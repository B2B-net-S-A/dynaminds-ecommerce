/** Source only; root runs using its exclusively owned disposable PostgreSQL. */
import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { buildApp } from '../server/app';
import { migrate,pool } from '../server/db';
import { warehouseDocumentRegister } from '../server/warehouse-document-register';
import { seed } from './fixtures';
import { stocktakeAdjustmentFixture,countedAdjustmentSource,adjustmentActor,type AdjustmentFixture,type AdjustmentTestRow as Row } from './stocktake-adjustments-fixture';
import { withoutApiKeyLastUse } from './api-key-last-use';

assert.equal(process.env.DYNA_TEST,'true');
const database=new URL(process.env.DATABASE_URL??'');
assert(['localhost','127.0.0.1','[::1]'].includes(database.hostname));assert.match(database.pathname,/^\/dynaminds_test_\d+$/);
let app:Awaited<ReturnType<typeof buildApp>>,providers=0;
const base='/warehouse-document-register';
before(async()=>{await migrate();await seed();app=await buildApp({integrationTransport:async()=>{providers++;throw Error('No transport in register166');}});});
after(async()=>{try{assert.equal(providers,0);await app?.close();}finally{await pool.end();}});
const qs=(q:Record<string,string>)=>new URLSearchParams(q).toString();
async function posted(f:AdjustmentFixture){
  const source=await countedAdjustmentSource(f),series:Record<string,Row>={};
  for(const kind of ['PW','RW'])series[kind]=(await f.ok('/stocktake-adjustments/series','POST',{client_key:randomUUID(),kind,name:'Own union '+kind,prefix:kind+randomUUID().replaceAll('-','').slice(0,12).toUpperCase()},201)).series;
  const p=(await f.ok('/stocktake-adjustments/previews','POST',{client_key:randomUUID(),source_kind:source.source_kind,stocktake_id:source.id,version:source.version,
    ...(f.on?{review_id:source.review_id,scope_hash:source.scope_hash}:{review_hash:source.review_hash}),pw_series_id:series.PW.id,rw_series_id:series.RW.id},201)).preview;
  return f.ok('/stocktake-adjustments/previews/'+p.id+'/post','POST',{client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true},201);
}
async function legacy(f:AdjustmentFixture,kind:'receipt'|'transfer'|'issue'|'count',destination?:string,post=false){
  const stock=(await pool.query('SELECT version,on_hand FROM public.stock WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3)',[f.tenant,f.warehouse.id,f.products[0].id])).rows[0];
  const born=await f.ok('/warehouse-documents','POST',{kind,warehouse_id:f.warehouse.id,destination_id:destination??null,note:'Recorded legacy & <source>',reference:'=REF166',
    lines:[{product_id:f.products[0].id,quantity:kind==='count'?stock.on_hand:1,location:'A-01',...(kind==='count'?{expected_version:String(stock.version)}:{})}]},201);
  return post?f.ok('/warehouse-documents/'+born.id+'/post','POST',{version:born.version}):born;
}
async function facts(){const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");const result:Record<string,unknown[]>={};
  for(const {tablename} of(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows){assert.match(tablename,/^[a-z_][a-z0-9_]*$/);result[tablename]=(await c.query(`SELECT to_jsonb(r) row FROM public."${tablename}" r ORDER BY 1`)).rows;}
  await c.query('COMMIT');return withoutApiKeyLastUse(result);}finally{await c.query('ROLLBACK').catch(()=>undefined);c.release();}}
