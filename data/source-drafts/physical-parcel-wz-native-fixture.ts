/** Import-safe root fixture. Genuine HTTP producers only; no database writes,
 * migrations, workers, external providers, synthetic credentials or receipts.
 * The fixture describes an operator's explicit full mapping for a split kit
 * whose component also occurs as a separate historical order line.
 * AUTHORED / NOT_RUN until the root-owned native runner executes it. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';

export async function createPhysicalWzNativeFixture(args: {
  app: FastifyInstance; strictCatalog: boolean; automaticWz: boolean;
  remoteAddress: string; tag: string;
}) {
  const { app } = args;
  const credentials = { email: 'physical-wz-' + randomUUID() + '@example.test', password: 'PhysicalWz!' + randomUUID() };
  const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', remoteAddress: args.remoteAddress,
    payload: { ...credentials, name: 'Physical WZ local QA', organization: { name: 'Physical WZ ' + args.tag + ' ' + randomUUID() } } });
  assert.equal(signup.statusCode, 201, 'Genuine ordinary signup');
  const set = signup.headers['set-cookie']; assert(set); const cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
  assert(cookie.startsWith('dyna_session='));
  async function request(path: string, method: InjectOptions['method'] = 'GET', payload?: InjectOptions['payload']) {
    return app.inject({ url: '/api' + path, method, payload, headers: { cookie }, remoteAddress: args.remoteAddress });
  }
  async function ok(path: string, method: InjectOptions['method'] = 'GET', body?: InjectOptions['payload'], status = 200): Promise<any> {
    const r = await request(path, method, body); assert.equal(r.statusCode, status, 'Actual fixture endpoint ' + method + ' ' + path); return r.json();
  }
  const me = await ok('/auth/me'), tenant = me.user.tenant_id, user = me.user.id;
  assert.equal(me.user.role, 'admin'); assert.equal((await ok('/workspaces')).data[0].id, tenant);
  const warehouse = (await ok('/warehouses')).data[0]; assert(warehouse?.id);
  const products: any[] = [];
  for (const suffix of ['A', 'B']) products.push(await ok('/products', 'POST', {
    sku: 'PWZ-' + suffix + '-' + randomUUID(), name: 'WZ component ' + suffix,
    price: 501, vat: 23, warehouse_id: warehouse.id, quantity: 10, location: 'A-01',
  }, 201));
  const [a, b] = products;
  const kit = await ok('/products', 'POST', {
    sku: 'PWZ-KIT-' + randomUUID(), name: 'WZ split kit A2 B1', kind: 'bundle', price: 1001, vat: 23,
    warehouse_id: warehouse.id, quantity: 0,
    components: [{ product_id: a.id, quantity: 2 }, { product_id: b.id, quantity: 1 }],
  }, 201);
  let strict: any = null, wz: any = null;
  if (args.strictCatalog) {
    const catalog = (await ok('/product-catalogs?limit=50')).data.find((c: any) => c.is_default); assert(catalog);
    const { source } = await ok('/catalog-stock-control/catalogs/' + catalog.id + '/source'); assert.equal(source.ready, true);
    const body = { client_key: randomUUID(), catalog_version: source.snapshot.catalog.version,
      policy_version: source.snapshot.policy.version,
      warehouse_policy_versions: source.snapshot.warehouses.map((w: any) => ({ warehouse_id: w.id, version: w.policy.version })),
      series_versions: source.snapshot.warehouses.map((w: any) => ({ warehouse_id: w.id, version: w.series.version })) };
    const { preview } = await ok('/catalog-stock-control/catalogs/' + catalog.id + '/previews', 'POST', body, 201);
    strict = await ok('/catalog-stock-control/previews/' + preview.id + '/commit', 'POST', { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true }, 201);
    assert.equal(strict.reused, false);
  }
  if (args.automaticWz) {
    const options = await ok('/warehouse-automatic-wz/options'); assert.equal(options.issuer_available, true);
    const configuration = options.warehouses.find((w: any) => w.id === warehouse.id)?.configuration; assert(configuration);
    const settings = { enabled: true, moment: 'physical_dispatch', series_name: 'Physical parcel WZ ' + args.tag, prefix: 'PWZ' };
    const { preview } = await ok('/warehouse-automatic-wz/warehouses/' + warehouse.id + '/previews', 'POST', {
      client_key: randomUUID(), expected_version: configuration.version, settings,
    }, 201); assert.equal(preview.ready, true); assert.equal(preview.can_commit, true);
    wz = await ok('/warehouse-automatic-wz/previews/' + preview.id + '/commit', 'POST', {
      client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true,
    }, 201); assert.equal(wz.reused, false); assert.deepEqual(wz.operation.after.settings, settings);
  }
  let order = await ok('/orders', 'POST', {
    customer_name: 'Physical WZ local recipient', email: 'physical-wz-buyer@example.test',
    address: { street: 'Local QA 168', city: 'Warszawa', postal_code: '00-168', country: 'PL', phone: '+48123456789' },
    warehouse_id: warehouse.id, currency: 'PLN', payment_mode: 'prepaid', shipping_cost: 0,
    items: [{ product_id: kit.id, quantity: 1 }, { product_id: a.id, quantity: 1 }],
  }, 201);
  order = await ok('/orders/' + order.id); assert.equal(order.total, 1502);
  await ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version),
    kind: 'receipt', amount: order.total, currency: 'PLN', method: 'other', reference: 'Local declared QA payment', confirmed: true });
  await ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking' });
  for (const product of [a, a, a, b]) await ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: product.sku, location: 'A-01' });
  await ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
  order = await ok('/orders/' + order.id); assert.equal(order.status, 'packed'); assert.equal(order.items.length, 2);
  const kitItem = order.items.find((i: any) => i.product_id === kit.id), simpleItem = order.items.find((i: any) => i.product_id === a.id);
  assert(kitItem && simpleItem); assert.notEqual(kitItem.id, simpleItem.id);
  const { source } = await ok('/order-parcels/orders/' + order.id + '/source'); assert.equal(source.can_preview, true); assert.equal(source.cod_due, 0);
  const parcelRequest = { client_key: randomUUID(), order_version: source.order.version, parcels: [
    { source_kind: 'demo', cod_minor: 0, products: [{ product_id: a.id, quantity: 2 }] },
    { source_kind: 'demo', cod_minor: 0, products: [{ product_id: a.id, quantity: 1 }, { product_id: b.id, quantity: 1 }] },
  ] };
  const { preview } = await ok('/order-parcels/orders/' + order.id + '/previews', 'POST', parcelRequest, 201);
  const consent = { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true };
  const { plan } = await ok('/order-parcels/previews/' + preview.id + '/apply', 'POST', consent, 201);
  assert.equal(plan.parcels.length, 2); assert(plan.parcels.every((p: any) => p.products.length > 0 && !p.items));
  const allocation = [
    { parcel_index: 0, shipment_id: plan.parcels[0].shipment_id, components: [
      { item_id: kitItem.id, product_id: a.id, quantity: 1 }, { item_id: simpleItem.id, product_id: a.id, quantity: 1 },
    ] },
    { parcel_index: 1, shipment_id: plan.parcels[1].shipment_id, components: [
      { item_id: kitItem.id, product_id: a.id, quantity: 1 }, { item_id: kitItem.id, product_id: b.id, quantity: 1 },
    ] },
  ];
  return { credentials: { ...credentials, cookie, user_id: user, tenant_id: tenant }, tenant, user,
    warehouse, products, kit, order, kit_item: kitItem, simple_item: simpleItem, strict, wz,
    parcel_request: parcelRequest, parcel_preview: preview, parcel_consent: consent, plan, allocation };
}
