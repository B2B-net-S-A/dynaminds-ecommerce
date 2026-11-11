import { useEffect, useRef, useState } from 'react';
import { ApiError, date } from './api';
import './catalog-export-profiles.css';

export type CatalogExportProfileDefinition = {
  catalog_id?: string;
  format: 'csv' | 'xml';
  columns: string[];
  headers: Record<string, string>;
  spreadsheet_safe: boolean;
  warehouse_ids?: string[];
  price_list_ids?: string[];
};
type Profile = {
  id: string;
  name: string;
  version: number;
  definition: CatalogExportProfileDefinition;
  archived: boolean;
  created_at?: string;
  updated_at?: string;
};
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_manage: boolean;
};
type List = Flags & { data: Profile[]; limit: number };
type Detail = Flags & { profile: Profile; reused?: boolean };
type Attempt = {
  kind: 'create' | 'update' | 'archive' | 'restore';
  path: string;
  method: 'POST' | 'PATCH';
  body: Record<string, unknown>;
  label: string;
  targetId?: string;
};
export type CatalogExportCatalog = { id: string; name: string; active: boolean; is_default: boolean; version: string; warehouse_ids: string[]; price_list_ids: string[] };
let exportActor = '';
const profileAttempts = new Map<string, Attempt>();
const readLocks = new Set<string>();
const lockListeners = new Map<string, Set<(locked: boolean) => void>>();
export function catalogExportLocked(contextKey: string) { return profileAttempts.has(contextKey) || readLocks.has(contextKey); }
function publishLock(contextKey: string) { for (const callback of lockListeners.get(contextKey) ?? []) callback(catalogExportLocked(contextKey)); }
export function subscribeCatalogExportLock(contextKey: string, callback: (locked: boolean) => void) { const set = lockListeners.get(contextKey) ?? new Set(); set.add(callback); lockListeners.set(contextKey, set); callback(catalogExportLocked(contextKey)); return () => { set.delete(callback); if (!set.size) lockListeners.delete(contextKey); }; }
export function setCatalogExportReadLocked(contextKey: string, locked: boolean) { if (exportActor !== contextKey) return; if (locked) readLocks.add(contextKey); else readLocks.delete(contextKey); publishLock(contextKey); }
export function resetCatalogExportProfileContext(contextKey: string) { if (exportActor === contextKey) return; const old = new Set([...profileAttempts.keys(), ...readLocks]); exportActor = contextKey; profileAttempts.clear(); readLocks.clear(); for (const key of old) publishLock(key); }
export type CatalogExportProfilesProps = {
  workspaceId: string;
  contextKey: string;
  readOnly: boolean;
  definition: CatalogExportProfileDefinition;
  columns: { key: string; label: string; type?: string; unit?: string }[];
  warehouses?: { id: string; name: string; code?: string }[];
  price_lists?: { id: string; name: string; currency: string }[];
  catalogs?: CatalogExportCatalog[];
  catalogRequired?: boolean;
  externalWriteBlocked?: boolean;
  onApply: (
    definition: CatalogExportProfileDefinition,
    profile: { id: string; name: string; version: number },
  ) => void;
  onError?: (message: string) => void;
};
const prefix = '/catalog/export-profiles';
const copyDefinition = (d: CatalogExportProfileDefinition): CatalogExportProfileDefinition => ({
  ...(d.catalog_id ? { catalog_id: d.catalog_id } : {}),
  format: d.format,
  columns: [...d.columns],
  headers: { ...d.headers },
  spreadsheet_safe: d.spreadsheet_safe,
  ...(Object.prototype.hasOwnProperty.call(d, 'warehouse_ids')
    ? { warehouse_ids: d.warehouse_ids === undefined ? undefined : [...d.warehouse_ids] }
    : {}),
  ...(Object.prototype.hasOwnProperty.call(d, 'price_list_ids')
    ? { price_list_ids: d.price_list_ids === undefined ? undefined : [...d.price_list_ids] }
    : {}),
});
const definitionIdentity = (d: CatalogExportProfileDefinition) => JSON.stringify({ ...copyDefinition(d), headers: Object.fromEntries(Object.entries(d.headers).sort(([a], [b]) => a.localeCompare(b))) });

