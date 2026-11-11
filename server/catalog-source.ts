import { emitCatalogProductEvents, type CatalogProductEvent } from './product-rule-events';
import { amazonAccountPolicy } from './amazon-account';
import { deferEbayApiJob } from './ebay-api-limits';
import { processEbayCatalog } from './ebay-source';
import { processAmazonCatalog } from './amazon-source';
import { deferAmazonApiJob } from './amazon-api-limits';
import { amazonSettings } from './amazon';
import { ebayConnectionHash, ebaySettings } from './ebay';
import { processOdooCatalog } from './odoo-source';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, productSchema, type Actor } from './domain';
import { createProduct } from './catalog';
import { resolveProductCatalogInTx, assertProductCatalogInTx, assertProductCatalogWarehouseInTx } from './product-catalogs';
import { resolveProductSkus } from './product-sku';
import { ensure, Problem } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { loadChannel, channelRead, type IntegrationContext } from './channel-access';
import { WooCommerce } from './integrations';
import { connectionHash } from './offer-sync-policy';
import { normalizeSource, demoCatalog, sourceHash } from './catalog-source-normalize';
import { systemActor, type LocalWooReadLaneStageContext } from './sync';
import { Shopify, shopifyId } from './shopify';
import { normalizeShopifyCatalog, demoShopifyCatalog } from './shopify-catalog';
export function catalogConnectionMatches(ch: any, run: any) {
  return (
    ch &&
    (ch.provider === 'ebay' ? ebayConnectionHash(ch) : connectionHash(ch)) ===
      run.connection_hash &&
    (!['shopify', 'odoo', 'amazon'].includes(ch.provider) ||
      sourceHash(ch.credentials) === run.cursor.credentials_hash)
  );
}
const message = (e: unknown) => (e instanceof Problem ? e.message : 'Błąd importu katalogu');
export const catalogSourceInput = z
  .object({
    client_key: z.uuid(),
    warehouse_id: z.uuid(),
    vat: z.union([z.literal(0), z.literal(5), z.literal(8), z.literal(23)]).default(23),
    import_stock: z.boolean().default(false),
  })
  .strict();
