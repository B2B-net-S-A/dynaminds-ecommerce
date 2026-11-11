import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { stocktakeAdjustmentRegister } from '../server/stocktake-adjustments';
import { seed } from './fixtures';
import { productCatalogFacts } from './product-catalogs-fixture';
import { adjustmentActor, countedAdjustmentSource, stocktakeAdjustmentFixture, type AdjustmentFixture, type AdjustmentTestRow as Row } from './stocktake-adjustments-fixture';

// Root alone executes this against an exclusively allocated disposable DB.
assert.equal(process.env.DYNA_TEST,'true');
const database=new URL(process.env.DATABASE_URL??'');
assert(['localhost','127.0.0.1','[::1]'].includes(database.hostname));
assert.match(database.pathname,/^\/dynaminds_test_\d+$/);
let app:Awaited<ReturnType<typeof buildApp>>,providers=0;
const base='/stocktake-adjustments';
before(async()=>{await migrate();await seed();app=await buildApp({integrationTransport:async()=>{providers++;throw Error('No provider in register165');}});});
after(async()=>{try{assert.equal(providers,0);await app?.close();}finally{await pool.end();}});
async function series(f:AdjustmentFixture) {
  const result:Record<string,Row>={};
  for(const kind of ['PW','RW'])result[kind]=(await f.ok(base+'/series','POST',{client_key:randomUUID(),kind,name:'Register '+kind,prefix:kind+randomUUID().replaceAll('-','').slice(0,12).toUpperCase()},201)).series;
  return result;
}
async function post(f:AdjustmentFixture,s:Record<string,Row>,reverse=false) {
  let h:Awaited<ReturnType<typeof countedAdjustmentSource>>;
  if(reverse){
    assert.equal(f.on,false);
    const born=await f.ok('/stocktakes','POST',{client_key:randomUUID(),warehouse_id:f.warehouse.id,name:'Reverse actual register count',blind:false});
    const lines:Row[]=(await f.ok('/stocktakes/'+born.id)).lines;assert.equal(lines.length,6);
    const measured=lines.map(l=>({id:l.id,version:String(l.version),expected_stock_version:String(l.current_stock_version),quantity:Number(l.current_quantity)+(l.location==='A-01'?1:-1)}));
    for(const line of measured)assert(line.quantity>=0);
    await f.ok('/stocktakes/'+born.id+'/counts','POST',{client_key:randomUUID(),note:'Reverse count retains nonnegative measured bins',lines:measured});
    const current=await f.ok('/stocktakes/'+born.id);
    const reviewed=await f.ok('/stocktakes/'+born.id+'/review','POST',{version:String(current.version)});
    h={id:born.id,source_kind:'quantity',version:String(reviewed.version),review_hash:reviewed.review_hash,review_id:null,scope_hash:null,lines,measured,mode:'mixed'};
  }else h=await countedAdjustmentSource(f);
  const preview=(await f.ok(base+'/previews','POST',{client_key:randomUUID(),source_kind:h.source_kind,stocktake_id:h.id,version:h.version,
    ...(f.on?{review_id:h.review_id,scope_hash:h.scope_hash}:{review_hash:h.review_hash}),pw_series_id:s.PW.id,rw_series_id:s.RW.id},201)).preview;
  return f.ok(base+'/previews/'+preview.id+'/post','POST',{client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true},201);
}
const noCosts=(value:unknown)=>{const text=JSON.stringify(value);for(const key of ['unit_cost_minor','value_minor','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','rows_sha256','currency','exponent'])assert(!text.includes(key),'Redacted field '+key);};
const qs=(values:Record<string,string>)=>new URLSearchParams(values).toString();
async function globalFacts(){const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");const result:Record<string,unknown[]>={};
  for(const {tablename} of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows){assert.match(tablename,/^[a-z_][a-z0-9_]*$/);result[tablename]=(await c.query(`SELECT to_jsonb(r) row FROM public."${tablename}" r ORDER BY 1`)).rows;}
  await c.query('COMMIT');return result;}finally{await c.query('ROLLBACK').catch(()=>undefined);c.release();}}

