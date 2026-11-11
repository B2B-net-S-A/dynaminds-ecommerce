/** Trusted current-TX physical adapter. All quantities, destinations and costs
 * come from the private SQL148 admission, never from the public request.
 * It creates real bins/journals and one original-layer WMS return operation.
 * This module has no transaction, transport or retry of its own.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { wmsLotsEvidenceBudgetInTx } from './wms-lots';
import { wmsCostValue, wmsValueSummary } from './wms-lots-values';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import type { ReturnDestinationsActor } from './return-destinations-schema';
import type { ReturnDestinationPlan, ReturnDestinationAdmissionScope } from './return-destinations';

async function admittedScope(c: PoolClient, a: ReturnDestinationsActor, eid: string, rid: string): Promise<ReturnDestinationAdmissionScope> {
  const context = (await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(context.owner === 'postgres' && context.role === 'dyna_app' && context.tenant === a.tenantId,
    403, 'Adapter fizyczny wymaga własnej transakcji operatora');
  let failed = false;
  try {
    await c.query('RESET ROLE');
    const row = (await c.query('SELECT return_destination_admission_scope($1,$2,$3,$4) scope',
      [eid, rid, a.userId, a.apiKeyId ?? null])).rows[0];
    ensure(row?.scope && row.scope.plan.return_id === rid && row.scope.wms_operation_id === eid,
      409, 'Przyjęcie nie ma własnego aktywnego dopuszczenia');
    return row.scope as ReturnDestinationAdmissionScope;
  } catch (error) { failed = true; throw error; }
  finally { try { await c.query('SET LOCAL ROLE dyna_app'); } catch (error) { if (!failed) throw error; } }
}

export async function applyReturnDestinationPhysicalInTx(c: PoolClient, actor: ReturnDestinationsActor,
  admissionId: string, returnId: string): Promise<void> {
  const scope = await admittedScope(c, actor, admissionId, returnId), plan = scope.plan;
  ensure(plan.protocol === 'destinations_v1' && plan.arrivals.length <= 500 && plan.private_fragment_effects.length <= 500,
    413, 'Zakres fizycznego przyjęcia przekracza limit');
  const rma = (await c.query('SELECT number,order_id FROM return_cases WHERE tenant_id=$1 AND id=$2',
    [actor.tenantId, returnId])).rows[0];
  ensure(rma?.order_id === plan.order_id, 409, 'Przyjęcie zmieniło pierwotne zamówienie');

  // Check the complete union before the first stock birth or increment. Calling
  // the adapter twice cannot apply the frozen CAS a second time.
  for (const cell of plan.stock_effects) {
    const old = (await c.query(`SELECT version::text,on_hand,reserved FROM stock
      WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3) FOR UPDATE`,
      [actor.tenantId, cell.warehouse_id, cell.product_id])).rows[0];
    ensure(Boolean(old) === cell.before.exists && (old?.version ?? '0') === cell.before.version &&
      (old?.on_hand ?? 0) === cell.before.on_hand && (old?.reserved ?? 0) === cell.before.reserved,
    409, 'Cała unia docelowego zapasu zmieniła się przed przyjęciem');
  }
  for (const cell of plan.stock_effects) if (!cell.before.exists) {
    const first = plan.arrivals.find(a => a.warehouse_id === cell.warehouse_id && a.product_id === cell.product_id);
    ensure(first, 409, 'Brak rzeczywistej lokalizacji nowego zapasu');
    await c.query(`INSERT INTO stock(tenant_id,warehouse_id,product_id,location)
      VALUES($1,$2,$3,$4)`, [actor.tenantId, cell.warehouse_id, cell.product_id, first.location]);
  }
  const previousLocation = (await c.query("SELECT current_setting('app.stock_location',true) location")).rows[0].location ?? '';
  try {
    for (const arrival of plan.arrivals) {
      await c.query("SELECT set_config('app.stock_location',$1,true)", [arrival.location]);
      const changed = await c.query(`UPDATE stock SET on_hand=on_hand+$4
        WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3)`,
        [actor.tenantId, arrival.warehouse_id, arrival.product_id, arrival.quantity]);
      ensure(changed.rowCount === 1, 409, 'Nie znaleziono docelowego zapasu');
      await c.query(`INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,order_id,delta,kind,return_id,note)
        VALUES($1,$2,$3,$4,$5,$6,'return',$7,$8)`,
        [randomUUID(), actor.tenantId, arrival.product_id, arrival.warehouse_id, plan.order_id,
          arrival.quantity, returnId, rma.number]);
    }
  } finally {
    // A failed statement aborts the whole caller transaction; preserve its
    // original error rather than hiding it with a failed GUC restoration.
    await c.query("SELECT set_config('app.stock_location',$1,true)", [previousLocation]).catch(() => undefined);
  }
  for (const cell of plan.stock_effects) {
    const after = (await c.query(`SELECT on_hand,reserved FROM stock WHERE
      (tenant_id,warehouse_id,product_id)=($1,$2,$3)`,
      [actor.tenantId, cell.warehouse_id, cell.product_id])).rows[0];
    ensure(after?.on_hand === cell.after.on_hand && after.reserved === cell.after.reserved,
      409, 'Przyjęcie narusza zachowanie ilości lub rezerwacji');
  }
  if (!scope.wms_enabled) {
    ensure(plan.private_fragment_effects.length === 0, 409, 'Wyłączony WMS ma niedozwolone fragmenty');
    return;
  }
  if (plan.arrivals.length === 0) return;
  actor = enlistWmsActorInTx(c, actor, { orders: true });
  ensure(!((await c.query('SELECT id FROM wms_operations WHERE tenant_id=$1 AND return_id=$2 AND kind=\'return\'',
    [actor.tenantId, returnId])).rowCount), 409, 'Pierwotne przyjęcie ma już operację WMS');
  const fragments: Array<ReturnDestinationPlan['private_fragment_effects'][number] & { id: string }> = [];
  for (const fragment of plan.private_fragment_effects) {
    const value = wmsCostValue(fragment.quantity, fragment.unit_cost_minor);
    ensure(fragment.value_minor === (fragment.unit_cost_minor === null ? null : value.known_minor),
      409, 'Koszt fragmentu nie odpowiada pierwotnej warstwie');
    const changed = await c.query(`UPDATE wms_layer_positions SET quantity=quantity+$6,version=version+1
      WHERE(tenant_id,warehouse_id,product_id,location,layer_id)=($1,$2,$3,$4,$5)`,
      [actor.tenantId, fragment.warehouse_id, fragment.product_id, fragment.location, fragment.layer_id, fragment.quantity]);
    if (!changed.rowCount) await c.query(`INSERT INTO wms_layer_positions
      (tenant_id,warehouse_id,product_id,location,layer_id,quantity,reserved) VALUES($1,$2,$3,$4,$5,$6,0)`,
      [actor.tenantId, fragment.warehouse_id, fragment.product_id, fragment.location, fragment.layer_id, fragment.quantity]);
    await c.query(`INSERT INTO wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,
      location,layer_id,delta,value_delta,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'return')`,
      [randomUUID(), actor.tenantId, scope.wms_operation_id, fragment.warehouse_id, fragment.product_id,
        fragment.location, fragment.layer_id, fragment.quantity, fragment.value_minor]);
    const id = randomUUID();
    await c.query(`INSERT INTO wms_return_fragments(id,tenant_id,operation_id,order_id,return_id,
      issue_fragment_id,product_id,layer_id,warehouse_id,location,quantity,value_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, actor.tenantId, scope.wms_operation_id, plan.order_id, returnId, fragment.issue_fragment_id,
        fragment.product_id, fragment.layer_id, fragment.warehouse_id, fragment.location, fragment.quantity, fragment.value_minor]);
    fragments.push({ ...fragment, id });
  }
  const request = { protocol: 'destinations_v1', admission_id: admissionId, preview_id: scope.preview_id,
    return_id: returnId, order_id: plan.order_id, parts: plan.parts.map(part => part.part_id).sort() };
  const result = { fragments, legacy_unknown_layers: [], valuation: wmsValueSummary(fragments, plan.currency) };
  ensure(Buffer.byteLength(JSON.stringify({ request, result }), 'utf8') <= 4194304, 413, 'Dowód WMS przekracza limit');
  // Same canonical JSONB hash as the private139 SQL helper, using built-ins;
  // dyna_app deliberately has no EXECUTE on that private helper.
  const requestHash = (await c.query("SELECT encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex') hash",
    [JSON.stringify(request)])).rows[0].hash as string;
  await c.query(`INSERT INTO wms_operations(id,tenant_id,actor_id,client_key,request_hash,kind,source,
    policy_version,order_id,return_id,request,result) VALUES($1,$2,$3,$1,$4,'return',$5,$6,$7,$8,$9,$10)`,
    [scope.wms_operation_id, actor.tenantId, actor.userId,
      requestHash,
      actor.source ?? 'manual', scope.wms_policy_version, plan.order_id, returnId, JSON.stringify(request), JSON.stringify(result)]);
  await wmsLotsEvidenceBudgetInTx(c);
}
