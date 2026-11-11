import {
  ebayApplicationHash,
  ebayApiScope,
  ebaySimulationApplication,
} from '../server/ebay-api-limits';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt, decrypt } from '../server/security';
import {
  Ebay,
  ebayReadScopes,
  EBAY_READ_SCOPE,
  EBAY_INVENTORY_SCOPE,
  EBAY_INVENTORY_WRITE_SCOPE,
  EBAY_ACCOUNT_READ_SCOPE,
} from '../server/ebay';
import { validateEbayAspects } from '../server/ebay-seller-settings';
import { processOfferJob, failOffer } from '../server/offers';
import { processOfferSync, failOfferSync } from '../server/offer-sync';
import { readEbayOffer, ebayPayload, ebayAffectedOffers } from '../server/ebay-offers';
import { ebayOfferFixture } from './ebay-offer-fixture';
import {
  EbayRevisionWait,
  ebayRevisionListings,
  ebayRevisionScope,
  reserveEbayRevisions,
} from '../server/ebay-revision-budget';
import { ebaySecrets } from './ebay-fixture';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  viewer = '',
  other = '',
  warehouse = '',
  user = '',
  f = ebayOfferFixture();
const ctx = { transport: (u: string, i: RequestInit) => f.transport(u, i) };
let testIp = 1;
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    remoteAddress: '127.0.' + Math.floor(testIp / 250) + '.' + ((++testIp % 250) + 1),
    url: '/api' + p,
    method,
    payload,
    headers: { cookie: auth, ...(p === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
const ok = async (p: string, method: any = 'GET', payload?: any) => {
  const r = await req(p, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: ctx.transport });
  const login = async (email: string) =>
    (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  user = (await ok('/auth/me')).user.id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query('DELETE FROM ebay_api_leases; DELETE FROM ebay_api_buckets');
  f = ebayOfferFixture();
  await pool.query('DELETE FROM ebay_revision_attempts');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
});
afterEach(async () => {
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
});
async function fixture(
  access = 'orders_inventory_write',
  simulation = false,
  priceMode = 'gross',
  bind = true,
) {
  const ch = (
    await ok('/integrations', 'POST', {
      provider: 'ebay',
      name: 'eBay offers QA',
      mode: 'sandbox',
      credentials: ebaySecrets,
      settings: {
        inventory_access: access,
        marketplace_id: 'EBAY_DE',
        price_mode: priceMode,
      },
    })
  ).id;
  if (simulation)
    await pool.query(
      'UPDATE channels SET settings=settings||\'{"simulation":true}\'::jsonb WHERE id=$1',
      [ch],
    );
  const p = await ok('/products', 'POST', {
    sku: 'LOCAL-' + randomUUID(),
    name: 'Local SKU deliberately differs',
    price: 12300,
    vat: 23,
    quantity: 10,
    warehouse_id: warehouse,
  });
  const l = await ok(`/integrations/${ch}/mappings`, 'POST', { external_id: f.sku, sku: p.sku });
  if (bind && (access === 'orders_inventory_write' || simulation))
    await ok(`/integrations/${ch}/ebay-account/verify`, 'POST', {});
  return { ch, p, l };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const preview = (x: Fixture, extra: any = {}, auth = cookie) =>
  req(
    `/integrations/${x.ch}/offers/preview`,
    'POST',
    {
      product_id: x.p.id,
      listing_id: x.l.id,
      warehouse_id: warehouse,
      operation: 'sync',
      ...extra,
    },
    auth,
  );
async function plan(x: Fixture, extra: any = {}) {
  const r = await preview(x, extra);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const getPlan = async (p: any) =>
  (await pool.query('SELECT * FROM offer_plans WHERE id=$1', [p.id])).rows[0];
const queue = (p: any, confirm_live = true) =>
  ok(`/offer-plans/${p.id}/queue`, 'POST', { confirm_live });
const claim = async (id: string) =>
  (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
async function execute(p: any) {
  const stored = await getPlan(p),
    job = await claim(stored.job_id);
  try {
    await processOfferJob(job, ctx);
  } catch (e) {
    await failOffer(job, e);
  }
  return getPlan(p);
}
const writes = () => f.calls.filter((c) => c.url.endsWith('/bulk_update_price_quantity'));
const stock = async (x: Fixture) =>
  (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [x.p.id])).rows;
const configure = (x: Fixture, extra: any = {}) =>
  ok(`/integrations/${x.ch}/offer-sync`, 'PATCH', {
    version: 0,
    enabled: true,
    warehouse_id: warehouse,
    stock: true,
    price: true,
    interval_seconds: 60,
    verify_seconds: 300,
    confirm_external: true,
    ...extra,
  });

test('published SKU sync sends minimal POST once, preserves other market, content, local stock and reserved units', async () => {
  const x = await fixture();
  await ok('/orders', 'POST', {
    customer_name: 'QA reservation',
    email: 'qa@example.test',
    warehouse_id: warehouse,
    address: { country: 'PL' },
    items: [{ product_id: x.p.id, quantity: 2 }],
  });
  const content = structuredClone(f.inventory.product),
    uk = structuredClone(f.offers[1]);
  const p = await plan(x);
  assert.equal(p.quantity, 8);
  assert.equal(p.before.offer_id, 'DEMO-OFFER-0');
  assert.equal(p.affected_offers.length, 2);
  assert.equal(p.affected_offers[1].price_changes, false);
  assert.deepEqual(p.payload, {
    requests: [
      {
        sku: f.sku,
        shipToLocationAvailability: { quantity: 8 },
        offers: [
          {
            offerId: 'DEMO-OFFER-0',
            availableQuantity: 8,
            price: { value: '123.00', currency: 'PLN' },
          },
        ],
      },
    ],
  });
  await queue(p);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.desired_applied, true);
  assert.equal(done.result.scope, 'external_api_verified');
  assert.equal(writes().length, 1);
  assert.deepEqual(f.offers[1], uk);
  assert.deepEqual(f.inventory.product, content);
  assert.deepEqual(await stock(x), [{ on_hand: 10, reserved: 2 }]);
  const listing = (await pool.query('SELECT * FROM listings WHERE id=$1', [x.l.id])).rows[0];
  assert.equal(listing.last_result.stock_quantity, 8);
  assert.equal(listing.last_result.inventory_quantity, 8);
  assert.equal(listing.last_result.ebay_offer_snapshot.offer_id, 'DEMO-OFFER-0');
  assert.equal((await plan(x)).before.regular_price, '123.00');
});
test('price-only and stock-only plans preserve fields, currency selection and net/gross rules', async () => {
  const x = await fixture('orders_inventory_write', false, 'net');
  const p = await plan(x, { stock: false });
  assert.equal(p.payload.requests[0].offers[0].price.value, '100.00');
  assert.equal(p.payload.requests[0].shipToLocationAvailability, undefined);
  assert.equal(p.payload.requests[0].offers[0].availableQuantity, undefined);
  // Change price so this path actually writes rather than taking the unchanged shortcut.
  await pool.query('UPDATE products SET price=24600,version=version+1 WHERE id=$1', [x.p.id]);
  const price = await plan(x, { stock: false });
  await queue(price);
  assert.equal((await execute(price)).state, 'done');
  assert.equal(f.offers[0].pricingSummary.price.value, '200.00');
  assert.equal(f.inventory.availability.shipToLocationAvailability.quantity, 12);
  const s = await plan(x, { price: false });
  assert.equal(s.payload.requests[0].offers[0].price, undefined);
  await queue(s);
  assert.equal((await execute(s)).state, 'done');
  assert.equal(f.offers[0].pricingSummary.price.value, '200.00');
  f.offers[0].pricingSummary.price.currency = 'EUR';
  assert.equal((await preview(x)).statusCode, 422);
});
test('read-only consent can preview but cannot queue or enable writes; sandbox requires external confirmation', async () => {
  const x = await fixture('orders_inventory');
  f.state.scope = EBAY_READ_SCOPE + ' ' + EBAY_INVENTORY_SCOPE;
  const p = await plan(x);
  assert.equal(
    (await req(`/offer-plans/${p.id}/queue`, 'POST', { confirm_live: true })).statusCode,
    422,
  );
  assert.equal(
    (
      await req(`/integrations/${x.ch}/offer-sync`, 'PATCH', {
        version: 0,
        enabled: true,
        warehouse_id: warehouse,
        stock: true,
        price: true,
        interval_seconds: 60,
        verify_seconds: 300,
        confirm_external: true,
      })
    ).statusCode,
    422,
  );
  const writable = await fixture();
  f.state.scope = EBAY_READ_SCOPE + ' ' + EBAY_INVENTORY_WRITE_SCOPE;
  const w = await plan(writable);
  assert.equal((await req(`/offer-plans/${w.id}/queue`, 'POST', {})).statusCode, 422);
  assert.equal(writes().length, 0);
  assert.equal(ebayReadScopes({ inventory_access: 'orders_inventory_write' }), f.state.scope);
});
test('lost reply after applying every field is reconciled by GET, without a second POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.result = 'lost';
  const uncertain = await execute(p);
  assert.equal(uncertain.phase, 'write_started');
  assert.equal(uncertain.state, 'queued');
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(writes().length, 1);
});
test('partial 207 remains uncertain; explicit observed reconciliation records actual state without POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.result = 'partial';
  assert.equal((await execute(p)).phase, 'write_started');
  const failed = await execute(p);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /bez powtarzania POST/);
  assert.equal((await preview(x)).statusCode, 200); // A fresh preview is readable but cannot bypass an unresolved write.
  const next = await plan(x);
  assert.equal(
    (await req(`/offer-plans/${next.id}/queue`, 'POST', { confirm_live: true })).statusCode,
    409,
  );
  await ok(`/offer-plans/${p.id}/reconcile`, 'POST', { accept_observed: true });
  const done = await execute(p);
  assert.equal(done.state, 'done');
  assert.equal(done.result.desired_applied, false);
  assert.equal(done.result.verified_payload, undefined);
  assert.equal(done.result.actual_snapshot.stock_quantity, 10);
  assert.equal(done.result.actual_snapshot.regular_price, '100.00');
  assert.equal(writes().length, 1);
});
test('207 with all desired values applied is still reconciled instead of POST retry', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.result = '207';
  assert.equal((await execute(p)).phase, 'write_started');
  assert.equal((await execute(p)).state, 'done');
  assert.equal(writes().length, 1);
});
test('explicit provider rejection does not replay POST and can be accepted as unchanged observation', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.result = 'reject';
  await execute(p);
  assert.equal((await execute(p)).state, 'failed');
  assert.equal(writes().length, 1);
  await ok(`/offer-plans/${p.id}/reconcile`, 'POST', { accept_observed: true });
  assert.equal((await execute(p)).result.desired_applied, false);
  assert.equal(writes().length, 1);
});
test('all-SKU pagination includes drafts and auctions, preserves other allocations, rejects changed next filters', async () => {
  f.state.token = 1;
  const c = new Ebay('sandbox', { access_token: 'EBAY-OFFERS-1' }, f.transport);
  for (let n = 0; n < 25; n++)
    f.offers.push({
      offerId: 'DRAFT-' + n,
      sku: f.sku,
      marketplaceId: 'EBAY_FR',
      format: 'FIXED_PRICE',
      status: 'UNPUBLISHED',
    });
  const r = await readEbayOffer(c, f.sku, 'EBAY_DE');
  assert.equal(r.offers.length, 27);
  assert(f.calls.some((c) => new URL(c.url).searchParams.get('offset') === '1'));
  const draftScope = ebayAffectedOffers(r, ebayPayload(r, 3, 12300));
  assert.equal(draftScope.find((o) => o.offer_id === 'DRAFT-0')?.quantity_after, null);
  f.state.edit = (u, v) => {
    if (u.pathname.endsWith('/offer') && u.searchParams.get('offset') === '0')
      v.next = 'https://evil.test/?offset=1';
  };
  await assert.rejects(() => readEbayOffer(c, f.sku, 'EBAY_DE'), /zakres Inventory/);
});
test('unpublished, multiple selected, on-hold, lot and auction allocations require correct scope', async () => {
  const x = await fixture();
  f.offers[0].status = 'UNPUBLISHED';
  assert.equal((await preview(x)).statusCode, 422);
  f.offers[0].status = 'PUBLISHED';
  f.offers.push({ ...structuredClone(f.offers[0]), offerId: 'SECOND-DE' });
  assert.equal((await preview(x)).statusCode, 422);
  assert.equal((await preview(x, { ebay_offer_id: 'SECOND-DE' })).statusCode, 200);
  f.offers.pop();
  f.offers[0].listing.listingOnHold = true;
  assert.equal((await preview(x)).statusCode, 409);
  delete f.offers[0].listing.listingOnHold;
  f.offers[0].lotSize = 2;
  assert.equal((await preview(x)).statusCode, 422);
  assert.equal((await preview(x, { stock: false })).statusCode, 200);
  delete f.offers[0].lotSize;
  f.offers.push({
    ...structuredClone(f.offers[0]),
    offerId: 'AUCTION',
    format: 'AUCTION',
    availableQuantity: 11,
  });
  assert.equal((await preview(x)).statusCode, 409);
});
test('price/quantity drift of another market prevents write before mutation', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.offers[1].availableQuantity = 4;
  const failed = await execute(p);
  assert.equal(failed.state, 'conflict');
  assert.equal(writes().length, 0);
});
test('incomplete or foreign provider snapshots cannot create a plan or send a write', async () => {
  const x = await fixture();
  for (const bad of ['sku', 'inventory', 'offer', 'money']) {
    f.state.edit = (u, v) => {
      if (u.pathname.includes('/inventory_item/') && bad === 'inventory') delete v.availability;
      if (u.pathname.endsWith('/offer')) {
        if (bad === 'sku') v.offers[0].sku = 'FOREIGN';
        if (bad === 'offer') v.offers[0] = null;
        if (bad === 'money') v.offers[0].pricingSummary.price.value = '9999999999999999999999.00';
      }
    };
    assert.equal((await preview(x)).statusCode, 502, bad);
  }
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM offer_plans WHERE channel_id=$1', [x.ch]))
      .rows[0].n,
    0,
  );
  assert.equal(writes().length, 0);
});
test('credential change invalidates plan and schedule but OAuth access-token rotation does not', async () => {
  const x = await fixture(),
    p = await plan(x);
  await configure(x);
  const channel = (await pool.query('SELECT * FROM channels WHERE id=$1', [x.ch])).rows[0];
  const creds = decrypt(channel.credentials);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    x.ch,
    encrypt({ ...creds, access_token: 'changed-cache' }),
  ]);
  await queue(p); // cache refresh is permitted; connection identity is stable
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    x.ch,
    encrypt({ ...creds, client_id: 'DIFFERENT-client' }),
  ]);
  assert.equal((await execute(p)).state, 'conflict');
  assert.equal(writes().length, 0);
  assert.equal((await req(`/integrations/${x.ch}/offer-sync`, 'POST', {})).statusCode, 409);
});
test('role, mapping and local-stock changes during provider reads fence mutation', async () => {
  for (const reason of ['role', 'mapping', 'stock']) {
    const x = await fixture(),
      p = await plan(x);
    await queue(p);
    f.state.hook = async (u, m) => {
      if (m === 'GET' && u.pathname.endsWith('/offer')) {
        f.state.hook = undefined;
        if (reason === 'role')
          await pool.query(
            "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
            [DEMO_TENANT, user],
          );
        else if (reason === 'mapping')
          await pool.query("UPDATE listings SET external_id='DIFFERENT-SKU' WHERE id=$1", [x.l.id]);
        else
          await pool.query(
            'UPDATE stock SET on_hand=on_hand+1,version=version+1 WHERE product_id=$1',
            [x.p.id],
          );
      }
    };
    const done = await execute(p);
    assert(['conflict', 'failed'].includes(done.state), done.error);
    assert.equal(writes().length, 0);
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      user,
    ]);
  }
});
test('preview blocks revoked admin before subsequent HTTP and tenant/viewer access remains isolated', async () => {
  const x = await fixture();
  assert.equal((await preview(x, {}, viewer)).statusCode, 403);
  assert.equal((await preview(x, {}, other)).statusCode, 404);
  f.state.hook = async (u, m) => {
    if (m === 'GET' && u.pathname.includes('/inventory_item/'))
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
  };
  assert.equal((await preview(x)).statusCode, 403);
  assert.equal(f.calls.filter((c) => new URL(c.url).pathname.endsWith('/offer')).length, 0);
});
test('automatic sync queues changed values, acknowledges verification, skips fresh checks and stops after pause', async () => {
  const x = await fixture();
  await plan(x); // Acquire and verify the explicitly configured write scope before enabling a schedule.
  await configure(x);
  const tick = async () => {
    const d = await ok(`/integrations/${x.ch}/offer-sync`, 'POST', {});
    await processOfferSync(await claim(d.id), ctx);
    return d;
  };
  await tick();
  const p = (
    await pool.query("SELECT * FROM offer_plans WHERE channel_id=$1 AND state='queued'", [x.ch])
  ).rows[0];
  assert(p);
  assert.equal((await execute(p)).state, 'done');
  await tick();
  const item = (await pool.query('SELECT * FROM offer_sync_items WHERE channel_id=$1', [x.ch]))
    .rows[0];
  assert(item.verified_hash);
  assert.equal(writes().length, 1);
  const callsBefore = f.calls.length;
  await tick();
  assert.equal(f.calls.length, callsBefore);
  await pool.query('UPDATE stock SET on_hand=7,version=version+1 WHERE product_id=$1', [x.p.id]);
  await tick();
  const pending = (
    await pool.query("SELECT * FROM offer_plans WHERE channel_id=$1 AND state='queued'", [x.ch])
  ).rows[0];
  assert(pending);
  await configure(x, { version: 1, enabled: false });
  assert.equal((await getPlan(pending)).state, 'conflict');
  assert.equal(writes().length, 1);
});
test('401 after POST refreshes OAuth and reconciles from persisted verify phase without replay', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.afterWrite = async () => {
    f.state.unauthorizedOnce = true;
  };
  const uncertain = await execute(p);
  assert.equal(uncertain.phase, 'verify');
  assert.equal(uncertain.state, 'queued');
  assert.equal(f.state.token, 2);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(writes().length, 1);
});
test('lease loss after POST prevents local completion and next owner recovers only by GET', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  f.state.afterWrite = async () => {
    await pool.query(
      "UPDATE jobs SET state='pending',lease_token=NULL,locked_at=NULL WHERE id=(SELECT job_id FROM offer_plans WHERE id=$1)",
      [p.id],
    );
  };
  const uncertain = await execute(p);
  assert.equal(uncertain.phase, 'write_started');
  assert.equal(uncertain.state, 'queued');
  assert.equal(
    (await pool.query('SELECT last_result FROM listings WHERE id=$1', [x.l.id])).rows[0]
      .last_result,
    null,
  );
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(writes().length, 1);
});
test('provider ending a listing at quantity zero is a visible uncertain result that can be observed', async () => {
  const x = await fixture();
  await pool.query('UPDATE stock SET on_hand=0,version=version+1 WHERE product_id=$1', [x.p.id]);
  const p = await plan(x, { price: false });
  await queue(p);
  f.state.afterWrite = async () => {
    f.offers[0].listing.listingStatus = 'ENDED';
  };
  assert.equal((await execute(p)).phase, 'verify');
  assert.equal((await execute(p)).state, 'failed');
  await ok(`/offer-plans/${p.id}/reconcile`, 'POST', { accept_observed: true });
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.actual_snapshot.offers[0].listing.listingStatus, 'ENDED');
  assert.equal(writes().length, 1);
});
test('paused schedule after uncertain POST accepts observed state without a new mutation', async () => {
  const x = await fixture();
  await plan(x);
  await configure(x);
  const d = await ok(`/integrations/${x.ch}/offer-sync`, 'POST', {});
  await processOfferSync(await claim(d.id), ctx);
  const p = (
    await pool.query("SELECT * FROM offer_plans WHERE channel_id=$1 AND state='queued'", [x.ch])
  ).rows[0];
  f.state.afterWrite = async () => {
    await configure(x, { version: 1, enabled: false });
  };
  const uncertain = await execute(p);
  assert.equal(uncertain.state, 'failed');
  assert.equal(uncertain.phase, 'write_started');
  await ok(`/offer-plans/${p.id}/reconcile`, 'POST', {});
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.scope, 'external_api_observed');
  assert.equal(done.result.desired_applied, true);
  assert.equal(writes().length, 1);
});
test('explicitly selected published offer is remembered for subsequent previews and scheduled sync', async () => {
  const x = await fixture();
  f.offers.push({ ...structuredClone(f.offers[0]), offerId: 'SECOND-DE' });
  const p = await plan(x, { ebay_offer_id: 'SECOND-DE' });
  await queue(p);
  assert.equal((await execute(p)).state, 'done');
  assert.equal((await plan(x)).before.offer_id, 'SECOND-DE');
  await configure(x);
  const d = await ok(`/integrations/${x.ch}/offer-sync`, 'POST', {});
  await processOfferSync(await claim(d.id), ctx);
  const last = (
    await pool.query('SELECT state,error FROM offer_sync_items WHERE channel_id=$1', [x.ch])
  ).rows[0];
  assert.equal(last.state, 'unchanged', last.error);
  assert.equal(writes().length, 1);
});
test('connection changed during final GET cannot persist old-account results; restoring it reconciles without POST', async () => {
  const x = await fixture(),
    p = await plan(x);
  await queue(p);
  const credentials = (await pool.query('SELECT credentials FROM channels WHERE id=$1', [x.ch]))
    .rows[0].credentials;
  f.state.afterWrite = async () => {
    f.state.hook = async (u, m) => {
      if (m === 'GET' && u.pathname.endsWith('/offer')) {
        f.state.hook = undefined;
        await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
          x.ch,
          encrypt({ ...decrypt(credentials), client_id: 'OTHER-client' }),
        ]);
      }
    };
  };
  const failed = await execute(p);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.phase, 'verify');
  assert.equal(
    (await pool.query('SELECT last_result FROM listings WHERE id=$1', [x.l.id])).rows[0]
      .last_result,
    null,
  );
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [x.ch, credentials]);
  await ok(`/offer-plans/${p.id}/reconcile`, 'POST', {});
  assert.equal((await execute(p)).state, 'done');
  assert.equal(writes().length, 1);
});
test('simulation preserves exact remote SKU and reuses persisted snapshot, without external HTTP', async () => {
  const x = await fixture('orders', true),
    p = await plan(x);
  await queue(p, false);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.scope, 'local_simulation');
  assert.equal(f.calls.length, 0);
  const second = await plan(x);
  assert.equal(second.before.stock_quantity, 10);
  assert.equal(second.before.regular_price, '123.00');
  assert.equal(second.before.id, f.sku);
  assert.equal(second.before.offers[0].sku, f.sku);
});

