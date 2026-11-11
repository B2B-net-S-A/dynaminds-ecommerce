import type pg from 'pg';
import { DeepLError } from './deepl';
export async function cooldown(c: pg.Client, key: string) {
  return (
    await c.query(
      'SELECT retry_until FROM deepl_key_cooldowns WHERE key_hash=$1 AND retry_until>now()',
      [key],
    )
  ).rows[0]?.retry_until as Date | undefined;
}
export async function recordCooldown(c: pg.Client, key: string, error: unknown) {
  if (!(error instanceof DeepLError && error.retryable)) return;
  await c.query(
    "INSERT INTO deepl_key_cooldowns(key_hash,retry_until) VALUES($1,now()+$2*interval '1 second') ON CONFLICT(key_hash) DO UPDATE SET retry_until=greatest(deepl_key_cooldowns.retry_until,excluded.retry_until),updated_at=now()",
    [key, error.retryAfter],
  );
}
