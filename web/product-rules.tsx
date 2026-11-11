import {attributeValueText,attributeValuesEqual} from './catalog-attributes';
import type {JsonValue} from '../shared/pim-json';
import { ProductRuleSchedules } from './product-rule-schedules';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, Zap } from 'lucide-react';
import type { z } from 'zod';
import type { productRuleDefinition } from '../server/product-rules';
import { api, ApiError, date } from './api';
import './product-rules.css';

type Definition = z.infer<typeof productRuleDefinition>;
type Condition = Definition['conditions'][number];
type Action = Definition['actions'][number];
type Rule = {
  id: string;
  version: number;
  name: string;
  event: Definition['event'];
  enabled: boolean;
  approved_at: string | null;
  approved_by: string;
  definition: Definition;
};
type RulesList = {
  available: boolean;
  price_tags_available?:boolean;
  read_only: boolean;
  data: Rule[];
  meta?: { cursor: string | null };
};
type Source = {
  id: string;
  version: number;
  sku: string;
  name: string;
  category: string;
  kind: string;
  active: boolean;
  attributes: Record<string, JsonValue>;
  tags?:string[];
  price_targets?:Record<string,{frame:{list:{name:string;currency:string}};snapshot:{effective_price:number|null;override_present:boolean;override_price:number|null}}>;
};
type RunItem = {
  position: number;
  product_id: string;
  source_version: number;
  source: Source;
  projected: { category: string; attributes: Record<string, JsonValue>;tags?:string[];price_targets?:Record<string,number> };
  matched_rules: string[];
  state: 'pending' | 'changed' | 'skipped' | 'failed';
  result_version: number | null;
  error: string | null;
};
type RunHead = {
  id: string;
  event: Definition['event'];
  origin: 'manual' | 'catalog';
  state: 'preview' | 'queued' | 'done' | 'failed';
  scope_hash: string;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  product_count?: number;
  result: { changed?: number; skipped?: number; rolled_back?: boolean; job_failed?: boolean };
};
type Run = RunHead & {
  expires_at: string;
  rules: { id: string; version: number; approved_by: string; definition: Definition }[];
  items: RunItem[];
};
export type ProductRuleSelection = ReadonlyArray<{
  product_id: string;
  version: number;
  sku?: string;
  name?: string;
}>;
type CommonProps = {
  workspaceId: string;
  admin: boolean;
  readOnly: boolean;
  refresh?: number;
  onChanged?: () => void;
};
const eventNames = {
  'product.created': 'Utworzono produkt',
  'product.updated': 'Zaktualizowano produkt',
};
const fieldNames = {
  sku: 'SKU',
  name: 'Nazwa',
  category: 'Kategoria',
  kind: 'Typ produktu',
  active: 'Aktywność produktu',
  attribute: 'Atrybut',
  tag:'Tag produktu',
};
const opNames = {
  eq: 'jest równe',
  not_eq: 'jest inne',
  contains: 'zawiera',
  prefix: 'zaczyna się od',
  exists: 'istnieje',
  not_exists: 'nie istnieje',
  not_contains:'nie zawiera',
};
const actionNames = {
  set_category: 'Ustaw kategorię',
  set_attribute: 'Ustaw atrybut',
  remove_attribute: 'Usuń atrybut',
  add_tags:'Dodaj tagi',remove_tags:'Usuń tagi',replace_tags:'Zastąp wszystkie tagi',
  set_price:'Ustaw cenę w cenniku',adjust_price:'Zmień cenę o kwotę',multiply_price:'Pomnóż cenę w cenniku',
};
const kindNames = {
  simple: 'Produkt',
  variant: 'Wariant',
  group: 'Grupa wariantów',
  bundle: 'Zestaw',
};
const runNames = {
  preview: 'Podgląd — jeszcze nie wykonano',
  queued: 'Zlecono — oczekujemy na wynik',
  done: 'Zakończono',
  failed: 'Zatrzymano z błędem',
};
const itemNames = {
  pending: 'Oczekuje',
  changed: 'Zmieniono',
  skipped: 'Bez zmian',
  failed: 'Błąd — nie zastosowano',
};
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const clone = <T,>(value: T): T => structuredClone(value);
const newDefinition = (): Definition => ({
  name: '',
  event: 'product.updated',
  enabled: false,
  priority: 50,
  conditions: [],
  actions: [{ type: 'set_category', category: '' }],
});
function unique<T extends { id: string }>(old: T[], incoming: T[]) {
  const seen = new Set(old.map((v) => v.id));
  return [...old, ...incoming.filter((v) => !seen.has(v.id))];
}
function textProblem(value: string, max: number, empty = false) {
  return value.length > max || (!empty && !value.trim()) || /[\x00-\x1f\x7f]/.test(value);
}
function keyProblem(value: string) {
  return textProblem(value, 80) || forbiddenKeys.has(value);
}
function definitionProblem(d: Definition): string {
  if (textProblem(d.name, 120)) return 'Nazwa wymaga od 1 do 120 znaków bez znaków sterujących.';
  if (!Number.isInteger(d.priority) || d.priority < 0 || d.priority > 100)
    return 'Priorytet musi być liczbą całkowitą od 0 do 100.';
  if (d.conditions.length > 10 || !d.actions.length || d.actions.length > 5)
    return 'Reguła ma maksymalnie 10 warunków i od 1 do 5 akcji.';
  for (const c of d.conditions) {
    if (c.field === 'attribute' && keyProblem(c.key))
      return 'Popraw klucz atrybutu w warunku: 1–80 znaków; zastrzeżone klucze są niedozwolone.';
    if (
      'value' in c &&
      typeof c.value === 'string' &&
      textProblem(c.value, c.field === 'attribute' ? 500 : 200, true)
    )
      return 'Wartość warunku jest zbyt długa lub zawiera znak sterujący.';
  }
  for (const a of d.actions) {
    if (a.type === 'set_category' && textProblem(a.category, 80))
      return 'Kategoria wymaga od 1 do 80 znaków bez znaków sterujących.';
    if ('key' in a && keyProblem(a.key))
      return 'Popraw klucz atrybutu w akcji: 1–80 znaków; zastrzeżone klucze są niedozwolone.';
    if (a.type === 'set_attribute' && textProblem(a.value, 500, true))
      return 'Wartość atrybutu ma maksymalnie 500 znaków i nie może zawierać znaków sterujących.';
  }
    for(const a of d.actions){
      if('tags' in a && (a.tags.length>20||new Set(a.tags).size!==a.tags.length||a.tags.some(t=>textProblem(t,80)||t!==t.trim()||t!==t.normalize('NFC'))))return 'Podaj do 20 różnych tagów, po jednym w wierszu.';
      if('price_list_id' in a){if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.price_list_id))return 'Wybierz własny cennik.';
        if(a.type==='set_price'&&(!Number.isSafeInteger(a.amount_minor)||a.amount_minor<0||a.amount_minor>100000000))return 'Cena wymaga 0–100000000 najmniejszych jednostek waluty.';
        if(a.type==='adjust_price'&&(!Number.isSafeInteger(a.delta_minor)||Math.abs(a.delta_minor)>100000000))return 'Zmiana ceny wymaga całkowitej kwoty z podanym znakiem.';
        if(a.type==='multiply_price'&&(!Number.isSafeInteger(a.numerator)||!Number.isSafeInteger(a.denominator)||a.numerator<1||a.denominator<1||a.numerator>1000000||a.denominator>1000000))return 'Licznik i mianownik muszą mieścić się w zakresie 1–1000000.';
      }
    }
  return '';
}
function fatalAccessError(e: unknown) {
  return e instanceof ApiError && [401, 403, 423, 503].includes(e.status);
}
function conditionText(c: Condition) {
  return `${fieldNames[c.field]}${c.field === 'attribute' ? ' „' + c.key + '”' : ''} ${opNames[c.op]}${'value' in c ? ' „' + (typeof c.value === 'boolean' ? (c.value ? 'aktywny' : 'nieaktywny') : c.value) + '”' : ''}`;
}
function actionText(a: Action) {
  if('tags' in a)return actionNames[a.type]+': '+(a.tags.join(', ')||'(usuń wszystkie)');
  if('price_list_id' in a)return actionNames[a.type]+': '+(a.type==='set_price'?a.amount_minor+' minor':a.type==='adjust_price'?(a.delta_minor>=0?'+':'')+a.delta_minor+' minor':a.numerator+'/'+a.denominator)+' · wybrany cennik';
  return a.type === 'set_category'
    ? 'Kategoria → „' + a.category + '”'
    : a.type === 'set_attribute'
      ? 'Atrybut „' + a.key + '” → „' + a.value + '”'
      : 'Usuń atrybut „' + a.key + '”';
}
function DefinitionSummary({ definition }: { definition: Definition }) {
  return (
    <div className="pr-definition-summary">
      <p>
        <strong>{eventNames[definition.event]}</strong> · priorytet {definition.priority} ·{' '}
        {definition.enabled ? 'Aktywna' : 'Wyłączona'}
      </p>
      <p>
        {definition.conditions.length
          ? 'Wszystkie warunki (AND):'
          : 'Bez warunków — każdy produkt objęty zdarzeniem.'}
      </p>
      {definition.conditions.length > 0 && (
        <ul>
          {definition.conditions.map((c, i) => (
            <li key={i}>{conditionText(c)}</li>
          ))}
        </ul>
      )}
      <ol>
        {definition.actions.map((a, i) => (
          <li key={i}>{actionText(a)}</li>
        ))}
      </ol>
    </div>
  );
}
function AdminRequired() {
  return (
    <section className="panel product-rules-panel">
      <div className="pr-body">
        <h2>Automatyzacje produktów</h2>
        <p className="notice">
          Definicje i wykonania reguł produktów wymagają aktualnego administratora organizacji.
        </p>
      </div>
    </section>
  );
}

