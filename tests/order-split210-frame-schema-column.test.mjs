import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {deriveOrderSplit210FrameSchemaColumn,ORDER_SPLIT210_FRAME_SCHEMA_COLUMN_SOURCE} from '../tools/parity/order-split210-frame-schema-column.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
// Only the two complete authored declarations from Source31 program3e99139d.
// No whole-program duplicate, private path, database fixture or observed expectation.
const packed=Buffer.from('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','base64');
assert.equal(packed.length,7759);assert.equal(sha(packed),'7b290f18089ae040f0e73d9886427c24f0638baef5443835d318f42911af953d');
const raw=gunzipSync(packed,{maxOutputLength:65536});assert.equal(raw.length,57977);assert.equal(sha(raw),'1543b940f58e4aaed6524f1d8be0eda0787888a20627f683517c4321b04311f6');
const fixture=Object.freeze(JSON.parse(raw));
const beforePredicate=" AND payload_jsonb->>'schema'='order-split210-projection-basis/definition-codec-v1'";
const afterPredicate=" AND payload_schema='order-split210-projection-basis/definition-codec-v1'";
const column="payload_schema text GENERATED ALWAYS AS((payload::jsonb)->>'schema') STORED";
const head='CREATE FUNCTION public.order_split210_valid() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $closure210$';
const end='$closure210$;\n';
const input=()=>({...fixture});
const inverse=(source,proof)=>{assert.equal(source.slice(proof.afterStart,proof.afterStart+proof.after.length),proof.after);return source.slice(0,proof.afterStart)+proof.before+source.slice(proof.afterStart+proof.after.length);};

test('admits only the two full pinned Source31 declarations and emits fixed candidate pins',()=>{
 assert.equal(Buffer.byteLength(fixture.projectionBasisSql),627);assert.equal(sha(fixture.projectionBasisSql),'e1b1c0cbd44ffe0a69597b8129901ad171fcc2487adb3db962ff32496443c42f');
 assert.equal(Buffer.byteLength(fixture.validSql),53140);assert.equal(sha(fixture.validSql),'2b8023561f6456783d30a4d19a1211736f80b936f81c6fbb6388f5f5786154a5');
 const result=deriveOrderSplit210FrameSchemaColumn(input());
 assert.deepEqual(result.projection_basis,{bytes:703,sha256:'fa01b4866b0f694d55e61950cac43be65cdc76516ba30d2e53c6acebcbd3b71b'});
 assert.deepEqual(result.valid,{bytes:53130,sha256:'19558e1f578684cf667275c1f0afa81f458e4f5e4db118a1c56f522bfe0c6c29'});
 assert.equal(sha(result.projectionBasisSql),result.projection_basis.sha256);assert.equal(sha(result.validSql),result.valid.sha256);
});

test('both recorded edits independently restore the entire declarations',()=>{
 const result=deriveOrderSplit210FrameSchemaColumn(input());assert.equal(result.edits.length,2);
 for(const key of ['projectionBasisSql','validSql']){
  const edit=result.edits.find(e=>e.target===key);assert(edit);assert.equal(edit.beforeStart,fixture[key].indexOf(edit.before));assert.equal(edit.afterStart,result[key].indexOf(edit.after));
  assert.equal(inverse(result[key],edit),fixture[key]);
  assert.equal(result[key].slice(0,edit.afterStart),fixture[key].slice(0,edit.beforeStart));
  assert.equal(result[key].slice(edit.afterStart+edit.after.length),fixture[key].slice(edit.beforeStart+edit.before.length));
 }
 assert.equal(result.whole_table_inverse_verified,true);assert.equal(result.whole_valid_inverse_verified,true);
});

