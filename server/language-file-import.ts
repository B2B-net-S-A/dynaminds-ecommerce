import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { productDeletionsAvailable, productIdNotDeletedSQL } from './product-deletions';
import { assertCatalogImportJson } from './catalog-file-import-parse';
import { parseLanguageFile } from './language-file-import-parse';
import {
  createProductTranslationBulkEditPreviewInTx,
  executeProductTranslationBulkEditInTx,
  productTranslationBulkEditHash as hash,
  type TranslationSnapshot,
} from './product-translation-bulk-edit';
import { productTranslationTexts } from './product-translation-bulk-edit-schema';
import {
  LANGUAGE_FILE_IMPORT_LIMITS as L,
  languageFileImportPreviewInput,
  languageFileImportExecuteInput,
  languageFileImportProfileInput,
  languageFileImportProfileUpdateInput,
  languageFileImportOptionsQuery,
  languageFileImportPageQuery,
  languageFileImportRowsQuery,
  type LanguageFileImportActor,
  type LanguageFileImportInput,
  type LanguageFileImportDefinition,
  type LanguageFileImportFileRow,
  type LanguageFileImportExecutionRow,
  type LanguageFileImportSummary,
  type LanguageFileImportLocaleSummary,
  type LanguageFileImportProfile,
  type ParsedLanguageFile,
} from './language-file-import-schema';
export * from './language-file-import-schema';
type Row = Record<string, any>;
const ownTables = [
  'previews',
  'rows',
  'executions',
  'execution_rows',
  'profiles',
  'profile_revisions',
  'admissions',
  'core_witnesses',
].map((t) => `language_file_import_${t}`);
const coreTables = ['previews', 'rows', 'executions', 'execution_rows'].map(
  (t) => `product_translation_bulk_edit_${t}`,
);
const requiredFunctions = [
  'language_file_import_installed()',
  'language_file_import_access(uuid,uuid,boolean,boolean)',
  'language_file_import_store_preview(jsonb,uuid,uuid)',
  'language_file_import_prepare_execution(uuid,uuid,uuid,uuid)',
  'language_file_import_store_execution(jsonb,uuid,uuid)',
  'language_file_import_store_profile(jsonb,uuid,uuid)',
  'language_file_import_require(uuid,uuid,boolean)',
  'language_file_import_locks(uuid)',
  'language_file_import_canonical(jsonb)',
  'language_file_import_hash(jsonb)',
  'language_file_import_utf16_key(text)',
  'language_file_import_array_index(text)',
  'language_file_import_definition(jsonb)',
  'language_file_import_text_valid(text,boolean)',
  'language_file_import_source(jsonb)',
  'language_file_import_xml_value(xml,boolean,integer)',
  'language_file_import_decode(jsonb,text,jsonb)',
  'language_file_import_cell(jsonb,jsonb,jsonb)',
  'language_file_import_snapshot(jsonb)',
  'language_file_import_summary(jsonb,boolean)',
  'language_file_import_per_locale(jsonb,jsonb)',
  'language_file_import_validate_preview(jsonb,uuid,uuid,boolean,boolean)',
  'language_file_import_validate_execution(jsonb,uuid,uuid)',
  'language_file_import_budget(uuid)',
  'language_file_import_immutable()',
  'language_file_import_bytes()',
  'language_file_import_core_witness()',
  'language_file_import_head_scope()',
  'language_file_import_row_scope()',
  'language_file_import_admission_scope()',
  'language_file_import_complete()',
  'language_file_import_seal()',
  'language_file_import_rules(uuid)',
  'language_file_import_witness_scope()',
  'language_file_import_guards()',
  'product_translation_bulk_immutable()',
  'product_translation_bulk_bytes()',
  'product_translation_bulk_budget()',
  'product_translation_bulk_scope()',
  'product_translation_manual_scope()',
];
type Guard = { t: string; n: string; f: string; deferred: boolean };
const guards: Guard[] = [];
const guard = (t: string, n: string, f: string, deferred = false) =>
  guards.push({ t, n, f, deferred });
for (const t of ['previews', 'rows', 'executions', 'execution_rows', 'profile_revisions'].map(
  (n) => `language_file_import_${n}`,
)) {
  guard(t, 'language_file_import_immutable', 'language_file_import_immutable()');
  guard(t, 'language_file_import_bytes', 'language_file_import_bytes()');
}
for (const t of ['previews', 'executions'].map((n) => `language_file_import_${n}`))
  guard(t, 'language_file_import_head_scope', 'language_file_import_head_scope()');
for (const t of ['rows', 'execution_rows'].map((n) => `language_file_import_${n}`))
  guard(t, 'language_file_import_row_scope', 'language_file_import_row_scope()');
for (const t of ['previews', 'executions', 'profile_revisions', 'admissions'].map(
  (n) => `language_file_import_${n}`,
))
  guard(t, 'language_file_import_complete', 'language_file_import_complete()', true);
guard(
  'language_file_import_profiles',
  'language_file_import_profile_complete',
  'language_file_import_complete()',
  true,
);
guard(
  'language_file_import_admissions',
  'language_file_import_admission_scope',
  'language_file_import_admission_scope()',
);
guard(
  'language_file_import_core_witnesses',
  'language_file_import_immutable',
  'language_file_import_immutable()',
);
guard(
  'language_file_import_core_witnesses',
  'language_file_import_witness_scope',
  'language_file_import_witness_scope()',
);
for (const t of [
  'product_translation_bulk_edit_previews',
  'product_translation_bulk_edit_executions',
])
  guard(t, 'language_file_import_core_witness', 'language_file_import_core_witness()');
