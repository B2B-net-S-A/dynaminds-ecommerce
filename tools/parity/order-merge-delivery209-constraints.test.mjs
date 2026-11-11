import test from 'node:test';
import assert from 'node:assert/strict';
import{orderMergeDelivery209CheckAst as ast,ORDER_MERGE_DELIVERY209_CHECK_EXPRESSIONS as E,assertOrderMergeDelivery209ConstraintChanges as verify}from'./order-merge-delivery209-constraints.mjs';
const fixture=()=>['buyer_address_previews','buyer_address_receipts'].flatMap(t=>['kind','actor'].map(k=>({kind:'constraint',key:'public.'+t+'.fixture_'+k,before:{definition:E[k+'_before'],validated:true,type:'c',deferrable:false,deferred:false},after:{definition:E[k+'_after'],validated:true,type:'c',deferrable:false,deferred:false}})));
test('independent authored CHECK oracle accepts PG casts/pretty parentheses and both table pairs',()=>{
 assert.deepEqual(ast("CHECK ((kind = ANY (ARRAY['access'::text, 'delivery'::text, 'merge_inherit'::text])))"),ast(E.kind_after));
 assert.equal(verify(fixture()),true);
});
test('CHECK oracle rejects changed boolean grouping, additional kind, actor bypass and unrelated metadata',()=>{
 for(const mutation of [
  c=>c[0].after.definition="CHECK (kind IN('access','delivery','merge_inherit','extra'))",
  c=>c[1].after.definition=E.actor_after.replace('actor_id IS NOT NULL','actor_id IS NULL'),
  c=>c[1].after.definition=E.actor_after.replace(" OR(kind='delivery'", " AND(kind='delivery'"),
  c=>c[2].after.validated=false,
  c=>c[3].before.definition=E.actor_after,
  c=>c[3].key='public.orders.other',
  c=>c.push(c[0]),
 ]){const c=fixture();mutation(c);assert.throws(()=>verify(c));}
});
test('CHECK parser refuses trailing SQL, unknown fields/casts/operators and resource abuse',()=>{
 for(const value of [E.kind_after+'; SELECT 1',"CHECK (other='access')","CHECK(kind='access'::varchar)","CHECK(kind<>'access')",'CHECK ('+'('.repeat(40)+"kind='access'"+')'.repeat(40)+')','CHECK ('+'x'.repeat(8200)+')'])assert.throws(()=>ast(value));
});
