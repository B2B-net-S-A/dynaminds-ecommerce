import { useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** 228 RODO in the UI: the customer card section (data export, anonymisation preview and
 * confirmation) and the RODO page (access register, fields due for anonymisation, requests,
 * a customer by e-mail or phone without a CRM card, register retention). Administrator only. */
export type RodoSubject = { crm_client_id: string } | { email: string } | { phone: string };
export type PlanItem = { table: string; row: string; order_id?: string; fields: string[] };
export type KeptItem = PlanItem & { basis: 'tax_retention' | 'immutable_evidence'; legal_basis: string; retention_end: string; due_on: string; reason: string };
export type Plan = { today: string; crm_client_ids: string[]; orders: { id: string; number: string; tax_retention_end: string | null }[]; anonymise: PlanItem[]; keep: KeptItem[] };
export type Preview = { request_id: string; state: 'previewed'; plan_sha256: string; plan: Plan };

const TABLES: Record<string, string> = {
  orders: 'Zamówienie', crm_clients: 'Profil klienta CRM', crm_values: 'Pola dodatkowe CRM (zgody, notatki)', crm_files: 'Załącznik CRM', crm_commands: 'Dziennik poleceń CRM',
  documents: 'Faktura lub korekta', inbound_orders: 'Zamówienie pobrane z kanału', webhook_deliveries: 'Powiadomienie z kanału', idempotency_keys: 'Odpowiedź API (powtórzenia)',
  audit_events: 'Historia operacji', shipping_plans: 'Plan wysyłki', invoice_plans: 'Plan faktury', shipments: 'Przesyłka', order_events: 'Zdarzenie zamówienia', return_cases: 'Zwrot',
  shopify_dispatch_evidence: 'Dowód wysyłki Shopify', return_assistant_sessions: 'Sesja asystenta zwrotów', payment_entries: 'Wpłata', customer_messages: 'Wiadomość w portalu',
  email_messages: 'Wysłany e-mail', sms_messages: 'Wysłany SMS', buyer_address_state: 'Zmieniony adres dostawy', buyer_address_receipts: 'Potwierdzenie zmiany adresu',
  buyer_address_previews: 'Podgląd zmiany adresu', operative_delivery_evidence: 'Dowód adresu doręczenia', order_merge_origins: 'Zamówienie przed połączeniem', wms_operations: 'Operacja magazynowa',
  return_destination_admissions: 'Przyjęcie zwrotu', warehouse_wz_issuer_admissions: 'Wydanie WZ', local_invoice_previews: 'Podgląd faktury', local_invoice_receipts: 'Potwierdzenie wystawienia faktury',
  b2b_invoice_previews: 'Podgląd faktury B2B', b2b_invoice_receipts: 'Potwierdzenie faktury B2B', b2b_credit_previews: 'Podgląd korekty B2B', b2b_credit_receipts: 'Potwierdzenie korekty B2B',
  return_credit206_documents: 'Korekta do zwrotu', return_credit206_previews: 'Podgląd korekty do zwrotu', return_credit206_receipts: 'Potwierdzenie korekty do zwrotu',
  local_consumer_credit_documents: 'Korekta konsumencka', local_consumer_credit_previews: 'Podgląd korekty konsumenckiej', local_consumer_credit_receipts: 'Potwierdzenie korekty konsumenckiej',
  fa3_draft_projects: 'Projekt FA(3)', fa3_draft_previews: 'Podgląd projektu FA(3)',
  invoice230_previews: 'Podgląd faktury FV-S', invoice230_documents: 'Faktura FV-S (B2B, EUR, ZW/NP/OO/OSS)', invoice232_previews: 'Podgląd korekty KOR-S', invoice232_corrections: 'Korekta KOR-S faktury FV-S', receipt233_receipts: 'Paragon fiskalny', ksef229_submissions: 'Plik faktury wysłany do KSeF',
};
const FIELDS: Record<string, string> = {
  customer_name: 'imię i nazwisko', email: 'e-mail', note: 'uwagi', 'address.street': 'ulica', 'address.city': 'miasto', 'address.postal_code': 'kod pocztowy',
  'address.country': 'kraj', 'address.phone': 'telefon', source_snapshot: 'dane źródłowe', b2b_snapshot: 'dane B2B',
  raw: 'dane z kanału', normalized: 'dane znormalizowane', payload: 'treść', order_snapshot: 'kopia zamówienia', input: 'dane wejściowe', result: 'wynik',
  detail: 'szczegóły', tracking_data: 'dane śledzenia', request: 'żądanie', receipt: 'potwierdzenie', response: 'odpowiedź', header: 'dane zamówienia',
  receiver: 'odbiorca', source: 'źródło', body: 'treść', snapshot: 'kopia danych', recipient: 'odbiorca', reference: 'tytuł', reason: 'powód',
  decision_note: 'notatka decyzji', evidence_encrypted: 'dowód (zaszyfrowany)', before_state: 'stan przed', after_state: 'stan po', before_snapshot: 'stan przed',
  delivery_override_encrypted: 'adres dostawy (zaszyfrowany)', title: 'nazwa pliku', encrypted_bytes: 'treść pliku', frame: 'dane wydania',
  buyer_tax_id: 'NIP / numer VAT UE nabywcy', 'snapshot.buyer': 'dane nabywcy', xml: 'plik FA(3)', upo_xml: 'UPO',
};
const ACTIONS: Record<string, string> = { read: 'Odczyt', list: 'Lista', export: 'Eksport', anonymisation_preview: 'Podgląd anonimizacji', anonymisation: 'Anonimizacja' };
export const tableLabel = (t: string) => TABLES[t] ?? t;
export const fieldLabel = (f: string) => FIELDS[f] ?? (f.startsWith('profile.') ? 'profil: ' + f.slice(8).replace(/_/g, ' ') : f.startsWith('field:') ? 'pole dodatkowe' : f);
export const plDay = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const plTime = (t: string) => new Date(t).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });
const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const query = (s: RodoSubject) => new URLSearchParams(Object.entries(s) as [string, string][]).toString();

