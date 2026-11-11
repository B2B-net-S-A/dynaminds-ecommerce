import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes: Buffer): string {
  let value = 0,
    bits = 0,
    result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
export function unbase32(secret: string): Buffer {
  if (!/^[A-Z2-7]+$/.test(secret)) throw new Error('Invalid TOTP secret');
  let value = 0,
    bits = 0;
  const bytes: number[] = [];
  for (const letter of secret) {
    value = (value << 5) | alphabet.indexOf(letter);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}
export const newTotpSecret = () => base32(randomBytes(20));
export function hotp(secret: string, step: bigint, digits = 6, algorithm = 'sha1'): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(step);
  const hash = createHmac(algorithm, unbase32(secret)).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
export const totpStep = (now = Date.now()) => BigInt(Math.floor(now / 30000));
export const totp = (secret: string, now = Date.now(), digits = 6, algorithm = 'sha1') =>
  hotp(secret, totpStep(now), digits, algorithm);
export function matchedStep(
  secret: string,
  code: string,
  lastStep: bigint,
  now = Date.now(),
): bigint | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const step = totpStep(now);
  // Prefer the newest match if a rare collision occurs in the accepted window.
  for (const candidate of [step + 1n, step, step - 1n]) {
    if (candidate < 0n || candidate <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, candidate)), Buffer.from(code))) return candidate;
  }
}
export const totpUri = (secret: string, email: string) =>
  `otpauth://totp/${encodeURIComponent('DYNAMINDS Ecommerce:' + email)}?secret=${secret}&issuer=${encodeURIComponent('DYNAMINDS Ecommerce')}&algorithm=SHA1&digits=6&period=30`;
