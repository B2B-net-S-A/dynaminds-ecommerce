/** Trusted service adapter for the existing commercial RMA core. No HTTP route,
 * actor injection, transaction, physical fallback, or retry is defined here.
 */
import { isDeepStrictEqual } from 'node:util';
import { receiveReturn, decideReturn, receiveInput, decisionInput } from './returns';
import { ensure } from './errors';
import type { ReturnDestinationsCoreAdapter } from './return-destinations';

export const receiveReturnDestinationCoreInTx: ReturnDestinationsCoreAdapter = async (c, actor, id, input, internal) => {
  if (internal.action === 'reject') {
    const decision = decisionInput.parse(input);
    ensure(decision.decision === 'reject' && isDeepStrictEqual(decision, input), 409,
      'Odrzucenie musi odpowiadać dokładnej zapisanej decyzji');
    return decideReturn(c, actor, id, decision, { destinationAdmissionId: internal.destinationAdmissionId,
      beforeFinish: internal.beforeFinish });
  }
  ensure(internal.action === 'receive', 409, 'Nieznana decyzja przyjęcia');
  const receipt = receiveInput.parse(input);
  ensure(isDeepStrictEqual(receipt, input), 409, 'Przyjęcie musi odpowiadać dokładnemu zapisanemu rozpatrzeniu');
  return receiveReturn(c, actor, id, receipt, false, { destinationAdmissionId: internal.destinationAdmissionId,
    applyDestinationPhysical: internal.applyDestinationPhysical, beforeFinish: internal.beforeFinish, completion: internal.completion });
};
