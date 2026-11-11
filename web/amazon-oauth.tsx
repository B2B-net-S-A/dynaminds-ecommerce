import { useEffect, useState } from 'react';
import { api } from './api';
export function AmazonOAuthPanel({ channel }: { channel: any }) {
  const [account, setAccount] = useState<any>(null),
    [started, setStarted] = useState<any>(null),
    [sameAccount, setSameAccount] = useState(false),
    [returned, setReturned] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [outcome, setOutcome] = useState('');
  const reload = async () => setAccount(await api(`/integrations/${channel.id}/amazon-account`));
  useEffect(() => {
    reload().catch((e) => setError(e.message));
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
  async function finish(value: string) {
    await run(async () => {
      const r = await api('/oauth/amazon/finish', 'POST', { return_url: value });
      setOutcome(
        r.status === 'denied'
          ? 'Próba anulowana. Harmonogramy pozostają wyłączone.'
          : channel.settings.simulation
            ? 'Lokalny sprzedawca przypisany. Nie wykonano połączeń z Amazon.'
            : 'Token zgody zapisany, a sprzedawca przypisany na podstawie powrotu OAuth. Sprawdź odczyt API przed włączeniem harmonogramów.',
      );
      setStarted(null);
      setReturned('');
      setSameAccount(false);
    });
  }
  const needsConfirmation =
    !channel.settings.simulation && (account?.bound || account?.has_refresh_token);
  return (
    <section className="ebay-oauth-panel">
      <h3>{channel.name}</h3>
      <p>
        {channel.settings.simulation
          ? 'Przykład lokalny — bez konta i kluczy Amazon.'
          : `API ${channel.mode === 'sandbox' ? 'sandbox' : 'produkcyjne'}, region ${channel.settings.region.toUpperCase()}. Zgoda łączy konto sprzedawcy.`}
      </p>
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
      {account && (
        <div className="notice">
          <strong>{account.bound ? 'Sprzedawca przypisany' : 'Sprzedawca nieprzypisany'}</strong>
          <p>
            ID:{' '}
            {account.seller_id ||
              (channel.settings.simulation
                ? 'Zostanie nadany w przykładzie lokalnym'
                : 'Brak — podaj ID w nowym połączeniu')}
          </p>
          {account.bound && (
            <p>
              Źródło: {account.source === 'simulation' ? 'lokalna symulacja' : 'powrót OAuth'}. API
              nie potwierdziło niezależnie tożsamości konta.
            </p>
          )}
          {account.authorized_at && (
            <p>Ostatnia zgoda: {new Date(account.authorized_at).toLocaleString('pl-PL')}</p>
          )}
          {!account.grant_matches && (
            <p role="alert">Dane zgody zmieniono poza OAuth. Przywróć pierwotne połączenie.</p>
          )}
          {account.reauthorize_due && (
            <p>Od ostatniej zgody minął rok. Połącz ponownie tego samego sprzedawcę.</p>
          )}
          {(account.pending || account.pending_expired) && (
            <p>
              {account.pending_expired
                ? 'Próba wygasła — anuluj ją lub rozpocznij nową.'
                : 'Trwa próba połączenia. Synchronizacja jest zatrzymana.'}
            </p>
          )}
        </div>
      )}
      {!channel.settings.simulation && (
        <>
          <p>
            W aplikacji SP-API zarejestruj adres powrotu{' '}
            <code>
              {channel.settings.oauth_redirect_uri ||
                'http://127.0.0.1:4100/api/oauth/amazon/callback'}
            </code>{' '}
            oraz adres logowania <code>http://127.0.0.1:4100/api/oauth/amazon/login</code>. Obsługa
            lokalnego adresu przez Amazon wymaga potwierdzenia w rejestracji aplikacji.
          </p>
          <p>
            Wersja zgody:{' '}
            {channel.settings.oauth_beta === false
              ? 'opublikowana aplikacja'
              : 'Draft (version=beta)'}
            . Draft nie jest sandboxem: zgodę nadajesz w Seller Central i może ona dotyczyć
            rzeczywistego konta.
          </p>
        </>
      )}
      <p>
        Rozpoczęcie zgody wyłącza harmonogramy zamówień i ofert. Włączysz je ponownie po sprawdzeniu
        połączenia.
      </p>
      {needsConfirmation && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={sameAccount}
            onChange={(e) => setSameAccount(e.target.checked)}
          />
          Łączę ponownie tego samego sprzedawcę
        </label>
      )}
      <div className="inline-actions">
        <button
          className="button primary"
          disabled={busy || (needsConfirmation && !sameAccount) || account?.grant_matches === false}
          onClick={() =>
            run(async () => {
              setStarted(
                await api(`/integrations/${channel.id}/amazon-oauth/start`, 'POST', {
                  confirm_same_account: sameAccount,
                }),
              );
              setReturned('');
            })
          }
        >
          {account?.bound ? 'Połącz ponownie Amazon' : 'Rozpocznij połączenie Amazon'}
        </button>
        {(started || account?.pending || account?.pending_expired) && (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api(`/integrations/${channel.id}/amazon-oauth/cancel`, 'POST', {});
                setStarted(null);
                setReturned('');
                setOutcome(
                  'Próba anulowana. Dotychczasowa zgoda zachowana, harmonogramy wyłączone.',
                );
              })
            }
          >
            Anuluj próbę Amazon
          </button>
        )}
      </div>
      {started &&
        (channel.settings.simulation ? (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => finish(started.demo_return_url)}
          >
            Zakończ lokalny przykład OAuth
          </button>
        ) : (
          <>
            <p>
              Oczekiwany sprzedawca: <strong>{started.expected_seller}</strong>. Próba jest ważna
              przez 10 minut w tej samej sesji przeglądarki.
            </p>
            <a className="button" href={started.url} target="_blank" rel="noreferrer">
              Otwórz zgodę w Amazon
            </a>
            <label>
              Pełny adres powrotu Amazon
              <textarea
                value={returned}
                onChange={(e) => setReturned(e.target.value)}
                placeholder="http://127.0.0.1:4100/api/oauth/amazon/callback?..."
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              className="button primary"
              disabled={busy || !returned.trim()}
              onClick={() => finish(returned.trim())}
            >
              Zapisz powrót Amazon
            </button>
          </>
        ))}
    </section>
  );
}
