import {
  ebayApplicationHash,
  ebaySimulationApplication,
  ebayApiStatus,
  ebayLimitedTransport,
  reserveEbayTransport,
  sendEbayReserved,
  releaseEbayApi,
  type EbayApiPermit,
} from './ebay-api-limits';
import { randomBytes, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { assertDbLocksHeldInTx, holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { decrypt, encrypt, tokenHash } from './security';
import { safeFetch } from './integrations';
import type { IntegrationContext } from './channel-access';
import { readEbayAccount, EBAY_TRADING_SCOPE } from './ebay-account';
import {
  ebayBase,
  ebayConnectionHash,
  ebayJson,
  ebayReadScopes,
  ebayRuName,
  ebaySecret,
  ebaySettings,
  refreshEbay,
} from './ebay';

export const ebayConsentScopes = (settings: any) =>
  EBAY_TRADING_SCOPE + ' ' + ebayReadScopes(settings);

async function accountBinding(c: PoolClient, id: string) {
  return (await c.query('SELECT * FROM ebay_account_bindings WHERE channel_id=$1', [id])).rows[0];
}
async function bindAccount(
  c: PoolClient,
  actor: Actor,
  ch: any,
  identity: { account_hash: string; username: string | null },
) {
  const bound = await accountBinding(c, ch.id),
    source = ch.settings.simulation ? 'simulation' : 'trading';
  ensure(
    !bound ||
      (bound.account_hash === identity.account_hash &&
        bound.mode === ch.mode &&
        bound.source === source),
    409,
    'To inne konto eBay niż przypisane do kanału. Dotychczasowe połączenie zachowano; dla innego sprzedawcy utwórz nowy kanał.',
  );
  await c.query(
    `INSERT INTO ebay_account_bindings(tenant_id,channel_id,account_hash,username,mode,source,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,channel_id) DO UPDATE
    SET username=EXCLUDED.username,actor_id=EXCLUDED.actor_id,verified_at=now()`,
    [
      actor.tenantId,
      ch.id,
      identity.account_hash,
      identity.username,
      ch.mode,
      source,
      actor.userId,
    ],
  );
  await audit(c, actor, 'ebay.account.verified', ch.id, {
    source,
    mode: ch.mode,
    rechecked: !!bound,
  });
}
export async function cachedEbayAccount(actor: Actor, sessionHash: string, id: string) {
  return oauthTx(actor, sessionHash, async (c) => {
    await admin(c, actor);
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0];
    ensure(ch?.provider === 'ebay', 404, 'Nie znaleziono integracji eBay');
    const b = await accountBinding(c, id);
    return {
      bound: !!b,
      username: b?.username ?? null,
      mode: ch.mode,
      source: b?.source ?? null,
      verified_at: b?.verified_at ?? null,
      has_refresh_token: !!decrypt(ch.credentials).refresh_token,
      simulation: ch.settings.simulation === true,
    };
  });
}
export async function cachedEbayApiLimits(actor: Actor, sessionHash: string, id: string) {
  const ch = await oauthTx(actor, sessionHash, async (c) => {
    await admin(c, actor);
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0];
    ensure(ch?.provider === 'ebay', 404, 'Nie znaleziono integracji eBay');
    return ch;
  });
  return {
    ...(await ebayApiStatus(
      ch.settings.simulation
        ? ebaySimulationApplication(actor.tenantId, ch.mode)
        : ebayApplicationHash(ch.mode, decrypt(ch.credentials).client_id),
    )),
    scope: ch.settings.simulation ? 'local_simulation' : 'local_observation',
    mode: ch.mode,
  };
}
export async function verifyEbayAccount(
  actor: Actor,
  sessionHash: string,
  id: string,
  ctx: IntegrationContext = {},
) {
  return connectionLock(actor.tenantId, id, async () => {
    const check = async (expected?: string) =>
      oauthTx(actor, sessionHash, async (c) => {
        await admin(c, actor);
        const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0];
        ensure(ch?.provider === 'ebay', 404, 'Nie znaleziono integracji eBay');
        ensure(
          !expected || ebayConnectionHash(ch) === expected,
          409,
          'Połączenie eBay zmieniło się podczas identyfikacji',
        );
        await idle(c, id);
        ensure(
          !(
            await c.query(
              'SELECT 1 FROM oauth_states WHERE channel_id=$1 AND consumed_at IS NULL AND expires_at>now()',
              [id],
            )
          ).rowCount,
          409,
          'Najpierw zakończ lub anuluj próbę OAuth eBay',
        );
        return ch;
      });
    const ch = await check(),
      hash = ebayConnectionHash(ch);
    let identity: { account_hash: string; username: string | null };
    if (ch.settings.simulation) {
      identity = {
        account_hash: tokenHash('ebay-demo-account:' + id),
        username: 'DEMO — lokalny sprzedawca',
      };
    } else {
      const creds = decrypt(ch.credentials);
      ensure(creds.refresh_token, 422, 'Najpierw połącz konto przez OAuth');
      ensure(
        !ch.settings.oauth_refresh_expires_at ||
          Date.parse(ch.settings.oauth_refresh_expires_at) > Date.now(),
        401,
        'Zgoda eBay wygasła; weryfikacja istniejącego konta wymaga ważnego tokenu',
      );
      // A separate base-scope token is used for this read and never replaces the Sell token cache.
      const token =
        creds.access_token &&
        (ch.oauth_scopes ?? '').split(' ').includes(EBAY_TRADING_SCOPE) &&
        new Date(ch.token_expires_at).getTime() > Date.now() + 60000
          ? creds.access_token
          : (await refreshEbay(ch.mode, creds, ctx.transport ?? safeFetch, EBAY_TRADING_SCOPE))
              .access_token;
      await check(hash);
      identity = await readEbayAccount(ch.mode, token, ctx.transport ?? safeFetch, creds.client_id);
    }
    await check(hash);
    await oauthTx(actor, sessionHash, async (c) => {
      await admin(c, actor);
      const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      ensure(
        current && ebayConnectionHash(current) === hash,
        409,
        'Połączenie eBay zmieniło się podczas identyfikacji',
      );
      await idle(c, id);
      await bindAccount(c, actor, current, identity);
    });
    return cachedEbayAccount(actor, sessionHash, id);
  });
}

