import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import type {
  SupplierRemoteView,
  SupplierFeedScheduleView,
  SupplierRemoteFetchView,
  SupplierFeedPublishPolicy,
} from '../server/supplier-remote-schema';
import './supplier-remote-feeds.css';

type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_manage: boolean;
  can_fetch: boolean;
  can_enable_schedule: boolean;
};
type Publication = SupplierFeedPublishPolicy;
type Remote = SupplierRemoteView;
type Schedule = SupplierFeedScheduleView;
type Fetch = SupplierRemoteFetchView;
type Reply = Flags & { remote?: Remote; schedule?: Schedule; fetch?: Fetch; reused?: boolean };
type FetchDetail = Reply & {
  preview: { id: string; source_id: string; executed_run_id: string | null } | null;
  run: { id: string; source_id: string; preview_id: string } | null;
};
type ResolvedPublication = {
  identity: string;
  sourceId: string;
  fetchId: string;
  previewId: string;
  runId: string;
};
type History = Flags & {
  data: Fetch[];
  meta: { total: number; has_more: boolean; cursor: string | null };
};
type Attempt = {
  scope: string;
  sourceId: string;
  kind: 'remote' | 'schedule' | 'fetch';
  path: string;
  method: 'POST' | 'PATCH';
  body: string;
};
type Retained = {
  contextKey: string;
  scope: string;
  attempt: Attempt | null;
  inFlight: boolean;
  active: { sourceId: string; id: string } | null;
};
let actorContext = '';
let retained: Retained = {
  contextKey: '',
  scope: '',
  attempt: null,
  inFlight: false,
  active: null,
};
const listeners = new Set<() => void>();
function publish() {
  listeners.forEach((fn) => fn());
}
export function resetSupplierRemoteFeedsContext(contextKey: string) {
  if (actorContext === contextKey) return;
  actorContext = contextKey;
  retained = { contextKey, scope: '', attempt: null, inFlight: false, active: null };
  publish();
}
export function getSupplierRemoteFeedsLocked(contextKey: string) {
  return (
    retained.contextKey === contextKey &&
    (!!retained.attempt || retained.inFlight || !!retained.active)
  );
}
export function getSupplierRemoteFeedsSource(contextKey: string) {
  return retained.contextKey === contextKey
    ? (retained.attempt?.sourceId ?? retained.active?.sourceId ?? '')
    : '';
}
export function subscribeSupplierRemoteFeedsLock(
  contextKey: string,
  callback: (locked: boolean) => void,
) {
  const listener = () => callback(getSupplierRemoteFeedsLocked(contextKey));
  listeners.add(listener);
  listener();
  return () => {
    listeners.delete(listener);
  };
}
const disabledPublication = (): Publication => ({
  enabled: false,
  allow_new: false,
  withdrawal: { enabled: false, min_rows: 1, max_missing: 0, max_missing_percent: 0 },
});
const stateNames: Record<Fetch['state'], string> = {
  queued: 'Oczekuje na pobranie',
  fetching: 'Trwa pobieranie',
  success: 'Zakończone',
  'awaiting-consent': 'Podgląd oczekuje na zgodę',
  failed: 'Pobieranie nie powiodło się',
  conflict: 'Zmieniła się podstawa danych',
  cancelled: 'Anulowane',
};
function fetchErrorText(code: string, httpStatus?: number | null) {
  if (['INVALID_URL', 'DENIED_ADDRESS', 'REDIRECT', 'PEER_MISMATCH'].includes(code))
    return 'Adres źródła jest niedozwolony lub dostawca przekierował pobranie. Katalog zachowano.';
  if (
    code === 'INVALID_AUTH' ||
    (code === 'HTTP_STATUS' && (httpStatus === 401 || httpStatus === 403))
  )
    return 'Dostawca odrzucił dane dostępu. Popraw je przed kolejnym pobraniem.';
  if (['DEADLINE', 'CONNECT_TIMEOUT', 'IDLE_TIMEOUT'].includes(code))
    return 'Pobieranie nie zakończyło się w czasie. Katalog zachowano.';
  if (['WIRE_TOO_LARGE', 'DECODED_TOO_LARGE', 'HEADERS_TOO_LARGE'].includes(code))
    return 'Plik lub odpowiedź dostawcy przekracza limit. Nie obcięto danych ani katalogu.';
  if (
    [
      'INCOMPLETE_RESPONSE',
      'INVALID_COMPRESSION',
      'EMPTY_BODY',
      'NETWORK_FAILED',
      'ABORTED',
    ].includes(code)
  )
    return 'Nie odebrano całego pliku. Katalog pozostał bez zmian.';
  if (
    code === 'INVALID_UTF8' ||
    code === 'UNSUPPORTED_ENCODING' ||
    code === 'HTML_RESPONSE' ||
    code === 'INVALID_SOURCE'
  )
    return 'Odebrany plik nie jest poprawnym plikiem źródłowym. Sprawdź format i mapowanie; katalog zachowano.';
  if (code === 'CONFIG_CHANGED' || code === 'SCHEDULE_CHANGED')
    return 'Podczas pobrania zmieniła się konfiguracja. Odczytaj aktualne wersje przed nową próbą.';
  if (code === 'IAM_REVOKED')
    return 'Autor zgody utracił uprawnienia. Potrzebna jest nowa świadoma zgoda uprawnionego administratora.';
  if (code === 'QUOTA' || code === 'QUEUE_FULL')
    return 'Wstrzymano operację z powodu limitu kolejki lub dowodów. Dane katalogu zachowano.';
  if (code === 'AWAITING_CONSENT')
    return 'Podgląd wymaga osobnej zgody. Odczytaj wszystkie wiersze i brakujące pozycje.';
  if (code === 'LEASE_EXPIRED')
    return 'Próba utraciła prawo wykonania. Odczytaj jej trwały wynik przed kolejną czynnością.';
  return 'Pobranie nie zakończyło się poprawnie. Odczytaj trwały wynik; nie uznawaj błędu za dostępność zero.';
}
function errorText(error: unknown) {
  if (error instanceof PublicationEvidenceError)
    return 'Nie udało się potwierdzić spójnego wyniku publikacji. Odczytaj wynik ponownie; nie uznawaj pobrania za zastosowanie katalogu.';
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Sesja lub dane dostępu wygasły. Zaloguj się ponownie.';
    if (error.status === 403) return 'Brak bieżącego prawa do tej operacji.';
    if (error.status === 423)
      return 'Kopia działa w trybie odczytu. Pobieranie i zapisy są wyłączone.';
    if (error.status === 409)
      return 'Zmieniła się konfiguracja lub podstawa danych. Odczytaj aktualny stan przed nową próbą.';
    if (error.status === 413)
      return 'Plik lub podgląd przekracza dopuszczalny limit. Nie obcięto danych.';
    if (error.status === 429)
      return 'Wstrzymano operację z powodu limitu kolejki lub dowodów. Katalog zachowano.';
    if (error.status === 503)
      return 'Moduł pobierania jest niedostępny lub niekompletny. Nie uruchomiono innej ścieżki.';
    if (error.status === 422 || error.status === 400)
      return 'Niepoprawna konfiguracja. Sprawdź adres HTTPS, dane dostępu i politykę publikacji.';
  }
  return 'Nie udało się odczytać potwierdzenia. Sprawdź trwały wynik operacji.';
}
function validFetch(value: Fetch, sourceId: string) {
  if (!value.id || value.source_id !== sourceId || !Object.hasOwn(stateNames, value.state))
    throw Error('Nieprawidłowy wynik pobrania.');
  return value;
}
class PublicationEvidenceError extends Error {}
function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
function publicationId(reply: FetchDetail, fetchId: string, sourceId: string): string | null {
  const { fetch, preview, run } = reply;
  const reject = () => {
    throw new PublicationEvidenceError();
  };
  if (!fetch || !uuid(fetch.id) || fetch.id !== fetchId || fetch.source_id !== sourceId)
    return reject();
  if (fetch.preview_id === null) {
    if (preview !== null || run !== null || fetch.run_id !== null) return reject();
    return null;
  }
  if (
    !uuid(fetch.preview_id) ||
    !preview ||
    preview.id !== fetch.preview_id ||
    preview.source_id !== sourceId
  )
    return reject();
  if (preview.executed_run_id === null) {
    if (run !== null || fetch.run_id !== null) return reject();
    return null;
  }
  if (
    !uuid(preview.executed_run_id) ||
    !run ||
    run.id !== preview.executed_run_id ||
    run.source_id !== sourceId ||
    run.preview_id !== fetch.preview_id ||
    (fetch.run_id !== null && fetch.run_id !== run.id)
  )
    return reject();
  return run.id;
}
function integer(value: string, min: number, max: number, label: string) {
  if (
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) < BigInt(min) ||
    BigInt(value) > BigInt(max)
  )
    throw Error(`${label}: podaj liczbę całkowitą ${min}–${max}.`);
  return Number(value);
}
export type SupplierRemoteFeedsProps = {
  contextKey: string;
  readOnly: boolean;
  admin: boolean;
  sourceId: string;
  sourceVersion?: number;
  currency?: string;
  externalWriteBlocked?: boolean;
  getExternalWriteBlocked?: () => boolean;
  onPreview: (id: string) => void;
  onHistory?: () => void;
  onSourceChanged: () => void;
};
export function SupplierRemoteFeeds({
  contextKey,
  readOnly,
  admin,
  sourceId,
  sourceVersion,
  currency,
  externalWriteBlocked = false,
  getExternalWriteBlocked,
  onPreview,
  onHistory,
  onSourceChanged,
}: SupplierRemoteFeedsProps) {
  const scope = `${contextKey}:${readOnly}:${admin}`;
  const identity = `${scope}:${sourceId}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const epoch = useRef(0),
    busyRef = useRef(false),
    priorFlags = useRef<Flags | null>(null);
  const [, render] = useState(0);
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const [flags, setFlags] = useState<Flags | null>(null),
    [remote, setRemote] = useState<Remote | null>(null),
    [schedule, setSchedule] = useState<Schedule | null>(null);
  const [fetchResult, setFetchResult] = useState<Fetch | null>(null),
    [history, setHistory] = useState<Fetch[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [total, setTotal] = useState<number | null>(null);
  const [resolvedPublication, setResolvedPublication] = useState<ResolvedPublication | null>(null);
  const [remoteDraft, setRemoteDraft] = useState<{ version: number; sourceVersion: number } | null>(
    null,
  );
  const [scheduleDraft, setScheduleDraft] = useState<{
    version: number;
    sourceVersion: number;
    remoteVersion: number;
  } | null>(null);
  const [url, setUrl] = useState(''),
    [authAction, setAuthAction] = useState<'keep' | 'clear' | 'replace'>('keep'),
    [authKind, setAuthKind] = useState<'basic' | 'bearer' | 'header'>('bearer');
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [token, setToken] = useState(''),
    [headerName, setHeaderName] = useState('X-API-Key'),
    [headerValue, setHeaderValue] = useState('');
  const [feedScope, setFeedScope] = useState<'delta' | 'full'>('delta'),
    [remoteConsent, setRemoteConsent] = useState(false);
  const [enabled, setEnabled] = useState(false),
    [interval, setInterval] = useState('30'),
    [publication, setPublication] = useState<Publication>(disabledPublication),
    [minRows, setMinRows] = useState('1'),
    [maxMissing, setMaxMissing] = useState('0'),
    [maxPercent, setMaxPercent] = useState('0'),
    [futureConsent, setFutureConsent] = useState(false);
  const [tab, setTab] = useState<'remote' | 'history' | 'schedule'>('remote');
  const state = retained.contextKey === contextKey && retained.scope === scope ? retained : null;
  const pending = state?.attempt ?? null;
  const ownLocked = !!pending || !!state?.inFlight || !!state?.active;
  const visible = loadedIdentity === identity && actorContext === contextKey;
  const readable = visible && !!flags?.available && flags.can_read;
  const writable =
    readable &&
    admin &&
    !readOnly &&
    flags?.current_role === 'admin' &&
    flags.can_manage &&
    !flags.read_only;
  const freshDisabled = !writable || busy || ownLocked || externalWriteBlocked;
  let draftHost = '';
  try {
    if (url.trim()) draftHost = new URL(url.trim()).hostname;
  } catch {
    /* Full URL is never echoed. */
  }
  function clearSecrets() {
    setUrl('');
    setUsername('');
    setPassword('');
    setToken('');
    setHeaderValue('');
    setAuthAction('keep');
    setRemoteConsent(false);
  }
  function clearSensitive() {
    clearSecrets();
    setFlags(null);
    setRemote(null);
    setSchedule(null);
    setRemoteDraft(null);
    setScheduleDraft(null);
    setHistory([]);
    setFetchResult(null);
    setResolvedPublication(null);
    setCursor(null);
    setTotal(null);
    setFutureConsent(false);
    setPublication(disabledPublication());
    setEnabled(false);
    setHeaderName('X-API-Key');
    setAuthKind('bearer');
    setFeedScope('delta');
    setInterval('30');
    setMinRows('1');
    setMaxMissing('0');
    setMaxPercent('0');
    setStatus('');
  }
  function purge() {
    clearSensitive();
    priorFlags.current = null;
    if (retained.contextKey === contextKey && retained.scope === scopeRef.current) {
      retained.attempt = null;
      retained.active = null;
      retained.inFlight = false;
      publish();
    }
  }
  function accept(next: Flags) {
    if (
      typeof next.available !== 'boolean' ||
      typeof next.can_read !== 'boolean' ||
      typeof next.can_manage !== 'boolean' ||
      typeof next.can_fetch !== 'boolean' ||
      typeof next.can_enable_schedule !== 'boolean' ||
      typeof next.read_only !== 'boolean'
    )
      throw Error('Brak bieżących uprawnień w odpowiedzi.');
    const old = priorFlags.current;
    if (
      !next.available ||
      !next.can_read ||
      (old &&
        (old.current_role !== next.current_role ||
          (old.can_manage && !next.can_manage) ||
          (!old.read_only && next.read_only)))
    )
      purge();
    priorFlags.current = next;
    setFlags(next);
    return next.available && next.can_read;
  }
  async function request<T>(path: string, e: number, method = 'GET', body?: unknown): Promise<T> {
    const sentIdentity = identityRef.current;
    try {
      const value = await api<T>(path, method, body);
      if (
        e !== epoch.current ||
        identityRef.current !== sentIdentity ||
        actorContext !== contextKey
      )
        throw new DOMException('Kontekst zmieniono.', 'AbortError');
      return value;
    } catch (err) {
      if (
        e !== epoch.current ||
        identityRef.current !== sentIdentity ||
        actorContext !== contextKey
      )
        throw new DOMException('Kontekst zmieniono.', 'AbortError');
      throw err;
    }
  }
  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    setError(errorText(err));
    if (err instanceof ApiError && [401, 403, 423].includes(err.status)) purge();
  }
  async function read(work: (e: number) => Promise<void>) {
    if (busyRef.current) return;
    const e = epoch.current;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await work(e);
    } catch (err) {
      if (e === epoch.current) fail(err);
    } finally {
      if (e === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function applyRemote(r: Remote, replaceDraft: boolean) {
    if (
      r.source_id !== sourceId ||
      !Number.isInteger(r.version) ||
      !Number.isInteger(r.source_version)
    )
      throw Error('Nieprawidłowa konfiguracja źródła.');
    setRemote(r);
    if (replaceDraft) {
      setRemoteDraft({ version: r.version, sourceVersion: r.source_version });
      setFeedScope(r.scope);
      clearSecrets();
    }
  }
  function applySchedule(s: Schedule, source: Remote, replaceDraft: boolean) {
    if (s.source_id !== sourceId || !Number.isInteger(s.version) || !s.publish?.withdrawal)
      throw Error('Nieprawidłowa konfiguracja harmonogramu.');
    setSchedule(s);
    if (replaceDraft) {
      setScheduleDraft({
        version: s.version,
        sourceVersion: source.source_version,
        remoteVersion: source.version,
      });
      setEnabled(s.enabled);
      setInterval(String(s.interval_minutes));
      setPublication(structuredClone(s.publish));
      setMinRows(String(s.publish.withdrawal.min_rows));
      setMaxMissing(String(s.publish.withdrawal.max_missing));
      setMaxPercent(String(s.publish.withdrawal.max_missing_percent));
      setFutureConsent(false);
    }
  }
  function loadConfiguration(replaceDraft = false, initialRead = false) {
    if (!sourceId || (replaceDraft && ownLocked && !initialRead)) return;
    void read(async (e) => {
      const r = await request<Reply>(`/supplier-file-sources/${sourceId}/remote`, e);
      setLoadedIdentity(identityRef.current);
      if (!accept(r) || !r.remote) return;
      applyRemote(r.remote, replaceDraft || !remoteDraft);
      const s = await request<Reply>(`/supplier-file-sources/${sourceId}/feed-schedule`, e);
      if (!accept(s) || !s.schedule) return;
      applySchedule(s.schedule, r.remote, replaceDraft || !scheduleDraft);
    });
  }
  function recordFetch(f: Fetch, expectedSource = sourceId) {
    validFetch(f, expectedSource);
    setResolvedPublication(null);
    setFetchResult(f);
    if (retained.contextKey === contextKey && retained.scope === scopeRef.current) {
      if (f.state === 'queued' || f.state === 'fetching')
        retained.active = { sourceId: f.source_id, id: f.id };
      else if (retained.active?.id === f.id) retained.active = null;
      publish();
    }
  }
  function readFetch(id: string) {
    if (!readable || !id) return;
    void read(async (e) => {
      setResolvedPublication(null);
      const r = await request<FetchDetail>('/supplier-file-fetches/' + id, e);
      if (!accept(r)) return;
      const runId = publicationId(r, id, sourceId);
      const f = r.fetch!;
      recordFetch(f);
      if (runId)
        setResolvedPublication({
          identity: identityRef.current,
          sourceId,
          fetchId: f.id,
          previewId: f.preview_id!,
          runId,
        });
    });
  }
  function loadHistory(more = false) {
    if (!sourceId || !readable || (more && !cursor)) return;
    void read(async (e) => {
      const r = await request<History>(
        `/supplier-file-sources/${sourceId}/fetches?limit=25${more ? '&after=' + encodeURIComponent(cursor!) : ''}`,
        e,
      );
      if (!accept(r)) return;
      if (
        !Array.isArray(r.data) ||
        r.data.length > 25 ||
        !Number.isInteger(r.meta.total) ||
        r.meta.total < 0 ||
        new Set(r.data.map((f) => f.id)).size !== r.data.length ||
        (r.meta.has_more && (!r.meta.cursor || (more && r.meta.cursor === cursor)))
      )
        throw Error('Niekompletna strona historii.');
      r.data.forEach((f) => validFetch(f, sourceId));
      if (more && r.data.some((f) => history.some((old) => old.id === f.id)))
        throw Error('Powtórzona strona historii.');
      setHistory(more ? [...history, ...r.data] : r.data);
      setCursor(r.meta.has_more ? r.meta.cursor : null);
      setTotal(r.meta.total);
    });
  }
  async function send(attempt: Attempt) {
    if (
      busyRef.current ||
      !admin ||
      readOnly ||
      attempt.scope !== scopeRef.current ||
      actorContext !== contextKey ||
      (retained.attempt && retained.attempt !== attempt) ||
      retained.inFlight
    )
      return;
    const current = retained,
      e = epoch.current;
    current.attempt = attempt;
    current.inFlight = true;
    publish();
    busyRef.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    let wrote = false;
    try {
      const live = await request<Reply>(`/supplier-file-sources/${attempt.sourceId}/remote`, e);
      if (
        !accept(live) ||
        live.current_role !== 'admin' ||
        live.read_only ||
        !live.can_manage ||
        (attempt.kind === 'fetch' && !live.can_fetch) ||
        (attempt.kind === 'schedule' && !live.can_enable_schedule)
      )
        throw new ApiError('Brak prawa zapisu.', 403);
      if (current !== retained || current.attempt !== attempt) return;
      wrote = true;
      const r = await request<Reply>(attempt.path, e, attempt.method, JSON.parse(attempt.body));
      if (!accept(r)) throw Error('Brak potwierdzenia aktualnych uprawnień.');
      if (attempt.kind === 'fetch') {
        if (!r.fetch) throw Error('Brak potwierdzenia pobrania.');
        recordFetch(r.fetch, attempt.sourceId);
      } else if (attempt.kind === 'remote') {
        if (!r.remote) throw Error('Brak potwierdzenia konfiguracji.');
        applyRemote(r.remote, true);
        setScheduleDraft(null);
        onSourceChanged();
      } else {
        if (!r.schedule || !live.remote) throw Error('Brak potwierdzenia harmonogramu.');
        applySchedule(r.schedule, live.remote, true);
      }
      current.attempt = null;
      publish();
      clearSecrets();
      setStatus(
        r.reused
          ? 'Odczytano wynik wcześniej zapisanej dokładnie tej próby.'
          : attempt.kind === 'fetch'
            ? 'Próbę pobrania zapisano. Odczytaj jej wynik; publikacja wymaga osobnej zgody.'
            : 'Konfiguracja zapisana.',
      );
    } catch (err) {
      if (e !== epoch.current || current !== retained || actorContext !== contextKey) return;
      if (
        !wrote ||
        (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408)
      ) {
        current.attempt = null;
        publish();
      }
      fail(err);
      if (current.attempt)
        setError(
          'Wynik jest nieznany. Treść i klucz zachowano w RAM. Nowe zapisy są wstrzymane; ponów ręcznie dokładnie tę próbę.',
        );
    } finally {
      if (current === retained) {
        current.inFlight = false;
        publish();
      }
      if (e === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function start(kind: Attempt['kind'], method: Attempt['method'], path: string, body: object) {
    if (
      freshDisabled ||
      getExternalWriteBlocked?.() ||
      busyRef.current ||
      retained.attempt ||
      retained.inFlight ||
      retained.active
    )
      return;
    void send({
      kind,
      method,
      path,
      body: JSON.stringify(body),
      scope: scopeRef.current,
      sourceId,
    });
  }
  function saveRemote() {
    if (freshDisabled || !remoteDraft || !remoteConsent) return;
    try {
      if (!remote?.configured && !url.trim()) throw Error('Podaj pełny adres HTTPS.');
      if (url.trim()) {
        const parsed = new URL(url.trim());
        if (
          parsed.protocol !== 'https:' ||
          parsed.username ||
          parsed.password ||
          parsed.hash ||
          (parsed.port && parsed.port !== '443')
        )
          throw Error(
            'Wymagany adres HTTPS bez danych logowania, fragmentu i niestandardowego portu.',
          );
      }
      const auth =
        authAction !== 'replace'
          ? { action: authAction }
          : {
              action: 'replace',
              value:
                authKind === 'basic'
                  ? { kind: 'basic', username, password }
                  : authKind === 'bearer'
                    ? { kind: 'bearer', token }
                    : { kind: 'header', name: headerName, value: headerValue },
            };
      if (
        authAction === 'replace' &&
        (authKind === 'basic'
          ? !password
          : authKind === 'bearer'
            ? !token
            : !headerName || !headerValue)
      )
        throw Error('Wypełnij nowe dane dostępu.');
      start('remote', 'PATCH', `/supplier-file-sources/${sourceId}/remote`, {
        client_key: crypto.randomUUID(),
        version: remoteDraft.version,
        source_version: remoteDraft.sourceVersion,
        ...(url.trim() ? { url: url.trim() } : {}),
        auth,
        scope: feedScope,
        confirmed: true,
      });
    } catch (err) {
      setError(
        err instanceof Error && !(err instanceof TypeError)
          ? err.message
          : 'Niepoprawny adres HTTPS.',
      );
    }
  }
  function saveSchedule() {
    if (freshDisabled || !scheduleDraft || !remote?.configured || !futureConsent) return;
    try {
      const intervalMinutes = integer(interval, 30, 10080, 'Odstęp pobrań');
      const withdrawal = {
        enabled: publication.withdrawal.enabled,
        min_rows: integer(minRows, 1, 500, 'Minimalna liczba wierszy'),
        max_missing: integer(maxMissing, 0, 10000, 'Maksymalna liczba braków'),
        max_missing_percent: integer(maxPercent, 0, 100, 'Maksymalny procent braków'),
      };
      if (withdrawal.enabled && (!publication.enabled || remote.scope !== 'full'))
        throw Error('Wycofywanie wymaga pełnego zakresu oraz włączonej publikacji.');
      start('schedule', 'PATCH', `/supplier-file-sources/${sourceId}/feed-schedule`, {
        client_key: crypto.randomUUID(),
        version: scheduleDraft.version,
        source_version: scheduleDraft.sourceVersion,
        remote_version: scheduleDraft.remoteVersion,
        enabled,
        interval_minutes: intervalMinutes,
        confirmed: true,
        publish: { enabled: publication.enabled, allow_new: publication.allow_new, withdrawal },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sprawdź harmonogram.');
    }
  }
  useEffect(() => {
    const fn = () => render((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  useEffect(() => {
    ++epoch.current;
    busyRef.current = false;
    setBusy(false);
    priorFlags.current = null;
    clearSensitive();
    setError('');
    setStatus('');
    setLoadedIdentity('');
    resetSupplierRemoteFeedsContext(contextKey);
    if (retained.scope !== scope) {
      retained = { contextKey, scope, attempt: null, inFlight: false, active: null };
      publish();
    }
    if (sourceId) loadConfiguration(true, true);
    return () => {
      ++epoch.current;
      busyRef.current = false;
    };
  }, [identity]);
  useEffect(() => {
    if (
      !visible ||
      !remote ||
      sourceVersion === undefined ||
      sourceVersion === remote.source_version ||
      busyRef.current
    )
      return;
    loadConfiguration(false);
  }, [sourceVersion]);
  const shownFetch = visible ? fetchResult : null;
  const actualPublicationId =
    shownFetch &&
    resolvedPublication?.identity === identity &&
    resolvedPublication.sourceId === sourceId &&
    resolvedPublication.sourceId === shownFetch.source_id &&
    resolvedPublication.fetchId === shownFetch.id &&
    resolvedPublication.previewId === shownFetch.preview_id
      ? resolvedPublication.runId
      : null;
  const activeId = state?.active?.sourceId === sourceId ? state.active.id : null;
  return (
    <section className="supplier-remote-feeds" aria-label="Zdalny plik dostawcy">
      <h3>Pobieranie pliku od dostawcy</h3>
      <p>
        Adres HTTPS → trwały podgląd → osobna zgoda na katalog dostawcy. Ceny są netto
        {currency ? ` · ${currency}` : ''}. Pobranie nie tworzy własnego zapasu, produktu ani
        zakupu.
      </p>
      {error && (
        <p role="alert" className="srf-error">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {pending && (
        <div className="srf-pending">
          <strong>
            {state?.inFlight ? 'Trwa zapis' : 'Nieznany wynik'} ·{' '}
            {pending.kind === 'fetch'
              ? 'pobranie'
              : pending.kind === 'remote'
                ? 'konfiguracja dostępu'
                : 'harmonogram'}
          </strong>
          <p>
            Dokładna treść i klucz są zachowane w RAM także po nawigacji. Nie odświeżaj strony.
            Odczyt historii sam nie usuwa tej próby.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={!writable || busy || !!state?.inFlight}
            onClick={() => void send(pending)}
          >
            Ponów dokładnie tę próbę
          </button>
        </div>
      )}
      {!sourceId ? (
        <p>Wybierz własne źródło plikowe powyżej.</p>
      ) : (
        <>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => loadConfiguration(false)}
          >
            Odczytaj dostępność i uprawnienia
          </button>
          {!visible || !flags ? (
            <p>
              {busy
                ? 'Odczytywanie konfiguracji pobierania…'
                : 'Nie potwierdzono dostępności i uprawnień. Odczytaj aktualny stan przed dalszą czynnością.'}
            </p>
          ) : !flags.available ? (
            <p>
              Zdalne pobieranie nie jest dostępne w tej wersji. Ręczny import pliku pozostaje
              osobnym procesem.
            </p>
          ) : !readable ? (
            <p>Brak bieżącego prawa odczytu.</p>
          ) : (
            <>
              {!writable && (
                <p>Tryb odczytu. Zmiany wymagają bieżących uprawnień administratora do zakupów.</p>
              )}
              {externalWriteBlocked && !ownLocked && (
                <p>Nowe zapisy są wstrzymane przez inną próbę źródła plikowego.</p>
              )}
              {activeId && (
                <p role="status">
                  Próba jest w kolejce lub trwa pobieranie.{' '}
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => readFetch(activeId)}
                  >
                    Odczytaj wynik pobrania
                  </button>
                </p>
              )}
              <nav aria-label="Pobieranie i harmonogram">
                {(['remote', 'history', 'schedule'] as const).map((value) => (
                  <button
                    type="button"
                    className={'button ' + (tab === value ? 'primary' : '')}
                    key={value}
                    onClick={() => {
                      setTab(value);
                      if (value === 'history') loadHistory();
                    }}
                  >
                    {value === 'remote'
                      ? 'Pobieranie od dostawcy'
                      : value === 'history'
                        ? 'Historia pobrań'
                        : 'Harmonogram'}
                  </button>
                ))}
              </nav>
              {tab === 'remote' && remote && (
                <>
                  <p>
                    Host: {remote.display_host ?? 'Nie zapisano'} · dostęp:{' '}
                    {remote.auth_kind === 'none'
                      ? 'bez danych dostępu'
                      : remote.auth_kind === 'basic'
                        ? 'login i hasło'
                        : remote.auth_kind === 'bearer'
                          ? 'token'
                          : 'nagłówek'}{' '}
                    ·{' '}
                    {remote.has_credentials
                      ? 'dane dostępu zapisane'
                      : 'brak zapisanych danych dostępu'}{' '}
                    · wersja {remote.version} · źródło {remote.source_version}
                  </p>
                  <button
                    type="button"
                    className="button"
                    disabled={ownLocked || busy || externalWriteBlocked}
                    onClick={() => loadConfiguration(true)}
                  >
                    Odczytaj aktualną konfigurację · zastąp edycję
                  </button>
                  {remoteDraft &&
                    (remoteDraft.version !== remote.version ||
                      remoteDraft.sourceVersion !== remote.source_version) && (
                      <p>
                        Konfiguracja zmieniła się. Edycja zachowuje poprzednią wersję; odczytaj
                        aktualną przed nowym zapisem.
                      </p>
                    )}
                  {draftHost && (
                    <p>
                      Host nowego adresu: {draftHost}. Pełny adres i jego parametry nie będą
                      wyświetlane w historii.
                    </p>
                  )}
                  <fieldset disabled={freshDisabled} onChange={() => setRemoteConsent(false)}>
                    <legend>Konfiguracja pobierania</legend>
                    <div className="srf-grid">
                      <label>
                        Nowy adres HTTPS
                        <input
                          type="password"
                          autoComplete="off"
                          value={url}
                          onChange={(e) => setUrl(e.target.value)}
                          placeholder="Pozostaw puste, aby zachować zapisany adres"
                        />
                      </label>
                      <label>
                        Dane dostępu
                        <select
                          value={authAction}
                          onChange={(e) => setAuthAction(e.target.value as typeof authAction)}
                        >
                          <option value="keep">Zachowaj zapisane dane</option>
                          <option value="replace">Zastąp dane</option>
                          <option value="clear">Usuń dane · dostęp bez logowania</option>
                        </select>
                      </label>
                      <label>
                        Zakres pliku
                        <select
                          value={feedScope}
                          onChange={(e) => setFeedScope(e.target.value as typeof feedScope)}
                        >
                          <option value="delta">Zmiany · zachowaj pominięte pozycje</option>
                          <option value="full">Pełny katalog · pokaż brakujące pozycje</option>
                        </select>
                      </label>
                      {authAction === 'replace' && (
                        <>
                          <label>
                            Sposób dostępu
                            <select
                              value={authKind}
                              onChange={(e) => setAuthKind(e.target.value as typeof authKind)}
                            >
                              <option value="bearer">Token</option>
                              <option value="basic">Login i hasło</option>
                              <option value="header">Zatwierdzony nagłówek</option>
                            </select>
                          </label>
                          {authKind === 'basic' ? (
                            <>
                              <label>
                                Login
                                <input
                                  autoComplete="off"
                                  value={username}
                                  onChange={(e) => setUsername(e.target.value)}
                                />
                              </label>
                              <label>
                                Hasło
                                <input
                                  type="password"
                                  autoComplete="new-password"
                                  value={password}
                                  onChange={(e) => setPassword(e.target.value)}
                                />
                              </label>
                            </>
                          ) : authKind === 'bearer' ? (
                            <label>
                              Nowy token
                              <input
                                type="password"
                                autoComplete="new-password"
                                value={token}
                                onChange={(e) => setToken(e.target.value)}
                              />
                            </label>
                          ) : (
                            <>
                              <label>
                                Nazwa nagłówka
                                <input
                                  value={headerName}
                                  onChange={(e) => setHeaderName(e.target.value)}
                                />
                              </label>
                              <label>
                                Nowa wartość nagłówka
                                <input
                                  type="password"
                                  autoComplete="new-password"
                                  value={headerValue}
                                  onChange={(e) => setHeaderValue(e.target.value)}
                                />
                              </label>
                            </>
                          )}
                        </>
                      )}
                    </div>
                    <p>
                      Adres i dane dostępu są wyłącznie do zapisu. Nie odczytujemy sekretów z
                      serwera. Zmiana unieważnia stare podglądy i podstawę świeżości zakupowej.
                    </p>
                  </fieldset>
                  <label className="srf-check">
                    <input
                      type="checkbox"
                      checked={remoteConsent}
                      disabled={freshDisabled}
                      onChange={(e) => setRemoteConsent(e.target.checked)}
                    />
                    Potwierdzam zmianę konfiguracji pobierania tego źródła.
                  </label>
                  <button
                    type="button"
                    className="button"
                    disabled={freshDisabled || !remoteConsent || !remoteDraft}
                    onClick={saveRemote}
                  >
                    Zapisz konfigurację pobierania
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={freshDisabled || !remote.configured || !flags.can_fetch}
                    onClick={() =>
                      start('fetch', 'POST', `/supplier-file-sources/${sourceId}/fetches`, {
                        client_key: crypto.randomUUID(),
                        remote_version: remote.version,
                        source_version: remote.source_version,
                      })
                    }
                  >
                    Pobierz teraz · przygotuj podgląd
                  </button>
                </>
              )}
              {tab === 'schedule' && schedule && remote && (
                <>
                  <p>
                    Aktualnie: {schedule.enabled ? 'włączony' : 'wyłączony'} · wersja{' '}
                    {schedule.version}
                    {schedule.next_at ? ` · następne pobranie ${date(schedule.next_at)}` : ''}
                  </p>
                  {schedule.error_code && <p role="alert">{fetchErrorText(schedule.error_code)}</p>}
                  <button
                    type="button"
                    className="button"
                    disabled={ownLocked || busy || externalWriteBlocked}
                    onClick={() => loadConfiguration(true)}
                  >
                    Odczytaj aktualną konfigurację · zastąp edycję
                  </button>
                  <fieldset
                    disabled={freshDisabled || !flags.can_enable_schedule || !remote.configured}
                    onChange={() => setFutureConsent(false)}
                  >
                    <legend>Przyszłe pobrania i publikacja</legend>
                    <label className="srf-check">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => setEnabled(e.target.checked)}
                      />
                      Włącz harmonogram
                    </label>
                    <label>
                      Odstęp pobrań w minutach
                      <input
                        inputMode="numeric"
                        value={interval}
                        onChange={(e) => setInterval(e.target.value)}
                      />
                    </label>
                    <label className="srf-check">
                      <input
                        type="checkbox"
                        checked={publication.enabled}
                        onChange={(e) =>
                          setPublication((p) => ({ ...p, enabled: e.target.checked }))
                        }
                      />
                      Publikuj poprawny plik do katalogu dostawcy
                    </label>
                    <label className="srf-check">
                      <input
                        type="checkbox"
                        checked={publication.allow_new}
                        disabled={!publication.enabled && !publication.allow_new}
                        onChange={(e) =>
                          setPublication((p) => ({ ...p, allow_new: e.target.checked }))
                        }
                      />
                      Dopuszczaj nowe pozycje zewnętrzne · bez tworzenia własnych produktów
                    </label>
                    <label className="srf-check">
                      <input
                        type="checkbox"
                        checked={publication.withdrawal.enabled}
                        disabled={
                          (!publication.enabled || remote.scope !== 'full') &&
                          !publication.withdrawal.enabled
                        }
                        onChange={(e) =>
                          setPublication((p) => ({
                            ...p,
                            withdrawal: { ...p.withdrawal, enabled: e.target.checked },
                          }))
                        }
                      />
                      Deklaruję pełny katalog i dopuszczam wycofanie brakujących pozycji w podanych
                      granicach
                    </label>
                    <div className="srf-grid">
                      <label>
                        Minimalna liczba wierszy
                        <input
                          inputMode="numeric"
                          value={minRows}
                          onChange={(e) => setMinRows(e.target.value)}
                        />
                      </label>
                      <label>
                        Maksymalna liczba braków
                        <input
                          inputMode="numeric"
                          value={maxMissing}
                          onChange={(e) => setMaxMissing(e.target.value)}
                        />
                      </label>
                      <label>
                        Maksymalny procent braków
                        <input
                          inputMode="numeric"
                          value={maxPercent}
                          onChange={(e) => setMaxPercent(e.target.value)}
                        />
                      </label>
                    </div>
                  </fieldset>
                  <p>
                    Zgoda dotyczy źródła {scheduleDraft?.sourceVersion ?? '—'} i konfiguracji
                    pobierania {scheduleDraft?.remoteVersion ?? '—'}. Przekroczenie granic wymaga
                    osobnej zgody; błąd, pusty plik i odpowiedź „bez zmian” nie wycofują katalogu.
                    Pobranie co 30 minut nie zastępuje świeżości zakupu 15 minut.
                  </p>
                  <label className="srf-check">
                    <input
                      type="checkbox"
                      checked={futureConsent}
                      disabled={freshDisabled || !flags.can_enable_schedule}
                      onChange={(e) => setFutureConsent(e.target.checked)}
                    />
                    Potwierdzam powyższą konfigurację przyszłych pobrań i dozwolonych lokalnych
                    zmian katalogu. Nie tworzą zapasu, PZ ani zamówienia u dostawcy.
                  </label>
                  <button
                    type="button"
                    className="button primary"
                    disabled={
                      freshDisabled ||
                      !futureConsent ||
                      !flags.can_enable_schedule ||
                      !scheduleDraft ||
                      !remote.configured
                    }
                    onClick={saveSchedule}
                  >
                    Zapisz harmonogram
                  </button>
                </>
              )}
              {tab === 'history' && (
                <>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => loadHistory()}
                  >
                    Odczytaj historię pobrań
                  </button>
                  <p>
                    Odczytano {history.length}
                    {total !== null ? ` z ${total}` : ''} prób. Treść plików i dane dostępu nie są
                    wyświetlane.
                  </p>
                  <div className="srf-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Termin</th>
                          <th>Stan</th>
                          <th>Wersje źródła / pobierania</th>
                          <th>Wynik</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((f) => (
                          <tr key={f.id}>
                            <td>{date(f.queued_at)}</td>
                            <td>{stateNames[f.state]}</td>
                            <td>
                              {f.source_version} / {f.remote_version}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="button"
                                disabled={busy}
                                onClick={() => readFetch(f.id)}
                              >
                                Odczytaj wynik
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {cursor && (
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => loadHistory(true)}
                    >
                      Więcej prób
                    </button>
                  )}
                </>
              )}
              {shownFetch && (
                <div className="srf-result">
                  <h4>{stateNames[shownFetch.state]}</h4>
                  <p>
                    Próba {date(shownFetch.queued_at)} · wersja źródła {shownFetch.source_version} ·
                    konfiguracja {shownFetch.remote_version}
                  </p>
                  {shownFetch.error_code && (
                    <p role="alert">
                      {fetchErrorText(shownFetch.error_code, shownFetch.http_status)}
                    </p>
                  )}
                  {shownFetch.http_status === 304 && (
                    <p>
                      Dostawca odpowiedział „bez zmian”. Nie jest to nowy pełny plik; zastosowanie
                      wymaga wskazanego trwałego podglądu.
                    </p>
                  )}
                  {shownFetch.summary && (
                    <p>
                      Wiersze: {shownFetch.summary.total ?? '—'} · błędne:{' '}
                      {shownFetch.summary.invalid ?? '—'} · brakujące:{' '}
                      {shownFetch.summary.missing ?? '—'}
                    </p>
                  )}
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => readFetch(shownFetch.id)}
                  >
                    Odczytaj wynik ponownie
                  </button>
                  {shownFetch.preview_id && (
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy || !!state?.inFlight}
                      onClick={() => onPreview(shownFetch.preview_id!)}
                    >
                      {actualPublicationId
                        ? 'Otwórz zastosowany podgląd'
                        : 'Otwórz pełny podgląd · osobna zgoda na zastosowanie'}
                    </button>
                  )}
                  {actualPublicationId && (
                    <>
                      <p>
                        Publikację zapisano w historii uzgodnień źródła plikowego. Pobranie samo nie
                        dowodzi przyjęcia towaru.
                      </p>
                      {onHistory && (
                        <button
                          type="button"
                          className="button"
                          disabled={busy}
                          onClick={onHistory}
                        >
                          Otwórz historię uzgodnień katalogu
                        </button>
                      )}
                    </>
                  )}
                  <details>
                    <summary>Dowód pobrania</summary>
                    <p>
                      HTTP: {shownFetch.http_status ?? '—'} · odebrane bajty:{' '}
                      {shownFetch.wire_bytes ?? '—'} · treść UTF-8:{' '}
                      {shownFetch.decoded_bytes ?? '—'}
                    </p>
                    <p>Odebrany plik: {shownFetch.wire_hash ?? '—'}</p>
                    <p>Treść podglądu: {shownFetch.raw_hash ?? '—'}</p>
                  </details>
                </div>
              )}
              <p className="srf-hint">
                Limity bieżącego procesu: 500 wierszy, 2 MiB pliku, 10 000 pozycji źródła. Limit lub
                błąd nie usuwa historii i nie zeruje dostępności. Ilość dostawcy nie jest własnym
                zapasem.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
