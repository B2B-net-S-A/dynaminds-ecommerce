import { z } from 'zod';
import { ensure } from './errors';
const uuid = z.uuid().transform(v => v.toLowerCase());
const version = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v => BigInt(v) <= 9223372036854775807n);
export const printRecoveryOperations = ['job_create','printer_create','printer_update','reconcile','claim','ack'] as const;
export const intentRecoveryOperations = ['create','allocate','close','reopen'] as const;
export const originalRecoveryParams = z.strictObject({ key: uuid });
export const printRecoveryQuery = z.strictObject({ operation: z.enum(printRecoveryOperations), resource_id: uuid.optional() });
export const intentRecoveryQuery = z.strictObject({ operation: z.enum(intentRecoveryOperations), resource_id: uuid.optional() });
export const originalRecoveryResult = z.strictObject({
  client_key: uuid, operation: z.enum([...printRecoveryOperations,...intentRecoveryOperations]),
  resource_kind: z.enum(['job','printer','external_order']), resource_id: uuid,
  related_id: uuid.nullable(), receipt_id: uuid, version, receipt_version: version,
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  state: z.enum(['queued','claimed','file_saved','spool_submitted','failed','unknown','cancelled','open','closed']).nullable(),
});
export function originalRecoveryEntity(operation: string, resource: string | undefined) {
  const create = ['job_create','printer_create','create'].includes(operation);
  ensure(create ? resource === undefined : resource !== undefined, 422, 'Odczyt wymaga dokładnego rodzaju i oryginalnego obiektu próby');
  return resource ?? null;
}
export function checkedOriginalRecovery(value: unknown, key: string, operation: string, resource: string | null) {
  ensure(value !== null && value !== undefined, 404, 'Nie znaleziono potwierdzenia oryginalnej próby');
  const r = originalRecoveryResult.parse(value);
  ensure(r.client_key === key && r.operation === operation && (resource === null || r.resource_id === resource), 409, 'Odczyt nie odpowiada oryginalnej próbie');
  const kind = operation.startsWith('printer_') ? 'printer' : intentRecoveryOperations.includes(operation as typeof intentRecoveryOperations[number]) ? 'external_order' : 'job';
  ensure(r.resource_kind === kind && BigInt(r.version) >= BigInt(r.receipt_version), 409, 'Niepełne potwierdzenie oryginalnej próby');
  return r;
}
