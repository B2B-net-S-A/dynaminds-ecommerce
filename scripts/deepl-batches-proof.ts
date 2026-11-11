import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pool } from '../server/db';
const file = 'data/deepl-stage094.json',
  phase = process.argv[2];
const tables = [
  'channels',
  'products',
  'stock',
  'stock_movements',
  'orders',
  'order_items',
  'order_pick_items',
  'order_events',
  'reservations',
  'shipments',
  'documents',
  'return_cases',
  'return_items',
  'payment_entries',
  'warehouses',
  'memberships',
  'workspace_usage',
  'workspace_invitations',
  'order_status_configs',
  'order_status_plans',
  'order_status_simulations',
  'workspace_billing_accounts',
  'workspace_billing_previews',
  'workspace_billing_entries',
  'ai_catalog_drafts',
  'product_translations',
  'deepl_catalog_drafts',
];
async function snapshot(ids: string[]) {
  const s: any = {};
  for (const t of tables)
    s[t] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [ids],
      )
    ).rows;
  s.tenants = (
    await pool.query('SELECT to_jsonb(t) row FROM tenants t WHERE id=ANY($1::uuid[]) ORDER BY 1', [
      ids,
    ])
  ).rows;
  return s;
}
let cookie = '';
async function api(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, status, path);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return (await r.json()) as any;
}
async function preserve(s: any) {
  const now = await snapshot(s.ids),
    scheduler = [];
  for (const t of Object.keys(s.before)) {
    if (t === 'deepl_catalog_drafts') {
      for (const r of now[t]) {
        assert.equal(r.row.batch_id, null);
        assert.equal(r.row.batch_ordinal, null);
        assert.equal(r.row.batch_sku, null);
        delete r.row.batch_id;
        delete r.row.batch_ordinal;
        delete r.row.batch_sku;
      }
    }
    if (t !== 'order_status_configs') {
      assert(isDeepStrictEqual(now[t], s.before[t]), 'Previous firms ' + t);
      continue;
    }
    assert.equal(now[t].length, s.before[t].length);
    for (const oldRow of s.before[t]) {
      const old: any = oldRow.row,
        cur: any = now[t].find((x: any) => x.row.channel_id === old.channel_id)?.row;
      assert(cur);
      const strip = (r: any) =>
        Object.fromEntries(
          Object.entries(r).filter(
            ([k]) => !['last_job_id', 'last_run_at', 'next_run_at'].includes(k),
          ),
        );
      assert(isDeepStrictEqual(strip(cur), strip(old)));
      if (!isDeepStrictEqual(cur, old)) {
        assert(
          ['728d4b12-8a88-4125-95c0-308e3bef3798', 'fd17a7f8-b7ba-49f8-b65a-52e5050d2181'].includes(
            old.channel_id,
          ),
        );
        const ch = s.before.channels.find((x: any) => x.row.id === old.channel_id)?.row;
        assert(ch.settings.simulation && old.enabled);
        const j = (
          await pool.query('SELECT tenant_id,kind,payload FROM jobs WHERE id=$1', [cur.last_job_id])
        ).rows[0];
        assert.equal(j.tenant_id, old.tenant_id);
        assert.equal(j.kind, 'order.status.scan');
        assert.equal(j.payload.channel_id, old.channel_id);
        assert.equal(j.payload.version, old.version);
        scheduler.push({
          channel: old.channel_id,
          fields: ['last_job_id', 'last_run_at', 'next_run_at'],
        });
      }
    }
  }
  assert(
    isDeepStrictEqual(
      (
        await pool.query(
          'SELECT id,email,password_hash,name FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
          [s.accounts.map((u: any) => u.id)],
        )
      ).rows,
      s.accounts,
    ),
  );
  return {
    prior_firms: s.ids.length,
    prior_accounts: s.accounts.length,
    tables: tables.length,
    scheduler,
  };
}
try {
  if (phase === 'baseline') {
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      accounts = (await pool.query('SELECT id,email,password_hash,name FROM users ORDER BY id'))
        .rows;
    await writeFile(
      file,
      JSON.stringify(
        { ids, accounts, before: await snapshot(ids), baseline_at: new Date().toISOString() },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
    );
    console.log({ prior_firms: ids.length, prior_accounts: accounts.length });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8')),
      save = () => writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    if (phase === 'setup') {
      assert(!s.tenant);
      s.email = 'qa-deepl-094@demo.local';
      s.password = 'DynaLocalDeepLBatch!2026';
      const u = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA DeepL94',
          organization: { name: 'QA DeepL 094' },
        },
        201,
      );
      s.tenant = u.user.tenant_id;
      s.user = u.user.id;
      await save();
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.products = [];
      for (const [sku, name, description] of [
        [
          'QA-DEEPL-094-A',
          'Kubek stalowy 350 ml',
          'Kubek ze stali nierdzewnej. Pojemność 350 ml. Kolor czarny.',
        ],
        [
          'QA-DEEPL-094-B',
          'Bidon sportowy 750 ml',
          'Bidon sportowy. Pojemność 750 ml. Kolor zielony.',
        ],
      ])
        s.products.push(
          await api(
            '/products',
            'POST',
            { sku, name, description, price: 3000, quantity: 10, warehouse_id: s.warehouse },
            201,
          ),
        );
      s.products = await Promise.all(s.products.map((p: any) => api('/products/' + p.id)));
      s.channel = (await api('/integrations/deepl-example', 'POST', {})).channel_id;
      await save();
      console.log({ setup: true, products: 2, simulation: true });
    } else {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      if (phase === 'source') {
        assert(!s.translated_products);
        s.products = await Promise.all(
          s.products.map(async (p: any) => {
            const current = await api('/products/' + p.id);
            assert.equal(current.version, 1);
            for (const k of Object.keys(p)) assert(isDeepStrictEqual(current[k], p[k]), k);
            return current;
          }),
        );
        await save();
        console.log({ source_stock_captured: true, versions: [1, 1] });
      } else if (phase === 'translated') {
        const h = await api('/deepl/batches');
        assert.equal(h.data.length, 2);
        assert(h.data.every((b: any) => b.simulation));
        s.batch = h.data.find((b: any) => b.state === 'finished')?.id;
        s.cancelled_batch = h.data.find((b: any) => b.state === 'cancelled')?.id;
        assert(s.batch && s.cancelled_batch);
        const d = await api('/deepl/batches/' + s.batch);
        assert.equal(d.counts.applied, 4);
        assert.equal((await api('/deepl/batches/' + s.cancelled_batch)).counts.cancelled, 4);
        s.translated_products = [];
        for (const p of s.products) {
          const cur = await api('/products/' + p.id);
          assert.equal(cur.version, 2);
          assert.equal(cur.name, p.name);
          assert.equal(cur.description, p.description);
          assert.equal(cur.price, p.price);
          assert(isDeepStrictEqual(cur.stock, p.stock));
          const tr = (await api('/products/' + p.id + '/deepl')).translations;
          assert.equal(tr.length, 2);
          assert(tr.every((t: any) => t.deepl_draft_id && !t.ai_draft_id));
          s.translated_products.push(cur);
        }
        await save();
        console.log({ batches: 2, applied: 4, cancelled: 4, versions: [2, 2] });
      } else if (phase === 'order') {
        assert(s.translated_products && !s.order);
        const p = s.products[0];
        s.order = (
          await api(
            '/orders',
            'POST',
            {
              customer_name: 'Kupujący QA94',
              email: 'qa-deepl-buyer@example.test',
              warehouse_id: s.warehouse,
              items: [{ product_id: p.id, quantity: 2 }],
            },
            201,
          )
        ).id;
        await save();
        for (const status of ['paid', 'picking'])
          await api('/orders/' + s.order + '/status', 'PATCH', { status });
        for (let i = 0; i < 2; i++)
          await api('/orders/' + s.order + '/scan', 'POST', { code: p.sku });
        await api('/orders/' + s.order + '/status', 'PATCH', { status: 'packed' });
        await api('/orders/' + s.order + '/ship-demo', 'POST', {});
        s.invoice = (
          await api('/orders/' + s.order + '/documents', 'POST', { kind: 'invoice' })
        ).id;
        const current = await api('/orders/' + s.order),
          item = current.items[0];
        s.return_id = (
          await api(
            '/orders/' + s.order + '/returns',
            'POST',
            {
              client_key: randomUUID(),
              kind: 'return',
              reason: 'QA94 pełny zwrot po masowych tłumaczeniach',
              items: [{ item_id: item.id, quantity: 2 }],
            },
            201,
          )
        ).id;
        await save();
        await api('/returns/' + s.return_id + '/receive', 'POST', {
          version: (await api('/returns/' + s.return_id)).version,
          items: [{ item_id: item.id, accepted: 2, restocked: 2 }],
          note: 'QA94',
        });
        s.correction = (await api('/returns/' + s.return_id + '/document', 'POST', {})).id;
        s.final_order = await api('/orders/' + s.order);
        s.final_products = [];
        for (const p of s.products) s.final_products.push(await api('/products/' + p.id));
        assert.equal(s.final_order.total, 6000);
        assert.equal(
          s.final_products[0].stock.reduce((n: number, r: any) => n + Number(r.on_hand), 0),
          10,
        );
        assert.equal(
          s.final_products[0].stock.reduce((n: number, r: any) => n + Number(r.reserved), 0),
          0,
        );
        assert.equal(s.final_products[0].version, 2);
        s.completed_at = new Date().toISOString();
        await save();
        console.log({ order: s.final_order.number, total: 6000, returned: true, stock: '10/0' });
      } else if (phase === 'verify') {
        assert(s.completed_at);
        const health = await api('/health');
        assert.equal(health.schema_revision, '072_deepl_batches');
        assert(health.deepl_batches_available);
        assert(isDeepStrictEqual(await api('/orders/' + s.order), s.final_order));
        for (let i = 0; i < s.products.length; i++)
          assert(
            isDeepStrictEqual(await api('/products/' + s.products[i].id), s.final_products[i]),
          );
        const detail = await api('/deepl/batches/' + s.batch);
        assert.equal(detail.counts.applied, 4);
        assert.equal((await api('/deepl/batches/' + s.cancelled_batch)).counts.cancelled, 4);
        const preservation = await preserve(s);
        await writeFile(
          'docs/deepl-batches-native-qa.json',
          JSON.stringify(
            {
              stage: 94,
              health,
              simulation: true,
              batches: 2,
              products: 2,
              languages: ['de', 'en-us'],
              applied: 4,
              cancelled: 4,
              versions: [2, 2],
              source_and_prices_preserved: true,
              atomic_product_apply: true,
              order: s.final_order.number,
              total: 6000,
              full_return: true,
              stock: '10/0',
              preservation,
              checked_at: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        console.log({ verified: true, ...preservation });
      } else throw Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
