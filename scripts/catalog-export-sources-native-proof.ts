/** Root-operated QA116. Authoring this file does not run it.
 * setup creates one synthetic local firm; readback runs AFTER the manual UI
 * exercise and first captures its accepted checkpoint. A later readback must
 * match it exactly. Failed/partial setup requires explicit root inspection;
 * this helper never guesses a resume or recreates an existing state.
 */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { pool } from '../server/db';
import type { CatalogExportSourceValues } from '../server/catalog-export-sources';

type Json = Record<string, any>;
type Digest = { count: number; sha256: string };
const statePath = 'data/catalog-export-sources-stage116.json';
const reportPrefix = 'docs/catalog-export-sources-native';
const phase = process.argv[2];
const revision = process.env.QA_EXPECTED_REVISION;
assert(phase === 'setup' || phase === 'readback', 'Use setup or readback');
assert(revision && /^[a-f0-9]{7,40}$/.test(revision), 'Set QA_EXPECTED_REVISION');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const ownNames = [
  'tenants',
  'users',
  'memberships',
  'warehouses',
  'products',
  'product_sku_aliases',
  'product_logistics',
  'bundle_components',
  'stock',
  'stock_locations',
  'reservations',
  'reservation_locations',
  'orders',
  'order_items',
  'order_events',
  'price_lists',
  'price_list_items',
  'catalog_export_profiles',
  'audit_events',
  'workspace_usage',
];
async function save(s: Json, fresh = false) {
  if (!fresh) {
    const stat = await lstat(statePath);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  }
  const handle = await open(
    statePath,
    constants.O_WRONLY |
      constants.O_NOFOLLOW |
      (fresh ? constants.O_CREAT | constants.O_EXCL : constants.O_TRUNC),
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(s, null, 2));
  } finally {
    await handle.close();
  }
}
async function load(): Promise<Json> {
  const stat = await lstat(statePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  return JSON.parse(await readFile(statePath, 'utf8'));
}
async function api(
  s: Json,
  path: string,
  method = 'GET',
  body?: unknown,
  status = 200,
  extra: Record<string, string> = {},
) {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, status, `${method} ${path}: HTTP ${response.status}`);
  return { response, data: (await response.json()) as Json };
}
async function step(
  s: Json,
  name: string,
  path: string,
  method: string,
  body: Json,
  status = 200,
  extra: Record<string, string> = {},
) {
  s.pending = name;
  s.pending_request = { path, method, body, expected_status: status, headers: extra };
  await save(s);
  return api(s, path, method, body, status, extra);
}
async function checkpoint(s: Json): Promise<Record<string, Digest>> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const result: Record<string, Digest> = {};
    for (const name of s.own_names as string[]) {
      assert(ownNames.includes(name));
      const where = name === 'users' ? 'id=$1' : name === 'tenants' ? 'id=$1' : 'tenant_id=$1';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${where} ORDER BY 1`, [
          name === 'users' ? s.user : s.tenant,
        ])
      ).rows;
      result[name] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
    }
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
  }
}
/** Independent RFC4180 decoder, not the production serializer. */
function csv(text: string) {
  text = text.replace(/^\ufeff/, '');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && ch === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (ch === '\r' || ch === '\n')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  assert(!quoted && !cell && !row.length, 'CSV must contain complete terminated rows');
  return rows;
}
type XmlNode = { name: string; attrs: Record<string, string>; text: string; children: XmlNode[] };
/** Parses actual XML structure/types/nulls, without using the engine's encoder. */
function xml(text: string) {
  const parser = new SaxesParser({ xmlns: false });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  parser.on('opentag', (tag) => {
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(tag.attributes)) {
      assert.equal(typeof value, 'string');
      assert(typeof value === 'string');
      attrs[key] = value;
    }
    const node: XmlNode = { name: tag.name, attrs, text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on('text', (text) => {
    if (stack.length) stack.at(-1)!.text += text;
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('error', (error) => {
    throw error;
  });
  parser.write(text).close();
  assert(root && root.name === 'catalog');
  assert.equal(root.attrs.currency, 'PLN');
  assert.equal(root.attrs.price_source, 'catalog');
  const value = (node: XmlNode): unknown => {
    if (node.attrs.nil === 'true') return null;
    if (node.attrs.type === 'array') return node.children.map(value);
    if (node.attrs.type === 'object') {
      assert(node.children.every((n) => n.name === 'entry' && typeof n.attrs.key === 'string'));
      return Object.fromEntries(node.children.map((n) => [n.attrs.key, value(n)]));
    }
    if (node.attrs.type === 'number') {
      const n = Number(node.text);
      assert(Number.isFinite(n));
      return n;
    }
    if (node.attrs.type === 'boolean') {
      assert(['true', 'false'].includes(node.text));
      return node.text === 'true';
    }
    assert.equal(node.attrs.type, 'string');
    return node.text;
  };
  return root.children.map((product) => {
    assert.equal(product.name, 'product');
    assert.equal(product.children.length, 3);
    return Object.fromEntries(product.children.map((field) => [field.name, value(field)]));
  });
}
function definition(s: Json, format: 'csv' | 'xml') {
  return {
    format,
    columns: ['sku', 'inventory_json', 'prices_json'],
    warehouse_ids: [s.warehouses.second.id, s.warehouses.main.id],
    price_list_ids: [s.lists.eur.id, s.lists.pln.id],
    headers:
      format === 'csv'
        ? { inventory_json: 'Stany', prices_json: 'Ceny' }
        : { inventory_json: 'stocks', prices_json: 'prices' },
    spreadsheet_safe: format === 'csv',
  };
}
function expectedMatrix(s: Json, product: Json): CatalogExportSourceValues {
  const bundle = product.id === s.products.bundle.id;
  return {
    inventory_json: [s.warehouses.second, s.warehouses.main].map((w, i) => {
      const physical =
        product.id === s.products.a.id
          ? { on_hand: 12, reserved: 3, available: 9 }
          : { on_hand: 10, reserved: 0, available: 10 };
      return {
        warehouse_id: w.id,
        warehouse_name: w.name,
        warehouse_code: w.code,
        status: bundle || i === 1 ? 'available' : 'missing',
        source: bundle ? 'components' : 'stock',
        on_hand: bundle || i === 0 ? null : physical.on_hand,
        reserved: bundle || i === 0 ? null : physical.reserved,
        available: bundle ? (i === 0 ? 0 : 4) : i === 0 ? null : physical.available,
      };
    }),
    prices_json: [s.lists.eur, s.lists.pln].map((l, i) => {
      const override = i === 0 && product.id === s.products.a.id;
      const gross = Number((BigInt(product.price) * 10500n + 5000n) / 10000n) + 19;
      return {
        price_list_id: l.id,
        price_list_name: l.name,
        currency: l.currency,
        version: l.version,
        own_price_minor: override ? 0 : null,
        effective_price_minor: i === 0 ? (override ? 0 : null) : gross,
        source: i === 0 ? (override ? 'override' : null) : 'rule',
        status: i === 0 && !override ? 'missing' : 'available',
      };
    }),
  };
}
async function setup(health: Json) {
  // O_EXCL owns the state before the first account write; no existing fixture can be overwritten.
  const suffix = randomUUID();
  const s: Json = {
    stage: 116,
    runtime_revision: revision,
    schema_revision: health.schema_revision,
    email: `qa116-matrix-${suffix}@demo.local`,
    password: process.env.QA_NATIVE_TEST_PASSWORD ?? `DynaQa116!${randomUUID()}`,
    setup_complete: false,
    pending: 'signup',
    own_names: ownNames,
    own_snapshot_timezone: 'UTC',
    warehouses: {},
    products: {},
    lists: {},
    profiles: [],
  };
  assert(s.password.length >= 12 && s.password.length <= 200);
  await save(s, true);
  const signup = await api(
    {},
    '/auth/signup',
    'POST',
    {
      email: s.email,
      password: s.password,
      name: 'QA116 Macierz eksportu',
      organization: {
        name: 'QA116 Źródła eksportu ' + suffix.slice(0, 8),
        currency: 'PLN',
        locale: 'pl-PL',
      },
    },
    201,
  );
  const cookie = signup.response.headers.get('set-cookie');
  assert(cookie);
  s.cookie = cookie.split(';')[0];
  s.user = signup.data.user.id;
  s.tenant = signup.data.user.tenant_id;
  assert.equal(signup.data.user.role, 'admin');
  await save(s);
  // Official local plan change, as in earlier QA: Starter permits only one warehouse.
  const plan = await step(s, 'own local business plan', '/workspaces/plan', 'PATCH', {
    plan: 'business',
  });
  assert.equal(plan.data.billing, 'local_only');
  const warehouses = (await api(s, '/warehouses')).data.data as Json[];
  assert.equal(warehouses.length, 1);
  s.warehouses.main = warehouses[0];
  s.warehouses.second = (
    await step(s, 'second warehouse', '/warehouses', 'POST', {
      name: 'QA116 Magazyn drugi',
      code: 'QA116-' + suffix.slice(0, 8),
    })
  ).data;
  await save(s);
  for (const [key, price, quantity] of [
    ['a', 2599, 12],
    ['b', 1001, 10],
    ['bundle', 7999, 0],
  ] as const) {
    const body = {
      sku: `QA116-${suffix.slice(0, 8)}-${key.toUpperCase()}`,
      name: `QA116 Produkt ${key} ą`,
      price,
      quantity,
      warehouse_id: s.warehouses.main.id,
      ...(key === 'bundle'
        ? {
            kind: 'bundle',
            components: [
              { product_id: s.products.a.id, quantity: 2 },
              { product_id: s.products.b.id, quantity: 1 },
            ],
          }
        : {}),
    };
    s.products[key] = (await step(s, 'product ' + key, '/products', 'POST', body, 201)).data;
    await save(s);
  }
  const orderKey = randomUUID();
  s.order = (
    await step(
      s,
      'reserve three A',
      '/orders',
      'POST',
      {
        customer_name: 'QA116 Rezerwacja eksportu',
        email: 'qa116-order@example.test',
        warehouse_id: s.warehouses.main.id,
        items: [{ product_id: s.products.a.id, quantity: 3 }],
      },
      201,
      { 'Idempotency-Key': orderKey },
    )
  ).data;
  await save(s);
  for (const currency of ['PLN', 'EUR'] as const) {
    const key = currency === 'PLN' ? 'pln' : 'eur';
    s.lists[key] = (
      await step(
        s,
        'price list ' + currency,
        '/price-lists',
        'POST',
        {
          name: 'QA116 ' + currency,
          currency,
          fallback: currency === 'PLN',
          ...(currency === 'PLN' ? { adjustment_bps: 500, adjustment_amount: 19 } : {}),
        },
        201,
      )
    ).data;
    await save(s);
  }
  s.lists.eur = (
    await step(s, 'EUR zero override', `/price-lists/${s.lists.eur.id}/items`, 'PUT', {
      version: s.lists.eur.version,
      items: [{ product_id: s.products.a.id, price: 0 }],
    })
  ).data;
  await save(s);
  for (const format of ['csv', 'xml'] as const) {
    const body = {
      name: 'QA116 ' + format.toUpperCase() + ' źródła',
      definition: definition(s, format),
      client_key: randomUUID(),
    };
    const created = await step(
      s,
      'profile ' + format,
      '/catalog/export-profiles',
      'POST',
      body,
      201,
    );
    const before = await checkpoint(s);
    const replay = await api(s, '/catalog/export-profiles', 'POST', body);
    assert.equal(replay.data.reused, true);
    assert.deepEqual(replay.data.profile, created.data.profile);
    assert.deepEqual(await checkpoint(s), before, 'Exact create retry must not change own effects');
    s.profiles.push({ body, profile: created.data.profile });
    await save(s);
  }
  s.pending = null;
  delete s.pending_request;
  s.setup_complete = true;
  await save(s);
  await writeFile(
    reportPrefix + '-setup-qa.json',
    JSON.stringify(
      {
        status: 'PASS',
        stage: 116,
        runtime_revision: revision,
        schema_revision: health.schema_revision,
        own_tenant: s.tenant,
        warehouses: Object.values(s.warehouses).map((w: any) => ({ id: w.id, code: w.code })),
        products: Object.values(s.products).map((p: any) => ({
          id: p.id,
          sku: p.sku,
          kind: p.kind,
        })),
        price_lists: Object.values(s.lists).map((l: any) => ({
          id: l.id,
          currency: l.currency,
          version: l.version,
        })),
        profiles: s.profiles.map((p: Json) => ({
          id: p.profile.id,
          version: p.profile.version,
          format: p.profile.definition.format,
        })),
        reserved_quantity: 3,
        profile_create_exact_replays: 2,
        warehouse_2_physical_stock: 'missing',
        readback: 'PENDING',
        ui: 'PENDING',
        provider_operations: false,
        full_goal_complete: false,
      },
      null,
      2,
    ),
  );
  return { profiles: 2, products: 3 };
}
async function readback(health: Json) {
  const s = await load();
  assert(s.stage === 116 && s.setup_complete && !s.pending);
  assert.equal(s.runtime_revision, revision);
  assert.equal(s.schema_revision, health.schema_revision);
  const me = (await api(s, '/auth/me')).data.user;
  assert.equal(me.id, s.user);
  assert.equal(me.tenant_id, s.tenant);
  assert.equal(me.role, 'admin');
  const before = await checkpoint(s);
  if (s.own_snapshot)
    assert.deepEqual(before, s.own_snapshot, 'Accepted QA116 checkpoint must not drift');
  const noProviders = (
    await pool.query<{ channels: number; shipping_plans: number }>(
      `SELECT (SELECT count(*)::integer FROM channels WHERE tenant_id=$1) AS channels,
    (SELECT count(*)::integer FROM shipping_plans WHERE tenant_id=$1) AS shipping_plans`,
      [s.tenant],
    )
  ).rows[0];
  assert.deepEqual(noProviders, { channels: 0, shipping_plans: 0 });
  const profiles = (await api(s, '/catalog/export-profiles')).data;
  assert(profiles.available && profiles.can_manage && !profiles.read_only);
  assert.equal(profiles.data.length, 3, 'UI must save the third own source profile');
  const uiProfile = (profiles.data as Json[]).find((p) => p.name === 'QA116 XML własny źródła');
  assert(uiProfile && !uiProfile.archived && uiProfile.version === 1);
  assert.deepEqual(uiProfile.definition, definition(s, 'xml'));
  const options = (await api(s, '/catalog/exports/options')).data;
  assert.equal(options.catalog_currency, 'PLN');
  assert.equal(options.price_source, 'catalog');
  assert(
    options.sources.allow_inventory &&
      options.sources.warehouses.available &&
      options.sources.price_lists.available,
  );
  assert.equal(options.count.matched_products, 3);
  assert.equal(options.count.capped, false);
  const products = Object.values(s.products) as Json[];
  const ids = products.map((p) => p.id);
  const expected = new Map(products.map((p) => [p.id, expectedMatrix(s, p)]));
  const expectedBySku = new Map(products.map((p) => [p.sku, expected.get(p.id)!]));
  const files: Json[] = [],
    previews: Json[] = [];
  for (const native of s.profiles as Json[]) {
    const profile = (profiles.data as Json[]).find((p) => p.id === native.profile.id);
    assert(profile);
    assert.deepEqual(profile, native.profile, 'Native source profiles must remain unchanged');
    const config = { ...profile.definition, selection: 'selected', ids };
    const preview = (await api(s, '/catalog/exports/preview', 'POST', config)).data;
    assert.equal(preview.count.matched_products, 3);
    assert.equal(preview.count.capped, false);
    assert.equal(preview.catalog_currency, 'PLN');
    assert.equal(preview.sample_limit, 3);
    assert.equal(preview.sample.length, 3);
    assert.equal(preview.read_only, true);
    assert.deepEqual(
      preview.sample.map((p: Json) => p.product_id),
      [...ids].sort(),
    );
    for (const row of preview.sample) {
      const p = products.find((p) => p.id === row.product_id);
      assert(p);
      assert.equal(row.sku, p.sku);
      assert.equal(row.name, p.name);
      assert.deepEqual(
        { inventory_json: row.inventory_json, prices_json: row.prices_json },
        expected.get(row.product_id),
      );
    }
    previews.push({
      format: profile.definition.format,
      sample_count: 3,
      product_ids: preview.sample.map((p: Json) => p.product_id),
    });
    const response = await fetch('http://127.0.0.1:4100/api/catalog/exports/file', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        cookie: s.cookie,
        'X-Workspace-ID': s.tenant,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    });
    assert.equal(response.status, 200, 'POST /catalog/exports/file');
    const bytes = Buffer.from(await response.arrayBuffer()),
      text = bytes.toString('utf8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-catalog-currency'), 'PLN');
    assert.equal(response.headers.get('x-catalog-export-count'), '3');
    assert.equal(Number(response.headers.get('content-length')), bytes.length);
    assert(bytes.length > 0 && bytes.length <= options.limits.file_bytes);
    const found = new Map<string, CatalogExportSourceValues>();
    if (profile.definition.format === 'csv') {
      assert(response.headers.get('content-type')?.startsWith('text/csv'));
      const [header, ...rows] = csv(text);
      assert.deepEqual(header, ['sku', 'Stany', 'Ceny']);
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.equal(row.length, 3);
        assert(row[0].startsWith("'"));
        const sku = row[0].slice(1);
        assert(!found.has(sku));
        found.set(sku, { inventory_json: JSON.parse(row[1]), prices_json: JSON.parse(row[2]) });
      }
    } else {
      assert(response.headers.get('content-type')?.startsWith('application/xml'));
      const rows = xml(text);
      assert.equal(rows.length, 3);
      for (const row of rows) {
        assert.deepEqual(Object.keys(row), ['sku', 'stocks', 'prices']);
        assert.equal(typeof row.sku, 'string');
        const sku = row.sku as string;
        assert(!found.has(sku));
        found.set(sku, {
          inventory_json: row.stocks as CatalogExportSourceValues['inventory_json'],
          prices_json: row.prices as CatalogExportSourceValues['prices_json'],
        });
      }
    }
    assert.deepEqual([...found.keys()].sort(), [...expectedBySku.keys()].sort());
    for (const [sku, matrix] of found) assert.deepEqual(matrix, expectedBySku.get(sku));
    const artifact = `${reportPrefix}-custom.${profile.definition.format}`;
    await writeFile(artifact, bytes);
    files.push({
      format: profile.definition.format,
      profile_id: profile.id,
      version: profile.version,
      bytes: bytes.length,
      sha256: sha(bytes),
      artifact,
      rows: found.size,
    });
  }
  const after = await checkpoint(s);
  assert.deepEqual(
    after,
    before,
    'Options, preview and downloads must not mutate accepted own business data',
  );
  // No copied-session claim: UI may have made additional own logins; this scope
  // explicitly covers business/identity rows and excludes mutable jobs/sessions.
  if (!s.own_snapshot) {
    s.own_snapshot = after;
    s.accepted_checkpoint = after;
    await save(s);
  }
  await writeFile(
    reportPrefix + '-readback-qa.json',
    JSON.stringify(
      {
        status: 'PASS',
        stage: 116,
        runtime_revision: revision,
        schema_revision: health.schema_revision,
        own_tenant: s.tenant,
        profiles_count: profiles.data.length,
        native_profiles: files.map((f) => ({ id: f.profile_id, version: f.version })),
        defaults: options.defaults,
        limits: options.limits,
        previews,
        files,
        own_names: s.own_names,
        own_checkpoint: after,
        own_snapshot_timezone: 'UTC',
        own_business_readback_unchanged: true,
        accepted_checkpoint_exact: true,
        physical_stock: {
          a_on_hand: 12,
          a_reserved: 3,
          a_available: 9,
          b_on_hand: 10,
          b_reserved: 0,
          b_available: 10,
        },
        bundle_available: { main: 4, second: 0 },
        eur_zero_override_preserved: true,
        eur_missing_price_preserved: true,
        ui: 'SEPARATE_ROOT_ACCEPTANCE',
        provider_operations: false,
        full_goal_complete: false,
      },
      null,
      2,
    ),
  );
  return { profiles: profiles.data.length, files: files.length, sample_count: 3 };
}
try {
  const health = (await api({}, '/health')).data;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '097_catalog_export_sources');
  assert.equal(health.restore_preview, false);
  const result = phase === 'setup' ? await setup(health) : await readback(health);
  process.stdout.write(JSON.stringify({ status: 'PASS', phase, ...result }) + '\n');
} catch (error) {
  // Never echo HTTP bodies, cookies, signup credentials or private state.
  process.stderr.write(
    `QA116 ${phase} failed; inspect the owned pending step and sanitized HTTP assertions.\n`,
  );
  throw error;
} finally {
  await pool.end();
}
