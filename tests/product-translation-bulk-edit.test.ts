import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { Problem } from '../server/errors';
import {
  createProductTranslationBulkEditPreviewInTx,
  executeProductTranslationBulkEditInTx,
  type ProductTranslationBulkEditActor,
} from '../server/product-translation-bulk-edit';
import {
  productTranslationBulkEditPreviewInput,
  productTranslationTexts,
} from '../server/product-translation-bulk-edit-schema';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  user = '',
  ip = 0;
const prefix = '/product-translation-bulk-edit';
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie },
    remoteAddress: '127.109.1.' + ip,
  });
async function ok(path: string, method: any = 'GET', payload?: any, status = 200) {
  const r = await req(path, method, payload);
  assert.equal(r.statusCode, status, method + ' ' + path);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw Error('Manual translation must not call providers');
    },
  });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ip++;
  tenant = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'QA109 main translations','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const tx = <T>(f: (c: PoolClient) => Promise<T>) => tenantTx(tenant, f);
async function products(n = 1) {
  const ids = Array.from({ length: n }, () => randomUUID());
  await tx((c) =>
    c.query(
      `INSERT INTO products(id,tenant_id,sku,name,description,price,vat,category,attributes) SELECT id,$1,'TR-'||id,'Source product','Source description',1234,23,'Source category','{"material":"cotton"}'::jsonb FROM unnest($2::uuid[])id`,
      [tenant, ids],
    ),
  );
  return ids;
}
const row = (id: string, locale = 'de', extra: any = {}) => ({
  product_id: id,
  product_version: 1,
  locale,
  translation_version: null,
  operation: 'set',
  patch: { name: 'Localized ' + locale, description: 'Description ' + locale },
  ...extra,
});
async function preview(rows: any[], locales = ['de'], key = randomUUID()) {
  return ok(prefix + '/previews', 'POST', { client_key: key, locales, rows }, 201);
}
async function execute(p: any, extra: any = {}, key = randomUUID()) {
  return ok(
    prefix + '/previews/' + p.id + '/execute',
    'POST',
    {
      client_key: key,
      scope_hash: p.scope_hash,
      confirmed: true,
      ack_missing_translations: false,
      ...extra,
    },
    201,
  );
}
async function allRows(id: string, execution = false) {
  const data: any[] = [];
  let cursor: string | null = null;
  do {
    const page = await ok(
      prefix +
        (execution ? '/executions/' : '/previews/') +
        id +
        '/rows' +
        (cursor ? '?cursor=' + cursor : ''),
    );
    assert(page.data.length <= 50);
    data.push(...page.data);
    cursor = page.meta.cursor;
  } while (cursor);
  return data;
}
async function business() {
  return tx(async (c) => ({
    products: (await c.query('SELECT * FROM products ORDER BY id')).rows,
    translations: (await c.query('SELECT * FROM product_translations ORDER BY product_id,locale'))
      .rows,
    jobs: (await c.query('SELECT * FROM jobs ORDER BY id')).rows,
    events: (await c.query('SELECT * FROM order_events ORDER BY id')).rows,
  }));
}

