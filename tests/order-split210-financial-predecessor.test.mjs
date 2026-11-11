import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210FinancialPredecessors,ORDER_SPLIT210_FINANCIAL_PREDECESSOR_SOURCE} from '../tools/parity/order-split210-financial-predecessor.mjs';
const source204=fs.readFileSync(new URL('../server/204_partial_commercial_sale_scope.sql',import.meta.url),'utf8');
const result=deriveOrderSplit210FinancialPredecessors({source204}),key='public.financial_return_upgrade_valid()',sha=v=>createHash('sha256').update(v).digest('hex');
test('partial204 financial family equals entire actual Source189 authored definition',()=>{
 const source189=fs.readFileSync(new URL('../server/189_packing_required_order_fields.sql',import.meta.url),'utf8');assert.equal(Buffer.byteLength(source189),5601904);assert.equal(sha(source189),'6f0c071852c68a40c545e3d08fbcb60578bb7b43616439f1d1e8585fb150cbc2');
 const sites=[...source189.matchAll(/^CREATE OR REPLACE FUNCTION public\.financial_return_upgrade_valid\(\)/gm)];assert.equal(sites.length,1);const at=sites[0].index,open=source189.indexOf('AS $function$',at)+'AS $function$'.length,end=source189.indexOf('$function$;',open);assert(end>open);
 assert.equal(result.families.partial204[key],source189.slice(at,end+'$function$'.length)+'\n');assert.equal(sha(result.before204.source),ORDER_SPLIT210_FINANCIAL_PREDECESSOR_SOURCE.original189_body_sha256);
});
test('manual169 financial path is current204 identity, not the partial204 historical family',()=>{
 assert.equal(result.families.manual169[key],result.current_before.definition);assert.notEqual(result.families.manual169[key],result.families.partial204[key]);assert.equal(Buffer.byteLength(result.current_before.source),67979);assert.equal(Buffer.byteLength(result.before204.source),67329);
 assert.equal(Object.keys(result.current_before).length,24);const head=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));assert.deepEqual(head(result.current_before),head(result.before204));assert.equal(result.current_before.volatility,'v');assert.deepEqual(result.current_before.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
});
test('families have one exact identity and no observed authority or runtime execution flags',()=>{
 for(const family of ['partial204','manual169'])assert.deepEqual(Object.keys(result.families[family]),[key]);assert(Object.isFrozen(result.families.partial204));assert(Object.isFrozen(result.current_before));assert.equal(result.source_compilation_performed,false);assert.equal(result.native_certification,false);assert.equal(result.application_activation,false);
});
test('full source/header/body drift and appended source are refused',()=>{
 for(const changed of [source204+'\n',source204.replace('CREATE OR REPLACE FUNCTION public.financial_return_upgrade_valid()','CREATE OR REPLACE FUNCTION public.financial_return_upgrade_spoof()'),source204.replace('original:=$old204$','original:=$fake204$')])assert.throws(()=>deriveOrderSplit210FinancialPredecessors({source204:changed}));
});
test('source getter and extra caller family expectations are refused without invocation',()=>{
 let reads=0;const options={get source204(){reads++;return source204;}};assert.throws(()=>deriveOrderSplit210FinancialPredecessors(options));assert.equal(reads,0);assert.throws(()=>deriveOrderSplit210FinancialPredecessors({source204,families:result.families}));
});
