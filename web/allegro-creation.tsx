import { useEffect, useId, useState } from 'react';
import { api } from './api';
export function AllegroCreationFields({
  channelId,
  onChange,
}: {
  channelId: string;
  onChange: (value: any) => void;
}) {
  const fieldId = useId();
  const [phrase, setPhrase] = useState(''),
    [catalogPhrase, setCatalogPhrase] = useState(''),
    [catalog, setCatalog] = useState<any>({ data: [], meta: {} }),
    [options, setOptions] = useState<any>({}),
    [value, setValue] = useState<any>({
      handling_time: 'PT24H',
      safety_information: '',
      parameters: [],
    }),
    [defs, setDefs] = useState<any[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const root = '/integrations/' + channelId + '/allegro/';
  function update(next: any) {
    setValue(next);
    onChange(next);
  }
  useEffect(() => {
    setValue({ handling_time: 'PT24H', safety_information: '', parameters: [] });
    onChange(null);
  }, [channelId]);
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
  async function loadOptions() {
    const entries = [];
    for (const resource of ['shipping', 'returns', 'warranties', 'producers'])
      entries.push([resource, await api(root + 'creation-options?resource=' + resource)]);
    setOptions(Object.fromEntries(entries));
  }
  return (
    <fieldset className="allegro-creation-fields">
      <legend>Nowa oferta Allegro PL</legend>
      <p>
        Wybierz produkt katalogu i ustawienia konta sprzedawcy. Powstanie nieaktywna oferta;
        publikację zatwierdzisz osobno. Zdjęcia i opis pochodzą z produktu katalogowego.
      </p>
      {error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      <label>
        Szukaj w katalogu Allegro
        <input
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder="EAN lub nazwa produktu"
          maxLength={200}
        />
      </label>
      <button
        type="button"
        className="button"
        disabled={busy || !phrase.trim()}
        onClick={() =>
          run(async () => {
            update({ ...value, product_id: undefined, parameters: [] });
            setDefs([]);
            setCatalogPhrase(phrase);
            setCatalog(await api(root + 'catalog?phrase=' + encodeURIComponent(phrase)));
          })
        }
      >
        Szukaj produktu Allegro
      </button>
      <label>
        Produkt katalogu Allegro
        <select
          required
          disabled={busy}
          value={value.product_id ?? ''}
          onChange={(e) =>
            run(async () => {
              const next = { ...value, product_id: e.target.value, parameters: [] };
              setDefs([]);
              update(next);
              if (next.product_id)
                setDefs((await api(root + 'offer-parameters?product_id=' + next.product_id)).data);
            })
          }
        >
          <option value="">Wybierz produkt katalogowy</option>
          {catalog.data.map((p: any) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.id}
            </option>
          ))}
        </select>
      </label>
      {catalog.meta.cursor && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const page = await api(
                root +
                  'catalog?phrase=' +
                  encodeURIComponent(catalogPhrase) +
                  '&after=' +
                  encodeURIComponent(catalog.meta.cursor),
              );
              setCatalog({ ...page, data: [...catalog.data, ...page.data] });
            })
          }
        >
          Kolejna strona katalogu Allegro
        </button>
      )}
      <button type="button" className="button" disabled={busy} onClick={() => run(loadOptions)}>
        Wczytaj ustawienia sprzedawcy Allegro
      </button>
      {(
        [
          ['shipping', 'shipping_rate_id', 'Cennik dostawy Allegro'],
          ['returns', 'return_policy_id', 'Warunki zwrotów Allegro'],
          ['warranties', 'implied_warranty_id', 'Warunki reklamacji Allegro'],
          ['producers', 'responsible_producer_id', 'Producent odpowiedzialny Allegro'],
        ] as const
      ).map(([resource, key, label]) => (
        <div key={resource}>
          <label>
            {label}
            <select
              required
              value={value[key] ?? ''}
              onChange={(e) => update({ ...value, [key]: e.target.value })}
            >
              <option value="">Wybierz ustawienie konta</option>
              {options[resource]?.data.map((r: any) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {options[resource]?.meta.cursor !== null &&
            options[resource]?.meta.cursor !== undefined && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const page = await api(
                      root +
                        'creation-options?resource=' +
                        resource +
                        '&offset=' +
                        options[resource].meta.cursor,
                    );
                    setOptions({
                      ...options,
                      [resource]: { ...page, data: [...options[resource].data, ...page.data] },
                    });
                  })
                }
              >
                Kolejna strona producentów
              </button>
            )}
        </div>
      ))}
      <label>
        Czas wysyłki Allegro
        <select
          value={value.handling_time}
          onChange={(e) => update({ ...value, handling_time: e.target.value })}
        >
          {[
            ['PT0S', 'Natychmiast'],
            ['PT24H', '24 godziny'],
            ['P2D', '2 dni'],
            ['P3D', '3 dni'],
            ['P4D', '4 dni'],
            ['P5D', '5 dni'],
            ['P7D', '7 dni'],
            ['P10D', '10 dni'],
            ['P14D', '14 dni'],
            ['P21D', '21 dni'],
            ['P30D', '30 dni'],
            ['P60D', '60 dni'],
          ].map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Informacje o bezpieczeństwie produktu
        <textarea
          required
          maxLength={5000}
          value={value.safety_information}
          onChange={(e) => update({ ...value, safety_information: e.target.value })}
        />
      </label>
      {defs.map((def) => {
        const item = value.parameters.find((p: any) => p.id === def.id);
        return (
          <div className="allegro-parameter" key={def.id}>
            <span id={fieldId + '-allegro-parameter-' + def.id}>
              {def.name}
              {def.required ? ' *' : ''}
            </span>
            {def.dictionary ? (
              <select
                aria-labelledby={fieldId + '-allegro-parameter-' + def.id}
                required={def.required}
                multiple={def.restrictions?.multipleChoices ?? false}
                value={
                  def.restrictions?.multipleChoices
                    ? (item?.valuesIds ?? [])
                    : (item?.valuesIds?.[0] ?? '')
                }
                onChange={(e) =>
                  update({
                    ...value,
                    parameters: [
                      ...value.parameters.filter((p: any) => p.id !== def.id),
                      ...(e.target.value
                        ? [
                            {
                              id: def.id,
                              valuesIds: Array.from(e.currentTarget.selectedOptions)
                                .map((o) => o.value)
                                .filter(Boolean),
                            },
                          ]
                        : []),
                    ],
                  })
                }
              >
                <option value="">Wybierz wartość</option>
                {def.dictionary.map((r: any) => (
                  <option key={r.id} value={r.id}>
                    {r.value}
                  </option>
                ))}
              </select>
            ) : def.restrictions?.range ? (
              <span className="allegro-range">
                {(['from', 'to'] as const).map((key) => (
                  <label key={key}>
                    {key === 'from' ? 'Od' : 'Do'}
                    <input
                      required={def.required}
                      value={item?.rangeValue?.[key] ?? ''}
                      onChange={(e) => {
                        const rangeValue = {
                          from: item?.rangeValue?.from ?? '',
                          to: item?.rangeValue?.to ?? '',
                          [key]: e.target.value,
                        };
                        update({
                          ...value,
                          parameters: [
                            ...value.parameters.filter((p: any) => p.id !== def.id),
                            ...(rangeValue.from || rangeValue.to
                              ? [
                                  {
                                    id: def.id,
                                    rangeValue,
                                  },
                                ]
                              : []),
                          ],
                        });
                      }}
                    />
                  </label>
                ))}
              </span>
            ) : (
              <textarea
                aria-labelledby={fieldId + '-allegro-parameter-' + def.id}
                required={def.required}
                rows={def.restrictions?.allowedNumberOfValues > 1 ? 3 : 1}
                value={(item?.values ?? []).join('\n')}
                onChange={(e) =>
                  update({
                    ...value,
                    parameters: [
                      ...value.parameters.filter((p: any) => p.id !== def.id),
                      ...(e.target.value
                        ? [
                            {
                              id: def.id,
                              values:
                                def.restrictions?.allowedNumberOfValues > 1
                                  ? e.target.value.split('\n').filter(Boolean)
                                  : [e.target.value],
                            },
                          ]
                        : []),
                    ],
                  })
                }
              />
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
