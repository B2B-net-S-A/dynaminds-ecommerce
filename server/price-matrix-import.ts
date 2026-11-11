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
  lockPriceBulkEditFramesInTx,
  priceBulkEditHash,
  type PriceBulkEditActor,
} from './price-bulk-edit';
import { resolvePriceFileImportInTx, priceFileImportAvailable } from './price-file-import';
import type { PriceFileImportRow } from './price-file-import-schema';
import {
  priceMatrixImportPreviewInput,
  priceMatrixImportExecuteInput,
  priceMatrixImportProfileInput,
  priceMatrixImportProfileUpdateInput,
  priceMatrixImportPageQuery,
  priceMatrixImportRowsQuery,
  priceMatrixImportOptionsQuery,
  PRICE_MATRIX_IMPORT_LIMITS as L,
  type PriceMatrixImportRow,
} from './price-matrix-import-schema';
export * from './price-matrix-import-schema';
type Row = Record<string, any>;
const tables = [
  'price_matrix_import_previews',
  'price_matrix_import_executions',
  'price_matrix_import_profiles',
  'price_matrix_import_profile_revisions',
  'price_matrix_import_core_witnesses',
  'price_matrix_import_targets',
  'price_matrix_import_execution_targets',
  'price_matrix_import_execution_admissions',
  'price_bulk_edit_previews',
  'price_bulk_edit_rows',
  'price_bulk_edit_executions',
  'price_bulk_edit_execution_rows',
];
export async function priceMatrixImportAvailable(c: Pool | PoolClient) {
  const guards: Array<[string, string, string, boolean]> = [];
  guards.push([
    'price_matrix_import_execution_admissions',
    'complete',
    'price_matrix_import_admission_complete()',
    true,
  ]);
  for (const t of [
    'price_matrix_import_previews',
    'price_matrix_import_executions',
    'price_matrix_import_profile_revisions',
    'price_matrix_import_targets',
    'price_matrix_import_execution_targets',
  ]) {
    guards.push(
      [t, 'immutable', 'price_matrix_import_immutable()', false],
      [t, 'budget', 'price_matrix_import_budget()', false],
      [t, 'complete', 'price_matrix_import_complete()', true],
    );
  }
  guards.push(
    ['price_matrix_import_profiles', 'no_delete', 'price_matrix_import_immutable()', false],
    ['price_matrix_import_profiles', 'complete', 'price_matrix_import_complete()', true],
    ['price_bulk_edit_executions', 'price_matrix_receipt', 'price_matrix_import_receipt()', true],
  );
  for (const t of ['price_bulk_edit_previews', 'price_bulk_edit_executions'])
    guards.push(
      [t, 'price_matrix_witness', 'price_matrix_import_core_witness()', false],
      [t, 'price_matrix_witness_cleanup', 'price_matrix_import_core_witness()', true],
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
    guards.push([t, 'price_matrix_seal', 'price_matrix_import_seal()', false]);
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
  for (const t of ['price_file_import_previews', 'price_file_import_executions'])
    guards.push([t, 'price_matrix_exclusive', 'price_matrix_import_exclusive()', false]);
  const functions = [
    'price_matrix_import_access(uuid,uuid,boolean,boolean)',
    'price_matrix_import_store_preview(jsonb,uuid,uuid)',
    'price_matrix_import_store_execution(jsonb,uuid,uuid)',
    'price_matrix_import_store_profile(jsonb,uuid,uuid)',
    'price_matrix_import_require(uuid,uuid,boolean)',
    'price_matrix_import_targets(jsonb)',
    'price_matrix_import_validate_target(jsonb,uuid,uuid)',
    'price_matrix_import_execution_valid(uuid)',
    'price_matrix_import_installed()',
    'price_matrix_import_seal()',
    'price_matrix_import_core_witness()',
    'price_matrix_import_budget()',
    'price_matrix_import_complete()',
    'price_matrix_import_receipt()',
    'price_matrix_import_immutable()',
    'price_matrix_import_prepare_execution(uuid,uuid,uuid)',
    'price_matrix_import_admission_complete()',
    'price_matrix_import_exclusive()',
  ];
  if (!(await priceFileImportAvailable(c))) return false;
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
async function matrixTx<T>(a: PriceBulkEditActor, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await tenantTx(a.tenantId, async (c) => {
      ensure(await priceMatrixImportAvailable(c), 503, 'Niekompletny moduł importu macierzy cen');
      return fn(c);
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === '23514' && err.message === 'Brak aktualnej zgody na import macierzy cen')
      ensure(false, 403, err.message);
    if (err.code === '23514' && err.message === 'Wycofany klucz importu macierzy cen')
      ensure(false, 401, err.message);
    if (
      err.code === 'P0001' &&
      [
        'Limit historii importu macierzy cen',
        'Limit bajtów historii importu macierzy cen',
        'Limit profili importu macierzy cen',
        'Limit rewizji profili importu macierzy cen',
      ].includes(err.message ?? '')
    )
      ensure(false, 429, err.message!);
    if (
      err.code === '23514' &&
      [
        'Macierz nie jest gotowa do wykonania',
        'Mapowanie identyfikatora macierzy zmieniło się',
        'Cennik lub repricing macierzy zmienił się',
        'Produkt lub cena początkowa macierzy zmieniły się',
      ].includes(err.message ?? '')
    )
      ensure(false, 409, err.message!);
    throw e;
  }
}

async function access(c: PoolClient, a: PriceBulkEditActor, writing = false, pin = false) {
  const v = (
    await c.query('SELECT price_matrix_import_access($1,$2,$3,$4) result', [
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
    "SELECT pg_advisory_xact_lock_shared(hashtextextended('catalog:'||$1,0)),pg_advisory_xact_lock(hashtextextended('price.bulk:'||$1,0)),pg_advisory_xact_lock(hashtextextended('price.matrix:'||$1,0))",
    [a.tenantId],
  );
}
async function finish(c: PoolClient, a: PriceBulkEditActor, result: Row, write = false) {
  if (write) {
    try {
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === '23514' && err.message === 'Brak aktualnej zgody na import macierzy cen')
        ensure(false, 403, 'Brak aktualnej zgody na import macierzy cen');
      if (err.code === '23514' && err.message === 'Wycofany klucz importu macierzy cen')
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
    file_name: p.file_name,
    source_hash: p.source_hash,
    targets: p.targets,
    warnings: p.warnings,
    summary: p.summary,
    scope_hash: p.scope_hash,
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
    execution_id: e.id,
    can_execute: false,
    core_execution_ids: e.core_execution_ids,
    ack_missing_price_list_ids: e.ack_missing_price_list_ids,
    created_at: e.created_at,
  };
}
async function findPreview(c: PoolClient, id: string) {
  const p = (
    await c.query(
      'SELECT p.*,e.id execution_id FROM price_matrix_import_previews p LEFT JOIN price_matrix_import_executions e ON (e.tenant_id,e.preview_id)=(p.tenant_id,p.id) WHERE p.id=$1',
      [id],
    )
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu macierzy');
  return p;
}
function digest(a: PriceBulkEditActor, request: unknown) {
  return priceBulkEditHash({ actor_id: a.userId, api_key_id: a.apiKeyId ?? null, request });
}
function cellSummary(rows: PriceFileImportRow[]) {
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
function matrixSummary(rows: PriceMatrixImportRow[]) {
  const cells = rows.flatMap((r) => r.cells);
  return {
    total_products: rows.length,
    total_cells: cells.length,
    changed: cells.filter((r) => r.status === 'changed').length,
    unchanged: cells.filter((r) => r.status === 'unchanged').length,
    invalid: cells.filter((r) => r.status === 'invalid').length,
    conflicts: cells.filter((r) => r.status === 'conflict').length,
    missing_after_count: cells.filter((r) => (r.after as Row)?.source === 'missing').length,
    ready: cells.every((r) => r.status === 'changed' || r.status === 'unchanged'),
  };
}
export async function priceMatrixImportOptions(
  a: PriceBulkEditActor,
  q: z.input<typeof priceMatrixImportOptionsQuery> = {},
) {
  return matrixTx(a, async (c) => {
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

export async function priceMatrixImportPreviewDetail(a: PriceBulkEditActor, id: string) {
  return matrixTx(a, async (c) => finish(c, a, { preview: head(await findPreview(c, id)) }));
}
export async function priceMatrixImportExecutionDetail(a: PriceBulkEditActor, id: string) {
  return matrixTx(a, async (c) => {
    const e = (await c.query('SELECT * FROM price_matrix_import_executions WHERE id=$1', [id]))
      .rows[0];
    ensure(e, 404, 'Nie znaleziono wykonania macierzy');
    return finish(c, a, { execution: executionHead(e, await findPreview(c, e.preview_id)) });
  });
}
export async function priceMatrixImportRows(
  a: PriceBulkEditActor,
  id: string,
  q: z.input<typeof priceMatrixImportRowsQuery> = {},
  kind: 'preview' | 'execution' = 'preview',
) {
  const cursor = priceMatrixImportRowsQuery.parse(q).cursor,
    offset = Number(cursor ?? 0);
  return matrixTx(a, async (c) => {
    let pid = id;
    if (kind === 'execution') {
      const e = (
        await c.query('SELECT preview_id FROM price_matrix_import_executions WHERE id=$1', [id])
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
export async function priceMatrixImportHistory(
  a: PriceBulkEditActor,
  q: z.input<typeof priceMatrixImportPageQuery> = {},
  kind: 'preview' | 'execution' = 'preview',
) {
  const b = priceMatrixImportPageQuery.parse(q);
  return matrixTx(a, async (c) => {
    const table =
      kind === 'preview' ? 'price_matrix_import_previews' : 'price_matrix_import_executions';
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
export async function priceMatrixImportProfiles(
  a: PriceBulkEditActor,
  q: z.input<typeof priceMatrixImportPageQuery> = {},
) {
  const b = priceMatrixImportPageQuery.parse(q);
  return matrixTx(a, async (c) => {
    const data = (
        await c.query(
          'SELECT id,name,version,targets,created_at,updated_at FROM price_matrix_import_profiles WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 51',
          [b.cursor ?? null],
        )
      ).rows,
      more = data.length > 50;
    if (more) data.pop();
    return finish(c, a, {
      data,
      meta: {
        total: Number(
          (await c.query('SELECT count(*) FROM price_matrix_import_profiles')).rows[0].count,
        ),
        cursor: more ? data.at(-1).id : null,
      },
    });
  });
}
export async function priceMatrixImportProfileDetail(a: PriceBulkEditActor, id: string) {
  return matrixTx(a, async (c) => {
    const p = (
      await c.query(
        'SELECT id,name,version,targets,created_at,updated_at FROM price_matrix_import_profiles WHERE id=$1',
        [id],
      )
    ).rows[0];
    ensure(p, 404, 'Nie znaleziono profilu');
    return finish(c, a, { profile: p });
  });
}
export async function savePriceMatrixImportProfile(
  a: PriceBulkEditActor,
  input:
    | z.input<typeof priceMatrixImportProfileInput>
    | z.input<typeof priceMatrixImportProfileUpdateInput>,
  id?: string,
) {
  const b = id
    ? priceMatrixImportProfileUpdateInput.parse(input)
    : priceMatrixImportProfileInput.parse(input);
  return matrixTx(a, async (c) => {
    await admit(c, a);
    const result = (
      await c.query('SELECT price_matrix_import_store_profile($1,$2,$3) result', [
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

export async function createPriceMatrixImportPreview(
  a: PriceBulkEditActor,
  input: z.input<typeof priceMatrixImportPreviewInput>,
) {
  const b = priceMatrixImportPreviewInput.parse(input),
    hash = digest(a, b);
  ensure(Buffer.byteLength(b.content) <= L.file_bytes, 413, 'Plik przekracza 2 MiB');
  return matrixTx(a, async (c) => {
    await admit(c, a);
    const old = (
      await c.query(
        'SELECT id,actor_id,request_hash FROM price_matrix_import_previews WHERE client_key=$1',
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
    // All list and repricing parents precede the common identity/product SHARE locks.
    const frames = await lockPriceBulkEditFramesInTx(
      c,
      b.targets.map((t) => t.price_list_id),
    );
    const id = randomUUID(),
      targets: Row[] = [],
      matrix: PriceMatrixImportRow[] = [];
    let shared: Awaited<ReturnType<typeof resolvePriceFileImportInTx>>['shared'] | undefined;
    for (const target of b.targets) {
      const result = await resolvePriceFileImportInTx(
        c,
        { client_key: b.client_key, file_name: b.file_name, content: b.content, ...target },
        shared,
      );
      shared = result.shared;
      const rows = result.rows,
        frame = frames.get(target.price_list_id)!;
      for (const r of rows) {
        const currency = (r as Row).mapped_currency;
        if (currency !== undefined && currency !== frame.list.currency)
          r.errors.push('Waluta wiersza nie odpowiada wybranemu cennikowi');
        if (
          target.definition.format === 'xml' &&
          target.definition.native_price_mode === 'mapped' &&
          result.currency !== frame.list.currency
        )
          r.errors.push('Waluta XML nie odpowiada wybranemu cennikowi');
        delete (r as Row).mapped_currency;
      }
      const clean = rows.filter((r) => r.input && !r.errors.length),
        coreKey = randomUUID();
      let core: Row | null = null;
      if (clean.length) {
        core = await createPriceBulkEditPreviewInTx(
          c,
          a,
          {
            client_key: coreKey,
            price_list_id: target.price_list_id,
            list_version: target.list_version,
            rows: clean.map((r) => r.input!),
          },
          a.apiKeyId ? 'api' : 'manual',
          { matrixImportId: id, authorize },
        );
        const cr = (
          await c.query('SELECT * FROM price_bulk_edit_rows WHERE preview_id=$1 ORDER BY index', [
            core!.preview.id,
          ])
        ).rows;
        for (let i = 0; i < clean.length; i++) {
          const r = clean[i],
            v = cr[i];
          r.status = v.status;
          r.before = v.before;
          r.after = v.after;
          r.errors.push(...v.errors);
        }
      }
      for (const r of rows)
        if (r.errors.length) {
          if (r.status !== 'conflict') r.status = 'invalid';
          r.after = null;
        }
      targets.push({
        ...target,
        list_snapshot: frame.list,
        repricing_snapshot: frame.repricing_snapshot,
        warnings: frame.warnings,
        summary: cellSummary(rows),
        core_preview_id: core?.preview.id ?? null,
        core_client_key: coreKey,
      });
      for (const r of rows) {
        if (matrix[r.index])
          ensure(
            priceBulkEditHash({
              raw: r.raw_cells,
              resolution: r.resolution,
              product: r.product_id,
            }) ===
              priceBulkEditHash({
                raw: matrix[r.index].raw_cells,
                resolution: matrix[r.index].resolution,
                product: matrix[r.index].product_id,
              }),
            409,
            'Niezgodne wspólne rozwiązanie produktu',
          );
        else
          matrix.push({
            index: r.index,
            raw_cells: r.raw_cells,
            resolution: r.resolution,
            product_id: r.product_id,
            sku: r.sku,
            name: r.name,
            errors: [],
            cells: [],
          });
        matrix[r.index].cells.push({
          price_list_id: target.price_list_id,
          input: r.input,
          status: r.status,
          before: r.before,
          after: r.after,
          errors: r.errors,
          skipped_price_groups: r.skipped_price_groups,
        });
      }
    }
    for (const r of matrix)
      if (!r.product_id) r.errors.push('Brak jednoznacznego własnego produktu');
    const payload = {
      id,
      client_key: b.client_key,
      request_hash: hash,
      file_name: b.file_name,
      source_hash: createHash('sha256').update(b.content).digest('hex'),
      source: a.apiKeyId ? 'api' : 'manual',
      targets,
      rows: matrix,
      warnings: [...new Set(targets.flatMap((t) => t.warnings))],
      summary: matrixSummary(matrix),
    };
    ensure(
      Buffer.byteLength(JSON.stringify(payload)) <= L.preview_bytes,
      413,
      'Pełny podgląd przekracza 32 MiB',
    );
    await c.query('SELECT price_matrix_import_store_preview($1,$2,$3)', [
      JSON.stringify({ ...payload, scope_hash: priceBulkEditHash(payload) }),
      a.userId,
      a.apiKeyId ?? null,
    ]);
    await audit(c, a, 'pricing.matrix.preview', id, {
      price_list_ids: targets.map((t) => t.price_list_id),
      source_hash: payload.source_hash,
      total_products: matrix.length,
      total_cells: payload.summary.total_cells,
    });
    return finish(c, a, { preview: head(await findPreview(c, id)), reused: false }, true);
  });
}
export async function executePriceMatrixImport(
  a: PriceBulkEditActor,
  id: string,
  input: z.input<typeof priceMatrixImportExecuteInput>,
) {
  const b = priceMatrixImportExecuteInput.parse(input),
    hash = digest(a, { preview_id: id, ...b });
  return matrixTx(a, async (c) => {
    await admit(c, a);
    const old = (
      await c.query('SELECT * FROM price_matrix_import_executions WHERE client_key=$1', [
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
        !p.execution_id,
      409,
      'Podgląd niegotowy, wykonany lub zgoda ma inny zakres',
    );
    const required = p.targets
      .filter((t: Row) => t.summary.missing_after_count > 0)
      .map((t: Row) => t.price_list_id)
      .sort();
    ensure(
      priceBulkEditHash(required) === priceBulkEditHash(b.ack_missing_price_list_ids),
      422,
      'Potwierdź dokładnie wybrane cenniki z brakującymi cenami',
    );
    await lockPriceBulkEditFramesInTx(
      c,
      p.targets.map((t: Row) => t.price_list_id),
    );
    // Recheck the common identity scope once, under the same catalog admission.
    const deletions = await productDeletionsAvailable(c);
    const products = (
      await c.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [
        p.rows.map((r: Row) => r.product_id),
      ])
    ).rows;
    for (const r of p.rows) {
      const d = p.targets[0].definition,
        matches = (
          await c.query(
            `SELECT id FROM products WHERE CASE WHEN $1='uuid' THEN id::text=$2 WHEN $1 IN ('sku','historical_sku') THEN sku=$2 OR EXISTS(SELECT 1 FROM product_sku_aliases x WHERE (x.tenant_id,x.product_id)=(products.tenant_id,products.id) AND x.sku=$2) WHEN $1='ean' THEN ean<>'' AND ean=$2 ELSE name=$2 END AND ${productNotDeletedSQL(deletions, 'products')}`,
            [d.identity, r.resolution.value],
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
    await c.query('SELECT price_matrix_import_prepare_execution($1,$2,$3)', [
      id,
      a.userId,
      a.apiKeyId ?? null,
    ]);
    const core_execution_ids: Row[] = [];
    for (const target of p.targets) {
      const cp = (
        await c.query('SELECT scope_hash FROM price_bulk_edit_previews WHERE id=$1', [
          target.core_preview_id,
        ])
      ).rows[0];
      ensure(cp, 409, 'Brak pełnego zakresu silnika');
      const result = await executePriceBulkEditInTx(
        c,
        a,
        target.core_preview_id,
        {
          client_key: randomUUID(),
          scope_hash: cp.scope_hash,
          confirmed: true,
          ack_missing_prices: required.includes(target.price_list_id),
        },
        p.source,
        { matrixImportId: id, authorize },
      );
      core_execution_ids.push({
        price_list_id: target.price_list_id,
        core_execution_id: result.execution.id,
      });
    }
    const eid = randomUUID();
    await c.query('SELECT price_matrix_import_store_execution($1,$2,$3)', [
      JSON.stringify({
        id: eid,
        preview_id: id,
        client_key: b.client_key,
        request_hash: hash,
        scope_hash: p.scope_hash,
        core_execution_ids,
        ack_missing_price_list_ids: b.ack_missing_price_list_ids,
      }),
      a.userId,
      a.apiKeyId ?? null,
    ]);
    await audit(c, a, 'pricing.matrix.execute', eid, { preview_id: id, core_execution_ids });
    const e = (await c.query('SELECT * FROM price_matrix_import_executions WHERE id=$1', [eid]))
      .rows[0];
    return finish(c, a, { execution: executionHead(e, p), reused: false }, true);
  });
}
