import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx, pool } from './db';
import { audit, type Actor } from './domain';
import { encrypt } from './security';
import { ensure, Problem } from './errors';
import {
  acquireOrderFieldsAdmissionInTx,
  orderFieldCurrentRole,
  listOrderFields,
  prepareOrderFieldBatchRowsInTx,
  applyPreparedOrderFieldBatchInTx,
  orderFieldBatchReadableDefinitionsInTx,
  type OrderFieldBatchInputRow,
} from './order-fields';
import { orderFieldChangeSchema } from './order-fields-schema';
import {
  orderFieldBatchPreviewSchema,
  orderFieldBatchQueueSchema,
  orderFieldBatchExportSchema,
  type OrderFieldBatchPreviewInput,
} from './order-field-batches-schema';
import {
  orderFieldBatchCsvBytes,
  parseOrderFieldBatchCsv,
  orderFieldCsvCellSchema,
  orderFieldCsvQuote,
  orderFieldSheetCell,
} from './order-field-batches-csv';
export const ORDER_FIELD_BATCH_JOB = 'order.fields.batch';
const hash = (v: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(v, (_, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value,
      ),
    )
    .digest('hex');
const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time`;
const cursor = (row: any) =>
  Buffer.from(JSON.stringify([row.cursor_time, row.id])).toString('base64url');
function page(value?: string) {
  if (!value) return null;
  try {
    return z
      .tuple([z.iso.datetime(), z.uuid()])
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new Problem(422, 'Nieprawidłowy kursor');
  }
}
function rowPage(value?: string) {
  if (!value) return null;
  try {
    return z
      .tuple([z.number().int().min(0).max(4999), z.uuid()])
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new Problem(422, 'Nieprawidłowy kursor wierszy');
  }
}
const writer = (role: string) =>
  ensure(['admin', 'operator'].includes(role), 403, 'Wymagany aktualny administrator lub operator');
const publicRow = (r: any) => {
  const { effective_changes, ...wire } = r.snapshot ?? r;
  return wire;
};
const previewHead = (p: any) => ({
  id: p.id,
  kind: p.kind,
  scope_hash: p.scope_hash,
  policy: p.policy,
  expires_at: p.expires_at,
  summary: p.summary,
  created_at: p.created_at,
  definitions_snapshot: p.definitions_snapshot,
  ...(p.kind === 'csv'
    ? { filename: p.filename, config: p.config, file_hash: p.file_hash, byte_count: p.byte_count }
    : {}),
});
const executionHead = (e: any) => ({
  id: e.id,
  preview_id: e.preview_id,
  state: e.state,
  selected_count: e.selected_count,
  source: e.source,
  created_at: e.created_at,
  finished_at: e.finished_at,
  result: e.result,
  error: e.error,
});
async function preview(c: PoolClient, id: string) {
  const p = (await c.query('SELECT * FROM order_field_batch_previews WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu');
  return p;
}
async function acl(c: PoolClient, a: Actor, p: any, write = false) {
  return orderFieldBatchReadableDefinitionsInTx(
    c,
    a,
    p.definitions_snapshot.map((d: any) => d.id),
    write,
  );
}
async function rows(c: PoolClient, id: string, selected?: string[], after?: string) {
  const cp = rowPage(after),
    args: any[] = [id];
  if (selected) args.push(selected);
  if (cp) args.push(...cp);
  return (
    await c.query(
      `SELECT * FROM order_field_batch_rows WHERE preview_id=$1${selected ? ' AND id=ANY($2::uuid[])' : ''}${cp ? ` AND (position,id)>($${selected ? 3 : 2}::int,$${selected ? 4 : 3}::uuid)` : ''} ORDER BY position,id ${selected ? '' : 'LIMIT 51'}`,
      args,
    )
  ).rows;
}
function pagedRows(data: any[]) {
  return {
    data: data.slice(0, 50).map(publicRow),
    meta: {
      cursor:
        data.length > 50
          ? Buffer.from(JSON.stringify([data[49].position, data[49].id])).toString('base64url')
          : null,
    },
  };
}
export async function orderFieldBatchMetadata(a: Actor) {
  const defs = await listOrderFields(a);
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const { definitions_snapshot, current_role } = await orderFieldBatchReadableDefinitionsInTx(
      c,
      a,
      defs.data.map((d: any) => d.id),
    );
    return {
      current_role,
      can_write: ['admin', 'operator'].includes(current_role),
      definitions: definitions_snapshot,
      channels: (await c.query('SELECT id,name FROM channels ORDER BY name,id')).rows,
      limits: {
        preview_rows: 5000,
        selected_rows: 100,
        fields: 20,
        file_bytes: 5242880,
        active_previews: 20,
        queued_executions: 20,
        stored_csv_bytes: 104857600,
      },
    };
  });
}
export async function orderFieldBatchPreviewDetail(a: Actor, id: string, after?: string) {
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const p = await preview(c, id),
      access = await acl(c, a, p);
    return {
      ...previewHead(p),
      ...pagedRows(await rows(c, id, undefined, after)),
      current_role: access.current_role,
      can_write: ['admin', 'operator'].includes(access.current_role),
    };
  });
}
export async function orderFieldBatchHistory(
  a: Actor,
  kind: 'previews' | 'executions',
  after?: string,
) {
  const cp = page(after);
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const table =
        kind === 'previews' ? 'order_field_batch_previews' : 'order_field_batch_executions',
      data = (
        await c.query<any>(
          `SELECT t.*,${instant('t.created_at')} FROM ${table} t ${cp ? 'WHERE (t.created_at,t.id)<($1::timestamptz,$2::uuid)' : ''} ORDER BY t.created_at DESC,t.id DESC LIMIT 21`,
          cp ? [...cp] : [],
        )
      ).rows;
    for (const d of data.slice(0, 20))
      await acl(c, a, kind === 'previews' ? d : await preview(c, d.preview_id));
    const role = await orderFieldCurrentRole(c, a);
    return {
      current_role: role,
      can_write: ['admin', 'operator'].includes(role),
      data: data.slice(0, 20).map((d) => (kind === 'previews' ? previewHead(d) : executionHead(d))),
      meta: { cursor: data.length > 20 ? cursor(data[19]) : null },
    };
  });
}
export async function createOrderFieldBatchPreview(
  a: Actor,
  body: OrderFieldBatchPreviewInput,
  source: 'manual' | 'api' = 'manual',
) {
  const input = orderFieldBatchPreviewSchema.parse(body),
    requestHash = hash({ input, source }),
    bytes = input.kind === 'csv' ? orderFieldBatchCsvBytes(input.content_base64) : null,
    parsed = bytes && input.kind === 'csv' ? parseOrderFieldBatchCsv(bytes, input.config) : null;
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `order-field-preview-admission:${a.tenantId}`,
    ]);
    const old = (
      await c.query(
        'SELECT * FROM order_field_batch_previews WHERE actor_id=$1 AND client_key=$2',
        [a.userId, input.client_key],
      )
    ).rows[0];
    if (old) {
      ensure(
        old.request_hash === requestHash,
        409,
        'Klucz podglądu wykorzystano dla innych danych',
      );
      const access = await acl(c, a, old, true);
      writer(access.current_role);
      return {
        ...previewHead(old),
        ...pagedRows(await rows(c, old.id)),
        current_role: access.current_role,
        can_write: true,
        reused: true,
      };
    }
    ensure(
      (
        await c.query(
          'SELECT count(*)::int n FROM order_field_batch_previews WHERE expires_at>now()',
        )
      ).rows[0].n < 20,
      429,
      'Limit 20 aktywnych podglądów',
    );
    if (bytes)
      ensure(
        BigInt(
          (
            await c.query(
              'SELECT coalesce(sum(byte_count),0)::bigint n FROM order_field_batch_previews',
            )
          ).rows[0].n,
        ) +
          BigInt(bytes.length) <=
          104857600n,
        429,
        'Limit 100 MiB zapisanych źródeł CSV',
      );
    let inputs: OrderFieldBatchInputRow[];
    if (input.kind === 'bulk')
      inputs = input.orders.map((o, i) => ({
        row_id: randomUUID(),
        position: i,
        ...o,
        changes: input.changes,
      }));
    else {
      const config = input.config,
        fieldIds = config.fields.map((f) => f.field_id);
      const ds = (
        await c.query('SELECT id,type FROM order_field_definitions WHERE id=ANY($1::uuid[])', [
          fieldIds,
        ])
      ).rows;
      ensure(ds.length === fieldIds.length, 403, 'Definicja pola jest niedostępna');
      const raw = parsed!.rows,
        identities = raw.map((r) => r[config.identity.column]);
      let matches: any[];
      if (config.identity.kind === 'order_id') {
        const valid = identities.filter((id) => z.uuid().safeParse(id).success);
        matches = (
          await c.query(
            'SELECT id,number,version::float8 version FROM orders WHERE id=ANY($1::uuid[])',
            [valid],
          )
        ).rows;
      } else {
        ensure(
          (await c.query('SELECT id FROM channels WHERE id=$1', [config.identity.channel_id]))
            .rowCount,
          404,
          'Kanał jest niedostępny',
        );
        matches = (
          await c.query(
            'SELECT id,external_id FROM orders WHERE channel_id=$1 AND external_id=ANY($2::text[])',
            [config.identity.channel_id, identities],
          )
        ).rows;
      }
      const byIdentity = new Map(
        matches.map((o) => [config.identity.kind === 'order_id' ? o.id : o.external_id, o]),
      );
      inputs = raw.map((r, i) => {
        const found = byIdentity.get(r[config.identity.column]),
          v = r[config.order_version_column],
          issues: { code: string; message: string }[] = [],
          changes: any[] = [];
        let version: number | null = null;
        if (/^[1-9][0-9]{0,15}$/.test(v) && Number.isSafeInteger(Number(v))) version = Number(v);
        else
          issues.push({
            code: 'version_invalid',
            message: 'Wersja wymaga dodatniego integer string',
          });
        for (const f of config.fields)
          try {
            const parsedCell = orderFieldCsvCellSchema.parse(JSON.parse(r[f.column])),
              type = ds.find((d) => d.id === f.field_id)!.type;
            changes.push(
              orderFieldChangeSchema.parse({
                field_id: f.field_id,
                definition_version: f.definition_version,
                ...(parsedCell.operation === 'clear'
                  ? { operation: 'clear' }
                  : { type, value: parsedCell.value }),
              }),
            );
          } catch {
            issues.push({ code: 'cell_invalid', message: 'Komórka wymaga strict JSON set/clear' });
          }
        return {
          row_id: randomUUID(),
          position: i,
          order_id: found?.id ?? null,
          order_version: version,
          changes,
          issues,
        };
      });
    }
    const prepared = await prepareOrderFieldBatchRowsInTx(c, a, inputs, {
      policy: input.policy,
      writeLocks: false,
    });
    writer(prepared.current_role);
    const fieldIds =
      input.kind === 'bulk'
        ? input.changes.map((ch) => ch.field_id)
        : input.config.fields.map((f) => f.field_id);
    const access = await orderFieldBatchReadableDefinitionsInTx(c, a, fieldIds, true);
    writer(access.current_role);
    const summary = {
        total: prepared.rows.length,
        ready: prepared.rows.filter((r) => r.status === 'ready').length,
        no_op: prepared.rows.filter((r) => r.status === 'no_op').length,
        invalid: prepared.rows.filter((r) => r.status === 'invalid').length,
        conflict: prepared.rows.filter((r) => r.status === 'conflict').length,
      },
      id = randomUUID(),
      scopeHash = hash({
        actor_id: a.userId,
        kind: input.kind,
        policy: input.policy,
        definitions: access.definitions_snapshot,
        rows: prepared.rows,
      });
    const p = (
      await c.query(
        "INSERT INTO order_field_batch_previews(id,tenant_id,actor_id,client_key,request_hash,scope_hash,kind,policy,source,definitions_snapshot,config,filename,encrypted_bytes,byte_count,file_hash,summary,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now()+interval '15 minutes') RETURNING *",
        [
          id,
          a.tenantId,
          a.userId,
          input.client_key,
          requestHash,
          scopeHash,
          input.kind,
          input.policy,
          input.kind === 'csv' ? 'csv_import' : source,
          JSON.stringify(access.definitions_snapshot),
          input.kind === 'csv' ? JSON.stringify(input.config) : null,
          input.kind === 'csv' ? input.filename : null,
          bytes ? encrypt({ content_base64: bytes.toString('base64') }) : null,
          bytes?.length ?? null,
          parsed?.file_hash ?? null,
          JSON.stringify(summary),
        ],
      )
    ).rows[0];
    await c.query(
      'INSERT INTO order_field_batch_rows(id,tenant_id,preview_id,position,order_id,order_version,status,snapshot) SELECT x.id,$1,$2,x.position,x.order_id,x.order_version,x.status,x.snapshot FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,position int,order_id uuid,order_version bigint,status text,snapshot jsonb)',
      [
        a.tenantId,
        id,
        JSON.stringify(
          prepared.rows.map((r) => ({
            id: r.row_id,
            position: r.position,
            order_id: r.order_id,
            order_version: r.order_version,
            status: r.status,
            snapshot: r,
          })),
        ),
      ],
    );
    await audit(c, a, 'order.fields_batch_preview', id, {
      scope_hash: scopeHash,
      kind: input.kind,
      summary,
    });
    return {
      ...previewHead(p),
      ...pagedRows(await rows(c, id)),
      current_role: access.current_role,
      can_write: true,
      reused: false,
    };
  });
}
async function verified(c: PoolClient, a: Actor, p: any, selected: any[]) {
  ensure(new Date(p.expires_at).getTime() > Date.now(), 409, 'Podgląd wygasł');
  const fresh = await prepareOrderFieldBatchRowsInTx(
    c,
    a,
    selected.map((r) => r.snapshot),
    { policy: p.policy, writeLocks: true },
  );
  const access = await acl(c, a, p, true);
  writer(access.current_role);
  ensure(
    fresh.rows.every((r) => ['ready', 'no_op'].includes(r.status)),
    409,
    'Zakres zmienił się lub nie jest gotowy',
  );
  for (let i = 0; i < selected.length; i++)
    ensure(hash(fresh.rows[i]) === hash(selected[i].snapshot), 409, 'Zamrożony zakres zmienił się');
  return fresh;
}
export async function queueOrderFieldBatch(
  a: Actor,
  id: string,
  body: z.infer<typeof orderFieldBatchQueueSchema>,
  source: 'manual' | 'api' = 'manual',
) {
  const input = orderFieldBatchQueueSchema.parse(body),
    requestHash = hash({ preview_id: id, input, source });
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `order-field-execution-admission:${a.tenantId}`,
    ]);
    const p = await preview(c, id);
    const old = (
      await c.query(
        'SELECT * FROM order_field_batch_executions WHERE actor_id=$1 AND client_key=$2',
        [a.userId, input.client_key],
      )
    ).rows[0];
    if (old) {
      ensure(
        old.request_hash === requestHash,
        409,
        'Klucz wykonania wykorzystano dla innych danych',
      );
      const access = await acl(c, a, p, true);
      writer(access.current_role);
      return { execution: executionHead(old), reused: true };
    }
    ensure(
      new Set(input.selected_rows).size === input.selected_rows.length &&
        input.consent.selected_count === input.selected_rows.length &&
        input.consent.scope_hash === p.scope_hash &&
        input.consent.policy === p.policy,
      422,
      'Zgoda lub wybór nie odpowiada podglądowi',
    );
    const selected = await rows(c, id, input.selected_rows);
    ensure(selected.length === input.selected_rows.length, 422, 'Wiersz nie należy do podglądu');
    ensure(
      selected.every((r) => ['ready', 'no_op'].includes(r.status)),
      409,
      'Wybrany wiersz nie jest gotowy',
    );
    await verified(c, a, p, selected);
    ensure(
      (
        await c.query(
          "SELECT count(*)::int n FROM order_field_batch_executions WHERE state='queued'",
        )
      ).rows[0].n < 20,
      429,
      'Limit 20 oczekujących wykonań',
    );
    const executionId = randomUUID(),
      jobId = randomUUID();
    await c.query(
      'INSERT INTO jobs(id,tenant_id,kind,payload,max_attempts,dedup_key) VALUES($1,$2,$3,$4,1,$5)',
      [
        jobId,
        a.tenantId,
        ORDER_FIELD_BATCH_JOB,
        JSON.stringify({ execution_id: executionId }),
        'order.fields.batch:' + executionId,
      ],
    );
    const e = (
      await c.query(
        'INSERT INTO order_field_batch_executions(id,tenant_id,preview_id,actor_id,client_key,request_hash,selection_hash,consent,source,selected_count,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [
          executionId,
          a.tenantId,
          id,
          a.userId,
          input.client_key,
          requestHash,
          hash(selected.map((r) => r.id)),
          JSON.stringify(input.consent),
          p.kind === 'csv' ? 'csv_import' : source,
          selected.length,
          jobId,
        ],
      )
    ).rows[0];
    await c.query(
      'INSERT INTO order_field_batch_execution_rows(tenant_id,execution_id,preview_id,row_id) SELECT $1,$2,$3,unnest($4::uuid[])',
      [a.tenantId, executionId, id, selected.map((r) => r.id)],
    );
    await audit(c, a, 'order.fields_batch_queued', executionId, {
      preview_id: id,
      scope_hash: p.scope_hash,
      selection_hash: e.selection_hash,
      selected_count: selected.length,
    });
    return { execution: executionHead(e), reused: false };
  });
}
async function execution(c: PoolClient, id: string) {
  const e = (await c.query('SELECT * FROM order_field_batch_executions WHERE id=$1', [id])).rows[0];
  ensure(e, 404, 'Nie znaleziono wykonania');
  return e;
}
async function selectedRows(c: PoolClient, e: any) {
  return (
    await c.query(
      'SELECT r.* FROM order_field_batch_execution_rows s JOIN order_field_batch_rows r ON (r.tenant_id,r.preview_id,r.id)=(s.tenant_id,s.preview_id,s.row_id) WHERE s.execution_id=$1 ORDER BY r.position,r.id',
      [e.id],
    )
  ).rows;
}
export async function orderFieldBatchExecutionDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const e = await execution(c, id),
      p = await preview(c, e.preview_id),
      access = await acl(c, a, p);
    return {
      ...executionHead(e),
      consent: e.consent,
      current_role: access.current_role,
      can_write: ['admin', 'operator'].includes(access.current_role),
      data: (await selectedRows(c, e)).map((r) => ({
        ...publicRow(r),
        result: e.result?.rows?.find((x: any) => x.row_id === r.id) ?? null,
      })),
    };
  });
}
export async function processOrderFieldBatchJob(job: any) {
  z.uuid().parse(job.id);
  z.uuid().parse(job.tenant_id);
  z.uuid().parse(job.lease_token);
  z.strictObject({ execution_id: z.uuid() }).parse(job.payload);
  return tenantTx(job.tenant_id, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, { tenantId: job.tenant_id, userId: null });
    const live = (
      await c.query(
        "SELECT * FROM jobs WHERE id=$1 AND kind=$2 AND state='running' AND lease_token=$3 FOR UPDATE",
        [job.id, ORDER_FIELD_BATCH_JOB, job.lease_token],
      )
    ).rows[0];
    if (!live) return;
    const e = (
      await c.query('SELECT * FROM order_field_batch_executions WHERE job_id=$1 FOR UPDATE', [
        live.id,
      ])
    ).rows[0];
    ensure(
      e && live.payload.execution_id === e.id && hash(live.payload) === hash(job.payload),
      409,
      'Zadanie nie odpowiada wykonaniu',
    );
    if (e.state !== 'queued') {
      await c.query("UPDATE jobs SET state='done',locked_at=NULL,lease_token=NULL WHERE id=$1", [
        live.id,
      ]);
      return;
    }
    const a: Actor = { tenantId: job.tenant_id, userId: e.actor_id, role: 'operator' };
    await c.query('SAVEPOINT field_effects');
    try {
      const p = await preview(c, e.preview_id),
        selected = await selectedRows(c, e),
        checked = ensure(
          selected.length === e.selected_count &&
            selected.length === e.consent.selected_count &&
            hash(selected.map((r) => r.id)) === e.selection_hash &&
            e.consent.scope_hash === p.scope_hash &&
            e.consent.policy === p.policy &&
            e.consent.local_only === true,
          409,
          'Zgoda nie odpowiada dokładnemu wyborowi',
        ),
        prepared = await verified(c, a, p, selected),
        result = await applyPreparedOrderFieldBatchInTx(c, a, prepared, {
          requestHash: e.request_hash,
          source: e.source,
        });
      await c.query(
        "UPDATE order_field_batch_executions SET state='done',result=$2,finished_at=now() WHERE id=$1",
        [e.id, JSON.stringify(result)],
      );
      await c.query(
        "UPDATE jobs SET state='done',locked_at=NULL,lease_token=NULL,error=NULL WHERE id=$1",
        [live.id],
      );
      await c.query('RELEASE SAVEPOINT field_effects');
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT field_effects');
      const state = error instanceof Problem ? 'conflict' : 'failed',
        message =
          error instanceof Problem
            ? 'Zakres, wersja lub uprawnienia zmieniły się'
            : 'Lokalne wykonanie nie zostało zatwierdzone';
      await c.query(
        'UPDATE order_field_batch_executions SET state=$2,error=$3,finished_at=now() WHERE id=$1',
        [e.id, state, message],
      );
      await c.query(
        "UPDATE jobs SET state='failed',locked_at=NULL,lease_token=NULL,error=$2 WHERE id=$1",
        [live.id, message],
      );
    }
  });
}
export async function cancelOrderFieldBatch(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const initial = await execution(c, id);
    await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [initial.job_id]);
    const e = (
        await c.query('SELECT * FROM order_field_batch_executions WHERE id=$1 FOR UPDATE', [id])
      ).rows[0],
      p = await preview(c, e.preview_id),
      access = await acl(c, a, p, true);
    writer(access.current_role);
    if (e.state === 'cancelled') return executionHead(e);
    ensure(e.state === 'queued', 409, 'Wykonanie jest już zakończone');
    await c.query(
      "UPDATE order_field_batch_executions SET state='cancelled',finished_at=now() WHERE id=$1",
      [id],
    );
    await c.query(
      "UPDATE jobs SET state='done',locked_at=NULL,lease_token=NULL,error='Anulowano przed zapisem' WHERE id=$1",
      [e.job_id],
    );
    await audit(c, a, 'order.fields_batch_cancelled', id, { preview_id: p.id });
    return executionHead(await execution(c, id));
  });
}
export async function reapOrderFieldBatchJobs() {
  const candidates = (
    await pool.query(
      "SELECT e.id,e.tenant_id,e.job_id FROM order_field_batch_executions e JOIN jobs j ON (j.tenant_id,j.id)=(e.tenant_id,e.job_id) WHERE e.state='queued' AND j.kind=$1 AND j.state IN ('failed','done') ORDER BY e.id LIMIT 25",
      [ORDER_FIELD_BATCH_JOB],
    )
  ).rows;
  let count = 0;
  for (const t of candidates)
    await tenantTx(t.tenant_id, async (c) => {
      await acquireOrderFieldsAdmissionInTx(c, { tenantId: t.tenant_id, userId: null });
      const jobs = (
        await c.query(
          "SELECT id,state FROM jobs WHERE id=$1 AND kind=$2 AND state IN ('failed','done') FOR UPDATE",
          [t.job_id, ORDER_FIELD_BATCH_JOB],
        )
      ).rows;
      for (const job of jobs)
        count +=
          (
            await c.query(
              "UPDATE order_field_batch_executions SET state='failed',error='Zadanie wygasło przed zatwierdzeniem',finished_at=now() WHERE job_id=$1 AND state='queued'",
              [job.id],
            )
          ).rowCount ?? 0;
    });
  return count;
}
export async function exportOrderFieldBatch(
  a: Actor,
  query: z.infer<typeof orderFieldBatchExportSchema>,
) {
  const q = orderFieldBatchExportSchema.parse(query);
  let fieldIds: string[], orderIds: string[] | undefined;
  try {
    fieldIds = z.array(z.uuid()).min(1).max(20).parse(JSON.parse(q.field_ids));
    orderIds = q.order_ids
      ? z.array(z.uuid()).min(1).max(100).parse(JSON.parse(q.order_ids))
      : undefined;
  } catch {
    throw new Problem(422, 'Eksport wymaga jawnych UUID pól/zamówień');
  }
  ensure(
    new Set(fieldIds).size === fieldIds.length &&
      (!orderIds || new Set(orderIds).size === orderIds.length),
    422,
    'Powtórzony zakres eksportu',
  );
  const cp = page(q.cursor);
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const args: any[] = [orderIds ?? null, q.limit + 1];
    if (cp) args.push(...cp);
    const orders = (
      await c.query(
        `SELECT id,number,version::float8 version,created_at,${instant('created_at')} FROM orders WHERE ($1::uuid[] IS NULL OR id=ANY($1::uuid[])) ${cp ? 'AND (created_at,id)<($3::timestamptz,$4::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT $2`,
        args,
      )
    ).rows;
    const data = orders.slice(0, q.limit),
      ids = data.map((o) => o.id);
    const locked = ids.length
      ? (
          await c.query(
            'SELECT id,number,version::float8 version FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
            [ids],
          )
        ).rows
      : [];
    const { definitions_snapshot: defs, current_role } =
      await orderFieldBatchReadableDefinitionsInTx(c, a, fieldIds);
    const maximum = 5242880;
    // Estimate in SQL before transferring payloads. All candidate orders are already
    // locked, so both the estimate and the selected prefix use the same values.
    const estimates = ids.length
      ? (
          await c.query(
            'SELECT order_id,coalesce(sum(octet_length(payload::text)),0)::bigint byte_estimate FROM order_field_values WHERE order_id=ANY($1::uuid[]) AND field_id=ANY($2::uuid[]) GROUP BY order_id',
            [ids, fieldIds],
          )
        ).rows
      : [];
    const byEstimate = new Map(estimates.map((v) => [v.order_id, Number(v.byte_estimate)]));
    const payloadOrders: typeof data = [];
    let estimatedSize = Buffer.byteLength(JSON.stringify(defs)) + 1024;
    for (const o of data) {
      // The factor covers CSV quote escaping; the fixed allowance covers identity,
      // operation envelopes and up to twenty field IDs. Actual rendering below
      // still enforces the exact byte cap and rejects an oversized first row.
      const rowEstimate = 4096 + 2 * (byEstimate.get(o.id) ?? 0);
      if (payloadOrders.length && estimatedSize + rowEstimate > maximum) break;
      estimatedSize += rowEstimate;
      payloadOrders.push(o);
    }
    const payloadIds = payloadOrders.map((o) => o.id),
      values = payloadIds.length
        ? (
            await c.query(
              'SELECT order_id,field_id,payload FROM order_field_values WHERE order_id=ANY($1::uuid[]) AND field_id=ANY($2::uuid[])',
              [payloadIds, fieldIds],
            )
          ).rows
        : [];
    const byValue = new Map(values.map((v) => [`${v.order_id}:${v.field_id}`, v.payload])),
      byOrder = new Map(locked.map((o) => [o.id, o])),
      byField = new Map(defs.map((d) => [d.id, d]));
    let content: string, mime: string;
    const exported: typeof data = [];
    if (q.mode === 'json') {
      const prefix =
          JSON.stringify({ definitions: fieldIds.map((id) => byField.get(id)) }).slice(0, -1) +
          ',"data":[',
        suffix = ']}',
        encoded: string[] = [];
      let size = Buffer.byteLength(prefix + suffix);
      ensure(size <= maximum, 422, 'Definicje eksportu przekraczają 5 MiB');
      for (const o of payloadOrders) {
        const record = JSON.stringify({
            order_id: o.id,
            order_number: byOrder.get(o.id)!.number,
            order_version: byOrder.get(o.id)!.version,
            fields: fieldIds.map((id) => ({
              field_id: id,
              value: byValue.get(`${o.id}:${id}`) ?? null,
            })),
          }),
          recordSize = Buffer.byteLength(record) + (encoded.length ? 1 : 0);
        if (size + recordSize > maximum) {
          ensure(encoded.length > 0, 422, 'Pojedynczy rekord eksportu przekracza 5 MiB');
          break;
        }
        size += recordSize;
        encoded.push(record);
        exported.push(o);
      }
      content = prefix + encoded.join(',') + suffix;
      mime = 'application/json';
    } else {
      const header = [
          'order_id',
          'order_version',
          ...fieldIds.map((id) => 'field.' + byField.get(id)!.key),
        ],
        lines = [header.map(orderFieldCsvQuote).join(',')];
      let size = Buffer.byteLength(lines[0] + '\r\n');
      ensure(size <= maximum, 422, 'Nagłówek eksportu przekracza 5 MiB');
      for (const o of payloadOrders) {
        const cells = [
          o.id,
          String(byOrder.get(o.id)!.version),
          ...fieldIds.map((id) => {
            const value = byValue.get(`${o.id}:${id}`);
            return q.mode === 'csv_exact'
              ? JSON.stringify(
                  value ? { operation: 'set', value: value.value } : { operation: 'clear' },
                )
              : value
                ? typeof value.value === 'string'
                  ? value.value
                  : JSON.stringify(value.value)
                : '';
          }),
        ];
        const line = cells
            .map((s) => orderFieldCsvQuote(q.mode === 'csv_sheet' ? orderFieldSheetCell(s) : s))
            .join(','),
          lineSize = Buffer.byteLength(line + '\r\n');
        if (size + lineSize > maximum) {
          ensure(exported.length > 0, 422, 'Pojedynczy rekord eksportu przekracza 5 MiB');
          break;
        }
        size += lineSize;
        lines.push(line);
        exported.push(o);
      }
      content = lines.join('\r\n') + '\r\n';
      mime = 'text/csv; charset=utf-8';
    }
    const bytes = Buffer.from(content),
      config =
        q.mode === 'csv_exact'
          ? {
              encoding: 'utf-8',
              delimiter: ',',
              header: true,
              identity: { kind: 'order_id', column: 0 },
              order_version_column: 1,
              fields: fieldIds.map((id, i) => ({
                column: i + 2,
                field_id: id,
                definition_version: byField.get(id)!.version,
              })),
            }
          : undefined;
    return {
      current_role,
      filename: 'order-fields.' + (q.mode === 'json' ? 'json' : 'csv'),
      mime_type: mime,
      content_base64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      count: exported.length,
      meta: {
        cursor: orders.length > exported.length ? cursor(exported[exported.length - 1]) : null,
      },
      ...(config ? { config } : {}),
    };
  });
}
