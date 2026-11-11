import { OdooCatalogSync } from './odoo-catalog-sync';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date, money } from './api';
import { productCatalogsWriteLocked, type ProductCatalog } from './product-catalogs';
import { kinds } from './catalog';
import { ShopifyOfferLocation } from './shopify-offers';
const states: Record<string, string> = {
  queued: 'Pobieranie',
  ready: 'Podgląd gotowy',
  failed: 'Błąd pobierania',
  cancelled: 'Anulowano',
};
const cents = (s: string) => {
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw Error('Cena wymaga najwyżej dwóch miejsc po przecinku');
  const [whole, fraction = ''] = s.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};
type FrozenSourceApply = { contextKey: string; channelId: string; runId: string; catalogId: string; body: string };
const rememberedApplies = new Map<string, FrozenSourceApply>();
let sourceActorContext = '';
export function resetCatalogSourceContext(contextKey: string) {
  if (sourceActorContext === contextKey) return;
  sourceActorContext = contextKey; rememberedApplies.clear();
}
export function CatalogSourcePanel({ channelId, contextKey = '', readOnly = false, externalWriteBlocked = false }: { channelId: string; contextKey?: string; readOnly?: boolean; externalWriteBlocked?: boolean }) {
  const [index, setIndex] = useState<any>(null),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [runId, setRunId] = useState(''),
    [data, setData] = useState<any>(null),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [kind, setKind] = useState(''),
    [state, setState] = useState(''),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [after, setAfter] = useState(''),
    [back, setBack] = useState<string[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [drafts, setDrafts] = useState<Record<string, any>>({});
  const [catalogs, setCatalogs] = useState<ProductCatalog[]>([]), [catalogId, setCatalogId] = useState(''), [catalogAvailable, setCatalogAvailable] = useState(false), [catalogRead, setCatalogRead] = useState(false), [catalogWritable, setCatalogWritable] = useState(false), [applyAttempt, setApplyAttempt] = useState<FrozenSourceApply | null>(null);
  const memoryKey = contextKey + ':' + channelId;
  const scope = contextKey + ':' + readOnly + ':' + channelId + ':' + catalogId + ':' + runId;
  const scopeRef = useRef(scope), alive = useRef(false), generation = useRef(0);
  scopeRef.current = scope;
  const latestWriteBlock = useRef({ readOnly, externalWriteBlocked });
  latestWriteBlock.current = { readOnly, externalWriteBlocked };
  const key = useRef(crypto.randomUUID());
  const freshBlocked = busy || readOnly || externalWriteBlocked || Boolean(applyAttempt) || productCatalogsWriteLocked(contextKey);
  const chosenCatalog = catalogs.find((c) => c.id === catalogId && c.active);
  const allowedWarehouses = catalogAvailable ? warehouses.filter((w) => chosenCatalog?.settings.warehouse_ids.includes(w.id)) : warehouses;
  const canApply = Boolean(catalogRead && (!catalogAvailable || (catalogWritable && chosenCatalog && data?.catalog_id === catalogId && chosenCatalog.settings.warehouse_ids.includes(data?.run.warehouse_id))));
  useEffect(() => {
    alive.current = true; generation.current++; resetCatalogSourceContext(contextKey);
    if (readOnly) rememberedApplies.delete(memoryKey);
    setIndex(null); setData(null); setCatalogs([]); setCatalogId(''); setCatalogAvailable(false); setCatalogRead(false); setRunId(''); setSelected([]); setDrafts({}); setAfter(''); setBack([]); setNotice(''); setError(''); setBusy(false);
    const remembered = rememberedApplies.get(memoryKey) ?? null; setApplyAttempt(remembered); if (remembered) { setCatalogId(remembered.catalogId); setRunId(remembered.runId); }
    return () => { alive.current = false; generation.current++; };
  }, [contextKey, readOnly, channelId]);
  useEffect(() => {
    let active = true;
    api('/product-catalogs/options').then((d) => {
      if (!active) return;
      if (typeof d.available !== 'boolean' || typeof d.can_read !== 'boolean' || (d.available && (!d.can_read || !Array.isArray(d.catalogs)))) throw Error('Niepełny odczyt katalogów importu źródłowego.');
      setCatalogAvailable(d.available); setCatalogs(d.catalogs ?? []); setCatalogWritable(Boolean(d.can_manage && !d.read_only)); setCatalogRead(true);
    }).catch((e) => { if (active) { setCatalogRead(false); setError(e.message); } });
    return () => { active = false; };
  }, [contextKey, readOnly, channelId, refresh]);
  useEffect(() => {
    let active = true;
    Promise.all([api(`/integrations/${channelId}/catalog-source-runs`), api('/warehouses')])
      .then(([i, w]) => {
        if (active) {
          setIndex(i);
          setWarehouses(w.data);
          if (i.data[0]) setRunId((old) => old || i.data[0].id);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [channelId, refresh, contextKey, readOnly]);
  const path = runId && catalogRead && (!catalogAvailable || catalogId)
    ? `/catalog-source-runs/${runId}?limit=25&search=${encodeURIComponent(query)}${kind ? '&kind=' + kind : ''}${state ? '&state=' + state : ''}${after ? '&after=' + after : ''}${catalogAvailable ? '&catalog_id=' + encodeURIComponent(catalogId) : ''}`
    : '';
  useEffect(() => {
    setData(null);
    if (!path) return;
    let active = true;
    api(path)
      .then((d) => {
        if (active) {
          if (catalogAvailable && d.catalog_id !== catalogId) throw Error('Podgląd nie odpowiada wybranemu katalogowi.');
          setData(d);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [path, refresh, contextKey, readOnly]);
  useEffect(() => {
    if (data?.run.state !== 'queued' || busy) return;
    const t = setInterval(() => setRefresh((v) => v + 1), 1500);
    return () => clearInterval(t);
  }, [data?.run.state, busy]);
  useEffect(() => {
    setSelected([]);
    setDrafts({});
  }, [path]);
  const reset = () => {
    setAfter('');
    setBack([]);
    setSelected([]);
    setDrafts({});
  };
  const update = (id: string, patch: any) =>
    setDrafts((v) => ({ ...v, [id]: { ...v[id], ...patch } }));
  async function act(fn: () => Promise<void>) {
    if (freshBlocked) return;
    const captured = scope, g = generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      if (alive.current && scopeRef.current === captured && generation.current === g) setRefresh((v) => v + 1);
    } catch (e: any) {
      if (alive.current && scopeRef.current === captured && generation.current === g) setError(e.message);
    } finally {
      if (alive.current && generation.current === g) setBusy(false);
    }
  }
  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const captured = scope;
    if (!catalogRead || (catalogAvailable && (!chosenCatalog || !catalogWritable || !chosenCatalog.settings.warehouse_ids.includes(String(f.get('warehouse')))))) { setError('Wybierz aktywny katalog i przypisany do niego magazyn.'); return; }
    await act(async () => {
      const r = await api(`/integrations/${channelId}/catalog-source-runs`, 'POST', {
        client_key: key.current,
        warehouse_id: f.get('warehouse'),
        vat: Number(f.get('vat')),
        import_stock: f.get('import_stock') === 'on',
      });
      if (!alive.current || scopeRef.current !== captured) return;
      setRunId(r.id);
      setData(null);
      reset();
      key.current = crypto.randomUUID();
      setNotice('Pobieramy katalog do podglądu. Produkty powstaną dopiero po zatwierdzeniu.');
    });
  }
  async function apply(retry = false) {
    if (busy || readOnly || (retry ? !applyAttempt : freshBlocked || !canApply)) return;
    const captured = scope, g = generation.current;
    setBusy(true); setError(''); setNotice(''); let sent = false;
    let attempt = retry ? applyAttempt : null;
    try {
      const access = await api('/product-catalogs/options');
      if (!alive.current || generation.current !== g || scopeRef.current !== captured) return;
      if (retry && attempt && JSON.parse(attempt.body).items.some((v: any) => v.catalog_id) && !access.available) throw Error('Moduł katalogów jest niedostępny. Zachowano dokładną próbę; zapis nie został wysłany.');
      if (access.available && (!access.can_manage || access.read_only || (contextKey && access.current_role !== contextKey.split(':')[2]))) throw new ApiError('Brak bieżącego prawa importu katalogu.', access.read_only ? 423 : 403);
      if (contextKey) { const me = await api('/auth/me'); if (me.user?.role !== 'admin' || `${me.user?.tenant_id}:${me.user?.id}:${me.user?.role}` !== contextKey.split(':').slice(0, 3).join(':')) throw new ApiError('Zmienił się użytkownik lub firma importu.', 403); }
      if (!alive.current || generation.current !== g || scopeRef.current !== captured) return;
      if (!retry) {
      if (latestWriteBlock.current.readOnly || latestWriteBlock.current.externalWriteBlocked || productCatalogsWriteLocked(contextKey)) throw Error('Nowe zapisy są chwilowo zablokowane. Zatwierdzenie nie zostało wysłane.');
      if (catalogAvailable && (!access.available || !access.catalogs?.some((c: ProductCatalog) => c.id === catalogId && c.active && c.settings.warehouse_ids.includes(data.run.warehouse_id)))) throw Error('Katalog lub jego magazyny zmieniły się. Odczytaj podgląd ponownie.');
      const rows = data.data.filter((r: any) => selected.includes(r.id));
      const items = rows.map((r: any) => {
        const n = r.source,
          d = drafts[r.id] ?? {},
          sku = d.sku ?? n.sku;
        if (d.catalogConflict) throw Error('SKU należy do innego katalogu. Wybierz inny lokalny kod.');
        if (sku !== n.sku && d.checkedSku !== sku)
          throw Error('Po zmianie symbolu użyj „Sprawdź SKU”');
        const candidate =
          d.checkedSku === sku
            ? d.candidate
            : r.candidate_id
              ? { id: r.candidate_id, version: r.candidate_version }
              : null;
        const price =
          d.price ??
          (data.currency === n.currency && n.price !== null ? String(n.price / 100) : '');
        const quantity = d.quantity ?? (n.quantity === null ? '' : String(n.quantity));
        return {
          id: r.id,
          ...(catalogAvailable && r.state === 'staged' ? { catalog_id: catalogId } : {}),
          source_hash: r.source_hash,
          local_sku: sku,
          expected_product_id: candidate?.id ?? null,
          expected_version: candidate?.version ?? null,
          ...(!candidate && r.kind !== 'group' && price !== ''
            ? { price_override: cents(price) }
            : {}),
          ...(!candidate && r.kind !== 'group' && data.run.import_stock && quantity !== ''
            ? { quantity_override: Number(quantity) }
            : {}),
        };
      });
      attempt = { contextKey, channelId, runId, catalogId, body: JSON.stringify({ items }) };
      }
      if (!attempt || attempt.contextKey !== contextKey || attempt.channelId !== channelId) throw Error('Niezgodna zachowana próba importu.');
      rememberedApplies.set(memoryKey, attempt); setApplyAttempt(attempt); sent = true;
      const result = await api(`/catalog-source-runs/${attempt.runId}/apply`, 'POST', JSON.parse(attempt.body));
      if (sourceActorContext !== contextKey) return;
      const requested = JSON.parse(attempt.body).items;
      if (!Array.isArray(result.data) || result.data.length !== requested.length || new Set(result.data.map((r: any) => r.entry_id)).size !== requested.length || result.data.some((r: any) => {
        const input = requested.find((v: any) => v.id === r.entry_id);
        return !input || typeof r.product_id !== 'string' || !['created', 'linked'].includes(r.action) || (r.reused !== undefined && typeof r.reused !== 'boolean') || (input.expected_product_id !== null && (r.action !== 'linked' || r.product_id !== input.expected_product_id));
      }) || !Number.isSafeInteger(result.created) || result.created < 0 || !Number.isSafeInteger(result.linked) || result.linked < 0 || result.created !== result.data.filter((r: any) => r.action === 'created' && !r.reused).length || result.linked !== result.data.filter((r: any) => r.action === 'linked' && !r.reused).length) throw Error('Niepełny wynik zatwierdzenia. Zachowano dokładną próbę.');
      rememberedApplies.delete(memoryKey);
      if (!alive.current || generation.current !== g || scopeRef.current !== captured) return;
      setApplyAttempt(null);
      setSelected([]);
      setDrafts({});
      setNotice(
        `Utworzono ${result.created}; powiązano ${result.linked}. Istniejące ceny i stany zachowane.`,
      );
      setRefresh((v) => v + 1);
    } catch (e: any) {
      if (sourceActorContext === contextKey && e instanceof ApiError && [401, 403].includes(e.status)) rememberedApplies.delete(memoryKey);
      else if (sent && e instanceof ApiError && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) rememberedApplies.delete(memoryKey);
      if (alive.current && generation.current === g && scopeRef.current === captured) { setApplyAttempt(rememberedApplies.get(memoryKey) ?? null); setError(e.message); if (e instanceof ApiError && [401, 403].includes(e.status)) { setData(null); setDrafts({}); setSelected([]); setCatalogs([]); setCatalogRead(false); } }
    } finally { if (alive.current && generation.current === g) setBusy(false); }
  }
  if (!index || sourceActorContext !== contextKey) return <p>{error || 'Wczytywanie importu katalogu…'}</p>;
  return (
    <section className="catalog-source-panel">
      <p className="notice">
        {index.channel.settings.simulation
          ? 'PRZYKŁAD LOKALNY — katalog i warianty są syntetyczne; bez żądań do dostawcy.'
          : 'Pobieramy katalog przez API tylko do odczytu. Zatwierdzenie zapisuje produkty i powiązania w tej firmie.'}
      </p>
      {error && (
        <p role="alert" className="error-block">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {catalogAvailable && <label>Katalog nowych produktów<select aria-label="Katalog nowych produktów" value={catalogId} disabled={busy || Boolean(applyAttempt)} onChange={(e) => { setCatalogId(e.target.value); setData(null); reset(); }}><option value="">Wybierz aktywny katalog</option>{catalogs.filter((c) => c.active || c.id === applyAttempt?.catalogId).map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' · domyślny' : ''}{!c.active ? ' · nieaktywny' : ''}</option>)}</select><small>Wybrany katalog musi obejmować magazyn tego przeglądu. SKU nadal jest unikalne w firmie.</small></label>}
      {applyAttempt && <div className="notice" role="status"><p>Wynik zatwierdzenia jest niepewny. Zachowano dokładną listę pozycji, katalog i ustawienia; odczyt nie tworzy nowej próby.</p><button type="button" className="button" disabled={busy || readOnly || (catalogAvailable && !catalogWritable)} onClick={() => void apply(true)}>Ponów dokładne zatwierdzenie źródła</button></div>}
      <fieldset disabled={freshBlocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {index.channel.provider === 'odoo' && <OdooCatalogSync channelId={channelId} />}
      {index.channel.provider === 'shopify' && (
        <>
          <ShopifyOfferLocation
            purpose="catalog"
            channelId={channelId}
            onChange={() => {
              key.current = crypto.randomUUID();
              setRefresh((v) => v + 1);
            }}
          />
          <p className="muted">
            Import stanu wymaga wybranej lokalizacji Shopify. Przyjmujemy jej ilość dostępną jako
            stan początkowy nowych SKU. Sprawdź oczekujące zamówienia: ich późniejszy import tworzy
            osobne rezerwacje. Stan aktywny produktu nie potwierdza publikacji w kanale sprzedaży.
          </p>
        </>
      )}
      <form className="form-grid" onSubmit={start}>
        <label>
          Magazyn nowych SKU
          <select name="warehouse">
            <option value="">Wybierz magazyn</option>
            {allowedWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          VAT nowych produktów (%)
          <select name="vat" defaultValue="23">
            {[23, 8, 5, 0].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {!['odoo', 'ebay', 'amazon'].includes(index.channel.provider) && (
          <label className="inline-check">
            <input type="checkbox" name="import_stock" />
            Przyjmij stan źródłowy tylko dla nowych SKU
          </label>
        )}
        <button className="button primary" disabled={freshBlocked || !catalogRead || !allowedWarehouses.length || (catalogAvailable && (!chosenCatalog || !catalogWritable))}>
          Pobierz katalog do podglądu
        </button>
      </form>
      </fieldset>
      <p className="muted">
        {index.channel.provider === 'amazon'
          ? 'Amazon: raport wszystkich ofert i bieżące dane Listings API. Warianty są wiązane według SKU sprzedawcy. Cena B2C, VAT lokalny, bez przeliczania walut. Dostępność FBM i FBA pozostaje informacją zewnętrzną; nowe produkty mają stan fizyczny zero. Istniejące SKU zachowują dane, ceny i rezerwacje. Import nie publikuje ani nie zmienia ofert Amazon.'
          : index.channel.provider === 'ebay'
            ? 'eBay Inventory: dostępność źródłowa pozostaje informacją zewnętrzną; nowe SKU mają fizyczny stan zero. Oferty są pobierane dla wybranego marketplace. Cena FIXED_PRICE według jawnego trybu netto/brutto; aukcje i brak jednoznacznej ceny wymagają ceny lokalnej. VAT lokalny, bez FX. Katalog obejmuje zasoby Inventory API; oferty starszego Trading API wymagają osobnej integracji. Istniejące SKU zachowują dane, ceny i rezerwacje.'
            : index.channel.provider === 'odoo'
              ? 'Odoo: dostępność wybranego magazynu ERP jest informacją zewnętrzną. Nowe SKU mają fizyczny stan zero; towar przyjmij dokumentem magazynowym. Wybierz lokalny VAT i sprawdź konfigurację cen netto/brutto. Jednostka musi odpowiadać sztukom. Podatki ERP nie są kopiowane. Główne zdjęcie pobierzesz osobno w karcie powiązanego produktu. Istniejące SKU zachowują dane i rezerwacje.'
              : 'Sprawdź VAT sklepu. Cena netto jest przeliczana na brutto wybraną stawką. Shopify używa bieżącej ceny wariantu, a WooCommerce ceny regularnej. Bez przyjęcia stanów nowe SKU zaczynają od zera. Istniejące SKU zachowują dane i rezerwacje.'}
      </p>
      <label>
        Przegląd katalogu
        <select
          value={runId}
          disabled={busy || Boolean(applyAttempt)}
          onChange={(e) => {
            setRunId(e.target.value);
            setData(null);
            reset();
          }}
        >
          <option value="">Wybierz przegląd</option>
          {index.data.map((r: any) => (
            <option key={r.id} value={r.id}>
              {date(r.created_at)} · {states[r.state]} · {r.fetched} pozycji
            </option>
          ))}
        </select>
      </label>
      {data && (
        <>
          {catalogAvailable && !canApply && <p role="alert">Magazyn tego przeglądu nie jest przypisany do wybranego aktywnego katalogu. Wybierz zgodny katalog albo przygotuj nowy przegląd we właściwym magazynie.</p>}
          <div className="toolbar">
            <strong>
              {states[data.run.state]} · {data.run.fetched} pozycji
            </strong>
            {data.run.context && (
              <span>
                Źródło: {data.run.context.currency ?? data.run.context.marketplace_id} · ceny{' '}
                {data.run.context.prices_include_tax ? 'brutto' : 'netto'} · lokalnie{' '}
                {data.currency}
                {data.run.context.company_name && (
                  <small>
                    Firma ERP: {data.run.context.company_name} · magazyn:{' '}
                    {data.run.context.warehouse_name} · jednostka: {data.run.context.unit_name}
                  </small>
                )}
              </span>
            )}
            <button className="button" disabled={busy} onClick={() => setRefresh((v) => v + 1)}>
              Odśwież przegląd katalogu
            </button>
            {data.run.state === 'failed' && (
              <button
                className="button"
                disabled={freshBlocked}
                onClick={() =>
                  act(async () => {
                    await api(`/catalog-source-runs/${runId}/retry`, 'POST', {});
                    setNotice('Wznowiono od zapisanego miejsca.');
                  })
                }
              >
                Wznów pobieranie
              </button>
            )}
            {['queued', 'failed'].includes(data.run.state) && (
              <button
                className="button"
                disabled={freshBlocked}
                onClick={() =>
                  act(async () => {
                    await api(`/catalog-source-runs/${runId}/cancel`, 'POST', {});
                    setNotice('Pobieranie anulowano. Katalog lokalny bez zmian.');
                  })
                }
              >
                Anuluj pobieranie
              </button>
            )}
          </div>
          {data.run.error && <p role="alert">{data.run.error}</p>}
          <p>
            {data.counts
              .map(
                (r: any) =>
                  `${kinds[r.kind] ?? 'Nieobsługiwane'}: ${r.count} ${r.state === 'applied' ? 'zatwierdzonych' : 'w podglądzie'}`,
              )
              .join(' · ')}
          </p>
          <div className="toolbar">
            <input
              aria-label="Szukaj katalogu źródłowego"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              className="button"
              onClick={() => {
                setQuery(search);
                reset();
              }}
            >
              Szukaj w katalogu
            </button>
            <select
              aria-label="Typ katalogu źródłowego"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                reset();
              }}
            >
              <option value="">Wszystkie typy</option>
              {Object.entries({ ...kinds, unsupported: 'Nieobsługiwane' })
                .filter(([k]) => k !== 'bundle')
                .map(([k, n]) => (
                  <option key={k} value={k}>
                    {n}
                  </option>
                ))}
            </select>
            <select
              aria-label="Stan importu katalogu"
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                reset();
              }}
            >
              <option value="">Wszystkie pozycje</option>
              <option value="staged">Do zatwierdzenia</option>
              <option value="applied">Zatwierdzone</option>
            </select>
          </div>
          <p>
            Najpierw importuj grupę wariantów albo zaznacz ją z wariantami w tej samej partii.
            Podgląd pozycji jest ważny 24 godziny. Zmiana waluty wymaga jawnej ceny lokalnej dla
            nowych produktów.
          </p>
          <button
            className="button"
            disabled={freshBlocked || !canApply || data.run.state !== 'ready'}
            onClick={() =>
              setSelected(
                data.data
                  .filter((r: any) => r.state === 'staged' && !r.source.unsupported)
                  .map((r: any) => r.id),
              )
            }
          >
            Zaznacz dostępne na tej stronie
          </button>
          <div className="catalog-source-table">
            <table>
              <thead>
                <tr>
                  <th>Wybór / źródło</th>
                  <th>SKU lokalny</th>
                  <th>Cena źródłowa</th>
                  <th>
                    {index.channel.provider === 'amazon'
                      ? 'Dostępność Amazon FBM'
                      : index.channel.provider === 'ebay'
                        ? 'Dostępność eBay'
                        : index.channel.provider === 'odoo'
                          ? 'Dostępność ERP'
                          : 'Stan początkowy'}
                  </th>
                  <th>Wynik / uwagi</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((r: any) => {
                  const n = r.source,
                    d = drafts[r.id] ?? {},
                    sku = d.sku ?? n.sku,
                    candidate =
                      d.checkedSku === sku
                        ? d.candidate
                        : sku === n.sku && r.candidate_id
                          ? {
                              id: r.candidate_id,
                              version: r.candidate_version,
                              price: r.candidate_price,
                            }
                          : null;
                  return (
                    <tr key={r.id}>
                      <td>
                        <label className="inline-check">
                          <input
                            type="checkbox"
                            aria-label={`Wybierz katalog ${r.external_id}`}
                            disabled={
                              freshBlocked || !canApply ||
                              r.state === 'applied' ||
                              n.unsupported ||
                              data.run.state !== 'ready'
                            }
                            checked={selected.includes(r.id)}
                            onChange={(e) =>
                              setSelected((v) =>
                                e.target.checked ? [...v, r.id] : v.filter((id) => id !== r.id),
                              )
                            }
                          />
                          <strong>{n.name}</strong>
                        </label>
                        <small>
                          {kinds[r.kind] ?? 'Nieobsługiwane'} · ID{' '}
                          {r.kind === 'group' && n.ebay?.group_key
                            ? n.ebay.group_key
                            : r.external_id}
                          {r.parent_external_id
                            ? ' · rodzic ' + (n.ebay?.group_key ?? r.parent_external_id)
                            : ''}
                        </small>
                        <small>
                          VAT {n.vat}% · klasa {n.tax_class || 'standardowa'}
                        </small>
                      </td>
                      <td>
                        <input
                          aria-label={`SKU lokalny ${r.external_id}`}
                          maxLength={80}
                          value={sku}
                          disabled={freshBlocked || r.state === 'applied'}
                          onChange={(e) =>
                            update(r.id, { sku: e.target.value, checkedSku: null, candidate: null, catalogConflict: false })
                          }
                        />
                        <button
                          className="text-button"
                          aria-label={`Sprawdź SKU ${r.external_id}`}
                          disabled={freshBlocked || !canApply || r.state === 'applied' || !sku || sku.length > 80}
                          onClick={() =>
                            act(async () => {
                              const captured = scope;
                              const v = await api(
                                `/catalog-source-runs/${runId}/candidate?sku=${encodeURIComponent(sku)}${catalogAvailable ? '&catalog_id=' + encodeURIComponent(catalogId) : ''}`,
                              );
                              if (alive.current && scopeRef.current === captured) update(r.id, { checkedSku: sku, candidate: v.product, catalogConflict: v.catalog_conflict === true });
                            })
                          }
                        >
                          Sprawdź SKU
                        </button>
                        <small>
                          {d.catalogConflict ? 'SKU należy do innego katalogu — zatwierdzenie zablokowane' : candidate
                            ? 'Istniejący produkt — powiązanie bez zmiany ceny i stanu'
                            : catalogAvailable && d.checkedSku !== sku ? 'Brak dopasowania w tej puli. Sprawdź SKU, aby rozstrzygnąć konflikt w firmie.' : 'Nowy produkt'}
                        </small>
                      </td>
                      <td>
                        <small>
                          Źródło:{' '}
                          {n.price === null
                            ? 'Brak poprawnej ceny'
                            : money(n.price, n.currency ?? data.currency)}
                          {n.ebay?.offers && (
                            <small>
                              {n.ebay.offers.length} ofert · {n.source_status} ·{' '}
                              {n.ebay.selected_offer_id ?? 'brak ceny FIXED_PRICE'}
                            </small>
                          )}
                        </small>
                        {r.kind !== 'group' && (
                          <input
                            aria-label={`Cena lokalna ${r.external_id} (${data.currency})`}
                            type="number"
                            min="0"
                            max="1000000"
                            step="0.01"
                            placeholder={data.currency}
                            disabled={freshBlocked || r.state === 'applied' || !!candidate}
                            value={
                              d.price ??
                              (data.currency === n.currency && n.price !== null
                                ? String(n.price / 100)
                                : '')
                            }
                            onChange={(e) => update(r.id, { price: e.target.value })}
                          />
                        )}
                      </td>
                      <td>
                        <small>
                          {index.channel.provider === 'amazon'
                            ? 'Amazon FBM (zewnętrzne):'
                            : index.channel.provider === 'ebay'
                              ? 'eBay (zewnętrzne):'
                              : index.channel.provider === 'odoo'
                                ? 'ERP (zewnętrzne):'
                                : 'Źródło:'}{' '}
                          {n.quantity ?? 'Nieznany'} szt.
                        </small>
                        {r.kind !== 'group' && (
                          <input
                            aria-label={`Stan początkowy ${r.external_id}`}
                            type="number"
                            min="0"
                            max="10000000"
                            step="1"
                            disabled={
                              freshBlocked || r.state === 'applied' || !!candidate || !data.run.import_stock
                            }
                            value={
                              !data.run.import_stock
                                ? '0'
                                : (d.quantity ?? (n.quantity === null ? '' : String(n.quantity)))
                            }
                            onChange={(e) => update(r.id, { quantity: e.target.value })}
                          />
                        )}
                      </td>
                      <td>
                        {r.state === 'applied' ? (
                          <strong>
                            {r.result.action === 'created' ? 'Utworzono' : 'Powiązano'} ·{' '}
                            {r.result.sku}
                          </strong>
                        ) : null}
                        {r.issues.map((m: string, i: number) => (
                          <small key={i}>{m}</small>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="toolbar">
            <button
              className="button primary"
              disabled={freshBlocked || !canApply || data.run.state !== 'ready' || !selected.length}
              onClick={() => void apply()}
            >
              Zatwierdź wybrane SKU ({selected.length})
            </button>
            <button
              className="button"
              disabled={busy || !back.length}
              onClick={() => {
                setAfter(back.at(-1)!);
                setBack((v) => v.slice(0, -1));
              }}
            >
              Poprzednia strona katalogu
            </button>
            <button
              className="button"
              disabled={busy || !data.meta.cursor}
              onClick={() => {
                setBack((v) => [...v, after]);
                setAfter(data.meta.cursor);
              }}
            >
              Następna strona katalogu
            </button>
          </div>
          {!data.data.length && <p>Brak pozycji dla wybranych filtrów.</p>}
        </>
      )}
    </section>
  );
}
