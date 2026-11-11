import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { PoolClient, Pool } from 'pg';
import { z } from 'zod';
import { tenantTx, localConfig } from './db';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { assertProductsNotDeletedInTx, productDeletionsAvailable, productIdNotDeletedSQL, productNotDeletedSQL } from './product-deletions';
import { assertCatalogExportAccess } from './catalog-export';
import { assertPurchasingSourceAdmission } from './purchasing-transaction';
import { purchaseSave, purchaseInput, appendPurchaseDraft } from './purchasing';
import * as S from './replenishment-plans-schema';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
export * from './replenishment-plans-schema';

type Row = Record<string, any>;
type Access = { role: string; manage: boolean };
type Item = S.ReplenishmentPreviewInput['items'][number];
type PlanRow = {
  id: string;
  index: number;
  product_id: string | null;
  policy_id: string | null;
  product_version: number | null;
  policy_version: number | null;
  input: Item;
  snapshot: Row;
  result: Row;
  status: 'purchase' | 'unchanged' | 'invalid' | 'conflict';
  errors: string[];
  warnings: string[];
};
const L = S.REPLENISHMENT_LIMITS;
const txOptions = { wmsAdmission: 'read' as const };
const writeTxOptions = { ...txOptions, purchasingAdmission: true };
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}
export const replenishmentHash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const mac = (v: unknown) =>
  createHmac('sha256', localConfig.encryptionKey).update(replenishmentHash(v)).digest('hex');
