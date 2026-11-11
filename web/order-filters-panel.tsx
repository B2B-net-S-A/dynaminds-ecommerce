/**
 * Filter panel above the order list (Uwagi v3 §3): four rows of fields, all visible at once, applied
 * on "Filtruj" or Enter. Visibility and filter templates are remembered per user in this browser.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { fulfilmentLabels, paymentLabels, type FulfilmentStage, type PaymentState } from './order-stage';
import {
  activeFilterCount,
  addTemplate,
  deliveryLabels,
  emptyFilters,
  filterProblems,
  ordersStorageKey,
  parseTemplates,
  readStored,
  removeTemplate,
  sameFilters,
  writeStored,
  type FilterTemplate,
  type OrderFilters,
  type YesNo,
} from './order-filters';
import './order-filters.css';

export interface OrderFilterOptions {
  channels: string[];
  currencies: string[];
  delivery_methods: string[];
  /** Shop methods with cash on delivery variants and the channels' own methods, labelled. */
  delivery_options?: { value: string; label: string }[];
  delivery_available: boolean;
}

/** Stages in the order of the client's "Statusy" sheet. */
const STATUS_ORDER: FulfilmentStage[] = [
  'new',
  'paid',
  'picking',
  'packed',
  'ready_to_ship',
  'shipped',
  'delivered',
  'completed',
  'return_initiated',
  'return_received',
  'return_completed',
  'cancelled',
];
const statusLabel = (s: FulfilmentStage) => (s === 'new' ? 'Nieopłacone (czeka na wpłatę)' : fulfilmentLabels[s]);

interface Option {
  value: string;
  label: string;
}

