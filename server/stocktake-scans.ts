import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tenantTx, localConfig } from './db';
import { ensure } from './errors';
import { audit } from './domain';
import {
  wmsLotsAssertActorInTx,
  wmsLotsHash,
  wmsLotsPolicyInTx,
} from './wms-lots';
import { stocktakeScanBudgetInTx } from './stocktake-limits';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { wmsStocktakeScanBasisInTx, applyWmsStocktakeScanCountInTx } from './wms-stocktakes';
import { quantityStocktakeScanBasisInTx, applyQuantityStocktakeScanCountInTx } from './stocktakes';
import * as S from './stocktake-scans-schema';
export * from './stocktake-scans-schema';
type Row = Record<string, any>;
type Actor = S.StocktakeScanActor;
type Engine = S.StocktakeScanEngine;
const L = S.STOCKTAKE_SCAN_LIMITS;
const names = (e: Engine) =>
  e === 'wms'
    ? {
        heads: 'wms_stocktakes',
        lines: 'wms_stocktake_lines',
        measurements: 'wms_stocktake_measurements',
      }
    : { heads: 'stocktakes', lines: 'stocktake_lines', measurements: 'stocktake_measurements' };
const mac = (v: unknown) =>
  createHmac('sha256', localConfig.encryptionKey).update(wmsLotsHash(v)).digest('hex');
const identity = (a: Actor, e: Engine, id: string) => ({
  tenant: a.tenantId,
  actor: a.userId,
  source: a.source ?? 'manual',
  engine: e,
  stocktake: id,
});
const bounded = (v: unknown, n: number = L.response_bytes) =>
  ensure(Buffer.byteLength(JSON.stringify(v)) <= n, 413, 'Dowód skanu przekracza limit bajtów');
