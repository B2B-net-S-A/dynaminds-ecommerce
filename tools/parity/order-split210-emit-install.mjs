/** Build-only finite emitter. Real source derivation is mandatory; no API accepts
 * a SQL/template/fingerprint or sourceSeal. Emitted code has no source generator,
 * filesystem/database dependency or installation/readiness authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {deriveOrderSplit210InstallTemplate} from './order-split210-install-template.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};

// Code-owned runtime implementation. The only variable input at runtime is
// captured parent DATA. Fixed compressed segments and origins are module DATA.
const RUNTIME=String.raw`
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const sha=value=>createHash('sha256').update(value).digest('hex');
function fields(value,keys,label){
 assert(value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),label+' plain object');
 const ds=Object.getOwnPropertyDescriptors(value);assert.deepEqual(Reflect.ownKeys(ds).sort(),keys.slice().sort(),label+' exact fields');
 for(const key of keys)assert(Object.hasOwn(ds[key],'value')&&ds[key].enumerable,label+' data properties only');
 return Object.fromEntries(keys.map(key=>[key,ds[key].value]));
}
function data(value,depth=0,budget={nodes:0,bytes:0},ancestors=new Set()){
 assert(depth<=48&&++budget.nodes<=100000,'parent JSON node/depth bounds');
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number'){assert(Number.isFinite(value),'finite parent JSON');return value;}
 if(typeof value==='string'){
  const n=Buffer.byteLength(value);assert(n<=1048576&&Buffer.from(value).toString('utf8')===value&&!value.includes('\0'),'bounded valid parent UTF8 without NUL');
  budget.bytes+=n;assert(budget.bytes<=2097152,'parent JSON byte bound');return value;
 }
 assert(value&&typeof value==='object'&&[Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(value)),'plain parent JSON');
 assert(!ancestors.has(value),'acyclic parent JSON');ancestors.add(value);
 const array=Array.isArray(value),ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds),out=array?[]:Object.create(null);
 assert(keys.every(key=>typeof key==='string'),'no parent symbol keys');
 if(array)assert(value.length<=100000&&keys.length===value.length+1,'dense parent arrays');
 for(const key of keys.sort()){
  if(array&&key==='length')continue;
  if(array)assert(/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<value.length,'dense parent array indices');
  assert(Object.hasOwn(ds[key],'value')&&ds[key].enumerable,'parent data properties only');
  assert(Buffer.from(key).toString('utf8')===key&&!key.includes('\0'),'valid parent JSON key');
  budget.bytes+=Buffer.byteLength(key)+3;assert(budget.bytes<=2097152,'parent JSON byte bound');
  Object.defineProperty(out,key,{value:data(ds[key].value,depth+1,budget,ancestors),enumerable:true});
 }
 ancestors.delete(value);return freeze(out);
}
function parents(options){
 const raw=fields(options,['parent209','parent166'],'parent binding'),p=data(raw);
 const p209=fields(p.parent209,['id','profile','original166','constraints','fingerprint'],'captured parent209'),p166=fields(p.parent166,['singleton','profile','fingerprint','predecessor_certificates','installed_at'],'captured parent166');
 assert.equal(p209.id,true);assert.equal(p209.profile,'merge-delivery-inheritance/v1');assert(Array.isArray(p209.constraints)&&p209.constraints.length===4,'four parent209 constraints');
 assert.equal(p166.singleton,true);assert.equal(p166.profile,'delivery-sidecar-managed/v1');assert(typeof p166.installed_at==='string'&&p166.installed_at.length>0,'parent166 birth DATA');
 assert(p166.predecessor_certificates&&typeof p166.predecessor_certificates==='object'&&!Array.isArray(p166.predecessor_certificates),'parent166 certificates object');
 for(const row of [p209,p166])assert(typeof row.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(row.fingerprint),'historical parent fingerprint');
 assert.equal(JSON.stringify(p209.original166),JSON.stringify(p.parent166),'parent209 nested original166 exact');return p;
}
function tag(text,prefix){
 let longest=-1;for(let at=text.indexOf(prefix);at>=0;at=text.indexOf(prefix,at+prefix.length)){let end=at+prefix.length;while(text[end]==='x')end++;longest=Math.max(longest,end-at-prefix.length);}return prefix+'x'.repeat(longest+1)+'$';
}
const jsonSQL=value=>{const text=JSON.stringify(value),delimiter=tag(text,'$split210_fixed');return delimiter+text+delimiter+'::jsonb';};
const COMMENT='-- Separately reviewed FIXED source seal; parent originals are per-install immutable DATA.\n';
function wrap(body){const delimiter=tag(body,'$split210_fixed_seal');return COMMENT+'DO '+delimiter+body+delimiter+';\n';}
`;
const BIND=String.raw`
assert.equal(sha(JSON.stringify(ORDER_SPLIT210_INSTALL_ORIGIN)),ORIGIN_SHA256,'fixed install origin changed');
assert.equal(ORDER_SPLIT210_INSTALL_ORIGIN.schema,'order-split210-emitted-install-origin/v1');
assert.equal(ORDER_SPLIT210_INSTALL_ORIGIN.encoding,'gzip-base64/v1');
assert.equal(encoded.length,ORDER_SPLIT210_INSTALL_ORIGIN.gzip_bytes);assert.equal(sha(encoded),ORDER_SPLIT210_INSTALL_ORIGIN.gzip_sha256,'fixed install gzip changed');
const decoded=gunzipSync(encoded,{maxOutputLength:ORDER_SPLIT210_INSTALL_ORIGIN.decoded_bytes});
assert.equal(decoded.length,ORDER_SPLIT210_INSTALL_ORIGIN.decoded_bytes);assert.equal(sha(decoded),ORDER_SPLIT210_INSTALL_ORIGIN.decoded_sha256,'fixed install template changed');
const template=freeze(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decoded)));
fields(template,['schema','origin','body_segments'],'fixed install template');assert.equal(template.schema,'order-split210-fixed-install-body/v1');
assert.deepEqual(template.origin,ORDER_SPLIT210_INSTALL_ORIGIN.source,'fixed source origin changed');
assert.equal(template.origin.schema,'order-split210-install-template-origin/v1');
assert.deepEqual(template.origin.expected_counts,{source_additions:494,replacements:22,fingerprint_records:516,external_records:36,independent_expression_leaves:48});
for(const flag of ['parent_capture_verified','source_compilation_performed','native_certification','application_activation','business_acceptance'])assert.equal(template.origin[flag],false);
for(const flag of ['source_compilation_performed','native_certification','application_activation','business_acceptance'])assert.equal(ORDER_SPLIT210_INSTALL_ORIGIN[flag],false);
assert(Array.isArray(template.body_segments)&&template.body_segments.length===3,'three fixed immutable source segments');
for(let i=0;i<3;i++){assert.equal(typeof template.body_segments[i],'string');assert.equal(Buffer.byteLength(template.body_segments[i]),template.origin.body_segment_bytes[i]);assert.equal(sha(template.body_segments[i]),template.origin.body_segment_sha256[i],'source body segment changed');}
assert(template.body_segments[0].endsWith(' p209 jsonb:='));assert.equal(template.body_segments[1],';p166 jsonb:=');assert(template.body_segments[2].startsWith(';\n actual_own jsonb;'));
const segments=template.body_segments;
/** DATA-only formatter. Caller must independently own the genuine transaction,
 * capture both originals before210 DDL and check all parent/source gates. This
 * function neither obtains nor proves those facts and never executes SQL. */
