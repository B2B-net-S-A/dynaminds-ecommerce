import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Mirakl, MiraklReadDeferred, MIRAKL_ADAPTER_STATUS, miraklInstance, miraklMoney,
  normalizeMiraklOrder, normalizeMiraklOffer, type MiraklReadCursor} from '../server/mirakl';
import type {Transport} from '../server/integrations';
import {Problem} from '../server/errors';

// Controlled protocol fixtures from the documented A01/OR11/OF21 projection;
// they are not recordings from a provider account or proof of account acceptance.
const secret = 'MIRAKL_PRIVATE_KEY_NEVER_IN_ERROR';
const settings = {instance_url: 'https://local-contract.mirakl.net', shop_id: '2000', currency: 'PLN' as const};
const window = {start_update_date: '2026-10-01T00:00:00Z', end_update_date: '2026-10-02T00:00:00Z'};
const query = {window, max: 1};
const account = () => ({shop_id: 2000, shop_name: 'Controlled shop', currency_iso_code: 'PLN', shop_state: 'OPEN', model: 'MARKETPLACE'});
const line = (id = 'ORDER-1-L1') => ({order_line_id: id, offer_id: 101, offer_sku: 'SKU-1',
  product_title: 'Controlled product', quantity: 2, price: 20.1, shipping_price: 4.9, total_price: 25,
  order_line_state: 'SHIPPING', cancelations: [], refunds: [], fees: []});
const order = (id = 'ORDER-1') => ({order_id: id, currency_iso_code: 'PLN', order_state: 'SHIPPING',
  last_updated_date: '2026-10-01T12:00:00Z', order_tax_mode: 'TAX_INCLUDED',
  customer: {firstname: 'Jan', lastname: 'Testowy', shipping_address: {firstname: 'Jan', lastname: 'Testowy',
    street_1: 'Testowa 1', city: 'Warszawa', zip_code: '00-001', country_iso_code: 'POL'}},
  customer_notification_email: 'controlled@example.com', customer_debited_date: '2026-10-01T11:00:00Z',
  customer_directly_pays_seller: false, payment_workflow: 'PAY_ON_ACCEPTANCE', payment_type: 'Visa', fully_refunded: false,
  has_incident: false, price: 20.1, shipping_price: 4.9, total_price: 25, order_lines: [line()]});
const offer = (id = 101) => ({offer_id: id, shop_sku: 'SKU-1', product_sku: 'CATALOG-1',
  product_title: 'Controlled product', currency_iso_code: 'PLN', price: 20.1, quantity: 7, active: true, state_code: '11'});
const json = (data: unknown, status = 200, headers: Record<string,string> = {}) =>
  new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json', ...headers}});
type Call = {url: URL; init: RequestInit};
function harness(respond: (c: Call) => Response|Promise<Response> = c =>
  c.url.pathname === '/api/account' ? json(account()) : c.url.pathname === '/api/orders'
    ? json({orders: [order()], total_count: 1}) : json({offers: [offer()], total_count: 1})) {
  const calls: Call[] = [];
  const transport: Transport = async (url, init) => {const c = {url: new URL(url), init}; calls.push(c); return respond(c);};
  return {client: new Mirakl(settings, {api_key: secret}, transport), calls, transport};
}
const rejected = (status: number) => (e: unknown) => e instanceof Problem && e.status === status
  && !e.message.includes(secret) && !e.message.includes('REMOTE_PAYLOAD');

test('inert private configuration, own A01 binding and cached identity; GET only', async () => {
  const supplied = {...settings}, credentials = {api_key: secret};
  const {calls, transport} = harness();
  const client = new Mirakl(supplied, credentials, transport);
  supplied.shop_id = '999'; credentials.api_key = 'MUTATED';
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(client), '{}');
  assert.equal(MIRAKL_ADAPTER_STATUS, 'CODE_NOT_CONNECTED_NOT_ACCOUNT_ACCEPTED');
  await assert.rejects(client.orders(query), rejected(422));
  assert.equal(calls.length, 0);
  const [a,b] = await Promise.all([client.account(), client.account()]);
  a.shop_id = 999;
  assert.equal(b.shop_id, 2000);
  assert.equal((await client.account()).shop_id, 2000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, settings.instance_url);
  assert.equal(calls[0].url.searchParams.get('shop_id'), '2000');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal((calls[0].init.headers as Record<string,string>).Authorization, secret);
  assert.equal(calls[0].init.body, undefined);
});

