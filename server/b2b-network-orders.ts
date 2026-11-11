import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from './domain';
import { ensure } from './errors';
import { quoteB2b, checkoutB2b } from './b2b';
import {
  networkTx as tx,
  networkScope as scope,
  networkLink as ownLink,
  networkSource as source,
  networkAdmin as admin,
} from './b2b-network';
import { createWarehouseDocument, postWarehouseDocument, warehouseSchema } from './warehouse';
import { documentBody } from './portal-view';
import { paymentBalance } from './payments';
import { orderMergeBuyerPaymentBalanceInTx } from './order-merge-payments';
import { productCatalogsAvailable } from './product-catalogs';
import {
  guardB2BCatalogPairInTx,
  assertB2BBuyerCatalogItemsInTx,
  assertB2BBuyerCatalogWarehouseInTx,
  type B2BCatalogPair,
  b2bCatalogScopeMetadataPresent,
} from './b2b-catalog-scope-adapters';
import { registerB2bNetworkLifecycleRoutes } from './b2b-network-lifecycle';
import { registerB2bNetworkMappingRoutes, unboundItemIdsInTx } from './b2b-network-mappings';
import { registerB2bNetworkDecisionRoutes, openNetworkDecisionInTx, networkDecisionViewInTx } from './b2b-network-decisions';

