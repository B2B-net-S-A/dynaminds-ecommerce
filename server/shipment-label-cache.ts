import type { Pool, PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit } from './domain';
import { decrypt, encrypt } from './security';
import { InPost } from './integrations';
import type { IntegrationContext } from './channel-access';
import { printUuid, validatePrintContent, type PrintActor } from './print-job-values';
import { printJobsAvailable, type PrintJobFlags } from './print-jobs';
import { assertLabelsNotCancelledInTx } from './shipment-cancelled';
import {
  SHIPMENT_LABEL_CACHE_LIMITS,
  shipmentLabelCacheAcquireInput,
  shipmentLabelCacheReconcileInput,
  shipmentLabelCachePageInput,
  type ShipmentLabelCacheAcquireInput,
  type ShipmentLabelCacheReconcileInput,
  type ShipmentLabelCacheAcquisition,
  type ShipmentLabelCacheHead,
} from './shipment-label-cache-values';
export { SHIPMENT_LABEL_CACHE_LIMITS } from './shipment-label-cache-values';
export type {
  ShipmentLabelCacheAcquisition,
  ShipmentLabelCacheHead,
} from './shipment-label-cache-values';
const missing = 'Moduł cache etykiet jest niekompletny';
const tables = ['shipment_label_cache_assets', 'shipment_label_cache_acquisitions'];
export async function shipmentLabelCacheAvailable(c: Pool | PoolClient): Promise<boolean> {
  try {
    if (!(await printJobsAvailable(c))) return false;
    const p = (
      await c.query(
        `SELECT current_user db_role,EXISTS(SELECT 1 FROM unnest($1::text[]) n WHERE to_regclass(n) IS NOT NULL) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'label_cache_%') artifacts`,
        [tables],
      )
    ).rows[0];
    if (!p.artifacts) {
      ensure(p.db_role !== 'dyna_app', 503, missing);
      ensure(
        !(
          await c.query(
            "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='131_shipment_label_cache') installed",
          )
        ).rows[0].installed,
        503,
        missing,
      );
      return false;
    }
    ensure(
      (await c.query('SELECT label_cache_guards() ok,label_cache_installed() installed')).rows[0]
        .ok,
      503,
      missing,
    );
    ensure(
      (await c.query('SELECT label_cache_installed() installed')).rows[0].installed,
      503,
      missing,
    );
    return true;
  } catch (error) {
    if (['42P01', '42703', '42883'].includes((error as { code?: string }).code ?? ''))
      throw new Problem(503, missing);
    throw error;
  }
}
type Grant = { role: PrintActor['role']; allowed: boolean; key_valid: boolean; can_write: boolean };
async function access(c: PoolClient, a: PrintActor, writing: boolean, pin = false) {
  const g = (
    await c.query('SELECT label_cache_access($1,$2,$3,$4) g', [
      a.userId,
      a.apiKeyId ?? null,
      writing,
      pin,
    ])
  ).rows[0].g as Grant;
  ensure(g.key_valid, 401, 'Klucz cache etykiet jest nieaktualny');
  ensure(g.allowed, 403, 'Brak aktualnego uprawnienia do cache etykiet');
  return g;
}
async function flags(c: PoolClient, a: PrintActor, writing: boolean): Promise<PrintJobFlags> {
  const g = await access(c, a, writing, true);
  const w = (
    await c.query('SELECT label_cache_access($1,$2,true,false) g', [a.userId, a.apiKeyId ?? null])
  ).rows[0].g as Grant;
  return {
    available: true,
    read_only: false,
    current_role: g.role,
    can_read: true,
    can_write: !!w.allowed,
    can_manage: !!w.allowed && g.role === 'admin',
  };
}
function mapped(e: unknown): never {
  if (e instanceof Problem) throw e;
  const x = e as { code?: string; message?: string };
  if (
    x.code === '23514' &&
    ['Klucz cache etykiet jest nieaktualny', 'Klucz drukowania jest nieaktualny'].includes(
      x.message ?? '',
    )
  )
    throw new Problem(401, 'Klucz cache etykiet jest nieaktualny');
  if (
    x.code === '23514' &&
    [
      'Brak aktualnego uprawnienia do cache etykiet',
      'Brak aktualnego uprawnienia do drukowania',
    ].includes(x.message ?? '')
  )
    throw new Problem(403, 'Brak aktualnego uprawnienia do cache etykiet');
  if (x.code === '55000') throw new Problem(503, missing);
  if (x.code === 'P0002') throw new Problem(404, 'Nie znaleziono cache etykiety');
  if (['23514', '23505', '23503'].includes(x.code ?? ''))
    throw new Problem(409, x.message ?? 'Źródło cache etykiety zmieniło się');
  throw e;
}
// A read checks availability once, before its transaction (print-jobs.ts tx). Writes keep both.
async function tx<T>(
  a: PrintActor,
  writing: boolean,
  fn: (c: PoolClient) => Promise<T>,
  availabilityChecked = false,
): Promise<T> {
  if (!availabilityChecked) ensure(await shipmentLabelCacheAvailable(pool), 503, missing);
  try {
    return await tenantTx(a.tenantId, async (c) => {
      if (writing) await shipmentLabelCacheAvailable(c);
      await access(c, a, writing);
      return fn(c);
    });
  } catch (e) {
    return mapped(e);
  }
}
function acquisition(value: Record<string, any>, f: PrintJobFlags): ShipmentLabelCacheAcquisition {
  const { principal_matches, ...h } = value;
  return {
    ...h,
    can_reconcile: !!principal_matches && f.can_write && ['fetching', 'unknown'].includes(h.state),
  } as ShipmentLabelCacheAcquisition;
}
async function read(c: PoolClient, a: PrintActor, id: string) {
  return (await c.query('SELECT label_cache_read($1,$2,$3) r', [id, a.userId, a.apiKeyId ?? null]))
    .rows[0].r as { cache: ShipmentLabelCacheHead | null; acquisition: Record<string, any> };
}
async function result(a: PrintActor, id: string, reused: boolean, writing = true) {
  return tx(a, writing, async (c) => {
    const h = await read(c, a, id);
    const f = await flags(c, a, writing);
    return { cache: h.cache, acquisition: acquisition(h.acquisition, f), reused, ...f };
  });
}
export async function shipmentLabelCacheMetadata(a: PrintActor, shipmentId: string) {
  const sid = printUuid.parse(shipmentId);
  if (!(await shipmentLabelCacheAvailable(pool)))
    return {
      available: false,
      read_only: false,
      current_role: null,
      can_read: false,
      can_write: false,
      can_manage: false,
      cache: null,
      latest_acquisition: null,
      source_hash: null,
      order_version: null,
      can_acquire: false,
      can_queue: false,
      unavailable_reason: 'Cache etykiet nie jest zainstalowany',
      limits: SHIPMENT_LABEL_CACHE_LIMITS,
    };
  return tx(a, false, async (c) => {
    const m = (
      await c.query('SELECT label_cache_metadata($1,$2,$3) m', [sid, a.userId, a.apiKeyId ?? null])
    ).rows[0].m;
    const s = (await c.query('SELECT mode FROM shipments WHERE id=$1', [sid])).rows[0];
    const f = await flags(c, a, false);
    return {
      ...m,
      active: undefined,
      latest_acquisition: m.latest_acquisition ? acquisition(m.latest_acquisition, f) : null,
      can_acquire: f.can_write && !!m.source_hash && !m.active,
      can_queue: f.can_write && (!!m.cache || s?.mode === 'demo'),
      limits: SHIPMENT_LABEL_CACHE_LIMITS,
      ...f,
    };
  }, true);
}
export async function acquireShipmentLabelCache(
  a: PrintActor,
  shipmentId: string,
  input: ShipmentLabelCacheAcquireInput,
  ctx: IntegrationContext = {},
) {
  const sid = printUuid.parse(shipmentId),
    b = shipmentLabelCacheAcquireInput.parse(input);
  // This transaction commits the durable attempted request BEFORE any provider GET.
  const start = await tx(a, true, async (c) => {
    await assertLabelsNotCancelledInTx(c, [sid]);
    const r = (
      await c.query('SELECT label_cache_begin($1,$2::jsonb,$3,$4) r', [
        sid,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].r as { id: string; reused: boolean; network: boolean };
    if (!r.reused) await audit(c, a, 'print.label.cache.begin', r.id, { shipment_id: sid });
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await flags(c, a, true);
    return r;
  });
  if (start.reused) return result(a, start.id, true);
  // A new key can select an existing immutable cache without making a network request.
  try {
    const existing = await result(a, start.id, false);
    if (existing.acquisition.state === 'ready') return existing;
    const transport = await tx(a, true, async (c) => {
      const r = (
        await c.query('SELECT label_cache_transport($1,$2,$3) r', [
          start.id,
          a.userId,
          a.apiKeyId ?? null,
        ])
      ).rows[0].r;
      await flags(c, a, true);
      return r;
    });
    let content: Buffer;
    if (transport.provider === 'inpost') {
      // Connector chooses a fixed ShipX PL host; no runtime caller URL or retries.
      const creds = decrypt(transport.credentials);
      ensure(
        typeof creds.access_token === 'string' && creds.access_token.length > 0,
        422,
        'Brak tokenu istniejącego połączenia InPost',
      );
      content = await new InPost(transport.mode, creds, ctx.transport).label(
        transport.external_id,
        SHIPMENT_LABEL_CACHE_LIMITS.content_bytes,
      );
    } else {
      ensure(
        transport.provider === 'dpd' && typeof transport.content_base64 === 'string',
        409,
        'Brak zapisanych bajtów DPD',
      );
      content = Buffer.from(transport.content_base64, 'base64');
    }
    const b64 = content.toString('base64');
    try {
      validatePrintContent(b64, 'pdf');
    } catch {
      throw new Problem(422, 'Etykieta nie spełnia limitu bezpiecznego PDF');
    }
    await tx(a, true, async (c) => {
      await c.query('SELECT label_cache_finish($1,$2::jsonb,$3,$4)', [
        start.id,
        JSON.stringify({
          content_base64: b64,
          content_encrypted: encrypt({ content_base64: b64 }),
        }),
        a.userId,
        a.apiKeyId ?? null,
      ]);
      await audit(c, a, 'print.label.cache.ready', start.id, { shipment_id: sid });
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await read(c, a, start.id);
      await flags(c, a, true);
    });
  } catch (error) {
    const code =
      error instanceof Problem
        ? error.status === 401 || error.status === 403
          ? 'ACCESS_REVOKED'
          : error.status === 422
            ? 'LABEL_INVALID'
            : error.status === 409
              ? 'SOURCE_CHANGED'
              : 'LABEL_FETCH_FAILED'
        : 'LABEL_FETCH_FAILED';
    // Cleanup is a bounded principal-bound terminal transition, with no publication.
    await tenantTx(a.tenantId, async (c) => {
      await c.query('SELECT label_cache_fail($1,$2,$3,$4)', [
        start.id,
        a.userId,
        a.apiKeyId ?? null,
        code,
      ]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    if (code === 'ACCESS_REVOKED') throw error;
  }
  return result(a, start.id, false);
}
export async function shipmentLabelCacheDetail(a: PrintActor, id: string) {
  id = printUuid.parse(id);
  return tx(a, false, async (c) => {
    const h = (
      await c.query('SELECT acquisition_id FROM shipment_label_cache_assets WHERE id=$1', [id])
    ).rows[0];
    ensure(h, 404, 'Nie znaleziono cache etykiety');
    const r = await read(c, a, h.acquisition_id);
    const f = await flags(c, a, false);
    return { cache: r.cache, acquisition: acquisition(r.acquisition, f), ...f };
  });
}
export async function shipmentLabelCacheContent(a: PrintActor, id: string) {
  id = printUuid.parse(id);
  return tx(a, true, async (c) => {
    const h = (
      await c.query('SELECT label_cache_content($1,$2,$3) h', [id, a.userId, a.apiKeyId ?? null])
    ).rows[0].h;
    let b64: string;
    try {
      b64 = decrypt(h.content_encrypted).content_base64;
      const v = validatePrintContent(b64, 'pdf');
      ensure(
        v.content_sha256 === h.content_sha256 && v.content_bytes === h.content_bytes,
        502,
        'Niezgodna integralność cache etykiety',
      );
    } catch {
      throw new Problem(502, 'Nie można zweryfikować cache etykiety');
    }
    return {
      cache_id: id,
      format: 'pdf' as const,
      content_base64: b64,
      content_sha256: h.content_sha256 as string,
      content_bytes: h.content_bytes as number,
      ...(await flags(c, a, true)),
    };
  });
}
export async function shipmentLabelCacheHistory(a: PrintActor, shipmentId: string, input: unknown) {
  const sid = printUuid.parse(shipmentId),
    q = shipmentLabelCachePageInput.parse(input);
  return tx(a, false, async (c) => {
    ensure(
      (await c.query('SELECT id FROM shipments WHERE id=$1', [sid])).rowCount,
      404,
      'Nie znaleziono przesyłki',
    );
    if (q.cursor)
      ensure(
        (
          await c.query(
            'SELECT id FROM shipment_label_cache_acquisitions WHERE id=$1 AND shipment_id=$2',
            [q.cursor, sid],
          )
        ).rowCount,
        422,
        'Niepoprawny kursor cache etykiety',
      );
    const ids = (
      await c.query(
        `SELECT id FROM shipment_label_cache_acquisitions WHERE shipment_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM shipment_label_cache_acquisitions WHERE id=$2 AND shipment_id=$1)) ORDER BY created_at DESC,id DESC LIMIT $3`,
        [sid, q.cursor ?? null, q.limit + 1],
      )
    ).rows;
    const heads = [];
    for (const h of ids.slice(0, q.limit)) heads.push((await read(c, a, h.id)).acquisition);
    const f = await flags(c, a, false);
    return {
      data: heads.map((h) => acquisition(h, f)),
      next_cursor: ids.length > q.limit ? ids[q.limit - 1].id : null,
      ...f,
    };
  });
}
export async function reconcileShipmentLabelCache(
  a: PrintActor,
  id: string,
  input: ShipmentLabelCacheReconcileInput,
) {
  id = printUuid.parse(id);
  const b = shipmentLabelCacheReconcileInput.parse(input);
  return tx(a, true, async (c) => {
    const r = (
      await c.query('SELECT label_cache_reconcile($1,$2::jsonb,$3,$4) r', [
        id,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].r;
    if (!r.reused) await audit(c, a, 'print.label.cache.abandon', id, {});
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const h = await read(c, a, id);
    const f = await flags(c, a, true);
    return { cache: h.cache, acquisition: acquisition(h.acquisition, f), reused: r.reused, ...f };
  });
}
