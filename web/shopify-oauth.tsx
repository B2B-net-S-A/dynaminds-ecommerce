import { useEffect, useState } from 'react';
import { api } from './api';
import type { ShopifyLocale } from '../server/shopify-translation-api';
export function ShopifyOAuthPanel({ channel }: { channel: any }) {
  const [account, setAccount] = useState<any>(null),
    [started, setStarted] = useState<any>(null),
    [same, setSame] = useState(false),
    [returned, setReturned] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [outcome, setOutcome] = useState(''),
    [locales, setLocales] = useState<{ source: string; locales: ShopifyLocale[] } | null>(null),
    [writes, setWrites] = useState({
      products_write: false,
      inventory_write: false,
      publications_write: false,
      fulfillment_write: false,
      translations_write: false,
    });
  const reload = async () => {
    const value = await api(`/integrations/${channel.id}/shopify-account`);
    setAccount(value);
    return value;
  };
  useEffect(() => {
    setLocales(null);
    reload()
      .then((value) =>
        setWrites({
          products_write: value.scopes.includes('write_products'),
          inventory_write: value.scopes.includes('write_inventory'),
          publications_write: value.scopes.includes('write_publications'),
          fulfillment_write: value.scopes.includes('write_merchant_managed_fulfillment_orders'),
          translations_write: value.scopes.includes('write_translations'),
        }),
      )
      .catch((e) => setError(e.message));
  }, [channel.id]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setOutcome('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await reload().catch(() => {});
    }
  }
  const finish = (value: string) =>
    run(async () => {
      const r = await api('/oauth/shopify/finish', 'POST', { return_url: value });
      setOutcome(
        r.scope === 'local_simulation'
          ? 'Sklep przypisany w lokalnej symulacji. Nie wykonano żądań Shopify.'
          : 'Zgoda zapisana; API potwierdziło ID sklepu i zakresy. Harmonogramy pozostają wyłączone.',
      );
      setStarted(null);
      setLocales(null);
      setReturned('');
      setSame(false);
    });
  const needsConfirmation =
    (account?.bound || account?.has_access_token) && !channel.settings.simulation;
  return (
    <section className="ebay-oauth-panel shopify-oauth-panel">
      <h3>{channel.name}</h3>
      <p>
        {channel.settings.simulation
          ? 'Lokalny przykład — bez konta i połączeń Shopify.'
          : 'OAuth sklepu Shopify; token offline jest automatycznie odświeżany przed wygaśnięciem.'}
      </p>
      {error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      {outcome && (
        <p className="notice" role="status">
          {outcome}
        </p>
      )}
      {account && (
        <div className="notice">
          <strong>{account.bound ? 'Sklep przypisany' : 'Sklep nieprzypisany'}</strong>
          <p>{account.store_url}</p>
          <p>ID: {account.shop_id ?? 'Zostanie odczytane przy połączeniu'}</p>
          {account.bound && (
            <>
              <p>
                Źródło:{' '}
                {account.source === 'simulation' ? 'lokalna symulacja' : 'odczyt GraphQL API'}
              </p>
              <p>Zakresy: {account.scopes.join(', ')}</p>
            </>
          )}
          {account.token_expires_at && (
            <p>Token wygasa: {new Date(account.token_expires_at).toLocaleString('pl-PL')}</p>
          )}
          {account.refresh_expires_at && (
            <p>
              Możliwość odświeżania do:{' '}
              {new Date(account.refresh_expires_at).toLocaleString('pl-PL')}
            </p>
          )}
          {!account.grant_matches && (
            <p role="alert">Dane połączenia zmieniły się. Przywróć pierwotny sklep i aplikację.</p>
          )}
          {account.pending && (
            <p>
              {account.pending_state === 'failed'
                ? 'Wymiana nie została ukończona. Rozpocznij nową zgodę.'
                : account.pending_expired
                  ? 'Próba wygasła. Anuluj ją lub rozpocznij nową.'
                  : 'Trwa próba połączenia. Synchronizacja jest zatrzymana.'}
            </p>
          )}
        </div>
      )}
      {!channel.settings.simulation && (
        <>
          <p>
            W aplikacji Shopify zarejestruj dokładny adres powrotu{' '}
            <code>
              {channel.settings.oauth_redirect_uri ||
                'http://127.0.0.1:4100/api/oauth/shopify/callback'}
            </code>
            . Przyjęcie lokalnego adresu wymaga sprawdzenia w konfiguracji aplikacji dostawcy.
          </p>
          {account?.client_configured === false && (
            <p role="alert">
              Ten kanał ma tylko token ręczny. Dla OAuth utwórz nowy kanał z Client ID i sekretem
              aplikacji.
            </p>
          )}
        </>
      )}
      <p>
        Rozpoczęcie zgody wyłącza harmonogramy zamówień i ofert. Uprawnienia zapisu nie uruchamiają
        żadnej operacji; zapisy wymagają osobnego zatwierdzenia.
      </p>
      <fieldset disabled={busy}>
        <legend>Dodatkowe uprawnienia zapisu</legend>
        {Object.entries({
          products_write: 'Produkty i ceny',
          inventory_write: 'Stany magazynowe',
          publications_write: 'Publikowanie ofert',
          fulfillment_write: 'Realizacja i tracking',
          translations_write: 'Tłumaczenia produktów i odczyt języków sklepu',
        }).map(([key, label]) => (
          <label className="checkbox-row" key={key}>
            <input
              type="checkbox"
              checked={writes[key as keyof typeof writes]}
              onChange={(e) => setWrites({ ...writes, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <section>
        <h4>Języki sklepu</h4>
        <p>
          Odczytaj języki przed publikacją tłumaczeń. Język podstawowy i języki nieopublikowane są
          oznaczone osobno. Kody regionalne, np. en i en-US, wymagają osobnego wyboru.
        </p>
        <button
          className="button"
          disabled={
            busy ||
            !account?.grant_matches ||
            account?.pending ||
            (!account?.bound && !account?.has_access_token)
          }
          onClick={() =>
            run(async () => {
              setLocales(null);
              setLocales(await api(`/integrations/${channel.id}/shopify-locales`));
            })
          }
        >
          Odczytaj języki Shopify
        </button>
        {locales && (
          <>
            <p className="notice" role="status">
              {locales.source === 'local_simulation'
                ? 'Języki lokalnego przykładu. Nie wykonano żądania do Shopify.'
                : 'Języki odczytane z API Shopify.'}
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Język</th>
                    <th>Kod</th>
                    <th>Widoczność</th>
                  </tr>
                </thead>
                <tbody>
                  {locales.locales.map((l) => (
                    <tr key={l.locale}>
                      <td>{l.name}</td>
                      <td>{l.locale}</td>
                      <td>
                        {l.primary
                          ? 'Podstawowy'
                          : l.published
                            ? 'Opublikowany'
                            : 'Nieopublikowany'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      {needsConfirmation && (
        <label className="checkbox-row">
          <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} />
          Łączę ponownie ten sam sklep i aplikację
        </label>
      )}
      <div className="inline-actions">
        <button
          className="button primary"
          disabled={
            busy ||
            !account?.client_configured ||
            !account?.grant_matches ||
            (needsConfirmation && !same)
          }
          onClick={() =>
            run(async () => {
              setStarted(
                await api(`/integrations/${channel.id}/shopify-oauth/start`, 'POST', {
                  ...writes,
                  confirm_same_account: same,
                }),
              );
              setLocales(null);
              setReturned('');
            })
          }
        >
          {account?.bound ? 'Połącz ponownie Shopify' : 'Rozpocznij połączenie Shopify'}
        </button>
        {(started || account?.pending) && (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api(`/integrations/${channel.id}/shopify-oauth/cancel`, 'POST', {});
                setStarted(null);
                setReturned('');
                setOutcome('Próba anulowana. Harmonogramy pozostają wyłączone.');
              })
            }
          >
            Anuluj próbę Shopify
          </button>
        )}
      </div>
      {started && (
        <div className="notice">
          <p>Zakresy zgody: {started.requested_scopes.join(', ')}</p>
          {started.demo_return_url ? (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => finish(started.demo_return_url)}
            >
              Zakończ lokalny przykład Shopify
            </button>
          ) : (
            <a
              className="button primary"
              href={started.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Otwórz zgodę Shopify
            </a>
          )}
        </div>
      )}
      {!channel.settings.simulation && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            finish(returned);
          }}
        >
          <label>
            Pełny adres powrotu Shopify
            <textarea
              value={returned}
              maxLength={8192}
              onChange={(e) => setReturned(e.target.value)}
              placeholder="http://127.0.0.1:4100/api/oauth/shopify/callback?code=…"
              required
            />
          </label>
          <p className="muted">
            Jeśli callback nie otworzył aplikacji, wklej jego pełny adres w tej samej sesji. Adres i
            podpis zostaną sprawdzone lokalnie.
          </p>
          <button className="button" disabled={busy || !returned}>
            Zapisz powrót Shopify
          </button>
        </form>
      )}
    </section>
  );
}
