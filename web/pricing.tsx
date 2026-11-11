import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, money } from './api';
import { ProductPicker } from './catalog';
import { RepricingPanel } from './repricing';
import { competitorObservationsLocked, type CompetitorObservationContext } from './competitor-observations';
export function PriceListPicker({
  value,
  onChange,
  label = 'Cennik',
  initial,
}: {
  value: string;
  onChange: (list: any | null) => void;
  label?: string;
  initial?: any;
}) {
  const [query, setQuery] = useState(''),
    [data, setData] = useState<any>({ data: [], meta: {} }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const path = '/price-lists?active=true&limit=25&search=' + encodeURIComponent(query);
  useEffect(() => {
    let active = true;
    generation.current++;
    setBusy(true);
    api(path)
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
      generation.current++;
    };
  }, [path]);
  return (
    <div className="price-picker">
      <label>
        {label}
        <select
          value={value}
          onChange={(e) =>
            onChange(
              [...data.data, ...(initial ? [initial] : [])].find(
                (l: any) => l.id === e.target.value,
              ) ?? null,
            )
          }
        >
          <option value="">Cena katalogowa w walucie firmy</option>
          {initial?.id === value && !data.data.some((l: any) => l.id === value) && (
            <option value={initial.id}>
              {initial.name} · {initial.currency}
              {initial.active === false ? ' · nieaktywny' : ''}
            </option>
          )}
          {data.data.map((l: any) => (
            <option key={l.id} value={l.id}>
              {l.name} · {l.currency}
            </option>
          ))}
        </select>
      </label>
      <label>
        Szukaj cennika
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange(null);
          }}
          maxLength={100}
        />
      </label>
      {data.meta.cursor && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const stamp = generation.current;
              const d = await api(path + '&after=' + data.meta.cursor);
              if (generation.current !== stamp) return;
              setData((v: any) => ({ data: [...v.data, ...d.data], meta: d.meta }));
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Kolejne cenniki
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
const minor = (value: any) => {
  const v = String(value).trim().replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(v))
    throw Error('Kwota wymaga maksymalnie dwóch miejsc dziesiętnych');
  const sign = v.startsWith('-') ? -1 : 1,
    [a, b = ''] = v.replace('-', '').split('.');
  return sign * (Number(a) * 100 + Number(b.padEnd(2, '0')));
};
export function PricingPanel({
  write,
  admin,
  refresh,
  context,
  navigationLocked,
  externalWriteBlocked,
}: {
  write: boolean;
  admin: boolean;
  refresh: number;
  context: CompetitorObservationContext;
  navigationLocked: boolean;
  externalWriteBlocked: boolean;
}) {
  const [data, setData] = useState<any>({ data: [], meta: {} }),
    [selected, setSelected] = useState<any>(null),
    [create, setCreate] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState('');
  const generation = useRef(0);
  const path = '/price-lists?limit=25&search=' + encodeURIComponent(query);
  async function load() {
    setData(await api(path));
  }
  useEffect(() => {
    let active = true;
    generation.current++;
    if (navigationLocked) return;
    setSelected(null);
    api(path)
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      generation.current++;
    };
  }, [path, refresh]);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!write || externalWriteBlocked || competitorObservationsLocked(context)) {
      setError('Zapis cennika jest zablokowany; sprawdź wynik poprzedniej próby.');
      return;
    }
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      const row = await api('/price-lists', 'POST', {
        name: f.get('name'),
        currency: f.get('currency'),
        fallback: f.get('fallback') === 'on',
        adjustment_bps: minor(f.get('percent')),
        adjustment_amount: minor(f.get('amount')),
      });
      setCreate(false);
      setSelected(row);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pricing-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Cenniki sprzedaży</h2>
            <p>Ceny brutto według kanału, grupy klientów lub waluty</p>
          </div>
          {write && (
            <button className="button primary" onClick={() => setCreate(!create)}>
              Nowy cennik
            </button>
          )}
        </div>
        <div className="info-body">
          {error && (
            <p role="alert" className="error-block">
              {error}
            </p>
          )}
          {create && (
            <form onSubmit={add} className="form-grid">
              <label>
                Nazwa cennika
                <input name="name" required minLength={2} maxLength={120} />
              </label>
              <label>
                Waluta
                <select name="currency">
                  {['PLN', 'EUR', 'USD', 'GBP', 'CZK'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                Zmiana ceny katalogowej (%)
                <input
                  name="percent"
                  type="number"
                  min="-90"
                  max="1000"
                  step="0.01"
                  defaultValue="0"
                  required
                />
              </label>
              <label>
                Dodatkowa kwota
                <input name="amount" type="number" step="0.01" defaultValue="0" required />
              </label>
              <label>
                <input type="checkbox" name="fallback" />
                Dla brakujących SKU użyj reguły katalogowej w walucie firmy
              </label>
              <button className="button primary" disabled={busy}>
                Zapisz cennik
              </button>
              <p className="muted">
                Waluta jest stała. Cennik w innej walucie wymaga jawnej ceny każdego SKU.
              </p>
            </form>
          )}
          <form
            className="toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              if (navigationLocked) return;
              setQuery(search);
            }}
          >
            <input
              aria-label="Szukaj cenników"
              disabled={navigationLocked}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={100}
            />
            <button className="button">Szukaj</button>
          </form>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Cennik</th>
                  <th>Waluta</th>
                  <th>Stan</th>
                  <th>Reguła</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((l: any) => (
                  <tr key={l.id}>
                    <td>
                      <button className="text-button" disabled={navigationLocked} onClick={() => setSelected(l)}>
                        {l.name}
                      </button>
                    </td>
                    <td>{l.currency}</td>
                    <td>{l.active ? 'Aktywny' : 'Nieaktywny'}</td>
                    <td>
                      {l.fallback
                        ? `${l.adjustment_bps / 100}% + ${money(l.adjustment_amount, l.currency)}`
                        : 'Tylko ceny SKU'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.data.length && <p className="muted">Brak cenników dla wybranego wyszukiwania.</p>}
          {data.meta.cursor && (
            <button
              className="button"
              onClick={async () => {
                try {
                  const stamp = generation.current;
                  const d = await api(path + '&after=' + data.meta.cursor);
                  if (generation.current !== stamp) return;
                  setData((v: any) => ({ data: [...v.data, ...d.data], meta: d.meta }));
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            >
              Kolejne cenniki
            </button>
          )}
        </div>
      </section>
      {selected && (
        <PriceListDetail
          key={selected.id}
          initial={selected}
          context={context}
          refresh={refresh}
          externalWriteBlocked={externalWriteBlocked}
          write={write}
          admin={admin}
          onSaved={async (l) => {
            setSelected(l);
            await load();
          }}
        />
      )}
    </div>
  );
}
function PriceListDetail({
  initial,
  write,
  admin,
  onSaved,
  context,
  refresh,
  externalWriteBlocked,
}: {
  initial: any;
  write: boolean;
  admin: boolean;
  onSaved: (l: any) => Promise<void>;
  context: CompetitorObservationContext;
  refresh: number;
  externalWriteBlocked: boolean;
}) {
  const [data, setData] = useState<any>({ list: initial, data: [], meta: {} }),
    [product, setProduct] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    [preview, setPreview] = useState<any>(null);
  const generation = useRef(0);
  const path = '/price-lists/' + initial.id + '/items?limit=25&search=' + encodeURIComponent(query),
    l = data.list;
  useEffect(() => {
    let active = true;
    generation.current++;
    api(path)
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      generation.current++;
    };
  }, [path]);
  async function run(route: string, body: any, method: string) {
    if (!write || externalWriteBlocked || competitorObservationsLocked(context)) {
      setError('Zapis ceny jest zablokowany; sprawdź wynik poprzedniej próby.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const updated = await api(route, method, body);
      setData(await api(path));
      setPreview(null);
      await onSaved(updated);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{l.name}</h2>
          <p>
            {l.currency} · wersja {l.version}
          </p>
        </div>
      </div>
      <div className="info-body">
        {error && (
          <p role="alert" className="error-block">
            {error}
          </p>
        )}
        {write && (
          <form
            key={l.version}
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                run(
                  '/price-lists/' + l.id,
                  {
                    name: f.get('name'),
                    active: f.get('active') === 'on',
                    fallback: f.get('fallback') === 'on',
                    adjustment_bps: minor(f.get('percent')),
                    adjustment_amount: minor(f.get('amount')),
                    version: l.version,
                  },
                  'PATCH',
                );
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <label>
              Nazwa
              <input name="name" defaultValue={l.name} required minLength={2} maxLength={120} />
            </label>
            <label>
              Reguła procentowa (%)
              <input
                name="percent"
                type="number"
                min="-90"
                max="1000"
                step="0.01"
                defaultValue={l.adjustment_bps / 100}
              />
            </label>
            <label>
              Reguła kwotowa
              <input
                name="amount"
                type="number"
                step="0.01"
                defaultValue={l.adjustment_amount / 100}
              />
            </label>
            <label>
              <input name="active" type="checkbox" defaultChecked={l.active} />
              Aktywny
            </label>
            <label>
              <input name="fallback" type="checkbox" defaultChecked={l.fallback} />
              Reguła katalogowa dla brakujących SKU
            </label>
            <button className="button" disabled={busy}>
              Zapisz ustawienia cennika
            </button>
          </form>
        )}
        <p className="muted">
          Wpis SKU zastępuje regułę. Usunięcie wpisu przywraca regułę lub brak ceny. Zapisane
          zamówienia zachowują wcześniejsze kwoty.
        </p>
        {write && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              if (!product) {
                setError('Wybierz produkt');
                return;
              }
              try {
                run(
                  '/price-lists/' + l.id + '/items',
                  {
                    version: l.version,
                    items: [{ product_id: product.id, price: minor(f.get('price')) }],
                  },
                  'PUT',
                );
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <ProductPicker
              label="Produkt w cenniku"
              value={product?.id ?? ''}
              initial={product}
              select={(p) => {
                setProduct(p);
                setPreview(null);
              }}
              filter={(p) => p.kind !== 'group'}
            />
            <label>
              Cena brutto ({l.currency})
              <input name="price" type="number" min="0" max="1000000" step="0.01" required />
            </label>
            <div className="toolbar-actions">
              <button className="button primary" disabled={busy}>
                Zapisz cenę SKU
              </button>
              <button
                type="button"
                className="button"
                disabled={!product || busy}
                onClick={async () => {
                  try {
                    setPreview(
                      await api('/pricing/quote', 'POST', {
                        price_list_id: l.id,
                        product_ids: [product.id],
                      }),
                    );
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                Sprawdź cenę wynikową
              </button>
            </div>
            {preview && (
              <p role="status">
                {money(preview.items[0].price, preview.currency)} ·{' '}
                {preview.items[0].source === 'override' ? 'wpis SKU' : 'reguła katalogowa'}
              </p>
            )}
          </form>
        )}
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search);
          }}
        >
          <input
            aria-label="Szukaj SKU w cenniku"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={100}
          />
          <button className="button">Szukaj SKU</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Produkt / SKU</th>
              <th>Cena brutto</th>
              {write && <th>Reguła</th>}
            </tr>
          </thead>
          <tbody>
            {data.data.map((i: any) => (
              <tr key={i.product_id}>
                <td>
                  <strong>{i.sku}</strong>
                  <small>{i.name}</small>
                </td>
                <td>{money(i.price, l.currency)}</td>
                {write && (
                  <td>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        run(
                          '/price-lists/' + l.id + '/items',
                          {
                            version: l.version,
                            items: [{ product_id: i.product_id, price: null }],
                          },
                          'PUT',
                        )
                      }
                    >
                      Usuń wpis SKU
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!data.data.length && (
          <p className="muted">Brak indywidualnych cen dla wybranego filtra.</p>
        )}
        <RepricingPanel
          listId={l.id}
          context={context}
          refresh={refresh}
          externalWriteBlocked={externalWriteBlocked}
          write={write}
          admin={admin}
          onApplied={async () => {
            const updated = await api(path);
            setData(updated);
            await onSaved(updated.list);
          }}
        />
        {data.meta.cursor && (
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              try {
                const stamp = generation.current;
                const d = await api(path + '&after=' + data.meta.cursor);
                if (generation.current !== stamp) return;
                setData((v: any) => ({ ...d, data: [...v.data, ...d.data] }));
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            Kolejne ceny SKU
          </button>
        )}
      </div>
    </section>
  );
}
export function OrderPriceQuote({ ids, listId }: { ids: string[]; listId: string }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState('');
  const identity = JSON.stringify([...new Set(ids.filter(Boolean))].sort());
  useEffect(() => {
    let active = true;
    setError('');
    setData(null);
    const product_ids = JSON.parse(identity);
    if (product_ids.length)
      api('/pricing/quote', 'POST', { product_ids, ...(listId ? { price_list_id: listId } : {}) })
        .then((d) => active && setData(d))
        .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [identity, listId]);
  return (
    <div>
      {error && (
        <p role="alert" className="error-block">
          {error}
        </p>
      )}
      {data && (
        <p className="muted">
          Ceny jednostkowe:{' '}
          {data.items.map((i: any) => i.sku + ' — ' + money(i.price, data.currency)).join(' · ')}
        </p>
      )}
    </div>
  );
}
