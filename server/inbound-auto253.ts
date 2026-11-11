/** COM-005 (migration 245): periodic IMAP reading and automatic assignment of replies.
 * - A schedule per account (inbound253_schedules) runs as the administrator who enabled it. Every run re-reads that
 *   person's role; without admin the schedule stops ('refused'). All mailbox work goes through the 141 functions
 *   (prepare → import → bind) exactly as a person would do it, so their checks, ledger and audit apply.
 * - The matcher binds only on evidence: our own Message-ID (<email_messages.id@dynaminds.local>) in In-Reply-To,
 *   then in References (both only from the order's buyer or that email's recipient), then an order number in the subject sent from that order's own e-mail address. More than
 *   one order = 'ambiguous', nothing = 'none'; both stay unassigned for a person. Every decision is recorded in
 *   inbound253_matches with the method and evidence. */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import {
  bindInboundEmail,
  importInboundEmail,
  inboundAccounts,
  inboundMessage,
  prepareInboundEmail,
  type EmailInboundActor,
} from './email-inbound';

type Row = Record<string, any>;
export type MatchMethod = 'in_reply_to' | 'references' | 'subject_number';
export interface MatchDecision {
  outcome: 'bound' | 'ambiguous' | 'none';
  method: MatchMethod | null;
  order_id: string | null;
  candidates: number;
}
export interface AcquireDeps {
  /** Reads new mail of the account as the schedule's actor and imports it; returns the imported message ids. */
  acquire?: (a: EmailInboundActor, accountId: string) => Promise<string[]>;
}

