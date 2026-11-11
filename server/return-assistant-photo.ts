import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { z } from 'zod';
import { ensure, Problem } from './errors';

export const RETURN_ASSISTANT_PHOTO_LIMITS = {
  bytes: 1048576,
  dimension: 8192,
  pixels: 16000000,
  png_inflated_bytes: 67108864,
  segments: 16384,
} as const;
export const returnAssistantPhotoInput = z.strictObject({
  mime: z.enum(['image/png', 'image/jpeg']),
  content_base64: z.string().min(4).max(1398104),
});
export type ReturnAssistantPhoto = {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg';
  byte_count: number;
  sha256: string;
  width: number;
  height: number;
};
const invalid = 'Nieprawidłowa struktura zdjęcia PNG/JPEG';
function dimensions(width: number, height: number) {
  ensure(width > 0 && height > 0 && width <= RETURN_ASSISTANT_PHOTO_LIMITS.dimension &&
    height <= RETURN_ASSISTANT_PHOTO_LIMITS.dimension && width * height <= RETURN_ASSISTANT_PHOTO_LIMITS.pixels,
  422, 'Zdjęcie przekracza dopuszczalne wymiary');
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer) {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(bytes: Buffer) {
  ensure(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 422, invalid);
  let at = 8, width = 0, height = 0, depth = 0, color = -1, interlace = 0;
  let paletteEntries = 0, ended = false, dataStarted = false, dataEnded = false, chunks = 0;
  const seen = new Set<string>(), data: Buffer[] = [];
  const ancillary = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'pHYs', 'bKGD', 'sBIT', 'eXIf']);
  while (at < bytes.length) {
    ensure(++chunks <= RETURN_ASSISTANT_PHOTO_LIMITS.segments && at + 12 <= bytes.length, 422, invalid);
    const size = bytes.readUInt32BE(at), end = at + 12 + size;
    ensure(end <= bytes.length, 422, invalid);
    const type = bytes.subarray(at + 4, at + 8).toString('latin1');
    ensure(/^[A-Za-z]{4}$/.test(type) && (bytes[at + 6] & 32) === 0, 422, invalid);
    const body = bytes.subarray(at + 8, end - 4);
    ensure(crc32(bytes.subarray(at + 4, end - 4)) === bytes.readUInt32BE(end - 4), 422, invalid);
    if (chunks === 1) ensure(type === 'IHDR', 422, invalid);
    if (type === 'IHDR') {
      ensure(!seen.has(type) && chunks === 1 && size === 13, 422, invalid);
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); dimensions(width, height);
      depth = body[8]; color = body[9]; interlace = body[12];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      ensure(depths[color]?.includes(depth) && body[10] === 0 && body[11] === 0 && interlace <= 1, 422, invalid);
    } else if (type === 'PLTE') {
      ensure(!seen.has(type) && !dataStarted && color !== 0 && color !== 4 && size > 0 && size % 3 === 0 && size <= 768, 422, invalid);
      paletteEntries = size / 3;
      if (color === 3) ensure(paletteEntries <= 2 ** depth, 422, invalid);
    } else if (type === 'IDAT') {
      ensure(!dataEnded && (color !== 3 || paletteEntries > 0), 422, invalid);
      dataStarted = true; data.push(body);
    } else if (type === 'IEND') {
      ensure(size === 0 && dataStarted && end === bytes.length, 422, invalid);
      ended = true; at = end; break;
    } else {
      // No APNG, text, compressed profiles or opaque extensions: their
      // payloads are outside the bounded photo format accepted by this endpoint.
      ensure(ancillary.has(type) && !seen.has(type) && !dataStarted, 422, invalid);
      if (type === 'gAMA') ensure(size === 4 && body.readUInt32BE(0) > 0, 422, invalid);
      if (type === 'cHRM') ensure(size === 32, 422, invalid);
      if (type === 'sRGB') ensure(size === 1 && body[0] <= 3, 422, invalid);
      if (type === 'pHYs') ensure(size === 9 && body[8] <= 1, 422, invalid);
      if (type === 'tRNS') ensure(color === 0 ? size === 2 : color === 2 ? size === 6 : color === 3 && paletteEntries > 0 && size > 0 && size <= paletteEntries, 422, invalid);
      if (type === 'bKGD') ensure(color === 3 ? size === 1 && paletteEntries > 0 && body[0] < paletteEntries : size === (color === 0 || color === 4 ? 2 : 6), 422, invalid);
      if (type === 'sBIT') ensure(size === ({ 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 } as Record<number, number>)[color] && [...body].every(b => b > 0 && b <= (color === 3 ? 8 : depth)), 422, invalid);
      if (type === 'eXIf') ensure(size >= 8 && (body.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || body.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))), 422, invalid);
    }
    if (dataStarted && type !== 'IDAT') dataEnded = true;
    seen.add(type); at = end;
  }
  ensure(ended && at === bytes.length, 422, invalid);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const sizes = passes.map(([x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    return { height: w ? h : 0, stride: Math.ceil(w * channels * depth / 8) + 1 };
  });
  const expected = sizes.reduce((n, p) => n + p.height * p.stride, 0);
  ensure(expected > 0 && expected <= RETURN_ASSISTANT_PHOTO_LIMITS.png_inflated_bytes, 422, 'Rozpakowane zdjęcie przekracza limit');
  const compressed = Buffer.concat(data);
  let inflated: Buffer;
  try {
    // Node's info:true runtime result is not represented by @types/node's
    // inflateSync overload; keep the assertion confined to this built-in call.
    const result = inflateSync(compressed, { maxOutputLength: expected, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    ensure(result.engine.bytesWritten === compressed.length, 422, invalid);
    inflated = result.buffer;
  } catch (e) { if (e instanceof Problem) throw e; throw new Problem(422, invalid); }
  ensure(inflated.length === expected, 422, invalid);
  let row = 0;
  for (const pass of sizes) for (let y = 0; y < pass.height; y++) { ensure(inflated[row] <= 4, 422, invalid); row += pass.stride; }
  return { width, height };
}

function jpeg(bytes: Buffer) {
  ensure(bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216, 422, invalid);
  let at = 2, width = 0, height = 0, frame = -1, scans = 0, segments = 0, ended = false;
  const quant = new Set<number>(), huffman = new Set<number>();
  const components = new Map<number, { quant: number; sampling: number }>(), covered = new Set<number>();
  while (at < bytes.length) {
    ensure(++segments <= RETURN_ASSISTANT_PHOTO_LIMITS.segments && bytes[at++] === 255, 422, invalid);
    while (at < bytes.length && bytes[at] === 255) at++;
    ensure(at < bytes.length, 422, invalid);
    const marker = bytes[at++];
    if (marker === 0xd9) { ensure(scans > 0 && covered.size === components.size && at === bytes.length, 422, invalid); ended = true; break; }
    ensure(marker !== 0x00 && marker !== 0xd8 && marker !== 0x01 && !(marker >= 0xd0 && marker <= 0xd7) && at + 2 <= bytes.length, 422, invalid);
    const length = bytes.readUInt16BE(at); ensure(length >= 2 && at + length <= bytes.length, 422, invalid);
    const body = bytes.subarray(at + 2, at + length); at += length;
    if (marker === 0xc0 || marker === 0xc2) {
      ensure(frame < 0 && body.length >= 6 && body[0] === 8, 422, invalid);
      frame = marker; height = body.readUInt16BE(1); width = body.readUInt16BE(3); dimensions(width, height);
      const count = body[5]; ensure(count >= 1 && count <= 4 && body.length === 6 + count * 3, 422, invalid);
      let blocks = 0;
      for (let i = 0; i < count; i++) { const id = body[6 + i * 3], sampling = body[7 + i * 3], q = body[8 + i * 3];
        ensure(!components.has(id) && q <= 3 && (sampling >> 4) >= 1 && (sampling >> 4) <= 4 && (sampling & 15) >= 1 && (sampling & 15) <= 4, 422, invalid);
        blocks += (sampling >> 4) * (sampling & 15); components.set(id, { quant: q, sampling });
      }
      ensure(blocks <= 10, 422, invalid);
    } else if (marker === 0xdb) {
      let n = 0; while (n < body.length) { const spec = body[n++], size = (spec >> 4) ? 128 : 64;
        ensure((spec >> 4) <= 1 && (spec & 15) <= 3 && n + size <= body.length, 422, invalid);
        for (let i = 0; i < size; i += size === 128 ? 2 : 1) ensure(size === 128 ? body.readUInt16BE(n + i) > 0 : body[n + i] > 0, 422, invalid);
        quant.add(spec & 15); n += size;
      } ensure(body.length > 0, 422, invalid);
    } else if (marker === 0xc4) {
      let n = 0; while (n < body.length) { const spec = body[n++]; ensure((spec >> 4) <= 1 && (spec & 15) <= 3 && n + 16 <= body.length, 422, invalid);
        let symbols = 0, slots = 1;
        for (let i = 0; i < 16; i++) { const count = body[n++]; symbols += count; slots = slots * 2 - count; ensure(slots >= 0, 422, invalid); }
        ensure(symbols > 0 && symbols <= 256 && n + symbols <= body.length && slots > 0, 422, invalid);
        const values = body.subarray(n, n + symbols);
        ensure(new Set(values).size === symbols && [...values].every(v => (spec >> 4) === 0 ? v <= 11 : (v & 15) <= 10), 422, invalid);
        huffman.add(spec); n += symbols;
      } ensure(body.length > 0, 422, invalid);
    } else if (marker === 0xdd) ensure(body.length === 2, 422, invalid);
    else if (marker === 0xda) {
      ensure(frame >= 0 && body.length >= 4, 422, invalid);
      const count = body[0]; ensure(count > 0 && count <= components.size && body.length === 1 + count * 2 + 3, 422, invalid);
      const start = body[body.length - 3], end = body[body.length - 2], approximation = body.at(-1)!;
      if (frame === 0xc0) ensure(start === 0 && end === 63 && approximation === 0, 422, invalid);
      else ensure(start <= end && end <= 63 && (start === 0 ? end === 0 : count === 1) && (approximation >> 4) <= 13 && (approximation & 15) <= 13 && ((approximation >> 4) === 0 || (approximation >> 4) === (approximation & 15) + 1), 422, invalid);
      const ids = new Set<number>();
      for (let i = 0; i < count; i++) { const id = body[1 + i * 2], selector = body[2 + i * 2], component = components.get(id);
        ensure(component && !ids.has(id) && quant.has(component.quant) && (selector >> 4) <= 3 && (selector & 15) <= 3, 422, invalid);
        if (start === 0 && (frame === 0xc0 || (approximation >> 4) === 0)) ensure(huffman.has(selector >> 4), 422, invalid);
        if (end > 0) ensure(huffman.has(16 | (selector & 15)), 422, invalid);
        ids.add(id); covered.add(id);
      }
      scans++; let entropy = 0;
      while (at < bytes.length) {
        if (bytes[at] !== 255) { entropy++; at++; continue; }
        const markerStart = at; while (at < bytes.length && bytes[at] === 255) at++;
        ensure(at < bytes.length, 422, invalid);
        const next = bytes[at];
        if (next === 0) { ensure(at === markerStart + 1, 422, invalid); entropy++; at++; }
        else if (next >= 0xd0 && next <= 0xd7) at++;
        else { at = markerStart; break; }
      }
      ensure(entropy > 0, 422, invalid);
    } else {
      // Only ordinary bounded APP metadata/comments. No arithmetic/lossless,
      // hierarchical JPEG, DNL dimensions or other extension marker semantics.
      ensure((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe, 422, invalid);
    }
  }
  ensure(ended && width > 0 && height > 0, 422, invalid);
  return { width, height };
}

/** Bounded structure validation, not a general JPEG entropy/pixel decoder. */
export function validateReturnAssistantPhoto(input: { mime: string; content_base64: string }): ReturnAssistantPhoto {
  ensure(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 2 && Object.hasOwn(input, 'mime') && Object.hasOwn(input, 'content_base64') && (input.mime === 'image/png' || input.mime === 'image/jpeg'), 422, 'Obsługiwane zdjęcia: PNG i JPEG');
  const encoded = input.content_base64;
  ensure(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= 1398104, 422, 'Zdjęcie przekracza limit 1 MiB');
  // Validate alphabet/padding without a nested repetition regex on attacker data.
  ensure(encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 422, 'Niekanoniczne Base64 zdjęcia');
  const bytes = Buffer.from(encoded, 'base64');
  ensure(bytes.length > 0 && bytes.length <= RETURN_ASSISTANT_PHOTO_LIMITS.bytes && bytes.toString('base64') === encoded, 422, 'Niekanoniczne lub zbyt duże zdjęcie');
  const size = input.mime === 'image/png' ? png(bytes) : jpeg(bytes);
  return { bytes, mime: input.mime, byte_count: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...size };
}
