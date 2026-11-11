import { createHash, randomUUID } from 'node:crypto';
import { prepareCatalogStockEffectInTx, finishCatalogStockEffectInTx, abandonCatalogStockEffectInTx, catalogWmsCorrectionDocumentInTx, projectCatalogWmsCorrectionDocument, catalogWmsCorrectionHeadsInTx } from './catalog-stock-control';
import { captureCatalogStockEffectJournalsInTx, catalogStockEffectProofInTx } from './catalog-stock-effects';
import type { PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { ensure } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { assertNoOrderParcelPlanInTx } from './order-parcel-guards';
import { audit, type Actor } from './domain';
import { createWarehouseDocument, postWarehouseDocument } from './warehouse';
import { wmsLotsAdmissionInTx, enlistWmsActorInTx } from './wms-lots-transaction';
export { wmsLotsAdmissionInTx } from './wms-lots-transaction';
import * as S from './wms-lots-schema';
import { wmsLotLimitsInTx, wmsLotOpeningRowsInTx, wmsLotsEvidenceBudgetInTx, wmsLotsQuotaInTx } from './wms-lots-limits';
export { wmsLotsEvidenceBudgetInTx } from './wms-lots-limits';
import { selectFifoLayers, wmsCostValue, wmsValueSummary } from './wms-lots-values';
import { lockWarehouseInventoryPoliciesInTx, warehouseInventoryPoliciesAvailable } from './warehouse-inventory-policies';
import { warehousePolicyMapSQL } from './warehouse-sellability';

type Row = Record<string, any>;
type WmsActor = S.WmsActor & { canReadValue?: boolean };
export type { WmsOperationContext, WmsPick, WmsReceiptLine } from './wms-lots-schema';
export function wmsLotsHash(value: unknown): string {
  const canonical = (v: any): any =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((k) => v[k] !== undefined)
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
const operationKey = (text: string) => {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const date = (value: any) => (value instanceof Date ? value.toISOString() : value);
const key = (r: Row) => JSON.stringify([r.warehouse_id, r.product_id, r.location]);
function bounded(value: unknown, maximum = S.WMS_LOT_LIMITS.response_bytes) {
  ensure(
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximum,
    413,
    'Zakres WMS przekracza limit bajtów',
  );
}
function valueRows(rows: Row[]) {
  return rows.map((row) => {
    ensure(
      typeof row.quantity === 'number' && Number.isSafeInteger(row.quantity) && row.quantity >= 0,
      422,
      'Nieprawidłowa ilość wyceny',
    );
    ensure(
      row.unit_cost_minor === null || typeof row.unit_cost_minor === 'string',
      422,
      'Nieprawidłowy dokładny koszt wyceny',
    );
    ensure(typeof row.currency === 'string', 422, 'Nieprawidłowa waluta wyceny');
    const quantity: number = row.quantity;
    const unit_cost_minor: string | null = row.unit_cost_minor;
    const currency: string = row.currency;
    return { quantity, unit_cost_minor, currency };
  });
}
function movementPicks(rows: Row[]): S.WmsPick[] {
  return rows.map((row) => {
    const layer = S.wmsStockVersion.shape.product_id.parse(row.layer_id);
    ensure(
      typeof row.location === 'string' &&
        row.location.length > 0 &&
        row.location.length <= 80 &&
        !/[\u0000-\u001f\u007f]/.test(row.location),
      422,
      'Nieprawidłowa lokalizacja fragmentu',
    );
    ensure(
      typeof row.quantity === 'number' &&
        Number.isSafeInteger(row.quantity) &&
        row.quantity > 0 &&
        row.quantity <= 2147483647,
      422,
      'Nieprawidłowa ilość fragmentu',
    );
    return { layer_id: layer, location: row.location, quantity: row.quantity };
  });
}
function input<T>(schema: { parse: (value: unknown) => T }, raw: unknown): T {
  bounded(raw, S.WMS_LOT_LIMITS.request_bytes);
  return schema.parse(raw);
}
export async function wmsLotsAvailable(c: PoolClient) {
  return Boolean(
    (await c.query("SELECT to_regclass('public.wms_policies') IS NOT NULL available")).rows[0]
      .available,
  );
}
export async function wmsLotsPolicyInTx(c: PoolClient) {
  if (!(await wmsLotsAvailable(c)))
    return { enabled: false, version: '0', method: 'FIFO', currency: null, exponent: 2 };
  return (
    (await c.query('SELECT enabled,version,method,currency,exponent FROM wms_policies'))
      .rows[0] ?? { enabled: false, version: '0', method: 'FIFO', currency: null, exponent: 2 }
  );
}
export async function assertWmsLegacyQuantityWriteInTx(
  c: PoolClient,
  a: { tenantId: string },
  context?: S.WmsOperationContext,
) {
  const policy = await wmsLotsPolicyInTx(c);
  if (!policy.enabled) return;
  ensure(
    context && context.client_key && context.kind && context.request !== undefined,
    409,
    'WMS jest aktywny. Ta zmiana wymaga jawnych partii i zgodnego procesu WMS',
  );
  if (context.policy_version !== undefined)
    ensure(context.policy_version === policy.version, 409, 'Polityka WMS zmieniła wersję');
}
/** Final only, after every blocking write/FK and SET CONSTRAINTS in the root owner transaction. */
export async function wmsLotsAssertActorInTx(
  c: PoolClient,
  a: WmsActor,
  write = false,
  adminOnly = false,
  cost = false,
  orderRead = false,
) {
  ensure(await wmsLotsAvailable(c), 503, 'Kopia nie zawiera WMS partii');
  const role = (await c.query('SELECT wms_current_role($1,true) role', [a.userId])).rows[0].role;
  ensure(role, 403, 'Brak bieżącego dostępu do firmy');
  ensure(
    !write || role === 'admin' || (!adminOnly && role === 'operator'),
    403,
    'Brak uprawnień do operacji WMS',
  );
  ensure(!cost || role === 'admin', 403, 'Koszty i wycena WMS wymagają administratora');
  if (write && a.apiKeyId) {
    const grant = (
      await c.query('SELECT wms_key_grant($1,$2,$3) grant_result', [a.userId, a.apiKeyId, cost])
    ).rows[0].grant_result;
    ensure(grant !== 'invalid', 401, 'Klucz API został odwołany lub wygasł');
    ensure(grant === 'ok', 403, 'Klucz API nie ma bieżących zakresów WMS');
    const projection = (
      await c.query('SELECT wms_key_read_grant($1,$2) grant_result', [a.userId, a.apiKeyId])
    ).rows[0].grant_result;
    if (projection !== 'value') a.canReadValue = false;
  } else if (a.apiKeyId) {
    const grant = (
      await c.query('SELECT wms_key_read_grant($1,$2) grant_result', [a.userId, a.apiKeyId])
    ).rows[0].grant_result;
    ensure(grant !== 'invalid', 401, 'Klucz API został odwołany lub wygasł');
    ensure(grant !== 'insufficient', 403, 'Klucz API nie ma bieżącego odczytu magazynu');
    if (grant === 'quantity_only') a.canReadValue = false;
    ensure(!cost || grant === 'value', 403, 'Klucz API nie ma bieżącego odczytu wyceny');
  }
  if (orderRead && a.apiKeyId) {
    const grant = (
      await c.query('SELECT wms_key_order_read_grant($1,$2) grant_result', [a.userId, a.apiKeyId])
    ).rows[0].grant_result;
    ensure(grant !== 'invalid', 401, 'Klucz API został odwołany lub wygasł');
    ensure(grant === 'ok', 403, 'Klucz API nie ma bieżącego odczytu zapasu i zamówień');
  }
  return role as string;
}
/** Optional early rejection only: never pin membership/key before stock or FK waits. */
async function earlyWriter(c: PoolClient, a: WmsActor, adminOnly = false) {
  const role = (await c.query('SELECT wms_current_role($1,false) role', [a.userId])).rows[0].role;
  ensure(
    role === 'admin' || (!adminOnly && role === 'operator'),
    403,
    'Brak bieżących uprawnień do operacji WMS',
  );
}
async function policy(c: PoolClient, version?: string) {
  const p = await wmsLotsPolicyInTx(c);
  ensure(p.enabled, 409, 'Najpierw zatwierdź kompletne otwarcie magazynu partii');
  ensure(version === undefined || version === p.version, 409, 'Polityka WMS zmieniła wersję');
  return p;
}
const quota = wmsLotsQuotaInTx;
const evidenceBudget = wmsLotsEvidenceBudgetInTx;
const requestHash = (a: WmsActor, kind: string, request: unknown) =>
  wmsLotsHash({ actor_id: a.userId, source: a.source ?? 'manual', kind, request });
function operationHead(r: Row) {
  return Object.fromEntries(
    [
      'id',
      'kind',
      'order_id',
      'warehouse_document_id',
      'purchase_receipt_id',
      'return_id',
      'policy_version',
      'created_at',
    ].map((k) => [k, k === 'created_at' ? date(r[k]) : (r[k] ?? null)]),
  );
}
/** Writers share the tenant operations fence, so the same key sent twice at once waits here for the
 * first transaction and then replays its committed result instead of failing on UNIQUE(client_key). */
async function lockClientKey(c: PoolClient, a: WmsActor, kind: 'operation' | 'preview', key: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'wms.' + kind + '-key:' + a.tenantId + ':' + key,
  ]);
}
async function priorOperation(c: PoolClient, a: WmsActor, context: S.WmsOperationContext) {
  await lockClientKey(c, a, 'operation', context.client_key);
  const r = (
    await c.query('SELECT * FROM wms_operations WHERE client_key=$1', [context.client_key])
  ).rows[0];
  if (r)
    ensure(
      r.request_hash === requestHash(a, context.kind, context.request) && r.actor_id === a.userId,
      409,
      'Klucz WMS ma innego aktora lub zamrożony zakres',
    );
  return r;
}
async function recordOperation(
  c: PoolClient,
  a: WmsActor,
  context: S.WmsOperationContext,
  id: string,
  result: unknown,
) {
  bounded(result);
  const p = await policy(c, context.policy_version);
  const r = (
    await c.query(
      `INSERT INTO wms_operations(id,tenant_id,actor_id,client_key,request_hash,kind,source,
      policy_version,order_id,warehouse_document_id,purchase_receipt_id,return_id,request,result)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        id,
        a.tenantId,
        a.userId,
        context.client_key,
        requestHash(a, context.kind, context.request),
        context.kind,
        a.source ?? context.source ?? 'manual',
        p.version,
        context.order_id ?? null,
        context.warehouse_document_id ?? null,
        context.purchase_receipt_id ?? null,
        context.return_id ?? null,
        JSON.stringify(context.request),
        JSON.stringify(result),
      ],
    )
  ).rows[0];
  return { operation: operationHead(r), result: r.result, reused: false };
}
async function positions(c: PoolClient, warehouse: string, product: string, lock = false) {
  const rows = (
    await c.query(
      `SELECT p.*,p.quantity-p.reserved available,l.lot_id,l.fifo_sequence,
    l.unit_cost_minor,l.currency,o.lot_code FROM wms_layer_positions p
    JOIN wms_cost_layers l ON (l.tenant_id,l.id,l.product_id)=(p.tenant_id,p.layer_id,p.product_id)
    JOIN wms_lots o ON (o.tenant_id,o.id,o.product_id)=(l.tenant_id,l.lot_id,l.product_id)
    WHERE p.warehouse_id=$1 AND p.product_id=$2
    ORDER BY p.layer_id,p.location COLLATE "C" ${lock ? 'FOR UPDATE OF p' : ''}`,
      [warehouse, product],
    )
  ).rows;
  ensure(
    rows.length <= S.WMS_LOT_LIMITS.physical_rows,
    413,
    'Za dużo pozycji warstw dla jednego zakresu',
  );
  return rows;
}
async function positionDelta(
  c: PoolClient,
  a: WmsActor,
  warehouse: string,
  product: string,
  location: string,
  layer: string,
  delta: number,
  reservedDelta = 0,
) {
  if (delta === 0 && reservedDelta === 0) return;
  const updated = await c.query(
    `UPDATE wms_layer_positions SET quantity=quantity+$6,
    reserved=reserved+$7,version=version+1 WHERE
    (tenant_id,warehouse_id,product_id,location,layer_id)=($1,$2,$3,$4,$5)`,
    [a.tenantId, warehouse, product, location, layer, delta, reservedDelta],
  );
  if (!updated.rowCount) {
    ensure(delta >= 0 && reservedDelta >= 0, 409, 'Brak pozycji warstwy dla rozchodu');
    await c.query(
      `INSERT INTO wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id,quantity,reserved)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [a.tenantId, warehouse, product, location, layer, delta, reservedDelta],
    );
  }
}
async function journal(
  c: PoolClient,
  a: WmsActor,
  op: string,
  warehouse: string,
  product: string,
  pick: S.WmsPick,
  delta: number,
  cost: string | null,
  kind: string,
) {
  const value = wmsCostValue(Math.abs(delta), cost);
  await c.query(
    `INSERT INTO wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,
    location,layer_id,delta,value_delta,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      randomUUID(),
      a.tenantId,
      op,
      warehouse,
      product,
      pick.location,
      pick.layer_id,
      delta,
      cost === null ? null : (delta < 0 ? '-' : '') + value.known_minor,
      kind,
    ],
  );
}
async function makeLayer(
  c: PoolClient,
  a: WmsActor,
  op: string,
  warehouse: string,
  line: Omit<S.WmsReceiptLine, 'unit_cost_minor'> & { unit_cost_minor: string | null },
  origin: 'receipt' | 'opening' | 'adjustment' | 'legacy_return',
  context?: S.WmsOperationContext,
) {
  const lot = randomUUID(),
    layer = randomUUID();
  await c.query(
    `INSERT INTO wms_lots(id,tenant_id,product_id,operation_id,lot_code,origin,expiry_date)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [lot, a.tenantId, line.product_id, op, line.lot_code, origin, line.expiry_date ?? null],
  );
  const l = (
    await c.query(
      `INSERT INTO wms_cost_layers(id,tenant_id,lot_id,product_id,operation_id,
    quantity_received,unit_cost_minor,currency,exponent,purchase_receipt_id,warehouse_document_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,2,$9,$10) RETURNING *`,
      [
        layer,
        a.tenantId,
        lot,
        line.product_id,
        op,
        line.quantity,
        line.unit_cost_minor,
        line.currency,
        context?.purchase_receipt_id ?? null,
        context?.warehouse_document_id ?? null,
      ],
    )
  ).rows[0];
  await positionDelta(c, a, warehouse, line.product_id, line.location, layer, line.quantity);
  await journal(
    c,
    a,
    op,
    warehouse,
    line.product_id,
    { layer_id: layer, location: line.location, quantity: line.quantity },
    line.quantity,
    line.unit_cost_minor,
    origin,
  );
  return {
    lot_id: lot,
    layer_id: layer,
    product_id: line.product_id,
    warehouse_id: warehouse,
    location: line.location,
    quantity: line.quantity,
    unit_cost_minor: line.unit_cost_minor,
    currency: line.currency,
    fifo_sequence: l.fifo_sequence,
  };
}