/** Groups plan rows by table and fields, so a page shows "Zamówienie (2): e-mail, telefon". */
export function summarise<T extends PlanItem>(items: T[], key: (i: T) => string = i => i.table + '|' + i.fields.join(',')) {
  const groups = new Map<string, { item: T; count: number }>();
  for (const i of items) { const k = key(i), g = groups.get(k); if (g) g.count++; else groups.set(k, { item: i, count: 1 }); }
  return [...groups.values()];
}
/** Checks a preview reply before it is shown or confirmed. */
export function readPreview(v: unknown): Preview {
  const p = v as any, ok = p && typeof p.request_id === 'string' && p.state === 'previewed' && /^[a-f0-9]{64}$/.test(p.plan_sha256 ?? '') && p.plan
    && Array.isArray(p.plan.anonymise) && Array.isArray(p.plan.keep) && Array.isArray(p.plan.orders)
    && p.plan.keep.every((k: any) => /^\d{4}-\d{2}-\d{2}$/.test(k.retention_end) && /^\d{4}-\d{2}-\d{2}$/.test(k.due_on) && typeof k.legal_basis === 'string');
  if (!ok) throw Error('Niepełny podgląd anonimizacji. Odśwież widok.');
  return p;
}

/** Result of the last anonymisation per customer, shown again when the card reloads after it. */
const completed = new Map<string, { anonymised: number; kept: number }>();
async function download(tenantId: string, s: RodoSubject, purpose: string) {
  const r = await fetch('/api/rodo228/export?' + query(s) + (purpose.trim() ? '&purpose=' + encodeURIComponent(purpose.trim()) : ''),
    { credentials: 'same-origin', headers: { 'X-Workspace-ID': tenantId } });
  if (!r.ok) { let m = 'Nie udało się przygotować eksportu danych.'; try { const d = await r.json(); m = d.detail ?? d.error ?? m; } catch { /* reply without JSON */ } throw new ApiError(m, r.status); }
  const blob = await r.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') ?? '')?.[1] ?? 'dane-klienta.zip';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Export and anonymisation of one customer: on the CRM card or for an e-mail/phone. */
export function RodoCustomerPanel({ subject, tenantId, admin, readOnly, onChanged, title = 'Dane osobowe (RODO)' }:
  { subject: RodoSubject; tenantId: string; admin: boolean; readOnly: boolean; onChanged?: () => void; title?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [info, setInfo] = useState(''), [purpose, setPurpose] = useState('');
  const key = query(subject);
  const [preview, setPreview] = useState<Preview | null>(null), [agreed, setAgreed] = useState(false), [done, setDone] = useState<{ anonymised: number; kept: number } | null>(completed.get(key) ?? null);
  useEffect(() => { setPreview(null); setDone(completed.get(key) ?? null); setError(''); setInfo(''); setAgreed(false); }, [key]);
  if (!admin) return <section className="catalog-section" aria-label={title}><h3>{title}</h3><p className="muted">Eksport i anonimizacja danych klienta są dostępne dla administratora.</p></section>;
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); setInfo(''); try { await work(); } catch (e) { setError(message(e, 'Operacja RODO nie powiodła się.')); } finally { setBusy(false); } };
  return <section className="catalog-section" aria-label={title} style={{ display: 'grid', gap: 12 }}>
    <h3 style={{ margin: 0 }}>{title}</h3>
    <p className="muted" style={{ margin: 0 }}>Każdy eksport i anonimizacja zapisują się w rejestrze dostępu do danych osobowych.</p>
    <div className="inline-actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
      <label style={{ minWidth: 260 }}>Cel eksportu <input value={purpose} maxLength={160} placeholder="Wniosek klienta o dostęp do danych (art. 15 i 20 RODO)" onChange={e => setPurpose(e.target.value)} /></label>
      <button type="button" className="button" disabled={busy || readOnly} onClick={() => void run(async () => { await download(tenantId, subject, purpose); setInfo('Pobrano archiwum ZIP z plikami JSON i CSV.'); })}>Pobierz dane klienta (JSON + CSV)</button>
      <button type="button" className="button" disabled={busy || readOnly} onClick={() => void run(async () => {
        completed.delete(key); setDone(null); setAgreed(false); setPreview(readPreview(await api('/rodo228/anonymisation/preview', 'POST', subject)));
      })}>Przygotuj anonimizację</button>
    </div>
    {readOnly && <p className="muted" style={{ margin: 0 }}>Ta kopia jest tylko do odczytu — eksport i anonimizacja są wyłączone.</p>}
    {info && <p role="status" style={{ margin: 0 }}>{info}</p>}
    {error && <p className="notice" role="alert" style={{ margin: 0 }}>{error}</p>}
    {preview && !done && <PreviewView preview={preview} />}
    {preview && !done && <div className="inline-actions" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />Rozumiem, że anonimizacji nie można cofnąć</label>
      <button type="button" className="button danger" disabled={busy || readOnly || !agreed} onClick={() => void run(async () => {
        const r = await api(`/rodo228/anonymisation/${preview.request_id}/confirm`, 'POST', { plan_sha256: preview.plan_sha256 });
        const result = { anonymised: Number(r.result?.anonymised ?? 0), kept: Number(r.result?.kept ?? 0) };
        completed.set(key, result); setDone(result); onChanged?.();
      })}>Zanonimizuj dane klienta</button>
      <button type="button" className="button subtle" disabled={busy} onClick={() => setPreview(null)}>Anuluj</button>
    </div>}
    {done && <p role="status" style={{ margin: 0 }}><strong>Dane klienta zanonimizowano.</strong> Zmienione zapisy: {done.anonymised}. Zachowane do terminu: {done.kept} — są na liście „Do anonimizacji po terminie” w module RODO.</p>}
  </section>;
}

