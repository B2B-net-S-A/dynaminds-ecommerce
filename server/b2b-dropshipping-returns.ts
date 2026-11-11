import { prepareReturnCompletionInTx, completeReturnCompletionInTx, replayReturnCompletionInTx, pinReturnCompletionInTx, type ReturnCompletion } from './return-completion';
import { randomUUID } from 'node:crypto';
import { pool } from './db';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from './domain';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { networkTx, networkPairTx, networkScope } from './b2b-network';
import { wmsLotsHash, wmsLotsPolicyInTx } from './wms-lots';
import {
  allocatedRefund,
  requestReturn,
  receiveReturn,
  receiveInput,
  decideReturn,
  getReturn,
  lockedReturn,
  applyPartnerReturnAcceptanceInTx,
} from './returns';
import * as S from './b2b-dropshipping-returns-schema';
import {
  localReturnOriginContextInTx,
  selectLocalReturnOriginInTx,
} from './b2b-return-local-origins';
export * from './b2b-dropshipping-returns-schema';
export { registerB2bDropshippingReturnRoutes } from './b2b-dropshipping-return-routes';
type Row = Record<string, any>;
type Access = Awaited<ReturnType<typeof access>>;
const hash = (a: Actor, kind: string, parent: string, body: unknown) =>
  wmsLotsHash({
    tenant_id: a.tenantId,
    actor_id: a.userId,
    api_key_id: a.apiKeyId ?? null,
    kind,
    parent,
    body,
  });
