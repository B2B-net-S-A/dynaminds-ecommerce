/** ROOT ONLY. Source-authored; no login, setup, repair, migration or worker.
 * See docs/WAREHOUSE-DOCUMENT-REGISTER-NATIVE-PROOF166.md for all pins.
 * copy164 is the old4198 archive (no QA166 tenant); copy166 is a new4199 archive.
 * Import-safe pure oracle; all rows captured in owner UTC RR READ ONLY.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { SaxesParser } from 'saxes';
import { captureStocktakeAdjustmentReadback, validateStocktakeAdjustmentReceipt, type StocktakeAdjustmentCapture as Capture } from './stocktake-adjustments-native164-readback';
import { validateWarehouseDocumentSetupPreservation } from './warehouse-document-register-native166-setup';
import { captureStocktakeAdjustmentPreservation } from './stocktake-adjustments-native164-preservation';

type Row=Record<string,any>;
type Scope='primary'|'copy164'|'copy166';
type Detail={document:Row;rows:Row[];movements:Row[];evidence:Row;row_names:'recorded'};
const ROOT='<workspace>/app',SCHEMA='149_stocktake_adjustments';
const SHA=/^[a-f0-9]{64}$/,REV=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const pins={config:'9a2c81811d1ffdb6c52aabdd77dddf3ac1975bd8cc2c2d2957882b338dd7b660',
  sql:'a4ec349804e0bddddbe595669b3a87f432a72cc9f1b19af2eb80aabf6b902264',
  setup164:'78617b72b5a5564402705bf1e6d9309e5d84d947f0a8cd3b52dac82abb1a7ad8',
  primary165:'d1f140649851575bf5a08eb8836dea2b91482ce562004688638e8f7b48314f7a',
  copy165:'a9af0917808b9f6dd97818ca478793960476b9aa6d5111438219ba8f6594db18',
  oldResult:'c03e271483a77dad4448b7325b2f6b7cb13e14e80ca6fa87fce423d1e10aeb5c'};
const receipts={off:'3e325f7a-c4f1-4c01-819b-f6c13abfa4a3',on:'ba48c94d-f7f7-420f-ba94-733d9734c5e1'};
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
const one=(rs:Row[])=>{assert.equal(rs.length,1);return rs[0];};
const rows=(cap:Capture,n:string)=>{assert(cap.rows[n],n);return cap.rows[n].map(x=>x.row);};
const own=(cap:Capture,a:Row,n:string)=>rows(cap,n).filter(x=>x.tenant_id===a.tenant_id);
const money=new Set(['currency','exponent','unit_cost_minor','value_minor','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','rows_sha256','_exponent']);
function project(v:any,values:boolean):any {
  if(Array.isArray(v))return v.map(x=>project(x,values));
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='_exponent'&&(values||!money.has(k))).map(([k,x])=>[k,project(x,values)]));
  return v;
}
function tick(v:unknown):bigint {
  assert.equal(typeof v,'string');const m=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(v as string);assert(m);
  const seconds=Date.parse(m[1]+'Z');assert(Number.isFinite(seconds));return BigInt(seconds)*1000n+BigInt((m[2]??'').padEnd(6,'0'));
}
function ordering(a:Row,b:Row){const ta=tick(a.created_at),tb=tick(b.created_at);return ta!==tb?(ta>tb?-1:1):a.origin!==b.origin?(a.origin>b.origin?-1:1):a.id===b.id?0:a.id>b.id?-1:1;}

/** Independent raw-table oracle; never imports server projection/rendering code. */
export function warehouseRegisterExpected166(cap:Capture,a:Row):Detail[] {
  const warehouse=(id:string)=>{const w=one(own(cap,a,'warehouses').filter(x=>x.id===id));return{id:w.id,name:w.name,code:w.code};};
  const legacy=own(cap,a,'warehouse_documents').map(d=>{
    const ls=own(cap,a,'warehouse_document_lines').filter(l=>l.document_id===d.id).sort((x,y)=>x.product_id<y.product_id?-1:x.product_id>y.product_id?1:0);
    const ms=own(cap,a,'stock_movements').filter(m=>m.warehouse_document_id===d.id).sort((x,y)=>tick(x.created_at)!==tick(y.created_at)?tick(x.created_at)<tick(y.created_at)?-1:1:x.id<y.id?-1:1);
    const kind=({receipt:'PZ',transfer:'MM',issue:'WZ',count:'count'} as Row)[d.kind];assert(kind);
    return {document:{origin:'warehouse',id:d.id,kind,number:d.number,status:d.status,created_at:d.created_at,source_kind:'warehouse',warehouse:warehouse(d.warehouse_id),destination:d.destination_id?warehouse(d.destination_id):null,warehouse_names:'current',row_count:ls.length,value_available:false,summary:null},
      rows:ls.map((l,i)=>({origin:'warehouse',ordinal:i,product_id:l.product_id,sku:l.sku,name:l.name,quantity:l.quantity,location:l.location,expected_on_hand:l.expected_on_hand,expected_reserved:l.expected_reserved,expected_version:l.expected_version==null?null:String(l.expected_version)})),
      movements:ms.map(m=>({id:m.id,product_id:m.product_id,warehouse_id:m.warehouse_id,delta:m.delta,kind:m.kind,created_at:m.created_at})),
      evidence:{origin:'warehouse',version:String(d.version),reference:d.reference,note:d.note,posted_at:d.posted_at},row_names:'recorded' as const};
  });
  const adjustments=own(cap,a,'stocktake_adjustment_documents').map(d=>{
    const r=one(own(cap,a,'stocktake_adjustment_receipts').filter(x=>x.id===d.receipt_id)),p=one(own(cap,a,'stocktake_adjustment_previews').filter(x=>x.id===r.preview_id));
    const dr=own(cap,a,'stocktake_adjustment_document_rows').filter(x=>x.document_id===d.id).sort((x,y)=>x.ordinal-y.ordinal);
    assert.equal(dr.length,d.row_count);for(const[i,x]of dr.entries()){assert.equal(x.ordinal,i);assert.equal(x.payload.ordinal,i);}
    const frozen=p.frame.source.warehouse;
    return {document:{origin:'stocktake_adjustment',id:d.id,kind:d.kind,number:d.number,status:'posted',created_at:d.created_at,source_kind:p.source_kind,warehouse:{id:frozen.id,name:frozen.name,code:frozen.code},destination:null,warehouse_names:'frozen',row_count:d.row_count,value_available:p.source_kind==='wms',summary:d.summary},
      rows:dr.map(x=>project({...x.payload,origin:'stocktake_adjustment'},true)),movements:[],
      evidence:{origin:'stocktake_adjustment',receipt_id:r.id,preview_id:p.id,stocktake_id:p.request.stocktake_id,posting_id:r.posting_id,operation_id:r.operation_id,series_id:d.series_id,year:d.year,sequence:String(d.sequence)},row_names:'recorded' as const};
  });
  return [...legacy,...adjustments].sort((a,b)=>ordering(a.document,b.document));
}

