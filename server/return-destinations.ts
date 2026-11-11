import { prepareReturnCompletionInTx, completeReturnCompletionInTx, replayReturnCompletionInTx, pinReturnCompletionInTx, type ReturnCompletion } from './return-completion';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool } from './db';
import { beginCatalogStockControlTransaction, endCatalogStockControlTransaction,
  catalogStockControlAdmissionInTx, finalizeCatalogStockControlActorsInTx, finalizeCatalogStockCountTerminalInTx } from './catalog-stock-control-transaction';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { getReturn } from './returns';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
import { lockParcelReturnOrderInTx } from './order-parcel-returns';
import { admitLocalReturnReceiveInTx } from './b2b-return-local-origins';
import { beginWmsTransaction, endWmsTransaction, wmsLotsAdmissionInTx,
  enlistWmsActorInTx, finalizeWmsActorsInTx } from './wms-lots-transaction';
import { beginPurchasingTransaction, endPurchasingTransaction, purchasingStockAdmissionInTx } from './purchasing-transaction';
import { deriveReturnDestinationPlan, type ReturnDestinationSource } from './return-destinations-plan';
import * as V from './return-destinations-schema';

type Row = Record<string, any>;
export type ReturnDestinationPlan = ReturnType<typeof deriveReturnDestinationPlan>;
export type ReturnDestinationsCoreInput = {
  version: number; note: string; shipping_refund: number; origin_id?: string;
  items: { item_id: string; accepted: number; restocked: number }[];
} | { version: number; decision: 'reject'; note: string };
export type ReturnDestinationAdmissionScope = {
  action: 'receive' | 'reject'; preview_id: string; wms_enabled: boolean; wms_policy_version: string;
  wms_operation_id: string; plan: ReturnDestinationPlan; receive_input: ReturnDestinationsCoreInput;
  /** Private independent138 allocator proof, never a public DTO. */
  parcel_payload?: Record<string, unknown> | null;
};
export type ReturnDestinationsCoreAdapter = (c: PoolClient, actor: V.ReturnDestinationsActor,
  returnId: string, input: ReturnDestinationsCoreInput, internal: {
    action: 'receive' | 'reject'; destinationAdmissionId: string;
    applyDestinationPhysical: () => Promise<void>; beforeFinish: () => Promise<void>;
    completion?: ReturnCompletion;
  }) => Promise<unknown>;
export type ReturnDestinationsContext = {
  readOnly?: boolean;
  /** Trusted integration only: absent until the genuine core and physical writer exist. */
  receiveCore?: ReturnDestinationsCoreAdapter;
  applyPhysical?: (c: PoolClient, actor: V.ReturnDestinationsActor, admissionId: string, returnId: string) => Promise<void>;
};
const tables = ['return_destination_parts', 'return_destination_arrivals',
  'return_destination_fragments', 'return_destination_admissions'];
const incomplete = 'Niekompletne przyjęcie zwrotu do magazynów';
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : value;
const pick = (value: Row, fields: string[]) => Object.fromEntries(fields.map(field => [field, value[field]]));

