/** ROOT ONLY. GET + owner UTC REPEATABLE READ READ ONLY, no login or business
 * writes. Modes capture-before-post | after-post. Run from fixed primary with
 * APP_REVISION=QA_EXPECTED_REVISION, workers OFF, exact config/setup SHA pins.
 * QA164_READBACK_CONFIRM=READ_ONLY_OWN_STOCKTAKE_ADJUSTMENTS_164.
 * after-post additionally requires QA164_READBACK_BEFORE_SHA256 and explicit
 * QA164_OFF_RECEIPT_ID / QA164_ON_RECEIPT_ID. No latest-row inference or repair.
 * Optional QA164_SESSION_DELTA_JSON={off:{added:[tokenSHA],removed:[]},on:...}
 * binds <=4 own auth sessions per actor; omitted means exact unchanged sessions.
 * QA164_MIGRATION_AFTER_SHA256 optionally binds the immutable after-migration
 * checkpoint: every original row is retained exactly, additions only the two
 * new setup tenants/users. Absence is reported explicitly, never as proof.
 * Pure exports support a separately verified restore client; importing this
 * file does not read config, connect, invoke HTTP or run the CLI.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { captureReturnDestinationRestoreMetadata } from './return-destinations-native162-restore-readback';

type Row = Record<string, any>;
type Wrapped = { row: Row };
export type StocktakeAdjustmentCapture = {
  rows: Record<string, Wrapped[]>;
  fingerprints: Record<string, { count: number; sha256: string }>;
  portable_metadata: Awaited<ReturnType<typeof captureReturnDestinationRestoreMetadata>>;
  proof_hashes: Row[];
};
const ROOT = '<workspace>/app';
const SCHEMA = '149_stocktake_adjustments';
const TABLES = ['series','series_commands','counters','previews','preview_rows','admissions','receipts','documents','document_rows'].map(n=>'stocktake_adjustment_'+n);
const hash = (b: Buffer|string) => createHash('sha256').update(b).digest('hex');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const one = (rs: Row[]) => { assert.equal(rs.length,1); return rs[0]; };
const sorted = (rs: Row[]) => [...rs].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const omit = (r: Row, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k])=>!keys.includes(k)));
const own = (cap: StocktakeAdjustmentCapture,a: Row,n: string):Row[] => cap.rows[n].map(x=>x.row).filter(x=>x.tenant_id===a.tenant_id || (n==='tenants'&&x.id===a.tenant_id) || (n==='users'&&x.id===a.user_id));
const idName = (n: string) => { assert.match(n,/^[a-z][a-z0-9_]*$/); return '"'+n+'"'; };
const tick = (t: unknown) => { assert.equal(typeof t,'string'); const v=Date.parse(t as string); assert(Number.isFinite(v)); return v; };
const inc = (v: unknown) => { assert(/^(0|[1-9][0-9]*)$/.test(String(v))); return Number(BigInt(String(v))+1n); };

/** Caller owns a UTC RR READ ONLY transaction. No fixed database identity here:
 * native CLI and restore helper independently verify their exact connection.
 */
export async function captureStocktakeAdjustmentReadback(c: Pick<pg.Client,'query'>):Promise<StocktakeAdjustmentCapture> {
  assert.equal((await c.query("SELECT current_setting('transaction_read_only') r,current_setting('TimeZone') tz,current_setting('transaction_isolation') isolation")).rows[0].r,'on');
  const context=(await c.query("SELECT current_setting('TimeZone') tz,current_setting('transaction_isolation') isolation")).rows[0];
  assert.equal(context.tz,'UTC'); assert.equal(context.isolation,'repeatable read');
  assert.equal((await c.query('SELECT public.stocktake_adjustment_guards() ok')).rows[0].ok,true);
  const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows; assert.equal(tables.length,464);
  const rows:StocktakeAdjustmentCapture['rows']={},fingerprints:StocktakeAdjustmentCapture['fingerprints']={};
  for(const {tablename} of tables) { rows[tablename]=(await c.query(`SELECT to_jsonb(x) row FROM public.${idName(tablename)} x ORDER BY 1`)).rows; fingerprints[tablename]={count:rows[tablename].length,sha256:hash(JSON.stringify(rows[tablename]))}; }
  assert(rows.sessions); assert.equal(one(rows.migrations.filter(x=>x.row.name===SCHEMA).map(x=>x.row)).name,SCHEMA);
  const proof_hashes=(await c.query(`SELECT id::text preview_id,scope_hash=public.stocktake_adjustment_hash(frame) scope_hash_matches,
    frame->>'rows_sha256'=public.stocktake_adjustment_hash(frame->'rows') rows_hash_matches FROM public.stocktake_adjustment_previews ORDER BY id`)).rows;
  return {rows,fingerprints,portable_metadata:await captureReturnDestinationRestoreMetadata(c),proof_hashes};
}
function setupActor(a:Row) {
  for(const key of ['tenant_id','user_id']) assert(uuid(a[key])); assert(uuid(a.warehouse.id)); assert(uuid(a.stocktake.id));
  assert.equal(a.status,'READY_FOR_NATIVE_SERIES_PREVIEW_AND_CONSENT'); assert.equal(a.products.length,3); assert.equal(new Set(a.products.map((p:Row)=>p.id)).size,3);
  assert.deepEqual(a.products.map((p:Row)=>p.cost),['0','1000',null]); assert.equal(a.count_basis.length,6); assert.equal(a.measured.length,6);
  assert.equal(new Set(a.count_basis.map((x:Row)=>x.id)).size,6); assert.equal(a.adjustment_source.stocktake_id,a.stocktake.id);
  assert.equal(a.adjustment_source.source_kind,a.on?'wms':'quantity'); assert.equal(a.adjustment_source.state,'review'); assert.equal(a.adjustment_source.can_preview,true);
  assert.equal(a.adjustment_source.line_count,6); assert.equal(a.adjustment_source.row_count,6); assert.equal(a.adjustment_source.summary.pw_quantity,'3'); assert.equal(a.adjustment_source.summary.rw_quantity,'3');
  for(const p of a.products) for(const location of ['A-01','B-02']) { const line=one(a.count_basis.filter((x:Row)=>x.product_id===p.id&&x.location===location)); assert.equal(line.current_quantity,2); const measured=one(a.measured.filter((x:Row)=>x.id===line.id)); assert.equal(measured.quantity,location==='A-01'?1:3); }
}
function fresh(cap:StocktakeAdjustmentCapture,a:Row) {
  setupActor(a); for(const name of TABLES) assert.equal(own(cap,a,name).length,0,'No pre-Chrome149 own rows');
  const head=one(own(cap,a,a.on?'wms_stocktakes':'stocktakes')); assert.equal(head.id,a.stocktake.id); assert.equal(head.state,'review'); assert.equal(String(head.version),a.adjustment_source.version);
  const lines=own(cap,a,a.on?'wms_stocktake_lines':'stocktake_lines'); assert.equal(lines.length,6);
  for(const line of lines) assert.equal(line.counted,line.location==='A-01'?1:3);
  if(a.on) { const review=one(own(cap,a,'wms_stocktake_reviews')); assert.equal(review.id,a.review.id); assert.equal(review.scope_hash,a.review.scope_hash); assert.equal(String(review.stocktake_version),a.adjustment_source.version); assert.equal(own(cap,a,'wms_stocktake_postings').length,0); }
  for(const p of a.products) { const stock=one(own(cap,a,'stock').filter(x=>x.product_id===p.id)); assert.equal(stock.on_hand,4); assert.equal(stock.reserved,0); for(const location of ['A-01','B-02'])assert.equal(one(own(cap,a,'stock_locations').filter(x=>x.product_id===p.id&&x.location===location)).quantity,2); }
}

