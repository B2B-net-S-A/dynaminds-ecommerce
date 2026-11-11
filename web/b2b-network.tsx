import {CatalogAttributesRead} from './catalog-attributes';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { B2bCatalogScopePanel, b2bCatalogSiblingWriteGuard, resetB2bCatalogScopeContext, subscribeB2bCatalogScopeLock } from './b2b-catalog-scope';
import { api, ApiError, money, date } from './api';
import { ProductPicker } from './catalog';
import { performDropshipReturnWrite, useDropshipReturnWriteState } from './b2b-dropshipping-returns';
import { B2bNetworkOrders } from './b2b-network-orders';
import { B2bNetworkDropshipping } from './b2b-network-dropshipping';
import { B2bNetworkLinkLifecycle, B2bNetworkMappings } from './b2b-network-lifecycle';
const amount = (v: FormDataEntryValue | null) => {
  const s = String(v).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw Error('Podaj kwotę z maksymalnie dwoma miejscami dziesiętnymi');
  const [a, b = ''] = s.split('.');
  return Number(a) * 100 + Number(b.padEnd(2, '0'));
};
const states: Record<string, string> = {
  queued: 'W kolejce',
  done: 'Gotowe',
  failed: 'Błąd',
  cancelled: 'Przerwane',
};
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
type BindDraft = { item: { id: string; version: number; sku: string; name: string }; target: { id: string; name: string; version: string }; product: any | null; consent: boolean };
type BindReply = { binding: { id: string; item_id: string; link_id: string; product_id: string; item_version_before: number; item_version_after: number; quantity: 0; supplier_available: number; created_at: string }; reused: boolean };
function validateBindReply(reply: BindReply, linkId: string, itemId: string, body: { version: number; product_id: string }) {
  const b = reply?.binding;
  if (!b || !uuid(b.id) || b.link_id !== linkId || b.item_id !== itemId || b.product_id !== body.product_id || !Number.isSafeInteger(b.item_version_before) || !Number.isSafeInteger(b.item_version_after) || b.item_version_before !== body.version || b.item_version_after !== body.version + 1 || b.quantity !== 0 || !Number.isSafeInteger(b.supplier_available) || b.supplier_available < 0 || !Number.isFinite(Date.parse(b.created_at)) || typeof reply.reused !== 'boolean') throw Error('Niepełne potwierdzenie powiązania. Zachowano dokładną próbę.');
}
type InvitationHistory = {
  account: { id: string; version: number }; expiry_evaluated_at: string; next: string | null;
  data: { id: string; state: 'pending' | 'accepted' | 'revoked'; expired: boolean; account_version: number; created_at: string; expires_at: string }[];
};
const invitationStates = { pending: 'Oczekujące', accepted: 'Przyjęte', revoked: 'Cofnięte' };
function invitationHistory(value: any, accountId: string): InvitationHistory {
  const exact = (v: any, keys: string[]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join('|') === keys.sort().join('|');
  const stamp = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v) && Number.isFinite(Date.parse(v));
  if (!exact(value, ['account', 'expiry_evaluated_at', 'data', 'next']) || !exact(value.account, ['id', 'version']) || value.account.id !== accountId || !Number.isSafeInteger(value.account.version) || value.account.version < 1 || !stamp(value.expiry_evaluated_at) || !Array.isArray(value.data) || value.data.length > 25 || !(value.next === null || (typeof value.next === 'string' && value.next.length > 0 && value.next.length <= 2048))) throw Error('Niepełny odczyt historii zaproszeń.');
  const seen = new Set<string>();
  for (const row of value.data) {
    if (!exact(row, ['id', 'state', 'expired', 'account_version', 'created_at', 'expires_at']) || !uuid(row.id) || seen.has(row.id) || !Object.hasOwn(invitationStates, row.state) || typeof row.expired !== 'boolean' || (row.expired && row.state !== 'pending') || !Number.isSafeInteger(row.account_version) || row.account_version < 1 || !stamp(row.created_at) || !stamp(row.expires_at)) throw Error('Niepełny odczyt historii zaproszeń.');
    seen.add(row.id);
  }
  return value;
}
/** Existing local B2B invitations only; no provider/Base Connect API claim. */
export function B2bNetworkInvitationHistory({ contextKey, accounts }: { contextKey: string; accounts: { id: string; name: string; active: boolean }[] }) {
  const [accountId, setAccountId] = useState(''), [after, setAfter] = useState<string | undefined>(), [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; page: InvitationHistory } | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const sequence = useRef(0), current = useRef('');
  const key = `${contextKey}:${accountId}:${after ?? ''}:${refresh}`;
  current.current = key;
  const selected = accounts.find(a => a.id === accountId);
  useEffect(() => {
    const request = ++sequence.current;
    setResult(null); setError('');
    if (!selected) { setLoading(false); return; }
    setLoading(true); let alive = true;
    api('/b2b/accounts/' + encodeURIComponent(selected.id) + '/network-invitations?' + new URLSearchParams({ limit: '25', ...(after ? { after } : {}) }))
      .then(raw => { if (alive && current.current === key && sequence.current === request) setResult({ key, page: invitationHistory(raw, selected.id) }); })
      .catch(e => { if (alive && current.current === key && sequence.current === request) setError(e instanceof Error ? e.message : 'Nie udało się odczytać historii zaproszeń.'); })
      .finally(() => { if (alive && current.current === key && sequence.current === request) setLoading(false); });
    return () => { alive = false; };
  }, [key, selected?.id]);
  const page = result?.key === key ? result.page : null;
  const reset = () => { sequence.current++; setResult(null); setError(''); setAfter(undefined); setRefresh(v => v + 1); };
  return <section className="panel network-card" aria-label="Historia zaproszeń sieci B2B" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <h2>Historia zaproszeń do sieci B2B</h2>
    <p>Odczyt zapisanych zaproszeń. Kod jest jednorazowy i nie jest udostępniany w historii. Odczyt nie wysyła ani nie ponawia zaproszenia.</p>
    <label>Konto kontrahenta do historii<select aria-label="Konto kontrahenta do historii" value={selected ? accountId : ''} onChange={e => { sequence.current++; setResult(null); setError(''); setAccountId(e.target.value); setAfter(undefined); }}>
      <option value="">Wybierz konto</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.active ? '' : ' · nieaktywne'}</option>)}
    </select></label>
    {!accounts.length && <p>Brak kont kontrahentów na tej stronie.</p>}
    {selected && <>
      <div className="inline-actions" style={{ flexWrap: 'wrap' }}><button type="button" className="button" disabled={loading} onClick={reset}>Odśwież historię zaproszeń</button><button type="button" className="button" disabled={loading || !after} onClick={reset}>Najnowsze zaproszenia</button><button type="button" className="button" disabled={loading || !page?.next} onClick={() => { sequence.current++; setResult(null); setAfter(page!.next!); }}>Starsze zaproszenia</button></div>
      {loading && <p role="status">Odczytywanie historii zaproszeń…</p>}
      {error && <p role="alert">{error}</p>}
      {page && <><p>Wygaśnięcie oceniono na {date(page.expiry_evaluated_at)}. Status zaproszenia może się zmienić; odśwież historię.</p>{!page.data.length ? <p>Brak zaproszeń na tej stronie.</p> : <ul>{page.data.map(row => <li key={row.id}><strong>{row.expired ? 'Wygasłe' : invitationStates[row.state]}</strong> · utworzone {date(row.created_at)} · ważne do {date(row.expires_at)} · wersja konta {row.account_version}<br /><code>{row.id}</code></li>)}</ul>}</>}
    </>}
  </section>;
}
export function B2bNetwork({ admin, contextKey, readOnly, catalogContextKey, externalWriteBlocked = false }: { admin: boolean; contextKey: string; readOnly: boolean; catalogContextKey?: string; externalWriteBlocked?: boolean }) {
  const catalogKey = catalogContextKey ?? `${contextKey}:${readOnly}`;
  const [catalogLocked, setCatalogLocked] = useState(false), [scopeOpen, setScopeOpen] = useState(false), [ordersLocked, setOrdersLocked] = useState(false);
  const sharedWrites = useDropshipReturnWriteState(contextKey, readOnly);
  const [binding, setBinding] = useState<BindDraft | null>(null), [bindReceipt, setBindReceipt] = useState<BindReply | null>(null);
  const bindingRef = useRef(binding), catalogRef = useRef<any>(null);
  bindingRef.current = binding;
  const alive = useRef(false), latest = useRef({ catalogKey, readOnly, admin, externalWriteBlocked, selectedId: '', dropshippingLocked: false, ordersLocked: false, sharedLocked: false });
  const [dropshippingLocked, setDropshippingLocked] = useState(false);
  const [cart, setCart] = useState<any[]>([]);
  const [links, setLinks] = useState<any>(null),
    [accounts, setAccounts] = useState<any>(null),
    [accountsContext, setAccountsContext] = useState(''),
    [selected, setSelected] = useState<any>(null),
    [catalog, setCatalog] = useState<any>(null),
    [runs, setRuns] = useState<any>(null),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [after, setAfter] = useState<string | undefined>(),
    [linkAfter, setLinkAfter] = useState<string | undefined>(),
    [accountAfter, setAccountAfter] = useState<string | undefined>(),
    [runAfter, setRunAfter] = useState<string | undefined>(),
    [search, setSearch] = useState(''),
    [importing, setImporting] = useState<any>(null);
  const path = selected ? '/b2b/network/links/' + selected.id : '';
  catalogRef.current = catalog;
  latest.current = { catalogKey, readOnly, admin, externalWriteBlocked, selectedId: selected?.id ?? '', dropshippingLocked, ordersLocked, sharedLocked: sharedWrites.locked };
  const writeBlocked = readOnly || externalWriteBlocked || catalogLocked || dropshippingLocked || ordersLocked || sharedWrites.locked;
  const guardFreshWrite = b2bCatalogSiblingWriteGuard(catalogKey, retry => alive.current && latest.current.catalogKey === catalogKey && latest.current.admin && !latest.current.readOnly && (retry || (!latest.current.externalWriteBlocked && !latest.current.sharedLocked)));
  const guardSelectedWrite = async (retry = false, owner: 'parent' | 'orders' | 'dropshipping' = 'parent') => {
    const id = selected?.id;
    const fence = await guardFreshWrite(retry);
    const check = () => { fence(); if (!id || latest.current.selectedId !== id || (!retry && ((owner !== 'orders' && latest.current.ordersLocked) || (owner !== 'dropshipping' && latest.current.dropshippingLocked)))) throw Error('Wybrane połączenie B2B zmieniło się lub inny zapis wymaga potwierdzenia.'); };
    check(); return check;
  };
  async function write<T = any>(p: string, method: string, body: unknown, selectedScope = true): Promise<T> {
    const fence = await (selectedScope ? guardSelectedWrite() : guardFreshWrite()); fence();
    const d = await api<T>(p, method, body);
    if (!alive.current || latest.current.catalogKey !== catalogKey) throw Error('Firma lub użytkownik zmienił się. Odczytaj wynik we właściwej firmie.');
    return d;
  }
  useEffect(() => {
    alive.current = true; resetB2bCatalogScopeContext(catalogKey);
    setSelected(null); setScopeOpen(false); setLinks(null); setAccounts(null); setAccountsContext(''); setCatalog(null); setRuns(null); setImporting(null); setBinding(null); setBindReceipt(null); setCart([]); setToken(''); setBusy(false); setError(''); setMessage('');
    const un = subscribeB2bCatalogScopeLock(catalogKey, setCatalogLocked);
    return () => { alive.current = false; un(); };
  }, [catalogKey, readOnly]);
  useEffect(() => { setBinding(null); setBindReceipt(null); }, [catalogKey, selected?.id, catalog?.target_catalog?.id, catalog?.target_catalog?.version]);
  async function loadLinks() {
    const d = await api('/b2b/network/links' + (linkAfter ? '?after=' + linkAfter : ''));
    if (!alive.current || latest.current.catalogKey !== catalogKey) return;
    setLinks(d);
    setSelected((l: any) => (l ? (d.data.find((n: any) => n.id === l.id) ?? l) : null));
  }
  async function load() {
    if (!selected) return;
    const r = await api(path + '/runs' + (runAfter ? '?after=' + runAfter : ''));
    if (!alive.current || latest.current.catalogKey !== catalogKey || latest.current.selectedId !== selected.id) return;
    setRuns(r);
    if (!selected.paused)
      {
        const d = await api(
          path + '/catalog?' + new URLSearchParams({ search, ...(after ? { after } : {}) }),
        );
        if (alive.current && latest.current.catalogKey === catalogKey && latest.current.selectedId === selected.id) setCatalog(d);
      }
    else setCatalog(null);
  }
  useEffect(() => {
    loadLinks().catch((e) => setError(e.message));
  }, [linkAfter, catalogKey]);
  useEffect(() => {
    api('/b2b/accounts' + (accountAfter ? '?after=' + accountAfter : ''))
      .then(d => { if (alive.current && latest.current.catalogKey === catalogKey) { setAccounts(d); setAccountsContext(catalogKey); } })
      .catch((e) => setError(e.message));
  }, [accountAfter, catalogKey]);
  useEffect(() => {
    api('/warehouses')
      .then((d) => { if (alive.current && latest.current.catalogKey === catalogKey) setWarehouses(d.data); })
      .catch((e) => setError(e.message));
  }, [catalogKey]);
  useEffect(() => {
    setCatalog(null);
    load().catch((e) => setError(e.message));
  }, [selected?.id, selected?.version, after, search, runAfter]);
  useEffect(() => {
    if (!runs?.data.some((r: any) => r.state === 'queued')) return;
    const timer = setInterval(() => {
      load().catch((e) => setError(e.message));
      loadLinks().catch((e) => setError(e.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [
    selected?.id,
    selected?.version,
    runs?.data.some((r: any) => r.state === 'queued'),
    after,
    search,
    runAfter,
  ]);
  async function action(fn: () => Promise<void>, publish?: () => boolean) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e: any) {
      if (!publish || publish()) setError(e.message);
    } finally {
      if (!publish || publish()) setBusy(false);
    }
  }
  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action(async () => {
      const a = accounts.data.find((a: any) => a.id === f.get('account'));
      if (!a?.active) throw Error('Wybierz zatwierdzonego kontrahenta');
      const d = await write('/b2b/accounts/' + a.id + '/network-invite', 'POST', {
        version: a.version,
        recipient_email: String(f.get('email')),
        confirmed: true,
      }, false);
      setToken(d.token);
      setMessage('Zaproszenie przygotowane dla ' + d.recipient_email + '. Przekaż kod ręcznie.');
    });
  }
  async function accept(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      f = new FormData(form);
    await action(async () => {
      const d = await write('/b2b/network/accept', 'POST', {
        token: String(f.get('token')).trim(),
        confirmed: true,
      }, false);
      setSelected(d);
      await loadLinks();
      form.reset();
      setMessage('Połączono organizację z dostawcą. Odśwież katalog.');
    });
  }
  async function settings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action(async () => {
      const d = await write(path, 'PATCH', {
        version: selected.version,
        paused: f.get('paused') === 'on',
        schedule_minutes: Number(f.get('minutes')),
        confirmed: true,
      });
      setSelected(d);
      await loadLinks();
      setMessage('Ustawienia połączenia zapisane.');
    });
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action(async () => {
      await write(path + '/catalog/' + importing.id + '/product', 'POST', {
        version: importing.version,
        sku: String(f.get('sku')),
        sale_price: amount(f.get('price')),
        warehouse_id: String(f.get('warehouse')),
        confirmed: true,
      });
      setImporting(null);
      await load();
      setMessage('Produkt utworzony w Twoim katalogu ze stanem magazynu 0.');
    });
  }
  const bindPrefix = `${contextKey}:${readOnly}:network-bind:`;
  const bindAttempts = sharedWrites.entries.filter(e => e.scope.startsWith(bindPrefix));
  function openBind(i: any) {
    const target = catalogRef.current?.target_catalog;
    if (writeBlocked || busy || !i.published || i.product_id || !uuid(i.id) || !Number.isSafeInteger(i.version) || i.version <= 0 || !target || !uuid(target.id) || typeof target.name !== 'string' || typeof target.version !== 'string' || !/^[1-9][0-9]*$/.test(target.version)) return;
    setImporting(null); setBindReceipt(null); setError('');
    setBinding({ item: { id: i.id, version: i.version, sku: i.snapshot.sku, name: i.snapshot.name }, target: { ...target }, product: null, consent: false });
  }
  async function bindProduct(entry?: (typeof sharedWrites.entries)[number]) {
    const draft = bindingRef.current, linkId = selected?.id;
    if (busy || !linkId || readOnly || !admin || (!entry && (writeBlocked || !draft?.consent || !draft.product))) return;
    const itemId = entry ? entry.scope.slice(bindPrefix.length).split(':')[1] : draft!.item.id;
    const body = entry ? JSON.parse(entry.attempt.body) : { client_key: crypto.randomUUID(), version: draft!.item.version, product_id: draft!.product.id, confirmed: true };
    const bindPath = `/b2b/network/links/${linkId}/catalog/${itemId}/bind`, scope = `${bindPrefix}${linkId}:${itemId}`;
    if (!uuid(linkId) || !uuid(itemId) || !uuid(body.client_key) || !uuid(body.product_id) || !Number.isSafeInteger(body.version) || body.version <= 0 || body.confirmed !== true || (entry && (entry.scope !== scope || entry.attempt.path !== bindPath || entry.attempt.method !== 'POST'))) return;
    await action(async () => {
      try {
        const fence = await guardSelectedWrite(!!entry); fence();
        if (!entry) {
          const currentDraft = bindingRef.current, target = catalogRef.current?.target_catalog;
          if (!currentDraft || currentDraft !== draft || !currentDraft.consent || target?.id !== draft!.target.id || target?.version !== draft!.target.version || currentDraft.product?.catalog_id !== target.id || !currentDraft.product.active || !['simple', 'variant'].includes(currentDraft.product.kind)) throw Error('Wybrany produkt lub katalog zmienił się. Przygotuj powiązanie ponownie.');
        }
        fence();
        const r = await performDropshipReturnWrite<BindReply>(contextKey, readOnly, scope, entry?.attempt ?? {
          action: 'powiązanie oferty B2B z istniejącym produktem', path: bindPath, method: 'POST',
          body: JSON.stringify(body), retryable: true, retainRateLimited: true,
        }, reply => validateBindReply(reply, linkId, itemId, body));
        if (!alive.current || latest.current.catalogKey !== catalogKey || latest.current.selectedId !== linkId || latest.current.readOnly) return;
        setBindReceipt(r); setBinding(null); setMessage('Powiązanie produktu zapisane. Własna cena i stan magazynu pozostają bez zmian.');
        await load();
      } catch (e) {
        if (alive.current && latest.current.catalogKey === catalogKey) {
          setBinding(old => old ? { ...old, consent: false } : null);
          if (e instanceof ApiError && [401, 403, 423].includes(e.status)) { setBinding(null); setBindReceipt(null); setCatalog(null); setSelected(null); setCart([]); }
        }
        throw e;
      }
    }, () => alive.current && latest.current.catalogKey === catalogKey && latest.current.selectedId === linkId && latest.current.readOnly === readOnly);
  }
  return (
    <div className="b2b-network">
      <p className="notice">
        Połącz firmy za zgodą obu administratorów. Odczyt obejmuje wyłącznie ofertę zatwierdzonego
        kontrahenta. Dostępność u dostawcy jest oddzielona od Twojego magazynu.
      </p>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {bindAttempts.map(entry => {
        const linkId = entry.scope.slice(bindPrefix.length).split(':')[0];
        return <section className="notice" key={entry.scope} aria-label="Niepewne powiązanie B2B"><p>Wynik powiązania jest niepewny. Nowe zapisy B2B są wstrzymane. Odczyt oferty nie usuwa próby; wybierz to samo połączenie i ponów jej dokładną treść.</p><button type="button" className="button" disabled={busy || entry.inFlight || readOnly || !admin || selected?.id !== linkId} onClick={() => void bindProduct(entry)}>Ponów dokładne powiązanie B2B</button></section>;
      })}
      {admin && (
        <div className="network-connect-forms">
          <form className="panel network-card" onSubmit={invite}>
            <h2>Zaproś firmę kontrahenta</h2>
            <label>
              Konto kontrahenta
              <select name="account" required>
                <option value="">Wybierz aktywne konto</option>
                {accounts?.data
                  .filter((a: any) => a.active)
                  .map((a: any) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.email}
                    </option>
                  ))}
              </select>
            </label>
            <div className="inline-actions">
              <button
                type="button"
                className="button"
                disabled={!accountAfter}
                onClick={() => setAccountAfter(undefined)}
              >
                Pierwsze konta
              </button>
              <button
                type="button"
                className="button"
                disabled={!accounts?.next}
                onClick={() => setAccountAfter(accounts.next)}
              >
                Dalsze konta
              </button>
            </div>
            <label>
              Email administratora firmy odbiorcy
              <input name="email" type="email" required />
            </label>
            <label className="network-check">
              <input type="checkbox" required />
              Zatwierdzam udostępnienie oferty temu administratorowi
            </label>
            <button className="button primary" disabled={busy || writeBlocked}>
              Przygotuj kod połączenia B2B
            </button>
            {token && (
              <div>
                <p>Kod jednorazowy, ważny 24 h. Widoczny tylko tutaj.</p>
                <textarea aria-label="Kod zaproszenia B2B" readOnly value={token} />
              </div>
            )}
          </form>
          <form className="panel network-card" onSubmit={accept}>
            <h2>Połącz z dostawcą</h2>
            <p>
              Kod jest przypisany do emaila administratora. Połączenie dotyczy aktywnej organizacji.
            </p>
            <label>
              Kod od dostawcy
              <textarea name="token" required minLength={64} maxLength={64} />
            </label>
            <label className="network-check">
              <input type="checkbox" required />
              Zatwierdzam połączenie tej organizacji z ofertą dostawcy
            </label>
            <button className="button primary" disabled={busy || writeBlocked}>
              Zaakceptuj połączenie B2B
            </button>
          </form>
        </div>
      )}
      {admin && <B2bNetworkInvitationHistory key={`network-invitations:${catalogKey}`} contextKey={catalogKey} accounts={accountsContext === catalogKey ? accounts?.data ?? [] : []} />}
      <section className="panel network-card">
        <h2>Twoi dostawcy B2B</h2>
        <label>
          Wybierz połączenie
          <select
            value={selected?.id ?? ''}
            disabled={dropshippingLocked || ordersLocked || busy}
            onChange={(e) => {
              if (dropshippingLocked || ordersLocked || busy) return;
              setSelected(links.data.find((l: any) => l.id === e.target.value) ?? null);
              setAfter(undefined);
              setRunAfter(undefined);
              setImporting(null);
              setBinding(null); setBindReceipt(null);
              setCart([]);
              setScopeOpen(false);
              setError('');
            }}
          >
            <option value="">Wybierz dostawcę</option>
            {links?.data.map((l: any) => (
              <option key={l.id} value={l.id}>
                {l.supplier_name} · {l.paused ? 'Wstrzymane' : 'Aktywne'}
              </option>
            ))}
          </select>
        </label>
        <div className="inline-actions">
          <button className="button" disabled={!linkAfter} onClick={() => setLinkAfter(undefined)}>
            Pierwsi dostawcy
          </button>
          <button
            className="button"
            disabled={!links?.next}
            onClick={() => setLinkAfter(links.next)}
          >
            Dalsi dostawcy
          </button>
          <button className="button" onClick={() => action(loadLinks)}>
            Odśwież połączenia
          </button>
        </div>
      </section>
      {selected && (
        <>
          <button type="button" className="button" disabled={busy} onClick={() => setScopeOpen(v => !v)}>{scopeOpen ? 'Zamknij zakres katalogu odbiorcy' : 'Zakres katalogu odbiorcy B2B'}</button>
          {scopeOpen && <B2bCatalogScopePanel key={`buyer-scope:${catalogKey}:${selected.id}:${readOnly}`} contextKey={catalogKey} readOnly={readOnly} kind="buyer" entityId={selected.id} externalWriteBlocked={externalWriteBlocked || busy || dropshippingLocked || ordersLocked || sharedWrites.locked} onChanged={() => void loadLinks().catch(e => setError(e.message))} />}
          {admin && (
            <form
              className="panel network-card"
              key={selected.id + '-' + selected.version}
              onSubmit={settings}
            >
              <h2>Synchronizacja z {selected.supplier_name}</h2>
              <label className="network-check">
                <input type="checkbox" name="paused" defaultChecked={selected.paused} />
                Wstrzymaj połączenie i odczyt oferty
              </label>
              <label>
                Odświeżaj co (minuty, 0 wyłącza harmonogram)
                <input
                  name="minutes"
                  type="number"
                  min={0}
                  max={1440}
                  defaultValue={selected.schedule_minutes}
                />
              </label>
              <label className="network-check">
                <input type="checkbox" required />
                Potwierdzam ustawienia i przerwanie nieukończonego odczytu
              </label>
              <button className="button primary" disabled={busy || writeBlocked}>
                Zapisz synchronizację B2B
              </button>
            </form>
          )}
          <B2bNetworkLinkLifecycle key={'life:' + selected.id} link={selected} admin={admin} readOnly={writeBlocked} onChanged={(l) => { if (l) setSelected(l); void loadLinks().catch((e) => setError(e.message)); }} />
          <B2bNetworkMappings key={'map:' + selected.id} link={selected} admin={admin} readOnly={writeBlocked} />
          <section className="panel network-card">
            <div className="panel-heading">
              <h2>Oferta dostawcy</h2>
              <div className="inline-actions">
                <button className="button" disabled={busy} onClick={() => action(load)}>
                  Odśwież widok B2B
                </button>
                {admin && (
                  <button
                    className="button primary"
                    disabled={busy || writeBlocked || selected.paused}
                    onClick={() =>
                      action(async () => {
                        await write(path + '/refresh', 'POST', {
                          client_key: crypto.randomUUID(),
                          confirmed: true,
                        });
                        await load();
                        setMessage('Odczyt katalogu dodany do kolejki.');
                      })
                    }
                  >
                    Pobierz aktualny katalog B2B
                  </button>
                )}
              </div>
            </div>
            <p>
              {catalog?.last_at
                ? 'Ostatni pełny odczyt: ' + date(catalog.last_at)
                : 'Katalog oczekuje na pierwszy pełny odczyt.'}{' '}
              Ceny i dostępność aktualizują się po ukończeniu przebiegu.
            </p>
            {admin && catalog && !catalog.target_catalog && <p className="notice">Powiązanie istniejącego produktu wymaga odczytu własnego katalogu docelowego z serwera. Ten odczyt go nie udostępnia; nowego powiązania nie można przygotować.</p>}
            {selected.error && (
              <p role="alert" className="notice error">
                {selected.error}
              </p>
            )}
            <label>
              Szukaj w katalogu dostawcy
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setAfter(undefined);
                }}
              />
            </label>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Produkt</th>
                    <th>Cena dostawcy brutto</th>
                    <th>Dostępne u dostawcy</th>
                    <th>Twój katalog</th>
                  </tr>
                </thead>
                <tbody>
                  {catalog?.data.map((i: any) => (
                    <tr key={i.id}>
                      <td>
                        <strong>{i.snapshot.name}</strong>
                        <small>
                          {i.snapshot.sku} · {i.snapshot.kind}
                        </small>
                        <details>
                          <summary>Opis i zdjęcia</summary>
                          <p>{i.snapshot.description}</p>
                          <CatalogAttributesRead attributes={i.snapshot.attributes}/>
                          {i.snapshot.images.map((url: string) => (
                            <img
                              className="network-image"
                              key={url}
                              src={url}
                              alt={i.snapshot.name}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                            />
                          ))}
                        </details>
                      </td>
                      <td>{money(i.snapshot.price, i.snapshot.currency)}</td>
                      <td>{i.published ? i.snapshot.available : 'Oferta wycofana'}</td>
                      <td>
                        {admin && i.product_id && i.published && (
                          <button
                            className="button"
                            disabled={busy || writeBlocked || cart.length >= 100 || cart.some((x) => x.id === i.id)}
                            onClick={() => setCart([...cart, { ...i, quantity: 1 }])}
                          >
                            Do koszyka {i.snapshot.sku}
                          </button>
                        )}
                        {i.product_id ? (
                          'Produkt powiązany'
                        ) : admin ? (
                          <><button
                            className="button"
                            disabled={busy || writeBlocked || !i.published}
                            onClick={() => setImporting(i)}
                          >
                            Dodaj produkt {i.snapshot.sku}
                          </button><button type="button" className="button" disabled={busy || writeBlocked || !i.published || !catalog?.target_catalog} onClick={() => openBind(i)}>Powiąż istniejący produkt {i.snapshot.sku}</button></>
                        ) : (
                          'Brak powiązania'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="inline-actions">
              <button className="button" disabled={!after} onClick={() => setAfter(undefined)}>
                Pierwsza strona katalogu B2B
              </button>
              <button
                className="button"
                disabled={!catalog?.next}
                onClick={() => setAfter(catalog.next)}
              >
                Dalsze produkty B2B
              </button>
            </div>
          </section>
          {binding && <section className="panel network-card" aria-label="Powiązanie istniejącego produktu B2B"><h2>Powiąż ofertę z istniejącym produktem</h2><p>Oferta: {binding.item.sku} · {binding.item.name}. Katalog docelowy: {binding.target.name} · wersja {binding.target.version}.</p><p>Wybierz własny aktywny produkt lub wariant. Powiązanie nie kopiuje ceny ani opisu i nie przyjmuje dostępności dostawcy na Twój magazyn.</p><ProductPicker key={`${catalogKey}:${selected.id}:${binding.item.id}:${binding.target.id}:${binding.target.version}`} label="Istniejący produkt do oferty B2B" value={binding.product?.id ?? ''} initial={binding.product} catalogId={binding.target.id} contextKey={`${catalogKey}:${selected.id}:${binding.item.id}`} disabled={busy || writeBlocked} filter={p => p.active && ['simple', 'variant'].includes(p.kind)} select={p => { if (!busy && !writeBlocked && p?.catalog_id === binding.target.id && p.active && ['simple', 'variant'].includes(p.kind)) setBinding(old => old && old.item.id === binding.item.id && old.target.id === binding.target.id ? { ...old, product: p, consent: false } : old); }} />{binding.product && <p>Twój produkt: {binding.product.sku} · {binding.product.name}. Oferta dostawcy pozostaje oddzielna.</p>}<label className="network-check"><input aria-label="Potwierdzam powiązanie istniejącego produktu B2B" type="checkbox" checked={binding.consent} disabled={busy || writeBlocked || !binding.product} onChange={e => setBinding(old => old ? { ...old, consent: e.target.checked } : null)} />Sprawdziłem ofertę i wybrany własny produkt; zatwierdzam powiązanie.</label><div className="inline-actions"><button type="button" className="button primary" disabled={busy || writeBlocked || !binding.product || !binding.consent} onClick={() => void bindProduct()}>Zapisz powiązanie istniejącego produktu B2B</button><button type="button" className="button" onClick={() => setBinding(null)}>Zamknij powiązanie B2B</button></div></section>}
          {bindReceipt && <p role="status" className="notice">Zapis powiązania: {bindReceipt.binding.id} · wersja oferty {bindReceipt.binding.item_version_after}{bindReceipt.reused ? ' · odczyt dokładnego ponowienia' : ''}.</p>}
          {importing && (
            <form className="panel network-card" key={importing.id} onSubmit={create}>
              <h2>Dodaj {importing.snapshot.name} do swojego katalogu</h2>
              <p>
                Opis, parametry i zdjęcia zostaną skopiowane. Dostępność dostawcy nie zwiększy
                Twojego stanu. Cena dostawcy pozostaje w jego walucie; podaj własną cenę sprzedaży.
              </p>
              <label>
                SKU w Twoim katalogu
                <input name="sku" defaultValue={importing.snapshot.sku} required maxLength={80} />
              </label>
              <label>
                Cena sprzedaży brutto ({links?.currency})<input name="price" required />
              </label>
              <label>
                Magazyn dla lokalnego produktu
                <select name="warehouse" required>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="network-check">
                <input type="checkbox" required />
                Potwierdzam utworzenie produktu ze stanem 0
              </label>
              <div className="inline-actions">
                <button className="button primary" disabled={busy || writeBlocked}>
                  Utwórz produkt z katalogu B2B
                </button>
                <button className="button" type="button" onClick={() => setImporting(null)}>
                  Zamknij import B2B
                </button>
              </div>
            </form>
          )}
          <B2bNetworkOrders
            key={`network-orders:${catalogKey}:${selected.id}:${readOnly}`}
            link={selected}
            warehouses={warehouses}
            cart={cart}
            setCart={setCart}
            admin={admin}
            readOnly={readOnly}
            externalWriteBlocked={externalWriteBlocked || catalogLocked || dropshippingLocked || sharedWrites.locked}
            guardFreshWrite={retry => guardSelectedWrite(retry, 'orders')}
            onLockedChange={setOrdersLocked}
          />
          <B2bNetworkDropshipping
            key={contextKey + ':' + selected.id + ':' + readOnly}
            linkId={selected.id}
            supplierName={selected.supplier_name}
            contextKey={contextKey}
            readOnly={readOnly}
            externalWriteBlocked={externalWriteBlocked || catalogLocked || ordersLocked || sharedWrites.locked}
            guardFreshWrite={retry => guardSelectedWrite(retry, 'dropshipping')}
            onLockedChange={setDropshippingLocked}
          />
          <section className="panel network-card">
            <h2>Historia odczytu</h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Wynik</th>
                    <th>SKU</th>
                    <th>Informacja</th>
                  </tr>
                </thead>
                <tbody>
                  {runs?.data.map((r: any) => (
                    <tr key={r.id}>
                      <td>{date(r.created_at)}</td>
                      <td>{states[r.state] ?? r.state}</td>
                      <td>{r.fetched}</td>
                      <td>{r.error ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="inline-actions">
              <button
                className="button"
                disabled={!runAfter}
                onClick={() => setRunAfter(undefined)}
              >
                Najnowsze odczyty B2B
              </button>
              <button
                className="button"
                disabled={!runs?.next}
                onClick={() => setRunAfter(runs.next)}
              >
                Starsze odczyty B2B
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
