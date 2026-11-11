import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { crc32, inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { tenantTx } from './db';
import { ensure } from './errors';
import { encrypt, decrypt } from './security';
import { productImageData } from './product-image-format';
import { assertPackingActorInTx, packingStableHash } from './packing-workstation-guards';
import type { PackingActor } from './packing-workstation-schema';

const uuid = z.uuid().transform(s => s.toLowerCase());
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const packingPhotoUploadInput = z.strictObject({
  client_key: uuid, receipt_id: uuid,
  filename: z.string().trim().min(1).max(120).refine(s => !/[\u0000-\u001f\u007f/\\]/.test(s)),
  content_base64: z.string().min(4).max(699052),
});
export const packingPhotoConfirmInput = z.strictObject({ client_key: uuid, photo_id: uuid, file_hash: sha });
const headColumns = 'p.id,p.receipt_id,p.order_id,p.actor_id,p.client_key,p.filename,p.mime_type,p.byte_count,p.file_hash,p.created_at,c.id AS confirmation_id,c.client_key AS confirmation_key,c.actor_id AS confirmed_by,c.created_at AS confirmed_at';
const joined = 'packing_photos p LEFT JOIN packing_photo_confirmations c ON c.tenant_id=p.tenant_id AND c.photo_id=p.id';
const hashBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function decodedPackingPhoto(data: string, status=422) {
  const image=productImageData(data,status), bytes=image.bytes;
  ensure(image.mime==='image/png' && bytes.length>=45,status,'Na razie obsługiwane są zdjęcia PNG do 512 KiB');
  ensure(bytes.readUInt32BE(8)===13 && bytes.subarray(12,16).toString()==='IHDR',status,'Brak nagłówka PNG');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  ensure(width>0 && height>0 && width<=4096 && height<=4096 && width*height<=4194304,status,'Limit zdjęcia: bok 4096 px i 4 megapiksele');
  const depth=bytes[24],colour=bytes[25],interlace=bytes[28],channels=({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[colour];
  ensure(channels && bytes[26]===0 && bytes[27]===0 && [0,1].includes(interlace) && (colour===0?[1,2,4,8,16]:colour===3?[1,2,4,8]:[8,16]).includes(depth),status,'Nieobsługiwany nagłówek PNG');
  let at=8,count=0,seenEnd=false,seenHeader=false,idatEnded=false;const idats:Buffer[]=[];
  while(at<bytes.length){
    ensure(at+12<=bytes.length && ++count<=4096,status,'Niepełna struktura PNG');
    const length=bytes.readUInt32BE(at),end=at+12+length;
    ensure(end<=bytes.length,status,'Ucięty fragment PNG');
    const type=bytes.subarray(at+4,at+8).toString('ascii');
    ensure(/^[A-Za-z]{4}$/.test(type) && !['acTL','fcTL','fdAT'].includes(type),status,'Zdjęcie musi być pojedynczym PNG');
    ensure(crc32(bytes.subarray(at+4,end-4))===bytes.readUInt32BE(end-4),status,'Błędna suma kontrolna PNG');
    if(type==='IHDR'){ensure(!seenHeader && at===8 && length===13,status,'Powtórzony nagłówek PNG');seenHeader=true;}
    ensure(type[0]===type[0].toLowerCase() || ['IHDR','PLTE','IDAT','IEND'].includes(type),status,'Nieznany krytyczny fragment PNG');
    if(type==='IDAT'){ensure(!idatEnded,status,'Rozdzielone dane PNG');idats.push(bytes.subarray(at+8,end-4));}
    else if(idats.length)idatEnded=true;
    if(type==='IEND'){ensure(length===0 && end===bytes.length,status,'Dane po końcu PNG');seenEnd=true;}
    at=end;
  }
  ensure(seenEnd && idats.length>0,status,'Niepełne dane obrazu PNG');
  try{
    // Bound inflate BEFORE pdf-lib's actual PNG pixel decode. At most 8 bytes
    // per pixel + seven Adam7 row-filter overheads per image row.
    const inflated=inflateSync(Buffer.concat(idats),{maxOutputLength:width*height*8+height*7+64});
    const passes=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
    let offset=0;
    for(const [x,y,dx,dy] of passes){
      const w=Math.max(0,Math.ceil((width-x)/dx)),h=Math.max(0,Math.ceil((height-y)/dy));if(!w||!h)continue;
      const stride=Math.ceil(w*channels*depth/8)+1;
      for(let row=0;row<h;row++){ensure(offset+stride<=inflated.length && inflated[offset]<=4,status,'Niepełny zdekodowany wiersz PNG');offset+=stride;}
    }
    ensure(offset===inflated.length,status,'Nadmiar zdekodowanych danych PNG');
    const pdf=await PDFDocument.create(),decoded=await pdf.embedPng(bytes);
    ensure(decoded.width===width && decoded.height===height,status,'Zmienione wymiary PNG');
  }catch{ensure(false,status,'Nie można zdekodować ograniczonego zdjęcia PNG');}
  return image;
}

async function admission(c: PoolClient, a: PackingActor, write: boolean) {
  ensure((await c.query("SELECT to_regclass('public.packing_photos') IS NOT NULL AND to_regclass('public.packing_photo_confirmations') IS NOT NULL AS available")).rows[0].available, 503, 'Zdjęcia pakowania nie są zainstalowane');
  const role = await assertPackingActorInTx(c, a, write);
  ensure(role === a.role, 403, 'Rola użytkownika zmieniła się');
  if (write) await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['packing.photos:' + a.tenantId]);
  return role;
}
async function late(c: PoolClient, a: PackingActor, write: boolean) {
  if (write) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  ensure(await assertPackingActorInTx(c, a, write) === a.role, 403, 'Rola użytkownika zmieniła się');
}
async function receipt(c: PoolClient, id: string, write: boolean) {
  const r = (await c.query('SELECT id,order_id FROM packing_receipts WHERE id=$1', [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono dowodu pakowania');
  // Same order lock as packing mutations; a historical receipt remains readable.
  const o = (await c.query('SELECT id,status FROM orders WHERE id=$1 FOR SHARE', [r.order_id])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  if (write) {
    const p = (await c.query('SELECT receipt_id FROM order_packing_profiles WHERE order_id=$1', [o.id])).rows[0];
    ensure(p?.receipt_id === id && ['packed', 'shipped', 'delivered', 'completed'].includes(o.status), 409, 'Zdjęcie wymaga bieżącego dowodu zakończonego pakowania');
  }
  return r;
}
const binding = (a: PackingActor, body: unknown) => packingStableHash({ tenant: a.tenantId, actor: a.userId, source: a.source ?? 'manual', body });
export async function uploadPackingPhotoInTx(c: PoolClient, a: PackingActor, body: unknown) {
  const b = packingPhotoUploadInput.parse(body), image = await decodedPackingPhoto(b.content_base64), requestHash = binding(a, b);
  await admission(c, a, true);
  const old = (await c.query(`SELECT ${headColumns},p.request_hash FROM ${joined} WHERE p.actor_id=$1 AND p.client_key=$2`, [a.userId, b.client_key])).rows[0];
  if (old) {
    ensure(old.request_hash === requestHash, 409, 'Klucz zdjęcia należy do innych danych');
    await receipt(c, old.receipt_id, false); await late(c, a, true);
    const { request_hash: _, ...photo } = old; return { photo, reused: true };
  }
  const r = await receipt(c, b.receipt_id, true), id = randomUUID(), fileHash = hashBytes(image.bytes);
  await c.query('INSERT INTO packing_photos(id,tenant_id,receipt_id,order_id,actor_id,client_key,request_hash,filename,mime_type,byte_count,file_hash,encrypted_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, a.tenantId, r.id, r.order_id, a.userId, b.client_key, requestHash, b.filename, image.mime, image.bytes.length, fileHash, encrypt({ content_base64: b.content_base64 })]);
  await late(c, a, true);
  const photo = (await c.query(`SELECT ${headColumns} FROM ${joined} WHERE p.id=$1`, [id])).rows[0];
  return { photo, reused: false };
}
export async function confirmPackingPhotoInTx(c: PoolClient, a: PackingActor, body: unknown) {
  const b = packingPhotoConfirmInput.parse(body), requestHash = binding(a, b);
  await admission(c, a, true);
  const old = (await c.query('SELECT photo_id,request_hash FROM packing_photo_confirmations WHERE actor_id=$1 AND client_key=$2', [a.userId, b.client_key])).rows[0];
  if (old) ensure(old.photo_id === b.photo_id && old.request_hash === requestHash, 409, 'Klucz potwierdzenia należy do innych danych');
  const p = (await c.query(`SELECT ${headColumns},p.encrypted_bytes FROM ${joined} WHERE p.id=$1`, [b.photo_id])).rows[0];
  ensure(p, 404, 'Nie znaleziono zdjęcia');
  ensure(p.actor_id === a.userId && p.file_hash === b.file_hash, 409, 'Potwierdź własne zdjęcie po sprawdzeniu jego bajtów');
  const image = await decodedPackingPhoto(decrypt(p.encrypted_bytes).content_base64, 409);
  ensure(image.bytes.length === p.byte_count && image.mime === p.mime_type && hashBytes(image.bytes) === p.file_hash, 409, 'Integralność zdjęcia nie została potwierdzona');
  await receipt(c, p.receipt_id, !old);
  if (!old) {
    ensure(!p.confirmation_id, 409, 'Zdjęcie ma już inne potwierdzenie');
    await c.query('INSERT INTO packing_photo_confirmations(id,tenant_id,photo_id,receipt_id,order_id,actor_id,client_key,request_hash,file_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), a.tenantId, p.id, p.receipt_id, p.order_id, a.userId, b.client_key, requestHash, p.file_hash]);
  }
  await late(c, a, true);
  return { photo: (await c.query(`SELECT ${headColumns} FROM ${joined} WHERE p.id=$1`, [p.id])).rows[0], reused: Boolean(old) };
}
export const uploadPackingPhoto = (a: PackingActor, b: unknown) => tenantTx(a.tenantId, c => uploadPackingPhotoInTx(c, a, b));
export const confirmPackingPhoto = (a: PackingActor, b: unknown) => tenantTx(a.tenantId, c => confirmPackingPhotoInTx(c, a, b));
export async function packingPhotos(a: PackingActor, receiptId: string) {
  return tenantTx(a.tenantId, async c => {
    const role = await admission(c, a, false); await receipt(c, receiptId, false);
    const data = (await c.query(`SELECT ${headColumns} FROM ${joined} WHERE p.receipt_id=$1 ORDER BY p.created_at,p.id LIMIT 21`, [receiptId])).rows;
    ensure(data.length <= 20, 409, 'Historia zdjęć przekracza limit'); await late(c, a, false);
    return { current_role: role, data };
  });
}
export async function packingPhotoAttempt(a: PackingActor, key: string) {
  return tenantTx(a.tenantId, async c => {
    await admission(c, a, false);
    const photo = (await c.query(`SELECT ${headColumns} FROM ${joined} WHERE p.actor_id=$1 AND p.client_key=$2`, [a.userId, key])).rows[0] ?? null;
    if (photo) await receipt(c, photo.receipt_id, false);
    await late(c, a, false); return { photo };
  });
}
export async function packingPhotoContent(a: PackingActor, id: string) {
  return tenantTx(a.tenantId, async c => {
    await admission(c, a, false);
    const p = (await c.query(`SELECT ${headColumns},p.encrypted_bytes FROM ${joined} WHERE p.id=$1`, [id])).rows[0];
    ensure(p, 404, 'Nie znaleziono zdjęcia'); await receipt(c, p.receipt_id, false);
    const content = decrypt(p.encrypted_bytes).content_base64, image = await decodedPackingPhoto(content, 409);
    ensure(image.bytes.length === p.byte_count && image.mime === p.mime_type && hashBytes(image.bytes) === p.file_hash, 409, 'Integralność zdjęcia nie została potwierdzona');
    await late(c, a, false); const { encrypted_bytes: _, ...photo } = p;
    return { photo, content_base64: content };
  });
}
