/** Opt-in real Native210 integrity ONLY. No seed/install/seal/COMMIT/business acceptance.
 * Every scenario uses a fresh backend, the same8s query budgets, an owned numeric
 * compiler scratch, SAVEPOINT mutation restoration, and final ROLLBACK/end ACK. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const enabled=process.env.DYNA_NATIVE210_GUARD_QA==='true';
const options={skip:!enabled,concurrency:false,timeout:120000};
export const NATIVE210_EXPECTED_TESTS=27;
const SQL210="685c16fbf6fdf35f1b95752e7672e6df484ec865d0fa2cf5a20da5801da3dc73";
const SQL210_BYTES=4525572;
const SQL209='0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a';
const SOURCE_VECTOR_SHA256="0143a44ace2ff5eac97ccb39283e63879198c8092ef60b56b3c0561d6d14c9a9";
const SOURCE_VECTOR_BYTES=346866;
const SOURCE_VECTOR_CANONICAL_SHA256="cbe9a4819d11454443422879b851636c51e7ae7108677b5d24a48b172a502b32";
const SEAL_MODULE_SHA256="1fea1575ee3874e0d3c31d75c1aadd6c51e0753fadff665d29bbe93d2fbca4b9";
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v!==null&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),keys.slice().sort());};
const absolute=v=>typeof v==='string'&&path.isAbsolute(v)&&path.resolve(v)===v&&!/[\x00-\x1f\x7f]/.test(v);
const cut=s=>[s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
const quote=v=>{assert(/^[a-z_][a-z_0-9]{0,62}$/.test(v));return '"'+v+'"';};
export function validateNative210Locator(v){
 exact(v,['schema','databaseUrl','expectedDatabase','expectedPort','ownershipMarker','source209SqlPath','source210SqlPath','sourceExpectedPath','sourceExpectedSha256','controlRowsPath','controlRowsSha256','receiptDirectory']);
 assert.equal(v.schema,'dynaminds-native210-integrity-locator/v1');assert(typeof v.databaseUrl==='string'&&v.databaseUrl.length<4096);
 const u=new URL(v.databaseUrl);assert(['postgres:','postgresql:'].includes(u.protocol));assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'postgres');assert(u.password&&!u.search&&!u.hash);
 assert(Number.isInteger(v.expectedPort)&&v.expectedPort>=1024&&v.expectedPort<=65535);assert.equal(u.port,String(v.expectedPort));assert(/^dynaminds_test_[0-9]{13}$/.test(v.expectedDatabase));assert.equal(u.pathname,'/'+v.expectedDatabase);
 assert(/^dynaminds-source210-sealed-compiler:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.ownershipMarker));
 for(const k of ['source209SqlPath','source210SqlPath','sourceExpectedPath','controlRowsPath','receiptDirectory'])assert(absolute(v[k]));
 assert.equal(v.sourceExpectedSha256,SOURCE_VECTOR_SHA256);assert(/^[a-f0-9]{64}$/.test(v.controlRowsSha256));return Object.freeze({...v});
}
async function bounded(file,max,{privateFile=true,expected}={}){
 assert(absolute(file));assert.equal(await fs.realpath(file),file);const s=await fs.lstat(file,{bigint:true});
 assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.uid===BigInt(process.getuid())&&s.size>0n&&s.size<=BigInt(max));if(privateFile)assert.equal(s.mode&0o777n,0o600n);
 const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let first,bytes;
 try{assert.equal(cut(await h.stat({bigint:true})),cut(s));bytes=Buffer.alloc(Number(s.size)+1);let used=0;while(used<bytes.length){const r=await h.read(bytes,used,bytes.length-used,used);if(!r.bytesRead)break;used+=r.bytesRead;}assert.equal(used,Number(s.size));assert.equal(cut(await h.stat({bigint:true})),cut(s));assert.equal(cut(await fs.lstat(file,{bigint:true})),cut(s));assert.equal(await fs.realpath(file),file);bytes=bytes.subarray(0,used);if(expected)assert.equal(sha(bytes),expected);return bytes;}
 catch(e){first=e;throw e;}finally{try{await h.close();}catch(e){if(!first)throw e;}}
}
export async function loadNative210Locator(file){try{const bytes=await bounded(file,16384);try{return validateNative210Locator(JSON.parse(bytes.toString('utf8')));}finally{bytes.fill(0);}}catch{throw Error('Invalid private Native210 QA locator');}}
const locator=enabled?await loadNative210Locator(process.env.DYNA_NATIVE210_GUARD_QA_PRIVATE):undefined;
const sourceBase=new URL('../tools/parity/',import.meta.url);
async function sourceBasis(l){
 const pins={"order-split210-layer.mjs":"bf601f71814ce5b74127b8364b8de627e85927728f9e38cb206b24a4551a76e3","order-split210-source.mjs":"67a44d268476a53806503be6f71902a81e643080b42b79479175a7da0c999e80","order-split210-closure.mjs":"a71a21970a395abfccf1fbb9fdb200bd008158066c962dbc5a6b4f06ff37bf4a","order-split210-addition-oracle.mjs":"debfecae01d8d1ba28edfa48941b06303f09add7f18c8d9c9b9fb3829e445949","order-split210-buyer-successor.mjs":"43ae3f3e16a97d558a59777ed517e8a885832923ca63bc2a438a8997626276bb","order-split210-financial-successor.mjs":"3d3167469acb9e37fb6dabaa56d5c6162017e11992e88308aea3766af9e6f6ab","order-split210-financial-predecessor.mjs":"b4cdc98e84838e8e62baf7bb133c73ba9c8304ee3136829be84b34e8a0289e0e","order-split210-history-operative-successor.mjs":"371210d3bf84a8a443bbc907884fcc512d94f82446ab587238d3ae464ac953d7","order-split210-history-buyer-successor.mjs":"5a5596cf235a9be1d1105b3bb5630874d462b60d5b14c34cba2ebdfa93c17ae8","order-split210-startup-operative-successor.mjs":"63c277ba51545108e308e8433f6e875c3f1617b55bcac1c7b480a6ca4ccb0a82","order-split210-ordinary-financial-successor.mjs":"e4680599563373ac25d61005b891f9d63f2f58fa75669630659d3a07ee134fd3","order-split210-metadata-shapes.mjs":"1636efc9d11889d937c77d3302a68b33d816dac8642aa5d4f9897757c9e6dc0e","order-split210-buyer-metadata-shapes.mjs":"32674ab2adf8f8eda8e38a9d644cedcec0467cda866e2c7c6cc6c02021ea0cdf","order-split210-ordinary-metadata-shapes.mjs":"de9defbe38f8f32af920894258e2750ac51b4cc6a8f0c971d644dba5d49d1f14","order-split210-credit-successor.mjs":"52fe5009066b7669d72cf4838e6160618a36333683338a205aac8524ffa70b98","order-split210-manual-projection-successor.mjs":"89d0085567a70cb118cd63a664eeb66e6b8d6a58100e909c5c2c5ada5bba784b","order-split210-history-financial-sharing.mjs":"7771e5b9af04535f1a93ce2506b058bf9288a7dad56826f85ade4b86685a8608","order-split210-metadata-traversal.mjs":"f30e64b7dc390743b51d1f7db1d736fecbb65df22cb9b332e525d335078bebb2","order-split210-metadata-text.mjs":"f081e026bf1c9d9792efa245b7c88363fb8c44a081f7bf9058659b7fea831b48","order-split210-metadata-candidate-filter.mjs":"ec28a380061b45de3591fe1daffb63f86bd43f11662716130e104bd5513a9e83","order-split210-valid-snapshot.mjs":"4e47b1bb4eadcc80da71abbcd6717b872ebdc8da610e75e9cbbdee2e2bc207e7","order-split210-metadata-fresh-map.mjs":"620754f8d453752a26792896373b3d3555ad09ee59a34f0c8f08f4c8589e7c06","order-split210-trigger-constraint-map.mjs":"f201c294ece64e58ac76fa1fb0e8e7ec16498429c95ee9fee0721885aef0a2a2","order-split210-metadata-composite.mjs":"35752645b8e7ff389efa265d829e96a09db34395b6d0ccc599538130eb42551f","order-split210-definition-codec.mjs":"30eeb21ded629690e179f7888d467415b146009a129d3bb5b19a7abe4e2eb212","order-split210-definition-codec-ports.mjs":"0aa423defc37c28c654078d01f95b179a905b7d09a0c1514b216312211baac76","order-split210-valid-snapshot31.mjs":"bfbb4290c18d6a4f96602a9e122f729974a3ecc89d65cf0db56f248b758f3688",'order-split210-frame-schema-column.mjs':'8e9bc109ce6fccacbdb77366c0c1e3d7049b7efad34da34b75858f8d4ec260f9','order-split210-prefix-name-ranges.mjs':'b182f0c01d40b5d3578dfa46e2f6f1b7f4204edf91f8eea5f36d7aeb9e539627','order-split210-constraint-candidates.mjs':'ab48289e03554a3a8f47a607febd865859c8ecd6c9607fe2471b281f772acc9f','order-split210-fixed-seal.mjs':SEAL_MODULE_SHA256};
 assert(/^[a-f0-9]{64}$/.test(SEAL_MODULE_SHA256),'Source fixed seal module must be frozen before Native invocation');
 for(const[n,pin]of Object.entries(pins))await bounded(fileURLToPath(new URL(n,sourceBase)),131072,{privateFile:false,expected:pin});
 await bounded(l.source209SqlPath,28449419,{expected:SQL209});await bounded(l.source210SqlPath,SQL210_BYTES,{expected:SQL210});
 const raw=await bounded(l.sourceExpectedPath,SOURCE_VECTOR_BYTES,{expected:l.sourceExpectedSha256});assert.equal(raw.length,SOURCE_VECTOR_BYTES);const vector=JSON.parse(gunzipSync(raw,{maxOutputLength:33554432}));
 assert.equal(digest(vector),SOURCE_VECTOR_CANONICAL_SHA256);assert.equal(vector.schema,'order-split210-source-expected-vector/v1');assert.equal(vector.candidate.sha256,SQL210);assert.equal(vector.candidate.bytes,SQL210_BYTES);assert.equal(vector.additions.length,494);assert.equal(vector.changes.length,22);
 const layer=await import(new URL('order-split210-layer.mjs',sourceBase)),seal=await import(new URL('order-split210-fixed-seal.mjs',sourceBase));
 const sourceBundle=await layer.readOrderSplit210LayerSource({sourcePath:l.source209SqlPath});
 const root=new URL('../',import.meta.url),read=async p=>(await fs.readFile(new URL(p,root))).toString('utf8');
 const names={source104:'104_order_merge_custody.sql',source108:'108_b2b_dropshipping.sql',source160:'160_b2b_credit.sql',source169:'169_manual_inventory_off.sql',source204:'204_partial_commercial_sale_scope.sql'};
 const businessInputs={};for(const[k,n]of Object.entries(names))businessInputs[k]=await read('server/'+n);
 const inputs={sourceBundle,businessInputs,source158:await read('server/158_fa3_draft_native.sql'),source159:await read('server/159_b2b_invoice.sql'),source210:await read('tools/parity/order-split210-business.sql'),sourceTerminal:await read('tools/parity/order-split210-terminal.sql'),sourceSchema:await read('server/schema.sql')};
 const derived=seal.deriveOrderSplit210FixedSealBasis({inputs,expectedAdditions:vector.additions,expectedChanges:vector.changes});
 assert.equal(derived.candidate.sha256,SQL210);assert.equal(derived.candidate.bytes,SQL210_BYTES);assert.deepEqual(derived.expected_counts,{source_additions:494,replacements:22,fingerprint_records:516,external_records:36,independent_expression_leaves:48});assert.equal(derived.source_proofs.source_expected_vector_gzip_sha256,SOURCE_VECTOR_SHA256);assert.equal(derived.source_proofs.source_expected_vector_canonical_sha256,SOURCE_VECTOR_CANONICAL_SHA256);assert.equal(vector.changes.filter(r=>r.kind==='function'&&r.key==='public.buyer_address_guards()').length,1,'buyer is covered by every predecessor mutation batch');assert.equal(vector.changes.filter(r=>r.kind==='function'&&r.key==='public.financial_return_upgrade_valid()').length,1,'sixteenth financial guard is covered by every predecessor mutation batch');for(const key of ['public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)','public.order_merge_delivery209_buyer_guards(manual_basis jsonb)','public.order_merge_delivery209_startup_operative_valid(entries jsonb)','public.ordinary181_financial_valid(manual_basis jsonb)','public.ordinary181_credit_calculate(projection_ok boolean)','public.ordinary180_projection_valid(b jsonb)'])assert.equal(vector.changes.filter(r=>r.kind==='function'&&r.key===key).length,1,'each new source successor is covered by every predecessor mutation batch');
 const controls=JSON.parse((await bounded(l.controlRowsPath,1048576,{expected:l.controlRowsSha256})).toString('utf8'));exact(controls,['parent209','parent166','oldCertificates']);
 exact(controls.oldCertificates,['166','188','207','208']);for(const k of Object.keys(controls.oldCertificates))assert.equal(controls.oldCertificates[k].length,1);assert.deepEqual(controls.oldCertificates['166'][0],controls.parent166);
 return{...derived,additions:vector.additions,changes:vector.changes,controls};
}
let basis; if(enabled){try{basis=await sourceBasis(locator);}catch{throw Error('Invalid source-authenticated Native210 QA basis');}}
export const GENERATION_CONTROL_SQL='SELECT to_jsonb(g) row FROM public.ordinary182_runtime_generation g ORDER BY singleton';
const HISTORICAL_SQL=`SELECT jsonb_build_object('166',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.buyer_address_manifest m),'188',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.local_consumer_credit_manifest m),'207',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.return_credit206_manifest m),'208',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.return_credit208_manifest m)) value`;
async function controls(c){const generation=(await c.query(GENERATION_CONTROL_SQL)).rows;assert.equal(generation.length,1);const parent=(await c.query('SELECT (SELECT to_jsonb(m) FROM public.order_merge_delivery209_manifest m) parent209,(SELECT to_jsonb(m) FROM public.buyer_address_manifest m) parent166')).rows[0];const historical=(await c.query(HISTORICAL_SQL)).rows[0].value;assert.deepEqual({...parent,historical},{parent209:basis.controls.parent209,parent166:basis.controls.parent166,historical:basis.controls.oldCertificates});return digest({parent,historical,generation});}
async function healthy(c,{full=false}={}){
 const budget=(await c.query("SELECT current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout,current_setting('session_replication_role') replication_role")).rows;assert.deepEqual(budget,[{statement_timeout:'8s',lock_timeout:'8s',replication_role:'origin'}]);
 const expected=(await c.query(basis.fingerprint_query)).rows;assert.equal(expected.length,1);assert(/^[a-f0-9]{64}$/.test(expected[0].fingerprint));
 const actual=(await c.query('SELECT public.order_split210_valid() valid,public.order_split210_fingerprint() fingerprint,(SELECT fingerprint FROM public.order_split210_manifest WHERE id) sealed_fingerprint')).rows;
 assert.deepEqual(actual,[{valid:true,fingerprint:expected[0].fingerprint,sealed_fingerprint:expected[0].fingerprint}]);
 const controlHash=await controls(c);
 const parent=(await c.query('SELECT public.order_merge_delivery209_valid() own209,public.buyer_address_guards() buyer166,public.partial_sale204_valid() source204,public.catalog_header205_valid() source205,public.return_credit206_guards() source207')).rows;assert.deepEqual(parent,[{own209:true,buyer166:true,source204:true,source205:true,source207:true}]);
 if(full)for(const name of ['ordinary187_valid','large_import173_valid','pim_dictionary_valid','nested172_valid','parcel_physical_wz_valid','operative_delivery_valid'])assert.deepEqual((await c.query('SELECT public.'+name+'() valid')).rows,[{valid:true}],name+' must be genuinely true within8s');
 return{fingerprint:expected[0].fingerprint,control_sha256:controlHash,parent_predicates:parent[0],full_runtime:full};
}
const REFUSAL=new Set(['23514','42501','55000','42883','42P01','42703','42704']);
async function refused(c){await c.query('SAVEPOINT refusal210');let result;try{const rows=(await c.query('SELECT public.order_split210_valid() valid')).rows;assert.equal(rows.length,1);assert(rows[0].valid===false||rows[0].valid===null,'tampered current source must refuse');result={valid:rows[0].valid};}catch(e){assert(REFUSAL.has(e.code),'Timeout/unexpectedSQLSTATE is not an integrity PASS');result={code:e.code};await c.query('ROLLBACK TO SAVEPOINT refusal210');}await c.query('RELEASE SAVEPOINT refusal210');return result;}
async function identity(c,l){const r=(await c.query("SELECT current_database() database,current_user,session_user,host(inet_server_addr()) address,inet_server_port() port,current_setting('session_replication_role') replication_role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) owner,(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) marker")).rows;assert.equal(r.length,1);for(const[k,v]of Object.entries({database:l.expectedDatabase,current_user:'postgres',session_user:'postgres',address:'127.0.0.1',port:l.expectedPort,replication_role:'origin',owner:'postgres',marker:l.ownershipMarker}))assert.equal(r[0][k],v);}
async function receiptFile(title,value){const dir=locator.receiptDirectory;assert.equal(await fs.realpath(dir),dir);const s=await fs.lstat(dir);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o700);const h=await fs.open(path.join(dir,title+'.private.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await h.writeFile(JSON.stringify(value)+'\n');await h.sync();}finally{await h.close();}const d=await fs.open(dir,constants.O_RDONLY|constants.O_DIRECTORY);try{await d.sync();}finally{await d.close();}}
async function scenario(title,mutate,{full=false}={}){
 const l=await loadNative210Locator(process.env.DYNA_NATIVE210_GUARD_QA_PRIVATE);assert.equal(digest(l),digest(locator));await receiptFile(title+'.attempt',{schema:'native210-integrity-attempt/v1',title,source210_sha256:SQL210});
 const{default:pg}=await import('pg');const c=new pg.Client({connectionString:l.databaseUrl,connectionTimeoutMillis:8000,query_timeout:9000,application_name:'dyna_native210_integrity_owned_scratch',options:'-c timezone=UTC -c jit=off -c statement_timeout=8000 -c lock_timeout=8000'});
 let first,failed=false,began=false;const remember=e=>{if(!failed){failed=true;first=e;}};c.on('error',remember);
 const result={schema:'native210-integrity-only/v1',title,source210_sha256:SQL210,business_acceptance:false,no_seed:true,no_factory:true,commit_performed:false};
 try{await c.connect();if(failed)throw first;await identity(c,l);await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');began=true;await c.query('SELECT pg_advisory_xact_lock(982376)');result.before=await healthy(c,{full});await c.query('SAVEPOINT mutation210');if(mutate)result.probes=await mutate(c);await c.query('ROLLBACK TO SAVEPOINT mutation210');await c.query('RELEASE SAVEPOINT mutation210');result.after=await healthy(c,{full});assert.deepEqual(result.after,result.before);if(failed)throw first;result.restored_exact=true;}
 catch(e){remember(e);result.error={code:typeof e?.code==='string'?e.code:null,name:typeof e?.name==='string'?e.name:null};}
 finally{if(began)try{await c.query('ROLLBACK');result.rollback_confirmed=true;}catch(e){remember(e);result.rollback_confirmed=false;}try{await c.end();result.client_closed=true;}catch(e){remember(e);result.client_closed=false;}c.off('error',remember);result.status=failed?'FAIL':'PASS';await receiptFile(title,result);}
 if(failed)throw Object.assign(Error('Native210 integrity scenario failed: '+title),{code:result.error?.code??'NATIVE210_FAILED'});
}
async function functionRows(c,key){const rows=(await c.query("SELECT p.oid,p.prosrc,pg_get_functiondef(p.oid) definition,format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname||'('||pg_get_function_arguments(p.oid)||')'=$1",[key])).rows;assert.equal(rows.length,1);return rows[0];}
async function functionScope(c,name){return(await c.query("SELECT to_jsonb(p) descriptor,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1 ORDER BY pg_get_function_identity_arguments(p.oid)",[name])).rows;}
async function functionBatch(c,records,kind){const probes=[];for(const record of records){const head=await functionRows(c,record.key),before=await functionScope(c,head.proname);await c.query('SAVEPOINT function210');
 if(kind==='body'){assert.equal(head.definition.split(head.prosrc).length,2);await c.query(head.definition.replace(head.prosrc,()=> '/* Native210 body drift */'+head.prosrc));}
 else if(kind==='header')await c.query('ALTER FUNCTION '+head.signature+' COST 101');
 else if(kind==='acl'){const publicExecute=record.value?.acl?.some(a=>a.grantee==='PUBLIC'&&a.privilege==='EXECUTE')??record.after?.acl?.some(a=>a.grantee==='PUBLIC'&&a.privilege==='EXECUTE');await c.query((publicExecute?'REVOKE EXECUTE ON FUNCTION ':'GRANT EXECUTE ON FUNCTION ')+head.signature+(publicExecute?' FROM PUBLIC':' TO PUBLIC'));}
 else{assert.equal(kind,'overload');await c.query('CREATE FUNCTION public.'+quote(head.proname)+"(integer) RETURNS boolean LANGUAGE sql AS 'SELECT true'");}
 assert.notDeepEqual(await functionScope(c,head.proname),before,'requested function/header/ACL/overload mutation really changed scope');probes.push({key:record.key,kind,refusal:await refused(c)});await c.query('ROLLBACK TO SAVEPOINT function210');await c.query('RELEASE SAVEPOINT function210');assert.deepEqual(await functionScope(c,head.proname),before);}
 return probes;
}
const nativeTest=(name,fn,extra)=>test('Native210 '+name,options,()=>scenario(name,fn,extra));
nativeTest('healthy-source-metadata-and-controls',null);
nativeTest('healthy-full-parent-runtime-and-cold-entrypoints',null,{full:true});
for(const kind of ['body','header','acl','overload']){
 nativeTest('own-functions-'+kind,c=>functionBatch(c,basis.additions.filter(r=>r.kind==='function'),kind));
 nativeTest('twenty-predecessors-'+kind,c=>functionBatch(c,basis.changes,kind));
}
nativeTest('owner-only-function-and-table-ACL',async c=>{const signatures=(await c.query("SELECT p.oid::regprocedure::text signature,NOT has_function_privilege('dyna_app',p.oid,'EXECUTE') denied FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'order_split210_') ORDER BY p.proname")).rows;assert.equal(signatures.length,27);assert(signatures.every(r=>r.denied===true));const tables=(await c.query("SELECT relname,relrowsecurity,relforcerowsecurity,NOT has_table_privilege('dyna_app',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') denied FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND starts_with(relname,'order_split210_') ORDER BY relname")).rows;assert.equal(tables.length,8);assert(tables.every(r=>r.relrowsecurity&&r.relforcerowsecurity&&r.denied));return{functions:27,tables:8};});
for(const kind of ['rls','force-rls','table-acl'])nativeTest(kind+'-drift',async c=>{await c.query(kind==='rls'?'ALTER TABLE public.order_split210_previews DISABLE ROW LEVEL SECURITY':kind==='force-rls'?'ALTER TABLE public.order_split210_previews NO FORCE ROW LEVEL SECURITY':'GRANT SELECT ON public.order_split210_previews TO PUBLIC');return refused(c);});
for(const column of ['payload_jsonb','payload_octets','payload_sha256','payload_schema'])nativeTest('generated-'+column+'-drift',async c=>{await c.query('ALTER TABLE public.order_split210_projection_basis ALTER COLUMN '+quote(column)+' DROP EXPRESSION');return refused(c);});
for(const table of ['order_split210_manifest','order_split210_projection_basis'])nativeTest(table+'-immutable',async c=>{await c.query('SAVEPOINT immutable210');let denied=false;try{await c.query(table==='order_split210_manifest'?"UPDATE public.order_split210_manifest SET fingerprint=repeat('0',64) WHERE id":"UPDATE public.order_split210_projection_basis SET payload=payload||' ' WHERE id");}catch(e){assert.equal(e.code,'23514');denied=true;await c.query('ROLLBACK TO SAVEPOINT immutable210');}await c.query('RELEASE SAVEPOINT immutable210');assert(denied,'actual DATA mutation must reach immutable trigger');return{refusal:'23514'};});
nativeTest('authored-trigger-disabled',async c=>{const trigger=basis.additions.find(r=>r.kind==='trigger'&&!r.value.internal&&r.key.startsWith('public.order_split210_'));assert(trigger);const parts=trigger.key.split('.');assert.equal(parts.length,3);await c.query('ALTER TABLE public.'+quote(parts[1])+' DISABLE TRIGGER '+quote(parts[2]));return refused(c);});
nativeTest('CHECK-constraint-dropped',async c=>{const constraint=basis.additions.find(r=>r.kind==='constraint'&&r.value.kind==='c');assert(constraint);const parts=constraint.key.split('.');await c.query('ALTER TABLE public.'+quote(parts[1])+' DROP CONSTRAINT '+quote(parts[2]));return refused(c);});
nativeTest('projection-generated-write-refusals',async c=>{for(const column of ['payload_jsonb','payload_octets','payload_sha256','payload_schema']){await c.query('SAVEPOINT generated210');let denied=false;try{await c.query('UPDATE public.order_split210_projection_basis SET '+quote(column)+'='+quote(column)+' WHERE id');}catch(e){assert.equal(e.code,'428C9');denied=true;await c.query('ROLLBACK TO SAVEPOINT generated210');}await c.query('RELEASE SAVEPOINT generated210');assert(denied);}return{generated_always:4};});
nativeTest('own-index-renamed',async c=>{
 const key='public.order_split210_single_remainder';assert(basis.additions.some(r=>r.kind==='index'&&r.key===key));
 const before=(await c.query('SELECT pg_get_indexdef($1::regclass) definition',[key])).rows;assert.equal(before.length,1);
 await c.query('ALTER INDEX public.order_split210_single_remainder RENAME TO order_split210_native_qa_index_drift');
 assert.deepEqual((await c.query('SELECT to_regclass($1)::text original',[key])).rows,[{original:null}]);
 const after=(await c.query("SELECT pg_get_indexdef('public.order_split210_native_qa_index_drift'::regclass) definition")).rows;
 assert.notDeepEqual(after,before,'the actual source index identity/definition changed');return refused(c);
});
nativeTest('owner-policy-qualifier-drift',async c=>{
 const record=basis.additions.find(r=>r.kind==='policy');assert(record);const parts=record.key.split('.');assert.equal(parts.length,3);
 const read=async()=> (await c.query('SELECT pg_get_expr(polqual,polrelid) qualifier FROM pg_policy WHERE polrelid=$1::regclass AND polname=$2',[parts.slice(0,2).join('.'),parts[2]])).rows;
 const before=await read();assert.deepEqual(before,[{qualifier:'true'}]);
 await c.query('ALTER POLICY '+quote(parts[2])+' ON public.'+quote(parts[1])+' USING (false)');
 assert.deepEqual(await read(),[{qualifier:'false'}]);return refused(c);
});
nativeTest('source-type-explicit-ACL-drift',async c=>{
 const key='public.order_split210_previews';assert(basis.additions.some(r=>r.kind==='type'&&r.key===key));
 const read=async()=> (await c.query('SELECT to_jsonb(t) descriptor FROM pg_type t WHERE t.oid=$1::regtype',[key])).rows;
 const before=await read();assert.equal(before.length,1);assert.equal(before[0].descriptor.typacl,null);
 await c.query('GRANT USAGE ON TYPE public.order_split210_previews TO dyna_app');
 const after=await read();assert.notDeepEqual(after,before,'explicit type ACL must really differ even when PUBLIC already allows USAGE');assert(Array.isArray(after[0].descriptor.typacl));return refused(c);
});
// This pure check proves only the opt-in gate. Default SKIP is never Native proof.
test('Native210 locator and actual mutation harness fail closed without PG',async()=>{
 const v={schema:'dynaminds-native210-integrity-locator/v1',databaseUrl:'postgres://postgres:controlled@127.0.0.1:57084/dynaminds_test_1234567890123',expectedDatabase:'dynaminds_test_1234567890123',expectedPort:57084,ownershipMarker:'dynaminds-source210-sealed-compiler:00000000-0000-4000-8000-000000000001',source209SqlPath:'/private/source209.sql',source210SqlPath:'/private/source210.sql',sourceExpectedPath:'/private/vector.json.gz',sourceExpectedSha256:SOURCE_VECTOR_SHA256,controlRowsPath:'/private/controls.json',controlRowsSha256:'b'.repeat(64),receiptDirectory:'/private/receipts'};

 const source182=await fs.open(new URL('../server/182_cold_schema_runtime_admission.sql',import.meta.url),'r');let header;
 try{const b=Buffer.alloc(4096);const r=await source182.read(b,0,b.length,0);header=b.subarray(0,r.bytesRead).toString('utf8');}finally{await source182.close();}
 const generationDeclaration=/CREATE TABLE public\.ordinary182_runtime_generation\(([^;\n]+)\);/.exec(header);assert(generationDeclaration,'actual tracked182table declaration');
 const generationPk=/(?:^|,)([a-z_][a-z_0-9]*) boolean PRIMARY KEY/.exec(generationDeclaration[1]);assert(generationPk);assert.equal(generationPk[1],'singleton');assert.equal(GENERATION_CONTROL_SQL,'SELECT to_jsonb(g) row FROM public.ordinary182_runtime_generation g ORDER BY '+generationPk[1]);
 const controlled=()=>{let state={cost:100,acl:'owner',body:'SELECT true',overload:false},saved;const original=JSON.stringify(state);const seen=[];
  const row=()=>({oid:1,prosrc:state.body,definition:'CREATE OR REPLACE FUNCTION public.controlled210() RETURNS boolean LANGUAGE sql AS $body$'+state.body+'$body$',signature:'public.controlled210()',proname:'controlled210'});
  const c={query:async sql=>{seen.push(sql);
   if(sql.startsWith('SELECT p.oid,p.prosrc'))return{rows:[row()]};
   if(sql.startsWith('SELECT to_jsonb(p) descriptor'))return{rows:[{descriptor:{...state},definition:row().definition},...(state.overload?[{descriptor:{signature:'integer'}}]:[])]};
   if(sql==='SAVEPOINT function210'){saved={...state};return{rows:[]};}
   if(sql==='ROLLBACK TO SAVEPOINT function210'){state={...saved};return{rows:[]};}
   if(sql.startsWith('SAVEPOINT ')||sql.startsWith('RELEASE SAVEPOINT '))return{rows:[]};
   if(sql.startsWith('ALTER FUNCTION ')){state.cost=101;return{rows:[]};}
   if(sql.startsWith('GRANT EXECUTE ')){state.acl='PUBLIC';return{rows:[]};}
   if(sql.startsWith('CREATE FUNCTION ')){state.overload=true;return{rows:[]};}
   if(sql.startsWith('CREATE OR REPLACE FUNCTION ')){state.body='/* Native210 body drift */SELECT true';return{rows:[]};}
   if(sql==='SELECT public.order_split210_valid() valid')return{rows:[{valid:JSON.stringify(state)===original}]};
   throw Error('unexpected controlled SQL');
  }};return{c,seen};};
 for(const kind of ['body','header','acl','overload']){const{c,seen}=controlled();const probes=await functionBatch(c,[{key:'public.controlled210()',value:{acl:[{grantee:'postgres',privilege:'EXECUTE'}]}}],kind);assert.equal(probes.length,1);assert.deepEqual(probes[0].refusal,{valid:false});assert(seen.includes('ROLLBACK TO SAVEPOINT function210'));}
 const timeout={query:async sql=>{if(sql==='SELECT public.order_split210_valid() valid')throw Object.assign(Error('controlled timeout'),{code:'57014'});return{rows:[]};}};await assert.rejects(refused(timeout),/Timeout\/unexpectedSQLSTATE/);
 assert.equal(validateNative210Locator(v).expectedPort,57084);for(const change of [{sourceExpectedSha256:'58d86a31b14b4ff236d131331fc0370df1ac270d8f6fe186c30e9120de6ecb5e'},{sourceExpectedSha256:'13464fcb80007fa21ab0361c5eedaabc17d64db5b7e3e8d2c4bf9f46cac77604'},{sourceExpectedSha256:'8f2ba2f66a4c0bc4ff389ad1602836e4112e36ba8b962fbf979e4714ac61d1cc'},{expectedDatabase:'dynaminds_full_base_preview_20261017'},{databaseUrl:v.databaseUrl.replace('127.0.0.1','example.com')},{ownershipMarker:'unowned'},{expectedFingerprint:'a'.repeat(64)},{sourceExpectedPath:'relative'},{controlRowsSha256:'invalid'},{sourceExpectedSha256:'c'.repeat(64)},{sourceExpectedSha256:'9ef39ca65e0531fd2c72c47ebe7913bd1d43d29d017fbb43f25045d9019e67f0'},{sourceExpectedSha256:'aebab8c9b0f280f16d79bfb43e79ea47558fa6d6e2c100be0f148b92dcbfb870'},{sourceExpectedSha256:'f8704ea5f0f39df36bad8fabaef92949c62cfe93af020a4684c62bd7bdcf7bb6'},{sourceExpectedSha256:'0a0c84bee180f8ecdb5f3a591eec6ae985f32586c3863b9284f759610c2f95bf'},{sourceExpectedSha256:'b5c9f4138a098fb3fc898d735cdd122aaf8e740996f9aaf83da1fca3f2b2b2a1'},{sourceExpectedSha256:'6da80aebbe62021b8c756387e751b7f8be15e6de4c432a40eb09ffdbdbda717d'},{sourceExpectedSha256:'856abe82b1ac00faf13ccc91701a4f445ea5f92910d0207aceb0e451ef04266d'}])assert.throws(()=>validateNative210Locator({...v,...change}));
});
