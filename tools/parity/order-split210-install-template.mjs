/** BUILD-TIME source-seal template only. No IO, database, installation, runtime
 * admission or accepted verdict. Derivation authenticates the fixed source via
 * the real fixed-seal producer. The resulting closure accepts parent DATA only;
 * no API accepts arbitrary SQL, a template or an expected fingerprint. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210FixedSeal} from './order-split210-fixed-seal.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const digest=value=>sha(JSON.stringify(value));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const COMMENT='-- Separately reviewed FIXED source seal; parent originals are per-install immutable DATA.\n';
const P209_MARKER='SOURCE210_BUILD_ONLY_PARENT209_MARKER';
const P166_MARKER='SOURCE210_BUILD_ONLY_PARENT166_MARKER';
function fields(value,keys,label){
 assert(value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),label+' plain object');
 const ds=Object.getOwnPropertyDescriptors(value);assert.deepEqual(Reflect.ownKeys(ds).sort(),keys.slice().sort(),label+' exact fields');
 for(const key of keys)assert(Object.hasOwn(ds[key],'value')&&ds[key].enumerable,label+' data properties only');
 return Object.fromEntries(keys.map(key=>[key,ds[key].value]));
}
/** Capture JSON in canonical key order, without invoking getters/toJSON. Parent
 * originals are bounded DATA, not evidence of genuine capture or IAM authority. */
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
 const raw=fields(options,['parent209','parent166'],'parent binding');
 const p=data(raw),p209=fields(p.parent209,['id','profile','original166','constraints','fingerprint'],'captured parent209'),p166=fields(p.parent166,['singleton','profile','fingerprint','predecessor_certificates','installed_at'],'captured parent166');
 assert.equal(p209.id,true);assert.equal(p209.profile,'merge-delivery-inheritance/v1');assert(Array.isArray(p209.constraints)&&p209.constraints.length===4,'four parent209 constraints');
 assert.equal(p166.singleton,true);assert.equal(p166.profile,'delivery-sidecar-managed/v1');assert(typeof p166.installed_at==='string'&&p166.installed_at.length>0,'parent166 birth DATA');
 assert(p166.predecessor_certificates&&typeof p166.predecessor_certificates==='object'&&!Array.isArray(p166.predecessor_certificates),'parent166 certificates object');
 for(const row of [p209,p166])assert(typeof row.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(row.fingerprint),'historical parent fingerprint');
 assert.equal(JSON.stringify(p209.original166),JSON.stringify(p.parent166),'parent209 nested original166 exact');
 return p;
}
/** Same collision rule as the source producer, computed in one scan rather
 * than repeatedly scanning a large parent string for ever longer x prefixes. */
function tag(text,prefix){
 let longest=-1;
 for(let at=text.indexOf(prefix);at>=0;at=text.indexOf(prefix,at+prefix.length)){
  let end=at+prefix.length;while(text[end]==='x')end++;longest=Math.max(longest,end-at-prefix.length);
 }
 return prefix+'x'.repeat(longest+1)+'$';
}
const jsonSQL=value=>{const text=JSON.stringify(value),delimiter=tag(text,'$split210_fixed');return delimiter+text+delimiter+'::jsonb';};
function wrap(body){const delimiter=tag(body,'$split210_fixed_seal');return COMMENT+'DO '+delimiter+body+delimiter+';\n';}
function bodyOf(sql){
 assert.equal(typeof sql,'string');assert(sql.startsWith(COMMENT+'DO '),'source seal fixed DO header');
 const rest=sql.slice(COMMENT.length+3),match=/^(\$split210_fixed_sealx*\$)/.exec(rest);assert(match,'source seal fixed outer delimiter');
 const delimiter=match[1];assert(rest.endsWith(delimiter+';\n'),'source seal complete DO suffix');
 const body=rest.slice(delimiter.length,-delimiter.length-2);assert(!body.includes(delimiter),'source seal single complete DO body');return body;
}
function exactlyOnce(text,needle){const at=text.indexOf(needle);assert(at>=0&&text.indexOf(needle,at+needle.length)===-1,'exact one source parent DATA binding');return at;}

/** Required inputs are the real source producer inputs, not a sourceSeal object
 * or a caller-supplied template. The fixed-seal derivation independently checks
 * all494 additions, all22 full source replacements and the48 expression leaves. */
