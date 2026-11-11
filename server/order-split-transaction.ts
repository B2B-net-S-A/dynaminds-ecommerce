/** Fixed split duty lifecycle, not transaction/lease or Native admission proof.
 * The actual manager must begin on its genuine entered client, retain this
 * ledger through inner callback cleanup, then drain/seal and finalize at the
 * actual outer tail. End only after that transaction has committed/rolled back.
 * No ordinary write route is enabled by this unregistered adapter. */
import type {PoolClient} from 'pg';
import {ensure} from './errors';
import {orderSplitUuid} from './order-splits-schema';
import {finalizeOrderSplitRequestInTx,type OrderSplitRequest} from './order-split-transport';

type Kind='preview'|'execute';
type Duty=Readonly<{request:OrderSplitRequest;kind:Kind;headId:string}>;
type Transaction={phase:'open'|'finalizing'|'finished'|'failed';duty?:Duty};
const transactions=new WeakMap<PoolClient,Transaction>();
function current(c:PoolClient){const tx=transactions.get(c);ensure(tx,503,'Brak zarządzanego kontekstu podziału');return tx;}

export function beginOrderSplitTransaction(c:PoolClient){
 ensure(!transactions.has(c),503,'Powtórzony kontekst transakcji podziału');
 transactions.set(c,{phase:'open'});
}
export function endOrderSplitTransaction(c:PoolClient){transactions.delete(c);}
/** Presence only; never a readiness/authorization or authentic-lease verdict. */
export function hasOrderSplitTransactionDuty(c:PoolClient){return !!transactions.get(c)?.duty;}
export function enlistOrderSplitTransaction(c:PoolClient,request:OrderSplitRequest,kind:Kind,headId:string){
 const tx=current(c);ensure(tx.phase==='open',503,'Końcowa kontrola podziału już rozpoczęta');
 ensure(request&&typeof request==='object',401,'Brak oryginalnego żądania podziału');
 ensure(kind==='preview'||kind==='execute',422,'Nieprawidłowa operacja podziału');
 const id=orderSplitUuid.parse(headId);
 if(tx.duty){
  ensure(tx.duty.request===request&&tx.duty.kind===kind&&tx.duty.headId===id,409,'Inna operacja lub żądanie w transakcji podziału');
  return;
 }
 // The real finalizer validates the captured handle's private WeakMap entry.
 // This ledger neither reconstructs credentials nor accepts caller authority.
 tx.duty=Object.freeze({request,kind,headId:id});
}
export async function finalizeOrderSplitTransactionInTx(c:PoolClient){
 const tx=current(c);ensure(tx.phase==='open',503,'Końcowej kontroli podziału nie wolno ponawiać');
 tx.phase='finalizing';
 try{
  if(tx.duty)await finalizeOrderSplitRequestInTx(c,tx.duty.request,tx.duty.kind,tx.duty.headId);
  tx.phase='finished';
 }catch(e){tx.phase='failed';throw e;}
}
