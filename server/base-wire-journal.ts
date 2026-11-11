/** Base "journal" family on connector.php: getJournalList over native
 * order_events and invoice/correction documents with the 221 lossless log_id.
 * Source: docs/parity/base-api-orders-next-contracts-20261018.md (getJournalList).
 * Mapping and every local choice: docs/parity/BASE-WIRE-JOURNAL221-20261023.md.
 * No database/runtime import: the native port is supplied at startup.
 */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor } from './domain';
import { ensure } from './errors';
import type { BaseWireJson } from './base-wire-codec';
import type { BaseWireFamily } from './base-wire-routes';

export const BASE_WIRE_JOURNAL_METHODS = ['getJournalList'] as const;
type Method = typeof BASE_WIRE_JOURNAL_METHODS[number];
function method(value: string): asserts value is Method {
  ensure(BASE_WIRE_JOURNAL_METHODS.includes(value as Method), 400, 'Nieznana metoda Base dziennika');
}
export const isBaseWireJournalWrite = (value: string) => { method(value); return false; };
export const baseWireJournalScope = (value: string) => { method(value); return 'orders:read' as const; };
/** LOCAL page size: Base does not document one; 100 like getOrders. */
export const BASE_WIRE_JOURNAL_PAGE = 100;
/** Base log types (contract table), 1..22. */
export const BASE_WIRE_JOURNAL_MAX_TYPE = 22;

/** Native order stages (operation-schema.ts `stages`; a unit test pins equality).
 * Repeated here so the family module stays free of runtime imports. */
export const BASE_WIRE_JOURNAL_STAGES = ['new','paid','picking','packed','shipped','delivered','completed','cancelled',
  'return_initiated','return_received','return_completed'] as const;
/** What object_id carries: merged source order, package, workflow status or nothing (0). */
export type BaseWireJournalObject = 'none' | 'merged_order' | 'package' | 'status';
/** Native order_events kinds exposed in the journal. Invoice/correction documents
 * are log type 7 (object_id = 220 invoice id). LOCAL exception: order.shipped
 * without detail.shipmentId (a plain stage transition) is type 18, not 9. */
export type BaseWireJournalEventType = Readonly<{ kind: string; log_type: number; object: BaseWireJournalObject }>;
export const BASE_WIRE_JOURNAL_EVENT_TYPES: readonly BaseWireJournalEventType[] = Object.freeze(([
  { kind: 'order.created', log_type: 1, object: 'none' },
  { kind: 'payment.receipt', log_type: 3, object: 'none' },
  { kind: 'order.merged', log_type: 5, object: 'merged_order' },
  { kind: 'order.shipped', log_type: 9, object: 'package' },
  { kind: 'order.parcel.dispatched', log_type: 9, object: 'package' },
  { kind: 'order.delivery_address_changed', log_type: 11, object: 'none' },
  { kind: 'order.note_added', log_type: 16, object: 'none' },
  { kind: 'order.tags_changed', log_type: 16, object: 'none' },
  { kind: 'order.fields_changed', log_type: 16, object: 'none' },
  { kind: 'order.workflow_changed', log_type: 18, object: 'status' },
  ...BASE_WIRE_JOURNAL_STAGES.filter(s => s !== 'shipped').map(s => ({ kind: 'order.' + s, log_type: 18, object: 'none' as const })),
] as BaseWireJournalEventType[]).map(r => Object.freeze(r)));

export type BaseWireJournalEntry = { log_id: number; order_public_id: number; log_type: number; object_id: number; date: number };
/** `after` is exclusive; ascending log_id; last 3 days only. */
export type BaseWireJournalFilter = { after: number; types?: number[]; order_public_id?: number; limit: number };
/** One native port per transaction; every lookup is the current tenant only. */
export type BaseWireJournalNative = {
  /** base_wire221_allocate_journal() for the current tenant (writing transaction only). */
  allocate(): Promise<void>;
  entries(filter: BaseWireJournalFilter): Promise<BaseWireJournalEntry[]>;
};
export type BaseWireJournalPorts = {
  transaction<T>(actor: Actor, writing: boolean, work: (c: PoolClient) => Promise<T>): Promise<T>;
  native(c: PoolClient, actor: Actor): BaseWireJournalNative;
  /** Startup decision: a read-only copy never allocates log IDs. */
  allocateOnRead: boolean;
};

const optionalId = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Base sends ints; a digit string is accepted like the other families' loose IDs.
const looseId = z.union([optionalId, z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number)]).pipe(optionalId);
const journalInput = z.object({
  last_log_id: looseId.optional(),
  // LOCAL: logs_types is read as Base log type numbers (the example); an empty list means all types.
  logs_types: z.array(z.number().int().min(1).max(BASE_WIRE_JOURNAL_MAX_TYPE)).max(BASE_WIRE_JOURNAL_MAX_TYPE).optional(),
  // LOCAL: order_id 0 means no order filter; an unknown or foreign order_id matches nothing.
  order_id: looseId.optional(),
}).strict();

function logDto(e: BaseWireJournalEntry): Record<string, BaseWireJson> {
  // The contract table names the field `id`, its example `log_id`: both carry the same value (LOCAL).
  return { log_id: e.log_id, id: e.log_id, order_id: e.order_public_id, log_type: e.log_type, object_id: e.object_id, date: e.date };
}

export function createBaseWireJournalService(ports: BaseWireJournalPorts) {
  const tx = <T>(actor: Actor, writing: boolean, work: (n: BaseWireJournalNative) => Promise<T>) =>
    ports.transaction(actor, writing, c => work(ports.native(c, actor)));
  async function list(actor: Actor, parameters: Record<string, BaseWireJson>) {
    const b = journalInput.parse(parameters);
    // Every pending native row gets its log_id here, committed before the read snapshot.
    if (ports.allocateOnRead) await tx(actor, true, n => n.allocate());
    const types = b.logs_types?.length ? [...new Set(b.logs_types)] : undefined;
    const entries = await tx(actor, false, n => n.entries({ after: b.last_log_id ?? 0, types, order_public_id: b.order_id || undefined, limit: BASE_WIRE_JOURNAL_PAGE }));
    let previous = b.last_log_id ?? 0;
    for (const e of entries) { ensure(e.log_id > previous, 503, 'Niespójny dziennik Base'); previous = e.log_id; }
    return { logs: entries.slice(0, BASE_WIRE_JOURNAL_PAGE).map(logDto) };
  }
  return {
    async execute(actor: Actor, selected: string, parameters: Record<string, BaseWireJson>, _options: { clientKey?: string; credential?: string } = {}): Promise<Record<string, BaseWireJson>> {
      method(selected);
      return list(actor, parameters);
    },
  };
}
export type BaseWireJournalService = ReturnType<typeof createBaseWireJournalService>;

/** Sixth connector.php family. Only startup capability selects availability. */
export function createBaseWireJournalFamily(opts: { service: Pick<BaseWireJournalService, 'execute'>; available: boolean }): BaseWireFamily {
  return Object.freeze({ label: 'dziennika', methods: BASE_WIRE_JOURNAL_METHODS, scope: baseWireJournalScope, isWrite: isBaseWireJournalWrite,
    available: opts.available === true, service: opts.service });
}
