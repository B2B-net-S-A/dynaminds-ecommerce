import { WorkspaceBillingPanel } from './workspace-billing';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Building2, Plus, Users, ShieldCheck, Copy, Check, ArrowRight } from 'lucide-react';
import { api } from './api';
import { ROLE_LABELS, roleLabel } from './roles';

type User = { id: string; tenant_id: string; tenant_name: string; plan: string; role: string; accountant?: boolean };
type Props = {
  user: User;
  changed: (u: any) => void;
  notify: (text: string, error?: boolean) => void;
  refresh: number;
};
const labels: Record<string, string> = {
  products: 'Produkty',
  orders: 'Zamówienia w miesiącu UTC',
  channels: 'Połączenia',
  warehouses: 'Magazyny',
  memberships: 'Miejsca w zespole',
};
const roles = ROLE_LABELS;
export const invitedToken = () => new URLSearchParams(location.hash.slice(1)).get('invite') ?? '';
export function WorkspaceSwitcher({ user, changed, notify }: Omit<Props, 'refresh'>) {
  const scope = user.id + ':' + user.tenant_id;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const generation = useRef(0);
  const flight = useRef<object | null>(null);
  const [roster, setRoster] = useState<{scope: string; rows: any[]} | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    generation.current++;
    setRoster(null);
    api('/workspaces')
      .then((r) => {
        if (active && currentScope.current === scope) setRoster({scope, rows: r.data});
      })
      .catch((e) => {
        if (active && currentScope.current === scope) notify(e.message, true);
      });
    return () => { active = false; generation.current++; };
  }, [user.id, user.tenant_id, user.tenant_name]);
  const workspaces = roster?.scope === scope ? roster.rows : [];
  const currentPresent = workspaces.some((w) => w.id === user.tenant_id);
  const busy = busyScope !== null;

  return (
    <div className="workspace workspace-picker">
      <Building2 size={17} />
      <label>
        <span className="sr-only">Aktywna organizacja</span>
        <select
          aria-label="Aktywna organizacja"
          value={user.tenant_id}
          disabled={busy || !currentPresent}
          onChange={async (e) => {
            const tenantId = e.target.value;
            if (currentScope.current !== scope || busy || !currentPresent ||
              !workspaces.some((w) => w.id === tenantId)) return;
            if (flight.current) return;
            const ownFlight = {};
            flight.current = ownFlight;
            const ownGeneration = generation.current;
            setBusyScope(scope);
            try {
              const r = await api('/workspaces/switch', 'POST', { tenant_id: tenantId });
              if (currentScope.current === scope && generation.current === ownGeneration) changed(r.user);
            } catch (e) {
              if (currentScope.current === scope && generation.current === ownGeneration) notify((e as Error).message, true);
            } finally {
              if (flight.current === ownFlight) flight.current = null;
              setBusyScope((current) => current === scope ? null : current);
            }
          }}
        >
          {!currentPresent && <option value={user.tenant_id}>{user.tenant_name}</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <small>Plan {user.plan} · {roleLabel(user)} · lokalnie</small>
      </label>
    </div>
  );
}
export function WorkspaceSettings({ user, changed, notify, refresh, readOnly }: Props & {readOnly: boolean}) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [invitation, setInvitation] = useState(''),
    [joinToken, setJoinToken] = useState(invitedToken),
    [copied, setCopied] = useState(false);
  const admin = user.role === 'admin', scope = user.tenant_id + ':' + user.id + ':' + user.role;
  const access = useRef({scope, readOnly, admin}), alive = useRef(false), flight = useRef(false);
  access.current = {scope, readOnly, admin};
  useEffect(() => {alive.current = true;return () => {alive.current = false;};}, []);
  const current = () => alive.current && access.current.scope === scope && !access.current.readOnly;
  useEffect(() => {
    const onInvitation = () => setJoinToken(invitedToken());
    window.addEventListener('hashchange', onInvitation);
    return () => window.removeEventListener('hashchange', onInvitation);
  }, []);
  useEffect(() => {
    let active = true;
    api('/workspaces/settings')
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
  }, [refresh, revision, user.tenant_id, user.id, user.role]);
  async function action(fn: () => Promise<void>, message: string, adminRequired = true) {
    if (!current() || (adminRequired && !access.current.admin) || flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      await fn();
      if (!current()) return;
      setRevision((r) => r + 1);
      notify(message);
    } catch (e) {
      if (current()) notify((e as Error).message, true);
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function refreshUser() {
    if (!current()) return;
    try {
      const reply = await api('/auth/me');
      if (current()) changed(reply.user);
    } catch {
      if (current()) changed(null);
    }
  }
  const form = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return new FormData(e.currentTarget);
  };
  if (error)
    return (
      <p className="error-block" role="alert">
        {error}
      </p>
    );
  if (!data) return <p>Wczytywanie ustawień organizacji…</p>;
  const { tenant, usage } = data;
  return (
    <div className="saas-settings">
      <section className="panel">
        <div className="panel-heading">
          <h2>
            <Building2 size={20} /> Organizacja
          </h2>
          <span className="badge">{tenant.plan_name}</span>
        </div>
        <form
          className="workspace-form"
          onSubmit={(e) => {
            const f = form(e);
            void action(async () => {
              await api('/workspaces/settings', 'PATCH', {
                name: f.get('name'),
                locale: f.get('locale'),
              });
              await refreshUser();
            }, 'Zapisano ustawienia organizacji.');
          }}
        >
          <label>
            Nazwa organizacji
            <input
              key={tenant.name}
              name="name"
              defaultValue={tenant.name}
              minLength={2}
              maxLength={100}
              required
              disabled={!admin || busy || readOnly}
            />
          </label>
          <label>
            Język i region
            <select name="locale" defaultValue={tenant.locale} disabled={!admin || busy || readOnly}>
              <option value="pl-PL">Polski · Polska</option>
              <option value="en-GB">English · United Kingdom</option>
              <option value="de-DE">Deutsch · Deutschland</option>
              <option value="cs-CZ">Čeština · Česko</option>
            </select>
          </label>
          <p className="muted">
            Waluta organizacji: <strong>{tenant.currency}</strong>. Ustalana przy jej tworzeniu.
          </p>
          {admin && (
            <button className="button primary" disabled={busy || readOnly}>
              Zapisz organizację
            </button>
          )}
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>
            <ShieldCheck size={20} /> Plan i wykorzystanie
          </h2>
          <small>Bez opłat · konfiguracja lokalna</small>
        </div>
        <div className="quota-list">
          {Object.entries(tenant.limits).map(([resource, limit]) => {
            const used =
              usage[resource] + (resource === 'memberships' ? data.pending_invitations : 0);
            return (
              <div key={resource}>
                <div>
                  <strong>{labels[resource]}</strong>
                  <span>
                    {used.toLocaleString('pl-PL')} / {Number(limit).toLocaleString('pl-PL')}
                  </span>
                </div>
                <progress aria-label={labels[resource]} value={used} max={Number(limit)} />
                {resource === 'memberships' && data.pending_invitations > 0 && (
                  <small>W tym {data.pending_invitations} oczekujących zaproszeń.</small>
                )}
              </div>
            );
          })}
        </div>
        {admin && !data.billing_available && (
          <form
            className="workspace-plan"
            onSubmit={(e) => {
              const f = form(e);
              void action(async () => {
                await api('/workspaces/plan', 'PATCH', { plan: f.get('plan') });
                await refreshUser();
              }, 'Zmieniono plan lokalny. Nie naliczono opłat.');
            }}
          >
            <label>
              Plan organizacji
              <select key={tenant.plan} name="plan" defaultValue={tenant.plan} disabled={busy || readOnly}>
                {data.plans.map((p: any) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="button secondary" disabled={busy || readOnly}>
              Zmień plan lokalny
            </button>
          </form>
        )}
      </section>
      {data.billing_available && (
        <WorkspaceBillingPanel
          key={scope}
          contextKey={scope}
          readOnly={readOnly}
          refresh={refresh + revision}
          onChanged={async () => {
            setRevision((r) => r + 1);
            await refreshUser();
          }}
        />
      )}
      {admin && (
        <section className="panel workspace-team">
          <div className="panel-heading">
            <h2>
              <Users size={20} /> Zespół
            </h2>
            <small>{data.members.length} użytkowników</small>
          </div>
          <div className="workspace-members">
            {data.members.map((m: any) => (
              <div key={m.id}>
                <div>
                  <strong>
                    {m.name}
                    {m.id === user.id ? ' (Ty)' : ''}
                  </strong>
                  <small>{m.email}</small>
                </div>
                <label>
                  <span className="sr-only">Rola: {m.email}</span>
                  <select
                    aria-label={'Rola: ' + m.email}
                    value={m.role}
                    disabled={busy || readOnly}
                    onChange={(e) => {
                      const newRole = e.target.value;
                      void action(async () => {
                        await api('/workspaces/members/' + m.id, 'PATCH', { role: newRole });
                        await refreshUser();
                      }, 'Zmieniono rolę użytkownika.');
                    }}
                  >
                    {Object.entries(roles).map(([r, text]) => (
                      <option key={r} value={r}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
                {(m.role === 'operator' || m.role === 'admin') && (
                  // "Automatyzacje: edycja" (267): the administrator always has it, an operator gets it here.
                  <label className="workspace-member-right" title={m.role === 'admin' ? 'Administrator ma to uprawnienie zawsze' : undefined}>
                    <input
                      type="checkbox"
                      aria-label={'Automatyzacje: edycja: ' + m.email}
                      checked={m.role === 'admin' || m.automation_editor === true}
                      disabled={busy || readOnly || m.role === 'admin'}
                      onChange={(e) => {
                        const editor = e.target.checked;
                        void action(async () => {
                          await api('/workspaces/members/' + m.id, 'PATCH', { role: m.role, automation_editor: editor });
                          if (m.id === user.id) await refreshUser();
                        }, editor ? 'Nadano uprawnienie „Automatyzacje: edycja”.' : 'Odebrano uprawnienie „Automatyzacje: edycja”.');
                      }}
                    />
                    Automatyzacje: edycja
                  </label>
                )}
                <button
                  className="button ghost"
                  disabled={busy || readOnly}
                  onClick={() => {
                    void action(async () => {
                      await api('/workspaces/members/' + m.id, 'DELETE');
                      if (m.id === user.id) await refreshUser();
                    }, 'Odebrano dostęp do organizacji.');
                  }}
                >
                  Odbierz dostęp
                </button>
              </div>
            ))}
          </div>
          <form
            className="workspace-invite"
            onSubmit={(e) => {
              const f = form(e);
              void action(async () => {
                const r = await api('/workspaces/invitations', 'POST', {
                  email: f.get('email'),
                  role: f.get('role'),
                });
                if (!current()) return;
                setInvitation(location.origin + r.join_path);
                setCopied(false);
              }, 'Utworzono zaproszenie. Przekaż link wybranej osobie.');
            }}
          >
            <label>
              Email zapraszanej osoby
              <input
                name="email"
                type="email"
                placeholder="osoba@firma.pl"
                required
                disabled={busy || readOnly}
              />
            </label>
            <label>
              Uprawnienia
              <select name="role" defaultValue="operator" disabled={busy || readOnly}>
                {Object.entries(roles).map(([r, text]) => (
                  <option key={r} value={r}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            <button className="button primary" disabled={busy || readOnly}>
              Utwórz zaproszenie
            </button>
          </form>
          <p className="muted">
            Link ważny przez 7 dni, dla wskazanego adresu email. Przekazujesz go samodzielnie;
            system nie wysyła wiadomości.
          </p>
          {invitation && (
            <div className="workspace-invitation-link">
              <label>
                Link zaproszenia
                <input readOnly value={invitation} aria-label="Link zaproszenia" />
              </label>
              <button
                className="button secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(invitation);
                    setCopied(true);
                  } catch {
                    notify('Skopiuj link z pola zaproszenia.');
                  }
                }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? 'Skopiowano' : 'Kopiuj link'}
              </button>
            </div>
          )}
          {data.invitations.length > 0 && (
            <div className="workspace-pending">
              <h3>Oczekujące zaproszenia</h3>
              {data.invitations.map((i: any) => (
                <div key={i.id}>
                  <span>
                    <strong>{i.email}</strong>
                    <small>
                      {roles[i.role]} · wygasa {new Date(i.expires_at).toLocaleDateString('pl-PL')}
                    </small>
                  </span>
                  <button
                    className="button ghost"
                    disabled={busy || readOnly}
                    onClick={() => {
                      void action(async () => {
                        await api('/workspaces/invitations/' + i.id, 'DELETE');
                      }, 'Unieważniono zaproszenie.');
                    }}
                  >
                    Unieważnij
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>
            <Plus size={20} /> Nowa organizacja
          </h2>
        </div>
        <form
          className="workspace-form"
          onSubmit={(e) => {
            const f = form(e);
            void action(async () => {
              const r = await api('/workspaces', 'POST', {
                name: f.get('name'),
                currency: f.get('currency'),
                locale: 'pl-PL',
              });
              if (current()) changed(r.user);
            }, 'Utworzono organizację i przełączono do niej widok.', false);
          }}
        >
          <label>
            Nazwa nowej organizacji
            <input
              name="name"
              minLength={2}
              maxLength={100}
              placeholder="Nazwa firmy"
              required
              disabled={busy || readOnly}
            />
          </label>
          <label>
            Waluta
            <select name="currency" defaultValue="PLN" disabled={busy || readOnly}>
              {['PLN', 'EUR', 'USD', 'GBP', 'CZK'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <p className="muted">
            Plan Starter, pusty katalog i osobny magazyn MAIN. Dane każdej organizacji są
            odizolowane.
          </p>
          <button className="button secondary" disabled={busy || readOnly}>
            Utwórz organizację
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>
            <ArrowRight size={20} /> Dołącz do organizacji
          </h2>
        </div>
        <form
          className="workspace-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const token = joinToken.includes('#invite=')
                ? new URLSearchParams(joinToken.split('#')[1]).get('invite')
                : joinToken;
              const r = await api('/workspaces/invitations/accept', 'POST', { token });
              if (!current()) return;
              history.replaceState(null, '', location.pathname);
              changed(r.user);
            }, 'Przyjęto zaproszenie i przełączono organizację.', false);
          }}
        >
          <label>
            Link lub kod zaproszenia
            <input
              value={joinToken}
              onChange={(e) => setJoinToken(e.target.value)}
              autoComplete="off"
              placeholder="Wklej link otrzymany od administratora"
              required
              disabled={busy || readOnly}
            />
          </label>
          <button className="button secondary" disabled={busy || readOnly}>
            Przyjmij zaproszenie
          </button>
        </form>
      </section>
    </div>
  );
}
