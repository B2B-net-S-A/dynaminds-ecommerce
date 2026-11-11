/**
 * Root-only one-shot QA147 fixture, never a testfactory or carrier verification.
 * Run from the adopted primary app with its native server on schema131:
 * QA_EXPECTED_REVISION=<40hex> DYNA_WORKER_DISABLED=true
 * QA147_SETUP_CONFIRM=CREATE_NEW_CONTROLLED_FIXTURE tsx scripts/shipment-label-cache-native-setup.mjs
 * HTTP creates a NEW own firm and two genuinely picked/packed orders. A single
 * explicit own-firm owner TX seeds two synthetic sandbox shipment sources only.
 * No dispatch, provider request, cache acquisition, label preview, print job,
 * claim or ACK is executed here. Root's separate controlled service harness must
 * populate the cache BEFORE the ordinary native UI may use these sources.
 * The ordinary server NEVER receives a transport override. Never click its
 * uncached provider acquisition for this synthetic channel.
 * Existing files or ANY interrupted write prohibit rerun/resume.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const statePath = resolve(root, 'data/shipment-label-cache-stage147.json');
const reportPath = resolve(root, 'docs/shipment-label-cache-native-setup.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = '131_shipment_label_cache';
assert.match(revision, /^[a-f0-9]{40}$/);
assert.equal(process.env.QA147_SETUP_CONFIRM, 'CREATE_NEW_CONTROLLED_FIXTURE');
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
  throw Error('QA147 output exists; never resume or overwrite');
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
  stage: 147,
  runtime_revision: revision,
  schema_revision: schema,
  organization: 'QA147 Controlled label source ' + suffix,
  email: 'qa-label-cache-147-' + suffix + '@demo.local',
  password: 'DynaControlled!147-' + randomUUID(),
  cookie: '',
  tenant_id: '',
  user_id: '',
  complete: false,
  pending: null,
  completed: [],
  orders: [],
  fixture_seeded_source: true,
  provider_verified: false,
  physical_print_verified: false,
};
await writeFile(statePath, encode(state), { flag: 'wx', mode: 0o600 });
await writeFile(reportPath, encode({ stage: 147, status: 'PREPARING_OWN_CONTROLLED_FIXTURE' }), {
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
  const shipments = state.orders.map((o, i) => ({
    id: randomUUID(),
    order_id: o.id,
    external_id: String(147000001 + i),
    tracking_number: '00000000000000000147000' + String(i + 1),
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
  state.orders = state.orders.map((o, i) => ({
    ...o,
    ...shipments[i],
    id: o.id,
    shipment_id: shipments[i].id,
  }));
  state.completed.push({
    step: 'seed-own-synthetic-sources',
    kind: 'OWNER_SQL_FIXTURE',
    sources: 2,
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
      name: 'QA147 Controlled local operator',
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
      sku: 'QA147-CACHE-' + suffix,
      name: 'QA147 synthetic parcel content',
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
    name: 'QA147 controlled transport ONLY ' + suffix,
    mode: 'sandbox',
    credentials: { access_token: 'QA147-SYNTHETIC-NOT-A-CARRIER-CREDENTIAL-' + suffix },
    settings: { organization_id: '147' },
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
        customer_name: 'QA147 CONTROLLED SOURCE ' + (i + 1),
        email: 'qa147@example.test',
        warehouse_id: state.warehouse_id,
        payment_mode: 'cod',
        shipping_cost: 0,
        items: [{ product_id: state.product.id, quantity: 1 }],
        address: { country: 'PL', street: 'Testowa 147', city: 'Warszawa', postal_code: '00-147' },
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
      purpose: i === 0 ? 'ready_cachehit_chrome_queue' : 'unknown_abandon_new_acquire',
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
        code: 'QA147-' + suffix,
        label: 'QA147 Controlled file output',
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
        name: 'QA147 PDF local file ONLY',
        format: 'pdf',
        output_mode: 'file',
        cups_queue: null,
        enabled: true,
      },
      201,
    )
  ).printer;
  await seedOwnSources();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([297.64, 419.53]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('TEST TRANSPORTU - NIE DO NADANIA', {
    x: 14,
    y: 380,
    size: 12,
    font,
    color: rgb(0.6, 0, 0),
  });
  page.drawText('QA147 controlled InPost connector bytes', { x: 14, y: 350, size: 10, font });
  page.drawText('No carrier account or physical parcel verified', { x: 14, y: 330, size: 9, font });
  page.drawText('PDF A6 - single page - synthetic fixture', { x: 14, y: 300, size: 10, font });
  const bytes = await pdf.save({ useObjectStreams: false });
  assert(bytes.length > 100 && bytes.length <= 2097152);
  state.controlled_pdf = {
    content_base64: Buffer.from(bytes).toString('base64'),
    content_sha256: hash(bytes),
    content_bytes: bytes.length,
    format: 'pdf',
    layout: 'A6',
    warning: 'TEST TRANSPORTU - NIE DO NADANIA',
  };
  const orderDetails = [],
    metadata = [];
  for (const o of state.orders) {
    const detail = await api('order-born', '/orders/' + o.id);
    assert.equal(detail.status, 'packed');
    assert.equal(detail.payment.received, 0);
    assert.equal(detail.shipments.length, 1);
    assert.equal(detail.shipments[0].id, o.shipment_id);
    assert.equal(detail.shipments[0].mode, 'sandbox');
    assert.equal(detail.shipments[0].dispatched_at, null);
    orderDetails.push(detail);
    const m = await api('cache-born', '/print-jobs/shipments/' + o.shipment_id + '/label-cache');
    assert.equal(m.available, true);
    assert.equal(m.can_acquire, true);
    assert.equal(m.can_queue, false);
    assert.equal(m.cache, null);
    assert.equal(m.latest_acquisition, null);
    assert.match(m.source_hash, /^[a-f0-9]{64}$/);
    metadata.push(m);
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
    'shipment_label_cache_assets',
    'shipment_label_cache_acquisitions',
  ])
    assert.equal(state.setup_checkpoint[table]?.count, 0);
  state.complete = true;
  await save();
  await health();
  await atomic(reportPath, {
    stage: 147,
    status: 'OWN_CONTROLLED_FIXTURE_READY',
    runtime_revision: revision,
    schema_revision: schema,
    tenant_id: state.tenant_id,
    orders: state.orders,
    station_id: state.station.id,
    printer_id: state.printer.id,
    fixture_seeded_source: true,
    source_origin: 'owner_seeded_synthetic_sandbox_shipment',
    provider_verified: false,
    physical_dispatch_verified: false,
    physical_print_verified: false,
    controlled_transport_executed: false,
    cache_acquisitions: 0,
    print_jobs: 0,
    order_status: 'packed',
    stock: { on_hand: 6, reserved: 2, available: 4 },
    pdf: {
      format: 'pdf',
      layout: 'A6',
      content_bytes: bytes.length,
      content_sha256: hash(bytes),
      warning: 'TEST TRANSPORTU - NIE DO NADANIA',
    },
    api_mutations: state.completed.filter((r) => r.method && r.method !== 'GET').length,
    owner_fixture_transactions: 1,
    own_tables: Object.keys(state.setup_checkpoint).length,
    private_setup_sha256: hash(await readFile(statePath)),
    next: 'Root controlled service proof first; then native Chrome cached PDF preview and separate queue consent. Never acquire this synthetic source through unmodified native runtime.',
    full_goal_complete: false,
  });
  console.log(
    JSON.stringify({
      status: 'OWN_CONTROLLED_FIXTURE_READY',
      orders: 2,
      cache_acquisitions: 0,
      print_jobs: 0,
      provider_verified: false,
    }),
  );
} catch {
  throw Error(
    'QA147 setup interrupted. Private pending journal is preserved; never rerun/resume or print its credentials.',
  );
} finally {
  await pool.end();
}
