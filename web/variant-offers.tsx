import { useEffect, useState } from 'react';
import { api, date } from './api';
import { ProductPicker } from './catalog';
import { PriceListPicker } from './pricing';
const states: Record<string, string> = {
  preparing: 'Pobieranie podglądu',
  review: 'Gotowy do przeglądu',
  queued: 'W kolejce',
  done: 'Wykonany',
  partial: 'Częściowo wykonany',
  failed: 'Zatrzymany z błędem',
  cancelled: 'Przerwany',
  pending: 'Oczekuje',
  preview: 'Podgląd',
  skipped: 'Pominięty',
};
export function VariantOffersPanel({
  channelId,
  warehouses,
}: {
  channelId: string;
  warehouses: any[];
}) {
  const [list, setList] = useState<any>(null),
    [detail, setDetail] = useState<any>(null),
    [group, setGroup] = useState<any>(null),
    [parent, setParent] = useState(''),
    [warehouse, setWarehouse] = useState(''),
    [priceList, setPriceList] = useState<any>(null),
    [operation, setOperation] = useState('create_variant'),
    [selected, setSelected] = useState(''),
    [cursor, setCursor] = useState(''),
    [search, setSearch] = useState(''),
    [open, setOpen] = useState(false),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    api('/integrations/' + channelId + '/variant-batches')
      .then((d) => active && setList(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [channelId, refresh]);
  useEffect(() => {
    let active = true;
    if (!selected) {
      setDetail(null);
      return;
    }
    api(
      '/variant-batches/' +
        selected +
        '?search=' +
        encodeURIComponent(search) +
        (cursor ? '&after=' + cursor : ''),
    )
      .then((d) => active && setDetail(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [selected, cursor, search, refresh]);
  useEffect(() => {
    if (!list?.data.some((b: any) => ['preparing', 'queued'].includes(b.state))) return;
    const timer = setInterval(() => setRefresh((x) => x + 1), 2000);
    return () => clearInterval(timer);
  }, [list]);
  function changed() {
    setKey(crypto.randomUUID());
    setError('');
  }
  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await api('/integrations/' + channelId + '/variant-batches', 'POST', {
        group_id: group.id,
        parent_external_id: parent,
        warehouse_id: warehouse || warehouses[0]?.id,
        operation,
        client_key: key,
        ...(priceList ? { price_list_id: priceList.id } : {}),
      });
      setSelected(d.id);
      setCursor('');
      setConfirmed(false);
      setRefresh((x) => x + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function action(action: string) {
    setBusy(true);
    setError('');
    try {
      await api('/variant-batches/' + selected + '/' + action, 'POST', {
        version: detail.batch.version,
        confirm_external: confirmed,
      });
      setRefresh((x) => x + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!list) return null;
  return (
    <section className="variant-offer-panel">
      <div className="section-heading">
        <div>
          <h3>Warianty w WooCommerce</h3>
          <p>
            Najpierw utwórz szkic grupy. Następnie przejrzyj i zatwierdź jej warianty. Publikuj
            warianty przed publikacją grupy.
          </p>
        </div>
        <button className="button" onClick={() => setOpen((v) => !v)}>
          {open ? 'Ukryj nową operację' : 'Przygotuj warianty grupy'}
        </button>
      </div>
      {error && (
        <div className="notice import-error" role="alert">
          {error}
        </div>
      )}
      {open && (
        <form className="offer-form" onSubmit={start}>
          <ProductPicker
            label="Grupa wariantów"
            value={group?.id ?? ''}
            initial={group}
            filter={(p) => p.kind === 'group'}
            select={async (p) => {
              setGroup(p);
              setParent('');
              changed();
              try {
                const d = await api(
                  '/integrations/' +
                    channelId +
                    '/offer-listings?search=' +
                    encodeURIComponent(p.sku),
                );
                const l = d.data.find((v: any) => v.product_id === p.id && v.kind === 'group');
                if (l) setParent(l.external_id);
              } catch (e: any) {
                setError(e.message);
              }
            }}
          />
          <label>
            Operacja wariantów
            <select
              value={operation}
              onChange={(e) => {
                setOperation(e.target.value);
                changed();
              }}
            >
              <option value="create_variant">Utwórz szkice wariantów</option>
              <option value="publish">Opublikuj powiązane warianty</option>
            </select>
          </label>
          <label>
            ID grupy w WooCommerce
            <input
              required
              value={parent}
              onChange={(e) => {
                setParent(e.target.value);
                changed();
              }}
              placeholder={
                list.channel.settings.simulation
                  ? 'DEMO-… po utworzeniu grupy'
                  : 'ID produktu zmiennego'
              }
            />
          </label>
          <label>
            Magazyn wariantów
            <select
              value={warehouse || warehouses[0]?.id || ''}
              onChange={(e) => {
                setWarehouse(e.target.value);
                changed();
              }}
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <PriceListPicker
            label="Cennik wariantów"
            value={priceList?.id ?? ''}
            onChange={(p) => {
              setPriceList(p);
              changed();
            }}
          />
          <p>
            Przy tworzeniu pominiemy już powiązane warianty tego rodzica. Błędy pozostaną widoczne w
            raporcie. Sam podgląd nie zapisuje produktów w sklepie.
          </p>
          <button className="button primary" disabled={busy || !group || !parent}>
            {busy ? 'Przygotowywanie…' : 'Przygotuj podgląd wariantów'}
          </button>
        </form>
      )}
      {!!list.data.length && (
        <label>
          Operacja grupy
          <select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setCursor('');
              setSearch('');
              setConfirmed(false);
            }}
          >
            <option value="">Wybierz operację</option>
            {list.data.map((b: any) => (
              <option key={b.id} value={b.id}>
                {b.sku} · {b.input.operation === 'publish' ? 'Publikacja' : 'Szkice'} ·{' '}
                {states[b.state]} · {date(b.created_at)}
              </option>
            ))}
          </select>
        </label>
      )}
      {detail && (
        <div>
          <h4>
            {detail.batch.sku} · {states[detail.batch.state]}
          </h4>
          <p>
            {Object.entries(detail.counts)
              .map(([k, v]) => `${states[k] ?? k}: ${v}`)
              .join(' · ')}
          </p>
          {detail.batch.error && (
            <div role="alert" className="notice import-error">
              {detail.batch.error}
            </div>
          )}
          <label>
            Szukaj wariantu
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCursor('');
              }}
            />
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU / wariant</th>
                  <th>Plan ceny i stanu</th>
                  <th>Wynik</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.map((i: any) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.sku}</strong>
                      <br />
                      {i.name}
                    </td>
                    <td>
                      {i.payload?.regular_price
                        ? `${i.payload.regular_price} ${i.price_currency ?? ''} ${i.prices_include_tax === 'no' ? 'netto' : 'brutto'}`
                        : '—'}{' '}
                      · {i.payload?.stock_quantity ?? '—'} szt.
                      <br />
                      {i.payload?.attributes?.map((a: any) => `${a.name}: ${a.option}`).join(' · ')}
                    </td>
                    <td>
                      {states[i.state] ?? i.state}
                      {i.plan_state &&
                        i.plan_state !== i.state &&
                        ` · Plan: ${states[i.plan_state] ?? i.plan_state}`}
                      <br />
                      {i.remote_id}
                      <br />
                      {i.error || i.plan_error}
                      {i.state === 'skipped' &&
                        i.result?.reason === 'existing_mapping' &&
                        'Istniejące lokalne powiązanie; bez zapisu do API'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <button className="button" onClick={() => setCursor('')} disabled={!cursor}>
              Pierwsza strona
            </button>
            <button
              className="button"
              disabled={!detail.meta.cursor}
              onClick={() => setCursor(detail.meta.cursor)}
            >
              Następne warianty
            </button>
            <button className="button" onClick={() => setRefresh((x) => x + 1)}>
              Odśwież wynik
            </button>
          </div>
          {detail.batch.state === 'review' && (
            <div className="notice">
              <p>
                Zatwierdzisz {detail.counts.preview ?? 0} poprawnych planów. Błędy i pominięcia
                pozostaną w raporcie.
              </p>
              {!list.channel.settings.simulation && (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  Potwierdzam zapis we wskazanym koncie WooCommerce.
                </label>
              )}
              <button
                className="button primary"
                disabled={
                  busy ||
                  !detail.counts.preview ||
                  (!list.channel.settings.simulation && !confirmed)
                }
                onClick={() => action('queue')}
              >
                Zatwierdź zapis wariantów
              </button>
            </div>
          )}
          {['preparing', 'review', 'queued', 'failed'].includes(detail.batch.state) && (
            <div>
              <p>
                Przerwanie zatrzyma nowe zlecenia. Warianty już zakolejkowane mogą zakończyć zapis —
                sprawdź ich plany i wyniki poniżej.
              </p>
              <button className="button" disabled={busy} onClick={() => action('cancel')}>
                Przerwij kolejne zlecenia
              </button>
            </div>
          )}
          {detail.batch.state === 'failed' && (
            <button className="button" disabled={busy} onClick={() => action('retry')}>
              Wznów od ostatniego wariantu
            </button>
          )}
          {detail.batch.state === 'partial' && (
            <div className="notice">
              Uzgodnij niepewne zapisy w historii planów ofert poniżej, potem odśwież raport
              operacji. Ta czynność sprawdzi wyniki istniejących planów.
              <button className="button" disabled={busy} onClick={() => action('recheck')}>
                Sprawdź wyniki uzgodnionych planów
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