const measurementKey = (a: Actor, e: Engine, kind: string, key: string) => {
  const hex = createHash('sha256')
    .update(JSON.stringify(['stocktake-scan-count', a.tenantId, e, kind, key]))
    .digest('hex')
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
};
export async function stocktakeScansAvailable(c: PoolClient) {
  return Boolean(
    (await c.query("SELECT to_regclass('public.stocktake_scan_receipts') IS NOT NULL available"))
      .rows[0].available,
  );
}
async function available(c: PoolClient) {
  ensure(await stocktakeScansAvailable(c), 503, 'Kopia nie zawiera skanowania spisów');
}
async function catalog(c: PoolClient, a: Actor) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + a.tenantId,
  ]);
}
async function header(c: PoolClient, e: Engine, id: string, write = false): Promise<Row> {
  const h = (
    await c.query(`SELECT * FROM ${names(e).heads} WHERE id=$1 ${write ? 'FOR UPDATE' : ''}`, [id])
  ).rows[0];
  ensure(h, 404, 'Nie znaleziono spisu');
  return h;
}
async function currentRole(c: PoolClient, a: Actor, pin = false) {
  const role = (await c.query('SELECT wms_current_role($1,$2) role', [a.userId, pin])).rows[0].role;
  ensure(role, 403, 'Brak bieżącego dostępu do firmy');
  return role as string;
}
async function final(c: PoolClient, a: Actor, write = false) {
  return wmsLotsAssertActorInTx(c, a, write);
}
async function flags(c: PoolClient, a: Actor, e: Engine, h: Row, role: string) {
  const policy = await wmsLotsPolicyInTx(c);
  const enabled =
    e === 'wms' ? policy.enabled && policy.version === h.policy_version : !policy.enabled;
  return {
    current_role: role,
    engine: e,
    can_resolve: true,
    can_scan: ['admin', 'operator'].includes(role) && h.state === 'counting' && enabled,
    can_replay: ['admin', 'operator'].includes(role),
    stocktake: {
      id: h.id,
      state: h.state,
      version: h.version,
      warehouse_id: h.warehouse_id,
      blind: h.blind,
    },
  };
}
function encodeCursor(bind: unknown, key: unknown) {
  const p = { bind: wmsLotsHash(bind), key };
  return Buffer.from(JSON.stringify({ ...p, signature: mac(p) })).toString('base64url');
}
function cursor(raw: string | undefined, bind: unknown) {
  if (!raw) return null;
  let p: Row;
  try {
    p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    ensure(false, 422, 'Nieprawidłowy kursor');
  }
  ensure(
    p! && p!.signature === mac({ bind: p!.bind, key: p!.key }),
    422,
    'Kursor nie należy do bieżącej projekcji',
  );
  ensure(
    p!.bind === wmsLotsHash(bind),
    409,
    'Zakres lub projekcja kursora zmieniły się; odczytaj ponownie',
  );
  return p!.key;
}
/** Exact scoped matches, including EAN/SKU collisions; no identity preference. */
async function matches(c: PoolClient, e: Engine, id: string, code: string, location: string) {
  const rows = (
    await c.query(
      `SELECT l.id,l.product_id,l.sku,l.name,l.location,l.version,l.counted,p.sku current_sku,p.ean current_ean,p.version product_version,
 ${e === 'wms' ? 'l.lot' : 'NULL::jsonb'} lot,
 array_remove(ARRAY[CASE WHEN l.sku=$2 THEN 'frozen_sku' END,CASE WHEN p.sku=$2 THEN 'current_sku' END,CASE WHEN EXISTS(SELECT 1 FROM product_sku_aliases x WHERE (x.tenant_id,x.product_id,x.sku)=(p.tenant_id,p.id,$2)) THEN 'sku_alias' END,CASE WHEN p.ean<>'' AND p.ean=$2 THEN 'current_ean' END],NULL) matched_by
 FROM ${names(e).lines} l JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id)
 WHERE l.stocktake_id=$1 AND l.location=$3 AND (l.sku=$2 OR p.sku=$2 OR p.ean=$2 OR EXISTS(SELECT 1 FROM product_sku_aliases x WHERE (x.tenant_id,x.product_id,x.sku)=(p.tenant_id,p.id,$2))) ORDER BY l.id`,
      [id, code, location],
    )
  ).rows;
  ensure(rows.length <= (e === 'wms' ? 10000 : 2000), 413, 'Zakres skanu przekracza limit spisu');
  const products = new Map(
    rows.map((r) => [
      r.product_id,
      { id: r.product_id, version: r.product_version, sku: r.current_sku, ean: r.current_ean },
    ]),
  );
  return {
    rows,
    product_hash: wmsLotsHash([...products.values()].sort((a, b) => a.id.localeCompare(b.id))),
  };
}
async function prepared(
  c: PoolClient,
  a: Actor,
  e: Engine,
  id: string,
  ids: string[],
  write = false,
): Promise<{ header: Row; lines: Row[]; entries: Map<string, Row> }> {
  if (e === 'wms') return wmsStocktakeScanBasisInTx(c, a, id, ids, write);
  const r = await quantityStocktakeScanBasisInTx(c, a, id, ids, write);
  return {
    ...r,
    entries: new Map(
      r.lines.map((l) => {
        const basis = r.entries.get(l.id)!.basis;
        return [
          l.id,
          {
            basis,
            basis_token: mac({ ...identity(a, e, id), line: l.id, version: l.version, basis }),
            needs_recount: l.counted !== null && l.basis_version !== l.current_stock_version,
          },
        ];
      }),
    ),
  };
}
async function generation(c: PoolClient, e: Engine, h: Row, l: Row, basisHash: string) {
  const r = (
    await c.query(
      'SELECT * FROM stocktake_scan_receipts WHERE engine=$1 AND stocktake_id=$2 AND line_id=$3 ORDER BY after_line_version DESC LIMIT 1',
      [e, h.id, l.id],
    )
  ).rows[0];
  if (
    !r ||
    r.after_line_version !== l.version ||
    r.counted !== l.counted ||
    r.basis_hash !== basisHash ||
    (e === 'wms' && r.measurement_id !== l.latest_measurement_id)
  )
    return null;
  // Count measurements account for every intervening header version. Review/reopen leave a gap,
  // including legacy OFF transitions which have no separate command receipt.
  const gap = BigInt(h.version) - BigInt(r.stocktake_version);
  if (gap < 0n) return null;
  if (gap) {
    const n = (
      await c.query(
        `SELECT count(DISTINCT result->>'version')::text n FROM ${names(e).measurements} WHERE stocktake_id=$1 ${e === 'wms' ? "AND kind='count'" : ''} AND CASE WHEN result->>'version' ~ '^[1-9][0-9]{0,18}$' THEN (result->>'version')::numeric>$2::numeric AND (result->>'version')::numeric<=$3::numeric ELSE false END`,
        [h.id, r.stocktake_version, h.version],
      )
    ).rows[0].n;
    if (BigInt(n) !== gap) return null;
  }
  if (
    e === 'wms' &&
    (
      await c.query(
        "SELECT 1 FROM wms_stocktake_measurements WHERE stocktake_id=$1 AND kind='reopen' AND (result->>'version')::numeric>$2::numeric LIMIT 1",
        [h.id, r.stocktake_version],
      )
    ).rowCount
  )
    return null;
  if (e === 'quantity') {
    const newer = (
      await c.query(
        `SELECT 1 FROM stocktake_measurements m WHERE m.stocktake_id=$1 AND m.id<>$2 AND (m.created_at,m.id)>($3::timestamptz,$2::uuid) AND EXISTS(SELECT 1 FROM jsonb_array_elements(m.inputs) x WHERE x->>'id'=$4) LIMIT 1`,
        [h.id, r.measurement_id, r.source_snapshot.measurement_created_at, l.id],
      )
    ).rowCount;
    if (newer) return null;
  }
  return r;
}
function resolution(
  a: Actor,
  e: Engine,
  h: Row,
  l: Row,
  basis: unknown,
  code: string,
  productHash: string,
  g: string | null,
  expires: string,
) {
  return mac({
    ...identity(a, e, h.id),
    line: l.id,
    version: l.version,
    code,
    location: l.location,
    generation: g,
    product_id: l.product_id,
    product_version: l.product_version,
    candidates: productHash,
    basis,
    expires_at: expires,
  });
}
async function candidate(
  c: PoolClient,
  a: Actor,
  e: Engine,
  h: Row,
  l: Row,
  entry: Row,
  code: string,
  productHash: string,
) {
  const bh = wmsLotsHash(entry.basis),
    r = await generation(c, e, h, l, bh),
    expires = new Date(Date.now() + L.token_ttl_seconds * 1000).toISOString();
  const g = r?.generation_id ?? null;
  return {
    line_id: l.id,
    product_id: l.product_id,
    sku: l.sku,
    name: l.name,
    current_sku: l.current_sku,
    current_ean: l.current_ean,
    location: l.location,
    lot: l.lot ?? null,
    matched_by: l.matched_by,
    line_version: l.version,
    counted: l.counted,
    needs_recount: entry.needs_recount || Boolean(entry.basis.scope_changed),
    generation_id: g,
    can_continue: h.state === 'counting' && g !== null,
    basis_token: entry.basis_token,
    resolution_token: resolution(a, e, h, l, entry.basis, code, productHash, g, expires),
    expires_at: expires,
  };
}
async function freshLine(
  c: PoolClient,
  a: Actor,
  e: Engine,
  h: Row,
  b: { line_id: string; code: string; location: string },
) {
  const m = await matches(c, e, h.id, b.code, b.location),
    l = m.rows.find((r) => r.id === b.line_id);
  if (!l || h.state !== 'counting') return null;
  const p = await prepared(c, a, e, h.id, [l.id]);
  return candidate(
    c,
    a,
    e,
    p.header,
    { ...l, ...p.lines[0] },
    p.entries.get(l.id)!,
    b.code,
    m.product_hash,
  );
}
export async function stocktakeScanMetadata(a: Actor, e: Engine, id: string) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      const h = await header(c, e, id);
      if (!(await stocktakeScansAvailable(c)))
        return {
          available: false,
          can_resolve: false,
          can_scan: false,
          can_replay: false,
          engine: e,
          limits: L,
          stocktake: {
            id: h.id,
            state: h.state,
            version: h.version,
            warehouse_id: h.warehouse_id,
            blind: h.blind,
          },
        };
      const role = await final(c, a);
      return { ...(await flags(c, a, e, h, role)), limits: L, available: true };
    },
    { wmsAdmission: 'read' },
  );
}
export async function stocktakeScanCandidates(a: Actor, e: Engine, id: string, raw: unknown) {
  const q = S.stocktakeScanCandidatesQuery.parse(raw);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      await catalog(c, a);
      const h = await header(c, e, id),
        earlyRole = await currentRole(c, a);
      const m = await matches(c, e, id, q.code, q.location),
        bind = {
          ...identity(a, e, id),
          kind: 'candidates',
          candidates: m.product_hash,
          matched_lines: wmsLotsHash(m.rows.map((r) => r.id)),
          role: earlyRole,
          blind: h.blind,
          code: q.code,
          location: q.location,
        };
      const after = cursor(q.cursor, bind);
      ensure(!after || typeof after.id === 'string', 422, 'Nieprawidłowy kursor');
      const ordered = m.rows.filter((r) => !after || r.id > after.id),
        selected = ordered.slice(0, q.limit);
      const p = selected.length
        ? await prepared(
            c,
            a,
            e,
            id,
            selected.map((r) => r.id),
          )
        : null;
      const data = [];
      for (const l of selected)
        data.push(
          await candidate(
            c,
            a,
            e,
            h,
            { ...l, ...p!.lines.find((r) => r.id === l.id) },
            p!.entries.get(l.id)!,
            q.code,
            m.product_hash,
          ),
        );
      const afterWait = await matches(c, e, id, q.code, q.location);
      ensure(
        afterWait.product_hash === m.product_hash &&
          afterWait.rows.map((r) => r.id).join(',') === m.rows.map((r) => r.id).join(','),
        409,
        'Katalog zmienił dopasowanie; odczytaj ponownie',
      );
      const role = await final(c, a);
      ensure(role === earlyRole, 409, 'Uprawnienia zmieniły projekcję; odczytaj ponownie');
      const result = {
        data,
        meta: {
          total: m.rows.length,
          cursor:
            ordered.length > selected.length
              ? encodeCursor(bind, { id: selected.at(-1)!.id })
              : null,
        },
        ...(await flags(c, a, e, h, role)),
      };
      bounded(result);
      return result;
    },
    { wmsAdmission: 'read' },
  );
}
const budget = stocktakeScanBudgetInTx;
async function mutate(a: Actor, e: Engine, id: string, kind: 'start' | 'increment', raw: unknown) {
  bounded(raw, L.request_bytes);
  const b =
    kind === 'start'
      ? S.stocktakeScanStartInput.parse(raw)
      : S.stocktakeScanIncrementInput.parse(raw);
  const hash = wmsLotsHash({ ...identity(a, e, id), kind, request: b });
  return tenantTx(a.tenantId, async (c) => {
    await available(c);
    // New receipt quotas must serialize without acquiring an admission after stock/header locks.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'stocktake-scans:' + a.tenantId,
    ]);
    await catalog(c, a);
    const mk = measurementKey(a, e, kind, b.client_key);
    if (e === 'quantity')
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'stocktake-measure:' + a.tenantId + ':' + mk,
      ]);
    const h = await header(c, e, id, true);
    const old = (
      await c.query('SELECT * FROM stocktake_scan_receipts WHERE client_key=$1', [b.client_key])
    ).rows[0];
    if (old) {
      ensure(
        old.request_hash === hash &&
          old.actor_id === a.userId &&
          old.engine === e &&
          old.stocktake_id === id,
        409,
        'Klucz skanu ma inny zakres',
      );
      // Replay deliberately avoids fresh physical/token fences; the immutable receipt survives later mutations.
      const current_line = null,
        role = await final(c, a, true);
      return { scan: old.result, reused: true, current_line, ...(await flags(c, a, e, h, role)) };
    }
    const probe = await currentRole(c, a);
    ensure(['admin', 'operator'].includes(probe), 403, 'Liczenie wymaga operatora');
    ensure(h.state === 'counting', 409, 'Spis nie jest w fazie liczenia');
    const policy = await wmsLotsPolicyInTx(c);
    ensure(
      e === 'wms' ? policy.enabled && policy.version === h.policy_version : !policy.enabled,
      409,
      'Spis nie odpowiada bieżącej polityce WMS',
    );
    enlistWmsActorInTx(c, a);
    // Lock every frozen scope product in UUID order before stock/FK writes. This fences a
    // second EAN claimant as well as the chosen product; existing count order remains header→product→stock.
    await c.query(
      `SELECT p.id FROM products p WHERE EXISTS(SELECT 1 FROM ${names(e).lines} l WHERE l.stocktake_id=$1 AND (l.tenant_id,l.product_id)=(p.tenant_id,p.id)) ORDER BY p.id FOR SHARE`,
      [id],
    );
    const m = await matches(c, e, id, b.code, b.location);
    const match = m.rows.find((l) => l.id === b.line_id);
    ensure(match, 422, 'Kod i bin nie wskazują pozycji spisu');
    const p = await prepared(c, a, e, id, [b.line_id], true),
      l = { ...match, ...p.lines[0] },
      entry = p.entries.get(l.id)!;
    // Re-read the exact catalogue candidate set AFTER the potentially blocking product/stock locks.
    const lockedMatches = await matches(c, e, id, b.code, b.location),
      locked = lockedMatches.rows.find((r) => r.id === b.line_id);
    ensure(locked, 409, 'Kod produktu zmienił się');
    Object.assign(l, {
      current_sku: locked.current_sku,
      current_ean: locked.current_ean,
      product_version: locked.product_version,
      matched_by: locked.matched_by,
    });
    const prior = await generation(c, e, h, l, wmsLotsHash(entry.basis));
    ensure(!entry.basis.scope_changed, 409, 'scope_changed: utwórz nowy spis');
    ensure(
      l.version === b.version && entry.basis_token === b.basis_token,
      409,
      'Pozycja lub fizyczna podstawa zmieniła się; przelicz ponownie',
    );
    const expires = Date.parse(b.expires_at);
    ensure(
      expires > Date.now() && expires <= Date.now() + L.token_ttl_seconds * 1000 + 1000,
      409,
      'Token rozpoznania wygasł',
    );
    ensure(
      b.resolution_token ===
        resolution(
          a,
          e,
          h,
          l,
          entry.basis,
          b.code,
          lockedMatches.product_hash,
          prior?.generation_id ?? null,
          b.expires_at,
        ),
      409,
      'Kod, kandydaci lub token rozpoznania zmienili się',
    );
    const sid = randomUUID(),
      previous = l.counted as number | null;
    let counted: number, gid: string;
    if (kind === 'start') {
      const start = b as S.StocktakeScanStartInput;
      ensure(
        previous === null || start.confirmed_reset,
        409,
        'Ponowne liczenie wymaga zgody na reset',
      );
      counted = 0;
      gid = sid;
    } else {
      const inc = b as S.StocktakeScanIncrementInput;
      ensure(
        prior && inc.generation_id === prior.generation_id,
        409,
        'scan_start_required: rozpocznij jawnie od zera',
      );
      ensure(
        previous !== null && previous < (e === 'wms' ? 2147483647 : 1000000),
        422,
        'Licznik osiągnął limit',
      );
      counted = previous + 1;
      gid = inc.generation_id;
    }
    const note = kind === 'start' ? (b as S.StocktakeScanStartInput).note : 'Fizyczny skan +1';
    const applied =
      e === 'wms'
        ? await applyWmsStocktakeScanCountInTx(
            c,
            a,
            p as Awaited<ReturnType<typeof wmsStocktakeScanBasisInTx>>,
            { client_key: mk, quantity: counted, note },
          )
        : await applyQuantityStocktakeScanCountInTx(
            c,
            a,
            p as Awaited<ReturnType<typeof quantityStocktakeScanBasisInTx>>,
            { client_key: mk, quantity: counted, note, basis_hash: wmsLotsHash(entry.basis) },
          );
    const measurement = (
      await c.query(`SELECT created_at::text stamp FROM ${names(e).measurements} WHERE id=$1`, [
        applied.measurement_id,
      ])
    ).rows[0];
    const created = new Date().toISOString();
    const result = {
      id: sid,
      stocktake_id: id,
      engine: e,
      line_id: l.id,
      product_id: l.product_id,
      location: l.location,
      lot: l.lot ?? null,
      kind,
      generation_id: gid,
      code: b.code,
      matched_by: l.matched_by,
      previous_count: previous,
      counted,
      increment: kind === 'start' ? 0 : 1,
      before_line_version: l.version,
      after_line_version: applied.after_line_version,
      measurement_id: applied.measurement_id,
      stocktake_version: applied.stocktake_version,
      created_at: created,
    };
    const source = {
      product_id: l.product_id,
      product_version: l.product_version,
      current_sku: l.current_sku,
      current_ean: l.current_ean,
      measurement_client_key: mk,
      measurement_created_at: measurement.stamp,
      candidate_hash: lockedMatches.product_hash,
    };
    bounded({ request: b, result, source }, L.request_bytes);
    await c.query(
      `INSERT INTO stocktake_scan_receipts(id,tenant_id,engine,wms_stocktake_id,wms_line_id,wms_measurement_id,quantity_stocktake_id,quantity_line_id,quantity_measurement_id,product_id,location,lot_id,lot_snapshot,actor_id,source,client_key,request_hash,request,kind,generation_id,prior_scan_id,code,source_snapshot,matched_by,basis_hash,previous_count,counted,before_line_version,after_line_version,stocktake_version,result,created_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`,
      [
        sid,
        a.tenantId,
        e,
        e === 'wms' ? id : null,
        e === 'wms' ? l.id : null,
        e === 'wms' ? applied.measurement_id : null,
        e === 'quantity' ? id : null,
        e === 'quantity' ? l.id : null,
        e === 'quantity' ? applied.measurement_id : null,
        l.product_id,
        l.location,
        l.lot_id ?? null,
        e === 'wms' ? JSON.stringify(l.lot) : null,
        a.userId,
        a.source ?? 'manual',
        b.client_key,
        hash,
        JSON.stringify(b),
        kind,
        gid,
        kind === 'increment' ? prior!.id : null,
        b.code,
        JSON.stringify(source),
        JSON.stringify(l.matched_by),
        wmsLotsHash(entry.basis),
        previous,
        counted,
        l.version,
        applied.after_line_version,
        applied.stocktake_version,
        JSON.stringify(result),
        created,
      ],
    );
    await audit(c, a, 'stocktake.scan.' + kind, sid, {
      engine: e,
      stocktake_id: id,
      line_id: l.id,
    });
    await budget(c, e, id);
    const updated = await header(c, e, id),
      current_line = await freshLine(c, a, e, updated, b);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const role = await final(c, a, true);
    const response = {
      scan: result,
      reused: false,
      current_line,
      ...(await flags(c, a, e, updated, role)),
    };
    bounded(response);
    return response;
  }, { wmsAdmission: 'serial' }); // stocktake counting stays a tenant-wide WMS procedure (250)
}
export const startStocktakeScan = (a: Actor, e: Engine, id: string, b: unknown) =>
  mutate(a, e, id, 'start', b);
