/** Source271 producer for the sealed Source209 snapshot. Import-inert: no SQL dispatch, no file access.
 *
 * public.order_merge_delivery209_validation_snapshot() is replaced in place by a body that computes the same
 * value with two kinds of edits and nothing else (docs/parity/MERGE209-SNAPSHOT-GEN271-20261029.md):
 *  1. index paths: every catalogue predicate of the 209 body stays verbatim; an extra conjunct restricts the
 *     same rows to a superset that a catalogue index can find (name prefix ranges, oid lists). Rows, values,
 *     ordering and aggregation are untouched, so the result does not depend on the plan the conjunct enables.
 *  2. self entry: the 209 body hashes its own descriptor into the fingerprint. The new body reports, for its
 *     own record only, the digest the 209 body would report for a function with the same live attributes,
 *     and only when its live source and definition are exactly this body; any other text keeps the live
 *     digest. The body finds its own expected text without a stored copy: it is a quine (TEMPLATE below).
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const SNAPSHOT_KEY='public.order_merge_delivery209_validation_snapshot()';
export const SNAPSHOT_209_CREATE='CREATE FUNCTION public.order_merge_delivery209_validation_snapshot() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $snapshot209$';
export const SNAPSHOT_271_CREATE='CREATE OR REPLACE FUNCTION public.order_merge_delivery209_validation_snapshot() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $snapshot271$';
/** pg_get_functiondef() text before the body for these attributes (PostgreSQL 18, read on dynaminds_p271_20261029_01). */
export const DEFINITION_HEADER="CREATE OR REPLACE FUNCTION public.order_merge_delivery209_validation_snapshot()\n RETURNS jsonb\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\nAS $function$";
export const DEFINITION_FOOTER='$function$\n';
export const PLACEHOLDER='#271#';
export const QUOTE='$q271$';

const X="'order_merge_delivery209_'::name",Y="'order_merge_delivery209`'::name";
const RELS="SELECT oid FROM rels";
/** [209 text, 271 text]; each 271 text is the 209 text plus a conjunct (or, for the digest, the 209 expression
 * as the ELSE branch). Applied once each, in order; tests undo them to recover the 209 body byte for byte. */
export const REWRITES=Object.freeze([
 ["WITH rels AS MATERIALIZED(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'order_merge_delivery209_'))",
  "WITH rels AS MATERIALIZED(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'order_merge_delivery209_') AND relname>="+X+" AND relname<"+Y+")"],
 ["WHERE k.conrelid IN(SELECT oid FROM rels) OR(n.nspname='public' AND starts_with(k.conname,'order_merge_delivery209_'))",
  "WHERE (k.conrelid IN(SELECT oid FROM rels) OR(n.nspname='public' AND starts_with(k.conname,'order_merge_delivery209_'))) AND k.oid=ANY(ARRAY(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN("+RELS+") UNION ALL SELECT oid FROM pg_catalog.pg_constraint WHERE conname>="+X+" AND conname<"+Y+"))"],
 ["WHERE t.tgrelid IN(SELECT oid FROM rels) OR starts_with(t.tgname,'order_merge_delivery209_') OR t.tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))",
  "WHERE (t.tgrelid IN(SELECT oid FROM rels) OR starts_with(t.tgname,'order_merge_delivery209_') OR t.tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))) AND t.oid=ANY(ARRAY(SELECT oid FROM pg_catalog.pg_trigger WHERE tgrelid IN("+RELS+") UNION ALL SELECT oid FROM pg_catalog.pg_trigger WHERE tgname>="+X+" AND tgname<"+Y+" UNION ALL SELECT oid FROM pg_catalog.pg_trigger WHERE tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN("+RELS+"))))"],
 ["WHERE n.nspname='public' AND starts_with(p.proname,'order_merge_delivery209_')",
  "WHERE n.nspname='public' AND starts_with(p.proname,'order_merge_delivery209_') AND p.proname>="+X+" AND p.proname<"+Y],
 ["WHERE n.nspname='public' AND(starts_with(t.typname,'order_merge_delivery209_') OR starts_with(t.typname,'_order_merge_delivery209_'))",
  "WHERE n.nspname='public' AND(starts_with(t.typname,'order_merge_delivery209_') OR starts_with(t.typname,'_order_merge_delivery209_')) AND t.oid=ANY(ARRAY(SELECT oid FROM pg_catalog.pg_type WHERE typname>="+X+" AND typname<"+Y+" UNION ALL SELECT oid FROM pg_catalog.pg_type WHERE typname>='_order_merge_delivery209_'::name AND typname<'_order_merge_delivery209`'::name))"],
 ["WHERE n.nspname='public' AND c.relname IN('buyer_address_previews','buyer_address_receipts')",
  "WHERE n.nspname='public' AND c.relname IN('buyer_address_previews','buyer_address_receipts') AND k.conrelid=ANY(ARRAY(SELECT oid FROM pg_catalog.pg_class WHERE relname IN('buyer_address_previews','buyer_address_receipts')))"],
]);
export const OWN_DIGEST_209="encode(sha256(convert_to((record->'value')::text,'UTF8')),'hex')";
export const SELF_CTE_ANCHOR='WITH legacy209_current(kind,key,value) AS MATERIALIZED (';

