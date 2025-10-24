import { Queue, QueueEvents } from 'bullmq';
import { config } from '../config/env';
import { createLogger } from '../config/logger';

const logger = createLogger('queue');

// Email processing queue
export const emailQueue = new Queue('email-processor', {
  connection: {
    host: new URL(config.REDIS_URL).hostname,
    port: parseInt(new URL(config.REDIS_URL).port) || 6379,
  },
  defaultJobOptions: {
    attempts: 3, // Retry failed jobs 3 times
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s, 25s, 125s
    },
    removeOnComplete: {
      age: 7 * 24 * 60 * 60, // Keep completed jobs for 7 days
      count: 1000, // Keep max 1000 completed jobs
    },
    removeOnFail: false, // Keep failed jobs for debugging
  },
});

// Queue events for monitoring
const queueEvents = new QueueEvents('email-processor', {
  connection: {
    host: new URL(config.REDIS_URL).hostname,
    port: parseInt(new URL(config.REDIS_URL).port) || 6379,
  },
});

queueEvents.on('completed', ({ jobId }) => {
  logger.info({ jobId }, 'Job completed');
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error({ jobId, error: failedReason }, 'Job failed');
});

queueEvents.on('retrying', ({ jobId, attemptsMade }) => {
  logger.warn({ jobId, attemptsMade }, 'Job retrying');
});

// Job data interfaces
export interface EmailJobData {
  uid: number; // IMAP UID
  folder: string; // IMAP folder (INBOX, [Gmail]/Spam, etc.)
  queuedAt: number; // Timestamp
}

// Helper function to add email to queue
export async function queueEmail(uid: number, folder: string): Promise<void> {
  await emailQueue.add('process-email', {
    uid,
    folder,
    queuedAt: Date.now(),
  } as EmailJobData);

  logger.info({ uid, folder }, 'Email queued for processing');
}

// Graceful shutdown
export async function closeQueue(): Promise<void> {
  logger.info('Closing job queue...');
  await emailQueue.close();
  await queueEvents.close();
  logger.info('Job queue closed');
}
