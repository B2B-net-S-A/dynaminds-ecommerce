import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  KeyRound,
  Webhook,
  Copy,
  Eye,
  EyeOff,
  Check,
  ExternalLink,
  ShieldCheck,
  RotateCw,
} from 'lucide-react';
import { api, ApiError, date } from './api';

const scopeLabels: Record<string, string> = {
  'crm:read': 'CRM · odczyt',
  'crm:write': 'CRM · zapis',
  'purchasing:read': 'Zakupy · odczyt',
  'purchasing:write': 'Zakupy · zapis',
  'orders:read': 'Zamówienia · odczyt',
  'orders:write': 'Zamówienia · zapis',
  'products:read': 'Produkty · odczyt',
  'products:write': 'Produkty · zapis',
  'inventory:read': 'Magazyn · odczyt',
  'inventory:write': 'Magazyn · zapis',
  'documents:read': 'Dokumenty · odczyt',
  'documents:write': 'Dokumenty · zapis',
  'integrations:read': 'Integracje · odczyt',
  'integrations:write': 'Integracje · zapis',
};
const defaultScopes = ['purchasing:read', 'orders:read', 'products:read', 'inventory:read', 'documents:read'];
const eventLabels: Record<string, string> = {
  'order.created': 'Nowe zamówienie',
  'order.status_changed': 'Zmiana statusu',
  'order.updated': 'Aktualizacja zamówienia',
  'item.scanned': 'Skan produktu',
};
const stateLabels: Record<string, string> = {
  queued: 'W kolejce',
  delivered: 'Dostarczono',
  failed: 'Błąd',
  cancelled: 'Anulowano',
};
function Secret({
  value,
  label,
  clear,
  children,
}: {
  value: string;
  label: string;
  clear: () => void;
  children?: React.ReactNode;
}) {
  const [shown, setShown] = useState(false),
    [copied, setCopied] = useState(false);
  return (
    <div className="developer-secret">
      <strong>{label}</strong>
      <p>Zapisz teraz. Po zamknięciu nie będzie ponownie wyświetlany.</p>
      <div className="developer-secret-actions">
        <input
          aria-label={label}
          type={shown ? 'text' : 'password'}
          readOnly
          value={value}
          autoComplete="off"
        />
        <button
          className="button"
          aria-label={shown ? 'Ukryj sekret' : 'Pokaż sekret'}
          onClick={() => setShown(!shown)}
        >
          {shown ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        <button
          className="button"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />} Kopiuj
        </button>
        <button className="button" onClick={clear}>
          Zamknij sekret
        </button>
      </div>
      {children}
    </div>
  );
}
export function DeveloperPanel({
  admin,
  refresh,
  notify,
  readOnly = false,
  contextKey = 'developer',
}: {
  admin: boolean;
  refresh: number;
  notify: (text: string, error?: boolean) => void;
  readOnly?: boolean;
  contextKey?: string;
}) {
  const access = useRef({ admin, readOnly, contextKey }),
    alive = useRef(false),
    sequence = useRef(0),
    inFlight = useRef<number | null>(null);
  access.current = { admin, readOnly, contextKey };
  const current = () => alive.current && access.current.contextKey === contextKey;
  const allowed = (writing: boolean) => current() && access.current.admin && (!writing || !access.current.readOnly);
  const [keys, setKeys] = useState<any[]>([]),
    [hooks, setHooks] = useState<any>(null),
    // 237: rotation lineage and last use per key; null when the database has no 237.
    [keyState, setKeyState] = useState<Map<string, any> | null>(null),
    [rotating, setRotating] = useState('');
  const [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [token, setToken] = useState(''),
    [secret, setSecret] = useState(''),
    [keyId, setKeyId] = useState('');
  const [scopes, setScopes] = useState(defaultScopes);
  const [events, setEvents] = useState(['order.created', 'order.status_changed']);
  const [mode, setMode] = useState('local'),
    [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const [allDeliveries, setAllDeliveries] = useState(false),
    [allInbox, setAllInbox] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    ++sequence.current;
    inFlight.current = null;
    setBusy(false);
    setToken('');
    setSecret('');
    setKeyId('');
    setRotating('');
  }, [admin, readOnly, contextKey]);
  useEffect(() => {
    if (!admin) return;
    let active = true;
    Promise.all([
      api('/developer/keys'),
      api('/developer/webhooks'),
      api('/developer/keys/state').catch((e) =>
        e instanceof ApiError && e.status === 404 ? null : Promise.reject(e),
      ),
    ])
      .then(([k, h, s]) => {
        if (active) {
          setKeys(k.data);
          setHooks(h);
          setKeyState(s ? new Map(s.data.map((row: any) => [row.key_id, row])) : null);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [admin, refresh, revision, contextKey, readOnly]);
  async function action(fn: (canApply: () => boolean) => Promise<void>, message: string, writing = true) {
    if (!allowed(writing) || inFlight.current !== null) return;
    const id = ++sequence.current;
    inFlight.current = id;
    const canApply = () => inFlight.current === id && allowed(writing);
    setBusy(true);
    try {
      await fn(canApply);
      if (canApply()) {
        setRevision((r) => r + 1);
        notify(message);
      }
    } catch (e) {
      if (canApply()) notify((e as Error).message, true);
    } finally {
      if (inFlight.current === id) {
        inFlight.current = null;
        if (current()) setBusy(false);
      }
    }
  }
  const form = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return new FormData(e.currentTarget);
  };
  const toggle = (v: string, list: string[], set: (v: string[]) => void) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const toggleScope = (scope: string) => {
    setScopes((current) => {
      if (scope === 'crm:write' && !current.includes(scope))
        return [...new Set([...current, 'crm:read', 'crm:write'])];
      if (scope === 'crm:read' && current.includes(scope))
        return current.filter((value) => value !== 'crm:read' && value !== 'crm:write');
      return current.includes(scope)
        ? current.filter((value) => value !== scope)
        : [...current, scope];
    });
  };
  if (!admin) return <p className="error-block">Wymagana rola administratora organizacji.</p>;
  if (error)
    return (
      <p className="error-block" role="alert">
        {error}
      </p>
    );
  if (!hooks) return <p>Wczytywanie dostępu API…</p>;
  return (
    <div className="developer-workspace">
      {readOnly && <p className="notice">Podgląd kopii jest tylko do odczytu. Możesz przeglądać klucze i historię webhooków.</p>}
      <div className="developer-banner">
        <div>
          <strong>Twoja organizacja. Twoje połączenia.</strong>
          <p>
            Klucze działają tylko w tej organizacji. Webhooki przekazują zdarzenia do wybranego
            odbiorcy.
          </p>
        </div>
        <a className="button" href="/api/v1/openapi" target="_blank" rel="noreferrer">
          <ExternalLink size={16} /> Specyfikacja OpenAPI
        </a>
      </div>
      <div className="developer-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>
              <KeyRound size={18} /> Klucze API
            </h2>
            <span className="badge">
              {keys.filter((k) => !k.revoked_at && Date.parse(k.expires_at) > Date.now()).length} /
              20 aktywnych
            </span>
          </div>
          <form
            className="developer-form"
            onSubmit={(e) => {
              const f = form(e);
              void action(async (canApply) => {
                const k = await api('/developer/keys', 'POST', {
                  name: f.get('name'),
                  scopes,
                  expires_days: Number(f.get('expires_days')),
                });
                if (canApply()) {
                  setToken(k.token);
                  setKeyId(k.id);
                }
              }, 'Utworzono klucz API. Zapisz go w bezpiecznym miejscu.');
            }}
          >
            <label>
              Nazwa klucza
              <input
                name="name"
                disabled={readOnly || busy}
                required
                minLength={2}
                maxLength={100}
                placeholder="np. Własny sklep"
              />
            </label>
            <fieldset disabled={readOnly || busy}>
              <legend>Uprawnienia klucza</legend>
              <div className="developer-checks">
                {Object.entries(scopeLabels).map(([s, label]) => (
                  <label key={s}>
                    <input
                      type="checkbox"
                      checked={scopes.includes(s)}
                      onChange={() => toggleScope(s)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="developer-row">
              <label>
                Ważność
                <select name="expires_days" defaultValue="30" disabled={readOnly || busy}>
                  {[1, 7, 30, 90].map((n) => (
                    <option key={n} value={n}>
                      {n} {n === 1 ? 'dzień' : 'dni'}
                    </option>
                  ))}
                </select>
              </label>
              <button className="button primary" disabled={readOnly || busy || !scopes.some((s) => !s.startsWith('crm:')) || !!token}>
                Utwórz klucz API
              </button>
            </div>
            {scopes.length > 0 && scopes.every((s) => s.startsWith('crm:')) && (
              <p className="muted">Zakresy CRM wymagają co najmniej jednego zakresu spoza CRM.</p>
            )}
          </form>
          {token && (
            <Secret value={token} label="Nowy klucz API" clear={() => setToken('')}>
              <button
                className="button"
                disabled={busy || !scopes.includes('orders:read')}
                onClick={() =>
                  void action(async (canApply) => {
                    const r = await api('/v1/orders?limit=1', 'GET', undefined, {
                      Authorization: 'Bearer ' + token,
                    });
                    if (canApply()) notify(`Odczyt przez klucz API działa. Pobrano ${r.data.length} zamówień.`);
                  }, 'Klucz API zweryfikowany przez odczyt zamówień.', false)
                }
              >
                Test odczytu zamówień
              </button>
            </Secret>
          )}
          <div className="developer-list">
            {!keys.length && (
              <p className="muted">
                Nie ma jeszcze kluczy. Nadaj dostęp tylko do potrzebnych obszarów.
              </p>
            )}
            {keys.map((k) => {
              const revoked = !!k.revoked_at,
                expired = Date.parse(k.expires_at) <= Date.now();
              return (
                <div className="developer-item" key={k.id}>
                  <div>
                    <strong>{k.name}</strong>
                    <code>{k.prefix}…</code>
                    <small>{k.scopes.map((s: string) => scopeLabels[s]).join(' · ')}</small>
                    <small>
                      {revoked
                        ? 'Unieważniony'
                        : expired
                          ? 'Wygasł'
                          : 'Ważny do ' + date(k.expires_at)}
                    </small>
                    {keyState && (
                      <small>
                        {keyState.get(k.id)?.last_used_at
                          ? `Ostatnie użycie: ${date(keyState.get(k.id).last_used_at)}${keyState.get(k.id).last_used_ip ? ' z ' + keyState.get(k.id).last_used_ip : ''}`
                          : 'Jeszcze nie użyty'}
                        {keyState.get(k.id)?.rotated_from_id &&
                          ` · następca klucza ${keys.find((o) => o.id === keyState.get(k.id).rotated_from_id)?.prefix ?? ''}…`}
                      </small>
                    )}
                  </div>
                  {keyState && !revoked && !expired && rotating !== k.id && (
                    <button
                      className="button"
                      disabled={readOnly || busy || !!token}
                      aria-label={'Rotuj klucz ' + k.name}
                      onClick={() => {
                        if (allowed(true)) setRotating(k.id);
                      }}
                    >
                      <RotateCw size={14} /> Rotuj
                    </button>
                  )}
                  {rotating === k.id && (
                    <form
                      className="developer-rotate"
                      aria-label={'Rotacja klucza ' + k.name}
                      onSubmit={(e) => {
                        const f = form(e);
                        void action(async (canApply) => {
                          const r = await api('/developer/keys/' + k.id + '/rotate', 'POST', {
                            overlap_seconds: Number(f.get('overlap_seconds')),
                          });
                          if (canApply()) {
                            setRotating('');
                            setToken(r.token);
                            setKeyId(r.id);
                          }
                        }, 'Wydano nowy klucz API z tymi samymi uprawnieniami. Zapisz go i podmień w integracji.');
                      }}
                    >
                      <label>
                        Stary klucz
                        <select name="overlap_seconds" defaultValue="0" disabled={readOnly || busy}>
                          <option value="0">unieważnij od razu</option>
                          <option value="300">działa jeszcze 5 minut</option>
                          <option value="900">działa jeszcze 15 minut</option>
                          <option value="3600">działa jeszcze 60 minut</option>
                        </select>
                      </label>
                      <button className="button primary" disabled={readOnly || busy}>
                        Potwierdź rotację
                      </button>
                      <button className="button" type="button" disabled={busy} onClick={() => setRotating('')}>
                        Anuluj
                      </button>
                    </form>
                  )}
                  {!revoked && (
                    <button
                      className="button danger"
                      disabled={readOnly || busy}
                      aria-label={'Unieważnij klucz ' + k.name}
                      onClick={() =>
                        void action(async (canApply) => {
                          await api('/developer/keys/' + k.id, 'DELETE');
                          if (canApply() && keyId === k.id) setToken('');
                        }, 'Unieważniono klucz API.')
                      }
                    >
                      Unieważnij
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>
              <Webhook size={18} /> Webhooki wychodzące
            </h2>
            <span className="badge">
              {hooks.subscriptions.filter((s: any) => s.enabled).length} włączonych
            </span>
          </div>
          <form
            className="developer-form"
            onSubmit={(e) => {
              const f = form(e);
              void action(async (canApply) => {
                const s = await api('/developer/webhooks', 'POST', {
                  name: f.get('name'),
                  mode,
                  events,
                  ...(mode === 'https' ? { url: f.get('url') } : {}),
                });
                if (canApply()) setSecret(s.secret);
              }, 'Zapisano webhook. Włącz go po sprawdzeniu odbiorcy.');
            }}
          >
            <label>
              Nazwa webhooka
              <input
                name="name"
                disabled={readOnly || busy}
                required
                minLength={2}
                maxLength={100}
                placeholder="np. Powiadomienia o zamówieniach"
              />
            </label>
            <label>
              Odbiorca
              <select value={mode} disabled={readOnly || busy} onChange={(e) => setMode(e.target.value)}>
                <option value="local">Lokalna skrzynka testowa</option>
                <option value="https">Publiczny endpoint HTTPS</option>
              </select>
            </label>
            {mode === 'https' ? (
              <label>
                Adres odbiorcy
                <input
                  name="url"
                  disabled={readOnly || busy}
                  type="url"
                  required
                  placeholder="https://twoja-domena.pl/webhooks"
                />
                <small>Publiczny HTTPS, port 443, bez parametrów i danych logowania.</small>
              </label>
            ) : (
              <p className="muted">
                Zdarzenia trafią do skrzynki poniżej. Podpis jest sprawdzany przy każdym odbiorze.
              </p>
            )}
            <fieldset disabled={readOnly || busy}>
              <legend>Zdarzenia</legend>
              <div className="developer-checks">
                {Object.entries(eventLabels).map(([s, label]) => (
                  <label key={s}>
                    <input
                      type="checkbox"
                      checked={events.includes(s)}
                      onChange={() => toggle(s, events, setEvents)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <button className="button primary" disabled={readOnly || busy || !events.length || !!secret}>
              Dodaj webhook
            </button>
          </form>
          {secret && (
            <Secret value={secret} label="Sekret podpisu webhooka" clear={() => setSecret('')} />
          )}
          <div className="developer-list">
            {!hooks.subscriptions.length && (
              <p className="muted">Dodaj webhook i wybierz zdarzenia, które chcesz otrzymywać.</p>
            )}
            {hooks.subscriptions.map((s: any) => (
              <div className="developer-hook" key={s.id}>
                <div className="developer-item">
                  <div>
                    <strong>{s.name}</strong>
                    <small>{s.mode === 'local' ? 'Lokalna skrzynka testowa' : s.url}</small>
                    <small>{s.events.map((v: string) => eventLabels[v]).join(' · ')}</small>
                  </div>
                  <span className={'badge ' + (s.enabled ? 'status-delivered' : '')}>
                    {s.revoked_at ? 'Unieważniony' : s.enabled ? 'Włączony' : 'Wyłączony'}
                  </span>
                </div>
                {!s.revoked_at && (
                  <div className="developer-hook-actions">
                    {!s.enabled && s.mode === 'https' && (
                      <label>
                        Wpisz adres, aby zatwierdzić wysyłanie
                        <input
                          aria-label={'Potwierdź adres ' + s.name}
                          disabled={readOnly || busy}
                          value={confirmations[s.id] ?? ''}
                          onChange={(e) =>
                            setConfirmations((v) => ({ ...v, [s.id]: e.target.value }))
                          }
                        />
                      </label>
                    )}
                    <div className="developer-row">
                      <button
                        className="button"
                        disabled={
                          readOnly || busy ||
                          (!s.enabled && s.mode === 'https' && confirmations[s.id] !== s.url)
                        }
                        onClick={() =>
                          void action(
                            async () => {
                              await api(
                                '/developer/webhooks/' +
                                  s.id +
                                  (s.enabled ? '/disable' : '/enable'),
                                'POST',
                                s.enabled
                                  ? undefined
                                  : {
                                      confirm_destination:
                                        s.mode === 'local' ? 'local' : confirmations[s.id],
                                    },
                              );
                            },
                            s.enabled
                              ? 'Wyłączono webhook.'
                              : 'Włączono webhook dla wybranego odbiorcy.',
                          )
                        }
                      >
                        {s.enabled
                          ? 'Wyłącz webhook'
                          : s.mode === 'local'
                            ? 'Włącz skrzynkę lokalną'
                            : 'Zatwierdź wysyłanie HTTPS'}
                      </button>
                      <button
                        className="button danger"
                        disabled={readOnly || busy}
                        aria-label={'Unieważnij webhook ' + s.name}
                        onClick={() =>
                          void action(async () => {
                            await api('/developer/webhooks/' + s.id + '/revoke', 'POST');
                          }, 'Unieważniono webhook.')
                        }
                      >
                        Unieważnij
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>
            <Webhook size={18} /> Historia dostaw
          </h2>
          <button className="button" disabled={busy} onClick={() => setRevision((r) => r + 1)}>
            Odśwież dostawy
          </button>
        </div>
        {!hooks.deliveries.length ? (
          <p className="developer-empty">Po włączeniu webhooka nowe zdarzenia pojawią się tutaj.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Zdarzenie / odbiorca</th>
                  <th>Stan</th>
                  <th>HTTP</th>
                  <th>Próby</th>
                  <th>Czas</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {hooks.deliveries.slice(0, allDeliveries ? 50 : 10).map((d: any) => (
                  <tr key={d.id}>
                    <td>
                      <strong>{eventLabels[d.event_type]}</strong>
                      <small>{d.name}</small>
                      <code className="developer-id" title={d.id}>
                        {d.id.slice(0, 8)}…
                      </code>
                      {d.error && <small className="text-danger">{d.error}</small>}
                    </td>
                    <td>
                      <span className={'badge status-' + d.state}>{stateLabels[d.state]}</span>
                    </td>
                    <td>{d.response_status ?? '—'}</td>
                    <td>{d.attempts}</td>
                    <td>{date(d.delivered_at ?? d.created_at)}</td>
                    <td>
                      {['failed', 'cancelled'].includes(d.state) && (
                        <button
                          className="button"
                          disabled={readOnly || busy}
                          onClick={() =>
                            void action(async () => {
                              await api('/developer/deliveries/' + d.id + '/retry', 'POST');
                            }, 'Dostawa wróciła do kolejki.')
                          }
                        >
                          Ponów
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {hooks.deliveries.length > 10 && (
        <button className="button developer-more" onClick={() => setAllDeliveries((v) => !v)}>
          {allDeliveries
            ? 'Zwiń historię dostaw'
            : `Pokaż wszystkie dostawy (${hooks.deliveries.length})`}
        </button>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>
            <ShieldCheck size={18} /> Lokalna skrzynka webhooków
          </h2>
          <span className="badge">{hooks.inbox.length} ostatnich odbiorów</span>
        </div>
        {!hooks.inbox.length ? (
          <p className="developer-empty">
            Włącz lokalny webhook i utwórz lub zmień zamówienie. Zobaczysz odebrane zdarzenia z
            potwierdzonym podpisem.
          </p>
        ) : (
          <div className="developer-inbox">
            {hooks.inbox.slice(0, allInbox ? 20 : 5).map((i: any) => (
              <details key={i.delivery_id}>
                <summary>
                  <div>
                    <strong>{eventLabels[i.payload.type]}</strong>
                    <small>
                      Zamówienie {i.payload.order.id.slice(0, 8)}… · {i.payload.order.status} ·{' '}
                      {date(i.received_at)}
                    </small>
                  </div>
                  <span className="badge status-delivered">
                    <Check size={12} /> Podpis sprawdzony
                  </span>
                </summary>
                <p className="muted">Dostawa: {i.delivery_id}</p>
                <pre>{JSON.stringify(i.payload, null, 2)}</pre>
              </details>
            ))}
          </div>
        )}
      </section>
      {hooks.inbox.length > 5 && (
        <button className="button developer-more" onClick={() => setAllInbox((v) => !v)}>
          {allInbox ? 'Zwiń skrzynkę' : `Pokaż wszystkie odbiory (${hooks.inbox.length})`}
        </button>
      )}
      <p className="muted developer-footnote">
        Dostawy są ponawiane po awarii. Odbiorca powinien deduplikować je po identyfikatorze
        dostawy. Skrzynka wyświetla maksymalnie 20 ostatnich zdarzeń.
      </p>
    </div>
  );
}