function migrationBasis(basis:Row,cap:StocktakeAdjustmentCapture,actors:Row[],revision:string,configSha:string) {
  assert.equal(basis.stage,164);assert.equal(basis.phase,'after');assert.equal(basis.status,'EXACT_ADDITIVE_MIGRATION_VERIFIED');
  assert.equal(basis.schema_revision,SCHEMA);assert.equal(basis.revision,revision);assert.equal(basis.config_sha256,configSha);assert.equal(basis.sessions_included,true);
  const old=basis.capture.rows as Record<string,Wrapped[]>;assert.equal(Object.keys(old).length,464);assert.deepEqual(Object.keys(old),Object.keys(cap.rows));assert.deepEqual(basis.capture.metadata,cap.portable_metadata);
  assert.equal(new Set(actors.map(a=>a.user_id)).size,2);
  for(const a of actors){assert(!old.tenants.some(x=>x.row.id===a.tenant_id));assert(!old.users.some(x=>x.row.id===a.user_id));}
  const counts:Record<string,number>={};
  for(const [name,previous] of Object.entries(old)) {
    // Multiset subtraction preserves every old row literally, including tables
    // without an id. Neither changed old rows nor new unrelated rows are exempt.
    const remaining=new Map<string,number>();for(const x of cap.rows[name]){const key=JSON.stringify(x);remaining.set(key,(remaining.get(key)??0)+1);}
    for(const x of previous){const key=JSON.stringify(x),count=remaining.get(key)??0;assert(count>0,'Original migration row retained: '+name);remaining.set(key,count-1);}
    let added=0;
    for(const [key,count] of remaining){if(!count)continue;const x=(JSON.parse(key) as Wrapped).row;
      const actor=actors.find(a=>name==='tenants'?x.id===a.tenant_id:name==='users'?x.id===a.user_id:x.tenant_id===a.tenant_id||(name==='account_security'&&x.user_id===a.user_id));
      assert(actor,'No unrelated new rows: '+name);if(Object.hasOwn(x,'tenant_id'))assert.equal(x.tenant_id,actor.tenant_id);
      for(const field of ['user_id','actor_id'])if(x[field]!==null&&x[field]!==undefined)assert.equal(x[field],actor.user_id);
      added+=count;
    }
    if(added)counts[name]=added;
  }
  assert.equal(counts.tenants,2);assert.equal(counts.users,2);
  for(const a of actors){assert.equal(own(cap,a,'tenants').length,1);assert.equal(own(cap,a,'users').length,1);}
  return {original_tables:464,original_rows_exact:true,only_two_new_setup_actors:true,added_rows:counts};
}

/** Pure identity/provenance validator. No queries, writes or principal guesses.
 * Checks the actual full private graph, not merely displayed PW/RW totals.
 */