function PreviewView({ preview }: { preview: Preview }) {
  const p = preview.plan, orders = new Map(p.orders.map(o => [o.id, o.number]));
  const anon = summarise(p.anonymise), keep = summarise(p.keep, i => [i.table, i.fields.join(','), i.basis, i.retention_end, i.reason].join('|'));
  return <div style={{ display: 'grid', gap: 12 }} aria-label="Podgląd anonimizacji">
    <p style={{ margin: 0 }}>Zamówienia klienta: {p.orders.map(o => o.number).join(', ') || 'brak'}{p.crm_client_ids.length ? ` · profile CRM: ${p.crm_client_ids.length}` : ''}.</p>
    <h4 style={{ margin: 0 }}>Zostanie zanonimizowane</h4>
    {!anon.length ? <p className="muted" style={{ margin: 0 }}>Nic — dane zostały już zanonimizowane albo są chronione.</p> : <div className="table-scroll"><table>
      <thead><tr><th>Miejsce</th><th>Zapisy</th><th>Dane</th></tr></thead>
      <tbody>{anon.map(({ item, count }) => <tr key={item.table + item.fields.join()}><td>{tableLabel(item.table)}</td><td>{count}</td><td>{item.fields.map(fieldLabel).join(', ')}</td></tr>)}</tbody></table></div>}
    <h4 style={{ margin: 0 }}>Zostanie zachowane</h4>
    {!keep.length ? <p className="muted" style={{ margin: 0 }}>Nic.</p> : <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 10 }} aria-label="Zachowane dane">
      {keep.map(({ item, count }) => <li key={[item.table, item.fields.join(), item.basis, item.retention_end, item.reason].join('|')} style={{ lineHeight: 1.5 }}>
        <strong>{tableLabel(item.table)}{item.order_id && orders.get(item.order_id) ? ' ' + orders.get(item.order_id) : ''}</strong>{count > 1 ? ` (${count} zapisy)` : ''}: {item.fields.map(fieldLabel).join(', ')}<br />
        {item.basis === 'tax_retention' ? 'Przepisy podatkowe' : 'Zapis dowodowy'} · przechowywane do <strong>{plDay(item.retention_end)}</strong> · anonimizacja od <strong>{plDay(item.due_on)}</strong><br />
        <span className="muted">{item.reason}. Podstawa: {item.legal_basis}</span>
      </li>)}</ul>}
  </div>;
}

