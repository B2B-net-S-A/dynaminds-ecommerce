import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processOfferJob, failOffer } from '../server/offers';
import { processVariantBatch, failVariantBatch } from '../server/variant-offer-batches';
import { Problem } from '../server/errors';
import type { IntegrationContext } from '../server/channel-access';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  actor: string,
  next = 100000;
const store = new Map<string, any>(),
  calls: { method: string; path: string; body: any }[] = [];
let lost = false,
  tax = 'yes',
  currency = 'PLN',
  afterRead: (() => Promise<void>) | undefined,
  afterWrite: (() => Promise<void>) | undefined,
  corrupt = false,
  failSku = '';
const json = (v: any, status = 200) => new Response(JSON.stringify(v), { status });
const ctx: IntegrationContext = {
  transport: async (url, init) => {
    const u = new URL(url),
      path = u.pathname,
      method = init.method ?? 'GET',
      body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (path.includes('/settings/general/')) return json({ value: currency });
    if (path.includes('/settings/tax/')) return json({ value: tax });
    const parts = path.split('/'),
      variation = parts.includes('variations'),
      key = parts.at(-1)!,
      parent = variation ? parts[parts.indexOf('variations') - 1] : undefined;
    if (method === 'GET') {
      if (key === 'products' || key === 'variations')
        return json(
          [...store.values()].filter(
            (v) =>
              v.sku === u.searchParams.get('sku') &&
              (variation ? v._parent === parent : !v._parent),
          ),
        );
      const v = store.get(key);
      const copy = v ? { ...v } : null;
      if (copy) {
        delete copy._parent;
        delete copy.parent_id;
        if (variation) {
          delete copy.type;
          delete copy.name;
        }
      }
      if (afterRead) {
        const hook = afterRead;
        afterRead = undefined;
        await hook();
      }
      return v ? json(copy) : json({}, 404);
    }
    if (method === 'POST') {
      assert.equal(
        variation ? 'name' in body || 'type' in body || 'images' in body : false,
        false,
        'Variation API accepts no name/type/images',
      );
      if (body.sku === failSku) return json({ secret: 'NOT_EXPOSED' }, 503);
      const v = {
        id: next++,
        ...body,
        sale_price: '',
        ...(variation ? { _parent: parent } : { variations: [] }),
      };
      if (corrupt) v.attributes = [];
      store.set(String(v.id), v);
      if (variation) store.get(parent!).variations.push(v.id);
      await afterWrite?.();
      if (lost) {
        lost = false;
        throw new Problem(502, 'Odpowiedź utracona');
      }
      return json(v, 201);
    }
    const v = store.get(key);
    assert(v);
    Object.assign(v, body);
    await afterWrite?.();
    return json(v);
  },
};
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: auth } });
const good = async (p: ReturnType<typeof req>, status = 200) => {
  const r = await p;
  assert.equal(r.statusCode, status, r.body);
  return r.json();
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  warehouse = (await good(req('/api/warehouses'))).data[0].id;
  actor = (await good(req('/api/auth/me'))).user.id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await app.close();
  app = await buildApp({ integrationTransport: ctx.transport });
  lost = false;
  tax = 'yes';
  currency = 'PLN';
  afterRead = undefined;
  afterWrite = undefined;
  corrupt = false;
  failSku = '';
});
async function channel(simulation = false) {
  const id = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce','Grupy QA','sandbox',$3,$4)",
      [
        id,
        DEMO_TENANT,
        encrypt({ consumer_key: 'fixture', consumer_secret: 'fixture' }),
        JSON.stringify({ store_url: 'https://shop.example', simulation }),
      ],
    ),
  );
  return { id };
}
async function product(extra: any = {}) {
  return good(
    req('/api/products', 'POST', {
      sku: 'VAR-' + randomUUID().slice(0, 12),
      name: 'Wariant QA',
      price: 12300,
      vat: 23,
      warehouse_id: warehouse,
      quantity: 10,
      ...extra,
    }),
    201,
  );
}
async function group(count = 2) {
  const p = await product({
    kind: 'group',
    name: 'Grupa QA',
    price: 0,
    quantity: 0,
    attributes: { Materiał: 'Bawełna' },
  });
  const variants = [];
  for (let i = 0; i < count; i++)
    variants.push(
      await product({
        kind: 'variant',
        parent_id: p.id,
        attributes: { Kolor: 'Kolor ' + i, Rozmiar: 'M' },
        ean: '',
      }),
    );
  return { ...p, variants };
}
async function preview(ch: any, p: any, extra: any = {}) {
  return req('/api/integrations/' + ch.id + '/offers/preview', 'POST', {
    product_id: p.id,
    warehouse_id: warehouse,
    operation: 'create_group',
    stock: false,
    price: false,
    variation_axes: ['Kolor'],
    ...extra,
  });
}
const getPlan = async (id: string) =>
  (await pool.query('SELECT * FROM offer_plans WHERE id=$1', [id])).rows[0];