const sha=text=>createHash('sha256').update(text,'utf8').digest('hex');
const literal=text=>"'"+text.replaceAll("'","''")+"'";
function once(text,before,after){assert.equal(text.split(before).length,2,'exactly one closed source span');return text.replace(before,()=>after);}

/** The exact prosrc of the 209 snapshot inside server/209_order_merge_delivery_inheritance.sql. */
export function source209Body(sql209){
 assert.equal(typeof sql209,'string');
 const start=sql209.indexOf(SNAPSHOT_209_CREATE);assert(start>=0&&sql209.indexOf(SNAPSHOT_209_CREATE,start+1)<0,'one Source209 snapshot');
 const from=start+SNAPSHOT_209_CREATE.length,end=sql209.indexOf('$snapshot209$;',from);assert(end>from);
 return sql209.slice(from,end);
}

/** The self-entry CTE (template form: the literal is the placeholder). Every quote/placeholder token the code
 * needs is split, so the template holds PLACEHOLDER once and QUOTE/"$function" never. */
function selfCte(){
 const split=token=>"'"+token.slice(0,3)+"'||'"+token.slice(3)+"'";
 const definition=literal(DEFINITION_HEADER.slice(0,-'$function$'.length))+"||"+split('$function$')+"||s.src||"+split('$function$')+"||chr(10)";
 return "WITH self271(src_sha,def_sha) AS MATERIALIZED (SELECT encode(sha256(convert_to(s.src,'UTF8')),'hex'),encode(sha256(convert_to("+definition+",'UTF8')),'hex')"
  +" FROM (SELECT replace(q.t,"+split(PLACEHOLDER)+","+split(QUOTE)+"||q.t||"+split(QUOTE)+") src FROM (SELECT "+PLACEHOLDER+"::text t) q) s),\n";
}

/** The own-record digest: 209 expression unless the record is this function with exactly this body. */
export function ownDigest271({sourceSha209,definitionSha209}){
 assert.match(sourceSha209,/^[a-f0-9]{64}$/);assert.match(definitionSha209,/^[a-f0-9]{64}$/);
 const predecessor=JSON.stringify({source:['sha256-utf8-text/v1',sourceSha209],definition:['sha256-utf8-text/v1',definitionSha209]});
 return "CASE WHEN record->>'kind'='function' AND record->>'key'="+literal(SNAPSHOT_KEY)
  +" AND record->'value'->'source'=(SELECT jsonb_build_array('sha256-utf8-text/v1',src_sha) FROM self271)"
  +" AND record->'value'->'definition'=(SELECT jsonb_build_array('sha256-utf8-text/v1',def_sha) FROM self271)"
  +" THEN encode(sha256(convert_to(((record->'value')||"+literal(predecessor)+"::jsonb)::text,'UTF8')),'hex')"
  +" ELSE "+OWN_DIGEST_209+" END";
}

export function deriveOrderMergeDelivery271Snapshot({sql209}={}){
 const body209=source209Body(sql209);
 for(const token of ['$function',QUOTE,PLACEHOLDER,'$snapshot271$'])assert(!body209.includes(token),'209 body free of '+token);
 const sourceSha209=sha(body209),definitionSha209=sha(DEFINITION_HEADER+body209+DEFINITION_FOOTER);
 let template=body209;
 for(const [before,after] of REWRITES)template=once(template,before,after);
 template=once(template,OWN_DIGEST_209,ownDigest271({sourceSha209,definitionSha209}));
 template=once(template,SELF_CTE_ANCHOR,selfCte()+'legacy209_current(kind,key,value) AS MATERIALIZED (');
 assert.equal(template.split(PLACEHOLDER).length,2,'one placeholder');
 for(const token of ['$function',QUOTE,'$snapshot271$'])assert(!template.includes(token),'template free of '+token);
 const body=template.replace(PLACEHOLDER,()=>QUOTE+template+QUOTE);
 const sourceSha271=sha(body),definitionSha271=sha(DEFINITION_HEADER+body+DEFINITION_FOOTER);
 return Object.freeze({schema:'order-merge-delivery271-snapshot/v1',body209,template,body,
  create:SNAPSHOT_271_CREATE+body+'$snapshot271$;',
  sourceSha209,definitionSha209,sourceSha271,definitionSha271});
}
