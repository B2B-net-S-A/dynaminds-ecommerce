import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
export const sha=x=>createHash('sha256').update(x).digest('hex');
const repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const r=(path,sha256)=>({path:resolve(repo,path),sha256});
const freeze=x=>{if(x&&typeof x==='object'){for(const v of Object.values(x))freeze(v);Object.freeze(x);}return x;};
export const sources=freeze([
 {id:'base',ref:r('data/source-drafts/pim-large-import-postgres-storage-backend5/173_large_catalog_import_jobs.sql','7fafb32748feabb30345c87509936c36730c748923012ca3f54b3e0cde175138')},
 {id:'kernel',ref:r('data/source-drafts/pim-large-import-native173-certificate-backend/kernel.sql','fbe1dbbfac5ef2ec28fae22d61537a13b888a578fab363872f45a07593858f94')},
 {id:'admit',ref:r('data/source-drafts/pim-large-import173-current-admit-backend/admission.sql','81cfb07ca5fdc5f51a4f1d237080d30672b6902f71cad25c859fcc935f0a1f3a')},
 {id:'sidecar_scope',ref:r('data/source-drafts/pim-large-import-core-review-native-scope-sql2-root/candidate.sql','751f3d79ecaef8ab99e0129c68f90d8fe0913e0434c22d071d74b131390dd660')},
 {id:'quota',ref:r('data/source-drafts/pim-large-import-quota-terminal-reconcile-backend2/quota.sql','7841e3499d664ffa203971f081f0612f7752b28ff2323320abcfe63a605f998f')},
 {id:'keeper_admit',ref:r('data/source-drafts/pim-large-import-quota-terminal-reconcile-backend2/keeper-admit.sql','175eab6c4b701b54800fcbcf2c4c18d99d29f8a3603605f26944797bbe7a0674')},
 {id:'terminal',ref:r('data/source-drafts/pim-large-import-quota-terminal-reconcile-backend2/terminal.sql','10ab7ba2a1c8fb3677c0c725e006b7406f5f13abc73abf3eda26cc3a7667b31e')},
 {id:'cleanup_pin',ref:r('data/source-drafts/pim-large-import173-runtime-fs-integration-backend2/cleanup-pin.sql','df0526937711b07f6404341d52a1891975474577383c9868545cc80c20544c53')}
]);
export const queryRef=freeze(r('data/source-drafts/pim-large-import173-terminal-composite-compiler-ui/catalog-query.sql','41c557ca7a0a7a15660c0780d0fd41d1c973c6b71ae698895581a81bee416bad'));
export const canonicalSignature=s=>s.replace(/^public\./,'').replace(/\s*,\s*/g,',').replace(/\s+/g,' ').trim();
// Fixed pinned source extractor, not a general SQL parser or native deparse authority.
// Dollar bodies/strings are scanned as complete tokens, never interpreted as DDL.
function tokens(sql){const result=[];for(let i=0;i<sql.length;){const s=sql.slice(i);let m;
 if((m=/^\s+/.exec(s))){i+=m[0].length;continue;}
 if(s.startsWith('--')){const n=s.indexOf('\n');i+=n<0?s.length:n+1;continue;}
 if(s.startsWith('/*')){const n=s.indexOf('*/');assert(n>=0);i+=n+2;continue;}
 if((m=/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s))){const end=s.indexOf(m[0],m[0].length);assert(end>=0);result.push({text:s.slice(0,end+m[0].length),body:s.slice(m[0].length,end)});i+=end+m[0].length;continue;}
 if(s[0]==="'"){let n=1;for(;n<s.length;n++){if(s[n]==="'"){if(s[n+1]==="'"){n++;continue;}break;}}assert(n<s.length);result.push({text:s.slice(0,n+1)});i+=n+1;continue;}
 m=/^(?:[A-Za-z_][A-Za-z0-9_]*|\d+|::|[^\s])/.exec(s);assert(m);result.push({text:m[0]});i+=m[0].length;
 }return result;}
