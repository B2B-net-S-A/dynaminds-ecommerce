import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { api, date, money } from './api';
import { ProductPicker } from './catalog';
import { SupplierBulk } from './supplier-bulk';
import { SupplierSchedule } from './supplier-schedules';
import { productCatalogsWriteLocked, type ProductCatalog } from './product-catalogs';
import { catalogExportLocked } from './catalog-export';

function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <div className="notice import-error" role="alert">
      {error}
    </div>
  ) : null;
}
function Dialog({
  title,
  close,
  busy,
  children,
}: {
  title: string;
  close: () => void;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <div className="modal-shade">
      <section
        className="modal catalog-modal purchase-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Zamknij" disabled={busy} onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function SupplierCatalog({
  admin,
  refresh,
  reload,
  notify,
  contextKey,
  readOnly,
  externalWriteBlocked = false,
  productWriteBlocked = false,
}: {
  admin: boolean;
  refresh: number;
  reload: () => void;
  notify: (s: string) => void;
  contextKey: string;
  readOnly: boolean;
  externalWriteBlocked?: boolean;
  productWriteBlocked?: boolean;
}) {
  const [sources, setSources] = useState<any[]>([]),
    [sourceCursor, setSourceCursor] = useState<string | null>(null),
    [sourceId, setSourceId] = useState(''),
    [search, setSearch] = useState(''),
    [rows, setRows] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [reads, setReads] = useState<any[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState(''),
    [item, setItem] = useState<any>(null),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [localCurrency, setLocalCurrency] = useState('PLN');
  const source = sources.find((s) => s.id === sourceId),
    path = '/supplier-catalog?' + new URLSearchParams({ source_id: sourceId, search, limit: '25' });
  const fileSource = source?.kind === 'file';
  const canWrite = admin && !readOnly && !externalWriteBlocked;
  useEffect(() => {
    setSourceId('');
    setModal('');
    setItem(null);
    setSources([]);
    setRows([]);
    setReads([]);
    setError('');
  }, [contextKey, readOnly]);
  useEffect(() => {
    let active = true;
    Promise.all([
      api('/supplier-sources?limit=100'),
      api('/warehouses'),
      api('/workspaces/settings'),
      sourceId ? api('/supplier-sources/' + sourceId) : Promise.resolve(null),
    ])
      .then(([s, w, c, selected]) => {
        if (active) {
          setSources(
            selected && !s.data.some((r: any) => r.id === selected.id)
              ? [...s.data, selected]
              : s.data,
          );
          setSourceCursor(s.meta.cursor);
          setWarehouses(w.data);
          setLocalCurrency(c.tenant.currency ?? 'PLN');
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [refresh, contextKey, readOnly]);
  useEffect(() => {
    let active = true;
    setRows([]);
    setCursor(null);
    setReads([]);
    if (!sourceId) return;
    setLoading(true);
    Promise.all([
      api(path),
      fileSource
        ? Promise.resolve({ data: [] })
        : api('/supplier-reads?source_id=' + sourceId + '&limit=100'),
    ])
      .then(([c, r]) => {
        if (active) {
          setRows(c.data);
          setCursor(c.meta.cursor);
          setReads(r.data);
          setError('');
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [path, refresh, sourceId, contextKey, readOnly, fileSource]);
  async function act(work: () => Promise<any>, message: string) {
    if (!canWrite || busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      setModal('');
      reload();
      notify(message);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="warehouse-detail">
      <div className="panel-heading">
        <div>
          <h2>Katalog dostawcy</h2>
          <p>Katalog dostawcy → produkt lokalny → zakup → przyjęcie PZ</p>
        </div>
        {canWrite && (
          <button
            className="button primary"
            onClick={() => {
              setError('');
              setModal('source');
            }}
          >
            Podłącz hurtownię
          </button>
        )}
      </div>
      <ErrorNotice error={error} />
      <div className="warehouse-actions">
        <label>
          Źródło hurtowni
          <select
            aria-label="Źródło hurtowni"
            disabled={busy || externalWriteBlocked}
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
          >
            <option value="">Wybierz źródło</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.kind === 'file'
                  ? `${s.name || s.channel_name || 'Źródło plikowe'} · plik`
                  : s.channel_name}{' '}
                · {s.supplier_name}
                {s.paused ? ' · wstrzymane' : ''}
              </option>
            ))}
          </select>
        </label>
        {sourceCursor && (
          <button
            className="button"
            onClick={async () => {
              try {
                const r = await api('/supplier-sources?limit=100&after=' + sourceCursor);
                setSources((s) => [...s, ...r.data]);
                setSourceCursor(r.meta.cursor);
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            Więcej źródeł
          </button>
        )}
        <button className="button" onClick={reload}>
          Odśwież katalog
        </button>
      </div>
      {source && (
        <>
          {!fileSource && (
            <fieldset
              className="supplier-file-catalog-lock"
              disabled={readOnly || externalWriteBlocked}
            >
              <SupplierSchedule
                source={source}
                admin={admin}
                refresh={refresh}
                reload={reload}
                notify={notify}
              />
              <SupplierBulk
                source={source}
                admin={admin}
                refresh={refresh}
                reload={reload}
                notify={notify}
              />
            </fieldset>
          )}
          <div className="notice">
            {fileSource
              ? 'Odczyt z jawnie zastosowanego pliku dostawcy. '
              : source.simulation === 'true'
                ? 'Przykład lokalny — dane syntetyczne. '
                : 'Odczyt API BigBuy. '}
            Waluta ceny zakupu netto: {source.currency}. Dostępność obejmuje czas obsługi do{' '}
            {source.max_handling_days} dni. Zakup wymaga odczytu z ostatnich 15 minut. Stan naszego
            magazynu zwiększy dopiero PZ.
          </div>
          <div className="warehouse-actions">
            {canWrite && (
              <>
                {!fileSource && (
                  <button
                    className="button primary"
                    disabled={busy || source.paused}
                    onClick={() => {
                      setError('');
                      setModal('read');
                    }}
                  >
                    Pobierz produkt BigBuy
                  </button>
                )}
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api('/supplier-sources/' + source.id + '/state', 'PATCH', {
                          version: source.version,
                          paused: !source.paused,
                        }),
                      source.paused
                        ? 'Źródło wznowione. Pobierz dane ponownie.'
                        : 'Źródło wstrzymane.',
                    )
                  }
                >
                  {source.paused ? 'Wznów źródło' : 'Wstrzymaj źródło'}
                </button>
              </>
            )}
            <input
              aria-label="Szukaj w katalogu dostawcy"
              placeholder="Nazwa lub SKU dostawcy"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {loading ? (
            <p>Wczytywanie katalogu…</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Produkt dostawcy</th>
                    <th>Cena zakupu</th>
                    <th>Dostępność hurtowni</th>
                    <th>Odczyt</th>
                    <th>Produkt lokalny</th>
                    {admin && <th>Operacje</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <strong>{i.sku}</strong>
                        <br />
                        {i.name}
                        <br />
                        <small>
                          {i.snapshot.condition} · {i.snapshot.active ? 'Aktywny' : 'Nieaktywny'}
                        </small>
                      </td>
                      <td>
                        {money(i.snapshot.unit_cost, i.currency)}
                        {i.snapshot.tiers.map((t: any) => (
                          <div key={t.quantity}>
                            <small>
                              Od {t.quantity} szt.: {money(t.unit_cost, i.currency)}
                            </small>
                          </div>
                        ))}
                      </td>
                      <td>{i.snapshot.quantity} szt.</td>
                      <td>{date(i.refreshed_at)}</td>
                      <td>{i.local_sku || 'Brak powiązania'}</td>
                      {admin && (
                        <td>
                          <button
                            className="button"
                            disabled={busy || !canWrite}
                            onClick={() => {
                              if (!canWrite || busy) return;
                              setItem(i);
                              setError('');
                              setModal('item');
                            }}
                          >
                            Pozycja {i.sku}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={admin ? 6 : 5}>
                        {fileSource
                          ? 'Zastosuj plik w panelu plikowego źródła dostawcy, aby zobaczyć katalog.'
                          : 'Pobierz produkt po jego identyfikatorze BigBuy. Wariant wymaga również identyfikatora wariantu.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {cursor && (
            <button
              className="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api(path + '&after=' + cursor);
                  setRows((v) => [...v, ...r.data]);
                  setCursor(r.meta.cursor);
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Wczytaj kolejne pozycje
            </button>
          )}
          {!!reads.length && (
            <details>
              <summary>
                Odczyty katalogu ({reads.length}
                {reads.length === 100 ? '+' : ''})
              </summary>
              {reads.map((r) => (
                <p key={r.id}>
                  Produkt {r.remote_product_id}
                  {r.remote_variant_id ? ' / wariant ' + r.remote_variant_id : ''} ·{' '}
                  {
                    (
                      {
                        queued: 'Oczekuje',
                        success: 'Gotowy',
                        failed: 'Błąd',
                        cancelled: 'Anulowany',
                      } as any
                    )[r.state]
                  }{' '}
                  · krok {r.phase} {r.error && ' · ' + r.error}
                </p>
              ))}
            </details>
          )}
        </>
      )}
      {modal === 'source' && canWrite && (
        <SourceForm
          close={() => setModal('')}
          saved={(id: string) => {
            setSourceId(id);
            setModal('');
            reload();
            notify('Źródło hurtowni zapisane.');
          }}
        />
      )}
      {modal === 'read' && source && !fileSource && canWrite && (
        <ReadForm
          error={error}
          busy={busy}
          close={() => setModal('')}
          submit={(b) =>
            act(
              () => api('/supplier-sources/' + source.id + '/reads', 'POST', b),
              'Odczyt jest w kolejce. Odśwież katalog, aby zobaczyć wynik.',
            )
          }
        />
      )}
      {modal === 'item' && item && source && (
        <ItemForm
          contextKey={contextKey}
          item={item}
          source={source}
          warehouses={warehouses}
          localCurrency={localCurrency}
          error={error}
          busy={busy}
          writeBlocked={!canWrite}
          productWriteBlocked={productWriteBlocked}
          close={() => setModal('')}
          submit={(work, message) => act(work, message)}
        />
      )}
    </div>
  );
}
function ReadForm({
  busy,
  error,
  close,
  submit,
}: {
  busy: boolean;
  error: string;
  close: () => void;
  submit: (b: any) => void;
}) {
  const [root, setRoot] = useState(''),
    [variant, setVariant] = useState(''),
    [key, setKey] = useState(() => crypto.randomUUID());
  return (
    <Dialog title="Pobierz produkt BigBuy" close={close} busy={busy}>
      <form
        className="warehouse-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit({
            client_key: key,
            remote_product_id: root,
            ...(variant ? { remote_variant_id: variant } : {}),
          });
        }}
      >
        <ErrorNotice error={error} />
        <div className="notice">
          Odczyt obejmuje opis, zdjęcia, cenę i dostępność. Dla produktu z wariantami podaj
          konkretny wariant.
        </div>
        <label>
          ID produktu BigBuy
          <input
            required
            pattern="[1-9][0-9]{0,15}"
            value={root}
            onChange={(e) => {
              setRoot(e.target.value);
              setKey(crypto.randomUUID());
            }}
          />
        </label>
        <label>
          ID wariantu (opcjonalnie)
          <input
            pattern="[1-9][0-9]{0,15}"
            value={variant}
            onChange={(e) => {
              setVariant(e.target.value);
              setKey(crypto.randomUUID());
            }}
          />
        </label>
        <footer>
          <button className="button" type="button" disabled={busy} onClick={close}>
            Wróć
          </button>
          <button className="button primary" disabled={busy}>
            Zleć odczyt
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
function SourceForm({ close, saved }: { close: () => void; saved: (id: string) => void }) {
  const [suppliers, setSuppliers] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [search, setSearch] = useState(''),
    [channels, setChannels] = useState<any[]>([]),
    [supplier, setSupplier] = useState(''),
    [channel, setChannel] = useState(''),
    [currency, setCurrency] = useState('EUR'),
    [language, setLanguage] = useState('pl'),
    [days, setDays] = useState(2),
    [demo, setDemo] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api('/suppliers?limit=50&search=' + encodeURIComponent(search))
      .then((r) => {
        if (active) {
          setSuppliers(r.data.filter((s: any) => s.active));
          setCursor(r.meta.cursor);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [search]);
  useEffect(() => {
    let active = true;
    api('/integrations')
      .then(
        (r) =>
          active &&
          setChannels(
            r.channels.filter((c: any) => c.provider === 'bigbuy' && !c.settings?.simulation),
          ),
      )
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, []);
  return (
    <Dialog title="Podłącz hurtownię BigBuy" close={close} busy={busy}>
      <form
        className="warehouse-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const r = await api(
              demo ? '/supplier-sources/demo' : '/supplier-sources',
              'POST',
              demo
                ? { supplier_id: supplier }
                : {
                    supplier_id: supplier,
                    channel_id: channel,
                    currency,
                    language,
                    max_handling_days: days,
                  },
            );
            saved(r.id);
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorNotice error={error} />
        <label>
          Szukaj dostawcy
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label>
          Dostawca
          <select required value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            <option value="">Wybierz dostawcę</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {cursor && (
          <button
            className="button"
            type="button"
            onClick={async () => {
              try {
                const r = await api(
                  '/suppliers?limit=50&search=' + encodeURIComponent(search) + '&after=' + cursor,
                );
                setSuppliers((v) => [...v, ...r.data.filter((s: any) => s.active)]);
                setCursor(r.meta.cursor);
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            Więcej dostawców
          </button>
        )}
        <label className="check">
          <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />{' '}
          Przykład lokalny bez połączenia z hurtownią
        </label>
        {!demo && (
          <>
            <div className="notice">
              Najpierw dodaj BigBuy z kluczem API w Integracjach. Potwierdź walutę konta: API nie
              zwraca jej przy cenie.
            </div>
            <label>
              Integracja BigBuy
              <select required value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="">Wybierz integrację</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.mode}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Waluta konta
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {['PLN', 'EUR', 'USD', 'GBP', 'CZK'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Język opisów
              <input
                required
                pattern="[a-z]{2}"
                maxLength={2}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </label>
            <label>
              Maksymalny czas obsługi (dni)
              <input
                type="number"
                min="0"
                max="365"
                required
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </label>
          </>
        )}
        <footer>
          <button className="button" type="button" disabled={busy} onClick={close}>
            Wróć
          </button>
          <button className="button primary" disabled={busy}>
            Zapisz źródło
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
function ItemForm({
  contextKey,
  item,
  source,
  warehouses,
  localCurrency,
  error,
  busy,
  writeBlocked,
  productWriteBlocked,
  close,
  submit,
}: {
  contextKey: string;
  item: any;
  source: any;
  warehouses: any[];
  localCurrency: string;
  error: string;
  busy: boolean;
  writeBlocked: boolean;
  productWriteBlocked: boolean;
  close: () => void;
  submit: (work: () => Promise<any>, message: string) => void;
}) {
  const [product, setProduct] = useState(''),
    [sku, setSku] = useState(item.sku),
    [price, setPrice] = useState(''),
    [vat, setVat] = useState(23),
    [warehouse, setWarehouse] = useState(warehouses[0]?.id ?? ''),
    [quantity, setQuantity] = useState(1),
    [key, setKey] = useState(() => crypto.randomUUID());
  const [catalogs, setCatalogs] = useState<ProductCatalog[]>([]), [catalogId, setCatalogId] = useState(''), [catalogRead, setCatalogRead] = useState(false), [catalogAvailable, setCatalogAvailable] = useState(false), [catalogWritable, setCatalogWritable] = useState(false), [catalogError, setCatalogError] = useState('');
  const createScope = contextKey + ':' + item.id + ':' + catalogId + ':' + writeBlocked + ':' + productWriteBlocked;
  const createScopeRef = useRef(createScope), formAlive = useRef(false);
  createScopeRef.current = createScope;
  const latestWriteBlocked = useRef(writeBlocked);
  latestWriteBlocked.current = writeBlocked;
  const latestProductWriteBlocked = useRef(productWriteBlocked);
  latestProductWriteBlocked.current = productWriteBlocked;
  const pimBlocked = () => latestProductWriteBlocked.current || productCatalogsWriteLocked(contextKey) || catalogExportLocked(contextKey);
  async function linkProduct(productId: string | null) {
    const captured = createScope;
    if (latestWriteBlocked.current || pimBlocked()) throw Error('Nowe zapisy produktów są chwilowo wstrzymane.');
    const me = await api('/auth/me');
    if (me.user?.role !== 'admin' || `${me.user?.tenant_id}:${me.user?.id}:${me.user?.role}` !== contextKey.split(':').slice(0, 3).join(':')) throw Error('Zmienił się użytkownik lub firma. Powiązanie nie zostało wysłane.');
    if (!formAlive.current || createScopeRef.current !== captured || latestWriteBlocked.current || pimBlocked()) throw Error('Formularz produktu zmienił się. Powiązanie nie zostało wysłane.');
    return api('/supplier-catalog/' + item.id + '/link', 'PATCH', { version: item.version, product_id: productId });
  }
  useEffect(() => {
    let active = true; formAlive.current = true;
    setCatalogId(''); setCatalogs([]); setCatalogRead(false); setCatalogAvailable(false); setCatalogWritable(false); setCatalogError(''); setProduct(''); setPrice('');
    api('/product-catalogs/options').then((d) => {
      if (!active) return;
      if (typeof d.available !== 'boolean' || typeof d.can_read !== 'boolean' || (d.available && (!d.can_read || !Array.isArray(d.catalogs)))) throw Error('Niepełny odczyt katalogów produktu hurtowni.');
      setCatalogAvailable(d.available); setCatalogs(d.catalogs ?? []); setCatalogWritable(Boolean(d.can_manage && !d.read_only)); setCatalogRead(true);
    }).catch((e) => active && setCatalogError(e.message));
    return () => { active = false; formAlive.current = false; };
  }, [contextKey, item.id]);
  const createCatalog = catalogs.find((c) => c.id === catalogId && c.active);
  const createWarehouses = catalogAvailable ? warehouses.filter((w) => createCatalog?.settings.warehouse_ids.includes(w.id)) : warehouses;
  const productBlocked = busy || writeBlocked || pimBlocked();
  const createBlocked = productBlocked || !catalogRead || (catalogAvailable && (!catalogWritable || !createCatalog || !createWarehouses.some((w) => w.id === warehouse)));
  let cost = item.snapshot.unit_cost;
  for (const t of item.snapshot.tiers) if (quantity >= t.quantity) cost = t.unit_cost;
  const warehouseField = (
    <label>
      Magazyn
      <select
        required
        value={warehouse}
        onChange={(e) => {
          setWarehouse(e.target.value);
          setKey(crypto.randomUUID());
        }}
      >
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Dialog title={'Pozycja ' + item.sku} close={close} busy={busy}>
      <div className="warehouse-form">
        <ErrorNotice error={error} />
        <ErrorNotice error={catalogError} />
        {pimBlocked() && <p className="notice">Nowe produkty i zmiany powiązań są wstrzymane podczas nierozstrzygniętej operacji PIM lub eksportu. Odczyty i historia pozostają dostępne.</p>}
        <fieldset className="supplier-file-catalog-lock" disabled={writeBlocked}>
          {source.kind !== 'file' && (
            <button
              className="button"
              disabled={busy || source.paused}
              onClick={() =>
                submit(
                  () =>
                    api('/supplier-sources/' + source.id + '/reads', 'POST', {
                      client_key: key,
                      remote_product_id: item.remote_product_id,
                      ...(item.remote_variant_id
                        ? { remote_variant_id: item.remote_variant_id }
                        : {}),
                    }),
                  'Świeży odczyt pozycji jest w kolejce. Odśwież katalog po zakończeniu.',
                )
              }
            >
              Odśwież tę pozycję
            </button>
          )}
          <p>
            {item.name} · hurtownia: {item.snapshot.quantity} szt. · {money(cost, item.currency)}
          </p>
          {!item.product_id ? (
            <>
              <form
                className="warehouse-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (productBlocked) return;
                  submit(
                    () => linkProduct(product),
                    'Produkt powiązany.',
                  );
                }}
              >
                <ProductPicker
                  contextKey={contextKey}
                  disabled={productBlocked}
                  label="Produkt lokalny"
                  value={product}
                  select={(p) => setProduct(p?.id ?? '')}
                  filter={(p) => ['simple', 'variant'].includes(p.kind)}
                />
                <button className="button primary" disabled={productBlocked}>
                  Powiąż produkt
                </button>
              </form>
              <details>
                <summary>Utwórz nowy produkt lokalny</summary>
                <form
                  className="warehouse-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (createBlocked) return;
                    const captured = createScope;
                    const body = { version: item.version, sku, price: Math.round(Number(price) * 100), vat, warehouse_id: warehouse, ...(catalogAvailable ? { catalog_id: catalogId } : {}) };
                    submit(
                      async () => {
                        const access = await api('/product-catalogs/options');
                        if (!formAlive.current || createScopeRef.current !== captured || latestWriteBlocked.current || pimBlocked()) throw Error('Formularz produktu zmienił się. Zapis nie został wysłany.');
                        if (catalogAvailable && (!access.available || !access.can_manage || access.read_only || access.current_role !== contextKey.split(':')[2] || !access.catalogs?.some((c: ProductCatalog) => c.id === body.catalog_id && c.active && c.settings.warehouse_ids.includes(body.warehouse_id)))) throw Error('Katalog lub magazyn produktu zmienił się. Odczytaj formularz ponownie.');
                        const me = await api('/auth/me');
                        if (me.user?.role !== 'admin' || `${me.user?.tenant_id}:${me.user?.id}:${me.user?.role}` !== contextKey.split(':').slice(0, 3).join(':')) throw Error('Zmienił się użytkownik lub firma. Zapis produktu nie został wysłany.');
                        if (!formAlive.current || createScopeRef.current !== captured || latestWriteBlocked.current || pimBlocked()) throw Error('Formularz produktu zmienił się. Zapis nie został wysłany.');
                        return api('/supplier-catalog/' + item.id + '/product', 'POST', body);
                      },
                      'Produkt utworzony ze stanem zero.',
                    );
                  }}
                >
                  <div className="notice">
                    Dostępność hurtowni nie jest stanem magazynu. Podaj własną cenę sprzedaży w{' '}
                    {localCurrency}.
                  </div>
                  {catalogAvailable && <label>Katalog nowego produktu<select aria-label="Katalog nowego produktu" value={catalogId} required disabled={busy || writeBlocked} onChange={(e) => { setCatalogId(e.target.value); setWarehouse(''); setProduct(''); setSku(item.sku); setPrice(''); }}><option value="">Wybierz aktywny katalog</option>{catalogs.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' · domyślny' : ''}</option>)}</select><small>SKU nadal jest unikalne w całej firmie. Powstanie produkt w tej puli ze stanem zero.</small></label>}
                  <label>
                    Lokalne SKU
                    <input
                      required
                      maxLength={80}
                      value={sku}
                      onChange={(e) => setSku(e.target.value)}
                    />
                  </label>
                  <label>
                    Cena sprzedaży ({localCurrency})
                    <input
                      required
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                    />
                  </label>
                  <label>
                    VAT
                    <select value={vat} onChange={(e) => setVat(Number(e.target.value))}>
                      {[0, 5, 8, 23].map((v) => (
                        <option key={v} value={v}>
                          {v}%
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>Magazyn nowego produktu<select aria-label="Magazyn nowego produktu" value={warehouse} required disabled={busy || writeBlocked} onChange={(e) => setWarehouse(e.target.value)}><option value="">Wybierz przypisany magazyn</option>{createWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
                  <button className="button primary" disabled={createBlocked}>
                    Utwórz produkt ze stanem zero
                  </button>
                </form>
              </details>
            </>
          ) : (
            <>
              <p>
                Produkt lokalny: <strong>{item.local_sku}</strong>
              </p>
              <form
                className="warehouse-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit(
                    () =>
                      api('/supplier-sources/' + source.id + '/purchase', 'POST', {
                        client_key: key,
                        warehouse_id: warehouse,
                        items: [{ id: item.id, version: item.version, quantity }],
                      }),
                    'Szkic zakupu utworzony. Otwórz listę zakupów.',
                  );
                }}
              >
                {warehouseField}
                <label>
                  Ilość zakupu
                  <input
                    required
                    type="number"
                    min="1"
                    max={item.snapshot.quantity}
                    value={quantity}
                    onChange={(e) => {
                      setQuantity(Number(e.target.value));
                      setKey(crypto.randomUUID());
                    }}
                  />
                </label>
                <div className="notice">
                  Cena jednostkowa {money(cost, item.currency)}, razem netto{' '}
                  {money(quantity * cost, item.currency)}. Szkic zakupu zapisujemy lokalnie.
                  Przyjęcie dostawy wykonasz na liście zakupów.
                </div>
                <button
                  className="button primary"
                  disabled={
                    busy || source.paused || !item.snapshot.active || !item.snapshot.quantity
                  }
                >
                  Utwórz zakup
                </button>
              </form>
              <button
                className="button"
                disabled={productBlocked}
                onClick={() =>
                  submit(
                    () => linkProduct(null),
                    'Powiązanie usunięte.',
                  )
                }
              >
                Usuń powiązanie produktu
              </button>
            </>
          )}
        </fieldset>
        <footer>
          <button className="button" disabled={busy} onClick={close}>
            Wróć
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