async function execute(id: string) {
  const p = await getPlan(id);
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [p.job_id, randomUUID()],
    )
  ).rows[0];
  try {
    await processOfferJob(job, ctx);
  } catch (e) {
    await failOffer(job, e);
  }
  return getPlan(id);
}
async function queued(plan: any) {
  await good(req('/api/offer-plans/' + plan.id + '/queue', 'POST', {}));
  return execute(plan.id);
}
async function createdGroup(ch: any, p: any) {
  const plan = await good(preview(ch, p));
  const done = await queued(plan);
  assert.equal(done.state, 'done', done.error);
  return done;
}
async function variantPreview(ch: any, p: any, parent: string, extra: any = {}) {
  return preview(ch, p, {
    operation: 'create_variant',
    stock: true,
    price: true,
    variation_axes: undefined,
    parent_external_id: parent,
    ...extra,
  });
}
async function start(ch: any, g: any, parent: string, extra: any = {}) {
  return good(
    req('/api/integrations/' + ch.id + '/variant-batches', 'POST', {
      group_id: g.id,
      warehouse_id: warehouse,
      parent_external_id: parent,
      operation: 'create_variant',
      client_key: randomUUID(),
      ...extra,
    }),
    201,
  );
}
const batch = async (id: string) =>
  (await pool.query('SELECT * FROM variant_offer_batches WHERE id=$1', [id])).rows[0];