export const ebayOAuthStartInput = z
  .object({
    inventory_access: ebaySettings.shape.inventory_access.optional(),
    fulfillment_write: z.boolean().optional(),
    seller_settings_read: z.boolean().optional(),
    confirm_same_account: z.boolean().default(false),
  })
  .strict();
export const ebayOAuthCallback = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[^\s]+$/)
      .optional(),
    error: z.string().min(1).max(160).optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.error), 'Wymagany kod albo odmowa OAuth');
export const ebayCallbackPath = '/api/oauth/ebay/callback';
export const ebayConsentBase = (mode: string) =>
  mode === 'sandbox' ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com';
async function connectionLock<T>(tenant: string, id: string, fn: () => Promise<T>) {
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'ebay-oauth');
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
    await lock.query("SET statement_timeout='15s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      `ebay-oauth:${tenant}:${id}`,
    ]);
    return await fn();
    });
  } finally {
    await lock.end();
  }
}
async function admin(c: PoolClient, actor: Actor) {
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) authorized', [actor.userId])).rows[0]
      ?.authorized,
    403,
    'Wymagana aktualna rola administratora',
  );
}
async function idle(c: PoolClient, id: string) {
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM offer_plans WHERE channel_id=$1 AND (state='queued' OR (state IN ('failed','conflict') AND phase NOT IN ('ready','done'))) LIMIT 1",
        [id],
      )
    ).rowCount,
    409,
    'Najpierw uzgodnij rozpoczęte zapisy ofert eBay',
  );
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM ebay_fulfillment_plans WHERE channel_id=$1 AND (state='queued' OR (state IN ('failed','conflict') AND phase IN ('write_started','verify'))) LIMIT 1",
        [id],
      )
    ).rowCount,
    409,
    'Najpierw uzgodnij zgłoszenie wysyłki eBay',
  );
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM jobs WHERE payload->>'channel_id'=$1 AND state IN ('pending','running') LIMIT 1",
        [id],
      )
    ).rowCount,
    409,
    'Poczekaj na zakończenie zadań tego kanału przed OAuth',
  );
}
// Authenticate and lock the browser session before switching to the tenant's RLS role.
// Logout or workspace switching cannot race a committed token/state write.
// No network request runs inside this transaction.
async function oauthTx<T>(
  actor: Actor,
  sessionHash: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  ensure(/^[a-f0-9]{64}$/.test(sessionHash), 401, 'OAuth wymaga sesji przeglądarki');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='8s'");
    ensure(
      (
        await c.query(
          'SELECT 1 FROM sessions WHERE token_hash=$1 AND user_id=$2 AND tenant_id=$3 AND expires_at>now() FOR SHARE',
          [sessionHash, actor.userId, actor.tenantId],
        )
      ).rowCount,
      401,
      'Sesja OAuth wygasła lub zmieniła organizację',
    );
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [actor.tenantId]);
    const result = await fn(c);
    await assertDbLocksHeldInTx(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function beginEbayOAuth(
  actor: Actor,
  id: string,
  sessionHash: string,
  input: z.infer<typeof ebayOAuthStartInput>,
) {
  return connectionLock(actor.tenantId, id, () =>
    oauthTx(actor, sessionHash, async (c) => {
      await admin(c, actor);
      // Config -> channel matches the existing offer worker lock order.
      await c.query('SELECT channel_id FROM offer_sync_configs WHERE channel_id=$1 FOR UPDATE', [
        id,
      ]);
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [id])).rows[0];
      ensure(ch, 404, 'Nie znaleziono integracji');
      ensure(
        ch.provider === 'ebay' && !ch.settings.simulation,
        422,
        'Wymagane rzeczywiste połączenie eBay',
      );
      const credentials = decrypt(ch.credentials),
        ruName = ebayRuName.safeParse(credentials.ru_name);
      ensure(ruName.success, 422, 'Dodaj kanał eBay z RuName aplikacji dla tego środowiska');
      ensure(
        !credentials.refresh_token || input.confirm_same_account,
        422,
        'Potwierdź ponowne połączenie tego samego konta eBay; dla innego konta utwórz nowy kanał',
      );
      ensure(
        !credentials.refresh_token || (await accountBinding(c, id)),
        409,
        'Najpierw sprawdź tożsamość aktualnego konta eBay. Weryfikacja użyje dotychczasowego tokenu, zanim pozwoli go zastąpić.',
      );
      await idle(c, id);
      const inventoryAccess = input.inventory_access ?? ch.settings.inventory_access ?? 'orders';
      const fulfillmentWrite = input.fulfillment_write ?? ch.settings.fulfillment_write ?? false;
      const sellerRead = input.seller_settings_read ?? ch.settings.seller_settings_read ?? false;
      const scope = ebayConsentScopes({
          inventory_access: inventoryAccess,
          fulfillment_write: fulfillmentWrite,
          seller_settings_read: sellerRead,
        }),
        state = randomBytes(32).toString('base64url');
      await c.query(
        'UPDATE oauth_states SET consumed_at=now() WHERE channel_id=$1 AND consumed_at IS NULL',
        [id],
      );
      await c.query(
        "INSERT INTO oauth_states(state_hash,tenant_id,channel_id,user_id,verifier,expires_at,scope) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes',$6)",
        [
          tokenHash(state),
          actor.tenantId,
          id,
          actor.userId,
          encrypt({
            provider: 'ebay',
            connection_hash: ebayConnectionHash(ch),
            session_hash: sessionHash,
            inventory_access: inventoryAccess,
            fulfillment_write: fulfillmentWrite,
            seller_settings_read: sellerRead,
          }),
          scope,
        ],
      );
      await c.query('UPDATE channels SET sync_enabled=false,next_sync_at=NULL WHERE id=$1', [id]);
      await c.query(
        'UPDATE ebay_fulfillment_configs SET enabled=false,external_authorized=false,version=version+1,next_run_at=NULL,updated_at=now() WHERE channel_id=$1',
        [id],
      );
      await c.query(
        'UPDATE offer_sync_configs SET enabled=false,external_authorized=false,version=version+1,next_run_at=NULL,updated_at=now() WHERE channel_id=$1',
        [id],
      );
      await audit(c, actor, 'ebay.oauth.start', id, {
        mode: ch.mode,
        scope,
        schedules_paused: true,
      });
      const url = new URL(ebayConsentBase(ch.mode) + '/oauth2/authorize');
      for (const [k, v] of Object.entries({
        client_id: credentials.client_id,
        redirect_uri: ruName.data,
        response_type: 'code',
        scope,
        state,
        prompt: 'login',
      }))
        url.searchParams.set(k, v);
      return {
        url: url.toString(),
        expires_in: 600,
        scope,
        mode: ch.mode,
        callback_path: ebayCallbackPath,
        schedules_paused: true,
      };
    }),
  );
}
export async function finishEbayOAuth(
  actor: Actor,
  sessionHash: string,
  input: z.infer<typeof ebayOAuthCallback>,
  ctx: IntegrationContext = {},
) {
  const pending = await oauthTx(actor, sessionHash, async (c) => {
    await admin(c, actor);
    const row = (
      await c.query('SELECT * FROM oauth_states WHERE state_hash=$1 AND user_id=$2', [
        tokenHash(input.state),
        actor.userId,
      ])
    ).rows[0];
    ensure(row, 422, 'Nieprawidłowy, wykorzystany lub wygasły stan OAuth');
    const binding = decrypt(row.verifier);
    ensure(
      binding.provider === 'ebay' && binding.session_hash === sessionHash,
      422,
      'OAuth wymaga tej samej sesji przeglądarki i dostawcy',
    );
    return { row, binding };
  });
  return connectionLock(actor.tenantId, pending.row.channel_id, async () => {
    const candidate = await oauthTx(actor, sessionHash, async (c) => {
      await admin(c, actor);
      const row = (
        await c.query(
          'SELECT * FROM oauth_states WHERE state_hash=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now()',
          [pending.row.state_hash, actor.userId],
        )
      ).rows[0];
      ensure(row, 422, 'Nieprawidłowy, wykorzystany lub wygasły stan OAuth');
      const current = (await c.query('SELECT * FROM channels WHERE id=$1', [row.channel_id]))
        .rows[0];
      ensure(
        current?.provider === 'ebay' &&
          !current.settings.simulation &&
          ebayConnectionHash(current) === pending.binding.connection_hash,
        409,
        'Połączenie eBay zmieniło się podczas OAuth',
      );
      return current;
    });
    const limited = ebayLimitedTransport(
      candidate.mode,
      decrypt(candidate.credentials).client_id,
      ctx.transport ?? safeFetch,
    );
    let tokenPermit: EbayApiPermit | undefined, identityPermit: EbayApiPermit | undefined;
    try {
      if (!input.error) {
        tokenPermit = await reserveEbayTransport(
          limited,
          ebayBase(candidate.mode) + '/identity/v1/oauth2/token',
          'POST',
        );
        identityPermit = await reserveEbayTransport(
          limited,
          ebayBase(candidate.mode) + '/ws/api.dll',
          'POST',
        );
      }
      const ch = await oauthTx(actor, sessionHash, async (c) => {
        await admin(c, actor);
        const consumed = (
          await c.query(
            'UPDATE oauth_states SET consumed_at=now() WHERE state_hash=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING channel_id',
            [pending.row.state_hash, actor.userId],
          )
        ).rows[0];
        ensure(consumed, 422, 'Nieprawidłowy, wykorzystany lub wygasły stan OAuth');
        return (await c.query('SELECT * FROM channels WHERE id=$1', [consumed.channel_id])).rows[0];
      });
      ensure(
        ch?.provider === 'ebay' &&
          !ch.settings.simulation &&
          ebayConnectionHash(ch) === pending.binding.connection_hash,
        409,
        'Połączenie eBay zmieniło się podczas OAuth',
      );
      if (input.error) {
        await oauthTx(actor, sessionHash, (c) => audit(c, actor, 'ebay.oauth.denied', ch.id, {}));
        return { id: ch.id, status: 'denied', schedules_paused: true };
      }
      await oauthTx(actor, sessionHash, (c) => idle(c, ch.id));
      const credentials = decrypt(ch.credentials);
      const validateCurrent = () =>
        oauthTx(actor, sessionHash, async (c) => {
          await admin(c, actor);
          const current = (await c.query('SELECT * FROM channels WHERE id=$1', [ch.id])).rows[0];
          ensure(
            current && ebayConnectionHash(current) === pending.binding.connection_hash,
            409,
            'Połączenie eBay zmieniło się podczas OAuth',
          );
          await idle(c, ch.id);
        });
      await validateCurrent();
      // Authorization codes are single-use, are never persisted, logged or retried.
      const response = await sendEbayReserved(
        limited,
        tokenPermit,
        ebayBase(ch.mode) + '/identity/v1/oauth2/token',
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(12000),
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from(credentials.client_id + ':' + credentials.client_secret).toString(
                'base64',
              ),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: input.code!,
            redirect_uri: ebayRuName.parse(credentials.ru_name),
          }).toString(),
        },
      ).catch(() => {
        throw new Problem(
          502,
          'Niepewny wynik OAuth eBay; rozpocznij nową zgodę bez ponawiania kodu',
        );
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Problem(
          [400, 401].includes(response.status) ? 401 : 502,
          'OAuth eBay: HTTP ' + response.status + '; rozpocznij nową zgodę',
        );
      }
      const parsed = z
        .object({
          access_token: ebaySecret,
          refresh_token: ebaySecret,
          expires_in: z.number().int().min(1).max(86400),
          refresh_token_expires_in: z
            .number()
            .int()
            .min(1)
            .max(10 * 366 * 86400),
          token_type: z
            .string()
            .refine((v) => ['bearer', 'user access token'].includes(v.toLowerCase())),
          scope: z.string().max(10000).optional(),
        })
        .safeParse(await ebayJson(response, 64 * 1024));
      ensure(parsed.success, 502, 'Nieprawidłowa odpowiedź OAuth eBay; rozpocznij nową zgodę');
      const tokens = parsed.data;
      ensure(
        tokens.scope === undefined ||
          pending.row.scope.split(' ').every((s: string) => tokens.scope!.split(' ').includes(s)),
        401,
        'OAuth eBay nie potwierdził wymaganych zakresów',
      );
      await validateCurrent();
      const identity = await readEbayAccount(
        ch.mode,
        tokens.access_token,
        limited,
        credentials.client_id,
        identityPermit,
      );
      await oauthTx(actor, sessionHash, async (c) => {
        await admin(c, actor);
        await c.query('SELECT channel_id FROM offer_sync_configs WHERE channel_id=$1 FOR UPDATE', [
          ch.id,
        ]);
        const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [ch.id]))
          .rows[0];
        ensure(
          current && ebayConnectionHash(current) === pending.binding.connection_hash,
          409,
          'Połączenie eBay zmieniło się podczas OAuth',
        );
        await idle(c, ch.id);
        // This comparison and credential replacement commit together under the channel lock.
        await bindAccount(c, actor, current, identity);
        const settings = {
          ...current.settings,
          inventory_access: pending.binding.inventory_access,
          fulfillment_write: pending.binding.fulfillment_write,
          seller_settings_read: pending.binding.seller_settings_read ?? false,
          oauth_connection_id: randomUUID(),
          oauth_refresh_expires_at: new Date(
            Date.now() + tokens.refresh_token_expires_in * 1000,
          ).toISOString(),
        };
        await c.query(
          "UPDATE channels SET credentials=$1,settings=$2,oauth_scopes=$3,token_expires_at=now()+make_interval(secs=>$4),status='authorized_read',sync_enabled=false,next_sync_at=NULL WHERE id=$5",
          [
            encrypt({
              ...credentials,
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
            }),
            JSON.stringify(settings),
            pending.row.scope,
            tokens.expires_in,
            ch.id,
          ],
        );
        await c.query(
          'UPDATE offer_sync_configs SET enabled=false,external_authorized=false,next_run_at=NULL WHERE channel_id=$1',
          [ch.id],
        );
        await audit(c, actor, 'ebay.oauth.connected', ch.id, {
          scope: pending.row.scope,
          mode: ch.mode,
          schedules_paused: true,
        });
      });
      return {
        id: ch.id,
        status: 'authorized_read',
        scope: pending.row.scope,
        schedules_paused: true,
        username: identity.username,
        account_verified: true,
      };
    } finally {
      if (tokenPermit) await releaseEbayApi(tokenPermit).catch(() => {});
      if (identityPermit) await releaseEbayApi(identityPermit).catch(() => {});
    }
  });
}

export { oauthTx as browserOAuthTx };
