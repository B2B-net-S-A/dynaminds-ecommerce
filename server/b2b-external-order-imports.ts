import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { b2bDropshipAccessInTx } from './b2b-network-dropshipping';
import {
  b2bExternalOrderIntentsAvailable,
  createB2bExternalOrderIntentFromImportInTx,
} from './b2b-external-order-intents';
import { orderSourceLinesAvailable } from './order-source-lines';
import {
  importOrder,
  normalizeOrder,
  importConnectionHash,
  stageOrders,
  importSourceHash,
  acquireOrderFieldObservationAdmissionInTx,
  type CanonicalOrder,
} from './imports';
import { commitShopifyOrder } from './shopify-order-read';
import { commitEbayOrder } from './ebay-order-sync';
import { commitAmazonOrder } from './amazon-order-sync';
import { commitOdooOrder } from './odoo-order-sync';
import { channelRead, type IntegrationContext } from './channel-access';
import { WooCommerce, Allegro, PrestaShop } from './integrations';
import { wmsLotsHash } from './wms-lots';
import * as S from './b2b-external-order-imports-schema';
export * from './b2b-external-order-imports-schema';
export { registerB2bExternalOrderImportRoutes } from './b2b-external-order-imports-routes';
type Row = Record<string, any>;
type PreviewInput = z.infer<typeof S.b2bExternalImportPreviewInput>;
export type PreparedExternalImport = {
  preview: Row;
  certificate_id: string;
  fragments: Array<{ id: string; product_id: string; quantity: number; line_total: number }>;
  allocations: Array<{
    customer_item_id: string;
    local_quantity: number;
    external_quantity: number;
    unassigned_quantity: number;
    link_id: string | null;
  }>;
};
export async function b2bExternalOrderImportsAvailable(c: Pool | PoolClient) {
  return (
    Boolean(
      (
        await c.query(`SELECT bool_and(to_regclass('public.'||n) IS NOT NULL)
    AND to_regprocedure('public.b2b_external_import_prepare(uuid,uuid,uuid,uuid,text,jsonb)') IS NOT NULL
    AND to_regprocedure('public.b2b_external_import_admitted(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_external_import_certify(uuid,uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_external_import_create_proof(uuid,uuid,uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_external_import_execution_request(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_external_import_finish(uuid,uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_external_import_key_grant(uuid,uuid,boolean,boolean)') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.orders') AND tgname='external_import_created' AND tgenabled<>'D')
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.b2b_external_import_previews') AND tgname='a_source_guard' AND tgenabled<>'D')
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.b2b_external_import_certificates') AND tgname='complete' AND tgenabled<>'D')
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.b2b_external_import_executions') AND tgname='source_guard' AND tgenabled<>'D') available
    FROM unnest(ARRAY['b2b_external_import_previews','b2b_external_import_executions','b2b_external_import_certificates']) n`)
      ).rows[0]?.available,
    ) &&
    (await b2bExternalOrderIntentsAvailable(c)) &&
    (await orderSourceLinesAvailable(c))
  );
}
const digest = (a: Actor, kind: string, id: string, input: unknown) =>
  wmsLotsHash({
    tenant_id: a.tenantId,
    actor_id: a.userId,
    api_key_id: a.apiKeyId ?? null,
    kind,
    id,
    input,
  });
