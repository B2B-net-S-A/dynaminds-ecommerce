import { assertLabelsNotCancelledInTx } from './shipment-cancelled';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { decrypt, encrypt } from './security';
import {
  printJobsAvailable,
  type PrintJobFlags,
  type PrintPrinter,
  type PrintStation,
} from './print-jobs';
import { printUuid, validatePrintContent, type PrintActor } from './print-job-values';
import {
  SHIPMENT_LABEL_BATCH_LIMITS,
  shipmentLabelBatchPreviewInput,
  shipmentLabelBatchQueueInput,
  shipmentLabelBatchHistoryInput,
  shipmentLabelBatchChildKey,
  type ShipmentLabelBatchPreviewInput,
  type ShipmentLabelBatchQueueInput,
  type ShipmentLabelBatchHistoryInput,
} from './shipment-label-batch-values';
import {
  renderShipmentLabelBatchPdf,
  validateShipmentLabelBatchContent,
  type ShipmentLabelBatchPdfSource,
} from './shipment-label-batch-pdf';
export { SHIPMENT_LABEL_BATCH_LIMITS } from './shipment-label-batch-values';

export type ShipmentLabelBatchRow = {
  index: number;
  shipment_id: string;
  order_id: string;
  order_number: string;
  order_version: string;
  cache_asset_id: string;
  child_preview_id: string;
  child_scope_hash: string;
  tracking_number: string;
  provider: string;
  mode: string;
  layout: 'A4' | 'A6';
  source_hash: string;
  content_sha256: string;
  content_bytes: number;
  pages: number;
  page_from: number;
  page_to: number;
};
export type ShipmentLabelBatchSummary = {
  shipments: number;
  orders: number;
  source_pages: number;
  combined_pages: number;
  copies: number;
  expected_label_copies: number;
};
export type ShipmentLabelBatchPreview = {
  id: string;
  kind: 'preview';
  scope_hash: string;
  created_at: string;
  expires_at: string;
  station_snapshot: PrintStation;
  printer_snapshot: PrintPrinter;
  copies: number;
  summary: ShipmentLabelBatchSummary;
  combined_pdf: {
    format: 'pdf';
    content_sha256: string;
    content_bytes: number;
    pages: number;
    layout: 'A4' | 'A6';
  };
  rows: ShipmentLabelBatchRow[];
  queued_execution_id: string | null;
  can_queue: boolean;
};
export type ShipmentLabelBatchExecution = {
  id: string;
  kind: 'execution';
  preview_id: string;
  scope_hash: string;
  summary: ShipmentLabelBatchSummary;
  created_at: string;
  rows: (ShipmentLabelBatchRow & { job_id: string; job_create_event_id: string })[];
  progress: { index: number; job_id: string; state: string; version: string }[];
};
const tables = [
  'shipment_label_batch_previews',
  'shipment_label_batch_preview_rows',
  'shipment_label_batch_executions',
  'shipment_label_batch_execution_rows',
  'shipment_label_batch_admissions',
];
const missing = 'Moduł partii etykiet jest niekompletny';
export async function shipmentLabelBatchesAvailable(c: Pool | PoolClient): Promise<boolean> {
  if (!(await printJobsAvailable(c))) return false;
  try {
    const p = (
      await c.query(
        `SELECT current_user db_role,EXISTS(SELECT 1 FROM unnest($1::text[]) n WHERE to_regclass(n) IS NOT NULL) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'label_batch_%') artifacts`,
        [tables],
      )
    ).rows[0];
    if (!p.artifacts) {
      ensure(p.db_role !== 'dyna_app', 503, missing);
      ensure(
        !(
          await c.query(
            "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='132_shipment_label_batches') installed",
          )
        ).rows[0].installed,
        503,
        missing,
      );
      return false;
    }
    ensure(
      (
        await c.query(
          "SELECT to_regprocedure('label_batch_guards()') IS NOT NULL AND to_regprocedure('label_batch_installed()') IS NOT NULL ok",
        )
      ).rows[0].ok,
      503,
      missing,
    );
    const g = (await c.query('SELECT label_batch_guards() ok,label_batch_installed() installed'))
      .rows[0];
    ensure(g.ok && g.installed, 503, missing);
    return true;
  } catch (e) {
    if (['42P01', '42703', '42883'].includes((e as { code?: string }).code ?? ''))
      throw new Problem(503, missing);
    throw e;
  }
}
type Grant = { role: PrintActor['role']; allowed: boolean; key_valid: boolean };
async function access(c: PoolClient, a: PrintActor, write: boolean, pin: boolean) {
  const g = (
    await c.query('SELECT label_cache_access($1,$2,$3,$4) g', [
      a.userId,
      a.apiKeyId ?? null,
      write,
      pin,
    ])
  ).rows[0].g as Grant;
  ensure(g.key_valid, 401, 'Klucz drukowania jest nieaktualny');
  ensure(g.allowed, 403, 'Brak aktualnego uprawnienia do drukowania');
  return g;
}
async function flags(
  c: PoolClient,
  a: PrintActor,
  write: boolean,
): Promise<PrintJobFlags & { batch_available: true }> {
  const g = await access(c, a, write, true);
  const w = (
    await c.query('SELECT label_cache_access($1,$2,true,false) g', [a.userId, a.apiKeyId ?? null])
  ).rows[0].g as Grant;
  return {
    available: true,
    batch_available: true,
    read_only: false,
    current_role: g.role,
    can_read: true,
    can_write: w.key_valid && w.allowed,
    can_manage: w.key_valid && w.allowed && g.role === 'admin',
  };
}
async function tx<T>(
  a: PrintActor,
  write: boolean,
  fn: (c: PoolClient) => Promise<T>,
  availabilityChecked = false,
) {
  if (!availabilityChecked) ensure(await shipmentLabelBatchesAvailable(pool), 503, missing);
  try {
    return await tenantTx(a.tenantId, async (c) => {
      if (write && !availabilityChecked) ensure(await shipmentLabelBatchesAvailable(c), 503, missing);
      await access(c, a, write, false);
      return fn(c);
    });
  } catch (e) {
    if (e instanceof Problem) throw e;
    const err = e as { code?: string; message?: string };
    if (
      err.code === '23514' &&
      ['Klucz drukowania jest nieaktualny', 'Klucz cache etykiet jest nieaktualny'].includes(
        err.message ?? '',
      )
    )
      throw new Problem(401, err.message!);
    if (
      err.code === '23514' &&
      [
        'Brak aktualnego uprawnienia do drukowania',
        'Brak aktualnego uprawnienia do cache etykiet',
      ].includes(err.message ?? '')
    )
      throw new Problem(403, err.message!);
    if (err.code === '55000') throw new Problem(503, missing);
    if (err.code === 'P0002') throw new Problem(404, err.message ?? 'Nie znaleziono partii');
    if (['23514', '23503', '23505'].includes(err.code ?? ''))
      throw new Problem(409, err.message ?? 'Zakres partii zmienił się');
    throw e;
  }
}
async function previewView(c: PoolClient, id: string) {
  const p = (
    await c.query(
      'SELECT id,actor_id,api_key_id,scope_hash,payload FROM shipment_label_batch_previews WHERE id=$1',
      [id],
    )
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu partii');
  const executed = (
    await c.query('SELECT id FROM shipment_label_batch_executions WHERE preview_id=$1', [id])
  ).rows[0];
  return {
    p,
    preview: {
      ...p.payload,
      scope_hash: p.scope_hash,
      queued_execution_id: executed?.id ?? null,
      can_queue: false,
    } as ShipmentLabelBatchPreview,
  };
}
function eligible(h: Awaited<ReturnType<typeof previewView>>, a: PrintActor, f: PrintJobFlags) {
  return {
    ...h.preview,
    can_queue:
      f.can_write &&
      !h.preview.queued_execution_id &&
      h.p.actor_id === a.userId &&
      h.p.api_key_id === (a.apiKeyId ?? null) &&
      Date.parse(h.preview.expires_at) > Date.now(),
  };
}
async function executionView(c: PoolClient, id: string): Promise<ShipmentLabelBatchExecution> {
  const e = (await c.query('SELECT payload FROM shipment_label_batch_executions WHERE id=$1', [id]))
    .rows[0];
  ensure(e, 404, 'Nie znaleziono wykonania partii');
  const progress = (
    await c.query(
      'SELECT r.index,r.job_id,j.state,j.version::text FROM shipment_label_batch_execution_rows r JOIN print_jobs j ON (j.tenant_id,j.id)=(r.tenant_id,r.job_id) WHERE r.execution_id=$1 ORDER BY r.index',
      [id],
    )
  ).rows;
  ensure(progress.length === e.payload.rows.length, 503, missing);
  return { ...e.payload, progress };
}
async function sourceBytes(c: PoolClient, a: PrintActor, id: string, cache: boolean) {
  const raw = (
    await c.query(
      cache ? 'SELECT label_cache_content($1,$2,$3) r' : 'SELECT label_print_asset($1,$2,$3) r',
      [id, a.userId, a.apiKeyId ?? null],
    )
  ).rows[0].r;
  try {
    const b64 = decrypt(raw.content_encrypted).content_base64;
    const checked = validatePrintContent(b64, 'pdf');
    ensure(
      checked.content_sha256 === raw.content_sha256 && checked.content_bytes === raw.content_bytes,
      502,
      'Niezgodna integralność etykiety',
    );
    return {
      content_base64: b64 as string,
      content_sha256: checked.content_sha256,
      content_bytes: checked.content_bytes,
    };
  } catch {
    throw new Problem(502, 'Nie można zweryfikować zapisanej etykiety');
  }
}
// Read only and the first request of the batch panel: the availability chain costs seconds, so it runs once here.
export async function shipmentLabelBatchOptions(a: PrintActor) {
  if (!(await shipmentLabelBatchesAvailable(pool)))
    return {
      available: false,
      batch_available: false,
      read_only: false,
      current_role: null,
      can_read: false,
      can_write: false,
      can_manage: false,
      stations: [],
      printers: [],
      limits: SHIPMENT_LABEL_BATCH_LIMITS,
    };
  return tx(a, false, async (c) => {
    const stations = (
      await c.query(
        'SELECT id,code,label,enabled,version::text FROM packing_stations ORDER BY id LIMIT 101',
      )
    ).rows;
    const printers = (
      await c.query(
        'SELECT id,station_id,name,format,output_mode,cups_queue,enabled,version::text,created_at,updated_at FROM print_printers ORDER BY id LIMIT 101',
      )
    ).rows;
    ensure(
      stations.length <= 100 && printers.length <= 100,
      409,
      'Zbyt wiele stanowisk lub drukarek',
    );
    return {
      stations,
      printers,
      limits: SHIPMENT_LABEL_BATCH_LIMITS,
      ...(await flags(c, a, false)),
    };
  }, true);
}
export async function createShipmentLabelBatchPreview(
  a: PrintActor,
  input: ShipmentLabelBatchPreviewInput,
) {
  const b = shipmentLabelBatchPreviewInput.parse(input);
  return tx(a, true, async (c) => {
    await assertLabelsNotCancelledInTx(c, b.shipments.map((s) => s.shipment_id));
    let id = (
      await c.query('SELECT label_batch_preview_replay($1::jsonb,$2,$3) id', [
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].id as string | null;
    const reused = !!id;
    if (!id) {
      id = randomUUID();
      await c.query('SELECT label_batch_prepare_preview($1,$2::jsonb,$3,$4)', [
        id,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ]);
      const sources: ShipmentLabelBatchPdfSource[] = [];
      for (const s of b.shipments) {
        const metadata = (
          await c.query(
            'SELECT layout FROM shipment_label_cache_assets WHERE id=$1 AND shipment_id=$2',
            [s.asset_id, s.shipment_id],
          )
        ).rows[0];
        ensure(metadata, 409, 'Nie znaleziono wskazanego cache etykiety');
        sources.push({
          ...(await sourceBytes(c, a, s.asset_id, true)),
          shipment_id: s.shipment_id,
          asset_id: s.asset_id,
          layout: metadata.layout,
        });
      }
      let combined: Awaited<ReturnType<typeof renderShipmentLabelBatchPdf>>;
      try {
        combined = await renderShipmentLabelBatchPdf(sources);
      } catch {
        throw new Problem(422, 'Etykiety nie spełniają limitów wspólnego PDF A4 lub A6');
      }
      const v = {
        id,
        request: b,
        rows: combined.rows.map((r, i) => ({
          ...r,
          content_base64: sources[i].content_base64,
          content_encrypted: encrypt({ content_base64: sources[i].content_base64 }),
        })),
        combined_pdf: {
          format: 'pdf',
          content_sha256: combined.content_sha256,
          content_bytes: combined.content_bytes,
          pages: combined.pages,
          layout: combined.layout,
        },
        combined_content_base64: combined.content_base64,
        combined_content_encrypted: encrypt({ content_base64: combined.content_base64 }),
      };
      id = (
        await c.query('SELECT label_batch_store_preview($1::jsonb,$2,$3) id', [
          JSON.stringify(v),
          a.userId,
          a.apiKeyId ?? null,
        ])
      ).rows[0].id;
      await audit(c, a, 'print.label.batch.preview', id!, {
        shipments: b.shipments.length,
        content_sha256: combined.content_sha256,
      });
    }
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const h = await previewView(c, id!);
    const f = await flags(c, a, true);
    return { preview: eligible(h, a, f), reused, ...f };
  });
}
export async function shipmentLabelBatchPreviewDetail(a: PrintActor, id: string) {
  id = printUuid.parse(id);
  return tx(a, false, async (c) => {
    const h = await previewView(c, id);
    const f = await flags(c, a, false);
    return { preview: eligible(h, a, f), ...f };
  });
}
export async function shipmentLabelBatchContent(a: PrintActor, id: string) {
  id = printUuid.parse(id);
  return tx(a, true, async (c) => {
    const r = (
      await c.query('SELECT label_batch_content($1,$2,$3) r', [id, a.userId, a.apiKeyId ?? null])
    ).rows[0].r;
    let content: Awaited<ReturnType<typeof validateShipmentLabelBatchContent>>;
    try {
      content = await validateShipmentLabelBatchContent(
        decrypt(r.combined_content_encrypted).content_base64,
        r.metadata.content_sha256,
        r.metadata.content_bytes,
      );
    } catch {
      throw new Problem(502, 'Nie można zweryfikować wspólnego PDF');
    }
    ensure(
      content.pages === r.metadata.pages && content.layout === r.metadata.layout,
      502,
      'Niezgodny manifest wspólnego PDF',
    );
    return { preview_id: id, format: 'pdf' as const, ...content, ...(await flags(c, a, true)) };
  });
}
export async function queueShipmentLabelBatch(
  a: PrintActor,
  id: string,
  input: ShipmentLabelBatchQueueInput,
) {
  id = printUuid.parse(id);
  const b = shipmentLabelBatchQueueInput.parse(input);
  return tx(a, true, async (c) => {
    let eid = (
      await c.query('SELECT label_batch_execution_replay($1,$2::jsonb,$3,$4) id', [
        id,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].id as string | null;
    const reused = !!eid;
    if (!eid) {
      eid = randomUUID();
      await c.query('SELECT label_batch_prepare_queue($1,$2,$3::jsonb,$4,$5)', [
        id,
        eid,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ]);
      const h = await previewView(c, id);
      for (const r of h.preview.rows) {
        const content = await sourceBytes(c, a, r.child_preview_id, false);
        const body = {
          client_key: shipmentLabelBatchChildKey(id, r.shipment_id, 'queue'),
          scope_hash: r.child_scope_hash,
          confirmed: true,
        };
        await c.query('SELECT label_print_queue($1,$2::jsonb,$3,$4,$5)', [
          r.child_preview_id,
          JSON.stringify(body),
          content.content_base64,
          a.userId,
          a.apiKeyId ?? null,
        ]);
      }
      await c.query('SELECT label_batch_store_execution($1,$2,$3::jsonb,$4,$5)', [
        eid,
        id,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ]);
      await audit(c, a, 'print.label.batch.queue', eid, {
        preview_id: id,
        shipments: h.preview.rows.length,
      });
    }
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const execution = await executionView(c, eid!);
    return { execution, reused, ...(await flags(c, a, true)) };
  });
}
export async function shipmentLabelBatchExecutionDetail(a: PrintActor, id: string) {
  id = printUuid.parse(id);
  return tx(a, false, async (c) => {
    const execution = await executionView(c, id);
    return { execution, ...(await flags(c, a, false)) };
  });
}
export async function shipmentLabelBatchHistory(
  a: PrintActor,
  input: ShipmentLabelBatchHistoryInput,
) {
  const b = shipmentLabelBatchHistoryInput.parse(input);
  return tx(a, false, async (c) => {
    const table =
      b.kind === 'preview' ? 'shipment_label_batch_previews' : 'shipment_label_batch_executions';
    if (b.cursor)
      ensure(
        (await c.query(`SELECT id FROM ${table} WHERE id=$1`, [b.cursor])).rows[0],
        404,
        'Nie znaleziono kursora historii',
      );
    const extra =
      b.kind === 'preview'
        ? "jsonb_build_object('expires_at',h.expires_at,'queued_execution_id',(SELECT id FROM shipment_label_batch_executions WHERE preview_id=h.id))"
        : "jsonb_build_object('preview_id',h.preview_id)";
    const rows = (
      await c.query(
        `SELECT jsonb_build_object('id',h.id,'kind',$3::text,'scope_hash',h.scope_hash,'summary',h.payload->'summary','created_at',h.created_at)||${extra} head FROM ${table} h WHERE ($1::uuid IS NULL OR (h.created_at,h.id)<(SELECT created_at,id FROM ${table} WHERE id=$1)) ORDER BY h.created_at DESC,h.id DESC LIMIT $2`,
        [b.cursor ?? null, b.limit + 1, b.kind],
      )
    ).rows;
    const data = rows.slice(0, b.limit).map((r) => r.head);
    return {
      kind: b.kind,
      data,
      next_cursor: rows.length > b.limit ? data.at(-1)!.id : null,
      ...(await flags(c, a, false)),
    };
  });
}
