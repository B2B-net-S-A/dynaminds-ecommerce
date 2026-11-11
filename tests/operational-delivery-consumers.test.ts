/** AUTHORED / NOT_RUN. Root-only native167 gate on a quiet numeric test clone of
 * accepted166. Genuine signup/products/opening/order/address/packing/label/parcel
 * APIs; no seed, parent SQL insertion, provider ACK or credential fabrication.
 * Root owns TEMPLATE-wide preservation, current source pins and database closure.
 * Before hook creates the legacy plan under166 then calls ROOT-managed migrate()
 * once to167; no seed/reset/DDL/registry edits. Targeted no-requester worker entry
 * is the same resolvePackedLabelPrint called by resolvePackedLabelsDue, avoiding
 * mutation of unrelated waiting intentions in the accepted clone.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { lstat } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Actor } from '../server/domain';

let app: FastifyInstance,
  pool: Pool,
  providerCalls = 0;
let savedFetch: typeof globalThis.fetch | undefined, fetchCalls = 0;
const deniedFetch: typeof globalThis.fetch = async () => { ++fetchCalls; throw Error('External fetch forbidden in native167 gate'); };
let captureOrderId: string | null = null, capturedAuthority: Actor | undefined;
let buildApp: typeof import('../server/app').buildApp;
let O: typeof import('../server/operational-delivery-consumers');
let resolveWorker: typeof import('../server/packed-label-print').resolvePackedLabelPrint;
let who: Actor,
  cookie = '',
  warehouse = '',
  station: any,
  printer: any,
  carton: any;
let products: any[], legacy: any;
const old = {
  recipient_name: 'Original QA recipient',
  street: 'Old Road 5',
  city: 'Warszawa',
  postal_code: '00-001',
  country: 'PL',
  phone: '+48123456789',
};
const corrected = {
  ...old,
  recipient_name: 'Corrected QA recipient',
  street: 'New Road 12',
  city: 'Lodz',
  postal_code: '90-001',
};
const canonical = (v: any): string =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v);
const hash = (v: any) => createHash('sha256').update(canonical(v)).digest('hex');
async function request(
  path: string,
  method: InjectOptions['method'] = 'GET',
  body?: any,
  lease?: string,
) {
  return app.inject({
    url: '/api' + path,
    method,
    payload: body,
    headers: { cookie, ...(lease ? { 'x-packing-lease': lease } : {}) },
    remoteAddress: '127.0.167.17',
  });
}
async function ok(
  path: string,
  method: InjectOptions['method'] = 'GET',
  body?: any,
  status = 200,
  lease?: string,
): Promise<any> {
  const r = await request(path, method, body, lease);
  let detail = '';
  if (r.statusCode !== status) {
    try { const problem = r.json(); if (typeof problem.detail === 'string') detail = problem.detail; } catch { /* Status still fails without echoing arbitrary response bytes. */ }
  }
  assert.equal(r.statusCode, status, 'Actual own native endpoint status' + (detail ? ': ' + detail : ''));
  return r.json();
}
async function publicOk(o: any, tail = '', body?: any, status = 200): Promise<any> {
  const r = await app.inject({
    url: '/api/public/orders/' + o.portal_token + '/address' + tail,
    method: body ? 'POST' : 'GET',
    payload: body,
    remoteAddress: '127.0.167.18',
  });
  assert.equal(r.statusCode, status, 'Actual buyer-token producer status');
  return r.json();
}
async function order(correct = true, paymentMode: 'cod' | 'prepaid' = 'cod') {
  const o = await ok(
    '/orders',
    'POST',
    {
      customer_name: old.recipient_name,
      email: 'buyer167@example.test',
      warehouse_id: warehouse,
      payment_mode: paymentMode,
      shipping_cost: 0,
      address: {
        street: old.street,
        city: old.city,
        postal_code: old.postal_code,
        country: old.country,
        phone: old.phone,
      },
      items: products.map((p) => ({ product_id: p.id, quantity: 1 })),
    },
    201,
  );
  if (correct) {
    const source = (await pool.query('SELECT customer_name,email,address,source_snapshot FROM orders WHERE(tenant_id,id)=($1,$2)', [who.tenantId, o.id])).rows[0];
    await ok('/orders/' + o.id + '/buyer-address-access', 'PATCH', {
      version: Number(o.version),
      policy_version: 0,
      enabled: true,
      delivery_kind: 'address',
      confirmed_delivery_kind: true,
    });
    const overview = await publicOk(o);
    const preview = await publicOk(
      o,
      '/previews',
      { client_key: randomUUID(), revision: overview.revision, delivery: corrected },
      201,
    );
    await publicOk(
      o,
      '/previews/' + preview.id + '/apply',
      {
        client_key: randomUUID(),
        scope_hash: preview.scope_hash,
        confirmed: true,
        local_only: true,
      },
      201,
    );
    assert.deepEqual((await pool.query('SELECT customer_name,email,address,source_snapshot FROM orders WHERE(tenant_id,id)=($1,$2)', [who.tenantId, o.id])).rows[0], source, 'Correction preserves full original buyer/source fields');
    assert.deepEqual((await ok('/orders/' + o.id)).effective_delivery.delivery, corrected, 'Genuine current operational receiver');
  }
  return o;
}
async function simplePacked(o: any) {
  await ok('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
  for (const p of products) await ok('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
  await ok('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
}
async function graph() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names = (
      await c.query(
        "SELECT relname FROM pg_class c WHERE relnamespace='public'::regnamespace AND relkind='r' AND EXISTS(SELECT FROM pg_attribute WHERE attrelid=c.oid AND attname='tenant_id' AND NOT attisdropped) ORDER BY relname",
      )
    ).rows;
    const result: Record<string, any[]> = {};
    for (const { relname } of names) {
      assert.match(relname, /^[a-z0-9_]+$/);
      result[relname] = (
        await c.query(
          `SELECT to_jsonb(x) row FROM public."${relname}" x WHERE tenant_id=$1 ORDER BY to_jsonb(x)::text`,
          [who.tenantId],
        )
      ).rows.map((r) => r.row);
    }
    await c.query('COMMIT');
    return result;
  } finally {
    try {
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }
}
async function zero(fn: () => Promise<unknown>) {
  const before = await graph();
  const result = await fn();
  assert.deepEqual(await graph(), before, 'All own tenant rows literal across read/replay/refusal');
  return result;
}
function retain(rows: any[], next: any[]) {
  for (const row of rows)
    assert.ok(
      next.some((x) => hash(x) === hash(row)),
      'Every old immutable row literal',
    );
}
type Graph = Record<string, any[]>;
const omit = (r: any, fields: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !fields.includes(k)));
const selected = (rows: any[], predicate: (r: any) => boolean) => {
  const matches = rows.filter(predicate); assert.equal(matches.length, 1); return matches[0];
};
function exactRowDelta(before: any[], after: any[], key: (r: any) => string,
  target: (r: any) => boolean, mutable: string[], changed: (a: any, b: any) => void) {
  assert.equal(after.length, before.length);
  let count = 0;
  for (const b of before) {
    const a = selected(after, r => key(r) === key(b));
    if (target(b)) { ++count; assert.deepEqual(omit(a, mutable), omit(b, mutable)); changed(a, b); }
    else assert.deepEqual(a, b, 'All other physical rows literal');
  }
  assert.equal(count, 1, 'One genuine selected physical row');
}
function assertParcelDispatch(b: Graph, a: Graph, orderId: string, productId: string, dispatchId: string) {
  exactRowDelta(b.stock, a.stock, r => r.warehouse_id + ':' + r.product_id,
    r => r.product_id === productId && r.warehouse_id === warehouse, ['on_hand', 'reserved', 'version'], (x, y) => {
      assert.equal(x.on_hand, y.on_hand - 1); assert.equal(x.reserved, y.reserved - 1);
      assert.equal(BigInt(x.version), BigInt(y.version) + 1n);
    });
  exactRowDelta(b.stock_locations, a.stock_locations, r => r.warehouse_id + ':' + r.product_id + ':' + r.location,
    r => r.product_id === productId && r.warehouse_id === warehouse && r.location === 'A-01', ['quantity'],
    (x, y) => assert.equal(x.quantity, y.quantity - 1));
  exactRowDelta(b.reservations, a.reservations, r => r.order_id + ':' + r.product_id,
    r => r.order_id === orderId && r.product_id === productId, ['consumed_quantity', 'state'], (x, y) => {
      assert.equal(y.quantity, 1); assert.equal(y.consumed_quantity, 0); assert.equal(y.released_quantity, 0);
      assert.equal(x.consumed_quantity, 1); assert.equal(x.state, 'consumed');
    });
  exactRowDelta(b.reservation_locations, a.reservation_locations, r => r.order_id + ':' + r.product_id + ':' + r.location,
    r => r.order_id === orderId && r.product_id === productId && r.location === 'A-01', ['consumed_quantity'], (x, y) => {
      assert.equal(y.quantity, 1); assert.equal(y.scanned, 1); assert.equal(y.consumed_quantity, 0); assert.equal(x.consumed_quantity, 1);
    });
  for (const name of ['stock_movements', 'stock_location_movements']) {
    retain(b[name], a[name]); assert.equal(a[name].length, b[name].length + 1);
    const r = selected(a[name], r => !b[name].some(old => old.id === r.id));
    assert.equal(r.order_id, orderId); assert.equal(r.product_id, productId); assert.equal(r.warehouse_id, warehouse);
    assert.equal(r.kind, 'shipment'); assert.equal(r.delta, -1);
    if (name === 'stock_location_movements') { assert.equal(r.location, 'A-01'); assert.equal(r.operation_id, dispatchId); }
    else assert.equal(r.note, 'parcel:' + dispatchId);
  }
  for (const name of ['wms_operations', 'wms_issue_fragments', 'wms_layer_positions', 'wms_reservation_layers']) assert.deepEqual(a[name], b[name], 'Fixture WMS OFF never writes lots');
}
function assertParcelRelease(b: Graph, a: Graph, orderId: string, productId: string) {
  exactRowDelta(b.stock, a.stock, r => r.warehouse_id + ':' + r.product_id,
    r => r.product_id === productId && r.warehouse_id === warehouse, ['reserved', 'available', 'version'], (x, y) => {
      assert.equal(x.reserved, y.reserved - 1); assert.equal(x.available, y.available + 1);
      assert.equal(BigInt(x.version), BigInt(y.version) + 1n);
    });
  exactRowDelta(b.reservations, a.reservations, r => r.order_id + ':' + r.product_id,
    r => r.order_id === orderId && r.product_id === productId, ['released_quantity', 'state'], (x, y) => {
      assert.equal(y.quantity, 1); assert.equal(y.consumed_quantity, 0); assert.equal(y.released_quantity, 0);
      assert.equal(x.released_quantity, 1); assert.equal(x.state, 'released');
    });
  exactRowDelta(b.reservation_locations, a.reservation_locations, r => r.order_id + ':' + r.product_id + ':' + r.location,
    r => r.order_id === orderId && r.product_id === productId && r.location === 'A-01', ['released_quantity'], (x, y) => {
      assert.equal(y.quantity, 1); assert.equal(y.scanned, 1); assert.equal(y.released_quantity, 0); assert.equal(x.released_quantity, 1);
    });
  for (const name of ['stock_locations', 'stock_movements', 'stock_location_movements', 'wms_operations', 'wms_issue_fragments', 'wms_layer_positions', 'wms_reservation_layers'])
    assert.deepEqual(a[name], b[name], 'Release creates no physical stock/bin/layer movement');
  assert.deepEqual(a.operative_delivery_evidence, b.operative_delivery_evidence, 'Release never fabricates another receiver write');
}
function pdfText(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const streams: string[] = [];
  for (const match of bytes.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    assert.match(match[1], /^[0-9A-F]+>$/);
    const raw = Buffer.from(match[1].slice(0, -1), 'hex');
    try {
      streams.push(inflateSync(raw).toString('latin1'));
    } catch {
      streams.push(raw.toString('latin1'));
    }
  }
  const map = new Map<string, string>();
  for (const s of streams)
    for (const part of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
      for (const m of part[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const b = Buffer.from(m[2], 'hex');
        assert.equal(b.length % 2, 0);
        b.swap16();
        map.set(m[1].toUpperCase(), b.toString('utf16le'));
      }
  assert.ok(map.size > 0, 'Actual embedded ToUnicode map');
  return streams
    .flatMap((s) =>
      [...s.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) =>
        (m[1].match(/.{4}/g) ?? []).map((c) => {
          const glyph = map.get(c.toUpperCase()); assert.notEqual(glyph, undefined, 'Every native PDF text glyph decodes'); return glyph;
        }).join(''),
      ),
    )
    .join('\n');
}
async function parcelPlan(o: any, commercial: boolean) {
  const source = (await ok('/order-parcels/orders/' + o.id + '/source')).source;
  assert.equal(source.can_preview, true);
  const parcels = products.map((p) => ({
    source_kind: 'demo',
    cod_minor: source.cod_due / 2,
    ...(commercial
      ? {
          items: [
            {
              item_id: source.commercial_lines.find((l: any) => l.product_id === p.id).item_id,
              quantity: 1,
            },
          ],
        }
      : { products: [{ product_id: p.id, quantity: 1 }] }),
  }));
  assert.ok(
    parcels.every((p) => Number.isInteger(p.cod_minor)),
    'Fixture divides genuine COD exactly',
  );
  const body = {
    client_key: randomUUID(),
    order_version: source.order.version,
    ...(commercial ? { protocol: 'commercial_v1' } : {}),
    parcels,
  };
  const p = (await ok('/order-parcels/orders/' + o.id + '/previews', 'POST', body, 201)).preview;
  const consent = { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true };
  const result = await ok('/order-parcels/previews/' + p.id + '/apply', 'POST', consent, 201);
  return { p, result, consent };
}
async function freshApp() {
  const instance = await buildApp({ logging: false, backgroundWorkersEnabled: false,
    integrationTransport: async () => { ++providerCalls; throw Error('Native167 provider calls forbidden'); } });
  // Registered before the first inject. Actor/currentUser/cookie come from the
  // genuine native authentication hook; no test-constructed request authority.
  instance.addHook('onRequest', async req => {
    if (captureOrderId && req.method === 'GET' && req.url === '/api/orders/' + captureOrderId) {
      capturedAuthority = O.captureOperationalDeliveryAuthority(req, 'dyna_session');
    }
  });
  return instance;
}
before(async () => {
  assert.equal(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_OPERATIONAL_DELIVERY_NATIVE, 'true');
  const u = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
  assert.equal(u.port, '55432'); assert.match(u.pathname, /^\/dynaminds_test_[0-9]{13}$/);
  const configPath = process.env.DYNA_LOCAL_CONFIG_PATH;
  assert.ok(configPath && configPath.startsWith('/'), 'Root supplies private configuration before imports');
  const stat = await lstat(configPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.mode & 0o777, 0o600);
  savedFetch = globalThis.fetch; globalThis.fetch = deniedFetch;
  const db = await import('../server/db');
  pool = db.pool;
  ({ buildApp } = await import('../server/app'));
  O = await import('../server/operational-delivery-consumers');
  ({ resolvePackedLabelPrint: resolveWorker } = await import('../server/packed-label-print'));
  assert.deepEqual((await pool.query(
    "SELECT EXISTS(SELECT FROM migrations WHERE name='166_buyer_address_sidecar') yes,EXISTS(SELECT FROM migrations WHERE name='167_operational_delivery_consumers') installed,buyer_address_guards() good"
  )).rows[0], { yes: true, installed: false, good: true }, 'Root starts from accepted166 only');
  app = await freshApp();
  const signup = await app.inject({
    url: '/api/auth/signup',
    method: 'POST',
    payload: {
      email: 'op167-' + randomUUID() + '@example.test',
      password: 'Operational167!' + randomUUID(),
      name: 'Native167',
      organization: { name: 'Native167 ' + randomUUID() },
    },
    remoteAddress: '127.0.167.17',
  });
  assert.equal(signup.statusCode, 201);
  const set = signup.headers['set-cookie'];
  assert.ok(set);
  cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
  const me = await ok('/auth/me'),
    spaces = await ok('/workspaces');
  who = { tenantId: spaces.data[0].id, userId: me.user.id, role: 'admin' };
  warehouse = (await ok('/warehouses')).data[0].id;
  products = [];
  for (let i = 0; i < 2; i++)
    products.push(
      await ok(
        '/products',
        'POST',
        {
          sku: 'OP167-' + randomUUID(),
          name: 'Native167 product',
          price: 10000,
          vat: 23,
          warehouse_id: warehouse,
          quantity: 100,
          location: 'A-01',
        },
        201,
      ),
    );
  const catalogs = await ok('/product-catalogs?limit=50'),
    primary = catalogs.data.find((r: any) => r.is_default);
  assert.ok(primary);
  const C = await import('../server/catalog-stock-control'),
    ctx = { writersAvailable: true };
  const { source } = await C.sourceCatalogStockControl(who, primary.id, ctx);
  assert.equal(source.ready, true);
  const { preview } = await C.previewCatalogStockControl(
    who,
    primary.id,
    {
      client_key: randomUUID(),
      catalog_version: source.snapshot.catalog.version,
      policy_version: source.snapshot.policy.version,
      warehouse_policy_versions: source.snapshot.warehouses.map((w: { id: string; policy: { version: string | number }; series: { version: string | number } }) => ({
        warehouse_id: w.id,
        version: w.policy.version,
      })),
      series_versions: source.snapshot.warehouses.map((w: { id: string; policy: { version: string | number }; series: { version: string | number } }) => ({
        warehouse_id: w.id,
        version: w.series.version,
      })),
    },
    ctx,
  );
  await C.commitCatalogStockControl(
    who,
    preview.id,
    { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true },
    ctx,
  );
  // A strict BO catalog requires genuine native automatic WZ before dispatch.
  // The native preview/commit creates its own series/configuration/revision; no
  // direct series insertion or waived fulfillment guard is permitted here.
  const wzOptions = await ok('/warehouse-automatic-wz/options');
  assert.equal(wzOptions.available, true);
  assert.equal(wzOptions.issuer_available, true);
  assert.equal(wzOptions.can_manage, true);
  const wzConfiguration = wzOptions.warehouses.find((w: { id: string }) => w.id === warehouse)?.configuration;
  assert.ok(wzConfiguration);
  const wzSettings = { enabled: true, moment: 'physical_dispatch',
    series_name: 'Native167 automatic dispatch WZ', prefix: 'OP167-WZ' };
  const wzPreview = (await ok('/warehouse-automatic-wz/warehouses/' + warehouse + '/previews', 'POST', {
    client_key: randomUUID(), expected_version: wzConfiguration.version, settings: wzSettings,
  }, 201)).preview;
  assert.equal(wzPreview.ready, true);
  assert.equal(wzPreview.can_commit, true);
  const wzCommit = await ok('/warehouse-automatic-wz/previews/' + wzPreview.id + '/commit', 'POST', {
    client_key: randomUUID(), scope_hash: wzPreview.scope_hash, confirmed: true,
  }, 201);
  assert.equal(wzCommit.reused, false);
  assert.deepEqual(wzCommit.operation.after.settings, wzSettings);
  assert.ok(wzCommit.operation.after.series_id);
  station = (
    await ok(
      '/packing/stations',
      'POST',
      {
        client_key: randomUUID(),
        code: 'OP167-' + randomUUID().slice(0, 8),
        label: 'Native167 station',
        enabled: true,
      },
      201,
    )
  ).station;
  carton = (
    await ok(
      '/packing/cartons',
      'POST',
      {
        client_key: randomUUID(),
        code: 'OP167-' + randomUUID().slice(0, 8),
        label: 'Native167 carton',
        enabled: true,
        inner_dimensions: { length_mm: 360, width_mm: 180, height_mm: 80 },
        outer_dimensions: { length_mm: 380, width_mm: 200, height_mm: 100 },
        tare_grams: 120,
      },
      201,
    )
  ).carton;
  printer = (
    await ok(
      '/print-jobs/printers',
      'POST',
      {
        client_key: randomUUID(),
        station_id: station.id,
        station_version: String(station.version),
        name: 'Native167 file printer',
        format: 'pdf',
        output_mode: 'file',
        cups_queue: null,
        enabled: true,
      },
      201,
    )
  ).printer;
  const o = await order(false);
  await simplePacked(o);
  legacy = { order: o, ...(await parcelPlan(o, false)) };
  await app.close();
  await db.migrate();
  app = await freshApp();
  const guards = (
    await pool.query(
      'SELECT operative_delivery_valid() own,buyer_address_guards() buyer,packed_label_print_guards() packed,order_parcel_guards() parcel',
    )
  ).rows[0];
  assert.deepEqual(guards, { own: true, buyer: true, packed: true, parcel: true });
});
after(async () => {
  const closed: PromiseSettledResult<unknown>[] = [];
  try {
    if (app) closed.push(...await Promise.allSettled([app.close()]));
    if (pool) {
      closed.push(...await Promise.allSettled([(async () => {
        assert.deepEqual((await pool.query('SELECT operative_delivery_valid() own,buyer_address_guards() buyer,packed_label_print_guards() packed,order_parcel_guards() parcel,order_parcel_release_guards() releases')).rows[0],
          { own: true, buyer: true, packed: true, parcel: true, releases: true });
      })()]));
      closed.push(...await Promise.allSettled([pool.end()]));
    }
  } finally {
    if (savedFetch) { assert.equal(globalThis.fetch, deniedFetch); globalThis.fetch = savedFetch; }
  }
  assert.ok(closed.every(r => r.status === 'fulfilled'), 'Own sequential app/pool cleanup');
  assert.equal(providerCalls, 0); assert.equal(fetchCalls, 0);
  if (pool) { assert.equal(pool.totalCount, 0); assert.equal(pool.idleCount, 0); assert.equal(pool.waitingCount, 0); }
});

test('native corrected DEMO frame and actual PDF; immutable preview/queue replay stays literal', async () => {
  const o = await order();
  await simplePacked(o);
  await ok('/orders/' + o.id + '/ship-demo', 'POST');
  const shipment = (
    await pool.query('SELECT * FROM shipments WHERE(tenant_id,order_id)=($1,$2)', [
      who.tenantId,
      o.id,
    ])
  ).rows[0];
  assert.equal(shipment.mode, 'demo');
  const current = await ok('/orders/' + o.id),
    body = {
      client_key: randomUUID(),
      order_version: String(current.version),
      station_id: station.id,
      station_version: String(station.version),
      printer_id: printer.id,
      printer_version: String(printer.version),
      copies: 1,
    };
  const before = await graph(),
    result = await ok(
      '/print-jobs/shipments/' + shipment.id + '/label-previews',
      'POST',
      body,
      201,
    ),
    p = result.preview;
  const asset = (
    await pool.query(
      'SELECT a.* FROM print_label_assets a JOIN print_label_previews p ON(p.tenant_id,p.asset_id)=(a.tenant_id,a.id) WHERE(p.tenant_id,p.id)=($1,$2)',
      [who.tenantId, p.id],
    )
  ).rows[0];
  assert.equal(asset.source_kind, 'demo_generated');
  assert.deepEqual(asset.source_frame.operative_delivery.delivery, corrected);
  const content = await ok('/print-jobs/label-previews/' + p.id + '/content');
  const bytes = Buffer.from(content.content_base64, 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.content_sha256);
  const text = pdfText(bytes);
  for (const value of [
    corrected.recipient_name,
    corrected.street,
    corrected.city,
    corrected.postal_code,
  ])
    assert.ok(text.includes(value), 'Actual PDF shows corrected receiver');
  assert.ok(!text.includes(old.recipient_name));
  const afterPreview = await graph();
  retain(before.print_label_assets, afterPreview.print_label_assets);
  retain(before.operative_delivery_evidence, afterPreview.operative_delivery_evidence);
  await zero(() =>
    ok('/print-jobs/shipments/' + shipment.id + '/label-previews', 'POST', body, 200),
  );
  const consent = { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true };
  const queued = await ok('/print-jobs/label-previews/' + p.id + '/queue', 'POST', consent, 201);
  assert.equal(queued.job.content_sha256, asset.content_sha256);
  await zero(() => ok('/print-jobs/label-previews/' + p.id + '/queue', 'POST', consent, 200));
});
for (const commercial of [false, true])
  test(
    'corrected new ' +
      (commercial ? 'commercial' : 'physical') +
      ' parcel corrected receiver, native dispatch and truthful release boundary',
    async () => {
      const primaryWarehouse = warehouse, primaryProducts = products;
      const primaryBefore = await graph();
      if (!commercial) {
        // Signup starts with the genuine starter quota. Expand this own fixture
        // through local-estimate billing preview/commit, never raw quota SQL.
        const billingBefore = await ok('/workspaces/billing');
        assert.equal(billingBefore.mode, 'local_estimate'); assert.equal(billingBefore.admin, true);
        assert.equal(billingBefore.account, null); assert.equal(billingBefore.current_plan, 'starter');
        const business = billingBefore.plans.find((p: any) => p.plan === 'business');
        assert.ok(business); assert(business.limits.warehouses >= 2);
        const billingPreview = await ok('/workspaces/billing/preview', 'POST', { kind: 'activate', plan: 'business' });
        assert.equal(billingPreview.mode, 'local_estimate'); assert.equal(billingPreview.can_commit, true);
        assert.deepEqual(billingPreview.blockers, []);
        const billingCommit = await ok('/workspaces/billing/previews/' + billingPreview.id + '/commit', 'POST', {});
        assert.equal(billingCommit.mode, 'local_estimate'); assert.equal(billingCommit.plan, 'business');
        const billingAfter = await ok('/workspaces/billing');
        assert.equal(billingAfter.current_plan, 'business'); assert.equal(billingAfter.account.plan, 'business');
        const simpleWarehouse = await ok('/warehouses', 'POST', {
          name: 'Native167 simple physical warehouse', code: 'OP167-SIMPLE',
        });
        const settings = { name: 'Native167 simple physical catalog', active: true,
          languages: ['pl'], default_language: 'pl', warehouse_ids: [simpleWarehouse.id], price_list_ids: [] };
        const catalogPreview = (await ok('/product-catalogs/previews', 'POST', {
          client_key: randomUUID(), kind: 'create', settings,
        }, 201)).preview;
        assert.equal(catalogPreview.ready, true); assert.equal(catalogPreview.can_commit, true);
        const created = await ok('/product-catalogs/previews/' + catalogPreview.id + '/commit', 'POST', {
          client_key: randomUUID(), scope_hash: catalogPreview.scope_hash, confirmed: true,
        }, 201);
        assert.equal(created.reused, false); assert.deepEqual(created.catalog.settings, settings);
        const simpleCatalog = created.catalog.id;
        const simpleProducts = [];
        for (let i = 0; i < 2; i++) simpleProducts.push(await ok('/products', 'POST', {
          sku: 'OP167-SIMPLE-' + randomUUID(), name: 'Native167 simple physical product',
          price: 10000, vat: 23, catalog_id: simpleCatalog, warehouse_id: simpleWarehouse.id,
          quantity: 100, location: 'A-01',
        }, 201));
        const simpleGraph = await graph();
        assert.equal(simpleGraph.catalog_stock_control_policies.filter((r: any) => r.catalog_id === simpleCatalog).length, 0,
          'Genuine new simple catalog has no strict BO policy');
        const configuration = (await ok('/warehouse-automatic-wz/options')).warehouses.find((w: any) => w.id === simpleWarehouse.id)?.configuration;
        assert.deepEqual(configuration, { warehouse_id: simpleWarehouse.id, version: '0', series_id: null, settings: null },
          'New warehouse has no automatic WZ, without toggling any existing configuration');
        for (const product of simpleProducts) {
          assert.equal(product.catalog_id, simpleCatalog);
          const ownStock = selected(simpleGraph.stock, (r: any) => r.product_id === product.id && r.warehouse_id === simpleWarehouse.id);
          assert.equal(ownStock.on_hand, 100); assert.equal(ownStock.reserved, 0);
          assert.equal(selected(simpleGraph.stock_locations, (r: any) => r.product_id === product.id && r.warehouse_id === simpleWarehouse.id && r.location === 'A-01').quantity, 100);
        }
        warehouse = simpleWarehouse.id; products = simpleProducts;
      }
      try {
      const o = await order(true, commercial ? 'prepaid' : 'cod');
      if (commercial) {
        const payable = await ok('/orders/' + o.id);
        await ok('/orders/' + o.id + '/payments', 'POST', {
          client_key: randomUUID(), version: Number(payable.version), kind: 'receipt',
          amount: payable.total, currency: payable.currency, method: 'other',
          reference: 'Own native prepaid commercial release167', confirmed: true,
        });
      }
      await simplePacked(o);
      const { p, result, consent } = await parcelPlan(o, commercial);
      assert.deepEqual(p.source.operative_delivery.delivery, corrected);
      assert.equal(p.source.receiver.name, corrected.recipient_name);
      assert.equal(p.source.receiver.email, o.email);
      for (const key of ['street', 'city', 'postal_code', 'country', 'phone'])
        assert.equal(p.source.receiver.address[key], corrected[key as keyof typeof corrected]);
      assert.deepEqual(result.plan.source.operative_delivery, p.source.operative_delivery);
      await zero(() => ok('/order-parcels/previews/' + p.id + '/apply', 'POST', consent, 200));
      const beforeDispatch = await graph();
      const dispatchRequest = { client_key: randomUUID(), scope_hash: result.plan.scope_hash, confirmed: true };
      const dispatched = await ok(
        '/order-parcels/plans/' + result.plan.id + '/parcels/0/dispatch',
        'POST',
        dispatchRequest,
      );
      const afterDispatch = await graph();
      assertParcelDispatch(beforeDispatch, afterDispatch, o.id, products[0].id, dispatched.dispatch.id);
      await zero(() => ok('/order-parcels/plans/' + result.plan.id + '/parcels/0/dispatch', 'POST', dispatchRequest));
      assert.equal(dispatched.dispatch.plan_id, result.plan.id);
      const actual = (
        await pool.query('SELECT payload FROM order_parcel_plans WHERE(tenant_id,id)=($1,$2)', [
          who.tenantId,
          result.plan.id,
        ])
      ).rows[0].payload;
      assert.deepEqual(actual.source.operative_delivery.delivery, corrected);
      const releaseSource = (await ok('/order-parcel-releases/plans/' + result.plan.id + '/source')).source;
      // Native137 only admits prepaid commercial_v1. Legacy physical/COD is
      // inspection-only here; prove truthful refusal rather than fake release.
      if (!commercial) {
        assert.equal(releaseSource.can_release, false);
        await zero(() => ok('/order-parcel-releases/plans/' + result.plan.id + '/previews', 'POST',
          { client_key: randomUUID(), order_version: releaseSource.order_version }, 409));
        const pending = (await ok('/order-parcels/plans/' + result.plan.id)).plan;
        assert.equal(pending.complete, false); assert.deepEqual(pending.progress.map((r: any) => r.state), ['dispatched', 'pending']);
        assert.deepEqual(pending.origins, []);
        return;
      }
      assert.equal(releaseSource.can_release, true); assert.equal(releaseSource.summary.pending_parcels, 1);
      assert.deepEqual(releaseSource.pending.map((r: any) => r.index), [1]);
      const releasePreview = (await ok('/order-parcel-releases/plans/' + result.plan.id + '/previews', 'POST',
        { client_key: randomUUID(), order_version: releaseSource.order_version }, 201)).preview;
      const releaseConsent = { client_key: randomUUID(), scope_hash: releasePreview.scope_hash, confirmed: true };
      const beforeRelease = await graph();
      const released = (await ok('/order-parcel-releases/previews/' + releasePreview.id + '/release', 'POST', releaseConsent, 201)).release;
      assert.equal(released.order_status, 'shipped'); assert.equal(released.receipt.physical_movement, false);
      assert.deepEqual(released.receipt.cancelled.map((r: any) => r.index), [1]);
      assertParcelRelease(beforeRelease, await graph(), o.id, products[1].id);
      await zero(() => ok('/order-parcel-releases/previews/' + releasePreview.id + '/release', 'POST', releaseConsent, 200));
      const completed = (await ok('/order-parcels/plans/' + result.plan.id)).plan;
      assert.equal(completed.complete, true); assert.deepEqual(completed.progress.map((r: any) => r.state), ['dispatched', 'cancelled']);
      assert.equal(completed.progress[1].release_id, released.id);
      assert.equal(completed.origins.length, 2);
      assert.deepEqual(completed.origins.map((r: any) => [r.parcel_index, r.issued_quantity, r.cancelled_quantity]), [[0, 1, 0], [1, 0, 1]]);

      } finally {
        warehouse = primaryWarehouse; products = primaryProducts;
        if (!commercial) {
          const afterPhysical = await graph();
          for (const name of ['catalog_stock_control_policies', 'catalog_stock_control_revisions',
            'warehouse_automatic_wz_configurations', 'warehouse_automatic_wz_revisions'])
            assert.deepEqual(afterPhysical[name], primaryBefore[name], 'Primary strict catalog and enabled WZ remain literal');
          for (const name of ['stock', 'stock_locations']) {
            const primary = (r: any) => r.warehouse_id === primaryWarehouse && primaryProducts.some(p => p.id === r.product_id);
            assert.deepEqual(afterPhysical[name].filter(primary), primaryBefore[name].filter(primary), 'Physical fixture never changes primary stock');
          }
        }
      }
    },
  );
test('accepted pre167 parcel plan replay uses exact original receiver without new corrected evidence', async () => {
  assert.equal(Object.hasOwn(legacy.result.plan.source, 'operative_delivery'), false);
  await zero(async () => {
    const r = await ok(
      '/order-parcels/previews/' + legacy.p.id + '/apply',
      'POST',
      legacy.consent,
      200,
    );
    assert.deepEqual(r.plan, legacy.result.plan);
  });
});
test('actual automatic156 worker uses durable consent; no fabricated session and exact queued replay', async () => {
  const settings = {
    station_id: station.id,
    station_version: String(station.version),
    printer_id: printer.id,
    printer_version: String(printer.version),
    copies: 1,
    enabled: true,
  };
  const cfg = (
    await ok(
      '/print-jobs/packed-labels/previews',
      'POST',
      { client_key: randomUUID(), expected_version: '0', settings },
      201,
    )
  ).preview;
  await ok(
    '/print-jobs/packed-labels/previews/' + cfg.id + '/approve',
    'POST',
    { client_key: randomUUID(), scope_hash: cfg.scope_hash, confirmed: true },
    201,
  );
  const o = await order();
  await ok('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
  const current = await ok('/orders/' + o.id),
    lease = randomUUID();
  let session = (
    await ok(
      '/packing/sessions',
      'POST',
      {
        client_key: randomUUID(),
        order_id: o.id,
        order_version: String(current.version),
        station_id: station.id,
        station_version: String(station.version),
        lease_token: lease,
      },
      201,
    )
  ).session;
  for (const p of products) {
    await ok(
      '/packing/sessions/' + session.id + '/scans',
      'POST',
      {
        client_key: randomUUID(),
        session_version: String(session.version),
        order_version: String(current.version),
        code: p.sku,
      },
      201,
      lease,
    );
    session = (await ok('/packing/sessions/' + session.id)).session;
  }
  const finish = (
    await ok(
      '/packing/previews',
      'POST',
      {
        client_key: randomUUID(),
        kind: 'finish',
        session_id: session.id,
        session_version: String(session.version),
        order_version: String(current.version),
        station_version: String(station.version),
        packaging: { kind: 'carton', carton_id: carton.id, carton_version: String(carton.version) },
        measurements: { weight_grams: 1370, length_mm: 380, width_mm: 200, height_mm: 100 },
        include_product_estimate: false,
      },
      201,
      lease,
    )
  ).preview;
  assert.equal(finish.ready, true);
  await ok(
    '/packing/previews/' + finish.id + '/finish',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: finish.scope_hash,
      confirmed: true,
      confirm_measured: true,
    },
    201,
    lease,
  );
  const intent = (await ok('/print-jobs/packed-labels/intentions?order_id=' + o.id)).data[0];
  assert.equal(intent.state, 'waiting');
  await ok('/orders/' + o.id + '/ship-demo', 'POST');
  const before = await graph();
  await resolveWorker(who.tenantId, intent.id);
  const after = await graph();
  assert.deepEqual(after.sessions, before.sessions, 'Worker creates no login/session');
  const queued = after.packed_label_print_intents.find((i) => i.id === intent.id);
  assert.equal(queued.state, 'queued');
  const evidence = after.operative_delivery_evidence.filter(
    (e) => e.worker_intent_id === intent.id,
  );
  assert.equal(evidence.length, 2);
  assert.ok(
    evidence.every(
      (e) => e.actor_id === who.userId && e.api_key_id === null && e.consumer === 'label',
    ),
  );
  const job = after.print_jobs.find((j) => j.id === queued.job_id),
    asset = after.print_label_assets.find((a) => a.content_sha256 === job.content_sha256);
  assert.deepEqual(asset.source_frame.operative_delivery.delivery, corrected);
  assert.deepEqual(evidence.map(e => e.client_key).sort(), [queued.preview_key, queued.queue_key].sort());
  assert.ok(evidence.every(e => e.delivery_hash === hash(corrected) && /^[a-f0-9]{64}$/.test(e.worker_basis_hash)));
  const packingReceipt = selected(after.packing_receipts, r => r.id === queued.receipt_id);
  assert.equal(packingReceipt.order_id, o.id); assert.equal(packingReceipt.kind, 'finish');
  const configuration = selected(after.packed_label_print_configurations, r => r.id === queued.configuration_id);
  assert.equal(configuration.approved_by, who.userId); assert.deepEqual(configuration.settings, settings);
  const source = selected(after.print_job_label_sources, r => r.job_id === job.id);
  const admission = selected(after.packed_label_print_admissions, r => r.intent_id === intent.id);
  assert.equal(admission.preview_id, source.preview_id); assert.equal(admission.approved_by, who.userId);
  assert.equal(source.client_key, queued.queue_key); assert.equal(source.actor_id, who.userId); assert.equal(source.api_key_id, null);
  assert.equal(source.order_id, o.id); assert.equal(source.asset_id, asset.id);
  const actualPreview = selected(after.print_label_previews, r => r.id === source.preview_id);
  assert.equal(actualPreview.client_key, queued.preview_key);
  const content = await ok('/print-jobs/label-previews/' + actualPreview.id + '/content');
  const bytes = Buffer.from(content.content_base64, 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.content_sha256);
  const workerPdfText = pdfText(bytes);
  for (const value of [corrected.recipient_name, corrected.street, corrected.city, corrected.postal_code]) assert.ok(workerPdfText.includes(value));
  assert.ok(!workerPdfText.includes(old.recipient_name));

  await zero(() => resolveWorker(who.tenantId, intent.id));
});
test('real orphan operational admission rejects deferred closure23514 and fully rolls back', async () => {
  const o = await order();
  capturedAuthority = undefined; captureOrderId = o.id;
  try { await ok('/orders/' + o.id); } finally { captureOrderId = null; }
  assert.ok(capturedAuthority, 'Native authenticated GET captured real authority');
  const before = await graph(), c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [who.tenantId]);
    await c.query('SET LOCAL ROLE dyna_app');
    O.beginOperationalDeliveryTransaction(c);
    await O.enlistOperationalDeliveryInTx(c, {
      actor: capturedAuthority,
      orderId: o.id,
      consumer: 'label',
      clientKey: randomUUID(),
      encryptionKey: (await import('../server/db')).localConfig.encryptionKey,
      write: true,
    });
    await assert.rejects(
      c.query('SET CONSTRAINTS ALL IMMEDIATE'),
      (e: any) =>
        e.code === '23514' && e.message === 'Operational proof lacks its typed native operation',
    );
  } finally {
    try {
      await c.query('ROLLBACK');
    } finally {
      O.endOperationalDeliveryTransaction(c);
      c.release();
    }
  }
  assert.deepEqual(await graph(), before);
});
test('historical encrypted operational evidence validates correct key and rejects wrong key without mutations', async () => {
  const before = await graph(),
    c = await pool.connect(),
    config = await import('../server/db');
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await O.validateRecoveredOperationalDeliveries(
      c,
      config.localConfig.encryptionKey,
    );
    const count = Number((await c.query('SELECT count(*) n FROM operative_delivery_evidence')).rows[0].n);
    assert.equal(result.records, count, 'Every global historical evidence row actually decrypted');
    assert.equal(before.operative_delivery_evidence.length, 10, 'Two manual label + two parcel preview/apply/dispatch chains + two worker evidence rows');
    const wrong =
      (config.localConfig.encryptionKey[0] === '0' ? '1' : '0') +
      config.localConfig.encryptionKey.slice(1);
    await assert.rejects(
      O.validateRecoveredOperationalDeliveries(c, wrong),
      (e: any) => e.status === 503,
    );
  } finally {
    try {
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }
  assert.deepEqual(await graph(), before);
});
// Real cached carrier bytes need an independently supplied genuine provider/cache
// fixture. This suite neither fabricates it nor claims cached-provider acceptance.