const publicationInput = {
  operation: 'publish',
  ebay_offer_id: 'DEMO-OFFER-0',
  stock: false,
  price: false,
};
const publications = () => f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/publish'));
async function draft(simulation = false, bind = true) {
  const x = await fixture('orders_inventory_write', simulation, 'gross', bind);
  Object.assign(f.inventory, { condition: 'NEW' });
  Object.assign(f.inventory.product, {
    description: 'QA draft description',
    imageUrls: ['https://example.test/photo.jpg'],
  });
  Object.assign(f.offers[0], {
    status: 'UNPUBLISHED',
    categoryId: '123',
    merchantLocationKey: 'QA-LOCATION',
    listingDuration: 'GTC',
    listingPolicies: { paymentPolicyId: '1', returnPolicyId: '2', fulfillmentPolicyId: '3' },
  });
  delete f.offers[0].listing;
  if (simulation)
    await pool.query('UPDATE listings SET last_result=$2 WHERE id=$1', [
      x.l.id,
      JSON.stringify({
        ebay_offer_snapshot: {
          inventory: f.inventory,
          offers: f.offers,
          offer_id: 'DEMO-OFFER-0',
          publication_context: {
            offer: f.offers[0],
            location: {
              merchantLocationKey: 'QA-LOCATION',
              merchantLocationStatus: 'ENABLED',
              location: { address: { country: 'DE', postalCode: '10115' } },
            },
          },
        },
      }),
    ]);
  if (bind) await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  return x;
}
test('publication sends one bodyless POST for an explicit draft; preserves price, policies, pool, other markets and local stock', async () => {
  const x = await draft(),
    beforeStock = await stock(x),
    uk = structuredClone(f.offers[1]),
    product = structuredClone(f.inventory.product);
  const p = await plan(x, publicationInput);
  assert.deepEqual(p.payload, { offer_id: 'DEMO-OFFER-0', publish: true });
  assert.equal(p.publication.price.value, '100.00');
  assert.equal(p.affected_offers, undefined);
  assert.equal(
    (await req(`/offer-plans/${p.id}/queue`, 'POST', { confirm_live: false })).statusCode,
    422,
  );
  await queue(p);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.desired_applied, true);
  assert.deepEqual(done.result.ebay_publication, {
    offer_id: 'DEMO-OFFER-0',
    listing_id: 'QA-LISTING-067',
    status: 'PUBLISHED',
  });
  assert.equal(publications().length, 1);
  assert.equal(writes().length, 0);
  assert.equal(publications()[0].payload, undefined);
  assert.deepEqual(f.offers[1], uk);
  assert.deepEqual(f.inventory.product, product);
  assert.equal(f.offers[0].pricingSummary.price.value, '100.00');
  assert.deepEqual(await stock(x), beforeStock);
  const listing = (await pool.query('SELECT * FROM listings WHERE id=$1', [x.l.id])).rows[0];
  assert.equal(
    listing.last_result.ebay_offer_snapshot.publication_context.offer.listing.listingId,
    'QA-LISTING-067',
  );
  assert.equal(listing.price, x.p.price);
});
test('publication requires identity, explicit offer ID, price/stock disabled and an administrator in the same tenant', async () => {
  const x = await draft(false, false);
  assert.equal((await preview(x, publicationInput)).statusCode, 409);
  await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  for (const extra of [
    { ebay_offer_id: undefined },
    { stock: true },
    { price: true },
    { ebay_offer_id: 'OFFER-UK' },
    { ebay_offer_id: 'UNKNOWN' },
  ])
    assert.equal((await preview(x, { ...publicationInput, ...extra })).statusCode, 422);
  assert.equal((await preview(x, publicationInput, viewer)).statusCode, 403);
  assert.equal((await preview(x, publicationInput, other)).statusCode, 404);
  assert.equal(publications().length, 0);
});
test('publication rejects missing policies, disabled location, missing image and grouped Inventory; never sends POST', async () => {
  const x = await draft();
  for (const edit of [
    (u: URL, v: any) => {
      if (u.pathname.endsWith('/DEMO-OFFER-0')) delete v.listingPolicies.returnPolicyId;
    },
    (u: URL, v: any) => {
      if (u.pathname.includes('/location/')) v.merchantLocationStatus = 'DISABLED';
    },
    (u: URL, v: any) => {
      if (u.pathname.includes('/inventory_item/')) v.product.imageUrls = [];
    },
    (u: URL, v: any) => {
      if (u.pathname.includes('/inventory_item/')) v.inventoryItemGroupKeys = ['GROUP'];
    },
  ]) {
    f.state.edit = edit;
    const r = await preview(x, publicationInput);
    assert([409, 422].includes(r.statusCode), r.body);
  }
  assert.equal(publications().length, 0);
});
test('already published unchanged offer is confirmed by GET without another publication', async () => {
  const x = await draft();
  const p = await plan(x, publicationInput);
  await queue(p);
  assert.equal((await execute(p)).state, 'done');
  const second = await plan(x, publicationInput);
  await queue(second);
  assert.equal((await execute(second)).state, 'done');
  assert.equal(publications().length, 1);
});
test('draft changed after preview blocks publication before POST', async () => {
  const x = await draft(),
    p = await plan(x, publicationInput);
  await queue(p);
  f.offers[0].pricingSummary.price.value = '26.00';
  assert.equal((await execute(p)).phase, 'ready');
  assert.equal(publications().length, 0);
});
test('lost publication response reconciles from durable phase with GET and one POST', async () => {
  const x = await draft(),
    p = await plan(x, publicationInput);
  await queue(p);
  f.state.result = 'lost';
  const failed = await execute(p);
  assert.equal(failed.phase, 'write_started');
  assert.notEqual(failed.state, 'done');
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(publications().length, 1);
});
for (const status of ['reject', '401', '429', '503'])
  test(
    'publication ' +
      status +
      ' never repeats POST, then explicitly accepts the observed unchanged draft',
    async () => {
      const x = await draft(),
        p = await plan(x, publicationInput);
      await queue(p);
      f.state.result = status;
      assert.equal((await execute(p)).phase, 'write_started');
      assert.notEqual((await execute(p)).state, 'done');
      assert.equal(publications().length, 1);
      await ok(`/offer-plans/${p.id}/reconcile`, 'POST', { accept_observed: true });
      const done = await execute(p);
      assert.equal(done.state, 'done', done.error);
      assert.equal(done.result.desired_applied, false);
      assert.equal(publications().length, 1);
    },
  );
