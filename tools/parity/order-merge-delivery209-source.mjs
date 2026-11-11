/** Append-only Source209 derivation. Pure source transformation; no SQL dispatch. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PACKING204_SOURCE_CONTRACT as E204} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing204-source-contract.mjs';
import {RECORDS_SQL} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
// Function-only ESM dependency: neither module derives SQL at import time.
import {deriveOrderMergeDelivery209ValidationSnapshot} from './order-merge-delivery209-validation-snapshot.mjs';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS} from './order-merge-delivery209-startup-roster.mjs';

export const SOURCE166_SHA256='be9c25bfdfc2611422285653b7f417aa12ca289af60a3c706353f89797e9f912';
export const MIGRATION209='209_order_merge_delivery_inheritance';
const hash=v=>createHash('sha256').update(v).digest('hex');
const quote=v=>"'"+v.replaceAll("'","''")+"'";
export function replaceExactlyOnce(source,before,after){assert.equal(source.split(before).length,2,'one explicit source edit');return source.replace(before,()=>after);}
function literal166Function(source,name){
 const start=source.indexOf('CREATE FUNCTION '+name+'()');assert(start>=0);
 const open=source.indexOf(' AS $$',start),end=source.indexOf('$$;',open+6);assert(open>=start&&end>open);
 const body=source.slice(open+6,end);
 const definition='CREATE OR REPLACE FUNCTION public.'+name+'()\n RETURNS trigger\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO \'pg_catalog\', \'public\'\n SET "TimeZone" TO \'UTC\'\nAS $function$'+body+'$function$\n';
 const base=E204.changes.find(r=>r.key==='public.buyer_address_guards()').after;
 return {...structuredClone(base),volatility:'v',result:'trigger',source:body,definition};
}
function successor(before,source){return {...structuredClone(before),source,definition:replaceExactlyOnce(before.definition,before.source,source)};}
function constraintProjection(source){
 return source.replaceAll('pg_get_constraintdef(c.oid,true)','public.order_merge_delivery209_constraint_definition(c.oid)');
}
/** Exact legacy four-body delta; all unrelated bytes and all legacy branches survive. */
export function deriveOrderMergeDelivery209Bodies({source166}){
 assert.equal(hash(source166),SOURCE166_SHA256,'literal Source166 required');
 const changes=[];
 for(const name of ['buyer_address_preview_guard','buyer_address_state_guard']){
  const before=literal166Function(source166,name);let source=before.source;
  const branch=name==='buyer_address_preview_guard'
   ?"\n IF NEW.kind='merge_inherit' THEN\n  PERFORM public.order_merge_delivery209_match('preview',to_jsonb(NEW));RETURN NEW;\n END IF;"
   :"\n IF TG_OP='INSERT' AND EXISTS(SELECT FROM public.buyer_address_receipts r WHERE(r.tenant_id,r.order_id,r.id,r.kind)=(NEW.tenant_id,NEW.order_id,NEW.last_receipt_id,'merge_inherit')) THEN\n  PERFORM public.order_merge_delivery209_match('state',to_jsonb(NEW));RETURN NEW;\n END IF;";
  source=source.replace('\nBEGIN','\nBEGIN'+branch);
  changes.push({kind:'function',key:'public.'+name+'()',before,after:successor(before,source)});
 }
 for(const name of ['buyer_address_guards','buyer_address_fingerprint']){
  const before=E204.changes.find(r=>r.key==='public.'+name+'()').after;
  let source=constraintProjection(before.source);
  assert.equal(before.source.split('pg_get_constraintdef(c.oid,true)').length,2,'one actual own constraint query');
  if(name==='buyer_address_guards') source=source.replace('\nBEGIN','\nBEGIN\n IF public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RETURN false;END IF;');
  changes.push({kind:'function',key:'public.'+name+'()',before:structuredClone(before),after:successor(before,source)});
 }
 return changes;
}

