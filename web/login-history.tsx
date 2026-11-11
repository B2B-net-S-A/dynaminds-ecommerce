import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { api, ApiError, date } from './api';

export interface LoginEvent {
  id: string;
  created_at: string;
  outcome: string;
  status: number;
  ip: string | null;
  user_agent: string | null;
  tenant_name?: string | null;
  user_name?: string;
  user_email?: string;
}
export const loginOutcomeLabels: Record<string, string> = {
  success: 'Zalogowano',
  password_failed: 'Błędne hasło',
  mfa_failed: 'Błędny kod MFA',
  password_locked: 'Odrzucono: blokada po błędnych hasłach',
  mfa_locked: 'Odrzucono: blokada MFA',
  refused: 'Odmowa dostępu',
  password_reset: 'Hasło zmienione przez odzyskiwanie',
};
const failed = (outcome: string) => outcome !== 'success' && outcome !== 'password_reset';
/** Short browser/system name from the User-Agent; the full text stays in the title. */
export function agentName(ua: string | null): string {
  if (!ua) return '—';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  // Mobile first: iOS agents also say "like Mac OS X" and Android agents say "Linux".
  const system = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, system].filter(Boolean).join(', ') || ua.slice(0, 40);
}

interface Props {
  /** '/auth/security/logins' (own account) or '/workspaces/security/logins' (administrator). */
  url: string;
  refresh: number;
  members?: boolean;
}
interface Member {
  id: string;
  name: string;
  email: string;
}
interface Page {
  data: LoginEvent[];
  retention_days: number;
  members?: Member[];
  meta?: { cursor: string | null };
}
export function LoginHistory({ url, refresh, members = false }: Props) {
  const [data, setData] = useState<Page | null>(null),
    [error, setError] = useState(''),
    [unavailable, setUnavailable] = useState(false),
    [person, setPerson] = useState(''),
    [busy, setBusy] = useState(false);
  // Members (238): a person filter and older pages by the server's cursor; the first page has no query.
  const pageUrl = (after?: string) => {
    const p = new URLSearchParams();
    if (person) p.set('user_id', person);
    if (after) p.set('after', after);
    return url + (p.size ? '?' + p.toString() : '');
  };
  useEffect(() => {
    let active = true;
    api(pageUrl())
      .then((r) => {
        if (active) {
          setData(r);
          setError('');
        }
      })
      .catch((e) => {
        if (!active) return;
        // 404: the database does not have migration 237 (e.g. an older restored copy).
        if (e instanceof ApiError && e.status === 404) setUnavailable(true);
        else setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [url, refresh, person]);
  async function older() {
    const cursor = data?.meta?.cursor;
    if (!cursor) return;
    setBusy(true);
    try {
      const r: Page = await api(pageUrl(cursor));
      setData((prev) => ({ ...r, data: [...(prev?.data ?? []), ...r.data] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (unavailable) return null;
  const failures = data?.data.filter((e) => failed(e.outcome)).length ?? 0;
  return (
    <div className="login-history" aria-label={members ? 'Historia logowań członków' : 'Historia logowania'}>
      <h3>
        <History size={16} /> {members ? 'Historia logowań członków' : 'Historia logowania'}
      </h3>
      <p className="muted">
        {members
          ? 'Logowania osób z tej organizacji, także nieudane. Logowania do innych organizacji nie są tu widoczne.'
          : 'Wszystkie próby logowania na Twoje konto, także nieudane.'}{' '}
        {data && `Przechowujemy je ${data.retention_days} dni. ${failures ? `Nieudane próby na liście: ${failures}.` : ''}`}
      </p>
      {members && data?.members && (
        <label className="login-history-filter">
          Osoba
          <select aria-label="Osoba" value={person} disabled={busy} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Wszystkie osoby</option>
            {data.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.email})
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      {data && !data.data.length && <p className="muted">Brak zapisanych logowań.</p>}
      {data && data.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Czas</th>
                {members && <th>Osoba</th>}
                <th>Wynik</th>
                <th>Adres IP</th>
                <th>Urządzenie</th>
                {!members && <th>Organizacja</th>}
              </tr>
            </thead>
            <tbody>
              {data.data.map((e) => (
                <tr key={e.id}>
                  <td>{date(e.created_at)}</td>
                  {members && (
                    <td>
                      {e.user_name}
                      <small>{e.user_email}</small>
                    </td>
                  )}
                  <td>
                    <span className={'badge ' + (failed(e.outcome) ? 'status-error' : 'status-completed')}>
                      {loginOutcomeLabels[e.outcome] ?? e.outcome}
                    </span>
                  </td>
                  <td>
                    <code>{e.ip ?? '—'}</code>
                  </td>
                  <td title={e.user_agent ?? ''}>{agentName(e.user_agent)}</td>
                  {!members && <td>{e.tenant_name ?? '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.meta?.cursor && (
        <button className="button" type="button" disabled={busy} onClick={() => void older()}>
          Pokaż starsze
        </button>
      )}
    </div>
  );
}
