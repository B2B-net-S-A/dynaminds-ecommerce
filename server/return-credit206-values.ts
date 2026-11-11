/** Successor financial model only. A JSON shape is never native history or IAM authority. */
import {z} from 'zod';
import {creditUuid,type ConsumerCreditSource,type ConsumerCreditCalculation,type ConsumerAcceptance} from './local-consumer-credit-values';
export const RETURN_CREDIT206_LIMITS={returns:1000,lines:101,input_bytes:33554432,output_bytes:2097152,series:100,yearly_numbers:999999} as const;
export const returnCredit206SeriesInput=z.strictObject({client_key:creditUuid,name:z.string().trim().min(1).max(120).refine(v=>!/[\x00-\x1f\x7f]/.test(v)),prefix:z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,23}$/).default('KOR-ZWROT')});
export type ReturnCredit206Series={id:string;version:string;name:string;prefix:string;enabled:boolean};
export type ReturnCredit206Calculation=Omit<ConsumerCreditCalculation,'schema'>&{schema:'consumer-return-credit-calculation/v2';physical_history_hash:string};
export type ReturnCredit206Previous=Omit<ConsumerCreditSource['previous_credits'][number],'calculation'>&{calculation:ConsumerCreditCalculation|ReturnCredit206Calculation};
export type ReturnCredit206RejectedInspection={return_id:string;receipt_id:string;completed_at:string;evidence_hash:string};
export type ReturnCredit206Source={schema:'consumer-return-credit-source/v2';original:ConsumerCreditSource['original'];acceptances:ConsumerAcceptance[];rejected_inspections:ReturnCredit206RejectedInspection[];previous_credits:ReturnCredit206Previous[];selected_return_id:string;physical_protocols:{return_id:string;receipt_id:string;protocol:'rma'|'assistant_v1'|'destinations_v1'}[];credit_families:{document_id:string;receipt_id:string;family:'legacy'|'destinations';created_at:string}[]};
export type ReturnCredit206Decision={status:'credit_required'|'no_commercial_change'|'already_credited'|'earlier_acceptance_required';next_return_id:string|null;selected_return_id:string;physical_history_hash:string;calculation:ReturnCredit206Calculation|null};
/** Three-component numbers are structurally disjoint from legacy KOR/prefix/year/seq.
 * No counter is allocated here. Native issue must lock and atomically consume a number. */
export function returnCredit206Number(prefix:string,year:number,sequence:number){
 const parsed=returnCredit206SeriesInput.shape.prefix.parse(prefix);
 if(!Number.isSafeInteger(year)||year<2006||year>2050||!Number.isSafeInteger(sequence)||sequence<1||sequence>RETURN_CREDIT206_LIMITS.yearly_numbers)throw Error('Nieprawidłowa seria lub numer korekty');
 return parsed+'/'+year+'/'+String(sequence).padStart(6,'0');
}
const positiveVersion=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
export const returnCredit206PreviewInput=z.strictObject({client_key:creditUuid,original_document_id:creditUuid,return_id:creditUuid,expected_return_version:positiveVersion,series_id:creditUuid,expected_series_version:positiveVersion,reason:z.string().trim().min(3).max(500).refine(v=>!/[\x00-\x1f\x7f]/.test(v)),ordinary_domestic_confirmed:z.literal(true),local_only:z.literal(true)});
export {localConsumerCreditIssueInput as returnCredit206IssueInput,localConsumerCreditPageQuery as returnCredit206PageQuery,creditUuid} from './local-consumer-credit-values';
export type ReturnCredit206Snapshot={schema:'consumer-return-credit/v2';original_document:ConsumerCreditSource['original']['document'];physical_history_hash:string;correction_series:Pick<ReturnCredit206Series,'id'|'version'|'name'|'prefix'>;calculation:ReturnCredit206Calculation;reason:string;return_version:string;issue_date:string;local_only:true;ksef_state:'not_submitted';fiscalized:false};
export type ReturnCredit206Preview={id:string;original_document_id:string;return_id:string;scope_hash:string;calculation_hash:string;snapshot:ReturnCredit206Snapshot;expires_at:string;can_issue:boolean;issued_document_id:string|null};
export type ReturnCredit206Document={id:string;order_id:string;original_document_id:string;return_id:string;kind:'correction';mode:'consumer_return_credit';number:string;data:ReturnCredit206Snapshot&{number:string;preview_id:string;scope_hash:string;year:number;sequence:number};created_at:string};
