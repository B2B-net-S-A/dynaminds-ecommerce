import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { pool } from '../server/db';
import { adjustmentActor } from './stocktake-adjustments-fixture';

export type Row = Record<string, any>;
export type Facts = Record<string, { row: Row }[]>;
export const prefix169 = '/catalog-stock-control';
export const physical169 = ['stock','stock_locations','stock_movements','stock_location_movements','stock_file_import_epochs','purchasing_stock_changes','wms_policies','wms_lots','wms_cost_layers','wms_layer_positions','wms_layer_movements','wms_operations','wms_issue_fragments','wms_return_fragments','reservations','reservation_locations','wms_reservation_layers'];
export const integer169 = (v: unknown) => { assert(v !== null && v !== undefined); return BigInt(String(v)); };
export const raw169 = (f: Facts, name: string): Row[] => { assert(f[name], name); return f[name].map(x => x.row); };
export const own169 = (f: Facts, name: string, tenant: string) => raw169(f,name).filter(r=>r.tenant_id===tenant);
export const sort169 = <T>(xs:T[]) => [...xs].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
export const consent169 = (p:Row) => ({client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true});

export function assertNumericDatabase169() {
  assert.equal(process.env.DYNA_TEST,'true');
  const u=new URL(process.env.DATABASE_URL??'');
  assert(['localhost','127.0.0.1','[::1]'].includes(u.hostname));
  assert.match(u.pathname,/^\/dynaminds_test_\d+$/);
}

/** Import safe; root alone invokes this in its fresh, exclusively owned DB. */
export async function bootstrap151169() {
  assertNumericDatabase169();
  assert.equal((await pool.query("SELECT to_regclass('public.migrations') ledger")).rows[0].ledger,null);
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
  const source=await readFile(new URL('../server/db.ts',import.meta.url),'utf8');
  const part=source.slice(source.indexOf('for (const [name, file] of ['));
  assert(part.startsWith('for (const [name, file] of ['));
  const manifest=[...part.matchAll(/\[\s*'(\d{3}_[a-z0-9_]+)'\s*,\s*'\.\/([a-z0-9_-]+\.sql)'\s*,?\s*\]/g)]
    .map(m=>({name:m[1],file:m[2]})).filter(m=>Number(m.name.slice(0,3))<=151);
  assert.equal(manifest.length,151); assert.equal(manifest[0].name,'001_foundation');
  assert.equal(manifest.at(-1)?.name,'151_warehouse_wz_issuer');
  assert.deepEqual(manifest.map(m=>Number(m.name.slice(0,3))),Array.from({length:151},(_,i)=>i+1));
  const c=await pool.connect();
  try { for(const m of manifest) {
    await c.query('BEGIN');
    try {
      await c.query(await readFile(new URL('../server/'+m.file,import.meta.url),'utf8'));
      if(m.name==='092_wms_stocktakes') await c.query(await readFile(new URL('../server/wms-stocktake-invariants.sql',import.meta.url),'utf8'));
      if(m.name==='108_b2b_dropshipping') await c.query(await readFile(new URL('../server/108_b2b_dropship_dispatch.sql',import.meta.url),'utf8'));
      await c.query('INSERT INTO migrations(name) VALUES($1)',[m.name]); await c.query('COMMIT');
    } catch(e) { await c.query('ROLLBACK'); throw e; }
  } } finally { c.release(); }
}

export async function install152169() {
  const c=await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(await readFile(new URL('../server/152_catalog_stock_control.sql',import.meta.url),'utf8'));
    await c.query("INSERT INTO migrations(name) VALUES('152_catalog_stock_control')");
    await c.query('COMMIT');
  } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

/** Literal UTC global rows, including all sessions. No tenant exclusion. */
export async function facts169():Promise<Facts> {
  const c=await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    const f:Facts={};
    for(const {tablename} of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows) {
      assert.match(tablename,/^[a-z][a-z0-9_]*$/);
      f[tablename]=(await c.query(`SELECT to_jsonb(r) row FROM public."${tablename}" r ORDER BY 1`)).rows;
    }
    await c.query('COMMIT'); return f;
  } finally { await c.query('ROLLBACK').catch(()=>{}); c.release(); }
}

export function physicalExact169(a:Facts,b:Facts) {
  for(const table of physical169) assert.deepEqual(b[table],a[table],'BO has no physical write or marker/version change: '+table);
}

