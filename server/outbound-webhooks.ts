import { randomUUID, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { localConfig, pool, tenantTx } from './db';
import { decrypt } from './security';
import { ensure, Problem } from './errors';
import { publicAddresses, validateRemoteUrl, type Transport } from './integrations';
import type { IntegrationContext } from './channel-access';

export const webhookTypes = [
  'order.created',
  'order.status_changed',
  'order.updated',
  'item.scanned',
] as const;
class DeliveryFailure extends Problem {
  constructor(
    message: string,
    public retryAfter = 0,
  ) {
    super(502, message);
  }
}
const stages = new Set([
  'new',
  'paid',
  'picking',
  'packed',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'return_initiated',
  'return_received',
  'return_completed',
]);
export async function enqueueOutgoing(
  c: PoolClient,
  tenantId: string,
  kind: string,
  snapshot: any,
) {
  if (!snapshot) return;
  const type =
    kind === 'order.created'
      ? kind
      : kind === 'item.scanned'
        ? kind
        : kind.startsWith('order.') && stages.has(kind.slice(6))
          ? 'order.status_changed'
          : 'order.updated';
  const subscribers = (
    await c.query(
      'SELECT id,actor_id FROM outbound_subscriptions WHERE tenant_id=$1 AND enabled AND revoked_at IS NULL AND approved_at IS NOT NULL AND $2=ANY(events) ORDER BY id',
      [tenantId, type],
    )
  ).rows;
  if (!subscribers.length) return;
  // A cash-on-delivery order is created in paid ("Nowe", ready to fulfil) but nobody has paid it: subscribers keep
  // seeing new for it, as before paid meant "Nowe" (docs/order-status-codes.md).
  const cod =
    snapshot.status === 'paid' &&
    (await c.query('SELECT payment_mode FROM orders WHERE id=$1', [snapshot.id])).rows[0]?.payment_mode === 'cod';
  const id = randomUUID();
  const payload = {
    id,
    type,
    organization_id: tenantId,
    occurred_at: new Date().toISOString(),
    order: {
      id: snapshot.id,
      version: snapshot.version,
      status: cod ? 'new' : snapshot.status,
      total: snapshot.total,
      currency: snapshot.currency,
      warehouse_id: snapshot.warehouse_id,
      workflow_status_id: snapshot.workflow_status_id,
    },
  };
  const body = JSON.stringify(payload);
  await c.query(
    'INSERT INTO outbound_events(id,tenant_id,event_type,payload,body) VALUES($1,$2,$3,$4,$5)',
    [id, tenantId, type, body, body],
  );
  for (const sub of subscribers) {
    const delivery = randomUUID(),
      job = randomUUID();
    await c.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,'outbound.webhook',$3,$4,8)",
      [
        job,
        tenantId,
        JSON.stringify({ delivery_id: delivery, actor_id: sub.actor_id }),
        'outbound:' + delivery,
      ],
    );
    await c.query(
      'INSERT INTO outbound_deliveries(id,tenant_id,event_id,subscription_id,job_id) VALUES($1,$2,$3,$4,$5)',
      [delivery, tenantId, id, sub.id, job],
    );
  }
}
export function signWebhook(secret: string, body: string | Buffer, timestamp: number) {
  return (
    'v1=' +
    createHmac('sha256', secret)
      .update(String(timestamp) + '.')
      .update(body)
      .digest('hex')
  );
}
export function verifyWebhook(
  secret: string,
  body: Buffer,
  timestamp: string,
  signature: string,
  now = Date.now(),
) {
  ensure(
    /^\d{10}$/.test(timestamp) &&
      Math.abs(now / 1000 - Number(timestamp)) <= 300 &&
      /^v1=[a-f0-9]{64}$/.test(signature),
    401,
    'Nieprawidłowy lub wygasły podpis webhooka',
  );
  const actual = Buffer.from(signature.slice(3), 'hex'),
    expected = Buffer.from(signWebhook(secret, body, Number(timestamp)).slice(3), 'hex');
  ensure(
    actual.length === expected.length && timingSafeEqual(actual, expected),
    401,
    'Nieprawidłowy podpis webhooka',
  );
}
// Pin a validated public IP for the request: DNS cannot rebind between validation and HTTPS.
export function createWebhookTransport(
  deps: {
    validate?: typeof validateRemoteUrl;
    addresses?: typeof publicAddresses;
    request?: typeof httpsRequest;
  } = {},
): Transport {
  return async (url, init) => {
    await (deps.validate ?? validateRemoteUrl)(url);
    const u = new URL(url),
      addresses = await (deps.addresses ?? publicAddresses)(u.hostname),
      address = addresses[0];
    return new Promise<Response>((resolve, reject) => {
      const r = (deps.request ?? httpsRequest)(
        u,
        {
          method: 'POST',
          headers: init.headers as Record<string, string>,
          servername: u.hostname,
          signal: AbortSignal.timeout(10000),
          lookup: (_host: any, options: any, cb: any) =>
            options?.all ? cb(null, [address]) : cb(null, address.address, address.family),
        },
        (res) => {
          const status = res.statusCode ?? 502;
          const retryAfter = res.headers['retry-after'];
          res.destroy();
          resolve(
            new Response(null, {
              status,
              headers: typeof retryAfter === 'string' ? { 'Retry-After': retryAfter } : {},
            }),
          );
        },
      );
      r.on('error', () => reject(new Problem(502, 'Brak odpowiedzi odbiorcy webhooka')));
      r.end(String(init.body ?? ''));
    });
  };
}
export const webhookFetch = createWebhookTransport();
export async function receiveLocalWebhook(
  id: string,
  body: Buffer,
  headers: Record<string, unknown>,
) {
  ensure(Buffer.isBuffer(body), 415, 'Webhook wymaga treści application/json');
  ensure(body.length <= 65536, 413, 'Webhook przekracza 64 KiB');
  const sub = (
    await pool.query(
      "SELECT s.* FROM outbound_subscriptions s JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.actor_id WHERE s.id=$1 AND s.mode='local' AND s.enabled AND s.revoked_at IS NULL AND m.role='admin'",
      [id],
    )
  ).rows[0];
  ensure(sub, 401, 'Nieprawidłowy odbiorca webhooka');
  verifyWebhook(
    decrypt(sub.secret).secret,
    body,
    String(headers['x-dyna-timestamp'] ?? ''),
    String(headers['x-dyna-signature'] ?? ''),
  );
  const deliveryId = z.uuid().parse(headers['x-dyna-delivery-id']),
    eventId = z.uuid().parse(headers['x-dyna-event-id']);
  return tenantTx(sub.tenant_id, async (c) => {
    const d = (
      await c.query(
        'SELECT d.event_id,e.body,e.payload FROM outbound_deliveries d JOIN outbound_events e ON (e.tenant_id,e.id)=(d.tenant_id,d.event_id) WHERE d.id=$1 AND d.subscription_id=$2',
        [deliveryId, id],
      )
    ).rows[0];
    ensure(
      d && d.event_id === eventId && d.body === body.toString('utf8'),
      409,
      'Treść nie odpowiada identyfikatorowi dostawy',
    );
    const hash = createHash('sha256').update(body).digest('hex');
    const inserted = await c.query(
      'INSERT INTO local_webhook_inbox(tenant_id,delivery_id,payload,body_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING delivery_id',
      [sub.tenant_id, deliveryId, d.payload, hash],
    );
    const previous = (
      await c.query('SELECT body_hash FROM local_webhook_inbox WHERE delivery_id=$1', [deliveryId])
    ).rows[0];
    ensure(previous.body_hash === hash, 409, 'Dostawa otrzymana wcześniej z inną treścią');
    return { accepted: true, duplicate: !inserted.rowCount };
  });
}
async function fence(c: PoolClient, job: any) {
  return Boolean(
    (
      await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rowCount,
  );
}
export async function processOutbound(job: any, ctx: IntegrationContext = {}) {
  if (job.payload?.rule_webhook) return processRuleWebhook(job, ctx);
  const data = await tenantTx(job.tenant_id, async (c) => {
    if (!(await fence(c, job))) return null;
    const d = (
      await c.query(
        'SELECT d.*,s.enabled,s.approved_at,s.revoked_at,s.mode,s.url,s.secret,s.actor_id,e.body FROM outbound_deliveries d JOIN outbound_subscriptions s ON (s.tenant_id,s.id)=(d.tenant_id,d.subscription_id) JOIN outbound_events e ON (e.tenant_id,e.id)=(d.tenant_id,d.event_id) WHERE d.id=$1',
        [job.payload.delivery_id],
      )
    ).rows[0];
    ensure(d, 404, 'Nie znaleziono dostawy webhooka');
    if (d.state === 'delivered') {
      await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
        job.id,
      ]);
      return null;
    }
    if (!d.enabled || d.revoked_at || !d.approved_at) {
      await c.query(
        "UPDATE outbound_deliveries SET state='cancelled',error='Webhook wyłączony' WHERE id=$1",
        [d.id],
      );
      await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
        job.id,
      ]);
      return null;
    }
    return d;
  });
  if (!data) return;
  const member = (
    await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
      job.tenant_id,
      data.actor_id,
    ])
  ).rows[0];
  ensure(member?.role === 'admin', 403, 'Administrator webhooka utracił uprawnienia');
  const timestamp = Math.floor(Date.now() / 1000),
    secret = decrypt(data.secret).secret;
  const headers = {
    'Content-Type': 'application/json',
    'X-Dyna-Event-ID': data.event_id,
    'X-Dyna-Delivery-ID': data.id,
    'X-Dyna-Timestamp': String(timestamp),
    'X-Dyna-Signature': signWebhook(secret, data.body, timestamp),
  };
  const url =
    data.mode === 'local'
      ? `http://127.0.0.1:${Number(process.env.PORT ?? 4100)}/api/local-webhooks/${data.subscription_id}`
      : data.url;
  const transport =
    ctx.transport ??
    (data.mode === 'local'
      ? (url, init) =>
          fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) })
      : webhookFetch);
  let response: Response;
  try {
    response = await transport(url, { method: 'POST', headers, body: data.body });
  } catch (e) {
    throw e instanceof Problem ? e : new Problem(502, 'Brak odpowiedzi odbiorcy webhooka');
  }
  await response.body?.cancel().catch(() => {});
  if (!response.ok) {
    await tenantTx(job.tenant_id, async (c) => {
      if (await fence(c, job))
        await c.query('UPDATE outbound_deliveries SET response_status=$2 WHERE id=$1', [
          data.id,
          response.status,
        ]);
    });
    const message = `Odbiorca webhooka: HTTP ${response.status}`;
    if (response.status === 429 || response.status >= 500) {
      const header = response.headers.get('retry-after') ?? '';
      const seconds = /^\d+$/.test(header)
        ? Number(header)
        : Math.ceil((Date.parse(header) - Date.now()) / 1000);
      throw new DeliveryFailure(
        message,
        Number.isFinite(seconds) ? Math.max(0, Math.min(86400, seconds)) : 0,
      );
    }
    throw new Problem(422, message);
  }
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fence(c, job))) return;
    await c.query(
      "UPDATE outbound_deliveries SET state='delivered',response_status=$2,error=NULL,delivered_at=now() WHERE id=$1",
      [data.id, response.status],
    );
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
      [job.id],
    );
  });
}
export async function failOutbound(job: any, error: unknown) {
  if (job.payload?.rule_webhook) return failRuleWebhook(job, error);
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fence(c, job))) return;
    const retry = !(error instanceof Problem) || error.status === 502;
    const state = retry && job.attempts < job.max_attempts ? 'pending' : 'failed';
    const message = error instanceof Problem ? error.message : 'Błąd dostawy webhooka';
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>greatest($4,least(3600,30*power(2,attempts-1)::int))) WHERE id=$1',
      [job.id, state, message, error instanceof DeliveryFailure ? error.retryAfter : 0],
    );
    await c.query('UPDATE outbound_deliveries SET state=$2,error=$3 WHERE id=$1', [
      job.payload.delivery_id,
      state === 'failed' ? 'failed' : 'queued',
      message,
    ]);
  });
}