test('52 genuinely posted tied headers paginate once each; literal own filters and reads preserve all tenant rows',async()=>{
  const f=await stocktakeAdjustmentFixture(app),s=await series(f),marker='test_register165_'+randomUUID().replaceAll('-','');
  // A disposable clock trigger sets timestamps at INSERT, never rewrites an
  // immutable receipt/header. Core posting and all149 guards remain real.
  await pool.query(`CREATE FUNCTION public.${marker}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.tenant_id='${f.tenant}'::uuid THEN NEW.created_at:='2026-01-02T03:04:05.123456Z'::timestamptz;END IF;RETURN NEW;END $$`);
  await pool.query(`CREATE TRIGGER ${marker} BEFORE INSERT ON public.stocktake_adjustment_documents FOR EACH ROW EXECUTE FUNCTION public.${marker}()`);
  try{for(let i=0;i<26;i++)await post(f,s,i%2===1);}finally{await pool.query(`DROP TRIGGER ${marker} ON public.stocktake_adjustment_documents`);await pool.query(`DROP FUNCTION public.${marker}()`);}
  const before=await globalFacts(),actual=(await pool.query('SELECT id FROM public.stocktake_adjustment_documents WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC',[f.tenant])).rows.map(r=>r.id);
  assert.equal(actual.length,52);
  assert.equal((await pool.query('SELECT count(DISTINCT created_at)::int n FROM public.stocktake_adjustment_documents WHERE tenant_id=$1',[f.tenant])).rows[0].n,1);
  const first=await f.ok(base+'/register?limit=50');assert.equal(first.data.length,50);assert(first.meta.cursor);assert(!first.meta.cursor.includes(actual[49]));
  const second=await f.ok(base+'/register?'+qs({limit:'50',cursor:first.meta.cursor}));assert.equal(second.data.length,2);assert.equal(second.meta.cursor,null);
  assert.deepEqual([...first.data,...second.data].map((d:Row)=>d.id),actual);
  const one=await f.ok(base+'/register?'+qs({kind:'PW',source_kind:'quantity',warehouse_id:f.warehouse.id,number_prefix:s.PW.prefix,from:'2026-01-02T03:04:05.123456Z',to:'2026-01-02T03:04:05.123456Z'}));
  assert.equal(one.data.length,26);for(const d of one.data){assert.equal(d.kind,'PW');assert.equal(d.warehouse.id,f.warehouse.id);assert(d.number.startsWith(s.PW.prefix));}
  assert.equal((await f.ok(base+'/register?number_prefix=%25')).data.length,0,'Percent is literal, not SQL wildcard');
  assert.equal((await f.ok(base+'/register?number_prefix=_')).data.length,0,'Underscore is literal');
  assert.equal((await f.request(base+'/register?from=2026-01-02T03%3A04%3A05.123457Z&to=2026-01-02T03%3A04%3A05.123456Z')).statusCode,422,'Microsecond inverted range');
  assert.deepEqual(await globalFacts(),before,'Every old global table/row including all sessions remains literal after register reads');
});

