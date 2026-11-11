/** RODO 228 for the purchase invoices of 243: a subject whose CRM invoice data carries a NIP may be a seller
 * (sole trader). The export lists their purchase invoices as data (no files); the anonymisation plan keeps them
 * with basis tax_retention until retain_until (ksef243_purchase_purge() removes them after it). */
import type { PoolClient } from 'pg';

export type PurchaseInvoiceOfSeller = { id: string; ksef_number: string; invoice_number: string; fa3_kind: string; issue_date: string; seller_nip: string; seller_name: string;
  buyer_nip: string; currency: string; gross_total: string; status: string; retain_until: string; legal_hold: boolean };
export async function purchaseInvoicesOfSellersInTx(c: PoolClient, nips: readonly string[]): Promise<PurchaseInvoiceOfSeller[]> {
  if (!nips.length || !(await c.query("SELECT to_regclass('public.ksef243_purchase_invoices') IS NOT NULL AS p")).rows[0]?.p) return [];
  return (await c.query(`SELECT id,ksef_number,invoice_number,fa3_kind,to_char(issue_date,'YYYY-MM-DD') issue_date,seller_nip,seller_name,buyer_nip,currency,gross_total::text,status,
    to_char(retain_until,'YYYY-MM-DD') retain_until,legal_hold FROM ksef243_purchase_invoices WHERE seller_nip=ANY($1::text[]) ORDER BY issue_date,id`, [nips])).rows;
}
