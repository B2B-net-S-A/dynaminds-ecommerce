import type { Pool, PoolClient } from 'pg';
import { pool, tenantTx, localConfig } from './db';
import { enlistOperationalDeliveryInTx } from './operational-delivery-consumers';
import { audit } from './domain';
import { encrypt, decrypt } from './security';
import { ensure, Problem } from './errors';
import { assertLabelsNotCancelledInTx } from './shipment-cancelled';
import {
  printJobsAvailable,
  type PrintJobFlags,
  type PrintJobHead,
  type PrintPrinter,
  type PrintStation,
} from './print-jobs';
import { printUuid, validatePrintContent, type PrintActor } from './print-job-values';
import { renderDemoShipmentLabel, type DemoShipmentLabelInput } from './demo-shipment-label-pdf';
import {
  SHIPMENT_LABEL_PRINT_LIMITS,
  shipmentLabelPrintPreviewInput,
  shipmentLabelPrintQueueInput,
  type ShipmentLabelPrintPreviewInput,
  type ShipmentLabelPrintQueueInput,
} from './shipment-label-print-values';
export { SHIPMENT_LABEL_PRINT_LIMITS } from './shipment-label-print-values';
export type ShipmentLabelPrintPreview = {
  id: string;
  shipment_id: string;
  order_id: string;
  source_kind: 'dpd_cached' | 'demo_generated' | 'inpost_cached';
  source_snapshot: {
    carrier: string;
    mode: string;
    tracking_number: string;
    shipping_plan_id: string | null;
    source_hash: string;
    cache_asset_id?: string;
  };
  order_snapshot: PrintJobHead['order_snapshot'];
  station_snapshot: PrintStation;
  printer_snapshot: PrintPrinter;
  copies: number;
  format: 'pdf';
  content_sha256: string;
  content_bytes: number;
  scope_hash: string;
  created_at: string;
  expires_at: string;
  queued_job_id: string | null;
  can_queue: boolean;
};
const tables = ['print_label_assets', 'print_label_previews', 'print_job_label_sources'];
const missing = 'Moduł kolejki etykiet jest niekompletny';
export async function shipmentLabelPrintAvailable(c: Pool | PoolClient): Promise<boolean> {
  if (!(await printJobsAvailable(c))) return false;
  const probe = (
    await c.query(
      `SELECT current_user db_role,EXISTS(SELECT 1 FROM unnest($1::text[]) n WHERE to_regclass(n) IS NOT NULL) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'label_print_%') artifacts`,
      [tables],
    )
  ).rows[0];
  if (!probe.artifacts) {
    ensure(probe.db_role !== 'dyna_app', 503, missing);
    ensure(
      !(
        await c.query(
          "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='130_shipment_label_prints') installed",
        )
      ).rows[0].installed,
      503,
      missing,
    );
    return false;
  }
  ensure((await c.query('SELECT label_print_guards() ok')).rows[0].ok, 503, missing);
  ensure((await c.query('SELECT label_print_installed() ok')).rows[0].ok, 503, missing);
  return true;
}
type Grant = { role: PrintActor['role']; allowed: boolean; key_valid: boolean };
async function access(c: PoolClient, a: PrintActor, write: boolean, pin: boolean) {
  const g = (
    await c.query('SELECT print_job_access($1,$2,$3,$4) g', [
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
async function cacheAccess(c: PoolClient, a: PrintActor, pin: boolean) {
  ensure(
    (
      await c.query(
        "SELECT to_regprocedure('label_cache_access(uuid,uuid,boolean,boolean)') IS NOT NULL ok",
      )
    ).rows[0].ok,
    503,
    'Moduł cache etykiet jest niekompletny',
  );
  ensure(
    (await c.query('SELECT label_cache_guards() ok,label_cache_installed() installed')).rows[0].ok,
    503,
    'Moduł cache etykiet jest niekompletny',
  );
  ensure(
    (await c.query('SELECT label_cache_installed() installed')).rows[0].installed,
    503,
    'Moduł cache etykiet jest niekompletny',
  );
  const g = (
    await c.query('SELECT label_cache_access($1,$2,true,$3) g', [a.userId, a.apiKeyId ?? null, pin])
  ).rows[0].g as Grant;
  ensure(g.key_valid, 401, 'Klucz drukowania jest nieaktualny');
  ensure(g.allowed, 403, 'Brak aktualnego uprawnienia do drukowania');
}
async function flags(c: PoolClient, a: PrintActor, write: boolean): Promise<PrintJobFlags> {
  const g = await access(c, a, write, true);
  const w = (
    await c.query('SELECT print_job_access($1,$2,true,false) g', [a.userId, a.apiKeyId ?? null])
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
// A read checks availability once, before its transaction (print-jobs.ts tx). Writes keep both.
async function tx<T>(
  a: PrintActor,
  write: boolean,
  fn: (c: PoolClient) => Promise<T>,
  availabilityChecked = false,
): Promise<T> {
  if (!availabilityChecked) ensure(await shipmentLabelPrintAvailable(pool), 503, missing);
  try {
    return await tenantTx(a.tenantId, async (c) => {
      if (write) await shipmentLabelPrintAvailable(c);
      await access(c, a, write, false);
      return fn(c);
    });
  } catch (e) {
    if (e instanceof Problem) throw e;
    const err = e as { code?: string; message?: string };
    if (err.code === '23514' && err.message === 'Klucz drukowania jest nieaktualny')
      throw new Problem(401, err.message);
    if (err.code === '23514' && err.message === 'Brak aktualnego uprawnienia do drukowania')
      throw new Problem(403, err.message);
    if (err.code === '55000') throw new Problem(503, missing);
    if (err.code === 'P0002') throw new Problem(404, err.message ?? 'Nie znaleziono etykiety');
    if (['23514', '23503', '23505'].includes(err.code ?? ''))
      throw new Problem(409, err.message ?? 'Zakres etykiety zmienił się');
    throw e;
  }
}
async function view(c: PoolClient, id: string) {
  const p = (
    await c.query(
      'SELECT id,actor_id,api_key_id,scope_hash,payload,request FROM print_label_previews WHERE id=$1',
      [id],
    )
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu etykiety');
  const l = (await c.query('SELECT job_id FROM print_job_label_sources WHERE preview_id=$1', [id]))
    .rows[0];
  const batch = (await c.query("SELECT to_regclass('shipment_label_batch_preview_rows') IS NOT NULL ok")).rows[0];
  if (batch.ok) p.batch_linked = !!(await c.query('SELECT 1 FROM shipment_label_batch_preview_rows WHERE child_preview_id=$1',[id])).rows[0];
  const { asset_id: _, ...payload } = p.payload;
  return {
    p,
    preview: {
      ...payload,
      scope_hash: p.scope_hash,
      queued_job_id: l?.job_id ?? null,
      can_queue: false,
    } as ShipmentLabelPrintPreview,
  };
}
function eligibility(
  preview: ShipmentLabelPrintPreview,
  p: Record<string, any>,
  a: PrintActor,
  f: PrintJobFlags,
) {
  return {
    ...preview,
    can_queue:
      f.can_write &&
      !p.batch_linked &&
      !preview.queued_job_id &&
      p.actor_id === a.userId &&
      p.api_key_id === (a.apiKeyId ?? null) &&
      Date.parse(preview.expires_at) > Date.now(),
  };
}
async function bytes(c: PoolClient, a: PrintActor, id: string) {
  const asset = (
    await c.query('SELECT label_print_asset($1,$2,$3) a', [id, a.userId, a.apiKeyId ?? null])
  ).rows[0].a;
  let b64: string;
  try {
    b64 = decrypt(asset.content_encrypted).content_base64;
    const checked = validatePrintContent(b64, 'pdf');
    ensure(
      checked.content_bytes === asset.content_bytes &&
        checked.content_sha256 === asset.content_sha256,
      502,
      'Niezgodna integralność zapisanej etykiety',
    );
  } catch (e) {
    if (e instanceof Problem) throw e;
    throw new Problem(502, 'Nie można zweryfikować zapisanej etykiety');
  }
  return {
    content_base64: b64,
    content_sha256: asset.content_sha256 as string,
    content_bytes: asset.content_bytes as number,
  };
}
export async function shipmentLabelPrintMetadata(a: PrintActor) {
  if (!(await shipmentLabelPrintAvailable(pool)))
    return {
      available: false,
      read_only: false,
      current_role: null,
      can_read: false,
      can_write: false,
      can_manage: false,
      limits: SHIPMENT_LABEL_PRINT_LIMITS,
      stations: [],
    };
  return tx(a, false, async (c) => {
    const stations = (
      await c.query(
        'SELECT id,code,label,enabled,version::text FROM packing_stations ORDER BY id LIMIT 101',
      )
    ).rows;
    ensure(stations.length <= 100, 409, 'Zbyt wiele stanowisk');
    return { stations, limits: SHIPMENT_LABEL_PRINT_LIMITS, ...(await flags(c, a, false)) };
  }, true);
}
export async function createShipmentLabelPrintPreview(a: PrintActor, shipmentId: string, input: ShipmentLabelPrintPreviewInput) {
  const sid=printUuid.parse(shipmentId), b=shipmentLabelPrintPreviewInput.parse(input);
  return tx(a,true,c=>createShipmentLabelPrintPreviewInTx(c,a,sid,b));
}
/** Same namespace as native129 print_job_lock, before any operational order lock.
 * Serialize key lookup too: a concurrent committed replay never gains admission. */
async function lockOperationalLabelInTx(c: PoolClient, a: PrintActor) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('print.jobs:'||$1::text,0))", [a.tenantId]);
}
async function enlistOperationalLabelInTx(c: PoolClient, a: PrintActor, orderId: string, clientKey: string) {
  return enlistOperationalDeliveryInTx(c, {
    actor: a, orderId, consumer: 'label', clientKey,
    encryptionKey: localConfig.encryptionKey, write: true,
  });
}
/** Internal only: preserves the native130 source/frame/budget/principal on the supplied TX. */
export async function createShipmentLabelPrintPreviewInTx(c: PoolClient,a: PrintActor,sid:string,b:ShipmentLabelPrintPreviewInput) {
    await assertLabelsNotCancelledInTx(c, [sid]);
    if (b.asset_id) await cacheAccess(c, a, false);
    await lockOperationalLabelInTx(c, a);
    let r = (
      await c.query('SELECT label_print_preview_replay($1,$2::jsonb,$3,$4) r', [
        sid,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].r;
    if (!r) {
      // Cached selected assets and provider bytes keep their original provenance.
      // The native frame still validates the current shipment/source after admission.
      if (!b.asset_id) {
        const shipment = (await c.query(
          'SELECT order_id,mode FROM shipments WHERE(tenant_id,id)=($1,$2)',
          [a.tenantId, sid],
        )).rows[0];
        if (shipment?.mode === 'demo')
          await enlistOperationalLabelInTx(c, a, shipment.order_id, b.client_key);
      }
      const frame = (
        await c.query(
          b.asset_id
            ? 'SELECT label_cache_selected_frame($1,$4::jsonb,$2,$3) f'
            : 'SELECT label_print_frame($1,$2,$3) f',
          b.asset_id
            ? [sid, a.userId, a.apiKeyId ?? null, JSON.stringify(b)]
            : [sid, a.userId, a.apiKeyId ?? null],
        )
      ).rows[0].f;
      let content: Buffer;
      if (frame.source_kind === 'demo_generated') {
        try {
          content = await renderDemoShipmentLabel(frame.renderer_input as DemoShipmentLabelInput);
        } catch {
          throw new Problem(422, 'Dane etykiety DEMO przekraczają obsługiwany układ lub znaki');
        }
      } else if (b.asset_id) {
        const raw = (
          await c.query('SELECT label_cache_content($1,$2,$3) r', [
            b.asset_id,
            a.userId,
            a.apiKeyId ?? null,
          ])
        ).rows[0].r;
        try {
          const value = decrypt(raw.content_encrypted).content_base64;
          const checked = validatePrintContent(value, 'pdf');
          ensure(
            checked.content_sha256 === raw.content_sha256 &&
              checked.content_bytes === raw.content_bytes,
            502,
            'Niezgodna integralność cache etykiety',
          );
          content = Buffer.from(value, 'base64');
        } catch {
          throw new Problem(502, 'Nie można zweryfikować cache etykiety');
        }
      } else content = Buffer.from(frame.content_base64, 'base64');
      const b64 = content.toString('base64');
      try {
        validatePrintContent(b64, 'pdf');
      } catch {
        throw new Problem(422, 'Etykieta nie spełnia limitu bezpiecznego PDF');
      }
      const v = {
        shipment_id: sid,
        request: b,
        source_frame: frame.source_frame,
        content_base64: b64,
        content_encrypted: encrypt({ content_base64: b64 }),
      };
      r = (
        await c.query('SELECT label_print_store_preview($1::jsonb,$2,$3) r', [
          JSON.stringify(v),
          a.userId,
          a.apiKeyId ?? null,
        ])
      ).rows[0].r;
      if (!r.reused)
        await audit(c, a, 'print.label.preview', r.preview_id, {
          shipment_id: sid,
          source_kind: frame.source_kind,
        });
    }
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const h = await view(c, r.preview_id);
    const f = await flags(c, a, true);
    if (b.asset_id) await cacheAccess(c, a, true);
    return { preview: eligibility(h.preview, h.p, a, f), reused: r.reused, ...f };

}
export async function shipmentLabelPrintDetail(a: PrintActor, id: string) {
  id = printUuid.parse(id);
  return tx(a, false, async (c) => {
    const h = await view(c, id);
    const f = await flags(c, a, false);
    if (h.p.request?.asset_id) {
      const g = (
        await c.query('SELECT label_cache_access($1,$2,true,false) g', [
          a.userId,
          a.apiKeyId ?? null,
        ])
      ).rows[0].g as Grant;
      f.can_write = f.can_write && g.key_valid && !!g.allowed;
    }
    return { preview: eligibility(h.preview, h.p, a, f), ...f };
  });
}
export async function shipmentLabelPrintContent(a: PrintActor, id: string) {
  id = printUuid.parse(id);
  return tx(a, true, async (c) => {
    const linked = await view(c, id);
    if (linked.p.request?.asset_id) await cacheAccess(c, a, false);
    const content = await bytes(c, a, id);
    const f = await flags(c, a, true);
    if (linked.p.request?.asset_id) await cacheAccess(c, a, true);
    return { preview_id: id, format: 'pdf' as const, ...content, ...f };
  });
}
export async function queueShipmentLabelPrint(a:PrintActor,id:string,input:ShipmentLabelPrintQueueInput) {
  id=printUuid.parse(id);const b=shipmentLabelPrintQueueInput.parse(input);
  return tx(a,true,async c=>{const result=await queueShipmentLabelPrintInTx(c,a,id,b);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');const linked=await view(c,id);const f=await flags(c,a,true);if(linked.p.request?.asset_id)await cacheAccess(c,a,true);return {...result,...f};});
}
/** No route accepts this automatic shape. SQL156 requires its real same-TX admitted parent. */
export async function queueShipmentLabelPrintInTx(c:PoolClient,a:PrintActor,id:string,b:ShipmentLabelPrintQueueInput|{client_key:string;scope_hash:string;packed_intent_id:string}) {
    // Linked children can only be queued by the admitted outer batch transaction,
    // including exact replays of the single-label endpoint.
    const batch = (await c.query("SELECT to_regprocedure('label_batch_child_allowed(uuid,uuid,uuid)') IS NOT NULL ok")).rows[0];
    if (batch.ok) await c.query('SELECT label_batch_child_allowed($1,$2,$3)', [id,a.userId,a.apiKeyId??null]);
    const linked = await view(c, id);
    if (linked.p.request?.asset_id) await cacheAccess(c, a, false);
    await lockOperationalLabelInTx(c, a);
    let r = (
      await c.query('SELECT label_print_queue_replay($1,$2::jsonb,$3,$4) r', [
        id,
        JSON.stringify(b),
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].r;
    if (!r) {
      if (!linked.p.request?.asset_id) {
        const nativeAsset = (await c.query(
          `SELECT asset.order_id,asset.source_kind
           FROM print_label_previews preview JOIN print_label_assets asset
             ON(asset.tenant_id,asset.id,asset.order_id)=(preview.tenant_id,preview.asset_id,preview.order_id)
           WHERE(preview.tenant_id,preview.id)=($1,$2)`,
          [a.tenantId, id],
        )).rows[0];
        if (nativeAsset?.source_kind === 'demo_generated')
          await enlistOperationalLabelInTx(c, a, nativeAsset.order_id, b.client_key);
      }
      const asset = await bytes(c, a, id);
      r = (
        await c.query('SELECT label_print_queue($1,$2::jsonb,$3,$4,$5) r', [
          id,
          JSON.stringify(b),
          asset.content_base64,
          a.userId,
          a.apiKeyId ?? null,
        ])
      ).rows[0].r;
      if (!r.reused)
        await audit(c, a, 'print.label.queue', r.job.id, {
          preview_id: id,
          event_id: r.event.id,
          content_sha256: r.job.content_sha256,
        });
    }
    // Outer native parent finishes before constraint flush; public wrapper flushes below.
    const f = await flags(c, a, true);
    if (linked.p.request?.asset_id) await cacheAccess(c, a, true);
    return {
      ...r,
      job: {
        ...r.job,
        can_claim: f.can_write && r.job.state === 'queued',
        can_reconcile:
          f.can_manage &&
          (r.job.state === 'queued' ||
            (r.job.state === 'claimed' && Date.parse(r.job.lease_expires_at ?? '') <= Date.now())),
      },
      ...f,
    };

}
