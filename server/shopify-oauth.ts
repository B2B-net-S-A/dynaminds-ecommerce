import { randomBytes, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { decrypt, encrypt, tokenHash } from './security';
import { browserOAuthTx } from './ebay-oauth';
import { Shopify, shopifyStore, shopifyId } from './shopify';
import { safeFetch } from './integrations';
import type { IntegrationContext } from './channel-access';
import {
  shopifyRedirect,
  shopifyOAuthInput,
  shopifyRequestedScopes,
  shopifyCallbackParameters,
  verifyShopifyHmac,
  shopifyOAuthHmac,
  shopifyGrantHash,
  shopifyAccountHash,
  effectiveShopifyScopes,
} from './shopify-auth-input';
const scopesSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9_]{1,100}$/))
  .min(1)
  .max(200);
export const shopifyVerifierSchema = z
  .object({
    provider: z.literal('shopify'),
    connection_hash: z.string().regex(/^[a-f0-9]{64}$/),
    store: z.string(),
    client_id: z.string(),
    client_secret: z.string(),
    redirect: z.string(),
    previous_status: z.string(),
    requested: scopesSchema,
  })
  .strict();
const verifierOf = (s: any) => shopifyVerifierSchema.parse(decrypt(s.verifier));
const rawHash = (ch: any) =>
  tokenHash(JSON.stringify([ch.provider, ch.mode, ch.settings, ch.credentials]));
const storeOf = (ch: any) =>
  shopifyStore(
    ch.settings.store_url || (ch.settings.simulation ? `https://qa-${ch.id}.myshopify.com` : ''),
  );
const clientOf = (ch: any) =>
  ch.settings.simulation ? 'DEMO086' : decrypt(ch.credentials).client_id;
const oauthTx = <T>(actor: Actor, session: string, fn: (c: PoolClient) => Promise<T>) =>
  browserOAuthTx(actor, session, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify-oauth:' + actor.tenantId,
    ]);
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
      403,
      'Wymagana aktualna rola administratora',
    );
    return fn(c);
  });
async function channel(c: PoolClient, id: string, lock = false) {
  if (lock)
    await c.query('SELECT channel_id FROM offer_sync_configs WHERE channel_id=$1 FOR UPDATE', [id]);
  const ch = (
    await c.query('SELECT * FROM channels WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id])
  ).rows[0];
  ensure(ch?.provider === 'shopify', 404, 'Nie znaleziono kanału Shopify');
  return ch;
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
    'Najpierw uzgodnij rozpoczęte zapisy ofert Shopify',
  );
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM shopify_fulfillment_plans WHERE channel_id=$1 AND (state='queued' OR (state IN ('failed','conflict') AND phase IN ('write_started','verify'))) LIMIT 1",
        [id],
      )
    ).rowCount,
    409,
    'Najpierw uzgodnij zgłoszenie wysyłki Shopify',
  );
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM jobs WHERE payload->>'channel_id'=$1 AND state IN ('pending','running') LIMIT 1",
        [id],
      )
    ).rowCount,
    409,
    'Poczekaj na zakończenie zadań kanału Shopify',
  );
}
async function accountLock<T>(key: string, fn: () => Promise<T>) {
  const c = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'shopify-oauth');
  await c.connect();
  try {
    return await holdingDbLock(c, async () => {
    await c.query("SET statement_timeout='20s'");
    await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))', ['shopify-oauth:' + key]);
    return await fn();
    });
  } finally {
    await c.end();
  }
}
const boundOf = async (c: PoolClient, id: string) =>
  (await c.query('SELECT * FROM shopify_account_bindings WHERE channel_id=$1', [id])).rows[0];
