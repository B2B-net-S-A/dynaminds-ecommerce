import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx, pool } from './db';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import { locationOperation } from './stock-locations';
import {
  prepareCatalogStockCountInTx, finishCatalogStockCountInTx, abandonCatalogStockCountInTx,
  retainCatalogStockCountParentInTx, assertCatalogStockCountChildInTx,
  type CatalogStockCountParent,
} from './catalog-stock-count-effects';
import { catalogStockCountDocumentsInTx } from './catalog-stock-count-read';
import {
  inventoryBulkEditPreviewInput,
  inventoryBulkEditExecuteInput,
  inventoryBulkEditSelectionQuery,
  type InventoryBulkEditInput,
  type InventoryBulkEditExecute,
} from './inventory-bulk-edit-schema';

export type InventoryBulkEditActor = Actor & { apiKeyId?: string };
const stable = (v: any): any =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, stable(x)]),
        )
      : v;
export const inventoryBulkEditHash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(v)))
    .digest('hex');
export function inventoryBulkEditOperationKey(previewId: string, clientKey: string, index: number) {
  const h = inventoryBulkEditHash({ preview_id: previewId, client_key: clientKey, index });
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const access = (r: string) => ({ current_role: r, can_read: true, can_write: r === 'admin' });
async function role(c: PoolClient, a: InventoryBulkEditActor, write = false) {
  const r = (await c.query('SELECT catalog_bulk_edit_current_role($1) role', [a.userId])).rows[0]
    ?.role;
  ensure(['admin', 'operator', 'viewer'].includes(r), 403, 'Utracono dostęp do magazynu');
  ensure(!write || r === 'admin', 403, 'Wymagany aktualny administrator');
  if (write && a.apiKeyId) {
    const key = (
      await c.query('SELECT inventory_bulk_edit_key_grant($1,$2) grant_result', [
        a.userId,
        a.apiKeyId,
      ])
    ).rows[0]?.grant_result;
    ensure(key !== 'invalid', 401, 'Klucz API został cofnięty lub wygasł');
    ensure(
      key === 'ok',
      403,
      'Brak aktualnych scopes products:read, inventory:read, inventory:write',
    );
  }
  return r as Actor['role'];
}
async function admission(c: PoolClient, a: Actor) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    `catalog:${a.tenantId}`,
  ]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `inventory.bulk:${a.tenantId}`,
  ]);
}
async function warehouse(c: PoolClient, id: string) {
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1 FOR SHARE', [id])).rowCount,
    404,
    'Nie znaleziono własnego magazynu',
  );
}
async function quota(c: PoolClient, kind: 'previews' | 'executions') {
  ensure(
    (await c.query(`SELECT count(*)::int n FROM inventory_bulk_edit_${kind}`)).rows[0].n < 2000,
    409,
    `Limit 2000 ${kind}; historia nie jest usuwana automatycznie`,
  );
}
function requestHash(v: unknown, source: string) {
  ensure(
    Buffer.byteLength(JSON.stringify(v), 'utf8') <= 786432,
    413,
    'Żądanie przekracza 786432 bajty',
  );
  return inventoryBulkEditHash({ source, request: v });
}
type Bin = { location: string; quantity: number; reserved: number; available: number };
type State = { product: any; stock: any | null; bins: Bin[] };
async function states(
  c: PoolClient,
  w: string,
  ids: string[],
  boundInitialScope = true,
): Promise<Map<string, State>> {
  // SHARE freezes catalog versions without blocking the KEY SHARE FK of a concurrent missing-stock INSERT.
  // A deleted product (225) is outside every scope: it counts as missing.
  const deletions = await productDeletionsAvailable(c);
  const products = (
    await c.query(`SELECT * FROM products WHERE id=ANY($1::uuid[]) AND ${productNotDeletedSQL(deletions, 'products')} ORDER BY id FOR SHARE`, [ids])
  ).rows;
  ensure(products.length === ids.length, 422, 'Zakres zawiera brakujący lub obcy produkt');
  const stock = (
    await c.query(
      'SELECT * FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR UPDATE',
      [w, ids],
    )
  ).rows;
  // Lock every existing source/destination bin before any ledger operation. Reservation writers lock stock first.
  await c.query(
    'SELECT product_id,location FROM stock_locations WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id,location FOR UPDATE',
    [w, ids],
  );
  const bins = (
    await c.query(
      `SELECT l.product_id,l.location,l.quantity,coalesce(h.held,0)::int reserved,(l.quantity-coalesce(h.held,0))::int available
 FROM stock_locations l LEFT JOIN LATERAL(SELECT sum(a.quantity) held FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id)
 WHERE (a.tenant_id,a.warehouse_id,a.product_id,a.location)=(l.tenant_id,l.warehouse_id,l.product_id,l.location) AND r.state='active')h ON true
 WHERE l.warehouse_id=$1 AND l.product_id=ANY($2::uuid[]) ORDER BY l.product_id,l.location`,
      [w, ids],
    )
  ).rows;
  ensure(
    !boundInitialScope ||
      bins.length + products.filter((p) => !stock.some((s) => s.product_id === p.id)).length <= 500,
    422,
    'Pełny zakres lokalizacji przekracza 500 wierszy; wybierz mniejszy zakres',
  );
  return new Map(
    products.map((p) => [
      p.id,
      {
        product: p,
        stock: stock.find((s) => s.product_id === p.id) ?? null,
        bins: bins
          .filter((b) => b.product_id === p.id)
          .map(({ location, quantity, reserved, available }) => ({
            location,
            quantity,
            reserved,
            available,
          }))
          .sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0)),
      },
    ]),
  );
}
function snapshot(s: State, location: string) {
  const b = s.bins.find((b) => b.location === location);
  return {
    exists: s.stock !== null,
    stock_version: s.stock?.version ?? null,
    warehouse_on_hand: s.stock?.on_hand ?? 0,
    warehouse_reserved: s.stock?.reserved ?? 0,
    location,
    quantity: b?.quantity ?? null,
    reserved: b?.reserved ?? null,
    available: b?.available ?? null,
    bins: s.bins.map((b) => ({ ...b })),
  };
}
function virtual(s: State): State {
  return {
    product: s.product,
    stock: s.stock ? { ...s.stock } : null,
    bins: s.bins.map((b) => ({ ...b })),
  };
}
function ensureDefaultBin(s: State) {
  const location = s.stock?.location ?? 'A-01';
  if (s.stock && !s.bins.some((b) => b.location === location))
    s.bins.push({ location, quantity: 0, reserved: 0, available: 0 });
}
type FrozenRow = {
  index: number;
  product_id: string;
  location: string;
  sku: string;
  input: InventoryBulkEditInput['rows'][number];
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict' | 'missing';
  before: any;
  after: any;
  errors: string[];
};
function plan(
  input: InventoryBulkEditInput,
  original: Map<string, State>,
  allowNewLocations = false,
): FrozenRow[] {
  const future = new Map([...original].map(([id, s]) => [id, virtual(s)]));
  const rows: FrozenRow[] = input.rows.map((r, index) => {
    const s = original.get(r.product_id)!;
    const before = snapshot(s, r.location);
    if (!s.stock && (r.location === 'A-01' || allowNewLocations)) {
      before.quantity = 0;
      before.reserved = 0;
      before.available = 0;
    }
    const row: FrozenRow = {
      index,
      product_id: r.product_id,
      location: r.location,
      sku: s.product.sku,
      input: r,
      status: 'unchanged',
      before,
      after: null,
      errors: [],
    };
    if (!['simple', 'variant'].includes(s.product.kind))
      row.errors.push('Grupa lub zestaw nie ma własnego stanu fizycznego');
    if (s.stock && !s.bins.some((b) => b.location === r.location)) {
      if (allowNewLocations && r.operation !== 'move') {
        before.quantity = 0;
        before.reserved = 0;
        before.available = 0;
        future
          .get(r.product_id)!
          .bins.push({ location: r.location, quantity: 0, reserved: 0, available: 0 });
      } else row.errors.push('Nie istnieje lokalizacja źródłowa');
    }
    if (!s.stock && ((!allowNewLocations && r.location !== 'A-01') || r.operation === 'move'))
      row.errors.push('Brak stock: dozwolony pomiar A-01 lub NOP');
    if (r.operation === 'move' && r.destination === r.location)
      row.errors.push('Lokalizacja docelowa musi być inna');
    if (r.operation === 'count' && r.quantity < (before.reserved ?? 0))
      row.errors.push('Pomiar narusza rezerwacje lokalizacji');
    if (r.product_version !== s.product.version || r.stock_version !== (s.stock?.version ?? null)) {
      row.status = 'conflict';
      row.errors.unshift('Wersja produktu lub stock zmieniła się');
    } else if (row.errors.length) row.status = 'invalid';
    return row;
  });
  // Counts establish the independent funding base for ALL moves; incoming moves never finance outgoing ones.
  for (const row of rows) {
    if (row.status === 'invalid' || row.status === 'conflict' || row.input.operation !== 'count')
      continue;
    const s = future.get(row.product_id)!,
      r = row.input;
    const old = s.bins.find((b) => b.location === r.location)?.quantity ?? 0;
    if (r.quantity === old) continue;
    if (!s.stock) {
      s.stock = { version: '0', on_hand: 0, reserved: 0 };
      if (!s.bins.some((b) => b.location === r.location))
        s.bins.push({
          location: allowNewLocations ? r.location : 'A-01',
          quantity: 0,
          reserved: 0,
          available: 0,
        });
    }
    const b = s.bins.find((b) => b.location === r.location)!;
    b.quantity = r.quantity;
    b.available = b.quantity - b.reserved;
    s.stock.on_hand += r.quantity - old;
    s.stock.version = (BigInt(s.stock.version) + 1n).toString();
    ensureDefaultBin(s);
    row.status = 'changed';
  }
  const outgoing = new Map<string, number>();
  for (const row of rows) {
    if (row.status === 'invalid' || row.status === 'conflict' || row.input.operation !== 'move')
      continue;
    const key = row.product_id + '\0' + row.location;
    outgoing.set(key, (outgoing.get(key) ?? 0) + row.input.quantity);
  }
  for (const row of rows) {
    if (row.status === 'invalid' || row.status === 'conflict' || row.input.operation !== 'move')
      continue;
    const s = future.get(row.product_id)!,
      key = row.product_id + '\0' + row.location,
      b = s.bins.find((b) => b.location === row.location);
    if (!b || (outgoing.get(key) ?? 0) > b.available) {
      row.status = 'invalid';
      row.errors.push(
        'Przesunięcia wymagają wolnych sztuk po pomiarach, bez przychodzących przesunięć',
      );
    }
  }
  for (const s of future.values())
    if (s.stock && (s.stock.on_hand > 2147483647 || s.stock.on_hand < 0))
      for (const r of rows.filter((r) => r.product_id === s.product.id)) {
        r.status = 'invalid';
        r.errors.push('Końcowy stan przekracza limit integer');
      }
  for (const row of rows) {
    if (row.status === 'invalid' || row.status === 'conflict' || row.input.operation !== 'move')
      continue;
    const s = future.get(row.product_id)!,
      r = row.input,
      b = s.bins.find((b) => b.location === r.location)!;
    b.quantity -= r.quantity;
    b.available = b.quantity - b.reserved;
    let dest = s.bins.find((b) => b.location === r.destination);
    if (!dest) {
      dest = { location: r.destination, quantity: 0, reserved: 0, available: 0 };
      s.bins.push(dest);
    }
    dest.quantity += r.quantity;
    dest.available = dest.quantity - dest.reserved;
    s.stock.version = (BigInt(s.stock.version) + 1n).toString();
    ensureDefaultBin(s);
    row.status = 'changed';
  }
  for (const s of future.values())
    s.bins.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
  for (const s of future.values())
    if (s.stock && BigInt(s.stock.version) > 9223372036854775807n)
      for (const row of rows.filter((r) => r.product_id === s.product.id)) {
        row.status = 'invalid';
        row.errors.push('Wersja stock wyczerpała zakres bigint');
      }
  for (const row of rows) {
    row.after =
      row.status === 'changed' || row.status === 'unchanged'
        ? snapshot(future.get(row.product_id)!, row.location)
        : null;
    if (row.after && !future.get(row.product_id)!.stock && row.location === 'A-01') {
      row.after.quantity = 0;
      row.after.reserved = 0;
      row.after.available = 0;
    }
  }
  return rows;
}
const summary = (rows: FrozenRow[]) => ({
  total: rows.length,
  changed: rows.filter((r) => r.status === 'changed').length,
  unchanged: rows.filter((r) => r.status === 'unchanged').length,
  invalid: rows.filter((r) => r.status === 'invalid' || r.status === 'missing').length,
  conflicts: rows.filter((r) => r.status === 'conflict').length,
  ready: rows.every((r) => r.status === 'changed' || r.status === 'unchanged'),
});
const previewHead = (p: any) => ({
  id: p.id,
  actor_id: p.actor_id,
  warehouse_id: p.warehouse_id,
  note: p.note,
  scope_hash: p.scope_hash,
  total: p.total,
  changed: p.changed,
  unchanged: p.unchanged,
  invalid: p.invalid,
  conflicts: p.conflicts,
  ready: p.ready,
  created_at: p.created_at,
});
const executionHead = (e: any) => ({
  id: e.id,
  preview_id: e.preview_id,
  actor_id: e.actor_id,
  scope_hash: e.scope_hash,
  state: e.state,
  total: e.total,
  changed: e.changed,
  unchanged: e.unchanged,
  created_at: e.created_at,
});
async function preview(c: PoolClient, id: string) {
  const p = (await c.query('SELECT * FROM inventory_bulk_edit_previews WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu');
  return p;
}
async function execution(c: PoolClient, id: string) {
  const e = (await c.query('SELECT * FROM inventory_bulk_edit_executions WHERE id=$1', [id]))
    .rows[0];
  ensure(e, 404, 'Nie znaleziono wykonania');
  return e;
}
async function frozen(c: PoolClient, id: string): Promise<FrozenRow[]> {
  return (
    await c.query(
      'SELECT index,product_id,location,sku,input,status,before,after,errors FROM inventory_bulk_edit_rows WHERE preview_id=$1 ORDER BY index',
      [id],
    )
  ).rows as FrozenRow[];
}

export async function inventoryBulkEditMetadata(a: Actor) {
  return tenantTx(a.tenantId, async (c) => ({
    ...access(await role(c, a)),
    warehouses: (await c.query('SELECT id,name FROM warehouses ORDER BY name,id')).rows,
    limits: { products: 500, selection_products: 50, rows: 500, page: 50, body_bytes: 786432 },
  }));
}
export async function inventoryBulkEditSelection(
  a: Actor,
  query: z.infer<typeof inventoryBulkEditSelectionQuery>,
) {
  const q = inventoryBulkEditSelectionQuery.parse({
      ...query,
      ids: Array.isArray(query.ids) ? query.ids.join(',') : query.ids,
    }),
    ids = [...q.ids].sort(),
    scope = inventoryBulkEditHash({ warehouse_id: q.warehouse_id, ids });
  let offset = 0;
  if (q.cursor) {
    try {
      const v = z
        .tuple([z.string().length(64), z.number().int().min(0).max(499)])
        .parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
      ensure(v[0] === scope, 422, 'Kursor należy do innego zakresu');
      offset = v[1];
    } catch {
      ensure(false, 422, 'Nieprawidłowy kursor zakresu');
    }
  }
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    await warehouse(c, q.warehouse_id);
    const data: any[] = [];
    const scopeStates = await states(c, q.warehouse_id, ids);
    for (const [id, s] of scopeStates) {
      const physical = ['simple', 'variant'].includes(s.product.kind),
        bins = s.stock ? s.bins : [{ location: 'A-01', quantity: 0, reserved: 0, available: 0 }];
      for (const b of bins)
        data.push({
          product_id: id,
          product_version: s.product.version,
          sku: s.product.sku,
          name: s.product.name,
          kind: s.product.kind,
          ...b,
          stock_version: s.stock?.version ?? null,
          warehouse_on_hand: s.stock?.on_hand ?? 0,
          warehouse_reserved: s.stock?.reserved ?? 0,
          exists: !!s.stock,
          editable: physical,
          errors: physical ? [] : ['Grupa lub zestaw nie ma własnego stanu fizycznego'],
        });
    }
    ensure(data.length <= 500, 422, 'Pełny zakres przekracza 500 wierszy');
    ensure(offset === 0 || offset < data.length, 422, 'Kursor poza zakresem');
    return {
      ...access(await role(c, a)),
      data: data.slice(offset, offset + 50),
      meta: {
        total: data.length,
        cursor:
          offset + 50 < data.length
            ? Buffer.from(JSON.stringify([scope, offset + 50])).toString('base64url')
            : null,
      },
    };
  });
}

