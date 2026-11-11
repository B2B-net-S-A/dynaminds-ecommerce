import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tenantTx as dbTenantTx, tenantReadTx } from './db';
async function tenantTx<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await dbTenantTx(tenantId, fn);
  } catch (e) {
    if ((e as any)?.code === 'P0001' && (e as Error).message === 'Limit pamięci pakowania')
      throw new Problem(413, 'Limit pamięci pakowania');
    throw e;
  }
}
import { ensure, Problem } from './errors';
import { acquirePackingFieldAdmissionInTx, capturePackingFieldRequirementsInTx } from './packing-order-field-requirements';
import { audit, lockedOrder, scan, transition } from './domain';
import { paymentBalance } from './payments';
import { orderProductLogisticsInTx } from './order-product-logistics';
import * as S from './packing-workstation-schema';
import {
  assertPackingActorInTx,
  packingFulfillmentHashInTx,
  packingReceiptCurrentInTx,
} from './packing-workstation-guards';
import type { PackingActor } from './packing-workstation-schema';
export function packingCanonical(v: any): any {
  if (Array.isArray(v)) return v.map(packingCanonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== undefined)
        .map((k) => [k, packingCanonical(v[k])]),
    );
  return v;
}
export const packingHash = (v: any) =>
  createHash('sha256')
    .update(JSON.stringify(packingCanonical(v)))
    .digest('hex');
const tokenHash = (v: string) => createHash('sha256').update(v.toLowerCase()).digest('hex');
const source = (a: PackingActor) => a.source ?? (a.apiKeyId ? 'api' : 'manual');
const requestHash = (a: PackingActor, target: string, b: any) =>
  packingHash({ tenant_id: a.tenantId, actor_id: a.userId, source: source(a), target, body: b });