export function deriveOrderSplit210InstallTemplate(options){
 const source=fields(options,['inputs','expectedAdditions','expectedChanges'],'install template source');
 const synthetic=parents({parent166:{singleton:true,profile:'delivery-sidecar-managed/v1',fingerprint:'a'.repeat(64),predecessor_certificates:{source_template_marker:P166_MARKER},installed_at:'2000-01-01T00:00:00+00:00'},parent209:{id:true,profile:'merge-delivery-inheritance/v1',original166:{singleton:true,profile:'delivery-sidecar-managed/v1',fingerprint:'a'.repeat(64),predecessor_certificates:{source_template_marker:P166_MARKER},installed_at:'2000-01-01T00:00:00+00:00'},constraints:[{source_template_marker:P209_MARKER},null,null,null],fingerprint:'b'.repeat(64)}});
 const sealed=deriveOrderSplit210FixedSeal({...source,...synthetic});
 assert.equal(sealed.schema,'order-split210-source-fixed-seal-program/v1');assert.equal(sha(sealed.sql),sealed.sha256);assert.equal(Buffer.byteLength(sealed.sql),sealed.bytes);
 assert.equal(sealed.seal_executed,false);assert.equal(sealed.native_certification,false);assert.equal(sealed.application_activation,false);
 const basis=sealed.source_basis;assert.deepEqual(basis.expected_counts,{source_additions:494,replacements:22,fingerprint_records:516,external_records:36,independent_expression_leaves:48});
 for(const key of ['source_expected_vector_canonical_sha256','source_expected_vector_gzip_sha256','source_expected_review_sha256'])assert(/^[a-f0-9]{64}$/.test(basis.source_proofs[key]),'published source expectation required');
 assert.equal(sha(JSON.stringify(canonical({records:basis.records,basis:basis.basis}))),basis.fingerprint_input_sha256,'fixed source input commitment');
 const body=bodyOf(sealed.sql),literal209=jsonSQL(synthetic.parent209),literal166=jsonSQL(synthetic.parent166);
 const declaration=' p209 jsonb:=',between=';p166 jsonb:=',suffix=';\n actual_own jsonb;';
 const start=exactlyOnce(body,declaration)+declaration.length,middle=start+literal209.length,next=middle+between.length,end=next+literal166.length;
 assert.equal(body.slice(start,middle),literal209);assert.equal(body.slice(middle,next),between);assert.equal(body.slice(next,end),literal166);assert.equal(body.slice(end,end+suffix.length),suffix);
 assert.equal(exactlyOnce(body,literal209),start);assert.equal(exactlyOnce(body,literal166),next);
 const segments=freeze([body.slice(0,start),body.slice(middle,next),body.slice(end)]);
 assert(segments.every(part=>!part.includes(P209_MARKER)&&!part.includes(P166_MARKER)),'parent DATA fully removed from template');
 const origin=freeze({schema:'order-split210-install-template-origin/v1',candidate:basis.candidate,source_vector_gzip_sha256:basis.source_proofs.source_expected_vector_gzip_sha256,source_vector_canonical_sha256:basis.source_proofs.source_expected_vector_canonical_sha256,source_expectation_result_sha256:basis.source_proofs.source_expected_review_sha256,fingerprint_input_sha256:sealed.fingerprint_input_sha256,fingerprint_query_sha256:sha(sealed.fingerprint_query),basis:basis.basis,expected_counts:basis.expected_counts,body_segment_sha256:segments.map(sha),body_segment_bytes:segments.map(part=>Buffer.byteLength(part)),parent_capture_verified:false,source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false});
 const bind=options=>{
  const captured=parents(options),body=segments[0]+jsonSQL(captured.parent209)+segments[1]+jsonSQL(captured.parent166)+segments[2],sql=wrap(body);
  return freeze({schema:'order-split210-install-bound-program/v1',sql,sha256:sha(sql),bytes:Buffer.byteLength(sql),origin,parent_data_sha256:{original209:digest(captured.parent209),original166:digest(captured.parent166)},parent_capture_requirements:sealed.parent_capture_requirements,parent_capture_verified:false,seal_executed:false,source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false});
 };
 return freeze({schema:'order-split210-install-template/v1',origin,body_segments:segments,bind});
}
