import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { tick } from '../server/worker';
import { BigBuy, bigbuyBulkResources } from '../server/bigbuy';
import { bulkDemoPage } from '../server/supplier-bulk';
import { encrypt } from '../server/security';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  other = '',
  viewer = '',
  tenant = '',
  source: any,
  supplier: any,
  w = '';
const req = (path: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie: auth } });
const ok = async (path: string, method: any = 'GET', payload?: any) => {
  const r = await req(path, method, payload);
  assert([200, 201].includes(r.statusCode), r.body);
  return r.json();
};
const login = async (email: string) =>
  (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' })).headers[
    'set-cookie'
  ]!.toString().split(';')[0];
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  cookie = (
    await req('/auth/signup', 'POST', {
      email: 'bulk-test@demo.local',
      password: 'DynaDemo!2026',
      name: 'Bulk Test',
      organization: { name: 'Bulk Test' },
    })
  ).headers['set-cookie']!.toString().split(';')[0];
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  tenant = (await ok('/auth/me')).user.tenant_id;
  await ok('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
  supplier = await ok('/suppliers', 'POST', { name: 'BigBuy masowy QA', code: 'BB-BULK' });
  source = await ok('/supplier-sources/demo', 'POST', { supplier_id: supplier.id });
  w = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
// Isolated fixture controls queue deadlines, so an older suite's jobs cannot be selected.
async function step(id: string, ctx: any = {}) {
  await pool.query(
    "UPDATE jobs SET run_at=CASE WHEN payload->>'bulk_id'=$1 OR payload->>'read_id'=$1 THEN now() ELSE '2100-01-01'::timestamptz END WHERE state='pending'",
    [id],
  );
  return tick(ctx);
}
async function start(s = source, extra: any = {}) {
  return ok('/supplier-sources/' + s.id + '/bulk-runs', 'POST', {
    client_key: randomUUID(),
    ...extra,
  });
}
const detail = (id: string) => ok('/supplier-bulk-runs/' + id);
async function drain(id: string, ctx: any = {}, limit = 2000) {
  for (let n = 0; n < limit; n++) {
    const r = (await detail(id)).run;
    if (r.state !== 'queued') return r;
    await pool.query("UPDATE jobs SET run_at=now() WHERE id=$1 AND state='pending'", [r.job_id]);
    if (ctx.transport) await pool.query('UPDATE supplier_api_limits SET next_at=now()');
    await step(id, ctx);
  }
  throw Error('bulk drain exceeded limit');
}
async function realSource(taxonomy?: string) {
  const ch = await ok('/integrations', 'POST', {
    provider: 'bigbuy',
    name: 'BigBuy contract',
    mode: 'sandbox',
    credentials: { api_key: 'bulk-test-' + randomUUID() },
    settings: {},
  });
  return ok('/supplier-sources', 'POST', {
    channel_id: ch.id,
    supplier_id: supplier.id,
    currency: 'EUR',
  });
}
function fake(url: string) {
  const u = new URL(url),
    resource = u.pathname.split('/')[3].split('.')[0] as any;
  return bulkDemoPage(
    resource,
    Number(u.searchParams.get('page')),
    Number(u.searchParams.get('pageSize')),
  );
}
const transport = async (url: string) => new Response(JSON.stringify(fake(url)));
test('bulk GET: właściwe zasoby, page0/pageSize/taksonomia/język, Bearer i ograniczona odpowiedź', async () => {
  const calls: any[] = [];
  const c = new BigBuy('live', { api_key: 'bulk-test' }, async (u, i) => {
    calls.push({ u, i });
    return new Response('[]');
  });
  for (const resource of bigbuyBulkResources) await c.bulk(resource, 0, 10000, 'pl', '12');
  assert.equal(calls.length, 6);
  for (const x of calls) {
    const u = new URL(x.u);
    assert.equal(u.origin, 'https://api.bigbuy.eu');
    assert.equal(u.searchParams.get('page'), '0');
    assert.equal(u.searchParams.get('pageSize'), '10000');
    assert.equal(u.searchParams.get('parentTaxonomy'), '12');
    assert.equal(x.i.method, 'GET');
    assert.equal(x.i.headers.Authorization, 'Bearer bulk-test');
    assert(!x.i.body);
  }
  assert(calls.find((x) => x.u.includes('productsinformation')).u.includes('isoCode=pl'));
  await assert.rejects(c.bulk('bad' as any, 0, 100));
  await assert.rejects(c.bulk('products', -1, 100));
  await assert.rejects(c.bulk('products', 0, 10001));
  await assert.rejects(
    new BigBuy('live', { api_key: 'k' }, async () => new Response('[{},{}]')).bulk(
      'products',
      0,
      1,
    ),
  );
  await assert.rejects(
    new BigBuy('live', { api_key: 'k' }, async () => new Response('{}', { status: 409 })).bulk(
      'products',
      0,
      1,
    ),
    /409/,
  );
});
test('checkpoint strony i deduplikacja zlecenia, brak żywego katalogu w trakcie zbierania', async () => {
  const body = { client_key: randomUUID(), page_size: 50 },
    r = await ok('/supplier-sources/' + source.id + '/bulk-runs', 'POST', body);
  assert.equal((await ok('/supplier-sources/' + source.id + '/bulk-runs', 'POST', body)).id, r.id);
  assert.equal(
    (await req('/supplier-sources/' + source.id + '/bulk-runs', 'POST', { ...body, page_size: 51 }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await req('/supplier-sources/' + source.id + '/bulk-runs', 'POST', {
        ...body,
        client_key: randomUUID(),
      })
    ).statusCode,
    409,
  );
  await step(r.id);
  const d = (await detail(r.id)).run;
  assert.equal(d.cursors.products.page, 1);
  assert.equal(d.cursors.products.rows, 50);
  assert.equal((await ok('/supplier-catalog')).data.length, 0);
  const done = await drain(r.id);
  assert.equal(done.state, 'success');
  assert.equal(done.published, 107);
  assert.equal(done.rejected, 0);
  assert.equal(done.cursors.products.page, 3);
  assert.equal(done.cursors.productsvariations.page, 1);
  assert.equal(done.cursors.productsimages.page, 1);
});
test('zbiory stronicowane niezależnie i powiązane po ID, wariant ma własny koszt/stan', async () => {
  let cursor = '';
  const ids = new Set<string>();
  do {
    const r = await ok(
      '/supplier-catalog?source_id=' + source.id + '&limit=25' + (cursor ? '&after=' + cursor : ''),
    );
    for (const i of r.data) {
      assert(!ids.has(i.id));
      ids.add(i.id);
      assert.equal(i.snapshot.quantity, 8);
      assert(i.bulk_run_id);
      assert.equal(i.read_id, null);
    }
    cursor = r.meta.cursor ?? '';
  } while (cursor);
  assert.equal(ids.size, 107);
  const variants = (await ok('/supplier-catalog?source_id=' + source.id + '&search=BB-V')).data;
  assert.equal(variants.length, 2);
  assert(
    variants.every((i: any) => i.snapshot.unit_cost === 1550 && i.remote_product_id === '202'),
  );
  assert.equal((await ok('/inventory')).data.length, 0);
});
test('bulk → produkt ze stanem0 → zakup z zamrożonym bulk_id i częściowe PZ/replay', async () => {
  let i = (await ok('/supplier-catalog?source_id=' + source.id + '&search=BB-1000')).data[0];
  const p = await ok('/supplier-catalog/' + i.id + '/product', 'POST', {
    version: i.version,
    sku: 'BULK-LOCAL-1000',
    price: 5000,
    vat: 23,
    warehouse_id: w,
  });
  assert.equal((await ok('/inventory?product_id=' + p.id)).data[0].on_hand, 0);
  i = (await ok('/supplier-catalog?source_id=' + source.id + '&search=BB-1000')).data[0];
  const body = {
      client_key: randomUUID(),
      warehouse_id: w,
      items: [{ id: i.id, version: i.version, quantity: 5 }],
    },
    buy = await ok('/supplier-sources/' + source.id + '/purchase', 'POST', body);
  assert.equal((await ok('/supplier-sources/' + source.id + '/purchase', 'POST', body)).id, buy.id);
  let po = await ok('/purchase-orders/' + buy.id);
  assert.equal(po.currency, 'EUR');
  assert.equal(po.lines[0].unit_cost, 1100);
  po = await ok('/purchase-orders/' + po.id + '/place', 'POST', { version: po.version });
  const receipt = {
    client_key: randomUUID(),
    version: po.version,
    lines: [{ product_id: p.id, quantity: 3, location: 'BB-01' }],
  };
  await ok('/purchase-orders/' + po.id + '/receive', 'POST', receipt);
  await ok('/purchase-orders/' + po.id + '/receive', 'POST', receipt);
  assert.equal((await ok('/inventory?product_id=' + p.id)).data[0].on_hand, 3);
  assert.equal(
    (
      await pool.query('SELECT snapshot FROM supplier_catalog_purchases WHERE purchase_id=$1', [
        po.id,
      ])
    ).rows[0].snapshot[0].bulk_run_id,
    i.bulk_run_id,
  );
});
test('nowy bulk zachowuje mapowania i nie nadpisuje magazynu ani ceny sprzedaży', async () => {
  const r = await start();
  assert.equal((await drain(r.id)).published, 107);
  const i = (await ok('/supplier-catalog?source_id=' + source.id + '&search=BB-1000')).data[0];
  assert(i.product_id);
  assert.equal((await ok('/products/' + i.product_id)).price, 5000);
  assert.equal((await ok('/inventory?product_id=' + i.product_id)).data[0].on_hand, 3);
});
test('RLS i scope: obcy run404, obce części niewidoczne, viewer403, read key nie zapisuje', async () => {
  const r = (await ok('/supplier-bulk-runs')).data[0];
  assert.equal((await req('/supplier-bulk-runs/' + r.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal(
    (
      await req(
        '/supplier-sources/' + source.id + '/bulk-runs',
        'POST',
        { client_key: randomUUID() },
        viewer,
      )
    ).statusCode,
    403,
  );
  const alien = (await req('/auth/me', 'GET', undefined, other)).json().user.tenant_id;
  assert.equal(
    (await tenantTx(alien, (c) => c.query('SELECT * FROM supplier_bulk_parts'))).rowCount,
    0,
  );
  const k = await ok('/developer/keys', 'POST', { name: 'bulk read', scopes: ['purchasing:read'] });
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/supplier-bulk-runs',
        headers: { authorization: 'Bearer ' + k.token },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/supplier-sources/' + source.id + '/bulk-runs',
        method: 'POST',
        payload: { client_key: randomUUID() },
        headers: { authorization: 'Bearer ' + k.token },
      })
    ).statusCode,
    403,
  );
});
test('prawdziwy transport respektuje361s, Retry-After i checkpoint bez resetowania prób', async () => {
  const s = await realSource(),
    r = await start(s, { page_size: 50 }),
    calls: string[] = [];
  await step(r.id, {
    transport: async (url: string) => {
      calls.push(url);
      return transport(url);
    },
  });
  let d = (await detail(r.id)).run;
  assert.equal(d.cursors.products.page, 1);
  const gate = (
    await pool.query(
      "SELECT extract(epoch FROM next_at-now()) delay FROM supplier_api_limits WHERE key LIKE '%:products' ORDER BY next_at DESC LIMIT 1",
    )
  ).rows[0];
  assert(Number(gate.delay) > 350);
  await step(r.id, {
    transport: async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 429, headers: { 'retry-after': '3600' } });
    },
  });
  d = (await detail(r.id)).run;
  assert.equal(d.resource_index, 1);
  assert.equal(d.cursors.productsinformation, undefined);
  const j = (await pool.query('SELECT * FROM jobs WHERE id=$1', [d.job_id])).rows[0];
  assert.equal(j.attempts, 1);
  assert(new Date(j.run_at).getTime() > Date.now() + 3500000);
  await pool.query('UPDATE jobs SET run_at=now() WHERE id=$1', [j.id]);
  await step(r.id, {
    transport: async (url: string) => {
      calls.push(url);
      return transport(url);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(
    (await pool.query('SELECT attempts FROM jobs WHERE id=$1', [j.id])).rows[0].attempts,
    1,
  );
  assert.equal((await drain(r.id, { transport })).published, 107);
  assert.equal(calls.filter((u) => u.includes('/products.json')).length, 1);
});
test('błędna/zmienna paginacja kończy odczyt; nie publikuje niepełnego zestawu', async () => {
  const s = await realSource(),
    r = await start(s, { page_size: 50 });
  const ctx = {
    transport: async (url: string) => {
      const u = new URL(url);
      u.searchParams.set('page', '0');
      return transport(u.toString());
    },
  };
  const done = await drain(r.id, ctx);
  assert.equal(done.state, 'failed');
  assert.match(done.error, /powtarza/);
  assert.equal(done.published, 0);
  assert.equal((await ok('/supplier-catalog?source_id=' + s.id)).data.length, 0);
});
test('pauza podczas HTTP anuluje run, późna odpowiedź nie zapisuje strony', async () => {
  const s = await realSource(),
    r = await start(s);
  await step(r.id, {
    transport: async (url: string) => {
      await ok('/supplier-sources/' + s.id + '/state', 'PATCH', { version: 1, paused: true });
      return transport(url);
    },
  });
  const d = (await detail(r.id)).run;
  assert.equal(d.state, 'cancelled');
  assert.equal(Number(d.fetched_rows), 0);
  assert.equal(
    (await pool.query('SELECT 1 FROM supplier_bulk_parts WHERE run_id=$1', [r.id])).rowCount,
    0,
  );
});
test('zmiana klucza w czasie HTTP odrzuca dane i kończy run', async () => {
  const s = await realSource(),
    r = await start(s);
  await step(r.id, {
    transport: async (url: string) => {
      await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
        s.channel_id,
        encrypt({ api_key: 'changed' }),
      ]);
      return transport(url);
    },
  });
  const d = (await detail(r.id)).run;
  assert.equal(d.state, 'failed');
  assert.equal(Number(d.fetched_rows), 0);
});
test('anulowanie run wymaga aktualnej wersji i nie unieważnia innych źródeł', async () => {
  const r = await start();
  await step(r.id);
  const d = (await detail(r.id)).run;
  assert.equal(
    (await req('/supplier-bulk-runs/' + r.id + '/cancel', 'POST', { version: 1 })).statusCode,
    409,
  );
  await ok('/supplier-bulk-runs/' + r.id + '/cancel', 'POST', { version: d.version });
  assert.equal((await detail(r.id)).run.state, 'cancelled');
  assert.equal(
    (await req('/supplier-bulk-runs/' + r.id + '/cancel', 'POST', { version: d.version }, other))
      .statusCode,
    404,
  );
});
test('czas obserwacji nie staje się czasem składania: stare strony blokują zakup', async () => {
  const fresh = await ok('/supplier-sources/demo', 'POST', { supplier_id: supplier.id });
  const r = await start(fresh);
  for (let n = 0; n < 6; n++) await step(r.id);
  let d = (await detail(r.id)).run;
  assert.equal(d.phase, 'parents');
  await pool.query(
    "UPDATE supplier_bulk_parts SET observed_at=now()-interval '1 hour' WHERE run_id=$1",
    [r.id],
  );
  await drain(r.id);
  const i = (await ok('/supplier-catalog?source_id=' + fresh.id + '&search=BB-1000')).data[0];
  assert(new Date(i.refreshed_at).getTime() < Date.now() - 3500000);
  assert.equal(
    (
      await req('/supplier-sources/' + fresh.id + '/purchase', 'POST', {
        client_key: randomUUID(),
        warehouse_id: w,
        items: [{ id: i.id, version: i.version, quantity: 1 }],
      })
    ).statusCode,
    409,
  );
});
test('nowszy odczyt punktowy chroniony przed starym bulk, zakończony zbiór wycofuje zniknięte SKU', async () => {
  const r = await start();
  for (let n = 0; n < 6; n++) await step(r.id);
  const p = await ok('/supplier-sources/' + source.id + '/reads', 'POST', {
    client_key: randomUUID(),
    remote_product_id: '1000',
  });
  for (let n = 0; n < 4; n++) await step(p.id);
  await drain(r.id);
  assert.equal((await detail(r.id)).run.skipped_newer, 1);
  let i = (await ok('/supplier-catalog?source_id=' + source.id + '&search=BB-1000')).data[0];
  assert.equal(i.read_id, p.id);
  assert.equal(i.bulk_run_id, null);
  const next = await start();
  for (let n = 0; n < 6; n++) await step(next.id);
  await pool.query(
    "DELETE FROM supplier_bulk_parts WHERE run_id=$1 AND resource='products' AND remote_id='1000'",
    [next.id],
  );
  await drain(next.id);
  i = (await ok('/supplier-catalog?source_id=' + source.id + '&search=BB-1000')).data[0];
  assert.equal(i.snapshot.active, false);
  assert.equal(i.snapshot.quantity, 0);
  assert.equal((await ok('/inventory?product_id=' + i.product_id)).data[0].on_hand, 3);
});

