# Base wire: journal family (221), 23.10.2026

Sixth family on `POST /connector.php` (`server/base-wire-journal.ts`, native port
`server/base-wire-journal-runtime.ts`): `getJournalList`. Source:
`base-api-orders-next-contracts-20261018.md` (getJournalList). Local acceptance only; no Base
sandbox/account request was made. New migration `server/221_base_wire_journal.sql`
(successor to 220, owner-installed, registered in `db.ts` after 220, packaged like 220, cold
inspection projector `base-wire221-source-*.mjs` chained before 220).

## log_id (migration 221)
`order_events` has UUID keys and `created_at=now()` (transaction start), so no native column is
commit ordered. `base_wire221_journal_ids(tenant_id, source 'order_event'|'document', resource_id,
event_id, document_id, log_id bigint identity)`:
- `event_id` → `order_events(tenant_id,id)`, `document_id` → `documents(tenant_id,id)`, both
  `ON DELETE SET NULL` (tombstone). Two typed columns instead of one `local_id`, because one FK
  cannot point at two parents.
- RLS `tenant_scope`, SELECT only for `dyna_app`, immutable / no-truncate trigger (only the FK
  live → tombstone transition after the exact parent disappeared is allowed).
- No trigger on `order_events` or `documents`; only the FKs' internal RI triggers are attached
  (all nine guards stay true).
- `base_wire221_allocate_journal()` (SECURITY DEFINER, current tenant): first
  `base_wire220_allocate_pending('order')` and `('invoice')`, then a per-tenant advisory lock,
  then one INSERT of every not-yet-journaled row in `(created_at, source, id)` order. IDs commit
  before the lock is released, so allocators are serialized and a reader never sees a lower
  `log_id` appear after a higher one. A row whose order (or invoice) has no 220 identity yet in
  that snapshot waits for the next call and gets a higher ID.
- Only native rows from the last 3 days are journaled (Base exposes 3 days); no backfill.

## Call
`getJournalList` allocates in a short writing transaction, then reads in a read-only one (like
`getOrders`). A read-only copy never allocates. Scope `orders:read`; any role.

| Input | LOCAL rule |
|---|---|
| `last_log_id` | exclusive, default 0; int or digit string |
| `logs_types` | Base log type numbers 1..22 (as in the example); empty = all |
| `order_id` | 220 order id; 0 = no filter; unknown/foreign = no logs |

Output: `logs[]` ascending by `log_id`, at most 100 per call (Base names no size), only events
from the last 3 days (event time). Each entry has `log_id` and `id` with the same value (the
contract table says `id`, its example `log_id`), `order_id` (220), `log_type`, `object_id`
(0 when Base gives no meaning), `date` (Unix seconds of the native event).

## Native kind → log type
| Native | log_type | object_id |
|---|---|---|
| `order.created` | 1 | 0 |
| `payment.receipt` | 3 | 0 |
| `order.merged` | 5 | 220 id of `source_ids[0]` |
| invoice/correction `documents` | 7 | 220 invoice id |
| `order.shipped` with `shipmentId` (demo shipment), `order.parcel.dispatched` | 9 | 220 package id |
| `order.delivery_address_changed` | 11 | 0 |
| `order.note_added`, `order.tags_changed`, `order.fields_changed` | 16 | 0 |
| `order.workflow_changed` | 18 | 220 status id of `to` |
| `order.<stage>` (paid, picking, packed, shipped without shipment, …) | 18 | 0 |

Not exposed: item scans, returns, refunds, splits and every other kind. Courier labels
(InPost/DPD) create shipments without an order event, so they have no type 9 entry. Events of
one native transaction share a timestamp, so their order among themselves follows the UUID.
