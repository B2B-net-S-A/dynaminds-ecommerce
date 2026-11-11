import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,webcrypto} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';

// Actual assistant, native-normalization algorithm, return write registry and server
// PNG validator; controlled fetch/bitmap/canvas. No real browser decode, API or PG.
const dir=await mkdtemp(path.resolve('tests/.return-phone-photo-'));
await writeFile(path.join(dir,'entry.ts'),"export {ReturnAssistantPanel,resetReturnAssistantContext} from '../../web/return-assistant';export {normalizePackingPhotoFile,packingPhotoSourceDimensions} from '../../web/packing-photos';export {resetDropshipReturnContext} from '../../web/b2b-dropshipping-returns';export {setWorkspace} from '../../web/api';export {validateReturnAssistantPhoto} from '../../server/return-assistant-photo';");
await build({entryPoints:[path.join(dir,'entry.ts')],outdir:dir,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',logLevel:'silent',loader:{'.css':'empty'}});
const ui=await import(pathToFileURL(path.join(dir,'entry.js')).href),dom=new JSDOM('<!doctype html><html><body/></html>',{url:'http://localhost/'}),saved=new Map();
for(const [name,v] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,MouseEvent:dom.window.MouseEvent,Event:dom.window.Event,FormData:dom.window.FormData,crypto:webcrypto,IS_REACT_ACT_ENVIRONMENT:true})){
 saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value:v,writable:true,configurable:true});
}
const originalFetch=globalThis.fetch,{createRoot}=await import('react-dom/client');
const id=n=>`${String(n).padStart(8,'0')}-1540-4154-8154-154154154154`,tenant=id(1),user=id(2),returnId=id(3),orderId=id(4),stationId=id(5),sessionId=id(6),item=id(7),product=id(8);
const context=`${tenant}:${user}:admin:false`,flags={available:true,read_only:false,current_role:'admin',can_read:true,can_write:true},station={id:stationId,version:'1',code:'RMA-01',label:'Kontrola',enabled:true};
function initial(){return{id:sessionId,return_id:returnId,order_id:orderId,state:'active',version:'1',station,lease_generation:1,owner_id:user,can_control:true,can_receive_locally:true,fulfillment_origin:'ordinary',lease_expires_at:new Date(Date.now()+900000).toISOString(),draft:{parts:[],note:'',shipping_refund:0},scanned:[],lines:[{item_id:item,product_id:product,ordinal:1,sku:'PHONE',name:'Pozycja kontroli',requested:1,original_quantity:1,components:[{product_id:product,quantity:1}],codes:[]}],photos:[],return_case:{id:returnId,version:1,number:'RMA-PHONE',state:'requested',warehouse_id:id(9),requested_shipping:0},order:{id:orderId,number:'ORDER-PHONE',version:'1',currency:'PLN',wms_lots_enabled:false},receipt_id:null};}
function chunk(name,body){const t=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(body.length);crc.writeUInt32BE(crc32(Buffer.concat([t,body])));return Buffer.concat([size,t,body,crc]);}
function png(width=1,height=1){const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=8;h[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);}
function segment(marker,body){const p=Buffer.alloc(4);p[0]=255;p[1]=marker;p.writeUInt16BE(body.length+2,2);return Buffer.concat([p,body]);}
// Standards-conforming single grayscale DCT block, also accepted by the server validator.
const jpeg=Buffer.concat([Buffer.from([255,216]),segment(0xdb,Buffer.from([0,...Array(64).fill(1)])),segment(0xc0,Buffer.from([8,0,1,0,1,1,1,0x11,0])),segment(0xc4,Buffer.from([0,1,...Array(15).fill(0),0,0x10,1,...Array(15).fill(0),0])),segment(0xda,Buffer.from([1,1,0,0,63,0])),Buffer.from([0x3f,255,217])]);
const webp=await readFile('tests/fixtures/return-phone-photo/demo.webp');
const file=(bytes,name,type)=>({size:bytes.length,name,type,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
let decodeHook=null,decodeCount=0,closed=0,encodes=0,draws=[],oversizedOutput=false;
Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async(blob)=>{
 decodeCount++;if(decodeHook)await decodeHook.promise;
 const bytes=new Uint8Array(await blob.arrayBuffer()),shape=ui.packingPhotoSourceDimensions(bytes);
 return{width:shape.width,height:shape.height,close(){closed++;}};
}});
const create=document.createElement.bind(document);
document.createElement=(tag,...rest)=>{const el=create(tag,...rest);if(tag==='canvas'){
 Object.defineProperty(el,'getContext',{value:()=>({fillStyle:'',fillRect(){},drawImage(_bitmap,_x,_y,w,h){draws.push({w,h});}})});
 Object.defineProperty(el,'toBlob',{value:cb=>{encodes++;cb(new Blob([oversizedOutput?Buffer.alloc(600000):png(el.width,el.height)],{type:'image/png'}));}});
}return el;};
async function tick(){await act(async()=>new Promise(r=>setTimeout(r,0)));}
async function until(f){for(let i=0;i<100;i++){if(f())return;await tick();}assert(f(),'expected assistant state');}
const button=(h,label)=>{const b=[...h.container.querySelectorAll('button')].find(b=>b.textContent===label);assert(b,label);return b;};
const field=(h,label)=>[...h.container.querySelectorAll('label')].find(l=>l.firstChild?.textContent===label)?.querySelector('input,select');
async function choose(el,v){await act(async()=>{el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}));});}
async function pick(h,f){const el=h.container.querySelector('input[type=file]');Object.defineProperty(el,'files',{value:[f],configurable:true});await act(async()=>el.dispatchEvent(new Event('change',{bubbles:true})));}
async function mount(photoAnswer){
 decodeHook=null;oversizedOutput=false;draws=[];ui.resetDropshipReturnContext('',false);ui.resetDropshipReturnContext(context,false);ui.resetReturnAssistantContext('',false);ui.resetReturnAssistantContext(context,false);ui.setWorkspace(tenant);
 let session=initial();const posts=[];
 globalThis.fetch=async(url,opt={})=>{assert.equal(opt.headers['X-Workspace-ID'],tenant);if(opt.method==='GET'){assert.equal(url,'/api/return-assistant/options');return Response.json({...flags,stations:[station],limits:{photo_bytes:1048576}});}const b=JSON.parse(opt.body);posts.push({url,b});if(url.endsWith('/sessions'))return Response.json({...flags,session});assert(url.endsWith('/photos'));if(photoAnswer)return photoAnswer(b);const v=ui.validateReturnAssistantPhoto({mime:b.mime,content_base64:b.content_base64}),photo={id:id(10),item_id:b.item_id,part_id:b.part_id??null,mime:v.mime,byte_count:v.byte_count,sha256:v.sha256,width:v.width,height:v.height,created_at:'2026-10-11T10:00:00Z'};session={...session,version:'2',photos:[photo]};return Response.json({...flags,session,photo});};
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container),props={contextKey:context,readOnly:false,write:true,returnId,returnNumber:'RMA-PHONE',onOrder(){},onChanged(){}};
 const h={container,root,props,posts,async render(next={}){Object.assign(props,next);await act(async()=>root.render(React.createElement(ui.ReturnAssistantPanel,props)));},async close(){await act(async()=>root.unmount());container.remove();}};
 await h.render();await until(()=>field(h,'Stanowisko kontroli'));await choose(field(h,'Stanowisko kontroli'),stationId);await act(async()=>button(h,'Rozpocznij kontrolę zwrotu').closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await until(()=>field(h,'Pozycja zdjęcia'));await choose(field(h,'Pozycja zdjęcia'),item);return h;
}
const photoPosts=h=>h.posts.filter(p=>p.url.endsWith('/photos'));
try{
 for(const [format,bytes,type] of [['PNG',png(),'image/png'],['JPEG',jpeg,'image/jpeg'],['WebP',webp,'image/webp']])await test(`${format}: actual assistant normalizes to bounded server-valid PNG, explicit single upload only`,async()=>{
  const h=await mount();try{assert(h.container.querySelector('input[type=file]').accept.includes('image/webp'));await pick(h,file(bytes,'telefon.'+(format==='JPEG'?'jpg':format.toLowerCase()),type));await until(()=>button(h,'Zapisz zdjęcie kontroli'));assert.equal(photoPosts(h).length,0,'selection does not POST');assert(h.container.textContent.includes('telefon.png'));
   const b=button(h,'Zapisz zdjęcie kontroli');await act(async()=>{b.dispatchEvent(new MouseEvent('click',{bubbles:true}));b.dispatchEvent(new MouseEvent('click',{bubbles:true}));});await until(()=>photoPosts(h).length===1&&!h.container.querySelector('.ra-photo button'));const sent=photoPosts(h)[0].b;assert.equal(sent.mime,'image/png');assert.equal(sent.item_id,item);assert.equal(sent.version,'1');assert.match(sent.client_key,/^[0-9a-f-]{36}$/);const checked=ui.validateReturnAssistantPhoto({mime:sent.mime,content_base64:sent.content_base64});assert(checked.byte_count<=524288);assert(checked.width<=2048&&checked.height<=2048);assert(h.container.textContent.includes('Operacja kontroli została zapisana.'));
  }finally{await h.close();}
 });
 await test('large dimensions downscale before POST; pixel output passes unchanged server PNG admission',async()=>{
  const h=await mount();try{await pick(h,file(png(4096,2),'szerokie.png','image/png'));await until(()=>button(h,'Zapisz zdjęcie kontroli'));assert.equal(photoPosts(h).length,0);assert.deepEqual(draws.at(-1),{w:2048,h:1});await act(async()=>button(h,'Zapisz zdjęcie kontroli').click());await until(()=>photoPosts(h).length===1);const b=photoPosts(h)[0].b;assert.equal(ui.validateReturnAssistantPhoto({mime:b.mime,content_base64:b.content_base64}).width,2048);}finally{await h.close();}
 });
 await test('invalid/oversized inputs refuse before decode/POST and remove obsolete draft',async()=>{
  const h=await mount();try{await pick(h,file(png(),'old.png','image/png'));await until(()=>button(h,'Zapisz zdjęcie kontroli'));const n=decodeCount;await pick(h,{size:8388609,name:'duze.webp',arrayBuffer(){throw Error('must not read oversized');}});await until(()=>h.container.textContent.includes('8 MiB'));assert.equal(decodeCount,n);assert(![...h.container.querySelectorAll('button')].some(b=>b.textContent==='Zapisz zdjęcie kontroli'));await pick(h,file(Buffer.from('not a photo'),'invalid.webp','image/webp'));await until(()=>h.container.textContent.includes('nieobsługiwane zdjęcie'));assert.equal(decodeCount,n);assert.equal(photoPosts(h).length,0);}finally{await h.close();}
 });
 await test('decoder failure and output overflow produce no upload or fake conversion',async()=>{
  const h=await mount();const bitmap=globalThis.createImageBitmap;try{globalThis.createImageBitmap=async()=>{throw Error('Nie można zdekodować zdjęcia.');};await pick(h,file(webp,'bad.webp','image/webp'));await until(()=>h.container.textContent.includes('Nie można zdekodować'));assert.equal(photoPosts(h).length,0);globalThis.createImageBitmap=bitmap;oversizedOutput=true;await pick(h,file(png(),'big.png','image/png'));await until(()=>h.container.textContent.includes('512 KiB'));assert.equal(photoPosts(h).length,0);}finally{globalThis.createImageBitmap=bitmap;await h.close();}
 });
 await test('double selection while decoding runs once; changed actor discards delayed decoded draft',async()=>{
  const h=await mount();try{decodeHook=defer();const n=decodeCount;await pick(h,file(webp,'old.webp','image/webp'));await pick(h,file(png(),'second.png','image/png'));assert.equal(decodeCount,n+1);await h.render({contextKey:`${tenant}:${id(22)}:admin:false`});decodeHook.resolve();await tick();await tick();assert(!h.container.textContent.includes('old.png'));assert(![...h.container.querySelectorAll('button')].some(b=>b.textContent==='Zapisz zdjęcie kontroli'));assert.equal(photoPosts(h).length,0);}finally{await h.close();}
 });
 await test('lost photo ACK retains original PNG and upload key for manual exact retry, never autoPOST',async()=>{
  let fail=true;const h=await mount(async()=>{if(fail)throw TypeError('scripted delivery loss');throw Error('retry response intentionally unsupported');});try{await pick(h,file(webp,'uncertain.webp','image/webp'));await until(()=>button(h,'Zapisz zdjęcie kontroli'));await act(async()=>button(h,'Zapisz zdjęcie kontroli').click());await until(()=>h.container.textContent.includes('jest nieznany'));const original=photoPosts(h)[0].b;await tick();assert.equal(photoPosts(h).length,1);assert(button(h,'Zapisz zdjęcie kontroli').closest('fieldset').disabled);fail=false;await act(async()=>button(h,'Ponów dokładną próbę asystenta').click());await until(()=>photoPosts(h).length===2);assert.deepEqual(photoPosts(h)[1].b,original);}finally{await h.close();}
 });
 await test('every bitmap minted by the scripted decoder is closed',()=>assert.equal(closed,decodeCount));
}finally{globalThis.fetch=originalFetch;delete globalThis.createImageBitmap;dom.window.close();for(const [name,d] of saved){if(d)Object.defineProperty(globalThis,name,d);else delete globalThis[name];}await rm(dir,{recursive:true,force:true});}