/** This bridge is restricted server infrastructure, not SQL-session actor hardening. */
async function owner<T>(c: PoolClient, actor: Pick<V.ReturnDestinationsActor, 'tenantId'>, fn: () => Promise<T>): Promise<T> {
  const context = (await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(context.owner === 'postgres' && context.tenant === actor.tenantId &&
    ['dyna_app', context.owner].includes(context.role), 403, 'Nieprawidłowy kontekst przyjęcia');
  const restore = context.role === 'dyna_app'; let failed = false;
  try { if (restore) await c.query('RESET ROLE'); return await fn(); }
  catch (error) { failed = true; throw error; }
  finally { if (restore) try { await c.query('SET LOCAL ROLE dyna_app'); } catch (error) { if (!failed) throw error; } }
}
async function availableOwner(c: Pool | PoolClient): Promise<boolean> {
  const probe = (await c.query(`SELECT to_regprocedure('public.return_destination_installed()') marker,
    EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[]))
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'return_destination_%' AND proname NOT LIKE 'return_destination_status_%') partial,
    to_regclass('public.migrations') ledger`, [tables])).rows[0];
  const ledger = probe.ledger && (await c.query("SELECT EXISTS(SELECT 1 FROM migrations WHERE name='148_return_destinations') installed")).rows[0].installed;
  if (!probe.marker) { ensure(!probe.partial && !ledger, 503, incomplete); return false; }
  try { ensure((await c.query('SELECT return_destination_installed() AND return_destination_guards() ok')).rows[0]?.ok, 503, incomplete); return true; }
  catch (error) { if (['42P01', '42703', '42883', '42704'].includes((error as { code?: string }).code ?? '')) throw new Problem(503, incomplete); throw error; }
}
export async function returnDestinationsAvailable(c: Pool | PoolClient = pool): Promise<boolean> {
  if (!('release' in c)) return availableOwner(c);
  const client = c as PoolClient;
  const tenant = (await client.query("SELECT current_setting('app.tenant_id',true) tenant")).rows[0].tenant;
  return owner(client, { tenantId: tenant }, () => availableOwner(client));
}
type Grant = { current_role: 'admin' | 'operator' | 'viewer'; can_read: boolean; can_write: boolean };
async function access(c: PoolClient, actor: V.ReturnDestinationsActor, writing: boolean, pin: boolean): Promise<Grant> {
  return owner(c, actor, async () => {
    const member = (await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2' + (pin ? ' FOR SHARE' : ''),
      [actor.tenantId, actor.userId])).rows[0];
    ensure(member && ['admin', 'operator', 'viewer'].includes(member.role), 403, 'Brak aktualnego uprawnienia przyjęcia');
    let scopes: string[] | null = null;
    if (actor.apiKeyId) {
      const key = (await c.query('SELECT user_id,scopes,revoked_at,expires_at FROM api_keys WHERE tenant_id=$1 AND id=$2' + (pin ? ' FOR SHARE' : ''),
        [actor.tenantId, actor.apiKeyId])).rows[0];
      ensure(key && key.user_id === actor.userId && !key.revoked_at &&
        (await c.query('SELECT $1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp() alive', [key.expires_at])).rows[0].alive,
      401, 'Klucz przyjęcia został cofnięty lub wygasł');
      scopes = key.scopes;
    }
    const canRead = !scopes || ['orders:read', 'inventory:read'].every(scope => scopes!.includes(scope));
    const canWrite = member.role !== 'viewer' && (!scopes || ['orders:write', 'inventory:write'].every(scope => scopes!.includes(scope)));
    ensure(canRead && (!writing || canWrite), 403, 'Brak aktualnego zakresu przyjęcia');
    return { current_role: member.role, can_read: true, can_write: canRead && canWrite };
  });
}
function flags(grant: Grant, ctx: ReturnDestinationsContext) {
  return { available: true, read_only: !!ctx.readOnly, ...grant,
    can_write: grant.can_write && !ctx.readOnly,
    intake_available: Boolean(ctx.receiveCore && ctx.applyPhysical), can_read_value: false as const };
}
function mapped(error: unknown): never {
  if (error instanceof Problem) throw error;
  const e = error as { code?: string; message?: string };
  if (e.code === '55000' || ['42P01', '42703', '42883'].includes(e.code ?? '')) throw new Problem(503, incomplete);
  if (e.code === '28000') throw new Problem(401, 'Klucz przyjęcia został cofnięty lub wygasł');
  if (e.code === '42501') throw new Problem(403, 'Brak aktualnego uprawnienia przyjęcia');
  if (e.code === 'P0002') throw new Problem(404, 'Nie znaleziono własnego przyjęcia lub sesji');
  if (e.code === '54000') throw new Problem(413, 'Limit dowodów przyjęcia');
  if (['23514', '23503', '23505'].includes(e.code ?? '')) throw new Problem(409, e.message ?? 'Zakres przyjęcia zmienił się');
  throw error;
}
/** Mutations precede flush; hydration and final fresh ACL/key lock precede COMMIT. */
async function tx(actor: V.ReturnDestinationsActor, writing: boolean, ctx: ReturnDestinationsContext,
  work: (c: PoolClient) => Promise<() => Promise<Row>>): Promise<Row> {
  ensure(!writing || !ctx.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
  V.returnDestinationsUuid.parse(actor.tenantId); ensure(actor.userId, 403, 'Przyjęcie wymaga operatora');
  V.returnDestinationsUuid.parse(actor.userId);
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED'); await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [actor.tenantId]);
    await c.query("SET LOCAL statement_timeout='8s'"); await c.query("SET LOCAL TimeZone='UTC'");
    beginWmsTransaction(c); beginPurchasingTransaction(c); beginCatalogStockControlTransaction(c);
    await wmsLotsAdmissionInTx(c, actor, writing ? 'shared' : 'read');
    await purchasingStockAdmissionInTx(c, actor);
    await catalogStockControlAdmissionInTx(c, actor);
    ensure(await returnDestinationsAvailable(c), 503, 'Kopia nie zawiera przyjęcia do magazynów');
    await access(c, actor, writing, false);
    const hydrate = await work(c);
    await finalizeWmsActorsInTx(c); await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const result = await hydrate(); const grant = await access(c, actor, writing, true);
    const f = flags(grant, ctx);
    if (result.source) result.source = { ...result.source, session: { ...result.source.session,
      can_control: result.source.session.can_control && f.can_write },
      can_preview: result.source.session.can_control && f.can_write };
    if (result.preview) result.preview = { ...result.preview, can_receive: result.preview.can_receive && f.can_write && f.intake_available };
    await finalizeCatalogStockControlActorsInTx(c);
    if (writing) await finalizeCatalogStockCountTerminalInTx(c, [{ actor,
      roles: ['admin','operator'], scopes: ['orders:read','inventory:read','orders:write','inventory:write'],
    }]);
    await c.query('COMMIT'); return { ...result, ...f };
  } catch (error) { await c.query('ROLLBACK').catch(() => undefined); return mapped(error); }
  finally { endWmsTransaction(c); endPurchasingTransaction(c); endCatalogStockControlTransaction(c); c.release(); }
}

