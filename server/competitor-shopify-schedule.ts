import {z} from 'zod';
import {ensure,Problem} from './errors';
import {shopifyCompetitorSource,storefrontRoot} from './competitor-shopify-collector';

/** Stored in existing repricing_rules.config; no new tables/job kinds. Exactly
 * one existing schedule slot per list; price-change consent remains explicit. */
export const shopifyCollectionDefinition=z.strictObject({
 profile_config_version:z.number().int().positive(),
 sources:z.array(shopifyCompetitorSource).min(1).max(10),
 mode:z.enum(['collection_only','collect_then_reprice']),
 local_observations_confirmed:z.literal(true),collection_confirmed:z.literal(true),
 price_changes_confirmed:z.boolean(),
}).superRefine((b,ctx)=>{
 if(b.mode==='collect_then_reprice'&&!b.price_changes_confirmed)ctx.addIssue({code:'custom',path:['price_changes_confirmed'],message:'Potwierdź istniejące lokalne zmiany cen'});
 const seen=new Set<string>();for(const [i,s]of b.sources.entries()){
  const k=JSON.stringify([s.product_id,storefrontRoot(s.shop_root).origin,s.remote_product_id,s.variant_id]);
  if(seen.has(k))ctx.addIssue({code:'custom',path:['sources',i],message:'Powtórzone źródło produktu'});seen.add(k);
 }
});
export const shopifyCollectionScheduleInput=z.strictObject({
 version:z.number().int().min(0),rule_config_version:z.number().int().positive(),
 profile_version:z.number().int().positive(),enabled:z.boolean(),
 interval_minutes:z.number().int().min(5).max(10080),
 sources:z.array(shopifyCompetitorSource).min(1).max(10),
 mode:z.enum(['collection_only','collect_then_reprice']),
 local_observations_confirmed:z.literal(true),collection_confirmed:z.literal(true),price_changes_confirmed:z.boolean(),
}).refine(b=>b.mode!=='collect_then_reprice'||b.price_changes_confirmed,'Potwierdź istniejące lokalne zmiany cen');
export function scheduledShopifyDefinition(config:unknown){
 if(config&&typeof config==='object'&&!Object.hasOwn(config,'shopify_collection'))return null;
 const parsed=shopifyCollectionDefinition.safeParse((config as Record<string,unknown>)?.shopify_collection);
 if(!parsed.success)throw new Problem(409,'Nieprawidłowa definicja kolekcji; publikacja cen nie jest dozwolona');
 return parsed.data;
}
export function scheduledCollectionProfileVersion(payload:unknown):number {
 const p=z.object({collection_profile_version:z.number().int().positive()}).safeParse(payload);
 if(!p.success)throw new Problem(409,'Brak przypiętej wersji profilu kolekcji');return p.data.collection_profile_version;
}
export function assertCollectionSourcesMatchProfile(definition:z.infer<typeof shopifyCollectionDefinition>,
 profile:{config_version:number;source_namespace:string;own_seller_id:string},currency:string){
 ensure(definition.profile_config_version===profile.config_version,409,'Definicja profilu kolekcji zmieniła się');
 for(const s of definition.sources){ensure(s.source_namespace===profile.source_namespace&&s.currency===currency,
  409,'Źródło nie odpowiada profilowi konkurencji');ensure('shopify:'+storefrontRoot(s.shop_root).hostname!==profile.own_seller_id,
  422,'Źródło wskazuje własnego sprzedawcę');}
}
