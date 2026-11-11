import { productCatalogOptionsInTx } from './product-catalogs';
import { assertProductRulePriceChildInTx } from './product-rule-price-tags';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import {
  priceBulkEditPreviewInput,
  priceBulkEditExecuteInput,
  priceBulkEditMetadataQuery,
  priceBulkEditSelectionQuery,
  type PriceBulkEditInput,
} from './price-bulk-edit-schema';

export type PriceBulkEditActor = Actor & { apiKeyId?: string };
const stable = (v: any): any =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, stable(x)]),
        )
      : v;
export const priceBulkEditHash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(v)))
    .digest('hex');
export function priceBulkEditGross(amount: number, vat: number, basis: 'gross' | 'net') {
  ensure(
    Number.isSafeInteger(amount) &&
      amount >= 0 &&
      amount <= 100000000 &&
      [0, 5, 8, 23].includes(vat),
    422,
    'Niepoprawna kwota lub VAT',
  );
  const gross =
    basis === 'net' ? (BigInt(amount) * BigInt(100 + vat) + 50n) / 100n : BigInt(amount);
  ensure(gross <= 100000000n, 422, 'Cena brutto po przeliczeniu przekracza 100000000 minor units');
  return Number(gross);
}
const access = (r: string) => ({ current_role: r, can_read: true, can_write: r === 'admin' });
async function role(c: PoolClient, a: PriceBulkEditActor, write = false) {
  const r = (await c.query('SELECT catalog_bulk_edit_current_role($1) role', [a.userId])).rows[0]
    ?.role;
  ensure(['admin', 'operator', 'viewer'].includes(r), 403, 'Utracono dostęp do cenników');
  ensure(!write || r === 'admin', 403, 'Wymagany aktualny administrator');
  if (write && a.apiKeyId) {
    const key = (
      await c.query('SELECT catalog_bulk_edit_key_grant($1,$2) grant_result', [
        a.userId,
        a.apiKeyId,
      ])
    ).rows[0]?.grant_result;
    ensure(key !== 'invalid', 401, 'Klucz API został cofnięty lub wygasł');
    ensure(key === 'ok', 403, 'Brak aktualnych scopes products:read i products:write');
  }
  return r as Actor['role'];
}
async function admission(c: PoolClient, a: Actor) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    `catalog:${a.tenantId}`,
  ]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `price.bulk:${a.tenantId}`,
  ]);
}
async function quota(c: PoolClient, kind: 'previews' | 'executions') {
  ensure(
    (await c.query(`SELECT count(*)::int n FROM price_bulk_edit_${kind}`)).rows[0].n < 2000,
    409,
    `Limit 2000 ${kind}; historia nie jest automatycznie usuwana`,
  );
}
function requestHash(v: unknown, source: string) {
  ensure(
    Buffer.byteLength(JSON.stringify(v), 'utf8') <= 786432,
    413,
    'Żądanie przekracza 786432 bajty',
  );
  return priceBulkEditHash({ source, request: v });
}
async function listFrame(c: PoolClient, id: string, readOnly = false) {
  const l = (
    await c.query(`SELECT * FROM price_lists WHERE id=$1 FOR ${readOnly ? 'SHARE' : 'UPDATE'}`, [
      id,
    ])
  ).rows[0];
  ensure(l, 404, 'Nie znaleziono własnego cennika');
  const t = (
    await c.query(
      "SELECT currency FROM tenants WHERE id=nullif(current_setting('app.tenant_id',true),'')::uuid FOR SHARE",
    )
  ).rows[0];
  const list = {
    id: l.id,
    name: l.name,
    currency: l.currency,
    version: l.version,
    active: l.active,
    fallback: l.fallback,
    adjustment_bps: l.adjustment_bps,
    adjustment_amount: l.adjustment_amount,
    catalog_currency: t.currency,
  };
  const present = (
    await c.query(
      "SELECT to_regclass('public.repricing_rules') rules,to_regclass('public.repricing_schedules') schedules,to_regclass('public.repricing_runs') runs",
    )
  ).rows[0];
  // UPDATE on each existing FK parent also fences insertion of an absent child.
  // Read-only selection uses compatible SHARE locks and needs no admission mutex.
  const rule = present.rules
    ? ((
        await c.query(
          `SELECT version,config_version,config FROM repricing_rules WHERE price_list_id=$1 FOR ${readOnly ? 'SHARE' : 'UPDATE'}`,
          [id],
        )
      ).rows[0] ?? null)
    : null;
  const schedule = present.schedules
    ? ((
        await c.query(
          `SELECT version,enabled,actor_id,rule_config_version,interval_minutes,batch_size FROM repricing_schedules WHERE price_list_id=$1 FOR ${readOnly ? 'SHARE' : 'UPDATE'}`,
          [id],
        )
      ).rows[0] ?? null)
    : null;
  const queued_run = present.runs
    ? ((
        await c.query(
          "SELECT id,state,rule_version,schedule_version,expected_list_version,cursor,scanned,changed FROM repricing_runs WHERE price_list_id=$1 AND state='queued' ORDER BY id FOR SHARE",
          [id],
        )
      ).rows[0] ?? null)
    : null;
  const repricing_snapshot = { rule, schedule, queued_run },
    warnings: string[] = [];
  if (!l.active)
    warnings.push(
      'Cennik nieaktywny: nowa wycena nie użyje go przed ponownym włączeniem. Arkusz nie włącza cennika.',
    );
  if (rule?.config.enabled)
    warnings.push('Włączona reguła repricingu może zostać później użyta do zmiany tych cen.');
  if (schedule?.enabled)
    warnings.push(
      'Aktywny harmonogram repricingu może później zmienić zatwierdzone ceny; arkusz go nie wyłącza.',
    );
  if (queued_run)
    warnings.push(
      'Czeka aktywny przebieg repricingu; lokalna zmiana wersji listy może unieważnić jego bieżący CAS.',
    );
  return { list, repricing_snapshot, warnings };
}
type State = { product: any; override: number | null; present: boolean };
async function states(
  c: PoolClient,
  listId: string,
  ids: string[],
  readOnly = false,
): Promise<Map<string, State>> {
  // Existing pricing writers take list first. SHARE stays compatible with product-first quote readers.
  // A deleted product (225) is outside every scope: it counts as missing.
  const deletions = await productDeletionsAvailable(c);
  const products = (
    await c.query(
      `SELECT id,sku,name,kind,active,vat,price,version FROM products WHERE id=ANY($1::uuid[]) AND ${productNotDeletedSQL(deletions, 'products')} ORDER BY id FOR SHARE`,
      [ids],
    )
  ).rows;
  ensure(products.length === ids.length, 422, 'Zakres zawiera brakujący lub obcy produkt');
  const entries = (
    await c.query(
      `SELECT product_id,price FROM price_list_items WHERE price_list_id=$1 AND product_id=ANY($2::uuid[]) ORDER BY product_id FOR ${readOnly ? 'SHARE' : 'UPDATE'}`,
      [listId, ids],
    )
  ).rows;
  const byId = new Map(entries.map((e) => [e.product_id, e.price]));
  return new Map(
    products.map((p) => [
      p.id,
      { product: p, present: byId.has(p.id), override: byId.get(p.id) ?? null },
    ]),
  );
}
type PriceSnapshot = {
  currency: string;
  vat: number;
  catalog_price: number;
  override_present: boolean;
  override_price: number | null;
  effective_price: number | null;
  source: 'override' | 'rule' | 'missing';
  issue: string | null;
};
function snapshot(list: any, s: State, present = s.present, value = s.override): PriceSnapshot {
  const result: PriceSnapshot = {
    currency: list.currency,
    vat: s.product.vat,
    catalog_price: s.product.price,
    override_present: present,
    override_price: present ? value : null,
    effective_price: null,
    source: 'missing',
    issue: null,
  };
  if (s.product.kind === 'group') {
    result.issue = 'non_sellable_group';
    return result;
  }
  if (present) {
    result.source = 'override';
    result.effective_price = value;
    return result;
  }
  if (!list.fallback || list.currency !== list.catalog_currency) {
    result.issue = 'missing_override';
    return result;
  }
  const computed =
    (BigInt(s.product.price) * BigInt(10000 + list.adjustment_bps) + 5000n) / 10000n +
    BigInt(list.adjustment_amount);
  if (computed < 0n || computed > 100000000n) {
    result.issue = 'invalid_fallback';
    return result;
  }
  result.source = 'rule';
  result.effective_price = Number(computed);
  return result;
}
type FrozenRow = {
  index: number;
  product_id: string;
  sku: string;
  name: string;
  kind: string;
  product_version: number;
  input: PriceBulkEditInput['rows'][number];
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict';
  before: PriceSnapshot;
  after: PriceSnapshot | null;
  errors: string[];
};
function plan(b: PriceBulkEditInput, list: any, values: Map<string, State>): FrozenRow[] {
  return b.rows.map((input, index) => {
    const s = values.get(input.product_id)!,
      before = snapshot(list, s),
      row: FrozenRow = {
        index,
        product_id: input.product_id,
        sku: s.product.sku,
        name: s.product.name,
        kind: s.product.kind,
        product_version: s.product.version,
        input,
        status: 'unchanged',
        before,
        after: null,
        errors: [],
      };
    let present = s.present,
      value = s.override;
    if (input.operation === 'set') {
      try {
        value = priceBulkEditGross(input.amount_minor, s.product.vat, input.basis);
        present = true;
      } catch (e) {
        row.errors.push((e as Error).message);
      }
    }
    if (input.operation === 'remove') {
      present = false;
      value = null;
    }
    const after = snapshot(list, s, present, value);
    if (s.product.kind === 'group') row.errors.push('Grupa wariantów nie ma ceny sprzedaży');
    if (after.issue === 'invalid_fallback')
      row.errors.push(
        'Wynik reguły fallback poza zakresem; podaj legalny override lub popraw konfigurację',
      );
    if (input.product_version !== s.product.version || b.list_version !== list.version) {
      row.status = 'conflict';
      row.errors.unshift('Cennik lub wersja produktu zmieniły się');
    } else if (row.errors.length) row.status = 'invalid';
    else {
      row.after = after;
      row.status = present !== s.present || value !== s.override ? 'changed' : 'unchanged';
    }
    return row;
  });
}
const summary = (rows: FrozenRow[]) => ({
  total: rows.length,
  changed: rows.filter((r) => r.status === 'changed').length,
  unchanged: rows.filter((r) => r.status === 'unchanged').length,
  invalid: rows.filter((r) => r.status === 'invalid').length,
  conflicts: rows.filter((r) => r.status === 'conflict').length,
  missing_after_count: rows.filter((r) => r.after?.source === 'missing').length,
  ready: rows.every((r) => r.status === 'changed' || r.status === 'unchanged'),
});
const previewHead = (p: any) => ({
  id: p.id,
  actor_id: p.actor_id,
  price_list_id: p.price_list_id,
  list_snapshot: p.list_snapshot,
  repricing_snapshot: p.repricing_snapshot,
  warnings: p.warnings,
  total: p.total,
  changed: p.changed,
  unchanged: p.unchanged,
  invalid: p.invalid,
  conflicts: p.conflicts,
  missing_after_count: p.missing_after_count,
  ready: p.ready,
  scope_hash: p.scope_hash,
  created_at: p.created_at,
});
const executionHead = (e: any) => ({
  id: e.id,
  preview_id: e.preview_id,
  actor_id: e.actor_id,
  price_list_id: e.price_list_id,
  list_snapshot: e.list_snapshot,
  repricing_snapshot: e.repricing_snapshot,
  warnings: e.warnings,
  state: e.state,
  total: e.total,
  changed: e.changed,
  unchanged: e.unchanged,
  missing_after_count: e.missing_after_count,
  before_list_version: e.before_list_version,
  after_list_version: e.after_list_version,
  scope_hash: e.scope_hash,
  ack_missing_prices: e.ack_missing_prices,
  created_at: e.created_at,
});
async function preview(c: PoolClient, id: string) {
  const p = (await c.query('SELECT * FROM price_bulk_edit_previews WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu cen');
  return p;
}
async function execution(c: PoolClient, id: string) {
  const e = (await c.query('SELECT * FROM price_bulk_edit_executions WHERE id=$1', [id])).rows[0];
  ensure(e, 404, 'Nie znaleziono wykonania cen');
  return e;
}
async function frozen(c: PoolClient, id: string): Promise<FrozenRow[]> {
  return (
    await c.query(
      'SELECT index,product_id,sku,name,kind,product_version,input,status,before,after,errors FROM price_bulk_edit_rows WHERE preview_id=$1 ORDER BY index',
      [id],
    )
  ).rows as FrozenRow[];
}
function scope(frame: any, rows: FrozenRow[]) {
  return priceBulkEditHash({
    list_snapshot: frame.list,
    repricing_snapshot: frame.repricing_snapshot,
    warnings: frame.warnings,
    rows,
  });
}

export async function priceBulkEditMetadata(
  a: Actor,
  query: z.input<typeof priceBulkEditMetadataQuery> = {},
) {
  const q = priceBulkEditMetadataQuery.parse(query);
  return tenantTx(a.tenantId, async (c) => {
    const lists = (
        await c.query(
          "SELECT id,name,currency,version,active,fallback,adjustment_bps,adjustment_amount FROM price_lists WHERE ($1::uuid IS NULL OR id>$1) AND ($2='' OR strpos(lower(name),lower($2))>0) ORDER BY id LIMIT 51",
          [q.cursor ?? null, q.search],
        )
      ).rows,
      more = lists.length > 50;
    if (more) lists.pop();
    const catalog_currency = (
      await c.query(
        "SELECT currency FROM tenants WHERE id=nullif(current_setting('app.tenant_id',true),'')::uuid",
      )
    ).rows[0].currency;
    return {
      ...access(await role(c, a)),
      catalog_currency,
      price_lists: lists,
      meta: { cursor: more ? lists.at(-1).id : null },
      limits: { products: 500, selection_products: 50, rows: 500, page: 50, body_bytes: 786432 },
    };
  });
}
export async function priceBulkEditSelection(
  a: Actor,
  query: z.infer<typeof priceBulkEditSelectionQuery>,
) {
  const q = priceBulkEditSelectionQuery.parse({
      ...query,
      ids: Array.isArray(query.ids) ? query.ids.join(',') : query.ids,
    }),
    ids = [...q.ids].sort(),
    identity = priceBulkEditHash({ price_list_id: q.price_list_id, ids });
  let offset = 0;
  if (q.cursor) {
    try {
      const v = z
        .tuple([z.string().length(64), z.number().int().min(0).max(499)])
        .parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
      ensure(v[0] === identity, 422, 'Kursor należy do innego zakresu');
      offset = v[1];
    } catch {
      ensure(false, 422, 'Nieprawidłowy kursor zakresu');
    }
  }
  return tenantTx(a.tenantId, async (c) => {
    const frame = await listFrame(c, q.price_list_id, true),
      values = await states(c, q.price_list_id, ids, true);
    const data = [...values].map(([id, s]) => {
      const v = snapshot(frame.list, s);
      return {
        product_id: id,
        product_version: s.product.version,
        sku: s.product.sku,
        name: s.product.name,
        kind: s.product.kind,
        active: s.product.active,
        ...v,
        editable: s.product.kind !== 'group',
        errors:
          v.issue === 'non_sellable_group'
            ? ['Grupa wariantów nie ma ceny sprzedaży']
            : v.issue === 'invalid_fallback'
              ? ['Wynik reguły fallback poza zakresem']
              : [],
      };
    });
    ensure(offset === 0 || offset < data.length, 422, 'Kursor poza zakresem');
    return {
      ...access(await role(c, a)),
      ...frame,
      data: data.slice(offset, offset + 50),
      meta: {
        total: data.length,
        cursor:
          offset + 50 < data.length
            ? Buffer.from(JSON.stringify([identity, offset + 50])).toString('base64url')
            : null,
      },
    };
  });
}
export type PriceBulkEditTransactionOptions = {
  productRuleRunId?: string;
  fileImportId?: string;
  matrixImportId?: string;
  authorize?: (c: PoolClient, a: PriceBulkEditActor, write: boolean) => Promise<Actor['role']>;
};
// Acquire every list/repricing parent before the shared product scope in a matrix.
export async function lockPriceBulkEditFramesInTx(c: PoolClient, ids: string[],readOnly=false) {
  const frames = new Map<string, Awaited<ReturnType<typeof listFrame>>>();
  for (const id of [...new Set(ids)].sort()) frames.set(id, await listFrame(c, id,readOnly));
  return frames;
}
export async function createPriceBulkEditPreview(
  a: PriceBulkEditActor,
  input: PriceBulkEditInput,
  source: 'manual' | 'api' | 'product_rule' = 'manual',
) {
  return tenantTx(a.tenantId, (c) => createPriceBulkEditPreviewInTx(c, a, input, source));
}
export async function executePriceBulkEdit(
  a: PriceBulkEditActor,
  previewId: string,
  input: z.input<typeof priceBulkEditExecuteInput>,
  source: 'manual' | 'api' | 'product_rule' = 'manual',
) {
  return tenantTx(a.tenantId, (c) => executePriceBulkEditInTx(c, a, previewId, input, source));
}
export async function createPriceBulkEditPreviewInTx(
  c: PoolClient,
  a: PriceBulkEditActor,
  input: PriceBulkEditInput,
  source: 'manual' | 'api' | 'product_rule' = 'manual',
  internal: PriceBulkEditTransactionOptions = {},
) {
  const b = priceBulkEditPreviewInput.parse(input),
    hash = requestHash(b, source);
  if (source === 'product_rule') await assertProductRulePriceChildInTx(c, a, internal.productRuleRunId, b);
  else ensure(!internal.productRuleRunId, 409, 'Rodzic reguły wymaga własnego źródła cen');
  await admission(c, a);
  const old = (
    await c.query('SELECT * FROM price_bulk_edit_previews WHERE client_key=$1', [b.client_key])
  ).rows[0];
  if (old) {
    ensure(
      old.actor_id === a.userId && old.request_hash === hash,
      409,
      'Klucz podglądu ma inny aktor lub zakres',
    );
    return {
      ...access(await (internal.authorize ?? role)(c, a, true)),
      preview: previewHead(old),
      reused: true,
    };
  }
  await quota(c, 'previews');
  const frame = await listFrame(c, b.price_list_id),
    values = await states(c, b.price_list_id, [...new Set(b.rows.map((r) => r.product_id))].sort()),
    rows = plan(b, frame.list, values),
    sum = summary(rows),
    id = randomUUID();
  if (sum.changed && frame.list.version === 2147483647)
    for (const row of rows) {
      row.status = 'invalid';
      row.after = null;
      row.errors.push('Wersja cennika wyczerpała zakres integer');
    }
  const final = summary(rows),
    r = await (internal.authorize ?? role)(c, a, true);
  const p = (
    await c.query(
      `INSERT INTO price_bulk_edit_previews(id,tenant_id,actor_id,price_list_id,client_key,request_hash,scope_hash,source,list_snapshot,repricing_snapshot,warnings,total,changed,unchanged,invalid,conflicts,missing_after_count,ready) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        id,
        a.tenantId,
        a.userId,
        b.price_list_id,
        b.client_key,
        hash,
        scope(frame, rows),
        source,
        JSON.stringify(frame.list),
        JSON.stringify(frame.repricing_snapshot),
        JSON.stringify(frame.warnings),
        final.total,
        final.changed,
        final.unchanged,
        final.invalid,
        final.conflicts,
        final.missing_after_count,
        final.ready,
      ],
    )
  ).rows[0];
  await c.query(
    `INSERT INTO price_bulk_edit_rows(tenant_id,preview_id,index,product_id,sku,name,kind,product_version,input,status,before,after,errors) SELECT $1,$2,r.index,r.product_id,r.sku,r.name,r.kind,r.product_version,r.input,r.status,r.before,r.after,r.errors FROM jsonb_to_recordset($3::jsonb)r(index int,product_id uuid,sku text,name text,kind text,product_version int,input jsonb,status text,before jsonb,after jsonb,errors jsonb)`,
    [a.tenantId, id, JSON.stringify(rows)],
  );
  await audit(c, a, 'pricing.bulk.preview', id, {
    price_list_id: b.price_list_id,
    total: final.total,
    scope_hash: p.scope_hash,
  });
  return { ...access(r), preview: previewHead(p), reused: false };
}
export async function executePriceBulkEditInTx(
  c: PoolClient,
  a: PriceBulkEditActor,
  previewId: string,
  input: z.input<typeof priceBulkEditExecuteInput>,
  source: 'manual' | 'api' | 'product_rule' = 'manual',
  internal: PriceBulkEditTransactionOptions = {},
) {
  const b = priceBulkEditExecuteInput.parse(input),
    hash = requestHash({ preview_id: previewId, ...b }, source);
  if (source === 'product_rule') {
    const parent = await preview(c, previewId);
    const rows = await frozen(c, previewId);
    await assertProductRulePriceChildInTx(c, a, internal.productRuleRunId, {client_key:parent.client_key,price_list_id:parent.price_list_id,list_version:parent.list_snapshot.version,rows:rows.map(r=>r.input)});
  } else ensure(!internal.productRuleRunId, 409, 'Rodzic reguły wymaga własnego źródła cen');
  await admission(c, a);
  const fileLedger = (
    await c.query(
      "SELECT to_regclass('public.price_file_import_previews') t,to_regprocedure('public.price_file_import_installed()') installed",
    )
  ).rows[0];
  if (!fileLedger.t && fileLedger.installed)
    ensure(
      !(await c.query('SELECT price_file_import_installed() installed')).rows[0].installed,
      503,
      'Niekompletny moduł importu pliku cen',
    );
  if (fileLedger.t) {
    const linked = (
      await c.query('SELECT id FROM price_file_import_previews WHERE core_preview_id=$1', [
        previewId,
      ])
    ).rows[0];
    ensure(
      !linked || linked.id === internal.fileImportId,
      409,
      'Podgląd pliku wymaga wykonania przez import cen',
    );
  }
  const matrixLedger = (
    await c.query(
      "SELECT to_regclass('public.price_matrix_import_previews') t,to_regprocedure('public.price_matrix_import_installed()') installed",
    )
  ).rows[0];
  if (!matrixLedger.t && matrixLedger.installed)
    ensure(
      !(await c.query('SELECT price_matrix_import_installed() installed')).rows[0].installed,
      503,
      'Niekompletny moduł importu macierzy cen',
    );
  if (matrixLedger.t) {
    const linked = (
      await c.query(
        "SELECT id FROM price_matrix_import_previews WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(targets) target WHERE target->>'core_preview_id'=$1)",
        [previewId],
      )
    ).rows[0];
    ensure(
      !linked || linked.id === internal.matrixImportId,
      409,
      'Podgląd macierzy wymaga wykonania przez import macierzy cen',
    );
  }
  const old = (
    await c.query('SELECT * FROM price_bulk_edit_executions WHERE client_key=$1', [b.client_key])
  ).rows[0];
  if (old) {
    ensure(
      old.actor_id === a.userId && old.request_hash === hash,
      409,
      'Klucz wykonania ma inny aktor lub zakres',
    );
    return {
      ...access(await (internal.authorize ?? role)(c, a, true)),
      execution: executionHead(old),
      reused: true,
    };
  }
  const p = await preview(c, previewId);
  ensure(
    p.actor_id === a.userId && p.source === source && p.scope_hash === b.scope_hash && p.ready,
    409,
    'Podgląd niegotowy lub zgoda ma inny zakres',
  );
  ensure(
    p.missing_after_count === 0 || b.ack_missing_prices,
    422,
    'Potwierdź osobno produkty bez ceny po wykonaniu',
  );
  ensure(
    !(await c.query('SELECT id FROM price_bulk_edit_executions WHERE preview_id=$1', [p.id]))
      .rowCount,
    409,
    'Podgląd ma wykonanie; ponów zapisany klucz',
  );
  await quota(c, 'executions');
  const rows = await frozen(c, p.id),
    frozenFrame = {
      list: p.list_snapshot,
      repricing_snapshot: p.repricing_snapshot,
      warnings: p.warnings,
    };
  ensure(
    rows.length === p.total &&
      rows.every((r, i) => r.index === i) &&
      scope(frozenFrame, rows) === p.scope_hash,
    409,
    'Niezgodny pełny scope podglądu',
  );
  const frame = await listFrame(c, p.price_list_id);
  ensure(
    priceBulkEditHash(frame) === priceBulkEditHash(frozenFrame),
    409,
    'Cennik, reguła, harmonogram lub przebieg repricingu zmieniły się',
  );
  const ids = rows.map((r) => r.product_id).sort(),
    values = await states(c, p.price_list_id, ids),
    request: PriceBulkEditInput = {
      client_key: p.client_key,
      price_list_id: p.price_list_id,
      list_version: p.list_snapshot.version,
      rows: rows.map((r) => r.input),
    },
    current = plan(request, frame.list, values);
  ensure(
    summary(current).ready && priceBulkEditHash(current) === priceBulkEditHash(rows),
    409,
    'Produkt, VAT, cena lub jej źródło zmieniły się; cała partia odrzucona',
  );
  const changed = rows.filter((r) => r.status === 'changed');
  if (changed.length) {
    ensure(frame.list.version < 2147483647, 409, 'Wersja cennika wyczerpała zakres integer');
    const remove = changed.filter((r) => !r.after!.override_present).map((r) => r.product_id);
    await c.query(
      'DELETE FROM price_list_items WHERE price_list_id=$1 AND product_id=ANY($2::uuid[])',
      [p.price_list_id, remove],
    );
    const set = changed
      .filter((r) => r.after!.override_present)
      .map((r) => ({ product_id: r.product_id, price: r.after!.override_price }));
    await c.query(
      `INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) SELECT $1,$2,product_id,price FROM jsonb_to_recordset($3::jsonb)x(product_id uuid,price int) ON CONFLICT(tenant_id,price_list_id,product_id) DO UPDATE SET price=excluded.price`,
      [a.tenantId, p.price_list_id, JSON.stringify(set)],
    );
    await c.query('UPDATE price_lists SET version=version+1,updated_at=now() WHERE id=$1', [
      p.price_list_id,
    ]);
  }
  if (!internal.matrixImportId && !internal.productRuleRunId) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const finalValues = await states(c, p.price_list_id, ids);
  for (const row of rows)
    ensure(
      priceBulkEditHash(snapshot(frame.list, finalValues.get(row.product_id)!)) ===
        priceBulkEditHash(row.after),
      409,
      'Rzeczywista końcowa cena różni się od zatwierdzonej',
    );
  const finalList = (
    await c.query('SELECT version FROM price_lists WHERE id=$1', [p.price_list_id])
  ).rows[0];
  ensure(
    finalList.version === frame.list.version + (changed.length ? 1 : 0),
    409,
    'Niezgodna końcowa wersja listy',
  );
  if (internal.fileImportId || internal.matrixImportId || internal.productRuleRunId)
    await c.query('SET CONSTRAINTS ALL DEFERRED');
  const r = await (internal.authorize ?? role)(c, a, true),
    id = randomUUID();
  const e = (
    await c.query(
      `INSERT INTO price_bulk_edit_executions(id,tenant_id,preview_id,actor_id,price_list_id,client_key,request_hash,scope_hash,list_snapshot,repricing_snapshot,warnings,total,changed,unchanged,missing_after_count,ack_missing_prices,before_list_version,after_list_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        id,
        a.tenantId,
        p.id,
        a.userId,
        p.price_list_id,
        b.client_key,
        hash,
        p.scope_hash,
        JSON.stringify(p.list_snapshot),
        JSON.stringify(p.repricing_snapshot),
        JSON.stringify(p.warnings),
        p.total,
        p.changed,
        p.unchanged,
        p.missing_after_count,
        b.ack_missing_prices,
        frame.list.version,
        finalList.version,
      ],
    )
  ).rows[0];
  const results = rows.map((row) => ({
    index: row.index,
    product_id: row.product_id,
    sku: row.sku,
    name: row.name,
    input: row.input,
    operation: row.input.operation,
    status: row.status,
    before: row.before,
    after: row.after,
    before_list_version: frame.list.version,
    after_list_version: finalList.version,
  }));
  await c.query(
    `INSERT INTO price_bulk_edit_execution_rows(tenant_id,execution_id,preview_id,index,product_id,sku,name,input,operation,status,before,after,before_list_version,after_list_version) SELECT $1,$2,$3,r.index,r.product_id,r.sku,r.name,r.input,r.operation,r.status,r.before,r.after,r.before_list_version,r.after_list_version FROM jsonb_to_recordset($4::jsonb)r(index int,product_id uuid,sku text,name text,input jsonb,operation text,status text,before jsonb,after jsonb,before_list_version int,after_list_version int)`,
    [a.tenantId, id, p.id, JSON.stringify(results)],
  );
  await audit(c, a, 'pricing.bulk.execute', id, {
    preview_id: p.id,
    price_list_id: p.price_list_id,
    total: p.total,
    changed: p.changed,
    before_list_version: frame.list.version,
    after_list_version: finalList.version,
  });
  return { ...access(r), execution: executionHead(e), reused: false };
}
export async function priceBulkEditPreviewDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => ({
    preview: previewHead(await preview(c, id)),
    ...access(await role(c, a)),
  }));
}
export async function priceBulkEditExecutionDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => ({
    execution: executionHead(await execution(c, id)),
    ...access(await role(c, a)),
  }));
}
async function pagedRows(
  a: Actor,
  id: string,
  cursor: string | undefined,
  kind: 'preview' | 'execution',
) {
  const offset = cursor === undefined ? 0 : z.coerce.number().int().min(0).max(499).parse(cursor);
  return tenantTx(a.tenantId, async (c) => {
    const head = kind === 'preview' ? await preview(c, id) : await execution(c, id);
    ensure(offset === 0 || offset < head.total, 422, 'Kursor poza zakresem');
    const data = (
      await c.query(
        `SELECT ${kind === 'preview' ? 'index,product_id,sku,name,kind,product_version,input,status,before,after,errors' : 'index,product_id,sku,name,input,operation,status,before,after,before_list_version,after_list_version'} FROM price_bulk_edit_${kind === 'preview' ? 'rows' : 'execution_rows'} WHERE ${kind === 'preview' ? 'preview_id' : 'execution_id'}=$1 AND index>=$2 ORDER BY index LIMIT 50`,
        [id, offset],
      )
    ).rows;
    return {
      ...access(await role(c, a)),
      data,
      meta: { cursor: offset + 50 < head.total ? String(offset + 50) : null },
    };
  });
}
export const priceBulkEditPreviewRows = (a: Actor, id: string, cursor?: string) =>
  pagedRows(a, id, cursor, 'preview');
