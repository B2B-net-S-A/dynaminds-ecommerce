import {enlistFinancialReturn162ActorInTx,prepareFinancialReturn162InTx,claimFinancialReturn162InTx,replayFinancialReturn162InTx,completeFinancialReturn162InTx,discardFinancialReturn162Handle,type FinancialReturn162Handle} from './financial-return-completion';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { ensure } from './errors';
import {
  prepareCatalogStockReturnInTx, finishCatalogStockReturnInTx, abandonCatalogStockReturnInTx,
  catalogStockReturnSource, type CatalogStockReturnSource, type CatalogStockReturnAdmission,
  type CatalogStockReturnProof,
} from './catalog-stock-return-effects';
import { completeLocalReturnReceiveInTx, pinLocalReturnReceiveInTx } from './b2b-return-local-origins';
import { completeParcelReturnReceiveInTx, pinParcelReturnReceiveInTx } from './order-parcel-returns';

// A trusted enclosing transaction owns completion; neither a request UUID nor
// a public defer flag can postpone native validation or authorization.
export type ReturnCompletion = Readonly<{ id: string; return_id: string }>;
type Native = { local: { id: string; actor: Actor } | null; parcel: boolean };
type State = { client: PoolClient; actor: string; source: CatalogStockReturnSource;
  admission: CatalogStockReturnAdmission | null; financial:FinancialReturn162Handle|null; native?: Native;
  phase: 'prepared' | 'received' | 'replay' | 'complete' };
const custody = new WeakMap<ReturnCompletion, State>();
const actorKey = (a: Actor) => JSON.stringify([a.tenantId, a.userId, a.apiKeyId ?? null, a.source ?? 'manual']);
function state(c: PoolClient, a: Actor, h: ReturnCompletion) {
  const s = custody.get(h);
  ensure(s && s.client === c && s.actor === actorKey(a) && h.return_id === s.source.return_id,
    403, 'Obcy koordynator przyjęcia zwrotu');
  return s;
}
export async function prepareReturnCompletionInTx(c: PoolClient, a: Actor, raw: CatalogStockReturnSource): Promise<ReturnCompletion> {
  const source = catalogStockReturnSource.parse(raw);
  const admission = await prepareCatalogStockReturnInTx(c, a, source);
  const financial = await prepareFinancialReturn162InTx(c,a,source);
  const handle = Object.freeze({ id: randomUUID(), return_id: source.return_id });
  custody.set(handle, { client: c, actor: actorKey(a), source, admission, financial, phase: 'prepared' });
  return handle;
}
export function assertReturnCompletionInTx(c: PoolClient, a: Actor, h: ReturnCompletion, id: string, input: unknown) {
  const s = state(c, a, h);
  ensure(s.phase === 'prepared' && h.return_id === id && isDeepStrictEqual(s.source.request, input),
    409, 'Koordynator nie odpowiada dokładnemu przyjęciu zwrotu');
}
export async function enlistReturnCompletionActorInTx(c:PoolClient,a:Actor,h:ReturnCompletion){
 const s=state(c,a,h);
 const next=await enlistFinancialReturn162ActorInTx(c,a,s.financial);
 state(c,next,h);return next;
}
export async function claimFinancialReturnCompletionInTx(c:PoolClient,a:Actor,h:ReturnCompletion){
 const s=state(c,a,h);ensure(s.phase==='prepared',409,'Financial receive already left source phase');
 await claimFinancialReturn162InTx(c,a,s.financial);
}
export function retainNativeReturnCompletionInTx(c: PoolClient, a: Actor, h: ReturnCompletion, native: Native) {
  const s = state(c, a, h);
  ensure(s.phase === 'prepared', 409, 'Przyjęcie zwrotu ma już fazę końcową');
  s.native = native; s.phase = 'received';
}
export async function replayReturnCompletionInTx(c: PoolClient, a: Actor, h: ReturnCompletion) {
  const s = state(c, a, h);
  ensure(s.phase === 'prepared', 409, 'Nie można porzucić zmienionego przyjęcia zwrotu');
  await abandonCatalogStockReturnInTx(c, a, s.admission);
  await replayFinancialReturn162InTx(c,a,s.financial);
  await completeFinancialReturn162InTx(c,a,s.financial);
  s.phase = 'replay';
}
/** All replacement/order/financial writes and outer native parents are done.
 * Complete112/138 creates the genuine seals;169 adds proof, never inventory. */
export async function completeReturnCompletionInTx(c: PoolClient, a: Actor, h: ReturnCompletion,
  parents: CatalogStockReturnProof = {}) {
  const s = state(c, a, h);
  if (s.phase === 'replay') {await completeFinancialReturn162InTx(c,a,s.financial);return;}
  ensure(s.phase === 'received' && s.native, 409, 'Brak rzeczywistego przyjęcia do zamknięcia');
  const local = await completeLocalReturnReceiveInTx(c, s.native.local);
  const parcel = await completeParcelReturnReceiveInTx(c, a, h.return_id, s.native.parcel);
  const operation = (await c.query("SELECT id FROM wms_operations WHERE return_id=$1 AND kind='return'", [h.return_id])).rows[0];
  await finishCatalogStockReturnInTx(c, a, s.admission, {
    ...parents, ...(local ? { local_proof_id: local } : {}),
    ...(parcel ? { parcel_receipt_return_id: parcel } : {}),
    ...(operation ? { wms_operation_id: operation.id } : {}),
  });
  await completeFinancialReturn162InTx(c,a,s.financial);
  s.phase = 'complete';
}
/** Called only after terminal deferred checks and final response hydration. */
export async function pinReturnCompletionInTx(c: PoolClient, a: Actor, h: ReturnCompletion) {
  const s = state(c, a, h);
  ensure(s.phase === 'complete' || s.phase === 'replay', 409, 'Niekompletne przyjęcie zwrotu');
  if (s.native) {
    await pinLocalReturnReceiveInTx(c, s.native.local);
    await pinParcelReturnReceiveInTx(c, a, s.native.parcel);
  }
  discardFinancialReturn162Handle(c,a,s.financial);
  custody.delete(h);
}
