import { randomUUID, createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tenantTx, localConfig, pool } from './db';
import { ensure } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { audit } from './domain';
import {
  wmsLotsHash,
  wmsLotsPolicyInTx,
  wmsLotsAssertActorInTx,
  wmsLotsEvidenceBudgetInTx,
} from './wms-lots';
import { assertWmsSerialAdmissionInTx, enlistWmsActorInTx, type WmsAdmission } from './wms-lots-transaction';
import { selectFifoLayers, wmsCostValue } from './wms-lots-values';
import { applyWmsStocktakeInTx } from './wms-stocktake-apply';
import { wmsStocktakeQuotaInTx } from './stocktake-limits';
import * as S from './wms-stocktakes-schema';
type Row = Record<string, any>;
type Actor = S.WmsStocktakeActor;
export type WmsStocktakeBasis = {
  stock: Row;
  bin: Row;
  layers: Row[];
  reservations: Row[];
  quantity: number;
  reserved: number;
  scope_changed: boolean;
};
type Basis = WmsStocktakeBasis;
type Measurements = Map<string, Row>;
const L = S.WMS_STOCKTAKE_LIMITS;
const max = 9223372036854775807n;
function bounded(v: unknown, n: number = L.response_bytes) {
  ensure(Buffer.byteLength(JSON.stringify(v)) <= n, 413, 'Zakres spisu przekracza limit bajtów');
}
function parsed<T>(schema: { parse(v: unknown): T }, v: unknown) {
  bounded(v, L.request_bytes);
  return schema.parse(v);
}
const requestHash = (a: Actor, kind: string, id: string | null, b: unknown) =>
  wmsLotsHash({
    actor_id: a.userId,
    source: a.source ?? 'manual',
    kind,
    parent_id: id,
    request: b,
  });
const token = (a: Actor, line: Row, b: Basis) =>
  createHmac('sha256', localConfig.encryptionKey)
    .update(
      wmsLotsHash({
        tenant: a.tenantId,
        actor: a.userId,
        line: line.id,
        version: line.version,
        basis: b,
      }),
    )
    .digest('hex');