type PrivateSource = Row & { planner_source: ReturnDestinationSource };
async function sql<T>(c: PoolClient, actor: V.ReturnDestinationsActor, query: string, values: unknown[]): Promise<T> {
  return owner(c, actor, async () => (await c.query(query, values)).rows[0].value as T);
}
/** Own unlocked references → sorted WH/policy → selected status SHARE → quota/order. */
async function lockScope(c: PoolClient, actor: V.ReturnDestinationsActor, returnId: string, sessionId: string, statusIds?: string[], frozenWarehouses: string[] = []) {
  return owner(c, actor, async () => {
    const head = (await c.query(`SELECT r.order_id,r.warehouse_id,o.warehouse_id order_warehouse_id,s.id session_id FROM return_cases r
      JOIN orders o ON(o.tenant_id,o.id)=(r.tenant_id,r.order_id)
      JOIN return_assistant_sessions s ON(s.tenant_id,s.return_id)=(r.tenant_id,r.id)
      WHERE r.tenant_id=$1 AND r.id=$2 AND s.id=$3`, [actor.tenantId, returnId, sessionId])).rows[0];
    ensure(head, 404, 'Sesja nie należy do własnego RMA');
    const statuses = (await c.query(`SELECT h.id,rv.warehouse_id FROM return_destination_statuses h
      JOIN return_destination_status_revisions rv ON(rv.tenant_id,rv.status_id,rv.id,rv.version)=(h.tenant_id,h.id,h.revision_id,h.version)
      WHERE h.tenant_id=$1 AND ($2::uuid[] IS NULL AND (rv.settings->>'active')::boolean OR h.id=ANY($2::uuid[]))
      ORDER BY h.id LIMIT 201`, [actor.tenantId, statusIds ?? null])).rows;
    ensure(statuses.length <= 200 && (!statusIds || statuses.length === statusIds.length), 409, 'Statusy przyjęcia zmieniły zakres');
    const warehouses = [...new Set([head.warehouse_id, head.order_warehouse_id, ...statuses.flatMap(status => status.warehouse_id ? [status.warehouse_id] : []), ...frozenWarehouses])].sort();
    await lockWarehouseInventoryPoliciesInTx(c, warehouses);
    const locked = (await c.query(`SELECT h.id,rv.warehouse_id FROM return_destination_statuses h
      JOIN return_destination_status_revisions rv ON(rv.tenant_id,rv.status_id,rv.id,rv.version)=(h.tenant_id,h.id,h.revision_id,h.version)
      WHERE h.tenant_id=$1 AND h.id=ANY($2::uuid[]) ORDER BY h.id FOR SHARE OF h,rv`,
      [actor.tenantId, statuses.map(status => status.id)])).rows;
    ensure(locked.every(status => !status.warehouse_id || warehouses.includes(status.warehouse_id)), 409, 'Magazyn statusu zmienił się przed blokadą');
    const current = (await c.query(`SELECT r.order_id,r.warehouse_id,o.warehouse_id order_warehouse_id FROM return_cases r
      JOIN orders o ON(o.tenant_id,o.id)=(r.tenant_id,r.order_id) WHERE r.tenant_id=$1 AND r.id=$2`, [actor.tenantId, returnId])).rows[0];
    ensure(current && current.order_id === head.order_id && current.warehouse_id === head.warehouse_id &&
      current.order_warehouse_id === head.order_warehouse_id, 409, 'Źródło RMA zmieniło magazyn');
    return { order_id: head.order_id as string, warehouses };
  });
}
type StockCell = { warehouse_id: string; product_id: string };
async function quotaOrder(c: PoolClient, actor: V.ReturnDestinationsActor, returnId: string, orderId: string, targets: StockCell[]) {
  await c.query('SELECT return_assistant_lock()');
  await admitLocalReturnReceiveInTx(c, actor, returnId);
  await owner(c, actor, async () => {
    // Match134's global order locks first; then acquire the complete sorted
    // union before reentering its original-source-only stock locks.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['order.parcels.quota:' + actor.tenantId]);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['order.parcels:' + actor.tenantId + ':' + orderId]);
    ensure((await c.query('SELECT id FROM orders WHERE(tenant_id,id)=($1,$2) FOR UPDATE', [actor.tenantId, orderId])).rowCount,
      404, 'Nie znaleziono pierwotnego zamówienia');
    await c.query('SELECT id FROM shipments WHERE(tenant_id,order_id)=($1,$2) ORDER BY id FOR UPDATE', [actor.tenantId, orderId]);
    const originals = (await c.query(`SELECT r.warehouse_id,(component->>'product_id')::uuid product_id
      FROM return_cases r JOIN return_items ri ON(ri.tenant_id,ri.return_id)=(r.tenant_id,r.id)
      CROSS JOIN LATERAL jsonb_array_elements(ri.components) component WHERE(r.tenant_id,r.id)=($1,$2)
      UNION SELECT warehouse_id,product_id FROM reservations WHERE(tenant_id,order_id)=($1,$3)`,
      [actor.tenantId, returnId, orderId])).rows as StockCell[];
    const cells = [...new Map([...originals, ...targets].map(cell => [cell.warehouse_id + '/' + cell.product_id, cell])).values()];
    ensure(cells.length <= 1000, 413, 'Pełna unia źródła i celu przekracza limit');
    const values = [actor.tenantId, JSON.stringify(cells)];
    const predicate = `sk.tenant_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) v
      WHERE(sk.warehouse_id::text,sk.product_id::text)=(v->>'warehouse_id',v->>'product_id'))`;
    await c.query(`SELECT product_id FROM stock sk WHERE ${predicate} ORDER BY sk.warehouse_id,sk.product_id FOR UPDATE`, values);
    await c.query(`SELECT product_id FROM stock_locations sk WHERE ${predicate} ORDER BY sk.warehouse_id,sk.product_id,sk.location COLLATE "C" FOR UPDATE`, values);
    await c.query(`SELECT product_id FROM wms_layer_positions sk WHERE ${predicate} ORDER BY sk.warehouse_id,sk.product_id,sk.location COLLATE "C",sk.layer_id FOR UPDATE`, values);
  });
  await lockParcelReturnOrderInTx(c, actor, orderId);
}
function safePlanner(source: ReturnDestinationSource) {
  return { ...source, wms: { ...source.wms, issue_fragments: source.wms.issue_fragments.map(fragment => ({
    ...pick(fragment, ['id', 'product_id', 'layer_id', 'order_id', 'eligible_item_ids', 'quantity', 'returned_quantity', 'currency']),
    available: fragment.quantity - fragment.returned_quantity,
  })) } };
}
function publicPlan(plan: ReturnDestinationPlan) {
  const { private_fragment_effects, ...rest } = plan;
  return { ...rest, fragments: private_fragment_effects.map(fragment => pick(fragment,
    ['part_id', 'item_id', 'product_id', 'warehouse_id', 'location', 'quantity', 'effect', 'issue_fragment_id', 'layer_id', 'currency'])) };
}
const sessionFields = ['id', 'return_id', 'order_id', 'state', 'version', 'station_id', 'lease_generation', 'lease_expires_at'];
const caseFields = ['id', 'number', 'state', 'version', 'warehouse_id', 'requested_shipping', 'refund_amount', 'refunded_shipping', 'received_at', 'decision_note', 'receipt_sequence'];
const orderFields = ['id', 'number', 'version', 'status', 'currency', 'warehouse_id', 'payment_mode', 'wms_lots_enabled'];
function lines(value: Row[]) { return value.map(line => ({
  ...pick(line, ['item_id', 'product_id', 'sku', 'name', 'requested', 'original_quantity', 'line_total', 'components', 'codes']),
  //139 uses row_number(1..N); the strict destinations planner uses0..N-1.
  ordinal: Number(line.ordinal) - 1,
})); }
function snapshot(value: Row, source: ReturnDestinationSource, plan?: ReturnDestinationPlan) {
  return { protocol: 'destinations_v1', session: { ...pick(value.session, sessionFields), version: String(value.session.version),
    lease_generation: String(value.session.lease_generation) },
    return_case: pick(value.return_case, caseFields), order: pick(value.order, orderFields), lines: lines(value.lines),
    station: pick(value.station, ['id', 'version', 'code', 'label', 'enabled']), scanned: value.scanned,
    photos: value.photos.map((photo: Row) => pick(photo, ['id', 'item_id', 'part_id', 'mime', 'byte_count', 'sha256', 'width', 'height', 'created_at'])),
    warehouses: value.warehouses.map((warehouse: Row) => pick(warehouse, ['id', 'name', 'code'])),
    origins: value.origins.map((origin: Row) => ({
      ...pick(origin, ['origin_id', 'item_id', 'dispatch_id', 'parcel_index', 'shipment_id', 'quantity']),
      fragments: origin.fragments.map((fragment: Row) => pick(fragment, ['fragment_id', 'product_id', 'quantity', 'available'])),
    })),
    source: safePlanner(source), ...(plan ? { plan: publicPlan(plan) } : {}) };
}
function sourceView(value: PrivateSource, actor: V.ReturnDestinationsActor) {
  const s = snapshot(value, value.planner_source);
  return { ...s, planner_source: s.source, return_version: String(value.return_case.version),
    session: { ...s.session, version: String(value.session.version),
      can_control: value.session.actor_id === actor.userId && value.session.api_key_id === (actor.apiKeyId ?? null) && value.session.state === 'active'
        && Date.parse(value.session.lease_expires_at) > Date.now() } };
}
type PreviewRow = Row & { payload: Row & { planner_source: ReturnDestinationSource; plan: ReturnDestinationPlan } };
async function previewRow(c: PoolClient, actor: V.ReturnDestinationsActor, id: string): Promise<PreviewRow> {
  return owner(c, actor, async () => {
    const row = (await c.query('SELECT * FROM return_assistant_previews WHERE tenant_id=$1 AND id=$2', [actor.tenantId, id])).rows[0];
    ensure(row && row.payload.snapshot.protocol === 'destinations_v1', 404, 'Nie znaleziono własnego podglądu destinations'); return row as PreviewRow;
  });
}
function checkedPlan(frame: Row, draft: V.ReturnDestinationsPreviewInput) {
  return deriveReturnDestinationPlan(frame.planner_source, V.returnDestinationsPlannerDraft(draft));
}
async function planEquality(c: PoolClient, derived: ReturnDestinationPlan, sqlPlan: ReturnDestinationPlan) {
  ensure((await c.query('SELECT $1::jsonb=$2::jsonb ok', [JSON.stringify(derived), JSON.stringify(sqlPlan)])).rows[0].ok,
    503, 'Dowody ilości przyjęcia nie są zgodne');
}
async function previewView(c: PoolClient, actor: V.ReturnDestinationsActor, id: string) {
  const p = await previewRow(c, actor, id), frame = p.payload, ss = frame.snapshot;
  const receipt = (await c.query('SELECT id FROM return_assistant_receipts WHERE preview_id=$1', [id])).rows[0];
  const session = (await c.query('SELECT state,version::text FROM return_assistant_sessions WHERE id=$1', [p.session_id])).rows[0];
  return { ...pick(p, ['id', 'session_id', 'return_id', 'order_id', 'scope_hash']), kind: 'preview', protocol: 'destinations_v1',
    created_at: iso(p.created_at), expires_at: iso(p.expires_at), action: frame.action,
    request: { client_key: p.client_key, ...ss.request }, core_input: frame.receive_input, summary: frame.plan.summary,
    snapshot: { ...snapshot(ss, frame.planner_source, frame.plan), request: { client_key: p.client_key, ...ss.request } },
    operation_id: receipt?.id ?? null, can_receive: !receipt && p.actor_id === actor.userId && p.api_key_id === (actor.apiKeyId ?? null)
      && Date.parse(iso(p.expires_at)) > Date.now() && session?.state === 'active' && session.version === String(ss.session.version) };
}
async function operationView(c: PoolClient, actor: V.ReturnDestinationsActor, id: string) {
  const r = await owner(c, actor, async () => (await c.query('SELECT * FROM return_assistant_receipts WHERE tenant_id=$1 AND id=$2', [actor.tenantId, id])).rows[0]);
  ensure(r && r.payload.snapshot.protocol === 'destinations_v1', 404, 'Nie znaleziono własnego przyjęcia destinations');
  const p = await previewView(c, actor, r.preview_id);
  return { ...pick(r, ['id', 'preview_id', 'session_id', 'return_id', 'order_id', 'scope_hash']), kind: 'operation', protocol: 'destinations_v1',
    return_id: r.return_id as string,
    created_at: iso(r.created_at), action: r.payload.action, request: { client_key: r.client_key, scope_hash: r.scope_hash, confirmed: true },
    snapshot: p.snapshot, core_input: r.payload.receive_input, summary: r.payload.plan.summary, result: pick(r.result, caseFields) };
}

