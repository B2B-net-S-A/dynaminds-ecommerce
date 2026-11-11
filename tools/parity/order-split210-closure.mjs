/** Authored Native210 closure candidate. No seal, SQL execution, or acceptance.
 * The twenty-two predecessors are re-derived from pinned SQL, never a catalogue.
 * A later independent source compiler must supply a fixed, reviewed seal. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210DefinitionCodec,ORDER_SPLIT210_DEFINITION_CODEC} from './order-split210-definition-codec.mjs';
import {deriveOrderSplit210DefinitionCodecPorts} from './order-split210-definition-codec-ports.mjs';
import {deriveOrderSplit210Predecessor} from './order-split210-predecessor.mjs';
import {deriveOrderSplit210Layer} from './order-split210-layer.mjs';
import {deriveOrderSplit210BuyerSuccessor} from './order-split210-buyer-successor.mjs';
import {deriveOrderSplit210FinancialSuccessor} from './order-split210-financial-successor.mjs';
import {deriveOrderSplit210FinancialPredecessors} from './order-split210-financial-predecessor.mjs';
import {deriveOrderSplit210HistoryFinancialSharing} from './order-split210-history-financial-sharing.mjs';
import {deriveOrderSplit210HistoryBuyerSuccessor} from './order-split210-history-buyer-successor.mjs';
import {deriveOrderSplit210StartupOperativeSuccessor} from './order-split210-startup-operative-successor.mjs';
import {deriveOrderSplit210OrdinaryFinancialSuccessor} from './order-split210-ordinary-financial-successor.mjs';
import {deriveOrderSplit210CreditSuccessor} from './order-split210-credit-successor.mjs';
import {deriveOrderSplit210ManualProjectionSuccessor} from './order-split210-manual-projection-successor.mjs';
import {deriveOrderSplit210MetadataTraversal} from './order-split210-metadata-traversal.mjs';
import {deriveOrderSplit210MetadataText} from './order-split210-metadata-text.mjs';
import {deriveOrderSplit210MetadataCandidateFilter} from './order-split210-metadata-candidate-filter.mjs';
import {deriveOrderSplit210ValidSnapshot31} from './order-split210-valid-snapshot31.mjs';
import {deriveOrderSplit210FrameSchemaColumn} from './order-split210-frame-schema-column.mjs';
import {deriveOrderSplit210PrefixNameRanges} from './order-split210-prefix-name-ranges.mjs';
import {deriveOrderSplit210ConstraintCandidates} from './order-split210-constraint-candidates.mjs';
import {deriveOrderSplit210BuyerMetadataShapes} from './order-split210-buyer-metadata-shapes.mjs';
import {deriveOrderSplit210OrdinaryMetadataShapes} from './order-split210-ordinary-metadata-shapes.mjs';
import {deriveOrderSplit210FinancialMetadataShapes} from './order-split210-metadata-shapes.mjs';
import {deriveOrderSplit210TriggerRoster} from './order-split210-external-triggers.mjs';
import {deriveOrderSplit210ForeignKeyRoster} from './order-split210-foreign-keys.mjs';
import {RECORDS_SQL} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const json=v=>quote(JSON.stringify(canonical(v)))+'::jsonb';
const identity=r=>r.kind+'\0'+r.key;
const ordered=rs=>[...rs].sort((a,b)=>identity(a)<identity(b)?-1:identity(a)>identity(b)?1:0);
const kinds=['relation','column','constraint','index','policy','trigger','function','type'];
const sourcePins={
 source158:['92381024b61a9c23472857b2cece974b6f848e2f0b414b96ae9dc0c071d849bb','fa3_draft_fingerprint','3a2f515dfbe901334f25b3e42d664440f199ccf3b067f923b09c1225a3f292f1'],
 source159:['391b8af271c70f1fc3c17c7ebbda9bc000f477eb81922f45acb3018c9be86b94','b2b_invoice_fingerprint','8e8cd38e43ef9535c281e87e29684840743c08a76d9205de1da7b2270db9aa8b'],
};
function arm(kind){const rows=RECORDS_SQL.split('\n').filter(l=>l.startsWith(" UNION ALL SELECT '"+kind+"',"));assert.equal(rows.length,1);return rows[0].slice(' UNION ALL '.length);}
function replaceOnce(s,from,to){assert.equal(s.split(from).length,2,'exact canonical SQL site: '+from);return s.replace(from,()=>to);}
function taggedQuery(s){return replaceOnce(replaceOnce(s,"'source',p.prosrc","'source',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))"),"'definition',pg_catalog.pg_get_functiondef(p.oid)","'definition',jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex'))");}
export function orderSplit210TaggedDescriptor(value){
 assert(value&&typeof value.source==='string'&&typeof value.definition==='string','full raw descriptor required');
 return {...value,source:['sha256-utf8-text/v1',sha(value.source)],definition:['sha256-utf8-text/v1',sha(value.definition)]};
}
function recordQuery(sql){return 'SELECT jsonb_build_object(\'kind\',kind,\'key\',key,\'value\',value) record FROM('+sql+') entries(kind,key,value)';}
function functionQuery(filter,tagged=false){let s=replaceOnce(arm('function'),"WHERE n.nspname IN ('public','ordinary187_private')",'WHERE '+filter);if(tagged)s=taggedQuery(s);return recordQuery(s);}
function selectedQuery(changes){const names=[...new Set(changes.map(c=>c.key.match(/^public\.([a-z_0-9]+)\(/)[1]))];return functionQuery("n.nspname='public' AND p.proname IN("+names.map(quote).join(',')+')',true);}
function scopeQuery(){
 const rels="SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'order_split210_')";
 const arms=kinds.map(kind=>{let s=arm(kind);
  if(kind==='constraint')s=replaceOnce(s,"WHERE n.nspname IN ('public','ordinary187_private')","WHERE k.conrelid IN(SELECT oid FROM rels) OR(n.nspname='public' AND starts_with(k.conname,'order_split210_'))");
  if(kind==='trigger')s=replaceOnce(s,'WHERE t.tgrelid IN(SELECT oid FROM rels)',"WHERE t.tgrelid IN(SELECT oid FROM rels) OR starts_with(t.tgname,'order_split210_') OR t.tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))");
  if(kind==='function')s=taggedQuery(replaceOnce(s,"WHERE n.nspname IN ('public','ordinary187_private')","WHERE n.nspname='public' AND starts_with(p.proname,'order_split210_')"));
  if(kind==='type')s=replaceOnce(s,"WHERE n.nspname IN ('public','ordinary187_private')","WHERE n.nspname='public' AND(starts_with(t.typname,'order_split210_') OR starts_with(t.typname,'_order_split210_'))");
  return s;
 });
 return 'WITH rels AS MATERIALIZED('+rels+'), entries(kind,key,value)AS('+arms.join(' UNION ALL ')+") SELECT jsonb_build_object('kind',kind,'key',key,'value',value) record FROM entries";
}
function oldDefinition(source,pin){
 assert.equal(typeof source,'string');assert(Buffer.byteLength(source)<=8388608);assert.equal(sha(source),pin[0],'literal family source pin');
 const marker='CREATE FUNCTION public.'+pin[1]+'()';
 const starts=[...source.matchAll(new RegExp('^'+marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gm'))];assert.equal(starts.length,1);
 const begin=source.indexOf('$$',starts[0].index),end=source.indexOf('$$',begin+2);assert(begin>=0&&end>begin);
 const body=source.slice(begin+2,end);assert.equal(sha(body),pin[2],'independent historical body pin');
 return 'CREATE OR REPLACE FUNCTION public.'+pin[1]+"()\n RETURNS text\n LANGUAGE sql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$"+body+'$function$\n';
}
function pim(value,name,bodyHash){return {signature:name,definition:value.definition,owner:value.owner,language:value.language,
 volatility:value.volatility,strict:value.strict,leakproof:value.leakproof,security_definer:value.security_definer,
 parallel:value.parallel,kind:value.kind,returns_set:value.returns_set,arguments:value.arguments,result:value.result,
 argument_modes:value.argument_modes,argument_names:value.argument_names,defaults:value.defaults,configuration:value.config,
 cost:value.cost,rows:value.rows,acl:value.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]),...(bodyHash?{body_sha256:sha(value.source)}:{})};}
function ddlTable(name,columns){return `CREATE TABLE public.${name}(${columns});
ALTER TABLE public.${name} ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.${name} FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_scope ON public.${name} TO postgres USING(true) WITH CHECK(true);
REVOKE ALL ON public.${name} FROM PUBLIC,dyna_app;
CREATE TRIGGER ${name}_immutable BEFORE UPDATE OR DELETE ON public.${name} FOR EACH ROW EXECUTE FUNCTION public.order_split210_immutable();
CREATE TRIGGER ${name}_no_truncate BEFORE TRUNCATE ON public.${name} FOR EACH STATEMENT EXECUTE FUNCTION public.order_split210_immutable();\n`;}
const functionSql=(name,args,result,body,language='plpgsql')=>`CREATE FUNCTION public.order_split210_${name}(${args}) RETURNS ${result} LANGUAGE ${language} STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $closure210$${body}$closure210$;\n`;
const fail="RAISE EXCEPTION 'Split210 source closure is unsealed or changed' USING ERRCODE='55000';";
const dataSelect="SELECT payload_jsonb INTO STRICT entries FROM public.order_split210_projection_basis WHERE id;";

/** No caller-provided descriptors or predicate callbacks. All source arguments
 * are re-validated by the literal predecessor/roster derivations. The output is
 * usable by an assembler, but deliberately contains NO manifest INSERT. */
