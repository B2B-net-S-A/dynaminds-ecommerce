import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderMergeDelivery209Bodies,deriveOrderMergeDelivery209Records,deriveOrderMergeDelivery209FingerprintRecords,deriveOrderMergeDelivery209FingerprintRows,deriveOrderMergeDelivery209ConstraintDDL,deriveOrderMergeDelivery209Manifest,deriveOrderMergeDelivery209Seal,assembleOrderMergeDelivery209} from '../tools/parity/order-merge-delivery209-source.mjs';

const root=new URL('../',import.meta.url),read=name=>readFileSync(new URL(name,root),'utf8');
const source166=read('server/166_buyer_address_sidecar.sql');
const changes=deriveOrderMergeDelivery209Bodies({source166});
const sha=value=>createHash('sha256').update(value).digest('hex');
test('209 rejects altered historical166 and derives exactly four complete descriptor changes',()=>{
 assert.throws(()=>deriveOrderMergeDelivery209Bodies({source166:source166+'\n'}),/literal Source166/);
 assert.equal(changes.length,4);assert.equal(new Set(changes.map(r=>r.key)).size,4);
 for(const r of changes){
  assert.notEqual(r.after.source,r.before.source);
  assert.equal(r.after.definition,r.before.definition.replace(r.before.source,()=>r.after.source));
  const {source:a,definition:b,...headerAfter}=r.after,{source:c,definition:d,...headerBefore}=r.before;
  assert.deepEqual(headerAfter,headerBefore,'header and effective ACL remain literal');
 }
});
test('209 preview/state initialization branches are narrow; every legacy byte remains',()=>{
 for(const name of ['preview','state']){
  const r=changes.find(c=>c.key===`public.buyer_address_${name}_guard()`);
  const beforeBegin=r.before.source.indexOf('\nBEGIN'),afterBegin=r.after.source.indexOf('\nBEGIN');
  assert.equal(r.before.source.slice(0,beforeBegin),r.after.source.slice(0,afterBegin));
  const marker=' END IF;';const injectedEnd=r.after.source.indexOf(marker,afterBegin)+marker.length;
  assert.equal(r.after.source.slice(injectedEnd),r.before.source.slice(beforeBegin+'\nBEGIN'.length));
  assert.match(r.after.source,/order_merge_delivery209_match/);
  if(name==='state')assert.match(r.after.source,/TG_OP='INSERT' AND EXISTS/);
 }
});
test('209 leaves legacy delivery rules and order version effects intact',()=>{
 const preview=changes.find(c=>c.key==='public.buyer_address_preview_guard()').after.source;
 assert.match(preview,/ord.status NOT IN\('new','paid'\)/);
 assert.match(preview,/NEW.token_digest IS DISTINCT FROM encode/);
 assert.match(preview,/NEW.kind='delivery' AND NEW.changed/);
 assert.match(deriveOrderMergeDelivery209ConstraintDDL(),/count\(\*\).*<>4/);
 assert.match(deriveOrderMergeDelivery209ConstraintDDL(),/kind IN\(''access'',''merge_inherit''\).*actor_id IS NOT NULL AND token_digest IS NULL/);
});
test('209 catalogue sealing includes complete eight-kind namespace, every changed legacy routine and immutable original166',()=>{
 const records=deriveOrderMergeDelivery209Records();
 for(const kind of ['relation','column','constraint','index','policy','trigger','function','type'])assert(records.includes(`SELECT '${kind}',`));
 assert(records.includes('starts_with(t.typname,\'_order_merge_delivery209_\')'));
 assert(records.includes("starts_with(t.tgname,'order_merge_delivery209_')"),'new guards attached to historical MERGE tables are in the seal');
 assert(records.includes("starts_with(k.conname,'order_merge_delivery209_')"),'deferred constraint on the historical execution table is in the seal');
 const manifest=deriveOrderMergeDelivery209Manifest(changes);
 for(const r of changes)assert(manifest.includes(r.key.slice(7,r.key.indexOf('('))));
 assert(!manifest.includes('::regprocedure::oid'),'cold keys with argument names are not regprocedure input');
 assert.match(manifest,/original166 IS NOT DISTINCT FROM\(SELECT to_jsonb\(b\) FROM public.buyer_address_manifest b\)/);
 assert.match(manifest,/m.fingerprint IS NOT DISTINCT FROM public.order_merge_delivery209_fingerprint/);
 const seal=deriveOrderMergeDelivery209Seal();
 assert(!/UPDATE\s+(?:public\.)?buyer_address_manifest/i.test(seal));
 assert.match(seal,/BEFORE|closing209/);
 assert.match(seal,/WHERE grantee<>o.owner/g);
});
test('209 current-root producer binds portal policy, private credential, complete source roster and deferred completion',()=>{
 const sql=read('tools/parity/order-merge-delivery209-business.sql');
 assert.match(sql,/array_position\(ids,NULL\) IS NOT NULL/);
 assert.match(sql,/\(oid=ANY\(ids\)\) IS DISTINCT FROM true/);
 assert.match(sql,/portal_enabled,o.portal_expires_at\) IS DISTINCT FROM\(source.portal_enabled,source.portal_expires_at\)/);
 assert.match(sql,/portal_token=ANY/);
 assert.match(sql,/p.expires_at<=clock_timestamp\(\)/);
 assert.match(sql,/'enabled',false,'delivery_kind',state/);
 assert.match(sql,/a.scopes @> ARRAY\['orders:read','orders:write','inventory:read','inventory:write'\]/);
 assert.match(sql,/root_xid<>pg_current_xact_id\(\)/);
 assert(!/\b[eo]\.xmin\b/.test(sql),'209 explicitly reads the source row xmin by tenant and ID');
 assert.match(sql,/SELECT z\.xmin::text FROM public\.order_merge_executions z WHERE\(z\.tenant_id,z\.id\)=\(t,e\.id\)/);
 assert.match(sql,/SELECT z\.xmin::text FROM public\.orders z WHERE\(z\.tenant_id,z\.id\)=\(t,o\.id\)/);
 assert.match(sql,/transaction_started_at<>transaction_timestamp\(\)/);
 assert.match(sql,/DEFERRABLE INITIALLY DEFERRED/);
 assert(!sql.includes("status NOT IN('new','paid')"),'inheritance is initialization for all supported MERGE statuses');
 assert(!/UPDATE\s+(?:public\.)?orders\b/i.test(sql));
});
test('unchanged constraint identity returns its actual definition before209 authority; mapped four still require exact live successor',()=>{
 const sql=deriveOrderMergeDelivery209Manifest(changes).split('$constraint209$')[1];
 const identity=sql.indexOf('IF old IS NULL THEN RETURN r.definition;END IF;'),guard=sql.indexOf('IF public.order_merge_delivery209_valid()');
 assert(identity>0&&guard>identity);assert(sql.indexOf('SELECT n.nspname')<identity);
 assert(sql.indexOf("value->>'schema'=r.nspname AND value->>'table'=r.relname AND value->>'name'=r.conname")<identity);
 assert(sql.indexOf('IF r.definition IS DISTINCT FROM live')>guard);
 assert(sql.indexOf('RETURN old;')>guard);
});
test('209 fingerprint binds every fresh field and complete text byte into ordered kind/key/digest arrays without dropping rows',()=>{
 const body=deriveOrderMergeDelivery209Manifest(changes).split('$fp209$')[1];
 assert(body.includes("'profile','merge-delivery-complete-record-text-digests/v2'"));
 assert(body.includes('FROM('+deriveOrderMergeDelivery209FingerprintRecords()+') own209'),'all eight reader arms remain; only function text leaves are represented by complete fresh hashes');
 assert(body.includes("jsonb_build_array(record->>'kind',record->>'key',encode(sha256(convert_to((record->'value')::text,'UTF8')),'hex'))"));
 assert.equal(body.split("jsonb_build_array(kind,key,encode(sha256(convert_to(value::text,'UTF8')),'hex'))").length-1,2,'legacy and constraints both retain full descriptors');
 for(const field of ["'local',k.conislocal","'inheritance_count',k.coninhcount","'no_inherit',k.connoinherit","'definition',pg_catalog.pg_get_constraintdef(k.oid,true)"])assert(body.includes(field),'full external constraint metadata: '+field);
 assert(body.includes("WHERE n.nspname='public' AND c.relname IN('buyer_address_previews','buyer_address_receipts')"),'all constraints of both166 tables, not only the four changed checks');
 assert(body.includes("'projection_payload',(SELECT jsonb_build_object('byte_count',payload_octets,'sha256',payload_sha256) FROM public.order_merge_delivery209_projection_basis)"));
 assert(!body.includes('octet_length(payload)'));assert(!body.includes("convert_to(payload,'UTF8')"));
 assert(body.includes('UNION ALL'));assert(!body.includes('jsonb_object_agg('));
 // The unchanged reader legitimately uses string_agg inside complete metadata
 // fields. Only the outer fingerprint collections must remain row arrays.
 for(const label of ['legacy','constraints'])assert(body.includes("'"+label+"',(SELECT jsonb_agg(jsonb_build_array(kind,key,"));
 assert(body.includes("'own',(SELECT coalesce(jsonb_agg(jsonb_build_array(record->>'kind',record->>'key',"));
 assert(!body.includes('set_config('));assert(!body.includes('predecessor_descriptor('));assert(!body.includes('checked_projection_map('));
 assert.equal((body.match(/ORDER BY kind COLLATE "C",key COLLATE "C"/g)??[]).length,2);
});

