/**
 * Automation rules v2: effect merge_orders ("Połącz z innymi otwartymi zamówieniami tego samego klienta").
 *
 * The rule never merges by itself. The merge module's execution needs an administrator's live session: the 209
 * address inheritance calls buyer_address_identity with the request's session hash (209_order_merge_delivery_
 * inheritance.sql:59, 166_buyer_address_sidecar.sql:324-339) and requires the execution and target rows to carry the
 * top-level transaction id (209:123-133), which rows written inside the rule's savepoint never do. Both are sealed.
 *
 * So the rule finds the order's open pairs (same buyer e-mail, channel and company; new or paid; not merged yet),
 * checks every pair with the module's own capture and conflict rules (orderMergeEligibilityInTx: currency, warehouse,
 * payment, shipments, documents, returns, carrier/channel attempts, picking waves, packing, reservations, and the
 * receiver/address check), and when the set passes without exceptions it leaves a proposal:
 *   - audit_events 'automation.merge_proposal' (entity = main order; detail.key = hash of the order set),
 *   - order history 'automation.merge_proposed' on every order of the set,
 *   - a bell notification ('automation.notification' with merge_order_ids) for the chosen administrators or all of
 *     them; the bell opens the order list with the set selected in the merge panel.
 * The administrator previews and executes in the module, with all its checks. The same set is proposed once
 * (idempotent per key); merged sources are claimed and drop out, so a merged order never re-proposes itself.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { result, type EffectEnv, type EffectHandler, type EffectModule } from './automation-v2-effect-types';
import { NOTIFICATION_ACTION } from './automation-v2-effects-comm';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { localOrderEvent } from './events';
import { orderMergeClaimInTx } from './order-merge-guards';
import { orderMergeEligibilityInTx, orderMergesAvailable, ORDER_MERGE_LIMITS } from './order-merges';

export const MERGE_PROPOSAL_ACTION = 'automation.merge_proposal';
export const MERGE_PROPOSED_EVENT = 'automation.merge_proposed';
/** Open = nothing picked, packed or shipped yet (stricter than the module, which also accepts picking/packed). */
const OPEN_STATUSES = ['new', 'paid'];

const mergeParams = z.strictObject({ user_ids: z.array(z.uuid().transform((v) => v.toLowerCase())).max(20).default([]) });
type MergeParams = z.infer<typeof mergeParams>;
type Row = Record<string, any>;

const REASONS: Record<string, string> = {
  different_currency: 'inna waluta',
  different_warehouse: 'inny magazyn',
  different_payment_mode: 'inny sposób płatności',
  existing_shipments: 'ma przesyłkę',
  existing_documents: 'ma dokument',
  existing_return_cases: 'ma zwrot',
  active_picking_wave: 'jest w aktywnej fali kompletacji',
  active_packing_session: 'jest w trakcie pakowania',
  non_active_reservation: 'ma nieaktywną rezerwację',
};
function reason(code: string): string {
  if (code.startsWith('not_pre_fulfillment:')) return 'jest już w realizacji';
  if (code.startsWith('provider_attempt:')) return 'trwa obsługa u przewoźnika lub kanału';
  return REASONS[code] ?? code;
}

/** Administrators of the tenant (081 SECURITY DEFINER reader, paged by user id). Only they can merge. */
async function administrators(c: PoolClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let after: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page: Array<{ user_id: string; name: string; role: string }> = (
      await c.query('SELECT user_id,name,role FROM customer_message_eligible_assignees($1)', [after])
    ).rows;
    for (const r of page) if (r.role === 'admin') out.set(r.user_id, r.name);
    if (page.length < 101) break;
    after = page[page.length - 1]!.user_id;
  }
  return out;
}

/** The module's read-only check of one set, isolated so a refused candidate leaves the rule's transaction intact. */
async function refusals(c: PoolClient, mainId: string, ids: string[]): Promise<string[]> {
  await c.query('SAVEPOINT automation_merge_check');
  try {
    const r = await orderMergeEligibilityInTx(c, mainId, ids);
    await c.query('RELEASE SAVEPOINT automation_merge_check');
    return [...new Set([...r.conflicts.map(reason), ...(r.receiver_conflict ? ['inny odbiorca lub adres'] : [])])];
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT automation_merge_check');
    await c.query('RELEASE SAVEPOINT automation_merge_check');
    if (e instanceof Problem) return [e.message];
    throw e;
  }
}

