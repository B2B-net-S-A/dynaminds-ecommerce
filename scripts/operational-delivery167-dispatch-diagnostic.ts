/** Root diagnostic; real existing failed own order, entire attempted dispatch rolled back. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const inputBytes=await readFile(resolve(process.argv[2]));assert.equal(hash(inputBytes),'39d74121db59e3427e42a020cf2c82e740c4e75076b9733c05a1627bae71bc2d');const input=JSON.parse(inputBytes.toString());
assert.equal(input.database,'dynaminds_test_1791431348741');
const cfgBytes=await readFile(input.configuration.path);assert.equal(hash(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
Object.assign(process.env,input.environment);process.env.DYNA_TEST='true';process.env.DYNA_IMAGE_DIR=input.images;
const directory=resolve(input.directory,'consumer167-dispatch-diagnostic1');await mkdir(directory,{mode:0o700});
const c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:input.database});await c.connect();
const afterFile=JSON.parse(await readFile(resolve(input.directory,'consumer167-native2/after.private.json'),'utf8'));
const beforeFile=JSON.parse(await readFile(resolve(input.directory,'consumer167-native2/before.private.json'),'utf8'));
const oldOrders=new Set(beforeFile.graph.rows.orders.map((r:any)=>r.row.id));
const order=afterFile.graph.rows.orders.map((r:any)=>r.row).find((r:any)=>!oldOrders.has(r.id)&&r.status==='packed'&&!afterFile.graph.rows.order_parcel_plans.some((p:any)=>p.row.order_id===r.id));assert(order);
const member=(await c.query("SELECT user_id,role FROM memberships WHERE tenant_id=$1 AND role='admin' ORDER BY user_id LIMIT 1",[order.tenant_id])).rows[0];assert(member);
const before=await captureDatabase(c,false);await c.end();
const {pool,tenantTx}=await import('../server/db');const {shipDemo}=await import('../server/domain');let observed:any;
const stop=Error('Own successful diagnostic rollback');
try{await tenantTx(order.tenant_id,async tx=>{await shipDemo(tx,{tenantId:order.tenant_id,userId:member.user_id,role:member.role},order.id);throw stop;});}catch(e){observed=e===stop?{success_rolled_back:true}:{name:(e as any)?.name,code:(e as any)?.code,message:(e as any)?.message,stack:(e as any)?.stack};}finally{await pool.end();}
const check=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:input.database});await check.connect();const after=await captureDatabase(check,false);await check.end();assert.equal(hash(JSON.stringify(after)),hash(JSON.stringify(before)));
const path=resolve(directory,'result.private.json'),bytes=Buffer.from(JSON.stringify({status:'ROOT_EXISTING167_DISPATCH_DIAGNOSTIC_ROLLBACK',observed,whole562_literal:true},null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});console.log(JSON.stringify({status:'ROOT_EXISTING167_DISPATCH_DIAGNOSTIC_ROLLBACK',result:{path,sha256:hash(bytes)},code:observed.code??null}));
