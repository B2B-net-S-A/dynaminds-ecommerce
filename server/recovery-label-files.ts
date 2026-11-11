import { createHash } from 'node:crypto';

/** Recovery verifies the frozen bytes; it does not fetch or reinterpret provider data. */
export function recoveredLabelBytes(
  body: unknown,
  head: { format: unknown; content_bytes: unknown; content_sha256: unknown },
): Buffer {
  const content =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).content_base64
      : null;
  const fail = () => {
    throw new Error('Odtworzona etykieta nie odpowiada metadanym');
  };
  if (
    head.format !== 'pdf' ||
    typeof content !== 'string' ||
    !content.length ||
    content.length > 2796204 ||
    !Number.isSafeInteger(head.content_bytes) ||
    Number(head.content_bytes) < 1 ||
    Number(head.content_bytes) > 2097152 ||
    typeof head.content_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(head.content_sha256)
  )
    return fail();
  const bytes = Buffer.from(content, 'base64');
  if (
    bytes.toString('base64') !== content ||
    bytes.length !== head.content_bytes ||
    !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
    createHash('sha256').update(bytes).digest('hex') !== head.content_sha256
  )
    return fail();
  return bytes;
}
