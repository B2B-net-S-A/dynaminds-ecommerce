import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { orderMergeOriginalCommerceInTx, resolveOrderMergeOwnerInTx } from './order-merge-payments';
import { ensure, Problem } from './errors';
import { channelRead, loadChannel, withAllegroJobContext, type IntegrationContext } from './channel-access';
import { WooCommerce, Allegro, PrestaShop } from './integrations';
import { allegroPaymentAmount, normalizeOrder } from './imports';
import { commerceHash, statusConnection } from './order-status';
import { appendPayment, advancePaid } from './payments';
import { systemActor } from './sync';
async function lockedSourceOrder(c: PoolClient, id: string) {
  const owner = await resolveOrderMergeOwnerInTx(c, id);
  await c.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [owner]);
  ensure(
    (await resolveOrderMergeOwnerInTx(c, id)) === owner,
    409,
    'Właściciel płatności zmienił się; odczytaj ponownie',
  );
  const current = (await c.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
  ensure(current, 404, 'Nie znaleziono zamówienia');
  const original = await orderMergeOriginalCommerceInTx(c, id);
  return { ...current, ...original.header, version: current.version };
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const sourceProviders = ['woocommerce', 'allegro', 'prestashop'];
export async function sourceTotals(c: PoolClient, id: string) {
  const v = (
    await c.query(
      `SELECT
    coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='receipt' AND coalesce(r.method,p.method) IN ('source_import','source_sync')),0)::bigint AS source,
    coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind) IN ('receipt','courier_collection') AND coalesce(r.method,p.method) NOT IN ('source_import','source_sync')),0)::bigint AS manual,
    bool_or(p.kind='reversal' AND r.method IN ('source_import','source_sync')) AS corrected
    FROM payment_entries p LEFT JOIN payment_entries r ON r.id=p.reversal_of WHERE p.order_id=$1`,
      [id],
    )
  ).rows[0];
  ensure(
    [v.source, v.manual].every((x) => Number.isSafeInteger(Number(x)) && Number(x) >= 0),
    409,
    'Nieprawidłowe saldo źródła',
  );
  return { amount: Number(v.source), manual: Number(v.manual), corrected: Boolean(v.corrected) };
}
function sourceValue(ch: any, o: any, raw: any) {
  const n = normalizeOrder(ch.provider, raw, ch.settings);
  ensure(
    commerceHash(n) === commerceHash(o, o.source_snapshot.items),
    409,
    'Zmieniły się pozycje, kwoty, tryb lub odbiorca zamówienia',
  );
  ensure(o.payment_mode === 'prepaid', 409, 'Pobranie rozlicza się osobno z kurierem');
  if (ch.provider === 'woocommerce') {
    ensure(
      !['refunded', 'cancelled', 'failed'].includes(raw.status) && !(raw.refunds ?? []).length,
      409,
      'Źródło zawiera anulowanie lub refundację; wymagane uzgodnienie',
    );
    return { amount: n.paid_amount, basis: 'WooCommerce date_paid — deklaracja pełnej wpłaty' };
  }
  if (ch.provider === 'allegro') {
    ensure(
      raw.status === 'READY_FOR_PROCESSING' && raw.fulfillment?.provider?.id !== 'ALLEGRO',
      409,
      'Formularz Allegro nie jest gotowy lub jest obsługiwany przez One Fulfillment',
    );
    return {
      amount: allegroPaymentAmount(raw, o.currency),
      basis: 'Allegro paidAmount + zakończone surcharges',
    };
  }
  ensure(
    !(raw._dyna?.details ?? []).some(
      (x: any) =>
        Number(x.product_quantity_refunded) > 0 ||
        Number(x.product_quantity_return) > 0 ||
        Number(x.total_refunded_tax_incl) > 0,
    ),
    409,
    'PrestaShop zawiera zwrot; wymagane uzgodnienie',
  );
  ensure(
    !['1', 1, true].includes(raw._dyna?.state?.deleted),
    409,
    'Zamówienie PrestaShop jest usunięte',
  );
  return { amount: n.paid_amount, basis: 'PrestaShop total_paid_real — deklaracja kwoty wpłat' };
}
async function configuration(c: PoolClient, channel: string, lock = false) {
  return (
    await c.query(
      'SELECT * FROM source_payment_configs WHERE channel_id=$1' + (lock ? ' FOR SHARE' : ''),
      [channel],
    )
  ).rows[0];
}
async function authorized(c: PoolClient, job: any, ch: any, lock = false) {
  const cfg = await configuration(c, ch.id, lock);
  return (
    statusConnection(ch) === job.payload.connection_hash &&
    (!job.payload.automatic ||
      Boolean(
        cfg?.enabled &&
        cfg.version === job.payload.config_version &&
        cfg.actor_id === job.payload.actor_id &&
        cfg.connection_hash === statusConnection(ch) &&
        (ch.settings.simulation || cfg.external_authorized),
      ))
  );
}
export async function queueSourceRead(
  c: PoolClient,
  a: Actor,
  id: string,
  ch: any,
  automatic = false,
  cfg?: any,
) {
  ensure(a.role === 'admin', 403, 'Wymagana rola administratora');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'source-payments-queue:' + a.tenantId + ':' + ch.id,
  ]);
  const o = await lockedSourceOrder(c, id);
  ensure(
    sourceProviders.includes(ch.provider) &&
      o.channel_id === ch.id &&
      o.source === ch.provider &&
      o.source_snapshot?.items?.length,
    422,
    'Wymagane zamówienie zaimportowane z kanału',
  );
  const active = (
    await c.query(
      "SELECT id,state FROM jobs WHERE kind='payment.source.read' AND state IN ('pending','running') AND payload->>'order_id'=$1 LIMIT 1",
      [id],
    )
  ).rows[0];
  if (active) return { job_id: active.id, reused: true };
  const count = (
    await c.query(
      "SELECT count(*)::int AS n FROM jobs WHERE kind='payment.source.read' AND state IN ('pending','running') AND payload->>'channel_id'=$1",
      [ch.id],
    )
  ).rows[0].n;
  ensure(count < 100, 429, 'Kolejka płatności kanału ma 100 aktywnych odczytów');
  const jid = randomUUID();
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5)', [
    jid,
    a.tenantId,
    'payment.source.read',
    JSON.stringify({
      order_id: id,
      channel_id: ch.id,
      actor_id: a.userId,
      automatic,
      config_version: cfg?.version,
      connection_hash: statusConnection(ch),
    }),
    'payment.source:' + jid,
  ]);
  return { job_id: jid, reused: false };
}
export async function sourceHistory(c: PoolClient, id: string) {
  const o = (await c.query('SELECT id,channel_id FROM orders WHERE id=$1', [id])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  const ch = (
    await c.query('SELECT id,name,provider,mode,settings FROM channels WHERE id=$1', [o.channel_id])
  ).rows[0];
  const checks = (
    await c.query(
      'SELECT id,state,source_amount,previous_amount,delta,currency,basis,reason,order_version,created_at,applied_at,last_seen_at,seen_count FROM source_payment_checks WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 25',
      [id],
    )
  ).rows;
  const job =
    (
      await c.query(
        "SELECT id,state,error,attempts FROM jobs WHERE kind='payment.source.read' AND payload->>'order_id'=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [id],
      )
    ).rows[0] ?? null;
  return {
    channel: ch
      ? {
          id: ch.id,
          name: ch.name,
          provider: ch.provider,
          simulation: Boolean(ch.settings.simulation),
        }
      : null,
    data: checks,
    job,
    totals: await sourceTotals(c, id),
  };
}
export async function applySourceCheck(
  c: PoolClient,
  a: Actor,
  id: string,
  version: number,
  automatic = false,
) {
  ensure(a.role === 'admin', 403, 'Wymagana rola administratora');
  const ref = (await c.query('SELECT order_id FROM source_payment_checks WHERE id=$1', [id]))
    .rows[0];
  ensure(ref, 404, 'Nie znaleziono podglądu płatności');
  const o = await lockedSourceOrder(c, ref.order_id),
    p = (await c.query('SELECT * FROM source_payment_checks WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (p.state === 'applied') return { changed: false, order_id: o.id };
  ensure(p.state === 'review', 409, p.reason ?? 'Podgląd nie zawiera nowej wpłaty');
  ensure(
    (
      await c.query(
        "SELECT created_at>clock_timestamp()-interval '10 minutes' AS fresh FROM source_payment_checks WHERE id=$1",
        [id],
      )
    ).rows[0].fresh,
    409,
    'Podgląd płatności wygasł; odczytaj źródło ponownie',
  );
  const latest = (
    await c.query(
      'SELECT id FROM source_payment_checks WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
      [o.id],
    )
  ).rows[0];
  ensure(latest?.id === id, 409, 'Istnieje nowszy odczyt; odśwież podgląd płatności');
  ensure(
    Number(o.version) === version && Number(p.order_version) === version,
    409,
    'Zamówienie zmieniło się; odczytaj płatność ponownie',
  );
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [p.channel_id])).rows[0];
  ensure(ch && statusConnection(ch) === p.connection_hash, 409, 'Zmieniono połączenie kanału');
  const t = await sourceTotals(c, o.id);
  ensure(
    !t.corrected && t.manual === 0,
    409,
    'Ręczne wpłaty lub korekty źródła wymagają uzgodnienia',
  );
  ensure(
    t.amount === p.previous_amount &&
      p.source_amount > t.amount &&
      p.delta === p.source_amount - t.amount,
    409,
    'Saldo źródła zmieniło się; odczytaj płatność ponownie',
  );
  await appendPayment(
    c,
    a,
    o.id,
    'source-check:' + id,
    { check_id: id, amount: p.source_amount },
    {
      kind: 'receipt',
      amount: p.delta,
      currency: o.currency,
      method: 'source_sync',
      reference: ch.provider + ':' + o.external_id,
      note: p.basis + '; deklaracja z API, bez weryfikacji rachunku bankowego',
    },
  );
  await advancePaid(c, a, o.id);
  await c.query("UPDATE source_payment_checks SET state='applied',applied_at=now() WHERE id=$1", [
    id,
  ]);
  await audit(c, a, 'payment.source.apply', o.id, {
    check_id: id,
    delta: p.delta,
    source_amount: p.source_amount,
    automatic,
  });
  return { changed: true, order_id: o.id, amount: p.delta };
}
export async function processSourceRead(job: any, ctx: IntegrationContext = {}) {
  ctx = withAllegroJobContext(ctx, job);
  const a = await systemActor(job.tenant_id, job.payload.actor_id),
    ch = await loadChannel(job.tenant_id, job.payload.channel_id);
  const o = await tenantTx(a.tenantId, async (c) => {
    ensure(
      await authorized(c, job, ch),
      409,
      'Harmonogram płatności wyłączono lub zmieniono połączenie',
    );
    const current = (
      await c.query("SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running'", [
        job.id,
        job.lease_token,
      ])
    ).rows[0];
    if (!current) return null;
    return (await c.query('SELECT * FROM orders WHERE id=$1', [job.payload.order_id])).rows[0];
  });
  if (!o) return;
  const raw = ch.settings.simulation
    ? await tenantTx(
        a.tenantId,
        async (c) =>
          (
            await c.query('SELECT raw FROM inbound_orders WHERE order_id=$1 AND channel_id=$2', [
              o.id,
              ch.id,
            ])
          ).rows[0]?.raw,
      )
    : await channelRead(
        a.tenantId,
        ch.id,
        (client) =>
          client instanceof WooCommerce
            ? client.order(Number(o.external_id))
            : client instanceof PrestaShop
              ? client.order(o.external_id)
              : (client as Allegro).order(o.external_id),
        ctx,
        true,
        (current) =>
          ensure(
            statusConnection(current) === statusConnection(ch),
            409,
            'Zmieniono połączenie kanału',
          ),
      );
  await tenantTx(a.tenantId, async (c) => {
    const currentCh = (await c.query('SELECT * FROM channels WHERE id=$1', [ch.id])).rows[0];
    ensure(
      currentCh && (await authorized(c, job, currentCh, true)),
      409,
      'Harmonogram płatności wyłączono lub zmieniono połączenie',
    );
    if (
      !(
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rowCount
    )
      return;
    // Source config updates invalidate jobs, so config -> lease -> order -> current grant.
    const current = await lockedSourceOrder(c, o.id);
    const latestCh = (await c.query('SELECT * FROM channels WHERE id=$1', [ch.id])).rows[0];
    ensure(
      latestCh && statusConnection(latestCh) === statusConnection(currentCh),
      409,
      'Zmieniono połączenie kanału',
    );
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) AS ok', [a.userId])).rows[0].ok,
      403,
      'Administrator utracił uprawnienia',
    );
    const t = await sourceTotals(c, o.id);
    let amount: number | null = null,
      basis = '',
      reason: string | null = null,
      state = 'review';
    try {
      const v = sourceValue(currentCh, current, raw);
      amount = v.amount;
      basis = v.basis;
      ensure(
        amount >= t.amount,
        409,
        'Kwota w źródle spadła; nie utworzono automatycznej refundacji',
      );
      if (amount === t.amount) state = 'unchanged';
      else
        ensure(
          !t.corrected && t.manual === 0,
          409,
          'Ręczne wpłaty lub korekty źródła wymagają uzgodnienia',
        );
    } catch (e) {
      if (!(e instanceof Problem) && !(e instanceof Error && e.name === 'ZodError')) throw e;
      state = 'blocked';
      reason = e instanceof Problem ? e.message : 'Nieprawidłowe dane płatności kanału';
    }
    const id = randomUUID();
    const previous = (
      await c.query(
        'SELECT * FROM source_payment_checks WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
        [o.id],
      )
    ).rows[0];
    if (
      ['unchanged', 'blocked'].includes(state) &&
      previous?.state === state &&
      previous.source_hash === hash(raw) &&
      previous.source_amount === amount &&
      previous.previous_amount === t.amount &&
      previous.reason === reason &&
      Number(previous.order_version) === Number(current.version)
    ) {
      await c.query(
        'UPDATE source_payment_checks SET last_seen_at=clock_timestamp(),seen_count=seen_count+1 WHERE id=$1',
        [previous.id],
      );
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
        [job.id],
      );
      return;
    }
    await c.query(
      'INSERT INTO source_payment_checks(id,tenant_id,order_id,channel_id,job_id,state,source_amount,previous_amount,delta,currency,basis,reason,order_version,connection_hash,source_hash,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [
        id,
        a.tenantId,
        o.id,
        ch.id,
        job.id,
        state,
        amount,
        t.amount,
        amount === null ? null : amount - t.amount,
        current.currency,
        basis,
        reason,
        current.version,
        statusConnection(currentCh),
        hash(raw),
        a.userId,
      ],
    );
    if (state === 'review' && job.payload.automatic) {
      await c.query('SAVEPOINT source_payment_apply');
      try {
        await applySourceCheck(c, a, id, Number(current.version), true);
        state = 'applied';
        await c.query('RELEASE SAVEPOINT source_payment_apply');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT source_payment_apply');
        await c.query('RELEASE SAVEPOINT source_payment_apply');
        if (!(e instanceof Problem)) throw e;
        state = 'blocked';
        await c.query("UPDATE source_payment_checks SET state='blocked',reason=$2 WHERE id=$1", [
          id,
          e.message,
        ]);
      }
    }
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
      [job.id],
    );
    await audit(c, a, 'payment.source.read', o.id, {
      check_id: id,
      provider: ch.provider,
      automatic: job.payload.automatic,
      state,
    });
  });
}
export async function scheduleSourcePaymentsDue() {
  const rows = (
    await pool.query(
      'SELECT tenant_id,channel_id FROM source_payment_configs WHERE enabled AND next_at<=now() ORDER BY next_at LIMIT 20',
    )
  ).rows;
  for (const r of rows)
    await tenantTx(r.tenant_id, async (c) => {
      const cfg = (
        await c.query(
          'SELECT * FROM source_payment_configs WHERE channel_id=$1 FOR UPDATE SKIP LOCKED',
          [r.channel_id],
        )
      ).rows[0];
      if (!cfg?.enabled || new Date(cfg.next_at).getTime() > Date.now()) return;
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [r.channel_id])).rows[0];
      if (
        !ch ||
        cfg.connection_hash !== statusConnection(ch) ||
        (!ch.settings.simulation && !cfg.external_authorized)
      ) {
        await c.query(
          "UPDATE source_payment_configs SET enabled=false,error='Zmieniono połączenie lub uprawnienia autora' WHERE channel_id=$1",
          [r.channel_id],
        );
        return;
      }
      // Keep queue admission ahead of order locks; queueSourceRead reuses this same lock.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'source-payments-queue:' + r.tenant_id + ':' + ch.id,
      ]);
      const active = (
        await c.query(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='payment.source.read' AND state IN ('pending','running') AND payload->>'channel_id'=$1",
          [ch.id],
        )
      ).rows[0].n;
      if (active >= 75) {
        await c.query(
          "UPDATE source_payment_configs SET next_at=now()+interval '30 seconds' WHERE channel_id=$1",
          [ch.id],
        );
        return;
      }
      const orders = (
        await c.query(
          "SELECT id FROM orders WHERE channel_id=$1 AND payment_mode='prepaid' AND source_snapshot IS NOT NULL AND external_id IS NOT NULL AND created_at>=now()-interval '90 days' AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 26 FOR UPDATE",
          [ch.id, cfg.cursor],
        )
      ).rows;
      if (!(await c.query('SELECT offer_sync_is_admin($1) AS ok', [cfg.actor_id])).rows[0].ok) {
        await c.query(
          "UPDATE source_payment_configs SET enabled=false,error='Zmieniono połączenie lub uprawnienia autora' WHERE channel_id=$1",
          [ch.id],
        );
        return;
      }
      for (const o of orders.slice(0, 25))
        await queueSourceRead(
          c,
          { tenantId: r.tenant_id, userId: cfg.actor_id, role: 'admin' },
          o.id,
          ch,
          true,
          cfg,
        );
      await c.query(
        'UPDATE source_payment_configs SET cursor=$2,next_at=now()+make_interval(secs=>$3),error=NULL WHERE channel_id=$1',
        [
          ch.id,
          orders.length > 25 ? orders[24].id : null,
          orders.length > 25 ? 1 : cfg.interval_seconds,
        ],
      );
    });
}
export async function failSourceRead(job: any, e: unknown) {
  const reason = e instanceof Problem ? e.message : 'Błąd odczytu płatności kanału';
  const terminal = e instanceof Problem && [403, 404, 409, 422].includes(e.status);
  await tenantTx(job.tenant_id, (c) =>
    c.query(
      "UPDATE jobs SET state=CASE WHEN $4 OR attempts>=max_attempts THEN 'failed' ELSE 'pending' END,error=$2,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1 AND lease_token=$3",
      [job.id, reason, job.lease_token, terminal],
    ),
  );
}
