import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import { emitCatalogProductEvents } from './product-rule-events';
import {
  PRODUCT_TRANSLATION_BULK_LIMITS as LIMITS,
  productTranslationBulkEditPreviewInput,
  productTranslationBulkEditExecuteInput,
  productTranslationBulkEditSelectionQuery,
  productTranslationTexts,
  type ProductTranslationBulkEditInput,
  type ProductTranslationBulkEditRow,
} from './product-translation-bulk-edit-schema';

export type ProductTranslationBulkEditActor = Actor & { apiKeyId?: string };
/** Internal transaction adapter only; no linked-file admission is implemented here.
 * Callers that defer constraints must finalize the complete outer transaction.
 */
export type ProductTranslationBulkEditInternalOptions = {
  deferConstraintFinalization?: boolean;
  /** Trusted adapter callback; HTTP schemas cannot provide this function.
   * A file adapter checks unpinned access here and pins only after its full proof.
   */
  authorizeInTx?: (
    c: PoolClient,
    a: ProductTranslationBulkEditActor,
    write: boolean,
  ) => Promise<Actor['role']>;
};
async function requireTranslationTransactionContext(
  c: PoolClient,
  a: ProductTranslationBulkEditActor,
) {
  const context = (
    await c.query(
      "SELECT current_user AS db_role,current_setting('app.tenant_id',true) AS tenant_id",
    )
  ).rows[0];
  ensure(
    context?.db_role === 'dyna_app' && context?.tenant_id === a.tenantId,
    403,
    'Niezgodny kontekst transakcji wersji językowych',
  );
}
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
export const productTranslationBulkEditHash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(v)))
    .digest('hex');
