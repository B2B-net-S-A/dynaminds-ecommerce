import { useState, type FormEvent } from 'react';
import { api } from './api';

export function takePasswordResetToken() {
  const match = /^#password-reset=([a-f0-9]{64})$/.exec(location.hash);
  if (!match) return null;
  // Keep the bearer secret in component memory, not in browser history or request URLs.
  history.replaceState(null, '', location.pathname + location.search);
  return match[1];
}
export function PasswordRecovery({
  token,
  onBack,
  onDone,
}: {
  token?: string | null;
  onBack: () => void;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [mfaRequired, setMfaRequired] = useState(false),
    [done, setDone] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(e.currentTarget);
    const value = (name: string) => String(data.get(name) ?? '');
    try {
      if (token) {
        if (value('password') !== value('confirm_password'))
          throw new Error('Hasła muszą być identyczne.');
        const result = await api('/auth/password/reset', 'POST', {
          token,
          password: value('password'),
          confirm_password: value('confirm_password'),
          ...(mfaRequired ? { code: value('code') } : {}),
        });
        if (result.mfa_required) {
          setMfaRequired(true);
          return;
        }
        setDone(true);
        setMessage(
          'Hasło zmienione. Wszystkie sesje zostały zakończone. Zaloguj się nowym hasłem.',
        );
      } else {
        const result = await api('/auth/password/request', 'POST', { email: value('email') });
        setMessage(result.message);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-brand">
        <div className="brand-mark">
          D<span>•</span>
        </div>
        <span>
          DYNAMINDS <small>Ecommerce</small>
        </span>
      </div>
      <section className="login-card">
        <div className="eyebrow">DOSTĘP DO KONTA</div>
        <h1>{token ? 'Ustaw nowe hasło.' : 'Odzyskaj dostęp.'}</h1>
        <p>
          {token
            ? 'Link działa raz i jest ważny przez 15 minut.'
            : 'Podaj adres email używany do logowania.'}
        </p>
        {!done && (
          <form onSubmit={submit}>
            {token ? (
              <>
                <label>
                  Nowe hasło
                  <input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={200}
                    required
                  />
                </label>
                <label>
                  Powtórz nowe hasło
                  <input
                    name="confirm_password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={200}
                    required
                  />
                </label>
                {mfaRequired && (
                  <label>
                    Kod z aplikacji lub kod odzyskiwania
                    <input
                      name="code"
                      autoComplete="one-time-code"
                      maxLength={80}
                      required
                      autoFocus
                      spellCheck={false}
                    />
                    <small>Odzyskanie hasła zachowuje ochronę MFA.</small>
                  </label>
                )}
              </>
            ) : (
              <label>
                Adres email
                <input name="email" type="email" autoComplete="username" maxLength={254} required />
              </label>
            )}
            {error && (
              <div className="error-block" role="alert">
                {error}
              </div>
            )}
            <button className="button primary full" disabled={busy}>
              {busy ? 'Zapisywanie…' : token ? 'Zmień hasło' : 'Przygotuj link'}
            </button>
          </form>
        )}
        {message && (
          <p className="info-callout" role="status">
            {message}
          </p>
        )}
        {!token && (
          <p className="muted">
            W środowisku lokalnym wiadomość można odczytać w terminalu:{' '}
            <code>npm run auth:mail -- --email twój-adres</code>. Skrzynka jest dostępna wyłącznie
            dla operatora tego komputera.
          </p>
        )}
        <button
          type="button"
          className="button ghost full"
          disabled={busy}
          onClick={done ? (onDone ?? onBack) : onBack}
        >
          {done ? 'Przejdź do logowania' : 'Wróć do logowania'}
        </button>
      </section>
      <div className="login-foot">DYNAMINDS Ecommerce / Local workspace</div>
    </div>
  );
}