guard(
  'product_translation_bulk_edit_executions',
  'language_file_import_core_complete',
  'language_file_import_complete()',
  true,
);
for (const t of [
  ...coreTables,
  'products',
  'product_translations',
  'product_sku_aliases',
  'product_rules',
  'language_file_import_admissions',
  'language_file_import_core_witnesses',
])
  guard(t, 'language_file_import_seal', 'language_file_import_seal()');
for (const t of coreTables) {
  guard(t, 'immutable', 'product_translation_bulk_immutable()');
  guard(t, 'serialized_bytes', 'product_translation_bulk_bytes()');
  guard(t, 'budget', 'product_translation_bulk_budget()');
}
for (const t of coreTables.filter((t) => t !== 'product_translation_bulk_edit_previews'))
  guard(t, 'scope', 'product_translation_bulk_scope()');
guard('product_translations', 'manual_scope', 'product_translation_manual_scope()');
type ForeignKey = { t: string; cols: string[]; target: string; refs: string[]; deferred: boolean };
const foreignKeys: ForeignKey[] = [];
const fk = (t: string, cols: string[], target: string, refs: string[], deferred = false) =>
  foreignKeys.push({ t, cols, target, refs, deferred });
fk(
  'language_file_import_previews',
  ['tenant_id', 'core_preview_id'],
  'product_translation_bulk_edit_previews',
  ['tenant_id', 'id'],
);
fk('language_file_import_rows', ['tenant_id', 'preview_id'], 'language_file_import_previews', [
  'tenant_id',
  'id',
]);
fk('language_file_import_rows', ['tenant_id', 'product_id'], 'products', ['tenant_id', 'id']);
fk(
  'language_file_import_rows',
  ['tenant_id', 'core_preview_id', 'core_index', 'receipt_id', 'product_id', 'locale'],
  'product_translation_bulk_edit_rows',
  ['tenant_id', 'preview_id', 'index', 'receipt_id', 'product_id', 'locale'],
);
fk(
  'language_file_import_executions',
  ['tenant_id', 'preview_id'],
  'language_file_import_previews',
  ['tenant_id', 'id'],
);
fk(
  'language_file_import_executions',
  ['tenant_id', 'core_execution_id', 'core_preview_id'],
  'product_translation_bulk_edit_executions',
  ['tenant_id', 'id', 'preview_id'],
);
fk(
  'language_file_import_execution_rows',
  ['tenant_id', 'execution_id', 'preview_id'],
  'language_file_import_executions',
  ['tenant_id', 'id', 'preview_id'],
);
fk(
  'language_file_import_execution_rows',
  ['tenant_id', 'preview_id', 'index'],
  'language_file_import_rows',
  ['tenant_id', 'preview_id', 'index'],
);
fk(
  'language_file_import_execution_rows',
  ['tenant_id', 'receipt_id', 'product_id', 'locale'],
  'product_translation_bulk_edit_execution_rows',
  ['tenant_id', 'id', 'product_id', 'locale'],
);
fk(
  'language_file_import_profile_revisions',
  ['tenant_id', 'profile_id'],
  'language_file_import_profiles',
  ['tenant_id', 'id'],
);
fk(
  'language_file_import_admissions',
  ['tenant_id', 'preview_id'],
  'language_file_import_previews',
  ['tenant_id', 'id'],
);
fk(
  'language_file_import_admissions',
  ['tenant_id', 'execution_id'],
  'language_file_import_executions',
  ['tenant_id', 'id'],
  true,
);
for (const t of ['previews', 'executions', 'profile_revisions', 'admissions'].map(
  (n) => `language_file_import_${n}`,
))
  fk(t, ['tenant_id', 'api_key_id'], 'api_keys', ['tenant_id', 'id']);
/** Fail closed for partial schema, disabled guards, broken receipts or replica mode. */
export async function languageFileImportAvailable(c: Pool | PoolClient): Promise<boolean> {
  return !!(
    await c.query(
      `SELECT current_setting('session_replication_role')='origin' AND
      NOT EXISTS(SELECT 1 FROM unnest($1::text[]) n WHERE NOT EXISTS(
      SELECT 1 FROM pg_class t JOIN pg_namespace s ON s.oid=t.relnamespace
      WHERE s.nspname='public' AND t.relname=n AND t.relrowsecurity AND t.relforcerowsecurity))
      AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n WHERE to_regprocedure(n) IS NULL)
      AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb)x(t text,n text,f text,deferred boolean)
        WHERE NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=to_regclass('public.'||x.t)
          AND g.tgname=x.n AND g.tgfoid=to_regprocedure(x.f) AND g.tgenabled='O'
          AND (NOT x.deferred OR(g.tgdeferrable AND g.tginitdeferred))))
      AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb)x(t text,cols text[],target text,refs text[],deferred boolean)
        WHERE NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.contype='f' AND k.convalidated
          AND k.conrelid=to_regclass('public.'||x.t) AND k.confrelid=to_regclass('public.'||x.target)
          AND (NOT x.deferred OR(k.condeferrable AND k.condeferred))
          AND k.conkey=ARRAY(SELECT a.attnum FROM unnest(x.cols) WITH ORDINALITY u(n,i)
            JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attname=u.n ORDER BY u.i)
          AND k.confkey=ARRAY(SELECT a.attnum FROM unnest(x.refs) WITH ORDINALITY u(n,i)
            JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attname=u.n ORDER BY u.i))) ok`,
      [
        [...ownTables, ...coreTables],
        requiredFunctions,
        JSON.stringify(guards),
        JSON.stringify(foreignKeys),
      ],
    )
  ).rows[0]?.ok;
}
const source = (a: LanguageFileImportActor) =>
  a.apiKeyId ? ('api' as const) : ('manual' as const);
