/** Unwired Source31 candidate. Pure source edits; no SQL, IO or runtime authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export const ORDER_SPLIT210_FRAME_SCHEMA_COLUMN_SOURCE=freeze({
 schema:'order-split210-frame-schema-column-source31/v1',
 authored_program:{bytes:4524547,sha256:'3e99139ded0b97012846f5d1bb023e60bb289b307a0647d3302419c3f60414ab'},
 projection_basis:{bytes:627,sha256:'e1b1c0cbd44ffe0a69597b8129901ad171fcc2487adb3db962ff32496443c42f'},
 valid:{bytes:53140,sha256:'2b8023561f6456783d30a4d19a1211736f80b936f81c6fbb6388f5f5786154a5'},
 payload:{bytes:3590688,sha256:'db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3'},
 payload_schema:'order-split210-projection-basis/definition-codec-v1',
});

const tableClose=');';
const scalarColumn="payload_schema text GENERATED ALWAYS AS((payload::jsonb)->>'schema') STORED";
const beforePredicate=" AND payload_jsonb->>'schema'='order-split210-projection-basis/definition-codec-v1'";
const afterPredicate=" AND payload_schema='order-split210-projection-basis/definition-codec-v1'";
const validHead='CREATE FUNCTION public.order_split210_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $closure210$';
const validEnd='$closure210$;\n';

function pinned(value,ref,label){
 assert.equal(typeof value,'string',label+': primitive authored source required');
 assert.equal(Buffer.byteLength(value),ref.bytes,label+': exact Source31 bytes');
 assert.equal(sha(value),ref.sha256,label+': exact Source31 SHA');
}
function edit(source,before,after,target){
 const at=source.indexOf(before);
 assert(at>=0&&source.indexOf(before,at+1)<0,'one fixed '+target+' edit');
 const result=source.slice(0,at)+after+source.slice(at+before.length);
 const proof={target,beforeStart:at,afterStart:at,before,after};
 assert.equal(result.slice(0,at)+before+result.slice(at+after.length),source,'whole '+target+' inverse');
 return {result,proof};
}

/**
 * The caller supplies the complete authored CREATE TABLE and CREATE FUNCTION
 * declarations, not descriptors learned from a database. Both are finite pins.
 * Later integration replaces exactly this table declaration in the preamble
 * and this valid declaration after the existing Source31 finite derivation.
 *
 * The scalar is derived from raw payload, because PostgreSQL does not permit
 * a generated column to depend on another generated column. It is nullable:
 * the original WHERE equality remains an equality without a NULL fallback.
 * Actual PostgreSQL expression/NULL behavior and descriptor counts remain
 * unmeasured. A fresh source vector must authenticate the generated expression
 * and all original metadata before any deployment or performance claim.
 */
export function deriveOrderSplit210FrameSchemaColumn(input){
 assert.equal(arguments.length,1,'one closed authored-source object');
 assert(input&&typeof input==='object'&&!Array.isArray(input),'source object required');
 assert([Object.prototype,null].includes(Object.getPrototypeOf(input)),'plain source object required');
 assert.deepEqual(Reflect.ownKeys(input).sort(),['projectionBasisSql','validSql'],'exact source inputs');
 for(const key of ['projectionBasisSql','validSql'])assert(Object.hasOwn(Object.getOwnPropertyDescriptors(input)[key],'value'),'data properties required');
 const {projectionBasisSql,validSql}=input,pin=ORDER_SPLIT210_FRAME_SCHEMA_COLUMN_SOURCE;
 pinned(projectionBasisSql,pin.projection_basis,'projection basis declaration');
 pinned(validSql,pin.valid,'whole valid declaration');
 assert(projectionBasisSql.startsWith('CREATE TABLE public.order_split210_projection_basis(')&&projectionBasisSql.endsWith(');'),'whole fixed table declaration');
 assert(validSql.startsWith(validHead)&&validSql.endsWith(validEnd),'whole fixed function declaration');
 assert(!projectionBasisSql.includes('payload_schema')&&!validSql.includes('payload_schema'),'fresh finite column name');
 const table=edit(projectionBasisSql,tableClose,','+scalarColumn+tableClose,'projectionBasisSql');
 const valid=edit(validSql,beforePredicate,afterPredicate,'validSql');
 const capture=' WITH live_changed AS MATERIALIZED(';
 const priorCapture=validSql.indexOf(capture),nextCapture=valid.result.indexOf(capture);
 assert(priorCapture>0&&nextCapture>0);
 assert.equal(valid.result.slice(nextCapture),validSql.slice(priorCapture),'entire catalogue capture, all checks and suffix unchanged');
 assert.equal(valid.result.slice(0,validHead.length),validHead,'STABLE/security/search_path header unchanged');
 assert.equal(table.result.replace(','+scalarColumn,''),projectionBasisSql,'only the generated scalar column was appended');
 assert.equal(table.result.slice(0,projectionBasisSql.length-tableClose.length),projectionBasisSql.slice(0,-tableClose.length),'entire existing column declaration sequence unchanged');
 assert(table.result.endsWith(','+scalarColumn+tableClose),'new column follows every existing column');
 return freeze({
  schema:'order-split210-frame-schema-column-candidate/v1',
  projectionBasisSql:table.result,validSql:valid.result,
  projection_basis:{bytes:Buffer.byteLength(table.result),sha256:sha(table.result)},
  valid:{bytes:Buffer.byteLength(valid.result),sha256:sha(valid.result)},
  edits:[table.proof,valid.proof],edit_offsets:'javascript-string-characters',
  source_proofs:pin,whole_table_inverse_verified:true,whole_valid_inverse_verified:true,
  catalogue_capture_and_full_checks_unchanged:true,function_header_and_spi_boundary_unchanged:true,
  existing_column_declaration_sequence_preserved:true,
  original_payload_jsonb_preserved:true,physical_payload_changed:false,
  scalar_expression:"(payload::jsonb)->>'schema'",scalar_nullable:true,
  schema_equality_has_no_null_fallback:true,postgres_expression_and_null_behavior_measured:false,
  runtime_function_count_delta:0,authored_column_count_delta:1,
  independently_compiled_descriptor_delta:null,cross_invocation_cache:false,verdict_cache:false,
  stored_scalar_is_authority:false,source_compilation_performed:false,expected_catalogue_generated:false,
  public_generator_integrated:false,native_certification:false,application_activation:false,
  performance_acceptance:false,business_acceptance:false,
 });
}
