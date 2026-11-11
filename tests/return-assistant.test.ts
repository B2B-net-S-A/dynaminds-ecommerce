import { after,before,test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32,deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate,pool } from '../server/db';
import { seed } from './fixtures';
import { returnAssistantFixture } from './return-assistant-fixture';
assert.equal(process.env.DYNA_TEST,'true');
const db=new URL(process.env.DATABASE_URL??'');assert(['localhost','127.0.0.1','[::1]'].includes(db.hostname));assert.match(db.pathname,/^\/dynaminds_test_\d+$/);
let app:Awaited<ReturnType<typeof buildApp>>;
before(async()=>{await migrate();await seed();app=await buildApp({integrationTransport:async()=>{throw Error('Local assistant cannot invoke a provider');}});});
after(async()=>{try{await app?.close();}finally{await pool.end();}});
async function facts(tenant:string){const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");const names=(await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema=t.table_schema AND c.table_name=t.table_name AND c.column_name='tenant_id') ORDER BY 1")).rows;const out:Record<string,any>={};for(const {table_name}of names){assert.match(table_name,/^[a-z][a-z0-9_]*$/);out[table_name]=(await c.query(`SELECT to_jsonb(x) row FROM "${table_name}" x WHERE tenant_id=$1 ORDER BY 1`,[tenant])).rows;}await c.query('COMMIT');return out;}finally{await c.query('ROLLBACK').catch(()=>{});c.release();}}
const unchangedCore=(a:any,b:any)=>{for(const table of ['orders','order_items','order_pick_items','return_cases','return_items','stock','stock_locations','stock_movements','stock_location_movements','reservations','reservation_locations','payment_entries','documents','wms_operations','wms_layer_positions','wms_return_fragments','wms_layer_movements'])assert.deepEqual(a[table],b[table],table);};
async function start(f:Awaited<ReturnType<typeof returnAssistantFixture>>){const lease=randomUUID(),body={client_key:randomUUID(),return_number:f.rma.number,station_id:f.station.id,station_version:String(f.station.version),lease_token:lease};const r=await f.ok('/return-assistant/sessions','POST',body,201);return {lease,body,session:r.session};}
for(const on of [false,true])test(`${on?'ON bundle':'OFF duplicate SKU'} inspection changes no goods until one atomic receipt; grouped status and pennies stay exact`,async()=>{
 const f=await returnAssistantFixture(app,on,true),beforeRows=await facts(f.tenant);let {lease,body,session}=await start(f);
 assert.equal(session.lines.length,2);assert.equal(new Set(session.lines.map((l:any)=>l.item_id)).size,2);assert.equal(session.lease_generation,1);
 const ambiguity=await f.request('/return-assistant/sessions/'+session.id+'/scans','POST',{client_key:randomUUID(),version:String(session.version),lease_token:lease,code:f.product.sku});assert.equal(ambiguity.statusCode,409);assert.match(ambiguity.body,/niejednoznaczny/);
 const same=await f.ok('/return-assistant/sessions','POST',body);assert.equal(same.reused,true);assert.equal(same.session.id,session.id);
 for(const line of session.lines)for(let i=0;i<line.requested;i++)session=(await f.ok('/return-assistant/sessions/'+session.id+'/scans','POST',{client_key:randomUUID(),version:String(session.version),lease_token:lease,code:f.product.sku,item_id:line.item_id})).session;
 const cheap=session.lines.find((l:any)=>l.line_total===1000),expensive=session.lines.find((l:any)=>l.line_total===3401);
 const parts=[{part_id:randomUUID(),item_id:cheap.item_id,status:'sale',quantity:1},{part_id:randomUUID(),item_id:expensive.item_id,status:'hold',quantity:1},{part_id:randomUUID(),item_id:expensive.item_id,status:'reject',quantity:1}];
 // One accepted bundle returns only its exact frozen original components.
 const wms=on?{...f.receiveBody.wms_lots,picks:f.receiveBody.wms_lots.picks.map((p:any)=>({...p,quantity:p.quantity/3}))}:undefined;
 session=(await f.ok('/return-assistant/sessions/'+session.id+'/draft','PATCH',{client_key:randomUUID(),version:String(session.version),lease_token:lease,parts,note:'Own inspection sale, hold and rejection',shipping_refund:0,...(wms?{wms_lots:wms}:{})})).session;
 unchangedCore(beforeRows,await facts(f.tenant));
 const preview=(await f.ok('/return-assistant/sessions/'+session.id+'/previews','POST',{client_key:randomUUID(),version:String(session.version),lease_token:lease},201)).preview;
 assert.equal(preview.action,'receive');assert.equal(preview.summary.accepted,2);assert.equal(preview.summary.restocked,1);assert.equal(preview.summary.held,1);assert.equal(preview.summary.rejected,1);assert.equal(preview.summary.refund_minor,2700);assert.equal(preview.can_read_value,false);
 assert(preview.snapshot.source.issue_fragments.every((fr:any)=>!Object.hasOwn(fr,'unit_cost_minor')&&!Object.hasOwn(fr,'value_minor')));
 const approved={client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true,lease_token:lease};const result=await f.ok('/return-assistant/previews/'+preview.id+'/receive','POST',approved,201);
 assert.equal(result.return_case.state,'refund_pending');assert.equal(result.return_case.refund_amount,2700);assert.equal(result.return_case.settlement,null);assert.equal(result.session.state,'completed');assert.equal(result.receipt.action,'receive');
 const afterRows=await facts(f.tenant);assert.deepEqual(afterRows.payment_entries,beforeRows.payment_entries);assert.deepEqual(afterRows.documents,beforeRows.documents);assert.deepEqual(afterRows.order_items,beforeRows.order_items);assert.equal(afterRows.return_assistant_receipts.length,1);
 assert.equal(afterRows.stock_movements.filter((x:any)=>x.row.return_id===f.rma.id).length,on?2:1);assert.equal(afterRows.wms_return_fragments.length>0,on);
 const replay=await f.ok('/return-assistant/previews/'+preview.id+'/receive','POST',approved);assert.equal(replay.reused,true);assert.deepEqual(replay.receipt,result.receipt);assert.deepEqual(await facts(f.tenant),afterRows);
 assert.equal((await f.request('/return-assistant/previews/'+preview.id+'/receive','POST',{...approved,scope_hash:'0'.repeat(64)})).statusCode,409);assert.deepEqual(await facts(f.tenant),afterRows);
});
test('all rejected portions need no fabricated scans or stock: one immutable rejection and exact replay',async()=>{
 const f=await returnAssistantFixture(app),beforeRows=await facts(f.tenant);let {session,lease}=await start(f);
 session=(await f.ok('/return-assistant/sessions/'+session.id+'/draft','PATCH',{client_key:randomUUID(),version:String(session.version),lease_token:lease,parts:f.rma.items.map((i:any)=>({part_id:randomUUID(),item_id:i.item_id,status:'reject',quantity:i.requested})),note:'Not accepted after explicit inspection decision',shipping_refund:0})).session;
 const preview=(await f.ok('/return-assistant/sessions/'+session.id+'/previews','POST',{client_key:randomUUID(),version:String(session.version),lease_token:lease},201)).preview;assert.equal(preview.action,'reject');assert.equal(preview.summary.scanned,0);
 const b={client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true,lease_token:lease};const r=await f.ok('/return-assistant/previews/'+preview.id+'/receive','POST',b,201);assert.equal(r.return_case.state,'rejected');assert.equal(r.return_case.refund_amount,0);assert.equal(r.return_case.receipt,null);const afterRows=await facts(f.tenant);for(const table of ['stock','stock_locations','stock_movements','wms_operations','payment_entries','documents'])assert.deepEqual(afterRows[table],beforeRows[table]);const again=await f.ok('/return-assistant/previews/'+preview.id+'/receive','POST',b);assert(again.reused);assert.deepEqual(await facts(f.tenant),afterRows);
});
test('real encrypted photo survives draft and receipt reads; station change invalidates approval and no byte is public metadata',async()=>{
 const f=await returnAssistantFixture(app);let {session,lease}=await start(f);
 const chunk=(name:string,b:Buffer)=>{const n=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(b.length);crc.writeUInt32BE(crc32(Buffer.concat([n,b])));return Buffer.concat([size,n,b,crc]);};const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,50,100,150,255]))),chunk('IEND',Buffer.alloc(0))]).toString('base64');
 session=(await f.ok('/return-assistant/sessions/'+session.id+'/photos','POST',{client_key:randomUUID(),version:String(session.version),lease_token:lease,item_id:f.rma.items[0].item_id,mime:'image/png',content_base64:png},201)).session;assert.equal(session.photos.length,1);assert(!JSON.stringify(session.photos).includes('content_base64'));
 const content=await f.ok('/return-assistant/photos/'+session.photos[0].id+'/content');assert.equal(content.content_base64,png);assert.equal(content.sha256,session.photos[0].sha256);
 const photo=(await pool.query('SELECT content_encrypted FROM return_assistant_photos WHERE tenant_id=$1',[f.tenant])).rows[0];assert(!photo.content_encrypted.includes(png));
 session=(await f.ok('/return-assistant/sessions/'+session.id+'/scans','POST',{client_key:randomUUID(),version:String(session.version),lease_token:lease,code:f.product.sku,item_id:f.rma.items[0].item_id})).session;
 session=(await f.ok('/return-assistant/sessions/'+session.id+'/draft','PATCH',{client_key:randomUUID(),version:String(session.version),lease_token:lease,note:'Own sale inspection with image',shipping_refund:0,parts:[{part_id:randomUUID(),item_id:f.rma.items[0].item_id,status:'sale',quantity:1}]})).session;
 const preview=(await f.ok('/return-assistant/sessions/'+session.id+'/previews','POST',{client_key:randomUUID(),version:String(session.version),lease_token:lease},201)).preview;
 await f.ok('/packing/stations/'+f.station.id,'PATCH',{client_key:randomUUID(),version:String(f.station.version),enabled:false});const beforeRows=await facts(f.tenant);
 assert.equal((await f.request('/return-assistant/previews/'+preview.id+'/receive','POST',{client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true,lease_token:lease})).statusCode,409);assert.deepEqual(await facts(f.tenant),beforeRows);
});