const visibleValue = (a: Actor, role: string) => role === 'admin' && a.canReadValue !== false;
const newVersion = (h: Row) => {
  ensure(BigInt(h.version) < max, 422, 'Wyczerpano wersje spisu');
  return (BigInt(h.version) + 1n).toString();
};
const date = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null));
export async function wmsStocktakesAvailable(c: PoolClient) {
  return Boolean(
    (
      await c.query(`SELECT bool_and(to_regclass('public.'||name) IS NOT NULL) available
      FROM unnest(ARRAY['wms_stocktakes','wms_stocktake_lines','wms_stocktake_scope_layers',
      'wms_stocktake_measurements','wms_stocktake_measurement_layers','wms_stocktake_reviews',
      'wms_stocktake_review_rows','wms_stocktake_postings']) name`)
    ).rows[0].available,
  );
}
async function stocktakeTx<T extends { current_role: string }>(
  a: Actor,
  callback: (c: PoolClient) => Promise<T>,
  // Stocktake writes are tenant-wide procedures: the exclusive operations lock (250).
  options: { wmsAdmission?: WmsAdmission } = { wmsAdmission: 'serial' },
) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const result = await callback(c);
      const response = { ...result, can_read_value: visibleValue(a, result.current_role) };
      bounded(response);
      return response;
    },
    options,
  );
}
async function available(c: PoolClient) {
  ensure(await wmsStocktakesAvailable(c), 503, 'Kopia nie zawiera inwentaryzacji partii');
}
async function early(c: PoolClient, a: Actor, admin = false) {
  await available(c);
  const r = (await c.query('SELECT wms_current_role($1,false) role', [a.userId])).rows[0].role;
  ensure(r === 'admin' || (!admin && r === 'operator'), 403, 'Brak bieżącego prawa zapisu spisu');
}
async function finish(
  c: PoolClient,
  a: Actor,
  admin = false,
  cost = false,
  internal: WmsStocktakeInternal = {},
): Promise<string> {
  if (internal.stockFileImportId) {
    const grant = (
      await c.query('SELECT stock_file_import_access($1,$2,true,false) result', [
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].result;
    ensure(grant.key_valid !== false, 401, 'Klucz API został cofnięty lub wygasł');
    ensure(grant.allowed === true, 403, 'Brak aktualnej zgody importu stanów');
    ensure(grant.role === 'admin', 403, 'Brak aktualnego administratora');
    return grant.role as string;
  }
  await wmsLotsEvidenceBudgetInTx(c);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const role = await wmsLotsAssertActorInTx(c, a, true, admin, cost);
  ensure(role, 403, 'Brak aktualnego uprawnienia');
  return role;
}
async function head(c: PoolClient, id: string, lock = false) {
  await available(c);
  const h = (
    await c.query(`SELECT * FROM wms_stocktakes WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])
  ).rows[0];
  ensure(h, 404, 'Nie znaleziono spisu');
  return h as Row;
}
async function lines(c: PoolClient, id: string) {
  return (
    await c.query('SELECT * FROM wms_stocktake_lines WHERE stocktake_id=$1 ORDER BY id', [id])
  ).rows as Row[];
}
const quota = wmsStocktakeQuotaInTx;
function currentPolicy(p: Row, h: Row) {
  ensure(
    p.enabled && p.version === h.policy_version && p.currency === h.currency,
    409,
    'Polityka WMS zmieniła się',
  );
}
async function lockPhysical(
  c: PoolClient,
  warehouse: string,
  ids: string[],
  write: boolean,
  scope: Row[],
) {
  if (!ids.length) return;
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    `catalog:${(await c.query("SELECT current_setting('app.tenant_id') tenant")).rows[0].tenant}`,
  ]);
  const ps = (
    await c.query('SELECT id,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [
      ids,
    ])
  ).rows;
  ensure(
    ps.length === ids.length && ps.every((p) => ['simple', 'variant'].includes(p.kind)),
    422,
    'Spis wymaga własnych fizycznych produktów',
  );
  await c.query(
    `SELECT product_id FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR ${write ? 'UPDATE' : 'SHARE'}`,
    [warehouse, ids],
  );
  await c.query(
    `WITH scope AS MATERIALIZED (
       SELECT DISTINCT product_id,location FROM jsonb_to_recordset($3::jsonb) x(product_id uuid,location text,lot_id uuid)
     )
     SELECT p.product_id FROM stock_locations p JOIN scope x
       ON (x.product_id,x.location)=(p.product_id,p.location)
     WHERE p.warehouse_id=$1 AND p.product_id=ANY($2::uuid[])
     ORDER BY p.product_id,p.location COLLATE "C" FOR ${write ? 'UPDATE' : 'SHARE'} OF p`,
    [warehouse, ids, JSON.stringify(scope)],
  );
  await c.query(
    `WITH scope AS MATERIALIZED (
       SELECT DISTINCT product_id,location,lot_id FROM jsonb_to_recordset($3::jsonb) x(product_id uuid,location text,lot_id uuid)
     ), scope_bins AS MATERIALIZED (
       SELECT DISTINCT product_id,location FROM scope
     ), physical_layers AS MATERIALIZED (
       SELECT pos.tenant_id,pos.product_id,pos.location,pos.layer_id,layer.lot_id
       FROM wms_layer_positions pos JOIN wms_cost_layers layer
         ON (layer.tenant_id,layer.id,layer.product_id)=(pos.tenant_id,pos.layer_id,pos.product_id)
       WHERE pos.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
         AND pos.warehouse_id=$1 AND pos.product_id=ANY($2::uuid[])
         AND EXISTS(SELECT 1 FROM scope_bins bin WHERE (bin.product_id,bin.location)=(pos.product_id,pos.location))
     ), scoped_layers AS MATERIALIZED (
       SELECT physical.tenant_id,physical.product_id,physical.location,physical.layer_id
       FROM physical_layers physical JOIN scope requested
         ON (requested.product_id,requested.location,requested.lot_id)=(physical.product_id,physical.location,physical.lot_id)
     )
     SELECT p.layer_id FROM (
       SELECT * FROM scoped_layers
       ORDER BY product_id,location COLLATE "C",layer_id OFFSET 0
     ) x JOIN LATERAL (
       SELECT base.* FROM wms_layer_positions base
       WHERE (base.tenant_id,base.warehouse_id,base.product_id,base.location,base.layer_id)
         =(x.tenant_id,$1::uuid,x.product_id,x.location,x.layer_id)
         AND base.product_id=ANY($2::uuid[]) OFFSET 0
     ) p ON true
     ORDER BY p.product_id,p.location COLLATE "C",p.layer_id FOR ${write ? 'UPDATE' : 'SHARE'} OF p`,
    [warehouse, ids, JSON.stringify(scope)],
  );
}
async function bases(c: PoolClient, h: Row, ls: Row[], write = false): Promise<Map<string, Basis>> {
  const ids = [...new Set(ls.map((l) => l.product_id as string))].sort();
  const scope = ls.map((l) => ({
    product_id: l.product_id,
    location: l.location,
    lot_id: l.lot_id,
  }));
  await lockPhysical(c, h.warehouse_id, ids, write, scope);
  const stocks = (
    await c.query('SELECT * FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[])', [
      h.warehouse_id,
      ids,
    ])
  ).rows;
  const bins = (
    await c.query(
      `WITH scope AS MATERIALIZED (
         SELECT DISTINCT product_id,location FROM jsonb_to_recordset($3::jsonb) x(product_id uuid,location text,lot_id uuid)
       )
       SELECT p.* FROM stock_locations p JOIN scope x ON (x.product_id,x.location)=(p.product_id,p.location)
       WHERE p.warehouse_id=$1 AND p.product_id=ANY($2::uuid[])`,
      [h.warehouse_id, ids, JSON.stringify(scope)],
    )
  ).rows;
  const layers = (
    await c.query(
      `WITH scope AS MATERIALIZED (
         SELECT DISTINCT product_id,location,lot_id FROM jsonb_to_recordset($3::jsonb) x(product_id uuid,location text,lot_id uuid)
       ), scope_bins AS MATERIALIZED (
         SELECT DISTINCT product_id,location FROM scope
       ), physical_layers AS MATERIALIZED (
         SELECT pos.tenant_id,pos.product_id,pos.location,pos.layer_id,layer.lot_id
         FROM wms_layer_positions pos JOIN wms_cost_layers layer
           ON (layer.tenant_id,layer.id,layer.product_id)=(pos.tenant_id,pos.layer_id,pos.product_id)
         WHERE pos.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
           AND pos.warehouse_id=$1 AND pos.product_id=ANY($2::uuid[])
           AND EXISTS(SELECT 1 FROM scope_bins bin WHERE (bin.product_id,bin.location)=(pos.product_id,pos.location))
       ), scoped_layers AS MATERIALIZED (
         SELECT physical.tenant_id,physical.product_id,physical.location,physical.layer_id
         FROM physical_layers physical JOIN scope requested
           ON (requested.product_id,requested.location,requested.lot_id)=(physical.product_id,physical.location,physical.lot_id)
       )
 SELECT p.product_id,p.location,p.layer_id,p.quantity,p.reserved,p.version,l.lot_id,l.fifo_sequence,l.unit_cost_minor,l.currency
 FROM scoped_layers x JOIN LATERAL (
   SELECT base.* FROM wms_layer_positions base
   WHERE (base.tenant_id,base.warehouse_id,base.product_id,base.location,base.layer_id)
     =(x.tenant_id,$1::uuid,x.product_id,x.location,x.layer_id)
     AND base.product_id=ANY($2::uuid[]) OFFSET 0
 ) p ON true
 JOIN wms_cost_layers l ON (l.tenant_id,l.id,l.product_id)=(p.tenant_id,p.layer_id,p.product_id)
 ORDER BY p.product_id,p.location COLLATE "C",l.fifo_sequence,l.id`,
      [h.warehouse_id, ids, JSON.stringify(scope)],
    )
  ).rows;
  const reservations = (
    await c.query(
      `WITH scope AS MATERIALIZED (
         SELECT DISTINCT product_id,location,lot_id FROM jsonb_to_recordset($3::jsonb) x(product_id uuid,location text,lot_id uuid)
       ), scope_bins AS MATERIALIZED (
         SELECT DISTINCT product_id,location FROM scope
       ), physical_layers AS MATERIALIZED (
         SELECT pos.tenant_id,pos.product_id,pos.location,pos.layer_id,layer.lot_id
         FROM wms_layer_positions pos JOIN wms_cost_layers layer
           ON (layer.tenant_id,layer.id,layer.product_id)=(pos.tenant_id,pos.layer_id,pos.product_id)
         WHERE pos.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
           AND pos.warehouse_id=$1 AND pos.product_id=ANY($2::uuid[])
           AND EXISTS(SELECT 1 FROM scope_bins bin WHERE (bin.product_id,bin.location)=(pos.product_id,pos.location))
       ), scoped_layers AS MATERIALIZED (
         SELECT physical.tenant_id,physical.product_id,physical.location,physical.layer_id
         FROM physical_layers physical JOIN scope requested
           ON (requested.product_id,requested.location,requested.lot_id)=(physical.product_id,physical.location,physical.lot_id)
       )
 SELECT p.order_id,p.product_id,p.location,p.layer_id,p.quantity,p.scanned,p.state
 FROM wms_reservation_layers p JOIN scoped_layers x ON (x.tenant_id,x.product_id,x.location,x.layer_id)=(p.tenant_id,p.product_id,p.location,p.layer_id)
 WHERE p.warehouse_id=$1 AND p.product_id=ANY($2::uuid[]) ORDER BY p.product_id,p.location COLLATE "C",p.layer_id,p.order_id`,
      [h.warehouse_id, ids, JSON.stringify(scope)],
    )
  ).rows;
  const out = new Map<string, Basis>();
  const stocksByProduct = new Map(stocks.map((r) => [r.product_id, r]));
  const binsByKey = new Map(bins.map((r) => [JSON.stringify([r.product_id, r.location]), r]));
  const layerGroups = new Map<string, Row[]>(),
    reservationGroups = new Map<string, Row[]>();
  const layerLots = new Map(layers.map((r) => [r.layer_id, r.lot_id]));
  for (const r of layers) {
    const k = JSON.stringify([r.product_id, r.location, r.lot_id]);
    const group = layerGroups.get(k) ?? [];
    group.push(r);
    layerGroups.set(k, group);
  }
  for (const r of reservations) {
    const k = JSON.stringify([r.product_id, r.location, layerLots.get(r.layer_id)]);
    const group = reservationGroups.get(k) ?? [];
    group.push(r);
    reservationGroups.set(k, group);
  }
  for (const l of ls) {
    const groupKey = JSON.stringify([l.product_id, l.location, l.lot_id]);
    const layerRows = layerGroups.get(groupKey) ?? [];
    const s = stocksByProduct.get(l.product_id),
      b = binsByKey.get(JSON.stringify([l.product_id, l.location]));
    const keys = layerRows.map((r) => r.layer_id).sort();
    const scopeChanged = wmsLotsHash(keys) !== wmsLotsHash(l.original.layer_ids ?? []);
    const quantity = layerRows.reduce((n, r) => n + r.quantity, 0),
      reserved = layerRows.reduce((n, r) => n + r.reserved, 0);
    ensure(
      Number.isSafeInteger(quantity) && quantity <= 2147483647,
      422,
      'Ilość partii przekracza int32',
    );
    out.set(l.id, {
      stock: {
        present: Boolean(s),
        version: s?.version ?? '0',
        on_hand: s?.on_hand ?? 0,
        reserved: s?.reserved ?? 0,
      },
      bin: { present: Boolean(b), quantity: b?.quantity ?? 0 },
      layers: layerRows,
      reservations: reservationGroups.get(groupKey) ?? [],
      quantity,
      reserved,
      scope_changed: scopeChanged,
    });
  }
  return out;
}
async function measures(c: PoolClient, ls: Row[]): Promise<Measurements> {
  const ids = [...new Set(ls.map((l) => l.latest_measurement_id).filter(Boolean))];
  const rows = (
    await c.query('SELECT id,result FROM wms_stocktake_measurements WHERE id=ANY($1::uuid[])', [
      ids,
    ])
  ).rows;
  const index = new Map<string, Row>();
  for (const m of rows)
    for (const line of m.result.lines ?? []) index.set(m.id + ':' + line.line_id, line);
  return index;
}
function needs(l: Row, b: Basis, ms: Measurements) {
  if (l.counted === null) return false;
  const f = ms.get(l.latest_measurement_id + ':' + l.id);
  return !f || f.basis_hash !== wmsLotsHash(b) || b.scope_changed;
}
function lineView(a: Actor, role: string, h: Row, l: Row, b: Basis, ms: Measurements) {
  const output: Row = {
    id: l.id,
    product_id: l.product_id,
    sku: l.sku,
    name: l.name,
    location: l.location,
    lot: l.lot,
    counted: l.counted,
    version: l.version,
    basis_token: token(a, l, b),
    needs_recount: !['posted', 'cancelled'].includes(h.state) && needs(l, b, ms),
  };
  if (role === 'admin' || (!h.blind && role !== 'viewer'))
    Object.assign(output, {
      original_quantity: l.original.quantity,
      current_quantity: b.quantity,
      reserved: b.reserved,
      difference: l.counted === null ? null : l.counted - b.quantity,
      scope_changed: b.scope_changed,
    });
  return output;
}
function headView(h: Row, ls: Row[] = [], bs?: Map<string, Basis>, ms: Measurements = new Map()) {
  return {
    id: h.id,
    warehouse_id: h.warehouse_id,
    name: h.name,
    state: h.state,
    version: h.version,
    scope_hash: h.scope_hash,
    blind: h.blind,
    policy_version: h.policy_version,
    currency: h.currency,
    line_count: ls.length,
    counted_count: ls.filter((l) => l.counted !== null).length,
    needs_recount_count:
      bs && !['posted', 'cancelled'].includes(h.state)
        ? ls.filter((l) => needs(l, bs.get(l.id)!, ms)).length
        : 0,
    created_at: h.created_at,
    latest_review_id: h.last_review_id,
    posting_id: h.posting_id,
  };
}
function summaryView(summary: Row, value: boolean) {
  return value ? summary : { total: summary.total };
}
function reviewView(r: Row, value: boolean) {
  return {
    id: r.id,
    stocktake_id: r.stocktake_id,
    stocktake_version: r.stocktake_version,
    scope_hash: r.scope_hash,
    ready: true,
    summary: summaryView(r.summary, value),
    created_at: r.created_at,
  };
}
function postingView(r: Row, value: boolean) {
  return {
    id: r.id,
    stocktake_id: r.stocktake_id,
    review_id: r.review_id,
    wms_operation_id: r.operation_id,
    state: 'posted',
    changed: r.result.changed,
    summary: summaryView(r.result.summary, value),
    created_at: r.created_at,
  };
}
function page<T extends Row>(
  rows: T[],
  q: { cursor?: string; limit: number },
  bind: unknown,
  key = (r: T) => r.id,
): { data: T[]; meta: { cursor: string | null } } {
  let seek: string | null = null;
  if (q.cursor) {
    let v: Row;
    try {
      v = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
    } catch {
      ensure(false, 422, 'Nieprawidłowy kursor spisu');
    }
    ensure(
      v!.bind === wmsLotsHash(bind) && typeof v!.key === 'string',
      422,
      'Kursor ma inny zakres',
    );
    seek = v!.key;
  }
  const ordered = [...rows]
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .filter((r) => seek === null || key(r) > seek!);
  const data = ordered.slice(0, q.limit),
    last = data.at(-1);
  return {
    data,
    meta: {
      cursor:
        ordered.length > data.length
          ? Buffer.from(JSON.stringify({ bind: wmsLotsHash(bind), key: key(last!) })).toString(
              'base64url',
            )
          : null,
    },
  };
}
async function auditLocal(c: PoolClient, a: Actor, kind: string, id: string, detail: unknown = {}) {
  await audit(c, a, `wms.stocktake.${kind}`, id, detail);
}
async function history(
  c: PoolClient,
  table: 'wms_stocktakes' | 'wms_stocktake_measurements' | 'wms_stocktake_reviews',
  q: SPage,
  bind: unknown,
  parent?: string,
  warehouse?: string,
) {
  let seek: Row | undefined;
  if (q.cursor) {
    try {
      seek = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
    } catch {
      ensure(false, 422, 'Nieprawidłowy kursor');
    }
    ensure(
      seek?.bind === wmsLotsHash(bind) &&
        typeof seek.stamp === 'string' &&
        typeof seek.id === 'string',
      422,
      'Kursor ma inny zakres',
    );
  }
  const cols =
    table === 'wms_stocktakes'
      ? `t.id,t.warehouse_id,t.name,t.state,t.version,t.scope_hash,t.blind,t.policy_version,t.currency,t.created_at,t.last_review_id,t.posting_id,
 (SELECT count(*)::int FROM wms_stocktake_lines l WHERE l.stocktake_id=t.id) line_count,
 (SELECT count(*)::int FROM wms_stocktake_lines l WHERE l.stocktake_id=t.id AND l.counted IS NOT NULL) counted_count`
      : table === 'wms_stocktake_measurements'
        ? `t.id,t.stocktake_id,t.kind,t.created_at,t.result-'lines' AS result`
        : `t.id,t.stocktake_id,t.stocktake_version,t.scope_hash,t.summary,t.created_at`;
  const rs = (
    await c.query(
      `SELECT ${cols},t.created_at::text cursor_stamp FROM ${table} t WHERE
 ${parent ? 't.stocktake_id=$1' : '($1::uuid IS NULL OR t.warehouse_id=$1)'}
 AND ($2::timestamptz IS NULL OR (t.created_at,t.id)<($2::timestamptz,$3::uuid)) ORDER BY t.created_at DESC,t.id DESC LIMIT $4`,
      [parent ?? warehouse ?? null, seek?.stamp ?? null, seek?.id ?? null, q.limit + 1],
    )
  ).rows;
  const data = rs.slice(0, q.limit),
    last = data.at(-1);
  return {
    data,
    meta: {
      cursor:
        rs.length > q.limit
          ? Buffer.from(
              JSON.stringify({ bind: wmsLotsHash(bind), stamp: last!.cursor_stamp, id: last!.id }),
            ).toString('base64url')
          : null,
    },
  };
}
async function old(
  c: PoolClient,
  table: string,
  a: Actor,
  kind: string,
  id: string | null,
  b: { client_key: string },
) {
  const r = (await c.query(`SELECT * FROM ${table} WHERE client_key=$1`, [b.client_key])).rows[0];
  if (r)
    ensure(
      r.actor_id === a.userId && r.request_hash === requestHash(a, kind, id, b),
      409,
      'Klucz spisu dotyczy innej operacji',
    );
  return r as Row | undefined;
}
async function allKeys(c: PoolClient, key: string, allowed: string) {
  const r = (
    await c.query(
      `SELECT kind FROM (
 SELECT client_key,'create' kind FROM wms_stocktakes UNION ALL SELECT client_key,kind FROM wms_stocktake_measurements
 UNION ALL SELECT client_key,'review' FROM wms_stocktake_reviews UNION ALL SELECT client_key,'post' FROM wms_stocktake_postings
 UNION ALL SELECT o.client_key,'wms' FROM wms_operations o WHERE NOT EXISTS(SELECT 1 FROM wms_stocktake_postings p WHERE p.operation_id=o.id)) x WHERE client_key=$1`,
      [key],
    )
  ).rows;
  ensure(
    r.every((r) => r.kind === allowed),
    409,
    'Klucz jest już użyty w innym rodzaju operacji',
  );
}
export async function wmsStocktakeMetadata(a: Actor) {
  return stocktakeTx(
    a,
    async (c) => {
      await available(c);
      const policy = await wmsLotsPolicyInTx(c);
      const warehouses = (await c.query('SELECT id,name,code FROM warehouses ORDER BY name,id'))
        .rows;
      const role = await wmsLotsAssertActorInTx(c, a);
      return {
        policy,
        warehouses,
        limits: L,
        current_role: role,
        can_read_value: visibleValue(a, role),
      };
    },
    { wmsAdmission: 'read' },
  );
}
export type WmsStocktakeInternal = {
  stockFileImportId?: string;
  headId?: string;
  lineIds?: string[];
  exactScope?: boolean;
  /** Trusted coordinator only. A private current-TX admission is checked below. */
  adjustment?: { admissionId: string; beforeFinish: (c: PoolClient) => Promise<void> };
};
async function stockFileGuard(c: PoolClient, internal: WmsStocktakeInternal, id: string | null) {
  const present = (
    await c.query(
      "SELECT to_regprocedure('public.stock_file_import_core_admitted(uuid,uuid,text)') IS NOT NULL ok",
    )
  ).rows[0].ok;
  if (!present) {
    const probe = (
      await c.query(
        "SELECT to_regclass('public.stock_file_import_previews') IS NOT NULL artifacts,to_regprocedure('public.stock_file_import_installed()') IS NOT NULL installed_probe",
      )
    ).rows[0];
    const torn =
      (
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='115_stock_file_imports') installed",
        )
      ).rows[0].installed ||
      probe.artifacts ||
      (probe.installed_probe &&
        (await c.query('SELECT stock_file_import_installed() ok')).rows[0].ok);
    ensure(!internal.stockFileImportId && !torn, 503, 'Niekompletny moduł importu stanów');
    return;
  }
  ensure(
    (
      await c.query("SELECT stock_file_import_core_admitted($1,$2,'on') ok", [
        internal.stockFileImportId ?? null,
        id,
      ])
    ).rows[0].ok,
    409,
    'Spis jest związany z importem pliku',
  );
}
export async function wmsStocktakeFileBasesInTx(
  c: PoolClient,
  warehouse_id: string,
  ls: Row[],
  write = false,
) {
  let result = await bases(c, { warehouse_id }, ls, write);
  for (const l of ls)
    l.original = {
      layer_ids: result
        .get(l.id)!
        .layers.map((r) => r.layer_id)
        .sort(),
    };
  return bases(c, { warehouse_id }, ls, write);
}
export async function createWmsStocktake(a: Actor, raw: unknown) {
  return stocktakeTx(a, (c) => createWmsStocktakeInTx(c, a, raw));
}
export async function createWmsStocktakeInTx(
  c: PoolClient,
  a: Actor,
  raw: unknown,
  internal: WmsStocktakeInternal = {},
) {
  assertWmsSerialAdmissionInTx(c, a);
  const input = parsed(S.wmsStocktakeCreateInput, raw);
  const b = {
    ...input,
    ...(input.product_ids ? { product_ids: [...new Set(input.product_ids)].sort() } : {}),
    discoveries: internal.exactScope
      ? [...input.discoveries]
      : [...input.discoveries].sort((x, y) => wmsLotsHash(x).localeCompare(wmsLotsHash(y))),
  };

  await stockFileGuard(c, internal, internal.headId ?? null);
  await early(c, a, true);
  await allKeys(c, b.client_key, 'create');
  const prior = await old(c, 'wms_stocktakes', a, 'create', null, b);
  if (prior) {
    const ls = await lines(c, prior.id);
    const role = await finish(c, a, true, false, internal);
    return { stocktake: headView(prior, ls), reused: true, current_role: role };
  }
  enlistWmsActorInTx(c, a, { adminOnly: true });
  await quota(c, 'heads');
  ensure(
    (
      await c.query(
        "SELECT count(*)::int n FROM wms_stocktakes WHERE state IN ('counting','review')",
      )
    ).rows[0].n < L.open,
    429,
    'Limit otwartych spisów',
  );
  const p = await wmsLotsPolicyInTx(c);
  ensure(
    p.enabled && p.version === b.policy_version,
    409,
    'Najpierw aktywuj właściwą politykę WMS',
  );
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1 FOR SHARE', [b.warehouse_id])).rowCount,
    404,
    'Nie znaleziono magazynu',
  );
  ensure(
    !(
      await c.query(
        "SELECT id FROM wms_stocktakes WHERE warehouse_id=$1 AND state IN ('counting','review')",
        [b.warehouse_id],
      )
    ).rowCount,
    409,
    'Magazyn ma już aktywny spis',
  );
  const source = internal.exactScope
    ? []
    : (
        await c.query(
          `SELECT p.product_id,p.location,l.lot_id,o.lot_code,o.expiry_date::text expiry_date,p.quantity FROM wms_layer_positions p
   JOIN wms_cost_layers l ON (l.tenant_id,l.id,l.product_id)=(p.tenant_id,p.layer_id,p.product_id) JOIN wms_lots o ON (o.tenant_id,o.id,o.product_id)=(l.tenant_id,l.lot_id,l.product_id)
   WHERE p.warehouse_id=$1 AND starts_with(p.location,$2) AND ($3::uuid[] IS NULL OR p.product_id=ANY($3)) AND p.quantity>0 LIMIT 10001`,
          [b.warehouse_id, b.location_prefix, b.product_ids ?? null],
        )
      ).rows;
  ensure(source.length <= L.positions, 422, 'Zakres przekracza 10000 pozycji; zawęź spis');
  const groups = new Map<string, Row>();
  for (const r of source)
    groups.set(JSON.stringify([r.product_id, r.location, r.lot_id]), {
      ...r,
      lot: { id: r.lot_id, lot_code: r.lot_code, expiry_date: r.expiry_date },
    });
  const permittedProducts = b.product_ids ? new Set(b.product_ids) : null;
  const lotIds = b.discoveries.flatMap((d) => (d.lot.kind === 'existing' ? [d.lot.lot_id] : []));
  const ownLots = new Map(
    (
      await c.query(
        'SELECT id,product_id,lot_code,expiry_date::text expiry_date FROM wms_lots WHERE id=ANY($1::uuid[])',
        [lotIds],
      )
    ).rows.map((r) => [r.id, r]),
  );
  for (const d of b.discoveries) {
    ensure(
      starts(d.location, b.location_prefix) &&
        (!permittedProducts || permittedProducts.has(d.product_id)),
      422,
      'Znalezisko poza zakresem spisu',
    );
    let lot: Row;
    if (d.lot.kind === 'existing') {
      const row = ownLots.get(d.lot.lot_id);
      ensure(row && row.product_id === d.product_id, 422, 'Partia nie należy do produktu');
      lot = { id: row.id, lot_code: row.lot_code, expiry_date: row.expiry_date };
    } else lot = { id: null, lot_code: d.lot.lot_code, expiry_date: d.lot.expiry_date };
    const key = JSON.stringify([d.product_id, d.location, lot.id ?? lot.lot_code]);
    ensure(!groups.has(key), 422, 'Powtórzona pozycja fizyczna');
    groups.set(key, { product_id: d.product_id, location: d.location, lot_id: lot.id, lot });
  }
  ensure(groups.size > 0 && groups.size <= L.positions, 422, 'Spis wymaga 1–10000 pozycji');
  const products = (
    await c.query('SELECT id,sku,name FROM products WHERE id=ANY($1::uuid[])', [
      [...new Set([...groups.values()].map((r) => r.product_id))],
    ])
  ).rows;
  await assertProductsNotDeletedInTx(c, products.map((p) => p.id));
  const productsById = new Map(products.map((p) => [p.id, p]));
  const ls: Row[] = [...groups.values()].map((g) => {
    const product = productsById.get(g.product_id);
    ensure(product, 422, 'Obcy produkt');
    return {
      id: internal.lineIds?.[groups.size ? [...groups.values()].indexOf(g) : 0] ?? randomUUID(),
      product_id: g.product_id,
      location: g.location,
      lot_id: g.lot_id,
      lot: g.lot,
      sku: product.sku,
      name: product.name,
      original: { layer_ids: [] },
      version: '1',
      counted: null,
    };
  });
  const h: Row = {
    id: internal.headId ?? randomUUID(),
    warehouse_id: b.warehouse_id,
    policy_version: p.version,
    currency: p.currency,
  };
  let bs = await bases(c, h, ls, true);
  ensure(
    [...bs.values()].reduce((n, r) => n + r.layers.length, 0) <= L.positions,
    422,
    'Zakres warstw przekracza 10000',
  );
  for (const l of ls) {
    const base = bs.get(l.id)!;
    l.original = {
      quantity: base.quantity,
      stock: base.stock,
      bin: base.bin,
      layer_ids: base.layers.map((r) => r.layer_id).sort(),
    };
  }
  bs = await bases(c, h, ls, true);
  const scope = wmsLotsHash({
    warehouse: b.warehouse_id,
    policy: p,
    rows: ls
      .map((l) => ({
        id: l.id,
        product_id: l.product_id,
        location: l.location,
        lot: l.lot,
        original: l.original,
      }))
      .sort((x, y) => x.id.localeCompare(y.id)),
  });
  await c.query(
    `INSERT INTO wms_stocktakes(id,tenant_id,warehouse_id,actor_id,client_key,request_hash,request,scope_hash,policy_version,currency,name,blind)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      h.id,
      a.tenantId,
      b.warehouse_id,
      a.userId,
      b.client_key,
      requestHash(a, 'create', null, b),
      JSON.stringify(b),
      scope,
      p.version,
      p.currency,
      b.name,
      b.blind,
    ],
  );
  await c.query(
    `INSERT INTO wms_stocktake_lines(id,tenant_id,stocktake_id,product_id,location,lot_id,lot,sku,name,original)
   SELECT x.id,$1,$2,x.product_id,x.location,x.lot_id,x.lot,x.sku,x.name,x.original FROM jsonb_to_recordset($3::jsonb)x(id uuid,product_id uuid,location text,lot_id uuid,lot jsonb,sku text,name text,original jsonb)`,
    [a.tenantId, h.id, JSON.stringify(ls)],
  );
  const frozen = ls.flatMap((l) =>
    bs.get(l.id)!.layers.map((r) => ({
      line_id: l.id,
      product_id: l.product_id,
      layer_id: r.layer_id,
      original: r,
    })),
  );
  if (frozen.length)
    await c.query(
      `INSERT INTO wms_stocktake_scope_layers(tenant_id,stocktake_id,line_id,product_id,layer_id,original) SELECT $1,$2,line_id,product_id,layer_id,original FROM jsonb_to_recordset($3::jsonb)x(line_id uuid,product_id uuid,layer_id uuid,original jsonb)`,
      [a.tenantId, h.id, JSON.stringify(frozen)],
    );
  await auditLocal(c, a, 'create', h.id, { line_count: ls.length });
  const role = await finish(c, a, true, false, internal);
  return { stocktake: headView(await head(c, h.id), ls), reused: false, current_role: role };
}
const starts = (value: string, prefix: string) => value.startsWith(prefix);
export async function countWmsStocktake(a: Actor, id: string, raw: unknown) {
  return stocktakeTx(a, (c) => countWmsStocktakeInTx(c, a, id, raw));
}
export async function countWmsStocktakeInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  raw: unknown,
  internal: WmsStocktakeInternal = {},
) {
  assertWmsSerialAdmissionInTx(c, a);
  const parsedInput = parsed(S.wmsStocktakeCountInput, raw),
    b = { ...parsedInput, lines: [...parsedInput.lines].sort((x, y) => x.id.localeCompare(y.id)) };

  await stockFileGuard(c, internal, id);
  await early(c, a);
  const h = await head(c, id, true);
  await allKeys(c, b.client_key, 'count');
  const previous = await old(c, 'wms_stocktake_measurements', a, 'count', id, b);
  if (previous) {
    const role = await finish(c, a, false, false, internal);
    return { measurement: publicMeasurement(previous), reused: true, current_role: role };
  }
  enlistWmsActorInTx(c, a);
  ensure(h.state === 'counting', 409, 'Spis nie jest w fazie liczenia');
  currentPolicy(await wmsLotsPolicyInTx(c), h);
  const countById = new Map(b.lines.map((r) => [r.id, r]));
  const ls = (await lines(c, id)).filter((l) => countById.has(l.id));
  ensure(ls.length === b.lines.length, 404, 'Pozycja nie należy do spisu');
  const bs = await bases(c, h, ls, true),
    mid = randomUUID(),
    v = newVersion(h);
  const frozen = ls.map((l) => {
    const input = countById.get(l.id)!,
      base = bs.get(l.id)!;
    ensure(!base.scope_changed, 409, 'scope_changed: utwórz nowy spis');
    ensure(
      l.version === input.version && token(a, l, base) === input.basis_token,
      409,
      'Pozycja lub stan zmieniły się; odczytaj i przelicz',
    );
    ensure(BigInt(l.version) < max, 422, 'Wyczerpano wersje pomiaru');
    return {
      line_id: l.id,
      counted: input.quantity,
      basis_hash: wmsLotsHash(base),
      version: (BigInt(l.version) + 1n).toString(),
    };
  });
  const result = { id: mid, stocktake_id: id, version: v, updated: ls.length, lines: frozen };
  await c.query(
    `INSERT INTO wms_stocktake_measurements(id,tenant_id,stocktake_id,actor_id,client_key,request_hash,kind,request,result) VALUES($1,$2,$3,$4,$5,$6,'count',$7,$8)`,
    [
      mid,
      a.tenantId,
      id,
      a.userId,
      b.client_key,
      requestHash(a, 'count', id, b),
      JSON.stringify(b),
      JSON.stringify(result),
    ],
  );
  const ml = ls.flatMap((l) =>
    bs.get(l.id)!.layers.map((r) => ({
      line_id: l.id,
      product_id: l.product_id,
      layer_id: r.layer_id,
      basis: r,
    })),
  );
  if (ml.length)
    await c.query(
      `INSERT INTO wms_stocktake_measurement_layers(tenant_id,measurement_id,stocktake_id,line_id,product_id,layer_id,basis) SELECT $1,$2,$3,line_id,product_id,layer_id,basis FROM jsonb_to_recordset($4::jsonb)x(line_id uuid,product_id uuid,layer_id uuid,basis jsonb)`,
      [a.tenantId, mid, id, JSON.stringify(ml)],
    );
  await c.query(
    `UPDATE wms_stocktake_lines l SET counted=x.counted,version=x.version,latest_measurement_id=$2 FROM jsonb_to_recordset($3::jsonb)x(line_id uuid,counted integer,version bigint) WHERE l.stocktake_id=$1 AND l.id=x.line_id`,
    [id, mid, JSON.stringify(frozen)],
  );
  await c.query('UPDATE wms_stocktakes SET version=$2 WHERE id=$1', [id, v]);
  await auditLocal(c, a, 'count', id, { updated: ls.length });
  const role = await finish(c, a, false, false, internal);
  return {
    measurement: { id: mid, stocktake_id: id, version: v, updated: ls.length },
    reused: false,
    current_role: role,
  };
}
function publicMeasurement(m: Row) {
  return {
    id: m.id,
    stocktake_id: m.stocktake_id,
    version: m.result.version,
    updated: m.result.updated ?? 0,
  };
}
export function planWmsStocktakeLine(
  l: Row,
  b: Basis,
  surplus?: { unit_cost_minor: string; currency: string },
): S.WmsStocktakeApplyRow {
  ensure(l.counted !== null && !b.scope_changed, 409, 'Brak aktualnego pomiaru');
  ensure(
    l.counted >= b.reserved,
    409,
    'count_below_reserved: ' + l.id + ' — wynik poniżej rezerwacji partii',
  );
  const delta = l.counted - b.quantity;
  let fragments: S.WmsStocktakeFragment[] = [];
  if (delta < 0) {
    const picks = selectFifoLayers(
      b.layers.map((r) => ({
        layer_id: r.layer_id,
        location: l.location,
        fifo_sequence: r.fifo_sequence,
        available: r.quantity - r.reserved,
        unit_cost_minor: r.unit_cost_minor,
        currency: r.currency,
      })),
      -delta,
    );
    fragments = picks.map((r) => ({
      layer_id: r.layer_id,
      quantity: r.quantity,
      delta: -r.quantity,
      unit_cost_minor: r.unit_cost_minor,
      currency: r.currency,
    }));
  }
  if (delta > 0) {
    ensure(surplus, 422, 'Nadwyżka wymaga jawnego kosztu');
    wmsCostValue(delta, surplus.unit_cost_minor);
    fragments = [
      {
        layer_id: null,
        quantity: delta,
        delta,
        unit_cost_minor: surplus.unit_cost_minor,
        currency: surplus.currency,
      },
    ];
  }
  return {
    line_id: l.id,
    product_id: l.product_id,
    location: l.location,
    lot: l.lot,
    before_quantity: b.quantity,
    after_quantity: l.counted,
    fragments,
  };
}
function summarize(rows: S.WmsStocktakeApplyRow[]) {
  let loss = 0n,
    gain = 0n,
    unknown = 0,
    shortage = 0,
    surplus = 0;
  for (const r of rows)
    for (const f of r.fragments) {
      const value = wmsCostValue(f.quantity, f.unit_cost_minor);
      if (f.delta < 0) {
        loss += BigInt(value.known_minor);
        unknown += value.unknown_quantity;
        shortage += f.quantity;
      } else {
        gain += BigInt(value.known_minor);
        surplus += f.quantity;
      }
    }
  ensure(loss <= max && gain <= max, 422, 'Wartość przekracza int64');
  return {
    total: rows.length,
    changed: rows.filter((r) => r.before_quantity !== r.after_quantity).length,
    shortage_quantity: shortage,
    surplus_quantity: surplus,
    known_loss_minor: loss.toString(),
    known_surplus_minor: gain.toString(),
    unknown_loss_quantity: unknown,
  };
}
async function validateFinalValue(c: PoolClient, summary: ReturnType<typeof summarize>) {
  const value = (
    await c.query(
      `SELECT coalesce(sum(p.quantity::numeric*l.unit_cost_minor),0)::text n FROM wms_layer_positions p JOIN wms_cost_layers l ON (l.tenant_id,l.id,l.product_id)=(p.tenant_id,p.layer_id,p.product_id) WHERE l.unit_cost_minor IS NOT NULL`,
    )
  ).rows[0].n;
  const after =
    BigInt(value) - BigInt(summary.known_loss_minor) + BigInt(summary.known_surplus_minor);
  ensure(after >= 0n && after <= max, 422, 'Łączna wycena po rozliczeniu przekracza int64');
}
export async function reviewWmsStocktake(a: Actor, id: string, raw: unknown) {
  return stocktakeTx(a, (c) => reviewWmsStocktakeInTx(c, a, id, raw));
}
export async function reviewWmsStocktakeInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  raw: unknown,
  internal: WmsStocktakeInternal = {},
) {
  assertWmsSerialAdmissionInTx(c, a);
  const input = parsed(S.wmsStocktakeReviewInput, raw),
    b = {
      ...input,
      surplus: [...input.surplus].sort((x, y) => x.line_id.localeCompare(y.line_id)),
    };

  await stockFileGuard(c, internal, id);
  await early(c, a, true);
  const h = await head(c, id, true);
  await allKeys(c, b.client_key, 'review');
  const previous = await old(c, 'wms_stocktake_reviews', a, 'review', id, b);
  if (previous) {
    const role = await finish(c, a, true, true, internal);
    return {
      review: reviewView(previous, visibleValue(a, role)),
      reused: true,
      current_role: role,
    };
  }
  enlistWmsActorInTx(c, a, { adminOnly: true, cost: true });
  await quota(c, 'reviews');
  ensure(h.state === 'counting' && h.version === b.version, 409, 'Spis lub etap zmienił się');
  currentPolicy(await wmsLotsPolicyInTx(c), h);
  const ls = await lines(c, id),
    bs = await bases(c, h, ls, true),
    ms = await measures(c, ls);
  ensure(
    ls.every((l) => l.counted !== null && !needs(l, bs.get(l.id)!, ms)),
    409,
    'Policz wszystkie pozycje i przelicz nieaktualne pomiary',
  );
  const positive = new Set(ls.filter((l) => l.counted > bs.get(l.id)!.quantity).map((l) => l.id));
  ensure(
    b.surplus.length === positive.size &&
      b.surplus.every((r) => positive.has(r.line_id) && r.currency === h.currency),
    422,
    'Koszty muszą odpowiadać dokładnie nadwyżkom w walucie polityki',
  );
  const surplusById = new Map(b.surplus.map((s) => [s.line_id, s]));
  const rows = ls.map((l) => planWmsStocktakeLine(l, bs.get(l.id)!, surplusById.get(l.id))),
    summary = summarize(rows);
  await validateFinalValue(c, summary);
  const totals = new Map<string, number>();
  for (const r of rows)
    totals.set(
      r.product_id,
      (totals.get(r.product_id) ?? 0) + r.after_quantity - r.before_quantity,
    );
  for (const l of ls) {
    const s = bs.get(l.id)!.stock,
      delta = totals.get(l.product_id)!;
    ensure(s.on_hand + delta >= s.reserved, 409, 'Globalny stan narusza rezerwacje');
    ensure(s.on_hand + delta <= 2147483647, 422, 'Globalny stan przekracza int32');
  }
  const binTotals = new Map<string, number>();
  for (const r of rows) {
    const k = JSON.stringify([r.product_id, r.location]);
    binTotals.set(k, (binTotals.get(k) ?? 0) + r.after_quantity - r.before_quantity);
  }
  for (const l of ls) {
    const k = JSON.stringify([l.product_id, l.location]);
    ensure(
      bs.get(l.id)!.bin.quantity + (binTotals.get(k) ?? 0) <= 2147483647,
      422,
      'Stan lokalizacji przekracza int32',
    );
  }
  const rr = rows.map((r) => ({
    ...r,
    before: {
      quantity: r.before_quantity,
      reserved: bs.get(r.line_id)!.reserved,
      basis_hash: wmsLotsHash(bs.get(r.line_id)!),
    },
    after: { quantity: r.after_quantity },
    basis_hash: wmsLotsHash(bs.get(r.line_id)!),
  }));
  bounded(rr, 16 * 1024 * 1024);
  const rid = randomUUID(),
    v = newVersion(h),
    scope = wmsLotsHash({ stocktake: id, scope: h.scope_hash, version: v, rows: rr });
  await c.query(
    `INSERT INTO wms_stocktake_reviews(id,tenant_id,stocktake_id,actor_id,client_key,request_hash,request,stocktake_version,scope_hash,summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      rid,
      a.tenantId,
      id,
      a.userId,
      b.client_key,
      requestHash(a, 'review', id, b),
      JSON.stringify(b),
      v,
      scope,
      JSON.stringify(summary),
    ],
  );
  await c.query(
    `INSERT INTO wms_stocktake_review_rows(tenant_id,review_id,stocktake_id,line_id,product_id,before,after,fragments,basis_hash) SELECT $1,$2,$3,line_id,product_id,before,after,fragments,basis_hash FROM jsonb_to_recordset($4::jsonb)x(line_id uuid,product_id uuid,before jsonb,after jsonb,fragments jsonb,basis_hash text)`,
    [a.tenantId, rid, id, JSON.stringify(rr)],
  );
  await c.query(
    "UPDATE wms_stocktakes SET state='review',version=$2,last_review_id=$3 WHERE id=$1",
    [id, v, rid],
  );
  await auditLocal(c, a, 'review', id, { review_id: rid });
  const role = await finish(c, a, true, true, internal);
  return {
    review: reviewView(
      {
        id: rid,
        stocktake_id: id,
        stocktake_version: v,
        scope_hash: scope,
        summary,
        created_at: new Date().toISOString(),
      },
      visibleValue(a, role),
    ),
    reused: false,
    current_role: role,
  };
}
export async function postWmsStocktake(a: Actor, id: string, raw: unknown) {
  return stocktakeTx(a, (c) => postWmsStocktakeInTx(c, a, id, raw));
}
export async function postWmsStocktakeInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  raw: unknown,
  internal: WmsStocktakeInternal = {},
) {
  assertWmsSerialAdmissionInTx(c, a);
  const b = parsed(S.wmsStocktakePostInput, raw);

  await stockFileGuard(c, internal, id);
  await early(c, a, true);
  const h = await head(c, id, true);
  await allKeys(c, b.client_key, 'post');
  const previous = await old(c, 'wms_stocktake_postings', a, 'post', id, b);
  if (previous) {
    const role = await finish(c, a, true, true, internal);
    return {
      posting: postingView(previous, visibleValue(a, role)),
      reused: true,
      current_role: role,
    };
  }
  enlistWmsActorInTx(c, a, { adminOnly: true, cost: true });
  ensure(
    h.state === 'review' && h.version === b.version && h.last_review_id === b.review_id,
    409,
    'Spis lub przegląd zmienił się',
  );
  currentPolicy(await wmsLotsPolicyInTx(c), h);
  const review = (
    await c.query('SELECT * FROM wms_stocktake_reviews WHERE id=$1 AND stocktake_id=$2', [
      b.review_id,
      id,
    ])
  ).rows[0];
  ensure(
    review && review.scope_hash === b.scope_hash && review.stocktake_version === b.version,
    409,
    'Zgoda ma inny zakres',
  );
  const ls = await lines(c, id),
    bs = await bases(c, h, ls, true),
    ms = await measures(c, ls),
    rs = (
      await c.query('SELECT * FROM wms_stocktake_review_rows WHERE review_id=$1 ORDER BY line_id', [
        review.id,
      ])
    ).rows;
  const rowsById = new Map(rs.map((r) => [r.line_id, r]));
  ensure(
    rs.length === ls.length && ls.every((l) => rowsById.has(l.id)),
    409,
    'Dowód ma inny zakres pozycji',
  );
  const surplusById = new Map<string, Row>(review.request.surplus.map((s: Row) => [s.line_id, s]));
  const rows: S.WmsStocktakeApplyRow[] = ls.map((l) => {
    const r = rowsById.get(l.id)!,
      base = bs.get(l.id)!;
    ensure(
      !needs(l, base, ms) && wmsLotsHash(base) === r.basis_hash && l.counted === r.after.quantity,
      409,
      'Ruch po przeglądzie; ponownie policz',
    );
    const surplus = surplusById.get(l.id) as
      { unit_cost_minor: string; currency: string } | undefined;
    const plan = planWmsStocktakeLine(l, base, surplus);
    ensure(
      wmsLotsHash(plan.fragments) === wmsLotsHash(r.fragments) &&
        r.before.quantity === plan.before_quantity,
      409,
      'Niezgodny plan warstw',
    );
    return plan;
  });
  const proofRows = rows.map((r) => ({
    ...r,
    before: rowsById.get(r.line_id)!.before,
    after: rowsById.get(r.line_id)!.after,
    basis_hash: rowsById.get(r.line_id)!.basis_hash,
  }));
  ensure(
    wmsLotsHash({
      stocktake: id,
      scope: h.scope_hash,
      version: review.stocktake_version,
      rows: proofRows,
    }) === review.scope_hash,
    409,
    'Niezgodny immutable scope hash',
  );
  const summary = summarize(rows);
  await validateFinalValue(c, summary);
  ensure(wmsLotsHash(summary) === wmsLotsHash(review.summary), 409, 'Niezgodne podsumowanie');
  const pid = randomUUID(),
    v = newVersion(h);
  const applied = await applyWmsStocktakeInTx(c, a, {
    stocktake_id: id,
    posting_id: pid,
    review_id: review.id,
    client_key: b.client_key,
    policy_version: h.policy_version,
    warehouse_id: h.warehouse_id,
    request: b,
    rows,
  });
  const result = { changed: summary.changed > 0, summary };
  await c.query(
    `INSERT INTO wms_stocktake_postings(id,tenant_id,stocktake_id,review_id,actor_id,client_key,request_hash,request,operation_id,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      pid,
      a.tenantId,
      id,
      review.id,
      a.userId,
      b.client_key,
      requestHash(a, 'post', id, b),
      JSON.stringify(b),
      applied.operation_id,
      JSON.stringify(result),
    ],
  );
  await c.query("UPDATE wms_stocktakes SET state='posted',version=$2,posting_id=$3 WHERE id=$1", [
    id,
    v,
    pid,
  ]);
  await auditLocal(c, a, 'post', id, { posting_id: pid, operation_id: applied.operation_id });
  if (internal.adjustment) {
    // Never expose this callback in the public post schema. The same owner
    // connection certifies the actor/key, source, and current transaction.
    await c.query('RESET ROLE');
    try {
      const proof = (await c.query('SELECT public.stocktake_adjustment_core_scope($1,$2,$3,$4) ok',
        [internal.adjustment.admissionId, id, a.userId, a.apiKeyId ?? null])).rows[0];
      ensure(proof?.ok === true, 409, 'Brak aktualnej zgody dokumentów spisu');
    } finally { await c.query('SET LOCAL ROLE dyna_app'); }
    await internal.adjustment.beforeFinish(c);
  }
  const role = await finish(c, a, true, true, internal);
  const posting = (await c.query('SELECT * FROM wms_stocktake_postings WHERE id=$1', [pid]))
    .rows[0];
  return {
    posting: postingView(posting, visibleValue(a, role)),
    reused: false,
    current_role: role,
  };
}
export async function commandWmsStocktake(
  a: Actor,
  id: string,
  kind: 'reopen' | 'cancel',
  raw: unknown,
) {
  const b = parsed(S.wmsStocktakeCommandInput, raw);
  return stocktakeTx(a, async (c) => {
    await early(c, a, true);
    const h = await head(c, id, true);
    await allKeys(c, b.client_key, kind);
    const previous = await old(c, 'wms_stocktake_measurements', a, kind, id, b);
    if (previous) {
      const role = await wmsLotsAssertActorInTx(c, a, true, true);
      return { stocktake: previous.result.stocktake, reused: true, current_role: role };
    }
    enlistWmsActorInTx(c, a, { adminOnly: true });
    ensure(
      h.version === b.version &&
        (kind === 'reopen' ? h.state === 'review' : ['counting', 'review'].includes(h.state)),
      409,
      'Spis zmienił się lub jest zamknięty',
    );
    const v = newVersion(h),
      state = kind === 'cancel' ? 'cancelled' : 'counting';
    await c.query('UPDATE wms_stocktakes SET state=$2,version=$3 WHERE id=$1', [id, state, v]);
    const ls = await lines(c, id),
      result = { stocktake: headView({ ...h, state, version: v }, ls), version: v };
    await c.query(
      `INSERT INTO wms_stocktake_measurements(id,tenant_id,stocktake_id,actor_id,client_key,request_hash,kind,request,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        a.tenantId,
        id,
        a.userId,
        b.client_key,
        requestHash(a, kind, id, b),
        kind,
        JSON.stringify(b),
        JSON.stringify(result),
      ],
    );
    await auditLocal(c, a, kind, id);
    const role = await finish(c, a, true);
    return { ...result, reused: false, current_role: role };
  });
}
export async function wmsStocktakeDetail(a: Actor, id: string) {
  return stocktakeTx(
    a,
    async (c) => {
      const h = await head(c, id),
        ls = await lines(c, id),
        bs = await bases(c, h, ls),
        ms = await measures(c, ls);
      const role = await wmsLotsAssertActorInTx(c, a);
      return { stocktake: headView(h, ls, bs, ms), current_role: role };
    },
    { wmsAdmission: 'read' },
  );
}
export async function wmsStocktakeLines(a: Actor, id: string, q: SPage) {
  return stocktakeTx(
    a,
    async (c) => {
      const h = await head(c, id);
      const initialRole = (await c.query('SELECT wms_current_role($1,false) role', [a.userId]))
        .rows[0].role;
      ensure(
        ['admin', 'operator', 'viewer'].includes(initialRole),
        403,
        'Brak bieżącego prawa odczytu spisu',
      );
      const out = page(await lines(c, id), q, { id, role: initialRole, blind: h.blind });
      const bs = await bases(c, h, out.data),
        ms = await measures(c, out.data),
        role = await wmsLotsAssertActorInTx(c, a);
      ensure(role === initialRole, 409, 'Uprawnienia zmieniły się podczas odczytu; odśwież stronę');
      return {
        ...out,
        data: out.data.map((l) => lineView(a, role, h, l, bs.get(l.id)!, ms)),
        current_role: role,
      };
    },
    { wmsAdmission: 'read' },
  );
}

type SPage = { cursor?: string; limit: number };
export async function wmsStocktakeList(a: Actor, q: SPage & { warehouse_id?: string }) {
  return stocktakeTx(
    a,
    async (c) => {
      await available(c);
      const role = await wmsLotsAssertActorInTx(c, a);
      const out = await history(
        c,
        'wms_stocktakes',
        q,
        { kind: 'list', warehouse: q.warehouse_id ?? null, role },
        undefined,
        q.warehouse_id,
      );
      return {
        ...out,
        data: out.data.map((r) => ({
          ...headView(r),
          line_count: r.line_count,
          counted_count: r.counted_count,
        })),
        current_role: role,
      };
    },
    { wmsAdmission: 'read' },
  );
}

export async function wmsStocktakeMeasurements(a: Actor, id: string, q: SPage) {
  return stocktakeTx(
    a,
    async (c) => {
      await head(c, id);
      const out = await history(
        c,
        'wms_stocktake_measurements',
        q,
        { id, kind: 'measurements' },
        id,
      );
      const role = await wmsLotsAssertActorInTx(c, a);
      return {
        ...out,
        data: out.data.map((r) => ({
          id: r.id,
          stocktake_id: r.stocktake_id,
          kind: r.kind,
          created_at: r.created_at,
          result: publicMeasurement(r),
        })),
        current_role: role,
      };
    },
    { wmsAdmission: 'read' },
  );
}
export async function wmsStocktakeReviews(a: Actor, id: string, q: SPage) {
  return stocktakeTx(
    a,
    async (c) => {
      await head(c, id);
      const out = await history(c, 'wms_stocktake_reviews', q, { id, kind: 'reviews' }, id);
      const role = await wmsLotsAssertActorInTx(c, a);
      return {
        ...out,
        data: out.data.map((r) => reviewView(r, visibleValue(a, role))),
        current_role: role,
      };
    },
    { wmsAdmission: 'read' },
  );
}
async function reviewOwn(c: PoolClient, id: string, rid: string) {
  await head(c, id);
  const r = (
    await c.query('SELECT * FROM wms_stocktake_reviews WHERE id=$1 AND stocktake_id=$2', [rid, id])
  ).rows[0];
  ensure(r, 404, 'Nie znaleziono przeglądu');
  return r;
}
export async function wmsStocktakeReviewDetail(a: Actor, id: string, rid: string) {
  return stocktakeTx(
    a,
    async (c) => {
      const r = await reviewOwn(c, id, rid),
        role = await wmsLotsAssertActorInTx(c, a);
      return { review: reviewView(r, visibleValue(a, role)), current_role: role };
    },
    { wmsAdmission: 'read' },
  );
}
export async function wmsStocktakeReviewRows(a: Actor, id: string, rid: string, q: SPage) {
  return stocktakeTx(
    a,
    async (c) => {
      await reviewOwn(c, id, rid);
      const rows = (
        await c.query(
          `SELECT r.*,l.sku,l.name,l.location,l.lot FROM wms_stocktake_review_rows r JOIN wms_stocktake_lines l ON (l.tenant_id,l.stocktake_id,l.id)=(r.tenant_id,r.stocktake_id,r.line_id) WHERE r.review_id=$1 ORDER BY r.line_id`,
          [rid],
        )
      ).rows;
      const role = await wmsLotsAssertActorInTx(c, a);
      const out = page(rows, q, { id, rid, role, value: visibleValue(a, role) }, (r) => r.line_id);
      return {
        ...out,
        data: out.data.map((r) => ({
          line_id: r.line_id,
          product_id: r.product_id,
          sku: r.sku,
          name: r.name,
          location: r.location,
          lot: r.lot,
          counted: r.after.quantity,
          ...(visibleValue(a, role)
            ? { before: r.before, after: r.after, fragments: r.fragments, errors: [] }
            : {}),
        })),
        current_role: role,
      };
    },
    { wmsAdmission: 'read' },
  );
}
export async function wmsStocktakePosting(a: Actor, id: string) {
  return stocktakeTx(
    a,
    async (c) => {
      await head(c, id);
      const r = (await c.query('SELECT * FROM wms_stocktake_postings WHERE stocktake_id=$1', [id]))
        .rows[0];
      ensure(r, 404, 'Spis nie ma rozliczenia');
      const role = await wmsLotsAssertActorInTx(c, a);
      return { posting: postingView(r, visibleValue(a, role)), current_role: role };
    },
    { wmsAdmission: 'read' },
  );
}

/** Scan callers acquire catalogue admission BEFORE any header; no membership pin here. */
export async function wmsStocktakeScanBasisInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  lineIds: string[],
  write = false,
) {
  const h = await head(c, id, write);
  const ls = (
    await c.query(
      `SELECT * FROM wms_stocktake_lines WHERE stocktake_id=$1 AND id=ANY($2::uuid[]) ORDER BY product_id,location COLLATE "C",id ${write ? 'FOR UPDATE' : 'FOR SHARE'}`,
      [id, lineIds],
    )
  ).rows;
  ensure(ls.length === lineIds.length, 404, 'Pozycja nie należy do spisu');
  const bs = await bases(c, h, ls, write),
    ms = await measures(c, ls);
  return {
    header: h,
    lines: ls,
    entries: new Map(
      ls.map((l) => [
        l.id,
        {
          basis: bs.get(l.id)!,
          basis_token: token(a, l, bs.get(l.id)!),
          needs_recount: needs(l, bs.get(l.id)!, ms),
        },
      ]),
    ),
  };
}
/** One real count plus its layer evidence in caller TX. Final grants follow the scan receipt. */
export async function applyWmsStocktakeScanCountInTx(
  c: PoolClient,
  a: Actor,
  prepared: Awaited<ReturnType<typeof wmsStocktakeScanBasisInTx>>,
  input: { client_key: string; quantity: number; note: string },
) {
  const h = prepared.header,
    l = prepared.lines[0],
    base = prepared.entries.get(l.id)!.basis;
  ensure(
    prepared.lines.length === 1 && h.state === 'counting',
    409,
    'Spis nie jest w fazie liczenia',
  );
  currentPolicy(await wmsLotsPolicyInTx(c), h);
  ensure(!base.scope_changed, 409, 'scope_changed: utwórz nowy spis');
  ensure(BigInt(l.version) < max, 422, 'Wyczerpano wersje pomiaru');
  await allKeys(c, input.client_key, 'count');
  ensure(
    !(
      await c.query(
        'SELECT 1 FROM wms_stocktake_measurements WHERE client_key=$1 UNION ALL SELECT 1 FROM wms_operations WHERE client_key=$1',
        [input.client_key],
      )
    ).rowCount,
    409,
    'Klucz wewnętrznego pomiaru jest zajęty',
  );
  const mid = randomUUID(),
    v = newVersion(h),
    lv = (BigInt(l.version) + 1n).toString();
  const b = {
    client_key: input.client_key,
    note: input.note,
    lines: [
      {
        id: l.id,
        version: l.version,
        basis_token: prepared.entries.get(l.id)!.basis_token,
        quantity: input.quantity,
      },
    ],
  };
  const result = {
    id: mid,
    stocktake_id: h.id,
    version: v,
    updated: 1,
    lines: [
      {
        line_id: l.id,
        counted: input.quantity,
        previous_count: l.counted,
        before_version: l.version,
        basis_hash: wmsLotsHash(base),
        version: lv,
      },
    ],
  };
  await c.query(
    `INSERT INTO wms_stocktake_measurements(id,tenant_id,stocktake_id,actor_id,client_key,request_hash,kind,request,result) VALUES($1,$2,$3,$4,$5,$6,'count',$7,$8)`,
    [
      mid,
      a.tenantId,
      h.id,
      a.userId,
      input.client_key,
      requestHash(a, 'count', h.id, b),
      JSON.stringify(b),
      JSON.stringify(result),
    ],
  );
  if (base.layers.length)
    await c.query(
      `INSERT INTO wms_stocktake_measurement_layers(tenant_id,measurement_id,stocktake_id,line_id,product_id,layer_id,basis) SELECT $1,$2,$3,$4,$5,x.layer_id,x.basis FROM jsonb_to_recordset($6::jsonb)x(layer_id uuid,basis jsonb)`,
      [
        a.tenantId,
        mid,
        h.id,
        l.id,
        l.product_id,
        JSON.stringify(base.layers.map((r) => ({ layer_id: r.layer_id, basis: r }))),
      ],
    );
  await c.query(
    'UPDATE wms_stocktake_lines SET counted=$2,version=$3,latest_measurement_id=$4 WHERE id=$1',
    [l.id, input.quantity, lv, mid],
  );
  await c.query('UPDATE wms_stocktakes SET version=$2 WHERE id=$1', [h.id, v]);
  await auditLocal(c, a, 'count', h.id, { updated: 1 });
  return { measurement_id: mid, stocktake_version: v, after_line_version: lv };
}
