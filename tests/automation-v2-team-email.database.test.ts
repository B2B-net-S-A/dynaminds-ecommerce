/**
 * Arkusz „Automatyzacje - katalog” wiersz 102: efekt „Powiadom zespół” wysyła e-mail do zespołu firmy (wybrane osoby
 * i/lub wszyscy z rolą) szablonem e-mail ze zmiennymi zamówienia, przez moduł e-mail (email_batches / email_messages /
 * zadanie 'email.send', tryb lokalny jak e-mail do kupującego z reguły). Adresaci tylko z zespołu tej samej firmy.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { tick } from '../server/worker';
import { applyEffect } from '../server/automation-v2-effects';
import { loadOrderContexts } from '../server/automation-v2-context';
import { exportBundleInTx } from '../server/rodo228';
import { repliedOrdersInTx } from '../server/inbound-auto253';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, operator: string, warehouse: string, product: string;
let adminId: string, operatorId: string, viewerId: string, otherTenantUserId: string, tenant: string;
let template: string, plainTemplate: string, inactiveTemplate: string;
const V2 = '/api/automations/v2';
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) => app.inject({ url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
const userId = async (email: string) => (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id as string;
async function emailTemplate(name: string, subject: string, body: string, html = '') {
  return (await ok('/api/email/templates', 'POST', { name, subject, body, html, client_key: randomUUID() })).id as string;
}

before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = async (email: string) => {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  };
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  [adminId, operatorId, viewerId, otherTenantUserId] = await Promise.all(
    ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local', 'other@demo.local'].map(userId),
  );
  warehouse = (await ok('/api/warehouses')).data[0].id;
  tenant = (await pool.query('SELECT tenant_id FROM warehouses WHERE id=$1', [warehouse])).rows[0].tenant_id;
  product = (await ok('/api/products', 'POST', { name: 'E-mail zespołu', sku: 'V2T-' + randomUUID(), price: 1990, warehouse_id: warehouse, quantity: 1000 })).id;
  template = await emailTemplate('Zespół: pilne ' + randomUUID().slice(0, 6), 'Pilne {{order_number}}', 'Kupujący {{customer_name}} czeka', '<p>Kupujący: {{customer_name}}</p>');
  plainTemplate = await emailTemplate('Zespół: tekst ' + randomUUID().slice(0, 6), 'Sprawdź {{order_number}}', 'Wartość {{total}} {{currency}}');
  inactiveTemplate = await emailTemplate('Zespół: wyłączony ' + randomUUID().slice(0, 6), 'X', 'Y');
  await pool.query('UPDATE email_templates SET active=false WHERE id=$1', [inactiveTemplate]);
});
beforeEach(async () => {
  await pool.query('UPDATE automation_rules SET enabled=false,version=version+1 WHERE enabled');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE state IN ('pending','running')");
});
after(async () => {
  await app.close();
  await pool.end();
});

async function order(customer_name = 'QA zespół', email = 'kupujacy-v2t@example.test') {
  return ok('/api/orders', 'POST', {
    customer_name,
    email,
    warehouse_id: warehouse,
    items: [{ product_id: product, quantity: 1 }],
    address: { country: 'PL', city: 'Kraków', phone: '500600700' },
  });
}
const body = (effects: any[]) => ({
  name: 'V2T ' + randomUUID().slice(0, 8),
  trigger: 'order.matches',
  enabled: true,
  config: { version: 2, group: 'Testy', scope: 'orders', run: { ...DEFAULT_RUN, auto: false, manual_button: true }, conditions: { match: 'all', items: [] }, effects, stop_further: false },
});
const create = (effects: any[]) => ok(V2 + '/rules', 'POST', body(effects));
const refused = async (effects: any[], pattern: RegExp) => {
  const r = await req(V2 + '/rules', 'POST', body(effects));
  assert.equal(r.statusCode, 422, r.body);
  assert.match(r.json().message ?? r.body, pattern);
};
async function run(ruleId: string, orderId: string, cookie = admin) {
  const [r] = (await ok(V2 + '/rules/' + ruleId + '/run', 'POST', { order_ids: [orderId] }, cookie)).runs;
  const row = (await pool.query('SELECT result FROM automation_runs WHERE id=$1', [r.id])).rows[0];
  return { ...r, effects: (row?.result?.effects ?? []) as Array<{ type: string; changed: boolean; message: string }> };
}
async function drain() {
  for (let i = 0; i < 300; i++) if (!(await tick({ transport: async () => new Response(null, { status: 200 }) }))) return;
  assert.fail('Kolejka nie wygasła w 300 krokach');
}
const mails = async (orderId: string) =>
  (
    await pool.query(
      `SELECT m.id,m.state,m.payload,m.snapshot,m.job_id,m.error,b.automation_run_id,b.mode,b.template_id
       FROM email_messages m JOIN email_batches b ON (b.tenant_id,b.id)=(m.tenant_id,m.batch_id) WHERE m.order_id=$1 ORDER BY m.payload->>'recipient'`,
      [orderId],
    )
  ).rows;
const notify = (extra: Record<string, unknown>) => ({ type: 'notify_team', params: { message: 'Sprawdź zamówienie', email: true, email_template_id: template, ...extra } });

test('katalog: „Powiadom zespół” ma wybór roli i szablonu e-maila do zespołu', async () => {
  const params = (await ok(V2 + '/catalog')).effects.find((e: any) => e.type === 'notify_team').params;
  const role = params.find((p: any) => p.key === 'role');
  assert.deepEqual(role.options.map((o: any) => o.value).sort(), ['admin', 'operator']);
  const t = params.find((p: any) => p.key === 'email_template_id');
  assert.equal(t.kind, 'select');
  assert.ok(t.options.some((o: any) => o.value === template));
  assert.ok(!t.options.some((o: any) => o.value === inactiveTemplate), 'nieaktywny szablon nie jest do wyboru');
});

test('e-mail do wybranej osoby i całej roli: szablon ze zmiennymi zamówienia, HTML escapowany, kolejka modułu e-mail', async () => {
  const r = await create([notify({ user_ids: [operatorId], role: 'admin' })]);
  const o = await order('<b>Ala & Ola</b>');
  const x = await run(r.id, o.id, operator);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.match(x.effects[0].message, /w systemie: 2 os\.; e-mail: 2/);
  const m = await mails(o.id);
  assert.deepEqual(m.map((r) => r.payload.recipient), ['admin@demo.local', 'operator@demo.local']);
  for (const row of m) {
    assert.equal(row.payload.subject, `Pilne ${o.number}`);
    assert.equal(row.payload.text, 'Kupujący <b>Ala & Ola</b> czeka');
    assert.equal(row.payload.html, '<p>Kupujący: &lt;b&gt;Ala &amp; Ola&lt;/b&gt;</p>');
    assert.equal(row.state, 'queued');
    assert.equal(row.automation_run_id, x.id);
    assert.equal(row.mode, 'local');
    assert.equal(row.template_id, template);
  }
  assert.deepEqual(m.map((r) => r.snapshot.team_user_id).sort(), [adminId, operatorId].sort());
  assert.ok(!m.some((r) => r.payload.recipient === 'kupujacy-v2t@example.test'), 'nic nie idzie do kupującego');
  // In-app notifications reached the same two people.
  const inApp = (await pool.query("SELECT entity_id FROM audit_events WHERE action='automation.notification' AND detail->>'order_id'=$1", [o.id])).rows;
  assert.deepEqual(inApp.map((r) => r.entity_id).sort(), [adminId, operatorId].sort());
  await drain();
  const sent = await mails(o.id);
  assert.deepEqual(sent.map((r) => r.state), ['simulated', 'simulated']);
  // A staff reply to the notification (In-Reply-To = our Message-ID, From = the staff recipient) is no buyer message.
  const replied = await tenantTx(tenant, (c) => repliedOrdersInTx(c, sent.map((r) => r.id), 'admin@demo.local'));
  assert.deepEqual(replied, []);
  // A team e-mail is not "template sent to the buyer" for conditions, and the buyer's data export hides staff addresses.
  const ctx = await tenantTx(tenant, async (c) => (await loadOrderContexts(c, [o.id])).get(o.id)!);
  assert.ok(Array.isArray(ctx.values['history.template_sent']));
  assert.ok(!(ctx.values['history.template_sent'] as string[]).includes(template));
  const orderRow = (await pool.query('SELECT * FROM orders WHERE id=$1', [o.id])).rows[0];
  const bundle: any = await tenantTx(tenant, (c) =>
    exportBundleInTx(c, { tenantId: tenant, userId: adminId, role: 'admin' } as any, { clients: [], orders: [orderRow], emails: [], phones: [], hash: 'x', hashes: [] }, 'klucz-testowy', new Date()),
  );
  const exported = bundle.wiadomosci.filter((w: any) => w.kanal === 'email');
  assert.equal(exported.length, 2);
  assert.ok(exported.every((w: any) => w.odbiorca === 'zespół sprzedawcy'), JSON.stringify(exported));
});

test('bez HTML w szablonie treść tekstowa trafia do HTML escapowana; brak szablonu HTML nie psuje wysyłki', async () => {
  const r = await create([notify({ user_ids: [adminId], email_template_id: plainTemplate })]);
  const o = await order();
  const x = await run(r.id, o.id);
  assert.equal(x.status, 'done', JSON.stringify(x));
  const [m] = await mails(o.id);
  assert.equal(m.payload.subject, `Sprawdź ${o.number}`);
  assert.match(m.payload.html, /^<p>Wartość .+<\/p>$/);
});

test('idempotencja: ponowne wykonanie efektu w tym samym przebiegu i ponowne zadanie e-mail nie wysyłają drugi raz', async () => {
  const r = await create([notify({ user_ids: [adminId, operatorId] })]);
  const o = await order();
  const x = await run(r.id, o.id);
  assert.equal(x.status, 'done', JSON.stringify(x));
  const again = await tenantTx(tenant, (c) =>
    applyEffect(
      {
        c,
        actor: { tenantId: tenant, userId: adminId, role: 'admin' } as any,
        orderId: o.id,
        runId: x.id,
        rule: { id: r.id, name: r.name },
        context: { chain_id: randomUUID(), depth: 1, trace: [] } as any,
        runRule: async () => '',
      },
      notify({ user_ids: [adminId, operatorId] }),
      0,
    ),
  );
  assert.match(again.message, /e-mail: zlecono już wcześniej \(2\)/);
  assert.equal((await mails(o.id)).length, 2);
  await drain();
  const first = await mails(o.id);
  assert.deepEqual(first.map((m) => m.state), ['simulated', 'simulated']);
  // The worker gets the same e-mail jobs again (e.g. after a restart): nothing is sent twice.
  await pool.query("UPDATE jobs SET state='pending',lease_token=NULL,attempts=0 WHERE id=ANY($1::uuid[])", [first.map((m) => m.job_id)]);
  await drain();
  assert.deepEqual((await mails(o.id)).map((m) => m.state), ['simulated', 'simulated']);
  const results = (await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='email.result' AND entity_id=ANY($1::uuid[])", [first.map((m) => m.id)])).rows[0].n;
  assert.equal(results, 2);
});

test('odmowy przy zapisie: osoba spoza firmy, brak adresatów, brak lub nieaktywny szablon, nieznana rola', async () => {
  await refused([notify({ user_ids: [otherTenantUserId] })], /nie należy do zespołu/);
  await refused([notify({ user_ids: [randomUUID()] })], /nie należy do zespołu/);
  await refused([notify({ user_ids: [viewerId] })], /nie należy do zespołu/);
  await refused([notify({ user_ids: [] })], /e-mail wymaga wybrania osób lub roli/);
  await refused([notify({ user_ids: [adminId], email_template_id: undefined })], /e-mail wymaga szablonu/);
  await refused([notify({ user_ids: [adminId], email_template_id: inactiveTemplate })], /szablon e-mail jest nieaktywny/);
  await refused([notify({ user_ids: [adminId], email_template_id: randomUUID() })], /szablon e-mail jest nieaktywny/);
  await refused([notify({ role: 'viewer' })], /uzupełnij/);
  await refused([{ type: 'notify_team', params: { message: 'X', user_ids: [adminId], email_template_id: template } }], /zaznacz „Wyślij też e-mail”/);
});

test('osoba usunięta z zespołu po zapisie reguły nie dostaje e-maila; po zakolejkowaniu wiadomość do niej przepada', async () => {
  const r = await create([notify({ user_ids: [operatorId] })]);
  await pool.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND tenant_id=$2", [operatorId, tenant]);
  try {
    const o = await order();
    const x = await run(r.id, o.id);
    assert.equal(x.status, 'done', JSON.stringify(x));
    assert.match(x.effects[0].message, /pominięto 1 os\. spoza zespołu; e-mail: brak adresatów w zespole/);
    assert.equal((await mails(o.id)).length, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND tenant_id=$2", [operatorId, tenant]);
  }
  // Queued while still in the team, sent after leaving it: the worker re-checks the team and refuses.
  const r2 = await create([notify({ user_ids: [adminId, operatorId] })]);
  const o2 = await order();
  assert.equal((await run(r2.id, o2.id)).status, 'done');
  await pool.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND tenant_id=$2", [operatorId, tenant]);
  try {
    await drain();
  } finally {
    await pool.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND tenant_id=$2", [operatorId, tenant]);
  }
  const states = Object.fromEntries((await mails(o2.id)).map((m) => [m.snapshot.team_user_id, m.state]));
  assert.deepEqual(states, { [adminId]: 'simulated', [operatorId]: 'failed' });
});

test('stara reguła z e-mailem bez szablonu: e-mail pominięty z widocznym powodem, reszta powiadomienia działa', async () => {
  const r = await create([notify({ user_ids: [adminId] })]);
  await pool.query("UPDATE automation_rules SET config=jsonb_set(config,'{effects,0,params}',(config#>'{effects,0,params}')-'email_template_id') WHERE id=$1", [r.id]);
  const o = await order();
  const x = await run(r.id, o.id);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.match(x.effects[0].message, /e-mail pominięty: wybierz szablon e-maila w regule/);
  assert.equal((await mails(o.id)).length, 0);
});

test('limit adresatów: rola z więcej niż 20 osobami jest odrzucana', async () => {
  const extra = Array.from({ length: 20 }, () => randomUUID());
  for (const id of extra) {
    await pool.query("INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,'x')", [id, `op-${id.slice(0, 8)}@demo.local`, 'Operator ' + id.slice(0, 4)]);
    await pool.query("INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'operator')", [id, tenant]);
  }
  try {
    await refused([notify({ role: 'operator' })], /najwyżej 20 adresatów/);
    await create([notify({ role: 'admin' })]);
  } finally {
    await pool.query('DELETE FROM memberships WHERE user_id=ANY($1::uuid[])', [extra]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [extra]);
  }
});
