import { drainPublicConstraintsInTx } from './public-constraint-drain';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool, localConfig } from './db';
import { ensure, Problem } from './errors';
import * as V from './warehouse-wz-issued-schema';
import { refreshWzIssuerVerdict, scheduleWzIssuerRefresh } from './wz-issuer273-refresh';

const tables = ['admissions','receipts','counters','documents','rows','manifest'].map(n => 'warehouse_wz_issuer_' + n);
const incomplete = () => new Problem(503, 'Niekompletny wystawca dokumentów WZ');
// 273: a verdict miss cut by the request statement budget (57014) records nothing, so every later request would miss as
// well; one background refresh per process, with the cold budget, records the full guard's true for the next request.
const refreshAfterTimeout=(e:unknown):never=>{if(typeof e==='object'&&e!==null&&(e as {code?:unknown}).code==='57014')void scheduleWzIssuerRefresh(pool);throw e;};
export async function issuedWzAvailable(c: Pool | PoolClient = pool): Promise<boolean> {
  const p = (await c.query(`SELECT to_regprocedure('public.warehouse_wz_issuer_installed()') marker,
    to_regprocedure('public.warehouse_wz_issuer_guards()') guards,
    to_regprocedure('public.wz_issuer239_verdict()') verdict,
    to_regprocedure('public.wz_issuer273_refresh()') refresh,
    EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]))
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'warehouse_wz_issuer_%') partial,
    to_regclass('public.migrations') ledger`, [tables])).rows[0];
  const installed = p.ledger && (await c.query("SELECT EXISTS(SELECT 1 FROM migrations WHERE name='151_warehouse_wz_issuer') installed")).rows[0].installed;
  if (!p.marker) { if (p.partial || installed) throw incomplete(); return false; }
  if (!p.guards || !installed) throw incomplete();
  try {
    // 239: inside a transaction the same verdict, reused while the cold-approved schema and its sealed basis
    // are unchanged; the Pool (startup, outside any transaction) keeps the full guard.
    const sql = p.verdict && 'release' in c ? 'SELECT public.wz_issuer239_verdict() ok' : 'SELECT public.warehouse_wz_issuer_guards() ok';
    // 273: at startup (the Pool) this process's cold approval has just made the record stale. The refresh asks the same
    // verdict (a miss: the full guard, as before) in its own transaction and records its true, so the first requests
    // hit. No answer (another process refreshes, or an error, logged): the full guard as before.
    const ok = p.refresh && !('release' in c) ? await refreshWzIssuerVerdict(c).catch((e: unknown) => {
      console.error(JSON.stringify({ level: 'error', step: 'wz_issuer273.startup_refresh', code: (e as { code?: unknown } | null)?.code ?? null }));
      return null;
    }) : null;
    ensure(ok ?? (await c.query(sql).catch(refreshAfterTimeout)).rows[0].ok, 503, incomplete().message);
    return true;
  } catch (e: any) { if (['42P01','42703','42883','55000'].includes(e.code)) throw incomplete(); throw e; }
}

async function access(c: PoolClient, a: V.IssuedWzActor, pin: boolean) {
  const role = (await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2' + (pin ? ' FOR SHARE' : ''),
    [a.tenantId, a.userId])).rows[0]?.role;
  ensure(['admin','operator','viewer'].includes(role), 403, 'Brak bieżącego dostępu do dokumentów WZ');
  let value = role === 'admin';
  if (a.apiKeyId) {
    const key = (await c.query('SELECT user_id,scopes,revoked_at,expires_at FROM api_keys WHERE tenant_id=$1 AND id=$2' + (pin ? ' FOR SHARE' : ''),
      [a.tenantId, a.apiKeyId])).rows[0];
    ensure(key && key.user_id === a.userId && !key.revoked_at, 401, 'Klucz API został cofnięty lub wygasł');
    ensure((await c.query('SELECT $1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp() alive', [key.expires_at])).rows[0].alive,
      401, 'Klucz API został cofnięty lub wygasł');
    ensure(key.scopes.includes('inventory:read'), 403, 'Brak odczytu dokumentów magazynowych');
    value = value && key.scopes.includes('purchasing:read');
  }
  return { current_role: role as V.IssuedWzActor['role'], can_read: true, can_read_value: value };
}
/** Freeze immutable data in RR, then check fresh IAM in a separate RC transaction.
 * No response is acknowledged until current membership and key locks are held. */