async function step(id: string) {
  const b = await batch(id),
    job = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
        [b.job_id, randomUUID()],
      )
    ).rows[0];
  try {
    await processVariantBatch(job, ctx);
  } catch (e) {
    await failVariantBatch(job, e);
  }
  return batch(id);
}
async function prepare(b: any, n: number) {
  for (let i = 0; i <= n; i++) await step(b.id);
  const r = await good(req('/api/variant-batches/' + b.id));
  assert.equal(r.batch.state, 'review');
  return r;
}
async function completeBatch(b: any, max = 200) {
  for (let i = 0; i < max; i++) {
    const row = await batch(b.id);
    if (!['queued', 'preparing'].includes(row.state)) return row;
    await step(b.id);
    const plans = (
      await pool.query(
        "SELECT p.id FROM variant_offer_batch_items i JOIN offer_plans p ON p.id=i.plan_id WHERE i.batch_id=$1 AND p.state='queued'",
        [b.id],
      )
    ).rows;
    for (const p of plans) await execute(p.id);
  }
  throw Error('Batch did not settle');
}
const writes = () => calls.filter((c) => ['POST', 'PUT'].includes(c.method)).length;
test('grupa tworzy variable/draft z parametrami wariantów bez ceny i stanu', async () => {
  const ch = await channel(),
    g = await group(),
    p = await good(preview(ch, g));
  assert.equal(p.payload.type, 'variable');
  assert.equal(p.payload.regular_price, undefined);
  assert.equal(p.payload.stock_quantity, undefined);
  assert.deepEqual(p.payload.attributes[0], {
    name: 'Kolor',
    visible: true,
    variation: true,
    options: ['Kolor 0', 'Kolor 1'],
  });
  assert.equal(p.payload.attributes[1].variation, false);
  const d = await queued(p);
  assert.equal(d.state, 'done');
  assert(d.result.desired_applied);
});
test('brak parametrów, brak wartości, puste grupy i powtórzone kombinacje są odrzucane', async () => {
  const ch = await channel(),
    g = await group();
  assert.equal((await preview(ch, g, { variation_axes: [] })).statusCode, 422);
  assert.equal((await preview(ch, g, { variation_axes: ['Kolor', 'kolor'] })).statusCode, 422);
  assert.equal((await preview(ch, g, { variation_axes: ['Brak'] })).statusCode, 422);
  await pool.query('UPDATE products SET attributes=$2 WHERE id=$1', [
    g.variants[1].id,
    JSON.stringify(g.variants[0].attributes),
  ]);
  assert.equal((await preview(ch, g)).statusCode, 422);
  const empty = await group(0);
  assert.equal((await preview(ch, empty)).statusCode, 422);
});
test('nowy wariant używa endpointu rodzica, pól wariantu, ceny netto i dostępnego stanu', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g);
  tax = 'no';
  await good(
    req('/api/orders', 'POST', {
      warehouse_id: warehouse,
      customer_name: 'QA Rezerwacja wariantu',
      email: 'qa@example.test',
      address: { street: 'Testowa 1', postcode: '00-001', city: 'Warszawa', country: 'PL' },
      items: [{ product_id: g.variants[0].id, quantity: 3 }],
    }),
    201,
  );
  const p = await good(variantPreview(ch, g.variants[0], parent.remote_id));
  assert.equal(p.payload.regular_price, '100.00');
  assert.equal(p.payload.stock_quantity, 7);
  assert.deepEqual(p.payload.attributes, [{ name: 'Kolor', option: 'Kolor 0' }]);
  assert.equal(p.payload.name, undefined);
  assert.equal(p.payload.type, undefined);
  const d = await queued(p);
  assert.equal(d.state, 'done', d.error);
  assert.equal(
    (await pool.query('SELECT parent_external_id FROM listings WHERE id=$1', [d.listing_id]))
      .rows[0].parent_external_id,
    parent.remote_id,
  );
  assert(
    calls.some(
      (c) => c.method === 'POST' && c.path.endsWith('/' + parent.remote_id + '/variations'),
    ),
  );
});
test('walutowy cennik wariantu nie zmienia ceny katalogu', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    v = g.variants[0];
  currency = 'EUR';
  tax = 'no';
  const l = await good(
    req('/api/price-lists', 'POST', { name: 'EUR warianty', currency: 'EUR' }),
    201,
  );
  await good(
    req('/api/price-lists/' + l.id + '/items', 'PUT', {
      version: 1,
      items: [{ product_id: v.id, price: 1234 }],
    }),
  );
  const p = await good(variantPreview(ch, v, parent.remote_id, { price_list_id: l.id }));
  assert.equal(p.payload.regular_price, '10.03');
  const d = await queued(p);
  assert.equal(d.state, 'done');
  assert.deepEqual(
    (await pool.query('SELECT price,price_currency FROM listings WHERE id=$1', [d.listing_id]))
      .rows[0],
    { price: 1234, price_currency: 'EUR' },
  );
  assert.equal(
    (await pool.query('SELECT price FROM products WHERE id=$1', [v.id])).rows[0].price,
    12300,
  );
});
test('obcy SKU rodzica, niewłaściwy typ i niedozwolona opcja nie przechodzą podglądu', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    r = store.get(parent.remote_id),
    sku = r.sku;
  r.sku = 'Obcy';
  assert.equal((await variantPreview(ch, g.variants[0], parent.remote_id)).statusCode, 422);
  r.sku = sku;
  r.type = 'simple';
  assert.equal((await variantPreview(ch, g.variants[0], parent.remote_id)).statusCode, 422);
  r.type = 'variable';
  r.attributes[0].options = ['Inny'];
  assert.equal((await variantPreview(ch, g.variants[0], parent.remote_id)).statusCode, 422);
});
test('zmiana opcji rodzica po podglądzie zatrzymuje POST', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    p = await good(variantPreview(ch, g.variants[0], parent.remote_id));
  store.get(parent.remote_id).attributes[0].options.push('Nowy');
  const before = writes();
  const d = await queued(p);
  assert.equal(d.state, 'conflict');
  assert.equal(writes(), before);
});
test('utracony POST grupy i wariantu odzyskuje własny znacznik bez powtórnego tworzenia', async () => {
  const ch = await channel(),
    g = await group(),
    p = await good(preview(ch, g));
  lost = true;
  let d = await queued(p);
  assert.equal(d.phase, 'write_started');
  const count = writes();
  d = await execute(p.id);
  assert.equal(d.state, 'done');
  assert.equal(writes(), count);
  const v = await good(variantPreview(ch, g.variants[0], d.remote_id));
  lost = true;
  d = await queued(v);
  assert.equal(d.phase, 'write_started');
  const variantWrites = writes();
  await pool.query('UPDATE products SET price=9900,version=version+1 WHERE id=$1', [
    g.variants[0].id,
  ]);
  d = await execute(v.id);
  assert.equal(d.state, 'done', d.error);
  assert.equal(writes(), variantWrites);
  assert.equal(d.result.local_changed, true);
});
test('GET odzyskania obcego wariantu nie uprawnia do jego nadpisania', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    p = await good(variantPreview(ch, g.variants[0], parent.remote_id));
  lost = true;
  await queued(p);
  const r = [...store.values()].find((v) => v._parent === parent.remote_id);
  r.meta_data = [];
  const count = writes();
  const d = await execute(p.id);
  assert.equal(d.state, 'failed');
  assert.equal(writes(), count);
});
test('brak atrybutów po POST nie jest sukcesem; uzgodnienie odczytem nie powtarza zapisu', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    p = await good(variantPreview(ch, g.variants[0], parent.remote_id));
  corrupt = true;
  let d = await queued(p);
  assert.equal(d.phase, 'verify');
  assert.notEqual(d.state, 'done');
  await pool.query('UPDATE jobs SET max_attempts=attempts WHERE id=$1', [d.job_id]);
  d = await execute(p.id);
  assert.equal(d.state, 'failed');
  const count = writes();
  await good(req('/api/offer-plans/' + p.id + '/reconcile', 'POST', { accept_observed: true }));
  d = await execute(p.id);
  assert.equal(d.state, 'done');
  assert.equal(d.result.desired_applied, false);
  assert.equal(d.result.scope, 'external_api_observed');
  assert.equal(writes(), count);
});
test('zmiana lokalnego stanu podczas GET zatrzymuje zapis przed POST', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    p = await good(variantPreview(ch, g.variants[0], parent.remote_id));
  await good(req('/api/offer-plans/' + p.id + '/queue', 'POST', {}));
  afterRead = async () => {
    await pool.query('UPDATE stock SET on_hand=on_hand+1,version=version+1 WHERE product_id=$1', [
      g.variants[0].id,
    ]);
  };
  const before = writes();
  const d = await execute(p.id);
  assert.equal(d.state, 'conflict');
  assert.equal(writes(), before);
});
test('odebrana rola administratora zatrzymuje zapis przed POST', async () => {
  const ch = await channel(),
    g = await group(),
    p = await good(preview(ch, g));
  await good(req('/api/offer-plans/' + p.id + '/queue', 'POST', {}));
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    actor,
  ]);
  const count = writes();
  try {
    const d = await execute(p.id);
    assert.equal(d.state, 'failed');
    assert.equal(writes(), count);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actor,
    ]);
  }
});
test('zmiana połączenia po podglądzie blokuje kolejkę', async () => {
  const ch = await channel(),
    g = await group(),
    p = await good(preview(ch, g));
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"connection_id":"changed"}\'::jsonb WHERE id=$1',
    [ch.id],
  );
  assert.equal((await req('/api/offer-plans/' + p.id + '/queue', 'POST', {})).statusCode, 409);
});
test('symulacja obsługuje grupę, wariant i publikację bez jakiegokolwiek transportu', async () => {
  const ch = await channel(true),
    g = await group(),
    before = calls.length,
    parent = await createdGroup(ch, g),
    v = await good(variantPreview(ch, g.variants[0], parent.remote_id));
  const d = await queued(v);
  assert.equal(d.state, 'done', d.error);
  const pub = await good(
    preview(ch, g, {
      operation: 'publish',
      variation_axes: undefined,
      listing_id: parent.listing_id,
    }),
  );
  assert.equal((await queued(pub)).state, 'done');
  assert.equal(calls.length, before);
});
test('61 wariantów otrzymuje pełny podgląd, kursor i idempotentne zatwierdzenie; przed zgodą brak POST', async () => {
  const ch = await channel(true),
    g = await group(61),
    parent = await createdGroup(ch, g),
    key = randomUUID(),
    b = await start(ch, g, parent.remote_id, { client_key: key });
  const same = await start(ch, g, parent.remote_id, { client_key: key });
  assert.equal(same.id, b.id);
  const r = await prepare(b, 61);
  assert.equal(r.counts.preview, 61);
  assert.equal(r.data.length, 25);
  const ids = r.data.map((v: any) => v.id);
  let cursor = r.meta.cursor;
  while (cursor) {
    const page = await good(req('/api/variant-batches/' + b.id + '?after=' + cursor));
    ids.push(...page.data.map((v: any) => v.id));
    cursor = page.meta.cursor;
  }
  assert.equal(new Set(ids).size, 61);
  const version = r.batch.version;
  await good(req('/api/variant-batches/' + b.id + '/queue', 'POST', { version }));
  await good(req('/api/variant-batches/' + b.id + '/queue', 'POST', { version }));
  const done = await completeBatch(b, 250);
  assert.equal(done.state, 'done');
  assert.equal((await good(req('/api/variant-batches/' + b.id))).counts.done, 61);
  assert.equal(
    (await good(req('/api/variant-batches/' + b.id + '/queue', 'POST', { version }))).state,
    'done',
  );
});
test('kontrakt API: batch GET-only podgląd, zgoda także sandbox, create/publish wariantów i rodzica', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    before = writes(),
    b = await start(ch, g, parent.remote_id),
    r = await prepare(b, 2);
  assert.equal(writes(), before);
  assert.equal(
    (await req('/api/variant-batches/' + b.id + '/queue', 'POST', { version: r.batch.version }))
      .statusCode,
    422,
  );
  await good(
    req('/api/variant-batches/' + b.id + '/queue', 'POST', {
      version: r.batch.version,
      confirm_external: true,
    }),
  );
  assert.equal((await completeBatch(b)).state, 'done');
  const publish = await start(ch, g, parent.remote_id, { operation: 'publish' }),
    review = await prepare(publish, 2);
  await good(
    req('/api/variant-batches/' + publish.id + '/queue', 'POST', {
      version: review.batch.version,
      confirm_external: true,
    }),
  );
  assert.equal((await completeBatch(publish)).state, 'done');
  assert(
    [...store.values()]
      .filter((v) => v._parent === parent.remote_id)
      .every((v) => v.status === 'publish'),
  );
  const pub = await good(
    preview(ch, g, {
      operation: 'publish',
      variation_axes: undefined,
      listing_id: parent.listing_id,
    }),
  );
  assert.equal((await queued(pub)).state, 'done');
  assert.equal(store.get(parent.remote_id).status, 'publish');
});
test('błąd jednego wariantu daje partial, zachowuje wynik pozostałego i pozwala uzgodnić bez duplikatu', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    b = await start(ch, g, parent.remote_id),
    r = await prepare(b, 2);
  failSku = g.variants[0].sku;
  await good(
    req('/api/variant-batches/' + b.id + '/queue', 'POST', {
      version: r.batch.version,
      confirm_external: true,
    }),
  );
  const done = await completeBatch(b);
  assert.equal(done.state, 'partial');
  let report = await good(req('/api/variant-batches/' + b.id));
  assert.equal(report.counts.failed, 1);
  assert.equal(report.counts.done, 1);
  failSku = '';
  const failed = report.data.find((i: any) => i.state === 'failed');
  await good(req('/api/offer-plans/' + failed.plan_id + '/reconcile', 'POST', {}));
  assert.equal((await execute(failed.plan_id)).state, 'done');
  await good(
    req('/api/variant-batches/' + b.id + '/recheck', 'POST', { version: report.batch.version }),
  );
  assert.equal((await completeBatch(b)).state, 'done');
  assert.equal([...store.values()].filter((v) => v._parent === parent.remote_id).length, 2);
});
test('ponowne tworzenie pomija istniejące powiązania rodzica i nie tworzy kolejnych wariantów', async () => {
  const ch = await channel(true),
    g = await group(),
    parent = await createdGroup(ch, g),
    b = await start(ch, g, parent.remote_id),
    r = await prepare(b, 2);
  await good(req('/api/variant-batches/' + b.id + '/queue', 'POST', { version: r.batch.version }));
  await completeBatch(b);
  const again = await start(ch, g, parent.remote_id),
    review = await prepare(again, 2);
  assert.equal(review.counts.skipped, 2);
  assert.equal(review.counts.preview, undefined);
  assert.equal(
    (
      await req('/api/variant-batches/' + again.id + '/queue', 'POST', {
        version: review.batch.version,
      })
    ).statusCode,
    422,
  );
});
test('przerwanie checkpointu blokuje starego workera i kolejne podglądy', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    b = await start(ch, g, parent.remote_id);
  await step(b.id);
  const row = await batch(b.id);
  await good(req('/api/variant-batches/' + b.id + '/cancel', 'POST', { version: row.version }));
  const before = calls.length;
  await step(b.id);
  assert.equal((await batch(b.id)).state, 'cancelled');
  assert.equal(calls.length, before);
  const report = await good(req('/api/variant-batches/' + b.id));
  assert.equal(report.counts.skipped, 2);
});
test('utrata połączenia zatrzymuje batch i zachowuje checkpoint; wznowienie pomija przygotowane', async () => {
  const ch = await channel(true),
    g = await group(),
    parent = await createdGroup(ch, g),
    b = await start(ch, g, parent.remote_id);
  await step(b.id);
  const original = (await pool.query('SELECT settings FROM channels WHERE id=$1', [ch.id])).rows[0]
    .settings;
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"connection_id":"new"}\'::jsonb WHERE id=$1',
    [ch.id],
  );
  const failed = await step(b.id);
  assert.equal(failed.state, 'failed');
  await pool.query('UPDATE channels SET settings=$2 WHERE id=$1', [
    ch.id,
    JSON.stringify(original),
  ]);
  await good(req('/api/variant-batches/' + b.id + '/retry', 'POST', { version: failed.version }));
  await step(b.id);
  await step(b.id);
  const r = await good(req('/api/variant-batches/' + b.id));
  assert.equal(r.batch.state, 'review');
  assert.equal(r.counts.preview, 2);
});
test('izolacja firmy, role i FORCE RLS obejmują operacje i pozycje wariantów', async () => {
  const ch = await channel(true),
    g = await group(),
    parent = await createdGroup(ch, g),
    b = await start(ch, g, parent.remote_id);
  for (const auth of [other, viewer]) {
    assert.equal(
      (await req('/api/variant-batches/' + b.id, 'GET', undefined, auth)).statusCode,
      auth === viewer ? 403 : 404,
    );
    assert.equal(
      (await req('/api/variant-batches/' + b.id + '/queue', 'POST', { version: 1 }, auth))
        .statusCode,
      auth === viewer ? 403 : 404,
    );
  }
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal(
      (await c.query('SELECT id FROM variant_offer_batches WHERE id=$1', [b.id])).rowCount,
      0,
    );
    assert.equal(
      (await c.query('SELECT id FROM variant_offer_batch_items WHERE batch_id=$1', [b.id]))
        .rowCount,
      0,
    );
  });
  const r = await pool.query(
    "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('variant_offer_batches','variant_offer_batch_items')",
  );
  assert.equal(r.rowCount, 2);
  assert(r.rows.every((v) => v.relrowsecurity && v.relforcerowsecurity));
});