export async function b2bDropshippingReturnsAvailable(c: Pool | PoolClient) {
  return Boolean(
    (
      await c.query(`SELECT bool_and(to_regclass('public.'||n) IS NOT NULL)
    AND to_regprocedure('public.b2b_dropship_return_pair(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_acceptance(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_prepare(uuid,uuid,uuid,uuid,text,jsonb)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_apply_partner(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_finish(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_key_grant(uuid,uuid,boolean,boolean)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_value_grant(uuid,uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_events(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_retail_caps(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_capacity(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_issue_capacity()') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_bind(uuid,uuid,uuid,uuid,uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_installed()') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_write_allowed(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_return_case_state(uuid)') IS NOT NULL
    AND to_regprocedure('public.b2b_dropship_fulfillment(uuid)') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.b2b_dropship_return_previews') AND tgname='source_guard' AND NOT tgisinternal)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.wms_return_fragments') AND tgname='b2b_dropship_return_issue_capacity' AND NOT tgisinternal)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.b2b_dropship_return_cases') AND tgname='complete' AND NOT tgisinternal)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.b2b_dropship_return_actions') AND tgname='action_guard' AND NOT tgisinternal)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.b2b_dropship_return_proofs') AND tgname='proof_complete' AND NOT tgisinternal)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.stock') AND tgname='dropship_return_seal' AND NOT tgisinternal) available
    FROM unnest(ARRAY['b2b_dropship_return_settings','b2b_dropship_return_previews',
      'b2b_dropship_return_cases','b2b_dropship_return_lines','b2b_dropship_return_supplier_cases',
      'b2b_dropship_return_actions','b2b_dropship_return_proofs','b2b_dropship_return_created_cases']) n`)
    ).rows[0].available,
  );
}
async function access(c: PoolClient, a: Actor, writing = false, pin = false) {
  const role = (await c.query('SELECT b2b_dropship_current_role($1,$2) role', [a.userId, pin]))
    .rows[0].role;
  ensure(['admin', 'operator', 'viewer'].includes(role), 403, 'Brak bieżącego członkostwa');
  ensure(!writing || role === 'admin', 403, 'Koordynowany zwrot zatwierdza administrator');
  let canManage = role === 'admin',
    value = role === 'admin';
  if (a.apiKeyId) {
    const key = (
      await c.query('SELECT b2b_dropship_return_key_grant($1,$2,$3,$4) result', [
        a.userId,
        a.apiKeyId,
        writing,
        pin,
      ])
    ).rows[0].result;
    ensure(key !== 'invalid', 401, 'Klucz został cofnięty lub wygasł');
    ensure(key === 'ok', 403, 'Brak bieżących uprawnień do zwrotów dropshippingowych');
    if (!writing)
      canManage =
        canManage &&
        (
          await c.query('SELECT b2b_dropship_return_key_grant($1,$2,true,false) result', [
            a.userId,
            a.apiKeyId,
          ])
        ).rows[0].result === 'ok';
    value =
      value &&
      Boolean(
        (
          await c.query('SELECT b2b_dropship_return_value_grant($1,$2) result', [
            a.userId,
            a.apiKeyId,
          ])
        ).rows[0].result,
      );
  }
  return {
    available: true,
    read_only: false,
    current_role: role,
    can_read: true,
    can_manage: canManage,
    can_read_value: value,
  };
}
function project(v: any, value: boolean): any {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => project(x, value));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) =>
            value ||
            (!k.endsWith('_minor') &&
              ![
                'payment_balance',
                'refund_amount',
                'settlement_amount',
                'settlement',
                'requested_shipping',
                'refunded_shipping',
                'shipping_refund',
                'price',
                'line_total',
                'shipping_cost',
                'total_value',
                'unit_cost_minor',
                'value_minor',
              ].includes(k)),
        )
        .map(([k, x]) => [k, project(x, value)]),
    );
  return v;
}
async function transaction(
  a: Actor,
  write: boolean,
  fn: (c: PoolClient) => Promise<Row>,
  caseId?: string,
  beforeWriteQuota?: (c: PoolClient) => Promise<void>,
) {
  const callback = async (c: PoolClient) => {
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    ensure(
      await b2bDropshippingReturnsAvailable(c),
      503,
      'Ta kopia nie obsługuje koordynowanych zwrotów',
    );
    await access(c, a, write);
    if (write) await beforeWriteQuota?.(c);
    if (write)
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'b2b.dropship.returns:' + a.tenantId,
      ]);
    const output = await fn(c);
    await networkScope(c, a.tenantId);
    if (write) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const flags = await access(c, a, write, true);
    if (!flags.can_manage)
      for (const head of [
        output.case,
        output.preview,
        output.context,
        ...(output.data ?? []),
      ].filter(Boolean))
        for (const k of [
          'can_receive',
          'can_reject',
          'can_withdraw',
          'can_reconcile',
          'can_preview',
          'can_submit',
          'can_select_local_origin',
          'can_receive_locally',
        ])
          if (k in head) head[k] = false;
    return { ...project(output, flags.can_read_value), ...flags };
  };
  try {
    return await (caseId
      ? networkPairTx(a.tenantId, caseId, callback)
      : networkTx(a.tenantId, callback));
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === '23514' && e.message === 'Klucz został cofnięty lub wygasł')
      throw new Problem(401, e.message);
    if (e.code === '23514' && e.message === 'Brak bieżących zakresów zwrotu')
      throw new Problem(403, e.message);
    if (e.code === '23514' && e.message === 'Brak aktualnej zgody administratora')
      throw new Problem(403, e.message);
    if (e.code === '23514' && e.message?.startsWith('Powiązany zwrot'))
      throw new Problem(409, e.message);
    if (e.code === 'P0001' && e.message?.startsWith('Limit koordynowanych zwrotów'))
      throw new Problem(429, e.message);
    throw error;
  }
}
function bounded(v: unknown) {
  ensure(
    Buffer.byteLength(JSON.stringify(v)) <= S.B2B_DROPSHIP_RETURN_LIMITS.preview_bytes,
    413,
    'Za duży pełny zakres zwrotu',
  );
}
function page(rows: Row[], q: { cursor?: string; limit: number }, bind: unknown) {
  const digest = wmsLotsHash(bind);
  let index = 0;
  if (q.cursor) {
    let decoded: Row;
    try {
      decoded = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
    } catch {
      throw new Problem(422, 'Nieprawidłowy kursor');
    }
    ensure(
      decoded.hash === digest &&
        Number.isInteger(decoded.index) &&
        decoded.index >= 0 &&
        decoded.index <= rows.length,
      409,
      'Kursor dotyczy innego zakresu',
    );
    index = decoded.index;
  }
  const data = rows.slice(index, index + q.limit),
    next = index + data.length;
  return {
    data,
    meta: {
      total: rows.length,
      cursor:
        next < rows.length
          ? Buffer.from(JSON.stringify({ hash: digest, index: next })).toString('base64url')
          : null,
    },
  };
}
async function ownReturn(c: PoolClient, id: string, lock = false) {
  if (lock) return (await lockedReturn(c, id)).r;
  const r = (await c.query('SELECT * FROM return_cases WHERE id=$1', [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono własnego RMA');
  return r;
}
async function caseRecord(c: PoolClient, id: string) {
  const buyer = (await c.query('SELECT * FROM b2b_dropship_return_cases WHERE id=$1', [id]))
    .rows[0];
  if (buyer) return { ...buyer, side: 'buyer' };
  const supplier = (
    await c.query('SELECT * FROM b2b_dropship_return_supplier_cases WHERE case_id=$1', [id])
  ).rows[0];
  ensure(supplier, 404, 'Nie znaleziono własnego powiązanego zwrotu');
  return { ...supplier.snapshot, id, side: 'supplier', snapshot: supplier.snapshot };
}
async function state(c: PoolClient, id: string) {
  const r = (await c.query('SELECT b2b_dropship_return_case_state($1) result', [id])).rows[0]
    .result;
  ensure(r, 404, 'Nie znaleziono sprawy');
  return r;
}
async function caseView(c: PoolClient, h: Row, a: Actor) {
  const current = await state(c, h.id),
    flags = await access(c, a),
    s = h.snapshot;
  const activeScopeReady =
    h.side === 'buyer' &&
    !(
      await c.query(
        "SELECT h.id FROM b2b_dropship_return_cases h WHERE h.return_id=$1 AND coalesce(b2b_dropship_return_case_state(h.id)->>'state','requested') NOT IN('withdrawn','received','rejected') LIMIT 1",
        [h.return_id ?? s.buyer_return_id],
      )
    ).rowCount;
  return {
    ...s.public,
    id: h.id,
    preview_id: h.preview_id ?? s.preview_id,
    dropship_order_id: h.dropship_order_id ?? s.dropship_order_id,
    buyer_return_id: h.return_id ?? s.buyer_return_id,
    buyer_order_id: h.order_id ?? s.buyer_order_id,
    supplier_return_id: h.supplier_return_id ?? s.supplier_return_id,
    side: h.side,
    created_at: h.created_at ?? s.created_at,
    ...current,
    can_withdraw: flags.can_manage && h.side === 'buyer' && current.state === 'requested',
    can_receive: flags.can_manage && h.side === 'supplier' && current.state === 'requested',
    can_reject: flags.can_manage && h.side === 'supplier' && current.state === 'requested',
    can_reconcile:
      flags.can_manage &&
      h.side === 'buyer' &&
      activeScopeReady &&
      ['received', 'rejected'].includes(current.state) &&
      !current.retail_reconciled_at,
  };
}
async function prior(c: PoolClient, a: Actor, kind: string, parent: string, input: Row) {
  const action = (
    await c.query('SELECT * FROM b2b_dropship_return_actions WHERE client_key=$1', [
      input.client_key,
    ])
  ).rows[0];
  if (action)
    ensure(
      action.request_hash === hash(a, kind, parent, input),
      409,
      'Klucz próby należy do innej treści lub aktora',
    );
  return action;
}
async function action(
  c: PoolClient,
  a: Actor,
  kind: string,
  parent: string,
  input: Row,
  result: Row,
  id = randomUUID(),
  caseId: string | null = null,
  returnId: string | null = null,
  previewId: string | null = null,
) {
  await networkScope(c, a.tenantId);
  await c.query(
    'INSERT INTO b2b_dropship_return_actions(id,tenant_id,actor_id,api_key_id,client_key,kind,case_id,preview_id,return_id,request_hash,request,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      id,
      a.tenantId,
      a.userId,
      a.apiKeyId ?? null,
      input.client_key,
      kind,
      caseId,
      previewId,
      returnId,
      hash(a, kind, parent, input),
      input,
      result,
    ],
  );
  await audit(c, a, 'b2b.dropship.return.' + kind, caseId ?? returnId ?? parent, {
    action_id: id,
    ...result,
  });
}
export async function b2bDropshipReturnOptions(a: Actor) {
  const legacy = await olderCopy(a, undefined, true);
  if (legacy) return legacy;
  return transaction(a, false, async (c) => ({
    limits: S.B2B_DROPSHIP_RETURN_LIMITS,
    warehouses: {
      data: (await c.query('SELECT id,name,code FROM warehouses ORDER BY id LIMIT 201')).rows.slice(
        0,
        200,
      ),
      capped: (await c.query('SELECT count(*)::int n FROM warehouses')).rows[0].n > 200,
    },
  }));
}
export async function b2bDropshipReturnSettings(a: Actor, accountId: string) {
  return transaction(a, false, async (c) => {
    ensure(
      (await c.query('SELECT id FROM b2b_accounts WHERE id=$1', [accountId])).rowCount,
      404,
      'Nie znaleziono własnego kontrahenta',
    );
    const s = (
      await c.query('SELECT * FROM b2b_dropship_return_settings WHERE account_id=$1', [accountId])
    ).rows[0];
    const warehouses = (await c.query('SELECT id,name,code FROM warehouses ORDER BY id LIMIT 201'))
      .rows;
    return {
      settings: s
        ? {
            version: s.version,
            enabled: s.enabled,
            warehouse_id: s.warehouse_id,
            return_address: s.return_address,
          }
        : { version: 0, enabled: false, warehouse_id: null, return_address: null },
      warehouses: { data: warehouses.slice(0, 200), capped: warehouses.length > 200 },
    };
  });
}
export async function updateB2bDropshipReturnSettings(a: Actor, accountId: string, raw: unknown) {
  const input = S.b2bDropshipReturnSettingsInput.parse(raw);
  return transaction(a, true, async (c) => {
    const old = await prior(c, a, 'settings', accountId, input);
    if (old) return { ...old.result, reused: true };
    ensure(
      (await c.query('SELECT id FROM b2b_accounts WHERE id=$1 FOR UPDATE', [accountId])).rowCount,
      404,
      'Nie znaleziono kontrahenta',
    );
    ensure(
      (await c.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouse_id])).rowCount,
      404,
      'Nie znaleziono własnego magazynu',
    );
    const current = (
      await c.query('SELECT * FROM b2b_dropship_return_settings WHERE account_id=$1', [accountId])
    ).rows[0];
    ensure((current?.version ?? 0) === input.version, 409, 'Ustawienia zmieniły wersję');
    const settings = {
      version: input.version + 1,
      enabled: input.enabled,
      warehouse_id: input.warehouse_id,
      return_address: input.return_address,
    };
    await c.query(
      'INSERT INTO b2b_dropship_return_settings(tenant_id,account_id,version,enabled,warehouse_id,return_address) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,account_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,warehouse_id=excluded.warehouse_id,return_address=excluded.return_address',
      [
        a.tenantId,
        accountId,
        settings.version,
        settings.enabled,
        settings.warehouse_id,
        settings.return_address,
      ],
    );
    await action(c, a, 'settings', accountId, input, { settings });
    return { settings, reused: false };
  });
}

