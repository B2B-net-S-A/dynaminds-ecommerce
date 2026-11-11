/** Root-only one-shot QA155 ordinary-API fixture. No assistant writes or RMA approval.
 * Two new firms: OFF simple3 and ON bundle3 A1/B2, genuinely issued before two distinct RMAs.
 * First cheap-line RMA is inspected by Chrome; second expensive-line RMA stays requested.
 * Local prepaid declarations are synthetic ledger facts, not bank transfers.
 * Unknown writes stop with durable pending custody and are never retried here.
 * The only resume mode validates the preserved, fully confirmed first 18 OFF writes
 * and enters the post-RMA tail; it never repeats those writes or recovers an unknown result.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { validateReturnAssistantPhoto } from '../server/return-assistant-photo';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const path = resolve(root, 'data/return-assistant-queue-stage155.json');
const reportPath = resolve(root, 'docs/return-assistant-queue-native155-setup.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = '140_return_assistant_queues';
const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid = (v: unknown): string => {
  assert.equal(typeof v, 'string');
  assert.match(v as string, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return v as string;
};
let pool: Pool | undefined;
let currentStep = 'preflight';
let state: any;
async function absent(file: string) {
  try { await lstat(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('QA155 output already exists; manual inspection required');
}
async function writeExclusive(file: string, value: unknown, mode = 0o600) {
  const f = await open(file, 'wx', mode);
  try { await f.writeFile(encode(value)); await f.sync(); } finally { await f.close(); }
}
async function save() {
  const prior = await lstat(path);
  assert(prior.isFile() && !prior.isSymbolicLink());
  assert.equal(prior.mode & 0o777, 0o600);
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeExclusive(tmp, state);
    await rename(tmp, path);
    const d = await open(dirname(path), 'r');
    try { await d.sync(); } finally { await d.close(); }
  } finally { await unlink(tmp).catch(() => {}); }
}
async function received(r: Response) {
  const bytes = Buffer.from(await r.arrayBuffer());
  assert(bytes.length <= 8 * 1024 * 1024, 'Bounded fixture response');
  return JSON.parse(bytes.toString('utf8'));
}
async function health() {
  const r = await fetch(base + '/health', { redirect: 'error', signal: AbortSignal.timeout(10000), cache: 'no-store' });
  assert.equal(r.status, 200);
  const h = await received(r);
  assert.equal(h.status, 'ok'); assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema); assert.equal(h.mode, 'local');
  assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.return_assistant_available, true);
  assert.equal(h.return_assistant_queues_available, true);
  assert.equal(h.manual_order_lines_available, true);
  return h;
}
function headers(a: any, extra: Record<string, string> = {}) {
  return { ...(a.cookie ? { cookie: a.cookie, 'X-Workspace-ID': a.tenant_id } : {}), 'Content-Type': 'application/json', ...extra };
}
async function get(a: any, route: string) {
  assert(route.startsWith('/') && !route.includes('://'));
  const r = await fetch(base + route, { headers: headers(a), redirect: 'error', signal: AbortSignal.timeout(10000), cache: 'no-store' });
  assert.equal(r.status, 200, 'Authenticated own GET');
  return received(r);
}
function allowed(a: any, method: string, route: string) {
  if (method === 'POST' && ['/auth/signup', '/products', '/suppliers', '/purchase-orders', '/orders', '/packing/stations', '/workspaces/billing/preview'].includes(route)) return true;
  if (method === 'POST' && a.billing_preview?.id && route === '/workspaces/billing/previews/' + a.billing_preview.id + '/commit') return true;
  if (a.on && method === 'POST' && route === '/wms-lots/opening-previews') return true;
  if (a.on && method === 'POST' && a.opening?.id && route === '/wms-lots/opening-previews/' + a.opening.id + '/activate') return true;
  if (method === 'POST' && a.purchase?.id && ['/place', '/receive'].some(suffix => route === '/purchase-orders/' + a.purchase.id + suffix)) return true;
  if (a.order_id && method === 'POST' && ['/payments', '/scan', '/ship-demo', '/returns'].some(suffix => route === '/orders/' + a.order_id + suffix)) return true;
  if (a.tenant_id && a.sale_product_id && method === 'POST' && route === '/product-images') return true;
  if (a.sale_product_id && method === 'PATCH' && route === '/products/' + a.sale_product_id) return true;
  return Boolean(a.order_id && method === 'PATCH' && route === '/orders/' + a.order_id + '/status');
}
async function mutate(a: any, label: string, method: string, route: string, body: any, expected: number, assign: (data: any, response: Response) => void = () => {}, extra: Record<string, string> = {}) {
  currentStep = a.label + ':' + label;
  assert.equal(state.pending, null);
  assert(allowed(a, method, route), 'Bounded ordinary fixture route');
  await health();
  if (route !== '/auth/signup') {
    const me = await get(a, '/auth/me');
    assert.equal(me.user.id, a.user_id); assert.equal(me.user.tenant_id, a.tenant_id); assert.equal(me.user.role, 'admin');
  }
  state.pending = { actor: a.label, step: label, method, route, body, extra_headers: extra, expected_status: expected, response: null };
  state.phase = 'PENDING_WRITE';
  await save();
  let r: Response, data: any;
  try {
    r = await fetch(base + route, { method, headers: headers(a, extra), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
    data = await received(r);
  } catch {
    state.phase = 'UNKNOWN_RESULT_DO_NOT_RETRY'; await save();
    throw Error('Unconfirmed write; retained custody requires manual inspection');
  }
  state.pending.response = { status: r.status, data };
  await save();
  assert.equal(r.status, expected, 'Expected ordinary API result');
  // Assigned IDs/cookie remain durable while the complete response is pending.
  assign(data, r);
  await save();
  state.completed.push({ actor: a.label, step: label, method, route, status: r.status, response_sha256: hash(data) });
  state.pending = null; state.phase = 'CONFIRMED';
  await save();
  return data;
}
async function pages(a: any, route: string, maximum: number) {
  const all: any[] = []; const seen = new Set<string>(); let cursor: string | null = null;
  do {
    const response = await get(a, route + (cursor ? (route.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cursor) : ''));
    assert(Array.isArray(response.data)); all.push(...response.data);
    assert(all.length <= maximum, 'Complete bounded fixture scope');
    cursor = response.meta?.cursor ?? null;
    if (cursor) { assert(!seen.has(cursor)); seen.add(cursor); }
  } while (cursor);
  return all;
}
async function snapshot(a: any, captureCore = false) {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const native = (await c.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0];
    assert.deepEqual(native, { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id')) ORDER BY table_name")).rows.map(r => r.table_name as string);
    const result: Record<string, { count: number; sha256: string }> = {};
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const rows = (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE ${key}=$1 ORDER BY 1`, [name === 'users' ? a.user_id : a.tenant_id])).rows;
      result[name] = { count: rows.length, sha256: hash(rows) };
    }
    const core:Record<string,{count:number;sha256:string}>={};
    uuid(a.next_return_id);
    for(const [label,table,key] of [['next_return_case','return_cases','id'],['next_return_items','return_items','return_id']] as const){
      const rows=(await c.query(`SELECT to_jsonb(q) row FROM "${table}" q WHERE tenant_id=$1 AND "${key}"=$2 ORDER BY 1`,[a.tenant_id,a.next_return_id])).rows;
      assert.equal(rows.length,1,'Second RMA exact untouched core scope');core[label]={count:rows.length,sha256:hash(rows)};
    }
    if(captureCore&&!a.setup_checkpoint_core)a.setup_checkpoint_core=core;
    else assert.deepEqual(core,a.setup_checkpoint_core,'Second RMA born hashes must not be rebased');
    await c.query('COMMIT'); return result;
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

async function resumeConfirmedRmas() {
  currentStep='resume-known-off-preflight';
  const custodyPath=resolve(root,'data/return-assistant-queue-stage155-setup-attempt1.json');
  const expectedHash=process.env.QA155_RESUME_JOURNAL_SHA256??'',expectedBytes=process.env.QA155_RESUME_JOURNAL_BYTES??'';
  assert.match(expectedHash,/^[a-f0-9]{64}$/);assert.match(expectedBytes,/^[1-9][0-9]{0,7}$/);
  const readPrivate=async(file:string)=>{const info=await lstat(file);assert(info.isFile()&&!info.isSymbolicLink());assert.equal(info.mode&0o777,0o600);assert(info.size>0&&info.size<=8*1024*1024);return readFile(file);};
  const bytes=await readPrivate(path),custody=await readPrivate(custodyPath);
  assert.equal(bytes.length,Number(expectedBytes));assert.equal(createHash('sha256').update(bytes).digest('hex'),expectedHash);assert(bytes.equals(custody),'Original journal must match preserved attempt1 byte for byte');
  state=JSON.parse(bytes.toString('utf8'));
  assert.equal(state.stage,155);assert.equal(state.runtime_revision,revision);assert.equal(state.schema_revision,schema);
  assert.equal(state.pending,null);assert.equal(state.complete,false);assert.equal(state.phase,'CONFIRMED');assert.equal(state.resume,undefined);
  assert.equal(state.provider_verified,false);assert.equal(state.queue_approval_verified,false);assert.equal(state.settings_approval_verified,false);assert.equal(state.assistant_approval_verified,false);
  assert.match(state.suffix,/^[a-f0-9]{8}$/);assert.deepEqual(state.actors,[state.off,state.on]);state.actors=[state.off,state.on];
  const a=state.off,on=state.on;assert.equal(a.label,'OFF');assert.equal(a.on,false);assert.equal(a.complete,false);
  assert.deepEqual(Object.keys(on).sort(),['label','on','email','password','organization','cookie','tenant_id','user_id','components','complete'].sort());
  assert.equal(on.label,'ON');assert.equal(on.on,true);assert.equal(on.complete,false);assert.equal(on.tenant_id,'');assert.equal(on.user_id,'');assert.equal(on.cookie,'');assert.deepEqual(on.components,[]);
  assert.equal(a.email,'qa155-off-'+state.suffix+'@demo.local');assert.equal(on.email,'qa155-on-'+state.suffix+'@demo.local');
  assert.equal(a.organization,'QA155 Own Return Assistant OFF '+state.suffix);assert.equal(on.organization,'QA155 Own Return Assistant ON '+state.suffix);
  for(const key of ['tenant_id','user_id','warehouse_id','supplier_id','sale_product_id','order_id','return_id','rma_id','next_return_id','cheap_item_id','expensive_item_id'])uuid(a[key]);
  assert.equal(a.rma_id,a.return_id);assert.notEqual(a.return_id,a.next_return_id);assert.notEqual(a.cheap_item_id,a.expensive_item_id);assert(a.cookie.startsWith('dyna_session='));
  for(const key of ['station','station_id','station_version','catalog_image','current_catalog','assistant_draft','source_born','expected','setup_checkpoint','setup_checkpoint_core'])assert.equal(a[key],undefined,'Resume only before station/PIM/assistant/checkpoints');
  const steps:[string,string,string,number][]=[
    ['signup','POST','/auth/signup',201],['local-enterprise-preview','POST','/workspaces/billing/preview',200],['local-enterprise-commit','POST','/workspaces/billing/previews/'+uuid(a.billing_preview?.id)+'/commit',200],
    ['product-S','POST','/products',201],['supplier','POST','/suppliers',201],['purchase','POST','/purchase-orders',201],['place-purchase','POST','/purchase-orders/'+uuid(a.purchase?.id)+'/place',200],['genuine-pz','POST','/purchase-orders/'+a.purchase.id+'/receive',200],
    ['sale','POST','/orders',201],['synthetic-local-prepaid-declaration','POST','/orders/'+a.order_id+'/payments',200],['picking','PATCH','/orders/'+a.order_id+'/status',200],
    ...[0,1,2].map(n=>['scan-simple-'+n,'POST','/orders/'+a.order_id+'/scan',200] as [string,string,string,number]),
    ['packed','PATCH','/orders/'+a.order_id+'/status',200],['genuine-DEMO-shipment','POST','/orders/'+a.order_id+'/ship-demo',200],['first-cheap-issued-RMA','POST','/orders/'+a.order_id+'/returns',201],['second-expensive-issued-RMA','POST','/orders/'+a.order_id+'/returns',201],
  ];
  assert.equal(state.completed.length,18);
  state.completed.forEach((entry:any,index:number)=>{const [step,method,route,status]=steps[index];assert.equal(entry.actor,'OFF');assert.equal(entry.step,step);assert.equal(entry.method,method);assert.equal(entry.route,route);assert.equal(entry.status,status);assert.match(entry.response_sha256,/^[a-f0-9]{64}$/);});
  assert.equal(state.photo.path,resolve(root,'data/return-assistant-queue-stage155-photo.png'));assert.equal(state.photo.synthetic,true);assert.equal(state.photo.mime,'image/png');
  const photo=await readPrivate(state.photo.path);assert.equal(photo.length,state.photo.byte_count);assert.equal(createHash('sha256').update(photo).digest('hex'),state.photo.sha256);assert.deepEqual(validateReturnAssistantPhoto({mime:'image/png',content_base64:photo.toString('base64')}).sha256,state.photo.sha256);
  const me=await get(a,'/auth/me');assert.equal(me.user.id,a.user_id);assert.equal(me.user.tenant_id,a.tenant_id);assert.equal(me.user.role,'admin');assert.equal(me.user.email,a.email);
  const wh=await get(a,'/warehouses');assert.equal(wh.data.length,1);assert.equal(wh.data[0].id,a.warehouse_id);
  const billing=await get(a,'/workspaces/billing');assert.equal(billing.mode,'local_estimate');assert.equal(billing.current_plan,'enterprise');assert.equal(billing.admin,true);
  assert.equal(a.components.length,1);const component=a.components[0];assert.equal(component.id,a.sale_product_id);assert.equal(component.sku,'QA155-OFF-S-'+state.suffix);assert.equal(component.initial_quantity,5);assert.equal(component.recipe_quantity,1);assert.equal(component.unit_cost_minor,317);
  const catalog=await get(a,'/products?limit=50');assert.equal(catalog.data.length,1);assert.equal(catalog.meta?.cursor,null);assert.equal(catalog.data[0].id,a.sale_product_id);
  const p=await get(a,'/products/'+a.sale_product_id);assert.equal(p.kind,'simple');assert.equal(p.sku,component.sku);assert.equal(p.name,'QA155 OFF Component S');assert.equal(p.price,10000);assert.equal(p.vat,23);assert.equal(p.ean,'');assert.deepEqual(p.images,[]);assert.deepEqual(p.components,[]);
  assert.equal(p.stock.length,1);assert.equal(p.stock[0].warehouse_id,a.warehouse_id);assert.equal(p.stock[0].on_hand,2);assert.equal(p.stock[0].reserved,0);assert.equal((await get(a,'/wms-lots')).policy.enabled,false);
  const purchases=await get(a,'/purchase-orders?limit=50');assert.equal(purchases.data.length,1);assert.equal(purchases.meta?.cursor,null);assert.equal(purchases.data[0].id,a.purchase.id);
  const po=await get(a,'/purchase-orders/'+a.purchase.id);assert.equal(po.state,'received');assert.equal(po.supplier_id,a.supplier_id);assert.equal(po.warehouse_id,a.warehouse_id);assert.equal(po.lines.length,1);assert.equal(po.lines[0].product_id,a.sale_product_id);assert.equal(po.lines[0].quantity,5);assert.equal(po.lines[0].received_quantity,5);assert.equal(po.lines[0].unit_cost,317);assert.equal(po.receipts.length,1);assert.equal(po.receipts[0].id,a.receipt.receipt_id);assert.equal(po.receipts[0].lines.length,1);assert.equal(po.receipts[0].lines[0].quantity,5);assert.equal(po.receipts[0].lines[0].location,'QA155-01');
  const order=await get(a,'/orders/'+a.order_id);assert.equal(order.status,'shipped');assert.equal(order.warehouse_id,a.warehouse_id);assert.equal(order.source,'manual');assert.equal(order.currency,'PLN');assert.equal(order.payment_mode,'prepaid');assert.equal(order.total,4401);assert.equal(order.shipping_cost,0);assert.equal(order.payment.received,4401);assert.equal(order.payment.refunded,0);assert.equal(order.payment.amount_due,0);assert.equal(order.items.length,2);assert.equal(order.documents.length,0);assert.equal(order.shipments.length,1);assert(order.shipments[0].dispatched_at);assert.equal(order.shipments[0].mode,'demo');
  const cheap=order.items.find((r:any)=>r.id===a.cheap_item_id),expensive=order.items.find((r:any)=>r.id===a.expensive_item_id);assert(cheap&&expensive);for(const item of [cheap,expensive]){assert.equal(item.product_id,a.sale_product_id);assert.equal(item.scanned,item.quantity);assert.equal(item.sku,component.sku);assert.equal(item.name,p.name);}assert.equal(cheap.quantity,1);assert.equal(cheap.line_total,1000);assert.equal(expensive.quantity,2);assert.equal(expensive.line_total,3401);
  const payments=await get(a,'/orders/'+a.order_id+'/payments');assert.equal(payments.data.length,1);assert.equal(payments.next,null);assert.equal(payments.data[0].id,a.payment.data[0].id);assert.equal(payments.data[0].kind,'receipt');assert.equal(payments.data[0].amount,4401);assert.equal(payments.data[0].method,'other');assert.equal(payments.data[0].client_key,a.payment.data[0].client_key);
  const overview=await get(a,'/orders/'+a.order_id+'/returns?limit=50');assert.equal(overview.case_count,2);assert.equal(overview.meta?.has_more,false);assert.equal(overview.meta?.cursor,null);assert.equal(overview.cases.length,2);assert.deepEqual(overview.cases.map((r:any)=>r.id).sort(),[a.return_id,a.next_return_id].sort());
  for(const [id,item,q,number] of [[a.return_id,a.cheap_item_id,1,a.rma_number],[a.next_return_id,a.expensive_item_id,2,a.next_return_number]] as const){const rma=await get(a,'/returns/'+id);assert.equal(rma.number,number);assert.equal(rma.order_id,a.order_id);assert.equal(rma.state,'requested');assert.equal(rma.refund_amount,0);assert.equal(rma.receipt,null);assert.equal(rma.items.length,1);assert.equal(rma.items[0].item_id,item);assert.equal(rma.items[0].requested,q);assert.equal(rma.items[0].accepted,0);assert.equal(rma.items[0].restocked,0);}
  const own=await snapshot(a,true);assert.equal(Object.keys(own).length,403);
  for(const [name,row] of Object.entries(own))if(name.startsWith('return_assistant_')||['packing_stations','product_images'].includes(name))assert.equal(row.count,0,'No station/PIM/assistant before narrow resume');
  for(const [name,count] of [['orders',1],['return_cases',2],['return_items',2],['products',1],['warehouses',1],['shipments',1],['purchase_orders',1],['purchase_receipts',1]] as const)assert.equal(own[name]?.count,count,'No additional own business scope');
  const c=await pool!.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const n=(await c.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0];assert.deepEqual(n,{role:'postgres',db:'dynaminds',host:'127.0.0.1',port:55432});assert.equal((await c.query('SELECT count(*)::int n FROM users WHERE email=$1',[on.email])).rows[0].n,0);assert.equal((await c.query('SELECT count(*)::int n FROM tenants WHERE name=$1',[on.organization])).rows[0].n,0);await c.query('COMMIT');}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}
  await health();
  state.resume={mode:'CONFIRMED_OFF_RMAS_ONLY',journal_bytes:bytes.length,journal_sha256:expectedHash,custody_path:custodyPath,confirmed_writes_preserved:18,before_own_snapshot:own};
  await save();
}

async function setup(a: any, resumeAfterRmas = false) {
  let policy:any,order:any,cheap:any,expensive:any,rma:any;
  if(!resumeAfterRmas){
  await mutate(a, 'signup', 'POST', '/auth/signup', { name: 'QA155 Parcel ' + a.label + ' Operator', email: a.email, password: a.password, organization: { name: a.organization, currency: 'PLN', locale: 'pl-PL' } }, 201, (r, response) => {
    a.tenant_id = uuid(r.user.tenant_id); a.user_id = uuid(r.user.id);
    a.cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]; assert(a.cookie.startsWith('dyna_session='));
  });
  const wh = await get(a, '/warehouses'); assert.equal(wh.data.length, 1); a.warehouse_id = uuid(wh.data[0].id); await save();
  const billing = await get(a, '/workspaces/billing');
  assert.equal(billing.mode, 'local_estimate'); assert.equal(billing.admin, true);
  assert.equal(billing.account, null); assert.equal(billing.current_plan, 'starter');
  await mutate(a, 'local-enterprise-preview', 'POST', '/workspaces/billing/preview', { kind: 'activate', plan: 'enterprise' }, 200, r => {
    assert.equal(r.mode, 'local_estimate'); assert.equal(r.actor_id, a.user_id); assert.equal(r.tenant_id, a.tenant_id);
    assert.equal(r.can_commit, true); assert.deepEqual(r.blockers, []); uuid(r.id); a.billing_preview = r;
  });
  await mutate(a, 'local-enterprise-commit', 'POST', '/workspaces/billing/previews/' + a.billing_preview.id + '/commit', {}, 200, r => {
    assert.equal(r.mode, 'local_estimate'); assert.equal(r.plan, 'enterprise'); a.billing_result = r;
  });
  assert.equal((await get(a, '/workspaces/billing')).current_plan, 'enterprise');
  const specs = a.on ? [{ letter: 'A', recipe: 1, stock: 5, cost: 0 }, { letter: 'B', recipe: 2, stock: 10, cost: 1000 }] : [{ letter: 'S', recipe: 1, stock: 5, cost: 317 }];
  for (const x of specs) {
    const sku = 'QA155-' + a.label + '-' + x.letter + '-' + state.suffix;
    await mutate(a, 'product-' + x.letter, 'POST', '/products', { sku, name: 'QA155 ' + a.label + ' Component ' + x.letter, kind: 'simple', price: 10000, vat: 23, warehouse_id: a.warehouse_id, quantity: 0, location: 'QA155-01' }, 201, r => {
      a.components.push({ id: uuid(r.id), sku, recipe_quantity: x.recipe, initial_quantity: x.stock, unit_cost_minor: x.cost });
    });
  }
  if (a.on) {
    await mutate(a, 'bundle', 'POST', '/products', { sku: 'QA155-ON-BUNDLE-' + state.suffix, name: 'QA155 Frozen A1 B2 Bundle', kind: 'bundle', price: 10000, vat: 23, warehouse_id: a.warehouse_id, quantity: 0, location: 'QA155-01', components: a.components.map((r: any) => ({ product_id: r.id, quantity: r.recipe_quantity })) }, 201, r => { a.sale_product_id = uuid(r.id); });
    await mutate(a, 'empty-wms-opening', 'POST', '/wms-lots/opening-previews', { client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'QA155 empty opening before genuine purchase receipt', lines: [] }, 201, r => {
      assert.equal(r.preview.ready, true); uuid(r.preview.id); a.opening = r.preview;
    });
    await mutate(a, 'activate-wms', 'POST', '/wms-lots/opening-previews/' + a.opening.id + '/activate', { client_key: randomUUID(), scope_hash: a.opening.scope_hash, confirmed: true, ack_unknown_costs: false }, 201);
  } else { a.sale_product_id = a.components[0].id; await save(); }
  policy = (await get(a, '/wms-lots')).policy; assert.equal(policy.enabled, a.on); a.policy = policy; await save();
  await mutate(a, 'supplier', 'POST', '/suppliers', { name: 'QA155 Own Synthetic Purchase Supplier ' + a.label, code: 'QA155-' + a.label + '-' + state.suffix }, 201, r => { a.supplier_id = uuid(r.id); });
  const lines = a.components.map((r: any) => ({ product_id: r.id, quantity: r.initial_quantity, unit_cost: r.unit_cost_minor }));
  await mutate(a, 'purchase', 'POST', '/purchase-orders', { supplier_id: a.supplier_id, warehouse_id: a.warehouse_id, currency: 'PLN', reference: 'QA155 ' + a.label + ' genuine own stock', lines }, 201, r => { a.purchase = r; uuid(r.id); });
  await mutate(a, 'place-purchase', 'POST', '/purchase-orders/' + a.purchase.id + '/place', { version: a.purchase.version }, 200, r => { assert.equal(r.state, 'ordered'); a.purchase = r; });
  const versions: any[] = [];
  for (const product of a.components) {
    const p = await get(a, '/products/' + product.id);
    const stock = p.stock.find((r: any) => r.warehouse_id === a.warehouse_id);
    versions.push({ warehouse_id: a.warehouse_id, product_id: product.id, version: String(stock?.version ?? '0') });
  }
  const receive: any = { client_key: randomUUID(), version: a.purchase.version, reference: 'QA155 PZ ' + a.label, note: 'Own QA stock with known net purchase costs', lines: lines.map((r: any) => ({ product_id: r.product_id, quantity: r.quantity, location: 'QA155-01' })) };
  if (a.on) receive.wms_lots = { policy_version: String(policy.version), stock_versions: versions, lines: lines.map((r: any, i: number) => ({ product_id: r.product_id, quantity: r.quantity, location: 'QA155-01', lot_code: 'QA155-' + i + '-' + state.suffix })) };
  await mutate(a, 'genuine-pz', 'POST', '/purchase-orders/' + a.purchase.id + '/receive', receive, 200, r => { assert.equal(r.order.state, 'received'); uuid(r.receipt_id); a.receipt = r; a.purchase = r.order; });
  a.purchased_products = await Promise.all(a.components.map((r: any) => get(a, '/products/' + r.id)));
  for (const product of a.components) {
    const p = a.purchased_products.find((r: any) => r.id === product.id), stock = p.stock.find((r: any) => r.warehouse_id === a.warehouse_id);
    assert.equal(stock.on_hand, product.initial_quantity); assert.equal(stock.reserved, 0);
  }
  if (a.on) {
    a.purchased_positions = await pages(a, '/wms-lots/positions', 2); assert.equal(a.purchased_positions.length, 2);
    a.purchased_valuation = await get(a, '/wms-lots/valuation');
    assert.equal(a.purchased_valuation.valuation.known_minor, '10000'); assert.equal(a.purchased_valuation.valuation.unknown_quantity, '0');
  }
  await mutate(a, 'sale', 'POST', '/orders', { source: 'manual', customer_name: 'QA155 Own Return Customer ' + a.label, email: 'qa155-customer@example.test', address: { street: 'Testowa 154', city: 'Warszawa', postal_code: '00-154', country: 'PL', phone: '500000154' }, warehouse_id: a.warehouse_id, currency: 'PLN', payment_mode: 'prepaid', shipping_cost: 0, items: [{ product_id: a.sale_product_id, quantity: 3 }], manual_lines: [{product_id:a.sale_product_id,quantity:1,line_total:1000},{product_id:a.sale_product_id,quantity:2,line_total:3401}], note: 'QA155 frozen priced lines for return assistant; no provider calls' }, 201, r => { a.order_id = uuid(r.id); }, { 'Idempotency-Key': randomUUID() });
  order = await get(a, '/orders/' + a.order_id);
  assert.equal(order.items.length,2); assert.deepEqual(order.items.map((r:any)=>r.line_total).sort((x:number,y:number)=>x-y),[1000,3401]); assert.equal(order.total,4401); a.commercial_items=order.items; await save();
  const paymentKey = randomUUID();
  await mutate(a, 'synthetic-local-prepaid-declaration', 'POST', '/orders/' + a.order_id + '/payments', { client_key: paymentKey, version: Number(order.version), kind: 'receipt', amount: 4401, currency: 'PLN', method: 'other', reference: 'QA155 synthetic own local ledger declaration', note: 'No bank transfer, provider reconciliation or external money movement', confirmed: true }, 200, r => {
    assert.equal(r.data.length, 1); assert.equal(r.data[0].client_key, paymentKey); assert.equal(r.data[0].amount, 4401); a.payment = r;
  });
  await mutate(a, 'picking', 'PATCH', '/orders/' + a.order_id + '/status', { status: 'picking' }, 200);
  if (a.on) {
    const allocations = await pages(a, '/wms-lots/orders/' + a.order_id + '/allocations', 2); assert.equal(allocations.length, 2); a.allocations = allocations;
    for (const r of allocations) {
      const product = a.components.find((v: any) => v.id === r.product_id); assert(product);
      assert.equal(r.warehouse_id, a.warehouse_id); assert.equal(r.location, 'QA155-01'); assert.equal(r.quantity, 3 * product.recipe_quantity); uuid(r.layer_id);
      for (let n = 0; n < r.quantity; n++) await mutate(a, 'scan-' + product.sku + '-' + n, 'POST', '/orders/' + a.order_id + '/scan', { client_key: randomUUID(), code: product.sku, location: r.location, layer_id: r.layer_id }, 200);
    }
  } else {
    for (let n = 0; n < 3; n++) await mutate(a, 'scan-simple-' + n, 'POST', '/orders/' + a.order_id + '/scan', { client_key: randomUUID(), code: a.components[0].sku, location: 'QA155-01' }, 200);
  }
  await mutate(a, 'packed', 'PATCH', '/orders/' + a.order_id + '/status', { status: 'packed' }, 200);
  order = await get(a, '/orders/' + a.order_id);
  assert.equal(order.status, 'packed'); assert.equal(order.payment.received, 4401); assert.equal(order.payment.amount_due, 0);
  assert.equal(order.shipments.length, 0); assert.equal(order.documents.length, 0); assert.equal(order.returns.case_count, 0);
  assert(order.items.every((r:any)=>r.scanned===r.quantity));
  await mutate(a,'genuine-DEMO-shipment','POST','/orders/'+a.order_id+'/ship-demo',{},200);
  order=await get(a,'/orders/'+a.order_id); assert.equal(order.status,'shipped'); assert.equal(order.shipments.length,1); assert(order.shipments[0].dispatched_at);
  cheap=order.items.find((r:any)=>r.line_total===1000);expensive=order.items.find((r:any)=>r.line_total===3401);
  assert(cheap&&expensive); assert.equal(cheap.quantity,1); assert.equal(expensive.quantity,2);
  assert.notEqual(cheap.id,expensive.id); assert.equal(cheap.product_id,expensive.product_id);
  a.cheap_item_id=uuid(cheap.id); a.expensive_item_id=uuid(expensive.id);
  await mutate(a,'first-cheap-issued-RMA','POST','/orders/'+a.order_id+'/returns',{client_key:randomUUID(),reason:'QA155 first queue case for one cheap historical unit',shipping_refund:0,items:[{item_id:cheap.id,quantity:1}]},201,r=>{
    a.return_id=uuid(r.id);a.rma_id=a.return_id;a.rma_number=r.number;
    assert(typeof a.rma_number==='string'&&a.rma_number.length>0);
  });
  rma=await get(a,'/returns/'+a.return_id);
  assert.equal(rma.state,'requested'); assert.equal(rma.refund_amount,0); assert.equal(rma.receipt,null); assert.equal(rma.items.length,1);
  assert.equal(rma.items[0].item_id,cheap.id); assert.equal(rma.items[0].requested,1); assert.equal(rma.items[0].accepted,0); assert.equal(rma.items[0].restocked,0);
  await mutate(a,'second-expensive-issued-RMA','POST','/orders/'+a.order_id+'/returns',{client_key:randomUUID(),reason:'QA155 second queue case for two expensive historical units',shipping_refund:0,items:[{item_id:expensive.id,quantity:2}]},201,r=>{
    a.next_return_id=uuid(r.id);a.next_return_number=r.number;a.next_rma_number=r.number;
    assert(typeof a.next_return_number==='string'&&a.next_return_number.length>0);
  });
  }else{
    assert.equal(a.label,'OFF');assert.equal(a.on,false);
    order=await get(a,'/orders/'+a.order_id);policy=(await get(a,'/wms-lots')).policy;assert.equal(policy.enabled,false);
    cheap=order.items.find((r:any)=>r.id===a.cheap_item_id);expensive=order.items.find((r:any)=>r.id===a.expensive_item_id);
    assert(cheap&&expensive);assert.equal(cheap.line_total,1000);assert.equal(cheap.quantity,1);assert.equal(expensive.line_total,3401);assert.equal(expensive.quantity,2);
    rma=await get(a,'/returns/'+a.return_id);
  }
  assert.notEqual(a.return_id,a.next_return_id);
  a.return_ids=[a.return_id,a.next_return_id];
  const nextRma=await get(a,'/returns/'+a.next_return_id);
  assert.equal(nextRma.state,'requested'); assert.equal(nextRma.refund_amount,0); assert.equal(nextRma.receipt,null); assert.equal(nextRma.items.length,1);
  assert.equal(nextRma.items[0].item_id,expensive.id); assert.equal(nextRma.items[0].requested,2); assert.equal(nextRma.items[0].accepted,0); assert.equal(nextRma.items[0].restocked,0);
  const cases=await get(a,'/orders/'+a.order_id+'/returns?limit=50');
  assert.equal(cases.case_count,2);assert.equal(cases.meta?.has_more,false);assert.equal(cases.meta?.cursor,null);assert(Array.isArray(cases.cases));
  assert.equal(cases.cases.length,2); assert.deepEqual(cases.cases.map((r:any)=>r.id).sort(),[...a.return_ids].sort());
  await mutate(a,'return-station','POST','/packing/stations',{client_key:randomUUID(),code:'QA155-'+a.label+'-'+state.suffix,label:'QA155 Own Return Desk '+a.label,enabled:true},201,r=>{a.station=r.station;a.station_id=uuid(a.station.id);a.station_version=String(a.station.version);assert.match(a.station_version,/^[1-9][0-9]*$/);});
  // Own current catalog metadata changes only after the sale and both RMA snapshots.
  // The PNG was generated by this one-shot setup; no earlier private files are read.
  assert.equal(state.photo.path,resolve(root,'data/return-assistant-queue-stage155-photo.png'));
  const photoStat=await lstat(state.photo.path);assert(photoStat.isFile()&&!photoStat.isSymbolicLink());assert.equal(photoStat.mode&0o777,0o600);
  assert(photoStat.size>0&&photoStat.size<=524288);
  const photoBytes=await readFile(state.photo.path);
  assert.equal(photoBytes.length,state.photo.byte_count);assert.equal(createHash('sha256').update(photoBytes).digest('hex'),state.photo.sha256);
  await mutate(a,'own-product-image','POST','/product-images',{data:photoBytes.toString('base64')},201,r=>{
    uuid(r.id);assert.equal(r.url,'/api/product-images/'+r.id);assert.equal(r.mime,'image/png');assert.equal(r.size,photoBytes.length);a.catalog_image=r;
  });
  const live=await get(a,'/products/'+a.sale_product_id);assert.equal(live.id,a.sale_product_id);assert(Number.isSafeInteger(live.version)&&live.version>0);
  const catalogBody:any={version:live.version,name:'QA155 Current Catalog '+a.label,ean:a.on?'1550000000002':'1550000000001',price:live.price,vat:live.vat,category:live.category,description:live.description,attributes:live.attributes,images:[a.catalog_image.url],active:live.active,components:live.components.map((v:any)=>({product_id:v.product_id,quantity:v.quantity}))};
  for(const key of ['weight_grams','length_mm','width_mm','height_mm','manufacturer'])if(Object.hasOwn(live,key))catalogBody[key]=live[key];
  await mutate(a,'own-current-catalog-metadata','PATCH','/products/'+a.sale_product_id,catalogBody,200,r=>{
    assert.equal(r.id,a.sale_product_id);assert.equal(r.version,live.version+1);assert.equal(r.name,catalogBody.name);assert.equal(r.ean,catalogBody.ean);assert.deepEqual(r.images,catalogBody.images);
  });
  a.current_catalog=await get(a,'/products/'+a.sale_product_id);
  assert.notEqual(a.current_catalog.name,cheap.name);assert.equal(a.current_catalog.sku,live.sku);
  assert.deepEqual(a.current_catalog.components.map((v:any)=>({product_id:v.product_id,quantity:v.quantity})),catalogBody.components);
  const historicalNow=await get(a,'/orders/'+a.order_id);
  const sold=(o:any)=>o.items.map((v:any)=>({id:v.id,product_id:v.product_id,sku:v.sku,name:v.name,quantity:v.quantity,line_total:v.line_total,vat:v.vat,components:v.components})).sort((x:any,y:any)=>x.id.localeCompare(y.id));
  assert.deepEqual(sold(historicalNow),sold(order),'Catalog metadata must preserve historical sale lines and recipes');
  a.assistant_draft={parts:[{part_id:randomUUID(),item_id:cheap.id,status:'sale',quantity:1}],note:'QA155 first queue case: one inspected whole unit returned to sale',shipping_refund:0};
  const products=await Promise.all(a.components.map((r:any)=>get(a,'/products/'+r.id)));
  if(a.on){const fs=await pages(a,'/wms-lots/orders/'+a.order_id+'/return-fragments',2);assert.equal(fs.length,2);a.assistant_draft.wms_lots={client_key:randomUUID(),policy_version:String(policy.version),stock_versions:products.map((p:any)=>({product_id:p.id,warehouse_id:a.warehouse_id,version:String(p.stock.find((s:any)=>s.warehouse_id===a.warehouse_id).version)})),picks:fs.map((f:any)=>({issue_fragment_id:uuid(f.id),quantity:a.components.find((p:any)=>p.id===f.product_id).recipe_quantity,location:'QA155-01'}))};a.return_fragments=fs;}
  a.source_born={order:historicalNow,return_case:rma,next_return_case:nextRma,return_ids:[...a.return_ids],products,sale_product:a.current_catalog,current_catalog:a.current_catalog,catalog_image:a.catalog_image,policy:(await get(a,'/wms-lots')).policy,positions:a.on?await pages(a,'/wms-lots/positions',2):[],valuation:a.on?await get(a,'/wms-lots/valuation'):null};
  for(const component of a.components){const stock=products.find((p:any)=>p.id===component.id).stock.find((s:any)=>s.warehouse_id===a.warehouse_id);assert.equal(stock.on_hand,component.initial_quantity-3*component.recipe_quantity);assert.equal(stock.reserved,0);}
  a.expected={accepted:1,restocked:1,held:0,rejected:0,refund_minor:1000,original_cash:4401,next_requested:2,next_accepted:0,next_refund_minor:0,current_catalog:{name:a.current_catalog.name,ean:a.current_catalog.ean,image_url:a.catalog_image.url},physical_after:a.components.map((p:any)=>({product_id:p.id,on_hand:p.initial_quantity-2*p.recipe_quantity,reserved:0}))};
  a.setup_checkpoint=await snapshot(a,true);assert.equal(Object.keys(a.setup_checkpoint).length,403);for(const [name,value] of Object.entries(a.setup_checkpoint) as [string,{count:number}][])if(name.startsWith('return_assistant_'))assert.equal(value.count,0,'Setup has no assistant state or approval');

  a.complete = true; await save();
}

async function main() {
  assert.equal(resolve(process.cwd()), root);
  assert.equal(resolve(dirname(fileURLToPath(import.meta.url)), '..'), root);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json'));
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.QA155_SETUP_CONFIRM, 'CREATE_TWO_NEW_OWN_QUEUE_FIXTURES'); assert.match(revision, /^[a-f0-9]{40}$/);
  const resumeMode=process.env.QA155_RESUME_AFTER_CONFIRMED_RMAS;
  assert(resumeMode===undefined||resumeMode==='RESUME_KNOWN_OFF_CHECKPOINT','Only the explicitly confirmed OFF checkpoint can resume');
  const resuming=resumeMode==='RESUME_KNOWN_OFF_CHECKPOINT';
  const config = await lstat(resolve(root, '.local.json')); assert(config.isFile() && !config.isSymbolicLink()); assert.equal(config.mode & 0o777, 0o600);
  for (const dir of [resolve(root, 'data'), resolve(root, 'docs')]) { const d = await lstat(dir); assert(d.isDirectory() && !d.isSymbolicLink()); }
  if(!resuming)await absent(path); await absent(reportPath); await health();
  pool = (await import('../server/db')).pool;
  const u = new URL(pool.options.connectionString!); assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, '55432'); assert.equal(u.pathname, '/dynaminds');
  // Verify native database before the first signup; no database writes occur here.
  const c = await pool.connect();
  try { const n = (await c.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0]; assert.deepEqual(n, { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 }); } finally { c.release(); }
  if(resuming)await resumeConfirmedRmas();
  else{
  const suffix = randomUUID().slice(0, 8);
  const actor = (on: boolean) => ({ label: on ? 'ON' : 'OFF', on, email: 'qa155-' + (on ? 'on' : 'off') + '-' + suffix + '@demo.local', password: 'QA155-' + randomBytes(24).toString('hex'), organization: 'QA155 Own Return Assistant ' + (on ? 'ON' : 'OFF') + ' ' + suffix, cookie: '', tenant_id: '', user_id: '', components: [], complete: false });
  state = { stage: 155, runtime_revision: revision, schema_revision: schema, suffix, off: actor(false), on: actor(true), pending: null, completed: [], phase: 'PREPARED', complete: false, provider_verified: false, queue_approval_verified: false, settings_approval_verified: false, assistant_approval_verified: false };
  state.actors=[state.off,state.on];
  await writeExclusive(path, state);
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
  const chunk=(name:string,data:Buffer)=>{const n=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([n,data])));return Buffer.concat([size,n,data,crc]);};
  const image=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,55,105,155,255]))),chunk('IEND',Buffer.alloc(0))]);
  const photo=validateReturnAssistantPhoto({mime:'image/png',content_base64:image.toString('base64')});
  const photoPath=resolve(root,'data/return-assistant-queue-stage155-photo.png');await absent(photoPath);
  const imageFile=await open(photoPath,'wx',0o600);try{await imageFile.writeFile(photo.bytes);await imageFile.sync();}finally{await imageFile.close();}
  state.photo={path:photoPath,mime:photo.mime,byte_count:photo.byte_count,sha256:photo.sha256,width:photo.width,height:photo.height,synthetic:true};await save();
  }
  await setup(state.off,resuming);
  await setup(state.on);
  // Work on the second firm must preserve the first firm's completed own baseline.
  assert.deepEqual(await snapshot(state.off), state.off.setup_checkpoint);
  await health(); assert.equal(state.pending, null);
  assert.equal(state.completed.length,52,'Exact ordinary setup writes including two catalog metadata writes per firm; no assistant, settings or queue writes');
  state.complete = true; state.phase = 'READY_BEFORE_QUEUE_AND_ASSISTANT_INSPECTION'; await save();
  await writeExclusive(reportPath,{stage:155,status:'OWN_RETURN_ASSISTANT_QUEUE_SETUP_PASS',revision,schema_revision:schema,firms:['off','on'].map(key=>{const a=state[key];return {wms_enabled:a.on,tenant_id:a.tenant_id,order_id:a.order_id,return_id:a.return_id,next_return_id:a.next_return_id,return_ids:[...a.return_ids],rma_count:2,rma_requested_quantities:[1,2],station_id:a.station.id,commercial_lines:2,issued_commercial_quantity:3,source_credit:4401,current_catalog_name:a.current_catalog.name,current_catalog_ean:a.current_catalog.ean,own_image_uploaded:true,synthetic_image_sha256:state.photo.sha256,expected:a.expected,own_tables:Object.keys(a.setup_checkpoint).length,setup_checkpoint_sha256:hash(a.setup_checkpoint)};}),successful_writes:state.completed.length,expected_setup_writes:52,assistant_queues:0,assistant_settings:0,assistant_sessions:0,assistant_previews:0,assistant_receipts:0,synthetic_photo:true,provider_requests:0,bank_verified:false,full_goal_complete:false},0o644);
  console.log(JSON.stringify({status:'OWN_RETURN_ASSISTANT_QUEUE_SETUP_PASS',firms:2,rmas:4,successful_writes:state.completed.length,assistant_queues:0,assistant_receipts:0}));
}
main().catch(() => {
  console.error(JSON.stringify({ status: 'QA155_SETUP_FAILED', step: currentStep, code: 'PRIVATE_DETAILS_WITHHELD', pending_must_be_inspected: true }));
  process.exitCode = 1;
}).finally(() => pool?.end());
