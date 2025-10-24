import { Job, Worker } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { eq, and } from 'drizzle-orm';
import { config } from '../../config/env';
import { createLogger } from '../../config/logger';
import { getDb } from '../../database/db';
import { processedEmails, uploads, driveFolders } from '../../database/schema';
import { getOrCreateUser, createPrivateDriveForUser, markWelcomeEmailSent } from '../../services/user-service';
import { canUserUpload, recordUpload, getUsageSummary } from '../../services/usage-service';
import { uploadFilesToArDrive, createFolderInDrive, uploadFilesToFolder, getDriveShareKey } from '../../storage/ardrive-storage';
import { sendUploadConfirmation, sendUsageLimitEmail, sendDriveWelcomeEmail, sendUploadErrorEmail } from '../../services/email-notification';
import { type EmailJobData } from '../queue';
import { generateDrivePassword } from '../../utils/crypto';
import { getOrCreateUserWallet } from '../../services/wallet-service';
import { ensureUserHasCredits } from '../../services/credit-service';

const logger = createLogger('email-processor');


/**
 * Helper: Sanitize folder/file name (remove special chars, limit length)
 */
function sanitizeName(name: string, maxLength: number = 50): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // Remove invalid chars
    .replace(/\s+/g, '-') // Replace spaces with dashes
    .substring(0, maxLength)
    .replace(/^\.+/, '') // Remove leading dots
    .trim() || 'unnamed';
}

/**
 * Helper: Get or create year folder
 */
async function getOrCreateYearFolder(
  userId: string,
  driveId: string,
  rootFolderId: string,
  year: number,
  drivePassword?: string,
  userJwk?: object
): Promise<string> {
  const db = await getDb();

  // Check if year folder exists in cache
  const existingFolder = await (db.query as any).driveFolders?.findFirst({
    where: and(
      eq(driveFolders.userId, userId),
      eq(driveFolders.driveId, driveId),
      eq(driveFolders.folderType, 'year'),
      eq(driveFolders.year, year)
    ),
  });

  if (existingFolder) {
    logger.info({ year, folderId: existingFolder.folderEntityId }, 'Using cached year folder');
    return existingFolder.folderEntityId;
  }

  // Create year folder
  logger.info({ year }, 'Creating year folder');

  try {
    const { folderId } = await createFolderInDrive(
      driveId,
      year.toString(),
      rootFolderId,
      drivePassword,
      userJwk
    );

    // Save to cache
    await db.insert(driveFolders).values({
      userId,
      driveId,
      folderType: 'year',
      folderName: year.toString(),
      parentFolderId: rootFolderId,
      folderEntityId: folderId,
      year,
      month: null,
    });

    // Wait for indexing (reduced from 10s to 6s)
    logger.info({ year, folderId }, 'Waiting 6s for year folder indexing');
    await new Promise(resolve => setTimeout(resolve, 6000));

    return folderId;
  } catch (error) {
    // If folder already exists (e.g., on retry), try to find it
    logger.warn({ year, error }, 'Year folder creation failed, checking if exists');

    // Check cache again (might have been created by concurrent process)
    const retryFolder = await (db.query as any).driveFolders?.findFirst({
      where: and(
        eq(driveFolders.userId, userId),
        eq(driveFolders.driveId, driveId),
        eq(driveFolders.folderType, 'year'),
        eq(driveFolders.year, year)
      ),
    });

    if (retryFolder) {
      logger.info({ year, folderId: retryFolder.folderEntityId }, 'Found year folder in cache after error');
      return retryFolder.folderEntityId;
    }

    // If still not found, throw original error
    throw error;
  }
}

/**
 * Helper: Get or create month folder
 */
