/** The organisation's audit log (SEC-009, migration 238): every audit write keeps the API key behind a
 * key-authenticated action (audit238_event_keys, keyed by the event id), and administrators read the log
 * with its author, filters, a keyset cursor and a CSV export. Reads run under the tenant's RLS; names of
 * people and keys are resolved afterwards for the rows of the page only. */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantReadTx, tenantTx } from './db';
import { ensure } from './errors';
import { auditActionLabel, auditChanges } from './audit-labels';
import { KEYSET_AT, keysetAfter, keysetCursor } from './keyset-cursor';

type Querier = Pick<PoolClient, 'query'>;
export interface AuditWriter {
  tenantId: string;
  userId: string | null;
  apiKeyId?: string;
}
// Once installed the table never goes away; an older restored copy is asked again (key actions only).
let keyTable = false;
async function keyTableInstalled(c: Querier): Promise<boolean> {
  if (!keyTable)
    keyTable = (await c.query("SELECT to_regclass('public.audit238_event_keys') IS NOT NULL AS present")).rows[0]?.present === true;
  return keyTable;
}
const insertEvent = 'INSERT INTO audit_events(id,tenant_id,user_id,action,entity_id,detail) VALUES($1,$2,$3,$4,$5,$6)';
/** One audit event; a key-authenticated actor also leaves its key, in the same statement and time. */
export async function insertAuditEvent(c: PoolClient, a: AuditWriter, action: string, id: string | null, detail: unknown = {}): Promise<void> {
  const values = [randomUUID(), a.tenantId, a.userId, action, id, JSON.stringify(detail)];
  if (a.apiKeyId && (await keyTableInstalled(c))) {
    await c.query(
      `WITH e AS (${insertEvent} RETURNING id,tenant_id,created_at)
       INSERT INTO audit238_event_keys(event_id,tenant_id,api_key_id,created_at) SELECT id,tenant_id,$7,created_at FROM e`,
      [...values, a.apiKeyId],
    );
    return;
  }
  await c.query(insertEvent, values);
}

const DAY = /^\d{4}-\d\d-\d\d$/;
/** Midnight in Warsaw that starts the given day (at 00:00 UTC Warsaw is already on that day's offset). */
function warsawStart(day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', hourCycle: 'h23' }).format(new Date(utc)));
  return new Date(utc - hour * 3600000);
}
/** from: the instant or the start of that Warsaw day; to: exclusive, a whole day includes that day. */
const nextDay = (day: string): string => new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
const bound = (value: string, end: boolean): string =>
  DAY.test(value) ? warsawStart(end ? nextDay(value) : value).toISOString() : value;
