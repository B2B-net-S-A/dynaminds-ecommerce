import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, KeyRound, Copy } from 'lucide-react';
import { api, date } from './api';
import { LoginHistory } from './login-history';

export function AccountSecurity({
  changed,
  notify,
  refresh,
  readOnly,
  contextKey,
  onRecoveryCodesSaved,
}: {
  changed: (u: any, recoveryCodes?: string[]) => void;
  notify: (s: string, error?: boolean) => void;
  refresh: number;
  readOnly: boolean;
  contextKey: string;
  onRecoveryCodesSaved?: () => void;
}) {
  const [data, setData] = useState<any>(),
    [setup, setSetup] = useState<any>(),
    [codes, setCodes] = useState<string[]>([]),
    [action, setAction] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const access = useRef({ contextKey, readOnly }),
    alive = useRef(false),
    flight = useRef(false);
  access.current = { contextKey, readOnly };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => alive.current && access.current.contextKey === contextKey;
  const writable = () => current() && !access.current.readOnly;
  useEffect(() => {
    let active = true;
    api('/auth/security')
      .then((r) => {
        if (active) {
          setData(r);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [refresh, revision, contextKey]);
  async function operate(fn: () => Promise<void>, mutation = true) {
    if (!(mutation ? writable() : current()) || flight.current) return;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      if (current()) setRevision((r) => r + 1);
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="panel account-security" aria-label="Bezpieczeństwo konta">
      <div className="panel-heading">
        <h2>
          <ShieldCheck size={20} /> Bezpieczeństwo konta
        </h2>
        <span className={'badge ' + (data?.enabled ? 'success' : '')}>
          {data?.enabled ? 'MFA włączone' : 'MFA wyłączone'}
        </span>
      </div>
      <div className="account-security-body">
        <p className="muted">
          Ochrona dotyczy Twojego konta we wszystkich organizacjach. Użyj aplikacji
          uwierzytelniającej na telefonie.
        </p>
        {error && (
          <p className="error-block" role="alert">
            {error}
          </p>
        )}
        {data && (
          <>
            {!!data.required_by_organizations?.length && (
              <p className="notice">
                MFA wymagają: {data.required_by_organizations.map((w: any) => w.name).join(', ')}.
                Wyłączenie ochrony wymaga wcześniejszej zmiany polityki tych organizacji.
              </p>
            )}
            <div className="security-actions">
              {!data.enabled ? (
                <button
                  className="button"
                  disabled={busy || readOnly || !!codes.length}
                  onClick={() => {
                    if (writable() && !flight.current) setAction('enroll');
                  }}
                >
                  <ShieldCheck size={16} /> Włącz MFA
                </button>
              ) : (
                <>
                  <span className="muted">
                    Pozostałe kody odzyskiwania: {data.recovery_remaining} z 8
                  </span>
                  <button
                    className="button"
                    disabled={busy || readOnly || !!codes.length}
                    onClick={() => {
                      if (writable() && !flight.current) setAction('recovery');
                    }}
                  >
                    Nowe kody odzyskiwania
                  </button>
                  <button
                    className="button"
                    disabled={
                      busy || readOnly || !!codes.length || !!data.required_by_organizations?.length
                    }
                    onClick={() => {
                      if (writable() && !flight.current) setAction('disable');
                    }}
                  >
                    Wyłącz MFA
                  </button>
                </>
              )}
              <button
                className="button"
                disabled={busy || readOnly || !!codes.length}
                onClick={() => {
                  if (!writable() || flight.current) return;
                  setSetup(null);
                  setAction('password');
                }}
              >
                <KeyRound size={16} /> Zmień hasło
              </button>
            </div>
            {codes.length > 0 && (
              <div className="security-recovery" role="status">
                <h3>Zapisz kody odzyskiwania</h3>
                <p>
                  Każdy kod działa tylko raz. Zapisz je w bezpiecznym miejscu. Po zamknięciu nie
                  będzie można ich ponownie wyświetlić.
                </p>
                <textarea
                  aria-label="Kody odzyskiwania"
                  readOnly
                  value={codes.join('\n')}
                  rows={8}
                />
                <div className="security-actions">
                  <button
                    className="button"
                    onClick={() =>
                      void operate(async () => {
                        await navigator.clipboard.writeText(codes.join('\n'));
                        if (current()) notify('Skopiowano kody odzyskiwania.');
                      }, false)
                    }
                  >
                    <Copy size={16} /> Kopiuj kody
                  </button>
                  <button
                    className="button primary"
                    onClick={() => {
                      if (!current()) return;
                      setCodes([]);
                      if (writable()) onRecoveryCodesSaved?.();
                    }}
                  >
                    Kody zapisane — zamknij
                  </button>
                </div>
              </div>
            )}
            {action && !readOnly && (
              <form
                className="security-form"
                key={action + String(!!setup)}
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const f = new FormData(form);
                  void operate(async () => {
                    const endpoint = action === 'enroll' && setup ? 'confirm' : action;
                    const result = await api('/auth/security/' + endpoint, 'POST', {
                      password: f.get('password'),
                      ...(f.get('code') ? { code: f.get('code') } : {}),
                      ...(action === 'password' ? { new_password: f.get('new_password') } : {}),
                    });
                    if (!writable()) return;
                    form.reset();
                    if (endpoint === 'enroll') {
                      setSetup(result);
                      notify('Zeskanuj kod QR i potwierdź kod z aplikacji.');
                      return;
                    }
                    setSetup(null);
                    setAction('');
                    if (result.user) changed(result.user, result.recovery_codes);
                    if (result.recovery_codes) setCodes(result.recovery_codes);
                    notify(
                      endpoint === 'confirm'
                        ? 'MFA włączone. Pozostałe sesje zakończone.'
                        : endpoint === 'disable'
                          ? 'MFA wyłączone. Pozostałe sesje zakończone.'
                          : endpoint === 'recovery'
                            ? 'Wygenerowano nowe kody. Poprzednie kody i pozostałe sesje unieważnione.'
                            : 'Hasło zmienione. Pozostałe sesje zakończone.',
                    );
                  });
                }}
              >
                <h3>
                  {action === 'enroll'
                    ? setup
                      ? 'Potwierdź konfigurację MFA'
                      : 'Przygotuj konfigurację MFA'
                    : action === 'password'
                      ? 'Zmiana hasła'
                      : action === 'recovery'
                        ? 'Zastąp kody odzyskiwania'
                        : 'Wyłączenie MFA'}
                </h3>
                {action === 'enroll' && setup && (
                  <div className="security-setup">
                    <img
                      src={setup.qr}
                      width={240}
                      height={240}
                      alt="Kod QR konfiguracji aplikacji uwierzytelniającej"
                    />
                    <div>
                      <p>
                        Zeskanuj kod QR albo wpisz klucz ręcznie w aplikacji. Konfiguracja jest
                        ważna do {date(setup.expires_at)}.
                      </p>
                      <label>
                        Klucz konfiguracji
                        <input readOnly value={setup.secret} autoComplete="off" />
                      </label>
                      <p className="muted">
                        Kod: 6 cyfr, zmienia się co 30 sekund. Po użyciu poczekaj na następny kod.
                      </p>
                    </div>
                  </div>
                )}
                <label>
                  Aktualne hasło
                  <input
                    name="password"
                    type="password"
                    required
                    maxLength={200}
                    autoComplete="current-password"
                  />
                </label>
                {(data.enabled || (action === 'enroll' && setup)) && (
                  <label>
                    Kod z aplikacji lub kod odzyskiwania
                    <input
                      name="code"
                      required
                      maxLength={80}
                      autoComplete="one-time-code"
                      spellCheck={false}
                    />
                  </label>
                )}
                {action === 'password' && (
                  <label>
                    Nowe hasło — co najmniej 12 znaków
                    <input
                      name="new_password"
                      type="password"
                      required
                      minLength={12}
                      maxLength={200}
                      autoComplete="new-password"
                    />
                  </label>
                )}
                <p className="muted">
                  {action === 'enroll' && !setup
                    ? 'Ochrona zacznie działać dopiero po potwierdzeniu kodu.'
                    : 'Potwierdzenie zakończy pozostałe sesje we wszystkich organizacjach. Bieżąca sesja otrzyma nowy identyfikator.'}
                </p>
                <div className="security-actions">
                  <button className="button primary" disabled={busy || readOnly}>
                    {busy
                      ? 'Sprawdzanie…'
                      : action === 'enroll' && !setup
                        ? 'Przygotuj kod QR'
                        : 'Potwierdź'}
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy || readOnly}
                    onClick={() =>
                      void operate(async () => {
                        if (setup) await api('/auth/security/enroll', 'DELETE');
                        if (!writable()) return;
                        setSetup(null);
                        setAction('');
                      })
                    }
                  >
                    Anuluj
                  </button>
                </div>
              </form>
            )}
            <h3>Aktywne sesje</h3>
            <p className="muted">
              Możesz zakończyć pozostałe logowania do swojego konta. Przełączenie organizacji
              zmienia identyfikator sesji.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Organizacja</th>
                    <th>Utworzona / zarejestrowana</th>
                    <th>Wygasa</th>
                    <th>Sesja</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((s: any) => (
                    <tr key={s.id}>
                      <td>{s.tenant_name}</td>
                      <td>{date(s.created_at)}</td>
                      <td>{date(s.expires_at)}</td>
                      <td>
                        {s.current ? (
                          <span className="badge">Bieżąca</span>
                        ) : (
                          <button
                            className="button small"
                            disabled={busy || readOnly}
                            onClick={() =>
                              void operate(async () => {
                                await api('/auth/security/sessions/' + s.id, 'DELETE');
                                if (writable()) notify('Sesja zakończona.');
                              })
                            }
                          >
                            Zakończ sesję
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <LoginHistory url="/auth/security/logins" refresh={refresh + revision} />
          </>
        )}
      </div>
    </section>
  );
}