test('role lost immediately before publication blocks the transport and later reconciliation cannot replay POST', async () => {
  const x = await draft(),
    p = await plan(x, publicationInput);
  await queue(p);
  f.state.hook = async (u, m) => {
    if (m === 'GET' && u.pathname.includes('/location/'))
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]);
  };
  assert.notEqual((await execute(p)).state, 'done');
  assert.equal(publications().length, 0);
});
test('lease lost after publication leaves local snapshot unchanged; recovery confirms one POST', async () => {
  const x = await draft(),
    p = await plan(x, publicationInput);
  await queue(p);
  f.state.afterWrite = async () => {
    await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [
      (await getPlan(p)).job_id,
      randomUUID(),
    ]);
  };
  const stopped = await execute(p);
  assert.equal(stopped.phase, 'write_started');
  assert.equal(publications().length, 1);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(publications().length, 1);
});
test('publication during an active OAuth consent is blocked after preview', async () => {
  const x = await draft(),
    p = await plan(x, publicationInput);
  await pool.query(
    "INSERT INTO oauth_states(state_hash,tenant_id,channel_id,user_id,verifier,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
    ['067-' + randomUUID(), DEMO_TENANT, x.ch, user, encrypt({ verifier: 'fixture' })],
  );
  assert.equal(
    (await req(`/offer-plans/${p.id}/queue`, 'POST', { confirm_live: true })).statusCode,
    409,
  );
  assert.equal(publications().length, 0);
});
test('local publication uses the persisted draft with zero HTTP and leaves warehouse balances unchanged', async () => {
  const x = await draft(true),
    before = await stock(x),
    p = await plan(x, publicationInput);
  await queue(p, false);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.scope, 'local_simulation');
  assert.equal(done.result.desired_applied, true);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await stock(x), before);
  assert.equal((await plan(x, publicationInput)).publication.status, 'PUBLISHED');
});
test('draft quantity falls back to Inventory; zero stock and offer-only quantity can publish without changing either source', async () => {
  const x = await draft();
  delete f.offers[0].availableQuantity;
  assert.equal((await plan(x, publicationInput)).publication.quantity, 12);
  f.offers[0].availableQuantity = 0;
  delete f.inventory.availability.shipToLocationAvailability.quantity;
  const p = await plan(x, publicationInput);
  assert.equal(p.publication.quantity, 0);
  await queue(p);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(publications().length, 1);
  assert.equal(f.inventory.availability.shipToLocationAvailability.quantity, undefined);
});
test('publication with unrelated field drift remains uncertain and records explicit observed state without replay', async () => {
  const x = await draft(),
    p = await plan(x, publicationInput);
  await queue(p);
  f.state.afterWrite = async () => {
    delete f.offers[0].listingPolicies.returnPolicyId;
  };
  assert.equal((await execute(p)).phase, 'verify');
  assert.notEqual((await execute(p)).state, 'done');
  await ok(`/offer-plans/${p.id}/reconcile`, 'POST', { accept_observed: true });
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.scope, 'external_api_observed');
  assert.equal(
    done.result.actual_snapshot.publication_context.offer.listingPolicies.returnPolicyId,
    undefined,
  );
  assert.equal(publications().length, 1);
});
test('GET 401 after successful publication rotates the token and the next job confirms by GET only', async () => {
  const x = await draft(),
    p = await plan(x, publicationInput);
  await queue(p);
  f.state.afterWrite = async () => {
    f.state.unauthorizedOnce = true;
  };
  assert.equal((await execute(p)).phase, 'verify');
  assert.equal(f.state.token, 2);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(publications().length, 1);
});
test('settings changed during final publication GET prevent completion against a different connection', async () => {
  const x = await draft(),
    p = await plan(x, publicationInput);
  await queue(p);
  const old = (await pool.query('SELECT settings FROM channels WHERE id=$1', [x.ch])).rows[0]
    .settings;
  f.state.afterWrite = async () => {
    f.state.hook = async (u, m) => {
      if (m === 'GET' && u.pathname.includes('/location/')) {
        f.state.hook = undefined;
        await pool.query(
          'UPDATE channels SET settings=settings||\'{"marketplace_id":"EBAY_GB"}\' WHERE id=$1',
          [x.ch],
        );
      }
    };
  };
  assert.equal((await execute(p)).phase, 'verify');
  assert.equal(publications().length, 1);
  await pool.query('UPDATE channels SET settings=$2 WHERE id=$1', [x.ch, old]);
  await ok(`/offer-plans/${p.id}/reconcile`, 'POST', {});
  const recovered = await execute(p);
  assert.equal(recovered.state, 'done', recovered.error);
  assert.equal(publications().length, 1);
});
test('simulation can close an uncertain draft by observing it after local data changed, without a write', async () => {
  const x = await draft(true),
    p = await plan(x, publicationInput);
  await queue(p, false);
  await pool.query("UPDATE offer_plans SET phase='write_started',state='failed' WHERE id=$1", [
    p.id,
  ]);
  await pool.query('UPDATE products SET price=price+100,version=version+1 WHERE id=$1', [x.p.id]);
  await ok(`/offer-plans/${p.id}/reconcile`, 'POST', { accept_observed: true });
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.desired_applied, false);
  assert.equal(done.result.local_changed, true);
  assert.equal(done.result.actual_snapshot.status, 'UNPUBLISHED');
  assert.equal(f.calls.length, 0);
});

