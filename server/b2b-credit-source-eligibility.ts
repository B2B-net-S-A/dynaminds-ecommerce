/** SOURCE_ONLY_NOT_RUN. Pure proposed public projection, never an authority,
 * native history collector, endpoint fallback, or correction writer.
 * Caller must first validate the full original159 + whole160 history natively. */
import type {B2bCreditSource} from './b2b-credit-values';
export type CreditSourceEligibility160=B2bCreditSource&{
 eligible:boolean;
 eligibility_reason:'no_accepted_returns'|'all_received_returns_credited'|null;
};
export function tagEligibilityForVerifiedCreditSource160(source:Omit<B2bCreditSource,'eligible'|'eligibility_reason'>):CreditSourceEligibility160{
 const received=source.accepted_returns,prior=source.previous_credits;
 if(!Array.isArray(received)||!Array.isArray(prior)||prior.length>received.length)throw Error('Unverified full correction history');
 const next=received[prior.length]?.return_id??null;
 if(source.next_return_id!==next)throw Error('Unverified next correction source');
 if(received.length===0){
  if(prior.length!==0||source.next_return_id!==null)throw Error('Credits without accepted history');
  return {...source,eligible:false,eligibility_reason:'no_accepted_returns'};
 }
 if(next===null)return {...source,eligible:false,eligibility_reason:'all_received_returns_credited'};
 return {...source,eligible:true,eligibility_reason:null};
}
