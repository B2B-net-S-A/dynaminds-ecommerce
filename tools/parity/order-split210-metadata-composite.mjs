/** Unwired finite composite candidate. No IO, database, cache or trusted frame. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const header="CREATE OR REPLACE FUNCTION public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$";
const snapshotHeader="CREATE OR REPLACE FUNCTION public.order_merge_delivery209_validation_snapshot()\n RETURNS jsonb\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$";
const suffix='$function$\n';
const snapshotPrefix='\n SELECT public.order_split210_require();\n';
const tag='$split210_composite_snapshot$';
export const ORDER_SPLIT210_METADATA_COMPOSITE_SOURCE=freeze({
 schema:'order-split210-source30-metadata-composite-input/v1',
 source_vector_gzip_sha256:'13464fcb80007fa21ab0361c5eedaabc17d64db5b7e3e8d2c4bf9f46cac77604',
 source_vector_canonical_sha256:'ebbe874a4c9edd42f0099c75c856cdacfa637c8a261a220619a736603bf1f136',
 metadata_key:'public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)',
 metadata_bytes:6507,metadata_sha256:'cfad1ebdc47ddd2f3c72b058a1736dd4767a244d7ea4c22f51c3a1a655f4499e',
 metadata_definition_bytes:6739,metadata_definition_sha256:'0ed79c936942803a5e685b3d6da8a4b4a15a3ae6c7bd6d9c7b43185786edeff0',
 snapshot_key:'public.order_merge_delivery209_validation_snapshot()',
 snapshot_bytes:21739,snapshot_sha256:'611cb9304d6f540b31b72a1a627a2e87a5964129dfc0335120e587c4ecdd791c',
 snapshot_definition_bytes:21940,snapshot_definition_sha256:'61765199e83747bd2a16a709c450f260eaf48a828f4606bb97c43b62d8c2dfc4',
});

/** Replace only the already authenticated snapshot boundary. EXECUTE receives a
 * fixed, source-pinned SQL literal, never parameters or generated identifiers.
 * This avoids capture of SQL's unqualified `value` by the PL/pgSQL parameter;
 * no function-wide variable_conflict setting changes existing statements.
 * PostgreSQL18 exec_stmt_dynexecute passes estate->readonly_func to SPI, so
 * this STABLE function keeps the calling-query snapshot. EXECUTE replans each
 * time: savings and actual cardinality/error/MVCC controls remain unverified.
 * Existing try_metadata_projection and snapshot fallback guards remain intact.
 * The one caller require replaces the two explicit requirements at THIS
 * boundary only; it is not a count of all possible nested runtime checks.
 * Evidence: postgresql.org/docs/18/spi-visibility.html and PostgreSQL's
 * REL_18_STABLE src/pl/plpgsql/src/pl_exec.c, exec_stmt_dynexecute.
 */