export type InventoryBulkEditInternal = { stockFileImportId?: string; previewId?: string;
  catalogStockCountParent?: CatalogStockCountParent };
async function fileGuard(c: PoolClient, parent: string | undefined, child: string | null) {
  const exists = (
    await c.query(
      "SELECT to_regprocedure('public.stock_file_import_core_admitted(uuid,uuid,text)') IS NOT NULL ok",
    )
  ).rows[0].ok;
  if (!exists) {
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
    ensure(!parent && !torn, 503, 'Niekompletny moduł importu stanów');
    return;
  }
  ensure(
    (
      await c.query("SELECT stock_file_import_core_admitted($1,$2,'off') ok", [
        parent ?? null,
        child,
      ])
    ).rows[0].ok,
    409,
    'Zakres stanów jest związany z importem pliku',
  );
}
async function fileRole(
  c: PoolClient,
  a: InventoryBulkEditActor,
  internal: InventoryBulkEditInternal,
) {
  if (!internal.stockFileImportId) return role(c, a, true);
  const r = (
    await c.query('SELECT stock_file_import_access($1,$2,true,false) result', [
      a.userId,
      a.apiKeyId ?? null,
    ])
  ).rows[0].result;
  ensure(r.key_valid !== false, 401, 'Klucz API został cofnięty lub wygasł');
  ensure(r.allowed === true, 403, 'Brak aktualnej zgody importu stanów');
  return r.role as Actor['role'];
}

