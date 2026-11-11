import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ensure, Problem} from './errors';
import {competitorBatchInput, competitorObservationInput, type CompetitorProfile} from './competitor-observations-schema';

// Shopify Ajax Product/Cart API, not Allegro listing or authenticated Admin API.
// Shipping and gross-tax semantics are explicit operator configuration, never
// inferred from a product response. No raw cart, cookies or product body escapes.
const id=z.string().regex(/^[1-9]\d{0,19}$/);
const currency=z.enum(['PLN','EUR','USD','GBP','CZK','CHF','CAD','AUD']); // 2 decimal places only
export const shopifyCompetitorSource=z.strictObject({
 product_id:z.uuid(), source_namespace:z.string().trim().min(1).max(200).refine(v=>!v.includes('\0')),
 shop_root:z.string().max(300), handle:z.string().regex(/^[a-z0-9][a-z0-9-]{0,199}$/),
 remote_product_id:id, variant_id:id, currency,
 delivery_gross_minor:z.string().regex(/^(0|[1-9]\d*)$/).refine(v=>BigInt(v)<=100000000n),
 gross_prices_confirmed:z.literal(true), fixed_delivery_confirmed:z.literal(true),
});
export const shopifyCollectionInput=z.strictObject({
 client_key:z.uuid(),profile_version:z.number().int().min(1).max(2147483646),
 sources:z.array(shopifyCompetitorSource).min(1).max(10),local_observations_confirmed:z.literal(true),
});
type Source=z.infer<typeof shopifyCompetitorSource>;
export const SHOPIFY_COLLECTOR_LIMITS=Object.freeze({sources:10,variants:250,requests:30,
 responseBytes:1024*1024,totalBytes:10*1024*1024,requestMs:8000,totalMs:60000});