export function languageFileImportRequestHash(
  a: LanguageFileImportActor,
  kind: 'preview' | 'execute' | 'profile',
  parent: string | null,
  request: unknown,
) {
  assertCatalogImportJson(request);
  ensure(
    Buffer.byteLength(JSON.stringify(request), 'utf8') <= L.request_bytes,
    413,
    'Żądanie przekracza 3 MiB',
  );
  return hash({
    tenant_id: a.tenantId,
    actor_id: a.userId,
    api_key_id: a.apiKeyId ?? null,
    source: source(a),
    kind,
    parent_id: parent,
    request,
  });
}
async function currentAccess(
  c: PoolClient,
  a: LanguageFileImportActor,
  writing = false,
  pin = false,
) {
  const context = (
    await c.query("SELECT current_user db_role,current_setting('app.tenant_id',true) tenant_id")
  ).rows[0];
  ensure(
    context?.db_role === 'dyna_app' && context?.tenant_id === a.tenantId,
    403,
    'Niezgodny kontekst importu wersji językowych',
  );
  const v = (
    await c.query('SELECT language_file_import_access($1,$2,$3,$4) result', [
      a.userId,
      a.apiKeyId ?? null,
      writing,
      pin,
    ])
  ).rows[0]?.result;
  ensure(v?.key_valid !== false, 401, 'Klucz API wygasł lub został wycofany');
  ensure(
    ['admin', 'operator', 'viewer'].includes(v?.role) && v.allowed,
    403,
    'Brak aktualnej roli lub scopes products',
  );
  ensure(!writing || v.role === 'admin', 403, 'Wymagany aktualny administrator');
  return {
    available: true,
    read_only: false,
    current_role: v.role as LanguageFileImportActor['role'],
    can_read: true,
    can_write: !!v.can_write,
  };
}
const authorizeInTx = async (c: PoolClient, a: LanguageFileImportActor, writing: boolean) =>
  (await currentAccess(c, a, writing, false)).current_role;