/** Same eight catalogue kinds as Native208, confined to the NEW209 namespace. */
export function deriveOrderMergeDelivery209Records(){
 const prefix='order_merge_delivery209_',kinds=['relation','column','constraint','index','policy','trigger','function','type'];
 const arms=kinds.map(kind=>{
  const candidates=RECORDS_SQL.split('\n').filter(l=>l.startsWith(" UNION ALL SELECT '"+kind+"',"));assert.equal(candidates.length,1);
  let arm=candidates[0].replace(/^ UNION ALL /,'');
  if(kind==='constraint')arm=replaceExactlyOnce(arm,"WHERE n.nspname IN ('public','ordinary187_private')",`WHERE k.conrelid IN(SELECT oid FROM rels) OR(n.nspname='public' AND starts_with(k.conname,'${prefix}'))`);
  if(kind==='trigger')arm=replaceExactlyOnce(arm,'WHERE t.tgrelid IN(SELECT oid FROM rels)',`WHERE t.tgrelid IN(SELECT oid FROM rels) OR starts_with(t.tgname,'${prefix}') OR t.tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))`);
  if(kind==='function')arm=replaceExactlyOnce(arm,"WHERE n.nspname IN ('public','ordinary187_private')",`WHERE n.nspname='public' AND starts_with(p.proname,'${prefix}')`);
  if(kind==='type')arm=replaceExactlyOnce(arm,"WHERE n.nspname IN ('public','ordinary187_private')",`WHERE n.nspname='public' AND(starts_with(t.typname,'${prefix}') OR starts_with(t.typname,'_${prefix}'))`);
  return arm;
 });
 return `WITH rels AS MATERIALIZED(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'${prefix}')), entries(kind,key,value) AS (\n${arms.join('\n UNION ALL ')}\n) SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM entries`;
}

// Fingerprinting needs the complete bytes of both text leaves, but does not
// need to JSON-escape multi-megabyte source/definition strings first. This is a
// representation of fresh pg_proc values, never a stored verdict or a change
// to the ordinary full-descriptor reader. NULL remains a distinct tagged leaf.
function fingerprintFunctionText(sql){
 const leaf=expression=>`jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(${expression},'UTF8')),'hex'))`;
 let result=replaceExactlyOnce(sql,"'source',p.prosrc","'source',"+leaf('p.prosrc'));
 return replaceExactlyOnce(result,"'definition',pg_catalog.pg_get_functiondef(p.oid)","'definition',"+leaf('pg_catalog.pg_get_functiondef(p.oid)'));
}
export function deriveOrderMergeDelivery209FingerprintRecords(){
 return fingerprintFunctionText(deriveOrderMergeDelivery209Records());
}

/** Fingerprint-only tuple output. All eight fresh catalogue arms and their
 * complete descriptor fields/text digests are identical to the wrapped reader.
 * Avoid constructing/extracting the outer record JSON once per referenced
 * kind/key/value expression; the ordinary full reader remains unchanged. */
export function deriveOrderMergeDelivery209FingerprintRows(){
 return replaceExactlyOnce(deriveOrderMergeDelivery209FingerprintRecords(),
  "SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM entries",
  'SELECT kind,key,value FROM entries');
}