/* Automation rules v2, effect "webhook" with a URL typed in the rule (server/automation-v2-effects-comm.ts).
 * The effect only queues an 'outbound.webhook' job with payload.rule_webhook inside the rule's savepoint, so a
 * rolled-back rule sends nothing and no HTTP call holds the tenant transaction. Delivery is at-least-once with a
 * stable X-Dyna-Delivery-ID; it is signed like the subscriptions (signWebhook: X-Dyna-Signature v1=HMAC-SHA256 of
 * "<X-Dyna-Timestamp>.<body>", so a receiver can refuse replays) with a per-rule secret derived from the installation
 * key (nothing stored, no migration). The result (HTTP code or a Polish error) lands in the order history as
 * 'automation.webhook'. */
export type RuleWebhookJob = {
  url: string;
  body: string;
  event_id: string;
  delivery_id: string;
  rule_id: string;
  rule_name: string;
  order_id: string;
};
export function ruleWebhookSecret(tenantId: string, ruleId: string): string {
  return createHmac('sha256', localConfig.encryptionKey).update(`automation-v2-webhook:${tenantId}:${ruleId}`).digest('hex');
}
/** Canonical form of a rule webhook URL (lower-case host, no default port, at least "/"). A URL with credentials,
 * query or fragment is returned unchanged so the rule's validation still refuses it. */
