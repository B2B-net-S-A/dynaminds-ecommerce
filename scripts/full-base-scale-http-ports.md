# Local scale HTTP bindings — partial implementation

The actual driver entry point is `createFullBaseScaleOperations` in
`full-base-scale-http-ports.mjs`. The module performs no network, file, database,
seed, session renewal or other hidden IO. The driver owns every measured request.
The fixture is explicit JSON under the private plan's `context.fixture`, with
exact source pins, five declared tenant/user/session bindings, read cases and
finite, once-consumed write commands containing the original key, body, version,
resource identity and expected business values. It must fit the current 60,000 B
fixture / 65,536 B whole-plan limits. Fixture declarations do not authenticate a
session's tenant or establish an installed release's source authority.

**The complete frozen profile is still NOT runnable with this fixture format.**
The full entry point refuses the implementation/lifecycle gates listed in
`SCALE_HTTP_FULL_PROFILE_BLOCKERS`; the existing driver returns
`NOT_RUN_INCOMPLETE_OPERATION_PORTS` before its attempt marker, health request or
any business write. These gates cannot be replaced with fixture booleans. No
successful requests, provider acceptance or scale measurement are inferred.

`createPreparedScaleHttpOperationBindings` exposes partial source-tested bindings
for examining prepared requests and ordinary DTOs. Its 40 implemented variant
slots are not 40 accepted operation families. Across five firms these cover three
reads, manual prepaid PLN order creation, eligible status change to picking,
manual payment receipt or native local invoice issue, positive/negative WMS adjustment
execute, prepared inter-warehouse transfer, ordinary sale RMA receive with WMS
OFF/ON picks and a separately prepared destinations inspection.

Payment/RMA HTTP 200 alone is insufficient. The newly inspected backend selects
`reused` in the same locked atomic mutation that either reads an exact historical
receipt or inserts the new effect. Payment completion now requires
`reused:false`, the exact `payment_entry_id`, and that ledger entry's complete
parsed original request and business values. RMA requires `reused:false`, exact
durable `{return_id,receipt_sequence}`, and the entire archived parsed receipt,
including all WMS picks, stock versions, locations and client key. Historical
`reused:true`, missing fields from older releases, null/unsequenced identities or
changed bodies refuse; they never become fresh latency samples. This source-only
binding is not evidence that a currently running release contains these changes.

The pure `inspectScaleReturnReceiveReadback` still returns `freshness:UNPROVEN`
and `write_acceptance:false` for a matching receipt alone. It is readback
inspection, never write authorization. Invoice/WMS fresh responses require HTTP
201 and `reused:false`; duplicate business IDs within a run refuse. Status writes
retain the source version CAS. A lost ACK keeps original request custody and
cannot authorize an automatic retry. Catalog results follow the ordinary server's
SKU/name/EAN/alias predicate; no absent alias list is invented from the DTO.

Prepared negative corrections use the same ordinary `/api/inventory/adjust`
execute protocol, fresh `reused:false` operation and exact policy version. Their
actual backend result is an issue: positive-quantity `fragments`, not receipt
`layers` or `result.signed_delta`. The fixture must capture every selected layer,
lot, location, quantity, known/unknown unit cost and exact value. Completion binds
all those fields, unique newly issued fragment IDs, own product, a durable
warehouse-document UUID and complete valuation. Operation, warehouse-document and
issued-fragment IDs are deduplicated per tenant across successful commands as one
bounded, atomic registration; a duplicate cannot partly register the other IDs.
Minus the fragment quantity sum
must equal the prepared negative `signed_delta`. Redacted costs cannot pass this
value-aware binding. The local fixture limits this variant to 100 fragments and
one policy currency. The genuine prepared preview/scope binds the warehouse and
input stock versions; the execute DTO does not expose post-stock versions or a
full stock/journal readback, so none is claimed here. Post-operation conservation is still outside this binding.