async function proposeMerge(env: EffectEnv, p: MergeParams) {
  const { c, actor, orderId } = env;
  const done = (changed: boolean, message: string) => result('merge_orders', changed, message);
  ensure(await orderMergesAvailable(c), 503, 'Ta kopia nie zawiera pełnego modułu łączenia zamówień');
  const o = (await c.query('SELECT id,number,status,email,source,channel_id,created_at FROM orders WHERE id=$1', [orderId])).rows[0] as Row;
  ensure(o, 404, 'Nie znaleziono zamówienia');
  if (await orderMergeClaimInTx(c, orderId)) return done(false, `Zamówienie ${o.number} zostało już połączone z innym`);
  if (!OPEN_STATUSES.includes(o.status)) return done(false, `Zamówienie ${o.number} nie jest otwarte (nowe lub opłacone) — bez propozycji połączenia`);
  if (!String(o.email ?? '').trim()) return done(false, `Zamówienie ${o.number} nie ma e-maila klienta — nie da się znaleźć jego innych zamówień`);
  const candidates = (
    await c.query(
      `SELECT o.id,o.number,o.created_at FROM orders o
        WHERE o.tenant_id=$1 AND o.id<>$2 AND lower(btrim(o.email))=lower(btrim($3)) AND o.status=ANY($4::text[])
          AND o.source IS NOT DISTINCT FROM $5 AND o.channel_id IS NOT DISTINCT FROM $6
          AND NOT EXISTS(SELECT 1 FROM order_merge_claims m WHERE m.source_order_id=o.id)
        ORDER BY o.created_at,o.id LIMIT $7`,
      [actor.tenantId, orderId, o.email, OPEN_STATUSES, o.source, o.channel_id, ORDER_MERGE_LIMITS.orders - 1],
    )
  ).rows as Row[];
  if (!candidates.length) return done(false, 'Brak innych otwartych zamówień tego klienta (ten sam e-mail i kanał)');
  const earlier = (x: Row, y: Row) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime() || String(x.id).localeCompare(String(y.id));
  const accepted: Row[] = [],
    refused: string[] = [];
  for (const cand of candidates) {
    const main = earlier(o, cand) <= 0 ? o : cand;
    const why = await refusals(c, main.id, [orderId, cand.id]);
    if (why.length) refused.push(`${cand.number} — ${why.join(', ')}`);
    else accepted.push(cand);
  }
  if (!accepted.length) return done(false, `Brak zamówień do połączenia: ${refused.join('; ')}`);
  const set = [o, ...accepted].sort(earlier);
  const ids = set.map((x) => x.id as string),
    numbers = set.map((x) => x.number as string),
    main = set[0]!;
  const whole = await refusals(c, main.id, ids);
  if (whole.length) return done(false, `Zamówienia ${numbers.join(', ')} nie przechodzą kontroli łączenia: ${whole.join(', ')}`);
  const key = createHash('sha256').update([...ids].sort().join(',')).digest('hex');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${MERGE_PROPOSAL_ACTION}:${actor.tenantId}:${key}`]);
  if ((await c.query(`SELECT 1 FROM audit_events WHERE action='${MERGE_PROPOSAL_ACTION}' AND detail->>'key'=$1 LIMIT 1`, [key])).rowCount)
    return done(false, `Propozycja połączenia zamówień ${numbers.join(', ')} już czeka na decyzję administratora`);
  const detail = { key, rule_id: env.rule.id, rule_name: env.rule.name, run_id: env.runId, main_order_id: main.id, order_ids: ids, order_numbers: numbers };
  await audit(c, actor, MERGE_PROPOSAL_ACTION, main.id, detail);
  for (const id of ids) await localOrderEvent(c, actor.tenantId, id, MERGE_PROPOSED_EVENT, { rule_id: env.rule.id, rule_name: env.rule.name, order_ids: ids, order_numbers: numbers });
  const admins = await administrators(c);
  const people = (p.user_ids.length ? p.user_ids : [...admins.keys()]).filter((u) => admins.has(u));
  const message = `Propozycja połączenia zamówień ${numbers.join(', ')} (ten sam klient, adres, waluta i płatność). Zatwierdź w module łączenia zamówień.`;
  for (const u of people)
    await audit(c, actor, NOTIFICATION_ACTION, u, { rule_id: env.rule.id, rule_name: env.rule.name, run_id: env.runId, order_id: orderId, order_number: o.number, message, merge_order_ids: ids });
  const skipped = refused.length ? `; pominięto: ${refused.join('; ')}` : '';
  return done(true, `Propozycja połączenia zamówień ${numbers.join(', ')} czeka na zatwierdzenie w module łączenia (powiadomiono administratorów: ${people.length})${skipped}`);
}

const mergeOrders: EffectHandler<MergeParams> = {
  schema: mergeParams,
  async validate(c, p) {
    ensure(new Set(p.user_ids).size === p.user_ids.length, 422, 'Połącz zamówienia: osoba wybrana dwa razy');
    if (p.user_ids.length) {
      const admins = await administrators(c);
      ensure(p.user_ids.every((u) => admins.has(u)), 422, 'Połącz zamówienia: wybrana osoba nie jest administratorem tej organizacji');
    }
  },
  describe: (p, names) =>
    'Sprawdzi w module łączenia inne otwarte zamówienia tego klienta i zaproponuje ich połączenie ' +
    (p.user_ids.length ? `(powiadomi: ${p.user_ids.map((u) => names[u] ?? u).join(', ')})` : '(powiadomi wszystkich administratorów)'),
  apply: (env, p) => proposeMerge(env, p),
};

export const effects: EffectModule = {
  handlers: { merge_orders: mergeOrders },
  catalogParams: async (c) => ({
    merge_orders: [
      {
        key: 'user_ids',
        label: 'Powiadom administratorów (puste = wszyscy)',
        kind: 'multiselect',
        options: [...(await administrators(c))].map(([value, label]) => ({ value, label })),
      },
    ],
  }),
};