function safeJson(v: any, depth = 0): void {
  ensure(depth <= 8, 422, 'Zbyt głęboka struktura żądania');
  if (typeof v === 'string')
    ensure(
      !v.includes('\0') && Buffer.from(v, 'utf8').toString('utf8') === v,
      422,
      'Niepoprawny Unicode lub NUL',
    );
  else if (Array.isArray(v)) for (const x of v) safeJson(x, depth + 1);
  else if (v && typeof v === 'object') {
    ensure(
      Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null,
      422,
      'Niepoprawny obiekt JSON',
    );
    for (const [k, x] of Object.entries(v)) {
      ensure(
        !['__proto__', 'prototype', 'constructor'].includes(k),
        422,
        'Niebezpieczny klucz JSON',
      );
      safeJson(x, depth + 1);
    }
  }
}
function requestHash(a: Actor, v: unknown, source: string) {
  safeJson(v);
  ensure(
    Buffer.byteLength(JSON.stringify(v), 'utf8') <= LIMITS.request_bytes,
    413,
    'Żądanie przekracza 2 MiB',
  );
  return productTranslationBulkEditHash({ actor_id: a.userId, source, request: v });
}
async function tx<T>(a: Actor, f: (c: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await tenantTx(a.tenantId, f);
  } catch (e: any) {
    if (e.code === 'P0001' && e.message === 'Translation bulk history quota exceeded')
      throw new Problem(409, 'Limit 2000 podglądów lub wykonań');
    if (
      e.code === 'P0001' &&
      [
        'Translation bulk storage quota exceeded',
        'Translation bulk preview exceeds eight MiB',
      ].includes(e.message)
    )
      throw new Problem(413, 'Przekroczony limit 8 MiB podglądu lub 128 MiB historii firmy');
    throw e;
  }
}
const access = (r: string) => ({ current_role: r, can_read: true, can_write: r === 'admin' });
async function role(c: PoolClient, a: ProductTranslationBulkEditActor, write = false) {
  const r = (await c.query('SELECT catalog_bulk_edit_current_role($1) role', [a.userId])).rows[0]
    ?.role;
  ensure(['admin', 'operator', 'viewer'].includes(r), 403, 'Utracono dostęp do katalogu');
  ensure(!write || r === 'admin', 403, 'Wymagany aktualny administrator');
  if (write && a.apiKeyId) {
    const k = (
      await c.query('SELECT catalog_bulk_edit_key_grant($1,$2) grant_result', [
        a.userId,
        a.apiKeyId,
      ])
    ).rows[0]?.grant_result;
    ensure(k !== 'invalid', 401, 'Klucz API został cofnięty lub wygasł');
    ensure(k === 'ok', 403, 'Brak aktualnych scopes products:read i products:write');
  }
  return r as Actor['role'];
}
async function admission(c: PoolClient, a: Actor) {
  for (const key of [
    `catalog:${a.tenantId}`,
    `product.rules:${a.tenantId}`,
    `product.translation.bulk:${a.tenantId}`,
  ])
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
}
async function quota(c: PoolClient, kind: 'previews' | 'executions') {
  ensure(
    (await c.query(`SELECT count(*)::int n FROM product_translation_bulk_edit_${kind}`)).rows[0].n <
      2000,
    409,
    'Limit 2000 podglądów lub wykonań',
  );
}
async function activeRules(c: PoolClient) {
  if (!(await c.query("SELECT to_regclass('public.product_rules') p")).rows[0].p) return [];
  const rows = (
    await c.query(
      `SELECT id,version,event,definition,approved_by,to_char(approved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') approved_at FROM product_rules WHERE enabled AND deleted_at IS NULL ORDER BY id FOR SHARE`,
    )
  ).rows;
  ensure(rows.length <= 100, 409, 'Przekroczono limit aktywnych reguł');
  return rows;
}
export type TranslationSnapshot = {
  present: boolean;
  version: number | null;
  name: string | null;
  description: string | null;
  provenance: { kind: 'ai' | 'deepl' | 'manual'; id: string } | null;
};
function snapshot(t: any): TranslationSnapshot {
  return t
    ? {
        present: true,
        version: t.version,
        name: t.name,
        description: t.description,
        provenance: t.manual_receipt_id
          ? { kind: 'manual', id: t.manual_receipt_id }
          : t.ai_draft_id
            ? { kind: 'ai', id: t.ai_draft_id }
            : { kind: 'deepl', id: t.deepl_draft_id },
      }
    : { present: false, version: null, name: null, description: null, provenance: null };
}
type Pair = { product_id: string; locale: string };
type State = { products: Map<string, any>; translations: Map<string, any> };
const key = (id: string, locale: string) => id + ':' + locale;
const sourceOf = (p: any) => ({
  name: p.name,
  description: p.description,
  category: p.category,
  attributes: p.attributes,
});
async function states(
  c: PoolClient,
  ids: string[],
  pairs: Pair[],
  write: boolean,
  bounded: boolean,
): Promise<State> {
  // A deleted product (225) is outside every scope: it counts as missing.
  const deletions = await productDeletionsAvailable(c);
  const locked = (
    await c.query(
      `SELECT id,version FROM products WHERE id=ANY($1::uuid[]) AND ${productNotDeletedSQL(deletions, 'products')} ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [ids],
    )
  ).rows;
  ensure(locked.length === ids.length, 422, 'Zakres zawiera brakujący lub obcy produkt');
  const encoded = JSON.stringify(pairs);
  await c.query(
    `SELECT t.product_id,t.locale FROM product_translations t JOIN jsonb_to_recordset($1::jsonb)x(product_id uuid,locale text) ON (t.product_id,t.locale)=(x.product_id,x.locale) ORDER BY t.product_id,t.locale FOR ${write ? 'UPDATE' : 'SHARE'} OF t`,
    [encoded],
  );
  if (bounded) {
    const estimate = (
      await c.query(
        `SELECT coalesce(sum(octet_length(jsonb_build_object('name',p.name,'description',p.description,'category',p.category,'attributes',p.attributes)::text)+coalesce(octet_length(jsonb_build_object('name',t.name,'description',t.description)::text),0)),0)::text n FROM jsonb_to_recordset($1::jsonb)x(product_id uuid,locale text) JOIN products p ON p.id=x.product_id LEFT JOIN product_translations t ON (t.product_id,t.locale)=(x.product_id,x.locale)`,
        [encoded],
      )
    ).rows[0].n;
    ensure(
      BigInt(estimate) <= BigInt(LIMITS.preview_bytes),
      413,
      'Istniejące teksty przekraczają 8 MiB podglądu; wybierz mniejszy zakres',
    );
  }
  const wanted = [...new Set(pairs.map((x) => x.product_id))],
    products = (
      await c.query(
        'SELECT id,sku,kind,name,description,category,attributes,version FROM products WHERE id=ANY($1::uuid[]) ORDER BY id',
        [wanted],
      )
    ).rows;
  const translations = (
    await c.query(
      `SELECT t.* FROM product_translations t JOIN jsonb_to_recordset($1::jsonb)x(product_id uuid,locale text) ON (t.product_id,t.locale)=(x.product_id,x.locale) ORDER BY t.product_id,t.locale`,
      [encoded],
    )
  ).rows;
  return {
    products: new Map(products.map((p) => [p.id, p])),
    translations: new Map(translations.map((t) => [key(t.product_id, t.locale), t])),
  };
}
export type ProductTranslationFrozenRow = {
  index: number;
  receipt_id: string;
  product_id: string;
  sku: string;
  kind: string;
  product_name: string;
  product_version: number;
  locale: string;
  input: ProductTranslationBulkEditRow;
  source: any;
  before: TranslationSnapshot;
  after: TranslationSnapshot | null;
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict';
  errors: string[];
};
function plan(
  b: ProductTranslationBulkEditInput,
  s: State,
  receipts?: string[],
): ProductTranslationFrozenRow[] {
  const rows = b.rows.map((input, index) => {
    const p = s.products.get(input.product_id),
      t = s.translations.get(key(input.product_id, input.locale)),
      before = snapshot(t),
      receipt_id = receipts?.[index] ?? randomUUID();
    const row: ProductTranslationFrozenRow = {
      index,
      receipt_id,
      product_id: p.id,
      sku: p.sku,
      kind: p.kind,
      product_name: p.name,
      product_version: p.version,
      locale: input.locale,
      input,
      source: sourceOf(p),
      before,
      after: before,
      status: 'unchanged',
      errors: [],
    };
    if (input.operation === 'remove' && before.present) {
      row.after = snapshot(null);
      row.status = 'changed';
    }
    if (input.operation === 'set') {
      const parsed = productTranslationTexts.safeParse({
        name: input.patch.name ?? t?.name,
        description: input.patch.description ?? t?.description ?? '',
      });
      if (!parsed.success) {
        row.status = 'invalid';
        row.after = null;
        row.errors = parsed.error.issues
          .map((x) => `${x.path.join('.')}: ${x.message}`)
          .slice(0, 20);
      } else if (
        !before.present ||
        parsed.data.name !== before.name ||
        parsed.data.description !== before.description
      ) {
        if (t?.version === 2147483647) {
          row.status = 'invalid';
          row.after = null;
          row.errors.push('Wersja tłumaczenia wyczerpała integer');
        } else {
          row.status = 'changed';
          row.after = {
            present: true,
            version: t ? t.version + 1 : 1,
            ...parsed.data,
            provenance: { kind: 'manual', id: receipt_id },
          };
        }
      }
    }
    if (p.version !== input.product_version || before.version !== input.translation_version) {
      row.status = 'conflict';
      row.after = null;
      row.errors.unshift('Produkt lub wersja językowa zmieniły się');
    }
    return row;
  });
  const exhausted = new Set(
    rows
      .filter((r) => r.status === 'changed' && r.product_version === 2147483647)
      .map((r) => r.product_id),
  );
  for (const r of rows)
    if (exhausted.has(r.product_id)) {
      r.status = 'invalid';
      r.after = null;
      r.errors.push('Wersja produktu wyczerpała integer');
    }
  return rows;
}
const summary = (rows: ProductTranslationFrozenRow[]) => ({
  total: rows.length,
  product_count: new Set(rows.map((r) => r.product_id)).size,
  changed_pairs: rows.filter((r) => r.status === 'changed').length,
  unchanged_pairs: rows.filter((r) => r.status === 'unchanged').length,
  changed_products: new Set(rows.filter((r) => r.status === 'changed').map((r) => r.product_id))
    .size,
  invalid: rows.filter((r) => r.status === 'invalid').length,
  conflicts: rows.filter((r) => r.status === 'conflict').length,
  missing_after_count: rows.filter((r) => r.after && !r.after.present).length,
  ready: rows.every((r) => r.status === 'changed' || r.status === 'unchanged'),
});
const scope = (
  actor: string,
  locales: string[],
  rows: ProductTranslationFrozenRow[],
  rules: any[],
) => productTranslationBulkEditHash({ actor_id: actor, locales, rows, rules_snapshot: rules });
const previewHead = (p: any) => ({
  id: p.id,
  actor_id: p.actor_id,
  locales: p.locales,
  rules_snapshot: p.rules_snapshot,
  created_at: p.created_at,
  scope_hash: p.scope_hash,
  total: p.total,
  product_count: p.product_count,
  changed_pairs: p.changed_pairs,
  unchanged_pairs: p.unchanged_pairs,
  changed_products: p.changed_products,
  invalid: p.invalid,
  conflicts: p.conflicts,
  missing_after_count: p.missing_after_count,
  ready: p.ready,
});
const executionHead = (e: any) => ({
  id: e.id,
  preview_id: e.preview_id,
  actor_id: e.actor_id,
  locales: e.locales,
  rules_snapshot: e.rules_snapshot,
  created_at: e.created_at,
  scope_hash: e.scope_hash,
  state: e.state,
  total: e.total,
  product_count: e.product_count,
  changed_pairs: e.changed_pairs,
  unchanged_pairs: e.unchanged_pairs,
  changed_products: e.changed_products,
  missing_after_count: e.missing_after_count,
  ack_missing_translations: e.ack_missing_translations,
});
async function preview(c: PoolClient, id: string) {
  const p = (
    await c.query('SELECT * FROM product_translation_bulk_edit_previews WHERE id=$1', [id])
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu wersji językowych');
  return p;
}
async function execution(c: PoolClient, id: string) {
  const e = (
    await c.query('SELECT * FROM product_translation_bulk_edit_executions WHERE id=$1', [id])
  ).rows[0];
  ensure(e, 404, 'Nie znaleziono wykonania wersji językowych');
  return e;
}
const frozenColumns =
  'index,receipt_id,product_id,sku,kind,product_name,product_version,locale,input,source,before,after,status,errors';
async function frozen(c: PoolClient, id: string): Promise<ProductTranslationFrozenRow[]> {
  return (
    await c.query(
      `SELECT ${frozenColumns} FROM product_translation_bulk_edit_rows WHERE preview_id=$1 ORDER BY index`,
      [id],
    )
  ).rows as ProductTranslationFrozenRow[];
}

export async function productTranslationBulkEditMetadata(a: Actor, cursor?: string) {
  return tx(a, async (c) => {
    const rows = (
        await c.query(
          'SELECT DISTINCT locale FROM product_translations WHERE ($1::text IS NULL OR locale>$1) ORDER BY locale LIMIT 51',
          [cursor ?? null],
        )
      ).rows,
      more = rows.length > 50;
    if (more) rows.pop();
    return {
      ...access(await role(c, a)),
      locales: rows.map((r) => r.locale),
      meta: { cursor: more ? rows.at(-1).locale : null },
      limits: LIMITS,
    };
  });
}
function boundedPage(rows: any[], offset: number, total: number) {
  const data: any[] = [];
  let bytes = 4096;
  for (const row of rows) {
    const n = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    ensure(n + 4096 <= 5242880, 413, 'Pojedynczy wiersz przekracza 5 MiB odpowiedzi');
    if (bytes + n > 5242880) break;
    data.push(row);
    bytes += n;
  }
  return {
    data,
    meta: { cursor: offset + data.length < total ? String(offset + data.length) : null },
  };
}
export async function productTranslationBulkEditSelection(
  a: Actor,
  query: z.infer<typeof productTranslationBulkEditSelectionQuery>,
) {
  const q = productTranslationBulkEditSelectionQuery.parse({
      ...query,
      ids: Array.isArray(query.ids) ? query.ids.join(',') : query.ids,
      locales: Array.isArray(query.locales) ? query.locales.join(',') : query.locales,
    }),
    ids = [...q.ids].sort(),
    langs = [...q.locales].sort(),
    identity = productTranslationBulkEditHash({ ids, locales: langs });
  let offset = 0;
  if (q.cursor) {
    try {
      const v = z
        .tuple([z.string().length(64), z.number().int().min(0).max(2999)])
        .parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')));
      ensure(v[0] === identity, 422, 'Kursor należy do innego zakresu');
      offset = v[1];
    } catch {
      ensure(false, 422, 'Nieprawidłowy kursor wyboru');
    }
  }
  const all = ids.flatMap((product_id) => langs.map((locale) => ({ product_id, locale })));
  ensure(offset < all.length, 422, 'Kursor poza zakresem');
  const pairs = all.slice(offset, offset + 50);
  return tx(a, async (c) => {
    const s = await states(c, ids, pairs, false, false),
      rows = pairs.map((x) => {
        const p = s.products.get(x.product_id),
          t = snapshot(s.translations.get(key(x.product_id, x.locale)));
        return {
          product_id: p.id,
          sku: p.sku,
          kind: p.kind,
          product_name: p.name,
          product_version: p.version,
          locale: x.locale,
          translation_version: t.version,
          present: t.present,
          name: t.name,
          description: t.description,
          provenance: t.provenance,
          source: sourceOf(p),
        };
      });
    const page = boundedPage(rows, offset, all.length);
    return {
      ...access(await role(c, a)),
      data: page.data,
      meta: {
        total: all.length,
        cursor: page.meta.cursor
          ? Buffer.from(JSON.stringify([identity, Number(page.meta.cursor)])).toString('base64url')
          : null,
      },
    };
  });
}
export async function createProductTranslationBulkEditPreview(
  a: ProductTranslationBulkEditActor,
  input: ProductTranslationBulkEditInput,
  source: 'manual' | 'api' = 'manual',
) {
  requestHash(a, input, source);
  const b = productTranslationBulkEditPreviewInput.parse(input);
  requestHash(a, b, source);
  return tx(a, (c) => createProductTranslationBulkEditPreviewInTx(c, a, b, source));
}
/** Uses the caller's already tenant-scoped transaction; never opens or commits one. */
export async function createProductTranslationBulkEditPreviewInTx(
  c: PoolClient,
  a: ProductTranslationBulkEditActor,
  input: ProductTranslationBulkEditInput,
  source: 'manual' | 'api' = 'manual',
  internal: ProductTranslationBulkEditInternalOptions = {},
) {
  await requireTranslationTransactionContext(c, a);
  const authorize = internal.authorizeInTx ?? role;
  requestHash(a, input, source);
  const b = productTranslationBulkEditPreviewInput.parse(input),
    hash = requestHash(a, b, source);
  await admission(c, a);
  const old = (
    await c.query('SELECT * FROM product_translation_bulk_edit_previews WHERE client_key=$1', [
      b.client_key,
    ])
  ).rows[0];
  if (old) {
    ensure(
      old.actor_id === a.userId && old.request_hash === hash,
      409,
      'Klucz podglądu ma inny autor lub treść',
    );
    return { ...access(await authorize(c, a, true)), preview: previewHead(old), reused: true };
  }
  await quota(c, 'previews');
  const ids = [...new Set(b.rows.map((r) => r.product_id))].sort(),
    s = await states(c, ids, b.rows, true, true),
    rules = await activeRules(c),
    rows = plan(b, s),
    sum = summary(rows),
    id = randomUUID();
  const p = (
    await c.query(
      `INSERT INTO product_translation_bulk_edit_previews(id,tenant_id,actor_id,client_key,request_hash,scope_hash,source,locales,rules_snapshot,total,product_count,changed_pairs,unchanged_pairs,changed_products,invalid,conflicts,missing_after_count,ready) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        id,
        a.tenantId,
        a.userId,
        b.client_key,
        hash,
        scope(a.userId, b.locales, rows, rules),
        source,
        JSON.stringify(b.locales),
        JSON.stringify(rules),
        sum.total,
        sum.product_count,
        sum.changed_pairs,
        sum.unchanged_pairs,
        sum.changed_products,
        sum.invalid,
        sum.conflicts,
        sum.missing_after_count,
        sum.ready,
      ],
    )
  ).rows[0];
  await c.query(
    `INSERT INTO product_translation_bulk_edit_rows(tenant_id,preview_id,index,receipt_id,product_id,sku,kind,product_name,product_version,locale,input,source,before,after,status,errors) SELECT $1,$2,r.index,r.receipt_id,r.product_id,r.sku,r.kind,r.product_name,r.product_version,r.locale,r.input,r.source,r.before,r.after,r.status,r.errors FROM jsonb_to_recordset($3::jsonb)r(index int,receipt_id uuid,product_id uuid,sku text,kind text,product_name text,product_version int,locale text,input jsonb,source jsonb,before jsonb,after jsonb,status text,errors jsonb)`,
    [a.tenantId, id, JSON.stringify(rows)],
  );
  await audit(c, a, 'translation.bulk.preview', id, {
    total: sum.total,
    product_count: sum.product_count,
    scope_hash: p.scope_hash,
  });
  if (!internal.deferConstraintFinalization) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const r = await authorize(c, a, true);
  return { ...access(r), preview: previewHead(p), reused: false };
}
export async function executeProductTranslationBulkEdit(
  a: ProductTranslationBulkEditActor,
  id: string,
  input: z.input<typeof productTranslationBulkEditExecuteInput>,
  source: 'manual' | 'api' = 'manual',
) {
  const b = productTranslationBulkEditExecuteInput.parse(input);
  requestHash(a, { preview_id: id, ...b }, source);
  return tx(a, async (c) => {
    // A file-linked plan must retain its complete source, parent receipt and ACK.
    // The dedicated importer calls InTx after its typed SQL admission instead.
    if (
      (await c.query("SELECT to_regclass('public.language_file_import_previews') present")).rows[0]
        .present
    ) {
      ensure(
        !(
          await c.query('SELECT id FROM language_file_import_previews WHERE core_preview_id=$1', [
            id,
          ])
        ).rowCount,
        409,
        'Podgląd pliku wykonaj przez import tłumaczeń',
      );
    }
    return executeProductTranslationBulkEditInTx(c, a, id, b, source);
  });
}
/** All admission, CAS, replay, rule and final-state checks run even when deferred. */
export async function executeProductTranslationBulkEditInTx(
  c: PoolClient,
  a: ProductTranslationBulkEditActor,
  id: string,
  input: z.input<typeof productTranslationBulkEditExecuteInput>,
  source: 'manual' | 'api' = 'manual',
  internal: ProductTranslationBulkEditInternalOptions = {},
) {
  await requireTranslationTransactionContext(c, a);
  const authorize = internal.authorizeInTx ?? role;
  const b = productTranslationBulkEditExecuteInput.parse(input),
    hash = requestHash(a, { preview_id: id, ...b }, source);
  await admission(c, a);
  const old = (
    await c.query('SELECT * FROM product_translation_bulk_edit_executions WHERE client_key=$1', [
      b.client_key,
    ])
  ).rows[0];
  if (old) {
    ensure(
      old.actor_id === a.userId && old.request_hash === hash,
      409,
      'Klucz wykonania ma innego autora lub treść',
    );
    return { ...access(await authorize(c, a, true)), execution: executionHead(old), reused: true };
  }
  const p = await preview(c, id);
  ensure(
    p.actor_id === a.userId && p.source === source && p.ready && p.scope_hash === b.scope_hash,
    409,
    'Podgląd niegotowy lub inny zakres zgody',
  );
  ensure(
    p.missing_after_count === 0 || b.ack_missing_translations,
    422,
    'Potwierdź osobno brak wersji językowej po operacji',
  );
  ensure(
    !(
      await c.query('SELECT id FROM product_translation_bulk_edit_executions WHERE preview_id=$1', [
        id,
      ])
    ).rowCount,
    409,
    'Podgląd już wykonano; ponów pierwotny klucz',
  );
  await quota(c, 'executions');
  const rows = await frozen(c, id);
  ensure(
    rows.length === p.total &&
      rows.every((r, i) => r.index === i && ['changed', 'unchanged'].includes(r.status)) &&
      scope(a.userId, p.locales, rows, p.rules_snapshot) === p.scope_hash,
    409,
    'Niezgodny pełny scope podglądu',
  );
  const request = productTranslationBulkEditPreviewInput.parse({
      client_key: p.client_key,
      locales: p.locales,
      rows: rows.map((r) => r.input),
    }),
    ids = [...new Set(rows.map((r) => r.product_id))].sort(),
    s = await states(c, ids, rows, true, true),
    rules = await activeRules(c);
  ensure(
    productTranslationBulkEditHash(rules) === productTranslationBulkEditHash(p.rules_snapshot),
    409,
    'Aktywne reguły produktów zmieniły się',
  );
  const projected = plan(
    request,
    s,
    rows.map((r) => r.receipt_id),
  );
  ensure(
    summary(projected).ready &&
      productTranslationBulkEditHash(projected) === productTranslationBulkEditHash(rows),
    409,
    'Produkt, źródło lub wersja językowa zmieniły się; cała partia odrzucona',
  );
  const changed = rows.filter((r) => r.status === 'changed'),
    changedProducts = [...new Set(changed.map((r) => r.product_id))].sort(),
    executionId = randomUUID();
  const e = (
    await c.query(
      `INSERT INTO product_translation_bulk_edit_executions(id,tenant_id,preview_id,actor_id,client_key,source,request_hash,scope_hash,locales,rules_snapshot,total,product_count,changed_pairs,unchanged_pairs,changed_products,missing_after_count,ack_missing_translations) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        executionId,
        a.tenantId,
        id,
        a.userId,
        b.client_key,
        source,
        hash,
        p.scope_hash,
        JSON.stringify(p.locales),
        JSON.stringify(rules),
        p.total,
        p.product_count,
        p.changed_pairs,
        p.unchanged_pairs,
        p.changed_products,
        p.missing_after_count,
        b.ack_missing_translations,
      ],
    )
  ).rows[0];
  const results = rows.map((r) => ({
    id: r.receipt_id,
    index: r.index,
    product_id: r.product_id,
    locale: r.locale,
    sku: r.sku,
    kind: r.kind,
    product_name: r.product_name,
    input: r.input,
    operation: r.input.operation,
    status: r.status,
    source: r.source,
    before: r.before,
    after: r.after,
    before_product_version: r.product_version,
    after_product_version: r.product_version + (changedProducts.includes(r.product_id) ? 1 : 0),
  }));
  await c.query(
    `INSERT INTO product_translation_bulk_edit_execution_rows(id,tenant_id,execution_id,preview_id,index,product_id,locale,sku,kind,product_name,input,operation,status,source,before,after,before_product_version,after_product_version) SELECT r.id,$1,$2,$3,r.index,r.product_id,r.locale,r.sku,r.kind,r.product_name,r.input,r.operation,r.status,r.source,r.before,r.after,r.before_product_version,r.after_product_version FROM jsonb_to_recordset($4::jsonb)r(id uuid,index int,product_id uuid,locale text,sku text,kind text,product_name text,input jsonb,operation text,status text,source jsonb,before jsonb,after jsonb,before_product_version int,after_product_version int)`,
    [a.tenantId, executionId, id, JSON.stringify(results)],
  );
  const remove = changed
    .filter((r) => !r.after!.present)
    .map((r) => ({ product_id: r.product_id, locale: r.locale }));
  await c.query(
    `DELETE FROM product_translations t USING jsonb_to_recordset($1::jsonb)x(product_id uuid,locale text) WHERE (t.product_id,t.locale)=(x.product_id,x.locale)`,
    [JSON.stringify(remove)],
  );
  const set = changed
    .filter((r) => r.after!.present)
    .map((r) => ({
      product_id: r.product_id,
      locale: r.locale,
      name: r.after!.name,
      description: r.after!.description,
      version: r.after!.version,
      receipt_id: r.receipt_id,
    }));
  await c.query(
    `INSERT INTO product_translations(tenant_id,product_id,locale,name,description,version,ai_draft_id,deepl_draft_id,manual_receipt_id) SELECT $1,x.product_id,x.locale,x.name,x.description,x.version,NULL,NULL,x.receipt_id FROM jsonb_to_recordset($2::jsonb)x(product_id uuid,locale text,name text,description text,version int,receipt_id uuid) ON CONFLICT(tenant_id,product_id,locale) DO UPDATE SET name=excluded.name,description=excluded.description,version=excluded.version,ai_draft_id=NULL,deepl_draft_id=NULL,manual_receipt_id=excluded.manual_receipt_id,updated_at=now()`,
    [a.tenantId, JSON.stringify(set)],
  );
  await c.query('UPDATE products SET version=version+1 WHERE id=ANY($1::uuid[])', [
    changedProducts,
  ]);
  await emitCatalogProductEvents(
    c,
    { ...a, role: 'admin' },
    changedProducts.map((product_id) => ({
      product_id,
      event: 'product.updated' as const,
      cause_id: rows.find((r) => r.product_id === product_id && r.status === 'changed')!.receipt_id,
    })),
  );
  if (!internal.deferConstraintFinalization) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const final = await states(c, ids, rows, true, false);
  for (const r of rows) {
    ensure(
      final.products.get(r.product_id).version ===
        r.product_version + (changedProducts.includes(r.product_id) ? 1 : 0) &&
        productTranslationBulkEditHash(
          snapshot(final.translations.get(key(r.product_id, r.locale))),
        ) === productTranslationBulkEditHash(r.after),
      409,
      'Końcowy wynik nie odpowiada zatwierdzonej macierzy',
    );
  }
  await audit(c, a, 'translation.bulk.execute', executionId, {
    preview_id: id,
    total: p.total,
    changed_pairs: p.changed_pairs,
    changed_products: p.changed_products,
  });
  const finalRole = await authorize(c, a, true);
  return { ...access(finalRole), execution: executionHead(e), reused: false };
}
export async function productTranslationBulkEditPreviewDetail(a: Actor, id: string) {
  return tx(a, async (c) => ({
    preview: previewHead(await preview(c, id)),
    ...access(await role(c, a)),
  }));
}
export async function productTranslationBulkEditExecutionDetail(a: Actor, id: string) {
  return tx(a, async (c) => ({
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
  const offset = cursor === undefined ? 0 : z.coerce.number().int().min(0).max(2999).parse(cursor);
  return tx(a, async (c) => {
    const head = kind === 'preview' ? await preview(c, id) : await execution(c, id);
    ensure(offset < head.total, 422, 'Kursor poza zakresem');
    const columns =
        kind === 'preview'
          ? frozenColumns
          : 'id,index,product_id,locale,sku,kind,product_name,input,operation,status,source,before,after,before_product_version,after_product_version',
      rows = (
        await c.query(
          `SELECT ${columns} FROM product_translation_bulk_edit_${kind === 'preview' ? 'rows' : 'execution_rows'} WHERE ${kind === 'preview' ? 'preview_id' : 'execution_id'}=$1 AND index>=$2 ORDER BY index LIMIT 50`,
          [id, offset],
        )
      ).rows;
    return { ...access(await role(c, a)), ...boundedPage(rows, offset, head.total) };
  });
}
export const productTranslationBulkEditPreviewRows = (a: Actor, id: string, cursor?: string) =>
  pagedRows(a, id, cursor, 'preview');
export const productTranslationBulkEditExecutionRows = (a: Actor, id: string, cursor?: string) =>
  pagedRows(a, id, cursor, 'execution');
export async function productTranslationBulkEditHistory(a: Actor, cursor?: string) {
  let seek: [string, string] | null = null;
  if (cursor) {
    try {
      seek = z
        .tuple([z.iso.datetime({ precision: 6 }), z.uuid()])
        .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    } catch {
      ensure(false, 422, 'Nieprawidłowy kursor historii');
    }
  }
  return tx(a, async (c) => {
    const rows = (
        await c.query(
          `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM product_translation_bulk_edit_executions WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,
          [seek?.[0] ?? null, seek?.[1] ?? null],
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