export async function shopifyAccountPolicy(c: PoolClient, ch: any) {
  ensure(ch?.provider === 'shopify', 404, 'Nie znaleziono kanału Shopify');
  ensure(
    !['shopify_oauth_pending', 'shopify_reauthorization_required'].includes(ch.status),
    409,
    'Zakończ ponowne połączenie Shopify przed odczytem lub zapisem',
  );
  const creds = decrypt(ch.credentials);
  if (!creds.oauth_grant_id) {
    ensure(creds.access_token || ch.settings.simulation, 401, 'Połącz sklep Shopify przez OAuth');
    return;
  }
  const b = await boundOf(c, ch.id);
  ensure(
    b &&
      b.grant_id === creds.oauth_grant_id &&
      b.grant_hash === shopifyGrantHash(ch) &&
      b.store_url === storeOf(ch) &&
      b.client_id === clientOf(ch) &&
      b.mode === ch.mode &&
      b.source === (ch.settings.simulation ? 'simulation' : 'graphql') &&
      b.scopes.join(',') === creds.granted_scope,
    409,
    'Dane zgody Shopify zmieniono; wymagane pierwotne połączenie',
  );
}
export async function cachedShopifyAccount(actor: Actor, session: string, id: string) {
  return oauthTx(actor, session, async (c) => {
    const ch = await channel(c, id),
      b = await boundOf(c, id),
      creds = decrypt(ch.credentials);
    const s = (
      await c.query(
        "SELECT state,expires_at FROM shopify_oauth_states WHERE channel_id=$1 AND state IN ('pending','exchanging','failed')",
        [id],
      )
    ).rows[0];
    let matches = true;
    if (b) {
      try {
        await shopifyAccountPolicy(c, { ...ch, status: 'authorized_read' });
      } catch {
        matches = false;
      }
    }
    return {
      bound: !!b,
      shop_id: b?.shop_id ?? null,
      store_url: b?.store_url ?? storeOf(ch),
      source: b?.source ?? null,
      mode: ch.mode,
      scopes: b?.scopes ?? [],
      verified_at: b?.verified_at ?? null,
      has_refresh_token: !!creds.refresh_token,
      has_access_token: !!creds.access_token,
      client_configured: ch.settings.simulation || !!(creds.client_id && creds.client_secret),
      token_expires_at: ch.token_expires_at,
      refresh_expires_at: creds.refresh_expires_at ?? null,
      grant_matches: matches,
      simulation: !!ch.settings.simulation,
      pending: !!s,
      pending_state: s?.state ?? null,
      pending_expired: !!s && new Date(s.expires_at).getTime() <= Date.now(),
    };
  });
}
export async function beginShopifyOAuth(
  actor: Actor,
  session: string,
  id: string,
  input: z.infer<typeof shopifyOAuthInput>,
) {
  const initial = await oauthTx(actor, session, (c) => channel(c, id)),
    store = storeOf(initial),
    client = clientOf(initial);
  ensure(client, 422, 'Dodaj Client ID i sekret aplikacji w nowym kanale Shopify');
  return accountLock(shopifyAccountHash(store, client), () =>
    oauthTx(actor, session, async (c) => {
      const ch = await channel(c, id, true),
        b = await boundOf(c, id),
        creds = decrypt(ch.credentials);
      ensure(
        rawHash(ch) === rawHash(initial),
        409,
        'Połączenie Shopify zmieniło się przed rozpoczęciem zgody',
      );
      await idle(c, id);
      ensure(
        input.confirm_same_account || (!b && !creds.access_token) || ch.settings.simulation,
        422,
        'Potwierdź ponowne połączenie tego samego sklepu',
      );
      if (b) await shopifyAccountPolicy(c, { ...ch, status: 'authorized_read' });
      if (!b && !ch.settings.simulation)
        ensure(
          !(
            await c.query(
              'SELECT 1 FROM orders WHERE channel_id=$1 UNION ALL SELECT 1 FROM listings WHERE channel_id=$1 UNION ALL SELECT 1 FROM inbound_orders WHERE channel_id=$1 LIMIT 1',
              [id],
            )
          ).rowCount,
          409,
          'Kanał ma dane wcześniejszego połączenia. Zachowaj go i utwórz nowy kanał OAuth',
        );
      const previous = (
        await c.query(
          "SELECT * FROM shopify_oauth_states WHERE channel_id=$1 AND state IN ('pending','exchanging','failed') FOR UPDATE",
          [id],
        )
      ).rows[0];
      ensure(
        previous?.state !== 'exchanging' || new Date(previous.expires_at).getTime() <= Date.now(),
        409,
        'Trwa wymiana kodu Shopify',
      );
      const previousStatus = previous
        ? previous.exchange_started_at
          ? 'shopify_reauthorization_required'
          : verifierOf(previous).previous_status
        : ch.status;
      await c.query(
        "UPDATE shopify_oauth_states SET state='cancelled',consumed_at=coalesce(consumed_at,now()) WHERE channel_id=$1 AND state IN ('pending','failed','exchanging')",
        [id],
      );
      const state = randomBytes(32).toString('hex'),
        attempt = randomUUID(),
        requested = shopifyRequestedScopes(input),
        redirect = shopifyRedirect(
          ch.settings.oauth_redirect_uri || 'http://127.0.0.1:4100/api/oauth/shopify/callback',
        ),
        verifier = {
          provider: 'shopify',
          connection_hash: rawHash(ch),
          store,
          client_id: client,
          client_secret: ch.settings.simulation ? 'DEMO-Shopify-secret-086' : creds.client_secret,
          redirect,
          previous_status: previousStatus,
          requested,
        };
      ensure(verifier.client_secret, 422, 'Brak sekretu aplikacji Shopify');
      await c.query(
        "INSERT INTO shopify_oauth_states(id,tenant_id,channel_id,user_id,session_hash,state_hash,account_hash,verifier,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes')",
        [
          attempt,
          actor.tenantId,
          id,
          actor.userId,
          session,
          tokenHash(state),
          shopifyAccountHash(store, client),
          encrypt(verifier),
        ],
      );
      ensure(
        (await c.query('SELECT shopify_oauth_claim($1) ok', [attempt])).rows[0]?.ok,
        409,
        'To połączenie sklepu i aplikacji jest już przypisane do innej firmy lub kanału',
      );
      await c.query(
        "UPDATE channels SET status='shopify_oauth_pending',sync_enabled=false,next_sync_at=NULL WHERE id=$1",
        [id],
      );
      if (
        (await c.query("SELECT to_regclass('public.shopify_webhook_configs') present")).rows[0]
          .present
      )
        await c.query(
          'UPDATE shopify_webhook_configs SET enabled=false,version=version+1,updated_at=now() WHERE channel_id=$1',
          [id],
        );
      await c.query(
        'UPDATE offer_sync_configs SET enabled=false,external_authorized=false,version=version+1,next_run_at=NULL WHERE channel_id=$1',
        [id],
      );
      await audit(c, actor, 'shopify.oauth.start', id, {
        source: ch.settings.simulation ? 'simulation' : 'external_consent',
        requested,
      });
      const url = new URL(store + '/admin/oauth/authorize');
      Object.entries({
        client_id: client,
        scope: requested.join(','),
        redirect_uri: redirect,
        state,
      }).forEach(([k, v]) => url.searchParams.set(k, v));
      const demo = new URL(redirect),
        params = {
          shop: new URL(store).hostname,
          state,
          timestamp: String(Math.floor(Date.now() / 1000)),
          code: 'DEMO-CODE086',
        };
      Object.entries({ ...params, hmac: shopifyOAuthHmac(params, verifier.client_secret) }).forEach(
        ([k, v]) => demo.searchParams.set(k, v),
      );
      return {
        channel_id: id,
        url: ch.settings.simulation ? null : url.toString(),
        expires_in: 600,
        requested_scopes: requested,
        store_url: store,
        scope: ch.settings.simulation ? 'local_simulation' : 'external_consent',
        ...(ch.settings.simulation ? { demo_return_url: demo.toString() } : {}),
      };
    }),
  );
}
export async function cancelShopifyOAuth(actor: Actor, session: string, id: string) {
  const initial = await oauthTx(actor, session, (c) => channel(c, id));
  return accountLock(shopifyAccountHash(storeOf(initial), clientOf(initial) || ''), () =>
    oauthTx(actor, session, async (c) => {
      const ch = await channel(c, id, true),
        s = (
          await c.query(
            "SELECT * FROM shopify_oauth_states WHERE channel_id=$1 AND state IN ('pending','exchanging','failed') FOR UPDATE",
            [id],
          )
        ).rows[0];
      if (!s) return { channel_id: id, status: 'idle' };
      ensure(
        s.user_id === actor.userId && s.session_hash === session,
        409,
        'Anulowanie wymaga sesji, która rozpoczęła tę zgodę',
      );
      ensure(
        s.state !== 'exchanging' || new Date(s.expires_at).getTime() <= Date.now(),
        409,
        'Trwa wymiana kodu Shopify',
      );
      const v = verifierOf(s);
      ensure(rawHash(ch) === v.connection_hash, 409, 'Połączenie zmieniono podczas zgody');
      await c.query(
        "UPDATE shopify_oauth_states SET state='cancelled',consumed_at=coalesce(consumed_at,now()) WHERE id=$1",
        [s.id],
      );
      const status = s.exchange_started_at ? 'shopify_reauthorization_required' : v.previous_status;
      await c.query('UPDATE channels SET status=$2 WHERE id=$1', [id, status]);
      await c.query('SELECT shopify_oauth_release($1)', [id]);
      await audit(c, actor, 'shopify.oauth.cancel', id, {
        exchange_started: !!s.exchange_started_at,
      });
      return { channel_id: id, status };
    }),
  );
}
const tokenSchema = z.object({
  access_token: z
    .string()
    .min(16)
    .max(4096)
    .regex(/^[^\s\x00-\x1f\x7f]+$/),
  refresh_token: z
    .string()
    .min(16)
    .max(4096)
    .regex(/^[^\s\x00-\x1f\x7f]+$/),
  expires_in: z.number().int().min(61).max(86400),
  refresh_token_expires_in: z.number().int().min(1).max(31622400),
  scope: z.string().max(8192).optional(),
  associated_user: z.never().optional(),
});
async function tokens(
  store: string,
  credentials: Record<string, string>,
  params: Record<string, string>,
  ctx: IntegrationContext,
) {
  let response: Response;
  try {
    response = await (ctx.transport ?? safeFetch)(store + '/admin/oauth/access_token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        ...params,
      }).toString(),
    });
  } catch {
    throw new Problem(502, 'Brak odpowiedzi autoryzacji Shopify; wynik żądania nie jest znany');
  }
  ensure(
    response.ok,
    response.status === 401 ? 401 : 502,
    `Autoryzacja Shopify: HTTP ${response.status}`,
  );
  const reader = response.body?.getReader();
  ensure(reader, 502, 'Brak odpowiedzi autoryzacji Shopify');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      ensure(size <= 32768, 502, 'Zbyt duża odpowiedź autoryzacji Shopify');
      chunks.push(part.value);
    }
  } catch (e) {
    if (e instanceof Problem) throw e;
    throw new Problem(502, 'Niekompletna odpowiedź autoryzacji Shopify');
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks);
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(bytes).toString());
  } catch {
    throw new Problem(502, 'Nieprawidłowa odpowiedź autoryzacji Shopify');
  }
  const parsed = tokenSchema.safeParse(body);
  ensure(parsed.success, 502, 'Nieprawidłowy wygasający token offline Shopify');
  const t = parsed.data,
    scopes = t.scope ? scopesSchema.safeParse(t.scope.split(',')) : null;
  ensure(!t.scope || scopes?.success, 502, 'Nieprawidłowe zakresy zgody Shopify');
  return { ...t, issued_at: Date.now() };
}
export async function finishShopifyReturn(
  actor: Actor,
  session: string,
  value: string,
  ctx: IntegrationContext = {},
) {
  const { url, params } = shopifyCallbackParameters(value);
  const pending = await oauthTx(actor, session, async (c) => {
    const s = (
      await c.query(
        "SELECT * FROM shopify_oauth_states WHERE state_hash=$1 AND user_id=$2 AND session_hash=$3 AND state='pending' AND expires_at>now()",
        [tokenHash(params.state), actor.userId, session],
      )
    ).rows[0];
    ensure(s, 422, 'Nieprawidłowy, wykorzystany lub wygasły stan Shopify');
    return s;
  });
  return accountLock(pending.account_hash, async () => {
    const check = () =>
      oauthTx(actor, session, async (c) => {
        const ch = await channel(c, pending.channel_id, true),
          s = (
            await c.query('SELECT * FROM shopify_oauth_states WHERE id=$1 FOR UPDATE', [pending.id])
          ).rows[0],
          v = verifierOf(s);
        ensure(
          s.state === 'exchanging' &&
            ch.status === 'shopify_oauth_pending' &&
            rawHash(ch) === v.connection_hash,
          409,
          'Zgoda lub połączenie Shopify zmieniło się podczas autoryzacji',
        );
        await idle(c, ch.id);
        ensure(
          (await c.query('SELECT shopify_oauth_claim($1) ok', [s.id])).rows[0]?.ok,
          409,
          'Sklep Shopify ma inne przypisanie',
        );
        return { ch, s, v };
      });
    await oauthTx(actor, session, async (c) => {
      const ch = await channel(c, pending.channel_id, true),
        s = (
          await c.query(
            "SELECT * FROM shopify_oauth_states WHERE id=$1 AND state='pending' AND expires_at>now() FOR UPDATE",
            [pending.id],
          )
        ).rows[0];
      ensure(s, 422, 'Nieprawidłowy, wykorzystany lub wygasły stan Shopify');
      const v = verifierOf(s);
      ensure(
        url.origin + url.pathname === v.redirect &&
          !url.hash &&
          !url.username &&
          !url.password &&
          params.shop === new URL(v.store).hostname,
        422,
        'Powrót dotyczy innego adresu lub sklepu Shopify',
      );
      verifyShopifyHmac(params, v.client_secret);
      ensure(
        ch.status === 'shopify_oauth_pending' && rawHash(ch) === v.connection_hash,
        409,
        'Połączenie Shopify zmieniło się od rozpoczęcia',
      );
      await idle(c, ch.id);
      await c.query(
        "UPDATE shopify_oauth_states SET state='exchanging',exchange_started_at=now(),consumed_at=now() WHERE id=$1",
        [s.id],
      );
    });
    try {
      const { ch, v } = await check(),
        grant = randomUUID();
      let t: z.infer<typeof tokenSchema> & { issued_at: number }, shop: string, scopes: string[];
      if (ch.settings.simulation) {
        t = {
          access_token: 'DEMO-access-' + grant,
          refresh_token: 'DEMO-refresh-' + grant,
          expires_in: 3600,
          refresh_token_expires_in: 7776000,
          scope: v.requested.join(','),
          issued_at: Date.now(),
        };
        shop =
          'gid://shopify/Shop/' +
          (BigInt('0x' + ch.id.replaceAll('-', '').slice(0, 15)) + 1n).toString();
        scopes = v.requested;
      } else {
        t = await tokens(
          v.store,
          { client_id: v.client_id, client_secret: v.client_secret },
          { code: params.code, expiring: '1' },
          ctx,
        );
        const tokenScopes = effectiveShopifyScopes((t.scope ?? '').split(','));
        ensure(
          v.requested.every((s) => tokenScopes.includes(s)),
          403,
          'Token Shopify nie obejmuje zamówionych zakresów',
        );
        const result = await new Shopify(
          { store_url: v.store },
          { access_token: t.access_token },
          async (u, i) => {
            await check();
            return (ctx.transport ?? safeFetch)(u, i);
          },
        ).test();
        shop = shopifyId(result.shop?.id, 'Shop');
        scopes = scopesSchema.parse([...new Set(result.scopes)].sort());
        const effective = effectiveShopifyScopes(scopes);
        ensure(
          v.requested.every((s) => effective.includes(s)),
          403,
          'API Shopify nie potwierdziło zamówionych zakresów',
        );
        ensure(
          effective.join(',') === tokenScopes.join(','),
          403,
          'Token i API Shopify wskazują różne zakresy',
        );
      }
      const saved = encrypt({
        client_id: v.client_id,
        client_secret: v.client_secret,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        oauth_grant_id: grant,
        granted_scope: scopes.join(','),
        refresh_expires_at: new Date(t.issued_at + t.refresh_token_expires_in * 1000).toISOString(),
      });
      await check();
      await oauthTx(actor, session, async (c) => {
        const current = await channel(c, ch.id, true),
          s = (
            await c.query('SELECT * FROM shopify_oauth_states WHERE id=$1 FOR UPDATE', [pending.id])
          ).rows[0];
        ensure(
          s.state === 'exchanging' &&
            rawHash(current) === v.connection_hash &&
            current.status === 'shopify_oauth_pending',
          409,
          'Połączenie zmieniło się przed zapisaniem tokenu Shopify',
        );
        await idle(c, ch.id);
        const b = await boundOf(c, ch.id);
        ensure(
          !b ||
            (b.store_url === v.store &&
              b.shop_id === shop &&
              b.client_id === v.client_id &&
              b.mode === ch.mode &&
              b.source === (ch.settings.simulation ? 'simulation' : 'graphql')),
          409,
          'To inne konto Shopify niż przypisane do kanału; utwórz nowy kanał',
        );
        await c.query(
          `INSERT INTO shopify_account_bindings(tenant_id,channel_id,store_url,shop_id,client_id,mode,source,grant_id,grant_hash,scopes,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,channel_id) DO UPDATE SET grant_id=EXCLUDED.grant_id,grant_hash=EXCLUDED.grant_hash,scopes=EXCLUDED.scopes,actor_id=EXCLUDED.actor_id,verified_at=now()`,
          [
            actor.tenantId,
            ch.id,
            v.store,
            shop,
            v.client_id,
            ch.mode,
            ch.settings.simulation ? 'simulation' : 'graphql',
            grant,
            shopifyGrantHash({ ...ch, credentials: saved }),
            scopes,
            actor.userId,
          ],
        );
        await c.query(
          'UPDATE channels SET credentials=$2,token_expires_at=$3::timestamptz,oauth_scopes=$4,status=$5 WHERE id=$1',
          [
            ch.id,
            saved,
            new Date(t.issued_at + t.expires_in * 1000).toISOString(),
            scopes.join(','),
            ch.settings.simulation ? 'simulation' : 'authorized_read',
          ],
        );
        await c.query("UPDATE shopify_oauth_states SET state='done' WHERE id=$1", [s.id]);
        await audit(c, actor, 'shopify.oauth.connected', ch.id, {
          source: ch.settings.simulation ? 'simulation' : 'graphql',
          shop_id: shop,
          scopes,
        });
      });
      return {
        channel_id: ch.id,
        status: ch.settings.simulation ? 'simulation' : 'authorized_read',
        shop_id: shop,
        scope: ch.settings.simulation ? 'local_simulation' : 'graphql',
      };
    } catch (e) {
      // Never retry a consumed authorization code. Even a failed exchange can retire old tokens.
      await tenantTx(actor.tenantId, (c) =>
        c.query(
          "UPDATE shopify_oauth_states SET state='failed',error='Autoryzacja nie została ukończona; rozpocznij nową zgodę' WHERE id=$1 AND state='exchanging'",
          [pending.id],
        ),
      ).catch(() => {});
      throw e;
    }
  });
}
export async function refreshShopifyOAuth(
  tenantId: string,
  id: string,
  expected: string | undefined,
  ctx: IntegrationContext = {},
  validate?: (ch: any) => void | Promise<void>,
) {
  const initial = await tenantTx(tenantId, (c) => channel(c, id));
  return accountLock(shopifyAccountHash(storeOf(initial), clientOf(initial) || ''), async () => {
    const ch = await tenantTx(tenantId, async (c) => {
        const ch = await channel(c, id);
        await shopifyAccountPolicy(c, ch);
        return ch;
      }),
      creds = decrypt(ch.credentials);
    ensure(
      creds.oauth_grant_id && !ch.settings.simulation,
      422,
      'Wymagana rzeczywista zgoda OAuth Shopify',
    );
    await validate?.(ch);
    if (expected && creds.access_token !== expected) return ch;
    if (
      !expected &&
      ch.token_expires_at &&
      new Date(ch.token_expires_at).getTime() > Date.now() + 60000
    )
      return ch;
    ensure(
      creds.refresh_token && Date.parse(creds.refresh_expires_at) > Date.now(),
      401,
      'Zgoda Shopify wygasła; połącz ponownie ten sam sklep',
    );
    const t = await tokens(
      storeOf(ch),
      creds,
      { grant_type: 'refresh_token', refresh_token: creds.refresh_token },
      ctx,
    );
    ensure(
      !t.scope ||
        effectiveShopifyScopes(t.scope.split(',')).join(',') ===
          effectiveShopifyScopes(creds.granted_scope.split(',')).join(','),
      403,
      'Zakresy Shopify zmieniły się; połącz ponownie sklep',
    );
    await validate?.(ch);
    await tenantTx(tenantId, async (c) => {
      const current = await channel(c, id, true);
      await shopifyAccountPolicy(c, current);
      ensure(
        rawHash(current) === rawHash(ch),
        409,
        'Połączenie Shopify zmieniło się podczas odświeżania',
      );
      await c.query(
        'UPDATE channels SET credentials=$2,token_expires_at=$3::timestamptz WHERE id=$1',
        [
          id,
          encrypt({
            ...creds,
            access_token: t.access_token,
            refresh_token: t.refresh_token,
            refresh_expires_at: new Date(
              t.issued_at + t.refresh_token_expires_in * 1000,
            ).toISOString(),
          }),
          new Date(t.issued_at + t.expires_in * 1000).toISOString(),
        ],
      );
    });
    return tenantTx(tenantId, (c) => channel(c, id));
  });
}
