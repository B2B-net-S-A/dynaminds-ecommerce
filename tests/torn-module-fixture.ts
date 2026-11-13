import assert from 'node:assert/strict';
import { pool } from '../server/db';
/** A module table hidden in the fully migrated schema is not an older copy:
 * the PIM integrity guards (pim_dictionary_valid) see a torn installation and
 * the application fails closed. A genuine older copy has no PIM module at all. */
export const PIM_INCOMPLETE = 'Niekompletny moduł PIM';
export const pimIncomplete = (e: any) => e?.status === 503 && e.message === PIM_INCOMPLETE;
export function assertPimIncomplete(r: { statusCode: number; body: string; json(): any }) {
  assert.equal(r.statusCode, 503, r.body);
  assert.equal(r.json().detail, PIM_INCOMPLETE);
}
/** Digest of every tenant-scoped table, read by the owner while the module is
 * torn. Session and API-key usage stamps are not business effects. */
export async function tenantDataDigest(): Promise<Record<string, string>> {
  const tables = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','auth237_api_key_state','outbound_subscriptions','sessions') ORDER BY 1`)
  ).rows.map((r) => r.table_name as string);
  const digest: Record<string, string> = {};
  for (const name of tables) {
    assert.match(name, /^[a-z][a-z0-9_]*$/);
    digest[name] = (
      await pool.query(
        `SELECT md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text),'')) d FROM "${name}" t`,
      )
    ).rows[0].d;
  }
  return digest;
}
