import './catalog-export-sources.css';

export type CatalogExportWarehouseChoice = { id: string; name: string; code: string };
export type CatalogExportPriceListChoice = {
  id: string;
  name: string;
  currency: string;
  version: number;
  active: boolean;
  fallback: boolean;
};
export type CatalogExportSourcesProps = {
  warehouses: CatalogExportWarehouseChoice[];
  price_lists: CatalogExportPriceListChoice[];
  warehouse_ids: string[];
  price_list_ids: string[];
  inventorySelected: boolean;
  pricesSelected: boolean;
  allowInventory: boolean;
  available: { inventory: boolean; prices: boolean };
  capped?: { warehouses?: boolean; price_lists?: boolean };
  disabled: boolean;
  onChange: (sources: { warehouse_ids: string[]; price_list_ids: string[] }) => void;
};

const limit = 10;

export function CatalogExportSources({
  warehouses,
  price_lists,
  warehouse_ids,
  price_list_ids,
  inventorySelected,
  pricesSelected,
  allowInventory,
  available,
  capped,
  disabled,
  onChange,
}: CatalogExportSourcesProps) {
  function toggle(kind: 'inventory' | 'prices', id: string, checked: boolean) {
    const inventory = kind === 'inventory';
    if (
      disabled ||
      !(inventory
        ? inventorySelected && allowInventory && available.inventory
        : pricesSelected && available.prices)
    )
      return;
    const ids = inventory ? warehouse_ids : price_list_ids;
    if (checked && (ids.length >= limit || ids.includes(id))) return;
    if (checked && !inventory && !price_lists.some((list) => list.id === id && list.active)) return;
    const next = checked ? [...ids, id] : ids.filter((value) => value !== id);
    onChange({
      warehouse_ids: inventory ? next : [...warehouse_ids],
      price_list_ids: inventory ? [...price_list_ids] : next,
    });
  }
  const inventoryDisabled =
    disabled || !inventorySelected || !allowInventory || !available.inventory;
  const pricesDisabled = disabled || !pricesSelected || !available.prices;
  const missingWarehouses = warehouse_ids.filter((id) => !warehouses.some((w) => w.id === id));
  const missingLists = price_list_ids.filter((id) => !price_lists.some((list) => list.id === id));
  return (
    <section className="catalog-export-sources" aria-label="Źródła stanów i cen eksportu">
      <h3>Źródła stanów i cen</h3>
      <p>
        Wybierz źródła dla pól „Stany magazynowe” i „Ceny z cenników”. Wybór nie dodaje tych pól do
        eksportu automatycznie.
      </p>
      <div className="ces-grid">
        <fieldset className="ces-group" disabled={inventoryDisabled}>
          <legend>
            Magazyny · {warehouse_ids.length}/{limit}
          </legend>
          {!inventorySelected && <p>Zaznacz pole „Stany magazynowe”, aby wybrać jego źródła.</p>}
          {!allowInventory && (
            <p>Brak bieżącego dostępu do stanów magazynowych. Nie zastępujemy ich zerem.</p>
          )}
          {allowInventory && !available.inventory && (
            <p>Źródła magazynowe nie są dostępne w tej kopii aplikacji.</p>
          )}
          {allowInventory && available.inventory && (
            <>
              {capped?.warehouses && (
                <p className="ces-notice">
                  Lista magazynów została ograniczona. Nie obejmuje wszystkich źródeł firmy;
                  wcześniej wybranych identyfikatorów nie usunięto.
                </p>
              )}
              {!warehouses.length && <p>Nie odczytano magazynów do wyboru.</p>}
              <div className="ces-choices">
                {warehouses.map((warehouse) => (
                  <label className="ces-choice" key={warehouse.id}>
                    <input
                      type="checkbox"
                      checked={warehouse_ids.includes(warehouse.id)}
                      disabled={
                        !warehouse_ids.includes(warehouse.id) && warehouse_ids.length >= limit
                      }
                      onChange={(e) => toggle('inventory', warehouse.id, e.target.checked)}
                    />
                    <span>
                      {warehouse.name}
                      <small>{warehouse.code}</small>
                    </span>
                  </label>
                ))}
                {missingWarehouses.map((id) => (
                  <label className="ces-choice ces-unresolved" key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={(e) => toggle('inventory', id, e.target.checked)}
                    />
                    <span>
                      Źródło poza odczytaną listą<small>{id}</small>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
          {inventorySelected && warehouse_ids.length === 0 && (
            <p className="ces-notice">
              Wybierz od 1 do {limit} własnych magazynów przed eksportem.
            </p>
          )}
          {warehouse_ids.length > limit && (
            <p className="ces-error" role="alert">
              Wybrano za dużo magazynów. Usuń nadmiar; zakres nie został obcięty.
            </p>
          )}
        </fieldset>
        <fieldset className="ces-group" disabled={pricesDisabled}>
          <legend>
            Cenniki · {price_list_ids.length}/{limit}
          </legend>
          {!pricesSelected && <p>Zaznacz pole „Ceny z cenników”, aby wybrać jego źródła.</p>}
          {!available.prices && <p>Źródła cenników nie są dostępne w tej kopii aplikacji.</p>}
          {available.prices && (
            <>
              {capped?.price_lists && (
                <p className="ces-notice">
                  Lista cenników została ograniczona. Nie obejmuje wszystkich źródeł firmy;
                  wcześniej wybranych identyfikatorów nie usunięto.
                </p>
              )}
              {!price_lists.length && <p>Nie odczytano cenników do wyboru.</p>}
              <div className="ces-choices">
                {price_lists.map((list) => {
                  const checked = price_list_ids.includes(list.id);
                  return (
                    <label className="ces-choice" key={list.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && (!list.active || price_list_ids.length >= limit)}
                        onChange={(e) => toggle('prices', list.id, e.target.checked)}
                      />
                      <span>
                        {list.name} · {list.currency}
                        <small>
                          Wersja {list.version}
                          {list.fallback ? ' · reguła ceny bazowej' : ' · własne ceny'}
                          {!list.active ? ' · nieaktywny — usuń z wyboru przed eksportem' : ''}
                        </small>
                      </span>
                    </label>
                  );
                })}
                {missingLists.map((id) => (
                  <label className="ces-choice ces-unresolved" key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={(e) => toggle('prices', id, e.target.checked)}
                    />
                    <span>
                      Źródło poza odczytaną listą<small>{id}</small>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
          {pricesSelected && price_list_ids.length === 0 && (
            <p className="ces-notice">
              Wybierz od 1 do {limit} własnych aktywnych cenników przed eksportem.
            </p>
          )}
          {price_list_ids.length > limit && (
            <p className="ces-error" role="alert">
              Wybrano za dużo cenników. Usuń nadmiar; zakres nie został obcięty.
            </p>
          )}
        </fieldset>
      </div>
      <p className="ces-hint">
        Brak ceny lub stanu jest opisany osobno i nie oznacza zera. Dla produktu fizycznego eksport
        pokazuje zapas i rezerwacje; dostępność zestawu wynika z jego składników w wybranym
        magazynie. Grupa wariantów nie ma własnego stanu fizycznego.
      </p>
      <p className="ces-hint">
        Ceny są kwotami brutto w najmniejszej jednostce waluty danego cennika, np. 12301 oznacza
        123,01 PLN. Eksport rozróżnia własną cenę, regułę i brak ceny. Własne zero jest ceną; walut
        nie przeliczamy.
      </p>
    </section>
  );
}
