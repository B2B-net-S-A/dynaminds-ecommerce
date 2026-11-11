/** Pure server-side serialization contract; no default IO, connection or authority. */
import {createHash} from 'node:crypto';
import type {CoreReview} from '../pim-large-import-job-coordinator-backend5/core-review';
import type {Job} from '../pim-large-import-job-coordinator-backend5/coordinator';
import {decodeReview} from './review-store';
const hash=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
/** Exactly the immutable coordinator5 algorithm, including integer property enumeration and UTF16 sort. */
export const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
export const canonicalText=(v:unknown)=>JSON.stringify(canonical(v));
export type NativeBindings={scope_text:string;request_texts:string[];row_texts:string[]};
export function scopeProjection(r:CoreReview){return {schema:r.schema,source_plan_hash:r.source_plan_hash,raw:r.raw,parsing_spec:r.parsing_spec,batches:r.batches.map(b=>({index:b.index,preview_id:b.preview_id,scope_hash:b.scope_hash,preview_key:b.preview_key,execute_key:b.execute_key,request_hash:b.request_hash,rows_hash:b.rows_hash,resolution:b.resolution,source_hash:b.eligibility.source_hash,authority_revision:b.eligibility.authority_revision}))};}
/** Strict JS canonical byte validation remains mandatory before save and after every stored read. */
export function nativeBindings(r:CoreReview,j:Job):NativeBindings{
 const text=JSON.stringify(r);decodeReview(text,hash(text),j);
 const result={scope_text:canonicalText(scopeProjection(r)),request_texts:j.core.map(c=>canonicalText(c.request)),row_texts:r.batches.map(b=>canonicalText(b.preview.pages.flatMap(p=>p.rows)))};
 if(hash(result.scope_text)!==r.aggregate_scope_hash||result.request_texts.some((s,n)=>hash(s)!==r.batches[n].request_hash)||result.row_texts.some((s,n)=>hash(s)!==r.batches[n].rows_hash))throw Error('native-binding-canonical-digest');
 return result;
}
/** Semantic JSONB equality alone is insufficient: whitespace/key-order aliases must refuse here. */
export function verifyNativeBindings(actual:NativeBindings,r:CoreReview,j:Job):void{
 const expected=nativeBindings(r,j);
 if(!actual||actual.scope_text!==expected.scope_text||!Array.isArray(actual.request_texts)||!Array.isArray(actual.row_texts)||JSON.stringify(actual.request_texts)!==JSON.stringify(expected.request_texts)||JSON.stringify(actual.row_texts)!==JSON.stringify(expected.row_texts))throw Error('native-binding-not-exact-JS-canonical-bytes');
}
