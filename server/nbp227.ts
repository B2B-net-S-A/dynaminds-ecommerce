/** Native 227 NBP rates: the tenant's table A rates (cached NBP reads and manual entries),
 * the rate chosen for a tax point, and the append-only rate record of an issued
 * foreign-currency document. Rules are pure (nbp227-model.ts); this module only reads and
 * writes the own 227 tables. The issue path never calls the network: it uses stored rates. */
import type { Pool, PoolClient } from 'pg';
import { audit, type AuditActor } from './domain';
import { ensure } from './errors';
import {
  NBP227_LOOKBACK_DAYS, addDays, chooseRate, coverRange, midText, midScaled, nbpRateLine, plDate, plnAmounts, taxPointOf,
  type NbpManualInput, type NbpPublication, type PlnBucket, type RateChoice, type StoredRate, type TaxPoint, type VatBucket,
} from './nbp227-model';

type Actor = AuditActor & { apiKeyId?: string };
export async function nbp227Available(c: Pool | PoolClient): Promise<boolean> {
  return Boolean((await c.query(`SELECT to_regclass('public.nbp227_rates') IS NOT NULL AND to_regclass('public.nbp227_document_rate_vat') IS NOT NULL
    AND to_regprocedure('public.nbp227_record_guard()') IS NOT NULL AS available`)).rows[0]?.available);
}
export async function requireNbp227(c: PoolClient): Promise<void> {
  ensure(await nbp227Available(c), 503, 'Kursy NBP (migracja 227) są niedostępne w tej kopii');
}
const day = (v: Date | string) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);
const RATE_COLUMNS = `currency,to_char(effective_date,'YYYY-MM-DD') effective_date,table_no,mid::text mid,to_char(covered_through,'YYYY-MM-DD') covered_through,source,fetched_at`;
export type RateView = StoredRate & { currency: string; fetched_at: string };
const rateRow = (r: any): RateView => ({ currency: r.currency, effective_date: day(r.effective_date), table_no: r.table_no, mid: r.mid,
  covered_through: day(r.covered_through), source: r.source, fetched_at: iso(r.fetched_at) });

export async function listRatesInTx(c: PoolClient, currency: string): Promise<RateView[]> {
  await requireNbp227(c);
  return (await c.query(`SELECT ${RATE_COLUMNS} FROM nbp227_rates WHERE currency=$1 ORDER BY effective_date DESC LIMIT 60`, [currency])).rows.map(rateRow);
}

/** Caches one NBP range read: publications are upserted as fetched (NBP wins over a manual
 * entry), manual entries on days NBP shows without a table are removed, and coverage of an
 * earlier row is cut before the first publication of the range. */
export async function storeFetchedRangeInTx(c: PoolClient, a: Actor, currency: string, start: string, end: string, pubs: readonly NbpPublication[], today: string): Promise<RateView[]> {
  await requireNbp227(c);
  const rows = coverRange(pubs, start, end, today);
  await c.query('SELECT 1 FROM nbp227_rates WHERE currency=$1 FOR UPDATE', [currency]);
  const removed = (await c.query(`DELETE FROM nbp227_rates WHERE currency=$1 AND source='manual' AND (effective_date BETWEEN $2 AND $3 AND NOT effective_date=ANY($4::date[]) OR table_no=ANY($5::text[]) AND NOT effective_date=ANY($4::date[]))
    RETURNING to_char(effective_date,'YYYY-MM-DD') d`, [currency, start, end, rows.map(r => r.effective_date), rows.map(r => r.table_no)])).rows.map(r => r.d);
  if (rows.length) await c.query(`UPDATE nbp227_rates SET covered_through=$3::date-1 WHERE currency=$1 AND effective_date<$2 AND covered_through>=$3`, [currency, start, rows[0]!.effective_date]);
  for (const r of rows)
    await c.query(`INSERT INTO nbp227_rates(tenant_id,currency,effective_date,table_no,mid,covered_through,source,actor_id,api_key_id) VALUES($1,$2,$3,$4,$5,$6,'fetched',$7,$8)
      ON CONFLICT(tenant_id,currency,effective_date) DO UPDATE SET table_no=EXCLUDED.table_no,mid=EXCLUDED.mid,source='fetched',fetched_at=clock_timestamp(),actor_id=EXCLUDED.actor_id,api_key_id=EXCLUDED.api_key_id,
      covered_through=CASE WHEN nbp227_rates.source='fetched' THEN greatest(nbp227_rates.covered_through,EXCLUDED.covered_through) ELSE EXCLUDED.covered_through END`,
    [a.tenantId, currency, r.effective_date, r.table_no, r.mid, r.covered_through, a.userId, a.apiKeyId ?? null]);
  await audit(c, a, 'nbp.rates_fetch', null, { currency, start, end, tables: rows.map(r => r.table_no), removed_manual: removed });
  return (await c.query(`SELECT ${RATE_COLUMNS} FROM nbp227_rates WHERE currency=$1 AND effective_date BETWEEN $2 AND $3 ORDER BY effective_date`, [currency, start, end])).rows.map(rateRow);
}

