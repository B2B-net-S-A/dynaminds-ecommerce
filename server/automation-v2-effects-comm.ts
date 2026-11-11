/**
 * Automation rules v2: communication effects (lane M), see server/automation-v2-effect-types.ts.
 * - marketplace_message: a reply to the buyer. The order's marketplace conversation (COM-008 inbox, migration 245)
 *   gets a 'pending' reply that its connector sends (no provider is called locally); without one the reply goes to
 *   the buyer thread of the order portal (server/customer-messages.ts). No channel at all = a Polish refusal.
 * - notify_team: the order history entry as before, plus in-app notifications for chosen people and/or everyone with a
 *   team role (audit_events rows 'automation.notification', read by server/automation-v2-notifications.ts), an e-mail
 *   to the same people from an e-mail template with the order's variables (server/automation-v2-team-email.ts, the
 *   e-mail module's queue) and an optional messenger webhook to an approved outbound subscription.
 * - webhook: an approved outbound subscription (as before) or an https:// URL typed in the rule, queued as an
 *   'outbound.webhook' job and signed with HMAC-SHA256 (server/outbound-webhooks.ts processRuleWebhook).
 */
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { audit, lockedOrder } from './domain';
import { ensure, Problem } from './errors';
import { localOrderEvent } from './events';
import { appendCustomerOrderMessage } from './customer-messages';
import { appendChannelMessageInTx } from './channel-inbox253';
import { orderMessageValues, orderVariables, rowVariables, usedVariables } from './message-variables';
import { normalizeWebhookUrl, type RuleWebhookJob } from './outbound-webhooks';
import { result, type EffectEnv, type EffectHandler, type EffectModule } from './automation-v2-effect-types';
import { queueTeamEmails, TEAM_EMAIL_LIMIT } from './automation-v2-team-email';

export const NOTIFICATION_ACTION = 'automation.notification';
const uuid = z.uuid();
/** Editor text inputs send '' for an empty optional field. */
const optional = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), t.optional());

/** A stable UUID per run and effect, so a retried run reuses the same client keys. */
function stableKey(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---------- marketplace_message ----------
const VARIABLES = new Set([...rowVariables, ...orderVariables]);
const CHANNEL_LABELS: Record<string, string> = { allegro: 'Allegro', ebay: 'eBay', amazon: 'Amazon', helpdesk: 'helpdesk' };
const marketplaceSchema = z.strictObject({ body: z.string().trim().min(1).max(4000) });

function checkVariables(body: string) {
  for (const key of usedVariables([body])) ensure(VARIABLES.has(key), 422, `Wiadomość: nieznana zmienna {{${key}}}`);
}

async function marketplaceThread(c: PoolClient, orderId: string) {
  if (!(await c.query("SELECT to_regclass('public.channel253_threads') IS NOT NULL ok")).rows[0].ok) return null;
  return (
    await c.query(
      `SELECT t.id,t.channel,k.name FROM channel253_threads t JOIN channel253_connections k ON (k.tenant_id,k.id)=(t.tenant_id,t.connection_id)
       WHERE t.order_id=$1 AND k.enabled ORDER BY (t.channel<>'helpdesk') DESC,t.last_message_at DESC,t.id LIMIT 1`,
      [orderId],
    )
  ).rows[0] ?? null;
}

const marketplaceMessage: EffectHandler<z.infer<typeof marketplaceSchema>> = {
  schema: marketplaceSchema,
  validate: async (_c, p) => checkVariables(p.body),
  describe: (p) => `Wyśle wiadomość do kupującego: ${p.body.slice(0, 80)}`,
  async apply(env, p, index) {
    const { c, actor, orderId } = env;
    checkVariables(p.body);
    const o = await lockedOrder(c, orderId);
    const values = await orderMessageValues(c, o, usedVariables([p.body]));
    const body = p.body.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => values[key] ?? '').trim();
    ensure(body.length >= 1 && body.length <= 4000, 422, 'Wiadomość po wstawieniu danych jest pusta albo dłuższa niż 4000 znaków');
    const role = (await c.query('SELECT customer_message_role($1) r', [actor.userId])).rows[0]?.r;
    ensure(role === 'admin' || role === 'operator', 403, 'Wiadomość wysyła administrator albo operator; autor reguły nie ma już tej roli');
    // run_rule runs a nested rule under the same run id; the rule id keeps their effect keys apart.
    const key = stableKey('v2-marketplace', env.runId, env.rule.id, String(index));
    const thread = await marketplaceThread(c, orderId);
    if (thread) {
      const r = await appendChannelMessageInTx(c, actor, thread.id, { kind: 'reply', body, client_key: key });
      const where = `${CHANNEL_LABELS[thread.channel] ?? thread.channel} „${thread.name}”`;
      return result(
        'marketplace_message',
        !r.reused,
        `Wiadomość czeka w skrzynce ${where} na wysłanie przez konektor (lokalnie dostawca nie jest wywoływany)`,
      );
    }
    const portal = o.portal_enabled !== false && (!o.portal_expires_at || new Date(o.portal_expires_at) > new Date());
    ensure(
      portal,
      409,
      'Zamówienie nie ma kanału wiadomości z kupującym: brak rozmowy marketplace, a strona zamówienia kupującego jest wyłączona lub wygasła',
    );
    const r = await appendCustomerOrderMessage(c, actor, orderId, 'reply', { client_key: key, body });
    return result('marketplace_message', !r.reused, 'Wysłano wiadomość do kupującego w wątku zamówienia (strona zamówienia kupującego)');
  },
};

