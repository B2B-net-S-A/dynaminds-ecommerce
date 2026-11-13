import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import type { Transport } from '../server/integrations';
import { processB2bCatalog } from '../server/b2b-network';
import { seed } from './fixtures';
import { apiKeyLineage } from './api-key-last-use';

type Row = Record<string, any>;
type Actor = { tenant: string; user: string; warehouse: string; cookie: string };
type Snapshot = Record<string, { count: number; sha256: string }>;
export type ProviderHarness = {
  app: Awaited<ReturnType<typeof buildApp>>;
  close(): Promise<void>;
};
export type SourceIntentFixture = {
  app: ProviderHarness['app'];
  buyer: Actor;
  supplier: Actor;
  product: Row;
  source: Row;
  link: Row;
  channel: Row;
  inbound: Row;
  raw: Row;
  previewBody: Row;
  request(
    path: string,
    method?: any,
    payload?: any,
    cookie?: string,
  ): Promise<LightMyRequestResponse>;
  ok(path: string, method?: any, payload?: any, cookie?: string): Promise<Row>;
  snapshot(options?: { physicalOnly?: boolean; tenants?: string[] }): Promise<Snapshot>;
  preview(): Promise<Row>;
  executeBody(preview: Row): Row;
  execute(preview: Row, body?: Row): Promise<LightMyRequestResponse>;
};
const physicalTables = [
  'stock',
  'stock_locations',
  'stock_location_movements',
  'stock_location_operations',
  'stock_movements',
  'reservations',
  'reservation_locations',
  'order_pick_items',
  'warehouse_documents',
  'warehouse_document_lines',
  'wms_operations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
  'shipments',
];
let fixtureSequence = 0;

export async function makeProviderHarness({
  transport,
}: {
  transport: Transport;
}): Promise<ProviderHarness> {
  assert.equal(process.env.DYNA_TEST, 'true');
  const database = new URL(process.env.DATABASE_URL ?? '');
  assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
  await migrate();
  await seed();
  const app = await buildApp({ integrationTransport: transport, logging: false });
  return {
    app,
    async close() {
      try {
        await app.close();
      } finally {
        await pool.end();
      }
    },
  };
}