export const catalogApplyInput = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            catalog_id: z.uuid().optional(),
            source_hash: z.string().regex(/^[a-f0-9]{64}$/),
            local_sku: z.string().trim().min(1).max(80).optional(),
            expected_product_id: z.uuid().nullable(),
            expected_version: z.number().int().positive().nullable(),
            price_override: z.number().int().min(0).max(100000000).optional(),
            quantity_override: z.number().int().min(0).max(10000000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export async function enqueueCatalog(c: PoolClient, actor: Actor, run: any) {
  const id = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'catalog.fetch',$3,$4)",
    [
      id,
      actor.tenantId,
      JSON.stringify({ run_id: run.id, actor_id: actor.userId }),
      `catalog.fetch:${id}`,
    ],
  );
  await c.query(
    "UPDATE catalog_source_runs SET job_id=$2,state='queued',error=NULL,updated_at=now() WHERE id=$1",
    [run.id, id],
  );
  return id;
}
export async function startCatalog(
  c: PoolClient,
  actor: Actor,
  channelId: string,
  b: z.infer<typeof catalogSourceInput>,
) {
  await c.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [channelId]);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [channelId])).rows[0];
  ensure(
    ['woocommerce', 'shopify', 'odoo', 'ebay', 'amazon'].includes(ch?.provider),
    404,
    'Nie znaleziono kanału katalogu',
  );
  const hash = sourceHash(b),
    prior = (
      await c.query('SELECT * FROM catalog_source_runs WHERE channel_id=$1 AND client_key=$2', [
        channelId,
        b.client_key,
      ])
    ).rows[0];
  if (prior) {
    ensure(prior.input_hash === hash, 409, 'Klucz importu użyto z innymi ustawieniami');
    return { ...prior, reused: true };
  }
  ensure(
    !['odoo', 'ebay', 'amazon'].includes(ch.provider) || !b.import_stock,
    422,
    'Dostępność zewnętrzna nie jest przyjęciem towaru; importuj katalog bez stanów',
  );
  if (ch.provider === 'amazon') await amazonAccountPolicy(c, ch);
  if (ch.provider === 'amazon')
    ensure(
      ch.settings.simulation || amazonSettings.parse(ch.settings).selling_partner_id,
      422,
      'Import katalogu Amazon wymaga identyfikatora sprzedawcy',
    );
  if (ch.provider === 'ebay')
    ensure(
      ch.settings.simulation ||
        ['orders_inventory', 'orders_inventory_write'].includes(
          ebaySettings.parse(ch.settings).inventory_access,
        ),
      422,
      'Wymagana zgoda sell.inventory.readonly i połączenie z dostępem do katalogu eBay',
    );
  if (ch.provider === 'shopify' && b.import_stock)
    shopifyId(ch.settings.inventory_location_id, 'Location');
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1', [b.warehouse_id])).rowCount,
    404,
    'Nie znaleziono magazynu',
  );
  const run = (
    await c.query(
      'INSERT INTO catalog_source_runs(id,tenant_id,channel_id,actor_id,warehouse_id,client_key,input_hash,connection_hash,vat,import_stock) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [
        randomUUID(),
        actor.tenantId,
        channelId,
        actor.userId,
        b.warehouse_id,
        b.client_key,
        hash,
        ch.provider === 'ebay' ? ebayConnectionHash(ch) : connectionHash(ch),
        b.vat,
        b.import_stock,
      ],
    )
  ).rows[0];
  if (['shopify', 'odoo', 'ebay', 'amazon'].includes(ch.provider)) {
    run.cursor = {
      phase: ch.provider,
      after: ch.provider === 'shopify' ? null : 0,
      pages: 0,
      last_id: '0',
      credentials_hash:
        ch.provider === 'ebay' ? ebayConnectionHash(ch) : sourceHash(ch.credentials),
    };
    await c.query('UPDATE catalog_source_runs SET cursor=$2 WHERE id=$1', [
      run.id,
      JSON.stringify(run.cursor),
    ]);
  }
  run.job_id = await enqueueCatalog(c, actor, run);
  await audit(c, actor, 'catalog.source.start', run.id, {
    channel_id: ch.id,
    warehouse_id: b.warehouse_id,
    import_stock: b.import_stock,
  });
  return run;
}
export { guard as guardCatalogSource };
async function guard(
  job: any, fn: (c: PoolClient, run: any) => Promise<void>, renew = false,
  beforeStage?: LocalWooReadLaneStageContext['localWooReadLaneBeforeStage'],
) {
  return tenantTx(job.tenant_id, async (c) => {
    // A selected local lane locks its source before the existing run/job order.
    await beforeStage?.(c, job);
    const run = (
      await c.query('SELECT * FROM catalog_source_runs WHERE id=$1 FOR UPDATE', [
        job.payload.run_id,
      ])
    ).rows[0];
    if (!run || run.state !== 'queued' || run.job_id !== job.id) return false;
    const fence = await c.query(
      renew
        ? "UPDATE jobs SET locked_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id"
        : "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
      [job.id, job.lease_token],
    );
    if (!fence.rowCount) return false;
    await fn(c, run);
    return true;
  });
}
export async function processCatalogSource(job: any, ctx: LocalWooReadLaneStageContext = {}) {
  const actor = await systemActor(job.tenant_id, job.payload.actor_id);
  ensure(actor.role === 'admin', 403, 'Administrator utracił prawo importu katalogu');
  let run: any;
  if (
    !(await guard(
      job,
      async (_c, r) => {
        run = r;
      },
      true,
    ))
  )
    return;
  const ch = await loadChannel(job.tenant_id, run.channel_id);
  if (ch.provider === 'amazon') return processAmazonCatalog(job, actor, run, ch, ctx);
  if (ch.provider === 'ebay') return processEbayCatalog(job, actor, run, ch, ctx);
  if (ch.provider === 'odoo') return processOdooCatalog(job, actor, run, ch, ctx);
  if (ch.provider === 'shopify') return processShopifyCatalog(job, actor, run, ch, ctx);
  const validate = (current: any) =>
    ensure(
      connectionHash(current) === run.connection_hash && current.provider === 'woocommerce',
      409,
      'Połączenie zmieniono od rozpoczęcia importu; rozpocznij nowy przegląd',
    );
  validate(ch);
  const settings = async () => {
    if (ch.settings.simulation) return { currency: 'PLN', prices_include_tax: true };
    const read = async (group: string, key: string) => {
      ensure(
        await guard(job, async () => {}, true),
        409,
        'Import został zatrzymany lub dzierżawa wygasła',
      );
      return channelRead(
        job.tenant_id,
        ch.id,
        async (client) => {
          ensure(client instanceof WooCommerce, 422, 'Wymagany sklep WooCommerce');
          return client.setting(group, key);
        },
        ctx,
        true,
        validate,
      );
    };
    const currency = await read('general', 'woocommerce_currency'),
      tax = await read('tax', 'woocommerce_prices_include_tax');
    ensure(
      ['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(currency?.value) &&
        ['yes', 'no'].includes(tax?.value),
      422,
      'Nie można ustalić waluty lub sposobu wprowadzania cen',
    );
    return { currency: currency.value, prices_include_tax: tax.value === 'yes' };
  };
  const context = run.context ?? (await settings());
  run.context = context;
  const cursor = run.cursor,
    parent = cursor.phase === 'variants' ? cursor.variable_ids[cursor.variable_index] : undefined;
  const page = parent ? cursor.variant_page : cursor.product_page;
  ensure(
    await guard(job, async () => {}, true),
    409,
    'Import został zatrzymany lub dzierżawa wygasła',
  );
  const result = ch.settings.simulation
    ? { data: demoCatalog(parent, page), has_more: false }
    : await channelRead(
        job.tenant_id,
        ch.id,
        async (client) => {
          ensure(client instanceof WooCommerce, 422, 'Wymagany sklep WooCommerce');
          return client.catalogPage(page, parent);
        },
        ctx,
        true,
        validate,
      );
  const normalized = result.data.map((raw: any) => normalizeSource(raw, run, parent));
  ensure(
    new Set(normalized.map((v: any) => v.external_id)).size === normalized.length,
    502,
    'Powtórzone ID na stronie katalogu',
  );
  let next: any,
    done = false;
  if (!parent) {
    const vars = normalized.filter((v: any) => v.kind === 'group').map((v: any) => v.external_id);
    next = vars.length
      ? {
          phase: 'variants',
          product_page: page,
          products_more: result.has_more,
          variable_ids: vars,
          variable_index: 0,
          variant_page: 1,
        }
      : { phase: 'products', product_page: page + 1 };
    done = !vars.length && !result.has_more;
  } else if (result.has_more) next = { ...cursor, variant_page: page + 1 };
  else if (cursor.variable_index + 1 < cursor.variable_ids.length)
    next = { ...cursor, variable_index: cursor.variable_index + 1, variant_page: 1 };
  else {
    next = { phase: 'products', product_page: cursor.product_page + 1 };
    done = !cursor.products_more;
  }
  if (done)
    ensure(
      sourceHash(await settings()) === sourceHash(context),
      409,
      'Ustawienia waluty lub podatku zmieniły się podczas pobierania; rozpocznij nowy przegląd',
    );
  await guard(job, async (c, current) => {
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) AS authorized', [current.actor_id])).rows[0]
        ?.authorized,
      403,
      'Administrator utracił prawo importu katalogu',
    );
    const latest = (
      await c.query('SELECT provider,mode,settings FROM channels WHERE id=$1', [current.channel_id])
    ).rows[0];
    validate(latest);
    for (const row of normalized) {
      const existing = (
        await c.query(
          'SELECT parent_external_id FROM catalog_source_items WHERE run_id=$1 AND external_id=$2',
          [run.id, row.external_id],
        )
      ).rows[0];
      ensure(
        !existing || existing.parent_external_id === row.parent_external_id,
        502,
        'ID źródła występuje przy innym rodzicu',
      );
      await c.query(
        `INSERT INTO catalog_source_items(id,tenant_id,run_id,external_id,parent_external_id,kind,source,source_hash,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,run_id,external_id) DO UPDATE SET source=excluded.source,source_hash=excluded.source_hash,issues=excluded.issues,kind=excluded.kind,captured_at=now()`,
        [
          randomUUID(),
          job.tenant_id,
          run.id,
          row.external_id,
          row.parent_external_id,
          row.kind,
          JSON.stringify(row.source),
          row.source_hash,
          JSON.stringify(row.issues),
        ],
      );
    }
    await c.query(
      "UPDATE catalog_source_runs SET context=$2,cursor=$3,state=$4,fetched=(SELECT count(*) FROM catalog_source_items WHERE run_id=$1),error=NULL,updated_at=now(),finished_at=CASE WHEN $4='ready' THEN now() ELSE NULL END WHERE id=$1",
      [run.id, JSON.stringify(context), JSON.stringify(next), done ? 'ready' : 'queued'],
    );
    await c.query(
      "UPDATE jobs SET state=$2,attempts=0,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now()+interval '1 second' WHERE id=$1",
      [job.id, done ? 'done' : 'pending'],
    );
    if (done) await audit(c, actor, 'catalog.source.ready', run.id, { channel_id: ch.id });
  }, false, ctx.localWooReadLaneBeforeStage);
}
async function processShopifyCatalog(
  job: any,
  actor: Actor,
  run: any,
  ch: any,
  ctx: IntegrationContext,
) {
  const validate = (current: any) =>
    ensure(
      current?.provider === 'shopify' && catalogConnectionMatches(current, run),
      409,
      'Połączenie Shopify zmieniono; rozpocznij nowy przegląd',
    );
  validate(ch);
  const fence = async () => {
    ensure(
      await guard(
        job,
        async (c, current) => {
          ensure(
            (await c.query('SELECT offer_sync_is_admin($1) AS authorized', [current.actor_id]))
              .rows[0]?.authorized,
            403,
            'Administrator utracił prawo importu katalogu',
          );
          validate(
            (await c.query('SELECT * FROM channels WHERE id=$1', [current.channel_id])).rows[0],
          );
        },
        true,
      ),
      409,
      'Import został zatrzymany lub dzierżawa wygasła',
    );
  };
  const read = <T>(fn: (client: Shopify) => Promise<T>) =>
    channelRead(
      job.tenant_id,
      ch.id,
      async (client) => {
        ensure(client instanceof Shopify, 422, 'Wymagany sklep Shopify');
        return fn(client);
      },
      ctx,
      false,
      validate,
    );
  const settings = () =>
    ch.settings.simulation
      ? Promise.resolve({ currency: 'PLN', prices_include_tax: true })
      : read((client) => client.catalogSettings(fence));
  const context = run.context ?? (await settings());
  const cursor = run.cursor;
  ensure(
    cursor.phase === 'shopify' && Number.isInteger(cursor.pages) && cursor.pages < 50000,
    422,
    'Przekroczono limit stron przeglądu katalogu Shopify',
  );
  await fence();
  const result = ch.settings.simulation
    ? {
        data: demoShopifyCatalog(ch.settings.inventory_location_id ?? 'gid://shopify/Location/1'),
        has_more: false,
        next_cursor: null,
        context,
      }
    : await read((client) =>
        client.catalogPage(
          cursor.after,
          run.import_stock,
          ch.settings.inventory_location_id,
          fence,
        ),
      );
  ensure(
    sourceHash(result.context) === sourceHash(context),
    409,
    'Waluta lub sposób wprowadzania cen zmieniły się podczas importu',
  );
  let last = BigInt(cursor.last_id);
  const normalized = new Map<string, ReturnType<typeof normalizeShopifyCatalog>>();
  for (const raw of result.data) {
    const id = shopifyId(raw?.id, 'ProductVariant'),
      number = BigInt(id.split('/').at(-1)!);
    ensure(number > last, 502, 'Brak postępu lub powtórzone ID wariantów Shopify');
    last = number;
    const input = { ...run, context, location_id: ch.settings.inventory_location_id };
    const rows =
      raw.product?.hasOnlyDefaultVariant === false
        ? [normalizeShopifyCatalog(raw, input, true), normalizeShopifyCatalog(raw, input)]
        : [normalizeShopifyCatalog(raw, input)];
    for (const row of rows) {
      const prior = normalized.get(row.external_id);
      ensure(
        !prior || prior.source_hash === row.source_hash,
        409,
        'Produkt Shopify zmienił się podczas pobierania',
      );
      normalized.set(row.external_id, row);
    }
  }
  const done = !result.has_more;
  if (done)
    ensure(
      sourceHash(await settings()) === sourceHash(context),
      409,
      'Ustawienia Shopify zmieniły się; rozpocznij nowy przegląd',
    );
  await guard(job, async (c, current) => {
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) AS authorized', [current.actor_id])).rows[0]
        ?.authorized,
      403,
      'Administrator utracił prawo importu katalogu',
    );
    validate((await c.query('SELECT * FROM channels WHERE id=$1', [current.channel_id])).rows[0]);
    for (const row of normalized.values()) {
      const prior = (
        await c.query(
          'SELECT kind,source_hash FROM catalog_source_items WHERE run_id=$1 AND external_id=$2',
          [run.id, row.external_id],
        )
      ).rows[0];
      if (prior) {
        ensure(
          row.kind === 'group' && prior.kind === 'group' && prior.source_hash === row.source_hash,
          409,
          'Produkt Shopify zmienił się lub ID zostało powtórzone podczas pobierania',
        );
        continue;
      }
      await c.query(
        'INSERT INTO catalog_source_items(id,tenant_id,run_id,external_id,parent_external_id,kind,source,source_hash,issues) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          job.tenant_id,
          run.id,
          row.external_id,
          row.parent_external_id,
          row.kind,
          JSON.stringify(row.source),
          row.source_hash,
          JSON.stringify(row.issues),
        ],
      );
    }
    const next = {
      ...cursor,
      after: result.next_cursor,
      pages: cursor.pages + 1,
      last_id: last.toString(),
    };
    await c.query(
      "UPDATE catalog_source_runs SET context=$2,cursor=$3,state=$4,fetched=(SELECT count(*) FROM catalog_source_items WHERE run_id=$1),error=NULL,updated_at=now(),finished_at=CASE WHEN $4='ready' THEN now() ELSE NULL END WHERE id=$1",
      [run.id, JSON.stringify(context), JSON.stringify(next), done ? 'ready' : 'queued'],
    );
    await c.query(
      "UPDATE jobs SET state=$2,attempts=0,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now()+interval '1 second' WHERE id=$1",
      [job.id, done ? 'done' : 'pending'],
    );
    if (done)
      await audit(c, actor, 'catalog.source.ready', run.id, {
        channel_id: ch.id,
        provider: 'shopify',
      });
  });
}
export async function failCatalogSource(job: any, e: unknown) {
  if (await deferAmazonApiJob(job, e)) return;
  if (await deferEbayApiJob(job, e)) return;
  await guard(job, async (c, run) => {
    const terminal =
      (e instanceof Problem && [401, 403, 409, 422].includes(e.status)) ||
      job.attempts >= job.max_attempts;
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', message(e)],
    );
    await c.query('UPDATE catalog_source_runs SET state=$2,error=$3,updated_at=now() WHERE id=$1', [
      run.id,
      terminal ? 'failed' : 'queued',
      message(e),
    ]);
  });
}
export async function applyCatalog(
  c: PoolClient,
  actor: Actor,
  runId: string,
  b: z.infer<typeof catalogApplyInput>,
) {
  ensure(
    new Set(b.items.map((v) => v.id)).size === b.items.length,
    422,
    'Powtórzone pozycje importu',
  );
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `catalog:${actor.tenantId}`,
  ]);
  // Quota triggers and membership edits lock the firm before its member rows.
  await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [actor.tenantId]);
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) AS authorized', [actor.userId])).rows[0]
      ?.authorized,
    403,
    'Administrator utracił prawo importu katalogu',
  );
  const run = (await c.query('SELECT * FROM catalog_source_runs WHERE id=$1 FOR UPDATE', [runId]))
    .rows[0];
  ensure(run, 404, 'Nie znaleziono importu katalogu');
  ensure(run.state === 'ready', 409, 'Najpierw zakończ pobieranie katalogu');
  const channel = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [run.channel_id]))
    .rows[0];
  ensure(
    catalogConnectionMatches(channel, run),
    409,
    'Połączenie zmieniono; rozpocznij nowy przegląd',
  );
  const tenant = (await c.query('SELECT currency FROM tenants WHERE id=$1', [actor.tenantId]))
    .rows[0];
  const rows = (
    await c.query(
      "SELECT * FROM catalog_source_items WHERE run_id=$1 AND id=ANY($2::uuid[]) ORDER BY (kind='group') DESC,id FOR UPDATE",
      [runId, b.items.map((v) => v.id)],
    )
  ).rows;
  ensure(rows.length === b.items.length, 404, 'Nie znaleziono pozycji tego importu');
  const results: any[] = [];
  const productEvents: CatalogProductEvent[] = [];
  for (const row of rows) {
    const input = b.items.find((v) => v.id === row.id)!,
      hash = sourceHash(input);
    ensure(row.source_hash === input.source_hash, 409, 'Źródło zmieniło się od podglądu');
    if (row.state === 'applied') {
      ensure(row.apply_hash === hash, 409, 'Pozycję już zatwierdzono z innymi ustawieniami');
      results.push({ ...row.result, reused: true });
      continue;
    }
    const catalog = await resolveProductCatalogInTx(c, input.catalog_id);
    await assertProductCatalogWarehouseInTx(c, catalog?.id ?? null, run.warehouse_id);
    ensure(
      Date.now() - new Date(row.captured_at).getTime() < 86400000,
      409,
      'Podgląd pozycji ma ponad 24 godziny; pobierz katalog ponownie',
    );
    const n = row.source;
    ensure(!n.unsupported, 422, 'Pozycja nie jest obsługiwanym produktem fizycznym');
    const sku = input.local_sku ?? n.sku;
    ensure(
      typeof sku === 'string' && sku.length > 0 && sku.length <= 80,
      422,
      'Podaj SKU do 80 znaków',
    );
    let parentId: null | string = null;
    if (row.kind === 'variant') {
      const parent = (
        await c.query(
          "SELECT product_id,state FROM catalog_source_items WHERE run_id=$1 AND external_id=$2 AND kind='group'",
          [run.id, row.parent_external_id],
        )
      ).rows[0];
      ensure(
        parent?.state === 'applied',
        422,
        'Najpierw importuj grupę wariantów albo zaznacz ją w tej samej partii',
      );
      parentId = parent.product_id;
    }
    const candidate = (await resolveProductSkus(c, [sku]))[0];
    let p = candidate
      ? (await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [candidate.id])).rows[0]
      : undefined;
    // A deleted product (225) keeps its SKU forever; the import never links or recreates it.
    if (p) await assertProductsNotDeletedInTx(c, [p.id]);
    if (catalog) await assertProductCatalogInTx(c, [p?.id, parentId].filter(Boolean), catalog.id);
    ensure(
      (p?.id ?? null) === input.expected_product_id &&
        (p?.version ?? null) === input.expected_version,
      409,
      'SKU lub jego wersja zmieniły się od podglądu; odśwież wyniki',
    );
    let action = 'linked';
    if (p) {
      ensure(
        p.kind === row.kind && (p.parent_id ?? null) === parentId,
        409,
        'SKU ma inny typ lub należy do innej grupy',
      );
    } else {
      const price = row.kind === 'group' ? 0 : (input.price_override ?? n.price);
      ensure(price !== null && Number.isInteger(price), 422, 'Podaj jawną cenę lokalną');
      ensure(
        row.kind === 'group' ||
          (n.currency ?? run.context.currency) === tenant.currency ||
          input.price_override !== undefined,
        422,
        'Waluta sklepu różni się od firmy; podaj cenę lokalną, bez niejawnego FX',
      );
      const quantity =
        row.kind === 'group' ? 0 : !run.import_stock ? 0 : (input.quantity_override ?? n.quantity);
      ensure(
        Number.isInteger(quantity) && quantity >= 0,
        422,
        'Podaj jednoznaczny stan początkowy lub importuj bez stanów',
      );
      p = await createProduct(
        c,
        actor,
        productSchema.parse({
          sku,
          name: n.name,
          ean: n.ean,
          price,
          vat: n.vat,
          category: n.category,
          description: n.description,
          attributes: n.attributes,
          images: n.images,
          active: n.active,
          kind: row.kind,
          ...(parentId ? { parent_id: parentId } : {}),
          warehouse_id: run.warehouse_id,
          ...(catalog ? { catalog_id: catalog.id } : {}),
          quantity,
        }),
        { deferProductRules: true },
      );
      productEvents.push({ product_id: p.id, event: 'product.created', cause_id: row.id });
      action = 'created';
    }
    let listing: any = null;
    if (row.kind !== 'group') {
      const offerParent = ['shopify', 'odoo', 'ebay', 'amazon'].includes(channel.provider)
        ? null
        : row.parent_external_id;
      const existing = (
        await c.query('SELECT * FROM listings WHERE channel_id=$1 AND external_id=$2 FOR UPDATE', [
          channel.id,
          row.external_id,
        ])
      ).rows[0];
      if (existing) {
        ensure(existing.product_id === p.id, 409, 'Oferta jest już powiązana z innym SKU');
        ensure(
          !existing.parent_external_id || existing.parent_external_id === offerParent,
          409,
          'Oferta ma inne powiązanie rodzica',
        );
        if ((existing.parent_external_id ?? null) !== offerParent) {
          ensure(
            !(
              await c.query(
                "SELECT id FROM offer_plans WHERE listing_id=$1 AND (state='queued' OR (state='failed' AND phase IN ('write_started','verify')))",
                [existing.id],
              )
            ).rowCount,
            409,
            'Trwa lub wymaga uzgodnienia zapis oferty',
          );
          await c.query('UPDATE listings SET parent_external_id=$2 WHERE id=$1', [
            existing.id,
            offerParent,
          ]);
        }
        listing = existing;
      } else
        listing = (
          await c.query(
            'INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,parent_external_id,warehouse_id,price,price_currency,status,last_result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
            [
              randomUUID(),
              actor.tenantId,
              channel.id,
              p.id,
              row.external_id,
              offerParent,
              run.warehouse_id,
              n.price ?? 0,
              n.currency ?? run.context.currency ?? tenant.currency,
              channel.settings.simulation ? 'simulation' : 'linked',
              JSON.stringify({
                stock_quantity: n.quantity,
                scope: channel.settings.simulation
                  ? 'local_simulation'
                  : 'external_read_local_write',
                catalog_run_id: run.id,
                ...(channel.provider === 'ebay'
                  ? {
                      ebay: n.ebay,
                      stock_scope: 'external_availability',
                      source_currency: n.currency,
                      source_price_known: n.price !== null,
                    }
                  : {}),
                ...(channel.provider === 'odoo'
                  ? { erp: n.erp, stock_scope: 'external_availability' }
                  : {}),
                ...(channel.provider === 'amazon'
                  ? {
                      amazon: n.amazon,
                      stock_scope: 'external_availability',
                      source_currency: n.currency,
                      source_price_known: n.price !== null,
                    }
                  : {}),
                ...(channel.provider === 'shopify'
                  ? {
                      sku: n.source_sku,
                      status: n.source_status,
                      taxable: n.taxable ?? n.vat !== 0,
                      prices_include_tax: run.context.prices_include_tax ? 'yes' : 'no',
                      regular_price: n.regular_price,
                      product_id: n.product_id,
                      inventory_item_id: n.inventory_item_id,
                    }
                  : {}),
              }),
            ],
          )
        ).rows[0];
    }
    const result = {
      entry_id: row.id,
      external_id: row.external_id,
      product_id: p.id,
      sku: p.sku,
      kind: p.kind,
      parent_id: p.parent_id,
      listing_id: listing?.id ?? null,
      action,
      local_price: p.price,
      local_currency: tenant.currency,
    };
    await c.query(
      "UPDATE catalog_source_items SET state='applied',product_id=$2,apply_hash=$3,result=$4,applied_at=now() WHERE id=$1",
      [row.id, p.id, hash, JSON.stringify(result)],
    );
    await audit(c, actor, 'catalog.source.apply', p.id, {
      run_id: run.id,
      external_id: row.external_id,
      action,
    });
    results.push(result);
  }
  await emitCatalogProductEvents(c, actor, productEvents);
  return {
    data: results,
    created: results.filter((v) => v.action === 'created' && !v.reused).length,
    linked: results.filter((v) => v.action === 'linked' && !v.reused).length,
  };
}