export function deriveOrderSplit210Closure({businessInputs,sourceBundle,source158,source159,source210,sourceSchema}){
 const business=deriveOrderSplit210Predecessor(businessInputs),layer=deriveOrderSplit210Layer({sourceBundle});
 const buyer=deriveOrderSplit210BuyerSuccessor({source210});
 const financial=deriveOrderSplit210FinancialSuccessor({source204:businessInputs.source204,source210});
 const historyOperative=deriveOrderSplit210HistoryFinancialSharing({source210});
 const historyBuyer=deriveOrderSplit210HistoryBuyerSuccessor({source210});
 const startupOperative=deriveOrderSplit210StartupOperativeSuccessor({source210});
 const ordinaryFinancial=deriveOrderSplit210OrdinaryFinancialSuccessor({source204:businessInputs.source204,source210});
 const creditCalculation=deriveOrderSplit210CreditSuccessor({source210});
 const manualProjection=deriveOrderSplit210ManualProjectionSuccessor();
 const compactFinancial=deriveOrderSplit210FinancialMetadataShapes({change:financial.change});
 const compactBuyer=deriveOrderSplit210BuyerMetadataShapes({change:buyer.change,ancestor208:buyer.before208});
 const compactOrdinary=deriveOrderSplit210OrdinaryMetadataShapes({change:ordinaryFinancial.change});
 const triggers=deriveOrderSplit210TriggerRoster({source210}),fks=deriveOrderSplit210ForeignKeyRoster({source210,sourceSchema});
 const changes=[...business.changes,...layer.changes,buyer.change,financial.change,historyOperative.change,historyBuyer.change,startupOperative.change,ordinaryFinancial.change,creditCalculation.change,manualProjection.change];assert.equal(changes.length,22);assert.equal(new Set(changes.map(c=>c.key)).size,22);
 const financialPredecessors=deriveOrderSplit210FinancialPredecessors({source204:businessInputs.source204});
 const families={partial204:{...financialPredecessors.families.partial204,...ordinaryFinancial.families.partial204,...creditCalculation.families.partial204},manual169:{...financialPredecessors.families.manual169,...ordinaryFinancial.families.manual169,...creditCalculation.families.manual169}};
 for(const c of business.changes){families.partial204[c.key]=c.before.definition;families.manual169[c.key]=c.before.definition;}
 families.partial204['public.fa3_draft_fingerprint()']=oldDefinition(source158,sourcePins.source158);
 families.partial204['public.b2b_invoice_fingerprint()']=oldDefinition(source159,sourcePins.source159);
 // Source204's manual169 projector delegates these two names to its partial204
 // fold. Returning their current204 definitions would change the original160
 // credit fingerprint while buyer's independent financial160 query stays old.
 for(const key of ['public.fa3_draft_fingerprint()','public.b2b_invoice_fingerprint()'])families.manual169[key]=families.partial204[key];
 // The manual169 projector maps credit back to literal160, not169 or204.
 const credit=businessInputs.source160,creditName='b2b_credit_fingerprint';
 const at=credit.indexOf('CREATE FUNCTION public.'+creditName+'()'),open=credit.indexOf('$$',at),close=credit.indexOf('$$',open+2);
 assert(at>=0&&open>at&&close>open);const creditBody=credit.slice(open+2,close);
 assert.equal(sha(creditBody),'eb63a87e7d4dd426474f7f9a4cc08c3acb5a482247f1fdf40dcc21f21015c948');
 families.manual169['public.b2b_credit_fingerprint()']='CREATE OR REPLACE FUNCTION public.'+creditName+"()\n RETURNS text\n LANGUAGE sql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$"+creditBody+'$function$\n';
 // Buyer is already a member of209's seventeen predecessors. Its live record
 // must reach the original209 checks before209 returns its genuine208 value.
 // The original four, both financial guards, credit calculator and manual projection (not in legacy17)
 // use the exact early-return port.
 // Financial remains raw inside its own source162 self-normalization query.
 const four=business.changes.map(c=>c.key),nonlegacyKeys=[...four,financial.change.key,ordinaryFinancial.change.key,creditCalculation.change.key,manualProjection.change.key],layerKeys=[...layer.changes.map(c=>c.key),buyer.change.key,historyOperative.change.key,historyBuyer.change.key,startupOperative.change.key];
 const metadataChanges=[...business.changes,buyer.change,financial.change,ordinaryFinancial.change],metadataKeys=metadataChanges.map(c=>c.key);
 // Reuse the existing source-authenticated family port without losing204's
 // extra pg_proc checks, which are absent from the canonical24-field record.
 // Only the intersection with204's actual strict CASE receives these checks.
 const partialMarker='CREATE FUNCTION public.partial_sale204_predecessor_definition(fn oid)\n';
 const partialStart=businessInputs.source204.indexOf(partialMarker);assert(partialStart>=0&&businessInputs.source204.indexOf(partialMarker,partialStart+1)<0);
 const partialOpen=businessInputs.source204.indexOf('AS $function$',partialStart)+'AS $function$'.length;
 const partialPrefix=businessInputs.source204.slice(partialOpen,partialOpen+4096);
 const whitelist=/ IF fn NOT IN\(([^\n]+)\) THEN RETURN pg_get_functiondef\(fn\);END IF;/.exec(partialPrefix);assert(whitelist,'literal204 strict-scope gate');
 const strictTypes=new Set([...whitelist[1].matchAll(/'([^']+)'::regprocedure/g)].map(m=>m[1]));assert.equal(strictTypes.size,23);
 const strictPartialKeys=nonlegacyKeys.filter(key=>strictTypes.has(key.replace('(manual_basis jsonb)','(jsonb)')));
 assert.deepEqual(strictPartialKeys,[four[0],four[1],financial.change.key,ordinaryFinancial.change.key]);
 const strictCondition="p.proallargtypes IS NOT NULL OR p.protrftypes IS NOT NULL OR p.prosqlbody IS NOT NULL OR (SELECT count(*) FROM pg_proc q WHERE q.pronamespace='public'::regnamespace AND q.proname=p.proname)<>1";
 const strictRefusal="RAISE EXCEPTION '204 exact scoped descriptor required' USING ERRCODE='55000';";
 assert(partialPrefix.includes(' IF '+strictCondition+' THEN '+strictRefusal+'END IF;'),'exact source204 strict descriptor refusal');

 const shapeVariants=c=>[c.key,c.key.slice('public.'.length)].flatMap(name=>[false,true].map(bodyHash=>({key:c.key,before:pim(c.before,name,bodyHash),after:pim(c.after,name,bodyHash)})));
 const literalPairs=[['source',buyer.change.after,buyer.change.before],['definition',buyer.change.after,buyer.change.before],
  ...['source','definition'].flatMap(field=>[[field,buyer.change.before,buyer.change.before],[field,buyer.before208,buyer.before208]])];
 const logicalData={schema:'order-split210-projection-basis/v1',changes:changes.map(c=>({...c,before_check:orderSplit210TaggedDescriptor(c.before),after_check:orderSplit210TaggedDescriptor(c.after)})),business_keys:four,nonlegacy_projection_keys:nonlegacyKeys,layer_keys:layerKeys,metadata_keys:metadataKeys,families,
  metadata:business.changes.flatMap(shapeVariants),
  metadata_compact_shapes:[...compactFinancial.refs,...compactBuyer.refs,...compactOrdinary.refs],
  metadata_literal_keys:[financial.change.key,ordinaryFinancial.change.key],
  metadata_ancestor_records:[buyer.before208,orderSplit210TaggedDescriptor(buyer.before208)].map(value=>({kind:'function',key:buyer.change.key,value})),
  metadata_ancestor_shapes:[],
  metadata_literals:literalPairs.map(([field,after,before])=>({after:after[field],before:before[field]}))};
 const definitionCodec=deriveOrderSplit210DefinitionCodec(logicalData),data=definitionCodec.physicalData;assert.equal(data.schema,ORDER_SPLIT210_DEFINITION_CODEC.physical_schema);
 const payload=JSON.stringify(canonical(data)),bytes=Buffer.byteLength(payload);assert(bytes<=4194304,'finite immutable closure DATA, not recursive historical SQL; bytes='+bytes);
 const hash=sha(payload),expected=ordered(changes.map(c=>({kind:'function',key:c.key,value:orderSplit210TaggedDescriptor(c.after)})));
 const expectedSql=json(expected),current=selectedQuery(changes),own=scopeQuery();
 const external=[...triggers.triggers,...fks.ri_triggers].filter(r=>!r.key.startsWith('public.order_split210_'));
 const externalKeys=external.map(r=>r.key);assert.equal(new Set(externalKeys).size,external.length);
 const externalBasis=external.map(r=>({...r,value:Object.fromEntries(Object.entries(r.value).filter(([k])=>k!=='definition'))}));
 const generatedHash="pg_catalog.encode(pg_catalog.sha256(pg_catalog.decode(pg_catalog.replace(payload COLLATE \"C\",pg_catalog.chr(92),pg_catalog.repeat(pg_catalog.chr(92),2)),'escape')),'hex')";
 let preambleSql=`DO $closure210owner$ BEGIN IF current_user<>'postgres' OR current_setting('server_encoding')<>'UTF8' OR current_setting('standard_conforming_strings')<>'on' THEN RAISE EXCEPTION 'Split210 closure requires postgres/UTF8/standard strings' USING ERRCODE='55000';END IF;END $closure210owner$;\n`;
 preambleSql+=ddlTable('order_split210_projection_basis',`id boolean PRIMARY KEY CHECK(id),payload text NOT NULL CHECK(octet_length(payload)=${bytes}),payload_jsonb jsonb GENERATED ALWAYS AS(payload::jsonb) STORED NOT NULL,payload_octets integer GENERATED ALWAYS AS(pg_catalog.octet_length(payload)) STORED NOT NULL,payload_sha256 text GENERATED ALWAYS AS(${generatedHash}) STORED NOT NULL CHECK(payload_sha256=${quote(hash)})`);
 preambleSql+=`INSERT INTO public.order_split210_projection_basis(id,payload) VALUES(true,${quote(payload)});\n`;
 preambleSql+=ddlTable('order_split210_manifest',"id boolean PRIMARY KEY CHECK(id),profile text NOT NULL CHECK(profile='order-split210-closure/v1'),fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'),original209 jsonb NOT NULL,original166 jsonb NOT NULL,external_records jsonb NOT NULL CHECK(jsonb_typeof(external_records)='array')");
 const liveOne=functionQuery('p.oid=fn');
 let sql=functionSql('fingerprint','','text',`SELECT encode(sha256(convert_to(jsonb_build_object('records',(SELECT coalesce(jsonb_agg(record ORDER BY record->>'kind' COLLATE "C",record->>'key' COLLATE "C"),'[]'::jsonb) FROM(${own} UNION ALL ${current}) fp),'basis',(SELECT jsonb_build_object('count',count(*),'bytes',min(payload_octets),'sha',min(payload_sha256)) FROM public.order_split210_projection_basis))::text,'UTF8')),'hex');`,'sql');
 const validSnapshot=deriveOrderSplit210ValidSnapshot31(functionSql('valid','','boolean',`
DECLARE m public.order_split210_manifest%ROWTYPE; actual jsonb; entries jsonb;
BEGIN
 IF current_setting('server_encoding')<>'UTF8' OR(SELECT count(*) FROM public.order_split210_manifest)<>1 OR(SELECT count(*) FROM public.order_split210_projection_basis)<>1 THEN RETURN false;END IF;
 SELECT * INTO STRICT m FROM public.order_split210_manifest WHERE id;
 IF m.profile IS DISTINCT FROM 'order-split210-closure/v1' OR(SELECT count(*) FROM public.order_merge_delivery209_manifest)<>1 OR(SELECT count(*) FROM public.buyer_address_manifest)<>1
 OR m.original209 IS DISTINCT FROM(SELECT to_jsonb(p) FROM public.order_merge_delivery209_manifest p)
 OR m.original166 IS DISTINCT FROM(SELECT to_jsonb(p) FROM public.buyer_address_manifest p) THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT FROM public.order_split210_projection_basis WHERE id AND payload IS NOT NULL AND payload_octets=${bytes} AND payload_sha256=${quote(hash)} AND payload_jsonb->>'schema'='order-split210-projection-basis/definition-codec-v1') THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(record ORDER BY record->>'kind' COLLATE "C",record->>'key' COLLATE "C"),'[]'::jsonb) INTO actual FROM(${current}) full_after;
 IF actual IS DISTINCT FROM ${expectedSql} THEN RETURN false;END IF;
 IF jsonb_array_length(m.external_records)<>${external.length} THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',v->>'kind','key',v->>'key','value',(v->'value')-'definition') ORDER BY v->>'kind' COLLATE "C",v->>'key' COLLATE "C"),'[]'::jsonb) INTO actual FROM jsonb_array_elements(m.external_records) v;
 IF actual IS DISTINCT FROM ${json(ordered(externalBasis))} THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(record ORDER BY record->>'kind' COLLATE "C",record->>'key' COLLATE "C"),'[]'::jsonb) INTO actual FROM(${own}) external_live WHERE record->>'kind'='trigger' AND record->>'key'=ANY(ARRAY[${externalKeys.map(quote).join(',')}]::text[]);
 IF actual IS DISTINCT FROM(SELECT jsonb_agg(v ORDER BY v->>'kind' COLLATE "C",v->>'key' COLLATE "C") FROM jsonb_array_elements(m.external_records) v) THEN RETURN false;END IF;
 RETURN m.fingerprint IS NOT DISTINCT FROM public.order_split210_fingerprint();
EXCEPTION WHEN undefined_table OR undefined_function OR no_data_found THEN RETURN false;
END;`));
 const frameTableStart=preambleSql.indexOf('CREATE TABLE public.order_split210_projection_basis('),frameTableEnd=preambleSql.indexOf(';',frameTableStart)+1;
 assert(frameTableStart>=0&&frameTableEnd>frameTableStart,'whole source-authored projection basis declaration');
 const frameTable=preambleSql.slice(frameTableStart,frameTableEnd);
 const frameSchemaColumn=deriveOrderSplit210FrameSchemaColumn({projectionBasisSql:frameTable,validSql:validSnapshot.sql});
 preambleSql=replaceOnce(preambleSql,frameTable,frameSchemaColumn.projectionBasisSql);
 const prefixNameRanges=deriveOrderSplit210PrefixNameRanges(frameSchemaColumn.validSql);
 const constraintCandidates=deriveOrderSplit210ConstraintCandidates(prefixNameRanges.sql);
 sql+=constraintCandidates.sql;
 sql+=functionSql('require','','void',`BEGIN IF public.order_split210_valid() IS DISTINCT FROM true THEN ${fail} END IF;END;`);
 sql+=functionSql('try_function_projection','fn oid','jsonb',`
DECLARE nm text; actual jsonb; entries jsonb; entry jsonb;
BEGIN
 SELECT p.proname INTO nm FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=fn AND n.nspname='public';
 IF nm IS NULL OR NOT nm=ANY(ARRAY[${nonlegacyKeys.map(k=>quote(k.slice(7,k.indexOf('(')))).join(',')}]::text[]) THEN RETURN NULL;END IF;
 PERFORM public.order_split210_require();${dataSelect}
 SELECT record INTO STRICT actual FROM(${liveOne}) live;
 SELECT v INTO entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'=actual->>'key';
 IF entry IS NULL OR NOT(entries->'nonlegacy_projection_keys' @> jsonb_build_array(entry->>'key')) OR actual->'value' IS DISTINCT FROM entry->'after' THEN ${fail} END IF;
 RETURN entry->'before';
END;`);
 sql+=functionSql('project209_record','record jsonb','jsonb',`
DECLARE entries jsonb; entry jsonb;
BEGIN
 IF record->>'kind' IS DISTINCT FROM 'function' OR NOT(record->>'key'=ANY(ARRAY[${layerKeys.map(quote).join(',')}]::text[])) THEN RETURN record;END IF;
 PERFORM public.order_split210_require();${dataSelect}
 SELECT v INTO STRICT entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'=record->>'key';
 IF record IS DISTINCT FROM jsonb_build_object('kind','function','key',entry->>'key','value',entry->'after_check') THEN ${fail} END IF;
 RETURN jsonb_build_object('kind','function','key',entry->>'key','value',entry->'before_check');
END;`);
 const metadataTraversal=deriveOrderSplit210MetadataTraversal(functionSql('try_metadata_projection','value jsonb','jsonb',`
DECLARE entries jsonb; entry jsonb; item jsonb; result jsonb; k text; field text; changed boolean:=false;
BEGIN
 IF value IS NULL OR NOT(${metadataKeys.map(k=>"position("+quote(k.slice(7,k.indexOf('('))+'(')+" in value::text)>0").join(' OR ')}) THEN RETURN NULL;END IF;
 PERFORM public.order_split210_require();${dataSelect}
 IF jsonb_typeof(value)='object' THEN
  IF value->>'kind'='function' AND value->>'key'=ANY(ARRAY[${metadataKeys.map(quote).join(',')}]::text[]) THEN
   SELECT v INTO STRICT entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'=order_split210_try_metadata_projection.value->>'key';
   IF value=jsonb_build_object('kind','function','key',entry->>'key','value',entry->'before') THEN RETURN value;END IF;
   -- The outer209 metadata tail maps source hashes but never definition hashes.
   -- For this one source-authenticated tagged member, return its complete208
   -- ancestor. Live209 comparison frames still use project209_record→209.
   IF entry->>'key'=${quote(buyer.change.key)} AND(value=jsonb_build_object('kind','function','key',entry->>'key','value',entry->'before_check')
    OR value=jsonb_build_object('kind','function','key',entry->>'key','value',entry->'after_check')) THEN
    SELECT v INTO STRICT item FROM jsonb_array_elements(entries->'metadata_ancestor_records') v
     WHERE v->>'key'=entry->>'key' AND jsonb_typeof(v->'value'->'source')='array' AND jsonb_typeof(v->'value'->'definition')='array';
    RETURN item;
   END IF;
   IF value=jsonb_build_object('kind','function','key',entry->>'key','value',entry->'before_check') THEN RETURN value;END IF;
   IF value=jsonb_build_object('kind','function','key',entry->>'key','value',entry->'after') THEN RETURN jsonb_build_object('kind','function','key',entry->>'key','value',entry->'before');END IF;
   IF value=jsonb_build_object('kind','function','key',entry->>'key','value',entry->'after_check') THEN RETURN jsonb_build_object('kind','function','key',entry->>'key','value',entry->'before_check');END IF;
   IF EXISTS(SELECT FROM jsonb_array_elements(entries->'metadata_ancestor_records') v WHERE v=order_split210_try_metadata_projection.value) THEN RETURN value;END IF;${fail}
  END IF;
${compactFinancial.sql}
${compactBuyer.sql}
${compactOrdinary.sql}
  IF EXISTS(SELECT FROM jsonb_array_elements(entries->'metadata') v WHERE v->'after'->>'signature'=order_split210_try_metadata_projection.value->>'signature') THEN
   SELECT v INTO entry FROM jsonb_array_elements(entries->'metadata') v WHERE v->'after'=order_split210_try_metadata_projection.value OR v->'before'=order_split210_try_metadata_projection.value;
   IF entry IS NULL THEN
    IF EXISTS(SELECT FROM jsonb_array_elements(entries->'metadata_ancestor_shapes') v WHERE v=order_split210_try_metadata_projection.value) THEN RETURN value;END IF;${fail}
   END IF;RETURN entry->'before';
  END IF;
  result:='{}'::jsonb;FOR k,item IN SELECT * FROM jsonb_each(value) LOOP entry:=public.order_split210_try_metadata_projection(item);IF entry IS NOT NULL THEN item:=entry;changed:=true;END IF;result:=result||jsonb_build_object(k,item);END LOOP;
 ELSIF jsonb_typeof(value)='array' THEN
  result:='[]'::jsonb;FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP entry:=public.order_split210_try_metadata_projection(item);IF entry IS NOT NULL THEN item:=entry;changed:=true;END IF;result:=result||jsonb_build_array(item);END LOOP;
 ELSIF jsonb_typeof(value)='string' THEN
  -- Reuse the bound whole descriptors instead of duplicating large financial
  -- source/definition strings in immutable DATA. Equality remains whole JSON.
  FOR entry IN SELECT v FROM jsonb_array_elements(entries->'changes') v
   WHERE (entries->'metadata_literal_keys') ? (v->>'key') LOOP
   FOREACH field IN ARRAY ARRAY['source','definition'] LOOP
    IF value=entry->'after'->field THEN RETURN entry->'before'->field;END IF;
    IF value=entry->'before'->field THEN RETURN value;END IF;
   END LOOP;
  END LOOP;
  SELECT v INTO entry FROM jsonb_array_elements(entries->'metadata_literals') v WHERE v->'after'=order_split210_try_metadata_projection.value;
  IF entry IS NOT NULL THEN RETURN entry->'before';END IF;RETURN NULL;
 ELSE RETURN NULL;END IF;
 IF changed THEN RETURN result;END IF;RETURN NULL;
END;`));
 const metadataText=deriveOrderSplit210MetadataText(metadataTraversal.sql);
 const metadataCandidateFilter=deriveOrderSplit210MetadataCandidateFilter(metadataText.sql);
 const definitionPortStart=sql.indexOf('CREATE FUNCTION public.order_split210_try_function_projection('),definitionPortTail='$closure210$;\n',definitionPortEnd=sql.indexOf(definitionPortTail,definitionPortStart)+definitionPortTail.length;
 assert(definitionPortStart>=0&&definitionPortEnd>definitionPortStart);const definitionPortOriginal=sql.slice(definitionPortStart,definitionPortEnd);
 const definitionCodecPorts=deriveOrderSplit210DefinitionCodecPorts({functionSql:definitionPortOriginal,metadataSql:metadataCandidateFilter.sql});
 sql=sql.slice(0,definitionPortStart)+definitionCodecPorts.functionSql+sql.slice(definitionPortEnd);
 sql+=definitionCodecPorts.metadataSql;
 sql+=functionSql('predecessor_definition','fn oid, family text','text',`
DECLARE projected jsonb; entries jsonb; k text;
BEGIN
 IF family IS NULL OR family NOT IN('partial204','manual169') THEN ${fail} END IF;
 projected:=public.order_split210_try_function_projection(fn);
 IF projected IS NULL THEN
  IF family='partial204' THEN RETURN public.partial_sale204_predecessor_definition(fn);END IF;
  RETURN public.manual_inventory_off_projected_definition(fn);
 END IF;
 ${dataSelect}
 SELECT 'public.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')' INTO STRICT k FROM pg_catalog.pg_proc p WHERE p.oid=fn;
 IF family='partial204' AND k=ANY(ARRAY[${strictPartialKeys.map(quote).join(',')}]::text[])
 AND EXISTS(SELECT FROM pg_catalog.pg_proc p WHERE p.oid=fn AND(${strictCondition})) THEN ${strictRefusal}END IF;
 IF entries->'families'->family->>k IS NULL THEN ${fail} END IF;RETURN entries->'families'->family->>k;
END;`);
 const triggerQuery=recordQuery(replaceOnce(arm('trigger'),'WHERE t.tgrelid IN(SELECT oid FROM rels)','WHERE t.oid=fn'));
 sql+=functionSql('is_added_trigger','fn oid','boolean',`
DECLARE actual jsonb; m public.order_split210_manifest%ROWTYPE;
BEGIN
 SELECT record INTO actual FROM(${triggerQuery}) live;
 IF actual IS NULL OR NOT(actual->>'key'=ANY(ARRAY[${triggers.triggers.filter(r=>!r.key.startsWith('public.order_split210_')).map(r=>quote(r.key)).join(',')}]::text[])) THEN RETURN false;END IF;
 PERFORM public.order_split210_require();SELECT * INTO STRICT m FROM public.order_split210_manifest WHERE id;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(m.external_records) v WHERE v=actual) THEN ${fail} END IF;RETURN true;
END;`);
 sql+=functionSql('is_added_trigger_function','fn oid','boolean',`
BEGIN
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=fn AND n.nspname='public' AND p.proname='order_split210_bound_guard') THEN RETURN false;END IF;
 PERFORM public.order_split210_require();
 IF(SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='order_split210_bound_guard')<>1 OR fn IS DISTINCT FROM to_regprocedure('public.order_split210_bound_guard()')::oid THEN ${fail} END IF;RETURN true;
END;`);
 // Revoke EVERY inherited default grantee, not just PUBLIC/dyna_app. No grant
 // to application roles: these ports run only inside source-owned routines.
 const aclSql=`DO $closure210acl$ DECLARE o record;a record;tab text;BEGIN
 FOR o IN SELECT p.oid,p.proowner FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(ARRAY['order_split210_fingerprint','order_split210_valid','order_split210_require','order_split210_try_function_projection','order_split210_project209_record','order_split210_try_metadata_projection','order_split210_predecessor_definition','order_split210_is_added_trigger','order_split210_is_added_trigger_function']) LOOP
 FOR a IN SELECT DISTINCT x.grantee FROM pg_catalog.aclexplode(coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=o.oid),pg_catalog.acldefault('f',o.proowner))) x WHERE x.grantee<>o.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',o.oid::regprocedure,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END);END LOOP;END LOOP;
 FOREACH tab IN ARRAY ARRAY['order_split210_projection_basis','order_split210_manifest'] LOOP
 FOR a IN SELECT DISTINCT x.grantee FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) x WHERE c.oid=('public.'||tab)::regclass AND x.grantee<>c.relowner LOOP EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %s',tab,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END);END LOOP;END LOOP;
 END $closure210acl$;\n`;
 return freeze({schema:'order-split210-source-closure-candidate/v1',parent:layer.parent,changes,data,logical_data:logicalData,definition_codec:{logical_data:definitionCodec.logical_data,physical_data:definitionCodec.physical_data,saved_bytes:definitionCodec.saved_bytes,whole_canonical_inverse_proven:definitionCodec.whole_canonical_inverse_proven},definition_codec_ports:definitionCodecPorts,frame_schema_column:frameSchemaColumn,prefix_name_ranges:prefixNameRanges,constraint_candidates:constraintCandidates,projection_basis:{bytes,sha256:hash},preambleSql,sql,aclSql,
  metadata_queries:{own:own,changed_functions:current},authored_basis:{triggers,fks},source_inputs:{...business.source_inputs,parent209:layer.parent.source_sha256,metadataFreshMap209:layer.source_proofs.metadataFreshMap209,metadataComposite209:layer.source_proofs.metadataComposite209,definitionCodec210:ORDER_SPLIT210_DEFINITION_CODEC,definitionCodecPorts210:definitionCodecPorts.source_proofs,source158:sourcePins.source158[0],source159:sourcePins.source159[0],buyer209:buyer.source_proofs,financial204:financial.source_proofs,financialPredecessors204:financialPredecessors.source_proofs,historyOperative209:historyOperative.source_proofs,historyBuyer209:historyBuyer.source_proofs,startupOperative209:startupOperative.source_proofs,ordinaryFinancial204:ordinaryFinancial.source_proofs,creditCalculation189:creditCalculation.source_proofs,manualProjection180:manualProjection.source_proofs,metadataTraversal210:metadataTraversal.source_proofs,metadataText210:metadataText.source_proofs,metadataCandidateFilter210:metadataCandidateFilter.source_proofs,validSnapshot210:validSnapshot.source_proofs,frameSchemaColumn210:frameSchemaColumn.source_proofs,prefixNameRanges210:prefixNameRanges.source_proofs,constraintCandidates210:constraintCandidates.source_proofs,triggerConstraintMap210:validSnapshot.trigger_constraint_map.source_proofs,compactFinancial:compactFinancial.source_proofs,compactBuyer:compactBuyer.source_proofs,compactOrdinary:compactOrdinary.source_proofs},
  installer_order:['core210 and terminal210 tables/functions (no entry-point grants)','closure preamble/data (manifest EMPTY)','closure ports (before SQL-language successors resolve their new calls)','twenty-two exact predecessor replacements','owner-only ACL seal','independent source compilation and complete descriptor/inverse/certificate comparison','separate reviewed fixed manifest INSERT'],
  required_fixed_seal:{profile:'order-split210-closure/v1',fields:['fingerprint','original209','original166','external_records'],external_keys:externalKeys,external_semantic_basis:externalBasis},
  unresolved_pg_fields:['trigger.definition','constraint.definition','new closure table/type/index/policy/default-expression deparser metadata','full twenty-two before/after descriptor compiler equality','Source210 full program source-compiler proof'],
  sealed:false,seal_sql_emitted:false,source_compilation_performed:false,full_before_descriptors_compiler_verified:false,complete_fifteen_change_closure:false,complete_sixteen_change_closure:false,complete_seventeen_change_closure:false,complete_twenty_change_closure:false,complete_twenty_two_change_closure:false,complete_twenty_one_change_closure:false,native_certification:false,application_activation:false});
}

/** File-only compiler primitive. It checks all twenty-two CURRENT descriptors
 * before replacing any, preserves every unrelated object by identity, and
 * never treats this inverse as a native/database admission. Added210 records
 * are deliberately retained here; their complete compiled roster is pending. */
export function projectOrderSplit210ChangedFunctions(records,candidate,{representation='raw'}={}){
 assert(Array.isArray(records)&&candidate?.schema==='order-split210-source-closure-candidate/v1');
 assert(representation==='raw'||representation==='tagged','explicit descriptor representation');
 const changes=candidate.changes;assert.equal(changes.length,22);
 const names=new Set(changes.map(c=>c.key.slice(0,c.key.indexOf('('))));
 const expected=new Map(changes.map(c=>[c.key,c]));let count=0;const seen=new Set();
 for(const r of records){
  if(r.kind!=='function'||!names.has(r.key.slice(0,r.key.indexOf('('))))continue;
  assert(!seen.has(r.key),'duplicate current changed-function identity');seen.add(r.key);count++;
  const change=expected.get(r.key);assert(change,'extra overload in changed-function namespace');
  const value=representation==='raw'?change.after:orderSplit210TaggedDescriptor(change.after);
  assert.equal(JSON.stringify(canonical(r)),JSON.stringify(canonical({kind:'function',key:r.key,value})),'complete current AFTER descriptor required');
 }
 assert.equal(count,22,'all twenty-two current descriptors required');
 return records.map(r=>r.kind==='function'&&expected.has(r.key)?{kind:'function',key:r.key,value:representation==='raw'?expected.get(r.key).before:orderSplit210TaggedDescriptor(expected.get(r.key).before)}:r);
}