// ---------- webhook ----------
/** Private, loopback, link-local, carrier-grade NAT, multicast and reserved ranges (as integrations.ts). */
function privateIp(ip: string): boolean {
  const v6 = ip.toLowerCase();
  if (v6.includes(':'))
    return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || v6.startsWith('fe80') || v6.startsWith('::ffff:');
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Save-time check of a URL typed in a rule; the send (webhookFetch) also checks DNS and pins a public IP. */
export function checkWebhookUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Problem(422, 'Webhook: nieprawidłowy adres URL');
  }
  ensure(u.protocol === 'https:', 422, 'Webhook: adres musi zaczynać się od https://');
  ensure(!u.username && !u.password, 422, 'Webhook: adres nie może zawierać loginu ani hasła');
  ensure(!u.search && !u.hash, 422, 'Webhook: adres nie może zawierać parametrów (?…) ani fragmentu (#…)');
  ensure(!u.port || u.port === '443', 422, 'Webhook: dozwolony jest tylko port 443');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host))
    throw new Problem(422, privateIp(host) ? 'Webhook: adres prywatny, lokalny lub zastrzeżony jest niedozwolony' : 'Webhook: podaj adres domenowy zamiast adresu IP');
  ensure(
    host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local') && !host.endsWith('.internal') && host.includes('.'),
    422,
    'Webhook: adres lokalny (localhost, .local) jest niedozwolony',
  );
  return normalizeWebhookUrl(u.href);
}

// The rule stores the canonical URL, the same string the queued job carries and the worker compares.
const webhookSchema = z.strictObject({ subscription_id: optional(uuid), url: optional(z.string().max(2000).transform(normalizeWebhookUrl)) });
type WebhookParams = z.infer<typeof webhookSchema>;

async function approvedSubscription(c: PoolClient, id: string) {
  return (
    await c.query('SELECT id,name,actor_id FROM outbound_subscriptions WHERE id=$1 AND enabled AND revoked_at IS NULL AND approved_at IS NOT NULL', [id])
  ).rows[0];
}

async function orderBody(env: EffectEnv, eventId: string, extra: Record<string, unknown> = {}) {
  const o = await lockedOrder(env.c, env.orderId);
  const items = (
    await env.c.query('SELECT sku,name,quantity,price,vat FROM order_items WHERE order_id=$1 ORDER BY sku,id LIMIT 500', [env.orderId])
  ).rows;
  return JSON.stringify({
    id: eventId,
    type: 'order.updated',
    organization_id: env.actor.tenantId,
    occurred_at: new Date().toISOString(),
    automation: { rule_id: env.rule.id, rule_name: env.rule.name, run_id: env.runId },
    order: {
      id: o.id,
      number: o.number,
      version: o.version,
      status: o.status,
      total: o.total,
      currency: o.currency,
      warehouse_id: o.warehouse_id,
      workflow_status_id: o.workflow_status_id,
    },
    items: items.map((i) => ({ sku: i.sku, name: i.name, quantity: i.quantity, price: i.price, vat: i.vat })),
    ...extra,
  });
}

