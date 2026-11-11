/** Admin view of the global worker loop (heartbeat, per-scheduler state, pause/resume) and of the
 * tenant's own job queue (due backlog, retries, stale leases, failures). Pause is runtime-only.
 * The loop serves every workspace of the installation and signup is open, so pausing a scheduler
 * and reading its last error belong to the installation operator only: an admin of the workspace
 * named by DYNA_WORKER_OPERATOR_TENANT (unset by default = nobody). Other admins see the loop
 * state without errors and control only their own scoped processor (SR4-H1). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { tenantReadTx, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { workerRuntime } from './worker-supervisor';
import type { ScopedProcessorControl } from './scoped-automation-processor';

export const WORKER_REPLAY_RULE =
  'Zadanie wraca do kolejki automatycznie tylko w limicie max_attempts i tylko wtedy, gdy jego skutek zewnętrzny nie został rozpoczęty. Rozpoczęty skutek o nieznanym wyniku czeka na uzgodnienie przez operatora. Procesor reguł automatycznych zapisuje max_attempts=1, więc żadna pętla go nie ponawia.';
const SCHEDULER = z.object({ name: z.string().regex(/^[a-z0-9_.]{1,64}$/) });
type Options = {
  backgroundWorkersEnabled: boolean;
  scopedAutomationEnabled: boolean;
  readOnly: boolean;
  scopedProcessor?: ScopedProcessorControl;
};

function adminSession(req: FastifyRequest): Actor {
  const r = req as FastifyRequest & { actor: Actor & { apiKeyId?: string }; apiScopes?: string[] };
  ensure(r.actor?.role === 'admin' && !r.actor.apiKeyId && !r.apiScopes, 403, 'Wymagana sesja administratora');
  return r.actor;
}
/** The installation operator workspace, from the environment; off unless set to a workspace id. */
export function workerOperatorTenant(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.DYNA_WORKER_OPERATOR_TENANT?.trim().toLowerCase();
  return v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : null;
}
const isInstallationOperator = (a: Actor) => workerOperatorTenant() === a.tenantId.toLowerCase();
export const WORKER_OPERATOR_ONLY =
  'Wstrzymanie i wznowienie schedulera obejmuje wszystkie firmy tej instalacji, więc może je wykonać tylko operator instalacji (administrator firmy wskazanej w DYNA_WORKER_OPERATOR_TENANT).';
function notStartedReason(o: Options) {
  return o.backgroundWorkersEnabled
    ? 'Worker w tle nie został jeszcze uruchomiony w tym procesie. Harmonogramy ruszą po starcie pętli.'
    : 'Worker w tle jest wyłączony w tym uruchomieniu (DYNA_WORKER_DISABLED=true albo zwykły lokalny runtime bez workerów w tle). Harmonogramy nie są wykonywane; kolejka poniżej czeka.';
}

