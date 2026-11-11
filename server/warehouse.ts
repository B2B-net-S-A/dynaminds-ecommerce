import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { assertWmsLegacyQuantityWriteInTx, receiveWmsLotsInTx } from './wms-lots';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
import { prepareCatalogStockEffectInTx, finishCatalogStockEffectInTx, abandonCatalogStockEffectInTx } from './catalog-stock-control';
import type { CatalogStockEffectAdmission } from './catalog-stock-control-schema';
import { captureCatalogStockEffectJournalsInTx, catalogStockEffectProofInTx } from './catalog-stock-effects';

export const warehouseSchema = z.object({
  kind: z.enum(['receipt', 'transfer', 'count', 'issue']),
  warehouse_id: z.uuid(),
  destination_id: z.uuid().nullable().default(null),
  reference: z.string().trim().max(200).default(''),
  note: z.string().trim().max(1000).default(''),
  lines: z
    .array(
      z.object({
        product_id: z.uuid(),
        quantity: z.number().int().min(0).max(1000000),
        location: z.string().trim().min(1).max(80).default('A-01'),
        expected_version: z.string().regex(/^\d+$/).max(30).optional(),
      }),
    )
    .min(1)
    .max(200),
});
type Input = z.infer<typeof warehouseSchema>;
export const versionSchema = z.object({ version: z.number().int().positive() });

export async function warehouseDetail(c: PoolClient, id: string) {
  const d = (
    await c.query(
      `SELECT d.*,w.name AS warehouse_name,t.name AS destination_name
    FROM warehouse_documents d JOIN warehouses w ON (w.tenant_id,w.id)=(d.tenant_id,d.warehouse_id)
    LEFT JOIN warehouses t ON (t.tenant_id,t.id)=(d.tenant_id,d.destination_id) WHERE d.id=$1`,
      [id],
    )
  ).rows[0];
  ensure(d, 404, 'Nie znaleziono dokumentu magazynowego');
  d.lines = (
    await c.query(
      `SELECT l.*,s.on_hand AS current_on_hand,s.reserved AS current_reserved,
    s.version AS current_version FROM warehouse_document_lines l
    LEFT JOIN stock s ON s.tenant_id=l.tenant_id AND s.product_id=l.product_id AND s.warehouse_id=$2
    WHERE l.document_id=$1 ORDER BY l.sku`,
      [id, d.warehouse_id],
    )
  ).rows;
  return d;
}

