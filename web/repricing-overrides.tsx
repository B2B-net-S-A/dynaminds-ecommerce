import { useEffect, useState } from 'react';
import { api, money } from './api';

/** REPRICE-004: manual override per price list and SKU — exclusion from repricing or a fixed price,
 * with author and time; revoked rows stay as history. */
export function RepricingOverridesPanel({
  listId,
  currency,
  write,
  skus,
  onChanged,
}: {
  listId: string;
  currency: string;
  write: boolean;
  skus: { product_id: string; sku: string }[];
  onChanged: () => void;
}) {
  const root = '/price-lists/' + listId + '/repricing/overrides';
  const [state, setState] = useState<'active' | 'all'>('active'),
    [data, setData] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async (s = state) => setData(await api(root + '?state=' + s));
  useEffect(() => {
    let active = true;
    api(root + '?state=' + state)
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [root, state]);
  async function run(f: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await f();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return error ? <p role="alert" className="error-block">{error}</p> : <p>Wczytywanie nadpisań…</p>;
  if (!data.available) return <p className="muted">Ręczne nadpisania wymagają migracji 247 w tej kopii.</p>;
  const activeBy = new Map(data.data.filter((o: any) => !o.revoked_at).map((o: any) => [o.product_id, o]));
  return (
    <section aria-label="Ręczne nadpisania">
      <h3>Ręczne nadpisania</h3>
      <p className="muted">
        Wykluczenie zostawia obecną cenę SKU, cena ręczna zastępuje wyliczoną. Dotyczy podglądów i automatu tego cennika, więc każdej oferty
        synchronizowanej z tego cennika. Zmiana po utworzeniu podglądu wymaga nowego podglądu.
      </p>
      {error && <p role="alert" className="error-block">{error}</p>}
      {write && (
        <form
          className="form-grid"
          aria-label="Nowe nadpisanie"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            run(async () => {
              const product = String(f.get('product_id') ?? ''),
                mode = String(f.get('mode')),
                price = String(f.get('fixed_price') ?? '').trim().replace(',', '.');
              if (!product) throw Error('Wybierz SKU');
              if (mode === 'fixed' && !/^\d+(\.\d{1,2})?$/.test(price)) throw Error('Podaj cenę z najwyżej dwoma miejscami po przecinku');
              const [a, b = ''] = price.split('.');
              const current: any = activeBy.get(product);
              await api(root, 'POST', {
                product_id: product,
                mode,
                ...(mode === 'fixed' ? { fixed_price: Number(a) * 100 + Number(b.padEnd(2, '0')) } : {}),
                reason: f.get('reason'),
                replaces: current?.id ?? null,
              });
              await load();
              onChanged();
            });
          }}
        >
          <label>
            SKU
            <select name="product_id" required defaultValue="">
              <option value="">Wybierz SKU z kosztami</option>
              {skus.map((s) => (
                <option key={s.product_id} value={s.product_id}>
                  {s.sku}
                  {activeBy.has(s.product_id) ? ' (zastąp nadpisanie)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rodzaj
            <select name="mode" defaultValue="exclude">
              <option value="exclude">Wyklucz z repricingu</option>
              <option value="fixed">Cena ręczna</option>
            </select>
          </label>
          <label>
            Cena ręczna brutto ({currency})
            <input name="fixed_price" type="number" min="0" max="1000000" step="0.01" />
          </label>
          <label>
            Powód
            <input name="reason" minLength={3} maxLength={500} required />
          </label>
          <button className="button" disabled={busy}>
            Zapisz nadpisanie
          </button>
        </form>
      )}
      <label>
        Pokaż
        <select value={state} onChange={(e) => setState(e.target.value as 'active' | 'all')}>
          <option value="active">Aktywne</option>
          <option value="all">Wszystkie z historią</option>
        </select>
      </label>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Nadpisanie</th>
              <th>Autor i czas</th>
              <th>Stan</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((o: any) => (
              <tr key={o.id}>
                <td>
                  <strong>{o.sku}</strong>
                  {o.current_price !== null && <small>w cenniku {money(o.current_price, currency)}</small>}
                </td>
                <td>
                  {o.mode === 'fixed' ? 'Cena ręczna ' + money(o.fixed_price, currency) : 'Wykluczone z repricingu'}
                  <small>{o.reason}</small>
                </td>
                <td>
                  {o.created_by_name || 'Użytkownik'}
                  <small>{new Date(o.created_at).toLocaleString('pl-PL')}</small>
                </td>
                <td>
                  {o.revoked_at ? (
                    <>
                      Wycofane
                      <small>
                        {o.revoked_by_name || 'Użytkownik'} · {new Date(o.revoked_at).toLocaleString('pl-PL')} · {o.revoke_reason}
                      </small>
                    </>
                  ) : write ? (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await api('/repricing-overrides/' + o.id + '/revoke', 'POST', { confirmed: true });
                          await load();
                          onChanged();
                        })
                      }
                    >
                      Wycofaj
                    </button>
                  ) : (
                    'Aktywne'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.data.length && <p className="muted">Brak nadpisań.</p>}
    </section>
  );
}
