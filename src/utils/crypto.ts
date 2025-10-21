import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { config } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY = Buffer.from(config.ENCRYPTION_KEY, 'hex');

/**
 * Encrypt text using AES-256-GCM (authenticated encryption)
 * Format: iv:authTag:encryptedData (all hex-encoded)
 *
 * Use this for encrypting ArDrive drive passwords before storing in DB
 */
export function encrypt(text: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt text encrypted with encrypt()
 * Throws if authentication fails (data tampered with)
 */
export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format');
  }

  const [ivHex, authTagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Hash email for consistent user IDs
 */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex');
}

/**
 * Generate a secure random password for ArDrive private drives
 */
export function generateDrivePassword(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate a secure random API key (for future use)
 */
export function generateApiKey(): string {
  return randomBytes(32).toString('base64url');
}
