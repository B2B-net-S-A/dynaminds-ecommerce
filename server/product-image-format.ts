import { ensure } from './errors';
export function productImageData(data: unknown, status = 422) {
  ensure(
    typeof data === 'string' &&
      data.length > 0 &&
      data.length <= 699052 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data),
    status,
    'Nieprawidłowe zdjęcie Base64 (limit 512 KiB)',
  );
  const bytes = Buffer.from(data, 'base64');
  ensure(
    bytes.length > 0 && bytes.length <= 524288 && bytes.toString('base64') === data,
    status,
    'Zdjęcie przekracza 512 KiB lub ma nieprawidłowe Base64',
  );
  let mime = '';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    mime = 'image/png';
  else if (
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  )
    mime = 'image/jpeg';
  else if (
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP'
  )
    mime = 'image/webp';
  ensure(mime, status, 'Obsługiwane zdjęcia: PNG, JPEG, WebP');
  return { bytes, mime };
}