function useRules(readOnly: boolean, refresh: number) {
  const [list, setList] = useState<RulesList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [serverReadOnly, setServerReadOnly] = useState(false);
  const generation = useRef(0),
    alive = useRef(true);
  function fail(e: unknown) {
    setError((e as Error).message);
    if (e instanceof ApiError && [401, 403, 423, 503].includes(e.status)) {
      ++generation.current;
      setBusy(false);
      if (e.status === 423) setServerReadOnly(true);
      else {
        setBlocked(true);
        setList(null);
      }
    }
  }
  async function load(after?: string | null) {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const d = await api<RulesList>(
        '/product-rules' + (after ? '?after=' + encodeURIComponent(after) : ''),
      );
      if (!alive.current || current !== generation.current) return;
      setList((previous) => ({
        ...d,
        data: after ? unique(previous?.data ?? [], d.data) : d.data,
      }));
      setBlocked(false);
      setServerReadOnly(d.read_only);
    } catch (e) {
      if (alive.current && (current === generation.current || fatalAccessError(e))) fail(e);
    } finally {
      if (alive.current && current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      ++generation.current;
    };
  }, [refresh]);
  return {
    list,
    busy,
    error,
    blocked,
    readonly: readOnly || serverReadOnly || !!list?.read_only,
    available: list?.available === true,
    load,
    fail,
  };
}
function GateNotice({ gate }: { gate: ReturnType<typeof useRules> }) {
  return (
    <>
      {gate.error && (
        <p className="error" role="alert">
          {gate.error}
        </p>
      )}
      {gate.busy && !gate.list && <p role="status">Wczytywanie automatyzacji produktów…</p>}
      {gate.list && !gate.list.available && (
        <p className="notice">
          Ta kopia nie zawiera automatyzacji produktów. Historia i zapis są niedostępne.
        </p>
      )}
      {gate.readonly && (
        <p className="notice">
          Podgląd kopii — można odczytać istniejące reguły i wykonania. Zapis, podgląd nowej partii
          i zlecanie są wyłączone.
        </p>
      )}
      {gate.blocked && (
        <p className="notice">
          Dostęp został zatrzymany. Potrzebne są aktualne uprawnienia administratora i dostępny
          moduł. Odśwież definicje po przywróceniu dostępu.
        </p>
      )}
    </>
  );
}

