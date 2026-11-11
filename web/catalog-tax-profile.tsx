import './tax226.css';
import { useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** Native 226 tax profile of a product (GET/PUT /products/:id/tax-profile). */
export const TAX_CATEGORIES = ['standard', 'zw', 'np', 'oo'] as const;
export const EXEMPTION_BASIS_KINDS = ['P_19A', 'P_19B', 'P_19C'] as const;
export const NP_KINDS = ['np_i', 'np_ii'] as const;
export const GTU_CODES = Array.from({ length: 13 }, (_, i) => 'GTU_' + String(i + 1).padStart(2, '0'));
export const OSS_RATE_CLASSES = ['standard', 'reduced_1', 'reduced_2', 'super_reduced', 'zero'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];
export type TaxProfileDraft = {
  category: TaxCategory;
  exemption_basis_kind: (typeof EXEMPTION_BASIS_KINDS)[number] | null;
  exemption_basis: string | null;
  np_kind: (typeof NP_KINDS)[number] | null;
  gtu: string | null;
  annex15: boolean;
  oss_rate_class: (typeof OSS_RATE_CLASSES)[number];
};
export type TaxProfile = TaxProfileDraft & { version: number | null };
export type ProductTaxProfileView = { product_id: string; sku: string; product_vat: number; profile: TaxProfile; updated_at: string | null; read_only: boolean };

export const taxCategoryLabel = (c: TaxCategory, vat: number) =>
  ({ standard: `Zwykła stawka VAT ${vat}%`, zw: 'Zwolnienie ZW', np: 'Niepodlegające NP', oo: 'Odwrotne obciążenie OO' })[c];
export const exemptionBasisKindLabels: Record<string, string> = {
  P_19A: 'P_19A — przepis ustawy/rozporządzenia',
  P_19B: 'P_19B — przepis dyrektywy 2006/112/WE',
  P_19C: 'P_19C — inna podstawa',
};
export const npKindLabels: Record<string, string> = {
  np_i: 'NP I: poza krajem, bez art. 100 ust. 1 pkt 4 i OSS',
  np_ii: 'NP II: usługi z art. 100 ust. 1 pkt 4 (art. 28b) dla podatnika z UE',
};
export const ossRateClassLabels: Record<string, string> = {
  standard: 'Podstawowa',
  reduced_1: 'Obniżona 1',
  reduced_2: 'Obniżona 2',
  super_reduced: 'Superobniżona',
  zero: 'Zerowa',
};
const text = (v: unknown): v is string => typeof v === 'string' && !/[\x00-\x1f\x7f-\x9f]/.test(v);
const stamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const has = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v);
/** The category rules of 226: ZW carries a basis, NP its kind, every other field stays null. */
function consistent(p: any) {
  return has(TAX_CATEGORIES, p.category) && (p.gtu === null || has(GTU_CODES, p.gtu)) && typeof p.annex15 === 'boolean' && has(OSS_RATE_CLASSES, p.oss_rate_class)
    && (p.category === 'zw'
      ? has(EXEMPTION_BASIS_KINDS, p.exemption_basis_kind) && text(p.exemption_basis) && p.exemption_basis.trim().length > 0 && p.exemption_basis.length <= 256
      : p.exemption_basis_kind === null && p.exemption_basis === null)
    && (p.category === 'np' ? has(NP_KINDS, p.np_kind) : p.np_kind === null);
}
export function readProductTaxProfile(value: unknown, productId: string): ProductTaxProfileView {
  const v = value as any, p = v?.profile;
  const ok = v && v.product_id === productId && text(v.sku) && typeof v.product_vat === 'number' && Number.isFinite(v.product_vat) && v.product_vat >= 0 && v.product_vat <= 100
    && typeof v.read_only === 'boolean' && p && (p.version === null || Number.isSafeInteger(p.version) && p.version > 0) && consistent(p)
    && (p.version === null ? v.updated_at === null : stamp(v.updated_at));
  if (!ok) throw Error('Niepełne lub obce dane podatkowe produktu. Odśwież kartę.');
  return v;
}
/** PUT body: fields of other categories are sent as null; the server stays the authority on the rules. */
export function taxProfileBody(version: number | null, d: TaxProfileDraft) {
  if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw Error('Brak wersji profilu podatkowego. Odśwież kartę.');
  const basis = d.category === 'zw' ? (d.exemption_basis ?? '').trim() : null;
  if (d.category === 'zw' && !d.exemption_basis_kind) throw Error('Wybierz rodzaj podstawy zwolnienia (P_19A, P_19B lub P_19C).');
  if (basis !== null && !basis) throw Error('Podaj podstawę prawną zwolnienia.');
  if (basis !== null && basis.length > 256) throw Error('Podstawa prawna może mieć najwyżej 256 znaków.');
  if (d.category === 'np' && !d.np_kind) throw Error('Wybierz rodzaj NP: NP I albo NP II.');
  return {
    version, category: d.category, exemption_basis_kind: d.category === 'zw' ? d.exemption_basis_kind : null, exemption_basis: basis,
    np_kind: d.category === 'np' ? d.np_kind : null, gtu: d.gtu, annex15: d.annex15, oss_rate_class: d.oss_rate_class,
  };
}
const draftOf = ({ version: _v, ...d }: TaxProfile): TaxProfileDraft => d;