/** A manual rate: the user states the table, its mid rate and the last day before the next
 * publication. Refused when NBP data already says otherwise. */
export async function saveManualRateInTx(c: PoolClient, a: Actor, b: NbpManualInput, today: string): Promise<RateView> {
  await requireNbp227(c);
  ensure(b.effective_date <= today && b.covered_through <= today, 422, 'Kurs ręczny może dotyczyć tylko tabeli już opublikowanej');
  await c.query('SELECT 1 FROM nbp227_rates WHERE currency=$1 FOR UPDATE', [b.currency]);
  const same = (await c.query(`SELECT source FROM nbp227_rates WHERE currency=$1 AND effective_date=$2`, [b.currency, b.effective_date])).rows[0];
  ensure(!same || same.source === 'manual', 409, 'Na ten dzień jest już kurs pobrany z NBP; kursu z tabeli NBP nie zmienia się ręcznie');
  const later = (await c.query(`SELECT to_char(effective_date,'YYYY-MM-DD') d,table_no FROM nbp227_rates WHERE currency=$1 AND effective_date>$2 AND effective_date<=$3 ORDER BY effective_date LIMIT 1`,
    [b.currency, b.effective_date, b.covered_through])).rows[0];
  ensure(!later, 409, later ? `W okresie obowiązywania jest już tabela ${later.table_no} z dnia ${plDate(later.d)}; skróć okres „obowiązuje do”` : '');
  const proven = (await c.query(`SELECT table_no FROM nbp227_rates WHERE currency=$1 AND source='fetched' AND effective_date<$2 AND covered_through>=$2`, [b.currency, b.effective_date])).rows[0];
  ensure(!proven, 409, proven ? `Według odczytu NBP w tym dniu nie było tabeli (obowiązuje ${proven.table_no})` : '');
  const table = (await c.query('SELECT 1 FROM nbp227_rates WHERE currency=$1 AND table_no=$2 AND effective_date<>$3', [b.currency, b.table_no, b.effective_date])).rowCount;
  ensure(!table, 409, 'Ten numer tabeli jest już zapisany dla innego dnia');
  await c.query(`UPDATE nbp227_rates SET covered_through=$2::date-1 WHERE currency=$1 AND source='manual' AND effective_date<$2 AND covered_through>=$2`, [b.currency, b.effective_date]);
  await c.query(`INSERT INTO nbp227_rates(tenant_id,currency,effective_date,table_no,mid,covered_through,source,actor_id,api_key_id) VALUES($1,$2,$3,$4,$5,$6,'manual',$7,$8)
    ON CONFLICT(tenant_id,currency,effective_date) DO UPDATE SET table_no=EXCLUDED.table_no,mid=EXCLUDED.mid,covered_through=EXCLUDED.covered_through,fetched_at=clock_timestamp(),actor_id=EXCLUDED.actor_id,api_key_id=EXCLUDED.api_key_id`,
  [a.tenantId, b.currency, b.effective_date, b.table_no, midText(midScaled(b.mid)), b.covered_through, a.userId, a.apiKeyId ?? null]);
  await audit(c, a, 'nbp.rate_manual', null, { currency: b.currency, effective_date: b.effective_date, table_no: b.table_no, mid: b.mid, covered_through: b.covered_through });
  return rateRow((await c.query(`SELECT ${RATE_COLUMNS} FROM nbp227_rates WHERE currency=$1 AND effective_date=$2`, [b.currency, b.effective_date])).rows[0]);
}

/** Choice of the stored rate for a tax point (no network). */
export async function rateForTaxPointInTx(c: PoolClient, currency: string, taxPoint: string): Promise<RateChoice> {
  await requireNbp227(c);
  const r = (await c.query(`SELECT ${RATE_COLUMNS} FROM nbp227_rates WHERE currency=$1 AND effective_date<$2 ORDER BY effective_date DESC LIMIT 1`, [currency, taxPoint])).rows[0];
  return chooseRate(r ? rateRow(r) : null, taxPoint, currency);
}

/** The parts of a document (157 snapshot format) the rate record uses. */
export type NbpDocumentSource = { currency: string; sell_date: string; issue_date: string; vat_totals: readonly VatBucket[] };
export type IssueRate = { currency: string; tax_point: TaxPoint; rate: StoredRate };
/** Before numbering: PLN needs nothing; another currency needs a stored rate for its tax point, otherwise 409. */
export async function nbpRateForIssueInTx(c: PoolClient, s: NbpDocumentSource): Promise<IssueRate | null> {
  if (s.currency === 'PLN') return null;
  await requireNbp227(c);
  const point = taxPointOf(s), choice = await rateForTaxPointInTx(c, s.currency, point.date);
  ensure('rate' in choice, 409, 'refusal' in choice ? choice.refusal : '');
  return { currency: s.currency, tax_point: point, rate: (choice as { rate: StoredRate }).rate };
}

/** The check of an issue before numbering, from a 157 preview snapshot: the invoice is
 * dated with the 157 issue day (UTC), so a PLN preview costs no query. */
