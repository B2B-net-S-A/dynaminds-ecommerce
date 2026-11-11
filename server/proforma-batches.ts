import type { Pool, PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import {
  proformasAvailable,
  type ProformaSnapshot,
  type ProformaDocument,
  type ProformaReceipt,
} from './proformas';
import type { ProformaActor } from './proforma-values';
import {
  PROFORMA_BATCH_LIMITS,
  proformaBatchPreviewInput,
  proformaBatchIssueInput,
  proformaBatchHistoryQuery,
  type ProformaBatchPreviewInput,
  type ProformaBatchIssueInput,
} from './proforma-batch-values';

export type ProformaBatchRow = {
  index: number;
  order_id: string;
  order_version: string;
  preview_id: string;
  scope_hash: string;
  snapshot: ProformaSnapshot;
};
export type ProformaBatchSummary = {
  orders: number;
  currencies: { currency: string; gross_minor: string; net_minor: string; vat_minor: string }[];
};
export type ProformaBatchPreview = {
  id: string;
  series_id: string;
  shipping_vat: number;
  scope_hash: string;
  summary: ProformaBatchSummary;
  rows: ProformaBatchRow[];
  created_at: string;
  expires_at: string;
  can_issue: boolean;
  issued_execution_id: string | null;
};
export type ProformaBatchExecution = {
  id: string;
  preview_id: string;
  series_id: string;
  shipping_vat: number;
  scope_hash: string;
  summary: ProformaBatchSummary;
  rows: (ProformaBatchRow & { document: ProformaDocument; receipt: ProformaReceipt })[];
  created_at: string;
};
export { PROFORMA_BATCH_LIMITS } from './proforma-batch-values';
const tables = [
  'proforma_batch_previews',
  'proforma_batch_preview_rows',
  'proforma_batch_executions',
  'proforma_batch_execution_rows',
  'proforma_batch_admissions',
];
const funcs = [
  'proforma_batch_installed()',
  'proforma_batch_child_key(uuid,uuid,text)',
  'proforma_batch_request_valid(jsonb)',
  'proforma_batch_locks(jsonb)',
  'proforma_batch_summary(jsonb)',
  'proforma_batch_validate_preview(jsonb,jsonb,uuid,uuid)',
  'proforma_batch_preview_guard()',
  'proforma_batch_preview_row_guard()',
  'proforma_batch_store_preview(jsonb,uuid,uuid)',
  'proforma_batch_admission_guard()',
  'proforma_batch_child_guard()',
  'proforma_batch_execution_guard()',
  'proforma_batch_execution_row_guard()',
  'proforma_batch_issue(uuid,jsonb,uuid,uuid)',
  'proforma_batch_complete()',
  'proforma_batch_seal()',
];
const guards = [
  ...tables.map((table) => ({
    table,
    name: 'proforma_batch_immutable',
    fn: 'proforma_immutable()',
    deferred: false,
  })),
  ...[
    'proforma_batch_previews',
    'proforma_batch_executions',
    'proforma_batch_admissions',
    'proforma_receipts',
  ].map((table) => ({
    table,
    name: 'proforma_batch_complete',
    fn: 'proforma_batch_complete()',
    deferred: true,
  })),
  ...['orders', 'order_items', 'return_cases'].map((table) => ({
    table,
    name: 'proforma_batch_seal',
    fn: 'proforma_batch_seal()',
    deferred: false,
  })),
  ...[
    ['proforma_batch_previews', 'proforma_batch_preview_guard'],
    ['proforma_batch_preview_rows', 'proforma_batch_preview_row_guard'],
    ['proforma_batch_admissions', 'proforma_batch_admission_guard'],
    ['proforma_batch_executions', 'proforma_batch_execution_guard'],
    ['proforma_batch_execution_rows', 'proforma_batch_execution_row_guard'],
    ['proforma_admissions', 'proforma_batch_child_guard'],
  ].map(([table, name]) => ({ table, name, fn: `${name}()`, deferred: false })),
];
export async function proformaBatchesAvailable(c: Pool | PoolClient): Promise<boolean> {
  const r = (
    await c.query(
      `SELECT current_user db_role,EXISTS(SELECT 1 FROM unnest($1::text[]) n WHERE to_regclass(n) IS NOT NULL)
    OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'proforma_batch_%') artifacts`,
      [tables],
    )
  ).rows[0];
  if (!r.artifacts) {
    ensure(r.db_role !== 'dyna_app', 503, 'Moduł masowych proform jest niekompletny');
    ensure(
      !(
        await c.query(
          "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='128_proforma_batches') installed",
        )
      ).rows[0].installed,
      503,
      'Moduł masowych proform jest niekompletny',
    );
    return false;
  }
  const ok = (
    await c.query(
      `SELECT
    (SELECT count(*) FROM pg_class WHERE oid=ANY(ARRAY(SELECT to_regclass(n) FROM unnest($1::text[]) n)) AND relrowsecurity AND relforcerowsecurity)=5
    AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) n WHERE to_regprocedure(n) IS NULL)
    AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) g("table" text,name text,fn text,deferred boolean)
      WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(g."table") AND t.tgname::text=g.name AND t.tgfoid=to_regprocedure(g.fn)
      AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgdeferrable=g.deferred AND t.tginitdeferred=g.deferred))
    AND NOT EXISTS(SELECT 1 FROM unnest($1::text[]) n WHERE has_table_privilege('dyna_app',to_regclass(n),'INSERT,UPDATE,DELETE'))
    AND NOT has_table_privilege('dyna_app',to_regclass('proforma_batch_admissions'),'SELECT')
    AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('proforma_batch_execution_rows') AND contype='f' AND convalidated)=4
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('proforma_batch_admissions') AND confrelid=to_regclass('proforma_batch_executions') AND contype='f' AND convalidated AND condeferrable AND condeferred)
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['proforma_batch_previews_page','proforma_batch_executions_page','proforma_batch_admissions_tx']) n WHERE NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass(n) AND i.indisvalid))
    AND current_setting('session_replication_role')='origin' available`,
      [tables, funcs, JSON.stringify(guards)],
    )
  ).rows[0].available;
  ensure(ok, 503, 'Moduł masowych proform jest niekompletny');
  ensure(await proformasAvailable(c), 503, 'Brak silnika pojedynczej proformy');
  ensure(
    (await c.query('SELECT proforma_batch_installed() installed')).rows[0].installed,
    503,
    'Brak potwierdzonej migracji masowych proform',
  );
  return true;
}
async function access(c: PoolClient, a: ProformaActor, writing: boolean, pin = false) {
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
async function flags(c: PoolClient, a: ProformaActor, writing: boolean) {
  const g = await access(c, a, writing, true);
  const w = (
    await c.query('SELECT proforma_access($1,$2,true,false) g', [a.userId, a.apiKeyId ?? null])
  ).rows[0].g;
  return {
    available: true,
    read_only: false,
    current_role: g.role,
    can_read: true,
    can_write: Boolean(w.allowed),
  };
}
async function tx<T>(
  a: ProformaActor,
  write: boolean,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  ensure(await proformaBatchesAvailable(pool), 503, 'Masowe proformy nie są dostępne');
  try {
    return await tenantTx(a.tenantId, async (c) => {
      await proformaBatchesAvailable(c);
      await access(c, a, write);
      return fn(c);
    });
  } catch (err) {
    if (err instanceof Problem) throw err;
    const e = err as { code?: string; message?: string };
    if (e.code === '23514' && e.message === 'Klucz proformy jest wycofany lub wygasł')
      throw new Problem(401, e.message);
    if (e.code === '23514' && e.message === 'Brak aktualnych uprawnień do proformy')
      throw new Problem(403, e.message);
    if (e.code === 'P0002') throw new Problem(404, e.message ?? 'Nie znaleziono partii proform');
    if (e.code === '23514') throw new Problem(409, e.message ?? 'Partia proform zmieniła się');
    if (e.code === '23505')
      throw new Problem(409, 'Partia, numer lub proforma zamówienia już istnieje');
    throw err;
  }
}
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
async function previewView(
  c: PoolClient,
  a: ProformaActor,
  id: string,
): Promise<ProformaBatchPreview> {
  const p = (await c.query('SELECT * FROM proforma_batch_previews WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu partii proform');
  const e = (await c.query('SELECT id FROM proforma_batch_executions WHERE preview_id=$1', [id]))
    .rows[0];
  return {
    ...p.payload,
    scope_hash: p.scope_hash,
    created_at: iso(p.created_at),
    expires_at: iso(p.expires_at),
    issued_execution_id: e?.id ?? null,
    can_issue:
      !e &&
      p.actor_id === a.userId &&
      p.api_key_id === (a.apiKeyId ?? null) &&
      new Date(p.expires_at).getTime() > Date.now(),
  };
}
async function executionView(c: PoolClient, id: string): Promise<ProformaBatchExecution> {
  const e = (await c.query('SELECT * FROM proforma_batch_executions WHERE id=$1', [id])).rows[0];
  ensure(e, 404, 'Nie znaleziono wykonania partii proform');
  return { ...e.payload, scope_hash: e.scope_hash, created_at: iso(e.created_at) };
}
export async function previewProformaBatch(a: ProformaActor, input: ProformaBatchPreviewInput) {
  const b = proformaBatchPreviewInput.parse(input);
  return tx(a, true, async (c) => {
    const p = (
      await c.query('SELECT proforma_batch_store_preview($1::jsonb,$2,$3) p', [
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].p;
    if (!p.reused)
      await audit(c, a, 'proforma.batch.preview', p.id, {
        scope_hash: p.scope_hash,
        orders: b.orders.map((r) => r.order_id),
      });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const preview = await previewView(c, a, p.id);
    const f = await flags(c, a, true);
    preview.can_issue &&= f.can_write;
    return { ...f, preview, reused: Boolean(p.reused) };
  });
}
export async function issueProformaBatch(
  a: ProformaActor,
  id: string,
  input: ProformaBatchIssueInput,
) {
  const b = proformaBatchIssueInput.parse(input);
  return tx(a, true, async (c) => {
    const e = (
      await c.query('SELECT proforma_batch_issue($1,$2::jsonb,$3,$4) e', [
        id,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].e;
    if (!e.reused) {
      for (const row of e.payload.rows)
        await audit(c, a, 'proforma.issue', row.document.id, {
          order_id: row.order_id,
          preview_id: row.preview_id,
          number: row.document.number,
          batch_execution_id: e.id,
          scope_hash: row.scope_hash,
        });
      await audit(c, a, 'proforma.batch.issue', e.id, {
        preview_id: id,
        orders: e.payload.rows.length,
        scope_hash: e.scope_hash,
      });
    }
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const execution = await executionView(c, e.id);
    return { ...(await flags(c, a, true)), execution, reused: Boolean(e.reused) };
  });
}
export async function proformaBatchPreviewDetail(a: ProformaActor, id: string) {
  return tx(a, false, async (c) => {
    const preview = await previewView(c, a, id);
    const f = await flags(c, a, false);
    preview.can_issue &&= f.can_write;
    return { ...f, preview };
  });
}
export async function proformaBatchExecutionDetail(a: ProformaActor, id: string) {
  return tx(a, false, async (c) => {
    const execution = await executionView(c, id);
    return { ...(await flags(c, a, false)), execution };
  });
}
export async function proformaBatchHistory(a: ProformaActor, query: unknown) {
  const q = proformaBatchHistoryQuery.parse(query);
  const table = q.kind === 'preview' ? 'proforma_batch_previews' : 'proforma_batch_executions';
  return tx(a, false, async (c) => {
    if (q.cursor)
      ensure(
        (await c.query(`SELECT id FROM ${table} WHERE id=$1`, [q.cursor])).rowCount,
        404,
        'Nie znaleziono własnego kursora partii',
      );
    const extra =
      q.kind === 'preview'
        ? `h.expires_at,(SELECT e.id FROM proforma_batch_executions e WHERE e.preview_id=h.id) issued_execution_id`
        : 'h.preview_id';
    const rows = (
      await c.query(
        `SELECT h.id,h.scope_hash,h.created_at,h.payload->>'series_id' series_id,
      (h.payload->>'shipping_vat')::integer shipping_vat,h.payload->'summary' summary,${extra}
      FROM ${table} h WHERE($1::uuid IS NULL OR(h.created_at,h.id)<(SELECT created_at,id FROM ${table} WHERE id=$1))
      ORDER BY h.created_at DESC,h.id DESC LIMIT 51`,
        [q.cursor ?? null],
      )
    ).rows;
    const data = rows
      .slice(0, 50)
      .map((row) => ({
        ...row,
        kind: q.kind,
        created_at: iso(row.created_at),
        ...(q.kind === 'preview' ? { expires_at: iso(row.expires_at) } : {}),
      }));
    const f = await flags(c, a, false);
    return { ...f, kind: q.kind, data, next_cursor: rows.length > 50 ? rows[49].id : null };
  });
}
/** Root-owned 127 route calls this BEFORE the legacy exact-replay branch. SQL independently guards the write race. */
export async function assertStandaloneProformaPreview(a: ProformaActor, id: string) {
  if (!(await proformaBatchesAvailable(pool))) return;
  await tx(a, true, async (c) => {
    const linked = (
      await c.query('SELECT 1 FROM proforma_batch_preview_rows WHERE preview_id=$1', [id])
    ).rowCount;
    ensure(!linked, 409, 'Podgląd dziecka wymaga zgody i wykonania całej partii');
    await access(c, a, true, true);
  });
}
