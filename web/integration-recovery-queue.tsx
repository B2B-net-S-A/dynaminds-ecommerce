import { useEffect, useRef, useState } from 'react';

export type RecoveryProvider = 'shopify' | 'amazon' | 'ebay';
export type RecoveryIdentity = {
  tenant_id: string;
  user_id: string;
  role: string;
  restore_preview: boolean;
};
export type RecoveryFilter = {
  provider: RecoveryProvider | null;
  execution: 'all' | 'live' | 'simulation';
};
export type RecoveryRow = {
  provider: RecoveryProvider;
  plan_id: string;
  order_id: string;
  order_number: string;
  shipment_id: string;
  channel_id: string;
  channel_name: string;
  channel_status: string;
  channel_mode: 'sandbox' | 'live';
  simulation: boolean | null;
  state: 'failed' | 'conflict' | 'queued';
  phase: 'ready' | 'write_started' | 'verify' | 'done';
  job_id: string | null;
  job_disposition: 'pending' | 'active' | 'stale' | 'exhausted' | 'failed' | 'done' | 'missing_or_mismatched';
  updated_at: string;
  issue: 'failed_before_send' | 'source_conflict' | 'write_outcome_unknown' |
    'verification_incomplete' | 'result_requires_review';
  reconcile_availability: 'in_detail' | 'read_only' | 'admin_required' |
    'credentials_missing' | 'connection_changed' | 'not_applicable' | 'not_verified' | 'queued_inspection_only';
};
export type RecoveryPage = {
  scope: RecoveryIdentity;
  items: RecoveryRow[];
  next_cursor: string | null;
};
/** Native HTTP registration is a separate dependency. Neither method writes or contacts a provider. */
export type IntegrationRecoveryTransport = {
  identity(): Promise<unknown>;
  list(query: RecoveryFilter & { limit: 50; after: string | null }): Promise<unknown>;
};

