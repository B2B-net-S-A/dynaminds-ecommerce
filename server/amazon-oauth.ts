import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { encrypt, decrypt, tokenHash } from './security';
import { browserOAuthTx } from './ebay-oauth';
import type { IntegrationContext } from './channel-access';
import { safeFetch } from './integrations';
import { amazonSettings, amazonConnectionCredentials } from './amazon';
import { amazonApiTransport } from './amazon-api-limits';
import { amazonSellerHash } from './amazon-account';
import { amazonCatalogHash } from './amazon-catalog';
export const AMAZON_CALLBACK = '/api/oauth/amazon/callback';
const secret = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\s\x00-\x1f\x7f]+$/);
export const amazonOAuthInput = z
  .object({ confirm_same_account: z.boolean().default(false) })
  .strict();
export const amazonOAuthFinish = z
  .object({
    state: z.string().regex(/^[a-f0-9]{64}$/),
    selling_partner_id: z
      .string()
      .regex(/^[A-Z0-9]{1,32}$/)
      .optional(),
    spapi_oauth_code: secret.optional(),
    error: z.literal('access_denied').optional(),
  })
  .strict()
  .refine(
    (b) => (b.error ? !b.spapi_oauth_code : !!b.spapi_oauth_code && !!b.selling_partner_id),
    'Wymagany kod i sprzedawca albo anulowanie',
  );
export const amazonLoginInput = z
  .object({
    amazon_callback_uri: z.string().url().max(2048),
    amazon_state: secret,
    selling_partner_id: z.string().regex(/^[A-Z0-9]{1,32}$/),
    version: z.literal('beta').optional(),
  })
  .strict();
const verifierSchema = z
  .object({
    provider: z.literal('amazon'),
    connection_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expected_seller: z.string().regex(/^[A-Z0-9]{1,32}$/),
    previous_status: z.string().min(1).max(100),
    redirect: z.string().url(),
    beta: z.boolean(),
    application_id: z.string(),
    session_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const verifierOf = (value: string) => verifierSchema.parse(decrypt(value));
const oauthHash = (ch: any) =>
  amazonCatalogHash({ mode: ch.mode, settings: ch.settings, credentials: ch.credentials });
export function amazonRedirect(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Problem(422, 'Nieprawidłowy adres powrotu Amazon');
  }
  ensure(
    ['http:', 'https:'].includes(u.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      u.pathname === AMAZON_CALLBACK,
    422,
    'Adres powrotu Amazon musi wskazywać lokalny callback aplikacji',
  );
  return u.toString();
}
// Official Seller Central URL table; these five European stores use the shared host.
export function amazonSellerCentral(market: string) {
  const eu = 'sellercentral-europe.amazon.com';
  const domains: Record<string, string> = {
    A1C3SOZRARQ6R3: 'sellercentral.amazon.pl',
    A1PA6795UKMFR9: eu,
    A1F83G8C2ARO7P: eu,
    A13V1IB3VIYZZH: eu,
    APJ6JRA9NG5V4: eu,
    A1RKKUPIHCS9HS: eu,
    AMEN7PMS3EDWL: 'sellercentral.amazon.com.be',
    A1805IZSGTT6HS: 'sellercentral.amazon.nl',
    A28R8C7NBKEWEA: 'sellercentral.amazon.ie',
    A2NODRKZP88ZB9: 'sellercentral.amazon.se',
    AE08WJ6YKNBMC: 'sellercentral.amazon.co.za',
    ARBP9OOSHTCHU: 'sellercentral.amazon.eg',
    ATVPDKIKX0DER: 'sellercentral.amazon.com',
    A2EUQ1WTGCTBG2: 'sellercentral.amazon.ca',
    A1AM78C64UM0Y8: 'sellercentral.amazon.com.mx',
    A2Q3Y263D00KWC: 'sellercentral.amazon.com.br',
    A19VAU5U5O7RUS: 'sellercentral.amazon.sg',
    A39IBJ37TRP1C6: 'sellercentral.amazon.com.au',
    A1VC38T7YXB528: 'sellercentral.amazon.co.jp',
    A21TJRUUN4KGV: 'sellercentral.amazon.in',
    A33AVAJ2PDY3EV: 'sellercentral.amazon.com.tr',
    A2VIGQ35RCS4UG: 'sellercentral.amazon.ae',
    A17E79C6D8DWNP: 'sellercentral.amazon.sa',
  };
  ensure(domains[market], 422, 'Brak zweryfikowanego adresu Seller Central dla tego rynku');
  return 'https://' + domains[market];
}
// Serialize only short local OAuth transactions. Never hold this lock during HTTP.
const oauthTx = <T>(actor: Actor, session: string, fn: (c: PoolClient) => Promise<T>) =>
  browserOAuthTx(actor, session, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'amazon-oauth:' + actor.tenantId,
    ]);
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
      403,
      'Wymagana aktualna rola administratora',
    );
    return fn(c);
  });
