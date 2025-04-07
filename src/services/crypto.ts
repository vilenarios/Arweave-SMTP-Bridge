import crypto from 'crypto';
const ALGO = 'aes-256-ctr';
const IV_LENGTH = 16;

export function encrypt(text: string, secret: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.createHash('sha256').update(secret).digest();
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(encryptedText: string, secret: string): string {
  const [ivHex, dataHex] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

export function hashEmail(email: string) {
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
}

export function generatePrivateDrivePassword(){
    const privateDrivePassword = crypto.randomBytes(32).toString('hex');
    return privateDrivePassword;
}