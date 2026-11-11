import { useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** 229 KSeF in the UI: Ustawienia → KSeF (per-NIP settings with a write-only secret and
 * "Sprawdź połączenie"), the KSeF section of an invoice (status, KSeF number, UPO, offline
 * badge with its deadline and QR codes) and Dokumenty → "Kolejka KSeF" with retry.
 * This local build never connects to the Ministry of Finance: only the local test server. */
export type KsefEnvironment = 'local_fake' | 'test' | 'demo' | 'prod';
export type KsefConfig = { nip: string; environment: KsefEnvironment; base_url: string | null; auth_method: 'token' | 'certificate'; active: boolean;
  secret: { stored: true; masked: string; fingerprint: string }; certificate_serial: string | null; offline_certificate: { serial: string } | null; updated_at: string };
export type KsefQr = { url: string; label: string; svg: string };
export type KsefSubmission = { id: string; document_id: string; document_number: string; nip: string; environment: KsefEnvironment; state: 'queued' | 'sent' | 'accepted' | 'rejected'; state_label: string;
  ksef_number: string | null; acquisition_at: string | null; reference_number: string | null; status: { code: number; description: string; details: string[] } | null; upo_available: boolean;
  attempts: number; last_error: string | null; offline: null | { mode: 'offline24' | 'offline' | 'awaryjny'; reason: string; since: string; deadline: string | null; overdue: boolean; kod1: KsefQr; kod2: KsefQr | null; kod2_note: string | null } };
export type KsefDocumentView = { document_id: string; submission: KsefSubmission | null; rejected: KsefSubmission[] };
export type KsefQueueItem = { id: string; document_id: string; document_number: string; nip: string; state: KsefSubmission['state']; state_label: string; issue_mode: string;
  offline_reason: string | null; deadline: string | null; overdue: boolean; attempts: number; last_error: string | null; status: { code: number; description: string } | null };

export const ENVIRONMENTS: Record<KsefEnvironment, string> = { local_fake: 'Lokalny serwer testowy (bez MF)', test: 'MF — środowisko testowe', demo: 'MF — środowisko przedprodukcyjne (demo)', prod: 'MF — produkcja' };
const MODES: Record<string, string> = { offline24: 'offline24', offline: 'offline — niedostępność KSeF', awaryjny: 'tryb awaryjny', online: 'online' };
export const plDay = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const KSEF_NUMBER = /^[0-9]{10}-[0-9]{8}-[0-9A-F]{12}-[0-9A-F]{2}$/;

/** Checks a document reply before it is shown: it must be about this document and never carry a secret. */
export function readKsefDocument(v: unknown, documentId: string): KsefDocumentView {
  const x = v as KsefDocumentView, s = x?.submission;
  const ok = x && x.document_id === documentId && Array.isArray(x.rejected) && (s === null || (s && s.document_id === documentId && typeof s.state_label === 'string'
    && (s.ksef_number === null || KSEF_NUMBER.test(s.ksef_number)) && (s.state === 'accepted') === (s.ksef_number !== null)
    && (s.offline === null || (typeof s.offline.kod1?.url === 'string' && s.offline.kod1.svg.startsWith('<svg')))));
  if (!ok) throw Error('Niepełny lub obcy stan KSeF faktury. Odśwież widok.');
  return x;
}
async function download(path: string, workspaceId: string, fallback: string) {
  const response = await fetch('/api' + path, { credentials: 'same-origin', headers: { 'X-Workspace-ID': workspaceId } });
  if (!response.ok) { const b = await response.json().catch(() => null) as { detail?: string } | null; throw Error(b?.detail ?? 'Nie udało się pobrać pliku'); }
  const text = await response.text();
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || !text.trimStart().startsWith('<')) throw Error('Serwer zwrócił plik, który nie jest XML');
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? fallback;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/xml;charset=utf-8' })), a = document.createElement('a');
  a.href = url; a.download = name;
  try { document.body.appendChild(a); a.click(); } finally { a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
const svgSrc = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

// ---------- Ustawienia → KSeF ----------
type Form = { nip: string; environment: KsefEnvironment; base_url: string; auth_method: 'token' | 'certificate'; token: string; certificate_pem: string; private_key_pem: string;
  certificate_serial: string; offline_certificate_pem: string; offline_private_key_pem: string; offline_certificate_serial: string; active: boolean };
const blank: Form = { nip: '', environment: 'local_fake', base_url: 'http://127.0.0.1:4239/v2', auth_method: 'token', token: '', certificate_pem: '', private_key_pem: '',
  certificate_serial: '', offline_certificate_pem: '', offline_private_key_pem: '', offline_certificate_serial: '', active: true };
/** PUT body: empty secret fields are left out, so the stored secret is kept. */
export function configBody(f: Form): Record<string, unknown> {
  const b: Record<string, unknown> = { environment: f.environment, auth_method: f.auth_method, active: f.active };
  if (f.environment === 'local_fake') b.base_url = f.base_url.trim();
  for (const k of f.auth_method === 'token' ? ['token'] as const : ['certificate_pem', 'private_key_pem', 'certificate_serial'] as const) if (f[k].trim()) b[k] = f[k].trim();
  for (const k of ['offline_certificate_pem', 'offline_private_key_pem', 'offline_certificate_serial'] as const) if (f[k].trim()) b[k] = f[k].trim();
  return b;
}
type Check = { ok: boolean; problem: string | null; steps: { name: string; ok: boolean; ms: number }[] };

export function KsefSettingsPanel({ admin, readOnly }: { admin: boolean; readOnly: boolean }) {
  const [configs, setConfigs] = useState<KsefConfig[] | null>(null), [error, setError] = useState(''), [unavailable, setUnavailable] = useState(false);
  const [form, setForm] = useState<Form>(blank), [editing, setEditing] = useState<KsefConfig | null>(null), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''), [actionError, setActionError] = useState(''), [check, setCheck] = useState<{ nip: string; result: Check } | null>(null);
  async function load() { const v = await api<{ configs: KsefConfig[] }>('/ksef229/configs'); setConfigs(v.configs); }
  useEffect(() => {
    if (!admin) return;
    load().catch(e => { if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError(message(e, 'Nie udało się odczytać ustawień KSeF')); });
  }, [admin]);
  async function run(f: () => Promise<void>) { if (busy) return; setBusy(true); setActionError(''); setNotice(''); try { await f(); } catch (e) { setActionError(message(e, 'Operacja się nie powiodła')); } finally { setBusy(false); } }
  const edit = (c: KsefConfig) => { setEditing(c); setForm({ ...blank, nip: c.nip, environment: c.environment, base_url: c.base_url ?? '', auth_method: c.auth_method, certificate_serial: c.certificate_serial ?? '', active: c.active }); setCheck(null); };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const canWrite = !readOnly && !busy;
  if (!admin) return <section className="panel"><div className="panel-heading"><h2>KSeF</h2></div><div className="form-body"><p className="muted">Ustawienia KSeF zmienia administrator.</p></div></section>;
  return <section className="panel ksef-settings" aria-label="KSeF">
    <div className="panel-heading"><div><h2>KSeF</h2><p>Połączenie z Krajowym Systemem e-Faktur dla każdego NIP sprzedawcy. Ta wersja działa lokalnie: wysyła wyłącznie do lokalnego serwera testowego, nigdy do Ministerstwa Finansów.</p></div></div>
    <div className="form-body">
    {unavailable && <p className="notice">KSeF (migracja 229) jest niedostępny w tej kopii.</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {configs && (configs.length ? <div className="table-scroll"><table><thead><tr><th>NIP</th><th>Środowisko</th><th>Uwierzytelnienie</th><th>Sekret</th><th>Stan</th><th /></tr></thead><tbody>
      {configs.map(c => <tr key={c.nip}><td>{c.nip}</td><td>{ENVIRONMENTS[c.environment]}{c.base_url && <small>{c.base_url}</small>}</td>
        <td>{c.auth_method === 'token' ? 'Token KSeF' : 'Certyfikat ' + c.certificate_serial}{c.offline_certificate && <small>Certyfikat offline {c.offline_certificate.serial}</small>}</td>
        <td><span aria-label="Sekret zapisany, ukryty">{c.secret.masked}</span><small>odcisk {c.secret.fingerprint}</small></td><td>{c.active ? 'Aktywne' : 'Wyłączone'}</td>
        <td><button type="button" className="text-button" disabled={busy} onClick={() => edit(c)}>Zmień {c.nip}</button>
          <button type="button" className="text-button" disabled={!canWrite} onClick={() => void run(async () => { setCheck({ nip: c.nip, result: await api<Check>(`/ksef229/configs/${c.nip}/check`, 'POST') }); })}>Sprawdź połączenie {c.nip}</button></td></tr>)}
    </tbody></table></div> : <p className="muted">Brak ustawień KSeF. Dodaj NIP sprzedawcy poniżej.</p>)}
    {check && <div className={check.result.ok ? 'notice' : 'notice error'} role="status"><strong>{check.result.ok ? `Połączenie z KSeF dla NIP ${check.nip} działa.` : `Połączenie z KSeF dla NIP ${check.nip} nie działa: ${check.result.problem}`}</strong>
      <ul>{check.result.steps.map(s => <li key={s.name}>{s.ok ? '✓' : '✗'} {s.name} ({s.ms} ms)</li>)}</ul></div>}
    <fieldset className="ksef-form" disabled={!canWrite}><legend>{editing ? `Zmień ustawienia NIP ${editing.nip}` : 'Dodaj NIP'}</legend>
      <label>NIP sprzedawcy<input value={form.nip} maxLength={10} inputMode="numeric" readOnly={Boolean(editing)} onChange={e => set('nip', e.target.value.replace(/\D/g, ''))} /></label>
      <label>Środowisko<select value={form.environment} onChange={e => set('environment', e.target.value as KsefEnvironment)}>{Object.entries(ENVIRONMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      {form.environment === 'local_fake'
        ? <label>Adres lokalnego serwera<input value={form.base_url} onChange={e => set('base_url', e.target.value)} placeholder="http://127.0.0.1:4239/v2" /></label>
        : <p className="notice">Adres środowiska MF jest stały. Połączenie z MF jest wyłączone w tej wersji — ustawienia można zapisać, ale wysyłka i sprawdzenie połączenia zostaną odrzucone.</p>}
      <label>Uwierzytelnienie<select value={form.auth_method} onChange={e => set('auth_method', e.target.value as Form['auth_method'])}><option value="token">Token KSeF</option><option value="certificate">Certyfikat KSeF</option></select></label>
      {form.auth_method === 'token'
        ? <label>Token KSeF<input type="password" autoComplete="off" value={form.token} onChange={e => set('token', e.target.value)} placeholder={editing?.auth_method === 'token' ? 'Zapisany (••••••••) — wpisz nowy, aby zmienić' : ''} /></label>
        : <><label>Certyfikat (PEM)<textarea rows={3} value={form.certificate_pem} onChange={e => set('certificate_pem', e.target.value)} placeholder={editing?.auth_method === 'certificate' ? 'Zapisany — wklej nowy, aby zmienić' : '-----BEGIN CERTIFICATE-----'} /></label>
          <label>Klucz prywatny (PEM)<textarea rows={3} autoComplete="off" value={form.private_key_pem} onChange={e => set('private_key_pem', e.target.value)} placeholder={editing?.auth_method === 'certificate' ? 'Zapisany (••••••••) — wklej nowy, aby zmienić' : '-----BEGIN PRIVATE KEY-----'} /></label>
          <label>Numer seryjny certyfikatu<input value={form.certificate_serial} onChange={e => set('certificate_serial', e.target.value)} /></label></>}
      <details><summary>Certyfikat KSeF typu Offline (KOD II na fakturach offline)</summary>
        <label>Certyfikat offline (PEM)<textarea rows={3} value={form.offline_certificate_pem} onChange={e => set('offline_certificate_pem', e.target.value)} placeholder={editing?.offline_certificate ? 'Zapisany — wklej nowy, aby zmienić' : ''} /></label>
        <label>Klucz prywatny certyfikatu offline (PEM)<textarea rows={3} autoComplete="off" value={form.offline_private_key_pem} onChange={e => set('offline_private_key_pem', e.target.value)} /></label>
        <label>Numer seryjny certyfikatu offline<input value={form.offline_certificate_serial} onChange={e => set('offline_certificate_serial', e.target.value)} /></label></details>
      <label className="ksef-check"><input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />Aktywne — faktury tego NIP można wysyłać</label>
      <div className="ksef-actions">
        <button type="button" className="button primary" disabled={!canWrite || !/^[0-9]{10}$/.test(form.nip)} onClick={() => void run(async () => {
          await api('/ksef229/configs/' + form.nip, 'PUT', configBody(form)); await load(); setNotice(`Zapisano ustawienia KSeF dla NIP ${form.nip}. Sekret jest zaszyfrowany i nie będzie już wyświetlany.`); setEditing(null); setForm(blank);
        })}>Zapisz ustawienia KSeF</button>
        {editing && <button type="button" className="button" onClick={() => { setEditing(null); setForm(blank); }}>Anuluj</button>}
      </div>
    </fieldset>
    {notice && <p role="status" className="notice">{notice}</p>}
    {actionError && <p role="alert" className="notice error">{actionError}</p>}
    </div>
  </section>;
}

// ---------- invoice detail ----------
function OfflineBadge({ s, sent }: { s: NonNullable<KsefSubmission['offline']>; sent: boolean }) {
  if (sent) return <span className="badge ksef-offline">wystawiona w trybie {MODES[s.mode]} · wysłana do KSeF</span>;
  return <span className={'badge ksef-offline' + (s.overdue ? ' overdue' : '')}>{MODES[s.mode]} · {s.deadline ? `wyślij do ${plDay(s.deadline)}${s.overdue ? ' — termin minął' : ''}` : 'termin: 7 dni roboczych po zakończeniu trybu awaryjnego'}</span>;
}
export function KsefDocumentStatus({ documentId, workspaceId, role, readOnly }: { documentId: string; workspaceId: string; role: string; readOnly: boolean }) {
  const [view, setView] = useState<KsefDocumentView | null>(null), [error, setError] = useState(''), [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(''), [actionError, setActionError] = useState(''), [emergencyEnd, setEmergencyEnd] = useState('');
  useEffect(() => {
    let alive = true; setView(null); setError(''); setUnavailable(false);
    api('/ksef229/documents/' + documentId).then(v => { if (alive) setView(readKsefDocument(v, documentId)); })
      .catch(e => { if (!alive) return; if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError(message(e, 'Nie udało się odczytać stanu KSeF')); });
    return () => { alive = false; };
  }, [documentId]);
  async function act(label: string, f: () => Promise<unknown>) {
    if (busy) return; setBusy(label); setActionError('');
    try { const v = await f(); if (v) setView(readKsefDocument(v, documentId)); } catch (e) { setActionError(message(e, 'Operacja KSeF się nie powiodła')); } finally { setBusy(''); }
  }
  if (unavailable) return null;
  const s = view?.submission ?? null, canSend = !readOnly && (role === 'admin' || role === 'operator');
  return <section className="ksef-document" aria-label="KSeF">
    <h5>KSeF</h5>
    {error && <p role="alert" className="notice error">{error}</p>}
    {view && !s && <p>Nie wysłano do KSeF.</p>}
    {s && <div className="ksef-state">
      <p><strong>{s.state_label}</strong>{s.ksef_number && <> · numer KSeF <code>{s.ksef_number}</code></>}{s.offline && <> <OfflineBadge s={s.offline} sent={s.state === 'accepted'} /></>}</p>
      {s.status && <p>Status KSeF {s.status.code}: {s.status.description}{s.status.details.length > 0 && <small> {s.status.details.join('; ')}</small>}</p>}
      {s.acquisition_at && <p>Data nadania numeru: {new Date(s.acquisition_at).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}</p>}
      {s.last_error && s.state !== 'accepted' && <p className="notice">Ostatnia próba: {s.last_error}</p>}
      {s.environment === 'local_fake' && <p><small>Lokalny serwer testowy — numer KSeF i UPO nie mają mocy prawnej.</small></p>}
      {s.offline && <div className="ksef-qr">
        <p>{s.offline.reason}</p>
        <figure><img src={svgSrc(s.offline.kod1.svg)} alt={'KOD I ' + s.offline.kod1.label} width={132} height={132} /><figcaption>{s.offline.kod1.label}</figcaption></figure>
        {s.offline.kod2 ? <figure><img src={svgSrc(s.offline.kod2.svg)} alt="KOD II CERTYFIKAT" width={132} height={132} /><figcaption>{s.offline.kod2.label}</figcaption></figure> : <p><small>{s.offline.kod2_note}</small></p>}
        <p><small>KOD I: <a href={s.offline.kod1.url} target="_blank" rel="noreferrer">{s.offline.kod1.url}</a></small></p>
      </div>}
    </div>}
    <div className="ksef-actions">
      {canSend && (!s || s.state === 'queued') && <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void act('send', () => api(`/ksef229/documents/${documentId}/send`, 'POST'))}>{busy === 'send' ? 'Wysyłanie do KSeF…' : s ? 'Wyślij ponownie do KSeF' : 'Wyślij do KSeF'}</button>}
      {canSend && s?.state === 'sent' && <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void act('refresh', () => api(`/ksef229/documents/${documentId}/refresh`, 'POST'))}>Sprawdź status w KSeF</button>}
      {canSend && s?.state === 'accepted' && !s.upo_available && <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void act('refresh', () => api(`/ksef229/documents/${documentId}/refresh`, 'POST'))}>Pobierz UPO z KSeF</button>}
      {canSend && (!s || (s.state === 'queued' && !s.offline)) && <details className="ksef-offline-choice"><summary>Wystaw w trybie offline</summary>
        <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void act('offline24', () => api(`/ksef229/documents/${documentId}/offline`, 'POST', { mode: 'offline24' }))}>Tryb offline24</button>
        <label>Koniec trybu awaryjnego (z komunikatu MF)<input type="date" value={emergencyEnd} onChange={e => setEmergencyEnd(e.target.value)} /></label>
        <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void act('awaryjny', () => api(`/ksef229/documents/${documentId}/offline`, 'POST', { mode: 'awaryjny', ...(emergencyEnd ? { emergency_end: emergencyEnd } : {}) }))}>Tryb awaryjny</button>
      </details>}
      {s?.upo_available && <button type="button" className="button" onClick={() => void act('upo', async () => { await download(`/ksef229/documents/${documentId}/upo.xml`, workspaceId, 'UPO.xml'); return null; })}>Pobierz UPO</button>}
      {s && <button type="button" className="text-button" onClick={() => void act('xml', async () => { await download(`/ksef229/documents/${documentId}/sent.xml`, workspaceId, 'faktura.xml'); return null; })}>Pobierz plik wysłany do KSeF</button>}
    </div>
    {actionError && <p role="alert" className="notice error">{actionError}</p>}
    {view && view.rejected.length > 0 && <details><summary>Wcześniejsze odrzucenia ({view.rejected.length})</summary><ul>{view.rejected.map(r => <li key={r.id}>{r.status ? `${r.status.code}: ${r.status.description}` : r.state_label}</li>)}</ul></details>}
  </section>;
}

