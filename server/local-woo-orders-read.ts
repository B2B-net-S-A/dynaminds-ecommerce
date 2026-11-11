/** Bounded complete READ for one deliberate local orders.sync invocation. */
import {isDeepStrictEqual} from 'node:util';
import type {Transport} from './integrations';
import {LOCAL_WOO_ORIGIN,localWooOrigin,type LocalWooOrigin} from './local-woo-http-transport';
import {ensure,Problem} from './errors';
export type LocalWooOrdersRead={data:any[];has_more:false;pagination:{schema:'local-woo-orders-read/v1';complete:true;pages:number;unique_orders:number;response_bytes:number;termination:'total_pages'|'empty_page'}};
const PAGE_SIZE=50,MAX_PAGES=20,MAX_ROWS=1000,MAX_PAGE_BYTES=2*1024*1024,MAX_BYTES=10*1024*1024,DEADLINE_MS=90000;
// Snapshot bound: only orders created (GMT) strictly before a second fixed at read start, so orders
// created during the read cannot shift pages; the next read picks them up. The lag covers an order
// whose creation time precedes its COMMIT and small host/container clock skew.
const SNAPSHOT_LAG_MS=5000;
export function localWooOrdersSnapshotBound(nowMs:number):string{ensure(Number.isSafeInteger(nowMs)&&nowMs>0,500,'Nieprawidłowy czas odczytu');return new Date(Math.floor((nowMs-SNAPSHOT_LAG_MS)/1000)*1000).toISOString().slice(0,19).replace('T',' ');}
function count(value:string|null,max:number){if(value===null)return null;ensure(/^(0|[1-9]\d*)$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)<=max,502,'Nieprawidłowa lub zbyt duża paginacja WooCommerce');return Number(value);}
export async function readLocalWooOrders(transport:Transport,authorization:string,originInput:LocalWooOrigin=LOCAL_WOO_ORIGIN,options:{now?:()=>number}={}):Promise<LocalWooOrdersRead>{
 const origin=localWooOrigin(originInput),before=localWooOrdersSnapshotBound((options.now??Date.now)());
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(new Problem(504,'Przekroczono czas odczytu zamówień; wynik niepełny')),DEADLINE_MS);timer.unref();
 function wait<T>(work:Promise<T>):Promise<T>{return new Promise((yes,no)=>{const refused=()=>no(abort.signal.reason);abort.signal.addEventListener('abort',refused,{once:true});work.then(yes,no).finally(()=>abort.signal.removeEventListener('abort',refused)).catch(()=>{});if(abort.signal.aborted)refused();});}
 const unique=new Map<number,any>();let bytes=0,rawRows=0,pages=0,totalPages:number|null=null,totalRows:number|null=null;
 try{
  for(let page=1;page<=MAX_PAGES;page++){
   ensure(!abort.signal.aborted,504,'Odczyt zamówień przerwany; wynik niepełny');
   const url=new URL(origin+'/wp-json/wc/v3/orders');url.search=new URLSearchParams({page:String(page),per_page:String(PAGE_SIZE),orderby:'id',order:'asc',before,dates_are_gmt:'true'}).toString();
   const response=await wait(transport(url.toString(),{method:'GET',headers:{Authorization:authorization,Accept:'application/json'},redirect:'error',credentials:'omit',signal:abort.signal}));
   ensure(response.status===200,502,'Nie potwierdzono strony zamówień WooCommerce');
   const tp=count(response.headers.get('x-wp-totalpages'),MAX_PAGES),tr=count(response.headers.get('x-wp-total'),MAX_ROWS);
   if(page===1){totalPages=tp;totalRows=tr;}else ensure(tp===totalPages&&tr===totalRows,409,'Paginacja WooCommerce zmieniła się; wynik niepełny');
   ensure(/^(application\/json)(?:\s*;|$)/i.test(response.headers.get('content-type')??''),502,'Nieprawidłowy typ odpowiedzi WooCommerce');
   const reader=response.body?.getReader();ensure(reader,502,'Brak strony zamówień WooCommerce');let pageBytes=0;const chunks:Uint8Array[]=[];
   try{while(true){const part=await wait(reader.read());if(part.done)break;pageBytes+=part.value.byteLength;bytes+=part.value.byteLength;ensure(pageBytes<=MAX_PAGE_BYTES&&bytes<=MAX_BYTES,422,'Przekroczono limit danych zamówień; wynik niepełny');chunks.push(part.value);}}catch(e){void reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
   const body=Buffer.concat(chunks);let rows:any;try{rows=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(body));}catch{throw new Problem(502,'Nieprawidłowy JSON zamówień WooCommerce');}
   ensure(Array.isArray(rows)&&rows.length<=PAGE_SIZE,502,'Nieprawidłowa strona zamówień WooCommerce');pages++;rawRows+=rows.length;ensure(rawRows<=MAX_ROWS,422,'Przekroczono limit zamówień; wynik niepełny');let added=0;
   for(const row of rows){ensure(row&&typeof row==='object'&&Number.isSafeInteger(row.id)&&row.id>0,502,'Nieprawidłowy identyfikator zamówienia WooCommerce');const prior=unique.get(row.id);if(prior)ensure(isDeepStrictEqual(prior,row),409,'Zamówienie zmieniło się między stronami; wynik niepełny');else{unique.set(row.id,row);added++;}}
   let termination:LocalWooOrdersRead['pagination']['termination']|undefined;
   if(totalPages!==null){ensure((totalPages===0&&page===1&&rows.length===0)||(totalPages>=page&&rows.length>0),502,'Nieprawidłowa końcowa strona WooCommerce');if(totalPages===0||page===totalPages)termination='total_pages';}
   else if(rows.length===0)termination='empty_page';
   if(termination){ensure(totalRows===null||totalRows===unique.size,409,'Liczba zamówień WooCommerce zmieniła się; wynik niepełny');return{data:[...unique.values()],has_more:false,pagination:{schema:'local-woo-orders-read/v1',complete:true,pages,unique_orders:unique.size,response_bytes:bytes,termination}};}
   ensure(added>0,409,'Brak postępu stron WooCommerce; wynik niepełny');
  }
  throw new Problem(422,'Przekroczono limit stron zamówień; wynik niepełny');
 }finally{clearTimeout(timer);}
}