export function validateStocktakeAdjustmentReceipt(cap:StocktakeAdjustmentCapture,a:Row,id:string) {
  setupActor(a); assert(uuid(id));
  const r=one(own(cap,a,'stocktake_adjustment_receipts')); assert.equal(r.id,id); assert.equal(r.actor_id,a.user_id); assert.equal(r.api_key_id,null);
  const p=one(own(cap,a,'stocktake_adjustment_previews')); assert.equal(p.id,r.preview_id); assert.equal(p.actor_id,a.user_id); assert.equal(p.api_key_id,null);
  assert.equal(p.request.source_kind,a.on?'wms':'quantity'); assert.equal(p.request.stocktake_id,a.stocktake.id); assert.equal(p.request.version,a.adjustment_source.version);
  assert.equal(p.source_kind,r.source_kind); assert.equal(r.source_kind,p.request.source_kind); assert.equal(p.frame.source.stocktake_id,a.stocktake.id); assert.equal(p.frame.source.version,a.adjustment_source.version);
  assert.deepEqual(p.frame.source,a.adjustment_source); assert.equal(p.frame.row_count,6); assert.equal(p.frame.rows.length,6);
  assert(uuid(p.frame.nonce)); assert.notEqual(p.frame.nonce,p.id); assert.equal(one(cap.proof_hashes.filter(x=>x.preview_id===p.id)).scope_hash_matches,true); assert.equal(one(cap.proof_hashes.filter(x=>x.preview_id===p.id)).rows_hash_matches,true);
  assert.equal(r.request.client_key,r.client_key); assert.equal(r.request.scope_hash,p.scope_hash); assert.equal(r.request.confirmed,true); assert(uuid(r.client_key));
  const adm=one(own(cap,a,'stocktake_adjustment_admissions')); assert.equal(adm.id,r.id); assert.equal(adm.preview_id,p.id); assert.equal(adm.actor_id,a.user_id); assert.equal(adm.api_key_id,null); assert.equal(adm.client_key,r.client_key); assert.deepEqual(adm.request,r.request); assert.equal(adm.sealed,true);
  const source=one(own(cap,a,a.on?'wms_stocktakes':'stocktakes')); assert.equal(source.id,a.stocktake.id); assert.equal(source.state,'posted'); assert.equal(String(source.version),String(inc(a.adjustment_source.version))); assert.equal(r.source_version,source.version);
  assert.equal(r.quantity_stocktake_id,a.on?null:a.stocktake.id); assert.equal(r.wms_stocktake_id,a.on?a.stocktake.id:null);
  const series=own(cap,a,'stocktake_adjustment_series'),commands=own(cap,a,'stocktake_adjustment_series_commands'),docs=own(cap,a,'stocktake_adjustment_documents'),counters=own(cap,a,'stocktake_adjustment_counters');
  assert.equal(series.length,2); assert.equal(commands.length,2); assert.equal(docs.length,2); assert.equal(counters.length,2); assert.equal(adm.counter_before.length,2); assert.equal(adm.counter_after.length,2);
  const previewRows=own(cap,a,'stocktake_adjustment_preview_rows').sort((x,y)=>x.ordinal-y.ordinal),rows=own(cap,a,'stocktake_adjustment_document_rows'); assert.equal(previewRows.length,6); assert.equal(rows.length,6);
  assert.deepEqual(previewRows.map(x=>x.payload),p.frame.rows); const movements:Row[]=[]; const layerMovements:Row[]=[]; const layers:Row[]=[]; const positions:Row[]=[];
  const op=a.on?one(own(cap,a,'wms_operations').filter(x=>x.id===r.operation_id)):null;
  if(a.on) {
    const post=one(own(cap,a,'wms_stocktake_postings')); assert.equal(post.id,r.posting_id); assert.equal(post.id,source.posting_id); assert.equal(post.operation_id,op!.id); assert.equal(post.stocktake_id,a.stocktake.id); assert.equal(post.review_id,a.review.id); assert.equal(post.actor_id,a.user_id); assert.equal(post.client_key,r.client_key);
    assert.deepEqual(post.request,{client_key:r.client_key,version:a.adjustment_source.version,review_id:a.review.id,scope_hash:a.review.scope_hash,confirmed:true});
    assert.equal(op!.actor_id,a.user_id); assert.equal(op!.client_key,r.client_key); assert.equal(op!.kind,'stocktake_post'); assert.equal(op!.source,'manual'); assert.equal(op!.stocktake_id,a.stocktake.id); assert.equal(op!.stocktake_posting_id,post.id); assert.equal(op!.stocktake_review_id,a.review.id); assert.equal(String(op!.policy_version),'1');
    for(const key of ['order_id','warehouse_document_id','purchase_receipt_id','return_id'])assert.equal(op![key],null);
    assert.deepEqual(op!.request,{stocktake_id:a.stocktake.id,posting_id:post.id,review_id:a.review.id,body:post.request}); assert.equal(op!.result.rows.length,6); assert.equal(op!.result.changed,6);
    assert.deepEqual(op!.result.summary,{currency:'PLN',known_delta_minor:'1000',unknown_delta_quantity:'-1',incoming_quantity:'3',outgoing_quantity:'3'});
  } else { assert.equal(r.posting_id,null); assert.equal(r.operation_id,null); assert.equal(source.posted_by,a.user_id); tick(source.posted_at); }
  for(const kind of ['PW','RW']) {
    const d=one(docs.filter(x=>x.kind===kind)),s=one(series.filter(x=>x.id===d.series_id)),command=one(commands.filter(x=>x.series_id===s.id));
    assert.equal(d.receipt_id,r.id); assert.equal(d.warehouse_id,a.warehouse.id); assert.equal(s.kind,kind); assert.equal(s.version,1); assert.equal(command.actor_id,a.user_id); assert.equal(command.api_key_id,null); assert.deepEqual(command.request,{client_key:command.client_key,kind,name:s.name,prefix:s.prefix});
    assert.deepEqual(p.frame.series[kind],{...omit(s,['tenant_id']),version:'1'});
    assert.equal(p.frame.series[kind].version,'1');
    const counter=one(counters.filter(x=>x.series_id===s.id)); assert.equal(counter.year,p.frame.year); assert.equal(counter.sequence,1); assert.equal(d.year,p.frame.year); assert.equal(d.sequence,1); assert.equal(d.number,`${s.prefix}/${d.year}/000001`); assert.equal(d.row_count,3);
    const before=one(adm.counter_before.filter((x:Row)=>x.series_id===s.id)); assert.equal(before.sequence,0); assert.deepEqual(counter,one(adm.counter_after.filter((x:Row)=>x.series_id===s.id))); assert.deepEqual(omit(counter,['sequence']),omit(before,['sequence']));
    const selected=rows.filter(x=>x.document_id===d.id).sort((x,y)=>x.ordinal-y.ordinal); assert.equal(selected.length,3);
    const summary:Row={pw_quantity:kind==='PW'?'3':'0',rw_quantity:kind==='RW'?'3':'0'};
    if(a.on)Object.assign(summary,{currency:'PLN',exponent:2,known_pw_minor:kind==='PW'?'2000':'0',known_rw_minor:kind==='RW'?'1000':'0',unknown_pw_quantity:'0',unknown_rw_quantity:kind==='RW'?'1':'0'});
    assert.deepEqual(d.summary,summary);
    for(const [ordinal,row] of selected.entries()) {
      assert.equal(row.ordinal,ordinal); assert.equal(row.preview_id,p.id); assert.equal(row.payload.ordinal,ordinal); assert.equal(row.payload.source_ordinal,row.source_ordinal); assert.equal(row.stock_movement_id,null); assert.equal(row.payload.stock_movement_id,null);
      const v=one(previewRows.filter(x=>x.ordinal===row.source_ordinal)); assert.equal(v.preview_id,p.id); const expected=v.payload; assert.equal(expected.kind,kind); assert.equal(expected.quantity,1); assert.equal(expected.delta,kind==='PW'?1:-1); assert.equal(expected.warehouse_id,a.warehouse.id); assert.equal(expected.location,kind==='PW'?'B-02':'A-01');
      const product=one(a.products.filter((x:Row)=>x.id===expected.product_id)),original=one(a.count_basis.filter((x:Row)=>x.id===expected.line_id)); assert.equal(original.product_id,product.id); assert.equal(original.location,expected.location);
      assert.deepEqual(omit(row.payload,['ordinal','source_ordinal','movement_id','stock_movement_id','lot_id','layer_id']),omit(expected,['ordinal','lot_id','layer_id']));
      const bin=one(own(cap,a,'stock_location_movements').filter(x=>a.on?x.operation_id===op!.id&&x.product_id===product.id&&x.location===expected.location:x.id===row.quantity_movement_id));
      assert.equal(bin.warehouse_id,a.warehouse.id); assert.equal(bin.product_id,product.id); assert.equal(bin.location,expected.location); assert.equal(bin.delta,expected.delta); assert.equal(bin.order_id,null); assert.equal(bin.kind,a.on?'wms_stocktake':'stocktake'); assert.equal(bin.operation_id,a.on?op!.id:a.stocktake.id); assert.equal(bin.stocktake_id,a.on?null:a.stocktake.id); assert.equal(bin.note,a.on?'Inwentaryzacja WMS '+a.stocktake.id:source.name); movements.push(bin);
      if(!a.on) { assert.equal(row.wms_movement_id,null); assert.equal(row.payload.movement_id,bin.id); assert.equal(row.payload.lot_id,null); assert.equal(row.payload.layer_id,null); }
      else {
        assert.equal(row.quantity_movement_id,null); const m=one(own(cap,a,'wms_layer_movements').filter(x=>x.id===row.wms_movement_id)),l=one(own(cap,a,'wms_cost_layers').filter(x=>x.id===m.layer_id)); assert.equal(row.payload.movement_id,m.id); assert.equal(row.payload.layer_id,l.id); assert.equal(row.payload.lot_id,l.lot_id);
        assert.equal(m.operation_id,op!.id); assert.equal(m.kind,'stocktake'); assert.equal(m.product_id,product.id); assert.equal(m.warehouse_id,a.warehouse.id); assert.equal(m.location,expected.location); assert.equal(m.delta,expected.delta); assert.equal(l.product_id,product.id); assert.equal(l.currency,'PLN'); assert.equal(l.exponent,2);
        const cost=kind==='PW'?(product.cost??'1000'):product.cost; assert.equal(expected.unit_cost_minor,cost); assert.equal(expected.value_minor,cost); assert.equal(l.unit_cost_minor===null?null:String(l.unit_cost_minor),cost); assert.equal(m.value_delta===null?null:String(m.value_delta),cost===null?null:String(BigInt(cost)*BigInt(expected.delta)));
        const position=one(own(cap,a,'wms_layer_positions').filter(x=>x.layer_id===l.id&&x.warehouse_id===a.warehouse.id&&x.location===expected.location)); assert.equal(position.quantity,1); assert.equal(position.reserved,0);
        const actual=one(op!.result.rows.filter((x:Row)=>x.line_id===expected.line_id)); assert.equal(actual.fragments.length,1); assert.equal(actual.fragments[0].id,m.id); assert.equal(actual.fragments[0].layer_id,l.id); assert.equal(actual.delta,expected.delta);
        if(kind==='RW')assert.equal(l.id,expected.layer_id); else { assert.equal(expected.layer_id,null); assert.equal(l.operation_id,op!.id); assert.equal(l.quantity_received,1); assert.equal(l.stocktake_line_id,expected.line_id); assert.equal(l.warehouse_document_id,null); assert.equal(l.purchase_receipt_id,null); layers.push(l); positions.push(position); }
        layerMovements.push(m);
      }
    }
  }
  assert.equal(new Set(movements.map(x=>x.id)).size,6); assert.equal(new Set(rows.map(x=>x.source_ordinal)).size,6);
  const summary:Row={pw_quantity:'3',rw_quantity:'3'}; if(a.on)Object.assign(summary,{currency:'PLN',exponent:2,known_pw_minor:'2000',known_rw_minor:'1000',unknown_pw_quantity:'0',unknown_rw_quantity:'1'}); assert.deepEqual(p.frame.summary,summary);
  const begin=tick(p.created_at),end=tick(docs.reduce((last,x)=>tick(x.created_at)>tick(last)?x.created_at:last,r.created_at)); assert(begin<=tick(r.created_at)); for(const m of movements)assert(tick(m.created_at)<=tick(r.created_at)); assert(end>=tick(r.created_at));
  return {receipt_id:r.id,preview_id:p.id,stocktake_id:a.stocktake.id,source_kind:r.source_kind,version:String(source.version),posting_id:r.posting_id,operation_id:r.operation_id,document_ids:docs.map(x=>x.id).sort(),document_numbers:docs.map(x=>x.number).sort(),summary,
    receipt:r,preview:p,admission:adm,documents:docs,series,commands,counters,preview_rows:previewRows,document_rows:rows,source,movements,layer_movements:layerMovements,new_layers:layers,new_positions:positions,operation:op};
}