// ---------- Dokumenty → Kolejka KSeF ----------
export function KsefQueuePanel({ role, readOnly }: { role: string; readOnly: boolean }) {
  const [items, setItems] = useState<KsefQueueItem[] | null>(null), [error, setError] = useState(''), [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [actionError, setActionError] = useState('');
  async function load() { setItems((await api<{ items: KsefQueueItem[] }>('/ksef229/queue')).items); }
  useEffect(() => { load().catch(e => { if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError(message(e, 'Nie udało się odczytać kolejki KSeF')); }); }, []);
  async function send(ids?: string[]) {
    if (busy) return; setBusy(true); setNotice(''); setActionError('');
    try {
      const r = await api<{ attempted: number; accepted: number; results: { ok: boolean; message: string | null }[] }>('/ksef229/queue/send', 'POST', ids ? { ids } : {});
      const failed = r.results.filter(x => !x.ok && x.message).map(x => x.message);
      setNotice(`Wysłano ${r.attempted}, przyjęto w KSeF ${r.accepted}.${failed.length ? ' ' + failed.join(' ') : ''}`); await load();
    } catch (e) { setActionError(message(e, 'Wysyłka kolejki KSeF się nie powiodła')); } finally { setBusy(false); }
  }
  if (unavailable) return null;
  const canSend = !readOnly && (role === 'admin' || role === 'operator'), pending = items?.filter(i => i.state === 'queued' || i.state === 'sent') ?? [];
  return <section className="panel ksef-queue" aria-label="Kolejka KSeF">
    <div className="panel-heading"><div><h2>Kolejka KSeF</h2><p>Faktury do wysłania do KSeF: wystawione w trybie offline, czekające na status albo odrzucone.</p></div>{canSend && pending.length > 0 && <button type="button" className="button primary" disabled={busy} onClick={() => void send()}>{busy ? 'Wysyłanie…' : `Wyślij wszystkie (${pending.length})`}</button>}</div>
    <div className="form-body">
    {error && <p role="alert" className="notice error">{error}</p>}
    {items && !items.length && <p className="muted">Kolejka jest pusta.</p>}
    {items && items.length > 0 && <div className="table-scroll"><table><thead><tr><th>Faktura</th><th>Stan</th><th>Tryb</th><th>Termin wysyłki</th><th>Próby</th><th /></tr></thead><tbody>
      {items.map(i => <tr key={i.id}><td>{i.document_number}<small>NIP {i.nip}</small></td><td>{i.state_label}{i.status && <small>{i.status.code}: {i.status.description}</small>}{i.last_error && <small>{i.last_error}</small>}</td>
        <td>{MODES[i.issue_mode] ?? i.issue_mode}</td><td className={i.overdue ? 'ksef-overdue' : ''}>{i.deadline ? plDay(i.deadline) + (i.overdue ? ' — termin minął' : '') : i.issue_mode === 'online' ? '—' : 'po trybie awaryjnym'}</td><td>{i.attempts}</td>
        <td>{canSend && i.state !== 'rejected' && <button type="button" className="text-button" disabled={busy} onClick={() => void send([i.id])}>Ponów {i.document_number}</button>}</td></tr>)}
    </tbody></table></div>}
    {notice && <p role="status" className="notice">{notice}</p>}
    {actionError && <p role="alert" className="notice error">{actionError}</p>}
    </div>
  </section>;
}
