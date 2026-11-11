import { createHash } from 'node:crypto';
// jsonb changes key order; hashes must be stable after a database round-trip.
const canonical = (v: any): any =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const emailHash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
export const emailChannelHash = (ch: any) =>
  emailHash({
    mode: ch.mode,
    provider: ch.provider,
    credentials: ch.credentials,
    settings: ch.settings,
  });