const creationConfig = () => ({
  sku: f.sku,
  category_id: '123',
  merchant_location_key: 'QA-LOCATION',
  payment_policy_id: '1',
  return_policy_id: '2',
  fulfillment_policy_id: '3',
  content_language: 'de-DE',
  condition: 'NEW',
});
async function newDraft(simulation = false, bind = true, mode = 'gross') {
  const x = await fixture('orders_inventory_write', simulation, mode, bind);
  await pool.query('DELETE FROM listings WHERE id=$1', [x.l.id]);
  x.l.id = undefined;
  await pool.query(
    'UPDATE products SET description=$2,images=$3,attributes=$4,version=version+1 WHERE id=$1',
    [
      x.p.id,
      'A <safe> description & details',
      JSON.stringify(['https://example.test/image.jpg']),
      JSON.stringify({ Brand: 'QA' }),
    ],
  );
  f.state.inventoryExists = false;
  f.offers.splice(0);
  if (bind) await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  return x;
}
const creationPreview = (x: Fixture, cfg: any = creationConfig(), extra: any = {}, auth = cookie) =>
  preview(
    x,
    { operation: 'create_draft', stock: true, price: true, ebay_creation: cfg, ...extra },
    auth,
  );
async function creationPlan(x: Fixture, cfg: any = creationConfig(), extra: any = {}) {
  const r = await creationPreview(x, cfg, extra);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const inventoryCreates = () => f.calls.filter((c) => c.method === 'PUT');
const offerCreates = () =>
  f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/sell/inventory/v1/offer'));
const reconcileCreation = async (p: any, observed = false) => {
  let current = await getPlan(p);
  if (observed && current.state !== 'failed') current = await execute(p);
  if (current.state === 'failed')
    await ok(`/offer-plans/${p.id}/reconcile`, 'POST', { accept_observed: observed });
  return execute(p);
};
test('new Inventory draft preserves escaped content, public images, local stock and reservation; can subsequently publish', async () => {
  const x = await newDraft();
  await ok('/orders', 'POST', {
    customer_name: 'QA create reservation',
    email: 'qa@example.test',
    warehouse_id: warehouse,
    address: { country: 'PL' },
    items: [{ product_id: x.p.id, quantity: 2 }],
  });
  const p = await creationPlan(x);
  assert.equal(p.draft.quantity, 8);
  assert.equal(p.draft.price.value, '123.00');
  assert.equal(p.draft.language, 'de-DE');
  assert.equal(inventoryCreates().length, 0);
  assert.equal(
    p.payload.inventory.product.description,
    `A &lt;safe&gt; description &amp; details<!-- dynaminds-offer-plan:${p.id} -->`,
  );
  assert.deepEqual(p.payload.inventory.product.aspects, { Brand: ['QA'] });
  await queue(p);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.desired_applied, true);
  assert.equal(done.result.ebay_offer_id, 'QA-CREATED-068');
  assert.equal(done.result.ebay_creation_steps.offer_verified, true);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 1);
  assert.equal(publications().length, 0);
  assert.equal(f.offers[0].status, 'UNPUBLISHED');
  assert.deepEqual(await stock(x), [{ on_hand: 10, reserved: 2 }]);
  const linked = (await pool.query('SELECT * FROM listings WHERE id=$1', [done.listing_id]))
    .rows[0];
  assert.equal(linked.external_id, f.sku);
  assert.equal(linked.last_result.ebay_offer_snapshot.offer_id, 'QA-CREATED-068');
  x.l = linked;
  const pub = await plan(x, {
    operation: 'publish',
    stock: false,
    price: false,
    ebay_offer_id: 'QA-CREATED-068',
  });
  await queue(pub);
  const published = await execute(pub);
  assert.equal(published.state, 'done', published.error);
  assert.equal(publications().length, 1);
  assert.equal(f.offers[0].status, 'PUBLISHED');
  assert.deepEqual(await stock(x), [{ on_hand: 10, reserved: 2 }]);
});
test('new draft net price is calculated from selected EUR price list without FX', async () => {
  const x = await newDraft(false, true, 'net');
  const l = await ok('/price-lists', 'POST', {
    name: 'QA creation EUR',
    currency: 'EUR',
  });
  await ok(`/price-lists/${l.id}/items`, 'PUT', {
    version: l.version,
    items: [{ product_id: x.p.id, price: 24600 }],
  });
  const p = await creationPlan(x, creationConfig(), { price_list_id: l.id });
  assert.equal(p.payload.offer.pricingSummary.price.value, '200.00');
  assert.equal(p.draft.price.currency, 'EUR');
  await queue(p);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(f.offers[0].pricingSummary.price.currency, 'EUR');
});
test('new draft rejects missing binding, read-only scope, missing description/images, bad paths and disabled location', async () => {
  const x = await newDraft(false, false);
  assert.equal((await creationPreview(x)).statusCode, 409);
  await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  for (const cfg of [
    { ...creationConfig(), sku: '..' },
    { ...creationConfig(), category_id: '0' },
    { ...creationConfig(), merchant_location_key: '..' },
  ])
    assert.equal((await creationPreview(x, cfg)).statusCode, 422);
  assert.equal((await creationPreview(x, creationConfig(), { stock: false })).statusCode, 422);
  assert.equal((await creationPreview(x, creationConfig(), {}, viewer)).statusCode, 403);
  assert.equal((await creationPreview(x, creationConfig(), {}, other)).statusCode, 404);
  await pool.query("UPDATE products SET description='',version=version+1 WHERE id=$1", [x.p.id]);
  assert.equal((await creationPreview(x)).statusCode, 422);
  await pool.query(
    "UPDATE products SET description='QA',images='[\"http://localhost/img.jpg\"]',version=version+1 WHERE id=$1",
    [x.p.id],
  );
  assert.equal((await creationPreview(x)).statusCode, 422);
  await pool.query(
    'UPDATE products SET images=\'["https://example.test/img.jpg"]\',version=version+1 WHERE id=$1',
    [x.p.id],
  );
  f.state.edit = (u, v) => {
    if (u.pathname.includes('/location/')) v.merchantLocationStatus = 'DISABLED';
  };
  assert.equal((await creationPreview(x)).statusCode, 422);
  f.state.edit = undefined;
  const p = await creationPlan(x);
  await pool.query('UPDATE channels SET oauth_scopes=$2 WHERE id=$1', [
    x.ch,
    EBAY_READ_SCOPE + ' ' + EBAY_INVENTORY_SCOPE,
  ]);
  assert.equal(
    (await req(`/offer-plans/${p.id}/queue`, 'POST', { confirm_live: true })).statusCode,
    422,
  );
  assert.equal(inventoryCreates().length + offerCreates().length, 0);
});
test('existing foreign Inventory or other-market offer prevents preview and overwriting', async () => {
  const x = await newDraft();
  f.state.inventoryExists = true;
  assert.equal((await creationPreview(x)).statusCode, 409);
  f.state.inventoryExists = false;
  f.offers.push({ offerId: 'FOREIGN-UK', sku: f.sku, marketplaceId: 'EBAY_GB' });
  assert.equal((await creationPreview(x)).statusCode, 409);
  assert.equal(inventoryCreates().length + offerCreates().length, 0);
});
test('remote drift before PUT prevents either mutation', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.inventoryExists = true;
  const r = await execute(p);
  assert.equal(r.state, 'conflict', r.error);
  assert.equal(inventoryCreates().length + offerCreates().length, 0);
});
test('lost Inventory response recovers by GET then first POST; never repeats PUT', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.inventoryResult = 'lost';
  const r = await execute(p);
  assert.equal(r.phase, 'write_started');
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 0);
  assert.equal(r.result.ebay_creation_steps.inventory_started, true);
  const done = await reconcileCreation(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.desired_applied, true);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 1);
});
test('lost offer response recovers by GET alone and exact content and markers', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.offerResult = 'lost';
  assert.equal((await execute(p)).phase, 'write_started');
  const done = await reconcileCreation(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.desired_applied, true);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 1);
});
for (const status of ['reject', '401', '429', '503'])
  test(`offer ${status} is never replayed; owned orphan can be explicitly reused after observed closure`, async () => {
    const x = await newDraft(),
      p = await creationPlan(x);
    await queue(p);
    f.state.offerResult = status;
    assert.equal((await execute(p)).phase, 'write_started');
    assert.equal((await reconcileCreation(p)).state, 'failed');
    assert.equal(offerCreates().length, 1);
    assert.equal((await creationPreview(x)).statusCode, 409);
    const observed = await reconcileCreation(p, true);
    assert.equal(observed.state, 'done', observed.error);
    assert.equal(observed.result.retained_inventory, true);
    assert.equal(observed.result.desired_applied, false);
    assert.equal(observed.listing_id, null);
    assert.equal(
      observed.result.actual_snapshot.inventory.product.description,
      p.payload.inventory.product.description,
    );
    await pool.query('UPDATE products SET price=15000,version=version+1 WHERE id=$1', [x.p.id]);
    const next = await creationPlan(x, { ...creationConfig(), reuse_inventory_plan_id: p.id });
    assert.equal(next.draft.reuses_inventory, true);
    f.state.offerResult = 'normal';
    await queue(next);
    const done = await execute(next);
    assert.equal(done.state, 'done', done.error);
    assert.equal(f.offers[0].pricingSummary.price.value, '150.00');
    assert.equal(inventoryCreates().length, 2);
    assert.equal(offerCreates().length, 2);
  });
