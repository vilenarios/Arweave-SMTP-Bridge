import { Job, Worker } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { config } from '../../config/env';
import { createLogger } from '../../config/logger';
import { getDb } from '../../database/db';
import { processedEmails, uploads } from '../../database/schema';
import { getOrCreateUser, getUserPrivateDrive, createPrivateDriveForUser } from '../../services/user-service';
import { canUserUpload, recordUpload, getUsageSummary } from '../../services/usage-service';
import { uploadFilesToArDrive } from '../../storage/ardrive-storage';
import { sendUploadConfirmation, sendUsageLimitEmail } from '../../services/email-notification';
import { type EmailJobData } from '../queue';

const logger = createLogger('email-processor');

interface SavedAttachment {
  filepath: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export class EmailProcessor {
  private worker: Worker | null = null;
  private imapClient: ImapFlow | null = null;

  async start(): Promise<void> {
    logger.info('Starting email processor worker...');

    // Create IMAP client for fetching email bodies
    this.imapClient = new ImapFlow({
      host: config.EMAIL_HOST,
      port: config.EMAIL_PORT,
      secure: config.EMAIL_TLS,
      auth: {
        user: config.EMAIL_USER,
        pass: config.EMAIL_PASSWORD,
      },
      logger: false,
    });

    await this.imapClient.connect();
    logger.info('Email processor IMAP connected');

    // Start worker
    this.worker = new Worker('email-processor', this.processJob.bind(this), {
      connection: {
        host: new URL(config.REDIS_URL).hostname,
        port: parseInt(new URL(config.REDIS_URL).port) || 6379,
      },
      concurrency: 1, // Process one email at a time for now
    });

    this.worker.on('completed', (job) => {
      logger.info({ jobId: job.id }, 'Job completed successfully');
    });

    this.worker.on('failed', (job, error) => {
      logger.error({ jobId: job?.id, error }, 'Job failed');
    });

    logger.info('Email processor worker started');
  }

  async stop(): Promise<void> {
    logger.info('Stopping email processor worker...');

    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }

    if (this.imapClient) {
      await this.imapClient.logout();
      this.imapClient = null;
    }

    logger.info('Email processor worker stopped');
  }

  private async processJob(job: Job<EmailJobData>): Promise<void> {
    const { uid } = job.data;
    const db = await getDb();

    logger.info({ uid, jobId: job.id }, 'Processing email...');

    try {
      // Update status to processing
      await db.update(processedEmails)
        .set({ status: 'processing' })
        .where(eq(processedEmails.uid, uid));

      // 1. Fetch full email from IMAP
      const email = await this.fetchEmail(uid);
      if (!email) {
        throw new Error(`Could not fetch email with UID ${uid}`);
      }

      const from = email.from?.value[0]?.address;
      if (!from) {
        throw new Error('Email has no sender');
      }

      logger.info({ uid, from, subject: email.subject }, 'Email fetched');

      // 2. Get or create user (validates allowlist)
      const { user, privateDrive } = await getOrCreateUser(from);

      logger.info({ userId: user.id, email: from }, 'User validated');

      // 3. Check usage limits
      const { allowed, reason, usage } = await canUserUpload(user.id);
      if (!allowed) {
        logger.warn({ userId: user.id, reason }, 'User upload blocked');

        // Send usage limit email
        const summary = await getUsageSummary(user.id);
        await sendUsageLimitEmail(from, reason || 'Usage limit exceeded', summary);

        await db.update(processedEmails)
          .set({
            status: 'completed',
            processedAt: new Date(),
            errorMessage: `Upload blocked: ${reason}`,
          })
          .where(eq(processedEmails.uid, uid));
        return;
      }

      // 4. Save attachments to temp directory
      const attachments = await this.saveAttachments(email, uid);

      if (attachments.length === 0) {
        logger.info({ uid }, 'No attachments to process');
        await db.update(processedEmails)
          .set({ status: 'completed', processedAt: new Date() })
          .where(eq(processedEmails.uid, uid));
        return;
      }

      logger.info({ uid, count: attachments.length }, 'Attachments saved');

      // 5. Get or create private drive for user
      let driveInfo = privateDrive;
      if (!driveInfo) {
        // Create private drive on first upload
        logger.info({ userId: user.id }, 'Creating private drive...');

        const { results, driveId, rootFolderId } = await uploadFilesToArDrive(
          user.id,
          attachments.map(a => ({
            filepath: a.filepath,
            filename: a.filename,
            contentType: a.contentType,
          })),
          {
            driveName: `${user.email}-private`,
          }
        );

        // Save drive info
        const { drivePassword } = await createPrivateDriveForUser(
          user.id,
          driveId,
          rootFolderId
        );

        driveInfo = {
          id: crypto.randomUUID(),
          userId: user.id,
          driveId,
          driveType: 'private' as const,
          rootFolderId,
          drivePasswordEncrypted: '', // Encrypted in createPrivateDriveForUser
          createdAt: new Date(),
          drivePassword, // Decrypted password
        };

        logger.info({ userId: user.id, driveId }, 'Private drive created');

        // Record uploads
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const attachment = attachments[i];

          await db.insert(uploads).values({
            userId: user.id,
            emailMessageId: email.messageId || null,
            fileName: result.fileName,
            sizeBytes: attachment.sizeBytes,
            contentType: attachment.contentType,
            status: 'completed',
            driveId,
            entityId: result.entityId,
            dataTxId: result.dataTxId || null,
            fileKey: result.fileKey || null,
            completedAt: new Date(),
          });

          // Record usage
          await recordUpload(user.id, attachment.sizeBytes);
        }
      } else {
        // Upload to existing drive
        const { results } = await uploadFilesToArDrive(
          user.id,
          attachments.map(a => ({
            filepath: a.filepath,
            filename: a.filename,
            contentType: a.contentType,
          })),
          {
            driveId: driveInfo.driveId,
            rootFolderId: driveInfo.rootFolderId,
            drivePassword: driveInfo.drivePassword,
          }
        );

        logger.info({ userId: user.id, count: results.length }, 'Files uploaded to ArDrive');

        // Record uploads
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const attachment = attachments[i];

          await db.insert(uploads).values({
            userId: user.id,
            emailMessageId: email.messageId || null,
            fileName: result.fileName,
            sizeBytes: attachment.sizeBytes,
            contentType: attachment.contentType,
            status: 'completed',
            driveId: driveInfo.driveId,
            entityId: result.entityId,
            dataTxId: result.dataTxId || null,
            fileKey: result.fileKey || null,
            completedAt: new Date(),
          });

          // Record usage
          await recordUpload(user.id, attachment.sizeBytes);
        }
      }