test('new nullable generated scalar derives from raw payload, without replacing the JSONB or checks',()=>{
 const result=deriveOrderSplit210FrameSchemaColumn(input());assert.equal(result.projectionBasisSql.split(column).length,2);
 assert.equal(result.projectionBasisSql.replace(','+column,''),fixture.projectionBasisSql);
 assert(result.projectionBasisSql.includes('payload_jsonb jsonb GENERATED ALWAYS AS(payload::jsonb) STORED NOT NULL,'));
 assert(!column.includes('payload_jsonb'));assert(!column.includes('NOT NULL'));assert(!column.includes('CHECK'));
 assert.equal(result.original_payload_jsonb_preserved,true);assert.equal(result.physical_payload_changed,false);
 assert.equal(result.authored_column_count_delta,1);assert.equal(result.independently_compiled_descriptor_delta,null);
});

test('appends after every original column without changing the prior declaration sequence',()=>{
 const result=deriveOrderSplit210FrameSchemaColumn(input()),prior=fixture.projectionBasisSql.slice(0,-2);
 assert.equal(result.projectionBasisSql.slice(0,prior.length),prior);
 assert.equal(result.projectionBasisSql.slice(prior.length),','+column+');');
 assert.equal(result.existing_column_declaration_sequence_preserved,true);
 const original=['id boolean','payload text','payload_jsonb jsonb','payload_octets integer','payload_sha256 text'];
 for(let i=0;i<original.length;i++)assert.equal(result.projectionBasisSql.indexOf(original[i]),fixture.projectionBasisSql.indexOf(original[i]));
 assert(result.projectionBasisSql.indexOf('payload_schema text')>result.projectionBasisSql.indexOf('payload_sha256 text'));
});

test('preserves the null-rejecting WHERE equality and false branch as source, without claiming PG execution',()=>{
 const result=deriveOrderSplit210FrameSchemaColumn(input());
 const prior=fixture.validSql.split('\n').find(line=>line.includes(beforePredicate));
 const current=result.validSql.split('\n').find(line=>line.includes(afterPredicate));
 assert.equal(current,prior.replace(beforePredicate,afterPredicate));
 assert(current.startsWith(' IF NOT EXISTS(SELECT FROM public.order_split210_projection_basis WHERE id AND payload IS NOT NULL AND payload_octets=3590688 AND payload_sha256='));
 assert(current.endsWith(") THEN RETURN false;END IF;"));
 assert(!current.includes('coalesce('));assert(!current.includes('payload_schema IS NULL'));assert(!current.includes('IS NOT FALSE'));
 assert.equal(result.schema_equality_has_no_null_fallback,true);assert.equal(result.postgres_expression_and_null_behavior_measured,false);
});

test('full single-statement capture, complete comparison tail and STABLE/SPI header stay byte-exact',()=>{
 const result=deriveOrderSplit210FrameSchemaColumn(input());const marker=' WITH live_changed AS MATERIALIZED(';
 assert.equal(result.validSql.slice(result.validSql.indexOf(marker)),fixture.validSql.slice(fixture.validSql.indexOf(marker)));
 assert(result.validSql.startsWith(head)&&result.validSql.endsWith(end));assert.equal(result.validSql.split(marker).length,2);
 assert.equal(result.validSql.replace(afterPredicate,beforePredicate),fixture.validSql);
 for(const call of ['public.order_split210_fingerprint()','public.order_split210_require()'])assert.equal(result.validSql.split(call).length,fixture.validSql.split(call).length);
 assert.equal(result.catalogue_capture_and_full_checks_unchanged,true);assert.equal(result.function_header_and_spi_boundary_unchanged,true);
});

test('body and complete declaration inverses retain every prefix/suffix byte',()=>{
 const result=deriveOrderSplit210FrameSchemaColumn(input());const originalBody=fixture.validSql.slice(head.length,-end.length),body=result.validSql.slice(head.length,-end.length);
 assert.equal(body.replace(afterPredicate,beforePredicate),originalBody);assert.equal(head+body.replace(afterPredicate,beforePredicate)+end,fixture.validSql);
 const definitionHead="CREATE OR REPLACE FUNCTION public.order_split210_valid()\n RETURNS boolean\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$";
 const beforeDefinition=definitionHead+originalBody+'$function$\n',afterDefinition=definitionHead+body+'$function$\n';
 assert.equal(afterDefinition.replace(afterPredicate,beforePredicate),beforeDefinition);
 assert.equal(sha(beforeDefinition),'fd4773a620093ae4577e444ddfbb31a13193b11c6be6d221e0ddd11968aa4390');
});

