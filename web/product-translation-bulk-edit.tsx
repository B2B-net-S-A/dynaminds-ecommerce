import type {JsonValue} from '../shared/pim-json';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './product-translation-bulk-edit.css';

type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string | null;
  can_read: boolean;
  can_write: boolean;
};
type Metadata = Flags & {
  locales: string[];
  meta: { cursor: string | null };
  limits: {
    max_products: number;
    max_locales: number;
    max_rows: number;
    selection_products: number;
    page: number;
    request_bytes: number;
    name_chars: number;
    description_chars: number;
  };
};
type Provenance = { kind: 'ai' | 'deepl' | 'manual'; id: string } | null;
type Snapshot = {
  present: boolean;
  version: number | null;
  name: string | null;
  description: string | null;
  provenance: Provenance;
};
type SelectionRow = {
  product_id: string;
  sku: string;
  kind: string;
  product_name: string;
  product_version: number;
  locale: string;
  translation_version: number | null;
  present: boolean;
  name: string | null;
  description: string | null;
  provenance: Provenance;
  source: {
    name: string;
    description: string;
    category: string;
    attributes: Record<string, JsonValue>;
  };
};
type Operation = 'none' | 'set' | 'remove';
type Input = {
  product_id: string;
  product_version: number;
  locale: string;
  translation_version: number | null;
} & (
  | { operation: 'none' | 'remove' }
  | { operation: 'set'; patch: { name?: string; description?: string } }
);
type Draft = {
  operation: Operation;
  name: string;
  description: string;
  useName: boolean;
  useDescription: boolean;
};
type Head = {
  id: string;
  scope_hash: string;
  locales: string[];
  created_at: string;
  rules_snapshot: unknown;
  total: number;
  product_count: number;
  changed_pairs: number;
  unchanged_pairs: number;
  changed_products: number;
  invalid?: number;
  conflicts?: number;
  missing_after_count: number;
  ready?: boolean;
  preview_id?: string;
  state?: string;
};
type FrozenRow = {
  index: number;
  receipt_id: string;
  product_id: string;
  sku: string;
  kind: string;
  product_name: string;
  product_version: number;
  locale: string;
  input: Input;
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict';
  before: Snapshot;
  after: Snapshot | null;
  source: SelectionRow['source'];
  errors: string[];
  id?: string;
  before_product_version?: number;
  after_product_version?: number;
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null; total?: number } };
type PreviewBody = { client_key: string; locales: string[]; rows: Input[] };
type ExecuteBody = {
  client_key: string;
  scope_hash: string;
  confirmed: true;
  ack_missing_translations: boolean;
};
const prefix = '/product-translation-bulk-edit';
const labels: Record<Operation, string> = {
  none: 'Bez zmiany',
  set: 'Ustaw pola',
  remove: 'Usuń wersję językową',
};
const localeNames: Record<string, string> = {
  pl: 'Polski',
  en: 'Angielski',
  de: 'Niemiecki',
  fr: 'Francuski',
  es: 'Hiszpański',
  cs: 'Czeski',
};
const pairKey = (r: { product_id: string; locale: string }) => r.product_id + ':' + r.locale;
const sourceLabel = (p: Provenance) =>
  p ? { ai: 'AI', deepl: 'DeepL', manual: 'Ręcznie' }[p.kind] : 'Brak';