/** Root caller already owns all sorted order/product/stock/bin locks; no admission or final member pin here. */
export async function reserveWmsLotsInTx(
  c: PoolClient,
  a: WmsActor,
  b: { order_id: string; warehouse_id: string; product_id: string; quantity: number },
) {
  await lockWarehouseInventoryPoliciesInTx(c, [b.warehouse_id], { sellable: true });
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  a = enlistWmsActorInTx(c, a);
  const context: S.WmsOperationContext = {
    client_key: operationKey('reserve:' + b.order_id + ':' + b.product_id),
    kind: 'reserve',
    request: b,
    order_id: b.order_id,
  };
  const prior = await priorOperation(c, a, context);
  if (prior) return prior.result;
  await quota(c);
  const rows = await positions(c, b.warehouse_id, b.product_id, true);
  const picks = selectFifoLayers(rows, b.quantity);
  const bins = new Map<string, number>();
  for (const pick of picks) bins.set(pick.location, (bins.get(pick.location) ?? 0) + pick.quantity);
  for (const [location, quantity] of [...bins].sort(([a], [b]) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  ))
    await c.query(
      'INSERT INTO reservation_locations(tenant_id,order_id,product_id,warehouse_id,location,quantity) VALUES($1,$2,$3,$4,$5,$6)',
      [a.tenantId, b.order_id, b.product_id, b.warehouse_id, location, quantity],
    );
  for (const pick of picks) {
    await positionDelta(
      c,
      a,
      b.warehouse_id,
      b.product_id,
      pick.location,
      pick.layer_id,
      0,
      pick.quantity,
    );
    await c.query(
      `INSERT INTO wms_reservation_layers(tenant_id,order_id,product_id,warehouse_id,location,layer_id,quantity)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        a.tenantId,
        b.order_id,
        b.product_id,
        b.warehouse_id,
        pick.location,
        pick.layer_id,
        pick.quantity,
      ],
    );
  }
  await recordOperation(c, a, context, randomUUID(), {
    allocations: picks.map(({ unit_cost_minor, ...p }) => p),
  });
  await evidenceBudget(c);
  return picks;
}
export const WMS_RESIZE_REFUSED =
  'Przy partiach WMS tej zmiany ilości nie można zapisać: przydział FIFO opróżniłby lokalizację już zarezerwowaną dla tej pozycji. Anuluj zamówienie i utwórz nowe z właściwą ilością.';
export const WMS_READD_REFUSED =
  'Przy partiach WMS produktu usuniętego z zamówienia nie można dodać ponownie, bo jego warstwy zostały już zwolnione. Utwórz nowe zamówienie dla tego produktu.';
/** Order line edit of a product the order already reserved (order-edit.ts). The result is the FIFO
 * allocation a fresh reservation of `quantity` gets from current availability, counting the order's own
 * active layers as free. Layer rows the plan drops are released; rows it keeps (or takes back after an
 * earlier lowering) are resized in place under a wms_order_line_resizes record of this transaction (265),
 * the only change of quantity or state wms_row_guard admits; new rows are appended. A reservation location
 * stays above zero and its layer rows reference it, so a plan that empties a held bin is refused, and so is
 * the re-add of a product whose rows were all released by its removal.
 * Caller owns the order, stock and policy locks and has set reservations.quantity to `quantity`. */
export async function resizeWmsLotsInTx(
  c: PoolClient,
  a: WmsActor,
  b: { order_id: string; warehouse_id: string; product_id: string; quantity: number; revision: string },
) {
  await lockWarehouseInventoryPoliciesInTx(c, [b.warehouse_id], { sellable: true });
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  a = enlistWmsActorInTx(c, a);
  const context: S.WmsOperationContext = {
    client_key: operationKey('reserve-edit:' + b.order_id + ':' + b.product_id + ':' + b.revision),
    kind: 'reserve',
    request: b,
    order_id: b.order_id,
  };
  ensure(!(await priorOperation(c, a, context)), 409, 'Zamówienie zmieniło się. Odśwież dane przed edycją.');
  await quota(c);
  const rows = await positions(c, b.warehouse_id, b.product_id, true);
  const own = (
    await c.query(
      `SELECT * FROM wms_reservation_layers WHERE order_id=$1 AND product_id=$2 AND warehouse_id=$3
    ORDER BY layer_id,location COLLATE "C" FOR UPDATE`,
      [b.order_id, b.product_id, b.warehouse_id],
    )
  ).rows;
  ensure(
    own.every((r) => r.state !== 'consumed' && r.scanned === 0),
    409,
    'Zamówienie ma już skany kompletacji',
  );
  const pair = (r: Row) => JSON.stringify([r.layer_id, r.location]);
  const active = new Map(own.filter((r) => r.state === 'active').map((r) => [pair(r), r]));
  ensure(active.size > 0 || own.length === 0, 409, WMS_READD_REFUSED);
  const picks = selectFifoLayers(
    rows.map((r) => ({ ...r, available: r.available + (active.get(pair(r))?.quantity ?? 0) })),
    b.quantity,
  );
  const planned = new Map(picks.map((p) => [pair(p), p]));
  const bins = new Map<string, number>();
  for (const pick of picks) bins.set(pick.location, (bins.get(pick.location) ?? 0) + pick.quantity);
  const located = (
    await c.query('SELECT location,quantity FROM reservation_locations WHERE order_id=$1 AND product_id=$2 FOR UPDATE', [
      b.order_id,
      b.product_id,
    ])
  ).rows;
  ensure(located.every((l) => bins.has(l.location)), 409, WMS_RESIZE_REFUSED);
  const released = [...active.values()].filter((r) => !planned.has(pair(r)));
  const resized = own
    .filter((r) => planned.has(pair(r)) && (r.state !== 'active' || r.quantity !== planned.get(pair(r))!.quantity))
    .map((r) => ({ row: r, quantity: planned.get(pair(r))!.quantity }));
  for (const r of released) {
    await positionDelta(c, a, r.warehouse_id, r.product_id, r.location, r.layer_id, 0, -r.quantity);
    await c.query(
      `UPDATE wms_reservation_layers SET state='released' WHERE
      (tenant_id,order_id,product_id,warehouse_id,location,layer_id)=($1,$2,$3,$4,$5,$6)`,
      [a.tenantId, b.order_id, b.product_id, b.warehouse_id, r.location, r.layer_id],
    );
  }
  if (resized.length) {
    // The record holds each row exactly as it is now and as it will be; wms_row_guard admits only that pair.
    const target = resized.map(({ row, quantity }) => ({ location: row.location, layer_id: row.layer_id, quantity }));
    await c.query(
      `INSERT INTO wms_order_line_resizes(tenant_id,order_id,product_id,warehouse_id,before_layers,after_layers)
      SELECT $1,$2,$3,$4,jsonb_agg(to_jsonb(r) ORDER BY r.layer_id,r.location COLLATE "C"),
      jsonb_agg(to_jsonb(r)||jsonb_build_object('quantity',t.quantity,'state','active') ORDER BY r.layer_id,r.location COLLATE "C")
      FROM wms_reservation_layers r JOIN jsonb_to_recordset($5::jsonb) t(location text,layer_id uuid,quantity integer)
      ON (r.location,r.layer_id)=(t.location,t.layer_id)
      WHERE (r.tenant_id,r.order_id,r.product_id,r.warehouse_id)=($1,$2,$3,$4)`,
      [a.tenantId, b.order_id, b.product_id, b.warehouse_id, JSON.stringify(target)],
    );
    for (const { row: r, quantity } of resized) {
      await positionDelta(c, a, r.warehouse_id, r.product_id, r.location, r.layer_id, 0, quantity - (r.state === 'active' ? r.quantity : 0));
      await c.query(
        `UPDATE wms_reservation_layers SET quantity=$7,state='active' WHERE
        (tenant_id,order_id,product_id,warehouse_id,location,layer_id)=($1,$2,$3,$4,$5,$6)`,
        [a.tenantId, b.order_id, b.product_id, b.warehouse_id, r.location, r.layer_id, quantity],
      );
    }
  }
  for (const [location, quantity] of [...bins].sort(([a], [b]) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    const row = located.find((l) => l.location === location);
    if (!row)
      await c.query(
        'INSERT INTO reservation_locations(tenant_id,order_id,product_id,warehouse_id,location,quantity) VALUES($1,$2,$3,$4,$5,$6)',
        [a.tenantId, b.order_id, b.product_id, b.warehouse_id, location, quantity],
      );
    else if (row.quantity !== quantity)
      await c.query('UPDATE reservation_locations SET quantity=$4 WHERE order_id=$1 AND product_id=$2 AND location=$3', [
        b.order_id,
        b.product_id,
        location,
        quantity,
      ]);
  }
  const held = new Set(own.map(pair));
  for (const pick of picks.filter((p) => !held.has(pair(p)))) {
    await positionDelta(c, a, b.warehouse_id, b.product_id, pick.location, pick.layer_id, 0, pick.quantity);
    await c.query(
      `INSERT INTO wms_reservation_layers(tenant_id,order_id,product_id,warehouse_id,location,layer_id,quantity)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [a.tenantId, b.order_id, b.product_id, b.warehouse_id, pick.location, pick.layer_id, pick.quantity],
    );
  }
  await recordOperation(c, a, context, randomUUID(), {
    allocations: picks.map(({ unit_cost_minor, ...p }) => p),
    released: released.map((r) => ({ layer_id: r.layer_id, location: r.location, quantity: r.quantity })),
    resized: resized.map(({ row, quantity }) => ({ layer_id: row.layer_id, location: row.location, from: row.state === 'active' ? row.quantity : 0, quantity })),
  });
  await evidenceBudget(c);
  return picks;
}
export async function scanWmsLotInTx(
  c: PoolClient,
  a: WmsActor,
  b: { order_id: string; product_id: string; location: string; layer_id?: string },
) {
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  a = enlistWmsActorInTx(c, a);
  const rows = (
    await c.query(
      `SELECT a.*,l.lot_id FROM wms_reservation_layers a JOIN wms_cost_layers l
    ON (l.tenant_id,l.id)=(a.tenant_id,a.layer_id) WHERE a.order_id=$1 AND a.product_id=$2
    AND a.location=$3 AND a.state='active' AND a.scanned<a.quantity ORDER BY a.layer_id FOR UPDATE OF a`,
      [b.order_id, b.product_id, b.location],
    )
  ).rows;
  ensure(rows.length > 0, 409, 'Brak nieskompletowanej przypisanej warstwy w tej lokalizacji');
  ensure(
    b.layer_id || rows.length === 1,
    422,
    'W lokalizacji przypisano kilka warstw. Wybierz layer_id',
  );
  const r = rows.find((r) => r.layer_id === (b.layer_id ?? rows[0].layer_id));
  ensure(r, 422, 'Wybrana warstwa nie należy do nieskompletowanej rezerwacji');
  // A scan changes no stock row, so it pins it shared: no writer can commit a stock change while
  // this transaction's deferred wms_consistency check compares the stock row with its positions.
  await c.query('SELECT 1 FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR SHARE', [
    r.warehouse_id,
    b.product_id,
  ]);
  await c.query(
    `UPDATE wms_reservation_layers SET scanned=scanned+1 WHERE
    (tenant_id,order_id,product_id,warehouse_id,location,layer_id)=($1,$2,$3,$4,$5,$6)`,
    [a.tenantId, b.order_id, b.product_id, r.warehouse_id, b.location, r.layer_id],
  );
  return { layer_id: r.layer_id, lot_id: r.lot_id, location: r.location };
}
export type WmsScanInput = {
  order_id: string;
  client_key: string;
  code: string;
  location?: string;
  layer_id?: string;
};
export async function wmsScanReplayInTx(c: PoolClient, a: WmsActor, b: WmsScanInput) {
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  const previous = await priorOperation(c, a, {
    client_key: b.client_key,
    kind: 'scan',
    request: b,
    order_id: b.order_id,
  });
  if (!previous) return null;
  await wmsLotsAssertActorInTx(c, a, true);
  return previous.result;
}
export async function wmsRecordScanInTx(
  c: PoolClient,
  a: WmsActor,
  b: WmsScanInput,
  result: unknown,
) {
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  a = enlistWmsActorInTx(c, a);
  await quota(c);
  const r = await recordOperation(
    c,
    a,
    { client_key: b.client_key, kind: 'scan', request: b, order_id: b.order_id },
    randomUUID(),
    result,
  );
  await evidenceBudget(c);
  return r;
}
/** Releases the order's active layers; with productId only that product's (an order line edit). */
export async function releaseWmsLotsInTx(c: PoolClient, a: WmsActor, orderId: string, productId?: string) {
  await assertNoOrderParcelPlanInTx(c, orderId);
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  a = enlistWmsActorInTx(c, a);
  const rows = (
    await c.query(
      `SELECT * FROM wms_reservation_layers WHERE order_id=$1 AND state='active'
    AND ($2::uuid IS NULL OR product_id=$2)
    ORDER BY warehouse_id,product_id,layer_id,location COLLATE "C" FOR UPDATE`,
      [orderId, productId ?? null],
    )
  ).rows;
  for (const r of rows) {
    await positionDelta(c, a, r.warehouse_id, r.product_id, r.location, r.layer_id, 0, -r.quantity);
    await c.query(
      `UPDATE wms_reservation_layers SET state='released' WHERE
      (tenant_id,order_id,product_id,warehouse_id,location,layer_id)=($1,$2,$3,$4,$5,$6)`,
      [a.tenantId, orderId, r.product_id, r.warehouse_id, r.location, r.layer_id],
    );
  }
  return { released: rows.length };
}
export async function consumeWmsLotsInTx(
  c: PoolClient,
  a: WmsActor,
  b: { order_id: string; warehouse_id: string; product_id: string },
) {
  await lockWarehouseInventoryPoliciesInTx(c, [b.warehouse_id], { sellable: true });
  await assertNoOrderParcelPlanInTx(c, b.order_id);
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  a = enlistWmsActorInTx(c, a);
  const context: S.WmsOperationContext = {
    client_key: operationKey('dispatch:' + b.order_id + ':' + b.product_id),
    kind: 'dispatch',
    order_id: b.order_id,
    request: b,
  };
  const prior = await priorOperation(c, a, context);
  if (prior) return prior.result;
  await quota(c);
  const rows = (
    await c.query(
      `SELECT r.*,l.unit_cost_minor,l.currency FROM wms_reservation_layers r
    JOIN wms_cost_layers l ON (l.tenant_id,l.id)=(r.tenant_id,r.layer_id)
    WHERE r.order_id=$1 AND r.product_id=$2 AND r.warehouse_id=$3
    ORDER BY r.layer_id,r.location COLLATE "C" FOR UPDATE OF r`,
      [b.order_id, b.product_id, b.warehouse_id],
    )
  ).rows;
  ensure(
    rows.length > 0 && rows.every((r) => r.state === 'active' && r.scanned === r.quantity),
    409,
    'Wydanie wymaga kompletnych skanów wszystkich przypisanych warstw',
  );
  await positions(c, b.warehouse_id, b.product_id, true);
  const op = randomUUID(),
    fragments: Row[] = [];
  for (const r of rows) {
    await positionDelta(
      c,
      a,
      b.warehouse_id,
      b.product_id,
      r.location,
      r.layer_id,
      -r.quantity,
      -r.quantity,
    );
    await journal(
      c,
      a,
      op,
      b.warehouse_id,
      b.product_id,
      r,
      -r.quantity,
      r.unit_cost_minor,
      'dispatch',
    );
    const value = wmsCostValue(r.quantity, r.unit_cost_minor),
      id = randomUUID();
    await c.query(
      `INSERT INTO wms_issue_fragments(id,tenant_id,operation_id,order_id,warehouse_id,
      product_id,location,layer_id,quantity,unit_cost_minor,value_minor,currency)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        a.tenantId,
        op,
        b.order_id,
        b.warehouse_id,
        b.product_id,
        r.location,
        r.layer_id,
        r.quantity,
        r.unit_cost_minor,
        r.unit_cost_minor === null ? null : value.known_minor,
        r.currency,
      ],
    );
    await c.query(
      `UPDATE wms_reservation_layers SET state='consumed' WHERE
      (tenant_id,order_id,product_id,warehouse_id,location,layer_id)=($1,$2,$3,$4,$5,$6)`,
      [a.tenantId, b.order_id, b.product_id, b.warehouse_id, r.location, r.layer_id],
    );
    fragments.push({
      id,
      product_id: b.product_id,
      layer_id: r.layer_id,
      quantity: r.quantity,
      unit_cost_minor: r.unit_cost_minor,
      value_minor: r.unit_cost_minor === null ? null : value.known_minor,
      currency: r.currency,
    });
  }
  const result = { fragments, valuation: wmsValueSummary(rows, rows[0].currency) };
  await recordOperation(c, a, context, op, result);
  await evidenceBudget(c);
  return result;
}
/** A parcel consumes only its frozen holds; the original reservation remains traceable. */
export async function consumeWmsParcelLotsInTx(
  c: PoolClient,
  actor: WmsActor,
  b: {
    operation_id: string; plan_id: string; parcel_index: number; shipment_id: string; order_id: string;
    allocations: import('./order-parcels-values').OrderParcelProduct[];
  },
) {
  const lotPolicy = await wmsLotsPolicyInTx(c);
  if (!lotPolicy.enabled) {
    ensure(b.allocations.every(p => p.lot_holds.length === 0), 409, 'Polityka partii zmieniła się');
    return null;
  }
  const a = enlistWmsActorInTx(c, actor, { orders: true });
  const context: S.WmsOperationContext = {
    client_key: b.operation_id, kind: 'dispatch', order_id: b.order_id,
    request: { plan_id: b.plan_id, parcel_index: b.parcel_index, shipment_id: b.shipment_id, allocations: b.allocations },
  };
  ensure(!(await priorOperation(c, a, context)), 409, 'Wydanie tej paczki ma już dowód WMS');
  await quota(c);
  const fragments: Array<{ id:string;product_id:string;warehouse_id:string;layer_id:string;
    location:string;quantity:number;unit_cost_minor:string|null;value_minor:string|null;currency:string }> = [];
  for (const product of [...b.allocations].sort((x,y) => x.product_id.localeCompare(y.product_id))) {
    ensure(product.lot_holds.reduce((n,r) => n+r.quantity,0) === product.quantity, 409, 'Warstwy nie pokrywają ilości paczki');
    await positions(c, product.warehouse_id, product.product_id, true);
    for (const pick of [...product.lot_holds].sort((x,y) => x.layer_id.localeCompare(y.layer_id) || x.location.localeCompare(y.location))) {
      const r = (await c.query(`SELECT r.*,l.unit_cost_minor,l.currency FROM wms_reservation_layers r
        JOIN wms_cost_layers l ON(l.tenant_id,l.id)=(r.tenant_id,r.layer_id)
        WHERE(r.tenant_id,r.order_id,r.product_id,r.warehouse_id,r.location,r.layer_id)=($1,$2,$3,$4,$5,$6)
        FOR UPDATE OF r`, [a.tenantId,b.order_id,product.product_id,product.warehouse_id,pick.location,pick.layer_id])).rows[0];
      ensure(r && r.state === 'active' && r.scanned === r.quantity &&
        Number.isSafeInteger(pick.quantity) && pick.quantity > 0 &&
        r.consumed_quantity + (r.released_quantity ?? 0) + pick.quantity <= r.quantity, 409, 'Warstwa paczki nie ma tylu skompletowanych sztuk');
      await positionDelta(c,a,product.warehouse_id,product.product_id,pick.location,pick.layer_id,-pick.quantity,-pick.quantity);
      await journal(c,a,b.operation_id,product.warehouse_id,product.product_id,pick,-pick.quantity,r.unit_cost_minor,'dispatch');
      const id=randomUUID(), value=wmsCostValue(pick.quantity,r.unit_cost_minor);
      await c.query(`INSERT INTO wms_issue_fragments(id,tenant_id,operation_id,order_id,warehouse_id,product_id,
        location,layer_id,quantity,unit_cost_minor,value_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id,a.tenantId,b.operation_id,b.order_id,product.warehouse_id,product.product_id,pick.location,pick.layer_id,
          pick.quantity,r.unit_cost_minor,r.unit_cost_minor===null?null:value.known_minor,r.currency]);
      await c.query(`UPDATE wms_reservation_layers SET consumed_quantity=consumed_quantity+$7,
        state=CASE WHEN consumed_quantity+$7=quantity THEN 'consumed' ELSE 'active' END
        WHERE(tenant_id,order_id,product_id,warehouse_id,location,layer_id)=($1,$2,$3,$4,$5,$6)`,
        [a.tenantId,b.order_id,product.product_id,product.warehouse_id,pick.location,pick.layer_id,pick.quantity]);
      fragments.push({id,product_id:product.product_id,warehouse_id:product.warehouse_id,layer_id:pick.layer_id,
        location:pick.location,quantity:pick.quantity,unit_cost_minor:r.unit_cost_minor,
        value_minor:r.unit_cost_minor===null?null:value.known_minor,currency:r.currency});
    }
  }
  const result={fragments,valuation:wmsValueSummary(fragments,lotPolicy.currency)};
  await recordOperation(c,a,context,b.operation_id,result);
  await evidenceBudget(c);
  return {operation_id:b.operation_id,fragment_ids:fragments.map(r=>String(r.id)),physical_quantity:fragments.reduce((n,r)=>n+Number(r.quantity),0)};
}
export async function receiveWmsLotsInTx(
  c: PoolClient,
  a: WmsActor,
  context: S.WmsOperationContext,
  warehouse: string,
  lines: S.WmsReceiptLine[],
) {
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  a = enlistWmsActorInTx(c, a, { cost: true, adminOnly: true });
  const p = await policy(c, context.policy_version);
  ensure(
    context.kind === 'receipt' && context.warehouse_document_id,
    422,
    'Przyjęcie wymaga rzeczywistego PZ',
  );
  const previous = await priorOperation(c, a, context);
  if (previous)
    return { operation: operationHead(previous), result: previous.result, reused: true };
  await quota(c);
  ensure(
    lines.length > 0 && lines.length <= S.WMS_LOT_LIMITS.lines,
    422,
    'Nieprawidłowy zakres przyjęcia',
  );
  const op = randomUUID(),
    layers: Row[] = [];
  for (const line of lines) {
    const valid = S.wmsReceiptLine.parse(line);
    ensure(
      valid.currency === p.currency,
      422,
      'Waluta kosztu nie jest walutą polityki WMS; FX jest wyłączony',
    );
    layers.push(await makeLayer(c, a, op, warehouse, valid, 'receipt', context));
  }
  const result = {
    layers,
    valuation: wmsValueSummary(valueRows(layers), p.currency),
    warehouse_document_id: context.warehouse_document_id,
  };
  const r = await recordOperation(c, a, context, op, result);
  await evidenceBudget(c);
  return r;
}
export async function wmsOrderLotHashInTx(c: PoolClient, orderId: string) {
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  return wmsLotsHash(
    (
      await c.query(
        `SELECT product_id,warehouse_id,location,layer_id,quantity,scanned,state
    FROM wms_reservation_layers WHERE order_id=$1 ORDER BY product_id,warehouse_id,layer_id,location COLLATE "C"`,
        [orderId],
      )
    ).rows,
  );
}

