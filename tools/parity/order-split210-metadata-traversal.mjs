/** Fixed Source24 SQL transformation only. No runtime entries API or execution. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {orderMergeDelivery209HistorySqlSpans as spans} from './order-merge-delivery209-history-closure.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const code=s=>spans(s).map(x=>x.executable?x.text:x.text.replace(/[^\n]/g,' ')).join('');
export const ORDER_SPLIT210_METADATA_TRAVERSAL_SOURCE=freeze({
 schema:'order-split210-source24-metadata-sql/v1',
 bytes:16192,sha256:'a06f8c1eaff7701be568309d312bd9ddfac375334c3557c04d5dc8cbdc623513',
 key:'public.order_split210_try_metadata_projection(value jsonb)',
 source24_candidate_sha256:'59bafbea5dabb4e8ccd65139d9075f5433be252545971c04a9f0d0cc226ba2d7',
 unchanged_basis_bytes:4193843,unchanged_basis_sha256:'0d59e41fbe0cc778bc4009e1efafa47905eb351a99e00f6bd74207a6ceb351a7',
});

/** Primitive exact authored CREATE SQL only; no metadata/frame/verdict input. */
export function deriveOrderSplit210MetadataTraversal(sourceSql){
 const pin=ORDER_SPLIT210_METADATA_TRAVERSAL_SOURCE;
 assert.equal(arguments.length,1,'exactly one authored SQL argument');
 assert.equal(typeof sourceSql,'string','exact authored SQL string required');
 assert.equal(Buffer.byteLength(sourceSql),pin.bytes,'exact Source24 SQL bytes');
 assert.equal(sha(sourceSql),pin.sha256,'exact Source24 SQL SHA');
 const delimiter='$closure210$',a=sourceSql.indexOf(delimiter)+delimiter.length,b=sourceSql.lastIndexOf(delimiter);
 assert(a>=delimiter.length&&b>a&&sourceSql.slice(b)===delimiter+';\n');
 const body=sourceSql.slice(a,b),head=sourceSql.slice(0,a),suffix=sourceSql.slice(b);
 assert(head.startsWith('CREATE FUNCTION '+pin.key+' RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS '));
 const declaration='DECLARE entries jsonb; entry jsonb; item jsonb; result jsonb; k text; field text; changed boolean:=false;';
 assert(body.startsWith('\n'+declaration+'\nBEGIN\n'));
 const objectStart=body.indexOf(" IF jsonb_typeof(value)='object' THEN");assert(objectStart>0);
 const preamble=body.slice(0,objectStart),gate=preamble.split('\n').find(s=>s.startsWith(' IF value IS NULL OR NOT('));assert(gate?.endsWith('THEN RETURN NULL;END IF;'));
 assert.equal((code(preamble).match(/order_split210_require\(/g)||[]).length,1);
 assert(preamble.includes('SELECT payload_jsonb INTO STRICT entries FROM public.order_split210_projection_basis WHERE id;'));
 const tail=' IF changed THEN RETURN result;END IF;RETURN NULL;\nEND;';
 assert(body.endsWith(tail));const end=body.length-tail.length;
 const objectLoop="  result:='{}'::jsonb;FOR k,item IN SELECT * FROM jsonb_each(value) LOOP entry:=public.order_split210_try_metadata_projection(item);IF entry IS NOT NULL THEN item:=entry;changed:=true;END IF;result:=result||jsonb_build_object(k,item);END LOOP;";
 const arrayLoop="  result:='[]'::jsonb;FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP entry:=public.order_split210_try_metadata_projection(item);IF entry IS NOT NULL THEN item:=entry;changed:=true;END IF;result:=result||jsonb_build_array(item);END LOOP;";
 const objectPush=`  FOR walk_child IN SELECT e.key,e.value FROM jsonb_each(order_split210_try_metadata_projection.value) WITH ORDINALITY e(key,value,ord) ORDER BY e.ord DESC LOOP
   walk_nodes:=array_append(walk_nodes,walk_child.value);walk_paths:=array_append(walk_paths,walk_path||jsonb_build_array(walk_child.key));
  END LOOP;`;
 const arrayPush=`  FOR walk_child IN SELECT (e.ord-1)::text AS key,e.item AS value FROM jsonb_array_elements(order_split210_try_metadata_projection.value) WITH ORDINALITY e(item,ord) ORDER BY e.ord DESC LOOP
   walk_nodes:=array_append(walk_nodes,walk_child.value);walk_paths:=array_append(walk_paths,walk_path||jsonb_build_array(walk_child.key));
  END LOOP;`;
 const edits=[],add=(at,before,after,kind)=>{assert.equal(body.slice(at,at+before.length),before);edits.push({beforeStart:at,before,after,kind});};
 add(1,declaration,declaration+'\n walk_root jsonb;walk_nodes jsonb[];walk_paths jsonb[];walk_path jsonb;walk_projection jsonb;walk_changed boolean:=false;walk_index integer;walk_child record;walk_text_path text[];','invocation_local_stack');
 const loopStart=` walk_root:=value;walk_nodes:=ARRAY[value];walk_paths:=ARRAY['[]'::jsonb];
 WHILE cardinality(walk_nodes)>0 LOOP
  walk_index:=cardinality(walk_nodes);value:=walk_nodes[walk_index];walk_path:=walk_paths[walk_index];
  IF walk_index=1 THEN walk_nodes:=ARRAY[]::jsonb[];walk_paths:=ARRAY[]::jsonb[];
  ELSE walk_nodes:=walk_nodes[1:walk_index-1];walk_paths:=walk_paths[1:walk_index-1];END IF;
  walk_projection:=NULL;entry:=NULL;item:=NULL;result:=NULL;k:=NULL;field:=NULL;changed:=false;
  <<metadata_node>>
  BEGIN
${gate.replace('RETURN NULL;','walk_projection:=NULL;EXIT metadata_node;')}
`;
 add(objectStart,'',loopStart,'walk_after_fresh_guard');
 for(const [before,after,kind]of [[objectLoop,objectPush,'original_object_children_reverse_push'],[arrayLoop,arrayPush,'original_array_children_reverse_push']]){
  assert.equal(body.split(before).length,2);const at=body.indexOf(before);assert(at>objectStart&&at<end);add(at,before,after,kind);
 }
 // The lexical mask excludes quoted strings/comments. Preserve the original
 // returned expressions byte-for-byte, including SQL NULL vs JSONB null.
 const classifier=body.slice(objectStart,end),masked=code(classifier);
 const returns=[...masked.matchAll(/\bRETURN\b([\s\S]*?);/g)];assert(returns.length>10&&returns.length<40);
 for(const m of returns){const original=classifier.slice(m.index,m.index+m[0].length),expression=original.slice('RETURN'.length,-1).trim();assert(expression&&!/^(NEXT|QUERY)\b/.test(expression));
  add(objectStart+m.index,original,'walk_projection:=('+expression+');EXIT metadata_node;','exact_terminal_return');
 }
 const finish=`  END metadata_node;
  IF walk_projection IS NOT NULL THEN
   walk_changed:=true;
   IF walk_projection IS DISTINCT FROM value THEN
    IF jsonb_array_length(walk_path)=0 THEN walk_root:=walk_projection;
    ELSE SELECT array_agg(e.part ORDER BY e.ord) INTO walk_text_path FROM jsonb_array_elements_text(walk_path) WITH ORDINALITY e(part,ord);
     walk_root:=jsonb_set(walk_root,walk_text_path,walk_projection,false);END IF;
   END IF;
  END IF;
 END LOOP;
 IF walk_changed THEN RETURN walk_root;END IF;RETURN NULL;
END;`;
 add(end,tail,finish,'single_invocation_result');
 edits.sort((x,y)=>x.beforeStart-y.beforeStart);let cursor=0,transformed='';
 for(const e of edits){assert(e.beforeStart>=cursor,'disjoint fixed SQL edits');transformed+=body.slice(cursor,e.beforeStart);e.afterStart=transformed.length;transformed+=e.after;cursor=e.beforeStart+e.before.length;}transformed+=body.slice(cursor);
 let inverse=transformed;for(const e of [...edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}assert.equal(inverse,body,'whole original Source24 function body inverse');
 assert.equal((code(transformed).match(/order_split210_require\(/g)||[]).length,1);
 assert.equal((code(transformed).match(/public\.order_split210_try_metadata_projection\(/g)||[]).length,0,'no public recursive invocation');
 const sql=head+transformed+suffix;assert.equal(head+inverse+suffix,sourceSql,'entire declaration/header/suffix inverse');
 return freeze({schema:'order-split210-local-metadata-traversal/v1',sql,bytes:Buffer.byteLength(sql),sha256:sha(sql),
  edits:edits.map(e=>({...e,beforeStart:e.beforeStart+a,afterStart:e.afterStart+a})),source_proofs:pin,
  traversal:{fresh_full_guards:1,immutable_basis_reads:1,terminal_returns:returns.length,original_recursion_sites:2,depth_first:true,root_before_identity_nonnull:true,sql_null_distinct_from_json_null:true,cross_invocation_cache:false,new_runtime_functions:0},
  whole_source_inverse_verified:true,header_and_suffix_preserved:true,source_data_changed:false,target_metadata_adopted:false,
  source_compilation_performed:false,native_certification:false,application_activation:false,business_acceptance:false});
}
