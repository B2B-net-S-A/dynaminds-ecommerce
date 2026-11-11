// Building blocks of the v2 rule editor: grouped search picker, value editors per type, condition tree, effect params.
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import {
  OPERATOR_LABELS,
  OPERATORS,
  type CatalogEffect,
  type CatalogField,
  type ConditionGroup,
  type ConditionLeaf,
  type ConditionValue,
} from '../shared/automation-v2';
import {
  FIELD_GROUPS,
  WEEKDAYS,
  appendAt,
  groszeToZl,
  groupedSearch,
  isGroup,
  isMoneyField,
  isSupported,
  newGroup,
  newLeaf,
  removeAt,
  setMatch,
  toggleNegate,
  updateAt,
  valueShape,
  withOperator,
  zlToGrosze,
  type FieldMap,
  type Path,
} from './automation-v2-model';
import { api } from './api';

const pathKey = (p: Path) => p.join('.');

// ---------- grouped searchable picker ----------
export interface PickerItem {
  key: string;
  group: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function GroupedPicker({
  label,
  items,
  order,
  onPick,
  disabled,
}: {
  label: string;
  items: PickerItem[];
  order: readonly string[];
  onPick: (key: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    box = useRef<HTMLDivElement>(null),
    id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  const groups = groupedSearch(items, query, (i) => i.label + ' ' + i.group + ' ' + (i.hint ?? ''), (i) => i.group, order);
  return (
    <div className="av2-picker" ref={box} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="button small-btn" disabled={disabled} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        + {label}
      </button>
      {open && (
        <div className="av2-picker-pop" id={id}>
          <input
            autoFocus
            type="search"
            aria-label={label + ': szukaj'}
            placeholder="Szukaj…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="av2-picker-list" role="listbox" aria-label={label}>
            {!groups.length && <p className="muted">Brak wyników</p>}
            {groups.map((g) => (
              <div key={g.group} role="group" aria-label={g.group}>
                <strong className="av2-picker-group">{g.group}</strong>
                {g.items.map((i) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    key={i.key}
                    disabled={i.disabled}
                    title={i.hint}
                    onClick={() => {
                      onPick(i.key);
                      setOpen(false);
                      setQuery('');
                    }}
                  >
                    {i.label}
                    {i.disabled && <small> · nieobsługiwane{i.hint ? ': ' + i.hint : ''}</small>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- value editors ----------
/** Złote typed by the user, grosze stored. Keeps the raw text while it is being typed. */
export function MoneyInput({ value, onChange, label }: { value: number | null | undefined; onChange: (n: number | null) => void; label: string }) {
  const [text, setText] = useState(groszeToZl(value));
  useEffect(() => {
    if (zlToGrosze(text) !== (value ?? null)) setText(groszeToZl(value));
  }, [value]);
  return (
    <span className="av2-unit">
      <input
        inputMode="decimal"
        aria-label={label}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(zlToGrosze(e.target.value));
        }}
      />
      zł
    </span>
  );
}

function NumberInput({ value, onChange, label, money }: { value: unknown; onChange: (n: number | null) => void; label: string; money: boolean }) {
  if (money) return <MoneyInput value={typeof value === 'number' ? value : null} onChange={onChange} label={label} />;
  return (
    <input
      type="number"
      aria-label={label}
      value={typeof value === 'number' ? value : ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
export function toLocalInput(iso: unknown): string {
  if (typeof iso !== 'string' || !iso || Number.isNaN(Date.parse(iso))) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (s: string): string => (s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : '');

type Relative = { amount: number; unit: 'minutes' | 'hours' | 'days' };
const isRelative = (v: unknown): v is Relative => !!v && typeof v === 'object' && !Array.isArray(v) && 'unit' in v;

function RelativeInput({ value, onChange, label }: { value: Relative; onChange: (v: Relative) => void; label: string }) {
  return (
    <span className="av2-inline">
      <input
        type="number"
        min={1}
        aria-label={label + ': ile'}
        value={value.amount}
        onChange={(e) => onChange({ ...value, amount: Number(e.target.value) })}
      />
      <select aria-label={label + ': jednostka'} value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as Relative['unit'] })}>
        <option value="minutes">minut</option>
        <option value="hours">godzin</option>
        <option value="days">dni</option>
      </select>
    </span>
  );
}

export function WeekdayChips({ value, onChange, label }: { value: number[]; onChange: (v: number[]) => void; label: string }) {
  return (
    <span className="av2-days" role="group" aria-label={label}>
      {WEEKDAYS.map((d, i) => {
        const n = i + 1,
          on = value.includes(n);
        return (
          <label key={d} className={on ? 'on' : ''}>
            <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== n) : [...value, n].sort())} />
            {d}
          </label>
        );
      })}
    </span>
  );
}

/** GET /api/orders/status-counts: orders per fulfilment stage and per custom status id. */
type StatusCounts = { statuses: Record<string, number>; workflow: Record<string, number>; total: number };
const COUNTED_FIELDS = ['order.status', 'order.workflow_status'];
type ListOption = NonNullable<CatalogField['options']>[number];

/** Orders in one status option: a stage, or a custom status (its id, or 'wf:<id>' inside order.status). */
export function statusOptionCount(fieldKey: string, value: string, counts: StatusCounts): number {
  if (value.startsWith('wf:')) return counts.workflow[value.slice(3)] ?? 0;
  return (fieldKey === 'order.workflow_status' ? counts.workflow[value] : counts.statuses[value]) ?? 0;
}

/** Orders in a group (category); in order.status only stages count, a custom status is already inside its stage. */
export function statusGroupCount(fieldKey: string, options: readonly ListOption[], counts: StatusCounts): number {
  return options
    .filter((o) => fieldKey === 'order.workflow_status' || !o.value.startsWith('wf:'))
    .reduce((sum, o) => sum + statusOptionCount(fieldKey, o.value, counts), 0);
}

/** Searchable checkbox list grouped by option.group, with select-all per group (statuses can be ~100). */
export function ListValueEditor({
  options,
  value,
  onChange,
  label,
  emptyLabel,
  countField,
}: {
  options: NonNullable<CatalogField['options']>;
  value: string[];
  onChange: (v: string[]) => void;
  label: string;
  /** Summary of an empty choice when empty is a valid answer (e.g. "Dowolny"); the list then starts closed. */
  emptyLabel?: string;
  /** Field key; for order.status / order.workflow_status the list shows how many orders are in each status. */
  countField?: string;
}) {
  const [query, setQuery] = useState(''),
    [open, setOpen] = useState(!value.length && !emptyLabel);
  const box = useRef<HTMLDivElement>(null);
  const counted = !!countField && COUNTED_FIELDS.includes(countField);
  const [counts, setCounts] = useState<StatusCounts | null>(null),
    [countsError, setCountsError] = useState('');
  useEffect(() => {
    if (!counted) return;
    let live = true;
    api<StatusCounts>('/orders/status-counts')
      .then((c) => {
        if (!live) return;
        if (c && typeof c.statuses === 'object' && typeof c.workflow === 'object') setCounts(c);
        else setCountsError('nieprawidłowa odpowiedź serwera');
      })
      .catch((e: unknown) => {
        if (live) setCountsError(e instanceof Error ? e.message : 'nieznany błąd');
      });
    return () => {
      live = false;
    };
  }, [counted]);
  const shownCounts = counted ? counts : null;
  // Like the field picker: a click outside or Escape closes the list (the choice is already applied).
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  const groups = groupedSearch(options, query, (o) => o.label + ' ' + (o.group ?? ''), (o) => o.group ?? '', []);
  const selected = new Set(value);
  const chosen = options.filter((o) => selected.has(o.value)).map((o) => o.label);
  const toggleAll = (vals: string[], on: boolean) =>
    onChange(on ? [...new Set([...value, ...vals])] : value.filter((v) => !vals.includes(v)));
  return (
    <div className="av2-list" ref={box} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="av2-list-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        {chosen.length ? chosen.slice(0, 4).join(', ') + (chosen.length > 4 ? ' i ' + (chosen.length - 4) + ' więcej' : '') : emptyLabel ?? 'Wybierz…'}
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="av2-list-pop">
          {options.length > 8 && (
            <input type="search" aria-label={label + ': szukaj'} placeholder="Szukaj…" value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          <div className="av2-list-scroll" role="group" aria-label={label}>
            {groups.map((g) => {
              const vals = g.items.map((o) => o.value),
                all = vals.every((v) => selected.has(v));
              return (
                <div key={g.group || '-'}>
                  {g.group && (
                    <label className="av2-list-group">
                      <input type="checkbox" checked={all} onChange={() => toggleAll(vals, !all)} aria-label={'Zaznacz wszystkie: ' + g.group} />
                      {g.group}
                      {shownCounts && countField ? ' (' + statusGroupCount(countField, options.filter((o) => (o.group ?? '') === g.group), shownCounts) + ')' : ''}:
                    </label>
                  )}
                  {g.items.map((o) => (
                    <label key={o.value} className="av2-list-option">
                      <input
                        type="checkbox"
                        checked={selected.has(o.value)}
                        onChange={() => onChange(selected.has(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value])}
                      />
                      {o.label}
                      {shownCounts && countField && (
                        <span className="av2-list-count">{statusOptionCount(countField, o.value, shownCounts)}</span>
                      )}
                    </label>
                  ))}
                </div>
              );
            })}
            {!groups.length && <p className="muted">Brak wyników</p>}
          </div>
          {counted && countsError && <p className="muted">Liczby zamówień niedostępne: {countsError}</p>}
          <small className="muted">Zaznaczono: {value.length}</small>
        </div>
      )}
    </div>
  );
}

export function LeafValueEditor({ leaf, field, onChange }: { leaf: ConditionLeaf; field: CatalogField; onChange: (v: ConditionValue | undefined) => void }) {
  const v = leaf.value,
    label = field.label,
    money = isMoneyField(field);
  switch (valueShape(field.type, leaf.op)) {
    case 'none':
      return null;
    case 'list':
      return (
        <ListValueEditor
          options={field.options ?? []}
          value={Array.isArray(v) ? (v as string[]) : []}
          onChange={onChange}
          label={label}
          countField={field.key}
        />
      );
    case 'text':
      return <input aria-label={label + ': wartość'} value={typeof v === 'string' ? v : ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <NumberInput value={v} onChange={onChange} label={label + ': wartość'} money={money} />;
    case 'range': {
      const r = Array.isArray(v) ? (v as Array<number | null>) : [null, null];
      return (
        <span className="av2-inline">
          od <NumberInput value={r[0]} onChange={(n) => onChange([n, r[1]] as [number, number])} label={label + ': od'} money={money} />
          do <NumberInput value={r[1]} onChange={(n) => onChange([r[0], n] as [number, number])} label={label + ': do'} money={money} />
        </span>
      );
    }
    case 'moment': {
      const relative = isRelative(v);
      return (
        <span className="av2-inline">
          <select
            aria-label={label + ': rodzaj daty'}
            value={relative ? 'relative' : 'absolute'}
            onChange={(e) => onChange(e.target.value === 'relative' ? { amount: 1, unit: 'days' } : '')}
          >
            <option value="relative">o okres</option>
            <option value="absolute">od daty</option>
          </select>
          {relative ? (
            <RelativeInput value={v} onChange={onChange} label={label} />
          ) : (
            <input type="datetime-local" aria-label={label + ': data'} value={toLocalInput(v)} onChange={(e) => onChange(fromLocalInput(e.target.value))} />
          )}
        </span>
      );
    }
    case 'relative':
      return <RelativeInput value={isRelative(v) ? v : { amount: 1, unit: 'days' }} onChange={onChange} label={label} />;
    case 'date_range': {
      const r = Array.isArray(v) ? (v as string[]) : ['', ''];
      return (
        <span className="av2-inline">
          od <input type="datetime-local" aria-label={label + ': od'} value={toLocalInput(r[0])} onChange={(e) => onChange([fromLocalInput(e.target.value), r[1]])} />
          do <input type="datetime-local" aria-label={label + ': do'} value={toLocalInput(r[1])} onChange={(e) => onChange([r[0], fromLocalInput(e.target.value)])} />
        </span>
      );
    }
    case 'weekdays':
      return <WeekdayChips value={Array.isArray(v) ? (v as number[]) : []} onChange={onChange} label={label} />;
    case 'hours': {
      const r = Array.isArray(v) ? (v as string[]) : ['08:00', '16:00'];
      return (
        <span className="av2-inline">
          od <input type="time" aria-label={label + ': od godziny'} value={r[0]} onChange={(e) => onChange([e.target.value, r[1]])} />
          do <input type="time" aria-label={label + ': do godziny'} value={r[1]} onChange={(e) => onChange([r[0], e.target.value])} />
        </span>
      );
    }
  }
}

// ---------- condition tree ----------
interface TreeProps {
  root: ConditionGroup;
  fields: CatalogField[];
  fieldMap: FieldMap;
  errors: ReadonlyMap<string, string>;
  onChange: (root: ConditionGroup) => void;
}

export const fieldPickerItems = (fields: CatalogField[]): PickerItem[] =>
  fields.map((f) => ({ key: f.key, group: f.group, label: f.label, hint: f.hint, disabled: !isSupported(f) }));

function LeafRow({ leaf, path, props }: { leaf: ConditionLeaf; path: Path; props: TreeProps }) {
  const field = props.fieldMap.get(leaf.field),
    error = props.errors.get(pathKey(path));
  const set = (next: ConditionLeaf) => props.onChange(updateAt(props.root, path, () => next));
  const remove = (
    <button type="button" className="icon-btn" aria-label={'Usuń warunek ' + (field?.label ?? leaf.field)} onClick={() => props.onChange(removeAt(props.root, path))}>
      <X size={16} />
    </button>
  );
  if (!field)
    return (
      <tr className="av2-invalid">
        <td>{leaf.field}</td>
        <td>
          <span className="av2-error">Nieznane pole — usuń warunek albo odśwież katalog.</span>
        </td>
        <td>{remove}</td>
      </tr>
    );
  return (
    <tr className={error ? 'av2-invalid' : undefined}>
      <td>
        <strong>{field.label}</strong>
        <small>{field.group}</small>
        {!isSupported(field) && <small className="av2-error">Nieobsługiwane{field.hint ? ': ' + field.hint : ''}</small>}
      </td>
      <td>
        <div className="av2-inline">
          {field.per_line && (
            <select
              aria-label={field.label + ': zakres produktów'}
              value={leaf.quantifier ?? 'any'}
              onChange={(e) => set({ ...leaf, quantifier: e.target.value as 'any' | 'all' })}
            >
              <option value="any">którykolwiek produkt</option>
              <option value="all">wszystkie produkty</option>
            </select>
          )}
          <select aria-label={field.label + ': operator'} value={leaf.op} onChange={(e) => set(withOperator(leaf, field, e.target.value as ConditionLeaf['op']))}>
            {OPERATORS[field.type].map((op) => (
              <option key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </option>
            ))}
          </select>
          <LeafValueEditor
            leaf={leaf}
            field={field}
            onChange={(value) => {
              const { value: _old, ...rest } = leaf;
              set(value === undefined ? rest : { ...rest, value });
            }}
          />
        </div>
        {error && <small className="av2-error" role="alert">{error}</small>}
      </td>
      <td>{remove}</td>
    </tr>
  );
}

function GroupBody({ group, path, props }: { group: ConditionGroup; path: Path; props: TreeProps }) {
  const add = (key: string) => {
    const f = props.fieldMap.get(key);
    if (f) props.onChange(appendAt(props.root, path, newLeaf(f)));
  };
  const joiner = group.match === 'all' ? 'i' : 'lub';
  return (
    <>
      <table className="av2-table">
        <thead>
          <tr>
            <th>Rodzaj</th>
            <th>Ustawienia</th>
            <th aria-label="Usuń" />
          </tr>
        </thead>
        <tbody>
          {!group.items.length && (
            <tr>
              <td colSpan={3} className="muted">
                {path.length ? 'Pusta grupa — dodaj warunek.' : 'Bez warunków — reguła dotyczy każdego zamówienia.'}
              </td>
            </tr>
          )}
          {group.items.map((n, i): ReactNode => {
            const p = [...path, i];
            const sep = i > 0 && (
              <tr className="av2-joiner" aria-hidden>
                <td colSpan={3}>{joiner}</td>
              </tr>
            );
            if (!isGroup(n))
              return (
                <Fragment key={pathKey(p)}>
                  {sep}
                  <LeafRow leaf={n} path={p} props={props} />
                </Fragment>
              );
            return (
              <Fragment key={pathKey(p)}>
                {sep}
                <tr className="av2-subgroup-row">
                  <td colSpan={3}>
                    <GroupBlock group={n} path={p} props={props} />
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="ops-buttons">
        <GroupedPicker label="Dodaj warunek" items={fieldPickerItems(props.fields)} order={FIELD_GROUPS} onPick={add} />
        <button type="button" className="button small-btn" onClick={() => props.onChange(appendAt(props.root, path, newGroup()))}>
          + Dodaj grupę warunków
        </button>
      </div>
    </>
  );
}

function GroupBlock({ group, path, props }: { group: ConditionGroup; path: Path; props: TreeProps }) {
  return (
    <fieldset className={'av2-group' + (group.negate ? ' negated' : '')}>
      <legend>
        <select
          aria-label={'Łączenie warunków w grupie ' + pathKey(path.map((i) => i + 1))}
          value={group.match}
          onChange={(e) => props.onChange(setMatch(props.root, path, e.target.value as 'all' | 'any'))}
        >
          <option value="all">Grupa: wszystkie (I)</option>
          <option value="any">Grupa: dowolny (LUB)</option>
        </select>
        <label className="av2-check">
          <input type="checkbox" checked={!!group.negate} onChange={() => props.onChange(toggleNegate(props.root, path))} />
          NIE (zaprzecz grupę)
        </label>
        <button type="button" className="icon-btn" aria-label={'Usuń grupę ' + pathKey(path.map((i) => i + 1))} onClick={() => props.onChange(removeAt(props.root, path))}>
          <X size={16} />
        </button>
      </legend>
      <GroupBody group={group} path={path} props={props} />
    </fieldset>
  );
}

export function ConditionsEditor(props: TreeProps) {
  const { root } = props;
  return (
    <div className="av2-conditions">
      <div className="av2-inline av2-logic">
        <label className="av2-check">
          <input type="checkbox" checked={root.match === 'all'} onChange={() => props.onChange(setMatch(root, [], root.match === 'all' ? 'any' : 'all'))} />
          Wszystkie warunki muszą być spełnione (I)
        </label>
        {root.match === 'any' && <span className="badge">LUB: wystarczy jeden warunek</span>}
        <label className="av2-check">
          <input type="checkbox" checked={!!root.negate} onChange={() => props.onChange(toggleNegate(root, []))} />
          NIE (zaprzecz całość)
        </label>
      </div>
      <GroupBody group={root} path={[]} props={props} />
    </div>
  );
}

// ---------- effect parameters ----------
export function EffectParamsForm({ effect, params, onChange }: { effect: CatalogEffect; params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }) {
  if (!effect.params.length) return <small className="muted">Bez ustawień</small>;
  const set = (key: string, v: unknown) => onChange({ ...params, [key]: v });
  return (
    <div className="av2-params">
      {effect.params.map((p) => {
        const v = params[p.key],
          label = p.label + (p.required ? ' *' : '');
        switch (p.kind) {
          case 'bool':
            return (
              <label key={p.key} className="av2-check">
                <input type="checkbox" checked={v === true} onChange={(e) => set(p.key, e.target.checked)} />
                {p.label}
              </label>
            );
          case 'textarea':
            return (
              <label key={p.key}>
                {label}
                <textarea rows={3} value={typeof v === 'string' ? v : ''} onChange={(e) => set(p.key, e.target.value)} />
              </label>
            );
          case 'number':
            return (
              <label key={p.key}>
                {label}
                <input type="number" value={typeof v === 'number' ? v : ''} onChange={(e) => set(p.key, e.target.value === '' ? undefined : Number(e.target.value))} />
              </label>
            );
          case 'money':
            return (
              <label key={p.key}>
                {label}
                <MoneyInput value={typeof v === 'number' ? v : null} onChange={(n) => set(p.key, n ?? undefined)} label={p.label} />
              </label>
            );
          case 'select':
            return (
              <label key={p.key}>
                {label}
                <select value={typeof v === 'string' ? v : ''} onChange={(e) => set(p.key, e.target.value || undefined)}>
                  <option value="">Wybierz…</option>
                  {p.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          case 'multiselect':
            return (
              <div key={p.key} className="av2-param-multi">
                <span>{label}</span>
                <ListValueEditor options={p.options ?? []} value={Array.isArray(v) ? (v as string[]) : []} onChange={(x) => set(p.key, x)} label={p.label} />
              </div>
            );
          case 'date':
            return (
              <label key={p.key}>
                {label}
                <input type="date" value={typeof v === 'string' ? v : ''} onChange={(e) => set(p.key, e.target.value || undefined)} />
              </label>
            );
          default:
            return (
              <label key={p.key}>
                {label}
                <input value={typeof v === 'string' ? v : ''} onChange={(e) => set(p.key, e.target.value)} />
              </label>
            );
        }
      })}
    </div>
  );
}