async function admit(c: PoolClient, a: LanguageFileImportActor) {
  await currentAccess(c, a, true);
  // Same order as the translation engine; no narrower shared catalog fence.
  for (const key of [
    `catalog:${a.tenantId}`,
    `product.rules:${a.tenantId}`,
    `product.translation.bulk:${a.tenantId}`,
  ])
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `language.file:${a.tenantId}`,
  ]);
}
async function fileTx<T>(
  a: LanguageFileImportActor,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await tenantTx(a.tenantId, async (c) => {
      ensure(
        await languageFileImportAvailable(c),
        503,
        'Niekompletny moduł importu wersji językowych',
      );
      await currentAccess(c, a);
      return fn(c);
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === '23514' && err.message === 'Wycofany klucz importu języków')
      throw new Problem(401, err.message);
    if (err.code === '23514' && err.message === 'Brak aktualnej zgody na import języków')
      throw new Problem(403, err.message);
    if (err.code === 'P0001' && err.message === 'Limit bajtów podglądu importu języków')
      throw new Problem(413, err.message);
    if (
      err.code === 'P0001' &&
      err.message?.startsWith('Limit ') &&
      err.message.includes('importu języków')
    )
      throw new Problem(429, err.message);
    if (
      err.code === 'P0001' &&
      [
        'Translation bulk storage quota exceeded',
        'Translation bulk preview exceeds eight MiB',
      ].includes(err.message ?? '')
    )
      throw new Problem(413, 'Przekroczono budżet silnika wersji językowych');
    if (err.code === 'P0001' && err.message === 'Translation bulk history quota exceeded')
      throw new Problem(409, 'Limit historii silnika wersji językowych');
    throw e;
  }
}
async function finish(c: PoolClient, a: LanguageFileImportActor, result: Row, write = false) {
  if (write) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const flags = await currentAccess(c, a, write, write);
  if (result.preview) result.preview.can_execute = flags.can_write && result.preview.can_execute;
  return { ...result, ...flags };
}
function previewHead(p: Row, a: LanguageFileImportActor) {
  const v = p.payload;
  return {
    id: p.id,
    created_at: p.created_at,
    source_hash: v.source_hash,
    scope_hash: p.scope_hash,
    definition: v.definition,
    profile_snapshot: v.profile_snapshot,
    summary: v.summary,
    per_locale: v.per_locale,
    core_preview_id: p.core_preview_id ?? v.core_preview_id,
    executed_execution_id: p.executed_execution_id ?? null,
    can_execute:
      !!v.summary.ready &&
      !p.executed_execution_id &&
      p.actor_id === a.userId &&
      p.api_key_id === (a.apiKeyId ?? null),
  };
}
function executionHead(e: Row) {
  const v = e.payload;
  return {
    id: e.id,
    created_at: e.created_at,
    preview_id: e.preview_id,
    source_hash: v.source_hash,
    scope_hash: e.scope_hash,
    definition: v.definition,
    profile_snapshot: v.profile_snapshot,
    summary: v.summary,
    per_locale: v.per_locale,
    core_preview_id: v.core_preview_id,
    core_execution_id: e.core_execution_id ?? v.core_execution_id,
    state: 'done' as const,
    executed_execution_id: e.id,
    ack_missing_locale_codes: v.ack_missing_locale_codes,
    can_execute: false,
  };
}
async function findPreview(c: PoolClient, id: string) {
  const p = (
    await c.query(
      `SELECT p.*,e.id executed_execution_id FROM language_file_import_previews p
    LEFT JOIN language_file_import_executions e ON (e.tenant_id,e.preview_id)=(p.tenant_id,p.id) WHERE p.id=$1`,
      [id],
    )
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu importu języków');
  return p;
}
async function findExecution(c: PoolClient, id: string) {
  const e = (await c.query('SELECT * FROM language_file_import_executions WHERE id=$1', [id]))
    .rows[0];
  ensure(e, 404, 'Nie znaleziono wykonania importu języków');
  return e;
}
function profileView(p: Row): LanguageFileImportProfile {
  const v = p.payload ?? p;
  return {
    id: p.id,
    version: p.version ?? v.version,
    name: p.name ?? v.name,
    definition: p.definition ?? v.definition,
    archived: p.archived ?? v.archived,
    created_at: p.created_at ?? v.created_at,
    updated_at: p.updated_at ?? v.updated_at,
  };
}
async function findProfile(c: PoolClient, id: string) {
  // App profiles are SELECT-only. Write serialization uses the shared advisory;
  // the SD preview writer independently checks the frozen current profile.
  const p = (await c.query('SELECT * FROM language_file_import_profiles WHERE id=$1', [id]))
    .rows[0];
  ensure(p, 404, 'Nie znaleziono profilu importu języków');
  return p;
}
type Resolution = { value: string; matches: number; product_id: string | null };
async function identities(
  c: PoolClient,
  d: LanguageFileImportDefinition,
  values: string[],
): Promise<Map<string, Resolution>> {
  if (!values.length) return new Map();
  const match =
    d.identity === 'historical_sku'
      ? `SELECT p.sku value,p.id product_id FROM products p WHERE p.sku=ANY($1::text[])
       UNION SELECT a.sku,a.product_id FROM product_sku_aliases a JOIN products p ON (p.tenant_id,p.id)=(a.tenant_id,a.product_id) WHERE a.sku=ANY($1::text[])`
      : d.identity === 'uuid'
        ? 'SELECT id::text value,id product_id FROM products WHERE id=ANY($1::uuid[])'
        : d.identity === 'sku'
          ? 'SELECT sku value,id product_id FROM products WHERE sku=ANY($1::text[])'
          : d.identity === 'ean'
            ? "SELECT ean value,id product_id FROM products WHERE ean<>'' AND ean=ANY($1::text[])"
            : 'SELECT name value,id product_id FROM products WHERE name=ANY($1::text[])';
  // A deleted product (225) matches no file row.
  const deletions = await productDeletionsAvailable(c);
  const rows = (
    await c.query(
      `WITH matches AS (${match}) SELECT value,count(DISTINCT product_id)::int matches,
    CASE WHEN count(DISTINCT product_id)=1 THEN min(product_id::text) ELSE NULL END product_id FROM matches
    WHERE ${productIdNotDeletedSQL(deletions, "nullif(current_setting('app.tenant_id',true),'')::uuid", 'matches.product_id')} GROUP BY value`,
      [values],
    )
  ).rows;
  return new Map(rows.map((r) => [r.value, r as Resolution]));
}
const pairKey = (id: string, locale: string) => `${id}:${locale}`;
function translationSnapshot(t: Row | undefined): TranslationSnapshot {
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
async function resolve(c: PoolClient, d: LanguageFileImportDefinition, parsed: ParsedLanguageFile) {
  const values = [
    ...new Set(parsed.rows.flatMap((r) => (r.identity === null ? [] : [r.identity]))),
  ].sort();
  const before = await identities(c, d, values),
    ids = [
      ...new Set([...before.values()].flatMap((v) => (v.product_id ? [v.product_id] : []))),
    ].sort();
  const products = (
    await c.query(
      'SELECT id,sku,kind,name,version FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [ids],
    )
  ).rows;
  const after = await identities(c, d, values);
  ensure(
    hash([...before].sort()) === hash([...after].sort()),
    409,
    'Identyfikator produktu zmienił się podczas oczekiwania',
  );
  ensure(products.length === ids.length, 409, 'Zakres produktów zmienił się podczas oczekiwania');
  const pairs = ids.flatMap((product_id) =>
    d.languages.map((l) => ({ product_id, locale: l.locale })),
  );
  await c.query(
    `SELECT t.product_id,t.locale FROM product_translations t JOIN jsonb_to_recordset($1::jsonb)x(product_id uuid,locale text)
    ON (t.product_id,t.locale)=(x.product_id,x.locale) ORDER BY t.product_id,t.locale FOR UPDATE OF t`,
    [JSON.stringify(pairs)],
  );
  const translations = (
    await c.query(
      `SELECT t.* FROM product_translations t JOIN jsonb_to_recordset($1::jsonb)x(product_id uuid,locale text)
    ON (t.product_id,t.locale)=(x.product_id,x.locale) ORDER BY t.product_id,t.locale`,
      [JSON.stringify(pairs)],
    )
  ).rows;
  const productMap = new Map<string, Row>(products.map((p) => [p.id, p])),
    translationMap = new Map<string, Row>(
      translations.map((t) => [pairKey(t.product_id, t.locale), t]),
    );
  const rows: LanguageFileImportFileRow[] = parsed.rows.flatMap((s, source_index) =>
    d.languages.map((l, li) => {
      const resolution = s.identity === null ? undefined : after.get(s.identity),
        p = resolution?.product_id ? productMap.get(resolution.product_id) : undefined;
      const cell = s.cells.find((v) => v.locale === l.locale)!,
        errors = [...s.issues, ...cell.issues];
      if (!p)
        errors.push(
          resolution && resolution.matches > 1
            ? 'Niejednoznaczny identyfikator własnego produktu'
            : 'Brak własnego produktu',
        );
      const t = p ? translationMap.get(pairKey(p.id, l.locale)) : undefined,
        snap = p ? translationSnapshot(t) : null;
      const input = p
        ? {
            product_id: p.id,
            product_version: p.version,
            locale: l.locale,
            translation_version: t?.version ?? null,
            operation: cell.operation,
            ...(cell.operation === 'set' ? { patch: cell.patch! } : {}),
          }
        : null;
      let changed = false;
      if (cell.operation === 'set' && p) {
        const texts = productTranslationTexts.safeParse({
          name: cell.patch?.name ?? t?.name,
          description: cell.patch?.description ?? t?.description ?? '',
        });
        if (!texts.success)
          errors.push(...texts.error.issues.map((v) => `${v.path.join('.')}: ${v.message}`));
        else changed = !t || texts.data.name !== t.name || texts.data.description !== t.description;
        if (changed && t?.version === 2147483647)
          errors.push('Wersja tłumaczenia wyczerpała integer');
      } else changed = cell.operation === 'remove' && !!t;
      return {
        index: source_index * d.languages.length + li,
        source_index,
        locale: l.locale,
        raw_cells: s.raw_cells,
        resolution: {
          identity: d.identity,
          value: s.identity,
          matched_historical_sku: !!p && d.identity === 'historical_sku' && p.sku !== s.identity,
        },
        product_id: p?.id ?? null,
        sku: p?.sku ?? null,
        kind: p?.kind ?? null,
        product_name: p?.name ?? null,
        product_version: p?.version ?? null,
        input: input as LanguageFileImportFileRow['input'],
        before: snap,
        after: changed ? null : snap,
        status: errors.length ? 'invalid' : changed ? 'changed' : 'unchanged',
        skip_reason: cell.operation === 'none' ? 'Źródło nie zmienia tej wersji językowej' : null,
        errors,
        core_index: null,
        receipt_id: null,
        source_translation_version: s.source_translation_versions[l.locale] ?? null,
        skipped_locales: s.skipped_locales,
      };
    }),
  );
  const sourceGroups = new Map<string, Set<number>>();
  for (const r of rows)
    if (r.product_id) {
      const g = sourceGroups.get(r.product_id) ?? new Set<number>();
      g.add(r.source_index);
      sourceGroups.set(r.product_id, g);
    }
  const changedProducts = new Set(
    rows.filter((r) => r.status === 'changed').map((r) => r.product_id),
  );
  for (const r of rows) {
    if (r.product_id && sourceGroups.get(r.product_id)!.size > 1)
      r.errors.push('Powtórzony produkt po rozwiązaniu aliasów');
    if (r.product_version === 2147483647 && changedProducts.has(r.product_id))
      r.errors.push('Wersja produktu wyczerpała integer');
  }
  if (rows.some((r) => r.errors.length))
    for (const r of rows) {
      if (!r.errors.length)
        r.errors.push('Cała macierz odrzucona z powodu błędów źródła lub tekstów');
      r.status = 'invalid';
      r.after = null;
    }
  return rows;
}
function summary(rows: LanguageFileImportFileRow[]): LanguageFileImportSummary {
  return {
    source_rows: new Set(rows.map((r) => r.source_index)).size,
    product_count: new Set(rows.flatMap((r) => (r.product_id ? [r.product_id] : []))).size,
    total_pairs: rows.length,
    changed_pairs: rows.filter((r) => r.status === 'changed').length,
    unchanged_pairs: rows.filter((r) => r.status === 'unchanged').length,
    skipped_pairs: rows.filter((r) => r.status === 'unchanged' && r.input?.operation === 'none')
      .length,
    changed_products: new Set(rows.filter((r) => r.status === 'changed').map((r) => r.product_id))
      .size,
    invalid: rows.filter((r) => r.status === 'invalid').length,
    conflicts: rows.filter((r) => r.status === 'conflict').length,
    missing_after_count: rows.filter((r) => r.after?.present === false).length,
    skipped_locale_entries: [
      ...new Map(rows.map((r) => [r.source_index, r.skipped_locales.length])).values(),
    ].reduce((a, b) => a + b, 0),
    ready: rows.length > 0 && rows.every((r) => ['changed', 'unchanged'].includes(r.status)),
  };
}
function perLocale(
  rows: LanguageFileImportFileRow[],
  d: LanguageFileImportDefinition,
): LanguageFileImportLocaleSummary[] {
  return d.languages.map((l) => ({
    locale: l.locale,
    ...summary(rows.filter((r) => r.locale === l.locale)),
    skipped_locale_entries: 0,
  }));
}
export async function languageFileImportOptions(
  a: LanguageFileImportActor,
  q: z.input<typeof languageFileImportOptionsQuery> = {},
) {
  const b = languageFileImportOptionsQuery.parse(q);
  return fileTx(a, async (c) => {
    const rows = (
      await c.query(
        'SELECT DISTINCT locale FROM product_translations WHERE ($1::text IS NULL OR locale>$1) ORDER BY locale LIMIT 51',
        [b.cursor ?? null],
      )
    ).rows;
    const more = rows.length > L.page;
    if (more) rows.pop();
    return finish(c, a, {
      locales: rows.map((r) => r.locale),
      can_use_custom_locale: true,
      modes: ['columns', 'translations_json'],
      limits: L,
      meta: { cursor: more ? rows.at(-1)!.locale : null },
    });
  });
}
export async function createLanguageFileImportPreview(
  a: LanguageFileImportActor,
  input: z.input<typeof languageFileImportPreviewInput>,
) {
  ensure(Buffer.byteLength(input.content, 'utf8') <= L.file_bytes, 413, 'Plik przekracza 2 MiB');
  const b = languageFileImportPreviewInput.parse(input),
    request_hash = languageFileImportRequestHash(a, 'preview', null, b);
  // Structural errors precede any durable preview; row issues remain in parsed output.
  const parsed = parseLanguageFile(b.content, b.definition);
  if (b.definition.format === 'xml')
    ensure(
      parsed.rows.every(
        (r) =>
          Object.hasOwn(r.raw_cells, b.definition.mapping.identity) &&
          Object.hasOwn(r.raw_cells, b.definition.mapping.translations_json!),
      ),
      422,
      'Brak mapowanego pola XML',
    );
  return fileTx(a, async (c) => {
    await admit(c, a);
    const old = (
      await c.query('SELECT * FROM language_file_import_previews WHERE client_key=$1', [
        b.client_key,
      ])
    ).rows[0];
    if (old) {
      ensure(
        old.actor_id === a.userId &&
          old.api_key_id === (a.apiKeyId ?? null) &&
          old.request_hash === request_hash,
        409,
        'Klucz podglądu ma innego aktora, klucz API lub treść',
      );
      return finish(
        c,
        a,
        { preview: previewHead(await findPreview(c, old.id), a), reused: true },
        true,
      );
    }
    let profile_snapshot: null | Pick<LanguageFileImportProfile, 'id' | 'version' | 'name'> = null;
    if (b.profile) {
      const p = profileView(await findProfile(c, b.profile.id));
      ensure(
        !p.archived && p.version === b.profile.version && hash(p.definition) === hash(b.definition),
        409,
        'Profil zmienił wersję lub definicję',
      );
      profile_snapshot = { id: p.id, version: p.version, name: p.name };
    }
    const id = randomUUID(),
      rows = await resolve(c, b.definition, parsed);
    let core_preview_id: string | null = null;
    if (rows.every((r) => !r.errors.length)) {
      const core = await createProductTranslationBulkEditPreviewInTx(
        c,
        a,
        {
          client_key: id,
          locales: b.definition.languages.map((l) => l.locale),
          rows: rows.map((r) => r.input!),
        },
        source(a),
        { deferConstraintFinalization: true, authorizeInTx },
      );
      core_preview_id = core.preview.id;
      const cr = (
        await c.query(
          'SELECT * FROM product_translation_bulk_edit_rows WHERE preview_id=$1 ORDER BY index',
          [core_preview_id],
        )
      ).rows;
      ensure(
        cr.length === rows.length && cr.every((r, i) => r.index === i),
        409,
        'Niezgodny pełny zbiór par silnika',
      );
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i],
          v = cr[i];
        ensure(
          v.product_id === r.product_id && v.locale === r.locale && hash(v.input) === hash(r.input),
          409,
          'Niezgodna para silnika',
        );
        r.core_index = v.index;
        r.receipt_id = v.receipt_id;
        r.before = v.before;
        r.after = v.after;
        r.status = v.status;
        r.errors = [...v.errors];
      }
      ensure(
        rows.every((r) => ['changed', 'unchanged'].includes(r.status)),
        409,
        'Silnik odrzucił aktualną macierz języków',
      );
    }
    const payload = {
      id,
      client_key: b.client_key,
      request_hash,
      source: source(a),
      request: b,
      definition: b.definition,
      source_hash: parsed.source_hash,
      profile_snapshot,
      summary: summary(rows),
      per_locale: perLocale(rows, b.definition),
      rows,
      core_preview_id,
    };
    ensure(
      Buffer.byteLength(JSON.stringify(payload), 'utf8') <= L.preview_bytes,
      413,
      'Pełny podgląd przekracza 32 MiB',
    );
    await c.query('SELECT language_file_import_store_preview($1,$2,$3)', [
      JSON.stringify({ ...payload, scope_hash: hash(payload) }),
      a.userId,
      a.apiKeyId ?? null,
    ]);
    await audit(c, a, 'translation.file.preview', id, {
      source_hash: payload.source_hash,
      total_pairs: rows.length,
      core_preview_id,
    });
    return finish(c, a, { preview: previewHead(await findPreview(c, id), a), reused: false }, true);
  });
}
export async function executeLanguageFileImport(
  a: LanguageFileImportActor,
  id: string,
  input: z.input<typeof languageFileImportExecuteInput>,
) {
  const b = languageFileImportExecuteInput.parse(input),
    request_hash = languageFileImportRequestHash(a, 'execute', id, b);
  return fileTx(a, async (c) => {
    await admit(c, a);
    const old = (
      await c.query('SELECT * FROM language_file_import_executions WHERE client_key=$1', [
        b.client_key,
      ])
    ).rows[0];
    if (old) {
      ensure(
        old.actor_id === a.userId &&
          old.api_key_id === (a.apiKeyId ?? null) &&
          old.preview_id === id &&
          old.request_hash === request_hash,
        409,
        'Klucz wykonania ma innego aktora, klucz API lub treść',
      );
      return finish(c, a, { execution: executionHead(old), reused: true }, true);
    }
    const p = await findPreview(c, id),
      v = p.payload;
    ensure(
      p.actor_id === a.userId &&
        p.api_key_id === (a.apiKeyId ?? null) &&
        p.scope_hash === b.scope_hash &&
        v.summary.ready &&
        p.core_preview_id &&
        !p.executed_execution_id,
      409,
      'Podgląd jest niegotowy, wykonany lub ma inny zakres zgody',
    );
    const required = v.per_locale
      .filter((l: LanguageFileImportLocaleSummary) => l.missing_after_count > 0)
      .map((l: LanguageFileImportLocaleSummary) => l.locale)
      .sort();
    ensure(
      hash(required) === hash(b.ack_missing_locale_codes),
      422,
      'Potwierdź dokładny zbiór języków z brakującą wersją',
    );
    const frozenRequest = languageFileImportPreviewInput.parse(v.request),
      current = await resolve(
        c,
        frozenRequest.definition,
        parseLanguageFile(frozenRequest.content, frozenRequest.definition),
      );
    const frozen = v.rows as LanguageFileImportFileRow[];
    ensure(
      current.length === frozen.length &&
        current.every(
          (r, i) =>
            r.errors.length === 0 &&
            hash({
              resolution: r.resolution,
              product_id: r.product_id,
              sku: r.sku,
              kind: r.kind,
              product_name: r.product_name,
              product_version: r.product_version,
              input: r.input,
              before: r.before,
            }) ===
              hash({
                resolution: frozen[i].resolution,
                product_id: frozen[i].product_id,
                sku: frozen[i].sku,
                kind: frozen[i].kind,
                product_name: frozen[i].product_name,
                product_version: frozen[i].product_version,
                input: frozen[i].input,
                before: frozen[i].before,
              }),
        ),
      409,
      'Produkt, identyfikator lub wersja językowa zmieniły się',
    );
    const eid = randomUUID();
    await c.query('SELECT language_file_import_prepare_execution($1,$2,$3,$4)', [
      id,
      eid,
      a.userId,
      a.apiKeyId ?? null,
    ]);
    const core = await executeProductTranslationBulkEditInTx(
      c,
      a,
      p.core_preview_id,
      {
        client_key: eid,
        scope_hash: (
          await c.query(
            'SELECT scope_hash FROM product_translation_bulk_edit_previews WHERE id=$1',
            [p.core_preview_id],
          )
        ).rows[0].scope_hash,
        confirmed: true,
        ack_missing_translations: required.length > 0,
      },
      source(a),
      { deferConstraintFinalization: true, authorizeInTx },
    );
    const cr = (
      await c.query(
        'SELECT * FROM product_translation_bulk_edit_execution_rows WHERE execution_id=$1 ORDER BY index',
        [core.execution.id],
      )
    ).rows;
    ensure(
      cr.length === frozen.length &&
        cr.every(
          (r, i) =>
            r.index === i &&
            r.id === frozen[i].receipt_id &&
            r.product_id === frozen[i].product_id &&
            r.locale === frozen[i].locale,
        ),
      409,
      'Niezgodne końcowe potwierdzenia par językowych',
    );
    const rows: LanguageFileImportExecutionRow[] = frozen.map((r, i) => ({
      ...r,
      after: cr[i].after,
      core_receipt_id: cr[i].id,
      before_product_version: cr[i].before_product_version,
      after_product_version: cr[i].after_product_version,
    }));
    const payload = {
      id: eid,
      preview_id: id,
      client_key: b.client_key,
      request_hash,
      scope_hash: p.scope_hash,
      source: source(a),
      request: b,
      definition: v.definition,
      source_hash: v.source_hash,
      profile_snapshot: v.profile_snapshot,
      summary: v.summary,
      per_locale: v.per_locale,
      rows,
      core_preview_id: p.core_preview_id,
      core_execution_id: core.execution.id,
      ack_missing_locale_codes: b.ack_missing_locale_codes,
    };
    ensure(
      Buffer.byteLength(JSON.stringify(payload), 'utf8') <= L.preview_bytes,
      413,
      'Pełny dowód wykonania przekracza 32 MiB',
    );
    await c.query('SELECT language_file_import_store_execution($1,$2,$3)', [
      JSON.stringify(payload),
      a.userId,
      a.apiKeyId ?? null,
    ]);
    await audit(c, a, 'translation.file.execute', eid, {
      preview_id: id,
      core_execution_id: core.execution.id,
      total_pairs: rows.length,
    });
    return finish(
      c,
      a,
      { execution: executionHead(await findExecution(c, eid)), reused: false },
      true,
    );
  });
}
export async function languageFileImportPreviewDetail(a: LanguageFileImportActor, id: string) {
  return fileTx(a, async (c) =>
    finish(c, a, { preview: previewHead(await findPreview(c, id), a) }),
  );
}
export async function languageFileImportExecutionDetail(a: LanguageFileImportActor, id: string) {
  return fileTx(a, async (c) =>
    finish(c, a, { execution: executionHead(await findExecution(c, id)) }),
  );
}
function boundedRows(rows: Row[], offset: number, total: number) {
  const data: Row[] = [];
  let bytes = 4096;
  for (const r of rows) {
    const n = Buffer.byteLength(JSON.stringify(r), 'utf8') + 1;
    ensure(n + 4096 <= L.response_bytes, 413, 'Pojedynczy wiersz przekracza 5 MiB odpowiedzi');
    if (bytes + n > L.response_bytes) break;
    data.push(r);
    bytes += n;
  }
  return {
    data,
    meta: { total, cursor: offset + data.length < total ? String(offset + data.length) : null },
  };
}
export async function languageFileImportRows(
  a: LanguageFileImportActor,
  id: string,
  q: z.input<typeof languageFileImportRowsQuery> = {},
  kind: 'preview' | 'execution' = 'preview',
) {
  const offset = Number(languageFileImportRowsQuery.parse(q).cursor ?? 0);
  return fileTx(a, async (c) => {
    const head = kind === 'preview' ? await findPreview(c, id) : await findExecution(c, id),
      total = head.payload.rows.length;
    ensure(offset < total, 422, 'Kursor poza zakresem');
    const rows = (
      await c.query(
        `SELECT payload FROM language_file_import_${kind === 'preview' ? 'rows' : 'execution_rows'}
      WHERE ${kind === 'preview' ? 'preview_id' : 'execution_id'}=$1 AND index>=$2 ORDER BY index LIMIT 50`,
        [id, offset],
      )
    ).rows.map((r) => r.payload);
    return finish(c, a, boundedRows(rows, offset, total));
  });
}
type Seek = [string, string];
function decodeCursor(cursor: string | undefined): Seek | null {
  if (!cursor) return null;
  try {
    const v = z
      .tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), z.uuid()])
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    const date = new Date(v[0]);
    ensure(
      Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === v[0].slice(0, 19),
      422,
      'Niepoprawna data kursora',
    );
    return v;
  } catch {
    throw new Problem(422, 'Niepoprawny kursor historii języków');
  }
}
const encodeCursor = (r: Row) =>
  Buffer.from(JSON.stringify([r.cursor_at, r.id])).toString('base64url');
