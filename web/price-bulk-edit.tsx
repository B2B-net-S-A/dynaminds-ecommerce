import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, date, money } from './api';
import './price-bulk-edit.css';

// Text is parsed before converting to Number: all supported currencies use two minor digits.
export function parsePriceAmount(raw: string): number {
  const text = raw.trim();
  if (!/^(0|[1-9]\d*)(?:[.,]\d{1,2})?$/.test(text))
    throw new Error(
      'Kwota wymaga nieujemnej liczby z najwyżej dwoma miejscami po kropce lub przecinku, bez wykładnika i separatorów tysięcy.',
    );
  const [whole, fraction = ''] = text.replace(',', '.').split('.');
  if (whole.length > 7) throw new Error('Kwota przekracza 1 000 000,00.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > 100000000n) throw new Error('Kwota przekracza 1 000 000,00.');
  return Number(minor);
}
function amountText(value: number) {
  return Math.trunc(value / 100) + '.' + String(value % 100).padStart(2, '0');
}
function grossFor(amount: number, basis: 'gross' | 'net', vat: number) {
  if (!Number.isInteger(vat) || ![0, 5, 8, 23].includes(vat))
    throw new Error('Brak poprawnej stawki VAT w odczycie produktu.');
  const result =
    basis === 'gross' ? BigInt(amount) : (BigInt(amount) * BigInt(100 + vat) + 50n) / 100n;
  if (result > 100000000n) throw new Error('Cena brutto po VAT przekracza 1 000 000,00.');
  return Number(result);
}

type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string | null;
  can_read: boolean;
  can_write: boolean;
};
type List = {
  id: string;
  name: string;
  currency: string;
  version: number;
  active: boolean;
  fallback: boolean;
  adjustment_bps: number;
  adjustment_amount: number;
};
type ListSnapshot = List & { catalog_currency: string };
type Repricing = {
  rule: null | { version: number; config_version: number; config: unknown };
  schedule: null | {
    version: number;
    enabled: boolean;
    actor_id: string;
    rule_config_version: number;
    interval_minutes: number;
    batch_size: number;
  };
  queued_run: null | {
    id: string;
    state: string;
    rule_version: number;
    schedule_version: number;
    expected_list_version: number;
    cursor: string | null;
    scanned: number;
    changed: number;
  };
};
type Metadata = Flags & {
  catalog_currency: string;
  price_lists: List[];
  meta: { cursor: string | null };
  limits: {
    products: number;
    selection_products: number;
    rows: number;
    page: number;
    body_bytes: number;
  };
};
type Source = 'override' | 'rule' | 'missing';
type PriceSnapshot = {
  currency: string;
  vat: number;
  catalog_price: number;
  override_present: boolean;
  override_price: number | null;
  effective_price: number | null;
  source: Source;
  issue: string | null;
};
type SelectionRow = {
  product_id: string;
  product_version: number;
  sku: string;
  name: string;
  kind: string;
  active: boolean;
  vat: number;
  catalog_price: number;
  override_present: boolean;
  override_price: number | null;
  effective_price: number | null;
  source: Source;
  issue: string | null;
  editable: boolean;
  errors: string[];
};
type Operation = 'none' | 'set' | 'remove';
type Basis = 'gross' | 'net';
type InputRow =
  | { product_id: string; product_version: number; operation: 'none' | 'remove' }
  | {
      product_id: string;
      product_version: number;
      operation: 'set';
      basis: Basis;
      amount_minor: number;
    };
type Draft = { operation: Operation; basis: Basis; amount: string };
type Preview = {
  id: string;
  price_list_id: string;
  list_snapshot: ListSnapshot;
  repricing_snapshot: Repricing;
  warnings: string[];
  total: number;
  changed: number;
  unchanged: number;
  invalid: number;
  conflicts: number;
  missing_after_count: number;
  ready: boolean;
  scope_hash: string;
  created_at: string;
};
type PreviewRow = {
  index: number;
  product_id: string;
  sku: string;
  name: string;
  kind: string;
  product_version: number;
  input: InputRow;
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict';
  before: PriceSnapshot;
  after: PriceSnapshot | null;
  errors: string[];
};
type Execution = {
  id: string;
  preview_id: string;
  price_list_id: string;
  list_snapshot: ListSnapshot;
  repricing_snapshot: Repricing;
  warnings: string[];
  state: 'done';
  total: number;
  changed: number;
  unchanged: number;
  missing_after_count: number;
  before_list_version: number;
  after_list_version: number;
  scope_hash: string;
  ack_missing_prices: boolean;
  created_at: string;
};
type ExecutionRow = {
  index: number;
  product_id: string;
  sku: string;
  name: string;
  input: InputRow;
  operation: Operation;
  status: 'changed' | 'unchanged';
  before: PriceSnapshot;
  after: PriceSnapshot;
  before_list_version: number;
  after_list_version: number;
};
type Page<T> = Flags & { data: T[]; meta: { cursor: string | null; total?: number } };
type SelectionPage = Page<SelectionRow> & {
  list: ListSnapshot;
  repricing_snapshot: Repricing;
  warnings: string[];
};
type PreviewRequest = {
  client_key: string;
  price_list_id: string;
  list_version: number;
  rows: InputRow[];
};
type ExecuteRequest = {
  client_key: string;
  scope_hash: string;
  confirmed: true;
  ack_missing_prices: boolean;
};
const prefix = '/price-bulk-edit',
  MAX_BYTES = 786432;