const chars = (s: string) => Array.from(s).length;
function textError(s: string, name: boolean, max: number) {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s))
    return 'Niepoprawny znak Unicode.';
  if (/[<>\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s))
    return 'Tekst nie może zawierać HTML ani niedozwolonych znaków sterujących.';
  if (name && (chars(s) < 2 || !s.trim() || /[\r\n]/.test(s)))
    return 'Nazwa wymaga co najmniej 2 znaków, bez nowej linii i samych spacji.';
  if (chars(s) > max) return 'Tekst przekracza limit ' + max + ' znaków Unicode.';
  return '';
}
function normalizedLocale(raw: string) {
  const value = raw.trim().toLowerCase();
  if (value.length > 40 || !/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/.test(value))
    throw new Error(
      'Kod języka wymaga formatu np. de lub en-us; bez podkreślników i wewnętrznych spacji.',
    );
  return value;
}
function Summary({ head, receipt = false }: { head: Head; receipt?: boolean }) {
  return (
    <div className="ptbe-box">
      <strong>
        {receipt ? 'Zapis lokalny' : 'Podgląd lokalny'} · {head.product_count} produktów ·{' '}
        {head.total} par · {head.locales.join(', ')}
      </strong>
      <p>
        {head.changed_pairs} zmienionych par · {head.unchanged_pairs} bez zmiany ·{' '}
        {head.changed_products} zmienionych produktów
        {!receipt && (
          <>
            {' '}
            · {head.invalid} błędów · {head.conflicts} konfliktów
          </>
        )}
        . Brak wersji po operacji: {head.missing_after_count}.
      </p>
      <p>
        Zmiany dotyczą nazw i opisów w lokalnym katalogu. Nie publikują tłumaczeń do sklepu.
        Usunięcie wersji lokalnej nie usuwa tekstu Shopify.
      </p>
      <details>
        <summary>Reguły produktów i dane techniczne</summary>
        <p>
          Istniejące zatwierdzone reguły otrzymują jedno zdarzenie na zmieniony produkt; poniżej
          zamrożony zakres reguł.
        </p>
        <pre className="ptbe-text">{JSON.stringify(head.rules_snapshot, null, 2)}</pre>
        <p>
          {head.id} · {head.scope_hash}
        </p>
      </details>
    </div>
  );
}
function SnapshotView({ value }: { value: Snapshot | null }) {
  if (!value) return <p>Nie wyliczono wyniku.</p>;
  if (!value.present)
    return (
      <p>
        <strong>Brak wersji językowej</strong>
      </p>
    );
  return (
    <>
      <strong>{value.name}</strong>
      <small>
        Wersja {value.version} · {sourceLabel(value.provenance)}
      </small>
      <details>
        <summary>Pełny opis · {chars(value.description ?? '')} znaków</summary>
        <p className="ptbe-text">{value.description === '' ? 'Pusty opis' : value.description}</p>
      </details>
    </>
  );
}
function FrozenTable({ rows, receipt }: { rows: FrozenRow[]; receipt: boolean }) {
  return (
    <div className="ptbe-scroll">
      <table>
        <thead>
          <tr>
            <th>Produkt / język / operacja</th>
            <th>Przed</th>
            <th>Po</th>
            <th>Wynik / wersje</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index}>
              <td>
                <strong>{r.sku}</strong>
                <small>{r.product_name}</small>
                <small>
                  {r.locale} · {labels[r.input.operation]}
                </small>
              </td>
              <td>
                <SnapshotView value={r.before} />
              </td>
              <td>
                <SnapshotView value={r.after} />
              </td>
              <td>
                {r.status === 'changed'
                  ? receipt
                    ? 'Zapisano zmianę'
                    : 'Do zmiany'
                  : r.status === 'unchanged'
                    ? 'Bez zmiany'
                    : r.status === 'conflict'
                      ? 'Konflikt wersji'
                      : 'Błąd'}
                <small>
                  Produkt: {r.before_product_version ?? r.product_version}
                  {r.after_product_version !== undefined && <> → {r.after_product_version}</>}
                </small>
                {r.errors?.map((e, i) => (
                  <p role="alert" className="ptbe-error" key={i}>
                    {e}
                  </p>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProductTranslationBulkEdit({
  selection,
  readOnly,
  onChanged,
  onClose,
  onPendingChange,
  initialTab = 'editor',
}: {
  selection: ReadonlyArray<{ id: string; version: number; sku: string }>;
  readOnly: boolean;
  onChanged: () => void;
  onClose: () => void;
  onPendingChange?: (pending: boolean) => void;
  initialTab?: 'editor' | 'history';
}) {
  const [metadata, setMetadata] = useState<Metadata | null>(null),
    [tab, setTab] = useState(initialTab);
  const [locales, setLocales] = useState<string[]>([]),
    [custom, setCustom] = useState('');
  const [rows, setRows] = useState<SelectionRow[]>([]),
    [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loaded, setLoaded] = useState(false),
    [progress, setProgress] = useState(0),
    [page, setPage] = useState(0),
    [filter, setFilter] = useState('');
  const [applyLocale, setApplyLocale] = useState(''),
    [applyField, setApplyField] = useState<'name' | 'description'>('name'),
    [applyOperation, setApplyOperation] = useState<'set' | 'clear' | 'remove' | 'none'>('set'),
    [applyValue, setApplyValue] = useState('');
  const [preview, setPreview] = useState<Head | null>(null),
    [execution, setExecution] = useState<Head | null>(null);
  const [frozenRows, setFrozenRows] = useState<FrozenRow[]>([]),
    [rowCursor, setRowCursor] = useState<string | null>(null),
    [frozenPage, setFrozenPage] = useState(0),
    [frozenOffsets, setFrozenOffsets] = useState<number[]>([0]);
  const [history, setHistory] = useState<Head[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [historyLoaded, setHistoryLoaded] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState<PreviewBody | null>(null),
    [executeAttempt, setExecuteAttempt] = useState<ExecuteBody | null>(null);
  const [consent, setConsent] = useState(''),
    [missingConsent, setMissingConsent] = useState('');
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const epoch = useRef(0),
    alive = useRef(false),
    ticket = useRef(0),
    inFlight = useRef<number | null>(null);
  const selectionKey = JSON.stringify(selection.map((p) => [p.id, p.version, p.sku]));
  const pending = busy || !!previewAttempt || !!executeAttempt;
  const writable =
    !readOnly && !blocked && !!metadata?.available && metadata.can_write && !metadata.read_only;
  const fence = preview ? preview.id + ':' + preview.scope_hash : '';
  const validScope =
    selection.length > 0 &&
    selection.length <= 500 &&
    new Set(selection.map((p) => p.id)).size === selection.length;
  const current = (context: number) => alive.current && epoch.current === context;
  function clearPlan() {
    setPreview(null);
    setExecution(null);
    setFrozenRows([]);
    setRowCursor(null);
    setFrozenPage(0);
    setFrozenOffsets([0]);
    setConsent('');
    setMissingConsent('');
  }
  function purge() {
    ++epoch.current;
    inFlight.current = null;
    setBusy(false);
    setBlocked(true);
    setMetadata(null);
    setRows([]);
    setDrafts({});
    setLoaded(false);
    setHistory([]);
    setHistoryLoaded(false);
    setHistoryCursor(null);
    setLocales([]);
    setCustom('');
    setApplyValue('');
    setPreviewAttempt(null);
    setExecuteAttempt(null);
    clearPlan();
    onPendingChange?.(false);
  }
  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : 'Nie udało się wykonać operacji.');
    if (e instanceof ApiError && [401, 403].includes(e.status)) purge();
    else if (e instanceof ApiError && [423, 503].includes(e.status)) {
      setBlocked(true);
      setConsent('');
      setMissingConsent('');
      setPreviewAttempt(null);
      setExecuteAttempt(null);
      setNotice(
        e.status === 423
          ? 'Zapis zablokowany. Szkic zachowano; historia pozostaje dostępna tylko do odczytu.'
          : 'Moduł niedostępny. Dalsze zapisy zablokowano.',
      );
    }
  }
  function flags(d: Flags) {
    if (!d.can_read && d.available) {
      setError('Utracono uprawnienia do odczytu wersji językowych.');
      purge();
      return false;
    }
    setMetadata((m) =>
      m
        ? {
            ...m,
            available: d.available,
            read_only: d.read_only,
            current_role: d.current_role,
            can_read: d.can_read,
            can_write: d.can_write,
          }
        : m,
    );
    if (!d.available) {
      setRows([]);
      setDrafts({});
      setLoaded(false);
      clearPlan();
      setHistory([]);
      setPreviewAttempt(null);
      setExecuteAttempt(null);
      return false;
    }
    return true;
  }
  async function run(fn: (context: number) => Promise<void>) {
    if (inFlight.current !== null) return;
    const context = epoch.current,
      id = ++ticket.current;
    inFlight.current = id;
    setBusy(true);
    setError('');
    onPendingChange?.(true);
    try {
      await fn(context);
    } catch (e) {
      if (current(context)) fail(e);
    } finally {
      if (current(context) && inFlight.current === id) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  }
  async function get<T>(path: string) {
    return api<T>(path, 'GET', undefined, { 'Cache-Control': 'no-store' });
  }
  async function historyPage(context: number, cursor?: string | null) {
    const d = await get<Page<Head>>(
      prefix + '/executions' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    if (!current(context) || !flags(d)) return;
    setHistory((old) =>
      cursor ? [...old, ...d.data.filter((h) => !old.some((p) => p.id === h.id))] : d.data,
    );
    setHistoryCursor(d.meta.cursor);
    setHistoryLoaded(true);
  }
  useEffect(() => {
    alive.current = true;
    ++epoch.current;
    inFlight.current = null;
    setBusy(false);
    setBlocked(false);
    setMetadata(null);
    setLocales([]);
    setRows([]);
    setDrafts({});
    setLoaded(false);
    setPreviewAttempt(null);
    setExecuteAttempt(null);
    clearPlan();
    setHistory([]);
    setHistoryLoaded(false);
    setError('');
    setNotice('');
    void run(async (context) => {
      const d = await get<Metadata>(prefix);
      if (!current(context)) return;
      setMetadata(d);
      if (d.available && !d.can_read) {
        setError('Brak uprawnień do odczytu wersji językowych.');
        purge();
        return;
      }
      if (d.available && initialTab === 'history') await historyPage(context);
    });
    return () => {
      alive.current = false;
      ++epoch.current;
      inFlight.current = null;
      onPendingChange?.(false);
    };
  }, [selectionKey, readOnly, initialTab]);
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  function changeLocales(next: string[]) {
    if (pending || inFlight.current !== null) return;
    setLocales(next);
    setRows([]);
    setDrafts({});
    setLoaded(false);
    setPage(0);
    setFilter('');
    clearPlan();
    setError('');
  }
  async function moreLocales() {
    if (!metadata?.meta.cursor || pending) return;
    await run(async (context) => {
      const d = await get<Metadata>(
        prefix + '?cursor=' + encodeURIComponent(metadata.meta.cursor!),
      );
      if (!current(context) || !flags(d)) return;
      setMetadata((m) => (m ? { ...d, locales: [...new Set([...m.locales, ...d.locales])] } : d));
    });
  }
  async function loadSelection() {
    if (!metadata || !validScope || !locales.length || pending || inFlight.current !== null) return;
    clearPlan();
    setLoaded(false);
    setRows([]);
    setDrafts({});
    setProgress(0);
    setNotice('');
    await run(async (context) => {
      const all: SelectionRow[] = [],
        seen = new Set<string>(),
        versions = new Map<string, number>();
      for (let start = 0; start < selection.length; start += 50) {
        const chunk = selection.slice(start, start + 50),
          expected = chunk.length * locales.length;
        let cursor: string | null = null,
          count = 0;
        const cursors = new Set<string>();
        do {
          const d: Page<SelectionRow> = await get<Page<SelectionRow>>(
            prefix +
              '/selection?ids=' +
              encodeURIComponent(chunk.map((p) => p.id).join(',')) +
              '&locales=' +
              encodeURIComponent(locales.join(',')) +
              (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
          );
          if (!current(context) || !flags(d)) return;
          if (d.meta.total !== expected)
            throw new Error('API nie potwierdziło pełnej macierzy wybranych produktów i języków.');
          for (const r of d.data) {
            if (
              !chunk.some((p) => p.id === r.product_id) ||
              !locales.includes(r.locale) ||
              seen.has(pairKey(r))
            )
              throw new Error('Nieprawidłowy lub powtórzony wiersz zakresu; całość odrzucono.');
            const v = versions.get(r.product_id);
            if (v !== undefined && v !== r.product_version)
              throw new Error('Produkt zmienił się podczas odczytu. Wczytaj cały zakres ponownie.');
            versions.set(r.product_id, r.product_version);
            seen.add(pairKey(r));
            all.push(r);
            count++;
          }
          cursor = d.meta.cursor;
          if (cursor && (cursors.has(cursor) || !d.data.length))
            throw new Error('Odczyt stron nie postępuje; zakres nie został obcięty.');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        if (count !== expected) throw new Error('Niekompletny zakres językowy; całość odrzucono.');
        if (current(context)) setProgress(all.length);
      }
      if (!current(context)) return;
      const ordered = selection.flatMap((p) =>
        locales.map((locale) => all.find((r) => r.product_id === p.id && r.locale === locale)!),
      );
      if (ordered.length > metadata.limits.max_rows || ordered.some((r) => !r))
        throw new Error('Zakres przekracza limit lub brakuje pary.');
      const next: Record<string, Draft> = {};
      for (const r of ordered)
        next[pairKey(r)] = {
          operation: 'none',
          name: r.name ?? '',
          description: r.description ?? '',
          useName: false,
          useDescription: false,
        };
      setRows(ordered);
      setDrafts(next);
      setLoaded(true);
      setPage(0);
      if (
        ordered.some(
          (r) => selection.find((p) => p.id === r.product_id)!.version !== r.product_version,
        )
      )
        setNotice(
          'Niektóre produkty mają nowszą wersję. Oczekiwania pierwotnego wyboru zachowano; podgląd pokaże konflikt.',
        );
    });
  }
  function editRow(r: SelectionRow, patch: Partial<Draft>) {
    if (!writable || pending || inFlight.current !== null || execution) return;
    setDrafts((old) => ({ ...old, [pairKey(r)]: { ...old[pairKey(r)], ...patch } }));
    clearPlan();
    setNotice('');
  }
  function applyAll() {
    if (!loaded || !writable || pending || inFlight.current !== null || execution || !applyLocale)
      return;
    const targets = rows.filter((r) => r.locale === applyLocale);
    if (!targets.length) {
      setError('Wybierz język z aktualnego zakresu.');
      return;
    }
    if (applyOperation === 'clear' && applyField === 'name') {
      setError('Nazwy nie można wyczyścić.');
      return;
    }
    if (applyOperation === 'set') {
      const e = textError(
        applyValue,
        applyField === 'name',
        applyField === 'name' ? metadata!.limits.name_chars : metadata!.limits.description_chars,
      );
      if (e) {
        setError(e);
        return;
      }
    }
    setDrafts((old) => {
      const next = { ...old };
      for (const r of targets) {
        const d = { ...next[pairKey(r)] };
        if (applyOperation === 'none' || applyOperation === 'remove') d.operation = applyOperation;
        else {
          d.operation = 'set';
          if (applyField === 'name') {
            d.name = applyValue;
            d.useName = true;
          } else {
            d.description = applyOperation === 'clear' ? '' : applyValue;
            d.useDescription = true;
          }
        }
        next[pairKey(r)] = d;
      }
      return next;
    });
    clearPlan();
    setError('');
    setNotice('Zmieniono szkic dla ' + targets.length + ' par. Nie zapisano danych.');
  }
  function buildBody(): PreviewBody {
    const input: Input[] = rows.map((r) => {
      const d = drafts[pairKey(r)],
        p = selection.find((p) => p.id === r.product_id)!;
      const base = {
        product_id: r.product_id,
        product_version: p.version,
        locale: r.locale,
        translation_version: r.translation_version,
      };
      if (d.operation !== 'set') return { ...base, operation: d.operation };
      const patch: { name?: string; description?: string } = {};
      if (d.useName) {
        const e = textError(d.name, true, metadata!.limits.name_chars);
        if (e) throw new Error(r.sku + ' · ' + r.locale + ' · ' + e);
        patch.name = d.name;
      }
      if (d.useDescription) {
        const e = textError(d.description, false, metadata!.limits.description_chars);
        if (e) throw new Error(r.sku + ' · ' + r.locale + ' · ' + e);
        patch.description = d.description;
      }
      if (!d.useName && !d.useDescription)
        throw new Error(
          r.sku + ' · ' + r.locale + ' · Wybierz co najmniej jedno pole do ustawienia.',
        );
      if (!r.present && !d.useName)
        throw new Error(r.sku + ' · ' + r.locale + ' · Nowa wersja wymaga jawnej nazwy.');
      return { ...base, operation: 'set', patch };
    });
    const body: PreviewBody = {
      client_key: crypto.randomUUID(),
      locales: [...locales],
      rows: input,
    };
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > metadata!.limits.request_bytes)
      throw new Error(
        'Całe żądanie przekracza limit 2 MiB. Zmniejsz jawny zakres lub teksty; niczego nie obcięto.',
      );
    return body;
  }
  async function firstFrozen(context: number, head: Head, receipt: boolean) {
    const d = await get<Page<FrozenRow>>(
      prefix + (receipt ? '/executions/' : '/previews/') + head.id + '/rows',
    );
    if (!current(context) || !flags(d)) return;
    setFrozenRows(d.data);
    setRowCursor(d.meta.cursor);
    setFrozenPage(0);
    setFrozenOffsets([0]);
  }
  async function createPreview() {
    if (!writable || !loaded || execution || executeAttempt || busy || inFlight.current !== null)
      return;
    let body: PreviewBody;
    try {
      body = previewAttempt ?? buildBody();
    } catch (e) {
      fail(e);
      return;
    }
    setPreviewAttempt(body);
    setConsent('');
    setMissingConsent('');
    await run(async (context) => {
      let d: Flags & { preview: Head; reused: boolean };
      try {
        d = await api(prefix + '/previews', 'POST', body);
      } catch (e) {
        if (current(context) && e instanceof ApiError && [409, 413, 422].includes(e.status)) {
          setPreviewAttempt(null);
          clearPlan();
        }
        throw e;
      }
      if (!current(context) || !flags(d)) return;
      setPreviewAttempt(null);
      setPreview(d.preview);
      setExecution(null);
      setFrozenRows([]);
      setRowCursor(null);
      await firstFrozen(context, d.preview, false);
    });
  }
  async function execute() {
    if (
      !writable ||
      !preview ||
      busy ||
      inFlight.current !== null ||
      execution ||
      (!executeAttempt &&
        (!preview.ready ||
          consent !== fence ||
          (preview.missing_after_count > 0 && missingConsent !== fence)))
    )
      return;
    const head = preview,
      body = executeAttempt ?? {
        client_key: crypto.randomUUID(),
        scope_hash: head.scope_hash,
        confirmed: true as const,
        ack_missing_translations: missingConsent === fence,
      };
    setExecuteAttempt(body);
    await run(async (context) => {
      let d: Flags & { execution: Head; reused: boolean };
      try {
        d = await api(prefix + '/previews/' + head.id + '/execute', 'POST', body);
      } catch (e) {
        if (current(context) && e instanceof ApiError && [409, 413, 422].includes(e.status)) {
          setExecuteAttempt(null);
          setConsent('');
          setMissingConsent('');
          setPreview(null);
          setFrozenRows([]);
          setRowCursor(null);
        }
        throw e;
      }
      if (!current(context) || !flags(d)) return;
      setExecuteAttempt(null);
      setPreview(null);
      setExecution(d.execution);
      setConsent('');
      setMissingConsent('');
      setFrozenRows([]);
      setRowCursor(null);
      onChanged();
      setNotice(
        d.reused
          ? 'Odczytano wynik tej samej próby. Nie wykonano drugiego zapisu.'
          : 'Zapis zakończony w lokalnym katalogu.',
      );
      await firstFrozen(context, d.execution, true);
    });
  }
  async function openHistory(id: string) {
    if (pending || inFlight.current !== null) return;
    clearPlan();
    await run(async (context) => {
      const d = await get<Flags & { execution: Head }>(prefix + '/executions/' + id);
      if (!current(context) || !flags(d)) return;
      setExecution(d.execution);
      await firstFrozen(context, d.execution, true);
    });
  }
  async function frozenNext() {
    const head = execution ?? preview;
    if (!head || pending || inFlight.current !== null) return;
    if (frozenPage + 1 < frozenOffsets.length) {
      setFrozenPage((p) => p + 1);
      return;
    }
    if (!rowCursor) return;
    await run(async (context) => {
      const d = await get<Page<FrozenRow>>(
        prefix +
          (execution ? '/executions/' : '/previews/') +
          head.id +
          '/rows?cursor=' +
          encodeURIComponent(rowCursor),
      );
      if (!current(context) || !flags(d)) return;
      if (!d.data.length && d.meta.cursor) throw new Error('Odczyt dowodów nie postępuje.');
      if (d.meta.cursor === rowCursor) throw new Error('Kursor dowodów nie postępuje.');
      if (d.data.some((r) => frozenRows.some((p) => p.index === r.index)))
        throw new Error('Powtórzony wiersz dowodu; odczyt odrzucono.');
      if (d.data.length) {
        setFrozenOffsets((old) => [...old, frozenRows.length]);
        setFrozenRows((old) => [...old, ...d.data]);
        setFrozenPage((p) => p + 1);
      }
      setRowCursor(d.meta.cursor);
    });
  }
  async function switchTab(next: 'editor' | 'history') {
    if (pending || inFlight.current !== null) return;
    clearPlan();
    setTab(next);
    setError('');
    if (next === 'history' && metadata?.available) await run((c) => historyPage(c));
  }
  const visible = rows.filter((r) => !filter || r.locale === filter),
    display = visible.slice(page * 50, (page + 1) * 50);
  const head = execution ?? preview;
  return (
    <section className="panel translation-bulk-edit" aria-label="Arkusz wersji językowych">
      <div className="panel-heading">
        <h2>{tab === 'editor' ? 'Wersje językowe produktów' : 'Historia wersji językowych'}</h2>
        <button className="button" disabled={pending} onClick={onClose}>
          Zamknij
        </button>
      </div>
      <div className="ptbe-body">
        <div className="ptbe-toolbar">
          <button className="button" disabled={pending} onClick={() => void switchTab('editor')}>
            Arkusz
          </button>
          <button className="button" disabled={pending} onClick={() => void switchTab('history')}>
            Historia
          </button>
        </div>
        {error && (
          <p role="alert" className="ptbe-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {busy && (
          <p role="status">
            Wczytywanie / sprawdzanie całego zakresu… {progress > 0 && <>{progress} par</>}
          </p>
        )}
        {!metadata && !error && <p>Wczytywanie dostępności modułu…</p>}
        {metadata && !metadata.available && (
          <p>Arkusz wersji językowych nie jest dostępny w tej kopii aplikacji.</p>
        )}
        {(readOnly || metadata?.read_only) && <p>Kopia tylko do odczytu — zapisy zablokowane.</p>}
        {metadata?.available && !metadata.can_write && (
          <p>Aktualne uprawnienia pozwalają wyłącznie odczytać zapisane podglądy i historię.</p>
        )}
        {(previewAttempt || executeAttempt) && !busy && (
          <p role="alert">
            Wynik próby może być niepewny. Zachowano dokładne żądanie i klucz. Ponów tę samą próbę;
            edycja zakresu jest zablokowana do rozstrzygnięcia.
          </p>
        )}
        {metadata?.available && metadata.can_read && tab === 'editor' && (
          <>
            <p>
              {selection.length} jawnie wybranych produktów × {locales.length} języków ={' '}
              {selection.length * locales.length} par. Maksymalnie500 produktów,6 języków,3000 par;
              całe żądanie2 MiB. Zapis lokalny, bez AI, DeepL i publikacji do sklepu.
            </p>
            <p>
              Pełne zamrożone dane przed/po mogą przekroczyć limit8 MiB podglądu, także przy krótkim
              nowym tekście. Błąd413 oznacza odrzucenie całej próby bez zapisu tłumaczeń; zmniejsz
              zakres świadomie. Żadne opisy ani strony nie są obcinane.
            </p>
            {!validScope && (
              <p role="alert">
                Wybierz w katalogu od1 do500 różnych produktów. Wyboru nie obcinamy.
              </p>
            )}
            <div className="ptbe-box">
              <strong>Języki lokalnego katalogu</strong>
              <div className="ptbe-locales">
                {metadata.locales.map((locale) => (
                  <label className="ptbe-check" key={locale}>
                    <input
                      type="checkbox"
                      checked={locales.includes(locale)}
                      disabled={pending || (!locales.includes(locale) && locales.length >= 6)}
                      onChange={(e) =>
                        changeLocales(
                          e.target.checked
                            ? [...locales, locale]
                            : locales.filter((l) => l !== locale),
                        )
                      }
                    />
                    {localeNames[locale] ?? 'Wersja językowa'} · {locale}
                  </label>
                ))}
              </div>
              {metadata.meta.cursor && (
                <button className="button" disabled={pending} onClick={() => void moreLocales()}>
                  Więcej istniejących języków
                </button>
              )}
              <label>
                Nowy kod języka
                <input
                  value={custom}
                  disabled={pending}
                  placeholder="np. en-us"
                  onChange={(e) => setCustom(e.target.value)}
                />
              </label>
              <button
                className="button"
                disabled={pending || locales.length >= 6}
                onClick={() => {
                  if (pending || inFlight.current !== null) return;
                  try {
                    const locale = normalizedLocale(custom);
                    if (locales.includes(locale)) throw new Error('Ten język jest już wybrany.');
                    setMetadata((m) =>
                      m ? { ...m, locales: [...new Set([...m.locales, locale])] } : m,
                    );
                    changeLocales([...locales, locale]);
                    setCustom('');
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                Dodaj język do zakresu
              </button>
              <p>
                Wybrane: {locales.join(', ') || 'brak'}. Języki lokalne są odrębne od języków kanału
                Shopify; regionalne kody nie są automatycznie mapowane.
              </p>
              <button
                className="button"
                disabled={!validScope || !locales.length || pending}
                onClick={() => void loadSelection()}
              >
                Wczytaj pełny zakres
              </button>
            </div>
            {loaded && (
              <>
                <div className="ptbe-apply ptbe-box">
                  <strong className="ptbe-wide">
                    Ustaw dla wszystkich wybranych produktów w jednym języku — tylko szkic
                  </strong>
                  <label>
                    Język zakresu
                    <select
                      value={applyLocale}
                      disabled={pending || !writable || !!execution}
                      onChange={(e) => setApplyLocale(e.target.value)}
                    >
                      <option value="">Wybierz jawnie</option>
                      {locales.map((l) => (
                        <option key={l}>{l}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Pole
                    <select
                      value={applyField}
                      disabled={pending || !writable || !!execution}
                      onChange={(e) => setApplyField(e.target.value as 'name' | 'description')}
                    >
                      <option value="name">Nazwa</option>
                      <option value="description">Opis</option>
                    </select>
                  </label>
                  <label>
                    Operacja
                    <select
                      value={applyOperation}
                      disabled={pending || !writable || !!execution}
                      onChange={(e) => setApplyOperation(e.target.value as typeof applyOperation)}
                    >
                      <option value="set">Ustaw pole</option>
                      <option value="clear">Wyczyść opis</option>
                      <option value="remove">Usuń całe wersje językowe</option>
                      <option value="none">Bez zmiany całych wersji</option>
                    </select>
                  </label>
                  {applyOperation === 'set' && (
                    <label className="ptbe-wide">
                      Nowy tekst
                      <textarea
                        value={applyValue}
                        disabled={pending || !writable || !!execution}
                        onChange={(e) => setApplyValue(e.target.value)}
                      />
                      <small>
                        {chars(applyValue)} znaków Unicode. Wspólna nazwa zastąpi nazwy wszystkich
                        wybranych produktów w tym języku.
                      </small>
                    </label>
                  )}
                  <button
                    className="button"
                    disabled={!writable || pending || !applyLocale || !!execution}
                    onClick={applyAll}
                  >
                    Zastosuj do {selection.length} par
                  </button>
                </div>
                <label>
                  Widoczny język
                  <select
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="">Wszystkie wybrane</option>
                    {locales.map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                </label>
                <div className="ptbe-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Produkt / wersje</th>
                        <th>Język / operacja</th>
                        <th>Edytowana nazwa</th>
                        <th>Edytowany opis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {display.map((r) => {
                        const d = drafts[pairKey(r)],
                          expected = selection.find((p) => p.id === r.product_id)!.version;
                        return (
                          <tr key={pairKey(r)}>
                            <td>
                              <strong>{r.sku}</strong>
                              <small>Bazowa nazwa: {r.product_name}</small>
                              <small>
                                Produkt: oczekiwano {expected}, odczytano {r.product_version}
                              </small>
                              <small>
                                Tłumaczenie:{' '}
                                {r.present ? 'wersja ' + r.translation_version : 'brak'} ·{' '}
                                {sourceLabel(r.provenance)}
                              </small>
                            </td>
                            <td>
                              <strong>{r.locale}</strong>
                              <label>
                                Operacja dla {r.sku} · {r.locale}
                                <select
                                  value={d.operation}
                                  disabled={pending || !writable || !!execution}
                                  onChange={(e) =>
                                    editRow(r, { operation: e.target.value as Operation })
                                  }
                                >
                                  {Object.entries(labels).map(([v, l]) => (
                                    <option value={v} key={v}>
                                      {l}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {d.operation === 'remove' && (
                                <p>Usunięcie całej lokalnej wersji, bez zmiany tekstów sklepu.</p>
                              )}
                            </td>
                            <td>
                              <label className="ptbe-check">
                                <input
                                  type="checkbox"
                                  checked={d.useName}
                                  disabled={
                                    pending || !writable || d.operation !== 'set' || !!execution
                                  }
                                  onChange={(e) => editRow(r, { useName: e.target.checked })}
                                />
                                Ustaw nazwę
                              </label>
                              <label>
                                Nazwa · {r.sku} · {r.locale}
                                <input
                                  value={d.name}
                                  disabled={
                                    pending ||
                                    !writable ||
                                    d.operation !== 'set' ||
                                    !d.useName ||
                                    !!execution
                                  }
                                  onChange={(e) => editRow(r, { name: e.target.value })}
                                />
                              </label>
                              <small>
                                {chars(d.name)} / {metadata.limits.name_chars} znaków Unicode;
                                pominięte pole zachowane.
                              </small>
                            </td>
                            <td>
                              <label className="ptbe-check">
                                <input
                                  type="checkbox"
                                  checked={d.useDescription}
                                  disabled={
                                    pending || !writable || d.operation !== 'set' || !!execution
                                  }
                                  onChange={(e) => editRow(r, { useDescription: e.target.checked })}
                                />
                                Ustaw opis
                              </label>
                              <details>
                                <summary>Opis · {chars(d.description)} znaków Unicode</summary>
                                <label>
                                  Opis · {r.sku} · {r.locale}
                                  <textarea
                                    value={d.description}
                                    disabled={
                                      pending ||
                                      !writable ||
                                      d.operation !== 'set' ||
                                      !d.useDescription ||
                                      !!execution
                                    }
                                    onChange={(e) => editRow(r, { description: e.target.value })}
                                  />
                                </label>
                                <small>
                                  {chars(d.description)} / {metadata.limits.description_chars};
                                  tekst nie jest przycinany.
                                </small>
                              </details>
                              <button
                                className="button"
                                disabled={pending || !writable || !!execution}
                                onClick={() =>
                                  editRow(r, {
                                    operation: 'set',
                                    useDescription: true,
                                    description: '',
                                  })
                                }
                              >
                                Wyczyść opis
                              </button>
                              <small>
                                {r.present
                                  ? 'Pominięte pole zachowane.'
                                  : 'Nowa wersja wymaga nazwy; pominięty opis będzie pusty.'}
                              </small>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="ptbe-toolbar">
                  <button className="button" disabled={!page} onClick={() => setPage((p) => p - 1)}>
                    Poprzednia
                  </button>
                  <span>
                    Strona {page + 1} · {visible.length} widocznych / {rows.length} par w zakresie
                  </span>
                  <button
                    className="button"
                    disabled={(page + 1) * 50 >= visible.length}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Następna
                  </button>
                </div>
                <button
                  className="button"
                  disabled={!writable || busy || !!executeAttempt || !!execution}
                  onClick={() => void createPreview()}
                >
                  {previewAttempt
                    ? 'Ponów tę samą próbę podglądu'
                    : 'Przygotuj podgląd całego zakresu'}
                </button>
              </>
            )}
          </>
        )}
        {metadata?.available && metadata.can_read && tab === 'history' && (
          <>
            <button
              className="button"
              disabled={pending}
              onClick={() => void run((c) => historyPage(c))}
            >
              Odśwież historię lokalną
            </button>
            {historyLoaded && !history.length && <p>Brak wykonanych edycji językowych.</p>}
            {history.map((h) => (
              <button
                className="button"
                disabled={pending}
                key={h.id}
                onClick={() => void openHistory(h.id)}
              >
                {date(h.created_at)} · {h.product_count} produktów · {h.total} par ·{' '}
                {h.locales.join(', ')} · zmieniono {h.changed_pairs}
              </button>
            ))}
            {historyCursor && (
              <button
                className="button"
                disabled={pending}
                onClick={() => void run((c) => historyPage(c, historyCursor))}
              >
                Starsze wykonania
              </button>
            )}
          </>
        )}
        {head && (
          <div className="ptbe-box">
            <Summary head={head} receipt={!!execution} />
            <p>
              Odczytano {frozenRows.length} / {head.total} zamrożonych wierszy. Zgoda obejmuje
              całość, także inne strony.
            </p>
            <FrozenTable
              rows={frozenRows.slice(
                frozenOffsets[frozenPage],
                frozenOffsets[frozenPage + 1] ?? frozenRows.length,
              )}
              receipt={!!execution}
            />
            <div className="ptbe-toolbar">
              <button
                className="button"
                disabled={pending || !frozenPage}
                onClick={() => setFrozenPage((p) => p - 1)}
              >
                Poprzednie wiersze
              </button>
              <span>Strona {frozenPage + 1}</span>
              <button
                className="button"
                disabled={pending || (frozenPage + 1 >= frozenOffsets.length && !rowCursor)}
                onClick={() => void frozenNext()}
              >
                Następne wiersze
              </button>
              <button
                className="button"
                disabled={pending}
                onClick={() => void run((c) => firstFrozen(c, head, !!execution))}
              >
                Odśwież lokalny odczyt
              </button>
            </div>
            {preview && (
              <>
                {!preview.ready && (
                  <p role="alert">
                    Błędy lub konflikty blokują całą partię. Zachowano szkic i oczekiwane wersje.
                  </p>
                )}
                <label className="ptbe-check">
                  <input
                    type="checkbox"
                    checked={consent === fence}
                    disabled={!writable || pending || !preview.ready}
                    onChange={(e) => setConsent(e.target.checked ? fence : '')}
                  />
                  Zatwierdzam lokalny zapis dla {preview.product_count} produktów, {preview.total}{' '}
                  par w językach {preview.locales.join(', ')}. Sprawdziłem nazwy, opisy i usunięcia
                  całych wersji. Zapis nie publikuje do sklepu.
                </label>
                {preview.missing_after_count > 0 && (
                  <label className="ptbe-check">
                    <input
                      type="checkbox"
                      checked={missingConsent === fence}
                      disabled={!writable || pending || !preview.ready}
                      onChange={(e) => setMissingConsent(e.target.checked ? fence : '')}
                    />
                    Potwierdzam brak {preview.missing_after_count} lokalnych wersji językowych po
                    operacji, także już brakujących par pozostawionych bez zmiany.
                  </label>
                )}
                <button
                  className="button primary"
                  disabled={
                    !writable ||
                    busy ||
                    (!executeAttempt &&
                      (!preview.ready ||
                        consent !== fence ||
                        (preview.missing_after_count > 0 && missingConsent !== fence)))
                  }
                  onClick={() => void execute()}
                >
                  {executeAttempt
                    ? 'Ponów tę samą próbę zapisu'
                    : 'Zapisz cały zatwierdzony zakres lokalnie'}
                </button>
              </>
            )}
            {execution && (
              <p>
                Wynik jest trwałym dowodem lokalnego zapisu. Publikację Shopify uruchom osobno z jej
                własnym podglądem i zgodą.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
