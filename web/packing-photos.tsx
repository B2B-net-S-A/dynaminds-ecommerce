import { useEffect, useRef, useState } from 'react';
import { api, date } from './api';
export type PackingPhoto = { id: string; receipt_id: string; order_id: string; actor_id: string; client_key: string; filename: string; mime_type: string; byte_count: number; file_hash: string; created_at: string; confirmation_id: string | null; confirmation_key: string | null; confirmed_at: string | null; confirmed_by: string | null };
export type PhotoAttempt = { v: 1; context: string; receiptId: string; key: string; filename: string; bytes: number; hash: string; phase: 'upload-sent' | 'uploaded' | 'confirm-sent' | 'unknown' | 'confirmed'; lastSent: 'upload' | 'confirm'; photoId?: string; confirmKey?: string };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const storageKey = (context: string, receipt: string) => 'dyna:packing-photo:v1:' + context + ':' + receipt;
export function validatePackingPhoto(p: PackingPhoto, receiptId: string, orderId: string): PackingPhoto {
  if (!p || ![p.id,p.actor_id,p.client_key].every(uuid) || p.receipt_id !== receiptId || p.order_id !== orderId || !/^[a-f0-9]{64}$/.test(p.file_hash) || !Number.isSafeInteger(p.byte_count) || p.byte_count < 1 || p.byte_count > 524288 || !['image/png'].includes(p.mime_type) || typeof p.filename !== 'string' || p.filename.length > 120) throw Error('Nie potwierdzono metadanych własnego dowodu.');
  if (p.confirmation_id !== null && (![p.confirmation_id,p.confirmation_key,p.confirmed_by].every(uuid) || p.confirmed_by !== p.actor_id || !p.confirmed_at)) throw Error('Niepełny dowód potwierdzenia zdjęcia.');
  return p;
}
export function reconcilePackingPhoto(a: PhotoAttempt, p: PackingPhoto | null): PhotoAttempt {
  // Absence is never proof that an in-flight mutation did not commit.
  if (!p) return a;
  if (p.receipt_id !== a.receiptId || p.client_key !== a.key || p.file_hash !== a.hash || p.byte_count !== a.bytes || p.filename !== a.filename || (a.photoId && p.id !== a.photoId)) throw Error('Odczyt dotyczy innej próby; zachowano oryginalne identyfikatory.');
  if (a.lastSent === 'confirm') {
    if (p.confirmation_id && p.confirmation_key !== a.confirmKey) throw Error('Potwierdzenie ma inny klucz; zachowano próbę.');
    return { ...a, photoId: p.id, phase: p.confirmation_id ? 'confirmed' : a.phase };
  }
  if (p.confirmation_id) throw Error('Nieoczekiwane potwierdzenie; zachowano próbę.');
  return { ...a, photoId: p.id, phase: 'uploaded' };
}
function load(context: string, receiptId: string): PhotoAttempt | null {
  const raw = sessionStorage.getItem(storageKey(context, receiptId)); if (!raw) return null;
  const a = JSON.parse(raw) as PhotoAttempt;
  if (a.v !== 1 || a.context !== context || a.receiptId !== receiptId || !uuid(a.key) || !/^[a-f0-9]{64}$/.test(a.hash) || !Number.isSafeInteger(a.bytes) || a.bytes < 1 || a.bytes > 524288 || typeof a.filename !== 'string' || !['upload-sent','uploaded','confirm-sent','unknown','confirmed'].includes(a.phase) || !['upload','confirm'].includes(a.lastSent) || (a.photoId !== undefined && !uuid(a.photoId)) || (a.lastSent === 'confirm' && (!uuid(a.confirmKey) || !uuid(a.photoId)))) throw Error('Niepełny zapis próby. Zachowaj go i nie wysyłaj ponownie.');
  return a;
}
const digest = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
// Input is decoded locally; only canvas-produced bounded PNG goes to the server.
export function packingPhotoSourceDimensions(bytes: Uint8Array) {
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),ascii=(at:number,n:number)=>String.fromCharCode(...bytes.subarray(at,at+n));
  let width=0,height=0,format='';
  const need=(condition:unknown)=>{if(!condition)throw Error('Niepełne lub nieobsługiwane zdjęcie PNG/JPEG/WebP.');};
  need(bytes.length>0 && bytes.length<=8388608);
  if(bytes.length>=33 && bytes.subarray(0,8).every((b,i)=>b===[137,80,78,71,13,10,26,10][i])) {
    need(v.getUint32(8)===13 && ascii(12,4)==='IHDR');width=v.getUint32(16);height=v.getUint32(20);format='PNG';
    let at=8,n=0,end=false;while(at<bytes.length){need(at+12<=bytes.length && ++n<=4096);const size=v.getUint32(at),next=at+12+size;need(next<=bytes.length);const type=ascii(at+4,4);need(!['acTL','fcTL','fdAT'].includes(type));if(type==='IEND'){need(size===0&&next===bytes.length);end=true;}at=next;}need(end);
  } else if(bytes.length>=4 && bytes[0]===255 && bytes[1]===216) {
    format='JPEG';let at=2,n=0;
    while(at<bytes.length && !width){need(++n<=4096 && bytes[at]===255);while(bytes[at]===255)at++;need(at<bytes.length);const marker=bytes[at++];need(marker!==0 && marker!==217 && marker!==218);if(marker===216 || marker===1 || (marker>=208&&marker<=215))continue;need(at+2<=bytes.length);const size=v.getUint16(at);need(size>=2&&at+size<=bytes.length);
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){need(size>=8);height=v.getUint16(at+3);width=v.getUint16(at+5);}at+=size;
    }
  } else if(bytes.length>=20 && ascii(0,4)==='RIFF' && ascii(8,4)==='WEBP') {
    format='WebP';need(v.getUint32(4,true)+8===bytes.length);let at=12,n=0;
    while(at<bytes.length){need(at+8<=bytes.length && ++n<=4096);const kind=ascii(at,4),size=v.getUint32(at+4,true),start=at+8,next=start+size+(size%2);need(next<=bytes.length);need(kind!=='ANIM'&&kind!=='ANMF');
      if(kind==='VP8X'){need(size===10 && !(bytes[start]&2));width=1+bytes[start+4]+(bytes[start+5]<<8)+(bytes[start+6]<<16);height=1+bytes[start+7]+(bytes[start+8]<<8)+(bytes[start+9]<<16);}
      else if(kind==='VP8 '&&!width){need(size>=10 && !(bytes[start]&1) && bytes[start+3]===157 && bytes[start+4]===1 && bytes[start+5]===42);width=v.getUint16(start+6,true)&16383;height=v.getUint16(start+8,true)&16383;}
      else if(kind==='VP8L'&&!width){need(size>=5&&bytes[start]===47);const bits=v.getUint32(start+1,true);need((bits>>>29)===0);width=1+(bits&16383);height=1+((bits>>>14)&16383);}at=next;
    }
  }
  need(format && width>0 && height>0);
  if(width>8192 || height>8192 || width*height>33554432)throw Error('Zdjęcie wejściowe przekracza bok 8192 px lub 32 MP. Zmniejsz je przed dodaniem.');
  return {width,height,format};
}
export async function normalizePackingPhotoFile(file:File) {
  if(!file || file.size<1 || file.size>8388608)throw Error('Wybierz PNG, JPEG lub WebP do 8 MiB.');
  const original=file.name.trim();if(!original||original.length>120||/[\u0000-\u001f\u007f/\\]/.test(original))throw Error('Nieprawidłowa nazwa zdjęcia.');
  const input=await file.arrayBuffer(),source=packingPhotoSourceDimensions(new Uint8Array(input));
  if(typeof createImageBitmap!=='function')throw Error('Ta przeglądarka nie obsługuje lokalnego dekodera zdjęć. Nic nie wysłano.');
  let bitmap:ImageBitmap|undefined;
  try {
    bitmap=await createImageBitmap(new Blob([input]),{imageOrientation:'from-image'});
    if(!((bitmap.width===source.width&&bitmap.height===source.height)||(bitmap.width===source.height&&bitmap.height===source.width)))throw Error('Dekoder zwrócił inne wymiary zdjęcia.');
    if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>33554432)throw Error('Nie potwierdzono ograniczonego dekodowania zdjęcia.');
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error('Lokalna konwersja zdjęcia jest niedostępna. Nic nie wysłano.');
    let edge=Math.min(2048,Math.max(bitmap.width,bitmap.height));
    while(edge>=1){
      const scale=Math.min(1,edge/Math.max(bitmap.width,bitmap.height));canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/png'));
      if(!blob || blob.type!=='image/png')throw Error('Przeglądarka nie utworzyła PNG. Nic nie wysłano.');
      if(blob.size>0 && blob.size<=524288){const bytes=await blob.arrayBuffer();if(bytes.byteLength!==blob.size)throw Error('Zmieniony wynik konwersji.');return {bytes,filename:(original.replace(/\.[^.]+$/,'').slice(0,116)||'paczka')+'.png',width:canvas.width,height:canvas.height,sourceFormat:source.format};}
      if(edge<=128)break;edge=Math.max(128,Math.floor(edge*0.75));
    }
    throw Error('Nie udało się ograniczyć PNG do 512 KiB. Zmniejsz zdjęcie przed dodaniem.');
  } catch(cause) {throw cause instanceof Error?cause:Error('Przeglądarka nie zdekodowała zdjęcia. Nic nie wysłano.');}
  finally {bitmap?.close();}
}
export function PackingPhotoPanel({ contextKey, receiptId, orderId, readOnly }: { contextKey: string; receiptId: string; orderId: string; readOnly: boolean }) {
  const [attempt,setAttempt] = useState<PhotoAttempt|null>(null), [photos,setPhotos] = useState<PackingPhoto[]>([]), [file,setFile] = useState<File|null>(null);
  const [tenantId,userId,role]=contextKey.split(':');
  const validContext=contextKey.split(':').length===3 && uuid(tenantId) && uuid(userId) && ['admin','operator','viewer'].includes(role);
  const [freshConfirmed,setFreshConfirmed]=useState<string|null>(null);
  const [view,setView] = useState<{ photo: PackingPhoto; src: string }|null>(null), [rendered,setRendered] = useState<string|null>(null), [busy,setBusy] = useState(false), [error,setError] = useState(''), [locked,setLocked] = useState(false);
  const scope = contextKey + ':' + receiptId, active = useRef(scope), epoch = useRef(0), inFlight = useRef(false); active.current = scope;
  const alive = (e: number) => active.current === scope && epoch.current === e;
  function persist(next: PhotoAttempt, prior: PhotoAttempt|null) {
    const old = load(contextKey,receiptId);
    if (JSON.stringify(old) !== JSON.stringify(prior)) throw Error('Próba zmieniła się w tym oknie; odczytaj ją ponownie.');
    const bytes = JSON.stringify(next); sessionStorage.setItem(storageKey(contextKey,receiptId),bytes);
    if (sessionStorage.getItem(storageKey(contextKey,receiptId)) !== bytes) throw Error('Nie potwierdzono zapisu próby.');
  }
  async function sameActor(e:number, write=false) {
    if(!alive(e) || !validContext)throw Error('Kontekst użytkownika jest niepełny.');
    const me=await api('/auth/me');
    if(!alive(e) || me.user?.id!==userId || me.user?.tenant_id!==tenantId || me.user?.role!==role || (write && (readOnly || me.restore_preview || !['admin','operator'].includes(role))))throw Error('Sesja lub firma zmieniła się; zachowano pierwotną próbę.');
  }
  async function run(work: (e:number)=>Promise<void>) {
    if (inFlight.current) return; inFlight.current = true;
    const e = epoch.current; setBusy(true); setError('');
    try { await work(e); } catch (cause) { if(alive(e)) setError(cause instanceof Error ? cause.message : 'Nie udało się wykonać operacji.'); }
    finally { inFlight.current=false; if(alive(e)) setBusy(false); }
  }
  async function content(p: PackingPhoto, e:number) {
    if(!alive(e)) return; await sameActor(e); setRendered(null); setView(null);
    const r = await api<{photo:PackingPhoto;content_base64:string}>('/packing/photos/' + p.id + '/content');
    const photo = validatePackingPhoto(r.photo,receiptId,orderId);
    if (photo.id !== p.id || photo.file_hash !== p.file_hash || typeof r.content_base64 !== 'string' || r.content_base64.length > 699052) throw Error('Zmieniony odczyt zdjęcia.');
    const binary = atob(r.content_base64), bytes = Uint8Array.from(binary,c=>c.charCodeAt(0));
    if(bytes.length !== photo.byte_count || btoa(binary) !== r.content_base64 || await digest(bytes.buffer) !== photo.file_hash) throw Error('Nie potwierdzono integralności zdjęcia.');
    await sameActor(e);
    if(alive(e)) setView({photo,src:'data:' + photo.mime_type + ';base64,' + r.content_base64});
  }
  async function read(e:number) {
    setFreshConfirmed(null); await sameActor(e);
    const r = await api<{data:PackingPhoto[]}>('/packing/receipts/' + receiptId + '/photos');
    if(!Array.isArray(r.data) || r.data.length > 20) throw Error('Niepełna historia zdjęć.');
    const data = r.data.map(p=>validatePackingPhoto(p,receiptId,orderId));
    if(new Set(data.map(p=>p.id)).size !== data.length)throw Error('Historia zawiera powtórzone identyfikatory.');
    const saved = load(contextKey,receiptId);
    let next = saved;
    if(saved) {
      const r = await api<{photo:PackingPhoto|null}>('/packing/photos/attempts/' + saved.key);
      if(r.photo) {validatePackingPhoto(r.photo,receiptId,orderId);if(r.photo.actor_id!==userId)throw Error('Odczyt próby należy do innego użytkownika.');}
      next = reconcilePackingPhoto(saved,r.photo);
      await sameActor(e);
      if(alive(e) && r.photo?.confirmation_id && next.phase==='confirmed')setFreshConfirmed(r.photo.confirmation_id);
      if(alive(e) && JSON.stringify(next)!==JSON.stringify(saved)) persist(next,saved);
    }
    await sameActor(e);
    if(alive(e)) { setPhotos(data); setAttempt(next); setLocked(false); }
  }
  useEffect(()=>{
    epoch.current++; const e=epoch.current; setAttempt(null);setPhotos([]);setFile(null);setView(null);setRendered(null);setBusy(false);setError('');setLocked(true);setFreshConfirmed(null);
    try { setAttempt(load(contextKey,receiptId)); void run(read); } catch(cause) {setError(cause instanceof Error?cause.message:'Niepełny zapis próby.');}
    return ()=>{if(epoch.current===e)epoch.current++;};
  },[contextKey,receiptId,orderId,readOnly]);
  async function upload(e:number) {
    if(readOnly || locked || attempt || !file) return; await sameActor(e,true);
    const normalized=await normalizePackingPhotoFile(file),bytes=normalized.bytes,filename=normalized.filename,hash=await digest(bytes);if(!alive(e))return;
    const binary=Array.from(new Uint8Array(bytes),v=>String.fromCharCode(v)).join(''), content_base64=btoa(binary);
    const a:PhotoAttempt={v:1,context:contextKey,receiptId,key:crypto.randomUUID(),filename,bytes:bytes.byteLength,hash,phase:'upload-sent',lastSent:'upload'};
    await sameActor(e,true);
    persist(a,null);setAttempt(a);setFile(null);
    try {
      const r=await api<{photo:PackingPhoto}>('/packing/photos','POST',{client_key:a.key,receipt_id:receiptId,filename:a.filename,content_base64});
      validatePackingPhoto(r.photo,receiptId,orderId);if(r.photo.actor_id!==userId)throw Error('Odpowiedź należy do innego użytkownika.');await sameActor(e,true); const next=reconcilePackingPhoto(a,r.photo);
      if(alive(e)){persist(next,a);setAttempt(next);await read(e);await content(r.photo,e);}
    }catch(cause){if(alive(e) && JSON.stringify(load(contextKey,receiptId))===JSON.stringify(a)){const next:PhotoAttempt={...a,phase:'unknown'};try{persist(next,a);setAttempt(next);}catch{setLocked(true);}}throw cause;}
  }
  async function confirm(e:number) {
    const old=attempt;
    if(readOnly || locked || old?.phase!=='uploaded' || !view || rendered!==view.photo.id+':'+view.photo.file_hash || view.photo.id!==old.photoId || view.photo.file_hash!==old.hash) return;
    await sameActor(e,true); setFreshConfirmed(null);
    const a:PhotoAttempt={...old,phase:'confirm-sent',lastSent:'confirm',confirmKey:crypto.randomUUID()};persist(a,old);setAttempt(a);
    try {
      const r=await api<{photo:PackingPhoto}>('/packing/photos/confirm','POST',{client_key:a.confirmKey,photo_id:a.photoId,file_hash:a.hash});
      validatePackingPhoto(r.photo,receiptId,orderId);if(r.photo.actor_id!==userId)throw Error('Odpowiedź należy do innego użytkownika.');await sameActor(e,true);const next=reconcilePackingPhoto(a,r.photo);
      if(next.phase!=='confirmed')throw Error('Nie potwierdzono zapisu potwierdzenia.');
      if(alive(e)){persist(next,a);setAttempt(next);await read(e);}
    }catch(cause){if(alive(e) && JSON.stringify(load(contextKey,receiptId))===JSON.stringify(a)){const next:PhotoAttempt={...a,phase:'unknown'};try{persist(next,a);setAttempt(next);}catch{setLocked(true);}}throw cause;}
  }
  function newPhoto() {
    if(busy || inFlight.current || locked || readOnly || attempt?.phase!=='confirmed' || !freshConfirmed)return;
    try {
      const old=load(contextKey,receiptId);if(JSON.stringify(old)!==JSON.stringify(attempt))throw Error('Próba zmieniła się.');
      const k=storageKey(contextKey,receiptId)+':archive:'+attempt.key,raw=JSON.stringify(attempt),previous=sessionStorage.getItem(k);
      if(previous!==null && previous!==raw)throw Error('Archiwum próby ma inną treść.');sessionStorage.setItem(k,raw);
      if(sessionStorage.getItem(k)!==raw)throw Error('Nie zapisano archiwum; próba pozostaje.');
      sessionStorage.removeItem(storageKey(contextKey,receiptId));if(load(contextKey,receiptId))throw Error('Nie usunięto aktywnego wskaźnika.');
      setAttempt(null);setView(null);setRendered(null);setFreshConfirmed(null);
    }catch(cause){setError(cause instanceof Error?cause.message:'Nie można rozpocząć nowego zdjęcia.');}
  }
  return <section className="packing-card" aria-label="Zdjęcia paczki">
    <h4>Zdjęcia paczki</h4><p className="packing-help">Opcjonalny, prywatny załącznik do dowodu pakowania. PNG, JPEG lub WebP do 8 MiB (bok≤8192px,≤32MP). Przeglądarka dekoduje i zmniejsza zdjęcie do PNG≤512KiB; usuwane są oryginalne metadane, a rozmiar obrazu może się zmienić. Serwer przyjmuje wyłącznie ten PNG. Zdjęcie nie zmienia statusu zamówienia i nie jest dowodem nadania.</p>
    {error&&<p role="alert" className="packing-warning">{error}</p>}
    <div className="packing-actions"><button type="button" className="button" disabled={busy} onClick={()=>void run(read)}>Odczytaj historię i próbę</button>
    {!attempt&&<><label>Zdjęcie paczki <input type="file" accept="image/png,image/jpeg,image/webp" disabled={readOnly||busy||locked} onChange={e=>setFile(e.target.files?.[0]??null)}/></label><button type="button" className="button" disabled={readOnly||busy||locked||!file} onClick={()=>void run(upload)}>Zapisz prywatne zdjęcie</button></>}
    {attempt?.phase==='uploaded'&&<button type="button" className="button" disabled={readOnly||busy||locked||!view||rendered!==view.photo.id+':'+view.photo.file_hash||view.photo.id!==attempt.photoId} onClick={()=>void run(confirm)}>Potwierdź obejrzane zdjęcie</button>}
    {attempt?.phase==='confirmed'&&<button type="button" className="button" disabled={readOnly||busy||locked||!freshConfirmed} onClick={newPhoto}>Dodaj kolejne zdjęcie</button>}</div>
    {attempt&&<><p>{attempt.phase==='confirmed'?'Zdjęcie potwierdzone.':attempt.phase==='uploaded'?'Zdjęcie zapisane. Otwórz je i sprawdź przed potwierdzeniem.':'Oczekiwanie lub nieznany wynik. Odczytaj tę samą próbę; nie wysyłaj ponownie.'}</p><details><summary>Identyfikatory własnej próby</summary><p>Próba: {attempt.key} · zdjęcie: {attempt.photoId??'oczekuje'} · potwierdzenie: {attempt.confirmKey??'jeszcze nie wysłano'}</p></details></>}
    <ul>{photos.map(p=><li key={p.id}><button type="button" className="button" disabled={busy} onClick={()=>void run(e=>content(p,e))}>Otwórz {p.filename}</button> · {date(p.created_at)} · {p.confirmation_id?'Potwierdzone':'Niepotwierdzone'}</li>)}</ul>
    {view&&<figure><img src={view.src} alt={'Prywatne zdjęcie paczki: '+view.photo.filename} style={{maxWidth:'100%',maxHeight:480}} onLoad={()=>{if(active.current===scope)setRendered(view.photo.id+':'+view.photo.file_hash);}} onError={()=>{if(active.current!==scope)return;setRendered(null);setError('Przeglądarka nie odczytała obrazu. Potwierdzenie pozostaje wyłączone.');}}/><figcaption>{view.photo.filename} · {view.photo.byte_count} B</figcaption></figure>}
  </section>;
}
