import { useState, type ReactNode } from 'react';

/** Pliki JPK in Dokumenty: JPK_V7M / JPK_V7K for a month and JPK_FA for a date range, built
 * by the server from issued documents and downloaded locally. Nothing is sent to e-Deklaracje. */
export type JpkKind = 'v7m' | 'v7k' | 'fa';
export type JpkTaxpayer = { kod_urzedu: string; email: string; telefon: string; nip: string; nazwa: string; cel: '1' | '2'; osoba: 'niefizyczna' | 'fizyczna';
  imie: string; nazwisko: string; data_urodzenia: string; nadwyzka: string };
export type JpkAddress = { wojewodztwo: string; powiat: string; gmina: string; ulica: string; nr_domu: string; nr_lokalu: string; miejscowosc: string; kod_pocztowy: string };
export type JpkPeriod = { okres: string; od: string; do: string };
type Refused = { number: string; reason: string };

const emptyTaxpayer: JpkTaxpayer = { kod_urzedu: '', email: '', telefon: '', nip: '', nazwa: '', cel: '1', osoba: 'niefizyczna', imie: '', nazwisko: '', data_urodzenia: '', nadwyzka: '' };
const emptyAddress: JpkAddress = { wojewodztwo: '', powiat: '', gmina: '', ulica: '', nr_domu: '', nr_lokalu: '', miejscowosc: '', kod_pocztowy: '' };
const labels: Record<JpkKind, string> = { v7m: 'JPK_V7M', v7k: 'JPK_V7K', fa: 'JPK_FA' };

const pad = (n: number) => String(n).padStart(2, '0');
/** Previous calendar month as YYYY-MM. */
export function previousMonth(today = new Date()): string {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
/** First and last day of a YYYY-MM month. */
export function monthRange(okres: string): { od: string; do: string } {
  const [y, m] = okres.split('-').map(Number);
  if (!y || !m) return { od: '', do: '' };
  return { od: `${okres}-01`, do: `${okres}-${pad(new Date(y, m, 0).getDate())}` };
}

const storageKey = (contextKey: string) => 'dyna.jpk.' + contextKey;
function readSaved(contextKey: string): { taxpayer: JpkTaxpayer; address: JpkAddress } {
  try {
    const raw = window.localStorage.getItem(storageKey(contextKey));
    const v = raw ? JSON.parse(raw) : null;
    const pick = <T extends Record<string, string>>(base: T, src: unknown): T => {
      const out = { ...base };
      if (src && typeof src === 'object') for (const k of Object.keys(base)) { const x = (src as Record<string, unknown>)[k]; if (typeof x === 'string') (out as Record<string, string>)[k] = x; }
      return out;
    };
    const taxpayer = pick(emptyTaxpayer, v?.taxpayer);
    if (taxpayer.cel !== '1' && taxpayer.cel !== '2') taxpayer.cel = '1';
    if (taxpayer.osoba !== 'niefizyczna' && taxpayer.osoba !== 'fizyczna') taxpayer.osoba = 'niefizyczna';
    return { taxpayer, address: pick(emptyAddress, v?.address) };
  } catch { return { taxpayer: emptyTaxpayer, address: emptyAddress }; }
}
function writeSaved(contextKey: string, taxpayer: JpkTaxpayer, address: JpkAddress) {
  try { window.localStorage.setItem(storageKey(contextKey), JSON.stringify({ taxpayer, address })); } catch { /* storage unavailable: the form still works */ }
}

/** Convenience check before the request; the server validates everything again. */
export function validateJpk(kind: JpkKind, t: JpkTaxpayer, a: JpkAddress, p: JpkPeriod): string {
  if (kind === 'fa') {
    if (!p.od || !p.do) return 'Podaj daty „Od” i „Do”.';
    if (p.od > p.do) return 'Data „Od” nie może być późniejsza niż „Do”.';
  } else if (!/^\d{4}-\d{2}$/.test(p.okres)) return 'Wybierz miesiąc.';
  if (!/^\d{4}$/.test(t.kod_urzedu.trim())) return 'Kod urzędu skarbowego to 4 cyfry.';
  if (kind !== 'fa') {
    if (!t.email.trim()) return 'Podaj e-mail podatnika (wymagany w JPK_V7).';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.email.trim())) return 'Podaj poprawny adres e-mail.';
  }
  if (t.osoba === 'fizyczna') {
    if (!t.imie.trim()) return 'Podaj imię podatnika.';
    if (!t.nazwisko.trim()) return 'Podaj nazwisko podatnika.';
    if (!t.data_urodzenia) return 'Podaj datę urodzenia podatnika.';
  }
  if (kind !== 'fa' && t.nadwyzka.trim() && !/^\d{1,13}$/.test(t.nadwyzka.trim())) return 'Nadwyżka to kwota w pełnych złotych (same cyfry).';
  if (kind === 'fa') {
    const missing = ([['wojewodztwo', 'województwo'], ['powiat', 'powiat'], ['gmina', 'gminę'], ['nr_domu', 'numer domu'], ['miejscowosc', 'miejscowość'], ['kod_pocztowy', 'kod pocztowy']] as const)
      .filter(([k]) => !a[k].trim()).map(([, name]) => name);
    if (missing.length) return 'JPK_FA wymaga adresu podatnika — podaj: ' + missing.join(', ') + '.';
    if (!/^\d{2}-\d{3}$/.test(a.kod_pocztowy.trim())) return 'Kod pocztowy w formacie NN-NNN.';
  }
  return '';
}