export async function createInventoryBulkEditPreview(
  a: InventoryBulkEditActor,
  input: InventoryBulkEditInput,
  source: 'manual' | 'api' = 'manual',
) {
  return tenantTx(a.tenantId, (c) => createInventoryBulkEditPreviewInTx(c, a, input, source));
}

export async function createInventoryBulkEditPreviewInTx(
  c: PoolClient,
  a: InventoryBulkEditActor,
  input: InventoryBulkEditInput,
  source: 'manual' | 'api' = 'manual',
  internal: InventoryBulkEditInternal = {},
) {
  const b = inventoryBulkEditPreviewInput.parse(input),
    hash = requestHash(b, source);

  await fileGuard(c, internal.stockFileImportId, internal.previewId ?? null);
  await admission(c, a);
  const old = (
    await c.query('SELECT * FROM inventory_bulk_edit_previews WHERE client_key=$1', [b.client_key])
  ).rows[0];
  if (old) {
    ensure(
      old.actor_id === a.userId && old.request_hash === hash,
      409,
      'Klucz podglądu ma inny aktor lub zakres',
    );
    return { ...access(await fileRole(c, a, internal)), preview: previewHead(old), reused: true };
  }
  await quota(c, 'previews');
  await warehouse(c, b.warehouse_id);
  const s = await states(
    c,
    b.warehouse_id,
    [...new Set(b.rows.map((r) => r.product_id))].sort(),
    !internal.stockFileImportId,
  );
  const rows = plan(b, s, Boolean(internal.stockFileImportId)),
    sum = summary(rows),
    scopeHash = inventoryBulkEditHash({ warehouse_id: b.warehouse_id, note: b.note, rows }),
    id = internal.previewId ?? randomUUID();
  const r = await fileRole(c, a, internal);
  const p = (
    await c.query(
      `INSERT INTO inventory_bulk_edit_previews(id,tenant_id,actor_id,warehouse_id,client_key,request_hash,scope_hash,source,note,total,changed,unchanged,invalid,conflicts,ready) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        id,
        a.tenantId,
        a.userId,
        b.warehouse_id,
        b.client_key,
        hash,
        scopeHash,
        source,
        b.note,
        sum.total,
        sum.changed,
        sum.unchanged,
        sum.invalid,
        sum.conflicts,
        sum.ready,
      ],
    )
  ).rows[0];
  // Bounded JSON recordset avoids one database roundtrip per row.
  await c.query(
    `INSERT INTO inventory_bulk_edit_rows(tenant_id,preview_id,index,product_id,location,sku,input,status,before,after,errors) SELECT $1,$2,r.index,r.product_id,r.location,r.sku,r.input,r.status,r.before,r.after,r.errors FROM jsonb_to_recordset($3::jsonb) r(index int,product_id uuid,location text,sku text,input jsonb,status text,before jsonb,after jsonb,errors jsonb)`,
    [a.tenantId, id, JSON.stringify(rows)],
  );
  await audit(c, a, 'inventory.bulk.preview', id, {
    warehouse_id: b.warehouse_id,
    total: sum.total,
    scope_hash: scopeHash,
  });
  return { ...access(r), preview: previewHead(p), reused: false };
}
export async function executeInventoryBulkEdit(
  a: InventoryBulkEditActor,
  previewId: string,
  input: InventoryBulkEditExecute,
  source: 'manual' | 'api' = 'manual',
) {
  return tenantTx(a.tenantId, (c) => executeInventoryBulkEditInTx(c, a, previewId, input, source));
}

export async function executeInventoryBulkEditInTx(
  c: PoolClient,
  a: InventoryBulkEditActor,
  previewId: string,
  input: InventoryBulkEditExecute,
  source: 'manual' | 'api' = 'manual',
  internal: InventoryBulkEditInternal = {},
) {
  const b = inventoryBulkEditExecuteInput.parse(input),
    hash = requestHash({ preview_id: previewId, ...b }, source);

  // This native115 ownership probe is read-only and acquires no source lock.
  // Preserve its409 for IDs reserved by a file before COUNT source lookup.
  await fileGuard(c, internal.stockFileImportId, previewId);
  // Resolve and admit the real immutable source BEFORE native quota/header,
  // product and physical locks. A115 parent may suppress this child only with
  // a same-client opaque capability and an independent SQL child certificate.
  const borrowed = internal.catalogStockCountParent;
  if (borrowed) {
    ensure(internal.stockFileImportId === borrowed.source_id,409,'Parent pomiaru ma inne źródło importu');
    await assertCatalogStockCountChildInTx(c,a,borrowed,previewId);
  }
  const catalogCount = borrowed ? null : await prepareCatalogStockCountInTx(c,a,{
    protocol:'inventory_bulk',source_id:previewId,request:b,
  });
  const catalogParent = borrowed ?? retainCatalogStockCountParentInTx(c,a,catalogCount);
  await admission(c, a);
  const old = (
    await c.query('SELECT * FROM inventory_bulk_edit_executions WHERE client_key=$1', [
      b.client_key,
    ])
  ).rows[0];
  if (old) {
    ensure(
      old.actor_id === a.userId && old.request_hash === hash,
      409,
      'Klucz wykonania ma inny aktor lub zakres',
    );
    await abandonCatalogStockCountInTx(c,a,catalogCount);
    return {
      ...access(await fileRole(c, a, internal)),
      execution: { ...executionHead(old), stock_count_documents: await catalogStockCountDocumentsInTx(c,a,'inventory_bulk',old.id) },
      reused: true,
    };
  }
  const p = await preview(c, previewId);
  ensure(
    p.actor_id === a.userId && p.source === source && p.scope_hash === b.scope_hash && p.ready,
    409,
    'Podgląd nie jest gotowy lub zgoda ma inny zakres',
  );
  ensure(
    !(
      await c.query('SELECT id FROM inventory_bulk_edit_executions WHERE preview_id=$1', [
        previewId,
      ])
    ).rowCount,
    409,
    'Podgląd ma już wykonanie; ponów zapisany klucz',
  );
  await quota(c, 'executions');
  await warehouse(c, p.warehouse_id);
  const rows = await frozen(c, p.id);
  ensure(
    rows.length === p.total &&
      rows.every((r, i) => r.index === i) &&
      inventoryBulkEditHash({ warehouse_id: p.warehouse_id, note: p.note, rows }) === p.scope_hash,
    409,
    'Niezgodny pełny zakres podglądu',
  );
  const keys = rows
    .filter((r) => r.input.operation !== 'none')
    .map((r) => inventoryBulkEditOperationKey(p.id, b.client_key, r.index))
    .sort();
  // Ordinary locationOperation locks its operation key BEFORE stock. Match that order even for caller-guessed UUIDs.
  for (const key of keys)
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `stock-location:${a.tenantId}:${key}`,
    ]);
  const ids = [...new Set(rows.map((r) => r.product_id))].sort(),
    s = await states(c, p.warehouse_id, ids, !internal.stockFileImportId),
    request: InventoryBulkEditInput = {
      client_key: p.client_key,
      warehouse_id: p.warehouse_id,
      note: p.note,
      rows: rows.map((r) => r.input),
    },
    current = plan(request, s, Boolean(internal.stockFileImportId));
  ensure(
    inventoryBulkEditHash(current) === inventoryBulkEditHash(rows) && summary(current).ready,
    409,
    'Stan, rezerwacje, produkt lub lokalizacja zmieniły się; cała partia odrzucona',
  );
  const actor = { ...a, role: 'admin' as const },
    operationIds = new Map<number, string[]>();
  // Decreases first keep intermediate warehouse totals in range; every count still precedes every move.
  const operations = rows
    .filter((r) => r.status === 'changed')
    .sort((x, y) => {
      const rank = (r: FrozenRow) =>
        r.input.operation === 'move'
          ? 2
          : r.input.operation === 'count' && r.input.quantity < (r.before.quantity ?? 0)
            ? 0
            : 1;
      return rank(x) - rank(y) || x.index - y.index;
    });
  for (const row of operations) {
    const r = row.input;
    if (r.operation === 'none') continue;
    let stock = (
      await c.query('SELECT * FROM stock WHERE warehouse_id=$1 AND product_id=$2', [
        p.warehouse_id,
        row.product_id,
      ])
    ).rows[0];
    if (!stock) {
      ensure(
        r.operation === 'count' &&
          (internal.stockFileImportId || r.location === 'A-01') &&
          r.quantity > 0,
        409,
        'Brakujący stock wymaga rzeczywistego pomiaru',
      );
      stock = (
        await c.query(
          'INSERT INTO stock(tenant_id,warehouse_id,product_id,location,on_hand,reserved) VALUES($1,$2,$3,$4,0,0) RETURNING *',
          [
            a.tenantId,
            p.warehouse_id,
            row.product_id,
            internal.stockFileImportId ? r.location : 'A-01',
          ],
        )
      ).rows[0];
    }
    const result = await locationOperation(
      c,
      actor,
      {
        warehouse_id: p.warehouse_id,
        product_id: row.product_id,
        location: r.location,
        expected_version: stock.version,
        client_key: inventoryBulkEditOperationKey(p.id, b.client_key, row.index),
        note: p.note,
        quantity: r.quantity,
        ...(r.operation === 'move' ? { destination: r.destination } : {}),
      },
      r.operation,
      { catalogStockCountParent: catalogParent },
    );
    operationIds.set(row.index, [result.id]);
  }
  // Hydrate native results and insert the true parent before terminal flush;
  // the169 deferred publisher cannot certify an execution that does not exist.
  const after = await states(c, p.warehouse_id, ids, false),
    results = rows.map((row) => ({
      index: row.index,
      product_id: row.product_id,
      location: row.location,
      sku: row.sku,
      operation: row.input.operation,
      status: row.status,
      before: row.before,
      after: snapshot(after.get(row.product_id)!, row.location),
      before_stock_version: row.before.stock_version,
      after_stock_version: after.get(row.product_id)!.stock?.version ?? null,
      operation_ids: operationIds.get(row.index) ?? [],
    }));
  for (const row of results) {
    if (!row.after.exists && row.location === 'A-01') {
      row.after.quantity = 0;
      row.after.reserved = 0;
      row.after.available = 0;
    }
    ensure(
      inventoryBulkEditHash(row.after) === inventoryBulkEditHash(rows[row.index].after),
      409,
      'Rzeczywisty końcowy stan różni się od podglądu',
    );
  }
  const r = await fileRole(c, a, internal),
    id = randomUUID();
  const e = (
    await c.query(
      `INSERT INTO inventory_bulk_edit_executions(id,tenant_id,preview_id,actor_id,client_key,request_hash,scope_hash,total,changed,unchanged) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id,
        a.tenantId,
        p.id,
        a.userId,
        b.client_key,
        hash,
        p.scope_hash,
        p.total,
        p.changed,
        p.unchanged,
      ],
    )
  ).rows[0];
  await c.query(
    `INSERT INTO inventory_bulk_edit_execution_rows(tenant_id,execution_id,preview_id,index,product_id,location,sku,operation,status,before,after,before_stock_version,after_stock_version,operation_ids) SELECT $1,$2,$3,r.index,r.product_id,r.location,r.sku,r.operation,r.status,r.before,r.after,r.before_stock_version,r.after_stock_version,ARRAY(SELECT jsonb_array_elements_text(r.operation_ids)::uuid) FROM jsonb_to_recordset($4::jsonb) r(index int,product_id uuid,location text,sku text,operation text,status text,before jsonb,after jsonb,before_stock_version bigint,after_stock_version bigint,operation_ids jsonb)`,
    [a.tenantId, id, p.id, JSON.stringify(results)],
  );
  await audit(c, a, 'inventory.bulk.execute', id, {
    preview_id: p.id,
    warehouse_id: p.warehouse_id,
    total: p.total,
    scope_hash: p.scope_hash,
  });
  const counted = await finishCatalogStockCountInTx(c,a,catalogCount,{inventory_execution_id:id});
  //115 owns its outer terminal flush after all real child links exist.
  if (!internal.stockFileImportId) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  return { ...access(r), execution: { ...executionHead(e), stock_count_documents: counted.documents }, reused: false };
}
export async function inventoryBulkEditPreviewDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => ({
    preview: previewHead(await preview(c, id)),
    ...access(await role(c, a)),
  }));
}
export async function inventoryBulkEditExecutionDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    const e = await execution(c,id);
    const r = await role(c,a);
    return { execution: { ...executionHead(e), stock_count_documents: await catalogStockCountDocumentsInTx(c,a,'inventory_bulk',e.id) },
      ...access(r) };
  });
}
async function pagedRows(
  a: Actor,
  id: string,
  cursor: string | undefined,
  kind: 'preview' | 'execution',
) {
  const offset = cursor === undefined ? 0 : z.coerce.number().int().min(0).max(499).parse(cursor);
  return tenantTx(a.tenantId, async (c) => {
    const head = kind === 'preview' ? await preview(c, id) : await execution(c, id);
    ensure(offset === 0 || offset < head.total, 422, 'Kursor poza zakresem');
    const data = (
      await c.query(
        `SELECT ${kind === 'preview' ? 'index,product_id,location,sku,input,status,before,after,errors' : 'index,product_id,location,sku,operation,status,before,after,before_stock_version,after_stock_version,operation_ids'} FROM inventory_bulk_edit_${kind === 'preview' ? 'rows' : 'execution_rows'} WHERE ${kind === 'preview' ? 'preview_id' : 'execution_id'}=$1 AND index >=$2 ORDER BY index LIMIT 50`,
        [id, offset],
      )
    ).rows;
    if (kind === 'preview') for (const row of data) row.operation = row.input.operation;
    return {
      ...access(await role(c, a)),
      data,
      meta: { cursor: offset + 50 < head.total ? String(offset + 50) : null },
    };
  });
}
export const inventoryBulkEditPreviewRows = (a: Actor, id: string, cursor?: string) =>
  pagedRows(a, id, cursor, 'preview');
