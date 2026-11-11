export class SmsLiveUnknown extends Error { constructor(){super('Niepewny wynik SMSAPI; bez ponownej wysyłki');} }
export class SmsLiveRejected extends Error {
  constructor(public providerCode:number){super('SMSAPI odrzuciło wysyłkę: '+providerCode);}
}
export type SmsLiveReceipt={providerId:string;idx:string;recipient:string;providerSentAt:number;status:string;points:number};
export type SmsLiveRequest={id:string;recipient:string;payload:string;sender:string;max_parts:number;callbackUrl:string};
export type SmsLiveTransport=(url:string,init:RequestInit)=>Promise<Response>;
export async function sendSmsApiLive(token:string,m:SmsLiveRequest,transport:SmsLiveTransport):Promise<SmsLiveReceipt>{
  if(!token||!/^https:\/\/[^\s]+$/.test(m.callbackUrl)||!/^\d{8,15}$/.test(m.recipient)||!Number.isInteger(m.max_parts)||m.max_parts<1||m.max_parts>10)throw new Error('Nieprawidłowy zakres SMS');
  if(!/^[a-f0-9-]{36}$/i.test(m.id)||!m.payload||m.payload.length>1500||! /^[A-Za-z0-9 ._-]{1,11}$/.test(m.sender))throw new Error('Nieprawidłowy SMS');
  const idx=m.id.replaceAll('-','');
  const body=new URLSearchParams({to:m.recipient,message:m.payload,from:m.sender,idx,check_idx:'1',format:'json',encoding:'utf-8',max_parts:String(m.max_parts),notify_url:m.callbackUrl});
  // Exactly ONE POST. Never add retry, backup POST, or test=1 fallback here.
  let response:Response;
  try{response=await transport('https://api.smsapi.pl/sms.do',{method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:body.toString(),signal:AbortSignal.timeout(10000)});}catch{throw new SmsLiveUnknown();}
  if(!response.ok)throw new SmsLiveUnknown();
  const reader=response.body?.getReader();if(!reader)throw new SmsLiveUnknown();let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536)throw new SmsLiveUnknown();chunks.push(part.value);}}catch{throw new SmsLiveUnknown();}finally{await reader.cancel().catch(()=>{});}
  let result:any;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new SmsLiveUnknown();}
  if(Number.isInteger(result?.error)&&result.error>0&&result.error<1000){if(result.error===53)throw new SmsLiveUnknown();throw new SmsLiveRejected(result.error);}
  const r=result?.list?.[0];
  // date_sent is documented. Missing/malformed time is UNKNOWN, never Date.now().
  if(result?.count!==1||!Array.isArray(result.list)||result.list.length!==1||!r||typeof r.id!=='string'||!/^\S{1,32}$/.test(r.id)||r.id.includes(',')||r.number!==m.recipient||!Number.isSafeInteger(r.date_sent)||r.date_sent<=0||typeof r.status!=='string'||r.status.length>40||typeof r.points!=='number'||!Number.isFinite(r.points)||r.points<0)throw new SmsLiveUnknown();
  return{providerId:r.id,idx,recipient:m.recipient,providerSentAt:r.date_sent,status:r.status,points:r.points};
}
