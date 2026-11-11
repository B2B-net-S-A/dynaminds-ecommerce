import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import './catalog-export.css';
import { CatalogExportProfiles, type CatalogExportCatalog, resetCatalogExportProfileContext, subscribeCatalogExportLock, catalogExportLocked, setCatalogExportReadLocked } from './catalog-export-profiles';
export { subscribeCatalogExportLock, catalogExportLocked } from './catalog-export-profiles';
import {
  CatalogExportSources,
  type CatalogExportWarehouseChoice,
  type CatalogExportPriceListChoice,
} from './catalog-export-sources';

type Format = 'csv' | 'xml';
type Selection = 'filtered' | 'selected';
type Active = 'all' | 'yes' | 'no';
type Column = {
  key: string;
  label: string;
  type: 'text' | 'integer' | 'boolean' | 'json';
  unit?: string;
};
type Options = {
  catalog_available?: boolean;
  catalogs?: CatalogExportCatalog[];
  catalog?: CatalogExportCatalog | null;
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  formats: Format[];
  columns: Column[];
  default_columns: string[];
  catalog_currency: string;
  price_source: 'catalog';
  product_logistics_available: boolean;
  product_translations_available: boolean;
  sources?: {
    warehouses: { available: boolean; data: CatalogExportWarehouseChoice[]; capped: boolean };
    price_lists: { available: boolean; data: CatalogExportPriceListChoice[]; capped: boolean };
    allow_inventory: boolean;
  };
  count: { matched_products: number; capped: boolean };
  limits: {
    products: number;
    selected_products: number;
    batch_products: number;
    request_bytes: number;
    file_bytes: number;
  };
  defaults: { format: Format; selection: Selection; active: Active; spreadsheet_safe: boolean };
};
type SourceSample = {
  product_id: string;
  sku: string;
  name: string;
  inventory_json?: Array<Record<string, unknown>>;
  prices_json?: Array<Record<string, unknown>>;
};
type Review = {
  catalog_id?: string;
  catalog_version?: string;
  scope_hash?: string;
  catalog_name?: string;
  warehouse_ids?: string[];
  price_list_ids?: string[];
  sample?: SourceSample[];
  format: Format;
  selection: Selection;
  columns: string[];
  headers: Record<string, string>;
  ids: string[];
  search: string;
  active: Active;
  spreadsheet_safe: boolean;
  scope: string;
  matched_products: number | null;
};

export type CatalogExportProps = {
  workspaceId: string;
  contextKey: string;
  selectedIds: string[];
  initialFilter: { search: string; active: Active };
  readOnly?: boolean;
  onError?: (message: string) => void;
  onClose?: () => void;
  externalWriteBlocked?: boolean;
  onLockedChange?: (locked: boolean) => void;
};
type ReadAttempt = { kind: 'preview' | 'file'; body: string; review?: Review; contextKey: string; workspaceId: string };
let exportContext = '';
const retainedReads = new Map<string, ReadAttempt>();
export function resetCatalogExportContext(contextKey: string) { if (exportContext === contextKey) return; exportContext = contextKey; retainedReads.clear(); resetCatalogExportProfileContext(contextKey); }

const typeLabels = {
  text: 'Tekst',
  integer: 'Liczba całkowita',
  boolean: 'Tak / nie',
  json: 'Dane złożone',
};
const activeLabels = { all: 'Wszystkie', yes: 'Aktywne', no: 'Nieaktywne' };
const sourceLabel = (value: unknown) =>
  ({ stock: 'Zapas', components: 'Składniki zestawu', override: 'Własna cena', rule: 'Reguła' })[
    String(value)
  ] ?? '—';
const statusLabel = (value: unknown) =>
  ({
    available: 'Dostępne',
    missing: 'Brak danych',
    not_applicable: 'Nie dotyczy',
    unavailable: 'Niedostępne',
    invalid_out_of_range: 'Cena poza zakresem',
  })[String(value)] ?? String(value ?? '—');
const idsKey = (ids: string[]) => JSON.stringify([...new Set(ids)].sort());