test('brak części jest błędem konkretnego SKU; pozostałe pozycje nadal tworzą katalog', async () => {
  const s = await realSource(),
    r = await start(s);
  const ctx = {
    transport: async (url: string) => {
      const rows = fake(url);
      return new Response(
        JSON.stringify(
          url.includes('/productsinformation.') ? rows.filter((p) => p.id !== 1000) : rows,
        ),
      );
    },
  };
  const done = await drain(r.id, ctx);
  assert.equal(done.state, 'success');
  assert.equal(done.rejected, 1);
  assert.equal(done.published, 106);
  const d = await detail(r.id);
  assert.equal(d.data[0].remote_product_id, '1000');
  assert.equal(
    (await ok('/supplier-catalog?source_id=' + s.id + '&search=BB-1000')).data.length,
    0,
  );
});
test('bulk nie umożliwia zakupu swoich części przed zakończeniem run', async () => {
  const r = await start();
  for (let n = 0; n < 7; n++) await step(r.id);
  let i = (await ok('/supplier-catalog?source_id=' + source.id + '&search=BB-1000')).data[0];
  assert.equal(i.bulk_run_id, r.id);
  const response = await req('/supplier-sources/' + source.id + '/purchase', 'POST', {
    client_key: randomUUID(),
    warehouse_id: w,
    items: [{ id: i.id, version: i.version, quantity: 1 }],
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.json().detail, /nie zakończył/);
  await drain(r.id);
});
test('utrata roli podczas HTTP zatrzymuje masowy katalog', async () => {
  const s = await realSource(),
    r = await start(s),
    actor = (await detail(r.id)).run.actor_id;
  try {
    await step(r.id, {
      transport: async (url: string) => {
        await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          tenant,
          actor,
        ]);
        return transport(url);
      },
    });
    assert.equal(
      (await pool.query('SELECT state,fetched_rows FROM supplier_bulk_runs WHERE id=$1', [r.id]))
        .rows[0].state,
      'failed',
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      actor,
    ]);
  }
});
test('stara dzierżawa nie zapisuje strony, nowy worker może wznowić od początku tego kroku', async () => {
  const s = await realSource(),
    r = await start(s);
  await step(r.id, {
    transport: async (url: string) => {
      await pool.query("UPDATE jobs SET lease_token=$2 WHERE payload->>'bulk_id'=$1", [
        r.id,
        randomUUID(),
      ]);
      return transport(url);
    },
  });
  const d = (await detail(r.id)).run;
  assert.equal(Number(d.fetched_rows), 0);
  assert.deepEqual(d.cursors, {});
  await pool.query("UPDATE jobs SET state='pending',lease_token=NULL,locked_at=NULL WHERE id=$1", [
    d.job_id,
  ]);
  assert.equal((await drain(r.id, { transport })).state, 'success');
});
test('ostatnia wygasła dzierżawa kończy również masowy run', async () => {
  const r = await start(),
    d = (await detail(r.id)).run;
  await pool.query(
    "UPDATE jobs SET state='running',attempts=max_attempts,lease_token=$2,locked_at=now()-interval '3 minutes' WHERE id=$1",
    [d.job_id, randomUUID()],
  );
  await step(r.id);
  assert.equal((await detail(r.id)).run.state, 'failed');
});
test('limit64MiB przerywa strumień bez parsowania nieograniczonej odpowiedzi', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let cancelled = false;
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    new BigBuy('live', { api_key: 'k' }, async () => new Response(body)).bulk('products', 0, 10000),
    /64 MB/,
  );
  assert(cancelled);
});
test('strona10000, 50 partii składania i pełna paginacja10000 SKU w osobnej bazie', async () => {
  const s = await realSource(),
    r = await start(s),
    stockBefore = (await ok('/inventory?limit=200')).data;
  const ctx = {
    transport: async (url: string) => {
      const u = new URL(url),
        resource = u.pathname.split('/')[3].split('.')[0],
        page = Number(u.searchParams.get('page'));
      let rows: any[] = [];
      if (
        page === 0 &&
        ['products', 'productsinformation', 'productsstockbyhandlingdays'].includes(resource)
      )
        rows = Array.from({ length: 10000 }, (_, n) => {
          const id = 50000 + n,
            sku = 'SCALE-BB-' + id;
          if (resource === 'products')
            return {
              id,
              sku,
              active: 1,
              attributes: false,
              images: false,
              wholesalePrice: '12.34',
            };
          if (resource === 'productsinformation')
            return { id, sku, name: 'Supplier scale ' + id, isoCode: 'pl' };
          return { id, sku, stocks: [{ quantity: 8, minHandlingDays: 0, maxHandlingDays: 1 }] };
        });
      return new Response(JSON.stringify(rows));
    },
  };
  const startAt = Date.now(),
    done = await drain(r.id, ctx);
  assert.equal(done.published, 10000);
  assert.equal(done.rejected, 0);
  assert.equal(done.cursors.products.page, 2);
  const ids = new Set<string>();
  let cursor = '',
    pages = 0;
  do {
    const p = await ok(
      '/supplier-catalog?source_id=' + s.id + '&limit=100' + (cursor ? '&after=' + cursor : ''),
    );
    for (const i of p.data) {
      assert(!ids.has(i.id));
      ids.add(i.id);
    }
    cursor = p.meta.cursor ?? '';
    pages++;
  } while (cursor);
  assert.equal(ids.size, 10000);
  assert.equal(pages, 100);
  assert.deepEqual((await ok('/inventory?limit=200')).data, stockBefore);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    'docs/supplier-bulk-scale.json',
    JSON.stringify(
      {
        scope: 'isolated_postgres_fake_provider_10000_supplier_skus',
        skus: done.published,
        fetched_rows: Number(done.fetched_rows),
        fetched_bytes: Number(done.fetched_bytes),
        assembly_batch: 200,
        pages,
        page_size: 100,
        total_ms: Date.now() - startAt,
        stock_unchanged: true,
        provider_requests: 0,
        api_rate_wait_skipped_in_fixture: true,
      },
      null,
      2,
    ) + '\n',
  );
});