const stamp = (v: string | Date) => new Date(v).toISOString();
const source = (a: Actor) => (a.apiKeyId ? 'api' : 'manual');
const requestHash = (a: Actor, kind: string, body: unknown) =>
  replenishmentHash({ tenant_id: a.tenantId, actor_id: a.userId, source: source(a), kind, body });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  ensure(
    Buffer.byteLength(JSON.stringify(input) ?? '') <= L.request_bytes,
    413,
    'Pozycje planu przekraczają limit żądania',
  );
  return schema.parse(input);
}
function bounded<T>(v: T): T {
  ensure(
    Buffer.byteLength(JSON.stringify(v)) <= L.response_bytes,
    413,
    'Odpowiedź przekracza limit bajtów',
  );
  return v;
}
export async function replenishmentPlansAvailable(c: PoolClient | Pool) {
  return (
    await c.query<{ available: boolean }>(
      `SELECT
    (SELECT bool_and(to_regclass('public.'||n) IS NOT NULL) FROM unnest($1::text[]) n)
    AND to_regprocedure('public.purchasing_source_admit()') IS NOT NULL
    AND to_regprocedure('public.purchasing_stock_admit()') IS NOT NULL
    AND to_regprocedure('public.purchasing_source_version()') IS NOT NULL
    AND (SELECT count(*)=2 FROM pg_attribute WHERE attrelid=to_regclass('public.purchase_orders') AND NOT attisdropped AND attname IN ('replenishment_execution_id','replenishment_group_index')) AS available`,
      [
        [
          'replenishment_policies',
          'purchasing_source_versions',
          'purchasing_stock_changes',
          'replenishment_previews',
          'replenishment_rows',
          'replenishment_executions',
          'replenishment_execution_rows',
        ],
      ],
    )
  ).rows[0].available;
}
export async function replenishmentForecastAvailable(c: PoolClient | Pool) {
  return (
    await c.query<{ available: boolean }>(
      `SELECT
    to_regprocedure('public.replenishment_forecast_totals(uuid,uuid[],timestamp with time zone,timestamp with time zone)') IS NOT NULL
    AND to_regclass('public.replenishment_forecast_movements') IS NOT NULL
    AND (SELECT count(*)=4 FROM pg_trigger WHERE tgrelid=to_regclass('public.stock_movements') AND NOT tgisinternal AND tgenabled='O' AND tgname=ANY($1::text[])) AS available`,
      [
        [
          'replenishment_forecast_admission',
          'replenishment_forecast_insert',
          'replenishment_forecast_update',
          'replenishment_forecast_delete',
        ],
      ],
    )
  ).rows[0].available;
}
export async function replenishmentAppendAvailable(c: PoolClient | Pool) {
  return (
    await c.query<{ available: boolean }>(`SELECT
    to_regclass('public.replenishment_append_preparations') IS NOT NULL
    AND to_regclass('public.replenishment_append_seals') IS NOT NULL
    AND to_regprocedure('public.replenishment_append_source_before()') IS NOT NULL
    AND to_regprocedure('public.replenishment_append_source_after()') IS NOT NULL
    AND (SELECT count(*)=48 FROM pg_trigger WHERE tgrelid=ANY(ARRAY[to_regclass('public.purchase_orders'),to_regclass('public.purchase_order_lines'),to_regclass('public.purchase_receipts'),to_regclass('public.purchase_receipt_lines'),to_regclass('public.b2b_network_orders'),to_regclass('public.b2b_network_order_lines'),to_regclass('public.b2b_network_receipts'),to_regclass('public.b2b_network_receipt_lines'),to_regclass('public.stock'),to_regclass('public.stock_movements'),to_regclass('public.purchasing_source_versions'),to_regclass('public.purchasing_stock_changes')]) AND NOT tgisinternal AND tgenabled='O' AND tgname=ANY(ARRAY['replenishment_append_seal_before','replenishment_append_seal_insert','replenishment_append_seal_update','replenishment_append_seal_delete']))
    AND to_regprocedure('public.replenishment_append_prepare(uuid,uuid,integer)') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.replenishment_executions') AND tgname='append_prepared' AND NOT tgisinternal AND tgenabled='O') AS available`)
  ).rows[0].available;
}
type ForecastWindow = { from: string; to: string };
function frozenForecastConfig(value: Row) {
  const { forecast_window, ...request } = value;
  const body = S.replenishmentPreviewInput.parse(request);
  if (!body.forecast) {
    ensure(forecast_window === undefined, 409, 'Ręczny plan ma nieprawidłowe okno prognozy');
    return { body, window: undefined };
  }
  const window = z
    .strictObject({ from: z.iso.datetime(), to: z.iso.datetime() })
    .parse(forecast_window);
  ensure(
    Date.parse(window.to) - Date.parse(window.from) === body.forecast.lookback_days * 86400000,
    409,
    'Zamrożone okno prognozy jest nieprawidłowe',
  );
  return { body, window };
}
export function calculateReplenishmentForecast(
  shipped: string,
  lookback: number,
  coverage: number,
  minimum: number,
) {
  const forecast = S.replenishmentForecastInput.parse({
    lookback_days: lookback,
    coverage_days: coverage,
  });
  ensure(/^(0|[1-9][0-9]*)$/.test(shipped), 422, 'Nieprawidłowa ilość wydań');
  const gross = BigInt(shipped),
    denominator = BigInt(forecast.lookback_days);
  const target = (gross * BigInt(forecast.coverage_days) + denominator - 1n) / denominator;
  const floor = BigInt(minimum);
  return {
    coverage_target: target.toString(),
    effective_target: (target > floor ? target : floor).toString(),
  };
}
async function available(c: PoolClient) {
  ensure(
    await replenishmentPlansAvailable(c),
    503,
    'Planowanie zakupów nie jest dostępne w tej kopii',
  );
}
async function entry(a: Actor, write = false) {
  const role = await assertCatalogExportAccess(a, [
    'inventory:read',
    'purchasing:read',
    ...(write ? ['purchasing:write'] : []),
  ]);
  ensure(!write || role === 'admin', 403, 'Planowanie zakupów wymaga administratora');
}
async function access(c: PoolClient, a: Actor, write = false, pin = true): Promise<Access> {
  const role = (
    await c.query<{ role: string | null }>('SELECT replenishment_current_role($1,$2) AS role', [
      a.userId,
      pin,
    ])
  ).rows[0].role;
  ensure(
    role && ['admin', 'operator', 'viewer'].includes(role),
    403,
    'Brak aktualnego członkostwa',
  );
  ensure(!write || role === 'admin', 403, 'Planowanie zakupów wymaga administratora');
  let manage = role === 'admin';
  // Early role probes must not pin an API key across later business waits.
  // The separate entry transaction checked scopes; only the final probe pins.
  if (a.apiKeyId && pin) {
    const grant = (
      await c.query<{ grant_result: string }>(
        'SELECT replenishment_key_grant($1,$2,$3) AS grant_result',
        [a.userId, a.apiKeyId, write],
      )
    ).rows[0].grant_result;
    ensure(grant !== 'invalid', 401, 'Klucz API wygasł lub został cofnięty');
    ensure(
      grant === 'ok' || (!write && grant === 'read_only'),
      403,
      'Brak aktualnych scope planowania zakupów',
    );
    manage = manage && grant === 'ok';
  }
  return { role, manage };
}
const flags = (x: Access) => ({
  available: true,
  current_role: x.role,
  can_read: true,
  can_manage: x.manage,
  can_preview: x.manage,
  can_execute: x.manage,
  can_read_value: x.role === 'admin',
  read_only: false,
});
const costKeys = new Set([
  'unit_cost_minor',
  'line_total_minor',
  'cost_valid_until',
  'cost_confirmed_at',
  'total_minor',
  'unit_cost',
  'known_minor',
  'amount_minor',
  'total_before_minor',
  'total_after_minor',
  'total_net',
  'received_net',
  'line_total',
]);
function project(v: any, cost: boolean): any {
  if (cost) return v;
  if (Array.isArray(v)) return v.map((x) => project(x, false));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !costKeys.has(k))
        .map(([k, x]) => [k, project(x, false)]),
    );
  return v;
}
function policyView(p: Row) {
  return {
    id: p.id,
    warehouse_id: p.warehouse_id,
    product_id: p.product_id,
    version: p.version,
    ...p.definition,
    created_at: stamp(p.created_at),
    updated_at: stamp(p.updated_at),
  };
}
function headView(h: Row) {
  return {
    id: h.id,
    ...(h.config?.forecast || h.config?.draft_targets
      ? {
          config: {
            ...(h.config.forecast
              ? { forecast: h.config.forecast, forecast_window: h.config.forecast_window }
              : {}),
            ...(h.config.draft_targets ? { draft_targets: h.config.draft_targets } : {}),
          },
        }
      : {}),
    actor_id: h.actor_id,
    warehouse_id: h.warehouse_id,
    ...h.summary,
    ready: h.ready,
    scope_hash: h.scope_hash,
    groups: h.groups,
    warnings: h.warnings ?? [],
    created_at: stamp(h.created_at),
    ...(h.expires_at ? { expires_at: stamp(h.expires_at) } : {}),
    ...(h.preview_id
      ? {
          preview_id: h.preview_id,
          state: h.state,
          before_source_version: String(h.before_source_version),
          after_source_version: String(h.after_source_version),
        }
      : { source_version: String(h.source_version) }),
  };
}
function rowView(r: Row) {
  return {
    id: r.id,
    index: r.index,
    product_id: r.product_id,
    sku: r.snapshot.product?.sku ?? null,
    name: r.snapshot.product?.name ?? null,
    policy_snapshot: r.snapshot.policy,
    stock_snapshot: r.snapshot.stock,
    ...(r.snapshot.demand ? { demand: r.snapshot.demand } : {}),
    ...r.result,
    status: r.status,
    errors: r.errors,
    warnings: r.warnings,
    contributor_count: r.snapshot.contributors.length,
    ...(r.preview_row_id
      ? { preview_row_id: r.preview_row_id, purchase_order_id: r.purchase_order_id }
      : {}),
  };
}
function cursor(value: unknown, bind: unknown) {
  const b = Buffer.from(JSON.stringify({ value, bind: replenishmentHash(bind) })).toString(
    'base64url',
  );
  return b + '.' + mac(b);
}
function uncursor(s: string | undefined, bind: unknown): any {
  if (!s) return null;
  const [b, m, ...extra] = s.split('.');
  ensure(!extra.length && m === mac(b), 422, 'Nieprawidłowy kursor');
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  } catch {
    ensure(false, 422, 'Nieprawidłowy kursor');
  }
  ensure(
    parsed.bind === replenishmentHash(bind),
    409,
    'Zakres lub uprawnienia strony zmieniły się',
  );
  return parsed.value;
}
const bind = (a: Actor, x: Access, scope: unknown) => ({
  actor: a.userId,
  tenant: a.tenantId,
  role: x.role,
  key: a.apiKeyId ?? null,
  scope,
});
async function admission(c: PoolClient, a: Actor) {
  await available(c);
  ensure(
    (await access(c, a, false, false)).role === 'admin',
    403,
    'Planowanie zakupów wymaga administratora',
  );
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'replenishment.proof:' + a.tenantId,
  ]);
}
async function finalWrite(c: PoolClient, a: Actor) {
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  return access(c, a, true);
}
async function epoch(c: PoolClient) {
  return String(
    (await c.query<{ version: string }>('SELECT purchasing_source_version()::text AS version'))
      .rows[0].version,
  );
}
async function quota(c: PoolClient, table: 'replenishment_previews' | 'replenishment_executions') {
  ensure(
    Number((await c.query(`SELECT count(*) FROM ${table}`)).rows[0].count) < 2000,
    429,
    'Osiągnięto limit trwałych planów',
  );
}
async function selectRows(c: PoolClient, table: string, parent: string, id: string) {
  return (await c.query(`SELECT * FROM ${table} WHERE ${parent}=$1 ORDER BY index`, [id])).rows;
}
function definition(
  b: z.infer<typeof S.replenishmentPolicyDefinitionInput>,
  old?: S.ReplenishmentDefinition,
): S.ReplenishmentDefinition {
  const { confirm_cost, ...d } = b;
  if (d.unit_cost_minor === null) return { ...d, cost_confirmed_at: null };
  const same =
    old && old.unit_cost_minor === d.unit_cost_minor && old.cost_valid_until === d.cost_valid_until;
  ensure(same || confirm_cost, 422, 'Znany koszt wymaga jawnego potwierdzenia');
  if (confirm_cost)
    ensure(
      d.cost_valid_until !== null &&
        Date.parse(d.cost_valid_until) > Date.now() &&
        Date.parse(d.cost_valid_until) <= Date.now() + 30 * 86400000,
      422,
      'Termin kosztu musi być w przyszłości, do 30 dni',
    );
  return {
    ...d,
    cost_confirmed_at: confirm_cost ? new Date().toISOString() : old!.cost_confirmed_at,
  };
}
async function references(
  c: PoolClient,
  warehouse: string,
  product: string,
  d: S.ReplenishmentDefinition,
) {
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1 FOR SHARE', [warehouse])).rowCount,
    422,
    'Wybierz własny magazyn',
  );
  const supplier = (
    await c.query('SELECT id,active FROM suppliers WHERE id=$1 FOR SHARE', [d.supplier_id])
  ).rows[0];
  ensure(supplier, 422, 'Wybierz własnego dostawcę');
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + (await c.query("SELECT current_setting('app.tenant_id') id")).rows[0].id,
  ]);
  const p = (await c.query('SELECT id,kind,active FROM products WHERE id=$1 FOR SHARE', [product]))
    .rows[0];
  ensure(p, 422, 'Wybierz własny produkt');
  await assertProductsNotDeletedInTx(c, [p.id]);
  ensure(
    !d.enabled || (supplier.active && p.active && ['simple', 'variant'].includes(p.kind)),
    422,
    'Włączona polityka wymaga aktywnego fizycznego produktu i dostawcy',
  );
}
export async function replenishmentOptions(a: Actor) {
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      const enabled = await replenishmentPlansAvailable(c);
      if (!enabled)
        return bounded({
          available: false,
          append_available: false,
          forecast_available: false,
          forecast_lookback_days: [7, 14, 30, 60, 90],
          forecast_max_coverage_days: 365,
          current_role: await assertCatalogExportAccess(a, ['inventory:read', 'purchasing:read']),
          can_read: true,
          can_manage: false,
          can_preview: false,
          can_execute: false,
          can_read_value: false,
          read_only: false,
          limits: L,
          currencies: S.REPLENISHMENT_CURRENCIES,
          warehouses: { data: [], capped: false },
          suppliers: { data: [], capped: false },
        });
      const wh = (await c.query('SELECT id,name,code FROM warehouses ORDER BY id LIMIT 201')).rows;
      const sp = (
        await c.query('SELECT id,name,code,active,version FROM suppliers ORDER BY id LIMIT 201')
      ).rows;
      const acl = await access(c, a);
      return bounded({
        ...flags(acl),
        append_available: await replenishmentAppendAvailable(c),
        forecast_available: await replenishmentForecastAvailable(c),
        forecast_lookback_days: [7, 14, 30, 60, 90],
        forecast_max_coverage_days: 365,
        limits: L,
        currencies: S.REPLENISHMENT_CURRENCIES,
        warehouses: { data: wh.slice(0, 200), capped: wh.length > 200 },
        suppliers: { data: sp.slice(0, 200), capped: sp.length > 200 },
      });
    },
    txOptions,
  );
}
export async function createReplenishmentPolicy(a: Actor, input: unknown) {
  const b = parse(S.replenishmentPolicyCreateInput, input);
  await entry(a, true);
  const hash = requestHash(a, 'policy', b);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await admission(c, a);
      const old = (
        await c.query('SELECT * FROM replenishment_policies WHERE client_key=$1', [b.client_key])
      ).rows[0];
      if (old) {
        ensure(
          old.actor_id === a.userId && old.source === source(a) && old.request_hash === hash,
          409,
          'Klucz polityki dotyczy innego żądania',
        );
        const acl = await access(c, a, true);
        return bounded({ ...flags(acl), policy: policyView(old), reused: true });
      }
      const d = definition(b.definition);
      await references(c, b.warehouse_id, b.product_id, d);
      const p = (
        await c.query(
          `INSERT INTO replenishment_policies(id,tenant_id,warehouse_id,product_id,actor_id,source,client_key,request_hash,initial_request,definition) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            randomUUID(),
            a.tenantId,
            b.warehouse_id,
            b.product_id,
            a.userId,
            source(a),
            b.client_key,
            hash,
            JSON.stringify(b),
            JSON.stringify(d),
          ],
        )
      ).rows[0];
      await audit(c, a, 'replenishment.policy.created', p.id, { after: policyView(p), hash });
      const acl = await finalWrite(c, a);
      return bounded({ ...flags(acl), policy: policyView(p), reused: false });
    },
    writeTxOptions,
  );
}
export async function patchReplenishmentPolicy(a: Actor, id: string, input: unknown) {
  const b = parse(S.replenishmentPolicyPatchInput, input);
  await entry(a, true);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await admission(c, a);
      const old = (
        await c.query('SELECT * FROM replenishment_policies WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      ensure(old, 404, 'Nie znaleziono polityki');
      ensure(old.version === b.version, 409, 'Polityka zmieniła się');
      ensure(old.version < 2147483647, 409, 'Wersja polityki osiągnęła limit');
      const d = definition(b.definition, old.definition);
      await references(c, old.warehouse_id, old.product_id, d);
      const p = (
        await c.query(
          'UPDATE replenishment_policies SET definition=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
          [id, JSON.stringify(d)],
        )
      ).rows[0];
      await audit(c, a, 'replenishment.policy.updated', id, {
        before: policyView(old),
        after: policyView(p),
        hash: replenishmentHash(d),
      });
      const acl = await finalWrite(c, a);
      return bounded({ ...flags(acl), policy: policyView(p), reused: false });
    },
    writeTxOptions,
  );
}
export async function replenishmentSelection(a: Actor, input: unknown) {
  const q = S.replenishmentSelectionQuery.parse(input);
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const early = await access(c, a, false, false),
        binding = bind(a, early, {
          kind: 'selection',
          warehouse: q.warehouse_id,
          search: q.search,
        });
      const last = uncursor(q.cursor, binding);
      const values = [q.warehouse_id, '%' + q.search + '%', last];
      const deletions = await productDeletionsAvailable(c);
      const data = (
        await c.query(
          `SELECT p.id,p.sku,p.name,p.kind,p.active,p.version AS product_version,r.id AS policy_id,r.version AS policy_version,to_jsonb(r) AS policy FROM products p LEFT JOIN replenishment_policies r ON r.tenant_id=p.tenant_id AND r.product_id=p.id AND r.warehouse_id=$1 WHERE (p.sku ILIKE $2 OR p.name ILIKE $2) AND ${productNotDeletedSQL(deletions)} AND ($3::uuid IS NULL OR p.id>$3) ORDER BY p.id LIMIT $4`,
          [...values, q.limit + 1],
        )
      ).rows;
      const total = Number(
        (
          await c.query(`SELECT count(*) FROM products WHERE (sku ILIKE $1 OR name ILIKE $1) AND ${productNotDeletedSQL(deletions, 'products')}`, [
            values[1],
          ])
        ).rows[0].count,
      );
      const acl = await access(c, a);
      ensure(acl.role === early.role, 409, 'Uprawnienia zmieniły się podczas odczytu');
      const rows = data.slice(0, q.limit).map((p) => ({
        ...p,
        policy: p.policy ? project(policyView(p.policy), acl.role === 'admin') : null,
      }));
      return bounded({
        ...flags(acl),
        data: rows,
        meta: { total, cursor: data.length > q.limit ? cursor(rows.at(-1)!.id, binding) : null },
      });
    },
    txOptions,
  );
}
export async function replenishmentPolicies(a: Actor, input: unknown) {
  const q = S.replenishmentPoliciesQuery.parse(input);
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const early = await access(c, a, false, false),
        binding = bind(a, early, { kind: 'policies', warehouse: q.warehouse_id }),
        last = uncursor(q.cursor, binding);
      const deletions = await productDeletionsAvailable(c);
      const rows = (
        await c.query(
          `SELECT r.*,p.sku,p.name,p.version AS product_version FROM replenishment_policies r JOIN products p ON p.tenant_id=r.tenant_id AND p.id=r.product_id WHERE r.warehouse_id=$1 AND ${productNotDeletedSQL(deletions)} AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT $3`,
          [q.warehouse_id, last, q.limit + 1],
        )
      ).rows;
      const total = Number(
          (
            await c.query(`SELECT count(*) FROM replenishment_policies WHERE warehouse_id=$1 AND ${productIdNotDeletedSQL(deletions, 'replenishment_policies.tenant_id', 'replenishment_policies.product_id')}`, [
              q.warehouse_id,
            ])
          ).rows[0].count,
        ),
        acl = await access(c, a);
      ensure(acl.role === early.role, 409, 'Uprawnienia zmieniły się podczas odczytu');
      return bounded({
        ...flags(acl),
        data: project(
          rows.slice(0, q.limit).map((p) => ({
            ...policyView(p),
            sku: p.sku,
            name: p.name,
            product_version: p.product_version,
          })),
          acl.role === 'admin',
        ),
        meta: {
          total,
          cursor: rows.length > q.limit ? cursor(rows[q.limit - 1].id, binding) : null,
        },
      });
    },
    txOptions,
  );
}

/** All source locks precede product/stock waits; the source epoch also fences
 * absent contributors and raw ABA. Only the buyer's own B2B quantities are read. */
async function frame(
  c: PoolClient,
  a: Actor,
  b: S.ReplenishmentPreviewInput,
  frozenWindow?: ForecastWindow,
) {
  if (b.forecast)
    ensure(
      await replenishmentForecastAvailable(c),
      503,
      'Prognoza zakupów nie jest dostępna w tej kopii',
    );
  if (b.draft_targets)
    ensure(
      await replenishmentAppendAvailable(c),
      503,
      'Dopisanie do szkicu nie jest dostępne w tej kopii',
    );
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + a.tenantId,
  ]);
  const ids = b.items.map((i) => i.product_id);
  await lockWarehouseInventoryPoliciesInTx(c, [b.warehouse_id], { sellable: true });
  let forecastWindow = frozenWindow;
  if (b.forecast && !forecastWindow) {
    const now = (await c.query<{ clock: Date }>('SELECT clock_timestamp() AS clock')).rows[0].clock;
    const to = stamp(now);
    forecastWindow = {
      to,
      from: new Date(Date.parse(to) - b.forecast.lookback_days * 86400000).toISOString(),
    };
  }
  const demand = new Map<string, Row>();
  if (b.forecast && forecastWindow) {
    const totals = (
      await c.query(
        `SELECT * FROM replenishment_forecast_totals($1,$2::uuid[],$3::timestamptz,$4::timestamptz)`,
        [b.warehouse_id, ids, forecastWindow.from, forecastWindow.to],
      )
    ).rows;
    for (const total of totals) demand.set(total.product_id, total);
  }

  const po = (
    await c.query(
      `SELECT o.*,o.expected_date::text AS expected_date FROM purchase_orders o WHERE o.warehouse_id=$1 AND (EXISTS(SELECT 1 FROM purchase_order_lines l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.product_id=ANY($2::uuid[])) OR o.id=ANY($3::uuid[])) ORDER BY o.id LIMIT 10001 FOR SHARE OF o`,
      [b.warehouse_id, ids, b.draft_targets?.map((t) => t.purchase_order_id) ?? []],
    )
  ).rows;
  const lines = (
    await c.query(
      `SELECT l.* FROM purchase_order_lines l JOIN purchase_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id WHERE o.warehouse_id=$1 AND l.product_id=ANY($2::uuid[]) ORDER BY l.order_id,l.product_id LIMIT 10001 FOR SHARE OF l`,
      [b.warehouse_id, ids],
    )
  ).rows;
  const hasB2b = (
    await c.query("SELECT to_regclass('public.b2b_network_orders') IS NOT NULL available")
  ).rows[0].available;
  const bp = hasB2b
    ? (
        await c.query(
          `SELECT o.* FROM b2b_network_orders o WHERE o.warehouse_id=$1 AND EXISTS(SELECT 1 FROM b2b_network_order_lines l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id AND l.product_id=ANY($2::uuid[])) ORDER BY o.id LIMIT 10001 FOR SHARE OF o`,
          [b.warehouse_id, ids],
        )
      ).rows
    : [];
  const bl = hasB2b
    ? (
        await c.query(
          `SELECT l.* FROM b2b_network_order_lines l JOIN b2b_network_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id WHERE o.warehouse_id=$1 AND l.product_id=ANY($2::uuid[]) ORDER BY l.order_id,l.product_id LIMIT 10001 FOR SHARE OF l`,
          [b.warehouse_id, ids],
        )
      ).rows
    : [];
  ensure(
    lines.length + bl.length <= L.contributors,
    429,
    'Źródła planu przekraczają 10000 pozycji. Zmniejsz wybór',
  );
  const policies = (
    await c.query(
      'SELECT * FROM replenishment_policies WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
      [b.warehouse_id, ids],
    )
  ).rows;
  if (b.draft_targets) {
    const selectedPairs = new Set(
      policies.map((p) => p.definition.supplier_id + ':' + p.definition.currency),
    );
    ensure(
      b.draft_targets.every((t) => selectedPairs.has(t.supplier_id + ':' + t.currency)),
      422,
      'Każdy wskazany szkic musi odpowiadać dostawcy i walucie wybranej polityki',
    );
  }
  const supplierIds = [...new Set(policies.map((p) => p.definition.supplier_id))].sort();
  const suppliers = (
    await c.query(
      'SELECT id,name,code,version,active FROM suppliers WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [supplierIds],
    )
  ).rows;
  const wh = (
    await c.query('SELECT id,name,code FROM warehouses WHERE id=$1 FOR SHARE', [b.warehouse_id])
  ).rows[0];
  ensure(wh, 422, 'Wybierz własny magazyn');
  const products = (
    await c.query(
      'SELECT id,sku,name,kind,active,version FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [ids],
    )
  ).rows;
  const stocks = (
    await c.query(
      'SELECT product_id,on_hand,reserved,available,version::text FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR SHARE',
      [b.warehouse_id, ids],
    )
  ).rows;
  const draftSnapshots = new Map<string, { head: Row; lines: Row[] }>();
  if (b.draft_targets) {
    const targetIDs = b.draft_targets.map((t) => t.purchase_order_id);
    const heads = (
      await c.query(
        'SELECT to_jsonb(o) AS head FROM purchase_orders o WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE OF o',
        [targetIDs],
      )
    ).rows;
    const targetLines = (
      await c.query(
        'SELECT to_jsonb(l) AS line FROM purchase_order_lines l WHERE order_id=ANY($1::uuid[]) ORDER BY order_id,product_id LIMIT 100001 FOR SHARE OF l',
        [targetIDs],
      )
    ).rows;
    ensure(targetLines.length <= 100000, 413, 'Pełny zakres szkiców przekracza limit pozycji');
    const receiptHeads = (
      await c.query(
        'SELECT order_id FROM purchase_receipts WHERE order_id=ANY($1::uuid[]) ORDER BY order_id,id FOR SHARE',
        [targetIDs],
      )
    ).rows;
    for (const target of b.draft_targets) {
      const head = heads.find((r) => r.head.id === target.purchase_order_id)?.head;
      ensure(head, 422, 'Wybierz własny szkic zamówienia zakupowego');
      ensure(
        head.state === 'draft' && head.version === target.version,
        409,
        'Wybrany szkic zmienił wersję lub stan',
      );
      ensure(
        head.warehouse_id === b.warehouse_id &&
          head.supplier_id === target.supplier_id &&
          head.currency === target.currency,
        422,
        'Szkic ma inny magazyn, dostawcę lub walutę',
      );
      const ls = targetLines
        .filter((r) => r.line.order_id === target.purchase_order_id)
        .map((r) => r.line);
      ensure(
        ls.every((l) => l.received_quantity === 0 && l.closed_quantity === 0) &&
          !receiptHeads.some((r) => r.order_id === target.purchase_order_id),
        409,
        'Szkic ma przyjęte lub zamknięte ilości',
      );
      draftSnapshots.set(target.supplier_id + ':' + target.currency, { head, lines: ls });
    }
  }
  const contributors = new Map<string, Row[]>(),
    pmap = new Map(po.map((p) => [p.id, p])),
    bmap = new Map(bp.map((p) => [p.id, p]));
  for (const [ls, heads, kind] of [
    [lines, pmap, 'purchase_order'],
    [bl, bmap, 'b2b_network_order'],
  ] as const)
    for (const l of ls) {
      const o = heads.get(l.order_id)!;
      const received = kind === 'purchase_order' ? l.received_quantity : l.received,
        closed = kind === 'purchase_order' ? l.closed_quantity : 0;
      const remaining = ['draft', 'ordered', 'partial'].includes(o.state)
        ? BigInt(l.quantity) - BigInt(received) - BigInt(closed)
        : 0n;
      const v = {
        source_kind: kind,
        source_id: o.id,
        number: o.number ?? o.source_number,
        version: o.version,
        state: o.state,
        warehouse_id: o.warehouse_id,
        supplier_id: kind === 'purchase_order' ? o.supplier_id : null,
        currency: o.currency,
        expected_date: o.expected_date ?? null,
        quantity: l.quantity,
        received_quantity: received,
        closed_quantity: closed,
        unit_cost_minor: kind === 'purchase_order' ? l.unit_cost : null,
        supplier_sku: l.supplier_sku ?? '',
        remaining_quantity: remaining.toString(),
      };
      const list = contributors.get(l.product_id) ?? [];
      list.push(v);
      contributors.set(l.product_id, list);
    }
  for (const rows of contributors.values())
    rows.sort((x, y) =>
      (x.source_kind + ':' + x.source_id).localeCompare(y.source_kind + ':' + y.source_id),
    );
  return {
    source_version: await epoch(c),
    draftSnapshots,
    forecast: b.forecast,
    forecastWindow,
    demand,
    warehouse: wh,
    products,
    policies,
    suppliers,
    stocks,
    contributors,
  };
}
export function calculateReplenishment(input: {
  available: number;
  incoming_draft_quantity: string;
  incoming_ordered_quantity: string;
  minimum_quantity: number | string;
  target_quantity: number | string;
  minimum_order_quantity: number;
  order_multiple: number;
}) {
  const projected =
    BigInt(input.available) +
    BigInt(input.incoming_draft_quantity) +
    BigInt(input.incoming_ordered_quantity);
  const deficit =
    projected < BigInt(input.minimum_quantity) ? BigInt(input.target_quantity) - projected : 0n;
  const base =
    deficit > 0n
      ? deficit > BigInt(input.minimum_order_quantity)
        ? deficit
        : BigInt(input.minimum_order_quantity)
      : 0n;
  const multiple = BigInt(input.order_multiple),
    recommended = base === 0n ? 0n : ((base + multiple - 1n) / multiple) * multiple;
  return {
    available: String(input.available),
    incoming_draft_quantity: input.incoming_draft_quantity,
    incoming_ordered_quantity: input.incoming_ordered_quantity,
    projected_available: projected.toString(),
    deficit: deficit.toString(),
    recommended_quantity: recommended.toString(),
    rounding_surplus: (recommended - deficit).toString(),
  };
}
function plan(f: Awaited<ReturnType<typeof frame>>, items: Item[]) {
  const products = new Map(f.products.map((p) => [p.id, p])),
    policies = new Map(f.policies.map((p) => [p.product_id, p])),
    suppliers = new Map(f.suppliers.map((p) => [p.id, p])),
    stocks = new Map(f.stocks.map((p) => [p.product_id, p]));
  const rows: PlanRow[] = items.map<PlanRow>((item, index) => {
    const product = products.get(item.product_id),
      p = policies.get(item.product_id),
      d = p?.definition as S.ReplenishmentDefinition | undefined,
      supplier = d ? suppliers.get(d.supplier_id) : null,
      stock = stocks.get(item.product_id),
      contrib = f.contributors.get(item.product_id) ?? [];
    const errors: string[] = [],
      warnings: string[] = [];
    if (!product) errors.push('Nie znaleziono własnego produktu');
    else if (!product.active || !['simple', 'variant'].includes(product.kind))
      errors.push('Produkt musi być aktywny i fizyczny');
    if (!p || !d?.enabled) errors.push('Brak włączonej polityki');
    const conflict =
      Boolean(product && product.version !== item.product_version) ||
      Boolean(p && p.version !== item.policy_version);
    if (conflict) errors.push('Wersja produktu lub polityki zmieniła się');
    let draft = 0n,
      ordered = 0n;
    for (const v of contrib) {
      if (v.state === 'draft') draft += BigInt(v.remaining_quantity);
      else ordered += BigInt(v.remaining_quantity);
      if (v.state === 'draft' && BigInt(v.remaining_quantity) > 0n)
        warnings.push('Niezatwierdzony szkic ' + v.number + ' jest uwzględniony w dostawie');
      if (
        v.expected_date &&
        v.expected_date < new Date().toISOString().slice(0, 10) &&
        BigInt(v.remaining_quantity) > 0n
      )
        warnings.push('Przeterminowana data dostawy ' + v.number);
    }
    let demand: Row | undefined;
    let effective: string | undefined;
    if (f.forecast && f.forecastWindow) {
      const totals = f.demand.get(item.product_id) ?? {
        shipped_quantity: '0',
        restocked_return_quantity: '0',
        shipment_movement_count: '0',
        return_movement_count: '0',
      };
      const calculation = calculateReplenishmentForecast(
        totals.shipped_quantity,
        f.forecast.lookback_days,
        f.forecast.coverage_days,
        d?.minimum_quantity ?? 0,
      );
      effective = calculation.effective_target;
      demand = {
        semantic: 'warehouse_shipment_gross_v1',
        ...f.forecastWindow,
        ...f.forecast,
        shipped_quantity: totals.shipped_quantity,
        restocked_return_quantity: totals.restocked_return_quantity,
        shipment_movement_count: totals.shipment_movement_count,
        return_movement_count: totals.return_movement_count,
        coverage_target: calculation.coverage_target,
      };
      demand.demand_hash = replenishmentHash({
        warehouse_id: f.warehouse.id,
        product_id: item.product_id,
        source_version: f.source_version,
        ...demand,
      });
      if (totals.shipped_quantity === '0')
        warnings.push('Brak lokalnie zapisanych wydań w oknie; użyto minimum polityki');
    }
    const result: Row = calculateReplenishment({
      available: stock?.available ?? 0,
      incoming_draft_quantity: draft.toString(),
      incoming_ordered_quantity: ordered.toString(),
      minimum_quantity: effective ?? d?.minimum_quantity ?? 0,
      target_quantity: effective ?? d?.target_quantity ?? 0,
      minimum_order_quantity: d?.minimum_order_quantity ?? 1,
      order_multiple: d?.order_multiple ?? 1,
    });
    if (demand)
      Object.assign(result, {
        effective_minimum_quantity: effective,
        effective_target_quantity: effective,
        days_cover:
          demand.shipped_quantity === '0'
            ? null
            : {
                numerator: (
                  BigInt(result.projected_available) * BigInt(f.forecast!.lookback_days)
                ).toString(),
                denominator: demand.shipped_quantity,
              },
      });
    const qty = BigInt(result.recommended_quantity),
      known = d?.unit_cost_minor !== null && d?.unit_cost_minor !== undefined,
      valid =
        known && d?.cost_valid_until !== null && Date.parse(d!.cost_valid_until!) > Date.now();
    if (qty > 0n) {
      if (!supplier?.active) errors.push('Dostawca jest nieaktywny lub nie istnieje');
      if (!known) errors.push('Koszt zakupu jest nieznany');
      else if (!valid) errors.push('Koszt zakupu wygasł');
      if (qty > 1000000n) errors.push('Proponowana ilość przekracza limit 1000000');
    } else if (!valid) warnings.push('Nieznany lub nieaktualny koszt; zakup nie jest potrzebny');
    Object.assign(result, {
      unit_cost_minor: d?.unit_cost_minor ?? null,
      currency: d?.currency ?? null,
      line_total_minor: known ? (qty * BigInt(d!.unit_cost_minor!)).toString() : null,
      group_index: null,
    });
    return {
      id: randomUUID(),
      index,
      product_id: product?.id ?? null,
      policy_id: p?.id ?? null,
      product_version: product?.version ?? null,
      policy_version: p?.version ?? null,
      input: item,
      snapshot: {
        ...(demand ? { demand } : {}),
        product: product ?? null,
        policy: p ? policyView(p) : null,
        supplier: supplier ?? null,
        stock: {
          presence: Boolean(stock),
          on_hand: stock?.on_hand ?? null,
          reserved: stock?.reserved ?? null,
          available: stock?.available ?? 0,
          version: stock?.version ?? null,
        },
        contributors: contrib,
      },
      result,
      status: conflict
        ? 'conflict'
        : errors.length
          ? 'invalid'
          : qty > 0n
            ? 'purchase'
            : 'unchanged',
      errors,
      warnings,
    };
  });
  const buckets = new Map<string, PlanRow[]>();
  for (const r of rows)
    if (r.status === 'purchase') {
      const d = r.snapshot.policy,
        key = d.supplier_id + ':' + d.currency;
      const bucket = buckets.get(key) ?? [];
      bucket.push(r);
      buckets.set(key, bucket);
    }
  const groups: Row[] = [];
  for (const key of [...buckets.keys()].sort()) {
    const rs = buckets.get(key)!;
    const destinationSnapshot = f.draftSnapshots.get(key);
    const step = destinationSnapshot ? rs.length : 200;
    for (let offset = 0; offset < rs.length; offset += step) {
      const chunk = rs.slice(offset, offset + step),
        first = chunk[0],
        dates = chunk
          .map((r) => r.snapshot.policy.expected_date)
          .filter(Boolean)
          .sort(),
        total = chunk.reduce((n, r) => n + BigInt(r.result.line_total_minor), 0n);
      if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
        for (const r of chunk) {
          r.status = 'invalid';
          r.errors.push('Wartość szkicu przekracza bezpieczny limit kwoty');
        }
        continue;
      }
      let destination: Row | undefined;
      if (destinationSnapshot) {
        const oldByID = new Map(destinationSnapshot.lines.map((l) => [l.product_id, l]));
        let afterTotal = destinationSnapshot.lines.reduce(
          (n, l) => n + BigInt(l.quantity) * BigInt(l.unit_cost),
          0n,
        );
        const beforeTotal = afterTotal;
        const issues: string[] = [];
        for (const r of chunk) {
          const old = oldByID.get(r.product_id),
            qty = BigInt(r.result.recommended_quantity);
          if (
            old &&
            (old.unit_cost !== r.result.unit_cost_minor ||
              old.supplier_sku !== r.snapshot.policy.supplier_sku)
          )
            issues.push('Istniejąca pozycja ma inny koszt lub kod dostawcy');
          if (BigInt(old?.quantity ?? 0) + qty > 1000000n)
            issues.push('Końcowa ilość pozycji przekracza 1000000');
          afterTotal += qty * BigInt(r.result.unit_cost_minor);
        }
        const afterCount = oldByID.size + chunk.filter((r) => !oldByID.has(r.product_id)).length;
        if (afterCount > 200 || chunk.length > 200)
          issues.push('Wybrany szkic przekroczy 200 pozycji; wybierz mniejszy zakres');
        if (afterTotal > BigInt(Number.MAX_SAFE_INTEGER))
          issues.push('Końcowa wartość szkicu przekracza bezpieczny limit');
        if (destinationSnapshot.head.version === 2147483647)
          issues.push('Wersja szkicu nie pozwala na kolejną zmianę');
        if (issues.length) {
          for (const r of chunk) {
            r.status = 'invalid';
            r.errors.push(...new Set(issues));
          }
          continue;
        }
        destination = {
          kind: 'existing_draft',
          purchase_order_id: destinationSnapshot.head.id,
          number: destinationSnapshot.head.number,
          version: destinationSnapshot.head.version,
          snapshot: destinationSnapshot,
          line_count_before: oldByID.size,
          line_count_after: afterCount,
          total_before_minor: beforeTotal.toString(),
          total_after_minor: afterTotal.toString(),
        };
      }
      const index = groups.length;
      for (const r of chunk) r.result.group_index = index;
      groups.push({
        ...(destination ? { destination } : {}),
        index,
        supplier_id: first.snapshot.supplier.id,
        supplier_name: first.snapshot.supplier.name,
        supplier_version: first.snapshot.supplier.version,
        currency: first.result.currency,
        expected_date: destinationSnapshot
          ? destinationSnapshot.head.expected_date
          : (dates[0] ?? null),
        product_ids: chunk.map((r) => r.product_id),
        line_count: chunk.length,
        total_minor: total.toString(),
      });
      if (!destinationSnapshot && new Set(dates).size > 1)
        for (const r of chunk) r.warnings.push('Szkic przyjmie najwcześniejszą datę dostawy grupy');
    }
  }
  const summary = {
    total: rows.length,
    purchase: rows.filter((r) => r.status === 'purchase').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    invalid: rows.filter((r) => r.status === 'invalid').length,
    conflicts: rows.filter((r) => r.status === 'conflict').length,
  };
  return { rows, groups, summary, ready: summary.invalid === 0 && summary.conflicts === 0 };
}
function scope(f: Awaited<ReturnType<typeof frame>>, p: ReturnType<typeof plan>) {
  return mac({
    warehouse: f.warehouse,
    source_version: f.source_version,
    ...(f.draftSnapshots.size ? { draft_targets: [...f.draftSnapshots.entries()] } : {}),
    rows: p.rows.map(({ id, ...r }) => r),
    groups: p.groups,
  });
}
async function insertRows(c: PoolClient, a: Actor, preview: string, rows: PlanRow[]) {
  for (let offset = 0; offset < rows.length; offset += 100)
    await c.query(
      `INSERT INTO replenishment_rows(id,tenant_id,preview_id,index,product_id,policy_id,product_version,policy_version,input,snapshot,result,status,errors,warnings) SELECT x.id,$1,$2,x.index,x.product_id,x.policy_id,x.product_version,x.policy_version,x.input,x.snapshot,x.result,x.status,x.errors,x.warnings FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,index integer,product_id uuid,policy_id uuid,product_version integer,policy_version integer,input jsonb,snapshot jsonb,result jsonb,status text,errors jsonb,warnings jsonb)`,
      [a.tenantId, preview, JSON.stringify(rows.slice(offset, offset + 100))],
    );
}
export async function createReplenishmentPreview(a: Actor, input: unknown) {
  await entry(a, true);
  return tenantTx(a.tenantId, (c) => createReplenishmentPreviewInTx(c, a, input), writeTxOptions);
}
/** Internal executor owns source admission. finalize:false defers actor pins until
 * its caller has written its own run/job evidence and flushed all constraints. */
export async function createReplenishmentPreviewInTx(
  c: PoolClient,
  a: Actor,
  input: unknown,
  options: { finalize?: boolean } = {},
) {
  assertPurchasingSourceAdmission(c, a);
  const b = parse(S.replenishmentPreviewInput, input);
  const hash = requestHash(a, 'preview', b);
  await admission(c, a);
  const previous = (
    await c.query('SELECT * FROM replenishment_previews WHERE client_key=$1', [b.client_key])
  ).rows[0];
  if (previous) {
    ensure(
      previous.actor_id === a.userId &&
        previous.source === source(a) &&
        previous.request_hash === hash,
      409,
      'Klucz podglądu dotyczy innego żądania',
    );
    const acl = await access(c, a, true, options.finalize !== false);
    return bounded({ ...flags(acl), preview: headView(previous), reused: true });
  }
  await quota(c, 'replenishment_previews');
  const f = await frame(c, a, b),
    p = plan(f, b.items),
    id = randomUUID(),
    scopeHash = scope(f, p);
  ensure(
    Buffer.byteLength(JSON.stringify({ rows: p.rows, groups: p.groups })) <= L.preview_bytes,
    413,
    'Podgląd przekracza 8 MiB',
  );
  const h = (
    await c.query(
      `INSERT INTO replenishment_previews(id,tenant_id,actor_id,source,client_key,request_hash,warehouse_id,scope_hash,source_version,config,summary,groups,warnings,ready,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,statement_timestamp(),statement_timestamp()+interval '15 minutes') RETURNING *`,
      [
        id,
        a.tenantId,
        a.userId,
        source(a),
        b.client_key,
        hash,
        b.warehouse_id,
        scopeHash,
        f.source_version,
        JSON.stringify(f.forecastWindow ? { ...b, forecast_window: f.forecastWindow } : b),
        JSON.stringify(p.summary),
        JSON.stringify(p.groups),
        '[]',
        p.ready,
      ],
    )
  ).rows[0];
  await insertRows(c, a, id, p.rows);
  await audit(c, a, 'replenishment.preview.created', id, {
    scope_hash: scopeHash,
    summary: p.summary,
  });
  const acl = options.finalize === false ? await access(c, a, true, false) : await finalWrite(c, a);
  return bounded({ ...flags(acl), preview: headView(h), reused: false });
}
async function loadHead(c: PoolClient, table: string, id: string) {
  const h = (
    await c.query(
      table === 'replenishment_executions'
        ? 'SELECT e.*,p.config FROM replenishment_executions e JOIN replenishment_previews p ON p.tenant_id=e.tenant_id AND p.id=e.preview_id WHERE e.id=$1'
        : `SELECT * FROM ${table} WHERE id=$1`,
      [id],
    )
  ).rows[0];
  ensure(h, 404, 'Nie znaleziono własnego planu');
  return h;
}
async function detail(a: Actor, id: string, execution: boolean) {
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const h = await loadHead(
          c,
          execution ? 'replenishment_executions' : 'replenishment_previews',
          id,
        ),
        acl = await access(c, a);
      return bounded({
        ...flags(acl),
        [execution ? 'execution' : 'preview']: project(headView(h), acl.role === 'admin'),
      });
    },
    txOptions,
  );
}
export const replenishmentPreviewDetail = (a: Actor, id: string) => detail(a, id, false);
export const replenishmentExecutionDetail = (a: Actor, id: string) => detail(a, id, true);
async function pagedRows(a: Actor, id: string, input: unknown, execution: boolean) {
  const q = S.replenishmentPageQuery.parse(input);
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const h = await loadHead(
          c,
          execution ? 'replenishment_executions' : 'replenishment_previews',
          id,
        ),
        early = await access(c, a, false, false),
        binding = bind(a, early, {
          kind: execution ? 'executionRows' : 'previewRows',
          id,
          scope: h.scope_hash,
        }),
        last = uncursor(q.cursor, binding);
      const table = execution ? 'replenishment_execution_rows' : 'replenishment_rows',
        parent = execution ? 'execution_id' : 'preview_id';
      const rows = (
          await c.query(
            `SELECT * FROM ${table} WHERE ${parent}=$1 AND ($2::int IS NULL OR index>$2) ORDER BY index LIMIT $3`,
            [id, last, q.limit + 1],
          )
        ).rows,
        acl = await access(c, a);
      ensure(acl.role === early.role, 409, 'Uprawnienia strony zmieniły się');
      return bounded({
        ...flags(acl),
        data: project(rows.slice(0, q.limit).map(rowView), acl.role === 'admin'),
        meta: {
          total: h.summary.total,
          cursor: rows.length > q.limit ? cursor(rows[q.limit - 1].index, binding) : null,
        },
        scope_hash: h.scope_hash,
      });
    },
    txOptions,
  );
}
export const replenishmentPreviewRows = (a: Actor, id: string, q: unknown) =>
  pagedRows(a, id, q, false);
export const replenishmentExecutionRows = (a: Actor, id: string, q: unknown) =>
  pagedRows(a, id, q, true);
export async function replenishmentContributors(
  a: Actor,
  id: string,
  rowId: string,
  input: unknown,
) {
  const q = S.replenishmentPageQuery.parse(input);
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const row = (
        await c.query('SELECT * FROM replenishment_rows WHERE preview_id=$1 AND id=$2', [id, rowId])
      ).rows[0];
      ensure(row, 404, 'Nie znaleziono pozycji podglądu');
      const acl = await access(c, a),
        binding = bind(a, acl, { kind: 'contributors', id, rowId }),
        offset = uncursor(q.cursor, binding) ?? 0;
      ensure(Number.isInteger(offset) && offset >= 0, 422, 'Nieprawidłowy kursor');
      const rows = row.snapshot.contributors as Row[];
      return bounded({
        ...flags(acl),
        data: project(rows.slice(offset, offset + q.limit), acl.role === 'admin'),
        meta: {
          total: rows.length,
          cursor: offset + q.limit < rows.length ? cursor(offset + q.limit, binding) : null,
        },
      });
    },
    txOptions,
  );
}
export async function executeReplenishmentPlan(a: Actor, id: string, input: unknown) {
  await entry(a, true);
  return tenantTx(a.tenantId, (c) => executeReplenishmentPlanInTx(c, a, id, input), writeTxOptions);
}
/** Internal executor owns source admission. finalize:false defers actor pins until
 * its caller has written its own run/job evidence and flushed all constraints. */
export async function executeReplenishmentPlanInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  input: unknown,
  options: { finalize?: boolean } = {},
) {
  assertPurchasingSourceAdmission(c, a);
  const b = parse(S.replenishmentExecuteInput, input);
  const hash = requestHash(a, 'execute', { preview_id: id, ...b });
  await admission(c, a);
  const previous = (
    await c.query(
      'SELECT e.*,p.config FROM replenishment_executions e JOIN replenishment_previews p ON p.tenant_id=e.tenant_id AND p.id=e.preview_id WHERE e.client_key=$1',
      [b.client_key],
    )
  ).rows[0];
  if (previous) {
    ensure(
      previous.actor_id === a.userId &&
        previous.source === source(a) &&
        previous.request_hash === hash,
      409,
      'Klucz wykonania dotyczy innego żądania',
    );
    const acl = await access(c, a, true, options.finalize !== false);
    return bounded({ ...flags(acl), execution: headView(previous), reused: true });
  }
  const h = await loadHead(c, 'replenishment_previews', id);
  ensure(h.actor_id === a.userId && h.source === source(a), 403, 'Podgląd należy do innego aktora');
  ensure(
    h.ready && h.scope_hash === b.scope_hash,
    409,
    'Podgląd nie jest gotowy albo zgoda dotyczy innego zakresu',
  );
  ensure(new Date(h.expires_at).getTime() > Date.now(), 409, 'Podgląd wygasł');
  ensure(
    !(await c.query('SELECT id FROM replenishment_executions WHERE preview_id=$1', [id])).rowCount,
    409,
    'Podgląd został już wykonany',
  );
  await quota(c, 'replenishment_executions');
  const frozen = frozenForecastConfig(h.config),
    config = frozen.body,
    f = await frame(c, a, config, frozen.window),
    p = plan(f, config.items);
  ensure(
    p.ready && scope(f, p) === h.scope_hash,
    409,
    'Źródła planu zmieniły się. Utwórz nowy podgląd',
  );
  const approved = await selectRows(c, 'replenishment_rows', 'preview_id', id),
    executionId = randomUUID(),
    groups: Row[] = [];
  for (const g of h.groups as Row[]) {
    const rs = approved.filter((r) => r.result.group_index === g.index);
    const po = g.destination
      ? await appendPurchaseDraft(c, a, {
          id: g.destination.purchase_order_id,
          version: g.destination.version,
          preview_id: id,
          execution_id: executionId,
          group_index: g.index,
          lines: rs.map((r) => ({
            product_id: r.product_id,
            quantity: Number(r.result.recommended_quantity),
            unit_cost: r.result.unit_cost_minor,
            supplier_sku: r.snapshot.policy.supplier_sku,
          })),
        })
      : await purchaseSave(
          c,
          a,
          purchaseInput.parse({
            supplier_id: g.supplier_id,
            warehouse_id: h.warehouse_id,
            currency: g.currency,
            reference: 'Plan ' + executionId,
            note: 'Lokalny plan uzupełnienia; szkic bez wysyłki do dostawcy',
            expected_date: g.expected_date,
            lines: rs.map((r) => ({
              product_id: r.product_id,
              quantity: Number(r.result.recommended_quantity),
              unit_cost: r.result.unit_cost_minor,
              supplier_sku: r.snapshot.policy.supplier_sku,
            })),
          }),
        );
    if (!g.destination)
      await c.query(
        'UPDATE purchase_orders SET replenishment_execution_id=$2,replenishment_group_index=$3 WHERE id=$1',
        [po.id, executionId, g.index],
      );
    groups.push({ ...g, purchase_order_id: po.id, number: po.number, version: po.version });
  }
  const after = await epoch(c);
  const e = (
    await c.query(
      `INSERT INTO replenishment_executions(id,tenant_id,preview_id,actor_id,source,client_key,request_hash,warehouse_id,scope_hash,before_source_version,after_source_version,summary,groups,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'done') RETURNING *`,
      [
        executionId,
        a.tenantId,
        id,
        a.userId,
        source(a),
        b.client_key,
        hash,
        h.warehouse_id,
        h.scope_hash,
        f.source_version,
        after,
        JSON.stringify(h.summary),
        JSON.stringify(groups),
      ],
    )
  ).rows[0];
  const groupByIndex = new Map(groups.map((g) => [g.index, g]));
  for (let offset = 0; offset < approved.length; offset += 100) {
    const rs = approved.slice(offset, offset + 100).map((r) => ({
      ...r,
      id: randomUUID(),
      preview_row_id: r.id,
      purchase_order_id: groupByIndex.get(r.result.group_index)?.purchase_order_id ?? null,
    }));
    await c.query(
      `INSERT INTO replenishment_execution_rows(id,tenant_id,execution_id,preview_id,preview_row_id,index,product_id,policy_id,status,input,snapshot,result,errors,warnings,purchase_order_id) SELECT x.id,$1,$2,$3,x.preview_row_id,x.index,x.product_id,x.policy_id,x.status,x.input,x.snapshot,x.result,x.errors,x.warnings,x.purchase_order_id FROM jsonb_to_recordset($4::jsonb) AS x(id uuid,preview_row_id uuid,index integer,product_id uuid,policy_id uuid,status text,input jsonb,snapshot jsonb,result jsonb,errors jsonb,warnings jsonb,purchase_order_id uuid)`,
      [a.tenantId, executionId, id, JSON.stringify(rs)],
    );
  }
  await audit(c, a, 'replenishment.executed', executionId, {
    preview_id: id,
    scope_hash: h.scope_hash,
    summary: h.summary,
    purchase_order_ids: groups.map((g) => g.purchase_order_id),
  });
  const acl = options.finalize === false ? await access(c, a, true, false) : await finalWrite(c, a);
  return bounded({
    ...flags(acl),
    execution: headView({ ...e, config: h.config }),
    reused: false,
  });
}
export async function replenishmentExecutions(a: Actor, input: unknown) {
  const q = S.replenishmentExecutionsQuery.parse(input);
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const early = await access(c, a, false, false),
        binding = bind(a, early, { kind: 'history', warehouse: q.warehouse_id ?? null }),
        last = uncursor(q.cursor, binding);
      ensure(
        last === null || (typeof last.created_at === 'string' && typeof last.id === 'string'),
        422,
        'Nieprawidłowy kursor',
      );
      const rows = (
          await c.query(
            `SELECT e.*,p.config FROM replenishment_executions e JOIN replenishment_previews p ON p.tenant_id=e.tenant_id AND p.id=e.preview_id WHERE ($1::uuid IS NULL OR e.warehouse_id=$1) AND ($2::timestamptz IS NULL OR (e.created_at,e.id)<($2,$3::uuid)) ORDER BY e.created_at DESC,e.id DESC LIMIT $4`,
            [q.warehouse_id ?? null, last?.created_at ?? null, last?.id ?? null, q.limit + 1],
          )
        ).rows,
        acl = await access(c, a);
      ensure(acl.role === early.role, 409, 'Uprawnienia historii zmieniły się');
      const tail = rows[q.limit - 1];
      return bounded({
        ...flags(acl),
        data: project(rows.slice(0, q.limit).map(headView), acl.role === 'admin'),
        meta: {
          cursor:
            rows.length > q.limit
              ? cursor({ created_at: stamp(tail.created_at), id: tail.id }, binding)
              : null,
        },
      });
    },
    txOptions,
  );
}
export async function replenishmentPolicyDetail(a: Actor, id: string) {
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const p = (await c.query('SELECT * FROM replenishment_policies WHERE id=$1', [id])).rows[0];
      ensure(p, 404, 'Nie znaleziono polityki');
      const acl = await access(c, a);
      return bounded({ ...flags(acl), policy: project(policyView(p), acl.role === 'admin') });
    },
    txOptions,
  );
}

export async function replenishmentDrafts(a: Actor, input: unknown) {
  const q = S.replenishmentDraftsQuery.parse(input);
  await entry(a);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      ensure(
        await replenishmentAppendAvailable(c),
        503,
        'Dopisanie do szkicu nie jest dostępne w tej kopii',
      );
      const early = await access(c, a, false, false),
        binding = bind(a, early, {
          kind: 'drafts',
          warehouse: q.warehouse_id,
          supplier: q.supplier_id,
          currency: q.currency,
        }),
        last = uncursor(q.cursor, binding);
      ensure(
        last === null || (typeof last.created_at === 'string' && typeof last.id === 'string'),
        422,
        'Nieprawidłowy kursor',
      );
      const rows = (
        await c.query(
          `SELECT o.id,o.number,o.version,o.supplier_id,o.currency,o.warehouse_id,o.expected_date::text,o.created_at,
    (SELECT count(*)::int FROM purchase_order_lines l WHERE (l.tenant_id,l.order_id)=(o.tenant_id,o.id)) line_count,
    (SELECT coalesce(sum(l.quantity::bigint*l.unit_cost),0)::text FROM purchase_order_lines l WHERE (l.tenant_id,l.order_id)=(o.tenant_id,o.id)) total_minor
    FROM purchase_orders o WHERE o.state='draft' AND o.warehouse_id=$1 AND o.supplier_id=$2 AND o.currency=$3
    AND NOT EXISTS(SELECT 1 FROM purchase_receipts r WHERE (r.tenant_id,r.order_id)=(o.tenant_id,o.id))
    AND NOT EXISTS(SELECT 1 FROM purchase_order_lines l WHERE (l.tenant_id,l.order_id)=(o.tenant_id,o.id) AND (l.received_quantity<>0 OR l.closed_quantity<>0))
    AND ($4::timestamptz IS NULL OR (o.created_at,o.id)<($4,$5::uuid)) ORDER BY o.created_at DESC,o.id DESC LIMIT $6`,
          [
            q.warehouse_id,
            q.supplier_id,
            q.currency,
            last?.created_at ?? null,
            last?.id ?? null,
            q.limit + 1,
          ],
        )
      ).rows;
      const total = (
        await c.query<{ total: number }>(
          `SELECT count(*)::int total FROM purchase_orders o WHERE o.state='draft' AND o.warehouse_id=$1 AND o.supplier_id=$2 AND o.currency=$3
    AND NOT EXISTS(SELECT 1 FROM purchase_receipts r WHERE (r.tenant_id,r.order_id)=(o.tenant_id,o.id))
    AND NOT EXISTS(SELECT 1 FROM purchase_order_lines l WHERE (l.tenant_id,l.order_id)=(o.tenant_id,o.id) AND (l.received_quantity<>0 OR l.closed_quantity<>0))`,
          [q.warehouse_id, q.supplier_id, q.currency],
        )
      ).rows[0].total;
      const acl = await access(c, a);
      ensure(acl.role === early.role, 409, 'Uprawnienia szkiców zmieniły się');
      const tail = rows[q.limit - 1];
      return bounded({
        ...flags(acl),
        append_available: true,
        data: project(
          rows.slice(0, q.limit).map(({ created_at, ...r }) => r),
          acl.role === 'admin',
        ),
        meta: {
          total,
          cursor:
            rows.length > q.limit
              ? cursor({ created_at: stamp(tail.created_at), id: tail.id }, binding)
              : null,
        },
      });
    },
    txOptions,
  );
}
