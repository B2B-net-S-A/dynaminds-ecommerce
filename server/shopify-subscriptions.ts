import { validateRemoteUrl } from './integrations';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit, type Actor } from './domain';
import { importConnectionHash } from './imports';
import { channelRead, loadChannel, type IntegrationContext } from './channel-access';
import { shopifyOrderReadPolicy } from './shopify-order-read';
import { shopifyFulfillmentHash as hash } from './shopify-fulfillment';
import { Shopify, SHOPIFY_VERSION } from './shopify';
import {
  parseShopifySubscription,
  shopifySubscriptionTopics,
  subscriptionFieldsFor,
  subscriptionId,
  type ShopifySubscription,
} from './shopify-subscription-api';
export const shopifySubscriptionInput = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('create'),
      topic: z.enum(shopifySubscriptionTopics),
      uri: z.string().url().max(2048),
    })
    .strict(),
  z.object({ operation: z.literal('delete'), remote_id: subscriptionId }).strict(),
]);
const plan = async (c: PoolClient, id: string, lock = '') =>
  (await c.query('SELECT * FROM shopify_subscription_plans WHERE id=$1 ' + lock, [id])).rows[0];
const cfg = async (c: PoolClient, id: string) =>
  (await c.query('SELECT * FROM shopify_webhook_configs WHERE channel_id=$1 FOR SHARE', [id]))
    .rows[0];