test('utracony POST ze zmienionymi atrybutami zatrzymuje odzyskanie bez drugiego POST', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    p = await good(variantPreview(ch, g.variants[0], parent.remote_id));
  lost = true;
  corrupt = true;
  await queued(p);
  const before = writes();
  const d = await execute(p.id);
  assert.equal(d.state, 'failed');
  assert.equal(d.phase, 'write_started');
  assert.equal(writes(), before);
  await good(req('/api/offer-plans/' + p.id + '/reconcile', 'POST', { accept_observed: true }));
  const observed = await execute(p.id);
  assert.equal(observed.state, 'done');
  assert.equal(observed.result.desired_applied, false);
  assert.equal(writes(), before);
});
test('odebrana dzierżawa podczas POST nie zapisuje wyniku; nowy worker odzyskuje wariant przez GET', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    p = await good(variantPreview(ch, g.variants[0], parent.remote_id));
  await good(req('/api/offer-plans/' + p.id + '/queue', 'POST', {}));
  const plan = await getPlan(p.id);
  afterWrite = async () => {
    await pool.query(
      "UPDATE jobs SET state='pending',lease_token=NULL,locked_at=NULL WHERE id=$1",
      [plan.job_id],
    );
  };
  let d = await execute(p.id);
  assert.equal(d.state, 'queued');
  assert.equal(d.remote_id, null);
  const before = writes();
  afterWrite = undefined;
  d = await execute(p.id);
  assert.equal(d.state, 'done');
  assert.equal(writes(), before);
});
test('anulowany batch zachowuje wynik już zakolejkowanego wariantu i nie kolejkuje reszty', async () => {
  const ch = await channel(true),
    g = await group(),
    parent = await createdGroup(ch, g),
    b = await start(ch, g, parent.remote_id),
    r = await prepare(b, 2);
  await good(req('/api/variant-batches/' + b.id + '/queue', 'POST', { version: r.batch.version }));
  await step(b.id);
  const row = await batch(b.id);
  await good(req('/api/variant-batches/' + b.id + '/cancel', 'POST', { version: row.version }));
  let report = await good(req('/api/variant-batches/' + b.id));
  assert.equal(report.counts.skipped, 1);
  assert.equal(report.counts.queued, 1);
  const active = report.data.find((v: any) => v.state === 'queued');
  assert.equal((await execute(active.plan_id)).state, 'done');
  await step(b.id);
  report = await good(req('/api/variant-batches/' + b.id));
  assert.equal(report.batch.state, 'cancelled');
  assert.equal(report.data.find((v: any) => v.state === 'queued').plan_state, 'done');
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM listings WHERE channel_id=$1 AND parent_external_id=$2',
        [ch.id, parent.remote_id],
      )
    ).rows[0].n,
    1,
  );
});
test('harmonogram ceny i stanu pomija grupę, obejmując wszystkie warianty', async () => {
  const { processOfferSync } = await import('../server/offer-sync');
  const ch = await channel(true),
    g = await group(),
    parent = await createdGroup(ch, g),
    b = await start(ch, g, parent.remote_id),
    r = await prepare(b, 2);
  await good(req('/api/variant-batches/' + b.id + '/queue', 'POST', { version: r.batch.version }));
  await completeBatch(b);
  await good(
    req('/api/integrations/' + ch.id + '/offer-sync', 'PATCH', {
      version: 0,
      enabled: true,
      warehouse_id: warehouse,
      stock: true,
      price: true,
      interval_seconds: 30,
      verify_seconds: 60,
    }),
  );
  const j = await good(req('/api/integrations/' + ch.id + '/offer-sync', 'POST', {}));
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [j.id, randomUUID()],
    )
  ).rows[0];
  await processOfferSync(job, ctx);
  const items = (
    await pool.query(
      'SELECT l.product_id FROM offer_sync_items i JOIN listings l ON l.id=i.listing_id WHERE i.channel_id=$1',
      [ch.id],
    )
  ).rows;
  assert.equal(items.length, 2);
  assert(!items.some((v) => v.product_id === g.id));
  assert.deepEqual(
    new Set(items.map((v) => v.product_id)),
    new Set(g.variants.map((v: any) => v.id)),
  );
});

