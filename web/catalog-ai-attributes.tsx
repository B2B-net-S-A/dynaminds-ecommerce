/** DOM-AI-002: typed PIM parameter values proposed by the local model for one product. The table shows each
 * parameter's current and proposed value; the administrator ticks the values to accept and confirms; the server
 * writes them through the PIM preview/apply path (CAS on the frozen source). Values the model got wrong are listed
 * with the reason and are never written. */
import { useEffect, useState } from 'react';
import { api } from './api';

interface Option {
  id: string;
  label: string;
}
interface Definition {
  id: string;
  name: string;
  required: boolean;
  shape: { kind: string; unit?: string | null; options?: Option[] };
}
interface Entry {
  definition_id: string;
  kind: string;
  value?: string | boolean;
  option_id?: string;
}
interface Proposal {
  id: string;
  state: string;
  model: string;
  locale: string;
  definitions: Definition[];
  pim_source: { values: Entry[] };
  output: Entry[] | null;
  refused: { definition_id: string; name: string | null; reason: string }[] | null;
  accepted?: Entry[] | null;
  error?: string | null;
  created_at: string;
  expires_at: string;
}
interface Props {
  product: { id: string; version: number };
  saved: () => void;
}
const states: Record<string, string> = {
  queued: 'W kolejce',
  running: 'Generowanie',
  ready: 'Do przeglądu',
  applying: 'Zatwierdzanie w PIM',
  applied: 'Zastosowano',
  failed: 'Błąd generowania',
  conflict: 'Produkt zmieniono',
  cancelled: 'Anulowano',
};
function shown(e: Entry | undefined, d: Definition | undefined) {
  if (!e) return '—';
  if (e.kind === 'enum') return d?.shape.options?.find((o) => o.id === e.option_id)?.label ?? e.option_id ?? '—';
  if (e.kind === 'boolean') return e.value ? 'Tak' : 'Nie';
  return String(e.value) + (e.kind === 'decimal' && d?.shape.unit ? ' ' + d.shape.unit : '');
}