export function subscriptionReceiverUri(value: string, ch: any) {
  const u = new URL(value);
  ensure(
    u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      !u.port &&
      u.pathname === `/api/webhooks/shopify/${ch.id}`,
    422,
    'Wymagany adres HTTPS ze ścieżką odbiornika tego kanału',
  );
  ensure(
    !isIP(u.hostname) &&
      u.hostname.includes('.') &&
      !u.hostname.endsWith('.local') &&
      u.hostname !== 'localhost',
    422,
    'Wymagana publiczna domena HTTPS odbiornika',
  );
  ensure(
    ch.settings.simulation ||
      !['.invalid', '.test', '.localhost'].some((s) => u.hostname.endsWith(s)),
    422,
    'Przykładowa domena nie jest rzeczywistym odbiornikiem Shopify',
  );
  return u.toString();
}
async function access(actor: Actor, id: string) {
  const ch = await loadChannel(actor.tenantId, id);
  await tenantTx(actor.tenantId, (c) => shopifyOrderReadPolicy(c, actor, ch));
  return ch;
}
async function readRemote(
  actor: Actor,
  ch: any,
  ctx: IntegrationContext = {},
  extra?: () => Promise<void>,
  requireCurrentVersion = false,
): Promise<ShopifySubscription[]> {
  const fence = async () => {
    await extra?.();
    await tenantTx(actor.tenantId, (c) => shopifyOrderReadPolicy(c, actor, ch));
  };
  await fence();
  if (ch.settings.simulation)
    return tenantTx(actor.tenantId, async (c) => {
      await shopifyOrderReadPolicy(c, actor, ch);
      return (
        (
          await c.query('SELECT data FROM shopify_subscription_simulations WHERE channel_id=$1', [
            ch.id,
          ])
        ).rows[0]?.data ?? []
      )
        .map(parseShopifySubscription)
        .sort((a: ShopifySubscription, b: ShopifySubscription) => a.id.localeCompare(b.id));
    });
  const bound = await tenantTx(
    actor.tenantId,
    async (c) =>
      (await c.query('SELECT shop_id FROM shopify_account_bindings WHERE channel_id=$1', [ch.id]))
        .rows[0],
  );
  return channelRead(
    actor.tenantId,
    ch.id,
    (client) => (client as Shopify).subscriptions(fence, bound?.shop_id, requireCurrentVersion),
    ctx,
    true,
    async () => fence(),
  );
}
async function observe(c: PoolClient, ch: any, data: ShopifySubscription[]) {
  await c.query(
    `INSERT INTO shopify_subscription_observations(tenant_id,channel_id,connection_hash,data,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel_id) DO UPDATE SET connection_hash=excluded.connection_hash,data=excluded.data,source=excluded.source,observed_at=now()`,
    [
      ch.tenant_id,
      ch.id,
      importConnectionHash(ch),
      JSON.stringify(data),
      ch.settings.simulation ? 'local_simulation' : 'graphql',
    ],
  );
}
export async function refreshShopifySubscriptions(
  actor: Actor,
  id: string,
  ctx: IntegrationContext = {},
) {
  const ch = await access(actor, id),
    data = await readRemote(actor, ch, ctx);
  await tenantTx(actor.tenantId, async (c) => {
    await shopifyOrderReadPolicy(c, actor, ch);
    await observe(c, ch, data);
    await audit(c, actor, 'shopify.subscriptions.read', id, {
      count: data.length,
      source: ch.settings.simulation ? 'local_simulation' : 'graphql',
    });
  });
  return { count: data.length };
}
export async function subscriptionHistory(actor: Actor, id: string) {
  return tenantTx(actor.tenantId, async (c) => {
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [id])).rows[0];
    ensure(ch?.provider === 'shopify', 404, 'Brak kanału Shopify');
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
      403,
      'Wymagana rola administratora',
    );
    const observation = (
      await c.query('SELECT * FROM shopify_subscription_observations WHERE channel_id=$1', [id])
    ).rows[0];
    const plans = (
      await c.query(
        'SELECT id,operation,spec,state,phase,result,error,expires_at,created_at,external_authorized,job_id FROM shopify_subscription_plans WHERE channel_id=$1 ORDER BY created_at DESC,id DESC LIMIT 30',
        [id],
      )
    ).rows;
    const owned = (
      await c.query(
        "SELECT result->'remote' remote FROM shopify_subscription_plans WHERE channel_id=$1 AND connection_hash=$2 AND operation='create' AND state='done' AND result->>'remote_id'=ANY($3::text[])",
        [
          id,
          importConnectionHash(ch),
          (observation?.data ?? []).map((r: ShopifySubscription) => r.id),
        ],
      )
    ).rows.map((r) => r.remote);
    return {
      simulation: !!ch.settings.simulation,
      receiver_path: `/api/webhooks/shopify/${id}`,
      topics: shopifySubscriptionTopics,
      api_version: SHOPIFY_VERSION,
      observation: observation
        ? {
            ...observation,
            data: observation.data.map((r: ShopifySubscription) => ({
              ...r,
              managed_by_channel: owned.some(
                (o: ShopifySubscription) => subscriptionRecordHash(o) === subscriptionRecordHash(r),
              ),
            })),
            connection_matches: observation.connection_hash === importConnectionHash(ch),
          }
        : null,
      plans,
    };
  });
}
export async function previewShopifySubscription(
  actor: Actor,
  id: string,
  input: z.infer<typeof shopifySubscriptionInput>,
  ctx: IntegrationContext = {},
) {
  const ch = await access(actor, id);
  if (input.operation === 'create')
    input = { ...input, uri: subscriptionReceiverUri(input.uri, ch) };
  if (input.operation === 'create' && !ch.settings.simulation && !ctx.transport)
    await validateRemoteUrl(input.uri);
  const data = await readRemote(actor, ch, ctx, undefined, input.operation === 'create');
  return tenantTx(actor.tenantId, async (c) => {
    await shopifyOrderReadPolicy(c, actor, ch);
    const config = await cfg(c, id);
    ensure(
      config && config.connection_hash === importConnectionHash(ch),
      409,
      'Zapisz konfigurację webhooków dla aktualnego połączenia',
    );
    let spec: any;
    if (input.operation === 'create') {
      ensure(config.enabled, 409, 'Włącz odbiornik Shopify przed rejestracją');
      ensure(
        !data.some((r) => r.topic === input.topic && r.uri === input.uri),
        409,
        'Subskrypcja tego tematu i odbiornika już istnieje',
      );
      spec = {
        topic: input.topic,
        webhookSubscription: {
          uri: input.uri,
          format: 'JSON',
          includeFields: subscriptionFieldsFor(input.topic),
        },
      };
    } else {
      const row = data.find((r) => r.id === input.remote_id);
      ensure(row, 404, 'Subskrypcja nie występuje w aktualnym odczycie');
      const ownership = (
        await c.query(
          "SELECT result->'remote' remote FROM shopify_subscription_plans WHERE channel_id=$1 AND connection_hash=$2 AND operation='create' AND state='done' AND result->>'remote_id'=$3",
          [id, importConnectionHash(ch), input.remote_id],
        )
      ).rows[0];
      ensure(
        ownership && subscriptionRecordHash(ownership.remote) === subscriptionRecordHash(row),
        409,
        'Można usunąć tylko niezmienioną subskrypcję utworzoną przez ten kanał i połączenie',
      );
      spec = { remote_id: input.remote_id, remote: row };
    }
    const p = (
      await c.query(
        `INSERT INTO shopify_subscription_plans(id,tenant_id,channel_id,actor_id,connection_hash,config_version,operation,spec,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          randomUUID(),
          actor.tenantId,
          id,
          actor.userId,
          importConnectionHash(ch),
          config.version,
          input.operation,
          JSON.stringify(spec),
          JSON.stringify(data),
          hash(data),
        ],
      )
    ).rows[0];
    await observe(c, ch, data);
    await audit(c, actor, 'shopify.subscriptions.preview', p.id, { operation: input.operation });
    return p;
  });
}
async function policy(c: PoolClient, actor: Actor, p: any, readOnly = false) {
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id]))
    .rows[0];
  ensure(
    ch && importConnectionHash(ch) === p.connection_hash,
    409,
    'Połączenie subskrypcji Shopify zmieniło się',
  );
  await shopifyOrderReadPolicy(c, actor, ch);
  if (readOnly) return ch;
  const config = await cfg(c, ch.id);
  ensure(
    config &&
      config.version === p.config_version &&
      config.connection_hash === p.connection_hash &&
      (p.operation === 'delete' || config.enabled),
    409,
    'Konfiguracja odbiornika Shopify zmieniła się',
  );
  return ch;
}
export async function queueShopifySubscription(actor: Actor, id: string, authorized: boolean) {
  return tenantTx(actor.tenantId, async (c) => {
    const initial = await plan(c, id);
    ensure(initial, 404, 'Brak planu subskrypcji');
    const ch = await policy(c, actor, initial, initial.state === 'done');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'shopify-subscription:' + actor.tenantId + ':' + ch.id,
    ]);
    const p = await plan(c, id, 'FOR UPDATE');
    if (p.state === 'queued' || p.state === 'done') return { id: p.id, state: p.state };
    ensure(
      p.state === 'preview' && new Date(p.expires_at).getTime() > Date.now() && p.phase === 'fresh',
      409,
      'Podgląd nie jest aktualny',
    );
    ensure(
      ch.settings.simulation || authorized,
      422,
      'Zatwierdź zewnętrzną rejestrację odbiornika lub usunięcie subskrypcji',
    );
    ensure(
      !(
        await c.query(
          "SELECT 1 FROM shopify_subscription_plans WHERE channel_id=$1 AND state IN ('queued','uncertain')",
          [ch.id],
        )
      ).rowCount,
      409,
      'Poprzednia subskrypcja wymaga zakończenia lub odczytu wyniku',
    );
    const job = randomUUID();
    await c.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'shopify.subscription',$3,$4)",
      [
        job,
        actor.tenantId,
        JSON.stringify({ plan_id: id, actor_id: actor.userId, channel_id: ch.id }),
        'shopify-subscription:' + id,
      ],
    );
    await c.query(
      "UPDATE shopify_subscription_plans SET state='queued',external_authorized=$2,job_id=$3,updated_at=now() WHERE id=$1",
      [id, !ch.settings.simulation && authorized, job],
    );
    await audit(c, actor, 'shopify.subscriptions.queue', id);
    return { id, state: 'queued' };
  });
}
export async function cancelShopifySubscription(actor: Actor, id: string) {
  return tenantTx(actor.tenantId, async (c) => {
    const initial = await plan(c, id);
    ensure(initial, 404, 'Brak planu');
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
      403,
      'Wymagana rola administratora',
    );
    if (initial.job_id) {
      const j = (await c.query('SELECT state FROM jobs WHERE id=$1 FOR UPDATE', [initial.job_id]))
        .rows[0];
      ensure(j?.state !== 'running', 409, 'Zadanie rozpoczęło pracę');
    }
    const p = await plan(c, id, 'FOR UPDATE');
    ensure(
      ['preview', 'queued', 'failed'].includes(p.state) && p.phase === 'fresh',
      409,
      'Próby zapisu nie można anulować lokalnie',
    );
    await c.query(
      "UPDATE shopify_subscription_plans SET state='cancelled',updated_at=now() WHERE id=$1",
      [id],
    );
    if (p.job_id)
      await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
        p.job_id,
      ]);
    return { cancelled: true };
  });
}
async function guard(c: PoolClient, job: any) {
  const initial = await plan(c, job.payload.plan_id);
  ensure(initial && initial.job_id === job.id, 422, 'Nieprawidłowy plan subskrypcji');
  const actor: Actor = { tenantId: job.tenant_id, userId: job.payload.actor_id, role: 'admin' },
    ch = await policy(c, actor, initial);
  const j = (
    await c.query(
      "SELECT * FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
      [job.id, job.lease_token],
    )
  ).rows[0];
  if (!j) return null;
  const p = await plan(c, initial.id, 'FOR UPDATE');
  ensure(
    p.state === 'queued' &&
      j.kind === 'shopify.subscription' &&
      j.payload.plan_id === p.id &&
      j.payload.actor_id === actor.userId,
    409,
    'Zadanie subskrypcji zmieniło się',
  );
  ensure(
    ch.settings.simulation || p.external_authorized,
    409,
    'Brak zgody na zewnętrzną subskrypcję',
  );
  await c.query('UPDATE jobs SET locked_at=now() WHERE id=$1', [job.id]);
  return { p, ch, actor };
}
const subscriptionRecordHash = (r: ShopifySubscription) =>
  hash({ ...r, includeFields: [...r.includeFields].sort() });
const wanted = (r: ShopifySubscription, p: any) =>
  r.topic === p.spec.topic &&
  r.uri === p.spec.webhookSubscription.uri &&
  r.format === 'JSON' &&
  !r.filter &&
  r.apiVersion.handle === SHOPIFY_VERSION &&
  hash([...r.includeFields].sort()) === hash([...p.spec.webhookSubscription.includeFields].sort());
async function finish(c: PoolClient, p: any, ch: any, rows: ShopifySubscription[]) {
  const candidates =
    p.operation === 'create'
      ? rows.filter((r) => wanted(r, p) && !p.snapshot.some((s: any) => s.id === r.id))
      : rows.filter((r) => r.id === p.spec.remote_id);
  ensure(
    p.operation === 'create' ? candidates.length === 1 : candidates.length === 0,
    409,
    'Wynik nie jest jednoznaczny; odczytaj ponownie bez ponawiania zapisu',
  );
  const result =
    p.operation === 'create'
      ? { remote_id: candidates[0].id, remote: candidates[0] }
      : { remote_id: p.spec.remote_id, deleted: true };
  await c.query(
    "UPDATE shopify_subscription_plans SET state='done',phase='done',result=$2,error=NULL,updated_at=now() WHERE id=$1",
    [p.id, JSON.stringify(result)],
  );
  await observe(c, ch, rows);
  return result;
}
export async function processShopifySubscription(job: any, ctx: IntegrationContext = {}) {
  const initial = await tenantTx(job.tenant_id, (c) => guard(c, job));
  if (!initial) return;
  const fence = async () =>
    ensure(
      await tenantTx(job.tenant_id, (c) => guard(c, job)),
      409,
      'Utracono dzierżawę subskrypcji',
    );
  let rows = await readRemote(
    initial.actor,
    initial.ch,
    ctx,
    fence,
    initial.p.phase === 'fresh' && initial.p.operation === 'create',
  );
  if (initial.p.phase === 'fresh') {
    if (initial.p.operation === 'create' && !initial.ch.settings.simulation && !ctx.transport)
      await validateRemoteUrl(initial.p.spec.webhookSubscription.uri);
    const marked = await tenantTx(job.tenant_id, async (c) => {
      const current = await guard(c, job);
      if (!current) return false;
      ensure(
        new Date(current.p.expires_at).getTime() > Date.now(),
        409,
        'Podgląd subskrypcji wygasł',
      );
      ensure(
        hash(rows) === current.p.snapshot_hash,
        409,
        'Subskrypcje Shopify zmieniły się po podglądzie',
      );
      await c.query(
        "UPDATE shopify_subscription_plans SET phase='attempted',attempted_at=now(),updated_at=now() WHERE id=$1",
        [current.p.id],
      );
      return true;
    });
    if (!marked) return;
    if (initial.ch.settings.simulation) {
      await tenantTx(job.tenant_id, async (c) => {
        const current = await guard(c, job);
        ensure(current, 409, 'Zatrzymano przykład subskrypcji');
        let next = [...rows];
        if (initial.p.operation === 'create')
          next.push(
            parseShopifySubscription({
              id:
                'gid://shopify/WebhookSubscription/' +
                BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 15)).toString(),
              ...initial.p.spec.webhookSubscription,
              topic: initial.p.spec.topic,
              filter: null,
              apiVersion: { handle: SHOPIFY_VERSION },
            }),
          );
        else next = next.filter((r) => r.id !== initial.p.spec.remote_id);
        await c.query(
          'INSERT INTO shopify_subscription_simulations(tenant_id,channel_id,data) VALUES($1,$2,$3) ON CONFLICT(channel_id) DO UPDATE SET data=excluded.data',
          [
            job.tenant_id,
            initial.ch.id,
            JSON.stringify(next.sort((a, b) => a.id.localeCompare(b.id))),
          ],
        );
      });
    } else
      await channelRead(
        job.tenant_id,
        initial.ch.id,
        async (client) =>
          initial.p.operation === 'create'
            ? (client as Shopify).createSubscription(initial.p.spec, fence)
            : (client as Shopify).deleteSubscription(initial.p.spec.remote_id, fence),
        ctx,
        false,
        async () => fence(),
      );
    rows = await readRemote(initial.actor, initial.ch, ctx, fence);
  }
  await tenantTx(job.tenant_id, async (c) => {
    const current = await guard(c, job);
    if (!current) return;
    const result = await finish(c, current.p, current.ch, rows);
    await c.query(
      "UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL WHERE id=$1",
      [job.id],
    );
    await audit(c, current.actor, 'shopify.subscriptions.completed', current.p.id, result);
  });
}
export async function failShopifySubscription(job: any, error: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    const j = (
      await c.query(
        "SELECT * FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rows[0];
    if (!j) return;
    const p = await plan(c, job.payload.plan_id, 'FOR UPDATE');
    if (!p) return;
    const message = error instanceof Problem ? error.message : 'Błąd subskrypcji Shopify';
    await c.query(
      'UPDATE shopify_subscription_plans SET state=$2,error=$3,updated_at=now() WHERE id=$1',
      [p.id, p.phase === 'fresh' ? 'failed' : 'uncertain', message],
    );
    await c.query(
      "UPDATE jobs SET state='done',error=$2,lease_token=NULL,locked_at=NULL WHERE id=$1",
      [job.id, message],
    );
  });
}
export async function reconcileShopifySubscription(
  actor: Actor,
  id: string,
  ctx: IntegrationContext = {},
) {
  const initial = await tenantTx(actor.tenantId, async (c) => {
    const p = await plan(c, id);
    ensure(
      p && p.state === 'uncertain' && p.phase === 'attempted',
      409,
      'Plan nie wymaga uzgodnienia',
    );
    return { p, ch: await policy(c, actor, p, true) };
  });
  const rows = await readRemote(actor, initial.ch, ctx);
  return tenantTx(actor.tenantId, async (c) => {
    await policy(c, actor, initial.p, true);
    if (initial.p.job_id) {
      const j = (await c.query('SELECT state FROM jobs WHERE id=$1 FOR UPDATE', [initial.p.job_id]))
        .rows[0];
      ensure(j?.state !== 'running', 409, 'Poczekaj na zakończenie zadania');
    }
    const current = await plan(c, id, 'FOR UPDATE');
    ensure(current.state === 'uncertain', 409, 'Plan zmienił się');
    const result = await finish(c, current, initial.ch, rows);
    await audit(c, actor, 'shopify.subscriptions.reconciled', id, result);
    return result;
  });
}