function statements(sql){const ts=tokens(sql),out=[];let part=[];for(const t of ts){if(t.text===';'){out.push(part);part=[];}else part.push(t);}assert.equal(part.length,0,'unterminated SQL source');return out;}
const text=ts=>ts.map(t=>t.text).join(' ');
function triggerType(st,on){const events=st.slice(3,on).map(x=>x.text);return (st.some((x,i)=>x.text==='FOR'&&st[i+1]?.text==='EACH'&&st[i+2]?.text==='ROW')?1:0)+(events.includes('BEFORE')?2:0)+(events.includes('INSTEAD')?64:0)+['INSERT','DELETE','UPDATE','TRUNCATE'].reduce((n,e,i)=>n+(events.includes(e)?[4,8,16,32][i]:0),0);}
function split(ts){let depth=0,a=[],out=[];for(const t of ts){if(t.text==='(')depth++;if(t.text===')')depth--;if(t.text===','&&depth===0){out.push(a);a=[];}else a.push(t);}out.push(a);assert.equal(depth,0);return out;}
function table(stmt,module){const name=stmt[4].text;assert.equal(stmt[3].text,'.');assert.equal(stmt[5].text,'(');assert.equal(stmt.at(-1).text,')');const parts=split(stmt.slice(6,-1));const columns=[],constraints=[];for(const p of parts){const s=text(p);if(/^(PRIMARY|FOREIGN|CHECK|UNIQUE|CONSTRAINT)\b/i.test(s)){constraints.push(s);continue;}const stop=p.findIndex((t,i)=>i>0&&['NOT','DEFAULT','CHECK','REFERENCES','PRIMARY','UNIQUE','COLLATE'].includes(t.text.toUpperCase()));const end=stop<0?p.length:stop;columns.push({name:p[0].text,type:text(p.slice(1,end)),not_null:/\bNOT NULL\b|\bPRIMARY KEY\b/.test(s),definition:s});}
 const pk=parts.filter(p=>/\bPRIMARY KEY\b/.test(text(p))).flatMap(p=>{const s=text(p);if(p[0].text==='PRIMARY')return p.filter((t,i)=>i>2&&t.text!==')'&&t.text!==',').map(t=>t.text);return[p[0].text];});for(const c of columns)if(pk.includes(c.name))c.not_null=true;
 return {name,module,columns,constraints,primary:pk,checks:parts.reduce((n,p)=>n+p.filter(t=>t.text==='CHECK').length,0),foreign_keys:parts.reduce((n,p)=>n+p.filter(t=>t.text==='REFERENCES').length,0),unique:parts.filter(p=>text(p).includes('UNIQUE')).length,ddl:text(stmt)};
}
function fn(stmt,module){assert.equal(stmt[3].text,'.');const name=stmt[4].text;const close=stmt.findIndex((t,i)=>i>5&&t.text===')');assert(close>0);const args=split(stmt.slice(6,close)).filter(x=>x.length);const types=args.map(a=>text(a.slice(1,a.findIndex(x=>x.text==='DEFAULT')<0?a.length:a.findIndex(x=>x.text==='DEFAULT'))).replace(/\s*\[\s*\]/g,'[]'));const sig=name+'('+types.join(',')+')';const ret=stmt.findIndex(t=>t.text==='RETURNS'),lang=stmt.findIndex(t=>t.text==='LANGUAGE'),body=stmt.find(t=>Object.hasOwn(t,'body'));assert(body);const header=text(stmt.slice(close+1,stmt.indexOf(body)));const app=false; // Assigned only from exact static GRANT EXECUTE statements, never a name heuristic.
 return{signature:sig,module,body_sha256:sha(body.body),result:stmt[ret+1].text,language:stmt[lang+1].text,security_definer:header.includes('SECURITY DEFINER'),volatility:header.includes('IMMUTABLE')?'i':header.includes('STABLE')?'s':'v',strict:header.includes('STRICT'),configuration:[module==='kernel'||module==='admit'||module==='quota'?'search_path=pg_catalog, public':/search_path = pg_catalog , public/.test(header)?'search_path=pg_catalog, public':'search_path=pg_catalog',...(/TimeZone/.test(header)?['TimeZone=UTC']:[])],app_execute:app,defaults:args.some(a=>a.some(t=>t.text==='DEFAULT'))?'0':null};
}
export function deriveInventory(inputs){const relations=[],functions=[],triggers=[],policies=[],indexes=[],grants=[];
 for(const s of inputs){for(const st of statements(s.sql)){const head=text(st.slice(0,3));if(head==='CREATE TABLE public')relations.push(table(st,s.id));else if(head==='CREATE FUNCTION public')functions.push(fn(st,s.id));else if(head.startsWith('CREATE TRIGGER')){const on=st.findIndex(t=>t.text==='ON'),f=st.findIndex(t=>t.text==='FUNCTION');triggers.push({name:st[2].text,relation:st[on+3].text,function:st[f+3].text+'()',type:triggerType(st,on),module:s.id,ddl:text(st)});}else if(head.startsWith('CREATE POLICY')){const on=st.findIndex(t=>t.text==='ON');policies.push({name:st[2].text,relation:st[on+3].text,module:s.id,ddl:text(st)});}else if(head.startsWith('CREATE INDEX')){const on=st.findIndex(t=>t.text==='ON');indexes.push({name:st[2].text,relation:st[on+3].text,module:s.id,ddl:text(st)});}else if(st[0]?.text==='GRANT'||st[0]?.text==='REVOKE')grants.push({module:s.id,ddl:text(st)});}}
 const base=inputs.find(s=>s.id==='base');if(base){
  const expected=['large_import_blobs173','large_import_parts173','large_import_batches173','large_import_jobs173','large_import_events173'];
  assert(base.sql.includes("FOR t IN SELECT unnest(ARRAY["+expected.map(t=>"'"+t+"'").join(',')+"]) LOOP"));
  assert(base.sql.includes("EXECUTE format('CREATE POLICY tenant_scope ON public.%I TO dyna_app USING(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')::uuid))',t);"));
  assert(base.sql.includes("EXECUTE format('GRANT SELECT,INSERT ON public.%I TO dyna_app',t);"));
  for(const relation of expected){policies.push({name:'tenant_scope',relation,module:'base',ddl:'Exact pinned five-table DO loop tenant policy'});grants.push({module:'base',ddl:'GRANT SELECT,INSERT ON public.'+relation+' TO dyna_app',origin:'Exact pinned five-table DO loop'});}
 }
 const duplicate=(xs,field)=>assert.equal(new Set(xs.map(x=>x[field])).size,xs.length,'namespace collision: '+field);duplicate(relations,'name');duplicate(functions,'signature');duplicate(indexes,'name');duplicate(triggers.map(t=>({key:t.relation+'.'+t.name})),'key');duplicate(policies.map(t=>({key:t.relation+'.'+t.name})),'key');
 for(const f of functions)assert(/^(large_import_|large_import173_)/.test(f.signature));
 for(const f of functions)f.app_execute=false;
 for(const s of inputs)for(const st of statements(s.sql)){if(text(st.slice(0,4))!=='GRANT EXECUTE ON FUNCTION')continue;const to=st.findIndex(t=>t.text==='TO');assert(to>4);if(text(st.slice(to+1))!=='dyna_app')continue;for(const part of split(st.slice(4,to))){const signature=canonicalSignature(text(part).replace(/\s*\.\s*/g,'.').replace(/\s*\(\s*/g,'(').replace(/\s*\)\s*/g,')').replace(/\s*\[\s*\]/g,'[]'));const f=functions.find(x=>x.signature===signature);assert(f,'GRANT outside exact function inventory: '+signature);f.app_execute=true;}}
 const source_graph=inputs.map(s=>({id:s.id,ref:structuredClone(s.ref)}));return{schema:'large-import173-composite-source-contract/v1',source_graph,query:queryRef,relations,functions,triggers,policies,indexes,grants,counts:{relations:relations.length,functions:functions.length,user_triggers:triggers.length,foreign_keys:relations.reduce((n,t)=>n+t.foreign_keys,0),ri:relations.reduce((n,t)=>n+4*t.foreign_keys,0),columns:relations.reduce((n,t)=>n+t.columns.length,0),checks:relations.reduce((n,t)=>n+t.checks,0),not_null:relations.reduce((n,t)=>n+t.columns.filter(c=>c.not_null).length,0)},native_deparse:'OPEN',activation:'NOT_APPLY_READY'};
}
export function readSources(){return sources.map(s=>{const st=lstatSync(s.ref.path);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1,'selected-source-regular-single-link');const b=readFileSync(s.ref.path);assert.equal(sha(b),s.ref.sha256);return{...s,sql:b.toString('utf8')};});}
export function sourceContract(){const inputs=readSources(),st=lstatSync(queryRef.path);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1,'selected-query-regular-single-link');const q=readFileSync(queryRef.path);assert.equal(sha(q),queryRef.sha256);const out=deriveInventory(inputs);// Exact counts are derived from all source statements; no claimed author count is accepted here.
 assert.equal(out.relations.length,new Set(out.relations.map(x=>x.name)).size);return out;}