export const inventoryBulkEditExecutionRows = (a: Actor, id: string, cursor?: string) =>
  pagedRows(a, id, cursor, 'execution');
export async function inventoryBulkEditHistory(a: Actor, cursor?: string) {
  let page: [string, string] | null = null;
  if (cursor) {
    try {
      page = z
        .tuple([z.iso.datetime({ precision: 6 }), z.uuid()])
        .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    } catch {
      ensure(false, 422, 'Nieprawidłowy kursor historii');
    }
  }
  return tenantTx(a.tenantId, async (c) => {
    const rows = (
        await c.query(
          `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM inventory_bulk_edit_executions WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,
          [page?.[0] ?? null, page?.[1] ?? null],
        )
      ).rows,
      more = rows.length > 50;
    if (more) rows.pop();
    const r = await role(c,a);
    const data = [];
    for (const row of rows) data.push({ ...executionHead(row), stock_count_documents: await catalogStockCountDocumentsInTx(c,a,'inventory_bulk',row.id) });
    return {
      ...access(r),
      data,
      meta: {
        cursor: more
          ? Buffer.from(JSON.stringify([rows.at(-1).cursor_time, rows.at(-1).id])).toString(
              'base64url',
            )
          : null,
      },
    };
  });
}

export {
  states as inventoryBulkEditStatesInTx,
  plan as planInventoryBulkEdit,
  snapshot as inventoryBulkEditSnapshot,
};