export function deriveOrderSplit210MetadataComposite(sourceBody,snapshotBody){
 assert.equal(arguments.length,2,'exactly two finite authored bodies');
 assert.equal(typeof sourceBody,'string','primitive metadata body required');
 assert.equal(typeof snapshotBody,'string','primitive snapshot body required');
 const pin=ORDER_SPLIT210_METADATA_COMPOSITE_SOURCE;
 assert.equal(Buffer.byteLength(sourceBody),pin.metadata_bytes,'exact metadata body bytes');
 assert.equal(sha(sourceBody),pin.metadata_sha256,'exact metadata body SHA');
 assert.equal(Buffer.byteLength(snapshotBody),pin.snapshot_bytes,'exact snapshot body bytes');
 assert.equal(sha(snapshotBody),pin.snapshot_sha256,'exact snapshot body SHA');
 const beforeDefinition=header+sourceBody+suffix,snapshotDefinition=snapshotHeader+snapshotBody+suffix;
 assert.equal(Buffer.byteLength(beforeDefinition),pin.metadata_definition_bytes);assert.equal(sha(beforeDefinition),pin.metadata_definition_sha256);
 assert.equal(Buffer.byteLength(snapshotDefinition),pin.snapshot_definition_bytes);assert.equal(sha(snapshotDefinition),pin.snapshot_definition_sha256);
 assert(snapshotBody.startsWith(snapshotPrefix));
 const snapshotSql=snapshotBody.slice(snapshotPrefix.length);
 assert(snapshotSql.startsWith(' WITH split210_snapshot_map('));
 assert(!snapshotSql.includes(tag)&&!snapshotSql.includes('$function$'),'fixed unambiguous SQL and outer definition quotes');
 const before=` -- Independently authenticate the snapshot callee BEFORE dispatch; its own
 -- require remains too. No checked-map callee or caller frame is authority.
 PERFORM public.order_split210_require();
 -- SAME fresh snapshot as209_valid; Source210 snapshot retains its require.
 split210_fresh_snapshot:=public.order_merge_delivery209_validation_snapshot();
`;
 assert.equal(sourceBody.split(before).length,2,'one complete original snapshot boundary');
 const after=` -- Authenticate the complete composite before its literal source snapshot.
 PERFORM public.order_split210_require();
 EXECUTE ${tag}${snapshotSql}${tag} INTO split210_fresh_snapshot;
`;
 const beforeStart=sourceBody.indexOf(before),source=sourceBody.slice(0,beforeStart)+after+sourceBody.slice(beforeStart+before.length);
 const edits=[{kind:'source-authenticated-literal-snapshot',beforeStart,afterStart:beforeStart,before,after}];
 const inverse=source.slice(0,beforeStart)+before+source.slice(beforeStart+after.length);
 assert.equal(inverse,sourceBody,'whole raw metadata body inverse');assert.equal(header+inverse+suffix,beforeDefinition,'whole fixed-header definition inverse');
 const payloadStart=' SELECT count(*) OVER(),id,payload IS NOT NULL,payload_octets,payload_sha256,payload_jsonb INTO total,source_id,payload_present,payload_bytes,payload_hash,entries FROM public.order_merge_delivery209_projection_basis;';
 assert(sourceBody.includes(payloadStart));assert.equal(source.slice(source.indexOf(payloadStart)),sourceBody.slice(sourceBody.indexOf(payloadStart)),'complete original DATA/51 projection suffix');
 const definition=header+source+suffix;
 return freeze({schema:'order-split210-metadata-composite-candidate/v1',source,source_bytes:Buffer.byteLength(source),source_sha256:sha(source),
  definition,sql:definition,bytes:Buffer.byteLength(definition),sha256:sha(definition),edits,source_proofs:pin,
  snapshot_sql:snapshotSql,snapshot_sql_bytes:Buffer.byteLength(snapshotSql),snapshot_sql_sha256:sha(snapshotSql),
  source_byte_delta:Buffer.byteLength(source)-Buffer.byteLength(sourceBody),definition_byte_delta:Buffer.byteLength(definition)-Buffer.byteLength(beforeDefinition),
  full_body_inverse_verified:true,full_definition_inverse_verified:true,standalone_snapshot_unchanged:true,
  explicit_caller_require_at_snapshot_boundary:1,explicit_snapshot_require_removed:1,snapshot_dispatch_calls:0,
  global_nested_require_count_claimed:false,existing_projection_and_fallback_guards_preserved:true,
  literal_sql_only:true,caller_sql_arguments:false,variable_conflict_setting_changed:false,query_replanned_each_execution:true,
  sql_snapshot_semantics_basis:'postgresql18-stable-readonly-spi',runtime_mvcc_validation:false,
  existing_changed_function:true,new_runtime_functions:0,trusted_frame_api:false,cross_invocation_cache:false,
  parent209_data_changed:false,source210_data_fit_measured:false,source210_data_fit_claimed:false,
  public_generator_integrated:false,source_compilation_performed:false,native_certification:false,application_activation:false,
  performance_acceptance:false,business_acceptance:false});
}
