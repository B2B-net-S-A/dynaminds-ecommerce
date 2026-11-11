import { useEffect, useRef, useState } from 'react';
import { money } from './api';
import './return-destination-parts.css';

export type ReturnDestinationPart = { part_id: string; item_id: string; quantity: number; status_id: string; status_version: string };
export type ReturnDestinationPartLine = { item_id: string; ordinal: number; sku: string; name: string; requested: number; ordered_quantity: number; line_total_minor: number; components: { product_id: string; quantity: number; sku?: string; name?: string }[] };
export type ReturnDestinationPartStatus = { id: string; version: string; revision_id: string; settings: { name: string; color: string; active: boolean; decision: 'accept' | 'reject'; inventory_effect: 'sale' | 'custody' | 'none'; warehouse_id: string | null; warehouse_policy_version: string | null; default_location: string | null } };
export type ReturnDestinationPartsValidity = { valid: boolean; errors: string[] };
export type ReturnDestinationPartsChange = { reason: 'initialize' | 'split' | 'merge' | 'status'; created_part_ids: string[]; retired_part_ids: string[] };
export type ReturnDestinationPartsEditorProps = {
  returnId: string;
  currency: string;
  lines: ReturnDestinationPartLine[];
  statuses: ReturnDestinationPartStatus[];
  warehouses: { id: string; name: string; code: string }[];
  value: ReturnDestinationPart[];
  onChange: (next: ReturnDestinationPart[], change: ReturnDestinationPartsChange) => void;
  onValidityChange?: (validity: ReturnDestinationPartsValidity) => void;
  retiredPartIds?: string[];
  readOnly: boolean;
};
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const qty = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 100000;
const version = (v: unknown, zero = false): v is string => typeof v === 'string' && (zero ? /^(0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/).test(v) && BigInt(v) <= 9223372036854775807n;
const statusKey = (s: { id: string; version: string }) => s.id + ':' + s.version;
const partStatusKey = (p: ReturnDestinationPart) => p.status_id + ':' + p.status_version;
function validStatus(s: ReturnDestinationPartStatus) {
  if (!s || !uuid(s.id) || !version(s.version) || !uuid(s.revision_id) || !s.settings || typeof s.settings.name !== 'string' || !s.settings.name.trim() || !/^#[a-f0-9]{6}$/i.test(s.settings.color) || typeof s.settings.active !== 'boolean') return false;
  const v = s.settings;
  return v.decision === 'reject' ? v.inventory_effect === 'none' && v.warehouse_id === null && v.warehouse_policy_version === null && v.default_location === null
    : v.decision === 'accept' && ['sale', 'custody'].includes(v.inventory_effect) && uuid(v.warehouse_id) && version(v.warehouse_policy_version, true) && typeof v.default_location === 'string' && !!v.default_location.trim();
}
function lineErrors(lines: ReturnDestinationPartLine[], returnId: string, currency: string) {
  if (!uuid(returnId) || !/^[A-Z]{3}$/.test(currency) || !Array.isArray(lines) || !lines.length || lines.length > 100) return ['Brak pełnego zakresu historycznych pozycji zwrotu.'];
  if (new Set(lines.map(l => l.item_id)).size !== lines.length || new Set(lines.map(l => l.ordinal)).size !== lines.length || lines.some(l => !uuid(l.item_id) || !Number.isInteger(l.ordinal) || l.ordinal < 0 || l.ordinal > 99 || typeof l.sku !== 'string' || typeof l.name !== 'string' || !qty(l.requested) || !qty(l.ordered_quantity) || l.requested > l.ordered_quantity || !Number.isSafeInteger(l.line_total_minor) || l.line_total_minor < 0 || !Array.isArray(l.components) || !l.components.length || l.components.length > 100 || l.components.some(c => !uuid(c.product_id) || !qty(c.quantity)))) return ['Niespójne UUID, ilości lub receptura oryginalnych pozycji zwrotu. Odczytaj sprawę ponownie.'];
  return [];
}
function structuralErrors(parts: ReturnDestinationPart[], lines: ReturnDestinationPartLine[], retired: Set<string>, bindings: Map<string, string>, allowEmpty = false) {
  const errors: string[] = [];
  if (!Array.isArray(parts) || parts.length > 200) return ['Podział może zawierać najwyżej 200 części.'];
  if (allowEmpty && parts.length === 0) return errors;
  const lineIds = new Set(lines.map(l => l.item_id));
  if (new Set(parts.map(p => p.part_id)).size !== parts.length) errors.push('UUID części muszą być unikalne.');
  for (const p of parts) {
    if (!uuid(p.part_id) || !uuid(p.item_id) || !lineIds.has(p.item_id)) errors.push('Część nie należy do oryginalnej pozycji tego zgłoszenia.');
    if (!qty(p.quantity)) errors.push('Każda część wymaga dodatniej całkowitej ilości do 100000 sztuk.');
    if (retired.has(p.part_id)) errors.push('Usunięty UUID części nie może zostać użyty ponownie.');
    if (bindings.has(p.part_id) && bindings.get(p.part_id) !== p.item_id) errors.push('Część zmieniła UUID oryginalnej pozycji. Odczytaj sprawę ponownie.');
  }
  for (const l of lines) if (parts.filter(p => p.item_id === l.item_id).reduce((n, p) => n + p.quantity, 0) !== l.requested) errors.push(`Pozycja ${l.ordinal + 1}: części muszą obejmować dokładnie ${l.requested} zgłoszonych sztuk.`);
  return [...new Set(errors)];
}
function StatusView({ status: s, warehouses }: { status: ReturnDestinationPartStatus; warehouses: ReturnDestinationPartsEditorProps['warehouses'] }) {
  const v = s.settings, w = warehouses.find(w => w.id === v.warehouse_id);
  return <div className="rdp-status"><span className="rdp-swatch" style={{ backgroundColor: v.color }} aria-hidden="true"/><strong>{v.name}</strong><small>Rewizja {s.version} · {s.revision_id}</small><p>{v.decision === 'reject' ? 'Odrzucenie · bez przyjęcia zapasu' : v.inventory_effect === 'custody' ? 'Przyjęcie fizyczne poza sprzedażą' : 'Przyjęcie fizyczne do magazynu sprzedażowego'}</p>{v.warehouse_id && <p>Magazyn: {w ? `${w.name} (${w.code})` : `Nazwa niedostępna · ${v.warehouse_id}`} · polityka {v.warehouse_policy_version} · lokalizacja {v.default_location}</p>}</div>;
}

export function ReturnDestinationPartsEditor(props: ReturnDestinationPartsEditorProps) {
  const { value, lines, statuses, warehouses, readOnly } = props;
  const [error, setError] = useState(''), [announcement, setAnnouncement] = useState(''), [initialStatus, setInitialStatus] = useState(''), [splitAmounts, setSplitAmounts] = useState<Record<string, string>>({}), [trackingVersion, setTrackingVersion] = useState(0);
  const tracker = useRef({ returnId: props.returnId, previous: [] as ReturnDestinationPart[], bindings: new Map<string, string>(), retired: new Set<string>() });
  const validityCallback = useRef(props.onValidityChange), lastValidity = useRef('');
  validityCallback.current = props.onValidityChange;
  // Only private UI identity bookkeeping, never an API action. A different RMA is a new scope.
  if (tracker.current.returnId !== props.returnId) tracker.current = { returnId: props.returnId, previous: [], bindings: new Map(), retired: new Set() };
  const retired = new Set([...tracker.current.retired, ...(props.retiredPartIds ?? [])]);
  const baseErrors = lineErrors(lines, props.returnId, props.currency);
  const shapeErrors = baseErrors.length ? baseErrors : structuralErrors(value, lines, retired, tracker.current.bindings, true);
  const configurationErrors = !Array.isArray(statuses) || statuses.length > 200 || statuses.some(s => !validStatus(s)) || new Set(statuses.map(s => s.id)).size !== statuses.length ? ['Brak jednoznacznych, pełnych rewizji statusów. Odczytaj konfigurację ponownie.'] : [];
  const active = configurationErrors.length ? [] : statuses.filter(s => s.settings.active);
  const statusErrors = value.flatMap(p => active.some(s => partStatusKey(p) === statusKey(s)) ? [] : [`Część ${p.part_id}: wybierz aktywną aktualną rewizję statusu.`]);
  const coverageErrors = baseErrors.length ? [] : structuralErrors(value, lines, retired, tracker.current.bindings);
  const errors = [...new Set([...baseErrors, ...coverageErrors, ...configurationErrors, ...statusErrors])];
  const errorsKey = JSON.stringify(errors), disabled = readOnly || shapeErrors.length > 0 || configurationErrors.length > 0;
  useEffect(() => {
    const t = tracker.current, now = new Set(value.map(p => p.part_id));
    let changed = false;
    for (const p of t.previous) if (!now.has(p.part_id) && !t.retired.has(p.part_id)) { t.retired.add(p.part_id); changed = true; }
    for (const p of value) if (!t.bindings.has(p.part_id)) { t.bindings.set(p.part_id, p.item_id); changed = true; }
    t.previous = value.map(p => ({ ...p })); if (changed) setTrackingVersion(v => v + 1);
  }, [props.returnId, value]);
  useEffect(() => { setError(''); setAnnouncement(''); setInitialStatus(''); setSplitAmounts({}); }, [props.returnId]);
  useEffect(() => { const key = props.returnId + ':' + errorsKey; if (lastValidity.current === key) return; lastValidity.current = key; validityCallback.current?.({ valid: errors.length === 0, errors: JSON.parse(errorsKey) }); }, [props.returnId, errorsKey, trackingVersion]);
  function freshId(taken: Set<string>) {
    for (let i = 0; i < 10; i++) { const id = crypto.randomUUID(); if (!taken.has(id) && !retired.has(id) && !tracker.current.bindings.has(id)) { taken.add(id); return id; } }
    throw Error('Nie udało się nadać nowej tożsamości części.');
  }
  function publish(next: ReturnDestinationPart[], change: ReturnDestinationPartsChange, message: string) {
    if (disabled) return;
    const problems = structuralErrors(next, lines, retired, tracker.current.bindings);
    if (problems.length) { setError(problems.join(' ')); return; }
    setError(''); setAnnouncement(message); props.onChange(next.map(p => ({ ...p })), change);
  }
  function initialize() {
    if (disabled || value.length || !active.some(s => statusKey(s) === initialStatus)) return;
    const s = active.find(s => statusKey(s) === initialStatus)!;
    try { const taken = new Set<string>(), next = [...lines].sort((a, b) => a.ordinal - b.ordinal).map(l => ({ part_id: freshId(taken), item_id: l.item_id, quantity: l.requested, status_id: s.id, status_version: s.version })); publish(next, { reason: 'initialize', created_part_ids: next.map(p => p.part_id), retired_part_ids: [] }, 'Utworzono pełny podział wszystkich zgłoszonych pozycji.'); }
    catch (e) { setError((e as Error).message); }
  }
  function split(p: ReturnDestinationPart) {
    if (disabled) return;
    if (value.length >= 200) { setError('Osiągnięto limit 200 części. Najpierw połącz zgodne części.'); return; }
    const text = splitAmounts[p.part_id] ?? '1', n = Number(text);
    if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(n) || n >= p.quantity) { setError('Podział wymaga dwóch dodatnich części: podaj mniej sztuk niż ilość tej części.'); return; }
    try { const newId = freshId(new Set(value.map(p => p.part_id))), index = value.findIndex(v => v.part_id === p.part_id), next = [...value.slice(0, index), { ...p, quantity: n }, { ...p, part_id: newId, quantity: p.quantity - n }, ...value.slice(index + 1)]; publish(next, { reason: 'split', created_part_ids: [newId], retired_part_ids: [] }, `Podzielono część na ${n} i ${p.quantity - n} sztuk bez zmiany oryginalnej pozycji.`); }
    catch (e) { setError((e as Error).message); }
  }
  function merge(p: ReturnDestinationPart) {
    if (disabled) return;
    const index = value.findIndex(v => v.part_id === p.part_id), nextPart = value[index + 1];
    if (!nextPart || nextPart.item_id !== p.item_id) { setError('Można połączyć tylko sąsiednie części tej samej oryginalnej pozycji.'); return; }
    if (partStatusKey(p) !== partStatusKey(nextPart)) { setError('Najpierw wybierz ten sam status i tę samą rewizję dla obu części. Różnych decyzji nie łączymy.'); return; }
    const next = [...value.slice(0, index), { ...p, quantity: p.quantity + nextPart.quantity }, ...value.slice(index + 2)];
    publish(next, { reason: 'merge', created_part_ids: [], retired_part_ids: [nextPart.part_id] }, 'Połączono sąsiednie części. Usunięty UUID części nie będzie użyty ponownie.');
  }
  function changeStatus(p: ReturnDestinationPart, key: string) {
    const s = active.find(s => statusKey(s) === key); if (disabled || !s) return;
    publish(value.map(v => v.part_id === p.part_id ? { ...v, status_id: s.id, status_version: s.version } : v), { reason: 'status', created_part_ids: [], retired_part_ids: [] }, 'Zmieniono rewizję statusu części. Poprzedni podgląd przyjęcia wymaga ponownego przygotowania.');
  }
  return <section className="return-destination-parts" aria-label="Podział pozycji zwrotu"><h3>Podział i statusy sztuk zwrotu</h3><p>Każda część należy do konkretnej pozycji sprzedaży. Suma części musi pokrywać dokładnie zgłoszoną ilość; identyczny SKU nie łączy różnych pozycji.</p><p>{value.length} / 200 części. Edytor przygotowuje decyzje; nie przyjmuje towaru i nie wypłaca pieniędzy.</p>{readOnly && <p className="notice">Podział jest dostępny tylko do odczytu.</p>}{value.length >= 200 && <p className="notice">Osiągnięto limit 200 części. Najpierw połącz zgodne części.</p>}{error && <p className="error-block" role="alert">{error}</p>}{errors.length > 0 && <div className="notice" role="status"><p>Podział nie jest gotowy do podglądu przyjęcia:</p><ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}<p role="status" aria-live="polite">{announcement}</p>
    {!value.length && !baseErrors.length && <fieldset disabled={disabled}><legend>Rozpocznij pełny podział</legend><label>Status początkowy wszystkich pozycji<select value={initialStatus} onChange={e => setInitialStatus(e.target.value)}><option value="">Wybierz aktywną rewizję</option>{active.map(s => <option key={statusKey(s)} value={statusKey(s)}>{s.settings.name} · rewizja {s.version}</option>)}</select></label><button className="button" type="button" disabled={!active.some(s => statusKey(s) === initialStatus)} onClick={initialize}>Utwórz części wszystkich pozycji</button></fieldset>}
    {!baseErrors.length && [...lines].sort((a, b) => a.ordinal - b.ordinal).map(l => <article className="rdp-line" key={l.item_id}><h4>Pozycja {l.ordinal + 1} · {l.sku} · {l.name}</h4><small>Oryginalna pozycja: {l.item_id}</small><p>Zgłoszono {l.requested} szt. · oryginalnie {l.ordered_quantity} szt. / {money(l.line_total_minor, props.currency)} za całą pozycję.</p><p>Receptura sprzedaży: {l.components.map(c => `${c.sku ?? c.product_id}${c.name ? ' · ' + c.name : ''} × ${c.quantity}`).join('; ')} na jedną pełną sztukę.</p>
      {value.filter(p => p.item_id === l.item_id).map((p, i) => { const s = statuses.find(s => validStatus(s) && statusKey(s) === partStatusKey(p)), next = value[value.findIndex(v => v.part_id === p.part_id) + 1]; return <div className="rdp-part" key={p.part_id}><h5>Część {i + 1} · {p.quantity} szt.</h5><small>UUID części: {p.part_id}</small>{s && <StatusView status={s} warehouses={warehouses}/>}<fieldset disabled={disabled}><label>Status części<select aria-label={`Status pozycji ${l.ordinal + 1} części ${i + 1}`} value={partStatusKey(p)} onChange={e => changeStatus(p, e.target.value)}>{!active.some(s => statusKey(s) === partStatusKey(p)) && <option value={partStatusKey(p)} disabled>Status nieaktywny lub zmieniona rewizja — wybierz aktualny</option>}{active.map(s => <option key={statusKey(s)} value={statusKey(s)}>{s.settings.name} · rewizja {s.version}</option>)}</select></label><label>Ilość w pierwszej części po podziale<input aria-label={`Podział pozycji ${l.ordinal + 1} części ${i + 1}`} type="number" min={1} max={Math.max(1, p.quantity - 1)} disabled={p.quantity < 2 || value.length >= 200} value={splitAmounts[p.part_id] ?? '1'} onChange={e => setSplitAmounts(v => ({ ...v, [p.part_id]: e.target.value }))}/></label><div className="rdp-actions"><button className="button" type="button" disabled={p.quantity < 2 || value.length >= 200} onClick={() => split(p)}>Podziel pozycję {l.ordinal + 1}, część {i + 1}</button><button className="button" type="button" disabled={!next || next.item_id !== p.item_id} onClick={() => merge(p)}>Połącz z następną częścią pozycji {l.ordinal + 1}, część {i + 1}</button></div></fieldset></div>; })}
    </article>)}
  </section>;
}
