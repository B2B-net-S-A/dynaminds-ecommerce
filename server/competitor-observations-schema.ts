import {z} from 'zod';
export const COMPETITOR_OBSERVATION_LIMITS={batch_rows:1000,batch_bytes:1_000_000,page:50} as const;
const identifier=z.string().min(1).max(200).refine(v=>v.trim()===v&&!v.includes('\0'));
export const competitorMinor=z.string().regex(/^(?:0|[1-9]\d{0,8})$/).refine(v=>/^(?:0|[1-9]\d{0,8})$/.test(v)&&BigInt(v)<=100000000n);
export const competitorUtc=z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/).refine(v=>{
 const seconds=v.slice(0,19),ms=Date.parse(seconds+'Z');return Number.isFinite(ms)&&ms>=0&&new Date(ms).toISOString().slice(0,19)===seconds;
});
export const competitorObservationInput=z.strictObject({product_id:z.uuid(),source_namespace:identifier,offer_id:identifier,seller_id:identifier,currency:z.string().regex(/^[A-Z]{3}$/),price_gross_minor:competitorMinor,delivery_gross_minor:competitorMinor,available:z.boolean(),observed_at:competitorUtc});
export const competitorProfileDefinition=z.strictObject({source_namespace:identifier,own_seller_id:identifier,rank:z.number().int().min(1).max(1000),own_delivery_gross_minor:competitorMinor,max_age_minutes:z.number().int().min(1).max(10080)});
export const competitorProfileInput=z.strictObject({version:z.number().int().min(0).max(2147483646),profile:competitorProfileDefinition});
export const competitorBatchInput=z.strictObject({client_key:z.uuid(),profile_version:z.number().int().min(1).max(2147483646),observations:z.array(competitorObservationInput).min(1).max(1000),local_observations_confirmed:z.literal(true)}).superRefine((b,ctx)=>{
 const seen=new Set<string>();for(const [i,o]of b.observations.entries()){const k=JSON.stringify([o.source_namespace,o.offer_id,o.observed_at,o.product_id]);if(seen.has(k))ctx.addIssue({code:'custom',path:['observations',i],message:'Powtórzona tożsamość obserwacji'});seen.add(k);}
});
export const competitorPageInput=z.strictObject({limit:z.literal(50),after:z.string().min(1).max(2048).nullable(),product_id:z.uuid().nullable()});
export type CompetitorProfileDefinition=z.infer<typeof competitorProfileDefinition>;
export type CompetitorObservationInput=z.infer<typeof competitorObservationInput>;
export type CompetitorBatchInput=z.infer<typeof competitorBatchInput>;
export type CompetitorProfile={price_list_id:string;version:number;config_version:number;data_version:number;updated_at:string}&CompetitorProfileDefinition;
export type CompetitorBatch={id:string;price_list_id:string;client_key:string;profile_version:number;profile_config_version:number;profile_data_version:number;request_hash:string;count:number;created_at:string};
export type CompetitorObservation=CompetitorObservationInput&{id:string;batch_id:string;ordinal:number;created_at:string};
