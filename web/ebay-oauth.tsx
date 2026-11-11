import { useEffect, useState } from 'react';
import { EbayApiLimits } from './ebay-api-limits';
import { api } from './api';
export function EbayOAuthPanel({ channel }: { channel: any }) {
  const [access, setAccess] = useState(channel.settings.inventory_access ?? 'orders'),
    [fulfillmentWrite, setFulfillmentWrite] = useState(channel.settings.fulfillment_write === true),
    [sellerRead, setSellerRead] = useState(channel.settings.seller_settings_read === true),
    [sameAccount, setSameAccount] = useState(false),
    [started, setStarted] = useState<any>(null),
    [returned, setReturned] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [outcome, setOutcome] = useState(''),
    [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<any>(null);
  useEffect(() => {
    api('/integrations/' + channel.id + '/ebay-account')
      .then(setAccount)
      .catch((e) => setError(e.message));
  }, [channel.id]);
  async function verifyAccount() {
    setBusy(true);
    setError('');
    try {
      setAccount(await api('/integrations/' + channel.id + '/ebay-account/verify', 'POST', {}));
      setOutcome(
        channel.settings.simulation
          ? 'Sprawdzono lokalny przykład. Nie wysłano żądań do eBay.'
          : 'Tożsamość aktualnego konta potwierdzona odczytem eBay.',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const requiresConfirmation = channel.status !== 'awaiting_oauth' || connected;
  async function start() {
    setBusy(true);
    setError('');
    setOutcome('');
    setStarted(null);
    setReturned('');
    try {
      setStarted(
        await api('/integrations/' + channel.id + '/oauth/start', 'POST', {
          inventory_access: access,
          fulfillment_write: fulfillmentWrite,
          seller_settings_read: sellerRead,
          confirm_same_account: sameAccount,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function finish(cancel = false) {
    setBusy(true);
    setError('');
    try {
      let body: any;
      if (cancel)
        body = { state: new URL(started.url).searchParams.get('state'), error: 'access_denied' };
      else {
        let u: URL;
        try {
          u = new URL(returned);
        } catch {
          throw Error('Wklej pełny adres powrotu zawierający state i code albo error.');
        }
        if (
          u.searchParams.getAll('state').length !== 1 ||
          u.searchParams.getAll('code').length > 1 ||
          u.searchParams.getAll('error').length > 1 ||
          (u.searchParams.has('code') && u.searchParams.has('error'))
        )
          throw Error('Adres powrotu zawiera powtórzone lub sprzeczne parametry.');
        body = {
          state: u.searchParams.get('state'),
          ...(u.searchParams.has('code')
            ? { code: u.searchParams.get('code') }
            : { error: u.searchParams.get('error') }),
        };
      }
      const result = await api('/oauth/ebay/finish', 'POST', body);
      setOutcome(
        result.status === 'denied'
          ? 'Próba połączenia anulowana. Harmonogramy pozostają wyłączone.'
          : 'Zgoda OAuth i tożsamość konta potwierdzone. Sprawdź odczyt API, a następnie włącz wybrane harmonogramy.',
      );
      setStarted(null);
      setReturned('');
      if (result.status !== 'denied') {
        setConnected(true);
        setSameAccount(false);
        setAccount(await api('/integrations/' + channel.id + '/ebay-account'));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ebay-oauth-panel">
      <h3>{channel.name}</h3>
      <EbayApiLimits channelId={channel.id} />
      <p>
        Środowisko:{' '}
        <strong>
          {channel.settings.simulation
            ? 'Przykład lokalny'
            : channel.mode === 'sandbox'
              ? 'Sandbox eBay'
              : 'Konto produkcyjne eBay'}
        </strong>
        . Zgoda OAuth łączy konto; nie publikuje ofert ani nie włącza harmonogramów.
      </p>
      {!channel.settings.simulation && (
        <p>
          W konfiguracji RuName aplikacji eBay ustaw adres przyjęcia i odmowy. Lokalny endpoint
          powrotu: <code>http://127.0.0.1:4100/api/oauth/ebay/callback</code>. Dostępność lokalnego
          adresu trzeba potwierdzić w konfiguracji eBay. Aplikacja nie tworzy tunelu ani nie
          publikuje serwera.
        </p>
      )}
      {error && (
        <p role="alert" className="error-block">
          {error}
        </p>
      )}
      {outcome && (
        <p role="status" className="notice">
          {outcome}
        </p>
      )}
      <div className="notice">
        <strong>
          {account?.bound
            ? account.simulation
              ? 'Konto przykładowe'
              : 'Konto przypisane do kanału'
            : 'Tożsamość konta nie została jeszcze sprawdzona'}
        </strong>
        {account?.bound && (
          <p>
            {account.username || 'Nazwa konta nieudostępniona'} ·{' '}
            {new Date(account.verified_at).toLocaleString('pl-PL')}
          </p>
        )}
        <p>
          {channel.settings.simulation
            ? 'Lokalny przykład — bez połączenia z kontem eBay.'
            : 'Porównujemy stały identyfikator konta, także po zmianie nazwy użytkownika. Inny sprzedawca wymaga nowego kanału. Przed ponownym OAuth stare połączenie musi zostać sprawdzone.'}
        </p>
        <button
          className="button"
          disabled={
            busy || !!started || !account || (!account.has_refresh_token && !account.simulation)
          }
          onClick={verifyAccount}
        >
          Sprawdź tożsamość konta eBay
        </button>
      </div>
      {!channel.settings.simulation && (
        <>
          <label>
            Zakres dostępu eBay
            <select
              value={access}
              disabled={busy || !!started}
              onChange={(e) => setAccess(e.target.value)}
            >
              <option value="orders">Zamówienia — odczyt</option>
              <option value="orders_inventory">Zamówienia i katalog — odczyt</option>
              <option value="orders_inventory_write">
                Zamówienia, katalog i zapis cen oraz stanów
              </option>
            </select>
          </label>
          <p>
            Zgoda obejmuje też podstawowy zakres api_scope wymagany do identyfikacji konta. Pozwala
            on również wykonywać zapisy przez Trading API. Ten ekran używa go wyłącznie do odczytu
            GetUser; aplikacja nie udostępnia zapisów Trading.
          </p>
          <p>
            {access === 'orders_inventory_write'
              ? 'eBay poprosi o dostęp sell.inventory pozwalający zmieniać oferty. W aplikacji każdy zapis i harmonogram nadal wymaga zatwierdzenia.'
              : access === 'orders_inventory'
                ? 'Wybrany tryb aplikacji obejmuje odczyt zamówień i katalogu. Zapis ofert nie jest włączony.'
                : 'Wybrany tryb aplikacji obejmuje odczyt zamówień. Zapis ofert nie jest włączony.'}
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={fulfillmentWrite}
              disabled={busy || !!started}
              onChange={(e) => setFulfillmentWrite(e.target.checked)}
            />
            Zezwól na przekazanie wysyłki i numeru śledzenia do eBay (sell.fulfillment).
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={sellerRead}
              disabled={busy || !!started}
              onChange={(e) => setSellerRead(e.target.checked)}
            />
            Odczyt warunków płatności, zwrotu i dostawy eBay (sell.account.readonly).
          </label>
          {fulfillmentWrite && (
            <p>
              eBay otrzyma dane wysyłki po osobnym zatwierdzeniu w aplikacji i może powiadomić
              kupującego.
            </p>
          )}
          {requiresConfirmation && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={sameAccount}
                disabled={busy || !!started}
                onChange={(e) => setSameAccount(e.target.checked)}
              />
              Łączę ponownie to samo konto eBay. Dla innego konta utworzę nowy kanał.
            </label>
          )}
          {!started && (
            <button
              className="button primary"
              disabled={busy || (requiresConfirmation && !sameAccount)}
              onClick={start}
            >
              Przygotuj zgodę eBay
            </button>
          )}
          {started && (
            <>
              <p>
                Link jest ważny 10 minut. Otwarcie nowej próby unieważnia poprzednią. Harmonogramy
                tego kanału zostały wyłączone.
              </p>
              <a className="button primary" href={started.url} target="_blank" rel="noreferrer">
                Otwórz zgodę na eBay
              </a>
              <details>
                <summary>Zakresy zgody</summary>
                <p>{started.scope}</p>
              </details>
              <label>
                Adres powrotu po zgodzie eBay
                <input
                  type="text"
                  autoComplete="off"
                  value={returned}
                  onChange={(e) => setReturned(e.target.value)}
                  placeholder="Pełny adres z state oraz code albo error"
                />
              </label>
              <p>
                Jeśli powrót automatyczny nie dotarł do aplikacji, wklej adres z przeglądarki. Kod
                jest jednorazowy i nie jest zapisywany.
              </p>
              <div className="inline-actions">
                <button className="button" disabled={busy || !returned} onClick={() => finish()}>
                  Dokończ połączenie
                </button>
                <button className="button" disabled={busy} onClick={() => finish(true)}>
                  Anuluj próbę połączenia
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
