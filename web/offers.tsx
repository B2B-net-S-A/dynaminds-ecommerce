import {OrdinaryConnectorJobControl,type ConnectorJobContext} from './ordinary-connector-job';
import { useEffect, useState } from 'react';
import {LocalWooJobControl,type LocalWooContext} from './configured-woo';
import { api, date, money } from './api';
import { ProductPicker } from './catalog';
import { PriceListPicker } from './pricing';
import { VariantOffersPanel } from './variant-offers';
import { ShopifyOfferLocation, ShopifyPublicationPicker } from './shopify-offers';
import { OfferSyncPanel } from './offer-sync';
import { AllegroCreationFields } from './allegro-creation';
import { AllegroBatchesPanel } from './allegro-batches';
import { EbayApiLimits } from './ebay-api-limits';
import { EbaySellerFields } from './ebay-seller-settings';
const amazonMarketLabel = (id: string) =>
  (
    ({
      A1C3SOZRARQ6R3: 'Amazon.pl',
      A1PA6795UKMFR9: 'Amazon.de',
      A1F83G8C2ARO7P: 'Amazon.co.uk',
      A13V1IB3VIYZZH: 'Amazon.fr',
      APJ6JRA9NG5V4: 'Amazon.it',
      A1RKKUPIHCS9HS: 'Amazon.es',
      ATVPDKIKX0DER: 'Amazon.com',
      A2EUQ1WTGCTBG2: 'Amazon.ca',
      A1AM78C64UM0Y8: 'Amazon.com.mx',
    }) as Record<string, string>
  )[id] ?? id;
