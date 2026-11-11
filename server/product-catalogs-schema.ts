import {z} from 'zod';
export const PRODUCT_CATALOG_LIMITS={max_catalogs:100,max_languages:64,max_warehouses:100,max_price_lists:100,max_previews:2000,max_operations:2000,tenant_bytes:67108864,preview_ttl_seconds:900,page:50} as const;
export const productCatalogLanguage=z.string().max(40).regex(/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/);
const text=z.string().trim().min(2).max(120).refine(v=>!/[\u0000-\u001f\u007f]/.test(v)&&Buffer.from(v,'utf8').toString('utf8')===v,'Niepoprawny tekst');
const version=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v=>/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n,'Niepoprawna wersja');
const uuid=z.uuid().transform(v=>v.toLowerCase());
const ids=(max:number)=>z.array(uuid).max(max).refine(v=>new Set(v).size===v.length,'Powtórzony identyfikator').transform(v=>[...v].sort());
export const productCatalogSettings=z.strictObject({name:text,active:z.boolean(),languages:z.array(productCatalogLanguage).min(1).max(64).refine(v=>new Set(v).size===v.length,'Powtórzony język').transform(v=>[...v].sort()),default_language:productCatalogLanguage,warehouse_ids:ids(100).refine(v=>v.length>0,'Katalog wymaga magazynu'),price_list_ids:ids(100)}).refine(v=>v.languages.includes(v.default_language),'Język domyślny nie został przypisany');
export const productCatalogPreviewInput=z.discriminatedUnion('kind',[
 z.strictObject({client_key:uuid,kind:z.literal('create'),settings:productCatalogSettings}),
 z.strictObject({client_key:uuid,kind:z.literal('update'),catalog_id:uuid,version,settings:productCatalogSettings}),
]);
export const productCatalogCommitInput=z.strictObject({client_key:uuid,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
export const productCatalogListQuery=z.strictObject({cursor:uuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(50)});
export const productCatalogHistoryQuery=productCatalogListQuery.extend({kind:z.enum(['preview','operation']).default('preview')});
export type ProductCatalogSettings=z.infer<typeof productCatalogSettings>;
export type ProductCatalogPreviewInput=z.infer<typeof productCatalogPreviewInput>;
export type ProductCatalogActor={tenantId:string;userId:string;role:'admin'|'operator'|'viewer';source?:'api'|'manual'|'system';apiKeyId?:string};