test('rejected Inventory is not retried; observed absence closes without a false mapping', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.inventoryResult = 'reject';
  await execute(p);
  assert.equal((await reconcileCreation(p)).state, 'failed');
  const done = await reconcileCreation(p, true);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.retained_inventory, false);
  assert.equal(done.result.desired_applied, false);
  assert.equal(done.remote_id, null);
  assert.equal(done.listing_id, null);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 0);
});
test('foreign or rewritten offer after lost response is never adopted as verified', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.offerResult = 'lost';
  await execute(p);
  f.offers[0].listingDescription = 'Foreign';
  const r = await reconcileCreation(p);
  assert.equal(r.state, 'failed');
  const observed = await reconcileCreation(p, true);
  assert.equal(observed.state, 'done');
  assert.equal(observed.result.desired_applied, false);
  assert.equal(observed.listing_id, null);
  assert.equal(offerCreates().length, 1);
});
test('local stock drift after Inventory prevents POST; observed orphan closes without overwriting local state', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.afterInventoryWrite = async () => {
    await pool.query('UPDATE stock SET on_hand=9,version=version+1 WHERE product_id=$1', [x.p.id]);
  };
  const r = await execute(p);
  assert.equal(r.state, 'failed', r.error);
  assert.equal(offerCreates().length, 0);
  const observed = await reconcileCreation(p, true);
  assert.equal(observed.state, 'done', observed.error);
  assert.equal(observed.result.local_changed, true);
  assert.deepEqual(await stock(x), [{ on_hand: 9, reserved: 0 }]);
});
test('lost lease after Inventory blocks POST and local mapping; a new worker continues safely', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  const q = await queue(p);
  f.state.afterInventoryWrite = async () => {
    await pool.query("UPDATE jobs SET state='pending',lease_token=NULL WHERE id=$1", [q.job_id]);
  };
  await execute(p);
  assert.equal(offerCreates().length, 0);
  assert.equal((await getPlan(p)).listing_id, null);
  f.state.afterInventoryWrite = undefined;
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 1);
});
test('local simulation creates and publishes a draft with zero HTTP calls', async () => {
  const x = await newDraft(true),
    p = await creationPlan(x);
  await queue(p, false);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.scope, 'local_simulation');
  assert.equal(done.result.desired_applied, true);
  assert.equal(f.calls.length, 0);
  x.l = (await pool.query('SELECT * FROM listings WHERE id=$1', [done.listing_id])).rows[0];
  const pub = await plan(x, {
    operation: 'publish',
    stock: false,
    price: false,
    ebay_offer_id: done.result.ebay_offer_id,
  });
  await queue(pub, false);
  assert.equal((await execute(pub)).state, 'done');
  assert.equal(f.calls.length, 0);
});
for (const changed of ['role', 'credentials', 'identity', 'lease'])
  test(`new draft fences ${changed} between Inventory and POST`, async () => {
    const x = await newDraft(),
      p = await creationPlan(x);
    const q = await queue(p);
    f.state.afterInventoryWrite = async () => {
      if (changed === 'role')
        await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          DEMO_TENANT,
          user,
        ]);
      if (changed === 'credentials')
        await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
          x.ch,
          encrypt({ ...ebaySecrets, client_secret: 'different-secret' }),
        ]);
      if (changed === 'identity')
        await pool.query(
          "INSERT INTO oauth_states(state_hash,tenant_id,channel_id,user_id,verifier,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
          ['068-' + randomUUID(), DEMO_TENANT, x.ch, user, encrypt({ verifier: 'fixture' })],
        );
      if (changed === 'lease')
        await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [q.job_id, randomUUID()]);
    };
    const stopped = await execute(p);
    assert.notEqual(stopped.state, 'done');
    assert.equal(inventoryCreates().length, 1);
    assert.equal(offerCreates().length, 0);
    assert.equal(stopped.listing_id, null);
  });
test('two products cannot queue the same new SKU; prior orphan cannot be reused for another product', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  const second = await ok('/products', 'POST', {
    sku: 'OTHER-' + randomUUID(),
    name: 'QA other',
    price: 12300,
    quantity: 1,
    warehouse_id: warehouse,
  });
  await pool.query('UPDATE products SET description=$2,images=$3 WHERE id=$1', [
    second.id,
    'QA',
    JSON.stringify(['https://example.test/other.jpg']),
  ]);
  const y = { ...x, p: second };
  const competing = await creationPlan(y);
  await queue(p);
  assert.equal(
    (await req(`/offer-plans/${competing.id}/queue`, 'POST', { confirm_live: true })).statusCode,
    409,
  );
  f.state.offerResult = 'reject';
  await execute(p);
  await reconcileCreation(p);
  await reconcileCreation(p, true);
  assert.equal(
    (await creationPreview(y, { ...creationConfig(), reuse_inventory_plan_id: p.id })).statusCode,
    404,
  );
  f.inventory.product.description = 'foreign';
  assert.equal(
    (await creationPreview(x, { ...creationConfig(), reuse_inventory_plan_id: p.id })).statusCode,
    409,
  );
});
test('GET 401 after createOffer reloads durable state and confirms without repeating either mutation', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.afterWrite = async () => {
    f.state.unauthorizedOnce = true;
  };
  const r = await execute(p);
  assert.equal(r.phase, 'verify');
  assert.notEqual(r.state, 'done');
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.result.desired_applied, true);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 1);
});
test('mismatched offer summary prevents confirmation even when detail matches', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.offerResult = 'lost';
  await execute(p);
  f.state.edit = (u, v) => {
    if (u.pathname.endsWith('/offer')) v.offers[0].pricingSummary.price.value = '1.00';
  };
  const r = await reconcileCreation(p);
  assert.equal(r.state, 'failed');
  const observed = await reconcileCreation(p, true);
  assert.equal(observed.result.desired_applied, false);
  assert.equal(observed.listing_id, null);
  assert.equal(offerCreates().length, 1);
});
test('observed foreign Inventory is not offered for reuse as an owned retained record', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.offerResult = 'reject';
  await execute(p);
  await reconcileCreation(p);
  f.inventory.product.description = 'Foreign replacement';
  const observed = await reconcileCreation(p, true);
  assert.equal(observed.state, 'done', observed.error);
  assert.equal(observed.result.retained_inventory, false);
  assert.equal(observed.result.desired_applied, false);
  assert.equal(observed.listing_id, null);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 1);
});

