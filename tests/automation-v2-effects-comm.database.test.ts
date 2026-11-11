import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { tick } from '../server/worker';
import { checkWebhookUrl } from '../server/automation-v2-effects-comm';
import { verifyWebhook } from '../server/outbound-webhooks';
import { DEFAULT_RUN } from '../shared/automation-v2';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, operator: string, viewer: string, warehouse: string, product: string;
let adminId: string, operatorId: string, viewerId: string, tenant: string, subscription: string;
const V2 = '/api/automations/v2';
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) => app.inject({ url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, `${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
}
const userId = async (email: string) => (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id as string;
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
  viewer = await login('viewer@demo.local');
  [adminId, operatorId, viewerId] = await Promise.all(['admin@demo.local', 'operator@demo.local', 'viewer@demo.local'].map(userId));
  warehouse = (await ok('/api/warehouses')).data[0].id;
  tenant = (await pool.query('SELECT tenant_id FROM warehouses WHERE id=$1', [warehouse])).rows[0].tenant_id;
  product = (await ok('/api/products', 'POST', { name: 'Komunikacja v2', sku: 'V2C-' + randomUUID(), price: 2500, warehouse_id: warehouse, quantity: 1000 })).id;
  // An approved local outbound subscription (the "messenger" / registered webhook).
  const s = await req('/api/developer/webhooks', 'POST', { name: 'Komunikator QA', events: ['order.created'], mode: 'local' });
  assert.equal(s.statusCode, 201, s.body);
  subscription = s.json().id;
  await ok('/api/developer/webhooks/' + subscription + '/enable', 'POST', { confirm_destination: 'local' });
});
beforeEach(async () => {
  await pool.query('UPDATE automation_rules SET enabled=false,version=version+1 WHERE enabled');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL WHERE state IN ('pending','running')");
});
after(async () => {
  await app.close();
  await pool.end();
});

async function order(email = 'v2c@example.test') {
  return ok('/api/orders', 'POST', {
    customer_name: 'QA komunikacja',
    email,
    warehouse_id: warehouse,
    items: [{ product_id: product, quantity: 2 }],
    address: { country: 'PL', city: 'Warszawa', phone: '500600700' },
  });
}
const body = (effects: any[]) => ({
  name: 'V2C ' + randomUUID().slice(0, 8),
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
type Sent = { url: string; headers: Record<string, string>; body: string };
async function drain(respond: (s: Sent) => number = () => 200) {
  const sent: Sent[] = [];
  const transport = async (url: string, init: RequestInit) => {
    const s = { url, headers: init.headers as Record<string, string>, body: String(init.body) };
    sent.push(s);
    return new Response(null, { status: respond(s) });
  };
  for (let i = 0; i < 300; i++) if (!(await tick({ transport }))) return sent;
  assert.fail('Kolejka nie wygasła w 300 krokach');
}

// ---------- marketplace_message ----------
test('marketplace_message: reply in the buyer thread of the order, with variables', async () => {
  const r = await create([{ type: 'marketplace_message', params: { body: 'Zamówienie {{order_number}} jest w drodze' } }]);
  const o = await order();
  const x = await run(r.id, o.id, operator);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.match(x.effects[0].message, /wątku zamówienia/);
  const m = (await pool.query("SELECT kind,body FROM customer_messages WHERE order_id=$1 AND kind='reply'", [o.id])).rows;
  assert.equal(m.length, 1);
  assert.equal(m[0].body, `Zamówienie ${o.number} jest w drodze`);
});

test('marketplace_message: marketplace conversation gets a pending reply for its connector', async () => {
  const o = await order();
  const conn = randomUUID(), thread = randomUUID();
  await pool.query("INSERT INTO channel253_connections(id,tenant_id,channel,name,created_by) VALUES($1,$2,'allegro',$3,$4)", [conn, tenant, 'Allegro QA ' + conn.slice(0, 6), adminId]);
  await pool.query("INSERT INTO channel253_threads(id,tenant_id,connection_id,channel,external_thread_id,order_id) VALUES($1,$2,$3,'allegro',$4,$5)", [thread, tenant, conn, 'ext-' + thread, o.id]);
  const r = await create([{ type: 'marketplace_message', params: { body: 'Dziękujemy za zakup' } }]);
  const x = await run(r.id, o.id);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.match(x.effects[0].message, /skrzynce Allegro.*konektor/);
  const m = (await pool.query('SELECT kind,state,body FROM channel253_messages WHERE thread_id=$1', [thread])).rows;
  assert.deepEqual(m, [{ kind: 'reply', state: 'pending', body: 'Dziękujemy za zakup' }]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM customer_messages WHERE order_id=$1', [o.id])).rows[0].n, 0);
});

test('marketplace_message: refused without a message channel and for an unknown variable', async () => {
  await refused([{ type: 'marketplace_message', params: { body: 'Kod {{rabat}}' } }], /nieznana zmienna/);
  await refused([{ type: 'marketplace_message', params: { body: '' } }], /uzupełnij/);
  const r = await create([{ type: 'add_tag', params: { tag: 'Wiadomość' } }, { type: 'marketplace_message', params: { body: 'Halo' } }]);
  const o = await order();
  await pool.query('UPDATE orders SET portal_enabled=false WHERE id=$1', [o.id]);
  const x = await run(r.id, o.id);
  assert.equal(x.status, 'failed');
  assert.match(x.error, /nie ma kanału wiadomości z kupującym/);
  assert.ok(!(await ok('/api/orders/' + o.id)).tags.includes('Wiadomość'), 'odmowa wycofuje wcześniejsze efekty reguły');
});

// ---------- notify_team ----------
test('notify_team: history, in-app notifications with read state and messenger webhook (e-mail: automation-v2-team-email.database.test.ts)', async () => {
  const cat = await ok(V2 + '/catalog');
  const params = cat.effects.find((e: any) => e.type === 'notify_team').params;
  assert.ok(params.find((p: any) => p.key === 'user_ids').options.some((o: any) => o.value === operatorId));
  const r = await create([{ type: 'notify_team', params: { message: 'Pilne: sprawdź adres', user_ids: [adminId, operatorId], subscription_id: subscription } }]);
  const o = await order();
  const x = await run(r.id, o.id);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.match(x.effects[0].message, /w systemie: 2 os\.; komunikator: webhook „Komunikator QA”/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='automation.notify'", [o.id])).rows[0].n, 1);
  const d = (await pool.query("SELECT e.payload FROM outbound_deliveries d JOIN outbound_events e ON e.id=d.event_id WHERE d.subscription_id=$1 AND e.event_type='order.updated' AND e.payload->'order'->>'id'=$2", [subscription, o.id])).rows;
  assert.equal(d.length, 1);
  assert.equal(d[0].payload.notification.message, 'Pilne: sprawdź adres');
  // In-app list of the operator: unread → read one → read all.
  const list = await ok(V2 + '/notifications', 'GET', undefined, operator);
  const mine = list.data.find((n: any) => n.order_id === o.id);
  assert.ok(mine && !mine.read && mine.message === 'Pilne: sprawdź adres' && mine.order_number === o.number);
  assert.ok(list.unread >= 1);
  const afterRead = await ok(V2 + '/notifications/' + mine.id + '/read', 'POST', {}, operator);
  assert.equal(afterRead.unread, list.unread - 1);
  assert.equal((await ok(V2 + '/notifications', 'GET', undefined, operator)).data.find((n: any) => n.id === mine.id).read, true);
  // Someone else's notification is not visible or markable.
  assert.equal((await req(V2 + '/notifications/' + mine.id + '/read', 'POST', {}, viewer)).statusCode, 404);
  assert.ok(!(await ok(V2 + '/notifications', 'GET', undefined, viewer)).data.some((n: any) => n.id === mine.id));
  await ok(V2 + '/notifications/read-all', 'POST', {}, admin);
  assert.equal((await ok(V2 + '/notifications', 'GET', undefined, admin)).unread, 0);
});

test('notify_team: legacy rule with only message still works; wrong people and channels are refused', async () => {
  const legacy = await create([{ type: 'notify_team', params: { message: 'Sprawdź' } }]);
  const o = await order();
  const x = await run(legacy.id, o.id);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.equal(x.effects[0].message, 'Powiadomiono zespół (historia zamówienia)');
  await refused([{ type: 'notify_team', params: { message: 'X', user_ids: [randomUUID()] } }], /nie należy do zespołu/);
  await refused([{ type: 'notify_team', params: { message: 'X', user_ids: [viewerId] } }], /nie należy do zespołu/);
  await refused([{ type: 'notify_team', params: { message: 'X', email: true } }], /e-mail wymaga wybrania osób/);
  await refused([{ type: 'notify_team', params: { message: 'X', subscription_id: randomUUID() } }], /komunikator musi być zatwierdzonym/);
  // A messenger revoked after the rule was saved: the run fails and rolls back the history entry.
  const s = await req('/api/developer/webhooks', 'POST', { name: 'Komunikator do wyłączenia', events: ['order.created'], mode: 'local' });
  const sid = s.json().id;
  await ok('/api/developer/webhooks/' + sid + '/enable', 'POST', { confirm_destination: 'local' });
  const r = await create([{ type: 'notify_team', params: { message: 'Y', subscription_id: sid } }]);
  await ok('/api/developer/webhooks/' + sid + '/revoke', 'POST', {});
  const o2 = await order();
  const f = await run(r.id, o2.id);
  assert.equal(f.status, 'failed');
  assert.match(f.error, /nie jest już zatwierdzony/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='automation.notify'", [o2.id])).rows[0].n, 0);
});

// ---------- webhook ----------
test('webhook: private, local and non-https URLs are refused at save', async () => {
  for (const url of [
    'http://erp.example.com/hook',
    'https://10.0.0.1/',
    'https://192.168.1.1/',
    'https://172.16.0.5/',
    'https://169.254.169.254/latest',
    'https://localhost/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://2130706433/',
    'https://erp.local/hook',
    'https://user:haslo@erp.example.com/hook',
    'https://erp.example.com:8443/hook',
    'https://erp.example.com/hook?token=1',
    'nie-adres',
  ])
    await refused([{ type: 'webhook', params: { url } }], /Webhook/);
  await refused([{ type: 'webhook', params: { url: 'https://10.0.0.1/' } }], /prywatny/);
  await refused([{ type: 'webhook', params: { url: 'https://localhost/' } }], /lokalny/);
  await refused([{ type: 'webhook', params: { url: 'http://erp.example.com/' } }], /https:\/\//);
  await refused([{ type: 'webhook', params: {} }], /jedno z dwóch/);
  await refused([{ type: 'webhook', params: { url: 'https://erp.example.com/a', subscription_id: subscription } }], /jedno z dwóch/);
  await refused([{ type: 'webhook', params: { subscription_id: randomUUID() } }], /zatwierdzonym/);
  assert.equal(checkWebhookUrl('https://ERP.example.com/hooks/dyna'), 'https://erp.example.com/hooks/dyna');
});

test('webhook: URL delivery is queued, signed with HMAC-SHA256 and its HTTP code lands in the order history', async () => {
  const url = 'https://erp.example.com/hooks/dyna';
  const r = await create([{ type: 'webhook', params: { url } }]);
  const o = await order();
  const x = await run(r.id, o.id, operator);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.match(x.effects[0].message, /Zlecono wysyłkę do erp\.example\.com/);
  const sent = (await drain()).filter((s) => s.url === url);
  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0].body);
  assert.equal(payload.order.id, o.id);
  assert.equal(payload.order.number, o.number);
  assert.deepEqual(payload.items.map((i: any) => i.quantity), [2]);
  assert.equal(payload.automation.rule_id, r.id);
  assert.equal(JSON.stringify(payload).includes('v2c@example.test'), false, 'bez danych osobowych kupującego');
  // The admin reads the secret; the receiver verifies the signature of the exact body.
  assert.equal((await req(V2 + '/rules/' + r.id + '/webhook-secret', 'GET', undefined, operator)).statusCode, 403);
  const { secret } = await ok(V2 + '/rules/' + r.id + '/webhook-secret');
  // Signed like the outbound webhooks: v1=HMAC(secret, "<timestamp>.<body>") with the same X-Dyna-Timestamp (no replay).
  const ts = sent[0].headers['X-Dyna-Timestamp'];
  assert.match(ts, /^\d{10}$/);
  assert.equal(sent[0].headers['X-Dyna-Signature'], 'v1=' + createHmac('sha256', secret).update(ts + '.').update(sent[0].body).digest('hex'));
  verifyWebhook(secret, Buffer.from(sent[0].body), ts, sent[0].headers['X-Dyna-Signature']);
  assert.match(sent[0].headers['X-Dyna-Delivery-ID'], /^[0-9a-f-]{36}$/);
  const ev = (await pool.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='automation.webhook'", [o.id])).rows;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.ok, true);
  assert.equal(ev[0].detail.message, 'Webhook wysłany: HTTP 200');
});

test('webhook: refused by the receiver (HTTP 404) is a Polish error in the history; disabled rule cancels the delivery', async () => {
  const url = 'https://erp.example.com/hooks/odmowa';
  const r = await create([{ type: 'webhook', params: { url } }]);
  const o = await order();
  assert.equal((await run(r.id, o.id)).status, 'done');
  const sent = (await drain((s) => (s.url === url ? 404 : 200))).filter((s) => s.url === url);
  assert.equal(sent.length, 1, 'błąd 4xx nie jest ponawiany');
  const ev = (await pool.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='automation.webhook'", [o.id])).rows;
  assert.equal(ev[0].detail.ok, false);
  assert.match(ev[0].detail.message, /Webhook nie wysłany: Odbiorca webhooka odpowiedział HTTP 404/);
  // Disabled after queuing: nothing is sent.
  const o2 = await order();
  assert.equal((await run(r.id, o2.id)).status, 'done');
  await pool.query('UPDATE automation_rules SET enabled=false WHERE id=$1', [r.id]);
  assert.equal((await drain()).filter((s) => s.url === url).length, 0);
  const ev2 = (await pool.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='automation.webhook'", [o2.id])).rows;
  assert.match(ev2[0].detail.message, /anulowany/);
});

test('webhook: URL without path, with upper-case host and :443 is stored normalized and still delivered', async () => {
  const r = await create([{ type: 'webhook', params: { url: 'https://ERP.Example.com:443' } }]);
  const stored = (await ok(V2 + '/rules')).data.find((x: any) => x.id === r.id).config.effects[0].params.url;
  assert.equal(stored, 'https://erp.example.com/');
  const o = await order();
  assert.equal((await run(r.id, o.id)).status, 'done');
  const sent = (await drain()).filter((s) => s.url === 'https://erp.example.com/');
  assert.equal(sent.length, 1, 'wysłany, nie anulowany');
  const ev = (await pool.query("SELECT detail FROM order_events WHERE order_id=$1 AND kind='automation.webhook'", [o.id])).rows;
  assert.equal(ev[0].detail.ok, true, JSON.stringify(ev));
});

test('run_rule: a nested rule with the same effect index keeps its own keys (webhook and marketplace message)', async () => {
  const inner = await create([
    { type: 'webhook', params: { url: 'https://erp.example.com/inner' } },
    { type: 'marketplace_message', params: { body: 'Wiadomość reguły wewnętrznej' } },
  ]);
  const outer = await create([
    { type: 'webhook', params: { url: 'https://erp.example.com/outer' } },
    { type: 'marketplace_message', params: { body: 'Wiadomość reguły zewnętrznej' } },
    { type: 'run_rule', params: { rule_id: inner.id } },
  ]);
  const o = await order();
  const x = await run(outer.id, o.id);
  assert.equal(x.status, 'done', JSON.stringify(x));
  const urls = (await drain()).map((s) => s.url).filter((u) => u.includes('/inner') || u.includes('/outer')).sort();
  assert.deepEqual(urls, ['https://erp.example.com/inner', 'https://erp.example.com/outer']);
  const bodies = (await pool.query("SELECT body FROM customer_messages WHERE order_id=$1 AND kind='reply' ORDER BY body", [o.id])).rows.map((m) => m.body);
  assert.deepEqual(bodies, ['Wiadomość reguły wewnętrznej', 'Wiadomość reguły zewnętrznej']);
});

test('webhook: approved subscription path keeps working', async () => {
  const r = await create([{ type: 'webhook', params: { subscription_id: subscription } }]);
  const o = await order();
  const x = await run(r.id, o.id);
  assert.equal(x.status, 'done', JSON.stringify(x));
  assert.match(x.effects[0].message, /Wysłano webhook „Komunikator QA”/);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM outbound_deliveries d JOIN outbound_events e ON e.id=d.event_id WHERE d.subscription_id=$1 AND e.event_type='order.updated' AND e.payload->'order'->>'id'=$2", [subscription, o.id])).rows[0].n,
    1,
  );
});