function MultiSelect({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: Option[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const chosen = options.filter((o) => value.includes(o.value));
  const summary = !chosen.length ? 'Wszystkie' : chosen.length <= 2 ? chosen.map((o) => o.label).join(', ') : `Wybrano ${chosen.length}`;
  return (
    <div className="of-field" ref={root}>
      <span className="of-label" id={id}>
        {label}
      </span>
      <button
        type="button"
        className={'of-multi' + (chosen.length ? ' has-value' : '')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={id}
        disabled={disabled}
        title={chosen.map((o) => o.label).join(', ')}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      >
        <span>{summary}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="of-menu" role="listbox" aria-multiselectable="true" aria-labelledby={id} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          {options.length ? (
            options.map((o) => (
              <label key={o.value} className="of-check">
                <input
                  type="checkbox"
                  checked={value.includes(o.value)}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...value, o.value] : value.filter((v) => v !== o.value))
                  }
                />
                {o.label}
              </label>
            ))
          ) : (
            <p className="of-empty">Brak wartości w danych</p>
          )}
          {value.length > 0 && (
            <button type="button" className="text-button" onClick={() => onChange([])}>
              Wyczyść wybór
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Text({
  label,
  value,
  onChange,
  max,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  placeholder?: string;
  inputMode?: 'text' | 'tel' | 'email' | 'numeric';
}) {
  return (
    <label className="of-field">
      <span className="of-label">{label}</span>
      <input value={value} maxLength={max} placeholder={placeholder} inputMode={inputMode} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Range({
  label,
  from,
  to,
  onChange,
  kind,
}: {
  label: string;
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  kind: 'date' | 'money';
}) {
  const id = useId();
  const input = (value: string, set: (v: string) => void, part: string) =>
    kind === 'date' ? (
      <input type="date" value={value} aria-label={`${label} ${part}`} onChange={(e) => set(e.target.value)} />
    ) : (
      <input inputMode="decimal" value={value} maxLength={14} placeholder={part} aria-label={`${label} ${part}`} onChange={(e) => set(e.target.value)} />
    );
  return (
    <div className="of-field" role="group" aria-labelledby={id}>
      <span className="of-label" id={id}>
        {label}
      </span>
      <div className="of-range">
        {input(from, (v) => onChange(v, to), 'od')}
        <span aria-hidden="true">–</span>
        {input(to, (v) => onChange(from, v), 'do')}
      </div>
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <label className="of-field">
      <span className="of-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

const yesNo: [YesNo, string][] = [
  ['', 'Wszystkie'],
  ['yes', 'Tak'],
  ['no', 'Nie'],
];

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="of-row">
      <legend>{title}</legend>
      <div className="of-grid">{children}</div>
    </fieldset>
  );
}

function TemplatesMenu({
  templates,
  onPick,
  onSave,
  onDelete,
  saveDisabled,
}: {
  templates: FilterTemplate[];
  onPick: (t: FilterTemplate) => void;
  onSave: (name: string) => boolean;
  onDelete: (id: string) => void;
  saveDisabled: boolean;
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(''),
    [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="of-templates" ref={root} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
        Szablony filtrów <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="of-menu of-menu-right" role="menu">
          {templates.length ? (
            <ul className="of-template-list">
              {templates.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    role="menuitem"
                    className="of-template-pick"
                    onClick={() => {
                      onPick(t);
                      setOpen(false);
                    }}
                  >
                    {t.name}
                  </button>
                  <button type="button" className="icon-btn" aria-label={'Usuń szablon ' + t.name} onClick={() => onDelete(t.id)}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="of-empty">Nie masz jeszcze szablonów.</p>
          )}
          {saving ? (
            <div className="of-template-save">
              <input
                autoFocus
                aria-label="Nazwa szablonu"
                placeholder="Nazwa szablonu"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (name.trim() && onSave(name)) {
                      setName('');
                      setSaving(false);
                    }
                  }
                }}
              />
              <button
                type="button"
                className="button primary small-btn"
                disabled={!name.trim()}
                onClick={() => {
                  if (onSave(name)) {
                    setName('');
                    setSaving(false);
                  }
                }}
              >
                Zapisz
              </button>
            </div>
          ) : (
            <button type="button" className="text-button" disabled={saveDisabled} onClick={() => setSaving(true)}>
              Zapisz bieżące filtry jako szablon…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function OrderFiltersPanel({
  value,
  onApply,
  options,
  contextKey,
  sourceLabel,
  disabled = false,
}: {
  /** Applied filters; the panel edits a draft until "Filtruj". */
  value: OrderFilters;
  onApply: (f: OrderFilters) => void;
  options: OrderFilterOptions | null;
  /** "tenant:user:role": visibility and templates are stored per user. */
  contextKey: string;
  sourceLabel: (source: string) => string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<OrderFilters>(value);
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const appliedKey = JSON.stringify(value);
  useEffect(() => {
    setDraft(value);
    setProblems([]);
  }, [appliedKey]);
  const visibleKey = ordersStorageKey(contextKey, 'filtersVisible');
  const templatesKey = ordersStorageKey(contextKey, 'filterTemplates');
  const [visible, setVisible] = useState(() => readStored(visibleKey) !== 'false');
  const [templates, setTemplates] = useState<FilterTemplate[]>(() => parseTemplates(readStored(templatesKey)));
  const set = <K extends keyof OrderFilters>(k: K, v: OrderFilters[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const range = (from: keyof OrderFilters, to: keyof OrderFilters) => (a: string, b: string) =>
    setDraft((d) => ({ ...d, [from]: a, [to]: b }));
  const apply = (f: OrderFilters) => {
    const found = filterProblems(f);
    setProblems(found);
    if (!found.length) onApply(f);
  };
  const storeTemplates = (next: FilterTemplate[]) => {
    setTemplates(next);
    setNotice(writeStored(templatesKey, JSON.stringify(next)) ? '' : 'Przeglądarka nie zapisała szablonów (tryb prywatny lub brak miejsca). Będą dostępne do odświeżenia strony.');
  };
  const active = activeFilterCount(value);
  const dirty = !sameFilters(draft, value);
  const channelOptions = (options?.channels ?? []).map((s) => ({ value: s, label: sourceLabel(s) }));
  const deliveryOptions = options?.delivery_options ?? (options?.delivery_methods ?? []).map((m) => ({ value: m, label: deliveryLabels[m] ?? m }));
  return (
    <section className="of-panel" aria-label="Filtry zamówień">
      <div className="of-head">
        <button
          type="button"
          className="text-button"
          aria-expanded={visible}
          onClick={() => {
            setVisible(!visible);
            writeStored(visibleKey, String(!visible));
          }}
        >
          {visible ? 'Ukryj filtry' : 'Pokaż filtry'}
        </button>
        {active > 0 && (
          <span className="of-active">
            Aktywne filtry: {active}
            {!visible && (
              <button type="button" className="text-button" disabled={disabled} onClick={() => apply(emptyFilters)}>
                Wyczyść
              </button>
            )}
          </span>
        )}
      </div>
      {visible && (
        <form
          className="of-form"
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft);
          }}
        >
          <fieldset disabled={disabled} className="of-fields">
            <Row title="Zamówienie i klient">
              <Text label="Numer zamówienia" value={draft.number} max={60} onChange={(v) => set('number', v)} />
              <Text label="Zewnętrzne ID" value={draft.external_id} max={100} onChange={(v) => set('external_id', v)} />
              <MultiSelect label="Kanał sprzedaży" options={channelOptions} value={draft.channel} onChange={(v) => set('channel', v)} />
              <MultiSelect
                label="Status"
                options={STATUS_ORDER.map((s) => ({ value: s, label: statusLabel(s) }))}
                value={draft.status}
                onChange={(v) => set('status', v as FulfilmentStage[])}
              />
              <Text label="Imię / nazwisko / firma / NIP" value={draft.customer} max={100} onChange={(v) => set('customer', v)} />
              <Text label="Telefon klienta" value={draft.phone} max={30} inputMode="tel" onChange={(v) => set('phone', v)} />
              <Text label="E-mail klienta" value={draft.email} max={120} inputMode="email" onChange={(v) => set('email', v)} />
            </Row>
            <Row title="Adres i daty">
              <Text label="Login Allegro" value={draft.allegro_login} max={60} onChange={(v) => set('allegro_login', v)} />
              <Text label="Miasto" value={draft.city} max={100} onChange={(v) => set('city', v)} />
              <Text label="Kod pocztowy" value={draft.postal_code} max={20} onChange={(v) => set('postal_code', v)} />
              <Text label="Kraj" value={draft.country} max={40} placeholder="np. PL" onChange={(v) => set('country', v)} />
              <Range label="Dodane" kind="date" from={draft.created_from} to={draft.created_to} onChange={range('created_from', 'created_to')} />
              <Range
                label="Ost. zmiana statusu"
                kind="date"
                from={draft.status_changed_from}
                to={draft.status_changed_to}
                onChange={range('status_changed_from', 'status_changed_to')}
              />
              <Range label="Data dostarczenia" kind="date" from={draft.delivered_from} to={draft.delivered_to} onChange={range('delivered_from', 'delivered_to')} />
            </Row>
            <Row title="Produkt i wysyłka">
              <Text label="EAN" value={draft.ean} max={20} inputMode="numeric" onChange={(v) => set('ean', v)} />
              <Text label="SKU" value={draft.sku} max={60} onChange={(v) => set('sku', v)} />
              <MultiSelect
                label="Sposób wysyłki"
                options={deliveryOptions}
                value={draft.delivery}
                disabled={options !== null && !options.delivery_available}
                onChange={(v) => set('delivery', v)}
              />
              <Range label="Koszt wysyłki" kind="money" from={draft.shipping_from} to={draft.shipping_to} onChange={range('shipping_from', 'shipping_to')} />
              <MultiSelect
                label="Status płatności"
                options={(Object.keys(paymentLabels) as PaymentState[]).map((p) => ({ value: p, label: paymentLabels[p] }))}
                value={draft.payment}
                onChange={(v) => set('payment', v as PaymentState[])}
              />
            </Row>
            <Row title="Płatność i dokumenty">
              <Range label="Kwota" kind="money" from={draft.total_from} to={draft.total_to} onChange={range('total_from', 'total_to')} />
              <Choice
                label="Waluta"
                value={draft.currency}
                options={[['', 'Wszystkie'], ...(options?.currencies ?? []).map((c): [string, string] => [c, c])]}
                onChange={(v) => set('currency', v)}
              />
              <Choice label="Notatki" value={draft.has_note} options={yesNo} onChange={(v) => set('has_note', v)} />
              <Choice label="Komentarz kupującego" value={draft.has_comment} options={yesNo} onChange={(v) => set('has_comment', v)} />
              <Choice
                label="Dokument sprzedaży"
                value={draft.sale_document}
                options={[
                  ['', 'Wszystkie'],
                  ['invoice', 'Faktura'],
                  ['receipt', 'Paragon'],
                  ['none', 'Brak'],
                ]}
                onChange={(v) => set('sale_document', v)}
              />
              <Choice label="Zwrot" value={draft.has_return} options={yesNo} onChange={(v) => set('has_return', v)} />
            </Row>
          </fieldset>
          {(problems.length > 0 || notice) && (
            <div className="of-problems" role="alert">
              {problems.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {notice && <p>{notice}</p>}
            </div>
          )}
          <div className="of-actions">
            {dirty && <span className="of-dirty">Zmienione filtry czekają na „Filtruj”</span>}
            <button
              type="button"
              className="button"
              disabled={disabled}
              onClick={() => {
                setDraft(emptyFilters);
                apply(emptyFilters);
              }}
            >
              Wyczyść filtry
            </button>
            <TemplatesMenu
              templates={templates}
              saveDisabled={activeFilterCount(draft) === 0}
              onPick={(t) => {
                setDraft(t.filters);
                apply(t.filters);
              }}
              onSave={(name) => {
                if (filterProblems(draft).length) {
                  setProblems(filterProblems(draft));
                  return false;
                }
                storeTemplates(addTemplate(templates, name, draft, crypto.randomUUID()));
                return true;
              }}
              onDelete={(id) => storeTemplates(removeTemplate(templates, id))}
            />
            <button type="submit" className="button primary" disabled={disabled}>
              Filtruj
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
