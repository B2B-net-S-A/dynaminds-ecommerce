/** KSeF number of an issued document stored by 229, for FA(3) KOR (NrKSeFFaKorygowanej) and
 * JPK_V7 (NrKSeF / OFF). Without 229 or without a number: null. Read-only, own table only. */
import type { PoolClient } from 'pg';

export type DocumentKsef = { number: string | null; offline: boolean };
export async function documentKsefInTx(c: PoolClient, documentId: string): Promise<DocumentKsef> {
  if (!(await c.query("SELECT to_regclass('public.ksef229_submissions') IS NOT NULL AS present")).rows[0].present) return { number: null, offline: false };
  const r = (await c.query(`SELECT ksef_number,issue_mode FROM ksef229_submissions WHERE document_id=$1 AND state<>'rejected'`, [documentId])).rows[0];
  return { number: r?.ksef_number ?? null, offline: Boolean(r && r.issue_mode !== 'online' && !r.ksef_number) };
}
