/** Source-only CRM dictionary adapter; not registered with the application.
 * Contracts: docs/parity/base-api-client-contracts.v1.json, six status/group methods.
 * The caller MUST supply a tenant/actor/API-key-bound transaction which performs
 * fresh CRM authority/MFA/readOnly checks BEFORE invoking this callback, including
 * replay. Shared routing, rate limits and response envelopes remain outside here.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ensure } from './errors';
import { parseBaseWireId, type BaseWireJson } from './base-wire-codec';

export const BASE_WIRE_CRM_DICTIONARY_METHODS = [
  'getCrmClientStatusGroups', 'getCrmClientStatuses',
  'addCrmClientStatusGroup', 'addCrmClientStatus',
  'deleteCrmClientStatusGroup', 'deleteCrmClientStatus',
] as const;
export type BaseWireCrmDictionaryMethod = typeof BASE_WIRE_CRM_DICTIONARY_METHODS[number];
export type DictionaryKind = 'group' | 'status';
type WriteMethod = Exclude<BaseWireCrmDictionaryMethod, 'getCrmClientStatusGroups' | 'getCrmClientStatuses'>;
export const isBaseWireCrmDictionaryWrite = (method: string) =>
  BASE_WIRE_CRM_DICTIONARY_METHODS.includes(method as BaseWireCrmDictionaryMethod) &&
  method !== 'getCrmClientStatusGroups' && method !== 'getCrmClientStatuses';

export type CrmWireGroup = { id: string; name: string; is_main_group: 0 | 1; version: number };
export type CrmWireStatus = {
  id: string; name: string; color: string; group_id: string; is_primary: 0 | 1;
  position: number; version: number;
};
export type CrmDictionaryCommand = { clientKey: string; wireHash: string; method: WriteMethod };
export type CrmDictionaryReceipt = { method: WriteMethod; resourceId: string };
/** A real integration must delegate writes to existing CRM parse/apply/journal/
 * audit inside this SAME transaction. No DML or authority is implemented here.
 * resolve is live-only; publicId reads immutable resource_id even after deletion.
 * Every method is tenant-scoped; neither read allocates/backfills numeric IDs.
 */
export interface BaseWireCrmDictionaryPort {
  groups(): Promise<CrmWireGroup[]>;
  statuses(): Promise<CrmWireStatus[]>;
  resolve(kind: DictionaryKind, publicId: number): Promise<string | null>;
  publicId(kind: DictionaryKind, resourceId: string): Promise<string | null>;
  /** Exact original hash + current actor/API-key custody, never a new execution. */
  replay(command: CrmDictionaryCommand): Promise<CrmDictionaryReceipt | null>;
  saveGroup(id: string | null, input: { name: string }, command: CrmDictionaryCommand): Promise<CrmDictionaryReceipt>;
  saveStatus(id: string | null, input: { name?: string; color?: string; group_id?: string }, command: CrmDictionaryCommand): Promise<CrmDictionaryReceipt>;
  removeGroup(id: string, command: CrmDictionaryCommand): Promise<CrmDictionaryReceipt>;
  removeStatus(id: string, targetId: string, command: CrmDictionaryCommand): Promise<CrmDictionaryReceipt>;
}
export interface BaseWireCrmDictionaryTransactions {
  transaction<T>(writing: boolean, work: (dictionary: BaseWireCrmDictionaryPort) => Promise<T>): Promise<T>;
}

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuid = z.uuid();
const name = (max: number) => z.string().trim().min(1).max(max);
const groupInput = z.object({ group_id: id.optional(), name: name(15) }).strict();
const statusInput = z.object({
  status_id: id.optional(), name: name(30).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  group_id: id.optional(),
}).strict().superRefine((input, ctx) => {
  // Retained docs do not mark all requiredness explicitly. These are LOCAL
  // native-CRM-compatible refusals, not a vendor claim about missing fields.
  if (input.status_id === undefined && (input.name === undefined || input.color === undefined))
    ctx.addIssue({ code: 'custom', message: 'Nowy status wymaga nazwy i koloru' });
  if (input.status_id !== undefined && Object.keys(input).length === 1)
    ctx.addIssue({ code: 'custom', message: 'Brak zmian statusu' });
});
const removeGroupInput = z.object({ group_id: id }).strict();
const removeStatusInput = z.object({ status_id: id, target_status_id: id }).strict()
  .refine(input => input.status_id !== input.target_status_id, 'Status docelowy musi być inny');
const groupRow = z.object({ id: uuid, name: z.string().min(1).max(15), is_main_group: z.union([z.literal(0), z.literal(1)]), version: id }).strict();
const statusRow = z.object({
  id: uuid, name: z.string().min(1).max(30), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), group_id: uuid,
  is_primary: z.union([z.literal(0), z.literal(1)]), version: id, position: z.number().int().nonnegative(),
}).strict();
const receiptSchema = z.object({ method: z.enum([
  'addCrmClientStatusGroup', 'addCrmClientStatus', 'deleteCrmClientStatusGroup', 'deleteCrmClientStatus',
]), resourceId: uuid }).strict();

