/** Import-inert ordinary HTTP acceptance. No app/DB/config import, factory, SQL or implicit execution.
 * Root supplies an authorized local synthetic release and existing genuine FV-before-RMA manifests. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
const profiles=new WeakMap(),UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,SHA=/^[a-f0-9]{64}$/;
const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...keys].sort());};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const safePath=p=>p.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g,'[own-id]');
export function validateReturnCredit207OrdinaryProfile(input){
 exact(input,['baseUrl','expectedRevision']);assert(typeof input.baseUrl==='string');const u=new URL(input.baseUrl);
 assert.equal(u.protocol,'http:');assert.equal(u.hostname,'127.0.0.1');assert(Number(u.port)>=1024&&Number(u.port)<=65535);assert.notEqual(u.port,'4100','Main port is excluded');
 assert.equal(u.origin,input.baseUrl);assert.equal(u.pathname,'/');assert(!u.search&&!u.hash&&!u.username&&!u.password);assert(SHA.test(input.expectedRevision),'Exact packaged release SHA required');
 return Object.freeze({...input});
}
async function boundedText(response){
 const reader=response.body?.getReader();assert(reader,'Expected bounded HTTP response');const chunks=[];let size=0;
 try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;assert(size<=4*1024*1024,'Acceptance response budget');chunks.push(r.value);}}
 finally{try{await reader.cancel();}catch{}reader.releaseLock();}
 return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
}
/** fetcher injection exists for focused controlled tests; it never supplies authentication or native authority. */
export function createReturnCredit207OrdinaryTransport(input,fetcher=fetch){
 const profile=validateReturnCredit207OrdinaryProfile(input);assert.equal(typeof fetcher,'function');
 const app=Object.freeze({async inject(request){
  exact(request,['url','method','payload','headers']);assert(['GET','POST'].includes(request.method));
  assert(typeof request.url==='string'&&/^\/api\//.test(request.url)&&!/[\\\x00-\x20\x7f]/.test(request.url));
  const target=new URL(request.url,profile.baseUrl);assert.equal(target.origin,profile.baseUrl);assert(!target.username&&!target.password&&!target.hash&&target.pathname.startsWith('/api/'));
  assert(request.method!=='GET'||request.payload===undefined);const headers={};
  if(request.headers){exact(request.headers,['cookie']);assert(typeof request.headers.cookie==='string'&&!/[\r\n]/.test(request.headers.cookie));headers.cookie=request.headers.cookie;}
  if(request.payload!==undefined)headers['content-type']='application/json';
  let response;try{response=await fetcher(target.href,{method:request.method,headers,body:request.payload===undefined?undefined:JSON.stringify(request.payload),redirect:'error',signal:AbortSignal.timeout(120000)});}
  catch{throw new Error('Local HTTP result unconfirmed; inspect the saved original client key before any retry');}
  assert(response.url===''||new URL(response.url).origin===profile.baseUrl,'Foreign HTTP response origin');
  const text=await boundedText(response),type=response.headers.get('content-type')??'',cookies=response.headers.getSetCookie?.()??[];
  return Object.freeze({statusCode:response.status,headers:Object.freeze({'set-cookie':cookies.length?cookies:response.headers.get('set-cookie'), 'content-type':type,'content-security-policy':response.headers.get('content-security-policy'),'cache-control':response.headers.get('cache-control')}),text:()=>text,json:()=>{assert(/(?:application\/json|\+json)(?:;|$)/i.test(type),'Expected ordinary JSON DTO');return JSON.parse(text);}});
 }});
 profiles.set(app,profile);return app;
}
function validateCases(financial,rejectOnly,mixed){
 assert.equal(financial?.schema,'dynaminds-native-return-credit207-invoice-cases/v1');assert.equal(financial.evidence,'genuine_http_fv157_before_rma_no207_execution');
 assert(Array.isArray(financial.cases)&&financial.cases.length===2);assert.deepEqual(financial.cases.map(f=>f.wms).sort(),[false,true]);
 assert.equal(rejectOnly?.schema,'dynaminds-native-return-credit207-reject-only-case/v1');assert.equal(rejectOnly.evidence,financial.evidence);
 const cases=[...financial.cases.map(f=>({...f,kind:'commercial'})),{...rejectOnly.case,kind:'reject_only'}];
 if(mixed!==undefined){
  assert(['dynaminds-native-return-credit207-mixed-case/v1','dynaminds-native-return-credit207-mixed-case/v2'].includes(mixed?.schema),'Pinned genuine mixed manifest required');assert.equal(mixed.evidence,'genuine_http_fv157_rma169_credit188_before_rejected148_then_destinations169_no207_execution');
  assert.deepEqual(mixed.expected,{original_gross_minor:'4401',legacy_delta_minor:'-1000',legacy_after_minor:'3401',successor_delta_minor:'-1700',remaining_minor:'1701'});
  const f=mixed.case;assert(f&&f.wms===false);
  for(const key of ['legacy_return_id','legacy_return_receipt_id','legacy_document_id','legacy_receipt_id','legacy_preview_id','legacy_preview_client_key','legacy_issue_client_key','later_return_id','physical_receipt_id','no_change_physical_receipt_id'])assert(UUID.test(f[key]),'Genuine mixed history identity required');assert(SHA.test(f.legacy_scope_hash));
  const pb=f.legacy_preview_request,ib=f.legacy_issue_request,p=f.legacy_preview,d=f.legacy_document,r=f.legacy_receipt;
  exact(pb,['client_key','original_document_id','return_id','expected_return_version','reason','ordinary_domestic_confirmed','local_only']);exact(ib,['client_key','scope_hash','confirmed','local_only']);
  assert.equal(pb.client_key,f.legacy_preview_client_key);assert.equal(pb.original_document_id,f.original_document_id);assert.equal(pb.return_id,f.legacy_return_id);assert.equal(typeof pb.expected_return_version,'string');assert(/^[1-9][0-9]{0,18}$/.test(pb.expected_return_version));assert.equal(typeof pb.reason,'string');assert(pb.reason.trim().length>=3&&pb.reason.length<=500);assert.equal(pb.ordinary_domestic_confirmed,true);assert.equal(pb.local_only,true);
  assert.equal(ib.client_key,f.legacy_issue_client_key);assert.equal(ib.scope_hash,f.legacy_scope_hash);assert.equal(ib.confirmed,true);assert.equal(ib.local_only,true);
  assert.equal(p?.id,f.legacy_preview_id);assert.equal(p.scope_hash,f.legacy_scope_hash);assert.equal(p.original_document_id,f.original_document_id);assert.equal(p.return_id,f.legacy_return_id);assert(p.snapshot&&Number.isFinite(Date.parse(p.expires_at)));assert.equal(p.snapshot.reason,pb.reason);assert.equal(p.snapshot.return_version,pb.expected_return_version);
  assert.equal(d?.id,f.legacy_document_id);assert.equal(d.order_id,f.order_id);assert.equal(d.original_document_id,f.original_document_id);assert.equal(d.return_id,f.legacy_return_id);assert.equal(d.mode,'local_consumer_credit');assert.equal(d.kind,'correction');assert.equal(d.data.calculation.totals.delta.gross_minor,'-1000');assert.equal(d.data.calculation.totals.after.gross_minor,'3401');
  assert.equal(r?.id,f.legacy_receipt_id);assert.equal(r.document_id,d.id);assert.equal(r.preview_id,p.id);assert.equal(r.client_key,ib.client_key);assert.equal(r.scope_hash,ib.scope_hash);assert.equal(r.return_receipt_id,f.legacy_return_receipt_id);assert.equal(r.number,d.number);assert.deepEqual(p.snapshot.calculation,d.data.calculation);
  cases.push({...f,kind:'mixed'});
 }
 for(const f of cases){if(f.series_prefix!==undefined)assert(typeof f.series_prefix==='string'&&/^[A-Z][A-Z0-9-]{0,19}$/.test(f.series_prefix),'Explicit business series prefix required');for(const key of ['tenant_id','order_id','original_document_id','original_receipt_id','original_preview_id'])assert(UUID.test(f[key]),'Genuine case identity required');assert(SHA.test(f.original_scope_hash));assert.equal(typeof f.wms,'boolean');if(f.kind==='commercial')assert(UUID.test(f.physical_receipt_id));if(f.no_change_physical_receipt_id!=null)assert(UUID.test(f.no_change_physical_receipt_id));if(f.kind==='reject_only')assert(UUID.test(f.no_change_physical_receipt_id));}
 assert.equal(new Set(cases.map(f=>f.tenant_id)).size,cases.length);assert.equal(new Set(cases.map(f=>f.order_id)).size,cases.length);return cases;
}
const root='/api/consumer-return-credits',old='/api/local-consumer-credits';
const cookieOf=response=>{const cookies=response.headers['set-cookie'];assert(cookies,'Ordinary login/switch must issue its real session cookie');return(Array.isArray(cookies)?cookies:[cookies]).map(x=>x.split(';')[0]).join('; ');};
const freezeJson=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeJson(child);Object.freeze(value);}return value;};
const seriesKeys=['client_key','name','prefix'],previewKeys=['client_key','original_document_id','return_id','expected_return_version','series_id','expected_series_version','reason','ordinary_domestic_confirmed','local_only'];
/** Explicit continuation input is copied from the caller's existing private
 * progress sink. Keys and exact original bodies are mandatory. A missing 503
 * rollback DTO (including an old run that failed to save it) is not repairable
 * with a later GET 404. The runner never manufactures that evidence. */
