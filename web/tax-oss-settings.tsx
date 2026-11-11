import './tax226.css';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { OSS_RATE_CLASSES, ossRateClassLabels } from './catalog-tax-profile';

/** Tenant OSS registration and destination rates of the 226 tax model (GET/PUT /tax/oss). */
export const OSS_COUNTRIES = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'RO', 'SE', 'SI', 'SK'] as const;
export type OssRate = { country: string; rate_class: string; rate: string };
export type OssView = {
  settings: { version: number | null; registered: boolean; registered_from: string | null; updated_at: string | null };
  rates: OssRate[]; countries: string[]; rate_classes: string[]; read_only: boolean;
};
export type OssRow = { key: number; country: string; rate_class: string; rate: string };
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const stamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
export function readOssSettings(value: unknown): OssView {
  const v = value as any, s = v?.settings, seen = new Set<string>();
  const ok = v && s && Array.isArray(v.countries) && same(v.countries, OSS_COUNTRIES) && Array.isArray(v.rate_classes) && same(v.rate_classes, OSS_RATE_CLASSES) && typeof v.read_only === 'boolean'
    && (s.version === null ? s.registered === false && s.registered_from === null && s.updated_at === null : Number.isSafeInteger(s.version) && s.version > 0 && stamp(s.updated_at))
    && typeof s.registered === 'boolean' && (s.registered ? day(s.registered_from) : s.registered_from === null)
    && Array.isArray(v.rates) && v.rates.length <= OSS_COUNTRIES.length * OSS_RATE_CLASSES.length
    && v.rates.every((r: any) => {
      const k = r?.country + ':' + r?.rate_class, fresh = !seen.has(k); seen.add(k);
      return fresh && (OSS_COUNTRIES as readonly string[]).includes(r.country) && (OSS_RATE_CLASSES as readonly string[]).includes(r.rate_class)
        && typeof r.rate === 'string' && /^(0|[1-9][0-9]?)\.[0-9]{2}$/.test(r.rate) && Number(r.rate) <= 30;
    });
  if (!ok) throw Error('Niepełne lub obce ustawienia OSS. Odśwież widok.');
  return v;
}
/** PUT body; the whole table replaces the stored one. Rates accept "19", "19.5" or "19,50". */
export function ossSettingsBody(version: number | null, registered: boolean, registeredFrom: string, rows: readonly OssRow[]) {
  if (registered && !day(registeredFrom)) throw Error('Podaj datę początku rejestracji OSS.');
  const seen = new Set<string>();
  const rates = rows.map((r) => {
    const k = r.country + ':' + r.rate_class, t = r.rate.trim().replace(',', '.');
    if (!(OSS_COUNTRIES as readonly string[]).includes(r.country) || !(OSS_RATE_CLASSES as readonly string[]).includes(r.rate_class)) throw Error('Wybierz kraj i klasę stawki z listy.');
    if (seen.has(k)) throw Error(`Stawka ${r.country} / ${ossRateClassLabels[r.rate_class]} występuje dwa razy.`);
    seen.add(k);
    if (!/^[0-9]{1,2}([.][0-9]{1,2})?$/.test(t) || Number(t) > 30) throw Error(`Stawka ${r.country} / ${ossRateClassLabels[r.rate_class]}: podaj liczbę od 0 do 30, najwyżej dwa miejsca po przecinku.`);
    return { country: r.country, rate_class: r.rate_class, rate: Number(t) };
  });
  return { version, registered, registered_from: registered ? registeredFrom : null, rates };
}
const rateText = (r: string) => r.replace('.', ',') + '%';

