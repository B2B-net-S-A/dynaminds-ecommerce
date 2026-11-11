import type { Pool, PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import {
  PROFORMA_LIMITS,
  proformaSeriesInput,
  proformaPreviewInput,
  proformaIssueInput,
  proformaPageQuery,
  type ProformaActor,
  type ProformaSeriesInput,
  type ProformaPreviewInput,
  type ProformaIssueInput,
} from './proforma-values';

export { PROFORMA_LIMITS } from './proforma-values';
export type ProformaLine = {
  item_id: string | null;
  product_id: string | null;
  kind: 'item' | 'shipping';
  sku: string;
  name: string;
  quantity: number;
  unit_gross_minor: string;
  vat_rate: number;
  gross_minor: string;
  net_minor: string;
  vat_minor: string;
};
export type ProformaSnapshot = {
  order: {
    id: string;
    number: string;
    version: string;
    status: string;
    currency: string;
    total_minor: string;
    shipping_cost_minor: string;
    payment_mode: string;
  };
  seller: ProformaSeriesInput['seller'];
  buyer: {
    name: string;
    email: string;
    address: { street: string; postal_code: string; city: string; country: string };
  };
  series: {
    id: string;
    name: string;
    prefix: string;
    payment_terms_days: number;
    payment_instructions: string;
    notes: string;
  };
  currency: string;
  lines: ProformaLine[];
  totals: { gross_minor: string; net_minor: string; vat_minor: string };
  issue_date: string;
  due_date: string;
  year: number;
};
export type ProformaSeries = Omit<ProformaSeriesInput, 'client_key'> & {
  id: string;
  version: 1;
  created_at: string;
};
export type ProformaPreview = {
  id: string;
  order_id: string;
  order_version: string;
  series_id: string;
  scope_hash: string;
  snapshot: ProformaSnapshot;
  expires_at: string;
  created_at: string;
  can_issue: boolean;
  issued_document_id: string | null;
};
export type ProformaDocument = {
  id: string;
  order_id: string;
  number: string;
  kind: 'proforma';
  mode: 'local';
  data: ProformaSnapshot & {
    number: string;
    preview_id: string;
    scope_hash: string;
    local_only: true;
    not_tax_invoice: true;
  };
  created_at: string;
};
export type ProformaReceipt = {
  id: string;
  document_id: string;
  preview_id: string;
  series_id: string;
  year: number;
  sequence: number;
  number: string;
  scope_hash: string;
  created_at: string;
};

const tables = [
  'proforma_series',
  'proforma_series_commands',
  'proforma_previews',
  'proforma_counters',
  'proforma_receipts',
  'proforma_admissions',
];
const historyTables = tables.filter((t) => t !== 'proforma_counters');
const functions = [
  'proforma_installed()',
  'proforma_access(uuid,uuid,boolean,boolean)',
  'proforma_require(uuid,uuid,boolean,boolean)',
  'proforma_locks()',
  'proforma_canonical(jsonb)',
  'proforma_hash(jsonb)',
  'proforma_request_hash(text,uuid,jsonb,uuid,uuid)',
  'proforma_text(jsonb,integer,integer)',
  'proforma_definition(jsonb)',
  'proforma_budget(uuid)',
  'proforma_frame(uuid,uuid,integer)',
  'proforma_immutable()',
  'proforma_series_guard()',
  'proforma_command_guard()',
  'proforma_create_series(jsonb,uuid,uuid)',
  'proforma_preview_guard()',
  'proforma_store_preview(uuid,jsonb,uuid,uuid)',
  'proforma_admission_guard()',
  'proforma_document_guard()',
  'proforma_receipt_guard()',
  'proforma_counter_guard()',
  'proforma_issue(uuid,jsonb,uuid,uuid)',
  'proforma_complete()',
  'proforma_seal()',
];
const guards = [
  ...historyTables.flatMap((table) => [
    { table, name: 'proforma_immutable', fn: 'proforma_immutable()', deferred: false },
    { table, name: 'proforma_complete', fn: 'proforma_complete()', deferred: true },
  ]),
  ...['orders', 'order_items', 'return_cases'].map((table) => ({
    table,
    name: 'proforma_seal',
    fn: 'proforma_seal()',
    deferred: false,
  })),
  ...[
    ['proforma_series', 'proforma_series_guard'],
    ['proforma_series_commands', 'proforma_command_guard'],
    ['proforma_previews', 'proforma_preview_guard'],
    ['proforma_admissions', 'proforma_admission_guard'],
    ['proforma_receipts', 'proforma_receipt_guard'],
    ['proforma_counters', 'proforma_counter_guard'],
    ['documents', 'proforma_document_guard'],
  ].map(([table, name]) => ({ table, name, fn: `${name}()`, deferred: false })),
];
const unavailable = 'Moduł lokalnych proform jest niekompletny';
/** A wholly older schema is neutral; any torn 127 contract fails closed. */
export async function proformasAvailable(c: Pool | PoolClient): Promise<boolean> {
  const probe = (
    await c.query(
      `SELECT current_user db_role,
    EXISTS(SELECT 1 FROM unnest($1::text[]) x WHERE to_regclass(x) IS NOT NULL)
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'proforma_%')
    OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='documents'::regclass AND conname='documents_proforma_local') artifacts`,
      [tables],
    )
  ).rows[0];
  if (!probe.artifacts) {
    // Owner preflight runs before tenantTx. Never acquire a second pool connection inside a transaction.
    ensure(probe.db_role !== 'dyna_app', 503, unavailable);
    const installed = (
      await c.query("SELECT EXISTS(SELECT 1 FROM migrations WHERE name='127_proformas') installed")
    ).rows[0].installed;
    ensure(!installed, 503, unavailable);
    return false;
  }
  const full = (
    await c.query(
      `SELECT
    (SELECT count(*) FROM pg_class WHERE oid=ANY(ARRAY(SELECT to_regclass(x) FROM unnest($1::text[]) x)) AND relrowsecurity AND relforcerowsecurity)=6
    AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) x WHERE to_regprocedure(x) IS NULL)
    AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) g("table" text,name text,fn text,deferred boolean)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(g."table") AND t.tgname::text=g.name
      AND t.tgfoid=to_regprocedure(g.fn) AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgdeferrable=g.deferred AND t.tginitdeferred=g.deferred))
    AND NOT EXISTS(SELECT 1 FROM unnest($1::text[]) x WHERE has_table_privilege('dyna_app',to_regclass(x),'INSERT,UPDATE,DELETE'))
    AND NOT has_table_privilege('dyna_app',to_regclass('proforma_admissions'),'SELECT')
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['documents_kind_check','documents_proforma_local']) n
      WHERE NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid='documents'::regclass AND k.conname::text=n AND k.convalidated))
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['document_order_mode','document_demo_number','proforma_series_page','proforma_admissions_tx']) n
      WHERE NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass(n) AND i.indisvalid))
    AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid=to_regclass('proforma_receipts') AND k.contype='f' AND k.convalidated AND cardinality(k.conkey)=2)=5
    AND (SELECT count(*) FROM pg_constraint k WHERE k.conrelid=to_regclass('proforma_admissions') AND k.contype='f' AND k.convalidated AND k.condeferrable AND k.condeferred)=1
    AND current_setting('session_replication_role')='origin' available`,
      [tables, functions, JSON.stringify(guards)],
    )
  ).rows[0].available;
  ensure(full, 503, unavailable);
  ensure(
    (await c.query('SELECT proforma_installed() installed')).rows[0].installed,
    503,
    unavailable,
  );
  return true;
}
type Grant = { role: Actor['role']; key_valid: boolean; allowed: boolean };
async function access(
  c: PoolClient,
  a: ProformaActor,
  writing: boolean,
  pin: boolean,
): Promise<Grant> {
  const g = (
    await c.query('SELECT proforma_access($1,$2,$3,$4) g', [
      a.userId,
      a.apiKeyId ?? null,
      writing,
      pin,
    ])
  ).rows[0].g;
  ensure(g.key_valid, 401, 'Klucz proformy jest wycofany lub wygasł');
  ensure(g.allowed, 403, 'Brak aktualnych uprawnień do proformy');
  return g;
}
async function flags(c: PoolClient, a: ProformaActor, writing: boolean, admin = false) {
  const g = await access(c, a, writing, true);
  if (admin) ensure(g.role === 'admin', 403, 'Serią proform zarządza administrator');
  const w = (
    await c.query('SELECT proforma_access($1,$2,true,false) g', [a.userId, a.apiKeyId ?? null])
  ).rows[0].g as Grant;
  return {
    available: true,
    read_only: false,
    current_role: g.role,
    can_read: true,
    can_write: Boolean(w.allowed),
    can_create_series: Boolean(w.allowed && g.role === 'admin'),
  };
}
async function transaction<T>(
  a: ProformaActor,
  writing: boolean,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  ensure(await proformasAvailable(pool), 503, 'Lokalne proformy nie są dostępne');
  try {
    return await tenantTx(a.tenantId, async (c) => {
      await proformasAvailable(c);
      await access(c, a, writing, false);
      return fn(c);
    });
  } catch (error) {
    if (error instanceof Problem) throw error;
    const e = error as { code?: string; message?: string };
    if (e.code === '23514' && e.message === 'Klucz proformy jest wycofany lub wygasł')
      throw new Problem(401, e.message);
    if (
      e.code === '23514' &&
      ['Brak aktualnych uprawnień do proformy', 'Serią proform zarządza administrator'].includes(
        e.message ?? '',
      )
    )
      throw new Problem(403, e.message!);
    if (e.code === 'P0002') throw new Problem(404, e.message ?? 'Nie znaleziono proformy');
    if (e.code === '23514') throw new Problem(409, e.message ?? 'Zakres proformy zmienił się');
    if (e.code === '23505')
      throw new Problem(409, 'Seria, numer lub proforma zamówienia już istnieje');
    throw error;
  }
}
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
function seriesView(s: Record<string, any>): ProformaSeries {
  return {
    id: s.id,
    version: 1,
    name: s.name,
    prefix: s.prefix,
    seller: s.definition.seller,
    payment_terms_days: s.definition.payment_terms_days,
    payment_instructions: s.definition.payment_instructions,
    notes: s.definition.notes,
    created_at: iso(s.created_at),
  };
}
async function previewView(c: PoolClient, a: ProformaActor, id: string): Promise<ProformaPreview> {
  const p = (await c.query('SELECT * FROM proforma_previews WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu proformy');
  const d = (
    await c.query("SELECT id FROM documents WHERE order_id=$1 AND kind='proforma'", [p.order_id])
  ).rows[0];
  return {
    id: p.id,
    order_id: p.order_id,
    order_version: String(p.order_version),
    series_id: p.series_id,
    scope_hash: p.scope_hash,
    snapshot: p.snapshot,
    expires_at: iso(p.expires_at),
    created_at: iso(p.created_at),
    issued_document_id: d?.id ?? null,
    can_issue:
      !d &&
      p.actor_id === a.userId &&
      p.api_key_id === (a.apiKeyId ?? null) &&
      new Date(p.expires_at).getTime() > Date.now(),
  };
}
async function documentView(
  c: PoolClient,
  id: string,
): Promise<{ document: ProformaDocument; receipt: ProformaReceipt }> {
  const d = (
    await c.query("SELECT * FROM documents WHERE id=$1 AND kind='proforma' AND mode='local'", [id])
  ).rows[0];
  ensure(d, 404, 'Nie znaleziono własnej proformy');
  const r = (await c.query('SELECT * FROM proforma_receipts WHERE document_id=$1', [id])).rows[0];
  ensure(
    r &&
      r.order_id === d.order_id &&
      r.number === d.number &&
      d.data.preview_id === r.preview_id &&
      d.data.scope_hash === r.scope_hash,
    503,
    'Niepełny trwały dowód proformy',
  );
  return {
    document: {
      id: d.id,
      order_id: d.order_id,
      number: d.number,
      kind: 'proforma',
      mode: 'local',
      data: d.data,
      created_at: iso(d.created_at),
    },
    receipt: {
      id: r.id,
      document_id: r.document_id,
      preview_id: r.preview_id,
      series_id: r.series_id,
      year: r.year,
      sequence: r.sequence,
      number: r.number,
      scope_hash: r.scope_hash,
      created_at: iso(r.created_at),
    },
  };
}
export async function proformaOptions(a: ProformaActor) {
  if (!(await proformasAvailable(pool)))
    return {
      available: false,
      read_only: false,
      current_role: a.role,
      can_read: false,
      can_write: false,
      can_create_series: false,
      limits: PROFORMA_LIMITS,
    };
  return transaction(a, false, async (c) => ({
    ...(await flags(c, a, false)),
    limits: PROFORMA_LIMITS,
  }));
}
export async function listProformaSeries(a: ProformaActor, page: unknown = {}) {
  const q = proformaPageQuery.parse(page);
  return transaction(a, false, async (c) => {
    if (q.cursor)
      ensure(
        (await c.query('SELECT id FROM proforma_series WHERE id=$1', [q.cursor])).rowCount,
        404,
        'Nie znaleziono kursora własnych serii',
      );
    const data = (
      await c.query(
        `SELECT * FROM proforma_series WHERE
      ($1::uuid IS NULL OR(created_at,id)<(SELECT created_at,id FROM proforma_series WHERE id=$1))
      ORDER BY created_at DESC,id DESC LIMIT 51`,
        [q.cursor ?? null],
      )
    ).rows;
    const more = data.length > 50;
    const rows = data.slice(0, 50).map(seriesView);
    return {
      ...(await flags(c, a, false)),
      data: rows,
      next_cursor: more ? rows.at(-1)!.id : null,
    };
  });
}
export async function createProformaSeries(a: ProformaActor, input: ProformaSeriesInput) {
  const b = proformaSeriesInput.parse(input);
  return transaction(a, true, async (c) => {
    const s = (
      await c.query('SELECT proforma_create_series($1::jsonb,$2,$3) s', [
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].s;
    if (!s.reused) await audit(c, a, 'proforma.series.create', s.id, { prefix: s.prefix });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const view = seriesView(s);
    return { ...(await flags(c, a, true, true)), series: view, reused: Boolean(s.reused) };
  });
}
export async function previewProforma(
  a: ProformaActor,
  orderId: string,
  input: ProformaPreviewInput,
) {
  const b = proformaPreviewInput.parse(input);
  return transaction(a, true, async (c) => {
    const p = (
      await c.query('SELECT proforma_store_preview($1,$2::jsonb,$3,$4) p', [
        orderId,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].p;
    if (!p.reused)
      await audit(c, a, 'proforma.preview', p.id, {
        order_id: orderId,
        series_id: b.series_id,
        scope_hash: p.scope_hash,
      });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const preview = await previewView(c, a, p.id);
    const f = await flags(c, a, true);
    preview.can_issue &&= f.can_write;
    return { ...f, preview, reused: Boolean(p.reused) };
  });
}
export async function issueProforma(
  a: ProformaActor,
  previewId: string,
  input: ProformaIssueInput,
) {
  const b = proformaIssueInput.parse(input);
  return transaction(a, true, async (c) => {
    const r = (
      await c.query('SELECT proforma_issue($1,$2::jsonb,$3,$4) r', [
        previewId,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].r;
    if (!r.reused)
      await audit(c, a, 'proforma.issue', r.document_id, {
        order_id: r.order_id,
        preview_id: previewId,
        number: r.number,
        scope_hash: r.scope_hash,
      });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const result = await documentView(c, r.document_id);
    return { ...(await flags(c, a, true)), ...result, reused: Boolean(r.reused) };
  });
}
export async function proformaPreviewDetail(a: ProformaActor, id: string) {
  return transaction(a, false, async (c) => {
    const preview = await previewView(c, a, id);
    const f = await flags(c, a, false);
    preview.can_issue &&= f.can_write;
    return { ...f, preview };
  });
}
export async function proformaDetail(a: ProformaActor, documentId: string) {
  return transaction(a, false, async (c) => {
    const result = await documentView(c, documentId);
    return { ...(await flags(c, a, false)), ...result };
  });
}