export function CatalogAiAttributes({ product, saved }: Props) {
  const [data, setData] = useState<{ available: boolean; pim_available?: boolean; data: Proposal[] }>(),
    [models, setModels] = useState<{ name: string; digest: string }[]>([]),
    [model, setModel] = useState(''),
    [locale, setLocale] = useState('pl'),
    [selected, setSelected] = useState<string>(),
    [ticked, setTicked] = useState<string[]>([]),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async (signal?: AbortSignal) => {
    const r = await api('/products/' + product.id + '/ai/attributes', 'GET', undefined, {}, signal);
    if (!signal?.aborted) setData(r);
  };
  useEffect(() => {
    const owned = new AbortController();
    load(owned.signal).catch((e) => !owned.signal.aborted && setError(e.message));
    api('/ai/catalog/runtime', 'GET', undefined, {}, owned.signal)
      .then((r) => {
        setModels(r.models);
        setModel((m) => m || r.models[0]?.name || '');
      })
      .catch(() => {});
    return () => owned.abort();
  }, [product.id]);
  const proposal = data?.data.find((p) => p.id === selected) ?? data?.data[0];
  const pending = proposal && ['queued', 'running'].includes(proposal.state);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [pending, product.id]);
  useEffect(() => {
    setTicked([]);
    setApproved(false);
  }, [proposal?.id, proposal?.state]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data?.available) return null;
  const defs = new Map((proposal?.definitions ?? []).map((d) => [d.id, d]));
  const current = new Map((proposal?.pim_source.values ?? []).map((v) => [v.definition_id, v]));
  return (
    <section className="catalog-ai-panel catalog-section">
      <header className="panel-heading">
        <div>
          <h3>Parametry PIM z AI</h3>
          <p>Lokalny model · wartości zgodne z typem parametru · zapis po akceptacji</p>
        </div>
      </header>
      {data.pim_available === false && <p className="notice">Słowniki parametrów PIM nie są dostępne w tej bazie.</p>}
      {error && (
        <p role="alert" className="error-inline">
          {error}
        </p>
      )}
      <div className="catalog-ai-fields">
        <label>
          Model lokalny
          <select aria-label="Model parametrów AI" value={model} onChange={(e) => setModel(e.target.value)}>
            {!model && <option value="">Brak modelu</option>}
            {models.map((m) => (
              <option key={m.digest} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Język wartości tekstowych
          <select aria-label="Język parametrów AI" value={locale} onChange={(e) => setLocale(e.target.value)}>
            <option value="pl">Polski</option>
            <option value="en">Angielski</option>
            <option value="de">Niemiecki</option>
            <option value="fr">Francuski</option>
            <option value="es">Hiszpański</option>
            <option value="cs">Czeski</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        className="button"
        disabled={busy || !model || data.pim_available === false}
        onClick={() =>
          action(async () => {
            const p = await api('/products/' + product.id + '/ai/attributes', 'POST', {
              version: product.version,
              client_key: crypto.randomUUID(),
              model,
              locale,
            });
            setSelected(p.id);
          })
        }
      >
        Zaproponuj parametry
      </button>
      {proposal && (
        <div className="catalog-ai-review">
          <strong>
            {states[proposal.state] ?? proposal.state} · {proposal.model}
          </strong>
          {proposal.error && <p className="error-inline">{proposal.error}</p>}
          {proposal.output && (
            <table>
              <thead>
                <tr>
                  <th>Przyjmij</th>
                  <th>Parametr</th>
                  <th>Obecnie</th>
                  <th>Propozycja AI</th>
                </tr>
              </thead>
              <tbody>
                {proposal.output.map((e) => {
                  const d = defs.get(e.definition_id);
                  const accepted = proposal.accepted?.some((x) => x.definition_id === e.definition_id);
                  return (
                    <tr key={e.definition_id}>
                      <td>
                        {proposal.state === 'ready' ? (
                          <input
                            type="checkbox"
                            aria-label={'Przyjmij ' + (d?.name ?? e.definition_id)}
                            checked={ticked.includes(e.definition_id)}
                            onChange={(x) => {
                              setApproved(false);
                              setTicked((t) => (x.target.checked ? [...t, e.definition_id] : t.filter((y) => y !== e.definition_id)));
                            }}
                          />
                        ) : accepted ? (
                          'Zapisano'
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {d?.name}
                        {d?.required ? ' *' : ''}
                      </td>
                      <td>{shown(current.get(e.definition_id), d)}</td>
                      <td>{shown(e, d)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {(proposal.refused?.length ?? 0) > 0 && (
            <details open>
              <summary>Odrzucone wartości AI ({proposal.refused!.length})</summary>
              <ul>
                {proposal.refused!.map((r, n) => (
                  <li key={n}>
                    {r.name ? r.name + ': ' + r.reason : r.reason + ' (spoza listy parametrów kategorii)'}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {proposal.state === 'ready' && (
            <>
              <label className="checkbox-row">
                <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
                Sprawdziłem wartości; zapisz zaznaczone parametry
              </label>
              <button
                type="button"
                className="button primary"
                disabled={busy || !approved || ticked.length < 1}
                onClick={() =>
                  action(async () => {
                    await api('/ai/catalog/attributes/' + proposal.id + '/apply', 'POST', { approve: true, definition_ids: ticked });
                    saved();
                  })
                }
              >
                Zatwierdź parametry
              </button>
            </>
          )}
          {['queued', 'ready'].includes(proposal.state) && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => action(() => api('/ai/catalog/attributes/' + proposal.id + '/cancel', 'POST', {}))}
            >
              Anuluj propozycję
            </button>
          )}
        </div>
      )}
      {(data.data.length ?? 0) > 1 && (
        <details className="catalog-ai-history">
          <summary>Historia propozycji parametrów</summary>
          {data.data.map((p) => (
            <div key={p.id}>
              <button type="button" className="text-button" onClick={() => setSelected(p.id)}>
                {states[p.state] ?? p.state} · {new Date(p.created_at).toLocaleString('pl-PL')}
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
