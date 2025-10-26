import { eq, and } from 'drizzle-orm';
import { getDb } from '../database/db';
import { users, userDrives, type User, type UserDrive } from '../database/schema';
import { createLogger } from '../config/logger';
import { hashEmail, encrypt, decrypt, generateDrivePassword } from '../utils/crypto';
import { config } from '../config/env';

const logger = createLogger('user-service');

export interface UserWithDrive {
  user: User;
  privateDrive?: UserDrive & { drivePassword: string };
  publicDrive?: UserDrive;
  drive?: UserDrive & { drivePassword?: string }; // Generic drive (private or public)
}

/**
 * Check if email is allowed by the allowlist
 */
export function isAllowedEmail(email: string): boolean {
  const lowerEmail = email.toLowerCase();
  const domain = lowerEmail.split('@')[1];

  const allowList = config.FORWARD_ALLOWED_EMAILS
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  for (const allowed of allowList) {
    // Exact match
    if (allowed === lowerEmail) return true;

    // Wildcard domain match (*@example.com)
    if (allowed.startsWith('*@')) {
      const allowedDomain = allowed.slice(2);
      if (domain === allowedDomain) return true;
    }
  }

  return false;
}

/**
 * Get or create user by email
 * Returns user with drive info of specified type if exists
 */
export async function getOrCreateUser(email: string, driveType: 'private' | 'public' = 'private'): Promise<UserWithDrive> {
  const db = await getDb();
  const emailLower = email.toLowerCase();

  // Check allowlist
  if (!isAllowedEmail(emailLower)) {
    logger.warn({ email: emailLower }, 'Email not in allowlist');
    throw new Error('Email not authorized');
  }

  // Try to find existing user
  let user = await (db.query as any).users?.findFirst({
    where: eq(users.email, emailLower),
  });

  // Create user if doesn't exist
  if (!user) {
    logger.info({ email: emailLower }, 'Creating new user');

    const [newUser] = await db.insert(users).values({
      email: emailLower,
      emailVerified: true, // Auto-verify since they're on allowlist
      allowed: true,
      plan: 'free',
    }).returning();

    user = newUser;
  }

  // Get user's drive of specified type
  const drive = await (db.query as any).userDrives?.findFirst({
    where: and(
      eq(userDrives.userId, user.id),
      eq(userDrives.driveType, driveType)
    ),
  });

  if (drive) {
    // Decrypt password for private drives
    if (driveType === 'private' && drive.drivePasswordEncrypted) {
      const drivePassword = decrypt(drive.drivePasswordEncrypted);
      return {
        user,
        privateDrive: { ...drive, drivePassword },
        drive: { ...drive, drivePassword },
      };
    }
    // Public drive (no password)
    return {
      user,
      publicDrive: drive,
      drive,
    };
  }

  return { user };
}

/**
 * Create ArDrive drive for user (private or public)
 * This is called the first time a user uploads a file
 */
export async function createDriveForUser(
  userId: string,
  driveId: string,
  rootFolderId: string,
  driveType: 'private' | 'public' = 'private',
  drivePassword?: string,
  driveKeyBase64?: string
): Promise<{ drivePassword?: string }> {
  const db = await getDb();

  // For private drives, use provided password or generate new one
  let password: string | undefined;
  let encryptedPassword: string | undefined;

  if (driveType === 'private') {
    password = drivePassword || generateDrivePassword();
    encryptedPassword = encrypt(password);
  }

  await db.insert(userDrives).values({
    userId,
    driveId,
    driveType,
    rootFolderId,
    drivePasswordEncrypted: encryptedPassword || null,
    driveKeyBase64: driveKeyBase64 || null,
    welcomeEmailSent: false,
  });

  logger.info({ userId, driveId, driveType, hasDriveKey: !!driveKeyBase64 }, `Created ${driveType} drive for user`);

  return { drivePassword: password };
}

/**
 * Legacy function - wrapper for backwards compatibility
 */
export async function createPrivateDriveForUser(
  userId: string,
  driveId: string,
  rootFolderId: string,
  drivePassword?: string,
  driveKeyBase64?: string
): Promise<{ drivePassword: string }> {
  const result = await createDriveForUser(userId, driveId, rootFolderId, 'private', drivePassword, driveKeyBase64);
  return { drivePassword: result.drivePassword! };
}

/**
 * Get user's private drive info
 */
export async function getUserPrivateDrive(userId: string): Promise<(UserDrive & { drivePassword: string }) | null> {
  const db = await getDb();

  const drive = await (db.query as any).userDrives?.findFirst({
    where: and(
      eq(userDrives.userId, userId),
      eq(userDrives.driveType, 'private')
    ),
  });

  if (!drive || !drive.drivePasswordEncrypted) {
    return null;
  }

  const drivePassword = decrypt(drive.drivePasswordEncrypted);

  return {
    ...drive,
    drivePassword,
  };
}

/**
 * Update user plan (free -> paid)
 */
export async function updateUserPlan(userId: string, plan: 'free' | 'paid', stripeCustomerId?: string): Promise<void> {
  const db = await getDb();

  await db.update(users)
    .set({
      plan,
      stripeCustomerId,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  logger.info({ userId, plan }, 'Updated user plan');
}

/**
 * Mark welcome email as sent for user's drive
 */
export async function markWelcomeEmailSent(userId: string, driveType: 'private' | 'public' = 'private'): Promise<void> {
  const db = await getDb();

  await db.update(userDrives)
    .set({ welcomeEmailSent: true })
    .where(and(
      eq(userDrives.userId, userId),
      eq(userDrives.driveType, driveType)
    ));

  logger.info({ userId, driveType }, 'Marked welcome email as sent');
}
