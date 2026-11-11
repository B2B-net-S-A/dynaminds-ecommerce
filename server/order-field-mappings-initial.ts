import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { tenantTx } from './db';
import { ensure } from './errors';
import {
  acquireOrderFieldsAdmissionInTx,
  prepareInitialOrderFieldsInTx,
  applyInitialOrderFieldsInTx,
} from './order-fields';
import { mappingHash as hash } from './order-field-mappings-source';
import {
  mappingPreviewInTx,
  mappingRowsInTx,
  mappingAclInTx,
  mappingAdmin,
  mappingExecutionHead,
  mappingSourceFenceInTx,
  mappingProvenance,
  mappingFinalGrantsInTx,
  mappingInstant,
  verifyMappingPreviewScopeInTx,
} from './order-field-mappings';
import {
  orderFieldMappingImportSchema,
  type MappedInitialConsent,
} from './order-field-mappings-schema';
import type { IntegrationContext } from './channel-access';
export type PreparedMappedInitial = {
  reused: boolean;
  order_id?: string;
  execution: any;
  preview: any;
  row: any;
  fields?: Awaited<ReturnType<typeof prepareInitialOrderFieldsInTx>>;
  changed?: number;
};
export async function prepareMappedInitialOrderFieldsInTx(
  c: PoolClient,
  a: Actor,
  inbound: any,
  warehouseId: string,
  consent: MappedInitialConsent,
): Promise<PreparedMappedInitial> {
  await acquireOrderFieldsAdmissionInTx(c, a);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `order-field-mapping-execution:${a.tenantId}`,
  ]);
  const p = await mappingPreviewInTx(c, consent.preview_id),
    input = orderFieldMappingImportSchema.parse({
      client_key: consent.client_key,
      consent: { scope_hash: consent.scope_hash, local_only: true },
    }),
    requestHash = hash({ preview_id: p.id, input, origin: consent.origin });
  const old = (
    await c.query(
      'SELECT * FROM order_field_mapping_executions WHERE actor_id=$1 AND client_key=$2',
      [a.userId, consent.client_key],
    )
  ).rows[0];
  if (old) {
    ensure(
      old.request_hash === requestHash && old.kind === 'initial' && old.preview_id === p.id,
      409,
      'Klucz importu wykorzystano dla innego zakresu',
    );
    const access = await mappingAclInTx(c, a, p, true);
    mappingAdmin(access.current_role);
    ensure(
      old.state === 'done' && old.result?.order_id === inbound.order_id,
      409,
      'Import nie ma zatwierdzonego receipt tego zamówienia',
    );
    return {
      reused: true,
      order_id: old.result.order_id,
      execution: mappingExecutionHead(old),
      preview: p,
      row: null,
    };
  }
  ensure(
    p.kind === 'initial' &&
      p.warehouse_id === warehouseId &&
      p.scope_hash === consent.scope_hash &&
      new Date(p.expires_at).getTime() > Date.now(),
    409,
    'Plan importu wygasł lub zgoda/warehouse nie odpowiada',
  );
  await verifyMappingPreviewScopeInTx(c, p);
  const rows = await mappingRowsInTx(c, p.id);
  ensure(
    rows.length === 1 &&
      rows[0].inbound_id === inbound.id &&
      rows[0].snapshot.inbound_id === inbound.id &&
      ['ready', 'no_op'].includes(rows[0].status),
    409,
    'Plan nie jest gotowy dla tego źródła',
  );
  ensure(
    !inbound.order_id,
    409,
    'Zwykły wcześniejszy import nie może dostać nowego profilu przez replay',
  );
  const row = rows[0].snapshot;
  ensure(inbound.source_hash === row.source_hash, 409, 'Źródło zmieniło się');
  const fields = await prepareInitialOrderFieldsInTx(c, a, row.changes, {
    manual: false,
    source: 'channel_import',
    fieldWritesAllowed: true,
  });
  const currentDefs = fields.definitions.filter((d) =>
    p.definitions_snapshot.some((f: any) => f.id === d.id),
  );
  ensure(
    hash(currentDefs) === hash(p.definitions_snapshot),
    409,
    'Definicje mapowania zmieniły się',
  );
  const e = (
    await c.query(
      'INSERT INTO order_field_mapping_executions(id,tenant_id,preview_id,kind,actor_id,client_key,request_hash,selection_hash,selected_count,consent,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10) RETURNING *',
      [
        randomUUID(),
        a.tenantId,
        p.id,
        'initial',
        a.userId,
        consent.client_key,
        requestHash,
        hash([rows[0].id]),
        JSON.stringify(input.consent),
        consent.origin,
      ],
    )
  ).rows[0];
  await c.query(
    'INSERT INTO order_field_mapping_execution_rows(tenant_id,execution_id,preview_id,row_id) VALUES($1,$2,$3,$4)',
    [a.tenantId, e.id, p.id, rows[0].id],
  );
  return { reused: false, execution: e, preview: p, row, fields };
}
export async function applyMappedInitialOrderFieldsInTx(
  c: PoolClient,
  a: Actor,
  orderId: string,
  prepared: PreparedMappedInitial,
) {
  ensure(!prepared.reused && prepared.fields, 409, 'Import nie jest przygotowany');
  const live = (
    await c.query(
      `SELECT *,${mappingInstant('updated_at')} source_epoch_text FROM inbound_orders WHERE id=$1`,
      [prepared.row.inbound_id],
    )
  ).rows[0];
  const current = await mappingSourceFenceInTx(c, a, prepared.preview, [prepared.row], [live]);
  const access = await mappingAclInTx(c, a, prepared.preview, true);
  mappingAdmin(access.current_role);
  await mappingFinalGrantsInTx(c, a, current, true);
  ensure(
    hash(access.definitions_snapshot) === hash(prepared.preview.definitions_snapshot),
    409,
    'Definicje mapowania zmieniły się',
  );
  prepared.changed = await applyInitialOrderFieldsInTx(
    c,
    a,
    orderId,
    prepared.fields,
    mappingProvenance(prepared.preview, prepared.execution, prepared.row),
  );
}
export async function completeMappedInitialImportInTx(
  c: PoolClient,
  a: Actor,
  prepared: PreparedMappedInitial,
  orderId: string,
) {
  const order = (await c.query('SELECT version::float8 version FROM orders WHERE id=$1', [orderId]))
    .rows[0];
  const result = {
    order_id: orderId,
    rows: [
      {
        row_id: prepared.row.row_id,
        order_id: orderId,
        changed: (prepared.changed ?? 0) > 0,
        order_version: order.version,
      },
    ],
    changed_orders: (prepared.changed ?? 0) > 0 ? 1 : 0,
    no_op_orders: (prepared.changed ?? 0) > 0 ? 0 : 1,
  };
  const e = (
    await c.query(
      "UPDATE order_field_mapping_executions SET state='done',result=$2,finished_at=now() WHERE id=$1 AND state='queued' RETURNING *",
      [prepared.execution.id, JSON.stringify(result)],
    )
  ).rows[0];
  ensure(e, 409, 'Receipt importu jest zakończony');
  return mappingExecutionHead(e);
}
export async function importMappedOrder(
  a: Actor,
  id: string,
  body: unknown,
  origin: 'manual' | 'api',
  context: IntegrationContext = {},
) {
  const input = orderFieldMappingImportSchema.parse(body);
  const p = await tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const p = await mappingPreviewInTx(c, id),
      rows = await mappingRowsInTx(c, id);
    ensure(p.kind === 'initial' && rows.length === 1, 409, 'Podgląd nie jest initial');
    return { ...p, row: rows[0].snapshot };
  });
  const options = {
    mappedInitial: {
      preview_id: id,
      scope_hash: input.consent.scope_hash,
      client_key: input.client_key,
      origin,
    },
  };
  // Ordinary adapter import is reused; no implicit profile selection or extra read
  // capability is introduced. Shopify preserves its existing fresh-read protocol.
  const receipt = await tenantTx(
    a.tenantId,
    async (c) =>
      (
        await c.query(
          'SELECT id FROM order_field_mapping_executions WHERE actor_id=$1 AND client_key=$2',
          [a.userId, input.client_key],
        )
      ).rows[0],
  );
  if (p.profile_snapshot.provider === 'shopify' && !receipt)
    return (await import('./shopify-order-read')).commitShopifyOrder(
      a,
      p.row.inbound_id,
      p.warehouse_id,
      p.row.source_hash,
      context,
      options,
    );
  return (await import('./imports')).importOrder(
    a,
    p.row.inbound_id,
    p.warehouse_id,
    p.row.source_hash,
    undefined,
    options,
  );
}
