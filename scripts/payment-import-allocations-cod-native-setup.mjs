/** Own local QA142 fixture, API writes only. Never approves or executes an allocation.
 * Existing output or an unknown write outcome prohibits rerunning/resuming.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const privatePath = resolve(root, 'data/payment-import-allocations-cod-stage142.json');
const reportPath = resolve(root, 'docs/payment-import-allocations-cod-native-setup.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
assert.match(revision, /^[a-f0-9]{40}$/);
const schema = '126_payment_import_allocation_cod_balances';
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
  throw new Error('QA142 output exists; do not resume or overwrite');
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
  stage: 142,
  runtime_revision: revision,
  schema_revision: h.schema_revision,
  organization: 'QA142 Split payments DEMO ' + suffix,
  email: 'qa-cod-142-' + suffix + '@demo.local',
  password: 'DynaSplit!142-' + randomUUID(),
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
await writeFile(reportPath, encode({ stage: 142, status: 'PREPARING_OWN_FIXTURE' }), {
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
      name: 'QA142 split operator',
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
      sku: 'QA142-SPLIT-' + suffix,
      name: 'QA142 reconciliation DEMO',
      price: 5000,
      quantity: 20,
      location: 'A-01',
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
        customer_name: 'QA142 synthetic local buyer',
        email: 'qa142@example.test',
        warehouse_id: state.warehouse_id,
        payment_mode: 'cod',
        items: [{ product_id: state.product.id, quantity }],
        address: { country: 'PL', street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001' },
      },
      201,
    );
    assert.equal(order.total, quantity * 5000);
    await api('picking-' + quantity, '/orders/' + order.id + '/status', 'PATCH', {
      status: 'picking',
    });
    for (let unit = 0; unit < quantity; unit++)
      await api('scan-' + quantity + '-' + unit, '/orders/' + order.id + '/scan', 'POST', {
        code: state.product.sku,
        location: 'A-01',
        client_key: randomUUID(),
      });
    await api('packed-' + quantity, '/orders/' + order.id + '/status', 'PATCH', {
      status: 'packed',
    });
    await api('ship-' + quantity, '/orders/' + order.id + '/ship-demo', 'POST', {});
    const shipped = await api('shipped-read-' + quantity, '/orders/' + order.id);
    assert.equal(shipped.status, 'shipped');
    assert.equal(shipped.shipments.length, 1);
    assert.equal(shipped.shipments[0].carrier, 'Symulator lokalny');
    assert.equal(shipped.shipments[0].mode, 'demo');
    assert(shipped.shipments[0].dispatched_at);
    assert.equal(shipped.shipments[0].cod_expected, quantity * 5000);
    state.orders.push(shipped);
    await save();
  }
  state.namespace = await api('namespace', '/payment-imports/namespaces', 'POST', {
    client_key: randomUUID(),
    label: 'QA142 synthetic carrier report',
    source_kind: 'carrier_report',
  });
  state.sources = {};
  for (const mode of ['cod_collection', 'cod_remittance']) {
    const remit = mode === 'cod_remittance';
    const definition = {
      name: 'QA142 aggregate ' + mode,
      description: 'Synthetic DEMO only; no carrier verification',
      source_kind: 'carrier_report',
      source_namespace_id: state.namespace.id,
      transaction_id_scope: 'namespace',
      mode,
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
        tracking_number: { index: 4 },
        ...(remit ? { fee: { index: 5 } } : {}),
      },
      match: { kind: 'order_number', carrier: 'Symulator lokalny', extraction: 'whole_field' },
    };
    const profile = await api(mode + '-profile', '/payment-imports/profiles', 'POST', {
      client_key: randomUUID(),
      definition,
    });
    const csv =
      'transaction;date;amount;reference;tracking' +
      (remit ? ';fee' : '') +
      '\nQA142-' +
      mode +
      '-' +
      suffix +
      ';2026-10-06;' +
      (remit ? '340,00' : '350,00') +
      ';ZBIORCZA-QA142;AGGREGATE-QA142' +
      (remit ? ';10,00' : '') +
      '\n';
    const upload = await api(mode + '-upload', '/payment-imports/uploads', 'POST', {
      client_key: randomUUID(),
      profile_id: profile.id,
      profile_version: profile.version,
      filename: 'QA142-synthetic-' + mode + '.csv',
      content_base64: Buffer.from(csv).toString('base64'),
    });
    const preview = await api(mode + '-preview', '/payment-imports/previews', 'POST', {
      client_key: randomUUID(),
      file_id: upload.file_id,
      profile_id: profile.id,
      profile_version: profile.version,
    });
    const detail = await api(mode + '-detail', '/payment-imports/previews/' + preview.id);
    assert.equal(detail.data.length, 1);
    assert.equal(detail.data[0].source.normalized.amount_minor, remit ? '34000' : '35000');
    assert.equal(detail.data[0].source.normalized.fee_minor, remit ? '1000' : '0');
    state.sources[mode] = { profile, upload, preview, detail };
    await save();
  }
  state.born = {
    orders: await Promise.all(state.orders.map((o) => api('read-order', '/orders/' + o.id))),
    stock: (await api('read-product', '/products/' + state.product.id)).stock,
  };
  state.complete = true;
  await save();
  await atomic(reportPath, {
    stage: 142,
    status: 'OWN_FIXTURE_READY_FOR_CHROME',
    runtime_revision: revision,
    schema_revision: h.schema_revision,
    tenant_id: state.tenant_id,
    user_id: state.user_id,
    organization: state.organization,
    sources: Object.fromEntries(
      Object.entries(state.sources).map(([mode, s]) => [
        mode,
        {
          source_preview_id: s.preview.id,
          source_row_id: s.detail.data[0].row_id,
          amount_minor: s.detail.data[0].source.normalized.amount_minor,
          fee_minor: s.detail.data[0].source.normalized.fee_minor,
        },
      ]),
    ),
    currency: 'PLN',
    orders: state.orders.map((o) => ({ id: o.id, number: o.number, total: o.total })),
    mutations: state.completed,
    unresolved_write: false,
    private_setup_sha256: hash(await readFile(privatePath)),
    allocation_executed: false,
    carrier_verified: false,
    full_goal_complete: false,
  });
  console.log(
    JSON.stringify({
      stage: 142,
      status: 'OWN_FIXTURE_READY_FOR_CHROME',
      orders: 3,
      mutations: state.completed.length,
    }),
  );
} catch (e) {
  await save();
  console.error('QA142 setup stopped; inspect own journal before any next action. ' + e.message);
  process.exitCode = 1;
}