/** Two actual catalog pools share both actual WH; no physical SQL fixture writes. */
export async function fixture169(app:FastifyInstance,on=false,quantity=5) {
  const tenant=randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own strict catalog169','enterprise')",[tenant]);
  const f=await adjustmentActor(app,tenant);
  const A=await f.ok('/warehouses','POST',{name:'Own BO169 A',code:'BOA-'+randomUUID().slice(0,8)});
  const B=await f.ok('/warehouses','POST',{name:'Own BO169 B',code:'BOB-'+randomUUID().slice(0,8)});
  const primary=(await pool.query('SELECT * FROM product_catalogs WHERE tenant_id=$1 AND is_default',[tenant])).rows[0]; assert(primary);
  const cp=(await f.ok('/product-catalogs/previews','POST',{client_key:randomUUID(),kind:'create',settings:{
    name:'Own separate pool169',active:true,languages:['pl'],default_language:'pl',warehouse_ids:[A.id,B.id],price_list_ids:[],
  }},201)).preview;
  const secondary=(await f.ok('/product-catalogs/previews/'+cp.id+'/commit','POST',consent169(cp),201)).catalog;
  const products:Row[]=[];
  for(const cost of (on?['0','1000',null]:[null])) {
    const p=await f.ok('/products','POST',{catalog_id:primary.id,name:'=BO169 '+String(cost),sku:'BO169-'+randomUUID(),price:1501,vat:23,warehouse_id:A.id,quantity,location:'A-01'},201);
    products.push({...p,cost});
  }
  const other=await f.ok('/products','POST',{catalog_id:secondary.id,name:'Other selected pool169',sku:'OTHER169-'+randomUUID(),price:1501,vat:23,warehouse_id:A.id,quantity:7,location:'A-01'},201);
  if(on) {
    const lines:Row[]=[];
    for(const p of [...products,{...other,cost:'1000'}]) {
      const stock=(await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',[tenant,A.id,p.id])).rows[0];
      lines.push({product_id:p.id,warehouse_id:A.id,location:'A-01',quantity:p.id===other.id?7:quantity,stock_version:String(stock.version),lot_code:'BO169-'+randomUUID(),unit_cost_minor:p.cost});
    }
    if(lines.some(l=>l.quantity>0)) {
      const p=(await f.ok('/wms-lots/opening-previews','POST',{client_key:randomUUID(),policy_version:'0',currency:'PLN',note:'Actual existing layers before catalog BO',lines:lines.filter(l=>l.quantity>0)},201)).preview;
      assert.equal(p.ready,true);
      await f.ok('/wms-lots/opening-previews/'+p.id+'/activate','POST',{client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true,ack_unknown_costs:true},201);
    }
  }
  return {...f,on,warehouse:A,warehouses:[A,B],products,other,primary,secondary};
}
export type Fixture169=Awaited<ReturnType<typeof fixture169>>;

export async function prepare169(f:Fixture169,catalog=f.primary) {
  const sourceReply=await f.ok(prefix169+'/catalogs/'+catalog.id+'/source');
  assert.equal(sourceReply.activation_available,true,'Real activation must be integrated; a false capability is not BO proof');
  assert.equal(sourceReply.writers_available,true,'All actual physical adapters must exist before activation');
  const source=sourceReply.source; assert(source); assert.equal(source.ready,true); assert.deepEqual(source.blockers,[]);
  const body={client_key:randomUUID(),catalog_version:source.snapshot.catalog.version,policy_version:source.snapshot.policy.version,
    warehouse_policy_versions:source.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.policy.version})),
    series_versions:source.snapshot.warehouses.map((w:Row)=>({warehouse_id:w.id,version:w.series.version}))};
  const reply=await f.ok(prefix169+'/catalogs/'+catalog.id+'/previews','POST',body,201),preview=reply.preview;
  assert(preview); assert.equal(preview.ready,true); assert.equal(preview.can_commit,true); assert.equal(preview.operation_id,null);
  return {source,body,preview,commit:consent169(preview)};
}
export async function allRows169(f:Fixture169,path:string) {
  const result:Row[]=[]; let cursor:number|undefined;
  do {
    const response=await f.ok(path+'?limit=100'+(cursor===undefined?'':'&cursor='+cursor));
    assert(Array.isArray(response.data)); assert.equal(response.meta.limit,100); assert.equal(response.meta.total>=result.length,true);
    for(const row of response.data) { assert.equal(row.ordinal,result.length); result.push(row); }
    const next=response.meta.cursor;
    if(next!==null) { assert.equal(typeof next,'number'); assert.equal(next,result.length); assert(result.length>0); }
    cursor=next===null?undefined:next;
    if(next===null) { assert.equal(result.length,response.meta.total); break; }
  } while(true);
  return result;
}

export async function wait169(blocker:number,query:RegExp,timeout=5000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    const waiting=(await pool.query("SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",[blocker])).rows;
    const found=waiting.find(r=>query.test(r.query)); if(found) return found.pid as number;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Actual PostgreSQL lock waiter was not observed: '+query);
}
/** Owner-side observation only; no application grant or second pool transaction. */
export async function owner169<T>(c:PoolClient,tenant:string,work:()=>Promise<T>):Promise<T> {
  const s=(await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
  assert.equal(s.owner,'postgres'); assert.equal(s.tenant,tenant); assert(['postgres','dyna_app'].includes(s.role));
  const restore=s.role==='dyna_app';let failed=false;
  try { if(restore) await c.query('RESET ROLE'); return await work(); }
  catch(e) { failed=true;throw e; }
  finally { if(restore) try { await c.query('SET LOCAL ROLE dyna_app'); } catch(e) { if(!failed) throw e; } }
}
