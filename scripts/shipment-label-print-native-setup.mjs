/** Own local QA146 fixture, API writes only. DEMO fulfillment and file printer; no carrier or print job.
 * Existing output or an unknown write outcome prohibits rerunning/resuming.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const privatePath = resolve(root, 'data/print-jobs-stage146.json');
const reportPath = resolve(root, 'docs/shipment-label-print-native-setup.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
assert.match(revision, /^[a-f0-9]{40}$/);
const schema = '130_shipment_label_prints';
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
  throw new Error('QA146 output exists; do not resume or overwrite');
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
assert.equal(h.print_jobs_available, true);
assert.equal(h.background_workers_enabled, false);
assert.equal(h.restore_preview, false);
const suffix = randomUUID().slice(0, 8);
const state = {
  stage: 146,
  runtime_revision: revision,
  schema_revision: h.schema_revision,
  organization: 'QA146 Printing DEMO ' + suffix,
  email: 'qa-print-146-' + suffix + '@demo.local',
  password: 'DynaSplit!146-' + randomUUID(),
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
await writeFile(reportPath, encode({ stage: 146, status: 'PREPARING_OWN_FIXTURE' }), {
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
      name: 'QA146 print operator',
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
      sku: 'QA146-PRINT-' + suffix,
      name: 'QA146 historical gross product',
      price: 12345,
      vat: 23,
      quantity: 50,
      location: 'A-01',
      warehouse_id: state.warehouse_id,
    },
    201,
  );
  for (const quantity of [1]) {
    const o = await api(
      'order-' + quantity,
      '/orders',
      'POST',
      {
        customer_name: 'Łukasz Żółć — QA146 DEMO',
        email: 'qa146@example.test',
        warehouse_id: state.warehouse_id,
        payment_mode: 'cod',
        shipping_cost: 999,
        items: [{ product_id: state.product.id, quantity }],
        address: {
          country: 'PL',
          street: 'Świętojańska 146',
          city: 'Warszawa',
          postal_code: '00-146',
        },
      },
      201,
    );
    const order = await api('order-read-' + quantity, '/orders/' + o.id);
    assert.equal(order.total, quantity * 12345 + 999);
    assert.equal(order.status, 'new');
    assert.equal(order.payment.received, 0);
    assert.equal(order.documents.length, 0);
    state.orders.push(order);
    await save();
  }
  state.station = (
    await api(
      'station',
      '/packing/stations',
      'POST',
      {
        client_key: randomUUID(),
        code: 'QA146-' + suffix,
        label: 'QA146 Stanowisko DEMO',
        enabled: true,
      },
      201,
    )
  ).station;
  assert(state.station?.id && state.station.enabled);
  const orderId = state.orders[0].id;
  await api('start-picking', '/orders/' + orderId + '/status', 'PATCH', { status: 'picking' });
  await api('scan', '/orders/' + orderId + '/scan', 'POST', {
    code: state.product.sku,
    location: 'A-01',
    client_key: randomUUID(),
  });
  await api('pack', '/orders/' + orderId + '/status', 'PATCH', { status: 'packed' });
  const shipped = await api('ship-demo', '/orders/' + orderId + '/ship-demo', 'POST', {});
  assert.equal(shipped.shipments.length, 1);
  assert.equal(shipped.shipments[0].mode, 'demo');
  assert.equal(shipped.payment.received, 0);
  state.orders = [shipped];
  state.shipment_id = shipped.shipments[0].id;
  state.printer = (
    await api(
      'file-printer',
      '/print-jobs/printers',
      'POST',
      {
        client_key: randomUUID(),
        station_id: state.station.id,
        station_version: state.station.version,
        name: 'QA146 PDF — plik lokalny',
        format: 'pdf',
        output_mode: 'file',
        cups_queue: null,
        enabled: true,
      },
      201,
    )
  ).printer;
  state.born = {
    stock: (await api('stock', '/products/' + state.product.id)).stock,
    orders: state.orders,
  };
  state.complete = true;
  await save();
  const report = {
    stage: 146,
    status: 'OWN_FIXTURE_READY',
    shipment_id: state.shipment_id,
    printer_id: state.printer.id,
    runtime_revision: revision,
    schema_revision: schema,
    tenant_id: state.tenant_id,
    orders: state.orders.map((o) => ({
      id: o.id,
      number: o.number,
      total: o.total,
      status: o.status,
    })),
    stock: state.born.stock,
    station: state.station,
    private_setup_sha256: hash(await readFile(privatePath)),
  };
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), {
    stage: 146,
    status: 'PREPARING_OWN_FIXTURE',
  });
  await atomic(reportPath, report);
  console.log(
    JSON.stringify({
      status: report.status,
      orders: state.orders.length,
      no_print_job_queued: true,
    }),
  );
} catch (e) {
  throw new Error(
    'QA146 setup interrupted; inspect private pending journal, never rerun automatically',
    { cause: e },
  );
}
