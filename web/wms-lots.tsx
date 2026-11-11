import { inventoryCorrectionRequest, inventoryCorrectionApply, inventoryCorrectionDocumentLabel } from './inventory-correction-on-model';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, date } from './api';
import { catalogStockControlLocked } from './catalog-stock-control-panel';
import './wms-lots.css';

type WmsFlags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_write: boolean;
  can_admin: boolean;
  can_read_value: boolean;
};
type Attempt = {
  path: string;
  method: string;
  body: unknown;
  label: string;
  complete: (data: any) => void;
};
class StaleWmsRead extends Error {}
const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Nie udało się wykonać operacji magazynowej.';

function useWmsIO(
  contextKey: string,
  readOnly: boolean,
  purge: () => void,
  onRejected?: (status: number) => void,
  externalWriteBlocked = false,
) {
  const externalBlocked = useRef(externalWriteBlocked);
  externalBlocked.current = externalWriteBlocked;
  const actorScope = useRef({ contextKey, readOnly });
  actorScope.current = { contextKey, readOnly };
  // IO keys may append an order/preview ID; BO uses the actual actor + restore bit.
  const boBlocked = () => catalogStockControlLocked(
    actorScope.current.contextKey.split(':').slice(0, 3).join(':') + ':' + actorScope.current.readOnly,
  );
  const live = useRef(false),
    epoch = useRef(0),
    gate = useRef(false),
    role = useRef<string | null>(null);
  const purgeRef = useRef(purge);
  purgeRef.current = purge;
  const rejectedRef = useRef(onRejected);
  rejectedRef.current = onRejected;
  const pendingRef = useRef<Attempt | null>(null);
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false);
  const [error, setError] = useState(''),
    [pending, setPending] = useState<Attempt | null>(null);
  const current = (e: number) => live.current && epoch.current === e;
  function deny() {
    ++epoch.current;
    gate.current = false;
    pendingRef.current = null;
    setBusy(false);
    setPending(null);
    setBlocked(true);
    purgeRef.current();
    setError(
      'Dostęp został cofnięty lub zmieniła się rola. Otwórz panel ponownie po odświeżeniu uprawnień.',
    );
  }
  function accept(data: Partial<WmsFlags>) {
    if (role.current && data.current_role && role.current !== data.current_role) {
      deny();
      throw new StaleWmsRead();
    }
    if (data.current_role) role.current = data.current_role;
    if (data.available && data.can_read === false) {
      deny();
      throw new StaleWmsRead();
    }
    if (data.read_only) setBlocked(true);
    if (data.can_write === false && pendingRef.current) {
      pendingRef.current = null;
      setPending(null);
      setBlocked(true);
    }
  }
  async function get<T>(path: string): Promise<T> {
    const e = epoch.current;
    try {
      const data = await api<T>(path);
      if (!current(e)) throw new StaleWmsRead();
      accept(data as Partial<WmsFlags>);
      return data;
    } catch (err) {
      if (current(e) && err instanceof ApiError && [401, 403].includes(err.status)) deny();
      throw err;
    }
  }
  async function read(task: () => Promise<void>) {
    if (!live.current || gate.current) return;
    const e = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (err) {
      if (current(e) && !(err instanceof StaleWmsRead)) setError(message(err));
    } finally {
      if (current(e)) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  async function send(a: Attempt) {
    if (
      !live.current ||
      gate.current ||
      actorScope.current.readOnly || actorScope.current.contextKey !== contextKey ||
      blocked ||
      ((externalBlocked.current || boBlocked()) && pendingRef.current !== a)
    )
      return;
    const e = epoch.current;
    gate.current = true;
    setBusy(true);
    setError('');
    pendingRef.current = a;
    setPending(a);
    try {
      const d = await api(a.path, a.method, a.body);
      if (!current(e)) return;
      accept(d);
      if (!current(e)) return;
      pendingRef.current = null;
      setPending(null);
      a.complete(d);
    } catch (err) {
      if (!current(e)) return;
      if (err instanceof ApiError && [401, 403].includes(err.status)) {
        deny();
        return;
      }
      if (err instanceof ApiError && [400, 404, 409, 413, 422, 423, 429].includes(err.status)) {
        // These responses explicitly reject this local operation. A transport/5xx failure stays frozen.
        pendingRef.current = null;
        setPending(null);
        rejectedRef.current?.(err.status);
        if (err.status === 423) setBlocked(true);
      }
      setError(message(err));
    } finally {
      if (current(e)) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  function mutate(
    path: string,
    method: string,
    body: unknown,
    label: string,
    complete: Attempt['complete'],
  ) {
    if (pendingRef.current || gate.current || actorScope.current.readOnly || actorScope.current.contextKey !== contextKey || blocked || externalBlocked.current || boBlocked())
      return;
    const text = JSON.stringify(body);
    if (new TextEncoder().encode(text).byteLength > 2097152) {
      setError('Pełne żądanie przekracza 2 MiB. Nie wysłano ani nie obcięto żadnego wiersza.');
      return;
    }
    const frozen = JSON.parse(text);
    void send({ path, method, body: frozen, label, complete });
  }
  useEffect(() => {
    live.current = true;
    ++epoch.current;
    gate.current = false;
    role.current = null;
    pendingRef.current = null;
    setPending(null);
    setBusy(false);
    setBlocked(false);
    setError('');
    return () => {
      live.current = false;
      ++epoch.current;
      gate.current = false;
      pendingRef.current = null;
    };
  }, [contextKey, readOnly]);
  return {
    get,
    read,
    mutate,
    busy,
    blocked,
    error,
    pending,
    deny,
    setError,
    locked: busy || blocked || readOnly || !!pending || externalWriteBlocked,
    retry: () => {
      if (pendingRef.current) void send(pendingRef.current);
    },
  };
}
type WmsIO = ReturnType<typeof useWmsIO>;
function IONotice({ io }: { io: WmsIO }) {
  return (
    <>
      {io.error && (
        <p className="wms-error" role="alert">
          {io.error}
        </p>
      )}
      {io.pending && (
        <div className="wms-warning" role="status">
          {io.busy ? (
            <>
              <strong>{io.pending.label}: oczekiwanie na wynik…</strong>
              <p>Trwa obsługa operacji. Poczekaj na zakończenie żądania; dokładna treść i klucz próby pozostają w pamięci panelu.</p>
            </>
          ) : (
            <>
              <strong>{io.pending.label}: wynik nie został potwierdzony.</strong>
              <p>
                Operacja mogła zostać zapisana. Zachowano dokładną treść i klucz tej próby w pamięci
                bieżącego panelu. Ponowienie nie tworzy nowej dostawy ani nowego ruchu.
              </p>
              <button
                type="button"
                className="button"
                disabled={io.busy || io.blocked}
                onClick={io.retry}
              >
                Ponów tę samą próbę
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
function exactInteger(text: string, label: string, min = 0n, max = 2147483647n): number {
  if (!/^(0|[1-9]\d*)$/.test(text))
    throw new Error(label + ': wpisz pełną liczbę całkowitą bez znaku lub wykładnika.');
  const n = BigInt(text);
  if (n < min || n > max) throw new Error(label + ': wartość poza dozwolonym zakresem.');
  return Number(n);
}
function minorFromText(text: string, exponent: number): string {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6)
    throw new Error('Nieznana dokładność waluty wyceny.');
  const s = text.replace(',', '.');
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(s))
    throw new Error(
      'Koszt wymaga nieujemnej kwoty bez znaku lub wykładnika. Puste pole nie oznacza zera.',
    );
  const [whole, frac = ''] = s.split('.');
  if (frac.length > exponent)
    throw new Error('Koszt ma zbyt wiele miejsc dziesiętnych dla tej waluty.');
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(frac.padEnd(exponent, '0') || '0');
  if (minor > 9223372036854775807n) throw new Error('Koszt przekracza dokładny zakres int64.');
  return minor.toString();
}
function exactMoney(value: string | null | undefined, currency: string, exponent: number): string {
  if (value === null || value === undefined) return 'Koszt nieznany';
  if (
    !/^-?(0|[1-9]\d*)$/.test(value) ||
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 6
  )
    return 'Nie można odczytać dokładnej kwoty';
  const n = BigInt(value),
    abs = n < 0n ? -n : n,
    scale = 10n ** BigInt(exponent);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (
    (n < 0n ? '−' : '') +
    whole +
    (exponent ? ',' + (abs % scale).toString().padStart(exponent, '0') : '') +
    ' ' +
    currency
  );
}
function Technical({
  children,
  label = 'Identyfikatory i szczegóły techniczne',
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <details className="wms-technical">
      <summary>{label}</summary>
      {children}
    </details>
  );
}

const prefix = '/wms-lots';
type Policy = {
  enabled: boolean;
  version: string;
  method: 'FIFO';
  currency: string | null;
  exponent: number;
};
type Metadata = WmsFlags & {
  policy: Policy;
  warehouses: { id: string; name: string; code: string }[];
  limits: Record<string, number>;
  can_receive: boolean;
  can_return?: boolean;
  can_issue: boolean;
  can_adjust: boolean;
  can_transfer: boolean;
  can_activate: boolean;
};
type Page<T> = WmsFlags & { data: T[]; meta: { cursor: string | null } };
type Product = { id: string; sku: string; name: string; kind: string };
type Position = {
  warehouse_id: string;
  warehouse_name: string;
  product_id: string;
  sku: string;
  name: string;
  location: string;
  lot_id: string;
  lot_code: string;
  layer_id: string;
  fifo_sequence: string;
  quantity: number;
  reserved: number;
  available: number;
  position_version: string;
  stock_version: string;
  unit_cost_minor: string | null;
  currency: string;
  value_minor: string | null;
  unknown_quantity: number | null;
};
type OpeningRow = {
  warehouse_id: string;
  product_id: string;
  sku: string;
  name: string;
  location: string;
  quantity: number;
  stock_version: string;
};
type OpeningDraft = OpeningRow & { lot_code: string; cost: string; unknown: boolean };
type PreviewHead = {
  id: string;
  kind: string;
  scope_hash: string;
  policy_version: string;
  ready: boolean;
  issues: string[];
  created_at: string;
  expires_at: string;
  total: number;
  known_minor: string | null;
  unknown_quantity: string | number | null;
  currency: string;
};
type Operation = {
  id: string;
  kind: string;
  order_id: string | null;
  warehouse_document_id: string | null;
  purchase_receipt_id: string | null;
  return_id: string | null;
  policy_version: string;
  created_at: string;
  // Additive proposed quantity-only native list projection; absent on older servers.
  correction_head?: unknown;
};
type OperationResponse = {
  correction_document?: {id:string;protocol:'wms_adjustment';operation_id:string;kind:'PW'|'RW';number:string;year:number;sequence:string;quantity:string;row_count:number;warehouse:{id:string;name:string;code:string};rows?:unknown} | null;
  operation: Operation;
  result: Record<string, any>;
  can_read_value?: boolean;
};
type CorrectionHeadView = {
  id:string;protocol:'wms_adjustment';operation_id:string;kind:'PW'|'RW';
  number:string;year:number;sequence:string;quantity:string;row_count:number;
  warehouse:{id:string;name:string;code:string};product:{id:string;sku:string;name:string};
};
type CorrectionQuantityView = CorrectionHeadView & {
  rows:{sku:string;name:string;location:string;quantity:string;delta:string}[];
};
const correctionUuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const correctionInteger=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d*$/.test(v)&&v.length<=19&&BigInt(v)<=9223372036854775807n;
function correctionKeys(v:unknown,keys:string[]):v is Record<string,unknown> {
  return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.prototype.hasOwnProperty.call(v,k));
}
function correctionHeadView(value:unknown,operation:Operation):CorrectionHeadView|null {
  if(!correctionKeys(value,['id','protocol','operation_id','kind','number','year','sequence','quantity','row_count','warehouse','product']))return null;
  const v=value;
  if(operation.kind!=='adjustment'||!correctionUuid(v.id)||v.protocol!=='wms_adjustment'||v.operation_id!==operation.id||
    !['PW','RW'].includes(v.kind as string)||!correctionInteger(v.sequence)||!Number.isInteger(v.year)||
    (v.year as number)<2000||(v.year as number)>9999||v.number!==`${v.kind}/${v.year}/${v.sequence.padStart(6,'0')}`||
    !correctionInteger(v.quantity)||!Number.isInteger(v.row_count)||(v.row_count as number)<1||(v.row_count as number)>10000||BigInt(v.quantity)<BigInt(v.row_count as number)||
    !correctionKeys(v.warehouse,['id','name','code'])||!correctionUuid(v.warehouse.id)||typeof v.warehouse.name!=='string'||typeof v.warehouse.code!=='string'||
    !correctionKeys(v.product,['id','sku','name'])||!correctionUuid(v.product.id)||typeof v.product.sku!=='string'||typeof v.product.name!=='string')return null;
  // Explicit projection prevents a financial/identity cache from widening with DTO extras.
  return {id:v.id,protocol:'wms_adjustment',operation_id:operation.id,kind:v.kind as 'PW'|'RW',number:v.number as string,
    year:v.year as number,sequence:v.sequence,quantity:v.quantity,row_count:v.row_count as number,
    warehouse:{id:v.warehouse.id,name:v.warehouse.name,code:v.warehouse.code},product:{id:v.product.id,sku:v.product.sku,name:v.product.name}};
}
function sameCorrectionHead(a:CorrectionHeadView,b:CorrectionHeadView):boolean {
  return ['id','protocol','operation_id','kind','number','year','sequence','quantity','row_count'].every(k=>a[k as keyof CorrectionHeadView]===b[k as keyof CorrectionHeadView])&&
    a.warehouse.id===b.warehouse.id&&a.warehouse.name===b.warehouse.name&&a.warehouse.code===b.warehouse.code&&
    a.product.id===b.product.id&&a.product.sku===b.product.sku&&a.product.name===b.product.name;
}
// Native correction rows are full fragments of ONE recorded product, never current PIM.
function correctionQuantityView(d:OperationResponse):CorrectionQuantityView|null {
  const v=d.correction_document;
  if(!v||!Array.isArray(v.rows)||!v.rows.length)return null;
  const first=v.rows[0] as Record<string,unknown>;
  if(!first)return null;
  const head=correctionHeadView({id:v.id,protocol:v.protocol,operation_id:v.operation_id,kind:v.kind,number:v.number,year:v.year,
    sequence:v.sequence,quantity:v.quantity,row_count:v.row_count,warehouse:v.warehouse,product:{id:first.product_id,sku:first.sku,name:first.name}},d.operation);
  if(!head||v.rows.length!==head.row_count)return null;
  const rows:CorrectionQuantityView['rows']=[];let total=0n;
  for(let i=0;i<v.rows.length;i++){
    const r=v.rows[i] as Record<string,unknown>;
    if(!r||r.ordinal!==i||r.operation_id!==d.operation.id||r.warehouse_id!==head.warehouse.id||r.product_id!==head.product.id||
      r.sku!==head.product.sku||r.name!==head.product.name||!correctionInteger(r.quantity)||BigInt(r.quantity)>2147483647n||
      r.delta!==(head.kind==='PW'?r.quantity:'-'+r.quantity)||typeof r.location!=='string')return null;
    total+=BigInt(r.quantity);rows.push({sku:head.product.sku,name:head.product.name,location:r.location,quantity:r.quantity,delta:r.delta as string});
  }
  return total===BigInt(head.quantity)?{...head,rows}:null;
}
type Allocation = {
  order_id: string;
  product_id: string;
  warehouse_id: string;
  location: string;
  layer_id: string;
  lot_id: string;
  lot_code: string;
  quantity: number;
  scanned: number;
  state: string;
  fifo_sequence: string;
};
type ReturnFragment = {
  id: string;
  product_id: string;
  lot_id: string;
  lot_code: string;
  layer_id: string;
  quantity: number;
  returned_quantity: number;
  remaining: number;
  unit_cost_minor: string | null;
  value_minor: string | null;
  currency: string;
  location: string;
};
type WorkspaceProps = {
  contextKey: string;
  readOnly: boolean;
  refresh?: number;
  onChanged?: () => void;
  externalWriteBlocked?: boolean;
};
const names: Record<string, string> = {
  opening: 'Otwarcie WMS',
  receipt: 'Przyjęcie partii',
  issue: 'Wydanie',
  transfer: 'Przesunięcie MM',
  bin_move: 'Zmiana lokalizacji',
  adjustment: 'Korekta liczby sztuk',
  order_issue: 'Wydanie zamówienia',
  dispatch: 'Wydanie zamówienia',
  reserve: 'Rezerwacja partii',
  scan: 'Skan partii',
  release: 'Zwolnienie rezerwacji',
  return: 'Przyjęcie zwrotu',
};
function exactVersion(value: unknown): string {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error('Nie można odczytać dokładnej wersji stanu. Odśwież dane.');
}
function Availability({ meta, readOnly }: { meta: Metadata | null; readOnly: boolean }) {
  return !meta ? (
    <p role="status">Wczytywanie modułu partii…</p>
  ) : !meta.available ? (
    <p className="wms-warning">
      Ta kopia nie zawiera modułu partii WMS. Dotychczasowy proces ilościowy pozostaje osobny.
    </p>
  ) : (
    <>
      {(readOnly || meta.read_only) && (
        <p className="wms-warning">Podgląd kopii — wszystkie zapisy są wyłączone.</p>
      )}
      {!meta.can_write && (
        <p className="wms-help">Dostęp tylko do odczytu w bieżącym zakresie uprawnień.</p>
      )}
      {!meta.can_read_value && (
        <p className="wms-help">
          Koszty i wartość zapasu są ukryte zgodnie z uprawnieniami. Ukryta kwota nie oznacza kosztu
          nieznanego ani zera.
        </p>
      )}
    </>
  );
}
const valuationFields = ['quantity', 'totalquantity', 'known_minor', 'unknown_quantity', 'known_quantity', 'physical_quantity', 'reserved_quantity', 'physical_available', 'sellable_quantity', 'sellable_available', 'zero_cost_quantity'] as const;
type PhysicalValuation = Record<(typeof valuationFields)[number], string> & { currency: string; exponent: number };
type ClassifiedValuation = PhysicalValuation & {
  warehouse_policy_available: boolean;
  snapshot_at: string;
  warehouses: { warehouse_id: string; name: string; code: string; policy: { usage: 'sale' | 'custody'; enabled: boolean; version: string }; valuation: PhysicalValuation }[];
  usage_buckets: { usage: 'sale' | 'custody'; valuation: PhysicalValuation }[];
};
function checkedClassification(value: Record<string, any>): ClassifiedValuation | null {
  const additions = ['warehouse_policy_available', 'snapshot_at', 'warehouses', 'usage_buckets'];
  if (additions.every(key => value[key] === undefined)) return null;
  const invalid = () => { throw new Error('Nie można potwierdzić pełnej klasyfikacji wyceny. Odczytaj zakres ponownie; nie zastąpiono brakujących danych zerami.'); };
  if (typeof value.warehouse_policy_available !== 'boolean' || typeof value.snapshot_at !== 'string' || !Number.isFinite(Date.parse(value.snapshot_at)) || !Array.isArray(value.warehouses) || value.warehouses.length > 200 || !Array.isArray(value.usage_buckets) || value.usage_buckets.length !== 2) invalid();
  const totals = (row: any): PhysicalValuation => {
    if (!row || typeof row.currency !== 'string' || !row.currency || !Number.isInteger(row.exponent) || row.exponent < 0 || row.exponent > 6) invalid();
    for (const key of valuationFields) if (typeof row[key] !== 'string' || !/^(0|[1-9]\d*)$/.test(row[key]) || BigInt(row[key]) > 9223372036854775807n) invalid();
    if (row.totalquantity !== row.quantity || row.physical_quantity !== row.quantity || BigInt(row.known_quantity) + BigInt(row.unknown_quantity) !== BigInt(row.quantity) || BigInt(row.zero_cost_quantity) > BigInt(row.known_quantity) || BigInt(row.reserved_quantity) + BigInt(row.physical_available) !== BigInt(row.quantity) || BigInt(row.sellable_quantity) > BigInt(row.quantity) || BigInt(row.sellable_available) > BigInt(row.physical_available) || BigInt(row.sellable_available) > BigInt(row.sellable_quantity)) invalid();
    return row;
  };
  totals(value);
  const warehouseIds = new Set<string>();
  for (const row of value.warehouses) {
    if (!row || typeof row.warehouse_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.warehouse_id) || warehouseIds.has(row.warehouse_id) || typeof row.name !== 'string' || typeof row.code !== 'string' || !row.policy || !['sale', 'custody'].includes(row.policy.usage) || typeof row.policy.enabled !== 'boolean' || typeof row.policy.version !== 'string' || !/^(0|[1-9]\d*)$/.test(row.policy.version) || (row.policy.version === '0' && (row.policy.usage !== 'sale' || !row.policy.enabled)) || (!value.warehouse_policy_available && (row.policy.version !== '0' || row.policy.usage !== 'sale' || !row.policy.enabled))) invalid();
    warehouseIds.add(row.warehouse_id); totals(row.valuation);
    const sale = row.policy.usage === 'sale' && row.policy.enabled;
    if (row.valuation.sellable_quantity !== (sale ? row.valuation.quantity : '0') || row.valuation.sellable_available !== (sale ? row.valuation.physical_available : '0')) invalid();
  }
  const usages = new Set<string>();
  for (const row of value.usage_buckets) {
    if (!row || !['sale', 'custody'].includes(row.usage) || usages.has(row.usage)) invalid();
    usages.add(row.usage); totals(row.valuation);
    const warehouses = value.warehouses.filter((w: ClassifiedValuation['warehouses'][number]) => w.policy.usage === row.usage);
    for (const key of valuationFields) if (warehouses.reduce((sum: bigint, w: ClassifiedValuation['warehouses'][number]) => sum + BigInt(w.valuation[key]), 0n) !== BigInt(row.valuation[key])) invalid();
  }
  for (const row of [...value.warehouses, ...value.usage_buckets]) if (row.valuation.currency !== value.currency || row.valuation.exponent !== value.exponent) invalid();
  for (const key of valuationFields) if (value.usage_buckets.reduce((sum: bigint, row: ClassifiedValuation['usage_buckets'][number]) => sum + BigInt(row.valuation[key]), 0n) !== BigInt(value[key])) invalid();
  return value as ClassifiedValuation;
}
function ValuationClassification({ value }: { value: Record<string, any> }) {
  let classification: ClassifiedValuation | null;
  try { classification = checkedClassification(value); }
  catch (err) { return <p className="wms-warning" role="alert">{message(err)}</p>; }
  if (!classification) return <p className="wms-help" role="status">Klasyfikacja SALE/CUSTODY nie jest dostępna w tej odpowiedzi. Powyższa wycena pozostaje sumą fizycznego zapasu; nie wywnioskowano przeznaczenia magazynów.</p>;
  const usageName = (usage: 'sale' | 'custody') => usage === 'sale' ? 'SALE — magazyny sprzedaży' : 'CUSTODY — fizycznie poza sprzedażą';
  const columns = (v: PhysicalValuation) => <><td>{v.physical_quantity}</td><td>{v.reserved_quantity}</td><td>{v.physical_available}</td><td>{v.sellable_quantity}</td><td>{v.sellable_available}</td><td>{v.known_quantity}</td><td>{exactMoney(v.known_minor, v.currency, v.exponent)}</td><td>{v.zero_cost_quantity}</td><td>{v.unknown_quantity}</td></>;
  return <section className="wms-card" aria-label="Bieżąca wycena fizyczna według przeznaczenia magazynów">
    <h3>Bieżąca wycena fizyczna według przeznaczenia magazynów</h3>
    <p className="wms-help">Stan wspólnego odczytu: {date(classification.snapshot_at)}. Fizyczny zapas i jego znana wartość istnieją także w CUSTODY oraz przy wyłączonej dostępności sprzedażowej. To bieżące przeznaczenie magazynu, bez przypisania zapasu do konkretnych zwrotów ani rozliczenia kosztu sprzedaży.</p>
    {!classification.warehouse_policy_available && <p className="wms-warning">Ta kopia nie zawiera ustawień przeznaczenia magazynów. Klasyfikacja korzysta z dotychczasowej polityki domyślnej SALE, włączonej, wersja 0.</p>}
    <div className="wms-scroll"><table className="wms-table"><caption>Fizyczny zapas i dostępność sprzedażowa w tym samym zakresie</caption><thead><tr><th>Zakres / polityka</th><th>Fizycznie</th><th>Zarezerwowane</th><th>Fizycznie wolne</th><th>Zapas sprzedażowy</th><th>Dostępne do sprzedaży</th><th>Sztuki o znanym koszcie</th><th>Wartość części znanej</th><th>Sztuki o koszcie zero</th><th>Sztuki o nieznanym koszcie (NULL)</th></tr></thead><tbody>
      <tr><th scope="row">Cały odczytany zakres</th>{columns(classification)}</tr>
      {classification.usage_buckets.map(row => <tr key={row.usage}><th scope="row">{usageName(row.usage)}</th>{columns(row.valuation)}</tr>)}
      {classification.warehouses.map(row => <tr key={row.warehouse_id}><th scope="row">{row.code} — {row.name}<small>{usageName(row.policy.usage)} · sprzedaż {row.policy.usage === 'sale' && row.policy.enabled ? 'włączona' : 'wyłączona'} · polityka {row.policy.enabled ? 'włączona' : 'wyłączona'} · wersja {row.policy.version}</small></th>{columns(row.valuation)}</tr>)}
    </tbody></table></div>
    <p className="wms-help">Znany koszt zero jest oddzielny od nieznanego kosztu NULL. Przy nieznanym koszcie suma części znanej nie stanowi pełnej wartości fizycznego zapasu.</p>
  </section>;
}
function Valuation({
  value,
  currency,
  exponent,
  permitted,
}: {
  value: Record<string, any> | null;
  currency: string;
  exponent: number;
  permitted: boolean;
}) {
  if (!permitted)
    return <p className="wms-help">Wycena dostępna wyłącznie w uprawnionym zakresie finansowym.</p>;
  if (!value) return null;
  return (
    <><div className="wms-summary">
      <span>
        Wartość części o znanym koszcie
        <strong>{exactMoney(value.known_minor, value.currency ?? currency, exponent)}</strong>
      </span>
      <span>
        Sztuki o nieznanym koszcie<strong>{String(value.unknown_quantity ?? '—')}</strong>
      </span>
      <p className="wms-help">
        Suma części znanej nie jest pełną wartością zapasu, jeśli istnieją sztuki o nieznanym
        koszcie. Nie przeliczamy walut.
      </p>
    </div><ValuationClassification value={value}/></>
  );
}
function ProductChooser({
  io,
  value,
  onChange,
  disabled,
  contextKey,
}: {
  io: WmsIO;
  value: Product | null;
  onChange: (p: Product | null) => void;
  disabled: boolean;
  contextKey: string;
}) {
  const [search, setSearch] = useState(''),
    [rows, setRows] = useState<Product[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const local = useRef(0);
  useEffect(() => {
    ++local.current;
    setRows([]);
    setCursor(null);
    setSearch('');
    return () => {
      ++local.current;
    };
  }, [contextKey]);
  async function find(more = false) {
    const e = ++local.current;
    const d = await io.get<{ data: Product[]; meta: { cursor: string | null } }>(
      '/products?limit=50&search=' +
        encodeURIComponent(search) +
        (more && cursor ? '&after=' + encodeURIComponent(cursor) : ''),
    );
    if (e !== local.current) return;
    const physical = d.data.filter((p) => p.kind === 'simple' || p.kind === 'variant');
    setRows((old) => (more ? [...old, ...physical] : physical));
    setCursor(d.meta.cursor);
  }
  const choices = value && !rows.some((p) => p.id === value.id) ? [value, ...rows] : rows;
  return (
    <div className="wms-form wms-full">
      <label>
        Szukaj produktu fizycznego
        <input
          disabled={disabled}
          value={search}
          onChange={(e) => {
            ++local.current;
            setSearch(e.target.value);
            setRows([]);
            setCursor(null);
          }}
        />
      </label>
      <div className="wms-actions">
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => void io.read(() => find())}
        >
          Szukaj produktu
        </button>
        {cursor && (
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => void io.read(() => find(true))}
          >
            Wczytaj kolejne produkty
          </button>
        )}
      </div>
      <label className="wms-full">
        Produkt
        <select
          disabled={disabled}
          value={value?.id ?? ''}
          onChange={(e) => onChange(choices.find((p) => p.id === e.target.value) ?? null)}
        >
          <option value="">Wybierz produkt</option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sku} — {p.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
function PositionTable({
  rows,
  valueAllowed,
  exponent,
  onTrace,
}: {
  rows: Position[];
  valueAllowed: boolean;
  exponent: number;
  onTrace?: (id: string) => void;
}) {
  return (
    <div className="wms-scroll">
      <table className="wms-table">
        <thead>
          <tr>
            <th>Produkt / magazyn</th>
            <th>Partia / FIFO</th>
            <th>Lokalizacja</th>
            <th>Fizycznie</th>
            <th>Zarezerwowane</th>
            <th>Wolne</th>
            {valueAllowed && (
              <>
                <th>Koszt jednostkowy netto</th>
                <th>Wartość części znanej</th>
              </>
            )}
            <th>Wersje</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.layer_id + ':' + r.warehouse_id + ':' + r.location + ':' + i}>
              <td>
                <strong>{r.sku}</strong>
                <small>{r.name}</small>
                <small>{r.warehouse_name}</small>
              </td>
              <td>
                {r.lot_code}
                <small>Kolejność: {r.fifo_sequence}</small>
                {onTrace && (
                  <button type="button" className="button" onClick={() => onTrace(r.lot_id)}>
                    Historia tej partii
                  </button>
                )}
              </td>
              <td>{r.location}</td>
              <td>{r.quantity}</td>
              <td>{r.reserved}</td>
              <td>{r.available}</td>
              {valueAllowed && (
                <>
                  <td>{exactMoney(r.unit_cost_minor, r.currency, exponent)}</td>
                  <td>
                    {exactMoney(r.value_minor, r.currency, exponent)}
                    <small>Nieznany koszt: {r.unknown_quantity ?? '—'} szt.</small>
                  </td>
                </>
              )}
              <td>
                Stan: {r.stock_version}
                <small>Pozycja partii: {r.position_version}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type ReceiptDraft = {
  key: string;
  product: Product;
  location: string;
  quantity: string;
  lot_code: string;
  cost: string;
  expiry: string;
};
type StockVersion = { warehouse_id: string; product_id: string; version: string };
type Fragment = {
  layer_id: string;
  lot_id: string;
  lot_code: string;
  location: string;
  quantity: number;
  unit_cost_minor: string | null;
  currency: string;
  fifo_sequence: string;
  known_minor: string | null;
  unknown_quantity: number | null;
};
function FragmentTable({
  rows,
  exponent,
  valueAllowed,
}: {
  rows: Fragment[];
  exponent: number;
  valueAllowed: boolean;
}) {
  return (
    <div className="wms-scroll">
      <table className="wms-table">
        <thead>
          <tr>
            <th>Partia</th>
            <th>Lokalizacja</th>
            <th>Sztuki</th>
            <th>Kolejność FIFO</th>
            {valueAllowed && (
              <>
                <th>Koszt jednostkowy netto</th>
                <th>Wartość</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.layer_id + ':' + r.location + ':' + i}>
              <td>
                {r.lot_code ||
                  (r.layer_id ? 'Warstwa: ' + r.layer_id : 'Brak identyfikatora w dowodzie')}
              </td>
              <td>{r.location}</td>
              <td>{r.quantity}</td>
              <td>{r.fifo_sequence ?? 'Nie zapisano w dowodzie'}</td>
              {valueAllowed && (
                <>
                  <td>
                    {r.unit_cost_minor === undefined
                      ? 'Brak informacji w dowodzie'
                      : exactMoney(r.unit_cost_minor, r.currency, exponent)}
                  </td>
                  <td>
                    {r.known_minor === undefined
                      ? 'Brak informacji w dowodzie'
                      : exactMoney(r.known_minor, r.currency, exponent)}
                    <small>Nieznany koszt: {r.unknown_quantity ?? '—'} szt.</small>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function MovementScope({
  snapshot,
  fragments,
  valueAllowed,
  exponent,
}: {
  snapshot: Record<string, any>;
  fragments: Fragment[];
  valueAllowed: boolean;
  exponent: number;
}) {
  const request = snapshot.request;
  const bins = snapshot.bin_summary;
  if (!request) return <p className="wms-warning">Nie można odczytać zamrożonego zakresu ruchu.</p>;
  return (
    <>
      <p>
        <strong>{names[request.kind] ?? request.kind}</strong> · {request.location}
        {request.destination_location && ' → ' + request.destination_location}. Liczba sztuk w
        żądaniu: {String(request.quantity)}.
      </p>
      {bins?.source ? (
        <div className="wms-scroll">
          <table className="wms-table">
            <thead>
              <tr>
                <th>Zakres</th>
                <th>Stan przed</th>
                <th>Planowany stan po</th>
                <th>Rezerwacje</th>
              </tr>
            </thead>
            <tbody>
              {[bins.source, bins.destination].filter(Boolean).map((r, i) => (
                <tr key={i}>
                  <td>
                    {i === 0 ? 'Źródło / korekta' : 'Cel'}: {r.location}
                    <small>
                      {r.present ? 'Lokalizacja istnieje' : 'Brak lokalizacji przed ruchem'}
                    </small>
                  </td>
                  <td>{String(r.before_quantity)}</td>
                  <td>{String(r.after_quantity)}</td>
                  <td>{String(r.reserved)} — bez zmiany</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="wms-warning">
          Ten historyczny podgląd nie zawiera podsumowania stanu lokalizacji. Nie wyliczamy
          brakujących ilości jako zera.
        </p>
      )}
      {Array.isArray(bins?.warehouse_totals) && (
        <div className="wms-scroll">
          <table className="wms-table">
            <thead>
              <tr>
                <th>Magazyn w zakresie</th>
                <th>Stan przed → po</th>
                <th>Rezerwacje</th>
                <th>Wersja</th>
              </tr>
            </thead>
            <tbody>
              {bins.warehouse_totals.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{r.warehouse_id}</td>
                  <td>
                    {String(r.before_on_hand)} → {String(r.after_on_hand)}
                  </td>
                  <td>{String(r.reserved)}</td>
                  <td>{r.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="wms-help">
        To stan zamrożony przez serwer. Cały zakres i rezerwacje zostaną sprawdzone ponownie przy
        zatwierdzeniu; nie jest to odczyt stanu po zapisie.
      </p>
      <h4>Fragmenty wybrane przez serwer</h4>
      <FragmentTable rows={fragments} valueAllowed={valueAllowed} exponent={exponent} />
    </>
  );
}
function OperationResult({
  result,
  meta,
  valueAllowed,
}: {
  result: Record<string, any>;
  meta: Metadata;
  valueAllowed?: boolean;
}) {
  const allowed = meta.can_read_value && valueAllowed !== false;
  function normalize(r: any) {
    if (!allowed) return { ...r, known_minor: null, unknown_quantity: null };
    if (r.unit_cost_minor === null) return { ...r, known_minor: '0', unknown_quantity: r.quantity };
    if (
      typeof r.unit_cost_minor !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(r.unit_cost_minor) ||
      !Number.isSafeInteger(r.quantity) ||
      r.quantity < 0
    )
      return { ...r, known_minor: undefined, unknown_quantity: null };
    return {
      ...r,
      known_minor:
        r.known_minor ??
        r.value_minor ??
        (BigInt(r.quantity) * BigInt(r.unit_cost_minor)).toString(),
      unknown_quantity: 0,
    };
  }
  const layers = Array.isArray(result.layers)
    ? result.layers.map((r: any) => normalize({ ...r, lot_code: r.lot_code ?? 'Warstwa przyjęta' }))
    : [];
  const fragments = Array.isArray(result.fragments) ? result.fragments.map(normalize) : [];
  return (
    <>
      {result.policy && (
        <p>
          Polityka FIFO: {result.policy.enabled ? 'włączona' : 'wyłączona'} · wersja{' '}
          {result.policy.version} · waluta {result.policy.currency}.
        </p>
      )}
      {result.signed_delta !== undefined && (
        <p>
          Zapisana zmiana liczby sztuk: <strong>{String(result.signed_delta)}</strong>.
        </p>
      )}
      {layers.length > 0 && (
        <>
          <h4>Zapisane warstwy: {layers.length}</h4>
          <FragmentTable rows={layers} exponent={meta.policy.exponent} valueAllowed={allowed} />
        </>
      )}
      {fragments.length > 0 && (
        <>
          <h4>Rozliczone fragmenty: {fragments.length}</h4>
          <FragmentTable rows={fragments} exponent={meta.policy.exponent} valueAllowed={allowed} />
        </>
      )}
      <Valuation
        value={result.valuation ?? null}
        currency={meta.policy.currency ?? ''}
        exponent={meta.policy.exponent}
        permitted={allowed}
      />
      <Technical label="Dowody i pełny zapis lokalnej operacji">
        {allowed ? (
          <pre>{JSON.stringify(result, null, 2)}</pre>
        ) : (
          <p>
            Pełny zapis kwot jest ukryty zgodnie z bieżącymi uprawnieniami. Identyfikatory operacji
            pozostają w historii.
          </p>
        )}
      </Technical>
    </>
  );
}

export function WmsOrderLotsPanel({
  orderId,
  contextKey,
  readOnly,
  refresh = 0,
  onChanged,
  externalWriteBlocked = false,
}: WorkspaceProps & { orderId: string }) {
  const [meta, setMeta] = useState<Metadata | null>(null),
    [order, setOrder] = useState<{
      number: string;
      status: string;
      picking_items?: { product_id: string; sku: string; name?: string }[];
      items?: { product_id: string; sku: string; name: string }[];
    } | null>(null);
  const [rows, setRows] = useState<Allocation[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [canScan, setCanScan] = useState(false),
    [blockers, setBlockers] = useState<string[]>([]);
  const [selected, setSelected] = useState(''),
    [code, setCode] = useState(''),
    [scanned, setScanned] = useState('');
  const [returns, setReturns] = useState<ReturnFragment[]>([]),
    [returnCursor, setReturnCursor] = useState<string | null>(null),
    [returnsLoaded, setReturnsLoaded] = useState(false);
  const [operations, setOperations] = useState<Operation[]>([]),
    [operationsCursor, setOperationsCursor] = useState<string | null>(null),
    [operationsLoaded, setOperationsLoaded] = useState(false),
    [result, setResult] = useState<OperationResponse | null>(null);
  const [revision, setRevision] = useState(0);
  const key = (r: Allocation) =>
    JSON.stringify([r.product_id, r.warehouse_id, r.location, r.layer_id]);
  function purge() {
    setMeta(null);
    setOrder(null);
    setRows([]);
    setCursor(null);
    setCanScan(false);
    setBlockers([]);
    setSelected('');
    setCode('');
    setScanned('');
    setReturns([]);
    setReturnCursor(null);
    setReturnsLoaded(false);
    setOperations([]);
    setOperationsCursor(null);
    setOperationsLoaded(false);
    setResult(null);
  }
  const io = useWmsIO(
    contextKey + ':' + orderId,
    readOnly,
    purge,
    () => {
      setSelected('');
      setCanScan(false);
    },
    externalWriteBlocked,
  );
  async function load(more = false) {
    if (!more) {
      const m = await io.get<Metadata>(prefix);
      setMeta(m);
      if (!m.available || !m.can_read) return;
      setOrder(await io.get('/orders/' + orderId));
    }
    const d = await io.get<
      Page<Allocation> & {
        order: { id: string; number: string; status: string; version: string };
        can_scan: boolean;
        blockers: string[];
      }
    >(
      prefix +
        '/orders/' +
        orderId +
        '/allocations' +
        (more && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    setRows((old) => (more ? [...old, ...d.data] : d.data));
    setCursor(d.meta.cursor);
    setCanScan(d.can_scan);
    setBlockers(d.blockers ?? []);
    if (d.order) setOrder((old) => ({ ...old, ...d.order }));
    if (!more) {
      setSelected('');
      setReturnsLoaded(false);
      setOperationsLoaded(false);
    }
  }
  useEffect(() => {
    purge();
    void io.read(() => load());
  }, [contextKey, orderId, readOnly]);
  useEffect(() => {
    if ((refresh || revision) && !io.pending) void io.read(() => load());
  }, [refresh, revision]);
  const chosen = rows.find((r) => key(r) === selected);
  const write = !!meta?.available && meta.policy.enabled && meta.can_write && canScan && !io.locked;
  const label = (productId: string) => {
    const p =
      order?.picking_items?.find((r) => r.product_id === productId) ??
      order?.items?.find((r) => r.product_id === productId);
    return p ? p.sku + (p.name ? ' — ' + p.name : '') : 'Fizyczny składnik zamówienia';
  };
  function scan() {
    if (!write || !chosen || !code.trim()) return;
    const body = {
      code,
      location: chosen.location,
      layer_id: chosen.layer_id,
      client_key: crypto.randomUUID(),
    };
    io.mutate(
      '/orders/' + orderId + '/scan',
      'POST',
      body,
      'Skan jednej sztuki z partii ' + chosen.lot_code,
      () => {
        setScanned(
          'Przyjęto lokalny skan kodu ' +
            code +
            ', partia ' +
            chosen.lot_code +
            ', lokalizacja ' +
            chosen.location +
            '.',
        );
        setCode('');
        setSelected('');
        setRevision((v) => v + 1);
        onChanged?.();
      },
    );
  }
  async function loadReturns(more = false) {
    const d = await io.get<Page<ReturnFragment>>(
      prefix +
        '/orders/' +
        orderId +
        '/return-fragments' +
        (more && returnCursor ? '?cursor=' + encodeURIComponent(returnCursor) : ''),
    );
    setReturns((old) => (more ? [...old, ...d.data] : d.data));
    setReturnCursor(d.meta.cursor);
    setReturnsLoaded(true);
  }
  async function loadOperations(more = false) {
    const d = await io.get<Page<Operation>>(
      prefix +
        '/operations?order_id=' +
        encodeURIComponent(orderId) +
        (more && operationsCursor ? '&cursor=' + encodeURIComponent(operationsCursor) : ''),
    );
    setOperations((old) => (more ? [...old, ...d.data] : d.data));
    setOperationsCursor(d.meta.cursor);
    setOperationsLoaded(true);
  }
  return (
    <section className="wms-lots" aria-label="Partie przypisane do zamówienia">
      <header>
        <div>
          <h2>Partie zamówienia{order ? ' ' + order.number : ''}</h2>
          <p className="wms-help">
            Przypisanie FIFO, skan konkretnej partii i dowody kosztu wydania. Skan ani spakowanie
            nie wydają zapasu.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={io.busy || !!io.pending}
          onClick={() => void io.read(() => load())}
        >
          Odśwież przypisania i dostęp
        </button>
      </header>
      <Availability meta={meta} readOnly={readOnly} />
      <IONotice io={io} />
      {meta?.available && meta.can_read && (
        <>
          {!meta.policy.enabled ? (
            <p className="wms-help">
              Śledzenie partii nie jest włączone dla tej firmy. Dotychczasowa kompletacja ilościowa
              pozostaje osobnym procesem.
            </p>
          ) : (
            <>
              {blockers.map((b, i) => (
                <p className="wms-warning" key={i}>
                  {b}
                </p>
              ))}
              {!canScan && (
                <p className="wms-help">
                  Zapis skanu w tym panelu jest obecnie niedostępny. Dla aktywnego stanowiska
                  pakowania lub fali użyj właściwego procesu z jego uprawnieniami i dzierżawą;
                  zwykły skan nie omija tych blokad.
                </p>
              )}
              {!rows.length && (
                <p className="wms-empty">
                  Brak przypisań partii do tego zamówienia. Dawne wydania sprzed aktywacji nie
                  otrzymują wymyślonej partii ani kosztu.
                </p>
              )}
              <div className="wms-scroll">
                <table className="wms-table">
                  <thead>
                    <tr>
                      <th>Fizyczny produkt</th>
                      <th>Partia / FIFO</th>
                      <th>Magazyn / lokalizacja</th>
                      <th>Przypisano</th>
                      <th>Zeskanowano</th>
                      <th>Stan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={key(r) + ':' + i}>
                        <td>{label(r.product_id)}</td>
                        <td>
                          {r.lot_code}
                          <small>Kolejność: {r.fifo_sequence}</small>
                        </td>
                        <td>
                          {meta.warehouses.find((w) => w.id === r.warehouse_id)?.name ??
                            'Magazyn zamówienia'}
                          <small>{r.location}</small>
                        </td>
                        <td>{r.quantity}</td>
                        <td>{r.scanned}</td>
                        <td>
                          {(
                            {
                              active: 'Zarezerwowane',
                              consumed: 'Wydane',
                              released: 'Zwolnione',
                            } as Record<string, string>
                          )[r.state] ?? r.state}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {cursor && (
                <button
                  type="button"
                  className="button"
                  disabled={io.busy}
                  onClick={() => void io.read(() => load(true))}
                >
                  Wczytaj kolejne przypisania (do 50)
                </button>
              )}
              <form
                className="wms-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  scan();
                }}
              >
                <label>
                  Jawnie wybierz przypisaną partię i lokalizację
                  <select
                    value={selected}
                    disabled={!write}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    <option value="">Wybierz partię — bez automatycznego wyboru</option>
                    {rows
                      .filter((r) => r.state === 'active' && r.scanned < r.quantity)
                      .map((r, i) => (
                        <option key={key(r) + ':' + i} value={key(r)}>
                          {label(r.product_id)} · {r.lot_code} · {r.location} · pozostało{' '}
                          {r.quantity - r.scanned} szt.
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Odczytany kod SKU lub EAN
                  <input value={code} disabled={!write} onChange={(e) => setCode(e.target.value)} />
                </label>
                <button
                  type="submit"
                  className="button primary"
                  disabled={!write || !chosen || !code.trim()}
                >
                  Skanuj jedną sztukę wybranej partii
                </button>
              </form>
              {scanned && (
                <p className="wms-success" role="status">
                  {scanned} Bieżące liczniki są odczytywane z serwera.
                </p>
              )}
            </>
          )}
          <section className="wms-card">
            <h3>Wydania i ich koszt magazynowy</h3>
            <p className="wms-help">
              Wydanie powstaje dopiero przy potwierdzonym rozchodzie. Cena sprzedaży i zwrot środków
              są odrębnymi kwotami.
            </p>
            <button
              type="button"
              className="button"
              disabled={io.busy}
              onClick={() => void io.read(() => loadOperations())}
            >
              Odczytaj historię wydań
            </button>
            {operationsLoaded && !operations.some((r) => r.order_id === orderId) && (
              <p>
                W odczytanej stronie historii nie ma operacji tego zamówienia.
                {operationsCursor ? ' Dostępne są dalsze strony historii zamówienia.' : ''}
              </p>
            )}
            <div className="wms-history">
              {operations
                .filter((op) => op.order_id === orderId)
                .map((op) => (
                  <button
                    type="button"
                    className="button"
                    key={op.id}
                    disabled={io.busy}
                    onClick={() =>
                      void io.read(async () => {
                        const d = await io.get<OperationResponse>(prefix + '/operations/' + op.id);
                        setResult(d);
                      })
                    }
                  >
                    {names[op.kind] ?? op.kind} · {date(op.created_at)}
                  </button>
                ))}
            </div>
            {operationsCursor && (
              <button
                type="button"
                className="button"
                disabled={io.busy}
                onClick={() => void io.read(() => loadOperations(true))}
              >
                Wczytaj kolejne operacje (do 50)
              </button>
            )}
            {result && (
              <OperationResult
                result={result.result}
                meta={meta}
                valueAllowed={result.can_read_value}
              />
            )}
          </section>
          <section className="wms-card">
            <h3>Fragmenty wydania dostępne do powiązania zwrotu</h3>
            <p className="wms-help">
              Przyjęcie zwrotu odbywa się w istniejącej sprawie zwrotu, w jednej transakcji z
              przywróceniem właściwych fragmentów. Ten odczyt nie przyjmuje towaru ani nie wypłaca
              pieniędzy.
            </p>
            <button
              type="button"
              className="button"
              disabled={io.busy}
              onClick={() => void io.read(() => loadReturns())}
            >
              Odczytaj fragmenty pierwotnego wydania
            </button>
            {returnsLoaded && !returns.length && (
              <p className="wms-empty">
                Brak dostępnych fragmentów pierwotnego wydania. Nie twórz na tej podstawie
                fikcyjnego kosztu historycznego.
              </p>
            )}
            <div className="wms-scroll">
              <table className="wms-table">
                <thead>
                  <tr>
                    <th>Produkt / partia</th>
                    <th>Wydano</th>
                    <th>Już przywrócono</th>
                    <th>Pozostało do powiązania</th>
                    {meta.can_read_value && <th>Pierwotny koszt netto</th>}
                    <th>Dowód</th>
                  </tr>
                </thead>
                <tbody>
                  {returns.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {label(r.product_id)}
                        <small>{r.lot_code}</small>
                        <small>{r.location}</small>
                      </td>
                      <td>{r.quantity}</td>
                      <td>{r.returned_quantity}</td>
                      <td>{r.remaining}</td>
                      {meta.can_read_value && (
                        <td>
                          {exactMoney(r.unit_cost_minor, r.currency, meta.policy.exponent)}
                          <small>
                            Wartość: {exactMoney(r.value_minor, r.currency, meta.policy.exponent)}
                          </small>
                        </td>
                      )}
                      <td>
                        <Technical label="Tożsamość fragmentu do sprawy zwrotu">
                          <p>{r.id}</p>
                          <p>Warstwa: {r.layer_id}</p>
                          <p>Partia: {r.lot_id}</p>
                        </Technical>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {returnCursor && (
              <button
                type="button"
                className="button"
                disabled={io.busy}
                onClick={() => void io.read(() => loadReturns(true))}
              >
                Wczytaj kolejne fragmenty (do 50)
              </button>
            )}
          </section>
        </>
      )}
    </section>
  );
}
function FrozenPreview({
  id,
  kind,
  contextKey,
  readOnly,
  exponent,
  onDenied,
  onLoaded,
}: {
  id: string;
  kind: 'opening' | 'movement';
  contextKey: string;
  readOnly: boolean;
  exponent: number;
  onDenied: () => void;
  onLoaded: () => void;
}) {
  const [detail, setDetail] = useState<{
    preview: PreviewHead;
    snapshot_summary: Record<string, any>;
    can_read_value: boolean;
  } | null>(null);
  const [rows, setRows] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const io = useWmsIO(contextKey + ':' + id, readOnly, () => {
    setDetail(null);
    setRows([]);
    setCursor(null);
    onDenied();
  });
  const base =
    prefix + '/' + (kind === 'opening' ? 'opening-previews' : 'movement-previews') + '/' + id;
  useEffect(() => {
    setDetail(null);
    setRows([]);
    setCursor(null);
    void io.read(async () => {
      const d = await io.get<{
        available: boolean;
        preview: PreviewHead;
        snapshot_summary: Record<string, any>;
        can_read_value: boolean;
      }>(base);
      if (!d.available || !d.preview)
        throw new Error('Podgląd jest niedostępny w tej kopii. Nie można potwierdzić zakresu.');
      const r = await io.get<Page<any>>(base + '/rows');
      setDetail(d);
      setRows(r.data);
      setCursor(r.meta.cursor);
      onLoaded();
    });
  }, [id, contextKey, readOnly]);
  return (
    <div className="wms-card">
      <h4>Zamrożony zakres podglądu</h4>
      <IONotice io={io} />
      {detail && (
        <>
          <p>
            Cały zakres: {detail.preview.total} wierszy · odczytano {rows.length}. Zgoda dotyczy
            całego zakresu, także kolejnych stron.
          </p>
          {kind === 'opening' ? (
            <div className="wms-scroll">
              <table className="wms-table">
                <thead>
                  <tr>
                    <th>Produkt / magazyn</th>
                    <th>Lokalizacja</th>
                    <th>Partia</th>
                    <th>Sztuki</th>
                    {detail.can_read_value && <th>Koszt jednostkowy netto</th>}
                    <th>Wersja stanu</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td>
                        {r.sku ?? r.product_id}
                        <small>{r.name}</small>
                        <small>{r.warehouse_name ?? r.warehouse_id}</small>
                      </td>
                      <td>{r.location}</td>
                      <td>{r.lot_code}</td>
                      <td>
                        {r.quantity} → {r.quantity}
                      </td>
                      {detail.can_read_value && (
                        <td>{exactMoney(r.unit_cost_minor, detail.preview.currency, exponent)}</td>
                      )}
                      <td>{r.stock_version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <MovementScope
              snapshot={detail.snapshot_summary}
              fragments={rows}
              exponent={exponent}
              valueAllowed={detail.can_read_value}
            />
          )}
          {cursor && (
            <button
              type="button"
              className="button"
              disabled={io.busy}
              onClick={() =>
                void io.read(async () => {
                  const r = await io.get<Page<any>>(
                    base + '/rows?cursor=' + encodeURIComponent(cursor),
                  );
                  setRows((old) => [...old, ...r.data]);
                  setCursor(r.meta.cursor);
                })
              }
            >
              Wczytaj kolejne wiersze (do 50)
            </button>
          )}
          {kind === 'movement' && (
            <Technical label="Stan przed, zakres ruchu i wynik po zatwierdzeniu">
              <pre>{JSON.stringify(detail.snapshot_summary, null, 2)}</pre>
            </Technical>
          )}
          <Technical label="Identyfikator i skrót zatwierdzanego zakresu">
            <p>
              {detail.preview.id} · {detail.preview.scope_hash}
            </p>
          </Technical>
        </>
      )}
    </div>
  );
}

export function WmsLotsWorkspace({
  contextKey,
  readOnly,
  refresh = 0,
  onChanged,
  externalWriteBlocked = false,
}: WorkspaceProps) {
  const [meta, setMeta] = useState<Metadata | null>(null),
    [tab, setTab] = useState('inventory');
  const [warehouse, setWarehouse] = useState(''),
    [product, setProduct] = useState<Product | null>(null);
  const [positions, setPositions] = useState<Position[]>([]),
    [positionsCursor, setPositionsCursor] = useState<string | null>(null),
    [value, setValue] = useState<Record<string, any> | null>(null);
  const [positionsLoaded, setPositionsLoaded] = useState(false),
    [positionsScope, setPositionsScope] = useState('');
  const [traceId, setTraceId] = useState(''),
    [trace, setTrace] = useState<any>(null),
    [traceRows, setTraceRows] = useState<any[]>([]),
    [traceCursor, setTraceCursor] = useState<string | null>(null);
  const [opening, setOpening] = useState<OpeningDraft[]>([]),
    [openingLoaded, setOpeningLoaded] = useState(false),
    [openingBlockers, setOpeningBlockers] = useState<string[]>([]),
    [openingPage, setOpeningPage] = useState(0);
  const [currency, setCurrency] = useState(''),
    [note, setNote] = useState(''),
    [bulkLot, setBulkLot] = useState(''),
    [bulkCost, setBulkCost] = useState(''),
    [bulkUnknown, setBulkUnknown] = useState(false);
  const [receiptRows, setReceiptRows] = useState<ReceiptDraft[]>([]),
    [receiptReview, setReceiptReview] = useState<Record<string, any> | null>(null);
  const [movementKind, setMovementKind] = useState<
      'issue' | 'transfer' | 'bin_move' | 'adjustment'
    >('issue'),
    [movementLocation, setMovementLocation] = useState(''),
    [destinationWarehouse, setDestinationWarehouse] = useState(''),
    [destinationLocation, setDestinationLocation] = useState(''),
    [quantity, setQuantity] = useState('');
  const [movementPositions, setMovementPositions] = useState<Position[]>([]),
    [movementVersions, setMovementVersions] = useState<StockVersion[]>([]),
    [chosenLayers, setChosenLayers] = useState<string[]>([]),
    [adjustDirection, setAdjustDirection] = useState<'plus' | 'minus'>('minus'),
    [adjustCost, setAdjustCost] = useState(''),
    [adjustLot, setAdjustLot] = useState('');
  const [preview, setPreview] = useState<{
      head: PreviewHead;
      kind: 'opening' | 'movement';
    } | null>(null),
    [previewLoaded, setPreviewLoaded] = useState(false),
    [consent, setConsent] = useState(false),
    [unknownConsent, setUnknownConsent] = useState(false);
  const [result, setResult] = useState<OperationResponse | null>(null),
    [history, setHistory] = useState<Operation[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyCorrections,setHistoryCorrections]=useState<{scope:string;data:Record<string,CorrectionQuantityView>}>({scope:'',data:{}});
  const correctionScope=contextKey+':'+readOnly;
  const [historyScope,setHistoryScope]=useState('');
  const visibleHistory=historyScope===correctionScope?history:[];
  const visibleCorrections:Record<string,CorrectionQuantityView>=historyCorrections.scope===correctionScope?historyCorrections.data:{};
  const resultCorrection=result?visibleCorrections[result.operation.id]:undefined;
  let correctionDocumentLabel: string | null = null, correctionDocumentError = '';
  if (result) { try { correctionDocumentLabel = inventoryCorrectionDocumentLabel(result); } catch (e) { correctionDocumentError = message(e); } }
  const [revision, setRevision] = useState(0);
  function clearPreview() {
    setPreview(null);
    setPreviewLoaded(false);
    setConsent(false);
    setUnknownConsent(false);
  }
  function dirty() {
    clearPreview();
    setResult(null);
    setReceiptReview(null);
  }
  function purge() {
    setMeta(null);
    setWarehouse('');
    setProduct(null);
    setPositions([]);
    setPositionsCursor(null);
    setValue(null);
    setPositionsLoaded(false);
    setPositionsScope('');
    setTraceId('');
    setTrace(null);
    setTraceRows([]);
    setTraceCursor(null);
    setOpening([]);
    setOpeningLoaded(false);
    setOpeningBlockers([]);
    setOpeningPage(0);
    setCurrency('');
    setNote('');
    setBulkLot('');
    setBulkCost('');
    setBulkUnknown(false);
    setReceiptRows([]);
    setReceiptReview(null);
    setMovementPositions([]);
    setMovementVersions([]);
    setChosenLayers([]);
    setMovementLocation('');
    setDestinationWarehouse('');
    setDestinationLocation('');
    setQuantity('');
    setAdjustCost('');
    setAdjustLot('');
    clearPreview();
    setResult(null);
    setHistoryCorrections({scope:'',data:{}});
    setHistoryScope('');
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
  }
  const io = useWmsIO(
    contextKey,
    readOnly,
    purge,
    () => {
      clearPreview();
      setReceiptReview(null);
    },
    externalWriteBlocked,
  );
  async function loadMetadata() {
    const d = await io.get<Metadata>(prefix);
    setMeta(d);
    setPositionsLoaded(false);
    setPositionsScope('');
    return d;
  }
  useEffect(() => {
    purge();
    void io.read(async () => {
      await loadMetadata();
    });
  }, [contextKey, readOnly]);
  useEffect(() => {
    if ((refresh || revision) && !io.pending)
      void io.read(async () => {
        clearPreview();
        await loadMetadata();
      });
  }, [refresh, revision]);
  const write = !!meta?.available && meta.can_write && !io.locked,
    exponent = meta?.policy.exponent ?? 2;
  const enabled = !!meta?.policy.enabled;
  function showOperation(d: OperationResponse) {
    const correction=correctionQuantityView(d);
    setHistoryCorrections(old=>{const data={...(old.scope===correctionScope?old.data:{})};if(correction)data[d.operation.id]=correction;else delete data[d.operation.id];return{scope:correctionScope,data};});
    setResult(d);
  }
  function saved(d: OperationResponse) {
    showOperation(d);
    setPreview(null);
    setPreviewLoaded(false);
    setConsent(false);
    setUnknownConsent(false);
    setReceiptReview(null);
    setHistoryLoaded(false);
    setRevision((v) => v + 1);
    onChanged?.();
  }
  async function versionsFor(warehouseId: string, productIds: string[]): Promise<StockVersion[]> {
    const unique = [...new Set(productIds)];
    const out: StockVersion[] = [];
    for (let i = 0; i < unique.length; i += 50) {
      const ids = unique.slice(i, i + 50);
      const d = await io.get<{ data: { product_id: string; version: unknown }[] }>(
        '/inventory/snapshot?' +
          new URLSearchParams({ warehouse_id: warehouseId, product_ids: ids.join(',') }),
      );
      for (const id of ids) {
        const row = d.data.find((r) => r.product_id === id);
        out.push({
          warehouse_id: warehouseId,
          product_id: id,
          version: row ? exactVersion(row.version) : '0',
        });
      }
    }
    return out;
  }
  async function allPositions(warehouseId: string, productId: string) {
    const base =
      prefix +
      '/positions?' +
      new URLSearchParams({ warehouse_id: warehouseId, product_id: productId });
    const rows: Position[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const d: Page<Position> = await io.get<Page<Position>>(
        base + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      );
      rows.push(...d.data);
      if (rows.length > 10000)
        throw new Error('Pełny zakres przekracza 10000 pozycji. Nie obcięto zakresu.');
      cursor = d.meta.cursor;
      if (cursor && seen.has(cursor))
        throw new Error('Nieprawidłowa paginacja pozycji — zakres nie został przyjęty.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return rows;
  }
  async function loadPositions(more = false) {
    if (!more) {
      setPositionsLoaded(false);
      setPositionsScope('');
    }
    const query = new URLSearchParams({
      ...(warehouse ? { warehouse_id: warehouse } : {}),
      ...(product ? { product_id: product.id } : {}),
      ...(more && positionsCursor ? { cursor: positionsCursor } : {}),
    });
    const d = await io.get<Page<Position>>(prefix + '/positions?' + query);
    setPositions((old) => (more ? [...old, ...d.data] : d.data));
    setPositionsCursor(d.meta.cursor);
    setPositionsLoaded(true);
    setPositionsScope(
      (warehouse
        ? (meta?.warehouses.find((w) => w.id === warehouse)?.name ?? 'Wybrany magazyn')
        : 'Wszystkie własne magazyny') +
        ' · ' +
        (product ? product.sku + ' — ' + product.name : 'Wszystkie produkty'),
    );
    if (!more) {
      setValue(null);
      if (meta?.policy.enabled && meta.can_read_value) {
        const d = await io.get<{ valuation: Record<string, any> }>(
          prefix +
            '/valuation?' +
            new URLSearchParams({
              ...(warehouse ? { warehouse_id: warehouse } : {}),
              ...(product ? { product_id: product.id } : {}),
            }),
        );
        setValue(d.valuation);
      }
    }
  }
  async function loadTrace(id: string, more = false) {
    const d = await io.get<any>(
      prefix +
        '/lots/' +
        id +
        '/trace' +
        (more && traceCursor ? '?cursor=' + encodeURIComponent(traceCursor) : ''),
    );
    setTraceId(id);
    setTrace(d.lot);
    setTraceRows((old) => (more ? [...old, ...d.data] : d.data));
    setTraceCursor(d.meta.cursor);
  }
  async function loadOpening() {
    dirty();
    setOpeningLoaded(false);
    setOpening([]);
    setOpeningBlockers([]);
    const rows: OpeningDraft[] = [];
    const blockers = new Set<string>();
    const seen = new Set<string>();
    let cursor: string | null = null,
      hash: string | null = null;
    do {
      const d: Page<OpeningRow> & { scope_hash: string; active_blockers: string[] } = await io.get(
        prefix + '/opening-scope' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      );
      if (hash && hash !== d.scope_hash)
        throw new Error(
          'Stany zmieniły się podczas odczytu otwarcia. Wczytaj od początku cały zakres.',
        );
      hash = d.scope_hash;
      for (const b of d.active_blockers) blockers.add(b);
      rows.push(...d.data.map((r) => ({ ...r, lot_code: '', cost: '', unknown: true })));
      if (rows.length > 10000)
        throw new Error(
          'Otwarcie przekracza 10000 pozycji. Nie obcięto zakresu; aktywacja jest niemożliwa.',
        );
      cursor = d.meta.cursor;
      if (cursor && seen.has(cursor))
        throw new Error('Nieprawidłowa paginacja otwarcia. Nie przyjęto częściowego zakresu.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    setOpening(rows);
    setOpeningBlockers([...blockers]);
    setOpeningLoaded(true);
    setOpeningPage(0);
  }
  function openingPreview() {
    if (!meta || !write || !meta.can_activate || !openingLoaded) return;
    try {
      if (!currency) throw new Error('Wybierz jawną walutę wyceny.');
      if (openingBlockers.length) throw new Error('Zakończ wskazane procesy przed otwarciem WMS.');
      const lines = opening.map((r, i) => {
        if (!r.lot_code.trim())
          throw new Error('Wiersz ' + (i + 1) + ': podaj kod partii otwarcia.');
        exactInteger(String(r.quantity), 'Wiersz ' + (i + 1) + ': ilość', 1n, 2147483647n);
        return {
          warehouse_id: r.warehouse_id,
          product_id: r.product_id,
          location: r.location,
          quantity: r.quantity,
          stock_version: r.stock_version,
          lot_code: r.lot_code,
          unit_cost_minor: r.unknown ? null : minorFromText(r.cost, exponent),
        };
      });
      io.mutate(
        prefix + '/opening-previews',
        'POST',
        {
          client_key: crypto.randomUUID(),
          policy_version: meta.policy.version,
          currency,
          note,
          lines,
        },
        'Podgląd otwarcia całej firmy',
        (d) => {
          setPreview({ head: d.preview, kind: 'opening' });
          setConsent(false);
          setUnknownConsent(false);
          setPreviewLoaded(false);
        },
      );
    } catch (e) {
      io.setError(message(e));
    }
  }
  async function reviewReceipt() {
    if (!meta || !enabled || !meta.can_receive || !warehouse || !receiptRows.length)
      throw new Error(
        'Wybierz magazyn i dodaj co najmniej jeden produkt. Przyjęcie wymaga aktywnego WMS i właściwych uprawnień.',
      );
    if (receiptRows.length > 500)
      throw new Error('Przyjęcie może mieć najwyżej 500 jawnych wierszy.');
    if (!note.trim() || note.trim().length < 3)
      throw new Error('Podaj uzasadnienie przyjęcia (co najmniej 3 znaki).');
    const lines = receiptRows.map((r, i) => {
      if (!r.location.trim() || !r.lot_code.trim())
        throw new Error('Wiersz ' + (i + 1) + ': podaj lokalizację i kod partii.');
      return {
        product_id: r.product.id,
        location: r.location,
        quantity: exactInteger(r.quantity, 'Ilość wiersza ' + (i + 1), 1n, 1000000n),
        lot_code: r.lot_code,
        unit_cost_minor: minorFromText(r.cost, exponent),
        currency: meta.policy.currency,
        expiry_date: r.expiry || null,
      };
    });
    const stock_versions = await versionsFor(
      warehouse,
      lines.map((r) => r.product_id),
    );
    const body = {
      client_key: crypto.randomUUID(),
      policy_version: meta.policy.version,
      warehouse_id: warehouse,
      stock_versions,
      lines,
      note,
      confirmed: true,
    };
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 2097152)
      throw new Error('Całe przyjęcie przekracza 2 MiB. Nie wysłano ani nie obcięto wierszy.');
    setReceiptReview(body);
    setConsent(false);
    clearPreview();
  }
  async function readMovementScope() {
    dirty();
    setMovementPositions([]);
    setMovementVersions([]);
    setChosenLayers([]);
    if (!warehouse || !product) throw new Error('Wybierz źródłowy magazyn i produkt fizyczny.');
    const p = await allPositions(warehouse, product.id);
    const versions = await versionsFor(warehouse, [product.id]);
    if (movementKind === 'transfer') {
      if (!destinationWarehouse || destinationWarehouse === warehouse)
        throw new Error('MM wymaga innego magazynu docelowego.');
      versions.push(...(await versionsFor(destinationWarehouse, [product.id])));
    }
    setMovementPositions(p);
    setMovementVersions(versions);
  }
  function movementPreview() {
    if (!meta || !enabled || !write || !product || !warehouse) return;
    try {
      if (
        !(movementKind === 'adjustment'
          ? meta.can_adjust
          : movementKind === 'issue'
            ? meta.can_issue
            : meta.can_transfer)
      )
        throw new Error('Bieżące uprawnienia nie pozwalają zatwierdzić tego rodzaju ruchu.');
      if (!movementVersions.length)
        throw new Error('Najpierw odczytaj pełny stan partii i wersje obu magazynów.');
      const n = exactInteger(quantity, 'Liczba sztuk', 1n, 1000000n);
      const delta = movementKind === 'adjustment' && adjustDirection === 'minus' ? -n : n;
      if (!movementLocation.trim()) throw new Error('Podaj źródłową lokalizację.');
      if (movementKind === 'adjustment' && delta < 0 && !chosenLayers.length)
        throw new Error('Ujemna korekta wymaga jawnego wyboru warstw.');
      if (!note.trim() || note.trim().length < 3)
        throw new Error('Podaj uzasadnienie ruchu (co najmniej 3 znaki).');
      const body = {
        client_key: crypto.randomUUID(),
        policy_version: meta.policy.version,
        kind: movementKind,
        product_id: product.id,
        warehouse_id: warehouse,
        location: movementLocation,
        quantity: delta,
        stock_versions: movementVersions,
        ...(movementKind === 'transfer'
          ? {
              destination_warehouse_id: destinationWarehouse,
              destination_location: destinationLocation,
            }
          : {}),
        ...(movementKind === 'bin_move' ? { destination_location: destinationLocation } : {}),
        ...(chosenLayers.length && !(movementKind === 'adjustment' && delta > 0)
          ? { layer_ids: chosenLayers }
          : {}),
        ...(movementKind === 'adjustment' && delta > 0
          ? {
              unit_cost_minor: minorFromText(adjustCost, exponent),
              currency: meta.policy.currency,
              lot_code: adjustLot,
            }
          : {}),
        note,
      };
      const correction = movementKind === 'adjustment';
      const request = correction ? inventoryCorrectionRequest(body, { currency: meta.policy.currency, exponent, positions: movementPositions }) : body;
      io.mutate(
        correction ? '/inventory/adjust/previews' : prefix + '/movement-previews',
        'POST',
        request,
        'Podgląd ruchu: ' + names[movementKind],
        (d) => {
          setPreview({ head: d.preview, kind: 'movement' });
          setConsent(false);
          setPreviewLoaded(false);
        },
      );
    } catch (e) {
      io.setError(message(e));
    }
  }
  function executePreview() {
    if (!preview?.head.ready || !consent || !previewLoaded || !write) return;
    if (
      preview.kind === 'opening' &&
      BigInt(String(preview.head.unknown_quantity ?? '0')) > 0n &&
      !unknownConsent
    )
      return;
    const correction = preview.kind === 'movement' && preview.head.kind === 'adjustment';
    io.mutate(
      correction ? '/inventory/adjust' : prefix +
        '/' +
        (preview.kind === 'opening' ? 'opening-previews' : 'movement-previews') +
        '/' +
        preview.head.id +
        '/' +
        (preview.kind === 'opening' ? 'activate' : 'execute'),
      'POST',
      correction ? inventoryCorrectionApply(preview.head.id, preview.head.scope_hash, crypto.randomUUID(), consent) : {
        client_key: crypto.randomUUID(),
        scope_hash: preview.head.scope_hash,
        confirmed: true,
        ...(preview.kind === 'opening' ? { ack_unknown_costs: unknownConsent } : {}),
      },
      preview.kind === 'opening'
        ? 'Aktywacja FIFO dla całej firmy'
        : 'Zatwierdzenie ruchu magazynowego',
      saved,
    );
  }
  async function loadHistory(more = false) {
    const d = await io.get<Page<Operation>>(
      prefix +
        '/operations' +
        (more && historyCursor ? '?cursor=' + encodeURIComponent(historyCursor) : ''),
    );
    if(d.data.some(op=>op.correction_head!=null&&!correctionHeadView(op.correction_head,op)))
      throw new Error('Nie można odczytać zapisanych nagłówków korekt. Otwórz wspólny rejestr magazynowy.');
    setHistory((old) => (more ? [...old, ...d.data] : d.data));
    setHistoryScope(correctionScope);
    setHistoryCursor(d.meta.cursor);
    setHistoryLoaded(true);
  }
  function changeScope(kind: 'warehouse' | 'product', v: string | Product | null) {
    dirty();
    setPositions([]);
    setPositionsCursor(null);
    setPositionsLoaded(false);
    setPositionsScope('');
    setValue(null);
    setMovementPositions([]);
    setMovementVersions([]);
    setChosenLayers([]);
    setMovementLocation('');
    setTrace(null);
    setTraceId('');
    setTraceRows([]);
    setTraceCursor(null);
    if (kind === 'warehouse') setWarehouse(v as string);
    else setProduct(v as Product | null);
  }
  const movementAllowed =
    !!meta &&
    (movementKind === 'adjustment'
      ? meta.can_adjust
      : movementKind === 'issue'
        ? meta.can_issue
        : meta.can_transfer);
  return (
    <section className="wms-lots" aria-label="Partie WMS i FIFO">
      <header>
        <div>
          <h2>Partie WMS i FIFO</h2>
          <p className="wms-help">
            Partia → rezerwacja → skan → wydanie → koszt i pochodzenie. Wszystkie działania tego
            panelu są lokalne.
          </p>
        </div>
        <button
          type="button"
          className="button"
          disabled={io.busy || !!io.pending}
          onClick={() =>
            void io.read(async () => {
              clearPreview();
              setReceiptReview(null);
              await loadMetadata();
            })
          }
        >
          Odśwież politykę
        </button>
      </header>
      <Availability meta={meta} readOnly={readOnly} />
      <IONotice io={io} />
      {externalWriteBlocked && (
        <p className="wms-warning">
          Nowe zapisy są zablokowane do czasu rozstrzygnięcia importu stanów. Odczyty i ponowienie
          własnej zachowanej próby pozostają dostępne.
        </p>
      )}
      {meta?.available && meta.can_read && (
        <>
          <p>
            <strong>Śledzenie partii: {enabled ? 'włączone' : 'wyłączone'}</strong> · FIFO · wersja
            polityki {meta.policy.version}
            {meta.policy.currency && ' · ' + meta.policy.currency}.{' '}
            {!enabled && 'Dotychczasowe ilościowe operacje pozostają odrębnym procesem.'}
          </p>
          <nav className="wms-tabs" aria-label="Zakres partii WMS">
            {[
              ['inventory', 'Zapas i pochodzenie'],
              ['opening', 'Otwarcie i aktywacja'],
              ['receipt', 'Przyjęcie partii'],
              ['movement', 'Ruch i korekta'],
              ['history', 'Historia operacji'],
            ].map(([id, label]) => (
              <button
                type="button"
                className="button"
                key={id}
                aria-pressed={tab === id}
                disabled={io.busy || !!io.pending}
                onClick={() => {
                  dirty();
                  setTab(id);
                  if (id === 'history' && !historyLoaded) void io.read(() => loadHistory());
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          {['inventory', 'receipt', 'movement'].includes(tab) && (
            <div className="wms-card">
              <div className="wms-form">
                <label>
                  Magazyn
                  <select
                    value={warehouse}
                    disabled={tab === 'inventory' ? io.busy || !!io.pending : io.locked}
                    onChange={(e) => changeScope('warehouse', e.target.value)}
                  >
                    <option value="">
                      {tab === 'inventory' ? 'Wszystkie własne magazyny' : 'Wybierz magazyn'}
                    </option>
                    {meta.warehouses.map((w) => (
                      <option value={w.id} key={w.id}>
                        {w.code} — {w.name}
                      </option>
                    ))}
                  </select>
                </label>
                {tab === 'inventory' && (
                  <button
                    type="button"
                    className="button"
                    disabled={io.busy}
                    onClick={() => void io.read(() => loadPositions())}
                  >
                    Odczytaj zapas i wartość
                  </button>
                )}
              </div>
              <ProductChooser
                contextKey={contextKey + ':' + tab}
                io={io}
                value={product}
                disabled={tab === 'inventory' ? io.busy || !!io.pending : io.locked}
                onChange={(p) => changeScope('product', p)}
              />
              {tab === 'inventory' && product && (
                <button
                  type="button"
                  className="button"
                  disabled={io.busy || !!io.pending}
                  onClick={() => changeScope('product', null)}
                >
                  Pokaż wszystkie produkty
                </button>
              )}
            </div>
          )}
          {tab === 'inventory' && (
            <>
              {!enabled && (
                <p className="wms-help">
                  Śledzenie partii jest wyłączone. Zapas ilościowy odczytasz w „Magazyny”. Aby
                  rozpocząć śledzenie partii i ich kosztów, przejdź do „Otwarcie i aktywacja” i
                  jawnie zatwierdź pełny stan otwarcia.
                </p>
              )}
              <Valuation
                value={value}
                currency={meta.policy.currency ?? ''}
                exponent={exponent}
                permitted={meta.can_read_value}
              />
              {!positions.length && (
                <p className="wms-empty">
                  {positionsLoaded
                    ? 'W odczytanym zakresie nie ma pozycji partii. Nie oznacza to zerowego historycznego zapasu ilościowego.'
                    : 'Wybierz zakres i odczytaj własny zapas w partiach.'}
                </p>
              )}
              {positionsLoaded && (
                <p className="wms-success" role="status">
                  Odczyt pozycji partii zakończony: {positions.length} pozycji w odczytanych
                  stronach. {positionsScope}.{positionsCursor && ' Dostępne są kolejne strony.'}
                </p>
              )}
              {positions.length > 0 && (
                <PositionTable
                  rows={positions}
                  exponent={exponent}
                  valueAllowed={meta.can_read_value}
                  onTrace={(id) => {
                    if (!io.busy) void io.read(() => loadTrace(id));
                  }}
                />
              )}
              {positionsCursor && (
                <button
                  type="button"
                  className="button"
                  disabled={io.busy}
                  onClick={() => void io.read(() => loadPositions(true))}
                >
                  Wczytaj kolejne pozycje (do 50)
                </button>
              )}
              {trace && (
                <section className="wms-card">
                  <h3>Pochodzenie partii {trace.lot_code}</h3>
                  <p>
                    Data ważności: {trace.expiry_date ?? 'Nie podano'}. FIFO wybiera kolejność
                    przyjęcia; zapis daty nie włącza FEFO ani kontroli przeterminowania.
                  </p>
                  <Technical label="Źródło przyjęcia">
                    <pre>{JSON.stringify(trace.origin, null, 2)}</pre>
                  </Technical>
                  <div className="wms-scroll">
                    <table className="wms-table">
                      <thead>
                        <tr>
                          <th>Ruch</th>
                          <th>Magazyn / lokalizacja</th>
                          <th>Zmiana sztuk</th>
                          {meta.can_read_value && <th>Zmiana wartości</th>}
                          <th>Czas / dowody</th>
                        </tr>
                      </thead>
                      <tbody>
                        {traceRows.map((r, i) => (
                          <tr key={r.id ?? i}>
                            <td>{names[r.kind] ?? r.kind}</td>
                            <td>
                              {meta.warehouses.find((w) => w.id === r.warehouse_id)?.name ??
                                r.warehouse_id}
                              <small>{r.location}</small>
                            </td>
                            <td>{String(r.delta)}</td>
                            {meta.can_read_value && (
                              <td>
                                {exactMoney(
                                  r.value_delta,
                                  r.currency ?? meta.policy.currency ?? '',
                                  exponent,
                                )}
                              </td>
                            )}
                            <td>
                              {date(r.created_at)}
                              <Technical>
                                <pre>
                                  {JSON.stringify(
                                    {
                                      operation_id: r.operation_id,
                                      order_id: r.order_id,
                                      warehouse_document_id: r.warehouse_document_id,
                                      return_id: r.return_id,
                                      layer_id: r.layer_id,
                                    },
                                    null,
                                    2,
                                  )}
                                </pre>
                              </Technical>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {traceCursor && (
                    <button
                      type="button"
                      className="button"
                      disabled={io.busy}
                      onClick={() => void io.read(() => loadTrace(traceId, true))}
                    >
                      Wczytaj kolejne ruchy partii (do 50)
                    </button>
                  )}
                </section>
              )}
            </>
          )}
          {tab === 'opening' && (
            <section className="wms-card">
              <h3>Otwarcie całej firmy</h3>
              <p className="wms-help">
                Aktywacja wiąże cały istniejący zapas z partiami. Wymaga zakończenia aktywnych
                rezerwacji, fal, sesji i wskazanych zadań. Nie przepisuje dawnych wydań ani nie
                tworzy ich historycznego kosztu.
              </p>
              {enabled ? (
                <p className="wms-success">
                  FIFO jest już aktywne. Zmiana metody lub waluty oraz wyłączenie nie są dostępne w
                  tym procesie.
                </p>
              ) : (
                <>
                  {!meta.can_activate && (
                    <p className="wms-warning">
                      Aktywacja wymaga bieżących uprawnień administratora do zapasu i kosztów.
                    </p>
                  )}
                  <button
                    type="button"
                    className="button"
                    disabled={io.locked || !meta.can_activate}
                    onClick={() => void io.read(loadOpening)}
                  >
                    Wczytaj cały stan otwarcia — wszystkie strony
                  </button>
                  {openingBlockers.map((b, i) => (
                    <p key={i} className="wms-warning">
                      {b}
                    </p>
                  ))}
                  {openingLoaded && (
                    <>
                      <p>
                        Pełny zakres: {opening.length} pozycji. Ilości pozostają bez zmian; otwarcie
                        tworzy ich identyfikowalne warstwy.
                      </p>
                      <div className="wms-form">
                        <label>
                          Waluta kosztu netto
                          <select
                            value={currency}
                            disabled={io.locked}
                            onChange={(e) => {
                              dirty();
                              setCurrency(e.target.value);
                            }}
                          >
                            <option value="">Wybierz walutę wyceny</option>
                            {['PLN', 'EUR', 'USD', 'GBP', 'CZK'].map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Kod partii do ustawienia we wszystkich odczytanych wierszach
                          <input
                            value={bulkLot}
                            disabled={io.locked}
                            onChange={(e) => setBulkLot(e.target.value)}
                          />
                        </label>
                        <label>
                          Jawny koszt jednostki netto
                          <input
                            value={bulkCost}
                            inputMode="decimal"
                            disabled={io.locked || bulkUnknown}
                            onChange={(e) => setBulkCost(e.target.value)}
                          />
                        </label>
                        <label className="wms-check">
                          <input
                            type="checkbox"
                            checked={bulkUnknown}
                            disabled={io.locked}
                            onChange={(e) => setBulkUnknown(e.target.checked)}
                          />
                          Ustaw koszt jako nieznany, bez przyjmowania zera
                        </label>
                        <button
                          type="button"
                          className="button"
                          disabled={io.locked || !bulkLot.trim()}
                          onClick={() => {
                            dirty();
                            setOpening((old) => old.map((r) => ({ ...r, lot_code: bulkLot })));
                          }}
                        >
                          Ustaw kod we wszystkich {opening.length} wierszach
                        </button>
                        <button
                          type="button"
                          className="button"
                          disabled={io.locked}
                          onClick={() => {
                            try {
                              if (!bulkUnknown) minorFromText(bulkCost, exponent);
                              dirty();
                              setOpening((old) =>
                                old.map((r) => ({
                                  ...r,
                                  unknown: bulkUnknown,
                                  cost: bulkUnknown ? '' : bulkCost,
                                })),
                              );
                            } catch (e) {
                              io.setError(message(e));
                            }
                          }}
                        >
                          Ustaw koszt we wszystkich {opening.length} wierszach
                        </button>
                      </div>
                      <div className="wms-scroll">
                        <table className="wms-table">
                          <thead>
                            <tr>
                              <th>Produkt / magazyn</th>
                              <th>Lokalizacja</th>
                              <th>Stan przed → po</th>
                              <th>Kod partii</th>
                              <th>Koszt jednostki netto</th>
                              <th>Wersja stanu</th>
                            </tr>
                          </thead>
                          <tbody>
                            {opening.slice(openingPage * 50, (openingPage + 1) * 50).map((r, j) => {
                              const i = openingPage * 50 + j;
                              return (
                                <tr key={i}>
                                  <td>
                                    {r.sku}
                                    <small>{r.name}</small>
                                    <small>
                                      {meta.warehouses.find((w) => w.id === r.warehouse_id)?.name}
                                    </small>
                                  </td>
                                  <td>{r.location}</td>
                                  <td>
                                    {r.quantity} → {r.quantity}
                                  </td>
                                  <td>
                                    <input
                                      aria-label={'Kod partii otwarcia ' + r.sku + ' ' + r.location}
                                      value={r.lot_code}
                                      disabled={io.locked}
                                      onChange={(e) => {
                                        dirty();
                                        setOpening((old) =>
                                          old.map((v, n) =>
                                            n === i ? { ...v, lot_code: e.target.value } : v,
                                          ),
                                        );
                                      }}
                                    />
                                  </td>
                                  <td>
                                    <label className="wms-check">
                                      <input
                                        type="checkbox"
                                        checked={r.unknown}
                                        disabled={io.locked}
                                        onChange={(e) => {
                                          dirty();
                                          setOpening((old) =>
                                            old.map((v, n) =>
                                              n === i ? { ...v, unknown: e.target.checked } : v,
                                            ),
                                          );
                                        }}
                                      />
                                      Nieznany
                                    </label>
                                    <input
                                      aria-label={'Koszt otwarcia ' + r.sku + ' ' + r.location}
                                      disabled={io.locked || r.unknown}
                                      inputMode="decimal"
                                      value={r.cost}
                                      onChange={(e) => {
                                        dirty();
                                        setOpening((old) =>
                                          old.map((v, n) =>
                                            n === i ? { ...v, cost: e.target.value } : v,
                                          ),
                                        );
                                      }}
                                    />
                                  </td>
                                  <td>{r.stock_version}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div className="wms-actions">
                        <button
                          type="button"
                          className="button"
                          disabled={io.locked || !openingPage}
                          onClick={() => setOpeningPage((p) => p - 1)}
                        >
                          Poprzednie 50 wierszy
                        </button>
                        <span>
                          Strona {openingPage + 1} / {Math.max(1, Math.ceil(opening.length / 50))}
                        </span>
                        <button
                          type="button"
                          className="button"
                          disabled={io.locked || (openingPage + 1) * 50 >= opening.length}
                          onClick={() => setOpeningPage((p) => p + 1)}
                        >
                          Następne 50 wierszy
                        </button>
                      </div>
                      <label>
                        Uzasadnienie otwarcia
                        <textarea
                          value={note}
                          disabled={io.locked}
                          onChange={(e) => {
                            dirty();
                            setNote(e.target.value);
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="button primary"
                        disabled={
                          !write || !meta.can_activate || !!openingBlockers.length || !currency
                        }
                        onClick={openingPreview}
                      >
                        Utwórz podgląd całego otwarcia
                      </button>
                    </>
                  )}
                </>
              )}
            </section>
          )}
          {tab === 'receipt' && (
            <section className="wms-card">
              <h3>Przyjęcie nowej dostawy</h3>
              <p className="wms-help">
                Nowa partia wymaga znanego kosztu netto w walucie polityki:{' '}
                {meta.policy.currency ?? 'WMS jeszcze wyłączone'}. Koszt sprzedaży i VAT nie są
                kosztem zapasu. Przyjęcie tworzy lokalny dokument PZ i warstwy w jednej operacji.
              </p>
              {!meta.can_receive && (
                <p className="wms-warning">Brak bieżącego prawa przyjęcia z kosztem.</p>
              )}
              <button
                type="button"
                className="button"
                disabled={
                  !write || !enabled || !meta.can_receive || !product || receiptRows.length >= 500
                }
                onClick={() => {
                  if (!product) return;
                  dirty();
                  setReceiptRows((old) => [
                    ...old,
                    {
                      key: crypto.randomUUID(),
                      product,
                      location: '',
                      quantity: '',
                      lot_code: '',
                      cost: '',
                      expiry: '',
                    },
                  ]);
                }}
              >
                Dodaj wybrany produkt do przyjęcia
              </button>
              {!receiptRows.length && (
                <p className="wms-empty">
                  Wyszukaj produkt i dodaj go jawnie. Nic nie zostanie przyjęte przez samo otwarcie
                  panelu.
                </p>
              )}
              <div className="wms-scroll">
                <table className="wms-table">
                  <thead>
                    <tr>
                      <th>Produkt</th>
                      <th>Lokalizacja</th>
                      <th>Sztuki</th>
                      <th>Partia dostawcy</th>
                      <th>Koszt jednostki netto</th>
                      <th>Data ważności</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {receiptRows.map((r) => (
                      <tr key={r.key}>
                        <td>
                          {r.product.sku}
                          <small>{r.product.name}</small>
                        </td>
                        {(['location', 'quantity', 'lot_code', 'cost', 'expiry'] as const).map(
                          (field) => (
                            <td key={field}>
                              <input
                                aria-label={
                                  {
                                    location: 'Lokalizacja',
                                    quantity: 'Liczba sztuk',
                                    lot_code: 'Kod partii',
                                    cost: 'Koszt jednostki netto',
                                    expiry: 'Data ważności',
                                  }[field] +
                                  ' ' +
                                  r.product.sku
                                }
                                type={field === 'expiry' ? 'date' : 'text'}
                                inputMode={
                                  field === 'quantity'
                                    ? 'numeric'
                                    : field === 'cost'
                                      ? 'decimal'
                                      : undefined
                                }
                                disabled={io.locked}
                                value={r[field]}
                                onChange={(e) => {
                                  dirty();
                                  setReceiptRows((old) =>
                                    old.map((v) =>
                                      v.key === r.key ? { ...v, [field]: e.target.value } : v,
                                    ),
                                  );
                                }}
                              />
                            </td>
                          ),
                        )}
                        <td>
                          <button
                            type="button"
                            className="button"
                            disabled={io.locked}
                            onClick={() => {
                              dirty();
                              setReceiptRows((old) => old.filter((v) => v.key !== r.key));
                            }}
                          >
                            Usuń wiersz
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="wms-help">
                Data ważności jest metadaną. Ten proces nie włącza FEFO ani automatycznej blokady
                partii po terminie.
              </p>
              <label>
                Uzasadnienie przyjęcia
                <textarea
                  value={note}
                  disabled={io.locked}
                  onChange={(e) => {
                    dirty();
                    setNote(e.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                className="button"
                disabled={
                  !write || !enabled || !meta.can_receive || !warehouse || !receiptRows.length
                }
                onClick={() => void io.read(reviewReceipt)}
              >
                Sprawdź wersje stanów i przejrzyj przyjęcie
              </button>
              {receiptReview && (
                <section className="wms-card">
                  <h4>Lokalny przegląd przed zapisem</h4>
                  <p className="wms-warning">
                    To przegląd dokładnej treści i odczytanych wersji, nie zamrożony plan serwera.
                    Serwer sprawdzi aktualność całego przyjęcia przy zapisie i odrzuci całość przy
                    konflikcie.
                  </p>
                  <p>
                    {receiptReview.lines.length} jawnych wierszy · waluta {meta.policy.currency} ·
                    wersja polityki {receiptReview.policy_version}.
                  </p>
                  <div className="wms-scroll">
                    <table className="wms-table">
                      <thead>
                        <tr>
                          <th>Produkt</th>
                          <th>Partia / lokalizacja</th>
                          <th>Sztuki</th>
                          <th>Koszt jednostki netto</th>
                          <th>Data ważności</th>
                        </tr>
                      </thead>
                      <tbody>
                        {receiptReview.lines.map((r: any, i: number) => (
                          <tr key={i}>
                            <td>{receiptRows[i]?.product.sku}</td>
                            <td>
                              {r.lot_code}
                              <small>{r.location}</small>
                            </td>
                            <td>{r.quantity}</td>
                            <td>{exactMoney(r.unit_cost_minor, r.currency, exponent)}</td>
                            <td>{r.expiry_date ?? 'Nie podano'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Technical label="Odczytane wersje stanów">
                    <pre>{JSON.stringify(receiptReview.stock_versions, null, 2)}</pre>
                  </Technical>
                  <label className="wms-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={!write}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    Potwierdzam wszystkie partie, ilości i koszty tego lokalnego przyjęcia
                  </label>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!write || !meta.can_receive || !consent}
                    onClick={() =>
                      io.mutate(
                        prefix + '/receipts',
                        'POST',
                        receiptReview,
                        'Przyjęcie partii i kosztów',
                        saved,
                      )
                    }
                  >
                    Zapisz przyjęcie wszystkich wierszy
                  </button>
                </section>
              )}
            </section>
          )}
          {tab === 'movement' && (
            <section className="wms-card">
              <h3>Ruch z podglądem</h3>
              {movementKind === 'adjustment' && <p className="wms-help">Ręczna korekta partii: jawna zmiana ze znakiem, koszt w walucie polityki i nowa partia przy przyroście; przy ubytku wyłącznie wybrane rzeczywiste wolne warstwy. Po zapisie zobaczysz rzeczywisty dokument magazynowy albo korektę PW/RW.</p>}
              <div className="wms-form">
                <label>
                  Rodzaj operacji
                  <select
                    value={movementKind}
                    disabled={io.locked}
                    onChange={(e) => {
                      dirty();
                      setMovementKind(e.target.value as typeof movementKind);
                      setMovementVersions([]);
                      setMovementPositions([]);
                      setChosenLayers([]);
                    }}
                  >
                    {['issue', 'transfer', 'bin_move', 'adjustment'].map((k) => (
                      <option key={k} value={k}>
                        {names[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Lokalizacja źródłowa / korekty
                  <input
                    value={movementLocation}
                    disabled={io.locked}
                    onChange={(e) => {
                      dirty();
                      setMovementLocation(e.target.value);
                      setChosenLayers([]);
                    }}
                  />
                </label>
                {movementKind === 'transfer' && (
                  <label>
                    Magazyn docelowy
                    <select
                      value={destinationWarehouse}
                      disabled={io.locked}
                      onChange={(e) => {
                        dirty();
                        setDestinationWarehouse(e.target.value);
                        setMovementVersions([]);
                      }}
                    >
                      <option value="">Wybierz inny magazyn</option>
                      {meta.warehouses
                        .filter((w) => w.id !== warehouse)
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code} — {w.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {['transfer', 'bin_move'].includes(movementKind) && (
                  <label>
                    Lokalizacja docelowa
                    <input
                      value={destinationLocation}
                      disabled={io.locked}
                      onChange={(e) => {
                        dirty();
                        setDestinationLocation(e.target.value);
                      }}
                    />
                  </label>
                )}
                {movementKind === 'adjustment' && (
                  <label>
                    Kierunek korekty
                    <select
                      value={adjustDirection}
                      disabled={io.locked}
                      onChange={(e) => {
                        dirty();
                        setAdjustDirection(e.target.value as typeof adjustDirection);
                        setChosenLayers([]);
                      }}
                    >
                      <option value="minus">Zmniejsz o liczbę sztuk</option>
                      <option value="plus">Zwiększ o liczbę sztuk</option>
                    </select>
                  </label>
                )}
                <label>
                  {movementKind === 'adjustment'
                    ? 'Korekta o liczbę sztuk — nie stan docelowy'
                    : 'Liczba sztuk do ruchu'}
                  <input
                    value={quantity}
                    inputMode="numeric"
                    disabled={io.locked}
                    onChange={(e) => {
                      dirty();
                      setQuantity(e.target.value);
                    }}
                  />
                </label>
                {movementKind === 'adjustment' && adjustDirection === 'plus' && (
                  <>
                    <label>
                      Kod nowej partii korekty
                      <input
                        value={adjustLot}
                        disabled={io.locked}
                        onChange={(e) => {
                          dirty();
                          setAdjustLot(e.target.value);
                        }}
                      />
                    </label>
                    <label>
                      Znany koszt jednostki netto ({meta.policy.currency})
                      <input
                        value={adjustCost}
                        disabled={io.locked}
                        inputMode="decimal"
                        onChange={(e) => {
                          dirty();
                          setAdjustCost(e.target.value);
                        }}
                      />
                    </label>
                  </>
                )}
              </div>
              <p className="wms-help">
                Wydanie i przeniesienie dotyczą wyłącznie wolnych sztuk. MM i ruch między
                lokalizacjami zachowują tożsamość partii, koszt oraz kolejność FIFO. Korekta minus
                wymaga jawnego wyboru warstw; plus tworzy nową warstwę ze znanym kosztem.
              </p>
              <button
                type="button"
                className="button"
                disabled={io.locked || !enabled || !warehouse || !product}
                onClick={() => void io.read(readMovementScope)}
              >
                Odczytaj cały zapas produktu i wersje magazynów
              </button>
              {movementKind === 'adjustment' && <p>Zmiana ilości: {adjustDirection === 'minus' ? '−' : '+'}{quantity || '—'} szt. · waluta polityki: {meta.policy.currency ?? 'nieodczytana'}</p>}
              {movementVersions.length > 0 && (
                <>
                  <p>
                    Odczytano {movementPositions.length} pozycji bez obcięcia. Wersje pozostają
                    związane z tym odczytem; ponowny odczyt resetuje podgląd.
                  </p>
                  <PositionTable
                    rows={movementPositions}
                    exponent={exponent}
                    valueAllowed={meta.can_read_value}
                  />
                  <fieldset disabled={io.locked}>
                    <legend>
                      Jawny wybór wolnych warstw w lokalizacji {movementLocation || '—'}
                    </legend>
                    {movementPositions
                      .filter((p) => p.location === movementLocation && p.available > 0)
                      .map((p, i) => (
                        <label className="wms-check" key={p.layer_id + ':' + i}>
                          <input
                            type="checkbox"
                            checked={chosenLayers.includes(p.layer_id)}
                            onChange={(e) => {
                              dirty();
                              setChosenLayers((old) =>
                                e.target.checked
                                  ? [...new Set([...old, p.layer_id])]
                                  : old.filter((v) => v !== p.layer_id),
                              );
                            }}
                          />
                          {p.lot_code} · FIFO {p.fifo_sequence} · wolne {p.available} szt.
                        </label>
                      ))}
                    {movementKind !== 'adjustment' && (
                      <p className="wms-help">
                        Bez zaznaczenia serwer wybierze wolne fragmenty FIFO. To nie wybór
                        pierwszego wiersza w przeglądarce.
                      </p>
                    )}
                  </fieldset>
                </>
              )}
              {!movementAllowed && (
                <p className="wms-warning">
                  Bieżące uprawnienia nie pozwalają na wybrany rodzaj ruchu.
                </p>
              )}
              <label>
                Uzasadnienie ruchu
                <textarea
                  value={note}
                  disabled={io.locked}
                  onChange={(e) => {
                    dirty();
                    setNote(e.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                className="button primary"
                disabled={!write || !enabled || !movementAllowed || !movementVersions.length}
                onClick={movementPreview}
              >
                Utwórz zamrożony podgląd ruchu
              </button>
            </section>
          )}
          {preview && (
            <section className="wms-card">
              <h3>
                {preview.kind === 'opening'
                  ? 'Podgląd aktywacji całego WMS'
                  : 'Podgląd ruchu magazynowego'}
              </h3>
              <p>
                Wiersze: {preview.head.total} · ważny do {date(preview.head.expires_at)} ·{' '}
                {preview.head.ready ? 'Gotowy do potwierdzenia' : 'Zapis zablokowany'}.
              </p>
              {preview.head.issues.map((e, i) => (
                <p className="wms-error" key={i}>
                  {e}
                </p>
              ))}
              <Valuation
                value={preview.head}
                currency={preview.head.currency}
                exponent={exponent}
                permitted={meta.can_read_value}
              />
              <FrozenPreview
                key={preview.head.id}
                id={preview.head.id}
                kind={preview.kind}
                contextKey={contextKey}
                readOnly={readOnly}
                exponent={exponent}
                onDenied={io.deny}
                onLoaded={() => setPreviewLoaded(true)}
              />
              {preview.kind === 'opening' &&
                BigInt(String(preview.head.unknown_quantity ?? '0')) > 0n && (
                  <label className="wms-check">
                    <input
                      type="checkbox"
                      checked={unknownConsent}
                      disabled={!write || !preview.head.ready}
                      onChange={(e) => setUnknownConsent(e.target.checked)}
                    />
                    Akceptuję wskazane sztuki otwarcia o nieznanym koszcie; nie przyjmuję dla nich
                    wartości zero
                  </label>
                )}
              <label className="wms-check">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={!write || !preview.head.ready || !previewLoaded}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Potwierdzam cały zamrożony zakres, wszystkie fragmenty i lokalny skutek tej operacji
              </label>
              <button
                type="button"
                className="button primary"
                disabled={
                  !write ||
                  !preview.head.ready ||
                  !previewLoaded ||
                  !consent ||
                  (preview.kind === 'opening' &&
                    BigInt(String(preview.head.unknown_quantity ?? '0')) > 0n &&
                    !unknownConsent)
                }
                onClick={executePreview}
              >
                {preview.kind === 'opening'
                  ? 'Aktywuj FIFO dla całej firmy'
                  : 'Zapisz zatwierdzony ruch'}
              </button>
              <button type="button" className="button" disabled={io.locked} onClick={clearPreview}>
                Odrzuć podgląd i popraw szkic
              </button>
            </section>
          )}
          {result && (
            <section className="wms-card">
              <p className="wms-success" role="status">
                Zapisano lokalną operację: {names[result.operation.kind] ?? result.operation.kind} ·{' '}
                {date(result.operation.created_at)}. Odczytany wynik nie oznacza zdalnej płatności
                ani wysyłki.
              </p>
              {correctionDocumentLabel && <p role="status">{correctionDocumentLabel}</p>}
              {correctionDocumentError && <p role="alert">{correctionDocumentError}</p>}
              {resultCorrection ? (
                <section aria-label="Zapisany dokument korekty">
                  <h3>{resultCorrection.number} · {resultCorrection.kind==='PW'?'Przyrost zapasu':'Ubytek zapasu'}</h3>
                  <p>{resultCorrection.warehouse.name} ({resultCorrection.warehouse.code}) · {resultCorrection.quantity} szt.</p>
                  <div className="wms-scroll"><table className="wms-table">
                    <caption>Zapisane pozycje korekty</caption>
                    <thead><tr><th>Produkt</th><th>SKU</th><th>Lokalizacja</th><th>Zmiana liczby sztuk</th></tr></thead>
                    <tbody>{resultCorrection.rows.map((r,i)=><tr key={i}><th scope="row">{r.name}</th><td>{r.sku}</td><td>{r.location}</td><td>{r.delta.startsWith('-')?r.delta:'+'+r.delta} szt.</td></tr>)}</tbody>
                  </table></div>
                </section>
              ) : result.correction_document ? <p role="alert">Nie można odczytać pełnych pozycji dokumentu korekty. Otwórz dokument we wspólnym rejestrze magazynowym.</p> : null}
              <OperationResult
                result={result.result}
                meta={meta}
                valueAllowed={result.can_read_value}
              />
            </section>
          )}
          {tab === 'history' && (
            <section className="wms-card">
              <h3>Niezmienna historia operacji</h3>
              <button
                type="button"
                className="button"
                disabled={io.busy}
                onClick={() => void io.read(() => loadHistory())}
              >
                Odśwież historię
              </button>
              {historyLoaded && historyScope===correctionScope && !visibleHistory.length && (
                <p className="wms-empty">Brak zapisanych operacji partii w tej firmie.</p>
              )}
              <div className="wms-history">
                {visibleHistory.map((op) => {
                  const head=correctionHeadView(op.correction_head,op)??visibleCorrections[op.id];
                  return (
                  <button
                    className="button"
                    type="button"
                    key={op.id}
                    disabled={io.busy}
                    onClick={() =>
                      void io.read(async () => {
                        const d = await io.get<OperationResponse>(prefix + '/operations/' + op.id);
                        if(d.operation.id!==op.id)throw new Error('Odczytano inną operację niż wybrana.');
                        const selected=correctionHeadView(op.correction_head,op),detail=correctionQuantityView(d);
                        if(selected&&(!detail||!sameCorrectionHead(selected,detail)))
                          throw new Error('Pozycje korekty nie odpowiadają wybranemu dokumentowi. Otwórz wspólny rejestr magazynowy.');
                        showOperation(d);
                      })
                    }
                  >
                    {head ? <>
                      <strong>{head.number}</strong> · {head.kind==='PW'?'Przyrost zapasu':'Ubytek zapasu'} · {head.quantity} szt.
                      <small>{head.warehouse.name} · {head.product.name} ({head.product.sku}) · fragmenty partii: {head.row_count}</small>
                    </> : <strong>{names[op.kind] ?? op.kind}</strong>} · {date(op.created_at)}
                    {op.order_id && <small> · związana z zamówieniem</small>}
                    {op.return_id && <small> · związana ze zwrotem</small>}
                  </button>
                );})}
              </div>
              {historyScope===correctionScope && historyCursor && (
                <button
                  type="button"
                  className="button"
                  disabled={io.busy}
                  onClick={() => void io.read(() => loadHistory(true))}
                >
                  Wczytaj starsze operacje (do 50)
                </button>
              )}
            </section>
          )}
          <p className="wms-help">
            Koszt magazynowy jest kosztem jednostkowym netto w walucie polityki. Wartość części o
            znanym koszcie i liczba sztuk o nieznanym koszcie są wykazywane osobno; nieznany koszt
            nie jest przyjmowany jako zero.
          </p>
        </>
      )}
    </section>
  );
}

export type WmsReturnLotsPayload = {
  client_key: string;
  policy_version: string;
  stock_versions: StockVersion[];
  picks: { issue_fragment_id: string; quantity: number; location: string }[];
};
type ReturnPickDraft = { fragment: ReturnFragment; quantity: string; location: string };
export function WmsReturnLotsFields({
  orderId,
  warehouseId,
  physicalProductIds,
  allowedFragments,
  contextKey,
  readOnly,
  onChange,
}: {
  orderId: string;
  warehouseId: string;
  physicalProductIds: string[];
  allowedFragments?: { fragment_id: string; product_id: string; available: number }[];
  contextKey: string;
  readOnly: boolean;
  onChange: (payload: WmsReturnLotsPayload | null, ready: boolean) => void;
}) {
  const productsKey = JSON.stringify([...new Set(physicalProductIds)].sort());
  const fragmentScope = JSON.stringify(allowedFragments === undefined ? null : [...allowedFragments].sort((a,b)=>a.fragment_id.localeCompare(b.fragment_id)));
  const scopeKey = contextKey + ':' + orderId + ':' + warehouseId + ':' + productsKey + ':' + fragmentScope;
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [drafts, setDrafts] = useState<ReturnPickDraft[]>([]),
    [versions, setVersions] = useState<StockVersion[]>([]);
  const [draftPage, setDraftPage] = useState(0);
  const [loaded, setLoaded] = useState(false),
    [validation, setValidation] = useState('');
  const key = useRef(''),
    notify = useRef(onChange);
  notify.current = onChange;
  function invalidate() {
    key.current = crypto.randomUUID();
    notify.current(null, false);
  }
  function purge() {
    setMeta(null);
    setDrafts([]);
    setVersions([]);
    setLoaded(false);
    setDraftPage(0);
    setValidation('');
    key.current = '';
    notify.current(null, false);
  }
  const io = useWmsIO(scopeKey, readOnly, purge);
  useEffect(() => {
    purge();
    void io.read(async () => {
      const m = await io.get<Metadata>(prefix);
      setMeta(m);
      if (m.available && m.can_read && !m.policy.enabled) notify.current(null, true);
    });
  }, [scopeKey, readOnly]);
  async function load() {
    invalidate();
    setLoaded(false);
    setDrafts([]);
    setVersions([]);
    setDraftPage(0);
    setValidation('');
    const m = await io.get<Metadata>(prefix);
    setMeta(m);
    if (!m.available || !m.can_read)
      throw new Error('Nie można odczytać partii w tej kopii lub bieżącym zakresie uprawnień.');
    if (!m.policy.enabled) {
      notify.current(null, true);
      return;
    }
    if (!warehouseId || !m.warehouses.some((w) => w.id === warehouseId))
      throw new Error('Wybierz własny magazyn przyjęcia zwrotu.');
    const fragments: ReturnFragment[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const d: Page<ReturnFragment> = await io.get<Page<ReturnFragment>>(
        prefix +
          '/orders/' +
          orderId +
          '/return-fragments' +
          (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
      );
      fragments.push(...d.data);
      if (fragments.length > 10000)
        throw new Error('Pełny zakres zwrotu przekracza 10000 fragmentów. Nie obcięto wyboru.');
      cursor = d.meta.cursor;
      if (cursor && seen.has(cursor))
        throw new Error('Nieprawidłowa paginacja fragmentów. Wczytaj cały zakres ponownie.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    const productIds = [...new Set(physicalProductIds)].sort();
    if (!productIds.length)
      throw new Error('Brak jawnych fizycznych produktów do sprawdzenia wersji przyjęcia.');
    if (productIds.length > 500)
      throw new Error(
        'Zwrot przekracza 500 fizycznych produktów w zakresie stanów. Nie obcięto listy.',
      );
    const stockVersions: StockVersion[] = [];
    for (let start = 0; start < productIds.length; start += 50) {
      const ids = productIds.slice(start, start + 50);
      const d = await io.get<{ data: { product_id: string; version: unknown }[] }>(
        '/inventory/snapshot?' +
          new URLSearchParams({ warehouse_id: warehouseId, product_ids: ids.join(',') }),
      );
      for (const id of ids) {
        const r = d.data.find((s) => s.product_id === id);
        stockVersions.push({
          warehouse_id: warehouseId,
          product_id: id,
          version: r ? exactVersion(r.version) : '0',
        });
      }
    }
    let scopedFragments = fragments.filter(fragment => physicalProductIds.includes(fragment.product_id));
    if (allowedFragments !== undefined) {
      const uuid = (v:unknown) => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
      if (!Array.isArray(allowedFragments) || allowedFragments.length > 10000 || new Set(allowedFragments.map(f=>f.fragment_id)).size !== allowedFragments.length || allowedFragments.some(f=>!uuid(f.fragment_id) || !uuid(f.product_id) || !Number.isSafeInteger(f.available) || f.available < 0))
        throw Error('Niepełny zakres pierwotnych fragmentów wybranego wydania.');
      const ids = new Map(scopedFragments.map(fragment=>[fragment.id,fragment]));
      if (allowedFragments.some(f=>f.available>0 && (!ids.has(f.fragment_id) || ids.get(f.fragment_id)!.product_id !== f.product_id)))
        throw Error('Pierwotne fragmenty wybranego wydania zmieniły się. Odczytaj sprawę ponownie.');
      scopedFragments = scopedFragments.flatMap(fragment=>{
        const allowed=allowedFragments.find(f=>f.fragment_id===fragment.id);
        return allowed && allowed.available>0 ? [{...fragment,remaining:Math.min(fragment.remaining,allowed.available)}] : [];
      });
    }
    setDrafts(scopedFragments.map((fragment) => ({ fragment, quantity: '', location: '' })));
    setVersions(stockVersions);
    setLoaded(true);
  }
  useEffect(() => {
    if (!meta?.available || !meta.can_read) {
      notify.current(null, false);
      return;
    }
    if (!meta.policy.enabled) {
      notify.current(null, true);
      return;
    }
    if (!loaded || !versions.length || readOnly || meta.read_only || !meta.can_return) {
      notify.current(null, false);
      return;
    }
    try {
      const picks: WmsReturnLotsPayload['picks'] = [];
      for (let i = 0; i < drafts.length; i++) {
        const r = drafts[i];
        if (!r.quantity || r.quantity === '0') continue;
        if (!physicalProductIds.includes(r.fragment.product_id))
          throw new Error(
            'Fragment ' +
              (i + 1) +
              ': produkt nie należy do jawnego zakresu fizycznie przywracanych składników tej sprawy.',
          );
        const quantity = exactInteger(r.quantity, 'Zwrot fragmentu ' + (i + 1), 1n, 1000000n);
        if (quantity > r.fragment.remaining)
          throw new Error(
            'Fragment ' + (i + 1) + ': ilość przekracza pozostałe sztuki pierwotnego wydania.',
          );
        if (
          !r.location.trim() ||
          r.location.trim().length > 80 ||
          /[\u0000-\u001f\u007f]/.test(r.location)
        )
          throw new Error(
            'Fragment ' +
              (i + 1) +
              ': podaj lokalizację docelową (do 80 znaków, bez znaków sterujących).',
          );
        picks.push({ issue_fragment_id: r.fragment.id, quantity, location: r.location.trim() });
      }
      if (drafts.length && !picks.length) {
        setValidation('Wybierz jawnie ilości i lokalizacje fragmentów zwracanych fizycznie.');
        notify.current(null, false);
        return;
      }
      if (picks.length > 500)
        throw new Error(
          'Jedno przyjęcie zwrotu może obejmować najwyżej 500 jawnie wybranych fragmentów. Nie obcięto wyboru; zmniejsz jego zakres przed zatwierdzeniem.',
        );
      const payload = {
        client_key: key.current,
        policy_version: meta.policy.version,
        stock_versions: versions,
        picks,
      };
      if (!key.current || new TextEncoder().encode(JSON.stringify(payload)).byteLength > 2097152)
        throw new Error(
          'Zakres zwrotu przekracza limit lub nie ma klucza próby. Wczytaj pełny zakres ponownie.',
        );
      setValidation('');
      notify.current(payload, true);
    } catch (err) {
      setValidation(message(err));
      notify.current(null, false);
    }
  }, [meta, loaded, versions, drafts, readOnly, productsKey, fragmentScope]);
  return (
    <section className="wms-lots" aria-label="Pierwotne partie przyjmowanego zwrotu">
      <h3>Partie i koszt przyjęcia zwrotu</h3>
      <Availability meta={meta} readOnly={readOnly} />
      <IONotice io={io} />
      {meta?.available &&
        meta.can_read &&
        (meta.policy.enabled ? (
          <>
            <p className="wms-help">
              Wskaż pierwotne fragmenty wydania oraz docelowe lokalizacje. Ich ilości muszą
              odpowiadać fizycznym składnikom przywracanym w tej sprawie. Przyjęcie, sprawa zwrotu i
              zapas zapiszą się razem przy zatwierdzeniu istniejącego formularza.
            </p>
            {!meta.can_return && (
              <p className="wms-warning">
                Przyjęcie zwrotu wymaga bieżących uprawnień do zamówień i zapasu. Pierwotny koszt
                zachowuje serwer; dostęp do kwot jest osobnym uprawnieniem.
              </p>
            )}
            <button
              type="button"
              className="button"
              disabled={io.busy || readOnly || meta.read_only || !warehouseId}
              onClick={() => void io.read(load)}
            >
              Wczytaj wszystkie fragmenty i wersje stanów zwrotu
            </button>
            {loaded && !drafts.length && (
              <p className="wms-warning">
                Brak historycznych fragmentów partii. Jeśli wydanie nastąpiło przed aktywacją WMS,
                przyjęcie będzie jawnie oznaczone ZWROT o nieznanym koszcie. Nie przypisujemy mu
                kosztu zero; zgodność fizycznych składników sprawdzi serwer.
              </p>
            )}
            {loaded && (
              <>
                <p>
                  Odczytano cały zakres: {drafts.length} fragmentów i {versions.length} wersji
                  stanów.
                </p>
                <div className="wms-scroll">
                  <table className="wms-table">
                    <thead>
                      <tr>
                        <th>Pierwotna partia</th>
                        <th>Wydano / już przywrócono</th>
                        <th>Pozostało</th>
                        <th>Przyjmij sztuki</th>
                        <th>Lokalizacja docelowa</th>
                        {meta.can_read_value && <th>Pierwotny koszt netto</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {drafts.slice(draftPage * 50, (draftPage + 1) * 50).map((r, j) => {
                        const i = draftPage * 50 + j;
                        return (
                          <tr key={r.fragment.id}>
                            <td>
                              {r.fragment.lot_code}
                              <small>Pierwotna lokalizacja: {r.fragment.location}</small>
                              <Technical>
                                <p>Fragment: {r.fragment.id}</p>
                                <p>Produkt: {r.fragment.product_id}</p>
                              </Technical>
                            </td>
                            <td>
                              {r.fragment.quantity} / {r.fragment.returned_quantity}
                            </td>
                            <td>{r.fragment.remaining}</td>
                            <td>
                              <input
                                aria-label={
                                  'Zwrot sztuk partii ' +
                                  r.fragment.lot_code +
                                  ' fragment ' +
                                  (i + 1)
                                }
                                inputMode="numeric"
                                value={r.quantity}
                                disabled={
                                  io.busy ||
                                  readOnly ||
                                  meta.read_only ||
                                  !meta.can_return ||
                                  !r.fragment.remaining
                                }
                                onChange={(e) => {
                                  invalidate();
                                  setDrafts((old) =>
                                    old.map((v, n) =>
                                      n === i ? { ...v, quantity: e.target.value } : v,
                                    ),
                                  );
                                }}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={
                                  'Lokalizacja zwrotu partii ' +
                                  r.fragment.lot_code +
                                  ' fragment ' +
                                  (i + 1)
                                }
                                value={r.location}
                                disabled={
                                  io.busy ||
                                  readOnly ||
                                  meta.read_only ||
                                  !meta.can_return ||
                                  !r.fragment.remaining
                                }
                                onChange={(e) => {
                                  invalidate();
                                  setDrafts((old) =>
                                    old.map((v, n) =>
                                      n === i ? { ...v, location: e.target.value } : v,
                                    ),
                                  );
                                }}
                              />
                            </td>
                            {meta.can_read_value && (
                              <td>
                                {exactMoney(
                                  r.fragment.unit_cost_minor,
                                  r.fragment.currency,
                                  meta.policy.exponent,
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="wms-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={io.busy || !draftPage}
                    onClick={() => setDraftPage((p) => p - 1)}
                  >
                    Poprzednie 50 fragmentów
                  </button>
                  <span>
                    Strona {draftPage + 1} / {Math.max(1, Math.ceil(drafts.length / 50))}
                  </span>
                  <button
                    type="button"
                    className="button"
                    disabled={io.busy || (draftPage + 1) * 50 >= drafts.length}
                    onClick={() => setDraftPage((p) => p + 1)}
                  >
                    Następne 50 fragmentów
                  </button>
                </div>
                <Technical label="Dokładne wersje stanów przyjęcia">
                  <pre>{JSON.stringify(versions, null, 2)}</pre>
                </Technical>
              </>
            )}
            {validation && (
              <p className="wms-warning" role="status">
                {validation}
              </p>
            )}
          </>
        ) : (
          <p className="wms-help">
            Śledzenie partii jest wyłączone. Formularz przyjęcia zachowuje dotychczasowy proces
            ilościowy.
          </p>
        ))}
    </section>
  );
}