export function CatalogExportProfiles({
  workspaceId,
  contextKey,
  readOnly,
  definition,
  columns,
  warehouses,
  price_lists,
  catalogs,
  catalogRequired = false,
  externalWriteBlocked = false,
  onApply,
  onError,
}: CatalogExportProfilesProps) {
  const [flags, setFlags] = useState<Flags | null>(null);
  const [data, setData] = useState<Profile[]>([]);
  const [limit, setLimit] = useState(200);
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [selected, setSelected] = useState<Profile | null>(null);
  const [newName, setNewName] = useState('');
  const [editName, setEditName] = useState('');
  const [confirmedUpdate, setConfirmedUpdate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [conflict, setConflict] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState<{ id: string; name: string; version: number } | null>(
    null,
  );
  const epoch = useRef(0),
    requestId = useRef(0);
  const inFlight = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const controller = useRef<AbortController | null>(null);
  const authorizedContext = useRef<string | null>(null);
  const currentContext = useRef('');
  currentContext.current = `${contextKey}:${workspaceId}:${readOnly}`;
  const selectionRef = useRef(selected?.id ?? null);
  selectionRef.current = selected?.id ?? null;
  const definitionKey = JSON.stringify(definition);
  const readAllowed =
    !!flags?.available &&
    flags.can_read &&
    !blocked &&
    authorizedContext.current === currentContext.current;
  const manageAllowed = readAllowed && !!flags?.can_manage && !readOnly && !flags?.read_only;
  const latestExternalBlock = useRef(externalWriteBlocked);
  latestExternalBlock.current = externalWriteBlocked;

  function acceptFlags(d: Flags) {
    if (!d.can_read) { purge(); return; }
    authorizedContext.current = currentContext.current;
    setFlags({
      available: d.available,
      read_only: d.read_only,
      current_role: d.current_role,
      can_read: d.can_read,
      can_manage: d.can_manage,
    });
  }
  function purge() {
    authorizedContext.current = null;
    setBlocked(true);
    setFlags(null);
    setData([]);
    setSelected(null);
    setNewName('');
    setEditName('');
    setApplied(null);
    setConfirmedUpdate(false);
    attempt.current = null;
    setPending(null);
    profileAttempts.delete(contextKey); publishLock(contextKey);
  }
  function fail(err: unknown) {
    const message = err instanceof Error ? err.message : 'Nie udało się odczytać profili eksportu.';
    setError(message);
    onError?.(message);
    if (err instanceof ApiError && [401, 403].includes(err.status)) purge();
    if (err instanceof ApiError && err.status === 423) {
      setFlags((old) => (old ? { ...old, read_only: true, can_manage: false } : old));
    }
  }
  async function request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body: unknown,
    abort: AbortController,
    expectedEpoch: number,
  ): Promise<T> {
    const context = currentContext.current;
    const response = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'X-Workspace-ID': workspaceId,
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      signal: abort.signal,
    });
    const result = await response.json();
    if (
      expectedEpoch !== epoch.current ||
      context !== currentContext.current ||
      abort.signal.aborted
    )
      throw new DOMException('Organizacja lub uprawnienia zostały zmienione.', 'AbortError');
    if (!response.ok) {
      if (result.code === 'MFA_REQUIRED')
        window.dispatchEvent(
          new CustomEvent('dyna:mfa-required', { detail: { workspace: workspaceId } }),
        );
      throw new ApiError(
        result.detail ?? `Operacja nie powiodła się (HTTP ${response.status}).`,
        response.status,
        result.code,
      );
    }
    return result as T;
  }
  async function loadList(expectedEpoch = epoch.current) {
    if (inFlight.current) return;
    const selectedBefore = selected,
      draftName = editName;
    const r = ++requestId.current,
      abort = new AbortController();
    controller.current = abort;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await request<List>(prefix, 'GET', undefined, abort, expectedEpoch);
      if (expectedEpoch !== epoch.current || r !== requestId.current) return;
      acceptFlags(result);
      if (!result.available || !result.can_read) {
        setData([]);
        setSelected(null);
        return;
      }
      if (result.data.length > result.limit)
        throw Error('Odczyt profili przekroczył limit; lista nie została obcięta.');
      setLimit(result.limit);
      setData(result.data);
      const existing = result.data.find((p) => p.id === selectionRef.current);
      setSelected(existing ?? null);
      if (
        existing &&
        (!selectedBefore || selectedBefore.id !== existing.id || draftName === selectedBefore.name)
      )
        setEditName(existing.name);
      setConfirmedUpdate(false);
      setConflict(false);
      if (attempt.current)
        setStatus(
          'Lista została odczytana. Niepewna próba nadal wymaga dokładnego ponowienia; odczyt nie zapisuje profilu.',
        );
    } catch (err) {
      if (expectedEpoch === epoch.current && !abort.signal.aborted) fail(err);
    } finally {
      if (expectedEpoch === epoch.current && r === requestId.current) {
        inFlight.current = false;
        controller.current = null;
        setBusy(false);
        setLoading(false);
      }
    }
  }
  async function loadSelected() {
    if (!readAllowed || !selected || inFlight.current) return;
    const id = selected.id,
      storedName = selected.name,
      draftName = editName,
      e = epoch.current,
      r = ++requestId.current,
      abort = new AbortController();
    controller.current = abort;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await request<Detail>(prefix + '/' + id, 'GET', undefined, abort, e);
      if (e !== epoch.current || r !== requestId.current || selectionRef.current !== id) return;
      acceptFlags(result);
      setSelected(result.profile);
      if (draftName === storedName) setEditName(result.profile.name);
      setData((old) => old.map((p) => (p.id === id ? result.profile : p)));
      setConfirmedUpdate(false);
      setConflict(false);
      setStatus(
        'Odczytano bieżącą wersję profilu. Bieżące ustawienia eksportu pozostają bez zmian.',
      );
    } catch (err) {
      if (e === epoch.current && !abort.signal.aborted) fail(err);
    } finally {
      if (e === epoch.current && r === requestId.current) {
        inFlight.current = false;
        controller.current = null;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    const e = ++epoch.current;
    resetCatalogExportProfileContext(contextKey);
    controller.current?.abort();
    controller.current = null;
    inFlight.current = false;
    authorizedContext.current = null;
    if (readOnly) { profileAttempts.delete(contextKey); publishLock(contextKey); }
    attempt.current = profileAttempts.get(contextKey) ?? null;
    setPending(attempt.current);
    setFlags(null);
    setData([]);
    setSelected(null);
    selectionRef.current = null;
    setNewName('');
    setEditName('');
    setConfirmedUpdate(false);
    setConflict(false);
    setBlocked(false);
    setApplied(null);
    setError('');
    setStatus('');
    setTab('active');
    setBusy(false);
    setLoading(true);
    void loadList(e);
    return () => {
      ++epoch.current;
      ++requestId.current;
      controller.current?.abort();
    };
  }, [contextKey, workspaceId, readOnly]);
  useEffect(() => {
    setConfirmedUpdate(false);
  }, [definitionKey, editName, selected?.id, selected?.version]);

  function choose(id: string) {
    const p = data.find((row) => row.id === id) ?? null;
    setSelected(p);
    setEditName(p?.name ?? '');
    setConfirmedUpdate(false);
    setConflict(false);
    setError('');
    setStatus('');
  }
  function checkDefinition(d: CatalogExportProfileDefinition, saving = false) {
    if (saving && catalogRequired && !d.catalog_id) throw Error('Wybierz katalog przed zapisaniem profilu.');
    if (d.catalog_id) {
      const catalog = catalogs?.find((c) => c.id === d.catalog_id);
      if (!catalog || !catalog.active) throw Error('Katalog profilu jest niedostępny lub nieaktywny. Wybierz aktualny katalog.');
      if (d.warehouse_ids?.some((id) => !catalog.warehouse_ids.includes(id)) || d.price_list_ids?.some((id) => !catalog.price_list_ids.includes(id))) throw Error('Źródła profilu nie należą do wybranego katalogu. Sprawdź jego przypisania.');
    }
    if (
      !['csv', 'xml'].includes(d.format) ||
      !d.columns.length ||
      d.columns.length > columns.length
    )
      throw Error(
        `Wybierz format CSV lub XML i od 1 do ${columns.length} dostępnych pól w bieżącym eksporcie.`,
      );
    if (
      new Set(d.columns).size !== d.columns.length ||
      d.columns.some((key) => !columns.some((c) => c.key === key))
    )
      throw Error(
        'Konfiguracja zawiera powtórzone lub niedostępne pola. Popraw ją w bieżącym eksporcie.',
      );
    if (Object.keys(d.headers).some((key) => !d.columns.includes(key)))
      throw Error(
        'Nagłówki mogą dotyczyć wyłącznie wybranych pól. Popraw bieżącą konfigurację eksportu.',
      );
    for (const [field, ids, label] of [
      ['inventory_json', d.warehouse_ids, 'magazynów'],
      ['prices_json', d.price_list_ids, 'cenników'],
    ] as const) {
      if (ids !== undefined && !d.columns.includes(field))
        throw Error(
          `Wybrane źródła ${label} wymagają odpowiadającego im pola eksportu. Popraw bieżącą konfigurację; źródeł nie usunięto automatycznie.`,
        );
      if (
        d.columns.includes(field) &&
        (!ids || ids.length < 1 || ids.length > 10 || new Set(ids).size !== ids.length)
      )
        throw Error(
          `Dla wybranego pola wybierz od 1 do 10 różnych ${label}. Popraw bieżącą konfigurację eksportu.`,
        );
    }
  }
  function name(value: string) {
    const n = value.trim();
    if (!n || n.length > 120) throw Error('Nazwa profilu musi zawierać od 1 do 120 znaków.');
    return n;
  }
  async function apply() {
    if (!readAllowed || !selected || selected.archived || inFlight.current || attempt.current || externalWriteBlocked)
      return;
    const e = epoch.current, id = selected.id, abort = new AbortController();
    inFlight.current = true; setBusy(true); controller.current = abort;
    try {
      const result = await request<Detail>(prefix + '/' + id, 'GET', undefined, abort, e);
      if (e !== epoch.current || selectionRef.current !== id || latestExternalBlock.current) return;
      acceptFlags(result);
      if (!result.available || !result.can_read || result.profile?.id !== id || result.profile.archived) throw Error('Profil jest niedostępny. Odczytaj listę ponownie.');
      checkDefinition(result.profile.definition);
      const meta = { id, name: result.profile.name, version: result.profile.version };
      onApply(copyDefinition(result.profile.definition), meta);
      setSelected(result.profile);
      setApplied(meta);
      setError('');
      setStatus(
        'Skopiowano konfigurację profilu do bieżącego eksportu. Produkty i filtry nie zostały zmienione; plik nie został pobrany.',
      );
    } catch (err) {
      if (e === epoch.current && !abort.signal.aborted) fail(err);
    } finally {
      if (e === epoch.current) { inFlight.current = false; setBusy(false); controller.current = null; }
    }
  }
  async function execute(a: Attempt) {
    const retained = profileAttempts.get(contextKey) === a;
    if (!manageAllowed || inFlight.current || (attempt.current && attempt.current !== a) || (!retained && externalWriteBlocked)) return;
    const e = epoch.current,
      r = ++requestId.current,
      abort = new AbortController();
    attempt.current = a;
    profileAttempts.set(contextKey, a); publishLock(contextKey);
    setPending(a);
    controller.current = abort;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    let sent = false;
    try {
      const access = await request<Flags>(prefix, 'GET', undefined, abort, e);
      if (!access.available || !access.can_read || !access.can_manage || access.read_only) throw new ApiError('Brak bieżącego prawa zapisu profilu.', access.read_only ? 423 : 403);
      const me = await request<{ user: { tenant_id: string; id: string; role: string } }>('/auth/me', 'GET', undefined, abort, e);
      if (`${me.user?.tenant_id}:${me.user?.id}:${me.user?.role}` !== contextKey.split(':').slice(0, 3).join(':')) throw new ApiError('Zmienił się użytkownik lub firma.', 403);
      if (!retained && latestExternalBlock.current) throw Error('Nowe zapisy są zablokowane. Zapis profilu nie został wysłany.');
      sent = true;
      const result = await request<Detail>(a.path, a.method, a.body, abort, e);
      if (e !== epoch.current || r !== requestId.current) return;
      acceptFlags(result);
      if (
        !result.available || !result.can_read || !result.profile ||
        typeof result.reused !== 'boolean' || !/^[a-f0-9-]{36}$/i.test(result.profile.id) ||
        !Number.isSafeInteger(result.profile.version) || result.profile.version < 1 ||
        typeof result.profile.name !== 'string' || typeof result.profile.archived !== 'boolean' ||
        !result.profile.definition || !Array.isArray(result.profile.definition.columns) ||
        (a.targetId && result.profile.id !== a.targetId) ||
        (a.kind === 'create' && !result.reused && (
          result.profile.version !== 1 || result.profile.name !== a.body.name ||
          definitionIdentity(result.profile.definition) !== definitionIdentity(a.body.definition as CatalogExportProfileDefinition)
        )) ||
        (a.kind === 'update' && (
          result.profile.version !== Number(a.body.version) + 1 || result.profile.name !== a.body.name ||
          definitionIdentity(result.profile.definition) !== definitionIdentity(a.body.definition as CatalogExportProfileDefinition)
        )) ||
        (['archive', 'restore'].includes(a.kind) && (
          result.profile.archived !== (a.kind === 'archive') ||
          result.profile.version !== Number(a.body.version) + (result.reused ? 0 : 1)
        ))
      )
        throw Error(
          'Odpowiedź nie potwierdza zapisu profilu. Odczytaj listę i ponów tę samą próbę.',
        );
      setData((old) => {
        const found = old.some((p) => p.id === result.profile.id);
        return found
          ? old.map((p) => (p.id === result.profile.id ? result.profile : p))
          : [...old, result.profile];
      });
      setSelected(result.profile);
      setEditName(result.profile.name);
      setTab(result.profile.archived ? 'archived' : 'active');
      setConflict(false);
      setConfirmedUpdate(false);
      if (a.kind === 'create') setNewName('');
      attempt.current = null;
      setPending(null);
      profileAttempts.delete(contextKey); publishLock(contextKey);
      setStatus(
        result.reused
          ? a.kind === 'create'
            ? 'Odnaleziono wcześniej utworzony profil; wyświetlono jego bieżącą wersję. Nie wykonano ponownego zapisu.'
            : 'Stan profilu był już zgodny z próbą; odczytano jego bieżącą wersję bez ponownej zmiany.'
          : a.kind === 'archive'
            ? 'Profil zarchiwizowany. Można go przywrócić; użyta wcześniej kopia eksportu pozostaje bez zmian.'
            : a.kind === 'restore'
              ? 'Profil przywrócony. Zastosuj go jawnie, aby zmienić konfigurację eksportu.'
              : 'Profil zapisany. Bieżący eksport nie został pobrany ani automatycznie zmieniony.',
      );
    } catch (err) {
      if (e !== epoch.current || abort.signal.aborted) return;
      if ((!sent && !retained) || (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status))) {
        attempt.current = null;
        setPending(null);
        profileAttempts.delete(contextKey); publishLock(contextKey);
        setConfirmedUpdate(false);
        if (err instanceof ApiError && err.status === 409) {
          setConflict(a.kind !== 'create');
          setStatus(
            a.kind === 'create'
              ? 'Sprawdź podany błąd i odczytaj listę profili. Szkic nazwy i bieżąca konfiguracja eksportu pozostają zachowane.'
              : 'Wersja lub stan profilu uległy zmianie. Odczytaj wybrany profil i sprawdź różnice przed nowym zatwierdzeniem. Nie zmieniono bieżącej konfiguracji eksportu.',
          );
        }
        fail(err);
      } else {
        setError(
          'Wynik zapisu jest niepewny. Zatrzymano kolejne zmiany. Ponów ręcznie dokładnie tę samą próbę; nie twórz nowego profilu z nowym kluczem.',
        );
      }
    } finally {
      if (e === epoch.current && r === requestId.current) {
        inFlight.current = false;
        controller.current = null;
        setBusy(false);
      }
    }
  }
  function create() {
    if (!manageAllowed || inFlight.current || attempt.current || externalWriteBlocked) return;
    try {
      const n = name(newName);
      checkDefinition(definition, true);
      void execute({
        kind: 'create',
        path: prefix,
        method: 'POST',
        label: 'Utworzenie profilu „' + n + '”',
        body: { name: n, definition: copyDefinition(definition), client_key: crypto.randomUUID() },
      });
    } catch (err) {
      fail(err);
    }
  }
  function update() {
    if (
      !manageAllowed ||
      !selected ||
      selected.archived ||
      conflict ||
      !confirmedUpdate ||
      inFlight.current ||
      attempt.current
      || externalWriteBlocked
    )
      return;
    try {
      const n = name(editName);
      checkDefinition(definition, true);
      void execute({
        kind: 'update',
        path: prefix + '/' + selected.id,
        method: 'PATCH',
        targetId: selected.id,
        label: 'Aktualizacja profilu „' + selected.name + '”, wersja ' + selected.version,
        body: { version: selected.version, name: n, definition: copyDefinition(definition) },
      });
    } catch (err) {
      fail(err);
    }
  }
  function archiveOrRestore() {
    if (!manageAllowed || !selected || conflict || inFlight.current || attempt.current || externalWriteBlocked) return;
    const kind = selected.archived ? 'restore' : 'archive';
    void execute({
      kind,
      path: `${prefix}/${selected.id}/${kind}`,
      method: 'POST',
      targetId: selected.id,
      label:
        (kind === 'archive' ? 'Archiwizacja' : 'Przywrócenie') + ' profilu „' + selected.name + '”',
      body: { version: selected.version },
    });
  }
  function definitionView(d: CatalogExportProfileDefinition) {
    return (
      <div className="cep-definition">
        <p>
          {d.format.toUpperCase()} · {d.columns.length} pól
          {d.format === 'csv'
            ? d.spreadsheet_safe
              ? ' · do arkusza'
              : ' · do wymiany danych'
            : ''}
        </p>
        <p>Katalog: {d.catalog_id ? catalogs?.find((c) => c.id === d.catalog_id)?.name ?? d.catalog_id : 'Starszy profil bez zakresu katalogu — wybierz katalog przed eksportem.'}</p>
        <ol>
          {d.columns.map((key) => (
            <li key={key}>
              {columns.find((c) => c.key === key)?.label ?? key}
              <span> — nagłówek: {d.headers[key] ?? key}</span>
            </li>
          ))}
        </ol>
        {d.warehouse_ids !== undefined && (
          <p>
            Wybrane magazyny:{' '}
            {d.warehouse_ids.length
              ? d.warehouse_ids
                  .map((id) => {
                    const warehouse = warehouses?.find((w) => w.id === id);
                    return warehouse
                      ? `${warehouse.name}${warehouse.code ? ` (${warehouse.code})` : ''}`
                      : id;
                  })
                  .join(', ')
              : 'brak'}
          </p>
        )}
        {d.price_list_ids !== undefined && (
          <p>
            Wybrane cenniki:{' '}
            {d.price_list_ids.length
              ? d.price_list_ids
                  .map((id) => {
                    const list = price_lists?.find((p) => p.id === id);
                    return list ? `${list.name} (${list.currency})` : id;
                  })
                  .join(', ')
              : 'brak'}
          </p>
        )}
      </div>
    );
  }
  const shown = data.filter((p) => p.archived === (tab === 'archived'));
  return (
    <section className="catalog-export-profiles" aria-label="Zapisane profile eksportu">
      <div className="cep-heading">
        <div>
          <h3>Profile eksportu</h3>
          <p>
            Zapisz format, pola, ich kolejność, nazwy nagłówków oraz wybrane źródła stanów i cen.
            Produkty oraz filtry wybierasz osobno.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={busy || blocked}
          onClick={() => void loadList()}
        >
          Odczytaj listę profili
        </button>
      </div>
      {error && (
        <p className="cep-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="cep-status" role="status">
          {status}
        </p>
      )}
      {loading && <p role="status">Odczytywanie profili…</p>}
      {flags && !flags.available && <p>Profile eksportu nie są dostępne w tej kopii aplikacji.</p>}
      {flags?.available && !flags.can_read && (
        <p>Nie masz bieżącego dostępu do profili eksportu.</p>
      )}
      {pending && (
        <div className="cep-pending" role="status">
          <strong>
            {busy ? 'Trwa próba zapisu: ' : 'Niepewna próba: '}
            {pending.label}
          </strong>
          <p>
            Dokładna treść i klucz pozostają w pamięci tego aktora także po zamknięciu panelu. Pełne odświeżenie aplikacji usuwa tę pamięć.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={busy || !manageAllowed}
            onClick={() => void execute(pending)}
          >
            Ponów dokładnie tę samą próbę
          </button>
          <p>
            Aktualizacja i archiwizacja sprawdzają wersję. Jeżeli wcześniejszy zapis doszedł do
            skutku, ponowienie może zwrócić konflikt; wtedy odczytaj wybrany profil.
          </p>
        </div>
      )}
      {readAllowed && (
        <>
          <div className="cep-select">
            <label>
              Pokaż profile
              <select
                value={tab}
                disabled={busy || !!pending}
                onChange={(e) => {
                  setTab(e.target.value as 'active' | 'archived');
                  choose('');
                }}
              >
                <option value="active">Aktywne · {data.filter((p) => !p.archived).length}</option>
                <option value="archived">
                  Archiwalne · {data.filter((p) => p.archived).length}
                </option>
              </select>
            </label>
            <label>
              Wybierz profil
              <select
                value={selected?.id ?? ''}
                disabled={busy || !!pending}
                onChange={(e) => choose(e.target.value)}
              >
                <option value="">— Wybierz profil —</option>
                {shown.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name} · wersja {p.version}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!shown.length && (
            <p>
              {tab === 'active'
                ? 'Brak aktywnych profili. Możesz ustawić eksport ręcznie.'
                : 'Brak zarchiwizowanych profili.'}
            </p>
          )}
          <p className="cep-hint">
            Odczytano {data.length} profili; limit firmy: {limit}. Zastosowanie profilu nie pobiera
            pliku. To kopia konfiguracji — późniejsze zmiany profilu jej nie zmieniają.
          </p>
          {applied && (
            <p className="cep-hint">
              Użyta kopia: {applied.name}, wersja {applied.version}. Możesz dalej edytować bieżący
              eksport.
            </p>
          )}
          {selected && (
            <div className="cep-selected">
              <h4>
                {selected.name} · wersja {selected.version}
                {selected.archived ? ' · archiwalny' : ''}
              </h4>
              {selected.updated_at && <p>Ostatnia zmiana: {date(selected.updated_at)}</p>}
              <details>
                <summary>Konfiguracja zapisanej wersji</summary>
                {definitionView(selected.definition)}
              </details>
              <div className="cep-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || !!pending || selected.archived || externalWriteBlocked}
                  onClick={() => void apply()}
                >
                  Użyj profilu
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy || !!pending}
                  onClick={() => void loadSelected()}
                >
                  Odczytaj wybrany profil
                </button>
              </div>
              {selected.archived && (
                <p>Profil jest zarchiwizowany. Administrator może go przywrócić przed użyciem.</p>
              )}
              {manageAllowed && (
                <div className="cep-editor">
                  <label>
                    Nazwa wybranego profilu
                    <input
                      value={editName}
                      disabled={busy || !!pending || selected.archived}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                  </label>
                  <p>
                    Aktualizacja zastąpi konfigurację profilu bieżącymi ustawieniami eksportu
                    pokazanymi poniżej.
                  </p>
                  {!selected.archived && (
                    <label className="cep-checkbox">
                      <input
                        type="checkbox"
                        checked={confirmedUpdate}
                        disabled={busy || !!pending || conflict}
                        onChange={(e) => setConfirmedUpdate(e.target.checked)}
                      />
                      Potwierdzam zastąpienie konfiguracji wybranego profilu, wersja{' '}
                      {selected.version}.
                    </label>
                  )}
                  <div className="cep-actions">
                    {!selected.archived && (
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy || !!pending || conflict || !confirmedUpdate || externalWriteBlocked}
                        onClick={update}
                      >
                        Zaktualizuj wybrany profil
                      </button>
                    )}
                    <button
                      type="button"
                      className="button"
                      disabled={busy || !!pending || conflict || externalWriteBlocked}
                      onClick={archiveOrRestore}
                    >
                      {selected.archived ? 'Przywróć profil' : 'Archiwizuj profil'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {manageAllowed && (
            <div className="cep-create">
              <details>
                <summary>Bieżąca konfiguracja do zapisania</summary>
                {definitionView(definition)}
              </details>
              <label>
                Nazwa nowego profilu
                <input
                  value={newName}
                  disabled={busy || !!pending}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Np. Katalog dla hurtowni"
                />
              </label>
              <button
                type="button"
                className="button primary"
                disabled={busy || !!pending || data.length >= limit || externalWriteBlocked}
                onClick={create}
              >
                Zapisz bieżące ustawienia jako nowy profil
              </button>
              {data.length >= limit && (
                <p>
                  Osiągnięto limit profili. Archiwizacja zachowuje profil i nie zwalnia miejsca;
                  zaktualizuj istniejący profil.
                </p>
              )}
            </div>
          )}
          {!manageAllowed && (
            <p className="cep-hint">
              Możesz używać aktywnych profili. Tworzenie, zmiana i archiwizacja wymagają bieżących
              uprawnień administratora oraz trybu umożliwiającego zapis.
            </p>
          )}
        </>
      )}
    </section>
  );
}