export async function nbpRateBeforeNumberingInTx(c: PoolClient, snapshot: Omit<NbpDocumentSource, 'issue_date'>): Promise<IssueRate | null> {
  if (snapshot.currency === 'PLN') return null;
  const issue = (await c.query("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d")).rows[0].d as string;
  return nbpRateForIssueInTx(c, { ...snapshot, issue_date: issue });
}
/** In the issuing transaction, after numbering: the rate record of a foreign-currency document. */
export async function captureDocumentNbpRateInTx(c: PoolClient, a: Actor, documentId: string, s: NbpDocumentSource, withIssue: boolean): Promise<void> {
  if (s.currency === 'PLN') return;
  await requireNbp227(c);
  if ((await c.query('SELECT 1 FROM nbp227_document_rates WHERE document_id=$1', [documentId])).rowCount) return;
  const chosen = (await nbpRateForIssueInTx(c, s))!, { rows, totals: t } = plnAmounts(s.vat_totals, chosen.rate.mid), r = chosen.rate;
  await c.query(`INSERT INTO nbp227_document_rates(tenant_id,document_id,currency,tax_point,tax_point_basis,rate_date,table_no,mid,rate_source,net_minor,vat_minor,gross_minor,net_pln_minor,vat_pln_minor,gross_pln_minor,captured_with_issue,actor_id,api_key_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
  [a.tenantId, documentId, s.currency, chosen.tax_point.date, chosen.tax_point.basis, r.effective_date, r.table_no, r.mid, r.source,
    t.net_minor, t.vat_minor, t.gross_minor, t.net_pln_minor, t.vat_pln_minor, t.gross_pln_minor, withIssue, a.userId, a.apiKeyId ?? null]);
  for (const v of rows)
    await c.query(`INSERT INTO nbp227_document_rate_vat(tenant_id,document_id,vat_rate,mid,net_minor,vat_minor,gross_minor,net_pln_minor,vat_pln_minor,gross_pln_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [a.tenantId, documentId, v.vat_rate, r.mid, v.net_minor, v.vat_minor, v.gross_minor, v.net_pln_minor, v.vat_pln_minor, v.gross_pln_minor]);
  await audit(c, a, 'document.nbp_rate', documentId, { currency: s.currency, tax_point: chosen.tax_point.date, rate_date: r.effective_date, table_no: r.table_no, mid: r.mid, vat_pln_minor: t.vat_pln_minor });
}

export type DocumentNbpRate = { currency: string; tax_point: string; tax_point_basis: 'sell_date' | 'issue_date'; rate_date: string; table_no: string; mid: string; rate_source: 'fetched' | 'manual';
  net_minor: string; vat_minor: string; gross_minor: string; net_pln_minor: string; vat_pln_minor: string; gross_pln_minor: string; captured_with_issue: boolean; captured_at: string;
  vat: PlnBucket[]; line: string };
/** Stored record of a document; null when there is none (PLN document or issued without it). */
export async function documentNbpRateInTx(c: PoolClient, documentId: string): Promise<DocumentNbpRate | null> {
  await requireNbp227(c);
  const h = (await c.query(`SELECT *,mid::text mid,to_char(tax_point,'YYYY-MM-DD') tax_point,to_char(rate_date,'YYYY-MM-DD') rate_date FROM nbp227_document_rates WHERE document_id=$1`, [documentId])).rows[0];
  if (!h) return null;
  const vat = (await c.query('SELECT * FROM nbp227_document_rate_vat WHERE document_id=$1 ORDER BY vat_rate', [documentId])).rows.map(v => ({ vat_rate: v.vat_rate,
    net_minor: String(v.net_minor), vat_minor: String(v.vat_minor), gross_minor: String(v.gross_minor), net_pln_minor: String(v.net_pln_minor), vat_pln_minor: String(v.vat_pln_minor), gross_pln_minor: String(v.gross_pln_minor) }));
  const sum = (k: 'vat_pln_minor' | 'net_pln_minor') => vat.reduce((n, v) => n + BigInt(v[k]), 0n).toString();
  ensure(vat.length > 0 && sum('vat_pln_minor') === String(h.vat_pln_minor) && sum('net_pln_minor') === String(h.net_pln_minor), 503, 'Zapis kursu NBP dokumentu jest niespójny');
  const out = { currency: h.currency, tax_point: h.tax_point, tax_point_basis: h.tax_point_basis, rate_date: h.rate_date, table_no: h.table_no, mid: h.mid, rate_source: h.rate_source,
    net_minor: String(h.net_minor), vat_minor: String(h.vat_minor), gross_minor: String(h.gross_minor), net_pln_minor: String(h.net_pln_minor), vat_pln_minor: String(h.vat_pln_minor),
    gross_pln_minor: String(h.gross_pln_minor), captured_with_issue: h.captured_with_issue, captured_at: iso(h.captured_at), vat };
  return { ...out, line: nbpRateLine(out) };
}
/** Window a fetch for a tax point reads: the days before it, up to the day before. */
export const lookbackWindow = (taxPoint: string): { start: string; end: string } => ({ start: addDays(taxPoint, -NBP227_LOOKBACK_DAYS), end: addDays(taxPoint, -1) });