async function getOrCreateMonthFolder(
  userId: string,
  driveId: string,
  yearFolderId: string,
  year: number,
  month: number,
  drivePassword?: string,
  userJwk?: object
): Promise<string> {
  const db = await getDb();

  // Check if month folder exists in cache
  const existingFolder = await db.query.driveFolders.findFirst({
    where: and(
      eq(driveFolders.userId, userId),
      eq(driveFolders.driveId, driveId),
      eq(driveFolders.folderType, 'month'),
      eq(driveFolders.year, year),
      eq(driveFolders.month, month)
    ),
  });

  if (existingFolder) {
    logger.info({ year, month, folderId: existingFolder.folderEntityId }, 'Using cached month folder');
    return existingFolder.folderEntityId;
  }

  // Create month folder (format: "01", "02", etc.)
  const monthStr = month.toString().padStart(2, '0');
  logger.info({ year, month: monthStr }, 'Creating month folder');

  try {
    const { folderId } = await createFolderInDrive(
      driveId,
      monthStr,
      yearFolderId,
      drivePassword,
      userJwk
    );

    // Save to cache
    await db.insert(driveFolders).values({
      userId,
      driveId,
      folderType: 'month',
      folderName: monthStr,
      parentFolderId: yearFolderId,
      folderEntityId: folderId,
      year,
      month,
    });

    // Wait for indexing (reduced from 10s to 6s)
    logger.info({ year, month: monthStr, folderId }, 'Waiting 6s for month folder indexing');
    await new Promise(resolve => setTimeout(resolve, 6000));

    return folderId;
  } catch (error) {
    // If folder already exists (e.g., on retry), try to find it
    logger.warn({ year, month, error }, 'Month folder creation failed, checking if exists');

    // Check cache again
    const retryFolder = await (db.query as any).driveFolders?.findFirst({
      where: and(
        eq(driveFolders.userId, userId),
        eq(driveFolders.driveId, driveId),
        eq(driveFolders.folderType, 'month'),
        eq(driveFolders.year, year),
        eq(driveFolders.month, month)
      ),
    });

    if (retryFolder) {
      logger.info({ year, month, folderId: retryFolder.folderEntityId }, 'Found month folder in cache after error');
      return retryFolder.folderEntityId;
    }

    throw error;
  }
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

    logger.info({ uid, jobId: job.id, attemptsMade: job.attemptsMade }, 'Processing email...');

    const tempFiles: string[] = []; // Track all temp files for cleanup
    let userEmail: string | undefined;
    let emailSubject: string | undefined;

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

      // Track for error notifications
      userEmail = from;
      emailSubject = email.subject;

      const emailDate = email.date || new Date();
      const subject = email.subject;

      logger.info({ uid, from, subject }, 'Email fetched');

      // 2. Get or create user (validates allowlist)
      const { user, privateDrive } = await getOrCreateUser(from);

      logger.info({ userId: user.id, email: from }, 'User validated');

      // 3. Check usage limits
      const { allowed, reason } = await canUserUpload(user.id);
      if (!allowed) {
        logger.warn({ userId: user.id, reason }, 'User upload blocked');

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

      // 3.5. Handle wallet mode (single vs multi)
      let userWallet: { address: string; jwk: object } | null = null;

      if (config.WALLET_MODE === 'multi') {
        logger.info({ userId: user.id }, 'Multi-wallet mode: Getting or creating user wallet');
        userWallet = await getOrCreateUserWallet(user.id);

        if (!userWallet) {
          throw new Error('Failed to create user wallet');
        }

        logger.info({
          userId: user.id,
          walletAddress: userWallet.address
        }, 'User wallet ready');

        // Ensure user has enough Turbo credits (just-in-time allocation)
        // Estimate: 3MB per email
        const estimatedBytes = 3 * 1024 * 1024;
        const estimatedWinc = BigInt(Math.ceil((estimatedBytes / (1024 * 1024 * 1024)) * 1e12)); // ~0.003 Credits

        await ensureUserHasCredits(user.id, userWallet.address, estimatedWinc);
        logger.info({ userId: user.id }, 'User has sufficient Turbo credits');
      } else {
        logger.info('Single-wallet mode: Using master wallet for uploads');
      }

      // 4. Save email as .eml file (includes all embedded attachments)
      const emlFile = await this.saveEmailAsEml(uid, emailDate, subject);
      if (emlFile) {
        tempFiles.push(emlFile.filepath);
        logger.info({ uid, emlSize: emlFile.sizeBytes }, 'Email saved as .eml');
      }

      // 6. Get or create private drive for user
      let driveInfo = privateDrive;
      let isNewDrive = false;

      if (!driveInfo) {
        isNewDrive = true;
        logger.info({ userId: user.id }, 'Creating private drive...');

        const drivePassword = generateDrivePassword();

        // Create EMPTY drive first (no files)
        const { driveId, rootFolderId } = await uploadFilesToArDrive(
          user.id,
          [],
          {
            driveName: `${user.email}-private`,
            drivePassword,
          }
        );

        // Derive drive key for sharing
        const driveKeyBase64 = await getDriveShareKey(driveId, drivePassword);

        // Save drive info to database with drive key
        await createPrivateDriveForUser(
          user.id,
          driveId,
          rootFolderId,
          drivePassword,
          driveKeyBase64
        );

        driveInfo = {
          id: (globalThis.crypto as any).randomUUID(),
          userId: user.id,
          driveId,
          driveType: 'private' as const,
          rootFolderId,
          drivePasswordEncrypted: '',
          driveKeyBase64,
          welcomeEmailSent: false,
          createdAt: new Date(),
          drivePassword,
        };

        logger.info({ userId: user.id, driveId, rootFolderId }, 'Private drive created');

        // Wait for drive indexing (reduced from 10s to 6s)
        logger.info({ driveId }, 'Waiting 6s for drive indexing');
        await new Promise(resolve => setTimeout(resolve, 6000));
      }

      // 7. Send welcome email if this is a new drive (only once)
      if (isNewDrive && driveInfo.driveKeyBase64) {
        logger.info({ userId: user.id }, 'Sending welcome email...');
        await sendDriveWelcomeEmail(
          from,
          driveInfo.driveId,
          driveInfo.driveKeyBase64,
          user.email,
          userWallet?.address // Include wallet address in multi mode
        );
        await markWelcomeEmailSent(user.id);
        logger.info({ userId: user.id }, 'Welcome email sent');
      }

      // 8. Create folder hierarchy: Year/Month/Email
      const year = emailDate.getFullYear();
      const month = emailDate.getMonth() + 1; // JS months are 0-indexed

      logger.info({ year, month }, 'Creating folder hierarchy');

      const yearFolderId = await getOrCreateYearFolder(
        user.id,
        driveInfo.driveId,
        driveInfo.rootFolderId,
        year,
        driveInfo.drivePassword,
        userWallet?.jwk
      );

      const monthFolderId = await getOrCreateMonthFolder(
        user.id,
        driveInfo.driveId,
        yearFolderId,
        year,
        month,
        driveInfo.drivePassword,
        userWallet?.jwk
      );

      // Create email folder: YYYY-MM-DD_HH-MM-SS_Subject
      const timestamp = emailDate.toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const sanitizedSubject = subject ? sanitizeName(subject, 50) : 'No-Subject';
      const emailFolderName = `${timestamp}_${sanitizedSubject}`;

      logger.info({ emailFolderName }, 'Creating email folder');
      const { folderId: emailFolderId } = await createFolderInDrive(
        driveInfo.driveId,
        emailFolderName,
        monthFolderId,
        driveInfo.drivePassword,
        userWallet?.jwk // Pass user wallet in multi mode
      );

      logger.info({ emailFolderId }, 'Email folder created, waiting 6s for indexing');
      await new Promise(resolve => setTimeout(resolve, 6000));

      // 9. Upload .eml file to email folder
      if (!emlFile) {
        throw new Error('No .eml file to upload');
      }

      logger.info('Uploading .eml file to email folder');
      const uploadResults = await uploadFilesToFolder(
        driveInfo.driveId,
        emailFolderId,
        [{
          filepath: emlFile.filepath,
          filename: emlFile.filename,
          contentType: 'message/rfc822' // Proper MIME type for .eml files
        }],
        driveInfo.drivePassword,
        userWallet?.jwk // Pass user wallet in multi mode
      );

      const emlUploadResult = uploadResults[0];
      if (!emlUploadResult) {
        throw new Error('.eml file upload failed - no result returned');
      }
      logger.info({ entityId: emlUploadResult.entityId }, '.eml file uploaded');

      // 10. Record .eml upload in database
      await db.insert(uploads).values({
        userId: user.id,
        emailMessageId: email.messageId || null,
        fileName: emlUploadResult.fileName,
        sizeBytes: emlFile.sizeBytes,
        contentType: 'message/rfc822',
        status: 'completed',
        driveId: driveInfo.driveId,
        entityId: emlUploadResult.entityId,
        dataTxId: emlUploadResult.dataTxId || null,
        fileKey: emlUploadResult.fileKey || null,
        emailFolderEntityId: emailFolderId,
        completedAt: new Date(),
      });

      await recordUpload(user.id, emlFile.sizeBytes);

      // 11. Update processedEmails with folder and .eml info
      await db.update(processedEmails)
        .set({
          folderEntityId: emailFolderId,
          folderName: emailFolderName,
          emlFileEntityId: emlUploadResult.entityId,
          emlFileKey: emlUploadResult.fileKey || null,
        })
        .where(eq(processedEmails.uid, uid));

      // 12. Send confirmation email
      const summary = await getUsageSummary(user.id);

      const emlInfo = {
        fileName: emlUploadResult.fileName,
        entityId: emlUploadResult.entityId,
        fileKey: emlUploadResult.fileKey,
      };

      await sendUploadConfirmation(
        from,
        emlInfo,
        subject || 'No Subject',
        summary
      );

      logger.info({ userId: user.id }, 'Confirmation email sent');

      // 14. Clean up temp files
      for (const filepath of tempFiles) {
        try {
          unlinkSync(filepath);
        } catch (error) {
          logger.warn({ filepath }, 'Failed to cleanup temp file');
        }
      }

      // 15. Mark as completed
      await db.update(processedEmails)
        .set({ status: 'completed', processedAt: new Date() })
        .where(eq(processedEmails.uid, uid));

      logger.info({ uid, userId: user.id }, 'Email processing complete');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ uid, error, attemptsMade: job.attemptsMade }, 'Error processing email');

      // Clean up temp files on error
      for (const filepath of tempFiles) {
        try {
          unlinkSync(filepath);
        } catch (cleanupError) {
          logger.warn({ filepath }, 'Failed to cleanup temp file after error');
        }
      }

      // Mark as failed
      await db.update(processedEmails)
        .set({
          status: 'failed',
          errorMessage,
          processedAt: new Date(),
        })
        .where(eq(processedEmails.uid, uid));

      // Send error notification email on final failure (after all retries exhausted)
      // BullMQ default: 3 attempts (attemptsMade starts at 1)
      const maxAttempts = 3;
      const isFinalFailure = job.attemptsMade >= maxAttempts;

      if (isFinalFailure && userEmail) {
        logger.warn({ uid, userEmail, attemptsMade: job.attemptsMade }, 'Final failure - sending error email to user');
        try {
          await sendUploadErrorEmail(
            userEmail,
            emailSubject,
            errorMessage,
            job.attemptsMade
          );
        } catch (emailError) {
          logger.error({ emailError }, 'Failed to send error notification email');
        }
      }

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

  private async saveEmailAsEml(
    uid: number,
    emailDate: Date,
    subject: string | undefined
  ): Promise<{ filepath: string; filename: string; sizeBytes: number } | null> {
    if (!this.imapClient) {
      throw new Error('IMAP client not connected');
    }

    const tmpDir = join(process.cwd(), 'tmp');
    mkdirSync(tmpDir, { recursive: true });

    const lock = await this.imapClient.getMailboxLock('INBOX');

    try {
      // Fetch raw email source
      const message = await this.imapClient.fetchOne(String(uid), {
        source: true,
      });

      if (!message || !message.source) {
        logger.warn({ uid }, 'Could not fetch email source for .eml');
        return null;
      }

      const emailSource = message.source;
      const sizeBytes = Buffer.byteLength(emailSource);

      // Check 50MB limit
      const FIFTY_MB = 50 * 1024 * 1024;
      if (sizeBytes > FIFTY_MB) {
        logger.warn({ uid, sizeBytes, limit: FIFTY_MB }, 'Email exceeds 50MB limit, skipping .eml save');
        return null;
      }

      // Create filename: YYYY-MM-DD_Subject.eml
      const dateStr = emailDate.toISOString().split('T')[0];
      const sanitizedSubject = subject ? sanitizeName(subject, 50) : 'No-Subject';
      const filename = `${dateStr}_${sanitizedSubject}.eml`;
      const filepath = join(tmpDir, `${uid}-${filename}`);

      // Save .eml file
      writeFileSync(filepath, emailSource);

      logger.info({ uid, filename, sizeBytes }, 'Saved email as .eml');

      return { filepath, filename, sizeBytes };
    } finally {
      lock.release();
    }
  }
}
