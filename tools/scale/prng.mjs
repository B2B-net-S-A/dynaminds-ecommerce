// Deterministic randomness for the scale generator. Every entity draws from its own stream
// keyed by (seed, tenant, kind, index), so entity N is the same whatever order or batch it is
// generated in — that is what makes resume and per-seed idempotency possible.
import { createHash } from 'node:crypto';

/** sfc32 seeded from SHA-256 of the key parts. Returns a float generator in [0, 1). */
export function stream(...parts) {
  const h = createHash('sha256').update(parts.map(String).join('\u001f')).digest();
  let a = h.readUInt32LE(0), b = h.readUInt32LE(4), c = h.readUInt32LE(8), d = h.readUInt32LE(12);
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = c << 21 | c >>> 11;
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

export const int = (r, min, max) => min + Math.floor(r() * (max - min + 1));
export const pick = (r, list) => list[Math.floor(r() * list.length)];
/** weights: [[value, weight], ...]; weights need not sum to 100. */
export function weighted(r, weights) {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [value, w] of weights) if ((x -= w) < 0) return value;
  return weights[weights.length - 1][0];
}

/** RFC 4122 v4-shaped UUID derived from the key, for client_key / idempotency fields. */
export function uuidFrom(...parts) {
  const h = createHash('sha256').update('uuid\u001f' + parts.map(String).join('\u001f')).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
