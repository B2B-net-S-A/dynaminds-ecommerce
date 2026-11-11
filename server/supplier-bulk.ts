import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx, pool } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { decrypt } from './security';
import { systemActor } from './sync';
import { safeFetch } from './integrations';
import {
  BigBuy,
  BigBuyRetry,
  bigbuyId,
  bigbuyBulkResources,
  normalizeBigBuy,
  type BigBuyBulkResource,
} from './bigbuy';
import {
  supplierSource,
  supplierSourceConnection,
  supplierConnection,
  reserveBigBuySlot,
} from './supplier-catalog';
import type { IntegrationContext } from './channel-access';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const bulkInput = z
  .object({
    client_key: z.uuid(),
    page_size: z.number().int().min(1).max(10000).default(10000),
    taxonomy: bigbuyId.optional(),
  })
  .strict();
export async function startSupplierBulk(
  c: PoolClient,
  a: Actor,
  sourceId: string,
  b: z.infer<typeof bulkInput>,
) {
  const s = await supplierSource(c, sourceId, true),
    ch = await supplierSourceConnection(c, s),
    inputHash = hash(b);
  ensure(ch.provider === 'bigbuy', 422, 'Źródło plikowe odśwież przez podgląd CSV/XML');
  const prior = (
    await c.query(
      'SELECT id,state,input_hash FROM supplier_bulk_runs WHERE source_id=$1 AND client_key=$2',
      [sourceId, b.client_key],
    )
  ).rows[0];
  if (prior) {
    ensure(prior.input_hash === inputHash, 409, 'Klucz masowego odczytu ma inne dane');
    return { id: prior.id, state: prior.state, replayed: true };
  }
  ensure(
    !(
      await c.query("SELECT id FROM supplier_bulk_runs WHERE source_id=$1 AND state='queued'", [
        sourceId,
      ])
    ).rowCount,
    409,
    'Masowy odczyt źródła już trwa',
  );
  const id = randomUUID(),
    job = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'supplier.bulk',$3,$4)",
    [job, a.tenantId, JSON.stringify({ bulk_id: id, actor_id: a.userId }), 'supplier.bulk:' + id],
  );
  await c.query(
    'INSERT INTO supplier_bulk_runs(id,tenant_id,source_id,actor_id,client_key,input_hash,connection_hash,taxonomy,page_size,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      id,
      a.tenantId,
      sourceId,
      a.userId,
      b.client_key,
      inputHash,
      supplierConnection(s, ch),
      b.taxonomy ?? null,
      b.page_size,
      job,
    ],
  );
  await audit(c, a, 'supplier.bulk.queued', id, {
    source_id: sourceId,
    page_size: b.page_size,
    taxonomy: b.taxonomy ?? null,
  });
  return { id, state: 'queued' };
}
async function fenced(c: PoolClient, job: any) {
  const peek = (
    await c.query('SELECT source_id FROM supplier_bulk_runs WHERE id=$1', [job.payload.bulk_id])
  ).rows[0];
  if (!peek) return null;
  const s = await supplierSource(c, peek.source_id, true),
    r = (
      await c.query('SELECT * FROM supplier_bulk_runs WHERE id=$1 FOR UPDATE', [
        job.payload.bulk_id,
      ])
    ).rows[0];
  if (!r || r.state !== 'queued' || r.job_id !== job.id) return null;
  if (r.schedule_version != null) {
    const cfg = (
      await c.query('SELECT enabled,version,actor_id FROM supplier_schedules WHERE source_id=$1', [
        r.source_id,
      ])
    ).rows[0];
    ensure(
      cfg?.enabled && cfg.version === r.schedule_version && cfg.actor_id === r.actor_id,
      409,
      'Harmonogram lub jego autor zmienił się',
    );
  }
  if (
    !(
      await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rowCount
  )
    return null;
  const ch = await supplierSourceConnection(c, s);
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [r.actor_id])).rows[0].ok,
    403,
    'Administrator utracił prawo pobierania hurtowni',
  );
  ensure(
    supplierConnection(s, ch) === r.connection_hash,
    409,
    'Połączenie lub ustawienia hurtowni zmieniły się; rozpocznij nowy odczyt',
  );
  return { r, s, ch };
}
async function defer(
  c: PoolClient,
  job: any,
  seconds = 0,
  error: string | null = null,
  reset = true,
) {
  await c.query(
    "UPDATE jobs SET state='pending',lease_token=NULL,locked_at=NULL,attempts=CASE WHEN $4 THEN 0 ELSE attempts END,run_at=now()+make_interval(secs=>$2),error=$3 WHERE id=$1",
    [job.id, seconds, error, reset],
  );
}
export async function processSupplierBulk(job: any, ctx: IntegrationContext = {}) {
  const actor = await systemActor(job.tenant_id, job.payload.actor_id),
    state = await tenantTx(job.tenant_id, (c) => fenced(c, job));
  if (!state) return;
  const { r, s, ch } = state;
  if (r.phase !== 'fetch') {
    await tenantTx(job.tenant_id, async (c) => {
      const current = await fenced(c, job);
      if (!current) return;
      await assemble(c, actor, job, current);
    });
    return;
  }
  const resource = bigbuyBulkResources[r.resource_index],
    cursor = r.cursors[resource] ?? { page: 0, rows: 0, done: false };
  ensure(resource && !cursor.done, 409, 'Nieprawidłowy checkpoint katalogu');
  const creds = decrypt(ch.credentials),
    rateKey = hash([ch.mode, creds.api_key]);
  job.supplier_rate_key = rateKey;
  if (!ch.settings.simulation) {
    const delay = await reserveBigBuySlot(
      rateKey,
      resource,
      resource === 'productsinformation' ? 151 : 361,
    );
    if (delay) {
      await tenantTx(job.tenant_id, async (c) => {
        if (await fenced(c, job)) {
          await c.query('UPDATE jobs SET attempts=greatest(0,attempts-1) WHERE id=$1', [job.id]);
          await defer(c, job, delay, null, false);
        }
      });
      return;
    }
  }
  const data = ch.settings.simulation
    ? bulkDemoPage(resource, cursor.page, r.page_size)
    : await new BigBuy(ch.mode, creds, ctx.transport ?? safeFetch).bulk(
        resource,
        cursor.page,
        r.page_size,
        s.language,
        r.taxonomy,
      );
  const rows = data.map((row) => ({
    remote_id: bigbuyId.parse(row.id),
    parent_id: resource === 'productsvariations' ? bigbuyId.parse(row.product) : null,
    payload: row,
  }));
  ensure(
    new Set(rows.map((p) => p.remote_id)).size === rows.length,
    502,
    'Powtórzony identyfikator na stronie BigBuy',
  );
  const bytes = Buffer.byteLength(JSON.stringify(rows));
  await tenantTx(job.tenant_id, async (c) => {
    const current = await fenced(c, job);
    if (!current) return;
    const now = current.r;
    ensure(
      now.phase === 'fetch' &&
        now.resource_index === r.resource_index &&
        JSON.stringify(now.cursors) === JSON.stringify(r.cursors),
      409,
      'Checkpoint masowego katalogu zmienił się',
    );
    ensure(
      Number(now.fetched_rows) + rows.length <= 10000000 &&
        Number(now.fetched_bytes) + bytes <= 8 * 1024 ** 3,
      409,
      'Katalog przekroczył limit 10 mln rekordów lub 8 GiB; podziel pobieranie na taksonomie',
    );
    ensure(
      !(
        await c.query(
          'SELECT 1 FROM supplier_bulk_parts WHERE run_id=$1 AND resource=$2 AND remote_id=ANY($3::text[]) LIMIT 1',
          [r.id, resource, rows.map((p) => p.remote_id)],
        )
      ).rowCount,
      409,
      'Strona powtarza dane poprzednich stron; BigBuy nie zapewnił spójnej paginacji',
    );
    if (rows.length)
      await c.query(
        'INSERT INTO supplier_bulk_parts(tenant_id,run_id,resource,remote_id,parent_id,payload) SELECT $1,$2,$3,x.remote_id,x.parent_id,x.payload FROM jsonb_to_recordset($4::jsonb) x(remote_id text,parent_id text,payload jsonb)',
        [job.tenant_id, r.id, resource, JSON.stringify(rows)],
      );
    const cursors = {
        ...now.cursors,
        [resource]: {
          page: cursor.page + 1,
          rows: cursor.rows + rows.length,
          done: rows.length < r.page_size,
        },
      },
      next = Array.from({ length: 6 }, (_, n) => (r.resource_index + n + 1) % 6).find(
        (index) => !cursors[bigbuyBulkResources[index]]?.done,
      ),
      done = next === undefined;
    await c.query(
      'UPDATE supplier_bulk_runs SET cursors=$2,resource_index=$3,phase=$4,fetched_rows=fetched_rows+$5,fetched_bytes=fetched_bytes+$6,version=version+1,error=NULL WHERE id=$1',
      [r.id, JSON.stringify(cursors), next ?? 0, done ? 'parents' : 'fetch', rows.length, bytes],
    );
    await defer(c, job);
  });
}
async function issue(
  c: PoolClient,
  a: Actor,
  r: any,
  root: string,
  variant: string,
  error: string,
) {
  await c.query(
    'INSERT INTO supplier_bulk_issues(id,tenant_id,run_id,remote_product_id,remote_variant_id,error) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
    [randomUUID(), a.tenantId, r.id, root, variant, error],
  );
}
async function assemble(c: PoolClient, a: Actor, job: any, state: any) {
  const { r, s } = state;
  if (r.phase === 'retire') {
    // Only a complete set can withdraw identities. A taxonomy run retires its own former scope.
    const old = (
      await c.query(
        "SELECT i.id FROM supplier_catalog_items i WHERE i.source_id=$1 AND i.refreshed_at<=$2 AND (i.snapshot->>'active')::boolean AND ($3::text IS NULL OR i.snapshot->>'scope_taxonomy'=$3) AND ((i.remote_variant_id='' AND NOT EXISTS(SELECT 1 FROM supplier_bulk_parts p WHERE p.run_id=$4 AND p.resource='products' AND p.remote_id=i.remote_product_id)) OR (i.remote_variant_id<>'' AND NOT EXISTS(SELECT 1 FROM supplier_bulk_parts p WHERE p.run_id=$4 AND p.resource='productsvariations' AND p.remote_id=i.remote_variant_id))) ORDER BY i.id LIMIT 200 FOR UPDATE OF i",
        [s.id, r.created_at, r.taxonomy, r.id],
      )
    ).rows;
    if (old.length) {
      await c.query(
        "UPDATE supplier_catalog_items SET snapshot=snapshot||jsonb_build_object('quantity',0,'active',false,'withdrawn_by_bulk_id',$2::text),version=version+1 WHERE id=ANY($1::uuid[])",
        [old.map((p) => p.id), r.id],
      );
      await c.query(
        'UPDATE supplier_bulk_runs SET withdrawn=withdrawn+$2,version=version+1 WHERE id=$1',
        [r.id, old.length],
      );
      await defer(c, job);
      return;
    }
    await c.query(
      "UPDATE supplier_bulk_runs SET state='success',finished_at=now(),version=version+1,error=NULL WHERE id=$1",
      [r.id],
    );
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
      [job.id],
    );
    await audit(c, a, 'supplier.bulk.success', r.id, {
      source_id: s.id,
      published: r.published,
      rejected: r.rejected,
      skipped_newer: r.skipped_newer,
      withdrawn: r.withdrawn,
      simulation: !!state.ch.settings.simulation,
    });
    return;
  }
  const variant = r.phase === 'variants';
  ensure(variant || r.phase === 'parents', 409, 'Nieprawidłowa faza masowego katalogu');
  const parts = (
    await c.query(
      `SELECT x.remote_id,x.payload selected,x.observed_at selected_at,p.payload product,p.observed_at product_at,i.payload information,i.observed_at information_at,m.payload images,m.observed_at images_at,t.payload stock,t.observed_at stock_at FROM supplier_bulk_parts x LEFT JOIN supplier_bulk_parts p ON p.run_id=x.run_id AND p.tenant_id=x.tenant_id AND p.resource='products' AND p.remote_id=${variant ? 'x.parent_id' : 'x.remote_id'} LEFT JOIN supplier_bulk_parts i ON i.run_id=x.run_id AND i.tenant_id=x.tenant_id AND i.resource='productsinformation' AND i.remote_id=p.remote_id LEFT JOIN supplier_bulk_parts m ON m.run_id=x.run_id AND m.tenant_id=x.tenant_id AND m.resource='productsimages' AND m.remote_id=p.remote_id LEFT JOIN supplier_bulk_parts t ON t.run_id=x.run_id AND t.tenant_id=x.tenant_id AND t.resource=$3 AND t.remote_id=x.remote_id WHERE x.run_id=$1 AND x.resource=$2 AND x.remote_id>$4 ORDER BY x.remote_id LIMIT 200`,
      [
        r.id,
        variant ? 'productsvariations' : 'products',
        variant ? 'productsvariationsstockbyhandlingdays' : 'productsstockbyhandlingdays',
        r.after_id,
      ],
    )
  ).rows;
  if (!parts.length) {
    await c.query(
      "UPDATE supplier_bulk_runs SET phase=$2,after_id='',version=version+1 WHERE id=$1",
      [r.id, variant ? 'retire' : 'variants'],
    );
    await defer(c, job);
    return;
  }
  let published = 0,
    rejected = 0,
    skipped = 0;
  for (const row of parts) {
    const root = variant ? String(row.selected.product) : row.remote_id,
      variantId = variant ? row.remote_id : '';
    if (!variant && row.product?.attributes === true) {
      if (
        !(
          await c.query(
            "SELECT 1 FROM supplier_bulk_parts WHERE run_id=$1 AND resource='productsvariations' AND parent_id=$2 LIMIT 1",
            [r.id, root],
          )
        ).rowCount
      ) {
        await issue(c, a, r, root, '', 'Produkt z wariantami nie ma wariantów w pobranym zbiorze');
        rejected++;
      }
      continue;
    }
    let snapshot: any;
    try {
      const normalized = normalizeBigBuy(
        {
          product: row.product,
          productinformation: row.information,
          productimages:
            row.images ?? (row.product?.images === false ? { id: root, images: [] } : undefined),
          productvariations: variant ? [row.selected] : undefined,
          [variant ? 'productvariationsstockbyhandlingdays' : 'productstockbyhandlingdays']:
            row.stock,
        },
        root,
        variantId || null,
        s.language,
        s.max_handling_days,
      );
      const dates = [
        row.product_at,
        row.information_at,
        row.stock_at,
        row.selected_at,
        ...(row.images_at ? [row.images_at] : []),
      ];
      ensure(dates.every(Boolean), 502, 'Brak czasu odczytu części katalogu');
      const observed = new Date(Math.min(...dates.map((d) => new Date(d).getTime()))).toISOString();
      snapshot = {
        ...normalized,
        currency: s.currency,
        simulation: !!state.ch.settings.simulation,
        connection_hash: r.connection_hash,
        bulk_run_id: r.id,
        observed_at: observed,
        scope_taxonomy: r.taxonomy,
      };
    } catch (e) {
      await issue(
        c,
        a,
        r,
        root,
        variantId,
        e instanceof Problem ? e.message : 'Niekompletna lub nieprawidłowa pozycja BigBuy',
      );
      rejected++;
      continue;
    }
    const result = await c.query(
      'INSERT INTO supplier_catalog_items(id,tenant_id,source_id,remote_product_id,remote_variant_id,sku,name,snapshot,bulk_run_id,refreshed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,source_id,remote_product_id,remote_variant_id) DO UPDATE SET sku=excluded.sku,name=excluded.name,snapshot=excluded.snapshot,read_id=NULL,bulk_run_id=excluded.bulk_run_id,refreshed_at=excluded.refreshed_at,version=supplier_catalog_items.version+1 WHERE supplier_catalog_items.refreshed_at<=excluded.refreshed_at',
      [
        randomUUID(),
        a.tenantId,
        s.id,
        root,
        variantId,
        snapshot.sku,
        snapshot.name,
        JSON.stringify(snapshot),
        r.id,
        snapshot.observed_at,
      ],
    );
    if (result.rowCount) published++;
    else skipped++;
  }
  await c.query(
    'UPDATE supplier_bulk_runs SET after_id=$2,published=published+$3,rejected=rejected+$4,skipped_newer=skipped_newer+$5,version=version+1,error=NULL WHERE id=$1',
    [r.id, parts.at(-1).remote_id, published, rejected, skipped],
  );
  await defer(c, job);
}
export async function failSupplierBulk(job: any, error: unknown) {
  if (error instanceof BigBuyRetry && job.supplier_rate_key)
    await pool.query(
      'INSERT INTO supplier_api_limits(key,next_at) VALUES($1,now()+make_interval(secs=>$2)) ON CONFLICT(key) DO UPDATE SET next_at=greatest(supplier_api_limits.next_at,excluded.next_at)',
      [job.supplier_rate_key + ':*', error.seconds],
    );
  await tenantTx(job.tenant_id, async (c) => {
    const r = (
      await c.query('SELECT * FROM supplier_bulk_runs WHERE id=$1 FOR UPDATE', [
        job.payload.bulk_id,
      ])
    ).rows[0];
    if (!r || r.state !== 'queued' || r.job_id !== job.id) return;
    if (
      !(
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rowCount
    )
      return;
    const message = error instanceof Problem ? error.message : 'Błąd pobierania masowego katalogu',
      retry =
        (error instanceof BigBuyRetry || (error instanceof Problem && error.status === 502)) &&
        job.attempts < job.max_attempts;
    await c.query(
      "UPDATE supplier_bulk_runs SET state=$2,error=$3,version=version+1,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1",
      [r.id, retry ? 'queued' : 'failed', message],
    );
    if (retry)
      await defer(
        c,
        job,
        error instanceof BigBuyRetry ? error.seconds : Math.max(5, 2 ** job.attempts),
        message,
        false,
      );
    else
      await c.query(
        "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error=$2 WHERE id=$1",
        [job.id, message],
      );
  });
}
export function bulkDemoPage(resource: BigBuyBulkResource, page: number, size: number) {
  const parents = [
    ...Array.from({ length: 105 }, (_, n) => ({
      id: 1000 + n,
      sku: 'BB-' + (1000 + n),
      active: 1,
      attributes: false,
      images: false,
      wholesalePrice: '12.34',
      priceLargeQuantities: [{ quantity: 5, price: '11.00' }],
    })),
    {
      id: 202,
      sku: 'BB-202',
      active: 1,
      attributes: true,
      images: false,
      wholesalePrice: '12.34',
      priceLargeQuantities: [],
    },
  ];
  const variants = [303, 304].map((id) => ({
    id,
    product: 202,
    sku: 'BB-V-' + id,
    wholesalePrice: '15.50',
    priceLargeQuantities: [{ quantity: 5, price: '14.00' }],
  }));
  const stock = (id: number, sku: string) => ({
    id,
    sku,
    stocks: [
      { quantity: 8, minHandlingDays: 0, maxHandlingDays: 1, warehouse: 1 },
      { quantity: 4, minHandlingDays: 2, maxHandlingDays: 4, warehouse: 1 },
    ],
  });
  const data =
    resource === 'products'
      ? parents
      : resource === 'productsinformation'
        ? parents.map((p) => ({
            id: p.id,
            sku: p.sku,
            name: 'Katalog lokalny BigBuy ' + p.id,
            isoCode: 'pl',
            description: 'Syntetyczny przykład masowego katalogu.',
          }))
        : resource === 'productsimages'
          ? []
          : resource === 'productsstockbyhandlingdays'
            ? parents.map((p) => stock(p.id, p.sku))
            : resource === 'productsvariations'
              ? variants
              : variants.map((v) => stock(v.id, v.sku));
  return data.slice(page * size, (page + 1) * size);
}