async function frame(c: PoolClient, a: Actor, rid: string, lock = false) {
  await ownReturn(c, rid, lock);
  const r = (await c.query('SELECT to_jsonb(r) row FROM return_cases r WHERE id=$1', [rid])).rows[0]
    .row;
  const o = (await c.query('SELECT to_jsonb(o) row FROM orders o WHERE id=$1', [r.order_id]))
    .rows[0]?.row;
  ensure(o, 404, 'Nie znaleziono zamówienia');
  const retail = (
    await c.query(
      'SELECT to_jsonb(ri) row,to_jsonb(oi) commercial FROM return_items ri JOIN order_items oi ON(oi.tenant_id,oi.order_id,oi.id)=(ri.tenant_id,ri.order_id,ri.item_id) WHERE ri.return_id=$1 ORDER BY ri.item_id',
      [rid],
    )
  ).rows;
  ensure(retail.length <= 100, 413, 'Za dużo pozycji detalicznego RMA');
  for (const item of retail)
    item.prior_accepted = Number(
      (
        await c.query(
          "SELECT coalesce(sum(i.accepted),0)::int n FROM return_items i JOIN return_cases r ON(r.tenant_id,r.id)=(i.tenant_id,i.return_id) WHERE i.order_id=$1 AND i.item_id=$2 AND r.state IN('refund_pending','closed')",
          [r.order_id, item.row.item_id],
        )
      ).rows[0].n,
    );
  const drops = (
    await c.query(
      `SELECT to_jsonb(d) row,q.snapshot FROM b2b_dropship_orders d JOIN b2b_dropship_quotes q ON(q.tenant_id,q.id)=(d.tenant_id,d.quote_id) WHERE d.customer_order_id=$1 AND d.state='ordered' ORDER BY d.id LIMIT 101`,
      [r.order_id],
    )
  ).rows;
  ensure(drops.length <= 100, 413, 'Za dużo zewnętrznych dostaw');
  const dispatched = (await c.query('SELECT b2b_dropship_fulfillment($1) result', [r.order_id]))
    .rows[0].result;
  const sources: Row[] = [],
    groups: Row[] = [];
  for (const d of drops) {
    const drop = d.row;
    if (!dispatched.some((x: Row) => x.id === drop.id && x.dispatched)) continue;
    const link = (
      await c.query('SELECT to_jsonb(l) row FROM b2b_links l WHERE id=$1', [drop.link_id])
    ).rows[0]?.row;
    ensure(link, 503, 'Brakuje pierwotnego powiązania kontrahenta');
    const selected = d.snapshot.items.filter((i: Row) =>
      retail.some((x) => x.row.item_id === i.customer_item_id),
    );
    if (!selected.length) continue;
    const used = (
      await c.query(
        `SELECT li.customer_item_id,coalesce(sum(li.quantity),0)::int quantity FROM b2b_dropship_return_lines li JOIN b2b_dropship_return_cases h ON(h.tenant_id,h.id)=(li.tenant_id,li.case_id) WHERE h.dropship_order_id=$1 AND (b2b_dropship_return_case_state(h.id)->>'state') IS DISTINCT FROM 'withdrawn' AND (b2b_dropship_return_case_state(h.id)->>'state') IS DISTINCT FROM 'rejected' GROUP BY li.customer_item_id`,
        [drop.id],
      )
    ).rows;
    await networkScope(c, drop.supplier_tenant_id);
    const supplier = (
      await c.query(
        'SELECT to_jsonb(o) row FROM orders o WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
        [drop.supplier_order_id],
      )
    ).rows[0]?.row;
    ensure(supplier, 404, 'Brakuje pierwotnego zamówienia dostawcy');
    const account = (
      await c.query(
        'SELECT to_jsonb(a) row FROM b2b_accounts a WHERE id=$1' + (lock ? ' FOR SHARE' : ''),
        [link.account_id],
      )
    ).rows[0]?.row;
    const settings = (
      await c.query(
        'SELECT to_jsonb(s) row FROM b2b_dropship_return_settings s WHERE account_id=$1' +
          (lock ? ' FOR SHARE' : ''),
        [link.account_id],
      )
    ).rows[0]?.row;
    const supplierItems = (
      await c.query('SELECT to_jsonb(i) row FROM order_items i WHERE order_id=$1 ORDER BY id', [
        supplier.id,
      ])
    ).rows.map((x) => x.row);
    ensure(supplierItems.length <= 100, 413, 'Za dużo pozycji dostawcy');
    const receipts = (
      await c.query('SELECT to_jsonb(r) row FROM return_cases r WHERE order_id=$1 ORDER BY id', [
        supplier.id,
      ])
    ).rows.map((x) => x.row);
    const receiptItems = (
      await c.query(
        'SELECT to_jsonb(i) row FROM return_items i WHERE order_id=$1 ORDER BY return_id,item_id',
        [supplier.id],
      )
    ).rows.map((x) => x.row);
    const manifests = (
      await c.query(
        `SELECT e.shipment_id,e.items FROM shopify_dispatch_evidence e JOIN shipments sh ON(sh.tenant_id,sh.id,sh.order_id)=(e.tenant_id,e.shipment_id,e.order_id) JOIN b2b_dropship_supplier_orders b ON(b.tenant_id,b.order_id)=(e.tenant_id,e.order_id) WHERE e.order_id=$1 AND sh.dispatched_at IS NOT NULL AND e.receiver=b.receiver ORDER BY e.shipment_id LIMIT 1001`,
        [supplier.id],
      )
    ).rows;
    const issues = (
      await c.query(
        `SELECT f.id,f.product_id,f.quantity,(SELECT coalesce(sum(quantity),0)::int FROM wms_return_fragments x WHERE(x.tenant_id,x.issue_fragment_id)=(f.tenant_id,f.id)) returned FROM wms_issue_fragments f WHERE f.order_id=$1 ORDER BY f.id LIMIT 1001`,
        [supplier.id],
      )
    ).rows;
    ensure(
      manifests.length <= 1000 &&
        issues.length <= 1000 &&
        receiptItems.length <= 10000 &&
        receipts.length <= 2000,
      413,
      'Za dużo fragmentów fizycznego wydania',
    );
    ensure(
      manifests.length === 1,
      409,
      'Historyczne wielopaczkowe wydanie wymaga jednoznacznego przypisania fragmentów',
    );
    const wms = await wmsLotsPolicyInTx(c);
    for (const selectedItem of selected) {
      const requested = retail.find((x) => x.row.item_id === selectedItem.customer_item_id)!;
      const physical: Row[] = [];
      const mappings = d.snapshot.mapping_snapshot.filter(
        (m: Row) => m.customer_item_id === selectedItem.customer_item_id,
      );
      ensure(mappings.length > 0, 409, 'Brakuje pierwotnego fizycznego przypisania');
      for (const mapping of mappings) {
        const matching = supplierItems.filter(
          (i) => i.product_id === mapping.catalog_item.source_product_id,
        );
        ensure(
          matching.length === 1,
          409,
          'Historyczne wydanie wymaga jednoznacznej oryginalnej pozycji dostawcy',
        );
        const si = matching[0],
          per = Number(mapping.labels.quantity);
        const committed = receiptItems
          .filter(
            (i) =>
              i.item_id === si.id &&
              receipts.some(
                (rc) =>
                  rc.id === i.return_id &&
                  ['requested', 'refund_pending', 'closed'].includes(rc.state),
              ),
          )
          .reduce(
            (n, i) =>
              n +
              (receipts.find((rc) => rc.id === i.return_id)?.state === 'requested'
                ? i.requested
                : i.accepted),
            0,
          );
        for (const manifest of manifests) {
          const line = manifest.items.find((i: Row) => i.id === si.id);
          if (!line) continue;
          const remaining = Math.max(0, Math.min(line.quantity, si.quantity) - committed);
          const base = {
            supplier_item_id: si.id,
            product_id: si.product_id,
            sku: si.sku,
            name: si.name,
            shipment_id: manifest.shipment_id,
            quantity_per_unit: per,
            quantity_available: remaining,
          };
          if (issues.length) {
            for (const issue of issues.filter((i) => i.product_id === si.product_id))
              physical.push({
                ...base,
                issue_fragment_id: issue.id,
                quantity_available: Math.min(remaining, issue.quantity - issue.returned),
              });
          } else physical.push(base);
        }
      }
      sources.push({
        customer_item_id: selectedItem.customer_item_id,
        dropship_order_id: drop.id,
        sku: requested.commercial.sku,
        name: requested.commercial.name,
        requested: requested.row.requested,
        quantity_available: Math.max(
          0,
          Math.min(
            selectedItem.quantity -
              (used.find((u) => u.customer_item_id === selectedItem.customer_item_id)?.quantity ??
                0),
            ...mappings.map((m: Row) =>
              Math.floor(
                physical
                  .filter((p) => p.product_id === m.catalog_item.source_product_id)
                  .reduce((n, p) => n + p.quantity_available, 0) / m.labels.quantity,
              ),
            ),
          ),
        ),
        supplier_name: link.supplier_name ?? 'Dostawca',
        supplier_order_number: supplier.number,
        supplier_order_id: supplier.id,
        supplier_tenant_id: drop.supplier_tenant_id,
        link_id: drop.link_id,
        retail_currency: o.currency,
        retail_line_total_minor: String(requested.commercial.line_total),
        wholesale_currency: supplier.currency,
        physical_sources: physical,
        return_address: settings?.return_address ?? null,
        enabled: Boolean(settings?.enabled && account?.active && !link.paused),
      });
    }
    groups.push({
      dropship_order_id: drop.id,
      supplier_tenant_id: drop.supplier_tenant_id,
      supplier_order_id: supplier.id,
      supplier_order_number: supplier.number,
      supplier_name: link.supplier_name ?? 'Dostawca',
      link_id: drop.link_id,
      account,
      settings,
      supplier,
      supplier_items: supplierItems,
      receipts,
      receipt_items: receiptItems,
      manifests,
      issues,
      wms_lots_enabled: wms.enabled,
      drop,
      quote_snapshot: d.snapshot,
    });
    await networkScope(c, a.tenantId);
  }
  const snapshot = { rma: { head: r, items: retail }, order: o, sources, groups };
  bounded(snapshot);
  return snapshot;
}

