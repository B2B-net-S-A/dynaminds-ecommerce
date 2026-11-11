import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { processDpd, dpdInput, dpdPdf, verifiedDpdLabel } from '../server/dpd-shipping';
import { failShipping } from '../server/shipping';
import { encrypt } from '../server/security';
import { Dpd } from '../server/integrations';
import { Problem } from '../server/errors';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  viewer: string,
  other: string,
  operator: string,
  warehouse: string;
const calls: any[] = [],
  remote = new Map<string, string>();
let lostCreate = false,
  lostLabel = false,
  badPdf = false,
  wrongWaybill = false,
  missing = false,
  ambiguous = false,
  wrongCreatedRef = false,
  rejectData = false;
let hook: ((operation: string) => Promise<void>) | undefined;
let foreignLabelReference: string | undefined;
const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status });
const pdf = Buffer.from('%PDF-1.4\nfixture-label').toString('base64');
function labels(reference: string, waybill: string) {
  return {
    status: 'OK',
    session: {
      statusInfo: { status: 'OK' },
      packages: [
        {
          statusInfo: { status: 'OK' },
          parcels: [{ statusInfo: { status: 'OK' }, reference, waybill }],
        },
      ],
    },
    documentData: badPdf ? Buffer.from('<html>bad</html>').toString('base64') : pdf,
    traceId: randomUUID(),
  };
}
const transport = async (url: string, init: RequestInit) => {
  const u = new URL(url),
    operation = u.pathname.split('/').at(-1)!,
    body = init.body ? JSON.parse(String(init.body)) : null;
  assert.equal(
    (init.headers as any).Authorization,
    'Basic ' + Buffer.from('fixture:fixture-password').toString('base64'),
  );
  assert.equal((init.headers as any)['x-dpd-fid'], '1495');
  calls.push({ url, method: init.method ?? 'GET', body, operation });
  await hook?.(operation);
  if (operation === 'postalCode') return json({ status: 'OK', traceId: randomUUID() });
  if (operation === 'generatePackagesNumbers') {
    assert.equal(init.method, 'POST');
    const reference = body.packages[0].reference,
      waybill = '00008891' + String(remote.size + 10000) + 'Q';
    if (rejectData)
      return json({
        status: 'INCORRECT_DATA',
        packages: [
          {
            status: 'INCORRECT_DATA',
            reference,
            parcels: [{ status: 'INCORRECT_DATA', reference, waybill: null }],
          },
        ],
      });
    remote.set(reference, waybill);
    if (lostCreate) {
      lostCreate = false;
      throw new Problem(502, 'Lost response');
    }
    return json({
      status: 'OK',
      sessionId: 20000,
      packages: [
        {
          status: 'OK',
          reference: wrongCreatedRef ? 'other' : reference,
          parcels: [{ status: 'OK', reference, waybill }],
        },
      ],
    });
  }
  assert.equal(operation, 'generateSpedLabels');
  assert.equal(body.format, 'A4');
  assert.equal(body.outputDocFormat, 'PDF');
  const reference = body.labelSearchParams.session.packages[0].parcels[0].reference;
  if (missing || !remote.has(reference))
    return json({ status: 'NOT_FOUND', traceId: randomUUID() });
  const result = labels(reference, wrongWaybill ? '9999999999999Q' : remote.get(reference)!);
  if (foreignLabelReference) result.session.packages[0].parcels[0].reference = foreignLabelReference;
  if (ambiguous)
    result.session.packages[0].parcels.push({ ...result.session.packages[0].parcels[0] });
  if (lostLabel) {
    lostLabel = false;
    throw new Problem(502, 'Lost label response');
  }
  return json(result);
};
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url, method, payload, headers: { cookie: auth } });
async function checked(url: string, method: any = 'GET', payload?: any, auth = cookie) {
  const r = await req(url, method, payload, auth);
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await checked('/api/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(() => {
  calls.length = 0;
  remote.clear();
  ((lostCreate = lostLabel = badPdf = wrongWaybill = missing = ambiguous = wrongCreatedRef = false),
    (rejectData = false));
  hook = undefined;
  foreignLabelReference = undefined;
});
const party = {
  name: 'QA DPD',
  address: 'Testowa 1',
  city: 'Warszawa',
  postalCode: '01-354',
  phone: '500600700',
  email: 'qa@example.test',
};
async function packed() {
  const product = await checked('/api/products', 'POST', {
    sku: 'DPD-' + randomUUID().slice(0, 10),
    name: 'DPD synthetic',
    price: 5000,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 10,
  });
  const order = await checked('/api/orders', 'POST', {
    customer_name: 'QA DPD',
    payment_mode: 'cod',
    email: party.email,
    warehouse_id: warehouse,
    address: {
      street: party.address,
      city: party.city,
      postal_code: party.postalCode,
      country: 'PL',
      phone: party.phone,
    },
    items: [{ product_id: product.id, quantity: 2 }],
  });
  await checked('/api/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => checked(orderPath, 'GET', undefined), '/api/orders/' + order.id + '/status', { status: 'picking' }));
  for (let n = 0; n < 2; n++)
    await checked('/api/orders/' + order.id + '/scan', 'POST', { code: product.sku });
  await checked('/api/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => checked(orderPath, 'GET', undefined), '/api/orders/' + order.id + '/status', { status: 'packed' }));
  return { product, order: await checked('/api/orders/' + order.id) };
}
async function channel(mode = 'sandbox') {
  return (
    await checked('/api/integrations', 'POST', {
      provider: 'dpd',
      name: 'DPD test',
      mode,
      credentials: { username: 'fixture', password: 'fixture-password' },
      settings: {
        master_fid: '1495',
        simulation: 'true',
        store_url: 'https://attacker.example.test',
      },
    })
  ).id;
}
const input = (ch: string) => ({
  channel_id: ch,
  sender: party,
  receiver: party,
  weight: 1.25,
  dimensions: { length: 20, width: 15, height: 10 },
  content: 'Test',
  cod: 10000,
  insurance: 10000,
});
async function setup(mode = 'sandbox', simulation = false) {
  const { product, order } = await packed();
  const ch = simulation
    ? (await checked('/api/dpd-shipping/example', 'POST', {})).channel_id
    : await channel(mode);
  const preview = await checked(
    '/api/orders/' + order.id + '/dpd-shipping/preview',
    'POST',
    input(ch),
  );
  return { product, order, ch, preview };
}
async function plan(id: string) {
  return tenantTx(
    DEMO_TENANT,
    async (c) => (await c.query('SELECT * FROM shipping_plans WHERE id=$1', [id])).rows[0],
  );
}
async function queue(id: string) {
  return checked('/api/dpd-shipping/' + id + '/queue', 'POST', {
    confirm_external: true,
    ack_contract_rate: true,
  });
}
async function run(id: string, onProblem?: (error: Problem) => void) {
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,attempts=attempts+1,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
  try {
    await processDpd(job, { transport });
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    onProblem?.(e);
    await failShipping(job, e);
  }
  return job;
}
const countCreate = () => calls.filter((c) => c.operation === 'generatePackagesNumbers').length;
test('DPD connector fixes official environments, auth and checks read-only routing', async () => {
  const client = new Dpd(
    'sandbox',
    { master_fid: '1495' },
    { username: 'fixture', password: 'fixture-password' },
    transport,
  );
  assert.equal(client.base, 'https://dpdservicesdemo.dpd.com.pl');
  await client.test();
  assert.equal(calls[0].method, 'GET');
  assert.equal(new URL(calls[0].url).searchParams.get('zipCode'), '01354');
  assert.equal(
    new Dpd(
      'live',
      { master_fid: '1495' },
      { username: 'fixture', password: 'fixture-password' },
      transport,
    ).base,
    'https://dpdservices.dpd.com.pl',
  );
  assert.throws(
    () =>
      new Dpd('live', { master_fid: '2147483648' }, { username: 'x', password: 'y' }, transport),
  );
  assert.throws(
    () => new Dpd('live', { master_fid: '1495' }, { username: 'x:y', password: 'y' }, transport),
  );
});
test('DPD config strips synthetic flags and never returns credentials', async () => {
  const id = await channel();
  const d = await checked('/api/integrations');
  const ch = d.channels.find((c: any) => c.id === id);
  assert.deepEqual(ch.settings, { master_fid: '1495' });
  assert.equal(ch.credentials, undefined);
  assert(!JSON.stringify(d).includes('fixture-password'));
  await checked('/api/integrations/' + id + '/test', 'POST', {});
  assert.equal(calls.length, 1);
  assert.equal(
    (
      await req('/api/integrations', 'POST', {
        provider: 'dpd',
        name: 'Bad',
        mode: 'live',
        credentials: { username: 'x', password: 'y' },
        settings: { master_fid: '0' },
      })
    ).statusCode,
    422,
  );
});
test('DPD validates country, parcel units, precise weight and contract amounts', () => {
  const b = input(randomUUID());
  assert.equal(dpdInput.parse(b).receiver.postalCode, '01354');
  for (const bad of [
    { ...b, weight: 1.001 },
    { ...b, weight: 31.51 },
    { ...b, insurance: 9999 },
    { ...b, dimensions: { ...b.dimensions, length: 176 } },
    { ...b, receiver: { ...party, countryCode: 'DE' } },
  ])
    assert.equal(dpdInput.safeParse(bad).success, false);
});
test('DPD preview is local, maps cm/kg and exact COD, requires confirmed contract even in sandbox', async () => {
  const f = await setup();
  assert.equal(calls.length, 0);
  const b = f.preview.payload.packages[0];
  assert.equal(b.parcels[0].sizeX, 20);
  assert.equal(b.parcels[0].weight, 1.25);
  assert.equal(b.receiver.postalCode, '01354');
  assert.equal(b.services[0].attributes[0].value, '100.00');
  assert.equal(
    (await req('/api/dpd-shipping/' + f.preview.id + '/queue', 'POST', {})).statusCode,
    422,
  );
  assert.equal(
    (await req('/api/dpd-shipping/' + f.preview.id + '/queue', 'POST', { confirm_external: true }))
      .statusCode,
    422,
  );
  const q = await queue(f.preview.id);
  assert.equal((await queue(f.preview.id)).job_id, q.job_id);
  assert.equal(calls.length, 0);
});
test('DPD end-to-end numbers and cached PDF preserve reservations then dispatch once', async () => {
  const f = await setup();
  await run((await queue(f.preview.id)).job_id);
  const p = await plan(f.preview.id);
  assert.equal(p.state, 'ready');
  assert.equal(p.result.scope, 'external_sandbox_verified');
  assert.equal(countCreate(), 1);
  const o = await checked('/api/orders/' + f.order.id);
  assert.equal(o.status, 'packed');
  assert.equal(
    (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product.id]))
      .rows[0].reserved,
    2,
  );
  const before = calls.length;
  const r = await req('/api/shipments/' + p.shipment_id + '/label');
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'application/pdf');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.rawPayload.toString(), Buffer.from(pdf, 'base64').toString());
  assert.equal(calls.length, before);
  const list = await checked('/api/orders/' + f.order.id + '/shipping');
  assert.equal(list.data[0].result.label_base64, undefined);
  await checked('/api/dpd-shipping/' + p.id + '/dispatch', 'POST', {});
  await checked('/api/dpd-shipping/' + p.id + '/dispatch', 'POST', {});
  assert.equal((await checked('/api/orders/' + f.order.id)).status, 'shipped');
  assert.deepEqual(
    (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product.id]))
      .rows[0],
    { on_hand: 8, reserved: 0 },
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM stock_movements WHERE order_id=$1 AND kind='shipment'",
        [f.order.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT detail->>'provider' AS p FROM order_events WHERE order_id=$1 AND kind='order.shipped'",
        [f.order.id],
      )
    ).rows[0]?.p,
    'dpd',
  );
});
test('DPD lost create response recovers by parcel reference without another generation', async () => {
  const f = await setup(),
    q = await queue(f.preview.id);
  lostCreate = true;
  await run(q.job_id);
  assert.equal((await plan(f.preview.id)).phase, 'create_started');
  assert.equal((await plan(f.preview.id)).shipment_id, null);
  await run(q.job_id);
  const recovered = await plan(f.preview.id);
  assert.equal(recovered.state, 'ready', recovered.error ?? 'Recovered shipment must be ready');
  assert.equal(countCreate(), 1);
});
async function assertRecoveryUnaccepted(f: Awaited<ReturnType<typeof setup>>) {
  const p = await plan(f.preview.id);
  assert.equal(p.phase, 'create_started'); assert.equal(p.remote_id, null); assert.equal(p.shipment_id, null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM shipments WHERE tenant_id=$1 AND order_id=$2', [DEMO_TENANT,f.order.id])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='dpd.created'",[DEMO_TENANT,f.preview.id])).rows[0].n,0);
  assert.equal((await checked('/api/orders/'+f.order.id)).status,'packed');
  assert.deepEqual((await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',[DEMO_TENANT,f.product.id,warehouse])).rows[0],{on_hand:10,reserved:2});
  assert.equal((await pool.query("SELECT count(*)::int n FROM stock_movements WHERE tenant_id=$1 AND order_id=$2 AND kind='shipment'",[DEMO_TENANT,f.order.id])).rows[0].n,0);
  assert.equal(countCreate(),1);
  return p;
}
async function lostCreateRecovery() {
  const f = await setup(),q = await queue(f.preview.id),errors:number[]=[];
  lostCreate=true; await run(q.job_id,e=>errors.push(e.status)); assert.deepEqual(errors,[502]);
  const p=await assertRecoveryUnaccepted(f); assert.equal(p.state,'queued');
  assert.equal(remote.get(p.payload.packages[0].reference) !== undefined,true,'Remote create actually happened before its ACK was lost');
  return {...f,q};
}
test('DPD lost-create recovery rejects another genuine plan reference before persisting numbers, then valid labels recover without create',async()=>{
  const foreign = await setup(), f = await lostCreateRecovery(), errors:number[]=[];
  foreignLabelReference = (await plan(foreign.preview.id)).payload.packages[0].reference;
  // The response still has one valid PDF/waybill and status OK. Only its parcel
  // reference belongs to the other genuinely created preview/order.
  assert.notEqual(foreignLabelReference,'DYNA-'+f.preview.id);
  try {
    await run(f.q.job_id,e=>errors.push(e.status)); assert.deepEqual(errors,[502]);
    const refused=await assertRecoveryUnaccepted(f); assert.equal(refused.state,'queued');
    assert.match(refused.error,/jednoznacznej etykiety/);
    assert.equal(calls.filter(c=>c.operation==='generateSpedLabels').length,1);
  } finally {foreignLabelReference=undefined;}
  await run(f.q.job_id);
  const recovered=await plan(f.preview.id); assert.equal(recovered.state,'ready',recovered.error??'Recovery must finish only after its own label');
  assert.equal(recovered.remote_id,remote.get('DYNA-'+f.preview.id)); assert(recovered.shipment_id); assert.equal(countCreate(),1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM shipments WHERE tenant_id=$1 AND order_id=$2',[DEMO_TENANT,foreign.order.id])).rows[0].n,0);
});
for(const intrusion of ['expired','replacement'] as const) test(`DPD lost-create ${intrusion} lease after recovery labels refuses the new numbers transition`,async()=>{
  const f=await lostCreateRecovery(),errors:number[]=[],replacement=randomUUID(); let intrudedJob:Record<string,any>|undefined;
  hook=async op=>{
    if(op!=='generateSpedLabels')return;
    if(intrusion==='replacement') await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1',[f.q.job_id,replacement]);
    else await pool.query("UPDATE jobs SET locked_at=now()-interval '3 minutes' WHERE id=$1",[f.q.job_id]);
    intrudedJob=(await pool.query('SELECT * FROM jobs WHERE id=$1',[f.q.job_id])).rows[0];
  };
  try {
    await run(f.q.job_id,e=>errors.push(e.status)); assert.deepEqual(errors,[409]); assert(intrudedJob);
    const refused=await assertRecoveryUnaccepted(f);
    assert.equal(calls.filter(c=>c.operation==='generateSpedLabels').length,1);
    const current=(await pool.query('SELECT * FROM jobs WHERE id=$1',[f.q.job_id])).rows[0];
    if(intrusion==='replacement') {
      assert.deepEqual(current,intrudedJob,'Obsolete worker/fail handler cannot overwrite any replacement job field');
      assert.equal(current.lease_token,replacement); assert.equal(refused.state,'queued');
    } else {assert.equal(current.state,'failed');assert.equal(refused.state,'failed');assert.match(refused.error,/Dzierżawa/);}
  } finally {hook=undefined;}
  const next=intrusion==='expired' ? await checked('/api/dpd-shipping/'+f.preview.id+'/reconcile','POST',{}) : f.q;
  await run(next.job_id);
  const recovered=await plan(f.preview.id); assert.equal(recovered.state,'ready',recovered.error??'Valid renewed recovery must finish'); assert.equal(countCreate(),1);
});
test('DPD lost-create role withdrawal after recovery labels refuses acceptance, restored author reconciles by labels only',async()=>{
  const f=await lostCreateRecovery(),actor=(await plan(f.preview.id)).actor_id,errors:number[]=[];
  const original=(await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2',[DEMO_TENANT,actor])).rows[0]; assert(original);
  hook=async op=>{if(op==='generateSpedLabels')await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",[DEMO_TENANT,actor]);};
  try {
    await run(f.q.job_id,e=>errors.push(e.status)); assert.deepEqual(errors,[403]);
    // Avoid staff API while its actual membership has been withdrawn.
    const p=await plan(f.preview.id); assert.equal(p.state,'failed'); assert.equal(p.phase,'create_started');assert.equal(p.remote_id,null);assert.equal(p.shipment_id,null);
    assert.equal((await pool.query('SELECT count(*)::int n FROM shipments WHERE tenant_id=$1 AND order_id=$2',[DEMO_TENANT,f.order.id])).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='dpd.created'",[DEMO_TENANT,f.preview.id])).rows[0].n,0);
    assert.equal(calls.filter(c=>c.operation==='generateSpedLabels').length,1); assert.equal(countCreate(),1);
  } finally {hook=undefined;await pool.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2',[DEMO_TENANT,actor,original.role]);}
  await assertRecoveryUnaccepted(f);
  const retry=await checked('/api/dpd-shipping/'+f.preview.id+'/reconcile','POST',{});await run(retry.job_id);
  const recovered=await plan(f.preview.id);assert.equal(recovered.state,'ready',recovered.error??'Restored author recovery must finish');assert.equal(countCreate(),1);
});
test('DPD lost label response uses stored waybill and repeats only labels', async () => {
  const f = await setup(),
    q = await queue(f.preview.id);
  lostLabel = true;
  await run(q.job_id);
  assert.equal((await plan(f.preview.id)).phase, 'numbers_ready');
  await run(q.job_id);
  assert.equal((await plan(f.preview.id)).state, 'ready');
  assert.equal(countCreate(), 1);
});
test('DPD never treats missing, ambiguous or foreign label as proof of shipment', async () => {
  for (const key of ['missing', 'ambiguous', 'wrongWaybill', 'badPdf']) {
    const f = await setup(),
      q = await queue(f.preview.id);
    missing = key === 'missing';
    ambiguous = key === 'ambiguous';
    wrongWaybill = key === 'wrongWaybill';
    badPdf = key === 'badPdf';
    await run(q.job_id);
    assert.equal((await plan(f.preview.id)).shipment_id, null);
    missing = ambiguous = wrongWaybill = badPdf = false;
    await run(q.job_id);
    assert.equal((await plan(f.preview.id)).state, 'ready');
  }
  assert.equal(countCreate(), 4);
});
test('DPD failed uncertain result blocks cancellation, duplicate and inpost paths; reconciles without create', async () => {
  const f = await setup(),
    q = await queue(f.preview.id);
  missing = true;
  await run(q.job_id);
  await pool.query('UPDATE jobs SET attempts=4 WHERE id=$1', [q.job_id]);
  await run(q.job_id);
  assert.equal((await plan(f.preview.id)).state, 'failed');
  assert.equal(
    (await req('/api/shipping-plans/' + f.preview.id + '/cancel', 'POST', {})).statusCode,
    409,
  );
  assert.equal(
    (await req('/api/shipping-plans/' + f.preview.id + '/reconcile', 'POST', {})).statusCode,
    422,
  );
  assert.equal(
    (await req('/api/shipping-plans/' + f.preview.id + '/queue', 'POST', {})).statusCode,
    422,
  );
  const another = await checked(
    '/api/orders/' + f.order.id + '/dpd-shipping/preview',
    'POST',
    input(f.ch),
  );
  assert.equal(
    (
      await req('/api/dpd-shipping/' + another.id + '/queue', 'POST', {
        confirm_external: true,
        ack_contract_rate: true,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await req('/api/orders/' + f.order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/api/orders/' + f.order.id + '/status', { status: 'cancelled' })))
      .statusCode,
    409,
  );
  missing = false;
  const retry = await checked('/api/dpd-shipping/' + f.preview.id + '/reconcile', 'POST', {});
  await run(retry.job_id);
  assert.equal((await plan(f.preview.id)).state, 'ready');
  assert.equal(countCreate(), 1);
});
test('DPD expired preview cancels locally without a provider call', async () => {
  const f = await setup();
  await pool.query("UPDATE shipping_plans SET created_at=now()-interval '31 minutes' WHERE id=$1", [
    f.preview.id,
  ]);
  assert.equal(
    (
      await req('/api/dpd-shipping/' + f.preview.id + '/queue', 'POST', {
        confirm_external: true,
        ack_contract_rate: true,
      })
    ).statusCode,
    409,
  );
  await checked('/api/shipping-plans/' + f.preview.id + '/cancel', 'POST', {});
  assert.equal((await plan(f.preview.id)).state, 'cancelled');
  assert.equal(calls.length, 0);
});
test('DPD roles and foreign tenant cannot create, read labels, queue or dispatch', async () => {
  const f = await setup();
  assert.equal(
    (await req('/api/orders/' + f.order.id + '/dpd-shipping/preview', 'POST', input(f.ch), viewer))
      .statusCode,
    403,
  );
  assert.equal(
    (await req('/api/orders/' + f.order.id + '/dpd-shipping/preview', 'POST', input(f.ch), other))
      .statusCode,
    422,
  );
  assert.equal(
    (
      await req(
        '/api/dpd-shipping/' + f.preview.id + '/queue',
        'POST',
        { confirm_external: true, ack_contract_rate: true },
        operator,
      )
    ).statusCode,
    403,
  );
  await run((await queue(f.preview.id)).job_id);
  const p = await plan(f.preview.id);
  assert.equal(
    (await req('/api/shipments/' + p.shipment_id + '/label', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req('/api/dpd-shipping/' + p.id + '/dispatch', 'POST', {}, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req('/api/dpd-shipping/' + p.id + '/dispatch', 'POST', {}, other)).statusCode,
    404,
  );
});
test('DPD loss of role during routing stops generation before POST', async () => {
  const f = await setup(),
    q = await queue(f.preview.id),
    actor = (await plan(f.preview.id)).actor_id;
  hook = async (operation) => {
    if (operation === 'postalCode')
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        actor,
      ]);
  };
  try {
    await run(q.job_id);
    assert.equal(countCreate(), 0);
    assert.equal((await plan(f.preview.id)).state, 'failed');
  } finally {
    hook = undefined;
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actor,
    ]);
  }
});
test('DPD account change after remote create fences local acceptance and further HTTP', async () => {
  const f = await setup(),
    q = await queue(f.preview.id);
  hook = async (operation) => {
    if (operation === 'generatePackagesNumbers')
      await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
        f.ch,
        encrypt({ username: 'other-account', password: 'other' }),
      ]);
  };
  await run(q.job_id);
  assert.equal((await plan(f.preview.id)).state, 'failed');
  assert.equal((await plan(f.preview.id)).shipment_id, null);
  assert.equal(calls.filter((c) => c.operation === 'generateSpedLabels').length, 0);
  assert.equal(countCreate(), 1);
});
test('DPD changed order before worker stops all remote traffic', async () => {
  const f = await setup(),
    q = await queue(f.preview.id);
  await pool.query('UPDATE orders SET updated_at=now() WHERE id=$1', [f.order.id]);
  await run(q.job_id);
  assert.equal((await plan(f.preview.id)).state, 'failed');
  assert.equal(calls.length, 0);
});
test('DPD simulation stays entirely local and uses demo print and stock dispatch', async () => {
  const f = await setup('sandbox', true);
  await run((await queue(f.preview.id)).job_id);
  const p = await plan(f.preview.id);
  assert.equal(p.state, 'ready');
  assert.equal(p.result.scope, 'local_simulation');
  const r = await req('/api/shipments/' + p.shipment_id + '/label');
  assert.match(r.body, /ETYKIETA TESTOWA/);
  assert.match(r.body, /DPD Polska/);
  await checked('/api/dpd-shipping/' + p.id + '/dispatch', 'POST', {});
  assert.equal(calls.length, 0);
});
test('DPD decoder refuses arbitrary base64, missing PDF and mismatched parcel proof', () => {
  for (const b of [
    '@@@',
    Buffer.from('html').toString('base64'),
    '',
    pdf + '\n',
    'A'.repeat(6 * 1024 * 1024 + 4),
  ])
    assert.throws(() => dpdPdf(b));
  assert.throws(() => verifiedDpdLabel(labels('DYNA-' + randomUUID(), '0000889101439Q'), 'other'));
});

test('DPD explicit validation rejection can be cancelled and corrected with a fresh preview', async () => {
  const f = await setup();
  rejectData = true;
  await run((await queue(f.preview.id)).job_id);
  const p = await plan(f.preview.id);
  assert.equal(p.state, 'failed');
  assert.equal(p.phase, 'rejected');
  assert.equal(remote.size, 0);
  await checked('/api/shipping-plans/' + p.id + '/cancel', 'POST', {});
  rejectData = false;
  const next = await checked(
    '/api/orders/' + f.order.id + '/dpd-shipping/preview',
    'POST',
    input(f.ch),
  );
  await run((await queue(next.id)).job_id);
  assert.equal((await plan(next.id)).state, 'ready');
  assert.equal(remote.size, 1);
});
test('DPD known number freezes payment changes while an uncertain label is reconciled', async () => {
  const f = await setup(),
    q = await queue(f.preview.id);
  lostLabel = true;
  await run(q.job_id);
  const order = await checked('/api/orders/' + f.order.id);
  const r = await req('/api/orders/' + f.order.id + '/payments', 'POST', {
    client_key: randomUUID(),
    version: Number(order.version),
    kind: 'receipt',
    amount: 100,
    currency: 'PLN',
    reference: 'Unsafe COD change',
    confirmed: true,
  });
  assert.equal(r.statusCode, 409);
  await run(q.job_id);
  assert.equal((await plan(f.preview.id)).state, 'ready');
});
test('DPD expired lease after label response cannot create a shipment or overwrite replacement job', async () => {
  const f = await setup(),
    q = await queue(f.preview.id);
  const replacement = randomUUID();
  hook = async (op) => {
    if (op === 'generateSpedLabels')
      await pool.query('UPDATE jobs SET lease_token=$2 WHERE id=$1', [q.job_id, replacement]);
  };
  await run(q.job_id);
  const p = await plan(f.preview.id);
  assert.equal(p.shipment_id, null);
  assert.equal(p.phase, 'numbers_ready');
  assert.equal(
    (await pool.query('SELECT lease_token FROM jobs WHERE id=$1', [q.job_id])).rows[0].lease_token,
    replacement,
  );
  hook = undefined;
  await run(q.job_id);
  assert.equal((await plan(f.preview.id)).state, 'ready');
  assert.equal(countCreate(), 1);
});
test('DPD simultaneous approvals and distinct previews produce one active generation job', async () => {
  const f = await setup();
  const second = await checked(
    '/api/orders/' + f.order.id + '/dpd-shipping/preview',
    'POST',
    input(f.ch),
  );
  const qs = await Promise.all([queue(f.preview.id), queue(f.preview.id)]);
  assert.equal(qs[0].job_id, qs[1].job_id);
  const other = await req('/api/dpd-shipping/' + second.id + '/queue', 'POST', {
    confirm_external: true,
    ack_contract_rate: true,
  });
  assert.equal(other.statusCode, 409);
  await run(qs[0].job_id);
  assert.equal(countCreate(), 1);
});
test('DPD restore preview serves cached PDF without provider HTTP and refuses mutation', async () => {
  const f = await setup();
  await run((await queue(f.preview.id)).job_id);
  const p = await plan(f.preview.id),
    before = calls.length;
  const restored = await buildApp({
    readOnly: true,
    previewPort: 4101,
    integrationTransport: async () => {
      assert.fail('Restore cannot contact provider');
    },
  });
  try {
    const login = await restored.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    });
    const auth = login.headers['set-cookie']!.toString().split(';')[0];
    const r = await restored.inject({
      url: '/api/shipments/' + p.shipment_id + '/label',
      headers: { cookie: auth },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.rawPayload.toString(), Buffer.from(pdf, 'base64').toString());
    assert.equal(
      (
        await restored.inject({
          url: '/api/dpd-shipping/' + p.id + '/dispatch',
          method: 'POST',
          payload: {},
          headers: { cookie: auth },
        })
      ).statusCode,
      423,
    );
    assert.equal(calls.length, before);
  } finally {
    await restored.close();
  }
});
