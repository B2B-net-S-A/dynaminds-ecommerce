import { useEffect, useState } from 'react';
import { api } from './api';

export function ShopifyOfferLocation({
  channelId,
  onChange,
  purpose = 'offers',
}: {
  channelId: string;
  purpose?: 'offers' | 'catalog';
  onChange: () => void;
}) {
  const [page, setPage] = useState<any>(null),
    [selected, setSelected] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setPage(null);
    setError('');
    setSelected('');
    api('/integrations/' + channelId + '/shopify-locations')
      .then((r) => {
        if (active) {
          setPage(r);
          setSelected(r.inventory_location_id ?? '');
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [channelId]);
  async function next() {
    setBusy(true);
    setError('');
    try {
      const r = await api(
        '/integrations/' +
          channelId +
          '/shopify-locations?cursor=' +
          encodeURIComponent(page.next_cursor),
      );
      if (r.inventory_location_id !== page.inventory_location_id)
        throw new Error('Konfigurację zmieniono; otwórz panel ponownie');
      setPage({
        ...r,
        data: [...new Map([...page.data, ...r.data].map((l: any) => [l.id, l])).values()],
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      const r = await api('/integrations/' + channelId + '/shopify-location', 'PATCH', {
        location_id: selected,
        expected_location_id: page.inventory_location_id,
      });
      setPage({ ...page, inventory_location_id: r.inventory_location_id });
      onChange();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="notice">
      <h3>Lokalizacja magazynowa Shopify</h3>
      <p>
        {purpose === 'catalog'
          ? 'Wybierz jedną lokalizację, z której pobierzemy stan początkowy nowych produktów.'
          : 'Stan dostępny wybranego magazynu DYNAMINDS będzie synchronizowany do jednej lokalizacji Shopify. Dla samej ceny wybór lokalizacji jest opcjonalny.'}
      </p>
      {error && <p role="alert">{error}</p>}
      {page && (
        <>
          {page.scope === 'local_simulation' && (
            <p>PRZYKŁAD LOKALNY — lokalizacja demonstracyjna.</p>
          )}
          <label>
            Lokalizacja Shopify{' '}
            <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={busy}>
              <option value="">Wybierz lokalizację Shopify</option>
              {page.inventory_location_id &&
                !page.data.some((l: any) => l.id === page.inventory_location_id) && (
                  <option value={page.inventory_location_id}>
                    {page.inventory_location_id} (zapisana)
                  </option>
                )}
              {page.data.map((l: any) => (
                <option key={l.id} value={l.id} disabled={!l.isActive || !l.fulfillsOnlineOrders}>
                  {l.name} · {l.id}
                  {!l.isActive || !l.fulfillsOnlineOrders ? ' (niedostępna online)' : ''}
                </option>
              ))}
            </select>
          </label>
          {page.has_more && (
            <button onClick={next} disabled={busy}>
              Następne lokalizacje
            </button>
          )}
          <button
            onClick={save}
            disabled={busy || !selected || selected === page.inventory_location_id}
          >
            Zapisz lokalizację Shopify
          </button>
          <p>
            Zmiana lokalizacji wymaga wstrzymanego harmonogramu i uzgodnienia trwających zapisów.
          </p>
        </>
      )}
    </section>
  );
}

export function ShopifyPublicationPicker({
  channelId,
  value,
  onChange,
}: {
  channelId: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [page, setPage] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setPage(null);
    setError('');
    api('/integrations/' + channelId + '/shopify-publications')
      .then((r) => active && setPage(r))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [channelId]);
  async function next() {
    setBusy(true);
    setError('');
    try {
      const r = await api(
        '/integrations/' +
          channelId +
          '/shopify-publications?cursor=' +
          encodeURIComponent(page.next_cursor),
      );
      setPage({
        ...r,
        data: [...new Map([...page.data, ...r.data].map((p: any) => [p.id, p])).values()],
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="notice shopify-publication-note">
      <h3>Kanał publikacji Shopify</h3>
      <p>
        Wybierz dokładnie jeden kanał. Publikowany będzie cały istniejący produkt Shopify wraz z
        wariantami.
      </p>
      {error && <p role="alert">{error}</p>}
      {!page && !error && <p>Odczytywanie kanałów…</p>}
      {page && (
        <>
          {page.scope === 'local_simulation' && <p>PRZYKŁAD LOKALNY — kanał demonstracyjny.</p>}
          <label>
            Publikacja Shopify{' '}
            <select
              value={value}
              onChange={(e) => onChange(e.target.value)}
              disabled={busy}
              required
            >
              <option value="">Wybierz kanał publikacji</option>
              {page.data.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.catalog?.title ?? p.id} · {p.id}
                  {p.catalog?.status && p.catalog.status !== 'ACTIVE'
                    ? ' (' + p.catalog.status + ')'
                    : ''}
                </option>
              ))}
            </select>
          </label>
          {page.has_more && (
            <button type="button" onClick={next} disabled={busy}>
              Następne kanały publikacji
            </button>
          )}
          {!page.data.length && <p>Brak dostępnych publikacji dla tego połączenia.</p>}
        </>
      )}
    </section>
  );
}