export async function b2bDropshipReturnSources(a: Actor, id: string, raw: unknown) {
  const q = S.b2bDropshipReturnPageQuery.parse(raw);
  return transaction(a, false, async (c) => {
    const f = await frame(c, a, id);
    return page(f.sources, q, { tenant: a.tenantId, return: id, hash: wmsLotsHash(f) });
  });
}
function frozenRows(f: Row, input: ReturnType<typeof S.b2bDropshipReturnPreviewInput.parse>) {
  ensure(
    f.rma.head.state === 'requested' && !f.rma.head.receipt,
    409,
    'RMA zostało już rozpatrzone',
  );
  for (const item of f.rma.items)
    ensure(
      input.items
        .filter((i) => i.customer_item_id === item.row.item_id)
        .reduce((n, i) => n + i.quantity, 0) === item.row.requested,
      422,
      'Przekaż pełny zakres detalicznego RMA; lokalną część zgłoś osobno',
    );
  ensure(
    input.items.every((i) => f.rma.items.some((r: Row) => r.row.item_id === i.customer_item_id)),
    422,
    'Obca pozycja RMA',
  );
  return input.items.map((item, index) => {
    const source = f.sources.find(
      (x: Row) =>
        x.customer_item_id === item.customer_item_id &&
        x.dropship_order_id === item.dropship_order_id,
    );
    ensure(source?.enabled, 409, 'Dostawca nie przyjmuje nowych przekazań');
    ensure(
      item.quantity <= source.quantity_available,
      409,
      'Przekroczono wydany lub wolny zakres pozycji',
    );
    const keys = item.physical_sources.map((p) =>
      [p.supplier_item_id, p.shipment_id, p.issue_fragment_id ?? ''].join(':'),
    );
    ensure(new Set(keys).size === keys.length, 422, 'Powtórzony fragment wydania');
    const physical = item.physical_sources.map((p) => {
      const match = source.physical_sources.find(
        (s: Row) =>
          s.supplier_item_id === p.supplier_item_id &&
          s.shipment_id === p.shipment_id &&
          s.issue_fragment_id === p.issue_fragment_id,
      );
      ensure(
        match && p.quantity <= match.quantity_available,
        409,
        'Fragment nie należy do wolnego wydania',
      );
      return { ...match, quantity: p.quantity };
    });
    for (const product of new Set<string>(source.physical_sources.map((s: Row) => s.product_id))) {
      const picks = physical.filter((p) => p.product_id === product),
        per = source.physical_sources.find((p: Row) => p.product_id === product).quantity_per_unit;
      ensure(
        picks.reduce((n, p) => n + p.quantity, 0) === item.quantity * per,
        422,
        'Pokryj dokładnie każdy fizyczny składnik',
      );
    }
    const retail = f.rma.items.find((x: Row) => x.row.item_id === item.customer_item_id),
      original = retail.commercial;
    const prior =
      retail.prior_accepted +
      input.items
        .slice(0, index)
        .filter((i) => i.customer_item_id === item.customer_item_id)
        .reduce((n, i) => n + i.quantity, 0);
    const group = f.groups.find((g: Row) => g.dropship_order_id === item.dropship_order_id);
    let wholesale = 0;
    for (const product of new Set<string>(physical.map((p) => p.product_id))) {
      const picks = physical.filter((p) => p.product_id === product),
        si = group.supplier_items.find((i: Row) => i.id === picks[0].supplier_item_id);
      const priorQuantity = group.receipt_items
        .filter(
          (i: Row) =>
            i.item_id === si.id &&
            group.receipts.some(
              (r: Row) => r.id === i.return_id && ['refund_pending', 'closed'].includes(r.state),
            ),
        )
        .reduce((n: number, i: Row) => n + i.accepted, 0);
      const previous = input.items
        .slice(0, index)
        .filter((i) => i.dropship_order_id === item.dropship_order_id)
        .flatMap((i) => i.physical_sources)
        .filter((p) => p.supplier_item_id === si.id)
        .reduce((n, p) => n + p.quantity, 0);
      wholesale += allocatedRefund(
        si.line_total,
        si.quantity,
        priorQuantity + previous,
        picks.reduce((n, p) => n + p.quantity, 0),
      );
    }
    return {
      ...source,
      index,
      quantity: item.quantity,
      physical_sources: physical,
      retail_refund_minor: String(
        allocatedRefund(original.line_total, original.quantity, prior, item.quantity),
      ),
      wholesale_refund_minor: String(wholesale),
    };
  });
}
async function previewView(c: PoolClient, p: Row, a: Actor) {
  const ids = (
    await c.query('SELECT id FROM b2b_dropship_return_cases WHERE preview_id=$1 ORDER BY id', [
      p.id,
    ])
  ).rows.map((r) => r.id);
  const flags = await access(c, a);
  const local = await localReturnOriginContextInTx(c, a, p.return_id);
  return {
    id: p.id,
    version: 1,
    return_id: p.return_id,
    order_id: p.order_id,
    scope_hash: p.scope_hash,
    total: p.snapshot.rows.length,
    group_count: p.snapshot.groups.length,
    created_at: p.created_at,
    expires_at: p.expires_at,
    executed_case_ids: ids,
    can_submit:
      flags.can_manage &&
      !local.local_origin &&
      !ids.length &&
      new Date(p.expires_at).valueOf() > Date.now(),
    groups: p.snapshot.groups.map((g: Row) => ({
      dropship_order_id: g.dropship_order_id,
      supplier_order_id: g.supplier_order_id,
      supplier_order_number: g.supplier_order_number,
      supplier_name: g.supplier_name,
      return_address: g.settings.return_address,
      supplier_shipping_refund_minor: String(g.shipping_refund),
      wholesale_currency: g.supplier.currency,
    })),
  };
}
export async function createB2bDropshipReturnPreview(a: Actor, id: string, raw: unknown) {
  const input = S.b2bDropshipReturnPreviewInput.parse(raw);
  return transaction(a, true, async (c) => {
    const requestHash = hash(a, 'preview', id, input),
      old = (
        await c.query('SELECT * FROM b2b_dropship_return_previews WHERE client_key=$1', [
          input.client_key,
        ])
      ).rows[0];
    if (old) {
      ensure(old.request_hash === requestHash, 409, 'Klucz należy do innej treści lub aktora');
      return { preview: await previewView(c, old, a), reused: true };
    }
    const f = await frame(c, a, id, true);
    const local = await localReturnOriginContextInTx(c, a, id);
    ensure(!local.local_origin, 409, 'RMA ma już zatwierdzone lokalne pochodzenie');
    ensure(Number(f.rma.head.version) === input.version, 409, 'RMA zmieniło wersję');
    const rows = frozenRows(f, input),
      dropIds = new Set(rows.map((r) => r.dropship_order_id));
    const groups: Row[] = f.groups
      .filter((g: Row) => dropIds.has(g.dropship_order_id))
      .map((g: Row) => ({
        ...g,
        shipping_refund:
          input.supplier_shipping_refunds.find((x) => x.dropship_order_id === g.dropship_order_id)
            ?.amount_minor ?? 0,
      }));
    for (const group of groups) {
      const used = group.receipts.reduce(
        (n: number, r: Row) =>
          n +
          (r.state === 'requested'
            ? r.requested_shipping
            : ['refund_pending', 'closed'].includes(r.state)
              ? r.refunded_shipping
              : 0),
        0,
      );
      ensure(
        group.shipping_refund <= group.supplier.shipping_cost - used,
        422,
        'Zwrot dostawy dostawcy przekracza dostępny historyczny koszt',
      );
    }
    ensure(
      input.supplier_shipping_refunds.every((x) => dropIds.has(x.dropship_order_id)),
      422,
      'Zwrot dostawy nie należy do przekazania',
    );
    for (const group of groups)
      ensure(
        new Set(
          rows
            .filter((r: Row) => r.dropship_order_id === group.dropship_order_id)
            .flatMap((r: Row) => r.physical_sources.map((p: Row) => p.supplier_item_id)),
        ).size <= 100,
        422,
        'Jedno RMA dostawcy obejmuje najwyżej 100 pozycji fizycznych',
      );
    const snapshot = { ...f, rows, groups };
    bounded(snapshot);
    const p = (
      await c.query(
        `INSERT INTO b2b_dropship_return_previews(id,tenant_id,return_id,order_id,actor_id,api_key_id,client_key,request_hash,request,snapshot,scope_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+interval '15 minutes') RETURNING *`,
        [
          randomUUID(),
          a.tenantId,
          id,
          f.order.id,
          a.userId,
          a.apiKeyId ?? null,
          input.client_key,
          requestHash,
          input,
          snapshot,
          wmsLotsHash(snapshot),
        ],
      )
    ).rows[0];
    return { preview: await previewView(c, p, a), reused: false };
  });
}
export async function b2bDropshipReturnPreview(a: Actor, id: string) {
  return transaction(a, false, async (c) => {
    const p = (await c.query('SELECT * FROM b2b_dropship_return_previews WHERE id=$1', [id]))
      .rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu');
    return { preview: await previewView(c, p, a) };
  });
}
export async function b2bDropshipReturnPreviewRows(a: Actor, id: string, raw: unknown) {
  const q = S.b2bDropshipReturnPageQuery.parse(raw);
  return transaction(a, false, async (c) => {
    const p = (await c.query('SELECT * FROM b2b_dropship_return_previews WHERE id=$1', [id]))
      .rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu');
    return page(p.snapshot.rows.map(publicRow), q, {
      tenant: a.tenantId,
      preview: id,
      scope: p.scope_hash,
    });
  });
}

