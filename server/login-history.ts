/** Login history with failed attempts (SEC-005) and the durable failed-password lock (SEC-012), migration 237.
 * A login is keyed by an HMAC of the normalised e-mail (key derived from the installation's encryptionKey), the
 * same for known and unknown addresses: the lock, the answer and the work done do not reveal whether an
 * account exists, and the table holds neither the address nor an unkeyed hash that a copy could test. */
import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { localConfig, pool } from './db';
import { ensure } from './errors';
import { ownedSession } from './account-security';
import { authTx } from './workspace-routes';
import { KEYSET_AT, keysetAfter, keysetCursor } from './keyset-cursor';

const LOGIN_OUTCOMES = ['success', 'password_failed', 'mfa_failed', 'password_locked', 'mfa_locked', 'refused', 'password_reset'] as const;
export type LoginOutcome = (typeof LOGIN_OUTCOMES)[number];
export type FactorOutcome = 'mfa_failed' | 'mfa_locked';
type Querier = Pick<PoolClient, 'query'>;
interface LoginContext {
  ip: string | null;
  userAgent: string | null;
}
/** Same text for every locked login, whether or not an account exists. */
export const LOGIN_LOCKED_MESSAGE =
  'Logowanie jest chwilowo zablokowane po kolejnych nieudanych próbach. Spróbuj ponownie za kilka minut albo odzyskaj hasło.';

export function loginSubject(email: string): string {
  return createHmac('sha256', 'auth237:' + localConfig.encryptionKey)
    .update(email.trim().toLowerCase())
    .digest('hex');
}
function context(req: FastifyRequest): LoginContext {
  const agent = req.headers['user-agent'];
  return { ip: req.ip ? req.ip.slice(0, 64) : null, userAgent: typeof agent === 'string' ? agent.slice(0, 300) : null };
}
async function record(
  c: Querier,
  ctx: LoginContext,
  subject: string,
  outcome: LoginOutcome,
  status: number,
  userId?: string | null,
  tenantId?: string | null,
): Promise<void> {
  await c.query('SELECT public.auth237_record_login($1,$2,$3,$4,$5,$6,$7)', [
    userId ?? null,
    tenantId ?? null,
    subject,
    outcome,
    status,
    ctx.ip,
    ctx.userAgent,
  ]);
}
export async function loginHistoryInstalled(c: Querier): Promise<boolean> {
  return (
    (await c.query("SELECT to_regprocedure('public.auth237_record_login(uuid,uuid,text,text,integer,text,text)') IS NOT NULL AS present"))
      .rows[0]?.present === true
  );
}

export interface LoginAttempt {
  /** Counts this attempt against the login; false when the login is locked (nothing counted). */
  reserve(): Promise<boolean>;
  /** The right password: the counter of this login is removed. */
  passed(): Promise<void>;
  record(c: Querier, outcome: LoginOutcome, status: number, userId?: string | null, tenantId?: string | null): Promise<void>;
  readonly recorded: boolean;
}
/** One /api/auth/login request. Every query runs the same way for a known and an unknown address. */
export function loginAttempt(req: FastifyRequest, email: string): LoginAttempt {
  const subject = loginSubject(email),
    ctx = context(req);
  let recorded = false;
  return {
    async reserve() {
      return (await pool.query('SELECT allowed FROM public.auth237_login_attempt($1)', [subject])).rows[0].allowed === true;
    },
    async passed() {
      await pool.query('DELETE FROM public.auth237_login_throttle WHERE subject_hash=$1', [subject]);
    },
    async record(c, outcome, status, userId, tenantId) {
      recorded = true;
      await record(c, ctx, subject, outcome, status, userId, tenantId);
    },
    get recorded() {
      return recorded;
    },
  };
}
/** A completed password reset proves the mailbox: it is recorded and clears the login lock. */
export async function recordPasswordReset(c: Querier, req: FastifyRequest, user: { id: string; email: string }): Promise<void> {
  if (!(await loginHistoryInstalled(c))) return;
  const subject = loginSubject(user.email);
  await c.query('DELETE FROM public.auth237_login_throttle WHERE subject_hash=$1', [subject]);
  await record(c, context(req), subject, 'password_reset', 200, user.id);
}

const columns = 'e.id,e.created_at,e.outcome,e.status,e.ip,e.user_agent';
const membersQuery = z.strictObject({
  user_id: z.uuid().optional(),
  outcome: z.enum(LOGIN_OUTCOMES).optional(),
  after: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
// Both lists show only the retention window, also before the bounded purge in auth237_record_login caught up.
export function registerLoginHistoryRoutes(app: FastifyInstance, cookieName: string): void {
  // The account owner: every event of the own account, also failures and other organisations.
  app.get('/api/auth/security/logins', async (req) =>
    authTx(async (c) => {
      const { user } = await ownedSession(c, req, cookieName);
      const data = (
        await c.query(
          `SELECT ${columns},t.name AS tenant_name FROM auth237_login_events e LEFT JOIN tenants t ON t.id=e.tenant_id
      WHERE e.user_id=$1 AND e.created_at>clock_timestamp()-interval '90 days' ORDER BY e.created_at DESC,e.id DESC LIMIT 50`,
          [user.id],
        )
      ).rows;
      return { data, retention_days: 90 };
    }),
  );
  // An administrator: the current members' account events and their sign-ins into this organisation only.
  // Pages of 50 with a keyset cursor and a person/outcome filter (238), so a burst of attempts on one login
  // cannot push the other members' events out of reach.
  app.get('/api/workspaces/security/logins', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const q = membersQuery.parse(req.query), after = keysetAfter(q.after, 'Niepoprawny kursor historii logowań');
    const [events, members] = await Promise.all([
      pool.query(
        `SELECT ${columns},u.name AS user_name,u.email AS user_email,${KEYSET_AT} AS cursor_at FROM auth237_login_events e
      JOIN memberships m ON m.user_id=e.user_id AND m.tenant_id=$1 JOIN users u ON u.id=e.user_id
      WHERE (e.tenant_id IS NULL OR e.tenant_id=$1) AND e.created_at>clock_timestamp()-interval '90 days'
        AND ($2::uuid IS NULL OR e.user_id=$2) AND ($3::text IS NULL OR e.outcome=$3)
        AND ($4::timestamptz IS NULL OR (e.created_at,e.id)<($4::timestamptz,$5::uuid))
      ORDER BY e.created_at DESC,e.id DESC LIMIT $6`,
        [req.actor.tenantId, q.user_id ?? null, q.outcome ?? null, after.at, after.id, q.limit + 1],
      ),
      pool.query('SELECT u.id,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.name,u.id', [req.actor.tenantId]),
    ]);
    const rows = events.rows.slice(0, q.limit), last = events.rows.length > q.limit ? rows.at(-1) : undefined;
    return {
      data: rows.map(({ cursor_at: _, ...e }) => e),
      members: members.rows,
      retention_days: 90,
      meta: { cursor: last ? keysetCursor(last.cursor_at, last.id) : null },
    };
  });
}
