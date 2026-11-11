import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';

/** One entry of the native 223 return reason dictionary (GET /api/return-reasons). */
export type ReturnReason = { id: string; public_id: number; name: string; active: boolean; position: number; version: number };
export type ReturnReasonChoice = { reason_id: string; public_id: number; name: string; active: boolean };

/** Active reasons for a new case; `available` is false when the dictionary is not installed (503). */
export function useReturnReasons(enabled: boolean, contextKey: string) {
  const [state, setState] = useState<{ key: string; reasons: ReturnReason[]; available: boolean } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api<{ data: ReturnReason[] }>('/return-reasons')
      .then((r) => { if (alive) setState({ key: contextKey, reasons: r.data, available: true }); })
      .catch(() => { if (alive) setState({ key: contextKey, reasons: [], available: false }); });
    return () => { alive = false; };
  }, [enabled, contextKey]);
  return state?.key === contextKey ? state : { key: contextKey, reasons: [], available: false };
}

/** Admin dictionary: add, rename, deactivate/restore. Reasons are never deleted, so
 * earlier cases and Base return_reason_id keep their meaning. */
export function ReturnReasonsPanel({ contextKey, readOnly, blocked }: { contextKey: string; readOnly: boolean; blocked: boolean }) {
  const [reasons, setReasons] = useState<ReturnReason[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  async function load() {
    try {
      setReasons((await api<{ data: ReturnReason[] }>('/return-reasons?include_inactive=true')).data);
    } catch (e: any) {
      if (e.status === 503) setUnavailable(true);
      else setError(e.message);
    }
  }
  useEffect(() => { setReasons(null); setEditing(null); setError(''); void load(); }, [contextKey]);
  const locked = readOnly || blocked || busy;
  async function write(path: string, method: 'POST' | 'PATCH', body: unknown) {
    if (locked) return false;
    setBusy(true);
    setError('');
    try {
      await api(path, method, body);
      await load();
      return true;
    } catch (e: any) {
      setError(e.message);
      if (e.status === 409) await load();
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget, name = String(new FormData(form).get('name') ?? '').trim();
    if (await write('/return-reasons', 'POST', { name })) form.reset();
  }
  async function rename(r: ReturnReason) {
    if (!editing || editing.id !== r.id) return;
    if (await write('/return-reasons/' + r.id, 'PATCH', { version: r.version, name: editing.name.trim() })) setEditing(null);
  }
  if (unavailable) return <p className="notice">Słownik powodów zwrotu nie jest dostępny w tej bazie.</p>;
  return (
    <section className="return-reasons" aria-label="Powody zwrotu">
      <h3>Powody zwrotu</h3>
      <p>Powód z listy wybierasz przy nowej sprawie; opis zgłoszenia pozostaje tekstem sprawy. Bez wyboru sprawa ma „Inny powód”.
        Powodów się nie usuwa — nieaktywny znika z wyboru, a wcześniejsze sprawy go zachowują.</p>
      {error && <div className="error-block" role="alert">{error}</div>}
      {reasons === null ? <p>Wczytywanie…</p> : reasons.length === 0 ? <p>Brak powodów w słowniku.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Nr</th><th>Nazwa</th><th>Stan</th><th>Akcje</th></tr></thead>
            <tbody>
              {reasons.map((r) => (
                <tr key={r.id}>
                  <td>{r.public_id}</td>
                  <td>
                    {editing?.id === r.id ? (
                      <input aria-label={'Nowa nazwa: ' + r.name} value={editing.name} minLength={3} maxLength={120}
                        onChange={(e) => setEditing({ id: r.id, name: e.target.value })} />
                    ) : r.name}
                  </td>
                  <td>{r.active ? 'Aktywny' : 'Nieaktywny'}</td>
                  <td>
                    {editing?.id === r.id ? (
                      <>
                        <button type="button" className="button" disabled={locked || editing.name.trim().length < 3} onClick={() => void rename(r)}>Zapisz</button>
                        <button type="button" className="button" disabled={busy} onClick={() => setEditing(null)}>Anuluj</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="button" disabled={locked} onClick={() => setEditing({ id: r.id, name: r.name })}>Zmień nazwę</button>
                        <button type="button" className="button" disabled={locked}
                          onClick={() => void write('/return-reasons/' + r.id, 'PATCH', { version: r.version, active: !r.active })}>
                          {r.active ? 'Dezaktywuj' : 'Przywróć'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="form-grid" onSubmit={add}>
        <label>
          Nowy powód
          <input name="name" minLength={3} maxLength={120} required disabled={locked} />
        </label>
        <button className="button primary" disabled={locked}>Dodaj powód</button>
      </form>
    </section>
  );
}