export async function submitB2bDropshipReturn(a: Actor, id: string, raw: unknown) {
  const input = S.b2bDropshipReturnSubmitInput.parse(raw);
  return transaction(a, true, async (c) => {
    const old = await prior(c, a, 'submit', id, input);
    if (old) {
      const cases = [];
      for (const cid of old.result.case_ids)
        cases.push(await caseView(c, await caseRecord(c, cid), a));
      return { cases, reused: true };
    }
    const p = (await c.query('SELECT * FROM b2b_dropship_return_previews WHERE id=$1', [id]))
      .rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu');
    ensure(
      p.actor_id === a.userId && p.api_key_id === (a.apiKeyId ?? null),
      403,
      'Podgląd zatwierdza jego autor',
    );
    ensure(
      p.scope_hash === input.scope_hash && new Date(p.expires_at).valueOf() > Date.now(),
      409,
      'Podgląd wygasł lub zmienił zakres',
    );
    ensure(
      !(
        await c.query(
          "SELECT h.id FROM b2b_dropship_return_cases h WHERE h.return_id=$1 AND (b2b_dropship_return_case_state(h.id)->>'state') IS DISTINCT FROM 'withdrawn' AND (b2b_dropship_return_case_state(h.id)->>'state') IS DISTINCT FROM 'rejected'",
          [p.return_id],
        )
      ).rowCount,
      409,
      'Ten zakres RMA został już przekazany',
    );
    const f = await frame(c, a, p.return_id, true);
    const local = await localReturnOriginContextInTx(c, a, p.return_id);
    ensure(!local.local_origin, 409, 'RMA ma już zatwierdzone lokalne pochodzenie');
    const rows = frozenRows(f, p.request);
    const groups: Row[] = f.groups
      .filter((g: Row) =>
        p.snapshot.groups.some((x: Row) => x.dropship_order_id === g.dropship_order_id),
      )
      .map((g: Row) => ({
        ...g,
        shipping_refund:
          p.request.supplier_shipping_refunds.find(
            (x: Row) => x.dropship_order_id === g.dropship_order_id,
          )?.amount_minor ?? 0,
      }));
    ensure(
      wmsLotsHash({ ...f, rows, groups }) === p.scope_hash,
      409,
      'Zmieniło się RMA, wydanie, przyjęcia lub polityka dostawcy',
    );
    const ids: string[] = [];
    for (const group of groups) {
      const physical = new Map<string, number>();
      for (const row of rows.filter((x: Row) => x.dropship_order_id === group.dropship_order_id))
        for (const part of row.physical_sources)
          physical.set(
            part.supplier_item_id,
            (physical.get(part.supplier_item_id) ?? 0) + part.quantity,
          );
      await networkScope(c, group.supplier_tenant_id);
      const supplierActor = { ...a, tenantId: group.supplier_tenant_id };
      const r = await requestReturn(
        c,
        supplierActor,
        group.supplier_order_id,
        {
          client_key: randomUUID(),
          kind: 'return',
          reason: 'Zwrot klienta przez własną sieć B2B',
          warehouse_id: group.settings.warehouse_id,
          shipping_refund: group.shipping_refund,
          items: [...physical].map(([item_id, quantity]) => ({ item_id, quantity })),
        },
        false,
        'buyer',
      );
      await networkScope(c, a.tenantId);
      const cid = randomUUID();
      await c.query('SELECT b2b_dropship_return_bind($1,$2,$3,$4,$5)', [
        p.id,
        cid,
        r.id,
        a.userId,
        a.apiKeyId ?? null,
      ]);
      ids.push(cid);
    }
    await action(c, a, 'submit', id, input, { case_ids: ids }, undefined, null, p.return_id, p.id);
    const cases = [];
    for (const cid of ids) cases.push(await caseView(c, await caseRecord(c, cid), a));
    return { cases, reused: false };
  });
}

