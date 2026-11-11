import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { BigBuy, BigBuyRetry, bigbuyMoney, normalizeBigBuy } from '../server/bigbuy';
import { tick } from '../server/worker';
import { encrypt } from '../server/security';
import { reserveBigBuySlot } from '../server/supplier-catalog';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  w: string,
  source: any,
  supplier: any,
  tenant: string;
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie: auth ?? '' } });
const ok = async (url: string, method: any = 'GET', payload?: any) => {
  const r = await req(url, method, payload);
  assert([200, 201].includes(r.statusCode), r.body);
  return r.json();
};
const cookieOf = (r: any) => r.headers['set-cookie'].toString().split(';')[0];
before(async () => {
  await migrate();
  await seed();
  // Seed OMS orders enqueue automation events. Finish those before assertions
  // that count the four supplier checkpoints through the shared worker.
  for (let i = 0; i < 100; i++) {
    const count = (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE kind='automation' AND state='pending'",
      )
    ).rows[0].n;
    if (!count) break;
    await tick();
  }
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE kind='automation' AND state='pending'",
      )
    ).rows[0].n,
    0,
  );
  app = await buildApp();
  cookie = cookieOf(
    await req('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' }),
  );
  tenant = (await ok('/auth/me')).user.tenant_id;
  other = cookieOf(
    await req('/auth/login', 'POST', { email: 'other@demo.local', password: 'DynaDemo!2026' }),
  );
  viewer = cookieOf(
    await req('/auth/login', 'POST', { email: 'viewer@demo.local', password: 'DynaDemo!2026' }),
  );
  await ok('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
  w = (await ok('/warehouses')).data[0].id;
  supplier = await ok('/suppliers', 'POST', { name: 'BigBuy QA', code: 'BB-QA' });
  source = await ok('/supplier-sources/demo', 'POST', { supplier_id: supplier.id });
});
after(async () => {
  await app.close();
  await pool.end();
});
async function drain(ctx: any = {}, id?: string) {
  for (let n = 0; n < 25; n++) {
    if (id)
      await pool.query(
        "UPDATE jobs SET run_at=now() WHERE payload->>'read_id'=$1 AND state='pending'",
        [id],
      );
    const active = (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE state='pending' AND ($1::text IS NULL OR payload->>'read_id'=$1)",
        [id ?? null],
      )
    ).rows[0].n;
    if (!active) break;
    await tick(ctx);
  }
}
async function read(product = '101', variant?: string, s = source) {
  const r = await ok('/supplier-sources/' + s.id + '/reads', 'POST', {
    client_key: randomUUID(),
    remote_product_id: product,
    ...(variant ? { remote_variant_id: variant } : {}),
  });
  await drain({}, r.id);
  const item = (await ok('/supplier-catalog?source_id=' + s.id)).data.find(
    (i: any) => i.remote_product_id === product && i.remote_variant_id === (variant ?? ''),
  );
  assert(item);
  return item;
}
test('BigBuy: oficjalne domeny, GET/Bearer/isoCode, brak zapisu i odroczenie 429/5xx', async () => {
  const calls: any[] = [];
  const transport = async (u: string, i: any) => {
    calls.push({ u, i });
    return new Response(JSON.stringify({ id: 101 }), { status: 200 });
  };
  const c = new BigBuy('sandbox', { api_key: 'private-test-key' }, transport);
  await c.read('productinformation', '101', 'pl');
  assert.equal(
    calls[0].u,
    'https://api.sandbox.bigbuy.eu/rest/catalog/productinformation/101.json?isoCode=pl',
  );
  assert.equal(calls[0].i.method, 'GET');
  assert.equal(calls[0].i.headers.Authorization, 'Bearer private-test-key');
  assert(!calls[0].i.body);
  assert.equal(new BigBuy('live', { api_key: 'k' }, transport).base, 'https://api.bigbuy.eu');
  await assert.rejects(c.read('create', '101'));
  await assert.rejects(c.read('product', '../x'));
  for (const status of [429, 503])
    await assert.rejects(
      new BigBuy(
        'sandbox',
        { api_key: 'k' },
        async () => new Response('{}', { status, headers: { 'retry-after': '3600' } }),
      ).read('product', '101'),
      (e: any) => e instanceof BigBuyRetry && e.seconds === 3600,
    );
  await assert.rejects(
    new BigBuy(
      'sandbox',
      { api_key: 'k' },
      async () => new Response('private-key', { status: 401 }),
    ).read('product', '101'),
    (e: any) => e.status === 401 && !e.message.includes('private-key'),
  );
  await assert.rejects(
    new BigBuy(
      'sandbox',
      { api_key: 'k' },
      async () => new Response('x'.repeat(5 * 1024 * 1024 + 1)),
    ).read('product', '101'),
    /5 MB/,
  );
});
test('ceny dokładne, progi i handling days; zły SKU, wariant, język i duplikat koszyka blokują snapshot', () => {
  assert.equal(bigbuyMoney('12.34'), 1234);
  assert.equal(bigbuyMoney(17.35), 1735);
  for (const x of [null, '', '1e2', '0.001', '-1', 'NaN', Infinity])
    assert.throws(() => bigbuyMoney(x));
  const parts: any = {
    product: { id: 101, sku: 'S101', active: 1, attributes: false, wholesalePrice: '12.34' },
    productinformation: { id: 101, isoCode: 'pl', name: 'Produkt QA' },
    productimages: { id: 101, images: [] },
    productstockbyhandlingdays: {
      id: 101,
      sku: 'S101',
      stocks: [
        { quantity: 5, minHandlingDays: 0, maxHandlingDays: 1 },
        { quantity: 12, minHandlingDays: 2, maxHandlingDays: 4 },
      ],
    },
  };
  assert.equal(normalizeBigBuy(parts, '101', null, 'pl', 2).quantity, 5);
  assert.equal(normalizeBigBuy(parts, '101', null, 'pl', 4).quantity, 17);
  for (const mutate of [
    (p: any) => (p.productinformation.isoCode = 'en'),
    (p: any) => (p.productstockbyhandlingdays.sku = 'bad'),
    (p: any) => (p.product.attributes = true),
    (p: any) => p.productstockbyhandlingdays.stocks.push(p.productstockbyhandlingdays.stocks[0]),
  ]) {
    const p = structuredClone(parts);
    mutate(p);
    assert.throws(() => normalizeBigBuy(p, '101', null, 'pl', 2));
  }
});
test('cztery checkpointy kończą atomowy snapshot, replay nie tworzy nowego joba; magazyn bez zmian', async () => {
  const stocks = (await ok('/inventory?limit=200')).data;
  const key = randomUUID(),
    body = { client_key: key, remote_product_id: '101' };
  const r = await ok('/supplier-sources/' + source.id + '/reads', 'POST', body);
  assert.equal((await ok('/supplier-sources/' + source.id + '/reads', 'POST', body)).id, r.id);
  assert.equal(
    (
      await req('/supplier-sources/' + source.id + '/reads', 'POST', {
        ...body,
        remote_product_id: '102',
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await req('/supplier-sources/' + source.id + '/reads', 'POST', {
        ...body,
        client_key: randomUUID(),
      })
    ).statusCode,
    409,
  );
  await tick();
  assert.equal((await ok('/supplier-catalog')).data.length, 0);
  await drain({}, r.id);
  const i = (await ok('/supplier-catalog')).data[0];
  assert.equal(i.snapshot.quantity, 8);
  assert.equal(i.snapshot.unit_cost, 1234);
  assert.equal(i.snapshot.currency, 'EUR');
  assert.equal(i.snapshot.simulation, true);
  assert.deepEqual((await ok('/inventory?limit=200')).data, stocks);
  const done = (await pool.query('SELECT * FROM supplier_catalog_reads WHERE id=$1', [r.id]))
    .rows[0];
  assert.equal(done.state, 'success');
  assert.equal(done.phase, 4);
});
test('wariant ma własny SKU/cenę/stan i nie używa stanu rodzica', async () => {
  const i = await read('202', '303');
  assert.equal(i.sku, 'BB-V-303');
  assert.equal(i.snapshot.unit_cost, 1550);
  assert.equal(i.snapshot.quantity, 8);
  assert.equal(i.remote_variant_id, '303');
});
test('produkt lokalny tworzony ze stanem zero, zakup progu ceny i częściowe PZ mają idempotencję', async () => {
  let i = (await ok('/supplier-catalog?search=BB-101')).data[0];
  const p = await ok('/supplier-catalog/' + i.id + '/product', 'POST', {
    version: i.version,
    sku: 'LOCAL-BB-101',
    price: 5000,
    vat: 23,
    warehouse_id: w,
  });
  assert.equal((await ok('/inventory?product_id=' + p.id)).data[0].on_hand, 0);
  i = (await ok('/supplier-catalog?search=BB-101')).data[0];
  const body = {
    client_key: randomUUID(),
    warehouse_id: w,
    items: [{ id: i.id, version: i.version, quantity: 5 }],
  };
  const buy = await ok('/supplier-sources/' + source.id + '/purchase', 'POST', body);
  assert.equal((await ok('/supplier-sources/' + source.id + '/purchase', 'POST', body)).id, buy.id);
  let po = await ok('/purchase-orders/' + buy.id);
  assert.equal(po.currency, 'EUR');
  assert.equal(po.lines[0].unit_cost, 1100);
  assert.equal(po.total_net, 5500);
  assert.equal(po.state, 'draft');
  assert.equal(
    (
      await req('/supplier-sources/' + source.id + '/purchase', 'POST', {
        ...body,
        items: [{ ...body.items[0], quantity: 4 }],
      })
    ).statusCode,
    409,
  );
  await ok('/purchase-orders/' + po.id + '/place', 'POST', { version: po.version });
  po = await ok('/purchase-orders/' + po.id);
  const receipt = {
    version: po.version,
    client_key: randomUUID(),
    lines: [{ product_id: p.id, quantity: 3, location: 'BB-01' }],
  };
  await ok('/purchase-orders/' + po.id + '/receive', 'POST', receipt);
  await ok('/purchase-orders/' + po.id + '/receive', 'POST', receipt);
  const stock = (await ok('/inventory?product_id=' + p.id)).data[0];
  assert.equal(stock.on_hand, 3);
  assert.equal(stock.reserved, 0);
  assert.equal((await ok('/products/' + p.id)).price, 5000);
  const snapshots = (
    await pool.query('SELECT snapshot FROM supplier_catalog_purchases WHERE purchase_id=$1', [
      po.id,
    ])
  ).rows[0].snapshot;
  assert.equal(snapshots[0].read_id, i.read_id);
  assert.equal(snapshots[0].unit_cost, 1100);
});
test('obcy produkt/źródło i viewer nie mogą pisać; publiczny odczyt wymaga scope', async () => {
  assert.deepEqual((await req('/supplier-catalog', 'GET', undefined, other)).json().data, []);
  assert.equal(
    (
      await req(
        '/supplier-sources/' + source.id + '/reads',
        'POST',
        { client_key: randomUUID(), remote_product_id: '1' },
        other,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await req(
        '/supplier-sources/' + source.id + '/reads',
        'POST',
        { client_key: randomUUID(), remote_product_id: '1' },
        viewer,
      )
    ).statusCode,
    403,
  );
  const key = await ok('/developer/keys', 'POST', {
    name: 'Dostawcy read',
    scopes: ['purchasing:read'],
  });
  const r = await app.inject({
    url: '/api/v1/supplier-catalog',
    headers: { authorization: 'Bearer ' + key.token },
  });
  assert.equal(r.statusCode, 200);
  assert(r.json().data.length);
  assert.equal(
    (
      await app.inject({
        url: '/api/v1/supplier-sources/' + source.id + '/reads',
        method: 'POST',
        headers: { authorization: 'Bearer ' + key.token },
        payload: { client_key: randomUUID(), remote_product_id: '1' },
      })
    ).statusCode,
    403,
  );
});
test('zmiana wersji i brak świeżości/aktywności/dostępności blokują zakup', async () => {
  const i = (await ok('/supplier-catalog?search=BB-101')).data[0],
    body = {
      client_key: randomUUID(),
      warehouse_id: w,
      items: [{ id: i.id, version: i.version, quantity: 9 }],
    };
  assert.equal(
    (await req('/supplier-sources/' + source.id + '/purchase', 'POST', body)).statusCode,
    409,
  );
  assert.equal(
    (
      await req('/supplier-sources/' + source.id + '/purchase', 'POST', {
        ...body,
        items: [{ ...body.items[0], quantity: 1, version: i.version - 1 }],
      })
    ).statusCode,
    409,
  );
  await pool.query(
    "UPDATE supplier_catalog_items SET refreshed_at=now()-interval '16 minutes' WHERE id=$1",
    [i.id],
  );
  assert.equal(
    (
      await req('/supplier-sources/' + source.id + '/purchase', 'POST', {
        ...body,
        items: [{ ...body.items[0], quantity: 1 }],
      })
    ).statusCode,
    409,
  );
  await read('101');
});
test('wstrzymanie anuluje oczekujące odczyty; wznowienie wymaga nowego snapshotu', async () => {
  const r = await ok('/supplier-sources/' + source.id + '/reads', 'POST', {
    client_key: randomUUID(),
    remote_product_id: '404',
  });
  await ok('/supplier-sources/' + source.id + '/state', 'PATCH', {
    version: source.version,
    paused: true,
  });
  assert.equal(
    (await pool.query('SELECT state FROM supplier_catalog_reads WHERE id=$1', [r.id])).rows[0]
      .state,
    'cancelled',
  );
  assert.equal(
    (
      await req('/supplier-sources/' + source.id + '/reads', 'POST', {
        client_key: randomUUID(),
        remote_product_id: '405',
      })
    ).statusCode,
    409,
  );
  source = (await ok('/supplier-sources')).data[0];
  await ok('/supplier-sources/' + source.id + '/state', 'PATCH', {
    version: source.version,
    paused: false,
  });
  source = (await ok('/supplier-sources')).data[0];
});
test('limiter wspólny dla duplikatów tokenu rezerwuje jedną próbę bez blokowania workerów', async () => {
  const k = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => reserveBigBuySlot(k, 'product')),
  );
  assert.equal(results.filter((d) => d === 0).length, 1);
  assert(results.every((d) => d >= 0 && d <= 5));
  assert.equal(await reserveBigBuySlot(k, 'productinformation'), 0);
  await assert.rejects(tenantTx(tenant, (c) => c.query('SELECT * FROM supplier_api_limits')));
});

async function realSource() {
  const ch = await ok('/integrations', 'POST', {
    provider: 'bigbuy',
    name: 'BigBuy fake transport',
    mode: 'sandbox',
    credentials: { api_key: 'test-' + randomUUID() },
    settings: {},
  });
  return ok('/supplier-sources', 'POST', {
    channel_id: ch.id,
    supplier_id: supplier.id,
    currency: 'EUR',
  });
}
function providerPart(url: string) {
  const u = new URL(url),
    resource = u.pathname.split('/')[3],
    id = Number(u.pathname.split('/')[4].split('.')[0]);
  if (resource === 'product')
    return { id, sku: 'REAL-' + id, attributes: false, active: 1, wholesalePrice: '12.34' };
  if (resource === 'productinformation')
    return { id, isoCode: 'pl', name: 'Contract product ' + id };
  if (resource === 'productimages') return { id, images: [] };
  return {
    id,
    sku: 'REAL-' + id,
    stocks: [{ quantity: 8, minHandlingDays: 0, maxHandlingDays: 1 }],
  };
}
test('worker HTTP zapisuje checkpoint, honoruje Retry-After, wznawia od brakującego kroku', async () => {
  const s = await realSource(),
    r = await ok('/supplier-sources/' + s.id + '/reads', 'POST', {
      client_key: randomUUID(),
      remote_product_id: '505',
    }),
    calls: string[] = [];
  const ctx = {
    transport: async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(providerPart(url)));
    },
  };
  await tick(ctx);
  let row = (await pool.query('SELECT * FROM supplier_catalog_reads WHERE id=$1', [r.id])).rows[0];
  assert.equal(row.phase, 1);
  assert(row.parts.product);
  assert.equal((await ok('/supplier-catalog?source_id=' + s.id)).data.length, 0);
  await tick({
    transport: async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 429, headers: { 'retry-after': '3600' } });
    },
  });
  const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [row.job_id])).rows[0];
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 1);
  assert(new Date(job.run_at).getTime() > Date.now() + 3500000);
  assert.equal(
    (await pool.query('SELECT phase FROM supplier_catalog_reads WHERE id=$1', [r.id])).rows[0]
      .phase,
    1,
  );
  const n = calls.length;
  await pool.query('UPDATE jobs SET run_at=now() WHERE id=$1', [job.id]);
  await tick(ctx);
  assert.equal(calls.length, n);
  assert.equal(
    (await pool.query('SELECT attempts FROM jobs WHERE id=$1', [job.id])).rows[0].attempts,
    1,
  );
  await pool.query('UPDATE supplier_api_limits SET next_at=now()');
  await drain(ctx, r.id);
  row = (await pool.query('SELECT * FROM supplier_catalog_reads WHERE id=$1', [r.id])).rows[0];
  assert.equal(row.state, 'success');
  assert.equal(row.phase, 4);
  assert.equal(calls.filter((u) => u.includes('/product/')).length, 1);
  assert.equal(calls.filter((u) => u.includes('/productinformation/')).length, 2);
});
test('pauza podczas HTTP odrzuca późną odpowiedź i nie zapisuje checkpointu', async () => {
  const s = await realSource(),
    r = await ok('/supplier-sources/' + s.id + '/reads', 'POST', {
      client_key: randomUUID(),
      remote_product_id: '606',
    });
  await tick({
    transport: async (url: string) => {
      await ok('/supplier-sources/' + s.id + '/state', 'PATCH', { version: 1, paused: true });
      return new Response(JSON.stringify(providerPart(url)));
    },
  });
  const row = (await pool.query('SELECT * FROM supplier_catalog_reads WHERE id=$1', [r.id]))
    .rows[0];
  assert.equal(row.state, 'cancelled');
  assert.equal(row.phase, 0);
  assert.deepEqual(row.parts, {});
  assert.equal((await ok('/supplier-catalog?source_id=' + s.id)).data.length, 0);
});
test('zmiana tokenu podczas HTTP kończy stary odczyt, bez częściowego katalogu', async () => {
  const s = await realSource(),
    r = await ok('/supplier-sources/' + s.id + '/reads', 'POST', {
      client_key: randomUUID(),
      remote_product_id: '707',
    });
  await tick({
    transport: async (url: string) => {
      await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
        s.channel_id,
        encrypt({ api_key: 'replacement' }),
      ]);
      return new Response(JSON.stringify(providerPart(url)));
    },
  });
  const row = (await pool.query('SELECT * FROM supplier_catalog_reads WHERE id=$1', [r.id]))
    .rows[0];
  assert.equal(row.state, 'failed');
  assert.equal(row.phase, 0);
  assert.equal((await ok('/supplier-catalog?source_id=' + s.id)).data.length, 0);
});
test('wygaśnięcie ostatniej dzierżawy kończy także run dostawcy', async () => {
  const s = await realSource(),
    r = await ok('/supplier-sources/' + s.id + '/reads', 'POST', {
      client_key: randomUUID(),
      remote_product_id: '808',
    });
  await pool.query(
    "UPDATE jobs SET state='running',attempts=max_attempts,lease_token=$2,locked_at=now()-interval '3 minutes' WHERE payload->>'read_id'=$1",
    [r.id, randomUUID()],
  );
  let requests = 0;
  await tick({
    transport: async () => {
      requests++;
      return new Response('{}');
    },
  });
  assert.equal(requests, 0);
  assert.equal(
    (await pool.query('SELECT state FROM supplier_catalog_reads WHERE id=$1', [r.id])).rows[0]
      .state,
    'failed',
  );
});
test('odczyt tylko własnego źródła i katalogu ma pełną paginację bez duplikatów', async () => {
  for (let n = 0; n < 4; n++) await read(String(900 + n));
  const ids = new Set<string>();
  let cursor = '';
  do {
    const p = await ok(
      '/supplier-catalog?source_id=' + source.id + '&limit=2' + (cursor ? '&after=' + cursor : ''),
    );
    for (const row of p.data) {
      assert(!ids.has(row.id));
      ids.add(row.id);
    }
    cursor = p.meta.cursor ?? '';
  } while (cursor);
  assert.equal(ids.size, 6);
  assert.equal(
    (await req('/supplier-sources/' + source.id, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal((await req('/supplier-catalog?limit=101')).statusCode, 422);
  const doc = (await app.inject({ url: '/api/v1/openapi' })).json();
  assert(doc.paths['/supplier-sources/{id}/reads'].post.requestBody);
  assert(
    doc.paths['/supplier-catalog'].get.parameters.some(
      (p: any) => p.name === 'limit' && p.schema.maximum === 100,
    ),
  );
});

test('późna odpowiedź starego workera nie nadpisuje nowej dzierżawy', async () => {
  const s = await realSource(),
    r = await ok('/supplier-sources/' + s.id + '/reads', 'POST', {
      client_key: randomUUID(),
      remote_product_id: '1001',
    }),
    replacement = randomUUID();
  await tick({
    transport: async (url: string) => {
      await pool.query("UPDATE jobs SET lease_token=$2 WHERE payload->>'read_id'=$1", [
        r.id,
        replacement,
      ]);
      return new Response(JSON.stringify(providerPart(url)));
    },
  });
  let row = (await pool.query('SELECT * FROM supplier_catalog_reads WHERE id=$1', [r.id])).rows[0];
  assert.equal(row.phase, 0);
  assert.deepEqual(row.parts, {});
  assert.equal(
    (await pool.query('SELECT lease_token FROM jobs WHERE id=$1', [row.job_id])).rows[0]
      .lease_token,
    replacement,
  );
  await pool.query(
    "UPDATE jobs SET state='pending',lease_token=NULL,locked_at=NULL,run_at=now() WHERE id=$1",
    [row.job_id],
  );
  await pool.query('UPDATE supplier_api_limits SET next_at=now()');
  await drain(
    { transport: async (url: string) => new Response(JSON.stringify(providerPart(url))) },
    r.id,
  );
  row = (await pool.query('SELECT * FROM supplier_catalog_reads WHERE id=$1', [r.id])).rows[0];
  assert.equal(row.state, 'success');
});
test('utrata roli w trakcie HTTP blokuje katalog przed zapisaniem danych', async () => {
  const s = await realSource(),
    r = await ok('/supplier-sources/' + s.id + '/reads', 'POST', {
      client_key: randomUUID(),
      remote_product_id: '1002',
    }),
    actor = (await pool.query('SELECT actor_id FROM supplier_catalog_reads WHERE id=$1', [r.id]))
      .rows[0].actor_id;
  try {
    await tick({
      transport: async (url: string) => {
        await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          tenant,
          actor,
        ]);
        return new Response(JSON.stringify(providerPart(url)));
      },
    });
    assert.equal(
      (await pool.query('SELECT state,phase FROM supplier_catalog_reads WHERE id=$1', [r.id]))
        .rows[0].state,
      'failed',
    );
    assert.equal(
      (await pool.query('SELECT phase FROM supplier_catalog_reads WHERE id=$1', [r.id])).rows[0]
        .phase,
      0,
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      actor,
    ]);
  }
});

