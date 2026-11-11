/** Creates only a fresh own QA136 firm and supplier. All file-source business writes belong to Chrome. */
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = resolve(process.env.QA_STATE_ROOT ?? '<workspace>/app');
assert.equal(root, '<workspace>/app');
const path = resolve(root, 'data/supplier-remote-feeds-stage136.json');
const prior = JSON.parse(await readFile('docs/supplier-remote-feeds-native-after.json', 'utf8'));
assert.equal(prior.status, 'PASS');
assert.equal(prior.tenants.length, 140);
const health = await (await fetch('http://127.0.0.1:4100/api/health')).json();
assert.match(process.env.QA_EXPECTED_REVISION ?? '', /^[a-f0-9]{40}$/);
assert.equal(health.revision, process.env.QA_EXPECTED_REVISION);
assert.equal(health.schema_revision, '119_supplier_remote_feeds');
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const suffix = randomUUID().slice(0, 8);
const state = {
  phase: 'READY_TO_SIGNUP',
  runtime: health.revision,
  email: `qa-remote-136-${suffix}@demo.local`,
  password: 'DynaSupplierDemo!2026',
  name: 'QA136 Remote feed',
  organization: `QA136 Remote feed ${suffix}`,
  cookie: '',
  tenant_id: '',
  user_id: '',
  supplier: null,
  warehouse_id: '',
  pending: null,
  completed: [],
};
await writeFile(path, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
assert.equal((await lstat(path)).mode & 0o777, 0o600);
const save = () => writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
async function post(route, body) {
  assert(['/auth/signup', '/suppliers'].includes(route));
  state.pending = { method: 'POST', route, body };
  state.phase = 'PENDING_WRITE';
  await save();
  let response;
  try {
    response = await fetch('http://127.0.0.1:4100/api' + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(state.cookie ? { cookie: state.cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    state.phase = 'UNKNOWN_RESULT_DO_NOT_RETRY';
    await save();
    throw new Error('Own setup write result unknown; inspect private ledger without retry');
  }
  assert.equal(response.status, 201, route + ' status ' + response.status);
  const data = await response.json();
  state.completed.push({ route, status: response.status, id: data.id ?? data.user?.tenant_id });
  state.pending = null;
  state.phase = 'CONFIRMED';
  if (route === '/auth/signup') {
    state.cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
    assert(state.cookie.startsWith('dyna_session='));
    state.tenant_id = data.user.tenant_id;
    state.user_id = data.user.id;
  }
  await save();
  return data;
}
await post('/auth/signup', {
  name: state.name,
  email: state.email,
  password: state.password,
  organization: { name: state.organization, currency: 'PLN', locale: 'pl-PL' },
});
state.supplier = await post('/suppliers', {
  name: 'Dostawca QA136 PUBLIC CSV DEMO',
  code: 'FEED136',
});
const w = await fetch('http://127.0.0.1:4100/api/warehouses', {
  headers: { cookie: state.cookie },
});
assert.equal(w.status, 200);
state.warehouse_id = (await w.json()).data[0].id;
state.phase = 'READY_FOR_CHROME';
await save();
await writeFile(
  'docs/supplier-remote-feeds-native-setup.json',
  JSON.stringify(
    {
      status: 'OWN_SETUP_ONLY',
      runtime: state.runtime,
      organization: state.organization,
      tenant_id: state.tenant_id,
      user_id: state.user_id,
      supplier_id: state.supplier.id,
      warehouse_id: state.warehouse_id,
      private_ledger_sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
      private_ledger_mode: '0600',
      source_writes: 0,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('OWN_SETUP_READY: ' + state.organization + '; source business writes:0');