test('foreign account, currency and unsupported account models fail before subsequent reads', async () => {
  for (const changed of [{shop_id: 2001}, {currency_iso_code: 'EUR'}, {model: 'DROPSHIP'}]) {
    const h = harness(() => json({...account(), ...changed}));
    await assert.rejects(h.client.account(), e => e instanceof Problem && [422,502].includes(e.status));
    await assert.rejects(h.client.account()); // same failed promise: no hidden retry of A01
    await assert.rejects(h.client.offers(), rejected(422));
    assert.equal(h.calls.length, 1);
  }
});

test('origin and private settings reject paths, aliases, credential URLs, private addresses and unknown query settings', () => {
  for (const origin of ['http://shop.mirakl.net','https://shop.example','https://mirakl.net',
    'https://shop.mirakl.net.evil.example','https://user:pass@shop.mirakl.net','https://shop.mirakl.net:8443',
    'https://shop.mirakl.net/api','https://shop.mirakl.net/?shop_id=999','https://127.0.0.1','https://shop.mirakl.net/#x'])
    assert.throws(() => miraklInstance(origin), rejected(422));
  for (const changed of [{shop_id: '0'}, {shop_id: '01'}, {shop_id: '9007199254740992'}, {api_key: secret}, {currency: 'JPY'}])
    assert.throws(() => new Mirakl({...settings, ...changed} as never, {api_key: secret}, async () => json(account())), rejected(422));
  for (const value of ['', 'x\r\nAuthorization: evil','x y','ą'])
    assert.throws(() => new Mirakl(settings, {api_key: value}, async () => json(account())), rejected(422));
});

test('OR11 fixed own shop, bounded window, tax mode, offset, limit and encoded dates', async () => {
  const h = harness(); await h.client.account();
  const page = await h.client.orders(query);
  assert.equal(page.data[0].id, 'ORDER-1'); assert.equal(page.has_more, false); assert.equal(page.next_cursor, null);
  const c = h.calls.at(-1)!;
  assert.equal(c.url.pathname, '/api/orders');
  assert.deepEqual(Object.fromEntries(c.url.searchParams), {shop_id: '2000', max: '1',
    start_update_date: window.start_update_date, end_update_date: window.end_update_date,
    order_tax_mode: 'TAX_INCLUDED', sort: 'dateCreated', order: 'asc', offset: '0'});
  assert.match(c.url.href, /00%3A00%3A00Z/);
  const before = h.calls.length;
  for (const bad of [{...query, shop_id: '999'}, {...query, max: 101}, {...query, max: 0}, {...query, offset: -1},
    {...query, window: {...window, end_update_date: window.start_update_date}},
    {...query, window: {...window, end_update_date: '2026-12-01T00:00:00Z'}},
    {...query, window: {...window, start_update_date: '2026-02-30T00:00:00Z'}}])
    await assert.rejects(h.client.orders(bad), rejected(422));
  assert.equal(h.calls.length, before);
});

test('OR11 permits documented lower-bound overlap but refuses beyond end, wrong currency or tax mode', async () => {
  for (const changed of [{last_updated_date: '2026-10-03T00:00:00Z'}, {currency_iso_code:'EUR'}, {order_tax_mode:'TAX_EXCLUDED'}]) {
    const h = harness(c => c.url.pathname === '/api/account' ? json(account()) : json({orders: [{...order(), ...changed}], total_count: 1}));
    await h.client.account(); await assert.rejects(h.client.orders(query), rejected(502));
  }
  const h = harness(c => c.url.pathname === '/api/account' ? json(account()) :
    json({orders: [{...order(), last_updated_date:'2026-09-30T23:59:59Z'}], total_count:1}));
  await h.client.account(); assert.equal((await h.client.orders(query)).data.length, 1);
});

