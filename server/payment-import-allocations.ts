import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { paymentImportHash, paymentImportAdmin } from './payment-imports';
import { recordFinancialPaymentInTx, type FinancialPaymentEntry } from './payments';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import {
  allocationPreviewInput,
  allocationExecuteInput,
  allocationOptionsQuery,
  allocationPageQuery,
  PAYMENT_IMPORT_ALLOCATION_LIMITS,
  type PaymentImportAllocationActor,
} from './payment-import-allocation-values';
export {
  allocationPreviewInput,
  allocationExecuteInput,
  allocationOptionsQuery,
  allocationPageQuery,
  PAYMENT_IMPORT_ALLOCATION_LIMITS,
} from './payment-import-allocation-values';

const tables = [
  'payment_import_allocation_sources',
  'payment_import_allocation_previews',
  'payment_import_allocation_executions',
  'payment_import_allocation_rows',
  'payment_import_allocation_admissions',
  'payment_import_allocation_witnesses',
];
const signatures = [
  'payment_allocation_installed()',
  'payment_allocation_access(uuid,uuid,boolean)',
  'payment_allocation_require(uuid,uuid,boolean)',
  'payment_allocation_locks()',
  'payment_allocation_hash(jsonb)',
  'payment_allocation_source(uuid,uuid)',
  'payment_allocation_snapshot(uuid,uuid)',
  'payment_allocation_frame(jsonb,uuid,uuid)',
  'payment_allocation_immutable()',
  'payment_allocation_budget(uuid)',
  'payment_allocation_store_preview(jsonb,uuid,uuid)',
  'payment_allocation_prepare(uuid,uuid,uuid,uuid)',
  'payment_allocation_admission_guard()',
  'payment_allocation_source_guard()',
  'payment_allocation_payment_guard()',
  'payment_allocation_witness()',
  'payment_allocation_witness_guard()',
  'payment_allocation_store_execution(jsonb,uuid,uuid)',
  'payment_allocation_canonical(jsonb)',
  'payment_allocation_request_hash(text,uuid,jsonb,uuid,uuid)',
  'payment_allocation_preview_guard()',
  'payment_allocation_execution_guard()',
  'payment_allocation_complete()',
  'payment_allocation_seal()',
];
const guards = [
  ...tables
    .filter((t) => t !== 'payment_import_allocation_admissions')
    .map((table) => ({
      table,
      name: 'payment_allocation_immutable',
      fn: 'payment_allocation_immutable()',
      deferred: false,
    })),
  ...[
    'payment_import_allocation_executions',
    'payment_import_allocation_rows',
    'payment_import_allocation_admissions',
  ].map((table) => ({
    table,
    name: 'payment_allocation_complete',
    fn: 'payment_allocation_complete()',
    deferred: true,
  })),
  ...[
    'orders',
    'payment_entries',
    'shipments',
    'return_cases',
    'source_payment_checks',
    'shipping_plans',
    'order_merge_claims',
  ].map((table) => ({
    table,
    name: 'payment_allocation_seal',
    fn: 'payment_allocation_seal()',
    deferred: false,
  })),
  {
    table: 'payment_import_allocation_admissions',
    name: 'payment_allocation_admission_guard',
    fn: 'payment_allocation_admission_guard()',
    deferred: false,
  },
  {
    table: 'payment_import_allocation_sources',
    name: 'payment_allocation_source_guard',
    fn: 'payment_allocation_source_guard()',
    deferred: false,
  },
  {
    table: 'payment_entries',
    name: 'payment_allocation_payment_guard',
    fn: 'payment_allocation_payment_guard()',
    deferred: false,
  },
  {
    table: 'payment_entries',
    name: 'payment_allocation_witness',
    fn: 'payment_allocation_witness()',
    deferred: false,
  },
  {
    table: 'payment_import_allocation_witnesses',
    name: 'payment_allocation_witness_guard',
    fn: 'payment_allocation_witness_guard()',
    deferred: false,
  },
  {
    table: 'payment_import_allocation_previews',
    name: 'payment_allocation_preview_guard',
    fn: 'payment_allocation_preview_guard()',
    deferred: false,
  },
  {
    table: 'payment_import_allocation_executions',
    name: 'payment_allocation_execution_guard',
    fn: 'payment_allocation_execution_guard()',
    deferred: false,
  },
  {
    table: 'payment_import_claims',
    name: 'claim_guard',
    fn: 'payment_import_claim_guard()',
    deferred: false,
  },
];
async function artifacts(c: Pool | PoolClient) {
  return (
    await c.query(
      `SELECT EXISTS(SELECT 1 FROM unnest($1::text[]) tab WHERE to_regclass(tab) IS NOT NULL) OR EXISTS(SELECT 1 FROM unnest($2::text[]) sig WHERE to_regprocedure(sig) IS NOT NULL) OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('payment_import_claims') AND attname='allocation_source_id' AND NOT attisdropped) present`,
      [tables, signatures],
    )
  ).rows[0].present as boolean;
}
export async function paymentImportAllocationsAvailable(c: Pool | PoolClient): Promise<boolean> {
  if (!(await artifacts(c))) {
    const role = (await c.query('SELECT current_user role')).rows[0].role;
    ensure(role !== 'dyna_app', 503, 'Moduł podziału wpłat zniknął w aktywnym kontekście');
    ensure(
      !(
        await c.query(
          "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='124_payment_import_allocations') installed",
        )
      ).rows[0].installed,
      503,
      'Moduł podziału wpłat jest niekompletny',
    );
    return false;
  }
  const ok = (
    await c.query(
      `SELECT NOT EXISTS(SELECT 1 FROM unnest($1::text[]) tab LEFT JOIN pg_class cl ON cl.oid=to_regclass(tab) WHERE cl.oid IS NULL OR NOT cl.relrowsecurity OR NOT cl.relforcerowsecurity)
  AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) sig WHERE to_regprocedure(sig) IS NULL)
  AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) g("table" text,name text,fn text,deferred boolean) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger tr WHERE tr.tgrelid=to_regclass(g."table") AND tr.tgname=g.name AND tr.tgfoid=to_regprocedure(g.fn) AND tr.tgenabled='O' AND tr.tgdeferrable=g.deferred AND tr.tginitdeferred=g.deferred))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('payment_import_claims') AND attname='allocation_source_id' AND NOT attisdropped) ok`,
      [tables, signatures, JSON.stringify(guards)],
    )
  ).rows[0].ok;
  ensure(ok, 503, 'Moduł podziału wpłat jest niekompletny');
  ensure(
    (await c.query('SELECT payment_allocation_installed() installed')).rows[0].installed,
    503,
    'Brak potwierdzonej migracji podziału wpłat',
  );
  return true;
}
async function access(c: PoolClient, a: PaymentImportAllocationActor, pin = false) {
  const g = (
    await c.query('SELECT payment_allocation_access($1,$2,$3) g', [
      a.userId,
      a.apiKeyId ?? null,
      pin,
    ])
  ).rows[0].g;
  ensure(g.key_valid, 401, 'Klucz API jest wycofany lub wygasł');
  ensure(
    g.allowed,
    403,
    'Wymagany aktualny administrator finansów i zakres orders:read/orders:write',
  );
  return g;
}
async function transact<T>(
  a: PaymentImportAllocationActor,
  run: (c: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    ensure(await paymentImportAllocationsAvailable(pool), 503, 'Kopia nie zawiera podziału wpłat');
    return await tenantTx(a.tenantId, async (c) => {
      ensure(await paymentImportAllocationsAvailable(c), 503, 'Kopia nie zawiera podziału wpłat');
      await access(c, a);
      enlistWmsActorInTx(c, a);
      return run(c);
    });
  } catch (e: any) {
    if (e instanceof Problem) throw e;
    if (e.code === '23514' && e.message === 'Klucz podziału wpłaty jest wycofany lub wygasł')
      throw new Problem(401, e.message);
    if (e.code === '23514' && e.message === 'Brak aktualnej zgody na podział wpłaty')
      throw new Problem(403, e.message);
    if (e.code === '23514' && e.message === 'Źródło nie ma poprawnych danych finansowych')
      throw new Problem(422, e.message);
    if (
      e.code === '23514' &&
      /^(Niepoprawn|Niepełn|Niekompletn|Podgląd podziału|Receipt |Źródło |Zmienił|Zmieniły|Format lub domena|Transakcja źródłowa|Cel wymaga|Wpłata |Pobranie |Rozliczenie |COD wymaga|Powtórzony cel|Podział |Nadmiar wpłat|Właściciel płatności|Admission podziału|Zatwierdzone saldo|Claim podziału|Dowód podziału|Witness wymaga)/.test(
        e.message ?? '',
      )
    )
      throw new Problem(409, e.message);
    if (e.code === 'P0001' && /^Limit /.test(e.message ?? '')) throw new Problem(409, e.message);
    if (e.code === 'P0002')
      throw new Problem(404, 'Nie znaleziono własnego źródła lub celu płatności');
    if (e.code === '23505') throw new Problem(409, 'Transakcja lub podgląd został już rozliczony');
    throw e;
  }
}
const requestHash = (
  a: PaymentImportAllocationActor,
  kind: string,
  parent: string | null,
  request: unknown,
) =>
  paymentImportHash({
    tenant_id: a.tenantId,
    actor_id: a.userId,
    api_key_id: a.apiKeyId ?? null,
    kind,
    parent_id: parent,
    request,
  });
