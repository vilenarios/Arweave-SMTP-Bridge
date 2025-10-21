import { eq, and, gte, lte } from 'drizzle-orm';
import { getDb } from '../database/db';
import { usage, type Usage } from '../database/schema';
import { createLogger } from '../config/logger';
import { config } from '../config/env';

const logger = createLogger('usage-service');

/**
 * Get the current billing period (month)
 */
function getCurrentBillingPeriod(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  return { start, end };
}

/**
 * Get or create current usage period for user
 */
export async function getCurrentUsage(userId: string): Promise<Usage> {
  const db = await getDb();
  const { start, end } = getCurrentBillingPeriod();

  // Try to find existing usage record for current period
  let usageRecord = await db.query.usage.findFirst({
    where: and(
      eq(usage.userId, userId),
      gte(usage.periodStart, start),
      lte(usage.periodEnd, end)
    ),
  });

  // Create if doesn't exist
  if (!usageRecord) {
    logger.info({ userId }, 'Creating new usage period');

    const [newUsage] = await db.insert(usage).values({
      userId,
      periodStart: start,
      periodEnd: end,
      uploadsCount: 0,
      bytesUploaded: 0,
      costUsd: 0,
      billed: false,
    }).returning();

    usageRecord = newUsage;
  }

  return usageRecord;
}

/**
 * Check if user can upload (hasn't exceeded limits)
 * Returns { allowed: boolean, reason?: string, usage: Usage }
 */
export async function canUserUpload(userId: string): Promise<{
  allowed: boolean;
  reason?: string;
  usage: Usage;
}> {
  const usageRecord = await getCurrentUsage(userId);

  const freeEmails = config.FREE_EMAILS_PER_MONTH;

  // Check if user has exceeded free tier
  if (usageRecord.uploadsCount >= freeEmails) {
    // For paid plan, allow unlimited (or check Stripe subscription status)
    // For now, just allow since we'll bill them
    return {
      allowed: true,
      usage: usageRecord,
    };
  }

  // Within free tier
  return {
    allowed: true,
    usage: usageRecord,
  };
}

/**
 * Record an upload and calculate cost
 */
export async function recordUpload(
  userId: string,
  fileSizeBytes: number
): Promise<{ cost: number; usage: Usage }> {
  const db = await getDb();
  const usageRecord = await getCurrentUsage(userId);

  const newUploadsCount = usageRecord.uploadsCount + 1;
  const newBytesUploaded = usageRecord.bytesUploaded + fileSizeBytes;

  // Calculate cost
  let additionalCost = 0;
  const freeEmails = config.FREE_EMAILS_PER_MONTH;

  if (newUploadsCount > freeEmails) {
    // This upload is billable
    additionalCost = config.COST_PER_EMAIL;
  }

  const newCostUsd = usageRecord.costUsd + additionalCost;

  // Update usage record
  const [updated] = await db.update(usage)
    .set({
      uploadsCount: newUploadsCount,
      bytesUploaded: newBytesUploaded,
      costUsd: newCostUsd,
      updatedAt: new Date(),
    })
    .where(eq(usage.id, usageRecord.id))
    .returning();

  logger.info({
    userId,
    uploadsCount: newUploadsCount,
    costUsd: newCostUsd,
    fileSizeBytes,
  }, 'Recorded upload');

  return {
    cost: additionalCost,
    usage: updated,
  };
}

/**
 * Get usage summary for user (for display in emails/dashboard)
 */
export async function getUsageSummary(userId: string): Promise<{
  uploadsThisMonth: number;
  freeEmailsUsed: number;
  freeEmailsRemaining: number;
  paidEmailsThisMonth: number;
  costThisMonth: number;
  bytesUploadedThisMonth: number;
}> {
  const usageRecord = await getCurrentUsage(userId);
  const freeEmails = config.FREE_EMAILS_PER_MONTH;

  const freeEmailsUsed = Math.min(usageRecord.uploadsCount, freeEmails);
  const freeEmailsRemaining = Math.max(0, freeEmails - usageRecord.uploadsCount);
  const paidEmailsThisMonth = Math.max(0, usageRecord.uploadsCount - freeEmails);

  return {
    uploadsThisMonth: usageRecord.uploadsCount,
    freeEmailsUsed,
    freeEmailsRemaining,
    paidEmailsThisMonth,
    costThisMonth: usageRecord.costUsd,
    bytesUploadedThisMonth: usageRecord.bytesUploaded,
  };
}