test('restartable OR11 page uses explicit bounded offset with no transferable cursor', async () => {
  const h = harness(c => c.url.pathname === '/api/account' ? json(account())
    : json({orders: [order('ORDER-2')], total_count: 2}));
  await h.client.account();
  const page = await h.client.ordersPage(query, 1);
  assert.equal(h.calls.at(-1)!.url.searchParams.get('offset'), '1');
  assert.deepEqual(Object.keys(page).sort(), ['data','has_more','offset','total_count']);
  assert.equal(page.data[0].id, 'ORDER-2'); assert.equal(page.offset, 1); assert.equal(page.has_more, false);
  const before = h.calls.length;
  for (const offset of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 10001])
    await assert.rejects(h.client.ordersPage(query, offset), rejected(422));
  assert.equal(h.calls.length, before);
  const duplicate = harness(c => c.url.pathname === '/api/account' ? json(account())
    : json({orders: [order(), order()], total_count: 4}));
  await duplicate.client.account();
  await assert.rejects(duplicate.client.ordersPage({...query,max:2},2),rejected(502));
});

test('OF21 single-page reads preserve exact offset/SKU and never invent a cursor or fetch the next page', async () => {
  const h = harness(c => c.url.pathname === '/api/account' ? json(account())
    : json({offers:[offer(201 + Number(c.url.searchParams.get('offset')))],total_count:103}));
  await assert.rejects(h.client.offersPage({max:1},100),rejected(422));
  assert.equal(h.calls.length,0,'account admission still precedes OF21');
  await h.client.account();
  const page=await h.client.offersPage({max:1,sku:'SKU /ą'},100);
  assert.deepEqual(page,{data:[{...offer(301),id:'301'}],offset:100,total_count:103,has_more:true});
  assert.deepEqual(Object.fromEntries(h.calls.at(-1)!.url.searchParams),{shop_id:'2000',max:'1',sku:'SKU /ą',offset:'100'});
  assert.equal(h.calls.length,2,'one A01 and one requested page, no continuation');
  const before=h.calls.length;
  for(const offset of [-1,0.5,NaN,Infinity,10001])await assert.rejects(h.client.offersPage({},offset),rejected(422));
  for(const q of [{max:101},{shop_id:'foreign'},{offset:100}])await assert.rejects(h.client.offersPage(q),rejected(422));
  assert.equal(h.calls.length,before);
  const first=await h.client.offersPage({max:1});assert.equal(first.offset,0);assert.equal(h.calls.at(-1)!.url.searchParams.get('offset'),'0');
});

test('OF21 explicit page retains malformed, duplicate, empty-progress and currency refusal',async()=>{
  for(const body of [{offers:[offer(),offer()],total_count:102},{offers:[],total_count:102},
    {offers:[{...offer(),currency_iso_code:'EUR'}],total_count:101},{offers:[offer()],total_count:100}]){
    const h=harness(c=>c.url.pathname==='/api/account'?json(account()):json(body));await h.client.account();
    await assert.rejects(h.client.offersPage({max:2},100),rejected(502));assert.equal(h.calls.length,2);
  }
});

test('continuation advances constructed offset and rejects repeated provider pages across requests', async () => {
  const h = harness(c => c.url.pathname === '/api/account' ? json(account()) : json({orders: [order()], total_count: 2}));
  await h.client.account(); const first = await h.client.orders(query);
  assert.equal(first.has_more, true); assert.equal(first.next_cursor?.offset, 1);
  await assert.rejects(h.client.orders(query, first.next_cursor!), rejected(502));
  assert.equal(h.calls.at(-1)!.url.searchParams.get('offset'), '1');
});

test('two distinct pages finish with stable total and initial empty collection finishes without a cursor', async () => {
  const h = harness(c => c.url.pathname === '/api/account' ? json(account()) :
    json({orders: [order(c.url.searchParams.get('offset') === '0' ? 'FIRST' : 'SECOND')], total_count: 2}));
  await h.client.account();
  const first = await h.client.orders(query), last = await h.client.orders(query, first.next_cursor!);
  assert.deepEqual([first.data[0].id,last.data[0].id],['FIRST','SECOND']);
  assert.equal(last.offset,1); assert.equal(last.has_more,false); assert.equal(last.next_cursor,null);
  const empty = harness(c => c.url.pathname === '/api/account' ? json(account()) : json({offers:[],total_count:0}));
  await empty.client.account();
  assert.deepEqual(await empty.client.offers(),{data:[],offset:0,total_count:0,has_more:false,next_cursor:null});
});

