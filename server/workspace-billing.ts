import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db';
import { authTx, lockAdmin, workspaceUsage } from './workspace-routes';
import { audit, type Actor, type AuditActor } from './domain';
import { ensure } from './errors';
import { z } from 'zod';
export const billingInput = z
  .object({
    kind: z.enum(['activate', 'change', 'schedule', 'renew']),
    plan: z.enum(['starter', 'business', 'enterprise']),
  })
  .strict();
function canonical(v: any): any {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
const fingerprint = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const account = async (c: PoolClient, tenant: string) =>
  (
    await c.query('SELECT * FROM workspace_billing_accounts WHERE tenant_id=$1 FOR UPDATE', [
      tenant,
    ])
  ).rows[0] ?? null;
const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export function prorated(amount: number, start: Date, end: Date) {
  const total = BigInt(nextMonth(start).getTime() - monthStart(start).getTime()),
    remaining = BigInt(Math.max(0, end.getTime() - start.getTime()));
  ensure(
    Number.isSafeInteger(amount) && amount >= 0 && remaining <= total,
    422,
    'Nieprawidłowy okres rozliczenia',
  );
  return Number((BigInt(amount) * remaining + total / 2n) / total);
}
async function rate(c: PoolClient, plan: string) {
  const p = (
    await c.query(
      'SELECT p.code AS plan,p.name,p.limits,r.version AS rate_version,r.currency,r.monthly_amount FROM service_plans p JOIN workspace_plan_rates r ON r.plan=p.code WHERE p.code=$1 FOR SHARE OF p,r',
      [plan],
    )
  ).rows[0];
  ensure(p, 422, 'Brak przykładowego cennika planu');
  return p;
}
function blockers(state: any, terms: any) {
  return Object.entries(state.usage)
    .filter(
      ([r, n]) =>
        Number(n) + (r === 'memberships' ? state.pending_invitations : 0) > terms.limits[r],
    )
    .map(([resource, used]) => ({
      resource,
      used: Number(used) + (resource === 'memberships' ? state.pending_invitations : 0),
      limit: terms.limits[resource],
    }));
}
async function entry(
  c: PoolClient,
  tenant: string,
  key: string,
  kind: string,
  terms: any,
  amount: number,
  start: Date,
  end: Date,
) {
  await c.query(
    'INSERT INTO workspace_billing_entries(id,tenant_id,key,kind,plan,currency,amount,period_start,period_end,terms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,key) DO NOTHING',
    [
      randomUUID(),
      tenant,
      key,
      kind,
      terms.plan,
      terms.currency,
      amount,
      start,
      end,
      JSON.stringify(terms),
    ],
  );
}
async function apply(
  c: PoolClient,
  actor: AuditActor,
  a: any,
  terms: any,
  kind: string,
  at: Date,
  key: string,
) {
  const end = kind === 'renew' ? nextMonth(at) : a ? new Date(a.period_end) : nextMonth(at);
  if (kind === 'change' && a)
    await entry(
      c,
      actor.tenantId,
      key + ':credit',
      'credit',
      a.current_terms,
      -prorated(a.monthly_amount, at, end),
      at,
      end,
    );
  const amount = prorated(terms.monthly_amount, at, end);
  await entry(c, actor.tenantId, key + ':debit', kind, terms, amount, at, end);
  await c.query('UPDATE tenants SET plan=$2 WHERE id=$1', [actor.tenantId, terms.plan]);
  if (a)
    await c.query(
      `UPDATE workspace_billing_accounts SET version=version+1,plan=$2,monthly_amount=$3,current_terms=$7,period_start=CASE WHEN $4 THEN $5 ELSE period_start END,period_end=$6,next_terms=NULL,next_error=NULL,retry_at=NULL,updated_at=now() WHERE tenant_id=$1`,
      [
        actor.tenantId,
        terms.plan,
        terms.monthly_amount,
        kind === 'renew',
        at,
        end,
        JSON.stringify(terms),
      ],
    );
  else
    await c.query(
      'INSERT INTO workspace_billing_accounts(tenant_id,plan,currency,monthly_amount,period_start,period_end,current_terms) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        actor.tenantId,
        terms.plan,
        terms.currency,
        terms.monthly_amount,
        at,
        end,
        JSON.stringify(terms),
      ],
    );
  await audit(c, actor, 'workspace.billing.' + kind, actor.tenantId, {
    plan: terms.plan,
    amount,
    currency: terms.currency,
    mode: 'local_estimate',
    key,
  });
  return { mode: 'local_estimate', plan: terms.plan, amount, currency: terms.currency };
}
export async function billingState(actor: Actor, cursor?: { created_at: string; id: string }) {
  return authTx(async (c) => {
    // Tenant lock aligns observations with the quota lock. Membership rechecked in the transaction.
    await c.query('SELECT id FROM tenants WHERE id=$1 FOR SHARE', [actor.tenantId]);
    const m = (
      await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
        actor.tenantId,
        actor.userId,
      ])
    ).rows[0];
    ensure(m, 403, 'Brak dostępu do organizacji');
    const s = await workspaceUsage(c, actor.tenantId);
    const a =
      (
        await c.query('SELECT * FROM workspace_billing_accounts WHERE tenant_id=$1', [
          actor.tenantId,
        ])
      ).rows[0] ?? null;
    const entries =
      m.role === 'admin'
        ? (
            await c.query(
              'SELECT * FROM workspace_billing_entries WHERE tenant_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 31',
              [actor.tenantId, cursor?.created_at ?? null, cursor?.id ?? null],
            )
          ).rows
        : [];
    const plans = (
      await c.query(
        'SELECT p.code AS plan,p.name,p.limits,r.version AS rate_version,r.currency,r.monthly_amount FROM service_plans p JOIN workspace_plan_rates r ON r.plan=p.code ORDER BY monthly_amount',
      )
    ).rows;
    const last = entries[29];
    return {
      mode: 'local_estimate',
      account: a,
      usage: s.usage,
      pending_invitations: s.pending_invitations,
      current_plan: s.tenant.plan,
      plans,
      entries: entries.slice(0, 30),
      next_cursor: entries.length > 30 ? { created_at: last.created_at, id: last.id } : null,
      admin: m.role === 'admin',
    };
  });
}
export async function previewBilling(
  actor: Actor,
  input: z.infer<typeof billingInput>,
  at = new Date(),
) {
  return authTx(async (c) => {
    await lockAdmin(c, actor);
    const a = await account(c, actor.tenantId),
      s = await workspaceUsage(c, actor.tenantId, at),
      terms = await rate(c, input.plan);
    ensure(
      input.kind === 'activate' ? !a : !!a,
      409,
      a ? 'Abonament lokalny już istnieje' : 'Najpierw uruchom abonament lokalny',
    );
    if (a) {
      ensure(a.plan === s.tenant.plan, 409, 'Plan organizacji zmienił się poza abonamentem');
      ensure(new Date(a.period_start) <= at, 409, 'Nie można cofnąć czasu okresu abonamentu');
    }
    if (input.kind === 'renew')
      ensure(new Date(a.period_end) <= at, 409, 'Okres jeszcze się nie zakończył');
    if (['change', 'schedule'].includes(input.kind)) {
      ensure(new Date(a.period_end) > at, 409, 'Najpierw odnów zakończony okres');
      ensure(input.plan !== a.plan, 409, 'Wybierz inny plan');
    }
    const effective =
      input.kind === 'renew' || input.kind === 'schedule' ? new Date(a.period_end) : at;
    const end =
      input.kind === 'renew' || input.kind === 'schedule'
        ? nextMonth(effective)
        : a
          ? new Date(a.period_end)
          : nextMonth(effective);
    const credit = input.kind === 'change' ? -prorated(a.monthly_amount, effective, end) : 0;
    const b = blockers(s, terms);
    const p = (
      await c.query(
        'INSERT INTO workspace_billing_previews(id,tenant_id,actor_id,version,kind,terms,before_plan,before_terms,usage,effective_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [
          randomUUID(),
          actor.tenantId,
          actor.userId,
          a?.version ?? 0,
          input.kind,
          JSON.stringify(terms),
          s.tenant.plan,
          JSON.stringify(a ?? {}),
          JSON.stringify({ ...s.usage, pending_invitations: s.pending_invitations }),
          effective,
          new Date(at.getTime() + 15 * 60000),
        ],
      )
    ).rows[0];
    return {
      ...p,
      mode: 'local_estimate',
      debit: prorated(terms.monthly_amount, effective, end),
      credit,
      total: prorated(terms.monthly_amount, effective, end) + credit,
      period_end: end,
      blockers: b,
      can_commit: input.kind === 'schedule' || b.length === 0,
    };
  });
}
export async function commitBilling(actor: Actor, id: string, at = new Date()) {
  return authTx(async (c) => {
    await lockAdmin(c, actor);
    const a = await account(c, actor.tenantId);
    const p = (
      await c.query(
        'SELECT * FROM workspace_billing_previews WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
        [id, actor.tenantId],
      )
    ).rows[0];
    ensure(p, 404, 'Brak podglądu abonamentu');
    if (p.state === 'committed') return p.result;
    ensure(p.actor_id === actor.userId, 403, 'Podgląd należy do innego administratora');
    ensure(new Date(p.expires_at) > at, 409, 'Podgląd abonamentu wygasł');
    const state = await workspaceUsage(c, actor.tenantId, at);
    ensure(
      (a?.version ?? 0) === p.version &&
        state.tenant.plan === p.before_plan &&
        fingerprint(a ?? {}) === fingerprint(p.before_terms),
      409,
      'Abonament zmienił się; przygotuj nowy podgląd',
    );
    ensure(
      fingerprint(await rate(c, p.terms.plan)) === fingerprint(p.terms),
      409,
      'Cennik zmienił się; przygotuj nowy podgląd',
    );
    let result;
    if (p.kind === 'schedule') {
      ensure(new Date(a.period_end) > at, 409, 'Okres zakończył się przed zatwierdzeniem');
      await c.query(
        'UPDATE workspace_billing_accounts SET version=version+1,next_terms=$2,next_error=NULL,retry_at=NULL,updated_at=now() WHERE tenant_id=$1',
        [actor.tenantId, JSON.stringify(p.terms)],
      );
      result = {
        mode: 'local_estimate',
        scheduled: true,
        plan: p.terms.plan,
        effective_at: p.effective_at,
      };
      await audit(c, actor, 'workspace.billing.scheduled', id, result);
    } else {
      ensure(
        blockers(state, p.terms).length === 0,
        409,
        'Wykorzystanie przekracza limity docelowego planu',
      );
      if (p.kind === 'change')
        ensure(new Date(a.period_end) > at, 409, 'Okres zakończył się przed zatwierdzeniem');
      result = await apply(c, actor, a, p.terms, p.kind, new Date(p.effective_at), p.id);
    }
    await c.query("UPDATE workspace_billing_previews SET state='committed',result=$2 WHERE id=$1", [
      id,
      JSON.stringify(result),
    ]);
    return result;
  });
}
export async function configureBilling(
  actor: Actor,
  input: { version: number; auto_renew?: boolean; cancel_scheduled?: boolean },
) {
  return authTx(async (c) => {
    await lockAdmin(c, actor);
    const a = await account(c, actor.tenantId);
    ensure(a && a.version === input.version, 409, 'Abonament zmienił się; odśwież widok');
    await c.query(
      'UPDATE workspace_billing_accounts SET version=version+1,auto_renew=$2,next_terms=CASE WHEN $3 THEN NULL ELSE next_terms END,next_error=CASE WHEN $3 THEN NULL ELSE next_error END,retry_at=NULL,updated_at=now() WHERE tenant_id=$1',
      [actor.tenantId, input.auto_renew ?? a.auto_renew, !!input.cancel_scheduled],
    );
    await audit(c, actor, 'workspace.billing.configured', actor.tenantId, input);
    return { ok: true };
  });
}
export async function legacyBillingPlanChange(c: PoolClient, actor: Actor, target: string) {
  const a = await account(c, actor.tenantId);
  if (!a) {
    await c.query('UPDATE tenants SET plan=$2 WHERE id=$1', [actor.tenantId, target]);
    return;
  }
  if (a.plan === target) return;
  ensure(new Date(a.period_start) <= new Date(), 409, 'Nie można cofnąć czasu okresu abonamentu');
  ensure(new Date(a.period_end) > new Date(), 409, 'Najpierw odnów zakończony okres abonamentu');
  await apply(c, actor, a, await rate(c, target), 'change', new Date(), randomUUID());
}
export async function renewBillingDue(at = new Date(), onlyTenant?: string) {
  const due = (
    await pool.query(
      'SELECT tenant_id FROM workspace_billing_accounts WHERE auto_renew AND period_end<=$1 AND (retry_at IS NULL OR retry_at<=$1) AND ($2::uuid IS NULL OR tenant_id=$2) ORDER BY period_end,tenant_id LIMIT 50',
      [at, onlyTenant ?? null],
    )
  ).rows;
  let renewed = 0,
    blocked = 0;
  for (const d of due) {
    try {
      await authTx(async (c) => {
        await c.query('SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE', [d.tenant_id]);
        const a = await account(c, d.tenant_id);
        if (
          !a?.auto_renew ||
          new Date(a.period_end) > at ||
          (a.retry_at && new Date(a.retry_at) > at)
        )
          return;
        const state = await workspaceUsage(c, d.tenant_id, at),
          terms = a.next_terms ?? a.current_terms;
        const problems = blockers(state, terms);
        const rateChanged = fingerprint(await rate(c, terms.plan)) !== fingerprint(terms);
        if (state.tenant.plan !== a.plan || problems.length || rateChanged) {
          const error = rateChanged
            ? 'Cennik zmienił się; zatwierdź nowy podgląd'
            : state.tenant.plan !== a.plan
              ? 'Plan organizacji wymaga uzgodnienia'
              : 'Docelowy plan przekracza wykorzystanie: ' +
                problems.map((p) => p.resource).join(', ');
          await c.query(
            'UPDATE workspace_billing_accounts SET version=version+1,next_error=$2,retry_at=$3,updated_at=now() WHERE tenant_id=$1',
            [d.tenant_id, error, new Date(at.getTime() + 3600000)],
          );
          await audit(
            c,
            { tenantId: d.tenant_id, userId: null },
            'workspace.billing.renewal_blocked',
            d.tenant_id,
            { reason: error, mode: 'local_estimate' },
          );
          blocked++;
          return;
        }
        await apply(
          c,
          { tenantId: d.tenant_id, userId: null },
          a,
          terms,
          'renew',
          new Date(a.period_end),
          'renew:' + a.period_end.toISOString(),
        );
        renewed++;
      });
    } catch {
      // Isolate one account's invalid terms; order processing and other tenants continue.
      await authTx(async (c) => {
        await c.query('SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE', [d.tenant_id]);
        const a = await account(c, d.tenant_id);
        if (
          !a?.auto_renew ||
          new Date(a.period_end) > at ||
          (a.retry_at && new Date(a.retry_at) > at)
        )
          return;
        await c.query(
          "UPDATE workspace_billing_accounts SET version=version+1,next_error='Nie udało się odnowić kalkulacji; sprawdź konfigurację abonamentu',retry_at=$2,updated_at=now() WHERE tenant_id=$1",
          [d.tenant_id, new Date(at.getTime() + 3600000)],
        );
        await audit(
          c,
          { tenantId: d.tenant_id, userId: null },
          'workspace.billing.renewal_failed',
          d.tenant_id,
          { mode: 'local_estimate' },
        );
        blocked++;
      });
    }
  }
  return { renewed, blocked };
}
