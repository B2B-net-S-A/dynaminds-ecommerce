/** Source-only transformation tests. No PostgreSQL, trigger execution, or acceptance claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210WmsSuccessor as derive,addOrderSplit210WmsBranch as addBranch,
  assertOrderSplit210WmsPredecessor as assertBefore,ORDER_SPLIT210_WMS_BRANCH as branch,
  ORDER_SPLIT210_WMS_SOURCE as pins} from '../tools/parity/order-split210-wms-successor.mjs';
const source104=readFileSync(new URL('../server/104_order_merge_custody.sql',import.meta.url),'utf8');
const source108=readFileSync(new URL('../server/108_b2b_dropshipping.sql',import.meta.url),'utf8');
const run=()=>derive({source104,source108});
const hash=v=>createHash('sha256').update(v).digest('hex');
const declaration='\nDECLARE l record;op record;f record;p record;BEGIN';

test('literal104 plus actual108 B2B edit reproduces complete independently compiled predecessor',()=>{
  const result=run(),change=result.changes[0];
  assert.equal(result.changes.length,1);assert.equal(change.key,'public.wms_row_guard()');
  assert.equal(result.before_record_sha256,'c2b12caaf79c2347e1a06557ac62dae1963647edb9527d8fa313e96c85d07669');
  assert.equal(result.after_record_sha256,'f573804fc6f47b5d36e0a451448db22e461a50e718d6bff08114284654b1f556');
  assert.equal(hash(change.before.source),'d3470c4726c70f07e302e978efddca31ecc545a55106b14122141ec6333345c1');
  assert(change.before.source.includes("b2b_dropship_wms_change_allowed(to_jsonb(OLD),to_jsonb(NEW),TG_OP)"));
  assert.equal(result.source_inputs.source208_catalogue_gzip_sha256,'320ba526496c79605630b7b1c98128bd3039251d72365ceedc75798e2650987d');
  assert.equal(result.source_compilation_performed,false);assert.equal(result.native_certification,false);
  assert.equal(result.application_activation,false);
});

test('new branch is the only byte delta, with exact old invoker header and ACL retained',()=>{
  const r=run(),{before,after}=r.changes[0];
  assert.equal(after.source.replace(branch,''),before.source);
  assert.equal(after.definition.replace(branch,''),before.definition);
  const withoutBody=({source,definition,...header})=>header;
  assert.deepEqual(withoutBody(after),withoutBody(before));
  assert.equal(after.security_definer,false);assert.equal(after.config,null);assert.equal(after.acl_null,true);
  assert.deepEqual(after.acl.map(a=>a.grantee),['PUBLIC','postgres']);
  assert.equal(r.sql,after.definition+';\n');
  assert(!r.sql.includes('GRANT '));assert(!r.sql.includes('ALTER '));
  assert(Object.isFrozen(r)&&Object.isFrozen(after)&&Object.isFrozen(after.acl[0]));
});

test('quoted historical declarations, BEGINs and nested function text are never rewritten',()=>{
  const quoted=`\n x:=$history$CREATE FUNCTION unrelated() RETURNS trigger AS $nested$${declaration}\n RETURN OLD;END$nested$;$history$;
 -- ${declaration.slice(1)}
 x:='BEGIN; DECLARE l record;op record;f record;p record;BEGIN';
 RETURN NEW;END `;
  const source=declaration+quoted,after=addBranch(source);
  assert.equal(after.slice(declaration.length+branch.length),quoted);
  assert.equal(after.slice(0,declaration.length),declaration);
  assert.equal(after.split('public.order_split210_row_admission(').length,2);
});

test('ordinary invoker path cannot call private port; owner still needs positive exact proof',()=>{
  const body=run().changes[0].after.source;
  // Separate nested IF ensures the private expression is not evaluated in the
  // ordinary dyna_app branch; a SQL AND evaluation-order assumption is unnecessary.
  assert(body.startsWith(declaration+branch+'\n IF TG_TABLE_NAME=\'wms_reservation_layers\' AND b2b_'));
  assert(branch.includes("IF current_user='postgres' AND TG_TABLE_NAME='wms_reservation_layers' THEN\n  IF public."));
  assert(branch.includes("CASE WHEN TG_OP='INSERT' THEN NULL::jsonb ELSE to_jsonb(OLD) END"));
  assert(branch.includes("CASE WHEN TG_OP='DELETE' THEN NULL::jsonb ELSE to_jsonb(NEW) END) IS TRUE THEN"));
  assert(branch.includes("IF TG_OP='DELETE' THEN RETURN OLD;END IF;\n   RETURN NEW;"));
  assert(!branch.includes('set_config'));assert(!branch.includes('current_setting'));
  assert(body.indexOf("RAISE EXCEPTION 'Historia WMS jest nieusuwalna'")>body.indexOf(branch));
});

test('any source drift is refused before deriving a successor',()=>{
  assert.throws(()=>derive({source104:source104+'\n',source108}),/literal Source104/);
  assert.throws(()=>derive({source104,source108:source108.replace('b2b_dropship_wms_change_allowed','other_allowance')}),/literal Source108/);
  assert.throws(()=>derive({source104,source108:''}),/literal Source108/);
  assert.equal(hash(source104),pins.source104_sha256);assert.equal(hash(source108),pins.source108_sha256);
});

test('body, header, ACL, overload identity, extra fields and absent predecessor all fail exact pin',()=>{
  const value=run().changes[0].before,record={kind:'function',key:'public.wms_row_guard()',value};
  assert.equal(assertBefore(record),record);
  for(const mutate of [
    r=>r.key='public.wms_row_guard(extra integer)',r=>r.value.owner='dyna_app',
    r=>r.value.source+=' ',r=>r.value.definition+=' ',r=>r.value.security_definer=true,
    r=>r.value.config=['search_path=public'],r=>r.value.volatility='s',
    r=>r.value.acl_null=false,r=>r.value.acl[0].grantable=true,r=>r.value.acl.pop(),
    r=>r.value.extra='unexpected',r=>r.value.extra=undefined,r=>delete r.value.parallel,
  ]){const changed=structuredClone(record);mutate(changed);assert.throws(()=>assertBefore(changed));}
  assert.throws(()=>assertBefore(null));
});

test('unknown top-level declarations and a second successor are refused',()=>{
  assert.throws(()=>addBranch("-- declaration hidden in comment\n"+run().changes[0].before.source),/top-level/);
  assert.throws(()=>addBranch(declaration.replace('op record','different record')+'\n RETURN NEW;END'),/top-level/);
  assert.throws(()=>addBranch(run().changes[0].after.source),/already present/);
});
