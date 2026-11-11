/** Each SQL statement materializes one guarded policy per selected warehouse,
 * rather than validating the full manifest for every product/component cell.
 * A missing whole module still has the legacy physical sale policy.
 */
export function warehousePolicyMapSQL(enabled: boolean, filter: { warehouseParam?: number; warehouseArrayParam?: number } = {}) {
  if (filter.warehouseParam !== undefined && filter.warehouseArrayParam !== undefined)
    throw Error('Choose one internal warehouse filter');
  for (const p of [filter.warehouseParam, filter.warehouseArrayParam])
    if (p !== undefined && (!Number.isSafeInteger(p) || p < 1 || p > 100)) throw Error('Invalid internal SQL parameter');
  const where = filter.warehouseParam !== undefined
    ? `WHERE ($${filter.warehouseParam}::uuid IS NULL OR w.id=$${filter.warehouseParam}::uuid)`
    : filter.warehouseArrayParam !== undefined ? `WHERE w.id=ANY($${filter.warehouseArrayParam}::uuid[])` : '';
  return `WITH warehouse_policy_map AS MATERIALIZED (SELECT w.tenant_id,w.id,w.name,w.code,
    ${enabled ? 'public.warehouse_inventory_policy(w.tenant_id,w.id)' : "jsonb_build_object('usage','sale','enabled',true,'version','0')"} AS policy
    FROM warehouses w ${where})`;
}
export function warehousePolicySellableQuantitySQL(policy: string, quantity: string) {
  for (const identifier of [policy, quantity])
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/.test(identifier)) throw Error('Invalid internal policy SQL identifier');
  return `(CASE WHEN (${policy}->>'usage')='sale' AND (${policy}->>'enabled')::boolean
    THEN coalesce(${quantity},0) ELSE 0 END)`;
}
