/** DOM-AI-003: batch AI drafts for the products selected in the catalog list. One batch = one model, process,
 * language and style; each item shows its own result (waiting, draft state, conflict, error, applied). Approval in
 * bulk uses the generated text of the ticked ready items after an explicit check; edited text is applied one by one
 * on the product card (Treści produktu z AI). */
import { useEffect, useState } from 'react';
import { api } from './api';

interface Selection {
  id: string;
  version: number;
  sku: string;
}
interface Props {
  selection: Selection[];
  saved: (id: string) => void;
}
interface Draft {
  id: string;
  state: string;
  output: { name: string; description: string } | null;
  reviewed_text?: { name: string; description: string } | null;
  error?: string | null;
}
interface Item {
  product_id: string;
  position: number;
  state: string;
  product_name: string | null;
  error?: string | null;
  outcome?: string | null;
  draft: Draft | null;
}
interface Batch {
  id: string;
  state: string;
  destination: string;
  locale: string;
  model: string;
  item_count: number;
  created_at: string;
  items?: Item[];
  counts?: Record<string, number>;
}
const languages: Record<string, string> = { pl: 'Polski', en: 'Angielski', de: 'Niemiecki', fr: 'Francuski', es: 'Hiszpański', cs: 'Czeski' };
const itemStates: Record<string, string> = {
  waiting: 'Czeka na miejsce w kolejce',
  queued: 'W kolejce',
  ready: 'Do przeglądu',
  applied: 'Zastosowano',
  failed: 'Błąd',
  conflict: 'Produkt zmieniono',
  cancelled: 'Anulowano',
};
const itemLabel = (i: Item) => (i.outcome === 'applied' ? 'Zastosowano' : itemStates[i.draft?.state ?? i.state] ?? i.state);
const itemError = (i: Item) => i.error ?? i.draft?.error ?? null;