test('cursor actor/key/role/filters/limit/restore context and tamper are enforced without hidden foreign reads',async()=>{
  const f=await stocktakeAdjustmentFixture(app),done=await post(f,await series(f));
  const first=await f.ok(base+'/register?limit=1');assert(first.meta.cursor);
  const cursor=first.meta.cursor as string,foreign=await stocktakeAdjustmentFixture(app);
  const own=await productCatalogFacts(f.tenant),other=await productCatalogFacts(foreign.tenant);
  assert.equal((await foreign.request(base+'/register?'+qs({limit:'1',cursor}))).statusCode,409);
  assert.equal((await f.request(base+'/register?'+qs({limit:'2',cursor}))).statusCode,409);
  assert.equal((await f.request(base+'/register?'+qs({limit:'1',cursor,kind:'PW'}))).statusCode,409);
  assert.equal((await f.request(base+'/register?cursor=not-a-document-cursor')).statusCode,422);
  const broken=(cursor[0]==='A'?'B':'A')+cursor.slice(1);assert.equal((await f.request(base+'/register?'+qs({limit:'1',cursor:broken}))).statusCode,422);
  assert.equal((await f.request(base+'/register?warehouse_id='+foreign.warehouse.id)).statusCode,404);
  assert.equal((await foreign.request(base+'/documents/'+done.documents[0].id+'/export?format=xml')).statusCode,404);
  await assert.rejects(stocktakeAdjustmentRegister(f.actor,{limit:'1',cursor},{readOnly:true}),(e:{status?:number})=>e.status===409);
  assert.deepEqual(await productCatalogFacts(f.tenant),own);assert.deepEqual(await productCatalogFacts(foreign.tenant),other);
  const op=await adjustmentActor(app,f.tenant,'operator@demo.local');
  await pool.query("UPDATE memberships SET role='operator' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,op.user]);
  assert.equal((await op.request(base+'/register?'+qs({limit:'1',cursor}))).statusCode,409);
  const key=await f.ok('/developer/keys','POST',{name:'Own register reader',scopes:['inventory:read']},201);
  const keyed=await f.ok(base+'/register?limit=1','GET',undefined,200,key);noCosts(keyed);
  assert.equal((await f.request(base+'/register?'+qs({limit:'1',cursor}),'GET',undefined,key)).statusCode,409);
  assert.equal((await f.request(base+'/register?'+qs({limit:'1',cursor:keyed.meta.cursor}))).statusCode,409);
});

test('ON exports contain the entire immutable header and rows, preserve zero vs NULL and omit values for quantity-only reads',async()=>{
  const f=await stocktakeAdjustmentFixture(app,true),done=await post(f,await series(f)),rw=done.documents.find((d:Row)=>d.kind==='RW');
  const key=await f.ok('/developer/keys','POST',{name:'No valuation',scopes:['inventory:read']},201),before=await globalFacts();
  const csv=await f.ok(base+'/documents/'+rw.id+'/export?format=csv&include_values=true');
  assert.equal(csv.row_count,3);assert.equal(csv.values_included,true);assert.equal(csv.content_type,'text/csv; charset=utf-8');
  assert.equal(csv.document.id,rw.id);assert.equal(csv.content.split('\r\n').length,6,'columns+header+3 rows+EOF');
  assert(csv.content.includes('"0"'));assert(csv.content.includes('"1000"'));assert(csv.content.includes('"unknown"'));
  const xml=await f.ok(base+'/documents/'+rw.id+'/export?format=xml&include_values=true');
  assert.equal((xml.content.match(/<row>/g)??[]).length,3);assert(xml.content.includes('<unit_cost_minor>0</unit_cost_minor>'));
  assert(xml.content.includes('<unit_cost_minor nil="true"/>'));assert(xml.content.includes('<currency>PLN</currency>'));assert(xml.content.includes('<exponent>2</exponent>'));
  for(const format of ['csv','xml']){
    const restricted=await f.ok(base+'/documents/'+rw.id+'/export?format='+format+'&include_values=false','GET',undefined,200,key);
    assert.equal(restricted.values_included,false);assert.equal(restricted.can_read_value,false);assert.equal(restricted.row_count,3);noCosts(restricted);
    const adminNoValue=await f.ok(base+'/documents/'+rw.id+'/export?format='+format+'&include_values=false');noCosts(adminNoValue);assert.equal(adminNoValue.can_read_value,true);
  }
  assert.equal((await f.request(base+'/documents/'+rw.id+'/export?format=xml&include_values=true','GET',undefined,key)).statusCode,403);
  assert.equal((await f.request(base+'/documents/'+rw.id+'/export?format=xml&include_values=0')).statusCode,422);
  assert.deepEqual(await globalFacts(),before,'All global rows incl sessions, exports/denials leave evidence, stock and counters unchanged');
});

test('OFF exports never invent values, and CSV/XML escape actual frozen user strings',async()=>{
  const f=await stocktakeAdjustmentFixture(app);
  // Product names are changed through the real PIM endpoint before counting.
  const p=f.products[0];
  const current=await f.ok('/products/'+p.id);
  await f.ok('/products/'+p.id,'PATCH',{...current,version:Number(current.version),name:'=SUM(1,2) <& "quote"'});
  const done=await post(f,await series(f)),d=done.documents[0],before=await globalFacts();
  const csv=await f.ok(base+'/documents/'+d.id+'/export?format=csv&include_values=true');
  assert.equal(csv.values_included,false);noCosts(csv);assert(csv.content.includes("'=SUM(1,2)"));assert(csv.content.includes('""quote""'));
  const xml=await f.ok(base+'/documents/'+d.id+'/export?format=xml');assert(xml.content.includes('&lt;&amp; &quot;quote&quot;'));noCosts(xml);
  assert.equal((xml.content.match(/<row>/g)??[]).length,d.row_count);assert.deepEqual(await globalFacts(),before);
});

test('one document with 103 real repeated-SKU fragments exports all rows beyond the ordinary page size',async()=>{
  const tenant=randomUUID();await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own full register165','enterprise')",[tenant]);
  const actor=await adjustmentActor(app,tenant),warehouse=await actor.ok('/warehouses','POST',{name:'Long manifest',code:'R'+randomUUID().slice(0,8)});
  const product=await actor.ok('/products','POST',{name:'Repeated SKU',sku:'R'+randomUUID(),price:1000,vat:23,warehouse_id:warehouse.id,quantity:206,location:'A-01'},201);
  const locations=['A-01',...Array.from({length:102},(_,i)=>'R-'+String(i+1).padStart(3,'0'))];
  // Opening allows one row per real positive warehouse/product/bin cell.
  // Establish103 cells through ordinary OFF moves, never hand-seed positions.
  for(const location of locations.slice(1)){
    const current=(await pool.query('SELECT version FROM stock WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3)',[tenant,warehouse.id,product.id])).rows[0];
    await actor.ok('/stock-location-moves','POST',{client_key:randomUUID(),warehouse_id:warehouse.id,product_id:product.id,location:'A-01',destination:location,quantity:2,expected_version:String(current.version),note:'Genuine103-bin opening prerequisite'});
  }
  const bins=(await pool.query('SELECT location,quantity FROM stock_locations WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3) AND quantity>0 ORDER BY location',[tenant,warehouse.id,product.id])).rows;
  assert.equal(bins.length,103);for(const bin of bins)assert.equal(bin.quantity,2);
  const stock=(await pool.query('SELECT version FROM stock WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3)',[tenant,warehouse.id,product.id])).rows[0];
  const opening=(await actor.ok('/wms-lots/opening-previews','POST',{client_key:randomUUID(),policy_version:'0',currency:'PLN',note:'103 original layers',
    lines:locations.map((location,i)=>({warehouse_id:warehouse.id,product_id:product.id,location,quantity:2,stock_version:String(stock.version),lot_code:'R'+i,unit_cost_minor:i%3===0?null:i%3===1?'0':'1000'}))},201)).preview;
  assert.equal(opening.ready,true);await actor.ok('/wms-lots/opening-previews/'+opening.id+'/activate','POST',{client_key:randomUUID(),scope_hash:opening.scope_hash,confirmed:true,ack_unknown_costs:true},201);
  const f={...actor,warehouse,products:[product],on:true},s=await series(f);
  const h=(await f.ok('/wms-lots/stocktakes','POST',{client_key:randomUUID(),warehouse_id:warehouse.id,name:'103 measured layers',blind:false,policy_version:'1'},201)).stocktake;
  async function currentLines(){const result:Row[]=[];let cursor:string|null=null;
    do{const page=await f.ok('/wms-lots/stocktakes/'+h.id+'/lines'+(cursor?'?cursor='+encodeURIComponent(cursor):''));result.push(...page.data);cursor=page.meta.cursor;assert(result.length<=103);}while(cursor);
    assert.equal(result.length,103);assert.equal(new Set(result.map(l=>l.id)).size,103);return result;}
  const lines=await currentLines();
  assert.equal(lines.length,103);
  const countKeys=new Set<string>();
  for(let offset=0;offset<lines.length;offset+=100){
    const current=offset===0?lines:await currentLines(),ids=new Set(lines.slice(offset,offset+100).map(l=>l.id));
    const batch=current.filter(l=>ids.has(l.id));assert.equal(batch.length,offset===0?100:3);
    for(const l of batch)assert.equal(l.counted,null,'Each genuine line is measured once');
    const client_key=randomUUID();assert(!countKeys.has(client_key));countKeys.add(client_key);
    const response=await f.ok('/wms-lots/stocktakes/'+h.id+'/counts','POST',{client_key,note:'Complete genuine surplus batch '+offset,
      lines:batch.map(l=>({id:l.id,version:String(l.version),basis_token:l.basis_token,quantity:Number(l.current_quantity)+1}))},201);
    assert.equal(response.reused,false);assert.equal(response.measurement.updated,batch.length);
  }
  assert.equal(countKeys.size,2);
  for(const l of await currentLines()){assert.equal(l.counted,3);assert.equal(String(l.version),(BigInt(lines.find(original=>original.id===l.id)!.version)+1n).toString());}
  const head=(await f.ok('/wms-lots/stocktakes/'+h.id)).stocktake;
  const review=(await f.ok('/wms-lots/stocktakes/'+h.id+'/reviews','POST',{client_key:randomUUID(),version:String(head.version),note:'All103 prices separately reviewed',surplus:lines.map(l=>({line_id:l.id,unit_cost_minor:'0',currency:'PLN'}))},201)).review;
  const preview=(await f.ok(base+'/previews','POST',{client_key:randomUUID(),source_kind:'wms',stocktake_id:h.id,version:String(review.stocktake_version),review_id:review.id,scope_hash:review.scope_hash,pw_series_id:s.PW.id},201)).preview;
  const done=await f.ok(base+'/previews/'+preview.id+'/post','POST',{client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true},201);
  assert.equal(done.documents.length,1);const d=done.documents[0];assert.equal(d.row_count,103);
  const before=await globalFacts(),exported=await f.ok(base+'/documents/'+d.id+'/export?format=xml&include_values=true');
  assert.equal(exported.row_count,103);assert.equal((exported.content.match(/<row>/g)??[]).length,103);
  assert.equal((exported.content.match(new RegExp('<product_id>'+product.id+'</product_id>','g'))??[]).length,103);
  assert.equal((exported.content.match(/<unit_cost_minor>0<\/unit_cost_minor>/g)??[]).length,103);
  assert.deepEqual(await globalFacts(),before);
});

async function pinWait(blocker:number) {
  const deadline=Date.now()+7000;
  while(Date.now()<deadline){const rows=(await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",[blocker])).rows;
    if(rows.some(r=>/stocktake_adjustment_access/.test(r.query)))return;await new Promise(r=>setTimeout(r,10));}
  assert.fail('Real terminal IAM waiter was not observed');
}
test('late membership withdrawal at actual final PIN denies already captured value content and leaves all business facts unchanged',async()=>{
  const f=await stocktakeAdjustmentFixture(app,true),done=await post(f,await series(f)),d=done.documents[0],before=await productCatalogFacts(f.tenant),held=await pool.connect();let pending:ReturnType<typeof f.request>|undefined;
  try{
    await held.query('BEGIN');const pid=(await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await held.query('SELECT role FROM memberships WHERE(tenant_id,user_id)=($1,$2) FOR NO KEY UPDATE',[f.tenant,f.user]);
    pending=f.request(base+'/documents/'+d.id+'/export?format=xml&include_values=true');void pending.catch(()=>undefined);
    await pinWait(pid);await held.query("UPDATE memberships SET role='operator' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);await held.query('COMMIT');
    const denied=await pending;assert.equal(denied.statusCode,403);assert(!denied.body.includes('<stocktake_adjustment'));
  }finally{await held.query('ROLLBACK').catch(()=>undefined);held.release();await pending?.catch(()=>undefined);await pool.query("UPDATE memberships SET role='admin' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);}
  assert.deepEqual(await productCatalogFacts(f.tenant),before);
});

test('late API-key scope withdrawal/expiry denies explicit values rather than publishing earlier rendered costs',async()=>{
  const f=await stocktakeAdjustmentFixture(app,true),done=await post(f,await series(f)),d=done.documents[0];
  const key=await f.ok('/developer/keys','POST',{name:'Current values reader',scopes:['inventory:read','purchasing:read']},201);
  const original=(await pool.query('SELECT scopes,expires_at::text FROM api_keys WHERE(tenant_id,id)=($1,$2)',[f.tenant,key.id])).rows[0],before=await productCatalogFacts(f.tenant);
  for(const expire of [false,true]){
    const held=await pool.connect();let pending:ReturnType<typeof f.request>|undefined;
    try{await held.query('BEGIN');const pid=(await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await held.query('SELECT id FROM api_keys WHERE(tenant_id,id)=($1,$2) FOR NO KEY UPDATE',[f.tenant,key.id]);
      pending=f.request(base+'/documents/'+d.id+'/export?format=csv&include_values=true','GET',undefined,key);void pending.catch(()=>undefined);
      await pinWait(pid);if(expire)await held.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE(tenant_id,id)=($1,$2)",[f.tenant,key.id]);
      else await held.query("UPDATE api_keys SET scopes=ARRAY['inventory:read']::text[] WHERE(tenant_id,id)=($1,$2)",[f.tenant,key.id]);
      await held.query('COMMIT');const response=await pending;assert.equal(response.statusCode,expire?401:403);assert(!response.body.includes('record_type'));
    }finally{await held.query('ROLLBACK').catch(()=>undefined);held.release();await pending?.catch(()=>undefined);await pool.query('UPDATE api_keys SET scopes=$3,expires_at=$4::timestamptz WHERE(tenant_id,id)=($1,$2)',[f.tenant,key.id,original.scopes,original.expires_at]);}
    assert.deepEqual(await productCatalogFacts(f.tenant),before);
  }
});