/** Approved subscription: the same outbound event + delivery + job as the built-in effect. */
async function sendToSubscription(env: EffectEnv, subscriptionId: string, extra: Record<string, unknown> = {}) {
  const { c } = env;
  const sub = await approvedSubscription(c, subscriptionId);
  ensure(sub, 422, 'Webhook nie jest już zatwierdzony');
  const id = randomUUID();
  const body = await orderBody(env, id, extra);
  await c.query('INSERT INTO outbound_events(id,tenant_id,event_type,payload,body) VALUES($1,$2,$3,$4,$5)', [id, env.actor.tenantId, 'order.updated', body, body]);
  const delivery = randomUUID(),
    job = randomUUID();
  await c.query("INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,'outbound.webhook',$3,$4,8)", [
    job,
    env.actor.tenantId,
    JSON.stringify({ delivery_id: delivery, actor_id: sub.actor_id }),
    'outbound:' + delivery,
  ]);
  await c.query('INSERT INTO outbound_deliveries(id,tenant_id,event_id,subscription_id,job_id) VALUES($1,$2,$3,$4,$5)', [delivery, env.actor.tenantId, id, sub.id, job]);
  return String(sub.name);
}

/** URL typed in the rule: queued after commit by the worker (processRuleWebhook), never sent inside the savepoint. */
async function queueUrlWebhook(env: EffectEnv, url: string, index: number) {
  const delivery = stableKey('v2-webhook', env.runId, env.rule.id, String(index));
  const eventId = stableKey('v2-webhook-event', env.runId, env.rule.id, String(index));
  const payload: RuleWebhookJob = {
    url,
    body: await orderBody(env, eventId),
    event_id: eventId,
    delivery_id: delivery,
    rule_id: env.rule.id,
    rule_name: env.rule.name,
    order_id: env.orderId,
  };
  const r = await env.c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,'outbound.webhook',$3,$4,6) ON CONFLICT (tenant_id,dedup_key) DO NOTHING",
    [randomUUID(), env.actor.tenantId, JSON.stringify({ rule_webhook: payload }), 'v2webhook:' + delivery],
  );
  return Boolean(r.rowCount);
}

const webhook: EffectHandler<WebhookParams> = {
  schema: webhookSchema,
  async validate(c, p) {
    ensure(Boolean(p.subscription_id) !== Boolean(p.url), 422, 'Webhook: wybierz zatwierdzony webhook albo wpisz adres https:// (jedno z dwóch)');
    if (p.url) checkWebhookUrl(p.url);
    if (p.subscription_id) ensure(await approvedSubscription(c, p.subscription_id), 422, 'Webhook musi być zatwierdzonym punktem odbioru tej organizacji');
  },
  describe: (p, names) =>
    p.url ? `Wyśle zamówienie (JSON, podpis HMAC) na ${(() => { try { return new URL(p.url).host; } catch { return p.url; } })()}` : `Wyśle webhook ${names[p.subscription_id ?? ''] ?? p.subscription_id}`,
  async apply(env, p, index) {
    if (p.subscription_id) return result('webhook', true, `Wysłano webhook „${await sendToSubscription(env, p.subscription_id)}”`);
    ensure(p.url, 422, 'Webhook: brak adresu');
    const url = checkWebhookUrl(p.url);
    const queued = await queueUrlWebhook(env, url, index);
    return result(
      'webhook',
      queued,
      queued
        ? `Zlecono wysyłkę do ${new URL(url).host}; kod HTTP albo błąd trafi do historii zamówienia`
        : 'Wysyłkę tego webhooka zlecono już wcześniej',
    );
  },
};