type AccessRow = { id: string; accessed_at: string; actor: string | null; actor_id: string; api_key: string | null; channel: 'session' | 'api'; action: string; purpose: string; resource: string; crm_client_id: string | null; order_count: number };
type Retained = { request_id: string; item_no: number; source_table: string; row_ref: string; order_number: string | null; fields: string[]; basis: string; retention_end: string; due_on: string; overdue: boolean };
type Request = { id: string; state: string; orders: number; crm_client_ids: string[]; requested_at: string; completed_at: string | null; anonymise_count: number; keep_count: number };

/** RODO page: register, due list, requests, customer without a CRM card, retention. */
export function RodoPage({ tenantId, admin, readOnly }: { tenantId: string; admin: boolean; readOnly: boolean }) {
  const [tab, setTab] = useState<'log' | 'due' | 'requests' | 'customer' | 'settings'>('log'), [unavailable, setUnavailable] = useState(false), [error, setError] = useState('');
  const [filters, setFilters] = useState({ email: '', phone: '', crm_client_id: '', action: '', from: '', to: '' }), [log, setLog] = useState<{ data: AccessRow[]; next: string | null } | null>(null);
  const [due, setDue] = useState<{ today: string; data: Retained[] } | null>(null), [onlyDue, setOnlyDue] = useState(true), [requests, setRequests] = useState<Request[] | null>(null);
  const [retention, setRetention] = useState(''), [saved, setSaved] = useState(''), [busy, setBusy] = useState(false), [lookup, setLookup] = useState(''), [subject, setSubject] = useState<RodoSubject | null>(null);
  const fail = (e: unknown) => { if (e instanceof ApiError && e.status === 503) setUnavailable(true); else setError(message(e, 'Nie udało się odczytać danych RODO.')); };
  async function loadLog(before?: string) {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v.trim()) as [string, string][]);
    if (before) q.set('before', before);
    const r = await api('/rodo228/access-log?' + q.toString());
    setLog(before && log ? { data: [...log.data, ...r.data], next: r.next } : r);
  }
  useEffect(() => {
    if (!admin) return;
    setError('');
    const work = tab === 'log' ? loadLog() : tab === 'due' ? api('/rodo228/retained?due=' + (onlyDue ? '1' : '0')).then(setDue)
      : tab === 'requests' ? api('/rodo228/requests').then(r => setRequests(r.data)) : tab === 'settings' ? api('/rodo228/status').then(r => setRetention(String(r.settings.access_log_retention_days))) : Promise.resolve();
    work.catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, onlyDue, admin]);
  if (!admin) return <section className="panel"><div className="form-body"><p className="muted">Moduł RODO jest dostępny dla administratora organizacji.</p></div></section>;
  const tabs = [['log', 'Rejestr dostępu'], ['due', 'Do anonimizacji po terminie'], ['requests', 'Wnioski o anonimizację'], ['customer', 'Klient bez karty CRM'], ['settings', 'Retencja rejestru']] as const;
  return <section className="panel" aria-label="RODO">
    <div className="panel-heading"><div><h2>RODO — dane osobowe klientów</h2><p>Kto i kiedy odczytał lub wyeksportował dane klienta, dane zachowane do upływu terminu i anonimizacja klientów bez karty CRM.</p></div></div>
    <div className="form-body" style={{ display: 'grid', gap: 16 }}>
      <div className="inline-actions" role="tablist" style={{ flexWrap: 'wrap', gap: 8 }}>
        {tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={'button' + (tab === id ? ' primary' : '')} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {unavailable && <p className="muted">Narzędzia RODO (migracja 228) są niedostępne w tej kopii.</p>}
      {error && <p className="notice" role="alert">{error}</p>}
      {tab === 'log' && <div style={{ display: 'grid', gap: 12 }}>
        <form className="inline-actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }} onSubmit={e => { e.preventDefault(); setError(''); loadLog().catch(fail); }}>
          <label>E-mail klienta <input type="email" value={filters.email} onChange={e => setFilters({ ...filters, email: e.target.value })} /></label>
          <label>Telefon <input value={filters.phone} onChange={e => setFilters({ ...filters, phone: e.target.value })} /></label>
          <label>Id klienta CRM <input value={filters.crm_client_id} onChange={e => setFilters({ ...filters, crm_client_id: e.target.value.trim() })} /></label>
          <label>Czynność <select value={filters.action} onChange={e => setFilters({ ...filters, action: e.target.value })}><option value="">wszystkie</option>{Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Od <input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label>
          <label>Do <input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label>
          <button className="button">Filtruj</button>
        </form>
        {!log ? <p role="status">Odczytywanie rejestru…</p> : !log.data.length ? <p className="muted">Brak wpisów dla tych filtrów.</p> : <div className="table-scroll"><table>
          <thead><tr><th>Data</th><th>Kto</th><th>Kanał</th><th>Czynność</th><th>Cel</th><th>Klient CRM</th><th>Zamówienia</th></tr></thead>
          <tbody>{log.data.map(r => <tr key={r.id}><td>{plTime(r.accessed_at)}</td><td>{r.actor ?? r.actor_id.slice(0, 8)}{r.api_key ? <><br /><span className="muted">klucz {r.api_key}</span></> : null}</td>
            <td>{r.channel === 'api' ? 'API' : 'Panel'}</td><td>{ACTIONS[r.action] ?? r.action}<br /><span className="muted">{r.resource}</span></td><td>{r.purpose}</td>
            <td>{r.crm_client_id ? r.crm_client_id.slice(0, 8) : '—'}</td><td>{r.order_count}</td></tr>)}</tbody></table></div>}
        {log?.next && <button type="button" className="button subtle" onClick={() => void loadLog(log.next!).catch(fail)}>Pokaż starsze</button>}
      </div>}
      {tab === 'due' && <div style={{ display: 'grid', gap: 12 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={onlyDue} onChange={e => setOnlyDue(e.target.checked)} />Tylko po terminie (do anonimizacji teraz)</label>
        <p className="muted" style={{ margin: 0 }}>Dane zachowane przy anonimizacji z powodu przepisów podatkowych albo niezmiennych zapisów dowodowych. Od dnia „Anonimizacja od” nie ma już podstawy do ich przechowywania.</p>
        {!due ? <p role="status">Odczytywanie…</p> : !due.data.length ? <p className="muted">{onlyDue ? `Na dzień ${plDay(due.today)} nic nie czeka na anonimizację po terminie.` : 'Brak zachowanych danych.'}</p> : <div className="table-scroll"><table>
          <thead><tr><th>Miejsce</th><th>Zamówienie</th><th>Dane</th><th>Podstawa</th><th>Przechowywane do</th><th>Anonimizacja od</th></tr></thead>
          <tbody>{due.data.map(r => <tr key={r.request_id + r.item_no}><td>{tableLabel(r.source_table)}</td><td>{r.order_number ?? '—'}</td><td>{r.fields.map(fieldLabel).join(', ')}</td>
            <td>{r.basis === 'tax_retention' ? 'Przepisy podatkowe' : 'Zapis dowodowy'}</td><td>{plDay(r.retention_end)}</td><td>{r.overdue ? <strong>{plDay(r.due_on)} — po terminie</strong> : plDay(r.due_on)}</td></tr>)}</tbody></table></div>}
      </div>}
      {tab === 'requests' && (!requests ? <p role="status">Odczytywanie…</p> : !requests.length ? <p className="muted">Brak wniosków o anonimizację.</p> : <div className="table-scroll"><table>
        <thead><tr><th>Utworzono</th><th>Stan</th><th>Zamówienia</th><th>Profile CRM</th><th>Do anonimizacji</th><th>Zachowane</th><th>Wykonano</th></tr></thead>
        <tbody>{requests.map(r => <tr key={r.id}><td>{plTime(r.requested_at)}</td><td>{r.state === 'completed' ? 'Wykonany' : 'Podgląd'}</td><td>{r.orders}</td><td>{r.crm_client_ids.length}</td>
          <td>{r.anonymise_count}</td><td>{r.keep_count}</td><td>{r.completed_at ? plTime(r.completed_at) : '—'}</td></tr>)}</tbody></table></div>)}
      {tab === 'customer' && <div style={{ display: 'grid', gap: 12 }}>
        <form className="inline-actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }} onSubmit={e => {
          e.preventDefault(); const v = lookup.trim(); setSubject(v ? (v.includes('@') ? { email: v.toLowerCase() } : { phone: v }) : null);
        }}>
          <label style={{ minWidth: 280 }}>E-mail albo telefon klienta <input value={lookup} onChange={e => setLookup(e.target.value)} placeholder="np. jan@example.com albo 500 600 700" /></label>
          <button className="button">Wybierz klienta</button>
        </form>
        {subject && <RodoCustomerPanel subject={subject} tenantId={tenantId} admin={admin} readOnly={readOnly} title={'Klient ' + ('email' in subject ? subject.email : 'phone' in subject ? subject.phone : '')} />}
      </div>}
      {tab === 'settings' && <form style={{ display: 'grid', gap: 12, maxWidth: 520 }} onSubmit={e => {
        e.preventDefault(); setBusy(true); setSaved(''); setError('');
        api('/rodo228/settings', 'PUT', { access_log_retention_days: Number(retention) }).then(r => { setRetention(String(r.settings.access_log_retention_days)); setSaved('Zapisano retencję rejestru.'); }).catch(fail).finally(() => setBusy(false));
      }}>
        <label>Przechowuj wpisy rejestru dostępu (dni, 180–3650) <input type="number" min={180} max={3650} required value={retention} onChange={e => setRetention(e.target.value)} /></label>
        <div className="inline-actions" style={{ gap: 12 }}>
          <button className="button" disabled={busy || readOnly}>Zapisz</button>
          <button type="button" className="button subtle" disabled={busy || readOnly} onClick={() => { setBusy(true); setSaved(''); api('/rodo228/access-log/purge', 'POST').then(r => setSaved(`Usunięto wpisy starsze niż retencja: ${r.deleted}.`)).catch(fail).finally(() => setBusy(false)); }}>Usuń wpisy po retencji</button>
        </div>
        {saved && <p role="status">{saved}</p>}
      </form>}
    </div>
  </section>;
}
