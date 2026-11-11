import test from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {consumerCreditPreviewCanIssue as canIssue,consumerCreditPreviewIssueState as hydrate} from '../server/consumer-credit-preview-state';
const now=Date.UTC(2026,9,17),actor={userId:'own-actor'},preview={actor_id:actor.userId,api_key_id:null,expires_at:new Date(now+1000),issued_document_id:null};
test('an issued preview stays non-issuable even for its original actor with current write access and a future expiry',()=>{
 assert.equal(canIssue(preview,true,actor,now),true);
 assert.equal(canIssue({...preview,issued_document_id:'persisted-document'},true,actor,now),false);
});
test('immutable preview command replay is hydrated from the issued receipt for both financial families',async()=>{
 const current={...preview,id:'own-preview',expires_at:new Date(Date.now()+60000)},owner={...actor,tenantId:'own-tenant'};
 for(const family of ['legacy','destinations'] as const){
  let issued=false;
  const query=async(sql:string,args:unknown[])=>{assert.deepEqual(args,[owner.tenantId,current.id]);assert(sql.includes(family==='legacy'?'public.local_consumer_credit_receipts':'public.return_credit206_receipts'));return{rows:issued?[{document_id:'persisted-document'}]:[]};};
  const c={query} as unknown as Pick<PoolClient,'query'>;
  assert.deepEqual(await hydrate(c,family,current,true,owner),{issued_document_id:null,can_issue:true});
  issued=true;assert.deepEqual(await hydrate(c,family,current,true,owner),{issued_document_id:'persisted-document',can_issue:false});
 }
});
test('read-only, expiry and changed actor/key deny issuance independently of document state',()=>{
 assert.equal(canIssue(preview,false,actor,now),false);
 assert.equal(canIssue({...preview,expires_at:new Date(now)},true,actor,now),false);
 assert.equal(canIssue({...preview,expires_at:'not-a-date'},true,actor,now),false);
 assert.equal(canIssue(preview,true,{userId:'other'},now),false);
 assert.equal(canIssue({...preview,api_key_id:'revoked-key'},true,actor,now),false);
 assert.equal(canIssue({...preview,api_key_id:'own-key'},true,{...actor,apiKeyId:'own-key'},now),true);
});