function sessionDelta(before:StocktakeAdjustmentCapture,now:StocktakeAdjustmentCapture,a:Row,expected:Row) {
  assert.deepEqual(Object.keys(expected).sort(),['added','removed']); const old=own(before,a,'sessions'),current=own(now,a,'sessions'); assert(old.length>0);
  for(const key of ['added','removed']) { assert(Array.isArray(expected[key])&&expected[key].length<=4); assert.equal(new Set(expected[key]).size,expected[key].length); for(const v of expected[key])assert.match(v,/^[a-f0-9]{64}$/); }
  const added=current.filter(x=>!old.some(y=>y.token_hash===x.token_hash)),removed=old.filter(x=>!current.some(y=>y.token_hash===x.token_hash));
  assert.deepEqual(added.map(x=>x.token_hash).sort(),[...expected.added].sort()); assert.deepEqual(removed.map(x=>x.token_hash).sort(),[...expected.removed].sort());
  for(const x of current) { assert.equal(x.user_id,a.user_id); assert.equal(x.tenant_id,a.tenant_id); const prior=old.find(y=>y.token_hash===x.token_hash); if(prior)assert.deepEqual(x,prior); tick(x.expires_at); }
  assert(current.length>0);return {added:added.length,removed:removed.length,retained:current.length-added.length};
}
function compareOwn(before:StocktakeAdjustmentCapture,now:StocktakeAdjustmentCapture,a:Row,g:ReturnType<typeof validateStocktakeAdjustmentReceipt>) {
  const append:Record<string,Row[]>={stocktake_adjustment_series:g.series,stocktake_adjustment_series_commands:g.commands,stocktake_adjustment_counters:g.counters,
    stocktake_adjustment_previews:[g.preview],stocktake_adjustment_preview_rows:g.preview_rows,stocktake_adjustment_admissions:[g.admission],stocktake_adjustment_receipts:[g.receipt],stocktake_adjustment_documents:g.documents,stocktake_adjustment_document_rows:g.document_rows,
    stock_location_movements:g.movements};
  const mutable=new Set(['stock','stock_locations',a.on?'wms_stocktakes':'stocktakes']);
  if(a.on) {
    append.wms_stocktake_postings=[one(own(now,a,'wms_stocktake_postings'))];append.wms_operations=[g.operation!];append.wms_layer_movements=g.layer_movements;append.wms_cost_layers=g.new_layers;
    // Existing lot selected by every counted line: surplus creates new layers,
    // not a new lot. A different fixture requires a separately reviewed proof.
    assert.equal(g.new_layers.length,3);assert.deepEqual(own(now,a,'wms_lots'),own(before,a,'wms_lots'));
    mutable.add('wms_layer_positions');
  }
  const audits=own(now,a,'audit_events').filter(x=>!own(before,a,'audit_events').some(y=>y.id===x.id)); assert.equal(audits.length,4);
  for(const s of g.series) {const audit=one(audits.filter(x=>x.entity_id===s.id));assert.equal(audit.action,'stocktake.adjustment.series');assert.deepEqual(audit.detail,{});assert.equal(audit.user_id,a.user_id);}
  const core=one(audits.filter(x=>x.entity_id===a.stocktake.id));assert.equal(core.action,a.on?'wms.stocktake.post':'stocktake.post');assert.equal(core.user_id,a.user_id);assert.deepEqual(core.detail,a.on?{posting_id:g.posting_id,operation_id:g.operation_id}:{});
  const posted=one(audits.filter(x=>x.entity_id===g.receipt_id));assert.equal(posted.action,'stocktake.adjustment.post');assert.equal(posted.user_id,a.user_id);assert.deepEqual(posted.detail,{preview_id:g.preview_id});append.audit_events=audits;
  const markers=own(now,a,'purchasing_stock_changes').filter(x=>!own(before,a,'purchasing_stock_changes').some(y=>String(y.id)===String(x.id)));assert.equal(markers.length,1);
  const oldMax=own(before,a,'purchasing_stock_changes').reduce((max,x)=>BigInt(x.id)>max?BigInt(x.id):max,0n);assert(BigInt(markers[0].id)>oldMax);assert.deepEqual(Object.keys(markers[0]).sort(),['id','tenant_id']);append.purchasing_stock_changes=markers;
  for(const n of Object.keys(before.rows)) {
    if(n==='sessions'||mutable.has(n))continue;
    assert.deepEqual(sorted(own(now,a,n)),sorted([...own(before,a,n),...(append[n]??[])]),'Exact own retained rows and literal additions: '+n);
  }
  const oldHead=one(own(before,a,a.on?'wms_stocktakes':'stocktakes')); assert.deepEqual(g.preview.frame.head,oldHead); assert.deepEqual(omit(g.source,a.on?['state','version','posting_id']:['state','version','posted_by','posted_at']),omit(oldHead,a.on?['state','version','posting_id']:['state','version','posted_by','posted_at']));
  const stock=own(before,a,'stock');assert.equal(stock.length,3);assert.deepEqual(sorted(own(now,a,'stock')),sorted(stock.map(x=>({...x,version:inc(x.version)}))));
  const bins=own(before,a,'stock_locations');assert.equal(bins.length,6);assert.deepEqual(sorted(own(now,a,'stock_locations')),sorted(bins.map(x=>({...x,quantity:x.location==='A-01'?1:3}))));
  if(a.on) {
    const old=own(before,a,'wms_layer_positions');assert.equal(old.length,6);
    const expected=old.map(x=>g.layer_movements.some(m=>m.layer_id===x.layer_id&&m.location===x.location&&m.delta===-1)?{...x,quantity:x.quantity-1,version:inc(x.version)}:x);
    for(const x of g.new_positions){assert.equal(x.version,1);assert.equal(x.quantity,1);assert.equal(x.reserved,0);}
    assert.deepEqual(sorted(own(now,a,'wms_layer_positions')),sorted([...expected,...g.new_positions]));
    for(const m of g.layer_movements.filter(x=>x.delta===-1)){const original=one(own(before,a,'wms_cost_layers').filter(x=>x.id===m.layer_id));assert.deepEqual(one(own(now,a,'wms_cost_layers').filter(x=>x.id===m.layer_id)),original);}
  }
}
let step='preflight',gets=0,client:pg.Client|undefined;
async function fixedDir(p:string){const s=await lstat(p);assert(s.isDirectory()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);}
async function privateRead(p:string,max=512*1024*1024){const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.mode&0o777,0o600);assert(s.size>0&&s.size<=max);const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stable=(x:typeof s)=>{for(const k of ['ino','dev','size','mode','mtimeMs'] as const)assert.equal(x[k],s[k]);};stable(await f.stat());const b=await f.readFile();stable(await f.stat());stable(await lstat(p));assert.equal(b.length,s.size);return b;}finally{await f.close();}}
async function absent(p:string){try{await lstat(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Exclusive evidence exists');}
async function wx(p:string,v:unknown,mode:number){await fixedDir(dirname(p));const b=JSON.stringify(v,null,2)+'\n';assert(Buffer.byteLength(b)<=512*1024*1024);const f=await open(p,'wx',mode);try{await f.writeFile(b);await f.sync();}finally{await f.close();}const d=await open(dirname(p),'r');try{await d.sync();}finally{await d.close();}return hash(b);}
async function get(a:Row|null,path:string){assert(path==='/health'||path==='/auth/me'||path==='/stocktake-adjustments/options'||/^\/stocktake-adjustments\/(receipts\/[a-f0-9-]{36}|previews\/[a-f0-9-]{36}(\/rows\?limit=100)?|documents\/[a-f0-9-]{36}(\/rows\?limit=100)?|sources\/(quantity|wms)\/[a-f0-9-]{36}|documents\?source_kind=(quantity|wms)&stocktake_id=[a-f0-9-]{36}&limit=50)$/.test(path));gets++;const r=await fetch('http://127.0.0.1:4100/api'+path,{method:'GET',headers:a?{cookie:a.cookie,'X-Workspace-ID':a.tenant_id}:{},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);const b=Buffer.from(await r.arrayBuffer());assert(b.length<=8*1024*1024);return JSON.parse(b.toString('utf8')) as Row;}
async function health(rev:string){const h=await get(null,'/health');assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,rev);assert.equal(h.schema_revision,SCHEMA);assert.equal(h.restore_preview,false);assert.equal(h.background_workers_enabled,false);assert.equal(h.stocktake_adjustments_available,true);}
async function captureNative(){await client!.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client!.query("SET LOCAL TimeZone='UTC'");try{assert.deepEqual((await client!.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],{db:'dynaminds',role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432,readonly:'on'});const result=await captureStocktakeAdjustmentReadback(client!);await client!.query('COMMIT');return result;}catch(e){await client!.query('ROLLBACK').catch(()=>undefined);throw e;}}
function publicRows(rows:Row[]){return rows.map(x=>omit(x,['_exponent']));}
async function identity(a:Row){const me=await get(a,'/auth/me');assert.equal(me.user.id,a.user_id);assert.equal(me.user.tenant_id,a.tenant_id);assert.equal(me.user.role,'admin');const o=await get(a,'/stocktake-adjustments/options');assert.equal(o.available,true);assert.equal(o.read_only,false);assert.equal(o.can_read,true);assert.equal(o.can_write,true);assert.equal(o.can_read_value,true);return o;}
async function apiProof(a:Row,g:ReturnType<typeof validateStocktakeAdjustmentReceipt>){await identity(a);const prefix='/stocktake-adjustments';const r=await get(a,prefix+'/receipts/'+g.receipt_id),p=await get(a,prefix+'/previews/'+g.preview_id),pr=await get(a,prefix+'/previews/'+g.preview_id+'/rows?limit=100');
  assert.equal(r.receipt.id,g.receipt_id);assert.equal(r.receipt.preview_id,g.preview_id);assert.equal(r.receipt.scope_hash,g.preview.scope_hash);assert.deepEqual(r.receipt.request,g.receipt.request);assert.equal(r.receipt.source.state,'posted');assert.equal(r.receipt.source.version,g.version);assert.equal(r.receipt.source.posting_id,g.posting_id);assert.equal(r.receipt.source.operation_id,g.operation_id);assert.equal(p.preview.receipt_id,g.receipt_id);assert.equal(p.preview.can_post,false);assert.deepEqual(r.receipt.snapshot,p.preview.snapshot);assert.deepEqual(p.preview.snapshot.summary,g.summary);assert.deepEqual(p.preview.snapshot.source,g.preview.frame.source);assert.equal(p.preview.snapshot.rows_sha256,g.preview.frame.rows_sha256);assert.deepEqual(pr.meta,{cursor:null,total:6});assert.deepEqual(pr.data,publicRows(g.preview_rows.map(x=>x.payload)));
  const history=await get(a,`${prefix}/documents?source_kind=${a.on?'wms':'quantity'}&stocktake_id=${a.stocktake.id}&limit=50`);assert.equal(history.meta.cursor,null);assert.deepEqual(history.data.map((x:Row)=>x.id).sort(),g.document_ids);assert.deepEqual(r.documents,r.receipt.documents);
  for(const d of g.documents){const view=await get(a,prefix+'/documents/'+d.id),rows=await get(a,prefix+'/documents/'+d.id+'/rows?limit=100');assert.equal(view.document.receipt_id,g.receipt_id);assert.equal(view.document.number,d.number);assert.equal(view.document.sequence,String(d.sequence));assert.equal(view.document.row_count,3);assert.deepEqual(view.document.summary,d.summary);assert.deepEqual(view.document,one(r.documents.filter((x:Row)=>x.id===d.id)));assert.deepEqual(rows.meta,{cursor:null,total:3});assert.deepEqual(rows.data,publicRows(g.document_rows.filter(x=>x.document_id===d.id).sort((x,y)=>x.ordinal-y.ordinal).map(x=>x.payload)));}
  return {receipt_id:g.receipt_id,preview_id:g.preview_id,document_ids:g.document_ids,source:g.source_kind,stocktake_id:g.stocktake_id,summary:g.summary,core_operation_id:g.operation_id};}
async function main(){
  const mode=process.argv[2],revision=process.env.QA_EXPECTED_REVISION??'',configPath=resolve(ROOT,'.local.json'),setupPath=resolve(ROOT,'data/stocktake-adjustments-native164-setup.json'),beforePath=resolve(ROOT,'data/stocktake-adjustments-native164-readback-capture-before-post.json');
  assert(['capture-before-post','after-post'].includes(mode??''));assert.equal(await realpath(process.cwd()),ROOT);assert.equal(process.cwd(),ROOT);assert.equal(process.env.QA164_READBACK_CONFIRM,'READ_ONLY_OWN_STOCKTAKE_ADJUSTMENTS_164');assert.equal(process.env.APP_REVISION,revision);assert.match(revision,/^[a-f0-9]{40}$/);assert.equal(process.env.DYNA_WORKER_DISABLED,'true');assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,configPath);for(const k of ['DYNA_TEST','DATABASE_URL','DYNA_PREVIEW_PORT'])assert.equal(process.env[k],undefined);
  for(const k of ['QA164_CONFIG_SHA256','QA164_SETUP_SHA256'])assert.match(process.env[k]??'',/^[a-f0-9]{64}$/);await fixedDir(ROOT);await fixedDir(resolve(ROOT,'data'));await fixedDir(resolve(ROOT,'docs'));
  const privateOutput=resolve(ROOT,`data/stocktake-adjustments-native164-readback-${mode}.json`),publicOutput=resolve(ROOT,`docs/stocktake-adjustments-native164-readback-${mode}.json`);await absent(privateOutput);await absent(publicOutput);
  const migrationPath=resolve(ROOT,'data/stocktake-adjustments-native164-preservation-after.json');let migrationBytes:Buffer|null=null,migration:Row|null=null;
  if(process.env.QA164_MIGRATION_AFTER_SHA256!==undefined){assert.match(process.env.QA164_MIGRATION_AFTER_SHA256,/^[a-f0-9]{64}$/);migrationBytes=await privateRead(migrationPath);assert.equal(hash(migrationBytes),process.env.QA164_MIGRATION_AFTER_SHA256);migration=JSON.parse(migrationBytes.toString('utf8'));}
  const configBytes=await privateRead(configPath,65536),setupBytes=await privateRead(setupPath,32*1024*1024);assert.equal(hash(configBytes),process.env.QA164_CONFIG_SHA256);assert.equal(hash(setupBytes),process.env.QA164_SETUP_SHA256);const config=JSON.parse(configBytes.toString('utf8')) as Row,setup=JSON.parse(setupBytes.toString('utf8')) as Row;
  assert.equal(typeof config.dbPassword,'string');assert(config.dbPassword.length>0);assert.equal(setup.stage,164);assert.equal(setup.schema,SCHEMA);assert.equal(setup.runtime_revision,revision);assert.equal(setup.status,'READY_FOR_NATIVE_CHROME_NOT_POSTED');assert.equal(setup.pending,null);assert.equal(setup.actors.length,2);const actors:Row[]=setup.actors;assert.deepEqual(actors.map(a=>a.label),['OFF','ON']);assert.equal(actors[0].on,false);assert.equal(actors[1].on,true);assert.equal(new Set(actors.map(a=>a.tenant_id)).size,2);
  for(const a of actors){setupActor(a);assert.match(a.cookie,/^dyna_session=[A-Za-z0-9_.-]+$/);const done=setup.completed.filter((x:Row)=>x.actor===a.label);assert(done.length>0);assert.equal(new Set(done.map((x:Row)=>x.label)).size,done.length);for(const x of done){assert.equal(x.response.status,x.expected_status);assert.equal(hash(JSON.stringify(x.response.data)),x.response_sha256);}}
  let before:Row|null=null,beforeBytes:Buffer|null=null;const receiptIds:Row={off:null,on:null};if(mode==='after-post'){assert.match(process.env.QA164_READBACK_BEFORE_SHA256??'',/^[a-f0-9]{64}$/);beforeBytes=await privateRead(beforePath);assert.equal(hash(beforeBytes),process.env.QA164_READBACK_BEFORE_SHA256);before=JSON.parse(beforeBytes.toString('utf8'));assert.equal(before!.status,'READ_ONLY_BASELINE_CAPTURED');assert.equal(before!.stage,164);assert.equal(before!.mode,'capture-before-post');assert.equal(before!.schema,SCHEMA);assert.equal(before!.runtime_revision,revision);assert.equal(before!.setup_sha256,hash(setupBytes));assert.equal(before!.config_sha256,hash(configBytes));assert.deepEqual(before!.actors,actors);for(const key of ['off','on']){receiptIds[key]=process.env[key==='off'?'QA164_OFF_RECEIPT_ID':'QA164_ON_RECEIPT_ID'];assert(uuid(receiptIds[key]));}assert.notEqual(receiptIds.off,receiptIds.on);}
  await health(revision);client=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:config.dbPassword,database:'dynaminds',connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c TimeZone=UTC'});client.on('error',()=>{});await client.connect();step='capture';const cap=await captureNative();const proof:Row={off:null,on:null},apiProofs:Row={off:null,on:null},auth:Row={};
  const migrationProof=migration?migrationBasis(migration,cap,actors,revision,hash(configBytes)):null;
  if(mode==='capture-before-post')for(const a of actors){fresh(cap,a);await identity(a);}
  else {
    const base=before!.capture as StocktakeAdjustmentCapture;assert.deepEqual(Object.keys(cap.rows),Object.keys(base.rows));assert.deepEqual(cap.portable_metadata,base.portable_metadata);
    const delta=process.env.QA164_SESSION_DELTA_JSON?JSON.parse(process.env.QA164_SESSION_DELTA_JSON):{off:{added:[],removed:[]},on:{added:[],removed:[]}};assert.deepEqual(Object.keys(delta).sort(),['off','on']);
    for(const n of Object.keys(base.rows)){const protectedRows=(v:StocktakeAdjustmentCapture)=>v.rows[n].filter(({row})=>!actors.some(a=>row.tenant_id===a.tenant_id||(n==='tenants'&&row.id===a.tenant_id)||(n==='users'&&row.id===a.user_id)));assert.deepEqual(protectedRows(cap),protectedRows(base),'All non-QA rows incl sessions unchanged: '+n);}
    for(const a of actors){const label=a.on?'on':'off';step=label+':graph';fresh(base,a);const g=validateStocktakeAdjustmentReceipt(cap,a,receiptIds[label]);compareOwn(base,cap,a,g);auth[label]=sessionDelta(base,cap,a,delta[label]);proof[label]=g;apiProofs[label]=await apiProof(a,g);}
  }
  step='final-purity';assert.deepEqual(await captureNative(),cap,'All GETs retain all rows/sessions/metadata');await health(revision);assert.equal(hash(await privateRead(configPath,65536)),hash(configBytes));assert.equal(hash(await privateRead(setupPath,32*1024*1024)),hash(setupBytes));if(beforeBytes)assert.equal(hash(await privateRead(beforePath)),hash(beforeBytes));if(migrationBytes)assert.equal(hash(await privateRead(migrationPath)),hash(migrationBytes));
  const status=mode==='capture-before-post'?'READ_ONLY_BASELINE_CAPTURED':'STOCKTAKE_ADJUSTMENTS_NATIVE_READBACK_PASS';const checkpoint={stage:164,mode,status,runtime_revision:revision,schema:SCHEMA,config_sha256:hash(configBytes),setup_sha256:hash(setupBytes),migration_after_sha256:migrationBytes?hash(migrationBytes):null,migration_basis_proof:migrationProof,before_sha256:beforeBytes?hash(beforeBytes):null,receipt_ids:receiptIds,actors,capture:cap,proof,api_proof:apiProofs,own_auth_session_deltas:auth,sessions_included:true,created_at:new Date().toISOString()};const checkpointSha=await wx(privateOutput,checkpoint,0o600);
  const publicProof=Object.fromEntries(Object.entries(proof).map(([label,g])=>[label,g?{receipt_id:g.receipt_id,preview_id:g.preview_id,stocktake_id:g.stocktake_id,source_kind:g.source_kind,document_ids:g.document_ids,fragment_count:6,pw_quantity:'3',rw_quantity:'3',net_quantity:'0'}:null]));
  const report={stage:164,mode,status,runtime_revision:revision,schema:SCHEMA,setup_sha256:hash(setupBytes),migration_after_sha256:checkpoint.migration_after_sha256,migration_original_rows_exact:migrationProof!==null,only_two_new_setup_actors:migrationProof!==null,before_sha256:checkpoint.before_sha256,private_checkpoint_sha256:checkpointSha,table_count:Object.keys(cap.rows).length,portable_metadata_sha256:hash(JSON.stringify(cap.portable_metadata)),receipt_ids:receiptIds,proof:publicProof,own_auth_session_deltas:auth,sessions_included:true,all_non_qa_rows_exact:mode==='after-post',no_second_stock_writer:mode==='after-post',gets,mutations:0,login_calls:0,worker_calls:0,chrome_verified_here:false,provider_verified:false,restore_verified_here:false,full_goal_complete:false};await wx(publicOutput,report,0o644);console.log(JSON.stringify({stage:164,mode,status,gets,mutations:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch((e:unknown)=>{const at=(e instanceof Error?e.stack??'':'').match(/stocktake-adjustments-native164-readback\.ts:(\d+):(\d+)/);console.error(JSON.stringify({stage:164,status:'READBACK_FAILED_NO_REPAIR',step,source_line:at?Number(at[1]):null,private_details_withheld:true}));process.exitCode=1;}).finally(async()=>{await client?.end().catch(()=>undefined);});