async function local(port: BaseWireCrmDictionaryPort, kind: DictionaryKind, numeric: number) {
  const resource = await port.resolve(kind, parseBaseWireId(numeric, false));
  ensure(resource !== null, 404, 'Nie znaleziono własnego słownika CRM');
  return uuid.parse(resource);
}
async function numeric(port: BaseWireCrmDictionaryPort, kind: DictionaryKind, resource: string) {
  const value = await port.publicId(kind, uuid.parse(resource));
  ensure(typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
    503, 'Brak poprawnej trwałej tożsamości słownika CRM');
  return parseBaseWireId(Number(value), false);
}
function checkedReceipt(receipt: CrmDictionaryReceipt, command: CrmDictionaryCommand) {
  const parsed = receiptSchema.parse(receipt);
  ensure(parsed.method === command.method, 503, 'Niespójne potwierdzenie słownika CRM');
  return parsed;
}

export function createBaseWireCrmDictionariesService(ports: BaseWireCrmDictionaryTransactions) {
  return {
    async execute(method: string, parameters: Record<string, BaseWireJson>, options: { clientKey?: string } = {}): Promise<Record<string, BaseWireJson>> {
      ensure(BASE_WIRE_CRM_DICTIONARY_METHODS.includes(method as BaseWireCrmDictionaryMethod), 400, 'Nieznana metoda słownika CRM');
      if (method === 'getCrmClientStatusGroups' || method === 'getCrmClientStatuses') {
        z.object({}).strict().parse(parameters);
        return ports.transaction(false, async (port): Promise<Record<string, BaseWireJson>> => {
          if (method === 'getCrmClientStatusGroups') {
            const status_groups = [];
            for (const raw of await port.groups()) {
              const row = groupRow.parse(raw);
              status_groups.push({ group_id: await numeric(port, 'group', row.id), name: row.name, is_main_group: row.is_main_group });
            }
            return { status_groups };
          }
          const statuses = [];
          for (const raw of await port.statuses()) {
            const row = statusRow.parse(raw);
            statuses.push({ id: await numeric(port, 'status', row.id), name: row.name, color: row.color,
              group_id: await numeric(port, 'group', row.group_id), is_primary: row.is_primary });
          }
          return { statuses };
        });
      }
      const writeMethod = method as WriteMethod;
      const command: CrmDictionaryCommand = {
        clientKey: uuid.parse(options.clientKey ?? randomUUID()), method: writeMethod,
        wireHash: createHash('sha256').update(JSON.stringify({ method, parameters })).digest('hex'),
      };
      // Validate before entering a write transaction, retaining the original
      // unnormalised parameters above for exact-key replay custody.
      const parsed = method === 'addCrmClientStatusGroup' ? groupInput.parse(parameters)
        : method === 'addCrmClientStatus' ? statusInput.parse(parameters)
          : method === 'deleteCrmClientStatusGroup' ? removeGroupInput.parse(parameters) : removeStatusInput.parse(parameters);
      return ports.transaction(true, async port => {
        const kind: DictionaryKind = method.endsWith('StatusGroup') ? 'group' : 'status';
        const result = async (receipt: CrmDictionaryReceipt) => {
          const retained = checkedReceipt(receipt, command);
          const publicId = await numeric(port, kind, retained.resourceId);
          const originalId = kind === 'group' ? (parsed as { group_id?: number }).group_id : (parsed as { status_id?: number }).status_id;
          ensure(originalId === undefined || publicId === originalId, 503, 'Potwierdzenie wskazuje inny słownik CRM');
          return method.startsWith('delete') ? {} : {
            [kind === 'group' ? 'group_id' : 'status_id']: publicId,
          };
        };
        // Fresh authority belongs to transaction(), before this callback. Replay
        // precedes live lookup/CAS, so historical ACKs survive physical deletion.
        const prior = await port.replay(command);
        if (prior) return result(prior);
        if (method === 'addCrmClientStatusGroup') {
          const input = parsed as z.infer<typeof groupInput>;
          return result(await port.saveGroup(input.group_id === undefined ? null : await local(port, 'group', input.group_id), { name: input.name }, command));
        }
        if (method === 'addCrmClientStatus') {
          const input = parsed as z.infer<typeof statusInput>, body: { name?: string; color?: string; group_id?: string } = {};
          if (input.name !== undefined) body.name = input.name;
          if (input.color !== undefined) body.color = input.color;
          if (input.group_id !== undefined) body.group_id = await local(port, 'group', input.group_id);
          return result(await port.saveStatus(input.status_id === undefined ? null : await local(port, 'status', input.status_id), body, command));
        }
        if (method === 'deleteCrmClientStatusGroup')
          return result(await port.removeGroup(await local(port, 'group', (parsed as z.infer<typeof removeGroupInput>).group_id), command));
        const input = parsed as z.infer<typeof removeStatusInput>;
        return result(await port.removeStatus(await local(port, 'status', input.status_id), await local(port, 'status', input.target_status_id), command));
      });
    },
  };
}