test('cursor is bound to client, operation and exact query; serialized cursor does not authorize', async () => {
  const h = harness(c => c.url.pathname === '/api/account' ? json(account()) : json({orders: [order()], total_count: 2}));
  await h.client.account(); const first = await h.client.orders(query), cursor = first.next_cursor!;
  const count = h.calls.length;
  await assert.rejects(h.client.orders({...query,max:2},cursor), rejected(422));
  await assert.rejects(h.client.offers({},cursor), rejected(422));
  await assert.rejects(h.client.orders(query,JSON.parse(JSON.stringify(cursor)) as MiraklReadCursor), rejected(422));
  assert.equal(h.calls.length, count);
  const other = harness(); await other.client.account();
  await assert.rejects(other.client.orders(query,cursor), rejected(422)); assert.equal(other.calls.length, 1);
});

test('empty, overfull, duplicate and unstable result sets cannot make pagination progress', async () => {
  for (const data of [{orders:[],total_count:2}, {orders:[order(),order()],total_count:2},
    {orders:[order()],total_count:0}, {orders:[order()],total_count:1000001}, {orders:[order()],total_count:'1'}]) {
    const h = harness(c => c.url.pathname === '/api/account' ? json(account()) : json(data));
    await h.client.account(); await assert.rejects(h.client.orders({...query,max:2}), rejected(502));
  }
  let pages = 0;
  const h = harness(c => c.url.pathname === '/api/account' ? json(account()) : json({orders:[order('ORDER-'+(++pages))], total_count:pages===1?2:3}));
  await h.client.account(); const first = await h.client.orders(query);
  await assert.rejects(h.client.orders(query,first.next_cursor!), rejected(502));
});

test('OF21 own-shop read, exact SKU query and offer projection preserve documented money and quantities', async () => {
  const h = harness(); await h.client.account();
  const page = await h.client.offers({sku:'SKU & /? 1',max:10});
  assert.equal(h.calls.at(-1)!.url.searchParams.get('sku'), 'SKU & /? 1');
  assert.equal(h.calls.at(-1)!.url.searchParams.get('shop_id'),'2000');
  assert.equal(page.data[0].id,'101');
  assert.deepEqual(normalizeMiraklOffer(page.data[0],'PLN'), {external_id:'101',sku:'SKU-1',name:'Controlled product',
    price:2010,stock:7,quantity:7,currency:'PLN',active:true,source_status:'11'});
  await assert.rejects(h.client.offers({shop_id:'foreign'} as never),rejected(422));
  assert.throws(()=>normalizeMiraklOffer({...offer(),quantity:1.5},'PLN'),rejected(422));
  assert.throws(()=>normalizeMiraklOffer(offer(),'EUR'),rejected(422));
});

test('order normalization preserves source line identity, same-SKU lines, exact sums and explicit country mapping', () => {
  const o = order(); o.order_lines.push({...line('ORDER-1-L2')}); o.price=40.2; o.shipping_price=9.8; o.total_price=50;
  const n = normalizeMiraklOrder(o,'PLN');
  assert.equal(n.items.length,2); assert.equal(n.items[1].remote_line_id,'ORDER-1-L2');
  assert.equal(n.items[0].sku,n.items[1].sku); assert.equal(n.items[0].line_total,2010);
  assert.equal(n.total,5000); assert.equal(n.shipping_cost,980); assert.equal(n.paid_amount,5000);
  assert.equal(n.address.country,'PL'); assert.deepEqual(n.blockers,[]);
  assert.throws(()=>normalizeMiraklOrder({...o,total_price:49.99},'PLN'),rejected(422));
  assert.throws(()=>normalizeMiraklOrder({...order(),order_lines:[line(),line()]},'PLN'),rejected(422));
  assert.throws(()=>normalizeMiraklOrder({...order(),customer:{shipping_address:null}},'PLN'),rejected(422));
});

test('unknown provider state/workflow, corrections and special fulfillment remain visible blockers', () => {
  const unknown = normalizeMiraklOrder({...order(),order_state:'FUTURE_PROVIDER_STATE',payment_workflow:'FUTURE_WORKFLOW'},'PLN');
  assert.equal(unknown.source_status,'FUTURE_PROVIDER_STATE'); assert.equal(unknown.paid,false);
  assert.ok(unknown.blockers.length>=2);
  const refunded = {...order(), order_lines:[{...line(),refunds:[{amount:1}]}]};
  assert.ok(normalizeMiraklOrder(refunded,'PLN').blockers.length); assert.equal(normalizeMiraklOrder(refunded,'PLN').paid,false);
  assert.ok(normalizeMiraklOrder({...order(),fulfillment:{center:{code:'EXTERNAL'}}},'PLN').blockers.length);
  const advanced = {...order(),order_lines:[{...line(),price_amount_breakdown:{parts:[]}}]};
  assert.ok(normalizeMiraklOrder(advanced,'PLN').blockers.length);
});

