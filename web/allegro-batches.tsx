import { useEffect, useState } from 'react';
import { api, date } from './api';
import { ProductPicker } from './catalog';
import { PriceListPicker } from './pricing';
import { AllegroCreationFields } from './allegro-creation';
const labels: Record<string, string> = {
  preparing: 'Przygotowywanie podglądu',
  review: 'Gotowa do zatwierdzenia',
  queued: 'Realizacja',
  done: 'Potwierdzona',
  partial: 'Częściowo wykonana',
  failed: 'Błąd',
  cancelled: 'Przerwana',
  pending: 'Oczekuje',
  preview: 'Podgląd',
  skipped: 'Pominięta',
};
export function AllegroBatchesPanel({
  channelId,
  warehouses,
}: {
  channelId: string;
  warehouses: any[];
}) {
  const [list, setList] = useState<any>(null),
    [detail, setDetail] = useState<any>(null),
    [open, setOpen] = useState(false),
    [operation, setOperation] = useState<'create_draft' | 'publish'>('create_draft'),
    [linked, setLinked] = useState<any>(null),
    [linkedSearch, setLinkedSearch] = useState(''),
    [linkedAfter, setLinkedAfter] = useState(''),
    [product, setProduct] = useState<any>(null),
    [mapping, setMapping] = useState<any>(null),
    [items, setItems] = useState<any[]>([]),
    [name, setName] = useState('Nowe oferty Allegro'),
    [warehouse, setWarehouse] = useState(''),
    [priceList, setPriceList] = useState<any>(null),
    [selected, setSelected] = useState(''),
    [after, setAfter] = useState(''),
    [listAfter, setListAfter] = useState(''),
    [search, setSearch] = useState(''),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    api(
      '/integrations/' + channelId + '/allegro-batches' + (listAfter ? '?after=' + listAfter : ''),
    )
      .then((d) => active && setList(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [channelId, listAfter, refresh]);
  useEffect(() => {
    let active = true;
    if (!selected) {
      setDetail(null);
      return;
    }
    api(
      '/allegro-batches/' +
        selected +
        '?search=' +
        encodeURIComponent(search) +
        (after ? '&after=' + after : ''),
    )
      .then((d) => active && setDetail(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [selected, after, search, refresh]);
  useEffect(() => {
    if (
      !list?.data.some((b: any) => ['preparing', 'queued'].includes(b.state)) &&
      !['preparing', 'queued'].includes(detail?.batch.state)
    )
      return;
    const timer = setInterval(() => setRefresh((v) => v + 1), 2000);
    return () => clearInterval(timer);
  }, [list, detail?.batch.state]);
  useEffect(() => {
    if (!open || operation !== 'publish') return;
    let active = true;
    api(
      '/integrations/' +
        channelId +
        '/offer-listings?search=' +
        encodeURIComponent(linkedSearch) +
        (linkedAfter ? '&after=' + linkedAfter : ''),
    )
      .then((d) => active && setLinked(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [open, operation, channelId, linkedSearch, linkedAfter]);
  function changed() {
    setKey(crypto.randomUUID());
    setError('');
  }
  async function run(f: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await f();
      setRefresh((v) => v + 1);
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
          <h3>Masowe oferty Allegro</h3>
          <p>
            Twórz szkice lub publikuj istniejące oferty. Przejrzyj każdą pozycję i zatwierdź partię
            do 200 SKU.
          </p>
        </div>
        <button className="button" onClick={() => setOpen(!open)}>
          {open ? 'Ukryj nową partię' : 'Przygotuj partię Allegro'}
        </button>
      </div>
      {error && (
        <p role="alert" className="notice import-error">
          {error}
        </p>
      )}
      {open && (
        <div>
          <label>
            Operacja partii Allegro
            <select
              value={operation}
              onChange={(e) => {
                setOperation(e.target.value as 'create_draft' | 'publish');
                setItems([]);
                setProduct(null);
                changed();
              }}
            >
              <option value="create_draft">Utwórz nieaktywne szkice</option>
              <option value="publish">Opublikuj powiązane oferty</option>
            </select>
          </label>
          {operation === 'publish' && (
            <div>
              <label>
                Szukaj oferty do publikacji
                <input
                  value={linkedSearch}
                  onChange={(e) => {
                    setLinkedSearch(e.target.value);
                    setLinkedAfter('');
                  }}
                />
              </label>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>SKU / produkt</th>
                      <th>Oferta / ostatni status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {linked?.data
                      .filter((l: any) => ['simple', 'variant'].includes(l.kind))
                      .map((l: any) => (
                        <tr key={l.id}>
                          <td>
                            {l.sku} · {l.name}
                          </td>
                          <td>
                            {l.external_id} ·{' '}
                            {l.last_result?.status ?? 'Status zostanie odczytany w podglądzie'}
                          </td>
                          <td>
                            <button
                              className="button"
                              disabled={
                                items.length >= 200 ||
                                items.some((i) => i.product.id === l.product_id)
                              }
                              onClick={() => {
                                setItems((v) => [
                                  ...v,
                                  {
                                    product: { id: l.product_id, sku: l.sku, name: l.name },
                                    listing: l,
                                  },
                                ]);
                                changed();
                              }}
                            >
                              Dodaj ofertę {l.sku}
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="button-row">
                <button
                  className="button"
                  disabled={!linkedAfter}
                  onClick={() => setLinkedAfter('')}
                >
                  Pierwsze oferty do publikacji
                </button>
                <button
                  className="button"
                  disabled={!linked?.meta.cursor}
                  onClick={() => setLinkedAfter(linked.meta.cursor)}
                >
                  Kolejne oferty do publikacji
                </button>
              </div>
              <p>
                Publikacja ustawia status ACTIVE. Cena i dostępny stan oferty zostaną odczytane w
                podglądzie; synchronizację można wykonać osobno.
              </p>
            </div>
          )}
          {operation === 'create_draft' && (
            <form
              className="offer-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!product || !mapping) return;
                setItems((v) => [...v, { product, allegro: structuredClone(mapping) }]);
                setProduct(null);
                changed();
              }}
            >
              <ProductPicker
                label="Produkt do partii Allegro"
                value={product?.id ?? ''}
                initial={product}
                filter={(p) =>
                  ['simple', 'variant'].includes(p.kind) &&
                  !items.some((i) => i.product.id === p.id)
                }
                select={setProduct}
              />
              <AllegroCreationFields channelId={channelId} onChange={setMapping} />
              <button className="button" disabled={!product || !mapping || items.length >= 200}>
                Dodaj SKU do partii
              </button>
            </form>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU / produkt</th>
                  <th>{operation === 'publish' ? 'Oferta Allegro' : 'Katalog Allegro'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.product.id}>
                    <td>
                      {i.product.sku} · {i.product.name}
                    </td>
                    <td>{i.allegro?.product_id ?? i.listing?.external_id}</td>
                    <td>
                      <button
                        className="button"
                        onClick={() => {
                          setItems((v) => v.filter((r) => r.product.id !== i.product.id));
                          changed();
                        }}
                      >
                        Usuń {i.product.sku} z partii
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form
            className="offer-form"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const d = await api('/integrations/' + channelId + '/allegro-batches', 'POST', {
                  name,
                  warehouse_id: warehouse || warehouses[0]?.id,
                  client_key: key,
                  operation,
                  ...(operation === 'create_draft' && priceList
                    ? { price_list_id: priceList.id }
                    : {}),
                  items: items.map((i) =>
                    operation === 'create_draft'
                      ? { product_id: i.product.id, allegro: i.allegro }
                      : { product_id: i.product.id, listing_id: i.listing.id },
                  ),
                });
                setSelected(d.id);
                setAfter('');
                setListAfter('');
                setConfirmed(false);
                setOpen(false);
                setItems([]);
                changed();
              });
            }}
          >
            <label>
              Nazwa partii Allegro
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  changed();
                }}
              />
            </label>
            <label>
              Magazyn partii Allegro
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
            {operation === 'create_draft' && (
              <PriceListPicker
                label="Cennik partii Allegro"
                value={priceList?.id ?? ''}
                onChange={(p) => {
                  setPriceList(p);
                  changed();
                }}
              />
            )}
            <p>
              {operation === 'create_draft' ? (
                <>
                  Podgląd wykonuje odczyty. Już powiązane SKU zostaną pominięte. Każdy szkic i błąd
                  będzie widoczny przed zatwierdzeniem. Publikacja jest oddzielną operacją.
                </>
              ) : (
                'Podgląd odczytuje wskazane oferty. Dopiero zatwierdzenie uruchomi publikację.'
              )}
            </p>
            <button className="button primary" disabled={busy || !items.length}>
              Przygotuj podgląd partii ({items.length} SKU)
            </button>
          </form>
        </div>
      )}
      <label>
        Partia Allegro
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setAfter('');
            setSearch('');
            setConfirmed(false);
          }}
        >
          <option value="">Wybierz partię</option>
          {list.data.map((b: any) => (
            <option value={b.id} key={b.id}>
              {b.input.name} · {labels[b.state]} · {date(b.created_at)}
            </option>
          ))}
        </select>
      </label>
      <div className="button-row">
        <button className="button" disabled={!listAfter} onClick={() => setListAfter('')}>
          Pierwsza strona partii
        </button>
        <button
          className="button"
          disabled={!list.meta.cursor}
          onClick={() => setListAfter(list.meta.cursor)}
        >
          Kolejne partie Allegro
        </button>
        <button className="button" onClick={() => setRefresh((v) => v + 1)}>
          Odśwież partie Allegro
        </button>
      </div>
      {detail && (
        <div>
          <h4>
            {detail.batch.input.name} ·{' '}
            {detail.batch.input.operation === 'publish' ? 'Publikacja' : 'Szkice'} ·{' '}
            {labels[detail.batch.state]}
          </h4>
          <p>
            {Object.entries(detail.counts)
              .map(([k, v]) => `${labels[k] ?? k}: ${v}`)
              .join(' · ')}
          </p>
          {detail.batch.error && (
            <p role="alert" className="notice import-error">
              {detail.batch.error}
            </p>
          )}
          <label>
            Szukaj SKU w partii Allegro
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setAfter('');
              }}
            />
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU / produkt</th>
                  <th>Oferta / cena / stan / publikacja</th>
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
                      {detail.batch.input.operation === 'publish'
                        ? (i.remote_id ?? i.remote_snapshot?.id)
                        : (i.creation_context?.product?.name ?? i.creation_input.product_id)}
                      <br />
                      {i.payload?.sellingMode?.price?.amount ??
                        i.remote_snapshot?.price?.amount ??
                        '—'}{' '}
                      {i.payload?.sellingMode?.price?.currency ??
                        i.remote_snapshot?.price?.currency ??
                        'PLN'}{' '}
                      brutto ·{' '}
                      {i.payload?.stock?.available ?? i.remote_snapshot?.stock?.available ?? '—'}{' '}
                      szt.
                      <br />
                      {detail.batch.input.operation === 'publish'
                        ? `${i.remote_snapshot?.publication ?? '—'} → ACTIVE`
                        : 'Szkic nieaktywny'}
                      {detail.batch.input.operation !== 'publish' && (
                        <details>
                          <summary>Warunki szkicu {i.sku}</summary>
                          <dl>
                            {Object.entries({
                              shipping_rate_id: 'Cennik dostawy',
                              return_policy_id: 'Zwroty',
                              implied_warranty_id: 'Reklamacje',
                              responsible_producer_id: 'Producent',
                            }).map(([key, label]) => (
                              <div key={key}>
                                <dt>{label}</dt>
                                <dd>
                                  {i.creation_context?.selected?.find(
                                    (r: any) => r.id === i.creation_input[key],
                                  )?.name ?? i.creation_input[key]}
                                </dd>
                              </div>
                            ))}
                            <dt>Czas wysyłki</dt>
                            <dd>
                              {i.creation_input.handling_time === 'PT24H'
                                ? '24 godziny'
                                : i.creation_input.handling_time === 'PT0S'
                                  ? 'Natychmiast'
                                  : i.creation_input.handling_time?.replace(/^P(\d+)D$/, '$1 dni')}
                            </dd>
                            <dt>Bezpieczeństwo produktu</dt>
                            <dd>{i.creation_input.safety_information}</dd>
                            {(i.creation_input.parameters ?? []).map((p: any) => {
                              const def = i.creation_context?.definitions?.find(
                                (d: any) => d.id === p.id,
                              );
                              return (
                                <div key={p.id}>
                                  <dt>{def?.name ?? 'Parametr ' + p.id}</dt>
                                  <dd>
                                    {p.rangeValue
                                      ? `${p.rangeValue.from}–${p.rangeValue.to}`
                                      : (p.values?.join(', ') ??
                                        p.valuesIds
                                          ?.map(
                                            (id: string) =>
                                              def?.dictionary?.find((d: any) => d.id === id)
                                                ?.value ?? id,
                                          )
                                          .join(', '))}
                                  </dd>
                                </div>
                              );
                            })}
                          </dl>
                        </details>
                      )}
                    </td>
                    <td>
                      {labels[i.state] ?? i.state}
                      {i.plan_state &&
                        i.plan_state !== i.state &&
                        ' · Plan: ' + (labels[i.plan_state] ?? i.plan_state)}
                      <br />
                      {i.remote_id}
                      <br />
                      {i.error || i.plan_error}
                      {i.state === 'skipped' &&
                        i.result?.reason === 'existing_mapping' &&
                        'Istniejące powiązanie; bez tworzenia nowej oferty'}
                      {i.plan_result?.scope === 'local_simulation' && ' · Symulacja lokalna'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <button className="button" disabled={!after} onClick={() => setAfter('')}>
              Pierwsze SKU partii
            </button>
            <button
              className="button"
              disabled={!detail.meta.cursor}
              onClick={() => setAfter(detail.meta.cursor)}
            >
              Kolejne SKU partii
            </button>
            <button className="button" onClick={() => setRefresh((v) => v + 1)}>
              Odśwież wynik partii Allegro
            </button>
          </div>
          {detail.batch.state === 'review' && (
            <div className="notice">
              <p>
                Zatwierdzisz {detail.counts.preview ?? 0} poprawnych{' '}
                {detail.batch.input.operation === 'publish' ? 'publikacji' : 'szkiców'}. Błędy i
                pominięcia pozostaną w raporcie. Podglądy wygasają po 30 minutach; zmienione dane
                wymagają nowego podglądu.
              </p>
              {!list.channel.settings.simulation && (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  Potwierdzam{' '}
                  {detail.batch.input.operation === 'publish'
                    ? 'publikację ofert'
                    : 'utworzenie szkiców'}{' '}
                  we wskazanym koncie Allegro.
                </label>
              )}
              <button
                className="button primary"
                disabled={
                  busy ||
                  !detail.counts.preview ||
                  (!list.channel.settings.simulation && !confirmed)
                }
                onClick={() =>
                  run(async () => {
                    await api('/allegro-batches/' + selected + '/queue', 'POST', {
                      version: detail.batch.version,
                      confirm_external: confirmed,
                    });
                  })
                }
              >
                {list.channel.settings.simulation
                  ? detail.batch.input.operation === 'publish'
                    ? 'Uruchom lokalną publikację partii'
                    : 'Uruchom lokalną partię szkiców'
                  : detail.batch.input.operation === 'publish'
                    ? 'Zatwierdź publikację partii Allegro'
                    : 'Zatwierdź partię szkiców Allegro'}
              </button>
            </div>
          )}
          {['preparing', 'review', 'queued', 'failed'].includes(detail.batch.state) && (
            <div>
              <p>
                Przerwanie zatrzymuje kolejne zlecenia. Już zakolejkowane oferty mogą zakończyć
                zapis; ich wyniki pozostaną widoczne.
              </p>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api('/allegro-batches/' + selected + '/cancel', 'POST', {
                      version: detail.batch.version,
                    });
                  })
                }
              >
                Przerwij partię Allegro
              </button>
            </div>
          )}
          {['failed', 'cancelled'].includes(detail.batch.state) && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api('/allegro-batches/' + selected + '/retry', 'POST', {
                    version: detail.batch.version,
                  });
                })
              }
            >
              Wznów partię Allegro
            </button>
          )}
          {detail.batch.state === 'partial' && (
            <div className="notice">
              Uzgodnij niepewne zapisy w planach ofert poniżej. Sprawdzenie raportu nie ponawia
              zapisu ofert.
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api('/allegro-batches/' + selected + '/recheck', 'POST', {
                      version: detail.batch.version,
                    });
                  })
                }
              >
                Sprawdź uzgodnione wyniki Allegro
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
