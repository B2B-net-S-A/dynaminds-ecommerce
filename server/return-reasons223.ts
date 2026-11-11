/** Native 223 tenant dictionary of return reasons (return_reasons223) and the
 * reason chosen for a return case (return_case_reasons223). The case's free-text
 * reason stays the native return_cases.reason; a case without a dictionary choice
 * is "other". A reason is never deleted: renames keep its UUID and numeric
 * public_id (Base return_reason_id), deactivation hides it from new choices. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { audit, type Actor, type AuditActor } from './domain';
import { ensure } from './errors';

/** LOCAL ceiling of one company's dictionary. */
export const RETURN_REASONS223_LIMIT = 100;
const name = z.string().trim().min(3).max(120);
const position = z.number().int().min(0).max(999);
export const returnReasonCreateInput = z.strictObject({ name, position: position.optional() });
export const returnReasonUpdateInput = z.strictObject({
  version: z.number().int().positive(),
  name: name.optional(),
  active: z.boolean().optional(),
  position: position.optional(),
}).refine((v) => v.name !== undefined || v.active !== undefined || v.position !== undefined, 'Podaj zmianę powodu');
export const returnReasonListQuery = z.strictObject({ include_inactive: z.enum(['true', 'false']).optional() });

export type ReturnReason = { id: string; public_id: number; name: string; active: boolean; position: number; version: number;
  created_at: string; updated_at: string };
export type ReturnReasonChoice = { reason_id: string; public_id: number; name: string; active: boolean };

export async function returnReasons223Available(c: Pool | PoolClient): Promise<boolean> {
  return Boolean((await c.query(`SELECT to_regclass('public.return_reasons223') IS NOT NULL
    AND to_regclass('public.return_case_reasons223') IS NOT NULL
    AND to_regprocedure('public.return_reasons223_guard()') IS NOT NULL AS available`)).rows[0]?.available);
}
async function requireAvailable(c: PoolClient) {
  ensure(await returnReasons223Available(c), 503, 'Słownik powodów zwrotu jest niedostępny w tej bazie');
}
const row = (r: any): ReturnReason => ({ id: r.id, public_id: Number(r.public_id), name: r.name, active: r.active, position: r.position,
  version: r.version, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString() });
const COLUMNS = 'id,public_id::text AS public_id,name,active,position,version,created_at,updated_at';
const unique = (e: any) => e?.code === '23505' && /return_reasons223_name/.test(e?.constraint ?? '');

/** Current tenant's reasons by position, then public ID. */
export async function listReturnReasons(c: PoolClient, opts: { includeInactive?: boolean } = {}) {
  await requireAvailable(c);
  const rows = (await c.query(`SELECT ${COLUMNS} FROM return_reasons223 WHERE ($1 OR active) ORDER BY position,public_id`,
    [opts.includeInactive === true])).rows;
  return rows.map(row);
}

function manager(a: Actor) {
  ensure(a.role === 'admin', 403, 'Słownik powodów zwrotu zmienia administrator');
}
async function insertable(c: PoolClient, sql: string, params: unknown[]) {
  await c.query('SAVEPOINT return_reason223');
  try {
    const r = (await c.query(sql, params)).rows[0];
    await c.query('RELEASE SAVEPOINT return_reason223');
    return r;
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT return_reason223');
    ensure(!unique(e), 409, 'Powód zwrotu o tej nazwie już istnieje');
    throw e;
  }
}

export async function createReturnReason(c: PoolClient, a: Actor, raw: unknown) {
  manager(a);
  const b = returnReasonCreateInput.parse(raw);
  await requireAvailable(c);
  // One writer per company dictionary: the count ceiling and default position are exact.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['return_reasons223:' + a.tenantId]);
  const head = (await c.query('SELECT count(*)::int n,coalesce(max(position)+1,0)::int next FROM return_reasons223')).rows[0];
  ensure(head.n < RETURN_REASONS223_LIMIT, 409, `Słownik może mieć najwyżej ${RETURN_REASONS223_LIMIT} powodów`);
  const r = await insertable(c, `INSERT INTO return_reasons223(tenant_id,id,name,active,position,version,created_by)
    VALUES($1,$2,$3,true,$4,1,$5) RETURNING ${COLUMNS}`, [a.tenantId, randomUUID(), b.name, b.position ?? Math.min(head.next, 999), a.userId]);
  const saved = row(r);
  await audit(c, a, 'return_reason.create', saved.id, { public_id: saved.public_id, name: saved.name, position: saved.position });
  return saved;
}

export async function updateReturnReason(c: PoolClient, a: Actor, id: string, raw: unknown) {
  manager(a);
  const reasonId = z.uuid().parse(id).toLowerCase(), b = returnReasonUpdateInput.parse(raw);
  await requireAvailable(c);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['return_reasons223:' + a.tenantId]);
  const current = (await c.query(`SELECT ${COLUMNS} FROM return_reasons223 WHERE id=$1 FOR UPDATE`, [reasonId])).rows[0];
  ensure(current, 404, 'Nie znaleziono powodu zwrotu');
  ensure(current.version === b.version, 409, 'Powód zmieniono w innym oknie. Odśwież listę.');
  const next = { name: b.name ?? current.name, active: b.active ?? current.active, position: b.position ?? current.position };
  if (next.name === current.name && next.active === current.active && next.position === current.position) return row(current);
  const r = await insertable(c, `UPDATE return_reasons223 SET name=$2,active=$3,position=$4,version=version+1,updated_at=clock_timestamp()
    WHERE id=$1 RETURNING ${COLUMNS}`, [reasonId, next.name, next.active, next.position]);
  const saved = row(r);
  await audit(c, a, 'return_reason.update', saved.id, { public_id: saved.public_id,
    before: { name: current.name, active: current.active, position: current.position }, after: next });
  return saved;
}

/** Inside requestReturn after the case row: an active own reason, recorded with its current name. */
export async function attachReturnReasonInTx(c: PoolClient, a: AuditActor, returnId: string, reasonId: string) {
  await requireAvailable(c);
  ensure(a.userId, 422, 'Powód z listy wybiera użytkownik firmy');
  const r = (await c.query('SELECT id,public_id::text AS public_id,name,active FROM return_reasons223 WHERE id=$1 FOR SHARE', [reasonId.toLowerCase()])).rows[0];
  ensure(r, 404, 'Nie znaleziono powodu zwrotu');
  ensure(r.active, 422, 'Powód zwrotu jest nieaktywny');
  await c.query('INSERT INTO return_case_reasons223(tenant_id,return_id,reason_id,reason_name,actor_id) VALUES($1,$2,$3,$4,$5)',
    [a.tenantId, returnId, r.id, r.name, a.userId]);
  return { reason_id: r.id as string, public_id: Number(r.public_id), name: r.name as string };
}

/** Dictionary choice per case (current name and state; the snapshot name is kept in the row). */
export async function returnReasonChoicesInTx(c: PoolClient, returnIds: string[]): Promise<Map<string, ReturnReasonChoice>> {
  if (!returnIds.length || !(await returnReasons223Available(c))) return new Map();
  const rows = (await c.query(`SELECT x.return_id,r.id,r.public_id::text AS public_id,r.name,r.active FROM return_case_reasons223 x
    JOIN return_reasons223 r ON(r.tenant_id,r.id)=(x.tenant_id,x.reason_id) WHERE x.return_id=ANY($1::uuid[])`, [returnIds])).rows;
  return new Map(rows.map((r) => [r.return_id as string, { reason_id: r.id, public_id: Number(r.public_id), name: r.name, active: r.active }]));
}