async function idle(c: PoolClient, id: string) {
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM offer_plans WHERE channel_id=$1 AND (state='queued' OR (state IN ('failed','conflict') AND phase NOT IN ('ready','done'))) LIMIT 1",
        [id],
      )
    ).rowCount,
    409,
    'Najpierw uzgodnij rozpoczęte zapisy ofert Amazon',
  );
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM jobs WHERE payload->>'channel_id'=$1 AND state IN ('pending','running') LIMIT 1",
        [id],
      )
    ).rowCount,
    409,
    'Poczekaj na zakończenie zadań kanału Amazon',
  );
}
async function channel(c: PoolClient, id: string) {
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(ch?.provider === 'amazon', 404, 'Nie znaleziono kanału Amazon');
  return ch;
}
async function binding(c: PoolClient, ch: any, seller: string) {
  const b = (await c.query('SELECT * FROM amazon_account_bindings WHERE channel_id=$1', [ch.id]))
    .rows[0];
  ensure(
    !b ||
      (b.seller_hash === amazonSellerHash(ch, seller) &&
        b.mode === ch.mode &&
        b.region === ch.settings.region),
    409,
    'To inny sprzedawca Amazon niż przypisany do kanału. Utwórz nowe połączenie; dotychczasowe dane zachowano',
  );
  return b;
}
const credentialsOf = (ch: any) =>
  ch.settings.simulation
    ? { client_id: 'DEMO076', client_secret: 'DEMO076', refresh_token: '' }
    : amazonConnectionCredentials.parse(decrypt(ch.credentials));