export function deriveOrderMergeDelivery209ConstraintDDL(){
 return `-- Before values come from an intact Source166 Native fingerprint, never guessed constraint names.
CREATE TEMP TABLE order_merge_delivery209_constraint_basis ON COMMIT DROP AS
SELECT k.oid,k.conrelid,k.conname,pg_get_constraintdef(k.oid,true) before_definition,NULL::text after_definition
FROM pg_constraint k WHERE k.conrelid IN('public.buyer_address_previews'::regclass,'public.buyer_address_receipts'::regclass)
AND k.contype='c' AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(k.conkey) n JOIN pg_attribute a ON(a.attrelid,a.attnum)=(k.conrelid,n)) IN(ARRAY['kind']::text[],ARRAY['actor_id','api_key_id','kind','token_digest']::text[]);
DO $constraints209$ DECLARE r record;expression text;BEGIN
 IF(SELECT count(*) FROM pg_temp.order_merge_delivery209_constraint_basis)<>4 THEN RAISE EXCEPTION '209 exact four Source166 checks required';END IF;
 FOR r IN SELECT * FROM pg_temp.order_merge_delivery209_constraint_basis ORDER BY conrelid,conname LOOP
  expression:=CASE WHEN r.before_definition LIKE '%actor_id%' THEN '(kind IN(''access'',''merge_inherit'') AND actor_id IS NOT NULL AND token_digest IS NULL) OR (kind=''delivery'' AND actor_id IS NULL AND api_key_id IS NULL AND token_digest IS NOT NULL AND token_digest ~ ''^[a-f0-9]{64}$'')' ELSE 'kind IN(''access'',''delivery'',''merge_inherit'')' END;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.conrelid::regclass,r.conname);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK(%s)',r.conrelid::regclass,r.conname,expression);
  UPDATE pg_temp.order_merge_delivery209_constraint_basis b SET after_definition=pg_get_constraintdef(k.oid,true) FROM pg_constraint k WHERE k.conrelid=r.conrelid AND k.conname=r.conname AND b.oid=r.oid;
 END LOOP;
END$constraints209$;`;
}

