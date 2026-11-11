export type ImportReceipt={v:1;tenant_id:string;user_id:string;original_context:string;channel_id:string;inbound_id:string;source_hash:string;warehouse_id:string;external_id:string;page:number;phase:'sent'|'unknown'|'confirmed';ack_order_id?:string};
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
export function importActor(context:string){const [tenant_id,user_id]=context.split(':');if(!uuid(tenant_id)||!uuid(user_id))throw Error('Brak właściwej firmy lub użytkownika importu.');return{tenant_id,user_id};}
export function importCustodyKey(context:string,channel:string){const a=importActor(context);if(!uuid(channel))throw Error('Brak właściwego kanału importu.');return 'dyna:ordinary-import:v1:'+a.tenant_id+':'+a.user_id+':'+channel;}
function parseImportReceipts(raw:string|null,context:string,channel:string):Record<string,ImportReceipt>{
 if(raw===null)return{};if(raw.length>256000)throw Error('Zapis prób importu przekroczył limit. Zachowaj oryginalne dane.');
 const all=JSON.parse(raw),actor=importActor(context);if(!all||Array.isArray(all)||typeof all!=='object'||Object.keys(all).length>200)throw Error('Niepełny zapis prób importu.');
 for(const [id,value]of Object.entries(all)){const r=value as ImportReceipt;if(!r||r.v!==1||r.tenant_id!==actor.tenant_id||r.user_id!==actor.user_id||r.channel_id!==channel||id!==r.inbound_id||![r.inbound_id,r.warehouse_id].every(uuid)||!/^([a-f0-9]{64})$/.test(r.source_hash)||typeof r.original_context!=='string'||typeof r.external_id!=='string'||!r.external_id||r.external_id.length>512||!Number.isSafeInteger(r.page)||r.page<1||r.page>10000||!['sent','unknown','confirmed'].includes(r.phase)||r.ack_order_id!==undefined&&!uuid(r.ack_order_id)||r.phase==='confirmed'&&!uuid(r.ack_order_id))throw Error('Niepełne oryginalne tożsamości importu.');}
 return all;
}
export function readImportReceipts(context:string,channel:string){return parseImportReceipts(localStorage.getItem(importCustodyKey(context,channel)),context,channel);}
export function saveImportReceipt(context:string,channel:string,r:ImportReceipt){
 const all=readImportReceipts(context,channel),old=all[r.inbound_id];
 if(old&&['tenant_id','user_id','channel_id','inbound_id','source_hash','warehouse_id','external_id'].some(k=>old[k as keyof ImportReceipt]!==r[k as keyof ImportReceipt]))throw Error('Oryginalna próba zmieniła się. Zachowano poprzedni zapis.');
 if(old?.ack_order_id&&old.ack_order_id!==r.ack_order_id||old?.phase==='confirmed'&&r.phase!=='confirmed')throw Error('Nie można zastąpić potwierdzonej tożsamości.');
 const merged={...all};delete merged[r.inbound_id];merged[r.inbound_id]=r;const unsettled=Object.values(merged).filter(x=>x.phase!=='confirmed');
 if(unsettled.length>100)throw Error('Limit nieuzgodnionych prób importu. Zachowaj ich oryginalne tożsamości.');
 // Only already confirmed local receipts may leave the bounded support history.
 const confirmed=Object.keys(merged).filter(id=>merged[id].phase==='confirmed');
 while(confirmed.length>50){const oldest=confirmed.shift()!;delete merged[oldest];}
 const next=JSON.stringify(merged);parseImportReceipts(next,context,channel);localStorage.setItem(importCustodyKey(context,channel),next);if(localStorage.getItem(importCustodyKey(context,channel))!==next)throw Error('Nie potwierdzono trwałego zapisu próby. Nie wysyłaj ponownie.');
}
export function assertOriginalImportOrder(r:ImportReceipt,o:any){if(!o||!uuid(o.id)||r.ack_order_id&&r.ack_order_id!==o.id||o.tenant_id!==r.tenant_id||o.channel_id!==r.channel_id||String(o.external_id)!==r.external_id||o.warehouse_id!==r.warehouse_id||typeof o.number!=='string'||!o.number)throw Error('Zamówienie nie odpowiada oryginalnej próbie importu.');}
export function reconcileImportReceipt(r:ImportReceipt,row:any,order:any):ImportReceipt{
 if(!row||row.id!==r.inbound_id||String(row.external_id)!==r.external_id||row.source_hash!==r.source_hash||row.imported_hash!==r.source_hash||row.state!=='imported'||row.source_changed!==false||!uuid(row.order_id)||row.order_id!==order?.id)throw Error('Brak dokładnego potwierdzenia oryginalnego źródła. Nie ponawiaj importu.');
 assertOriginalImportOrder(r,order);return{...r,phase:'confirmed',ack_order_id:order.id};
}