const operations: Record<Operation, string> = {
  none: 'Bez zmiany',
  set: 'Ustaw własną cenę',
  remove: 'Usuń własną cenę',
};
const sourceNames: Record<Source, string> = {
  override: 'Własna cena',
  rule: 'Reguła cennika',
  missing: 'Brak ceny',
};
const issueNames: Record<string, string> = {
  missing_override: 'Brak własnego wpisu i dostępnej reguły',
  invalid_fallback: 'Reguła nie daje poprawnej ceny',
  non_sellable_group: 'Grupa wariantów nie ma własnej ceny sprzedaży',
};
const statuses = {
  changed: 'Do zmiany',
  unchanged: 'Bez zmiany',
  invalid: 'Błąd',
  conflict: 'Konflikt wersji',
};
const merge = <T extends { index: number }>(old: T[], next: T[]) => [
  ...old,
  ...next.filter((r) => !old.some((p) => p.index === r.index)),
];
const initialDraft = (r: SelectionRow): Draft => ({
  operation: 'none',
  basis: 'gross',
  amount: r.override_present && r.override_price !== null ? amountText(r.override_price) : '',
});
function ownPrice(s: Pick<PriceSnapshot, 'override_present' | 'override_price' | 'currency'>) {
  return s.override_present && s.override_price !== null
    ? money(s.override_price, s.currency)
    : 'Brak własnego wpisu';
}
function effectivePrice(s: Pick<PriceSnapshot, 'effective_price' | 'currency'>) {
  return s.effective_price === null ? 'Brak ceny' : money(s.effective_price, s.currency);
}
function ScopeSummary({ list, warnings }: { list: ListSnapshot; warnings: string[] }) {
  return (
    <div className="pbe-scope">
      <p>
        <strong>
          Cennik: {list.name} · {list.currency} · ceny wynikowe brutto · wersja {list.version}
        </strong>
      </p>
      <p>
        {list.fallback
          ? 'Brak własnej ceny: reguła ' +
            list.adjustment_bps / 100 +
            '% i ' +
            money(list.adjustment_amount, list.currency) +
            ' od bazy w ' +
            list.catalog_currency +
            '.'
          : 'Brak własnego wpisu oznacza brak ceny w tym cenniku.'}
      </p>
      {!list.active && (
        <p className="notice">
          Cennik nieaktywny — można edytować ceny, lecz nowa sprzedaż nie użyje go przed ponownym
          włączeniem.
        </p>
      )}
      {warnings.map((w, i) => (
        <p key={i} className="notice">
          {w}
        </p>
      ))}
    </div>
  );
}
function FrozenRows({
  rows,
  receipt = false,
}: {
  rows: (PreviewRow | ExecutionRow)[];
  receipt?: boolean;
}) {
  return (
    <div className="pbe-scroll">
      <table className="pbe-results">
        <thead>
          <tr>
            <th>Produkt / operacja</th>
            <th>Własna cena przed → po</th>
            <th>Cena wynikowa brutto przed → po</th>
            <th>Wynik / VAT</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index}>
              <td>
                <strong>{r.sku}</strong>
                <small>{r.name}</small>
                <small>{operations[r.input.operation]}</small>
                {r.input.operation === 'set' && (
                  <small>
                    Wpisano {money(r.input.amount_minor, r.before.currency)}{' '}
                    {r.input.basis === 'net' ? 'netto' : 'brutto'}; docelowo brutto{' '}
                    {r.after?.override_price === null || !r.after
                      ? 'nie wyliczono'
                      : money(r.after.override_price, r.after.currency)}
                    .
                  </small>
                )}
              </td>
              <td>
                {ownPrice(r.before)}
                <small>→ {r.after ? ownPrice(r.after) : 'Nie wyliczono'}</small>
              </td>
              <td>
                {effectivePrice(r.before)}
                <small>{sourceNames[r.before.source]}</small>
                <strong>→ {r.after ? effectivePrice(r.after) : 'Nie wyliczono'}</strong>
                {r.after && <small>{sourceNames[r.after.source]}</small>}
                {r.after?.issue && <small>{issueNames[r.after.issue] ?? r.after.issue}</small>}
              </td>
              <td>
                {receipt
                  ? r.status === 'changed'
                    ? 'Zapisano zmianę'
                    : 'Bez zmiany'
                  : statuses[r.status]}
                <small>VAT zamrożony: {r.before.vat}%</small>
                {'product_version' in r && <small>Wersja produktu: {r.product_version}</small>}
                {'before_list_version' in r && (
                  <small>
                    Cennik: {r.before_list_version} → {r.after_list_version}
                  </small>
                )}
                {'errors' in r &&
                  r.errors.map((e, i) => (
                    <p className="error" role="alert" key={i}>
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
export function PriceBulkEdit({
  selection: selectedProducts,
  readOnly,
  onClose,
  onChanged,
  onPendingChange,
  initialTab = 'editor',
}: {
  selection: ReadonlyArray<{ id: string; version: number; sku: string }>;
  readOnly: boolean;
  onClose: () => void;
  onChanged: () => void;
  onPendingChange?: (pending: boolean) => void;
  initialTab?: 'editor' | 'history';
}) {
  const [metadata, setMetadata] = useState<Metadata | null>(null),
    [tab, setTab] = useState(initialTab);
  const [listId, setListId] = useState(''),
    [list, setList] = useState<ListSnapshot | null>(null),
    [warnings, setWarnings] = useState<string[]>([]);
  const [selection, setSelection] = useState<SelectionRow[]>([]),
    [loaded, setLoaded] = useState(false),
    [progress, setProgress] = useState(0),
    [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}),
    [applyDraft, setApplyDraft] = useState<Draft>({ operation: 'set', basis: 'gross', amount: '' }),
    [listSearch, setListSearch] = useState(''),
    [listQuery, setListQuery] = useState(''),
    [pickedList, setPickedList] = useState<List | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null),
    [previewRows, setPreviewRows] = useState<PreviewRow[]>([]),
    [previewCursor, setPreviewCursor] = useState<string | null>(null);
  const [consent, setConsent] = useState(''),
    [missingConsent, setMissingConsent] = useState('');
  const [previewAttempt, setPreviewAttempt] = useState<PreviewRequest | null>(null),
    [executeAttempt, setExecuteAttempt] = useState<ExecuteRequest | null>(null);
  const previewRequest = useRef<PreviewRequest | null>(null),
    executeRequest = useRef<ExecuteRequest | null>(null);
  const [execution, setExecution] = useState<Execution | null>(null),
    [executionRows, setExecutionRows] = useState<ExecutionRow[]>([]),
    [executionCursor, setExecutionCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Page<Execution> | null>(null),
    [historical, setHistorical] = useState<Execution | null>(null),
    [historicalRows, setHistoricalRows] = useState<ExecutionRow[]>([]),
    [historicalCursor, setHistoricalCursor] = useState<string | null>(null);
  const alive = useRef(false),
    epoch = useRef(0),
    ticket = useRef(0),
    inFlight = useRef<number | null>(null);
  const selected = [...selectedProducts].sort((a, b) => a.id.localeCompare(b.id)),
    ids = selected.map((p) => p.id),
    scopeKey = selected.map((p) => p.id + ':' + p.version).join(',');
  const expected = new Map(selected.map((p) => [p.id, p.version]));
  const validScope = ids.length > 0 && ids.length <= 500 && new Set(ids).size === ids.length;
  const frozen = busy || !!previewAttempt || !!executeAttempt;
  const writable =
    !readOnly && !blocked && !!metadata?.available && metadata.can_write && !metadata.read_only;
  const editable = writable && !frozen && !execution;
  const fence = preview ? preview.id + ':' + preview.scope_hash : '';
  const current = (context: number) => alive.current && context === epoch.current;
  function clearPlan() {
    setPreview(null);
    setPreviewRows([]);
    setPreviewCursor(null);
    setConsent('');
    setMissingConsent('');
  }
  function clearExecution() {
    setExecution(null);
    setExecutionRows([]);
    setExecutionCursor(null);
  }
  function releaseAttempts() {
    previewRequest.current = null;
    executeRequest.current = null;
    setPreviewAttempt(null);
    setExecuteAttempt(null);
  }
  function purge() {
    ++epoch.current;
    ++ticket.current;
    inFlight.current = null;
    setMetadata(null);
    setListId('');
    setList(null);
    setSelection([]);
    setLoaded(false);
    setDrafts({});
    setApplyDraft({ operation: 'set', basis: 'gross', amount: '' });
    setListSearch('');
    setListQuery('');
    setPickedList(null);
    setWarnings([]);
    clearPlan();
    clearExecution();
    releaseAttempts();
    setHistory(null);
    setHistorical(null);
    setHistoricalRows([]);
    setHistoricalCursor(null);
    setNotice('');
    setBlocked(true);
    setBusy(false);
    onPendingChange?.(false);
  }
  function fail(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && [401, 403].includes(e.status)) purge();
    else if (e instanceof ApiError && e.status === 423) {
      releaseAttempts();
      setConsent('');
      setMissingConsent('');
      setBlocked(true);
      setMetadata((m) => (m ? { ...m, read_only: true, can_write: false } : m));
      setNotice(
        'Zapis zablokowany w kopii tylko do odczytu. Szkic zachowano; historia pozostaje czytelna.',
      );
    } else if (e instanceof ApiError && e.status === 503) {
      releaseAttempts();
      setConsent('');
      setMissingConsent('');
      setBlocked(true);
      setNotice('Moduł niedostępny; dalszy zapis zablokowano. Szkic zachowano.');
    }
  }
  function flags(d: Flags) {
    if (!d.can_read) {
      setError('Utracono uprawnienia do odczytu cen.');
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
      setList(null);
      setSelection([]);
      setLoaded(false);
      setWarnings([]);
      clearPlan();
      clearExecution();
      releaseAttempts();
      setHistory(null);
      setHistorical(null);
      setHistoricalRows([]);
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
  async function historyPage(context: number, cursor?: string | null) {
    const d = await api<Page<Execution>>(
      prefix + '/executions' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    if (!current(context) || !flags(d)) return;
    setHistory((old) => ({
      ...d,
      data: cursor
        ? [...(old?.data ?? []), ...d.data.filter((p) => !old?.data.some((r) => r.id === p.id))]
        : d.data,
    }));
  }
  useEffect(() => {
    alive.current = true;
    ++epoch.current;
    inFlight.current = null;
    setMetadata(null);
    setBlocked(false);
    setListId('');
    setList(null);
    setWarnings([]);
    setSelection([]);
    setLoaded(false);
    setDrafts({});
    setApplyDraft({ operation: 'set', basis: 'gross', amount: '' });
    setListSearch('');
    setListQuery('');
    setPickedList(null);
    clearPlan();
    clearExecution();
    releaseAttempts();
    setHistory(null);
    setHistorical(null);
    setHistoricalRows([]);
    setHistoricalCursor(null);
    setProgress(0);
    setPage(0);
    setError('');
    setNotice('');
    setBusy(false);
    void run(async (context) => {
      const m = await api<Metadata>(prefix);
      if (!current(context)) return;
      setMetadata(m);
      if (m.available && m.can_read && initialTab === 'history') await historyPage(context);
    });
    return () => {
      alive.current = false;
      ++epoch.current;
      ++ticket.current;
      inFlight.current = null;
      onPendingChange?.(false);
    };
  }, [scopeKey, readOnly]);
  useEffect(() => {
    onPendingChange?.(frozen);
  }, [frozen]);
  async function listPage(cursor?: string | null, search = listQuery) {
    if (frozen || !metadata?.available || !metadata.can_read) return;
    if (search.trim().length > 100) {
      setError('Wyszukiwanie cennika wymaga najwyżej 100 znaków.');
      return;
    }
    await run(async (context) => {
      const d = await api<Metadata>(
        prefix +
          '?search=' +
          encodeURIComponent(search.trim()) +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      );
      if (!current(context) || !flags(d)) return;
      setListQuery(search.trim());
      setMetadata((old) => ({
        ...d,
        price_lists:
          cursor && old
            ? [
                ...old.price_lists,
                ...d.price_lists.filter((l) => !old.price_lists.some((p) => p.id === l.id)),
              ]
            : d.price_lists,
      }));
    });
  }
  async function loadSelection(target: string) {
    if (!target || !validScope || frozen || !metadata?.available || !metadata.can_read) return;
    setListId(target);
    setList(null);
    setWarnings([]);
    setSelection([]);
    setLoaded(false);
    setDrafts({});
    clearPlan();
    clearExecution();
    setNotice('');
    setPage(0);
    setProgress(0);
    await run(async (context) => {
      const all: SelectionRow[] = [],
        seen = new Set<string>();
      let snapshot: ListSnapshot | null = null,
        repricingHash: string | null = null,
        notes: string[] = [];
      const size = Math.min(50, metadata.limits.selection_products);
      if (!Number.isInteger(size) || size < 1)
        throw new Error('Nieprawidłowy limit wyboru produktów.');
      for (let start = 0; start < ids.length; start += size) {
        const chunk = ids.slice(start, start + size);
        let cursor: string | null = null,
          count = 0,
          total: number | null = null;
        const cursors = new Set<string>();
        do {
          const d: SelectionPage = await api<SelectionPage>(
            prefix +
              '/selection?price_list_id=' +
              encodeURIComponent(target) +
              '&ids=' +
              encodeURIComponent(chunk.join(',')) +
              (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
          );
          if (!current(context) || !flags(d)) return;
          if (
            d.list.id !== target ||
            typeof d.meta.total !== 'number' ||
            !Number.isInteger(d.meta.total) ||
            d.meta.total !== chunk.length
          )
            throw new Error('API nie potwierdziło pełnego zakresu wybranych produktów i cennika.');
          if (
            snapshot &&
            (JSON.stringify(snapshot) !== JSON.stringify(d.list) ||
              repricingHash !== JSON.stringify(d.repricing_snapshot))
          )
            throw new Error(
              'Cennik lub repricing zmienił się w trakcie odczytu. Cały zakres odrzucono; wczytaj go ponownie.',
            );
          if (total !== null && total !== d.meta.total)
            throw new Error('Zakres zmienił się podczas odczytu.');
          snapshot = d.list;
          repricingHash = JSON.stringify(d.repricing_snapshot);
          total = d.meta.total;
          notes = d.warnings;
          for (const row of d.data) {
            if (!chunk.includes(row.product_id) || seen.has(row.product_id))
              throw new Error('API zwróciło obcy lub powtórzony produkt. Cały zakres odrzucono.');
            seen.add(row.product_id);
            all.push(row);
            ++count;
          }
          if (all.length > Math.min(500, metadata.limits.rows))
            throw new Error('Pełny zakres przekracza 500 wierszy; niczego nie obcinamy.');
          setProgress(all.length);
          cursor = d.meta.cursor;
          if (cursor) {
            if (cursors.has(cursor) || !d.data.length)
              throw new Error('Nieprawidłowy kursor zakresu.');
            cursors.add(cursor);
          }
        } while (cursor);
        if (count !== total || !chunk.every((id) => seen.has(id)))
          throw new Error(
            'Odczyt nie objął wszystkich wybranych produktów. Cały zakres odrzucono.',
          );
      }
      if (!snapshot) throw new Error('Brak odczytanego cennika.');
      setList(snapshot);
      setWarnings(notes);
      setSelection(all);
      setLoaded(true);
    });
  }
  function dirty() {
    clearPlan();
    setError('');
    setNotice('');
  }
  function change(row: SelectionRow, patch: Partial<Draft>) {
    if (!editable || !row.editable) return;
    setDrafts((old) => ({
      ...old,
      [row.product_id]: { ...(old[row.product_id] ?? initialDraft(row)), ...patch },
    }));
    dirty();
  }
  function applyAll() {
    if (!editable || !loaded) return;
    try {
      if (selection.some((r) => !r.editable))
        throw new Error(
          'Wybór zawiera produkt bez własnej ceny sprzedaży. Zmień wybór jawnie; nie pomijamy takich produktów.',
        );
      if (applyDraft.operation === 'set') {
        const amount = parsePriceAmount(applyDraft.amount);
        for (const r of selection) grossFor(amount, applyDraft.basis, r.vat);
      }
      setDrafts(Object.fromEntries(selection.map((r) => [r.product_id, { ...applyDraft }])));
      dirty();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const prepared = useMemo(() => {
    const rows: InputRow[] = [],
      errors: string[] = [];
    for (const r of selection) {
      const d = drafts[r.product_id] ?? initialDraft(r),
        base = {
          product_id: r.product_id,
          product_version: expected.get(r.product_id) ?? r.product_version,
        };
      if (d.operation === 'set') {
        try {
          const amount = parsePriceAmount(d.amount);
          grossFor(amount, d.basis, r.vat);
          rows.push({ ...base, operation: 'set', basis: d.basis, amount_minor: amount });
        } catch (e) {
          errors.push(r.sku + ': ' + (e as Error).message);
        }
      } else rows.push({ ...base, operation: d.operation });
    }
    const body = {
      client_key: '00000000-0000-4000-8000-000000000000',
      price_list_id: listId,
      list_version: list?.version ?? 1,
      rows,
    };
    return { rows, errors, bytes: new TextEncoder().encode(JSON.stringify(body)).length };
  }, [selection, drafts, list, listId, scopeKey]);
  async function previewPage(context: number, id: string, cursor?: string | null) {
    const d = await api<Page<PreviewRow>>(
      prefix +
        '/previews/' +
        id +
        '/rows' +
        (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    if (!current(context) || !flags(d)) return;
    setPreviewRows((old) => (cursor ? merge(old, d.data) : d.data));
    setPreviewCursor(d.meta.cursor);
  }
  async function executionPage(context: number, id: string, cursor?: string | null) {
    const d = await api<Page<ExecutionRow>>(
      prefix +
        '/executions/' +
        id +
        '/rows' +
        (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    if (!current(context) || !flags(d)) return;
    setExecutionRows((old) => (cursor ? merge(old, d.data) : d.data));
    setExecutionCursor(d.meta.cursor);
  }
  async function makePreview() {
    if (!writable || !loaded || !list || !validScope || execution || executeAttempt) return;
    if (
      !previewRequest.current &&
      (prepared.errors.length ||
        prepared.bytes > Math.min(MAX_BYTES, metadata?.limits.body_bytes ?? MAX_BYTES))
    ) {
      setError(
        prepared.errors[0] ??
          'Całe żądanie przekracza 786432 bajty. Nie obcinamy treści ani zakresu.',
      );
      return;
    }
    const body = previewRequest.current ?? {
      client_key: crypto.randomUUID(),
      price_list_id: list.id,
      list_version: list.version,
      rows: prepared.rows,
    };
    await run(async (context) => {
      previewRequest.current = body;
      setPreviewAttempt(body);
      clearPlan();
      setNotice('');
      try {
        const d = await api<Flags & { preview: Preview; reused: boolean }>(
          prefix + '/previews',
          'POST',
          body,
        );
        if (!current(context)) return;
        previewRequest.current = null;
        setPreviewAttempt(null);
        if (!flags(d)) return;
        setPreview(d.preview);
        await previewPage(context, d.preview.id);
      } catch (e) {
        if (!current(context)) return;
        if (e instanceof ApiError && [409, 422, 413].includes(e.status)) {
          previewRequest.current = null;
          setPreviewAttempt(null);
        }
        if (previewRequest.current)
          setNotice(
            'Odpowiedź podglądu jest niepewna. Ponów tę samą próbę z zachowanym body i kluczem.',
          );
        throw e;
      }
    });
  }
  async function execute() {
    if (
      !writable ||
      !preview?.ready ||
      execution ||
      (!executeRequest.current &&
        (consent !== fence || (preview.missing_after_count > 0 && missingConsent !== fence)))
    )
      return;
    const id = preview.id,
      body = executeRequest.current ?? {
        client_key: crypto.randomUUID(),
        scope_hash: preview.scope_hash,
        confirmed: true as const,
        ack_missing_prices: preview.missing_after_count > 0 && missingConsent === fence,
      };
    await run(async (context) => {
      executeRequest.current = body;
      setExecuteAttempt(body);
      setNotice('');
      try {
        const d = await api<Flags & { execution: Execution; reused: boolean }>(
          prefix + '/previews/' + id + '/execute',
          'POST',
          body,
        );
        if (!current(context)) return;
        executeRequest.current = null;
        setExecuteAttempt(null);
        if (!flags(d)) return;
        setExecution(d.execution);
        setExecutionRows([]);
        setConsent('');
        setMissingConsent('');
        setNotice('Cała partia cen została zapisana lokalnie. Wynik jest trwały.');
        onChanged();
        await executionPage(context, d.execution.id);
      } catch (e) {
        if (!current(context)) return;
        if (executeRequest.current && e instanceof ApiError && [409, 422, 413].includes(e.status)) {
          executeRequest.current = null;
          setExecuteAttempt(null);
          clearPlan();
          setNotice(
            'Partia nie została zapisana. Szkic i wybrane wersje zachowano; potrzebny nowy podgląd i zgoda. Jawny odczyt od nowa usuwa szkic.',
          );
        }
        if (executeRequest.current)
          setNotice(
            'Wynik jest niepewny. Ponowienie użyje identycznego body, obu zgód i klucza; nie tworzymy drugiego wykonania.',
          );
        throw e;
      }
    });
  }
  async function readHistory(head: Execution, cursor?: string | null) {
    await run(async (context) => {
      const [detail, rows] = await Promise.all([
        api<Flags & { execution: Execution }>(prefix + '/executions/' + head.id),
        api<Page<ExecutionRow>>(
          prefix +
            '/executions/' +
            head.id +
            '/rows' +
            (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        ),
      ]);
      if (!current(context) || !flags(detail) || !flags(rows)) return;
      setHistorical(detail.execution);
      setHistoricalRows((old) => (cursor ? merge(old, rows.data) : rows.data));
      setHistoricalCursor(rows.meta.cursor);
    });
  }
  const pages = Math.max(1, Math.ceil(selection.length / 50));
  return (
    <section className="panel price-bulk-edit" aria-label="Arkusz cen w cenniku">
      <div className="panel-heading">
        <div>
          <h2>Ceny w cenniku</h2>
          <p>{ids.length} jawnie wybranych produktów · jeden cennik na partię</p>
        </div>
        <button className="button" disabled={frozen} onClick={onClose}>
          Zamknij panel cen
        </button>
      </div>
      <div className="pbe-body">
        <p className="notice">
          Zapis zmienia wyłącznie własne ceny wybranego cennika. Cena bazowa PIM, stany i
          wcześniejsze zamówienia pozostają bez zmiany. Brak automatycznej publikacji do kanałów ani
          przeliczania walut.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {busy && (
          <p role="status">
            Trwa lokalna operacja…
            {listId && !loaded && ' Odczytano ' + progress + ' z ' + ids.length + ' produktów.'}
          </p>
        )}
        {metadata && !metadata.available && (
          <p>Ta kopia nie zawiera arkusza cen. Dotychczasowe cenniki mają osobny panel.</p>
        )}
        {(readOnly || metadata?.read_only) && (
          <p className="notice">Kopia tylko do odczytu — zapis cen zablokowany.</p>
        )}
        {metadata?.available && metadata.can_read && (
          <>
            <div className="pbe-toolbar" role="tablist" aria-label="Arkusz cen i historia">
              <button
                className="button"
                role="tab"
                aria-selected={tab === 'editor'}
                disabled={frozen || !validScope}
                onClick={() => setTab('editor')}
              >
                Arkusz wybranych produktów
              </button>
              <button
                className="button"
                role="tab"
                aria-selected={tab === 'history'}
                disabled={frozen}
                onClick={() => {
                  setTab('history');
                  if (!history) void run((context) => historyPage(context));
                }}
              >
                Historia cen w cennikach
              </button>
            </div>
            {tab === 'editor' && (
              <>
                {!writable && (
                  <p>
                    Brak uprawnienia do zapisu cen w tym kontekście. Historia i lokalne odczyty
                    pozostają dostępne.
                  </p>
                )}
                {!validScope && (
                  <p className="error">
                    Wybierz 1–500 różnych produktów; większego wyboru nie obcinamy.
                  </p>
                )}
                <form
                  className="pbe-toolbar"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void listPage(null, listSearch);
                  }}
                >
                  <label>
                    Szukaj cennika
                    <input
                      aria-label="Szukaj cennika dla arkusza"
                      value={listSearch}
                      disabled={frozen}
                      onChange={(e) => setListSearch(e.target.value)}
                    />
                  </label>
                  <button className="button" disabled={frozen}>
                    Szukaj cenników
                  </button>
                  {metadata.meta.cursor && (
                    <button
                      type="button"
                      className="button"
                      disabled={frozen}
                      onClick={() => void listPage(metadata.meta.cursor)}
                    >
                      Kolejne cenniki
                    </button>
                  )}
                </form>
                <label>
                  Cennik
                  <select
                    aria-label="Cennik arkusza cen"
                    value={listId}
                    disabled={frozen || !validScope}
                    onChange={(e) => {
                      const target = e.target.value;
                      setPickedList(
                        metadata.price_lists.find((p) => p.id === target) ?? pickedList,
                      );
                      if (!target) {
                        setListId('');
                        setList(null);
                        setPickedList(null);
                        setSelection([]);
                        setLoaded(false);
                        setDrafts({});
                        clearPlan();
                        clearExecution();
                      } else void loadSelection(target);
                    }}
                  >
                    <option value="">Wybierz cennik i walutę</option>
                    {pickedList && !metadata.price_lists.some((p) => p.id === pickedList.id) && (
                      <option value={pickedList.id}>
                        {pickedList.name} · {pickedList.currency}
                        {!pickedList.active && ' · nieaktywny'}
                      </option>
                    )}
                    {metadata.price_lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} · {l.currency}
                        {!l.active && ' · nieaktywny'}
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  Zmiana cennika albo ponowny odczyt zakresu usuwa szkic i zgodę. Wyszukiwanie
                  cenników zachowuje aktualny wybór.
                </p>
                {!metadata.price_lists.length && !metadata.meta.cursor && (
                  <p>
                    Brak cenników dla tego wyszukiwania. Cennik tworzysz w osobnym panelu Cenniki.
                  </p>
                )}
                {listId && (
                  <button
                    className="button"
                    disabled={frozen}
                    onClick={() => void loadSelection(listId)}
                  >
                    Wczytaj cały zakres od nowa (usuwa szkic)
                  </button>
                )}
                {loaded && list && (
                  <>
                    <ScopeSummary list={list} warnings={warnings} />
                    <p>
                      <strong>
                        Pełny zakres: {selection.length} z {ids.length} wybranych produktów.
                      </strong>{' '}
                      Odczytano wszystkie porcje i strony. Wersje wybrane w katalogu nie są
                      zastępowane bieżącymi.
                    </p>
                    <p>
                      Własna cena ma pierwszeństwo nad regułą. Usunięcie wpisu przywróci regułę albo
                      pozostawi brak ceny. Własne 0,00 {list.currency} jest ceną, nie brakiem wpisu.
                    </p>
                    <div className="pbe-apply" aria-label="Ustaw ceny dla całego wyboru">
                      <label>
                        Operacja dla wybranych
                        <select
                          aria-label="Operacja ceny dla wybranych"
                          value={applyDraft.operation}
                          disabled={!editable}
                          onChange={(e) =>
                            setApplyDraft((d) => ({ ...d, operation: e.target.value as Operation }))
                          }
                        >
                          <option value="none">Bez zmiany</option>
                          <option value="set">Ustaw własną cenę</option>
                          <option value="remove">Usuń własną cenę</option>
                        </select>
                      </label>
                      <label>
                        Kwota wejściowa
                        <select
                          aria-label="Brutto lub netto dla wybranych"
                          value={applyDraft.basis}
                          disabled={!editable || applyDraft.operation !== 'set'}
                          onChange={(e) =>
                            setApplyDraft((d) => ({ ...d, basis: e.target.value as Basis }))
                          }
                        >
                          <option value="gross">Brutto</option>
                          <option value="net">Netto</option>
                        </select>
                      </label>
                      <label>
                        Kwota ({list.currency})
                        <input
                          aria-label="Kwota ceny dla wybranych"
                          inputMode="decimal"
                          value={applyDraft.amount}
                          disabled={!editable || applyDraft.operation !== 'set'}
                          onChange={(e) => setApplyDraft((d) => ({ ...d, amount: e.target.value }))}
                        />
                      </label>
                      <button
                        type="button"
                        className="button"
                        disabled={!editable}
                        onClick={applyAll}
                      >
                        Zastosuj do {selection.length} wybranych produktów
                      </button>
                    </div>
                    <p>
                      Netto → brutto: VAT danego produktu, zaokrąglenie do jednostki minimalnej
                      połówką w górę. Nie zapisujemy osobnego netto ani VAT. Ostateczne brutto i
                      zamrożony VAT zobaczysz w trwałym podglądzie.
                    </p>
                    <div className="pbe-toolbar">
                      <strong>
                        Strona {page + 1} z {pages} · produkty po 50
                      </strong>
                      <button
                        className="button"
                        disabled={frozen || page === 0}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        Poprzednie produkty
                      </button>
                      <button
                        className="button"
                        disabled={frozen || page + 1 >= pages}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Następne produkty
                      </button>
                    </div>
                    <div className="pbe-scroll">
                      <table className="pbe-sheet">
                        <thead>
                          <tr>
                            <th>Produkt / VAT</th>
                            <th>Cena katalogowa</th>
                            <th>Własna / wynikowa</th>
                            <th>Operacja</th>
                            <th>Brutto / netto</th>
                            <th>Nowa kwota ({list.currency})</th>
                            <th>Brutto do zapisu</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selection.slice(page * 50, page * 50 + 50).map((r) => {
                            const d = drafts[r.product_id] ?? initialDraft(r),
                              snapshot = { ...r, currency: list.currency };
                            let gross: number | null = null,
                              validation = '';
                            if (d.operation === 'set') {
                              try {
                                gross = grossFor(parsePriceAmount(d.amount), d.basis, r.vat);
                              } catch (e) {
                                validation = (e as Error).message;
                              }
                            }
                            return (
                              <tr key={r.product_id}>
                                <td>
                                  <strong>{r.sku}</strong>
                                  <small>{r.name}</small>
                                  <small>
                                    VAT: {r.vat}% · wybrana wersja {expected.get(r.product_id)};
                                    odczytana {r.product_version}
                                  </small>
                                  {expected.get(r.product_id) !== r.product_version && (
                                    <p className="error">
                                      Produkt zmienił się od zaznaczenia. Starego oczekiwania nie
                                      podmieniamy.
                                    </p>
                                  )}
                                  {!r.active && (
                                    <small>Produkt nieaktywny — zapis ceny go nie aktywuje</small>
                                  )}
                                  {r.errors.map((e, i) => (
                                    <p className="error" key={i}>
                                      {e}
                                    </p>
                                  ))}
                                </td>
                                <td>{money(r.catalog_price, list.catalog_currency)}</td>
                                <td>
                                  {ownPrice(snapshot)}
                                  <small>Wynik brutto: {effectivePrice(snapshot)}</small>
                                  <small>{sourceNames[r.source]}</small>
                                  {r.issue && <small>{issueNames[r.issue] ?? r.issue}</small>}
                                </td>
                                <td>
                                  <select
                                    aria-label={'Operacja ceny · ' + r.sku}
                                    value={d.operation}
                                    disabled={!editable || !r.editable}
                                    onChange={(e) =>
                                      change(r, { operation: e.target.value as Operation })
                                    }
                                  >
                                    <option value="none">Bez zmiany</option>
                                    <option value="set">Ustaw własną cenę</option>
                                    <option value="remove">Usuń własną cenę</option>
                                  </select>
                                </td>
                                <td>
                                  <select
                                    aria-label={'Brutto lub netto · ' + r.sku}
                                    value={d.basis}
                                    disabled={!editable || !r.editable || d.operation !== 'set'}
                                    onChange={(e) => change(r, { basis: e.target.value as Basis })}
                                  >
                                    <option value="gross">Brutto</option>
                                    <option value="net">Netto</option>
                                  </select>
                                </td>
                                <td>
                                  <input
                                    aria-label={'Kwota ceny · ' + r.sku}
                                    inputMode="decimal"
                                    value={d.operation === 'set' ? d.amount : ''}
                                    disabled={!editable || !r.editable || d.operation !== 'set'}
                                    onChange={(e) => change(r, { amount: e.target.value })}
                                  />
                                </td>
                                <td>
                                  {d.operation === 'set'
                                    ? gross === null
                                      ? 'Nie wyliczono'
                                      : money(gross, list.currency)
                                    : d.operation === 'remove'
                                      ? 'Reguła lub brak ceny — sprawdź podgląd'
                                      : 'Bez zmiany'}
                                  {validation && <p className="error">{validation}</p>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p>
                      Całe żądanie: {prepared.bytes.toLocaleString('pl-PL')} /{' '}
                      {Math.min(MAX_BYTES, metadata.limits.body_bytes).toLocaleString('pl-PL')}{' '}
                      bajtów. Puste pole nie usuwa wpisu; wybierz operację usunięcia.
                    </p>
                    {prepared.errors.map((e, i) => (
                      <p className="error" key={i}>
                        {e}
                      </p>
                    ))}
                    <button
                      className="button primary"
                      disabled={!writable || busy || !!executeAttempt || !!execution}
                      onClick={() => void makePreview()}
                    >
                      {previewAttempt
                        ? 'Ponów ten sam podgląd cen'
                        : 'Utwórz podgląd całej partii cen'}
                    </button>
                  </>
                )}
                {preview && (
                  <section className="pbe-result">
                    <h3>Niezmienny podgląd cen</h3>
                    <ScopeSummary list={preview.list_snapshot} warnings={preview.warnings} />
                    <p>
                      Łącznie {preview.total}; zmiany {preview.changed}; bez zmiany{' '}
                      {preview.unchanged}; błędy {preview.invalid}; konflikty {preview.conflicts};
                      produktów bez ceny po operacji {preview.missing_after_count}.
                    </p>
                    <p>
                      Kwota netto jest wejściem. Do cennika zapisujemy brutto po dokładnym
                      przeliczeniu z zamrożonym VAT pokazanym w wierszu. Własny wpis równy cenie z
                      reguły zmienia źródło ceny, nawet bez zmiany kwoty.
                    </p>
                    <FrozenRows rows={previewRows} />
                    <p>
                      Wczytano {previewRows.length} z {preview.total} wierszy. Zgoda obejmuje
                      wszystkie strony.
                    </p>
                    {previewCursor && (
                      <button
                        className="button"
                        disabled={frozen}
                        onClick={() =>
                          void run((context) => previewPage(context, preview.id, previewCursor))
                        }
                      >
                        Kolejne wiersze podglądu cen
                      </button>
                    )}
                    <button
                      className="button"
                      disabled={frozen}
                      onClick={() => void run((context) => previewPage(context, preview.id))}
                    >
                      Odśwież lokalny podgląd cen
                    </button>
                    {!preview.ready && (
                      <p className="error">
                        Jeden błąd lub konflikt blokuje całą partię. Popraw szkic albo jawnie
                        wczytaj zakres od nowa.
                      </p>
                    )}
                    {preview.ready && !execution && (
                      <>
                        {preview.missing_after_count > 0 && (
                          <label className="pbe-check">
                            <input
                              type="checkbox"
                              aria-label="Zgoda na brakujące ceny po operacji"
                              checked={missingConsent === fence}
                              disabled={!writable || frozen}
                              onChange={(e) => setMissingConsent(e.target.checked ? fence : '')}
                            />
                            Świadomie pozostawiam {preview.missing_after_count} produktów bez ceny w
                            tym cenniku. Nowa wycena tych produktów będzie niedostępna do czasu
                            uzupełnienia ceny. To nie cena zero.
                          </label>
                        )}
                        <label className="pbe-check">
                          <input
                            type="checkbox"
                            aria-label="Zgoda na całą partię cen"
                            checked={consent === fence}
                            disabled={!writable || frozen}
                            onChange={(e) => setConsent(e.target.checked ? fence : '')}
                          />
                          Potwierdzam lokalny zapis całej partii {preview.total} produktów w cenniku{' '}
                          {preview.list_snapshot.name} ({preview.list_snapshot.currency}):{' '}
                          {preview.changed} zmian, {preview.unchanged} bez zmiany. Sprawdziłem
                          własne i wynikowe ceny brutto, VAT oraz braki. Bez publikacji do
                          dostawców.
                        </label>
                        <button
                          className="button primary"
                          disabled={
                            !writable ||
                            busy ||
                            (!executeAttempt &&
                              (consent !== fence ||
                                (preview.missing_after_count > 0 && missingConsent !== fence)))
                          }
                          onClick={() => void execute()}
                        >
                          {executeAttempt
                            ? 'Ponów tę samą próbę / odczytaj wynik cen'
                            : 'Zapisz całą zatwierdzoną partię cen'}
                        </button>
                      </>
                    )}
                    <details>
                      <summary>Identyfikator i hash zakresu cen</summary>
                      <p className="pbe-technical">
                        {preview.id}
                        <br />
                        {preview.scope_hash}
                      </p>
                    </details>
                  </section>
                )}
                {execution && (
                  <section className="pbe-result">
                    <h3>Zapisano całą partię cen</h3>
                    <ScopeSummary list={execution.list_snapshot} warnings={execution.warnings} />
                    <p>
                      {execution.total} produktów; zmieniono {execution.changed}; bez zmiany{' '}
                      {execution.unchanged}. Cennik: wersja {execution.before_list_version} →{' '}
                      {execution.after_list_version}. Brak ceny po operacji:{' '}
                      {execution.missing_after_count}
                      {execution.missing_after_count > 0 &&
                        (execution.ack_missing_prices
                          ? ' — świadomie potwierdzony'
                          : ' — bez potwierdzenia')}
                      .
                    </p>
                    <p>
                      Wynik brutto jest trwały; wejściowe netto i użyty VAT są dowodem przeliczenia.
                      Wersje produktów i dawne zamówienia nie zmieniły się.
                    </p>
                    <FrozenRows rows={executionRows} receipt />
                    <p>
                      Wczytano {executionRows.length} z {execution.total} wyników.
                    </p>
                    {executionCursor && (
                      <button
                        className="button"
                        disabled={frozen}
                        onClick={() =>
                          void run((context) =>
                            executionPage(context, execution.id, executionCursor),
                          )
                        }
                      >
                        Kolejne wyniki cen
                      </button>
                    )}
                    <button
                      className="button"
                      disabled={frozen}
                      onClick={() => void run((context) => executionPage(context, execution.id))}
                    >
                      Odśwież trwały wynik cen
                    </button>
                    <p>Następną partię rozpocznij przez jawny odczyt zakresu od nowa.</p>
                  </section>
                )}
              </>
            )}
            {tab === 'history' && (
              <>
                <div className="pbe-toolbar">
                  <button
                    className="button"
                    disabled={frozen}
                    onClick={() => void run((context) => historyPage(context))}
                  >
                    Odśwież historię cen
                  </button>
                  {history?.meta.cursor && (
                    <button
                      className="button"
                      disabled={frozen}
                      onClick={() =>
                        void run((context) => historyPage(context, history.meta.cursor))
                      }
                    >
                      Starsze wykonania cen
                    </button>
                  )}
                </div>
                {history && !history.data.length && (
                  <p>Brak wykonanych partii cen. Sam podgląd nie zmienia cennika.</p>
                )}
                {history && (
                  <div className="pbe-scroll">
                    <table className="pbe-history">
                      <thead>
                        <tr>
                          <th>Data / cennik</th>
                          <th>Zakres / zmiany</th>
                          <th>Wersja / braki</th>
                          <th>Wynik</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.data.map((h) => (
                          <tr key={h.id}>
                            <td>
                              {date(h.created_at)}
                              <small>
                                {h.list_snapshot.name} · {h.list_snapshot.currency}
                              </small>
                            </td>
                            <td>
                              {h.total} produktów; {h.changed} zmian; {h.unchanged} bez zmiany
                            </td>
                            <td>
                              {h.before_list_version} → {h.after_list_version}
                              <small>Brak ceny: {h.missing_after_count}</small>
                            </td>
                            <td>
                              <button
                                className="button"
                                disabled={frozen}
                                onClick={() => void readHistory(h)}
                              >
                                Pokaż trwały wynik cen
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {historical && (
                  <section className="pbe-result">
                    <h3>Trwały wynik cen · {date(historical.created_at)}</h3>
                    <ScopeSummary list={historical.list_snapshot} warnings={historical.warnings} />
                    <p>
                      {historical.total} produktów; {historical.changed} zmian;{' '}
                      {historical.unchanged} bez zmiany; wersja cennika{' '}
                      {historical.before_list_version} → {historical.after_list_version}. Brak ceny
                      po operacji: {historical.missing_after_count}
                      {historical.missing_after_count > 0 &&
                        historical.ack_missing_prices &&
                        ' — świadomie potwierdzony'}
                      .
                    </p>
                    <p>
                      Pokazujemy zamrożone kwoty, wejściowe netto lub brutto oraz VAT z chwili
                      zatwierdzenia. Aktualna reguła lub waluta nie przelicza tego wyniku.
                    </p>
                    <FrozenRows rows={historicalRows} receipt />
                    <p>
                      Wczytano {historicalRows.length} z {historical.total} wierszy wyniku.
                    </p>
                    {historicalCursor && (
                      <button
                        className="button"
                        disabled={frozen}
                        onClick={() => void readHistory(historical, historicalCursor)}
                      >
                        Kolejne wiersze wyniku cen
                      </button>
                    )}
                    <button
                      className="button"
                      disabled={frozen}
                      onClick={() => void readHistory(historical)}
                    >
                      Odśwież ten wynik cen
                    </button>
                    <details>
                      <summary>Identyfikatory i hash zakresu cen</summary>
                      <p className="pbe-technical">
                        {historical.id}
                        <br />
                        Podgląd: {historical.preview_id}
                        <br />
                        {historical.scope_hash}
                      </p>
                    </details>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
