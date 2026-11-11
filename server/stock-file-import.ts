import { catalogStockCountDocumentsInTx } from './catalog-stock-count-read';
import { prepareCatalogStockCountInTx, finishCatalogStockCountInTx, abandonCatalogStockCountInTx, retainCatalogStockCountParentInTx, type CatalogStockCountAdmission, type CatalogStockCountParent } from './catalog-stock-count-effects';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx, pool } from './db';
import { ensure } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import { audit } from './domain';
import * as S from './stock-file-import-schema';
import { parseStockFile } from './stock-file-import-parse';
import { wmsLotsPolicyInTx, wmsLotsHash } from './wms-lots';
import {
  inventoryBulkEditStatesInTx,
  planInventoryBulkEdit,
  createInventoryBulkEditPreviewInTx,
  executeInventoryBulkEditInTx,
  inventoryBulkEditOperationKey,
} from './inventory-bulk-edit';
import {
  createWmsStocktakeInTx,
  countWmsStocktakeInTx,
  reviewWmsStocktakeInTx,
  postWmsStocktakeInTx,
  wmsStocktakeFileBasesInTx,
  wmsStocktakeScanBasisInTx,
  planWmsStocktakeLine,
} from './wms-stocktakes';
export * from './stock-file-import-schema';
type Row = Record<string, any>;
type Actor = S.StockFileImportActor;
const L = S.STOCK_FILE_IMPORT_LIMITS;
const tables = [
  'stock_file_import_previews',
  'stock_file_import_executions',
  'stock_file_import_profiles',
  'stock_file_import_profile_revisions',
  'stock_file_import_admissions',
  'stock_file_import_core_witnesses',
  'stock_file_import_epochs',
];
const funcs = [
  'stock_file_import_installed()',
  'stock_file_import_access(uuid,uuid,boolean,boolean)',
  'stock_file_import_snapshot(jsonb)',
  'stock_file_import_store_preview(jsonb)',
  'stock_file_import_prepare(uuid,uuid,uuid,uuid,jsonb)',
  'stock_file_import_store_execution(jsonb)',
  'stock_file_import_store_profile(jsonb)',
  'stock_file_import_core_admitted(uuid,uuid,text)',
  'stock_file_import_complete()',
  'stock_file_import_seal()',
  'stock_file_import_immutable()',
  'stock_file_import_budget()',
  'stock_file_import_epoch()',
  'stock_file_import_core_witness()',
  'stock_file_import_record(jsonb)',
  'stock_file_import_validate_preview(jsonb)',
  'stock_file_import_validate_execution(jsonb)',
  'stock_file_import_admission_validation()',
  'stock_file_import_configuration(jsonb,jsonb)',
  'stock_file_import_summary(jsonb,boolean)',
  'stock_file_import_budget_check(uuid)',
  'stock_file_import_metadata_complete()',
  'stock_file_import_hash(jsonb)',
  'stock_file_import_canonical(jsonb)',
  'stock_file_import_source_cells(jsonb)',
  'stock_file_import_cell(text,boolean,boolean)',
  'stock_file_import_xml_value(xml)',
  'stock_file_import_require(uuid,uuid,boolean)',
];
const sealed = [
  'products',
  'product_sku_aliases',
  'warehouses',
  'stock',
  'stock_locations',
  'reservations',
  'reservation_locations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_operations',
  'wms_layer_movements',
  'stock_movements',
  'stock_location_movements',
  'stock_location_operations',
  'wms_stocktakes',
  'wms_stocktake_lines',
  'wms_stocktake_reviews',
  'wms_stocktake_review_rows',
  'wms_stocktake_postings',
  'wms_stocktake_measurements',
  'wms_stocktake_measurement_layers',
  'wms_stocktake_scope_layers',
  'inventory_bulk_edit_previews',
  'inventory_bulk_edit_rows',
  'inventory_bulk_edit_executions',
  'inventory_bulk_edit_execution_rows',
  'wms_policies',
];
export async function stockFileImportAvailable(c: Pool | PoolClient) {
  const guards: Row[] = [];
  for (const table of tables.slice(0, 4))
    guards.push(
      { table, name: 'immutable', fn: 'stock_file_import_immutable()', deferred: false },
      { table, name: 'budget', fn: 'stock_file_import_budget()', deferred: false },
    );
  guards.push({
    table: 'stock_file_import_admissions',
    name: 'complete',
    fn: 'stock_file_import_complete()',
    deferred: true,
  });
  for (const table of sealed)
    guards.push({
      table,
      name: 'stock_file_seal',
      fn: 'stock_file_import_seal()',
      deferred: false,
    });
  for (const table of [
    'inventory_bulk_edit_previews',
    'inventory_bulk_edit_executions',
    'wms_stocktakes',
    'wms_stocktake_postings',
  ])
    guards.push(
      {
        table,
        name: 'stock_file_witness',
        fn: 'stock_file_import_core_witness()',
        deferred: false,
      },
      { table, name: 'stock_file_receipt', fn: 'stock_file_import_complete()', deferred: true },
    );
  for (const table of ['stock_file_import_previews', 'stock_file_import_profile_revisions'])
    guards.push({
      table,
      name: 'complete',
      fn: 'stock_file_import_metadata_complete()',
      deferred: true,
    });
  guards.push({
    table: 'stock',
    name: 'stock_file_epoch',
    fn: 'stock_file_import_epoch()',
    deferred: false,
  });
  guards.push({
    table: 'stock_file_import_admissions',
    name: 'stock_file_validation',
    fn: 'stock_file_import_admission_validation()',
    deferred: false,
  });
  for (const table of ['stock_file_import_epochs', 'stock_file_import_core_witnesses'])
    guards.push({
      table,
      name: 'stock_file_seal',
      fn: 'stock_file_import_seal()',
      deferred: false,
    });
  return Boolean(
    (
      await c.query(
        `SELECT NOT EXISTS(SELECT 1 FROM unnest($1::text[]) t WHERE to_regclass('public.'||t) IS NULL) AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) f WHERE to_regprocedure('public.'||f) IS NULL) AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) t JOIN pg_class c ON c.oid=to_regclass('public.'||t) WHERE NOT(c.relrowsecurity AND c.relforcerowsecurity)) AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) g("table" text,name text,fn text,deferred boolean) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||g."table") AND t.tgname=g.name AND t.tgfoid=to_regprocedure('public.'||g.fn) AND t.tgenabled='O' AND (NOT g.deferred OR t.tgdeferrable AND t.tginitdeferred))) ok`,
        [tables, funcs, tables, JSON.stringify(guards)],
      )
    ).rows[0].ok,
  );
}
async function access(c: PoolClient, a: Actor, writing = false, pin = false) {
  const result = (
    await c.query('SELECT stock_file_import_access($1,$2,$3,$4) result', [
      a.userId,
      a.apiKeyId ?? null,
      writing,
      pin,
    ])
  ).rows[0].result;
  ensure(result?.key_valid !== false, 401, 'Klucz API został cofnięty lub wygasł');
  ensure(result?.allowed === true, 403, 'Brak aktualnych uprawnień importu stanów');
  return {
    current_role: result.role,
    can_read: true,
    can_write: result.can_write,
    can_read_value: result.can_read_value,
  };
}
function project(v: any, value: boolean): any {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => project(x, value));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) =>
            ![
              'snapshot',
              'request',
              'request_hash',
              'children',
              'child_keys',
              'basis',
              'epoch',
              'execute_request',
              'actor_id',
              'api_key_id',
            ].includes(k) &&
            (value ||
              ![
                'unit_cost_minor',
                'known_loss_minor',
                'known_surplus_minor',
                'unknown_loss_quantity',
                'surplus_quantity',
              ].includes(k)),
        )
        .map(([k, x]) => [
          k,
          !value && ['raw_cells', 'valuation', 'fragments'].includes(k)
            ? null
            : !value && k === 'mapping' && x && typeof x === 'object'
              ? project(
                  Object.fromEntries(Object.entries(x).filter(([field]) => field !== 'currency')),
                  value,
                )
              : project(x, value),
        ]),
    );
  return v;
}
function publicRows(rows: Row[], value: boolean) {
  return rows.map((r) => {
    const { basis, epoch, position, product_version, line_id, ...safe } = r;
    return project(safe, value);
  });
}
function hash(a: Actor, kind: string, parent: string | null, request: unknown) {
  return wmsLotsHash({
    actor_id: a.userId,
    api_key_id: a.apiKeyId ?? null,
    source: a.source ?? 'manual',
    kind,
    parent_id: parent,
    request,
  });
}
async function tx<T>(a: Actor, writing: boolean, fn: (c: PoolClient, flags: Row) => Promise<T>, beforeLocks?: (c: PoolClient) => Promise<void>) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      ensure(await stockFileImportAvailable(c), 503, 'Niekompletny moduł importu stanów');
      await access(c, a, writing);
      if (beforeLocks) await beforeLocks(c);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `stock-file:${a.tenantId}`,
      ]);
      await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
        `catalog:${a.tenantId}`,
      ]);
      const flags = await access(c, a, writing);
      let result: T;
      try {
        result = await fn(c, flags);
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      } catch (e) {
        const error = e as { code?: string; message?: string };
        if (error.message === 'Wycofany klucz importu stanów') ensure(false, 401, error.message);
        if (error.message === 'Brak aktualnej zgody importu stanów')
          ensure(false, 403, error.message);
        if (error.code === 'P0001') ensure(false, 429, 'Wyczerpano budżet dowodów importu stanów');
        throw e;
      }
      const final = await access(c, a, writing, true);
      return { ...project(result, final.can_read_value), ...final };
    },
    { purchasingAdmission: writing, wmsAdmission: writing ? 'serial' : 'read' },
  );
}
async function scope(c: PoolClient, targets: Row[], products: string[]) {
  return (
    await c.query('SELECT stock_file_import_snapshot($1) snapshot', [
      JSON.stringify({ warehouse_ids: targets.map((t) => t.warehouse_id), product_ids: products }),
    ])
  ).rows[0].snapshot;
}
async function head(c: PoolClient, kind: 'previews' | 'executions', id: string) {
  const h = (await c.query(`SELECT * FROM stock_file_import_${kind} WHERE id=$1`, [id])).rows[0];
  ensure(h, 404, 'Nie znaleziono importu');
  return h as Row;
}
function view(h: Row, canWrite: boolean, executed = false) {
  const b = h.payload;
  return {
    ...b,
    id: h.id,
    created_at: h.created_at,
    can_execute: canWrite && !executed && b.summary.invalid === 0 && b.summary.conflicts === 0,
    rows: undefined,
    snapshot: undefined,
    request: undefined,
  };
}
async function resolution(c: PoolClient, b: S.StockFileImportInput, parsed: S.ParsedStockFile) {
  const values = [...new Set(parsed.rows.flatMap((r) => (r.identity ? [r.identity] : [])))];
  // A deleted product (225) matches no file row: it reads as an unknown identifier.
  const deletions = await productDeletionsAvailable(c);
  const ps = (
    await c.query(
      `SELECT * FROM products p WHERE CASE WHEN $1='uuid' THEN p.id::text=ANY($2) WHEN $1 IN ('sku','historical_sku') THEN p.sku=ANY($2) OR ($1='historical_sku' AND EXISTS(SELECT 1 FROM product_sku_aliases a WHERE (a.tenant_id,a.product_id)=(p.tenant_id,p.id) AND a.sku=ANY($2))) WHEN $1='ean' THEN p.ean<>'' AND p.ean=ANY($2) ELSE p.name=ANY($2) END AND ${productNotDeletedSQL(deletions)} ORDER BY p.id FOR SHARE`,
      [b.definition.identity, values],
    )
  ).rows as Row[];
  const aliases =
    b.definition.identity === 'historical_sku'
      ? (
          await c.query(
            'SELECT sku,product_id FROM product_sku_aliases WHERE sku=ANY($1::text[])',
            [values],
          )
        ).rows
      : [];
  return parsed.rows.map((r) => {
    const candidates = ps.filter((p) =>
      b.definition.identity === 'uuid'
        ? p.id === r.identity
        : b.definition.identity === 'ean'
          ? p.ean === r.identity
          : b.definition.identity === 'name'
            ? p.name === r.identity
            : p.sku === r.identity ||
              aliases.some((v) => v.sku === r.identity && v.product_id === p.id),
    );
    return {
      source: r,
      product: candidates.length === 1 ? candidates[0] : null,
      resolution: {
        identity: b.definition.identity,
        value: r.identity,
        matched_historical_sku:
          b.definition.identity === 'historical_sku' &&
          candidates.length === 1 &&
          candidates[0].sku !== r.identity
            ? r.identity
            : null,
        candidates: candidates.map((p) => p.id),
      },
      errors: [
        ...r.errors,
        ...(candidates.length !== 1
          ? ['Identyfikator musi wskazywać dokładnie jeden własny produkt']
          : !candidates[0].active || !['simple', 'variant'].includes(candidates[0].kind)
            ? ['Pomiar wymaga aktywnego fizycznego produktu']
            : []),
      ],
    };
  });
}
function positionKey(r: Row) {
  return JSON.stringify([
    r.product_id,
    r.location,
    r.lot?.id ?? r.lot?.lot_id ?? r.lot?.lot_code ?? null,
  ]);
}
function before(b: Row) {
  return {
    present: b.stock.present,
    quantity: b.quantity,
    reserved: b.reserved,
    available: b.quantity - b.reserved,
    warehouse_on_hand: b.stock.on_hand,
    warehouse_reserved: b.stock.reserved,
    stock_version: b.stock.version,
  };
}
async function build(c: PoolClient, a: Actor, b: S.StockFileImportInput, reserved?: Row) {
  const parsed = parseStockFile(b),
    resolved = await resolution(c, b, parsed),
    policy = await wmsLotsPolicyInTx(c),
    products = [
      ...new Set<string>(resolved.flatMap((r) => (r.product ? [r.product.id as string] : []))),
    ].sort();
  ensure(products.length <= L.products, 413, 'Za dużo produktów');
  const warehouses = (
    await c.query(
      'SELECT id,name,code FROM warehouses WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [b.targets.map((t) => t.warehouse_id)],
    )
  ).rows;
  ensure(warehouses.length === b.targets.length, 404, 'Obcy lub brakujący magazyn');
  // Freeze the entire union first, independent of row order and absent stock.
  for (const w of warehouses) await inventoryBulkEditStatesInTx(c, w.id, products, false);
  const frozen = await scope(c, b.targets, products),
    rows: Row[] = [],
    targets: Row[] = [];
  let expandedLayers = 0;
  for (const target of b.targets) {
    const wh = warehouses.find((w) => w.id === target.warehouse_id)!;
    const targetRows: Row[] = [];
    for (const r of resolved) {
      const cell = r.source.cells.find((v) => v.warehouse_id === target.warehouse_id)!;
      const errors = [...r.errors, ...cell.errors];
      for (const p of cell.positions.length ? cell.positions : [null])
        targetRows.push({
          index: 0,
          source_index: r.source.source_index,
          raw_cells: r.source.raw_cells,
          resolution: r.resolution,
          product_id: r.product?.id ?? null,
          sku: r.product?.sku ?? null,
          name: r.product?.name ?? null,
          warehouse_id: wh.id,
          warehouse_name: wh.name,
          location: p?.location ?? null,
          lot: p?.lot ?? null,
          input: { operation: cell.operation, ...(p ? { quantity: p.quantity } : {}) },
          before: null,
          after: null,
          fragments: null,
          valuation: null,
          status: errors.length ? 'invalid' : cell.operation === 'none' ? 'skipped' : 'unchanged',
          errors: [...errors],
          product_version: r.product?.version ?? null,
          position: p,
        });
    }
    const physical = targetRows.filter(
      (r) => r.status !== 'invalid' && r.input.operation === 'count' && r.position,
    );
    const seen = new Map<string, Row>();
    // The secured snapshot is the authoritative own-lot projection. App role
    // intentionally has no direct wms_lots table grant.
    const lots: Row[] = policy.enabled ? frozen.lots : [];
    for (const r of physical) {
      if (Boolean(r.lot) !== Boolean(policy.enabled))
        r.errors.push(
          policy.enabled ? 'WMS wymaga jawnej partii' : 'Wyłączony WMS nie przyjmuje partii',
        );
      if (r.lot?.kind === 'existing') {
        const l = lots.find((l) => l.id === r.lot.lot_id && l.product_id === r.product_id);
        if (!l) r.errors.push('Obca partia produktu');
        else r.lot = { id: l.id, lot_code: l.lot_code, expiry_date: l.expiry_date };
      } else if (r.lot) {
        if (lots.some((l) => l.product_id === r.product_id && l.lot_code === r.lot.lot_code))
          r.errors.push('Kod partii już istnieje; wybierz jej UUID');
        r.lot = { id: null, lot_code: r.lot.lot_code, expiry_date: r.lot.expiry_date };
      }
      const key = positionKey(r);
      const duplicate = seen.get(key);
      if (duplicate) {
        r.errors.push('Powtórzona fizyczna pozycja');
        if (!duplicate.errors.includes('Powtórzona fizyczna pozycja'))
          duplicate.errors.push('Powtórzona fizyczna pozycja');
      } else seen.set(key, r);
    }
    for (const r of resolved) {
      const cell = r.source.cells.find((v) => v.warehouse_id === wh.id)!;
      if (target.quantity_scope !== 'warehouse_total' || cell.operation === 'none' || !r.product)
        continue;
      const productId = r.product.id;
      const existing = policy.enabled
        ? frozen.layer_positions
            .filter((p: Row) => p.warehouse_id === wh.id && p.product_id === productId)
            .map((p: Row) => {
              const layer = frozen.layers.find((l: Row) => l.id === p.layer_id);
              return JSON.stringify([p.product_id, p.location, layer?.lot_id]);
            })
        : frozen.bins
            .filter((p: Row) => p.warehouse_id === wh.id && p.product_id === productId)
            .map((p: Row) => JSON.stringify([p.product_id, p.location, null]));
      if (
        existing.some(
          (key: string) =>
            !physical.some(
              (p) => p.source_index === r.source.source_index && positionKey(p) === key,
            ),
        )
      )
        for (const p of targetRows.filter((p) => p.source_index === r.source.source_index))
          p.errors.push('Agregat nie obejmuje wszystkich istniejących pozycji');
    }
    if (policy.enabled) {
      const ls = physical
        .filter((r) => !r.errors.length)
        .map((r) => ({
          id:
            reserved?.rows.find(
              (x: Row) =>
                x.source_index === r.source_index &&
                x.warehouse_id === r.warehouse_id &&
                positionKey(x) === positionKey(r),
            )?.line_id ?? randomUUID(),
          product_id: r.product_id,
          location: r.location,
          lot_id: r.lot.id,
          lot: r.lot,
          original: { layer_ids: [] },
          counted: r.input.quantity,
        }));
      const bs = await wmsStocktakeFileBasesInTx(c, wh.id, ls, true);
      expandedLayers += [...bs.values()].reduce((n, b) => n + b.layers.length, 0);
      ensure(expandedLayers <= L.expanded_layers, 413, 'Za dużo warstw');
      for (const l of ls) {
        const r = physical.find((r) => positionKey(r) === positionKey(l))!,
          base = bs.get(l.id)!;
        r.line_id = l.id;
        r.basis = base;
        r.before = before(base);
        r.epoch =
          frozen.epochs.find((e: Row) => e.warehouse_id === wh.id && e.product_id === r.product_id)
            ?.version ?? '0';
        try {
          const plan = planWmsStocktakeLine(
            l,
            base,
            r.input.quantity > base.quantity
              ? { unit_cost_minor: r.position.unit_cost_minor, currency: r.position.currency }
              : undefined,
          );
          r.after = { ...r.before, quantity: l.counted, available: l.counted - base.reserved };
          r.fragments = plan.fragments;
          r.status = base.quantity === l.counted ? 'unchanged' : 'changed';
          let loss = 0n,
            gain = 0n,
            unknown = 0;
          for (const f of plan.fragments) {
            if (f.unit_cost_minor === null) unknown += f.quantity;
            else if (f.delta < 0) loss += BigInt(f.unit_cost_minor) * BigInt(f.quantity);
            else gain += BigInt(f.unit_cost_minor) * BigInt(f.quantity);
          }
          r.valuation = {
            known_loss_minor: loss.toString(),
            known_surplus_minor: gain.toString(),
            unknown_loss_quantity: unknown,
            surplus_quantity: Math.max(0, l.counted - base.quantity),
            currency: policy.currency,
          };
        } catch (e) {
          r.errors.push(e instanceof Error ? e.message : 'Niepoprawny plan warstw');
        }
      }
    } else {
      const state = await inventoryBulkEditStatesInTx(c, wh.id, products, false),
        valid = physical.filter((r) => !r.errors.length);
      const input = {
        warehouse_id: wh.id,
        client_key: b.client_key,
        note: b.note,
        rows: valid.map((r) => ({
          product_id: r.product_id,
          product_version: r.product_version,
          stock_version: state.get(r.product_id)!.stock?.version ?? null,
          location: r.location,
          operation: 'count' as const,
          quantity: r.input.quantity,
        })),
      };
      const plans = planInventoryBulkEdit(input, state, true);
      for (const [i, r] of valid.entries()) {
        const plan = plans[i];
        r.basis = state.get(r.product_id);
        r.epoch =
          frozen.epochs.find((e: Row) => e.warehouse_id === wh.id && e.product_id === r.product_id)
            ?.version ?? '0';
        r.before = {
          present: plan.before.exists,
          quantity: plan.before.quantity ?? 0,
          reserved: plan.before.reserved ?? 0,
          available: plan.before.available ?? 0,
          warehouse_on_hand: plan.before.warehouse_on_hand,
          warehouse_reserved: plan.before.warehouse_reserved,
          stock_version: plan.before.stock_version,
        };
        r.after = {
          ...r.before,
          quantity: plan.after?.quantity ?? r.before.quantity,
          available: plan.after?.available ?? r.before.available,
          warehouse_on_hand: plan.after?.warehouse_on_hand ?? r.before.warehouse_on_hand,
          stock_version: plan.after?.stock_version ?? r.before.stock_version,
        };
        r.status = plan.status;
        r.errors.push(...plan.errors);
      }
    }
    for (const r of targetRows) {
      if (r.errors.length) r.status = 'invalid';
      rows.push(r);
    }
    const stats = {
      positions: targetRows.length,
      changed: targetRows.filter((r) => r.status === 'changed').length,
      unchanged: targetRows.filter((r) => r.status === 'unchanged' || r.status === 'skipped')
        .length,
      invalid: targetRows.filter((r) => r.status === 'invalid').length,
      conflicts: 0,
      unknown_loss_quantity: targetRows.reduce(
        (n, r) => n + (r.valuation?.unknown_loss_quantity ?? 0),
        0,
      ),
      surplus_quantity: targetRows.reduce((n, r) => n + (r.valuation?.surplus_quantity ?? 0), 0),
    };
    const old = reserved?.targets.find((t: Row) => t.warehouse_id === wh.id);
    const active = targetRows.filter(
      (r) => r.input.operation === 'count' && r.product_id && r.position,
    );
    const children =
      old?.children ??
      (policy.enabled && active.length
        ? [
            {
              id: randomUUID(),
              create_key: randomUUID(),
              count_keys: Array.from({ length: Math.ceil(active.length / 100) }, () =>
                randomUUID(),
              ),
              review_key: randomUUID(),
              post_key: randomUUID(),
            },
          ]
        : !policy.enabled
          ? Array.from({ length: Math.ceil(active.length / 500) }, () => ({
              id: randomUUID(),
              create_key: randomUUID(),
              execute_key: randomUUID(),
            }))
          : []);
    targets.push({
      ...target,
      warehouse_name: wh.name,
      summary: stats,
      valuation: policy.enabled
        ? {
            currency: policy.currency,
            known_loss_minor: targetRows
              .reduce((n, r) => n + BigInt(r.valuation?.known_loss_minor ?? 0), 0n)
              .toString(),
            known_surplus_minor: targetRows
              .reduce((n, r) => n + BigInt(r.valuation?.known_surplus_minor ?? 0), 0n)
              .toString(),
          }
        : null,
      children,
    });
  }
  rows.forEach((r, i) => (r.index = i));
  // Net warehouse and bin totals must be valid before any child is created.
  for (const t of targets)
    for (const product of products) {
      const rs = rows.filter(
          (r) =>
            r.warehouse_id === t.warehouse_id &&
            r.product_id === product &&
            r.before &&
            r.input.operation === 'count',
        ),
        delta = rs.reduce((n, r) => n + r.input.quantity - r.before.quantity, 0);
      for (const r of rs)
        if (r.after) r.after.warehouse_on_hand = rs[0].before.warehouse_on_hand + delta;
      if (
        rs.length &&
        (rs[0].before.warehouse_on_hand + delta < rs[0].before.warehouse_reserved ||
          rs[0].before.warehouse_on_hand + delta > 2147483647)
      )
        for (const r of rs) {
          r.errors.push('Końcowy stan narusza rezerwacje lub int32');
          r.status = 'invalid';
        }
    }
  for (const t of targets) {
    const rs = rows.filter((r) => r.warehouse_id === t.warehouse_id);
    t.summary = {
      ...t.summary,
      changed: rs.filter((r) => r.status === 'changed').length,
      unchanged: rs.filter((r) => r.status === 'unchanged' || r.status === 'skipped').length,
      invalid: rs.filter((r) => r.status === 'invalid').length,
      conflicts: rs.filter((r) => r.status === 'conflict').length,
    };
  }
  const summary = {
    source_rows: parsed.rows.length,
    products: products.length,
    positions: rows.length,
    changed: rows.filter((r) => r.status === 'changed').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    invalid: rows.filter((r) => r.status === 'invalid').length,
    conflicts: rows.filter((r) => r.status === 'conflict').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
    unknown_loss_quantity: targets.reduce((n, t) => n + t.summary.unknown_loss_quantity, 0),
    surplus_quantity: targets.reduce((n, t) => n + t.summary.surplus_quantity, 0),
  };
  ensure(
    Buffer.byteLength(JSON.stringify({ rows, snapshot: frozen })) <= L.preview_bytes,
    413,
    'Podgląd przekracza 32 MiB',
  );
  // Hash the exact JSON representation that PostgreSQL receives. Core basis rows
  // contain pg Date instances; shared hash semantics intentionally stay unchanged.
  return JSON.parse(
    JSON.stringify({
      file_name: b.file_name,
      client_key: b.client_key,
      definition: b.definition,
      targets,
      note: b.note,
      source_hash: parsed.source_hash,
      summary,
      policy,
      rows,
      snapshot: frozen,
      request: b,
    }),
  ) as Row;
}
export async function stockFileImportOptions(a: Actor, q: unknown = {}) {
  const b = S.stockFileImportOptionsQuery.parse(q);
  return tx(a, false, async (c) => {
    const warehouses = (
      await c.query(
        "SELECT id,name,code FROM warehouses WHERE ($1::uuid IS NULL OR id>$1) AND ($2='' OR name ILIKE '%'||$2||'%' OR code ILIKE '%'||$2||'%') ORDER BY id LIMIT 51",
        [b.cursor ?? null, b.search],
      )
    ).rows;
    return {
      available: true,
      limits: L,
      policy: await wmsLotsPolicyInTx(c),
      warehouses: warehouses.slice(0, 50),
      next_cursor: warehouses.length > 50 ? warehouses[49].id : null,
    };
  });
}
export async function createStockFileImportPreview(a: Actor, raw: unknown) {
  const b = S.stockFileImportPreviewInput.parse(raw);
  return tx(a, true, async (c, f) => {
    const request_hash = hash(a, 'preview', null, b),
      old = (
        await c.query('SELECT * FROM stock_file_import_previews WHERE client_key=$1', [
          b.client_key,
        ])
      ).rows[0];
    if (old) {
      ensure(
        old.actor_id === a.userId &&
          old.api_key_id === (a.apiKeyId ?? null) &&
          old.request_hash === request_hash,
        409,
        'Klucz podglądu ma inny zakres lub autora',
      );
      return {
        preview: view(
          old,
          f.can_write,
          Boolean(
            (
              await c.query('SELECT 1 FROM stock_file_import_executions WHERE preview_id=$1', [
                old.id,
              ])
            ).rowCount,
          ),
        ),
        reused: true,
      };
    }
    const payload = await build(c, a, b),
      id = randomUUID();
    const scoped = {
      ...payload,
      id,
      actor_id: a.userId,
      api_key_id: a.apiKeyId ?? null,
      source: a.source ?? 'manual',
      request_hash,
    };
    const full = { ...scoped, scope_hash: wmsLotsHash(scoped) };
    await c.query('SELECT stock_file_import_store_preview($1)', [JSON.stringify(full)]);
    await audit(c, a, 'stock.file.preview', id, {
      positions: payload.rows.length,
      source_hash: payload.source_hash,
    });
    return {
      preview: view({ id, payload: full, created_at: new Date() }, f.can_write),
      reused: false,
    };
  });
}
export async function stockFileImportPreviewDetail(a: Actor, id: string) {
  return tx(a, false, async (c, f) => ({
    preview: view(
      await head(c, 'previews', id),
      f.can_write,
      Boolean(
        (await c.query('SELECT 1 FROM stock_file_import_executions WHERE preview_id=$1', [id]))
          .rowCount,
      ),
    ),
  }));
}
export async function stockFileImportExecutionDetail(a: Actor, id: string) {
  return tx(a, false, async (c) => ({ execution: {...view(await head(c, 'executions', id), false), stock_count_documents:await catalogStockCountDocumentsInTx(c,a,'stock_file',id)} }));
}
export async function stockFileImportRows(
  a: Actor,
  kind: 'previews' | 'executions',
  id: string,
  q: unknown = {},
) {
  const b = S.stockFileImportRowsQuery.parse(q);
  return tx(a, false, async (c, f) => {
    const rows = (await head(c, kind, id)).payload.rows as Row[],
      start = Number(b.cursor ?? 0);
    ensure(start <= rows.length, 422, 'Niepoprawny kursor wierszy');
    return {
      rows: publicRows(rows.slice(start, start + 50), f.can_read_value),
      total: rows.length,
      next_cursor: start + 50 < rows.length ? String(start + 50) : null,
    };
  });
}
async function history(c: PoolClient, table: string, cursor?: string) {
  let anchor: Row | undefined;
  if (cursor) {
    anchor = (await c.query(`SELECT created_at,id FROM ${table} WHERE id=$1`, [cursor])).rows[0];
    ensure(anchor, 404, 'Nieznany kursor historii');
  }
  const data = (
    await c.query(
      `SELECT * FROM ${table} WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,
      [anchor?.created_at ?? null, anchor?.id ?? null],
    )
  ).rows;
  return {
    data: data.slice(0, 50),
    next_cursor: data.length > 50 ? data[49].id : null,
    total: (await c.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
  };
}
async function executionHistoryViews(c:PoolClient,a:Actor,heads:Row[],kind:'previews'|'executions',canWrite:boolean,done:string[]) {
  const result:Row[]=[];
  for (const h of heads) result.push({...view(h,kind==='previews' && canWrite,done.includes(h.id)),
    ...(kind==='executions' ? {stock_count_documents:await catalogStockCountDocumentsInTx(c,a,'stock_file',h.id)} : {}),
  });
  return result;
}
export async function stockFileImportHistory(
  a: Actor,
  kind: 'previews' | 'executions',
  q: unknown = {},
) {
  const b = S.stockFileImportPageQuery.parse(q);
  return tx(a, false, async (c, f) => {
    const page = await history(c, `stock_file_import_${kind}`, b.cursor),
      done =
        kind === 'previews'
          ? (await c.query('SELECT preview_id FROM stock_file_import_executions')).rows.map(
              (r) => r.preview_id,
            )
          : [];
    return {
      ...page,
      data: await executionHistoryViews(c,a,page.data,kind,f.can_write,done),
    };
  });
}
export async function executeStockFileImport(a: Actor, id: string, raw: unknown) {
  const b = S.stockFileImportExecuteInput.parse(raw);
  let countAdmission: CatalogStockCountAdmission | null = null;
  let countParent: CatalogStockCountParent | undefined;
  return tx(a, true, async (c, f) => {
    const p = await head(c, 'previews', id),
      request_hash = hash(a, 'execute', id, b),
      old = (
        await c.query('SELECT * FROM stock_file_import_executions WHERE client_key=$1', [
          b.client_key,
        ])
      ).rows[0];
    if (old) {
      ensure(
        old.actor_id === a.userId &&
          old.api_key_id === (a.apiKeyId ?? null) &&
          old.request_hash === request_hash &&
          old.preview_id === id,
        409,
        'Klucz wykonania ma inny zakres lub autora',
      );
      await abandonCatalogStockCountInTx(c,a,countAdmission);
      return { execution: {...view(old, false), stock_count_documents:await catalogStockCountDocumentsInTx(c,a,'stock_file',old.id)}, reused: true };
    }
    ensure(
      p.actor_id === a.userId && p.api_key_id === (a.apiKeyId ?? null),
      409,
      'Podgląd należy do innego autora lub klucza',
    );
    ensure(
      p.payload.scope_hash === b.scope_hash &&
        p.payload.summary.invalid === 0 &&
        p.payload.summary.conflicts === 0,
      409,
      'Podgląd nie jest gotowy lub zgoda ma inny zakres',
    );
    ensure(
      !(await c.query('SELECT 1 FROM stock_file_import_executions WHERE preview_id=$1', [id]))
        .rowCount,
      409,
      'Podgląd został wykonany',
    );
    const unknown = p.payload.targets
        .filter((t: Row) => t.summary.unknown_loss_quantity > 0)
        .map((t: Row) => t.warehouse_id)
        .sort(),
      surplus = p.payload.targets
        .filter((t: Row) => t.summary.surplus_quantity > 0)
        .map((t: Row) => t.warehouse_id)
        .sort();
    ensure(
      wmsLotsHash(unknown) === wmsLotsHash(b.ack_unknown_loss_warehouse_ids) &&
        wmsLotsHash(surplus) === wmsLotsHash(b.ack_surplus_warehouse_ids),
      422,
      'Zgody wyceny muszą odpowiadać dokładnie magazynom',
    );
    // Every child key is admitted before products/physical locks.
    for (const target of p.payload.targets)
      for (const child of target.children) {
        for (const key of [
          child.create_key,
          ...(child.count_keys ?? []),
          child.review_key,
          child.post_key,
          child.execute_key,
        ]
          .filter(Boolean)
          .sort())
          await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `wms:stocktake:${a.tenantId}:${key}`,
          ]);
        if (!p.payload.policy.enabled) {
          const rs = p.payload.rows.filter(
              (r: Row) =>
                r.warehouse_id === target.warehouse_id &&
                r.input.operation === 'count' &&
                r.position,
            ),
            index = target.children.indexOf(child);
          for (let i = 0; i < Math.min(500, rs.length - index * 500); i++)
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
              `stock-location:${a.tenantId}:${inventoryBulkEditOperationKey(child.id, child.execute_key, i)}`,
            ]);
        }
      }
    const current = await build(c, a, p.payload.request, p.payload);
    ensure(
      wmsLotsHash(current) ===
        wmsLotsHash(
          Object.fromEntries(
            Object.entries(p.payload).filter(
              ([k]) =>
                !['id', 'actor_id', 'api_key_id', 'source', 'request_hash', 'scope_hash'].includes(
                  k,
                ),
            ),
          ),
        ),
      409,
      'Stan, produkt, polityka, rezerwacje lub źródło zmieniły się',
    );
    const eid = randomUUID();
    await c.query('SELECT stock_file_import_prepare($1,$2,$3,$4,$5)', [
      id,
      eid,
      a.userId,
      a.apiKeyId ?? null,
      JSON.stringify(b),
    ]);
    const links: Row[] = [];
    for (const target of p.payload.targets) {
      const rs = p.payload.rows.filter(
        (r: Row) =>
          r.warehouse_id === target.warehouse_id &&
          r.input.operation === 'count' &&
          r.position &&
          r.product_id,
      );
      for (const [ci, child] of (target.children as Row[]).entries()) {
        if (!p.payload.policy.enabled) {
          const rows = rs.slice(ci * 500, (ci + 1) * 500),
            state = await inventoryBulkEditStatesInTx(
              c,
              target.warehouse_id,
              [...new Set<string>(rows.map((r: Row) => r.product_id as string))].sort(),
              false,
            );
          const core = await createInventoryBulkEditPreviewInTx(
            c,
            a,
            {
              client_key: child.create_key,
              warehouse_id: target.warehouse_id,
              note: p.payload.note,
              rows: rows.map((r: Row) => ({
                product_id: r.product_id,
                product_version: r.product_version,
                stock_version: state.get(r.product_id)!.stock?.version ?? null,
                location: r.location,
                operation: 'count' as const,
                quantity: r.input.quantity,
              })),
            },
            a.source ?? 'manual',
            { stockFileImportId: id, previewId: child.id },
          );
          const executed = await executeInventoryBulkEditInTx(
            c,
            a,
            child.id,
            { client_key: child.execute_key, scope_hash: core.preview.scope_hash, confirmed: true },
            a.source ?? 'manual',
            { stockFileImportId: id, catalogStockCountParent: countParent },
          );
          links.push({
            warehouse_id: target.warehouse_id,
            mode: 'off',
            core_preview_id: child.id,
            core_execution_id: executed.execution.id,
          });
        } else {
          const internal = {
            stockFileImportId: id,
            headId: child.id,
            exactScope: true,
            lineIds: rs.map((r: Row) => r.line_id),
          };
          const created = await createWmsStocktakeInTx(
            c,
            a,
            {
              client_key: child.create_key,
              warehouse_id: target.warehouse_id,
              name: p.payload.note.slice(0, 100),
              policy_version: p.payload.policy.version,
              blind: false,
              location_prefix: '',
              product_ids: [...new Set<string>(rs.map((r: Row) => r.product_id as string))],
              discoveries: rs.map((r: Row) => ({
                product_id: r.product_id,
                location: r.location,
                lot: r.position.lot,
              })),
            },
            internal,
          );
          for (let i = 0; i < rs.length; i += 100) {
            const group = rs.slice(i, i + 100),
              basis = await wmsStocktakeScanBasisInTx(
                c,
                a,
                child.id,
                group.map((r: Row) => r.line_id),
                true,
              );
            await countWmsStocktakeInTx(
              c,
              a,
              child.id,
              {
                client_key: child.count_keys[i / 100],
                note: p.payload.note,
                lines: group.map((r: Row) => ({
                  id: r.line_id,
                  version: basis.lines.find((l) => l.id === r.line_id)!.version,
                  basis_token: basis.entries.get(r.line_id)!.basis_token,
                  quantity: r.input.quantity,
                })),
              },
              internal,
            );
          }
          const h = (await c.query('SELECT version FROM wms_stocktakes WHERE id=$1', [child.id]))
            .rows[0];
          const review = await reviewWmsStocktakeInTx(
            c,
            a,
            child.id,
            {
              client_key: child.review_key,
              version: h.version,
              note: p.payload.note,
              surplus: rs
                .filter((r: Row) => r.input.quantity > r.before.quantity)
                .map((r: Row) => ({
                  line_id: r.line_id,
                  unit_cost_minor: r.position.unit_cost_minor,
                  currency: r.position.currency,
                })),
            },
            internal,
          );
          const posted = await postWmsStocktakeInTx(
            c,
            a,
            child.id,
            {
              client_key: child.post_key,
              version: review.review.stocktake_version,
              review_id: review.review.id,
              scope_hash: review.review.scope_hash,
              confirmed: true,
            },
            internal,
          );
          links.push({
            warehouse_id: target.warehouse_id,
            mode: 'on',
            stocktake_id: created.stocktake.id,
            review_id: review.review.id,
            posting_id: posted.posting.id,
            operation_id: posted.posting.wms_operation_id,
          });
        }
      }
    }
    const finalSnapshot = await scope(
      c,
      p.payload.targets,
      p.payload.snapshot.products.map((p: Row) => p.id),
    );
    const actualRows = p.payload.rows.map((r: Row) => {
      if (!r.after) return r;
      const stock = finalSnapshot.stock.find(
        (s: Row) => s.warehouse_id === r.warehouse_id && s.product_id === r.product_id,
      );
      return {
        ...r,
        after: {
          ...r.after,
          present: Boolean(stock),
          warehouse_on_hand: stock?.on_hand ?? 0,
          warehouse_reserved: stock?.reserved ?? 0,
          stock_version: stock?.version ?? null,
        },
      };
    });
    const payload = {
      ...p.payload,
      rows: actualRows,
      id: eid,
      preview_id: id,
      client_key: b.client_key,
      actor_id: a.userId,
      api_key_id: a.apiKeyId ?? null,
      request_hash,
      execute_request: b,
      links,
      snapshot: finalSnapshot,
    };
    await c.query('SELECT stock_file_import_store_execution($1)', [JSON.stringify(payload)]);
    const countReceipt = await finishCatalogStockCountInTx(c,a,countAdmission,{stock_file_execution_id:eid});
    await audit(c, a, 'stock.file.execute', eid, {
      preview_id: id,
      positions: p.payload.rows.length,
    });
    return { execution: {...view({ id: eid, payload, created_at: new Date() }, false), stock_count_documents:countReceipt.documents}, reused: false };
  },async c => {
    countAdmission = await prepareCatalogStockCountInTx(c,a,{protocol:'stock_file',source_id:id,request:b});
    countParent = retainCatalogStockCountParentInTx(c,a,countAdmission);
  });
}
export async function stockFileImportProfiles(a: Actor, q: unknown = {}) {
  const b = S.stockFileImportPageQuery.parse(q);
  return tx(a, false, async (c) => {
    const page = await history(c, 'stock_file_import_profiles', b.cursor);
    return {
      ...page,
      data: page.data.map((r) => ({
        ...r.payload,
        id: r.id,
        version: r.version,
        created_at: r.created_at,
      })),
    };
  });
}
export async function stockFileImportProfileDetail(a: Actor, id: string) {
  return tx(a, false, async (c) => {
    const p = (await c.query('SELECT * FROM stock_file_import_profiles WHERE id=$1', [id])).rows[0];
    ensure(p, 404, 'Nie znaleziono profilu');
    return { profile: { ...p.payload, id: p.id, version: p.version, created_at: p.created_at } };
  });
}
export async function saveStockFileImportProfile(a: Actor, raw: unknown, id?: string) {
  const b = id
    ? S.stockFileImportProfileUpdateInput.parse(raw)
    : S.stockFileImportProfileInput.parse(raw);
  return tx(a, true, async (c) => {
    const rh = hash(a, 'profile', id ?? null, b),
      prior = (
        await c.query('SELECT * FROM stock_file_import_profile_revisions WHERE client_key=$1', [
          b.client_key,
        ])
      ).rows[0];
    if (prior) {
      ensure(
        prior.actor_id === a.userId &&
          prior.api_key_id === (a.apiKeyId ?? null) &&
          prior.request_hash === rh,
        409,
        'Klucz profilu ma inny zakres lub autora',
      );
      return { profile: prior.payload, reused: true };
    }
    const current = id
      ? (await c.query('SELECT * FROM stock_file_import_profiles WHERE id=$1', [id])).rows[0]
      : null;
    if (id)
      ensure(
        current &&
          current.version === (b as z.infer<typeof S.stockFileImportProfileUpdateInput>).version,
        409,
        'Wersja profilu zmieniła się',
      );
    const profile = {
      ...b,
      id: id ?? randomUUID(),
      version: (current?.version ?? 0) + 1,
      actor_id: a.userId,
      api_key_id: a.apiKeyId ?? null,
      request_hash: rh,
      source: a.source ?? 'manual',
    };
    await c.query('SELECT stock_file_import_store_profile($1)', [JSON.stringify(profile)]);
    await audit(c, a, 'stock.file.profile', profile.id, { version: profile.version });
    return { profile, reused: false };
  });
}

export async function stockFileImportLegacyOptions(a: Actor) {
  // Owner-only metadata read: dyna_app deliberately has no migrations SELECT grant.
  const installed = (
    await pool.query(
      "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='115_stock_file_imports') installed",
    )
  ).rows[0].installed;
  ensure(!installed, 503, 'Niekompletny moduł importu stanów');
  return tenantTx(
    a.tenantId,
    async (c) => {
      const p = (
        await c.query(
          "SELECT to_regprocedure('public.stock_file_import_installed()') IS NOT NULL probe,to_regclass('public.stock_file_import_previews') IS NOT NULL artifacts",
        )
      ).rows[0];
      ensure(
        !p.artifacts &&
          (!p.probe ||
            !(await c.query('SELECT stock_file_import_installed() installed')).rows[0].installed),
        503,
        'Niekompletny moduł importu stanów',
      );
      const role = (await c.query('SELECT catalog_bulk_edit_current_role($1) role', [a.userId]))
        .rows[0].role;
      ensure(['admin', 'operator', 'viewer'].includes(role), 403, 'Utracono dostęp do firmy');
      return {
        current_role: role,
        can_read: true,
        can_write: false,
        can_read_value: false,
        policy: await wmsLotsPolicyInTx(c),
      };
    },
    { wmsAdmission: 'read' },
  );
}
