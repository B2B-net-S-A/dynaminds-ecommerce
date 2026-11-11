import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import './catalog-bulk-edit.css';

export const logisticsFields = [
  'weight_grams',
  'length_mm',
  'width_mm',
  'height_mm',
  'manufacturer',
] as const;
export type LogisticsField = (typeof logisticsFields)[number];
export type ProductLogistics = {
  weight_grams?: number | null;
  length_mm?: number | null;
  width_mm?: number | null;
  height_mm?: number | null;
  manufacturer?: string | null;
};
export const logisticsLabels: Record<LogisticsField, string> = {
  weight_grams: 'Waga (kg)',
  length_mm: 'Długość (cm)',
  width_mm: 'Szerokość (cm)',
  height_mm: 'Wysokość (cm)',
  manufacturer: 'Producent',
};
export function isLogisticsField(field: string): field is LogisticsField {
  return (logisticsFields as readonly string[]).includes(field);
}
// Convert decimal text to integer base units without floating-point rounding.
export function parseLogisticsValue(field: LogisticsField, raw: string): number | string | null {
  const text = raw.trim();
  if (!text) return null;
  if (field === 'manufacturer') {
    if (text.length > 200) throw new Error('Producent jest zbyt długi (limit 200 znaków).');
    if (
      text.includes('\0') ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
    )
      throw new Error('Producent wymaga poprawnego tekstu Unicode bez NUL.');
    return text;
  }
  const precision = field === 'weight_grams' ? 3 : 1;
  const unit = field === 'weight_grams' ? 'kg' : 'cm';
  const normalized = text.replace(',', '.');
  if (!new RegExp('^(0|[1-9]\\d*)(?:\\.\\d{1,' + precision + '})?$').test(normalized))
    throw new Error(
      logisticsLabels[field] +
        ': wymagana dodatnia liczba bez wykładnika, najwyżej ' +
        precision +
        ' miejsc po kropce lub przecinku.',
    );
  const [whole, fraction = ''] = normalized.split('.');
  if (whole.length > 6)
    throw new Error(logisticsLabels[field] + ': przekroczono dopuszczalny zakres.');
  const base = BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0'));
  const max = field === 'weight_grams' ? 100000000n : 100000n;
  if (base < 1n || base > max)
    throw new Error(
      logisticsLabels[field] +
        ': zakres ' +
        (field === 'weight_grams' ? '0.001–100000' : '0.1–10000') +
        ' ' +
        unit +
        '.',
    );
  return Number(base);
}
export function logisticsRaw(field: LogisticsField, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (field === 'manufacturer') return String(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return '';
  const precision = field === 'weight_grams' ? 3 : 1;
  const units = 10n ** BigInt(precision),
    base = BigInt(value);
  const fraction = String(base % units)
    .padStart(precision, '0')
    .replace(/0+$/, '');
  return String(base / units) + (fraction ? '.' + fraction : '');
}
export function logisticsDisplay(field: LogisticsField, value: unknown): string {
  if (value === undefined) return 'Brak danych w tej kopii';
  if (value === null) return 'Nie podano';
  return (
    logisticsRaw(field, value) +
    (field === 'manufacturer' ? '' : field === 'weight_grams' ? ' kg' : ' cm')
  );
}
export function ProductLogisticsDetails({ product }: { product: ProductLogistics }) {
  return (
    <section className="catalog-section product-logistics">
      <h3>Dane logistyczne produktu</h3>
      <dl className="catalog-attributes">
        {logisticsFields.map((field) => (
          <div key={field}>
            <dt>{logisticsLabels[field]}</dt>
            <dd>{logisticsDisplay(field, product[field])}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">
        Wymiary dotyczą produktu. Wymiary i waga gotowej paczki wymagają osobnego ustalenia.
      </p>
    </section>
  );
}
type EstimateItem = ProductLogistics & {
  product_id: string;
  sku: string;
  name: string;
  quantity: number;
  version: number;
  known_weight_grams: number | null;
};
type Estimate = {
  available: boolean;
  basis: 'current_catalog';
  total_known_weight_grams: number | null;
  weight_overflow: boolean;
  complete: boolean;
  items: EstimateItem[];
  missing_weight_product_ids: string[];
};
export function ProductLogisticsPanel({ orderId }: { orderId: string }) {
  const [data, setData] = useState<Estimate | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(false),
    generation = useRef(0),
    inFlight = useRef<number | null>(null);
  async function load() {
    if (inFlight.current !== null) return;
    const current = ++generation.current;
    inFlight.current = current;
    setBusy(true);
    setError('');
    try {
      const result = await api<Estimate>(
        '/orders/' + encodeURIComponent(orderId) + '/product-logistics',
      );
      if (!alive.current || current !== generation.current) return;
      setData(result);
    } catch (e) {
      if (!alive.current || current !== generation.current) return;
      setError((e as Error).message);
      if (e instanceof ApiError && [401, 403, 404, 503].includes(e.status)) setData(null);
    } finally {
      if (alive.current && current === generation.current) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    inFlight.current = null;
    setData(null);
    setError('');
    void load();
    return () => {
      alive.current = false;
      ++generation.current;
      inFlight.current = null;
    };
  }, [orderId]);
  return (
    <section className="catalog-section product-logistics" aria-label="Dane logistyczne zamówienia">
      <div className="panel-heading">
        <h3>Waga i wymiary produktów</h3>
        <button type="button" className="button" disabled={busy} onClick={() => void load()}>
          Odśwież oszacowanie
        </button>
      </div>
      <p className="muted">
        Masa składników z aktualnego katalogu; ilości i fizyczny skład zestawów pochodzą ze
        snapshotu zamówienia. To oszacowanie masy produktów; nie obejmuje opakowania i nie określa
        wymiarów gotowej paczki.
      </p>
      {busy && <p role="status">Wczytywanie danych logistycznych…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data && !data.available && <p>Ta kopia nie zawiera danych logistycznych produktów.</p>}
      {data?.available && (
        <>
          <p>
            <strong>
              {data.complete ? 'Łączna znana waga produktów: ' : 'Częściowa znana waga produktów: '}
              {data.weight_overflow || data.total_known_weight_grams === null
                ? 'Przekroczony zakres pomiaru'
                : logisticsDisplay('weight_grams', data.total_known_weight_grams)}
            </strong>
          </p>
          {data.missing_weight_product_ids.length > 0 && (
            <p className="notice">
              Brakuje wagi dla {data.missing_weight_product_ids.length} produktów. Suma jest
              niepełna; nie można traktować jej jako potwierdzonej wagi przesyłki.
            </p>
          )}
          {data.weight_overflow && (
            <p className="notice">
              Znana masa przekracza dokładny zakres pomiaru. Nie wyświetlamy zaokrąglonej sumy.
            </p>
          )}
          <div className="product-logistics-scroll">
            <table>
              <thead>
                <tr>
                  <th>Produkt</th>
                  <th>Ilość / wersja</th>
                  <th>Waga jednostkowa</th>
                  <th>Znana waga pozycji</th>
                  <th>Wymiary produktu</th>
                  <th>Producent</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item, index) => (
                  <tr key={item.product_id + ':' + index}>
                    <td>
                      <strong>{item.sku}</strong>
                      <br />
                      {item.name}
                    </td>
                    <td>
                      {item.quantity} szt. · wersja {item.version}
                    </td>
                    <td>{logisticsDisplay('weight_grams', item.weight_grams)}</td>
                    <td>
                      {item.weight_grams == null
                        ? 'Nieznana'
                        : item.known_weight_grams === null
                          ? 'Przekroczony zakres pomiaru'
                          : logisticsDisplay('weight_grams', item.known_weight_grams)}
                    </td>
                    <td>
                      {['length_mm', 'width_mm', 'height_mm'].map((field) => (
                        <div key={field}>
                          {logisticsLabels[field as LogisticsField]}:{' '}
                          {logisticsDisplay(field as LogisticsField, item[field as LogisticsField])}
                        </div>
                      ))}
                    </td>
                    <td>{logisticsDisplay('manufacturer', item.manufacturer)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.items.length && <p>Brak pozycji produktowych do oszacowania.</p>}
        </>
      )}
    </section>
  );
}