test('uzgodnienie batcha odczytem bez utworzonego wariantu pozostawia partial i jawny brak zmiany', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g),
    b = await start(ch, g, parent.remote_id),
    r = await prepare(b, 2);
  failSku = g.variants[0].sku;
  await good(
    req('/api/variant-batches/' + b.id + '/queue', 'POST', {
      version: r.batch.version,
      confirm_external: true,
    }),
  );
  assert.equal((await completeBatch(b)).state, 'partial');
  let report = await good(req('/api/variant-batches/' + b.id));
  const failed = report.data.find((v: any) => v.state === 'failed');
  failSku = '';
  await good(
    req('/api/offer-plans/' + failed.plan_id + '/reconcile', 'POST', { accept_observed: true }),
  );
  assert.equal((await execute(failed.plan_id)).result.desired_applied, false);
  const before = writes();
  await good(
    req('/api/variant-batches/' + b.id + '/recheck', 'POST', { version: report.batch.version }),
  );
  assert.equal((await completeBatch(b)).state, 'partial');
  report = await good(req('/api/variant-batches/' + b.id));
  assert.equal(report.counts.failed, 1);
  assert.equal(report.counts.done, 1);
  assert.match(report.data.find((v: any) => v.state === 'failed').error, /nie jest potwierdzona/);
  assert.equal(writes(), before);
});

test('globalny parametr rodzica zachowuje ID taksonomii w POST wariantu', async () => {
  const ch = await channel(),
    g = await group(),
    parent = await createdGroup(ch, g);
  store.get(parent.remote_id).attributes[0].id = 7;
  const p = await good(variantPreview(ch, g.variants[0], parent.remote_id));
  assert.deepEqual(p.payload.attributes, [{ id: 7, name: 'Kolor', option: 'Kolor 0' }]);
  const d = await queued(p);
  assert.equal(d.state, 'done', d.error);
  assert.equal(
    calls
      .filter((c) => c.method === 'POST' && c.path.endsWith('/' + parent.remote_id + '/variations'))
      .at(-1)!.body.attributes[0].id,
    7,
  );
});
