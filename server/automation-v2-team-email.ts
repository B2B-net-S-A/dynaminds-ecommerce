/**
 * Automation rules v2: the e-mail channel of notify_team (arkusz „Automatyzacje - katalog” wiersz 102). One e-mail per
 * team member goes through the e-mail module like the rule's e-mail to the buyer: an email_batches row of the run
 * (automation_run_id, mode 'local', order_guard 'content'), one email_messages row and an 'email.send' job. The snapshot
 * carries team_user_id; processEmail (server/email.ts) re-checks that the person is still in the team and still has the
 * address before the send. Recipients come only from the tenant's team, never from the order's data.
 */
import { createHash, randomUUID } from 'node:crypto';
import { audit } from './domain';
import { ensure } from './errors';
import { emailHash, renderTeamEmail } from './email';
import { lockEmailQueue } from './email-actions';
import { teamEmailAddresses } from './team-email-recipients';
import type { EffectEnv } from './automation-v2-effect-types';

/** Most e-mails one notify_team effect sends (chosen people and a whole role together). */
export const TEAM_EMAIL_LIMIT = 20;
export const TEAM_EMAIL_ACTION = 'automation.notification.email';

export interface TeamEmailOutcome {
  queued: number;
  reused: number;
  /** People with no address in the team any more (left the firm between the in-app check and the read). */
  skipped: number;
}

/** A stable UUID per run, rule, effect and person: a repeated effect finds its batch instead of sending again. */
function teamKey(...parts: string[]): string {
  const h = createHash('sha256').update(['v2-team-email', ...parts].join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function queueTeamEmails(env: EffectEnv, templateId: string, userIds: readonly string[], index: number): Promise<TeamEmailOutcome> {
  const { c, actor, orderId } = env;
  ensure(userIds.length <= TEAM_EMAIL_LIMIT, 422, `Powiadom zespół: najwyżej ${TEAM_EMAIL_LIMIT} adresatów e-maila`);
  await lockEmailQueue(c, actor.tenantId);
  const t = (await c.query('SELECT * FROM email_templates WHERE id=$1 FOR SHARE', [templateId])).rows[0];
  ensure(t?.active, 422, 'Powiadom zespół: szablon e-mail jest nieaktywny lub spoza organizacji');
  const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR SHARE', [orderId])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  const addresses = await teamEmailAddresses(actor.tenantId, userIds);
  const out: TeamEmailOutcome = { queued: 0, reused: 0, skipped: 0 };
  const fresh: Array<{ userId: string; key: string; address: string }> = [];
  for (const userId of userIds) {
    const key = teamKey(env.runId, env.rule.id, String(index), userId);
    if ((await c.query('SELECT 1 FROM email_batches WHERE client_key=$1', [key])).rowCount) out.reused++;
    else if (!addresses.has(userId)) out.skipped++;
    else fresh.push({ userId, key, address: addresses.get(userId)! });
  }
  if (!fresh.length) return out;
  const active = (await c.query("SELECT count(*)::int n FROM jobs WHERE (state='pending' OR state='running')")).rows[0].n;
  ensure(active + fresh.length <= 1000, 409, 'Kolejka pełna');
  for (const f of fresh) {
    const snapshot = { version: o.version, subject: t.subject, body: t.body, html: t.html, attachment: 'none', team_user_id: f.userId };
    const payload = await renderTeamEmail(c, snapshot, o, f.address);
    const batch = randomUUID(),
      message = randomUUID(),
      job = randomUUID();
    await c.query(
      `INSERT INTO email_batches(id,tenant_id,actor_id,template_id,template_version,mode,client_key,request_hash,state,automation_run_id,order_guard)
       VALUES($1,$2,$3,$4,$5,'local',$6,$7,'queued',$8,'content')`,
      [batch, actor.tenantId, actor.userId, t.id, t.version, f.key, emailHash({ team_user_id: f.userId, template_id: t.id, order_id: orderId }), env.runId],
    );
    await c.query("INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,'email.send',$3,$4,3)", [
      job,
      actor.tenantId,
      JSON.stringify({ message_id: message }),
      'email:' + message,
    ]);
    await c.query(
      "INSERT INTO email_messages(id,tenant_id,batch_id,order_id,number,snapshot,payload,state,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8)",
      [message, actor.tenantId, batch, orderId, o.number, JSON.stringify(snapshot), JSON.stringify(payload), job],
    );
    // The audit names the person and the message, not the address.
    await audit(c, actor, TEAM_EMAIL_ACTION, f.userId, { rule_id: env.rule.id, run_id: env.runId, order_id: orderId, message_id: message, batch_id: batch });
    out.queued++;
  }
  return out;
}
