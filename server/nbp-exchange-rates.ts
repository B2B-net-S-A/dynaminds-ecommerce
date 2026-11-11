/** Latest public NBP table A read only. No app, DB, cache, credentials or retries. */
import type {ProviderReadPolicy,ProviderReadTransport} from './provider-read-transport';
export type NbpRateCode='REQUEST'|'TRANSPORT'|'NOT_AVAILABLE'|'RATE_LIMITED'|'HTTP'|'RESPONSE_LIMIT'|'RESPONSE_SCHEMA'|'RATE_PRECISION'|'SOURCE_EXPIRED'|'FUTURE_PUBLICATION';
export class NbpExchangeRateError extends Error{
 constructor(public readonly code:NbpRateCode,public readonly HTTP_status:number|null=null){super('NBP exchange rate: '+code);this.name='NbpExchangeRateError';}
}
const fail=(code:NbpRateCode,status:number|null=null)=>new NbpExchangeRateError(code,status);
const MAX_BYTES=32768,DAY=86400000;
function currencyCode(currency:string){if(typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))throw fail('REQUEST');return currency;}
export function nbpLatestTableAReadPolicy(currency:string):ProviderReadPolicy{
 const code=currencyCode(currency);
 return {routes:[{origin:'https://api.nbp.pl',path:'/api/exchangerates/rates/a/'+code.toLowerCase()+'/',methods:['GET'],queryKeys:['format']}]};
}
function keys(value:unknown,expected:string[]){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===expected.sort().join(',');}
function dateDay(value:string){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw fail('RESPONSE_SCHEMA');
 const n=Date.parse(value+'T00:00:00.000Z');if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==value)throw fail('RESPONSE_SCHEMA');return n/DAY;
}
/** After strict JSON schema checks, preserve its sole numeric token without float math. */
function decimalToken(text:string){
 const numbers:string[]=[],names:string[]=[];
 for(let i=0;i<text.length;){
  if(text[i]==='"'){
   const start=i++;while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i]==='"')break;i++;}
   const end=++i;let next=end;while(/\s/.test(text[next]??'')&&next<text.length)next++;
   if(text[next]===':')names.push(JSON.parse(text.slice(start,end)) as string);continue;
  }
  if(/[0-9-]/.test(text[i]!)){
   const number=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));if(!number)throw fail('RESPONSE_SCHEMA');numbers.push(number[0]);i+=number[0].length;
  }else i++;
 }
 const expected=['code','currency','effectiveDate','mid','no','rates','table'];
 if(names.length!==7||new Set(names).size!==7||names.sort().join(',')!==expected.join(',')||numbers.length!==1)throw fail('RESPONSE_SCHEMA');
 const token=numbers[0]!,match=/^(0|[1-9]\d{0,17})(?:\.(\d{1,8}))?$/.exec(token);if(!match)throw fail('RATE_PRECISION');
 const fraction=match[2]??'',scale=fraction.length,scaled=BigInt(match[1]!)*10n**BigInt(scale)+BigInt(fraction||'0');
 if(scaled<=0n)throw fail('RATE_PRECISION');
 return {source_decimal:token,mid_decimal:token,mid_scaled:scaled.toString(),scale};
}
async function responseText(response:Response){
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{reader=response.body?.getReader();}catch{throw fail('RESPONSE_SCHEMA');}
 if(!reader)throw fail('RESPONSE_SCHEMA');const chunks:Uint8Array[]=[];let size=0;
 try{
  while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>MAX_BYTES)throw fail('RESPONSE_LIMIT');chunks.push(r.value);}
  const bytes=Buffer.concat(chunks,size);try{return new TextDecoder('utf8',{fatal:true}).decode(bytes);}finally{bytes.fill(0);}
 }catch(e){if(e instanceof NbpExchangeRateError)throw e;throw fail('RESPONSE_SCHEMA');}
 finally{for(const b of chunks)b.fill(0);try{await reader.cancel();}catch{/* Preserve the first read/schema failure. */}}
}
export type NbpLatestRateInput={currency:string;mode:'public_read_only';maxAgeDays:number;transport:ProviderReadTransport;observedAt?:Date;signal?:AbortSignal};
export async function readLatestNbpTableARate(input:NbpLatestRateInput){
 const code=currencyCode(input.currency),now=input.observedAt??new Date();
 if(input.mode!=='public_read_only'||!Number.isSafeInteger(input.maxAgeDays)||input.maxAgeDays<0||input.maxAgeDays>31||typeof input.transport!=='function'||!(now instanceof Date)||!Number.isFinite(now.getTime()))throw fail('REQUEST');
 const observedAt=new Date(now.getTime()),maxAgeDays=input.maxAgeDays,endpoint='https://api.nbp.pl/api/exchangerates/rates/a/'+code.toLowerCase()+'/?format=json';
 let response:Response;try{response=await input.transport(endpoint,{method:'GET',headers:{Accept:'application/json'},signal:input.signal});}catch{throw fail('TRANSPORT');}
 if(response.status!==200){try{await response.body?.cancel();}catch{}throw fail(response.status===404?'NOT_AVAILABLE':response.status===429?'RATE_LIMITED':'HTTP',response.status);}
 if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){try{await response.body?.cancel();}catch{}throw fail('RESPONSE_SCHEMA');}
 const text=await responseText(response);let value:any;try{value=JSON.parse(text);}catch{throw fail('RESPONSE_SCHEMA');}
 if(!keys(value,['table','currency','code','rates'])||value.table!=='A'||value.code!==code||typeof value.currency!=='string'||value.currency.trim().length===0||value.currency.length>120||!Array.isArray(value.rates)||value.rates.length!==1)throw fail('RESPONSE_SCHEMA');
 const row=value.rates[0];if(!keys(row,['no','effectiveDate','mid'])||typeof row.no!=='string'||!/^\d{3}\/A\/NBP\/\d{4}$/.test(row.no)||typeof row.mid!=='number'||!Number.isFinite(row.mid))throw fail('RESPONSE_SCHEMA');
 const day=dateDay(row.effectiveDate);if(row.no.slice(-4)!==row.effectiveDate.slice(0,4))throw fail('RESPONSE_SCHEMA');
 const age=Math.floor(observedAt.getTime()/DAY)-day;if(age<0)throw fail('FUTURE_PUBLICATION');if(age>maxAgeDays)throw fail('SOURCE_EXPIRED');
 const rate=decimalToken(text);
 return Object.freeze({provider:'NBP' as const,table:'A' as const,table_number:row.no as string,currency_code:code,currency_name:value.currency as string,publication_date:row.effectiveDate as string,effective_date:row.effectiveDate as string,publication_date_source:'NBP effectiveDate' as const,...rate,source_age_days:age,max_age_days:maxAgeDays,observed_at:observedAt.toISOString(),mode:'public_read_only' as const});
}
