import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';
import { Amazon } from '../server/amazon';
import { OdooSales } from '../server/odoo-orders';
import type { Transport } from '../server/integrations';
import { amazonFixture, amazonConfig, amazonSecrets } from './amazon-fixture';
import { odooOrderFixture, odooSettings, odooCredentials } from './odoo-order-fixture';
import { makeProviderHarness, freshSourceIntentFixture } from './source-order-intents-provider-fixture';

assert.equal(process.env.DYNA_TEST,'true');
const database = new URL(process.env.DATABASE_URL??'');
assert.match(database.pathname,/^\/dynaminds_test_\d+$/);
assert(['localhost','127.0.0.1','[::1]'].includes(database.hostname));
type Row=Record<string,any>;
type Provider='amazon'|'odoo';
type Fixture=Awaited<ReturnType<typeof freshSourceIntentFixture>>;
let h:Awaited<ReturnType<typeof makeProviderHarness>>;
let provider:Provider;
let amazon=amazonFixture(),odoo=odooOrderFixture();
const erpSettings={...odooSettings,server_url:'https://example.com'};
const transport:Transport=(url,init)=>{
  if(provider==='amazon')return amazon.transport(url,init);
  const u=new URL(url);assert.equal(u.origin,erpSettings.server_url);
  // Reuse the existing in-memory RPC fixture's fixed host assertion; no network request occurs.
  u.host=new URL(odooSettings.server_url).host;
  return odoo.transport(u.toString(),init);
};
before(async()=>{h=await makeProviderHarness({transport});});
after(async()=>{if(h)await h.close();else await pool.end();});
const money=(amount:string)=>({amount,currencyCode:'PLN'});
function amazonRaw() {
  const raw:Row=amazon.orders[0],first=structuredClone(raw.orderItems[0]);
  raw.proceeds.grandTotal=money('42.00');
  // This upstream payment declaration is intentionally not reconciled cash in our ledger.
  raw.payment.paymentExecutions[0].paymentAmount=money('42.00');
  raw.orderItems=[
    {...structuredClone(first),orderItemId:'12345678901',quantityOrdered:2,
      fulfillment:{quantityFulfilled:0,quantityUnfulfilled:2},
      proceeds:{proceedsTotal:money('25.00'),breakdowns:[{type:'ITEM',subtotal:money('20.00')},{type:'SHIPPING',subtotal:money('5.00')}] }},
    {...structuredClone(first),orderItemId:'12345678902',quantityOrdered:1,
      fulfillment:{quantityFulfilled:0,quantityUnfulfilled:1},
      proceeds:{proceedsTotal:money('17.00'),breakdowns:[{type:'ITEM',subtotal:money('17.00')}] }},
  ];
  return raw;
}
function odooRaw() {
  const raw:Row=odoo.orders[0],original=raw._dyna.lines.find((r:Row)=>!r.is_delivery),delivery=raw._dyna.lines.find((r:Row)=>r.is_delivery);
  assert(original&&delivery);
  const line=(base:Row,id:number,quantity:number,gross:number)=>{
    const net=Math.round(gross*100/123);
    return {...structuredClone(base),id,product_uom_qty:quantity,qty_delivered:0,
      price_total:gross/100,price_subtotal:net/100,price_tax:(gross-net)/100};
  };
  raw._dyna.lines=[line(original,20011,2,2000),line(original,20013,1,1700),line(delivery,20012,1,500)];
  raw.order_line=raw._dyna.lines.map((r:Row)=>r.id);
  raw.amount_total=42;
  raw.amount_untaxed=raw._dyna.lines.reduce((sum:number,r:Row)=>sum+Math.round(r.price_subtotal*100),0)/100;
  raw.amount_tax=(4200-Math.round(raw.amount_untaxed*100))/100;
  raw._dyna.transactions[0].state='done';raw._dyna.transactions[0].amount=10;
  return raw;
}
async function setup(selected:Provider):Promise<Fixture> {
  provider=selected;amazon=amazonFixture();odoo=odooOrderFixture();
  const raw=selected==='amazon'?amazonRaw():odooRaw();
  const f=await freshSourceIntentFixture(h,{
    provider:selected,raw,settings:selected==='amazon'?amazonConfig:erpSettings,
    credentials:selected==='amazon'?amazonSecrets:odooCredentials,
    mode:selected==='amazon'?'sandbox':'live',
    external_product_id:selected==='amazon'?'AMAZON-DEMO-SKU':'101',
    remote_line_ids:selected==='amazon'?['12345678901','12345678902']:['20011','20013'],
    prepareRaw:async()=>selected==='amazon'
      ?new Amazon('sandbox',amazonConfig,amazonSecrets,amazon.transport).order(String(raw.id))
      :new OdooSales(erpSettings,odooCredentials,transport).order(Number(raw.id)),
  });
  amazon.calls.length=0;odoo.calls.length=0;
  return f;
}
const calls=()=>provider==='amazon'?amazon.calls.length:odoo.calls.length;
function assertActualProviderReads(selected:Provider) {
  if(selected==='amazon') {
    assert(amazon.calls.some(c=>new URL(c.url).pathname==='/auth/o2/token'&&c.method==='POST'),'Actual LWA token request required');
    assert(amazon.calls.some(c=>new URL(c.url).pathname.endsWith('/orders/'+amazon.orders[0].id)&&c.method==='GET'),'Actual current Amazon Orders read required');
    assert(amazon.calls.every(c=>c.method==='GET'||(new URL(c.url).origin==='https://api.amazon.com'&&new URL(c.url).pathname==='/auth/o2/token'&&c.method==='POST')),'No provider commercial mutation');
  } else {
    for(const model of ['sale.order','sale.order.line','res.partner','res.country','res.currency','payment.transaction','stock.picking','product.product'])
      assert(odoo.calls.some(c=>c.model===model&&c.method==='read'),'Genuine hydrated Odoo read '+model);
    assert(odoo.calls.every(c=>['read','search_read','fields_get'].includes(c.method)),'No ERP commercial write');
  }
}
async function assertChain(f:Fixture,p:Row,result:Row,selected:Provider) {
  const order=result.order,intent=result.intent;
  assert.equal(order.source,selected);assert.equal(order.total,4200);assert.equal(order.shipping_cost,500);assert.equal(order.currency,'PLN');
  assert.equal(order.status,'new');assert.equal(order.items.length,2);assert.equal(order.picking_items.length,0);
  const expectedPaid=selected==='amazon'?0:1000;
  assert.equal(order.payment.received,expectedPaid);assert.equal(order.payment.amount_due,4200-expectedPaid);
  const bindings=(await pool.query('SELECT * FROM order_source_lines WHERE tenant_id=$1 AND source_order_id=$2 ORDER BY remote_line_id',[f.buyer.tenant,order.id])).rows;
  assert.equal(bindings.length,2);
  assert.deepEqual(bindings.map(b=>b.remote_line_id),selected==='amazon'?['12345678901','12345678902']:['20011','20013']);
  for(const [index,quantity,price,lineTotal] of [[0,2,1000,2000],[1,1,1700,1700]]) {
    const b=bindings[index],item=order.items.find((i:Row)=>i.id===b.source_item_id),approved=p.rows.find((r:Row)=>r.remote_line_id===b.remote_line_id);
    assert(item&&approved);assert.equal(item.id,approved.customer_item_id);
    assert.equal(item.product_id,f.product.id);assert.equal(item.quantity,quantity);assert.equal(item.price,price);assert.equal(item.line_total,lineTotal);assert.equal(item.vat,23);
    assert.equal(b.channel_id,f.channel.id);assert.equal(b.inbound_id,f.inbound.id);assert.equal(b.source_hash,f.inbound.source_hash);
    assert.equal(b.product_id,item.product_id);assert.equal(b.quantity,quantity);assert.equal(b.line_total,lineTotal);
    const line=intent.items.find((r:Row)=>r.customer_item_id===item.id);assert(line);
    assert.equal(line.local_quantity,0);assert.equal(line.external_quantity,quantity);assert.equal(line.unassigned_quantity,0);assert.equal(line.link_id,f.link.id);
  }
  assert.equal(new Set(order.items.map((r:Row)=>r.id)).size,2);
  const entries=(await pool.query('SELECT kind,amount,currency,method FROM payment_entries WHERE tenant_id=$1 AND order_id=$2 ORDER BY id',[f.buyer.tenant,order.id])).rows;
  assert.deepEqual(entries,selected==='amazon'?[]:[{kind:'receipt',amount:1000,currency:'PLN',method:'source_import'}]);
  const [e]=(await pool.query('SELECT * FROM b2b_external_import_executions WHERE tenant_id=$1 AND inbound_id=$2',[f.buyer.tenant,f.inbound.id])).rows;
  assert(e);assert.equal(e.preview_id,p.id);assert.equal(e.order_id,order.id);assert.equal(e.intent_id,intent.id);assert.equal(e.actor_id,f.buyer.user);
  const [cert]=(await pool.query('SELECT * FROM b2b_external_import_certificates WHERE tenant_id=$1 AND id=$2',[f.buyer.tenant,e.certificate_id])).rows;
  assert(cert);assert.equal(cert.state,'complete');assert.equal(cert.actual_order_id,order.id);assert.equal(cert.intent_id,intent.id);assert.equal(cert.preview_id,p.id);
  assert.equal(cert.actor_id,e.actor_id);assert.equal(cert.client_key,e.client_key);assert.equal(cert.request_hash,e.request_hash);
  const [head]=(await pool.query('SELECT * FROM b2b_external_order_intents WHERE tenant_id=$1 AND id=$2',[f.buyer.tenant,intent.id])).rows;
  assert(head);assert.equal(head.order_id,order.id);assert.equal(head.original_items.length,2);assert.equal(head.version,1);assert.equal(head.state,'open');
  assert.deepEqual(head.original_items.map((i:Row)=>i.id).sort(),order.items.map((i:Row)=>i.id).sort());
  const [inbound]=(await pool.query('SELECT state,order_id,source_hash,imported_hash FROM inbound_orders WHERE tenant_id=$1 AND id=$2',[f.buyer.tenant,f.inbound.id])).rows;
  assert.equal(inbound.state,'imported');assert.equal(inbound.order_id,order.id);assert.equal(inbound.source_hash,inbound.imported_hash);
  assert.equal(inbound.imported_hash,f.inbound.source_hash);
}
for(const selected of ['amazon','odoo'] as const) {
  test(`${selected} actual source-intent path preserves historic 10/17 same-SKU identities, authentic payment, complete certificate and zero physical effects with exact retry`,async()=>{
    const f=await setup(selected),physical=await f.snapshot({physicalOnly:true}),p=await f.preview(),body=f.executeBody(p);
    assert.equal(Object.keys(physical).length,19);
    assert.equal(p.source.total,4200);assert.equal(p.source.shipping_cost,500);assert.equal(p.source.payment.paid_amount,selected==='amazon'?0:1000);
    assert.equal(p.rows.length,2);assert.equal(new Set(p.rows.map((r:Row)=>r.customer_item_id)).size,2);
    const response=await f.execute(p,body);assert.equal(response.statusCode,201,response.body);const result=response.json();
    await assertChain(f,p,result,selected);assertActualProviderReads(selected);
    assert.deepEqual(await f.snapshot({physicalOnly:true}),physical,'All19 buyer physical tables unchanged');
    const beforeRetry=await f.snapshot(),callCount=calls(),replay=await f.execute(p,body);
    assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().reused,true);assert.equal(replay.json().order.id,result.order.id);assert.equal(replay.json().intent.id,result.intent.id);
    assert.deepEqual(await f.snapshot(),beforeRetry,'Completed exact retry has no business effects');assert.equal(calls(),callCount,'Exact receipt retry performs no new provider observation');
  });
  test(`${selected} genuine fresh source price drift rejects frozen approval without order, payment, certificate or physical writes and retains the observed new source`,async()=>{
    const f=await setup(selected),p=await f.preview(),body=f.executeBody(p),before=await f.snapshot(),physical=await f.snapshot({physicalOnly:true});
    assert.equal(Object.keys(physical).length,19);
    if(selected==='amazon') {
      const raw=amazon.orders[0];raw.proceeds.grandTotal=money('43.00');raw.payment.paymentExecutions[0].paymentAmount=money('43.00');
      raw.orderItems[0].proceeds.proceedsTotal=money('26.00');raw.orderItems[0].proceeds.breakdowns[0].subtotal=money('21.00');
    } else {
      const raw:Row=odoo.orders[0],line=raw._dyna.lines.find((r:Row)=>r.id===20011),net=Math.round(2100*100/123);
      line.price_total=21;line.price_subtotal=net/100;line.price_tax=(2100-net)/100;
      raw.amount_total=43;raw.amount_untaxed=raw._dyna.lines.reduce((sum:number,r:Row)=>sum+Math.round(r.price_subtotal*100),0)/100;
      raw.amount_tax=(4300-Math.round(raw.amount_untaxed*100))/100;
    }
    const response=await f.execute(p,body);assert.equal(response.statusCode,409,response.body);assertActualProviderReads(selected);
    const after=await f.snapshot();
    for(const table of ['orders','order_items','payment_entries','order_source_lines','b2b_external_order_intents','b2b_external_order_intent_revisions','b2b_external_order_allocation_proofs','b2b_external_order_created_orders','b2b_external_import_previews','b2b_external_import_executions','b2b_external_import_certificates']) {
      assert(Object.hasOwn(before,table),'Required before snapshot table '+table);
      assert(Object.hasOwn(after,table),'Required after snapshot table '+table);
      assert.deepEqual(after[table],before[table],'No customer/evidence write on provider drift '+table);
    }
    assert.deepEqual(await f.snapshot({physicalOnly:true}),physical);
    const [inbound]=(await pool.query('SELECT state,order_id,source_hash,imported_hash,normalized FROM inbound_orders WHERE tenant_id=$1 AND id=$2',[f.buyer.tenant,f.inbound.id])).rows;
    assert.equal(inbound.state,'staged');assert.equal(inbound.order_id,null);assert.equal(inbound.imported_hash,null);
    assert.notEqual(inbound.source_hash,f.inbound.source_hash);assert.equal(inbound.normalized.total,4300);
    const oldApproval=await f.request('/imports/'+f.inbound.id+'/external-intent-previews','POST',{...f.previewBody,client_key:randomUUID()});
    assert.equal(oldApproval.statusCode,409,oldApproval.body);
  });
}