const instant = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const filters = {
  user_id: z.uuid().optional(),
  api_key_id: z.uuid().optional(),
  entity_id: z.uuid().optional(),
  source: z.enum(['user', 'api_key', 'system']).optional(),
  // An area ("order") or an exact code ("order.status"); codes are lower-case words joined by dots.
  action: z.string().regex(/^[a-z0-9_][a-z0-9_.-]{0,99}$/).optional(),
  from: instant.optional(),
  to: instant.optional(),
};
const ordered = (q: { from?: string; to?: string }) => !q.from || !q.to || Date.parse(bound(q.from, false)) < Date.parse(bound(q.to, true));
const range = { message: 'Początek zakresu dat musi być przed jego końcem', path: ['to'] };
const listQuery = z
  .strictObject({ ...filters, after: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
  .refine(ordered, range);
const exportQuery = z.strictObject(filters).refine(ordered, range);
type Filters = z.infer<typeof exportQuery>;
const EXPORT_LIMIT = 10000;

interface AuditRow {
  id: string;
  created_at: Date;
  user_id: string | null;
  action: string;
  entity_id: string | null;
  detail: unknown;
  api_key_id: string | null;
  cursor_at: string;
}
async function readRows(c: Querier, tenantId: string, q: Filters, after: { at: string | null; id: string | null }, limit: number): Promise<AuditRow[]> {
  const keys = await keyTableInstalled(c);
  return (
    await c.query(
      `SELECT e.id,e.created_at,e.user_id,e.action,e.entity_id,e.detail,${keys ? 'k.api_key_id' : 'NULL::uuid AS api_key_id'},${KEYSET_AT} AS cursor_at
       FROM audit_events e ${keys ? 'LEFT JOIN audit238_event_keys k ON k.event_id=e.id' : ''}
       WHERE e.tenant_id=$1 AND ($2::uuid IS NULL OR e.user_id=$2) AND ($3::uuid IS NULL OR ${keys ? 'k.api_key_id=$3' : 'false'})
         AND ($4::uuid IS NULL OR e.entity_id=$4) AND ($5::text IS NULL OR e.action=$5 OR left(e.action,length($5)+1)=$5||'.')
         AND ($6::timestamptz IS NULL OR e.created_at>=$6) AND ($7::timestamptz IS NULL OR e.created_at<$7)
         AND ($8::text IS NULL OR CASE $8::text WHEN 'system' THEN e.user_id IS NULL WHEN 'api_key' THEN ${keys ? 'k.api_key_id IS NOT NULL' : 'false'}
           ELSE e.user_id IS NOT NULL${keys ? ' AND k.api_key_id IS NULL' : ''} END)
         AND ($9::timestamptz IS NULL OR (e.created_at,e.id)<($9::timestamptz,$10::uuid))
       ORDER BY e.created_at DESC,e.id DESC LIMIT $11`,
      [tenantId, q.user_id ?? null, q.api_key_id ?? null, q.entity_id ?? null, q.action ?? null,
        q.from ? bound(q.from, false) : null, q.to ? bound(q.to, true) : null, q.source ?? null, after.at, after.id, limit],
    )
  ).rows;
}
export interface AuditAuthor {
  kind: 'user' | 'api_key' | 'system';
  user_id: string | null;
  name: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  api_key_prefix: string | null;
}
/** Names of the people and keys of these rows only (users and api_keys are read by the owner connection). */
async function authors(tenantId: string, rows: AuditRow[]): Promise<(r: AuditRow) => AuditAuthor> {
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((x): x is string => !!x))];
  const keyIds = [...new Set(rows.map((r) => r.api_key_id).filter((x): x is string => !!x))];
  const users = new Map<string, string>(userIds.length
    ? (await pool.query('SELECT id,name FROM users WHERE id=ANY($1::uuid[])', [userIds])).rows.map((u) => [u.id, u.name]) : []);
  const keys = new Map<string, { name: string; prefix: string }>(keyIds.length
    ? (await pool.query('SELECT id,name,prefix FROM api_keys WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [tenantId, keyIds])).rows.map((k) => [k.id, k]) : []);
  return (r) => ({
    kind: r.api_key_id ? 'api_key' : r.user_id ? 'user' : 'system',
    user_id: r.user_id,
    name: r.user_id ? users.get(r.user_id) ?? null : null,
    api_key_id: r.api_key_id,
    api_key_name: r.api_key_id ? keys.get(r.api_key_id)?.name ?? null : null,
    api_key_prefix: r.api_key_id ? keys.get(r.api_key_id)?.prefix ?? null : null,
  });
}
function adminSession(req: FastifyRequest): void {
  ensure(req.actor.role === 'admin' && !req.actor.apiKeyId && req.apiScopes === undefined, 403, 'Wymagana rola administratora');
}
const cell = (v: string): string => {
  const s = /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const utc = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
const keyLabel = (a: AuditAuthor) => (a.api_key_id ? (a.api_key_name ?? 'usunięty klucz') + (a.api_key_prefix ? ' (' + a.api_key_prefix + '…)' : '') : '');

export function registerAuditRoutes(app: FastifyInstance, options: { readOnly: boolean }): void {
  app.get('/api/audit', async (req) => {
    adminSession(req);
    const q = listQuery.parse(req.query), after = keysetAfter(q.after, 'Niepoprawny kursor dziennika');
    const rows = await tenantReadTx(req.actor.tenantId, (c) => readRows(c, req.actor.tenantId, q, after, q.limit + 1));
    const page = rows.slice(0, q.limit), author = await authors(req.actor.tenantId, page), last = rows.length > q.limit ? page.at(-1) : undefined;
    return {
      data: page.map((r) => ({ id: r.id, created_at: r.created_at, action: r.action, entity_id: r.entity_id, detail: r.detail, author: author(r) })),
      meta: { cursor: last ? keysetCursor(last.cursor_at, last.id) : null },
    };
  });
  // Filter choices: the current members and the organisation's keys (prefix only, never a secret).
  app.get('/api/audit/authors', async (req) => {
    adminSession(req);
    const [members, keys] = await Promise.all([
      pool.query('SELECT u.id,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.name,u.id', [req.actor.tenantId]),
      pool.query('SELECT id,name,prefix,revoked_at FROM api_keys WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200', [req.actor.tenantId]),
    ]);
    return { members: members.rows, api_keys: keys.rows };
  });
  // CSV of the filtered log (newest first, at most 10 000 rows); the export itself is audited.
  app.get('/api/audit/export', async (req, reply) => {
    adminSession(req);
    const q = exportQuery.parse(req.query), none = { at: null, id: null };
    const read = async (c: PoolClient) => {
      const rows = await readRows(c, req.actor.tenantId, q, none, EXPORT_LIMIT + 1);
      const truncated = rows.length > EXPORT_LIMIT, kept = rows.slice(0, EXPORT_LIMIT);
      if (!options.readOnly) await insertAuditEvent(c, req.actor, 'audit.exported', null, { rows: kept.length, truncated, filters: q });
      return { kept, truncated };
    };
    const { kept, truncated } = options.readOnly ? await tenantReadTx(req.actor.tenantId, read) : await tenantTx(req.actor.tenantId, read);
    const author = await authors(req.actor.tenantId, kept);
    const lines = [['Czas (UTC)', 'Autor', 'Klucz API', 'Operacja', 'Kod operacji', 'Obiekt', 'Zmiany', 'Szczegóły']];
    for (const r of kept) {
      const a = author(r);
      lines.push([utc(r.created_at), a.kind === 'system' ? 'System' : a.name ?? '—', keyLabel(a), auditActionLabel(r.action), r.action,
        r.entity_id ?? '', auditChanges(r.detail).join(', '), JSON.stringify(r.detail)]);
    }
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date()).replaceAll('-', '');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="dziennik-audytu-${day}.csv"`)
      .header('cache-control', 'no-store')
      .header('x-audit-truncated', String(truncated))
      .send('﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n') + '\r\n');
  });
}