const verifiedConfig = () => ({
  ...creationConfig(),
  verify_settings: true,
  aspects: { Brand: ['QA'], Color: ['Black'] },
});
async function sellerFixture() {
  const x = await newDraft();
  await pool.query(
    'UPDATE channels SET settings=settings||\'{"seller_settings_read":true}\'::jsonb WHERE id=$1',
    [x.ch],
  );
  f.state.scope += ' ' + EBAY_ACCOUNT_READ_SCOPE;
  return x;
}
test('seller options and Taxonomy use distinct tokens, preserve seller cache and send no business writes', async () => {
  const x = await sellerFixture();
  const opts = await ok(`/integrations/${x.ch}/ebay/seller-settings?language=de-DE`);
  assert.equal(opts.locations[0].key, 'QA-LOCATION');
  assert.equal(opts.policies.payment[0].name, 'QA payment');
  const before = (await pool.query('SELECT * FROM channels WHERE id=$1', [x.ch])).rows[0];
  const suggestions = await ok(`/integrations/${x.ch}/ebay/categories?phrase=accessories`);
  assert.equal(suggestions.data[0].path, 'QA root / QA accessories');
  const meta = await ok(`/integrations/${x.ch}/ebay/category?category_id=123`);
  assert.equal(meta.aspects[1].localizedAspectName, 'Color');
  const after = (await pool.query('SELECT * FROM channels WHERE id=$1', [x.ch])).rows[0];
  assert.equal(after.credentials, before.credentials);
  assert.equal(after.oauth_scopes, before.oauth_scopes);
  assert.equal(f.state.applicationToken, 2);
  assert.equal(meta.scope, 'external_read');
  assert.equal(inventoryCreates().length + offerCreates().length, 0);
});
test('Taxonomy works without Account consent and without refreshing the seller token; options require opt-in', async () => {
  const x = await newDraft(),
    tokens = f.state.token;
  assert.equal(
    (await req(`/integrations/${x.ch}/ebay/seller-settings?language=de-DE`)).statusCode,
    422,
  );
  assert.equal((await req(`/integrations/${x.ch}/ebay/category?category_id=123`)).statusCode, 200);
  assert.equal(f.state.token, tokens);
});
test('metadata reads reject viewer, other tenant, unbound identity and active OAuth before any request', async () => {
  const x = await sellerFixture(),
    count = f.calls.length;
  for (const p of [
    'seller-settings?language=de-DE',
    'categories?phrase=test',
    'category?category_id=123',
  ]) {
    assert.equal(
      (await req(`/integrations/${x.ch}/ebay/${p}`, 'GET', undefined, viewer)).statusCode,
      403,
    );
    assert.equal(
      (await req(`/integrations/${x.ch}/ebay/${p}`, 'GET', undefined, other)).statusCode,
      404,
    );
  }
  await pool.query('DELETE FROM ebay_account_bindings WHERE channel_id=$1', [x.ch]);
  assert.equal((await req(`/integrations/${x.ch}/ebay/category?category_id=123`)).statusCode, 409);
  assert.equal(f.calls.length, count);
  await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  await pool.query(
    "INSERT INTO oauth_states(state_hash,tenant_id,channel_id,user_id,verifier,expires_at,scope) VALUES($1,$2,$3,$4,'synthetic',now()+interval '5 minutes','synthetic')",
    [randomUUID(), DEMO_TENANT, x.ch, user],
  );
  const count2 = f.calls.length;
  assert.equal((await req(`/integrations/${x.ch}/ebay/categories?phrase=test`)).statusCode, 409);
  assert.equal(f.calls.length, count2);
});
for (const change of ['role', 'connection', 'identity'])
  test(`metadata fence catches ${change} drift after provider response`, async () => {
    const x = await sellerFixture();
    f.state.hook = async (u) => {
      if (!u.pathname.endsWith('get_default_category_tree_id')) return;
      f.state.hook = undefined;
      if (change === 'role')
        await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
          DEMO_TENANT,
          user,
        ]);
      else if (change === 'connection')
        await pool.query(
          'UPDATE channels SET settings=settings||\'{"marketplace_id":"EBAY_GB"}\' WHERE id=$1',
          [x.ch],
        );
      else await pool.query('DELETE FROM ebay_account_bindings WHERE channel_id=$1', [x.ch]);
    };
    const r = await req(`/integrations/${x.ch}/ebay/category?category_id=123`);
    assert.equal(r.statusCode, change === 'role' ? 403 : 409, r.body);
    assert.equal(f.calls.filter((c) => c.url.includes('get_category_subtree')).length, 0);
  });
test('Inventory locations read all pages and reject foreign links and duplicate keys', async () => {
  const x = await sellerFixture();
  f.state.edit = (u, raw) => {
    if (!u.pathname.endsWith('/location')) return;
    const offset = Number(u.searchParams.get('offset'));
    raw.total = 26;
    raw.locations = Array.from({ length: offset ? 1 : 25 }, (_, n) => ({
      ...raw.locations[0],
      merchantLocationKey: 'LOC-' + (offset + n),
    }));
    if (!offset)
      raw.next = 'https://api.sandbox.ebay.com/sell/inventory/v1/location?limit=25&offset=25';
  };
  assert.equal(
    (await ok(`/integrations/${x.ch}/ebay/seller-settings?language=de-DE`)).locations.length,
    26,
  );
  f.state.edit = (u, raw) => {
    if (u.pathname.endsWith('/location'))
      raw.next = 'https://evil.example/sell/inventory/v1/location?limit=25&offset=25';
  };
  assert.equal(
    (await req(`/integrations/${x.ch}/ebay/seller-settings?language=de-DE`)).statusCode,
    502,
  );
  f.state.edit = (u, raw) => {
    if (u.pathname.endsWith('/location')) {
      raw.locations.push(raw.locations[0]);
      raw.total = 2;
    }
  };
  assert.equal(
    (await req(`/integrations/${x.ch}/ebay/seller-settings?language=de-DE`)).statusCode,
    502,
  );
});
for (const invalid of ['market', 'partial', 'duplicate'])
  test(`Account list rejects ${invalid} data`, async () => {
    const x = await sellerFixture();
    f.state.edit = (u, raw) => {
      if (!u.pathname.endsWith('/payment_policy')) return;
      if (invalid === 'market') raw.paymentPolicies[0].marketplaceId = 'EBAY_GB';
      else if (invalid === 'partial') raw.total = 2;
      else {
        raw.paymentPolicies.push(raw.paymentPolicies[0]);
        raw.total = 2;
      }
    };
    assert.equal(
      (await req(`/integrations/${x.ch}/ebay/seller-settings?language=de-DE`)).statusCode,
      502,
    );
  });
for (const invalid of ['non-leaf', 'tree', 'duplicate-aspect', 'missing-constraint'])
  test(`Taxonomy rejects ${invalid} metadata`, async () => {
    const x = await sellerFixture();
    f.state.edit = (u, raw) => {
      if (u.pathname.endsWith('get_category_subtree')) {
        if (invalid === 'non-leaf') raw.categorySubtreeNode.leafCategoryTreeNode = false;
        if (invalid === 'tree') raw.categoryTreeVersion = 'DIFFERENT';
      }
      if (u.pathname.endsWith('get_item_aspects_for_category')) {
        if (invalid === 'duplicate-aspect') raw.aspects.push(raw.aspects[0]);
        if (invalid === 'missing-constraint') delete raw.aspects[0].aspectConstraint;
      }
    };
    assert.equal(
      (await req(`/integrations/${x.ch}/ebay/category?category_id=123`)).statusCode,
      invalid === 'non-leaf' ? 422 : 502,
    );
  });
