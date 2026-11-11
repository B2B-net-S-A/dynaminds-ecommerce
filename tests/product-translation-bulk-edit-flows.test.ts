import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { applyAi } from '../server/catalog-ai';
import { applyDeepL, binding } from '../server/deepl-catalog';
import { applyBatchProduct } from '../server/deepl-batches';
import { encrypt } from '../server/security';
import { SHOPIFY_VERSION } from '../server/shopify';
import { processTranslation, failTranslation } from '../server/shopify-translations';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  warehouse = '',
  user = '',
  ip = 1,
  sequence = 1090000,
  mode = '';
const prefix = '/product-translation-bulk-edit';
const variants = new Map<string, any>(),
  resources = new Map<string, any>(),
  calls: { op: string; variables: any }[] = [];
const json = (data: any) =>
  new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'X-Shopify-API-Version': SHOPIFY_VERSION },
  });
// Controlled GraphQL transport only. Any unrelated provider/inference call fails.
const transport = async (url: string, init: RequestInit) => {
  const b = JSON.parse(String(init.body)),
    op = b.query.match(/^(?:query|mutation) (\w+)/)?.[1];
  calls.push({ op, variables: b.variables });
  const shop = { id: 'gid://shopify/Shop/109', myshopifyDomain: new URL(url).hostname };
  if (op === 'DynaOffer' || op === 'DynaTranslationProductIdentity') {
    const v = variants.get(b.variables.id ?? b.variables.variantId);
    return json({
      shop,
      productVariant: { id: v.id, sku: v.sku, product: { id: v.productId, status: 'ACTIVE' } },
    });
  }
  if (op === 'DynaProductTranslation' || op === 'DynaProductTranslationEvidence') {
    const v = variants.get(b.variables.variantId),
      r = resources.get(b.variables.resourceId);
    assert(r);
    return json({
      shop,
      currentAppInstallation: {
        accessScopes: ['read_products', 'write_translations', 'read_locales'].map((handle) => ({
          handle,
        })),
      },
      shopLocales: [
        { locale: 'pl', name: 'Polski', primary: true, published: true },
        { locale: 'de', name: 'Deutsch', primary: false, published: true },
      ],
      ...(op === 'DynaProductTranslation'
        ? { productVariant: v ? { id: v.id, sku: v.sku, product: { id: v.productId } } : null }
        : {}),
      translatableResource: {
        resourceId: b.variables.resourceId,
        translatableContent: r.source,
        translations: r.translations.filter((t: any) => t.locale === b.variables.locale),
      },
    });
  }
  if (op === 'DynaProductTranslationRegister') {
    const r = resources.get(b.variables.resourceId);
    assert(r);
    for (const f of b.variables.translations) {
      r.translations = r.translations.filter(
        (t: any) => !(t.key === f.key && t.locale === f.locale && t.market === null),
      );
      r.translations.push({
        key: f.key,
        locale: f.locale,
        value: f.value,
        outdated: false,
        updatedAt: new Date().toISOString(),
        market: null,
      });
    }
    if (mode === 'lost') throw Error('Controlled lost response after one remote mutation');
    return json({
      translationsRegister: {
        translations: b.variables.translations.map((f: any) =>
          r.translations.find(
            (t: any) => t.key === f.key && t.locale === f.locale && t.market === null,
          ),
        ),
        userErrors: [],
      },
    });
  }
  throw Error('Unexpected provider operation ' + op);
};
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie },
    remoteAddress: '127.1.109.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await req(path, method, body);
  assert(r.statusCode < 300, method + ' ' + path + ' HTTP ' + r.statusCode);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  tenant = randomUUID();
  warehouse = randomUUID();
  mode = '';
  calls.length = 0;
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Translation flow','enterprise')", [
    tenant,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Translation warehouse','TF')",
    [warehouse, tenant],
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const actor = () => ({ tenantId: tenant, userId: user, role: 'admin' as const });
async function product(extra: any = {}) {
  return ok('/products', 'POST', {
    sku: 'TF-' + randomUUID(),
    name: 'Stainless mug',
    description: 'Steel. Capacity 350 ml.',
    price: 2500,
    quantity: 20,
    warehouse_id: warehouse,
    weight_grams: 350,
    manufacturer: 'Frozen manufacturer',
    ...extra,
  });
}
const current = (id: string) => ok('/products/' + id);
async function translation(p: any, locale = 'de') {
  return (
    await pool.query(
      'SELECT * FROM product_translations WHERE tenant_id=$1 AND product_id=$2 AND locale=$3',
      [tenant, p.id, locale],
    )
  ).rows[0];
}
async function preview(p: any, operations: { locale: string; operation: string; patch?: any }[]) {
  const rows = [];
  for (const op of operations) {
    const t = await translation(p, op.locale);
    rows.push({
      product_id: p.id,
      product_version: p.version,
      translation_version: t?.version ?? null,
      ...op,
    });
  }
  const made = await ok(prefix + '/previews', 'POST', {
    client_key: randomUUID(),
    locales: operations.map((o) => o.locale),
    rows,
  });
  assert.equal(made.preview.ready, true);
  return made.preview;
}
const consent = (plan: any) => ({
  client_key: randomUUID(),
  scope_hash: plan.scope_hash,
  confirmed: true,
  ack_missing_translations: plan.missing_after_count > 0,
});
async function execute(plan: any, body = consent(plan)) {
  return ok(prefix + '/previews/' + plan.id + '/execute', 'POST', body);
}
async function manual(
  p: any,
  locales = ['de'],
  patch: any = { name: 'Manueller Becher', description: 'Manuell geprüfter Beschreibungstext.' },
) {
  const plan = await preview(
    p,
    locales.map((locale) => ({ locale, operation: 'set', patch })),
  );
  await execute(plan);
  return current(p.id);
}
const protectedTables = [
  'product_logistics',
  'product_sku_aliases',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'stock_location_operations',
  'orders',
  'order_items',
  'order_events',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'bundle_components',
  'listings',
  'offer_plans',
  'price_lists',
  'price_list_items',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
async function snapshot(tables = protectedTables) {
  const out: Record<string, unknown> = {};
  for (const t of tables)
    out[t] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=$1 ORDER BY 1`, [tenant])
    ).rows;
  out.baseProducts = (
    await pool.query(
      "SELECT to_jsonb(p)-'version' row FROM products p WHERE tenant_id=$1 ORDER BY 1",
      [tenant],
    )
  ).rows;
  return out;
}
const reviewed = { name: 'Provider reviewed name', description: 'Provider reviewed description' };
type Provider = 'AI' | 'DeepL' | 'DeepL batch';
// Completed generation fixtures are controlled, own-tenant rows. Positive real apply
// controls prove that stale tests exercise the writable branches, not fake transports.
async function ready(p: any, source: Provider) {
  const original = { name: p.name, description: p.description };
  if (source === 'AI') {
    const id = randomUUID(),
      job = randomUUID();
    await pool.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,state,dedup_key) VALUES($1,$2,'catalog.ai',$3,'done',$4)",
      [job, tenant, JSON.stringify({ draft_id: id }), job],
    );
    await pool.query(
      "INSERT INTO ai_catalog_drafts(id,tenant_id,product_id,actor_id,client_key,request_hash,source_version,source,destination,locale,model,model_digest,state,output,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'translation','de','controlled-local',$9,'ready',$10,$11)",
      [
        id,
        tenant,
        p.id,
        user,
        randomUUID(),
        'a'.repeat(64),
        p.version,
        JSON.stringify(original),
        'b'.repeat(64),
        JSON.stringify(reviewed),
        job,
      ],
    );
    return { source, product: p, drafts: [id], batch: undefined };
  }
  const channel = (
    await pool.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,'deepl','Controlled completed translation','sandbox',$3,$4,'simulation') RETURNING *",
      [
        randomUUID(),
        tenant,
        encrypt({ api_key: 'controlled-fixture:fx' }),
        JSON.stringify({ api_plan: 'free', simulation: true }),
      ],
    )
  ).rows[0];
  const locales = source === 'DeepL batch' ? ['de', 'en'] : ['de'],
    batch = source === 'DeepL batch' ? randomUUID() : undefined;
  if (batch)
    await pool.query(
      "INSERT INTO deepl_catalog_batches(id,tenant_id,actor_id,channel_id,client_key,request_hash,connection_hash,source_lang,target_langs,formality,product_count,draft_count,characters,simulation,state) VALUES($1,$2,$3,$4,$5,$6,$7,'pl',$8,'default',1,2,100,true,'finished')",
      [
        batch,
        tenant,
        user,
        channel.id,
        randomUUID(),
        'c'.repeat(64),
        binding(channel),
        JSON.stringify(locales),
      ],
    );
  const drafts = [];
  for (const [i, locale] of locales.entries()) {
    const id = randomUUID();
    drafts.push(id);
    await pool.query(
      "INSERT INTO deepl_catalog_drafts(id,tenant_id,product_id,channel_id,actor_id,client_key,request_hash,connection_hash,source_version,source,source_lang,target_lang,formality,characters,simulation,state,output,batch_id,batch_ordinal,batch_sku) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pl',$11,'default',50,true,'ready',$12,$13,$14,$15)",
      [
        id,
        tenant,
        p.id,
        channel.id,
        user,
        randomUUID(),
        'd'.repeat(64),
        binding(channel),
        p.version,
        JSON.stringify(original),
        locale,
        JSON.stringify(reviewed),
        batch ?? null,
        batch ? i : null,
        batch ? p.sku : null,
      ],
    );
  }
  return { source, product: p, drafts, batch };
}
const applyProvider = (f: Awaited<ReturnType<typeof ready>>) =>
  f.source === 'AI'
    ? applyAi(actor(), f.drafts[0], { approve: true, version: f.product.version, ...reviewed })
    : f.source === 'DeepL'
      ? applyDeepL(actor(), f.drafts[0], { approve: true, version: f.product.version, ...reviewed })
      : applyBatchProduct(actor(), f.batch!, f.product.id, {
          approve: true,
          version: f.product.version,
          texts: f.drafts.map((draft_id) => ({ draft_id, ...reviewed })),
        });

test(
  'AI, DeepL single and batch replace manual provenance only through a fresh real apply; old applied replay never restores provider text',
  { timeout: 20000 },
  async () => {
    for (const source of ['AI', 'DeepL', 'DeepL batch'] as Provider[]) {
      let p = await product();
      p = await manual(p, ['de', 'en']);
      const receipt = (await translation(p)).manual_receipt_id,
        protectedBefore = await snapshot(),
        f = await ready(p, source);
      await applyProvider(f);
      p = await current(p.id);
      let t = await translation(p);
      assert.equal(t.manual_receipt_id, null);
      assert.equal(t.name, reviewed.name);
      assert.equal(Boolean(t.ai_draft_id), source === 'AI');
      assert.equal(Boolean(t.deepl_draft_id), source !== 'AI');
      if (source === 'DeepL batch')
        assert.equal((await translation(p, 'en')).manual_receipt_id, null);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM product_translation_bulk_edit_execution_rows WHERE id=$1',
            [receipt],
          )
        ).rows[0].n,
        1,
      );
      assert.deepEqual(await snapshot(), protectedBefore);
      p = await manual(p, ['de'], {
        name: 'New manual authority',
        description: 'Provider receipt stays historical.',
      });
      const before = await snapshot([
        'product_translations',
        'ai_catalog_drafts',
        'deepl_catalog_drafts',
        'product_translation_bulk_edit_executions',
        'product_translation_bulk_edit_execution_rows',
        'jobs',
        'audit_events',
      ]);
      assert.equal((await applyProvider(f)).reused, true);
      assert.deepEqual(
        await snapshot([
          'product_translations',
          'ai_catalog_drafts',
          'deepl_catalog_drafts',
          'product_translation_bulk_edit_executions',
          'product_translation_bulk_edit_execution_rows',
          'jobs',
          'audit_events',
        ]),
        before,
      );
      t = await translation(p);
      assert.equal(t.name, 'New manual authority');
      assert(t.manual_receipt_id);
    }
    assert.equal(calls.length, 0);
  },
);
test(
  'ready provider drafts lose their source CAS after manual writes and a mixed patch/remove/NOP preserves sales and all previous receipts',
  { timeout: 20000 },
  async () => {
    for (const source of ['AI', 'DeepL', 'DeepL batch'] as Provider[]) {
      let p = await product(),
        f = await ready(p, source);
      p = await manual(p, ['de', 'en']);
      const before = await snapshot([
        'product_translations',
        'products',
        'jobs',
        'audit_events',
        'ai_catalog_drafts',
        'deepl_catalog_drafts',
        ...protectedTables,
      ]);
      await assert.rejects(applyProvider(f), (e: any) => e.status === 409);
      assert.deepEqual(
        await snapshot([
          'product_translations',
          'products',
          'jobs',
          'audit_events',
          'ai_catalog_drafts',
          'deepl_catalog_drafts',
          ...protectedTables,
        ]),
        before,
      );
    }
    let p = await product();
    await ok('/orders', 'POST', {
      customer_name: 'Frozen translation sale',
      email: 'translation@example.test',
      warehouse_id: warehouse,
      payment_mode: 'cod',
      items: [{ product_id: p.id, quantity: 2 }],
    });
    p = await manual(p, ['de', 'en', 'fr']);
    const before = await snapshot(),
      old = await translation(p, 'en'),
      receipts = (
        await pool.query(
          'SELECT id FROM product_translation_bulk_edit_execution_rows WHERE tenant_id=$1 ORDER BY id',
          [tenant],
        )
      ).rows;
    const plan = await preview(p, [
      { locale: 'de', operation: 'set', patch: { description: '  First line\n\tSecond line  ' } },
      { locale: 'en', operation: 'none' },
      { locale: 'fr', operation: 'remove' },
    ]);
    assert.equal(plan.changed_pairs, 2);
    assert.equal(plan.changed_products, 1);
    assert.equal(plan.missing_after_count, 1);
    const noConsent = await req(prefix + '/previews/' + plan.id + '/execute', 'POST', {
      ...consent(plan),
      ack_missing_translations: false,
    });
    assert.equal(noConsent.statusCode, 422);
    assert.deepEqual(await snapshot(), before);
    const body = consent(plan);
    await execute(plan, body);
    const after = await current(p.id);
    assert.equal(after.version, p.version + 1);
    assert.equal((await translation(after, 'de')).description, '  First line\n\tSecond line  ');
    assert.deepEqual(await translation(after, 'en'), old);
    assert.equal(await translation(after, 'fr'), undefined);
    assert.deepEqual(await snapshot(), before);
    for (const receipt of receipts)
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM product_translation_bulk_edit_execution_rows WHERE id=$1',
            [receipt.id],
          )
        ).rows[0].n,
        1,
      );
    const saved = await snapshot([
      'product_translations',
      'jobs',
      'audit_events',
      'product_translation_bulk_edit_executions',
      'product_translation_bulk_edit_execution_rows',
    ]);
    assert.equal((await execute(plan, body)).reused, true);
    assert.deepEqual(
      await snapshot([
        'product_translations',
        'jobs',
        'audit_events',
        'product_translation_bulk_edit_executions',
        'product_translation_bulk_edit_execution_rows',
      ]),
      saved,
    );
    const noop = await preview(after, [
      { locale: 'de', operation: 'none' },
      { locale: 'en', operation: 'set', patch: { name: old.name, description: old.description } },
      { locale: 'fr', operation: 'remove' },
    ]);
    assert.equal(noop.changed_products, 0);
    const translations = (
      await pool.query(
        'SELECT * FROM product_translations WHERE tenant_id=$1 AND product_id=$2 ORDER BY locale',
        [tenant, p.id],
      )
    ).rows;
    await execute(noop);
    assert.equal((await current(p.id)).version, after.version);
    assert.deepEqual(
      (
        await pool.query(
          'SELECT * FROM product_translations WHERE tenant_id=$1 AND product_id=$2 ORDER BY locale',
          [tenant, p.id],
        )
      ).rows,
      translations,
    );
    assert.equal(calls.length, 0);
  },
);

async function shopifyFixture() {
  let p = await product();
  p = await manual(p);
  const ch = await ok('/integrations', 'POST', {
    provider: 'shopify',
    name: 'Controlled manual publication',
    mode: 'sandbox',
    settings: { store_url: 'https://manual-' + randomUUID() + '.myshopify.com' },
    credentials: { access_token: 'controlled-shopify-fixture-token' },
  });
  const id = 'gid://shopify/ProductVariant/' + ++sequence,
    resource = 'gid://shopify/Product/' + ++sequence;
  variants.set(id, { id, productId: resource, sku: p.sku });
  resources.set(resource, {
    source: [
      { key: 'title', value: p.name, digest: 'title-' + sequence, locale: 'pl' },
      {
        key: 'body_html',
        value: '<p>' + p.description + '</p>',
        digest: 'body-' + sequence,
        locale: 'pl',
      },
    ],
    translations: [],
  });
  const listing = await ok('/integrations/' + ch.id + '/mappings', 'POST', {
    external_id: id,
    sku: p.sku,
  });
  return { p, ch, listing, resource };
}
async function publication(f: Awaited<ReturnType<typeof shopifyFixture>>) {
  const t = await translation(f.p);
  return ok('/products/' + f.p.id + '/shopify-translations/preview', 'POST', {
    client_key: randomUUID(),
    listing_id: f.listing.id,
    version: f.p.version,
    local_locale: 'de',
    translation_version: t.version,
    target_locale: 'de',
    fields: ['title', 'body_html'],
  });
}
const queue = (p: any) =>
  ok('/shopify-translation-plans/' + p.id + '/queue', 'POST', {
    external_authorized: true,
    replace_existing: false,
    confirm_product_scope: true,
  });
const writes = () => calls.filter((c) => c.op === 'DynaProductTranslationRegister');
async function work(plan: any) {
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=(SELECT job_id FROM shopify_translation_plans WHERE id=$1) AND state='pending' RETURNING *",
      [plan.id, randomUUID()],
    )
  ).rows[0];
  assert(job);
  try {
    await processTranslation(job, { transport });
  } catch (e) {
    await failTranslation(job, e);
  }
  return (await pool.query('SELECT * FROM shopify_translation_plans WHERE id=$1', [plan.id]))
    .rows[0];
}
test(
  'manual receipt can preview Shopify but a later local write blocks an already queued fresh plan before any remote mutation',
  { timeout: 20000 },
  async () => {
    const f = await shopifyFixture(),
      plan = await publication(f);
    assert.equal(plan.local_snapshot.translation.version, 1);
    assert.equal(writes().length, 0);
    await queue(plan);
    f.p = await manual(f.p, ['de'], {
      name: 'Later manual text',
      description: 'New local version',
    });
    const before = await snapshot([
      'product_translations',
      'product_translation_bulk_edit_execution_rows',
    ]);
    const failed = await work(plan);
    assert.notEqual(failed.state, 'done');
    assert.equal(failed.phase, 'fresh');
    assert.equal(failed.attempted_at, null);
    assert.equal(writes().length, 0);
    assert.deepEqual(
      await snapshot(['product_translations', 'product_translation_bulk_edit_execution_rows']),
      before,
    );
  },
);
test(
  'lost Shopify response reconciles the immutable old manual spec after locale removal using GET only',
  { timeout: 20000 },
  async () => {
    const f = await shopifyFixture(),
      t = await translation(f.p),
      plan = await publication(f);
    await queue(plan);
    mode = 'lost';
    assert.equal((await work(plan)).state, 'uncertain');
    assert.equal(writes().length, 1);
    const removed = await preview(f.p, [{ locale: 'de', operation: 'remove' }]);
    await execute(removed);
    assert.equal(await translation(f.p), undefined);
    const before = await snapshot([
      'product_translations',
      'product_translation_bulk_edit_execution_rows',
    ]);
    const remote = JSON.stringify(resources.get(f.resource).translations);
    mode = '';
    const callCount = calls.length;
    const reconciled = await ok('/shopify-translation-plans/' + plan.id + '/reconcile', 'POST', {});
    assert.equal(reconciled.state, 'done');
    assert.equal(writes().length, 1);
    assert(calls.length > callCount);
    assert(calls.slice(callCount).every((c) => c.op !== 'DynaProductTranslationRegister'));
    assert.equal(JSON.stringify(resources.get(f.resource).translations), remote);
    assert.deepEqual(
      await snapshot(['product_translations', 'product_translation_bulk_edit_execution_rows']),
      before,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM product_translation_bulk_edit_execution_rows WHERE id=$1',
          [t.manual_receipt_id],
        )
      ).rows[0].n,
      1,
    );
  },
);