test('wire money is numeric, exact to minor units and never silently rounded', async () => {
  assert.equal(miraklMoney(0.29),29); assert.equal(miraklMoney(21474836.47),2147483647);
  for (const bad of ['10.00',-1,-0,0.001,21474836.48,NaN,Infinity]) assert.throws(()=>miraklMoney(bad),rejected(422));
  for (const bad of [0.001,21474836.48,'20.1']) {
    const h=harness(c=>c.url.pathname==='/api/account'?json(account()):json({offers:[{...offer(),price:bad}],total_count:1}));
    await h.client.account(); await assert.rejects(h.client.offers(),rejected(502));
  }
  const h=harness(c=>c.url.pathname==='/api/account'?json(account()):new Response(
    '{"offers":[{"offer_id":101,"shop_sku":"SKU-1","product_sku":"X","product_title":"X","currency_iso_code":"PLN","price":1.0000000000000001,"quantity":1,"active":true,"state_code":"11"}],"total_count":1}',
    {headers:{'content-type':'application/json'}}));
  await h.client.account(); await assert.rejects(h.client.offers(),rejected(502));
});

test('Retry-After is deferred unchanged without transport retry or blocked event loop', async () => {
  for (const status of [429,503]) {
    const h=harness(()=>json({REMOTE_PAYLOAD:secret},status,{'retry-after':'120'}));
    await assert.rejects(h.client.account(),e=>e instanceof MiraklReadDeferred && e.seconds===120 && !e.message.includes(secret));
    assert.equal(h.calls.length,1);
  }
});

test('transport exceptions, error bodies, redirects, malformed JSON/UTF8 and oversized bodies are redacted', async () => {
  const cases: Array<()=>Response|Promise<Response>> = [
    ()=>{throw new Error(secret+' REMOTE_PAYLOAD');},()=>json({REMOTE_PAYLOAD:secret},401),
    ()=>json({REMOTE_PAYLOAD:secret},403),()=>new Response(null,{status:302,headers:{location:'https://evil.example/?'+secret}}),
    ()=>{const r=json(account());Object.defineProperty(r,'url',{value:'https://foreign.mirakl.net/api/account'});return r;},
    ()=>new Response(secret,{headers:{'content-type':'text/html'}}),
    ()=>new Response('{REMOTE_PAYLOAD:'+secret,{headers:{'content-type':'application/json'}}),
    ()=>new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}),
    ()=>new Response(' '.repeat(2*1024*1024+1),{headers:{'content-type':'application/json'}}),
  ];
  for(const respond of cases){const h=harness(respond);await assert.rejects(h.client.account(),e=>e instanceof Problem
    && [401,403,502].includes(e.status)&&!e.message.includes(secret)&&!e.message.includes('REMOTE_PAYLOAD'));assert.equal(h.calls.length,1);}
});


test('payment workflow never creates courier COD; only documented platform debit is confirmed', async () => {
  for (const workflow of ['PAY_ON_ACCEPTANCE','PAY_ON_SHIPMENT','PAY_ON_DELIVERY']) {
    const source={...order(),payment_workflow:workflow,payment_type:'Operator-specific opaque method'};
    const normalized=normalizeMiraklOrder(source,'PLN');
    assert.equal(normalized.payment_mode,'prepaid');assert.equal(normalized.paid,true);assert.equal(normalized.paid_amount,2500);assert.deepEqual(normalized.blockers,[]);
    const pending=normalizeMiraklOrder({...source,customer_debited_date:null},'PLN');
    assert.equal(pending.payment_mode,'prepaid');assert.equal(pending.paid,false);assert.equal(pending.paid_amount,0);assert(pending.blockers.length>0);
  }
  for(const patch of [{customer_directly_pays_seller:true},{payment_workflow:'UNKNOWN_WORKFLOW'},{fully_refunded:true},{order_refunds:[{amount:25}]}]) {
    const normalized=normalizeMiraklOrder({...order(),payment_workflow:'PAY_ON_DELIVERY',...patch},'PLN');
    assert.equal(normalized.payment_mode,'prepaid');assert.equal(normalized.paid,false);assert.equal(normalized.paid_amount,0);assert(normalized.blockers.length>0);
  }
  const h=harness(c=>c.url.pathname==='/api/account'?json(account()):json({orders:[order()],total_count:1}));
  await h.client.account();assert.equal((await h.client.orders(query)).data[0].payment_type,'Visa');
});

