import crypto from 'crypto';

const algorithm = 'aes-256-cbc';
// Ensure your .env has ENCRYPTION_KEY (must be exactly 32 characters long)
const secretKey = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || 'fallback_secret_must_be_changed_').digest();

export const encrypt = (text: string) => {
  // Generate a random IV for every single encryption
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, secretKey, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // Return the IV and the encrypted text together, separated by a colon
  return `${iv.toString('hex')}:${encrypted}`;
};

export const decrypt = (encryptedText: string) => {
  // Split the stored string back into the IV and the ciphertext
  const [ivHex, encrypted] = encryptedText.split(':');
  if (!ivHex || !encrypted) throw new Error("Invalid encryption format");

  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(algorithm, secretKey, iv);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
};