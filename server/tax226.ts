/** Native 226 tax facts: product tax profiles, tenant OSS settings and the
 * append-only per-line tax snapshot of an issued local invoice. Rules are pure
 * (tax226-model.ts); this module only reads and writes the own 226 tables. */
import type { Pool, PoolClient } from 'pg';
import { audit, type AuditActor } from './domain';
import { ensure } from './errors';
import { productDeletedInTx } from './product-deletions';
import {
  DEFAULT_TAX_PROFILE, OSS_COUNTRIES, OSS_RATE_CLASSES, deriveLineTax, mppRequirement,
  type OssSettingsInput, type OssState, type TaxBuyer, type TaxLineFacts, type TaxProfile, type TaxProfileInput,
} from './tax226-model';

export async function tax226Available(c: Pool | PoolClient): Promise<boolean> {
  return Boolean((await c.query(`SELECT to_regclass('public.tax226_product_profiles') IS NOT NULL
    AND to_regclass('public.tax226_oss_rates') IS NOT NULL AND to_regclass('public.tax226_document_lines') IS NOT NULL
    AND to_regprocedure('public.tax226_snapshot_guard()') IS NOT NULL AS available`)).rows[0]?.available);
}
export async function requireTax226(c: PoolClient): Promise<void> {
  ensure(await tax226Available(c), 503, 'Model podatkowy (migracja 226) jest niedostępny w tej kopii');
}
const iso = (v: Date | string | null) => (v instanceof Date ? v.toISOString() : v);
const profileRow = (r: any): TaxProfile => ({ version: r.version, category: r.category, exemption_basis_kind: r.exemption_basis_kind,
  exemption_basis: r.exemption_basis, np_kind: r.np_kind, gtu: r.gtu, annex15: r.annex15, oss_rate_class: r.oss_rate_class });
export type ProductTaxProfileView = { product_id: string; sku: string; product_vat: number; profile: TaxProfile; updated_at: string | null };

export async function productTaxProfileInTx(c: PoolClient, productId: string): Promise<ProductTaxProfileView> {
  await requireTax226(c);
  const p = (await c.query('SELECT id,sku,vat FROM products WHERE id=$1', [productId])).rows[0];
  ensure(p && !(await productDeletedInTx(c, productId)), 404, 'Nie znaleziono produktu');
  const r = (await c.query('SELECT * FROM tax226_product_profiles WHERE product_id=$1', [productId])).rows[0];
  return { product_id: p.id, sku: p.sku, product_vat: p.vat, profile: r ? profileRow(r) : DEFAULT_TAX_PROFILE, updated_at: r ? iso(r.updated_at) : null };
}
/** Optimistic write of the product's profile: version null creates it, otherwise the current version is required. */
export async function saveProductTaxProfileInTx(c: PoolClient, a: AuditActor & { apiKeyId?: string }, productId: string, b: TaxProfileInput): Promise<ProductTaxProfileView> {
  await requireTax226(c);
  const p = (await c.query('SELECT id FROM products WHERE id=$1 FOR SHARE', [productId])).rows[0];
  ensure(p && !(await productDeletedInTx(c, productId)), 404, 'Nie znaleziono produktu');
  const values = [a.tenantId, productId, b.category, b.exemption_basis_kind, b.exemption_basis, b.np_kind, b.gtu, b.annex15, b.oss_rate_class, a.userId, a.apiKeyId ?? null];
  const saved = b.version === null
    ? (await c.query(`INSERT INTO tax226_product_profiles(tenant_id,product_id,category,exemption_basis_kind,exemption_basis,np_kind,gtu,annex15,oss_rate_class,updated_by,api_key_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING version`, values)).rows[0]
    : (await c.query(`UPDATE tax226_product_profiles SET category=$3,exemption_basis_kind=$4,exemption_basis=$5,np_kind=$6,gtu=$7,annex15=$8,oss_rate_class=$9,
        updated_by=$10,api_key_id=$11,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND product_id=$2 AND version=$12 RETURNING version`, [...values, b.version])).rows[0];
  ensure(saved, 409, 'Profil podatkowy zmieniono w innym oknie. Odśwież kartę.');
  await audit(c, a, 'product.tax_profile', productId, { version: saved.version, category: b.category, gtu: b.gtu, annex15: b.annex15 });
  return productTaxProfileInTx(c, productId);
}

export type OssView = { settings: { version: number | null; registered: boolean; registered_from: string | null; updated_at: string | null };
  rates: OssState['rates']; countries: readonly string[]; rate_classes: readonly string[] };
