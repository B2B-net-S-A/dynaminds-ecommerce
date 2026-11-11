import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api, ApiError, date } from './api';
import { WmsReturnLotsFields, type WmsReturnLotsPayload } from './wms-lots';
import type {
  B2bDropshipReturnSource,
  B2bDropshipReturnPreview,
  B2bDropshipReturnPreviewRow,
  B2bDropshipReturnCase,
  B2bDropshipReturnContext as DropshipReturnContext,
  B2bDropshipReturnEvent,
} from '../server/b2b-dropshipping-returns-schema';
import type { B2bReturnLocalContext } from '../server/b2b-return-local-origins-schema';
import './b2b-dropshipping-returns.css';

const prefix = '/b2b/dropshipping-returns';
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_read_value: boolean;
  can_preview?: boolean;
  can_submit?: boolean;
  can_manage?: boolean;
};
type Attempt = {
  action: string;
  path: string;
  method: 'POST' | 'PATCH';
  body: string;
  retryable?: boolean;
  // Opt-in for the durable B2B bind protocol; legacy status handling stays unchanged.
  retainRateLimited?: boolean;
};
const attempts = new Map<string, Attempt>();
const inFlight = new Map<string, symbol>();
const registryListeners = new Set<() => void>();
let registryRevision = 0;
let registryEpoch = 0;
let actorScope = '';
function registryChanged() {
  ++registryRevision;
  for (const listener of registryListeners) listener();
}
function subscribeRegistry(listener: () => void) {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}
function registrySnapshot() {
  return registryRevision;
}
function actorKey(contextKey: string, readOnly: boolean) {
  return `${contextKey}:${readOnly}`;
}
export function resetDropshipReturnContext(contextKey: string, readOnly: boolean) {
  const next = actorKey(contextKey, readOnly);
  if (next !== actorScope) {
    attempts.clear();
    inFlight.clear();
    ++registryEpoch;
    actorScope = next;
    registryChanged();
  }
}
function clearAttempts() {
  attempts.clear();
  inFlight.clear();
  ++registryEpoch;
  registryChanged();
}
export function purgeDropshipReturnAttempts(contextKey: string, readOnly: boolean) {
  if (actorKey(contextKey, readOnly) === actorScope) clearAttempts();
}
export function useDropshipReturnWriteState(contextKey: string, readOnly: boolean) {
  useSyncExternalStore(subscribeRegistry, registrySnapshot, registrySnapshot);
  const actor = actorKey(contextKey, readOnly);
  const current = actor === actorScope;
  return {
    locked: !current || attempts.size > 0 || inFlight.size > 0,
    entries: current
      ? [...attempts].map(([scope, attempt]) => ({ scope, attempt, inFlight: inFlight.has(scope) }))
      : [],
  };
}
/** Called synchronously before the HTTP request; only the stored owner's exact attempt can retry. */
export async function performDropshipReturnWrite<T>(
  contextKey: string,
  readOnly: boolean,
  scope: string,
  attempt: Attempt,
  validateReply?: (reply: T) => void,
): Promise<T> {
  const actor = actorKey(contextKey, readOnly);
  if (readOnly || actor !== actorScope || !scope.startsWith(actor + ':'))
    throw Error('Kontekst firmy lub tryb zapisu zmienił się. Odczytaj ponownie widok.');
  const stored = attempts.get(scope);
  if (inFlight.size || (attempts.size && (!stored || attempts.size !== 1)))
    throw Error('Inny zapis zwrotu wymaga potwierdzenia. Nowe zapisy są wstrzymane.');
  if (stored?.retryable === false)
    throw Error(
      'Ten zapis nie obsługuje bezpiecznego ponowienia. Odczytaj istniejące konto lub zaproszenie; blokada pozostaje w bieżącej firmie.',
    );
  if (
    stored &&
    (stored.path !== attempt.path ||
      stored.method !== attempt.method ||
      stored.body !== attempt.body)
  )
    throw Error('Niepewną próbę można ponowić wyłącznie z jej zapisaną treścią.');
  const frozen = stored ?? { ...attempt };
  const token = Symbol('return-write'),
    generation = registryEpoch;
  attempts.set(scope, frozen);
  inFlight.set(scope, token);
  registryChanged();
  const current = () => registryEpoch === generation && actorScope === actor;
  try {
    const reply = await api<T>(frozen.path, frozen.method, JSON.parse(frozen.body));
    if (!current())
      throw Error('Kontekst firmy zmienił się. Wynik odczytaj w historii właściwej firmy.');
    validateReply?.(reply);
    attempts.delete(scope);
    registryChanged();
    return reply;
  } catch (error) {
    if (current() && error instanceof ApiError) {
      if ([401, 403, 423].includes(error.status)) clearAttempts();
      else if (([400, 404, 409, 413, 422, 429].includes(error.status) && !(frozen.retainRateLimited && error.status === 429)) || (frozen.retainRateLimited && error.status === 414)) {
        attempts.delete(scope);
        registryChanged();
      }
    }
    throw error;
  } finally {
    if (current() && inFlight.get(scope) === token) {
      inFlight.delete(scope);
      registryChanged();
    }
  }
}
function amount(value: string | number | null | undefined, currency: string) {
  if (
    value == null ||
    !/^-?\d+$/.test(String(value)) ||
    (typeof value === 'number' && !Number.isSafeInteger(value))
  )
    return 'Brak danych';
  const n = BigInt(value),
    absolute = n < 0n ? -n : n;
  return `${n < 0n ? '−' : ''}${(absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')},${String(absolute % 100n).padStart(2, '0')} ${currency}`;
}
function minor(text: string) {
  const value = text.trim().replace(',', '.');
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value))
    throw Error('Podaj nieujemną kwotę z maksymalnie dwoma miejscami po przecinku');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result > 1000000n) throw Error('Kwota przekracza dopuszczalny zakres');
  return Number(result);
}
function integer(text: string, maximum: number) {
  if (!/^(0|[1-9]\d*)$/.test(text) || BigInt(text) > BigInt(maximum))
    throw Error('Podaj całkowitą ilość w pokazanym zakresie');
  return Number(text);
}
function useReturnIO(scope: string, contextKey: string, readOnly: boolean, purge: () => void, guardFreshWrite?: (exactRetry?: boolean) => Promise<() => void>) {
  const shared = useDropshipReturnWriteState(contextKey, readOnly);
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [flags, setFlags] = useState<Flags | null>(null);
  const pending = shared.entries.find((entry) => entry.scope === scope)?.attempt ?? null;
  const epoch = useRef(0),
    gate = useRef(false),
    bound = useRef(scope),
    currentScope = useRef(scope);
  const authority = useRef<Flags | null>(null),
    purgeRef = useRef(purge), freshGuard = useRef(guardFreshWrite);
  freshGuard.current = guardFreshWrite;
  currentScope.current = scope;
  purgeRef.current = purge;
  const current = (generation: number) =>
    epoch.current === generation && bound.current === currentScope.current;
  useEffect(() => {
    ++epoch.current;
    bound.current = scope;
    gate.current = false;
    setBusy(false);
    setBlocked(false);
    setError('');
    setNotice('');
    setFlags(null);
    authority.current = null;
    purgeRef.current();
    return () => {
      ++epoch.current;
      gate.current = false;
    };
  }, [scope, readOnly]);
  function remember(attempt: Attempt | null) {
    if (attempt) attempts.set(scope, attempt);
    else attempts.delete(scope);
    registryChanged();
  }
  function accept(reply: Flags, generation: number) {
    if (!current(generation)) return false;
    const old = authority.current;
    if (
      old &&
      (old.current_role !== reply.current_role || old.can_read_value !== reply.can_read_value)
    ) {
      authority.current = null;
      setFlags(null);
      purgeRef.current();
      clearAttempts();
      setBlocked(true);
      throw Error('Uprawnienia zmieniły się. Odczytaj ponownie widok firmy.');
    }
    authority.current = reply;
    setFlags(reply);
    return true;
  }
  async function run<T extends Flags>(
    fetcher: () => Promise<T>,
    apply: (reply: T) => void,
    attempt?: Attempt,
  ) {
    if (gate.current || bound.current !== scope || scope !== currentScope.current) return false;
    const generation = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      if (attempt && freshGuard.current) { const fence = await freshGuard.current(!!pending); if (!current(generation)) return false; fence(); }
      const reply = attempt
        ? await performDropshipReturnWrite<T>(contextKey, readOnly, scope, attempt)
        : await fetcher();
      if (!accept(reply, generation)) return false;
      if (attempt) remember(null);
      apply(reply);
      return true;
    } catch (e) {
      if (!current(generation)) return false;
      setError(e instanceof Error ? e.message : 'Nie udało się wykonać operacji');
      if (e instanceof ApiError && [401, 403, 423].includes(e.status)) {
        purgeRef.current();
        authority.current = null;
        setFlags(null);
        clearAttempts();
        setBlocked(true);
      } else if (
        attempt &&
        e instanceof ApiError &&
        [400, 404, 409, 413, 422, 429].includes(e.status)
      )
        remember(null);
      return false;
    } finally {
      if (current(generation)) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  return {
    busy,
    sharedLocked: shared.locked,
    blocked,
    error,
    notice,
    flags,
    pending,
    visible: bound.current === scope,
    setError,
    setNotice,
    read<T extends Flags>(path: string, apply: (reply: T) => void) {
      return run(() => api<T>(path), apply);
    },
    task<T extends Flags>(fetcher: () => Promise<T>, apply: (reply: T) => void) {
      return run(fetcher, apply);
    },
    write<T extends Flags>(
      action: string,
      path: string,
      method: 'POST' | 'PATCH',
      body: unknown,
      apply: (reply: T) => void,
    ) {
      if (
        gate.current ||
        bound.current !== scope ||
        scope !== currentScope.current ||
        readOnly ||
        blocked ||
        pending ||
        shared.locked ||
        attempts.has(scope) ||
        !authority.current?.available ||
        authority.current.read_only
      )
        return Promise.resolve(false);
      const attempt = { action, path, method, body: JSON.stringify(body) };
      return run(() => api<T>(path, method, JSON.parse(attempt.body)), apply, attempt);
    },
    retry<T extends Flags>(apply: (reply: T) => void) {
      if (
        !pending ||
        bound.current !== scope ||
        scope !== currentScope.current ||
        readOnly ||
        blocked ||
        !authority.current?.available ||
        authority.current.read_only
      )
        return Promise.resolve(false);
      return run(
        () => api<T>(pending.path, pending.method, JSON.parse(pending.body)),
        apply,
        pending,
      );
    },
  };
}
function Messages({
  error,
  notice,
  pending,
}: {
  error: string;
  notice: string;
  pending: Attempt | null;
}) {
  return (
    <>
      {error && (
        <p className="dr-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="dr-notice" role="status">
          {notice}
        </p>
      )}
      {pending && (
        <p className="dr-notice">
          Wynik działania „{pending.action}” wymaga potwierdzenia. Nowe zapisy są wstrzymane.
          Odczytaj historię lub ręcznie ponów dokładnie tę samą próbę.
        </p>
      )}
    </>
  );
}
function Scroll({ children }: { children: ReactNode }) {
  return <div className="dr-scroll">{children}</div>;
}

type Address = {
  name: string;
  street: string;
  city: string;
  postal_code: string;
  country: string;
  phone?: string;
};
type Settings = {
  version: number;
  enabled: boolean;
  warehouse_id: string | null;
  return_address: Address | null;
};
type SettingsReply = Flags & {
  settings: Settings;
  warehouses?: { data: { id: string; name: string; code: string }[]; capped: boolean };
};
const blankAddress: Address = {
  name: '',
  street: '',
  city: '',
  postal_code: '',
  country: 'PL',
  phone: '',
};
export function B2bDropshippingReturnSettings({
  accountId,
  contextKey,
  readOnly,
  onLockedChange,
  disabled = false,
  externalWriteBlocked = false,
  guardFreshWrite,
}: {
  accountId: string;
  contextKey: string;
  readOnly: boolean;
  onLockedChange?: (locked: boolean) => void;
  disabled?: boolean;
  externalWriteBlocked?: boolean;
  guardFreshWrite?: (exactRetry?: boolean) => Promise<() => void>;
}) {
  const scope = `${contextKey}:${readOnly}:return-settings:${accountId}`;
  const [saved, setSaved] = useState<Settings | null>(null),
    [enabled, setEnabled] = useState(false);
  const [warehouse, setWarehouse] = useState(''),
    [address, setAddress] = useState<Address>({ ...blankAddress });
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; code: string }[]>([]);
  const [capped, setCapped] = useState(false),
    [consent, setConsent] = useState(false);
  const io = useReturnIO(scope, contextKey, readOnly, () => {
    setSaved(null);
    setEnabled(false);
    setWarehouse('');
    setAddress({ ...blankAddress });
    setWarehouses([]);
    setCapped(false);
    setConsent(false);
  }, guardFreshWrite);
  function apply(reply: SettingsReply) {
    setSaved(reply.settings);
    setEnabled(reply.settings.enabled);
    setWarehouse(reply.settings.warehouse_id ?? '');
    setAddress({ ...(reply.settings.return_address ?? blankAddress) });
    setConsent(false);
    if (reply.warehouses) {
      setWarehouses(reply.warehouses.data);
      setCapped(reply.warehouses.capped);
    }
  }
  const path = prefix + '/settings/' + encodeURIComponent(accountId);
  useEffect(() => {
    void io.read<SettingsReply>(path, apply);
  }, [scope]);
  const locked = io.busy || io.sharedLocked || !io.visible;
  const settingsCallback = useRef(onLockedChange);
  settingsCallback.current = onLockedChange;
  useEffect(() => {
    settingsCallback.current?.(io.busy || !!io.pending || !io.visible);
    return () => settingsCallback.current?.(false);
  }, [locked]);
  const canWrite =
    !disabled &&
    (!externalWriteBlocked || !!io.pending) &&
    io.visible &&
    !readOnly &&
    !io.blocked &&
    !!io.flags?.available &&
    !!io.flags.can_manage &&
    !io.flags.read_only;
  function edit(next: Partial<Address>) {
    setAddress((old) => ({ ...old, ...next }));
    setConsent(false);
  }
  async function save() {
    try {
      if (!saved || !canWrite || locked || !consent) return;
      if (!warehouse || !warehouses.some((w) => w.id === warehouse))
        throw Error('Wybierz własny magazyn przyjęcia');
      const cleaned = Object.fromEntries(
        Object.entries(address).map(([key, value]) => [key, value?.trim() ?? '']),
      ) as Address;
      if (
        !cleaned.name ||
        !cleaned.street ||
        !cleaned.city ||
        !cleaned.postal_code ||
        !/^[A-Z]{2}$/.test(cleaned.country)
      )
        throw Error('Podaj pełny adres przyjęcia zwrotów i dwuliterowy kraj');
      await io.write<SettingsReply>(
        'zapis ustawień przyjmowania zwrotów',
        path,
        'PATCH',
        {
          client_key: crypto.randomUUID(),
          version: saved.version,
          enabled,
          warehouse_id: warehouse,
          return_address: cleaned,
          confirmed: true,
        },
        (reply) => {
          apply(reply);
          io.setNotice('Zapisano ustawienia przyjmowania zwrotów tego kontrahenta.');
        },
      );
    } catch (e) {
      io.setError(e instanceof Error ? e.message : 'Nie udało się zapisać ustawień');
    }
  }
  return (
    <section className="dropship-returns" aria-label="Ustawienia przyjmowania zwrotów kontrahenta">
      <h3>Zwroty klientów bezpośrednio do Twojej firmy</h3>
      <p>
        Ustawienia dotyczą tego kontrahenta. Przyjęcie fizycznego towaru potwierdza Twoja firma;
        przekazanie zgłoszenia nie wykonuje wypłaty.
      </p>
      {io.visible && <Messages error={io.error} notice={io.notice} pending={io.pending} />}
      {!io.visible || io.blocked ? (
        <p>Odczytaj ustawienia w bieżącym kontekście.</p>
      ) : io.flags && !io.flags.available ? (
        <p>Przyjmowanie zwrotów dropshipping jest niedostępne w tej kopii danych.</p>
      ) : (
        <>
          {saved && (
            <p>
              Wersja ustawień: {saved.version} ·{' '}
              {saved.enabled
                ? 'Przyjmowanie nowych zgłoszeń włączone'
                : 'Przyjmowanie nowych zgłoszeń wyłączone'}
            </p>
          )}
          <fieldset disabled={locked || !canWrite}>
            <label className="dr-check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  setEnabled(e.target.checked);
                  setConsent(false);
                }}
              />
              Przyjmuj zgłoszenia zwrotów tego kontrahenta
            </label>
            <div className="dr-grid">
              <label>
                Magazyn przyjęcia zwrotów
                <select
                  value={warehouse}
                  onChange={(e) => {
                    setWarehouse(e.target.value);
                    setConsent(false);
                  }}
                >
                  <option value="">Wybierz magazyn</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} · {w.code}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Nazwa odbiorcy zwrotów
                <input
                  value={address.name}
                  maxLength={200}
                  onChange={(e) => edit({ name: e.target.value })}
                />
              </label>
              <label>
                Ulica przyjęcia zwrotów
                <input
                  value={address.street}
                  maxLength={300}
                  onChange={(e) => edit({ street: e.target.value })}
                />
              </label>
              <label>
                Miasto przyjęcia zwrotów
                <input
                  value={address.city}
                  maxLength={100}
                  onChange={(e) => edit({ city: e.target.value })}
                />
              </label>
              <label>
                Kod pocztowy zwrotów
                <input
                  value={address.postal_code}
                  maxLength={20}
                  onChange={(e) => edit({ postal_code: e.target.value })}
                />
              </label>
              <label>
                Kraj przyjęcia zwrotów
                <input
                  value={address.country}
                  maxLength={2}
                  onChange={(e) => edit({ country: e.target.value.toUpperCase() })}
                />
              </label>
              <label>
                Telefon przyjęcia zwrotów
                <input
                  value={address.phone ?? ''}
                  maxLength={40}
                  onChange={(e) => edit({ phone: e.target.value })}
                />
              </label>
            </div>
            <label className="dr-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              Potwierdzam magazyn, adres i pokazane ustawienie przyjmowania nowych zwrotów.
            </label>
          </fieldset>
          {capped && (
            <p>
              Lista magazynów przekracza zakres tego formularza. Brakującego magazynu nie wybierzemy
              automatycznie.
            </p>
          )}
          <div className="dr-actions">
            <button
              className="button primary"
              disabled={locked || !canWrite || !consent || !saved}
              onClick={() => void save()}
            >
              Zapisz ustawienia zwrotów
            </button>
            <button
              className="button"
              disabled={io.busy}
              onClick={() => void io.read<SettingsReply>(path, apply)}
            >
              Odczytaj ustawienia
            </button>
            {io.pending && (
              <button
                className="button"
                disabled={io.busy || !canWrite}
                onClick={() =>
                  void io.retry<SettingsReply>((reply) => {
                    apply(reply);
                    io.setNotice('Odczytano wynik dokładnej próby zapisu ustawień.');
                  })
                }
              >
                Ponów dokładną próbę ustawień
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

type Page<T> = Flags & { data: T[]; meta: { total: number; cursor: string | null } };
type B2bDropshipReturnContext = DropshipReturnContext & B2bReturnLocalContext;
type ContextReply = Flags & { context: B2bDropshipReturnContext };
type PreviewReply = Flags & { preview: B2bDropshipReturnPreview };
type CaseReply = Flags & { case: B2bDropshipReturnCase };
type ReconcileReply = Flags & { return: { id: string }; reused: boolean };
type SubmitReply = Flags & { cases: B2bDropshipReturnCase[]; reused: boolean };
type CaseEvidence = CaseReply & {
  rows: B2bDropshipReturnPreviewRow[];
  events: B2bDropshipReturnEvent[];
};
type SourceDraft = { quantity: string; physical: Record<string, string> };
const sourceKey = (row: { customer_item_id: string; dropship_order_id: string }) =>
  `${row.customer_item_id}:${row.dropship_order_id}`;
const physicalKey = (row: {
  supplier_item_id: string;
  shipment_id: string;
  issue_fragment_id?: string;
}) => `${row.supplier_item_id}:${row.shipment_id}:${row.issue_fragment_id ?? ''}`;
const caseNames: Record<string, string> = {
  requested: 'Oczekuje na decyzję dostawcy',
  received: 'Przyjęto u dostawcy',
  rejected: 'Odrzucono u dostawcy',
  withdrawn: 'Wycofano',
};
const eventNames: Record<string, string> = {
  submit: 'Przekazano zgłoszenie',
  receive: 'Przyjęto towar u dostawcy',
  reject: 'Dostawca odmówił przyjęcia',
  withdraw: 'Wycofano przekazanie',
  reconcile: 'Uzgodniono detaliczny zwrot',
};
function sameAccess(a: Flags, b: Flags) {
  return (
    a.current_role === b.current_role &&
    a.can_read_value === b.can_read_value &&
    a.can_manage === b.can_manage &&
    a.read_only === b.read_only &&
    a.available === b.available &&
    a.can_read === b.can_read
  );
}
async function allPages<T>(path: string, maximum: number): Promise<Page<T>> {
  const data: T[] = [],
    cursors = new Set<string>();
  let cursor: string | null = null,
    first: Page<T> | null = null;
  do {
    const reply: Page<T> = await api<Page<T>>(
      path +
        (path.includes('?') ? '&' : '?') +
        new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }),
    );
    if (!Number.isInteger(reply.meta.total) || reply.meta.total < 0 || reply.meta.total > maximum)
      throw Error(
        'Pełny zakres przekracza dopuszczalny rozmiar. Żadna pozycja nie została pominięta.',
      );
    if (first && !sameAccess(reply, first))
      throw new ApiError(
        'Uprawnienia zmieniły się podczas odczytu. Odczytaj ponownie widok firmy.',
        403,
      );
    if (first && reply.meta.total !== first.meta.total)
      throw Error('Zakres zmienił się podczas odczytu. Odczytaj ponownie całość.');
    first ??= reply;
    data.push(...reply.data);
    if (data.length > maximum || data.length > reply.meta.total)
      throw Error('Odczyt zawiera niezgodną liczbę pozycji');
    cursor = reply.meta.cursor;
    if (cursor && cursors.has(cursor))
      throw Error('Nie można potwierdzić kompletności stron odczytu');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (!first || data.length !== first.meta.total)
    throw Error('Nie odczytano całego zakresu. Zatwierdzenie jest wstrzymane.');
  return { ...first, data, meta: { total: data.length, cursor: null } };
}
function AddressView({ value }: { value: Address | null }) {
  if (!value)
    return (
      <p>Brak adresu przyjęcia. Dostawca musi ustawić przyjmowanie zwrotów tego kontrahenta.</p>
    );
  return (
    <p>
      {value.name} · {value.street} · {value.postal_code} {value.city} · {value.country}
      {value.phone && ` · ${value.phone}`}
    </p>
  );
}
function EvidenceRows({
  rows,
  financial,
}: {
  rows: B2bDropshipReturnPreviewRow[];
  financial: boolean;
}) {
  return (
    <Scroll>
      <table>
        <thead>
          <tr>
            <th>Pozycja klienta / dostawca</th>
            <th>Jednostki handlowe</th>
            <th>Fizyczne składniki i rzeczywiste wydanie</th>
            {financial && (
              <>
                <th>Kwota detaliczna</th>
                <th>Kwota hurtowa</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.index}:${sourceKey(row)}`}>
              <td>
                <strong>{row.name}</strong>
                <small>
                  {row.sku} · {row.supplier_name} · {row.supplier_order_number}
                </small>
              </td>
              <td>{row.quantity}</td>
              <td>
                {row.physical_sources.map((part) => (
                  <div key={physicalKey(part)}>
                    {part.name} · {part.sku} · {part.quantity} szt.{' '}
                    <small>{part.quantity_per_unit} szt. na jednostkę pozycji</small>
                    <details>
                      <summary>Identyfikatory wydania</summary>
                      <small>
                        Przesyłka: {part.shipment_id}
                        <br />
                        Pozycja dostawcy: {part.supplier_item_id}
                        {part.issue_fragment_id && (
                          <>
                            <br />
                            Fragment partii: {part.issue_fragment_id}
                          </>
                        )}
                      </small>
                    </details>
                  </div>
                ))}
              </td>
              {financial && (
                <>
                  <td>{amount(row.retail_refund_minor, row.retail_currency)}</td>
                  <td>{amount(row.wholesale_refund_minor, row.wholesale_currency)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}
export type B2bDropshippingReturnsProps = {
  orderId: string;
  returnId: string;
  contextKey: string;
  readOnly: boolean;
  onChanged: () => void;
  disabled?: boolean;
  onLockedChange?: (locked: boolean) => void;
  onLocalReceiveChange?: (allowed: boolean) => void;
  onLocalOriginChange?: (originId: string | null) => void;
};
export function B2bDropshippingReturns({
  orderId,
  returnId,
  contextKey,
  readOnly,
  onChanged,
  onLockedChange,
  onLocalReceiveChange,
  onLocalOriginChange,
  disabled = false,
}: B2bDropshippingReturnsProps) {
  const scope = `${contextKey}:${readOnly}:dropship-return:${orderId}:${returnId}`;
  const base = prefix + '/returns/' + encodeURIComponent(returnId);
  const [context, setContext] = useState<B2bDropshipReturnContext | null>(null);
  const [originChoice, setOriginChoice] = useState<'local' | 'partner' | null>(null);
  const [localShipments, setLocalShipments] = useState<Record<string, string>>({});
  const [localConsent, setLocalConsent] = useState(false);
  const [sources, setSources] = useState<B2bDropshipReturnSource[] | null>(null);
  const [draft, setDraft] = useState<Record<string, SourceDraft>>({});
  const [supplierShipping, setSupplierShipping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<B2bDropshipReturnPreview | null>(null);
  const [previewRows, setPreviewRows] = useState<B2bDropshipReturnPreviewRow[] | null>(null);
  const [cases, setCases] = useState<Page<B2bDropshipReturnCase> | null>(null);
  const [selected, setSelected] = useState<CaseEvidence | null>(null);
  const [consent, setConsent] = useState(false),
    [note, setNote] = useState(''),
    [retailNote, setRetailNote] = useState('');
  const [actionConsent, setActionConsent] = useState(false),
    [reconcileConsent, setReconcileConsent] = useState(false),
    [retailShipping, setRetailShipping] = useState('0,00');
  const [receiveShipping, setReceiveShipping] = useState('0,00');
  const [received, setReceived] = useState<Record<string, { accepted: string; restocked: string }>>(
    {},
  );
  const [retailAccepted, setRetailAccepted] = useState<Record<string, string>>({});
  const [lots, setLots] = useState<WmsReturnLotsPayload | null>(null),
    [lotsReady, setLotsReady] = useState(false);
  const callbacks = useRef({
    onChanged,
    onLockedChange,
    onLocalReceiveChange,
    onLocalOriginChange,
  });
  callbacks.current = { onChanged, onLockedChange, onLocalReceiveChange, onLocalOriginChange };
  const io = useReturnIO(scope, contextKey, readOnly, () => {
    setContext(null);
    setOriginChoice(null);
    setLocalShipments({});
    setLocalConsent(false);
    setSources(null);
    setDraft({});
    setSupplierShipping({});
    setPreview(null);
    setPreviewRows(null);
    setCases(null);
    setSelected(null);
    setConsent(false);
    setActionConsent(false);
    setReconcileConsent(false);
    setNote('');
    setRetailNote('');
    setReceived({});
    setRetailAccepted({});
    setLots(null);
    setLotsReady(false);
    setRetailShipping('0,00');
    setReceiveShipping('0,00');
    callbacks.current.onLocalReceiveChange?.(false);
    callbacks.current.onLocalOriginChange?.(null);
  });
  const locked = io.busy || io.sharedLocked || io.blocked || !io.visible;
  const writable =
    !disabled &&
    io.visible &&
    !readOnly &&
    !io.blocked &&
    !!io.flags?.available &&
    !!io.flags.can_manage &&
    !io.flags.read_only;
  const financial = io.visible && !!io.flags?.can_read_value;
  const partnerSelected =
    context?.fulfillment_origin === 'partner' ||
    (context?.fulfillment_origin === 'unselected' && originChoice === 'partner');
  function chooseOrigin(choice: 'local' | 'partner') {
    setOriginChoice(choice);
    setLocalConsent(false);
    setConsent(false);
    setPreview(null);
    setPreviewRows(null);
    setSources(null);
    setDraft({});
    setSupplierShipping({});
  }
  function applyContext(reply: ContextReply) {
    setContext(reply.context);
    setOriginChoice(null);
    setLocalShipments({});
    setLocalConsent(false);
    if (reply.context.fulfillment_origin === 'local') {
      setPreview(null);
      setPreviewRows(null);
      setSources(null);
      setDraft({});
      setConsent(false);
    }
    setReconcileConsent(false);
    setRetailAccepted(
      Object.fromEntries(reply.context.retail_items.map((item) => [item.customer_item_id, '0'])),
    );
    callbacks.current.onLocalReceiveChange?.(reply.context.can_receive_locally);
    callbacks.current.onLocalOriginChange?.(reply.context.local_origin?.id ?? null);
  }
  useEffect(() => {
    callbacks.current.onLocalReceiveChange?.(false);
    callbacks.current.onLocalOriginChange?.(null);
    void io.read<ContextReply>(base + '/context', applyContext);
  }, [scope]);
  async function selectLocalOrigin() {
    if (!context || locked || !writable || !localConsent || !context.can_select_local_origin)
      return;
    try {
      if (
        context.fulfillment_origin !== 'unselected' ||
        !context.local_scope_hash ||
        !/^[a-f0-9]{64}$/.test(context.local_scope_hash)
      )
        throw Error('Odczytaj aktualny pełny zakres lokalnych wydań');
      if (
        !context.retail_items.length ||
        context.retail_items.length > 100 ||
        new Set(context.retail_items.map((item) => item.customer_item_id)).size !==
          context.retail_items.length
      )
        throw Error('Nie można potwierdzić pełnego zakresu zgłoszenia');
      if (
        context.local_sources.length > 1000 ||
        new Set(
          context.local_sources.map((source) => `${source.customer_item_id}:${source.shipment_id}`),
        ).size !== context.local_sources.length
      )
        throw Error(
          'Zakres lokalnych wydań jest niekompletny lub niejednoznaczny. Odczytaj ponownie zgłoszenie.',
        );
      const items = context.retail_items.map((item) => {
        const shipment = localShipments[item.customer_item_id];
        const candidates = context.local_sources.filter(
          (source) =>
            source.customer_item_id === item.customer_item_id && source.shipment_id === shipment,
        );
        if (
          !shipment ||
          candidates.length !== 1 ||
          candidates[0].quantity_available < item.requested
        )
          throw Error('Wybierz dokładną paczkę pokrywającą całą zgłoszoną ilość każdej pozycji');
        return {
          customer_item_id: item.customer_item_id,
          shipment_id: shipment,
          quantity: item.requested,
        };
      });
      await io.write<ContextReply>(
        'wybór lokalnego pochodzenia zwrotu',
        base + '/local-origin',
        'POST',
        {
          client_key: crypto.randomUUID(),
          version: context.version,
          scope_hash: context.local_scope_hash,
          confirmed: true,
          items,
        },
        (reply) => {
          applyContext(reply);
          callbacks.current.onChanged();
          io.setNotice(
            'Zapisano lokalne pochodzenie zgłoszenia. Towar przyjmiesz osobno w formularzu przyjęcia; zapas i płatności nie zostały zmienione.',
          );
        },
      );
    } catch (e) {
      io.setError(e instanceof Error ? e.message : 'Nie udało się wybrać lokalnego pochodzenia');
    }
  }
  useEffect(() => {
    callbacks.current.onLockedChange?.(io.busy || !!io.pending || io.blocked || !io.visible);
    return () => callbacks.current.onLockedChange?.(false);
  }, [locked]);
  const casePath = (id: string) => prefix + '/cases/' + encodeURIComponent(id);
  function invalidate() {
    setPreview(null);
    setPreviewRows(null);
    setConsent(false);
    setActionConsent(false);
  }
  function editSource(key: string, next: Partial<SourceDraft>) {
    setDraft((old) => ({
      ...old,
      [key]: { ...(old[key] ?? { quantity: '0', physical: {} }), ...next },
    }));
    invalidate();
  }
  async function loadSources() {
    await io.task(
      () => allPages<B2bDropshipReturnSource>(base + '/sources', context?.limits.items ?? 100),
      (reply) => {
        setSources(reply.data);
        setDraft(
          Object.fromEntries(
            reply.data.map((row) => [
              sourceKey(row),
              {
                quantity: '0',
                physical: Object.fromEntries(
                  row.physical_sources.map((part) => [physicalKey(part), '0']),
                ),
              },
            ]),
          ),
        );
        invalidate();
        io.setNotice(`Odczytano pełny zakres: ${reply.data.length} powiązań pozycji i dostawców.`);
      },
    );
  }
  async function loadPreview(id: string) {
    await io.task(
      async () => {
        const head = await api<PreviewReply>(prefix + '/previews/' + encodeURIComponent(id));
        const rows = await allPages<B2bDropshipReturnPreviewRow>(
          prefix + '/previews/' + encodeURIComponent(id) + '/rows',
          context?.limits.items ?? 100,
        );
        if (!sameAccess(rows, head))
          throw new ApiError('Uprawnienia zmieniły się podczas odczytu podglądu.', 403);
        if (rows.data.length !== head.preview.total)
          throw Error('Podgląd zmienił się. Zatwierdzenie jest wstrzymane.');
        return { ...head, rows: rows.data };
      },
      (reply) => {
        setPreview(reply.preview);
        setPreviewRows(reply.rows);
        setConsent(false);
      },
    );
  }
  async function loadCase(id: string) {
    await io.task(
      async () => {
        const head = await api<CaseReply>(casePath(id));
        const rows = await allPages<B2bDropshipReturnPreviewRow>(casePath(id) + '/rows', 100);
        const events = await allPages<B2bDropshipReturnEvent>(
          casePath(id) + '/events',
          context?.limits.history ?? 2000,
        );
        if ([rows, events].some((part) => !sameAccess(part, head)))
          throw new ApiError('Uprawnienia zmieniły się podczas odczytu sprawy.', 403);
        return { ...head, rows: rows.data, events: events.data };
      },
      (reply) => {
        setSelected(reply);
        setActionConsent(false);
        setNote('');
        setReceiveShipping('0,00');
        setLots(null);
        setLotsReady(false);
        setReceived(
          Object.fromEntries(
            reply.case.supplier_items.map((item) => [
              item.supplier_item_id,
              { accepted: '0', restocked: '0' },
            ]),
          ),
        );
      },
    );
  }
  async function loadCases(cursor?: string) {
    const query = new URLSearchParams({
      return_id: returnId,
      limit: '100',
      ...(cursor ? { cursor } : {}),
    });
    await io.read<Page<B2bDropshipReturnCase>>(prefix + '/cases?' + query, (reply) => {
      const merged = cursor && cases ? [...cases.data, ...reply.data] : reply.data;
      if (
        reply.meta.total > (context?.limits.history ?? 2000) ||
        merged.length > reply.meta.total ||
        new Set(merged.map((item) => item.id)).size !== merged.length ||
        (cursor && cases && cases.meta.total !== reply.meta.total)
      )
        throw Error('Zakres spraw zmienił się. Odczytaj ponownie pełną historię.');
      setCases({ ...reply, data: merged });
      setReconcileConsent(false);
    });
  }
  async function prepare() {
    try {
      if (
        !sources ||
        !context ||
        context.side !== 'buyer' ||
        !partnerSelected ||
        locked ||
        !writable ||
        !context.can_preview
      )
        return;
      const items = sources.flatMap((row) => {
        const value = draft[sourceKey(row)];
        const quantity = integer(
          value?.quantity ?? '0',
          Math.min(row.requested, row.quantity_available),
        );
        if (!quantity) return [];
        if (!row.enabled)
          throw Error(`Dostawca ${row.supplier_name} nie przyjmuje nowych przekazań`);
        const physical_sources = row.physical_sources.flatMap((part) => {
          const count = integer(value.physical[physicalKey(part)] ?? '0', part.quantity_available);
          return count
            ? [
                {
                  supplier_item_id: part.supplier_item_id,
                  shipment_id: part.shipment_id,
                  quantity: count,
                  ...(part.issue_fragment_id ? { issue_fragment_id: part.issue_fragment_id } : {}),
                },
              ]
            : [];
        });
        if (!physical_sources.length)
          throw Error(`Wybierz rzeczywiście wydane składniki dla pozycji ${row.sku}`);
        return [
          {
            customer_item_id: row.customer_item_id,
            dropship_order_id: row.dropship_order_id,
            quantity,
            physical_sources,
          },
        ];
      });
      if (!items.length)
        throw Error('Podaj jednostki handlowe i konkretne fizyczne fragmenty zwrotu');
      const supplier_shipping_refunds = Object.entries(supplierShipping).flatMap(
        ([dropship_order_id, text]) => {
          const amount_minor = minor(text || '0');
          return amount_minor ? [{ dropship_order_id, amount_minor }] : [];
        },
      );
      await io.write<PreviewReply>(
        'przygotowanie podglądu przekazania',
        base + '/previews',
        'POST',
        {
          client_key: crypto.randomUUID(),
          version: context.version,
          items,
          supplier_shipping_refunds,
          confirmed: true,
        },
        (reply) => {
          setPreview(reply.preview);
          setPreviewRows(null);
          setConsent(false);
          io.setNotice('Zapisano podgląd. Odczytaj wszystkie jego pozycje przed zatwierdzeniem.');
        },
      );
    } catch (e) {
      io.setError(e instanceof Error ? e.message : 'Nie udało się przygotować podglądu');
    }
  }
  async function submitPreview() {
    if (
      !partnerSelected ||
      !preview ||
      !previewRows ||
      locked ||
      !writable ||
      !consent ||
      !preview.can_submit
    )
      return;
    await io.write<SubmitReply>(
      'przekazanie zwrotu dostawcom',
      prefix + '/previews/' + preview.id + '/submit',
      'POST',
      {
        client_key: crypto.randomUUID(),
        version: 1,
        scope_hash: preview.scope_hash,
        confirmed: true,
      },
      (reply) => {
        setCases({
          ...reply,
          data: reply.cases,
          meta: { total: reply.cases.length, cursor: null },
        });
        setPreview((old) =>
          old
            ? { ...old, executed_case_ids: reply.cases.map((item) => item.id), can_submit: false }
            : null,
        );
        setConsent(false);
        callbacks.current.onLocalReceiveChange?.(false);
        callbacks.current.onChanged();
        io.setNotice(
          'Przekazano zgłoszenie do dostawców. Twój magazyn i płatności nie zostały zmienione.',
        );
      },
    );
  }
  const currentCase = selected?.case;
  const restockedProducts = selected
    ? [
        ...new Set(
          selected.rows.flatMap((row) =>
            row.physical_sources
              .filter((part) => Number(received[part.supplier_item_id]?.restocked ?? 0) > 0)
              .map((part) => part.product_id),
          ),
        ),
      ].sort()
    : [];
  const needsLots = !!currentCase?.wms_lots_enabled && restockedProducts.length > 0;
  async function caseAction(action: 'receive' | 'decision' | 'withdraw') {
    try {
      if (!currentCase || locked || !writable || !actionConsent) return;
      if (note.trim().length < 3 || note.trim().length > 2000)
        throw Error('Podaj uzasadnienie od 3 do 2000 znaków');
      const common = {
        client_key: crypto.randomUUID(),
        version: currentCase.version,
        confirmed: true,
      };
      let body: Record<string, unknown>;
      if (action === 'receive') {
        if (!currentCase.can_receive) return;
        const items = currentCase.supplier_items.map((item) => {
          const accepted = integer(
            received[item.supplier_item_id]?.accepted ?? '0',
            item.requested,
          );
          const restocked = integer(received[item.supplier_item_id]?.restocked ?? '0', accepted);
          return { supplier_item_id: item.supplier_item_id, accepted, restocked };
        });
        if (needsLots && (!lotsReady || !lots))
          throw Error('Odczytaj i wybierz partie całego rzeczywiście przywracanego zakresu');
        body = {
          ...common,
          supplier_return_version: currentCase.supplier_return_version,
          shipping_refund_minor: minor(receiveShipping),
          note: note.trim(),
          items,
          ...(needsLots && lots ? { wms_lots: lots } : {}),
        };
      } else if (action === 'decision') {
        if (!currentCase.can_reject) return;
        body = {
          ...common,
          supplier_return_version: currentCase.supplier_return_version,
          decision: 'reject',
          note: note.trim(),
        };
      } else {
        if (!currentCase.can_withdraw) return;
        body = { ...common, reason: note.trim() };
      }
      await io.write<CaseReply>(
        action === 'receive'
          ? 'fizyczne przyjęcie u dostawcy'
          : action === 'decision'
            ? 'odmowa dostawcy'
            : 'wycofanie przekazania',
        casePath(currentCase.id) + '/' + action,
        'POST',
        body,
        (reply) => {
          setSelected(null);
          setActionConsent(false);
          setLots(null);
          setLotsReady(false);
          callbacks.current.onChanged();
          io.setNotice(
            `${eventNames[action === 'decision' ? 'reject' : action]} zapisane. Odczytaj ponownie sprawę i historię.`,
          );
        },
      );
    } catch (e) {
      io.setError(e instanceof Error ? e.message : 'Nie udało się zapisać decyzji');
    }
  }
  async function reconcile() {
    try {
      if (!context || !cases || locked || !writable || !context.can_reconcile || !reconcileConsent)
        return;
      if (
        cases.meta.cursor ||
        cases.data.length !== cases.meta.total ||
        context.case_refs.length === 0 ||
        new Set(context.case_refs.map((ref) => ref.id)).size !== context.case_refs.length ||
        !context.case_refs.every((ref) =>
          cases.data.some((item) => item.id === ref.id && item.version === ref.version),
        )
      )
        throw Error(
          'Odczytaj wszystkie powiązane sprawy i ich aktualne decyzje przed uzgodnieniem',
        );
      if (retailNote.trim().length < 3 || retailNote.trim().length > 2000)
        throw Error('Podaj uzasadnienie od 3 do 2000 znaków');
      const items = context.retail_items.map((item) => ({
        customer_item_id: item.customer_item_id,
        accepted: integer(retailAccepted[item.customer_item_id] ?? '0', item.accepted_available),
      }));
      await io.write<ReconcileReply>(
        'uzgodnienie detalicznego zwrotu',
        base + '/reconcile',
        'POST',
        {
          client_key: crypto.randomUUID(),
          version: context.version,
          case_versions: context.case_refs.map((ref) => ({ id: ref.id, version: ref.version })),
          items,
          shipping_refund_minor: minor(retailShipping),
          note: retailNote.trim(),
          confirmed: true,
        },
        () => {
          setContext(null);
          setReconcileConsent(false);
          setActionConsent(false);
          setSelected(null);
          callbacks.current.onLocalReceiveChange?.(false);
          callbacks.current.onChanged();
          io.setNotice(
            'Uzgodniono detaliczny zwrot na podstawie decyzji dostawców. Nie wykonano lokalnego przyjęcia ani wypłaty.',
          );
        },
      );
    } catch (e) {
      io.setError(e instanceof Error ? e.message : 'Nie udało się uzgodnić zwrotu');
    }
  }
  async function retry() {
    const action = io.pending?.action;
    await io.retry<
      Flags & {
        preview?: B2bDropshipReturnPreview;
        cases?: B2bDropshipReturnCase[];
        case?: B2bDropshipReturnCase;
        context?: B2bDropshipReturnContext;
        return?: { id: string };
      }
    >((reply) => {
      if (reply.preview) {
        setPreview(reply.preview);
        setPreviewRows(null);
        setOriginChoice('partner');
      }
      if (reply.cases)
        setCases({
          ...reply,
          data: reply.cases,
          meta: { total: reply.cases.length, cursor: null },
        });
      if (reply.return) {
        setContext(null);
        callbacks.current.onLocalReceiveChange?.(false);
        callbacks.current.onLocalOriginChange?.(null);
      }
      if (reply.context) applyContext({ ...reply, context: reply.context });
      setSelected(null);
      setConsent(false);
      setActionConsent(false);
      setReconcileConsent(false);
      callbacks.current.onChanged();
      io.setNotice(
        `Odczytano wynik dokładnej próby: ${action}. Odczytaj aktualne sprawy i historię.`,
      );
    });
  }
  if (
    io.visible &&
    context &&
    (!io.flags?.available ||
      (!context.side && !['local', 'unselected'].includes(context.fulfillment_origin))) &&
    !io.error &&
    !io.pending
  )
    return null;
  return (
    <section className="dropship-returns" aria-label="Zwrot klienta bezpośrednio do dostawcy">
      <h3>
        {io.visible && context?.side === 'supplier'
          ? 'Przyjęcie zwrotu klienta kontrahenta'
          : context?.fulfillment_origin === 'local' || context?.fulfillment_origin === 'unselected'
            ? 'Pochodzenie zwrotu klienta'
            : 'Zwrot bezpośrednio do dostawcy'}
      </h3>
      <p>
        Towar trafia do firmy, która rzeczywiście go wydała. Ilości handlowe, fizyczne składniki
        oraz rozliczenia klienta i dostawcy są odrębne.
      </p>
      {io.visible && <Messages error={io.error} notice={io.notice} pending={io.pending} />}
      <div className="dr-actions">
        <button
          className="button"
          disabled={io.busy}
          onClick={() => void io.read<ContextReply>(base + '/context', applyContext)}
        >
          Odczytaj zakres zwrotu
        </button>
        {io.visible && context?.side && (
          <button className="button" disabled={io.busy} onClick={() => void loadCases()}>
            Odczytaj sprawy dostawców
          </button>
        )}
        {io.pending && (
          <button
            className="button primary"
            disabled={io.busy || !writable}
            onClick={() => void retry()}
          >
            Ponów dokładną próbę
          </button>
        )}
      </div>
      {!io.visible || io.blocked || !context ? (
        <p>Odczyt zakresu zwrotu…</p>
      ) : (
        <>
          {context.fulfillment_origin === 'unselected' && (
            <div className="dr-card">
              <h4>Wybierz miejsce przyjęcia całego zgłoszenia</h4>
              <p>
                Wskaż rzeczywiste wydanie zwracanego towaru. Lokalna ścieżka jest dostępna tylko dla
                udokumentowanego lokalnego wydania. Lokalną i zewnętrzną część zgłoś w osobnych
                sprawach.
              </p>
              <div className="dr-actions">
                <button
                  className="button"
                  aria-pressed={originChoice === 'local'}
                  disabled={locked || !writable || !context.can_select_local_origin}
                  onClick={() => chooseOrigin('local')}
                >
                  Do własnego magazynu
                </button>
                <button
                  className="button"
                  aria-pressed={originChoice === 'partner'}
                  disabled={locked || !writable || !context.can_preview}
                  onClick={() => chooseOrigin('partner')}
                >
                  Bezpośrednio do dostawcy
                </button>
              </div>
              {!context.can_select_local_origin && (
                <p>
                  Nie można teraz powiązać całego zgłoszenia z lokalnym wydaniem. Odczytaj zakres
                  ponownie lub wybierz właściwy zakres osobnego zgłoszenia.
                </p>
              )}
            </div>
          )}
          {context.fulfillment_origin === 'unselected' && originChoice === 'local' && (
            <div className="dr-card">
              <h4>Lokalne wydania · pełny zakres zgłoszenia</h4>
              <p>
                Wybierz paczkę każdej pozycji. Ilość musi pokrywać całe zgłoszenie. Zapis
                pochodzenia nie przyjmuje towaru ani nie zmienia zapasu lub płatności.
              </p>
              {context.local_sources.length > 1000 ? (
                <p role="alert">
                  Zakres przekracza limit odczytu. Niczego nie pominięto; zatwierdzenie jest
                  wstrzymane.
                </p>
              ) : (
                <Scroll>
                  <table className="dr-origin-table">
                    <thead>
                      <tr>
                        <th>Pozycja / zgłoszono</th>
                        <th>Rzeczywista paczka</th>
                        <th>Wydano / dostępne</th>
                        <th>Składniki na jednostkę</th>
                      </tr>
                    </thead>
                    <tbody>
                      {context.retail_items.map((item) => {
                        const candidates = context.local_sources.filter(
                          (source) => source.customer_item_id === item.customer_item_id,
                        );
                        const selectedSource = candidates.find(
                          (source) => source.shipment_id === localShipments[item.customer_item_id],
                        );
                        return (
                          <tr key={item.customer_item_id}>
                            <td>
                              {item.name}
                              <small>
                                {item.sku} · zgłoszono {item.requested}
                              </small>
                              <small>Pozycja: {item.customer_item_id}</small>
                            </td>
                            <td>
                              <select
                                aria-label={`Lokalna paczka · ${item.sku} · ${item.customer_item_id}`}
                                value={localShipments[item.customer_item_id] ?? ''}
                                disabled={locked || !writable}
                                onChange={(e) => {
                                  setLocalShipments((old) => ({
                                    ...old,
                                    [item.customer_item_id]: e.target.value,
                                  }));
                                  setLocalConsent(false);
                                }}
                              >
                                <option value="">Wybierz dokładne wydanie</option>
                                {candidates.map((source) => (
                                  <option key={source.shipment_id} value={source.shipment_id}>
                                    {source.shipment_id} · wydano {source.issued_quantity}, dostępne{' '}
                                    {source.quantity_available}
                                  </option>
                                ))}
                              </select>
                              {!candidates.length && (
                                <small>Brak udokumentowanej lokalnej paczki.</small>
                              )}
                              {candidates.length > 1 && (
                                <small>
                                  Kilka paczek wymaga jednoznacznego wskazania. Jeżeli serwer odmówi
                                  przypisania, odczytaj zgłoszenie; nie zastępuj wydania inną
                                  paczką.
                                </small>
                              )}
                            </td>
                            <td>
                              {selectedSource
                                ? `${selectedSource.issued_quantity} / ${selectedSource.quantity_available}`
                                : 'Wybierz wydanie'}
                            </td>
                            <td>
                              {selectedSource?.components.map((part) => (
                                <small key={part.product_id}>
                                  {part.product_id} · {part.quantity} szt.
                                </small>
                              ))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Scroll>
              )}
              <label className="dr-check">
                <input
                  type="checkbox"
                  checked={localConsent}
                  disabled={
                    locked ||
                    !writable ||
                    context.local_sources.length > 1000 ||
                    !context.local_scope_hash ||
                    !context.retail_items.length ||
                    !context.retail_items.every((item) =>
                      context.local_sources.some(
                        (source) =>
                          source.customer_item_id === item.customer_item_id &&
                          source.shipment_id === localShipments[item.customer_item_id] &&
                          source.quantity_available >= item.requested,
                      ),
                    )
                  }
                  onChange={(e) => setLocalConsent(e.target.checked)}
                />
                Potwierdzam lokalne pochodzenie całego zgłoszenia, dokładne paczki i pokazane
                ilości. Fizyczne przyjęcie i uznanie kwoty wykonam osobno.
              </label>
              <button
                className="button primary"
                disabled={locked || !writable || !localConsent || !context.can_select_local_origin}
                onClick={() => void selectLocalOrigin()}
              >
                Zapisz lokalne pochodzenie zwrotu
              </button>
            </div>
          )}
          {context.fulfillment_origin === 'local' && context.local_origin && (
            <div className="dr-card">
              <h4>Zapisane lokalne pochodzenie zwrotu</h4>
              <p>
                {date(context.local_origin.created_at)} · potwierdzenie {context.local_origin.id}
              </p>
              <ul>
                {context.local_origin.items.map((item) => (
                  <li key={item.customer_item_id}>
                    Pozycja {item.customer_item_id} · paczka {item.shipment_id} · {item.quantity}{' '}
                    szt.
                  </li>
                ))}
              </ul>
              <p>
                Przyjęcie do własnego magazynu wykonaj w osobnym formularzu tej sprawy. Zapisane
                pochodzenie nie oznacza fizycznego odbioru ani wypłaty.
              </p>
            </div>
          )}
          {!context.can_receive_locally && context.fulfillment_origin !== 'unselected' && (
            <p className="dr-notice">
              Przyjęcie tej sprawy odbywa się u dostawcy. Zwykłe lokalne przyjęcie jest wstrzymane;
              detaliczny zwrot wymaga osobnego uzgodnienia.
            </p>
          )}
          {(readOnly || io.flags?.read_only) && (
            <p>Tryb tylko do odczytu. Historia pozostaje dostępna.</p>
          )}
          {context.side === 'buyer' && context.can_preview && partnerSelected && (
            <>
              <button
                className="button"
                disabled={locked || !writable}
                onClick={() => void loadSources()}
              >
                Odczytaj wydane pozycje i dostawców
              </button>
              {sources && (
                <>
                  <p>
                    Odczytano {sources.length} powiązań. Wybierz jednostki handlowe i dokładne
                    fizyczne wydania; nie dopasowujemy ich po samym SKU.
                  </p>
                  {sources.map((row) => (
                    <div className="dr-card" key={sourceKey(row)}>
                      <h4>
                        {row.name} · {row.sku}
                      </h4>
                      <p>
                        {row.supplier_name} · {row.supplier_order_number} · zgłoszono{' '}
                        {row.requested}, dostępne do przekazania {row.quantity_available} jednostek
                      </p>
                      {financial && (
                        <p>
                          Oryginalna wartość pozycji detalicznej:{' '}
                          {amount(row.retail_line_total_minor, row.retail_currency)}
                        </p>
                      )}
                      <AddressView value={row.return_address} />
                      {!row.enabled && (
                        <p className="dr-notice">
                          Dostawca nie przyjmuje nowych przekazań tego kontrahenta. Odczytaj
                          ponownie po zmianie jego ustawień.
                        </p>
                      )}
                      <label>
                        Jednostki handlowe do tego dostawcy
                        <input
                          type="text"
                          inputMode="numeric"
                          value={draft[sourceKey(row)]?.quantity ?? '0'}
                          disabled={locked || !writable || !row.enabled}
                          onChange={(e) => editSource(sourceKey(row), { quantity: e.target.value })}
                        />
                      </label>
                      <Scroll>
                        <table>
                          <thead>
                            <tr>
                              <th>Fizyczny składnik</th>
                              <th>Na jednostkę / dostępne</th>
                              <th>Zwrot z tego wydania</th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.physical_sources.map((part) => (
                              <tr key={physicalKey(part)}>
                                <td>
                                  {part.name}
                                  <small>{part.sku}</small>
                                  <details>
                                    <summary>Identyfikatory wydania</summary>
                                    <small>
                                      {part.shipment_id}
                                      {part.issue_fragment_id && (
                                        <>
                                          <br />
                                          {part.issue_fragment_id}
                                        </>
                                      )}
                                    </small>
                                  </details>
                                </td>
                                <td>
                                  {part.quantity_per_unit} / {part.quantity_available}
                                </td>
                                <td>
                                  <input
                                    aria-label={`Fizyczny zwrot ${part.sku} · ${row.supplier_order_number} · ${part.shipment_id}`}
                                    inputMode="numeric"
                                    value={
                                      draft[sourceKey(row)]?.physical[physicalKey(part)] ?? '0'
                                    }
                                    disabled={locked || !writable || !row.enabled}
                                    onChange={(e) =>
                                      editSource(sourceKey(row), {
                                        physical: {
                                          ...draft[sourceKey(row)]?.physical,
                                          [physicalKey(part)]: e.target.value,
                                        },
                                      })
                                    }
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </Scroll>
                    </div>
                  ))}
                  {financial &&
                    [...new Map(sources.map((row) => [row.dropship_order_id, row])).values()].map(
                      (row) => (
                        <label key={row.dropship_order_id}>
                          Zwrot dostawy hurtowej · {row.supplier_name} · {row.wholesale_currency}
                          <input
                            inputMode="decimal"
                            value={supplierShipping[row.dropship_order_id] ?? '0,00'}
                            disabled={locked || !writable || !row.enabled}
                            onChange={(e) => {
                              setSupplierShipping((old) => ({
                                ...old,
                                [row.dropship_order_id]: e.target.value,
                              }));
                              invalidate();
                            }}
                          />
                        </label>
                      ),
                    )}
                  <button
                    className="button primary"
                    disabled={locked || !writable}
                    onClick={() => void prepare()}
                  >
                    Przygotuj pełny podgląd przekazania
                  </button>
                </>
              )}
            </>
          )}
          {preview && partnerSelected && (
            <div className="dr-card">
              <h4>
                Podgląd przekazania · {preview.total} pozycji · {preview.group_count} dostawców
              </h4>
              <p>Ważny do {date(preview.expires_at)}</p>
              {preview.groups.map((group) => (
                <div key={group.dropship_order_id}>
                  <strong>
                    {group.supplier_name} · {group.supplier_order_number}
                  </strong>
                  <AddressView value={group.return_address} />
                  {financial && (
                    <p>
                      Zwrot dostawy hurtowej:{' '}
                      {amount(group.supplier_shipping_refund_minor, group.wholesale_currency)}
                    </p>
                  )}
                </div>
              ))}
              {!previewRows ? (
                <button
                  className="button"
                  disabled={io.busy}
                  onClick={() => void loadPreview(preview.id)}
                >
                  Odczytaj wszystkie pozycje podglądu
                </button>
              ) : (
                <EvidenceRows rows={previewRows} financial={financial} />
              )}
              {preview.executed_case_ids.length ? (
                <p>Przekazanie już zapisano. Odczytaj powiązane sprawy dostawców.</p>
              ) : (
                <>
                  <label className="dr-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={locked || !writable || !previewRows || !preview.can_submit}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    Potwierdzam wszystkie pozycje, fizyczne wydania, adresy dostawców i niezależne
                    kwoty. Przekazanie nie przyjmuje towaru do mojego magazynu ani nie wykonuje
                    wypłaty.
                  </label>
                  <button
                    className="button primary"
                    disabled={
                      locked || !writable || !consent || !previewRows || !preview.can_submit
                    }
                    onClick={() => void submitPreview()}
                  >
                    Przekaż zwrot dostawcom
                  </button>
                </>
              )}
            </div>
          )}
          {cases && (
            <div className="dr-card">
              <h4>Powiązane sprawy dostawców</h4>
              <p>
                Odczytano {cases.data.length} z {cases.meta.total} spraw.
              </p>
              {cases.data.map((item) => (
                <div className="dr-actions" key={item.id}>
                  <strong>
                    {item.number} · {item.supplier_name}
                  </strong>
                  <span>
                    {caseNames[item.state] ?? item.state}
                    {item.retail_reconciled_at && ' · detalicznie uzgodniono'}
                  </span>
                  <button
                    className="button"
                    disabled={io.busy}
                    onClick={() => void loadCase(item.id)}
                  >
                    Odczytaj sprawę {item.number}
                  </button>
                </div>
              ))}
              {cases.meta.cursor && (
                <button
                  className="button"
                  disabled={io.busy}
                  onClick={() => void loadCases(cases.meta.cursor!)}
                >
                  Następne sprawy
                </button>
              )}
            </div>
          )}
          {selected && currentCase && (
            <div className="dr-card">
              <h4>
                {currentCase.number} · {caseNames[currentCase.state]}
              </h4>
              <p>
                {currentCase.supplier_name} · {currentCase.supplier_order_number} · wersja{' '}
                {currentCase.version}
              </p>
              <AddressView value={currentCase.return_address} />
              <EvidenceRows rows={selected.rows} financial={financial} />
              <Scroll>
                <table>
                  <thead>
                    <tr>
                      <th>Pozycja dostawcy</th>
                      <th>Zgłoszono</th>
                      <th>Przyjęto u dostawcy</th>
                      <th>Przywrócono do jego sprzedaży</th>
                      {financial && <th>Hurtowy zwrot</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {currentCase.supplier_items.map((item) => (
                      <tr key={item.supplier_item_id}>
                        <td>
                          {item.name}
                          <small>{item.sku}</small>
                        </td>
                        <td>{item.requested}</td>
                        <td>{item.accepted}</td>
                        <td>{item.restocked}</td>
                        {financial && (
                          <td>{amount(item.refund_minor, currentCase.wholesale_currency)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
              {currentCase.received_at && (
                <p>
                  Towar przyjęto u dostawcy: {date(currentCase.received_at)}. Nie jest to przyjęcie
                  w magazynie sprzedawcy.
                </p>
              )}
              {currentCase.retail_reconciled_at && (
                <p>
                  Detaliczny zwrot uzgodniono {date(currentCase.retail_reconciled_at)}. Rozliczenia
                  pieniężne pozostają osobne.
                </p>
              )}
              <h4>Historia sprawy</h4>
              {selected.events.length ? (
                selected.events.map((event) => (
                  <p key={event.id}>
                    <strong>{eventNames[event.kind] ?? event.kind}</strong> ·{' '}
                    {date(event.created_at)} · {event.actor_name}
                    {event.note && <small>{event.note}</small>}
                  </p>
                ))
              ) : (
                <p>Odczyt zakończony. Brak zdarzeń w tej sprawie.</p>
              )}
              {(currentCase.can_receive || currentCase.can_reject || currentCase.can_withdraw) && (
                <fieldset disabled={locked || !writable}>
                  {currentCase.can_receive && (
                    <>
                      <p>
                        Podaj ilości rzeczywiście odebrane przez Twoją firmę. Towar poza sprzedażą
                        nie zwiększy dostępnego zapasu.
                      </p>
                      {currentCase.supplier_items.map((item) => (
                        <div className="dr-grid" key={item.supplier_item_id}>
                          <label>
                            Przyjęto · {item.sku}
                            <input
                              inputMode="numeric"
                              value={received[item.supplier_item_id]?.accepted ?? '0'}
                              onChange={(e) => {
                                setReceived((old) => ({
                                  ...old,
                                  [item.supplier_item_id]: {
                                    ...old[item.supplier_item_id],
                                    accepted: e.target.value,
                                  },
                                }));
                                setActionConsent(false);
                              }}
                            />
                          </label>
                          <label>
                            Do sprzedaży · {item.sku}
                            <input
                              inputMode="numeric"
                              value={received[item.supplier_item_id]?.restocked ?? '0'}
                              onChange={(e) => {
                                setReceived((old) => ({
                                  ...old,
                                  [item.supplier_item_id]: {
                                    ...old[item.supplier_item_id],
                                    restocked: e.target.value,
                                  },
                                }));
                                setLots(null);
                                setLotsReady(false);
                                setActionConsent(false);
                              }}
                            />
                          </label>
                        </div>
                      ))}
                      {financial && (
                        <label>
                          Przyjęty zwrot dostawy hurtowej · {currentCase.wholesale_currency}
                          <input
                            inputMode="decimal"
                            value={receiveShipping}
                            onChange={(e) => {
                              setReceiveShipping(e.target.value);
                              setActionConsent(false);
                            }}
                          />
                        </label>
                      )}
                      {needsLots && (
                        <WmsReturnLotsFields
                          key={`${scope}:${currentCase.id}:${restockedProducts.join(',')}`}
                          orderId={currentCase.supplier_order_id}
                          warehouseId={currentCase.warehouse_id}
                          physicalProductIds={restockedProducts}
                          contextKey={contextKey}
                          readOnly={readOnly}
                          onChange={(payload, ready) => {
                            setLots(payload);
                            setLotsReady(ready);
                            setActionConsent(false);
                          }}
                        />
                      )}
                    </>
                  )}
                  <label>
                    Uzasadnienie przyjęcia, odmowy lub wycofania
                    <textarea
                      value={note}
                      minLength={3}
                      maxLength={2000}
                      onChange={(e) => {
                        setNote(e.target.value);
                        setActionConsent(false);
                      }}
                    />
                  </label>
                  <label className="dr-check">
                    <input
                      type="checkbox"
                      checked={actionConsent}
                      onChange={(e) => setActionConsent(e.target.checked)}
                    />
                    Potwierdzam wybraną decyzję i dokładne ilości tej sprawy. Nie potwierdzam
                    wypłaty.
                  </label>
                  <div className="dr-actions">
                    {currentCase.can_receive && (
                      <button
                        className="button primary"
                        disabled={!actionConsent || (needsLots && !lotsReady)}
                        onClick={() => void caseAction('receive')}
                      >
                        Potwierdź fizyczne przyjęcie u dostawcy
                      </button>
                    )}
                    {currentCase.can_reject && (
                      <button
                        className="button"
                        disabled={!actionConsent}
                        onClick={() => void caseAction('decision')}
                      >
                        Odmów przyjęcia z uzasadnieniem
                      </button>
                    )}
                    {currentCase.can_withdraw && (
                      <button
                        className="button"
                        disabled={!actionConsent}
                        onClick={() => void caseAction('withdraw')}
                      >
                        Wycofaj przekazanie
                      </button>
                    )}
                  </div>
                </fieldset>
              )}
            </div>
          )}
          {context.side === 'buyer' && context.can_reconcile && (
            <div className="dr-card">
              <h4>Uzgodnienie detalicznego zwrotu</h4>
              <p>
                Podstawą są decyzje wszystkich dostawców. Lokalny zapas sprzedawcy pozostaje bez
                zmian.
              </p>
              <p>
                Uzgodnienie obejmuje aktualne sprawy wskazane poniżej. Wycofane przekazania
                pozostają w historii.
              </p>
              <ul>
                {context.case_refs.map((ref) => (
                  <li key={ref.id}>
                    {ref.number} · {caseNames[ref.state] ?? ref.state} · wersja {ref.version}
                  </li>
                ))}
              </ul>
              <fieldset disabled={locked || !writable}>
                {context.retail_items.map((item) => (
                  <label key={item.customer_item_id}>
                    Detaliczna akceptacja · {item.name} · {item.sku} (maks.{' '}
                    {item.accepted_available} z {item.requested})
                    <input
                      inputMode="numeric"
                      value={retailAccepted[item.customer_item_id] ?? '0'}
                      onChange={(e) => {
                        setRetailAccepted((old) => ({
                          ...old,
                          [item.customer_item_id]: e.target.value,
                        }));
                        setReconcileConsent(false);
                      }}
                    />
                  </label>
                ))}
                {financial && (
                  <label>
                    Detaliczny zwrot dostawy · {context.currency} (maks.{' '}
                    {amount(context.shipping_refund_available_minor, context.currency)})
                    <input
                      inputMode="decimal"
                      value={retailShipping}
                      onChange={(e) => {
                        setRetailShipping(e.target.value);
                        setReconcileConsent(false);
                      }}
                    />
                  </label>
                )}
                <label>
                  Uzasadnienie uzgodnienia
                  <textarea
                    value={retailNote}
                    minLength={3}
                    maxLength={2000}
                    onChange={(e) => {
                      setRetailNote(e.target.value);
                      setReconcileConsent(false);
                    }}
                  />
                </label>
                <label className="dr-check">
                  <input
                    type="checkbox"
                    checked={reconcileConsent}
                    onChange={(e) => setReconcileConsent(e.target.checked)}
                  />
                  Potwierdzam wszystkie pokazane decyzje detaliczne na podstawie przyjęcia lub
                  odmowy dostawców. Nie zapisuję lokalnego przyjęcia ani wypłaty.
                </label>
                <button
                  className="button primary"
                  disabled={
                    !reconcileConsent ||
                    !cases ||
                    !!cases.meta.cursor ||
                    cases.data.length !== cases.meta.total ||
                    context.case_refs.length === 0 ||
                    new Set(context.case_refs.map((ref) => ref.id)).size !==
                      context.case_refs.length ||
                    !context.case_refs.every((ref) =>
                      cases.data.some((item) => item.id === ref.id && item.version === ref.version),
                    )
                  }
                  onClick={() => void reconcile()}
                >
                  Uzgodnij detaliczny zwrot
                </button>
              </fieldset>
            </div>
          )}
          <p className="dr-notice">
            Kwota zaakceptowanego zwrotu obniża odpowiednią należność. Potwierdzenie rozliczenia
            klienta i rozliczenia hurtowego wykonujesz osobno w ich sprawach. Ten panel nie wykonuje
            przelewu ani wysyłki.
          </p>
        </>
      )}
    </section>
  );
}