/** Append-only manifest. No historical certificate DATA is updated or resealed. */
export function deriveOrderMergeDelivery209Manifest(changes,{directOwnRows=false,validationSnapshot=false,runtimeRevision=21}={}){
 if(validationSnapshot){
  assert.equal(directOwnRows,false,'Source21 retains the reviewed wrapped own fingerprint');
  const snapshot=deriveOrderMergeDelivery209ValidationSnapshot({changes,runtimeRevision});
  const original=deriveOrderMergeDelivery209Manifest(changes),parts=original.split('$fp209$');assert.equal(parts.length,3);
  const marker='CREATE FUNCTION public.order_merge_delivery209_fingerprint()';
  return replaceExactlyOnce(parts[0],marker,snapshot.sql+'\n'+marker)+'$fp209$'+snapshot.fingerprint_source+'$fp209$'+parts[2];
 }
 const records=directOwnRows?deriveOrderMergeDelivery209FingerprintRows():deriveOrderMergeDelivery209FingerprintRecords();
 const own=directOwnRows
  ?`(SELECT coalesce(jsonb_agg(jsonb_build_array(kind,key,encode(sha256(convert_to(value::text,'UTF8')),'hex')) ORDER BY kind COLLATE "C",key COLLATE "C"),'[]'::jsonb) FROM(${records}) own209)`
  :`(SELECT coalesce(jsonb_agg(jsonb_build_array(record->>'kind',record->>'key',encode(sha256(convert_to((record->'value')::text,'UTF8')),'hex')) ORDER BY record->>'kind' COLLATE "C",record->>'key' COLLATE "C"),'[]'::jsonb) FROM(${records}) own209)`;
 const keys=changes.map(r=>r.key);assert.equal(new Set(keys).size,keys.length);
 const functionArm=RECORDS_SQL.split('\n').find(l=>l.startsWith(" UNION ALL SELECT 'function',"));
 const legacy=fingerprintFunctionText(replaceExactlyOnce(functionArm.replace(/^ UNION ALL /,''),"WHERE n.nspname IN ('public','ordinary187_private')",`WHERE n.nspname='public' AND p.proname=ANY(ARRAY[${keys.map(k=>quote(k.slice(7,k.indexOf('(')))).join(',')}]::text[])`));
 const constraintArm=RECORDS_SQL.split('\n').find(l=>l.startsWith(" UNION ALL SELECT 'constraint',"));
 const constraints=replaceExactlyOnce(constraintArm.replace(/^ UNION ALL /,''),"WHERE n.nspname IN ('public','ordinary187_private')","WHERE n.nspname='public' AND c.relname IN('buyer_address_previews','buyer_address_receipts')");
 return `CREATE TABLE public.order_merge_delivery209_manifest(
 id boolean PRIMARY KEY DEFAULT true CHECK(id),profile text NOT NULL CHECK(profile='merge-delivery-inheritance/v1'),
 original166 jsonb NOT NULL,constraints jsonb NOT NULL CHECK(jsonb_typeof(constraints)='array' AND jsonb_array_length(constraints)=4),
 fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$')
);
ALTER TABLE public.order_merge_delivery209_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_merge_delivery209_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON public.order_merge_delivery209_manifest TO postgres USING(true) WITH CHECK(true);
REVOKE ALL ON public.order_merge_delivery209_manifest FROM PUBLIC,dyna_app;
CREATE TRIGGER order_merge_delivery209_manifest_immutable BEFORE UPDATE OR DELETE ON public.order_merge_delivery209_manifest FOR EACH ROW EXECUTE FUNCTION public.order_merge_delivery209_immutable();
CREATE TRIGGER order_merge_delivery209_manifest_no_truncate BEFORE TRUNCATE ON public.order_merge_delivery209_manifest FOR EACH STATEMENT EXECUTE FUNCTION public.order_merge_delivery209_immutable();

CREATE FUNCTION public.order_merge_delivery209_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fp209$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'profile','merge-delivery-complete-record-text-digests/v2',
  'projection_payload',(SELECT jsonb_build_object('byte_count',payload_octets,'sha256',payload_sha256) FROM public.order_merge_delivery209_projection_basis),
  'own',${own},
  'legacy',(SELECT jsonb_agg(jsonb_build_array(kind,key,encode(sha256(convert_to(value::text,'UTF8')),'hex')) ORDER BY kind COLLATE "C",key COLLATE "C") FROM(${legacy}) legacy209(kind,key,value)),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(kind,key,encode(sha256(convert_to(value::text,'UTF8')),'hex')) ORDER BY kind COLLATE "C",key COLLATE "C") FROM(${constraints}) checks209(kind,key,value))
 )::text,'UTF8')),'hex')
$fp209$;
CREATE FUNCTION public.order_merge_delivery209_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $valid209$
DECLARE m public.order_merge_delivery209_manifest%ROWTYPE;BEGIN
 IF(SELECT count(*) FROM public.order_merge_delivery209_manifest)<>1 OR(SELECT count(*) FROM public.buyer_address_manifest)<>1 THEN RETURN false;END IF;
 SELECT * INTO m FROM public.order_merge_delivery209_manifest WHERE id;
 RETURN m.profile='merge-delivery-inheritance/v1'
  AND m.original166 IS NOT DISTINCT FROM(SELECT to_jsonb(b) FROM public.buyer_address_manifest b)
  AND m.fingerprint IS NOT DISTINCT FROM public.order_merge_delivery209_fingerprint();
END$valid209$;
CREATE FUNCTION public.order_merge_delivery209_constraint_definition(fn oid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $constraint209$
DECLARE old text;live text;r record;BEGIN
 SELECT n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid,true) definition INTO r FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE k.oid=fn;
 IF r.conname IS NULL THEN RAISE EXCEPTION 'Missing209 constraint';END IF;
 SELECT value->>'before_definition',value->>'after_definition' INTO old,live FROM public.order_merge_delivery209_manifest m CROSS JOIN LATERAL jsonb_array_elements(m.constraints) WHERE value->>'schema'=r.nspname AND value->>'table'=r.relname AND value->>'name'=r.conname;
 IF old IS NULL THEN RETURN r.definition;END IF;
 IF public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 metadata changed' USING ERRCODE='55000';END IF;
 IF r.definition IS DISTINCT FROM live THEN RAISE EXCEPTION '209 exact successor constraint changed' USING ERRCODE='55000';END IF;
 RETURN old;
END$constraint209$;`;
}

