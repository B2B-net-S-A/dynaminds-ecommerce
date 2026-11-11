import { randomUUID, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx } from './db';
import { ensure } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import { audit } from './domain';
import {
  createPriceBulkEditPreviewInTx,
  executePriceBulkEditInTx,
  priceBulkEditHash,
  priceBulkEditMetadata,
  type PriceBulkEditActor,
} from './price-bulk-edit';
import { parsePriceFile, parsePriceFileAmount, priceFileCell } from './price-file-import-parse';
import {
  priceFileImportPreviewInput,
  priceFileImportExecuteInput,
  priceFileImportProfileInput,
  priceFileImportProfileUpdateInput,
  priceFileImportPageQuery,
  priceFileImportRowsQuery,
  PRICE_FILE_IMPORT_LIMITS as L,
  type PriceFileImportInput,
  type PriceFileImportRow,
} from './price-file-import-schema';
export * from './price-file-import-schema';
type Row = Record<string, any>;
const tables = [
  'price_file_import_previews',
  'price_file_import_executions',
  'price_file_import_profiles',
  'price_file_import_profile_revisions',
  'price_file_import_core_witnesses',
  'price_bulk_edit_previews',
  'price_bulk_edit_rows',
  'price_bulk_edit_executions',
  'price_bulk_edit_execution_rows',
];
export async function priceFileImportAvailable(c: Pool | PoolClient) {
  const guards: Array<[string, string, string, boolean]> = [];
  for (const t of [
    'price_file_import_previews',
    'price_file_import_executions',
    'price_file_import_profile_revisions',
  ])
    guards.push(
      [t, 'immutable', 'price_file_import_immutable()', false],
      [t, 'budget', 'price_file_import_budget()', false],
      [t, 'complete', 'price_file_import_complete()', true],
    );
  guards.push(
    ['price_file_import_profiles', 'no_delete', 'price_file_import_immutable()', false],
    ['price_file_import_profiles', 'complete', 'price_file_import_complete()', true],
    ['price_bulk_edit_executions', 'price_file_receipt', 'price_file_import_receipt()', true],
  );
  for (const t of ['price_bulk_edit_previews', 'price_bulk_edit_executions'])
    guards.push(
      [t, 'price_file_witness', 'price_file_import_core_witness()', false],
      [t, 'price_file_witness_cleanup', 'price_file_import_core_witness()', true],
    );
  for (const t of [
    'products',
    'product_sku_aliases',
    'price_lists',
    'price_list_items',
    'tenants',
    'repricing_rules',
    'repricing_schedules',
    'repricing_runs',
  ])
    guards.push([t, 'price_file_seal', 'price_file_import_seal()', false]);
  for (const t of [
    'price_bulk_edit_previews',
    'price_bulk_edit_rows',
    'price_bulk_edit_executions',
    'price_bulk_edit_execution_rows',
  ])
    guards.push([t, 'immutable', 'price_bulk_edit_immutable()', false]);
  guards.push(
    ['price_bulk_edit_rows', 'price_bulk_edit_row_scope', 'price_bulk_edit_scope()', false],
    [
      'price_bulk_edit_executions',
      'price_bulk_edit_execution_scope',
      'price_bulk_edit_scope()',
      false,
    ],
    [
      'price_bulk_edit_execution_rows',
      'price_bulk_edit_execution_row_scope',
      'price_bulk_edit_scope()',
      false,
    ],
  );
  const functions = [
    'price_file_import_access(uuid,uuid,boolean,boolean)',
    'price_file_import_store_preview(jsonb,uuid,uuid)',
    'price_file_import_store_execution(jsonb,uuid,uuid)',
    'price_file_import_store_profile(jsonb,uuid,uuid)',
    'price_file_import_require(uuid,uuid,boolean)',
    'price_file_import_definition(jsonb)',
    'price_file_import_cell(jsonb,boolean,text)',
    'price_file_import_snapshot(jsonb,jsonb,boolean,integer)',
    'price_file_import_execution_valid(uuid)',
    'price_file_import_installed()',
    'price_file_import_seal()',
  ];
  const r = (
    await c.query(
      `SELECT NOT EXISTS(SELECT 1 FROM unnest($1::text[]) n WHERE NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace s ON s.oid=t.relnamespace WHERE s.nspname='public' AND t.relname=n AND t.relrowsecurity AND t.relforcerowsecurity)) AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n WHERE to_regprocedure(n) IS NULL) AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) x(t text,n text,f text,deferred boolean) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=to_regclass('public.'||x.t) AND g.tgname=x.n AND g.tgfoid=to_regprocedure(x.f) AND g.tgenabled='O' AND (NOT x.deferred OR (g.tgdeferrable AND g.tginitdeferred)))) ok`,
      [
        tables,
        functions,
        JSON.stringify(guards.map(([t, n, f, deferred]) => ({ t, n, f, deferred }))),
      ],
    )
  ).rows[0];
  return !!r.ok;
}
async function fileTx<T>(a: PriceBulkEditActor, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await tenantTx(a.tenantId, async (c) => {
      ensure(await priceFileImportAvailable(c), 503, 'Niekompletny moduł importu pliku cen');
      return fn(c);
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === '23514' && err.message === 'Brak aktualnej zgody na import cen')
      ensure(false, 403, err.message);
    if (err.code === '23514' && err.message === 'Wycofany klucz importu cen')
      ensure(false, 401, err.message);
    if (
      err.code === 'P0001' &&
      [
        'Limit historii importu cen',
        'Limit bajtów historii importu cen',
        'Limit profili importu cen',
        'Limit rewizji profili importu cen',
      ].includes(err.message ?? '')
    )
      ensure(false, 429, err.message!);
    throw e;
  }
}