const safePick = (r: any, keys: string[]) =>
  r == null
    ? null
    : Object.fromEntries(keys.filter((k) => Object.hasOwn(r, k)).map((k) => [k, r[k]]));
function sourceView(r: any) {
  return safePick(r, [
    'source_preview_id',
    'source_row_id',
    'source_version',
    'transaction_id',
    'ledger_kind',
    'currency',
    'gross_minor',
    'fee_minor',
    'available_minor',
    'remaining_minor',
    'remaining_amount_minor',
    'remaining_fee_minor',
    'can_allocate',
  ]);
}
function publicRows(rows: any[]) {
  return rows.map((r) => ({
    ...safePick(r, [
      'index',
      'order_id',
      'shipment_id',
      'amount_minor',
      'fee_minor',
      'after',
      'entry_id',
      'before_balance',
      'after_balance',
      'after_shipment_sums',
    ]),
    before: {
      order: safePick(r.before.order, [
        'id',
        'number',
        'version',
        'total',
        'currency',
        'payment_mode',
        'status',
        'fulfillment_kind',
      ]),
      owner: safePick(r.before.owner, [
        'id',
        'number',
        'version',
        'total',
        'currency',
        'payment_mode',
        'status',
        'fulfillment_kind',
      ]),
      balance: r.before.balance,
      shipment: safePick(r.before.shipment, [
        'id',
        'order_id',
        'carrier',
        'tracking_number',
        'dispatched_at',
        'cod_expected',
      ]),
      shipment_sums: r.before.shipment_sums,
    },
  }));
}
const flags = {
  available: true,
  read_only: false,
  current_role: 'admin',
  can_read: true,
  can_write: true,
};
async function source(c: PoolClient, pid: string, rid: string) {
  return (await c.query('SELECT payment_allocation_source($1,$2) source', [pid, rid])).rows[0]
    .source;
}
async function final(c: PoolClient, a: PaymentImportAllocationActor, payload?: any) {
  if (payload?.profile_state?.approved_by) {
    const g = (
      await c.query('SELECT payment_allocation_access($1,NULL,true) g', [
        payload.profile_state.approved_by,
      ])
    ).rows[0].g;
    ensure(g.allowed, 403, 'Zatwierdzający format utracił uprawnienia');
  }
  await access(c, a, true);
}
function head(
  r: any,
  kind: 'preview' | 'execution',
  executed: string | null = null,
  a?: PaymentImportAllocationActor,
) {
  return {
    id: r.id,
    kind,
    version: 1,
    scope_hash: r.scope_hash,
    source_preview_id: r.payload.source.source_preview_id,
    source_row_id: r.payload.source.source_row_id,
    source_version: kind === 'execution' ? r.source_version : r.payload.source.source_version,
    summary: r.payload.summary,
    created_at: r.created_at,
    ...(kind === 'preview'
      ? {
          expires_at: r.expires_at,
          can_execute:
            !executed &&
            new Date(r.expires_at).getTime() > Date.now() &&
            (!a || (r.actor_id === a.userId && r.api_key_id === (a.apiKeyId ?? null))),
          executed_execution_id: executed,
        }
      : { preview_id: r.preview_id }),
  };
}
async function previewView(c: PoolClient, a: PaymentImportAllocationActor, p: any) {
  const e = (
    await c.query('SELECT id FROM payment_import_allocation_executions WHERE preview_id=$1', [p.id])
  ).rows[0];
  const src = await source(c, p.payload.source.source_preview_id, p.payload.source.source_row_id);
  const h = head(p, 'preview', e?.id ?? null, a);
  return {
    preview: {
      ...h,
      can_execute: Boolean(
        'can_execute' in h &&
        h.can_execute &&
        src.source_version === p.payload.source.source_version &&
        src.can_allocate,
      ),
    },
    allocations: publicRows(p.payload.allocations),
    source: sourceView(src),
  };
}
async function executionView(c: PoolClient, e: any) {
  return {
    execution: head(e, 'execution'),
    allocations: publicRows(e.payload.allocations),
    source: sourceView(
      await source(c, e.payload.source.source_preview_id, e.payload.source.source_row_id),
    ),
  };
}
export async function paymentImportAllocationOptions(
  a: PaymentImportAllocationActor,
  input: unknown = {},
) {
  const q = allocationOptionsQuery.parse(input);
  if (!(await paymentImportAllocationsAvailable(pool)))
    return tenantTx(a.tenantId, async (c) => {
      await paymentImportAdmin(c, a);
      return {
        ...flags,
        available: false,
        can_write: false,
        source: null,
        limits: PAYMENT_IMPORT_ALLOCATION_LIMITS,
      };
    });
  return transact(a, async (c) => {
    const src = q.source_preview_id
      ? sourceView(await source(c, q.source_preview_id, q.source_row_id!))
      : null;
    await final(c, a);
    return { ...flags, source: src, limits: PAYMENT_IMPORT_ALLOCATION_LIMITS };
  });
}
export async function createPaymentImportAllocationPreview(
  a: PaymentImportAllocationActor,
  input: unknown,
) {
  const b = allocationPreviewInput.parse(input),
    hash = requestHash(a, 'preview', null, b);
  return transact(a, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'payment.import.admission:' + a.tenantId,
    ]);
    const old = (
      await c.query('SELECT * FROM payment_import_allocation_previews WHERE client_key=$1', [
        b.client_key,
      ])
    ).rows[0];
    if (old) {
      ensure(old.request_hash === hash, 409, 'Klucz wykorzystano z innymi danymi lub autorem');
      const v = await previewView(c, a, old);
      await final(c, a);
      return { ...flags, ...v, reused: true };
    }
    const frame = (
      await c.query('SELECT payment_allocation_frame($1,$2,$3) frame', [
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].frame;
    const p = (
      await c.query('SELECT payment_allocation_store_preview($1,$2,$3) p', [
        JSON.stringify({ id: randomUUID(), request_hash: hash, request: b, frame }),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].p;
    await audit(c, a, 'payment.allocation.preview', p.id, {
      count: b.allocations.length,
      source_preview_id: b.source_preview_id,
      source_row_id: b.source_row_id,
    });
    const v = await previewView(c, a, p);
    await final(c, a, p.payload);
    return { ...flags, ...v, reused: false };
  });
}
export async function executePaymentImportAllocation(
  a: PaymentImportAllocationActor,
  id: string,
  input: unknown,
) {
  const b = allocationExecuteInput.parse(input),
    hash = requestHash(a, 'execute', id, b);
  return transact(a, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'payment.import.admission:' + a.tenantId,
    ]);
    const old = (
      await c.query('SELECT * FROM payment_import_allocation_executions WHERE client_key=$1', [
        b.client_key,
      ])
    ).rows[0];
    if (old) {
      ensure(
        old.preview_id === id && old.request_hash === hash,
        409,
        'Klucz wykorzystano z innymi danymi lub autorem',
      );
      const v = await executionView(c, old);
      await final(c, a);
      return { ...flags, ...v, reused: true };
    }
    const p = (await c.query('SELECT * FROM payment_import_allocation_previews WHERE id=$1', [id]))
      .rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu podziału');
    ensure(p.scope_hash === b.scope_hash, 409, 'Zmieniony zakres podziału');
    ensure(
      p.actor_id === a.userId && p.api_key_id === (a.apiKeyId ?? null),
      409,
      'Podgląd należy do innego autora lub klucza',
    );
    const eid = randomUUID();
    await c.query('SELECT payment_allocation_prepare($1,$2,$3,$4)', [
      p.id,
      eid,
      a.userId,
      a.apiKeyId ?? null,
    ]);
    const n = p.payload.source.normalized,
      rows: any[] = [];
    for (const row of p.payload.allocations) {
      const entry: FinancialPaymentEntry = {
        kind: n.ledger_kind,
        amount: row.amount_minor,
        fee: row.fee_minor,
        currency: n.currency,
        method: n.method,
        reference: ('CSV ' + n.transaction_id).slice(0, 200),
        note: p.payload.request.reason,
        ...(row.shipment_id ? { shipment_id: row.shipment_id } : {}),
      };
      const result = await recordFinancialPaymentInTx(
        c,
        { ...a, role: 'admin' },
        row.order_id,
        `payment-allocation:${eid}:${row.index}`,
        { scope_hash: p.scope_hash, economic_key: p.payload.source.economic_key },
        entry,
        {
          effects: 'local_financial_only',
          provenance: {
            execution_id: eid,
            row_id: p.payload.source.source_row_id,
            preview_id: p.id,
          },
        },
      );
      rows.push({ ...row, entry_id: result.entry_id, before_balance: row.before.balance });
    }
    // Read actual owner and parcel balances only after every approved entry exists.
    for (const row of rows) {
      const snapshot = (
        await c.query('SELECT payment_allocation_snapshot($1,$2) snapshot', [
          row.order_id,
          row.shipment_id,
        ])
      ).rows[0].snapshot;
      row.after_balance = snapshot.balance;
      row.after_shipment_sums = snapshot.shipment_sums;
    }
    const e = (
      await c.query('SELECT payment_allocation_store_execution($1,$2,$3) e', [
        JSON.stringify({
          id: eid,
          preview_id: p.id,
          client_key: b.client_key,
          request: b,
          request_hash: hash,
          scope_hash: p.scope_hash,
          allocations: rows,
        }),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].e;
    await audit(c, a, 'payment.allocation.execute', e.id, {
      preview_id: p.id,
      source_id: e.source_id,
      count: rows.length,
      unallocated_minor: p.payload.summary.unallocated_minor,
      unallocated_fee_minor: p.payload.summary.unallocated_fee_minor,
    });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const v = await executionView(c, e);
    await final(c, a, p.payload);
    return { ...flags, ...v, reused: false };
  });
}
export async function paymentImportAllocationPreviewDetail(
  a: PaymentImportAllocationActor,
  id: string,
) {
  return transact(a, async (c) => {
    const p = (await c.query('SELECT * FROM payment_import_allocation_previews WHERE id=$1', [id]))
      .rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu podziału');
    const v = await previewView(c, a, p);
    await final(c, a);
    return { ...flags, ...v };
  });
}
export async function paymentImportAllocationExecutionDetail(
  a: PaymentImportAllocationActor,
  id: string,
) {
  return transact(a, async (c) => {
    const e = (
      await c.query('SELECT * FROM payment_import_allocation_executions WHERE id=$1', [id])
    ).rows[0];
    ensure(e, 404, 'Nie znaleziono wyniku podziału');
    const v = await executionView(c, e);
    await final(c, a);
    return { ...flags, ...v };
  });
}
export async function paymentImportAllocationHistory(
  a: PaymentImportAllocationActor,
  input: unknown = {},
) {
  const q = allocationPageQuery.parse(input);
  return transact(a, async (c) => {
    const table =
      q.kind === 'preview'
        ? 'payment_import_allocation_previews'
        : 'payment_import_allocation_executions';
    if (q.cursor)
      ensure(
        (await c.query(`SELECT id FROM ${table} WHERE id=$1`, [q.cursor])).rowCount,
        404,
        'Nie znaleziono kursora własnej historii',
      );
    const rows = (
      await c.query(
        `SELECT * FROM ${table} WHERE($1::uuid IS NULL OR(created_at,id)<(SELECT created_at,id FROM ${table} WHERE id=$1)) ORDER BY created_at DESC,id DESC LIMIT 51`,
        [q.cursor ?? null],
      )
    ).rows;
    const data = [];
    for (const r of rows.slice(0, 50)) {
      const executed =
        q.kind === 'preview'
          ? (
              await c.query(
                'SELECT id FROM payment_import_allocation_executions WHERE preview_id=$1',
                [r.id],
              )
            ).rows[0]?.id
          : null;
      data.push(head(r, q.kind, executed ?? null, a));
    }
    await final(c, a);
    return { ...flags, data, next_cursor: rows.length > 50 ? rows[49].id : null };
  });
}
