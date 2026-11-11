/** B2B-008 supplier directory (migration 246): the own opt-in profile, the search of other suppliers, the request
 * and its answer. „Połącz z dostawcą” takes the one-time invitation of an accepted request and uses the existing
 * POST /api/b2b/network/accept, so the link is the ordinary network link. Prices appear only after it exists. */
import { useEffect, useState, type FormEvent } from 'react';
import { api, date } from './api';

interface Profile { tenant_id: string; display_name: string; description: string; city: string; country: string; categories: string[]; listed?: boolean; version?: number }
interface Listed extends Profile { connected: boolean; request: { id: string; state: string } | null }
interface RequestRow { id: string; state: string; supplier_tenant_id: string; supplier_name: string; requester_name: string; message: string; created_at: string; decided_at: string | null; recipient_email?: string; connected?: boolean }
const states: Record<string, string> = { pending: 'Czeka na odpowiedź', accepted: 'Przyjęta', declined: 'Odrzucona', withdrawn: 'Wycofana' };

export function B2bSupplierDirectory({ admin, readOnly, contextKey }: { admin: boolean; readOnly: boolean; contextKey: string }) {
  const [own, setOwn] = useState<{ available: boolean; profile: Profile | null } | null>(null);
  const [list, setList] = useState<{ data: Listed[]; next: string | null } | null>(null);
  const [requests, setRequests] = useState<{ outgoing: RequestRow[]; incoming: RequestRow[] } | null>(null);
  const [accounts, setAccounts] = useState<{ id: string; name: string; version: number; active: boolean }[]>([]);
  const [search, setSearch] = useState(''), [after, setAfter] = useState<string | undefined>();
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Listed | null>(null), [choice, setChoice] = useState<Record<string, string>>({});
  const writable = admin && !readOnly;
  const loadAll = async () => {
    const [p, l, r] = await Promise.all([
      api('/b2b/directory/profile'),
      api('/b2b/directory?' + new URLSearchParams({ search, ...(after ? { after } : {}) })),
      api('/b2b/directory/requests'),
    ]);
    setOwn(p); setList(l); setRequests(r);
  };
  useEffect(() => { setError(''); loadAll().catch((e) => setError(e.message)); }, [contextKey, search, after]);
  useEffect(() => {
    if (admin) api('/b2b/accounts').then((d) => setAccounts(d.data.filter((a: any) => a.active))).catch(() => setAccounts([]));
  }, [contextKey, admin]);
  async function run(what: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { setNotice(await what()); await loadAll(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  function saveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(async () => {
      await api('/b2b/directory/profile', 'PUT', {
        display_name: String(f.get('name')), description: String(f.get('description') ?? ''), city: String(f.get('city') ?? ''),
        country: String(f.get('country') ?? 'PL'), categories: String(f.get('categories') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
        listed: f.get('listed') === 'on', version: own?.profile?.version ?? 0, confirmed: true,
      });
      return f.get('listed') === 'on' ? 'Profil jest widoczny w katalogu dostawców.' : 'Profil zapisany; nie jest widoczny w katalogu.';
    });
  }
  function sendRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!asking) return;
    const f = new FormData(e.currentTarget), to = asking;
    void run(async () => {
      await api('/b2b/directory/requests', 'POST', { supplier_tenant_id: to.tenant_id, client_key: crypto.randomUUID(), message: String(f.get('message') ?? ''), confirmed: true });
      setAsking(null);
      return 'Wysłano prośbę do ' + to.display_name + '.';
    });
  }
  const post = (id: string, action: string, body: object = { confirmed: true }) => api('/b2b/directory/requests/' + id + '/' + action, 'POST', body);
  if (own && !own.available) return <section className="card"><h2>Katalog dostawców</h2><p className="notice">Ta kopia bazy nie ma migracji katalogu dostawców.</p></section>;
  const p = own?.profile;
  return (
    <section className="panel network-card" aria-label="Katalog dostawców">
      <h2>Katalog dostawców</h2>
      <p className="muted">Dostawcy, którzy pokazują swój profil innym firmom. Ceny i oferta są widoczne dopiero po połączeniu.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      <details open={!p}>
        <summary>Mój profil dostawcy {p ? (p.listed ? '· widoczny' : '· ukryty') : '· brak'}</summary>
        {writable ? (
          <form onSubmit={saveProfile} key={p?.version ?? 0}>
            <div className="form-grid">
            <label>Nazwa w katalogu<input name="name" required minLength={2} maxLength={120} defaultValue={p?.display_name ?? ''} /></label>
            <label>Opis oferty<textarea name="description" maxLength={2000} defaultValue={p?.description ?? ''} /></label>
            <label>Miasto<input name="city" maxLength={100} defaultValue={p?.city ?? ''} /></label>
            <label>Kraj (kod)<input name="country" maxLength={2} defaultValue={p?.country ?? 'PL'} /></label>
            <label>Kategorie (po przecinku, do 10)<input name="categories" defaultValue={p?.categories.join(', ') ?? ''} /></label>
            </div>
            <label className="check"><input name="listed" type="checkbox" defaultChecked={p?.listed ?? false} /> Pokazuj profil innym firmom</label>
            <p className="muted">Inne firmy widzą tylko te pola. Ceny i katalog zobaczą dopiero po połączeniu.</p>
            <button className="button primary" disabled={busy}>Zapisz profil</button>
          </form>
        ) : <p>{p ? p.display_name : 'Firma nie ma profilu dostawcy.'} Profil ustawia administrator.</p>}
      </details>
      <h3>Znajdź dostawcę</h3>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setAfter(undefined); setSearch(String(new FormData(e.currentTarget).get('q') ?? '')); }}>
        <input name="q" placeholder="Nazwa, kategoria, miasto" defaultValue={search} aria-label="Szukaj dostawcy" />
        <button className="button">Szukaj</button>
      </form>
      {list && list.data.length === 0 && <p>Brak widocznych dostawców{search ? ' dla „' + search + '”' : ''}.</p>}
      {list && list.data.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Dostawca</th><th>Oferta</th><th>Kategorie</th><th>Akcja</th></tr></thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.tenant_id}>
                  <td><strong>{s.display_name}</strong><small>{[s.city, s.country].filter(Boolean).join(', ')}</small></td>
                  <td>{s.description || '—'}</td>
                  <td>{s.categories.join(' · ') || '—'}</td>
                  <td>
                    {s.connected ? 'Połączono'
                      : s.request?.state === 'pending' ? 'Prośba wysłana'
                      : writable && <button type="button" className="button" disabled={busy} onClick={() => setAsking(s)}>Poproś o współpracę</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <button className="button" disabled={!after} onClick={() => setAfter(undefined)}>Pierwsza strona</button>
        <button className="button" disabled={!list?.next} onClick={() => setAfter(list?.next ?? undefined)}>Następni dostawcy</button>
      </div>
      {asking && (
        <form className="card" onSubmit={sendRequest} aria-label="Prośba o współpracę">
          <h3>Prośba do {asking.display_name}</h3>
          <label>Wiadomość (opcjonalnie)<textarea name="message" maxLength={1000} /></label>
          <p className="muted">Dostawca zobaczy nazwę Twojej firmy i Twój adres e-mail, na który wyśle zaproszenie.</p>
          <div className="row">
            <button className="button primary" disabled={busy}>Wyślij prośbę</button>
            <button type="button" className="button" onClick={() => setAsking(null)}>Anuluj</button>
          </div>
        </form>
      )}
      {requests && (requests.incoming.length > 0 || requests.outgoing.length > 0) && (
        <>
          <h3>Prośby o współpracę</h3>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Kierunek</th><th>Firma</th><th>Wiadomość</th><th>Stan</th><th>Akcja</th></tr></thead>
              <tbody>
                {requests.incoming.map((r) => (
                  <tr key={'in' + r.id}>
                    <td>Do nas</td>
                    <td>{r.requester_name}<small>{r.recipient_email}</small></td>
                    <td>{r.message || '—'}</td>
                    <td>{states[r.state] ?? r.state}<small>{date(r.created_at)}</small></td>
                    <td>
                      {writable && r.state === 'pending' && (
                        <>
                          <select aria-label={'Konto kontrahenta dla ' + r.requester_name} value={choice[r.id] ?? ''} onChange={(e) => setChoice({ ...choice, [r.id]: e.target.value })}>
                            <option value="">Wybierz konto kontrahenta…</option>
                            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>
                          <button type="button" className="button primary" disabled={busy || !choice[r.id]} onClick={() => {
                            const a = accounts.find((x) => x.id === choice[r.id]);
                            if (a) void run(async () => { await post(r.id, 'accept', { account_id: a.id, version: a.version, confirmed: true }); return 'Przyjęto prośbę; zaproszenie czeka 24 h na ' + r.requester_name + '.'; });
                          }}>Przyjmij</button>
                          <button type="button" className="button" disabled={busy} onClick={() => void run(async () => { await post(r.id, 'decline'); return 'Odrzucono prośbę.'; })}>Odrzuć</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {requests.outgoing.map((r) => (
                  <tr key={'out' + r.id}>
                    <td>Od nas</td>
                    <td>{r.supplier_name}</td>
                    <td>{r.message || '—'}</td>
                    <td>{states[r.state] ?? r.state}<small>{date(r.created_at)}</small></td>
                    <td>
                      {writable && r.state === 'pending' && <button type="button" className="button" disabled={busy} onClick={() => void run(async () => { await post(r.id, 'withdraw'); return 'Wycofano prośbę.'; })}>Wycofaj</button>}
                      {r.state === 'accepted' && r.connected && 'Połączono'}
                      {writable && r.state === 'accepted' && !r.connected && <button type="button" className="button primary" disabled={busy} onClick={() => void run(async () => {
                        const { token } = await post(r.id, 'invitation');
                        await api('/b2b/network/accept', 'POST', { token, confirmed: true });
                        return 'Połączono z dostawcą ' + r.supplier_name + '. Jego oferta jest w sieci B2B.';
                      })}>Połącz z dostawcą</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