// ---------- notify_team ----------
const TEAM_ROLES = { admin: 'administratorzy', operator: 'operatorzy' } as const;
type TeamRole = keyof typeof TEAM_ROLES;
const notifySchema = z.strictObject({
  message: z.string().trim().min(1).max(500),
  user_ids: z.array(uuid).max(20).default([]),
  role: optional(z.enum(['admin', 'operator'])),
  email: z.boolean().default(false),
  email_template_id: optional(uuid),
  subscription_id: optional(uuid),
});
type NotifyParams = z.infer<typeof notifySchema>;
type TeamMember = { name: string; role: string };

/** Admins and operators of the tenant (075/081 SECURITY DEFINER reader, paged by user id). */
async function teamMembers(c: PoolClient): Promise<Map<string, TeamMember>> {
  const out = new Map<string, TeamMember>();
  let after: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page: Array<{ user_id: string; name: string; role: string }> = (await c.query('SELECT user_id,name,role FROM customer_message_eligible_assignees($1)', [after])).rows;
    for (const r of page) out.set(r.user_id, { name: r.name, role: r.role });
    if (page.length < 101) break;
    after = page[page.length - 1].user_id;
  }
  return out;
}

/** Chosen people still in the team plus everyone with the chosen role, without repeats, in a stable order. */
function recipients(team: Map<string, TeamMember>, p: NotifyParams): string[] {
  const byRole = p.role ? [...team].filter(([, m]) => m.role === p.role).map(([id]) => id).sort() : [];
  return [...new Set([...p.user_ids.filter((u) => team.has(u)), ...byRole])];
}

const tooMany = (n: number) => `Powiadom zespół: najwyżej ${TEAM_EMAIL_LIMIT} adresatów (wybrano ${n}); wybierz osoby zamiast całej roli`;

const notifyTeam: EffectHandler<NotifyParams> = {
  schema: notifySchema,
  async validate(c, p) {
    ensure(new Set(p.user_ids).size === p.user_ids.length, 422, 'Powiadom zespół: osoba wybrana dwa razy');
    ensure(!p.email || p.user_ids.length > 0 || p.role, 422, 'Powiadom zespół: e-mail wymaga wybrania osób lub roli');
    ensure(!p.email || p.email_template_id, 422, 'Powiadom zespół: e-mail wymaga szablonu e-mail');
    ensure(!p.email_template_id || p.email, 422, 'Powiadom zespół: zaznacz „Wyślij też e-mail”, aby użyć szablonu');
    if (p.email_template_id)
      ensure(
        (await c.query('SELECT 1 FROM email_templates WHERE id=$1 AND active', [p.email_template_id])).rowCount,
        422,
        'Powiadom zespół: szablon e-mail jest nieaktywny lub spoza organizacji',
      );
    if (p.user_ids.length || p.role) {
      const team = await teamMembers(c);
      ensure(p.user_ids.every((u) => team.has(u)), 422, 'Powiadom zespół: osoba nie należy do zespołu (administrator lub operator)');
      const n = recipients(team, p).length;
      ensure(n <= TEAM_EMAIL_LIMIT, 422, tooMany(n));
    }
    if (p.subscription_id)
      ensure(await approvedSubscription(c, p.subscription_id), 422, 'Powiadom zespół: komunikator musi być zatwierdzonym webhookiem tej organizacji');
  },
  describe: (p, names) => {
    const who = [...p.user_ids.map((u) => names[u] ?? u), ...(p.role ? [`wszyscy ${TEAM_ROLES[p.role as TeamRole]}`] : [])].join(', ');
    const channels = [
      who && `w systemie: ${who}`,
      p.email && `e-mail${p.email_template_id ? ` szablonem ${names[p.email_template_id] ?? p.email_template_id}` : ''}`,
      p.subscription_id && `komunikator ${names[p.subscription_id] ?? ''}`.trim(),
    ].filter(Boolean);
    return `Powiadomi zespół${channels.length ? ` (${channels.join('; ')})` : ''}: ${p.message.slice(0, 80)}`;
  },
  async apply(env, p, index) {
    const { c, actor, orderId } = env;
    const o = (await c.query('SELECT number FROM orders WHERE id=$1', [orderId])).rows[0];
    ensure(o, 404, 'Nie znaleziono zamówienia');
    await localOrderEvent(c, actor.tenantId, orderId, 'automation.notify', { rule_id: env.rule.id, rule_name: env.rule.name, message: p.message });
    await audit(c, actor, 'automation.notify', orderId, { rule_id: env.rule.id, message: p.message });
    const parts = ['historia zamówienia'];
    if (p.user_ids.length || p.role) {
      const team = await teamMembers(c);
      const people = recipients(team, p);
      ensure(people.length <= TEAM_EMAIL_LIMIT, 422, tooMany(people.length));
      const detail = { rule_id: env.rule.id, rule_name: env.rule.name, run_id: env.runId, order_id: orderId, order_number: o.number, message: p.message };
      for (const u of people) await audit(c, actor, NOTIFICATION_ACTION, u, detail);
      parts.push(`w systemie: ${people.length} os.`);
      const gone = p.user_ids.filter((u) => !team.has(u)).length;
      if (gone) parts.push(`pominięto ${gone} os. spoza zespołu`);
      if (p.email && !p.email_template_id) parts.push('e-mail pominięty: wybierz szablon e-maila w regule');
      else if (p.email && !people.length) parts.push('e-mail: brak adresatów w zespole');
      else if (p.email && p.email_template_id) {
        const r = await queueTeamEmails(env, p.email_template_id, people, index);
        if (r.queued) parts.push(`e-mail: ${r.queued} (kolejka modułu e-mail, tryb lokalny)`);
        if (r.reused) parts.push(`e-mail: zlecono już wcześniej (${r.reused})`);
        if (r.skipped) parts.push(`e-mail: pominięto ${r.skipped} os. bez adresu w zespole`);
      }
    }
    if (p.subscription_id) {
      const name = await sendToSubscription(env, p.subscription_id, { notification: { message: p.message } });
      parts.push(`komunikator: webhook „${name}”`);
    }
    return result('notify_team', true, `Powiadomiono zespół (${parts.join('; ')})`);
  },
};

