/** Trusted local construction capability. No credentials, IO, wildcard hosts or public configuration route. */
import {SaxesParser} from 'saxes';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {supplierRemoteFeedUrl} from './supplier-remote-fetch-transport';
export type ConnectorAccess='read'|'write';
export type OrdinaryConnectorProvider={provider:'allegro'|'inpost'|'dpd'|'dhl'|'pocztapolska';mode:'sandbox'|'live';access:ConnectorAccess}|{provider:'woocommerce';storeUrl:string;access:ConnectorAccess}|{provider:'mirakl';instanceUrl:string;shopId:string;access:'read'};
export type OrdinaryConnectorAccessConfiguration={providers:readonly OrdinaryConnectorProvider[]};
export class ConnectorPolicyError extends Error{constructor(public readonly code:'POLICY'|'METHOD'|'ROUTE'|'BODY'|'HEADERS'){super('Ordinary connector policy: '+code);}}
function fail(c:'POLICY'|'METHOD'|'ROUTE'|'BODY'|'HEADERS'):never{throw new ConnectorPolicyError(c);}
const ownKeys=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
const override=(key:string)=>['method','httpmethod','httpmethodoverride','xhttpmethod','xhttpmethodoverride','xmethodoverride','methodoverride'].includes(key.toLowerCase().replace(/[-_]/g,''));
const positive='[1-9][0-9]{0,18}',uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
export function validateOrdinaryConnectorAccess(input:OrdinaryConnectorAccessConfiguration):Readonly<OrdinaryConnectorAccessConfiguration>{
 if(!ownKeys(input,['providers'])||!Array.isArray(input.providers)||input.providers.length<1||input.providers.length>16)fail('POLICY');
 const seen=new Set<string>(),providers=input.providers.map(p=>{
  if(!p||!['read','write'].includes(p.access))fail('POLICY');
  if(p.provider==='mirakl'){
   if(!ownKeys(p,['provider','instanceUrl','shopId','access']))fail('POLICY');
   const {instanceUrl,shopId,access}=p;
   if(typeof instanceUrl!=='string'||!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.mirakl\.net$/.test(instanceUrl)||typeof shopId!=='string'||!/^[1-9]\d{0,15}$/.test(shopId)||BigInt(shopId)>BigInt(Number.MAX_SAFE_INTEGER)||access!=='read')fail('POLICY');
   const key='mirakl:'+instanceUrl+':'+shopId;if(seen.has(key))fail('POLICY');seen.add(key);
   return Object.freeze({provider:'mirakl' as const,instanceUrl,shopId,access});
  }
  if(p.provider==='woocommerce'){
   if(!ownKeys(p,['provider','storeUrl','access'])||typeof p.storeUrl!=='string')fail('POLICY');
   let u:URL;try{u=supplierRemoteFeedUrl(p.storeUrl);}catch{fail('POLICY');}
   const base=u!.origin+u!.pathname.replace(/\/$/,'');
   if((p.storeUrl!==base&&p.storeUrl!==base+'/')||u!.search||u!.hash||!/^\/(?:[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+)*)?\/?$/.test(u!.pathname))fail('POLICY');
   if(seen.has(base))fail('POLICY');seen.add(base);return Object.freeze({provider:'woocommerce' as const,storeUrl:base,access:p.access});
  }
  if(!ownKeys(p,['provider','mode','access'])||!['allegro','inpost','dpd','dhl','pocztapolska'].includes(p.provider)||!['sandbox','live'].includes(p.mode))fail('POLICY');
  const key=p.provider+':'+p.mode;if(seen.has(key))fail('POLICY');seen.add(key);return Object.freeze({...p});
 });return Object.freeze({providers:Object.freeze(providers)});
}
type Rule={method:string;path:RegExp;query:readonly string[];write?:boolean;body?:'json'|'form'|'xml'|'labels'|'buy'|'order-status';manual303?:boolean};
const rule=(method:string,path:string,query:readonly string[]=[],write=false,body?:Rule['body'],manual303=false):Rule=>({method,path:new RegExp('^'+path+'$'),query,write,body,manual303});
const allegro:readonly Rule[]=[
 rule('GET','/me'),rule('GET','/order/checkout-forms',['limit','offset']),rule('GET','/order/checkout-forms/'+uuid),rule('GET','/order/events',['limit','from']),rule('GET','/order/event-stats'),
 rule('PUT','/order/checkout-forms/'+uuid+'/fulfillment',['checkoutForm.revision'],true,'order-status'),
 rule('GET','/sale/offers',['limit','offset','external.id']),rule('GET','/sale/product-offers/'+positive),rule('GET','/sale/products',['phrase','language','page.id']),rule('GET','/sale/products/'+uuid,['language']),rule('GET','/sale/categories/'+positive+'/parameters'),
 ...['/sale/shipping-rates','/after-sales-service-conditions/return-policies','/after-sales-service-conditions/implied-warranties','/sale/responsible-producers'].flatMap(p=>[rule('GET',p,['marketplace','limit','offset']),rule('GET',p+'/'+uuid)]),
 rule('POST','/sale/product-offers',[],true,'json'),rule('PATCH','/sale/product-offers/'+positive,[],true,'json'),rule('GET','/sale/product-offers/'+positive+'/(?:sale/)?operations/'+uuid,[],false,undefined,true),
];
const inpost:readonly Rule[]=[rule('GET','/v1/organizations',['per_page']),rule('GET','/v1/points',['city','per_page','page']),rule('GET','/v1/tracking/[A-Za-z0-9]{8,32}'),rule('GET','/v1/organizations/'+positive+'/shipments',['created_at_gteq','page','per_page']),rule('GET','/v1/shipments/'+positive),rule('GET','/v1/shipments/'+positive+'/label',['format','type']),rule('POST','/v1/organizations/'+positive+'/shipments',[],true,'json'),rule('POST','/v1/shipments/'+positive+'/buy',[],true,'buy'),rule('PUT','/v1/shipments/'+positive,[],true,'json'),rule('DELETE','/v1/shipments/'+positive,[],true)];
const dpd:readonly Rule[]=[rule('GET','/public/routing/v1/postalCode',['countryCode','zipCode']),rule('GET','/public/courierorder/v1/courierOrderAvailability',['countryCode','zipCode']),rule('POST','/public/shipment/v1/generatePackagesNumbers',[],true,'json'),rule('POST','/public/shipment/v1/generateSpedLabels',[],false,'labels'),rule('POST','/public/shipment/v1/generateProtocol',[],true,'json'),rule('POST','/public/courierorder/v1/packagesPickupCall',[],true,'json'),rule('DELETE','/public/courierorder/v1/packagesPickupCall',['orderNumber','checkSum'],true)];
const woo:readonly Rule[]=[rule('GET','/products',['per_page','page','orderby','order','sku']),rule('GET','/products/'+positive),rule('GET','/products/'+positive+'/variations',['per_page','page','orderby','order','sku']),rule('GET','/products/'+positive+'/variations/'+positive),rule('GET','/orders',['per_page','page','orderby','order']),rule('GET','/orders/'+positive),rule('GET','/settings/(?:products|general)/[A-Za-z0-9_-]{1,100}'),rule('PUT','/orders/'+positive,[],true,'order-status'),rule('POST','/products',[],true,'json'),rule('PUT','/products/'+positive,[],true,'json'),rule('POST','/products/'+positive+'/variations',[],true,'json'),rule('PUT','/products/'+positive+'/variations/'+positive,[],true,'json')];
// This capability selects an actual instance and shop. It makes no sandbox assertion.
const mirakl:readonly Rule[]=[rule('GET','/api/account',['shop_id']),rule('GET','/api/orders',['shop_id','max','offset','start_update_date','end_update_date','order_tax_mode','sort','order']),rule('GET','/api/offers',['shop_id','max','offset','sku'])];
const miraklTime=z.iso.datetime({offset:true});
function miraklQuery(url:URL){
 const q=url.searchParams,integer=(key:string,min:number,max:number)=>{const s=q.get(key);return s!==null&&/^(?:0|[1-9]\d{0,4})$/.test(s)&&Number(s)>=min&&Number(s)<=max;};
 if(url.pathname==='/api/account')return;
 if(!integer('max',1,100)||!integer('offset',0,10000))fail('ROUTE');
 if(url.pathname==='/api/offers'){
  const sku=q.get('sku');if(sku!==null&&(sku.length<1||sku.length>160||/[\x00-\x1f\x7f]/.test(sku)))fail('ROUTE');return;
 }
 const start=q.get('start_update_date'),end=q.get('end_update_date');
 if(!miraklTime.safeParse(start).success||!miraklTime.safeParse(end).success||q.get('order_tax_mode')!=='TAX_INCLUDED'||q.get('sort')!=='dateCreated'||q.get('order')!=='asc')fail('ROUTE');
 const span=Date.parse(end!)-Date.parse(start!);if(!(span>0&&span<=31*86400000))fail('ROUTE');
}
function jsonBody(init:RequestInit){
 if(typeof init.body!=='string'||Buffer.byteLength(init.body)>524288)fail('BODY');let value:unknown;try{value=JSON.parse(init.body);}catch{fail('BODY');}
 if(!value||typeof value!=='object'||Array.isArray(value))fail('BODY');let count=0;function walk(v:unknown,depth=0){if(++count>20000||depth>20)fail('BODY');if(v&&typeof v==='object'){for(const[k,x]of Object.entries(v)){if(override(k))fail('BODY');walk(x,depth+1);}}}walk(value);return value as Record<string,unknown>;
}
function tokenBody(init:RequestInit,headers:Headers){
 if(typeof init.body!=='string'||Buffer.byteLength(init.body)>32768||headers.get('content-type')?.toLowerCase()!=='application/x-www-form-urlencoded')fail('BODY');
 const p=new URLSearchParams(init.body),keys=[...p.keys()].sort(),grant=p.get('grant_type'),wanted=grant==='refresh_token'?['grant_type','refresh_token']:grant==='authorization_code'?['code','code_verifier','grant_type','redirect_uri']:null;
 if(!wanted||keys.join(',')!==wanted.sort().join(','))fail('BODY');for(const [k,v]of p)if(!v||v.length>4096||/[\x00-\x1f\x7f]/.test(v))fail('BODY');
 if(grant==='authorization_code'){if(!/^[A-Za-z0-9._~-]{43,128}$/.test(p.get('code_verifier')!))fail('BODY');let callback:URL;try{callback=new URL(p.get('redirect_uri')!);}catch{fail('BODY');}if(callback!.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(callback!.hostname)||callback!.username||callback!.password||callback!.search||callback!.hash||callback!.pathname!=='/api/oauth/allegro/callback')fail('BODY');}
 return init.body;
}
/** Parse the SOAP tree: a read capability cannot tunnel a second operation or mutate via XML. */
function soapBody(init:RequestInit){
 if(typeof init.body!=='string'||Buffer.byteLength(init.body)>32768)fail('BODY');
 type Node={name:string;uri:string;text:string;children:Node[]};let root:Node|undefined,count=0;const stack:Node[]=[],parser=new SaxesParser({xmlns:true});
 parser.on('doctype',()=>fail('BODY'));parser.on('error',()=>fail('BODY'));parser.on('opentag',tag=>{if(++count>32||stack.length>=8||Object.values(tag.attributes).some(a=>a.uri!=='http://www.w3.org/2000/xmlns/'))fail('BODY');const n:Node={name:tag.local,uri:tag.uri,text:'',children:[]};if(stack.length)stack.at(-1)!.children.push(n);else if(root)fail('BODY');else root=n;stack.push(n);});parser.on('text',s=>{if(stack.length){stack.at(-1)!.text+=s;if(stack.at(-1)!.text.length>4096)fail('BODY');}else if(s.trim())fail('BODY');});parser.on('cdata',()=>fail('BODY'));parser.on('closetag',()=>{stack.pop();});try{parser.write(init.body).close();}catch{fail('BODY');}
 const same=(n:Node|undefined,name:string,uri:string,children:string[])=>!!n&&n.name===name&&n.uri===uri&&!n.text.trim()&&n.children.map(c=>c.name).join(',')===children.join(',');
 const soap='http://schemas.xmlsoap.org/soap/envelope/',ns='http://events.dpdinfoservices.dpd.com.pl/';
 if(!same(root,'Envelope',soap,['Body'])||!same(root!.children[0],'Body',soap,['getEventsForWaybillV1']))fail('BODY');const op=root!.children[0]!.children[0]!;
 if(!same(op,'getEventsForWaybillV1',ns,['waybill','eventsSelectType','language','authDataV1']))fail('BODY');
 for(const n of op.children.slice(0,3))if(n.uri!==''||n.children.length)fail('BODY');if(!/^[A-Za-z0-9]{8,32}$/.test(op.children[0]!.text)||op.children[1]!.text!=='ALL'||op.children[2]!.text!=='PL')fail('BODY');
 const auth=op.children[3]!;if(!same(auth,'authDataV1','',['channel','login','password']))fail('BODY');for(const n of auth.children)if(n.uri!==''||n.children.length||n.text.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(n.text))fail('BODY');if(!auth.children[1]!.text||!auth.children[2]!.text)fail('BODY');return init.body;
}
// 234 carriers: SOAP over POST to fixed endpoints. The operation is read from the parsed body and must equal
// the SOAPAction; mutations need write access. DHL24 has its own sandbox host; the Poczta Polska tracking
// service has no sandbox, so only a live capability may reach it (as DPD InfoServices).
export const SOAP_CARRIER_ENDPOINTS={
 dhl:{sandbox:'https://sandbox.dhl24.com.pl/webapi2',live:'https://dhl24.com.pl/webapi2'},
 pocztapolska:{sandbox:'https://en-testwebapi.poczta-polska.pl/websrv/en.php',live:'https://e-nadawca.poczta-polska.pl/websrv/en.php'},
 pocztapolska_tracking:'https://tt.poczta-polska.pl/Sledzenie/services/Sledzenie',
} as const;
const soapCarrier={
 dhl:{ns:'https://dhl24.com.pl/webapi2/provider/service.html?ws=1',action:(op:string)=>'"https://dhl24.com.pl/webapi2/provider/service.html?ws=1#'+op+'"',read:['getPostalCodeServices','getLabels','getTrackAndTraceInfo','getNearestServicepoints','getMyShipments'],write:['createShipments','bookCourier','cancelCourierBooking'],auth:false},
 pocztapolska:{ns:'http://e-nadawca.poczta-polska.pl',action:(op:string)=>'"http://e-nadawca.poczta-polska.pl/'+op+'"',read:['hello','getUrzedyNadania','getEnvelopeBufor','getPrintForParcel','getEnvelopeStatus','getPlacowkiPocztowe'],write:['addShipment','sendEnvelope','clearEnvelopeByGuids','clearEnvelope'],auth:true},
 pocztapolska_tracking:{ns:'http://sledzenie.pocztapolska.pl',action:()=>'""',read:['sprawdzPrzesylke'],write:[] as string[],auth:false},
} as const;
/** The single operation of a SOAP 1.1 request (Envelope → optional Header → Body → one element). */
function soapOperation(init:RequestInit,ns:string){
 if(typeof init.body!=='string'||Buffer.byteLength(init.body)>1048576)fail('BODY');
 type Node={name:string;uri:string;children:Node[]};let root:Node|undefined,count=0;const stack:Node[]=[],parser=new SaxesParser({xmlns:true});
 parser.on('doctype',()=>fail('BODY'));parser.on('processinginstruction',()=>fail('BODY'));parser.on('error',()=>fail('BODY'));
 parser.on('opentag',tag=>{if(++count>20000||stack.length>=24)fail('BODY');const n:Node={name:tag.local,uri:tag.uri,children:[]};if(stack.length)stack.at(-1)!.children.push(n);else if(root)fail('BODY');else root=n;stack.push(n);});
 parser.on('text',t=>{if(!stack.length&&t.trim())fail('BODY');});parser.on('closetag',()=>{stack.pop();});
 parser.write(init.body).close();
 const env='http://schemas.xmlsoap.org/soap/envelope/';
 if(!root||root.name!=='Envelope'||root.uri!==env)fail('BODY');
 const parts=root.children,body=parts.at(-1);
 if(!body||body.name!=='Body'||body.uri!==env||parts.length>2||(parts.length===2&&(parts[0]!.name!=='Header'||parts[0]!.uri!==env))||body.children.length!==1||body.children[0]!.uri!==ns)fail('BODY');
 return body.children[0]!.name;
}
function soapCarrierRequest(kind:keyof typeof soapCarrier,p:OrdinaryConnectorProvider,init:RequestInit):ConnectorRequest{
 const c=soapCarrier[kind];if((init.method??'GET')!=='POST')fail('METHOD');
 const headers=new Headers(init.headers),allowed=['accept','content-type','soapaction',...(c.auth?['authorization']:[])];
 if([...headers.keys()].some(k=>!allowed.includes(k))||headers.get('content-type')?.toLowerCase()!=='text/xml; charset=utf-8'||headers.get('accept')!=='text/xml')fail('HEADERS');
 if(c.auth){const a=headers.get('authorization')??'';if(!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(a)||a.length>1024)fail('HEADERS');}
 const op=soapOperation(init,c.ns);
 if(headers.get('soapaction')!==c.action(op))fail('HEADERS');
 const write=(c.write as readonly string[]).includes(op);
 if(!write&&!(c.read as readonly string[]).includes(op))fail('ROUTE');
 if(write&&p.access!=='write')fail('ROUTE');
 return{body:init.body as string,manual303:false};
}
export type ConnectorRequest={body:string|undefined;manual303:boolean};
export function validateOrdinaryConnectorRequest(url:URL,init:RequestInit,configuration:Readonly<OrdinaryConnectorAccessConfiguration>):ConnectorRequest{
 const method=init.method??'GET';if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))fail('METHOD');
 if([...url.searchParams].some(([k,v])=>override(k)||k.length>80||v.length>2048)||new Set(url.searchParams.keys()).size!==[...url.searchParams.keys()].length)fail('ROUTE');
 let p:OrdinaryConnectorProvider|undefined,r:Rule|undefined,token=false,soap=false;
 for(const candidate of configuration.providers){
  if(candidate.provider==='woocommerce'){const base=new URL(candidate.storeUrl),prefix=base.pathname.replace(/\/$/,'')+'/wp-json/wc/v3';if(url.origin===base.origin&&url.pathname.startsWith(prefix+'/')){p=candidate;r=woo.find(x=>x.method===method&&x.path.test(url.pathname.slice(prefix.length)));break;}continue;}
  if(candidate.provider==='mirakl'){if(url.origin===candidate.instanceUrl&&url.searchParams.get('shop_id')===candidate.shopId){p=candidate;r=mirakl.find(x=>x.method===method&&x.path.test(url.pathname));break;}continue;}
  if(candidate.provider==='allegro'){
   const domain=candidate.mode==='sandbox'?'allegro.pl.allegrosandbox.pl':'allegro.pl';if(url.origin==='https://'+domain&&url.pathname==='/auth/oauth/token'){p=candidate;token=true;r=rule('POST','/auth/oauth/token',[],false,'form');break;}
   if(url.origin==='https://api.'+domain){p=candidate;r=allegro.find(x=>x.method===method&&x.path.test(url.pathname));break;}
  }else if(candidate.provider==='inpost'){
   if(url.origin===(candidate.mode==='sandbox'?'https://sandbox-api-shipx-pl.easypack24.net':'https://api-shipx-pl.easypack24.net')){p=candidate;r=inpost.find(x=>x.method===method&&x.path.test(url.pathname));break;}
  }else if(candidate.provider==='dhl'){
   if(!url.search&&url.href===SOAP_CARRIER_ENDPOINTS.dhl[candidate.mode])return soapCarrierRequest('dhl',candidate,init);
  }else if(candidate.provider==='pocztapolska'){
   if(!url.search&&url.href===SOAP_CARRIER_ENDPOINTS.pocztapolska[candidate.mode])return soapCarrierRequest('pocztapolska',candidate,init);
   if(candidate.mode==='live'&&!url.search&&url.href===SOAP_CARRIER_ENDPOINTS.pocztapolska_tracking)return soapCarrierRequest('pocztapolska_tracking',candidate,init);
  }else{
   if(url.origin===(candidate.mode==='sandbox'?'https://dpdservicesdemo.dpd.com.pl':'https://dpdservices.dpd.com.pl')){p=candidate;r=dpd.find(x=>x.method===method&&x.path.test(url.pathname));break;}
   // InfoServices has no separate sandbox endpoint in the installed adapter. Never cross a sandbox capability into live tracking.
   if(candidate.mode==='live'&&url.href==='https://dpdinfoservices.dpd.com.pl/DPDInfoServicesObjEventsService/DPDInfoServicesObjEvents'){p=candidate;soap=true;r=rule('POST',url.pathname,[],false,'xml');break;}
  }
 }
 if(!p||!r||r.method!==method||r.write&&p.access!=='write'||[...url.searchParams.keys()].some(k=>!r!.query.includes(k)))fail('ROUTE');
 if(p.provider==='mirakl')miraklQuery(url);
 const headers=new Headers(init.headers),allowed=soap?['accept','content-type','soapaction']:p.provider==='mirakl'?['accept','authorization']:p.provider==='dpd'?['accept','authorization','content-type','x-dpd-fid']:['accept','authorization','content-type','user-agent'];
 if([...headers.keys()].some(k=>!allowed.includes(k)))fail('HEADERS');
 if(soap){if(headers.get('content-type')?.toLowerCase()!=='text/xml; charset=utf-8'||headers.get('accept')!=='text/xml'||headers.get('soapaction')!=='""')fail('HEADERS');return{body:soapBody(init),manual303:false};}
 const publicInpost=p.provider==='inpost'&&(/^\/v1\/(?:points|tracking\/)/.test(url.pathname)),authorization=headers.get('authorization')??'';
 if(!publicInpost){if(p.provider==='mirakl'){if(!/^[\x21-\x7e]{1,4096}$/.test(authorization)||headers.get('accept')!=='application/json')fail('HEADERS');}else if(token||p.provider==='woocommerce'||p.provider==='dpd'){if(!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization)||authorization.length>8192)fail('HEADERS');}else if(!/^Bearer [^\s\x00-\x1f\x7f]{1,4096}$/.test(authorization))fail('HEADERS');}
 if(p.provider==='dpd'&&!/^[1-9]\d{0,9}$/.test(headers.get('x-dpd-fid')??''))fail('HEADERS');
 const accept=headers.get('accept');if(accept!==null&&!['application/json','application/vnd.allegro.public.v1+json','application/pdf'].includes(accept))fail('HEADERS');
 if(token)return{body:tokenBody(init,headers),manual303:false};
 let body:string|undefined;
 if(r.body){if(headers.get('content-type')!== (p.provider==='allegro'?'application/vnd.allegro.public.v1+json':'application/json'))fail('HEADERS');const v=jsonBody(init);
  if(r.body==='buy'&&(!ownKeys(v,['offer_id'])||!Number.isSafeInteger(v.offer_id)||Number(v.offer_id)<=0))fail('BODY');
  if(r.body==='order-status'&&(!ownKeys(v,['status'])||typeof v.status!=='string'||!/^[A-Za-z_ -]{1,40}$/.test(v.status)))fail('BODY');
  if(r.body==='labels'){const expected={labelSearchParams:{policy:'STOP_ON_FIRST_ERROR',session:{type:'DOMESTIC',packages:[{parcels:[{reference:(v as any).labelSearchParams?.session?.packages?.[0]?.parcels?.[0]?.reference}]}]}},outputDocFormat:'PDF',format:'A4',outputType:'BIC3',variant:'STANDARD'};if(!isDeepStrictEqual(v,expected)||!/^DYNA-[a-f0-9-]{36}$/.test(expected.labelSearchParams.session.packages[0]!.parcels[0]!.reference??''))fail('BODY');}
  body=init.body as string;
 }else if(init.body!==undefined&&init.body!==null)fail('BODY');
 if(p.provider==='inpost'&&url.pathname.endsWith('/label')&&(url.search!=='?format=pdf&type=A6'))fail('ROUTE');
 return{body,manual303:r.manual303===true&&init.redirect==='manual'};
}