test('required values, cardinality, dictionary, dependencies and lengths are checked; offer overrides preserve catalogue', async () => {
  const x = await sellerFixture(),
    cfg = verifiedConfig();
  for (const aspects of [
    {},
    { Brand: ['QA'] },
    { Brand: ['QA', 'Other'], Color: ['Black'] },
    { Brand: ['QA'], Color: ['Unknown'] },
    { Brand: ['QA'], Color: ['White'] },
    { Brand: ['X'.repeat(21)], Color: ['Black'] },
    { Brand: ['QA'], Color: ['Black'], Foreign: ['value'] },
  ]) {
    assert.equal((await creationPreview(x, { ...cfg, aspects })).statusCode, 422);
  }
  const p = await creationPlan(x, {
    ...cfg,
    aspects: { Brand: ['White brand'], Color: ['White'] },
  });
  assert.equal(p.draft.requirements.policies.payment.name, 'QA payment');
  await queue(p);
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 1);
  assert.deepEqual(f.inventory.product.aspects, { Brand: ['White brand'], Color: ['White'] });
  assert.deepEqual(
    (await pool.query('SELECT attributes FROM products WHERE id=$1', [x.p.id])).rows[0].attributes,
    { Brand: 'QA' },
  );
});
test('changed policy or category after preview blocks before Inventory PUT', async () => {
  const x = await sellerFixture(),
    p = await creationPlan(x, verifiedConfig());
  await queue(p);
  f.state.edit = (u, raw) => {
    if (u.pathname.endsWith('/payment_policy/1')) raw.name = 'Changed';
  };
  const done = await execute(p);
  assert.equal(done.state, 'conflict', done.error);
  assert.equal(inventoryCreates().length + offerCreates().length, 0);
});
test('requirements drifting between PUT and POST preserve owned Inventory without creating an offer', async () => {
  const x = await sellerFixture(),
    p = await creationPlan(x, verifiedConfig());
  await queue(p);
  f.state.afterInventoryWrite = async () => {
    f.state.edit = (u, raw) => {
      if (u.pathname.endsWith('get_item_aspects_for_category'))
        raw.aspects[0].aspectConstraint.aspectMaxLength = 19;
    };
  };
  const done = await execute(p);
  assert.equal(done.state, 'failed', done.error);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 0);
  assert.equal(done.result.ebay_creation_steps.inventory_verified, true);
});
test('uncertain POST is reconciled by GET without rereading changed Account or replaying either write', async () => {
  const x = await sellerFixture(),
    p = await creationPlan(x, verifiedConfig());
  await queue(p);
  f.state.offerResult = 'lost';
  assert.equal((await execute(p)).phase, 'write_started');
  const apps = f.state.applicationToken;
  f.state.edit = (u, raw) => {
    if (u.pathname.endsWith('/payment_policy/1')) raw.name = 'Changed';
  };
  const done = await reconcileCreation(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(f.state.applicationToken, apps);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 1);
});
test('simulation options and requirements enforce same UI selection and aspects without HTTP', async () => {
  const x = await newDraft(true),
    count = f.calls.length;
  const opts = await ok(`/integrations/${x.ch}/ebay/seller-settings`);
  assert.equal(opts.scope, 'local_simulation');
  const cfg = {
    ...creationConfig(),
    verify_settings: true,
    merchant_location_key: opts.locations[0].key,
    payment_policy_id: opts.policies.payment[0].id,
    return_policy_id: opts.policies.return[0].id,
    fulfillment_policy_id: opts.policies.fulfillment[0].id,
    aspects: { Marka: ['QA'], Kolor: ['Czarny'] },
  };
  assert.equal(
    (await creationPreview(x, { ...cfg, merchant_location_key: 'DEMO-LOCATION-DISABLED' }))
      .statusCode,
    422,
  );
  const p = await creationPlan(x, cfg);
  await queue(p, false);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(f.calls.length, count);
});
test('dependent MULTI parameter allows documented OR choices and rejects duplicates', () => {
  const metadata = {
    aspects: [
      {
        localizedAspectName: 'Control',
        aspectConstraint: {
          aspectRequired: true,
          aspectMode: 'FREE_TEXT',
          itemToAspectCardinality: 'MULTI',
        },
      },
      {
        localizedAspectName: 'Choice',
        aspectConstraint: {
          aspectRequired: true,
          aspectMode: 'SELECTION_ONLY',
          itemToAspectCardinality: 'SINGLE',
        },
        aspectValues: [
          {
            localizedValue: 'X',
            valueConstraints: [
              {
                applicableForLocalizedAspectName: 'Control',
                applicableForLocalizedAspectValues: ['A'],
              },
              {
                applicableForLocalizedAspectName: 'Control',
                applicableForLocalizedAspectValues: ['B'],
              },
            ],
          },
        ],
      },
    ],
  };
  validateEbayAspects(metadata, { Control: ['B'], Choice: ['X'] });
  assert.throws(() => validateEbayAspects(metadata, { Control: ['C'], Choice: ['X'] }));
  assert.throws(() => validateEbayAspects(metadata, { Control: ['A', 'A'], Choice: ['X'] }));
});

async function budgetScope(x: Fixture) {
  const b = (
    await pool.query('SELECT account_hash FROM ebay_account_bindings WHERE channel_id=$1', [x.ch])
  ).rows[0];
  const ch = (await pool.query('SELECT mode,settings FROM channels WHERE id=$1', [x.ch])).rows[0];
  return ebayRevisionScope(
    b.account_hash,
    ch.mode,
    ch.settings.simulation ? DEMO_TENANT : undefined,
  );
}
async function exhaust(scope: string, listing: string, count = 250) {
  await pool.query(
    `INSERT INTO ebay_revision_attempts(scope_hash,listing_id,plan_id,attempted_at)
    SELECT $1,$2,gen_random_uuid(),clock_timestamp()-interval '1 hour' FROM generate_series(1,$3)`,
    [scope, listing, count],
  );
}
const ledgerCount = async () =>
  (await pool.query('SELECT count(*)::int n FROM ebay_revision_attempts')).rows[0].n;

test('revision budget serializes 255 concurrent reservations to exactly 250; independent listing still works', async () => {
  const scope = ebayRevisionScope('a'.repeat(64), 'sandbox');
  const result = await Promise.all(
    Array.from({ length: 255 }, async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await reserveEbayRevisions(c, scope, ['QA-concurrent'], randomUUID());
        await c.query('COMMIT');
        return 'reserved';
      } catch (e) {
        await c.query('ROLLBACK');
        assert(e instanceof EbayRevisionWait);
        return 'waiting';
      } finally {
        c.release();
      }
    }),
  );
  assert.equal(result.filter((x) => x === 'reserved').length, 250);
  assert.equal(result.filter((x) => x === 'waiting').length, 5);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await reserveEbayRevisions(c, scope, ['QA-other'], randomUUID());
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  assert.equal(await ledgerCount(), 251);
});
test('service-only revision ledger denies tenant reads and resets', async () => {
  for (const query of [
    'SELECT * FROM ebay_revision_attempts',
    'DELETE FROM ebay_revision_attempts',
    "INSERT INTO ebay_revision_attempts VALUES(repeat('a',64),'QA',gen_random_uuid(),now())",
  ])
    await assert.rejects(
      tenantTx(DEMO_TENANT, (c) => c.query(query)),
      (e: any) => e.code === '42501',
    );
});
test('account identity is required for sync preview and missing IDs fail closed for every affected market', async () => {
  const x = await fixture('orders_inventory_write', false, 'gross', false);
  assert.equal((await preview(x)).statusCode, 409);
  await ok(`/integrations/${x.ch}/ebay-account/verify`, 'POST', {});
  delete f.offers[1].listing;
  assert.equal((await preview(x, { stock: true, price: false })).statusCode, 422);
  assert.equal((await preview(x, { stock: false, price: true })).statusCode, 200);
  assert.equal(writes().length, 0);
});
test('same account through two channels shares exhausted budget; different account namespace is distinct', async () => {
  const x = await fixture(),
    y = await fixture();
  assert.equal(await budgetScope(x), await budgetScope(y));
  assert.notEqual(
    ebayRevisionScope('a'.repeat(64), 'sandbox'),
    ebayRevisionScope('b'.repeat(64), 'sandbox'),
  );
  assert.notEqual(
    ebayRevisionScope('a'.repeat(64), 'sandbox'),
    ebayRevisionScope('a'.repeat(64), 'live'),
  );
  const p = await plan(y, { price: true, stock: false }),
    scope = await budgetScope(x);
  await exhaust(scope, p.before.offers[0].listing.listingId);
  await queue(p);
  await pool.query('UPDATE jobs SET max_attempts=1 WHERE id=$1', [(await getPlan(p)).job_id]);
  const result = await execute(p);
  assert.equal(result.state, 'queued');
  assert.equal(result.phase, 'ready');
  assert(result.result.ebay_revision_wait_until);
  const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [result.job_id])).rows[0];
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 0);
  assert(new Date(job.run_at).getTime() > Date.now() + 22 * 3600000);
  assert.equal(writes().length, 0);
  assert.equal(await ledgerCount(), 250);
});
test('pool stock reserves all market listings atomically; exhausted second listing consumes no first slot', async () => {
  const x = await fixture();
  f.offers[1].listing = { listingId: 'QA-other-market', listingStatus: 'ACTIVE' };
  const p = await plan(x, { stock: true, price: false });
  assert.deepEqual(
    p.revision_budget.listing_ids,
    [f.offers[0].listing.listingId, 'QA-other-market'].sort(),
  );
  await exhaust(await budgetScope(x), 'QA-other-market');
  await queue(p);
  const r = await execute(p);
  assert.equal(r.phase, 'ready');
  assert.equal(r.state, 'queued');
  assert.equal(await ledgerCount(), 250);
  assert.equal(writes().length, 0);
});
test('rolling window resumes a deferred job with a fresh snapshot and a single revision', async () => {
  const x = await fixture(),
    p = await plan(x, { price: true, stock: false }),
    scope = await budgetScope(x);
  await exhaust(scope, p.before.offers[0].listing.listingId);
  await queue(p);
  assert.equal((await execute(p)).phase, 'ready');
  await pool.query(
    "UPDATE ebay_revision_attempts SET attempted_at=clock_timestamp()-interval '25 hours' WHERE scope_hash=$1",
    [scope],
  );
  const r = await execute(p);
  assert.equal(r.state, 'done');
  assert.equal(writes().length, 1);
  assert.equal(await ledgerCount(), 251);
  assert.equal(r.result.ebay_revision_wait_until, undefined);
});
test('changed local data while waiting conflicts without reserving or sending a revision', async () => {
  const x = await fixture(),
    p = await plan(x, { price: true, stock: false }),
    scope = await budgetScope(x);
  await exhaust(scope, p.before.offers[0].listing.listingId);
  await queue(p);
  await execute(p);
  await pool.query('UPDATE products SET price=price+100,version=version+1 WHERE id=$1', [x.p.id]);
  const r = await execute(p);
  assert.equal(r.state, 'conflict');
  assert.equal(r.phase, 'ready');
  assert.equal(writes().length, 0);
  assert.equal(await ledgerCount(), 250);
});
test('lost reply retains one reservation; reconciliation GET does not count or replay a revision', async () => {
  const x = await fixture(),
    p = await plan(x, { price: true, stock: false });
  await queue(p);
  f.state.result = 'lost';
  await execute(p);
  assert.equal(await ledgerCount(), 1);
  await execute(p);
  assert.equal((await getPlan(p)).state, 'done');
  assert.equal(writes().length, 1);
  assert.equal(await ledgerCount(), 1);
});
test('no-op sync and duplicate listing IDs consume zero and one reservation respectively', async () => {
  const x = await fixture();
  f.offers[0].pricingSummary.price.value = '123.00';
  const no = await plan(x, { price: true, stock: false });
  await queue(no);
  assert.equal((await execute(no)).state, 'done');
  assert.equal(writes().length, 0);
  assert.equal(await ledgerCount(), 0);
  f.offers[0].pricingSummary.price.value = '100.00';
  f.offers[1].listing = structuredClone(f.offers[0].listing);
  const p = await plan(x, { price: true, stock: true });
  assert.equal(ebayRevisionListings(p.before, p.payload).length, 1);
  await queue(p);
  assert.equal((await execute(p)).state, 'done');
  assert.equal(await ledgerCount(), 1);
});
test('simulation uses a tenant-isolated account budget; waiting can be cancelled only before a worker starts', async () => {
  const x = await fixture('orders_inventory_write', true),
    p = await plan(x, { price: true, stock: false });
  const scope = await budgetScope(x);
  await exhaust(scope, p.before.offers[0].listing.listingId);
  await queue(p);
  const r = await execute(p);
  assert.equal(r.state, 'queued');
  assert.equal(r.phase, 'ready');
  assert.equal(f.calls.length, 0);
  assert.equal((await req(`/offer-plans/${p.id}/cancel-wait`, 'POST', {}, viewer)).statusCode, 403);
  assert.equal((await req(`/offer-plans/${p.id}/cancel-wait`, 'POST', {}, other)).statusCode, 404);
  const job = await claim(r.job_id);
  assert.equal((await req(`/offer-plans/${p.id}/cancel-wait`, 'POST', {})).statusCode, 409);
  await failOffer(job, new EbayRevisionWait(r.result.ebay_revision_wait_until));
  assert.equal((await req(`/offer-plans/${p.id}/cancel-wait`, 'POST', {})).statusCode, 200);
  assert.equal((await getPlan(p)).state, 'failed');
  assert.equal(await ledgerCount(), 250);
  assert.equal((await req(`/offer-plans/${p.id}/cancel-wait`, 'POST', {})).statusCode, 409);
  assert.equal((await preview(x, { price: true, stock: false })).statusCode, 200);
});

