import { TurboFactory } from '@ardrive/turbo-sdk';
import { readFileSync } from 'fs';
import { getDb } from '../database/db';
import { users, creditShares } from '../database/schema';
import { eq, and } from 'drizzle-orm';
import { createLogger } from '../config/logger';
import { config } from '../config/env';
import { getUsageSummary } from './usage-service';

const logger = createLogger('credit-service');

// Average email size for credit calculation (3MB)
const AVG_EMAIL_SIZE_BYTES = 3 * 1024 * 1024;

// Arweave storage cost (approximate, in Credits per GB)
// 1 Credit ≈ 1 GB of storage with Turbo
const CREDITS_PER_GB = 1.0;

// 30 days in seconds
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

/**
 * Calculate credits needed for a number of bytes
 */
function calculateCreditsForBytes(bytes: number): bigint {
  const gb = bytes / (1024 * 1024 * 1024);
  const credits = gb * CREDITS_PER_GB;
  // Convert to winc (1 Credit = 1e12 winc)
  const winc = Math.ceil(credits * 1e12);
  return BigInt(winc);
}

/**
 * Calculate credits needed based on user's remaining email allowance
 */
async function calculateCreditsForUser(userId: string): Promise<bigint> {
  const usageSummary = await getUsageSummary(userId);
  const emailsRemaining = usageSummary.freeEmailsRemaining;

  if (emailsRemaining <= 0) {
    return BigInt(0);
  }

  const bytesNeeded = emailsRemaining * AVG_EMAIL_SIZE_BYTES;
  return calculateCreditsForBytes(bytesNeeded);
}

/**
 * Share credits with a user wallet
 * Returns the approval data item ID
 */
export async function shareCreditsWith(
  userAddress: string,
  wincAmount: bigint
): Promise<string> {
  // Load master wallet
  const masterJwk = JSON.parse(readFileSync(config.ARWEAVE_JWK_PATH, 'utf-8'));

  // Initialize Turbo with master wallet
  const masterTurbo = TurboFactory.authenticated({ privateKey: masterJwk });

  logger.info({
    userAddress,
    wincAmount: wincAmount.toString(),
    credits: (Number(wincAmount) / 1e12).toFixed(6)
  }, 'Sharing credits with user');

  // Share credits with expiration
  const { approvalDataItemId, approvedWincAmount } = await masterTurbo.shareCredits({
    approvedAddress: userAddress,
    approvedWincAmount: wincAmount,
    expiresBySeconds: THIRTY_DAYS_SECONDS
  });

  logger.info({
    userAddress,
    approvalDataItemId,
    approvedWincAmount: approvedWincAmount.toString()
  }, 'Credits shared successfully');

  return approvalDataItemId;
}

/**
 * Revoke all credits for a user
 */
export async function revokeCreditFor(userAddress: string): Promise<void> {
  const masterJwk = JSON.parse(readFileSync(config.ARWEAVE_JWK_PATH, 'utf-8'));
  const masterTurbo = TurboFactory.authenticated({ privateKey: masterJwk });

  logger.info({ userAddress }, 'Revoking credits for user');

  await masterTurbo.revokeCredits({
    revokedAddress: userAddress
  });

  logger.info({ userAddress }, 'Credits revoked successfully');
}

/**
 * Ensure user has enough credits for an upload
 * Shares more credits if needed (just-in-time allocation)
 */
export async function ensureUserHasCredits(
  userId: string,
  userAddress: string,
  requiredWinc: bigint
): Promise<void> {
  logger.info({ userId, userAddress, requiredWinc: requiredWinc.toString() }, 'Checking user credit balance');

  const db = await getDb();

  // Get user wallet info
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId)
  });

  if (!user || !user.userWalletJwkEncrypted) {
    throw new Error('User wallet not found');
  }

  const { decrypt } = await import('../utils/crypto');
  const userJwk = JSON.parse(decrypt(user.userWalletJwkEncrypted));

  // Check user wallet balance
  const userTurbo = TurboFactory.authenticated({ privateKey: userJwk });
  const balance = await userTurbo.getBalance();

  logger.info({
    userId,
    currentBalance: balance.winc.toString(),
    requiredWinc: requiredWinc.toString()
  }, 'User wallet balance checked');

  // If balance is sufficient, no need to share more
  if (BigInt(balance.winc) >= requiredWinc) {
    logger.info({ userId }, 'User has sufficient credits');
    return;
  }

  // Calculate how many credits to share based on user's plan
  const creditsToShare = await calculateCreditsForUser(userId);

  if (creditsToShare === BigInt(0)) {
    throw new Error('User has no remaining email allowance');
  }

  // Share credits
  const approvalDataItemId = await shareCreditsWith(userAddress, creditsToShare);

  // Record the share in database
  const db = await getDb();
  await db.insert(creditShares).values({
    userId,
    approvalDataItemId,
    approvedWincAmount: Number(creditsToShare), // SQLite doesn't support bigint, convert to number
    status: 'active',
    expiresAt: new Date(Date.now() + THIRTY_DAYS_SECONDS * 1000)
  });

  logger.info({
    userId,
    approvalDataItemId,
    creditsShared: (Number(creditsToShare) / 1e12).toFixed(6)
  }, 'Credits shared and recorded');
}

/**
 * Revoke user credits and mark in database
 */
export async function revokeUserCredits(userId: string): Promise<void> {
  const db = await getDb();

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId)
  });

  if (!user || !user.userWalletAddress) {
    throw new Error('User wallet not found');
  }

  // Revoke via Turbo
  await revokeCreditFor(user.userWalletAddress);

  // Mark all active shares as revoked
  await db.update(creditShares)
    .set({
      status: 'revoked',
      revokedAt: new Date()
    })
    .where(
      and(
        eq(creditShares.userId, userId),
        eq(creditShares.status, 'active')
      )
    );

  logger.info({ userId }, 'User credits revoked');
}