const operations: Record<string, string> = {
  create_draft: 'Utwórz szkic w WooCommerce',
  create_group: 'Utwórz grupę wariantów w WooCommerce',
  create_variant: 'Utwórz wariant w WooCommerce',
  publish: 'Opublikuj powiązaną ofertę',
  sync: 'Synchronizuj cenę i stan',
};
const states: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'W kolejce / weryfikacja',
  done: 'Potwierdzony',
  conflict: 'Konflikt przed zapisem',
  failed: 'Błąd / wymaga sprawdzenia',
};
export function OffersPanel({ channelId,localWooContext,connectorContext }: { channelId: string;localWooContext?:LocalWooContext;connectorContext?:ConnectorJobContext }) {
  const syncContext = localWooContext ?? connectorContext;
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0),
    [operation, setOperation] = useState('sync'),
    [warehouse, setWarehouse] = useState(''),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [listing, setListing] = useState(''),
    [listingSearch, setListingSearch] = useState(''),
    [listingData, setListingData] = useState<any>({ data: [], meta: {} }),
    [axisOptions, setAxisOptions] = useState<string[]>([]),
    [axes, setAxes] = useState<string[]>([]),
    [parent, setParent] = useState(''),
    [publication, setPublication] = useState(''),
    [ebayOffer, setEbayOffer] = useState(''),
    [ebayReady, setEbayReady] = useState(false),
    [ebayCreation, setEbayCreation] = useState<any>({
      sku: '',
      category_id: '',
      merchant_location_key: '',
      payment_policy_id: '',
      return_policy_id: '',
      fulfillment_policy_id: '',
      content_language: 'pl-PL',
      condition: 'NEW',
      verify_settings: true,
    }),
    [allegro, setAllegro] = useState<any>(null),
    [stock, setStock] = useState(true),
    [price, setPrice] = useState(true),
    [priceList, setPriceList] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [formOpen, setFormOpen] = useState(true),
    [preview, setPreview] = useState<any>(null),
    [confirmed, setConfirmed] = useState(false),
    [resolvePlan, setResolvePlan] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([api('/integrations/' + channelId + '/offers'), api('/warehouses')])
      .then(([d, w]) => {
        if (active) {
          setData(d);
          setWarehouses(w.data);
          setWarehouse((x) => x || w.data[0]?.id || '');
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [channelId, refresh]);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      api(
        '/integrations/' +
          channelId +
          '/offer-listings?search=' +
          encodeURIComponent(listingSearch),
      )
        .then((d) => {
          if (active) setListingData(d);
        })
        .catch((e) => active && setError(e.message));
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [channelId, listingSearch, refresh]);
  useEffect(() => {
    if (!data?.data.some((p: any) => p.state === 'queued')) return;
    const timer = setInterval(() => setRefresh((x) => x + 1), 2000);
    return () => clearInterval(timer);
  }, [data]);
  useEffect(() => {
    let active = true;
    if (operation !== 'create_group' || !selected) {
      setAxisOptions([]);
      setAxes([]);
      return;
    }
    api('/products/' + selected.id)
      .then((p) => {
        if (!active) return;
        const names = [
          ...new Set<string>(p.variants.flatMap((v: any) => Object.keys(v.attributes))),
        ];
        setAxisOptions(names);
        setAxes(names);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [operation, selected?.id]);
  function change() {
    setPreview(null);
    setConfirmed(false);
    setError('');
  }
  async function prepare(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setPreview(
        await api('/integrations/' + channelId + '/offers/preview', 'POST', {
          product_id: selected.id,
          ...(data.channel.provider === 'ebay' && operation !== 'create_draft' && ebayOffer
            ? { ebay_offer_id: ebayOffer }
            : {}),
          ...(data.channel.provider === 'ebay' && operation === 'create_draft'
            ? { ebay_creation: ebayCreation }
            : {}),
          warehouse_id: warehouse,
          operation,
          ...(data.channel.provider === 'shopify' && operation === 'publish'
            ? { publication_id: publication }
            : {}),
          ...(operation === 'create_group' ? { variation_axes: axes } : {}),
          ...(data.channel.provider === 'allegro' && operation === 'create_draft'
            ? { allegro }
            : {}),
          ...(listing ? { listing_id: listing } : {}),
          ...(parent ? { parent_external_id: parent } : {}),
          stock,
          price,
          ...(price && priceList ? { price_list_id: priceList.id } : {}),
        }),
      );
      setConfirmed(false);
      setRefresh((x) => x + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function queue() {
    setBusy(true);
    setError('');
    try {
      await api('/offer-plans/' + preview.id + '/queue', 'POST', { confirm_live: confirmed });
      setPreview(null);
      setFormOpen(false);
      setRefresh((x) => x + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function cancelWait(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/offer-plans/${id}/cancel-wait`, 'POST', {});
      setRefresh((x) => x + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <p>{error || 'Wczytywanie ofert…'}</p>;
  return (
    <div className="offers-panel">
      {data.channel.provider === 'shopify' && (
        <ShopifyOfferLocation
          channelId={channelId}
          onChange={() => {
            setPreview(null);
            setConfirmed(false);
            setRefresh((x) => x + 1);
          }}
        />
      )}
      {data.channel.provider === 'ebay' && (
        <EbayApiLimits channelId={channelId} refresh={refresh} />
      )}
      <OfferSyncPanel channelId={channelId} context={syncContext && {...syncContext, externalWriteBlocked: !!syncContext.externalWriteBlocked}} />
      {data.channel.provider === 'woocommerce' && (
        <VariantOffersPanel channelId={channelId} warehouses={warehouses} />
      )}
      {data.channel.provider === 'allegro' && (
        <AllegroBatchesPanel channelId={channelId} warehouses={warehouses} />
      )}
      <h3>{data.channel.name}</h3>
      <div className="notice">
        {data.channel.settings.simulation
          ? 'PRZYKŁAD LOKALNY — podgląd i kolejka działają na danych demonstracyjnych. Nie wysyłamy żądań do dostawcy.'
          : 'Podgląd pobiera dane z API. Zapis jest osobnym zadaniem; wynik jest potwierdzany odczytem dostawcy.'}
      </div>
      {error && (
        <div className="notice import-error" role="alert">
          {error}
        </div>
      )}
      <button className="button" disabled={busy} onClick={() => setFormOpen((x) => !x)}>
        {formOpen ? 'Ukryj formularz' : 'Przygotuj nową zmianę'}
      </button>
      {formOpen && (
        <form onSubmit={prepare} className="offer-form">
          <label>
            Operacja
            <select
              value={operation}
              onChange={(e) => {
                setOperation(e.target.value);
                const withValues =
                  e.target.value !== 'create_group' &&
                  !(
                    ['shopify', 'ebay'].includes(data.channel.provider) &&
                    e.target.value === 'publish'
                  );
                setStock(withValues);
                setPrice(withValues);
                setPublication('');
                setEbayOffer('');
                setParent('');
                setListing('');
                setSelected(null);
                change();
              }}
            >
              {Object.entries(operations)
                .filter(([k]) =>
                  ['shopify', 'ebay'].includes(data.channel.provider)
                    ? [
                        'sync',
                        'publish',
                        ...(data.channel.provider === 'ebay' ? ['create_draft'] : []),
                      ].includes(k)
                    : ['prestashop', 'amazon'].includes(data.channel.provider)
                      ? k === 'sync'
                      : !k.startsWith('create_') ||
                        data.channel.provider === 'woocommerce' ||
                        (data.channel.provider === 'allegro' && k === 'create_draft'),
                )
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {k === 'publish' && data.channel.provider === 'shopify'
                      ? 'Opublikuj cały produkt Shopify'
                      : k === 'publish' && data.channel.provider === 'ebay'
                        ? 'Opublikuj szkic eBay Inventory'
                        : k === 'create_draft' && data.channel.provider === 'ebay'
                          ? 'Utwórz szkic w eBay'
                          : k === 'create_draft' && data.channel.provider === 'allegro'
                            ? 'Utwórz szkic w Allegro'
                            : v}
                  </option>
                ))}
            </select>
          </label>
          {operation.startsWith('create_') ? (
            <ProductPicker
              label="Produkt do oferty"
              value={selected?.id ?? ''}
              initial={selected}
              filter={(p) =>
                operation === 'create_group'
                  ? p.kind === 'group'
                  : operation === 'create_variant'
                    ? p.kind === 'variant'
                    : data.channel.provider === 'allegro'
                      ? ['simple', 'variant'].includes(p.kind)
                      : ['simple', 'bundle'].includes(p.kind)
              }
              select={(p) => {
                setSelected(p);
                setEbayCreation((v: any) => ({
                  ...v,
                  sku: p.sku,
                  reuse_inventory_plan_id: undefined,
                }));
                change();
              }}
            />
          ) : (
            <div>
              <label>
                Szukaj powiązania po SKU, nazwie lub ID
                <input
                  disabled={busy}
                  value={listingSearch}
                  onChange={(e) => {
                    setListingSearch(e.target.value);
                    setListing('');
                    setSelected(null);
                    change();
                  }}
                />
              </label>
              <label>
                Powiązana oferta
                <select
                  required
                  value={listing}
                  onChange={(e) => {
                    const l = listingData.data.find((l: any) => l.id === e.target.value);
                    setListing(e.target.value);
                    setSelected(
                      l
                        ? {
                            id: l.product_id,
                            sku: l.sku,
                            name: l.name,
                            kind: l.kind,
                            listing_id: l.id,
                            external_id: l.external_id,
                          }
                        : null,
                    );
                    setParent(l?.parent_external_id ?? '');
                    const withValues =
                      l?.kind !== 'group' &&
                      !(
                        ['shopify', 'ebay'].includes(data.channel.provider) &&
                        operation === 'publish'
                      );
                    setStock(withValues);
                    setPrice(withValues);
                    change();
                  }}
                >
                  <option value="">Wybierz powiązanie</option>
                  {selected?.listing_id &&
                    !listingData.data.some((l: any) => l.id === selected.listing_id) && (
                      <option value={selected.listing_id}>
                        {selected.sku} · ID {selected.external_id}
                      </option>
                    )}
                  {listingData.data.map((l: any) => (
                    <option key={l.id} value={l.id}>
                      {l.sku} · ID {l.external_id}
                    </option>
                  ))}
                </select>
              </label>
              {listingData.meta.cursor && (
                <button
                  type="button"
                  className="button small-btn"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const d = await api(
                        '/integrations/' +
                          channelId +
                          '/offer-listings?search=' +
                          encodeURIComponent(listingSearch) +
                          '&after=' +
                          listingData.meta.cursor,
                      );
                      setListingData({ ...d, data: [...listingData.data, ...d.data] });
                    } catch (e: any) {
                      setError(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Więcej powiązań
                </button>
              )}
            </div>
          )}
          {data.channel.provider === 'allegro' && operation === 'create_draft' && (
            <AllegroCreationFields
              channelId={channelId}
              onChange={(value) => {
                setAllegro(value);
                change();
              }}
            />
          )}
          {data.channel.provider === 'ebay' && operation === 'create_draft' && (
            <fieldset>
              <legend>Szkic eBay Inventory</legend>
              <p>
                Wybierz kategorię, istniejącą lokalizację oraz warunki sprzedaży tego konta eBay.
                Produkt wymaga opisu i publicznych zdjęć HTTPS. Cena pochodzi z cennika, stan z
                magazynu po rezerwacjach. Publikacja jest osobnym krokiem.
              </p>
              <EbaySellerFields
                channelId={channelId}
                productId={selected?.id}
                value={ebayCreation}
                onReady={setEbayReady}
                onChange={(v) => {
                  setEbayCreation(v);
                  change();
                }}
              />
              {[
                ['sku', 'SKU w eBay'],
                ['category_id', 'ID kategorii eBay'],
                ['merchant_location_key', 'Klucz lokalizacji eBay'],
                ['payment_policy_id', 'ID warunków płatności eBay'],
                ['return_policy_id', 'ID warunków zwrotu eBay'],
                ['fulfillment_policy_id', 'ID warunków dostawy eBay'],
              ]
                .filter(([key]) => key === 'sku' || !ebayCreation.verify_settings)
                .map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      required
                      value={ebayCreation[key]}
                      onChange={(e) => {
                        setEbayCreation((v: any) => ({ ...v, [key]: e.target.value }));
                        change();
                      }}
                    />
                  </label>
                ))}
              <label>
                Język treści eBay
                <select
                  value={ebayCreation.content_language}
                  onChange={(e) => {
                    setEbayCreation((v: any) => ({ ...v, content_language: e.target.value }));
                    change();
                  }}
                >
                  {[
                    'pl-PL',
                    'de-DE',
                    'en-GB',
                    'en-US',
                    'en-AU',
                    'en-CA',
                    'fr-CA',
                    'fr-FR',
                    'it-IT',
                    'es-ES',
                    'nl-NL',
                    'nl-BE',
                    'fr-BE',
                    'de-AT',
                    'de-CH',
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Stan produktu eBay
                <select
                  value={ebayCreation.condition}
                  onChange={(e) => {
                    setEbayCreation((v: any) => ({ ...v, condition: e.target.value }));
                    change();
                  }}
                >
                  {[
                    'NEW',
                    'NEW_OTHER',
                    'NEW_WITH_DEFECTS',
                    'LIKE_NEW',
                    'USED_EXCELLENT',
                    'USED_VERY_GOOD',
                    'USED_GOOD',
                    'USED_ACCEPTABLE',
                    'FOR_PARTS_OR_NOT_WORKING',
                    'SELLER_REFURBISHED',
                    'CERTIFIED_REFURBISHED',
                    'EXCELLENT_REFURBISHED',
                    'VERY_GOOD_REFURBISHED',
                    'GOOD_REFURBISHED',
                    'PRE_OWNED_EXCELLENT',
                    'PRE_OWNED_FAIR',
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Opis stanu produktu (opcjonalnie)
                <input
                  maxLength={1000}
                  value={ebayCreation.condition_description ?? ''}
                  onChange={(e) => {
                    setEbayCreation((v: any) => ({ ...v, condition_description: e.target.value }));
                    change();
                  }}
                />
              </label>
              <label>
                Zachowany rekord Inventory
                <select
                  value={ebayCreation.reuse_inventory_plan_id ?? ''}
                  onChange={(e) => {
                    setEbayCreation((v: any) => ({
                      ...v,
                      reuse_inventory_plan_id: e.target.value || undefined,
                    }));
                    change();
                  }}
                >
                  <option value="">Nowe SKU — rekord nie może istnieć</option>
                  {data.data
                    .filter(
                      (p: any) =>
                        p.product_id === selected?.id &&
                        p.payload.sku === ebayCreation.sku &&
                        p.state === 'done' &&
                        p.result?.retained_inventory,
                    )
                    .map((p: any) => (
                      <option key={p.id} value={p.id}>
                        {p.payload.sku} · {date(p.completed_at)} · zastąp własny zachowany rekord
                      </option>
                    ))}
                </select>
              </label>
            </fieldset>
          )}
          <label>
            Magazyn źródłowy
            <select
              required
              value={warehouse}
              onChange={(e) => {
                setWarehouse(e.target.value);
                change();
              }}
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          {price && (
            <PriceListPicker
              label="Cennik oferty"
              value={priceList?.id ?? ''}
              onChange={(l) => {
                setPriceList(l);
                change();
              }}
            />
          )}
          {operation === 'create_group' && (
            <fieldset>
              <legend>Parametry rozróżniające warianty</legend>
              {axisOptions.map((a) => (
                <label key={a}>
                  <input
                    type="checkbox"
                    checked={axes.includes(a)}
                    onChange={(e) => {
                      setAxes((v) => (e.target.checked ? [...v, a] : v.filter((x) => x !== a)));
                      change();
                    }}
                  />
                  {a}
                </label>
              ))}
              {!axisOptions.length && (
                <p>Wybierz grupę z wariantami i uzupełnionymi parametrami.</p>
              )}
            </fieldset>
          )}
          {data.channel.provider === 'woocommerce' &&
            !['create_draft', 'create_group'].includes(operation) && (
              <label>
                ID rodzica wariantu WooCommerce (jeśli dotyczy)
                <input
                  value={parent}
                  required={operation === 'create_variant'}
                  onChange={(e) => {
                    setParent(e.target.value);
                    change();
                  }}
                  placeholder="Puste dla produktu prostego"
                />
              </label>
            )}
          {data.channel.provider === 'ebay' && operation !== 'create_draft' && (
            <label>
              {operation === 'publish'
                ? 'ID szkicu eBay (wymagane)'
                : 'ID oferty eBay (opcjonalne, dla wielu ofert tego SKU)'}
              <input
                value={ebayOffer}
                onChange={(e) => {
                  setEbayOffer(e.target.value);
                  change();
                }}
              />
            </label>
          )}
          {data.channel.provider === 'shopify' && operation === 'publish' && (
            <ShopifyPublicationPicker
              channelId={channelId}
              value={publication}
              onChange={(id) => {
                setPublication(id);
                change();
              }}
            />
          )}
          {data.channel.provider === 'ebay' && operation === 'publish' && (
            <div className="notice">
              Publikacja użyje ceny, ilości, treści i warunków istniejącego szkicu eBay. Może
              rozpocząć sprzedaż i naliczyć opłaty eBay. Najpierw sprawdź tożsamość konta w
              Integracjach.
            </div>
          )}
          <div className="offer-flags">
            <label>
              <input
                type="checkbox"
                checked={stock}
                disabled={
                  operation === 'create_group' ||
                  selected?.kind === 'group' ||
                  (data.channel.provider === 'ebay' &&
                    ['publish', 'create_draft'].includes(operation)) ||
                  (data.channel.provider === 'allegro' && operation === 'create_draft')
                }
                onChange={(e) => {
                  setStock(e.target.checked);
                  change();
                }}
              />
              Synchronizuj dostępny stan
            </label>
            <label>
              <input
                type="checkbox"
                checked={price}
                disabled={
                  operation === 'create_group' ||
                  selected?.kind === 'group' ||
                  (data.channel.provider === 'ebay' &&
                    ['publish', 'create_draft'].includes(operation)) ||
                  (data.channel.provider === 'allegro' && operation === 'create_draft')
                }
                onChange={(e) => {
                  setPrice(e.target.checked);
                  change();
                }}
              />
              Synchronizuj cenę
            </label>
          </div>
          <button
            className="button primary"
            disabled={
              busy ||
              !selected ||
              !warehouse ||
              (operation === 'create_group' && !axes.length) ||
              (data.channel.provider === 'shopify' && operation === 'publish' && !publication) ||
              (data.channel.provider === 'ebay' && operation === 'publish' && !ebayOffer.trim()) ||
              (data.channel.provider === 'ebay' &&
                operation === 'create_draft' &&
                ebayCreation.verify_settings &&
                !ebayReady)
            }
          >
            {busy ? 'Przygotowywanie…' : 'Przygotuj podgląd'}
          </button>
        </form>
      )}
      {preview && (
        <section className="offer-preview">
          <h3>Podgląd: {preview.sku}</h3>
          <p>
            {preview.publication ? (
              'Publikacja istniejącego szkicu. Cena i dostępność pochodzą z eBay.'
            ) : selected?.kind === 'group' ? (
              'Grupa: parametry wariantów. Ceny i stany należą do osobnych SKU.'
            ) : (
              <>
                Magazyn: {warehouses.find((w) => w.id === warehouse)?.name} · dostępne{' '}
                {preview.quantity} szt. · {preview.currency} · cena API{' '}
                {preview.price_basis === 'net' ? 'netto' : 'brutto'}
              </>
            )}
          </p>
          {preview.draft && (
            <div className="notice ebay-inventory-note">
              <h4>Nowy szkic eBay — bez publikacji</h4>
              <p>
                {preview.draft.title} · SKU {preview.draft.sku} · {preview.draft.marketplace}
              </p>
              <p>
                {money(
                  Math.round(Number(preview.draft.price.value) * 100),
                  preview.draft.price.currency,
                )}{' '}
                · {preview.draft.quantity} szt. · {preview.draft.condition} ·{' '}
                {preview.draft.language}
              </p>
              <p>
                Kategoria{' '}
                {preview.draft.requirements?.category.category.categoryName ??
                  preview.draft.category}{' '}
                · lokalizacja {preview.draft.location} · zdjęcia: {preview.draft.images.length}
              </p>
              <p>
                Warunki: płatność{' '}
                {preview.draft.requirements?.policies.payment.name ??
                  preview.draft.policies.paymentPolicyId}{' '}
                · zwrot{' '}
                {preview.draft.requirements?.policies.return.name ??
                  preview.draft.policies.returnPolicyId}{' '}
                · dostawa{' '}
                {preview.draft.requirements?.policies.fulfillment.name ??
                  preview.draft.policies.fulfillmentPolicyId}
              </p>
              <details>
                <summary>Opis produktu</summary>
                <p>{preview.draft.description}</p>
              </details>
              {preview.draft.reuses_inventory && (
                <p>
                  Zastąpimy własny rekord zachowany po poprzednim planie, po potwierdzeniu jego
                  treści i braku ofert.
                </p>
              )}
              <p>
                {preview.draft.requirements
                  ? 'Sprawdzono wymagane parametry, wartości słownikowe i zależności kategorii. '
                  : 'ID wpisano ręcznie; nie odczytano parametrów kategorii ani warunków Account. '}
                Dostępność zdjęć i ostateczne wymagania publikacji sprawdza eBay.
              </p>
              <p>
                Parametry:{' '}
                {Object.entries(preview.draft.aspects ?? {})
                  .map(([k, v]: any) => k + ': ' + v.join(', '))
                  .join(' · ')}
              </p>
            </div>
          )}
          {preview.publication && (
            <div className="notice ebay-inventory-note">
              <h4>Publikacja szkicu eBay</h4>
              <p>
                {preview.publication.title} · {preview.publication.offer_id} ·{' '}
                {preview.publication.marketplace}
              </p>
              <p>
                Kategoria: {preview.publication.category_id} · stan produktu:{' '}
                {preview.publication.condition} · zdjęcia: {preview.publication.image_urls.length}
              </p>
              <details>
                <summary>Opis szkicu</summary>
                <p>{preview.publication.description}</p>
              </details>
              <p>
                Cena szkicu:{' '}
                {money(
                  Math.round(Number(preview.publication.price.value) * 100),
                  preview.publication.price.currency,
                )}{' '}
                · dostępność eBay: {preview.publication.quantity} jednostek sprzedaży · status:{' '}
                {preview.publication.status}
              </p>
              <p>
                Lokalizacja: {preview.publication.merchant_location_key} · czas:{' '}
                {preview.publication.listing_duration}
              </p>
              <p>
                Warunki: płatność {preview.publication.listing_policies.paymentPolicyId} · zwrot{' '}
                {preview.publication.listing_policies.returnPolicyId} · dostawa{' '}
                {preview.publication.listing_policies.fulfillmentPolicyId}
              </p>
              <p>
                Publikacja nie zmienia ceny ani stanu. Wymagania kategorii ostatecznie sprawdza
                eBay.
              </p>
            </div>
          )}
          {preview.revision_budget && (
            <p className="notice">
              Budżet eBay: maksymalnie {preview.revision_budget.limit} prób zmiany każdej aukcji w
              ciągu {preview.revision_budget.window_hours} godzin. Liczba aukcji:{' '}
              {preview.revision_budget.listing_ids.length}. Licznik jest wspólny dla połączeń tego
              konta. Po wyczerpaniu zadanie poczeka przed zapisem.
            </p>
          )}
          {preview.affected_offers && (
            <div className="notice ebay-inventory-note">
              <h4>Wspólna dostępność SKU eBay</h4>
              <p>
                Pula SKU obejmuje wszystkie rynki. Pozostałe przydziały ofert pozostają bez zmian,
                lecz wspólna pula może ograniczyć ich dostępność. Stan 0 zależy od ustawienia
                Out-of-Stock Control na koncie eBay.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Oferta / rynek</th>
                    <th>Dostępność</th>
                    <th>Cena</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.affected_offers.map((o: any) => (
                    <tr key={o.offer_id}>
                      <td>
                        {o.offer_id} · {o.marketplace}
                      </td>
                      <td>
                        {o.quantity_before} → {o.quantity_after}
                      </td>
                      <td>
                        {o.price_before && o.price_after ? (
                          <>
                            {money(
                              Math.round(Number(o.price_before.value) * 100),
                              o.price_before.currency,
                            )}{' '}
                            →{' '}
                            {money(
                              Math.round(Number(o.price_after.value) * 100),
                              o.price_after.currency,
                            )}
                          </>
                        ) : (
                          'Brak ceny'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.before?.capture_publication && (
            <div className="notice shopify-publication-note">
              <h4>Publikacja całego produktu: {preview.before.product_title}</h4>
              <p>
                {preview.before.product_id} ·{' '}
                {preview.before.variants_count_precision === 'AT_LEAST' ? 'co najmniej ' : ''}
                {preview.before.variants_count} wariantów
              </p>
              <p>
                Kanał: {preview.before.publication_title} · {preview.before.publication_id}
              </p>
              <p>
                Status produktu: {preview.before.status} → {preview.payload.product_status}.
                Publikacja w kanale: {preview.before.published ? 'opublikowany' : 'nieopublikowany'}{' '}
                → opublikowany.
              </p>
              <p>
                Publikacja obejmuje wszystkie warianty tego produktu. Aktywacja produktu może
                udostępnić go także w kanałach, w których był wcześniej opublikowany. Cena i stan
                dotyczą tylko wybranego wariantu, jeśli zaznaczono ich synchronizację.
              </p>
              {preview.before.requires_selling_plan && (
                <p>
                  Produkt wymaga subskrypcji. Shopify dopuszcza jego publikację tylko w sklepie
                  online; dostępność wybranego kanału sprawdzi API.
                </p>
              )}
              <p>
                Potwierdzenie publikacji w API wymaga osobnej weryfikacji widoczności i zakupu w
                sklepie lub rynku.
              </p>
            </div>
          )}
          {preview.provider === 'amazon' && (
            <div className="notice">
              <strong>Amazon · istniejąca oferta {preview.before.sku}</strong>
              <p>
                Cena podstawowa: {preview.before.regular_price ?? 'brak'} {preview.before.currency}.
                Aktualna B2C:{' '}
                {preview.before.current_b2c_price_minor === null
                  ? 'brak'
                  : (preview.before.current_b2c_price_minor / 100).toFixed(2)}{' '}
                {preview.before.current_b2c_currency}. Dostępność FBM:{' '}
                {preview.before.stock_quantity ?? 'brak'}.
              </p>
              <p>
                Regionalne rynki objęte wspólnym stanem:{' '}
                {preview.before.regional_markets.map(amazonMarketLabel).join(', ')}. Przyjęcie
                żądania przez Amazon jest potwierdzane osobnym odczytem. Dostępność oferty do zakupu
                wymaga oddzielnej kontroli.
              </p>
            </div>
          )}
          {preview.warning && <div className="notice">{preview.warning}</div>}
          {preview.provider === 'amazon' && (
            <div className="offer-comparison">
              <div>
                <h4>Obecna oferta</h4>
                <p>
                  Cena podstawowa: {preview.before.regular_price ?? 'brak'}{' '}
                  {preview.before.currency}
                </p>
                <p>
                  Dostępność z własnego magazynu (FBM): {preview.before.stock_quantity ?? 'brak'}{' '}
                  szt.
                </p>
              </div>
              <div>
                <h4>Po zatwierdzeniu</h4>
                <p>
                  Cena podstawowa:{' '}
                  {preview.payload.patches
                    .find((p: any) => p.path === '/attributes/purchasable_offer')
                    ?.value[0].our_price[0].schedule[0].value_with_tax?.toFixed(2) ??
                    preview.before.regular_price}{' '}
                  {preview.before.currency}
                </p>
                <p>
                  Dostępność z własnego magazynu (FBM):{' '}
                  {preview.payload.patches.find(
                    (p: any) => p.path === '/attributes/fulfillment_availability',
                  )?.value[0].quantity ?? preview.before.stock_quantity}{' '}
                  szt.
                </p>
              </div>
            </div>
          )}
          {preview.provider !== 'amazon' && !preview.publication && !preview.draft && (
            <div className="offer-comparison">
              <div>
                <h4>Obecne dane dostawcy</h4>
                <pre>{JSON.stringify(preview.before ?? { new_product: true }, null, 2)}</pre>
              </div>
              <div>
                <h4>Żądana zmiana</h4>
                <pre>{JSON.stringify(preview.payload, null, 2)}</pre>
              </div>
            </div>
          )}
          {(preview.mode === 'live' ||
            ['prestashop', 'shopify', 'ebay', 'amazon'].includes(preview.provider)) &&
            preview.scope !== 'local_simulation' && (
              <label className="offer-live">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                Potwierdzam zapis tych zmian w rzeczywistym koncie dostawcy.
              </label>
            )}
          <button
            className="button primary"
            disabled={
              busy ||
              ((preview.mode === 'live' ||
                ['prestashop', 'shopify', 'ebay', 'amazon'].includes(preview.provider)) &&
                preview.scope !== 'local_simulation' &&
                !confirmed)
            }
            onClick={queue}
          >
            {preview.scope === 'local_simulation'
              ? 'Uruchom symulację zapisu'
              : 'Zatwierdź i dodaj do kolejki'}
          </button>
        </section>
      )}
      <div className="panel-heading">
        <h3>Plany i wyniki</h3>
        <button className="button" disabled={busy} onClick={() => setRefresh((x) => x + 1)}>
          Odśwież wyniki
        </button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Produkt / data</th>
              <th>Operacja</th>
              <th>Stan</th>
              <th>Wynik</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((p: any) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.sku}</strong>
                  <small>{date(p.created_at)}</small>
                </td>
                <td>
                  {p.payload.publication_id
                    ? 'Publikacja całego produktu Shopify'
                    : p.operation === 'publish' && data.channel.provider === 'ebay'
                      ? 'Opublikuj szkic eBay'
                      : p.operation === 'create_draft' && data.channel.provider === 'ebay'
                        ? 'Utwórz szkic w eBay'
                        : p.operation === 'create_draft' && data.channel.provider === 'allegro'
                          ? 'Utwórz szkic w Allegro'
                          : operations[p.operation]}
                </td>
                <td>
                  {p.result?.scope === 'external_api_observed'
                    ? 'Zamknięty po odczycie'
                    : states[p.state]}
                </td>
                <td>
                  {p.result?.scope === 'local_simulation'
                    ? 'Symulacja lokalna'
                    : p.result?.scope === 'external_api_observed'
                      ? 'Odczyt API — zamknięto wynik'
                      : p.result?.scope === 'external_api_verified'
                        ? 'Potwierdzono w API'
                        : p.phase === 'write_started' || p.phase === 'verify'
                          ? 'Weryfikacja możliwego zapisu'
                          : ''}
                  {p.remote_id && <small>ID: {p.remote_id}</small>}
                  {p.result?.ebay_offer_id && <small>Oferta eBay: {p.result.ebay_offer_id}</small>}
                  {p.result?.retained_inventory && (
                    <small>
                      Zachowano Inventory bez oferty. W nowym podglądzie możesz wybrać ten rekord do
                      ponownego przygotowania szkicu.
                    </small>
                  )}
                  {p.payload.publish && data.channel.provider === 'ebay' && (
                    <small>Oferta eBay: {p.payload.offer_id}</small>
                  )}
                  {p.result?.ebay_publication?.listing_id && (
                    <small>
                      Listing eBay: {p.result.ebay_publication.listing_id} ·{' '}
                      {p.result.ebay_publication.status}
                    </small>
                  )}

                  <small>
                    {warehouses.find((w) => w.id === p.warehouse_id)?.name}
                    {p.payload.publication_id && (
                      <small>
                        Cały produkt: {p.remote_snapshot.product_title} ·{' '}
                        {p.remote_snapshot.variants_count_precision === 'AT_LEAST'
                          ? 'co najmniej '
                          : ''}
                        {p.remote_snapshot.variants_count} wariantów ·{' '}
                        {p.remote_snapshot.publication_title}
                      </small>
                    )}
                    {p.payload.stock_quantity !== undefined || p.payload.stock
                      ? ` · stan ${p.payload.stock_quantity ?? p.payload.stock.available} szt.`
                      : ''}
                    {p.payload.regular_price || p.payload.sellingMode?.price
                      ? ` · cena API ${p.payload.regular_price ?? p.payload.sellingMode.price.amount} ${p.local_snapshot.currency}`
                      : ''}
                  </small>
                  {data.channel.provider === 'amazon' && p.result?.actual_snapshot && (
                    <small>
                      Cena podstawowa {p.result.actual_snapshot.regular_price}{' '}
                      {p.result.actual_snapshot.currency} · dostępność FBM{' '}
                      {p.result.actual_snapshot.stock_quantity ?? 'brak'} szt.
                    </small>
                  )}
                  {p.result?.local_changed && (
                    <small>Stan lokalny zmienił się; przygotuj nową synchronizację.</small>
                  )}
                  {p.error && <small className="negative">{p.error}</small>}
                  {localWooContext&&p.job_id&&<LocalWooJobControl key={p.job_id} {...localWooContext} channelId={channelId} jobId={p.job_id} onChanged={()=>setRefresh(x=>x+1)}/>}
                  {!localWooContext&&connectorContext&&data.channel.provider==='allegro'&&data.channel.settings.simulation===false&&p.job_id&&<OrdinaryConnectorJobControl {...connectorContext} externalWriteBlocked={connectorContext.externalWriteBlocked||busy} jobId={p.job_id} kind="offer.write" onChanged={()=>setRefresh(x=>x+1)}/>}
                  {p.state === 'queued' && p.job_state === 'pending' && p.provider_wait_until && (
                    <small>
                      Oczekiwanie na API: {date(p.provider_wait_until)}.{' '}
                      {p.phase === 'ready'
                        ? 'Zapis jeszcze nie rozpoczęty.'
                        : 'Wznowienie sprawdzi trwały etap operacji.'}
                    </small>
                  )}
                  {p.state === 'queued' &&
                    p.phase === 'ready' &&
                    (p.result?.ebay_revision_wait_until || p.provider_wait_until) && (
                      <div>
                        <small>
                          Najwcześniejsza próba: {date(p.job_run_at)}. Dane będą ponownie sprawdzone
                          przed zapisem.
                        </small>
                        <button
                          className="button"
                          disabled={busy || p.job_state !== 'pending'}
                          onClick={() => cancelWait(p.id)}
                        >
                          Anuluj oczekiwanie
                        </button>
                      </div>
                    )}
                  {p.result?.desired_applied === false && (
                    <small className="negative">
                      Żądana zmiana nie została potwierdzona. Przygotuj nowy plan.
                    </small>
                  )}
                  {p.state === 'failed' && ['write_started', 'verify'].includes(p.phase) && (
                    <button
                      className="button small-btn"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          await api('/offer-plans/' + p.id + '/reconcile', 'POST');
                          setRefresh((x) => x + 1);
                        } catch (e: any) {
                          setError(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Uzgodnij wynik
                    </button>
                  )}
                  {p.state === 'failed' && ['write_started', 'verify'].includes(p.phase) && (
                    <button
                      className="button small-btn"
                      disabled={busy}
                      onClick={() => setResolvePlan(p.id)}
                    >
                      Zamknij na podstawie odczytu
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {resolvePlan && (
        <div className="notice">
          <p>
            Ta operacja tylko odczyta aktualny stan dostawcy i zamknie poprzedni plan. Nie ponowi
            wcześniejszego zapisu. Brak zgodności z planem zostanie zapisany jawnie, a nową zmianę
            przygotujesz z nowego podglądu.
          </p>
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('/offer-plans/' + resolvePlan + '/reconcile', 'POST', {
                  accept_observed: true,
                });
                setResolvePlan(null);
                setRefresh((x) => x + 1);
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Potwierdzam odczyt i zamknięcie
          </button>
          <button className="button" disabled={busy} onClick={() => setResolvePlan(null)}>
            Wróć
          </button>
        </div>
      )}
      {data.meta.cursor && (
        <button
          className="button"
          onClick={async () => {
            setBusy(true);
            try {
              const d = await api(
                '/integrations/' + channelId + '/offers?after=' + data.meta.cursor,
              );
              setData({ ...d, data: [...data.data, ...d.data] });
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Więcej planów
        </button>
      )}
    </div>
  );
}
