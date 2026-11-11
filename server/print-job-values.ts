import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from './domain';

export const PRINT_JOB_LIMITS = { printers: 100, jobs: 2000, events: 10000, content_bytes: 2097152, history_bytes: 67108864, page: 50, copies: 10, lease_seconds: 90 } as const;
export type PrintActor = Actor & { apiKeyId?: string };
export const PRINT_JOB_STATES = ['queued','claimed','file_saved','spool_submitted','failed','unknown','cancelled'] as const;
export const printUuid = z.uuid().transform(v => v.toLowerCase());
export const printVersion = z.string().max(19).regex(/^[1-9]\d*$/).refine(v => v.length<=19 && /^[1-9]\d*$/.test(v) && BigInt(v) <= 9223372036854775807n);
const text = (max: number, min = 1) => z.string().trim().min(min).max(max).refine(v => !/[\u0000-\u001f\u007f]/.test(v) && Buffer.from(v).toString('utf8') === v);
export const printFormat = z.enum(['pdf','zpl']);
const printerFields = { station_id: printUuid, station_version: printVersion, name: text(120), format: printFormat, output_mode: z.enum(['file','cups']), cups_queue: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).nullable(), enabled: z.boolean() };
const printerRule = (v: {output_mode: string;cups_queue: string|null}) => (v.output_mode === 'cups') === (v.cups_queue !== null);
export const printPrinterCreateInput = z.strictObject({client_key: printUuid,...printerFields}).refine(printerRule,'Tryb CUPS wymaga nazwy kolejki');
export const printPrinterUpdateInput = z.strictObject({client_key: printUuid,version: printVersion,...printerFields}).refine(printerRule,'Tryb CUPS wymaga nazwy kolejki');
export const printJobCreateInput = z.strictObject({client_key: printUuid,order_id: printUuid,order_version: printVersion,station_id: printUuid,station_version: printVersion,printer_id: printUuid,printer_version: printVersion,source_kind: z.literal('manual'),format: printFormat,content_base64: z.string().min(4).max(2796204),copies: z.number().int().min(1).max(10),confirmed: z.literal(true),retry_of_job_id: printUuid.optional(),reprint_confirmed: z.literal(true).optional()}).refine(v => !!v.retry_of_job_id === !!v.reprint_confirmed,'Ponowne zlecenie wymaga osobnego potwierdzenia ryzyka kopii');
export const printJobClaimInput = z.strictObject({client_key: printUuid,version: printVersion,lease_token: printUuid});
export const printJobAckInput = z.strictObject({client_key: printUuid,version: printVersion,lease_token: printUuid,result: z.enum(['file_saved','spool_submitted','failed','unknown']),content_sha256: z.string().regex(/^[a-f0-9]{64}$/),artifact_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(),spool_job_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(),error_code: z.enum(['OUTPUT_FAILED','INTERRUPTED','UNCONFIRMED']).optional()}).superRefine((v,c) => { if ((v.result === 'file_saved' && (!v.artifact_name || v.spool_job_id || v.error_code)) || (v.result === 'spool_submitted' && (!v.spool_job_id || v.artifact_name || v.error_code)) || (['failed','unknown'].includes(v.result) && (!v.error_code || v.artifact_name || v.spool_job_id))) c.addIssue({code:'custom',message:'Wynik wymaga odpowiedniego, bezpiecznego potwierdzenia'}); });
export const printJobReconcileInput = z.strictObject({client_key: printUuid,version: printVersion,result: z.enum(['unknown','cancelled']),confirmed: z.literal(true),note: text(500,3)});
export const printPrinterQuery = z.strictObject({cursor: printUuid.optional(),limit: z.coerce.number().int().min(1).max(50).default(50)});
export const printJobQuery = z.strictObject({cursor: printUuid.optional(),limit: z.coerce.number().int().min(1).max(50).default(50),order_id: printUuid.optional(),printer_id: printUuid.optional(),state: z.enum(PRINT_JOB_STATES).optional()});
export const PRINTABLE_ZPL_COMMANDS = ['XA','XZ','FO','FT','FD','FS','A0','CF','CI','PW','LL','LH','LT','LS','FW','FB','FR','FX','BY','BC','B3','BQ','BE','GB','GF'] as const;
export function validatePrintContent(contentBase64: string, format: 'pdf'|'zpl') {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) throw new Error('PRINT_CONTENT_INVALID');
  const bytes = Buffer.from(contentBase64,'base64');
  if (!bytes.length || bytes.length > PRINT_JOB_LIMITS.content_bytes || bytes.toString('base64') !== contentBase64) throw new Error('PRINT_CONTENT_INVALID');
  if (format === 'pdf') {
    const s = bytes.toString('latin1');
    if (!/^%PDF-1\.[0-9]/.test(s) || !/%%EOF[\r\n\t ]*$/.test(s) || /\/(?:JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile)\b/i.test(s) || /#[0-9a-f]{2}/i.test(s)) throw new Error('PRINT_CONTENT_UNSAFE');
  } else {
    const s = bytes.toString('utf8');
    const commands = [...s.matchAll(/\^([A-Za-z0-9]{2})/g)].map(m => m[1]);
    if (Buffer.from(s).compare(bytes) !== 0 || /[^\x09\x0a\x0d\x20-\x7e]/.test(s) || s.includes('~') || !/^\s*\^XA/.test(s) || !/\^XZ\s*$/.test(s) || (s.match(/\^XA/g)||[]).length !== 1 || (s.match(/\^XZ/g)||[]).length !== 1 || (s.match(/\^/g)||[]).length !== commands.length || commands.some(c => !(PRINTABLE_ZPL_COMMANDS as readonly string[]).includes(c))) throw new Error('PRINT_CONTENT_UNSAFE');
    // Inline graphics only: no printer-resident files, fonts, configuration or copy commands.
    if (/\^GF(?!A,)/.test(s)) throw new Error('PRINT_CONTENT_UNSAFE');
    const graphics=[...s.matchAll(/\^GFA,(\d{1,7}),(\d{1,7}),(\d{1,4}),([A-Fa-f0-9]+)(?=\^|$)/g)];
    if (graphics.length !== commands.filter(c=>c==='GF').length || graphics.some(g=>Number(g[1])!==Number(g[2]) || Number(g[2])<1 || Number(g[2])>1048576 || Number(g[3])<1 || Number(g[3])>4096 || Number(g[2])%Number(g[3])!==0 || g[4].length!==Number(g[2])*2)) throw new Error('PRINT_CONTENT_UNSAFE');
  }
  return {content_bytes: bytes.length,content_sha256: createHash('sha256').update(bytes).digest('hex')};
}
export type PrintPrinterCreateInput = z.infer<typeof printPrinterCreateInput>;
export type PrintPrinterUpdateInput = z.infer<typeof printPrinterUpdateInput>;
export type PrintJobCreateInput = z.infer<typeof printJobCreateInput>;
export type PrintJobClaimInput = z.infer<typeof printJobClaimInput>;
export type PrintJobAckInput = z.infer<typeof printJobAckInput>;
export type PrintJobReconcileInput = z.infer<typeof printJobReconcileInput>;