async function validatedPicks(
  c: PoolClient,
  warehouse: string,
  product: string,
  picks: S.WmsPick[],
) {
  ensure(
    picks.length > 0 && picks.length <= S.WMS_LOT_LIMITS.physical_rows,
    422,
    'Nieprawidłowy zakres fragmentów',
  );
  ensure(
    new Set(picks.map((p) => JSON.stringify([p.layer_id, p.location]))).size === picks.length,
    422,
    'Fragment warstwy występuje więcej niż raz',
  );
  const available = await positions(c, warehouse, product, true);
  return picks.map((p) => {
    ensure(Number.isInteger(p.quantity) && p.quantity > 0, 422, 'Fragment wymaga dodatniej ilości');
    const r = available.find((r) => r.layer_id === p.layer_id && r.location === p.location);
    ensure(
      r && r.available >= p.quantity,
      409,
      'Fragment narusza dostępność lub rezerwacje warstwy',
    );
    return { ...r, quantity: p.quantity };
  });
}
export async function transferWmsLotsInTx(
  c: PoolClient,
  a: WmsActor,
  context: S.WmsOperationContext,
  b: {
    product_id: string;
    warehouse_id: string;
    destination_warehouse_id: string;
    destination_location: string;
    picks: S.WmsPick[];
  },
) {
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  a = enlistWmsActorInTx(c, a);
  ensure(['transfer', 'bin_move'].includes(context.kind), 422, 'Nieprawidłowy rodzaj transferu');
  ensure(
    b.warehouse_id !== b.destination_warehouse_id ||
      b.picks.every((p) => p.location !== b.destination_location),
    422,
    'Transfer wymaga innej pozycji',
  );
  const previous = await priorOperation(c, a, context);
  if (previous)
    return { operation: operationHead(previous), result: previous.result, reused: true };
  await quota(c);
  const rows = await validatedPicks(c, b.warehouse_id, b.product_id, b.picks),
    op = context.operation_id ?? randomUUID();
  // Target bin/stock rows and all target positions are owned/prelocked by the caller.
  for (const row of rows) {
    await positionDelta(
      c,
      a,
      b.warehouse_id,
      b.product_id,
      row.location,
      row.layer_id,
      -row.quantity,
    );
    await positionDelta(
      c,
      a,
      b.destination_warehouse_id,
      b.product_id,
      b.destination_location,
      row.layer_id,
      row.quantity,
    );
    await journal(
      c,
      a,
      op,
      b.warehouse_id,
      b.product_id,
      row,
      -row.quantity,
      row.unit_cost_minor,
      context.kind,
    );
    await journal(
      c,
      a,
      op,
      b.destination_warehouse_id,
      b.product_id,
      { ...row, location: b.destination_location },
      row.quantity,
      row.unit_cost_minor,
      context.kind,
    );
  }
  const result = {
    fragments: rows.map((r) => ({
      layer_id: r.layer_id,
      lot_id: r.lot_id,
      lot_code: r.lot_code,
      location: r.location,
      quantity: r.quantity,
      unit_cost_minor: r.unit_cost_minor,
      currency: r.currency,
      fifo_sequence: r.fifo_sequence,
    })),
    source_warehouse_id: b.warehouse_id,
    destination_warehouse_id: b.destination_warehouse_id,
    destination_location: b.destination_location,
    valuation: wmsValueSummary(rows, rows[0].currency),
  };
  const recorded = await recordOperation(c, a, context, op, result);
  await evidenceBudget(c);
  return recorded;
}
export async function issueWmsLotsInTx(
  c: PoolClient,
  a: WmsActor,
  context: S.WmsOperationContext,
  b: { product_id: string; warehouse_id: string; picks: S.WmsPick[] },
) {
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  a = enlistWmsActorInTx(c, a, { cost: true, adminOnly: true });
  ensure(
    ['issue', 'adjustment'].includes(context.kind) && context.warehouse_document_id,
    422,
    'Ręczny rozchód wymaga rzeczywistego dokumentu magazynowego',
  );
  const previous = await priorOperation(c, a, context);
  if (previous)
    return { operation: operationHead(previous), result: previous.result, reused: true };
  await quota(c);
  const rows = await validatedPicks(c, b.warehouse_id, b.product_id, b.picks),
    op = context.operation_id ?? randomUUID();
  const fragments: Row[] = [];
  for (const row of rows) {
    const value = wmsCostValue(row.quantity, row.unit_cost_minor),
      id = randomUUID();
    await positionDelta(
      c,
      a,
      b.warehouse_id,
      b.product_id,
      row.location,
      row.layer_id,
      -row.quantity,
    );
    await journal(
      c,
      a,
      op,
      b.warehouse_id,
      b.product_id,
      row,
      -row.quantity,
      row.unit_cost_minor,
      context.kind,
    );
    await c.query(
      `INSERT INTO wms_issue_fragments(id,tenant_id,operation_id,warehouse_document_id,warehouse_id,
      product_id,location,layer_id,quantity,unit_cost_minor,value_minor,currency)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        a.tenantId,
        op,
        context.warehouse_document_id,
        b.warehouse_id,
        b.product_id,
        row.location,
        row.layer_id,
        row.quantity,
        row.unit_cost_minor,
        row.unit_cost_minor === null ? null : value.known_minor,
        row.currency,
      ],
    );
    fragments.push({
      id,
      product_id: b.product_id,
      lot_id: row.lot_id,
      layer_id: row.layer_id,
      lot_code: row.lot_code,
      location: row.location,
      quantity: row.quantity,
      unit_cost_minor: row.unit_cost_minor,
      value_minor: row.unit_cost_minor === null ? null : value.known_minor,
      currency: row.currency,
    });
  }
  const r = await recordOperation(c, a, context, op, {
    fragments,
    valuation: wmsValueSummary(rows, rows[0].currency),
  });
  await evidenceBudget(c);
  return r;
}
export type WmsReturnScope = {
  order_id: string;
  return_id: string;
  warehouse_id: string;
  picks: Array<{ issue_fragment_id: string; quantity: number; location: string }>;
  legacy_unknown?: Array<{ product_id: string; quantity: number; location: string }>;
};
export async function returnWmsLotsInTx(
  c: PoolClient,
  a: WmsActor,
  context: S.WmsOperationContext,
  b: WmsReturnScope,
) {
  if (!(await wmsLotsPolicyInTx(c)).enabled) return null;
  a = enlistWmsActorInTx(c, a);
  const p = await policy(c, context.policy_version);
  ensure(
    context.kind === 'return' &&
      context.order_id === b.order_id &&
      context.return_id === b.return_id,
    422,
    'Zwrot wymaga dokładnego powiązania z własną sprawą i zamówieniem',
  );
  const previous = await priorOperation(c, a, context);
  if (previous)
    return { operation: operationHead(previous), result: previous.result, reused: true };
  await quota(c);
  ensure(
    b.picks.length + (b.legacy_unknown?.length ?? 0) <= S.WMS_LOT_LIMITS.physical_rows,
    413,
    'Za dużo fragmentów zwrotu',
  );
  const physical = new Map<string, number>();
  for (const row of (
    await c.query(
      `SELECT i.restocked,c.value component FROM return_items i
    CROSS JOIN LATERAL jsonb_array_elements(i.components)c(value)
    WHERE i.return_id=$1 AND i.order_id=$2`,
      [b.return_id, b.order_id],
    )
  ).rows) {
    const product = row.component.product_id;
    physical.set(product, (physical.get(product) ?? 0) + row.restocked * row.component.quantity);
  }
  const caseRow = (
    await c.query('SELECT warehouse_id FROM return_cases WHERE id=$1 AND order_id=$2', [
      b.return_id,
      b.order_id,
    ])
  ).rows[0];
  ensure(
    caseRow && caseRow.warehouse_id === b.warehouse_id,
    422,
    'Magazyn nie należy do tej sprawy zwrotu',
  );
  ensure(
    new Set(b.picks.map((r) => r.issue_fragment_id)).size === b.picks.length,
    422,
    'Fragment wydania występuje więcej niż raz',
  );
  const issues = (
    await c.query(
      `SELECT f.*,(SELECT coalesce(sum(quantity),0)::int FROM wms_return_fragments r
    WHERE (r.tenant_id,r.issue_fragment_id)=(f.tenant_id,f.id)) returned_quantity
    FROM wms_issue_fragments f WHERE f.order_id=$1 AND f.id=ANY($2::uuid[]) ORDER BY f.id`,
      [b.order_id, b.picks.map((r) => r.issue_fragment_id)],
    )
  ).rows;
  ensure(
    issues.length === b.picks.length,
    422,
    'Fragment nie należy do pierwotnego wydania tego zamówienia',
  );
  const matched = new Map<string, number>();
  for (const pick of b.picks) {
    const issue = issues.find((r) => r.id === pick.issue_fragment_id)!;
    ensure(
      Number.isInteger(pick.quantity) &&
        pick.quantity > 0 &&
        pick.quantity <= issue.quantity - issue.returned_quantity,
      409,
      'Zwrot przekracza pozostały fragment wydania',
    );
    matched.set(issue.product_id, (matched.get(issue.product_id) ?? 0) + pick.quantity);
  }
  if (b.legacy_unknown?.length) {
    ensure(
      !(await c.query('SELECT 1 FROM wms_issue_fragments WHERE order_id=$1 LIMIT 1', [b.order_id]))
        .rowCount,
      422,
      'Zamówienie ma historię partii. Wybierz rzeczywiste fragmenty wydania',
    );
    for (const row of b.legacy_unknown) {
      ensure(
        Number.isInteger(row.quantity) && row.quantity > 0,
        422,
        'Nieprawidłowa ilość historycznego zwrotu',
      );
      matched.set(row.product_id, (matched.get(row.product_id) ?? 0) + row.quantity);
    }
  }
  ensure(
    [...physical].filter(([, qty]) => qty > 0).length === matched.size &&
      [...matched].every(([product, qty]) => physical.get(product) === qty),
    422,
    'Wszystkie fragmenty muszą dokładnie pokrywać fizyczny restock przyjętej sprawy',
  );
  const op = randomUUID(),
    fragments: Row[] = [];
  for (const pick of b.picks) {
    const issue = issues.find((r) => r.id === pick.issue_fragment_id)!;
    const value = wmsCostValue(pick.quantity, issue.unit_cost_minor),
      id = randomUUID();
    await positionDelta(
      c,
      a,
      b.warehouse_id,
      issue.product_id,
      pick.location,
      issue.layer_id,
      pick.quantity,
    );
    await journal(
      c,
      a,
      op,
      b.warehouse_id,
      issue.product_id,
      { layer_id: issue.layer_id, location: pick.location, quantity: pick.quantity },
      pick.quantity,
      issue.unit_cost_minor,
      'return',
    );
    await c.query(
      `INSERT INTO wms_return_fragments(id,tenant_id,operation_id,order_id,return_id,
      issue_fragment_id,product_id,layer_id,warehouse_id,location,quantity,value_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        a.tenantId,
        op,
        b.order_id,
        b.return_id,
        issue.id,
        issue.product_id,
        issue.layer_id,
        b.warehouse_id,
        pick.location,
        pick.quantity,
        issue.unit_cost_minor === null ? null : value.known_minor,
      ],
    );
    fragments.push({
      id,
      issue_fragment_id: issue.id,
      product_id: issue.product_id,
      layer_id: issue.layer_id,
      quantity: pick.quantity,
      unit_cost_minor: issue.unit_cost_minor,
      value_minor: issue.unit_cost_minor === null ? null : value.known_minor,
      currency: issue.currency,
      location: pick.location,
    });
  }
  const legacyLayers: Row[] = [];
  for (const row of b.legacy_unknown ?? [])
    legacyLayers.push(
      await makeLayer(
        c,
        a,
        op,
        b.warehouse_id,
        {
          ...row,
          lot_code: 'LEGACY-RETURN-' + b.return_id,
          unit_cost_minor: null,
          currency: p.currency,
        },
        'legacy_return',
        context,
      ),
    );
  const result = {
    fragments,
    legacy_unknown_layers: legacyLayers,
    valuation: wmsValueSummary(valueRows([...fragments, ...legacyLayers]), p.currency),
  };
  const recorded = await recordOperation(c, a, context, op, result);
  await evidenceBudget(c);
  return recorded;
}