export const incrementStocktakeScan = (a: Actor, e: Engine, id: string, b: unknown) =>
  mutate(a, e, id, 'increment', b);
export async function stocktakeScanHistory(a: Actor, e: Engine, id: string, raw: unknown) {
  const q = S.stocktakeScanHistoryQuery.parse(raw);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const h = await header(c, e, id),
        role = await final(c, a),
        bind = {
          ...identity(a, e, id),
          kind: 'history',
          role,
          blind: h.blind,
          line_id: q.line_id ?? null,
        };
      const key = cursor(q.cursor, bind);
      ensure(
        !key || (typeof key.stamp === 'string' && typeof key.id === 'string'),
        422,
        'Nieprawidłowy kursor',
      );
      const rows = (
        await c.query(
          `SELECT result,id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') stamp FROM stocktake_scan_receipts WHERE engine=$1 AND stocktake_id=$2 AND ($3::uuid IS NULL OR line_id=$3) AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6`,
          [e, id, q.line_id ?? null, key?.stamp ?? null, key?.id ?? null, q.limit + 1],
        )
      ).rows;
      const data = rows.slice(0, q.limit),
        total = (
          await c.query(
            'SELECT count(*)::int n FROM stocktake_scan_receipts WHERE engine=$1 AND stocktake_id=$2 AND ($3::uuid IS NULL OR line_id=$3)',
            [e, id, q.line_id ?? null],
          )
        ).rows[0].n;
      const result = {
        data: data.map((r) => r.result),
        meta: {
          total,
          cursor:
            rows.length > data.length
              ? encodeCursor(bind, { stamp: data.at(-1)!.stamp, id: data.at(-1)!.id })
              : null,
        },
        ...(await flags(c, a, e, h, role)),
      };
      bounded(result);
      return result;
    },
    { wmsAdmission: 'read' },
  );
}
export async function stocktakeScanDetail(a: Actor, e: Engine, id: string, scanId: string) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const h = await header(c, e, id);
      const r = (
        await c.query(
          'SELECT result FROM stocktake_scan_receipts WHERE engine=$1 AND stocktake_id=$2 AND id=$3',
          [e, id, scanId],
        )
      ).rows[0];
      ensure(r, 404, 'Nie znaleziono skanu');
      const role = await final(c, a);
      return { scan: r.result, ...(await flags(c, a, e, h, role)) };
    },
    { wmsAdmission: 'read' },
  );
}