export function storefrontRoot(raw:string):URL {
 let u:URL;try{u=new URL(raw);}catch{throw new Problem(422,'Nieprawidłowy adres sklepu');}
 ensure(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&!u.port
  &&!isIP(u.hostname)&&/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname)
  &&u.hostname.length<=193&&!u.hostname.endsWith('.local')&&!u.hostname.endsWith('.localhost')
  &&/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?$/.test(u.pathname),422,'Wymagany publiczny adres HTTPS i jawny katalog języka');
 return u;
}
export function publicShopAddress(address:string):boolean {
 if(isIP(address)===6)return /^[23][0-9a-f]{3}:/i.test(address)&&!/^200[12]:/i.test(address);
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31
  ||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127
  ||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
type ReadResult={body:unknown;bytes:number;cookies:string[]};
export type ShopifyPublicRead=(url:URL,cookie:string,signal:AbortSignal)=>Promise<ReadResult>;
/** Fixed GET + validated, pinned DNS lookup: TLS still verifies the shop hostname.
 * Reject redirects, HTML/password walls and 429; no automatic provider retries. */
export const readPublicShopifyJson:ShopifyPublicRead=async(url,cookie,signal)=>{
 ensure(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:cart\.js|products\/[a-z0-9][a-z0-9-]{0,199}\.js)$/.test(url.pathname),422,'Niedozwolony zasób sklepu');
 storefrontRoot(url.origin+url.pathname.replace(/(?:cart\.js|products\/[^/]+\.js)$/,''));
 ensure(!url.username&&!url.password&&!url.search&&!url.hash&&!url.port,422,'Nieprawidłowy adres zasobu');
 ensure(cookie.length<=8192&&!/[\r\n]/.test(cookie),422,'Nieprawidłowe cookies sklepu');
 const addresses=await lookup(url.hostname,{all:true});
 ensure(addresses.length>0&&addresses.every(a=>publicShopAddress(a.address)),422,'Adres sklepu nie jest publiczny');
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const chosen=addresses[0];
  const req=httpsRequest(url,{method:'GET',signal,agent:false,rejectUnauthorized:true,servername:url.hostname,headers:{Accept:'application/json',
   'Accept-Language':'en',...(cookie?{Cookie:cookie}:{})},
   lookup:(_hostname,options,callback)=>{
    if(typeof options==='object'&&options.all)callback(null,[chosen]);
    else callback(null,chosen.address,chosen.family);
   }},res=>{
    let settled=false;
    const fail=(e:unknown)=>{if(!settled){settled=true;reject(e);}res.destroy();};
    if(res.statusCode!==200){
     const code=res.statusCode===429?'SHOPIFY_RATE_LIMITED':'SHOPIFY_READ_REFUSED';
     // Never persist the provider error body or URL query/cookies.
     fail(new Problem(res.statusCode===429?429:502,'Sklep odmówił odczytu produktu',code));return;
    }
    if(!/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(res.headers['content-type']??'')){
     fail(new Problem(502,'Sklep nie zwrócił JSON'));return;
    }
    const chunks:Buffer[]=[];let bytes=0;
    res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>SHOPIFY_COLLECTOR_LIMITS.responseBytes)
     fail(new Problem(502,'Odpowiedź sklepu przekracza limit'));else chunks.push(chunk);});
    res.on('error',()=>fail(new Problem(502,'Odczyt sklepu przerwany')));
    res.on('end',()=>{if(settled)return;try{
     const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
     settled=true;resolve({body,bytes,cookies:res.headers['set-cookie']??[]});
    }catch{fail(new Problem(502,'Nieprawidłowy JSON sklepu'));}});
   });
  req.on('error',()=>reject(new Problem(502,'Brak odpowiedzi sklepu')));req.end();
 });
};
function remoteId(v:unknown):string {
 ensure(typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v)||typeof v==='number'&&Number.isSafeInteger(v)&&v>0,
 502,'Nieprawidłowa tożsamość produktu');return String(v);
}
function object(v:unknown):Record<string,unknown>{ensure(v&&typeof v==='object'&&!Array.isArray(v),502,'Nieprawidłowa odpowiedź sklepu');return v as Record<string,unknown>;}
export function normalizeShopifyVariant(source:Source,raw:unknown,receivedCurrency:unknown,at:string){
 ensure(receivedCurrency===source.currency,409,'Waluta sklepu różni się od konfiguracji');
 const p=object(raw);ensure(remoteId(p.id)===source.remote_product_id&&p.handle===source.handle,409,'Sklep zwrócił inny produkt');
 ensure(Array.isArray(p.variants)&&p.variants.length>0&&p.variants.length<=250,502,'Nieprawidłowa liczba wariantów');
 const variants=p.variants.map(object),ids=variants.map(v=>remoteId(v.id));
 ensure(new Set(ids).size===ids.length,502,'Powtórzony wariant sklepu');
 const v=variants[ids.indexOf(source.variant_id)];ensure(v,404,'Brak wybranego wariantu sklepu');
 ensure(Number.isSafeInteger(v.price)&&(v.price as number)>=0&&(v.price as number)<=100000000
  &&typeof v.available==='boolean',502,'Nieprawidłowa cena lub dostępność');
 return competitorObservationInput.parse({product_id:source.product_id,source_namespace:source.source_namespace,
  offer_id:`shopify:${createHash('sha256').update(storefrontRoot(source.shop_root).origin).digest('hex')}:${source.remote_product_id}:${source.variant_id}`,
  seller_id:`shopify:${storefrontRoot(source.shop_root).hostname}`,currency:source.currency,
  price_gross_minor:String(v.price),delivery_gross_minor:source.delivery_gross_minor,available:v.available,observed_at:at});
}
/** Collection is all-or-nothing. No variant pagination exists in the Ajax API:
 * exactly configured variants are selected from its maximum 250 variant payload.
 * The read seam exists for tests; it is not provider-proof or native authority. */