test('verified account shares its revision budget across independent firms without exposing their plans', async () => {
  const x = await fixture(),
    scope = await budgetScope(x);
  const own = async (p: string, method: any = 'GET', body?: any) => {
    const r = await req(p, method, body, other);
    assert(r.statusCode < 300, r.body);
    return r.json();
  };
  const y = (
    await own('/integrations', 'POST', {
      provider: 'ebay',
      name: 'QA other firm shared seller',
      mode: 'sandbox',
      credentials: ebaySecrets,
      settings: {
        inventory_access: 'orders_inventory_write',
        marketplace_id: 'EBAY_DE',
        price_mode: 'gross',
      },
    })
  ).id;
  await own(`/integrations/${y}/ebay-account/verify`, 'POST', {});
  const b = (
    await pool.query(
      'SELECT account_hash,tenant_id FROM ebay_account_bindings WHERE channel_id=$1',
      [y],
    )
  ).rows[0];
  assert.notEqual(b.tenant_id, DEMO_TENANT);
  assert.equal(ebayRevisionScope(b.account_hash, 'sandbox'), scope);
  const w = (await own('/warehouses')).data[0].id;
  const p = await own('/products', 'POST', {
    sku: 'OTHER-' + randomUUID(),
    name: 'QA shared budget',
    price: 12300,
    vat: 23,
    quantity: 10,
    warehouse_id: w,
  });
  const l = await own(`/integrations/${y}/mappings`, 'POST', { external_id: f.sku, sku: p.sku });
  const preview = await own(`/integrations/${y}/offers/preview`, 'POST', {
    product_id: p.id,
    listing_id: l.id,
    warehouse_id: w,
    operation: 'sync',
    stock: false,
    price: true,
  });
  await exhaust(scope, preview.before.offers[0].listing.listingId);
  await own(`/offer-plans/${preview.id}/queue`, 'POST', { confirm_live: true });
  const waiting = await execute(preview);
  assert.equal(waiting.state, 'queued');
  assert.equal(waiting.phase, 'ready');
  assert.equal(writes().length, 0);
  assert.equal((await req(`/integrations/${y}/offers`)).statusCode, 404);
  assert.equal(await ledgerCount(), 250);
});

async function apiCooldown(simulation = false) {
  const app = simulation
    ? ebaySimulationApplication(DEMO_TENANT, 'sandbox')
    : ebayApplicationHash('sandbox', ebaySecrets.client_id);
  await pool.query(
    "INSERT INTO ebay_api_buckets(scope_hash,app_hash,family,cooldown_until) VALUES($1,$2,'inventory',now()+interval '1 hour') ON CONFLICT(scope_hash) DO UPDATE SET cooldown_until=excluded.cooldown_until",
    [ebayApiScope(app, 'inventory'), app],
  );
}
for (const simulation of [false, true])
  test(`API limit: ${simulation ? 'simulation' : 'connector'} waits before write without consuming attempt or revision, can cancel and resume`, async () => {
    const x = await fixture('orders_inventory_write', simulation),
      p = await plan(x);
    await queue(p);
    await apiCooldown(simulation);
    const before = f.calls.length,
      current = await execute(p);
    assert.equal(current.state, 'queued');
    assert.equal(current.phase, 'ready');
    assert.equal(await ledgerCount(), 0);
    assert.equal(writes().length, 0);
    if (simulation) assert.equal(f.calls.length, before);
    const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [current.job_id])).rows[0];
    assert.equal(job.state, 'pending');
    assert.equal(job.attempts, 0);
    assert(job.provider_wait_until);
    const history = await ok(`/integrations/${x.ch}/offers`);
    assert(history.data[0].provider_wait_until);
    const status = await ok(`/integrations/${x.ch}/ebay/api-limits`);
    assert(status.families.find((r: any) => r.family === 'inventory').cooldown_until);
    assert.equal(status.provider_quota_read, false);
    assert.equal(
      (await req(`/offer-plans/${p.id}/cancel-wait`, 'POST', {}, viewer)).statusCode,
      403,
    );
    assert.equal(
      (await req(`/offer-plans/${p.id}/cancel-wait`, 'POST', {}, other)).statusCode,
      404,
    );
    await ok(`/offer-plans/${p.id}/cancel-wait`, 'POST', {});
    assert.equal((await getPlan(p)).phase, 'ready');
    await pool.query("UPDATE ebay_api_buckets SET cooldown_until='-infinity'");
    const next = await plan(x);
    await queue(next);
    const done = await execute(next);
    assert.equal(done.state, 'done', done.error);
    assert.equal(writes().length, simulation ? 0 : 1);
    assert.equal(await ledgerCount(), simulation ? 1 : 1);
  });
test('API limit: cooldown after Inventory PUT preserves creation checkpoint and sends no second PUT', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.afterInventoryWrite = () => apiCooldown();
  const waiting = await execute(p);
  assert.equal(waiting.state, 'queued');
  assert.equal(waiting.phase, 'write_started');
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 0);
  assert.equal((await req(`/offer-plans/${p.id}/cancel-wait`, 'POST', {})).statusCode, 409);
  await pool.query("UPDATE ebay_api_buckets SET cooldown_until='-infinity'");
  f.state.afterInventoryWrite = undefined;
  const done = await execute(p);
  assert.equal(done.state, 'done', done.error);
  assert.equal(inventoryCreates().length, 1);
  assert.equal(offerCreates().length, 1);
});
test('API limit: provider 429 after offer POST retains uncertainty and GET wait never replays POST', async () => {
  const x = await newDraft(),
    p = await creationPlan(x);
  await queue(p);
  f.state.offerResult = '429';
  f.state.retryAfter = '3600';
  const failed = await execute(p);
  assert.equal(failed.phase, 'write_started');
  assert.equal(offerCreates().length, 1);
  const waiting = await execute(p);
  assert.equal(waiting.state, 'queued');
  assert.equal(waiting.phase, 'write_started');
  assert.equal(offerCreates().length, 1);
  await pool.query("UPDATE ebay_api_buckets SET cooldown_until='-infinity'");
  f.state.offerResult = 'normal';
  await execute(p);
  assert.equal(offerCreates().length, 1);
  assert.equal((await getPlan(p)).phase, 'write_started');
});
test('API limit: company cannot inspect another channel, viewer denied, no provider call for local status', async () => {
  const x = await fixture(),
    before = f.calls.length;
  assert.equal(
    (await req(`/integrations/${x.ch}/ebay/api-limits`, 'GET', undefined, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req(`/integrations/${x.ch}/ebay/api-limits`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal((await req(`/integrations/${x.ch}/ebay/api-limits`)).statusCode, 200);
  assert.equal(f.calls.length, before);
});

test('API limit: offer schedule wait preserves item cursor and resumes the same scan', async () => {
  const x = await fixture();
  await plan(x);
  await configure(x);
  const d = await ok(`/integrations/${x.ch}/offer-sync`, 'POST', {}),
    j = await claim(d.id);
  await apiCooldown();
  try {
    await processOfferSync(j, ctx);
    assert.fail('expected API wait');
  } catch (e) {
    await failOfferSync(j, e);
  }
  const waiting = (await pool.query('SELECT * FROM jobs WHERE id=$1', [j.id])).rows[0];
  assert.equal(waiting.state, 'pending');
  assert.equal(waiting.attempts, 0);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM offer_sync_items WHERE channel_id=$1', [x.ch]))
      .rows[0].n,
    0,
  );
  await pool.query("UPDATE ebay_api_buckets SET cooldown_until='-infinity'");
  await processOfferSync(await claim(j.id), ctx);
  assert.equal(
    (await pool.query('SELECT state FROM jobs WHERE id=$1', [j.id])).rows[0].state,
    'done',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM offer_plans WHERE channel_id=$1 AND state='queued'",
        [x.ch],
      )
    ).rows[0].n,
    1,
  );
});