const forbidden=['unit_cost_minor','value_minor','currency','exponent','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','rows_sha256','nonce','scope_hash','actor_id','api_key_id'];
function noValue(v:unknown){const s=JSON.stringify(v);for(const k of forbidden)assert(!s.includes(k),'Private/value field '+k);}
type Xml={name:string;text:string;attrs:Record<string,string>;children:Xml[]};
function xml(s:string){let root:Xml|undefined;const stack:Xml[]=[],p=new SaxesParser();p.on('doctype',()=>assert.fail('No DTD'));
  p.on('opentag',n=>{const x:Xml={name:n.name,text:'',attrs:Object.fromEntries(Object.entries(n.attributes)) as Record<string,string>,children:[]};if(stack.length)stack.at(-1)!.children.push(x);else{assert(!root);root=x;}stack.push(x);});
  p.on('text',s=>{if(stack.length)stack.at(-1)!.text+=s;});p.on('closetag',()=>stack.pop());p.write(s).close();assert(root);assert.equal(stack.length,0);return root;}
function child(n:Xml,name:string){const found=n.children.filter(x=>x.name===name);assert.equal(found.length,1);return found[0];}
async function sameCsvBytesWithFreshReadTime(f:AdjustmentFixture,url:string,first:Row){
  const next=await f.ok(url);
  assert.deepEqual(Buffer.from(next.content,'utf8'),Buffer.from(first.content,'utf8'),'Unchanged recorded document exports have identical actual CSV bytes');
  assert.deepEqual(next.document,first.document);assert.equal(next.row_count,first.row_count);assert.equal(next.values_included,first.values_included);
  assert(Number.isFinite(Date.parse(first.snapshot_at)));assert(Number.isFinite(Date.parse(next.snapshot_at)));
  assert.notEqual(next.snapshot_at,first.snapshot_at,'Each independent RR response retains its fresh read timestamp');
  assert(Date.parse(next.snapshot_at)>=Date.parse(first.snapshot_at));
  assert(!first.content.split('\r\n')[0].includes('"snapshot_at"'),'Transient read time is envelope metadata, not a stored-document CSV column');
}

test('53 real mixed tied heads paginate in one SQL order; every global row remains exact after all reads',async()=>{
  const f=await stocktakeAdjustmentFixture(app),clock='test_union166_'+randomUUID().replaceAll('-','');
  await pool.query(`CREATE FUNCTION public.${clock}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${f.tenant}'::uuid THEN NEW.created_at:='2026-02-03T04:05:06.123456Z';END IF;RETURN NEW;END $$`);
  for(const table of ['warehouse_documents','stocktake_adjustment_documents'])await pool.query(`CREATE TRIGGER ${clock} BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${clock}()`);
  const legacyIds:string[]=[];let adjustment:Row;
  try{for(let i=0;i<51;i++)legacyIds.push((await legacy(f,'receipt')).id);adjustment=await posted(f);}
  finally{for(const table of ['warehouse_documents','stocktake_adjustment_documents'])await pool.query(`DROP TRIGGER ${clock} ON public.${table}`);await pool.query(`DROP FUNCTION public.${clock}()`);}
  const before=await facts(),first=await f.ok(base+'?limit=50'),second=await f.ok(base+'?'+qs({limit:'50',cursor:first.meta.cursor}));
  assert.equal(first.data.length,50);assert.equal(second.data.length,3);assert.equal(second.meta.cursor,null);
  const expected=[...legacyIds.sort().reverse().map(id=>({origin:'warehouse',id})),...adjustment!.documents.map((d:Row)=>d.id).sort().reverse().map((id:string)=>({origin:'stocktake_adjustment',id}))];
  assert.deepEqual([...first.data,...second.data].map((x:Row)=>({origin:x.origin,id:x.id})),expected);
  assert.equal(new Set([...first.data,...second.data].map((x:Row)=>x.origin+':'+x.id)).size,53);
  const same=await f.ok(base+'?'+qs({from:'2026-02-03T04:05:06.123456Z',to:'2026-02-03T04:05:06.123456Z',origin:'stocktake_adjustment'}));assert.equal(same.data.length,2);
  assert.equal((await f.ok(base+'?number_prefix=%25')).data.length,0);assert.equal((await f.ok(base+'?number_prefix=_')).data.length,0);
  assert.equal((await f.request(base+'?'+qs({from:'2026-02-03T04:05:06.123457Z',to:'2026-02-03T04:05:06.123456Z'}))).statusCode,422);
  assert.deepEqual(await facts(),before);
});