export function AdminProductRules(props: CommonProps) {
  if (!props.admin) return <AdminRequired />;
  return <AdminProductRulesInner key={props.workspaceId + ':admin'} {...props} />;
}
function AdminProductRulesInner({ readOnly, refresh = 0, onChanged }: CommonProps) {
  const gate = useRules(readOnly, refresh);
  const [editor, setEditor] = useState<{
    rule?: Rule;
    definition?: Definition;
    serial: string;
  } | null>(null);
  const [archive, setArchive] = useState<{
    rule: Rule;
    confirmed: boolean;
    attempted: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false),
    [notice, setNotice] = useState('');
  const mutation = useRef(false),
    alive = useRef(true);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (gate.readonly || gate.blocked) setArchive((a) => (a ? { ...a, confirmed: false } : null));
  }, [gate.readonly, gate.blocked]);
  function edit(rule?: Rule, definition?: Definition) {
    setEditor({ rule, definition, serial: crypto.randomUUID() });
    setArchive(null);
    setNotice('');
  }
  async function archiveRule() {
    if (
      !archive?.confirmed ||
      mutation.current ||
      saving ||
      gate.readonly ||
      !gate.available ||
      gate.blocked
    )
      return;
    const current = archive;
    mutation.current = true;
    setSaving(true);
    setNotice('');
    setArchive({ ...current, attempted: true });
    try {
      await api('/product-rules/' + current.rule.id, 'DELETE', { version: current.rule.version });
      if (!alive.current) return;
      setArchive(null);
      setNotice('Reguła została zarchiwizowana. Historia pozostaje dostępna.');
      onChanged?.();
      await gate.load();
    } catch (e) {
      if (alive.current) {
        gate.fail(e);
        if (e instanceof ApiError && [409, 422].includes(e.status))
          setArchive({ ...current, confirmed: false, attempted: false });
      }
    } finally {
      mutation.current = false;
      if (alive.current) setSaving(false);
    }
  }
  return (
    <section className="panel product-rules-panel">
      <div className="panel-heading">
        <div>
          <h2>
            <Zap size={20} /> Automatyzacje produktów
          </h2>
          <p>Reguły zmieniają lokalnie kategorię, atrybuty, tagi i ceny wskazanego cennika.</p>
        </div>
        <div className="pr-buttons">
          <button
            className="button"
            disabled={gate.busy || saving}
            onClick={() => void gate.load()}
          >
            <RefreshCw size={16} /> Odśwież definicje
          </button>
          {gate.available && !gate.readonly && !gate.blocked && (
            <button className="button primary" disabled={saving} onClick={() => edit()}>
              <Plus size={16} /> Nowa reguła
            </button>
          )}
        </div>
      </div>
      <ProductRuleSchedules readOnly={gate.readonly} refresh={refresh} />
      <div className="pr-body">
        <GateNotice gate={gate} />
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {gate.available && !gate.blocked && (
          <>
            <p>
              Niższy priorytet działa wcześniej. Warunki wszystkich reguł sprawdzane są na
              pierwotnych danych produktu; późniejsza akcja może nadpisać wcześniejszą.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Reguła / zdarzenie</th>
                    <th>Aktywność</th>
                    <th>Priorytet / wersja</th>
                    <th>Definicja</th>
                    <th>Obsługa</th>
                  </tr>
                </thead>
                <tbody>
                  {gate.list!.data.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.name}</strong>
                        <small>{eventNames[r.event]}</small>
                      </td>
                      <td>
                        {r.enabled ? 'Aktywna' : 'Wyłączona'}
                        {r.approved_at && <small>Zatwierdzono {date(r.approved_at)}</small>}
                      </td>
                      <td>
                        {r.definition.priority}
                        <small>Wersja {r.version}</small>
                      </td>
                      <td>
                        <details>
                          <summary>Warunki i akcje</summary>
                          <DefinitionSummary definition={r.definition} />
                        </details>
                      </td>
                      <td>
                        <div className="pr-buttons">
                          <button
                            className="button"
                            disabled={gate.readonly || saving}
                            onClick={() => edit(r)}
                          >
                            Edytuj
                          </button>
                          {r.enabled && (
                            <button
                              className="button"
                              disabled={gate.readonly || saving}
                              onClick={() => edit(r, { ...clone(r.definition), enabled: false })}
                            >
                              Wyłącz
                            </button>
                          )}
                          <button
                            className="button"
                            disabled={gate.readonly || saving}
                            onClick={() => {
                              setEditor(null);
                              setArchive({ rule: clone(r), confirmed: false, attempted: false });
                              setNotice('');
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
            {!gate.list!.data.length && (
              <p className="empty">
                Brak reguł produktów. Nowa reguła rozpoczyna się jako wyłączony szkic.
              </p>
            )}
            {gate.list?.meta?.cursor && (
              <button
                className="button"
                disabled={gate.busy || saving}
                onClick={() => void gate.load(gate.list!.meta!.cursor)}
              >
                Więcej definicji
              </button>
            )}
            {archive && (
              <div className="pr-review">
                <h3>Archiwizacja: {archive.rule.name}</h3>
                <p>
                  Wyłączy regułę i usunie ją z bieżącej listy. Zachowa historię wykonania.
                  Zarchiwizowanej reguły nie można ponownie edytować; już wykonane zmiany produktów
                  pozostają.
                </p>
                {archive.attempted && (
                  <p className="notice">
                    Zapis mógł już się udać. Ponów ten sam zapis archiwizacji dla tej samej wersji.
                  </p>
                )}
                <label className="pr-check">
                  <input
                    type="checkbox"
                    checked={archive.confirmed}
                    disabled={saving || gate.readonly}
                    onChange={(e) => setArchive({ ...archive, confirmed: e.target.checked })}
                  />
                  Potwierdzam archiwizację tej reguły, wersja {archive.rule.version}.
                </label>
                <div className="pr-buttons">
                  <button
                    className="button primary"
                    disabled={!archive.confirmed || saving || gate.readonly}
                    onClick={archiveRule}
                  >
                    {archive.attempted ? 'Ponów archiwizację tej wersji' : 'Zarchiwizuj regułę'}
                  </button>
                  <button className="button" disabled={saving} onClick={() => setArchive(null)}>
                    Zamknij podsumowanie
                  </button>
                </div>
              </div>
            )}
            {editor && (
              <RuleEditor
                key={editor.serial}
                base={editor.rule}
                initial={editor.definition}
                current={gate.list!.data.find((r) => r.id === editor.rule?.id)}
                readonly={gate.readonly}
                extended={gate.list?.price_tags_available===true}
                onBlocked={gate.fail}
                onReload={() => gate.load()}
                onCurrent={(r) => edit(r)}
                onClose={() => setEditor(null)}
                onSaved={async () => {
                  setEditor(null);
                  setNotice('Zapisano definicję reguły.');
                  setHistoryRefresh((n) => n + 1);
                  onChanged?.();
                  await gate.load();
                }}
              />
            )}
            <RunHistory refresh={refresh + historyRefresh} onBlocked={gate.fail} />
          </>
        )}
      </div>
    </section>
  );
}

function newCondition(field: Condition['field']): Condition {
  return field === 'active'
    ? { field, op: 'eq', value: true }
    : field === 'tag'?{field,op:'contains',value:''}:field === 'attribute'
      ? { field, key: '', op: 'eq', value: '' }
      : { field, op: 'eq', value: field === 'kind' ? 'simple' : '' };
}
function withOperator(c: Condition, op: Condition['op']): Condition {
  if (c.field === 'active') return c;
  if(c.field==='tag')return {...c,op:op==='not_contains'?'not_contains':'contains'};
  if (c.field === 'attribute' && (op === 'exists' || op === 'not_exists'))
    return { field: c.field, key: c.key, op };
  const value = 'value' in c && typeof c.value === 'string' ? c.value : '';
  return c.field === 'attribute'
    ? { field: c.field, key: c.key, op: op as 'eq' | 'not_eq' | 'contains' | 'prefix', value }
    : { field: c.field, op: op as 'eq' | 'not_eq' | 'contains' | 'prefix', value };
}
function ConditionFields({ value, change,extended }: { value: Condition; change: (c: Condition) => void;extended:boolean }) {
  const ops =
    value.field === 'active'
      ? ['eq']
      : value.field==='tag'?['contains','not_contains']:value.field === 'attribute'
        ? ['eq','not_eq','contains','prefix','exists','not_exists']
        : ['eq', 'not_eq', 'contains', 'prefix'];
  return (
    <div className="pr-field-grid">
      <label>
        Pole
        <select
          value={value.field}
          onChange={(e) => change(newCondition(e.target.value as Condition['field']))}
        >
          {Object.entries(fieldNames).map(([id, n]) => (
            <option key={id} value={id} disabled={id==='tag'&&!extended}>
              {n}
            </option>
          ))}
        </select>
      </label>
      {value.field === 'attribute' && (
        <label>
          Dokładny klucz atrybutu
          <input
            maxLength={80}
            value={value.key}
            required
            onChange={(e) => change({ ...value, key: e.target.value })}
          />
        </label>
      )}
      <label>
        Porównanie
        <select
          value={value.op}
          onChange={(e) => change(withOperator(value, e.target.value as Condition['op']))}
        >
          {ops.map((o) => (
            <option key={o} value={o}>
              {opNames[o as keyof typeof opNames]}
            </option>
          ))}
        </select>
      </label>
      {value.field === 'active' ? (
        <label>
          Wartość
          <select
            value={String(value.value)}
            onChange={(e) => change({ ...value, value: e.target.value === 'true' })}
          >
            <option value="true">Aktywny</option>
            <option value="false">Nieaktywny</option>
          </select>
        </label>
      ) : (
        'value' in value &&
        (value.field === 'kind' && ['eq', 'not_eq'].includes(value.op) ? (
          <label>
            Typ produktu
            <select
              value={value.value}
              onChange={(e) => change({ ...value, value: e.target.value })}
            >
              {!Object.hasOwn(kindNames, value.value) && (
                <option value={value.value}>{value.value || '(pusta wartość)'}</option>
              )}
              {Object.entries(kindNames).map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            Wartość porównania
            <input
              maxLength={value.field === 'attribute' ? 500 : 200}
              value={value.value}
              onChange={(e) => change({ ...value, value: e.target.value })}
            />
          </label>
        ))
      )}
    </div>
  );
}
function newAction(type:Action['type']):Action{
  switch(type){
    case 'set_category':return {type,category:''};case 'set_attribute':return {type,key:'',value:''};case 'remove_attribute':return {type,key:''};
    case 'add_tags':case 'remove_tags':case 'replace_tags':return {type,tags:[]};
    case 'set_price':return {type,price_list_id:'',amount_minor:0};case 'adjust_price':return {type,price_list_id:'',delta_minor:0};
    case 'multiply_price':return {type,price_list_id:'',numerator:1,denominator:1};
  }
}
function RulePriceTarget({value,change}:{value:string;change:(id:string)=>void}){
  const [lists,setLists]=useState<{id:string;name:string;currency:string}[]>([]),[error,setError]=useState('');
  useEffect(()=>{let alive=true;void (async()=>{
    try{let cursor:string|null=null;const all:{id:string;name:string;currency:string}[]=[];const seen=new Set<string>();
      do{const r:{data:{id:string;name:string;currency:string}[];meta:{cursor:string|null}}=await api('/price-lists?limit=100&active=true'+(cursor?'&after='+encodeURIComponent(cursor):''));
        if(!Array.isArray(r.data)||!r.meta||all.length+r.data.length>100)throw new Error('Nie można odczytać całej listy cenników.');
        for(const row of r.data){if(typeof row.id!=='string'||seen.has(row.id)||typeof row.name!=='string'||typeof row.currency!=='string')throw new Error('Nieprawidłowa lista cenników.');seen.add(row.id);all.push(row);}
        cursor=r.meta.cursor;if(cursor!==null&&typeof cursor!=='string')throw new Error('Nieprawidłowa strona cenników.');
      }while(cursor);
      if(alive)setLists(all);
    }catch(e){if(alive){setLists([]);setError(e instanceof Error?e.message:'Nie można odczytać cenników.');}}
  })();return()=>{alive=false;};},[]);
  return <label>Cennik<select required value={value} onChange={e=>change(e.target.value)}><option value="">Wybierz cennik</option>
    {value&&!lists.some(l=>l.id===value)&&<option value={value}>Cennik niedostępny — wybierz ponownie</option>}
    {lists.map(l=><option key={l.id} value={l.id}>{l.name} · {l.currency}</option>)}
  </select>{error&&<span role="alert">{error}</span>}</label>;
}
function ActionFields({value,change,extended}:{value:Action;change:(a:Action)=>void;extended:boolean}){
  return <div className="pr-field-grid"><label>Akcja<select value={value.type} onChange={e=>change(newAction(e.target.value as Action['type']))}>
    {Object.entries(actionNames).map(([id,label])=><option key={id} value={id} disabled={!extended&&!['set_category','set_attribute','remove_attribute'].includes(id)}>{label}</option>)}
  </select></label>
  {value.type==='set_category'&&<label>Docelowa kategoria<input maxLength={80} required value={value.category} onChange={e=>change({...value,category:e.target.value})}/></label>}
  {'key' in value&&<label>Dokładny klucz atrybutu<input maxLength={80} required value={value.key} onChange={e=>change({...value,key:e.target.value})}/></label>}
  {value.type==='set_attribute'&&<label>Docelowa wartość (może być pusta)<input maxLength={500} value={value.value} onChange={e=>change({...value,value:e.target.value})}/></label>}
  {'tags' in value&&<label>Tagi — po jednym w wierszu<textarea value={value.tags.join('\n')} onChange={e=>change({...value,tags:e.target.value.split('\n').filter(Boolean)})}/><small>Do 20 tagów. Zastąpienie pustą listą usuwa wszystkie tagi.</small></label>}
  {'price_list_id' in value&&<><RulePriceTarget value={value.price_list_id} change={id=>change({...value,price_list_id:id})}/>
    {value.type==='set_price'&&<label>Cena brutto — najmniejsze jednostki waluty<input type="number" min={0} max={100000000} step={1} required value={value.amount_minor} onChange={e=>change({...value,amount_minor:Number(e.target.value)})}/></label>}
    {value.type==='adjust_price'&&<label>Zmiana — najmniejsze jednostki waluty, ze znakiem<input type="number" min={-100000000} max={100000000} step={1} required value={value.delta_minor} onChange={e=>change({...value,delta_minor:Number(e.target.value)})}/></label>}
    {value.type==='multiply_price'&&<><label>Licznik<input type="number" min={1} max={1000000} value={value.numerator} onChange={e=>change({...value,numerator:Number(e.target.value)})}/></label><label>Mianownik<input type="number" min={1} max={1000000} value={value.denominator} onChange={e=>change({...value,denominator:Number(e.target.value)})}/></label></>}
    <small>100 najmniejszych jednostek to 1,00 w walucie cennika. Bez przeliczania walut; mnożenie zaokrągla po każdej akcji.</small>
  </>}
  </div>;
}
function RuleEditor({
  base,
  initial,
  current,
  readonly,
  extended,
  onBlocked,
  onReload,
  onCurrent,
  onClose,
  onSaved,
}: {
  base?: Rule;
  initial?: Definition;
  current?: Rule;
  readonly: boolean;
  extended:boolean;
  onBlocked: (e: unknown) => void;
  onReload: () => Promise<void>;
  onCurrent: (r: Rule) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [definition, setDefinition] = useState(() =>
    clone(initial ?? base?.definition ?? newDefinition()),
  );
  const [consent, setConsent] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [pending, setPending] = useState<{ path: string; method: string; body: unknown } | null>(
    null,
  );
  const clientKey = useRef(crypto.randomUUID()),
    mutation = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (readonly) {
      setConsent(false);
      setReviewed(false);
    }
  }, [readonly]);
  const changed = !!base && !!current && current.version !== base.version;
  const locked = readonly || busy || !!pending;
  function update(d: Definition) {
    setDefinition(d);
    setConsent(false);
    setReviewed(false);
    setError('');
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (
      readonly ||
      mutation.current ||
      busy ||
      !reviewed ||
      (definition.enabled && !consent) ||
      changed
    )
      return;
    const problem = definitionProblem(definition);
    if (problem) {
      setError(problem);
      return;
    }
    const attempt = pending ?? {
      path: '/product-rules' + (base ? '/' + base.id : ''),
      method: base ? 'PUT' : 'POST',
      body: base
        ? {
            version: base.version,
            definition: clone(definition),
            confirm_future_changes: definition.enabled && consent,
          }
        : {
            client_key: clientKey.current,
            definition: clone(definition),
            confirm_future_changes: definition.enabled && consent,
          },
    };
    mutation.current = true;
    setPending(attempt);
    setBusy(true);
    setError('');
    try {
      await api(attempt.path, attempt.method, attempt.body);
      if (alive.current) await onSaved();
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        onBlocked(e);
        if (e instanceof ApiError && [409, 422].includes(e.status)) {
          setPending(null);
          setConsent(false);
          setReviewed(false);
        }
      }
    } finally {
      mutation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <form className="pr-editor" onSubmit={save}>
      <h3>
        {base
          ? 'Edycja: ' + base.name + ' · wersja ' + base.version
          : 'Nowa reguła — wyłączony szkic'}
      </h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <p className="notice">
          Treść próby jest zachowana. Po utracie odpowiedzi zapis mógł się udać. Ponów identyczne
          żądanie lub odśwież definicje, aby sprawdzić bieżącą wersję.
        </p>
      )}
      {changed && (
        <div className="pr-review">
          <p className="error">
            Reguła ma już wersję {current!.version}. Szkic pozostaje oparty na wersji{' '}
            {base!.version}; zapis jest wstrzymany.
          </p>
          <details>
            <summary>Bieżąca definicja</summary>
            <DefinitionSummary definition={current!.definition} />
          </details>
          <button
            type="button"
            className="button"
            disabled={busy || readonly}
            onClick={() => onCurrent(current!)}
          >
            Rozpocznij edycję bieżącej wersji
          </button>
        </div>
      )}
      <fieldset disabled={locked}>
        <div className="pr-field-grid">
          <label>
            Nazwa
            <input
              required
              maxLength={120}
              value={definition.name}
              onChange={(e) => update({ ...definition, name: e.target.value })}
            />
          </label>
          <label>
            Zdarzenie
            <select
              value={definition.event}
              onChange={(e) =>
                update({ ...definition, event: e.target.value as Definition['event'] })
              }
            >
              {Object.entries(eventNames).map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priorytet — niższy pierwszy
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              required
              value={definition.priority}
              onChange={(e) => update({ ...definition, priority: Number(e.target.value) })}
            />
          </label>
        </div>
        <h4>Wszystkie warunki (AND) · {definition.conditions.length} / 10</h4>
        {!definition.conditions.length && (
          <p className="notice">Brak warunków: każdy produkt objęty zdarzeniem spełni regułę.</p>
        )}
        {definition.conditions.map((c, i) => (
          <div className="pr-editor-row" key={i}>
            <ConditionFields
              extended={extended}
              value={c}
              change={(v) =>
                update({
                  ...definition,
                  conditions: definition.conditions.map((x, j) => (j === i ? v : x)),
                })
              }
            />
            <button
              type="button"
              className="button"
              onClick={() =>
                update({
                  ...definition,
                  conditions: definition.conditions.filter((_, j) => j !== i),
                })
              }
            >
              Usuń warunek {i + 1}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button"
          disabled={definition.conditions.length >= 10}
          onClick={() =>
            update({ ...definition, conditions: [...definition.conditions, newCondition('sku')] })
          }
        >
          Dodaj warunek
        </button>
        <p>
          Porównania rozróżniają wielkość liter. „Atrybut jest inny” może pasować także, gdy go
          brak; dodaj „istnieje”, jeżeli jest wymagany.
        </p>
        {!extended&&<p className="notice">Ta kopia udostępnia tylko akcje kategorii i atrybutów. Ceny i tagi są niedostępne.</p>}
        <h4>Akcje w kolejności · {definition.actions.length} / 5</h4>
        {definition.actions.map((a, i) => (
          <div className="pr-editor-row" key={i}>
            <ActionFields
              value={a}
              extended={extended}
              change={(v) =>
                update({
                  ...definition,
                  actions: definition.actions.map((x, j) => (j === i ? v : x)),
                })
              }
            />
            <div className="pr-buttons">
              <button
                type="button"
                className="button"
                disabled={i === 0}
                onClick={() => {
                  const actions = [...definition.actions];
                  [actions[i - 1], actions[i]] = [actions[i], actions[i - 1]];
                  update({ ...definition, actions });
                }}
              >
                Wcześniej
              </button>
              <button
                type="button"
                className="button"
                disabled={i === definition.actions.length - 1}
                onClick={() => {
                  const actions = [...definition.actions];
                  [actions[i], actions[i + 1]] = [actions[i + 1], actions[i]];
                  update({ ...definition, actions });
                }}
              >
                Później
              </button>
              <button
                type="button"
                className="button"
                disabled={definition.actions.length <= 1}
                onClick={() =>
                  update({ ...definition, actions: definition.actions.filter((_, j) => j !== i) })
                }
              >
                Usuń akcję {i + 1}
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="button"
          disabled={definition.actions.length >= 5}
          onClick={() =>
            update({ ...definition, actions: [...definition.actions, newAction('set_attribute')] })
          }
        >
          Dodaj akcję
        </button>
        <p>
          Pusta wartość atrybutu oznacza jego zachowanie z pustą treścią. Usunięcie wymaga osobnej
          akcji. Produkt może mieć do 50 atrybutów.
        </p>
        <label className="pr-check">
          <input
            type="checkbox"
            checked={definition.enabled}
            onChange={(e) => update({ ...definition, enabled: e.target.checked })}
          />
          Włącz dla przyszłych zdarzeń
        </label>
      </fieldset>
      <div className="pr-review">
        <h4>Podsumowanie definicji do zapisu</h4>
        <DefinitionSummary definition={definition} />
        <p>
          To podsumowanie reguły, nie podgląd wyników dla produktów. Podgląd partii jest dostępny
          dla aktywnych, zatwierdzonych reguł.
        </p>
      </div>
      {definition.enabled && (
        <label className="pr-check">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy || readonly}
            onChange={(e) => setConsent(e.target.checked)}
          />
          Potwierdzam automatyczne zmiany kategorii, atrybutów, tagów i cen dla przyszłych produktów
          spełniających tę regułę. Sprawdziłem warunki i akcje.
        </label>
      )}
      <label className="pr-check">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={busy || readonly}
          onChange={(e) => setReviewed(e.target.checked)}
        />
        Sprawdziłem powyższą definicję do zapisu.
      </label>
      <div className="pr-buttons">
        <button
          className="button primary"
          disabled={readonly || busy || changed || !reviewed || (definition.enabled && !consent)}
        >
          {pending
            ? 'Ponów identyczny zapis'
            : definition.enabled
              ? 'Zapisz aktywną regułę'
              : 'Zapisz wyłączoną regułę'}
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => void onReload()}>
          Odśwież definicje
        </button>
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          Zamknij szkic
        </button>
      </div>
    </form>
  );
}

function diff(item: RunItem) {
  const rows: { key: string; before?: string; after?: string }[] = [];
  if (item.source.category !== item.projected.category)
    rows.push({ key: 'Kategoria', before: item.source.category, after: item.projected.category });
  for (const key of [
    ...new Set([...Object.keys(item.source.attributes), ...Object.keys(item.projected.attributes)]),
  ].sort()) {
    const oldHas = Object.hasOwn(item.source.attributes, key),
      newHas = Object.hasOwn(item.projected.attributes, key);
    if (oldHas !== newHas || (oldHas && !attributeValuesEqual(item.source.attributes[key]!, item.projected.attributes[key]!)))
      rows.push({
        key: 'Atrybut: ' + key,
        before: oldHas ? attributeValueText(item.source.attributes[key]) : undefined,
        after: newHas ? attributeValueText(item.projected.attributes[key]) : undefined,
      });
  }
  if(item.source.tags!==undefined&&JSON.stringify(item.source.tags)!==JSON.stringify(item.projected.tags))rows.push({key:'Tagi',before:item.source.tags.join(', ')||'(brak)',after:item.projected.tags?.join(', ')||'(brak)'});
  for(const [id,amount] of Object.entries(item.projected.price_targets??{})){
    const target=item.source.price_targets?.[id];if(target&&(!target.snapshot.override_present||target.snapshot.override_price!==amount))rows.push({key:'Cennik: '+target.frame.list.name,before:(target.snapshot.effective_price===null?'(brak ceny)':(target.snapshot.effective_price/100).toFixed(2)+' '+target.frame.list.currency)+(target.snapshot.override_present?'':' · cena wyliczona'),after:(amount/100).toFixed(2)+' '+target.frame.list.currency+' · cena zapisana w cenniku'});
  }
  return rows;
}
function RunView({ run }: { run: Run }) {
  const changedInPreview = run.items.filter((i) => diff(i).length > 0).length;
  return (
    <div className="pr-run-view">
      <h3>{runNames[run.state]}</h3>
      <p>
        {date(run.created_at)} · {eventNames[run.event]} ·{' '}
        {run.origin === 'manual' ? 'Ręcznie wybrane produkty' : 'Automatycznie po zapisie produktu'}{' '}
        · {run.items.length} produktów
      </p>
      {run.state === 'preview' && (
        <p>
          Podgląd: {changedInPreview} ze zmianą, {run.items.length - changedInPreview} bez zmian.
          Jeszcze nie wykonano. Ważny do {date(run.expires_at)}.
        </p>
      )}
      {run.state === 'queued' && (
        <p className="notice">
          Sukces zlecenia oznacza trwałą kolejkę. Wynik zmian nie jest jeszcze potwierdzony.
          Zamknięcie widoku nie anuluje wykonania.
        </p>
      )}
      {run.state === 'done' && (
        <p role="status">
          Potwierdzony wynik:{' '}
          {run.result.changed ?? run.items.filter((i) => i.state === 'changed').length} zmienionych,{' '}
          {run.result.skipped ?? run.items.filter((i) => i.state === 'skipped').length} bez zmian.
        </p>
      )}
      {run.state === 'failed' && (
        <p className="error" role="alert">
          {run.error ?? 'Wykonanie zatrzymane.'}
          {run.result.rolled_back && run.result.changed === 0
            ? ' Cała partia wycofana — 0 zmian.'
            : ' Sprawdź dowody poniżej; nie uruchamiaj automatycznej nowej próby.'}
        </p>
      )}
      <details>
        <summary>Zamrożone reguły i kolejność</summary>
        {run.rules.map((r, i) => (
          <article className="pr-frozen-rule" key={r.id}>
            <h4>
              {i + 1}. {r.definition.name} · wersja {r.version}
            </h4>
            <DefinitionSummary definition={r.definition} />
          </article>
        ))}
      </details>
      <p>
        Warunki oceniono na oryginalnych danych. Późniejsza akcja może nadpisać wcześniejszą. Dane
        źródłowe poniżej przedstawiają chwilę podglądu, nie dzisiejszy katalog.
      </p>
      <div className="pr-product-results">
        {run.items.map((item) => (
          <article className="pr-product-result" key={item.product_id}>
            <h4>
              {item.source.sku} · {item.source.name}
            </h4>
            <p>
              Wersja wejściowa {item.source_version}
              {item.result_version !== null ? ' → wynikowa ' + item.result_version : ''} ·{' '}
              {run.state === 'preview'
                ? diff(item).length
                  ? 'Przewidziano zmianę'
                  : 'Bez zmian'
                : itemNames[item.state]}
            </p>
            <p>
              Dopasowane reguły:{' '}
              {item.matched_rules
                .map((id) => run.rules.find((r) => r.id === id)?.definition.name ?? id)
                .join(', ') || 'brak'}
            </p>
            {item.error && <p className="error">{item.error}</p>}
            {diff(item).length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Pole</th>
                      <th>Przed</th>
                      <th>Docelowo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff(item).map((d) => (
                      <tr key={d.key}>
                        <th>{d.key}</th>
                        <td>
                          <pre>
                            {d.before === undefined
                              ? '(nie istnieje)'
                              : d.before === ''
                                ? '(pusta wartość)'
                                : d.before}
                          </pre>
                        </td>
                        <td>
                          <pre>
                            {d.after === undefined
                              ? '(usunięty)'
                              : d.after === ''
                                ? '(pusta wartość)'
                                : d.after}
                          </pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>Brak różnic — no-op nie zwiększa wersji produktu.</p>
            )}
            <details>
              <summary>Pełny zamrożony stan produktu</summary>
              <h5>Źródło</h5>
              <pre>{JSON.stringify(item.source, null, 2)}</pre>
              <h5>Docelowe dane i ceny</h5>
              <pre>{JSON.stringify(item.projected, null, 2)}</pre>
            </details>
          </article>
        ))}
      </div>
    </div>
  );
}
function RunHistory({
  refresh,
  onBlocked,
  onChoose,
}: {
  refresh: number;
  onBlocked: (e: unknown) => void;
  onChoose?: () => void;
}) {
  const [heads, setHeads] = useState<{ data: RunHead[]; meta: { cursor: string | null } } | null>(
      null,
    ),
    [run, setRun] = useState<Run | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0),
    detailGeneration = useRef(0),
    alive = useRef(true);
  async function load(after?: string | null) {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const d = await api<NonNullable<typeof heads>>(
        '/product-rule-runs' + (after ? '?after=' + encodeURIComponent(after) : ''),
      );
      if (alive.current && current === generation.current)
        setHeads((old) => ({ ...d, data: after ? unique(old?.data ?? [], d.data) : d.data }));
    } catch (e) {
      if (alive.current && current === generation.current) {
        setError((e as Error).message);
        onBlocked(e);
      }
    } finally {
      if (alive.current && current === generation.current) setBusy(false);
    }
  }
  async function choose(id: string) {
    const current = ++detailGeneration.current;
    onChoose?.();
    setRun(null);
    setBusy(true);
    setError('');
    try {
      const d = await api<Run>('/product-rule-runs/' + id);
      if (alive.current && current === detailGeneration.current) setRun(d);
    } catch (e) {
      if (alive.current && current === detailGeneration.current) {
        setError((e as Error).message);
        onBlocked(e);
      }
    } finally {
      if (alive.current && current === detailGeneration.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      ++generation.current;
      ++detailGeneration.current;
    };
  }, [refresh]);
  return (
    <div className="pr-history">
      <div className="pr-buttons">
        <h3>Historia wykonań</h3>
        <button className="button" disabled={busy} onClick={() => void load()}>
          Odśwież historię
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {heads && (
        <>
          <div className="pr-history-list">
            {heads.data.map((h) => (
              <button
                className={'button ' + (run?.id === h.id ? 'active' : '')}
                key={h.id}
                disabled={busy}
                onClick={() => void choose(h.id)}
              >
                {date(h.created_at)} · {eventNames[h.event]} ·{' '}
                {h.origin === 'manual' ? 'Ręczne' : 'Po zapisie katalogu'} · {runNames[h.state]} ·{' '}
                {h.product_count} produktów
              </button>
            ))}
          </div>
          {!heads.data.length && <p>Brak zapisanych wykonań.</p>}
          {heads.meta.cursor && (
            <button className="button" disabled={busy} onClick={() => void load(heads.meta.cursor)}>
              Starsze wykonania
            </button>
          )}
        </>
      )}
      {run && (
        <>
          <button className="button" disabled={busy} onClick={() => void choose(run.id)}>
            Odśwież wynik tego wykonania
          </button>
          <RunView run={run} />
        </>
      )}
    </div>
  );
}

export function ProductRuleBulkPreview(props: CommonProps & { products: ProductRuleSelection }) {
  if (!props.admin) return <AdminRequired />;
  return <ProductRuleBulkInner key={props.workspaceId + ':admin'} {...props} />;
}
function ProductRuleBulkInner({
  readOnly,
  refresh = 0,
  products,
  onChanged,
}: CommonProps & { products: ProductRuleSelection }) {
  const gate = useRules(readOnly, refresh);
  const [event, setEvent] = useState<Definition['event']>('product.updated'),
    [chosen, setChosen] = useState<Record<string, number>>({}),
    [run, setRun] = useState<Run | null>(null),
    [consent, setConsent] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [historyRefresh, setHistoryRefresh] = useState(0),
    [now, setNow] = useState(Date.now());
  const previewAttempt = useRef<{ signature: string; key: string } | null>(null),
    mutation = useRef(false),
    generation = useRef(0),
    alive = useRef(true);
  const productKey = products
    .map((p) => p.product_id + ':' + p.version)
    .sort()
    .join('|');
  const rulesKey = Object.keys(chosen)
    .sort()
    .map((id) => id + ':' + chosen[id])
    .join('|');
  const inputKey = productKey + ':' + event + ':' + rulesKey;
  const inputRef = useRef(inputKey);
  inputRef.current = inputKey;
  const runFence = run ? run.id + ':' + run.scope_hash : '';
  const fenceRef = useRef(runFence);
  fenceRef.current = runFence;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++generation.current;
    };
  }, []);
  useEffect(() => {
    ++generation.current;
    setRun(null);
    setConsent('');
    setError('');
    setNotice('');
    previewAttempt.current = null;
  }, [inputKey]);
  useEffect(() => {
    setConsent('');
    if (gate.blocked) {
      ++generation.current;
      setRun(null);
    }
  }, [gate.readonly, gate.blocked]);
  useEffect(() => {
    if (run?.state !== 'preview') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run?.id, run?.state]);
  const invalidSelection =
    products.length < 1
      ? 'Zaznacz przynajmniej jeden produkt.'
      : products.length > 100
        ? 'Partia reguł ma maksymalnie 100 produktów. Zmniejsz wybór; żadnej pozycji nie obcinamy automatycznie.'
        : new Set(products.map((p) => p.product_id)).size !== products.length
          ? 'Wybór zawiera powtórzone produkty.'
          : products.some((p) => !Number.isInteger(p.version) || p.version < 1)
            ? 'Produkt wymaga konkretnej dodatniej wersji.'
            : '';
  const ruleEntries = Object.entries(chosen);
  const staleRules = ruleEntries.some(([id, version]) => {
    const r = gate.list?.data.find((r) => r.id === id);
    return !r || r.version !== version || !r.enabled || !r.approved_at || r.event !== event;
  });
  const writable = gate.available && !gate.readonly && !gate.blocked;
  const expired = !!run && new Date(run.expires_at).getTime() <= now;
  function clearPlan() {
    ++generation.current;
    setRun(null);
    setConsent('');
    setNotice('');
  }
  function fail(e: unknown) {
    setError((e as Error).message);
    setConsent('');
    gate.fail(e);
  }
  async function preview() {
    if (
      !writable ||
      mutation.current ||
      busy ||
      invalidSelection ||
      !ruleEntries.length ||
      ruleEntries.length > 100 ||
      staleRules
    )
      return;
    const signature = inputRef.current;
    if (previewAttempt.current?.signature !== signature)
      previewAttempt.current = { signature, key: crypto.randomUUID() };
    const clientKey = previewAttempt.current.key,
      current = ++generation.current;
    mutation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setRun(null);
    setConsent('');
    try {
      const d = await api<Run>('/product-rule-runs/preview', 'POST', {
        client_key: clientKey,
        event,
        rule_ids: Object.keys(chosen).sort(),
        items: [...products]
          .sort((a, b) => (a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0))
          .map((p) => ({ product_id: p.product_id, version: p.version })),
      });
      if (previewAttempt.current?.key === clientKey) previewAttempt.current = null;
      if (alive.current && current === generation.current && signature === inputRef.current) {
        setRun(d);
        setHistoryRefresh((n) => n + 1);
      }
    } catch (e) {
      if (alive.current && (current === generation.current || fatalAccessError(e))) fail(e);
    } finally {
      mutation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function refreshRun() {
    if (!run || busy) return;
    const id = run.id,
      current = ++generation.current;
    setBusy(true);
    setError('');
    setConsent('');
    try {
      const d = await api<Run>('/product-rule-runs/' + id);
      if (alive.current && current === generation.current) {
        setRun(d);
        if (d.state === 'done' && run.state !== 'done') onChanged?.();
      }
    } catch (e) {
      if (alive.current && (current === generation.current || fatalAccessError(e))) fail(e);
    } finally {
      if (alive.current && current === generation.current) setBusy(false);
    }
  }
  async function queue() {
    if (
      !run ||
      run.state !== 'preview' ||
      run.origin !== 'manual' ||
      !writable ||
      expired ||
      consent !== runFence ||
      mutation.current ||
      busy
    )
      return;
    const frozen = run,
      fence = runFence,
      current = ++generation.current;
    mutation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/product-rule-runs/' + frozen.id + '/queue', 'POST', {
        confirmed: true,
        scope_hash: frozen.scope_hash,
      });
      if (!alive.current || current !== generation.current || fence !== fenceRef.current) return;
      setConsent('');
      setNotice('Zlecono trwałą partię. Wynik zmian wymaga odczytu wykonania.');
      setHistoryRefresh((n) => n + 1);
      onChanged?.();
      const d = await api<Run>('/product-rule-runs/' + frozen.id);
      if (alive.current && current === generation.current && fence === fenceRef.current) setRun(d);
    } catch (e) {
      if (alive.current && (current === generation.current || fatalAccessError(e))) {
        fail(e);
        setNotice(
          'Jeśli utracono odpowiedź zlecenia, najpierw odśwież ten sam wynik. Nie przygotowuj automatycznie nowej próby.',
        );
      }
    } finally {
      mutation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="product-rules-panel product-rule-bulk">
      <h2>Podgląd reguł dla wybranych produktów</h2>
      <p>
        Dokładnie wybrane produkty: {products.length}. Zapis obejmuje lokalne dane, tagi i ceny cenników; nie wykonuje operacji u dostawców.
      </p>
      <GateNotice gate={gate} />
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
      {invalidSelection && (
        <p className="error" role="alert">
          {invalidSelection}
        </p>
      )}
      {gate.available && !gate.blocked && (
        <>
          <details>
            <summary>Wybrane produkty i wersje</summary>
            <ul>
              {products.map((p, i) => (
                <li key={p.product_id + ':' + i}>
                  {p.sku ?? p.product_id}
                  {p.name ? ' · ' + p.name : ''} · wersja {p.version}
                </li>
              ))}
            </ul>
          </details>
          <div className="pr-buttons">
            <label>
              Kontekst zdarzenia
              <select
                disabled={busy || gate.readonly}
                value={event}
                onChange={(e) => {
                  setEvent(e.target.value as Definition['event']);
                  setChosen({});
                }}
              >
                {Object.entries(eventNames).map(([id, n]) => (
                  <option key={id} value={id}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button"
              disabled={busy || gate.busy}
              onClick={() => {
                clearPlan();
                void gate.load();
              }}
            >
              Odśwież reguły
            </button>
          </div>
          <p>
            Jawnie wybierz aktywne reguły pasujące do zdarzenia. Zmiana kontekstu nie tworzy ani nie
            aktualizuje produktu.
          </p>
          <div className="pr-rule-selection">
            {gate.list!.data.map((r) => {
              const eligible = r.enabled && !!r.approved_at && r.event === event;
              const selected = Object.hasOwn(chosen, r.id);
              const stale = selected && chosen[r.id] !== r.version;
              return (
                <article key={r.id}>
                  <label className="pr-check">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={busy || gate.readonly || (!eligible && !selected)}
                      onChange={(e) =>
                        setChosen((old) => {
                          const next = { ...old };
                          if (e.target.checked) next[r.id] = r.version;
                          else delete next[r.id];
                          return next;
                        })
                      }
                    />
                    <span>
                      <strong>{r.name}</strong> · wersja {r.version} · priorytet{' '}
                      {r.definition.priority}
                      <small>
                        {eventNames[r.event]} ·{' '}
                        {eligible
                          ? 'Aktywna i zatwierdzona'
                          : !r.enabled
                            ? 'Wyłączona'
                            : r.event !== event
                              ? 'Inne zdarzenie'
                              : 'Brak zatwierdzenia'}
                      </small>
                    </span>
                  </label>
                  <details>
                    <summary>Sprawdź definicję</summary>
                    <DefinitionSummary definition={r.definition} />
                  </details>
                  {stale && (
                    <div>
                      <p className="error">
                        Wybrano wersję {chosen[r.id]}, obecnie wersja {r.version}. Sprawdź zmianę.
                      </p>
                      <button
                        className="button"
                        disabled={busy || gate.readonly || !eligible}
                        onClick={() => setChosen((old) => ({ ...old, [r.id]: r.version }))}
                      >
                        Wybierz tę bieżącą wersję
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          {gate.list?.meta?.cursor && (
            <button
              className="button"
              disabled={busy || gate.busy}
              onClick={() => void gate.load(gate.list!.meta!.cursor)}
            >
              Więcej reguł
            </button>
          )}
          {!gate.list!.data.length && (
            <p>Brak aktywnych definicji do wyboru. Utwórz i zatwierdź regułę w Automatyzacjach.</p>
          )}
          <p>
            Wybrano {ruleEntries.length} reguł. Warunki oceniamy na pierwotnych danych produktu, a
            późniejsze akcje mogą nadpisać wcześniejsze.
          </p>
          {staleRules && (
            <p className="error">
              Wybrana reguła zmieniła się, jest niedostępna lub ma inne zdarzenie. Odśwież definicje
              i wybierz aktualną wersję.
            </p>
          )}
          <button
            className="button primary"
            disabled={
              busy ||
              !writable ||
              !!invalidSelection ||
              !ruleEntries.length ||
              ruleEntries.length > 100 ||
              staleRules
            }
            onClick={preview}
          >
            Przygotuj podgląd dla {products.length} produktów
          </button>
          {run && (
            <div className="pr-review">
              <div className="pr-buttons">
                <button className="button" disabled={busy} onClick={refreshRun}>
                  Odśwież wynik tego podglądu
                </button>
              </div>
              {run.rules.some((r) => chosen[r.id] !== r.version) && (
                <p className="notice">
                  Reguły zmieniły się między wyborem a podglądem. Sprawdź pokazane zamrożone wersje
                  i ich definicje przed potwierdzeniem zmian.
                </p>
              )}
              <RunView run={run} />
              {run.origin === 'manual' && run.state === 'preview' && (
                <>
                  {expired && (
                    <p className="error">
                      Podgląd wygasł. Potrzebny jest nowy podgląd i nowa zgoda.
                    </p>
                  )}
                  <label className="pr-check">
                    <input
                      type="checkbox"
                      checked={consent === runFence}
                      disabled={busy || !writable || expired}
                      onChange={(e) => setConsent(e.target.checked ? runFence : '')}
                    />
                    Sprawdziłem zmiany kategorii, atrybutów, tagów i cen dla pokazanych produktów. Potwierdzam
                    wykonanie całego tego podglądu.
                  </label>
                  <button
                    className="button primary"
                    disabled={busy || !writable || expired || consent !== runFence}
                    onClick={queue}
                  >
                    Zleć zmiany dla {run.items.length} produktów
                  </button>
                </>
              )}
            </div>
          )}
          <p>
            Cała partia jest atomowa. Konflikt jednego produktu lub reguły może zatrzymać wszystkie
            zmiany. Nie ma anulowania konkretnego zleconego wykonania.
          </p>
          <RunHistory
            refresh={refresh + historyRefresh}
            onBlocked={gate.fail}
            onChoose={clearPlan}
          />
        </>
      )}
    </section>
  );
}
