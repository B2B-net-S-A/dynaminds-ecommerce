/** Construction-bound HTTPS transport for a finite selected official local Woo store. */
import {request as httpsRequest, type RequestOptions} from 'node:https';
import type {ClientRequest,IncomingMessage} from 'node:http';
import {checkServerIdentity} from 'node:tls';
import {X509Certificate,createHash} from 'node:crypto';
import {LOCAL_WOO_ORIGIN,LOCAL_WOO_ORIGINS,isLocalWooOrigin,type LocalWooOrigin} from '../shared/local-woo-origins';
export {LOCAL_WOO_ORIGIN,LOCAL_WOO_ORIGINS};
export type {LocalWooOrigin};
export function localWooOrigin(value:unknown=LOCAL_WOO_ORIGIN):LocalWooOrigin{
 if(!isLocalWooOrigin(value))refuse('Local Woo origin refused');
 return value as LocalWooOrigin;
}
export type LocalWooTransport=(url:string,init:RequestInit)=>Promise<Response>;
type Requester=(options:RequestOptions,receive:(res:IncomingMessage)=>void)=>ClientRequest;
const MAX=5*1024*1024,DEADLINE=12000;
function refuse(message:string):never{throw new Error(message);}
// Exact 'YYYY-MM-DD HH:MM:SS' that round-trips as a UTC instant: no zone, fraction or calendar overflow.
function gmtSecond(v:string){if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v))return false;const t=Date.parse(v.replace(' ','T')+'Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,19).replace('T',' ')===v;}
function destination(raw:string,init:RequestInit,origin:LocalWooOrigin){
 let u:URL;try{u=new URL(raw);}catch{refuse('Local Woo destination refused');}if(u.origin!==origin||u.username||u.password||u.hash||raw.includes('\\')||/\/\.{1,2}(?:\/|$)/.test(raw)||/%(?:2f|5c|2e)/i.test(raw))refuse('Local Woo destination refused');
 if(init.redirect&&init.redirect!=='error'||init.credentials&&init.credentials!=='omit'||init.body!==undefined&&typeof init.body!=='string')refuse('Local Woo request mode refused');
 const method=(init.method??'GET').toUpperCase(),p=u.pathname;
 const product=/^\/wp-json\/wc\/v3\/products(?:\/[1-9]\d*(?:\/variations(?:\/[1-9]\d*)?)?)?$/.test(p),order=/^\/wp-json\/wc\/v3\/orders(?:\/[1-9]\d*)?$/.test(p),setting=/^\/wp-json\/wc\/v3\/settings\/[a-z_]+\/[a-z_]+$/.test(p);
 if(!((method==='GET'&&(product||order||setting))||(method==='PUT'&&/^\/wp-json\/wc\/v3\/(?:products\/[1-9]\d*(?:\/variations\/[1-9]\d*)?|orders\/[1-9]\d*)$/.test(p))||(method==='POST'&&/^\/wp-json\/wc\/v3\/products(?:\/[1-9]\d*\/variations)?$/.test(p))))refuse('Local Woo path or method refused');
 const ordersCollection=p==='/wp-json/wc/v3/orders',keys=new Set<string>();for(const [k,v] of u.searchParams){if(keys.has(k)||method!=='GET'||!['page','per_page','orderby','order','sku',...(ordersCollection?['before','dates_are_gmt']:[])].includes(k)||v.length>200)refuse('Local Woo query refused');keys.add(k);if(['page','per_page'].includes(k)&&(!/^[1-9]\d*$/.test(v)||Number(v)> (k==='per_page'?100:100000)))refuse('Local Woo page refused');if(k==='order'&&!['asc','desc'].includes(v)||k==='orderby'&&!['id','date'].includes(v))refuse('Local Woo ordering refused');if(k==='before'&&!gmtSecond(v)||k==='dates_are_gmt'&&v!=='true')refuse('Local Woo snapshot bound refused');}
 // wc/v3 compares a GMT bound only with dates_are_gmt=true; alone it would be read in the store's local time.
 if(keys.has('before')!==keys.has('dates_are_gmt'))refuse('Local Woo snapshot bound refused');
 const headers=new Headers(init.headers);for(const k of headers.keys())if(!['authorization','accept','content-type'].includes(k))refuse('Local Woo header refused');
 if(!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(headers.get('authorization')??''))refuse('Local Woo API authentication missing');
 if(init.body&&Buffer.byteLength(init.body)>2*1024*1024)refuse('Local Woo write body too large');
 if(method==='GET'&&init.body!==undefined)refuse('Local Woo read body refused');
 return{u,method,headers:Object.fromEntries(headers.entries()),body:init.body as string|undefined};
}
export function createLocalWooHttpTransport(input:{ca:Uint8Array;caSha256:string;origin?:LocalWooOrigin},requester:Requester=httpsRequest):LocalWooTransport{
 const origin=localWooOrigin(input.origin),port=Number(new URL(origin).port);
 const ca=Buffer.from(input.ca);if(!/^[a-f0-9]{64}$/.test(input.caSha256)||createHash('sha256').update(ca).digest('hex')!==input.caSha256||ca.length>65536||!new X509Certificate(ca).ca)refuse('Local Woo CA pin refused');
 return async(raw,init)=>{
  const d=destination(raw,init,origin);if(init.signal?.aborted)throw new Error('Local Woo request aborted');
  return new Promise<Response>((resolve,reject)=>{
   let settled=false,req:ClientRequest|undefined,res:IncomingMessage|undefined;
   const finish=(e?:unknown,value?:Response)=>{if(settled)return;settled=true;clearTimeout(timer);init.signal?.removeEventListener('abort',abort);if(e){res?.destroy();req?.destroy();reject(e);}else resolve(value!);};
   const abort=()=>finish(new Error('Local Woo request aborted'));
   const timer=setTimeout(()=>finish(new Error('Local Woo request deadline exceeded')),DEADLINE);timer.unref();
   try{req=requester({protocol:'https:',hostname:'127.0.0.1',port,servername:'localhost',path:d.u.pathname+d.u.search,method:d.method,headers:{...d.headers,host:new URL(origin).host},agent:false,ca,rejectUnauthorized:true,minVersion:'TLSv1.2',checkServerIdentity:(_host,cert)=>checkServerIdentity('localhost',cert)},received=>{
    res=received;if(settled){res.destroy();return;}const status=res.statusCode??0;if(status>=300&&status<400){finish(new Error('Local Woo redirect refused'));return;}if(status<200||status>599){finish(new Error('Local Woo status refused'));return;}
    const chunks:Buffer[]=[];let size=0;res.on('data',(part:Buffer)=>{if(settled)return;size+=part.length;if(size>MAX){finish(new Error('Local Woo JSON response too large'));return;}chunks.push(Buffer.from(part));});
    res.once('error',()=>finish(new Error('Local Woo response failed')));res.once('aborted',()=>finish(new Error('Local Woo response interrupted')));res.once('end',()=>{if(settled)return;try{finish(undefined,new Response(status===204?null:Buffer.concat(chunks),{status,headers:{'content-type':String(res!.headers['content-type']??''),'retry-after':String(res!.headers['retry-after']??''),...(res!.headers['x-wp-totalpages']!==undefined?{'x-wp-totalpages':String(res!.headers['x-wp-totalpages'])}:{}),...(res!.headers['x-wp-total']!==undefined?{'x-wp-total':String(res!.headers['x-wp-total'])}:{})}}));}catch{finish(new Error('Local Woo response invalid'));}});
   });req.once('error',()=>finish(new Error('Local Woo TLS/network failed')));init.signal?.addEventListener('abort',abort,{once:true});if(init.signal?.aborted){abort();return;}req.end(d.body);}catch{finish(new Error('Local Woo request construction failed'));}
  });
 };
}
