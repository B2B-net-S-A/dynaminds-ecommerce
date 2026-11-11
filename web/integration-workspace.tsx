import { useEffect, useRef, useState } from 'react';
import { api, date } from './api';

type Channel = { id: string; name: string; provider: string };
type Run = { id: string; operation: string; status: string; created_at: string; scope: 'read_only' | null };
type Page = { channel: Channel; data: Run[]; next: string | null };
type Props = { tenantId: string; userId: string; contextKey: string; refresh: number; recentRuns: unknown[] };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
function cursor(v: unknown): v is string | null { return v === null || text(v, 500); }
function channel(v: any): Channel {
  if (!uuid(v?.id) || !text(v.name, 200) || !text(v.provider, 100)) throw Error('Invalid channel');
  return { id: v.id, name: v.name, provider: v.provider };
}
function run(v: any): Run {
  if (!uuid(v?.id) || !text(v.operation, 100) || !text(v.status, 100) || !text(v.created_at, 40)
    || !Number.isFinite(Date.parse(v.created_at)) || (v.scope !== null && v.scope !== 'read_only')) throw Error('Invalid history');
  return { id: v.id, operation: v.operation, status: v.status, created_at: v.created_at, scope: v.scope };
}
const resultNames: Record<string, string> = { success: 'Powodzenie', ok: 'Powodzenie', done: 'Zakończono',
  error: 'Błąd', failed: 'Niepowodzenie', verified_read: 'Odczyt zweryfikowany', authorized_read: 'Odczyt autoryzowany',
  simulation: 'Symulacja', pending: 'Oczekuje', page_done: 'Strona zakończona', not_verified: 'Niezweryfikowane' };
const operationNames: Record<string, string> = { verify: 'Weryfikacja połączenia', verification: 'Weryfikacja połączenia',
  connection: 'Sprawdzenie połączenia', preview: 'Podgląd', sync: 'Synchronizacja', 'offer.write': 'Zapis oferty',
  'webhook.stage': 'Przyjęcie źródła zamówienia', 'orders.stage': 'Przyjęcie źródeł zamówień',
  'orders.sync': 'Synchronizacja zamówień', 'order.status.write': 'Przekazanie statusu' };
function RunTable({ rows }: { rows: Run[] }) {
  return <div className="table-scroll"><table><thead><tr><th>Data</th><th>Operacja</th><th>Wynik</th><th>Zakres</th></tr></thead>
    <tbody>{rows.map(r => <tr key={r.id}><td>{date(r.created_at)}</td><td>{operationNames[r.operation] ?? 'Sprawdzenie integracji'}</td>
      <td>{resultNames[r.status] ?? 'Inny wynik'}</td><td>{r.scope === 'read_only' ? 'Tylko odczyt' : '—'}</td></tr>)}</tbody></table></div>;
}