async function integrationAccess(c: PoolClient, a: Actor, write: boolean, pin = false) {
  const grant = (
    await c.query('SELECT b2b_external_import_key_grant($1,$2,$3,$4) status', [
      a.userId,
      a.apiKeyId ?? null,
      write,
      pin,
    ])
  ).rows[0]?.status;
  ensure(grant !== 'invalid', 401, 'Klucz integracji wygasł lub został cofnięty');
  ensure(grant === 'ok', 403, 'Brak aktualnego scope integracji');
}
function publicProjection(v: any, canValue: boolean, parent = ''): any {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => publicProjection(x, canValue, parent));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) =>
            canValue ||
            (parent === 'meta' && k === 'total') ||
            (!k.endsWith('_minor') &&
              ![
                'total',
                'shipping_cost',
                'price',
                'line_total',
                'paid_amount',
                'payment_balance',
                'received',
                'amount_due',
                'amount_paid',
                'amount',
                'balance',
              ].includes(k)),
        )
        .map(([k, x]) => [k, publicProjection(x, canValue, k)]),
    );
  return v;
}
async function admission(c: PoolClient, a: Actor, write: boolean) {
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  await b2bDropshipAccessInTx(c, a, write);
  ensure(
    await b2bExternalOrderImportsAvailable(c),
    503,
    'Kopia nie obsługuje źródłowych intencji importu',
  );
  await integrationAccess(c, a, write);
  if (write) {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'b2b.external.import.proof:' + a.tenantId,
    ]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'b2b.external.intent.proof:' + a.tenantId,
    ]);
  }
}
async function finish(c: PoolClient, a: Actor, write: boolean, result: Row) {
  if (write) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const flags = await b2bDropshipAccessInTx(c, a, write, true);
  await integrationAccess(c, a, write, true);
  const canManage =
    flags.can_manage &&
    (!a.apiKeyId ||
      (
        await c.query('SELECT b2b_external_import_key_grant($1,$2,true,false) status', [
          a.userId,
          a.apiKeyId,
        ])
      ).rows[0]?.status === 'ok');
  const projected = publicProjection(result, flags.can_read_value);
  if (projected.preview) projected.preview.can_execute = projected.preview.can_execute && canManage;
  if (projected.data) for (const p of projected.data) p.can_execute = p.can_execute && canManage;
  return {
    ...projected,
    ...flags,
    can_read: true,
    can_manage: canManage,
    available: true,
    read_only: false,
  };
}
export async function externalImportReadAccessInTx(c: PoolClient, a: Actor) {
  await b2bDropshipAccessInTx(c, a, true);
  await integrationAccess(c, a, true);
}
export async function externalImportAdmissionInTx(c: PoolClient, a: Actor) {
  await admission(c, a, true);
}
export async function externalImportFinishInTx(c: PoolClient, a: Actor, result: Row) {
  return finish(c, a, true, result);
}
async function tx<T>(a: Actor, write: boolean, fn: (c: PoolClient) => Promise<T>) {
  try {
    return await tenantTx(
      a.tenantId,
      async (c) => {
        await admission(c, a, write);
        return finish(c, a, write, (await fn(c)) as Row);
      },
      { purchasingAdmission: write, wmsAdmission: 'read' },
    );
  } catch (e) {
    const error = e as { code?: string; message?: string };
    if (error.code === '23514' && error.message === 'Brak aktualnej zgody administratora')
      throw new Problem(403, 'Administrator utracił uprawnienia');
    if (error.code === 'P0001' && error.message?.startsWith('Limit historii źródłowych intencji'))
      throw new Problem(429, error.message);
    throw e;
  }
}
export function normalizeExternalImportOrder(channel: Row, raw: unknown): CanonicalOrder {
  const canonical = normalizeOrder(channel.provider, raw, channel.settings, true);
  ensure(
    canonical.items.every(
      (i) =>
        typeof i.remote_line_id === 'string' &&
        i.remote_line_id.length > 0 &&
        !/[\u0000-\u001f\u007f]/.test(i.remote_line_id),
    ) && new Set(canonical.items.map((i) => i.remote_line_id)).size === canonical.items.length,
    422,
    'Brak lub powtórzone rzeczywiste ID pozycji źródłowych',
  );
  ensure(canonical.blockers.length === 0, 422, canonical.blockers.join('; '));
  return canonical;
}
async function load(c: PoolClient, id: string, lock = false) {
  const inbound = (
    await c.query('SELECT * FROM inbound_orders WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id])
  ).rows[0];
  ensure(inbound, 404, 'Nie znaleziono własnego zamówienia źródłowego');
  const channel = (
    await c.query('SELECT * FROM channels WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [
      inbound.channel_id,
    ])
  ).rows[0];
  ensure(channel, 404, 'Nie znaleziono własnego kanału');
  return { inbound, channel };
}
async function frame(c: PoolClient, inbound: Row, channel: Row, canonical: CanonicalOrder) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + inbound.tenant_id,
  ]);
  const mappings = (
    await c.query(
      'SELECT id,channel_id,external_id,product_id FROM listings WHERE channel_id=$1 AND external_id=ANY($2::text[]) ORDER BY id FOR SHARE',
      [channel.id, canonical.items.map((i) => i.external_id)],
    )
  ).rows;
  const ids = [...new Set(mappings.map((m) => m.product_id))].sort();
  const products = (
    await c.query(
      'SELECT id,sku,name,version::text version,kind,active,vat FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [ids],
    )
  ).rows;
  const recipes = (
    await c.query(
      'SELECT bundle_id,product_id,quantity FROM bundle_components WHERE bundle_id=ANY($1::uuid[]) ORDER BY bundle_id,product_id',
      [ids],
    )
  ).rows;
  ensure(recipes.length <= 10000, 413, 'Za dużo składników w źródłowym zamówieniu');
  const physicalIDs = [
    ...new Set([
      ...products.filter((p) => p.kind !== 'bundle').map((p) => p.id),
      ...recipes.map((r) => r.product_id),
    ]),
  ].sort();
  const physical = (
    await c.query(
      'SELECT id,sku,name,version::text version,active,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [physicalIDs],
    )
  ).rows;
  const lines = canonical.items.map((i, index) => {
    const mapping = mappings.find((m) => m.external_id === i.external_id);
    ensure(mapping, 422, 'Brak jawnego mapowania oferty ' + i.external_id);
    const p = products.find((p) => p.id === mapping.product_id);
    ensure(p?.active && p.kind !== 'group', 422, 'Nieaktywny lub niefizyczny produkt źródłowy');
    const recipe =
      p.kind === 'bundle'
        ? recipes.filter((r) => r.bundle_id === p.id)
        : [{ product_id: p.id, quantity: 1 }];
    ensure(
      recipe.length > 0 && recipe.length <= 100,
      422,
      'Nieprawidłowa receptura źródłowej pozycji',
    );
    const components = recipe.map((r) => {
      const cp = physical.find((p) => p.id === r.product_id);
      ensure(
        cp?.active && ['simple', 'variant'].includes(cp.kind),
        422,
        'Nieaktywny fizyczny składnik',
      );
      return {
        product_id: cp.id,
        quantity: r.quantity,
        sku: cp.sku,
        name: cp.name,
        version: cp.version,
      };
    });
    return {
      source_index: index,
      remote_line_id: i.remote_line_id!,
      external_product_id: i.external_id,
      product_id: p.id,
      listing_id: mapping.id,
      sku: p.sku,
      name: p.name,
      quantity: i.quantity,
      price: Math.floor(i.line_total / i.quantity),
      line_total: i.line_total,
      vat: p.vat,
      product_version: p.version,
      components,
    };
  });
  return {
    canonical,
    mappings,
    products,
    physical,
    recipes,
    source: {
      inbound_id: inbound.id,
      channel_id: channel.id,
      provider: channel.provider,
      external_id: canonical.external_id,
      source_hash: inbound.source_hash,
      currency: canonical.currency,
      total: canonical.total,
      shipping_cost: canonical.shipping_cost,
      customer_name: canonical.customer_name,
      email: canonical.email,
      address: canonical.address,
      payment: {
        payment_mode: canonical.payment_mode,
        paid_amount: canonical.paid_amount,
        paid: canonical.paid,
        declaration_only: true,
      },
      lines,
    },
    connection_hash: importConnectionHash(channel),
  };
}
async function choices(c: PoolClient) {
  const warehouses = (await c.query('SELECT id,name,code FROM warehouses ORDER BY id LIMIT 201'))
    .rows;
  const links = (
    await c.query('SELECT id,supplier_name FROM b2b_links WHERE NOT paused ORDER BY id LIMIT 201')
  ).rows;
  return {
    warehouses: { data: warehouses.slice(0, 200), capped: warehouses.length > 200 },
    links: { data: links.slice(0, 200), capped: links.length > 200 },
  };
}
export async function b2bExternalImportSource(a: Actor, id: string) {
  return tx(a, false, async (c) => {
    const { inbound, channel } = await load(c, id);
    ensure(!inbound.order_id, 409, 'Zamówienie jest już zaimportowane');
    const f = await frame(c, inbound, channel, normalizeExternalImportOrder(channel, inbound.raw));
    return { source: f.source, ...(await choices(c)), limits: S.B2B_EXTERNAL_ORDER_IMPORT_LIMITS };
  });
}
function previewView(p: Row) {
  return {
    executed_order_id: p.executed_order_id ?? null,
    intent_id: p.intent_id ?? null,
    can_execute:
      !p.executed_order_id && !p.current_order_id && new Date(p.expires_at).getTime() > Date.now(),
    id: p.id,
    inbound_id: p.inbound_id,
    version: p.version,
    scope_hash: p.scope_hash,
    config: p.config,
    source: p.snapshot.source,
    rows: p.rows,
    created_at: p.created_at,
    expires_at: p.expires_at,
  };
}
async function validateConfig(c: PoolClient, f: Row, input: PreviewInput) {
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouse_id])).rowCount,
    404,
    'Nie znaleziono własnego magazynu',
  );
  ensure(
    input.allocations.length === f.source.lines.length,
    422,
    'Przydziel wszystkie pozycje źródłowe',
  );
  for (const line of f.source.lines) {
    const allocation = input.allocations.find((v) => v.remote_line_id === line.remote_line_id);
    ensure(
      allocation &&
        allocation.local_quantity +
          allocation.external_quantity +
          allocation.unassigned_quantity ===
          line.quantity,
      422,
      'Przydział narusza źródłową ilość',
    );
    if (allocation.link_id)
      ensure(
        (
          await c.query('SELECT id FROM b2b_links WHERE id=$1 AND NOT paused FOR SHARE', [
            allocation.link_id,
          ])
        ).rowCount,
        422,
        'Brak aktywnego własnego połączenia dostawcy',
      );
  }
}
export async function createB2bExternalImportPreview(a: Actor, id: string, input: PreviewInput) {
  return tx(a, true, async (c) => {
    const requestHash = digest(a, 'preview', id, input);
    const old = (
      await c.query(
        'SELECT p.*,e.order_id executed_order_id,e.intent_id,i.order_id current_order_id FROM b2b_external_import_previews p LEFT JOIN b2b_external_import_executions e ON(e.tenant_id,e.preview_id)=(p.tenant_id,p.id) JOIN inbound_orders i ON(i.tenant_id,i.id)=(p.tenant_id,p.inbound_id) WHERE p.client_key=$1',
        [input.client_key],
      )
    ).rows[0];
    if (old) {
      ensure(old.request_hash === requestHash, 409, 'Klucz należy do innej treści lub aktora');
      return { preview: previewView(old), reused: true };
    }
    const { inbound, channel } = await load(c, id, true);
    ensure(!inbound.order_id, 409, 'Zamówienie jest już zaimportowane');
    ensure(
      inbound.source_hash === input.expected_source_hash,
      409,
      'Źródło zmieniło się przed podglądem',
    );
    const f = await frame(c, inbound, channel, normalizeExternalImportOrder(channel, inbound.raw));
    await validateConfig(c, f, input);
    const links = (
      await c.query('SELECT id,supplier_name FROM b2b_links WHERE id=ANY($1::uuid[])', [
        input.allocations.flatMap((v) => (v.link_id ? [v.link_id] : [])),
      ])
    ).rows;
    const rows = f.source.lines.map((line) => {
      const alloc = input.allocations.find((v) => v.remote_line_id === line.remote_line_id)!;
      return {
        ...line,
        customer_item_id: randomUUID(),
        ...alloc,
        supplier_name: links.find((l) => l.id === alloc.link_id)?.supplier_name ?? null,
      };
    });
    const warehouse = (
      await c.query('SELECT name FROM warehouses WHERE id=$1', [input.warehouse_id])
    ).rows[0];
    const config = {
      warehouse_id: input.warehouse_id,
      warehouse_name: warehouse.name,
      allocations: input.allocations,
    };
    const scopeHash = wmsLotsHash({ snapshot: f, config, rows });
    const p = (
      await c.query(
        'INSERT INTO b2b_external_import_previews(tenant_id,id,inbound_id,channel_id,actor_id,api_key_id,client_key,request_hash,initial_request,scope_hash,config,snapshot,rows) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *',
        [
          a.tenantId,
          randomUUID(),
          id,
          channel.id,
          a.userId,
          a.apiKeyId ?? null,
          input.client_key,
          requestHash,
          JSON.stringify(input),
          scopeHash,
          JSON.stringify(config),
          JSON.stringify(f),
          JSON.stringify(rows),
        ],
      )
    ).rows[0];
    await audit(c, a, 'b2b.external.import.preview', p.id, { inbound_id: id });
    return { preview: previewView(p), reused: false };
  });
}
export async function b2bExternalImportPreviewDetail(a: Actor, id: string) {
  return tx(a, false, async (c) => {
    const p = (
      await c.query(
        'SELECT p.*,e.order_id executed_order_id,e.intent_id,i.order_id current_order_id FROM b2b_external_import_previews p LEFT JOIN b2b_external_import_executions e ON(e.tenant_id,e.preview_id)=(p.tenant_id,p.id) JOIN inbound_orders i ON(i.tenant_id,i.id)=(p.tenant_id,p.inbound_id) WHERE p.id=$1',
        [id],
      )
    ).rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu');
    return { preview: previewView(p) };
  });
}
export async function b2bExternalImportHistory(
  a: Actor,
  q: z.infer<typeof S.b2bExternalImportPageQuery>,
) {
  return tx(a, false, async (c) => {
    const data = (
      await c.query(
        'SELECT p.*,e.order_id executed_order_id,e.intent_id,i.order_id current_order_id FROM b2b_external_import_previews p LEFT JOIN b2b_external_import_executions e ON(e.tenant_id,e.preview_id)=(p.tenant_id,p.id) JOIN inbound_orders i ON(i.tenant_id,i.id)=(p.tenant_id,p.inbound_id) WHERE ($1::uuid IS NULL OR p.id>$1) AND ($3::uuid IS NULL OR p.inbound_id=$3) ORDER BY p.id LIMIT $2',
        [q.cursor ?? null, q.limit + 1, q.inbound_id ?? null],
      )
    ).rows;
    return {
      data: data.slice(0, q.limit).map(previewView),
      meta: {
        cursor: data.length > q.limit ? data[q.limit - 1].id : null,
        total: Number(
          (
            await c.query(
              'SELECT count(*) n FROM b2b_external_import_previews WHERE ($1::uuid IS NULL OR inbound_id=$1)',
              [q.inbound_id ?? null],
            )
          ).rows[0].n,
        ),
      },
    };
  });
}
export async function externalImportReplayInTx(
  c: PoolClient,
  a: Actor,
  inboundId: string,
  consent: S.ExternalImportConsent,
) {
  const old = (
    await c.query('SELECT * FROM b2b_external_import_executions WHERE client_key=$1', [
      consent.client_key,
    ])
  ).rows[0];
  if (!old) return null;
  const body = {
    client_key: consent.client_key,
    version: consent.version,
    scope_hash: consent.scope_hash,
    confirmed: consent.confirmed,
  };
  ensure(
    old.request_hash === digest(a, 'execute', consent.preview_id, body) &&
      old.preview_id === consent.preview_id &&
      old.inbound_id === inboundId,
    409,
    'Klucz wykonania należy do innej treści lub aktora',
  );
  const { getOrder } = await import('./domain');
  // Read inside this transaction; do not call public wrappers (they create a new TX).
  const p = (
    await c.query(
      'SELECT p.*,$2::uuid executed_order_id,$3::uuid intent_id FROM b2b_external_import_previews p WHERE id=$1',
      [old.preview_id, old.order_id, old.intent_id],
    )
  ).rows[0];
  const h = (
    await c.query(
      'SELECT id,order_id,version,state,original_items,allocations,created_at,updated_at FROM b2b_external_order_intents WHERE id=$1',
      [old.intent_id],
    )
  ).rows[0];
  return {
    preview: previewView(p),
    intent: {
      id: h.id,
      order_id: h.order_id,
      version: h.version,
      state: h.state,
      created_at: h.created_at,
      updated_at: h.updated_at,
      items: h.original_items.map((i: Row) => ({
        customer_item_id: i.id,
        product_id: i.product_id,
        sku: i.sku,
        name: i.name,
        quantity: i.quantity,
        components: i.components,
        ...h.allocations.find((v: Row) => v.customer_item_id === i.id),
      })),
    },
    order: await getOrder(c, old.order_id),
    reused: true,
  };
}
export async function prepareB2bExternalImportInTx(
  c: PoolClient,
  a: Actor,
  inbound: Row,
  channel: Row,
  canonical: CanonicalOrder,
  warehouseId: string,
  consent: S.ExternalImportConsent,
): Promise<PreparedExternalImport> {
  const p = (
    await c.query(
      'SELECT *,expires_at>clock_timestamp() live FROM b2b_external_import_previews WHERE id=$1',
      [consent.preview_id],
    )
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu importu');
  ensure(
    p.actor_id === a.userId && (p.api_key_id ?? null) === (a.apiKeyId ?? null),
    403,
    'Podgląd należy do innego aktora',
  );
  ensure(
    p.inbound_id === inbound.id &&
      p.version === consent.version &&
      p.scope_hash === consent.scope_hash &&
      p.config.warehouse_id === warehouseId &&
      p.live,
    409,
    'Podgląd jest nieaktualny',
  );
  const f = await frame(c, inbound, channel, canonical);
  ensure(
    wmsLotsHash(f) === wmsLotsHash(p.snapshot),
    409,
    'Źródło, mapowanie lub receptura zmieniły się po podglądzie',
  );
  await validateConfig(c, f, { ...p.initial_request, warehouse_id: warehouseId });
  const body = {
    client_key: consent.client_key,
    version: consent.version,
    scope_hash: consent.scope_hash,
    confirmed: consent.confirmed,
  };
  await b2bDropshipAccessInTx(c, a, true);
  await integrationAccess(c, a, true);
  const certificate = (
    await c.query('SELECT b2b_external_import_prepare($1,$2,$3,$4,$5,$6) id', [
      p.id,
      a.userId,
      a.apiKeyId ?? null,
      consent.client_key,
      digest(a, 'execute', p.id, body),
      JSON.stringify(body),
    ])
  ).rows[0].id;
  return {
    preview: p,
    certificate_id: certificate,
    fragments: p.rows.map((r: Row) => ({
      id: r.customer_item_id,
      product_id: r.product_id,
      quantity: r.quantity,
      line_total: r.line_total,
    })),
    allocations: p.rows.map((r: Row) => ({
      customer_item_id: r.customer_item_id,
      local_quantity: r.local_quantity,
      external_quantity: r.external_quantity,
      unassigned_quantity: r.unassigned_quantity,
      link_id: r.link_id,
    })),
  };
}
export async function completeB2bExternalImportInTx(
  c: PoolClient,
  a: Actor,
  p: PreparedExternalImport,
  order: Row,
) {
  const { inbound, channel } = await load(c, p.preview.inbound_id);
  const current = await frame(
    c,
    inbound,
    channel,
    normalizeExternalImportOrder(channel, inbound.raw),
  );
  ensure(
    wmsLotsHash(current) === wmsLotsHash(p.preview.snapshot),
    409,
    'Ceny VAT lub receptura zmieniły się podczas importu',
  );
  await b2bDropshipAccessInTx(c, a, true);
  await integrationAccess(c, a, true);
  await c.query('SELECT b2b_external_import_certify($1,$2)', [p.certificate_id, order.id]);
  const cert = (
    await c.query('SELECT client_key,request FROM b2b_external_import_execution_request($1)', [
      p.certificate_id,
    ])
  ).rows[0];
  const result = await createB2bExternalOrderIntentFromImportInTx(c, a, {
    order_id: order.id,
    client_key: cert.client_key,
    initial_request: {
      ...cert.request,
      source_preview_id: p.preview.id,
      source_certificate_id: p.certificate_id,
      allocations: p.allocations,
    },
    allocations: p.allocations,
    source_certificate_id: p.certificate_id,
  });
  await c.query('SELECT b2b_external_import_finish($1,$2)', [p.certificate_id, result.intent.id]);
  return {
    preview: previewView({
      ...p.preview,
      executed_order_id: order.id,
      intent_id: result.intent.id,
    }),
    ...result,
    reused: false,
  };
}
export async function executeB2bExternalImport(
  a: Actor,
  id: string,
  input: z.infer<typeof S.b2bExternalImportExecuteInput>,
  ctx: IntegrationContext = {},
) {
  const p = await tx(a, true, async (c) => {
    const preview = (await c.query('SELECT * FROM b2b_external_import_previews WHERE id=$1', [id]))
      .rows[0];
    ensure(preview, 404, 'Nie znaleziono podglądu');
    return { preview };
  });
  const consent = { ...input, preview_id: id };
  const ready = await tx(a, true, (c) =>
    externalImportReplayInTx(c, a, p.preview.inbound_id, consent).then((result) => ({ result })),
  );
  if (ready.result)
    return {
      ...ready.result,
      available: true,
      read_only: false,
      current_role: ready.current_role,
      can_manage: ready.can_manage,
      can_read: ready.can_read,
      can_read_value: ready.can_read_value,
    };
  const options = { externalImportConsent: consent };
  const provider = p.preview.snapshot.source.provider;
  if (provider === 'shopify')
    return commitShopifyOrder(
      a,
      p.preview.inbound_id,
      p.preview.config.warehouse_id,
      p.preview.snapshot.source.source_hash,
      ctx,
      options,
    );
  if (provider === 'ebay')
    return commitEbayOrder(
      a,
      p.preview.inbound_id,
      p.preview.config.warehouse_id,
      p.preview.snapshot.source.source_hash,
      ctx,
      options,
    );
  if (provider === 'amazon')
    return commitAmazonOrder(
      a,
      p.preview.inbound_id,
      p.preview.config.warehouse_id,
      p.preview.snapshot.source.source_hash,
      ctx,
      options,
    );
  if (provider === 'odoo')
    return commitOdooOrder(
      a,
      p.preview.inbound_id,
      p.preview.config.warehouse_id,
      p.preview.snapshot.source.source_hash,
      ctx,
      options,
    );
  const initial = await tenantTx(a.tenantId, async (c) => {
    await b2bDropshipAccessInTx(c, a, true);
    await integrationAccess(c, a, true);
    return load(c, p.preview.inbound_id);
  });
  const connection = importConnectionHash(initial.channel);
  if (!initial.channel.settings.simulation) {
    const latest = await channelRead(
      a.tenantId,
      initial.channel.id,
      (client) => {
        if (client instanceof WooCommerce) return client.order(Number(initial.inbound.external_id));
        if (client instanceof Allegro || client instanceof PrestaShop)
          return client.order(initial.inbound.external_id);
        throw new Problem(422, 'Brak obsługi odczytu tego źródła');
      },
      ctx,
      true,
      async (ch) => {
        await tenantTx(a.tenantId, async (c) => {
          await b2bDropshipAccessInTx(c, a, true);
          await integrationAccess(c, a, true);
          ensure(importConnectionHash(ch) === connection, 409, 'Połączenie źródłowe zmieniło się');
        });
      },
    );
    const changed = await tenantTx(a.tenantId, async (c) => {
      await b2bDropshipAccessInTx(c, a, true);
      await integrationAccess(c, a, true);
      await acquireOrderFieldObservationAdmissionInTx(c, a, provider);
      const live = await load(c, initial.inbound.id, true);
      ensure(
        live.inbound.source_hash === initial.inbound.source_hash,
        409,
        'Kolejka zmieniła się podczas odczytu',
      );
      if (importSourceHash(latest) === live.inbound.source_hash) return false;
      await stageOrders(c, a, live.channel, [latest]);
      return true;
    });
    ensure(!changed, 409, 'Źródło zmieniło zamówienie; odczytaj i zatwierdź nowy podgląd');
  }
  return importOrder(
    a,
    initial.inbound.id,
    p.preview.config.warehouse_id,
    p.preview.snapshot.source.source_hash,
    connection,
    options,
  );
}