const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const unique = <T>(rows: T[], key: (r: T) => string) => new Set(rows.map(key)).size === rows.length;
const quoteInput = z
  .object({
    client_key: z.uuid(),
    warehouse_id: z.uuid(),
    items: z
      .array(
        z.object({ item_id: z.uuid(), quantity: z.number().int().min(1).max(100000) }).strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine((b) => unique(b.items, (i) => i.item_id), 'Produkt występuje więcej niż raz');
const confirm = z.object({ confirmed: z.literal(true) }).strict();
const receiptInput = z
  .object({
    client_key: z.uuid(),
    version: z.number().int().positive(),
    confirmed: z.literal(true),
    lines: z
      .array(
        z
          .object({
            product_id: z.uuid(),
            quantity: z.number().int().min(1).max(100000),
            location: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine((b) => unique(b.lines, (i) => i.product_id), 'Produkt występuje więcej niż raz');
// Acquire both catalogs in one global order before any list/product locks. This also
// prevents reciprocal buyer/supplier purchases from reversing advisory lock order.
async function catalogs(c: PoolClient, tenants: string[]) {
  for (const tenant of [...new Set(tenants)].sort())
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
      'catalog:' + tenant,
    ]);
}
async function linkCatalogLocks(c: PoolClient, tenant: string, linkId: string) {
  const ref = (await c.query('SELECT supplier_tenant_id FROM b2b_links WHERE tenant_id=$1 AND id=$2', [tenant, linkId])).rows[0];
  ensure(ref, 404, 'Nie znaleziono połączenia B2B');
  await catalogs(c, [tenant, ref.supplier_tenant_id]);
  return ref.supplier_tenant_id;
}
async function freshCatalogPair(c: PoolClient, tenant: string, linkId: string, expected?: B2BCatalogPair) {
  if (await productCatalogsAvailable(c))
    return guardB2BCatalogPairInTx(c, { tenantId: tenant, linkId, expected });
  ensure(!(await b2bCatalogScopeMetadataPresent(c)), 503, 'Zakres B2B wymaga katalogów produktów');
  ensure(!expected, 409, 'Wycena wymaga katalogów produktów');
  return null;
}
function publicNetworkQuote(q: any) {
  const { catalog_scope: _proof, ...summary } = q.summary;
  return { ...q, summary };
}
async function localProducts(
  c: PoolClient,
  warehouse: string,
  ids: string[],
  requireActive = true,
) {
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1 FOR SHARE', [warehouse])).rowCount,
    404,
    'Nie znaleziono magazynu odbiorcy',
  );
  const ps = (
    await c.query(
      'SELECT id,active,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [ids],
    )
  ).rows;
  ensure(
    ps.length === ids.length && unique(ids, (id) => id),
    409,
    'Powiązanie z lokalnymi produktami jest nieprawidłowe',
  );
  ensure(
    ps.every((p) => (!requireActive || p.active) && ['simple', 'variant'].includes(p.kind)),
    409,
    'Zakup wymaga aktywnych fizycznych produktów w Twoim katalogu',
  );
}
async function ownOrder(c: PoolClient, id: string, lock = false) {
  const o = (
    await c.query('SELECT * FROM b2b_network_orders WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [
      id,
    ])
  ).rows[0];
  ensure(o, 404, 'Nie znaleziono zakupu B2B');
  return o;
}
// Keep supplier custody and buyer commerce separate after a merge. Internal origin headers
// are used only for admission; never serialize them into the purchasing firm's response.
export async function networkSupplierBuyerOrder(c: PoolClient, o: any, lock = false) {
  await scope(c, o.supplier_tenant_id);
  const current = (
    await c.query('SELECT * FROM orders WHERE id=$1 FOR ' + (lock ? 'UPDATE' : 'SHARE'), [
      o.source_order_id,
    ])
  ).rows[0];
  ensure(current, 404, 'Nie znaleziono zamówienia dostawcy');
  const tables = (
    await c.query(`SELECT to_regclass('public.order_merge_origins') IS NOT NULL AS origins,
    to_regclass('public.order_merge_executions') IS NOT NULL AS executions`)
  ).rows[0];
  ensure(
    tables.origins === tables.executions,
    503,
    'Historia zamówień dostawcy jest niekompletna w tej kopii',
  );
  let origin: any = null;
  if (tables.origins) {
    ensure(
      !(
        await c.query(
          "SELECT 1 FROM order_merge_executions WHERE target_order_id=$1 AND merge_mode='technical_merge' LIMIT 1",
          [o.source_order_id],
        )
      ).rowCount,
      404,
      'Nie znaleziono zamówienia dostawcy',
    );
    origin =
      (
        await c.query('SELECT header,items FROM order_merge_origins WHERE order_id=$1', [
          o.source_order_id,
        ])
      ).rows[0] ?? null;
  }
  const header = origin?.header ?? current;
  ensure(header.b2b_account_id === o.account_id, 404, 'Nie znaleziono zamówienia dostawcy');
  ensure(header.currency === o.currency, 409, 'Waluta źródłowego zakupu jest niezgodna');
  return { header, origin };
}
async function fulfillment(c: PoolClient, o: any, lock = false) {
  await scope(c, o.supplier_tenant_id);
  const { header: s, origin } = await networkSupplierBuyerOrder(c, o, lock);
  if (origin) {
    const { balance, payment_as_of_merge } = await orderMergeBuyerPaymentBalanceInTx(c, s.id);
    const payments = Object.fromEntries(
      [
        'currency',
        'payment_mode',
        'received',
        'refunded',
        'credit',
        'amount_due',
        'overpayment',
      ].map((key) => [key, (balance as any)[key]]),
    );
    await scope(c, o.tenant_id);
    return {
      status: s.status,
      status_label: 'Zamówienie źródłowe — historia po połączeniu',
      payment_mode: s.payment_mode,
      payments,
      payment_as_of_merge,
      historical: true,
      read_only: true,
      shipments: [],
      documents: [],
      returned: [],
    };
  }
  const shipments = (
    await c.query(
      'SELECT carrier,tracking_number,status,mode,dispatched_at FROM shipments WHERE order_id=$1 ORDER BY id LIMIT 100',
      [s.id],
    )
  ).rows;
  const documents = (
    await c.query(
      'SELECT id,number,kind,mode,created_at FROM documents WHERE order_id=$1 ORDER BY created_at,id LIMIT 100',
      [s.id],
    )
  ).rows;
  const label = s.workflow_status_id
    ? (await c.query('SELECT name FROM workflow_statuses WHERE id=$1', [s.workflow_status_id]))
        .rows[0]?.name
    : null;
  // A partial return can leave the original OMS status unchanged. Accepted quantities
  // therefore reduce the ceiling for receipts independently of the displayed status.
  const returned = (
    await c.query(
      `SELECT i.product_id,coalesce(sum(r.accepted),0)::int quantity FROM order_items i LEFT JOIN return_items r ON(r.tenant_id,r.order_id,r.item_id)=(i.tenant_id,i.order_id,i.id) WHERE i.order_id=$1 GROUP BY i.product_id`,
      [s.id],
    )
  ).rows;
  const balance = await paymentBalance(c, s.id);
  const payments = Object.fromEntries(
    ['currency', 'payment_mode', 'received', 'refunded', 'credit', 'amount_due', 'overpayment'].map(
      (key) => [key, (balance as any)[key]],
    ),
  );
  await scope(c, o.tenant_id);
  return {
    status: s.status,
    status_label: label ?? s.status,
    payment_mode: s.payment_mode,
    payments,
    shipments,
    documents,
    returned,
  };
}
async function detail(c: PoolClient, o: any) {
  const lines = (
    await c.query(
      "SELECT l.*,coalesce((SELECT sum(x.quantity-x.recovered) FROM b2b_network_return_lines x JOIN b2b_network_returns r ON(r.tenant_id,r.id)=(x.tenant_id,x.return_id) WHERE x.order_id=l.order_id AND x.product_id=l.product_id AND r.state<>'cancelled'),0)::int AS return_committed FROM b2b_network_order_lines l WHERE l.order_id=$1 ORDER BY l.sku,l.product_id",
      [o.id],
    )
  ).rows;
  const receipts = await receiptPage(c, o.id);
  const sourceFulfillment = await fulfillment(c, o);
  // 251 (B2B-004-X): the supplier's acceptance, rejection or expiry of this purchase.
  const decision = await networkDecisionViewInTx(c, o.id);
  return {
    ...o,
    ...(sourceFulfillment.read_only
      ? {
          read_only: true,
          historical: true,
          payment_as_of_merge: sourceFulfillment.payment_as_of_merge,
        }
      : {}),
    lines,
    receipts: receipts.data,
    receipts_next: receipts.next,
    fulfillment: sourceFulfillment,
    decision,
  };
}
async function receiptPage(c: PoolClient, order: string, after?: string) {
  const rows = (
    await c.query(
      'SELECT r.id,r.document_id,r.created_at,d.number FROM b2b_network_receipts r JOIN warehouse_documents d ON(d.tenant_id,d.id)=(r.tenant_id,r.document_id) WHERE r.order_id=$1 AND ($2::uuid IS NULL OR r.id<$2) ORDER BY r.id DESC LIMIT 26',
      [order, after ?? null],
    )
  ).rows;
  return { data: rows.slice(0, 25), next: rows.length > 25 ? rows[24].id : null };
}
export function registerB2bNetworkOrderRoutes(
  app: FastifyInstance,
  printLayout: (title: string, body: string, nativeProforma?: boolean) => string,
) {
  const root = '/api/b2b/network/links/:linkId';
  const id = (r: any, name: string) => z.uuid().parse(r.params[name]);
  // 251 (B2B-002/003/004-X): link lifecycle, mapping lifecycle and supplier decisions.
  registerB2bNetworkLifecycleRoutes(app);
  registerB2bNetworkMappingRoutes(app);
  registerB2bNetworkDecisionRoutes(app);
  app.post(root + '/quotes', async (r) => {
    const a = r.actor,
      b = quoteInput.parse(r.body),
      input = {
        warehouse_id: b.warehouse_id,
        items: [...b.items].sort((x, y) => x.item_id.localeCompare(y.item_id)),
      },
      hash = fingerprint(input);
    return tx(a.tenantId, async (c) => {
      await admin(c, a);
      const supplierTenant = await linkCatalogLocks(c, a.tenantId, id(r, 'linkId'));
      const l = await ownLink(c, id(r, 'linkId'));
      ensure(l.supplier_tenant_id === supplierTenant, 409, 'Dostawca zmienił się podczas blokowania katalogów');
      const old = (
        await c.query('SELECT * FROM b2b_network_quotes WHERE link_id=$1 AND client_key=$2', [
          l.id,
          b.client_key,
        ])
      ).rows[0];
      if (old) {
        ensure(old.fingerprint === hash, 409, 'Klucz wyceny użyto z innym koszykiem lub magazynem');
        return publicNetworkQuote(old);
      }
      const pair = await freshCatalogPair(c, a.tenantId, l.id);
      if (pair) await assertB2BBuyerCatalogWarehouseInTx(c, pair.buyer, b.warehouse_id);
      const selectedItems = (
        await c.query(
          'SELECT * FROM b2b_catalog_items WHERE tenant_id=$3 AND link_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
          [l.id, input.items.map((i) => i.item_id), a.tenantId],
        )
      ).rows;
      ensure(
        selectedItems.length === input.items.length && selectedItems.every((i) => i.published && i.product_id),
        409,
        'Najpierw zaimportuj aktualną ofertę do swojego katalogu',
      );
      ensure(!(await unboundItemIdsInTx(c, selectedItems.map((i) => i.id))).size, 409, 'Powiązanie oferty z własnym produktem zostało odpięte; powiąż je ponownie');
      const items = pair ? await assertB2BBuyerCatalogItemsInTx(c, pair, input.items.map(i => i.item_id), true, true) : selectedItems;
      await localProducts(
        c,
        b.warehouse_id,
        items.map((i) => i.product_id),
      );
      const s = await source(c, l);
      const q = await quoteB2b(c, s.account, {
        client_key: randomUUID(),
        items: input.items.map((i) => ({
          product_id: items.find((x) => x.id === i.item_id)!.source_product_id,
          quantity: i.quantity,
        })),
      });
      const ps = (
        await c.query('SELECT id,sku,name,vat FROM products WHERE id=ANY($1::uuid[]) ORDER BY id', [
          items.map((i) => i.source_product_id),
        ])
      ).rows;
      const mapped = input.items.map((i) => {
        const row = items.find((x) => x.id === i.item_id)!;
        const p = ps.find((x) => x.id === row.source_product_id)!;
        return {
          ...i,
          product_id: row.product_id,
          source_product_id: p.id,
          sku: p.sku,
          name: pair && (pair.buyer.mode !== 'legacy_default' || pair.supplier.mode !== 'legacy_default') ? row.snapshot.name : p.name,
          vat: p.vat,
          unit_gross: q.pricing.items.find((x: any) => x.product_id === p.id).price,
        };
      });
      const summary = {
        ...(pair ? { catalog_scope: pair } : {}),
        currency: q.pricing.currency,
        total_gross: q.total,
        shipping_gross: s.account.shipping_cost,
        payment_mode: s.account.payment_mode,
        address: s.account.address,
        items: mapped,
      };
      await scope(c, a.tenantId);
      const own = (
        await c.query(
          'INSERT INTO b2b_network_quotes(id,tenant_id,link_id,client_key,fingerprint,supplier_tenant_id,source_quote_id,link_version,warehouse_id,input,summary,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
          [
            randomUUID(),
            a.tenantId,
            l.id,
            b.client_key,
            hash,
            l.supplier_tenant_id,
            q.id,
            l.version,
            b.warehouse_id,
            JSON.stringify(input),
            JSON.stringify(summary),
            q.expires_at,
          ],
        )
      ).rows[0];
      await audit(c, a, 'b2b.network.quote', own.id, { link_id: l.id });
      return publicNetworkQuote(own);
    });
  });
  app.post(root + '/quotes/:quoteId/checkout', async (r) => {
    confirm.parse(r.body);
    const a = r.actor;
    return tx(a.tenantId, async (c) => {
      await admin(c, a);
      const supplierTenant = await linkCatalogLocks(c, a.tenantId, id(r, 'linkId'));
      const l = await ownLink(c, id(r, 'linkId'));
      ensure(l.supplier_tenant_id === supplierTenant, 409, 'Dostawca zmienił się podczas blokowania katalogów');
      const q = (
        await c.query('SELECT * FROM b2b_network_quotes WHERE id=$1 AND link_id=$2 FOR UPDATE', [
          id(r, 'quoteId'),
          l.id,
        ])
      ).rows[0];
      ensure(q, 404, 'Nie znaleziono wyceny zakupu');
      const old = (await c.query('SELECT * FROM b2b_network_orders WHERE quote_id=$1', [q.id]))
        .rows[0];
      if (old) return detail(c, old);
      ensure(q.link_version === l.version, 409, 'Połączenie zmieniło się; przygotuj nową wycenę');
      const pair = await freshCatalogPair(c, a.tenantId, l.id, q.summary.catalog_scope);
      ensure(q.summary.catalog_scope || !pair || (pair.buyer.mode === 'legacy_default' && pair.supplier.mode === 'legacy_default'),
        409, 'Wycena nie potwierdza zakresu katalogów; przygotuj nową');
      await localProducts(
        c,
        q.warehouse_id,
        q.summary.items.map((i: any) => i.product_id),
      );
      if (pair) {
        await assertB2BBuyerCatalogWarehouseInTx(c, pair.buyer, q.warehouse_id);
        await assertB2BBuyerCatalogItemsInTx(c, pair, q.summary.items.map((i: any) => i.item_id), true, true);
      }
      const mappings = (
        await c.query(
          'SELECT id,product_id,source_product_id,published FROM b2b_catalog_items WHERE link_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',
          [l.id, q.summary.items.map((i: any) => i.item_id)],
        )
      ).rows;
      ensure(
        q.summary.items.every((i: any) =>
          mappings.some(
            (m) =>
              m.id === i.item_id &&
              m.product_id === i.product_id &&
              m.source_product_id === i.source_product_id &&
              m.published,
          ),
        ),
        409,
        'Oferta lub powiązanie produktu zmieniły się',
      );
      ensure(!(await unboundItemIdsInTx(c, mappings.map((m) => m.id))).size, 409, 'Powiązanie oferty z własnym produktem zostało odpięte; powiąż je ponownie');
      const s = await source(c, l),
        order = await checkoutB2b(c, s.account, q.source_quote_id, 'network');
      await scope(c, a.tenantId);
      const own = (
        await c.query(
          'INSERT INTO b2b_network_orders(id,tenant_id,link_id,quote_id,supplier_tenant_id,source_order_id,account_id,warehouse_id,source_number,currency,total_gross,shipping_gross) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
          [
            randomUUID(),
            a.tenantId,
            l.id,
            q.id,
            l.supplier_tenant_id,
            order.id,
            l.account_id,
            q.warehouse_id,
            order.number,
            q.summary.currency,
            q.summary.total_gross,
            q.summary.shipping_gross,
          ],
        )
      ).rows[0];
      for (const i of q.summary.items)
        await c.query(
          'INSERT INTO b2b_network_order_lines(tenant_id,order_id,product_id,source_product_id,sku,name,vat,unit_gross,quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            a.tenantId,
            own.id,
            i.product_id,
            i.source_product_id,
            i.sku,
            i.name,
            i.vat,
            i.unit_gross,
            i.quantity,
          ],
        );
      // 251 (B2B-004-X): the supplier accepts or rejects within the decision window; the reservation holds until then.
      await openNetworkDecisionInTx(c, own);
      await audit(c, a, 'b2b.network.checkout', own.id, {
        link_id: l.id,
        source_order_id: order.id,
      });
      return detail(c, own);
    });
  });
  app.get(root + '/orders', async (r) =>
    tx(r.actor.tenantId, async (c) => {
      const l = await ownLink(c, id(r, 'linkId')),
        q = z.object({ after: z.uuid().optional() }).strict().parse(r.query);
      const rows = (
        await c.query(
          'SELECT * FROM b2b_network_orders WHERE link_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 26',
          [l.id, q.after ?? null],
        )
      ).rows;
      return { data: rows.slice(0, 25), next: rows.length > 25 ? rows[24].id : null };
    }),
  );
  const orders = '/api/b2b/network/orders/:orderId';
  app.get(orders, async (r) =>
    tx(r.actor.tenantId, async (c) => detail(c, await ownOrder(c, id(r, 'orderId')))),
  );
  app.get(orders + '/receipts', async (r) =>
    tx(r.actor.tenantId, async (c) => {
      const o = await ownOrder(c, id(r, 'orderId')),
        q = z.object({ after: z.uuid().optional() }).strict().parse(r.query);
      return receiptPage(c, o.id, q.after);
    }),
  );
  app.get(orders + '/documents/:documentId/print', async (r, reply) => {
    const d = await tx(r.actor.tenantId, async (c) => {
      const o = await ownOrder(c, id(r, 'orderId'));
      await scope(c, o.supplier_tenant_id);
      const sourceOrder = await networkSupplierBuyerOrder(c, o);
      ensure(
        !sourceOrder.origin,
        409,
        'Dokument historycznego źródła wymaga uzgodnienia z dostawcą',
      );
      const doc = (
        await c.query(
          'SELECT d.* FROM documents d JOIN orders o ON(o.tenant_id,o.id)=(d.tenant_id,d.order_id) WHERE d.id=$1 AND d.order_id=$2 AND o.b2b_account_id=$3',
          [id(r, 'documentId'), o.source_order_id, o.account_id],
        )
      ).rows[0];
      ensure(doc, 404, 'Nie znaleziono dokumentu zakupu');
      ensure(
        ['demo', 'simulation'].includes(doc.mode) ||
          (doc.kind === 'proforma' && doc.mode === 'local'),
        409,
        'Dokument zewnętrzny pobierz u dostawcy',
      );
      return doc;
    });
    return reply
      .type('text/html')
      .send(printLayout(d.number, documentBody(d), d.kind === 'proforma' && d.mode === 'local'));
  });
  app.post(orders + '/receipts', async (r) => {
    const a = r.actor,
      b = receiptInput.parse(r.body),
      input = { lines: [...b.lines].sort((x, y) => x.product_id.localeCompare(y.product_id)) },
      hash = fingerprint(input);
    return tx(a.tenantId, async (c) => {
      await admin(c, a);
      const o = await ownOrder(c, id(r, 'orderId'), true);
      const old = (
        await c.query('SELECT * FROM b2b_network_receipts WHERE order_id=$1 AND client_key=$2', [
          o.id,
          b.client_key,
        ])
      ).rows[0];
      if (old) {
        ensure(
          old.fingerprint === hash,
          409,
          'Klucz przyjęcia użyto z innymi ilościami lub lokalizacjami',
        );
        return old;
      }
      ensure(
        o.version === b.version && ['ordered', 'partial'].includes(o.state),
        409,
        'Zakup zmienił się lub został już przyjęty',
      );
      await catalogs(c, [a.tenantId, o.supplier_tenant_id]);
      const f = await fulfillment(c, o, true);
      ensure(
        !f.read_only,
        409,
        'Przyjęcie historycznego źródła wymaga projekcji realizacji dostawcy',
      );
      ensure(
        ['shipped', 'delivered', 'completed'].includes(f.status) &&
          f.shipments.some((s) => s.dispatched_at),
        409,
        'Dostawca nie wydał towaru lub obsługuje zwrot',
      );
      const lines = (
        await c.query(
          'SELECT * FROM b2b_network_order_lines WHERE order_id=$1 ORDER BY product_id FOR UPDATE',
          [o.id],
        )
      ).rows;
      for (const i of input.lines) {
        const l = lines.find((l) => l.product_id === i.product_id);
        ensure(l, 422, 'Produkt nie należy do tego zakupu');
        const returned =
          f.returned.find((x) => x.product_id === l.source_product_id)?.quantity ?? 0;
        ensure(
          i.quantity <= l.quantity - l.received - returned,
          409,
          'Przyjęcie przekracza pozostałą ilość po zwrotach',
        );
      }
      await localProducts(
        c,
        o.warehouse_id,
        input.lines.map((i) => i.product_id),
      );
      const draft = await createWarehouseDocument(
        c,
        a,
        warehouseSchema.parse({
          kind: 'receipt',
          warehouse_id: o.warehouse_id,
          reference: o.source_number,
          note: 'Przyjęcie zakupu B2B ' + o.id,
          lines: input.lines,
        }),
      );
      const posted = await postWarehouseDocument(c, a, draft.id, draft.version);
      const receipt = (
        await c.query(
          'INSERT INTO b2b_network_receipts(id,tenant_id,order_id,document_id,client_key,fingerprint,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [randomUUID(), a.tenantId, o.id, posted.id, b.client_key, hash, a.userId],
        )
      ).rows[0];
      for (const i of input.lines) {
        await c.query(
          'INSERT INTO b2b_network_receipt_lines(tenant_id,receipt_id,order_id,product_id,quantity,location) VALUES($1,$2,$3,$4,$5,$6)',
          [a.tenantId, receipt.id, o.id, i.product_id, i.quantity, i.location],
        );
        await c.query(
          'UPDATE b2b_network_order_lines SET received=received+$3 WHERE order_id=$1 AND product_id=$2',
          [o.id, i.product_id, i.quantity],
        );
      }
      await c.query(
        "UPDATE b2b_network_orders SET version=version+1,state=CASE WHEN EXISTS(SELECT 1 FROM b2b_network_order_lines WHERE order_id=$1 AND received<quantity) THEN 'partial' ELSE 'received' END WHERE id=$1",
        [o.id],
      );
      await audit(c, a, 'b2b.network.receipt', o.id, {
        receipt_id: receipt.id,
        document_id: posted.id,
      });
      return receipt;
    });
  });
}
export {
  ownOrder as networkOrder,
  detail as networkOrderDetail,
  catalogs as networkCatalogLocks,
  localProducts as networkLocalProducts,
};