export async function b2bDropshipReturnCase(a: Actor, id: string) {
  return transaction(
    a,
    false,
    async (c) => ({ case: await caseView(c, await caseRecord(c, id), a) }),
    id,
  );
}
export async function b2bDropshipReturnCases(a: Actor, raw: unknown) {
  const q = S.b2bDropshipReturnHistoryQuery.parse(raw);
  return transaction(a, false, async (c) => {
    const buyer = (
      await c.query(
        'SELECT id,return_id FROM b2b_dropship_return_cases ORDER BY created_at DESC,id DESC LIMIT 2001',
      )
    ).rows;
    const supplier = (
      await c.query(
        'SELECT case_id id,return_id FROM b2b_dropship_return_supplier_cases ORDER BY created_at DESC,case_id DESC LIMIT 2001',
      )
    ).rows;
    const refs = [
      ...(q.side === 'supplier' ? [] : buyer),
      ...(q.side === 'buyer' ? [] : supplier),
    ].filter((r) => !q.return_id || r.return_id === q.return_id);
    ensure(refs.length <= 2000, 413, 'Za duża historia zwrotów');
    const data = [];
    for (const r of refs) data.push(await caseView(c, await caseRecord(c, r.id), a));
    return page(data, q, {
      tenant: a.tenantId,
      side: q.side ?? null,
      return_id: q.return_id ?? null,
    });
  });
}
export async function b2bDropshipReturnCaseRows(a: Actor, id: string, raw: unknown) {
  const q = S.b2bDropshipReturnPageQuery.parse(raw);
  return transaction(
    a,
    false,
    async (c) => {
      const h = await caseRecord(c, id);
      return page(h.snapshot.rows.map(publicRow), q, {
        tenant: a.tenantId,
        case: id,
        rows: wmsLotsHash(h.snapshot.rows),
      });
    },
    id,
  );
}
export async function b2bDropshipReturnCaseEvents(a: Actor, id: string, raw: unknown) {
  const q = S.b2bDropshipReturnPageQuery.parse(raw);
  return transaction(
    a,
    false,
    async (c) => {
      await caseRecord(c, id);
      const data = (await c.query('SELECT b2b_dropship_return_events($1) result', [id])).rows[0]
        .result;
      return page(data, q, { tenant: a.tenantId, case: id, events: wmsLotsHash(data) });
    },
    id,
  );
}

