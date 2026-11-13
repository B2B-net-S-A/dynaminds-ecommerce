import { allegroOAuthCommitRefusalDetails } from './allegro-oauth-authority';
import { assertOrderMergeActiveInTx, orderMergeOriginInTx } from './order-merge-guards';
import { authTx } from './workspace-routes';
import {
  isLocalFinancialVersion,
  localFinancialFencesAvailable,
  LOCAL_FINANCIAL_SELECTION_SQL,
} from './local-financial-policy';
import { psStatusMap, psState, psSimState, psWritable, psResourceKey } from './prestashop-status';
import { psId, psMicros } from './prestashop-orders';
import { shopifyCredentialIdentity } from './shopify-auth-input';
import { createHash, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import {
  channelRead,
  withAllegroJobContext,
  loadChannel,
  orderWriteScope,
  type IntegrationContext,
} from './channel-access';
import { Allegro, WooCommerce, PrestaShop } from './integrations';
import { normalizeOrder } from './imports';
import { connectionHash } from './offer-sync-policy';
import { fenceSync } from './offer-sync';
import { signalStatus, insertStatusScan } from './order-status-signals';
import { systemActor } from './sync';

export const STATUS_BATCH = 25;
export const statusMappings: Record<string, Record<string, string>> = {
  prestashop: {},
  woocommerce: {
    paid: 'processing',
    picking: 'processing',
    packed: 'processing',
    shipped: 'completed',
    delivered: 'completed',
    completed: 'completed',
    cancelled: 'cancelled',
  },
  allegro: {
    paid: 'PROCESSING',
    picking: 'PROCESSING',
    packed: 'READY_FOR_SHIPMENT',
    shipped: 'SENT',
    delivered: 'SENT',
    completed: 'SENT',
    cancelled: 'CANCELLED',
  },
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const statusConnection = (ch: any) =>
  hash([
    connectionHash(ch),
    ch.provider === 'allegro'
      ? null
      : ch.provider === 'shopify'
        ? shopifyCredentialIdentity(ch)
        : ch.credentials,
  ]);
const message = (e: unknown) =>
  e instanceof Problem ? e.message : 'Błąd synchronizacji statusu kanału';
export function mappingsFor(ch: any) {
  return ch.provider === 'prestashop' ? psStatusMap(ch) : statusMappings[ch.provider];
}
export function statusTarget(ch: any, o: any) {
  ensure(
    ch &&
      statusMappings[ch.provider] &&
      o.channel_id === ch.id &&
      o.source === ch.provider &&
      o.external_id &&
      o.source_snapshot?.items?.length,
    422,
    'Wymagane zaimportowane zamówienie obsługiwanego kanału',
  );
  // A cash-on-delivery order is ready to fulfil in paid ("Nowe") but not paid: the channel hears nothing until
  // picking, as before the paid code meant "Nowe".
  const target = o.status === 'paid' && o.payment_mode === 'cod' ? undefined : mappingsFor(ch)[o.status];
  ensure(
    target,
    409,
    'Ten etap zamówienia wymaga osobnego procesu; status kanału nie zostanie zapisany',
  );
  if (ch.provider === 'prestashop') psId(o.external_id);
  if (ch.provider === 'woocommerce')
    ensure(
      /^[1-9]\d{0,14}$/.test(o.external_id) && Number.isSafeInteger(Number(o.external_id)),
      422,
      'Nieprawidłowe ID zamówienia sklepu',
    );
  return target;
}
// Hashes contain no customer fields in the response or audit; comparison includes address and totals.
export function commerceHash(o: any, items = o.items) {
  return hash({
    id: String(o.external_id),
    currency: o.currency,
    payment_mode: o.payment_mode ?? 'prepaid',
    total: o.total,
    shipping_cost: o.shipping_cost,
    email: o.email,
    customer_name: o.customer_name,
    address: Object.fromEntries(
      Object.entries(o.address ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
    items: items
      .map((i: any) => [String(i.external_id), i.quantity, i.line_total])
      .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}
export async function statusOrder(c: PoolClient, id: string, lock = false) {
  const o = (await c.query('SELECT * FROM orders WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [id]))
    .rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  if (lock) await assertOrderMergeActiveInTx(c, id);
  const original = await orderMergeOriginInTx(c, id);
  return original
    ? {
        ...o,
        total: original.header.total,
        shipping_cost: original.header.shipping_cost,
        source_snapshot: original.header.source_snapshot,
      }
    : o;
}
function observed(ch: any, o: any, raw: any) {
  let normalized;
  try {
    normalized = normalizeOrder(ch.provider, raw, ch.settings);
  } catch {
    throw new Problem(409, 'Dane źródłowe zamówienia są niezgodne; zapis statusu zatrzymany');
  }
  ensure(
    normalized.external_id === o.external_id &&
      commerceHash(normalized) === commerceHash(o, o.source_snapshot.items),
    409,
    'Zmieniły się pozycje, kwoty lub dane odbiorcy w kanale sprzedaży',
  );
  const status =
    ch.provider === 'prestashop'
      ? psId(raw.current_state)
      : ch.provider === 'allegro'
        ? (raw.fulfillment?.status ?? 'NEW')
        : raw.status;
  if (ch.provider === 'prestashop')
    ensure(
      raw._dyna.details.every(
        (d: any) =>
          Number(d.product_quantity_return) === 0 &&
          Number(d.product_quantity_refunded) === 0 &&
          psMicros(d.total_refunded_tax_incl) === 0n &&
          Number(d.id_customization) === 0,
      ),
      409,
      'Zwrot, refundacja lub personalizacja PrestaShop wymaga osobnego uzgodnienia',
    );
  ensure(
    typeof status === 'string' && status.length <= 80,
    502,
    'Brak statusu w odpowiedzi kanału',
  );
  ensure(
    ch.provider !== 'allegro' ||
      (typeof raw.revision === 'string' && raw.revision.length > 0 && raw.revision.length <= 160),
    502,
    'Brak rewizji zamówienia Allegro',
  );
  ensure(
    ch.provider !== 'allegro' || raw.fulfillment?.provider?.id !== 'ALLEGRO',
    409,
    'One Fulfillment wymaga osobnego procesu',
  );
  ensure(
    ch.provider !== 'woocommerce' || !(raw.refunds ?? []).length,
    409,
    'Zamówienie zawiera refundację; wymaga osobnego uzgodnienia',
  );
  return {
    status,
    revision: ch.provider === 'allegro' ? raw.revision : null,
    modified:
      ch.provider === 'prestashop'
        ? (raw.date_upd ?? null)
        : ch.provider === 'woocommerce'
          ? (raw.date_modified_gmt ?? raw.date_modified ?? null)
          : null,
    commerce_hash: commerceHash(normalized),
    paid: normalized.paid,
    payment_mode: normalized.payment_mode,
    source_state: normalized.source_status,
  };
}
function writable(ch: any, remote: any, target: string, local: string) {
  if (ch.provider === 'prestashop') return psWritable(ch, remote, target, local);
  if (remote.status === target) return;
  const stages =
    ch.provider === 'woocommerce'
      ? ['pending', 'on-hold', 'processing', 'completed']
      : ['NEW', 'PROCESSING', 'READY_FOR_SHIPMENT', 'SENT', 'PICKED_UP'];
  ensure(stages.includes(remote.status), 409, 'Status kanału wymaga osobnego uzgodnienia');
  if (target === 'cancelled' || target === 'CANCELLED')
    ensure(
      stages.indexOf(remote.status) < (ch.provider === 'woocommerce' ? 3 : 3),
      409,
      'Kanał potwierdził już wysyłkę; nie można anulować realizacji',
    );
  else {
    ensure(
      remote.paid || remote.payment_mode === 'cod',
      409,
      'Kanał nie potwierdza pełnej płatności ani pobrania',
    );
    ensure(
      ch.provider !== 'allegro' || remote.source_state === 'READY_FOR_PROCESSING',
      409,
      'Formularz Allegro nie jest gotowy do realizacji',
    );
    ensure(
      stages.indexOf(remote.status) <= stages.indexOf(target),
      409,
      'Status kanału wyprzedza lokalną realizację; cofnięcie zatrzymane',
    );
  }
}
async function readRemote(
  actor: Actor,
  ch: any,
  o: any,
  ctx: IntegrationContext,
  target?: string,
): Promise<any> {
  if (ch.provider === 'prestashop') target ??= statusTarget(ch, o);
  if (ch.settings.simulation)
    return tenantTx(actor.tenantId, async (c) => {
      const inbound = (
        await c.query('SELECT raw FROM inbound_orders WHERE order_id=$1 AND channel_id=$2', [
          o.id,
          ch.id,
        ])
      ).rows[0];
      ensure(inbound, 409, 'Brak danych przykładu importu');
      const base = structuredClone(inbound.raw);
      await c.query(
        'INSERT INTO order_status_simulations(tenant_id,order_id,status) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [
          actor.tenantId,
          o.id,
          ch.provider === 'prestashop'
            ? psId(base.current_state)
            : ch.provider === 'allegro'
              ? (base.fulfillment?.status ?? 'NEW')
              : base.status,
        ],
      );
      const sim = (
        await c.query('SELECT * FROM order_status_simulations WHERE order_id=$1', [o.id])
      ).rows[0];
      if (ch.provider === 'allegro') {
        base.fulfillment = { ...base.fulfillment, status: sim.status };
        base.revision = String(sim.revision);
      } else if (ch.provider === 'prestashop') {
        base.current_state = sim.status;
        base._dyna.state = psSimState(ch, sim.status);
        base.date_upd = String(sim.revision);
        return {
          ...observed(ch, o, base),
          ps_state: JSON.stringify(psState(base._dyna.state, sim.status)),
          ps_target_state: JSON.stringify(psState(psSimState(ch, target!), target!)),
        };
      } else {
        base.status = sim.status;
        base.date_modified_gmt = String(sim.revision);
      }
      return observed(ch, o, base);
    });
  return channelRead(
    actor.tenantId,
    ch.id,
    async (client) => {
      if (client instanceof PrestaShop) {
        const raw: any = await client.order(o.external_id),
          ts = await client.statusState(target!);
        return {
          ...observed(ch, o, raw),
          ps_state: JSON.stringify(psState(raw._dyna.state, psId(raw.current_state))),
          ps_target_state: JSON.stringify(psState(ts, target!)),
        };
      }
      return observed(
        ch,
        o,
        client instanceof WooCommerce
          ? await client.order(Number(o.external_id))
          : await (client as Allegro).order(o.external_id),
      );
    },
    ctx,
    true,
    (current) =>
      ensure(
        statusConnection(current) === statusConnection(ch),
        409,
        'Zmieniono połączenie kanału sprzedaży',
      ),
  );
}
export function requireStatusScope(ch: any) {
  if (ch.provider === 'allegro' && !ch.settings.simulation)
    ensure(
      (ch.oauth_scopes ?? '').split(' ').includes(orderWriteScope),
      403,
      'Połącz Allegro z prawem zapisu statusów zamówień',
    );
}
async function policy(c: PoolClient, actor: Actor, ch: any, version?: number | null) {
  if (version != null) {
    const cfg = (
      await c.query('SELECT * FROM order_status_configs WHERE channel_id=$1 FOR SHARE', [ch.id])
    ).rows[0];
    ensure(
      cfg?.enabled &&
        cfg.version === version &&
        cfg.actor_id === actor.userId &&
        cfg.connection_hash === statusConnection(ch) &&
        (ch.settings.simulation || cfg.external_authorized),
      409,
      'Automatyczny zapis wyłączono lub zmieniono; odśwież konfigurację',
    );
  }
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) AS ok', [actor.userId])).rows[0]?.ok,
    403,
    'Administrator nie ma już wymaganych uprawnień',
  );
  requireStatusScope(ch);
}
export async function previewStatus(
  actor: Actor,
  orderId: string,
  ctx: IntegrationContext = {},
  automatic?: { job: any; version: number },
) {
  const o = await tenantTx(actor.tenantId, async (c) => {
    const current = await statusOrder(c, orderId);
    await assertOrderMergeActiveInTx(c, orderId);
    if (automatic)
      ensure(
        !(await isLocalFinancialVersion(c, orderId)),
        409,
        'Lokalne rozliczenie nie uruchamia automatycznej synchronizacji statusu',
      );
    return current;
  });
  const ch = await loadChannel(actor.tenantId, o.channel_id),
    target = statusTarget(ch, o);
  const remote = await readRemote(actor, ch, o, ctx, target);
  writable(ch, remote, target, o.status);
  return tenantTx(actor.tenantId, async (c) => {
    const current = await statusOrder(c, orderId, true);
    ensure(current.version === o.version, 409, 'Zamówienie zmieniono; utwórz nowy podgląd');
    const connection = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
      .rows[0];
    ensure(
      statusConnection(connection) === statusConnection(ch),
      409,
      'Połączenie kanału zmieniono',
    );
    ensure(
      (
        await c.query(
          "SELECT id FROM inbound_orders WHERE order_id=$1 AND channel_id=$2 AND state='imported'",
          [o.id, ch.id],
        )
      ).rowCount,
      409,
      'Brak potwierdzonego powiązania importu',
    );
    if (automatic) {
      ensure(
        !(await isLocalFinancialVersion(c, orderId)),
        409,
        'Lokalne rozliczenie nie uruchamia automatycznej synchronizacji statusu',
      );
      await policy(c, actor, connection, automatic.version);
      ensure(await fenceSync(c, automatic.job, true), 409, 'Wygasła dzierżawa przeglądu statusów');
    }
    const id = randomUUID();
    const plan = (
      await c.query(
        `INSERT INTO order_status_plans(id,tenant_id,order_id,channel_id,actor_id,local_version,local_status,target,connection_hash,remote,config_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          id,
          actor.tenantId,
          o.id,
          ch.id,
          actor.userId,
          o.version,
          o.status,
          target,
          statusConnection(ch),
          JSON.stringify(remote),
          automatic?.version ?? null,
        ],
      )
    ).rows[0];
    await audit(c, actor, 'order.channel-status.preview', id, {
      order_id: o.id,
      target,
      simulation: Boolean(ch.settings.simulation),
    });
    return plan;
  });
}
export async function queueStatus(
  actor: Actor,
  planId: string,
  confirmExternal = false,
  automatic?: { job: any; version: number },
) {
  return tenantTx(actor.tenantId, c => queueStatusInTx(c, actor, planId, confirmExternal, automatic));
}
/** Internal in-TX body; original public queue retains its transaction boundary. */
export async function queueStatusInTx(c: PoolClient, actor: Actor, planId: string, confirmExternal = false, automatic?: {job: any; version: number}) {
  let p = (await c.query('SELECT * FROM order_status_plans WHERE id=$1', [planId])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu statusu');
  const o = await statusOrder(c, p.order_id, true);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [p.channel_id]))
    .rows[0];
  await policy(c, actor, ch, p.config_version);
  if (automatic)
    ensure(
      !(await isLocalFinancialVersion(c, o.id)),
      409,
      'Lokalne rozliczenie nie uruchamia automatycznej synchronizacji statusu',
    );
  if (automatic)
    ensure(await fenceSync(c, automatic.job, true), 409, 'Wygasła dzierżawa przeglądu');
  p = (await c.query('SELECT * FROM order_status_plans WHERE id=$1 FOR UPDATE', [planId]))
    .rows[0];
  if (p.state === 'queued' || p.state === 'done') return p;
  ensure(
    p.state === 'preview' && (!p.config_version || automatic?.version === p.config_version),
    409,
    'Ten podgląd nie może zostać zlecony',
  );
  ensure(
    o.version === p.local_version && statusTarget(ch, o) === p.target,
    409,
    'Zamówienie zmieniono; utwórz nowy podgląd',
  );
  ensure(statusConnection(ch) === p.connection_hash, 409, 'Połączenie kanału zmieniono');
  ensure(
    ch.settings.simulation || confirmExternal,
    422,
    'Potwierdź zapis statusu do API; dostawca może wysłać powiadomienie kupującemu',
  );
  ensure(
    !(
      await c.query(
        "SELECT id FROM order_status_plans WHERE order_id=$1 AND (state='queued' OR (state='failed' AND phase IN ('write_started','verify')))",
        [o.id],
      )
    ).rowCount,
    409,
    'Trwa zapis statusu albo wymaga odczytu wyniku',
  );
  const jobId = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'order.status.write',$3,$4)",
    [
      jobId,
      actor.tenantId,
      JSON.stringify({ plan_id: p.id, actor_id: actor.userId }),
      'order.status.write:' + p.id,
    ],
  );
  p = (
    await c.query(
      "UPDATE order_status_plans SET state='queued',job_id=$2,actor_id=$3,updated_at=now() WHERE id=$1 RETURNING *",
      [p.id, jobId, actor.userId],
    )
  ).rows[0];
  await audit(c, actor, 'order.channel-status.queue', p.id, {
    order_id: o.id,
    target: p.target,
    simulation: Boolean(ch.settings.simulation),
  });
  return p;
}
async function resourceLock(
  tenant: string,
  order: string,
  fn: () => Promise<void>,
  remoteKey?: string,
) {
  const c = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'order-status'),
    key = remoteKey ?? 'order-status:' + tenant + ':' + order;
  try {
    return await holdingDbLock(c, async () => {
    await c.connect();
    await c.query("SET lock_timeout='20s'");
    await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
    await fn();
    });
  } finally {
    await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]).catch(() => {});
    await c.end();
  }
}
async function planFor(job: any) {
  return tenantTx(
    job.tenant_id,
    async (c) =>
      (await c.query('SELECT * FROM order_status_plans WHERE id=$1', [job.payload.plan_id]))
        .rows[0],
  );
}
async function claimPresta(ch: any, o: any, p: any) {
  const resource = psResourceKey(ch, o).split(':')[1];
  await authTx(async (c) => {
    const held = (
      await c.query(
        'SELECT p.id,p.state,p.phase FROM prestashop_status_claims k JOIN order_status_plans p ON (p.tenant_id,p.id)=(k.tenant_id,k.plan_id) WHERE k.resource_hash=$1 FOR UPDATE OF k',
        [resource],
      )
    ).rows[0];
    ensure(
      !held ||
        held.id === p.id ||
        (['done', 'cancelled', 'conflict', 'failed'].includes(held.state) &&
          !['write_started', 'verify'].includes(held.phase)),
      409,
      'Ten sklep i zamówienie mają zapis lub niepewny wynik wymagający uzgodnienia',
    );
    if (held?.id === p.id) return;
    await c.query(
      'INSERT INTO prestashop_status_claims(resource_hash,tenant_id,plan_id) VALUES($1,$2,$3) ON CONFLICT(resource_hash) DO UPDATE SET tenant_id=excluded.tenant_id,plan_id=excluded.plan_id,claimed_at=now()',
      [resource, ch.tenant_id, p.id],
    );
  });
}
async function statusResource(tenant: string, p: any) {
  const ch = await loadChannel(tenant, p.channel_id);
  if (ch.provider !== 'prestashop') return undefined;
  const o = await tenantTx(tenant, (c) => statusOrder(c, p.order_id));
  return psResourceKey(ch, o);
}
export async function processStatusWrite(job: any, ctx: IntegrationContext = {}) {
  ctx = withAllegroJobContext(ctx, job);
  const initial = await planFor(job);
  ensure(initial, 404, 'Nie znaleziono zapisu statusu');
  await resourceLock(
    job.tenant_id,
    initial.order_id,
    async () => {
      const p = await planFor(job);
      if (p.state !== 'queued') {
        await finishStatusJob(job);
        return;
      }
      const actor: Actor = { tenantId: job.tenant_id, userId: p.actor_id, role: 'admin' };
      const o = await tenantTx(actor.tenantId, (c) => statusOrder(c, p.order_id));
      const ch = await loadChannel(actor.tenantId, p.channel_id);
      ensure(
        statusConnection(ch) === p.connection_hash,
        409,
        'Połączenie kanału zmieniono; wynik wymaga odczytu na pierwotnym koncie',
      );
      if (ch.provider === 'prestashop') {
        if (p.phase === 'ready')
          await tenantTx(actor.tenantId, async (c) => {
            await policy(c, actor, ch, p.config_version);
            ensure(await fenceSync(c, job, true), 409, 'Wygasła dzierżawa zapisu statusu');
          });
        await claimPresta(ch, o, p);
      }
      if (p.phase === 'ready') {
        ensure(
          o.version === p.local_version && statusTarget(ch, o) === p.target,
          409,
          'Zamówienie zmieniono; nowy zapis zatrzymany',
        );
        // GET can refresh OAuth. No write is replayed on a refreshed token.
        const remote = await readRemote(actor, ch, o, ctx, p.target);
        writable(ch, remote, p.target, p.local_status);
        if (remote.status === p.target) {
          await completeStatus(job, p, remote, true);
          return;
        }
        ensure(
          Object.entries(remote).every(([key, value]) => p.remote[key] === value),
          409,
          'Dane lub rewizja kanału zmieniły się od podglądu',
        );
        const allowed = await tenantTx(actor.tenantId, async (c) => {
          const latest = await statusOrder(c, p.order_id, true);
          const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
            .rows[0];
          ensure(
            latest.version === p.local_version && statusConnection(current) === p.connection_hash,
            409,
            'Zamówienie lub połączenie zmieniono przed zapisem',
          );
          await policy(c, actor, current, p.config_version);
          if (!(await fenceSync(c, job, true))) return false;
          const plan = (
            await c.query('SELECT * FROM order_status_plans WHERE id=$1 FOR UPDATE', [p.id])
          ).rows[0];
          if (plan.state !== 'queued' || plan.phase !== 'ready') return false;
          await c.query(
            "UPDATE order_status_plans SET phase='write_started',updated_at=now() WHERE id=$1",
            [p.id],
          );
          return true;
        });
        if (!allowed) return;
        if (ch.settings.simulation)
          await tenantTx(actor.tenantId, (c) =>
            c.query(
              'UPDATE order_status_simulations SET status=$2,revision=revision+1 WHERE order_id=$1',
              [o.id, p.target],
            ),
          );
        else
          await channelRead(
            actor.tenantId,
            ch.id,
            async (client) => {
              if (client instanceof PrestaShop)
                await client.updateOrderStatus(o.external_id, p.target);
              else if (client instanceof WooCommerce)
                await client.updateOrderStatus(Number(o.external_id), p.target);
              else {
                // The job authority no longer pins the config once the plan is write_started; a pause committed
                // after the write_started flip must still stop this first PUT.
                await tenantTx(actor.tenantId, async (c) => {
                  const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id])).rows[0];
                  await policy(c, actor, current, p.config_version);
                });
                await (client as Allegro).updateOrderStatus(
                  o.external_id,
                  p.target,
                  remote.revision,
                );
              }
            },
            ctx,
            false,
            (current) => {
              ensure(
                statusConnection(current) === p.connection_hash,
                409,
                'Połączenie kanału zmieniono przed żądaniem',
              );
              requireStatusScope(current);
            },
          );
        await tenantTx(actor.tenantId, async (c) => {
          if (await fenceSync(c, job, true))
            await c.query(
              "UPDATE order_status_plans SET phase='verify',updated_at=now() WHERE id=$1 AND state='queued'",
              [p.id],
            );
        });
      }
      const remote = await readRemote(actor, ch, o, ctx, p.target);
      ensure(
        remote.status === p.target,
        502,
        'Kanał nie potwierdził wyniku. Kolejna próba wykona wyłącznie odczyt',
      );
      if (ch.provider === 'prestashop')
        ensure(
          remote.ps_target_state === p.remote.ps_target_state,
          409,
          'Zmieniono znaczenie statusu sklepu; wymagane uzgodnienie',
        );
      await completeStatus(job, p, remote, false);
    },
    await statusResource(job.tenant_id, initial),
  );
}
async function completeStatus(job: any, p: any, remote: any, unchanged: boolean) {
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fenceSync(c, job))) return;
    const o = await statusOrder(c, p.order_id);
    const result = {
      status: remote.status,
      revision: remote.revision,
      unchanged,
      stale_local: o.version !== p.local_version,
      verified_at: new Date().toISOString(),
    };
    await c.query(
      "UPDATE order_status_plans SET state='done',phase='done',result=$2,error=NULL,updated_at=now() WHERE id=$1 AND state='queued'",
      [p.id, JSON.stringify(result)],
    );
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1 AND lease_token=$2",
      [job.id, job.lease_token],
    );
    await audit(
      c,
      { tenantId: job.tenant_id, userId: p.actor_id, role: 'admin' },
      'order.channel-status.verified',
      p.id,
      result,
    );
    if (o.version !== p.local_version) await signalStatus(c, job.tenant_id, p.order_id);
  });
}
async function finishStatusJob(job: any) {
  await tenantTx(job.tenant_id, (c) =>
    c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1 AND lease_token=$2",
      [job.id, job.lease_token],
    ),
  );
}
export async function failStatusJob(job: any, e: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fenceSync(c, job))) return;
    const p =
      job.kind === 'order.status.write'
        ? (
            await c.query('SELECT * FROM order_status_plans WHERE id=$1 FOR UPDATE', [
              job.payload.plan_id,
            ])
          ).rows[0]
        : null;
    const terminal = e instanceof Problem && [403, 404, 409, 422].includes(e.status);
    const failed = terminal || job.attempts >= job.max_attempts;
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, failed ? 'failed' : 'pending', message(e)],
    );
    if (p && failed) {
      // HTTP 409/422 from Allegro proves rejection, but a conflict from local checks after dispatch does not.
      const rejected =
        e instanceof Problem && /^API Allegro: HTTP (403|404|409|422)$/.test(e.message);
      await c.query(
        "UPDATE order_status_plans SET state=$2,phase=CASE WHEN $3 THEN 'done' ELSE phase END,error=$4,updated_at=now() WHERE id=$1 AND state='queued'",
        [p.id, p.phase === 'ready' || rejected ? 'conflict' : 'failed', rejected, message(e)],
      );
    }
    if (job.kind === 'order.status.scan' && failed)
      await c.query(
        'UPDATE order_status_configs SET error=$2,enabled=CASE WHEN $4 THEN false ELSE enabled END WHERE channel_id=$1 AND version=$3',
        [
          job.payload.channel_id,
          message(e),
          job.payload.version,
          e instanceof Problem && e.status === 403,
        ],
      );
  });
}
export async function reconcileStatus(
  actor: Actor,
  planId: string,
  ctx: IntegrationContext = {},
  acknowledge = false,
) {
  const p = await tenantTx(
    actor.tenantId,
    async (c) => (await c.query('SELECT * FROM order_status_plans WHERE id=$1', [planId])).rows[0],
  );
  ensure(
    p && p.state === 'failed' && ['write_started', 'verify'].includes(p.phase),
    409,
    'Odczyt wyniku dotyczy niepewnego zapisu po zakończeniu prób',
  );
  let result: any;
  await resourceLock(
    actor.tenantId,
    p.order_id,
    async () => {
      const ch = await loadChannel(actor.tenantId, p.channel_id);
      ensure(
        statusConnection(ch) === p.connection_hash,
        409,
        'Wymagane pierwotne połączenie kanału',
      );
      const o = await tenantTx(actor.tenantId, (c) => statusOrder(c, p.order_id));
      const remote = await readRemote(actor, ch, o, ctx, p.target);
      result = await tenantTx(actor.tenantId, async (c) => {
        ensure(
          (await c.query('SELECT offer_sync_is_admin($1) AS ok', [actor.userId])).rows[0]?.ok,
          403,
          'Administrator nie ma już wymaganych uprawnień',
        );
        const current = (
          await c.query('SELECT * FROM order_status_plans WHERE id=$1 FOR UPDATE', [p.id])
        ).rows[0];
        ensure(
          current.state === 'failed' && ['write_started', 'verify'].includes(current.phase),
          409,
          'Wynik już uzgodniono',
        );
        const matched =
          remote.status === p.target &&
          (ch.provider !== 'prestashop' || remote.ps_target_state === p.remote.ps_target_state);
        ensure(
          matched || acknowledge,
          409,
          'Kanał nie potwierdził statusu; możesz ponowić odczyt albo świadomie zamknąć niezgodność',
        );
        const report = {
          status: remote.status,
          target: p.target,
          unchanged: false,
          verified_at: new Date().toISOString(),
          acknowledged: !matched,
          stale_local: o.version !== p.local_version,
        };
        const updated = (
          await c.query(
            "UPDATE order_status_plans SET state=$2,phase='done',result=$3,error=$4,updated_at=now() WHERE id=$1 RETURNING *",
            [
              p.id,
              matched ? 'done' : 'conflict',
              JSON.stringify(report),
              matched
                ? null
                : 'Administrator zamknął niezgodność po odczycie; ewentualny kolejny zapis wymaga nowego podglądu',
            ],
          )
        ).rows[0];
        await audit(c, actor, 'order.channel-status.reconcile', p.id, report);
        return updated;
      });
    },
    await statusResource(actor.tenantId, p),
  );
  return result;
}
export async function scheduleStatusesDue() {
  const due = (
    await pool.query(
      'SELECT * FROM order_status_configs WHERE enabled AND (next_run_at IS NULL OR next_run_at<=now()) ORDER BY next_run_at NULLS FIRST,channel_id LIMIT 20',
    )
  ).rows;
  for (const row of due)
    await tenantTx(row.tenant_id, async (c) => {
      const cfg = (
        await c.query('SELECT * FROM order_status_configs WHERE channel_id=$1 FOR UPDATE', [
          row.channel_id,
        ])
      ).rows[0];
      if (
        !cfg?.enabled ||
        cfg.version !== row.version ||
        (cfg.next_run_at && new Date(cfg.next_run_at).getTime() > Date.now())
      )
        return;
      const job = await insertStatusScan(c, cfg);
      await c.query(
        "UPDATE order_status_configs SET next_run_at=now()+interval '60 seconds',last_job_id=coalesce($2,last_job_id) WHERE channel_id=$1",
        [cfg.channel_id, job.id],
      );
    });
}
export async function processStatusScan(job: any, ctx: IntegrationContext = {}) {
  ctx = withAllegroJobContext(ctx, job);
  const actor = await systemActor(job.tenant_id, job.payload.actor_id);
  const ch = await loadChannel(actor.tenantId, job.payload.channel_id);
  await tenantTx(actor.tenantId, (c) => policy(c, actor, ch, job.payload.version));
  const rows = await tenantTx(actor.tenantId, async (c) => {
    const localGuard = (await localFinancialFencesAvailable(c))
      ? LOCAL_FINANCIAL_SELECTION_SQL
      : '';
    return (
      await c.query(
        `SELECT o.id,o.version FROM orders o WHERE channel_id=$1 AND external_id IS NOT NULL AND id>coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid) AND status IN ('paid','picking','packed','shipped','delivered','completed','cancelled') AND NOT (status='paid' AND payment_mode='cod') ${localGuard} AND NOT EXISTS(SELECT 1 FROM order_status_plans p WHERE p.tenant_id=o.tenant_id AND p.order_id=o.id AND p.local_version=o.version AND p.config_version=$4 AND p.state<>'preview') AND NOT EXISTS(SELECT 1 FROM order_status_plans p WHERE p.tenant_id=o.tenant_id AND p.order_id=o.id AND ((p.state='queued' AND (p.phase<>'ready' OR p.config_version IS NULL)) OR (p.state='failed' AND p.phase IN ('write_started','verify')))) ORDER BY id LIMIT $3`,
        [ch.id, job.payload.after ?? null, STATUS_BATCH + 1, job.payload.version],
      )
    ).rows;
  });
  const stats = { ...job.payload.stats };
  let after = job.payload.after;
  for (const o of rows.slice(0, STATUS_BATCH)) {
    if (!(await tenantTx(actor.tenantId, (c) => fenceSync(c, job, true)))) return;
    // Coalesce only automatic plans that have never been dispatched. A manual plan keeps its operator decision.
    await tenantTx(actor.tenantId, async (c) => {
      const current = await statusOrder(c, o.id, true);
      const channel = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
        .rows[0];
      await policy(c, actor, channel, job.payload.version);
      if (!(await fenceSync(c, job, true))) return;
      const outdated = (
        await c.query(
          "SELECT id,job_id FROM order_status_plans WHERE order_id=$1 AND state='queued' AND phase='ready' AND config_version IS NOT NULL AND local_version<>$2",
          [o.id, current.version],
        )
      ).rows;
      for (const old of outdated) {
        await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [old.job_id]);
        const changed = await c.query(
          "UPDATE order_status_plans SET state='conflict',error='Nowsza wersja zamówienia zastąpiła niewysłany plan automatyczny',updated_at=now() WHERE id=$1 AND state='queued' AND phase='ready' RETURNING id",
          [old.id],
        );
        if (changed.rowCount)
          await c.query(
            "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Zastąpiono nowszą wersją zamówienia' WHERE id=$1 AND state IN ('pending','running')",
            [old.job_id],
          );
      }
    });
    const existing = await tenantTx(
      actor.tenantId,
      async (c) =>
        (
          await c.query(
            "SELECT id FROM order_status_plans WHERE order_id=$1 AND (local_version=$2 AND config_version=$3 OR state='queued' OR state='failed' AND phase IN ('write_started','verify')) ORDER BY created_at DESC LIMIT 1",
            [o.id, o.version, job.payload.version],
          )
        ).rows[0],
    );
    stats.checked++;
    if (existing) stats.skipped++;
    else
      try {
        const auto = { job, version: job.payload.version };
        const p = await previewStatus(actor, o.id, ctx, auto);
        await queueStatus(actor, p.id, true, auto);
        stats.queued++;
      } catch (e) {
        if (allegroOAuthCommitRefusalDetails(e)) throw e;
        if (e instanceof Problem && [403].includes(e.status)) throw e;
        stats.errors++;
        // Persist one error for this local revision; automatic cycles never spam the provider or retry a conflict.
        await tenantTx(actor.tenantId, async (c) => {
          const current = await statusOrder(c, o.id, true);
          const channel = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
            .rows[0];
          await policy(c, actor, channel, job.payload.version);
          if (!(await fenceSync(c, job, true))) return;
          await c.query(
            `INSERT INTO order_status_plans(id,tenant_id,order_id,channel_id,actor_id,local_version,local_status,target,connection_hash,remote,config_version,state,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}',$10,'conflict',$11)`,
            [
              randomUUID(),
              actor.tenantId,
              o.id,
              ch.id,
              actor.userId,
              o.version,
              current.status,
              (ch.provider === 'prestashop'
                ? psStatusMap(channel, false)
                : statusMappings[ch.provider])[current.status] ?? 'SKIPPED',
              statusConnection(channel),
              job.payload.version,
              message(e),
            ],
          );
        });
      }
    after = o.id;
  }
  await tenantTx(actor.tenantId, async (c) => {
    if (!(await fenceSync(c, job))) return;
    const more = rows.length > STATUS_BATCH;
    await c.query(
      "UPDATE jobs SET state=$2,payload=$3,attempts=CASE WHEN $2='pending' THEN 0 ELSE attempts END,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now() WHERE id=$1",
      [job.id, more ? 'pending' : 'done', JSON.stringify({ ...job.payload, after, stats })],
    );
    if (!more)
      await c.query(
        'UPDATE order_status_configs SET last_run_at=now(),last_job_id=$2,error=NULL WHERE channel_id=$1 AND version=$3',
        [ch.id, job.id, job.payload.version],
      );
  });
}