/** shared for receipts and movements (row locks decide); serial/activation for the whole-tenant
 * opening, chosen at the tenantTx admission (a later upgrade is refused with 409). */
async function admit(c: PoolClient, a: WmsActor, mode: 'shared' | 'serial' | 'activation' = 'shared') {
  ensure(await wmsLotsAvailable(c), 503, 'Kopia nie zawiera WMS partii');
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + a.tenantId,
  ]);
  await wmsLotsAdmissionInTx(c, a, mode);
  // Preview quota also requires admission while policy is OFF. Always before owner/stock waits.
  await c.query(
    `SELECT pg_advisory_xact_lock${mode === 'shared' ? '_shared' : ''}(hashtextextended($1,0))`,
    ['wms.operations:' + a.tenantId],
  );
}
async function lockStocks(
  c: PoolClient,
  a: WmsActor,
  expected: S.WmsStockVersion[],
  create = false,
) {
  await lockWarehouseInventoryPoliciesInTx(c, [...new Set(expected.map(r => r.warehouse_id))]);
  ensure(
    new Set(expected.map((r) => r.warehouse_id + ':' + r.product_id)).size === expected.length,
    422,
    'Stan występuje więcej niż raz',
  );
  const products = [...new Set(expected.map((r) => r.product_id))].sort();
  const ps = (
    await c.query(
      'SELECT id,sku,name,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [products],
    )
  ).rows;
  ensure(
    ps.length === products.length && ps.every((p) => ['simple', 'variant'].includes(p.kind)),
    422,
    'Zakres wymaga własnych fizycznych produktów',
  );
  await assertProductsNotDeletedInTx(c, products);
  const whs = [...new Set(expected.map((r) => r.warehouse_id))];
  ensure(
    (
      await c.query('SELECT id FROM warehouses WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [
        whs,
      ])
    ).rowCount === whs.length,
    422,
    'Magazyn nie należy do firmy',
  );
  const stocks: Row[] = [];
  for (const wanted of [...expected].sort(
    (a, b) =>
      a.warehouse_id.localeCompare(b.warehouse_id) || a.product_id.localeCompare(b.product_id),
  )) {
    let s = (
      await c.query('SELECT * FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE', [
        wanted.warehouse_id,
        wanted.product_id,
      ])
    ).rows[0];
    const present = Boolean(s);
    ensure((s?.version ?? '0') === wanted.version, 409, 'Stan lub rezerwacja zmieniły wersję');
    if (!s && create) {
      await c.query('INSERT INTO stock(tenant_id,warehouse_id,product_id) VALUES($1,$2,$3)', [
        a.tenantId,
        wanted.warehouse_id,
        wanted.product_id,
      ]);
      s = (
        await c.query('SELECT * FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE', [
          wanted.warehouse_id,
          wanted.product_id,
        ])
      ).rows[0];
    }
    stocks.push({
      warehouse_id: wanted.warehouse_id,
      product_id: wanted.product_id,
      present,
      version: s?.version ?? '0',
      on_hand: s?.on_hand ?? 0,
      reserved: s?.reserved ?? 0,
    });
  }
  await c.query(
    `SELECT location FROM stock_locations WHERE (warehouse_id,product_id) IN
    (SELECT warehouse_id,product_id FROM jsonb_to_recordset($1::jsonb)x(warehouse_id uuid,product_id uuid))
    ORDER BY warehouse_id,product_id,location COLLATE "C" FOR UPDATE`,
    [JSON.stringify(expected)],
  );
  return { products: ps, stocks };
}
async function finalWrite(c: PoolClient, a: WmsActor, adminOnly: boolean, cost: boolean) {
  await evidenceBudget(c);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  return wmsLotsAssertActorInTx(c, a, true, adminOnly, cost);
}
function redact(value: any, allowed: boolean): any {
  if (allowed) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, false));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        [
          'unit_cost_minor',
          'value_minor',
          'value_delta',
          'known_minor',
          'unknown_quantity',
          'known_quantity',
          'known_delta_minor',
          'unknown_delta_quantity',
        ].includes(k)
          ? null
          : redact(v, false),
      ]),
    );
  return value;
}
const canValue = (a: WmsActor, role: string) => role === 'admin' && a.canReadValue !== false;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value: string | undefined, bind: unknown): Row | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    ensure(parsed.bind === wmsLotsHash(bind), 422, 'Kursor ma inny zakres');
    return parsed;
  } catch {
    ensure(false, 422, 'Nieprawidłowy kursor WMS');
  }
}
function frozenRows(rows: Row[], cursor: string | undefined, bind: unknown) {
  const decoded = decode(cursor, bind),
    start = decoded?.index ?? 0;
  ensure(
    Number.isInteger(start) && start >= 0 && start <= rows.length,
    422,
    'Nieprawidłowy offset zakresu',
  );
  const data: Row[] = [];
  let end = start,
    bytes = 0;
  while (end < rows.length && data.length < 50) {
    const size = Buffer.byteLength(JSON.stringify(rows[end]), 'utf8');
    ensure(
      size < S.WMS_LOT_LIMITS.response_bytes - 65536,
      413,
      'Wiersz przekracza limit odpowiedzi',
    );
    if (bytes + size > S.WMS_LOT_LIMITS.response_bytes - 65536) break;
    data.push(rows[end++]);
    bytes += size;
  }
  return {
    data,
    meta: {
      total: rows.length,
      cursor: end < rows.length ? encode({ bind: wmsLotsHash(bind), index: end }) : null,
    },
  };
}

