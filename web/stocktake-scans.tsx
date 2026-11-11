import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import { BarcodeScanner } from './barcode-scanner';
import './stocktake-scans.css';

type Engine = 'wms' | 'quantity';
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_resolve: boolean;
  can_scan: boolean;
  can_replay: boolean;
};
type Lot = { id: string | null; lot_code: string; expiry_date: string | null };
type Candidate = {
  line_id: string;
  product_id: string;
  sku: string;
  name: string;
  current_sku: string;
  current_ean: string | null;
  location: string;
  lot: Lot | null;
  matched_by: string[];
  line_version: string;
  counted: number | null;
  needs_recount: boolean;
  generation_id: string | null;
  can_continue: boolean;
  basis_token: string;
  resolution_token: string;
  expires_at: string;
};
type ScanReceipt = {
  id: string;
  stocktake_id: string;
  engine: Engine;
  line_id: string;
  product_id: string;
  location: string;
  lot: Lot | null;
  kind: 'start' | 'increment';
  generation_id: string;
  code: string;
  matched_by: string[];
  previous_count: number | null;
  counted: number;
  increment: 0 | 1;
  before_line_version: string;
  after_line_version: string;
  measurement_id: string;
  stocktake_version: string;
  created_at: string;
};
type Metadata = Flags & {
  engine: Engine;
  limits: Record<string, number>;
  stocktake: { id: string; state: string; version: string; warehouse_id: string; blind: boolean };
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null; total?: number } };
type ScanDetail = Flags & { scan: ScanReceipt };
type Response = ScanDetail & { reused?: boolean; current_line: Candidate | null };
type Attempt = { path: string; body: Record<string, unknown>; label: string };
type Resolved = { code: string; location: string; data: Candidate[] };
class StaleScan extends Error {}
const matchNames: Record<string, string> = {
  frozen_sku: 'SKU w spisie',
  current_sku: 'Bieżące SKU',
  sku_alias: 'Dawne SKU',
  current_ean: 'Bieżący EAN',
};
const reason = (error: unknown) =>
  error instanceof Error ? error.message : 'Nie udało się odczytać wyniku.';
function text(value: string, label: string, min: number, max: number) {
  const trimmed = value.trim();
  if (
    trimmed.length < min ||
    trimmed.length > max ||
    /[\u0000-\u001f\u007f]/.test(trimmed) ||
    new TextDecoder().decode(new TextEncoder().encode(trimmed)) !== trimmed
  )
    throw new Error(
      `${label}: wymagane ${min}–${max} znaków poprawnego tekstu bez znaków sterujących.`,
    );
  return trimmed;
}