function validateResume(input,cases){
 if(input===undefined)return undefined;
 exact(input,['schema','confirmed','tenant_id','order_id','actor_id','series_command_key','preview_command_key','series_request','preview_request','physical_history_hash','preview_failure']);
 assert.equal(input.schema,'dynaminds-return-credit207-preview-resume/v1');assert.equal(input.confirmed,true,'Explicit original-preview continuation required');
 for(const key of ['tenant_id','order_id','actor_id','series_command_key','preview_command_key'])assert(UUID.test(input[key]),'Exact original resume identity required');assert(SHA.test(input.physical_history_hash));
 assert(cases[0].kind==='commercial'&&cases[0].tenant_id===input.tenant_id&&cases[0].order_id===input.order_id,'Only the first commercial case can explicitly resume');
 const sb=input.series_request,pb=input.preview_request,f=input.preview_failure;exact(sb,seriesKeys);exact(pb,previewKeys);
 assert.equal(sb.client_key,input.series_command_key);assert.equal(sb.name,'Korekty zwrotów');assert.equal(sb.prefix,cases[0].series_prefix??(cases[0].wms?'ZWROT-ON':'ZWROT-OFF'));
 assert.equal(pb.client_key,input.preview_command_key);assert.equal(pb.original_document_id,cases[0].original_document_id);for(const key of ['return_id','series_id'])assert(UUID.test(pb[key]));for(const key of ['expected_return_version','expected_series_version'])assert(typeof pb[key]==='string'&&/^[1-9][0-9]{0,18}$/.test(pb[key]));assert.equal(pb.reason,'Zwrot części pozycji');assert.equal(pb.ordinary_domestic_confirmed,true);assert.equal(pb.local_only,true);
 // A 404 alone does not establish rollback. This must be the actual saved
 // acknowledged error event; absent facts cannot be reconstructed by this API.
 exact(f,['phase','revision','method','resource','http_status','expected_status','body','body_sha256','body_bytes']);assert.equal(f.phase,'unexpected_http_response');assert(SHA.test(f.revision));assert.equal(f.method,'POST');assert.equal(f.resource,root+'/previews');assert.equal(f.http_status,503);assert.equal(f.expected_status,201);assert(SHA.test(f.body_sha256));assert(Number.isSafeInteger(f.body_bytes)&&f.body_bytes>0&&f.body_bytes<=4*1024*1024);
 assert(f.body&&typeof f.body==='object'&&!Array.isArray(f.body));assert.equal(f.body.write_outcome,'failed_before_write','An acknowledged rollback is required; GET 404 alone cannot authorize continuation');assert.equal(f.body.actor_id,input.actor_id);assert.equal(f.body.tenant_id,input.tenant_id);assert.equal(f.body.operation,'preview');assert.equal(f.body.client_key,input.preview_command_key);
 return freezeJson(structuredClone(input));
}
function durableBody(url,body,secrets){
 const keys=url===root+'/series'?seriesKeys:url===root+'/previews'?previewKeys:url===old+'/previews'?['client_key','original_document_id','return_id','expected_return_version','reason','ordinary_domestic_confirmed','local_only']:url.endsWith('/issue')?['client_key','scope_hash','confirmed','local_only']:null;
 assert(keys,'Only known business writes may enter durable progress');exact(body,keys);const value=structuredClone(body),text=JSON.stringify(value);assert(!secrets.some(secret=>secret&&text.includes(secret))&&!/\b(?:Bearer|Basic)\s+\S+|\b(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i.test(text),'Credentials are forbidden in durable business payloads');return freezeJson(value);
}
function safeHttpFailure(response,{method,resource,expectedStatus,secrets}){
 const raw=response.text(),allowed=new Set(['detail','message','error','code','status','statusCode','name','write_outcome','operation','client_key','actor_id','tenant_id','request_id']);let budget=8192;
 const clean=(value,depth=0)=>{
  if(depth>4||budget<=0)return'[TRUNCATED]';budget-=16;
  if(typeof value==='string'){let text=value;for(const secret of [...secrets].filter(Boolean).sort((a,b)=>b.length-a.length))text=text.split(secret).join('[REDACTED]');text=text.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi,'[REDACTED AUTH]').replace(/\b((?:postgres(?:ql)?|https?):\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[REDACTED]@').replace(/\b(?:password|token|secret|cookie|authorization|api[_-]?key|session(?:_id)?)\s*["']?\s*[:=]\s*["']?[^\s,;"']+/gi,'[REDACTED SECRET]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED TOKEN]');const length=Math.max(0,Math.min(2048,budget));budget-=Math.min(text.length,length);return text.length>length?text.slice(0,length)+'[TRUNCATED]':text;}
  if(value===null||typeof value==='boolean'||typeof value==='number')return value;
  if(Array.isArray(value))return value.slice(0,16).map(child=>clean(child,depth+1));
  if(value&&typeof value==='object'){const entries=Object.entries(value),kept=entries.filter(([key])=>allowed.has(key));return{...Object.fromEntries(kept.slice(0,32).map(([key,child])=>[key,clean(child,depth+1)])),...(kept.length!==entries.length?{_redacted_fields:entries.length-kept.length}:{})};}return'[REDACTED]';
 };
 let body;try{body=clean(JSON.parse(raw));if(Buffer.byteLength(JSON.stringify(body))>16384)body={content:'[REDACTED OVERSIZE JSON]'};}catch{body={format:'non_json',content:'[REDACTED]'};}
 return freezeJson({method,resource,http_status:response.statusCode,expected_status:expectedStatus,body,body_sha256:createHash('sha256').update(raw).digest('hex'),body_bytes:Buffer.byteLength(raw)});
}
/** The receipt covers ordinary API observables. Private Native/PG/scale/UI acceptance is separate.
 * A real caller must persist the awaited progress event before dispatch; in-memory
 * command locators retain failure evidence but are not a durable execution journal. */
export async function runReturnCredit207OrdinaryAcceptance({app,login,financialManifest,rejectOnlyManifest,mixedManifest,expectedRevision,onProgress,resume:resumeInput}){
 const profile=profiles.get(app);assert(profile,'Use the code-owned local ordinary HTTP transport');assert.equal(expectedRevision,profile.expectedRevision);exact(login,['email','password']);assert(typeof login.email==='string'&&login.email.length<=254&&login.email.includes('@'));assert(typeof login.password==='string'&&login.password.length>=8&&login.password.length<=1024);assert.equal(typeof onProgress,'function','Explicit progress sink required before any ordinary acceptance request');
 const cases=validateCases(financialManifest,rejectOnlyManifest,mixedManifest),trace=[],results=[],originalCommands=[],responseFailures=[];let cookie,pending=null,activeResume=false,resume;
 const resumeContext=()=>resumeInput?Object.fromEntries(['tenant_id','order_id','actor_id','series_command_key','preview_command_key'].filter(key=>UUID.test(resumeInput[key])).map(key=>[key,resumeInput[key]])):undefined;
 try{resume=validateResume(resumeInput,cases);}catch(error){error.code='RESUME_REFUSED_MISSING_OR_INVALID_EVIDENCE';error.acceptanceProgress={revision:expectedRevision,status:'RESUME_REFUSED_MISSING_OR_INVALID_EVIDENCE',resume_context:resumeContext(),pending_command:null,original_commands:[],response_failures:[],completed_cases:[],trace:[]};throw error;}
 const secrets=()=>[login.email,login.password,...(cookie?[cookie,...cookie.split(';').map(part=>{const clean=part.trim();return clean.slice(clean.indexOf('=')+1);})]:[])];
 async function request(url,method='GET',payload=undefined,status=200,{html=false,anonymous=false,onResponse=undefined}={}){
  const response=await app.inject({url,method,payload,headers:anonymous||!cookie?undefined:{cookie}});trace.push({method,path:url,status:response.statusCode});onResponse?.(response.statusCode);
  if(response.statusCode!==status){const failure=safeHttpFailure(response,{method,resource:url,expectedStatus:status,secrets:secrets()});responseFailures.push(failure);await onProgress({phase:'unexpected_http_response',revision:expectedRevision,...failure});try{assert.equal(response.statusCode,status,`${method} ${safePath(url)}: expected ${status}, received ${response.statusCode}`);}catch(error){error.httpFailure=failure;throw error;}}
  if(html){assert(/^text\/html(?:;|$)/i.test(response.headers['content-type']));return{value:response.text(),response};}
  return{value:response.json(),response};
 }
 const get=async url=>(await request(url)).value;
 async function resumeIdentity(){const me=await get('/api/auth/me');assert(me.restore_preview===false&&me.read_only!==true&&me.user?.id===resume.actor_id&&me.user?.tenant_id===resume.tenant_id&&me.user?.role==='admin','Original writable admin identity required for explicit continuation');return me;}
 async function write(operation,url,body,status=201){if(activeResume)await resumeIdentity();const saved=durableBody(url,body,secrets()),original=Object.freeze({operation,client_key:saved.client_key,resource:url});pending=original;originalCommands.push(Object.freeze({...original,phase:'intent',http_status:null}));await onProgress({phase:'before_financial_request',...original,request_body:saved});const {value,response}=await request(url,'POST',saved,status,{onResponse:http_status=>originalCommands.push(Object.freeze({...original,phase:'acknowledged',http_status}))});await onProgress({phase:'financial_result_received',...original,http_status:response.statusCode});pending=null;return value;}
 async function pages(url,{cursorField='next_cursor',query='cursor',max=10}={}){const data=[],seen=new Set();let cursor=null;for(let i=0;i<max;i++){const value=await get(url+(cursor?(url.includes('?')?'&':'?')+new URLSearchParams({[query]:cursor}):''));assert(Array.isArray(value.data));data.push(...value.data);const next=cursorField==='meta.cursor'?value.meta?.cursor:value[cursorField];assert(next===null||typeof next==='string','Explicit complete-page marker required');if(next===null)return data;assert(!seen.has(next),'Repeated pagination cursor');seen.add(next);cursor=next;}throw Error('Acceptance full-read page budget exceeded');}
 async function observables(f){const stock=await pages('/api/inventory?limit=200',{cursorField:'meta.cursor',query:'after'}),movements=await pages('/api/inventory/movements?limit=200',{cursorField:'meta.cursor',query:'after'});const warehouses=(await get('/api/warehouses')).data;assert(Array.isArray(warehouses)&&warehouses.length<=20);const locations=[];for(const wh of warehouses){assert(UUID.test(wh.id));locations.push(...await pages('/api/stock-locations?'+new URLSearchParams({warehouse_id:wh.id,limit:'100'}),{cursorField:'meta.cursor',query:'after'}));}const payments=await get('/api/orders/'+f.order_id+'/payments');assert.equal(payments.next,null,'Full payment read required');return{stock,movements,locations,payments};}
 const listSeries=async()=>{const r=await get(root+'/series');assert(Array.isArray(r.data)&&r.data.length<=100);return r.data;};
 const register=()=>pages(root+'/documents');
 const flags=v=>{assert.equal(v.available,true);assert.equal(v.read_only,false);assert.equal(v.can_read,true);};
 function original(source,f){flags(source);assert.equal(source.original.document.id,f.original_document_id);assert.equal(source.original.receipt.id,f.original_receipt_id);assert.equal(source.original.receipt.scope_hash,f.original_scope_hash);assert.equal(source.original.document.data.currency,'PLN');assert.equal(source.original.document.data.totals.gross_minor,'4401');assert(SHA.test(source.physical_history_hash));assert(Array.isArray(source.rejected_inspections)&&Array.isArray(source.previous_credits)&&Array.isArray(source.series));}
 async function oldRefusal(f,returnId,version){const before=await pages(old+'/documents'),client_key=randomUUID();const refused=await write('legacy_preview',old+'/previews',{client_key,original_document_id:f.original_document_id,return_id:returnId,expected_return_version:String(version),reason:'Kontrola właściwego procesu korekty',ordinary_domestic_confirmed:true,local_only:true},409);assert.equal(refused.write_outcome,'failed_before_write','Legacy refusal must have an acknowledged rollback');await request(old+'/commands/'+client_key+'?operation=preview','GET',undefined,404);assert.deepEqual(await pages(old+'/documents'),before);}
 async function legacyHistory(f,{replay=false}={}){
  const d=f.legacy_document,r=f.legacy_receipt,p=f.legacy_preview,rows=await pages(old+'/documents');assert.equal(rows.length,1);assert.equal(rows[0].id,d.id);assert.equal(rows[0].number,d.number);assert.equal(rows[0].totals.gross_minor,'-1000');
  const checkDocument=v=>{flags(v);assert.deepEqual(v.document,d);assert.deepEqual(v.receipt,r);};
  const checkPreview=v=>{flags(v);assert.equal(v.preview.id,p.id);assert.equal(v.preview.scope_hash,p.scope_hash);assert.deepEqual(v.preview.snapshot,p.snapshot);assert.equal(v.preview.issued_document_id,d.id);assert.equal(v.preview.can_issue,false);};
  checkDocument(await get(old+'/documents/'+d.id));checkPreview(await get(old+'/previews/'+p.id));
  const pc=await get(old+'/commands/'+f.legacy_preview_client_key+'?operation=preview');assert.equal(pc.operation,'preview');assert.equal(pc.client_key,f.legacy_preview_client_key);checkPreview(pc);
  const ic=await get(old+'/commands/'+f.legacy_issue_client_key+'?operation=issue');assert.equal(ic.operation,'issue');assert.equal(ic.client_key,f.legacy_issue_client_key);checkDocument(ic);
  if(replay){
   // These are the captured original request objects, not newly assembled bodies.
   const pr=await write('legacy_historical_preview_replay',old+'/previews',f.legacy_preview_request,200);assert.equal(pr.reused,true);checkPreview(pr);
   const ir=await write('legacy_historical_issue_replay',old+'/previews/'+p.id+'/issue',f.legacy_issue_request,200);assert.equal(ir.reused,true);checkDocument(ir);
   const client_key=randomUUID(),refused=await write('legacy_new_issue',old+'/previews/'+p.id+'/issue',{...f.legacy_issue_request,client_key},409);assert.equal(refused.write_outcome,'failed_before_write');await request(old+'/commands/'+client_key+'?operation=issue','GET',undefined,404);
   checkDocument(await get(old+'/documents/'+d.id));assert.deepEqual(await pages(old+'/documents'),rows,'Historical replay or refused new issue must not create another legacy document or number');
  }
  return rows;
 }
 try{
  const health=(await request('/api/health','GET',undefined,200,{anonymous:true})).value;assert(health.status==='ok'&&health.revision===expectedRevision&&health.restore_preview===false,'Exact writable synthetic release required');
  for(const f of cases){activeResume=Boolean(resume&&f===cases[0]);cookie=undefined;const auth=await request('/api/auth/login','POST',login,200,{anonymous:true});cookie=cookieOf(auth.response);const switched=await request('/api/workspaces/switch','POST',{tenant_id:f.tenant_id});cookie=cookieOf(switched.response);if(activeResume)await resumeIdentity();
   const strategy=await get(root+'/orders/'+f.order_id+'/strategy');assert.equal(strategy.order_id,f.order_id);assert.equal(strategy.strategy,'destinations');assert.equal(strategy.available,true,'Destinations cannot fall back to legacy');flags(await get(root+'/options'));
   const before=await observables(f),beforeSeries=await listSeries(),beforeRegister=await register();assert.equal(beforeRegister.length,0,'Fresh genuine case required; use original keys to inspect a prior run');const source=await get(root+'/orders/'+f.order_id+'/source');original(source,f);
   const mixed=f.kind==='mixed',delta=mixed?'-1700':'-2700',beforeMinor=mixed?'3401':'4401';let legacyRows;
   if(mixed){
    assert.equal(source.previous_credits.length,1);const legacy=source.previous_credits[0];assert.equal(legacy.document_id,f.legacy_document_id);assert.equal(legacy.receipt_id,f.legacy_receipt_id);assert.equal(legacy.return_id,f.legacy_return_id);assert.deepEqual(legacy.calculation,f.legacy_document.data.calculation);assert(Array.isArray(source.credit_families));assert.equal(source.credit_families.length,1);assert.equal(source.credit_families.filter(x=>x.document_id===f.legacy_document_id&&x.receipt_id===f.legacy_receipt_id&&x.family==='legacy').length,1);assert.equal(source.next_return_id,f.later_return_id);
    legacyRows=await legacyHistory(f,{replay:true});assert.deepEqual(await get(root+'/orders/'+f.order_id+'/source'),source,'Legacy replay must not alter the successor source');assert.deepEqual(await observables(f),before);
   }
   if(f.kind==='reject_only'){
    assert.equal(source.eligible,false);assert.equal(source.eligibility_reason,'no_commercial_change');assert.equal(source.calculation,null);assert.equal(source.next_return_id,null);assert.equal(source.acceptances.length,0);assert.equal(source.rejected_inspections.length,1);assert.equal(source.rejected_inspections[0].receipt_id,f.no_change_physical_receipt_id);
    const r=await get('/api/returns/'+source.rejected_inspections[0].return_id);assert.equal(r.state,'rejected');assert.equal(r.received_at,null);assert.equal(r.receipt_sequence,0);await oldRefusal(f,r.id,r.version);
    assert.deepEqual(await listSeries(),beforeSeries);assert.deepEqual(await register(),beforeRegister);assert.deepEqual(await get(root+'/orders/'+f.order_id+'/source'),source);assert.deepEqual(await observables(f),before);
    results.push({kind:f.kind,tenant_id:f.tenant_id,order_id:f.order_id,no_successor_financial_post:true,legacy_new_write_refused:true,registers_unchanged:true,stock_payments_unchanged:true,physical_history_hash:source.physical_history_hash});await onProgress({phase:'case_complete',...results.at(-1)});continue;
   }
   assert.equal(source.eligible,true);assert.equal(source.calculation.totals.delta.gross_minor,delta);assert.equal(source.calculation.totals.before.gross_minor,beforeMinor);assert.equal(source.calculation.totals.after.gross_minor,'1701');assert.equal(source.calculation.return_receipt_id,f.physical_receipt_id);assert(UUID.test(source.next_return_id));assert(/^[1-9][0-9]*$/.test(source.current_return_version));
   if(f.no_change_physical_receipt_id){const rejected=source.rejected_inspections.find(r=>r.receipt_id===f.no_change_physical_receipt_id);assert(rejected);const audit=await get(root+'/orders/'+f.order_id+'/source?'+new URLSearchParams({return_id:rejected.return_id}));original(audit,f);assert.equal(audit.eligible,false);assert.equal(audit.eligibility_reason,'no_commercial_change');assert.equal(audit.calculation,null);assert.equal(audit.next_return_id,source.next_return_id);assert.equal(source.calculation.receipt_sequence,mixed?2:1);}
   const rma=await get('/api/returns/'+source.next_return_id);if(!activeResume)await oldRefusal(f,rma.id,rma.version);
   let sb,series,pb;
   if(activeResume){
    sb=resume.series_request;pb=resume.preview_request;assert(source.can_preview===true&&source.can_issue===true&&source.current_role==='admin','Current financial capabilities required for explicit continuation');assert.equal(source.physical_history_hash,resume.physical_history_hash,'Physical history changed since the failed original preview');assert.equal(source.previous_credits.length,0);assert.deepEqual(source.credit_families,[]);assert.equal(pb.return_id,source.next_return_id);assert.equal(pb.expected_return_version,source.current_return_version);
    const command=await get(root+'/commands/'+resume.series_command_key+'?operation=series');flags(command);assert.equal(command.current_role,'admin');assert.equal(command.operation,'series');assert.equal(command.client_key,resume.series_command_key);assert.equal(command.actor_id,resume.actor_id);assert.equal(command.api_key_id,null);series=command.series;
    assert(UUID.test(series?.id));assert.equal(series.id,pb.series_id);assert.equal(series.version,pb.expected_series_version);assert.equal(series.name,sb.name);assert.equal(series.prefix,sb.prefix);assert.equal(series.enabled,true);
    assert.equal(beforeSeries.filter(s=>s.id===series.id).length,1);assert.deepEqual(beforeSeries.find(s=>s.id===series.id),series);assert.equal(source.series.filter(s=>s.id===series.id).length,1);assert.deepEqual(source.series.find(s=>s.id===series.id),series);
    const absent=await request(root+'/commands/'+resume.preview_command_key+'?operation=preview','GET',undefined,404);assert(typeof absent.value?.detail==='string'&&absent.value.detail.length>0,'Explicit original-command absence DTO required');await resumeIdentity();
    assert.deepEqual(await get(root+'/orders/'+f.order_id+'/source'),source,'Source changed during explicit resume checks');assert.deepEqual(await listSeries(),beforeSeries);assert.deepEqual(await register(),beforeRegister);assert.deepEqual(await observables(f),before);
    await onProgress({phase:'original_preview_resume_verified',tenant_id:f.tenant_id,order_id:f.order_id,series_command_key:resume.series_command_key,preview_command_key:resume.preview_command_key,physical_history_hash:source.physical_history_hash,acknowledged_rollback:{revision:resume.preview_failure.revision,http_status:503,body_sha256:resume.preview_failure.body_sha256,body_bytes:resume.preview_failure.body_bytes,write_outcome:'failed_before_write',actor_id:resume.actor_id,tenant_id:resume.tenant_id,operation:'preview',client_key:resume.preview_command_key}});
   }else{
    sb={client_key:randomUUID(),name:'Korekty zwrotów',prefix:f.series_prefix??(mixed?'ZWROT-MIX':f.wms?'ZWROT-ON':'ZWROT-OFF')};const created=await write('series',root+'/series',sb);flags(created);assert.equal(created.reused,false);series=created.series;assert(UUID.test(series.id));assert.equal(series.prefix,sb.prefix);assert.equal(series.enabled,true);
   }
   const seriesCommand=await get(root+'/commands/'+sb.client_key+'?operation=series');assert.equal(seriesCommand.operation,'series');assert.deepEqual(seriesCommand.series,series);assert((await listSeries()).some(x=>x.id===series.id));
   pb??={client_key:randomUUID(),original_document_id:f.original_document_id,return_id:source.next_return_id,expected_return_version:source.current_return_version,series_id:series.id,expected_series_version:series.version,reason:'Zwrot części pozycji',ordinary_domestic_confirmed:true,local_only:true};const prepared=await write('preview',root+'/previews',pb);flags(prepared);assert.equal(prepared.reused,false);const p=prepared.preview;assert(UUID.test(p.id));assert.equal(p.can_issue,true);assert(SHA.test(p.scope_hash));assert.equal(p.snapshot.physical_history_hash,source.physical_history_hash);assert.deepEqual(p.snapshot.calculation,source.calculation);
   const readPreview=await get(root+'/previews/'+p.id);assert.equal(readPreview.preview.id,p.id);assert.equal(readPreview.preview.can_issue,true);const previewCommand=await get(root+'/commands/'+pb.client_key+'?operation=preview');assert.equal(previewCommand.preview.id,p.id);assert.equal(previewCommand.preview.scope_hash,p.scope_hash);
   // Resume does not weaken the original acceptance case. The separate new
   // refusal command is allowed only after the old preview has been resolved.
   if(activeResume){assert.equal(pending,null);await oldRefusal(f,rma.id,rma.version);}
   const reusedPreview=await write('preview_replay',root+'/previews',pb,200);assert.equal(reusedPreview.reused,true);assert.equal(reusedPreview.preview.id,p.id);
   const ib={client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true,local_only:true},issued=await write('issue',root+'/previews/'+p.id+'/issue',ib);flags(issued);assert.equal(issued.reused,false);const d=issued.document,receipt=issued.receipt;assert(UUID.test(d.id)&&UUID.test(receipt.id));assert.equal(d.mode,'consumer_return_credit');assert.equal(d.kind,'correction');assert.equal(d.original_document_id,f.original_document_id);assert.equal(d.return_id,pb.return_id);assert.equal(receipt.document_id,d.id);assert.equal(receipt.preview_id,p.id);assert.equal(receipt.scope_hash,p.scope_hash);assert.equal(receipt.return_receipt_id,f.physical_receipt_id);assert.equal(d.data.correction_series.id,series.id);assert.equal(d.data.local_only,true);assert.equal(d.data.ksef_state,'not_submitted');assert.equal(d.data.fiscalized,false);assert.equal(d.data.calculation.totals.delta.gross_minor,delta);assert.equal(d.data.calculation.totals.after.gross_minor,'1701');assert(d.number.startsWith(sb.prefix+'/'));
   const detail=await get(root+'/documents/'+d.id);assert.deepEqual(detail.document,d);assert.deepEqual(detail.receipt,receipt);const originalCommand=await get(root+'/commands/'+ib.client_key+'?operation=issue');assert.deepEqual(originalCommand.document,d);assert.deepEqual(originalCommand.receipt,receipt);
   const print=await request(root+'/documents/'+d.id+'/print','GET',undefined,200,{html:true});assert(print.value.includes('Faktura korygująca')&&print.value.includes(d.number)&&print.value.includes(mixed?'-17,00 PLN':'-27,00 PLN')&&print.value.includes('17,01 PLN'));assert(print.response.headers['content-security-policy']?.includes("default-src 'none'"));
   const afterPreview=await get(root+'/previews/'+p.id);assert.equal(afterPreview.preview.issued_document_id,d.id);assert.equal(afterPreview.preview.can_issue,false,'An issued preview is a read-only result');const afterCommand=await get(root+'/commands/'+pb.client_key+'?operation=preview');assert.equal(afterCommand.preview.issued_document_id,d.id);assert.equal(afterCommand.preview.can_issue,false);
   const issuedRegister=await register();assert.equal(issuedRegister.length,1);assert.equal(issuedRegister[0].id,d.id);assert.equal(issuedRegister[0].number,d.number);
   const afterIssuePreviewReplay=await write('preview_replay_after_issue',root+'/previews',pb,200);assert.equal(afterIssuePreviewReplay.reused,true);assert.equal(afterIssuePreviewReplay.preview.id,p.id);assert.equal(afterIssuePreviewReplay.preview.scope_hash,p.scope_hash);assert.equal(afterIssuePreviewReplay.preview.issued_document_id,d.id);assert.equal(afterIssuePreviewReplay.preview.can_issue,false,'POST replay of an issued preview must hydrate its persisted issue state');assert.deepEqual(afterIssuePreviewReplay.preview.snapshot,p.snapshot);
   assert.deepEqual(await register(),issuedRegister,'Preview replay must preserve the exact document register and assigned number');const afterPreviewReplayDetail=await get(root+'/documents/'+d.id);assert.deepEqual(afterPreviewReplayDetail.document,d);assert.deepEqual(afterPreviewReplayDetail.receipt,receipt);assert.deepEqual(await observables(f),before);
   const replay=await write('issue_replay',root+'/previews/'+p.id+'/issue',ib,200);assert.equal(replay.reused,true);assert.deepEqual(replay.document,d);assert.deepEqual(replay.receipt,receipt);const rows=await register();assert.equal(rows.length,1);assert.equal(rows[0].id,d.id);assert.equal(rows[0].totals.gross_minor,delta);
   const after=await get(root+'/orders/'+f.order_id+'/source');original(after,f);assert.equal(after.eligible,false);assert.equal(after.eligibility_reason,'already_credited');assert.equal(after.previous_credits.length,mixed?2:1);const fresh=after.previous_credits.find(x=>x.document_id===d.id);assert(fresh);assert.equal(fresh.calculation.totals.after.gross_minor,'1701');if(mixed){assert.deepEqual(after.previous_credits.find(x=>x.document_id===f.legacy_document_id),source.previous_credits[0]);assert.equal(after.credit_families.length,2);assert.equal(after.credit_families.filter(x=>x.document_id===f.legacy_document_id&&x.receipt_id===f.legacy_receipt_id&&x.family==='legacy').length,1);assert.equal(after.credit_families.filter(x=>x.document_id===d.id&&x.receipt_id===receipt.id&&x.family==='destinations').length,1);assert.deepEqual(await legacyHistory(f),legacyRows);assert.equal(new Set(after.previous_credits.map(x=>x.document_id)).size,2);assert.equal(new Set(after.previous_credits.map(x=>x.receipt_id)).size,2);}assert.deepEqual(await observables(f),before);
   results.push({kind:f.kind,wms:f.wms,tenant_id:f.tenant_id,order_id:f.order_id,document_id:d.id,receipt_id:receipt.id,number:d.number,delta_minor:delta,...(mixed?{legacy_document_id:f.legacy_document_id,legacy_historical_replay_preserved:true,union_history_count:2}:{}),...(activeResume?{resumed_existing_series:true,original_preview_continued:true}:{}),remaining_minor:'1701',series_client_key:sb.client_key,preview_client_key:pb.client_key,issue_client_key:ib.client_key,legacy_new_write_refused:true,stock_payments_unchanged:true});await onProgress({phase:'case_complete',...results.at(-1)});
  }
  return{schema:'dynaminds-return-credit207-ordinary-http-acceptance/v1',status:'PASS_ORDINARY_HTTP',revision:expectedRevision,scope:'Ordinary local HTTP, not browser visual, Native certification, production, provider-account or scale acceptance',cases:results,mixed_case_included:cases.some(f=>f.kind==='mixed'),trace,trace_sha256:digest(trace),original_commands:[...originalCommands],original_commands_sha256:digest(originalCommands),no_sql:true,no_factory:true};
 }catch(error){error.acceptanceProgress={revision:expectedRevision,...(resume?{resume_context:resumeContext()}:{}),pending_command:pending,original_commands:[...originalCommands],response_failures:[...responseFailures],completed_cases:results,trace};throw error;}
}