/** Rows without stock (stock on_hand=0 and reserved=0, bin quantity=0) create no layer and raise no
 * blocker. They are still locked (one ordered statement per table, as before) and bound into the scope
 * hash, but as a count and a SQL digest instead of rows, so a 100 000 SKU catalogue keeps the snapshot,
 * the stored preview and its detail small. The digest covers every column the rows had, so any change
 * that invalidated the opening before (version, SKU, name, kind) still does. */
const zeroStock = 's.on_hand=0 AND s.reserved=0';
function splitZero(rows: Row[]) {
  const { total, zero, digest } = rows[0];
  return {
    total: Number(total),
    zero: { rows: Number(zero), digest },
    rows: rows
      .filter((r) => r.warehouse_id !== null)
      .map(({ total: _total, zero: _zero, digest: _digest, ...r }) => r),
  };
}
async function openingSnapshot(c: PoolClient, lock = false) {
  const limit = await wmsLotOpeningRowsInTx(c);
  const stock = splitZero(
    (
      await c.query(`WITH s AS MATERIALIZED (SELECT s.warehouse_id,s.product_id,s.on_hand,s.reserved,s.version,
    p.sku,p.name,p.kind,p.version product_version FROM stock s JOIN products p
    ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id) ORDER BY s.warehouse_id,s.product_id
    ${lock ? 'FOR UPDATE OF s' : ''}),
    z AS (SELECT count(*)::text total,(count(*) FILTER (WHERE ${zeroStock}))::text zero,
    encode(sha256(convert_to(coalesce(string_agg(json_build_array(s.warehouse_id,s.product_id,s.version,s.sku,s.name,s.kind,s.product_version)::text,
    E'\\n' ORDER BY s.warehouse_id,s.product_id) FILTER (WHERE ${zeroStock}),''),'UTF8')),'hex') digest FROM s)
    SELECT z.total,z.zero,z.digest,s.* FROM z LEFT JOIN s ON NOT (${zeroStock}) ORDER BY s.warehouse_id,s.product_id`)
    ).rows,
  );
  ensure(stock.total <= limit, 413, 'Otwarcie obejmuje za dużo stanów');
  const bins = splitZero(
    (
      await c.query(`WITH b AS MATERIALIZED (SELECT b.warehouse_id,b.product_id,b.location,b.quantity,
    s.version stock_version,p.sku,p.name FROM stock_locations b JOIN stock s
    USING(tenant_id,warehouse_id,product_id) JOIN products p ON (p.tenant_id,p.id)=(b.tenant_id,b.product_id)
    ORDER BY b.warehouse_id,b.product_id,b.location COLLATE "C" ${lock ? 'FOR UPDATE OF b' : ''}),
    z AS (SELECT count(*)::text total,(count(*) FILTER (WHERE b.quantity=0))::text zero,
    encode(sha256(convert_to(coalesce(string_agg(json_build_array(b.warehouse_id,b.product_id,b.location,b.stock_version,b.sku,b.name)::text,
    E'\\n' ORDER BY b.warehouse_id,b.product_id,b.location COLLATE "C") FILTER (WHERE b.quantity=0),''),'UTF8')),'hex') digest FROM b)
    SELECT z.total,z.zero,z.digest,b.* FROM z LEFT JOIN b ON b.quantity<>0
    ORDER BY b.warehouse_id,b.product_id,b.location COLLATE "C"`)
    ).rows,
  );
  ensure(bins.total <= limit, 413, 'Otwarcie obejmuje za dużo lokalizacji');
  const stocks = stock.rows;
  const active = (
    await c.query(`SELECT
    (SELECT count(*) FROM reservations WHERE state='active')::int reservations,
    (SELECT count(*) FROM picking_waves WHERE state='picking')::int waves,
    (SELECT count(*) FROM packing_sessions WHERE state='active')::int packing,
    (SELECT count(*) FROM jobs WHERE state IN ('pending','running'))::int jobs`)
  ).rows[0];
  const blockers: string[] = [];
  if (active.reservations || stocks.some((s) => s.reserved !== 0))
    blockers.push('Zakończ aktywne rezerwacje zamówień');
  if (active.waves) blockers.push('Zakończ aktywne fale kompletacji');
  if (active.packing) blockers.push('Zakończ aktywne sesje pakowania');
  if (active.jobs)
    blockers.push('Zakończ oczekujące i wykonywane zadania przed otwarciem magazynu');
  if (stocks.some((s) => s.on_hand > 0 && !['simple', 'variant'].includes(s.kind)))
    blockers.push('Dodatni zapas otwarcia może dotyczyć tylko produktów fizycznych');
  const snapshot = {
    policy: await wmsLotsPolicyInTx(c),
    stocks,
    bins: bins.rows,
    zero_stock: { stocks: stock.zero, bins: bins.zero },
    active,
    blockers,
  };
  bounded(snapshot);
  return snapshot;
}
function previewHead(r: Row, allowed = true) {
  const value = r.snapshot.valuation;
  return redact(
    {
      id: r.id,
      kind: r.kind,
      scope_hash: r.scope_hash,
      policy_version: r.policy_version,
      ready: r.ready,
      issues: r.issues,
      created_at: date(r.created_at),
      expires_at: date(r.expires_at),
      total: r.snapshot.rows?.length ?? r.snapshot.fragments?.length ?? 0,
      known_minor: value.known_minor,
      unknown_quantity: value.unknown_quantity,
      currency: value.currency,
    },
    allowed,
  );
}
async function priorPreview(c: PoolClient, a: WmsActor, kind: string, body: Row) {
  await lockClientKey(c, a, 'preview', body.client_key);
  const r = (await c.query('SELECT * FROM wms_previews WHERE client_key=$1', [body.client_key]))
    .rows[0];
  if (r)
    ensure(
      r.actor_id === a.userId && r.kind === kind && r.request_hash === requestHash(a, kind, body),
      409,
      'Klucz podglądu ma innego aktora lub zakres',
    );
  return r;
}
async function insertPreview(
  c: PoolClient,
  a: WmsActor,
  kind: string,
  body: Row,
  snapshot: Row,
  issues: string[],
) {
  bounded(snapshot);
  const r = (
    await c.query(
      `INSERT INTO wms_previews(id,tenant_id,actor_id,client_key,request_hash,kind,
    policy_version,scope_hash,request,snapshot,ready,issues,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock_timestamp()+interval '15 minutes') RETURNING *`,
      [
        randomUUID(),
        a.tenantId,
        a.userId,
        body.client_key,
        requestHash(a, kind, body),
        kind,
        body.policy_version,
        wmsLotsHash(snapshot),
        JSON.stringify(body),
        JSON.stringify(snapshot),
        issues.length === 0,
        JSON.stringify(issues),
      ],
    )
  ).rows[0];
  await audit(c, a, 'wms.preview', r.id, { kind, scope_hash: r.scope_hash, ready: r.ready });
  return r;
}
export async function wmsLotsMetadata(a: WmsActor) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const p = await wmsLotsPolicyInTx(c);
      const warehouses = (
        await c.query('SELECT id,name,code FROM warehouses ORDER BY id LIMIT 1001')
      ).rows;
      ensure(warehouses.length <= 1000, 413, 'Za dużo magazynów dla metadanych WMS');
      const role = await wmsLotsAssertActorInTx(c, a);
      return {
        current_role: role,
        policy: p,
        warehouses,
        limits: {
          ...S.WMS_LOT_LIMITS,
          ...(await wmsLotLimitsInTx(c)),
          opening_rows: await wmsLotOpeningRowsInTx(c),
        },
        can_read_value: canValue(a, role),
      };
    },
    { wmsAdmission: 'read' },
  );
}
export async function wmsOpeningScope(a: WmsActor, q: { cursor?: string }) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const source = await openingSnapshot(c),
        scope = wmsLotsHash(source);
      const role = await wmsLotsAssertActorInTx(c, a);
      return {
        current_role: role,
        scope_hash: scope,
        active_blockers: source.blockers,
        ...frozenRows(
          source.bins.filter((b) => b.quantity > 0),
          q.cursor,
          { tenant: a.tenantId, scope, kind: 'opening-scope' },
        ),
        can_read_value: canValue(a, role),
      };
    },
    { wmsAdmission: 'read' },
  );
}
function openingPlan(source: Row, b: Row) {
  const issues: string[] = [...source.blockers];
  if (source.policy.enabled || source.policy.version !== b.policy_version)
    issues.push('Polityka została już włączona lub zmieniła wersję');
  const positive = source.bins.filter((r: Row) => r.quantity > 0),
    supplied = new Map<string, Row>();
  for (const row of b.lines) {
    if (supplied.has(key(row))) issues.push('Lokalizacja otwarcia występuje więcej niż raz');
    supplied.set(key(row), row);
  }
  if (positive.length !== supplied.size)
    issues.push('Otwarcie musi obejmować wszystkie dodatnie lokalizacje firmy');
  for (const bin of positive) {
    const row = supplied.get(key(bin));
    if (!row || row.quantity !== bin.quantity || row.stock_version !== bin.stock_version)
      issues.push('Ilość lub wersja lokalizacji otwarcia nie jest aktualna');
  }
  const labels = new Map<string, Row>(positive.map((p: Row): [string, Row] => [key(p), p]));
  const rows = b.lines.map((r: Row) => ({
    ...r,
    sku: labels.get(key(r))?.sku ?? null,
    name: labels.get(key(r))?.name ?? null,
    currency: b.currency,
  }));
  return {
    issues: [...new Set(issues)],
    snapshot: { request: b, source, rows, valuation: wmsValueSummary(rows, b.currency) },
  };
}
export async function createWmsOpeningPreview(a: WmsActor, raw: unknown) {
  const b = input(S.wmsOpeningInput, raw);
  return tenantTx(a.tenantId, async (c) => {
    await admit(c, a, 'serial');
    const previous = await priorPreview(c, a, 'opening', b);
    if (previous)
      return {
        preview: previewHead(previous),
        reused: true,
        current_role: await wmsLotsAssertActorInTx(c, a, true, true, true),
      };
    await earlyWriter(c, a, true);
    await quota(c, true);
    const source = await openingSnapshot(c, true),
      { snapshot, issues } = openingPlan(source, b);
    const p = await insertPreview(c, a, 'opening', b, snapshot, issues);
    const role = await finalWrite(c, a, true, true);
    return { preview: previewHead(p), reused: false, current_role: role };
  }, { wmsAdmission: 'serial' });
}
export async function activateWmsOpening(a: WmsActor, id: string, raw: unknown) {
  const b = input(S.wmsActivateInput, raw),
    request = { preview_id: id, ...b };
  return tenantTx(
    a.tenantId,
    async (c) => {
      await admit(c, a, 'activation');
      const context: S.WmsOperationContext = { client_key: b.client_key, kind: 'opening', request };
      // Read the immutable source before the operation key/source locks. The
      // admission covers the whole tenant opening, including nonstrict pools.
      const openingSource = await getPreview(c, id, 'opening');
      ensure(openingSource.actor_id === a.userId, 404, 'Nie znaleziono własnego otwarcia');
      const catalogEffect = await prepareCatalogStockEffectInTx(c, a, {
        source_kind: 'wms_opening', source_id: id,
        warehouse_ids: openingSource.snapshot.rows.map((row: Row) => row.warehouse_id),
        product_ids: openingSource.snapshot.rows.map((row: Row) => row.product_id),
      });
      const catalogBaseline = await captureCatalogStockEffectJournalsInTx(c, catalogEffect);
      const previous = await priorOperation(c, a, context);
      if (previous) {
        if (catalogEffect) await abandonCatalogStockEffectInTx(c, a, catalogEffect);
        return {
          operation: operationHead(previous),
          result: previous.result,
          reused: true,
          current_role: await wmsLotsAssertActorInTx(c, a, true, true, true),
        };
      }
      const preview = (
        await c.query('SELECT *,expires_at>clock_timestamp() valid FROM wms_previews WHERE id=$1', [
          id,
        ])
      ).rows[0];
      ensure(
        preview && preview.actor_id === a.userId && preview.kind === 'opening',
        404,
        'Nie znaleziono własnego otwarcia',
      );
      ensure(
        preview.valid && preview.ready && preview.scope_hash === b.scope_hash,
        409,
        'Otwarcie nie jest gotowe, wygasło lub ma inny zakres',
      );
      ensure(
        preview.snapshot.valuation.unknown_quantity === '0' || b.ack_unknown_costs,
        422,
        'Potwierdź jawnie nieznany koszt historycznego zapasu',
      );
      await quota(c);
      const source = await openingSnapshot(c, true);
      const current = openingPlan(source, preview.request);
      ensure(
        current.issues.length === 0 && wmsLotsHash(current.snapshot) === b.scope_hash,
        409,
        'Stan, lokalizacje, zadania lub rezerwacje zmieniły się od podglądu',
      );
      const op = randomUUID(),
        layers: Row[] = [];
      // The policy row is tentative and checked only after complete opening layers/journal exist.
      await c.query(
        `INSERT INTO wms_policies(tenant_id,enabled,version,method,currency,exponent,opening_operation_id)
      VALUES($1,true,1,'FIFO',$2,2,$3)`,
        [a.tenantId, preview.request.currency, op],
      );
      a = enlistWmsActorInTx(c, a, { cost: true, adminOnly: true });
      for (const row of preview.snapshot.rows)
        layers.push(
          await makeLayer(
            c,
            a,
            op,
            row.warehouse_id,
            {
              product_id: row.product_id,
              location: row.location,
              quantity: row.quantity,
              lot_code: row.lot_code,
              unit_cost_minor: row.unit_cost_minor,
              currency: row.currency,
            },
            'opening',
          ),
        );
      const result = {
        layers,
        policy: await wmsLotsPolicyInTx(c),
        valuation: preview.snapshot.valuation,
        preview_id: preview.id,
        scope_hash: preview.scope_hash,
      };
      const recorded = await recordOperation(c, a, context, op, result);
      if (catalogEffect && catalogBaseline)
        await finishCatalogStockEffectInTx(c, a, catalogEffect,
          await catalogStockEffectProofInTx(c, catalogBaseline, { operation_id: op }));
      await audit(c, a, 'wms.opening.activate', op, {
        preview_id: preview.id,
        unknown_quantity: result.valuation.unknown_quantity,
      });
      const role = await finalWrite(c, a, true, true);
      return { ...recorded, current_role: role };
    },
    { wmsAdmission: 'activation' },
  );
}
async function getPreview(c: PoolClient, id: string, kind: 'opening' | 'movement') {
  const p = (await c.query('SELECT * FROM wms_previews WHERE id=$1', [id])).rows[0];
  ensure(
    p && (kind === 'opening' ? p.kind === 'opening' : p.kind !== 'opening'),
    404,
    'Nie znaleziono podglądu WMS',
  );
  return p;
}
export type WmsPreviewObserver = { enlist?: (c: PoolClient, p: Row, replay: boolean) => Promise<void> };
export type WmsExecuteObserver = { validate?: (c: PoolClient, p: Row) => Promise<void>; enlist?: (c: PoolClient, p: Row, replay: boolean, operation: Row) => Promise<void> };
export async function wmsPreviewDetail(a: WmsActor, id: string, kind: 'opening' | 'movement', observer: WmsPreviewObserver = {}) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const p = await getPreview(c, id, kind),
        role = await wmsLotsAssertActorInTx(c, a),
        allowed = canValue(a, role);
      await observer.enlist?.(c, p, true);
      const { rows, fragments, positions, ...summary } = p.snapshot;
      return {
        current_role: role,
        can_read_value: allowed,
        preview: previewHead(p, allowed),
        snapshot_summary: redact(
          {
            ...summary,
            rows_count: rows?.length ?? 0,
            fragments_count: fragments?.length ?? 0,
            positions_count: positions?.length ?? 0,
          },
          allowed,
        ),
      };
    },
    { wmsAdmission: 'read' },
  );
}
export async function wmsPreviewRows(
  a: WmsActor,
  id: string,
  kind: 'opening' | 'movement',
  q: { cursor?: string },
) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const p = await getPreview(c, id, kind),
        role = await wmsLotsAssertActorInTx(c, a),
        allowed = canValue(a, role);
      const rows = p.snapshot.rows ?? p.snapshot.fragments;
      return {
        current_role: role,
        can_read_value: allowed,
        ...frozenRows(redact(rows, allowed), q.cursor, {
          tenant: a.tenantId,
          id,
          scope: p.scope_hash,
        }),
      };
    },
    { wmsAdmission: 'read' },
  );
}