export const requiredManifests=freeze([
 r('data/source-drafts/pim-large-import-native173-certificate-backend/pins.json','868ae197560bb7bb1a2681e38d309d648f5cbf6bbf43a83cb04def6d61c9e7a5'),
 r('data/source-drafts/pim-large-import173-current-admit-backend/pins.json','ef1f7841beb31610b9a163366983073eaaf77aeefd84c2b4af4b52f04720d6a4'),
 r('data/source-drafts/pim-large-import-core-review-native-scope-sql2-root/pins.json','83e5e264c7e50f8fb4011b0f359727fc5773d7037bca5ca6a12bd738c207df2a'),
 r('data/source-drafts/pim-large-import-upload-quota-broker-backend3/pins.json','b26b377e04d668a79643367af423e4f55fad143c955e8bf961303eacc9c1f528'),
 r('data/source-drafts/pim-large-import-quota-terminal-reconcile-backend2/pins.json','2116a43e708c1d2e69feba4e9367fb16338c7095429541fa3c99a345c3657441'),
 r('data/source-drafts/pim-large-import173-runtime-fs-integration-backend2/pins.json','44fd5296f3e12a4a1e5e7481c32aaf5bed9a2b70a3b7831aff79d0eefc4a3f7d'),
 r('data/source-drafts/pim-large-import173-terminal-composite-compiler-ui/query-pins.json','fce386926d43483e2fd51a2ed485043e87f40e18d7f5cf9f879a77d5cced10ca')
]);
export const quotaPeer=freeze(r('data/source-drafts/pim-large-import-upload-quota-broker3-peer-safety/source-peer-safety.json','6eacee779f760c4182e6590e879811de60ccad7a924bc78bdb05522a21ef0251'));
export const terminalPeer=freeze(r('data/source-drafts/pim-large-import-quota-terminal-reconcile2-peer-safety/source-peer-safety.json','f058e00a2c0242b0282b26e8268e32ae00378a9e4309db9b1c4966510aecfd92'));
export const publisherPeer=freeze(r('data/source-drafts/pim-large-import173-runtime-fs-integration2-peer-safety/source-peer-safety.json','3e703c66ffe3fb42fa9dffdbc9d39d4e7f6dc1fdb22512f67d3d7d9245c9a83f'));
export function admitSourceSelection(input0){
 const input=structuredClone(input0);assert.deepEqual(input.source_graph,sources.map(s=>({id:s.id,ref:s.ref})));assert.deepEqual(input.source_manifests,requiredManifests);assert.deepEqual(input.quota_peer,quotaPeer);assert.deepEqual(input.terminal_peer,terminalPeer);assert.deepEqual(input.publisher_peer,publisherPeer);
 const load=ref=>{const st=lstatSync(ref.path);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1);const b=readFileSync(ref.path);assert.equal(sha(b),ref.sha256);return JSON.parse(b.toString());};
 const manifests=input.source_manifests.map(load);for(const ref of [...sources.map(s=>s.ref),queryRef])assert(manifests.some(m=>m.files.some(f=>f.path===ref.path&&f.sha256===ref.sha256)),'selected source absent from exact immutable package');
 const peer=load(input.quota_peer);assert.equal(peer.status,'SOURCE_ACK_NOT_RUN');assert.equal(peer.pins_sha256,requiredManifests[3].sha256);assert.deepEqual(peer.concrete_remaining_source_blockers,[]);
 // Historical manifest entries are not asserted current; only actual selected SQL/query are read here.
 // Root owns immutable historical custody and current app source-transition closure separately.
 const terminal=load(input.terminal_peer);assert.equal(terminal.status,'SOURCE_ACK_NOT_RUN');assert.equal(terminal.pins_sha256,requiredManifests[4].sha256);assert.deepEqual(terminal.concrete_remaining_source_blockers,[]);
 const publisher=load(input.publisher_peer);assert.equal(publisher.status,'SOURCE_ACK_NOT_RUN');assert.equal(publisher.pins_sha256,requiredManifests[5].sha256);assert.deepEqual(publisher.concrete_remaining_source_blockers,[]);
 readSources();return input;
}
