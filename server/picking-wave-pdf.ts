import { createHash } from 'node:crypto';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { z } from 'zod';
import { readNotoDocumentFont } from './demo-shipment-label-pdf';

const text = z.string().max(1024).refine(v => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v));
const quantity = z.number().int().min(0).max(2147483647);
const destination = z.object({ order_id:z.uuid(), number:text, slot:z.number().int().min(1).max(100), quantity, scanned:quantity, status:text });
const schema = z.object({
 wave:z.object({id:z.uuid(),tenant_id:z.uuid(),name:text,warehouse_id:z.uuid(),warehouse_name:text,state:z.enum(['picking','completed','cancelled']),version:z.string().regex(/^[1-9][0-9]*$/).max(30)}),
 orders:z.array(z.object({id:z.uuid(),number:text,status:text,payment_mode:text,slot:z.number().int().min(1).max(100)})).min(1).max(100),
 groups:z.array(z.object({product_id:z.uuid(),sku:text,ean:text.nullable(),name:text,location:text,quantity,scanned:quantity,destinations:z.array(destination).min(1).max(100)})).max(2000),
 progress:z.object({quantity,scanned:quantity,cancelled_orders:z.number().int().min(0).max(100)})
});
export function pickingPdfSnapshot(detail:unknown, tenantId:string, waveId:string, capturedAt:string) {
 const data=schema.parse(detail);
 if(data.wave.tenant_id!==tenantId || data.wave.id!==waveId || !Number.isFinite(Date.parse(capturedAt))) throw Error('PICKLIST_SCOPE_INVALID');
 const ids=new Map(data.orders.map(o=>[o.id,o]));
 if(ids.size!==data.orders.length || new Set(data.orders.map(o=>o.slot)).size!==data.orders.length) throw Error('PICKLIST_ORDERS_INVALID');
 let destinations=0;
 for(const g of data.groups){
  destinations+=g.destinations.length;
  if(g.scanned>g.quantity || g.destinations.reduce((n,d)=>n+d.quantity,0)!==g.quantity || g.destinations.reduce((n,d)=>n+d.scanned,0)!==g.scanned) throw Error('PICKLIST_QUANTITY_INVALID');
  for(const d of g.destinations){const o=ids.get(d.order_id);if(!o || d.number!==o.number || d.slot!==o.slot || d.status!==o.status || d.scanned>d.quantity || o.status==='cancelled') throw Error('PICKLIST_DESTINATION_INVALID');}
 }
 if(destinations>2000 || data.progress.quantity!==data.groups.reduce((n,g)=>n+g.quantity,0) || data.progress.scanned!==data.groups.reduce((n,g)=>n+g.scanned,0) || data.progress.cancelled_orders!==data.orders.filter(o=>o.status==='cancelled').length) throw Error('PICKLIST_COMPLETE_SNAPSHOT_INVALID');
 return {captured_at:new Date(capturedAt).toISOString(),...data};
}
export type PickingPdfSnapshot=ReturnType<typeof pickingPdfSnapshot>;
const states:Record<string,string>={picking:'W kompletacji',completed:'Zebrana',cancelled:'Anulowana',paid:'Nowe',new:'Nieopłacone',packed:'Spakowane',shipped:'Nadane',delivered:'Dostarczone'};
function wrap(value:string,font:PDFFont,size:number,width:number):string[]{
 const lines:string[]=[];let line='';
 for(const char of value){if(font.widthOfTextAtSize(char,size)>width)throw Error('PICKLIST_GLYPH_TOO_WIDE');if(line&&font.widthOfTextAtSize(line+char,size)>width){lines.push(line);line='';}line+=char;}lines.push(line);return lines;
}
/** Local document from one committed read-only snapshot. No print job, allocation or audit is created. */
export async function renderPickingWavePdf(snapshot:PickingPdfSnapshot):Promise<Buffer>{
 // Revalidate at renderer boundary; no caller-supplied arbitrary drawing instructions.
 const value=pickingPdfSnapshot(snapshot,snapshot.wave.tenant_id,snapshot.wave.id,snapshot.captured_at);
 const hash=createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
 // Reuse the already installed NotoSans resource; no untracked font/path dependency.
 const font=await doc.embedFont(await readNotoDocumentFont(),{subset:true});
 doc.setTitle('Lista kompletacyjna - '+value.wave.name);doc.setAuthor('Dynaminds');doc.setCreationDate(new Date(value.captured_at));doc.setModificationDate(new Date(value.captured_at));
 const width=595.28,height=841.89,margin=36,usable=width-margin*2,lineHeight=13;
 let page=doc.addPage([width,height]),y=0;
 const supported=new Set(font.getCharacterSet());
 const check=(s:string)=>{for(const c of s)if(!supported.has(c.codePointAt(0)!))throw Error('PICKLIST_UNSUPPORTED_GLYPH');};
 function header(){y=height-margin;draw('Lista kompletacyjna',16);draw(value.wave.name,11);draw('Magazyn: '+value.wave.warehouse_name+' | Wersja: '+value.wave.version+' | '+(states[value.wave.state]??value.wave.state),9);draw('Partia: '+value.wave.id,8);y-=8;}
 function draw(s:string,size=9,color=rgb(.12,.16,.2)) {check(s);for(const line of wrap(s,font,size,usable)){if(y<82){page=doc.addPage([width,height]);header();}page.drawText(line,{x:margin,y,size,font,color});y-=size>12?20:lineHeight;}}
 header();
 draw('Odczyt: '+value.captured_at+' | Zamówienia: '+value.orders.length,9);
 draw('Zebrano '+value.progress.scanned+' z '+value.progress.quantity+' szt. Anulowane zamówienia: '+value.progress.cancelled_orders,9);
 draw('Bieżący odczyt. Dokument nie potwierdza zebrania ani fizycznego wydruku.',8);y-=10;
 draw('Produkty i lokalizacje',12);
 if(!value.groups.length)draw('Brak aktywnych pozycji do przedstawienia. Patrz zamówienia poniżej.');
 for(const [i,g] of value.groups.entries()){
  // Keep a group heading together with its first fields; long content continues without truncation.
  if(y<145){page=doc.addPage([width,height]);header();}
  draw((i+1)+'. '+g.name,10);draw('SKU: '+g.sku+' | EAN: '+(g.ean??'brak'),9);
  draw('Lokalizacja: '+g.location+' | Ilość: '+g.quantity+' | Zebrano: '+g.scanned,9);
  for(const d of g.destinations)draw('Koszyk '+d.slot+' | '+d.number+' | '+d.quantity+' szt. | zebrano '+d.scanned,9);
  y-=10;
 }
 draw('Zamówienia i koszyki (pełny skład partii)',12);
 for(const o of value.orders)draw('Koszyk '+o.slot+' | '+o.number+' | '+(states[o.status]??o.status),9);
 for(const [i,p] of doc.getPages().entries()){
  p.drawLine({start:{x:margin,y:65},end:{x:width-margin,y:65},thickness:.5,color:rgb(.7,.74,.78)});
  p.drawText('Snapshot SHA-256: '+hash,{x:margin,y:51,size:7,font});
  p.drawText('Strona '+(i+1)+' / '+doc.getPageCount()+' | Dane aktualne w chwili odczytu',{x:margin,y:38,size:8,font});
 }
 const bytes=Buffer.from(await doc.save());if(bytes.length>8*1024*1024)throw Error('PICKLIST_PDF_TOO_LARGE');return bytes;
}