test('fingerprint-only text representation preserves every other field and the ordinary full metadata reader',()=>{
 const full=deriveOrderMergeDelivery209Records(),compact=deriveOrderMergeDelivery209FingerprintRecords();
 const source="jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))";
 const definition="jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex'))";
 assert.equal(compact,full.replace("'source',p.prosrc","'source',"+source).replace("'definition',pg_catalog.pg_get_functiondef(p.oid)","'definition',"+definition));
 assert(full.includes("'source',p.prosrc"));assert(full.includes("'definition',pg_catalog.pg_get_functiondef(p.oid)"));
 const body=deriveOrderMergeDelivery209Manifest(changes).split('$fp209$')[1];
 assert.equal(body.split("'source',"+source).length-1,2,'own and legacy functions both hash actual source bytes');
 assert.equal(body.split("'definition',"+definition).length-1,2,'own and legacy functions both hash actual complete definitions');
 for(const field of ["'cost',p.procost","'rows',p.prorows","'config',p.proconfig","'acl_null',p.proacl IS NULL","'binary',p.probin","'argument_names',p.proargnames"]){assert(compact.includes(field));assert(body.includes(field));}
 assert(!compact.includes('substr('));assert(!compact.includes('left('));assert(!compact.includes('set_config('));
});

test('direct fingerprint rows preserve all eight arms byte-for-byte and only remove terminal record wrapping',()=>{
 const wrapped=deriveOrderMergeDelivery209FingerprintRecords(),direct=deriveOrderMergeDelivery209FingerprintRows();
 const terminal="SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM entries";
 assert(wrapped.endsWith(terminal));assert(direct.endsWith('SELECT kind,key,value FROM entries'));
 assert.equal(direct,wrapped.slice(0,-terminal.length)+'SELECT kind,key,value FROM entries');
 const arms=direct.slice(0,-'SELECT kind,key,value FROM entries'.length);
 assert.equal(arms,wrapped.slice(0,-terminal.length));
 assert.equal((arms.match(/(?:\n|\n UNION ALL )SELECT '(?:relation|column|constraint|index|policy|trigger|function|type)',/g)||[]).length,8);
 assert.equal((arms.match(/\n UNION ALL SELECT '/g)||[]).length,7,'UNION ALL retains duplicates and all records');
 assert.equal(sha(deriveOrderMergeDelivery209Records()),'af1422370fc02768ee24b300d09831dcc4c7df835d6a962b22e1ccb84275ef05','ordinary raw full reader is unchanged');
});

test('optional direct manifest differs only in own tuple collection; default remains exact historical bytes',()=>{
 const old=deriveOrderMergeDelivery209Manifest(changes),direct=deriveOrderMergeDelivery209Manifest(changes,{directOwnRows:true});
 assert.equal(sha(old),'698508100e9f1dbd21a6cf00ef79de1a4f165599d6b530d57f36e943dbc19214');
 assert.equal(deriveOrderMergeDelivery209Manifest(changes,{directOwnRows:false}),old);
 const fragment=sql=>sql.slice(sql.indexOf("  'own',"),sql.indexOf("  'legacy',"));
 assert.equal(direct.replace(fragment(direct),()=>fragment(old)),old,'all DDL, profile, raw payload binding, legacy/constraint arms and validity stay literal');
 assert(fragment(direct).includes("coalesce(jsonb_agg(jsonb_build_array(kind,key,encode(sha256(convert_to(value::text,'UTF8')),'hex')) ORDER BY kind COLLATE \"C\",key COLLATE \"C\"),'[]'::jsonb)"));
 assert(fragment(direct).includes('FROM('+deriveOrderMergeDelivery209FingerprintRows()+') own209)'));
 assert(!fragment(direct).includes("record->"));
 assert.equal(direct.split("'sha256-utf8-text/v1'").length-1,4,'own+legacy full actual source/definition hashing unchanged');
 assert(!direct.includes('set_config('));assert(!direct.includes('MATERIALIZED(SELECT kind'));
});

test('direct tuple aggregate is algebraically identical to record extraction including nulls, duplicates, Unicode and empty sets',()=>{
 // Controlled representation oracle, not a claim about planner evaluation or
 // actual pg_catalog rows. Root must compare actual PG fingerprints separately.
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const text=value=>JSON.stringify(canonical(value));
 const compare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
 const ordered=rows=>rows.slice().sort((a,b)=>compare(a[0],b[0])||compare(a[1],b[1]));
 const digest=value=>sha(text(value));
 const old=rows=>ordered(rows.map(([kind,key,value])=>{
  const record=JSON.parse(JSON.stringify({kind,key,value}));return [record.kind,record.key,digest(record.value)];
 }));
 const direct=rows=>ordered(rows.map(([kind,key,value])=>[kind,key,digest(value)]));
 const rows=[['function','public.ą()',null],['function','public.z()',{'acl_null':false,source:['sha256-utf8-text/v1',null],config:null}],
  ['relation','public.a',{}],['column','public.a.x',0],['type','public.🧪',false],['policy','public.a.p',['x',null]],
  ['index','public.a.i','backslash\\\nżółć'],['constraint','public.a.c',{a:null,b:1}],['trigger','public.a.t',{args:'',internal:false}]];
 rows.push(structuredClone(rows[0]));
 for(const input of [[],rows,rows.slice().reverse()]){
  assert.equal(text(old(input)),text(direct(input)));assert.equal(digest(old(input)),digest(direct(input)));
  assert.equal(old(input).length,input.length);
 }
 assert.notEqual(digest(null),digest('null'));assert.notEqual(digest({}),digest([]));assert.notEqual(digest(false),digest(0));
 assert.equal(direct(rows).filter(row=>row[0]==='function'&&row[1]==='public.ą()').length,2);
});

test('assembler forwards optional direct mode while default inert fixture remains exact historical bytes',()=>{
 // Tiny source-only assembly fixture: no manifest acceptance or SQL execution.
 const core='-- inert assembly fixture; no SQL execution\nDO $pre209$ BEGIN NULL;END $pre209$;';
 const predecessor={changes:Array.from({length:6},(_,index)=>({kind:'function',key:'public.fixture_'+index+'()',before:{},after:{}})),
  preambleSql:'-- order_merge_delivery209_projection_basis fixture',sql:'-- inert predecessor fixture',source_compilation_performed:false};
 const ordinary=assembleOrderMergeDelivery209({source166,core,predecessor});
 assert.equal(ordinary.sql_sha256,'f49fcb1905286374b0689c22cdf9f50c25d173277776285f85627eebec478ddf');
 assert.equal(assembleOrderMergeDelivery209({source166,core,predecessor,directOwnRows:false}).sql,ordinary.sql);
 const direct=assembleOrderMergeDelivery209({source166,core,predecessor,directOwnRows:true});
 assert(direct.sql.includes(deriveOrderMergeDelivery209FingerprintRows()));
 assert(!ordinary.sql.includes(deriveOrderMergeDelivery209FingerprintRows()));
 assert.deepEqual(direct.changes,ordinary.changes);assert.deepEqual(direct.source_inputs,ordinary.source_inputs);
 for(const key of ['source_compilation_performed','application_activation','native_certification'])assert.equal(direct[key],false);
});
