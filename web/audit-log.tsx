import { useEffect, useState, type FormEvent } from 'react';
import { Download } from 'lucide-react';
import { api, ApiError, currentWorkspace, date } from './api';
import { auditActionLabel, auditChanges } from '../server/audit-labels';
import './audit-log.css';

interface AuditAuthor {
  kind: 'user' | 'api_key' | 'system';
  user_id: string | null;
  name: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  api_key_prefix: string | null;
}
interface AuditEvent {
  id: string;
  created_at: string;
  action: string;
  entity_id: string | null;
  detail: unknown;
  author: AuditAuthor;
}
interface Authors {
  members: { id: string; name: string; email: string }[];
  api_keys: { id: string; name: string; prefix: string; revoked_at: string | null }[];
}
type Filters = Partial<Record<'user_id' | 'api_key_id' | 'source' | 'action' | 'entity_id' | 'from' | 'to', string>>;
const FIELDS = ['user_id', 'api_key_id', 'source', 'action', 'entity_id', 'from', 'to'] as const;

function query(filters: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  for (const k of FIELDS) if (filters[k]) p.set(k, filters[k]!);
  const s = p.toString();
  return s ? '?' + s : '';
}
function Author({ a }: { a: AuditAuthor }) {
  if (a.kind === 'system') return <span className="muted">System</span>;
  if (a.kind === 'api_key')
    return (
      <>
        Klucz API: {a.api_key_name ?? 'usunięty klucz'}
        {a.api_key_prefix ? ` (${a.api_key_prefix}…)` : ''}
        <small>właściciel: {a.name ?? '—'}</small>
      </>
    );
  return <>{a.name ?? 'Usunięte konto'}</>;
}

/** The organisation's audit log for an administrator (SEC-009): who did what and when, with filters,
 * "older" pages by the server's cursor and a CSV export of the same filters. */
export function AuditLog({ refresh }: { refresh: number }) {
  const [authors, setAuthors] = useState<Authors>({ members: [], api_keys: [] }),
    [filters, setFilters] = useState<Filters>({}),
    [rows, setRows] = useState<AuditEvent[] | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Authors>('/audit/authors').then(setAuthors, (e) => setError(e.message));
  }, [refresh]);
  useEffect(() => {
    let active = true;
    setRows(null);
    api<{ data: AuditEvent[]; meta: { cursor: string | null } }>('/audit' + query(filters, { limit: '50' }))
      .then((r) => {
        if (!active) return;
        setRows(r.data);
        setCursor(r.meta.cursor);
        setError('');
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [filters, refresh]);
  async function older() {
    if (!cursor) return;
    setBusy(true);
    try {
      const r = await api<{ data: AuditEvent[]; meta: { cursor: string | null } }>('/audit' + query(filters, { limit: '50', after: cursor }));
      setRows((prev) => [...(prev ?? []), ...r.data]);
      setCursor(r.meta.cursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget, next: Filters = {};
    for (const k of FIELDS) {
      const v = (form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | null)?.value.trim();
      if (v) next[k] = v;
    }
    setFilters(next);
  }
  async function exportCsv() {
    setBusy(true);
    try {
      const workspace = currentWorkspace();
      const res = await fetch('/api/audit/export' + query(filters), {
        credentials: 'same-origin',
        headers: workspace ? { 'X-Workspace-ID': workspace } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(body.detail ?? 'Nie udało się wyeksportować dziennika', res.status);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'dziennik-audytu.csv';
      const url = URL.createObjectURL(await res.blob()), link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel audit-log">
      <form className="audit-filters" aria-label="Filtry dziennika" onSubmit={apply}>
        <label>
          Osoba
          <select name="user_id" defaultValue="">
            <option value="">Wszystkie osoby</option>
            {authors.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.email})
              </option>
            ))}
          </select>
        </label>
        <label>
          Klucz API
          <select name="api_key_id" defaultValue="">
            <option value="">Wszystkie klucze</option>
            {authors.api_keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} ({k.prefix}…){k.revoked_at ? ' — unieważniony' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Źródło
          <select name="source" defaultValue="">
            <option value="">Wszystkie</option>
            <option value="user">Osoba w panelu</option>
            <option value="api_key">Klucz API</option>
            <option value="system">System</option>
          </select>
        </label>
        <label>
          Operacja
          <input name="action" placeholder="np. order albo order.status" pattern="[a-z0-9_][a-z0-9_.\-]*" maxLength={100} />
        </label>
        <label>
          Obiekt (ID)
          <input name="entity_id" placeholder="identyfikator UUID" maxLength={36} />
        </label>
        <label>
          Od dnia
          <input name="from" type="date" />
        </label>
        <label>
          Do dnia
          <input name="to" type="date" />
        </label>
        <div className="audit-filter-actions">
          <button className="button primary" type="submit">
            Filtruj
          </button>
          <button className="button" type="reset" onClick={() => setFilters({})}>
            Wyczyść
          </button>
          <button className="button" type="button" disabled={busy} onClick={() => void exportCsv()}>
            <Download size={14} /> Eksport CSV
          </button>
        </div>
      </form>
      {error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      {!rows && !error && <p className="muted audit-status">Wczytywanie dziennika…</p>}
      {rows && !rows.length && <p className="muted audit-status">Brak operacji dla wybranych filtrów.</p>}
      {rows && rows.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Czas</th>
                <th>Autor</th>
                <th>Operacja</th>
                <th>Obiekt</th>
                <th>Zmiany</th>
                <th>Szczegóły</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const changes = auditChanges(a.detail);
                return (
                  <tr key={a.id}>
                    <td>{date(a.created_at)}</td>
                    <td className="audit-author">
                      <Author a={a.author} />
                    </td>
                    <td>
                      {auditActionLabel(a.action)}
                      <small>
                        <code>{a.action}</code>
                      </small>
                    </td>
                    <td>{a.entity_id ? <code title={a.entity_id}>{a.entity_id.slice(0, 8)}</code> : '—'}</td>
                    <td>{changes.length ? changes.map((c) => <div key={c}>{c}</div>) : '—'}</td>
                    <td>
                      <details className="audit-detail">
                        <summary>Pokaż</summary>
                        <pre>{JSON.stringify(a.detail, null, 2)}</pre>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-footer">
        {cursor ? (
          <button className="button" type="button" disabled={busy} onClick={() => void older()}>
            Pokaż starsze
          </button>
        ) : (
          rows && rows.length > 0 && 'To wszystkie operacje dla wybranych filtrów.'
        )}
      </div>
    </section>
  );
}