const safeBody = (b: any, lease?: string) => {
  const r = { ...b };
  if (r.lease_token) {
    r.lease_token_hash = tokenHash(r.lease_token);
    delete r.lease_token;
  }
  if (lease) r.current_lease_hash = tokenHash(lease);
  return r;
};
const parse = <T>(schema: { parse: (v: unknown) => T }, body: unknown): T => {
  ensure(
    Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8') <= S.PACKING_LIMITS.request_bytes,
    413,
    'Żądanie pakowania przekracza 64 KiB',
  );
  return schema.parse(body);
};
const bump = (v: string) => {
  ensure(BigInt(v) < 9223372036854775807n, 409, 'Wersja osiągnęła maksymalny zakres');
  return (BigInt(v) + 1n).toString();
};
const date = (v: any) => (v instanceof Date ? v.toISOString() : String(v));
async function readRole(c: PoolClient, a: PackingActor) {
  return assertPackingActorInTx(c, a);
}
async function early(c: PoolClient, a: PackingActor, admin = false) {
  const r = await readRole(c, a);
  ensure(r === 'admin' || (!admin && r === 'operator'), 403, 'Brak uprawnień do zmiany pakowania');
  return r;
}
async function admission(c: PoolClient, a: PackingActor, catalog = true) {
  if (catalog)
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
      `catalog:${a.tenantId}`,
    ]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `packing.admission:${a.tenantId}`,
  ]);
}
async function late(c: PoolClient, a: PackingActor, admin = false) {
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  return assertPackingActorInTx(c, a, true, admin);
}
async function quota(c: PoolClient, table: string, limit: number) {
  ensure(
    Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n) < limit,
    409,
    'Osiągnięto limit historii pakowania',
  );
}
async function opReplay(
  c: PoolClient,
  a: PackingActor,
  b: any,
  target: string,
  lease?: string,
  admin = false,
) {
  const h = requestHash(a, target, safeBody(b, lease));
  const r = (await c.query('SELECT * FROM packing_operations WHERE client_key=$1', [b.client_key]))
    .rows[0];
  if (!r) return { hash: h, row: null };
  ensure(
    r.actor_id === a.userId && r.source === source(a) && r.request_hash === h,
    409,
    'Klucz operacji obejmuje inny zakres',
  );
  await late(c, a, admin);
  return { hash: h, row: r };
}
async function saveOp(
  c: PoolClient,
  a: PackingActor,
  b: any,
  target: string,
  kind: string,
  result: any,
  lease?: string,
  sessionId?: string,
) {
  await quota(c, 'packing_operations', S.PACKING_LIMITS.operations);
  await c.query(
    `INSERT INTO packing_operations(id,tenant_id,actor_id,client_key,request_hash,source,kind,target_id,session_id,result,safe_request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      result.operation?.id ?? randomUUID(),
      a.tenantId,
      a.userId,
      b.client_key,
      requestHash(a, target, safeBody(b, lease)),
      source(a),
      kind,
      result.station?.id ?? result.carton?.id ?? result.session?.id ?? target.split(':').at(-1),
      sessionId ?? null,
      result,
      safeBody(b, lease),
    ],
  );
}
async function named(c: PoolClient, ids: string[]) {
  const rows = (await c.query('SELECT * FROM packing_operator_names($1)', [ids])).rows;
  return new Map<string, string>(rows.map((r) => [r.id, r.name]));
}
async function sessionHead(c: PoolClient, s: any) {
  const names = await named(c, [s.owner_id]);
  return {
    id: s.id,
    order_id: s.order_id,
    station_id: s.station_id,
    owner_id: s.owner_id,
    owner_name: names.get(s.owner_id) ?? '',
    state: s.state,
    version: s.version,
    lease_generation: s.lease_generation,
    expires_at: date(s.expires_at),
    created_at: date(s.created_at),
  };
}
async function session(c: PoolClient, id: string, lock = true) {
  const s = (
    await c.query(
      `SELECT *,expires_at>clock_timestamp() AS valid FROM packing_sessions WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
  ensure(s, 404, 'Nie znaleziono sesji pakowania');
  return s;
}
async function sessionOrder(c: PoolClient, id: string) {
  const h = await session(c, id, false);
  const o = await lockedOrder(c, h.order_id);
  return { o, s: await session(c, id) };
}
function lease(s: any, a: PackingActor, value?: string) {
  ensure(
    s.state === 'active' &&
      s.valid &&
      s.owner_id === a.userId &&
      value &&
      s.lease_token_hash === tokenHash(value),
    409,
    'Sesja wymaga bieżącego własnego lease',
  );
}
async function wave(c: PoolClient, id: string) {
  return (
    (await c.query('SELECT wave_id FROM picking_wave_orders WHERE order_id=$1 AND active', [id]))
      .rows[0]?.wave_id ?? null
  );
}
async function noWave(c: PoolClient, id: string) {
  ensure(!(await wave(c, id)), 409, 'Najpierw zakończ aktywną partię kompletacji');
}
async function station(c: PoolClient, id: string, version: string) {
  const r = (await c.query('SELECT * FROM packing_stations WHERE id=$1 FOR SHARE', [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono własnego stanowiska');
  ensure(r.enabled && r.version === version, 409, 'Stanowisko jest wyłączone lub zmieniło wersję');
  return cleanSetting(r);
}
function cleanSetting(r: any) {
  const { byte_count, tenant_id, ...rest } = r;
  for (const k of ['created_at', 'updated_at']) if (rest[k]) rest[k] = date(rest[k]);
  return rest;
}
async function policy(c: PoolClient, lock = false) {
  const r = (
    await c.query(
      `SELECT version,require_parcel_profile FROM packing_policies ${lock ? 'FOR SHARE' : ''}`,
    )
  ).rows[0];
  return r ?? { version: '0', require_parcel_profile: false };
}
async function packaging(c: PoolClient, b: any) {
  if (b.kind === 'custom') return b;
  const r = (await c.query('SELECT * FROM packing_cartons WHERE id=$1 FOR SHARE', [b.carton_id]))
    .rows[0];
  ensure(r, 404, 'Nie znaleziono własnego kartonu');
  ensure(
    r.enabled && r.version === b.carton_version,
    409,
    'Karton jest wyłączony lub zmienił wersję',
  );
  return { ...b, carton_snapshot: cleanSetting(r) };
}
function orderScope(o: any) {
  return {
    id: o.id,
    number: o.number,
    version: String(o.version),
    status: o.status,
    warehouse_id: o.warehouse_id,
    total: o.total,
    currency: o.currency,
    payment_mode: o.payment_mode,
    address: o.address,
    source: o.source,
    channel_id: o.channel_id,
    external_id: o.external_id,
    source_snapshot_hash: packingHash(o.source_snapshot ?? null),
  };
}
async function physical(c: PoolClient, o: any) {
  const counts = (
    await c.query(
      `SELECT (SELECT count(*) FROM order_items WHERE order_id=$1) AS items,(SELECT count(*) FROM order_pick_items WHERE order_id=$1) AS physical,(SELECT count(*) FROM reservation_locations WHERE order_id=$1) AS allocations`,
      [o.id],
    )
  ).rows[0];
  ensure(
    Number(counts.items) <= 100 &&
      Number(counts.physical) <= 10000 &&
      Number(counts.allocations) <= 10000,
    422,
    'Zamówienie przekracza zakres fizyczny stanowiska',
  );
  const f = (await c.query('SELECT packing_fulfillment_snapshot($1) AS snapshot', [o.id])).rows[0]
    .snapshot;
  const expected = new Map<string, bigint>();
  const issues: string[] = [];
  for (const i of f.order_items) {
    const components =
      Array.isArray(i.components) && i.components.length
        ? i.components
        : [{ product_id: i.product_id, quantity: 1 }];
    for (const x of components) {
      ensure(
        typeof x.product_id === 'string' && Number.isSafeInteger(x.quantity) && x.quantity > 0,
        422,
        'Nieprawidłowa migawka składników',
      );
      expected.set(
        x.product_id,
        (expected.get(x.product_id) ?? 0n) + BigInt(x.quantity) * BigInt(i.quantity),
      );
    }
  }
  ensure(expected.size <= 10000, 422, 'Zbyt wiele składników fizycznych');
  if (!f.physical.length) issues.push('EMPTY_PHYSICAL_SCOPE');
  if (
    f.physical.length !== expected.size ||
    f.physical.some((x: any) => expected.get(x.product_id) !== BigInt(x.quantity))
  )
    issues.push('PHYSICAL_COMPONENTS_MISMATCH');
  if (f.physical.some((x: any) => x.scanned !== x.quantity)) issues.push('SCANS_INCOMPLETE');
  const rs = new Map<string, any>(f.reservations.map((r: any) => [r.product_id, r]));
  if (
    rs.size !== expected.size ||
    f.physical.some((x: any) => {
      const r = rs.get(x.product_id);
      return (
        !r || r.state !== 'active' || r.warehouse_id !== o.warehouse_id || r.quantity !== x.quantity
      );
    })
  )
    issues.push('RESERVATIONS_MISMATCH');
  const allocations = new Map<string, bigint>();
  for (const r of f.allocations) {
    allocations.set(r.product_id, (allocations.get(r.product_id) ?? 0n) + BigInt(r.quantity));
    if (r.scanned !== r.quantity || r.warehouse_id !== o.warehouse_id)
      issues.push('ALLOCATIONS_INCOMPLETE');
  }
  if (
    allocations.size !== expected.size ||
    f.physical.some((x: any) => allocations.get(x.product_id) !== BigInt(x.quantity))
  )
    issues.push('ALLOCATIONS_MISMATCH');
  return { fulfillment: f, issues: [...new Set(issues)] };
}
async function noShipping(c: PoolClient, id: string) {
  ensure(
    !(await c.query('SELECT 1 FROM shipments WHERE order_id=$1', [id])).rowCount,
    409,
    'Nowy pomiar jest niedostępny po utworzeniu przesyłki',
  );
  for (const t of ['shipping_plans', 'dpd_shipping_plans']) {
    const exists = (await c.query('SELECT to_regclass($1) AS t', [t])).rows[0].t;
    if (exists)
      ensure(
        !(
          await c.query(
            `SELECT 1 FROM ${t} WHERE order_id=$1 AND state NOT IN ('preview','cancelled')`,
            [id],
          )
        ).rowCount,
        409,
        'Aktywny lub niepewny plan wysyłki blokuje nowy pomiar',
      );
  }
}
async function warning(c: PoolClient, o: any) {
  const rules = (
    await c.query(
      "SELECT id,version FROM automation_rules WHERE enabled AND trigger='order.packed' ORDER BY id LIMIT 101",
    )
  ).rows;
  ensure(rules.length <= 100, 422, 'Za dużo reguł pakowania');
  const fence = (
    await c.query(
      'SELECT 1 FROM order_local_financial_fences WHERE order_id=$1 AND order_version=$2',
      [o.id, o.version],
    )
  ).rowCount;
  return {
    event: 'order.packed',
    enabled_rule_ids: rules.map((r) => r.id),
    versions: rules.map((r) => r.version),
    may_enqueue: rules.length > 0,
    local_financial_fence_exit: Boolean(fence),
  };
}
async function snapshot(c: PoolClient, a: PackingActor, b: any, o: any, s: any) {
  const pol = await policy(c, true);
  const st = await station(c, b.kind === 'finish' ? s.station_id : b.station_id, b.station_version);
  const pack = await packaging(c, b.packaging);
  const f = await physical(c, o);
  const balance = await paymentBalance(c, o.id);
  const requiredFields = b.kind === 'finish' ? await capturePackingFieldRequirementsInTx(c,a,o.id) : null;
  const issues = [...f.issues];
  if (requiredFields && !requiredFields.complete) issues.push('ORDER_FIELDS_REQUIRED');
  if (o.payment_mode !== 'cod' && balance.amount_due !== 0) issues.push('PAYMENT_INCOMPLETE');
  const profile = await packingReceiptCurrentInTx(c, o);
  if (b.kind === 'remeasure') {
    ensure(o.status === 'packed', 409, 'Nowy pomiar wymaga spakowanego zamówienia');
    ensure(
      profile.profile?.receipt_id === b.replaces_receipt_id &&
        profile.profile?.revision === b.profile_revision,
      409,
      'Profil paczki został zastąpiony',
    );
    await noShipping(c, o.id);
  } else ensure(o.status === 'picking', 409, 'Sesja wymaga statusu kompletacji');
  ensure(String(o.version) === b.order_version, 409, 'Zamówienie zmieniło wersję');
  await noWave(c, o.id);
  let reference: any = null;
  if (b.include_product_estimate) {
    ensure(a.canReadProducts !== false, 403, 'Oszacowanie wymaga zakresu produktów');
    const ids = f.fulfillment.physical.map((r: any) => r.product_id).sort();
    await c.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [ids]);
    reference = await orderProductLogisticsInTx(c, o.id);
  }
  const sessionScope = s
    ? {
        id: s.id,
        version: s.version,
        lease_generation: s.lease_generation,
        owner_id: s.owner_id,
        station_id: s.station_id,
        lease_token_hash: s.lease_token_hash,
        expires_at: date(s.expires_at),
      }
    : null;
  const out = {
    input: b,
    ...(requiredFields ? { required_order_fields: requiredFields } : {}),
    order: orderScope(o),
    session: sessionScope,
    station: st,
    packaging: pack,
    measurements: b.measurements,
    policy: pol,
    financial: balance,
    payment_hash: packingHash(balance),
    fulfillment: f.fulfillment,
    fulfillment_hash: await packingFulfillmentHashInTx(c, o),
    reference,
    reference_hash: packingHash(reference),
    profile_identity: profile.profile
      ? { receipt_id: profile.profile.receipt_id, revision: profile.profile.revision }
      : null,
    automations_warning: await warning(c, o),
    issues: [...new Set(issues)],
  };
  ensure(
    Buffer.byteLength(JSON.stringify(out), 'utf8') <= S.PACKING_LIMITS.snapshot_bytes,
    413,
    'Migawka pakowania przekracza 5 MiB',
  );
  return out;
}
function previewHead(p: any) {
  const f = p.full_snapshot;
  return {
    id: p.id,
    kind: p.kind,
    order_id: p.order_id,
    session_id: p.session_id,
    actor_id: p.actor_id,
    scope_hash: p.scope_hash,
    created_at: date(p.created_at),
    expires_at: date(p.expires_at),
    ready: p.ready,
    issues: p.issues,
    measurements: f.measurements,
    packaging: f.packaging,
    policy_version: f.policy.version,
    order_version: f.order.version,
    scan_hash: f.fulfillment_hash,
    payment_hash: f.payment_hash,
    automations_warning: f.automations_warning,
  };
}
function summary(f: any, canProducts = true) {
  const session = f.session
    ? {
        id: f.session.id,
        version: f.session.version,
        lease_generation: f.session.lease_generation,
        owner_id: f.session.owner_id,
        station_id: f.session.station_id,
        expires_at: f.session.expires_at,
      }
    : null;
  return {
    order: f.order,
    session,
    station: f.station,
    packaging: f.packaging,
    measurements: f.measurements,
    policy: f.policy,
    financial: f.financial,
    physical_count: f.fulfillment.physical.length,
    allocation_count: f.fulfillment.allocations.length,
    reference_count: canProducts ? (f.reference?.items?.length ?? 0) : 0,
    fulfillment_hash: f.fulfillment_hash,
    reference_hash: canProducts ? f.reference_hash : null,
    automations_warning: f.automations_warning,
  };
}
async function receiptHead(c: PoolClient, r: any) {
  const f = r.full_snapshot,
    names = await named(c, [r.actor_id]);
  return {
    id: r.id,
    preview_id: r.preview_id,
    kind: r.kind,
    order_id: r.order_id,
    order_number: f.order.number,
    actor_id: r.actor_id,
    actor_name: names.get(r.actor_id) ?? '',
    station_snapshot: f.station,
    packaging: f.packaging,
    measurements: f.measurements,
    profile_revision: r.profile_revision,
    replaces_receipt_id: r.replaces_receipt_id,
    before_order_version: r.before_order_version,
    after_order_version: r.after_order_version,
    before_fulfillment_hash: r.before_fulfillment_hash,
    after_fulfillment_hash: r.after_fulfillment_hash,
    scope_hash: r.scope_hash ?? packingHash(f),
    created_at: date(r.created_at),
  };
}
const cursor = (v: any) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decode(v: string | undefined, binding: any) {
  if (!v) return null;
  try {
    const p = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
    ensure(p.binding === packingHash(binding), 422, 'Kursor nie odpowiada zakresowi');
    return p;
  } catch (e) {
    if (e instanceof Problem) throw e;
    throw new Problem(422, 'Nieprawidłowy kursor');
  }
}
async function settingList(c: PoolClient, a: PackingActor, t: string, q: any) {
  const role = await readRole(c, a),
    bind = { tenant: a.tenantId, t, enabled: q.enabled, search: q.search },
    p = decode(q.cursor, bind);
  const rows = (
    await c.query(
      `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS cursor_at FROM ${t} WHERE ($1::boolean IS NULL OR enabled=$1) AND ($2::text IS NULL OR code ILIKE '%'||$2||'%' OR label ILIKE '%'||$2||'%') AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,
      [q.enabled ?? null, q.search ?? null, p?.at ?? null, p?.id ?? null],
    )
  ).rows;
  const take = rows.slice(0, 50),
    last = take.at(-1);
  return {
    current_role: role,
    data: take.map((r) => {
      const x = cleanSetting(r);
      delete x.cursor_at;
      return x;
    }),
    meta: {
      cursor:
        rows.length > 50
          ? cursor({ binding: packingHash(bind), at: last.cursor_at + '+00', id: last.id })
          : null,
    },
  };
}
export async function packingMetadata(a: PackingActor) {
  return tenantReadTx(a.tenantId, async (c) => ({
    current_role: await readRole(c, a),
    policy: await policy(c),
    limits: S.PACKING_LIMITS,
    units: { weight: 'g', dimensions: 'mm' },
  }));
}
export async function listPackingStations(a: PackingActor, q: any) {
  return tenantReadTx(a.tenantId, (c) => settingList(c, a, 'packing_stations', q));
}
export async function listPackingCartons(a: PackingActor, q: any) {
  return tenantReadTx(a.tenantId, (c) => settingList(c, a, 'packing_cartons', q));
}
async function settingWrite(a: PackingActor, t: string, input: unknown, id?: string) {
  const b: any = parse<any>(
    t === 'packing_stations'
      ? id
        ? S.packingStationPatchInput
        : S.packingStationCreateInput
      : id
        ? S.packingCartonPatchInput
        : S.packingCartonCreateInput,
    input,
  );
  return tenantTx(a.tenantId, async (c) => {
    await early(c, a, true);
    await admission(c, a, false);
    const target = `${t}:${id ?? b.client_key}`;
    const old = await opReplay(c, a, b, target, undefined, true);
    if (old.row) return { ...old.row.result, reused: true, current_role: 'admin' };
    let r: any;
    let changed = true;
    if (id) {
      r = (await c.query(`SELECT * FROM ${t} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      ensure(r, 404, 'Nie znaleziono konfiguracji');
      ensure(r.version === b.version, 409, 'Konfiguracja zmieniła wersję');
      const next = { ...r, ...b };
      if (t === 'packing_cartons')
        S.packingCartonCreateInput.parse({
          client_key: b.client_key,
          code: next.code,
          label: next.label,
          enabled: next.enabled,
          inner_dimensions: next.inner_dimensions,
          outer_dimensions: next.outer_dimensions,
          tare_grams: next.tare_grams,
        });
      const fields =
        t === 'packing_stations'
          ? ['code', 'label', 'enabled']
          : ['code', 'label', 'enabled', 'inner_dimensions', 'outer_dimensions', 'tare_grams'];
      changed = fields.some((k) => packingHash(r[k]) !== packingHash(next[k]));
      if (changed) {
        bump(r.version);
        const values = fields.map((k) => next[k]);
        r = (
          await c.query(
            `UPDATE ${t} SET ${fields.map((k, i) => `${k}=$${i + 1}`).join(',')},version=version+1,updated_at=clock_timestamp() WHERE id=$${fields.length + 1} RETURNING *`,
            [...values, id],
          )
        ).rows[0];
      }
    } else {
      await quota(c, t, t === 'packing_stations' ? 100 : 500);
      const fields =
        t === 'packing_stations'
          ? ['code', 'label', 'enabled']
          : ['code', 'label', 'enabled', 'inner_dimensions', 'outer_dimensions', 'tare_grams'];
      r = (
        await c.query(
          `INSERT INTO ${t}(id,tenant_id,${fields.join(',')}) VALUES($1,$2,${fields.map((_, i) => `$${i + 3}`).join(',')}) RETURNING *`,
          [randomUUID(), a.tenantId, ...fields.map((k) => b[k])],
        )
      ).rows[0];
    }
    const result = { [t === 'packing_stations' ? 'station' : 'carton']: cleanSetting(r), changed };
    await saveOp(c, a, b, target, id ? 'config_edit' : 'config_create', result);
    if (changed) await audit(c, a, 'packing.configuration', r.id, { table: t, version: r.version });
    const role = await late(c, a, true);
    return { ...result, current_role: role, reused: false };
  });
}
export const createPackingStation = (a: PackingActor, b: unknown) =>
  settingWrite(a, 'packing_stations', b);
export const patchPackingStation = (a: PackingActor, id: string, b: unknown) =>
  settingWrite(a, 'packing_stations', b, id);
export const createPackingCarton = (a: PackingActor, b: unknown) =>
  settingWrite(a, 'packing_cartons', b);
export const patchPackingCarton = (a: PackingActor, id: string, b: unknown) =>
  settingWrite(a, 'packing_cartons', b, id);
export async function patchPackingPolicy(a: PackingActor, input: unknown) {
  const b = parse(S.packingPolicyInput, input);
  return tenantTx(a.tenantId, async (c) => {
    await early(c, a, true);
    await admission(c, a, false);
    const target = `policy:${a.tenantId}`,
      r = await opReplay(c, a, b, target, undefined, true);
    if (r.row) return { ...r.row.result, reused: true, current_role: 'admin' };
    const p = await policy(c, true);
    ensure(p.version === b.version, 409, 'Polityka zmieniła wersję');
    let next = p;
    const changed = p.require_parcel_profile !== b.require_parcel_profile;
    if (changed) {
      if (p.version === '0')
        await c.query(
          'INSERT INTO packing_policies(tenant_id,version,require_parcel_profile) VALUES($1,1,$2)',
          [a.tenantId, b.require_parcel_profile],
        );
      else {
        bump(p.version);
        await c.query(
          'UPDATE packing_policies SET require_parcel_profile=$1,version=version+1,updated_at=clock_timestamp()',
          [b.require_parcel_profile],
        );
      }
      next = await policy(c);
    }
    const result = { policy: next, changed };
    await saveOp(c, a, b, target, 'policy', result);
    if (changed) await audit(c, a, 'packing.policy', a.tenantId, next);
    return { ...result, reused: false, current_role: await late(c, a, true) };
  });
}
export async function packingCandidates(a: PackingActor, q: any) {
  return tenantTx(a.tenantId, async (c) => {
    const role = await readRole(c, a);
    ensure(
      (await c.query('SELECT 1 FROM warehouses WHERE id=$1', [q.warehouse_id])).rowCount,
      404,
      'Nie znaleziono magazynu',
    );
    const bind = { tenant: a.tenantId, warehouse: q.warehouse_id, search: q.search },
      p = decode(q.cursor, bind);
    const rows = (
      await c.query(
        `SELECT o.id,o.number,o.version,o.status,o.warehouse_id,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS cursor_at,coalesce((SELECT sum(quantity) FROM order_pick_items i WHERE i.order_id=o.id),0)::bigint AS quantity,coalesce((SELECT sum(scanned) FROM order_pick_items i WHERE i.order_id=o.id),0)::bigint AS scanned,(SELECT wave_id FROM picking_wave_orders w WHERE w.order_id=o.id AND w.active) AS active_wave_id,(SELECT id FROM packing_sessions s WHERE s.order_id=o.id AND s.state='active') AS active_session_id FROM orders o WHERE warehouse_id=$1 AND status='picking' AND ($2::text IS NULL OR o.number::text ILIKE '%'||$2||'%') AND ($3::timestamptz IS NULL OR (o.created_at,o.id)<($3::timestamptz,$4::uuid)) ORDER BY o.created_at DESC,o.id DESC LIMIT 51`,
        [q.warehouse_id, q.search ?? null, p?.at ?? null, p?.id ?? null],
      )
    ).rows;
    const take = rows.slice(0, 50),
      last = take.at(-1);
    return {
      current_role: role,
      data: take.map((r) => {
        const blockers = [
          ...(r.active_wave_id ? ['ACTIVE_PICKING_WAVE'] : []),
          ...(r.active_session_id ? ['ACTIVE_PACKING_SESSION'] : []),
        ];
        const { cursor_at, ...v } = r;
        return {
          ...v,
          quantity: Number(r.quantity),
          scanned: Number(r.scanned),
          eligible: blockers.length === 0,
          blockers,
        };
      }),
      meta: {
        cursor:
          rows.length > 50
            ? cursor({ binding: packingHash(bind), at: last.cursor_at + '+00', id: last.id })
            : null,
      },
    };
  });
}
export async function startPackingSession(a: PackingActor, input: unknown) {
  const b = parse(S.packingSessionCreateInput, input);
  return tenantTx(a.tenantId, async (c) => {
    await early(c, a);
    await admission(c, a);
    const target = `start:${b.order_id}`,
      r = await opReplay(c, a, b, target);
    if (r.row) return { ...r.row.result, reused: true, current_role: await readRole(c, a) };
    await quota(c, 'packing_sessions', 2000);
    ensure(
      Number(
        (await c.query("SELECT count(*) AS n FROM packing_sessions WHERE state='active'")).rows[0]
          .n,
      ) < 500,
      409,
      'Limit aktywnych sesji',
    );
    const o = await lockedOrder(c, b.order_id);
    ensure(
      o.status === 'picking' && String(o.version) === b.order_version,
      409,
      'Wymagane bieżące zamówienie w kompletacji',
    );
    await noWave(c, o.id);
    ensure(
      !(
        await c.query("SELECT 1 FROM packing_sessions WHERE order_id=$1 AND state='active'", [o.id])
      ).rowCount,
      409,
      'Zamówienie ma już aktywną sesję',
    );
    await station(c, b.station_id, b.station_version);
    const s = (
      await c.query(
        `INSERT INTO packing_sessions(id,tenant_id,order_id,warehouse_id,station_id,owner_id,state,lease_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,'active',$7,clock_timestamp()+interval '15 minutes') RETURNING *`,
        [
          randomUUID(),
          a.tenantId,
          o.id,
          o.warehouse_id,
          b.station_id,
          a.userId,
          tokenHash(b.lease_token),
        ],
      )
    ).rows[0];
    const result = { session: await sessionHead(c, s) };
    await saveOp(c, a, b, target, 'start', result, undefined, s.id);
    await audit(c, a, 'packing.start', o.id, { session_id: s.id, station_id: s.station_id });
    return { ...result, reused: false, current_role: await late(c, a) };
  });
}
async function leaseWrite(
  a: PackingActor,
  id: string,
  input: unknown,
  kind: 'renew' | 'takeover' | 'cancel',
  header?: string,
) {
  const b: any = parse(
    kind === 'renew'
      ? S.packingLeaseRenewInput
      : kind === 'takeover'
        ? S.packingTakeoverInput
        : S.packingCancelInput,
    input,
  );
  return tenantTx(a.tenantId, async (c) => {
    const role = await early(c, a);
    let requiresAdmin = false;
    await admission(c, a);
    const target = `${kind}:${id}`,
      r = await opReplay(c, a, b, target, header);
    if (r.row) return { ...r.row.result, reused: true, current_role: await readRole(c, a) };
    const { o, s } = await sessionOrder(c, id);
    ensure(
      s.state === 'active' && s.version === b.session_version,
      409,
      'Sesja zakończyła się lub zmieniła wersję',
    );
    bump(s.version);
    if (kind === 'takeover') {
      ensure(!s.valid, 409, 'Nie można przejąć ważnego lease');
      ensure(o.status === 'picking', 409, 'Zamówienie nie jest w kompletacji');
      await noWave(c, o.id);
      await station(c, b.station_id, b.station_version);
      bump(s.lease_generation);
    } else if (kind === 'cancel') {
      const ownLease =
        s.state === 'active' &&
        s.valid &&
        s.owner_id === a.userId &&
        header &&
        s.lease_token_hash === tokenHash(header);
      requiresAdmin = !ownLease;
      if (requiresAdmin)
        ensure(role === 'admin', 403, 'Anulowanie cudzej lub wygasłej sesji wymaga administratora');
      else lease(s, a, header);
    } else {
      lease(s, a, header);
      ensure(o.status === 'picking', 409, 'Zamówienie nie jest w kompletacji');
      await noWave(c, o.id);
      bump(s.lease_generation);
    }
    if (kind !== 'cancel')
      ensure(
        tokenHash(b.lease_token) !== s.lease_token_hash,
        409,
        'Nowy lease wymaga innego tokenu',
      );
    const next = (
      await c.query(
        kind === 'cancel'
          ? `UPDATE packing_sessions SET state='cancelled',version=version+1,finished_at=clock_timestamp() WHERE id=$1 RETURNING *`
          : `UPDATE packing_sessions SET owner_id=$2,station_id=$3,lease_token_hash=$4,version=version+1,lease_generation=lease_generation+1,expires_at=clock_timestamp()+interval '15 minutes' WHERE id=$1 RETURNING *`,
        kind === 'cancel'
          ? [id]
          : [
              id,
              a.userId,
              kind === 'takeover' ? b.station_id : s.station_id,
              tokenHash(b.lease_token),
            ],
      )
    ).rows[0];
    const result = { session: await sessionHead(c, next) };
    await saveOp(c, a, b, target, kind, result, header, id);
    await audit(c, a, `packing.${kind}`, o.id, { session_id: id });
    return { ...result, reused: false, current_role: await late(c, a, requiresAdmin) };
  });
}
export const renewPackingLease = (a: PackingActor, id: string, b: unknown, h?: string) =>
  leaseWrite(a, id, b, 'renew', h);
export const takeoverPackingSession = (a: PackingActor, id: string, b: unknown) =>
  leaseWrite(a, id, b, 'takeover');
export const cancelPackingSession = (a: PackingActor, id: string, b: unknown, h?: string) =>
  leaseWrite(a, id, b, 'cancel', h);
export async function packingSessionDetail(a: PackingActor, id: string, header?: string) {
  return tenantTx(a.tenantId, async (c) => {
    const role = await readRole(c, a);
    const h = await session(c, id, false);
    const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE', [h.order_id])).rows[0];
    const s = await session(c, id, false);
    const f = await physical(c, o);
    const waveId = await wave(c, o.id);
    const valid =
      s.state === 'active' &&
      s.valid &&
      s.owner_id === a.userId &&
      Boolean(header) &&
      s.lease_token_hash === tokenHash(header!);
    const staff = role === 'admin' || role === 'operator';
    const quantity = f.fulfillment.physical.reduce((n: number, r: any) => n + r.quantity, 0),
      scanned = f.fulfillment.physical.reduce((n: number, r: any) => n + r.scanned, 0);
    return {
      current_role: role,
      session: await sessionHead(c, s),
      order: {
        id: o.id,
        number: o.number,
        version: String(o.version),
        status: o.status,
        warehouse_id: o.warehouse_id,
      },
      progress: { quantity, scanned, complete: f.issues.length === 0 },
      current_profile: await profileHead(c, o),
      active_wave_id: waveId,
      blockers: [
        ...f.issues,
        ...(waveId ? ['ACTIVE_PICKING_WAVE'] : []),
        ...(o.status !== 'picking' ? ['ORDER_NOT_PICKING'] : []),
      ],
      can_scan: staff && valid && !waveId && o.status === 'picking',
      can_finish: staff && valid && !waveId && o.status === 'picking' && f.issues.length === 0,
      can_takeover: staff && s.state === 'active' && !s.valid && o.status === 'picking' && !waveId,
    };
  });
}
async function profileHead(c: PoolClient, o: any) {
  const r = await packingReceiptCurrentInTx(c, o);
  return r.profile
    ? {
        revision: r.profile.revision,
        receipt_id: r.profile.receipt_id,
        scope_hash: packingHash(r.receipt.full_snapshot),
        current: r.current,
        stale_reasons: r.stale_reasons,
      }
    : null;
}
function frozenPage(a: PackingActor, rows: any[], q: any, identity: any) {
  const p = decode(q.cursor, { tenant: a.tenantId, ...identity, product_id: q.product_id });
  const start = p?.index ?? 0;
  ensure(
    Number.isInteger(start) && start >= 0 && start <= rows.length,
    422,
    'Nieprawidłowa pozycja kursora',
  );
  const data: any[] = [];
  let end = start;
  let bytes = 0;
  for (; end < rows.length && data.length < 50; end++) {
    const r = rows[end];
    if (q.product_id && r.product_id !== q.product_id) continue;
    const size = Buffer.byteLength(JSON.stringify(r), 'utf8');
    ensure(size < S.PACKING_LIMITS.snapshot_bytes - 65536, 422, 'Wiersz jest zbyt duży');
    if (bytes + size > S.PACKING_LIMITS.snapshot_bytes - 65536) break;
    bytes += size;
    data.push(r);
  }
  return {
    data,
    meta: {
      cursor:
        end < rows.length
          ? cursor({
              binding: packingHash({ tenant: a.tenantId, ...identity, product_id: q.product_id }),
              index: end,
            })
          : null,
    },
  };
}
async function sessionPage(a: PackingActor, id: string, q: any, kind: 'items' | 'allocations') {
  return tenantTx(a.tenantId, async (c) => {
    const role = await readRole(c, a),
      s = await session(c, id, false),
      o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE', [s.order_id])).rows[0],
      f = await physical(c, o);
    const hash = await packingFulfillmentHashInTx(c, o);
    let rows = f.fulfillment[kind === 'items' ? 'physical' : 'allocations'];
    if (kind === 'items' && a.canReadProducts !== false) {
      const current = (
        await c.query('SELECT id,sku,ean FROM products WHERE id=ANY($1::uuid[])', [
          rows.map((r: any) => r.product_id),
        ])
      ).rows;
      const map = new Map(current.map((p) => [p.id, p]));
      rows = rows.map((r: any) => ({
        ...r,
        current_sku: map.get(r.product_id)?.sku ?? null,
        current_ean: map.get(r.product_id)?.ean ?? null,
      }));
    }
    return { current_role: role, ...frozenPage(a, rows, q, { session: id, hash, kind }) };
  });
}
export const packingSessionItems = (a: PackingActor, id: string, q: any) =>
  sessionPage(a, id, q, 'items');
export const packingSessionAllocations = (a: PackingActor, id: string, q: any) =>
  sessionPage(a, id, q, 'allocations');
export async function scanPackingSession(
  a: PackingActor,
  id: string,
  input: unknown,
  header?: string,
) {
  const b = parse(S.packingScanInput, input);
  return tenantTx(a.tenantId, async (c) => {
    await early(c, a);
    await admission(c, a);
    const target = `scan:${id}`,
      replay = await opReplay(c, a, b, target, header);
    if (replay.row)
      return { ...replay.row.result, reused: true, current_role: await readRole(c, a) };
    const { o, s } = await sessionOrder(c, id);
    lease(s, a, header);
    ensure(
      s.version === b.session_version && String(o.version) === b.order_version,
      409,
      'Sesja lub zamówienie zmieniło wersję',
    );
    bump(s.version);
    await noWave(c, o.id);
    const before = await physical(c, o);
    await scan(
      c,
      a,
      o.id,
      b.code,
      b.location,
      {
        session_id: s.id,
        session_version: s.version,
        lease_generation: s.lease_generation,
        lease_token_hash: s.lease_token_hash,
      },
      { layer_id: b.layer_id },
    );
    const after = await physical(c, o);
    const changes = after.fulfillment.physical.filter(
      (p: any) =>
        p.scanned !==
        before.fulfillment.physical.find((v: any) => v.product_id === p.product_id)?.scanned,
    );
    ensure(changes.length === 1, 409, 'Skan musi zmienić dokładnie jeden produkt');
    const p = changes[0],
      prev = before.fulfillment.physical.find((v: any) => v.product_id === p.product_id);
    const allocated = after.fulfillment.allocations.find(
      (x: any) =>
        x.product_id === p.product_id &&
        x.scanned !==
          before.fulfillment.allocations.find(
            (v: any) => v.product_id === x.product_id && v.location === x.location,
          )?.scanned,
    );
    ensure(p.scanned === prev.scanned + 1 && allocated, 409, 'Nieprawidłowy wynik skanu');
    await c.query('UPDATE packing_sessions SET version=version+1 WHERE id=$1', [id]);
    const operation = {
      id: randomUUID(),
      session_id: id,
      order_id: o.id,
      product_id: p.product_id,
      scanned_code: b.code,
      location: allocated.location,
      quantity: p.quantity,
      scanned_before: prev.scanned,
      scanned_after: p.scanned,
      before_session_version: s.version,
      after_session_version: bump(s.version),
      order_version: String(o.version),
      created_at: (await c.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString(),
    };
    const result = { operation };
    await saveOp(c, a, b, target, 'scan', result, header, id);
    return { ...result, reused: false, current_role: await late(c, a) };
  });
}
export async function packingOperationResult(a: PackingActor, key: string) {
  return tenantTx(a.tenantId, async (c) => {
    const role = await readRole(c, a),
      r = (
        await c.query(
          'SELECT id,kind,target_id,result,actor_id,created_at FROM packing_operations WHERE client_key=$1',
          [key],
        )
      ).rows[0];
    ensure(r, 404, 'Operacja nie została zapisana');
    ensure(
      r.actor_id === a.userId || role === 'admin',
      403,
      'Wynik operacji należy do innego operatora',
    );
    const { actor_id, ...operation } = r;
    return { current_role: role, operation };
  });
}
async function preview(c: PoolClient, id: string) {
  const p = (await c.query('SELECT * FROM packing_previews WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu pakowania');
  return p;
}
export async function createPackingPreview(a: PackingActor, input: unknown, header?: string) {
  const b = parse(S.packingPreviewInput, input);
  return tenantTx(a.tenantId, async (c) => {
    await early(c, a);
    await admission(c, a);
    if (b.kind === 'finish') await acquirePackingFieldAdmissionInTx(c,a);
    const hash = requestHash(a, 'preview', safeBody(b, b.kind === 'finish' ? header : undefined));
    const prior = (
      await c.query('SELECT * FROM packing_previews WHERE client_key=$1', [b.client_key])
    ).rows[0];
    if (prior) {
      ensure(
        prior.actor_id === a.userId && prior.source === source(a) && prior.request_hash === hash,
        409,
        'Klucz podglądu obejmuje inny zakres',
      );
      return {
        preview: previewHead(prior),
        reused: true,
        current_role: await late(c, { ...a, requireProductsRead: b.include_product_estimate }),
      };
    }
    await quota(c, 'packing_previews', 2000);
    let o: any,
      s: any = null;
    if (b.kind === 'finish') {
      const pair = await sessionOrder(c, b.session_id);
      o = pair.o;
      s = pair.s;
      lease(s, a, header);
      ensure(s.version === b.session_version, 409, 'Sesja zmieniła wersję');
    } else {
      o = await lockedOrder(c, b.order_id);
      await c.query('SELECT * FROM order_packing_profiles WHERE order_id=$1 FOR UPDATE', [o.id]);
    }
    const full = await snapshot(c, a, b, o, s),
      scope = packingHash(full);
    const p = (
      await c.query(
        `INSERT INTO packing_previews(id,tenant_id,actor_id,client_key,request_hash,source,kind,session_id,order_id,scope_hash,expires_at,ready,issues,full_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp()+interval '5 minutes',$11,$12,$13) RETURNING *`,
        [
          randomUUID(),
          a.tenantId,
          a.userId,
          b.client_key,
          hash,
          source(a),
          b.kind,
          s?.id ?? null,
          o.id,
          scope,
          full.issues.length === 0,
          JSON.stringify(full.issues),
          full,
        ],
      )
    ).rows[0];
    await audit(c, a, 'packing.preview', o.id, { preview_id: p.id, kind: b.kind, ready: p.ready });
    return {
      preview: previewHead(p),
      reused: false,
      current_role: await late(c, { ...a, requireProductsRead: b.include_product_estimate }),
    };
  });
}
function frozenComparable(f: any, original?: any) {
  const { automations_warning, ...rest } = f;
  // Exact legacy zero-requirement preview compatibility; no nonempty/new cut is ignored.
  if (original && !Object.hasOwn(original,'required_order_fields') && rest.required_order_fields?.schema==='packing-required-order-fields/v1' && rest.required_order_fields.complete===true && rest.required_order_fields.fields.length===0) {
    const { required_order_fields, ...legacy } = rest;return legacy;
  }
  return rest;
}
export async function finishPackingPreview(
  a: PackingActor,
  id: string,
  input: unknown,
  header?: string,
) {
  const b = parse(S.packingFinishInput, input);
  return tenantTx(a.tenantId, async (c) => {
    await early(c, a);
    await admission(c, a);
    await acquirePackingFieldAdmissionInTx(c,a);
    const hash = requestHash(a, `finish:${id}`, safeBody(b, header));
    const prior = (
      await c.query('SELECT * FROM packing_receipts WHERE client_key=$1', [b.client_key])
    ).rows[0];
    if (prior) {
      ensure(
        prior.actor_id === a.userId &&
          prior.source === source(a) &&
          prior.request_hash === hash &&
          prior.preview_id === id,
        409,
        'Klucz zakończenia obejmuje inny zakres',
      );
      const head = await receiptHead(c, prior);
      return { receipt: head, result: prior.result, reused: true, current_role: await late(c, a) };
    }
    await quota(c, 'packing_receipts', 2000);
    const p = await preview(c, id);
    ensure(
      p.actor_id === a.userId && p.source === source(a),
      403,
      'Podgląd należy do innego operatora',
    );
    ensure(
      p.scope_hash === b.scope_hash && p.ready,
      409,
      'Podgląd nie jest gotowy lub zgoda obejmuje inny zakres',
    );
    ensure(
      (await c.query('SELECT $1::timestamptz>clock_timestamp() AS valid', [p.expires_at])).rows[0]
        .valid,
      409,
      'Podgląd wygasł',
    );
    const o = await lockedOrder(c, p.order_id);
    let s: any = null;
    if (p.kind === 'finish') {
      s = await session(c, p.session_id);
      lease(s, a, header);
      ensure(s.version === p.full_snapshot.session.version, 409, 'Sesja zmieniła wersję');
    }
    await c.query('SELECT * FROM order_packing_profiles WHERE order_id=$1 FOR UPDATE', [o.id]);
    const frozen = p.full_snapshot,
      current = await snapshot(c, a, frozen.input, o, s);
    ensure(
      packingHash(frozenComparable(current,frozen)) === packingHash(frozenComparable(frozen)) &&
        current.issues.length === 0,
      409,
      'Zakres zamówienia, skanów, finansów lub pomiaru zmienił się',
    );
    const profile = (
      await c.query('SELECT * FROM order_packing_profiles WHERE order_id=$1', [o.id])
    ).rows[0];
    const revision = profile ? bump(profile.revision) : '1';
    const before = String(o.version),
      after = p.kind === 'finish' ? bump(before) : before;
    const receiptId = randomUUID(),
      beforeHash = await packingFulfillmentHashInTx(c, o),
      afterHash = await packingFulfillmentHashInTx(
        c,
        o,
        p.kind === 'finish' ? 'packed' : undefined,
      );
    const result = {
      order_id: o.id,
      status: 'packed',
      before_order_version: before,
      after_order_version: after,
      session_id: s?.id ?? null,
      session_state: s ? 'finished' : null,
      profile_revision: revision,
      receipt_id: receiptId,
    };
    const r = (
      await c.query(
        `INSERT INTO packing_receipts(id,tenant_id,actor_id,preview_id,client_key,request_hash,source,kind,order_id,replaces_receipt_id,profile_revision,before_order_version,after_order_version,before_fulfillment_hash,after_fulfillment_hash,full_snapshot,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [
          receiptId,
          a.tenantId,
          a.userId,
          id,
          b.client_key,
          hash,
          source(a),
          p.kind,
          o.id,
          profile?.receipt_id ?? null,
          revision,
          before,
          after,
          beforeHash,
          afterHash,
          frozen,
          result,
        ],
      )
    ).rows[0];
    await c.query(
      `INSERT INTO order_packing_profiles(tenant_id,order_id,receipt_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,order_id) DO UPDATE SET receipt_id=excluded.receipt_id,revision=excluded.revision`,
      [a.tenantId, o.id, receiptId, revision],
    );
    if (s) {
      bump(s.version);
      await c.query(
        "UPDATE packing_sessions SET state='finished',version=version+1,finished_at=clock_timestamp() WHERE id=$1",
        [s.id],
      );
      await transition(c, a, o.id, 'packed', undefined, {
        packing: {
          receipt_id: receiptId,
          preview_id: id,
          scope_hash: p.scope_hash,
          session_id: s.id,
        },
      });
    }
    await audit(c, a, p.kind === 'finish' ? 'packing.finish' : 'packing.remeasure', o.id, {
      receipt_id: receiptId,
      preview_id: id,
      profile_revision: revision,
    });
    const head = await receiptHead(c, r);
    const role = await late(c, {
      ...a,
      requireProductsRead: frozen.input.include_product_estimate,
    });
    return { receipt: head, result, reused: false, current_role: role };
  });
}
export async function packingPreviewDetail(a: PackingActor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    const role = await readRole(c, a),
      p = await preview(c, id);
    return {
      current_role: role,
      preview: previewHead(p),
      snapshot_summary: summary(p.full_snapshot, a.canReadProducts !== false),
    };
  });
}
async function proofPage(
  a: PackingActor,
  id: string,
  q: any,
  t: 'packing_previews' | 'packing_receipts',
  kind: 'items' | 'allocations',
) {
  return tenantTx(a.tenantId, async (c) => {
    const role = await readRole(c, a),
      r = (await c.query(`SELECT * FROM ${t} WHERE id=$1`, [id])).rows[0];
    ensure(r, 404, 'Nie znaleziono dowodu pakowania');
    const f = r.full_snapshot;
    let rows = f.fulfillment[kind === 'items' ? 'physical' : 'allocations'];
    if (kind === 'items' && a.canReadProducts !== false && f.reference) {
      const map = new Map(f.reference.items.map((v: any) => [v.product_id, v]));
      rows = rows.map((v: any) => ({ ...v, reference: map.get(v.product_id) ?? null }));
    }
    return {
      current_role: role,
      ...frozenPage(a, rows, q, { table: t, id, scope: r.scope_hash ?? packingHash(f), kind }),
    };
  });
}
export const packingPreviewItems = (a: PackingActor, id: string, q: any) =>
  proofPage(a, id, q, 'packing_previews', 'items');
export const packingPreviewAllocations = (a: PackingActor, id: string, q: any) =>
  proofPage(a, id, q, 'packing_previews', 'allocations');
export const packingReceiptItems = (a: PackingActor, id: string, q: any) =>
  proofPage(a, id, q, 'packing_receipts', 'items');
export const packingReceiptAllocations = (a: PackingActor, id: string, q: any) =>
  proofPage(a, id, q, 'packing_receipts', 'allocations');
export async function packingReceipts(a: PackingActor, q: any) {
  return tenantReadTx(a.tenantId, async (c) => {
    const role = await readRole(c, a),
      bind = { tenant: a.tenantId, order_id: q.order_id },
      p = decode(q.cursor, bind);
    const rows = (
      await c.query(
        `SELECT id,preview_id,kind,order_id,actor_id,profile_revision,replaces_receipt_id,before_order_version,after_order_version,before_fulfillment_hash,after_fulfillment_hash,created_at,(SELECT p.scope_hash FROM packing_previews p WHERE p.id=packing_receipts.preview_id) AS scope_hash,jsonb_build_object('order',full_snapshot->'order','station',full_snapshot->'station','packaging',full_snapshot->'packaging','measurements',full_snapshot->'measurements') AS full_snapshot,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') AS cursor_at FROM packing_receipts WHERE ($1::uuid IS NULL OR order_id=$1) AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,
        [q.order_id ?? null, p?.at ?? null, p?.id ?? null],
      )
    ).rows;
    const take = rows.slice(0, 50),
      last = take.at(-1);
    return {
      current_role: role,
      data: await Promise.all(take.map((r) => receiptHead(c, r))),
      meta: {
        cursor:
          rows.length > 50
            ? cursor({ binding: packingHash(bind), at: last.cursor_at + '+00', id: last.id })
            : null,
      },
    };
  });
}
export async function packingReceiptDetail(a: PackingActor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    const role = await readRole(c, a),
      r = (await c.query('SELECT * FROM packing_receipts WHERE id=$1', [id])).rows[0];
    ensure(r, 404, 'Nie znaleziono dowodu pomiaru');
    return {
      current_role: role,
      receipt: await receiptHead(c, r),
      snapshot_summary: summary(r.full_snapshot, a.canReadProducts !== false),
      result: r.result,
    };
  });
}
export async function orderPackingProfile(a: PackingActor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    const role = await readRole(c, a),
      o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE', [id])).rows[0];
    ensure(o, 404, 'Nie znaleziono zamówienia');
    return { current_role: role, profile: await profileHead(c, o) };
  });
}