test('stream and response exceptions redact even Problem and mutated previous public errors', async () => {
  const earlier=harness(()=>json({},401));let prior:Problem|undefined;
  try{await earlier.client.account();}catch(e){assert(e instanceof Problem);prior=e;}
  assert(prior);prior.message=secret+' REMOTE_PAYLOAD';
  const faults=[new Problem(403,secret+' REMOTE_PAYLOAD'),prior,new Error(secret+' REMOTE_PAYLOAD')];
  for(const fault of faults) {
    for(const mode of ['transport','stream','headers','body'] as const) {
      const h=harness(()=>{
        if(mode==='transport')throw fault;
        if(mode==='stream')return new Response(new ReadableStream({start(controller){controller.error(fault);}}),{headers:{'content-type':'application/json'}});
        const response=json(account());
        Object.defineProperty(response,mode,{get(){throw fault;}});return response;
      });
      await assert.rejects(h.client.account(),rejected(502));assert.equal(h.calls.length,1);
    }
  }
});

test('OR11 exact IDs preserve literal IDs, use a bounded comma-separated filter and report missing IDs without staging',async()=>{
 const ids=['A +ż/?&','ORDER-2','MISSING'];
 const h=harness(c=>c.url.pathname==='/api/account'?json(account()):json({orders:[order(ids[1]),order(ids[0])],total_count:2}));
 await h.client.account();const r=await h.client.ordersByIds({order_ids:ids});
 assert.deepEqual(Object.fromEntries(h.calls[1].url.searchParams),{shop_id:'2000',order_ids:ids.join(','),max:'100',offset:'0',order_tax_mode:'TAX_INCLUDED',sort:'dateCreated',order:'asc'});
 assert.equal(h.calls[1].init.method,'GET');assert.equal(h.calls[1].init.body,undefined);assert.equal(h.calls[1].init.redirect,'error');
 assert.deepEqual(r.requested_order_ids,ids);assert.deepEqual(r.group_order_ids,ids);assert.deepEqual(r.group_missing_order_ids,['MISSING']);
 assert.equal(r.readback_scope,'single_group');assert.equal(r.readback_complete,false);assert.equal(r.group_count,1);assert.equal(r.next_group,null);
 assert.deepEqual(r.data.map(o=>o.id),[ids[1],ids[0]]);assert(!h.calls[1].url.searchParams.has('start_update_date'));
 const full=harness(c=>c.url.pathname==='/api/account'?json(account()):json({orders:[order('ONLY')],total_count:1}));await full.client.account();assert.equal((await full.client.ordersByIds({order_ids:['ONLY']})).readback_complete,true);
});

test('100 requested IDs form deterministic UTF8-bounded groups; each explicit call reads one group without auto-continuation or global completion',async()=>{
 const ids=Array.from({length:100},(_,i)=>String(i+1));
 const h=harness(c=>c.url.pathname==='/api/account'?json(account()):json({orders:(c.url.searchParams.get('order_ids')??'').split(',').map(id=>order(id)),total_count:(c.url.searchParams.get('order_ids')??'').split(',').length}));
 await h.client.account();
 for(const [group,expected]of [[0,ids.slice(0,36)],[1,ids.slice(36,69)],[2,ids.slice(69)]] as const){
  const r=await h.client.ordersByIds({order_ids:ids,group});
  assert.deepEqual(r.group_order_ids,expected);assert.equal(r.group_count,3);assert.equal(r.group_index,group);assert.equal(r.readback_complete,false);
  assert.deepEqual(r.group_missing_order_ids,[]);assert.equal(r.has_more_groups,group<2);assert.equal(r.next_group,group<2?group+1:null);
  assert(Buffer.byteLength(h.calls.at(-1)!.url.searchParams.get('order_ids')!,'utf8')<=100);assert.equal(h.calls.length,group+2);
 }
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls.length,4,'no queued HTTP/hidden next group');
 const unicode=harness(c=>c.url.pathname==='/api/account'?json(account()):json({orders:[],total_count:0}));await unicode.client.account();
 const r=await unicode.client.ordersByIds({order_ids:['ż'.repeat(30),'ą'.repeat(30)]});assert.equal(r.group_count,2);assert.deepEqual(r.group_order_ids,['ż'.repeat(30)]);
 const edge=await unicode.client.ordersByIds({order_ids:['ż'.repeat(50),'A'],group:0});assert.equal(edge.group_count,2);assert.equal(Buffer.byteLength(unicode.calls.at(-1)!.url.searchParams.get('order_ids')!,'utf8'),100);
});