export async function freshSourceIntentFixture(
  h: ProviderHarness,
  options: {
    provider: string;
    raw: Row;
    settings: Row;
    credentials: Row;
    external_product_id: string;
    remote_line_ids: string[];
    quantities?: number[];
    mode?: 'sandbox' | 'live';
    prepareChannel?: (fixture: SourceIntentFixture) => Promise<void>;
    prepareRaw?: (fixture: SourceIntentFixture) => Promise<Row>;
  },
): Promise<SourceIntentFixture> {
  const ip = '127.0.190.' + ++fixtureSequence;
  const actor = async (email: string, label: string): Promise<Actor> => {
    const user = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0]?.id;
    assert(user);
    const a = { tenant: randomUUID(), warehouse: randomUUID(), user, cookie: '' };
    await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'enterprise')", [
      a.tenant,
      'Own127C ' + label,
    ]);
    await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
      a.tenant,
      user,
    ]);
    await pool.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$3)', [
      a.warehouse,
      a.tenant,
      label,
    ]);
    const login = await h.app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email, password: 'DynaDemo!2026' },
      remoteAddress: ip,
    });
    assert.equal(login.statusCode, 200);
    const switched = await h.app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: a.tenant },
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0] },
      remoteAddress: ip,
    });
    assert.equal(switched.statusCode, 200);
    a.cookie = String(switched.headers['set-cookie']).split(';')[0];
    return a;
  };
  const buyer = await actor('other@demo.local', 'Buyer'),
    supplier = await actor('admin@demo.local', 'Supplier');
  const request: SourceIntentFixture['request'] = (
    path,
    method = 'GET',
    payload,
    cookie = buyer.cookie,
  ) =>
    h.app.inject({ url: '/api' + path, method, payload, headers: { cookie }, remoteAddress: ip });
  const ok: SourceIntentFixture['ok'] = async (...args) => {
    const response = await request(...args);
    assert(
      response.statusCode < 300,
      `${args[1] ?? 'GET'} ${args[0]}: ${response.statusCode} ${response.body.slice(0, 600)}`,
    );
    return response.json();
  };
  const source = await ok(
    '/products',
    'POST',
    {
      sku: 'OWN127C-SUP-' + randomUUID(),
      name: 'Own provider source supplier',
      price: 700,
      vat: 23,
      quantity: 20,
      warehouse_id: supplier.warehouse,
    },
    supplier.cookie,
  );
  const list = await ok(
    '/price-lists',
    'POST',
    { name: 'Own127C list ' + randomUUID(), currency: 'PLN' },
    supplier.cookie,
  );
  await ok(
    '/price-lists/' + list.id + '/items',
    'PUT',
    { version: list.version, items: [{ product_id: source.id, price: 700 }] },
    supplier.cookie,
  );
  const accountBody = {
    name: 'Own127C buyer',
    email: 'own127c-' + randomUUID() + '@example.test',
    warehouse_id: supplier.warehouse,
    price_list_id: list.id,
    address: { street: 'Own warehouse 1', city: 'Poznań', postal_code: '60-001', country: 'PL' },
    min_total: 0,
    min_quantity: 1,
    quantity_step: 1,
    shipping_cost: 0,
    payment_mode: 'prepaid',
  };
  const account = await ok('/b2b/accounts', 'POST', accountBody, supplier.cookie);
  const enabled = await ok(
    '/b2b/accounts/' + account.id,
    'PATCH',
    { ...accountBody, version: account.version, active: true, confirmed: true },
    supplier.cookie,
  );
  const invitation = await ok(
    '/b2b/accounts/' + account.id + '/network-invite',
    'POST',
    { version: enabled.version, recipient_email: 'other@demo.local', confirmed: true },
    supplier.cookie,
  );
  const link = await ok('/b2b/network/accept', 'POST', {
    token: invitation.token,
    confirmed: true,
  });
  const base = '/b2b/network/links/' + link.id;
  const run = await ok(base + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = (await pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1', [run.id]))
      .rows[0];
    if (current.state === 'done') break;
    assert.equal(current.state, 'queued');
    const lease = randomUUID();
    const job = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 AND state='pending' RETURNING *",
        [current.job_id, lease],
      )
    ).rows[0];
    assert(job, 'Only the fixture catalog job may be claimed');
    await processB2bCatalog(job);
    await pool.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1 AND lease_token=$2 AND state='running'",
      [job.id, lease],
    );
  }
  assert.equal(
    (await pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [run.id])).rows[0].state,
    'done',
  );
  const item = (await ok(base + '/catalog')).data.find(
    (row: Row) => row.source_product_id === source.id,
  );
  assert(item);
  const mapped = await ok(base + '/catalog/' + item.id + '/product', 'POST', {
    version: item.version,
    sku: 'OWN127C-LOCAL-' + randomUUID(),
    sale_price: 29999,
    warehouse_id: buyer.warehouse,
    confirmed: true,
  });
  const product = await ok('/products/' + mapped.product_id);
  const channel = await ok('/integrations', 'POST', {
    provider: options.provider,
    name: 'Own127C ' + options.provider + ' ' + randomUUID(),
    mode: options.mode ?? 'sandbox',
    settings: options.settings,
    credentials: options.credentials,
  });
  const snapshot: SourceIntentFixture['snapshot'] = async ({
    physicalOnly = false,
    tenants,
  } = {}) => {
    const selectedTenants =
      tenants ?? (physicalOnly ? [buyer.tenant] : [buyer.tenant, supplier.tenant]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const names = physicalOnly
        ? physicalTables
        : (
            await client.query(
              "SELECT t.table_name FROM information_schema.tables t JOIN information_schema.columns c ON c.table_schema=t.table_schema AND c.table_name=t.table_name WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND c.column_name='tenant_id' AND t.table_name<>'sessions' ORDER BY 1",
            )
          ).rows.map((row: Row) => row.table_name);
      const result: Snapshot = {};
      for (const name of names) {
        assert.match(name, /^[a-z_][a-z0-9_]*$/);
        const rows = (
          await client.query(
            `SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
            [selectedTenants],
          )
        ).rows;
        const facts = name === 'auth237_api_key_state' ? apiKeyLineage(rows) : rows;
        result[name] = {
          count: facts.length,
          sha256: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
        };
      }
      await client.query('COMMIT');
      return result;
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  };
  const executeBody = (preview: Row) => ({
    client_key: randomUUID(),
    version: 1,
    scope_hash: preview.scope_hash,
    confirmed: true,
  });
  const f: SourceIntentFixture = {
    app: h.app,
    buyer,
    supplier,
    source,
    product,
    link,
    channel,
    inbound: {},
    raw: options.raw,
    previewBody: {},
    request,
    ok,
    snapshot,
    executeBody,
    async preview() {
      const response = await request(
        '/imports/' + f.inbound.id + '/external-intent-previews',
        'POST',
        f.previewBody,
      );
      assert.equal(response.statusCode, 201, response.body);
      return response.json().preview;
    },
    execute(preview, body = executeBody(preview)) {
      return request('/import-external-intent-previews/' + preview.id + '/execute', 'POST', body);
    },
  };
  await options.prepareChannel?.(f);
  await ok('/integrations/' + channel.id + '/mappings', 'POST', {
    external_id: options.external_product_id,
    sku: product.sku,
  });
  if (options.prepareRaw) f.raw = await options.prepareRaw(f);
  const staged = await ok('/integrations/' + channel.id + '/stage-orders', 'POST', {
    data: [f.raw],
  });
  assert.equal(staged.data.length, 1);
  f.inbound = staged.data[0];
  const quantities = options.quantities ?? [2, 1];
  assert.equal(options.remote_line_ids.length, quantities.length);
  f.previewBody = {
    client_key: randomUUID(),
    warehouse_id: buyer.warehouse,
    expected_source_hash: f.inbound.source_hash,
    allocations: options.remote_line_ids.map((remote_line_id, index) => ({
      remote_line_id,
      local_quantity: 0,
      external_quantity: quantities[index],
      unassigned_quantity: 0,
      link_id: link.id,
    })),
  };
  return f;
}
