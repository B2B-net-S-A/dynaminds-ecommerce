/** Pure source derivation; no PG/HTTP/factory, Native certificate or acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {deriveReturnCredit208,MIGRATION208} from '../tools/parity/return-credit208-source.mjs';
import {RETURN_CREDIT207_SOURCE_CONTRACT as E} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-contract.mjs';
import {deriveFull208Fingerprint} from '../tools/parity/return-credit208-full-fingerprint.candidate.mjs';
const root=new URL('../',import.meta.url),inputs={};
for(const[k,p]of Object.entries({source207:'server/207_consumer_return_credit.sql',source206:'server/206_return_credit_destinations_history.sql',source188:'server/188_local_consumer_credit.sql',structure188:'server/188_consumer_credit_structure.sql',template:'tools/parity/return-credit208.template.sql'}))inputs[k]=await fs.readFile(new URL(p,root),'utf8');
const derived=deriveReturnCredit208(inputs),guard=derived.changes[0],require=derived.changes[1];
test('candidate is reproducibly derived from exact frozen predecessors, with only two body changes',async()=>{
 assert.equal(await fs.readFile(new URL('server/'+MIGRATION208+'.sql',root),'utf8'),derived.sql);
 assert.deepEqual(deriveReturnCredit208(inputs),derived);
 assert.equal(derived.changes.length,2);
 for(const change of derived.changes){
  const {source:a,definition:b,...before}=change.before,{source:c,definition:d,...after}=change.after;
  assert.deepEqual(before,after);assert.notEqual(a,c);assert.equal(b.replace(a,()=>c),d);
 }
 assert.equal(derived.source_compilation_performed,false);assert.equal(derived.native_certification,false);assert.equal(derived.application_activation,false);
});
test('any predecessor drift or malformed template refuses rather than deriving a new baseline',()=>{
 for(const key of ['source207','source206','source188','structure188'])assert.throws(()=>deriveReturnCredit208({...inputs,[key]:inputs[key]+'\n'}),/frozen-predecessor/);
 for(const bad of [inputs.template.replace('@@GUARD@@',''),inputs.template+'@@REQUIRE@@',inputs.template+'@@UNKNOWN@@'])assert.throws(()=>deriveReturnCredit208({...inputs,template:bad}));
});
test('removed direct predicates are each still present in unchanged full188, retaining origin/structure/parents',()=>{
 const original188=inputs.source188.slice(inputs.source188.indexOf('CREATE FUNCTION local_consumer_credit_guards()'),inputs.source188.indexOf('CREATE FUNCTION local_consumer_credit_terminal('));
 for(const call of ['local_invoice_guards()','catalog_stock_return_guards()','b2b_credit_guards()']){
  assert(guard.before.source.includes('public.'+call));assert(!guard.after.source.includes('public.'+call));assert(original188.includes('public.'+call));
 }
 for(const kept of ["current_setting('session_replication_role')<>'origin'","relrowsecurity AND relforcerowsecurity)<>8",'public.local_consumer_credit_guards()','public.ordinary188_structure_valid()','c.original157=','c.original160='])assert(guard.after.source.includes(kept),kept);
 assert(guard.after.source.includes('s.original207=to_jsonb(c)'));assert(guard.after.source.includes('s.successor207_fingerprint=public.return_credit206_fingerprint()'));assert(guard.after.source.includes('s.fingerprint=public.return_credit208_fingerprint()'));assert(guard.after.source.includes(',false)'));
});
test('require removes only already-covered157/169 checks; identity/access/pin and all other native bodies stay literal',()=>{
 assert.equal(require.after.source,require.before.source.replace(' OR NOT public.local_invoice_guards() OR NOT public.catalog_stock_return_guards()',''));
 for(const kept of ['public.return_credit206_installed()','public.return_credit206_guards()','PERFORM public.local_invoice_require(uid,kid,writing,pin);'])assert(require.after.source.includes(kept));
 const ddl=derived.sql.slice(derived.sql.indexOf('END $pre208$;')+'END $pre208$;'.length);
 assert.deepEqual([...ddl.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)/g)].map(x=>x[1]),['public.return_credit206_guards','public.return_credit206_require']);
 assert.doesNotMatch(ddl,/\b(?:UPDATE|DELETE FROM|TRUNCATE|INSERT INTO)\s+(?:public\.)?(?:local_|b2b_|return_credit206_)/i);
 assert.doesNotMatch(ddl,/\b(?:SET LOCAL|set_config|statement_timeout|ALTER ROLE|ALTER DEFAULT PRIVILEGES|DISABLE TRIGGER|COMMIT|ROLLBACK)\b/i);
});
test('preflight contains the exact539 source descriptors, including opposite-side FK triggers, before any new DDL',()=>{
 const literal=derived.sql.split('$expected207$');assert.equal(literal.length,3);assert.deepEqual(JSON.parse(literal[1]),E.additions);
 assert(derived.recordsSql.includes('t.tgconstraint IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))'));
 assert(E.additions.some(r=>r.kind==='trigger'&&r.key.startsWith('public.api_keys.internal:')));
 assert(!derived.recordsSql.includes("n.nspname IN ('public','ordinary187_private')"));
 assert(derived.sql.indexOf('exact independently source-compiled539')<derived.sql.indexOf('CREATE TABLE public.return_credit208_manifest'));
});
test('new manifest is private and immutable; no old certificate or existing function ACL is written',()=>{
 for(const atom of ['ENABLE ROW LEVEL SECURITY','FORCE ROW LEVEL SECURITY','TO postgres USING(true) WITH CHECK(true)','BEFORE UPDATE OR DELETE','BEFORE TRUNCATE','a.grantee<>c.relowner','a.grantee<>p.proowner'])assert(derived.sql.includes(atom),atom);
 assert.equal((derived.sql.match(/INSERT INTO public.return_credit208_manifest/g)??[]).length,1);
 assert.doesNotMatch(derived.sql,/GRANT EXECUTE|UPDATE public\.return_credit206_manifest|ALTER TABLE public\.return_credit206_manifest/);
});
test('recut candidate full fingerprint covers only208 with complete table/type/routine metadata',()=>{
 const full=deriveFull208Fingerprint(derived.recordsSql);assert(!full.includes('return_credit206_'));
 for(const atom of ["starts_with(relname,'return_credit208_')","starts_with(t.typname,'_return_credit208_')","'options',c.reloptions","'security_definer',p.prosecdef","'acl_null',t.typacl IS NULL","'kind',kind,'key',key,'value',value",'t.tgconstraint IN'])assert(full.includes(atom),atom);
 assert.equal((full.match(/ UNION ALL SELECT /g)??[]).length,7);
 assert.throws(()=>deriveFull208Fingerprint(derived.recordsSql.replaceAll('return_credit206_','return_credit207_')));
 assert(derived.sql.includes('$fingerprint208$'+full+'$fingerprint208$'));
 assert.equal(derived.sql,deriveReturnCredit208(inputs).sql,'candidate derivation is deterministic');
});