export async function cachedAmazonAccount(actor: Actor, session: string, id: string) {
  return oauthTx(actor, session, async (c) => {
    const ch = await channel(c, id),
      b = (await c.query('SELECT * FROM amazon_account_bindings WHERE channel_id=$1', [id]))
        .rows[0];
    const pending = (
      await c.query('SELECT id,expires_at,consumed_at FROM amazon_oauth_states WHERE id=$1', [
        ch.amazon_oauth_attempt,
      ])
    ).rows[0];
    return {
      bound: !!b,
      seller_id: ch.settings.selling_partner_id || null,
      source: b?.source ?? null,
      authorized_at: b?.authorized_at ?? null,
      mode: ch.mode,
      region: ch.settings.region,
      simulation: ch.settings.simulation === true,
      has_refresh_token: !!decrypt(ch.credentials).refresh_token,
      pending: !!pending && new Date(pending.expires_at).getTime() > Date.now(),
      pending_expired:
        ch.status === 'amazon_oauth_pending' &&
        (!pending || new Date(pending.expires_at).getTime() <= Date.now()),
      api_identity_verified: false,
      grant_matches:
        !b ||
        (b.grant_hash === tokenHash(ch.credentials) &&
          b.seller_hash === amazonSellerHash(ch) &&
          b.mode === ch.mode &&
          b.region === ch.settings.region),
      reauthorize_due: !!b && Date.now() - new Date(b.authorized_at).getTime() > 365 * 86400000,
    };
  });
}
export async function beginAmazonOAuth(
  actor: Actor,
  session: string,
  id: string,
  input: z.infer<typeof amazonOAuthInput>,
) {
  return oauthTx(actor, session, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'offer-sync-config:' + actor.tenantId + ':' + id,
    ]);
    await c.query('SELECT channel_id FROM offer_sync_configs WHERE channel_id=$1 FOR UPDATE', [id]);
    const ch = await channel(c, id);
    await idle(c, id);
    const settings = amazonSettings.parse(ch.settings),
      credentials = credentialsOf(ch);
    const seller =
      settings.selling_partner_id ||
      (ch.settings.simulation ? 'ADEMO' + id.replaceAll('-', '').slice(0, 16).toUpperCase() : '');
    ensure(seller, 422, 'Podaj identyfikator oczekiwanego sprzedawcy przed rozpoczęciem OAuth');
    const b = await binding(c, ch, seller);
    ensure(
      !b || b.grant_hash === tokenHash(ch.credentials),
      409,
      'Grant kanału zmieniono poza zarządzanym OAuth; przywróć pierwotne połączenie',
    );
    ensure(
      ch.settings.simulation || input.confirm_same_account || (!credentials.refresh_token && !b),
      422,
      'Potwierdź ponowne połączenie tego samego sprzedawcy',
    );
    if (!b && !ch.settings.simulation)
      ensure(
        !(
          await c.query(
            'SELECT 1 FROM listings WHERE channel_id=$1 UNION ALL SELECT 1 FROM inbound_orders WHERE channel_id=$1 UNION ALL SELECT 1 FROM orders WHERE channel_id=$1 LIMIT 1',
            [id],
          )
        ).rowCount,
        409,
        'Starszy kanał ma historię bez przypisania OAuth. Utwórz nowy kanał przed zarządzaną zgodą; nie przypisujemy historii na podstawie ręcznego ID',
      );
    const redirect = amazonRedirect(settings.oauth_redirect_uri);
    if (!ch.settings.simulation)
      ensure(settings.application_id, 422, 'Uzupełnij ID zarejestrowanej aplikacji SP-API');
    // Invalidate the prior attempt for this channel, even if started by another browser or already exchanging a code.
    const previous = (
      await c.query(
        'SELECT s.* FROM amazon_oauth_states s JOIN channels ch ON ch.id=s.channel_id WHERE s.id=ch.amazon_oauth_attempt AND (s.channel_id=$1 OR (s.user_id=$2 AND s.session_hash=$3)) FOR UPDATE OF s',
        [id, actor.userId, session],
      )
    ).rows;
    let previousStatus = ch.status;
    for (const p of previous) {
      const v = verifierOf(p.verifier);
      if (p.channel_id === id) previousStatus = v.previous_status;
      await c.query(
        'UPDATE amazon_oauth_states SET consumed_at=coalesce(consumed_at,now()) WHERE id=$1',
        [p.id],
      );
      await c.query(
        'UPDATE channels SET amazon_oauth_attempt=NULL,status=$2 WHERE id=$1 AND amazon_oauth_attempt=$3',
        [p.channel_id, v.previous_status, p.id],
      );
    }
    ensure(
      previousStatus !== 'amazon_oauth_pending',
      409,
      'Anuluj niepełną próbę OAuth przed ponownym połączeniem',
    );
    const state = randomBytes(32).toString('hex'),
      attempt = randomUUID(),
      url = new URL(amazonSellerCentral(settings.marketplace_id) + '/apps/authorize/consent');
    url.searchParams.set(
      'application_id',
      settings.application_id || 'amzn1.sellerapps.app.DEMO076',
    );
    url.searchParams.set('state', state);
    if (settings.oauth_beta) url.searchParams.set('version', 'beta');
    const verifier = {
      provider: 'amazon',
      connection_hash: oauthHash(ch),
      expected_seller: seller,
      previous_status: previousStatus,
      redirect,
      beta: settings.oauth_beta,
      application_id: settings.application_id,
      session_hash: session,
    };
    await c.query(
      "INSERT INTO amazon_oauth_states(id,tenant_id,channel_id,user_id,session_hash,state_hash,verifier,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')",
      [attempt, actor.tenantId, id, actor.userId, session, tokenHash(state), encrypt(verifier)],
    );
    await c.query(
      "UPDATE channels SET status='amazon_oauth_pending',amazon_oauth_attempt=$2,sync_enabled=false,next_sync_at=NULL WHERE id=$1",
      [id, attempt],
    );
    await c.query(
      'UPDATE offer_sync_configs SET enabled=false,external_authorized=false,version=version+1,next_run_at=NULL,updated_at=now() WHERE channel_id=$1',
      [id],
    );
    await audit(c, actor, 'amazon.oauth.start', id, {
      mode: ch.mode,
      source: ch.settings.simulation ? 'simulation' : 'oauth',
      beta: settings.oauth_beta,
    });
    const demo = new URL(redirect);
    demo.searchParams.set('state', state);
    demo.searchParams.set('selling_partner_id', seller);
    demo.searchParams.set('spapi_oauth_code', 'DEMO-CODE076');
    return {
      channel_id: id,
      expected_seller: seller,
      url: ch.settings.simulation ? null : url.toString(),
      redirect_uri: redirect,
      expires_in: 600,
      scope: ch.settings.simulation ? 'local_simulation' : 'external_consent',
      ...(ch.settings.simulation ? { demo_return_url: demo.toString() } : {}),
    };
  });
}
export async function cancelAmazonOAuth(actor: Actor, session: string, id: string) {
  return oauthTx(actor, session, async (c) => {
    const ch = await channel(c, id);
    if (!ch.amazon_oauth_attempt) return { status: 'idle', channel_id: id };
    const s = (
      await c.query(
        'SELECT * FROM amazon_oauth_states WHERE id=$1 AND user_id=$2 AND session_hash=$3 FOR UPDATE',
        [ch.amazon_oauth_attempt, actor.userId, session],
      )
    ).rows[0];
    ensure(s, 409, 'Anulowanie wymaga sesji, która rozpoczęła tę zgodę');
    const v = verifierOf(s.verifier);
    await c.query(
      'UPDATE amazon_oauth_states SET consumed_at=coalesce(consumed_at,now()) WHERE id=$1',
      [s.id],
    );
    await c.query('UPDATE channels SET status=$2,amazon_oauth_attempt=NULL WHERE id=$1', [
      id,
      v.previous_status,
    ]);
    await audit(c, actor, 'amazon.oauth.cancel', id, {});
    return { status: 'denied', channel_id: id };
  });
}
export async function finishAmazonOAuth(
  actor: Actor,
  session: string,
  input: z.infer<typeof amazonOAuthFinish>,
  ctx: IntegrationContext = {},
  returnBase?: string,
) {
  const pending = await oauthTx(actor, session, async (c) => {
    const s = (
      await c.query(
        'SELECT * FROM amazon_oauth_states WHERE state_hash=$1 AND user_id=$2 AND session_hash=$3 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
        [tokenHash(input.state), actor.userId, session],
      )
    ).rows[0];
    ensure(s, 422, 'Próba OAuth wygasła, została użyta lub należy do innej sesji');
    const v = verifierOf(s.verifier),
      ch = await channel(c, s.channel_id);
    ensure(
      returnBase === undefined || amazonRedirect(returnBase) === v.redirect,
      422,
      'Adres powrotu nie pasuje do rozpoczętej zgody',
    );
    ensure(
      ch.amazon_oauth_attempt === s.id && oauthHash(ch) === v.connection_hash,
      409,
      'Połączenie zmieniło się od rozpoczęcia OAuth',
    );
    ensure(
      input.error || input.selling_partner_id === v.expected_seller,
      409,
      'Powrót OAuth dotyczy innego sprzedawcy niż wybrany kanał',
    );
    if (!input.error) await binding(c, ch, input.selling_partner_id!);
    await idle(c, ch.id);
    await c.query('UPDATE amazon_oauth_states SET consumed_at=now() WHERE id=$1', [s.id]);
    if (input.error) {
      await c.query('UPDATE channels SET status=$2,amazon_oauth_attempt=NULL WHERE id=$1', [
        ch.id,
        v.previous_status,
      ]);
      await audit(c, actor, 'amazon.oauth.cancel', ch.id, {});
    }
    return { s, v, ch };
  });
  if (input.error) return { status: 'denied', channel_id: pending.ch.id };
  const { s, v, ch } = pending;
  const fence = () =>
    oauthTx(actor, session, async (c) => {
      const current = await channel(c, ch.id);
      ensure(
        current.amazon_oauth_attempt === s.id && oauthHash(current) === v.connection_hash,
        409,
        'Połączenie OAuth zostało zastąpione lub zmienione',
      );
      await binding(c, current, input.selling_partner_id!);
      await idle(c, ch.id);
    });
  try {
    let credentials = credentialsOf(ch);
    if (!ch.settings.simulation) {
      await fence();
      const transport = amazonApiTransport(
        ch.mode,
        ch.settings.region,
        credentials.client_id,
        async (u, i) => {
          await fence();
          try {
            return await (ctx.transport ?? safeFetch)(u, i);
          } catch (e) {
            if (e instanceof Problem) throw e;
            throw new Problem(502, 'Niepewny wynik OAuth Amazon; rozpocznij nową zgodę');
          }
        },
      );
      // Authorization codes are single-use: no replay on 401, 429 or an unknown network result.
      const r = await transport('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        signal: AbortSignal.timeout(12000),
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.spapi_oauth_code!,
          redirect_uri: v.redirect,
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
        }).toString(),
      });
      ensure(
        r.ok,
        r.status === 400 || r.status === 401 ? 401 : 502,
        `OAuth Amazon: HTTP ${r.status}; rozpocznij nową zgodę`,
      );
      const p = z
        .object({
          access_token: secret,
          refresh_token: secret,
          token_type: z
            .string()
            .transform((v) => v.toLowerCase())
            .pipe(z.literal('bearer')),
          expires_in: z.number().int().min(61).max(86400),
        })
        .safeParse(await r.json().catch(() => null));
      ensure(p.success, 502, 'Nieprawidłowa odpowiedź OAuth Amazon; rozpocznij nową zgodę');
      credentials = { ...credentials, refresh_token: p.data.refresh_token };
    } else
      ensure(
        input.spapi_oauth_code === 'DEMO-CODE076',
        422,
        'Przykład lokalny wymaga kodu demonstracyjnego',
      );
    await oauthTx(actor, session, async (c) => {
      const current = await channel(c, ch.id);
      ensure(
        current.amazon_oauth_attempt === s.id && oauthHash(current) === v.connection_hash,
        409,
        'Połączenie zmieniło się podczas wymiany kodu',
      );
      await idle(c, ch.id);
      const prior = await binding(c, current, input.selling_partner_id!);
      const encrypted = ch.settings.simulation ? ch.credentials : encrypt(credentials);
      await c.query(
        "UPDATE channels SET credentials=$2,settings=jsonb_set(settings,'{selling_partner_id}',to_jsonb($3::text)),status=$4,amazon_oauth_attempt=NULL WHERE id=$1",
        [
          ch.id,
          encrypted,
          input.selling_partner_id,
          ch.settings.simulation ? 'simulation' : 'authorized_read',
        ],
      );
      await c.query(
        'INSERT INTO amazon_account_bindings(tenant_id,channel_id,seller_hash,grant_hash,mode,region,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,channel_id) DO UPDATE SET grant_hash=excluded.grant_hash,actor_id=excluded.actor_id,authorized_at=now()',
        [
          actor.tenantId,
          ch.id,
          amazonSellerHash(ch, input.selling_partner_id),
          tokenHash(encrypted),
          ch.mode,
          ch.settings.region,
          ch.settings.simulation ? 'simulation' : 'oauth_callback',
          actor.userId,
        ],
      );
      await audit(c, actor, 'amazon.oauth.connected', ch.id, {
        source: ch.settings.simulation ? 'simulation' : 'oauth_callback',
        api_identity_verified: false,
        reconnected: !!prior,
      });
    });
    return {
      status: 'connected',
      channel_id: ch.id,
      scope: ch.settings.simulation ? 'local_simulation' : 'oauth_callback',
      api_identity_verified: false,
    };
  } catch (e) {
    await oauthTx(actor, session, async (c) => {
      const current = await channel(c, ch.id);
      if (current.amazon_oauth_attempt === s.id && oauthHash(current) === v.connection_hash) {
        await c.query('UPDATE channels SET status=$2,amazon_oauth_attempt=NULL WHERE id=$1', [
          ch.id,
          v.previous_status,
        ]);
        await audit(c, actor, 'amazon.oauth.failed', ch.id, {
          reason: e instanceof Problem ? e.status : 502,
        });
      }
    }).catch(() => {});
    throw e;
  }
}
export async function finishAmazonReturn(
  actor: Actor,
  session: string,
  value: string,
  ctx: IntegrationContext = {},
) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Problem(422, 'Wklej pełny adres powrotu Amazon');
  }
  ensure(!u.username && !u.password && !u.hash, 422, 'Nieprawidłowy adres powrotu Amazon');
  const params: Record<string, string> = {};
  for (const [k, val] of u.searchParams) {
    ensure(!(k in params), 422, 'Powtórzony parametr powrotu Amazon');
    params[k] = val;
  }
  u.search = '';
  return finishAmazonOAuth(
    actor,
    session,
    amazonOAuthFinish.parse(params),
    ctx,
    amazonRedirect(u.toString()),
  );
}
export async function continueAmazonLogin(
  actor: Actor,
  session: string,
  input: z.infer<typeof amazonLoginInput>,
) {
  return oauthTx(actor, session, async (c) => {
    const pending = (
      await c.query(
        'SELECT * FROM amazon_oauth_states WHERE user_id=$1 AND session_hash=$2 AND consumed_at IS NULL AND expires_at>now() ORDER BY created_at DESC',
        [actor.userId, session],
      )
    ).rows;
    ensure(pending.length === 1, 409, 'Rozpocznij jedną próbę OAuth w panelu wybranego kanału');
    const s = pending[0],
      v = verifierOf(s.verifier),
      ch = await channel(c, s.channel_id);
    ensure(
      !ch.settings.simulation &&
        ch.amazon_oauth_attempt === s.id &&
        oauthHash(ch) === v.connection_hash &&
        input.selling_partner_id === v.expected_seller,
      409,
      'Powrót logowania nie pasuje do kanału',
    );
    const u = new URL(input.amazon_callback_uri);
    ensure(
      [
        'https://amazon.com',
        'https://www.amazon.com',
        amazonSellerCentral(ch.settings.marketplace_id),
      ].includes(u.origin) &&
        u.pathname === '/apps/authorize/confirm/' + v.application_id &&
        !u.username &&
        !u.password &&
        !u.hash &&
        !u.search,
      422,
      'Nieprawidłowy adres kontynuacji Amazon',
    );
    ensure((input.version === 'beta') === v.beta, 409, 'Wersja aplikacji Amazon zmieniła się');
    const state = randomBytes(32).toString('hex');
    await c.query('UPDATE amazon_oauth_states SET state_hash=$2 WHERE id=$1', [
      s.id,
      tokenHash(state),
    ]);
    u.searchParams.set('state', state);
    u.searchParams.set('amazon_state', input.amazon_state);
    u.searchParams.set('redirect_uri', v.redirect);
    if (v.beta) u.searchParams.set('version', 'beta');
    await audit(c, actor, 'amazon.oauth.login.continue', ch.id, {});
    return { url: u.toString() };
  });
}