async function read<T extends object, U extends object = T>(a: V.IssuedWzActor, context: { readOnly?: boolean },
  body: (c: PoolClient, available: boolean, grant: Awaited<ReturnType<typeof access>>) => Promise<T>, project: (data: T, value: boolean, grant: Awaited<ReturnType<typeof access>>) => U = data => data as unknown as U,
) {
  V.issuedWzUuid.parse(a.tenantId); V.issuedWzUuid.parse(a.userId); if (a.apiKeyId) V.issuedWzUuid.parse(a.apiKeyId);
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query('RESET ROLE');
    await c.query("SET LOCAL TimeZone='UTC'"); await c.query("SET LOCAL statement_timeout='8s'");
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    const earlyGrant = await access(c, a, false); const available = await issuedWzAvailable(c);
    const data = await body(c, available, earlyGrant); await c.query('COMMIT');
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    await c.query("SET LOCAL statement_timeout='8s'");
    ensure(await issuedWzAvailable(c) === available, 503, incomplete().message);
    await drainPublicConstraintsInTx(c);
    const flags = await access(c, a, true);
    const result = { ...project(data, flags.can_read_value, flags), ...flags, available, read_only: !!context.readOnly };
    ensure(Buffer.byteLength(JSON.stringify(result)) <= V.WZ_ISSUED_LIMITS.file_bytes, 413, 'Pełny odczyt WZ przekracza limit odpowiedzi');
    await c.query('COMMIT'); return result;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

function header(payload: any, value: boolean): V.IssuedWzHeader {
  const p = structuredClone(payload);
  ensure(p && p.kind === 'WZ' && p.row_count > 0 && p.row_count <= V.WZ_ISSUED_LIMITS.rows, 503, incomplete().message);
  const available = value && typeof p.summary?.known_value_minor === 'string';
  if (!available) p.summary = { physical_quantity: p.summary.physical_quantity };
  if (!value) p.commercial_lines = p.commercial_lines.map((line: Record<string, unknown>) => {
    const { line_total, vat, currency, ...quantityOnly } = line;
    return quantityOnly;
  });
  return { ...p, value_available: available };
}
function rowProjection(row: V.IssuedWzRow, value: boolean): V.IssuedWzRow {
  const r = { ...row };
  if (!value) { delete r.unit_cost_minor; delete r.value_minor; delete r.currency; delete r.exponent; }
  return r;
}
function detailProjection(d: V.IssuedWzDetail, value: boolean): V.IssuedWzDetail {
  const document = header(d.document, value);
  return { ...d, document, rows: d.rows.map(r => rowProjection(r, document.value_available)) };
}
export function issuedWzOptions(a: V.IssuedWzActor, context: { readOnly?: boolean } = {}) {
  return read(a, context, async (c, available) => {
    const warehouses = available ? (await c.query('SELECT id,name,code FROM warehouses WHERE tenant_id=$1 ORDER BY name COLLATE "C",id LIMIT 201', [a.tenantId])).rows : [];
    ensure(warehouses.length <= 200, 413, 'Lista magazynów WZ przekracza limit panelu');
    return { warehouses, limits: V.WZ_ISSUED_LIMITS };
  });
}
const cursorBody = z.strictObject({ id: V.issuedWzUuid, warehouse_id: V.issuedWzUuid.nullable(), order_id: V.issuedWzUuid.nullable(),
  tenant_id: V.issuedWzUuid, user_id: V.issuedWzUuid, api_key_id: V.issuedWzUuid.nullable(), role: z.enum(['admin','operator','viewer']),
  value: z.boolean(), read_only: z.boolean(), limit: z.number().int().min(1).max(50) });
function encodeCursor(data: z.infer<typeof cursorBody>) {
  const payload = JSON.stringify(data);
  const signature = createHmac('sha256', localConfig.encryptionKey).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ payload, signature })).toString('base64url');
}
function decodeCursor(token: string) {
  try {
    const envelope = z.strictObject({ payload: z.string().max(800), signature: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    const expected = createHmac('sha256', localConfig.encryptionKey).update(envelope.payload).digest();
    ensure(timingSafeEqual(expected, Buffer.from(envelope.signature, 'hex')), 422, 'Niepoprawny kursor dokumentów WZ');
    return cursorBody.parse(JSON.parse(envelope.payload));
  } catch { throw new Problem(422, 'Niepoprawny kursor dokumentów WZ'); }
}
export function issuedWzList(a: V.IssuedWzActor, input: unknown, context: { readOnly?: boolean } = {}) {
  const q = V.issuedWzQuery.parse(input);
  const scope = { warehouse_id: q.warehouse_id ?? null, order_id: q.order_id ?? null };
  const parsed = q.cursor ? decodeCursor(q.cursor) : null;
  const cursor = parsed?.id ?? null;
  return read(a, context, async (c, available, grant) => {
    ensure(available, 503, 'Kopia nie zawiera wystawcy WZ');
    const binding = { ...scope, tenant_id: a.tenantId, user_id: a.userId, api_key_id: a.apiKeyId ?? null,
      role: grant.current_role, value: grant.can_read_value, read_only: !!context.readOnly, limit: q.limit };
    if (parsed) ensure(Object.entries(binding).every(([k,v]) => parsed[k as keyof typeof parsed] === v),
      422, 'Kursor pochodzi z innego aktora, dostępu, filtra lub kopii');
    if (scope.warehouse_id) ensure((await c.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2', [a.tenantId, scope.warehouse_id])).rowCount, 404, 'Nie znaleziono własnego magazynu');
    if (scope.order_id) ensure((await c.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2', [a.tenantId, scope.order_id])).rowCount, 404, 'Nie znaleziono własnego zamówienia');
    const params = [a.tenantId, scope.warehouse_id, scope.order_id, cursor];
    const filter = 'tenant_id=$1 AND($2::uuid IS NULL OR warehouse_id=$2) AND($3::uuid IS NULL OR payload->\'source\'->>\'order_id\'=$3::text)';
    if (cursor) ensure((await c.query('SELECT id FROM warehouse_wz_issuer_documents WHERE ' + filter + ' AND id=$4', params)).rowCount, 404, 'Kursor nie należy do własnych dokumentów');
    const found = (await c.query(`SELECT id,payload FROM warehouse_wz_issuer_documents WHERE ${filter}
      AND($4::uuid IS NULL OR(created_at,id)<(SELECT created_at,id FROM warehouse_wz_issuer_documents WHERE tenant_id=$1 AND id=$4))
      ORDER BY created_at DESC,id DESC LIMIT $5`, [...params, q.limit + 1])).rows;
    const data = found.slice(0, q.limit).map(r => header(r.payload, true));
    return { data, meta: { cursor: found.length > q.limit ? encodeCursor({ id: data.at(-1)!.id, ...binding }) : null, limit: q.limit } };
  }, (r, value, grant) => ({ ...r, data: r.data.map(d => header(d, value)),
    meta: { ...r.meta, cursor: r.meta.cursor ? encodeCursor({ ...decodeCursor(r.meta.cursor),
      role: grant.current_role, value: grant.can_read_value }) : null } }));
}
async function frozenDetail(c: PoolClient, tenant: string, id: string): Promise<V.IssuedWzDetail> {
  const found = (await c.query('SELECT payload FROM warehouse_wz_issuer_documents WHERE tenant_id=$1 AND id=$2', [tenant, id])).rows[0];
  ensure(found, 404, 'Nie znaleziono własnego dokumentu WZ');
  const document = header(found.payload, true);
  if (document.commercial_lines.some(line => line.lineage_kind === 'physical_item_components_v1')) {
    ensure((await c.query("SELECT to_regprocedure('public.parcel_physical_wz_validate_admission(uuid,boolean)') helper")).rows[0].helper,503,incomplete().message);
    // Owner RR READ ONLY: verify the immutable approved map, actual historical
    // dispatch movements and full typed line source without acquiring row locks.
    await c.query('SELECT parcel_physical_wz_validate_admission($1,true)',[document.receipt_id]);
  }
  const stored = (await c.query('SELECT ordinal,payload FROM warehouse_wz_issuer_rows WHERE tenant_id=$1 AND document_id=$2 ORDER BY ordinal LIMIT 10001', [tenant, id])).rows;
  ensure(stored.length === document.row_count && stored.every((r, i) => r.ordinal === i), 503, incomplete().message);
  const rows = stored.map(r => ({ ...r.payload, ordinal: r.ordinal })) as V.IssuedWzRow[];
  ensure(rows.reduce((n, r) => n + r.quantity, 0) === document.summary.physical_quantity, 503, incomplete().message);
  const snapshot_at = (await c.query("SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS snapshot_at")).rows[0].snapshot_at;
  return { document, rows, snapshot_at };
}
export function issuedWzDetail(a: V.IssuedWzActor, id: string, context: { readOnly?: boolean } = {}) {
  id = V.issuedWzUuid.parse(id);
  return read(a, context, async (c, available) => { ensure(available, 503, 'Kopia nie zawiera wystawcy WZ'); return frozenDetail(c, a.tenantId, id); }, detailProjection);
}

const xml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[c]!);
const csv = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
};
function exportBody(detail: V.IssuedWzDetail, format: 'csv'|'xml', values: boolean) {
  const d = detailProjection(detail, values && detail.document.value_available);
  const keys = ['ordinal','product_id','sku','name','quantity','location','stock_movement_id','location_movement_id',
    'operation_id','issue_fragment_id','layer_movement_id','layer_id','lot_id', ...(d.document.value_available ? ['unit_cost_minor','value_minor','currency','exponent'] : [])];
  const identity = ['number','id','receipt_id','series_id','year','sequence','warehouse_id','order_id','shipment_id',
    'source_kind','plan_id','parcel_index','dispatch_id','warehouse_name','warehouse_code','created_at','physical_quantity'];
  const identityValues = [d.document.number,d.document.id,d.document.receipt_id,d.document.series_id,d.document.year,d.document.sequence,
    d.document.warehouse.id,d.document.source.order_id,d.document.source.shipment_id,d.document.source.kind,
    'plan_id' in d.document.source ? d.document.source.plan_id : null,
    'parcel_index' in d.document.source ? d.document.source.parcel_index : null,
    'dispatch_id' in d.document.source ? d.document.source.dispatch_id : null,
    d.document.warehouse.name,d.document.warehouse.code,d.document.created_at,d.document.summary.physical_quantity];
  if (d.document.value_available) {
    identity.push('known_value_minor','unknown_quantity','currency','exponent');
    identityValues.push(d.document.summary.known_value_minor!, d.document.summary.unknown_quantity!,
      d.document.summary.currency!, d.document.summary.exponent!);
  }
  const commercial = JSON.stringify(d.document.commercial_lines);
  const content = format === 'csv' ? '\ufeff' + [[...identity, ...keys, 'commercial_lines_json'].map(csv).join(';'), ...d.rows.map((r, i) =>
    [...identityValues, ...keys.map(k => r[k as keyof V.IssuedWzRow]), i === 0 ? commercial : ''].map(csv).join(';'))].join('\r\n') + '\r\n' :
    '<?xml version="1.0" encoding="UTF-8"?>\n<wz>' + identity.map((k, i) => '<' + k + '>' + xml(identityValues[i]) + '</' + k + '>').join('') +
    '<commercial_lines_json>' + xml(commercial) + '</commercial_lines_json><rows>' + d.rows.map(r => '<row>' + keys.map(k => '<' + k + (r[k as keyof V.IssuedWzRow] === null ? ' unknown="true"' : '') + '>' + xml(r[k as keyof V.IssuedWzRow]) + '</' + k + '>').join('') + '</row>').join('') + '</rows></wz>\n';
  ensure(Buffer.byteLength(content) <= V.WZ_ISSUED_LIMITS.file_bytes, 413, 'Eksport WZ przekracza limit pliku');
  return { document: d.document, format, content, filename: `WZ-${d.document.id}.${format}`,
    content_type: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8',
    values_included: d.document.value_available, row_count: d.rows.length, snapshot_at: d.snapshot_at };
}
export function issuedWzExport(a: V.IssuedWzActor, id: string, input: unknown, context: { readOnly?: boolean } = {}) {
  id = V.issuedWzUuid.parse(id); const q = V.issuedWzExportQuery.parse(input);
  return read(a, context, async (c, available) => { ensure(available, 503, 'Kopia nie zawiera wystawcy WZ'); return frozenDetail(c, a.tenantId, id); },
    (d, value) => {
      ensure(!q.include_values || value, 403, 'Brak bieżącego dostępu do wyceny WZ');
      return exportBody(d, q.format, q.include_values && value);
    });
}
