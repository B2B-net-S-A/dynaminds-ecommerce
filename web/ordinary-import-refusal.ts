import {importActor,importCustodyKey,readImportReceipts,type ImportReceipt} from './ordinary-import-custody';

type RollbackDisposition={version:1;outcome:'rolled_back';tenant_id:string;user_id:string;inbound_id:string;expected_hash:string;warehouse_id:string;provider:'woocommerce'|'allegro'|'prestashop';issues_update:'committed'|'not_required'};
export type ImportRefusal={v:1;sequence:number;request_id:string;status:number;original:ImportReceipt;disposition:RollbackDisposition};
export const importRefusalKey=(context:string,channel:string)=>importCustodyKey(context,channel)+':refusals';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function validateDisposition(d:any,r:ImportReceipt,provider:string){
 if(!d||Object.keys(d).sort().join(',')!=='expected_hash,inbound_id,issues_update,outcome,provider,tenant_id,user_id,version,warehouse_id'||d.version!==1||d.outcome!=='rolled_back'||!['woocommerce','allegro','prestashop'].includes(provider)||d.provider!==provider||!['committed','not_required'].includes(d.issues_update)||d.tenant_id!==r.tenant_id||d.user_id!==r.user_id||d.inbound_id!==r.inbound_id||d.expected_hash!==r.source_hash||d.warehouse_id!==r.warehouse_id)throw Error('Brak dokładnego potwierdzenia odmowy oryginalnego importu. Próba pozostaje zablokowana.');
}
function validateEntry(e:any,context:string,channel:string){
 const actor=importActor(context),r=e?.original;
 if(!e||e.v!==1||!Number.isSafeInteger(e.sequence)||e.sequence<1||!Number.isInteger(e.status)||e.status<400||e.status>=500||typeof e.request_id!=='string'||!/^[a-zA-Z0-9-]{1,200}$/.test(e.request_id)||!r||r.phase!=='sent'||r.ack_order_id!==undefined||r.tenant_id!==actor.tenant_id||r.user_id!==actor.user_id||r.channel_id!==channel||typeof r.original_context!=='string'||!/^([a-f0-9]{64})$/.test(r.source_hash)||typeof r.external_id!=='string'||!r.external_id||r.external_id.length>512||!Number.isSafeInteger(r.page)||r.page<1||r.page>10000||![r.inbound_id,r.warehouse_id].every(x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x)))throw Error('Niepełna historia odmów importu. Zachowaj oryginalny zapis.');
 validateDisposition(e.disposition,r,e.disposition?.provider);
}
export function readImportRefusals(context:string,channel:string):ImportRefusal[]{
 const raw=localStorage.getItem(importRefusalKey(context,channel));if(raw===null)return[];
 if(raw.length>2000000)throw Error('Historia odmów przekroczyła pojemność lokalnego zapisu. Zachowaj oryginalne próby.');
 const entries=JSON.parse(raw);if(!Array.isArray(entries))throw Error('Niepełna historia odmów importu.');
 let sequence=0;for(const e of entries){validateEntry(e,context,channel);if(e.sequence<=sequence)throw Error('Powtórzony zapis odmowy importu.');sequence=e.sequence;}return entries;
}
export function latestImportRefusals(context:string,channel:string){const latest:Record<string,ImportRefusal>={};for(const e of readImportRefusals(context,channel))latest[e.original.inbound_id]=e;return latest;}

// Called only by the fixed original POST response observer while its named WebLock is held.
// Archive the exact response first; only then remove its SAME SENT. Never release UNKNOWN or ACK.
export function captureImportRollbackRefusal(context:string,channel:string,r:ImportReceipt,provider:string,body:any,response:Readonly<{ok:boolean;status:number;workspace:string|null}>):boolean{
 if(body?.commit_disposition===undefined)return false;
 if(response.ok||response.workspace!==r.tenant_id||response.status!==body.status||response.status<400||response.status>=500||r.phase!=='sent'||r.ack_order_id!==undefined)throw Error('Odmowa nie odpowiada oryginalnej wysłanej próbie.');
 const history=readImportRefusals(context,channel);
 const entry:ImportRefusal={v:1,sequence:(history.at(-1)?.sequence??0)+1,request_id:body.request_id,status:response.status,original:{...r},disposition:{...body.commit_disposition}};
 validateEntry(entry,context,channel);validateDisposition(entry.disposition,r,provider);
 const active=readImportReceipts(context,channel),stored=active[r.inbound_id];if(!stored||!same(stored,r))throw Error('Zmieniono zapis oryginalnej próby. Nie odblokowano importu.');
 // Fastify request IDs can repeat after a server restart; retain every original refusal.
 const next=JSON.stringify([...history,entry]);if(next.length>2000000)throw Error('Brak miejsca na zachowanie odmowy. Import pozostaje zablokowany.');
 localStorage.setItem(importRefusalKey(context,channel),next);if(localStorage.getItem(importRefusalKey(context,channel))!==next)throw Error('Nie potwierdzono trwałego zapisu odmowy.');
 const fresh=readImportReceipts(context,channel);if(!same(fresh[r.inbound_id],r))throw Error('Oryginalna próba zmieniła się podczas zachowania odmowy.');
 delete fresh[r.inbound_id];const remaining=JSON.stringify(fresh);localStorage.setItem(importCustodyKey(context,channel),remaining);if(localStorage.getItem(importCustodyKey(context,channel))!==remaining)throw Error('Nie potwierdzono uzgodnienia odmowy. Nie ponawiaj importu.');
 return true;
}