const dayText = (v: Date | string | null) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
export async function ossSettingsInTx(c: PoolClient): Promise<OssView> {
  await requireTax226(c);
  const s = (await c.query('SELECT version,registered,to_char(registered_from,\'YYYY-MM-DD\') registered_from,updated_at FROM tax226_oss_settings')).rows[0];
  const rates = (await c.query('SELECT country,rate_class,rate::text rate FROM tax226_oss_rates ORDER BY country,rate_class')).rows;
  return { settings: s ? { version: s.version, registered: s.registered, registered_from: dayText(s.registered_from), updated_at: iso(s.updated_at) }
    : { version: null, registered: false, registered_from: null, updated_at: null }, rates, countries: OSS_COUNTRIES, rate_classes: OSS_RATE_CLASSES };
}
/** Replaces the OSS registration and the whole destination-rate table in one write. */
export async function saveOssSettingsInTx(c: PoolClient, a: AuditActor & { apiKeyId?: string }, b: OssSettingsInput): Promise<OssView> {
  await requireTax226(c);
  const values = [a.tenantId, b.registered, b.registered_from, a.userId, a.apiKeyId ?? null];
  const saved = b.version === null
    ? (await c.query(`INSERT INTO tax226_oss_settings(tenant_id,registered,registered_from,updated_by,api_key_id) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING RETURNING version`, values)).rows[0]
    : (await c.query(`UPDATE tax226_oss_settings SET registered=$2,registered_from=$3,updated_by=$4,api_key_id=$5,version=version+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND version=$6 RETURNING version`, [...values, b.version])).rows[0];
  ensure(saved, 409, 'Ustawienia OSS zmieniono w innym oknie. Odśwież.');
  await c.query('DELETE FROM tax226_oss_rates WHERE tenant_id=$1', [a.tenantId]);
  for (const r of b.rates)
    await c.query('INSERT INTO tax226_oss_rates(tenant_id,country,rate_class,rate) VALUES($1,$2,$3,$4)', [a.tenantId, r.country, r.rate_class, r.rate]);
  await audit(c, a, 'tax.oss_settings', null, { version: saved.version, registered: b.registered, registered_from: b.registered_from, rates: b.rates.length });
  return ossSettingsInTx(c);
}

/** The lines and parties of a local invoice snapshot (157) that the tax facts use. */
export type LocalInvoiceTaxSource = {
  /** 157 snapshots carry a consumer; a business buyer also says whether it has an EU VAT ID or PL VAT payer status. */
  buyer: { kind: 'consumer' | 'business'; address: { country: string }; tax_id_kind?: 'nip' | 'eu_vat' | 'none'; pl_vat_payer?: boolean };
  sell_date: string;
  totals: { gross_minor: string };
  lines: { kind: 'item' | 'shipping'; item_id: string | null; product_id: string | null; sku: string; name: string; vat_rate: number; gross_minor: string }[];
};
export type TaxFactsLine = TaxLineFacts & { line_no: number; kind: 'item' | 'shipping'; item_id: string | null; product_id: string | null; sku: string; name: string };
export type TaxFacts = { buyer_kind: TaxBuyer['kind']; buyer_country: string; procedure: 'domestic' | 'oss'; oss_country: string | null;
  gross_minor: string; annex15_gross_minor: string; mpp_required: boolean; mpp_reason: string; lines: TaxFactsLine[] };
const CATEGORY_LABEL: Record<string, string> = { zw: 'zwolnienie ZW', np: 'NP (niepodlegające)', oo: 'odwrotne obciążenie OO' };

/** Tax facts of a local invoice from the current product profiles and refusals
 * of this issue. Local invoice math (157) knows only ordinary rates, so any other
 * category on a line blocks the issue until the FA(3) step supports it. */
export async function localInvoiceTaxFactsInTx(c: PoolClient, s: LocalInvoiceTaxSource): Promise<{ facts: TaxFacts; blockers: string[] }> {
  await requireTax226(c);
  const ids = [...new Set(s.lines.map(l => l.product_id).filter((v): v is string => v !== null))];
  const profiles = new Map((await c.query('SELECT * FROM tax226_product_profiles WHERE product_id=ANY($1::uuid[])', [ids])).rows.map(r => [r.product_id as string, profileRow(r)]));
  const oss = await ossSettingsInTx(c), buyer: TaxBuyer = { kind: s.buyer.kind, country: s.buyer.address.country,
    eu_vat_id: s.buyer.tax_id_kind === 'eu_vat', pl_vat_payer: s.buyer.kind === 'business' && s.buyer.pl_vat_payer === true };
  const state: OssState = { registered: oss.settings.registered, registered_from: oss.settings.registered_from, rates: oss.rates };
  const blockers: string[] = [], lines: TaxFactsLine[] = [];
  let annex = 0n;
  for (const [i, l] of s.lines.entries()) {
    const d = deriveLineTax({ kind: l.kind, vat_rate: l.vat_rate, profile: (l.product_id && profiles.get(l.product_id)) || DEFAULT_TAX_PROFILE }, buyer, state, s.sell_date);
    if ('refusal' in d) { blockers.push(`${l.sku || l.name}: ${d.refusal}`); continue; }
    if (d.facts.category !== 'standard') blockers.push(`${l.sku}: ${CATEGORY_LABEL[d.facts.category]} — lokalna FV liczy dziś tylko zwykłe stawki 0/5/8/23%, wystawienie wstrzymane`);
    if (d.facts.annex15) annex += BigInt(l.gross_minor);
    lines.push({ ...d.facts, line_no: i + 1, kind: l.kind, item_id: l.item_id, product_id: l.product_id, sku: l.sku, name: l.name });
  }
  const gross = BigInt(s.totals.gross_minor), mpp = mppRequirement(buyer, gross, annex), oss_line = lines.some(l => l.rate_code === 'oss');
  if (mpp.required) blockers.push('Faktura wymaga oznaczenia MPP, którego lokalna FV jeszcze nie obsługuje');
  return { facts: { buyer_kind: buyer.kind, buyer_country: buyer.country, procedure: oss_line ? 'oss' : 'domestic', oss_country: oss_line ? buyer.country : null,
    gross_minor: gross.toString(), annex15_gross_minor: annex.toString(), mpp_required: mpp.required, mpp_reason: mpp.reason, lines }, blockers };
}