      // 6. Get upload results for confirmation email
      const uploadResults = await db.query.uploads.findMany({
        where: eq(uploads.emailMessageId, email.messageId || ''),
        orderBy: (uploads, { desc }) => [desc(uploads.createdAt)],
        limit: attachments.length,
      });

      const fileResults = uploadResults.map(u => ({
        fileName: u.fileName,
        entityId: u.entityId || '',
        dataTxId: u.dataTxId || undefined,
        fileKey: u.fileKey || undefined,
      }));

      // 7. Get usage summary
      const summary = await getUsageSummary(user.id);

      // 8. Send confirmation email
      await sendUploadConfirmation(
        from,
        fileResults,
        driveInfo.driveId,
        summary
      );

      logger.info({ userId: user.id, summary }, 'Confirmation email sent');

      // 8. Clean up temp files
      for (const attachment of attachments) {
        try {
          unlinkSync(attachment.filepath);
        } catch (error) {
          logger.warn({ filepath: attachment.filepath }, 'Failed to cleanup temp file');
        }
      }

      // 9. Mark as completed
      await db.update(processedEmails)
        .set({ status: 'completed', processedAt: new Date() })
        .where(eq(processedEmails.uid, uid));

      logger.info({ uid, userId: user.id }, 'Email processing complete');
    } catch (error) {
      logger.error({ uid, error }, 'Error processing email');

      // Mark as failed
      await db.update(processedEmails)
        .set({
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
          processedAt: new Date(),
        })
        .where(eq(processedEmails.uid, uid));

      throw error; // Let BullMQ handle retries
    }
  }

  private async fetchEmail(uid: number): Promise<ParsedMail | null> {
    if (!this.imapClient) {
      throw new Error('IMAP client not connected');
    }

    const lock = await this.imapClient.getMailboxLock('INBOX');

    try {
      // Fetch full email
      const message = await this.imapClient.fetchOne(String(uid), {
        source: true,
      });

      if (!message || !message.source) {
        return null;
      }

      // Parse email
      const parsed = await simpleParser(message.source);
      return parsed;
    } finally {
      lock.release();
    }
  }

  private async saveAttachments(email: ParsedMail, uid: number): Promise<SavedAttachment[]> {
    const tmpDir = join(process.cwd(), 'tmp');

    // Ensure tmp directory exists
    try {
      mkdirSync(tmpDir, { recursive: true });
    } catch (error) {
      // Directory might already exist
    }

    const saved: SavedAttachment[] = [];

    if (!email.attachments || email.attachments.length === 0) {
      return saved;
    }

    for (const attachment of email.attachments) {
      const filename = attachment.filename || `attachment-${Date.now()}`;
      const filepath = join(tmpDir, `${uid}-${filename}`);

      writeFileSync(filepath, attachment.content);

      saved.push({
        filepath,
        filename,
        contentType: attachment.contentType || 'application/octet-stream',
        sizeBytes: attachment.size,
      });
    }

    return saved;
  }
}
