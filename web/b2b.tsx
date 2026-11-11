import {CatalogAttributesRead} from './catalog-attributes';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { B2bCatalogScopePanel, b2bCatalogSiblingWriteGuard, resetB2bCatalogScopeContext, subscribeB2bCatalogScopeLock } from './b2b-catalog-scope';
import { api, money, date, statusNames } from './api';
import { B2bTradeCreditPanel, TradeCreditBalanceFrom } from './b2b-trade-credit';
import { B2bAccountNetworkLink, B2bNetworkDecisionInbox } from './b2b-network-lifecycle';
import { PriceListPicker } from './pricing';
import {
  B2bDropshippingReturnSettings,
  useDropshipReturnWriteState,
  performDropshipReturnWrite,
} from './b2b-dropshipping-returns';
const minor = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '0')
    .trim()
    .replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw Error('Kwota wymaga maksymalnie dwóch miejsc dziesiętnych');
  const [a, b = ''] = s.split('.');
  return Number(a) * 100 + Number(b.padEnd(2, '0'));
};
export function B2bPanel({
  admin,
  contextKey,
  readOnly,
  catalogContextKey,
  externalWriteBlocked = false,
}: {
  admin: boolean;
  contextKey: string;
  readOnly: boolean;
  catalogContextKey?: string;
  externalWriteBlocked?: boolean;
}) {
  const catalogKey = catalogContextKey ?? `${contextKey}:${readOnly}`;
  const [scopeAccount, setScopeAccount] = useState<{ id: string; name: string } | null>(null), [catalogLocked, setCatalogLocked] = useState(false);
  const alive = useRef(false), latest = useRef({ catalogKey, admin, readOnly, externalWriteBlocked, sharedLocked: false });
  const sharedWrites = useDropshipReturnWriteState(contextKey, readOnly);
  latest.current = { catalogKey, admin, readOnly, externalWriteBlocked, sharedLocked: sharedWrites.locked };
  const guardFreshWrite = b2bCatalogSiblingWriteGuard(catalogKey, retry => alive.current && latest.current.catalogKey === catalogKey && latest.current.admin && !latest.current.readOnly && (retry || (!latest.current.externalWriteBlocked && !latest.current.sharedLocked)));
  const [returnAccount, setReturnAccount] = useState<{ id: string; name: string } | null>(null);
  const [creditAccount, setCreditAccount] = useState<{ id: string; name: string } | null>(null);
  const [networkAccount, setNetworkAccount] = useState<{ id: string; name: string } | null>(null);
  const [returnLocked, setReturnLocked] = useState(false);
  const accountLocked = sharedWrites.locked || returnLocked || readOnly || externalWriteBlocked || catalogLocked;
  const legacyAccountHold = sharedWrites.entries.find((entry) =>
    entry.scope.startsWith(`${contextKey}:${readOnly}:legacy-b2b-account:`),
  );
  const [data, setData] = useState<any>(null),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [editing, setEditing] = useState<any>(null),
    [list, setList] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [invite, setInvite] = useState(''),
    [after, setAfter] = useState<string | undefined>(),
    [search, setSearch] = useState('');
  async function load() {
    const d = await api('/b2b/accounts?' + new URLSearchParams({ search, ...(after ? { after } : {}) }));
    if (alive.current && latest.current.catalogKey === catalogKey) setData(d);
  }
  useEffect(() => {
    alive.current = true; resetB2bCatalogScopeContext(catalogKey);
    setScopeAccount(null); setReturnAccount(null); setCreditAccount(null); setNetworkAccount(null); setEditing(null); setData(null); setList(null); setInvite(''); setError('');
    const un = subscribeB2bCatalogScopeLock(catalogKey, setCatalogLocked);
    return () => { alive.current = false; un(); };
  }, [catalogKey, readOnly]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [after, search, catalogKey]);
  useEffect(() => {
    api('/warehouses')
      .then((d) => { if (alive.current && latest.current.catalogKey === catalogKey) setWarehouses(d.data); })
      .catch((e) => setError(e.message));
  }, [catalogKey]);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!admin || accountLocked || busy) return;
    setBusy(true);
    setError('');
    try {
      const f = new FormData(e.currentTarget),
        text = (k: string) => String(f.get(k) ?? '');
      if (!list?.id) throw Error('Wybierz cennik z cenami SKU');
      const body = {
        name: text('name'),
        email: text('email'),
        tax_id: text('tax_id'),
        warehouse_id: text('warehouse'),
        price_list_id: list.id,
        address: {
          street: text('street'),
          city: text('city'),
          postal_code: text('postal'),
          country: text('country'),
          phone: text('phone'),
        },
        min_total: minor(f.get('minimum')),
        shipping_cost: minor(f.get('shipping')),
        min_quantity: Number(f.get('quantity')),
        quantity_step: Number(f.get('step')),
        payment_mode: text('payment'),
        ...(editing.id
          ? { version: editing.version, active: f.get('active') === 'on', confirmed: true }
          : {}),
      };
      const path = '/b2b/accounts' + (editing.id ? '/' + editing.id : '');
      const fence = await guardFreshWrite(); fence();
      await performDropshipReturnWrite(
        contextKey,
        readOnly,
        `${contextKey}:${readOnly}:legacy-b2b-account:${editing.id ?? 'create'}`,
        {
          action: editing.id ? 'zmiana warunków kontrahenta' : 'utworzenie kontrahenta',
          path,
          method: editing.id ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
          retryable: false,
        },
      );
      if (!alive.current || latest.current.catalogKey !== catalogKey) return;
      setEditing(null);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="b2b-admin">
      <p className="notice">
        Oferta kontrahenta obejmuje aktywne produkty z jawnymi cenami SKU w przypisanym cenniku.
        Utworzone konto jest nieaktywne; zatwierdź warunki i przygotuj zaproszenie. Wiadomości nie
        są wysyłane.
      </p>
      {legacyAccountHold && !legacyAccountHold.inFlight && (
        <p className="notice">
          Wynik zapisu konta lub zaproszenia jest nieznany. Odczytaj istniejące konta i stan
          zaproszenia. Ten zapis nie obsługuje bezpiecznego ponowienia; odczyt nie usuwa blokady. Po
          sprawdzeniu wyniku ponownie zaloguj się lub przełącz kontekst firmy. System nie ponowi
          tego zapisu.
        </p>
      )}
      {legacyAccountHold && (
        <button
          className="button"
          disabled={busy}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          Odczytaj istniejące konta i zaproszenia
        </button>
      )}
      {sharedWrites.entries.length > 0 && (
        <p className="notice">
          Zapis zwrotu lub jego ustawień wymaga potwierdzenia. Nowe ustawienia kontrahentów są
          wstrzymane; odczytaj historię albo wróć do formularza właściciela próby.
        </p>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <div className="row">
        <label>
          Szukaj kontrahenta
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setAfter(undefined);
            }}
          />
        </label>
        {admin && (
          <button
            className="button primary"
            disabled={busy || accountLocked}
            onClick={() => {
              if (busy || accountLocked) return;
              setEditing({});
              setList(null);
              setInvite('');
            }}
          >
            Dodaj kontrahenta B2B
          </button>
        )}
      </div>
      {invite && (
        <p className="notice">
          <strong>Jednorazowe zaproszenie, ważne 24 godziny.</strong> Przekaż link kontrahentowi.
          Nowe zaproszenie wyłącza poprzednie hasło i sesje.
          <br />
          <a href={invite} target="_blank" rel="noreferrer">
            Otwórz zaproszenie B2B
          </a>
        </p>
      )}
      {editing && (
        <form onSubmit={save} className="card b2b-account-form" key={editing.id ?? 'new'}>
          <fieldset disabled={busy || accountLocked}>
            <h2>{editing.id ? 'Warunki kontrahenta' : 'Nowy kontrahent B2B'}</h2>
            <div className="form-grid">
              <label>
                Nazwa firmy
                <input name="name" required defaultValue={editing.name} />
              </label>
              <label>
                Email kontrahenta
                <input name="email" type="email" required defaultValue={editing.email} />
              </label>
              <label>
                NIP / identyfikator podatkowy
                <input name="tax_id" defaultValue={editing.tax_id} />
              </label>
              <label>
                Magazyn realizacji
                <select name="warehouse" defaultValue={editing.warehouse_id}>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <PriceListPicker
              value={list?.id ?? ''}
              initial={list}
              onChange={setList}
              label="Cennik kontrahenta"
            />
            <div className="form-grid">
              <label>
                Ulica dostawy
                <input name="street" required defaultValue={editing.address?.street} />
              </label>
              <label>
                Miasto dostawy
                <input name="city" required defaultValue={editing.address?.city} />
              </label>
              <label>
                Kod pocztowy
                <input name="postal" required defaultValue={editing.address?.postal_code} />
              </label>
              <label>
                Kraj dostawy
                <input
                  name="country"
                  required
                  minLength={2}
                  maxLength={2}
                  defaultValue={editing.address?.country ?? 'PL'}
                />
              </label>
              <label>
                Telefon dostawy
                <input name="phone" defaultValue={editing.address?.phone} />
              </label>
              <label>
                Minimalna wartość towarów brutto ({list?.currency ?? 'waluta cennika'})
                <input
                  name="minimum"
                  defaultValue={((editing.min_total ?? 0) / 100).toFixed(2)}
                  required
                />
              </label>
              <label>
                Koszt dostawy brutto
                <input
                  name="shipping"
                  defaultValue={((editing.shipping_cost ?? 0) / 100).toFixed(2)}
                  required
                />
              </label>
              <label>
                Minimum sztuk na SKU
                <input
                  name="quantity"
                  type="number"
                  min={1}
                  max={100000}
                  defaultValue={editing.min_quantity ?? 1}
                  required
                />
              </label>
              <label>
                Wielokrotność opakowania
                <input
                  name="step"
                  type="number"
                  min={1}
                  max={100000}
                  defaultValue={editing.quantity_step ?? 1}
                  required
                />
              </label>
              <label>
                Płatność
                <select name="payment" defaultValue={editing.payment_mode ?? 'prepaid'}>
                  <option value="prepaid">Przedpłata</option>
                  <option value="cod">Pobranie</option>
                </select>
              </label>
            </div>
            {editing.id && (
              <label className="check">
                <input name="active" type="checkbox" defaultChecked={editing.active} />
                Zatwierdzam aktywne konto i powyższe warunki współpracy
              </label>
            )}
            <p className="muted">
              Zmiana warunków kończy sesje kontrahenta. Przy ponownym logowaniu obowiązują aktualne
              ceny; zapisane zamówienia zachowują swoją wycenę.
            </p>
            <div className="row">
              <button className="button primary" disabled={busy}>
                Zapisz kontrahenta
              </button>
              <button type="button" className="button" onClick={() => setEditing(null)}>
                Zamknij formularz kontrahenta
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {returnAccount && (
        <section aria-label="Zwroty klientów kontrahenta">
          <h2>Zwroty · {returnAccount.name}</h2>
          <button className="button" disabled={returnLocked} onClick={() => setReturnAccount(null)}>
            Zamknij ustawienia zwrotów
          </button>
          <B2bDropshippingReturnSettings
            key={`${contextKey}:${readOnly}:${returnAccount.id}`}
            accountId={returnAccount.id}
            contextKey={contextKey}
            readOnly={readOnly}
            disabled={busy}
            externalWriteBlocked={externalWriteBlocked || catalogLocked}
            guardFreshWrite={guardFreshWrite}
            onLockedChange={setReturnLocked}
          />
        </section>
      )}
      <B2bNetworkDecisionInbox key={'decisions:' + catalogKey} admin={admin} readOnly={readOnly} />
      {networkAccount && <B2bAccountNetworkLink key={networkAccount.id} accountId={networkAccount.id} accountName={networkAccount.name} admin={admin} readOnly={readOnly} onClose={() => setNetworkAccount(null)} />}
      {creditAccount && <B2bTradeCreditPanel key={creditAccount.id} accountId={creditAccount.id} accountName={creditAccount.name} admin={admin} readOnly={readOnly} onClose={() => setCreditAccount(null)} />}
      {scopeAccount && <section aria-label="Ustawienia katalogu kontrahenta"><h2>Katalog · {scopeAccount.name}</h2><button type="button" className="button" onClick={() => setScopeAccount(null)}>Zamknij zakres katalogu</button><B2bCatalogScopePanel key={`supplier-scope:${catalogKey}:${scopeAccount.id}:${readOnly}`} contextKey={catalogKey} readOnly={readOnly} kind="supplier" entityId={scopeAccount.id} externalWriteBlocked={externalWriteBlocked || sharedWrites.locked || returnLocked || busy} onChanged={() => void load().catch(e => setError(e.message))} /></section>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Kontrahent</th>
              <th>Dostęp</th>
              <th>Warunki</th>
              <th>Portal</th>
            </tr>
          </thead>
          <tbody>
            {data?.data.map((a: any) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.name}</strong>
                  <small>{a.email}</small>
                </td>
                <td>
                  {a.active ? 'Aktywne' : 'Nieaktywne'} ·{' '}
                  {a.activated
                    ? 'Logowanie gotowe'
                    : a.invitation_pending
                      ? 'Zaproszenie przygotowane'
                      : 'Brak hasła'}
                </td>
                <td>
                  Minimum {a.min_quantity} szt. · opakowanie {a.quantity_step}
                </td>
                <td>
                  <a href={'/b2b/' + a.id} target="_blank" rel="noreferrer">
                    Portal kontrahenta
                  </a>
                  <button
                    type="button" className="button" disabled={busy}
                    onClick={() => setScopeAccount({ id: a.id, name: a.name })}
                  >Zakres katalogu B2B</button>
                  <button type="button" className="button" disabled={busy} onClick={() => setCreditAccount({ id: a.id, name: a.name })}>Kredyt kupiecki</button>
                  <button type="button" className="button" disabled={busy} onClick={() => setNetworkAccount({ id: a.id, name: a.name })}>Sieć B2B</button>
                  <button
                    className="button"
                    disabled={returnLocked || busy}
                    onClick={() => setReturnAccount({ id: a.id, name: a.name })}
                  >
                    Ustaw zwroty klientów
                  </button>
                  {admin && (
                    <>
                      <button
                        className="button"
                        disabled={busy || accountLocked}
                        onClick={async () => {
                          if (busy || accountLocked) return;
                          setError('');
                          try {
                            const lists = await api('/price-lists?limit=100');
                            if (!alive.current || latest.current.catalogKey !== catalogKey || latest.current.readOnly || latest.current.externalWriteBlocked || latest.current.sharedLocked || catalogLocked) return;
                            setList(
                              lists.data.find((l: any) => l.id === a.price_list_id) ?? {
                                id: a.price_list_id,
                                name: 'Przypisany cennik',
                              },
                            );
                            setEditing(a);
                            setInvite('');
                          } catch (e: any) {
                            setError(e.message);
                          }
                        }}
                      >
                        Ustaw warunki
                      </button>
                      <button
                        className="button"
                        disabled={busy || accountLocked || !a.active}
                        onClick={async () => {
                          if (busy || accountLocked) return;
                          setBusy(true);
                          setError('');
                          try {
                            const path = '/b2b/accounts/' + a.id + '/invite';
                            const fence = await guardFreshWrite(); fence();
                            const d = await performDropshipReturnWrite<{ invitation: string }>(
                              contextKey,
                              readOnly,
                              `${contextKey}:${readOnly}:legacy-b2b-account:${a.id}:invite`,
                              {
                                action: 'przygotowanie zaproszenia kontrahenta',
                                path,
                                method: 'POST',
                                body: JSON.stringify({ version: a.version, confirmed: true }),
                                retryable: false,
                              },
                            );
                            if (!alive.current || latest.current.catalogKey !== catalogKey) return;
                            setInvite(d.invitation);
                            await load();
                          } catch (e: any) {
                            setError(e.message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Przygotuj nowe zaproszenie
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="button" disabled={!after} onClick={() => setAfter(undefined)}>
          Pierwsza strona kontrahentów
        </button>
        <button className="button" disabled={!data?.next} onClick={() => setAfter(data.next)}>
          Następni kontrahenci
        </button>
      </div>
    </div>
  );
}
export function B2bPortal({ accountId }: { accountId: string }) {
  const [me, setMe] = useState<any>(null),
    [checked, setChecked] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [catalog, setCatalog] = useState<any>(null),
    [orders, setOrders] = useState<any>(null),
    [detail, setDetail] = useState<any>(null),
    [cart, setCart] = useState<Record<string, any>>({}),
    [quote, setQuote] = useState<any>(null),
    [search, setSearch] = useState(''),
    [after, setAfter] = useState<string | undefined>(),
    [orderAfter, setOrderAfter] = useState<string | undefined>(),
    [confirmation, setConfirmation] = useState(false),
    [invitation, setInvitation] = useState(
      new URLSearchParams(location.hash.slice(1)).get('invite') ?? '',
    ),
    [message, setMessage] = useState('');
  const call = (p: string, m = 'GET', b?: any) => api('/public/b2b/' + accountId + p, m, b);
  async function load() {
    const [c, o] = await Promise.all([
      call('/catalog?' + new URLSearchParams({ search, ...(after ? { after } : {}) })),
      call('/orders' + (orderAfter ? '?after=' + orderAfter : '')),
    ]);
    setCatalog(c);
    setOrders(o);
  }
  useEffect(() => {
    call('/me')
      .then(setMe)
      .catch(() => {})
      .finally(() => setChecked(true));
  }, [accountId]);
  useEffect(() => {
    if (me) load().catch((e) => setError(e.message));
  }, [me, search, after, orderAfter]);
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      if (invitation) {
        await call('/activate', 'POST', { token: invitation, password: String(f.get('password')) });
        history.replaceState(null, '', location.pathname);
        setInvitation('');
        setMessage('Konto aktywowane. Zaloguj się swoim emailem i hasłem.');
      } else {
        await call('/login', 'POST', {
          email: String(f.get('email')),
          password: String(f.get('password')),
        });
        setMe(await call('/me'));
        setMessage('');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function quoteCart() {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const q = await call('/quotes', 'POST', {
        client_key: crypto.randomUUID(),
        items: Object.values(cart)
          .filter((p: any) => p.quantity > 0)
          .map((p: any) => ({ product_id: p.id, quantity: p.quantity })),
      });
      setQuote(q);
      setConfirmation(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const selected = Object.values(cart).filter((p: any) => p.quantity > 0),
    a = me?.account;
  if (!checked) return <p>Wczytywanie portalu B2B…</p>;
  return (
    <div className="b2b-portal">
      <header>
        <a href="/">
          DYNAMINDS <span>Ecommerce</span>
        </a>
        <strong>{me ? me.seller : 'Portal B2B'}</strong>
        {me && (
          <button
            className="button"
            onClick={async () => {
              await call('/logout', 'POST', {});
              setMe(null);
              setCart({});
              setQuote(null);
              setDetail(null);
            }}
          >
            Wyloguj kontrahenta
          </button>
        )}
      </header>
      <main>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        {!me ? (
          <form className="card b2b-login" onSubmit={login}>
            <h1>{invitation ? 'Aktywuj konto kontrahenta' : 'Logowanie kontrahenta'}</h1>
            <p>Dostęp do cen i zamówień Twojej firmy.</p>
            {!invitation && (
              <label>
                Email kontrahenta
                <input name="email" type="email" required />
              </label>
            )}
            <label>
              {invitation ? 'Ustaw hasło (minimum 12 znaków)' : 'Hasło kontrahenta'}
              <input
                name="password"
                type="password"
                required
                minLength={invitation ? 12 : 1}
                autoComplete={invitation ? 'new-password' : 'current-password'}
              />
            </label>
            <button className="button primary" disabled={busy}>
              {invitation ? 'Aktywuj konto B2B' : 'Zaloguj kontrahenta'}
            </button>
          </form>
        ) : (
          <>
            <h1>Oferta dla {a.name}</h1>
            <p>
              {a.payment_mode === 'cod' ? 'Płatność przy odbiorze' : 'Przedpłata'} · minimum towarów{' '}
              {money(a.min_total, a.currency)} · minimum {a.min_quantity} szt. na SKU · opakowanie{' '}
              {a.quantity_step} szt.
            </p>
            {me.read_only && (
              <p className="notice">Podgląd kopii — składanie zamówień i zgłoszeń wyłączone.</p>
            )}
            <TradeCreditBalanceFrom path={'/public/b2b/' + accountId + '/trade-credit'} refresh={orders} title="Twój kredyt kupiecki" />
            <div className="b2b-shopping">
              <section className="card">
                <div className="row">
                  <h2>Katalog kontrahenta</h2>
                  <label>
                    Szukaj w ofercie
                    <input
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setAfter(undefined);
                      }}
                    />
                  </label>
                  <button
                    className="button"
                    onClick={() => load().catch((e) => setError(e.message))}
                  >
                    Odśwież ofertę i zamówienia
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Produkt</th>
                        <th>Cena brutto</th>
                        <th>Dostępne</th>
                        <th>Ilość</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catalog?.data.map((p: any) => (
                        <tr key={p.id}>
                          <td>
                            <strong>{p.name}</strong>
                            {p.images?.map((url: string) => (
                              <img
                                key={url}
                                className="b2b-product-image"
                                src={url}
                                alt={p.name}
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            ))}
                            <small>
                              {p.sku} · VAT {p.vat}%
                            </small>
                            <details>
                              <summary>Opis produktu</summary>
                              <p>{p.description || 'Brak opisu'}</p>
                              <CatalogAttributesRead attributes={p.attributes}/>
                            </details>
                          </td>
                          <td>
                            {money(
                              quote?.pricing.items.find((i: any) => i.product_id === p.id)?.price ??
                                p.price,
                              a.currency,
                            )}
                          </td>
                          <td>{p.available}</td>
                          <td>
                            <input
                              aria-label={'Ilość B2B ' + p.sku}
                              type="number"
                              min={0}
                              max={100000}
                              step={a.quantity_step}
                              value={cart[p.id]?.quantity ?? 0}
                              disabled={me.read_only || (!cart[p.id] && selected.length >= 100)}
                              onChange={(e) => {
                                setCart((v) => ({
                                  ...v,
                                  [p.id]: { ...p, quantity: Number(e.target.value) },
                                }));
                                setQuote(null);
                                setConfirmation(false);
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="row">
                  <button className="button" disabled={!after} onClick={() => setAfter(undefined)}>
                    Pierwsza strona oferty
                  </button>
                  <button
                    className="button"
                    disabled={!catalog?.next}
                    onClick={() => setAfter(catalog.next)}
                  >
                    Następne produkty
                  </button>
                </div>
              </section>
              <aside className="card b2b-cart">
                <h2>Koszyk</h2>
                {selected.length === 0 ? (
                  <p>Wybierz ilości produktów.</p>
                ) : (
                  selected.map((p: any) => (
                    <div key={p.id}>
                      <strong>{p.name}</strong>
                      <p>
                        {p.quantity} ×{' '}
                        {money(
                          quote?.pricing.items.find((i: any) => i.product_id === p.id)?.price ??
                            p.price,
                          a.currency,
                        )}{' '}
                        <button
                          className="button"
                          aria-label={'Usuń ' + p.sku}
                          onClick={() => {
                            setCart((v) => {
                              const n = { ...v };
                              delete n[p.id];
                              return n;
                            });
                            setQuote(null);
                          }}
                        >
                          Usuń
                        </button>
                      </p>
                    </div>
                  ))
                )}
                <p>Dostawa: {money(a.shipping_cost, a.currency)}</p>
                <button
                  className="button primary"
                  disabled={busy || !selected.length || me.read_only}
                  onClick={quoteCart}
                >
                  Przelicz koszyk B2B
                </button>
                {quote && (
                  <>
                    <h3>Wycena: {money(quote.total, quote.pricing.currency)}</h3>
                    <p>
                      Ważna do {date(quote.expires_at)}. Cena i dostępność będą sprawdzone przy
                      złożeniu zamówienia.
                    </p>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={confirmation}
                        onChange={(e) => setConfirmation(e.target.checked)}
                      />
                      Potwierdzam zamówienie i jego wartość
                    </label>
                    <button
                      className="button primary"
                      disabled={busy || !confirmation || me.read_only}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          const o = await call('/quotes/' + quote.id + '/checkout', 'POST', {
                            confirmed: true,
                          });
                          setMessage('Zamówienie ' + o.number + ' zostało zapisane.' + (o.trade_credit ? ' Na kredyt kupiecki: ' + money(o.trade_credit.amount_minor, o.trade_credit.currency) + ', termin ' + date(o.trade_credit.due_at) + '.' : ''));
                          setQuote(null);
                          setCart({});
                          setConfirmation(false);
                          await load();
                        } catch (e: any) {
                          setError(e.message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Złóż zamówienie B2B
                    </button>
                  </>
                )}
              </aside>
            </div>
            <section className="card">
              <h2>Twoje zamówienia</h2>
              <table>
                <thead>
                  <tr>
                    <th>Numer</th>
                    <th>Status</th>
                    <th>Wartość</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orders?.data.map((o: any) => (
                    <tr key={o.id}>
                      <td>
                        {o.number}
                        <small>{date(o.created_at)}</small>
                      </td>
                      <td>{statusNames[o.status] ?? o.status}</td>
                      <td>{money(o.total, o.currency)}</td>
                      <td>
                        <button
                          className="button"
                          onClick={async () => {
                            try {
                              setDetail(await call('/orders/' + o.id));
                            } catch (e: any) {
                              setError(e.message);
                            }
                          }}
                        >
                          Szczegóły {o.number}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row">
                <button
                  className="button"
                  disabled={!orderAfter}
                  onClick={() => setOrderAfter(undefined)}
                >
                  Pierwsza strona zamówień
                </button>
                <button
                  className="button"
                  disabled={!orders?.next}
                  onClick={() => setOrderAfter(orders.next)}
                >
                  Następne zamówienia B2B
                </button>
              </div>
            </section>
            {detail && (
              <B2bOrder
                key={detail.id}
                detail={detail}
                base={'/api/public/b2b/' + accountId}
                call={call}
                changed={setDetail}
                error={setError}
              />
            )}
          </>
        )}
      </main>
      <footer>DYNAMINDS Ecommerce · lokalny portal kontrahenta</footer>
    </div>
  );
}
function B2bOrder({
  detail: d,
  base,
  call,
  changed,
  error,
}: {
  detail: any;
  base: string;
  call: (p: string, m?: string, b?: any) => Promise<any>;
  changed: (d: any) => void;
  error: (s: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [key, setKey] = useState(crypto.randomUUID());
  async function request(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    error('');
    const f = new FormData(e.currentTarget);
    try {
      const items = d.items
        .map((i: any) => ({ item_id: i.id, quantity: Number(f.get(i.id)) }))
        .filter((i: any) => i.quantity > 0);
      await call('/orders/' + d.id + '/returns', 'POST', {
        client_key: key,
        kind: String(f.get('kind')),
        reason: String(f.get('reason')),
        items,
      });
      setKey(crypto.randomUUID());
      changed(await call('/orders/' + d.id));
    } catch (e: any) {
      error(e.message);
    } finally {
      setBusy(false);
    }
  }
  const eligible =
    [
      'shipped',
      'delivered',
      'completed',
      'return_initiated',
      'return_received',
      'return_completed',
    ].includes(d.status) && d.items.some((i: any) => i.available > 0);
  return (
    <section className="card" key={d.id}>
      <h2>Zamówienie {d.number}</h2>
      {d.historical && (
        <p>
          To zamówienie źródłowe jest dostępne jako historia po połączeniu. Realizację, dokumenty i
          zwrot uzgodnij ze sprzedawcą.
        </p>
      )}
      {d.payment_as_of_merge && (
        <p>
          Saldo z chwili połączenia. Późniejsze rozliczenia zamówienia wynikowego wymagają
          uzgodnienia ze sprzedawcą.
        </p>
      )}
      <p>
        {statusNames[d.status]} · do zapłaty {money(d.payment.amount_due, d.currency)}
      </p>
      <ul>
        {d.items.map((i: any) => (
          <li key={i.id}>
            {i.name} · {i.quantity} szt. · {money(i.line_total, d.currency)}
          </li>
        ))}
      </ul>
      <h3>Przesyłki i dokumenty</h3>
      {d.shipments.map((s: any) => (
        <p key={s.tracking_number}>
          {s.carrier} · {s.tracking_number} ·{' '}
          {(
            {
              created: 'Utworzona',
              dispatched: 'Przekazana przewoźnikowi',
              in_transit: 'W drodze',
              delivered: 'Dostarczona',
              cancelled: 'Anulowana',
            } as Record<string, string>
          )[s.status] ?? s.status}
        </p>
      ))}
      {d.documents.map((v: any) => (
        <p key={v.id}>
          {['demo', 'simulation'].includes(v.mode) ||
          (v.kind === 'proforma' && v.mode === 'local') ? (
            <a
              href={base + '/orders/' + d.id + '/documents/' + v.id + '/print'}
              target="_blank"
              rel="noreferrer"
            >
              {v.number} ·{' '}
              {v.kind === 'proforma' && v.mode === 'local' ? 'Pro forma' : 'dokument DEMO'}
            </a>
          ) : (
            v.number + ' · pobranie u sprzedawcy'
          )}
        </p>
      ))}
      {eligible && !d.read_only && (
        <form onSubmit={request}>
          <h3>Zgłoś zwrot lub reklamację</h3>
          <label>
            Rodzaj zgłoszenia
            <select name="kind">
              <option value="return">Zwrot</option>
              <option value="complaint">Reklamacja</option>
            </select>
          </label>
          <label>
            Powód zgłoszenia
            <textarea name="reason" required minLength={3} maxLength={2000} />
          </label>
          {d.items.map((i: any) => (
            <label key={i.id}>
              Ilość zgłoszenia {i.sku}
              <input name={i.id} type="number" min={0} max={i.available} defaultValue={0} />
            </label>
          ))}
          <button className="button" disabled={busy}>
            Zapisz zgłoszenie B2B
          </button>
        </form>
      )}
      <h3>Zgłoszenia</h3>
      <div className="row">
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            call('/orders/' + d.id)
              .then(changed)
              .catch((e) => error(e.message))
          }
        >
          Najnowsze zgłoszenia
        </button>
        <button
          className="button"
          disabled={busy || !d.case_meta?.has_more}
          onClick={() =>
            call('/orders/' + d.id + '?case_after=' + encodeURIComponent(d.case_meta.cursor))
              .then(changed)
              .catch((e) => error(e.message))
          }
        >
          Starsze zgłoszenia
        </button>
      </div>
      {d.cases.map((r: any) => (
        <p key={r.id}>
          {r.number} · {r.kind === 'return' ? 'Zwrot' : 'Reklamacja'} ·{' '}
          {(
            {
              requested: 'Zgłoszone',
              refund_pending: 'Uznane — oczekuje rozliczenia',
              closed: 'Zamknięte',
              rejected: 'Odrzucone',
              cancelled: 'Anulowane',
            } as Record<string, string>
          )[r.state] ?? r.state}{' '}
          · {r.reason}
          {r.acceptance_kind === 'partner' && r.accepted_at && (
            <span>
              {' '}
              · Uznano na podstawie przyjęcia przez partnera; nie jest to przyjęcie do lokalnego
              magazynu.
            </span>
          )}
          {r.refund_amount > 0 && (
            <span> · Kwota zwrotu: {money(r.refund_amount, d.currency)}</span>
          )}
        </p>
      ))}
    </section>
  );
}