async function mutateCase(
  a: Actor,
  id: string,
  input: Row,
  kind: 'receive' | 'reject' | 'withdraw',
) {
  let completion: ReturnCompletion | undefined;
  let physicalReceipt: ReturnType<typeof receiveInput.parse> | undefined;
  let completionActor: Actor | undefined;
  return transaction(
    a,
    true,
    async (c) => {
      const previous = await prior(c, a, kind, id, input);
      if (previous) {
        if (completion && completionActor) await replayReturnCompletionInTx(c, completionActor, completion);
        const result = { case: await caseView(c, await caseRecord(c, id), a), reused: true };
        if (completion && completionActor) await pinReturnCompletionInTx(c, completionActor, completion);
        return result;
      }
      const h = await caseRecord(c, id),
        current = await state(c, id);
      ensure(
        h.side === (kind === 'withdraw' ? 'buyer' : 'supplier'),
        403,
        'Niewłaściwa strona zwrotu',
      );
      ensure(
        current.state === 'requested' && current.version === input.version,
        409,
        'Sprawa zmieniła się; odczytaj aktualną wersję',
      );
      if (kind !== 'withdraw')
        ensure(
          Number(current.supplier_return_version) === input.supplier_return_version,
          409,
          'RMA dostawcy zmieniło wersję',
        );
      const aid = randomUUID(),
        pid = (
          await c.query('SELECT b2b_dropship_return_prepare($1,$2,$3,$4,$5,$6) id', [
            id,
            aid,
            a.userId,
            a.apiKeyId ?? null,
            kind,
            input,
          ])
        ).rows[0].id;
      const supplier = h.snapshot.supplier_tenant_id,
        rid = h.snapshot.supplier_return_id;
      await networkScope(c, supplier);
      // Withdraw is admitted by the buyer's frozen binding; no supplier-role impersonation.
      const coreActor = { ...a, tenantId: supplier };
      if (kind === 'receive') {
        ensure(completion && physicalReceipt && completionActor && completionActor.tenantId === supplier,
          409, 'Brak dopuszczenia rzeczywistego przyjęcia dostawcy');
        await receiveReturn(c, coreActor, rid, physicalReceipt, false, { completion });
      }
      else
        await decideReturn(c, coreActor, rid, {
          version: Number(current.supplier_return_version),
          decision: kind === 'reject' ? 'reject' : 'cancel',
          note: kind === 'withdraw' ? input.reason : input.note,
        });
      await c.query('SELECT b2b_dropship_return_finish($1)', [pid]);
      await networkScope(c, a.tenantId);
      await action(c, a, kind, id, input, { case_id: id }, aid, id, h.snapshot.buyer_return_id);
      if (completion && completionActor) {
        await networkScope(c, completionActor.tenantId);
        await completeReturnCompletionInTx(c, completionActor, completion, { dropship_admission_id: pid });
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        await networkScope(c, a.tenantId);
      }
      const result = { case: await caseView(c, await caseRecord(c, id), a), reused: false };
      if (completion && completionActor) {
        await networkScope(c, completionActor.tenantId);
        await pinReturnCompletionInTx(c, completionActor, completion);
        await networkScope(c, a.tenantId);
      }
      return result;
    },
    id,
    kind === 'receive' ? async c => {
      const h = await caseRecord(c, id);
      ensure(h.side === 'supplier', 403, 'Niewłaściwa strona zwrotu');
      const supplier = h.snapshot.supplier_tenant_id;
      physicalReceipt = receiveInput.parse({ version: input.supplier_return_version,
        shipping_refund: input.shipping_refund_minor, note: input.note,
        items: input.items.map((i: Row) => ({ item_id: i.supplier_item_id, accepted: i.accepted, restocked: i.restocked })),
        ...(input.wms_lots ? { wms_lots: input.wms_lots } : {}),
      });
      completionActor = { ...a, tenantId: supplier };
      await networkScope(c, supplier);
      completion = await prepareReturnCompletionInTx(c, completionActor, { return_id: h.snapshot.supplier_return_id,
        protocol: 'dropship_supplier', request: physicalReceipt });
      await networkScope(c, a.tenantId);
    } : undefined,
  );
}
export async function receiveB2bDropshipReturn(a: Actor, id: string, raw: unknown) {
  return mutateCase(a, id, S.b2bDropshipReturnReceiveInput.parse(raw), 'receive');
}
export async function decideB2bDropshipReturn(a: Actor, id: string, raw: unknown) {
  return mutateCase(a, id, S.b2bDropshipReturnDecisionInput.parse(raw), 'reject');
}
export async function withdrawB2bDropshipReturn(a: Actor, id: string, raw: unknown) {
  return mutateCase(a, id, S.b2bDropshipReturnWithdrawInput.parse(raw), 'withdraw');
}

