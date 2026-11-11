/** Migration 257_order_merge_snapshot_index_paths (prepared as 271; Source271): the sealed Source209 snapshot body with
 * index paths and a quine self entry (docs/parity/MERGE209-SNAPSHOT-GEN271-20261029.md "Integracja jako 257"). Static
 * checks of the SQL file, its manifest row and the producer; the behaviour on a real catalogue is
 * tests/order-merge-delivery257.database.test.ts. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {RELEASE_MIGRATIONS} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
import {createHash} from 'node:crypto';
import {deriveOrderMergeDelivery271Snapshot as derive,REWRITES,OWN_DIGEST_209,SELF_CTE_ANCHOR,SNAPSHOT_271_CREATE,
 DEFINITION_HEADER,DEFINITION_FOOTER,PLACEHOLDER,QUOTE,ownDigest271} from '../tools/parity/order-merge-delivery271-snapshot.mjs';

const sql209=readFileSync(new URL('../server/209_order_merge_delivery_inheritance.sql',import.meta.url),'utf8');
const sql271=readFileSync(new URL('../server/257_order_merge_snapshot_index_paths.sql',import.meta.url),'utf8');
const sha=x=>createHash('sha256').update(x,'utf8').digest('hex');
const d=derive({sql209});
const bodyOf=sql=>{const i=sql.indexOf(SNAPSHOT_271_CREATE);assert(i>=0);const from=i+SNAPSHOT_271_CREATE.length;return sql.slice(from,sql.indexOf('$snapshot271$;',from));};

test('257 follows 256 in the release list and pins the exact SQL bytes',()=>{
 const i=RELEASE_MIGRATIONS.findIndex(m=>m.number===257),row=RELEASE_MIGRATIONS[i],b=readFileSync(new URL('../server/257_order_merge_snapshot_index_paths.sql',import.meta.url));
 assert(row,'manifest row 257');
 assert.equal(row.name,'257_order_merge_snapshot_index_paths');assert.equal(row.file,'257_order_merge_snapshot_index_paths.sql');
 assert.equal(row.native_id,'order_merge_snapshot257');assert.equal(row.cold.contract,'order-merge-snapshot257');assert.equal(row.cold.project,'projectCompiledOrderMergeSnapshot257Catalogue');
 assert.equal(row.bytes,b.length);assert.equal(row.sha256,createHash('sha256').update(b).digest('hex'));
 assert.equal(row.bytes,39793);assert.equal(row.sha256,'fe4b14ce3c2c7ae4889a37b03ef5a4418581f46df9bbbd683ffb3df411728c42');
 assert.equal(RELEASE_MIGRATIONS[i-1].name,'256_return_receipt_verdicts');
 assert.equal(RELEASE_MIGRATIONS[i+1]?.name,'258_wz_issuer_refresh','258 follows 257');
 assert.doesNotMatch(readFileSync(new URL('../server/db.ts',import.meta.url),'utf8'),/order_merge_snapshot_index_paths/,'db.ts takes 257 from the manifest, not a literal pair');
});

test('the file is the registered 257 migration and changes nothing but the snapshot body',()=>{
 assert.match(sql271.split('\n')[0],/^-- Migration 257_order_merge_snapshot_index_paths \(prepared as 271, registered after 256_return_receipt_verdicts;/);
 assert.equal(sql271.split(SNAPSHOT_271_CREATE).length,2,'one replacement of the snapshot');
 const outside=sql271.replace(SNAPSHOT_271_CREATE+bodyOf(sql271)+'$snapshot271$;','<snapshot271>')
  .split('\n').filter(line=>!line.startsWith('--')).join('\n');
 assert(!/\b(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|COMMENT|SECURITY LABEL)\b/i.test(outside),'no other DDL or DML');
 assert.equal((outside.match(/^DO \$[a-z0-9]+\$/gm)||[]).length,2,'one refusal before and one check after');
 // Before: only the exact Source209 text and a valid 209 installation are replaced.
 for(const literal of [d.sourceSha209,d.definitionSha209])assert(outside.includes("'"+literal+"'"));
 assert(outside.includes('public.order_merge_delivery209_valid() IS DISTINCT FROM true'));
 // After: the installed text is pinned and the answer is byte-identical to the answer before.
 for(const literal of [d.sourceSha271,d.definitionSha271])assert(outside.includes("'"+literal+"'"));
 assert(outside.includes("public.order_merge_delivery209_validation_snapshot()::text IS DISTINCT FROM current_setting('dyna.order_merge_snapshot271')"));
 for(const guard of ['order_merge_delivery209_valid','buyer_address_guards','return_credit206_guards'])
  assert(outside.split('IF ').some(part=>part.includes('public.'+guard+'() IS DISTINCT FROM true')),guard);
});

test('the body in the file is the producer output for the sealed 209 file',()=>{
 assert.equal(bodyOf(sql271),d.body);
 assert.equal(d.sourceSha209,sha(d.body209));
 assert.equal(d.definitionSha209,sha(DEFINITION_HEADER+d.body209+DEFINITION_FOOTER));
 assert.equal(d.sourceSha209,'ba515fa5528651b4da2218e6880c69fe08fc68e66943df12ea8be87a39f9ed06','live Source209 prosrc digest');
 assert.equal(d.definitionSha209,'b42da3eb74092804e8a92b0b8ba4adbf2e34c95af85f504ee2a3c463f4968461','live Source209 definition digest');
});

test('undoing the listed edits recovers the 209 body byte for byte',()=>{
 let t=d.template;
 const self=t.slice(t.indexOf('WITH self271('),t.indexOf('legacy209_current(kind,key,value) AS MATERIALIZED ('));
 t=t.replace(self,'WITH ');
 t=t.replace(ownDigest271(d),OWN_DIGEST_209);
 for(const [before,after] of [...REWRITES].reverse()){assert.equal(t.split(after).length,2);t=t.replace(after,()=>before);}
 assert.equal(t,d.body209);
 // The self CTE sits exactly where the 209 WITH began; nothing precedes it but the 209 leading newline.
 assert.equal(d.template.indexOf('WITH self271('),d.body209.indexOf(SELF_CTE_ANCHOR));
 assert.equal(d.body209.indexOf(SELF_CTE_ANCHOR),1);
});

test('every index edit keeps the 209 predicate verbatim and only adds a conjunct',()=>{
 for(const [before,after] of REWRITES){
  const predicate=before.startsWith('WHERE ')?before.slice(6):before;
  if(after.startsWith('WHERE (')){assert(after.startsWith('WHERE ('+predicate+') AND '),before.slice(0,60));}
  else if(before.startsWith('WITH rels')){assert(after.startsWith(before.slice(0,-1)+' AND ')&&after.endsWith(')'));}
  else assert(after.startsWith(before+' AND '),before.slice(0,60));
  const kept=before.startsWith('WITH rels')?before.slice(0,-1):after.startsWith('WHERE (')?predicate:before;
  assert.equal(after.split(kept).length,2);
  const extra=after.slice(after.indexOf(kept)+kept.length);
  assert(!/\bOR\b/.test(extra.replace(/UNION ALL/g,'')),'the added conjunct is not a disjunction');
  assert(!/\b(INSERT|UPDATE|DELETE|set_config|current_setting|EXECUTE)\b/i.test(extra));
 }
 assert.equal(REWRITES.length,6);
});

test('the name ranges contain every name the 209 prefix test accepts (bytewise, as for type name)',()=>{
 const X=Buffer.from('order_merge_delivery209_'),Y=Buffer.from('order_merge_delivery209`');
 const names=['order_merge_delivery209_','order_merge_delivery209_receipts','order_merge_delivery209_ż','order_merge_delivery209_\u{1F9EA}',
  'order_merge_delivery209_~','order_merge_delivery209_\u007f','order_merge_delivery209','order_merge_delivery209`','order_merge_delivery209^',
  'order_merge_delivery209a','order_merge_delivery208_x','order_merge_delivery210_x','_order_merge_delivery209_x','order_merge_delivery209__'];
 for(const n of names){
  const b=Buffer.from(n),starts=b.subarray(0,X.length).equals(X);
  const inRange=Buffer.compare(b,X)>=0&&Buffer.compare(b,Y)<0;
  if(starts)assert(inRange,n);
  // The range is a superset; the kept 209 predicate decides membership.
 }
 const U=Buffer.from('_order_merge_delivery209_'),V=Buffer.from('_order_merge_delivery209`');
 for(const n of names.map(n=>'_'+n)){const b=Buffer.from(n);if(b.subarray(0,U.length).equals(U))assert(Buffer.compare(b,U)>=0&&Buffer.compare(b,V)<0,n);}
});

test('the body computes its own expected text (quine), so no stored copy can be swapped',()=>{
 const open=d.body.indexOf(QUOTE),close=d.body.indexOf(QUOTE,open+QUOTE.length);
 assert(open>0&&close>open&&d.body.indexOf(QUOTE,close+QUOTE.length)<0,'one dollar-quoted literal');
 const template=d.body.slice(open+QUOTE.length,close);
 assert.equal(template,d.template);
 assert.equal(template.split(PLACEHOLDER).length,2);
 assert.equal(template.replace(PLACEHOLDER,()=>QUOTE+template+QUOTE),d.body);
 // pg_get_functiondef keeps the $function$ delimiter only while the body has no "$function".
 assert(!d.body.includes('$function'));assert(!d.body.includes('$snapshot271$'));
 assert(d.template.includes("replace(q.t,'#27'||'1#','$q2'||'71$'||q.t||'$q2'||'71$')"));
 assert(d.template.includes("'$fu'||'nction$'||s.src||'$fu'||'nction$'||chr(10)"));
});

test('the self entry: Source209 digest only for this exact text, the 209 expression otherwise',()=>{
 const own=ownDigest271(d);
 assert(own.endsWith(' ELSE '+OWN_DIGEST_209+' END'));
 assert(own.includes("record->>'key'='public.order_merge_delivery209_validation_snapshot()'"));
 assert(own.includes("record->'value'->'source'=(SELECT jsonb_build_array('sha256-utf8-text/v1',src_sha) FROM self271)"));
 assert(own.includes("record->'value'->'definition'=(SELECT jsonb_build_array('sha256-utf8-text/v1',def_sha) FROM self271)"));
 assert(own.includes(JSON.stringify({source:['sha256-utf8-text/v1',d.sourceSha209],definition:['sha256-utf8-text/v1',d.definitionSha209]})));
 assert.equal(d.template.split(own).length,2);
 // Every other field of the live record (owner, ACL, config, volatility, ...) stays live inside the THEN branch.
 assert(own.includes("((record->'value')||"));
});