async function access(c: PoolClient, a: PriceBulkEditActor, writing = false, pin = false) {
  const v = (
    await c.query('SELECT price_file_import_access($1,$2,$3,$4) result', [
      a.userId,
      a.apiKeyId ?? null,
      writing,
      pin,
    ])
  ).rows[0].result;
  ensure(v?.role, 403, 'Brak aktualnego członkostwa');
  ensure(v.key_valid !== false, 401, 'Klucz API wygasł lub został wycofany');
  ensure(v.allowed, 403, 'Brak aktualnej roli lub scopes products');
  return {
    current_role: v.role as 'admin' | 'operator' | 'viewer',
    can_read: true,
    can_write: !!v.can_write,
  };
}
const authorize = async (c: PoolClient, a: PriceBulkEditActor, write: boolean) =>
  (await access(c, a, write)).current_role;
async function admit(c: PoolClient, a: PriceBulkEditActor) {
  await access(c, a, true);
  await c.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended('catalog:'||$1,0)),pg_advisory_xact_lock(hashtextextended('price.bulk:'||$1,0)),pg_advisory_xact_lock(hashtextextended('price.file:'||$1,0))",
    [a.tenantId],
  );
}
async function finish(c: PoolClient, a: PriceBulkEditActor, result: Row, write = false) {
  if (write) {
    try {
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === '23514' && err.message === 'Brak aktualnej zgody na import cen')
        ensure(false, 403, 'Brak aktualnej zgody na import cen');
      if (err.code === '23514' && err.message === 'Wycofany klucz importu cen')
        ensure(false, 401, 'Klucz API wygasł lub został wycofany');
      throw e;
    }
  }
  return { ...result, ...(await access(c, a, write, write)) };
}
function head(p: Row) {
  return {
    id: p.id,
    actor_id: p.actor_id,
    price_list_id: p.price_list_id,
    file_name: p.file_name,
    source_hash: p.source_hash,
    definition: p.definition,
    list_snapshot: p.list_snapshot,
    warnings: p.warnings,
    summary: p.summary,
    scope_hash: p.scope_hash,
    core_preview_id: p.core_preview_id,
    execution_id: p.execution_id ?? null,
    can_execute: !!p.summary.ready && !p.execution_id,
    created_at: p.created_at,
  };
}
function executionHead(e: Row, p: Row) {
  return {
    ...head(p),
    id: e.id,
    preview_id: p.id,
    core_execution_id: e.core_execution_id,
    core_preview_id: p.core_preview_id,
    execution_id: e.id,
    can_execute: false,
    ack_missing_prices: e.ack_missing_prices,
    created_at: e.created_at,
  };
}
async function findPreview(c: PoolClient, id: string) {
  const p = (
    await c.query(
      'SELECT p.*,e.id execution_id FROM price_file_import_previews p LEFT JOIN price_file_import_executions e ON (e.tenant_id,e.preview_id)=(p.tenant_id,p.id) WHERE p.id=$1',
      [id],
    )
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu pliku cen');
  return p;
}
function digest(a: PriceBulkEditActor, request: unknown) {
  return priceBulkEditHash({ actor_id: a.userId, api_key_id: a.apiKeyId ?? null, request });
}
function summary(rows: PriceFileImportRow[]) {
  return {
    total: rows.length,
    changed: rows.filter((r) => r.status === 'changed').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    invalid: rows.filter((r) => r.status === 'invalid').length,
    conflicts: rows.filter((r) => r.status === 'conflict').length,
    missing_after_count: rows.filter((r) => (r.after as Row)?.source === 'missing').length,
    ready: rows.every((r) => r.status === 'changed' || r.status === 'unchanged'),
  };
}
export async function resolvePriceFileImportInTx(
  c: PoolClient,
  b: PriceFileImportInput,
  shared?: { parsed: ReturnType<typeof parsePriceFile>; products: Row[]; aliases: Row[] },
) {
  const parsed = shared?.parsed ?? parsePriceFile(b),
    d = b.definition,
    values = parsed.rows
      .map((r) =>
        priceFileCell(
          r.raw_cells[d.mapping.identity],
          d.format === 'csv' && d.spreadsheet_safe,
          d.identity,
        ),
      )
      .filter((v) => typeof v === 'string') as string[];
  // A deleted product (225) matches no file row: it reads as an unknown identifier.
  const products =
    shared?.products ??
    (
      await c.query(
        `SELECT p.id,p.sku,p.name,p.ean,p.version,p.kind,p.active,p.vat FROM products p WHERE CASE WHEN $1='uuid' THEN p.id::text=ANY($2::text[]) WHEN $1 IN ('sku','historical_sku') THEN p.sku=ANY($2::text[]) OR EXISTS(SELECT 1 FROM product_sku_aliases a WHERE (a.tenant_id,a.product_id)=(p.tenant_id,p.id) AND a.sku=ANY($2::text[])) WHEN $1='ean' THEN p.ean<>'' AND p.ean=ANY($2::text[]) ELSE p.name=ANY($2::text[]) END AND ${productNotDeletedSQL(await productDeletionsAvailable(c))} ORDER BY p.id FOR SHARE`,
        [d.identity, values],
      )
    ).rows;
  const aliases =
    shared?.aliases ??
    (d.identity === 'sku' || d.identity === 'historical_sku'
      ? (
          await c.query(
            'SELECT sku,product_id FROM product_sku_aliases WHERE sku=ANY($1::text[])',
            [values],
          )
        ).rows
      : []);
  const used = new Map<string, number[]>();
  const rows: PriceFileImportRow[] = parsed.rows.map((r, index) => {
    const identity = priceFileCell(
        r.raw_cells[d.mapping.identity],
        d.format === 'csv' && d.spreadsheet_safe,
        d.identity,
      ),
      value = typeof identity === 'string' ? identity : null,
      matches = products.filter((p) =>
        d.identity === 'uuid'
          ? p.id === value
          : d.identity === 'ean'
            ? p.ean === value
            : d.identity === 'name'
              ? p.name === value
              : p.sku === value || aliases.some((a) => a.product_id === p.id && a.sku === value),
      ),
      p = matches.length === 1 ? matches[0] : null;
    const row: PriceFileImportRow = {
      index,
      raw_cells: r.raw_cells,
      resolution: {
        identity: d.identity,
        value,
        matched_historical_sku:
          !!p && ['sku', 'historical_sku'].includes(d.identity) && p.sku !== value,
      },
      product_id: p?.id ?? null,
      sku: p?.sku ?? null,
      name: p?.name ?? null,
      input: null,
      status: 'invalid',
      before: null,
      after: null,
      errors: [...r.errors],
      skipped_price_groups: 0,
    };
    if (d.native_price_mode === 'mapped') {
      for (const field of [d.mapping.operation, d.mapping.currency].filter(Boolean) as string[])
        if (!Object.hasOwn(r.raw_cells, field)) row.errors.push('Brak mapowanego pola: ' + field);
    }
    if (!value) row.errors.push('Brak identyfikatora');
    else if (matches.length !== 1)
      row.errors.push(
        matches.length ? 'Niejednoznaczny identyfikator' : 'Nieznany lub obcy identyfikator',
      );
    if (p) {
      const indices = used.get(p.id) ?? [];
      indices.push(index);
      used.set(p.id, indices);
      try {
        let operation: unknown = d.mapping.operation
            ? priceFileCell(
                r.raw_cells[d.mapping.operation],
                d.format === 'csv' && d.spreadsheet_safe,
              )
            : undefined,
          amount = priceFileCell(
            r.raw_cells[d.mapping.price],
            d.format === 'csv' && d.spreadsheet_safe,
          ),
          currency = d.mapping.currency
            ? priceFileCell(
                r.raw_cells[d.mapping.currency],
                d.format === 'csv' && d.spreadsheet_safe,
              )
            : undefined;
        if (d.native_price_mode === 'own_entries') {
          ensure(d.mapping.price === 'prices_json', 422, 'Natywny XML wymaga prices_json');
          const entries = r.raw_cells.prices_json;
          ensure(
            Array.isArray(entries) &&
              entries.length <= 500 &&
              entries.every((e) => e !== null && typeof e === 'object' && !Array.isArray(e)),
            422,
            'Brak poprawnej tablicy własnych cen',
          );
          const selected = entries.filter((e: Row) => e.price_list_id === b.price_list_id);
          ensure(selected.length === 1, 422, 'Brak jednoznacznej grupy wybranego cennika');
          const entry = selected[0];
          currency = entry.currency;
          row.skipped_price_groups = entries.length - 1;
          if (entry.source === 'override' && entry.status === 'available') {
            operation = 'set';
            amount = entry.own_price_minor;
            ensure(Number.isSafeInteger(amount), 422, 'Własny override musi zawierać kwotę minor');
          } else {
            ensure(
              ((entry.source === 'rule' && entry.status === 'available') ||
                (entry.source === null && entry.status === 'missing')) &&
                entry.own_price_minor === null,
              422,
              'Nieprawidłowe źródło własnego wpisu',
            );
            operation = 'remove';
          }
        }
        if (currency !== undefined)
          ensure(
            typeof currency === 'string' && currency.length > 0,
            422,
            'Brak waluty w mapowanym polu',
          );
        const empty = amount === null || amount === undefined || amount === '';
        if (operation === undefined || operation === '')
          operation = !Object.hasOwn(r.raw_cells, d.mapping.price)
            ? 'none'
            : empty
              ? d.empty_policy === 'skip'
                ? 'none'
                : 'remove'
              : 'set';
        ensure(
          ['none', 'set', 'remove'].includes(String(operation)),
          422,
          'Nieznana operacja (none/set/remove)',
        );
        row.input =
          operation === 'set'
            ? {
                product_id: p.id,
                product_version: p.version,
                operation: 'set',
                basis: d.native_price_mode === 'own_entries' ? 'gross' : d.basis,
                amount_minor: parsePriceFileAmount(
                  amount,
                  d.native_price_mode === 'own_entries' ? 'minor' : d.amount_mode,
                  d.decimal_separator,
                ),
              }
            : {
                product_id: p.id,
                product_version: p.version,
                operation: operation as 'none' | 'remove',
              };
        (row as PriceFileImportRow & { mapped_currency?: unknown }).mapped_currency = currency;
      } catch (e) {
        row.errors.push((e as Error).message);
      }
    }
    return row;
  });
  for (const indices of used.values())
    if (indices.length > 1)
      for (const index of indices) rows[index].errors.push('Powtórzony produkt w pliku');
  return { rows, currency: parsed.currency, shared: { parsed, products, aliases } };
}
export async function priceFileImportOptions(
  a: PriceBulkEditActor,
  q: Parameters<typeof priceBulkEditMetadata>[1] = {},
) {
  return fileTx(a, async (c) => {
    await access(c, a);
    const lists = (
        await c.query(
          "SELECT id,name,currency,version,active,fallback,adjustment_bps,adjustment_amount FROM price_lists WHERE ($1::uuid IS NULL OR id>$1) AND ($2='' OR strpos(lower(name),lower($2))>0) ORDER BY id LIMIT 51",
          [q.cursor ?? null, q.search ?? ''],
        )
      ).rows,
      more = lists.length > 50;
    if (more) lists.pop();
    return finish(c, a, {
      catalog_currency: (await c.query('SELECT currency FROM tenants WHERE id=$1', [a.tenantId]))
        .rows[0].currency,
      price_lists: lists,
      meta: { cursor: more ? lists.at(-1).id : null },
      limits: L,
    });
  });
}
export async function createPriceFileImportPreview(
  a: PriceBulkEditActor,
  input: z.input<typeof priceFileImportPreviewInput>,
) {
  const b = priceFileImportPreviewInput.parse(input),
    hash = digest(a, b);
  return fileTx(a, async (c) => {
    await admit(c, a);
    const old = (
      await c.query(
        'SELECT id,request_hash,actor_id FROM price_file_import_previews WHERE client_key=$1',
        [b.client_key],
      )
    ).rows[0];
    if (old) {
      ensure(
        old.actor_id === a.userId && old.request_hash === hash,
        409,
        'Klucz podglądu ma inny zakres lub aktora',
      );
      return finish(c, a, { preview: head(await findPreview(c, old.id)), reused: true }, true);
    }
    const list = (
      await c.query(
        'SELECT id,name,currency,version,active,fallback,adjustment_bps,adjustment_amount FROM price_lists WHERE id=$1 FOR UPDATE',
        [b.price_list_id],
      )
    ).rows[0];
    ensure(list, 404, 'Nie znaleziono własnego cennika');
    const resolved = await resolvePriceFileImportInTx(c, b),
      rows = resolved.rows,
      id = randomUUID(),
      valid = rows.filter((r) => r.input && !r.errors.length);
    for (const r of rows) {
      const currency = (r as Row).mapped_currency;
      if (currency !== undefined && currency !== list.currency)
        r.errors.push('Waluta wiersza nie odpowiada wybranemu cennikowi');
      if (
        b.definition.format === 'xml' &&
        b.definition.native_price_mode === 'mapped' &&
        resolved.currency !== list.currency
      )
        r.errors.push('Waluta XML nie odpowiada wybranemu cennikowi');
      delete (r as Row).mapped_currency;
    }
    let core: Row | null = null;
    const clean = valid.filter((r) => !r.errors.length);
    if (clean.length) {
      core = await createPriceBulkEditPreviewInTx(
        c,
        a,
        {
          client_key: id,
          price_list_id: b.price_list_id,
          list_version: b.list_version,
          rows: clean.map((r) => r.input!),
        },
        a.apiKeyId ? 'api' : 'manual',
        { authorize },
      );
      const coreRows = (
        await c.query('SELECT * FROM price_bulk_edit_rows WHERE preview_id=$1 ORDER BY index', [
          core!.preview.id,
        ])
      ).rows;
      for (let i = 0; i < clean.length; i++) {
        const r = clean[i],
          cr = coreRows[i];
        r.status = cr.status;
        r.before = cr.before;
        r.after = cr.after;
        r.errors.push(...cr.errors);
      }
    }
    for (const r of rows)
      if (r.errors.length) {
        if (r.status !== 'conflict') r.status = 'invalid';
        r.after = null;
      }
    const sum = summary(rows),
      payload = {
        id,
        client_key: b.client_key,
        request_hash: hash,
        price_list_id: b.price_list_id,
        file_name: b.file_name,
        source_hash: createHash('sha256').update(b.content).digest('hex'),
        definition: b.definition,
        list_snapshot: core?.preview.list_snapshot ?? list,
        warnings: core?.preview.warnings ?? (!list.active ? ['price_list_inactive'] : []),
        summary: sum,
        rows,
        core_preview_id: core?.preview.id ?? null,
        source: a.apiKeyId ? 'api' : 'manual',
      };
    ensure(
      Buffer.byteLength(JSON.stringify(payload)) <= L.preview_bytes,
      413,
      'Pełny podgląd przekracza 8 MiB',
    );
    const scope_hash = priceBulkEditHash(payload);
    await c.query('SELECT price_file_import_store_preview($1,$2,$3)', [
      JSON.stringify({ ...payload, scope_hash }),
      a.userId,
      a.apiKeyId ?? null,
    ]);
    await audit(c, a, 'pricing.file.preview', id, {
      price_list_id: b.price_list_id,
      source_hash: payload.source_hash,
      total: sum.total,
    });
    return finish(c, a, { preview: head(await findPreview(c, id)), reused: false }, true);
  });
}
export async function executePriceFileImport(
  a: PriceBulkEditActor,
  id: string,
  input: z.input<typeof priceFileImportExecuteInput>,
) {
  const b = priceFileImportExecuteInput.parse(input),
    hash = digest(a, { preview_id: id, ...b });
  return fileTx(a, async (c) => {
    await admit(c, a);
    const old = (
      await c.query('SELECT * FROM price_file_import_executions WHERE client_key=$1', [
        b.client_key,
      ])
    ).rows[0];
    if (old) {
      ensure(
        old.actor_id === a.userId && old.request_hash === hash && old.preview_id === id,
        409,
        'Klucz wykonania ma inny zakres lub aktora',
      );
      return finish(
        c,
        a,
        { execution: executionHead(old, await findPreview(c, id)), reused: true },
        true,
      );
    }
    const p = await findPreview(c, id);
    ensure(
      p.actor_id === a.userId &&
        p.api_key_id === (a.apiKeyId ?? null) &&
        p.scope_hash === b.scope_hash &&
        p.summary.ready &&
        p.core_preview_id &&
        !p.execution_id,
      409,
      'Podgląd niegotowy, wykonany lub zgoda ma inny zakres',
    );
    ensure(
      !p.summary.missing_after_count || b.ack_missing_prices,
      422,
      'Potwierdź osobno brakujące ceny',
    );
    // Identity is re-resolved from frozen source cells: aliases, EAN and names cannot silently rebind.
    const deletions = await productDeletionsAvailable(c);
    const products = (
      await c.query(
        'SELECT id,sku,name,ean FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [p.rows.map((r: Row) => r.product_id)],
      )
    ).rows;
    for (const r of p.rows) {
      const d = p.definition,
        value = r.resolution.value;
      const matches = (
        await c.query(
          `SELECT id FROM products WHERE CASE WHEN $1='uuid' THEN id::text=$2 WHEN $1 IN ('sku','historical_sku') THEN sku=$2 OR EXISTS(SELECT 1 FROM product_sku_aliases x WHERE (x.tenant_id,x.product_id)=(products.tenant_id,products.id) AND x.sku=$2) WHEN $1='ean' THEN ean<>'' AND ean=$2 ELSE name=$2 END AND ${productNotDeletedSQL(deletions, 'products')}`,
          [d.identity, value],
        )
      ).rows;
      ensure(
        matches.length === 1 &&
          matches[0].id === r.product_id &&
          products.some((x) => x.id === r.product_id),
        409,
        'Mapowanie identyfikatora zmieniło się',
      );
    }
    const core = await executePriceBulkEditInTx(
        c,
        a,
        p.core_preview_id,
        {
          ...b,
          client_key: randomUUID(),
          scope_hash: (
            await c.query('SELECT scope_hash FROM price_bulk_edit_previews WHERE id=$1', [
              p.core_preview_id,
            ])
          ).rows[0].scope_hash,
        },
        p.source,
        { fileImportId: p.id, authorize },
      ),
      eid = randomUUID();
    await c.query('SELECT price_file_import_store_execution($1,$2,$3)', [
      JSON.stringify({
        id: eid,
        preview_id: id,
        client_key: b.client_key,
        request_hash: hash,
        scope_hash: p.scope_hash,
        core_execution_id: core.execution.id,
        ack_missing_prices: b.ack_missing_prices,
      }),
      a.userId,
      a.apiKeyId ?? null,
    ]);
    await audit(c, a, 'pricing.file.execute', eid, {
      preview_id: id,
      core_execution_id: core.execution.id,
    });
    const e = (await c.query('SELECT * FROM price_file_import_executions WHERE id=$1', [eid]))
      .rows[0];
    return finish(c, a, { execution: executionHead(e, p), reused: false }, true);
  });
}
export async function priceFileImportPreviewDetail(a: PriceBulkEditActor, id: string) {
  return fileTx(a, async (c) => finish(c, a, { preview: head(await findPreview(c, id)) }));
}
export async function priceFileImportExecutionDetail(a: PriceBulkEditActor, id: string) {
  return fileTx(a, async (c) => {
    const e = (await c.query('SELECT * FROM price_file_import_executions WHERE id=$1', [id]))
      .rows[0];
    ensure(e, 404, 'Nie znaleziono wykonania pliku');
    return finish(c, a, { execution: executionHead(e, await findPreview(c, e.preview_id)) });
  });
}
export async function priceFileImportRows(
  a: PriceBulkEditActor,
  id: string,
  q: z.input<typeof priceFileImportRowsQuery> = {},
  kind: 'preview' | 'execution' = 'preview',
) {
  const cursor = priceFileImportRowsQuery.parse(q).cursor,
    offset = Number(cursor ?? 0);
  return fileTx(a, async (c) => {
    let pid = id;
    if (kind === 'execution') {
      const e = (
        await c.query('SELECT preview_id FROM price_file_import_executions WHERE id=$1', [id])
      ).rows[0];
      ensure(e, 404, 'Nie znaleziono wykonania');
      pid = e.preview_id;
    }
    const p = await findPreview(c, pid);
    ensure(offset === 0 || offset < p.rows.length, 422, 'Kursor poza zakresem');
    return finish(c, a, {
      data: p.rows.slice(offset, offset + L.page),
      meta: {
        total: p.rows.length,
        cursor: offset + L.page < p.rows.length ? String(offset + L.page) : null,
      },
    });
  });
}
export async function priceFileImportHistory(
  a: PriceBulkEditActor,
  q: z.input<typeof priceFileImportPageQuery> = {},
  kind: 'preview' | 'execution' = 'preview',
) {
  const b = priceFileImportPageQuery.parse(q);
  return fileTx(a, async (c) => {
    const table =
      kind === 'preview' ? 'price_file_import_previews' : 'price_file_import_executions';
    if (b.cursor)
      ensure(
        (await c.query(`SELECT id FROM ${table} WHERE id=$1`, [b.cursor])).rowCount,
        422,
        'Kursor historii jest obcy lub nie istnieje',
      );
    const result = (
        await c.query(
          `SELECT * FROM ${table} WHERE ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM ${table} WHERE id=$1)) ORDER BY created_at DESC,id DESC LIMIT 51`,
          [b.cursor ?? null],
        )
      ).rows,
      more = result.length > 50;
    if (more) result.pop();
    const data = [];
    for (const r of result)
      data.push(
        kind === 'preview'
          ? head(await findPreview(c, r.id))
          : executionHead(r, await findPreview(c, r.preview_id)),
      );
    return finish(c, a, {
      data,
      meta: {
        total: Number((await c.query(`SELECT count(*) FROM ${table}`)).rows[0].count),
        cursor: more ? result.at(-1).id : null,
      },
    });
  });
}
export async function priceFileImportProfiles(
  a: PriceBulkEditActor,
  q: z.input<typeof priceFileImportPageQuery> = {},
) {
  const b = priceFileImportPageQuery.parse(q);
  return fileTx(a, async (c) => {
    const data = (
        await c.query(
          'SELECT id,name,version,price_list_id,definition,created_at,updated_at FROM price_file_import_profiles WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 51',
          [b.cursor ?? null],
        )
      ).rows,
      more = data.length > 50;
    if (more) data.pop();
    return finish(c, a, {
      data,
      meta: {
        total: Number(
          (await c.query('SELECT count(*) FROM price_file_import_profiles')).rows[0].count,
        ),
        cursor: more ? data.at(-1).id : null,
      },
    });
  });
}
export async function priceFileImportProfileDetail(a: PriceBulkEditActor, id: string) {
  return fileTx(a, async (c) => {
    const p = (
      await c.query(
        'SELECT id,name,version,price_list_id,definition,created_at,updated_at FROM price_file_import_profiles WHERE id=$1',
        [id],
      )
    ).rows[0];
    ensure(p, 404, 'Nie znaleziono profilu');
    return finish(c, a, { profile: p });
  });
}
export async function savePriceFileImportProfile(
  a: PriceBulkEditActor,
  input:
    z.input<typeof priceFileImportProfileInput> | z.input<typeof priceFileImportProfileUpdateInput>,
  id?: string,
) {
  const b = id
    ? priceFileImportProfileUpdateInput.parse(input)
    : priceFileImportProfileInput.parse(input);
  return fileTx(a, async (c) => {
    await admit(c, a);
    const result = (
      await c.query('SELECT price_file_import_store_profile($1,$2,$3) result', [
        JSON.stringify({
          ...b,
          id: id ?? randomUUID(),
          request_hash: digest(a, { id: id ?? null, body: b }),
        }),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].result;
    ensure(result.state !== 'conflict', 409, 'Klucz profilu lub wersja CAS ma inny zakres');
    return finish(c, a, result, true);
  });
}
