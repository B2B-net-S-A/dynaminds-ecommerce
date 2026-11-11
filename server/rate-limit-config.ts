/** Per-address request limit of this installation (owner decision 29.10.2026,
 * docs/scale/LOAD-TEST-FULL-20261029.md §4.1). DYNA_RATE_LIMIT_PER_MIN = requests per minute from one
 * client address (key: server/http-peer-ip.ts, no forwarded headers). Unset = 600, the fixed value before
 * 29.10. Any other spelling than a decimal integer 60…100000 refuses startup: no silent fallback. */
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { captureRateLimitPeer } from './http-peer-ip';

export const RATE_LIMIT_ENV = 'DYNA_RATE_LIMIT_PER_MIN';
export const DEFAULT_RATE_LIMIT_PER_MIN = 600;
const MIN = 60, MAX = 100_000;

export type RateLimitSetting = Readonly<{ per_address_per_minute: number; window_seconds: 60; source: 'default' | 'env' }>;

export class RateLimitConfigurationError extends Error {
  readonly code = 'RATE_LIMIT_CONFIG_INVALID';
}

export function readRateLimitSetting(env: NodeJS.ProcessEnv = process.env): RateLimitSetting {
  const raw = env[RATE_LIMIT_ENV];
  if (raw === undefined) return Object.freeze({ per_address_per_minute: DEFAULT_RATE_LIMIT_PER_MIN, window_seconds: 60, source: 'default' });
  const value = /^[1-9][0-9]{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= MIN && value <= MAX))
    throw new RateLimitConfigurationError(
      `${RATE_LIMIT_ENV} wymaga liczby całkowitej od ${MIN} do ${MAX} (żądań na minutę z jednego adresu klienta); ` +
        `podano ${JSON.stringify(raw.slice(0, 40))}. Usuń zmienną, aby użyć domyślnych ${DEFAULT_RATE_LIMIT_PER_MIN}.`,
    );
  return Object.freeze({ per_address_per_minute: value, window_seconds: 60, source: 'env' });
}

/** The global per-address limit; the peer is captured before any asynchronous request hook. */
export async function registerAddressRateLimit(app: FastifyInstance, setting: RateLimitSetting): Promise<void> {
  const peer = captureRateLimitPeer(app.server);
  app.addHook('onClose', async () => { peer.detach(); });
  await app.register(rateLimit, { max: setting.per_address_per_minute, timeWindow: '1 minute', keyGenerator: peer.keyGenerator });
}
