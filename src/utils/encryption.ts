// src/utils/encryption.ts
import crypto from 'crypto';

// The Master Key must live strictly in your .env file, NEVER in the code.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; 
const ALGORITHM = 'aes-256-cbc';

// Brutal safety check: The server will physically refuse to boot if the key is missing or weak.
if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  throw new Error("🔥 CRITICAL: ENCRYPTION_KEY must be exactly 64 hex characters in your .env file");
}

const key = Buffer.from(ENCRYPTION_KEY, 'hex');

export function encrypt(text: string): string {
  if (!text) return text;
  
  const iv = crypto.randomBytes(16); // 16 random bytes for the IV
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Store both the random IV and the encrypted text, separated by a colon
  return `${iv.toString('hex')}:${encrypted}`;
}

export function decrypt(hash: string): string {
  if (!hash || !hash.includes(':')) return hash; // Fallback if it's not encrypted yet
  
  const parts = hash.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = parts[1];
  
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}