export function bindOrderSplit210InstallParents(options){
 const p=parents(options),body=segments[0]+jsonSQL(p.parent209)+segments[1]+jsonSQL(p.parent166)+segments[2],sql=wrap(body);
 return freeze({schema:'order-split210-install-bound-program/v1',sql,sha256:sha(sql),bytes:Buffer.byteLength(sql),origin:template.origin,parent_data_sha256:{original209:sha(JSON.stringify(p.parent209)),original166:sha(JSON.stringify(p.parent166))},parent_capture_requirements:{before_any_210_ddl:true,accepted_parent_full_gates:true,historical_certificates:28,before_after_exact:true},parent_capture_verified:false,seal_executed:false,source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false});
}
`;

/** Fixed build inputs only. No arbitrary source/template/seal/SQL argument. */
export function emitOrderSplit210InstallModule(options){
 const template=deriveOrderSplit210InstallTemplate(options);
 const payload={schema:'order-split210-fixed-install-body/v1',origin:template.origin,body_segments:template.body_segments};
 const decoded=Buffer.from(JSON.stringify(payload));assert(decoded.length<=2097152,'fixed template decoded source bound');
 const encoded=gzipSync(decoded,{level:9});assert(encoded.length<=262144,'fixed template physical source bound');
 const origin=freeze({schema:'order-split210-emitted-install-origin/v1',source:template.origin,encoding:'gzip-base64/v1',gzip_bytes:encoded.length,gzip_sha256:sha(encoded),decoded_bytes:decoded.length,decoded_sha256:sha(decoded),source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false});
 const module='/** Generated BUILD-TIME fixed Source210 install formatter; UNACCEPTED. No IO, DB or activation. */\n'+
  "import assert from 'node:assert/strict';\nimport {createHash} from 'node:crypto';\nimport {gunzipSync} from 'node:zlib';\n"+RUNTIME+
  'export const ORDER_SPLIT210_INSTALL_ORIGIN=freeze('+JSON.stringify(origin)+');\n'+
  'const ORIGIN_SHA256='+JSON.stringify(sha(JSON.stringify(origin)))+';\n'+
  "const encoded=Buffer.from('"+encoded.toString('base64')+"','base64');\n"+BIND;
 assert(Buffer.byteLength(module)<=524288,'fixed emitted module physical bound');
 return freeze({schema:'order-split210-emitted-install-module/v1',module,bytes:Buffer.byteLength(module),sha256:sha(module),origin,runtime_imports:['node:assert/strict','node:crypto','node:zlib'],source_generator_shipped:false,source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false});
}
