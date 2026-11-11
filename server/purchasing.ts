import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { createWarehouseDocument, postWarehouseDocument } from './warehouse';
import { wmsLotsPolicyInTx, type WmsReceiptLine } from './wms-lots';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { assertPurchasingSourceAdmission } from './purchasing-transaction';
import { prepareCatalogStockEffectInTx, abandonCatalogStockEffectInTx } from './catalog-stock-control';
import { purchaseWmsLots } from './wms-lots-workflow-schema';

export const supplierInput = z.object({
  name: z.string().trim().min(2).max(200),
  code: z.string().trim().min(1).max(80),
  contact_name: z.string().trim().max(200).default(''),
  email: z.union([z.email(), z.literal('')]).default(''),
  phone: z.string().trim().max(40).default(''),
  address: z.string().trim().max(1000).default(''),
  tax_id: z.string().trim().max(80).default(''),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default('PL'),
  active: z.boolean().default(true),
});
export const purchaseInput = z.object({
  supplier_id: z.uuid(),
  warehouse_id: z.uuid(),
  currency: z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']).default('PLN'),
  reference: z.string().trim().max(200).default(''),
  note: z.string().trim().max(1000).default(''),
  expected_date: z.iso.date().nullable().default(null),
  lines: z
    .array(
      z.object({
        product_id: z.uuid(),
        quantity: z.number().int().min(1).max(1000000),
        unit_cost: z.number().int().min(0).max(1000000000),
        supplier_sku: z.string().trim().max(80).default(''),
      }),
    )
    .min(1)
    .max(200),
});
export const purchaseVersion = z.object({ version: z.number().int().positive() });
export const purchaseFinish = purchaseVersion.extend({
  reason: z.string().trim().min(1).max(1000),
});
export const purchaseReceive = purchaseVersion.extend({
  wms_lots: purchaseWmsLots.optional(),
  client_key: z.uuid(),
  reference: z.string().trim().max(200).default(''),
  note: z.string().trim().max(1000).default(''),
  lines: z
    .array(
      z.object({
        product_id: z.uuid(),
        quantity: z.number().int().min(1).max(1000000),
        location: z.string().trim().min(1).max(80).default('A-01'),
      }),
    )
    .min(1)
    .max(200),
});
type Input = z.infer<typeof purchaseInput>;
function amount(n: bigint) {
  ensure(n <= BigInt(Number.MAX_SAFE_INTEGER), 422, 'Wartość zamówienia przekracza limit');
  return Number(n);
}
export async function supplierSave(
  c: PoolClient,
  a: Actor,
  b: z.infer<typeof supplierInput>,
  id?: string,
  version?: number,
) {
  if (id) {
    const old = (await c.query('SELECT * FROM suppliers WHERE id=$1 FOR UPDATE', [id])).rows[0];
    ensure(old, 404, 'Nie znaleziono dostawcy');
    ensure(old.version === version, 409, 'Dostawca zmienił się. Odśwież dane.');
  }
  ensure(
    !(
      await c.query(
        'SELECT id FROM suppliers WHERE lower(code)=lower($1) AND ($2::uuid IS NULL OR id<>$2)',
        [b.code, id ?? null],
      )
    ).rowCount,
    409,
    'Kod dostawcy już istnieje',
  );
  const values = [
    b.name,
    b.code,
    b.contact_name,
    b.email,
    b.phone,
    b.address,
    b.tax_id,
    b.country,
    b.active,
  ];
  const d = id
    ? (
        await c.query(
          `UPDATE suppliers SET name=$1,code=$2,contact_name=$3,email=$4,phone=$5,address=$6,tax_id=$7,country=$8,active=$9,version=version+1,updated_at=now() WHERE id=$10 RETURNING *`,
          [...values, id],
        )
      ).rows[0]
    : (
        await c.query(
          `INSERT INTO suppliers(name,code,contact_name,email,phone,address,tax_id,country,active,id,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [...values, randomUUID(), a.tenantId],
        )
      ).rows[0];
  await audit(c, a, id ? 'supplier.updated' : 'supplier.created', d.id, { active: d.active });
  return d;
}
export async function purchaseDetail(c: PoolClient, id: string) {
  const d = (
    await c.query(
      `SELECT p.*,p.expected_date::text AS expected_date,w.name AS warehouse_name FROM purchase_orders p JOIN warehouses w ON (w.tenant_id,w.id)=(p.tenant_id,p.warehouse_id) WHERE p.id=$1`,
      [id],
    )
  ).rows[0];
  ensure(d, 404, 'Nie znaleziono zamówienia zakupowego');
  const lines = (
    await c.query(
      `SELECT l.*,s.on_hand,s.reserved FROM purchase_order_lines l LEFT JOIN stock s ON (s.tenant_id,s.product_id,s.warehouse_id)=(l.tenant_id,l.product_id,$2) WHERE l.order_id=$1 ORDER BY l.sku,l.product_id`,
      [id, d.warehouse_id],
    )
  ).rows;
  d.lines = lines.map((l) => ({
    ...l,
    remaining_quantity: l.quantity - l.received_quantity - l.closed_quantity,
    line_total: amount(BigInt(l.unit_cost) * BigInt(l.quantity)),
  }));
  d.total_net = amount(lines.reduce((t, l) => t + BigInt(l.unit_cost) * BigInt(l.quantity), 0n));
  d.received_net = amount(
    lines.reduce((t, l) => t + BigInt(l.unit_cost) * BigInt(l.received_quantity), 0n),
  );
  d.receipts = (
    await c.query(
      `SELECT r.*,d.number AS document_number,d.status AS document_status FROM purchase_receipts r JOIN warehouse_documents d ON (d.tenant_id,d.id)=(r.tenant_id,r.document_id) WHERE r.order_id=$1 ORDER BY r.created_at,r.id`,
      [id],
    )
  ).rows;
  const receiptLines = (
    await c.query('SELECT * FROM purchase_receipt_lines WHERE order_id=$1 ORDER BY product_id', [
      id,
    ])
  ).rows;
  for (const r of d.receipts) {
    r.lines = receiptLines.filter((l) => l.receipt_id === r.id);
    delete r.input_hash;
  }
  return d;
}
async function lock(c: PoolClient, id: string, version: number) {
  const d = (await c.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(d, 404, 'Nie znaleziono zamówienia zakupowego');
  ensure(d.version === version, 409, 'Zamówienie zmieniło się. Odśwież dane.');
  return d;
}
async function validate(c: PoolClient, a: Actor, b: Input) {
  ensure(
    new Set(b.lines.map((l) => l.product_id)).size === b.lines.length,
    422,
    'Produkt występuje więcej niż raz',
  );
  amount(b.lines.reduce((n, l) => n + BigInt(l.quantity) * BigInt(l.unit_cost), 0n));
  const supplier = (
    await c.query('SELECT * FROM suppliers WHERE id=$1 AND active FOR SHARE', [b.supplier_id])
  ).rows[0];
  ensure(supplier, 422, 'Wybierz aktywnego dostawcę swojej firmy');
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1 FOR SHARE', [b.warehouse_id])).rowCount,
    422,
    'Nie znaleziono magazynu',
  );
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    `catalog:${a.tenantId}`,
  ]);
  const products = (
    await c.query(
      'SELECT id,sku,name,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [b.lines.map((l) => l.product_id)],
    )
  ).rows;
  ensure(
    products.length === b.lines.length &&
      products.every((p) => ['simple', 'variant'].includes(p.kind)),
    422,
    'Zakupy wymagają produktów fizycznych swojej firmy',
  );
  await assertProductsNotDeletedInTx(c, products.map((p) => p.id));
  return { supplier, products };
}
export async function purchaseSave(
  c: PoolClient,
  a: Actor,
  b: Input,
  id?: string,
  version?: number,
) {
  assertPurchasingSourceAdmission(c, a);
  if (id) {
    const old = await lock(c, id, version!);
    ensure(old.state === 'draft', 409, 'Edytować można wyłącznie szkic');
  }
  const { supplier, products } = await validate(c, a, b),
    orderId = id ?? randomUUID();
  const snapshot = JSON.stringify(
    Object.fromEntries(
      ['id', 'name', 'code', 'contact_name', 'email', 'phone', 'address', 'tax_id', 'country'].map(
        (k) => [k, supplier[k]],
      ),
    ),
  );
  if (id)
    await c.query(
      `UPDATE purchase_orders SET supplier_id=$2,warehouse_id=$3,currency=$4,supplier_snapshot=$5,reference=$6,note=$7,expected_date=$8,version=version+1,updated_at=now() WHERE id=$1`,
      [
        id,
        b.supplier_id,
        b.warehouse_id,
        b.currency,
        snapshot,
        b.reference,
        b.note,
        b.expected_date,
      ],
    );
  else
    await c.query(
      `INSERT INTO purchase_orders(id,tenant_id,number,supplier_id,warehouse_id,currency,supplier_snapshot,reference,note,expected_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        orderId,
        a.tenantId,
        `ZZ/${new Date().getUTCFullYear()}/${orderId.replaceAll('-', '').slice(0, 16).toUpperCase()}`,
        b.supplier_id,
        b.warehouse_id,
        b.currency,
        snapshot,
        b.reference,
        b.note,
        b.expected_date,
        a.userId,
      ],
    );
  await c.query('DELETE FROM purchase_order_lines WHERE order_id=$1', [orderId]);
  for (const l of b.lines) {
    const p = products.find((p) => p.id === l.product_id)!;
    await c.query(
      'INSERT INTO purchase_order_lines(tenant_id,order_id,product_id,sku,name,supplier_sku,quantity,unit_cost) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [a.tenantId, orderId, p.id, p.sku, p.name, l.supplier_sku, l.quantity, l.unit_cost],
    );
  }
  await audit(c, a, id ? 'purchase.updated' : 'purchase.created', orderId);
  return purchaseDetail(c, orderId);
}
// Dedicated append: never re-create the head or replace historical line identity.
// Caller owns upfront purchasing source admission and final current IAM grants.
export async function appendPurchaseDraft(
  c: PoolClient,
  a: Actor,
  b: {
    id: string;
    version: number;
    preview_id: string;
    execution_id: string;
    group_index: number;
    lines: Input['lines'];
  },
) {
  assertPurchasingSourceAdmission(c, a);
  await c.query('SELECT replenishment_append_prepare($1,$2,$3)', [
    b.preview_id,
    b.execution_id,
    b.group_index,
  ]);
  const old = await lock(c, b.id, b.version);
  ensure(old.state === 'draft', 409, 'Dopisać można wyłącznie do szkicu');
  const input = purchaseInput.parse({
    supplier_id: old.supplier_id,
    warehouse_id: old.warehouse_id,
    currency: old.currency,
    lines: b.lines,
  });
  const { products } = await validate(c, a, input);
  const before = (
    await c.query(
      'SELECT * FROM purchase_order_lines WHERE order_id=$1 ORDER BY product_id FOR UPDATE',
      [b.id],
    )
  ).rows;
  ensure(
    before.every((l) => l.received_quantity === 0 && l.closed_quantity === 0) &&
      !(await c.query('SELECT id FROM purchase_receipts WHERE order_id=$1', [b.id])).rowCount,
    409,
    'Szkic zawiera przyjęte lub zamknięte pozycje',
  );
  const byID = new Map(before.map((l) => [l.product_id, l]));
  let total = before.reduce((n, l) => n + BigInt(l.quantity) * BigInt(l.unit_cost), 0n);
  ensure(
    byID.size + b.lines.filter((l) => !byID.has(l.product_id)).length <= 200,
    422,
    'Szkic przekroczy 200 pozycji',
  );
  for (const l of b.lines) {
    const existing = byID.get(l.product_id);
    ensure(
      !existing || (existing.unit_cost === l.unit_cost && existing.supplier_sku === l.supplier_sku),
      409,
      'Koszt lub kod dostawcy istniejącej pozycji zmienił się',
    );
    ensure(
      (existing?.quantity ?? 0) + l.quantity <= 1000000,
      422,
      'Końcowa ilość pozycji przekracza 1000000',
    );
    total += BigInt(l.quantity) * BigInt(l.unit_cost);
  }
  amount(total);
  ensure(old.version < 2147483647, 409, 'Wersja szkicu nie pozwala na kolejną zmianę');
  const productByID = new Map(products.map((p) => [p.id, p]));
  for (const l of b.lines) {
    if (byID.has(l.product_id))
      await c.query(
        'UPDATE purchase_order_lines SET quantity=quantity+$3 WHERE order_id=$1 AND product_id=$2',
        [b.id, l.product_id, l.quantity],
      );
    else {
      const p = productByID.get(l.product_id)!;
      await c.query(
        'INSERT INTO purchase_order_lines(tenant_id,order_id,product_id,sku,name,supplier_sku,quantity,unit_cost) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [a.tenantId, b.id, p.id, p.sku, p.name, l.supplier_sku, l.quantity, l.unit_cost],
      );
    }
  }
  await c.query(
    'UPDATE purchase_orders SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',
    [b.id],
  );
  await audit(c, a, 'purchase.replenishment.appended', b.id, {
    preview_id: b.preview_id,
    execution_id: b.execution_id,
    group_index: b.group_index,
    before_version: old.version,
    after_version: old.version + 1,
    product_ids: b.lines.map((l) => l.product_id),
  });
  return purchaseDetail(c, b.id);
}
export async function purchaseAction(
  c: PoolClient,
  a: Actor,
  id: string,
  action: 'place' | 'close' | 'cancel',
  b: { version: number; reason?: string },
) {
  assertPurchasingSourceAdmission(c, a);
  const d = await lock(c, id, b.version);
  if (action === 'place') {
    ensure(d.state === 'draft', 409, 'Zatwierdzić można wyłącznie szkic');
    ensure(
      (await c.query('SELECT id FROM suppliers WHERE id=$1 AND active FOR SHARE', [d.supplier_id]))
        .rowCount,
      409,
      'Dostawca jest nieaktywny',
    );
    await c.query(
      "UPDATE purchase_orders SET state='ordered',version=version+1,updated_at=now() WHERE id=$1",
      [id],
    );
  } else if (action === 'close') {
    ensure(['ordered', 'partial'].includes(d.state), 409, 'Zamknąć można otwarte zamówienie');
    await c.query(
      'UPDATE purchase_order_lines SET closed_quantity=quantity-received_quantity WHERE order_id=$1',
      [id],
    );
    await c.query(
      "UPDATE purchase_orders SET state='closed',close_reason=$2,version=version+1,updated_at=now() WHERE id=$1",
      [id, b.reason],
    );
  } else {
    ensure(
      ['draft', 'ordered'].includes(d.state),
      409,
      'Zamówienie z przyjęciami należy zamknąć, nie anulować',
    );
    await c.query('UPDATE purchase_order_lines SET closed_quantity=quantity WHERE order_id=$1', [
      id,
    ]);
    await c.query(
      "UPDATE purchase_orders SET state='cancelled',close_reason=$2,version=version+1,updated_at=now() WHERE id=$1",
      [id, b.reason],
    );
  }
  await audit(c, a, 'purchase.' + action, id, { reason: b.reason ?? '', external: false });
  return purchaseDetail(c, id);
}
export async function purchaseReceipt(
  c: PoolClient,
  a: Actor,
  id: string,
  b: z.infer<typeof purchaseReceive>,
) {
  assertPurchasingSourceAdmission(c, a);
  a = enlistWmsActorInTx(c, a, { cost: true, adminOnly: true });
  const proposedOrder = (await c.query('SELECT warehouse_id FROM purchase_orders WHERE id=$1', [id])).rows[0];
  ensure(proposedOrder, 404, 'Nie znaleziono zamówienia zakupowego');
  const receiptId = randomUUID();
  const catalogStockEffect = await prepareCatalogStockEffectInTx(c, a, {
    source_kind: 'purchase_receipt', source_id: receiptId,
    warehouse_ids: [proposedOrder.warehouse_id],
    product_ids: [...new Set(b.lines.map(line => line.product_id))].sort(),
  });
  const lotPolicy = await wmsLotsPolicyInTx(c);
  const order = (await c.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [id]))
    .rows[0];
  ensure(order, 404, 'Nie znaleziono zamówienia zakupowego');
  ensure(order.warehouse_id === proposedOrder.warehouse_id, 409, 'Magazyn zakupu zmienił się');
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        reference: b.reference,
        note: b.note,
        lines: [...b.lines].sort((x, y) => x.product_id.localeCompare(y.product_id)),
        ...(b.wms_lots ? { wms_lots: b.wms_lots } : {}),
      }),
    )
    .digest('hex');
  const previous = (
    await c.query(
      'SELECT id,input_hash FROM purchase_receipts WHERE order_id=$1 AND client_key=$2',
      [id, b.client_key],
    )
  ).rows[0];
  if (previous) {
    ensure(previous.input_hash === hash, 409, 'Klucz przyjęcia ma już inny zakres');
    if (catalogStockEffect) await abandonCatalogStockEffectInTx(c, a, catalogStockEffect);
    return { order: await purchaseDetail(c, id), receipt_id: previous.id, replayed: true };
  }
  ensure(
    !lotPolicy.enabled || b.wms_lots,
    409,
    'Przyjęcie zakupu w WMS wymaga partii, lokalizacji i wersji zapasu',
  );
  ensure(!b.wms_lots || lotPolicy.enabled, 409, 'Najpierw aktywuj magazyn partii');
  ensure(order.version === b.version, 409, 'Zamówienie zmieniło się. Odśwież dane.');
  ensure(
    ['ordered', 'partial'].includes(order.state),
    409,
    'Przyjęcie wymaga otwartego, zatwierdzonego zamówienia',
  );
  ensure(
    new Set(b.lines.map((l) => l.product_id)).size === b.lines.length,
    422,
    'Produkt występuje więcej niż raz',
  );
  const lines = (
    await c.query(
      'SELECT * FROM purchase_order_lines WHERE order_id=$1 ORDER BY product_id FOR UPDATE',
      [id],
    )
  ).rows;
  for (const l of b.lines) {
    const p = lines.find((p) => p.product_id === l.product_id);
    ensure(
      p && l.quantity <= p.quantity - p.received_quantity - p.closed_quantity,
      422,
      'Przyjęcie przekracza pozostałą ilość lub zawiera obcy produkt',
    );
  }
  let receiptLots: WmsReceiptLine[] | undefined;
  if (b.wms_lots) {
    ensure(b.wms_lots.policy_version === lotPolicy.version, 409, 'Polityka WMS zmieniła wersję');
    const totals = new Map<string, number>();
    receiptLots = b.wms_lots.lines.map((lot) => {
      const source = lines.find((line) => line.product_id === lot.product_id);
      ensure(
        source && b.lines.some((line) => line.product_id === lot.product_id),
        422,
        'Partia zawiera produkt spoza tego przyjęcia',
      );
      const cost = String(source.unit_cost);
      ensure(
        (lot.unit_cost_minor === undefined || lot.unit_cost_minor === cost) &&
          (lot.currency === undefined || lot.currency === order.currency),
        422,
        'Koszt partii musi odpowiadać zatwierdzonemu zakupowi',
      );
      totals.set(lot.product_id, (totals.get(lot.product_id) ?? 0) + lot.quantity);
      return { ...lot, unit_cost_minor: cost, currency: order.currency };
    });
    ensure(
      totals.size === b.lines.length &&
        b.lines.every((line) => totals.get(line.product_id) === line.quantity),
      422,
      'Partie muszą odpowiadać całej ilości przyjęcia zakupu',
    );
    ensure(
      b.wms_lots.stock_versions.length === b.lines.length &&
        new Set(b.wms_lots.stock_versions.map((v) => v.product_id)).size === b.lines.length,
      422,
      'Podaj dokładnie wersje wszystkich przyjmowanych produktów',
    );
    for (const version of [...b.wms_lots.stock_versions].sort((x, y) =>
      x.product_id.localeCompare(y.product_id),
    )) {
      ensure(
        version.warehouse_id === order.warehouse_id && totals.has(version.product_id),
        422,
        'Wersja zapasu dotyczy obcego zakresu',
      );
      const stock = (
        await c.query(
          `SELECT version FROM stock
        WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE`,
          [order.warehouse_id, version.product_id],
        )
      ).rows[0];
      ensure(
        (stock?.version ?? '0') === version.version,
        409,
        'Stan zakupu zmienił wersję. Odczytaj ponownie całe przyjęcie',
      );
    }
  }
  const draft = await createWarehouseDocument(c, a, {
    kind: 'receipt',
    warehouse_id: order.warehouse_id,
    destination_id: null,
    reference: b.reference || order.number,
    note: b.note,
    lines: b.lines,
  });
  await c.query(
    'INSERT INTO purchase_receipts(id,tenant_id,order_id,document_id,client_key,input_hash,reference,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [receiptId, a.tenantId, id, draft.id, b.client_key, hash, b.reference, b.note, a.userId],
  );
  for (const l of b.lines) {
    await c.query(
      'UPDATE purchase_order_lines SET received_quantity=received_quantity+$3 WHERE order_id=$1 AND product_id=$2',
      [id, l.product_id, l.quantity],
    );
    await c.query(
      'INSERT INTO purchase_receipt_lines(tenant_id,receipt_id,order_id,product_id,quantity,location) VALUES($1,$2,$3,$4,$5,$6)',
      [a.tenantId, receiptId, id, l.product_id, l.quantity, l.location],
    );
  }
  await postWarehouseDocument(
    c,
    a,
    draft.id,
    draft.version,
    receiptLots
      ? {
          catalogStockEffect, catalogStockReceiptId: receiptId,
          wms: {
            context: {
              client_key: b.client_key,
              kind: 'receipt',
              policy_version: b.wms_lots!.policy_version,
              request: b,
              warehouse_document_id: draft.id,
              purchase_receipt_id: receiptId,
            },
            receipt_lines: receiptLots,
          },
        }
      : { catalogStockEffect, catalogStockReceiptId: receiptId },
  );
  await c.query(
    `UPDATE purchase_orders SET state=CASE WHEN EXISTS(SELECT 1 FROM purchase_order_lines WHERE order_id=$1 AND received_quantity<quantity) THEN 'partial' ELSE 'received' END,version=version+1,updated_at=now() WHERE id=$1`,
    [id],
  );
  await audit(c, a, 'purchase.received', id, { receipt_id: receiptId, document_id: draft.id });
  return { order: await purchaseDetail(c, id), receipt_id: receiptId, replayed: false };
}
