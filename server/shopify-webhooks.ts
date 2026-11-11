import { createHmac, createHash, timingSafeEqual, randomUUID, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { encrypt, decrypt } from './security';
import { ensure, Problem } from './errors';
import { audit, type Actor } from './domain';
import { SHOPIFY_VERSION, shopifyId, shopifyStore } from './shopify';
import {
  importConnectionHash,
  stageOrders,
  acquireOrderFieldObservationAdmissionInTx,
} from './imports';
import { shopifyOrderReadPolicy, readShopifyOrder } from './shopify-order-read';
import type { IntegrationContext } from './channel-access';
import { demoShopifyOrder } from './shopify-example';
export const shopifyTopics = [
  'orders/create',
  'orders/updated',
  'orders/paid',
  'orders/cancelled',
  'orders/fulfilled',
  'refunds/create',
] as const;
export const shopifyWebhookInput = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    signing_secret: z.string().min(16).max(4096).regex(/^\S+$/).optional(),
  })
  .strict();
const config = async (c: PoolClient, id: string, lock = '') =>
  (await c.query('SELECT * FROM shopify_webhook_configs WHERE channel_id=$1 ' + lock, [id]))
    .rows[0];
const channel = async (c: PoolClient, id: string, tenantId: string) => {
  // OAuth writers lock this key before updating the channel. Take the shared
  // grant lock before channel/config rows, including receivers and controls.
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'shopify-oauth:' + tenantId,
  ]);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [id])).rows[0];
  ensure(ch?.provider === 'shopify', 404, 'Nie znaleziono kanału Shopify');
  return ch;
};
async function admin(c: PoolClient, actor: Actor) {
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
    403,
    'Wymagana bieżąca rola administratora',
  );
}
export const shopifyWebhookDomain = (ch: any) =>
  ch.settings.simulation
    ? 'demo-' + ch.id + '.myshopify.com'
    : new URL(shopifyStore(ch.settings.store_url)).hostname;
