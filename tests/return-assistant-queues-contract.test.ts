import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool,migrate } from '../server/db';
import { seed } from './fixtures';
import { returnAssistantQueueFixture,returnAssistantQueueFacts } from './return-assistant-queues-fixture';
import { tenantTx } from '../server/db';
import { ReturnAssistantPresentationLimitError,returnAssistantQueuePresentationInTx } from '../server/return-assistant-queues';
assert.equal(process.env.DYNA_TEST,'true');const db=new URL(process.env.DATABASE_URL??'');assert(['localhost','127.0.0.1','[::1]'].includes(db.hostname));assert.match(db.pathname,/^\/dynaminds_test_\d+$/);
let app:Awaited<ReturnType<typeof buildApp>>;
const transport=async():Promise<never>=>{throw Error('Queue HTTP contract must never call a provider');};
before(async()=>{await migrate();await seed();app=await buildApp({integrationTransport:transport});});
after(async()=>{try{await app?.close();}finally{await pool.end();}});
const tables=['return_assistant_settings','return_assistant_queues','return_assistant_queue_items','return_assistant_queue_operations','return_assistant_queue_admissions'];
test('genuinely absent 139 and 140 allow neutral settings/list GET and HEAD; normal/v1 malformed writes fail before parsing',async()=>{
 const f=await returnAssistantQueueFixture(app);const beforeRows=await returnAssistantQueueFacts(f.tenant);
 const allTables=[...tables,'return_assistant_sessions','return_assistant_operations','return_assistant_photos','return_assistant_previews','return_assistant_receipts','return_assistant_admissions'];
 const funcs=(await pool.query("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname LIKE 'return_assistant_%' ORDER BY p.oid")).rows;assert(funcs.length>=38);
 const markers=(await pool.query("SELECT name,applied_at::text applied_at FROM migrations WHERE name=ANY($1::text[]) ORDER BY name",[['139_return_assistant','140_return_assistant_queues']])).rows;assert.equal(markers.length,2);
 const c=await pool.connect();let hidden=false;
 try{
 await c.query('BEGIN');for(const fn of funcs){const signature=(await c.query('SELECT $1::oid::regprocedure::text signature',[fn.oid])).rows[0].signature;await c.query(`ALTER FUNCTION ${signature} RENAME TO qa140_both_hidden_${fn.oid}`);}for(const table of allTables)await c.query(`ALTER TABLE ${table} RENAME TO qa140_both_hidden_${table}`);await c.query('DELETE FROM migrations WHERE name=ANY($1::text[])',[markers.map(m=>m.name)]);await c.query('COMMIT');hidden=true;
 for(const prefix of ['/api','/api/v1']){
 for(const path of ['/settings','/queues']){const r=await app.inject({url:prefix+'/return-assistant'+path,headers:{cookie:f.cookie},remoteAddress:'127.140.2.4'});assert.equal(r.statusCode,200);assert.match(String(r.headers['cache-control']),/no-store/);assert.equal(r.json().available,false);assert.equal(r.json().can_write,false);if(path==='/queues'){assert.deepEqual(r.json().data,[]);assert.equal(r.json().next_cursor,null);}const h=await app.inject({method:'HEAD',url:prefix+'/return-assistant'+path,headers:{cookie:f.cookie},remoteAddress:'127.140.2.4'});assert.equal(h.statusCode,200);assert.equal(h.body,'');}
 for(const [method,path]of [['PATCH','/settings'],['POST','/queues'],['PATCH','/queues/'+randomUUID()]]as const){const r=await app.inject({method,url:prefix+'/return-assistant'+path,headers:{cookie:f.cookie,'content-type':'application/json'},payload:'{',remoteAddress:'127.140.2.4'});assert.equal(r.statusCode,503);}
 }
 }finally{await c.query('ROLLBACK');if(hidden){await c.query('BEGIN');for(const table of allTables)await c.query(`ALTER TABLE qa140_both_hidden_${table} RENAME TO ${table}`);for(const fn of funcs){const signature=(await c.query('SELECT $1::oid::regprocedure::text signature',[fn.oid])).rows[0].signature;assert.match(fn.proname,/^return_assistant_[a-z_]+$/);await c.query(`ALTER FUNCTION ${signature} RENAME TO ${fn.proname}`);}for(const marker of markers)await c.query('INSERT INTO migrations(name,applied_at) VALUES($1,$2::timestamptz)',[marker.name,marker.applied_at]);await c.query('COMMIT');}c.release();}
 assert.deepEqual(await returnAssistantQueueFacts(f.tenant),beforeRows);
});
test('genuinely absent 140 is neutral on GET/HEAD settings and list but malformed writes fail 503 before parsing',async()=>{
 const f=await returnAssistantQueueFixture(app);const beforeRows=await returnAssistantQueueFacts(f.tenant);
 const funcs=(await pool.query("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname LIKE 'return_assistant_queue_%' ORDER BY p.oid")).rows;assert(funcs.length>=14);
 const marker=(await pool.query("SELECT name,applied_at::text applied_at FROM migrations WHERE name='140_return_assistant_queues'")).rows[0];assert(marker);
 const c=await pool.connect();let hidden=false;
 try{await c.query('BEGIN');for(const f of funcs){const signature=(await c.query('SELECT $1::oid::regprocedure::text signature',[f.oid])).rows[0].signature;await c.query(`ALTER FUNCTION ${signature} RENAME TO qa140_hidden_${f.oid}`);}for(const table of tables)await c.query(`ALTER TABLE ${table} RENAME TO qa140_hidden_${table}`);await c.query("DELETE FROM migrations WHERE name='140_return_assistant_queues'");await c.query('COMMIT');hidden=true;
 for(const prefix of ['/api','/api/v1']){
 for(const path of ['/settings','/queues']){const r=await app.inject({url:prefix+'/return-assistant'+path,headers:{cookie:f.cookie},remoteAddress:'127.140.2.1'});assert.equal(r.statusCode,200);assert.match(String(r.headers['cache-control']),/no-store/);assert.equal(r.json().available,false);assert.equal(r.json().can_write,false);const h=await app.inject({method:'HEAD',url:prefix+'/return-assistant'+path,headers:{cookie:f.cookie},remoteAddress:'127.140.2.1'});assert.equal(h.statusCode,200);assert.equal(h.body,'');}
 for(const [method,path]of [['PATCH','/settings'],['POST','/queues'],['PATCH','/queues/'+randomUUID()]]as const){const r=await app.inject({method,url:prefix+'/return-assistant'+path,headers:{cookie:f.cookie,'content-type':'application/json'},payload:'{',remoteAddress:'127.140.2.1'});assert.equal(r.statusCode,503);}
 }
 }finally{await c.query('ROLLBACK');if(hidden){await c.query('BEGIN');for(const table of tables)await c.query(`ALTER TABLE qa140_hidden_${table} RENAME TO ${table}`);for(const f of funcs){const signature=(await c.query('SELECT $1::oid::regprocedure::text signature',[f.oid])).rows[0].signature;assert.match(f.proname,/^return_assistant_queue_[a-z_]+$/);await c.query(`ALTER FUNCTION ${signature} RENAME TO ${f.proname}`);}await c.query('INSERT INTO migrations(name,applied_at) VALUES($1,$2::timestamptz)',[marker.name,marker.applied_at]);await c.query('COMMIT');}c.release();}
 assert.deepEqual(await returnAssistantQueueFacts(f.tenant),beforeRows);
});
test('missing critical column or disabled deferred completion refuses reads/writes with 503 and no own effect',async()=>{
 const f=await returnAssistantQueueFixture(app);const beforeRows=await returnAssistantQueueFacts(f.tenant);
 for(const alteration of ['column','trigger']){let changed=false;try{if(alteration==='column')await pool.query('ALTER TABLE return_assistant_queues RENAME COLUMN position TO qa140_hidden_position');else await pool.query('ALTER TABLE return_assistant_queue_admissions DISABLE TRIGGER return_assistant_queue_complete');changed=true;
 for(const prefix of ['/api','/api/v1']){const r=await app.inject({url:prefix+'/return-assistant/settings',headers:{cookie:f.cookie},remoteAddress:'127.140.2.2'});assert.equal(r.statusCode,503);const w=await app.inject({method:'POST',url:prefix+'/return-assistant/queues',headers:{cookie:f.cookie,'content-type':'application/json'},payload:'{',remoteAddress:'127.140.2.2'});assert.equal(w.statusCode,503);}
 }finally{if(changed){if(alteration==='column')await pool.query('ALTER TABLE return_assistant_queues RENAME COLUMN qa140_hidden_position TO position');else await pool.query('ALTER TABLE return_assistant_queue_admissions ENABLE TRIGGER return_assistant_queue_complete');}}}
 assert.deepEqual(await returnAssistantQueueFacts(f.tenant),beforeRows);
});
test('restore rejects malformed metadata writes normal/v1 before parse, while headers/manifests remain readable',async()=>{
 const f=await returnAssistantQueueFixture(app);const queue=(await f.ok('/return-assistant/queues','POST',{client_key:randomUUID(),return_ids:f.return_ids,navigation:{auto_next:true,hide_accepted:true}},201)).queue;
 const readonly=await buildApp({readOnly:true,previewPort:4195,integrationTransport:transport});
 try{
 const login=await readonly.inject({method:'POST',url:'/api/auth/login',payload:{email:'admin@demo.local',password:'DynaDemo!2026'},remoteAddress:'127.140.2.3'});assert.equal(login.statusCode,200);
 const sw=await readonly.inject({method:'POST',url:'/api/workspaces/switch',payload:{tenant_id:f.tenant},headers:{cookie:String(login.headers['set-cookie']).split(';')[0]},remoteAddress:'127.140.2.3'});assert.equal(sw.statusCode,200);const cookie=String(sw.headers['set-cookie']).split(';')[0];const beforeRows=await returnAssistantQueueFacts(f.tenant);
 for(const prefix of ['/api','/api/v1']){
 for(const [method,path]of [['PATCH','/settings'],['POST','/queues'],['PATCH','/queues/'+queue.id]]as const){const r=await readonly.inject({method,url:prefix+'/return-assistant'+path,headers:{cookie,'content-type':'application/json'},payload:'{',remoteAddress:'127.140.2.3'});assert.equal(r.statusCode,423);}
 for(const path of ['/settings','/queues','/queues/'+queue.id,'/queues/'+queue.id+'/items']){const r=await readonly.inject({url:prefix+'/return-assistant'+path,headers:{cookie},remoteAddress:'127.140.2.3'});assert.equal(r.statusCode,200);assert.match(String(r.headers['cache-control']),/no-store/);const b=r.json();assert.equal(b.read_only,true);assert.equal(b.can_write,false);assert.equal(b.can_save_settings,false);assert.equal(b.can_manage_queue,false);if(b.queue)assert.equal(b.queue.id,queue.id);}
 }
 assert.deepEqual(await returnAssistantQueueFacts(f.tenant),beforeRows);
 }finally{await readonly.close();}
});
test('bounded auxiliary metadata cannot block genuine inspection or receive when presentation settings are unused',async()=>{
 for(const limit of ['locations','images']as const){
 const f=await returnAssistantQueueFixture(app);
 // Deliberately synthetic owner-only metadata in a fresh disposable test tenant.
 // Zero bins preserve real physical quantities; legacy images preserve sale authority.
 if(limit==='locations')await pool.query("INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity) SELECT $1,$2,$3,'QA140-AUX-'||lpad(n::text,4,'0'),0 FROM generate_series(1,501)n",[f.tenant,f.warehouse,f.product.id]);
 else await pool.query('UPDATE products SET images=$3::jsonb WHERE tenant_id=$1 AND id=$2',[f.tenant,f.product.id,JSON.stringify(Array.from({length:21},(_,i)=>`https://example.test/qa140-${i}.png`))]);
 assert.equal((await f.ok('/return-assistant/settings')).settings.values.thumbnail_size,'none');
 await assert.rejects(tenantTx(f.tenant,c=>returnAssistantQueuePresentationInTx(c,f.rma.id)),(e:unknown)=>e instanceof ReturnAssistantPresentationLimitError&&e.status===409&&e.code==='RETURN_ASSISTANT_PRESENTATION_LIMIT');
 const lease=randomUUID();let session=(await f.ok('/return-assistant/sessions','POST',{client_key:randomUUID(),return_number:f.rma.number,station_id:f.station.id,station_version:String(f.station.version),lease_token:lease},201)).session;
 assert.equal(session.presentation,null);assert.equal(session.presentation_unavailable_reason,'limit');assert.equal(session.lines[0].name,f.rma.items[0].name);assert.equal(session.can_control,true);
 const beforeRead=await returnAssistantQueueFacts(f.tenant);const read=(await f.ok('/return-assistant/sessions/'+session.id)).session;assert.equal(read.presentation,null);assert.equal(read.presentation_unavailable_reason,'limit');assert.deepEqual(await returnAssistantQueueFacts(f.tenant),beforeRead);
 session=(await f.ok('/return-assistant/sessions/'+session.id+'/scans','POST',{client_key:randomUUID(),version:String(session.version),lease_token:lease,code:f.product.sku,item_id:f.rma.items[0].item_id})).session;
 session=(await f.ok('/return-assistant/sessions/'+session.id+'/draft','PATCH',{client_key:randomUUID(),version:String(session.version),lease_token:lease,note:'Genuine inspection despite bounded auxiliary metadata',shipping_refund:0,parts:[{part_id:randomUUID(),item_id:f.rma.items[0].item_id,status:'sale',quantity:1}]})).session;
 const preview=(await f.ok('/return-assistant/sessions/'+session.id+'/previews','POST',{client_key:randomUUID(),version:String(session.version),lease_token:lease},201)).preview;
 const approved={client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true,lease_token:lease};const r=await f.ok('/return-assistant/previews/'+preview.id+'/receive','POST',approved,201);
 assert.equal(r.session.state,'completed');assert.equal(r.session.presentation,null);assert.equal(r.session.presentation_unavailable_reason,'limit');assert.equal(r.return_case.refund_amount,1000);assert.equal(r.receipt.summary.accepted,1);assert.equal(r.receipt.summary.restocked,1);
 const afterRows=await returnAssistantQueueFacts(f.tenant);assert.equal(afterRows.return_assistant_receipts.length,1);assert.equal(afterRows.stock_movements.filter((x:any)=>x.row.return_id===f.rma.id).length,1);
 // Genuine receiveReturn.changed updates only the order revision/timestamp here:
 // this one-unit RMA does not cover the entire three-unit original sale.
 assert.equal(afterRows.orders.length,beforeRead.orders.length);
 for(const old of beforeRead.orders){const actual=afterRows.orders.find(x=>x.row.id===old.row.id);assert(actual);assert.equal(BigInt(actual.row.version),BigInt(old.row.version)+1n);assert(new Date(actual.row.updated_at).getTime()>=new Date(old.row.updated_at).getTime());const {version:oldVersion,updated_at:oldUpdated,...oldFacts}=old.row;const {version:newVersion,updated_at:newUpdated,...newFacts}=actual.row;assert.deepEqual(newFacts,oldFacts);}
 for(const table of ['order_items','payment_entries','documents'])assert.deepEqual(afterRows[table],beforeRead[table],table);
 const replay=await f.ok('/return-assistant/previews/'+preview.id+'/receive','POST',approved);assert.equal(replay.reused,true);assert.deepEqual(replay.receipt,r.receipt);assert.deepEqual(await returnAssistantQueueFacts(f.tenant),afterRows);
 }
});
