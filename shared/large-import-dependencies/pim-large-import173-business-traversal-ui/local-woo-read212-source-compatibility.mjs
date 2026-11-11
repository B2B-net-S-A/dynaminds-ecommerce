/** Exact Source212 additions inverse before the unchanged211/209 chain.
 * A projected catalogue is metadata only, never a runtime authorization token. */
import assert from 'node:assert/strict';
import {validateRecoverySchema} from './packing189-catalogue-reader.mjs';
import {isLocalWooRead212Footprint,validateLocalWooRead212Draft,LOCAL_WOO_READ212_SOURCE_CONTRACT,LOCAL_WOO_READ212_SOURCE_ORIGIN,canonical212,digest212,freeze212} from './local-woo-read212-source-contract.mjs';
const id=r=>r.kind+'\0'+r.key,counts={relation:'relations',column:'columns',constraint:'constraints',index:'indexes',policy:'policies',trigger:'triggers',type:'types'};
function project(input,expected,compiled){
 const owned=input.records.filter(isLocalWooRead212Footprint);
 if(!owned.length)return freeze212({catalogue:input,active:false,removed_records:0,mode:'SOURCE212_ABSENT_PREDECESSOR_IDENTITY',authority:false});
 assert(expected,'212 source compilation not published; active or partial footprint refused');
 assert.deepEqual(canonical212(owned),expected.additions,'212 exact complete source addition roster/descriptors');
 const ids=new Set(expected.additions.map(id)),records=input.records.filter(r=>!ids.has(id(r))),afterCounts={...input.counts};
 for(const r of owned){assert(Object.hasOwn(counts,r.kind));assert(afterCounts[counts[r.kind]]>0);afterCounts[counts[r.kind]]--;}
 const body={schema:input.schema,postgres_major:input.postgres_major,scope:[...input.scope],sql_sha256:input.sql_sha256,counts:afterCounts,records};
 const catalogue=validateRecoverySchema({...body,sha256:digest212(body)});
 return freeze212({catalogue,active:true,removed_records:owned.length,mode:compiled?'SOURCE_COMPILED_EXACT212_TO211':'DRAFT_EXACT212_TO211',source_compilation_proven:compiled,native_certification:false,application_activation:false,business_acceptance:false,authority:false});
}
export function projectLocalWooRead212Catalogue(input,candidate){assert.equal(arguments.length,2);return project(validateRecoverySchema(input),validateLocalWooRead212Draft(candidate),false);}
export function projectCompiledLocalWooRead212Catalogue(input){assert.equal(arguments.length,1);return project(validateRecoverySchema(input),LOCAL_WOO_READ212_SOURCE_CONTRACT,LOCAL_WOO_READ212_SOURCE_ORIGIN.source_compilation_proven);}
