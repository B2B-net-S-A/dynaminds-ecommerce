import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Upload, Wallet, Plus } from 'lucide-react';
import type { BankCodProfile } from '../server/bank-cod-csv';
import { api, ApiError, date } from './api';
import './payment-imports.css';
import {
  PaymentImportAllocationsPanel,
  subscribePaymentImportAllocationsLock,
  resetPaymentImportAllocationsContext,
  getPaymentImportAllocationsLocked,
  type PaymentAllocationSource,
} from './payment-import-allocations';

type Profile = BankCodProfile;
type NamespaceOption = { id: string; label: string };
const modeNames = {
  bank_receipt: 'Wpłata klienta na rachunek',
  cod_collection: 'Pobranie od kupującego przez kuriera',
  cod_remittance: 'Przekazanie pobrania sprzedawcy',
};
const paymentKindNames: Record<string, string> = {
  receipt: 'Wpłata klienta',
  courier_collection: 'Pobranie od kupującego',
  courier_remittance: 'Przekazanie pobrania sprzedawcy',
  refund: 'Zwrot klientowi',
  reversal: 'Korekta',
};
const paymentKindName = (kind: string) => paymentKindNames[kind] ?? kind;
const sourceNames = { bank_statement: 'Wyciąg bankowy', carrier_report: 'Raport przewoźnika' };
const matchNames = {
  order_number: 'Dokładny numer zamówienia',
  external_order_id: 'ID zamówienia w konkretnym kanale',
  tracking_number: 'Numer nadania u konkretnego przewoźnika',
};
const currencies = ['PLN', 'EUR', 'USD', 'GBP', 'CZK'] as const;
const clone = <T,>(value: T): T => structuredClone(value);
function blankProfile(): Profile {
  return {
    name: '',
    description: '',
    source_kind: 'bank_statement',
    source_namespace_id: '',
    transaction_id_scope: 'namespace',
    mode: 'bank_receipt',
    encoding: 'utf-8',
    delimiter: ';',
    header: true,
    skip_records: 0,
    decimal_separator: ',',
    grouping_separator: 'none',
    sign: 'credit_positive',
    date_format: 'YYYY-MM-DD',
    columns: {
      transaction_id: { index: 0 },
      booking_date: { index: 1 },
      amount: { index: 2 },
      reference: [{ index: 3 }],
    },
    fixed_currency: 'PLN',
    match: { kind: 'order_number', extraction: 'whole_field' },
  };
}
function minorMoney(value: string | number | null | undefined, currency: string) {
  if (value === null || value === undefined || !/^-?\d+$/.test(String(value))) return '—';
  const n = BigInt(value),
    neg = n < 0n,
    absolute = neg ? -n : n;
  return (
    (neg ? '−' : '') +
    (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') +
    ',' +
    (absolute % 100n).toString().padStart(2, '0') +
    ' ' +
    currency
  );
}
function IndexInput({
  label,
  value,
  change,
  optional = false,
}: {
  label: string;
  value?: { index: number };
  change: (value: { index: number } | undefined) => void;
  optional?: boolean;
}) {
  return (
    <label>
      {label} (kolumna 1–100)
      <input
        type="number"
        min={1}
        max={100}
        step={1}
        required={!optional}
        value={value === undefined ? '' : value.index + 1}
        onChange={(e) =>
          change(e.target.value === '' ? undefined : { index: Number(e.target.value) - 1 })
        }
      />
    </label>
  );
}
function sensitiveApiFailure(e: unknown) {
  return e instanceof ApiError && [401, 403, 423, 503].includes(e.status);
}
function fileLabelProblem(name: string) {
  return !name.trim() || name.trim().length > 200 || /[\x00-\x1f\x7f]/.test(name)
    ? 'Podaj lokalną nazwę dowodu (1–200 znaków, bez znaków sterujących).'
    : '';
}
function profileProblem(p: Profile) {
  if (!p.name.trim() || !p.source_namespace_id)
    return 'Podaj nazwę formatu i wybierz istniejące źródło rozliczeń.';
  if (p.decimal_separator === p.grouping_separator)
    return 'Separator dziesiętny i grupowania muszą się różnić.';
  if (!!p.columns.currency === !!p.fixed_currency) return 'Wybierz jedno źródło waluty.';
  if (p.transaction_id_scope === 'statement' && !p.columns.statement_id)
    return 'Zakres raportu wymaga kolumny ze stałym ID wyciągu/raportu.';
  if (p.mode === 'bank_receipt' && p.source_kind !== 'bank_statement')
    return 'Wpłata klienta wymaga wyciągu bankowego.';
  if (p.mode === 'cod_collection' && p.source_kind !== 'carrier_report')
    return 'Potwierdzenie pobrania wymaga raportu przewoźnika.';
  if (
    (p.mode !== 'bank_receipt' || p.match.kind === 'tracking_number') &&
    (!p.columns.tracking_number || !p.match.carrier?.trim())
  )
    return 'COD lub dopasowanie po nadaniu wymaga kolumny numeru przesyłki i przewoźnika.';
  if (p.mode === 'cod_remittance' && !!p.columns.fee === !!p.fixed_fee_minor)
    return 'Rozliczenie pobrania wymaga jednej jawnej kolumny prowizji lub świadomego fee=0.';
  if (p.match.kind === 'external_order_id' && !p.match.channel_id)
    return 'Dopasowanie zewnętrznego ID wymaga konkretnego kanału.';
  if (p.match.extraction === 'delimited_token' && !p.match.reference_prefix?.trim())
    return 'Token wymaga literalnego prefiksu.';
  if (
    p.columns.direction &&
    (!p.direction_values?.credit.length || !p.direction_values?.debit.length)
  )
    return 'Kolumna kierunku wymaga dokładnych, rozłącznych wartości credit/debit.';
  const cols = Object.values(p.columns)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter(Boolean);
  if (cols.some((c) => !Number.isInteger(c.index) || c.index < 0 || c.index > 99))
    return 'Indeks kolumny wymaga liczby całkowitej 1–100.';
  return '';
}
function ProfileDefinition({ profile }: { profile: Profile }) {
  return (
    <div className="pi-definition">
      <p>
        <strong>{profile.name}</strong> · {modeNames[profile.mode]} ·{' '}
        {sourceNames[profile.source_kind]}
      </p>
      <p>
        Źródło rozliczeń zapisane w formacie · identyfikator transakcji:{' '}
        {profile.transaction_id_scope === 'namespace'
          ? 'unikalny dla źródła rozliczeń'
          : 'unikalne w wyciągu/raporcie'}
        . {profile.encoding}, separator{' '}
        {profile.delimiter === '\t' ? 'tabulator' : '„' + profile.delimiter + '”'},{' '}
        {profile.header ? 'z nagłówkiem' : 'bez nagłówka'}, pomijane rekordy: {profile.skip_records}
        .
      </p>
      <p>
        Kwota: kolumna {profile.columns.amount.index + 1}, separator dziesiętny „
        {profile.decimal_separator}”,{' '}
        {profile.sign === 'credit_positive'
          ? 'dodatni znak oznacza wpływ'
          : 'ujemny znak oznacza wpływ'}
        . Waluta:{' '}
        {profile.fixed_currency ??
          (profile.columns.currency
            ? 'kolumna ' + (profile.columns.currency.index + 1)
            : 'niewybrana')}
        .{' '}
        {profile.mode === 'cod_remittance'
          ? 'Prowizja: ' +
            (profile.fixed_fee_minor === '0'
              ? 'jawna stała 0'
              : profile.columns.fee
                ? 'kolumna ' + (profile.columns.fee.index + 1)
                : 'niewybrana') +
            '.'
          : ''}
      </p>
      <p>
        {matchNames[profile.match.kind]} ·{' '}
        {profile.match.extraction === 'whole_field'
          ? 'całe pole'
          : 'token z prefiksem „' + profile.match.reference_prefix + '”'}{' '}
        {profile.match.channel_id ? '· konkretny kanał zapisany w formacie' : ''}{' '}
        {profile.match.carrier ? '· przewoźnik ' + profile.match.carrier : ''}
      </p>
      <details>
        <summary>Pełne mapowanie i definicja</summary>
        <pre>{JSON.stringify(profile, null, 2)}</pre>
      </details>
    </div>
  );
}
function ProfileEditor({
  initial,
  namespaces,
  channels,
  locked,
  saving,
  resetReview,
  error,
  save,
  close,
}: {
  initial?: Profile;
  namespaces: NamespaceOption[];
  channels: { id: string; name: string }[];
  locked: boolean;
  saving: boolean;
  resetReview: number;
  error: string;
  save: (definition: Profile) => void;
  close: () => void;
}) {
  const [p, setP] = useState(() => clone(initial ?? blankProfile())),
    [reviewed, setReviewed] = useState(false),
    [directionText, setDirectionText] = useState(() => ({
      credit: initial?.direction_values?.credit.join('\n') ?? '',
      debit: initial?.direction_values?.debit.join('\n') ?? '',
    }));
  useEffect(() => {
    setReviewed(false);
  }, [locked, resetReview]);
  function update(next: Profile) {
    setP(next);
    setReviewed(false);
  }
  function col(key: keyof Profile['columns'], value: { index: number } | undefined) {
    const columns = { ...p.columns };
    if (value) Object.assign(columns, { [key]: value });
    else delete columns[key];
    update({ ...p, columns });
  }
  const problem = profileProblem(p);
  return (
    <form
      className="pi-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked && !saving && reviewed && !problem) save(clone(p));
      }}
    >
      <h3>{initial ? 'Edycja formatu' : 'Nowy format CSV'}</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <fieldset disabled={locked || saving}>
        <div className="pi-grid">
          <label>
            Nazwa lokalnego formatu
            <input
              required
              maxLength={120}
              value={p.name}
              onChange={(e) => update({ ...p, name: e.target.value })}
            />
          </label>
          <label>
            Opis
            <input
              maxLength={2000}
              value={p.description}
              onChange={(e) => update({ ...p, description: e.target.value })}
            />
          </label>
          <label>
            Stałe źródło rozliczeń: rachunek lub umowa
            <select
              required
              disabled={!!initial}
              value={p.source_namespace_id}
              onChange={(e) => update({ ...p, source_namespace_id: e.target.value })}
            >
              <option value="">Wybierz istniejące źródło rozliczeń</option>
              {namespaces.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Znaczenie kwoty
            <select
              value={p.mode}
              onChange={(e) => {
                const mode = e.target.value as Profile['mode'];
                const next = { ...p, mode, columns: { ...p.columns } };
                if (mode !== 'cod_remittance') {
                  delete next.columns.fee;
                  delete next.fixed_fee_minor;
                }
                if (mode === 'bank_receipt') next.source_kind = 'bank_statement';
                if (mode === 'cod_collection') next.source_kind = 'carrier_report';
                update(next);
              }}
            >
              {Object.entries(modeNames).map(([k, n]) => (
                <option key={k} value={k}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rodzaj dowodu
            <select
              value={p.source_kind}
              onChange={(e) =>
                update({ ...p, source_kind: e.target.value as Profile['source_kind'] })
              }
            >
              {Object.entries(sourceNames).map(([k, n]) => (
                <option key={k} value={k}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Zakres ID transakcji
            <select
              value={p.transaction_id_scope}
              disabled={!!initial}
              onChange={(e) =>
                update({
                  ...p,
                  transaction_id_scope: e.target.value as Profile['transaction_id_scope'],
                })
              }
            >
              <option value="namespace">Unikalne dla źródła rozliczeń</option>
              <option value="statement">Unikalne tylko w wyciągu/raporcie</option>
            </select>
          </label>
          <label>
            Kodowanie
            <select
              value={p.encoding}
              onChange={(e) => update({ ...p, encoding: e.target.value as Profile['encoding'] })}
            >
              <option value="utf-8">UTF-8</option>
              <option value="windows-1250">Windows-1250</option>
            </select>
          </label>
          <label>
            Separator CSV
            <select
              value={p.delimiter}
              onChange={(e) => update({ ...p, delimiter: e.target.value as Profile['delimiter'] })}
            >
              <option value=";">Średnik</option>
              <option value=",">Przecinek</option>
              <option value={'\t'}>Tabulator</option>
              <option value="|">Pionowa kreska</option>
            </select>
          </label>
          <label>
            Rekordy przed nagłówkiem
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={p.skip_records}
              onChange={(e) => update({ ...p, skip_records: Number(e.target.value) })}
            />
          </label>
          <label>
            Separator dziesiętny
            <select
              value={p.decimal_separator}
              onChange={(e) =>
                update({ ...p, decimal_separator: e.target.value as Profile['decimal_separator'] })
              }
            >
              <option value=",">Przecinek</option>
              <option value=".">Kropka</option>
            </select>
          </label>
          <label>
            Grupowanie tysięcy
            <select
              value={p.grouping_separator}
              onChange={(e) =>
                update({
                  ...p,
                  grouping_separator: e.target.value as Profile['grouping_separator'],
                })
              }
            >
              {[
                ['none', 'Brak'],
                [' ', 'Spacja'],
                ['\u00a0', 'Spacja nierozdzielająca'],
                ['.', 'Kropka'],
                [',', 'Przecinek'],
              ].map(([k, n]) => (
                <option key={k} value={k}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Znak wpływu
            <select
              value={p.sign}
              onChange={(e) => update({ ...p, sign: e.target.value as Profile['sign'] })}
            >
              <option value="credit_positive">Dodatnia kwota</option>
              <option value="credit_negative">Ujemna kwota</option>
            </select>
          </label>
          <label>
            Format daty
            <select
              value={p.date_format}
              onChange={(e) =>
                update({ ...p, date_format: e.target.value as Profile['date_format'] })
              }
            >
              <option>YYYY-MM-DD</option>
              <option>DD.MM.YYYY</option>
            </select>
          </label>
          <label>
            Źródło waluty
            <select
              value={p.fixed_currency ? 'fixed' : 'column'}
              onChange={(e) => {
                const next = { ...p, columns: { ...p.columns } };
                if (e.target.value === 'fixed') {
                  delete next.columns.currency;
                  next.fixed_currency = 'PLN';
                } else {
                  delete next.fixed_currency;
                  next.columns.currency = { index: 4 };
                }
                update(next);
              }}
            >
              <option value="fixed">Jawna stała waluta</option>
              <option value="column">Kolumna CSV</option>
            </select>
          </label>
          {p.fixed_currency && (
            <label>
              Waluta stała
              <select
                value={p.fixed_currency}
                onChange={(e) =>
                  update({ ...p, fixed_currency: e.target.value as Profile['fixed_currency'] })
                }
              >
                {currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label className="pi-check">
          <input
            type="checkbox"
            checked={p.header}
            onChange={(e) => update({ ...p, header: e.target.checked })}
          />
          Plik zawiera nagłówek po pominiętych rekordach
        </label>
        <h4>Mapowanie kolumn — numery w interfejsie zaczynają się od 1</h4>
        <p>
          ID transakcji pochodzi z ekonomicznego przepływu w raporcie; numer zamówienia, wiersza lub
          nazwa pliku nie zastępują go.
        </p>
        <div className="pi-grid">
          <IndexInput
            label="ID transakcji"
            value={p.columns.transaction_id}
            change={(v) => v && col('transaction_id', v)}
          />
          <IndexInput
            label="Data księgowania"
            value={p.columns.booking_date}
            change={(v) => v && col('booking_date', v)}
          />
          <IndexInput
            label="Kwota"
            value={p.columns.amount}
            change={(v) => v && col('amount', v)}
          />
          <IndexInput
            label="ID wyciągu/raportu"
            optional={p.transaction_id_scope !== 'statement'}
            value={p.columns.statement_id}
            change={(v) => col('statement_id', v)}
          />
          {!p.fixed_currency && (
            <IndexInput
              label="Waluta"
              value={p.columns.currency}
              change={(v) => col('currency', v)}
            />
          )}
          <IndexInput
            label="Własny numer/ID zamówienia (opcjonalnie)"
            optional
            value={p.columns.order_reference}
            change={(v) => col('order_reference', v)}
          />
          <IndexInput
            label="Numer nadania"
            optional={p.mode === 'bank_receipt' && p.match.kind !== 'tracking_number'}
            value={p.columns.tracking_number}
            change={(v) => col('tracking_number', v)}
          />
          <IndexInput
            label="Kierunek credit/debit (opcjonalnie)"
            optional
            value={p.columns.direction}
            change={(v) => {
              const next = { ...p, columns: { ...p.columns } };
              if (v) {
                next.columns.direction = v;
                next.direction_values ??= {
                  credit: directionText.credit.split('\n').filter(Boolean),
                  debit: directionText.debit.split('\n').filter(Boolean),
                };
              } else {
                delete next.columns.direction;
                delete next.direction_values;
              }
              update(next);
            }}
          />
        </div>
        <div className="pi-grid">
          {p.columns.reference.map((r, i) => (
            <div key={i}>
              <IndexInput
                label={'Tytuł / referencja ' + (i + 1)}
                value={r}
                change={(v) =>
                  v &&
                  update({
                    ...p,
                    columns: {
                      ...p.columns,
                      reference: p.columns.reference.map((old, j) => (j === i ? v : old)),
                    },
                  })
                }
              />
              {p.columns.reference.length > 1 && (
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    update({
                      ...p,
                      columns: {
                        ...p.columns,
                        reference: p.columns.reference.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  Usuń kolumnę tytułu
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="button"
          disabled={p.columns.reference.length >= 4}
          onClick={() =>
            update({
              ...p,
              columns: { ...p.columns, reference: [...p.columns.reference, { index: 0 }] },
            })
          }
        >
          Dodaj kolumnę tytułu (maks. 4)
        </button>
        {p.columns.direction && (
          <div className="pi-grid">
            {(['credit', 'debit'] as const).map((k) => (
              <label key={k}>
                Dokładne wartości {k} — po jednej w linii
                <textarea
                  rows={3}
                  value={directionText[k]}
                  onChange={(e) => {
                    setDirectionText((old) => ({ ...old, [k]: e.target.value }));
                    update({
                      ...p,
                      direction_values: {
                        ...p.direction_values!,
                        [k]: e.target.value.split('\n').filter(Boolean),
                      },
                    });
                  }}
                />
              </label>
            ))}
          </div>
        )}
        {p.mode === 'cod_remittance' && (
          <div className="pi-grid">
            <label>
              Źródło prowizji
              <select
                required
                value={p.fixed_fee_minor === '0' ? 'zero' : p.columns.fee ? 'column' : ''}
                onChange={(e) => {
                  const next = { ...p, columns: { ...p.columns } };
                  delete next.fixed_fee_minor;
                  delete next.columns.fee;
                  if (e.target.value === 'zero') next.fixed_fee_minor = '0';
                  if (e.target.value === 'column') next.columns.fee = { index: 5 };
                  update(next);
                }}
              >
                <option value="">Wybierz jawnie</option>
                <option value="column">Dokładna kolumna prowizji</option>
                <option value="zero">Świadomie stała prowizja 0</option>
              </select>
            </label>
            {p.columns.fee && (
              <IndexInput label="Prowizja" value={p.columns.fee} change={(v) => col('fee', v)} />
            )}
          </div>
        )}
        <h4>Dopasowanie zamówienia / przesyłki</h4>
        <div className="pi-grid">
          <label>
            Identyfikator
            <select
              value={p.match.kind}
              onChange={(e) => {
                const kind = e.target.value as Profile['match']['kind'];
                const match = { ...p.match, kind };
                if (kind !== 'external_order_id') delete match.channel_id;
                if (kind === 'tracking_number') {
                  match.extraction = 'whole_field';
                  delete match.reference_prefix;
                }
                update({ ...p, match });
              }}
            >
              {Object.entries(matchNames).map(([k, n]) => (
                <option key={k} value={k}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {p.match.kind === 'external_order_id' && (
            <label>
              Dokładny kanał
              <select
                required
                value={p.match.channel_id ?? ''}
                onChange={(e) =>
                  update({ ...p, match: { ...p.match, channel_id: e.target.value } })
                }
              >
                <option value="">Wybierz kanał</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(p.mode !== 'bank_receipt' || p.match.kind === 'tracking_number') && (
            <label>
              Dokładna nazwa przewoźnika
              <input
                required
                maxLength={80}
                value={p.match.carrier ?? ''}
                onChange={(e) => update({ ...p, match: { ...p.match, carrier: e.target.value } })}
              />
            </label>
          )}
          <label>
            Wyodrębnianie
            <select
              disabled={p.match.kind === 'tracking_number'}
              value={p.match.extraction}
              onChange={(e) => {
                const match = {
                  ...p.match,
                  extraction: e.target.value as Profile['match']['extraction'],
                };
                if (match.extraction === 'whole_field') delete match.reference_prefix;
                update({ ...p, match });
              }}
            >
              <option value="whole_field">Dokładnie całe pole</option>
              <option value="delimited_token">Token z literalnym prefiksem</option>
            </select>
          </label>
          {p.match.extraction === 'delimited_token' && (
            <label>
              Literalny prefiks (bez regex)
              <input
                required
                maxLength={80}
                value={p.match.reference_prefix ?? ''}
                onChange={(e) =>
                  update({ ...p, match: { ...p.match, reference_prefix: e.target.value } })
                }
              />
            </label>
          )}
        </div>
      </fieldset>
      <h4>Definicja do zapisu</h4>
      <ProfileDefinition profile={p} />
      {problem && <p className="error">{problem}</p>}
      <label className="pi-check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={locked || saving}
          onChange={(e) => setReviewed(e.target.checked)}
        />
        Sprawdziłem domenę tożsamości, źródła kwoty/prowizji/waluty i wszystkie kolumny. Zapis
        dotyczy formatu lokalnego, bez importu płatności.
      </label>
      <div className="pi-buttons">
        <button className="button primary" disabled={locked || saving || !reviewed || !!problem}>
          Zapisz format
        </button>
        <button type="button" className="button" disabled={saving} onClick={close}>
          Zamknij szkic
        </button>
      </div>
    </form>
  );
}

type Flags = { available: boolean; read_only: boolean; current_role: string; can_write: boolean };
type Namespace = NamespaceOption & {
  version: number;
  source_kind: 'bank_statement' | 'carrier_report' | 'shared_settlement';
  enabled: boolean;
};
type ProfileHead = { id: string; version: number; definition: Profile; deleted_at: string | null };
type Metadata = Flags & {
  data: ProfileHead[];
  namespaces: Namespace[];
  channels: { id: string; name: string; provider: string }[];
  meta: { cursor: string | null };
};
type Classification =
  'ready' | 'duplicate' | 'invalid' | 'unmatched' | 'ambiguous' | 'conflict' | 'review';
type Normalized = {
  amount_minor: string;
  fee_minor: string;
  currency: string;
  ledger_kind: string;
  transaction_id?: string | null;
  statement_id?: string | null;
  booking_date?: string;
  reference?: string;
  tracking_number?: string | null;
  event_stage?: string;
};
type Receipt = {
  id: string;
  order_id: string;
  order_number?: string;
  entry_id: string;
  shipment_id: string | null;
  kind: string;
  amount: number;
  fee: number;
  currency: string;
  booking_date: string;
  operation: string;
  execution_id: string;
  row_id: string;
  created_at: string;
  reversed: boolean;
};
type PreviewRow = {
  row_id: string;
  position: number;
  classification: Classification;
  issues: { code: string; field?: string; message: string }[];
  source: { raw: unknown; normalized: Normalized | null; entry_id?: string; reason?: string };
  evidence: {
    candidates: { id: string; number: string; shipment_id?: string; tracking_number?: string }[];
    more: boolean;
  };
  allocation: { order_id: string; shipment_id?: string } | null;
  snapshot: {
    order: {
      id: string;
      number: string;
      version: number;
      currency: string;
      status: string;
      payment_mode: string;
      total: number;
    };
    balance: unknown;
    [key: string]: unknown;
  } | null;
  payload_hash: string;
  economic_key: string | null;
  operation: 'apply' | 'link_existing' | 'reverse';
  linked_receipt_id?: string;
  receipt?: {
    id: string;
    order_number?: string;
    entry_id: string;
    before_balance: unknown;
    after_balance: unknown;
    result_version: number;
    reversed: boolean;
  } | null;
};
type Summary = {
  counts: Record<Classification, number>;
  totals: {
    currency: string;
    kind: string;
    operation?: 'apply' | 'link_existing' | 'reverse';
    amount_minor: string;
    fee_minor: string;
    count: number;
  }[];
};
type PreviewHead = {
  id: string;
  version: number;
  kind: string;
  scope_hash: string;
  file_id: string;
  profile_id: string;
  profile_version: number;
  summary: Summary;
  expires_at: string;
  created_at?: string;
};
type PreviewDetail = Flags &
  PreviewHead & {
    data: PreviewRow[];
    meta: { cursor: string | null };
    profile_snapshot: Profile | null;
  };
type ExecutionHead = {
  id: string;
  preview_id: string;
  kind: string;
  scope_hash: string;
  selected_count: number;
  currency: string;
  total_minor: string;
  fee_minor: string;
  state: string;
  error: string | null;
  job_id: string;
  created_at: string;
  result: Record<string, unknown>;
};
type ExecutionDetail = Flags &
  ExecutionHead & { data: PreviewRow[]; meta: { cursor: string | null } };
type UploadHead = {
  file_id: string;
  file_hash: string;
  byte_count: number;
  parser_version: string;
  filename: string;
  reused: boolean;
};
type PageData<T> = Flags & { data: T[]; meta: { cursor: string | null } };
type MutationAttempt = {
  title: string;
  path: string;
  method: string;
  body: unknown;
  financial: boolean;
  success: (result: any) => Promise<void> | void;
};
const classificationNames: Record<Classification, string> = {
  ready: 'Gotowy',
  duplicate: 'Duplikat — bez nowej wpłaty',
  invalid: 'Nieprawidłowy',
  unmatched: 'Brak dopasowania',
  ambiguous: 'Wiele dopasowań',
  conflict: 'Konflikt dowodu',
  review: 'Wymaga uzgodnienia',
};
const operationNames = {
  apply: 'Nowy lokalny wpis',
  link_existing: 'Powiązanie istniejącego dowodu — bez nowej wpłaty',
  reverse: 'Korekta istniejącego wpisu',
};
const executionNames: Record<string, string> = {
  queued: 'Zlecono — wynik jeszcze niepotwierdzony',
  running: 'Wykonywanie lokalnej transakcji',
  done: 'Zakończono',
  conflict: 'Konflikt — sprawdź wynik',
  failed: 'Błąd — sprawdź wynik',
  cancelled: 'Anulowano',
};
function mergeIds<T>(old: T[], rows: T[], key: (row: T) => string) {
  const known = new Set(old.map(key));
  return [...old, ...rows.filter((r) => !known.has(key(r)))];
}
function scopedPath(path: string, cursor?: string | null) {
  return path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '');
}
function ProfileSummaryTotals({
  summary,
  correction = false,
}: {
  summary: Summary;
  correction?: boolean;
}) {
  return (
    <div>
      <div className="pi-grid">
        {Object.entries(summary.counts).map(([key, count]) => (
          <p key={key}>
            {classificationNames[key as Classification]}: <strong>{count}</strong>
          </p>
        ))}
      </div>
      <p>
        {correction
          ? 'Kwoty wpisów do skorygowania według waluty i rodzaju. To dodatnie kwoty pierwotnych wpisów, bez zlecenia zwrotu klientowi.'
          : 'Kwoty dowodu według waluty i rodzaju; nie oznaczają potwierdzonego nowego księgowania.'}
      </p>
      {correction &&
        summary.counts.ready > 0 &&
        summary.totals.length > 0 &&
        summary.totals.every(
          (t) => BigInt(t.amount_minor) === 0n && BigInt(t.fee_minor) === 0n,
        ) && (
          <p className="notice">
            Podsumowanie tej starszej wersji podglądu zawiera zera. Sprawdź kwoty poszczególnych
            wierszy; przed nowym zleceniem przygotuj aktualny podgląd korekty.
          </p>
        )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Waluta / rodzaj</th>
              <th>Rekordy</th>
              <th>Kwota</th>
              <th>Prowizja</th>
            </tr>
          </thead>
          <tbody>
            {summary.totals.map((t, i) => (
              <tr key={i}>
                <td>
                  {t.currency} · {paymentKindName(t.kind)}
                  {t.operation && <small>{operationNames[t.operation]}</small>}
                </td>
                <td>{t.count}</td>
                <td>{minorMoney(t.amount_minor, t.currency)}</td>
                <td>{minorMoney(t.fee_minor, t.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function BalanceComparison({ before, after }: { before: unknown; after: unknown }) {
  const value = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const b = value(before),
    a = value(after);
  const rows = [
    ['nominal', 'Należność'],
    ['received', 'Zaksięgowane wpłaty klienta'],
    ['refunded', 'Zwroty klientowi'],
    ['net', 'Wpłaty po zwrotach'],
    ['amount_due', 'Pozostało do zapłaty'],
    ['overpayment', 'Nadpłata'],
  ];
  if (b.payment_mode === 'cod' || a.payment_mode === 'cod')
    rows.push(
      ['collected', 'Pobrania od kupującego'],
      ['remitted', 'Środki przekazane sprzedawcy'],
      ['fees', 'Prowizje przewoźnika'],
      ['courier_due', 'Pozostało do przekazania przez kuriera'],
    );
  const amount = (v: Record<string, unknown>, key: string) =>
    minorMoney(
      typeof v[key] === 'number' || typeof v[key] === 'string'
        ? (v[key] as number | string)
        : undefined,
      typeof v.currency === 'string' ? v.currency : '—',
    );
  return (
    <div className="table-scroll">
      <table>
        <caption>Potwierdzone saldo przed i po zapisie</caption>
        <thead>
          <tr>
            <th>Rozliczenie</th>
            <th>Przed</th>
            <th>Po</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .filter(([key]) => key in b || key in a)
            .map(([key, label]) => (
              <tr key={key}>
                <th scope="row">{label}</th>
                <td>{amount(b, key)}</td>
                <td>{amount(a, key)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
function ExecutionOutcome({ execution }: { execution: ExecutionDetail }) {
  const result = execution.result;
  const labels: Record<string, string> = {
    applied: 'Rozliczone wiersze',
    ledger_entries: 'Nowe wpisy w rejestrze',
    aliases: 'Powiązane istniejące dowody',
  };
  const counts = Object.entries(labels).filter(
    ([key]) =>
      result &&
      typeof result[key] === 'number' &&
      Number.isSafeInteger(result[key]) &&
      Number(result[key]) >= 0,
  );
  const groups = new Map<
    string,
    {
      kind: string;
      operation: string;
      currency: string;
      amount: bigint;
      fee: bigint;
      count: number;
    }
  >();
  for (const row of execution.data) {
    const n = row.source.normalized;
    if (!n || row.operation === 'link_existing') continue;
    const key = n.ledger_kind + ':' + row.operation + ':' + n.currency;
    const g = groups.get(key) ?? {
      kind: n.ledger_kind,
      operation: row.operation,
      currency: n.currency,
      amount: 0n,
      fee: 0n,
      count: 0,
    };
    g.amount += BigInt(n.amount_minor);
    g.fee += BigInt(n.fee_minor);
    g.count++;
    groups.set(key, g);
  }
  return (
    <div>
      {!!counts.length && (
        <dl className="pi-result-counts">
          {counts.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{String(result[key])}</dd>
            </div>
          ))}
        </dl>
      )}
      {!!groups.size && (
        <div className="table-scroll">
          <table>
            <caption>Kwoty wczytanych wierszy według rodzaju rozliczenia</caption>
            <thead>
              <tr>
                <th>Rodzaj</th>
                <th>Operacja</th>
                <th>Wiersze</th>
                <th>
                  {execution.kind === 'correction' ? 'Kwota odwracanego wpisu' : 'Kwota wpisu'}
                </th>
                <th>Prowizja</th>
              </tr>
            </thead>
            <tbody>
              {[...groups.values()].map((g) => (
                <tr key={g.kind + g.operation + g.currency}>
                  <td>{paymentKindName(g.kind)}</td>
                  <td>
                    {operationNames[g.operation as keyof typeof operationNames] ?? g.operation}
                  </td>
                  <td>{g.count}</td>
                  <td>{minorMoney(g.amount.toString(), g.currency)}</td>
                  <td>{minorMoney(g.fee.toString(), g.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details>
        <summary>Szczegóły techniczne wykonania</summary>
        <pre>
          {JSON.stringify(
            { id: execution.id, scope_hash: execution.scope_hash, result: execution.result },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
function RowEvidence({ row, executionState }: { row: PreviewRow; executionState?: string }) {
  const n = row.source.normalized;
  return (
    <div>
      <p>
        <strong>
          {executionState ? 'Zamrożona klasyfikacja: ' : ''}
          {classificationNames[row.classification]}
        </strong>{' '}
        · {operationNames[row.operation]}
      </p>
      <p>
        {row.snapshot?.order.number ??
          row.receipt?.order_number ??
          (row.allocation?.order_id ? 'Przypisane zamówienie' : 'Bez przypisanego zamówienia')}{' '}
        {row.allocation?.shipment_id ? '· powiązana przesyłka' : ''}
      </p>
      {n && (
        <p>
          Kwota: {minorMoney(n.amount_minor, n.currency)} · prowizja:{' '}
          {minorMoney(n.fee_minor, n.currency)} · {paymentKindName(n.ledger_kind)}.{' '}
          {n.booking_date ? 'Data dowodu: ' + n.booking_date + '.' : ''}
        </p>
      )}
      {n && row.operation !== 'reverse' && (
        <p>
          ID transakcji: {n.transaction_id ?? 'brak'}{' '}
          {n.statement_id ? '· ID wyciągu/raportu ' + n.statement_id : ''}{' '}
          {n.tracking_number ? '· numer nadania ' + n.tracking_number : ''}
        </p>
      )}
      {row.operation === 'reverse' && <p>Uzasadnienie korekty: {row.source.reason ?? '—'}.</p>}
      {executionState && !row.receipt && (
        <p>
          {executionState === 'queued'
            ? 'Zapis tego wiersza jeszcze nie został potwierdzony.'
            : 'Brak potwierdzonego dowodu rozliczenia dla tego wiersza.'}
        </p>
      )}
      {n?.reference && <pre>{n.reference}</pre>}
      {row.issues.map((issue, i) => (
        <p className="error" key={i}>
          {issue.message} <small>({issue.code})</small>
        </p>
      ))}
      {row.linked_receipt_id && (
        <p>Powiązano istniejący dowód rozliczenia; wpłata nie zostanie zwiększona.</p>
      )}
      {row.receipt && (
        <div className="pi-review">
          <p>Potwierdzony dowód rozliczenia {row.receipt.reversed ? '· skorygowany' : ''}</p>
          <BalanceComparison
            before={row.receipt.before_balance}
            after={row.receipt.after_balance}
          />
          <details>
            <summary>Szczegóły techniczne dowodu</summary>
            <pre>{JSON.stringify(row.receipt, null, 2)}</pre>
          </details>
        </div>
      )}
      <details>
        <summary>Zamrożony dowód, dopasowanie i finanse</summary>
        <pre>
          {JSON.stringify(
            {
              row_id: row.row_id,
              economic_key: row.economic_key,
              payload_hash: row.payload_hash,
              source: row.source,
              linked_receipt_id: row.linked_receipt_id,
              evidence: row.evidence,
              allocation: row.allocation,
              snapshot: row.snapshot,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
function bytesBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 16384)
    s += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(s);
}

export function AdminPaymentImports({
  onError,
  readOnly,
  contextKey,
}: {
  onError: (message: string) => void;
  readOnly: boolean;
  contextKey: string;
}) {
  const [allocationSource, setAllocationSource] = useState<PaymentAllocationSource | null>(null),
    [allocationLocked, setAllocationLocked] = useState(false);
  useEffect(
    () => subscribePaymentImportAllocationsLock(contextKey, setAllocationLocked),
    [contextKey],
  );
  const [metadata, setMetadata] = useState<Metadata | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [blocked, setBlocked] = useState(false),
    [serverReadonly, setServerReadonly] = useState(false);
  const [pending, setPending] = useState<MutationAttempt | null>(null),
    [retryConsent, setRetryConsent] = useState(false);
  const [editor, setEditor] = useState<{ head?: ProfileHead; serial: string } | null>(null),
    [namespaceEditor, setNamespaceEditor] = useState<Namespace | null | 'new'>(null);
  const [archive, setArchive] = useState<ProfileHead | null>(null),
    [archiveConsent, setArchiveConsent] = useState(false);
  const [profileId, setProfileId] = useState(''),
    [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null),
    [upload, setUpload] = useState<UploadHead | null>(null);
  const [preview, setPreview] = useState<PreviewDetail | null>(null),
    [selectedRows, setSelectedRows] = useState<Record<string, PreviewRow>>({}),
    [consent, setConsent] = useState(''),
    [classification, setClassification] = useState<Classification | 'all'>('all');
  const [previewHistory, setPreviewHistory] = useState<PageData<PreviewHead> | null>(null),
    [executionHistory, setExecutionHistory] = useState<PageData<ExecutionHead> | null>(null),
    [execution, setExecution] = useState<ExecutionDetail | null>(null);
  const [now, setNow] = useState(Date.now()),
    [correctionOpen, setCorrectionOpen] = useState(false),
    [resetReview, setResetReview] = useState(0);
  const alive = useRef(true),
    metadataGeneration = useRef(0),
    previewGeneration = useRef(0),
    executionGeneration = useRef(0),
    fileGeneration = useRef(0),
    historyGeneration = useRef(0),
    mutation = useRef(false),
    pendingRef = useRef<MutationAttempt | null>(null);
  const readonly = readOnly || serverReadonly || !!metadata?.read_only;
  const canWrite =
    metadata?.available === true &&
    metadata.can_write === true &&
    metadata.current_role === 'admin' &&
    !readonly &&
    !blocked;
  const locked = !canWrite || saving || !!pending || allocationLocked;
  const activeProfile = metadata?.data.find((p) => p.id === profileId && !p.deleted_at);
  function clearFinancialViews() {
    setAllocationSource(null);
    ++previewGeneration.current;
    ++executionGeneration.current;
    ++fileGeneration.current;
    ++historyGeneration.current;
    setPreview(null);
    setSelectedRows({});
    setExecution(null);
    setPreviewHistory(null);
    setExecutionHistory(null);
    setUpload(null);
    setFile(null);
    setConsent('');
    setEditor(null);
    setNamespaceEditor(null);
    setArchive(null);
    setCorrectionOpen(false);
  }
  function failure(e: unknown) {
    const message = (e as Error).message;
    setError(message);
    onError(message);
    setConsent('');
    setRetryConsent(false);
    setArchiveConsent(false);
    setResetReview((n) => n + 1);
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      setBlocked(true);
      setMetadata(null);
      resetPaymentImportAllocationsContext(contextKey);
      clearFinancialViews();
      pendingRef.current = null;
      setPending(null);
    }
    if (e instanceof ApiError && e.status === 423) setServerReadonly(true);
  }
  function flags(d: Flags) {
    if (d.read_only) {
      setServerReadonly(true);
      setConsent('');
      setRetryConsent(false);
      setArchiveConsent(false);
      setResetReview((n) => n + 1);
    }
    if (!d.available || d.current_role !== 'admin') {
      setBlocked(true);
      clearFinancialViews();
      setMetadata((current) =>
        current
          ? { ...current, available: d.available, can_write: false, current_role: d.current_role }
          : current,
      );
      return false;
    }
    return true;
  }
  async function loadMetadata(cursor?: string | null) {
    setConsent('');
    setArchiveConsent(false);
    setResetReview((n) => n + 1);
    const current = ++metadataGeneration.current;
    setLoading(true);
    setError('');
    try {
      const d = await api<Metadata>(scopedPath('/payment-imports/profiles', cursor));
      if (!alive.current) return;
      if (!flags(d) || current !== metadataGeneration.current) {
        if (current === metadataGeneration.current) setMetadata(d);
        return;
      }
      setMetadata((old) => ({
        ...d,
        data: cursor ? mergeIds(old?.data ?? [], d.data, (r) => r.id) : d.data,
      }));
      setBlocked(!d.available || d.current_role !== 'admin');
      setServerReadonly(d.read_only);
      if (!d.available || d.current_role !== 'admin') clearFinancialViews();
    } catch (e) {
      if (alive.current && (current === metadataGeneration.current || sensitiveApiFailure(e)))
        failure(e);
    } finally {
      if (alive.current && current === metadataGeneration.current) setLoading(false);
    }
  }
  async function loadHistory(kind: 'previews' | 'executions', cursor?: string | null) {
    const current = ++historyGeneration.current;
    setLoading(true);
    try {
      const d = await api<PageData<any>>(scopedPath('/payment-imports/' + kind, cursor));
      if (!alive.current) return;
      if (!flags(d) || current !== historyGeneration.current) return;
      if (kind === 'previews')
        setPreviewHistory((old) => ({
          ...d,
          data: cursor ? mergeIds(old?.data ?? [], d.data, (r) => r.id) : d.data,
        }));
      else
        setExecutionHistory((old) => ({
          ...d,
          data: cursor ? mergeIds(old?.data ?? [], d.data, (r) => r.id) : d.data,
        }));
    } catch (e) {
      if (alive.current && (current === historyGeneration.current || sensitiveApiFailure(e)))
        failure(e);
    } finally {
      if (alive.current && current === historyGeneration.current) setLoading(false);
    }
  }
  async function openPreview(id: string, cursor?: string | null) {
    const current = ++previewGeneration.current;
    setLoading(true);
    setConsent('');
    if (!cursor) {
      if (!getPaymentImportAllocationsLocked(contextKey)) setAllocationSource(null);
      setPreview(null);
      setSelectedRows({});
      setExecution(null);
      ++executionGeneration.current;
    }
    try {
      const d = await api<PreviewDetail>(scopedPath('/payment-imports/previews/' + id, cursor));
      if (!alive.current) return;
      if (!flags(d) || current !== previewGeneration.current) return;
      setPreview((old) => ({
        ...d,
        data: cursor && old?.id === id ? mergeIds(old.data, d.data, (r) => r.row_id) : d.data,
      }));
    } catch (e) {
      if (alive.current && (current === previewGeneration.current || sensitiveApiFailure(e)))
        failure(e);
    } finally {
      if (alive.current && current === previewGeneration.current) setLoading(false);
    }
  }
  async function openExecution(id: string, cursor?: string | null) {
    const current = ++executionGeneration.current;
    setLoading(true);
    setConsent('');
    if (!cursor) {
      if (!getPaymentImportAllocationsLocked(contextKey)) setAllocationSource(null);
      setExecution(null);
      setPreview(null);
      setSelectedRows({});
      ++previewGeneration.current;
    }
    try {
      const d = await api<ExecutionDetail>(scopedPath('/payment-imports/executions/' + id, cursor));
      if (!alive.current) return;
      if (!flags(d) || current !== executionGeneration.current) return;
      setExecution((old) => ({
        ...d,
        data: cursor && old?.id === id ? mergeIds(old.data, d.data, (r) => r.row_id) : d.data,
      }));
    } catch (e) {
      if (alive.current && (current === executionGeneration.current || sensitiveApiFailure(e)))
        failure(e);
    } finally {
      if (alive.current && current === executionGeneration.current) setLoading(false);
    }
  }
  async function perform(attempt: MutationAttempt, retry = false) {
    if (
      !canWrite ||
      mutation.current ||
      saving ||
      (!retry && pendingRef.current) ||
      (!retry && getPaymentImportAllocationsLocked(contextKey)) ||
      (retry && !retryConsent)
    )
      return;
    const frozen = retry ? pendingRef.current : attempt;
    if (!frozen) return;
    pendingRef.current = frozen;
    setPending(frozen);
    setSaving(true);
    mutation.current = true;
    setError('');
    setNotice('');
    setRetryConsent(false);
    let confirmed = false;
    try {
      const result = await api(frozen.path, frozen.method, frozen.body);
      confirmed = true;
      if (!alive.current) return;
      pendingRef.current = null;
      setPending(null);
      setConsent('');
      await frozen.success(result);
    } catch (e) {
      if (!alive.current) return;
      failure(e);
      if (!confirmed && e instanceof ApiError && [409, 422].includes(e.status)) {
        pendingRef.current = null;
        setPending(null);
      }
      if (confirmed)
        setNotice(
          'Zapis został potwierdzony. Odśwież odczyt wyników; nie trzeba powtarzać zapisu.',
        );
    } finally {
      mutation.current = false;
      if (alive.current) setSaving(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void loadMetadata();
    return () => {
      alive.current = false;
      ++metadataGeneration.current;
      ++previewGeneration.current;
      ++executionGeneration.current;
      ++fileGeneration.current;
      ++historyGeneration.current;
      pendingRef.current = null;
    };
  }, []);
  useEffect(() => {
    setConsent('');
    setRetryConsent(false);
    setArchiveConsent(false);
  }, [readonly, blocked]);
  useEffect(() => {
    if (!preview) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [preview?.id]);
  const selection = Object.values(selectedRows).sort((a, b) =>
    a.row_id < b.row_id ? -1 : a.row_id > b.row_id ? 1 : 0,
  );
  const selectionFence = preview
    ? preview.id +
      ':' +
      preview.version +
      ':' +
      preview.scope_hash +
      ':' +
      selection.map((r) => r.row_id + ':' + r.payload_hash).join('|')
    : '';
  const selectionRef = useRef(selectionFence);
  selectionRef.current = selectionFence;
  const expired = !!preview && new Date(preview.expires_at).getTime() <= now;
  const selectedCurrencies = new Set(
    selection.map((r) => r.source.normalized?.currency).filter(Boolean),
  );
  const selectionProblem =
    selection.length < 1
      ? 'Wybierz jawnie przynajmniej jeden gotowy wiersz.'
      : selection.length > 100
        ? 'Jedno wykonanie obejmuje maksymalnie 100 wierszy.'
        : selection.some((r) => r.classification !== 'ready')
          ? 'Wyjątek nie może zostać zlecony.'
          : selectedCurrencies.size !== 1
            ? 'Jedno wykonanie wymaga jednej waluty.'
            : '';
  function selectRow(row: PreviewRow, checked: boolean) {
    if (locked || expired) return;
    setConsent('');
    setSelectedRows((old) => {
      const next = { ...old };
      if (checked && row.classification === 'ready' && Object.keys(next).length < 100)
        next[row.row_id] = row;
      else if (!checked) delete next[row.row_id];
      return next;
    });
  }
  async function chooseFile(value: File | undefined) {
    if (locked) return;
    setAllocationSource(null);
    const current = ++fileGeneration.current;
    setFile(null);
    setUpload(null);
    setPreview(null);
    setSelectedRows({});
    setConsent('');
    ++previewGeneration.current;
    setError('');
    if (!value) return;
    if (!value.size || value.size > 5 * 1024 * 1024) {
      failure(Error('CSV wymaga od 1 bajtu do 5 MiB. Pliku nie obcinamy.'));
      return;
    }
    try {
      const bytes = new Uint8Array(await value.arrayBuffer());
      if (alive.current && current === fileGeneration.current) setFile({ name: value.name, bytes });
    } catch (e) {
      if (alive.current && current === fileGeneration.current) failure(e);
    }
  }
  function queuePreview() {
    if (
      !preview ||
      locked ||
      loading ||
      expired ||
      selectionProblem ||
      consent !== selectionFence ||
      selectionRef.current !== selectionFence
    )
      return;
    const correction = preview.kind === 'correction';
    if (
      correction &&
      (selection.length !== Object.values(preview.summary.counts).reduce((n, c) => n + c, 0) ||
        preview.data.some((r) => !selectedRows[r.row_id]) ||
        preview.meta.cursor)
    )
      return;
    const body = correction
      ? {
          client_key: crypto.randomUUID(),
          scope_hash: preview.scope_hash,
          confirmed: true,
          local_ledger_only: true,
        }
      : {
          client_key: crypto.randomUUID(),
          version: preview.version,
          row_ids: selection.map((r) => r.row_id),
          scope_hash: preview.scope_hash,
          confirmed: true,
          local_ledger_only: true,
        };
    void perform({
      title:
        'Dokładnie zatwierdzone wykonanie ' + preview.id + ' · ' + selection.length + ' wierszy',
      path: correction
        ? '/payment-imports/corrections/' + preview.id + '/queue'
        : '/payment-imports/previews/' + preview.id + '/queue',
      method: 'POST',
      body,
      financial: true,
      success: async (result) => {
        setNotice(
          'Zlecono trwałe wykonanie lokalne. Kwoty nie są jeszcze potwierdzone jako zapisane.',
        );
        await openExecution(result.id);
        await loadHistory('executions');
      },
    });
  }
  return (
    <section className="panel payment-imports-panel">
      <div className="panel-heading">
        <div>
          <h2>
            <Wallet size={20} /> Import wpłat i pobrań CSV
          </h2>
          <p>
            Lokalne dowody i rejestr płatności. Plik nie potwierdza autentyczności wpłaty u banku
            lub kuriera.
          </p>
        </div>
        <button
          className="button"
          disabled={loading || saving || !!pending}
          onClick={() => void loadMetadata()}
        >
          <RefreshCw size={16} /> Odśwież dostęp i formaty
        </button>
      </div>
      <div className="pi-body">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {loading && !metadata && <p role="status">Wczytywanie importera…</p>}
        {readonly && (
          <p className="notice">
            Kopia tylko do odczytu: konfiguracja, upload, nowe podglądy, zlecenia, anulowanie i
            korekty są wyłączone.
          </p>
        )}
        {metadata && !metadata.available && (
          <p className="notice">
            Ta kopia nie zawiera importera bank/COD. Nie odwołujemy się do brakujących danych
            modułu.
          </p>
        )}
        {blocked && (
          <p className="notice">
            Dostęp jest niedostępny lub wymaga aktualnego administratora. Odśwież po przywróceniu
            uprawnień.
          </p>
        )}
        {pending && (
          <div className="pi-review">
            <h3>Niepotwierdzona próba</h3>
            <p>{pending.title}</p>
            <p>
              Odpowiedź mogła zostać utracona po zapisie. Treść i klucz tej próby pozostają
              niezmienne w pamięci tej sesji. Sprawdź historię lub ponów dokładnie to samo żądanie.
            </p>
            <details>
              <summary>Dokładny zakres próby (bez bajtów CSV)</summary>
              <pre>
                {JSON.stringify(
                  {
                    ...(pending.body as object),
                    ...(pending.path.endsWith('/uploads')
                      ? { content_base64: '(surowe bajty CSV zachowane w pamięci)' }
                      : {}),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <label className="pi-check">
              <input
                type="checkbox"
                checked={retryConsent}
                disabled={!canWrite || saving}
                onChange={(e) => setRetryConsent(e.target.checked)}
              />
              {pending.financial
                ? 'Ponownie sprawdziłem ten sam zakres. Potwierdzam wyłącznie opisany lokalny zapis rejestru/statusu, bez transferu pieniędzy lub operacji u dostawców.'
                : 'Ponownie potwierdzam identyczny zakres lokalnej operacji.'}
            </label>
            <button
              className="button primary"
              disabled={!canWrite || saving || !retryConsent}
              onClick={() => void perform(pending, true)}
            >
              Ponów tę samą próbę
            </button>
            <button
              className="button"
              disabled={saving}
              onClick={() => {
                pendingRef.current = null;
                setPending(null);
                setConsent('');
                setRetryConsent(false);
                setNotice(
                  'Zamknięto próbę w tym widoku. Ewentualny zapis pozostaje w historii; sprawdź ją przed nowym zleceniem.',
                );
              }}
            >
              Zamknij próbę w widoku
            </button>
          </div>
        )}
        {metadata?.available && metadata.current_role === 'admin' && !blocked && (
          <>
            <h3>Źródła rozliczeń i formaty CSV</h3>
            <p>
              Źródło rozliczeń oznacza stały rachunek lub umowę. Zmiana nazwy formatu nie tworzy
              nowej tożsamości tej samej transakcji. Etykiety są lokalne, bez danych dostępu do
              konta.
            </p>
            <div className="pi-buttons">
              <button
                className="button"
                disabled={locked}
                onClick={() => {
                  setNamespaceEditor('new');
                  setEditor(null);
                }}
              >
                <Plus size={16} /> Nowe źródło rozliczeń
              </button>
              <button
                className="button"
                disabled={locked || !metadata.namespaces.some((n) => n.enabled)}
                onClick={() => {
                  setEditor({ serial: crypto.randomUUID() });
                  setNamespaceEditor(null);
                }}
              >
                <Plus size={16} /> Nowy format
              </button>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Źródło rozliczeń</th>
                    <th>Rodzaj</th>
                    <th>Stan / wersja</th>
                    <th>Obsługa</th>
                  </tr>
                </thead>
                <tbody>
                  {metadata.namespaces.map((n) => (
                    <tr key={n.id}>
                      <td>
                        {n.label}
                        <details>
                          <summary>Identyfikator źródła</summary>
                          <small>{n.id}</small>
                        </details>
                      </td>
                      <td>
                        {n.source_kind === 'shared_settlement'
                          ? 'Wspólne rozliczenie bank / kurier'
                          : sourceNames[n.source_kind]}
                      </td>
                      <td>
                        {n.enabled ? 'Aktywna' : 'Wyłączona'} · {n.version}
                      </td>
                      <td>
                        <button
                          className="button"
                          disabled={locked}
                          onClick={() => {
                            setNamespaceEditor(n);
                            setEditor(null);
                          }}
                        >
                          Edytuj etykietę / aktywność
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {namespaceEditor && (
              <NamespaceEditor
                key={
                  typeof namespaceEditor === 'string'
                    ? 'new'
                    : namespaceEditor.id + ':' + namespaceEditor.version
                }
                initial={typeof namespaceEditor === 'string' ? undefined : namespaceEditor}
                locked={locked}
                resetReview={resetReview}
                close={() => setNamespaceEditor(null)}
                save={(body) =>
                  void perform({
                    title: 'Zapis źródła rozliczeń',
                    path:
                      '/payment-imports/namespaces' +
                      (namespaceEditor === 'new' ? '' : '/' + namespaceEditor.id),
                    method: namespaceEditor === 'new' ? 'POST' : 'PUT',
                    body:
                      namespaceEditor === 'new'
                        ? { client_key: crypto.randomUUID(), ...body }
                        : { version: namespaceEditor.version, ...body },
                    financial: false,
                    success: async () => {
                      setNamespaceEditor(null);
                      await loadMetadata();
                    },
                  })
                }
              />
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Format</th>
                    <th>Znaczenie</th>
                    <th>Wersja / definicja</th>
                    <th>Obsługa</th>
                  </tr>
                </thead>
                <tbody>
                  {metadata.data.map((p) => (
                    <tr key={p.id}>
                      <td>{p.definition.name}</td>
                      <td>{modeNames[p.definition.mode]}</td>
                      <td>
                        Wersja {p.version}
                        <details>
                          <summary>Mapowanie</summary>
                          <ProfileDefinition profile={p.definition} />
                        </details>
                      </td>
                      <td>
                        <div className="pi-buttons">
                          <button
                            className="button"
                            disabled={locked}
                            onClick={() => {
                              setEditor({ head: clone(p), serial: crypto.randomUUID() });
                              setNamespaceEditor(null);
                              setArchive(null);
                            }}
                          >
                            Edytuj
                          </button>
                          <button
                            className="button"
                            disabled={locked}
                            onClick={() => {
                              setArchive(clone(p));
                              setArchiveConsent(false);
                              setEditor(null);
                            }}
                          >
                            Archiwizuj
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!metadata.data.length && (
              <p>Brak formatów CSV. Najpierw wybierz lub utwórz źródło rozliczeń.</p>
            )}
            {metadata.meta.cursor && (
              <button
                className="button"
                disabled={loading || saving || !!pending}
                onClick={() => void loadMetadata(metadata.meta.cursor)}
              >
                Więcej formatów
              </button>
            )}
            {editor?.head &&
              metadata.data.some(
                (p) => p.id === editor.head!.id && p.version !== editor.head!.version,
              ) && (
                <p className="error">
                  Ten szkic dotyczy starszej wersji formatu. Zamknij szkic i jawnie otwórz aktualny
                  format z listy; zgoda oraz wersja nie są przenoszone automatycznie.
                </p>
              )}
            {editor && (
              <ProfileEditor
                key={editor.serial}
                initial={editor.head?.definition}
                namespaces={metadata.namespaces.filter(
                  (n) => n.enabled || n.id === editor.head?.definition.source_namespace_id,
                )}
                channels={metadata.channels}
                locked={locked}
                saving={saving}
                resetReview={resetReview}
                error={error}
                save={(definition) =>
                  void perform({
                    title: 'Zapis formatu ' + definition.name,
                    path: '/payment-imports/profiles' + (editor.head ? '/' + editor.head.id : ''),
                    method: editor.head ? 'PUT' : 'POST',
                    body: editor.head
                      ? { version: editor.head.version, definition }
                      : { client_key: crypto.randomUUID(), definition },
                    financial: false,
                    success: async () => {
                      setEditor(null);
                      await loadMetadata();
                    },
                  })
                }
                close={() => setEditor(null)}
              />
            )}
            {archive && (
              <div className="pi-review">
                <h3>Archiwizacja formatu {archive.definition.name}</h3>
                <p>
                  Wersja {archive.version}. Format znika z bieżącego wyboru; pliki, podglądy i
                  rejestr zachowują historię.
                </p>
                <label className="pi-check">
                  <input
                    type="checkbox"
                    checked={archiveConsent}
                    disabled={locked}
                    onChange={(e) => setArchiveConsent(e.target.checked)}
                  />
                  Potwierdzam archiwizację tej wersji formatu.
                </label>
                <button
                  className="button"
                  disabled={locked || !archiveConsent}
                  onClick={() =>
                    void perform({
                      title: 'Archiwizacja formatu ' + archive.id,
                      path: '/payment-imports/profiles/' + archive.id,
                      method: 'DELETE',
                      body: { version: archive.version },
                      financial: false,
                      success: async () => {
                        setArchive(null);
                        await loadMetadata();
                      },
                    })
                  }
                >
                  Zarchiwizuj format
                </button>
                <button className="button" disabled={saving} onClick={() => setArchive(null)}>
                  Zamknij
                </button>
              </div>
            )}
            <h3>Wczytaj własny plik CSV</h3>
            <p>
              Maksymalnie 5 MiB surowych bajtów i 5000 rekordów. Bez pobierania z banku, przewoźnika
              lub URL. Kwoty i daty interpretuje dokładnie wybrany format.
            </p>
            <div className="pi-grid">
              <label>
                Format i wersja
                <select
                  value={profileId}
                  disabled={locked}
                  onChange={(e) => {
                    setProfileId(e.target.value);
                    setUpload(null);
                    setPreview(null);
                    setSelectedRows({});
                    setConsent('');
                    ++previewGeneration.current;
                  }}
                >
                  <option value="">Wybierz jawnie format</option>
                  {metadata.data
                    .filter(
                      (p) =>
                        !p.deleted_at &&
                        metadata.namespaces.some(
                          (n) => n.id === p.definition.source_namespace_id && n.enabled,
                        ),
                    )
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.definition.name} · wersja {p.version} · {modeNames[p.definition.mode]}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Plik
                <input
                  type="file"
                  accept=".csv,text/csv"
                  disabled={locked}
                  onChange={(e) => void chooseFile(e.target.files?.[0])}
                />
              </label>
            </div>
            {activeProfile && <ProfileDefinition profile={activeProfile.definition} />}{' '}
            {file && (
              <div>
                <label>
                  Nazwa lokalnego dowodu (bez zmiany bajtów CSV)
                  <input
                    maxLength={200}
                    value={file.name}
                    disabled={locked}
                    onChange={(e) => {
                      setFile({ ...file, name: e.target.value });
                      setUpload(null);
                      setConsent('');
                    }}
                  />
                </label>
                {fileLabelProblem(file.name) && (
                  <p className="error">{fileLabelProblem(file.name)}</p>
                )}
                <p>
                  Wybrano: {file.name} · {file.bytes.byteLength} bajtów. Plik pozostaje wyłącznie w
                  pamięci do zatwierdzonego lokalnego uploadu.
                </p>
              </div>
            )}
            <button
              className="button primary"
              disabled={locked || !file || !activeProfile || !!fileLabelProblem(file.name)}
              onClick={() => {
                if (!file || !activeProfile || fileLabelProblem(file.name)) return;
                void perform({
                  title:
                    'Upload ' +
                    file.name +
                    ' · ' +
                    file.bytes.byteLength +
                    ' bajtów · ' +
                    activeProfile.definition.name +
                    ' wersja ' +
                    activeProfile.version,
                  path: '/payment-imports/uploads',
                  method: 'POST',
                  body: {
                    client_key: crypto.randomUUID(),
                    profile_id: activeProfile.id,
                    profile_version: activeProfile.version,
                    filename: file.name.trim(),
                    content_base64: bytesBase64(file.bytes),
                  },
                  financial: false,
                  success: (result) => {
                    setUpload(result);
                    setNotice('Zapisano cały lokalny dowód CSV. Nie dopisano płatności.');
                  },
                });
              }}
            >
              <Upload size={16} /> Zapisz lokalny dowód CSV
            </button>
            {upload && (
              <div className="pi-review">
                <p>
                  Zapisany plik: {upload.filename} · {upload.byte_count} bajtów
                </p>
                <details>
                  <summary>Identyfikator i kontrola pliku</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        id: upload.file_id,
                        parser: upload.parser_version,
                        sha256: upload.file_hash,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <button
                  className="button"
                  disabled={locked || !activeProfile}
                  onClick={() => {
                    if (!activeProfile) return;
                    void perform({
                      title: 'Podgląd pliku ' + upload.file_id,
                      path: '/payment-imports/previews',
                      method: 'POST',
                      body: {
                        client_key: crypto.randomUUID(),
                        file_id: upload.file_id,
                        profile_id: activeProfile.id,
                        profile_version: activeProfile.version,
                      },
                      financial: false,
                      success: async (d) => {
                        await openPreview(d.id);
                        await loadHistory('previews');
                      },
                    });
                  }}
                >
                  Przygotuj nowy podgląd z wybranym formatem
                </button>
              </div>
            )}
            {preview && (
              <div className="pi-review">
                <h3>
                  {preview.kind === 'correction' ? 'Podgląd korekty' : 'Podgląd CSV'} · wersja{' '}
                  {preview.version}
                </h3>
                <p>Ważny do {date(preview.expires_at)}. Podgląd nie dopisuje płatności.</p>
                {preview.profile_snapshot && (
                  <details>
                    <summary>
                      Format użyty w tym podglądzie · wersja {preview.profile_version}
                    </summary>
                    <ProfileDefinition profile={preview.profile_snapshot} />
                  </details>
                )}
                <ProfileSummaryTotals
                  summary={preview.summary}
                  correction={preview.kind === 'correction'}
                />
                <p>
                  Wczytano {preview.data.length} z{' '}
                  {Object.values(preview.summary.counts).reduce((n, c) => n + c, 0)} wierszy. Filtr
                  obejmuje wczytane wiersze; kolejne odczytasz przyciskiem poniżej.
                </p>
                <div className="pi-buttons">
                  <label>
                    Filtr klasyfikacji
                    <select
                      value={classification}
                      disabled={saving || !!pending}
                      onChange={(e) => setClassification(e.target.value as Classification | 'all')}
                    >
                      <option value="all">Wszystkie</option>
                      {Object.entries(classificationNames).map(([k, n]) => (
                        <option key={k} value={k}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button"
                    disabled={loading || saving || !!pending}
                    onClick={() => void openPreview(preview.id)}
                  >
                    Odczytaj ponownie podgląd (reset wyboru)
                  </button>
                </div>
                {preview.data
                  .filter((r) => classification === 'all' || r.classification === classification)
                  .map((row) => (
                    <article className="pi-row" key={row.row_id}>
                      <label className="pi-check">
                        <input
                          type="checkbox"
                          checked={!!selectedRows[row.row_id]}
                          disabled={
                            locked ||
                            row.classification !== 'ready' ||
                            (!selectedRows[row.row_id] && selection.length >= 100)
                          }
                          onChange={(e) => selectRow(row, e.target.checked)}
                        />
                        Jawnie wybierz wiersz {row.position + 1} do lokalnego wykonania
                      </label>
                      <RowEvidence row={row} />
                      {preview.kind !== 'correction' && row.operation === 'apply' && (
                        <button
                          className="button"
                          disabled={locked || loading || !row.source.normalized}
                          onClick={() => {
                            if (locked || loading) return;
                            setConsent('');
                            setSelectedRows({});
                            setAllocationSource({
                              previewId: preview.id,
                              rowId: row.row_id,
                              position: row.position,
                            });
                          }}
                        >
                          Podziel tę wpłatę na kilka zamówień
                        </button>
                      )}
                      {['unmatched', 'ambiguous', 'review'].includes(row.classification) &&
                        row.operation !== 'reverse' && (
                          <ResolveRow
                            key={preview.id + ':' + row.row_id}
                            row={row}
                            previewId={preview.id}
                            disabled={locked}
                            onError={failure}
                            submit={(resolution) =>
                              void perform({
                                title: 'Nowy podgląd po uzgodnieniu wiersza ' + row.row_id,
                                path: '/payment-imports/previews/' + preview.id + '/resolve',
                                method: 'POST',
                                body: {
                                  client_key: crypto.randomUUID(),
                                  version: preview.version,
                                  resolutions: [resolution],
                                },
                                financial: false,
                                success: async (d) => {
                                  await openPreview(d.id);
                                  await loadHistory('previews');
                                },
                              })
                            }
                          />
                        )}
                    </article>
                  ))}
                {preview.meta.cursor && (
                  <button
                    className="button"
                    disabled={loading || saving || !!pending}
                    onClick={() => void openPreview(preview.id, preview.meta.cursor)}
                  >
                    Kolejne wiersze podglądu
                  </button>
                )}
                <SelectionReview rows={selection} />
                <p>
                  Poza wyborem:{' '}
                  {Object.values(preview.summary.counts).reduce((n, c) => n + c, 0) -
                    selection.length}{' '}
                  wierszy. Wyjątki w całym podglądzie:{' '}
                  {Object.entries(preview.summary.counts).reduce(
                    (n, [k, c]) => n + (k === 'ready' ? 0 : c),
                    0,
                  )}
                  .
                </p>
                {selectionProblem && <p className="notice">{selectionProblem}</p>}
                {expired && (
                  <p className="error">
                    Podgląd wygasł. Przygotuj nowy podgląd; zgoda nie zostanie przeniesiona.
                  </p>
                )}
                {preview.kind === 'correction' &&
                  selection.length !==
                    Object.values(preview.summary.counts).reduce((n, c) => n + c, 0) && (
                    <p className="notice">
                      Korekta obejmuje wszystkie zamrożone wpisy. Odczytaj kolejne strony i zaznacz
                      każdy z nich; nie odwracamy niezaznaczonych zależności.
                    </p>
                  )}
                <label className="pi-check">
                  <input
                    type="checkbox"
                    checked={consent === selectionFence && !!consent}
                    disabled={locked || loading || expired || !!selectionProblem}
                    onChange={(e) => setConsent(e.target.checked ? selectionFence : '')}
                  />
                  Sprawdziłem każdy wybrany wiersz, kwoty i powiązania. Potwierdzam lokalny zapis
                  rejestru płatności oraz ewentualne new→paid po pokryciu należności. Nie zlecam
                  transferu/refundu, SMS/email, dostawcy ani zmiany magazynu. Korekta nie cofa
                  realizacji zamówienia.
                </label>
                <button
                  className="button primary"
                  disabled={
                    locked ||
                    loading ||
                    expired ||
                    !!selectionProblem ||
                    consent !== selectionFence ||
                    !consent ||
                    (preview.kind === 'correction' &&
                      selection.length !==
                        Object.values(preview.summary.counts).reduce((n, c) => n + c, 0))
                  }
                  onClick={queuePreview}
                >
                  {preview.kind === 'correction'
                    ? 'Zleć zatwierdzoną korektę'
                    : 'Zleć lokalny zapis wybranych ' + selection.length + ' wierszy'}
                </button>
                <p>
                  Konflikt jednego wybranego wiersza blokuje całe wykonanie. Wiersze poza wyborem
                  nie są księgowane.
                </p>
              </div>
            )}
            {execution && (
              <div className="pi-execution">
                <h3>{executionNames[execution.state] ?? execution.state}</h3>
                <p>
                  {execution.selected_count} zatwierdzonych wierszy · Suma kwot wpisów:{' '}
                  {minorMoney(execution.total_minor, execution.currency)} · prowizja{' '}
                  {minorMoney(execution.fee_minor, execution.currency)}
                </p>
                {execution.kind === 'correction' && (
                  <p>
                    Korekta obejmuje {execution.selected_count} wpisów. Pobranie i przekazanie
                    środków są różnymi etapami rozliczenia; ich suma nie oznacza zwrotu klientowi.
                    Nie zlecono zwrotu bankowego.
                  </p>
                )}
                {execution.error && <p className="error">{execution.error}</p>}
                <ExecutionOutcome execution={execution} />
                <p>
                  Zapisane dowody rozliczenia poniżej przedstawiają wynik lokalnego zapisu, bez
                  potwierdzenia banku lub przewoźnika.
                </p>
                <div className="pi-buttons">
                  <button
                    className="button"
                    disabled={loading || saving || !!pending}
                    onClick={() => void openExecution(execution.id)}
                  >
                    Odczytaj rzeczywisty wynik
                  </button>
                  {execution.state === 'queued' && (
                    <button
                      className="button"
                      disabled={locked}
                      onClick={() =>
                        void perform({
                          title: 'Anulowanie niewykonanego zakresu ' + execution.id,
                          path: '/payment-imports/executions/' + execution.id + '/cancel',
                          method: 'POST',
                          body: { client_key: crypto.randomUUID() },
                          financial: false,
                          success: async () => {
                            await openExecution(execution.id);
                            await loadHistory('executions');
                          },
                        })
                      }
                    >
                      Anuluj, jeśli lokalny zapis jeszcze nie rozpoczął się
                    </button>
                  )}
                </div>
                {execution.data.map((r) => (
                  <article className="pi-row" key={r.row_id}>
                    <RowEvidence row={r} executionState={execution.state} />
                  </article>
                ))}
                {execution.meta.cursor && (
                  <button
                    className="button"
                    disabled={loading || saving || !!pending}
                    onClick={() => void openExecution(execution.id, execution.meta.cursor)}
                  >
                    Kolejne wiersze i dowody rozliczenia
                  </button>
                )}
              </div>
            )}
            <h3>Historia trwałych zakresów</h3>
            <div className="pi-buttons">
              <button
                className="button"
                disabled={loading || saving || !!pending}
                onClick={() => void loadHistory('previews')}
              >
                Odczytaj historię podglądów
              </button>
              <button
                className="button"
                disabled={loading || saving || !!pending}
                onClick={() => void loadHistory('executions')}
              >
                Odczytaj historię wykonań
              </button>
              <button
                className="button"
                disabled={locked}
                onClick={() => setCorrectionOpen((v) => !v)}
              >
                Przygotuj korektę zapisanych dowodów rozliczenia
              </button>
            </div>
            {previewHistory && (
              <>
                <div className="pi-history">
                  {previewHistory.data.map((p) => (
                    <button
                      className="button"
                      key={p.id}
                      disabled={loading || saving || !!pending}
                      onClick={() => void openPreview(p.id)}
                    >
                      {p.created_at ? date(p.created_at) : p.id} ·{' '}
                      {p.kind === 'correction' ? 'Korekta' : 'CSV'} · wersja {p.version} ·{' '}
                      {Object.values(p.summary.counts).reduce((n, c) => n + c, 0)} wierszy
                    </button>
                  ))}
                </div>
                {previewHistory.meta.cursor && (
                  <button
                    className="button"
                    disabled={loading || saving || !!pending}
                    onClick={() => void loadHistory('previews', previewHistory.meta.cursor)}
                  >
                    Starsze podglądy
                  </button>
                )}
              </>
            )}
            {executionHistory && (
              <>
                <div className="pi-history">
                  {executionHistory.data.map((x) => (
                    <button
                      className="button"
                      key={x.id}
                      disabled={loading || saving || !!pending}
                      onClick={() => void openExecution(x.id)}
                    >
                      {date(x.created_at)} · {x.kind === 'correction' ? 'Korekta' : 'Import'} ·{' '}
                      {executionNames[x.state] ?? x.state} · {x.selected_count} wierszy · suma
                      wpisów: {minorMoney(x.total_minor, x.currency)}
                    </button>
                  ))}
                </div>
                {executionHistory.meta.cursor && (
                  <button
                    className="button"
                    disabled={loading || saving || !!pending}
                    onClick={() => void loadHistory('executions', executionHistory.meta.cursor)}
                  >
                    Starsze wykonania
                  </button>
                )}
              </>
            )}
            {correctionOpen && (
              <CorrectionPreview
                disabled={locked}
                onError={failure}
                submit={(receiptIds, reason) =>
                  void perform({
                    title:
                      'Nowy podgląd korekty ' +
                      receiptIds.length +
                      ' wybranych dowodów rozliczenia',
                    path: '/payment-imports/corrections/preview',
                    method: 'POST',
                    body: { client_key: crypto.randomUUID(), receipt_ids: receiptIds, reason },
                    financial: false,
                    success: async (d) => {
                      setCorrectionOpen(false);
                      await openPreview(d.id);
                      await loadHistory('previews');
                    },
                  })
                }
              />
            )}
          </>
        )}
        <PaymentImportAllocationsPanel
          contextKey={contextKey}
          readOnly={readOnly}
          source={allocationSource}
          onSourceSelected={(selected) => {
            if (locked) return;
            setConsent('');
            setSelectedRows({});
            setAllocationSource(selected);
          }}
          externalWriteBlocked={!canWrite || saving || !!pending}
          onError={onError}
          onApplied={() => {
            setConsent('');
            setSelectedRows({});
            setNotice(
              'Podział zapisano. Odczytaj ponownie źródłowy podgląd przed kolejnym wykonaniem importu.',
            );
          }}
        />
      </div>
    </section>
  );
}

function NamespaceEditor({
  initial,
  locked,
  resetReview,
  save,
  close,
}: {
  initial?: Namespace;
  locked: boolean;
  resetReview: number;
  save: (body: {
    label: string;
    source_kind?: Namespace['source_kind'];
    enabled?: boolean;
  }) => void;
  close: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? ''),
    [sourceKind, setSourceKind] = useState<Namespace['source_kind']>('bank_statement'),
    [enabled, setEnabled] = useState(initial?.enabled ?? true),
    [reviewed, setReviewed] = useState(false);
  useEffect(() => {
    setReviewed(false);
  }, [locked, resetReview]);
  return (
    <form
      className="pi-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked && reviewed && label.trim())
          save(initial ? { label, enabled } : { label, source_kind: sourceKind });
      }}
    >
      <h3>
        {initial
          ? 'Nazwa i aktywność źródła rozliczeń'
          : 'Nowe źródło rozliczeń: rachunek lub umowa'}
      </h3>
      <p>
        Wybierz istniejące źródło rozliczeń dla kolejnego formatu tego samego rozliczenia. Nowe
        źródło twórz tylko dla odrębnej tożsamości transakcji; nie służy do pomijania duplikatów.
      </p>
      <fieldset disabled={locked}>
        <div className="pi-grid">
          <label>
            Maskowana lokalna etykieta
            <input
              required
              maxLength={120}
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setReviewed(false);
              }}
              placeholder="np. Rachunek firmowy …1234"
            />
          </label>
          {initial ? (
            <label className="pi-check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  setEnabled(e.target.checked);
                  setReviewed(false);
                }}
              />
              Źródło aktywne
            </label>
          ) : (
            <label>
              Rodzaj tożsamości
              <select
                value={sourceKind}
                onChange={(e) => {
                  setSourceKind(e.target.value as Namespace['source_kind']);
                  setReviewed(false);
                }}
              >
                <option value="bank_statement">Rachunek bankowy</option>
                <option value="carrier_report">Umowa / raport przewoźnika</option>
                <option value="shared_settlement">Wspólne rozliczenie banku i przewoźnika</option>
              </select>
            </label>
          )}
        </div>
      </fieldset>
      <label className="pi-check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={locked}
          onChange={(e) => setReviewed(e.target.checked)}
        />
        Sprawdziłem stałą tożsamość domeny. Etykieta nie zawiera hasła, tokenu ani danych dostępu.
      </label>
      <div className="pi-buttons">
        <button className="button primary" disabled={locked || !reviewed || !label.trim()}>
          Zapisz źródło rozliczeń
        </button>
        <button type="button" className="button" onClick={close}>
          Zamknij
        </button>
      </div>
    </form>
  );
}
function SelectionReview({ rows }: { rows: PreviewRow[] }) {
  const totals = new Map<
    string,
    { currency: string; kind: string; amount: bigint; fee: bigint; count: number }
  >();
  let linked = 0;
  for (const row of rows) {
    if (row.operation === 'link_existing') {
      linked++;
      continue;
    }
    const n = row.source.normalized;
    if (!n) continue;
    const key = n.currency + ':' + n.ledger_kind;
    const old = totals.get(key) ?? {
      currency: n.currency,
      kind: n.ledger_kind,
      amount: 0n,
      fee: 0n,
      count: 0,
    };
    old.amount += BigInt(n.amount_minor);
    old.fee += BigInt(n.fee_minor);
    old.count++;
    totals.set(key, old);
  }
  return (
    <div className="pi-review">
      <h4>Dokładnie wybrane wiersze: {rows.length} / 100</h4>
      <p>
        Powiązania istniejących dowodów bez nowej wpłaty: {linked}. Kwoty poniżej dotyczą tylko
        zaznaczonych operacji; dla korekty pokazują wpisy do odwrócenia.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Waluta / rodzaj</th>
              <th>Wiersze</th>
              <th>Kwota dowodu</th>
              <th>Prowizja dowodu</th>
            </tr>
          </thead>
          <tbody>
            {[...totals.values()].map((t) => (
              <tr key={t.currency + ':' + t.kind}>
                <td>
                  {t.currency} · {paymentKindName(t.kind)}
                </td>
                <td>{t.count}</td>
                <td>{minorMoney(t.amount.toString(), t.currency)}</td>
                <td>{minorMoney(t.fee.toString(), t.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>Sprawdź każdy wybrany wiersz i powiązanie</summary>
        {rows.map((r) => (
          <article className="pi-row" key={r.row_id}>
            <p>Wiersz {r.position + 1}</p>
            <RowEvidence row={r} />
          </article>
        ))}
      </details>
    </div>
  );
}
type OrderChoice = { id: string; number: string; customer_name?: string; currency?: string };
type OrderEvidence = OrderChoice & {
  shipments: {
    id: string;
    carrier: string;
    tracking_number: string;
    cod_expected?: number;
    dispatched_at?: string | null;
  }[];
  payment?: unknown;
};
function ResolveRow({
  row,
  previewId,
  disabled,
  onError,
  submit,
}: {
  row: PreviewRow;
  previewId: string;
  disabled: boolean;
  onError: (e: unknown) => void;
  submit: (
    resolution:
      | { row_id: string; action: 'assign'; order_id: string; shipment_id?: string; reason: string }
      | { row_id: string; action: 'link_existing_receipt'; receipt_id: string; reason: string },
  ) => void;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(''),
    [orders, setOrders] = useState<OrderChoice[]>([]),
    [orderId, setOrderId] = useState(''),
    [order, setOrder] = useState<OrderEvidence | null>(null),
    [shipmentId, setShipmentId] = useState(''),
    [action, setAction] = useState<'assign' | 'link_existing_receipt'>('assign'),
    [receipts, setReceipts] = useState<PageData<Receipt> | null>(null),
    [receiptId, setReceiptId] = useState(''),
    [reason, setReason] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++generation.current;
    };
  }, [previewId, row.row_id]);
  useEffect(() => {
    setReviewed(false);
  }, [disabled]);
  const cod =
    !!row.source.normalized &&
    ['courier_collection', 'courier_remittance'].includes(row.source.normalized.ledger_kind);
  function fail(e: unknown) {
    setError((e as Error).message);
    onError(e);
    setReviewed(false);
  }
  async function findOrders() {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const d = await api<{ data: OrderChoice[] }>(
        '/orders?limit=20&search=' + encodeURIComponent(search),
      );
      if (alive.current && current === generation.current) setOrders(d.data);
    } catch (e) {
      if (alive.current && (current === generation.current || sensitiveApiFailure(e))) fail(e);
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }
  async function chooseOrder(id: string, explicitShipment?: string) {
    const current = ++generation.current;
    setOrderId(id);
    setOrder(null);
    setShipmentId('');
    setReceipts(null);
    setReceiptId('');
    setReviewed(false);
    setLoading(true);
    setError('');
    try {
      const d = await api<OrderEvidence>('/orders/' + id);
      if (!alive.current || current !== generation.current) return;
      setOrder(d);
      if (explicitShipment && d.shipments.some((s) => s.id === explicitShipment))
        setShipmentId(explicitShipment);
    } catch (e) {
      if (alive.current && (current === generation.current || sensitiveApiFailure(e))) fail(e);
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }
  async function loadReceipts(cursor?: string | null) {
    if (!order) return;
    const current = ++generation.current;
    setLoading(true);
    setReviewed(false);
    try {
      const d = await api<PageData<Receipt>>(
        '/payment-imports/receipts?order_id=' +
          encodeURIComponent(order.id) +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      );
      if (!alive.current || current !== generation.current) return;
      if (!d.available || d.current_role !== 'admin')
        throw new ApiError('Dostęp do dowodów płatności jest niedostępny', 403);
      if (d.read_only) throw new ApiError('Kopia tylko do odczytu', 423);
      setReceipts((old) => ({
        ...d,
        data: cursor ? mergeIds(old?.data ?? [], d.data, (r) => r.id) : d.data,
      }));
    } catch (e) {
      if (alive.current && (current === generation.current || sensitiveApiFailure(e))) fail(e);
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }
  const valid =
    action === 'assign'
      ? !!order && (!cod || !!shipmentId)
      : !!receiptId && !!receipts?.data.some((r) => r.id === receiptId);
  return (
    <div>
      <button className="button" disabled={disabled || loading} onClick={() => setOpen((v) => !v)}>
        {open
          ? 'Zamknij uzgodnienie'
          : 'Uzgodnij jawnie dopasowanie / istniejący dowód rozliczenia'}
      </button>
      {open && (
        <div className="pi-review">
          <h4>Uzgodnienie nie omija waluty, limitów COD ani duplikatów</h4>
          {error && <p className="error">{error}</p>}
          <div className="pi-buttons">
            {row.evidence.candidates.map((c, i) => (
              <button
                className="button"
                key={c.id + ':' + (c.shipment_id ?? '') + ':' + i}
                disabled={disabled || loading}
                onClick={() => void chooseOrder(c.id, c.shipment_id)}
              >
                Wybierz kandydata {c.number}
                {c.tracking_number ? ' · ' + c.tracking_number : ''}
              </button>
            ))}
          </div>
          {row.evidence.more && (
            <p className="notice">
              Więcej kandydatów niż pokazane maksimum 5. Doprecyzuj własne zamówienie; nie wybieramy
              pierwszego automatycznie.
            </p>
          )}
          <div className="pi-grid">
            <label>
              Szukaj własnego numeru zamówienia
              <input
                maxLength={200}
                value={search}
                disabled={disabled || loading}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setReviewed(false);
                }}
              />
            </label>
            <button
              className="button"
              disabled={disabled || loading || !search.trim()}
              onClick={() => void findOrders()}
            >
              Wyszukaj lokalnie (maks. 20)
            </button>
          </div>
          <div className="pi-buttons">
            {orders.map((o) => (
              <button
                className="button"
                key={o.id}
                disabled={disabled || loading}
                onClick={() => void chooseOrder(o.id)}
              >
                Wybierz {o.number} · {o.customer_name}
              </button>
            ))}
          </div>
          <div className="pi-grid">
            <label>
              Dokładny UUID własnego zamówienia
              <input
                value={orderId}
                disabled={disabled || loading}
                onChange={(e) => {
                  setOrderId(e.target.value);
                  setOrder(null);
                  setShipmentId('');
                  setReceiptId('');
                  setReviewed(false);
                }}
              />
            </label>
            <button
              className="button"
              disabled={disabled || loading || !/^[0-9a-f-]{36}$/i.test(orderId)}
              onClick={() => void chooseOrder(orderId)}
            >
              Odczytaj wskazane zamówienie
            </button>
          </div>
          {order && (
            <>
              <p>
                Wybrano jawnie: {order.number} · {order.currency}
              </p>
              <details>
                <summary>Bieżące lokalne saldo (nowy podgląd zamrozi je ponownie)</summary>
                <pre>{JSON.stringify(order.payment, null, 2)}</pre>
              </details>
              <div className="pi-grid">
                <label>
                  Rodzaj uzgodnienia
                  <select
                    value={action}
                    disabled={disabled || loading}
                    onChange={(e) => {
                      setAction(e.target.value as typeof action);
                      setReviewed(false);
                    }}
                  >
                    <option value="assign">Przypisz własne zamówienie / przesyłkę</option>
                    <option value="link_existing_receipt">
                      Powiąż już istniejący dowód rozliczenia — bez nowej wpłaty
                    </option>
                  </select>
                </label>
                {action === 'assign' && (cod || order.shipments.length > 0) && (
                  <label>
                    Dokładna przesyłka (dla COD wymagana)
                    <select
                      value={shipmentId}
                      disabled={disabled || loading}
                      required={cod}
                      onChange={(e) => {
                        setShipmentId(e.target.value);
                        setReviewed(false);
                      }}
                    >
                      <option value="">Wybierz jawnie, bez domyślnej pierwszej</option>
                      {order.shipments.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.carrier} · {s.tracking_number}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {action === 'link_existing_receipt' && (
                <>
                  <button
                    className="button"
                    disabled={disabled || loading}
                    onClick={() => void loadReceipts()}
                  >
                    Odczytaj zapisane dowody rozliczenia tego zamówienia
                  </button>
                  {receipts && (
                    <>
                      <label>
                        Dokładny istniejący dowód
                        <select
                          value={receiptId}
                          disabled={disabled || loading}
                          onChange={(e) => {
                            setReceiptId(e.target.value);
                            setReviewed(false);
                          }}
                        >
                          <option value="">Wybierz jawnie</option>
                          {receipts.data.map((r, i) => (
                            <option key={r.id} value={r.id}>
                              Dowód {i + 1} · {r.order_number ?? order.number} ·{' '}
                              {paymentKindName(r.kind)} · {minorMoney(r.amount, r.currency)} ·
                              prowizja {minorMoney(r.fee, r.currency)} · {r.booking_date}
                              {r.reversed ? ' · skorygowany' : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      {receiptId && (
                        <details>
                          <summary>Identyfikatory wybranego dowodu</summary>
                          <small>Dowód: {receiptId}</small>
                          <small>Zamówienie: {order.id}</small>
                        </details>
                      )}
                      {receipts.meta.cursor && (
                        <button
                          className="button"
                          disabled={disabled || loading}
                          onClick={() => void loadReceipts(receipts.meta.cursor)}
                        >
                          Kolejne dowody rozliczenia zamówienia
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
          <label>
            Powód jawnego wyboru
            <input
              required
              maxLength={2000}
              value={reason}
              disabled={disabled || loading}
              onChange={(e) => {
                setReason(e.target.value);
                setReviewed(false);
              }}
            />
          </label>
          <label className="pi-check">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={disabled || loading || !valid || !reason.trim()}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            Sprawdziłem źródłowy dowód i dokładne własne powiązanie. Chcę nowego podglądu; to
            uzgodnienie nie dopisuje płatności.
          </label>
          <button
            className="button primary"
            disabled={disabled || loading || !valid || !reviewed || !reason.trim()}
            onClick={() =>
              submit(
                action === 'assign'
                  ? {
                      row_id: row.row_id,
                      action,
                      order_id: order!.id,
                      ...(shipmentId ? { shipment_id: shipmentId } : {}),
                      reason,
                    }
                  : { row_id: row.row_id, action, receipt_id: receiptId, reason },
              )
            }
          >
            Zapisz uzgodnienie i przygotuj nowy podgląd
          </button>
        </div>
      )}
    </div>
  );
}
function CorrectionPreview({
  disabled,
  onError,
  submit,
}: {
  disabled: boolean;
  onError: (e: unknown) => void;
  submit: (ids: string[], reason: string) => void;
}) {
  const [receipts, setReceipts] = useState<PageData<Receipt> | null>(null),
    [selection, setSelection] = useState<Record<string, Receipt>>({}),
    [orderFilter, setOrderFilter] = useState(''),
    [reason, setReason] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const alive = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++generation.current;
    };
  }, []);
  useEffect(() => {
    setReviewed(false);
  }, [disabled]);
  async function load(cursor?: string | null) {
    const current = ++generation.current;
    setLoading(true);
    setReviewed(false);
    if (!cursor) {
      setSelection({});
      setReceipts(null);
    }
    try {
      const path =
        '/payment-imports/receipts' +
        (cursor || orderFilter ? '?' : '') +
        (orderFilter ? 'order_id=' + encodeURIComponent(orderFilter) : '') +
        (cursor ? (orderFilter ? '&' : '') + 'cursor=' + encodeURIComponent(cursor) : '');
      const d = await api<PageData<Receipt>>(path);
      if (!alive.current || current !== generation.current) return;
      if (!d.available || d.current_role !== 'admin')
        throw new ApiError('Dowody rozliczenia wymagają aktualnego administratora', 403);
      setReceipts((old) => ({
        ...d,
        data: cursor ? mergeIds(old?.data ?? [], d.data, (r) => r.id) : d.data,
      }));
    } catch (e) {
      if (alive.current && (current === generation.current || sensitiveApiFailure(e))) {
        setError((e as Error).message);
        onError(e);
      }
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }
  const rows = Object.values(selection),
    oneCurrency = new Set(rows.map((r) => r.currency)).size === 1;
  return (
    <div className="pi-review">
      <h3>Nowy plan korekty</h3>
      <p>
        Korekta dopisuje lokalne wpisy odwracające dokładnie wskazane dowody rozliczenia. Nie usuwa
        importu ani blokady duplikatu, nie wykonuje zwrotu bankowego i nie przywraca wcześniejszego
        statusu realizacji. Powiązane pobranie i przekazanie środków trzeba wybrać jawnie; system
        sprawdzi całą paczkę.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="pi-grid">
        <details>
          <summary>Filtr zaawansowany</summary>
          <label>
            Opcjonalnie UUID własnego zamówienia
            <input
              value={orderFilter}
              disabled={disabled || loading}
              onChange={(e) => {
                setOrderFilter(e.target.value);
                setReceipts(null);
                setSelection({});
                setReviewed(false);
                ++generation.current;
              }}
            />
          </label>
        </details>
        <button
          className="button"
          disabled={disabled || loading || (!!orderFilter && !/^[0-9a-f-]{36}$/i.test(orderFilter))}
          onClick={() => void load()}
        >
          Odczytaj zapisane dowody rozliczenia
        </button>
      </div>
      {receipts && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Wybór</th>
                  <th>Dowód rozliczenia</th>
                  <th>Kwota / prowizja</th>
                  <th>Rodzaj i data</th>
                </tr>
              </thead>
              <tbody>
                {receipts.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={'Wybierz dowód rozliczenia ' + r.id}
                        checked={!!selection[r.id]}
                        disabled={
                          disabled ||
                          loading ||
                          r.reversed ||
                          r.operation === 'reverse' ||
                          (!selection[r.id] && rows.length >= 100)
                        }
                        onChange={(e) => {
                          setReviewed(false);
                          const checked = e.target.checked;
                          setSelection((old) => {
                            const next = { ...old };
                            if (checked) next[r.id] = r;
                            else delete next[r.id];
                            return next;
                          });
                        }}
                      />
                    </td>
                    <td>
                      {r.order_number
                        ? 'Zamówienie ' + r.order_number
                        : 'Numer zamówienia niedostępny'}
                      <small>Dowód z {r.booking_date}</small>
                      {r.operation === 'reverse' ? (
                        <small>Wpis korekty — nie można odwrócić ponownie</small>
                      ) : (
                        r.reversed && <small>Skorygowany — nie można odwrócić ponownie</small>
                      )}
                      <details>
                        <summary>Powiązania dowodu</summary>
                        <small>Dowód: {r.id}</small>
                        <small>Zamówienie: {r.order_id}</small>
                        <small>Wpis: {r.entry_id}</small>
                      </details>
                    </td>
                    <td>
                      {minorMoney(r.amount, r.currency)}
                      <small>Prowizja: {minorMoney(r.fee, r.currency)}</small>
                    </td>
                    <td>
                      {paymentKindName(r.kind)} ·{' '}
                      {operationNames[r.operation as keyof typeof operationNames] ?? r.operation}
                      <small>{r.booking_date}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {receipts.meta.cursor && (
            <button
              className="button"
              disabled={disabled || loading}
              onClick={() => void load(receipts.meta.cursor)}
            >
              Starsze dowody rozliczenia
            </button>
          )}
        </>
      )}
      <p>
        Wybrano dokładnie {rows.length} dowodów rozliczenia / 100.{' '}
        {rows.length > 0 && !oneCurrency ? 'Wybór wymaga jednej waluty.' : ''}
      </p>
      <details>
        <summary>Sprawdź dokładny zakres korekty</summary>
        <pre>{JSON.stringify(rows, null, 2)}</pre>
      </details>
      <label>
        Powód korekty
        <input
          required
          maxLength={2000}
          value={reason}
          disabled={disabled || loading}
          onChange={(e) => {
            setReason(e.target.value);
            setReviewed(false);
          }}
        />
      </label>
      <label className="pi-check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={disabled || loading || !rows.length || !oneCurrency || !reason.trim()}
          onChange={(e) => setReviewed(e.target.checked)}
        />
        Sprawdziłem dokładnie wybrane receipts i powód. Przygotuj podgląd; zapis korekty będzie
        wymagał osobnej zgody.
      </label>
      <button
        className="button primary"
        disabled={
          disabled ||
          loading ||
          !rows.length ||
          rows.length > 100 ||
          !oneCurrency ||
          !reviewed ||
          !reason.trim()
        }
        onClick={() => submit(rows.map((r) => r.id).sort(), reason)}
      >
        Przygotuj zamrożony podgląd korekty
      </button>
    </div>
  );
}