/** Query string of one request; only non-empty values are sent. */
export function jpkQuery(kind: JpkKind, t: JpkTaxpayer, a: JpkAddress, p: JpkPeriod): string {
  const q = new URLSearchParams();
  const add = (k: string, v: string) => { if (v.trim()) q.append(k, v.trim()); };
  if (kind === 'fa') { add('od', p.od); add('do', p.do); } else add('okres', p.okres);
  add('kod_urzedu', t.kod_urzedu);
  if (kind !== 'fa') { add('email', t.email); add('telefon', t.telefon); }
  add('nip', t.nip); add('nazwa', t.nazwa); add('cel', t.cel); add('osoba', t.osoba);
  if (t.osoba === 'fizyczna') { add('imie', t.imie); add('nazwisko', t.nazwisko); add('data_urodzenia', t.data_urodzenia); }
  if (kind !== 'fa') add('nadwyzka', t.nadwyzka);
  if (kind === 'fa') for (const k of Object.keys(emptyAddress) as (keyof JpkAddress)[]) add(k, a[k]);
  return q.toString();
}

const rowsWord = (n: number) => n === 1 ? 'wiersz' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'wiersze' : 'wierszy';
class Refusal extends Error { constructor(message: string, readonly documents: Refused[] = []) { super(message); } }

async function downloadJpk(kind: JpkKind, query: string, workspaceId: string): Promise<string> {
  const response = await fetch(`/api/jpk/${kind}.xml?${query}`, { credentials: 'same-origin', headers: { 'X-Workspace-ID': workspaceId } });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown; documents?: unknown } | null;
    const detail = typeof body?.detail === 'string' && body.detail ? body.detail : `Nie udało się przygotować pliku ${labels[kind]}.`;
    const documents = response.status === 409 && Array.isArray(body?.documents)
      ? body.documents.filter((d): d is Refused => !!d && typeof d.number === 'string' && typeof d.reason === 'string') : [];
    throw new Refusal(detail, documents);
  }
  const xml = await response.text();
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || parsed.getElementsByTagName('parsererror').length || parsed.documentElement?.localName !== 'JPK')
    throw new Refusal('Serwer zwrócił plik, który nie jest poprawnym JPK.');
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `${labels[kind]}.xml`;
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name;
  try { document.body.appendChild(link); link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  const rows = response.headers.get('x-jpk-wiersze');
  return rows && /^\d+$/.test(rows) ? `Pobrano plik ${name} (${rows} ${rowsWord(Number(rows))}).` : `Pobrano plik ${name}.`;
}