test('refuses stale or changed table headers, payload pins and whole-table suffixes',()=>{
 for(const bad of [fixture.projectionBasisSql+'\n',fixture.projectionBasisSql.replace('3590688','3590689'),fixture.projectionBasisSql.replace('STORED NOT NULL','STORED'),fixture.projectionBasisSql.replace('CREATE TABLE','CREATE TEMP TABLE')])assert.throws(()=>deriveOrderSplit210FrameSchemaColumn({...input(),projectionBasisSql:bad}));
});

test('refuses changed function identity, scope, header, guard, descriptor and overload bytes',()=>{
 for(const bad of [fixture.validSql+'\n',fixture.validSql.replace('valid()','valid(fn oid)'),fixture.validSql.replace('STABLE','VOLATILE'),fixture.validSql.replace('SECURITY DEFINER','SECURITY INVOKER'),fixture.validSql.replace("payload_jsonb->>'schema'","payload_jsonb->>'other'"),fixture.validSql.replace('live_changed AS MATERIALIZED','live_changed AS NOT MATERIALIZED'),fixture.validSql.replace("'language',l.lanname","'language','plpgsql'")]){
  assert.notEqual(bad,fixture.validSql);assert.throws(()=>deriveOrderSplit210FrameSchemaColumn({...input(),validSql:bad}));
 }
});

test('rejects extra fields and arguments, boxed strings and non-data properties',()=>{
 assert.throws(()=>deriveOrderSplit210FrameSchemaColumn());assert.throws(()=>deriveOrderSplit210FrameSchemaColumn(input(),{}));
 for(const bad of [null,undefined,[],{},Object.create({projectionBasisSql:fixture.projectionBasisSql,validSql:fixture.validSql}),{...input(),sql:'SELECT true'}, {...input(),validSql:new String(fixture.validSql)}])assert.throws(()=>deriveOrderSplit210FrameSchemaColumn(bad));
 let reads=0;const accessor={projectionBasisSql:fixture.projectionBasisSql,get validSql(){reads++;return fixture.validSql;}};assert.throws(()=>deriveOrderSplit210FrameSchemaColumn(accessor));assert.equal(reads,0);
});

test('does not mutate inputs and deeply freezes outputs and all source/edit proofs',()=>{
 const original=input(),result=deriveOrderSplit210FrameSchemaColumn(original);assert.deepEqual(original,fixture);
 assert(Object.isFrozen(result)&&Object.isFrozen(result.edits)&&Object.isFrozen(result.edits[0])&&Object.isFrozen(result.source_proofs.payload));
 assert.throws(()=>{result.edits[0].after='';});assert.throws(()=>{result.source_proofs.payload.bytes=1;});
 const again=deriveOrderSplit210FrameSchemaColumn(input());assert.deepEqual(again,result);assert.notEqual(again,result);
});

test('has no cached verdict, runtime helper, generated expectation, or premature acceptance',()=>{
 const result=deriveOrderSplit210FrameSchemaColumn(input());assert.equal(result.runtime_function_count_delta,0);
 for(const key of ['cross_invocation_cache','verdict_cache','stored_scalar_is_authority','source_compilation_performed','expected_catalogue_generated','public_generator_integrated','native_certification','application_activation','performance_acceptance','business_acceptance'])assert.equal(result[key],false,key);
 assert.equal(result.source_proofs,ORDER_SPLIT210_FRAME_SCHEMA_COLUMN_SOURCE);
});
