/** Root local genuine159 XML integration. No migration, seed, provider or listener. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
import {buildNative159Fa3DownloadFixture} from '../data/source-drafts/fa3-xml-native-fixture';
import {assertNativeFa3Download} from '../data/source-drafts/fa3-xml-download-native';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const inputBytes=await readFile(resolve(process.argv[2])),input=JSON.parse(inputBytes.toString());
assert.equal(hash(inputBytes),'45940aa7576bbdf8c8edc13802f94656bdbab317db4d0550a482d3b5c0c52406');
const prepBytes=await readFile(resolve(input.directory,'preparation.private.json'));assert.equal(hash(prepBytes),'1ac928a93679b300d635447b987ec5d01581d89cf312db06af5ee320ba368810');const preparation=JSON.parse(prepBytes.toString());
assert.match(input.database,/^dynaminds_test_\d{13}$/);
const url=new URL(input.environment.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55432');assert.equal(url.pathname,'/'+input.database);
const cfgBytes=await readFile(input.configuration.path);assert.equal(hash(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
const directory=resolve(input.directory,'native-xml1');await mkdir(directory,{mode:0o700});
async function save(n:string,v:unknown){const path=resolve(directory,n),b=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,b,{flag:'wx',mode:0o600});return{path,sha256:hash(b)};}
const sources:Record<string,string>={};
async function tree(d:string){for(const e of await readdir(d,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=d+'/'+e.name;if(e.isDirectory())await tree(p);else if(e.isFile()&&/\.(ts|tsx|sql|css|py|xsd|json)$/.test(e.name))sources[resolve(p)]=hash(await readFile(p));}}
await tree('server');await tree('web');await tree('data/source-drafts/fa3-xml-official-xsd');
for(const p of ['scripts/fa3-xml-native-run.ts','data/source-drafts/fa3-xml-native-fixture.ts','data/source-drafts/b2b-fa3-native-acceptance-fixtures2.ts','data/source-drafts/b2b-fa3-invoice159-issued-reader166.ts','data/source-drafts/b2b-fa3-invoice159-native-acceptance-oracles166.ts','data/source-drafts/fa3-xml-download-native.ts','data/source-drafts/fa3-xml-xsd-oracle.py','data/source-drafts/b2b-financial-return162-root-capture189.ts','scripts/stocktake-adjustments-native164-preservation.ts','scripts/return-destinations-native162-restore-readback.ts','package.json','package-lock.json'])sources[resolve(p)]=hash(await readFile(p));
for(const[p,h]of Object.entries({'server/fa3-xml.ts':'26ab291d2766ea1ecc50bc9fb55f13f94d4efbde4fe11fe87563b58e00648754','server/fa3-xml-routes.ts':'7bb9de77b1bebc91f96f3f9922b64922f6273d7638579dd8a8435106b0995a30','server/b2b-invoice-routes.ts':'49b0b7575b84e452daac2757d13f1e948b6abe16f2a0ff065dfeaa45749f1374','server/developer-api.ts':'3ad1740390b9ccbbc97197610e0d1689aa0267950ea4dcea908ac0b63d8e9433','data/source-drafts/fa3-xml-native-fixture.ts':'e14ddf1b6296d7c27a48d2fda1494e3c201fcc3f691a90036a6b7320f07f627f','data/source-drafts/fa3-xml-download-native.ts':'af199cba148a279d1aad0a2d81bcd157b01e699caaf51e7ead06a38dafbb1742'}))assert.equal(sources[resolve(p)],h);
const sourcesRef=await save('sources.private.json',sources),inputRef=await save('input-reference.private.json',{path:resolve(process.argv[2]),sha256:hash(inputBytes)});
const make=(database:string)=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database});
async function exclusive(){const c=make('postgres');try{await c.connect();assert.equal((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[input.database])).rows[0].n,0);}finally{await c.end();}}
async function captureWhole(){const c=make(input.database);try{await c.connect();const s=await captureDatabase(c,false);s.guards.competitor_observation_guards=(await c.query('SELECT competitor_observation_guards() ok')).rows[0].ok;s.guards.buyer_address_guards=(await c.query('SELECT buyer_address_guards() ok')).rows[0].ok;s.guards.operative_delivery_valid=(await c.query('SELECT operative_delivery_valid() ok')).rows[0].ok;assert.equal(Object.keys(s.graph.rows).length,562);assert.equal(s.graph.rows.migrations.length,167);assert(Object.values(s.guards).every(v=>v===true));return s;}finally{await c.end();}}
await exclusive();const before=await captureWhole(),beforeRef=await save('before.private.json',before);
const preparedCopy=await readFile(preparation.copy.path);assert.equal(hash(preparedCopy),preparation.copy.sha256);assert.deepEqual(before,JSON.parse(preparedCopy.toString()),'Fresh accepted clone continuity before fixture');
Object.assign(process.env,input.environment);process.env.DYNA_TEST='true';process.env.DYNA_IMAGE_DIR=input.images;
let providerCalls=0;const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{++providerCalls;throw Error('External provider fetch forbidden');};
const guard=async()=>{++providerCalls;throw Error('External provider transport forbidden');};
const {pool}=await import('../server/db'),{buildApp}=await import('../server/app'),{processB2bCatalog}=await import('../server/b2b-network');
const app=await buildApp({logging:false,backgroundWorkersEnabled:false,integrationTransport:guard});
let readonlyApp:Awaited<ReturnType<typeof buildApp>>|undefined,failure:unknown,result:unknown;
try{
 const fixture=await buildNative159Fa3DownloadFixture({deps:{app,pool,processB2bCatalog},directory:resolve(directory,'genuine-fixture'),expectedDatabase:input.database,sourcePins:sources,getProviderCalls:()=>providerCalls});
 const afterFixture=await captureWhole(),afterFixtureRef=await save('after-fixture.private.json',afterFixture);
 for(const[n,rows]of Object.entries(before.graph.rows)as[string,any[]][]){const next=new Set(afterFixture.graph.rows[n].map((r:any)=>hash(JSON.stringify(r))));for(const r of rows)assert(next.has(hash(JSON.stringify(r))),'Every existing row retained: '+n);}
 assert.deepEqual(afterFixture.graph.exact_metadata,before.graph.exact_metadata);assert.deepEqual(afterFixture.primary_keys,before.primary_keys);assert.deepEqual(afterFixture.views,before.views);
 for(const s of before.sequences)assert.deepEqual(afterFixture.sequences.find((n:any)=>n.name===s.name)?.options,s.options);
 const nativeInputsBytes=await readFile(fixture.artifacts.nativeInputs.path);assert.equal(hash(nativeInputsBytes),fixture.artifacts.nativeInputs.sha256);const {required_root_additions,...nativeInputs}=JSON.parse(nativeInputsBytes.toString());
 const credBytes=await readFile(fixture.artifacts.signup1.path);assert.equal(hash(credBytes),fixture.artifacts.signup1.sha256);const creds=JSON.parse(credBytes.toString());
 readonlyApp=await buildApp({readOnly:true,previewPort:4195,logging:false,backgroundWorkersEnabled:false,integrationTransport:guard});
 const login=await readonlyApp.inject({url:'/api/auth/login',method:'POST',payload:{email:creds.email,password:creds.password},remoteAddress:'127.159.1.1'});assert.equal(login.statusCode,200,'Actual readOnly password login');
 const raw=login.headers['set-cookie'];assert.equal(typeof raw,'string');const cookie=String(raw).split(';')[0];assert(cookie.startsWith('dyna_session_preview_4195='));
 const readonlyHeaders={cookie};const me=await readonlyApp.inject({url:'/api/auth/me',headers:readonlyHeaders});assert.equal(me.statusCode,200);assert.equal(me.json().restore_preview,true);assert.equal(me.json().user.id,creds.user_id);assert.equal(me.json().user.tenant_id,creds.tenant_id);assert.equal(me.json().user.role,'admin');
 const afterLogin=await captureWhole(),afterLoginRef=await save('after-login.private.json',afterLogin);
 const sessions=afterLogin.graph.rows.sessions;assert.equal(sessions.length,afterFixture.graph.rows.sessions.length+1);
 for(const r of afterFixture.graph.rows.sessions)assert(sessions.some((n:any)=>hash(JSON.stringify(n))===hash(JSON.stringify(r))));
 assert.deepEqual({...afterLogin,graph:{...afterLogin.graph,rows:{...afterLogin.graph.rows,sessions:afterFixture.graph.rows.sessions}}},afterFixture,'Only one genuine readonly session added');
 const acceptance=await assertNativeFa3Download({...nativeInputs,app,readonlyApp,readonlyHeaders,captureWhole});
 const after=await captureWhole(),afterRef=await save('after.private.json',after);assert.deepEqual(after,afterLogin);
 for(const[p,h]of Object.entries(sources))assert.equal(hash(await readFile(p)),h);assert.equal(hash(await readFile(input.configuration.path)),input.configuration.sha256);assert.equal(providerCalls,0);
 result={status:'ROOT_NATIVE159_FA3_XML_LOCAL_PASS',database:input.database,tables:562,migrations:167,guards:Object.keys(after.guards).length,actual_issued_invoices:2,actual_keys_created:3,actual_key_revoked:1,genuine_readonly_password_login:true,readonly_scope:'SAME_OWNED_DB_APP_MODE_NOT_RESTORED_COPY',whole_get_and_refusal_capture_literal:true,every_existing_row_and_metadata_retained:true,provider_calls:providerCalls,ksef_submission_executed:false,chrome:'NOT_RUN',sources:sourcesRef,input:inputRef,before:beforeRef,after_fixture:afterFixtureRef,after_login:afterLoginRef,after:afterRef,fixture:fixture.result_artifact,acceptance};
}catch(e){failure=e;await save('failure.private.json',{name:(e as any)?.name,message:(e as any)?.message,code:(e as any)?.code,stack:(e as any)?.stack});}
finally{
 const closed=await Promise.allSettled([app.close(),...(readonlyApp?[readonlyApp.close()]:[])]);if(closed.some(r=>r.status==='rejected'))failure??=Error('App closure failed');
 try{await pool.end();await exclusive();assert.equal(providerCalls,0);await save('cleanup.private.json',{status:failure?'FAILED':'PASS',owned_clients_closed:true,provider_calls:providerCalls});}catch(e){failure??=e;}
 globalThis.fetch=savedFetch;
}
if(failure){console.log(JSON.stringify({status:'ROOT_NATIVE159_FA3_XML_LOCAL_FAILED',directory}));process.exitCode=1;}else console.log(JSON.stringify({status:'ROOT_NATIVE159_FA3_XML_LOCAL_PASS',result:await save('result.private.json',result)}));
