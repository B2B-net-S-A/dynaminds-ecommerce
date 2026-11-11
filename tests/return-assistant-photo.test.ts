import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { Problem } from '../server/errors';
import { RETURN_ASSISTANT_PHOTO_LIMITS, returnAssistantPhotoInput, validateReturnAssistantPhoto } from '../server/return-assistant-photo';

// Fixture construction uses the native zlib CRC, independently of the validator.
function chunk(name: string, body: Buffer) {
  const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([type, body])));
  return Buffer.concat([size, type, body, crc]);
}
function png(options: { width?: number; height?: number; raw?: Buffer; compressed?: Buffer; interlace?: number; color?: number; extra?: Buffer[] } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(options.width ?? 1); header.writeUInt32BE(options.height ?? 1, 4);
  header[8] = 8; header[9] = options.color ?? 6; header[12] = options.interlace ?? 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...(options.extra ?? []), chunk('IDAT', options.compressed ?? deflateSync(options.raw ?? Buffer.from([0, 50, 100, 150, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function segment(marker: number, body: Buffer) { const prefix = Buffer.alloc(4); prefix[0] = 255; prefix[1] = marker; prefix.writeUInt16BE(body.length + 2, 2); return Buffer.concat([prefix, body]); }
// Minimal standards-conforming baseline grayscale image: one zero DCT block,
// one-bit DC=0 / AC=EOB Huffman codes and six padding bits (0x3f).
function jpeg(options: { width?: number; height?: number; exif?: boolean; entropy?: Buffer } = {}) {
  const frame = Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]); frame.writeUInt16BE(options.height ?? 1, 1); frame.writeUInt16BE(options.width ?? 1, 3);
  const dc = Buffer.from([0, 1, ...Array(15).fill(0), 0]), ac = Buffer.from([0x10, 1, ...Array(15).fill(0), 0]);
  return Buffer.concat([Buffer.from([255, 216]), ...(options.exif ? [segment(0xe1, Buffer.from('45786966000049492a0008000000000000000000', 'hex'))] : []), segment(0xdb, Buffer.from([0, ...Array(64).fill(1)])), segment(0xc0, frame), segment(0xc4, Buffer.concat([dc, ac])), segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), options.entropy ?? Buffer.from([0x3f]), Buffer.from([255, 217])]);
}
const input = (bytes: Buffer, mime = 'image/png') => ({ mime, content_base64: bytes.toString('base64') });
function rejects(bytes: Buffer, mime = 'image/png') { assert.throws(() => validateReturnAssistantPhoto(input(bytes, mime)), (e: unknown) => e instanceof Problem && e.status === 422); }

test('valid PNG retains exact bytes, dimensions and independent digest, including Adam7 and camera EXIF', () => {
  for (const bytes of [png(), png({ color: 0, interlace: 1, raw: Buffer.from([0, 128]) }), png({ extra: [chunk('eXIf', Buffer.from('49492a0008000000000000000000', 'hex'))] })]) {
    const result = validateReturnAssistantPhoto(input(bytes)); assert.deepEqual(result.bytes, bytes);
    assert.equal(result.mime, 'image/png'); assert.equal(result.width, 1); assert.equal(result.height, 1);
    assert.equal(result.byte_count, bytes.length); assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
});
test('valid baseline JPEG with ordinary camera EXIF is accepted without rewriting its content', () => {
  for (const bytes of [jpeg(), jpeg({ exif: true })]) { const result = validateReturnAssistantPhoto(input(bytes, 'image/jpeg')); assert.deepEqual(result.bytes, bytes); assert.equal(result.mime, 'image/jpeg'); assert.equal(result.width, 1); assert.equal(result.height, 1); assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex')); }
});
test('declared MIME cannot bless another image, SVG/GIF/HTML or additional unvalidated input', () => {
  rejects(png(), 'image/jpeg'); rejects(jpeg(), 'image/png');
  for (const mime of ['image/svg+xml', 'image/gif', 'text/html', 'image/png; charset=utf-8']) rejects(Buffer.from('<script>alert(1)</script>'), mime);
  assert.equal(returnAssistantPhotoInput.safeParse({ ...input(png()), path: '/tmp/file' }).success, false);
  assert.throws(() => validateReturnAssistantPhoto({ ...input(png()), path: '/tmp/file' } as any), Problem);
});
test('noncanonical base64 variants and both encoded/raw byte overflow fail before image work', () => {
  const good = input(png());
  for (const content_base64 of [good.content_base64 + '\n', good.content_base64.replace(/=+$/, ''), 'AA=A', 'Zh==', 'data:image/png;base64,' + good.content_base64, '-___', '', 123]) assert.throws(() => validateReturnAssistantPhoto({ mime: good.mime, content_base64 } as any), Problem);
  rejects(Buffer.alloc(RETURN_ASSISTANT_PHOTO_LIMITS.bytes + 1));
  assert.throws(() => validateReturnAssistantPhoto({ mime: 'image/png', content_base64: 'A'.repeat(1398108) }), Problem);
});
test('dimension and pixel budgets apply independently to PNG and JPEG before decompressing', () => {
  for (const dimensions of [{ width: 0 }, { height: 8193 }, { width: 4001, height: 4000 }]) { rejects(png(dimensions)); rejects(jpeg(dimensions), 'image/jpeg'); }
  rejects(png({ width: 8192, height: 8192 })); rejects(jpeg({ width: 8192, height: 8192 }), 'image/jpeg');
});
test('PNG requires CRC, complete unique ordered chunks and exact end, rejecting active trailing payload', () => {
  const bytes = png(), corrupt = Buffer.from(bytes); corrupt[20] ^= 1; rejects(corrupt);
  for (const cut of [1, 8, 20, bytes.length - 1]) rejects(bytes.subarray(0, cut));
  rejects(Buffer.concat([bytes, Buffer.from('<svg onload="alert(1)"/>')]));
  rejects(png({ extra: [chunk('IHDR', bytes.subarray(16, 29))] }));
  rejects(png({ extra: [chunk('tEXt', Buffer.from('comment\0<script/>'))] }));
});
test('PNG inflate is bounded by actual scanline geometry and rejects truncated/concatenated streams and filters', () => {
  rejects(png({ raw: Buffer.alloc(1048576) }));
  rejects(png({ raw: Buffer.from([5, 50, 100, 150, 255]) }));
  const packed = deflateSync(Buffer.from([0, 50, 100, 150, 255]));
  rejects(png({ compressed: packed.subarray(0, packed.length - 1) }));
  rejects(png({ compressed: Buffer.concat([packed, deflateSync(Buffer.from('payload'))]) }));
  rejects(png({ raw: Buffer.from([0, 50]) }));
});
test('JPEG requires bounded segments, actual frame/tables/scan/entropy and a final EOI without appended payload', () => {
  const bytes = jpeg();
  for (const cut of [2, 20, bytes.length - 1]) rejects(bytes.subarray(0, cut), 'image/jpeg');
  rejects(Buffer.from([255, 216, 255, 217]), 'image/jpeg');
  rejects(jpeg({ entropy: Buffer.alloc(0) }), 'image/jpeg');
  rejects(Buffer.concat([bytes, Buffer.from('<html><script/></html>')]), 'image/jpeg');
  const badLength = Buffer.from(bytes); badLength.writeUInt16BE(65535, 4); rejects(badLength, 'image/jpeg');
  const missingTable = Buffer.from(bytes); missingTable[3] = 0xe2; rejects(missingTable, 'image/jpeg');
});