/** Metadata reads on opening; downloading requires a reviewed scope and explicit click. */
export function CatalogExportPanel({
  workspaceId,
  contextKey,
  selectedIds,
  initialFilter,
  readOnly = false,
  onError,
  onClose,
  externalWriteBlocked = false,
  onLockedChange,
}: CatalogExportProps) {
  const [options, setOptions] = useState<Options | null>(null);
  const [catalogId, setCatalogId] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [readAttempt, setReadAttempt] = useState<ReadAttempt | null>(null);
  const [sharedLocked, setSharedLocked] = useState(false);
  const catalogReadGeneration = useRef(0);
  const [format, setFormat] = useState<Format>('csv');
  const [selection, setSelection] = useState<Selection>(
    selectedIds.length ? 'selected' : 'filtered',
  );
  const [columns, setColumns] = useState<string[]>([]);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [appliedProfile, setAppliedProfile] = useState('');
  const [warehouseIds, setWarehouseIds] = useState<string[]>([]);
  const [priceListIds, setPriceListIds] = useState<string[]>([]);
  const [search, setSearch] = useState(initialFilter.search);
  const [active, setActive] = useState<Active>(initialFilter.active);
  const [safe, setSafe] = useState(true);
  const [review, setReview] = useState<Review | null>(null);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [blocked, setBlocked] = useState(false);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const selectedKey = idsKey(selectedIds);
  const uniqueIds: string[] = JSON.parse(selectedKey);
  const scope = JSON.stringify({
    contextKey,
    workspaceId,
    readOnly,
    catalogId,
    format,
    selection,
    columns,
    headers,
    warehouseIds,
    priceListIds,
    search: search.trim(),
    active,
    safe: format === 'csv' && safe,
    selectedKey,
  });
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const readable = !!options?.available && options.can_read && !blocked;
  const chosenCatalog = options?.catalogs?.find((c) => c.id === catalogId);
  const catalogReady = !options?.catalog_available || Boolean(chosenCatalog?.active && options.catalog?.id === catalogId);
  const configurationLocked = busy || Boolean(readAttempt) || sharedLocked || externalWriteBlocked;
  const latestExternalBlock = useRef(externalWriteBlocked);
  latestExternalBlock.current = externalWriteBlocked;
  useEffect(() => subscribeCatalogExportLock(contextKey, (locked) => { setSharedLocked(locked); onLockedChange?.(locked); }), [contextKey, onLockedChange]);

  useEffect(() => {
    if (blocked) {
      setHeaders({});
      setAppliedProfile('');
      setWarehouseIds([]);
      setPriceListIds([]);
      retainedReads.delete(contextKey); setReadAttempt(null); setCatalogExportReadLocked(contextKey, false); setCatalogId('');
    }
  }, [blocked]);

  useEffect(() => {
    const e = ++epoch.current;
    resetCatalogExportContext(contextKey);
    let alive = true;
    controller.current?.abort();
    controller.current = null;
    busyRef.current = false;
    setBusy(false);
    setLoading(true);
    setBlocked(false);
    setError('');
    setStatus('');
    setOptions(null);
    setReview(null);
    setConsent(false);
    setColumns([]);
    setHeaders({});
    setAppliedProfile('');
    setWarehouseIds([]);
    setPriceListIds([]);
    setCatalogId('');
    const remembered = retainedReads.get(contextKey);
    setReadAttempt(remembered ?? null);
    api<Options>('/catalog/exports/options')
      .then((data) => {
        if (!alive || e !== epoch.current) return;
        setOptions(data);
        if (data.available && data.can_read) {
          if (remembered) {
            const body = JSON.parse(remembered.body);
            setCatalogId(body.catalog_id ?? ''); setColumns(body.columns); setHeaders(body.headers ?? {}); setFormat(body.format); setSafe(body.spreadsheet_safe); setWarehouseIds(body.warehouse_ids ?? []); setPriceListIds(body.price_list_ids ?? []); setSelection(body.selection); setSearch(body.search ?? ''); setActive(body.active ?? 'all');
          } else { setColumns(data.default_columns); setFormat(data.defaults.format); setSafe(data.defaults.spreadsheet_safe); }
        }
      })
      .catch((err: unknown) => {
        if (!alive || e !== epoch.current) return;
        const message = err instanceof Error ? err.message : 'Nie można odczytać opcji eksportu.';
        setError(message);
        if (err instanceof ApiError && [401, 403].includes(err.status)) setBlocked(true);
      })
      .finally(() => {
        if (alive && e === epoch.current) setLoading(false);
      });
    return () => {
      alive = false;
      ++epoch.current;
      controller.current?.abort();
    };
  }, [contextKey, workspaceId, readOnly]);

  useEffect(() => {
    const g = ++catalogReadGeneration.current, e = epoch.current;
    if (!options?.catalog_available || !catalogId || !chosenCatalog?.active) { setCatalogLoading(false); return; }
    let alive = true; setCatalogLoading(true);
    api<Options>('/catalog/exports/options?' + new URLSearchParams({ catalog_id: catalogId })).then((data) => {
      if (!alive || g !== catalogReadGeneration.current || e !== epoch.current) return;
      if (!data.can_read) throw new ApiError('Odebrano dostęp do eksportu katalogu.', 403);
      if (!data.catalog_available || data.catalog?.id !== catalogId) throw Error('Odczyt nie odpowiada wybranemu katalogowi.');
      setOptions(data);
    }).catch((err) => { if (alive && g === catalogReadGeneration.current && e === epoch.current) { setError(err.message); if (err instanceof ApiError && [401, 403].includes(err.status)) { setBlocked(true); setOptions(null); } } }).finally(() => { if (alive && g === catalogReadGeneration.current && e === epoch.current) setCatalogLoading(false); });
    return () => { alive = false; };
  }, [catalogId, options?.catalog_available, contextKey, workspaceId, readOnly]);

  useEffect(() => {
    setSearch(initialFilter.search);
    setActive(initialFilter.active);
  }, [initialFilter.search, initialFilter.active, contextKey]);
  useEffect(() => {
    setReview(null);
    setConsent(false);
    setStatus('');
    controller.current?.abort();
  }, [scope]);

  function toggleColumn(key: string) {
    setColumns((old) => (old.includes(key) ? old.filter((x) => x !== key) : [...old, key]));
  }
  function moveColumn(index: number, direction: -1 | 1) {
    setColumns((old) => {
      const next = [...old],
        target = index + direction;
      if (target < 0 || target >= next.length) return old;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  async function prepare(retry = false) {
    if (!readable || busyRef.current || !options || catalogLoading || (!retry && (configurationLocked || !catalogReady)) || (retry && readAttempt?.kind !== 'preview')) return;
    const e = epoch.current,
      reviewedScope = scope;
    setError('');
    setStatus('');
    setReview(null);
    setConsent(false);
    busyRef.current = true;
    setBusy(true);
    try {
      if (!columns.length) throw Error('Wybierz co najmniej jedno pole eksportu.');
      if (columns.some((key) => !options.columns.some((c) => c.key === key)))
        throw Error('Dostępne pola zmieniły się. Otwórz panel ponownie i wybierz pola.');
      const outputNames = columns.map((key) => headers[key]?.trim() || key);
      if (new Set(outputNames.map((name) => name.toLowerCase())).size !== outputNames.length)
        throw Error('Nazwy pól w pliku muszą być różne.');
      if (
        outputNames.some(
          (name) =>
            Array.from(name).length > 80 ||
            /[\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufffe\uffff]/u.test(name),
        )
      )
        throw Error('Nazwa pola może zawierać do 80 znaków, bez znaków sterujących.');
      if (
        format === 'xml' &&
        outputNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) || /^xml/i.test(name))
      )
        throw Error(
          'Nazwy XML muszą zaczynać się literą ASCII lub _, bez spacji, dwukropka i prefiksu xml.',
        );
      if (search.trim().length > 200)
        throw Error('Wyszukiwanie może zawierać najwyżej 200 znaków.');
      if (
        selection === 'selected' &&
        (!uniqueIds.length || uniqueIds.length > options.limits.selected_products)
      )
        throw Error(
          `Wybierz od 1 do ${options.limits.selected_products} produktów. Żaden wybór nie zostanie obcięty.`,
        );
      if (
        selection === 'selected' &&
        uniqueIds.some(
          (id) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id),
        )
      )
        throw Error('Zaznaczenie zawiera nieprawidłowy identyfikator produktu.');
      let matched: number | null = null;
      let sample: SourceSample[] | undefined;
      const sources = {
        ...(columns.includes('inventory_json') ? { warehouse_ids: [...warehouseIds] } : {}),
        ...(columns.includes('prices_json') ? { price_list_ids: [...priceListIds] } : {}),
      };
      if (
        columns.includes('inventory_json') &&
        (!options.sources?.allow_inventory || !warehouseIds.length || warehouseIds.length > 10)
      )
        throw Error('Wybierz od 1 do 10 magazynów z aktualnym dostępem do odczytu stanów.');
      if (columns.includes('prices_json') && (!priceListIds.length || priceListIds.length > 10))
        throw Error('Wybierz od 1 do 10 cenników.');
      let previewInput: Record<string, any> | undefined;
      let catalogFrame: { catalog_id: string; catalog_version: string; scope_hash: string; catalog_name: string } | undefined;
      if (options.catalog_available || columns.includes('inventory_json') || columns.includes('prices_json')) {
        const requestInput: Record<string, any> = retry && readAttempt ? JSON.parse(readAttempt.body) : {
          format, columns, headers: Object.fromEntries(columns.filter((key) => headers[key]?.trim()).map((key) => [key, headers[key].trim()])), spreadsheet_safe: format === 'csv' && safe, selection,
          ...(selection === 'selected' ? { ids: uniqueIds } : { search: search.trim(), active }), ...sources,
          ...(options.catalog_available ? { catalog_id: catalogId } : {}),
        };
        previewInput = requestInput;
        const fresh = await api<Options>('/catalog/exports/options' + (requestInput.catalog_id ? '?' + new URLSearchParams({ catalog_id: requestInput.catalog_id }) : ''));
        const me = await api('/auth/me');
        if (e !== epoch.current || reviewedScope !== currentScope.current) return;
        if (!fresh.can_read || !fresh.available || `${me.user?.tenant_id}:${me.user?.id}:${me.user?.role}` !== contextKey.split(':').slice(0, 3).join(':')) throw new ApiError('Zmieniła się firma lub dostęp do eksportu.', 403);
        if (!retry && latestExternalBlock.current) throw Error('Nowe odczyty eksportu są chwilowo zablokowane. Nie wysłano podglądu.');
        if (requestInput.catalog_id && (!fresh.catalog_available || fresh.catalog?.id !== requestInput.catalog_id)) throw Error('Ta kopia nie obsługuje wybranego katalogu. Dokładny odczyt pozostaje zachowany.');
        const a: ReadAttempt = retry && readAttempt ? readAttempt : { kind: 'preview', body: JSON.stringify(requestInput), contextKey, workspaceId };
        retainedReads.set(contextKey, a); setReadAttempt(a); setCatalogExportReadLocked(contextKey, true);
        const preview = await api<{
          count: { matched_products: number; capped: boolean };
          sample: SourceSample[];
          catalog?: CatalogExportCatalog; catalog_version?: string; scope_hash?: string;
        }>('/catalog/exports/preview', 'POST', JSON.parse(a.body));
        if (e !== epoch.current || reviewedScope !== currentScope.current) return;
        if (!preview.count || !Number.isSafeInteger(preview.count.matched_products) || preview.count.matched_products < 0 || typeof preview.count.capped !== 'boolean' || !Array.isArray(preview.sample) || preview.sample.length > 3 || new Set(preview.sample.map((v) => v.product_id)).size !== preview.sample.length) throw Error('Niepełny wynik podglądu. Zachowano dokładną próbę odczytu.');
        if (requestInput.catalog_id) {
          const catalog = preview.catalog, version = preview.catalog_version, hash = preview.scope_hash;
          if (!catalog || catalog.id !== requestInput.catalog_id || !catalog.active || typeof version !== 'string' || !/^[1-9][0-9]*$/.test(version) || catalog.version !== version || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || (requestInput.warehouse_ids ?? []).some((id: string) => !catalog.warehouse_ids.includes(id)) || (requestInput.price_list_ids ?? []).some((id: string) => !catalog.price_list_ids.includes(id))) throw Error('Podgląd nie potwierdza wybranego katalogu i jego zakresu. Zachowano dokładną próbę.');
          catalogFrame = { catalog_id: catalog.id, catalog_version: version, scope_hash: hash, catalog_name: catalog.name };
        }
        if (preview.count.capped) throw Error('Zakres przekracza limit produktów. Zawęź filtry.');
        matched = preview.count.matched_products;
        sample = preview.sample;
        retainedReads.delete(contextKey); setReadAttempt(null); setCatalogExportReadLocked(contextKey, false);
      }
      if (selection === 'filtered' && sample === undefined) {
        const data = await api<Options>(
          '/catalog/exports/options?' +
            new URLSearchParams({
              selection: 'filtered',
              search: search.trim(),
              active,
            }),
        );
        if (e !== epoch.current || reviewedScope !== currentScope.current) return;
        setOptions(data);
        if (!data.available || !data.can_read)
          throw new ApiError('Eksport nie jest dostępny dla bieżącego konta.', 403);
        if (data.count.capped)
          throw Error(
            `Zakres przekracza limit ${data.limits.products.toLocaleString('pl-PL')} produktów. Zawęź filtry; eksport nie obcina zakresu.`,
          );
        matched = data.count.matched_products;
      }
      setReview({
        format,
        selection,
        columns: [...columns],
        headers: Object.fromEntries(
          columns.filter((key) => headers[key]?.trim()).map((key) => [key, headers[key].trim()]),
        ),
        ids: selection === 'selected' ? uniqueIds : [],
        search: selection === 'filtered' ? search.trim() : '',
        active: selection === 'filtered' ? active : 'all',
        spreadsheet_safe: format === 'csv' && safe,
        scope,
        matched_products: matched,
        ...sources,
        sample,
        ...(previewInput ? { format: previewInput.format, selection: previewInput.selection, columns: previewInput.columns, headers: previewInput.headers, ids: previewInput.ids ?? [], search: previewInput.search ?? '', active: previewInput.active ?? 'all', spreadsheet_safe: previewInput.spreadsheet_safe, warehouse_ids: previewInput.warehouse_ids, price_list_ids: previewInput.price_list_ids } : {}),
        ...catalogFrame,
      });
      setConsent(false);
    } catch (err) {
      if (e !== epoch.current || reviewedScope !== currentScope.current) return;
      setError(err instanceof Error ? err.message : 'Sprawdź zakres eksportu.');
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) { retainedReads.delete(contextKey); setReadAttempt(null); setCatalogExportReadLocked(contextKey, false); }
      if (err instanceof ApiError && [401, 403].includes(err.status)) {
        setBlocked(true);
        setOptions(null);
        setColumns([]);
        setReview(null);
        setConsent(false);
      }
    } finally {
      if (e === epoch.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function download(retry = false) {
    if (
      !readable ||
      busyRef.current ||
      (retry ? readAttempt?.kind !== 'file' || !readAttempt.review : !review || review.scope !== currentScope.current || !consent || configurationLocked)
    )
      return;
    const e = epoch.current,
      frozen = retry ? { ...readAttempt!.review!, scope: currentScope.current } : review!;
    const abort = new AbortController();
    controller.current = abort;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    let objectUrl: string | null = null;
    try {
      const body = retry ? readAttempt!.body : JSON.stringify({
        format: frozen.format,
        selection: frozen.selection,
        columns: frozen.columns,
        headers: frozen.headers,
        active: frozen.active,
        search: frozen.search,
        spreadsheet_safe: frozen.spreadsheet_safe,
        ...(frozen.warehouse_ids ? { warehouse_ids: frozen.warehouse_ids } : {}),
        ...(frozen.price_list_ids ? { price_list_ids: frozen.price_list_ids } : {}),
        ...(frozen.selection === 'selected' ? { ids: frozen.ids } : {}),
        ...(frozen.catalog_id ? { catalog_id: frozen.catalog_id, catalog_version: frozen.catalog_version, scope_hash: frozen.scope_hash } : {}),
      });
      if (!options || new TextEncoder().encode(body).byteLength > options.limits.request_bytes)
        throw Error(
          'Konfiguracja eksportu przekracza dozwolony rozmiar. Zawęź zakres; wybór nie zostanie obcięty.',
        );
      const fresh = await api<Options>('/catalog/exports/options' + (frozen.catalog_id ? '?' + new URLSearchParams({ catalog_id: frozen.catalog_id }) : ''));
      const me = await api('/auth/me');
      if (e !== epoch.current || frozen.scope !== currentScope.current || abort.signal.aborted) return;
      if (!fresh.can_read || !fresh.available || `${me.user?.tenant_id}:${me.user?.id}:${me.user?.role}` !== contextKey.split(':').slice(0, 3).join(':')) throw new ApiError('Zmieniła się firma lub dostęp do eksportu.', 403);
      if (!retry && latestExternalBlock.current) throw Error('Nowe odczyty eksportu są chwilowo zablokowane. Nie wysłano pobrania.');
      if (frozen.catalog_id && !fresh.catalog_available) throw Error('Kopia nie obsługuje wybranego katalogu. Nie pobrano pliku.');
      const fileAttempt: ReadAttempt = retry ? readAttempt! : { kind: 'file', body, review: frozen, contextKey, workspaceId };
      retainedReads.set(contextKey, fileAttempt); setReadAttempt(fileAttempt); setCatalogExportReadLocked(contextKey, true);
      const response = await fetch('/api/catalog/exports/file', {
        method: 'POST',
        body,
        credentials: 'same-origin',
        headers: { 'X-Workspace-ID': workspaceId, 'Content-Type': 'application/json' },
        signal: abort.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        let message = `Eksport nie został pobrany (HTTP ${response.status}).`;
        let code: string | undefined;
        try {
          const data = await response.json();
          if (typeof data.detail === 'string') message = data.detail;
          if (typeof data.code === 'string') code = data.code;
        } catch {}
        if (e !== epoch.current || frozen.scope !== currentScope.current || abort.signal.aborted)
          return;
        if (code === 'MFA_REQUIRED')
          window.dispatchEvent(
            new CustomEvent('dyna:mfa-required', { detail: { workspace: workspaceId } }),
          );
        throw new ApiError(message, response.status, code);
      }
      const mime = response.headers.get('content-type') ?? '';
      if (frozen.catalog_id && (response.headers.get('X-Product-Catalog-ID') !== frozen.catalog_id || response.headers.get('X-Product-Catalog-Version') !== frozen.catalog_version || response.headers.get('X-Catalog-Export-Scope-Hash') !== frozen.scope_hash)) throw Error('Plik nie potwierdza sprawdzonego zakresu katalogu. Zachowano dokładną próbę odczytu.');
      if (!mime.toLowerCase().includes(frozen.format === 'csv' ? 'text/csv' : 'application/xml'))
        throw Error('Serwer nie zwrócił wybranego formatu. Plik nie został zapisany.');
      const blob = await response.blob();
      if (e !== epoch.current || frozen.scope !== currentScope.current || abort.signal.aborted)
        return;
      if (blob.size > options.limits.file_bytes)
        throw Error(
          'Plik przekracza limit 64 MiB. Zawęź filtry lub wybierz mniej pól; plik nie został zapisany.',
        );
      if (frozen.catalog_id && (!/^[0-9]+$/.test(response.headers.get('Content-Length') ?? '') || Number(response.headers.get('Content-Length')) !== blob.size)) throw Error('Nie odebrano całego pliku. Zachowano dokładną próbę odczytu.');
      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = frozen.format === 'csv' ? 'catalog.csv' : 'catalog.xml';
      document.body.appendChild(a);
      a.click();
      a.remove();
      retainedReads.delete(contextKey); setReadAttempt(null); setCatalogExportReadLocked(contextKey, false);
      setStatus(
        'Plik przekazano do pobrania w przeglądarce. Eksport odczytuje bieżący katalog i nie zmienia produktów.',
      );
      setConsent(false);
    } catch (err) {
      if (e !== epoch.current || abort.signal.aborted) return;
      const message =
        err instanceof TypeError
          ? 'Pobieranie zostało przerwane. Nie zapisano częściowego pliku. Ponów ręcznie dokładny odczyt; to nowy odczyt danych, a nie drugi zapis produktów.'
          : err instanceof Error
            ? err.message
            : 'Nie udało się pobrać całego pliku. Ponów ręcznie.';
      setError(message);
      onError?.(message);
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) { retainedReads.delete(contextKey); setReadAttempt(null); setCatalogExportReadLocked(contextKey, false); setReview(null); setConsent(false); }
      if (err instanceof ApiError && [401, 403].includes(err.status)) {
        setBlocked(true);
        setOptions(null);
        setColumns([]);
        setReview(null);
        setConsent(false);
      }
    } finally {
      if (objectUrl) {
        const url = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (e === epoch.current) {
        busyRef.current = false;
        controller.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <section className="catalog-export panel" aria-label="Eksport katalogu">
      <header className="ce-heading">
        <div>
          <h2>Eksport katalogu</h2>
          <p>Wybierz zawartość pliku i sprawdź zakres przed pobraniem.</p>
        </div>
        {onClose && (
          <button
            type="button"
            className="button"
            onClick={() => {
              controller.current?.abort();
              onClose();
            }}
          >
            Zamknij eksport
          </button>
        )}
      </header>
      {error && (
        <p className="ce-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="ce-status" role="status">
          {status}
        </p>
      )}
      {loading && <p role="status">Odczytywanie dostępnych pól eksportu…</p>}
      {readAttempt && <div className="ce-hint" role="status"><p>Nie potwierdzono pełnego {readAttempt.kind === 'preview' ? 'podglądu' : 'pobrania'}. Zachowano dokładny zakres odczytu w pamięci tego aktora, także po zamknięciu panelu. Ponowienie odczytu może zwrócić aktualne dane; nie zmienia produktów i nie zapewnia jednego pobrania pliku.</p><button type="button" className="button" disabled={busy || !readable || catalogLoading} onClick={() => void (readAttempt.kind === 'preview' ? prepare(true) : download(true))}>Ponów dokładny odczyt eksportu</button></div>}
      {!loading && options && !options.available && (
        <p>Eksport katalogu nie jest dostępny w tej kopii aplikacji.</p>
      )}
      {!loading && options?.available && !options.can_read && (
        <p>Twoje bieżące uprawnienia nie pozwalają eksportować katalogu.</p>
      )}
      {(readOnly || options?.read_only) && (
        <p className="ce-hint">Tryb tylko do odczytu. Eksport pozostaje odczytem katalogu.</p>
      )}
      {readable && options && (
        <>
          <CatalogExportProfiles
            workspaceId={workspaceId}
            contextKey={contextKey}
            readOnly={readOnly}
            definition={{
              format,
              columns,
              headers: Object.fromEntries(
                columns
                  .filter((key) => headers[key]?.trim())
                  .map((key) => [key, headers[key].trim()]),
              ),
              spreadsheet_safe: safe,
              ...(options.catalog_available && catalogId ? { catalog_id: catalogId } : {}),
              ...(columns.includes('inventory_json') ? { warehouse_ids: warehouseIds } : {}),
              ...(columns.includes('prices_json') ? { price_list_ids: priceListIds } : {}),
            }}
            columns={options.columns}
            warehouses={options.sources?.warehouses.data}
            price_lists={options.sources?.price_lists.data}
            catalogs={options.catalogs}
            catalogRequired={Boolean(options.catalog_available)}
            externalWriteBlocked={Boolean(readAttempt) || busy || externalWriteBlocked}
            onError={onError}
            onApply={(definition, profile) => {
              controller.current?.abort();
              setFormat(definition.format);
              setColumns([...definition.columns]);
              setHeaders({ ...definition.headers });
              setSafe(definition.spreadsheet_safe);
              setCatalogId(definition.catalog_id ?? '');
              setWarehouseIds([...(definition.warehouse_ids ?? [])]);
              setPriceListIds([...(definition.price_list_ids ?? [])]);
              setReview(null);
              setConsent(false);
              setAppliedProfile(`${profile.name} · wersja ${profile.version}`);
            }}
          />
          {appliedProfile && (
            <p className="ce-hint">
              Skopiowano ustawienia profilu: {appliedProfile}. Możesz je teraz dostosować.
            </p>
          )}
          <fieldset disabled={configurationLocked} className="ce-settings">
            <legend>Format i zakres</legend>
            {options.catalog_available ? <label>Katalog do eksportu<select aria-label="Katalog do eksportu" value={catalogId} onChange={(e) => { setCatalogId(e.target.value); setWarehouseIds([]); setPriceListIds([]); setAppliedProfile(''); setReview(null); setConsent(false); }}><option value="">Wybierz katalog</option>{options.catalogs?.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' · domyślny' : ''}{!c.active ? ' · nieaktywny' : ''}</option>)}</select><small>{chosenCatalog && !chosenCatalog.active ? 'Katalog jest nieaktywny. Możesz sprawdzić jego przypisania; eksport wymaga aktywnego katalogu.' : 'Eksport obejmie wyłącznie produkty oraz przypisane magazyny i cenniki tego katalogu.'}</small></label> : <p>Ta kopia nie obsługuje eksportu osobnego katalogu. Zakres obejmuje produkty całej firmy zgodnie z filtrami lub zaznaczeniem.</p>}
            {catalogLoading && <p role="status">Odczytywanie przypisań wybranego katalogu…</p>}
            <label>
              Format pliku
              <select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
                {options.formats.map((f) => (
                  <option key={f} value={f}>
                    {f === 'csv' ? 'CSV' : 'XML'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Produkty do eksportu
              <select value={selection} onChange={(e) => setSelection(e.target.value as Selection)}>
                <option value="filtered">Według wyszukiwania i aktywności</option>
                <option value="selected">Zaznaczone produkty · {uniqueIds.length}</option>
              </select>
            </label>
            {selection === 'filtered' && (
              <>
                <label>
                  Szukaj w katalogu
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Nazwa lub SKU"
                  />
                </label>
                <label>
                  Aktywność produktów
                  <select value={active} onChange={(e) => setActive(e.target.value as Active)}>
                    {(['all', 'yes', 'no'] as Active[]).map((v) => (
                      <option value={v} key={v}>
                        {activeLabels[v]}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {format === 'csv' && (
              <label className="ce-wide">
                Przeznaczenie CSV
                <select
                  value={safe ? 'sheet' : 'exchange'}
                  onChange={(e) => setSafe(e.target.value === 'sheet')}
                >
                  <option value="sheet">Do arkusza — ochrona tekstu</option>
                  <option value="exchange">Do wymiany danych — dokładne wartości</option>
                </select>
              </label>
            )}
          </fieldset>
          {format === 'csv' && (
            <p className="ce-hint">
              {safe
                ? 'Wariant do arkusza dodaje apostrof przed identyfikatorami, SKU i EAN oraz tekstem wymagającym ochrony przed formułami. To celowo zmieniony zapis tekstu. Przy imporcie CSV wybierz dla EAN i SKU typ „Tekst”; zwykłe otwarcie pliku w arkuszu nie gwarantuje zachowania zer.'
                : 'Wariant do wymiany zachowuje dokładne wartości tekstowe. W arkuszu importuj EAN i SKU jako tekst; treści zaczynające się jak formuły wymagają ostrożnego importu.'}
            </p>
          )}
          <p className="ce-hint">
            Eksport obejmuje bieżące wartości katalogu. Dane złożone trafiają do osobnych pól; plik
            nie zawiera samych zdjęć. To nie jest pełna kopia zapasowa aplikacji.
          </p>
          <p className="ce-hint">
            Cena bazowa brutto pochodzi z katalogu w walucie {options.catalog_currency}; kwota 12345
            oznacza 123,45 {options.catalog_currency}. Bez przeliczeń walut. Ceny wybranych cenników
            są osobnym polem eksportu. Brak wartości pozostaje pustą komórką CSV lub oznaczonym
            brakiem w XML, a nie zerem. Powiązania wariantów i składników nie dodają osobnych
            produktów do wybranego zakresu.
          </p>
          {options.product_logistics_available === false && (
            <p className="ce-hint">
              Ta kopia nie obsługuje masy, wymiarów i producenta. Puste wartości tych pól nie
              oznaczają wykonanych pomiarów.
            </p>
          )}
          {options.product_translations_available === false && (
            <p className="ce-hint">
              Wersje językowe nie są dostępne w tej kopii; ich pole nie zawiera tłumaczeń.
            </p>
          )}
          <fieldset disabled={configurationLocked} className="ce-fields">
            <legend>Pola w pliku · {columns.length}</legend>
            <div className="ce-column-grid">
              {options.columns.map((c) => (
                <label key={c.key} className="ce-column">
                  <input
                    type="checkbox"
                    checked={columns.includes(c.key)}
                    onChange={() => toggleColumn(c.key)}
                  />
                  <span>
                    {c.label}
                    <small>
                      {typeLabels[c.type]}
                      {c.unit
                        ? ` · ${c.unit === 'minor' ? '1/100 ' + options.catalog_currency : c.unit === 'percent' ? '%' : c.unit}`
                        : ''}
                    </small>
                  </span>
                </label>
              ))}
            </div>
            <details>
              <summary>Kolejność i nazwy pól w pliku</summary>
              <ol className="ce-order">
                {columns.map((key, i) => (
                  <li key={key}>
                    <span>{options.columns.find((c) => c.key === key)?.label ?? key}</span>
                    <label>
                      Nazwa pola {options.columns.find((c) => c.key === key)?.label ?? key}
                      <input
                        value={headers[key] ?? ''}
                        maxLength={160}
                        placeholder={key}
                        onChange={(e) => setHeaders((prev) => ({ ...prev, [key]: e.target.value }))}
                      />
                    </label>
                    <button
                      type="button"
                      className="button"
                      disabled={i === 0}
                      aria-label={`Przesuń ${options.columns.find((c) => c.key === key)?.label ?? key} wcześniej`}
                      onClick={() => moveColumn(i, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={i === columns.length - 1}
                      aria-label={`Przesuń ${options.columns.find((c) => c.key === key)?.label ?? key} później`}
                      onClick={() => moveColumn(i, 1)}
                    >
                      ↓
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          </fieldset>
          {options.sources && (
            <CatalogExportSources
              warehouses={options.sources.warehouses.data.filter((w) => !options.catalog_available || chosenCatalog?.warehouse_ids.includes(w.id))}
              price_lists={options.sources.price_lists.data.filter((p) => !options.catalog_available || chosenCatalog?.price_list_ids.includes(p.id))}
              warehouse_ids={warehouseIds}
              price_list_ids={priceListIds}
              inventorySelected={columns.includes('inventory_json')}
              pricesSelected={columns.includes('prices_json')}
              allowInventory={options.sources.allow_inventory}
              available={{
                inventory: options.sources.warehouses.available,
                prices: options.sources.price_lists.available,
              }}
              capped={{
                warehouses: options.sources.warehouses.capped,
                price_lists: options.sources.price_lists.capped,
              }}
              disabled={configurationLocked || catalogLoading || !catalogReady}
              onChange={(next) => {
                setWarehouseIds(next.warehouse_ids);
                setPriceListIds(next.price_list_ids);
              }}
            />
          )}
          <p>
            {selection === 'selected'
              ? `Zaznaczone produkty: ${uniqueIds.length}. Limit: ${options.limits.selected_products}.`
              : review?.scope === scope
                ? `Przy sprawdzeniu zakresu znaleziono ${review.matched_products} produktów. Przy pobraniu zostaną odczytane aktualne dane.`
                : `Zakres według filtrów, maksymalnie ${options.limits.products.toLocaleString('pl-PL')} produktów. Dokładna liczba nie została odczytana.`}
          </p>
          <p>
            Maksymalny plik: {(options.limits.file_bytes / 1048576).toLocaleString('pl-PL')} MiB.
            Przekroczenie limitu lub przerwanie pobierania nie zapisuje częściowego pliku.
          </p>
          <button type="button" className="button" disabled={configurationLocked || catalogLoading || !catalogReady} onClick={() => void prepare()}>
            Sprawdź zakres eksportu
          </button>
          {review && review.scope === scope && (
            <div className="ce-review">
              <h3>Zakres do pobrania</h3>
              <dl>
                {review.catalog_id && <><dt>Katalog</dt><dd>{review.catalog_name} · sprawdzona wersja {review.catalog_version}</dd></>}
                <dt>Plik</dt>
                <dd>
                  {review.format.toUpperCase()}
                  {review.format === 'csv'
                    ? review.spreadsheet_safe
                      ? ' do arkusza'
                      : ' do wymiany danych'
                    : ''}
                </dd>
                <dt>Produkty</dt>
                <dd>
                  {review.selection === 'selected'
                    ? `Zaznaczone produkty: ${review.ids.length}`
                    : `${review.matched_products} produktów przy odczycie zakresu. Wyszukiwanie: ${review.search || 'bez ograniczenia'}; aktywność: ${activeLabels[review.active]}`}
                </dd>
                <dt>Pola</dt>
                <dd>
                  {review.columns
                    .map((key) => options.columns.find((c) => c.key === key)?.label ?? key)
                    .join(', ')}
                </dd>
              </dl>
              {review.sample && (
                <div className="ce-source-sample">
                  <h4>Próbka stanów i cen · do 3 produktów</h4>
                  <p>
                    Próbka i pobranie pliku to osobne spójne odczyty. Zapas ani cena nie są
                    rezerwowane. Kwoty w najmniejszych jednostkach wskazanej waluty.
                  </p>
                  {!review.sample.length && <p>Brak produktów w tym zakresie.</p>}
                  {review.sample.map((row) => (
                    <section key={row.product_id}>
                      <h5>
                        {row.sku} · {row.name}
                      </h5>
                      {row.inventory_json && (
                        <div className="ce-sample-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Magazyn</th>
                                <th>Stan</th>
                                <th>Rezerwacje</th>
                                <th>Dostępne</th>
                                <th>Źródło / status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.inventory_json.map((w, i) => (
                                <tr key={i}>
                                  <td>{String(w.warehouse_name)}</td>
                                  <td>{w.on_hand == null ? '—' : String(w.on_hand)}</td>
                                  <td>{w.reserved == null ? '—' : String(w.reserved)}</td>
                                  <td>{w.available == null ? '—' : String(w.available)}</td>
                                  <td>
                                    {sourceLabel(w.source)} / {statusLabel(w.status)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {row.prices_json && (
                        <div className="ce-sample-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Cennik</th>
                                <th>Własna cena</th>
                                <th>Cena wynikowa</th>
                                <th>Waluta</th>
                                <th>Źródło / status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {row.prices_json.map((l, i) => (
                                <tr key={i}>
                                  <td>{String(l.price_list_name)}</td>
                                  <td>
                                    {l.own_price_minor == null ? '—' : String(l.own_price_minor)}
                                  </td>
                                  <td>
                                    {l.effective_price_minor == null
                                      ? '—'
                                      : String(l.effective_price_minor)}
                                  </td>
                                  <td>{String(l.currency)}</td>
                                  <td>
                                    {sourceLabel(l.source)} / {statusLabel(l.status)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                  ))}
                </div>
              )}
              <p>
                Przy pobraniu zostaną odczytane aktualne dane. Zmiana zakresu wymaga ponownego
                sprawdzenia i zgody.
              </p>
              <label className="ce-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={configurationLocked}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Potwierdzam eksport wskazanego zakresu do pliku.
              </label>
              <button
                type="button"
                className="button primary"
                disabled={configurationLocked || !consent}
                onClick={() => void download()}
              >
                {busy ? 'Pobieranie całego pliku…' : 'Pobierz plik'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