export function IntegrationVerificationHistory(p: Props) {
  // A principal change remounts the owned reader even when the tenant is unchanged.
  return <HistoryBody key={p.tenantId + ':' + p.userId + ':' + p.contextKey} {...p} />;
}
function HistoryBody(p: Props) {
  const alive = useRef(true), channelFlight = useRef(false), channelEpoch = useRef(0);
  const channelAbort = useRef<AbortController | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]), [channelNext, setChannelNext] = useState<string | null>(null);
  const [channelsBusy, setChannelsBusy] = useState(false), [channelsError, setChannelsError] = useState('');
  const [selected, setSelected] = useState(''), [cursors, setCursors] = useState<string[]>(['']);
  const [page, setPage] = useState<{ key: string; value: Page } | null>(null), [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false), [reload, setReload] = useState(0);
  const tail = cursors.at(-1) ?? '', pageKey = selected + ':' + tail;
  const visiblePage = page?.key === pageKey ? page.value : null;
  useEffect(() => { alive.current = true; return () => { alive.current = false; channelEpoch.current++; channelAbort.current?.abort(); }; }, []);

  async function loadChannels(after: string | null = null, reset = false) {
    if (channelFlight.current && !reset) return;
    if (reset) channelAbort.current?.abort();
    const epoch = ++channelEpoch.current, abort = new AbortController();
    channelAbort.current = abort; channelFlight.current = true; setChannelsBusy(true); setChannelsError('');
    if (reset) { setChannels([]); setChannelNext(null); setSelected(''); setCursors(['']); }
    try {
      const q = new URLSearchParams({ limit: '25' }); if (after) q.set('after', after);
      const v = await api<any>('/integrations/connections?' + q, 'GET', undefined, { 'X-Workspace-ID': p.tenantId }, abort.signal);
      if (!Array.isArray(v?.data) || v.data.length > 25 || !cursor(v.next) || (after && v.next === after)) throw Error('Invalid page');
      const rows = v.data.map(channel); if (new Set(rows.map((r: Channel) => r.id)).size !== rows.length) throw Error('Duplicate channel');
      if (!alive.current || epoch !== channelEpoch.current) return;
      setChannels(old => reset ? rows : [...old, ...rows.filter((r: Channel) => !old.some(c => c.id === r.id))]);
      setChannelNext(v.next);
    } catch {
      if (alive.current && epoch === channelEpoch.current && !abort.signal.aborted)
        setChannelsError('Nie udało się odczytać połączeń. Spróbuj ponownie odczytać listę.');
    } finally {
      if (alive.current && epoch === channelEpoch.current) { channelFlight.current = false; setChannelsBusy(false); }
    }
  }
  useEffect(() => { void loadChannels(null, true); }, [p.refresh]);
  useEffect(() => {
    let active = true; const abort = new AbortController();
    setPage(null); setHistoryError(''); setHistoryBusy(Boolean(selected));
    if (!selected) return () => { active = false; abort.abort(); };
    const q = new URLSearchParams({ limit: '25' }); if (tail) q.set('after', tail);
    void api<any>('/integrations/' + selected + '/verification-history?' + q, 'GET', undefined,
      { 'X-Workspace-ID': p.tenantId }, abort.signal).then(v => {
        const ownChannel = channel(v?.channel);
        if (ownChannel.id !== selected || !Array.isArray(v.data) || v.data.length > 25 || !cursor(v.next) || (v.next !== null && cursors.includes(v.next))) throw Error('Invalid history page');
        const rows = v.data.map(run); if (new Set(rows.map((r: Run) => r.id)).size !== rows.length) throw Error('Duplicate run');
        if (active && alive.current) setPage({ key: pageKey, value: { channel: ownChannel, data: rows, next: v.next } });
      }).catch(() => {
        if (active && alive.current && !abort.signal.aborted) setHistoryError('Nie udało się odczytać historii tego połączenia. Ponów wyłącznie odczyt.');
      }).finally(() => { if (active && alive.current) setHistoryBusy(false); });
    return () => { active = false; abort.abort(); };
  }, [selected, tail, reload]);
  const recent: Run[] = [];
  for (const v of p.recentRuns.slice(0, 30) as any[]) {
    try { recent.push(run({ ...v, scope: v?.detail?.scope === 'read_only' ? 'read_only' : null })); } catch { /* No raw detail/error fallback. */ }
  }
  return <section className="panel integration-verification-history">
    <div className="panel-heading"><h2>Historia weryfikacji</h2><p>Ostatnie sprawdzenia firmy oraz starsza historia wybranego połączenia. Odczyt nie kontaktuje się z dostawcą.</p></div>
    <div className="integration-filters"><label>Połączenie — starsza historia<select value={selected} disabled={channelsBusy}
      onChange={e => { setSelected(e.target.value); setCursors(['']); }}><option value="">Ostatnie 30 sprawdzeń firmy</option>
      {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <button className="button small-btn" type="button" disabled={channelsBusy} onClick={() => void loadChannels(null, true)}>Odśwież połączenia</button>
      {channelNext && <button className="button small-btn" type="button" disabled={channelsBusy} onClick={() => void loadChannels(channelNext)}>Pokaż więcej połączeń</button>}
    </div>
    {channelsError && <p className="notice" role="alert">{channelsError}</p>}
    {channelsBusy && <p className="info-body" role="status">Odczyt połączeń…</p>}
    {!selected ? <><RunTable rows={recent} />{!recent.length && <p className="info-body">Brak zapisanych sprawdzeń firmy.</p>}</>
      : <><div className="integration-history-heading"><h3>{visiblePage?.channel.name ?? channels.find(c => c.id === selected)?.name}</h3>
        <button className="button small-btn" type="button" disabled={historyBusy} onClick={() => { setCursors(['']); setReload(v => v + 1); }}>Odśwież historię</button></div>
        {historyBusy && <p className="info-body" role="status">Odczyt historii…</p>}
        {historyError && <p className="notice" role="alert">{historyError}</p>}
        {visiblePage && <><RunTable rows={visiblePage.data} />{!visiblePage.data.length && <p className="info-body">Brak sprawdzeń na tej stronie.</p>}</>}
        <div className="table-footer integration-pagination"><span role="status">Strona {cursors.length} · do 25 sprawdzeń</span><div className="inline-actions">
          <button className="button small-btn" type="button" disabled={historyBusy || cursors.length === 1} onClick={() => setCursors(v => v.slice(0, -1))}>Nowsze sprawdzenia</button>
          <button className="button small-btn" type="button" disabled={historyBusy || !visiblePage?.next} onClick={() => setCursors(v => visiblePage?.next && !v.includes(visiblePage.next) ? [...v, visiblePage.next] : v)}>Starsze sprawdzenia</button>
        </div></div></>}
  </section>;
}
