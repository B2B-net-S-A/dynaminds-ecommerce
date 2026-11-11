/** Root-only one-shot QA150 native fixture, no carrier verification.
 * Creates a NEW own firm, two packed orders and three owner-seeded synthetic
 * sandbox shipments (two in first order). Three existing-label acquisitions
 * use explicit injected transport returning distinct 1/2/1-page A6 PDFs.
 * The ordinary server never gets an override. Never acquire these synthetic
 * sources through its carrier endpoint. No queue, dispatch or bridge here.
 * Run after source adoption/native schema132, from primary, workers OFF:
 * QA_EXPECTED_REVISION=<40hex> QA150_SETUP_CONFIRM=CREATE_NEW_CONTROLLED_FIXTURE
 * DYNA_WORKER_DISABLED=true DYNA_LOCAL_CONFIG_PATH=<primary>/.local.json
 * tsx scripts/shipment-label-batch-native-setup.mjs
 * Every mutation is journalled; existing or interrupted outputs forbid rerun.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const statePath = resolve(root, 'data/shipment-label-batch-stage150.json');
const reportPath = resolve(root, 'docs/shipment-label-batch-native-setup150.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = '133_order_shipments';
assert.match(revision, /^[a-f0-9]{40}$/);
assert.equal(process.env.QA150_SETUP_CONFIRM, 'CREATE_NEW_CONTROLLED_FIXTURE');
assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
assert.notEqual(process.env.DYNA_TEST, 'true');
assert.equal(resolve(process.cwd()), root);
assert.equal(resolve(dirname(fileURLToPath(import.meta.url)), '..'), root);
const config = resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? resolve(root, '.local.json'));
assert.equal(config, resolve(root, '.local.json'));
assert.equal((await lstat(config)).isFile(), true);
assert.equal((await lstat(config)).mode & 0o777, 0o600);
for (const path of [statePath, reportPath]) {
  try {
    await lstat(path);
  } catch (e) {
    if (e.code === 'ENOENT') continue;
    throw e;
  }
  throw Error('QA150 output exists; never resume or overwrite');
}
const encode = (v) => JSON.stringify(v, null, 2) + '\n';
const hash = (v) => createHash('sha256').update(v).digest('hex');
async function atomic(path, value) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.writeFile(encode(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    const dir = await open(dirname(path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
async function jsonResponse(r) {
  const text = await r.text();
  assert(Buffer.byteLength(text) <= 5 * 1024 * 1024, 'Response bound');
  try {
    return JSON.parse(text);
  } catch {
    throw Error('Unexpected JSON; response withheld');
  }
}
async function health() {
  const r = await fetch(base + '/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(r.status, 200);
  const h = await jsonResponse(r);
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema);
  assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.print_jobs_available, true);
  assert.equal(h.shipment_label_print_available, true);
  assert.equal(h.shipment_label_cache_available, true);
  assert.equal(h.shipment_label_batches_available, true);
  return h;
}
await health();
// The module import is after preflight. It neither migrates nor starts workers.
const { pool } = await import('../server/db.ts');
const database = new URL(pool.options.connectionString);
assert(['127.0.0.1', 'localhost'].includes(database.hostname));
assert.equal(database.port, '55432');
assert.equal(database.pathname, '/dynaminds');
const dbIdentity = (await pool.query('SELECT current_database() AS name,current_user AS role'))
  .rows[0];
assert.equal(dbIdentity.name, 'dynaminds');
assert.equal(dbIdentity.role, 'postgres');
const suffix = randomUUID().slice(0, 8);
const state = {
  stage: 150,
  runtime_revision: revision,
  schema_revision: schema,
  organization: 'QA150 Controlled label source ' + suffix,
  email: 'qa-label-cache-150-' + suffix + '@demo.local',
  password: 'DynaControlled!150-' + randomUUID(),
  cookie: '',
  tenant_id: '',
  user_id: '',
  complete: false,
  pending: null,
  completed: [],
  orders: [],
  shipments: [],
  controlled_transport_callbacks: [],
  fixture_seeded_source: true,
  provider_verified: false,
  physical_print_verified: false,
};
await writeFile(statePath, encode(state), { flag: 'wx', mode: 0o600 });
await writeFile(reportPath, encode({ stage: 150, status: 'PREPARING_OWN_CONTROLLED_FIXTURE' }), {
  flag: 'wx',
  mode: 0o600,
});
const save = () => atomic(statePath, state);
async function api(step, path, method = 'GET', body, expected = 200) {
  assert.equal(state.pending, null);
  assert(path.startsWith('/') && !path.startsWith('//'));
  if (method !== 'GET') {
    await health();
    state.pending = { step, path, method, request: body, started_at: new Date().toISOString() };
    await save();
  }
  const r = await fetch(base + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      cookie: state.cookie,
      ...(state.tenant_id ? { 'X-Workspace-ID': state.tenant_id } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const cookie = r.headers.get('set-cookie');
  if (cookie) {
    state.cookie = cookie.split(';')[0];
    if (method !== 'GET') await save();
  }
  if (r.status !== expected) {
    if (method !== 'GET') {
      state.pending.response_status = r.status;
      await save();
    }
    throw Error('Unexpected API status; inspect private journal, do not retry');
  }
  const data = await jsonResponse(r);
  if (method !== 'GET') {
    state.completed.push({
      step,
      path,
      method,
      status: r.status,
      id: data.id ?? data.station?.id ?? data.printer?.id ?? data.user?.id ?? null,
    });
    state.pending = null;
    await save();
  }
  return data;
}
async function seedOwnSources() {
  assert.equal(state.pending, null);
  await health();
  const shipments = [state.orders[0], state.orders[0], state.orders[1]].map((o, i) => ({
    id: randomUUID(),
    order_id: o.id,
    external_id: String(150000001 + i),
    tracking_number: '00000000000000000150000' + String(i + 1),
  }));
  state.pending = {
    step: 'seed-own-synthetic-sources',
    kind: 'OWNER_SQL_FIXTURE',
    shipments,
    started_at: new Date().toISOString(),
  };
  await save();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='8s'");
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [state.tenant_id]);
    const membership = (
      await c.query(
        'SELECT t.name,m.role FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE t.id=$1 AND m.user_id=$2 FOR SHARE OF t,m',
        [state.tenant_id, state.user_id],
      )
    ).rows;
    assert.equal(membership.length, 1);
    assert.equal(membership[0].name, state.organization);
    assert.equal(membership[0].role, 'admin');
    const channel = (
      await c.query(
        'SELECT provider,mode,settings,status FROM channels WHERE tenant_id=$1 AND id=$2 FOR SHARE',
        [state.tenant_id, state.channel_id],
      )
    ).rows[0];
    assert.equal(channel?.provider, 'inpost');
    assert.equal(channel.mode, 'sandbox');
    assert.notEqual(channel.settings.simulation, true);
    assert.equal(channel.status, 'not_verified');
    assert.equal(
      Number(
        (await c.query('SELECT count(*) n FROM orders WHERE tenant_id=$1', [state.tenant_id]))
          .rows[0].n,
      ),
      2,
    );
    assert.equal(
      Number(
        (await c.query('SELECT count(*) n FROM shipments WHERE tenant_id=$1', [state.tenant_id]))
          .rows[0].n,
      ),
      0,
    );
    for (const s of shipments) {
      const o = (
        await c.query('SELECT id,status FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
          state.tenant_id,
          s.order_id,
        ])
      ).rows[0];
      assert.equal(o?.status, 'packed');
      await c.query(
        "INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,status,channel_id,external_id) VALUES($1,$2,$3,'InPost ShipX',$4,'sandbox','created',$5,$6)",
        [s.id, state.tenant_id, s.order_id, s.tracking_number, state.channel_id, s.external_id],
      );
    }
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  state.shipments = shipments.map((v, index) => ({
    ...v,
    shipment_id: v.id,
    index,
    order_version: state.orders.find((o) => o.id === v.order_id).version,
  }));
  state.completed.push({
    step: 'seed-own-synthetic-sources',
    kind: 'OWNER_SQL_FIXTURE',
    sources: 3,
    status: 'COMMITTED',
  });
  state.pending = null;
  await save();
}
async function ownCheckpoint() {
  const c = await pool.connect();
  const result = {};
  const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const tables = (
      await c.query(
        "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name IN(SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') ORDER BY table_name",
      )
    ).rows.map((r) => r.table_name);
    for (const name of [...tables.filter((n) => n !== 'sessions'), 'users', 'tenants']) {
      const predicate = name === 'users' ? 'id=$1' : name === 'tenants' ? 'id=$1' : 'tenant_id=$1';
      const id = name === 'users' ? state.user_id : state.tenant_id;
      const r = (
        await c.query(
          `SELECT count(*)::integer AS count,coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb) AS rows FROM (SELECT to_jsonb(t) row FROM ${quote(name)} t WHERE ${predicate}) s`,
          [id],
        )
      ).rows[0];
      result[name] = { count: r.count, sha256: hash(JSON.stringify(r.rows)) };
    }
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
try {
  const signup = await api(
    'signup',
    '/auth/signup',
    'POST',
    {
      email: state.email,
      password: state.password,
      name: 'QA150 Controlled local operator',
      organization: { name: state.organization },
    },
    201,
  );
  state.tenant_id = signup.user.tenant_id;
  state.user_id = signup.user.id;
  await save();
  const warehouses = await api('warehouses', '/warehouses');
  assert.equal(warehouses.data.length, 1);
  state.warehouse_id = warehouses.data[0].id;
  state.product = await api(
    'product',
    '/products',
    'POST',
    {
      sku: 'QA150-CACHE-' + suffix,
      name: 'QA150 synthetic parcel content',
      price: 10000,
      vat: 23,
      quantity: 6,
      location: 'A-01',
      warehouse_id: state.warehouse_id,
    },
    201,
  );
  const ch = await api('channel', '/integrations', 'POST', {
    provider: 'inpost',
    name: 'QA150 controlled transport ONLY ' + suffix,
    mode: 'sandbox',
    credentials: { access_token: 'QA150-SYNTHETIC-NOT-A-CARRIER-CREDENTIAL-' + suffix },
    settings: { organization_id: '150' },
  });
  assert.equal(ch.status, 'not_verified');
  state.channel_id = ch.id;
  await save();
  for (let i = 0; i < 2; i++) {
    const o = await api(
      'order-' + i,
      '/orders',
      'POST',
      {
        customer_name: 'QA150 CONTROLLED SOURCE ' + (i + 1),
        email: 'qa150@example.test',
        warehouse_id: state.warehouse_id,
        payment_mode: 'cod',
        shipping_cost: 0,
        items: [{ product_id: state.product.id, quantity: 1 }],
        address: { country: 'PL', street: 'Testowa 150', city: 'Warszawa', postal_code: '00-150' },
      },
      201,
    );
    await api('picking-' + i, '/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
    await api('scan-' + i, '/orders/' + o.id + '/scan', 'POST', {
      code: state.product.sku,
      location: 'A-01',
      client_key: randomUUID(),
    });
    const packed = await api('packed-' + i, '/orders/' + o.id + '/status', 'PATCH', {
      status: 'packed',
    });
    assert.equal(packed.status, 'packed');
    assert.equal(packed.total, 10000);
    assert.equal(packed.payment.received, 0);
    assert.equal(packed.documents.length, 0);
    assert.equal(packed.shipments.length, 0);
    state.orders.push({
      id: packed.id,
      number: packed.number,
      version: String(packed.version),
      purpose: i === 0 ? 'two_cached_shipments' : 'third_cached_shipment',
    });
    await save();
  }
  state.station = (
    await api(
      'station',
      '/packing/stations',
      'POST',
      {
        client_key: randomUUID(),
        code: 'QA150-' + suffix,
        label: 'QA150 Controlled file output',
        enabled: true,
      },
      201,
    )
  ).station;
  state.printer = (
    await api(
      'printer',
      '/print-jobs/printers',
      'POST',
      {
        client_key: randomUUID(),
        station_id: state.station.id,
        station_version: state.station.version,
        name: 'QA150 PDF local file ONLY',
        format: 'pdf',
        output_mode: 'file',
        cups_queue: null,
        enabled: true,
      },
      201,
    )
  ).printer;
  await seedOwnSources();
  state.controlled_pdfs = [];
  for (const s of state.shipments) {
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date('2020-01-01T00:00:00Z'));
    pdf.setModificationDate(new Date('2020-01-01T00:00:00Z'));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pages = [1, 2, 1][s.index];
    for (let j = 0; j < pages; j++) {
      const page = pdf.addPage([297.64, 419.53]);
      page.drawText('TEST TRANSPORTU - NIE DO NADANIA', {
        x: 14,
        y: 380,
        size: 12,
        font,
        color: rgb(0.6, 0, 0),
      });
      page.drawText('QA150 SOURCE ' + (s.index + 1) + ' PAGE ' + (j + 1) + '/' + pages, {
        x: 14,
        y: 340,
        size: 13,
        font,
      });
      page.drawText('Synthetic shipment - local file output only', {
        x: 14,
        y: 300,
        size: 10,
        font,
      });
    }
    const bytes = await pdf.save({ useObjectStreams: false });
    assert(bytes.length > 100 && bytes.length <= 2097152);
    state.controlled_pdfs.push({
      shipment_id: s.id,
      content_base64: Buffer.from(bytes).toString('base64'),
      content_sha256: hash(bytes),
      content_bytes: bytes.length,
      format: 'pdf',
      layout: 'A6',
      pages,
      warning: 'TEST TRANSPORTU - NIE DO NADANIA',
    });
  }
  await save();
  const orderDetails = [],
    metadata = [];
  for (const o of state.orders) {
    const d = await api('order-born', '/orders/' + o.id);
    assert.equal(d.status, 'packed');
    assert.equal(d.payment.received, 0);
    assert.equal(d.shipments.length, o.id === state.orders[0].id ? 2 : 1);
    assert(d.shipments.every((v) => v.mode === 'sandbox' && v.dispatched_at === null));
    orderDetails.push(d);
  }
  const { acquireShipmentLabelCache } = await import('../server/shipment-label-cache.ts');
  for (const s of state.shipments) {
    const m = await api('cache-born', '/print-jobs/shipments/' + s.id + '/label-cache');
    assert.equal(m.available, true);
    assert.equal(m.can_acquire, true);
    assert.equal(m.cache, null);
    assert.match(m.source_hash, /^[a-f0-9]{64}$/);
    const source = state.controlled_pdfs[s.index];
    const body = {
      client_key: randomUUID(),
      order_version: m.order_version,
      source_hash: m.source_hash,
      confirmed_existing_label: true,
    };
    await health();
    assert.equal(state.pending, null);
    state.pending = {
      step: 'controlled-cache-' + s.index,
      kind: 'INJECTED_TRANSPORT_ONLY',
      request: body,
      shipment_id: s.id,
      started_at: new Date().toISOString(),
    };
    await save();
    let callbacks = 0;
    const ready = await acquireShipmentLabelCache(
      { tenantId: state.tenant_id, userId: state.user_id, role: 'admin', source: 'manual' },
      s.id,
      body,
      {
        transport: async (url, init) => {
          assert.equal(++callbacks, 1);
          assert.equal(
            url,
            'https://sandbox-api-shipx-pl.easypack24.net/v1/shipments/' +
              s.external_id +
              '/label?format=pdf&type=A6',
          );
          assert.equal(init.method, 'GET');
          assert.equal(init.body, undefined);
          const rows = (
            await pool.query(
              'SELECT id,state,asset_id,source_hash FROM shipment_label_cache_acquisitions WHERE tenant_id=$1 AND shipment_id=$2 AND client_key=$3',
              [state.tenant_id, s.id, body.client_key],
            )
          ).rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].state, 'fetching');
          assert.equal(rows[0].asset_id, null);
          assert.equal(rows[0].source_hash, body.source_hash);
          assert.equal(
            Number(
              (
                await pool.query('SELECT count(*) n FROM print_jobs WHERE tenant_id=$1', [
                  state.tenant_id,
                ])
              ).rows[0].n,
            ),
            0,
          );
          state.controlled_transport_callbacks.push({
            shipment_id: s.id,
            acquisition_id: rows[0].id,
            committed_before_get: true,
            method: 'GET',
            source_sha256: source.content_sha256,
          });
          await save();
          return new Response(Buffer.from(source.content_base64, 'base64'), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        },
      },
    );
    assert.equal(callbacks, 1);
    assert.equal(ready.acquisition.state, 'ready');
    assert.equal(ready.reused, false);
    assert.equal(ready.cache.content_sha256, source.content_sha256);
    assert.equal(ready.cache.content_bytes, source.content_bytes);
    s.asset_id = ready.cache.id;
    s.acquisition_id = ready.acquisition.id;
    state.completed.push({
      step: 'controlled-cache-' + s.index,
      kind: 'INJECTED_TRANSPORT_ONLY',
      acquisition_id: ready.acquisition.id,
      asset_id: ready.cache.id,
      status: 'COMMITTED',
    });
    state.pending = null;
    await save();
    const current = await api('cache-ready', '/print-jobs/shipments/' + s.id + '/label-cache');
    assert.equal(current.can_queue, true);
    assert.equal(current.cache.id, s.asset_id);
    metadata.push(current);
  }
  const product = await api('stock-born', '/products/' + state.product.id);
  const stock = product.stock.find((s) => s.warehouse_id === state.warehouse_id);
  assert(stock);
  assert.equal(stock.on_hand, 6);
  assert.equal(stock.reserved, 2);
  assert.equal(stock.available, 4);
  state.born = { order_details: orderDetails, stock: product.stock, cache_metadata: metadata };
  state.setup_checkpoint = await ownCheckpoint();
  assert.equal(state.completed.filter((r) => r.method && r.method !== 'GET').length, 13);
  for (const table of [
    'print_jobs',
    'print_label_previews',
    'print_job_label_sources',
    'shipment_label_batch_previews',
    'shipment_label_batch_executions',
  ])
    assert.equal(state.setup_checkpoint[table]?.count, 0);
  assert.equal(state.setup_checkpoint.shipment_label_cache_assets.count, 3);
  assert.equal(state.setup_checkpoint.shipment_label_cache_acquisitions.count, 3);
  assert.equal(state.controlled_transport_callbacks.length, 3);
  state.complete = true;
  await save();
  await health();
  await atomic(reportPath, {
    stage: 150,
    status: 'OWN_CONTROLLED_FIXTURE_READY',
    runtime_revision: revision,
    schema_revision: schema,
    tenant_id: state.tenant_id,
    orders: state.orders,
    shipments: state.shipments,
    station_id: state.station.id,
    printer_id: state.printer.id,
    fixture_seeded_source: true,
    source_origin: 'owner_seeded_synthetic_sandbox_shipment',
    provider_verified: false,
    physical_dispatch_verified: false,
    physical_print_verified: false,
    controlled_transport_executed: true,
    controlled_transport_callbacks: state.controlled_transport_callbacks,
    cache_acquisitions: 3,
    print_jobs: 0,
    order_status: 'packed',
    stock: { on_hand: 6, reserved: 2, available: 4 },
    pdfs: state.controlled_pdfs.map(({ content_base64, ...v }) => v),
    api_mutations: state.completed.filter((r) => r.method && r.method !== 'GET').length,
    owner_fixture_transactions: 1,
    own_tables: Object.keys(state.setup_checkpoint).length,
    private_setup_sha256: hash(await readFile(statePath)),
    next: 'Native Chrome: select2 orders/pick3 cached shipments, review all4 pages, separately confirm queue. Never acquire synthetic sources through carrier endpoint.',
    full_goal_complete: false,
  });
  console.log(
    JSON.stringify({
      status: 'OWN_CONTROLLED_FIXTURE_READY',
      orders: 2,
      cache_acquisitions: 3,
      print_jobs: 0,
      provider_verified: false,
    }),
  );
} catch {
  throw Error(
    'QA150 setup interrupted. Private pending journal is preserved; never rerun/resume or print its credentials.',
  );
} finally {
  await pool.end();
}
