import { WalletDAO } from 'ardrive-core-js';
import { getDb } from '../database/db';
import { users } from '../database/schema';
import { eq } from 'drizzle-orm';
import { encrypt, decrypt } from '../utils/crypto';
import { createLogger } from '../config/logger';

const logger = createLogger('wallet-service');

export interface UserWalletInfo {
  address: string;
  jwk: any; // Full JWK for signing
  seedPhrase?: string; // Only returned when explicitly requested
}

/**
 * Generate a new Arweave wallet for a user
 * Returns wallet info with seed phrase for initial storage
 */
export async function generateUserWallet(): Promise<{
  address: string;
  seedPhrase: string;
  jwk: any;
}> {
  const walletDAO = new WalletDAO() as any;

  logger.info('Generating new user wallet');

  // Generate seed phrase
  const seedPhrase = await walletDAO.generateSeedPhrase();
  logger.debug({ seedPhrase: seedPhrase.toString().substring(0, 20) + '...' }, 'Seed phrase generated');

  // Generate JWK from seed phrase
  const jwkWallet = await walletDAO.generateJWKWallet(seedPhrase);
  const address = await jwkWallet.getAddress();
  const jwk = await jwkWallet.getPrivateKey();

  logger.info({ address: address.toString() }, 'User wallet generated');

  return {
    address: address.toString(),
    seedPhrase: seedPhrase.toString(),
    jwk
  };
}

/**
 * Store user wallet in database (encrypted)
 */
export async function storeUserWallet(
  userId: string,
  address: string,
  seedPhrase: string,
  jwk: any
): Promise<void> {
  const db = await getDb();
  const encryptedSeedPhrase = encrypt(seedPhrase);
  const encryptedJwk = encrypt(JSON.stringify(jwk));

  await db.update(users)
    .set({
      userWalletAddress: address,
      userWalletSeedPhraseEncrypted: encryptedSeedPhrase,
      userWalletJwkEncrypted: encryptedJwk
    })
    .where(eq(users.id, userId));

  logger.info({ userId, address }, 'User wallet stored in database');
}

/**
 * Get user wallet info (decrypted)
 * Does NOT include seed phrase by default for security
 */
export async function getUserWallet(userId: string): Promise<UserWalletInfo | null> {
  const db = await getDb();
  const user = await (db.query as any).users?.findFirst({
    where: eq(users.id, userId)
  });

  if (!user || !user.userWalletAddress || !user.userWalletJwkEncrypted) {
    return null;
  }

  const jwk = JSON.parse(decrypt(user.userWalletJwkEncrypted));

  return {
    address: user.userWalletAddress,
    jwk
  };
}

/**
 * Get user seed phrase (for recovery/export)
 * Should only be called when user explicitly requests it
 */
export async function getUserSeedPhrase(userId: string): Promise<string | null> {
  const db = await getDb();
  const user = await (db.query as any).users?.findFirst({
    where: eq(users.id, userId)
  });

  if (!user || !user.userWalletSeedPhraseEncrypted) {
    return null;
  }

  // Mark as downloaded
  await db.update(users)
    .set({ seedPhraseDownloadedAt: new Date() })
    .where(eq(users.id, userId));

  logger.info({ userId }, 'Seed phrase retrieved by user');

  return decrypt(user.userWalletSeedPhraseEncrypted);
}

/**
 * Get or create user wallet
 * - In 'multi' mode: Creates per-user wallet if doesn't exist
 * - In 'single' mode: Returns null (will use master wallet)
 */
export async function getOrCreateUserWallet(userId: string): Promise<UserWalletInfo | null> {
  // In single wallet mode, return null (caller will use master wallet)
  if (config.WALLET_MODE === 'single') {
    return null;
  }

  // Check if user already has a wallet
  const existingWallet = await getUserWallet(userId);
  if (existingWallet) {
    return existingWallet;
  }

  // Generate new wallet
  logger.info({ userId }, 'Creating new wallet for user');
  const { address, seedPhrase, jwk } = await generateUserWallet();

  // Store in database
  await storeUserWallet(userId, address, seedPhrase, jwk);

  return {
    address,
    jwk
  };
}

/**
 * Check if user has a wallet
 */
export async function userHasWallet(userId: string): Promise<boolean> {
  const db = await getDb();
  const user = await (db.query as any).users?.findFirst({
    where: eq(users.id, userId),
    columns: {
      userWalletAddress: true
    }
  });

  return !!user?.userWalletAddress;
}
