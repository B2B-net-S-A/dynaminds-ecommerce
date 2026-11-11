/** Source derivation only. No filesystem, SQL dispatch or activation. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RETURN_CREDIT207_SOURCE_CONTRACT as E} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-contract.mjs';
import {RECORDS_SQL} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {deriveFull208Fingerprint} from './return-credit208-full-fingerprint.candidate.mjs';
export const MIGRATION208='208_consumer_return_credit_guard_dedup';
const hash=x=>createHash('sha256').update(x).digest('hex');
export const SOURCE_PINS=Object.freeze({
 source207:'8abe73aec97e294860f918c7285c016444fce15322bf03148926f41041076172',
 source206:'1c79cbeaff631408370dd9908e73fb092d8e5ca4bf86a874e91072e9f0388bd4',
 source188:'cfa89fad3148555c0d91c5293d5e4727ab80d589681724196b70eb8a798cfbc6',
 structure188:'a1ab15d6196fe01f4a156a3f0f97d4080811dafe816e3b20ddd0c483ef7527db',
 recordsSql:'9e4494ccf86c39990d235fad4e6d6b073caa61c3bcc3eda06a297600d80baef7',
});
function replaceOne(source,before,after){assert.equal(source.split(before).length,2,'exactly-one-source-edit');return source.replace(before,()=>after);}
function body(source,name){
 const prefix='CREATE FUNCTION public.'+name+'(',start=source.indexOf(prefix);assert(start>=0);assert.equal(source.indexOf(prefix,start+1),-1);
 const opening=source.indexOf(' AS $$',start),end=source.indexOf('$$;',opening+6);assert(opening>=start&&end>opening);
 return source.slice(opening+6,end);
}
function scoped207Records(){
 assert.equal(hash(RECORDS_SQL),SOURCE_PINS.recordsSql,'literal-record-reader-required');
 const kinds=['relation','column','constraint','index','policy','trigger','function','type'],lines=RECORDS_SQL.split('\n');
 const arms=kinds.map(kind=>{
  const selected=lines.filter(line=>line.startsWith(" UNION ALL SELECT '"+kind+"',"));assert.equal(selected.length,1);
  let arm=selected[0].replace(/^ UNION ALL /,'');
  if(kind==='constraint')arm=replaceOne(arm,"WHERE n.nspname IN ('public','ordinary187_private')",'WHERE k.conrelid IN(SELECT oid FROM rels)');
  if(kind==='trigger')arm=replaceOne(arm,'WHERE t.tgrelid IN(SELECT oid FROM rels)','WHERE t.tgrelid IN(SELECT oid FROM rels) OR t.tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))');
  if(kind==='function')arm=replaceOne(arm,"WHERE n.nspname IN ('public','ordinary187_private')","WHERE n.nspname='public' AND starts_with(p.proname,'return_credit206_')");
  if(kind==='type')arm=replaceOne(arm,"WHERE n.nspname IN ('public','ordinary187_private')","WHERE n.nspname='public' AND(starts_with(t.typname,'return_credit206_') OR starts_with(t.typname,'_return_credit206_'))");
  return arm;
 });
 return "WITH rels AS MATERIALIZED(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'return_credit206_')), entries(kind,key,value) AS (\n"+arms.join('\n UNION ALL ')+"\n) SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM entries";
}
export function deriveReturnCredit208({source207,source206,source188,structure188,template}){
 for(const[key,value]of Object.entries({source207,source206,source188,structure188}))assert.equal(hash(value),SOURCE_PINS[key],'frozen-predecessor:'+key);
 assert.equal(E.additions.length,539);assert.equal(E.changes.length,0);assert.equal(E.removed.length,0);
 assert.equal(E.compiler_receipt_sha256,'3f7eacd45694ebfaedac6033602c324b4e32faa435f8af8390f9fcae5d60e5a9');
 const oldGuard=body(source207,'return_credit206_guards'),oldRequire=body(source207,'return_credit206_require');
 let guard=replaceOne(oldGuard,'DECLARE c record;BEGIN',"DECLARE c record;s record;BEGIN\n IF to_regclass('public.return_credit208_manifest') IS NULL OR to_regprocedure('public.return_credit208_fingerprint()') IS NULL THEN RETURN false;END IF;\n IF(SELECT count(*) FROM public.return_credit208_manifest)<>1 OR(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'return_credit208_') AND relkind IN('r','p'))<>1 OR(SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'return_credit208_'))<>1 THEN RETURN false;END IF;");
 guard=replaceOne(guard,'SELECT * INTO c FROM return_credit206_manifest WHERE id;','SELECT * INTO c FROM return_credit206_manifest WHERE id;\n SELECT * INTO s FROM public.return_credit208_manifest WHERE id;');
 guard=replaceOne(guard,' SELECT * INTO c FROM return_credit206_manifest WHERE id;'," IF(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'return_credit208_'))<>2 OR(SELECT count(*) FROM pg_type WHERE typnamespace='public'::regnamespace AND(starts_with(typname,'return_credit208_') OR starts_with(typname,'_return_credit208_')))<>2 OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'return_credit208_') AND tgrelid<>'public.return_credit208_manifest'::regclass) OR EXISTS(SELECT FROM pg_constraint WHERE connamespace='public'::regnamespace AND starts_with(conname,'return_credit208_') AND conrelid<>'public.return_credit208_manifest'::regclass) THEN RETURN false;END IF;\n SELECT * INTO c FROM return_credit206_manifest WHERE id;");
 guard=replaceOne(guard,'c.fingerprint=public.return_credit206_fingerprint()', "s.profile='207-to208-consumer-credit-deduplicated/v1' AND s.original207=to_jsonb(c)\n AND s.successor207_fingerprint=public.return_credit206_fingerprint() AND s.fingerprint=public.return_credit208_fingerprint()");
 guard=replaceOne(guard,' AND public.local_invoice_guards() AND public.catalog_stock_return_guards() AND public.b2b_credit_guards() AND public.local_consumer_credit_guards()',' AND public.local_consumer_credit_guards()');
 const require=replaceOne(oldRequire,' OR NOT public.local_invoice_guards() OR NOT public.catalog_stock_return_guards()','');
 const recordsSql=scoped207Records(),fingerprint=deriveFull208Fingerprint(recordsSql);
 const changes=[['public.return_credit206_guards()',oldGuard,guard],['public.return_credit206_require(uid uuid, kid uuid, writing boolean, pin boolean)',oldRequire,require]].map(([key,before,after])=>{
  const record=E.additions.find(r=>r.kind==='function'&&r.key===key);assert(record,'exact-compiled207-function');assert.equal(record.value.source,before);
  return{kind:'function',key,before:structuredClone(record.value),after:{...structuredClone(record.value),source:after,definition:replaceOne(record.value.definition,before,after)}};
 });
 const expected=JSON.stringify(E.additions);assert(!expected.includes('$expected207$')&&!expected.includes('$pre208$'));
 let sql=template;
 for(const[token,value]of Object.entries({MIGRATION:MIGRATION208,RECORDS:recordsSql,EXPECTED207:expected,FINGERPRINT:fingerprint,GUARD:guard,REQUIRE:require}))sql=replaceOne(sql,'@@'+token+'@@',value);
 assert(!/@@[A-Z0-9]+@@/.test(sql));
 return{sql,recordsSql,changes,source_compilation_performed:false,application_activation:false,native_certification:false};
}
