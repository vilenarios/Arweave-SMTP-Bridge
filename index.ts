import { config } from './src/config/env';
import { createLogger } from './src/config/logger';
import { getDb } from './src/database/db';
import { IMAPService } from './src/services/imap-service';
import { EmailProcessor } from './src/jobs/processors/email-processor';
import { closeQueue } from './src/jobs/queue';

const logger = createLogger('main');

let imapService: IMAPService | null = null;
let emailProcessor: EmailProcessor | null = null;
let isShuttingDown = false;

async function start(): Promise<void> {
  logger.info('🚀 Starting ForwARd by ArDrive...');

  try {
    // 1. Initialize database
    logger.info('📦 Initializing database...');
    await getDb();
    logger.info('✅ Database connected');

    // 2. Start email processor worker
    logger.info('⚙️  Starting email processor worker...');
    emailProcessor = new EmailProcessor();
    await emailProcessor.start();
    logger.info('✅ Email processor worker started');

    // 3. Start IMAP service
    logger.info('📧 Starting IMAP service...');
    imapService = new IMAPService();
    await imapService.start();
    logger.info('✅ IMAP service started');

    logger.info('');
    logger.info('🎉 ForwARd is running!');
    logger.info('📬 Monitoring inbox for new emails...');
    logger.info('');
    logger.info(`Environment: ${config.NODE_ENV}`);
    logger.info(`Email: ${config.EMAIL_USER}`);
    logger.info(`Free emails per month: ${config.FREE_EMAILS_PER_MONTH}`);
    logger.info(`Cost per email: $${config.COST_PER_EMAIL}`);
    logger.info('');
    logger.info('Press Ctrl+C to stop');
  } catch (error) {
    logger.error({ error }, '❌ Failed to start application');
    await shutdown(1);
  }
}

async function shutdown(exitCode = 0): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, force exiting...');
    process.exit(exitCode);
  }

  isShuttingDown = true;
  logger.info('');
  logger.info('🛑 Shutting down gracefully...');

  try {
    // Stop IMAP service first (stops new emails from being queued)
    if (imapService) {
      logger.info('Stopping IMAP service...');
      await imapService.stop();
      imapService = null;
      logger.info('✅ IMAP service stopped');
    }

    // Stop email processor (allows current jobs to finish)
    if (emailProcessor) {
      logger.info('Stopping email processor...');
      await emailProcessor.stop();
      emailProcessor = null;
      logger.info('✅ Email processor stopped');
    }

    // Close queue connections
    logger.info('Closing queue connections...');
    await closeQueue();
    logger.info('✅ Queue connections closed');

    logger.info('✅ Shutdown complete');
    process.exit(exitCode);
  } catch (error) {
    logger.error({ error }, '❌ Error during shutdown');
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM signal');
  shutdown(0).catch(() => process.exit(1));
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT signal');
  shutdown(0).catch(() => process.exit(1));
});

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, '❌ Unhandled rejection');
  shutdown(1).catch(() => process.exit(1));
});

process.on('uncaughtException', (error) => {
  logger.error({ error }, '❌ Uncaught exception');
  shutdown(1).catch(() => process.exit(1));
});

// Start the application
start().catch((error) => {
  logger.error({ error }, '❌ Fatal error during startup');
  process.exit(1);
});