Prepared transfer commands additionally use `kind:"wms_transfer"`, a captured
`preview_id`, and exact body `{client_key,scope_hash,confirmed}`. They dispatch
only `POST /api/wms-lots/movement-previews/:id/execute` and require fresh201,
`reused:false`, `operation.kind:"transfer"`, exact policy version and unique own
operation/warehouse-document IDs. The fixture captures `product_id`, source and
destination warehouse IDs, destination location, positive quantity and up to100
exact fragments `{layer_id,lot_id,lot_code,location,quantity,unit_cost_minor,
currency,fifo_sequence}` from the genuine preview. Actual result source/destination,
fragment identities/quantities/costs/FIFO and complete valuation must match; the
fragment sum equals the prepared quantity. These are existing transferred layers:
no invented new fragment ID, per-fragment product/value or signed delta is required.
The real scope binds product and both current input stock versions; those fields
are not exposed as execute-result readback. Value-redacted responses refuse.
Operation and warehouse-document IDs share the per-tenant atomic effect registry
with adjustments. Same-warehouse bin moves are not this variant. Ordinary positions
and operation-detail GETs can later support independent reconciliation, but this
synchronous binding performs no hidden requests or preview refresh. Finite prepared
transfers do not prove current-version lifecycle, hot-SKU ratios or conservation.

Prepared manual OFF corrections (tenants without WMS lots, migration 169) use
`kind:"manual_off"`, a captured `preview_id` and exact body
`{client_key,scope_hash,confirmed}`. They dispatch only
`POST /api/inventory/manual-corrections/previews/:id/apply` and require fresh201,
`reused:false`, a receipt with protocol `manual_off_pw_rw_v1` of exactly that preview,
consent key and scope, the prepared `product_id`/`warehouse_id`/`location`/nonzero
`delta` in its request, one PW (delta > 0) or RW document row with the same product,
location, delta and quantity, and both native journal IDs. Receipt and stock-movement
IDs join the per-tenant effect registry. The preview (frame revision of the stock row,
bins and active holds) is prepared outside this binding; stock conservation is not
claimed here (the load driver's reconciliation checks it after the run).

Prepared destinations commands use their distinct `kind:"return_destinations"`
and ordinary destinations receive endpoint. They carry a genuine prepared preview,
session custody and exact receive body in the private command queue. They require
fresh201, atomic `reused:false`, the immutable148 operation UUID, matching preview,
session, return/order/scope and public original request, plus the complete captured
public snapshot, parsed core input and summary. Session secrets remain only in the
private dispatch body, never an example or a public expected snapshot. The fixture
is an explicit captured/independently checked input, not runtime readiness authority.

The partial validator checks every requested item's accepted/restocked/custody/
rejected count, cumulative integer commercial credit and shipping refund; recipe
arrivals, warehouse-policy use, stock effects, and original WMS fragment coverage
must agree with the prepared public plan. The returned RMA items, money, advanced
version and the nine actually published immutable result fields must match. The
case warehouse and requested shipping are checked against the captured case, since
they are absent from the durable operation result. Its version remains a string.
The durable PG timestamp can contain microseconds and an offset; comparison uses
the public JS millisecond projection, refusing null/invalid or different times.
Raw received timestamps are retained in the response, without rewriting evidence.
Accepted sale/custody arrivals
require a positive expected169/RMA sequence and the entire archived parsed receipt.
Reject-only is solely a148 inspection: zero accepted/credit/refund/arrival/stock
plan, rejected case and no received timestamp or RMA receipt/sequence. It is never
classified as a physical receive or assigned a fictitious169 receipt. Atomic
per-tenant effect registration covers148 operation plus accepted return/sequence
or rejected return/version, and never partially registers a refused duplicate.
The current fixture scope starts from a requested, unreceipted case; expected next
accepted sequence comes from the coordinator's genuine order-history capture.

These checks do not read current stock/journal/payment tables. A planned stock
balance is not observed physical conservation, nor does a pending commercial
credit prove an outgoing payment/refund. Financial-only partner acceptance remains
unsupported; it cannot pass through the physical receipt variant. The full return
mix, independent physical/financial reconciliation and hour remain required.

Still required for the full profile: exact recent/historical and search ratios;
reservation/status contention and all transitions; payment/document equal mix and
reconciliation; current stock versions/complete transfer reconciliation/hot-SKU mix;
complete return variant mix and independent physical/financial reconciliation; ordinary authenticated tenant verification; enough legal,
unexpired commands and live lifecycle support for the full hour; dataset,
workers, import/sync, concurrency, latency, resources, recovery and restore on one
frozen release. Prepared previews expire; repeating old keys or increasing a
synthetic queue does not satisfy these requirements. No SLO, timeout or frozen
profile was relaxed.

Focused verification uses controlled clocks/transport and owned temporary files:
`node --test tests/full-base-scale-executor.test.mjs tests/full-base-scale-http-ports.test.mjs`.
It does not perform an actual HTTP load, provider call or PostgreSQL operation.
