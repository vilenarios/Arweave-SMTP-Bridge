import { ImapFlow } from 'imapflow';
import { eq } from 'drizzle-orm';
import { config } from '../config/env';
import { createLogger } from '../config/logger';
import { getDb } from '../database/db';
import { processedEmails } from '../database/schema';
import { queueEmail } from '../jobs/queue';

const logger = createLogger('imap');

const POLL_INTERVAL = 30000; // 30 seconds
const SEARCH_DAYS = 7; // Search emails from last 7 days
const MAX_RECONNECT_DELAY = 60000; // Max 60 seconds between reconnects

export class IMAPService {
  private client: ImapFlow | null = null;
  private pollTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private reconnectAttempts = 0;
  private isShuttingDown = false;
  private isConnected = false;

  async start(): Promise<void> {
    logger.info('Starting IMAP service...');
    await this.connect();
  }

  async stop(): Promise<void> {
    logger.info('Stopping IMAP service...');
    this.isShuttingDown = true;

    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Stop reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Disconnect
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      logger.info({ host: config.EMAIL_HOST, user: config.EMAIL_USER }, 'Connecting to IMAP...');

      this.client = new ImapFlow({
        host: config.EMAIL_HOST,
        port: config.EMAIL_PORT,
        secure: config.EMAIL_TLS,
        auth: {
          user: config.EMAIL_USER,
          pass: config.EMAIL_PASSWORD,
        },
        logger: false, // Disable ImapFlow's own logging
      });

      // Handle connection events
      this.client.on('close', () => this.handleDisconnect());
      this.client.on('error', (error) => {
        logger.error({ error }, 'IMAP error');
      });

      await this.client.connect();

      this.isConnected = true;
      this.reconnectAttempts = 0; // Reset on successful connection

      logger.info('✅ IMAP connected');

      // Start polling
      this.startPolling();
    } catch (error) {
      logger.error({ error }, 'Failed to connect to IMAP');
      this.isConnected = false;
      await this.scheduleReconnect();
    }
  }

  private async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
        logger.info('IMAP disconnected');
      } catch (error) {
        logger.warn({ error }, 'Error during IMAP disconnect');
      }
      this.client = null;
    }
    this.isConnected = false;
  }

  private async handleDisconnect(): Promise<void> {
    if (this.isShuttingDown) return;

    logger.warn('IMAP connection closed, will reconnect...');
    this.isConnected = false;

    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    await this.scheduleReconnect();
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.isShuttingDown || this.reconnectTimer) return;

    this.reconnectAttempts++;

    // Exponential backoff: 5s, 10s, 30s, 60s (max)
    const delays = [5000, 10000, 30000, MAX_RECONNECT_DELAY];
    const delay = delays[Math.min(this.reconnectAttempts - 1, delays.length - 1)];

    logger.info({ attempt: this.reconnectAttempts, delay }, 'Scheduling reconnect...');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  private startPolling(): void {
    // Initial poll
    this.pollForEmails().catch((error) => {
      logger.error({ error }, 'Initial poll failed');
    });

    // Poll every 30 seconds
    this.pollTimer = setInterval(() => {
      this.pollForEmails().catch((error) => {
        logger.error({ error }, 'Polling failed');
      });
    }, POLL_INTERVAL);

    logger.info({ interval: POLL_INTERVAL }, 'Polling started');
  }

  private async pollForEmails(): Promise<void> {
    if (!this.client || !this.isConnected) {
      logger.debug('Skipping poll - not connected');
      return;
    }

    try {
      const db = await getDb();

      // Open INBOX
      const lock = await this.client.getMailboxLock('INBOX');

      try {
        // Search for UNSEEN emails from last 7 days
        const sinceDate = new Date(Date.now() - SEARCH_DAYS * 24 * 60 * 60 * 1000);

        const messages = await this.client.search({
          seen: false,
          since: sinceDate,
        });

        if (messages.length === 0) {
          logger.debug('No new emails');
          return;
        }

        logger.info({ count: messages.length }, 'Found unseen emails');

        // Process each email
        for (const uid of messages) {
          // Check if already processed
          const existing = await (db.query as any).processedEmails?.findFirst({
            where: eq(processedEmails.uid, uid),
          });

          if (existing) {
            logger.debug({ uid }, 'Email already processed, skipping');
            continue;
          }

          // Fetch email metadata (not full body yet - that's done in the job)
          const message = await this.client.fetchOne(String(uid), {
            envelope: true,
          });

          if (!message || !message.envelope) {
            logger.warn({ uid }, 'Could not fetch envelope, skipping');
            continue;
          }

          const from = message.envelope.from?.[0]?.address || 'unknown';
          const subject = message.envelope.subject || '(no subject)';
          const messageId = message.envelope.messageId || null;

          // Queue for processing
          await queueEmail(uid);

          // Record in database
          await db.insert(processedEmails).values({
            uid,
            messageId,
            sender: from,
            subject,
            status: 'queued',
          });

          // Mark as SEEN (prevents re-processing if app crashes)
          await this.client.messageFlagsAdd([uid], ['\\Seen']);

          logger.info({ uid, from, subject }, 'Email queued');
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      // Don't crash on poll errors - just log and continue
      logger.error({ error }, 'Error during polling');
    }
  }

  async healthCheck(): Promise<boolean> {
    return this.isConnected;
  }
}