export async function configureShopifyWebhooks(
  actor: Actor,
  id: string,
  input: z.infer<typeof shopifyWebhookInput>,
) {
  return tenantTx(actor.tenantId, async (c) => {
    const ch = await channel(c, id, actor.tenantId);
    await admin(c, actor);
    // Serializes the initial INSERT as well as updates and public receivers.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify-webhook-config:' + actor.tenantId + ':' + id,
    ]);
    const old = await config(c, id, 'FOR UPDATE'),
      hash = importConnectionHash(ch);
    ensure(
      (old?.version ?? 0) === input.version,
      409,
      'Konfiguracja webhooków zmieniła się; odśwież panel',
    );
    if (input.enabled) await shopifyOrderReadPolicy(c, actor, ch);
    const secret = ch.settings.simulation
      ? old
        ? decrypt(old.signing_secret).secret
        : randomBytes(32).toString('hex')
      : input.signing_secret ||
        decrypt(ch.credentials).client_secret ||
        (old?.connection_hash === hash ? decrypt(old.signing_secret).secret : '');
    ensure(
      typeof secret === 'string' &&
        secret.length >= 16 &&
        secret.length <= 4096 &&
        !/\s/.test(secret),
      422,
      'Dodaj prawidłowy sekret aplikacji podpisującej webhooki Shopify',
    );
    ensure(
      !ch.settings.simulation || !input.signing_secret,
      422,
      'Przykład używa własnego losowego sekretu',
    );
    const saved = (
      await c.query(
        `INSERT INTO shopify_webhook_configs(tenant_id,channel_id,actor_id,enabled,connection_hash,signing_secret)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(channel_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,
      connection_hash=excluded.connection_hash,signing_secret=excluded.signing_secret,version=shopify_webhook_configs.version+1,updated_at=now() RETURNING version,enabled`,
        [actor.tenantId, id, actor.userId, input.enabled, hash, encrypt({ secret })],
      )
    ).rows[0];
    await audit(c, actor, 'shopify.webhooks.configure', id, {
      version: saved.version,
      enabled: saved.enabled,
      simulation: !!ch.settings.simulation,
    });
    return saved;
  });
}
export function verifyShopifyWebhook(body: Buffer, signature: unknown, secret: string) {
  ensure(
    typeof signature === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(signature),
    401,
    'Nieprawidłowy podpis webhooka Shopify',
  );
  const expected = createHmac('sha256', secret).update(body).digest(),
    actual = Buffer.from(signature, 'base64');
  ensure(
    actual.length === expected.length && timingSafeEqual(actual, expected),
    401,
    'Nieprawidłowy podpis webhooka Shopify',
  );
}
export function shopifyWebhookOrder(body: Buffer, topic: string) {
  let payload: any;
  try {
    // Node's reviver context retains the original integer lexeme. Shopify's public
    // examples exceed JS's safe range, including refunds with only numeric order_id.
    payload = JSON.parse(body.toString('utf8'), ((_: string, v: any, context: any) =>
      typeof v === 'number' && !Number.isSafeInteger(v) && /^\d{1,20}$/.test(context?.source ?? '')
        ? context.source
        : v) as any);
  } catch {
    throw new Problem(400, 'Nieprawidłowy JSON webhooka Shopify');
  }
  ensure(
    payload && typeof payload === 'object' && !Array.isArray(payload),
    422,
    'Brak obiektu powiadomienia Shopify',
  );
  const numeric = (value: any): string => {
    ensure(
      (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) ||
        (typeof value === 'number' && Number.isSafeInteger(value) && value > 0),
      422,
      'Nieprawidłowe ID zamówienia Shopify',
    );
    return String(value);
  };
  if (topic === 'refunds/create')
    return shopifyId('gid://shopify/Order/' + numeric(payload.order_id), 'Order');
  const gid = payload.admin_graphql_api_id
    ? shopifyId(payload.admin_graphql_api_id, 'Order')
    : shopifyId('gid://shopify/Order/' + numeric(payload.id), 'Order');
  if (payload.id !== undefined)
    ensure(
      gid === 'gid://shopify/Order/' + numeric(payload.id),
      422,
      'Sprzeczne identyfikatory zamówienia Shopify',
    );
  return gid;
}
export async function receiveShopifyWebhook(
  id: string,
  body: Buffer,
  headers: Record<string, unknown>,
) {
  ensure(
    Buffer.isBuffer(body) && body.length > 0 && body.length <= 1024 * 1024,
    413,
    'Nieprawidłowy rozmiar webhooka Shopify',
  );
  const row = (
    await pool.query(
      `SELECT ch.*,cfg.signing_secret FROM channels ch JOIN shopify_webhook_configs cfg ON (cfg.tenant_id,cfg.channel_id)=(ch.tenant_id,ch.id) WHERE ch.id=$1 AND ch.provider='shopify'`,
      [id],
    )
  ).rows[0];
  ensure(row, 401, 'Nieprawidłowy podpis webhooka Shopify');
  const secret = decrypt(row.signing_secret).secret;
  verifyShopifyWebhook(body, headers['x-shopify-hmac-sha256'], secret);
  const topic = z.enum(shopifyTopics).parse(headers['x-shopify-topic']),
    delivery = z.uuid().parse(headers['x-shopify-webhook-id']).toLowerCase(),
    event =
      headers['x-shopify-event-id'] === undefined
        ? null
        : z.uuid().parse(headers['x-shopify-event-id']).toLowerCase(),
    version = headers['x-shopify-api-version'],
    domain = headers['x-shopify-shop-domain'];
  ensure(version === SHOPIFY_VERSION, 422, 'Webhook Shopify wymaga wersji API ' + SHOPIFY_VERSION);
  ensure(domain === shopifyWebhookDomain(row), 401, 'Webhook Shopify dotyczy innego sklepu');
  const triggered =
    headers['x-shopify-triggered-at'] === undefined
      ? null
      : z.string().min(1).max(80).parse(headers['x-shopify-triggered-at']);
  const order = shopifyWebhookOrder(body, topic),
    hash = createHash('sha256').update(body).digest('hex');
  return tenantTx(row.tenant_id, async (c) => {
    await c.query("SET LOCAL statement_timeout='2s'");
    await c.query("SET LOCAL lock_timeout='1s'");
    const ch = await channel(c, id, row.tenant_id),
      cfg = await config(c, id, 'FOR UPDATE');
    ensure(
      cfg && decrypt(cfg.signing_secret).secret === secret && shopifyWebhookDomain(ch) === domain,
      401,
      'Konfiguracja podpisu Shopify zmieniła się',
    );
    const old = (
      await c.query(
        'SELECT * FROM shopify_webhook_deliveries WHERE channel_id=$1 AND delivery_id=$2',
        [id, delivery],
      )
    ).rows[0];
    if (old) {
      ensure(
        old.body_hash === hash &&
          old.topic === topic &&
          old.order_gid === order &&
          old.event_id === event,
        409,
        'ID dostawy Shopify zostało użyte z inną treścią',
      );
      return { accepted: true, duplicate: true, delivery_id: old.id, job_id: old.job_id };
    }
    ensure(
      cfg.enabled && cfg.connection_hash === importConnectionHash(ch),
      409,
      'Włącz odbiór webhooków dla aktualnego połączenia Shopify',
    );
    const actor: Actor = { tenantId: ch.tenant_id, userId: cfg.actor_id, role: 'admin' };
    await shopifyOrderReadPolicy(c, actor, ch);
    const pending = (
      await c.query(
        "SELECT count(*)::int n FROM jobs WHERE kind='shopify.webhook' AND payload->>'channel_id'=$1 AND state IN ('pending','running')",
        [id],
      )
    ).rows[0].n;
    ensure(pending < 200, 503, 'Kolejka webhooków Shopify jest pełna; ponów dostawę');
    const job = randomUUID(),
      receipt = randomUUID();
    await c.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'shopify.webhook',$3,$4)",
      [
        job,
        ch.tenant_id,
        JSON.stringify({
          channel_id: id,
          actor_id: cfg.actor_id,
          delivery_id: receipt,
          config_version: cfg.version,
          connection_hash: cfg.connection_hash,
        }),
        `shopify-webhook:${id}:${delivery}`,
      ],
    );
    await c.query(
      `INSERT INTO shopify_webhook_deliveries(id,tenant_id,channel_id,delivery_id,event_id,topic,api_version,shop_domain,order_gid,body_hash,connection_hash,config_version,job_id,triggered_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        receipt,
        ch.tenant_id,
        id,
        delivery,
        event,
        topic,
        version,
        domain,
        order,
        hash,
        cfg.connection_hash,
        cfg.version,
        job,
        triggered,
      ],
    );
    return { accepted: true, duplicate: false, delivery_id: receipt, job_id: job };
  }).catch((error: unknown) => {
    // tenantTx has rolled back the whole admission attempt. Shopify can retry
    // the unchanged delivery after transient lock or statement contention.
    if (['55P03', '57014', '40P01'].includes(String((error as { code?: string })?.code)))
      throw new Problem(503, 'Odbiór webhooka Shopify jest chwilowo zajęty; ponów dostawę');
    throw error;
  });
}
export async function shopifyWebhookHistory(actor: Actor, id: string) {
  return tenantTx(actor.tenantId, async (c) => {
    const ch = await channel(c, id, actor.tenantId);
    await admin(c, actor);
    const cfg = await config(c, id);
    const deliveries = (
      await c.query(
        `SELECT d.id,d.delivery_id,d.event_id,d.topic,d.order_gid,d.outcome,d.result,d.received_at,d.processed_at,
      j.state job_state,j.attempts,j.max_attempts,j.error,j.run_at FROM shopify_webhook_deliveries d JOIN jobs j ON (j.tenant_id,j.id)=(d.tenant_id,d.job_id)
      WHERE d.channel_id=$1 ORDER BY d.received_at DESC,d.id LIMIT 50`,
        [id],
      )
    ).rows;
    return {
      config: cfg
        ? {
            enabled: cfg.enabled,
            version: cfg.version,
            connection_matches: cfg.connection_hash === importConnectionHash(ch),
          }
        : null,
      client_secret_configured: !!decrypt(ch.credentials).client_secret,
      signing_secret_configured: !!cfg,
      simulation: !!ch.settings.simulation,
      receiver_path: '/api/webhooks/shopify/' + id,
      shop_domain: shopifyWebhookDomain(ch),
      api_version: SHOPIFY_VERSION,
      topics: shopifyTopics,
      queue_limit: 200,
      deliveries,
    };
  });
}
async function guard(c: PoolClient, job: any, renew = false) {
  const ch = await channel(c, job.payload.channel_id, job.tenant_id),
    cfg = await config(c, ch.id, 'FOR SHARE');
  const j = (
    await c.query(
      "SELECT * FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
      [job.id, job.lease_token],
    )
  ).rows[0];
  if (!j) return null;
  const receipt = (
    await c.query('SELECT * FROM shopify_webhook_deliveries WHERE id=$1 AND job_id=$2 FOR UPDATE', [
      job.payload.delivery_id,
      job.id,
    ])
  ).rows[0];
  ensure(
    receipt && receipt.channel_id === ch.id && j.kind === 'shopify.webhook',
    422,
    'Nieprawidłowe zadanie webhooka Shopify',
  );
  ensure(
    ['channel_id', 'actor_id', 'delivery_id', 'config_version', 'connection_hash'].every(
      (k) => j.payload[k] === job.payload[k],
    ),
    409,
    'Zmieniono zadanie webhooka Shopify',
  );
  const actor: Actor = { tenantId: job.tenant_id, userId: job.payload.actor_id, role: 'admin' };
  try {
    ensure(
      cfg?.enabled &&
        cfg.version === job.payload.config_version &&
        cfg.actor_id === actor.userId &&
        cfg.connection_hash === job.payload.connection_hash &&
        receipt.connection_hash === cfg.connection_hash,
      409,
      'Zmieniono konfigurację webhooków Shopify',
    );
    await shopifyOrderReadPolicy(c, actor, ch);
    ensure(importConnectionHash(ch) === cfg.connection_hash, 409, 'Zmieniono połączenie Shopify');
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    await c.query(
      "UPDATE jobs SET state='done',error=$2,lease_token=NULL,locked_at=NULL WHERE id=$1",
      [job.id, 'Zatrzymano webhook Shopify: ' + e.message],
    );
    await c.query(
      "UPDATE shopify_webhook_deliveries SET outcome='stopped',processed_at=now(),result=$2 WHERE id=$1",
      [receipt.id, JSON.stringify({ reason: e.message })],
    );
    return null;
  }
  if (renew) await c.query('UPDATE jobs SET locked_at=now() WHERE id=$1', [job.id]);
  return { ch, cfg, receipt, actor };
}
export async function processShopifyWebhook(job: any, ctx: IntegrationContext = {}) {
  const initial = await tenantTx(job.tenant_id, (c) => guard(c, job, true));
  if (!initial) return;
  const fence = async () =>
    ensure(
      await tenantTx(job.tenant_id, (c) => guard(c, job, true)),
      409,
      'Zatrzymano odczyt webhooka Shopify',
    );
  const raw = initial.ch.settings.simulation
    ? await tenantTx(job.tenant_id, async (c) => {
        ensure(await guard(c, job), 409, 'Zatrzymano lokalny webhook Shopify');
        const sample = (
          await c.query(
            'SELECT raw FROM shopify_webhook_simulations WHERE channel_id=$1 AND order_gid=$2',
            [initial.ch.id, initial.receipt.order_gid],
          )
        ).rows[0];
        ensure(sample, 404, 'Brak kanonicznego zamówienia w symulatorze Shopify');
        return sample.raw;
      })
    : await readShopifyOrder(initial.actor, initial.ch, initial.receipt.order_gid, ctx, fence);
  await tenantTx(job.tenant_id, async (c) => {
    // Admission precedes channel/config rows. guard then preserves the shared
    // config -> job lock order used by retry and rechecks the exact live lease.
    await acquireOrderFieldObservationAdmissionInTx(c, { tenantId: job.tenant_id }, 'shopify');
    const current = await guard(c, job);
    if (!current) return;
    ensure(raw.id === current.receipt.order_gid, 502, 'Symulator lub API zwrócił inne zamówienie');
    const staged = (await stageOrders(c, current.actor, current.ch, [raw]))[0];
    await c.query(
      "UPDATE shopify_webhook_deliveries SET outcome='processed',processed_at=now(),result=$2 WHERE id=$1",
      [
        current.receipt.id,
        JSON.stringify({
          inbound_id: staged.id,
          observation: staged.observation ?? 'updated',
          source_hash: staged.source_hash,
          scope: current.ch.settings.simulation ? 'local_simulation' : 'graphql_read',
        }),
      ],
    );
    await c.query(
      "UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL WHERE id=$1",
      [job.id],
    );
    await audit(c, current.actor, 'shopify.webhook.processed', current.receipt.id, {
      inbound_id: staged.id,
      topic: current.receipt.topic,
      observation: staged.observation ?? 'updated',
    });
  });
}
export async function failShopifyWebhook(job: any, error: unknown) {
  const message = error instanceof Problem ? error.message : 'Błąd odczytu zamówienia Shopify';
  await tenantTx(job.tenant_id, async (c) => {
    const j = (
      await c.query(
        `UPDATE jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,error=$3,
      lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING state`,
        [job.id, job.lease_token, message],
      )
    ).rows[0];
    if (j)
      await c.query(
        "UPDATE shopify_webhook_deliveries SET outcome=$2,result=$3,processed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE job_id=$1",
        [job.id, j.state === 'failed' ? 'failed' : 'queued', JSON.stringify({ reason: message })],
      );
  });
}
export async function retryShopifyWebhook(actor: Actor, id: string) {
  return tenantTx(actor.tenantId, async (c) => {
    const initial = (
      await c.query(
        'SELECT channel_id,job_id,connection_hash FROM shopify_webhook_deliveries WHERE id=$1',
        [id],
      )
    ).rows[0];
    ensure(initial, 404, 'Nie znaleziono dostawy Shopify');
    const ch = await channel(c, initial.channel_id, actor.tenantId),
      cfg = await config(c, ch.id, 'FOR UPDATE');
    await admin(c, actor);
    await shopifyOrderReadPolicy(c, actor, ch);
    ensure(
      cfg?.enabled &&
        cfg.connection_hash === initial.connection_hash &&
        cfg.connection_hash === importConnectionHash(ch),
      409,
      'Ponowienie wymaga tego samego połączenia i włączonego odbioru Shopify',
    );
    const j = (await c.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [initial.job_id]))
        .rows[0],
      receipt = (
        await c.query('SELECT * FROM shopify_webhook_deliveries WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
    ensure(
      j && ['failed', 'done'].includes(j.state) && ['failed', 'stopped'].includes(receipt.outcome),
      409,
      'Dostawa nie wymaga ponowienia',
    );
    ensure(
      (
        await c.query(
          "SELECT count(*)::int n FROM jobs WHERE kind='shopify.webhook' AND payload->>'channel_id'=$1 AND state IN ('pending','running')",
          [ch.id],
        )
      ).rows[0].n < 200,
      503,
      'Kolejka webhooków Shopify jest pełna',
    );
    await shopifyOrderReadPolicy(c, { ...actor, userId: cfg.actor_id }, ch);
    await c.query(
      "UPDATE jobs SET state='pending',attempts=0,error=NULL,run_at=now(),lease_token=NULL,locked_at=NULL,payload=$2 WHERE id=$1",
      [
        j.id,
        JSON.stringify({
          ...j.payload,
          config_version: cfg.version,
          actor_id: cfg.actor_id,
          connection_hash: cfg.connection_hash,
        }),
      ],
    );
    await c.query(
      "UPDATE shopify_webhook_deliveries SET outcome='queued',processed_at=NULL,result='{}' WHERE id=$1",
      [id],
    );
    await audit(c, actor, 'shopify.webhook.retry', id);
    return { queued: true };
  });
}
export async function exampleShopifyWebhook(
  actor: Actor,
  id: string,
  kind: 'created' | 'updated' | 'cancelled',
) {
  const delivery = await tenantTx(actor.tenantId, async (c) => {
    const ch = await channel(c, id, actor.tenantId),
      cfg = await config(c, id, 'FOR UPDATE');
    await admin(c, actor);
    await shopifyOrderReadPolicy(c, actor, ch);
    ensure(
      ch.settings.simulation && cfg?.enabled && cfg.connection_hash === importConnectionHash(ch),
      422,
      'Włącz odbiór dla lokalnego przykładu Shopify',
    );
    const old = (
      await c.query(
        'SELECT * FROM shopify_webhook_simulations WHERE channel_id=$1 AND order_gid=$2 FOR UPDATE',
        [id, demoShopifyOrder.id],
      )
    ).rows[0];
    const raw = structuredClone(old?.raw ?? demoShopifyOrder),
      version = (old?.version ?? 0) + 1;
    if (kind !== 'created' || !old) {
      raw.updatedAt = new Date(
        Math.max(Date.now(), Date.parse(raw.updatedAt) + 1000),
      ).toISOString();
      raw.note = 'Lokalne zdarzenie Shopify ' + version;
    }
    if (kind === 'cancelled') raw.cancelledAt = raw.updatedAt;
    await c.query(
      `INSERT INTO shopify_webhook_simulations(tenant_id,channel_id,order_gid,raw,version) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(tenant_id,channel_id,order_gid) DO UPDATE SET raw=excluded.raw,version=excluded.version,updated_at=now()`,
      [actor.tenantId, id, raw.id, JSON.stringify(raw), version],
    );
    const body = Buffer.from(
        JSON.stringify({ id: raw.id.split('/').at(-1), admin_graphql_api_id: raw.id }),
      ),
      headers = {
        'x-shopify-topic':
          kind === 'created'
            ? 'orders/create'
            : kind === 'cancelled'
              ? 'orders/cancelled'
              : 'orders/updated',
        'x-shopify-api-version': SHOPIFY_VERSION,
        'x-shopify-shop-domain': shopifyWebhookDomain(ch),
        'x-shopify-webhook-id': randomUUID(),
        'x-shopify-event-id': randomUUID(),
        'x-shopify-hmac-sha256': createHmac('sha256', decrypt(cfg.signing_secret).secret)
          .update(body)
          .digest('base64'),
      };
    await audit(c, actor, 'shopify.webhook.example', id, { kind, scope: 'local_simulation' });
    return { body, headers };
  });
  return {
    ...(await receiveShopifyWebhook(id, delivery.body, delivery.headers)),
    scope: 'local_simulation',
  };
}