export const inboundScheduleInput = z.strictObject({
  enabled: z.boolean(),
  interval_minutes: z.number().int().min(5).max(1440),
  auto_bind: z.boolean(),
  version: z.number().int().min(0),
});
const OWN_ID = /<([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@dynaminds\.local>/gi;
const MAX_REFERENCES = 20;

/** UUIDs of our own outgoing messages named in In-Reply-To and References (at most 20 references). */
export function ownMessageIds(h: { in_reply_to: string | null; references: string[] }): { in_reply_to: string[]; references: string[] } {
  const ids = (s: string) => [...s.matchAll(OWN_ID)].map((m) => m[1].toLowerCase());
  const references: string[] = [];
  for (const r of h.references ?? []) for (const id of ids(r)) if (references.length < MAX_REFERENCES && !references.includes(id)) references.push(id);
  return { in_reply_to: h.in_reply_to ? [...new Set(ids(h.in_reply_to))] : [], references };
}
/** Tokens of a subject that can be order numbers: 4–40 characters of letters, digits, '-', '/', '_' with a digit. */
export function subjectOrderTokens(subject: string): string[] {
  const out: string[] = [];
  for (const m of (subject ?? '').matchAll(/[A-Za-z0-9][A-Za-z0-9/_-]{2,38}[A-Za-z0-9]/g))
    if (/[0-9]/.test(m[0]) && !out.includes(m[0]) && out.length < 10) out.push(m[0]);
  return out;
}
export function decideMatch(input: { replyOrders: string[]; referenceOrders: string[]; subjectOrders: string[] }): MatchDecision {
  const steps: [MatchMethod, string[]][] = [
    ['in_reply_to', input.replyOrders],
    ['references', input.referenceOrders],
    ['subject_number', input.subjectOrders],
  ];
  for (const [method, list] of steps) {
    const unique = [...new Set(list)];
    if (unique.length === 1) return { outcome: 'bound', method, order_id: unique[0], candidates: 1 };
    if (unique.length > 1) return { outcome: 'ambiguous', method, order_id: null, candidates: unique.length };
  }
  return { outcome: 'none', method: null, order_id: null, candidates: 0 };
}
export function nextRunAt(now: Date, intervalMinutes: number): Date {
  return new Date(now.getTime() + intervalMinutes * 60000);
}

async function available(c: Pick<import('pg').PoolClient, 'query'> = pool) {
  return (await c.query("SELECT to_regclass('public.inbound253_schedules') IS NOT NULL AND to_regclass('public.inbound253_matches') IS NOT NULL ok")).rows[0]?.ok === true;
}
async function requireAvailable() {
  ensure(await available(), 409, 'Automatyczny odbiór IMAP wymaga migracji 245; ta kopia bazy jej nie ma');
}
const admin = (a: EmailInboundActor) => ensure(a.role === 'admin' && !a.apiKeyId, 403, 'Harmonogram odbioru ustawia administrator w sesji');
const scheduleView = (r: Row) => ({ ...r, lease_token: undefined });

export async function inboundSchedules(a: EmailInboundActor) {
  admin(a);
  if (!(await available())) return { available: false, data: [] };
  const accounts = (await inboundAccounts(a)).data as Row[];
  const rows = await tenantTx(a.tenantId, async (c) => (await c.query('SELECT * FROM inbound253_schedules ORDER BY created_at,account_id')).rows);
  return {
    available: true,
    data: accounts.map((acc) => {
      const s = rows.find((r) => r.account_id === acc.id);
      return { account_id: acc.id, account_name: acc.name, account_enabled: acc.enabled, ...(s ? scheduleView(s) : { enabled: false, interval_minutes: 15, auto_bind: true, version: 0 }) };
    }),
  };
}
export async function saveInboundSchedule(a: EmailInboundActor, accountId: string, input: unknown) {
  admin(a);
  const b = inboundScheduleInput.parse(input);
  await requireAvailable();
  const acc = ((await inboundAccounts(a)).data as Row[]).find((x) => x.id === accountId);
  ensure(acc, 404, 'Nie znaleziono konta IMAP');
  return tenantTx(a.tenantId, async (c) => {
    const cur = (await c.query('SELECT version FROM inbound253_schedules WHERE account_id=$1 FOR UPDATE', [accountId])).rows[0];
    ensure((cur?.version ?? 0) === b.version, 409, 'Harmonogram zmienił się w międzyczasie. Odśwież widok.');
    const row = (
      await c.query(
        `INSERT INTO inbound253_schedules(tenant_id,account_id,enabled,interval_minutes,auto_bind,actor_id,next_run_at)
         VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $3 THEN now() END)
         ON CONFLICT (tenant_id,account_id) DO UPDATE SET enabled=EXCLUDED.enabled,interval_minutes=EXCLUDED.interval_minutes,
           auto_bind=EXCLUDED.auto_bind,actor_id=EXCLUDED.actor_id,
           next_run_at=CASE WHEN EXCLUDED.enabled THEN coalesce(least(inbound253_schedules.next_run_at,now()+make_interval(mins=>EXCLUDED.interval_minutes)),now()) END,
           version=inbound253_schedules.version+1,updated_at=now()
         RETURNING *`,
        [a.tenantId, accountId, b.enabled, b.interval_minutes, b.auto_bind, a.userId],
      )
    ).rows[0];
    await audit(c, a, 'email.inbound.schedule', accountId, { enabled: b.enabled, interval_minutes: b.interval_minutes, auto_bind: b.auto_bind });
    return { schedule: scheduleView(row) };
  });
}
export async function inboundMatches(a: EmailInboundActor) {
  admin(a);
  if (!(await available())) return { available: false, data: [] };
  return tenantTx(a.tenantId, async (c) => ({
    available: true,
    data: (
      await c.query(
        'SELECT x.*,o.number order_number FROM inbound253_matches x LEFT JOIN orders o ON o.id=x.order_id ORDER BY x.created_at DESC,x.message_id LIMIT 50',
      )
    ).rows,
  }));
}

async function defaultAcquire(a: EmailInboundActor, accountId: string): Promise<string[]> {
  const acc = ((await inboundAccounts(a)).data as Row[]).find((x) => x.id === accountId);
  ensure(acc?.enabled, 409, 'Konto IMAP jest wyłączone');
  const started = await prepareInboundEmail(a, accountId, {
    client_key: randomUUID(),
    account_version: String(acc.version),
    after_uid: acc.last_uid ?? null,
    expected_uidvalidity: acc.uidvalidity ?? null,
    limit: 20,
    confirmed_read: true,
  });
  const p = started.preview as Row | null;
  if (!p || !p.rows?.length) return [];
  const imported = await importInboundEmail(a, p.id, { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true });
  return (imported as Row).import.message_ids as string[];
}

/**
 * Orders of our sent e-mails (ids from In-Reply-To / References) that this sender may answer. Our Message-ID counts only
 * when the sender is the order's buyer or the recipient of that email: a forwarded thread answered by a third party keeps
 * our id in References and must not land on someone else's order. A team e-mail of an automation (snapshot.team_user_id)
 * went to staff, so a staff reply to it is never a buyer message of the order.
 */
export async function repliedOrdersInTx(c: PoolClient, list: string[], from: string): Promise<string[]> {
  if (!list.length) return [];
  return (
    await c.query(
      `SELECT m.order_id FROM email_messages m JOIN orders o ON o.id=m.order_id
       WHERE m.id=ANY($1::uuid[]) AND m.state IN ('smtp_accepted','simulated','uncertain') AND NOT m.snapshot ? 'team_user_id'
         AND lower($2) IN (lower(o.email),lower(coalesce(m.payload->>'recipient','')))`,
      [list, from],
    )
  ).rows.map((r) => r.order_id);
}

/** Decides one imported message and binds it when exactly one order matches. Returns true when bound. */
async function matchOne(a: EmailInboundActor, accountId: string, messageId: string): Promise<boolean> {
  const m = (await inboundMessage(a, messageId)).message as Row;
  const done = await tenantTx(a.tenantId, async (c) => (await c.query('SELECT 1 FROM inbound253_matches WHERE message_id=$1', [messageId])).rowCount);
  if (m.state !== 'unassigned' || done) return false;
  const h = m.headers as { in_reply_to: string | null; references: string[]; subject: string; from: { address: string } };
  const ids = ownMessageIds(h), tokens = subjectOrderTokens(h.subject);
  const found = await tenantTx(a.tenantId, async (c) => {
    const sent = (list: string[]) => repliedOrdersInTx(c, list, h.from?.address ?? '');
    return {
      replyOrders: await sent(ids.in_reply_to),
      referenceOrders: await sent(ids.references),
      subjectOrders: tokens.length
        ? (await c.query('SELECT id FROM orders WHERE number=ANY($1::text[]) AND lower(email)=lower($2)', [tokens, h.from?.address ?? ''])).rows.map((r) => r.id)
        : [],
    };
  });
  const d = decideMatch(found);
  const evidence =
    d.method === 'in_reply_to' ? 'In-Reply-To: ' + ids.in_reply_to.join(', ')
    : d.method === 'references' ? 'References: ' + ids.references.join(', ')
    : d.method === 'subject_number' ? 'Temat: ' + tokens.join(', ') + '; nadawca = adres zamówienia'
    : '';
  let outcome: string = d.outcome, bindingId: string | null = null, note = evidence;
  if (d.outcome === 'bound') {
    try {
      const o = await tenantTx(a.tenantId, async (c) => (await c.query('SELECT version FROM orders WHERE id=$1', [d.order_id])).rows[0]);
      const r = await bindInboundEmail(a, messageId, { client_key: randomUUID(), version: String(m.version), order_id: d.order_id!, order_version: String(o.version), confirmed: true });
      bindingId = (r.binding as Row).id;
    } catch (e) {
      outcome = 'failed';
      note = (evidence + '; ' + (e instanceof Problem ? e.message : 'błąd przypisania')).slice(0, 300);
    }
  }
  await tenantTx(a.tenantId, (c) =>
    c.query(
      `INSERT INTO inbound253_matches(tenant_id,message_id,account_id,outcome,method,order_id,binding_id,candidates,evidence,actor_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [a.tenantId, messageId, accountId, outcome, d.method, outcome === 'bound' || outcome === 'failed' ? d.order_id : null, bindingId, outcome === 'failed' ? Math.min(d.candidates, 1) : d.candidates, note.slice(0, 300), a.userId],
    ),
  );
  return bindingId !== null;
}

/** One run of a due schedule under a lease; a second worker at the same time gets ran=false. */
export async function runInboundSchedule(tenantId: string, accountId: string, deps: AcquireDeps = {}): Promise<{ ran: boolean; outcome?: string }> {
  const token = randomUUID();
  const s = await tenantTx(tenantId, async (c) =>
    (
      await c.query(
        `UPDATE inbound253_schedules SET lease_token=$2,lease_until=now()+interval '10 minutes'
         WHERE account_id=$1 AND enabled AND next_run_at<=now() AND (lease_until IS NULL OR lease_until<now()) RETURNING *`,
        [accountId, token],
      )
    ).rows[0],
  );
  if (!s) return { ran: false };
  const finish = (set: { outcome: string; error?: string | null; fetched?: number; bound?: number; disable?: boolean }) =>
    tenantTx(tenantId, (c) =>
      c.query(
        `UPDATE inbound253_schedules SET lease_token=NULL,lease_until=NULL,last_run_at=now(),last_outcome=$3,last_error=$4,last_fetched=$5,last_bound=$6,
           enabled=enabled AND NOT $7,next_run_at=CASE WHEN enabled AND NOT $7 THEN now()+make_interval(mins=>interval_minutes) ELSE next_run_at END,updated_at=now()
         WHERE account_id=$1 AND lease_token=$2`,
        [accountId, token, set.outcome, set.error?.slice(0, 300) ?? null, set.fetched ?? null, set.bound ?? null, set.disable === true],
      ),
    );
  // The owner pool reads the membership: dyna_app cannot read auth tables.
  const role = (await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [tenantId, s.actor_id])).rows[0]?.role;
  if (role !== 'admin') {
    await finish({ outcome: 'refused', error: 'Osoba, która włączyła odbiór, nie ma już uprawnień administratora; włącz harmonogram ponownie', disable: true });
    return { ran: true, outcome: 'refused' };
  }
  const a: EmailInboundActor = { tenantId, userId: s.actor_id, role: 'admin', source: 'manual' };
  try {
    const ids = await (deps.acquire ?? defaultAcquire)(a, accountId);
    let bound = 0;
    if (s.auto_bind) for (const id of [...new Set(ids)]) if (await matchOne(a, accountId, id)) bound++;
    await finish({ outcome: ids.length ? 'fetched' : 'empty', fetched: ids.length, bound });
    return { ran: true, outcome: ids.length ? 'fetched' : 'empty' };
  } catch (e) {
    // The operator sees a Polish message; details stay in the server log (worker-supervisor format).
    if (!(e instanceof Problem))
      console.error(JSON.stringify({ level: 'error', step: 'email.inbound_schedules', tenant_id: tenantId, account_id: accountId, error: String((e as Error)?.message ?? e).slice(0, 500) }));
    await finish({ outcome: 'failed', error: e instanceof Problem ? e.message : 'Odczyt skrzynki nie powiódł się; spróbujemy w następnym cyklu' });
    return { ran: true, outcome: 'failed' };
  }
}
/** Worker step: due schedules of all tenants, at most 5 per cycle. */
export async function scheduleInboundPollsDue(deps: AcquireDeps = {}): Promise<void> {
  if (!(await available())) return;
  const due = (
    await pool.query(
      'SELECT tenant_id,account_id FROM inbound253_schedules WHERE enabled AND next_run_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_run_at,account_id LIMIT 5',
    )
  ).rows;
  for (const r of due) await runInboundSchedule(r.tenant_id, r.account_id, deps);
}