test('historia pokazuje najnowsze odczyty, strony remisu czasu nie pomijają wpisów', async () => {
  const template = (
    await pool.query('SELECT * FROM supplier_catalog_reads WHERE source_id=$1 LIMIT 1', [source.id])
  ).rows[0];
  for (let n = 0; n < 104; n++)
    await pool.query(
      "INSERT INTO supplier_catalog_reads(id,tenant_id,source_id,actor_id,client_key,input_hash,remote_product_id,connection_hash,state,created_at) VALUES($1,$2,$3,$4,$5,'qa',$6,'qa','success','2026-10-10T12:00:00.123456Z')",
      [randomUUID(), tenant, source.id, template.actor_id, randomUUID(), String(20000 + n)],
    );
  const expected = (
      await pool.query(
        'SELECT id FROM supplier_catalog_reads WHERE source_id=$1 ORDER BY created_at DESC,id DESC',
        [source.id],
      )
    ).rows.map((r) => r.id),
    actual: string[] = [];
  let cursor = '';
  do {
    const p = await ok(
      '/supplier-reads?source_id=' + source.id + '&limit=25' + (cursor ? '&after=' + cursor : ''),
    );
    actual.push(...p.data.map((r: any) => r.id));
    cursor = p.meta.cursor ?? '';
  } while (cursor);
  assert.deepEqual(actual, expected);
  assert.equal(
    (await ok('/supplier-reads?source_id=' + source.id + '&limit=100')).data.length,
    100,
  );
});