async function documentLock(c: PoolClient, id: string) {
  const d = (await c.query('SELECT * FROM warehouse_documents WHERE id=$1 FOR UPDATE', [id]))
    .rows[0];
  ensure(d, 404, 'Nie znaleziono dokumentu magazynowego');
  return d;
}
async function catalogLock(c: PoolClient, actor: Actor) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + actor.tenantId,
  ]);
}
async function validate(c: PoolClient, b: Input) {
  ensure(
    (b.kind === 'transfer') === !!b.destination_id && b.destination_id !== b.warehouse_id,
    422,
    'Przesunięcie wymaga innego magazynu docelowego',
  );
  const ids = [b.warehouse_id, ...(b.destination_id ? [b.destination_id] : [])];
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=ANY($1::uuid[])', [ids])).rowCount ===
      ids.length,
    404,
    'Nie znaleziono magazynu',
  );
  ensure(
    new Set(b.lines.map((l) => l.product_id)).size === b.lines.length,
    422,
    'Produkt występuje więcej niż raz',
  );
  ensure(
    b.kind === 'count' || b.lines.every((l) => l.quantity > 0),
    422,
    'Ilość musi być dodatnia',
  );
  const products = (
    await c.query(
      'SELECT id,sku,name,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [b.lines.map((l) => l.product_id)],
    )
  ).rows;
  ensure(products.length === b.lines.length, 404, 'Nie znaleziono produktu');
  ensure(
    products.every((p) => ['simple', 'variant'].includes(p.kind)),
    422,
    'Dokument może zawierać tylko fizyczne produkty i warianty',
  );
  await assertProductsNotDeletedInTx(c, products.map((p) => p.id));
  return products;
}
async function saveLines(c: PoolClient, actor: Actor, id: string, b: Input, products: any[]) {
  const stock = (
    await c.query(
      'SELECT * FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR SHARE',
      [b.warehouse_id, b.lines.map((l) => l.product_id)],
    )
  ).rows;
  ensure(
    b.kind !== 'count' || stock.length === b.lines.length,
    422,
    'Inwentaryzacja wymaga istniejącego stanu produktu w magazynie',
  );
  await c.query('DELETE FROM warehouse_document_lines WHERE document_id=$1', [id]);
  for (const line of b.lines) {
    const p = products.find((p) => p.id === line.product_id),
      s = stock.find((s) => s.product_id === line.product_id);
    ensure(
      b.kind !== 'count' ||
        (line.expected_version !== undefined && line.expected_version === s?.version),
      409,
      `Stan ${p.sku} zmienił się lub brakuje wersji bazowej pomiaru. Przelicz pozycje ponownie`,
    );
    await c.query(
      `INSERT INTO warehouse_document_lines(tenant_id,document_id,product_id,sku,name,quantity,expected_on_hand,expected_reserved,expected_version,location)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        actor.tenantId,
        id,
        p.id,
        p.sku,
        p.name,
        line.quantity,
        s?.on_hand ?? 0,
        s?.reserved ?? 0,
        s?.version ?? null,
        line.location,
      ],
    );
  }
}
export async function createWarehouseDocument(c: PoolClient, actor: Actor, b: Input) {
  await catalogLock(c, actor);
  const products = await validate(c, b),
    id = randomUUID();
  const prefix = { receipt: 'PZ', transfer: 'MM', count: 'INW', issue: 'WZ' }[b.kind];
  await c.query(
    `INSERT INTO warehouse_documents(id,tenant_id,number,kind,warehouse_id,destination_id,reference,note,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      actor.tenantId,
      `${prefix}/${new Date().getFullYear()}/${id.replaceAll('-', '').slice(0, 16).toUpperCase()}`,
      b.kind,
      b.warehouse_id,
      b.destination_id,
      b.reference,
      b.note,
      actor.userId,
    ],
  );
  await saveLines(c, actor, id, b, products);
  await audit(c, actor, 'warehouse.document.create', id, { kind: b.kind });
  return warehouseDetail(c, id);
}
export async function editWarehouseDocument(
  c: PoolClient,
  actor: Actor,
  id: string,
  b: Input & { version: number },
) {
  await catalogLock(c, actor);
  const d = await documentLock(c, id);
  ensure(d.status === 'draft', 409, 'Można edytować tylko szkic');
  ensure(d.version === b.version, 409, 'Dokument zmienił się. Otwórz go ponownie');
  ensure(
    d.kind === b.kind && d.warehouse_id === b.warehouse_id && d.destination_id === b.destination_id,
    422,
    'Rodzaju i magazynów nie można zmienić. Utwórz nowy dokument',
  );
  const products = await validate(c, b);
  // Explicit re-entry of the entire count is a new measurement and captures a fresh baseline.
  await saveLines(c, actor, id, b, products);
  await c.query(
    'UPDATE warehouse_documents SET reference=$2,note=$3,version=version+1 WHERE id=$1',
    [id, b.reference, b.note],
  );
  await audit(c, actor, 'warehouse.document.edit', id, {
    version: b.version,
    remeasured: b.kind === 'count',
  });
  return warehouseDetail(c, id);
}
export async function cancelWarehouseDocument(
  c: PoolClient,
  actor: Actor,
  id: string,
  version: number,
) {
  const d = await documentLock(c, id);
  if (d.status === 'cancelled') return warehouseDetail(c, id);
  ensure(d.status === 'draft', 409, 'Zatwierdzonego dokumentu nie można anulować');
  ensure(d.version === version, 409, 'Dokument zmienił się. Otwórz go ponownie');
  await c.query("UPDATE warehouse_documents SET status='cancelled',version=version+1 WHERE id=$1", [
    id,
  ]);
  await audit(c, actor, 'warehouse.document.cancel', id, {});
  return warehouseDetail(c, id);
}
export async function postWarehouseDocument(
  c: PoolClient,
  actor: Actor,
  id: string,
  version: number,
  options: {
    // Parent purchasing admits its actual receipt before locking the PO.
    catalogStockEffect?: CatalogStockEffectAdmission | null;
    catalogStockReceiptId?: string;
    wms?: {
      context: import('./wms-lots-schema').WmsOperationContext;
      receipt_lines: import('./wms-lots-schema').WmsReceiptLine[];
    };
  } = {},
) {
  actor = enlistWmsActorInTx(c, actor, { adminOnly: true, cost: Boolean(options.wms) });
  if (options.wms)
    ensure(
      options.wms.context.warehouse_document_id === id && options.wms.context.kind === 'receipt',
      422,
      'Kontekst partii nie odpowiada temu PZ',
    );
  const head = (await c.query('SELECT warehouse_id,destination_id,kind,status FROM warehouse_documents WHERE id=$1', [id])).rows[0];
  ensure(head, 404, 'Nie znaleziono dokumentu magazynowego');
  const proposedProducts = (await c.query('SELECT product_id FROM warehouse_document_lines WHERE document_id=$1 ORDER BY product_id', [id])).rows.map(r => r.product_id as string);
  const effect = options.catalogStockEffect !== undefined ? options.catalogStockEffect
    : head.status === 'draft' ? await prepareCatalogStockEffectInTx(c, actor, {
      source_kind: 'warehouse_document', source_id: id,
      warehouse_ids: [head.warehouse_id, ...(head.destination_id ? [head.destination_id] : [])].sort(),
      product_ids: proposedProducts,
    }) : null;
  const effectBaseline = await captureCatalogStockEffectJournalsInTx(c, effect);
  await catalogLock(c, actor);
  const policies = await lockWarehouseInventoryPoliciesInTx(c, [head.warehouse_id, ...(head.destination_id ? [head.destination_id] : [])]);
  const d = await documentLock(c, id);
  // Replaying the same posting never writes stock or movements a second time.
  if (d.status === 'posted') {
    if (effect) await abandonCatalogStockEffectInTx(c, actor, effect);
    return warehouseDetail(c, id);
  }
  ensure(d.warehouse_id === head.warehouse_id && d.destination_id === head.destination_id && d.kind === head.kind,
    409, 'Magazyny dokumentu zmieniły się');
  ensure(policies.every(p => p.enabled), 409, 'Magazyn jest wyłączony');
  ensure(d.kind !== 'issue' || policies.find(p => p.warehouse_id === d.warehouse_id)?.usage === 'sale',
    409, 'Magazyn nie jest źródłem sprzedaży');
  await assertWmsLegacyQuantityWriteInTx(c, actor, options.wms?.context);
  ensure(d.status === 'draft', 409, 'Dokument jest anulowany');
  ensure(d.version === version, 409, 'Dokument zmienił się. Otwórz go ponownie');
  const lines = (
    await c.query(
      'SELECT * FROM warehouse_document_lines WHERE document_id=$1 ORDER BY product_id',
      [id],
    )
  ).rows;
  ensure(lines.length === proposedProducts.length && lines.every((line, i) => line.product_id === proposedProducts[i]),
    409, 'Pozycje dokumentu zmieniły się. Odczytaj ponownie cały dokument');
  // A draft saved before a product was deleted (225) never moves its stock.
  await assertProductsNotDeletedInTx(c, proposedProducts);
  if (effect?.number) {
    ensure(({ receipt: 'PZ', transfer: 'MM', issue: 'WZ' } as Record<string, string>)[d.kind] === effect.number.kind,
      409, 'Numeracja nie odpowiada rodzajowi dokumentu');
    await c.query('UPDATE warehouse_documents SET number=$2 WHERE id=$1', [id, effect.number.number]);
    d.number = effect.number.number;
  }
  if (options.wms) {
    ensure(d.kind === 'receipt', 422, 'Partie przyjęcia wymagają dokumentu PZ');
    const totals = new Map<string, number>();
    for (const line of options.wms.receipt_lines)
      totals.set(line.product_id, (totals.get(line.product_id) ?? 0) + line.quantity);
    ensure(
      totals.size === lines.length &&
        lines.every((line) => totals.get(line.product_id) === line.quantity),
      422,
      'Partie i lokalizacje muszą odpowiadać całej ilości PZ',
    );
  }
  const warehouses = [d.warehouse_id, ...(d.destination_id ? [d.destination_id] : [])].sort();
  // The same total order for row creation and locks prevents opposite transfers deadlocking.
  const stocks = new Map<string, any>();
  for (const warehouse of warehouses)
    for (const line of lines) {
      if (d.kind !== 'count')
        await c.query(
          `INSERT INTO stock(tenant_id,warehouse_id,product_id,location) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [actor.tenantId, warehouse, line.product_id, line.location],
        );
      const s = (
        await c.query('SELECT * FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE', [
          warehouse,
          line.product_id,
        ])
      ).rows[0];
      ensure(s, 409, 'Stan magazynowy nie istnieje');
      stocks.set(warehouse + line.product_id, s);
    }
  const change = async (line: any, warehouse: string, delta: number, kind: string) => {
    await c.query("SELECT set_config('app.stock_location',$1,true)", [
      delta > 0 ? line.location : '',
    ]);
    await c.query('UPDATE stock SET on_hand=on_hand+$3 WHERE warehouse_id=$1 AND product_id=$2', [
      warehouse,
      line.product_id,
      delta,
    ]);
    await c.query("SELECT set_config('app.stock_location','',true)");
    await c.query(
      `INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,delta,kind,note,warehouse_document_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), actor.tenantId, line.product_id, warehouse, delta, kind, d.number, id],
    );
  };
  for (const line of lines) {
    const source = stocks.get(d.warehouse_id + line.product_id);
    if (d.kind === 'count') {
      ensure(
        source.version === line.expected_version,
        409,
        `Stan ${line.sku} zmienił się od pomiaru. Przelicz i zapisz cały szkic ponownie`,
      );
      ensure(
        line.quantity >= source.reserved,
        409,
        `Pomiar ${line.sku} narusza aktywne rezerwacje`,
      );
      const delta = line.quantity - source.on_hand;
      if (delta) await change(line, d.warehouse_id, delta, 'count');
    } else if (d.kind === 'receipt') {
      ensure(
        source.on_hand + line.quantity <= 2147483647,
        409,
        'Stan przekracza obsługiwany zakres',
      );
      if (options.wms) {
        for (const fragment of options.wms.receipt_lines.filter(
          (l) => l.product_id === line.product_id,
        ))
          await change(
            { ...line, location: fragment.location },
            d.warehouse_id,
            fragment.quantity,
            'receipt',
          );
      } else await change(line, d.warehouse_id, line.quantity, 'receipt');
    } else if (d.kind === 'issue') {
      ensure(
        source.available >= line.quantity,
        409,
        `Niewystarczający dostępny stan ${line.sku}. Wydanie nie narusza aktywnych rezerwacji`,
      );
      await change(line, d.warehouse_id, -line.quantity, 'issue');
    } else {
      ensure(
        source.available >= line.quantity,
        409,
        `Niewystarczający dostępny stan ${line.sku}. Rezerwacje pozostają w magazynie źródłowym`,
      );
      ensure(
        stocks.get(d.destination_id + line.product_id).on_hand + line.quantity <= 2147483647,
        409,
        'Stan docelowy przekracza obsługiwany zakres',
      );
      await change(line, d.warehouse_id, -line.quantity, 'transfer_out');
      await change(line, d.destination_id, line.quantity, 'transfer_in');
    }
  }
  await c.query(
    "UPDATE warehouse_documents SET status='posted',version=version+1,posted_at=now() WHERE id=$1",
    [id],
  );
  const wmsReceipt = options.wms
    ? await receiveWmsLotsInTx(
      c,
      actor,
      options.wms.context,
      d.warehouse_id,
      options.wms.receipt_lines,
    ) : null;
  if (effect && effectBaseline) await finishCatalogStockEffectInTx(c, actor, effect,
    await catalogStockEffectProofInTx(c, effectBaseline, { warehouse_document_id: id,
      ...(wmsReceipt ? { operation_id: wmsReceipt.operation.id } : {}),
      ...(options.catalogStockReceiptId ? { receipt_id: options.catalogStockReceiptId } : {}),
    }));
  await audit(c, actor, 'warehouse.document.post', id, { kind: d.kind, lines: lines.length });
  return warehouseDetail(c, id);
}