export async function returnDestinationsOptions(actor: V.ReturnDestinationsActor, ctx: ReturnDestinationsContext = {}) {
  if (!await returnDestinationsAvailable()) return { available: false, read_only: !!ctx.readOnly, can_read: false,
    can_write: false, current_role: null, intake_available: false, can_read_value: false, limits: V.RETURN_DESTINATIONS_LIMITS };
  return tx(actor, false, ctx, async () => async () => ({ limits: V.RETURN_DESTINATIONS_LIMITS }));
}
export function returnDestinationsSource(actor: V.ReturnDestinationsActor, returnId: string, input: unknown, ctx: ReturnDestinationsContext = {}) {
  const rid = V.returnDestinationsUuid.parse(returnId), q = V.returnDestinationsSourceQuery.parse(input);
  return tx(actor, false, ctx, async c => {
    await lockScope(c, actor, rid, q.session_id);
    return async () => ({ source: sourceView(await sql<PrivateSource>(c, actor,
      'SELECT return_destination_source($1,$2,$3,$4) value', [rid, q.session_id, actor.userId, actor.apiKeyId ?? null]), actor), limits: V.RETURN_DESTINATIONS_LIMITS });
  });
}
export function previewReturnDestinations(actor: V.ReturnDestinationsActor, returnId: string, input: unknown, ctx: ReturnDestinationsContext = {}) {
  ensure(!ctx.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
  const rid = V.returnDestinationsUuid.parse(returnId), b = V.returnDestinationsPreviewInput.parse(input);
  return tx(actor, true, ctx, async c => {
    const prior = await owner(c, actor, async () => (await c.query('SELECT id FROM return_assistant_previews WHERE tenant_id=$1 AND client_key=$2',
      [actor.tenantId, b.client_key])).rows[0]);
    const scope = await lockScope(c, actor, rid, b.session_id, [...new Set(b.parts.map(part => part.status_id))]);
    await quotaOrder(c, actor, rid, scope.order_id, b.stock_versions);
    if (!prior) {
      const frame = await sql<Row>(c, actor, 'SELECT return_destination_frame($1,$2::jsonb,$3,$4) value',
        [b.session_id, JSON.stringify(b), actor.userId, actor.apiKeyId ?? null]);
      ensure(frame.planner_source.return_id === rid, 409, 'Podgląd należy do innego RMA');
      await planEquality(c, checkedPlan(frame, b), frame.plan);
    }
    const proposed = randomUUID();
    const id = await sql<string>(c, actor, 'SELECT return_destination_preview($1,$2,$3::jsonb,$4,$5) value',
      [proposed, b.session_id, JSON.stringify(b), actor.userId, actor.apiKeyId ?? null]);
    if (id === proposed) await audit(c, actor, 'return.destinations.previewed', id);
    return async () => ({ preview: await previewView(c, actor, id), reused: id !== proposed });
  });
}
export function returnDestinationsPreviewDetail(actor: V.ReturnDestinationsActor, id: string, ctx: ReturnDestinationsContext = {}) {
  const pid = V.returnDestinationsUuid.parse(id); return tx(actor, false, ctx, async c => async () => ({ preview: await previewView(c, actor, pid) }));
}
export function receiveReturnDestinations(actor: V.ReturnDestinationsActor, id: string, input: unknown, ctx: ReturnDestinationsContext = {}) {
  ensure(!ctx.readOnly, 423, 'Odtworzona kopia jest tylko do odczytu');
  const pid = V.returnDestinationsUuid.parse(id), body = V.returnDestinationsReceiveInput.parse(input);
  return tx(actor, true, ctx, async c => {
    actor = enlistWmsActorInTx(c, actor, { orders: true });
    const p = await previewRow(c, actor, pid);
    const completion = p.payload.action === 'reject' ? null : await prepareReturnCompletionInTx(c, actor, {
      return_id: p.return_id, protocol: 'destinations_v1', preview_id: pid, request: p.payload.receive_input,
    });
    const scope = await lockScope(c, actor, p.return_id, p.session_id,
      [...new Set(p.payload.plan.parts.map(part => part.status.status_id))], p.payload.plan.stock_effects.map(cell => cell.warehouse_id));
    await quotaOrder(c, actor, p.return_id, scope.order_id, p.payload.plan.stock_effects);
    const proposed = randomUUID();
    const eid = await sql<string>(c, actor, 'SELECT return_destination_prepare($1,$2,$3::jsonb,$4,$5) value',
      [pid, proposed, JSON.stringify(body), actor.userId, actor.apiKeyId ?? null]);
    if (eid === proposed) {
      ensure(ctx.receiveCore && ctx.applyPhysical, 503, 'Przyjęcie destinations nie ma pełnego adaptera fizycznego');
      const admission = await sql<ReturnDestinationAdmissionScope>(c, actor, 'SELECT return_destination_admission_scope($1,$2,$3,$4) value',
        [eid, p.return_id, actor.userId, actor.apiKeyId ?? null]);
      let physicalStarted = false, physicalComplete = false, finished = false;
      await ctx.receiveCore(c, actor, p.return_id, admission.receive_input, {
        action: p.payload.action, destinationAdmissionId: eid, completion: completion ?? undefined,
        applyDestinationPhysical: async () => {
          ensure(!physicalStarted, 409, 'Adapter fizyczny może wykonać przyjęcie tylko raz');
          physicalStarted = true; await ctx.applyPhysical!(c, actor, eid, p.return_id); physicalComplete = true;
        },
        beforeFinish: async () => {
          ensure(!finished && (admission.plan.arrivals.length === 0 || physicalComplete),
            503, 'Core nie wykonał całego fizycznego przyjęcia przed certyfikacją');
          finished = true;
          await sql(c, actor, 'SELECT return_destination_finish($1,$2,$3) value', [eid, actor.userId, actor.apiKeyId ?? null]);
          await audit(c, actor, 'return.destinations.received', eid, { return_id: p.return_id });
        },
      });
      ensure(finished, 503, 'Core nie zakończył atomowego dowodu przyjęcia');
    }
    if (completion) {
      if (eid !== proposed) await replayReturnCompletionInTx(c, actor, completion);
      else await completeReturnCompletionInTx(c, actor, completion, { assistant_receipt_id: eid });
    }
    return async () => {
      const result = { operation: await operationView(c, actor, eid), return_case: await getReturn(c, p.return_id), reused: eid !== proposed };
      if (completion) await pinReturnCompletionInTx(c, actor, completion);
      return result;
    };
  });
}
export function returnDestinationsOperationDetail(actor: V.ReturnDestinationsActor, id: string, ctx: ReturnDestinationsContext = {}) {
  const eid = V.returnDestinationsUuid.parse(id); return tx(actor, false, ctx, async c => async () => {
    const operation = await operationView(c, actor, eid); return { operation, return_case: await getReturn(c, operation.return_id) };
  });
}
export function returnDestinationsHistory(actor: V.ReturnDestinationsActor, returnId: string, input: unknown, ctx: ReturnDestinationsContext = {}) {
  const rid = V.returnDestinationsUuid.parse(returnId), q = V.returnDestinationsHistoryQuery.parse(input);
  return tx(actor, false, ctx, async c => async () => owner(c, actor, async () => {
    ensure((await c.query('SELECT id FROM return_assistant_sessions WHERE tenant_id=$1 AND id=$2 AND return_id=$3', [actor.tenantId, q.session_id, rid])).rowCount,
      404, 'Historia nie należy do własnego RMA/sesji');
    if (q.cursor) ensure((await c.query("SELECT id FROM return_assistant_receipts WHERE tenant_id=$1 AND session_id=$2 AND return_id=$3 AND id=$4 AND payload->'snapshot'->>'protocol'='destinations_v1'", [actor.tenantId, q.session_id, rid, q.cursor])).rowCount,
      404, 'Kursor nie należy do historii przyjęć');
    const rows = (await c.query(`SELECT id,preview_id,session_id,return_id,order_id,created_at,scope_hash,payload->>'action' action,payload->'plan'->'summary' summary
      FROM return_assistant_receipts WHERE tenant_id=$1 AND session_id=$2 AND return_id=$3 AND payload->'snapshot'->>'protocol'='destinations_v1'
      AND($4::uuid IS NULL OR(created_at,id)<(SELECT created_at,id FROM return_assistant_receipts WHERE tenant_id=$1 AND id=$4))
      ORDER BY created_at DESC,id DESC LIMIT $5`, [actor.tenantId, q.session_id, rid, q.cursor ?? null, q.limit + 1])).rows;
    return { data: rows.slice(0, q.limit).map(row => ({ ...row, created_at: iso(row.created_at) })), next_cursor: rows.length > q.limit ? rows[q.limit - 1].id : null };
  }));
}