const inTxActor = (): ProductTranslationBulkEditActor => ({
  tenantId: tenant,
  userId: user,
  role: 'admin',
});
const inTxTables = [
  'products',
  'product_translations',
  'product_translation_bulk_edit_previews',
  'product_translation_bulk_edit_rows',
  'product_translation_bulk_edit_executions',
  'product_translation_bulk_edit_execution_rows',
  'audit_events',
  'jobs',
  'order_events',
  'product_rule_causes',
  'product_rule_runs',
  'product_rule_items',
] as const;
async function inTxSnapshot(tenantId = tenant) {
  return tenantTx(tenantId, async (c) => {
    const snapshot: Record<string, unknown[]> = {};
    for (const table of inTxTables)
      snapshot[table] = (await c.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY 1`)).rows;
    return snapshot;
  });
}
const inTxConsent = (p: { scope_hash: string }, client_key = randomUUID()) => ({
  client_key,
  scope_hash: p.scope_hash,
  confirmed: true as const,
  ack_missing_translations: false,
});

test('InTx preview belongs to the caller transaction and a later adapter error removes all evidence', async () => {
  const [id] = await products();
  const input = productTranslationBulkEditPreviewInput.parse({
    client_key: randomUUID(),
    locales: ['de'],
    rows: [row(id)],
  });
  const before = await inTxSnapshot();
  const failure = new Error('Outer preview adapter refused its own result');
  await assert.rejects(
    tx(async (c) => {
      const result = await createProductTranslationBulkEditPreviewInTx(c, inTxActor(), input);
      assert.equal(result.reused, false);
      assert.equal(result.preview.total, 1);
      assert.equal(
        (await c.query('SELECT id FROM product_translation_bulk_edit_previews')).rowCount,
        1,
      );
      assert.equal(
        (await c.query('SELECT receipt_id FROM product_translation_bulk_edit_rows')).rowCount,
        1,
      );
      assert.equal(
        (await c.query("SELECT id FROM audit_events WHERE action='translation.bulk.preview'"))
          .rowCount,
        1,
      );
      throw failure;
    }),
    (e) => e === failure,
  );
  assert.deepEqual(await inTxSnapshot(), before);
  const retried = await ok(prefix + '/previews', 'POST', input, 201);
  assert.equal(retried.reused, false);
});

test('InTx deferred execution rolls back translations, versions, manual receipts and real rule events on outer failure', async () => {
  const [id] = await products();
  await ok('/product-rules', 'POST', {
    client_key: randomUUID(),
    confirm_future_changes: true,
    definition: {
      name: 'InTx genuine translation event',
      event: 'product.updated',
      enabled: true,
      conditions: [],
      actions: [{ type: 'set_category', category: 'Future classification' }],
    },
  });
  const p = (await preview([row(id, 'de'), row(id, 'fr')], ['de', 'fr'])).preview;
  const input = inTxConsent(p);
  const before = await inTxSnapshot();
  const failure = new Error('Outer execution adapter rejected downstream evidence');
  await assert.rejects(
    tx(async (c) => {
      await c.query('SET CONSTRAINTS ALL DEFERRED');
      const result = await executeProductTranslationBulkEditInTx(
        c,
        inTxActor(),
        p.id,
        input,
        'manual',
        {
          deferConstraintFinalization: true,
        },
      );
      assert.equal(result.execution.changed_pairs, 2);
      assert.equal(
        (await c.query('SELECT version FROM products WHERE id=$1', [id])).rows[0].version,
        2,
      );
      const translations = (
        await c.query('SELECT manual_receipt_id FROM product_translations ORDER BY locale')
      ).rows;
      assert.equal(translations.length, 2);
      assert(translations.every((r) => r.manual_receipt_id));
      assert.equal(
        (await c.query('SELECT id FROM product_translation_bulk_edit_execution_rows')).rowCount,
        2,
      );
      assert.equal((await c.query('SELECT cause_id FROM product_rule_causes')).rowCount, 1);
      assert.equal((await c.query("SELECT id FROM jobs WHERE kind='product.rules'")).rowCount, 1);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      throw failure;
    }),
    (e) => e === failure,
  );
  assert.deepEqual(await inTxSnapshot(), before);
  const retried = await ok(prefix + '/previews/' + p.id + '/execute', 'POST', input, 201);
  assert.equal(retried.reused, false);
});

test('InTx default and deferred outer success persist genuine manual receipts and inert public replay', async () => {
  for (const deferred of [false, true]) {
    const [id] = await products();
    const input = productTranslationBulkEditPreviewInput.parse({
      client_key: randomUUID(),
      locales: ['de', 'fr'],
      rows: [row(id, 'de'), row(id, 'fr')],
    });
    const result = await tx(async (c) => {
      if (deferred) await c.query('SET CONSTRAINTS ALL DEFERRED');
      const options = { deferConstraintFinalization: deferred };
      const p = await createProductTranslationBulkEditPreviewInTx(
        c,
        inTxActor(),
        input,
        'manual',
        options,
      );
      const consent = inTxConsent(p.preview);
      const e = await executeProductTranslationBulkEditInTx(
        c,
        inTxActor(),
        p.preview.id,
        consent,
        'manual',
        options,
      );
      if (deferred) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      return { preview: p.preview, execution: e.execution, consent };
    });
    const receipts = await allRows(result.execution.id, true);
    assert.equal(receipts.length, 2);
    const translations = await tx((c) =>
      c.query('SELECT * FROM product_translations WHERE product_id=$1 ORDER BY locale', [id]),
    );
    assert.equal(translations.rows.length, 2);
    assert(
      translations.rows.every(
        (r) => r.version === 1 && r.ai_draft_id === null && r.deepl_draft_id === null,
      ),
    );
    assert.deepEqual(
      translations.rows.map((r) => r.manual_receipt_id).sort(),
      receipts.map((r) => r.id).sort(),
    );
    assert.equal(
      (await tx((c) => c.query('SELECT version FROM products WHERE id=$1', [id]))).rows[0].version,
      2,
    );
    const before = await inTxSnapshot();
    const previewReplay = await ok(prefix + '/previews', 'POST', input);
    const executionReplay = await ok(
      prefix + '/previews/' + result.preview.id + '/execute',
      'POST',
      result.consent,
    );
    assert.equal(previewReplay.reused, true);
    assert.equal(previewReplay.preview.id, result.preview.id);
    assert.equal(executionReplay.reused, true);
    assert.equal(executionReplay.execution.id, result.execution.id);
    assert.deepEqual(await inTxSnapshot(), before);
  }
});

test('InTx rejects actor tenant mismatch before fresh writes or matching foreign transaction replay', async () => {
  const [id] = await products();
  const input = productTranslationBulkEditPreviewInput.parse({
    client_key: randomUUID(),
    locales: ['de'],
    rows: [row(id)],
  });
  const p = (await ok(prefix + '/previews', 'POST', input, 201)).preview;
  const consent = inTxConsent(p);
  await ok(prefix + '/previews/' + p.id + '/execute', 'POST', consent, 201);
  const otherTenant = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'InTx actor tenant A','enterprise')",
    [otherTenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    otherTenant,
    user,
  ]);
  const actorA: ProductTranslationBulkEditActor = {
    tenantId: otherTenant,
    userId: user,
    role: 'admin',
  };
  const beforeB = await inTxSnapshot();
  const beforeA = await inTxSnapshot(otherTenant);
  const denied = (e: unknown) => e instanceof Problem && e.status === 403;
  await assert.rejects(
    tx((c) =>
      createProductTranslationBulkEditPreviewInTx(c, actorA, {
        ...input,
        client_key: randomUUID(),
      }),
    ),
    denied,
  );
  // Request hashes contain the same actor ID/body, so these are genuine replay
  // candidates inside B's RLS scope; only the transaction/actor guard denies them.
  await assert.rejects(
    tx((c) => createProductTranslationBulkEditPreviewInTx(c, actorA, input)),
    denied,
  );
  await assert.rejects(
    tx((c) => executeProductTranslationBulkEditInTx(c, actorA, p.id, consent)),
    denied,
  );
  assert.deepEqual(await inTxSnapshot(), beforeB);
  assert.deepEqual(await inTxSnapshot(otherTenant), beforeA);
});

test('strict complete matrix and Unicode codepoint bounds without normalization', () => {
  assert(
    productTranslationTexts.safeParse({ name: '😀'.repeat(200), description: '😀'.repeat(10000) })
      .success,
  );
  assert(!productTranslationTexts.safeParse({ name: '😀'.repeat(201), description: '' }).success);
  assert(!productTranslationTexts.safeParse({ name: 'aa\n', description: '' }).success);
  assert(!productTranslationTexts.safeParse({ name: 'aa', description: '<html>' }).success);
  assert(!productTranslationTexts.safeParse({ name: '\ud800x', description: '' }).success);
  assert.deepEqual(productTranslationTexts.parse({ name: '  Valid  ', description: '\t\n' }), {
    name: '  Valid  ',
    description: '\t\n',
  });
  const id = randomUUID();
  assert(
    !productTranslationBulkEditPreviewInput.safeParse({
      client_key: randomUUID(),
      locales: ['de', 'fr'],
      rows: [row(id)],
    }).success,
  );
  assert(
    !productTranslationBulkEditPreviewInput.safeParse({
      client_key: randomUUID(),
      locales: ['DE', 'de'],
      rows: [row(id), row(id)],
    }).success,
  );
  assert(
    !productTranslationBulkEditPreviewInput.safeParse({
      client_key: randomUUID(),
      locales: ['de'],
      rows: [row(id, 'de', { product_version: 2147483648 })],
    }).success,
  );
});

test('three locales apply once per product, partial changes preserve other text and explicit empty clears', async () => {
  const [id] = await products(),
    languages = ['de', 'fr', 'es'];
  const p = (
    await preview(
      languages.map((l) => row(id, l)),
      languages,
    )
  ).preview;
  assert.equal(p.changed_products, 1);
  assert.equal(p.changed_pairs, 3);
  await execute(p);
  let t = await tx((c) => c.query('SELECT * FROM product_translations ORDER BY locale'));
  assert.equal(t.rows.length, 3);
  assert(
    t.rows.every(
      (r: any) => r.version === 1 && r.manual_receipt_id && !r.ai_draft_id && !r.deepl_draft_id,
    ),
  );
  const rows = languages.map((l) =>
    row(id, l, {
      product_version: 2,
      translation_version: 1,
      operation: l === 'de' ? 'set' : 'none',
      ...(l === 'de' ? { patch: { description: '' } } : {}),
    }),
  );
  for (const r of rows) if (r.operation === 'none') delete r.patch;
  const q = (await preview(rows, languages)).preview;
  assert.equal(q.changed_pairs, 1);
  await execute(q);
  t = await tx((c) => c.query('SELECT * FROM product_translations ORDER BY locale'));
  assert.equal(t.rows[0].name, 'Localized de');
  assert.equal(t.rows[0].description, '');
  assert.equal(t.rows[0].version, 2);
  assert.equal(t.rows[1].description, 'Description es');
  const product = (await tx((c) => c.query('SELECT * FROM products WHERE id=$1', [id]))).rows[0];
  assert.equal(product.version, 3);
  assert.equal(product.price, 1234);
  assert.equal(product.name, 'Source product');
  assert.deepEqual(product.attributes, { material: 'cotton' });
});

test('physical remove requires separate missing consent, retains proof, and recreate starts at1 behind product ABA fence', async () => {
  const [id] = await products();
  const first = (await preview([row(id)])).preview;
  await execute(first);
  const stale = (
    await preview([
      row(id, 'de', {
        product_version: 2,
        translation_version: 1,
        patch: { description: 'Earlier plan' },
      }),
    ])
  ).preview;
  const remove = (
    await preview([
      {
        product_id: id,
        product_version: 2,
        translation_version: 1,
        locale: 'de',
        operation: 'remove',
      },
    ])
  ).preview;
  const before = await business();
  assert.equal(
    (
      await req(prefix + '/previews/' + remove.id + '/execute', 'POST', {
        client_key: randomUUID(),
        scope_hash: remove.scope_hash,
        confirmed: true,
      })
    ).statusCode,
    422,
  );
  assert.deepEqual(await business(), before);
  await execute(remove, { ack_missing_translations: true });
  assert.equal((await tx((c) => c.query('SELECT * FROM product_translations'))).rows.length, 0);
  const recreate = (await preview([row(id, 'de', { product_version: 3 })])).preview;
  await execute(recreate);
  const live = (await tx((c) => c.query('SELECT * FROM product_translations'))).rows[0];
  assert.equal(live.version, 1);
  assert.equal(
    (await tx((c) => c.query('SELECT version FROM products WHERE id=$1', [id]))).rows[0].version,
    4,
  );
  assert.equal(
    (
      await req(prefix + '/previews/' + stale.id + '/execute', 'POST', {
        client_key: randomUUID(),
        scope_hash: stale.scope_hash,
        confirmed: true,
        ack_missing_translations: true,
      })
    ).statusCode,
    409,
  );
  assert.equal((await allRows(first.id)).length, 1);
  assert.equal((await ok(prefix + '/executions')).data.length, 3);
});

test('identical texts and absent none preserve versions, receipt and timestamp with no jobs', async () => {
  const [id] = await products();
  await execute((await preview([row(id)])).preview);
  const prior = (await tx((c) => c.query('SELECT * FROM product_translations'))).rows[0];
  const p = (
    await preview(
      [
        row(id, 'de', { product_version: 2, translation_version: 1 }),
        {
          product_id: id,
          product_version: 2,
          locale: 'fr',
          translation_version: null,
          operation: 'none',
        },
      ],
      ['de', 'fr'],
    )
  ).preview;
  assert.equal(p.changed_pairs, 0);
  assert.equal(p.missing_after_count, 1);
  const e = (await execute(p, { ack_missing_translations: true })).execution;
  assert.equal(e.changed_products, 0);
  assert.deepEqual((await tx((c) => c.query('SELECT * FROM product_translations'))).rows[0], prior);
  assert.equal(
    (await tx((c) => c.query('SELECT version FROM products WHERE id=$1', [id]))).rows[0].version,
    2,
  );
  assert.equal((await tx((c) => c.query('SELECT id FROM jobs'))).rowCount, 0);
});

test('invalid cell and stale product reject whole multilingual plan without partial writes', async () => {
  const ids = await products(2);
  const p = (
    await preview([
      row(ids[0]),
      row(ids[1], 'de', { patch: { description: 'Creation needs name' } }),
    ])
  ).preview;
  assert.equal(p.ready, false);
  assert.equal(p.invalid, 1);
  const before = await business();
  assert.equal(
    (
      await req(prefix + '/previews/' + p.id + '/execute', 'POST', {
        client_key: randomUUID(),
        scope_hash: p.scope_hash,
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await business(), before);
  const q = (await preview(ids.map((id) => row(id)))).preview;
  await tx((c) =>
    c.query('UPDATE products SET price=price+1,version=version+1 WHERE id=$1', [ids[1]]),
  );
  const changed = await business();
  assert.equal(
    (
      await req(prefix + '/previews/' + q.id + '/execute', 'POST', {
        client_key: randomUUID(),
        scope_hash: q.scope_hash,
        confirmed: true,
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await business(), changed);
});

test('canonical nested replay, normalized locale, completed receipt replay after later mutation', async () => {
  const [id] = await products(),
    client_key = randomUUID();
  const body = {
    client_key,
    locales: ['DE'],
    rows: [row(id, 'DE', { patch: { description: 'Replay', name: 'Canonical' } })],
  };
  const p = (await ok(prefix + '/previews', 'POST', body, 201)).preview;
  const reuse = await ok(prefix + '/previews', 'POST', {
    rows: [{ ...row(id, 'de'), patch: { name: 'Canonical', description: 'Replay' } }],
    locales: ['de'],
    client_key,
  });
  assert.equal(reuse.reused, true);
  assert.equal(reuse.preview.id, p.id);
  const key = randomUUID(),
    input = {
      client_key: key,
      scope_hash: p.scope_hash,
      confirmed: true,
      ack_missing_translations: false,
    };
  const e = await ok(prefix + '/previews/' + p.id + '/execute', 'POST', input, 201);
  await tx((c) => c.query('UPDATE products SET price=price+1,version=version+1 WHERE id=$1', [id]));
  const before = await business(),
    again = await ok(prefix + '/previews/' + p.id + '/execute', 'POST', input);
  assert.equal(again.execution.id, e.execution.id);
  assert.equal(again.reused, true);
  assert.deepEqual(await business(), before);
  assert.equal(
    (
      await req(prefix + '/previews/' + p.id + '/execute', 'POST', {
        ...input,
        ack_missing_translations: true,
      })
    ).statusCode,
    409,
  );
});

test('bounded source prevents oversized frozen preview, request bytes reject before durable evidence', async () => {
  const ids = await products(500);
  await tx((c) => c.query("UPDATE products SET description=repeat('x',4000)"));
  const languages = ['de', 'fr', 'es', 'it', 'cs', 'sk'];
  const none = ids.flatMap((id) =>
    languages.map((locale) => ({
      product_id: id,
      product_version: 1,
      translation_version: null,
      locale,
      operation: 'none',
    })),
  );
  assert.equal(
    (
      await req(prefix + '/previews', 'POST', {
        client_key: randomUUID(),
        locales: languages,
        rows: none,
      })
    ).statusCode,
    413,
  );
  assert.equal(
    (await tx((c) => c.query('SELECT id FROM product_translation_bulk_edit_previews'))).rowCount,
    0,
  );
  const oversized = {
    client_key: randomUUID(),
    locales: ['de'],
    rows: [row(ids[0], 'de', { patch: { name: 'xx', description: 'x'.repeat(2097152) } })],
  };
  assert.equal((await req(prefix + '/previews', 'POST', oversized)).statusCode, 413);
  assert.equal(
    (await tx((c) => c.query('SELECT receipt_id FROM product_translation_bulk_edit_rows')))
      .rowCount,
    0,
  );
});

test('500products ×6locales produce3000 atomic manual receipts and all60 pages without truncation', async () => {
  const ids = await products(500),
    languages = ['de', 'fr', 'es', 'it', 'cs', 'sk'],
    rows = ids.flatMap((id) => languages.map((l) => row(id, l)));
  const p = (await preview(rows, languages)).preview;
  assert.equal(p.total, 3000);
  assert.equal(p.product_count, 500);
  assert.equal(p.changed_pairs, 3000);
  const frozen = await allRows(p.id);
  assert.equal(frozen.length, 3000);
  assert.equal(new Set(frozen.map((r) => r.product_id + ':' + r.locale)).size, 3000);
  const e = (await execute(p)).execution;
  assert.equal(e.total, 3000);
  assert.equal(e.changed_products, 500);
  const actual = await allRows(e.id, true);
  assert.equal(actual.length, 3000);
  assert.deepEqual(
    actual.map((r) => r.id),
    frozen.map((r) => r.receipt_id),
  );
  assert(
    actual.every(
      (r) =>
        r.after_product_version === 2 && r.before_product_version === 1 && r.after.version === 1,
    ),
  );
  const t = await tx((c) =>
    c.query(
      'SELECT count(*)::int n,count(DISTINCT manual_receipt_id)::int receipts FROM product_translations',
    ),
  );
  assert.deepEqual(t.rows[0], { n: 3000, receipts: 3000 });
  assert.equal(
    (await tx((c) => c.query('SELECT count(*)::int n FROM products WHERE version=2'))).rows[0].n,
    500,
  );
  const selection = await ok(
    prefix + '/selection?ids=' + ids.slice(0, 50).join(',') + '&locales=' + languages.join(','),
  );
  assert.equal(selection.meta.total, 300);
  assert.equal(selection.data.length, 50);
  assert(selection.meta.cursor);
  const metadata = await ok(prefix);
  assert.deepEqual(metadata.locales, [...languages].sort());
  assert.equal(metadata.limits.max_rows, 3000);
});