async function movementPlan(c: PoolClient, a: WmsActor, b: Row) {
  const p = await policy(c, b.policy_version);
  if (b.kind === 'issue' || (b.kind === 'adjustment' && b.quantity < 0))
    await lockWarehouseInventoryPoliciesInTx(c, [b.warehouse_id], { sellable: true });
  const pairs = [
    { warehouse_id: b.warehouse_id, product_id: b.product_id },
    ...(b.kind === 'transfer'
      ? [{ warehouse_id: b.destination_warehouse_id, product_id: b.product_id }]
      : []),
  ];
  ensure(
    b.stock_versions.length === pairs.length &&
      pairs.every((pair) =>
        b.stock_versions.some(
          (v: Row) => v.warehouse_id === pair.warehouse_id && v.product_id === pair.product_id,
        ),
      ),
    422,
    'Potwierdź dokładny zakres stanów ruchu',
  );
  const { stocks } = await lockStocks(c, a, b.stock_versions);
  const sourceRows = await positions(c, b.warehouse_id, b.product_id, true);
  const destinationRows =
    b.kind === 'transfer' ? await positions(c, b.destination_warehouse_id, b.product_id, true) : [];
  let fragments: Row[];
  if (b.kind === 'adjustment' && b.quantity > 0) {
    ensure(b.currency === p.currency, 422, 'Korekta wymaga waluty polityki, bez FX');
    fragments = [
      {
        layer_id: null,
        lot_id: null,
        lot_code: b.lot_code,
        location: b.location,
        quantity: b.quantity,
        unit_cost_minor: b.unit_cost_minor,
        currency: p.currency,
        fifo_sequence: null,
        ...wmsCostValue(b.quantity, b.unit_cost_minor),
      },
    ];
  } else {
    const candidates = sourceRows.filter(
      (r) => r.location === b.location && (!b.layer_ids || b.layer_ids.includes(r.layer_id)),
    );
    if (b.layer_ids)
      ensure(
        b.layer_ids.every((id: string) => candidates.some((r) => r.layer_id === id)),
        422,
        'Warstwa nie należy do lokalizacji źródłowej',
      );
    fragments = selectFifoLayers(candidates, Math.abs(b.quantity)).map((r) => {
      const source = candidates.find(
        (s) => s.layer_id === r.layer_id && s.location === r.location,
      )!;
      return { ...r, lot_id: source.lot_id, lot_code: source.lot_code };
    });
  }
  const bins = (
    await c.query(
      `SELECT * FROM stock_locations WHERE product_id=$1 AND warehouse_id=ANY($2::uuid[])
    ORDER BY warehouse_id,location COLLATE "C"`,
      [b.product_id, pairs.map((r) => r.warehouse_id)],
    )
  ).rows;
  const sourceBin = bins.find(
    (r) => r.warehouse_id === b.warehouse_id && r.location === b.location,
  );
  const sourceDelta = b.kind === 'adjustment' ? b.quantity : -b.quantity;
  const sourceReserved = sourceRows
    .filter((r) => r.location === b.location)
    .reduce((n, r) => n + r.reserved, 0);
  const targetWarehouse = b.kind === 'transfer' ? b.destination_warehouse_id : b.warehouse_id;
  const targetBin = ['transfer', 'bin_move'].includes(b.kind)
    ? bins.find((r) => r.warehouse_id === targetWarehouse && r.location === b.destination_location)
    : null;
  const source = {
    warehouse_id: b.warehouse_id,
    location: b.location,
    present: Boolean(sourceBin),
    reserved: sourceReserved,
    before_quantity: sourceBin?.quantity ?? 0,
    after_quantity: (sourceBin?.quantity ?? 0) + sourceDelta,
  };
  ensure(
    source.after_quantity >= sourceReserved && source.after_quantity <= 2147483647,
    409,
    'Ruch narusza rezerwację lub zakres lokalizacji',
  );
  const destination = ['transfer', 'bin_move'].includes(b.kind)
    ? {
        warehouse_id: targetWarehouse,
        location: b.destination_location,
        present: Boolean(targetBin),
        reserved: (targetWarehouse === b.warehouse_id ? sourceRows : destinationRows)
          .filter((r) => r.location === b.destination_location)
          .reduce((n, r) => n + r.reserved, 0),
        before_quantity: targetBin?.quantity ?? 0,
        after_quantity: (targetBin?.quantity ?? 0) + b.quantity,
      }
    : null;
  ensure(
    !destination || destination.after_quantity <= 2147483647,
    409,
    'Stan docelowy przekracza limit',
  );
  const totals = stocks.map((s) => {
    const delta =
      b.kind === 'bin_move' ? 0 : s.warehouse_id === b.warehouse_id ? sourceDelta : b.quantity;
    ensure(
      s.on_hand + delta >= s.reserved && s.on_hand + delta <= 2147483647,
      409,
      'Ruch narusza dostępność magazynu',
    );
    return {
      warehouse_id: s.warehouse_id,
      product_id: s.product_id,
      present: s.present,
      version: s.version,
      before_on_hand: s.on_hand,
      after_on_hand: s.on_hand + delta,
      reserved: s.reserved,
    };
  });
  const snapshot = {
    request: b,
    policy: p,
    stock_versions: stocks,
    bins,
    positions: [...sourceRows, ...destinationRows],
    fragments,
    bin_summary: { source, destination, warehouse_totals: totals },
    valuation: wmsValueSummary(valueRows(fragments), p.currency),
  };
  bounded(snapshot);
  return snapshot;
}
export async function createWmsMovementPreview(a: WmsActor, raw: unknown, observer: WmsPreviewObserver = {}) {
  const b = input(S.wmsMovementInput, raw),
    cost = ['issue', 'adjustment'].includes(b.kind);
  return tenantTx(a.tenantId, async (c) => {
    await admit(c, a);
    const previous = await priorPreview(c, a, b.kind, b);
    if (previous) {
      const role = await wmsLotsAssertActorInTx(c, a, true, cost, cost);
      await observer.enlist?.(c, previous, true);
      return {
        preview: previewHead(previous, canValue(a, role)),
        reused: true,
        current_role: role,
      };
    }
    await earlyWriter(c, a, cost);
    await quota(c, true);
    const snapshot = await movementPlan(c, a, b);
    const preview = await insertPreview(c, a, b.kind, b, snapshot, []);
    const role = await finalWrite(c, a, cost, cost);
    await observer.enlist?.(c, preview, false);
    return { preview: previewHead(preview, canValue(a, role)), reused: false, current_role: role };
  });
}
async function physicalBin(
  c: PoolClient,
  a: WmsActor,
  op: string,
  warehouse: string,
  product: string,
  location: string,
  delta: number,
  kind: string,
  note: string,
) {
  if (!delta) return;
  if (delta > 0)
    await c.query(
      `INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,warehouse_id,product_id,location)
    DO UPDATE SET quantity=stock_locations.quantity+excluded.quantity`,
      [a.tenantId, warehouse, product, location, delta],
    );
  else {
    const updated = await c.query(
      `UPDATE stock_locations SET quantity=quantity+$4::integer
      WHERE warehouse_id=$1 AND product_id=$2 AND location=$3 AND quantity>=-($4::integer)`,
      [warehouse, product, location, delta],
    );
    ensure(updated.rowCount === 1, 409, 'Brak towaru w lokalizacji');
  }
  await c.query(
    `INSERT INTO stock_location_movements(tenant_id,warehouse_id,product_id,location,delta,kind,operation_id,note)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.tenantId, warehouse, product, location, delta, 'wms_' + kind, op, note],
  );
}
export async function executeWmsMovement(a: WmsActor, id: string, raw: unknown, observer: WmsExecuteObserver = {}) {
  const b = input(S.wmsExecuteInput, raw),
    request = { preview_id: id, ...b };
  return tenantTx(a.tenantId, async (c) => {
    await admit(c, a);
    const p = await getPreview(c, id, 'movement'),
      kind = p.kind,
      cost = ['issue', 'adjustment'].includes(kind);
    await observer.validate?.(c, p);
    const catalogEffect = await prepareCatalogStockEffectInTx(c,a,{
      source_kind:'wms_movement',source_id:id,product_ids:[p.request.product_id],
      warehouse_ids:[...new Set([p.request.warehouse_id, ...(kind==='transfer' ? [p.request.destination_warehouse_id] : [])])].sort(),
    });
    const catalogBaseline=await captureCatalogStockEffectJournalsInTx(c,catalogEffect);
    const context: S.WmsOperationContext = { client_key: b.client_key, kind, request };
    const previous = await priorOperation(c, a, context);
    if (previous) {
      a = enlistWmsActorInTx(c,a,{cost,adminOnly:cost});
      if(catalogEffect)await abandonCatalogStockEffectInTx(c,a,catalogEffect);
      const correction = await catalogWmsCorrectionDocumentInTx(c,a,previous.id,true);
      const role = await wmsLotsAssertActorInTx(c,a,true,cost,cost), allowed = canValue(a,role);
      const response = {
        operation: operationHead(previous),
        correction_document: projectCatalogWmsCorrectionDocument(correction,allowed),
        result: redact(previous.result,allowed),
        reused: true,
        current_role: role,
      };
      await observer.enlist?.(c, p, true, previous);
      bounded(response);return response;
    }
    ensure(
      p.actor_id === a.userId &&
        p.scope_hash === b.scope_hash &&
        p.ready &&
        new Date(p.expires_at).getTime() > Date.now(),
      409,
      'Podgląd ruchu nie jest własny, gotowy lub aktualny',
    );
    await quota(c);
    const current = await movementPlan(c, a, p.request);
    ensure(
      wmsLotsHash(current) === p.scope_hash,
      409,
      'Stan, warstwy, koszt lub rezerwacje zmieniły się od podglądu',
    );
    const r = p.request;
    a = enlistWmsActorInTx(c, a, { cost, adminOnly: cost });
    // Create formerly absent states only after all-pairs absence/version validation.
    for (const stock of current.stock_versions.filter((s: Row) => !s.present))
      await c.query('INSERT INTO stock(tenant_id,warehouse_id,product_id) VALUES($1,$2,$3)', [
        a.tenantId,
        stock.warehouse_id,
        stock.product_id,
      ]);
    const sourceStock = current.stock_versions.find((s: Row) => s.warehouse_id === r.warehouse_id);
    ensure(sourceStock, 409, 'Brak zamrożonego stanu magazynu źródłowego');
    const docKind =
      kind === 'transfer'
        ? 'transfer'
        : kind === 'issue' || (kind === 'adjustment' && r.quantity < 0)
          ? 'issue'
          : kind === 'adjustment'
            ? 'receipt'
            : 'count';
    const d = await createWarehouseDocument(c, a as Actor, {
      kind: docKind,
      warehouse_id: r.warehouse_id,
      destination_id: kind === 'transfer' ? r.destination_warehouse_id : null,
      reference: 'WMS/' + id,
      note: r.note,
      lines: [
        {
          product_id: r.product_id,
          quantity: docKind === 'count' ? sourceStock.on_hand : Math.abs(r.quantity),
          location: r.location,
          expected_version: sourceStock.version,
        },
      ],
    });
    if(catalogEffect?.number && kind!=='adjustment') {
      ensure(({receipt:'PZ',transfer:'MM',issue:'WZ'} as Record<string,string>)[d.kind]===catalogEffect.number.kind,
        409,'Numeracja nie odpowiada rzeczywistemu ruchowi WMS');
      await c.query('UPDATE warehouse_documents SET number=$2 WHERE id=$1',[d.id,catalogEffect.number.number]);
      d.number=catalogEffect.number.number;
    }
    context.warehouse_document_id = d.id;
    const opTag = randomUUID();
    context.operation_id = opTag;
    await physicalBin(
      c,
      a,
      opTag,
      r.warehouse_id,
      r.product_id,
      r.location,
      kind === 'adjustment' ? r.quantity : -r.quantity,
      kind,
      r.note,
    );
    if (['transfer', 'bin_move'].includes(kind))
      await physicalBin(
        c,
        a,
        opTag,
        kind === 'transfer' ? r.destination_warehouse_id : r.warehouse_id,
        r.product_id,
        r.destination_location,
        r.quantity,
        kind,
        r.note,
      );
    for (const total of current.bin_summary.warehouse_totals) {
      await c.query('UPDATE stock SET on_hand=$3 WHERE warehouse_id=$1 AND product_id=$2', [
        total.warehouse_id,
        total.product_id,
        total.after_on_hand,
      ]);
      const delta = total.after_on_hand - total.before_on_hand;
      if (delta)
        await c.query(
          `INSERT INTO stock_movements(id,tenant_id,warehouse_id,product_id,
        delta,kind,warehouse_document_id,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            a.tenantId,
            total.warehouse_id,
            total.product_id,
            delta,
            'wms_' + kind,
            d.id,
            r.note,
          ],
        );
    }
    let result: any;
    if (['transfer', 'bin_move'].includes(kind))
      result = await transferWmsLotsInTx(c, a, context, {
        product_id: r.product_id,
        warehouse_id: r.warehouse_id,
        destination_warehouse_id: kind === 'transfer' ? r.destination_warehouse_id : r.warehouse_id,
        destination_location: r.destination_location,
        picks: movementPicks(current.fragments),
      });
    else if (kind === 'issue' || r.quantity < 0)
      result = await issueWmsLotsInTx(c, a, context, {
        product_id: r.product_id,
        warehouse_id: r.warehouse_id,
        picks: movementPicks(current.fragments),
      });
    else {
      const op = opTag;
      const layer = await makeLayer(
        c,
        a,
        op,
        r.warehouse_id,
        {
          product_id: r.product_id,
          location: r.location,
          quantity: r.quantity,
          lot_code: r.lot_code,
          unit_cost_minor: r.unit_cost_minor,
          currency: r.currency,
        },
        'adjustment',
        context,
      );
      result = await recordOperation(c, a, context, op, {
        layers: [layer],
        valuation: wmsValueSummary([layer], r.currency),
        signed_delta: r.quantity,
      });
    }
    await c.query(
      "UPDATE warehouse_documents SET status='posted',version=version+1,posted_at=clock_timestamp() WHERE id=$1",
      [d.id],
    );
    await audit(c, a, 'wms.movement.execute', result.operation.id, {
      kind,
      preview_id: id,
      warehouse_document_id: d.id,
    });
    if(catalogEffect&&catalogBaseline)await finishCatalogStockEffectInTx(c,a,catalogEffect,
      await catalogStockEffectProofInTx(c,catalogBaseline,{warehouse_document_id:d.id,operation_id:result.operation.id}));
    const correction = kind==='adjustment' ? await catalogWmsCorrectionDocumentInTx(c,a,result.operation.id,true) : null;
    const role = await finalWrite(c, a, cost, cost);
    const response = { ...result, correction_document: canValue(a,role) ? correction : null, result: redact(result.result, canValue(a, role)), current_role: role };
    await observer.enlist?.(c, p, false, result.operation);
    bounded(response);return response;
  });
}
export async function receiveWmsReceipt(a: WmsActor, raw: unknown) {
  const b = input(S.wmsReceiveInput, raw);
  return tenantTx(a.tenantId, async (c) => {
    await admit(c, a);
    const catalogStockEffect=await prepareCatalogStockEffectInTx(c,a,{
      source_kind:'wms_receipt',source_id:b.client_key,warehouse_ids:[b.warehouse_id],
      product_ids:[...new Set(b.lines.map(line => line.product_id))].sort(),
    });
    const context: S.WmsOperationContext = {
      client_key: b.client_key,
      kind: 'receipt',
      policy_version: b.policy_version,
      request: b,
    };
    const previous = await priorOperation(c, a, context);
    if (previous) {
      if(catalogStockEffect)await abandonCatalogStockEffectInTx(c,a,catalogStockEffect);
      return {
        operation: operationHead(previous),
        result: previous.result,
        reused: true,
        current_role: await wmsLotsAssertActorInTx(c, a, true, true, true),
      };
    }
    await policy(c, b.policy_version);
    await quota(c);
    let existing: Row | undefined;
    await lockWarehouseInventoryPoliciesInTx(c, [b.warehouse_id]);
    if (b.warehouse_document_id) {
      existing = (
        await c.query('SELECT * FROM warehouse_documents WHERE id=$1 FOR UPDATE', [
          b.warehouse_document_id,
        ])
      ).rows[0];
      ensure(
        existing &&
          existing.kind === 'receipt' &&
          existing.status === 'draft' &&
          existing.warehouse_id === b.warehouse_id,
        409,
        'PZ jest zaksięgowane, obce lub nie jest szkicem przyjęcia',
      );
    }
    const products = [...new Set(b.lines.map((r) => r.product_id))];
    ensure(
      b.stock_versions.length === products.length &&
        products.every((id) =>
          b.stock_versions.some((v) => v.product_id === id && v.warehouse_id === b.warehouse_id),
        ),
      422,
      'Potwierdź wszystkie stany przyjęcia',
    );
    await lockStocks(c, a, b.stock_versions);
    const grouped = products.map((id) => {
      const rows = b.lines.filter((r) => r.product_id === id),
        amount = rows.reduce((n, r) => n + r.quantity, 0);
      ensure(amount <= 1000000, 422, 'Pozycja rzeczywistego PZ przekracza limit ilości');
      return { product_id: id, quantity: amount, location: rows[0].location };
    });
    const d =
      existing ??
      (await createWarehouseDocument(c, a as Actor, {
        kind: 'receipt',
        warehouse_id: b.warehouse_id,
        destination_id: null,
        reference: 'WMS/' + b.client_key,
        note: b.note,
        lines: grouped,
      }));
    context.warehouse_document_id = d.id;
    context.purchase_receipt_id = b.purchase_receipt_id;
    a = enlistWmsActorInTx(c, a, { cost: true, adminOnly: true });
    await postWarehouseDocument(c, a as Actor, d.id, d.version, {
      catalogStockEffect,
      wms: { context, receipt_lines: b.lines },
    });
    const operation = (
      await c.query('SELECT * FROM wms_operations WHERE client_key=$1', [b.client_key])
    ).rows[0];
    ensure(operation, 500, 'PZ nie zapisało trwałego przyjęcia partii');
    const role = await finalWrite(c, a, true, true);
    return {
      operation: operationHead(operation),
      result: operation.result,
      reused: false,
      current_role: role,
    };
  });
}