async function page(c: PoolClient, table: string, q: z.input<typeof languageFileImportPageQuery>) {
  const b = languageFileImportPageQuery.parse(q),
    seek = decodeCursor(b.cursor);
  if (seek)
    ensure(
      (
        await c.query(`SELECT id FROM ${table} WHERE id=$1 AND created_at=$2::timestamptz`, [
          seek[1],
          seek[0],
        ])
      ).rowCount,
      422,
      'Kursor historii jest obcy lub nie istnieje',
    );
  const params: Array<string | null> = [seek?.[0] ?? null, seek?.[1] ?? null];
  const rows = (
    await c.query<Row>(
      `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
    FROM ${table} WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,
      params,
    )
  ).rows;
  const more = rows.length > L.page;
  if (more) rows.pop();
  return {
    rows,
    meta: {
      total: Number((await c.query(`SELECT count(*) FROM ${table}`)).rows[0].count),
      cursor: more ? encodeCursor(rows.at(-1)!) : null,
    },
  };
}
export async function languageFileImportHistory(
  a: LanguageFileImportActor,
  q: z.input<typeof languageFileImportPageQuery> = {},
  kind: 'preview' | 'execution' = 'preview',
) {
  return fileTx(a, async (c) => {
    const p = await page(
        c,
        `language_file_import_${kind === 'preview' ? 'previews' : 'executions'}`,
        q,
      ),
      data = [];
    for (const r of p.rows)
      data.push(kind === 'preview' ? previewHead(await findPreview(c, r.id), a) : executionHead(r));
    const result = await finish(c, a, { data, meta: p.meta });
    if (!result.can_write) for (const h of data) h.can_execute = false;
    return result;
  });
}
export async function languageFileImportProfiles(
  a: LanguageFileImportActor,
  q: z.input<typeof languageFileImportPageQuery> = {},
) {
  return fileTx(a, async (c) => {
    const p = await page(c, 'language_file_import_profiles', q);
    return finish(c, a, { data: p.rows.map(profileView), meta: p.meta });
  });
}
export async function languageFileImportProfileDetail(a: LanguageFileImportActor, id: string) {
  return fileTx(a, async (c) => finish(c, a, { profile: profileView(await findProfile(c, id)) }));
}
export async function saveLanguageFileImportProfile(
  a: LanguageFileImportActor,
  input:
    | z.input<typeof languageFileImportProfileInput>
    | z.input<typeof languageFileImportProfileUpdateInput>,
  id?: string,
) {
  const update = id ? languageFileImportProfileUpdateInput.parse(input) : undefined;
  const b = update ?? languageFileImportProfileInput.parse(input),
    expected_version = update?.version ?? 0,
    request_hash = languageFileImportRequestHash(a, 'profile', id ?? null, b);
  ensure(expected_version < 2147483647, 409, 'Wersja profilu wyczerpała integer');
  return fileTx(a, async (c) => {
    await admit(c, a);
    const result = (
      await c.query('SELECT language_file_import_store_profile($1,$2,$3) result', [
        JSON.stringify({
          id: id ?? randomUUID(),
          client_key: b.client_key,
          request_hash,
          expected_version,
          version: expected_version + 1,
          name: b.name,
          definition: b.definition,
          archived: update?.archived ?? false,
          request: b,
        }),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0]?.result;
    ensure(
      result && result.state !== 'conflict',
      409,
      'Klucz profilu lub wersja CAS ma inny zakres',
    );
    return finish(c, a, result, true);
  });
}
