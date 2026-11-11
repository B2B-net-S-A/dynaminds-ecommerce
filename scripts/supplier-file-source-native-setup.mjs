/** Creates only a fresh own QA135 firm and supplier. All file-source business writes belong to Chrome. */
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = resolve(process.env.QA_STATE_ROOT ?? '<workspace>/app');
assert.equal(root, '<workspace>/app');
const path = resolve(root, 'data/supplier-file-source-stage135.json');
const prior = JSON.parse(await readFile('docs/supplier-file-source-native-after.json', 'utf8'));
assert.equal(prior.status, 'PASS');
assert.equal(prior.tenants.length, 139);
const health = await (await fetch('http://127.0.0.1:4100/api/health')).json();
assert.equal(health.revision, '7a3d277516f46046128fe47f4832c582bc57af72');
assert.equal(health.schema_revision, '118_supplier_file_sources');
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const suffix = randomUUID().slice(0, 8);
const state = {
  phase: 'READY_TO_SIGNUP',
  runtime: health.revision,
  email: `qa-supplier-135-${suffix}@demo.local`,
  password: 'DynaSupplierDemo!2026',
  name: 'QA135 Supplier file',
  organization: `QA135 Supplier file ${suffix}`,
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
state.supplier = await post('/suppliers', { name: 'Dostawca QA135 CSV/XML', code: 'FEED135' });
const w = await fetch('http://127.0.0.1:4100/api/warehouses', {
  headers: { cookie: state.cookie },
});
assert.equal(w.status, 200);
state.warehouse_id = (await w.json()).data[0].id;
const csv =
  'ID;SKU;Nazwa;Koszt;Stan;Opis\nremote/A;SRC-A;Produkt dostawcy A;100.01;7;Opis CSV 雪\nremote/B;SRC-B;Produkt dostawcy B;0.00;0;Opis CSV B\n';
const xml =
  '<s:feed xmlns:s="urn:qa135"><s:item code="remote/A"><s:sku>SRC-A</s:sku><s:name>Produkt dostawcy A XML</s:name><s:cost>50.00</s:cost><s:qty>6</s:qty><s:description><![CDATA[Opis <b>XML</b> 雪]]></s:description></s:item><s:item code="remote/B"><s:sku>SRC-B</s:sku><s:name>Produkt dostawcy B</s:name><s:cost>0.00</s:cost><s:qty>0</s:qty><s:description>Opis CSV B</s:description></s:item></s:feed>';
for (const [ext, content] of [
  ['csv', csv],
  ['xml', xml],
]) {
  const fixture = resolve('docs/supplier-file-source-native-fixture.' + ext);
  await writeFile(fixture, content, { flag: 'wx' });
  state['fixture_' + ext] = {
    path: fixture,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}
state.phase = 'READY_FOR_CHROME';
await save();
await writeFile(
  'docs/supplier-file-source-native-setup.json',
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
      fixtures: { csv: state.fixture_csv, xml: state.fixture_xml },
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log('OWN_SETUP_READY: ' + state.organization + '; source business writes:0');