/** "Podatek" section of the product card; admins edit the profile in place. */
export function ProductTaxProfile({ productId, admin, readOnly, blocked }: { productId: string; admin: boolean; readOnly: boolean; blocked: boolean }) {
  const [view, setView] = useState<ProductTaxProfileView | null>(null),
    [error, setError] = useState(''),
    [unavailable, setUnavailable] = useState(false),
    [draft, setDraft] = useState<TaxProfileDraft | null>(null),
    [busy, setBusy] = useState(false),
    [saveError, setSaveError] = useState('');
  async function load() {
    const v = readProductTaxProfile(await api('/products/' + productId + '/tax-profile'), productId);
    setView(v);
    return v;
  }
  useEffect(() => {
    let alive = true;
    setView(null); setDraft(null); setError(''); setSaveError(''); setUnavailable(false);
    api('/products/' + productId + '/tax-profile')
      .then((v) => { if (alive) setView(readProductTaxProfile(v, productId)); })
      .catch((e) => { if (!alive) return; if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError((e as Error).message); });
    return () => { alive = false; };
  }, [productId]);
  const canEdit = admin && !readOnly && !blocked && !!view && !view.read_only;
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!view || !draft || busy || !canEdit) return;
    setSaveError('');
    let body;
    try { body = taxProfileBody(view.profile.version, draft); } catch (err) { setSaveError((err as Error).message); return; }
    setBusy(true);
    try {
      setView(readProductTaxProfile(await api('/products/' + productId + '/tax-profile', 'PUT', body), productId));
      setDraft(null);
    } catch (err) {
      setSaveError((err as Error).message);
      // A stale version is refreshed so the next save starts from the current profile.
      if (err instanceof ApiError && err.status === 409) { try { setDraft(draftOf((await load()).profile)); } catch (reload) { setError((reload as Error).message); } }
    } finally { setBusy(false); }
  }
  if (unavailable) return <section className="catalog-section" aria-label="Podatek"><h3>Podatek</h3><p className="muted">Model podatkowy niedostępny w tej kopii.</p></section>;
  const p = view?.profile, set = (patch: Partial<TaxProfileDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  return (
    <section className="catalog-section" aria-label="Podatek">
      <h3>Podatek</h3>
      {error && <div className="notice import-error" role="alert">{error}</div>}
      {!view && !error && <p role="status">Odczytywanie profilu podatkowego…</p>}
      {view && p && !draft && (
        <>
          <dl className="catalog-tax-profile">
            <dt>Kategoria</dt><dd>{taxCategoryLabel(p.category, view.product_vat)}</dd>
            {p.category === 'zw' && <><dt>Podstawa zwolnienia</dt><dd>{exemptionBasisKindLabels[p.exemption_basis_kind!]}: {p.exemption_basis}</dd></>}
            {p.category === 'np' && <><dt>Rodzaj NP</dt><dd>{npKindLabels[p.np_kind!]}</dd></>}
            <dt>GTU</dt><dd>{p.gtu ?? 'brak'}</dd>
            <dt>Załącznik 15 (MPP)</dt><dd>{p.annex15 ? 'tak' : 'nie'}</dd>
            <dt>Klasa stawki OSS</dt><dd>{ossRateClassLabels[p.oss_rate_class]}</dd>
          </dl>
          {p.version === null && <p className="muted">Brak zapisanego profilu — obowiązuje zwykła stawka produktu.</p>}
          {admin && (
            <button type="button" className="button" disabled={!canEdit} onClick={() => { setSaveError(''); setDraft(draftOf(p)); }}>
              Zmień dane podatkowe
            </button>
          )}
        </>
      )}
      {view && draft && (
        <form className="form-grid tax226-form" aria-label="Dane podatkowe produktu" onSubmit={save}>
          <label>
            Kategoria
            <select value={draft.category} disabled={busy} onChange={(e) => set({ category: e.target.value as TaxCategory })}>
              {TAX_CATEGORIES.map((c) => <option key={c} value={c}>{taxCategoryLabel(c, view.product_vat)}</option>)}
            </select>
          </label>
          {draft.category === 'zw' && (
            <>
              <label>
                Rodzaj podstawy zwolnienia
                <select value={draft.exemption_basis_kind ?? ''} disabled={busy} onChange={(e) => set({ exemption_basis_kind: (e.target.value || null) as TaxProfileDraft['exemption_basis_kind'] })}>
                  <option value="">Wybierz podstawę</option>
                  {EXEMPTION_BASIS_KINDS.map((k) => <option key={k} value={k}>{exemptionBasisKindLabels[k]}</option>)}
                </select>
              </label>
              <label className="full-span">
                Podstawa prawna zwolnienia
                <input value={draft.exemption_basis ?? ''} maxLength={256} disabled={busy} placeholder="np. art. 43 ust. 1 pkt 18 ustawy o VAT" onChange={(e) => set({ exemption_basis: e.target.value })} />
              </label>
            </>
          )}
          {draft.category === 'np' && (
            <label>
              Rodzaj NP
              <select value={draft.np_kind ?? ''} disabled={busy} onChange={(e) => set({ np_kind: (e.target.value || null) as TaxProfileDraft['np_kind'] })}>
                <option value="">Wybierz rodzaj</option>
                {NP_KINDS.map((k) => <option key={k} value={k}>{npKindLabels[k]}</option>)}
              </select>
            </label>
          )}
          <label>
            GTU
            <select value={draft.gtu ?? ''} disabled={busy} onChange={(e) => set({ gtu: e.target.value || null })}>
              <option value="">brak</option>
              {GTU_CODES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          <label>
            Klasa stawki OSS
            <select value={draft.oss_rate_class} disabled={busy} onChange={(e) => set({ oss_rate_class: e.target.value as TaxProfileDraft['oss_rate_class'] })}>
              {OSS_RATE_CLASSES.map((k) => <option key={k} value={k}>{ossRateClassLabels[k]}</option>)}
            </select>
          </label>
          <label className="tax226-check full-span">
            <input type="checkbox" checked={draft.annex15} disabled={busy} onChange={(e) => set({ annex15: e.target.checked })} />
            Towar lub usługa z załącznika nr 15 (mechanizm podzielonej płatności)
          </label>
          {saveError && <div className="notice import-error full-span" role="alert">{saveError}</div>}
          <div className="inline-actions full-span">
            <button type="button" className="button" disabled={busy} onClick={() => { setDraft(null); setSaveError(''); }}>Anuluj</button>
            <button className="button primary" disabled={busy || !canEdit}>{busy ? 'Zapisywanie…' : 'Zapisz dane podatkowe'}</button>
          </div>
        </form>
      )}
    </section>
  );
}
