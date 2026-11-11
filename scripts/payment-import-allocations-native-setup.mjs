/** Own local QA141 fixture, API writes only. Never approves or executes an allocation.
 * Existing output or an unknown write outcome prohibits rerunning/resuming.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const privatePath = resolve(root, 'data/payment-import-allocations-stage141.json');
const reportPath = resolve(root, 'docs/payment-import-allocations-native-setup.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
assert.match(revision, /^[a-f0-9]{40}$/);
const schema = process.env.QA_EXPECTED_SCHEMA ?? '125_payment_import_allocation_source_projection';
assert(
  ['124_payment_import_allocations', '125_payment_import_allocation_source_projection'].includes(
    schema,
  ),
);
assert.notEqual(process.env.DYNA_TEST, 'true');
const encode = (v) => JSON.stringify(v, null, 2) + '\n';
const hash = (v) => createHash('sha256').update(v).digest('hex');
for (const path of [privatePath, reportPath]) {
  try {
    await lstat(path);
  } catch (e) {
    if (e.code === 'ENOENT') continue;
    throw e;
  }
  throw new Error('QA141 output exists; do not resume or overwrite');
}
async function atomic(path, data) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.writeFile(encode(data));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
async function response(r) {
  const text = await r.text();
  assert(Buffer.byteLength(text) < 5 * 1024 * 1024);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Unexpected JSON; response withheld');
  }
}
const h = await response(
  await fetch(base + '/health', { redirect: 'error', signal: AbortSignal.timeout(10000) }),
);
assert.equal(h.status, 'ok');
assert.equal(h.mode, 'local');
assert.equal(h.revision, revision);
assert.equal(h.schema_revision, schema);
assert.equal(h.payment_import_allocations_available, true);
assert.equal(h.background_workers_enabled, false);
assert.equal(h.restore_preview, false);
const suffix = randomUUID().slice(0, 8);
const state = {
  stage: 141,
  runtime_revision: revision,
  schema_revision: h.schema_revision,
  organization: 'QA141 Split payments DEMO ' + suffix,
  email: 'qa-split-141-' + suffix + '@demo.local',
  password: 'DynaSplit!141-' + randomUUID(),
  cookie: '',
  tenant_id: '',
  user_id: '',
  complete: false,
  pending: null,
  completed: [],
  orders: [],
  born: null,
};
await writeFile(privatePath, encode(state), { flag: 'wx', mode: 0o600 });
await writeFile(reportPath, encode({ stage: 141, status: 'PREPARING_OWN_FIXTURE' }), {
  flag: 'wx',
  mode: 0o600,
});
const save = () => atomic(privatePath, state);
async function api(step, path, method = 'GET', body, expected = 200) {
  assert.equal(state.pending, null);
  if (method !== 'GET') {
    state.pending = { step, path, method, request: body, started_at: new Date().toISOString() };
    await save();
  }
  const r = await fetch(base + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      cookie: state.cookie,
      ...(state.tenant_id ? { 'X-Workspace-ID': state.tenant_id } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (r.status !== expected)
    throw new Error(step + ' unexpected status ' + r.status + '; do not retry');
  const data = await response(r);
  if (r.headers.get('set-cookie')) state.cookie = r.headers.get('set-cookie').split(';')[0];
  if (method !== 'GET') {
    state.completed.push({ step, path, method, status: r.status, id: data.id ?? null });
    state.pending = null;
    await save();
  }
  return data;
}
try {
  const signup = await api(
    'signup',
    '/auth/signup',
    'POST',
    {
      email: state.email,
      password: state.password,
      name: 'QA141 split operator',
      organization: { name: state.organization },
    },
    201,
  );
  state.tenant_id = signup.user.tenant_id;
  state.user_id = signup.user.id;
  await save();
  state.warehouse_id = (await api('warehouses', '/warehouses')).data[0].id;
  state.product = await api(
    'product',
    '/products',
    'POST',
    {
      sku: 'QA141-SPLIT-' + suffix,
      name: 'QA141 reconciliation DEMO',
      price: 5000,
      quantity: 20,
      warehouse_id: state.warehouse_id,
    },
    201,
  );
  for (const quantity of [2, 4, 1]) {
    const order = await api(
      'order-' + quantity,
      '/orders',
      'POST',
      {
        customer_name: 'QA141 synthetic local buyer',
        email: 'qa141@example.test',
        warehouse_id: state.warehouse_id,
        payment_mode: 'prepaid',
        items: [{ product_id: state.product.id, quantity }],
        address: { country: 'PL', street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001' },
      },
      201,
    );
    assert.equal(order.total, quantity * 5000);
    state.orders.push(order);
    await save();
  }
  state.namespace = await api('namespace', '/payment-imports/namespaces', 'POST', {
    client_key: randomUUID(),
    label: 'QA141 synthetic bank account',
    source_kind: 'bank_statement',
  });
  state.profile = await api('profile', '/payment-imports/profiles', 'POST', {
    client_key: randomUUID(),
    definition: {
      name: 'QA141 aggregate bank receipt',
      description: 'Synthetic file; not bank verification',
      source_kind: 'bank_statement',
      source_namespace_id: state.namespace.id,
      transaction_id_scope: 'namespace',
      mode: 'bank_receipt',
      encoding: 'utf-8',
      delimiter: ';',
      header: true,
      skip_records: 0,
      decimal_separator: ',',
      grouping_separator: 'none',
      sign: 'credit_positive',
      date_format: 'YYYY-MM-DD',
      fixed_currency: 'PLN',
      columns: {
        transaction_id: { index: 0 },
        booking_date: { index: 1 },
        amount: { index: 2 },
        reference: [{ index: 3 }],
        order_reference: { index: 3 },
      },
      match: { kind: 'order_number', extraction: 'whole_field' },
    },
  });
  const csv =
    'transaction;date;amount;reference\nQA141-AGGREGATE-' +
    suffix +
    ';2026-10-06;350,00;ZBIORCZA-WPLATA-QA141\n';
  state.upload = await api('upload', '/payment-imports/uploads', 'POST', {
    client_key: randomUUID(),
    profile_id: state.profile.id,
    profile_version: state.profile.version,
    filename: 'QA141-synthetic-aggregate.csv',
    content_base64: Buffer.from(csv).toString('base64'),
  });
  state.legacy_preview = await api('legacy-preview', '/payment-imports/previews', 'POST', {
    client_key: randomUUID(),
    file_id: state.upload.file_id,
    profile_id: state.profile.id,
    profile_version: state.profile.version,
  });
  state.legacy_detail = await api(
    'legacy-detail',
    '/payment-imports/previews/' + state.legacy_preview.id,
  );
  assert.equal(state.legacy_detail.data.length, 1);
  assert.equal(state.legacy_detail.data[0].source.normalized.amount_minor, '35000');
  state.born = {
    orders: await Promise.all(state.orders.map((o) => api('read-order', '/orders/' + o.id))),
    stock: (await api('read-product', '/products/' + state.product.id)).stock,
  };
  state.complete = true;
  await save();
  await atomic(reportPath, {
    stage: 141,
    status: 'OWN_FIXTURE_READY_FOR_CHROME',
    runtime_revision: revision,
    schema_revision: h.schema_revision,
    tenant_id: state.tenant_id,
    user_id: state.user_id,
    organization: state.organization,
    source_preview_id: state.legacy_preview.id,
    source_row_id: state.legacy_detail.data[0].row_id,
    source_amount_minor: '35000',
    source_fee_minor: '0',
    currency: 'PLN',
    orders: state.orders.map((o) => ({ id: o.id, number: o.number, total: o.total })),
    mutations: state.completed,
    unresolved_write: false,
    private_setup_sha256: hash(await readFile(privatePath)),
    allocation_executed: false,
    bank_verified: false,
    full_goal_complete: false,
  });
  console.log(
    JSON.stringify({
      stage: 141,
      status: 'OWN_FIXTURE_READY_FOR_CHROME',
      orders: 3,
      mutations: state.completed.length,
    }),
  );
} catch (e) {
  await save();
  console.error('QA141 setup stopped; inspect own journal before any next action. ' + e.message);
  process.exitCode = 1;
}