export function normalizeWebhookUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return u.username || u.password || u.search || u.hash ? raw : u.origin + u.pathname;
  } catch {
    return raw;
  }
}
const destinationHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return 'nieprawidłowy adres';
  }
};
async function ruleWebhookResult(c: PoolClient, tenantId: string, p: RuleWebhookJob, detail: Record<string, unknown>) {
  await c.query('INSERT INTO order_events(id,tenant_id,order_id,kind,detail) VALUES($1,$2,$3,$4,$5)', [
    randomUUID(),
    tenantId,
    p.order_id,
    'automation.webhook',
    JSON.stringify({ rule_id: p.rule_id, rule_name: p.rule_name, delivery_id: p.delivery_id, host: destinationHost(p.url), ...detail }),
  ]);
}
export async function processRuleWebhook(job: any, ctx: IntegrationContext = {}): Promise<void> {
  const p = job.payload.rule_webhook as RuleWebhookJob;
  const author = await tenantTx(job.tenant_id, async (c) => {
    if (!(await fence(c, job))) return null;
    // The rule must still be enabled and still send to this URL; otherwise the delivery is cancelled.
    const rule = (await c.query('SELECT enabled,actor_id,config FROM automation_rules WHERE id=$1', [p.rule_id])).rows[0];
    const still =
      rule?.enabled &&
      !rule.config?.deleted &&
      (rule.config?.effects ?? []).some(
        (e: any) => e?.type === 'webhook' && typeof e.params?.url === 'string' && normalizeWebhookUrl(e.params.url) === normalizeWebhookUrl(p.url),
      );
    if (!still) {
      const message = 'Webhook anulowany: reguła wyłączona albo zmieniono jej adres';
      await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=$2 WHERE id=$1", [job.id, message]);
      await ruleWebhookResult(c, job.tenant_id, p, { ok: false, message });
      return null;
    }
    return String(rule.actor_id);
  });
  if (!author) return;
  const member = (await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [job.tenant_id, author])).rows[0];
  ensure(member?.role === 'admin', 403, 'Autor reguły z webhookiem utracił rolę administratora');
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    'Content-Type': 'application/json',
    'X-Dyna-Event-ID': p.event_id,
    'X-Dyna-Delivery-ID': p.delivery_id,
    'X-Dyna-Timestamp': String(timestamp),
    'X-Dyna-Signature': signWebhook(ruleWebhookSecret(job.tenant_id, p.rule_id), p.body, timestamp),
  };
  let response: Response;
  try {
    // webhookFetch: public HTTPS only, DNS checked and the validated IP pinned for the request, 10 s, no redirects.
    response = await (ctx.transport ?? webhookFetch)(p.url, { method: 'POST', headers, body: p.body });
  } catch (e) {
    throw e instanceof Problem ? e : new Problem(502, 'Brak odpowiedzi odbiorcy webhooka');
  }
  await response.body?.cancel().catch(() => {});
  if (!response.ok) {
    const message = `Odbiorca webhooka odpowiedział HTTP ${response.status}`;
    if (response.status === 429 || response.status >= 500) throw new DeliveryFailure(message);
    throw new Problem(422, message);
  }
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fence(c, job))) return;
    await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1", [job.id]);
    await ruleWebhookResult(c, job.tenant_id, p, { ok: true, status: response.status, message: `Webhook wysłany: HTTP ${response.status}` });
  });
}
export async function failRuleWebhook(job: any, error: unknown): Promise<void> {
  const p = job.payload.rule_webhook as RuleWebhookJob;
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fence(c, job))) return;
    const retry = !(error instanceof Problem) || error.status === 502;
    const state = retry && job.attempts < job.max_attempts ? 'pending' : 'failed';
    const message = error instanceof Problem ? error.message : 'Błąd wysyłki webhooka';
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(3600,30*power(2,attempts-1)::int)) WHERE id=$1',
      [job.id, state, message],
    );
    if (state === 'failed') await ruleWebhookResult(c, job.tenant_id, p, { ok: false, message: 'Webhook nie wysłany: ' + message });
  });
}
