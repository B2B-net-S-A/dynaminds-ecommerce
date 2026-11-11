import { externalImportReadAccessInTx } from './b2b-external-order-imports';
import type { ImportOrderOptions } from './imports';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tenantTx } from './db';
import { type Actor, audit } from './domain';
import { ensure } from './errors';
import { decrypt } from './security';
import { safeFetch } from './integrations';
import type { IntegrationContext } from './channel-access';
import { OdooSales, initialOdooWindow } from './odoo-orders';
import { stageOrders, importSourceHash, importConnectionHash, importOrder } from './imports';
export const odooOrdersHash = importConnectionHash;
export async function odooReadPolicy(c: PoolClient, actor: Actor, ch: any) {
  const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id])).rows[0];
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
    403,
    'Administrator utracił prawo importu Odoo',
  );
  ensure(
    current?.provider === 'odoo' && odooOrdersHash(current) === odooOrdersHash(ch),
    409,
    'Połączenie Odoo zmieniło się podczas odczytu',
  );
  return current;
}
const client = (ch: any, ctx: IntegrationContext) =>
  new OdooSales(ch.settings, decrypt(ch.credentials), ctx.transport ?? safeFetch);
export async function readOdooOrders(
  actor: Actor,
  ch: any,
  cursor: string | undefined,
  ctx: IntegrationContext,
) {
  return client(ch, ctx).orders(cursor, undefined, () =>
    tenantTx(actor.tenantId, async (c) => {
      await odooReadPolicy(c, actor, ch);
    }),
  );
}
export async function commitOdooOrder(
  actor: Actor,
  id: string,
  warehouse: string,
  expectedHash: string,
  ctx: IntegrationContext,
  options: ImportOrderOptions = {},
) {
  const initial = await tenantTx(actor.tenantId, async (c) => {
    if (options.externalImportConsent) await externalImportReadAccessInTx(c, actor);
    const inbound = (await c.query('SELECT * FROM inbound_orders WHERE id=$1', [id])).rows[0];
    ensure(inbound, 404, 'Nie znaleziono zamówienia');
    ensure(inbound.source_hash === expectedHash, 409, 'Podgląd Odoo zmienił się; odśwież kolejkę');
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [inbound.channel_id])).rows[0];
    ensure(ch?.provider === 'odoo', 422, 'Wymagane źródło Odoo');
    await odooReadPolicy(c, actor, ch);
    return { inbound, ch };
  });
  if (!initial.ch.settings.simulation) {
    const latest = await client(initial.ch, ctx).order(Number(initial.inbound.external_id), () =>
      tenantTx(actor.tenantId, async (c) => {
        if (options.externalImportConsent) await externalImportReadAccessInTx(c, actor);
        await odooReadPolicy(c, actor, initial.ch);
      }),
    );
    const changed = await tenantTx(actor.tenantId, async (c) => {
      if (options.externalImportConsent) await externalImportReadAccessInTx(c, actor);
      await odooReadPolicy(c, actor, initial.ch);
      const inbound = (
        await c.query('SELECT source_hash FROM inbound_orders WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      ensure(
        inbound?.source_hash === expectedHash,
        409,
        'Kolejka Odoo zmieniła się podczas kontroli',
      );
      if (importSourceHash(latest) === expectedHash) return false;
      await stageOrders(c, actor, initial.ch, [latest]);
      return true;
    });
    ensure(!changed, 409, 'ERP zmienił zamówienie; odśwież podgląd i ponownie zatwierdź import');
  }
  return importOrder(actor, id, warehouse, expectedHash, odooOrdersHash(initial.ch), options);
}
export function odooSyncPayload(ch: any) {
  return {
    odoo_window: initialOdooWindow(ch.bootstrap_done ? ch.event_cursor : null),
    odoo_policy: { connection_hash: odooOrdersHash(ch), require_enabled: ch.sync_enabled },
  };
}
export async function processOdooSync(job: any, actor: Actor, ch: any, ctx: IntegrationContext) {
  ensure(job.payload.odoo_window && job.payload.odoo_policy, 422, 'Brak checkpointu zamówień Odoo');
  const guard = async (c: PoolClient, renew = false) => {
    const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
        .rows[0],
      j = (
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rows[0];
    if (!j) return false;
    if (
      !current ||
      current.provider !== 'odoo' ||
      current.settings.simulation ||
      !(await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok ||
      odooOrdersHash(current) !== job.payload.odoo_policy.connection_hash ||
      (job.payload.odoo_policy.require_enabled && !current.sync_enabled)
    ) {
      await c.query(
        "UPDATE jobs SET state='done',error='Odczyt Odoo zatrzymano po zmianie roli, konfiguracji lub pauzie',lease_token=NULL,locked_at=NULL WHERE id=$1",
        [job.id],
      );
      return false;
    }
    if (renew) await c.query('UPDATE jobs SET locked_at=now() WHERE id=$1', [job.id]);
    return true;
  };
  const fence = async () =>
    ensure(
      await tenantTx(job.tenant_id, (c) => guard(c, true)),
      409,
      'Zatrzymano odczyt zamówień Odoo',
    );
  if (!(await tenantTx(job.tenant_id, (c) => guard(c, true)))) return;
  const result = await client(ch, ctx).orders(undefined, job.payload.odoo_window, fence);
  ensure(
    !result.has_more || job.payload.page < 100000,
    422,
    'Przekroczono milion zamówień okna Odoo; zawęź import historyczny',
  );
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await guard(c))) return;
    await stageOrders(c, actor, ch, result.data);
    await c.query(
      'UPDATE channels SET event_cursor=CASE WHEN $2 THEN event_cursor ELSE $3 END,bootstrap_done=bootstrap_done OR NOT $2,last_sync_at=CASE WHEN $2 THEN last_sync_at ELSE now() END WHERE id=$1',
      [ch.id, result.has_more, result.window.to],
    );
    await c.query(
      'UPDATE jobs SET state=$2,attempts=0,payload=$3,error=NULL,lease_token=NULL,locked_at=NULL,run_at=now() WHERE id=$1',
      [
        job.id,
        result.has_more ? 'pending' : 'done',
        JSON.stringify({ ...job.payload, odoo_window: result.window, page: job.payload.page + 1 }),
      ],
    );
    await c.query(
      "INSERT INTO integration_runs(id,tenant_id,channel_id,operation,status,detail) VALUES($1,$2,$3,'orders.sync',$4,$5)",
      [
        randomUUID(),
        job.tenant_id,
        ch.id,
        result.has_more ? 'page_done' : 'done',
        JSON.stringify({
          page: job.payload.page,
          count: result.data.length,
          window: result.window,
          scope: 'ERP_read_local_stage',
        }),
      ],
    );
    await audit(c, actor, 'odoo.orders.page', ch.id, {
      count: result.data.length,
      has_more: result.has_more,
    });
  });
}