const fieldStyle = { margin: 0, minWidth: 0 } as const;
const inputStyle = { width: '100%', maxWidth: '100%', boxSizing: 'border-box' } as const;
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 12 } as const;
function Field({ label, children }: { label: string; children: ReactNode }) { return <label style={fieldStyle}>{label} {children}</label>; }

export function JpkFilesPanel({ contextKey, admin }: { contextKey: string; admin: boolean }) {
  const [saved] = useState(() => readSaved(contextKey));
  const [taxpayer, setTaxpayer] = useState<JpkTaxpayer>(saved.taxpayer), [address, setAddress] = useState<JpkAddress>(saved.address);
  const [okres, setOkres] = useState(previousMonth), [range, setRange] = useState(() => monthRange(previousMonth()));
  const [busy, setBusy] = useState<JpkKind | null>(null), [message, setMessage] = useState(''), [error, setError] = useState(''), [refused, setRefused] = useState<Refused[]>([]);

  const heading = <div className="panel-heading"><div><h2>Pliki JPK</h2><p>JPK_V7M, JPK_V7K i JPK_FA z wystawionych dokumentów — plik do pobrania i wysłania samodzielnie.</p></div></div>;
  if (!admin) return <section className="panel" aria-label="Pliki JPK">{heading}<div className="form-body"><p className="notice">Pliki JPK są dostępne dla administratora finansów.</p></div></section>;

  const setT = (patch: Partial<JpkTaxpayer>) => { const next = { ...taxpayer, ...patch }; setTaxpayer(next); writeSaved(contextKey, next, address); };
  const setA = (patch: Partial<JpkAddress>) => { const next = { ...address, ...patch }; setAddress(next); writeSaved(contextKey, taxpayer, next); };
  const text = (k: keyof JpkTaxpayer, extra: Record<string, unknown> = {}) => <input style={inputStyle} value={taxpayer[k]} onChange={e => setT({ [k]: e.target.value } as Partial<JpkTaxpayer>)} {...extra} />;
  const addr = (k: keyof JpkAddress, extra: Record<string, unknown> = {}) => <input style={inputStyle} value={address[k]} onChange={e => setA({ [k]: e.target.value } as Partial<JpkAddress>)} {...extra} />;

  async function run(kind: JpkKind) {
    if (busy) return;
    setMessage(''); setError(''); setRefused([]);
    const period = { okres, ...range };
    const invalid = validateJpk(kind, taxpayer, address, period);
    if (invalid) { setError(invalid); return; }
    setBusy(kind);
    try { setMessage(await downloadJpk(kind, jpkQuery(kind, taxpayer, address, period), contextKey.split(':')[0]!)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Nie udało się pobrać pliku JPK.'); setRefused(e instanceof Refusal ? e.documents : []); }
    finally { setBusy(null); }
  }
  const button = (kind: JpkKind) => <button type="button" className="button" disabled={busy !== null} onClick={() => void run(kind)}>{busy === kind ? `Przygotowanie ${labels[kind]}…` : `Pobierz ${labels[kind]}`}</button>;

  return <section className="panel" aria-label="Pliki JPK">
    {heading}
    <div className="form-body" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <div style={grid}>
        <Field label="Miesiąc"><input type="month" style={inputStyle} value={okres} onChange={e => { setOkres(e.target.value); setRange(monthRange(e.target.value)); }} /></Field>
        <Field label="Od"><input type="date" style={inputStyle} value={range.od} onChange={e => setRange({ ...range, od: e.target.value })} /></Field>
        <Field label="Do"><input type="date" style={inputStyle} value={range.do} onChange={e => setRange({ ...range, do: e.target.value })} /></Field>
      </div>
      <p className="muted" style={{ margin: 0 }}>Miesiąc dotyczy JPK_V7M i JPK_V7K, zakres dat — JPK_FA.</p>
      <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <legend style={{ fontWeight: 700, marginBottom: 8 }}>Dane podatnika</legend>
        <div style={grid}>
          <Field label="Kod urzędu skarbowego">{text('kod_urzedu', { inputMode: 'numeric', maxLength: 4, placeholder: 'np. 1471', required: true })}</Field>
          <Field label="E-mail">{text('email', { type: 'email', placeholder: 'wymagany w JPK_V7' })}</Field>
          <Field label="Telefon">{text('telefon', { type: 'tel', placeholder: 'opcjonalnie' })}</Field>
          <Field label="NIP">{text('nip', { inputMode: 'numeric', placeholder: 'z wystawionych dokumentów' })}</Field>
          <Field label="Pełna nazwa">{text('nazwa', { placeholder: 'z wystawionych dokumentów' })}</Field>
          <Field label="Cel złożenia"><select style={inputStyle} value={taxpayer.cel} onChange={e => setT({ cel: e.target.value as JpkTaxpayer['cel'] })}><option value="1">Złożenie</option><option value="2">Korekta</option></select></Field>
          <Field label="Rodzaj podatnika"><select style={inputStyle} value={taxpayer.osoba} onChange={e => setT({ osoba: e.target.value as JpkTaxpayer['osoba'] })}>
            <option value="niefizyczna">Osoba niefizyczna (spółka)</option><option value="fizyczna">Osoba fizyczna</option></select></Field>
          {taxpayer.osoba === 'fizyczna' && <>
            <Field label="Imię">{text('imie')}</Field>
            <Field label="Nazwisko">{text('nazwisko')}</Field>
            <Field label="Data urodzenia">{text('data_urodzenia', { type: 'date' })}</Field>
          </>}
          <Field label="Nadwyżka z poprzedniej deklaracji (zł)">{text('nadwyzka', { inputMode: 'numeric', placeholder: 'opcjonalnie, tylko JPK_V7' })}</Field>
        </div>
      </fieldset>
      <details style={{ minWidth: 0 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Adres do JPK_FA</summary>
        <div style={{ ...grid, marginTop: 12 }}>
          <Field label="Województwo">{addr('wojewodztwo')}</Field>
          <Field label="Powiat">{addr('powiat')}</Field>
          <Field label="Gmina">{addr('gmina')}</Field>
          <Field label="Ulica">{addr('ulica', { placeholder: 'opcjonalnie' })}</Field>
          <Field label="Nr domu">{addr('nr_domu')}</Field>
          <Field label="Nr lokalu">{addr('nr_lokalu', { placeholder: 'opcjonalnie' })}</Field>
          <Field label="Miejscowość">{addr('miejscowosc')}</Field>
          <Field label="Kod pocztowy">{addr('kod_pocztowy', { placeholder: 'NN-NNN', inputMode: 'numeric', maxLength: 6 })}</Field>
        </div>
      </details>
      <div className="inline-actions" style={{ flexWrap: 'wrap', gap: 12 }}>{button('v7m')}{button('v7k')}{button('fa')}</div>
      <p className="muted" style={{ margin: 0 }}>JPK_V7K zawiera deklarację tylko za ostatni miesiąc kwartału (03, 06, 09, 12). Rejestr zakupów (ZakupWiersz) jest pusty — aplikacja nie prowadzi rejestru zakupów. Pliki nie są nigdzie wysyłane (bez e-Deklaracji i bramki MF).</p>
      {busy && <p role="status">Trwa przygotowanie pliku {labels[busy]}…</p>}
      {message && <p role="status">{message}</p>}
      {error && <div className="notice" role="alert" style={{ display: 'grid', gap: 6, minWidth: 0, overflowWrap: 'anywhere' }}>
        <span>{error}</span>
        {refused.length > 0 && <><strong>Dokumenty, których nie da się ująć w pliku:</strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{refused.map((d, i) => <li key={d.number + i}>{d.number} — {d.reason}</li>)}</ul></>}
      </div>}
    </div>
  </section>;
}
