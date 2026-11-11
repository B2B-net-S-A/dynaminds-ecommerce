import { createHash } from 'node:crypto';
import { ensure } from './errors';
export function odooPdf(base64: unknown) {
  ensure(
    typeof base64 === 'string' &&
      base64.length > 0 &&
      base64.length <= 2796204 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64),
    502,
    'Nieprawidłowy PDF Odoo (limit 2 MiB)',
  );
  const pdf = Buffer.from(base64, 'base64');
  ensure(
    pdf.length > 0 &&
      pdf.length <= 2097152 &&
      pdf.toString('base64') === base64 &&
      /^%PDF-1\.[0-7]|^%PDF-2\.0/.test(pdf.subarray(0, 8).toString()) &&
      /%%EOF\s*$/.test(pdf.subarray(-1024).toString('latin1')),
    502,
    'Nieprawidłowy PDF Odoo (limit 2 MiB)',
  );
  return pdf;
}
export const pdfSha256 = (pdf: Buffer) => createHash('sha256').update(pdf).digest('hex');