export async function wmsLotPositions(
  a: WmsActor,
  q: { cursor?: string; warehouse_id?: string; product_id?: string; lot_id?: string },
) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const bind = {
        tenant: a.tenantId,
        warehouse_id: q.warehouse_id,
        product_id: q.product_id,
        lot_id: q.lot_id,
      };
      const cur = decode(q.cursor, bind);
      const rows = (
        await c.query(
          `SELECT x.warehouse_id,w.name warehouse_name,x.product_id,p.sku,p.name,
      x.location,x.layer_id,l.lot_id,o.lot_code,l.fifo_sequence,x.quantity,x.reserved,x.quantity-x.reserved available,
      x.version position_version,s.version stock_version,l.unit_cost_minor,l.currency,o.expiry_date::text expiry_date
      FROM wms_layer_positions x JOIN wms_cost_layers l ON (l.tenant_id,l.id)=(x.tenant_id,x.layer_id)
      JOIN wms_lots o ON (o.tenant_id,o.id)=(l.tenant_id,l.lot_id)
      JOIN products p ON (p.tenant_id,p.id)=(x.tenant_id,x.product_id)
      JOIN warehouses w ON (w.tenant_id,w.id)=(x.tenant_id,x.warehouse_id)
      JOIN stock s ON (s.tenant_id,s.warehouse_id,s.product_id)=(x.tenant_id,x.warehouse_id,x.product_id)
      WHERE ($1::uuid IS NULL OR x.warehouse_id=$1) AND ($2::uuid IS NULL OR x.product_id=$2)
      AND ($3::uuid IS NULL OR l.lot_id=$3) AND ($4::uuid IS NULL OR
      (x.warehouse_id,x.product_id,x.location COLLATE "C",x.layer_id)>
      ($4::uuid,$5::uuid,$6::text COLLATE "C",$7::uuid))
      ORDER BY x.warehouse_id,x.product_id,x.location COLLATE "C",x.layer_id LIMIT 51`,
          [
            q.warehouse_id ?? null,
            q.product_id ?? null,
            q.lot_id ?? null,
            cur?.warehouse ?? null,
            cur?.product ?? null,
            cur?.location ?? null,
            cur?.layer ?? null,
          ],
        )
      ).rows;
      const data = rows.slice(0, 50).map((r) => {
        const value = wmsCostValue(r.quantity, r.unit_cost_minor);
        return {
          ...r,
          value_minor: r.unit_cost_minor === null ? null : value.known_minor,
          unknown_quantity: value.unknown_quantity,
        };
      });
      const role = await wmsLotsAssertActorInTx(c, a),
        allowed = canValue(a, role),
        last = data.at(-1);
      return {
        current_role: role,
        can_read_value: allowed,
        data: redact(data, allowed),
        meta: {
          cursor:
            rows.length > 50
              ? encode({
                  bind: wmsLotsHash(bind),
                  warehouse: last.warehouse_id,
                  product: last.product_id,
                  location: last.location,
                  layer: last.layer_id,
                })
              : null,
        },
      };
    },
    { wmsAdmission: 'read' },
  );
}
const valuationNumericFields = [
  'quantity', 'known_minor', 'unknown_quantity', 'known_quantity', 'zero_cost_quantity',
  'reserved_quantity', 'physical_available', 'sellable_quantity', 'sellable_available',
] as const;
function valuationTotals(rows: Array<Record<typeof valuationNumericFields[number], string>>,
  currency: string, exponent: number): S.WmsValuationTotals {
  const totals = Object.fromEntries(valuationNumericFields.map(field => {
    const value = rows.reduce((sum, row) => {
      ensure(typeof row[field] === 'string' && /^(0|[1-9][0-9]*)$/.test(row[field]),
        422, 'Nieprawidłowa dokładna suma wyceny');
      return sum + BigInt(row[field]);
    }, 0n);
    ensure(value <= 9223372036854775807n, 422, 'Raport wartości przekracza obsługiwany zakres int64');
    return [field, value.toString()];
  })) as Record<typeof valuationNumericFields[number], string>;
  ensure(BigInt(totals.known_quantity) + BigInt(totals.unknown_quantity) === BigInt(totals.quantity)
    && BigInt(totals.zero_cost_quantity) <= BigInt(totals.known_quantity)
    && BigInt(totals.reserved_quantity) + BigInt(totals.physical_available) === BigInt(totals.quantity)
    && BigInt(totals.sellable_quantity) <= BigInt(totals.quantity)
    && BigInt(totals.sellable_available) <= BigInt(totals.physical_available),
  409, 'Ilości wyceny nie zachowują fizycznego zapasu');
  return { ...totals, totalquantity: totals.quantity, physical_quantity: totals.quantity, currency, exponent };
}
export async function wmsValuation(a: WmsActor, input: { warehouse_id?: string; product_id?: string }) {
  const q = S.wmsValuationQuery.parse(input), c = await pool.connect();
  try {
    // Data and current warehouse classification share exactly one RR snapshot.
    // No stock, policy or historical receipt is written by this report.
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    await c.query("SET LOCAL statement_timeout='8s'");
    await c.query("SET LOCAL TimeZone='UTC'");
    // Preserve read admission against concurrent FIFO activation. RR retains
    // its original snapshot across this wait; it is not rebased after activation.
    // This shared policy lock does not serialize ordinary stock/MM writers.
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
      'wms.policy:' + a.tenantId,
    ]);
    const p = await policy(c);
    const policiesAvailable = await warehouseInventoryPoliciesAvailable(c);
    const snapshotAt = (await c.query('SELECT transaction_timestamp() snapshot_at')).rows[0].snapshot_at;
    // Limit metadata before evaluating the guarded getter once per warehouse.
    const ids = (await c.query(`SELECT id FROM warehouses
      WHERE ($1::uuid IS NULL OR id=$1) ORDER BY id LIMIT $2`,
    [q.warehouse_id ?? null, S.WMS_VALUATION_WAREHOUSE_LIMIT + 1])).rows.map(row => row.id);
    ensure(ids.length <= S.WMS_VALUATION_WAREHOUSE_LIMIT, 413, 'Raport wyceny przekracza limit 200 magazynów');
    const rows = (await c.query(`${warehousePolicyMapSQL(policiesAvailable, { warehouseArrayParam: 1 })}
      SELECT w.id warehouse_id,w.name,w.code,w.policy,
        coalesce(sum(x.quantity),0)::text quantity,
        coalesce(sum(x.reserved),0)::text reserved_quantity,
        coalesce(sum(x.quantity-x.reserved),0)::text physical_available,
        (CASE WHEN w.policy->>'usage'='sale' AND (w.policy->>'enabled')::boolean
          THEN coalesce(sum(x.quantity),0) ELSE 0 END)::text sellable_quantity,
        (CASE WHEN w.policy->>'usage'='sale' AND (w.policy->>'enabled')::boolean
          THEN coalesce(sum(x.quantity-x.reserved),0) ELSE 0 END)::text sellable_available,
        coalesce(sum(CASE WHEN l.unit_cost_minor IS NULL THEN 0 ELSE x.quantity::numeric*l.unit_cost_minor END),0)::text known_minor,
        coalesce(sum(CASE WHEN l.unit_cost_minor IS NULL THEN x.quantity ELSE 0 END),0)::text unknown_quantity,
        coalesce(sum(CASE WHEN l.unit_cost_minor IS NULL THEN 0 ELSE x.quantity END),0)::text known_quantity,
        coalesce(sum(CASE WHEN l.unit_cost_minor=0 THEN x.quantity ELSE 0 END),0)::text zero_cost_quantity,
        coalesce(bool_and(l.currency=$3 OR l.id IS NULL),true) currency_valid
      FROM warehouse_policy_map w
      LEFT JOIN wms_layer_positions x ON (x.tenant_id,x.warehouse_id)=(w.tenant_id,w.id)
        AND ($2::uuid IS NULL OR x.product_id=$2)
      LEFT JOIN wms_cost_layers l ON (l.tenant_id,l.id)=(x.tenant_id,x.layer_id)
      GROUP BY w.id,w.name,w.code,w.policy ORDER BY w.id`,
    [ids, q.product_id ?? null, p.currency])).rows;
    ensure(rows.every(row => row.currency_valid), 409, 'Warstwy wymagają jednej waluty wyceny');
    const warehouses: S.WmsPhysicalValuation['warehouses'] = rows.map(row => ({
      warehouse_id: row.warehouse_id, name: row.name, code: row.code, policy: row.policy,
      valuation: valuationTotals([row], p.currency, p.exponent),
    }));
    const usageBuckets: S.WmsPhysicalValuation['usage_buckets'] = (['sale', 'custody'] as const).map(usage => ({
      usage, valuation: valuationTotals(warehouses.filter(row => row.policy.usage === usage).map(row => row.valuation), p.currency, p.exponent),
    }));
    const valuation: S.WmsPhysicalValuation = {
      ...valuationTotals(warehouses.map(row => row.valuation), p.currency, p.exponent),
      snapshot_at: date(snapshotAt), warehouse_policy_available: policiesAvailable,
      warehouses, usage_buckets: usageBuckets,
    };
    bounded(valuation);
    await c.query('COMMIT');
    // Fresh authority must not read the older RR snapshot. A separate final RC
    // transaction on this same client observes revocation after actual waits,
    // pins membership/key until COMMIT, and never retries a data transaction.
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    await c.query("SET LOCAL statement_timeout='8s'");
    await warehouseInventoryPoliciesAvailable(c);
    const role = await wmsLotsAssertActorInTx(c, a, false, false, true);
    await c.query('COMMIT');
    return { current_role: role, can_read_value: true, valuation };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { c.release(); }
}
export async function wmsLotTrace(a: WmsActor, id: string, q: { cursor?: string }) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const lot = (
        await c.query(
          'SELECT id,product_id,lot_code,origin,expiry_date::text expiry_date,created_at FROM wms_lots WHERE id=$1',
          [id],
        )
      ).rows[0];
      ensure(lot, 404, 'Nie znaleziono partii');
      const bind = { tenant: a.tenantId, lot: id },
        cur = decode(q.cursor, bind);
      const rows = (
        await c.query(
          `SELECT m.*,op.order_id,op.warehouse_document_id,op.purchase_receipt_id,op.return_id,
      to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') cursor_at
      FROM wms_layer_movements m JOIN wms_cost_layers l ON (l.tenant_id,l.id)=(m.tenant_id,m.layer_id)
      JOIN wms_operations op ON (op.tenant_id,op.id)=(m.tenant_id,m.operation_id)
      WHERE l.lot_id=$1 AND ($2::timestamptz IS NULL OR (m.created_at,m.id)<($2::timestamptz,$3::uuid))
      ORDER BY m.created_at DESC,m.id DESC LIMIT 51`,
          [id, cur?.at ?? null, cur?.id ?? null],
        )
      ).rows;
      const take = rows.slice(0, 50),
        last = take.at(-1),
        role = await wmsLotsAssertActorInTx(c, a),
        allowed = canValue(a, role);
      return {
        current_role: role,
        can_read_value: allowed,
        lot: { ...lot, created_at: date(lot.created_at) },
        data: redact(
          take.map(({ cursor_at, ...r }) => ({ ...r, created_at: date(r.created_at) })),
          allowed,
        ),
        meta: {
          cursor:
            rows.length > 50
              ? encode({ bind: wmsLotsHash(bind), at: last.cursor_at + '+00', id: last.id })
              : null,
        },
      };
    },
    { wmsAdmission: 'read' },
  );
}
export async function wmsOperations(a: WmsActor, q: { cursor?: string; order_id?: string }) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const bind = { tenant: a.tenantId, order: q.order_id },
        cur = decode(q.cursor, bind);
      const rows = (
        await c.query(
          `SELECT id,kind,order_id,warehouse_document_id,purchase_receipt_id,return_id,policy_version,
      created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') cursor_at
      FROM wms_operations WHERE ($1::uuid IS NULL OR order_id=$1)
      AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 51`,
          [q.order_id ?? null, cur?.at ?? null, cur?.id ?? null],
        )
      ).rows;
      const take = rows.slice(0, 50), last = take.at(-1);
      const correctionHeads = await catalogWmsCorrectionHeadsInTx(c, a, take.map(r => r.id));
      // No hydration query follows this fresh native actor/key/value PIN.
      const role = await wmsLotsAssertActorInTx(c, a);
      return {
        current_role: role,
        can_read_value: canValue(a, role),
        data: take.map(r => ({...operationHead(r), correction_head: correctionHeads.get(r.id) ?? null})),
        meta: {
          cursor:
            rows.length > 50
              ? encode({ bind: wmsLotsHash(bind), at: last.cursor_at + '+00', id: last.id })
              : null,
        },
      };
    },
    { wmsAdmission: 'read' },
  );
}
export async function wmsOperationDetail(a: WmsActor, id: string) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const r = (await c.query('SELECT * FROM wms_operations WHERE id=$1', [id])).rows[0];
      ensure(r, 404, 'Nie znaleziono operacji WMS');
      const correction = await catalogWmsCorrectionDocumentInTx(c,a,r.id,true);
      const role = await wmsLotsAssertActorInTx(c, a),
        allowed = canValue(a, role);
      const response = {
        current_role: role,
        can_read_value: allowed,
        operation: operationHead(r),
        correction_document: projectCatalogWmsCorrectionDocument(correction,allowed),
        result: redact(r.result, allowed),
        request: redact(r.request, allowed),
      };
      bounded(response);return response;
    },
    { wmsAdmission: 'read' },
  );
}
export async function wmsOrderAllocations(a: WmsActor, orderId: string, q: { cursor?: string }) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const order = (
        await c.query('SELECT id,number,status,version FROM orders WHERE id=$1 FOR SHARE', [
          orderId,
        ])
      ).rows[0];
      ensure(order, 404, 'Nie znaleziono własnego zamówienia');
      const rows = (
        await c.query(
          `SELECT r.*,l.lot_id,l.fifo_sequence,o.lot_code FROM wms_reservation_layers r
      JOIN wms_cost_layers l ON (l.tenant_id,l.id)=(r.tenant_id,r.layer_id)
      JOIN wms_lots o ON (o.tenant_id,o.id)=(l.tenant_id,l.lot_id)
      WHERE r.order_id=$1 ORDER BY r.product_id,r.layer_id,r.location COLLATE "C"`,
          [orderId],
        )
      ).rows;
      ensure(
        rows.length <= S.WMS_LOT_LIMITS.physical_rows,
        413,
        'Za dużo fragmentów tego zamówienia',
      );
      const blockers: string[] = [];
      if (!(await wmsLotsPolicyInTx(c)).enabled) blockers.push('Polityka partii jest wyłączona');
      if (order.status !== 'picking') blockers.push('Zamówienie nie jest w kompletacji');
      if (
        (
          await c.query(
            `SELECT 1 FROM picking_wave_orders x JOIN picking_waves w
      ON (w.tenant_id,w.id)=(x.tenant_id,x.wave_id) WHERE x.order_id=$1 AND w.state='picking' LIMIT 1`,
            [orderId],
          )
        ).rowCount
      )
        blockers.push('Skanuj w aktywnej fali kompletacji');
      if (
        (
          await c.query(
            "SELECT 1 FROM packing_sessions WHERE order_id=$1 AND state='active' LIMIT 1",
            [orderId],
          )
        ).rowCount
      )
        blockers.push('Skanuj w aktywnej sesji pakowania');
      const role = await wmsLotsAssertActorInTx(c, a, false, false, false, true);
      return {
        current_role: role,
        can_read_value: canValue(a, role),
        order: { ...order, version: String(order.version) },
        can_scan:
          ['admin', 'operator'].includes(role) &&
          blockers.length === 0 &&
          rows.some((r) => r.state === 'active' && r.scanned < r.quantity),
        blockers,
        ...frozenRows(rows, q.cursor, {
          tenant: a.tenantId,
          order: orderId,
          hash: wmsLotsHash(rows),
        }),
      };
    },
    { wmsAdmission: 'read' },
  );
}
export async function wmsOrderReturnFragments(
  a: WmsActor,
  orderId: string,
  q: { cursor?: string },
) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      ensure(
        (await c.query('SELECT id FROM orders WHERE id=$1 FOR SHARE', [orderId])).rowCount,
        404,
        'Nie znaleziono własnego zamówienia',
      );
      const rows = (
        await c.query(
          `SELECT f.*,l.lot_id,o.lot_code,
      (SELECT coalesce(sum(quantity),0)::int FROM wms_return_fragments r WHERE
      (r.tenant_id,r.issue_fragment_id)=(f.tenant_id,f.id)) returned_quantity
      FROM wms_issue_fragments f JOIN wms_cost_layers l ON (l.tenant_id,l.id)=(f.tenant_id,f.layer_id)
      JOIN wms_lots o ON (o.tenant_id,o.id)=(l.tenant_id,l.lot_id)
      WHERE f.order_id=$1 ORDER BY f.id`,
          [orderId],
        )
      ).rows;
      ensure(
        rows.length <= S.WMS_LOT_LIMITS.physical_rows,
        413,
        'Za dużo fragmentów tego zamówienia',
      );
      const role = await wmsLotsAssertActorInTx(c, a, false, false, false, true),
        allowed = canValue(a, role);
      const data = rows.map((r) => ({
        ...r,
        created_at: date(r.created_at),
        remaining: r.quantity - r.returned_quantity,
      }));
      return {
        current_role: role,
        can_read_value: allowed,
        ...frozenRows(redact(data, allowed), q.cursor, {
          tenant: a.tenantId,
          order: orderId,
          hash: wmsLotsHash(data),
        }),
      };
    },
    { wmsAdmission: 'read' },
  );
}