function scopedProcessorView(o: Options, tenant: string) {
  const p = o.scopedProcessor,
    mode = p?.mode ?? (o.scopedAutomationEnabled ? 'INSTALLATION' : 'UNAVAILABLE'),
    running = p ? p.running(tenant) : o.scopedAutomationEnabled;
  return {
    mode,
    running,
    enabled: running,
    can_control: mode === 'WORKSPACE' && !o.readOnly,
    scope: mode === 'WORKSPACE' ? 'THIS_WORKSPACE_RUNTIME_ONLY' : mode === 'INSTALLATION' ? 'ALL_WORKSPACES_CLI_OPTION' : null,
    message:
      mode === 'INSTALLATION'
        ? 'Procesor reguł automatycznych działa dla całej instalacji (opcja --scoped-automation) i obsługuje reguły włączone przez autora.'
        : mode === 'WORKSPACE'
          ? running
            ? 'Procesor reguł automatycznych działa dla tej firmy do restartu procesu. Obsługuje tylko reguły włączone przez autora dla nowych zdarzeń.'
            : 'Procesor reguł automatycznych nie działa dla tej firmy. Uruchom go tutaj; działa do restartu procesu i tylko dla tej firmy.'
          : o.readOnly
            ? 'Kopia tylko do odczytu nie uruchamia procesora reguł automatycznych.'
            : 'Procesor reguł automatycznych nie działa w tym procesie: zadania automatyzacji wykonuje tu globalna pętla workera.',
  };
}
export function registerWorkerSupervisionRoutes(app: FastifyInstance, o: Options) {
  app.get('/api/operations/workers', async (req) => {
    const a = adminSession(req);
    const operator = isInstallationOperator(a);
    const snapshot = workerRuntime()?.snapshot() ?? null;
    // Scheduler errors come from the work of every workspace; only the operator sees them.
    const runtime = snapshot && !operator ? { ...snapshot, steps: snapshot.steps.map((s) => ({ ...s, last_error: null })) } : snapshot;
    const queue = await tenantReadTx(a.tenantId, async (c) => {
      const kinds = (
        await c.query(
          `SELECT kind,
             count(*) FILTER (WHERE state='pending')::int pending,
             count(*) FILTER (WHERE state='pending' AND run_at<=now() AND (provider_wait_until IS NULL OR provider_wait_until<=now()))::int due,
             min(run_at) FILTER (WHERE state='pending' AND run_at<=now()) oldest_due_at,
             count(*) FILTER (WHERE state='pending' AND attempts>0)::int retrying,
             count(*) FILTER (WHERE state='running')::int running,
             count(*) FILTER (WHERE state='running' AND locked_at<now()-interval '2 minutes')::int stale_running,
             count(*) FILTER (WHERE state='failed')::int failed,
             max(attempts)::int max_attempts_used,
             max(provider_wait_until) FILTER (WHERE state='pending' AND provider_wait_until>now()) provider_wait_until,
             left((array_agg(error ORDER BY run_at DESC) FILTER (WHERE error IS NOT NULL))[1],300) last_error
           FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running','failed')
           GROUP BY kind ORDER BY kind LIMIT 200`,
          [a.tenantId],
        )
      ).rows;
      const now = (await c.query('SELECT now() at')).rows[0].at as Date;
      return {
        generated_at: now.toISOString(),
        kinds: kinds.map((k) => ({
          ...k,
          oldest_due_age_s: k.oldest_due_at ? Math.max(0, Math.round((now.getTime() - new Date(k.oldest_due_at).getTime()) / 1000)) : null,
        })),
      };
    });
    return {
      runtime,
      runtime_state: runtime ? runtime.state : 'NOT_STARTED',
      not_started_reason: runtime ? null : notStartedReason(o),
      background_workers_enabled: o.backgroundWorkersEnabled,
      installation_operator: operator,
      scheduler_control: operator && !o.readOnly,
      scheduler_control_rule: WORKER_OPERATOR_ONLY,
      scoped_processor: scopedProcessorView(o, a.tenantId),
      replay_rule: WORKER_REPLAY_RULE,
      queue,
    };
  });
  for (const action of ['pause', 'resume'] as const)
    app.post(`/api/operations/workers/schedulers/:name/${action}`, async (req) => {
      ensure(!o.readOnly, 423, 'Kopia tylko do odczytu');
      const a = adminSession(req);
      ensure(isInstallationOperator(a), 403, WORKER_OPERATOR_ONLY);
      const { name } = SCHEDULER.parse(req.params);
      const runtime = workerRuntime();
      ensure(runtime, 409, notStartedReason(o));
      ensure(runtime.snapshot().steps.some((s) => s.name === name), 404, 'Nieznany scheduler workera');
      await tenantTx(a.tenantId, (c) =>
        audit(c, a, `worker.scheduler.${action}`, null, { scheduler: name, scope: 'RUNTIME_ONLY_RESET_ON_RESTART' }),
      );
      const scheduler = action === 'pause' ? runtime.pause(name) : runtime.resume(name);
      return { scheduler, scope: 'RUNTIME_ONLY_RESET_ON_RESTART', affects: 'ALL_WORKSPACES_OF_THIS_INSTALLATION' };
    });
  for (const action of ['start', 'stop'] as const)
    app.post(`/api/operations/workers/scoped-processor/${action}`, async (req) => {
      ensure(!o.readOnly, 423, 'Kopia tylko do odczytu');
      const a = adminSession(req);
      const p = o.scopedProcessor;
      ensure(p && p.mode === 'WORKSPACE', 409, scopedProcessorView(o, a.tenantId).message);
      await tenantTx(a.tenantId, async (c) => {
        ensure((await c.query('SELECT offer_sync_is_admin($1) ok', [a.userId])).rows[0]?.ok === true, 403, 'Wymagany aktualny administrator');
        await audit(c, a, `worker.scoped_processor.${action}`, null, { scope: 'THIS_WORKSPACE_RUNTIME_ONLY' });
      });
      await (action === 'start' ? p.start(a.tenantId) : p.stop(a.tenantId));
      return { scoped_processor: scopedProcessorView(o, a.tenantId) };
    });
}
