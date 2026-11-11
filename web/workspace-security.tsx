import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, LogOut } from 'lucide-react';
import { api, date } from './api';
import { AccountSecurity } from './account-security';
import { WorkspaceSwitcher } from './workspaces';
import { LoginHistory } from './login-history';

type Props = {
  user: any;
  changed: (user: any) => void;
  notify: (message: string, error?: boolean) => void;
  readOnly: boolean;
};

export function MfaGate({ user, changed, notify, readOnly }: Props) {
  const contextKey = user.tenant_id + ':' + user.id + ':' + user.role;
  const access = useRef({ contextKey, readOnly }),
    alive = useRef(false);
  access.current = { contextKey, readOnly };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => alive.current && access.current.contextKey === contextKey;
  const writable = () => current() && !access.current.readOnly;
  const [pendingUser, setPendingUser] = useState<any>(null),
    [message, setMessage] = useState<{ text: string; error: boolean } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const gateNotice = (text: string, error = false) => {
    setMessage({ text, error });
    notify(text, error);
  };
  return (
    <main className="mfa-gate">
      <header className="mfa-gate-header">
        <strong>DYNAMINDS Ecommerce</strong>
        <button
          className="button"
          onClick={async () => {
            try {
              await api('/auth/logout', 'POST');
              changed(null);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <LogOut size={16} /> Wyloguj
        </button>
      </header>
      <div className="mfa-gate-content">
        <WorkspaceSwitcher user={user} changed={changed} notify={gateNotice} />
        <ShieldCheck size={36} />
        <h1>{pendingUser ? 'Zapisz kody odzyskiwania' : 'Firma wymaga potwierdzenia MFA'}</h1>
        <p>
          Organizacja <strong>{user.tenant_name}</strong> wymaga dodatkowej ochrony konta. Dostęp do
          zamówień, produktów i pozostałych danych zostanie odblokowany po potwierdzeniu.
        </p>
        {error && (
          <p className="error-block" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p
            className={message.error ? 'error-block' : 'notice'}
            role={message.error ? 'alert' : 'status'}
          >
            {message.text}
          </p>
        )}
        {typeof user.mfa_enrollment_required !== 'boolean' ? (
          <p role="status">Sprawdzanie ochrony konta…</p>
        ) : readOnly ? (
          <p className="notice">
            Podgląd kopii jest tylko do odczytu. Wyloguj się i zaloguj ponownie z kodem MFA.
            Konfigurację ochrony konta wykonaj w aplikacji źródłowej.
          </p>
        ) : user.mfa_enrollment_required || pendingUser ? (
          <AccountSecurity
            key={contextKey + ':' + readOnly}
            contextKey={contextKey}
            readOnly={readOnly}
            refresh={0}
            notify={gateNotice}
            changed={(next, codes) => {
              if (writable()) codes?.length ? setPendingUser(next) : changed(next);
            }}
            onRecoveryCodesSaved={() => {
              if (writable() && pendingUser) changed(pendingUser);
            }}
          />
        ) : (
          <form
            className="panel mfa-verify-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!writable()) return;
              const form = e.currentTarget,
                f = new FormData(form);
              setBusy(true);
              setError('');
              try {
                const r = await api('/auth/security/verify', 'POST', {
                  password: f.get('password'),
                  code: f.get('code'),
                });
                if (!writable()) return;
                form.reset();
                changed(r.user);
              } catch (e) {
                if (current()) setError((e as Error).message);
              } finally {
                if (current()) setBusy(false);
              }
            }}
          >
            <h2>Potwierdź ochronę konta</h2>
            <p>Potwierdzenie jest ważne przez 8 godzin. Pozostałe sesje pozostaną aktywne.</p>
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
            <button className="button primary" disabled={busy}>
              {busy ? 'Sprawdzanie…' : 'Potwierdź i przejdź do firmy'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

export function WorkspaceSecurityPolicy({
  user,
  changed,
  notify,
  readOnly,
  refresh,
}: Props & { refresh: number }) {
  const [data, setData] = useState<any>(null),
    [accountMfa, setAccountMfa] = useState(false),
    [revision, setRevision] = useState(0),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const admin = user.role === 'admin',
    contextKey = user.tenant_id + ':' + user.id + ':' + user.role;
  const access = useRef({ contextKey, readOnly, admin }),
    alive = useRef(false),
    flight = useRef(false);
  access.current = { contextKey, readOnly, admin };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => alive.current && access.current.contextKey === contextKey;
  const writable = () => current() && !access.current.readOnly && access.current.admin;
  useEffect(() => {
    let active = true;
    Promise.all([api('/workspaces/security'), api('/auth/security')])
      .then(([p, a]) => {
        if (active) {
          setData(p);
          setAccountMfa(a.enabled);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [user.tenant_id, user.id, user.role, refresh, revision]);
  const enabled = data?.members?.filter((m: any) => m.mfa_enabled).length ?? 0;
  return (
    <section className="panel workspace-security-policy" aria-label="Ochrona organizacji">
      <div className="panel-heading">
        <h2>
          <ShieldCheck size={20} /> Ochrona organizacji
        </h2>
        {data && (
          <span className={'badge ' + (data.require_mfa ? 'success' : '')}>
            {data.require_mfa ? 'MFA wymagane' : 'MFA dobrowolne'}
          </span>
        )}
      </div>
      <div className="workspace-security-body">
        <p>
          MFA chroni dostęp zespołu do danych firmy. Wymóg obejmuje istniejące sesje i nowe
          logowania. Właściciel klucza API również musi mieć włączone MFA; zadania w tle działają
          dalej.
        </p>
        {error && (
          <p className="error-block" role="alert">
            {error}
          </p>
        )}
        {data && (
          <>
            {data.updated_at && <p className="muted">Ostatnia zmiana: {date(data.updated_at)}</p>}
            {admin && (
              <>
                <p>
                  <strong>
                    {enabled} z {data.members.length}
                  </strong>{' '}
                  osób ma włączone MFA.
                  {data.members.length > enabled &&
                    ` ${data.members.length - enabled} osób potrzebuje konfiguracji.`}
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Osoba</th>
                        <th>Rola</th>
                        <th>MFA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.members.map((m: any) => (
                        <tr key={m.id}>
                          <td>
                            {m.name}
                            <small>{m.email}</small>
                          </td>
                          <td>
                            {
                              {
                                admin: 'Administrator',
                                operator: 'Magazynier',
                                viewer: 'Tylko odczyt',
                                accountant: 'Księgowa',
                              }[m.role as string]
                            }
                          </td>
                          <td>
                            <span className={'badge ' + (m.mfa_enabled ? 'success' : '')}>
                              {m.mfa_enabled ? 'Włączone' : 'Do konfiguracji'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!accountMfa && (
                  <p className="notice">Najpierw włącz MFA na własnym koncie w panelu poniżej.</p>
                )}
                {!editing ? (
                  <button
                    className="button"
                    disabled={!accountMfa || readOnly}
                    onClick={() => {
                      if (writable() && !flight.current && accountMfa) setEditing(true);
                    }}
                  >
                    Zmień wymóg MFA
                  </button>
                ) : (
                  !readOnly && (
                    <form
                      className="security-form"
                      key={data.version}
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!writable() || flight.current) return;
                        flight.current = true;
                        const form = e.currentTarget,
                          f = new FormData(form);
                        setBusy(true);
                        setError('');
                        try {
                          const r = await api('/workspaces/security', 'PATCH', {
                            require_mfa: f.get('require_mfa') === 'required',
                            version: data.version,
                            password: f.get('password'),
                            code: f.get('code'),
                          });
                          if (!writable()) return;
                          form.reset();
                          setEditing(false);
                          changed(r.user);
                          setRevision((r) => r + 1);
                          notify(
                            r.policy.require_mfa
                              ? 'Firma wymaga teraz MFA.'
                              : 'MFA w firmie jest teraz dobrowolne.',
                          );
                        } catch (e) {
                          if (current()) setError((e as Error).message);
                        } finally {
                          flight.current = false;
                          if (alive.current) setBusy(false);
                        }
                      }}
                    >
                      <label>
                        Wymóg MFA
                        <select
                          name="require_mfa"
                          defaultValue={data.require_mfa ? 'required' : 'optional'}
                          disabled={busy || readOnly}
                        >
                          <option value="required">Wymagane dla zespołu</option>
                          <option value="optional">Dobrowolne</option>
                        </select>
                      </label>
                      <p>
                        Włączenie wymogu zablokuje dostęp do danych osobom bez MFA do czasu
                        konfiguracji. Wyłączenie pozwoli członkom firmy korzystać z sesji bez
                        potwierdzenia MFA.
                      </p>
                      <label className="policy-confirm">
                        <input type="checkbox" required disabled={busy || readOnly} /> Rozumiem
                        wpływ zmiany na dostęp zespołu.
                      </label>
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
                      <div className="security-actions">
                        <button className="button primary" disabled={busy || readOnly}>
                          {busy ? 'Sprawdzanie…' : 'Potwierdź politykę'}
                        </button>
                        <button
                          className="button"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (!current() || flight.current) return;
                            setEditing(false);
                            setRevision((r) => r + 1);
                          }}
                        >
                          Anuluj i odśwież
                        </button>
                      </div>
                    </form>
                  )
                )}
                <LoginHistory url="/workspaces/security/logins" refresh={refresh + revision} members />
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
