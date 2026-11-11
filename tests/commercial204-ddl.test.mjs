import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const sql=readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
function creationTargets(source){
  const targets=[...source.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION ([^\s(]+)/gm)].map(m=>m[1]);
  assert.equal(targets.length,36);
  assert(targets.every(t=>/^public\.[a-z0-9_]+$/.test(t)),'all204-DDL-must-target-public-even-with-pg_catalog-first');
  return targets;
}
test('204 creates/replaces only exact public functions under any caller search_path',()=>{
  assert.deepEqual(creationTargets(sql),['public.partial_sale204_valid','public.partial_sale204_scope','public.partial_sale204_predecessor_definition','public.local_invoice_frame','public.local_invoice_fingerprint','public.order_parcel_release_frame','public.fa3_draft_fingerprint','public.b2b_invoice_fingerprint','public.manual_inventory_off_projected_definition','public.manual_inventory_off_fingerprint','public.manual_inventory_off_valid','public.manual_inventory_off_projection_valid','public.ordinary180_manual_basis','public.ordinary177_parent_hash','public.ordinary177_predecessor_project','public.wave_print177_history_map','public.wave_print177_valid','public.ordinary181_wave_valid','public.pim_dictionary_valid','public.cooperation171_valid','public.parcel_physical_wz_valid','public.operative_delivery_valid','public.nested172_valid','public.packed_label_print_guards','public.ordinary187_valid','public.financial_return_upgrade_valid','public.buyer_address_guards','public.wave_print177_history_operative_delivery_valid','public.ordinary181_history_operative_valid','public.ordinary181_financial_valid','public.ordinary181_buyer_guards','public.financial_return_fingerprint','public.buyer_address_fingerprint','public.ordinary181_nested_valid','public.ordinary181_packed_guards','public.ordinary181_parcel_valid']);
  assert(!sql.includes('CREATE OR REPLACE FUNCTION public.b2b_credit_fingerprint('),'preserve-genuine169-credit-function-literal');
});
test('both former unqualified replacements are rejected by regression',()=>{
  for(const name of ['local_invoice_frame','order_parcel_release_frame'])
    assert.throws(()=>creationTargets(sql.replace('CREATE OR REPLACE FUNCTION public.'+name+'(','CREATE OR REPLACE FUNCTION '+name+'(')),/all204-DDL-must-target-public/);
});
