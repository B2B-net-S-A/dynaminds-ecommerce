import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor, productSchema } from './domain';
import { ensure, Problem } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { decrypt } from './security';
import { connectionHash } from './offer-sync-policy';
import { systemActor } from './sync';
import { BigBuy, BigBuyRetry, bigbuyId, normalizeBigBuy } from './bigbuy';
import { safeFetch } from './integrations';
import type { IntegrationContext } from './channel-access';
import { purchaseSave, purchaseInput } from './purchasing';
import { createProduct } from './catalog';
import { wmsLotsHash } from './wms-lots';
const hash = (b: unknown) => createHash('sha256').update(JSON.stringify(b)).digest('hex');
export const supplierSourceInput = z
  .object({
    channel_id: z.uuid(),
    supplier_id: z.uuid(),
    language: z
      .string()
      .regex(/^[a-z]{2}$/)
      .default('pl'),
    currency: z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']),
    max_handling_days: z.number().int().min(0).max(365).default(2),
  })
  .strict();
export const supplierReadInput = z
  .object({
    client_key: z.uuid(),
    remote_product_id: bigbuyId,
    remote_variant_id: bigbuyId.optional(),
  })
  .strict();
export const supplierPurchaseInput = z
  .object({
    client_key: z.uuid(),
    warehouse_id: z.uuid(),
    reference: z.string().trim().max(200).default(''),
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            version: z.number().int().positive(),
            quantity: z.number().int().min(1).max(1000000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export const supplierStateInput = z
  .object({ version: z.number().int().positive(), paused: z.boolean() })
  .strict();
export const supplierLinkInput = z
  .object({ version: z.number().int().positive(), product_id: z.uuid().nullable() })
  .strict();
export const supplierProductInput = z
  .object({
    version: z.number().int().positive(),
    sku: z.string().trim().min(1).max(80),
    price: z.number().int().min(0).max(100000000),
    vat: z.union([z.literal(0), z.literal(5), z.literal(8), z.literal(23)]),
    warehouse_id: z.uuid(),
    catalog_id: z.uuid().optional(),
  })
  .strict();
export function supplierConnection(source: any, ch: any) {
  if (source.kind === 'file')
    return wmsLotsHash({
      kind: 'file',
      source_id: source.id,
      source_version: source.version,
      config: ch.settings,
      language: source.language,
      currency: source.currency,
      max_handling_days: source.max_handling_days,
    });
  return hash({
    connection: connectionHash(ch),
    credentials: hash(ch.credentials),
    source_version: source.version,
    language: source.language,
    currency: source.currency,
    max_handling_days: source.max_handling_days,
  });
}
export async function supplierSource(c: PoolClient, id: string, write = false) {
  const s = (
    await c.query('SELECT * FROM supplier_sources WHERE id=$1' + (write ? ' FOR UPDATE' : ''), [id])
  ).rows[0];
  ensure(s, 404, 'Nie znaleziono źródła dostawcy');
  return s;
}
export async function supplierSourceConnection(c: PoolClient, s: any) {
  if (s.kind === 'file') {
    ensure(!s.paused, 409, 'Źródło dostawcy jest wstrzymane');
    ensure(
      (await c.query('SELECT id FROM suppliers WHERE id=$1 AND active', [s.supplier_id])).rowCount,
      409,
      'Dostawca jest nieaktywny',
    );
    ensure(
      (await c.query("SELECT to_regclass('supplier_file_source_configs') IS NOT NULL ok")).rows[0]
        .ok,
      503,
      'Moduł źródła plikowego jest niekompletny',
    );
    const cfg = (
      await c.query('SELECT config FROM supplier_file_source_configs WHERE source_id=$1', [s.id])
    ).rows[0];
    ensure(cfg, 503, 'Brak konfiguracji źródła plikowego');
    return { provider: 'file', settings: cfg.config, credentials: null };
  }
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [s.channel_id]))
    .rows[0];
  ensure(ch?.provider === 'bigbuy', 422, 'Wymagana integracja BigBuy');
  ensure(!s.paused, 409, 'Źródło dostawcy jest wstrzymane');
  ensure(
    (await c.query('SELECT id FROM suppliers WHERE id=$1 AND active', [s.supplier_id])).rowCount,
    409,
    'Dostawca jest nieaktywny',
  );
  return ch;
}
export async function saveSupplierSource(
  c: PoolClient,
  a: Actor,
  b: z.infer<typeof supplierSourceInput>,
) {
  const ch = (
    await c.query("SELECT id FROM channels WHERE id=$1 AND provider='bigbuy' FOR UPDATE", [
      b.channel_id,
    ])
  ).rows[0];
  ensure(ch, 422, 'Wybierz integrację BigBuy swojej firmy');
  ensure(
    (await c.query('SELECT id FROM suppliers WHERE id=$1 AND active', [b.supplier_id])).rowCount,
    422,
    'Wybierz aktywnego dostawcę swojej firmy',
  );
  ensure(
    !(await c.query('SELECT id FROM supplier_sources WHERE channel_id=$1', [b.channel_id]))
      .rowCount,
    409,
    'Integracja ma już źródło dostawcy',
  );
  const r = (
    await c.query(
      'INSERT INTO supplier_sources(id,tenant_id,channel_id,supplier_id,language,currency,max_handling_days) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [
        randomUUID(),
        a.tenantId,
        b.channel_id,
        b.supplier_id,
        b.language,
        b.currency,
        b.max_handling_days,
      ],
    )
  ).rows[0];
  await audit(c, a, 'supplier.source.created', r.id, {
    channel_id: r.channel_id,
    supplier_id: r.supplier_id,
    currency: r.currency,
  });
  return r;
}
export async function startSupplierRead(
  c: PoolClient,
  a: Actor,
  id: string,
  b: z.infer<typeof supplierReadInput>,
) {
  const s = await supplierSource(c, id, true);
  ensure(s.kind !== 'file', 422, 'Źródło plikowe wymaga nowego podglądu pliku');
  const ch = await supplierSourceConnection(c, s),
    inputHash = hash(b);
  const prior = (
    await c.query('SELECT * FROM supplier_catalog_reads WHERE source_id=$1 AND client_key=$2', [
      id,
      b.client_key,
    ])
  ).rows[0];
  if (prior) {
    ensure(prior.input_hash === inputHash, 409, 'Klucz odczytu użyto z innymi danymi');
    return { id: prior.id, state: prior.state, replayed: true };
  }
  ensure(
    !(
      await c.query(
        "SELECT id FROM supplier_catalog_reads WHERE source_id=$1 AND remote_product_id=$2 AND remote_variant_id=$3 AND state='queued'",
        [id, b.remote_product_id, b.remote_variant_id ?? ''],
      )
    ).rowCount,
    409,
    'Odczyt tej pozycji już oczekuje',
  );
  const readId = randomUUID(),
    jobId = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'supplier.read',$3,$4)",
    [
      jobId,
      a.tenantId,
      JSON.stringify({ read_id: readId, actor_id: a.userId }),
      'supplier.read:' + readId,
    ],
  );
  await c.query(
    'INSERT INTO supplier_catalog_reads(id,tenant_id,source_id,actor_id,client_key,input_hash,remote_product_id,remote_variant_id,connection_hash,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [
      readId,
      a.tenantId,
      id,
      a.userId,
      b.client_key,
      inputHash,
      b.remote_product_id,
      b.remote_variant_id ?? '',
      supplierConnection(s, ch),
      jobId,
    ],
  );
  await audit(c, a, 'supplier.read.queued', readId, {
    source_id: id,
    remote_product_id: b.remote_product_id,
    remote_variant_id: b.remote_variant_id ?? null,
  });
  return { id: readId, state: 'queued' };
}
async function fenced(c: PoolClient, job: any) {
  const peek = (
    await c.query('SELECT source_id FROM supplier_catalog_reads WHERE id=$1', [job.payload.read_id])
  ).rows[0];
  if (!peek) return null;
  // Same lock order as pause/start/purchase: source, read, job, channel.
  const s = await supplierSource(c, peek.source_id, true);
  const r = (
    await c.query('SELECT * FROM supplier_catalog_reads WHERE id=$1 FOR UPDATE', [
      job.payload.read_id,
    ])
  ).rows[0];
  if (!r || r.state !== 'queued' || r.job_id !== job.id) return null;
  if (
    !(
      await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rowCount
  )
    return null;
  const ch = await supplierSourceConnection(c, s);
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) AS ok', [r.actor_id])).rows[0].ok,
    403,
    'Administrator utracił prawo odczytu dostawcy',
  );
  ensure(
    supplierConnection(s, ch) === r.connection_hash,
    409,
    'Połączenie lub ustawienia dostawcy zmieniły się; rozpocznij nowy odczyt',
  );
  return { r, s, ch };
}
export async function reserveBigBuySlot(key: string, resource: string, intervalSeconds = 5) {
  // No tenant grants: secret hash scopes one supplier token, including duplicate connections.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cooldown =
      (
        await c.query(
          'SELECT greatest(0,ceil(extract(epoch FROM next_at-now())))::int delay FROM supplier_api_limits WHERE key=$1',
          [key + ':*'],
        )
      ).rows[0]?.delay ?? 0;
    if (cooldown) {
      await c.query('COMMIT');
      return cooldown;
    }
    const k = key + ':' + resource;
    await c.query(
      'INSERT INTO supplier_api_limits(key,next_at) VALUES($1,now()) ON CONFLICT DO NOTHING',
      [k],
    );
    const slot = await c.query(
      'UPDATE supplier_api_limits SET next_at=now()+make_interval(secs=>$2) WHERE key=$1 AND next_at<=now() RETURNING key',
      [k, intervalSeconds],
    );
    const delay = slot.rowCount
      ? 0
      : (
          await c.query(
            'SELECT greatest(1,ceil(extract(epoch FROM next_at-now())))::int delay FROM supplier_api_limits WHERE key=$1',
            [k],
          )
        ).rows[0].delay;
    await c.query('COMMIT');
    return delay;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function defer(
  c: PoolClient,
  job: any,
  seconds: number,
  error: string | null = null,
  reset = true,
) {
  await c.query(
    "UPDATE jobs SET state='pending',attempts=CASE WHEN $4 THEN 0 ELSE attempts END,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>$2),error=$3 WHERE id=$1",
    [job.id, seconds, error, reset],
  );
}
export async function processSupplierRead(job: any, ctx: IntegrationContext = {}) {
  const actor = await systemActor(job.tenant_id, job.payload.actor_id),
    state = await tenantTx(job.tenant_id, (c) => fenced(c, job));
  if (!state) return;
  const { r, s, ch } = state;
  const steps = [
    'product',
    'productinformation',
    'productimages',
    ...(r.remote_variant_id
      ? ['productvariations', 'productvariationsstockbyhandlingdays']
      : ['productstockbyhandlingdays']),
  ];
  const resource = steps[r.phase];
  ensure(resource, 409, 'Nieprawidłowy checkpoint dostawcy');
  const creds = decrypt(ch.credentials),
    rateKey = hash([ch.mode, creds.api_key]);
  job.supplier_rate_key = rateKey;
  if (!ch.settings.simulation) {
    const delay = await reserveBigBuySlot(rateKey, resource);
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
    ? demoPart(resource, r.remote_product_id, r.remote_variant_id, s.language)
    : await new BigBuy(ch.mode, creds, ctx.transport ?? safeFetch).read(
        resource,
        resource === 'productvariationsstockbyhandlingdays'
          ? r.remote_variant_id
          : r.remote_product_id,
        s.language,
      );
  await tenantTx(job.tenant_id, async (c) => {
    const current = await fenced(c, job);
    if (!current) return;
    ensure(current.r.phase === r.phase, 409, 'Checkpoint odczytu zmienił się');
    const parts = { ...current.r.parts, [resource]: data },
      done = r.phase + 1 === steps.length;
    if (done) {
      const normalized = normalizeBigBuy(
          parts,
          r.remote_product_id,
          r.remote_variant_id || null,
          s.language,
          s.max_handling_days,
        ),
        snapshot = {
          ...normalized,
          currency: s.currency,
          simulation: !!ch.settings.simulation,
          connection_hash: r.connection_hash,
        };
      await c.query(
        'INSERT INTO supplier_catalog_items(id,tenant_id,source_id,remote_product_id,remote_variant_id,sku,name,snapshot,read_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,source_id,remote_product_id,remote_variant_id) DO UPDATE SET sku=excluded.sku,name=excluded.name,snapshot=excluded.snapshot,read_id=excluded.read_id,bulk_run_id=NULL,version=supplier_catalog_items.version+1,refreshed_at=now()',
        [
          randomUUID(),
          job.tenant_id,
          s.id,
          r.remote_product_id,
          r.remote_variant_id,
          normalized.sku,
          normalized.name,
          JSON.stringify(snapshot),
          r.id,
        ],
      );
      await audit(c, actor, 'supplier.read.success', r.id, {
        source_id: s.id,
        sku: normalized.sku,
        simulation: !!ch.settings.simulation,
      });
    }
    await c.query(
      "UPDATE supplier_catalog_reads SET parts=$2,phase=phase+1,state=$3,error=NULL,finished_at=CASE WHEN $3='success' THEN now() ELSE NULL END WHERE id=$1",
      [r.id, JSON.stringify(parts), done ? 'success' : 'queued'],
    );
    if (done)
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
        [job.id],
      );
    else await defer(c, job, 0);
  });
}
export async function failSupplierRead(job: any, e: unknown) {
  if (e instanceof BigBuyRetry && job.supplier_rate_key) {
    await pool.query(
      'INSERT INTO supplier_api_limits(key,next_at) VALUES($1,now()+make_interval(secs=>$2)) ON CONFLICT(key) DO UPDATE SET next_at=greatest(supplier_api_limits.next_at,excluded.next_at)',
      [job.supplier_rate_key + ':*', e.seconds],
    );
  }
  await tenantTx(job.tenant_id, async (c) => {
    const r = (
      await c.query('SELECT * FROM supplier_catalog_reads WHERE id=$1 FOR UPDATE', [
        job.payload.read_id,
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
    const message = e instanceof Problem ? e.message : 'Błąd odczytu katalogu dostawcy';
    const retry =
      (e instanceof BigBuyRetry || (e instanceof Problem && e.status === 502)) &&
      job.attempts < job.max_attempts;
    await c.query(
      "UPDATE supplier_catalog_reads SET state=$2,error=$3,finished_at=CASE WHEN $2='failed' THEN now() ELSE NULL END WHERE id=$1",
      [r.id, retry ? 'queued' : 'failed', message],
    );
    if (retry)
      await defer(
        c,
        job,
        e instanceof BigBuyRetry ? e.seconds : Math.max(5, 2 ** job.attempts),
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
export async function linkSupplierItem(
  c: PoolClient,
  a: Actor,
  id: string,
  version: number,
  productId: string | null,
) {
  const row = (await c.query('SELECT * FROM supplier_catalog_items WHERE id=$1 FOR UPDATE', [id]))
    .rows[0];
  ensure(row, 404, 'Nie znaleziono pozycji dostawcy');
  ensure(row.version === version, 409, 'Pozycja dostawcy zmieniła się');
  if (productId)
    ensure(
      (
        await c.query(
          "SELECT id FROM products WHERE id=$1 AND kind IN ('simple','variant') FOR SHARE",
          [productId],
        )
      ).rowCount,
      422,
      'Wybierz fizyczny produkt swojej firmy',
    );
  if (productId) await assertProductsNotDeletedInTx(c, [productId]);
  await c.query('UPDATE supplier_catalog_items SET product_id=$2,version=version+1 WHERE id=$1', [
    id,
    productId,
  ]);
  await audit(c, a, 'supplier.item.linked', id, { product_id: productId });
  return { ok: true };
}
export async function createSupplierProduct(
  c: PoolClient,
  a: Actor,
  id: string,
  b: { version: number; sku: string; price: number; vat: number; warehouse_id: string; catalog_id?: string },
) {
  const item = (await c.query('SELECT * FROM supplier_catalog_items WHERE id=$1 FOR UPDATE', [id]))
    .rows[0];
  ensure(item, 404, 'Nie znaleziono pozycji');
  ensure(
    item.version === b.version && !item.product_id,
    409,
    'Pozycja zmieniła się lub ma produkt',
  );
  const p = await createProduct(
    c,
    a,
    productSchema.parse({
      sku: b.sku,
      name: item.name,
      price: b.price,
      vat: b.vat,
      ean: item.snapshot.ean ?? undefined,
      quantity: 0,
      warehouse_id: b.warehouse_id,
      ...(b.catalog_id ? { catalog_id: b.catalog_id } : {}),
      description: item.snapshot.description.slice(0, 10000),
      images: item.snapshot.images.slice(0, 10),
    }),
    {birthScopes:['purchasing:write']},
  );
  await c.query('UPDATE supplier_catalog_items SET product_id=$2,version=version+1 WHERE id=$1', [
    id,
    p.id,
  ]);
  return p;
}
export async function purchaseFromSupplier(
  c: PoolClient,
  a: Actor,
  id: string,
  b: z.infer<typeof supplierPurchaseInput>,
) {
  const s = await supplierSource(c, id, true),
    orderedInput = { ...b, items: [...b.items].sort((x, y) => x.id.localeCompare(y.id)) },
    inputHash = hash(
      s.kind === 'file'
        ? {
            tenant_id: a.tenantId,
            actor_id: a.userId,
            api_key_id: (a as Actor & { apiKeyId?: string }).apiKeyId ?? null,
            request: orderedInput,
          }
        : orderedInput,
    );
  const fileAccess = async (pin: boolean) => {
    if (s.kind !== 'file') return;
    ensure(
      (
        await c.query(
          "SELECT to_regprocedure('supplier_file_access(uuid,uuid,boolean,boolean)') IS NOT NULL ok",
        )
      ).rows[0].ok,
      503,
      'Moduł źródła plikowego jest niekompletny',
    );
    const g = (
      await c.query('SELECT supplier_file_access($1,$2,true,$3) g', [
        a.userId,
        (a as Actor & { apiKeyId?: string }).apiKeyId ?? null,
        pin,
      ])
    ).rows[0].g;
    ensure(g.key_valid, 401, 'Klucz API wygasł lub został wycofany');
    ensure(g.allowed, 403, 'Brak aktualnych uprawnień purchasing do źródła plikowego');
  };
  await fileAccess(false);
  const prior = (
    await c.query('SELECT * FROM supplier_catalog_purchases WHERE source_id=$1 AND client_key=$2', [
      id,
      b.client_key,
    ])
  ).rows[0];
  if (prior) {
    ensure(prior.input_hash === inputHash, 409, 'Klucz zakupu użyto z innymi danymi');
    await fileAccess(true);
    return { id: prior.purchase_id, replayed: true };
  }
  const ch = await supplierSourceConnection(c, s);
  ensure(
    new Set(b.items.map((i) => i.id)).size === b.items.length,
    422,
    'Powtórzona pozycja dostawcy',
  );
  const rows = (
    await c.query(
      "SELECT *,refreshed_at>now()-interval '15 minutes' AS fresh FROM supplier_catalog_items WHERE source_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE",
      [id, b.items.map((i) => i.id)],
    )
  ).rows;
  ensure(rows.length === b.items.length, 422, 'Brak pozycji swojej firmy');
  const bulkIds = [...new Set(rows.map((r) => r.bulk_run_id).filter(Boolean))];
  const awaitedBulk = new Map<string, string>(
    (
      await c.query('SELECT id,state FROM supplier_bulk_runs WHERE id=ANY($1::uuid[])', [bulkIds])
    ).rows.map((r) => [r.id, r.state]),
  );
  const snapshots: any[] = [];
  const lines = b.items.map((i) => {
    const row = rows.find((r) => r.id === i.id),
      p = row.snapshot;
    ensure(
      row.version === i.version && row.fresh,
      409,
      'Pozycja zmieniła się lub odczyt ma ponad 15 minut; odśwież katalog',
    );
    ensure(
      p.connection_hash === supplierConnection(s, ch),
      409,
      'Zmieniła się konfiguracja dostawcy',
    );
    ensure(
      row.product_id && p.active && i.quantity <= p.quantity,
      409,
      'Brak powiązania, aktywności lub dostępności dostawcy',
    );
    if (row.bulk_run_id)
      ensure(
        awaitedBulk.get(row.bulk_run_id) === 'success',
        409,
        'Masowy katalog nie zakończył się; odśwież pozycję punktowo',
      );
    let cost = p.unit_cost;
    for (const t of p.tiers) if (i.quantity >= t.quantity) cost = t.unit_cost;
    snapshots.push({
      item_id: i.id,
      read_id: row.read_id,
      bulk_run_id: row.bulk_run_id,
      ...(row.file_run_id
        ? {
            file_run_id: row.file_run_id,
            file_preview_id: p.file_preview_id,
            raw_hash: p.raw_hash,
            source_version: p.source_version,
          }
        : {}),
      version: row.version,
      refreshed_at: row.refreshed_at,
      quantity: i.quantity,
      unit_cost: cost,
      supplier_sku: row.sku,
      currency: s.currency,
      simulation: p.simulation,
    });
    return {
      product_id: row.product_id,
      quantity: i.quantity,
      unit_cost: cost,
      supplier_sku: row.sku,
    };
  });
  const purchase = await purchaseSave(
    c,
    a,
    purchaseInput.parse({
      supplier_id: s.supplier_id,
      warehouse_id: b.warehouse_id,
      currency: s.currency,
      reference: b.reference,
      lines,
    }),
  );
  await c.query(
    'INSERT INTO supplier_catalog_purchases(id,tenant_id,source_id,client_key,input_hash,purchase_id,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), a.tenantId, id, b.client_key, inputHash, purchase.id, JSON.stringify(snapshots)],
  );
  await audit(c, a, 'supplier.purchase.created', purchase.id, {
    source_id: id,
    items: b.items.length,
  });
  if (s.kind === 'file') {
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await fileAccess(true);
  }
  return { id: purchase.id, replayed: false };
}
function demoPart(resource: string, root: string, variant: string, language: string) {
  const sku = variant ? 'BB-V-' + variant : 'BB-' + root;
  if (resource === 'product')
    return {
      id: Number(root),
      sku: 'BB-' + root,
      active: 1,
      attributes: !!variant,
      condition: 'NEW',
      wholesalePrice: '12.34',
      ean13: null,
      priceLargeQuantities: [{ quantity: 5, price: '11.00' }],
    };
  if (resource === 'productinformation')
    return {
      id: Number(root),
      sku: 'BB-' + root,
      name: 'Przykład lokalny BigBuy ' + root,
      description: 'Dane syntetyczne do sprawdzenia procesu zakupowego.',
      isoCode: language,
    };
  if (resource === 'productimages') return { id: Number(root), images: [] };
  if (resource === 'productvariations')
    return [
      {
        id: Number(variant),
        product: Number(root),
        sku,
        ean13: null,
        wholesalePrice: '15.50',
        priceLargeQuantities: [{ quantity: 5, price: '14.00' }],
      },
    ];
  return {
    id: Number(variant || root),
    sku,
    stocks: [
      { quantity: 8, minHandlingDays: 0, maxHandlingDays: 1, warehouse: 1 },
      { quantity: 4, minHandlingDays: 2, maxHandlingDays: 4, warehouse: 1 },
    ],
  };
}