test('actual PZ/MM/WZ and measured count remain distinct; MM CSV bytes repeat while each read timestamp is fresh',async()=>{
  const f=await stocktakeAdjustmentFixture(app),destination=await f.ok('/warehouses','POST',{name:'Actual transfer target166',code:'DST-'+randomUUID().slice(0,8)});
  const pz=await legacy(f,'receipt',undefined,true),mm=await legacy(f,'transfer',destination.id,true),wz=await legacy(f,'issue',undefined,true),count=await legacy(f,'count');
  const before=await facts();
  for(const [d,kind] of [[pz,'PZ'],[mm,'MM'],[wz,'WZ'],[count,'count']]as const){const got=await f.ok(base+'/warehouse/'+d.id);assert.equal(got.document.kind,kind);assert.equal(got.document.warehouse_names,'current');assert.equal(got.row_names,'recorded');assert.equal(got.rows.length,1);assert.equal(got.rows[0].quantity,d.lines[0].quantity);assert.equal(got.rows[0].delta,undefined);assert.equal(got.document.value_available,false);assert.equal(got.document.summary,null);}
  const detail=await f.ok(base+'/warehouse/'+mm.id);assert.equal(detail.document.destination.id,destination.id);assert.equal(detail.movements.length,2);
  assert.deepEqual(detail.movements.map((m:Row)=>[m.warehouse_id,m.delta]).sort(),[[f.warehouse.id,-1],[destination.id,1]].sort());
  for(const id of [destination.id,f.warehouse.id])assert.deepEqual((await f.ok(base+'?'+qs({kind:'MM',warehouse_id:id}))).data.map((h:Row)=>h.id),[mm.id]);
  assert.deepEqual((await f.ok(base+'?status=draft&kind=count')).data.map((h:Row)=>h.id),[count.id]);
  const file=await f.ok(base+'/warehouse/'+mm.id+'/export?format=xml&include_values=true');assert.equal(file.values_included,false);noValue(file);
  const parsed=xml(file.content);assert.equal(child(parsed,'rows').children.length,1);assert.equal(child(parsed,'movements').children.length,2);assert.equal(child(child(parsed,'evidence'),'reference').text,'=REF166');
  const csv=await f.ok(base+'/warehouse/'+mm.id+'/export?format=csv');assert(csv.content.includes("\"'=REF166\""));assert.equal(csv.content.split('\r\n').length,6,'columns,head,line,two movements,EOF');
  await sameCsvBytesWithFreshReadTime(f,base+'/warehouse/'+mm.id+'/export?format=csv',csv);
  assert.deepEqual(await facts(),before);
});

test('legacy warehouse names are current while149 names and recorded product names remain frozen',async()=>{
  const f=await stocktakeAdjustmentFixture(app),old=await legacy(f,'receipt'),done=await posted(f),original=f.warehouse.name;
  await pool.query('UPDATE public.warehouses SET name=$3 WHERE(tenant_id,id)=($1,$2)',[f.tenant,f.warehouse.id,'Current renamed166']);
  await pool.query('UPDATE public.products SET name=$3 WHERE(tenant_id,id)=($1,$2)',[f.tenant,f.products[0].id,'Current product renamed166']);
  const before=await facts(),current=await f.ok(base+'/warehouse/'+old.id),frozen=await f.ok(base+'/stocktake_adjustment/'+done.documents[0].id);
  assert.equal(current.document.warehouse.name,'Current renamed166');assert.equal(current.rows[0].name,f.products[0].name);assert.equal(frozen.document.warehouse.name,original);assert.equal(frozen.document.warehouse_names,'frozen');
  assert.deepEqual(await facts(),before);
});