async function contextInTx(c: PoolClient, a: Actor, id: string) {
  const r = await ownReturn(c, id),
    refs = (
      await c.query('SELECT id FROM b2b_dropship_return_cases WHERE return_id=$1 ORDER BY id', [id])
    ).rows;
  const supplier = (
    await c.query('SELECT case_id id FROM b2b_dropship_return_supplier_cases WHERE return_id=$1', [
      id,
    ])
  ).rows;
  const heads = [];
  for (const ref of [...refs, ...supplier])
    heads.push(await caseView(c, await caseRecord(c, ref.id), a));
  const caps =
    (await c.query('SELECT b2b_dropship_return_retail_caps($1) result', [id])).rows[0].result ?? [];
  const items = (
    await c.query(
      'SELECT item_id customer_item_id,sku,name,requested FROM return_items WHERE return_id=$1 ORDER BY item_id',
      [id],
    )
  ).rows;
  const order = (await c.query('SELECT currency FROM orders WHERE id=$1', [r.order_id])).rows[0];
  const flags = await access(c, a),
    accepted = (await c.query('SELECT b2b_dropship_return_acceptance($1) result', [id])).rows[0]
      .result;
  const hasExternal = Boolean(
    (
      await c.query(
        "SELECT d.id FROM b2b_dropship_orders d JOIN b2b_dropship_lines l ON(l.tenant_id,l.order_id)=(d.tenant_id,d.id) JOIN return_items ri ON(ri.tenant_id,ri.order_id,ri.item_id)=(d.tenant_id,d.customer_order_id,l.customer_item_id) WHERE d.customer_order_id=$1 AND d.state='ordered' AND ri.return_id=$2 LIMIT 1",
        [r.order_id, id],
      )
    ).rowCount,
  );
  const side = refs.length ? 'buyer' : supplier.length ? 'supplier' : hasExternal ? 'buyer' : null;
  const local = await localReturnOriginContextInTx(c, a, id);
  // Genuine older112 absence retains the authoritative111 partner workflow.
  if (local.fulfillment_origin === 'ordinary' && (hasExternal || side === 'buyer'))
    local.fulfillment_origin = 'partner';
  if (side === 'supplier') local.fulfillment_origin = 'supplier';
  const activeHeads = heads.filter((h) => h.state !== 'withdrawn');
  return {
    ...local,
    side,
    return_id: id,
    version: Number(r.version),
    currency: order.currency,
    shipping_refund_available_minor: String(r.requested_shipping),
    retail_items: items.map((i) => ({
      ...i,
      accepted_available:
        caps.find((x: Row) => x.customer_item_id === i.customer_item_id)?.accepted_available ?? 0,
    })),
    case_refs: activeHeads.map((h) => ({
      id: h.id,
      number: h.number,
      state: h.state,
      version: h.version,
    })),
    can_receive_locally: local.can_receive_locally ?? !side,
    can_preview:
      flags.can_manage &&
      side !== 'supplier' &&
      heads.every((h) => ['withdrawn', 'rejected'].includes(h.state)) &&
      hasExternal &&
      !local.local_origin &&
      r.state === 'requested',
    can_reconcile:
      flags.can_manage &&
      side === 'buyer' &&
      !accepted &&
      activeHeads.length > 0 &&
      activeHeads.every((h) => ['received', 'rejected'].includes(h.state)),
    limits: S.B2B_DROPSHIP_RETURN_LIMITS,
  };
}
export async function b2bDropshipReturnContext(a: Actor, id: string) {
  const legacy = await olderCopy(a, id);
  if (legacy) return legacy;
  return transaction(a, false, async (c) => ({ context: await contextInTx(c, a, id) }));
}
export async function selectB2bReturnLocalOrigin(a: Actor, id: string, raw: unknown) {
  return transaction(a, true, async (c) => ({
    ...(await selectLocalReturnOriginInTx(c, a, id, raw)),
    context: await contextInTx(c, a, id),
  }));
}
export async function reconcileB2bDropshipReturn(a: Actor, id: string, raw: unknown) {
  const input = S.b2bDropshipReturnReconcileInput.parse(raw);
  return transaction(a, true, async (c) => {
    const previous = await prior(c, a, 'reconcile', id, input);
    if (previous) return { return: await getReturn(c, id), reused: true };
    const r = await ownReturn(c, id, true);
    ensure(Number(r.version) === input.version, 409, 'RMA klienta zmieniło wersję');
    const refs = (
      await c.query(
        "SELECT h.id FROM b2b_dropship_return_cases h WHERE h.return_id=$1 AND (b2b_dropship_return_case_state(h.id)->>'state') IS DISTINCT FROM 'withdrawn' ORDER BY h.id",
        [id],
      )
    ).rows;
    ensure(
      refs.length && refs.length === input.case_versions.length,
      422,
      'Odczytaj i rozpatrz cały zakres partnerów',
    );
    for (const ref of refs) {
      const s = await state(c, ref.id);
      ensure(
        input.case_versions.some((x) => x.id === ref.id && x.version === s.version),
        409,
        'Decyzja dostawcy zmieniła wersję',
      );
      ensure(
        ['received', 'rejected'].includes(s.state),
        409,
        'Dostawca nie rozpatrzył wszystkich przekazań',
      );
    }
    const aid = randomUUID(),
      pid = (
        await c.query("SELECT b2b_dropship_return_prepare($1,$2,$3,$4,'reconcile',$5) id", [
          refs[0].id,
          aid,
          a.userId,
          a.apiKeyId ?? null,
          input,
        ])
      ).rows[0].id;
    await applyPartnerReturnAcceptanceInTx(c, a, id, pid);
    await c.query('SELECT b2b_dropship_return_finish($1)', [pid]);
    await action(
      c,
      a,
      'reconcile',
      id,
      input,
      { return_id: id, case_ids: refs.map((r) => r.id) },
      aid,
      null,
      id,
    );
    return { return: await getReturn(c, id), reused: false };
  });
}

async function olderCopy(a: Actor, returnId?: string, options = false) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (await b2bDropshippingReturnsAvailable(c)) {
      await c.query('COMMIT');
      return null;
    }
    const state = (
      await c.query(
        "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='111_b2b_dropshipping_returns') installed, EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'b2b_dropship_return_%') partial",
      )
    ).rows[0];
    ensure(
      options || (!state.installed && !state.partial),
      503,
      'Niekompletna kopia koordynowanych zwrotów',
    );
    const role = (
      await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE', [
        a.tenantId,
        a.userId,
      ])
    ).rows[0]?.role;
    ensure(['admin', 'operator', 'viewer'].includes(role), 403, 'Brak aktualnego członkostwa');
    if (a.apiKeyId) {
      const k = (
        await c.query(
          'SELECT scopes,revoked_at,expires_at FROM api_keys WHERE tenant_id=$1 AND id=$2 AND user_id=$3 FOR SHARE',
          [a.tenantId, a.apiKeyId, a.userId],
        )
      ).rows[0];
      ensure(
        k && !k.revoked_at && (!k.expires_at || new Date(k.expires_at).valueOf() > Date.now()),
        401,
        'Klucz został cofnięty lub wygasł',
      );
      ensure(
        ['orders:read', 'inventory:read'].every((s) => k.scopes.includes(s)),
        403,
        'Brak aktualnych uprawnień',
      );
    }
    await c.query('SET LOCAL ROLE dyna_app');
    await networkScope(c, a.tenantId);
    let context;
    if (returnId) {
      const r = await ownReturn(c, returnId),
        o = (await c.query('SELECT currency FROM orders WHERE id=$1', [r.order_id])).rows[0];
      context = {
        fulfillment_origin: 'ordinary',
        local_origin: null,
        local_sources: [],
        local_scope_hash: null,
        can_select_local_origin: false,
        side: null,
        return_id: r.id,
        version: Number(r.version),
        currency: o.currency,
        case_refs: [],
        retail_items: [],
        can_receive_locally: true,
        can_preview: false,
        can_reconcile: false,
        limits: S.B2B_DROPSHIP_RETURN_LIMITS,
      };
    }
    await c.query('COMMIT');
    return {
      available: false,
      read_only: false,
      current_role: role,
      can_read: true,
      can_manage: false,
      can_read_value: false,
      limits: S.B2B_DROPSHIP_RETURN_LIMITS,
      ...(context ? { context } : {}),
    };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

function publicRow(r: Row) {
  return {
    index: r.index,
    customer_item_id: r.customer_item_id,
    dropship_order_id: r.dropship_order_id,
    sku: r.sku,
    name: r.name,
    quantity: r.quantity,
    retail_currency: r.retail_currency,
    retail_refund_minor: r.retail_refund_minor,
    wholesale_currency: r.wholesale_currency,
    wholesale_refund_minor: r.wholesale_refund_minor,
    supplier_name: r.supplier_name,
    supplier_order_id: r.supplier_order_id,
    supplier_order_number: r.supplier_order_number,
    physical_sources: r.physical_sources.map((p: Row) => ({
      supplier_item_id: p.supplier_item_id,
      product_id: p.product_id,
      sku: p.sku,
      name: p.name,
      shipment_id: p.shipment_id,
      ...(p.issue_fragment_id ? { issue_fragment_id: p.issue_fragment_id } : {}),
      quantity_available: p.quantity_available,
      quantity_per_unit: p.quantity_per_unit,
      quantity: p.quantity,
    })),
  };
}