export type StocktakeScansProps = {
  engine: Engine;
  stocktakeId: string;
  contextKey: string;
  readOnly: boolean;
  refresh?: number;
  disabled?: boolean;
  onChanged?: () => void;
  /** Locks sibling writers and target changes while scan mode or an uncertain write is active. */
  onPendingChange?: (locked: boolean) => void;
  onAccessDenied?: () => void;
};
export function StocktakeScans(props: StocktakeScansProps) {
  return (
    <ScansScope
      key={`${props.contextKey}:${props.readOnly}:${props.engine}:${props.stocktakeId}`}
      {...props}
    />
  );
}
function ScansScope({
  engine,
  stocktakeId,
  contextKey,
  readOnly,
  refresh = 0,
  disabled = false,
  onChanged,
  onPendingChange,
  onAccessDenied,
}: StocktakeScansProps) {
  const prefix = (engine === 'wms' ? '/wms-lots/stocktakes/' : '/stocktakes/') + stocktakeId;
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false),
    [error, setError] = useState('');
  const [notice, setNotice] = useState(''),
    [location, setLocation] = useState(''),
    [code, setCode] = useState('');
  const [resolved, setResolved] = useState<Resolved | null>(null),
    [selectedId, setSelectedId] = useState('');
  const [candidatePage, setCandidatePage] = useState(0),
    [zero, setZero] = useState(false),
    [reset, setReset] = useState(false);
  const [note, setNote] = useState(''),
    [pending, setPending] = useState<Attempt | null>(null);
  const [receipt, setReceipt] = useState<ScanReceipt | null>(null);
  const [history, setHistory] = useState<ScanReceipt[]>([]),
    [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyNext, setHistoryNext] = useState<string | null>(null),
    [historyPath, setHistoryPath] = useState<(string | null)[]>([null]);
  const [historyLine, setHistoryLine] = useState(''),
    [historyFilter, setHistoryFilter] = useState('');
  const input = useRef<HTMLInputElement>(null),
    live = useRef(false),
    epoch = useRef(0),
    gate = useRef(false);
  const role = useRef<string | null>(null),
    pendingRef = useRef<Attempt | null>(null);
  const callbacks = useRef({ onChanged, onPendingChange, onAccessDenied });
  const previousRefresh = useRef(refresh),
    denied = useRef(false),
    mode = useRef(false);
  callbacks.current = { onChanged, onPendingChange, onAccessDenied };
  const current = (e: number) => live.current && epoch.current === e;
  const candidate = resolved?.data.find((row) => row.line_id === selectedId) ?? null;
  const matchesDraft =
    !!resolved && code.trim() === resolved.code && location.trim() === resolved.location;
  const target = matchesDraft ? candidate : null;
  const writable =
    !!meta?.available &&
    meta.can_scan &&
    !meta.read_only &&
    !readOnly &&
    meta.stocktake.state === 'counting' &&
    !blocked &&
    !disabled;
  const locked = busy || !!pending || blocked;
  const pageSize = Math.min(100, Math.max(1, meta?.limits.page ?? 50));

  function changeMode(value: boolean) {
    mode.current = value;
    setEnabled(value);
    callbacks.current.onPendingChange?.(value || !!pendingRef.current);
  }
  function forgetTarget() {
    setResolved(null);
    setSelectedId('');
    setHistoryLine('');
    setCandidatePage(0);
    setZero(false);
    setReset(false);
  }
  function purge() {
    ++epoch.current;
    gate.current = false;
    denied.current = true;
    pendingRef.current = null;
    mode.current = false;
    setPending(null);
    setBusy(false);
    setBlocked(true);
    setEnabled(false);
    setMeta(null);
    forgetTarget();
    setCode('');
    setLocation('');
    setNote('');
    setReceipt(null);
    setHistory([]);
    setHistoryLoaded(false);
    setHistoryNext(null);
    setHistoryPath([null]);
    setHistoryLine('');
    setHistoryFilter('');
    setNotice('');
    callbacks.current.onPendingChange?.(false);
    callbacks.current.onAccessDenied?.();
  }
  function adopt(data: Flags) {
    if (role.current && role.current !== data.current_role) {
      purge();
      setError('Zmieniła się rola. Ponownie otwórz panel po odświeżeniu uprawnień.');
      throw new StaleScan();
    }
    role.current = data.current_role;
    setMeta((old) => (old ? { ...old, ...data } : old));
    if (data.read_only || !data.available || !data.can_scan) {
      mode.current = false;
      setEnabled(false);
      forgetTarget();
      if (pendingRef.current && (data.read_only || !data.available || !data.can_replay)) {
        denied.current = true;
        setBlocked(true);
        pendingRef.current = null;
        setPending(null);
        setError(
          'Zapis został zablokowany przez aktualne uprawnienia. Odczytaj historię; nie ponawiaj zapisu.',
        );
      }
      callbacks.current.onPendingChange?.(!!pendingRef.current);
    }
  }
  async function get<T extends Flags>(path: string, e: number): Promise<T> {
    const data = await api<T>(path);
    if (!current(e)) throw new StaleScan();
    adopt(data);
    if (!current(e)) throw new StaleScan();
    return data;
  }
  function handle(error: unknown, e: number, writing = false) {
    if (!current(e) || error instanceof StaleScan) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      purge();
      setError('Dostęp został cofnięty. Ponownie otwórz panel po odświeżeniu uprawnień.');
      return;
    }
    if (error instanceof ApiError && error.status === 423) {
      denied.current = true;
      setBlocked(true);
      changeMode(false);
      forgetTarget();
      pendingRef.current = null;
      setPending(null);
      setCode('');
      setLocation('');
      setNote('');
      callbacks.current.onPendingChange?.(false);
    } else if (writing && error instanceof ApiError && error.status >= 400 && error.status < 500) {
      pendingRef.current = null;
      setPending(null);
      callbacks.current.onPendingChange?.(mode.current);
      setZero(false);
      setReset(false);
      if (error.status === 409) {
        forgetTarget();
        setNotice(
          error.message.includes('scope_changed')
            ? 'Zmienił się skład partii. Anuluj ten spis i utwórz nowy zakres; ponowne rozpoznanie kodu nie rozszerza starego spisu.'
            : 'Próba została odrzucona. Odczytaj ponownie pozycję; po zmianie podstawy rozpocznij fizyczne liczenie od nowa. Nie podmieniono wersji ani klucza próby.',
        );
      }
    }
    setError(reason(error));
  }
  async function read(work: (e: number) => Promise<void>) {
    if (!live.current || gate.current) return;
    const e = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      await work(e);
    } catch (err) {
      handle(err, e);
    } finally {
      if (current(e)) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  async function metadata(e: number) {
    const data = await get<Metadata>(prefix + '/scan-metadata', e);
    if (data.available && (data.engine !== engine || data.stocktake.id !== stocktakeId))
      throw new Error('Odczyt skanowania dotyczy innego spisu.');
    setMeta(data);
    if (data.available && data.stocktake.state !== 'counting') {
      changeMode(false);
      forgetTarget();
    }
  }
  async function resolve(e: number, chosenCode: string, chosenLocation: string, keepId = '') {
    const result: Candidate[] = [],
      seenIds = new Set<string>(),
      seenCursors = new Set<string>();
    let cursor: string | null = null,
      total: number | undefined;
    const max = engine === 'wms' ? 10000 : 2000;
    do {
      const params = new URLSearchParams({
        code: chosenCode,
        location: chosenLocation,
        limit: '100',
      });
      if (cursor) params.set('cursor', cursor);
      const page: Page<Candidate> = await get<Page<Candidate>>(
        prefix + '/scan-candidates?' + params,
        e,
      );
      if (!page.available || !page.can_resolve)
        throw new Error('Rozpoznawanie kodu jest obecnie niedostępne.');
      if (!Number.isInteger(page.meta.total) || page.meta.total! < 0 || page.meta.total! > max)
        throw new Error(
          'Nieprawidłowy lub zbyt duży zakres rozpoznanych pozycji. Niczego nie obcięto.',
        );
      if (total !== undefined && total !== page.meta.total)
        throw new Error('Zakres dopasowań zmienił się podczas odczytu. Rozpoznaj kod ponownie.');
      total = page.meta.total;
      for (const row of page.data) {
        if (seenIds.has(row.line_id) || row.location !== chosenLocation)
          throw new Error('Niespójne dopasowanie pozycji lub lokalizacji. Rozpoznaj kod ponownie.');
        seenIds.add(row.line_id);
        result.push(row);
      }
      if (result.length > max || page.data.length > 100)
        throw new Error('Zakres przekracza limit. Nie wybrano części pozycji.');
      cursor = page.meta.cursor;
      if (cursor) {
        if (!page.data.length || seenCursors.has(cursor))
          throw new Error('Nie udało się odczytać pełnego zakresu dopasowań.');
        seenCursors.add(cursor);
      }
    } while (cursor);
    if (result.length !== total)
      throw new Error('Odczyt dopasowań jest niepełny. Niczego nie wybrano.');
    setResolved({ code: chosenCode, location: chosenLocation, data: result });
    setSelectedId(keepId && result.some((r) => r.line_id === keepId) ? keepId : '');
    setCandidatePage(0);
    setZero(false);
    setReset(false);
    if (!result.length)
      setNotice(
        'Kod nie wskazuje pozycji w tej lokalizacji i zakresie spisu. Nie zapisano pomiaru.',
      );
    else if (!keepId)
      setNotice('Rozpoznano kod. Wybierz dokładną pozycję; samo rozpoznanie nie liczy sztuki.');
  }
  function lookup() {
    try {
      if (!meta?.can_resolve || !meta.available || gate.current || pendingRef.current || disabled)
        return;
      const chosenCode = text(code, 'EAN / SKU', 1, 80),
        chosenLocation = text(location, 'Lokalizacja', 1, 80);
      forgetTarget();
      setNotice('');
      void read((e) => resolve(e, chosenCode, chosenLocation));
    } catch (err) {
      setError(reason(err));
    }
  }
  async function send(attempt: Attempt) {
    if (
      !live.current ||
      gate.current ||
      denied.current ||
      readOnly ||
      disabled ||
      !meta?.available ||
      meta.read_only ||
      (pendingRef.current ? !meta.can_replay : !meta.can_scan)
    )
      return;
    const e = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    pendingRef.current = attempt;
    setPending(attempt);
    callbacks.current.onPendingChange?.(true);
    try {
      const response = await api<Response>(attempt.path, 'POST', attempt.body);
      if (!current(e)) return;
      adopt(response);
      if (!current(e)) return;
      if (
        response.scan.stocktake_id !== stocktakeId ||
        response.scan.engine !== engine ||
        response.scan.line_id !== attempt.body.line_id
      )
        throw new Error(
          'Odpowiedź nie potwierdza dokładnej pozycji tej próby. Zachowano ją do ponowienia.',
        );
      setReceipt(response.scan);
      pendingRef.current = null;
      setPending(null);
      setZero(false);
      setReset(false);
      callbacks.current.onPendingChange?.(mode.current);
      setNotice(
        `${response.scan.kind === 'start' ? 'Rozpoczęto liczenie od 0' : 'Zapisano jedną sztukę'} · pomiar ${response.scan.counted} szt.${response.reused ? ' · potwierdzono tę samą próbę' : ''}. Stan magazynowy pozostaje bez zmian.`,
      );
      callbacks.current.onChanged?.();
      const fresh = response.current_line;
      if (
        fresh &&
        response.can_scan &&
        !response.read_only &&
        mode.current &&
        fresh.line_id === attempt.body.line_id &&
        fresh.location === attempt.body.location
      ) {
        setResolved({
          code: String(attempt.body.code),
          location: String(attempt.body.location),
          data: [fresh],
        });
        setSelectedId(fresh.line_id);
        setCandidatePage(0);
      } else forgetTarget();
      if (current(e) && mode.current && document.activeElement === input.current)
        input.current?.select();
    } catch (err) {
      handle(err, e, true);
    } finally {
      if (current(e)) {
        gate.current = false;
        setBusy(false);
        callbacks.current.onPendingChange?.(mode.current || !!pendingRef.current);
      }
    }
  }
  function write(kind: 'start' | 'increment') {
    try {
      if (!writable || !enabled || locked || !target || pendingRef.current) return;
      if (Date.parse(target.expires_at) <= Date.now())
        throw new Error('Dopasowanie wygasło. Odczytaj ponownie pozycję.');
      if (kind === 'start' && (!zero || (target.counted !== null && !reset)))
        throw new Error(
          'Potwierdź rozpoczęcie od zera i ponowne fizyczne liczenie istniejącego pomiaru.',
        );
      if (kind === 'increment' && (!target.can_continue || !target.generation_id))
        throw new Error('Ta pozycja wymaga jawnego rozpoczęcia liczenia od 0.');
      const body = {
        client_key: crypto.randomUUID(),
        line_id: target.line_id,
        version: target.line_version,
        basis_token: target.basis_token,
        code: resolved!.code,
        location: resolved!.location,
        resolution_token: target.resolution_token,
        expires_at: target.expires_at,
        ...(kind === 'start'
          ? {
              confirmed_zero: true,
              confirmed_reset: target.counted !== null && reset,
              note: text(note, 'Notatka rozpoczęcia', 3, 500),
            }
          : { generation_id: target.generation_id, increment: 1 }),
      };
      if (
        new TextEncoder().encode(JSON.stringify(body)).byteLength >
        (meta?.limits.request_bytes ?? 16384)
      )
        throw new Error('Treść próby przekracza limit. Nie zapisano części danych.');
      void send({
        path: prefix + (kind === 'start' ? '/scan-start' : '/scans'),
        body,
        label: kind === 'start' ? 'Rozpoczęcie od zera' : 'Skan jednej sztuki',
      });
    } catch (err) {
      setError(reason(err));
    }
  }
  async function historyPage(
    e: number,
    cursor: string | null,
    path: (string | null)[],
    filter: string,
  ) {
    const params = new URLSearchParams({ limit: '50' });
    if (cursor) params.set('cursor', cursor);
    if (filter) params.set('line_id', filter);
    const data = await get<Page<ScanReceipt>>(prefix + '/scans?' + params, e);
    if (
      data.data.length > 100 ||
      data.data.some((r) => r.stocktake_id !== stocktakeId || r.engine !== engine)
    )
      throw new Error('Historia zawiera nieprawidłowy zakres.');
    setHistory(data.data);
    setHistoryNext(data.meta.cursor);
    setHistoryPath(path);
    setHistoryLoaded(true);
    setHistoryFilter(filter);
  }
  useEffect(() => {
    live.current = true;
    ++epoch.current;
    gate.current = false;
    role.current = null;
    denied.current = false;
    pendingRef.current = null;
    mode.current = false;
    setBlocked(false);
    setBusy(false);
    setPending(null);
    setEnabled(false);
    void read(metadata);
    return () => {
      live.current = false;
      ++epoch.current;
      gate.current = false;
      pendingRef.current = null;
      mode.current = false;
      callbacks.current.onPendingChange?.(false);
    };
  }, [contextKey, readOnly, engine, stocktakeId]);
  useEffect(() => {
    if (previousRefresh.current === refresh) return;
    previousRefresh.current = refresh;
    if (pendingRef.current) return; // Never discard an uncertain exact attempt on a sibling refresh.
    forgetTarget();
    setNotice('Otoczenie spisu mogło się zmienić. Odczytaj pozycję przed następnym skanem.');
  }, [refresh]);
  const choices =
    resolved?.data.slice(candidatePage * pageSize, (candidatePage + 1) * pageSize) ?? [];
  return (
    <section className="sts-panel" aria-label="Skanowanie spisu EAN i SKU">
      <header className="sts-heading">
        <div>
          <h3>Skanowanie sztuk · EAN / SKU</h3>
          <p>
            Jawny bin i pozycja → rozpoczęcie od 0 → jeden skan na sztukę. Pomiar nie zmienia
            zapasu.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void read(metadata)}
        >
          Odczytaj dostępność skanowania
        </button>
      </header>
      {error && (
        <p className="sts-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="sts-notice" role="status">
          {notice}
        </p>
      )}
      {!meta ? (
        <p>
          {busy
            ? 'Odczyt dostępności skanowania…'
            : 'Dostępność skanowania nie została potwierdzona. Odczytaj ją ponownie.'}
        </p>
      ) : !meta.available ? (
        <p className="sts-warning">
          Ta kopia nie zawiera modułu skanowania. Dotychczasowe pomiary spisu pozostają w jego
          historii.
        </p>
      ) : (
        <>
          {(meta.read_only || readOnly || !meta.can_scan) && (
            <p className="sts-help">
              Skanowanie jest tylko do odczytu. Historia pokazuje rzeczywiste zapisane pomiary.
            </p>
          )}
          {meta.stocktake.state !== 'counting' && (
            <p className="sts-help">
              Nowe skany są dostępne wyłącznie podczas liczenia. Ten spis jest już poza tym etapem.
            </p>
          )}
          {disabled && (
            <p className="sts-warning">
              Najpierw zakończ inną operację i zapisz albo usuń ręczne szkice pomiarów. Skan nie
              nadpisuje szkicu.
            </p>
          )}
          <div className="sts-actions">
            <button
              type="button"
              className="button"
              aria-pressed={enabled}
              disabled={busy || !!pending || (!enabled && !writable)}
              onClick={() => changeMode(!enabled)}
            >
              {enabled ? 'Wyłącz skanowanie' : 'Włącz skanowanie'}
            </button>
            <button
              type="button"
              className="button"
              disabled={!enabled || locked || !writable}
              onClick={() => {
                input.current?.focus();
                input.current?.select();
              }}
            >
              Przejdź do pola kodu
            </button>
            <span>
              {enabled
                ? 'Tryb skanowania aktywny — Enter w polu kodu'
                : 'Tryb skanowania wyłączony'}
            </span>
          </div>
          <form
            className="sts-code-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || pending) {
                setError(
                  'Ten odczyt kodu nie został zapisany. Poczekaj na potwierdzenie bieżącej próby i zeskanuj sztukę ponownie.',
                );
                return;
              }
              if (!enabled || locked || !writable) return;
              if (target?.can_continue) write('increment');
              else lookup();
            }}
          >
            <label>
              Lokalizacja / bin
              <input
                aria-label="Lokalizacja skanowania"
                value={location}
                disabled={locked || !enabled || !writable}
                onChange={(e) => {
                  setLocation(e.target.value);
                  forgetTarget();
                  setNotice('');
                }}
                placeholder="Wpisz dokładną lokalizację"
              />
            </label>
            <label>
              EAN / SKU
              <input
                ref={input}
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                aria-label="Kod EAN lub SKU do skanowania"
                value={code}
                readOnly={busy || !!pending}
                disabled={blocked || !enabled || !writable}
                onChange={(e) => {
                  setCode(e.target.value);
                  setZero(false);
                  setReset(false);
                }}
                onKeyDown={(e) => {
                  // Wedge scanners end a read with Enter or Tab; Tab on an empty field still moves focus.
                  const tab = e.key === 'Tab' && !e.shiftKey && !!code.trim();
                  if (e.key !== 'Enter' && !tab) return;
                  e.preventDefault();
                  if (e.repeat) return;
                  if (busy || pending) {
                    setError(
                      'Ten odczyt kodu nie został zapisany. Poczekaj na potwierdzenie bieżącej próby i zeskanuj sztukę ponownie.',
                    );
                    return;
                  }
                  if (!enabled || locked || !writable) return;
                  if (target?.can_continue) write('increment');
                  else lookup();
                }}
                placeholder="Skaner USB lub ręczny kod, potem Enter"
              />
            </label>
            <button
              type="button"
              className="button"
              disabled={locked || !enabled || !writable}
              onClick={lookup}
            >
              Rozpoznaj / odczytaj pozycję
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={locked || !enabled || !writable || !target?.can_continue}
            >
              Zapisz jedną sztukę (+1)
            </button>
          </form>
          <BarcodeScanner
            label="Odczytaj kod aparatem"
            disabled={locked || !enabled || !writable}
            onDetected={(value) => {
              // Same as typing the code: the operator still confirms with Enter or the buttons above.
              setCode(value);
              setZero(false);
              setReset(false);
              input.current?.focus();
            }}
          />
          {busy && (
            <p className="sts-warning" role="status">
              Trwa odczyt lub zapis. Poczekaj na potwierdzenie przed następnym fizycznym skanem;
              kolejne kody nie są kolejkowane.
            </p>
          )}
          {resolved && (
            <div className="sts-candidates">
              <h4>
                Pozycje w lokalizacji {resolved.location} · {resolved.data.length}
              </h4>
              <p>
                Wybierz dokładny produkt{engine === 'wms' ? ' i partię' : ''}. Rozpoznanie kodu samo
                nie zapisuje sztuki.
              </p>
              {!resolved.data.length ? (
                <p>Brak dopasowań w zakresie spisu.</p>
              ) : (
                <div className="sts-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Wybór</th>
                        <th>Produkt</th>
                        <th>Bin / partia</th>
                        <th>Własny zapisany pomiar</th>
                        <th>Dopasowanie</th>
                      </tr>
                    </thead>
                    <tbody>
                      {choices.map((row) => (
                        <tr key={row.line_id}>
                          <td>
                            <input
                              type="radio"
                              name={'scan-line-' + stocktakeId}
                              checked={selectedId === row.line_id}
                              disabled={locked || !enabled || !writable}
                              aria-label={`Wybierz ${row.sku}, ${row.location}${row.lot ? ', partia ' + row.lot.lot_code : ''}`}
                              onChange={() => {
                                setSelectedId(row.line_id);
                                setHistoryLine('');
                                setZero(false);
                                setReset(false);
                              }}
                            />
                          </td>
                          <td>
                            <strong>{row.sku}</strong>
                            <small>{row.name}</small>
                            {row.current_sku !== row.sku && (
                              <small>Bieżące SKU: {row.current_sku}</small>
                            )}
                            {row.current_ean && <small>Bieżący EAN: {row.current_ean}</small>}
                          </td>
                          <td>
                            {row.location}
                            {row.lot && (
                              <>
                                <small>Partia: {row.lot.lot_code}</small>
                                {row.lot.expiry_date && (
                                  <small>Termin: {row.lot.expiry_date}</small>
                                )}
                              </>
                            )}
                          </td>
                          <td>
                            {row.counted === null ? 'Niepoliczona' : row.counted + ' szt.'}
                            <small>
                              {row.can_continue
                                ? 'Możesz kontynuować liczenie'
                                : 'Wymagany jawny start od 0'}
                            </small>
                            {row.needs_recount && <small>Ponownie przelicz fizyczne sztuki</small>}
                          </td>
                          <td>{row.matched_by.map((m) => matchNames[m] ?? m).join(', ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {resolved.data.length > pageSize && (
                <div className="sts-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={locked || candidatePage === 0}
                    onClick={() => setCandidatePage(candidatePage - 1)}
                  >
                    Poprzednie dopasowania
                  </button>
                  <span>
                    Strona {candidatePage + 1} / {Math.ceil(resolved.data.length / pageSize)}
                  </span>
                  <button
                    type="button"
                    className="button"
                    disabled={locked || (candidatePage + 1) * pageSize >= resolved.data.length}
                    onClick={() => setCandidatePage(candidatePage + 1)}
                  >
                    Następne dopasowania
                  </button>
                </div>
              )}
            </div>
          )}
          {target && (
            <div className="sts-start">
              <h4>
                {target.sku} · {target.location}
                {target.lot ? ' · partia ' + target.lot.lot_code : ''}
              </h4>
              <p>
                Zapisany pomiar:{' '}
                <strong>
                  {target.counted === null ? 'Niepoliczona' : target.counted + ' szt.'}
                </strong>
                . Wersja pozycji {target.line_version}.
              </p>
              <p>
                Rozpoczęcie od 0 jest trwałym pomiarem i zastępuje wcześniejszy licznik tej pozycji.
                Ponownie policz wszystkie fizyczne sztuki. Stan magazynowy rozliczy później
                administrator.
              </p>
              <label>
                Notatka rozpoczęcia
                <input
                  aria-label="Notatka rozpoczęcia liczenia od zera"
                  value={note}
                  disabled={locked || !enabled || !writable}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setZero(false);
                    setReset(false);
                  }}
                />
              </label>
              <label className="sts-check">
                <input
                  type="checkbox"
                  checked={zero}
                  disabled={locked || !enabled || !writable}
                  onChange={(e) => setZero(e.target.checked)}
                />
                Potwierdzam rozpoczęcie fizycznego liczenia tej pozycji od 0.
              </label>
              {target.counted !== null && (
                <label className="sts-check">
                  <input
                    type="checkbox"
                    checked={reset}
                    disabled={locked || !enabled || !writable}
                    onChange={(e) => setReset(e.target.checked)}
                  />
                  Potwierdzam zastąpienie wcześniejszego pomiaru {target.counted} szt. i ponowne
                  przeliczenie.
                </label>
              )}
              <button
                type="button"
                className="button"
                disabled={
                  locked || !enabled || !writable || !zero || (target.counted !== null && !reset)
                }
                onClick={() => write('start')}
              >
                Rozpocznij od 0
              </button>
            </div>
          )}
        </>
      )}
      {pending && (
        <div className="sts-warning" role="status">
          <strong>{pending.label}: wynik niepotwierdzony.</strong>
          <p>
            Operacja mogła zostać zapisana. Zatrzymano następne skany. Dokładny klucz i treść
            zachowano tylko w pamięci tego panelu. Odczyt historii sam nie potwierdza tej próby;
            ponów ją ręcznie, aby uzyskać jej trwały dowód. Zamknięcie panelu usuwa możliwość tego
            ponowienia.
          </p>
          <button
            type="button"
            className="button"
            disabled={busy || blocked || readOnly || disabled || !meta?.can_replay}
            onClick={() => {
              if (pendingRef.current) void send(pendingRef.current);
            }}
          >
            Ponów dokładnie tę samą próbę skanu
          </button>
        </div>
      )}
      {receipt && <ReceiptView receipt={receipt} />}
      {!!meta?.available && (
        <div className="sts-history">
          <h4>Historia skanów i rozpoczęć</h4>
          <div className="sts-actions">
            <label>
              Zakres historii
              <select
                aria-label="Zakres historii skanów"
                value={historyLine}
                disabled={busy}
                onChange={(e) => setHistoryLine(e.target.value)}
              >
                <option value="">Cały spis</option>
                {candidate && (
                  <option value={candidate.line_id}>
                    Wybrana pozycja {candidate.sku} · {candidate.location}
                  </option>
                )}
              </select>
            </label>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void read((e) => historyPage(e, null, [null], historyLine))}
            >
              Odczytaj historię skanów
            </button>
          </div>
          {historyLoaded && (
            <p className="sts-help">
              Wyświetlana historia: {historyFilter ? 'jedna pozycja spisu' : 'cały spis'}. Zmiana
              wyboru zakresu wymaga ponownego odczytu historii.
            </p>
          )}
          {historyLoaded &&
            (!history.length ? (
              <p>Odczyt zakończony: brak zapisanych skanów w tym zakresie.</p>
            ) : (
              <div className="sts-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Czas</th>
                      <th>Operacja i kod</th>
                      <th>Bin / partia</th>
                      <th>Własny pomiar przed → po</th>
                      <th>Dowód</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((r) => (
                      <tr key={r.id}>
                        <td>{date(r.created_at)}</td>
                        <td>
                          {r.kind === 'start' ? 'Rozpoczęcie od 0' : 'Jedna sztuka (+1)'}
                          <small>{r.code}</small>
                        </td>
                        <td>
                          {r.location}
                          {r.lot && <small>Partia: {r.lot.lot_code}</small>}
                        </td>
                        <td>
                          {r.previous_count === null ? 'Niepoliczona' : r.previous_count} →{' '}
                          {r.counted} szt.
                        </td>
                        <td>
                          <button
                            type="button"
                            className="button"
                            disabled={busy}
                            onClick={() =>
                              void read(async (e) => {
                                const d = await get<ScanDetail>(prefix + '/scans/' + r.id, e);
                                if (d.scan.stocktake_id !== stocktakeId || d.scan.engine !== engine)
                                  throw new Error('Dowód dotyczy innego spisu.');
                                setReceipt(d.scan);
                              })
                            }
                          >
                            Odczytaj dowód skanu
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          {historyLoaded && (
            <div className="sts-actions">
              <button
                type="button"
                className="button"
                disabled={busy || historyPath.length < 2}
                onClick={() => {
                  const p = historyPath.slice(0, -1);
                  void read((e) => historyPage(e, p.at(-1)!, p, historyFilter));
                }}
              >
                Poprzednia strona skanów
              </button>
              <button
                type="button"
                className="button"
                disabled={busy || !historyNext}
                onClick={() =>
                  void read((e) =>
                    historyPage(e, historyNext, [...historyPath, historyNext], historyFilter),
                  )
                }
              >
                Następna strona skanów
              </button>
            </div>
          )}
        </div>
      )}
      <p className="sts-help">
        Skaner USB działający jako klawiatura wysyła kod i Enter do aktywnego pola. Każdy
        zatwierdzony skan liczy jedną sztukę. Nie zapisujemy kolejki offline ani nie ponawiamy
        zapisu automatycznie.
      </p>
    </section>
  );
}
function ReceiptView({ receipt: r }: { receipt: ScanReceipt }) {
  return (
    <div className="sts-receipt">
      <h4>Trwały dowód {r.kind === 'start' ? 'rozpoczęcia od 0' : 'skanu jednej sztuki'}</h4>
      <p>
        {r.code} · {r.location}
        {r.lot ? ' · partia ' + r.lot.lot_code : ''} · {date(r.created_at)}
      </p>
      <p>
        Własny zapisany pomiar:{' '}
        <strong>
          {r.previous_count === null ? 'Niepoliczona' : r.previous_count} → {r.counted} szt.
        </strong>{' '}
        · wersja pozycji {r.before_line_version} → {r.after_line_version}.
      </p>
      <p className="sts-help">
        Ten dowód pokazuje wynik konkretnej próby. Późniejsze pomiary mogą zmienić bieżący licznik.
      </p>
      <details>
        <summary>Identyfikatory dowodu</summary>
        <dl>
          <dt>Skan</dt>
          <dd>{r.id}</dd>
          <dt>Pozycja</dt>
          <dd>{r.line_id}</dd>
          <dt>Generacja</dt>
          <dd>{r.generation_id}</dd>
          <dt>Pomiar</dt>
          <dd>{r.measurement_id}</dd>
          <dt>Wersja spisu</dt>
          <dd>{r.stocktake_version}</dd>
        </dl>
      </details>
    </div>
  );
}
