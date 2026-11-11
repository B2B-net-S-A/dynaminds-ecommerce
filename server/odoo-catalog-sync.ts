import { emitCatalogProductEvents, type CatalogProductEvent } from './product-rule-events';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit, type Actor } from './domain';
import { importConnectionHash, importSourceHash } from './imports';
import { decrypt } from './security';
import { Odoo, odooId } from './odoo';
import { demoOdooCatalog, demoOdooContext, normalizeOdooCatalog } from './odoo-catalog';
import { safeFetch } from './integrations';
import type { IntegrationContext } from './channel-access';
const input = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    interval_minutes: z.number().int().min(30).max(10080),
    prices: z.boolean(),
    confirmed: z.boolean().default(false),
  })
  .strict();
const runInput = z.object({ version: z.number().int().positive(), client_key: z.uuid() }).strict();
async function channel(c: PoolClient, id: string) {
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(ch?.provider === 'odoo', 404, 'Nie znaleziono połączenia Odoo');
  return ch;
}
async function admin(c: PoolClient, user: string) {
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [user])).rows[0]?.ok,
    403,
    'Autor utracił rolę administratora',
  );
}
async function lockFirm(c: PoolClient, a: Actor) {
  // Short transactions commit before HTTP; catalogue precedes tenant/channel locks.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalog:' + a.tenantId]);
  await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [a.tenantId]);
}
async function cancel(c: PoolClient, id: string) {
  const r = (
    await c.query(
      "UPDATE odoo_catalog_sync_runs SET state='cancelled',finished_at=now(),error='Konfigurację harmonogramu zmieniono' WHERE channel_id=$1 AND state='queued' RETURNING id,job_id",
      [id],
    )
  ).rows;
  await c.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error='Konfigurację harmonogramu zmieniono' WHERE id=ANY($1::uuid[])",
    [r.map((x) => x.job_id)],
  );
}
export async function startOdooCatalogSync(
  c: PoolClient,
  a: Actor,
  id: string,
  b: z.infer<typeof runInput>,
) {
  await lockFirm(c, a);
  const ch = await channel(c, id),
    cfg = (
      await c.query('SELECT * FROM odoo_catalog_schedules WHERE channel_id=$1 FOR UPDATE', [id])
    ).rows[0];
  ensure(cfg && cfg.version === b.version, 409, 'Odśwież wersję harmonogramu');
  await admin(c, cfg.actor_id);
  const hash = importSourceHash({ version: b.version }),
    prior = (
      await c.query('SELECT * FROM odoo_catalog_sync_runs WHERE channel_id=$1 AND client_key=$2', [
        id,
        b.client_key,
      ])
    ).rows[0];
  if (prior) {
    ensure(prior.input_hash === hash, 409, 'Klucz ponowienia ma inną konfigurację');
    return { ...prior, replayed: true };
  }
  ensure(cfg.enabled, 409, 'Harmonogram jest wyłączony');
  ensure(
    importConnectionHash(ch) === cfg.connection_hash,
    409,
    'Połączenie zmieniło się; zapisz ponownie harmonogram',
  );
  ensure(
    !(
      await c.query("SELECT 1 FROM odoo_catalog_sync_runs WHERE channel_id=$1 AND state='queued'", [
        id,
      ])
    ).rowCount,
    409,
    'Kanał ma aktywny odczyt katalogu',
  );
  ensure(
    (await c.query("SELECT count(*)::int n FROM jobs WHERE (state='pending' OR state='running')")).rows[0]
      .n < 1000,
    409,
    'Kolejka firmy jest pełna',
  );
  const count = (
    await c.query(
      "SELECT count(*)::int n FROM listings l JOIN products p ON(p.tenant_id,p.id)=(l.tenant_id,l.product_id) WHERE l.channel_id=$1 AND p.kind<>'group'",
      [id],
    )
  ).rows[0].n;
  ensure(count > 0 && count <= 100000, 422, 'Harmonogram wymaga 1–100000 powiązanych wariantów');
  const rid = randomUUID(),
    jid = randomUUID();
  const run = (
    await c.query(
      'INSERT INTO odoo_catalog_sync_runs(id,tenant_id,channel_id,actor_id,schedule_version,client_key,input_hash,connection_hash,prices,simulation,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [
        rid,
        a.tenantId,
        id,
        cfg.actor_id,
        cfg.version,
        b.client_key,
        hash,
        cfg.connection_hash,
        cfg.prices,
        !!ch.settings.simulation,
        count,
      ],
    )
  ).rows[0];
  const captured = await c.query(
    "INSERT INTO odoo_catalog_sync_items(id,tenant_id,run_id,listing_id,product_id,external_id,product_version,vat,local_currency) SELECT gen_random_uuid(),l.tenant_id,$2,l.id,p.id,l.external_id,p.version,p.vat,t.currency FROM listings l JOIN products p ON(p.tenant_id,p.id)=(l.tenant_id,l.product_id) JOIN tenants t ON t.id=l.tenant_id WHERE l.channel_id=$1 AND p.kind<>'group'",
    [id, rid],
  );
  ensure(captured.rowCount && captured.rowCount <= 100000, 422, 'Przekroczono zakres wariantów');
  run.total = captured.rowCount;
  await c.query('UPDATE odoo_catalog_sync_runs SET total=$2 WHERE id=$1', [rid, run.total]);
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'odoo.catalog.sync',$3,$4)",
    [jid, a.tenantId, JSON.stringify({ run_id: rid }), `odoo-catalog:${rid}`],
  );
  await c.query('UPDATE odoo_catalog_sync_runs SET job_id=$2 WHERE id=$1', [rid, jid]);
  await c.query(
    'UPDATE odoo_catalog_schedules SET last_run_id=$2,last_finished_at=NULL,error=NULL,next_at=now()+make_interval(mins=>interval_minutes),updated_at=now() WHERE channel_id=$1',
    [id, rid],
  );
  await audit(c, a, 'odoo.catalog.sync.queue', rid, {
    channel_id: id,
    prices: cfg.prices,
    mapped_variants: count,
    scope: ch.settings.simulation ? 'local_simulation' : 'external_read_local_write',
  });
  return { ...run, job_id: jid };
}
export async function scheduleOdooCatalogDue() {
  await pool.query(
    `UPDATE odoo_catalog_schedules s SET last_finished_at=r.finished_at,next_at=r.finished_at+make_interval(mins=>s.interval_minutes),error=r.error,updated_at=now() FROM odoo_catalog_sync_runs r WHERE s.enabled AND(s.tenant_id,s.last_run_id)=(r.tenant_id,r.id) AND s.version=r.schedule_version AND r.state<>'queued' AND r.finished_at IS NOT NULL AND s.last_finished_at IS DISTINCT FROM r.finished_at`,
  );
  const due = (
    await pool.query(
      'SELECT tenant_id,channel_id FROM odoo_catalog_schedules WHERE enabled AND next_at<=now() ORDER BY next_at,channel_id LIMIT 20',
    )
  ).rows;
  for (const d of due)
    await tenantTx(d.tenant_id, async (c) => {
      const a: Actor = { tenantId: d.tenant_id, userId: '', role: 'admin' };
      await lockFirm(c, a);
      await channel(c, d.channel_id);
      const cfg = (
        await c.query(
          'SELECT * FROM odoo_catalog_schedules WHERE channel_id=$1 AND enabled AND next_at<=now() FOR UPDATE',
          [d.channel_id],
        )
      ).rows[0];
      if (
        !cfg ||
        (
          await c.query(
            "SELECT 1 FROM odoo_catalog_sync_runs WHERE channel_id=$1 AND state='queued'",
            [d.channel_id],
          )
        ).rowCount
      )
        return;
      a.userId = cfg.actor_id;
      try {
        await c.query('SAVEPOINT odoo_catalog_enqueue');
        await startOdooCatalogSync(c, a, d.channel_id, {
          version: cfg.version,
          client_key: randomUUID(),
        });
        await c.query('RELEASE SAVEPOINT odoo_catalog_enqueue');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT odoo_catalog_enqueue');
        await c.query('RELEASE SAVEPOINT odoo_catalog_enqueue');
        if (!(e instanceof Problem)) throw e;
        const terminal = e.message !== 'Kolejka firmy jest pełna';
        await c.query(
          "UPDATE odoo_catalog_schedules SET enabled=CASE WHEN $2 THEN false ELSE enabled END,next_at=CASE WHEN $2 THEN NULL ELSE now()+interval '1 minute' END,error=$3,version=version+CASE WHEN $2 THEN 1 ELSE 0 END WHERE channel_id=$1",
          [d.channel_id, terminal, e.message],
        );
      }
    });
}
async function guard(c: PoolClient, job: any, renew = false) {
  const a = { tenantId: job.tenant_id, userId: '', role: 'admin' } as Actor;
  await lockFirm(c, a);
  const pointer = (
    await c.query('SELECT channel_id FROM odoo_catalog_sync_runs WHERE id=$1', [job.payload.run_id])
  ).rows[0];
  if (!pointer) return null;
  const ch = await channel(c, pointer.channel_id),
    cfg = (
      await c.query('SELECT * FROM odoo_catalog_schedules WHERE channel_id=$1 FOR UPDATE', [ch.id])
    ).rows[0],
    run = (
      await c.query('SELECT * FROM odoo_catalog_sync_runs WHERE id=$1 FOR UPDATE', [
        job.payload.run_id,
      ])
    ).rows[0];
  const lease = (
    await c.query(
      "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
      [job.id, job.lease_token],
    )
  ).rows[0];
  if (!lease) return null;
  if (run.state !== 'queued') {
    await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
      job.id,
    ]);
    return null;
  }
  const authorized = (await c.query('SELECT offer_sync_is_admin($1) ok', [run.actor_id])).rows[0]
    ?.ok;
  if (
    !authorized ||
    !cfg?.enabled ||
    cfg.version !== run.schedule_version ||
    cfg.actor_id !== run.actor_id ||
    importConnectionHash(ch) !== run.connection_hash
  ) {
    await c.query(
      "UPDATE odoo_catalog_sync_runs SET state='cancelled',finished_at=now(),error='Zatrzymano po zmianie roli, konfiguracji, klucza lub pauzie' WHERE id=$1",
      [run.id],
    );
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error='Odczyt katalogu Odoo zatrzymano' WHERE id=$1",
      [job.id],
    );
    return null;
  }
  if (renew) await c.query('UPDATE jobs SET locked_at=now() WHERE id=$1', [job.id]);
  return { ch, cfg, run };
}
export async function processOdooCatalogSync(job: any, ctx: IntegrationContext = {}) {
  const initial = await tenantTx(job.tenant_id, async (c) => {
    const v = await guard(c, job, true);
    if (!v) return null;
    const items = (
      await c.query(
        "SELECT * FROM odoo_catalog_sync_items WHERE run_id=$1 AND state='pending' ORDER BY id LIMIT 50",
        [v.run.id],
      )
    ).rows;
    return { ...v, items };
  });
  if (!initial) return;
  const { ch, run, items } = initial;
  const fence = async () =>
    ensure(
      await tenantTx(job.tenant_id, (c) => guard(c, job, true)),
      409,
      'Odczyt katalogu Odoo zatrzymano',
    );
  const ids = items.map((i) => odooId(i.external_id));
  const result = ch.settings.simulation
    ? { data: demoOdooCatalog().filter((r) => ids.includes(r.id)), context: demoOdooContext }
    : await new Odoo(
        ch.settings,
        decrypt(ch.credentials),
        ctx.transport ?? safeFetch,
      ).catalogVariants(ids, fence);
  ensure(result.data.length === items.length, 422, 'Brak wariantów objętych harmonogramem');
  ensure(
    !run.context || isDeepStrictEqual(result.context, run.context),
    409,
    'Zakres firmy/magazynu/waluty/jednostki ERP zmienił się',
  );
  await tenantTx(job.tenant_id, async (c) => {
    const v = await guard(c, job);
    if (!v) return;
    const actor: Actor = { tenantId: job.tenant_id, userId: run.actor_id, role: 'admin' };
    const productEvents: CatalogProductEvent[] = [];
    let pageApplied = 0,
      pageSkipped = 0;
    for (const item of items) {
      const current = (
        await c.query(
          "SELECT * FROM odoo_catalog_sync_items WHERE id=$1 AND state='pending' FOR UPDATE",
          [item.id],
        )
      ).rows[0];
      if (!current) continue;
      let error: string | null = null,
        out: any = null;
      const listing = (
          await c.query('SELECT * FROM listings WHERE id=$1 FOR UPDATE', [item.listing_id])
        ).rows[0],
        product = (
          await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [item.product_id])
        ).rows[0],
        currency = (await c.query('SELECT currency FROM tenants WHERE id=$1', [job.tenant_id]))
          .rows[0].currency;
      try {
        ensure(
          listing?.channel_id === ch.id &&
            listing.product_id === item.product_id &&
            listing.external_id === item.external_id,
          409,
          'Powiązanie wariantu zmieniło się',
        );
        ensure(
          product &&
            product.kind !== 'group' &&
            product.active &&
            product.version === item.product_version &&
            product.vat === item.vat &&
            currency === item.local_currency,
          409,
          'Lokalny produkt, VAT lub waluta zmieniły się',
        );
        const raw = result.data.find((r) => String(r.id) === item.external_id);
        ensure(raw, 422, 'Niepełna odpowiedź wariantu');
        const n = normalizeOdooCatalog(raw, {
          channel_id: ch.id,
          vat: item.vat,
          context: result.context,
        }).source;
        ensure(
          !n.unsupported && raw.is_storable === true && n.quantity !== null && n.price !== null,
          422,
          'Wariant wymaga ręcznej kontroli ceny/jednostki/dostępności',
        );
        ensure(
          !run.prices || n.currency === currency,
          422,
          'Automatyczna cena wymaga tej samej waluty; bez FX',
        );
        out = {
          scope: run.simulation ? 'local_simulation' : 'external_read_local_write',
          external_id: item.external_id,
          erp: n.erp,
          availability: n.quantity,
          currency: n.currency,
          price: n.price,
          vat: item.vat,
          prices_include_tax: result.context.prices_include_tax,
          local_price_before: product.price,
          local_price_after: run.prices ? n.price : product.price,
          physical_stock_changed: false,
        };
        if (run.prices && product.price !== n.price) {
          await c.query('UPDATE products SET price=$2,version=version+1 WHERE id=$1', [
            product.id,
            n.price,
          ]);
          productEvents.push({
            product_id: product.id,
            event: 'product.updated',
            cause_id: item.id,
          });
          await audit(c, actor, 'product.price.erp', product.id, {
            run_id: run.id,
            before: product.price,
            after: n.price,
            currency,
          });
        }
        await c.query(
          "UPDATE listings SET price=$2,price_currency=$3,last_result=coalesce(last_result,'{}'::jsonb)||$4::jsonb WHERE id=$1",
          [
            listing.id,
            n.price,
            n.currency,
            JSON.stringify({
              stock_quantity: n.quantity,
              odoo_catalog_sync: { ...out, run_id: run.id, observed_at: new Date().toISOString() },
              stock_scope: 'external_availability',
            }),
          ],
        );
      } catch (e) {
        if (!(e instanceof Problem)) throw e;
        error = e.message;
      }
      if (error) pageSkipped++;
      else pageApplied++;
      await c.query(
        'UPDATE odoo_catalog_sync_items SET state=$2,result=$3,error=$4,captured_at=now() WHERE id=$1',
        [item.id, error ? 'skipped' : 'applied', out ? JSON.stringify(out) : null, error],
      );
    }
    await emitCatalogProductEvents(c, actor, productEvents);
    const counts = {
      applied: v.run.applied + pageApplied,
      skipped: v.run.skipped + pageSkipped,
      pending: v.run.total - v.run.applied - v.run.skipped - pageApplied - pageSkipped,
    };
    ensure(
      counts.pending >= 0 && (items.length > 0 || counts.pending === 0),
      409,
      'Brak postępu zakresu katalogu',
    );
    const done = counts.pending === 0,
      state = done ? (counts.skipped ? 'partial' : 'success') : 'queued',
      error = done && counts.skipped ? `Pominięte warianty: ${counts.skipped}` : null;
    await c.query(
      'UPDATE odoo_catalog_sync_runs SET state=$2,context=$3,applied=$4,skipped=$5,error=$6,finished_at=CASE WHEN $7 THEN now() ELSE NULL END WHERE id=$1',
      [run.id, state, JSON.stringify(result.context), counts.applied, counts.skipped, error, done],
    );
    await c.query(
      "UPDATE jobs SET state=$2,attempts=0,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now()+interval '1 second' WHERE id=$1",
      [job.id, done ? 'done' : 'pending'],
    );
    if (done)
      await c.query(
        'UPDATE odoo_catalog_schedules SET last_finished_at=now(),next_at=now()+make_interval(mins=>interval_minutes),error=$2,updated_at=now() WHERE channel_id=$1 AND version=$3',
        [ch.id, error, run.schedule_version],
      );
    await audit(c, actor, 'odoo.catalog.sync.page', run.id, {
      count: items.length,
      ...counts,
      state,
    });
  });
}
export async function failOdooCatalogSync(job: any, e: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    const v = await guard(c, job);
    if (!v) return;
    const message = e instanceof Problem ? e.message : 'Odczyt katalogu Odoo nie powiódł się';
    const retry =
      !(e instanceof Problem) ||
      e.status === 502 ||
      e.status === 429 ||
      e.status === 503 ||
      (e.status === 409 && /podczas odczytu|podczas pobierania/.test(e.message));
    const pending = retry && job.attempts < job.max_attempts;
    await c.query(
      "UPDATE jobs SET state=$2,lease_token=NULL,locked_at=NULL,error=$3,run_at=now()+interval '15 seconds' WHERE id=$1",
      [job.id, pending ? 'pending' : 'failed', message],
    );
    await c.query(
      "UPDATE odoo_catalog_sync_runs SET state=$2,error=$3,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1",
      [v.run.id, pending ? 'queued' : 'failed', message],
    );
  });
}
export function registerOdooCatalogSyncRoutes(app: FastifyInstance) {
  const id = (r: any) => z.object({ id: z.uuid() }).parse(r.params).id;
  const requireAdmin = (r: any) =>
    ensure(r.actor.role === 'admin', 403, 'Wymagana rola administratora');
  app.get('/api/integrations/:id/odoo-catalog-sync', (r) => {
    requireAdmin(r);
    return tenantTx(r.actor.tenantId, async (c) => {
      const ch = (
        await c.query(
          "SELECT id,name,provider,settings FROM channels WHERE id=$1 AND provider='odoo'",
          [id(r)],
        )
      ).rows[0];
      ensure(ch, 404, 'Nie znaleziono Odoo');
      return {
        channel: { id: ch.id, name: ch.name, simulation: !!ch.settings.simulation },
        config:
          (await c.query('SELECT * FROM odoo_catalog_schedules WHERE channel_id=$1', [ch.id]))
            .rows[0] ?? null,
        runs: (
          await c.query(
            'SELECT * FROM odoo_catalog_sync_runs WHERE channel_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',
            [ch.id],
          )
        ).rows,
      };
    });
  });
  app.put('/api/integrations/:id/odoo-catalog-sync', (r) => {
    requireAdmin(r);
    const b = input.parse(r.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      await lockFirm(c, r.actor);
      const ch = await channel(c, id(r));
      await admin(c, r.actor.userId);
      ensure(
        !b.enabled || !b.prices || b.confirmed,
        422,
        'Potwierdź automatyczną zmianę lokalnych cen',
      );
      const cfg = (
        await c.query('SELECT * FROM odoo_catalog_schedules WHERE channel_id=$1 FOR UPDATE', [
          ch.id,
        ])
      ).rows[0];
      ensure((cfg?.version ?? 0) === b.version, 409, 'Konfigurację zmieniono; odśwież podgląd');
      await cancel(c, ch.id);
      const saved = (
        await c.query(
          'INSERT INTO odoo_catalog_schedules(tenant_id,channel_id,actor_id,version,enabled,interval_minutes,prices,connection_hash,next_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,CASE WHEN $4 THEN now() ELSE NULL END) ON CONFLICT(tenant_id,channel_id) DO UPDATE SET actor_id=EXCLUDED.actor_id,version=odoo_catalog_schedules.version+1,enabled=EXCLUDED.enabled,interval_minutes=EXCLUDED.interval_minutes,prices=EXCLUDED.prices,connection_hash=EXCLUDED.connection_hash,next_at=EXCLUDED.next_at,error=NULL,updated_at=now() RETURNING *',
          [
            r.actor.tenantId,
            ch.id,
            r.actor.userId,
            b.enabled,
            b.interval_minutes,
            b.prices,
            importConnectionHash(ch),
          ],
        )
      ).rows[0];
      await audit(c, r.actor, 'odoo.catalog.schedule.save', ch.id, {
        version: saved.version,
        enabled: b.enabled,
        prices: b.prices,
        physical_stock: false,
      });
      return saved;
    });
  });
  app.post('/api/integrations/:id/odoo-catalog-sync', (r) => {
    requireAdmin(r);
    const b = runInput.parse(r.body);
    return tenantTx(r.actor.tenantId, (c) => startOdooCatalogSync(c, r.actor, id(r), b));
  });
  app.get('/api/odoo-catalog-sync-runs/:id', (r) => {
    requireAdmin(r);
    const q = z
      .object({
        after: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(r.query);
    return tenantTx(r.actor.tenantId, async (c) => {
      const run = (await c.query('SELECT * FROM odoo_catalog_sync_runs WHERE id=$1', [id(r)]))
        .rows[0];
      ensure(run, 404, 'Nie znaleziono odczytu');
      const rows = (
        await c.query(
          'SELECT i.*,p.sku FROM odoo_catalog_sync_items i JOIN products p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE i.run_id=$1 AND($2::uuid IS NULL OR i.id>$2) ORDER BY i.id LIMIT $3',
          [run.id, q.after ?? null, q.limit + 1],
        )
      ).rows;
      return {
        run,
        data: rows.slice(0, q.limit),
        next_cursor: rows.length > q.limit ? rows[q.limit - 1].id : null,
      };
    });
  });
}