test('ON0/1000/NULL full immutable detail and repeatable CSV retain every fragment; no-value files/envelopes omit financial fields',async()=>{
  const f=await stocktakeAdjustmentFixture(app,true),done=await posted(f),rw=done.documents.find((d:Row)=>d.kind==='RW'),key=await f.ok('/developer/keys','POST',{name:'Own union quantity',scopes:['inventory:read']},201),before=await facts();
  const detail=await f.ok(base+'/stocktake_adjustment/'+rw.id);assert.equal(detail.rows.length,3);assert.equal(detail.document.value_available,true);assert.deepEqual(detail.movements,[]);assert.equal(detail.evidence.receipt_id,done.receipt.id);
  assert.deepEqual(detail.rows.map((r:Row)=>r.unit_cost_minor).sort((a:any,b:any)=>String(a).localeCompare(String(b))),['0','1000',null].sort((a:any,b:any)=>String(a).localeCompare(String(b))));
  const original=(await f.ok('/stocktake-adjustments/documents/'+rw.id+'/rows?limit=100')).data;
  assert.deepEqual(detail.rows.map(({origin,...r}:Row)=>r),original);
  const file=await f.ok(base+'/stocktake_adjustment/'+rw.id+'/export?format=xml&include_values=true'),parsed=xml(file.content),rows=child(parsed,'rows').children;
  assert.equal(rows.length,3);for(let i=0;i<3;i++){assert.equal(child(rows[i],'product_id').text,detail.rows[i].product_id);assert.equal(child(rows[i],'movement_id').text,detail.rows[i].movement_id);if(detail.rows[i].unit_cost_minor===null)assert.deepEqual(child(rows[i],'unit_cost_minor').attrs,{nil:'true'});else assert.equal(child(rows[i],'unit_cost_minor').text,detail.rows[i].unit_cost_minor);}
  const csv=await f.ok(base+'/stocktake_adjustment/'+rw.id+'/export?format=csv&include_values=true');assert(csv.content.includes('"unknown"'));assert(csv.content.includes('"known"'));assert(csv.content.includes('"0"'));assert.equal(csv.content.split('\r\n').length,6);
  await sameCsvBytesWithFreshReadTime(f,base+'/stocktake_adjustment/'+rw.id+'/export?format=csv&include_values=true',csv);
  for(const format of ['csv','xml'])for(const principal of [undefined,key]){const redacted=await f.ok(base+'/stocktake_adjustment/'+rw.id+'/export?format='+format+'&include_values=false','GET',undefined,200,principal);assert.equal(redacted.document.value_available,false);noValue(redacted);assert.equal(redacted.row_count,3);}
  const redacted=await f.ok(base+'/stocktake_adjustment/'+rw.id,'GET',undefined,200,key);assert.equal(redacted.document.value_available,false);noValue(redacted);assert.equal(redacted.document.summary.rw_quantity,'3');
  assert.equal((await f.request(base+'/stocktake_adjustment/'+rw.id+'/export?format=xml&include_values=true','GET',undefined,key)).statusCode,403);
  assert.deepEqual(await facts(),before);
});