export const effects: EffectModule = {
  handlers: { marketplace_message: marketplaceMessage, notify_team: notifyTeam, webhook },
  catalogParams: async (c) => {
    const [members, hooks, emailTemplates] = await Promise.all([
      c.query('SELECT user_id id,name FROM customer_message_eligible_assignees(NULL) ORDER BY name LIMIT 200'),
      c.query('SELECT id,name FROM outbound_subscriptions WHERE enabled AND revoked_at IS NULL AND approved_at IS NOT NULL ORDER BY name,id LIMIT 100'),
      c.query('SELECT id,name FROM email_templates WHERE active ORDER BY name,id LIMIT 200'),
    ]);
    const people = members.rows.map((m) => ({ value: m.id, label: m.name }));
    const subscriptions = hooks.rows.map((h) => ({ value: h.id, label: h.name }));
    return {
      marketplace_message: [{ key: 'body', label: 'Treść wiadomości (zmienne jak {{order_number}})', kind: 'textarea', required: true }],
      notify_team: [
        { key: 'message', label: 'Treść powiadomienia', kind: 'textarea', required: true },
        { key: 'user_ids', label: 'Osoby (powiadomienie w systemie i e-mail)', kind: 'multiselect', options: people },
        { key: 'role', label: 'Wszyscy z rolą (razem z wybranymi osobami)', kind: 'select', options: Object.entries(TEAM_ROLES).map(([value, label]) => ({ value, label: label[0].toUpperCase() + label.slice(1) })) },
        { key: 'email', label: 'Wyślij też e-mail do tych osób', kind: 'bool' },
        { key: 'email_template_id', label: `Szablon e-maila do zespołu (zmienne zamówienia, najwyżej ${TEAM_EMAIL_LIMIT} adresatów)`, kind: 'select', options: emailTemplates.rows.map((t) => ({ value: t.id, label: t.name })) },
        { key: 'subscription_id', label: 'Komunikator (zatwierdzony webhook)', kind: 'select', options: subscriptions },
      ],
      webhook: [
        { key: 'subscription_id', label: 'Zatwierdzony webhook', kind: 'select', options: subscriptions },
        { key: 'url', label: 'albo adres https:// (ERP, księgowość; podpis X-Dyna-Signature)', kind: 'text' },
      ],
    };
  },
};