test('malformed exact IDs, duplicate identifiers and explicit local group/byte limits fail before any HTTP without normalizing IDs',async()=>{
 const h=harness();
 for(const bad of [{order_ids:[]},{order_ids:['A','A']},{order_ids:['A,B']},{order_ids:['']},{order_ids:['A\nB']},
  {order_ids:[String.fromCharCode(0xd800)]},{order_ids:Array.from({length:101},(_,i)=>String(i))},
  {order_ids:['A'],group:1},{order_ids:['A'],group:-1},{order_ids:['A'],group:0.5},{order_ids:['A'],shop_id:'OTHER'},
  {order_ids:['A'],window},{order_ids:'A'},{order_ids:['A'],offset:0}])await assert.rejects(h.client.ordersByIds(bad as never),rejected(422));
 await assert.rejects(h.client.ordersByIds({order_ids:['ż'.repeat(51)]}),e=>e instanceof Problem&&e.code==='MIRAKL_EXACT_IDS_LOCAL_LIMIT');
 await assert.rejects(h.client.ordersByIds({order_ids:['A']}),rejected(422));assert.equal(h.calls.length,0,'valid request also requires own A01');
});

test('exact-ID provider subset is explicit; duplicate, unexpected, incomplete total/has_more and tax/currency drift all refuse',async()=>{
 for(const response of [{orders:[order('FOREIGN')],total_count:1},{orders:[order('A'),order('A')],total_count:2},
  {orders:[order('A')],total_count:2},{orders:[order('A')],total_count:0},{orders:[order('A')],total_count:1,has_more:true},
  {orders:[order('A')],total_count:1,has_more:'false'},{orders:[{...order('A'),currency_iso_code:'EUR'}],total_count:1},
  {orders:[{...order('A'),order_tax_mode:'TAX_EXCLUDED'}],total_count:1},{orders:[order('A'),order('B'),order('C')],total_count:3}]){
  const h=harness(c=>c.url.pathname==='/api/account'?json(account()):json(response));await h.client.account();
  await assert.rejects(h.client.ordersByIds({order_ids:['A','B']}),rejected(502));assert.equal(h.calls.length,2);
 }
 const h=harness(c=>c.url.pathname==='/api/account'?json(account()):json({orders:[],total_count:0}));await h.client.account();
 const r=await h.client.ordersByIds({order_ids:['A','B']});assert.deepEqual(r.group_missing_order_ids,['A','B']);assert.equal(r.readback_complete,false);
});

test('exact-ID reads snapshot caller input and preserve transport no-retry/redirect/stream/error boundaries',async()=>{
 let unblock!:()=>void;const gate=new Promise<void>(resolve=>{unblock=resolve;});
 const h=harness(async c=>{if(c.url.pathname==='/api/account')return json(account());await gate;return json({orders:[order('ORIGINAL')],total_count:1});});
 await h.client.account();const ids=['ORIGINAL'];const pending=h.client.ordersByIds({order_ids:ids});ids[0]='CHANGED';unblock();
 const r=await pending;assert.deepEqual(r.requested_order_ids,['ORIGINAL']);assert.equal(h.calls[1].url.searchParams.get('order_ids'),'ORIGINAL');
 for(const response of [()=>json({},429,{'retry-after':'1800'}),()=>new Response('REMOTE_PAYLOAD', {status:200,headers:{'content-type':'text/plain'}}),
  ()=>{const r=json({orders:[order('A')],total_count:1});Object.defineProperty(r,'url',{value:'https://foreign.mirakl.net/api/orders'});return r;},
  ()=>new Response('{malformed', {status:200,headers:{'content-type':'application/json'}})]){
  const failed=harness(c=>c.url.pathname==='/api/account'?json(account()):response());await failed.client.account();
  await assert.rejects(failed.client.ordersByIds({order_ids:['A']}),e=>e instanceof Problem&&!e.message.includes(secret));
  assert.equal(failed.calls.length,2,'one exact read, no retry or next group');
 }
});