test('opaque mixed cursor binds actor/key/currentrole/filter/limit/readOnly; tamper and foreign resources refuse',async()=>{
  const f=await stocktakeAdjustmentFixture(app),foreign=await stocktakeAdjustmentFixture(app),done=await posted(f),first=await f.ok(base+'?limit=1'),cursor=first.meta.cursor;assert(cursor);
  const before=await facts();
  const incompatible:Record<string,string>[]=[{limit:'2',cursor},{limit:'1',cursor,origin:'warehouse'},{limit:'1',cursor,status:'posted'}];
  for(const q of incompatible)assert.equal((await f.request(base+'?'+qs(q))).statusCode,409);
  assert.equal((await foreign.request(base+'?'+qs({limit:'1',cursor}))).statusCode,409);
  assert.equal((await f.request(base+'?'+qs({cursor:(cursor[0]==='A'?'B':'A')+cursor.slice(1)}))).statusCode,422);
  assert.equal((await f.request(base+'?warehouse_id='+foreign.warehouse.id)).statusCode,404);
  assert.equal((await foreign.request(base+'/stocktake_adjustment/'+done.documents[0].id)).statusCode,404);
  await assert.rejects(warehouseDocumentRegister(f.actor,{limit:'1',cursor},{readOnly:true}),(e:{status?:number})=>e.status===409);
  assert.deepEqual(await facts(),before);
  const op=await adjustmentActor(app,f.tenant,'operator@demo.local');await pool.query("UPDATE public.memberships SET role='operator' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,op.user]);
  assert.equal((await op.request(base+'?'+qs({limit:'1',cursor}))).statusCode,409);
  const key=await f.ok('/developer/keys','POST',{name:'Cursor quantity166',scopes:['inventory:read']},201);
  const keyed=await f.ok(base+'?limit=1','GET',undefined,200,key);assert.equal((await f.request(base+'?'+qs({limit:'1',cursor:keyed.meta.cursor}))).statusCode,409);noValue(keyed);
});

async function pinWait(pid:number){const deadline=Date.now()+7000;while(Date.now()<deadline){const found=(await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",[pid])).rows;if(found.some(r=>/stocktake_adjustment_access/.test(r.query)))return;await new Promise(r=>setTimeout(r,10));}assert.fail('Actual final membership/key waiter missing');}
test('real held final membership PIN denies already-read export after currentadmin becomes operator',async()=>{
  const f=await stocktakeAdjustmentFixture(app,true),done=await posted(f),before=await facts(),held=await pool.connect();let pending:ReturnType<typeof f.request>|undefined;
  try{await held.query('BEGIN');const pid=(await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;await held.query('SELECT role FROM public.memberships WHERE(tenant_id,user_id)=($1,$2) FOR NO KEY UPDATE',[f.tenant,f.user]);
    pending=f.request(base+'/stocktake_adjustment/'+done.documents[0].id+'/export?format=xml&include_values=true');void pending.catch(()=>undefined);await pinWait(pid);
    await held.query("UPDATE public.memberships SET role='operator' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);await held.query('COMMIT');const denied=await pending;assert.equal(denied.statusCode,403);assert(!denied.body.includes('<warehouse_document'));
  }finally{await held.query('ROLLBACK').catch(()=>undefined);held.release();await pending?.catch(()=>undefined);await pool.query("UPDATE public.memberships SET role='admin' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant,f.user]);}
  assert.deepEqual(await facts(),before);
});

test('real held final key PIN sees revoke, expiry and scope loss, never emits earlier value content and does not mutate business data',async()=>{
  const f=await stocktakeAdjustmentFixture(app,true),done=await posted(f),key=await f.ok('/developer/keys','POST',{name:'Current166 cost reader',scopes:['inventory:read','purchasing:read']},201);
  const original=(await pool.query('SELECT scopes,revoked_at::text,expires_at::text FROM public.api_keys WHERE(tenant_id,id)=($1,$2)',[f.tenant,key.id])).rows[0],before=await facts();
  for(const change of ['scope','revoke','expiry'] as const){const held=await pool.connect();let pending:ReturnType<typeof f.request>|undefined;
    try{await held.query('BEGIN');const pid=(await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;await held.query('SELECT id FROM public.api_keys WHERE(tenant_id,id)=($1,$2) FOR NO KEY UPDATE',[f.tenant,key.id]);
      pending=f.request(base+'/stocktake_adjustment/'+done.documents[0].id+'/export?format=csv&include_values=true','GET',undefined,key);void pending.catch(()=>undefined);await pinWait(pid);
      if(change==='revoke')await held.query('UPDATE public.api_keys SET revoked_at=clock_timestamp() WHERE(tenant_id,id)=($1,$2)',[f.tenant,key.id]);
      else if(change==='expiry')await held.query("UPDATE public.api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE(tenant_id,id)=($1,$2)",[f.tenant,key.id]);
      else await held.query("UPDATE public.api_keys SET scopes=ARRAY['inventory:read']::text[] WHERE(tenant_id,id)=($1,$2)",[f.tenant,key.id]);
      await held.query('COMMIT');const denied=await pending;assert.equal(denied.statusCode,change==='scope'?403:401);assert(!denied.body.includes('record_type'));assert(!denied.body.includes('"content"'));
    }finally{await held.query('ROLLBACK').catch(()=>undefined);held.release();await pending?.catch(()=>undefined);await pool.query('UPDATE public.api_keys SET scopes=$3,revoked_at=$4::timestamptz,expires_at=$5::timestamptz WHERE(tenant_id,id)=($1,$2)',[f.tenant,key.id,original.scopes,original.revoked_at,original.expires_at]);}
    assert.deepEqual(await facts(),before);
  }
});

test('103 genuine repeated-SKU WMS shortage fragments survive the unified full manifest with known0/NULL costs',async()=>{
  const tenant=randomUUID();await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own full register166','enterprise')",[tenant]);
  const f=await adjustmentActor(app,tenant),wh=await f.ok('/warehouses','POST',{name:'Full fragment source166',code:'FR-'+randomUUID().slice(0,8)}),p=await f.ok('/products','POST',{name:'Repeated genuine fragment166',sku:'F166-'+randomUUID(),price:1000,vat:23,warehouse_id:wh.id,quantity:206,location:'A-01'},201);
  const locations=['A-01',...Array.from({length:102},(_,i)=>'F-'+String(i+1).padStart(3,'0'))];
  for(const location of locations.slice(1)){const current=(await pool.query('SELECT version FROM public.stock WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3)',[tenant,wh.id,p.id])).rows[0];await f.ok('/stock-location-moves','POST',{client_key:randomUUID(),warehouse_id:wh.id,product_id:p.id,location:'A-01',destination:location,quantity:2,expected_version:String(current.version),note:'Actual full fragment opening'});}
  const current=(await pool.query('SELECT version FROM public.stock WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3)',[tenant,wh.id,p.id])).rows[0];
  const opening=(await f.ok('/wms-lots/opening-previews','POST',{client_key:randomUUID(),policy_version:'0',currency:'PLN',note:'Complete real 103 cells',lines:locations.map((location,i)=>({warehouse_id:wh.id,product_id:p.id,location,quantity:2,stock_version:String(current.version),lot_code:'F166-'+i,unit_cost_minor:i%3===0?null:i%3===1?'0':'1000'}))},201)).preview;
  assert.equal(opening.ready,true);await f.ok('/wms-lots/opening-previews/'+opening.id+'/activate','POST',{client_key:randomUUID(),scope_hash:opening.scope_hash,confirmed:true,ack_unknown_costs:true},201);
  const h=(await f.ok('/wms-lots/stocktakes','POST',{client_key:randomUUID(),warehouse_id:wh.id,name:'All103 shortage rows',blind:false,policy_version:'1'},201)).stocktake;
  async function allLines(){const result:Row[]=[];let cursor:string|null=null;do{const r=await f.ok('/wms-lots/stocktakes/'+h.id+'/lines'+(cursor?'?cursor='+encodeURIComponent(cursor):''));result.push(...r.data);cursor=r.meta.cursor;assert(result.length<=103);}while(cursor);assert.equal(result.length,103);assert.equal(new Set(result.map(r=>r.id)).size,103);return result;}
  const lines=await allLines();
  for(let offset=0;offset<103;offset+=100){const ids=new Set(lines.slice(offset,offset+100).map(l=>l.id)),live=await allLines(),batch=live.filter(l=>ids.has(l.id));for(const l of batch)assert.equal(l.counted,null);
    const counted=await f.ok('/wms-lots/stocktakes/'+h.id+'/counts','POST',{client_key:randomUUID(),note:'Actual bounded shortage batch',lines:batch.map(l=>({id:l.id,version:String(l.version),basis_token:l.basis_token,quantity:Number(l.current_quantity)-1}))},201);assert.equal(counted.measurement.updated,batch.length);assert.equal(counted.reused,false);}
  const head=(await f.ok('/wms-lots/stocktakes/'+h.id)).stocktake,review=(await f.ok('/wms-lots/stocktakes/'+h.id+'/reviews','POST',{client_key:randomUUID(),version:String(head.version),note:'All shortages use real original layers',surplus:[]},201)).review;
  const s=(await f.ok('/stocktake-adjustments/series','POST',{client_key:randomUUID(),kind:'RW',name:'Full103 register166',prefix:'RW'+randomUUID().replaceAll('-','').slice(0,12).toUpperCase()},201)).series;
  const preview=(await f.ok('/stocktake-adjustments/previews','POST',{client_key:randomUUID(),source_kind:'wms',stocktake_id:h.id,version:String(review.stocktake_version),review_id:review.id,scope_hash:review.scope_hash,rw_series_id:s.id},201)).preview;
  const done=await f.ok('/stocktake-adjustments/previews/'+preview.id+'/post','POST',{client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true},201);assert.equal(done.documents.length,1);const doc=done.documents[0];assert.equal(doc.row_count,103);
  const before=await facts(),detail=await f.ok(base+'/stocktake_adjustment/'+doc.id);assert.equal(detail.rows.length,103);assert.equal(detail.document.summary.unknown_rw_quantity,'35');assert.equal(detail.document.summary.known_rw_minor,'34000');
  const file=await f.ok(base+'/stocktake_adjustment/'+doc.id+'/export?format=xml&include_values=true'),rows=child(xml(file.content),'rows').children;assert.equal(rows.length,103);
  assert.deepEqual(rows.map(r=>child(r,'movement_id').text),detail.rows.map((r:Row)=>r.movement_id));assert.equal(new Set(detail.rows.map((r:Row)=>r.movement_id)).size,103);
  assert.equal(rows.filter(r=>child(r,'unit_cost_minor').attrs.nil==='true').length,35);assert.equal(rows.filter(r=>child(r,'unit_cost_minor').text==='0').length,34);assert.equal(rows.filter(r=>child(r,'unit_cost_minor').text==='1000').length,34);
  for(const r of rows)assert.equal(child(r,'product_id').text,p.id);assert.deepEqual(await facts(),before);
});

test('actual full200 legacy lines remain complete in detail/export; no page100 truncation or invented costs',async()=>{
  const f=await stocktakeAdjustmentFixture(app),products:Row[]=[];
  for(let i=0;i<200;i++)products.push(await f.ok('/products','POST',{name:'Full legacy row '+i,sku:'U166-'+randomUUID(),price:1000,vat:23,warehouse_id:f.warehouse.id,quantity:0,location:'A-01'},201));
  const born=await f.ok('/warehouse-documents','POST',{kind:'receipt',warehouse_id:f.warehouse.id,lines:products.map(p=>({product_id:p.id,quantity:1,location:'A-01'}))},201),before=await facts();
  const detail=await f.ok(base+'/warehouse/'+born.id);assert.equal(detail.rows.length,200);assert.equal(detail.document.row_count,200);assert.deepEqual(detail.rows.map((r:Row)=>r.ordinal),Array.from({length:200},(_,i)=>i));
  const file=await f.ok(base+'/warehouse/'+born.id+'/export?format=xml&include_values=true'),root=xml(file.content),rows=child(root,'rows').children;assert.equal(rows.length,200);assert.deepEqual(rows.map(r=>child(r,'product_id').text).sort(),products.map(p=>p.id).sort());assert.equal(file.values_included,false);noValue(file);
  assert.deepEqual(await facts(),before);
});