const csvBase=['record_type','origin','document_id','number','kind','status','source_kind','created_at','warehouse_id','warehouse_name','warehouse_code','destination_id','destination_name','destination_code','warehouse_names','value_available','row_names','row_count','pw_quantity','rw_quantity','version','reference','note','posted_at','receipt_id','preview_id','stocktake_id','posting_id','operation_id','series_id','year','sequence','ordinal','source_ordinal','line_id','product_id','sku','name','quantity','location','delta','expected_on_hand','expected_reserved','expected_version','lot_id','lot_code','expiry_date','layer_id','movement_id','stock_movement_id','movement_kind','movement_created_at'];
const csvMoney=['currency','exponent','known_pw_minor','known_rw_minor','unknown_pw_quantity','unknown_rw_quantity','unit_cost_minor','value_minor','cost_state'];
function scalar(v:unknown){return v==null?'':typeof v==='string'&&/^[\s]*[=+\-@\t\r\n]/u.test(v)?"'"+v:String(v);}
function csvParse(content:string){const records:string[][]=[];let row:string[]=[],field='',quoted=false;
  for(let i=0;i<content.length;i++){const ch=content[i];if(quoted){if(ch==='"'&&content[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;}
    else if(ch==='"'){assert.equal(field,'');quoted=true;}else if(ch===','){row.push(field);field='';}else if(ch==='\r'&&content[i+1]==='\n'){row.push(field);records.push(row);row=[];field='';i++;}else field+=ch;}
  assert.equal(quoted,false);assert.deepEqual(row,[]);assert.equal(field,'');return records;
}
type XmlNode={name:string;attrs:Record<string,unknown>;text:string;children:XmlNode[]};
function xmlParse(content:string){let root:XmlNode|undefined;const stack:XmlNode[]=[];const p=new SaxesParser();
  p.on('doctype',()=>assert.fail('DTD forbidden'));p.on('opentag',n=>{const x:XmlNode={name:n.name,attrs:Object.fromEntries(Object.entries(n.attributes)),text:'',children:[]};if(stack.length)stack.at(-1)!.children.push(x);else{assert.equal(root,undefined);root=x;}stack.push(x);});
  p.on('text',t=>{if(stack.length)stack.at(-1)!.text+=t;else assert.equal(t.trim(),'');});p.on('closetag',()=>{assert(stack.length);stack.pop();});p.write(content).close();assert(root);assert.equal(stack.length,0);return root;
}
function xmlExact(n:XmlNode,v:any){if(v==null){assert.deepEqual(n.attrs,{nil:'true'});assert.equal(n.text,'');assert.deepEqual(n.children,[]);return;}
  assert.deepEqual(n.attrs,{});if(v&&typeof v==='object'){assert(!Array.isArray(v));assert.equal(n.text,'');assert.deepEqual(n.children.map(x=>x.name).sort(),Object.keys(v).sort());for(const x of n.children)xmlExact(x,v[x.name]);}
  else{assert.deepEqual(n.children,[]);assert.equal(n.text,String(v));}}
/** Full header/evidence/row/movement oracle; snapshot is only HTTP transaction's dynamic timestamp. */
export function validateWarehouseRegisterExport166(e:Row,raw:Detail,requested:boolean){
  const values=requested&&raw.document.value_available,expected=project(raw,values) as Detail;
  expected.document.value_available=values;assert.deepEqual(e.document,expected.document);assert.equal(e.values_included,values);assert.equal(e.row_count,expected.rows.length);
  assert.equal(e.filename,`${expected.document.kind}-${expected.document.origin}-${expected.document.id}.${e.format}`);tick(e.snapshot_at);assert.equal(typeof e.content,'string');
  if(e.format==='xml'){assert.equal(e.content_type,'application/xml; charset=utf-8');const root=xmlParse(e.content);assert.equal(root.name,'warehouse_document');assert.deepEqual(root.attrs,{version:'1'});assert.equal(root.text,'');assert.deepEqual(root.children.map(x=>x.name),['document','evidence','rows','movements']);
    xmlExact(root.children[0],expected.document);xmlExact(root.children[1],expected.evidence);
    for(const[i,rs]of [[2,expected.rows],[3,expected.movements]] as const){const container:XmlNode=root.children[i];assert.deepEqual(container.attrs,{});assert.equal(container.text,'');assert.equal(container.children.length,rs.length);container.children.forEach((n,j)=>{assert.equal(n.name,'row');xmlExact(n,rs[j]);});}
  }else{assert.equal(e.format,'csv');assert.equal(e.content_type,'text/csv; charset=utf-8');const[column,...serialized]=csvParse(e.content);assert(column);assert.deepEqual(column,[...csvBase,...(values?csvMoney:[])]);
    const d=expected.document,common={origin:d.origin,document_id:d.id,number:d.number,kind:d.kind,status:d.status,source_kind:d.source_kind,created_at:d.created_at,warehouse_id:d.warehouse.id};
    const records:Row[]=[{...common,...expected.evidence,record_type:'document',warehouse_name:d.warehouse.name,warehouse_code:d.warehouse.code,destination_id:d.destination?.id,destination_name:d.destination?.name,destination_code:d.destination?.code,warehouse_names:d.warehouse_names,value_available:d.value_available,row_names:'recorded',row_count:d.row_count,...d.summary},
      ...expected.rows.map(r=>({...common,...r,record_type:'row',...(values?{exponent:d.summary.exponent,cost_state:r.unit_cost_minor===null?'unknown':'known'}:{})})),
      ...expected.movements.map(m=>({...common,record_type:'movement',product_id:m.product_id,warehouse_id:m.warehouse_id,delta:m.delta,movement_id:m.id,movement_kind:m.kind,movement_created_at:m.created_at}))];
    assert.deepEqual(serialized,records.map(r=>column.map(k=>scalar(r[k]))),'Every complete CSV field, including evidence and actual movement');
  }
  if(!values){assert.deepEqual(e.document,project(e.document,false));const forbidden=(n:XmlNode)=>{assert(!money.has(n.name));n.children.forEach(forbidden);};if(e.format==='xml')forbidden(xmlParse(e.content));}
}

async function directory(p:string){const s=await lstat(p);assert(s.isDirectory()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);}
async function bytes(p:string,privateFile=true,max=512*1024*1024){const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);assert(s.size>0&&s.size<=max);if(privateFile)assert.equal(s.mode&0o777,0o600);
  const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs']as const)assert.equal(n[k],s[k]);};stable(await f.stat());const b=await f.readFile();stable(await f.stat());stable(await lstat(p));assert.equal(b.length,s.size);return b;}finally{await f.close();}}
async function hashFile(p:string){const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(await realpath(p),p);assert.equal(s.mode&0o777,0o600);const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stable=(n:typeof s)=>{for(const k of ['dev','ino','mode','size','mtimeMs']as const)assert.equal(n[k],s[k]);};stable(await f.stat());let size=0;const h=createHash('sha256');for await(const b of createReadStream(p,{fd:f.fd,autoClose:false})){size+=b.length;h.update(b);}stable(await f.stat());stable(await lstat(p));assert.equal(size,s.size);return{sha256:h.digest('hex'),bytes:size};}finally{await f.close();}}
async function absent(p:string){try{await lstat(p);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw Error('Exclusive artifact exists; no automatic resume');}
async function wx(p:string,b:Buffer|string,mode=0o600){await directory(dirname(p));assert(Buffer.byteLength(b)<=512*1024*1024);const f=await open(p,'wx',mode);try{await f.writeFile(b);await f.sync();}finally{await f.close();}const d=await open(dirname(p),'r');try{await d.sync();}finally{await d.close();}return sha(b);}
async function responseBytes(r:Response,max=8*1024*1024){assert(r.body);const reader=r.body.getReader(),parts:Buffer[]=[];let length=0;try{for(;;){const n=await reader.read();if(n.done)break;length+=n.value.byteLength;assert(length<=max);parts.push(Buffer.from(n.value));}}finally{await reader.cancel().catch(()=>undefined);}return Buffer.concat(parts);}
function sessions(before:Capture,now:Capture,actors:Row[],expected:Row){assert.deepEqual(Object.keys(expected).sort(),actors.map(a=>a.label).sort());const old=rows(before,'sessions'),current=rows(now,'sessions');assert.equal(new Set(current.map(s=>s.token_hash)).size,current.length);
  for(const s of old)assert.deepEqual(current.filter(x=>x.token_hash===s.token_hash),[s]);const added=current.filter(s=>!old.some(x=>x.token_hash===s.token_hash)),allowed:string[]=[],counts:Row={};
  for(const a of actors){const hs=expected[a.label];assert(Array.isArray(hs)&&hs.length<=1);hs.forEach(h=>assert.match(h,SHA));const ownAdded=added.filter(s=>s.tenant_id===a.tenant_id&&s.user_id===a.user_id);assert.deepEqual(ownAdded.map(s=>s.token_hash).sort(),[...hs].sort());allowed.push(...hs);counts[a.label]=hs.length;}
  assert.equal(new Set(allowed).size,allowed.length);assert.deepEqual(added.map(s=>s.token_hash).sort(),allowed.sort());return counts;
}
function compareCapture(before:Capture,now:Capture,actors:Row[],expected:Row){assert.equal(Object.keys(now.rows).length,464);assert.deepEqual(Object.keys(now.rows),Object.keys(before.rows));assert.deepEqual(now.portable_metadata,before.portable_metadata);assert.deepEqual(now.proof_hashes,before.proof_hashes);
  for(const n of Object.keys(before.rows))if(n!=='sessions'){assert.deepEqual(now.rows[n],before.rows[n],n);assert.deepEqual(now.fingerprints[n],before.fingerprints[n],n);}return sessions(before,now,actors,expected);}
function preserveOld(old:Capture,now:Capture){assert.deepEqual(Object.keys(now.rows),Object.keys(old.rows));assert.deepEqual(now.portable_metadata,old.portable_metadata);assert.deepEqual(now.proof_hashes,old.proof_hashes);
  for(const n of Object.keys(old.rows)){const counts=new Map<string,number>();for(const r of now.rows[n]){const k=JSON.stringify(r);counts.set(k,(counts.get(k)??0)+1);}for(const r of old.rows[n]){const k=JSON.stringify(r),num=counts.get(k)??0;assert(num>0,`Historical row changed/removed in ${n}`);counts.set(k,num-1);}}
}
function validateLegacy(cap:Capture,a:Row){const ds=own(cap,a,'warehouse_documents'),ls=own(cap,a,'warehouse_document_lines'),ms=own(cap,a,'stock_movements');assert.equal(ds.length,5);assert.equal(ls.length,5);assert.equal(a.documents.length,5);
  assert.deepEqual(a.documents.map((d:Row)=>d.label).sort(),['CANCELLED_PZ','COUNT','MM','PZ','WZ']);const expected:Row={PZ:{kind:'receipt',status:'posted',quantity:4,movements:[4]},MM:{kind:'transfer',status:'posted',quantity:1,movements:[-1,1]},WZ:{kind:'issue',status:'posted',quantity:1,movements:[-1]},COUNT:{kind:'count',status:'posted',quantity:0,movements:[-2]},CANCELLED_PZ:{kind:'receipt',status:'cancelled',quantity:1,movements:[]}};
  for(const d of a.documents){assert.match(d.id,UUID);const r=one(ds.filter(x=>x.id===d.id)),l=one(ls.filter(x=>x.document_id===d.id)),e=expected[d.label];assert.equal(r.kind,e.kind);assert.equal(r.status,e.status);assert.equal(r.number,d.number);assert.equal(r.warehouse_id,a.warehouses.A.id);assert.equal(r.destination_id,d.label==='MM'?a.warehouses.B.id:null);assert.equal(l.product_id,a.product.id);assert.equal(l.quantity,e.quantity);assert.equal(l.expected_reserved,0);
    const m=ms.filter(x=>x.warehouse_document_id===r.id);assert.deepEqual(m.map(x=>x.delta).sort((x,y)=>x-y),e.movements);for(const x of m){assert.equal(x.product_id,a.product.id);assert.equal(x.warehouse_id,x.delta>0&&d.label==='MM'?a.warehouses.B.id:a.warehouses.A.id);}if(d.label==='COUNT'){assert.equal(l.expected_on_hand,2);assert(l.expected_version!=null);}}
  assert.equal(ms.filter(x=>x.warehouse_document_id).length,5);const birth=ms.filter(x=>!x.warehouse_document_id);assert.equal(birth.length,1);assert.equal(birth[0].product_id,a.product.id);assert.equal(birth[0].warehouse_id,a.warehouses.A.id);assert.equal(birth[0].delta,0);
  for(const[k,q]of [['A',0],['B',1]]as const){const s=one(own(cap,a,'stock').filter(x=>x.warehouse_id===a.warehouses[k].id&&x.product_id===a.product.id));assert.equal(s.on_hand,q);assert.equal(s.reserved,0);const bins=own(cap,a,'stock_locations').filter(x=>x.warehouse_id===s.warehouse_id&&x.product_id===s.product_id);assert.equal(bins.reduce((n,b)=>n+b.quantity,0),q);}
  for(const n of ['stocktake_adjustment_receipts','stocktake_adjustment_documents','stocktake_adjustment_counters','wms_operations','reservations','orders','return_cases'])assert.deepEqual(own(cap,a,n),[]);
}

async function main(){let step='preflight',c:pg.Client|undefined,gets=0,malformed=0;const trace:Row[]=[];
  try{
    assert.equal(process.cwd(),ROOT);assert.equal(await realpath(ROOT),ROOT);assert.equal(process.argv.length,2);assert.equal(process.env.QA166_CONFIRM,'READ_ONLY_REGISTER_166');assert.equal(process.env.DYNA_WORKER_DISABLED,'true');
    for(const k of ['DATABASE_URL','DYNA_TEST'])assert.equal(process.env[k],undefined);for(const p of [ROOT,resolve(ROOT,'data'),resolve(ROOT,'docs')])await directory(p);
    const scope=process.env.QA166_SCOPE as Scope,phase=process.env.QA166_PHASE;assert(['primary','copy164','copy166'].includes(scope));assert(phase==='before'||phase==='after');const revision=process.env.QA_EXPECTED_REVISION??'';assert.match(revision,REV);
    const attempt=process.env.QA166_ATTEMPT??'1';assert(/^[1-9]$/.test(attempt));if(phase==='before')assert.equal(attempt,'1');const suffix=attempt==='1'?'':`-attempt${attempt}`,prefix=`warehouse-document-register-native166-${scope}-${phase}${suffix}`;
    const output=resolve(ROOT,'data',prefix+'.json'),publicOutput=resolve(ROOT,'docs',prefix+'.json');for(const p of [output,publicOutput,output+'.intent.json'])await absent(p);
    const retained=new Map<string,{hash:string;priv:boolean}>();async function pin(p:string,h:string|undefined,priv=true){assert.match(h??'',SHA);const b=await bytes(p,priv);assert.equal(sha(b),h);retained.set(p,{hash:h!,priv});return b;}
    const config=JSON.parse((await pin(resolve(ROOT,'.local.json'),pins.config)).toString())as Row;assert.match(config.encryptionKey,SHA);assert.equal(typeof config.dbPassword,'string');assert(config.dbPassword.length>0);await pin(resolve(ROOT,'server/149_stocktake_adjustments.sql'),pins.sql,false);
    const setup164=JSON.parse((await pin(resolve(ROOT,'data/stocktake-adjustments-native164-setup.json'),pins.setup164)).toString())as Row;assert.equal(setup164.stage,164);assert.equal(setup164.schema,SCHEMA);assert.deepEqual(setup164.actors.map((a:Row)=>[a.label,a.on]),[['OFF',false],['ON',true]]);
    const oldScope=scope==='copy164'?'copy':'primary',old165=JSON.parse((await pin(resolve(ROOT,`data/stocktake-adjustment-register-native165-${oldScope}-after-attempt2.json`),scope==='copy164'?pins.copy165:pins.primary165)).toString())as Row;assert.equal(old165.status,'REGISTER165_AFTER_READ_ONLY_PASS');assert.equal(old165.schema,SCHEMA);
    const adoptionPath=resolve(ROOT,`data/warehouse-document-register-native166-${oldScope}-adoption-before.json`),adoption=JSON.parse((await pin(adoptionPath,process.env.QA166_ADOPTION_SHA256)).toString())as Row;assert.equal(adoption.status,'ALL464_ADOPTION_EXACT_PASS');assert.equal(adoption.scope,oldScope);assert.equal(adoption.phase,'before');assert.equal(adoption.schema,SCHEMA);assert.deepEqual(adoption.capture,old165.capture);
    const setupPath=resolve(ROOT,'data/warehouse-document-register-native166-setup-accepted.json'),setup=JSON.parse((await pin(setupPath,process.env.QA166_SETUP_SHA256)).toString())as Row;
    assert.equal(setup.stage,166);assert.equal(setup.status,'OWN_LEGACY_DOCUMENTS_READY');assert.equal(setup.schema_revision,SCHEMA);assert.equal(setup.config_sha256,pins.config);assert.equal(setup.sql_sha256,pins.sql);assert.equal(setup.pending,null);assert.match(setup.runtime_revision,REV);
    const originalSetupPath=resolve(ROOT,'data/warehouse-document-register-native166-setup.json');assert.equal(setup.original_journal_path,originalSetupPath);assert.equal(setup.original_journal_sha256,process.env.QA166_ORIGINAL_SETUP_SHA256);assert.equal(setup.original_journal_status,'FAILED_DO_NOT_RERUN');assert.equal(setup.acceptance_mode,'READ_ONLY_REVALIDATION_AFTER_15_CONFIRMED_WRITES');
    const originalSetup=JSON.parse((await pin(originalSetupPath,process.env.QA166_ORIGINAL_SETUP_SHA256)).toString())as Row;assert.equal(originalSetup.stage,166);assert.equal(originalSetup.status,'FAILED_DO_NOT_RERUN');assert.equal(originalSetup.pending,null);assert.equal(originalSetup.failed_step,'full-after-setup');assert.equal(originalSetup.completed.length,15);assert.deepEqual(originalSetup.actor,setup.actor);
    for(const k of ['schema_revision','runtime_revision','config_sha256','sql_sha256','before_path','before_sha256'])assert.deepEqual(originalSetup[k],setup[k],k);assert.deepEqual(originalSetup.completed,setup.completed);
    assert.deepEqual(originalSetup.completed.map((x:Row)=>x.label),['signup','enterprise-preview','enterprise-commit','warehouse-B','product-zero','create-PZ','post-PZ','create-MM','post-MM','create-WZ','post-WZ','create-COUNT','post-COUNT','create-CANCELLED_PZ','cancel-CANCELLED_PZ']);
    for(const done of originalSetup.completed){assert.equal(done.method,'POST');assert.equal(done.response.status,done.expected_status);assert.equal(sha(JSON.stringify(done.response.data)),done.response_sha256);assert.equal(typeof done.raw_body,'string');JSON.parse(done.raw_body);}
    const setupBeforePath=resolve(ROOT,'data/warehouse-document-register-native166-primary-adoption-before.json');assert.equal(setup.before_path,setupBeforePath);assert.equal(setup.before_sha256,process.env.QA166_SETUP_ADOPTION_SHA256);const setupBefore=JSON.parse((await pin(setupBeforePath,process.env.QA166_SETUP_ADOPTION_SHA256)).toString())as Row;
    assert.equal(setupBefore.status,'ALL464_ADOPTION_EXACT_PASS');assert.equal(setupBefore.scope,'primary');assert.equal(setupBefore.phase,'before');assert.deepEqual(setupBefore.capture,JSON.parse((await pin(resolve(ROOT,'data/stocktake-adjustment-register-native165-primary-after-attempt2.json'),pins.primary165)).toString()).capture);
    const setupAfterPath=resolve(ROOT,'data/warehouse-document-register-native166-setup-after.json');assert.equal(setup.after_capture.path,setupAfterPath);const setupAfter=JSON.parse((await pin(setupAfterPath,setup.after_capture.sha256)).toString())as Row;
    assert.equal(setupAfter.stage,166);assert.equal(setupAfter.phase,'after-setup');assert.equal(setupAfter.status,'OWN_LEGACY_GRAPH_AND_OLD_ROWS_VERIFIED');assert.equal(setupAfter.schema,SCHEMA);assert.equal(setupAfter.runtime_revision,setup.runtime_revision);assert.equal(setupAfter.before_sha256,setup.before_sha256);assert.equal(setupAfter.config_sha256,pins.config);assert.equal(setupAfter.sql_sha256,pins.sql);assert.deepEqual(setupAfter.actor,setup.actor);assert.deepEqual(setupAfter.exact_metadata,setupBefore.exact_metadata);assert.match(setupAfter.setup_journal_sha256,SHA);const setupCapture=setupAfter.capture as Capture;
    assert.equal(Object.keys(setupCapture.rows).length,464);assert.deepEqual(validateWarehouseDocumentSetupPreservation(setupBefore.capture,setupCapture,setup.actor),setupAfter.preservation);assert.deepEqual(setup.preservation,setupAfter.preservation);preserveOld(setupBefore.capture,setupCapture);
    const qa={...setup.actor,label:'qa166'};assert.equal(qa.on,false);for(const k of ['user_id','tenant_id'])assert.match(qa[k],UUID);assert.match(qa.product.id,UUID);for(const k of ['A','B'])assert.match(qa.warehouses[k].id,UUID);assert.notEqual(qa.warehouses.A.id,qa.warehouses.B.id);validateLegacy(setupCapture,qa);
    // In copy164, setup belongs to primary and its before chain is primary too.
    const actors:Row[]=[...(scope==='copy164'?[]:[qa]),...setup164.actors.map((a:Row)=>({...a,label:a.on?'on':'off'}))];
    let database='dynaminds',dbConfig=config,archiveRevision:string|null=null,archivePath:string|undefined,archiveHash:Row|undefined;
    if(scope!=='primary'){
      const resultPath=process.env.QA166_RESTORE_RESULT_PATH??'';
      if(scope==='copy164')assert.equal(resultPath,resolve(ROOT,'data/stocktake-adjustments-backup164-1a8a5ffe-dd27-4a8e-8d7b-239a93684af0/restore/7add0957b206bbc5/result.json'));
      const match=/^\/Users\/arturtwardowski\/DYNA Ecomerce\/app\/data\/((?:stocktake-adjustments-backup164|warehouse-document-register-backup166)-([a-f0-9-]{36}))\/restore\/([a-f0-9]{16})\/result\.json$/.exec(resultPath);assert(match);assert.match(match[2],UUID);
      if(scope==='copy166')assert(match[1].startsWith('warehouse-document-register-backup166-'));
      for(const p of [resolve(ROOT,'data',match[1]),resolve(ROOT,'data',match[1],'restore'),dirname(resultPath),resolve(ROOT,'data',match[1],'backup')])await directory(p);
      const result=JSON.parse((await pin(resultPath,scope==='copy164'?pins.oldResult:process.env.QA166_RESTORE_RESULT_SHA256)).toString())as Row;
      assert.equal(result.id,match[3]);database='dynaminds_restore_'+match[3];assert.equal(result.database,database);assert.equal(result.directory,dirname(resultPath));assert.equal(result.config,resolve(dirname(resultPath),'local-config.json'));assert.equal(result.images,resolve(dirname(resultPath),'images'));assert.equal(result.source,'dynaminds');
      assert.equal(result.status,'verified');assert.equal(result.preview_only,true);assert.equal(result.worker_enabled,false);assert.equal(result.row_fingerprints_match,true);assert.equal(result.schema_fingerprint_match,true);assert.equal(result.tables,464);archiveRevision=process.env.QA166_ARCHIVE_REVISION??'';assert.match(archiveRevision,REV);assert.equal(result.revision,archiveRevision);
      const copyConfigBytes=await bytes(result.config);dbConfig=JSON.parse(copyConfigBytes.toString());retained.set(result.config,{hash:sha(copyConfigBytes),priv:true});assert.deepEqual(Object.keys(dbConfig).sort(),['dbPassword','encryptionKey']);assert.equal(dbConfig.encryptionKey,config.encryptionKey);assert.equal(typeof dbConfig.dbPassword,'string');assert(dbConfig.dbPassword.length>0);
      archivePath=process.env.QA166_ARCHIVE_PATH??'';assert.equal(dirname(archivePath),resolve(ROOT,'data',match[1],'backup'));assert.match(basename(archivePath),/^[a-z0-9]+-[a-f0-9]{16}\.dyna$/);assert.match(process.env.QA166_ARCHIVE_SHA256??'',SHA);archiveHash=await hashFile(archivePath);assert.equal(archiveHash.sha256,process.env.QA166_ARCHIVE_SHA256);
    }
    const port=scope==='primary'?4100:scope==='copy164'?4198:4199;if(scope!=='primary')assert.equal(process.env.DYNA_PREVIEW_PORT,String(port));else assert.equal(process.env.DYNA_PREVIEW_PORT,undefined);
    const baselinePath=scope==='primary'?setupAfterPath:scope==='copy164'?resolve(ROOT,'data/stocktake-adjustment-register-native165-copy-after-attempt2.json'):resolve(ROOT,'data/warehouse-document-register-native166-copy-baseline.json');
    const rootBaseline=JSON.parse((await pin(baselinePath,process.env.QA166_BASELINE_SHA256)).toString())as Row;const rootCapture=rootBaseline.capture as Capture;assert(rootCapture);
    if(scope==='primary')assert.deepEqual(rootCapture,setupCapture);
    if(scope==='copy166'){
      assert.equal(rootBaseline.stage,166);assert.equal(rootBaseline.scope,'copy166');assert.equal(rootBaseline.status,'REGISTER166_COPY_BASELINE_VERIFIED');assert.equal(rootBaseline.restore_result_sha256,process.env.QA166_RESTORE_RESULT_SHA256);assert.equal(rootBaseline.setup_sha256,process.env.QA166_SETUP_SHA256);assert.equal(rootBaseline.database,database);
      const acceptedPath=process.env.QA166_PRIMARY_ACCEPTED_PATH??'';assert.equal(dirname(acceptedPath),resolve(ROOT,'data'));assert.match(basename(acceptedPath),/^warehouse-document-register-native166-primary-after(?:-attempt[2-9])?\.json$/);
      const accepted=JSON.parse((await pin(acceptedPath,process.env.QA166_PRIMARY_ACCEPTED_SHA256)).toString())as Row;assert.equal(accepted.status,'REGISTER166_AFTER_READ_ONLY_PASS');assert.equal(accepted.scope,'primary');assert.equal(accepted.setup_sha256,process.env.QA166_SETUP_SHA256);assert.equal(accepted.schema,SCHEMA);assert.equal(accepted.runtime_revision,archiveRevision);assert.equal(rootBaseline.primary_accepted_sha256,process.env.QA166_PRIMARY_ACCEPTED_SHA256);assert.deepEqual(rootCapture,accepted.capture);preserveOld(setupCapture,rootCapture);
    }
    const beforePath=resolve(ROOT,`data/warehouse-document-register-native166-${scope}-before.json`);let before:Row|undefined;
    if(phase==='after'){before=JSON.parse((await pin(beforePath,process.env.QA166_BEFORE_SHA256)).toString())as Row;assert.equal(before.status,'REGISTER166_BEFORE_EXACT_PASS');assert.equal(before.scope,scope);assert.equal(before.phase,'before');assert.equal(before.stage,166);assert.equal(before.schema,SCHEMA);assert.equal(before.setup_sha256,process.env.QA166_SETUP_SHA256);assert.equal(before.baseline_sha256,process.env.QA166_BASELINE_SHA256);assert.deepEqual(before.capture,rootCapture);}
    async function custody(){for(const[p,h]of retained)assert.equal(sha(await bytes(p,h.priv)),h.hash);if(archivePath)assert.deepEqual(await hashFile(archivePath),archiveHash);}
    await custody();await wx(output+'.intent.json',json({stage:166,scope,phase,runtime_revision:revision,archive_revision:archiveRevision,action:'READ_ONLY_NO_LOGIN_NO_REPAIR',baseline_path:baselinePath,baseline_sha256:process.env.QA166_BASELINE_SHA256,before_sha256:phase==='after'?process.env.QA166_BEFORE_SHA256:null}),0o600);
    async function request(a:Row|null,path:string,status=200,method:'GET'|'POST'='GET',rawCookie=false){assert(/^\/api\/(?:health|auth\/me|(?:v1\/)?warehouse-document-register(?:[/?]|$)|stocktake-adjustments\/options)/.test(path));assert(!path.includes('#'));if(method==='POST')assert(scope!=='primary'&&phase==='after');
      const index=trace.length,artifact=resolve(ROOT,'data',`${prefix}-http-${index}.json`);await absent(artifact);const cookie=a?.cookie?.replace(/^dyna_session=/,scope!=='primary'&&!rawCookie?`dyna_session_preview_${port}=`:'dyna_session=');if(a)assert.match(cookie,/^dyna_session(?:_preview_419[89])?=[A-Za-z0-9_.-]+$/);
      if(method==='POST'){await custody();await wx(artifact+'.intent.json',json({stage:166,path,method,raw_body:'{',cookie:false,expected_status:423,state:'UNKNOWN_UNTIL_RESPONSE'}));malformed++;}else gets++;
      const start=Date.now(),r=await fetch(`http://127.0.0.1:${port}`+path,{method,headers:method==='POST'?{'Content-Type':'application/json'}:a?{cookie,'X-Workspace-ID':a.tenant_id}:{},...(method==='POST'?{body:'{'}:{}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});
      assert.equal(r.headers.get('set-cookie'),null);const b=await responseBytes(r);const bodyHash=await wx(artifact,b);trace.push({index,path,method,status:r.status,bytes:b.length,sha256:bodyHash,artifact});assert.equal(r.status,status);const value=JSON.parse(b.toString())as Row;
      if(status===200&&value.snapshot_at){tick(value.snapshot_at);const observed=Date.parse(value.snapshot_at);assert(observed>=start-1000&&observed<=Date.now()+1000);}return value;}
    async function health(){const h=await request(null,'/api/health');assert.equal(h.status,'ok');assert.equal(h.mode,'local');assert.equal(h.revision,revision);assert.equal(h.schema_revision,SCHEMA);assert.equal(h.restore_preview,scope!=='primary');assert.equal(h.background_workers_enabled,false);assert.equal(h.stocktake_adjustments_available,true);}
    await health();c=new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:dbConfig.dbPassword,database,connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c TimeZone=UTC'});c.on('error',()=>{});await c.connect();
    let exactMetadata:Row|undefined;
    async function capture(){assert(c);await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");try{assert.deepEqual((await c.query("SELECT current_database() db,current_user role,session_user owner,host(inet_server_addr()) host,inet_server_port() port,current_setting('transaction_read_only') readonly")).rows[0],{db:database,role:'postgres',owner:'postgres',host:'127.0.0.1',port:55432,readonly:'on'});const cap=await captureStocktakeAdjustmentReadback(c),metadata=await captureStocktakeAdjustmentPreservation(c);assert.deepEqual(metadata.rows,cap.rows);assert.deepEqual(metadata.metadata,cap.portable_metadata);exactMetadata=metadata.exact_metadata;await c.query('COMMIT');return cap;}catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}}
    step='capture';const cap=await capture(),metadata=exactMetadata,zero=Object.fromEntries(actors.map(a=>[a.label,[]]));assert(metadata);const expectedMetadata=phase==='after'?before!.exact_metadata:scope==='copy164'?adoption.exact_metadata:rootBaseline.exact_metadata;assert(expectedMetadata);assert.deepEqual(metadata,expectedMetadata,'Same-DB OID/owner/ACL/function/trigger identities retained');
    const sessionDeltas=compareCapture(phase==='after'?before!.capture:rootCapture,cap,actors,phase==='after'?JSON.parse(process.env.QA166_ADDED_SESSIONS_JSON??'null'):zero);preserveOld(adoption.capture,cap);if(scope!=='copy164')validateLegacy(cap,qa);
    const proof:Row={};for(const a of setup164.actors){const k=a.on?'on':'off';proof[k]=validateStocktakeAdjustmentReceipt(cap,a,receipts[k]);assert.deepEqual(proof[k],old165.proof[k]);}
    const exported:Row[]=[],apiProof:Row={};
    if(phase==='after'){
      if(scope!=='primary'){const primaryCookie=await request(actors[0],'/api/auth/me',401,'GET',true);assert(primaryCookie);}
      for(const a of actors){step=a.label+':api';const me=await request(a,'/api/auth/me');assert.equal(me.user.id,a.user_id);assert.equal(me.user.tenant_id,a.tenant_id);assert.equal(me.user.role,'admin');const ds=warehouseRegisterExpected166(cap,a);assert.equal(ds.length,a.label==='qa166'?5:2);const pages:Row[]=[];let cursor:string|null=null;const cursors=new Set<string>();
        do{const q=new URLSearchParams({limit:'1',...(cursor?{cursor}:{})});const r=await request(a,'/api/warehouse-document-register?'+q);assert.equal(r.meta.limit,1);assert.equal(r.data.length,1);pages.push(...r.data);assert(pages.length<=ds.length);cursor=r.meta.cursor;assert(cursor===null||typeof cursor==='string'&&cursor.length<=4096);if(cursor){assert(!cursors.has(cursor));cursors.add(cursor);}}while(cursor);
        assert.deepEqual(pages,ds.map(d=>d.document));const start=await request(a,'/api/warehouse-document-register?limit=1');assert(start.meta.cursor);await request(a,'/api/warehouse-document-register?'+new URLSearchParams({limit:'2',cursor:start.meta.cursor}),409);const altered=start.meta.cursor.slice(0,-1)+(start.meta.cursor.endsWith('A')?'B':'A');await request(a,'/api/warehouse-document-register?'+new URLSearchParams({limit:'1',cursor:altered}),422);
        const other=actors.find(x=>x.tenant_id!==a.tenant_id);assert(other);await request(other,'/api/warehouse-document-register?'+new URLSearchParams({limit:'1',cursor:start.meta.cursor}),409);
        for(const d of ds){const h=d.document,path=`/api/warehouse-document-register/${h.origin}/${h.id}`;
          const filtered=await request(a,'/api/warehouse-document-register?'+new URLSearchParams({origin:h.origin,kind:h.kind,status:h.status,source_kind:h.source_kind,warehouse_id:h.warehouse.id,number_prefix:h.number,from:new Date(Number(tick(h.created_at)/1000n)-1000).toISOString(),to:new Date(Number(tick(h.created_at)/1000n)+1000).toISOString(),limit:'50'}));assert.deepEqual(filtered.data,[h]);assert.equal(filtered.meta.cursor,null);
          const detail=await request(a,path);assert.deepEqual({document:detail.document,rows:detail.rows,movements:detail.movements,evidence:detail.evidence,row_names:detail.row_names},d);assert.equal(detail.can_read,true);assert.equal(detail.can_read_value,true);assert.equal(detail.read_only,scope!=='primary');
          const v1=await request(a,path.replace('/api/','/api/v1/'));assert.deepEqual({document:v1.document,rows:v1.rows,movements:v1.movements,evidence:v1.evidence,row_names:v1.row_names},d);
          await request(other,path,404);
          for(const format of ['csv','xml']as const)for(const requested of a.label==='qa166'?[false]:[false,true]){const e=await request(a,path+`/export?format=${format}&include_values=${requested}`);validateWarehouseRegisterExport166(e,d,requested);
            const artifact=resolve(ROOT,'data',`${prefix}-${a.label}-${h.origin}-${h.id}-${requested?'values':'quantity'}.${format}`);await absent(artifact);const hash=await wx(artifact,e.content);
            exported.push({actor:a.label,origin:h.origin,kind:h.kind,document_id:h.id,format,requested_values:requested,values_included:e.values_included,filename:e.filename,rows:e.row_count,bytes:Buffer.byteLength(e.content),sha256:hash,artifact});}
        }
        for(const wh of a.label==='qa166'?[a.warehouses.A.id,a.warehouses.B.id]:[a.warehouse.id]){const expected=ds.filter(d=>d.document.warehouse.id===wh||d.document.destination?.id===wh).map(d=>d.document);const r=await request(a,'/api/warehouse-document-register?'+new URLSearchParams({warehouse_id:wh,limit:'50'}));assert.deepEqual(r.data,expected);assert.equal(r.meta.cursor,null);}
        apiProof[a.label]={document_ids:ds.map(d=>d.document.id),headers:pages,full_rows:ds.reduce((n,d)=>n+d.rows.length,0),actual_legacy_movements:ds.reduce((n,d)=>n+d.movements.length,0)};
      }
      assert.equal(exported.length,scope==='copy164'?16:26);
      if(scope!=='primary'){
        const a=actors[0],d=warehouseRegisterExpected166(cap,a)[0],normal=['/api/warehouse-document-register',`/api/warehouse-document-register/${d.document.origin}/${d.document.id}`,`/api/warehouse-document-register/${d.document.origin}/${d.document.id}/export`];
        for(const p of [...normal,...normal.map(p=>p.replace('/api/','/api/v1/'))])await request(null,p,423,'POST');assert.equal(malformed,6);
      }
    }
    step='purity';assert.deepEqual(await capture(),cap,'All464 rows, sessions and metadata exact after every request');assert.deepEqual(exactMetadata,metadata);await health();await custody();const created=new Date().toISOString(),status=phase==='before'?'REGISTER166_BEFORE_EXACT_PASS':'REGISTER166_AFTER_READ_ONLY_PASS';
    const report={stage:166,scope,phase,attempt,status,schema:SCHEMA,runtime_revision:revision,archive_revision:archiveRevision,setup_runtime_revision:setup.runtime_revision,config_sha256:pins.config,sql_sha256:pins.sql,setup_sha256:process.env.QA166_SETUP_SHA256,original_setup_sha256:process.env.QA166_ORIGINAL_SETUP_SHA256,original_setup_status:'FAILED_DO_NOT_RERUN',setup_acceptance_mode:setup.acceptance_mode,setup_confirmed_writes:15,adoption_sha256:process.env.QA166_ADOPTION_SHA256,baseline_path:baselinePath,baseline_sha256:process.env.QA166_BASELINE_SHA256,before_path:phase==='after'?beforePath:null,before_sha256:phase==='after'?process.env.QA166_BEFORE_SHA256:null,before_created_at:before?.created_at??null,created_at:created,
      tables:464,all_baseline_rows_exact:true,all_old_rows_retained_exact:true,old_sessions_changed:0,old_sessions_removed:0,explicit_own_new_sessions:sessionDeltas,portable_metadata_exact:true,receipt_graph_exact:true,qa166_legacy_graph_verified:scope!=='copy164',old164_copy_has_no_new_qa166:scope==='copy164',exports:exported,exports_complete:phase==='after',gets,malformed_guard_posts:malformed,business_mutations:0,mutations:0,login_calls:0,worker_calls:0,new_restore_executed_here:false,providers_verified:false,chrome_verified_here:false,historical_files_verified_here:false,full_goal_complete:false};
    const privateHash=await wx(output,json({...report,capture:cap,exact_metadata:metadata,proof,api_proof:apiProof,http_trace:trace,actor_ids:actors.map(a=>({label:a.label,tenant_id:a.tenant_id,user_id:a.user_id}))}));await wx(publicOutput,json({...report,private_sha256:privateHash}),0o644);console.log(json({stage:166,scope,phase,status,private_sha256:privateHash,gets,exports:exported.length,malformed_guard_posts:malformed}));
  }catch(e){const m=e instanceof Error?e.stack?.match(/warehouse-document-register-native166-proof\.ts:(\d+):(\d+)/):null;console.error(json({stage:166,status:'FAILED_NO_REPAIR_NO_AUTOMATIC_RETRY',step,error_type:e instanceof Error?e.name:'Error',source_line:m?Number(m[1]):null,source_column:m?Number(m[2]):null,private_details_withheld:true}));process.exitCode=1;}
  finally{await c?.query('ROLLBACK').catch(()=>undefined);await c?.end().catch(()=>undefined);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main();