export function deriveOrderMergeDelivery209Seal(){return `
-- Remove inherited default privileges from ALL new tables and routines before sealing.
DO $sealacl209$ DECLARE o record;g record;BEGIN
 FOR o IN SELECT c.oid,c.relowner owner,c.relacl acl,c.oid::regclass::text identity FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND starts_with(c.relname,'order_merge_delivery209_') AND c.relkind IN('r','p') LOOP
  FOR g IN SELECT DISTINCT grantee FROM aclexplode(coalesce(o.acl,acldefault('r',o.owner))) WHERE grantee<>o.owner LOOP EXECUTE format('REVOKE ALL ON TABLE %s FROM %s',o.identity,CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);END LOOP;
 END LOOP;
 FOR o IN SELECT p.proowner owner,p.proacl acl,p.oid::regprocedure::text identity FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'order_merge_delivery209_') LOOP
  FOR g IN SELECT DISTINCT grantee FROM aclexplode(coalesce(o.acl,acldefault('f',o.owner))) WHERE grantee<>o.owner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',o.identity,CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);END LOOP;
 END LOOP;
END$sealacl209$;
GRANT EXECUTE ON FUNCTION public.order_merge_delivery209_inherit(uuid,uuid,uuid,text,text,text,integer,text) TO dyna_app;
INSERT INTO public.order_merge_delivery209_manifest(id,profile,original166,constraints,fingerprint)
SELECT true,'merge-delivery-inheritance/v1',original166,
 (SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',b.conname,'before_definition',b.before_definition,'after_definition',b.after_definition) ORDER BY c.relname,b.conname) FROM pg_temp.order_merge_delivery209_constraint_basis b JOIN pg_class c ON c.oid=b.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace),
 public.order_merge_delivery209_fingerprint() FROM pg_temp.order_merge_delivery209_install_basis;
DO $closing209$ BEGIN
 IF public.order_merge_delivery209_valid() IS DISTINCT FROM true OR public.buyer_address_guards() IS DISTINCT FROM true OR public.return_credit206_guards() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 exact successor closure refused' USING ERRCODE='55000';END IF;
END$closing209$;
`;}

export function deriveOrderMergeDelivery209InstallBasis(){return `CREATE TEMP TABLE order_merge_delivery209_install_basis ON COMMIT DROP AS SELECT to_jsonb(b) original166 FROM public.buyer_address_manifest b;`}

/** Freeze a complete candidate. E209 may be authored only after independent source compilation. */
export function assembleOrderMergeDelivery209({source166,core,predecessor,directOwnRows=false}){
 const buyer=deriveOrderMergeDelivery209Bodies({source166});
 if(predecessor.runtime_revision===22)assert.equal(predecessor.startup_function_count,ORDER_MERGE_DELIVERY209_STARTUP_KEYS.length);
 assert.equal(predecessor.changes.length,predecessor.runtime_revision===22?6+ORDER_MERGE_DELIVERY209_STARTUP_KEYS.length:6);assert.equal(predecessor.source_compilation_performed,false);
 assert(!core.includes('CREATE TABLE public.order_merge_delivery209_manifest('),'unexpanded business core required');
 assert.equal(core.split('END $pre209$;').length,2);
 const changes=[...buyer,...predecessor.changes];
 const business=core.replace('END $pre209$;',()=> 'END $pre209$;\n'+deriveOrderMergeDelivery209InstallBasis());
 assert.equal(typeof predecessor.preambleSql,'string');assert(predecessor.preambleSql.includes('order_merge_delivery209_projection_basis'));
 const sql=business+'\n'+deriveOrderMergeDelivery209ConstraintDDL()+'\n'+predecessor.preambleSql+'\n'+deriveOrderMergeDelivery209Manifest(changes,{directOwnRows,validationSnapshot:predecessor.runtime_revision>=21,runtimeRevision:predecessor.runtime_revision})+'\n'
  +buyer.map(r=>r.after.definition.trimEnd()+';').join('\n')+'\n'+predecessor.sql+'\n'+deriveOrderMergeDelivery209Seal();
 return{sql,changes,source_compilation_performed:false,application_activation:false,native_certification:false,
  source_inputs:{source166_sha256:hash(source166),business_core_sha256:hash(core)},sql_sha256:hash(sql)};
}