export async function collectShopifyCompetitorObservations(raw:unknown,read:ShopifyPublicRead=readPublicShopifyJson){
 const sources=z.array(shopifyCompetitorSource).min(1).max(10).parse(raw);
 const roots=sources.map(s=>storefrontRoot(s.shop_root));
 const identities=sources.map((s,i)=>JSON.stringify([s.product_id,roots[i].origin,s.remote_product_id,s.variant_id]));
 ensure(new Set(identities).size===identities.length,422,'Powtórzone źródło produktu');
 const total=AbortSignal.timeout(SHOPIFY_COLLECTOR_LIMITS.totalMs);let bytes=0;
 const observations=[];
 for(const [i,source]of sources.entries()){
  const root=roots[i],jar=new Map<string,string>();
  const get=async(path:string)=>{
   total.throwIfAborted();const signal=AbortSignal.any([total,AbortSignal.timeout(SHOPIFY_COLLECTOR_LIMITS.requestMs)]);
   // Promise race also bounds injected transports. Default HTTPS request is aborted
   // and its body destroyed on the SAME signal; no background provider retry.
   const result=await new Promise<ReadResult>((resolve,reject)=>{
    const abort=()=>reject(new Problem(504,'Przekroczono czas odczytu sklepu'));
    signal.addEventListener('abort',abort,{once:true});
    read(new URL(path,root),[...jar].map(([k,v])=>k+'='+v).join('; '),signal)
     .then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
   });
   ensure(Number.isSafeInteger(result.bytes)&&result.bytes>=0&&result.bytes<=SHOPIFY_COLLECTOR_LIMITS.responseBytes,502,'Nieprawidłowy rozmiar odpowiedzi');
   bytes+=result.bytes;ensure(bytes<=SHOPIFY_COLLECTOR_LIMITS.totalBytes,502,'Przekroczono łączny limit odpowiedzi');
   ensure(Array.isArray(result.cookies)&&result.cookies.length<=16,502,'Nieprawidłowe cookies sklepu');
   for(const c of result.cookies){const pair=c.split(';',1)[0];ensure(pair.length<=4096&&/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(pair),502,'Nieprawidłowe cookies sklepu');
    const at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}
   ensure(jar.size<=16&&[...jar].reduce((n,[k,v])=>n+k.length+v.length+2,0)<=8192,502,'Cookies sklepu przekraczają limit');return result.body;
  };
  const before=object(await get('cart.js')).currency;
  ensure(before===source.currency,409,'Waluta sklepu różni się od konfiguracji');
  const product=await get('products/'+source.handle+'.js');
  ensure(object(await get('cart.js')).currency===before,409,'Waluta sklepu zmieniła się podczas odczytu');
  const at=new Date().toISOString().replace(/\.(\d{3})Z$/,(_m,s)=>'.'+s+'000Z');
  observations.push(normalizeShopifyVariant(source,product,before,at));
  jar.clear(); // anonymous session state is RAM-only and never returned
 }
 return {observations,origin:'public_shopify_ajax_with_configured_delivery' as const,
  delivery_origin:'operator_configured' as const,requests:sources.length*3};
}
export type ObservationCollectorService<Request,Result>={
 options(req:Request,listId:string):Promise<{available:boolean;can_write:boolean;read_only:boolean}>;
 getProfile(req:Request,listId:string):Promise<{list:{active:boolean;currency:string};profile:CompetitorProfile|null}>;
 importBatch(req:Request,listId:string,raw:unknown):Promise<Result>;
};
/** Reuses existing native current IAM, profile CAS, idempotent batch, audit and
 * ranking invalidation. No new SQL, native authority, caller role or scheduler. */
export async function collectAndImportShopifyObservations<Request,Result>(service:ObservationCollectorService<Request,Result>,
 req:Request,listId:string,raw:unknown,read?:ShopifyPublicRead){
 const input=shopifyCollectionInput.parse(raw),options=await service.options(req,listId);
 ensure(!options.read_only,423,'Kopia przywrócona jest tylko do odczytu');
 ensure(options.available&&options.can_write,403,'Brak bieżących uprawnień do obserwacji');
 const state=await service.getProfile(req,listId),profile=state.profile;
 ensure(state.list.active&&profile&&profile.version===input.profile_version,409,'Profil konkurencji zmienił się');
 for(const s of input.sources){ensure(s.source_namespace===profile.source_namespace&&s.currency===state.list.currency,
  409,'Źródło nie odpowiada profilowi konkurencji');ensure(`shopify:${storefrontRoot(s.shop_root).hostname}`!==profile.own_seller_id,
  422,'Źródło wskazuje własnego sprzedawcę');}
 const collection=await collectShopifyCompetitorObservations(input.sources,read);
 const batch=competitorBatchInput.parse({client_key:input.client_key,profile_version:input.profile_version,
  observations:collection.observations,local_observations_confirmed:true});
 return {batch:await service.importBatch(req,listId,batch),origin:collection.origin,delivery_origin:collection.delivery_origin};
}
