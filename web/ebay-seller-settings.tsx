import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import {collectAspectSources,prefillAspectSources,aspectSourceProblem,ownAspectValues,type AspectSource} from './ebay-aspect-source';

export function EbaySellerFields({
  channelId,
  productId,
  value,
  onChange,
  onReady,
}: {
  channelId: string;
  productId?: string;
  value: any;
  onChange: (v: any) => void;
  onReady: (ready: boolean) => void;
}) {
  const [options, setOptions] = useState<any>(null),
    [phrase, setPhrase] = useState(''),
    [hits, setHits] = useState<any[]>([]),
    [category, setCategory] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sourceFields,setSourceFields] = useState<AspectSource[]>([]),
    [sourceNotes,setSourceNotes] = useState<string[]>([]);
  const revision = useRef(0),
    current = useRef({ value, onChange });
  current.current = { value, onChange };
  useEffect(() => {
    onReady(!busy && !!options && !!category);
  }, [busy, options, category, onReady]);
  useEffect(() => {
    revision.current++;
    setOptions(null);
    setCategory(null);
    setSourceFields([]);setSourceNotes([]);
    setHits([]);
    setBusy(false);
    setError('');
    if (current.current.value.verify_settings)
      current.current.onChange({
        ...current.current.value,
        category_id: '',
        merchant_location_key: '',
        payment_policy_id: '',
        return_policy_id: '',
        fulfillment_policy_id: '',
        aspects: {},
      });
    return () => {
      revision.current++;
    };
  }, [channelId, value.content_language]);
  useEffect(() => {
    revision.current++;
    setBusy(false);
    if (current.current.value.verify_settings)
      current.current.onChange({ ...current.current.value, aspects: {} });
    setSourceFields([]);setSourceNotes([]);
  }, [productId]);
  async function load(task: () => Promise<void>) {
    const r = revision.current;
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e: any) {
      if (r === revision.current) setError(e.message);
    } finally {
      if (r === revision.current) setBusy(false);
    }
  }
  const endpoint = '/integrations/' + channelId + '/ebay/';
  function aspect(name: string, values: string[]) {
    const next = { ...(value.aspects ?? {}) };
    if (values.length) Object.defineProperty(next,name,{value:values,enumerable:true,writable:true,configurable:true});
    else delete next[name];
    onChange({ ...value, aspects: next });
  }
  return (
    <fieldset disabled={busy}>
      <legend>Kategoria i warunki sprzedaży</legend>
      <label>
        <input
          type="checkbox"
          checked={!value.verify_settings}
          onChange={(e) => {
            revision.current++;
            setCategory(null);
            setSourceFields([]);setSourceNotes([]);
            setOptions(null);
            setHits([]);
            onChange({
              ...value,
              verify_settings: !e.target.checked,
              aspects: undefined,
              category_id: '',
              merchant_location_key: '',
              payment_policy_id: '',
              return_policy_id: '',
              fulfillment_policy_id: '',
            });
          }}
        />
        Ręcznie wpisz ID — bez sprawdzania parametrów kategorii i warunków Account
      </label>
      {value.verify_settings && (
        <>
          <p>
            Odczyt warunków wymaga zgody sell.account.readonly. Wybory i parametry są ponownie
            sprawdzane przy przygotowaniu i zapisie szkicu.
          </p>
          <button
            type="button"
            className="button"
            onClick={() =>
              load(async () => {
                const r = revision.current;
                const result = await api(
                  endpoint + 'seller-settings?language=' + value.content_language,
                );
                if (r === revision.current) setOptions(result);
              })
            }
          >
            Pobierz ustawienia eBay
          </button>
          {options && (
            <>
              <p>
                {options.scope === 'local_simulation'
                  ? 'Dane demonstracyjne — bez połączenia z eBay.'
                  : 'Dane odczytane z konta eBay.'}
              </p>
              <label>
                Lokalizacja eBay
                <select
                  required
                  value={value.merchant_location_key}
                  onChange={(e) => onChange({ ...value, merchant_location_key: e.target.value })}
                >
                  <option value="">Wybierz lokalizację</option>
                  {options.locations.map((v: any) => (
                    <option
                      key={v.key}
                      value={v.key}
                      disabled={
                        v.status !== 'ENABLED' ||
                        !v.address?.country ||
                        !(v.address.postalCode || v.address.city)
                      }
                    >
                      {v.name} · {v.key} · {v.status}
                    </option>
                  ))}
                </select>
              </label>
              {(['payment', 'return', 'fulfillment'] as const).map((kind) => (
                <label key={kind}>
                  {
                    {
                      payment: 'Warunki płatności eBay',
                      return: 'Warunki zwrotu eBay',
                      fulfillment: 'Warunki dostawy eBay',
                    }[kind]
                  }
                  <select
                    required
                    value={value[kind + '_policy_id']}
                    onChange={(e) => onChange({ ...value, [kind + '_policy_id']: e.target.value })}
                  >
                    <option value="">Wybierz warunki</option>
                    {options.policies[kind].map((v: any) => (
                      <option key={v.id} value={v.id} disabled={!v.eligible}>
                        {v.name} · {v.id}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </>
          )}
          <label>
            Szukaj kategorii eBay
            <input value={phrase} maxLength={200} onChange={(e) => setPhrase(e.target.value)} />
          </label>
          <button
            type="button"
            className="button"
            disabled={!phrase.trim()}
            onClick={() =>
              load(async () => {
                const r = revision.current;
                const result = await api(
                  endpoint + 'categories?phrase=' + encodeURIComponent(phrase),
                );
                if (r === revision.current) setHits(result.data);
              })
            }
          >
            Szukaj kategorii
          </button>
          <label>
            Kategoria eBay
            <select
              required
              value={value.category_id}
              onChange={(e) => {
                const id = e.target.value;
                onChange({ ...value, category_id: id, aspects: {} });
                setCategory(null);
                setSourceFields([]);setSourceNotes([]);
                if (!id) return;
                revision.current++;
                load(async () => {
                  const r = revision.current;
                  const [meta, product] = await Promise.all([
                    api(endpoint + 'category?category_id=' + id),
                    productId ? api('/products/' + productId) : Promise.resolve(null),
                  ]);
                  if (r !== revision.current) return;
                  const {aspects,issues}=prefillAspectSources(product?.attributes,meta),sources=collectAspectSources(product?.attributes);
                  setSourceFields(sources.fields);setSourceNotes([...issues,...(sources.issue?[sources.issue]:[])]);
                  setCategory(meta);
                  current.current.onChange({ ...current.current.value, category_id: id, aspects });
                });
              }}
            >
              <option value="">Wybierz końcową kategorię</option>
              {hits.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.path || v.name} · {v.id}
                </option>
              ))}
            </select>
          </label>
          {category && (
            <>
              <p>
                {category.category.categoryName} ·{' '}
                {category.scope === 'local_simulation'
                  ? 'parametry DEMO'
                  : 'parametry Taxonomy eBay'}
                . Wartości dotyczą tej oferty; katalog produktu pozostaje bez zmian.
              </p>
              {sourceNotes.length>0&&<p role="status">{sourceNotes.join(' ')}</p>}
              <p>Obiekty nie są zamieniane w tekst parametru. Możesz wybrać konkretne pole produktu lub wpisać wartość ręcznie.</p>
              {category.aspects.map((a: any) => {
                const name = a.localizedAspectName,
                  c = a.aspectConstraint,
                  multi = c.itemToAspectCardinality === 'MULTI';
                const values=ownAspectValues(value.aspects,name);
                return (
                  <label key={name}>
                    {name}
                    {c.aspectRequired ? ' (wymagany)' : ' (opcjonalny)'}
                    {c.aspectMode === 'SELECTION_ONLY' ? (
                      <select
                        multiple={multi}
                        required={c.aspectRequired}
                        value={multi ? values : (values[0] ?? '')}
                        onChange={(e) =>
                          aspect(
                            name,
                            multi
                              ? Array.from(e.target.selectedOptions)
                                  .map((v) => v.value)
                                  .filter(Boolean)
                              : e.target.value
                                ? [e.target.value]
                                : [],
                          )
                        }
                      >
                        {!multi && <option value="">Wybierz wartość</option>}
                        {(a.aspectValues ?? []).map((v: any) => (
                          <option key={v.localizedValue} value={v.localizedValue}>
                            {v.localizedValue}
                          </option>
                        ))}
                      </select>
                    ) : multi ? (
                      <textarea
                        required={c.aspectRequired}
                        value={values.join('\n')}
                        placeholder="Jedna wartość w wierszu (maks. 30)"
                        onChange={(e) =>
                          aspect(
                            name,
                            e.target.value
                              .split('\n')
                              .map((v) => v.trim())
                              .filter(Boolean),
                          )
                        }
                      />
                    ) : (
                      <input
                        required={c.aspectRequired}
                        maxLength={Math.min(50, c.aspectMaxLength ?? 50)}
                        value={values[0] ?? ''}
                        onChange={(e) => aspect(name, e.target.value ? [e.target.value] : [])}
                      />
                    )}
                    {sourceFields.length>0&&<select aria-label={'Źródło produktu dla '+name} value="" onChange={e=>{
                      const source=sourceFields.find(x=>x.id===e.target.value);if(!source)return;
                      const issue=aspectSourceProblem(a,source.values,value.aspects??{});
                      if(issue){setError(name+': '+issue);return;}setError('');aspect(name,[...source.values]);
                    }}>
                      <option value="">Ustaw z pola produktu…</option>
                      {sourceFields.map(source=><option key={source.id} value={source.id} disabled={!!aspectSourceProblem(a,source.values,value.aspects??{})}>{source.label} · {source.values.join(' / ')}</option>)}
                    </select>}
                    {c.aspectDataType && (
                      <small>
                        Format eBay: {c.aspectDataType} {c.aspectFormat ?? ''}
                      </small>
                    )}
                  </label>
                );
              })}
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {busy && <p>Odczytywanie eBay…</p>}
    </fieldset>
  );
}