export function CatalogAiBatches({ selection, saved }: Props) {
  const [models, setModels] = useState<{ name: string; digest: string }[]>([]),
    [allowed, setAllowed] = useState(false),
    [model, setModel] = useState(''),
    [destination, setDestination] = useState('catalog'),
    [locale, setLocale] = useState('pl'),
    [tone, setTone] = useState('factual'),
    [length, setLength] = useState('medium'),
    [list, setList] = useState<Batch[]>([]),
    [batch, setBatch] = useState<Batch>(),
    [ticked, setTicked] = useState<string[]>([]),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [available, setAvailable] = useState(true);
  useEffect(() => {
    const owned = new AbortController();
    api('/ai/catalog/runtime', 'GET', undefined, {}, owned.signal)
      .then((r) => {
        setModels(r.models);
        setAllowed(r.generation_allowed === true);
        setModel((m) => m || r.models[0]?.name || '');
      })
      .catch((e) => !owned.signal.aborted && setError(e.message));
    api('/ai/catalog/batches', 'GET', undefined, {}, owned.signal)
      .then((r) => {
        setAvailable(r.available !== false);
        setList(r.data);
      })
      .catch((e) => !owned.signal.aborted && setError(e.message));
    return () => owned.abort();
  }, []);
  const open = async (id: string) => setBatch(await api('/ai/catalog/batches/' + id));
  const pending = batch?.state === 'open' && batch.items?.some((i) => i.state === 'waiting' || i.draft?.state === 'queued');
  useEffect(() => {
    if (!pending || !batch) return;
    const timer = setInterval(() => void open(batch.id).catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [pending, batch?.id]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!available) return <p className="notice">Ta kopia nie zawiera partii AI katalogu.</p>;
  const ready = (batch?.items ?? []).filter((i) => i.draft?.state === 'ready');
  return (
    <section className="catalog-ai-panel catalog-section">
      <p>
        Partia tworzy szkic AI dla każdego zaznaczonego produktu (1–50). Szkice powstają kolejno w lokalnym modelu; każdy
        produkt ma własny wynik. Nic nie zmienia katalogu bez zatwierdzenia.
      </p>
      {error && (
        <p role="alert" className="error-inline">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action(async () => {
            const b = await api('/ai/catalog/batches', 'POST', {
              client_key: crypto.randomUUID(),
              model,
              destination,
              locale,
              ...(destination === 'catalog' ? { style: { tone, length } } : {}),
              products: selection.map((p) => ({ id: p.id, version: p.version })),
            });
            // The create answer is the batch row; the items come with the batch view.
            await open(b.id);
            setTicked([]);
            setApproved(false);
          });
        }}
      >
        <div className="catalog-ai-fields">
          <label>
            Model lokalny
            <select aria-label="Model partii AI" value={model} onChange={(e) => setModel(e.target.value)}>
              {!model && <option value="">Brak modelu</option>}
              {models.map((m) => (
                <option key={m.digest} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Proces
            <select aria-label="Proces partii AI" value={destination} onChange={(e) => setDestination(e.target.value)}>
              <option value="catalog">Popraw treść główną katalogu</option>
              <option value="translation">Przygotuj tłumaczenie</option>
            </select>
          </label>
          <label>
            Język
            <select aria-label="Język partii AI" value={locale} onChange={(e) => setLocale(e.target.value)}>
              {Object.entries(languages).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {destination === 'catalog' && (
            <>
              <label>
                Styl
                <select aria-label="Ton partii AI" value={tone} onChange={(e) => setTone(e.target.value)}>
                  <option value="factual">Rzeczowy</option>
                  <option value="marketing">Marketingowy</option>
                  <option value="technical">Techniczny</option>
                </select>
              </label>
              <label>
                Długość opisu
                <select aria-label="Długość opisu partii AI" value={length} onChange={(e) => setLength(e.target.value)}>
                  <option value="short">Krótki</option>
                  <option value="medium">Średni</option>
                  <option value="long">Długi</option>
                </select>
              </label>
            </>
          )}
        </div>
        <button className="button" disabled={busy || !allowed || !model || selection.length < 1 || selection.length > 50}>
          Utwórz partię AI
        </button>
        <span className="muted"> Zaznaczone produkty: {selection.length} (maks. 50)</span>
      </form>
      {batch?.items && (
        <div className="catalog-ai-review">
          <strong>
            Partia · {batch.state === 'cancelled' ? 'Anulowana' : 'Otwarta'} · {batch.model} · {languages[batch.locale]} ·{' '}
            {batch.items.length} pozycji
          </strong>
          <table>
            <thead>
              <tr>
                <th>Zatwierdź</th>
                <th>Produkt</th>
                <th>Wynik</th>
                <th>Szkic AI</th>
              </tr>
            </thead>
            <tbody>
              {batch.items.map((i) => (
                <tr key={i.product_id}>
                  <td>
                    {i.draft?.state === 'ready' && batch.state === 'open' && (
                      <input
                        type="checkbox"
                        aria-label={'Zatwierdź ' + (i.product_name ?? i.product_id)}
                        checked={ticked.includes(i.product_id)}
                        onChange={(e) => {
                          setApproved(false);
                          setTicked((t) => (e.target.checked ? [...t, i.product_id] : t.filter((x) => x !== i.product_id)));
                        }}
                      />
                    )}
                  </td>
                  <td>{i.product_name ?? i.product_id}</td>
                  <td>
                    {itemLabel(i)}
                    {itemError(i) && <p className="error-inline">{itemError(i)}</p>}
                  </td>
                  <td>
                    {(i.draft?.reviewed_text ?? i.draft?.output) && (
                      <details>
                        <summary>{(i.draft!.reviewed_text ?? i.draft!.output)!.name}</summary>
                        <p className="catalog-description">{(i.draft!.reviewed_text ?? i.draft!.output)!.description}</p>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {ready.length > 0 && batch.state === 'open' && (
            <>
              <button type="button" className="text-button" onClick={() => { setApproved(false); setTicked(ready.map((i) => i.product_id)); }}>
                Zaznacz wszystkie gotowe ({ready.length})
              </button>
              <label className="checkbox-row">
                <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
                Sprawdziłem treści zaznaczonych pozycji
              </label>
              <button
                type="button"
                className="button primary"
                disabled={busy || !approved || ticked.length < 1}
                onClick={() =>
                  action(async () => {
                    const r = await api('/ai/catalog/batches/' + batch.id + '/apply', 'POST', { approve: true, item_ids: ticked });
                    for (const x of r.results) if (x.outcome === 'applied') saved(x.product_id);
                    setTicked([]);
                    setApproved(false);
                    await open(batch.id);
                  })
                }
              >
                Zatwierdź zaznaczone
              </button>
            </>
          )}
          <button type="button" className="button" disabled={busy} onClick={() => action(() => open(batch.id))}>
            Odśwież partię
          </button>
          {batch.state === 'open' && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => action(async () => { await api('/ai/catalog/batches/' + batch.id + '/cancel', 'POST', {}); await open(batch.id); })}
            >
              Anuluj partię
            </button>
          )}
        </div>
      )}
      {list.length > 0 && (
        <details className="catalog-ai-history">
          <summary>Ostatnie partie AI</summary>
          {list.map((b) => (
            <div key={b.id}>
              <button type="button" className="text-button" onClick={() => action(() => open(b.id))}>
                {new Date(b.created_at).toLocaleString('pl-PL')} · {b.item_count} pozycji · {b.state === 'cancelled' ? 'anulowana' : 'otwarta'}
              </button>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
