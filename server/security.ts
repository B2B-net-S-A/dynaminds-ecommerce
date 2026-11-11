import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { localConfig } from './db';
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password: string, hash: string) {
  const [salt, digest] = hash.split(':');
  const a = scryptSync(password, salt, 64),
    b = Buffer.from(digest, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function encrypt(data: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(localConfig.encryptionKey, 'hex'), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function decrypt(
  data: string,
  encryptionKey = localConfig.encryptionKey,
): Record<string, string> {
  const b = Buffer.from(data, 'base64');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
}
