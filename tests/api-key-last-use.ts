/** Since 237 (API-001) every authenticated API-key request stamps auth237_api_key_state.last_used_at, a 403
 * scope denial included: touchApiKey runs in the auth hook, before a route checks the key's scopes. The stamp
 * is the key's usage telemetry, not an effect of the request, so tenant snapshots leave it out and keep only
 * the key's rotation lineage (rotated_from_id/by/at), which no request other than a rotation may change. */
export function apiKeyLineage(rows: { row: Record<string, unknown> }[]): { row: Record<string, unknown> }[] {
  return rows
    .filter((entry) => entry.row.rotated_from_id !== null)
    .map(({ row: { last_used_at: _at, last_used_ip: _ip, ...row } }) => ({ row }));
}
export function withoutApiKeyLastUse<T extends Record<string, any>>(facts: T): T {
  const state = facts.auth237_api_key_state;
  return Array.isArray(state) ? { ...facts, auth237_api_key_state: apiKeyLineage(state) } : facts;
}