export const priceBulkEditExecutionRows = (a: Actor, id: string, cursor?: string) =>
  pagedRows(a, id, cursor, 'execution');
export async function priceBulkEditHistory(a: Actor, cursor?: string) {
  let page: [string, string] | null = null;
  if (cursor) {
    try {
      page = z
        .tuple([z.iso.datetime({ precision: 6 }), z.uuid()])
        .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    } catch {
      ensure(false, 422, 'Nieprawidłowy kursor historii');
    }
  }
  return tenantTx(a.tenantId, async (c) => {
    const rows = (
        await c.query(
          `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM price_bulk_edit_executions WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,
          [page?.[0] ?? null, page?.[1] ?? null],
        )
      ).rows,
      more = rows.length > 50;
    if (more) rows.pop();
    return {
      ...access(await role(c, a)),
      data: rows.map(executionHead),
      meta: {
        cursor: more
          ? Buffer.from(JSON.stringify([rows.at(-1).cursor_time, rows.at(-1).id])).toString(
              'base64url',
            )
          : null,
      },
    };
  });
}

export async function productRulePriceFramesInTx(c:PoolClient,ids:string[],products:string[],writing=false){
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`price.bulk:${(await c.query("SELECT current_setting('app.tenant_id') tenant")).rows[0].tenant}`]);
  const frames=await lockPriceBulkEditFramesInTx(c,ids,!writing);
  const result=new Map<string,Record<string,unknown>>();
  // Native catalog helper reads owner-only assignments under the caller's
  // existing catalog mutex; no grant on the private assignment table is needed.
  const options=await productCatalogOptionsInTx(c),catalogued=options!==null;
  const definitions=catalogued?(await c.query('SELECT id,catalog_id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id',[products])).rows:[];
  for(const id of [...frames.keys()].sort()){
    const frame=frames.get(id)!;
    // Availability/assignment/basis refusal belongs to reached actions, not unrelated products.
    const assignments=options?options.catalogs.filter(catalog=>catalog.price_list_ids.includes(id)).map(catalog=>({catalog_id:catalog.id,price_list_id:id})).sort((a,b)=>a.catalog_id.localeCompare(b.catalog_id)):null;
    const values=await states(c,id,products,true);
    for(const product of products){
      const state=values.get(product)!;
      const snap=snapshot(frame.list,state);

      const prior=result.get(product)??{};
      prior[id]={frame,snapshot:snap,assignments,assigned:!catalogued||assignments?.some((a:any)=>a.catalog_id===definitions.find((p:any)=>p.id===product)?.catalog_id)};result.set(product,prior);
    }
  }
  return result;
}