/** Writes the snapshot of a just issued (or replayed) local invoice in the issuing transaction. */
export async function captureLocalInvoiceTaxInTx(c: PoolClient, a: AuditActor & { apiKeyId?: string }, documentId: string, data: LocalInvoiceTaxSource, withIssue: boolean): Promise<void> {
  if ((await c.query('SELECT 1 FROM tax226_document_snapshots WHERE document_id=$1', [documentId])).rowCount) return;
  const { facts: f, blockers } = await localInvoiceTaxFactsInTx(c, data);
  ensure(!blockers.length, 409, blockers.join(' · '));
  await c.query(`INSERT INTO tax226_document_snapshots(tenant_id,document_id,source,captured_with_issue,buyer_kind,buyer_country,procedure,oss_country,gross_minor,annex15_gross_minor,mpp_required,actor_id,api_key_id)
    VALUES($1,$2,'local_invoice',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [a.tenantId, documentId, withIssue, f.buyer_kind, f.buyer_country, f.procedure, f.oss_country, f.gross_minor, f.annex15_gross_minor, f.mpp_required, a.userId, a.apiKeyId ?? null]);
  for (const l of f.lines)
    await c.query(`INSERT INTO tax226_document_lines(tenant_id,document_id,line_no,kind,item_id,product_id,category,rate,rate_code,exemption_basis_kind,exemption_basis,np_kind,gtu,annex15,profile_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [a.tenantId, documentId, l.line_no, l.kind, l.item_id, l.product_id, l.category, l.rate, l.rate_code, l.exemption_basis_kind, l.exemption_basis, l.np_kind, l.gtu, l.annex15, l.profile_version]);
}

export type TaxSnapshotView = TaxFacts & { captured_with_issue: boolean; captured_at: string };
/** Stored snapshot of a document joined with its own line texts; null when the document was issued without it. */
export async function documentTaxSnapshotInTx(c: PoolClient, documentId: string, data: LocalInvoiceTaxSource): Promise<TaxSnapshotView | null> {
  await requireTax226(c);
  const h = (await c.query('SELECT * FROM tax226_document_snapshots WHERE document_id=$1', [documentId])).rows[0];
  if (!h) return null;
  const rows = (await c.query('SELECT *,rate::text rate FROM tax226_document_lines WHERE document_id=$1 ORDER BY line_no', [documentId])).rows;
  ensure(rows.length === data.lines.length && rows.every((r, i) => r.line_no === i + 1 && r.kind === data.lines[i].kind && r.item_id === data.lines[i].item_id),
    503, 'Migawka podatkowa nie zgadza się z pozycjami faktury');
  const mpp = mppRequirement({ kind: h.buyer_kind, country: h.buyer_country }, BigInt(h.gross_minor), BigInt(h.annex15_gross_minor));
  return { buyer_kind: h.buyer_kind, buyer_country: h.buyer_country, procedure: h.procedure, oss_country: h.oss_country, gross_minor: String(h.gross_minor),
    annex15_gross_minor: String(h.annex15_gross_minor), mpp_required: h.mpp_required, mpp_reason: mpp.reason, captured_with_issue: h.captured_with_issue, captured_at: iso(h.captured_at)!,
    lines: rows.map((r, i) => ({ line_no: r.line_no, kind: r.kind, item_id: r.item_id, product_id: r.product_id, sku: data.lines[i].sku, name: data.lines[i].name,
      category: r.category, rate: r.rate, rate_code: r.rate_code, exemption_basis_kind: r.exemption_basis_kind, exemption_basis: r.exemption_basis,
      np_kind: r.np_kind, gtu: r.gtu, annex15: r.annex15, profile_version: r.profile_version })) };
}