const providerNames: Record<RecoveryProvider, string> = { shopify: 'Shopify', amazon: 'Amazon', ebay: 'eBay' };
const issueNames: Record<RecoveryRow['issue'], string> = {
  failed_before_send: 'Operacja zakończona błędem przed wysłaniem',
  source_conflict: 'Dane źródłowe wymagają sprawdzenia',
  write_outcome_unknown: 'Wynik wysłania nie jest potwierdzony',
  verification_incomplete: 'Weryfikacja wyniku nie została zakończona',
  result_requires_review: 'Zapisany wynik wymaga sprawdzenia',
};
const reconcileNames: Record<RecoveryRow['reconcile_availability'], string> = {
  in_detail: 'Odczyt wyniku jest dostępny w panelu realizacji zamówienia.',
  read_only: 'Kopia tylko do odczytu. Uzgodnienie wymaga powrotu do zwykłego kontekstu.',
  admin_required: 'Uzgodnienie wymaga administratora i bieżących uprawnień.',
  credentials_missing: 'Brak wymaganych poświadczeń połączenia. Odczyt u dostawcy jest niedostępny.',
  connection_changed: 'Połączenie zmieniono. Istniejący panel sprawdzi tożsamość pierwotnego konta.',
  not_applicable: 'Sprawdź szczegóły błędu w zamówieniu. Ten plan nie ma niepewnego zapisu do uzgodnienia.',
  not_verified: 'Dostępność odczytu u dostawcy wymaga sprawdzenia w istniejącym panelu realizacji.',
  queued_inspection_only: 'Plan pozostaje w kolejce. Możesz sprawdzić zamówienie; obecne uzgodnienie nie obsługuje tego stanu.',
};
const jobNames: Record<RecoveryRow['job_disposition'], string> = {
  pending: 'Zadanie oczekuje na wykonanie lub następną próbę',
  active: 'Zadanie ma aktywną dzierżawę — może nadal wykonywać operację',
  stale: 'Brak odnowienia od ponad 2 minut — zadanie może wymagać obsługi workera',
  exhausted: 'Wyczerpano liczbę prób zadania',
  failed: 'Zadanie zakończone błędem',
  done: 'Zadanie zakończone — plan nadal wymaga sprawdzenia',
  missing_or_mismatched: 'Brak zgodnego zadania powiązanego z tym planem',
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utc6 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const invalid = () => new Error('Odpowiedź kolejki jest niepoprawna. Odśwież widok.');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw invalid();
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}
function id(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
function identity(value: unknown): RecoveryIdentity {
  const p = object(value);
  exact(p, ['tenant_id', 'user_id', 'role', 'restore_preview']);
  if (!id(p.tenant_id) || !id(p.user_id) || !text(p.role, 50) || typeof p.restore_preview !== 'boolean') throw invalid();
  return p as RecoveryIdentity;
}
function scopeKey(p: RecoveryIdentity) { return JSON.stringify([p.tenant_id, p.user_id, p.role, p.restore_preview]); }
function expectedIssue(row: RecoveryRow): RecoveryRow['issue'] {
  if (row.phase === 'write_started') return 'write_outcome_unknown';
  if (row.phase === 'verify') return 'verification_incomplete';
  if (row.phase === 'done') return 'result_requires_review';
  return row.state === 'failed' ? 'failed_before_send' : 'source_conflict';
}
export function validateIntegrationRecoveryPage(value: unknown, expected: RecoveryIdentity, filter: RecoveryFilter): RecoveryPage {
  const p = object(value);
  exact(p, ['scope', 'items', 'next_cursor']);
  if (scopeKey(identity(p.scope)) !== scopeKey(expected) || !Array.isArray(p.items) || p.items.length > 50) throw invalid();
  if (p.next_cursor !== null && (!text(p.next_cursor, 2048) || p.items.length !== 50)) throw invalid();
  const seen = new Set<string>();
  let previous: RecoveryRow | null = null;
  for (const value of p.items) {
    const raw = object(value);
    exact(raw, ['provider','plan_id','order_id','order_number','shipment_id','channel_id','channel_name',
      'channel_status','channel_mode','simulation','state','phase','job_id','job_disposition','updated_at','issue','reconcile_availability']);
    const row = raw as RecoveryRow;
    if (!Object.hasOwn(providerNames, row.provider) || !id(row.plan_id) || !id(row.order_id) || !id(row.shipment_id) ||
      !id(row.channel_id) || !text(row.order_number, 200) || !text(row.channel_name, 200) || !text(row.channel_status, 100) ||
      !['sandbox','live'].includes(row.channel_mode) || (row.simulation !== null && typeof row.simulation !== 'boolean') ||
      !['failed','conflict','queued'].includes(row.state) || !['ready','write_started','verify','done'].includes(row.phase) ||
      (row.job_id !== null && !id(row.job_id)) || !utc6.test(row.updated_at) || !Number.isFinite(Date.parse(row.updated_at)) ||
      !Object.hasOwn(jobNames, row.job_disposition) || (row.job_id === null && row.job_disposition !== 'missing_or_mismatched') ||
      row.issue !== expectedIssue(row) || !Object.hasOwn(reconcileNames, row.reconcile_availability)) throw invalid();
    const uncertain = row.phase === 'write_started' || row.phase === 'verify';
    if ((row.state === 'queued' && (!uncertain || row.reconcile_availability !== 'queued_inspection_only')) ||
      (row.state !== 'queued' && row.reconcile_availability === 'queued_inspection_only') ||
      (!uncertain && row.reconcile_availability !== 'not_applicable') ||
      (row.reconcile_availability === 'in_detail' && (expected.restore_preview || expected.role !== 'admin')) ||
      (filter.provider !== null && filter.provider !== row.provider) ||
      (filter.execution === 'simulation' && row.simulation !== true) || (filter.execution === 'live' && row.simulation !== false)) throw invalid();
    const key = row.provider + ':' + row.plan_id;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    // Native order is updated_at DESC, provider ASC, plan_id DESC; compare the full microsecond string.
    if (previous && (previous.updated_at < row.updated_at || (previous.updated_at === row.updated_at &&
      (previous.provider > row.provider || (previous.provider === row.provider && previous.plan_id.toLowerCase() <= row.plan_id.toLowerCase()))))) throw invalid();
    previous = row;
  }
  return p as RecoveryPage;
}

export function IntegrationRecoveryQueue({ context, transport, refresh = 0, onOpenOrder }: {
  context: RecoveryIdentity;
  transport?: IntegrationRecoveryTransport;
  refresh?: number;
  onOpenOrder: (orderId: string) => void;
}) {
  const key = scopeKey(context);
  const [controls, setControls] = useState<{ key: string; filter: RecoveryFilter; cursors: (string | null)[] }>({
    key, filter: { provider: null, execution: 'all' }, cursors: [null],
  });
  // Scope controls in render, so a changed actor never sends the old actor's cursor or filters.
  const filter: RecoveryFilter = controls.key === key ? controls.filter : { provider: null, execution: 'all' };
  const cursors: (string | null)[] = controls.key === key ? controls.cursors : [null];
  const [result, setResult] = useState<{ page: RecoveryPage; key: string; query: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const live = useRef({ key, transport, refresh });
  live.current = { key, transport, refresh };
  const navigation = useRef(onOpenOrder); navigation.current = onOpenOrder;
  const after = cursors.at(-1) ?? null;
  const queryKey = JSON.stringify([filter.provider, filter.execution, after]);
  const queryLive = useRef(queryKey); queryLive.current = queryKey;
  useEffect(() => {
    setControls(previous => previous.key === key ? previous : {
      key, filter: { provider: null, execution: 'all' }, cursors: [null],
    });
  }, [key]);
  useEffect(() => {
    const g = ++epoch.current, selectedTransport = transport, selectedContext = { ...context };
    let active = true;
    const current = () => active && g === epoch.current && live.current.key === key &&
      live.current.transport === selectedTransport && live.current.refresh === refresh && queryLive.current === queryKey;
    setResult(null); setError(''); setBusy(Boolean(selectedTransport));
    async function load() {
      if (!selectedTransport) return;
      try {
        const before = identity(await selectedTransport.identity());
        if (!current()) return;
        if (scopeKey(before) !== key) throw new Error('Kontekst użytkownika zmienił się. Otwórz kolejkę ponownie.');
        const value = await selectedTransport.list({ ...filter, limit: 50, after });
        if (!current()) return;
        const page = validateIntegrationRecoveryPage(value, selectedContext, filter);
        const final = identity(await selectedTransport.identity());
        if (!current()) return;
        if (scopeKey(final) !== key) throw new Error('Kontekst użytkownika zmienił się. Otwórz kolejkę ponownie.');
        if (page.next_cursor !== null && cursors.includes(page.next_cursor)) throw invalid();
        setResult({ page, key, query: queryKey });
      } catch {
        if (current()) { setResult(null); setError('Nie udało się odczytać kolejki. Sprawdź sesję i bieżące uprawnienia, a następnie odśwież.'); }
      } finally { if (current()) setBusy(false); }
    }
    void load();
    return () => { active = false; if (epoch.current === g) epoch.current++; };
  }, [key, transport, refresh, queryKey, reload]);
  function changeFilter(next: RecoveryFilter) { epoch.current++; setResult(null); setError(''); setControls({ key, filter: next, cursors: [null] }); }
  function move(next: (string | null)[]) { epoch.current++; setResult(null); setError(''); setControls({ key, filter, cursors: next }); }
  async function open(row: RecoveryRow) {
    const selected = live.current, g = epoch.current, selectedQuery = queryLive.current;
    if (!selected.transport || busy) return;
    try {
      const fresh = identity(await selected.transport.identity());
      if (g !== epoch.current || selected.key !== live.current.key || selected.transport !== live.current.transport ||
        selected.refresh !== live.current.refresh || selectedQuery !== queryLive.current) return;
      if (scopeKey(fresh) !== selected.key) throw invalid();
      navigation.current(row.order_id);
    } catch { if (g === epoch.current && selected.key === live.current.key && selected.transport === live.current.transport &&
      selected.refresh === live.current.refresh && selectedQuery === queryLive.current) {
      setResult(null); setError('Nie można otworzyć zamówienia w zmienionym kontekście. Odśwież kolejkę.');
    } }
  }
  const page = result?.key === key && result.query === queryKey ? result.page : null;
  return <section className="panel" aria-label="Operacje integracji wymagające sprawdzenia">
    <div className="panel-heading"><div><h2>Operacje wymagające sprawdzenia</h2>
      <p>Błędy i niepewne wyniki realizacji Shopify, Amazon i eBay, także przy poprawnie połączonym kanale.</p></div>
      <button className="button" type="button" disabled={busy || !transport} onClick={() => { epoch.current++; setResult(null); setReload(n => n + 1); }}>Odśwież kolejkę</button></div>
    {context.restore_preview && <p className="notice" role="status">Kopia tylko do odczytu. Możesz przejrzeć operacje; uzgadnianie pozostaje zablokowane.</p>}
    {!transport && <p className="notice" role="status">Odczyt kolejki nie jest jeszcze podłączony. Brak danych nie oznacza braku problemów.</p>}
    <div className="integration-filters">
      <label>Dostawca<select value={filter.provider ?? 'all'} disabled={!transport} onChange={e => changeFilter({ ...filter, provider: e.target.value === 'all' ? null : e.target.value as RecoveryProvider })}>
        <option value="all">Wszyscy</option>{Object.entries(providerNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <label>Wykonanie<select value={filter.execution} disabled={!transport} onChange={e => changeFilter({ ...filter, execution: e.target.value as RecoveryFilter['execution'] })}>
        <option value="all">Wszystkie</option><option value="live">Rzeczywiste</option><option value="simulation">Symulacje</option>
      </select></label>
    </div>
    {busy && <p className="notice" role="status">Odczytywanie operacji…</p>}
    {error && <p className="error-block" role="alert">{error}</p>}
    {page && <>
      {!page.items.length && <p className="notice" role="status">Brak operacji wymagających sprawdzenia dla wybranych filtrów.</p>}
      <div className="table-scroll"><table><caption>Niepewne wyniki i błędy realizacji — stan lokalnych planów</caption>
        <thead><tr><th scope="col">Zamówienie</th><th scope="col">Połączenie</th><th scope="col">Wynik i dalsze działanie</th><th scope="col">Ostatnia zmiana</th><th scope="col">Szczegóły</th></tr></thead>
        <tbody>{page.items.map(row => <tr key={row.provider + ':' + row.plan_id}>
          <td><strong>{row.order_number}</strong><br/><span>{providerNames[row.provider]}</span></td>
          <td>{row.channel_name}<br/><small>{row.channel_mode === 'sandbox' ? 'Bieżące środowisko testowe' : 'Bieżące środowisko produkcyjne'} · {row.simulation === null ? 'Nieustalony tryb historycznej próby' : row.simulation ? 'Symulacja — bez potwierdzenia u dostawcy' : 'Próba rzeczywistego wykonania'}</small><br/><small>Stan połączenia: {row.channel_status}</small></td>
          <td><strong>{issueNames[row.issue]}</strong><p>{reconcileNames[row.reconcile_availability]}</p>
            <p>{jobNames[row.job_disposition]}</p>
            {(row.phase === 'write_started' || row.phase === 'verify') && <small>Wysłanie mogło zostać przyjęte. Ta kolejka nie ponawia zapisu.</small>}</td>
          <td><time dateTime={row.updated_at}>{new Date(row.updated_at).toLocaleString('pl-PL')}</time></td>
          <td><button className="button small-btn" type="button" disabled={busy} onClick={() => void open(row)}>Otwórz zamówienie {row.order_number}</button>
            <details><summary>Identyfikatory operacji</summary><dl><dt>Plan</dt><dd>{row.plan_id}</dd><dt>Przesyłka</dt><dd>{row.shipment_id}</dd><dt>Zadanie</dt><dd>{row.job_id ?? 'Brak przypisanego zadania'}</dd></dl></details></td>
        </tr>)}</tbody></table></div>
      <div className="table-footer integration-pagination"><span role="status">Strona {cursors.length} · wyświetlono {page.items.length} operacji</span>
        <nav className="inline-actions" aria-label="Strony kolejki operacji">
          <button className="button small-btn" type="button" disabled={busy || cursors.length <= 1} onClick={() => move(cursors.slice(0, -1))}>Poprzednia strona</button>
          <button className="button small-btn" type="button" disabled={busy || page.next_cursor === null} onClick={() => { if (page.next_cursor) move([...cursors, page.next_cursor]); }}>Następna strona</button>
        </nav></div>
    </>}
  </section>;
}