export function TaxOssSettingsPanel({ contextKey, readOnly, admin }: { contextKey: string; readOnly: boolean; admin: boolean }) {
  const [view, setView] = useState<OssView | null>(null),
    [error, setError] = useState(''),
    [saveError, setSaveError] = useState(''),
    [unavailable, setUnavailable] = useState(false),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [registered, setRegistered] = useState(false),
    [from, setFrom] = useState(''),
    [rows, setRows] = useState<OssRow[]>([]);
  const next = useRef(0);
  function show(v: OssView) {
    setView(v); setRegistered(v.settings.registered); setFrom(v.settings.registered_from ?? '');
    setRows(v.rates.map((r) => ({ key: ++next.current, ...r })));
  }
  async function load() { show(readOssSettings(await api('/tax/oss'))); }
  useEffect(() => {
    let alive = true;
    setView(null); setError(''); setSaveError(''); setSaved(false); setUnavailable(false);
    api('/tax/oss')
      .then((v) => { if (alive) show(readOssSettings(v)); })
      .catch((e) => { if (!alive) return; if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError((e as Error).message); });
    return () => { alive = false; };
  }, [contextKey]);
  const editable = admin && !readOnly && !!view && !view.read_only;
  const edit = (key: number, patch: Partial<OssRow>) => { setSaved(false); setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r))); };
  function add() {
    const used = new Set(rows.map((r) => r.country + ':' + r.rate_class));
    const free = OSS_COUNTRIES.flatMap((c) => OSS_RATE_CLASSES.map((k) => [c, k] as const)).find(([c, k]) => !used.has(c + ':' + k));
    if (!free) return;
    setSaved(false);
    setRows((all) => [...all, { key: ++next.current, country: free[0], rate_class: free[1], rate: '' }]);
  }
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!view || !editable || busy) return;
    setSaveError(''); setSaved(false);
    let body;
    try { body = ossSettingsBody(view.settings.version, registered, from, rows); } catch (err) { setSaveError((err as Error).message); return; }
    setBusy(true);
    try { show(readOssSettings(await api('/tax/oss', 'PUT', body))); setSaved(true); }
    catch (err) {
      setSaveError((err as Error).message);
      if (err instanceof ApiError && err.status === 409) { try { await load(); } catch (reload) { setError((reload as Error).message); } }
    } finally { setBusy(false); }
  }
  if (unavailable) return <section className="panel tax-oss" aria-label="Ustawienia OSS"><h3>Procedura OSS</h3><p className="muted">Model podatkowy niedostępny w tej kopii.</p></section>;
  return (
    <section className="panel tax-oss" aria-label="Ustawienia OSS">
      <h3>Procedura OSS — stawki krajów UE</h3>
      <p className="muted">Sprzedaż wysyłkowa do konsumentów w innych krajach UE wymaga rejestracji OSS ważnej w dniu sprzedaży i stawki kraju przeznaczenia dla klasy stawki produktu.</p>
      {error && <div className="notice import-error" role="alert">{error}</div>}
      {!view && !error && <p role="status">Odczytywanie ustawień OSS…</p>}
      {view && !editable && (
        <>
          <p>{view.settings.registered ? `Zarejestrowano w OSS od ${view.settings.registered_from}.` : 'Brak rejestracji OSS.'}</p>
          {!view.rates.length ? <p>Brak stawek krajów przeznaczenia.</p> : (
            <div className="table-scroll"><table><thead><tr><th>Kraj</th><th>Klasa stawki</th><th>Stawka</th></tr></thead>
              <tbody>{view.rates.map((r) => <tr key={r.country + ':' + r.rate_class}><td>{r.country}</td><td>{ossRateClassLabels[r.rate_class]}</td><td>{rateText(r.rate)}</td></tr>)}</tbody></table></div>
          )}
          {admin && <p className="muted">Kopia tylko do odczytu — ustawień OSS nie można zmienić.</p>}
        </>
      )}
      {view && editable && (
        <form aria-label="Edycja ustawień OSS" onSubmit={save}>
          <div className="form-grid">
            <label className="tax226-check">
              <input type="checkbox" checked={registered} disabled={busy} onChange={(e) => { setSaved(false); setRegistered(e.target.checked); }} />
              Firma jest zarejestrowana w procedurze OSS
            </label>
            {registered && <label>Data początku rejestracji<input type="date" value={from} disabled={busy} required onChange={(e) => { setSaved(false); setFrom(e.target.value); }} /></label>}
          </div>
          <div className="table-scroll"><table><thead><tr><th>Kraj</th><th>Klasa stawki</th><th>Stawka (%)</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td><select aria-label="Kraj" value={r.country} disabled={busy} onChange={(e) => edit(r.key, { country: e.target.value })}>{OSS_COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></td>
                  <td><select aria-label="Klasa stawki" value={r.rate_class} disabled={busy} onChange={(e) => edit(r.key, { rate_class: e.target.value })}>{OSS_RATE_CLASSES.map((k) => <option key={k} value={k}>{ossRateClassLabels[k]}</option>)}</select></td>
                  <td><input aria-label={`Stawka ${r.country} ${ossRateClassLabels[r.rate_class]}`} inputMode="decimal" value={r.rate} maxLength={5} disabled={busy} onChange={(e) => edit(r.key, { rate: e.target.value })} /></td>
                  <td><button type="button" className="text-button" disabled={busy} onClick={() => { setSaved(false); setRows((all) => all.filter((x) => x.key !== r.key)); }}>Usuń stawkę</button></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={4}>Brak stawek krajów przeznaczenia.</td></tr>}
            </tbody></table></div>
          {saveError && <div className="notice import-error" role="alert">{saveError}</div>}
          {saved && <p role="status">Zapisano ustawienia OSS.</p>}
          <div className="inline-actions">
            <button type="button" className="button" disabled={busy || rows.length >= OSS_COUNTRIES.length * OSS_RATE_CLASSES.length} onClick={add}>Dodaj stawkę</button>
            <button className="button primary" disabled={busy}>{busy ? 'Zapisywanie…' : 'Zapisz ustawienia OSS'}</button>
          </div>
        </form>
      )}
    </section>
  );
}
