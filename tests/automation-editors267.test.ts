/** Migration 267 through the real app (buildApp, session cookies):
 * - "Automatyzacje: edycja": an operator without the grant is refused (403) on every write of /api/automations/v2;
 *   with the grant (given by the administrator in the team settings) the same writes pass; the grant is only for an
 *   operator, leaves with the operator role and is never taken from an API key;
 * - the category of a custom status (workflow_status267_categories): stored, read back, its stage's category by default,
 *   and the automation catalog groups statuses by category. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { migrate, pool } from '../server/db';
import { buildApp } from '../server/app';
import { DEFAULT_RUN } from '../shared/automation-v2';
import { seed } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
let app: FastifyInstance, tenant: string;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let n = 1;
const V2 = '/automations/v2';
const req = (url: string, method: any = 'GET', payload?: unknown, as = 'admin') =>
  app.inject({ url: '/api' + url, method, ...(payload === undefined ? {} : { payload: payload as any }), remoteAddress: '127.0.3.' + (n++ % 250 + 1), headers: { cookie: cookies[as] } });
async function ok(url: string, method: any = 'GET', payload?: unknown, as = 'admin') {
  const r = await req(url, method, payload, as);
  assert(r.statusCode < 300, method + ' ' + url + ' as ' + as + ': ' + r.body);
  return r.statusCode === 204 ? null : r.json();
}
async function status(url: string, method: any, payload: unknown, as: string) {
  return (await req(url, method, payload, as)).statusCode;
}
async function login(email: string) {
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  return String(r.headers['set-cookie']).split(';')[0];
}
async function switchTo(as: string) {
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, as);
  assert.equal(r.statusCode, 200, r.body);
  cookies[as] = String(r.headers['set-cookie']).split(';')[0];
  return r.json().user;
}
const body = (name = 'R267 ' + randomUUID().slice(0, 8)) => ({
  name,
  trigger: 'order.matches',
  enabled: false,
  config: {
    version: 2,
    group: 'Testy 267',
    scope: 'orders',
    run: { ...DEFAULT_RUN },
    conditions: { match: 'all', items: [] },
    effects: [{ type: 'add_tag', params: { tag: 'R267' } }],
    stop_further: false,
  },
});
const grant = (who: string, role: string, automation_editor?: boolean) =>
  req('/workspaces/members/' + ids[who], 'PATCH', { role, ...(automation_editor === undefined ? {} : { automation_editor }) });
const editorRow = async (who: string) =>
  (await pool.query('SELECT 1 FROM automation267_editors WHERE tenant_id=$1 AND user_id=$2', [tenant, ids[who]])).rowCount;

before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  // A fresh firm: admin@ administrator, operator@ operator (Magazynier), viewer@ read-only.
  tenant = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA Automatyzacje 267','enterprise')", [tenant]);
  for (const [who, role] of [['admin', 'admin'], ['operator', 'operator'], ['viewer', 'viewer']] as const) {
    ids[who] = (await pool.query('SELECT id FROM users WHERE email=$1', [who + '@demo.local'])).rows[0].id;
    await pool.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenant, ids[who], role]);
    cookies[who] = await login(who + '@demo.local');
  }
  for (const who of ['admin', 'operator', 'viewer']) await switchTo(who);
});
after(async () => {
  await app.close();
  await pool.end();
});

test('an operator without "Automatyzacje: edycja" is refused on every rule write; reads and runs stay as before', async () => {
  assert.equal((await ok('/auth/me', 'GET', undefined, 'operator')).user.automation_editor, false);
  const rule = await ok(V2 + '/rules', 'POST', body());
  for (const [url, method, payload] of [
    [V2 + '/rules', 'POST', body()],
    [V2 + '/rules/' + rule.id, 'PUT', { ...body(rule.name), version: rule.version }],
    [V2 + '/rules/' + rule.id + '/copy', 'POST', {}],
    [V2 + '/rules/order', 'PATCH', { ids: [rule.id] }],
    [V2 + '/rules/' + rule.id + '/preview', 'POST', {}],
    [V2 + '/rules/' + rule.id, 'DELETE', undefined],
  ] as const) {
    const r = await req(url, method, payload, 'operator');
    assert.equal(r.statusCode, 403, method + ' ' + url + ': ' + r.body);
    assert.match(r.json().detail ?? r.json().message ?? r.body, /Automatyzacje: edycja/);
    assert.equal(await status(url, method, payload, 'viewer'), 403, 'viewer ' + method + ' ' + url);
  }
  assert.equal((await ok(V2 + '/rules', 'GET', undefined, 'operator')).data.some((r: any) => r.id === rule.id), true);
  await ok(V2 + '/rules/' + rule.id, 'DELETE');
});

test('with the grant from the team settings the operator creates, changes, orders, previews, copies and deletes rules', async () => {
  const granted = await grant('operator', 'operator', true);
  assert.equal(granted.statusCode, 200, granted.body);
  assert.equal(await editorRow('operator'), 1);
  const members = (await ok('/workspaces/settings')).members;
  assert.deepEqual(
    Object.fromEntries(members.filter((m: any) => Object.values(ids).includes(m.id)).map((m: any) => [m.role, m.automation_editor])),
    { admin: true, operator: true, viewer: false },
  );
  assert.equal((await ok('/auth/me', 'GET', undefined, 'operator')).user.automation_editor, true);
  const created = await ok(V2 + '/rules', 'POST', body(), 'operator');
  const changed = await ok(V2 + '/rules/' + created.id, 'PUT', { ...body(created.name + ' zm.'), version: created.version }, 'operator');
  assert.equal(changed.name, created.name + ' zm.');
  await ok(V2 + '/rules/order', 'PATCH', { ids: [changed.id] }, 'operator');
  await ok(V2 + '/rules/' + changed.id + '/preview', 'POST', {}, 'operator');
  const copy = await ok(V2 + '/rules/' + changed.id + '/copy', 'POST', {}, 'operator');
  await ok(V2 + '/rules/' + copy.id, 'DELETE', undefined, 'operator');
  await ok(V2 + '/rules/' + changed.id, 'DELETE', undefined, 'operator');
  const audit = (await pool.query("SELECT detail FROM audit_events WHERE tenant_id=$1 AND action='workspace.role_changed' AND entity_id=$2 ORDER BY created_at DESC LIMIT 1", [tenant, ids.operator])).rows[0];
  assert.equal(audit.detail.automation_editor, true);
});

test('the grant is only for an operator, leaves with the operator role and is revoked by the administrator', async () => {
  assert.equal((await grant('viewer', 'viewer', true)).statusCode, 422, 'a viewer cannot hold it');
  assert.equal(await editorRow('viewer'), 0);
  assert.equal((await grant('operator', 'operator')).statusCode, 200, 'no flag keeps the grant');
  assert.equal(await editorRow('operator'), 1);
  // Operator -> viewer drops it; back to operator does not bring it back.
  assert.equal((await grant('operator', 'viewer')).statusCode, 200);
  assert.equal(await editorRow('operator'), 0);
  assert.equal((await grant('operator', 'operator')).statusCode, 200);
  assert.equal(await editorRow('operator'), 0);
  await switchTo('operator');
  assert.equal(await status(V2 + '/rules', 'POST', body(), 'operator'), 403);
  // Granted again, then revoked by the administrator: refused again on the next request.
  assert.equal((await grant('operator', 'operator', true)).statusCode, 200);
  assert.notEqual(await status(V2 + '/rules', 'POST', body(), 'operator'), 403);
  assert.equal((await grant('operator', 'operator', false)).statusCode, 200);
  assert.equal(await editorRow('operator'), 0);
  assert.equal(await status(V2 + '/rules', 'POST', body(), 'operator'), 403);
  // Only the administrator manages the team.
  assert.equal(await status('/workspaces/members/' + ids.operator, 'PATCH', { role: 'operator', automation_editor: true }, 'operator'), 403);
});

test('custom status category: stored, read back, default from the stage, grouped in the automation catalog', async () => {
  const problem = await ok('/workflow-statuses', 'POST', { name: 'Problem 267', color: '#D23B3B', stage: 'paid', active: true, category: 'not_completed' });
  assert.equal(problem.category, 'not_completed');
  const plain = await ok('/workflow-statuses', 'POST', { name: 'Pakowanie / Do zebrania DPD', stage: 'picking', active: true });
  assert.equal(plain.category, null, 'no row: the panel reads the stage category');
  assert.equal((await req('/workflow-statuses', 'POST', { name: 'Zła kategoria', stage: 'paid', category: 'lost' })).statusCode, 422);
  const list = (await ok('/workflow-statuses')).data;
  assert.equal(list.find((w: any) => w.id === problem.id).category, 'not_completed');
  const moved = await ok('/workflow-statuses/' + plain.id, 'PATCH', { ...plain, category: 'other' });
  assert.equal(moved.category, 'other');
  const kept = await ok('/workflow-statuses/' + plain.id, 'PATCH', { name: moved.name, color: moved.color, stage: moved.stage, active: true, version: moved.version });
  assert.equal(kept.category, 'other', 'without the field the category stays');
  const roundTrip = await ok('/workflow-statuses/' + problem.id, 'PATCH', { ...problem, category: null, name: 'Problem 267 b' });
  assert.equal(roundTrip.category, 'not_completed', 'a row sent back with category null keeps its category');
  const catalog = await ok(V2 + '/catalog', 'GET', undefined, 'viewer');
  const options = (key: string) => catalog.fields.find((f: any) => f.key === key).options;
  assert.deepEqual([...new Set(options('order.status').map((o: any) => o.group))], ['Nowe', 'W realizacji', 'Zrealizowane', 'Niezrealizowane', 'Pozostałe']);
  assert.equal(options('order.workflow_status').find((o: any) => o.value === problem.id).group, 'Niezrealizowane');
  assert.equal(options('order.workflow_status').find((o: any) => o.value === plain.id).group, 'Pozostałe');
});

test('demo data: "Problem" is a red custom status in Niezrealizowane, not an orders.status code', async () => {
  const demo = (await pool.query("SELECT w.name,w.color,w.stage,k.category FROM workflow_statuses w LEFT JOIN workflow_status267_categories k ON k.workflow_status_id=w.id WHERE w.tenant_id='11111111-1111-4111-8111-111111111111' AND w.name='Problem'")).rows;
  assert.deepEqual(demo, [{ name: 'Problem', color: '#D23B3B', stage: 'paid', category: 'not_completed' }]);
});
