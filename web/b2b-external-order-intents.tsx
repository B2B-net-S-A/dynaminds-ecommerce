import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, date, money, statusNames } from './api';
import { ProductPicker } from './catalog';
import { PriceListPicker } from './pricing';
import { OrderInitialFields, type InitialOrderFieldsState } from './order-fields';
import './b2b-external-order-intents.css';
import { browserRecovery, recoveryActor, recoveryRef, confirmedRecovery, matchesRecovery, originalKeyLocation, confirmOriginalKey, type RecoveryRef } from './browser-recovery-custody';

const prefix = '/b2b/external-order-intents';
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string;
  can_read: boolean;
  can_manage: boolean;
  can_read_value: boolean;
  can_write_fields: boolean;
};
type Allocation = {
  customer_item_id: string;
  local_quantity: number;
  external_quantity: number;
  unassigned_quantity: number;
  link_id: string | null;
};
type Component = { product_id: string; quantity: number; sku?: string; name?: string };
type IntentItem = Allocation & {
  product_id: string;
  sku: string;
  name: string;
  quantity: number;
  components: Component[];
  committed_quantity: number;
  dispatched_quantity: number;
};
type Intent = {
  id: string;
  order_id: string;
  version: number;
  state: 'open' | 'closed';
  items: IntentItem[];
  created_at: string;
  updated_at: string;
};
type Order = {
  id: string;
  number: string;
  customer_name: string;
  email: string;
  currency: string;
  status: string;
  total?: number;
  shipping_cost?: number;
  address: Record<string, unknown>;
  items?: {
    id: string;
    sku: string;
    name: string;
    quantity: number;
    price?: number;
    vat: number;
    line_total?: number;
  }[];
};
type Detail = Flags & { intent: Intent | null; order: Order; reused?: boolean };
type Options = Flags & {
  catalog_currency: string;
  limits: { items: number; quantity: number; page_rows: number };
  warehouses: { data: { id: string; name: string; code: string }[]; capped: boolean };
  links: { data: { id: string; supplier_name: string }[]; capped: boolean };
};
type Attempt = { path: string; body: string; role: string; recoveryOnly?: boolean };
const attempts = new Map<string, Attempt>();
let rememberedActor = '';
/** Called by the workspace boundary; ordinary modal close preserves a pending exact attempt. */
export function resetExternalOrderIntentContext(contextKey: string) {
  if (contextKey !== rememberedActor) {
    attempts.clear();
    rememberedActor = contextKey;
  }
}
function message(e: unknown) {
  return e instanceof Error ? e.message : 'Nie udało się wykonać operacji.';
}
function integer(text: string, max: number) {
  if (
    text.length > String(max).length ||
    !/^(0|[1-9][0-9]*)$/.test(text) ||
    BigInt(text) > BigInt(max)
  )
    throw Error('Ilość wymaga całej liczby od 0 do ' + max + '.');
  return Number(text);
}
function shippingMinor(text: string) {
  const s = text.trim().replace(',', '.');
  if (s.length > 10 || !/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(s))
    throw Error('Koszt dostawy wymaga kwoty nieujemnej z najwyżej dwoma miejscami po przecinku.');
  const [a, b = ''] = s.split('.');
  const n = BigInt(a) * 100n + BigInt(b.padEnd(2, '0'));
  if (n > 1000000n) throw Error('Koszt dostawy przekracza dozwolony zakres.');
  return Number(n);
}
type DraftAllocation = { local: string; external: string; unassigned: string; link: string };
function prepareAllocation(
  id: string,
  quantity: number,
  d: DraftAllocation,
  options: Options,
): Allocation {
  const local = integer(d.local, options.limits.quantity),
    external = integer(d.external, options.limits.quantity),
    unassigned = integer(d.unassigned, options.limits.quantity);
  if (local + external + unassigned !== quantity)
    throw Error(
      'Suma lokalnie, zewnętrznie i nieprzydzielone musi odpowiadać pełnej ilości pozycji.',
    );
  if (external && !options.links.data.some((l) => l.id === d.link))
    throw Error('Wybierz dostępnego dostawcę dla zewnętrznej części.');
  return {
    customer_item_id: id,
    local_quantity: local,
    external_quantity: external,
    unassigned_quantity: unassigned,
    link_id: external ? d.link : null,
  };
}
function allocationDraft(item: Allocation): DraftAllocation {
  return {
    local: String(item.local_quantity),
    external: String(item.external_quantity),
    unassigned: String(item.unassigned_quantity),
    link: item.link_id ?? '',
  };
}
function useIntentIO(
  contextKey: string,
  readOnly: boolean,
  target: string,
  onMutation: (d: Detail) => void,
) {
  const scope = contextKey + ':' + readOnly + ':' + target;
  const actor = recoveryActor(contextKey), slot = 'intent:' + target;
  const heldRecovery = useRef<RecoveryRef | null>(null);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const epoch = useRef(0),
    gate = useRef(false),
    callback = useRef(onMutation);
  callback.current = onMutation;
  const [options, setOptions] = useState<Options | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [blocked, setBlocked] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState<Attempt | null>(null),
    [revision, setRevision] = useState(0),
    [purge, setPurge] = useState(0),
    [rejection, setRejection] = useState(0);
  const valid = (e: number) => epoch.current === e && currentScope.current === scope;
  const clear = (removeDurable = true) => {
    const saved = browserRecovery.get(actor, slot);
    if (removeDurable && saved) browserRecovery.clear(saved);
    if (removeDurable) heldRecovery.current = null;
    attempts.delete(scope);
    setPending(null);
  };
  function fail(e: unknown) {
    setError(message(e));
    if (e instanceof ApiError && [401, 403, 423].includes(e.status)) {
      setBlocked(true);
      setOptions(null);
      setPurge((p) => p + 1);
    }
  }
  useEffect(() => {
    resetExternalOrderIntentContext(contextKey + ':' + readOnly);
    const e = ++epoch.current;
    gate.current = false;
    setBusy(false);
    setLoading(true);
    setOptions(null);
    setBlocked(false);
    setError('');
    setNotice('');
    setPurge((p) => p + 1);
    let remembered = attempts.get(scope) ?? null;
    try {
      heldRecovery.current = browserRecovery.get(actor,slot);
      if (!remembered && heldRecovery.current) remembered = {path:heldRecovery.current.path,body:'{}',role:'',recoveryOnly:true};
    } catch (err) { setBlocked(true); setError(message(err)); }
    setPending(remembered);
    api<Options>(prefix + '/options')
      .then((d) => {
        if (!valid(e)) return;
        if (remembered && (remembered.role !== d.current_role || !d.can_manage || d.read_only)) {
          setNotice(
            'Dostęp zmienił się. Oryginalna próba pozostaje zachowana; zapisy są wstrzymane.',
          );
          setPurge((p) => p + 1);
        }
        setOptions(d);
      })
      .catch((e2) => {
        if (valid(e)) fail(e2);
      })
      .finally(() => {
        if (valid(e)) setLoading(false);
      });
    return () => {
      ++epoch.current;
      gate.current = false;
    };
  }, [scope, revision]);
  const canWrite =
    !!options?.available && options.can_manage && !options.read_only && !readOnly && !blocked;
  async function readTask<T>(fetcher: () => Promise<T>, accept: (d: T) => void) {
    if (gate.current || currentScope.current !== scope || blocked) return;
    gate.current = true;
    const e = epoch.current;
    setBusy(true);
    setError('');
    try {
      const d = await fetcher();
      if (!valid(e)) return;
      const flags = d as Partial<Flags>;
      if (
        flags.current_role &&
        options &&
        (flags.current_role !== options.current_role ||
          (flags.can_read_value !== undefined && flags.can_read_value !== options.can_read_value))
      ) {
        setPurge((p) => p + 1);
        setOptions(null);
        setBlocked(true);
        throw Error('Uprawnienia zmieniły się. Odczytaj dostęp ponownie.');
      }
      if (flags.read_only) {
        setPurge((p) => p + 1);
        setOptions((o) => (o ? { ...o, read_only: true, can_manage: false } : o));
      }
      if (flags.current_role && typeof flags.can_manage === 'boolean')
        setOptions((o) =>
          o
            ? {
                ...o,
                can_manage: flags.can_manage!,
                ...(typeof flags.can_write_fields === 'boolean'
                  ? { can_write_fields: flags.can_write_fields }
                  : {}),
                ...(typeof flags.available === 'boolean' ? { available: flags.available } : {}),
              }
            : o,
        );
      accept(d);
    } catch (e2) {
      if (valid(e)) fail(e2);
    } finally {
      if (valid(e)) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  const read = <T,>(path: string, accept: (d: T) => void) => readTask(() => api<T>(path), accept);
  async function write(attempt: Attempt) {
    if (attempt.recoveryOnly || !canWrite || gate.current || currentScope.current !== scope) return;
    if (pending && (pending.path !== attempt.path || pending.body !== attempt.body)) {
      setError('Najpierw ustal wynik zachowanej próby.');
      return;
    }
    gate.current = true;
    const e = epoch.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const previous = browserRecovery.get(actor,slot);
      if (previous?.state === 'ack' && !pending && heldRecovery.current && JSON.stringify(previous) === JSON.stringify(heldRecovery.current)) browserRecovery.clear(previous);
      const initialSaved = recoveryRef(contextKey,slot,attempt.path,attempt.body);
      browserRecovery.put(initialSaved); heldRecovery.current = initialSaved;
      attempts.set(scope, attempt);
      setPending(attempt);
      const d = await api<Detail>(attempt.path, 'POST', JSON.parse(attempt.body));
      if (!valid(e)) return;
      if (!d.intent || d.intent.order_id !== d.order.id || !Number.isSafeInteger(d.intent.version) || d.intent.version < 1) throw Error('Niepełny potwierdzony wynik intencji.');
      const saved = heldRecovery.current;
      if (!saved) throw Error('Brak oryginalnej próby.');
      const known = confirmedRecovery(saved,d.order.id,String(d.intent.version),d.intent.id);
      browserRecovery.put(known); heldRecovery.current = known;
      if (d.current_role !== attempt.role || d.read_only || !d.can_manage) {
        setOptions(null);
        setBlocked(true);
        setPurge((p) => p + 1);
        throw Error('Dostęp zmienił się. Odczytaj wynik w historii.');
      }
      clear(false);
      callback.current(d);
      setNotice(
        d.reused
          ? 'Odczytano wynik wcześniej zapisanej dokładnej próby.'
          : attempt.path.endsWith('/cancel')
            ? 'Anulowano zamówienie i zamknięto intencję. Nie wykonano refundacji.'
            : attempt.path.endsWith('/reopen')
              ? 'Otwarto zamówienie i intencję ponownie. Nie złożono zlecenia dostawcy.'
              : attempt.path.endsWith('/allocate')
                ? 'Zapisano zmianę przydziału. Zlecenie dostawcy wymaga osobnej wyceny i zgody.'
                : 'Utworzono zamówienie z intencją dostawcy. Zlecenie dostawcy wymaga osobnej wyceny i zgody.',
      );
    } catch (e2) {
      if (!valid(e)) return;
      if (
        e2 instanceof ApiError &&
        e2.status >= 400 &&
        e2.status < 500 &&
        ![401,403,408,425,429].includes(e2.status)
      ) {
        clear();
        if ([409, 422].includes(e2.status)) setRejection((r) => r + 1);
      }
      fail(e2);
    } finally {
      if (valid(e)) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  async function recoverKnownResult() {
    const held=heldRecovery.current;
    if (!held) return;
    let accepted:Detail|null=null;
    const verifyActor=async()=>{
      const me=await api<{user:{tenant_id:string;id:string;role:string}}>('/auth/me');
      if (!me.user || me.user.tenant_id+':'+me.user.id!==actor || (options&&me.user.role!==options.current_role)) throw new ApiError('Kontekst intencji zmienił się.',403);
    };
    await readTask(async()=>{
      await verifyActor();
      const o=await api<Options>(prefix+'/options');
      if (o.available!==true || o.can_read!==true || typeof o.read_only!=='boolean' || typeof o.can_read_value!=='boolean' || (options&&(o.current_role!==options.current_role || o.can_read_value!==options.can_read_value || o.read_only!==options.read_only))) throw new ApiError('Dostęp do oryginalnej intencji zmienił się.',403);
      const endpoint=originalKeyLocation(held);
      if(endpoint.kind!=='external_order')throw Error('Obcy rodzaj oryginalnej próby.');
      const reply=await api<Flags & {recovery:unknown}>(endpoint.path);
      if (reply.available!==true || reply.can_read!==true || reply.current_role!==o.current_role || reply.read_only!==o.read_only || reply.can_read_value!==o.can_read_value) throw new ApiError('Dostęp do oryginalnego potwierdzenia zmienił się.',403);
      const {known}=confirmOriginalKey(held,reply.recovery,contextKey);
      const d=await api<Detail>(prefix+'/orders/'+known.resource);
      if (d.can_read!==true || d.available!==true || d.current_role!==o.current_role || d.read_only!==o.read_only || d.can_read_value!==o.can_read_value || !d.intent || !Number.isSafeInteger(d.intent.version) || d.intent.order_id!==d.order.id || !matchesRecovery(known,d.order.id,String(d.intent.version),d.intent.id,[known.receipt!])) throw Error('Odczyt nie potwierdza oryginalnego zamówienia i intencji.');
      const last=await api<Options>(prefix+'/options');
      await verifyActor();
      if (last.available!==true || last.can_read!==true || last.current_role!==o.current_role || last.read_only!==o.read_only || last.can_read_value!==o.can_read_value) throw new ApiError('Dostęp zmienił się przed potwierdzeniem wyniku.',403);
      return d;
    },d=>{accepted=d;});
    if (!accepted || heldRecovery.current!==held || currentScope.current!==scope) return;
    try { browserRecovery.clear(held);heldRecovery.current=null;clear(false);callback.current(accepted);setNotice('Odczytano oryginalny wynik bez ponawiania zapisu.'); }
    catch(err){setError(message(err));}
  }
  const send = (path: string, body: object) => {
    if (options) void write({ path, body: JSON.stringify(body), role: options.current_role });
  };
  return {
    options,
    busy,
    loading,
    blocked,
    error,
    notice,
    pending,
    purge,
    rejection,
    canWrite,
    locked: busy || !!pending || blocked || readOnly || !!options?.read_only,
    read,
    readTask,
    send,
    setError,
    recoverKnownResult,
    recovery: heldRecovery.current,
    retry: () => pending && !pending.recoveryOnly && void write(pending),
    reloadAccess: () => setRevision((r) => r + 1),
  };
}
type IO = ReturnType<typeof useIntentIO>;
function Access({ io }: { io: IO }) {
  return (
    <>
      {io.loading && <p role="status">Odczytywanie dostępu do intencji realizacji…</p>}
      {io.error && (
        <p className="intent-error" role="alert">
          {io.error}
        </p>
      )}
      {io.notice && (
        <p className="intent-notice" role="status">
          {io.notice}
        </p>
      )}
      {!io.loading && (!io.options || io.blocked) && (
        <button type="button" className="button" disabled={io.busy} onClick={io.reloadAccess}>
          Odczytaj dostęp ponownie
        </button>
      )}
      {io.options && !io.options.available && (
        <p>
          Ta kopia nie obsługuje zamówień z intencją zewnętrzną. Zwykłe zamówienie nadal wymaga
          własnej rezerwacji.
        </p>
      )}
      {io.options?.read_only && (
        <p className="intent-notice">
          Tylko odczyt. Przydziały i historia pozostają dostępne; zapisy są zablokowane.
        </p>
      )}
      {io.options?.available && !io.options.can_manage && !io.options.read_only && (
        <p className="intent-notice">
          Ten dostęp pozwala odczytać intencje, ale nie zatwierdzać ich zmian.
        </p>
      )}
      {io.pending && (
        <div className="intent-notice" role="alert">
          <strong>{io.pending.recoveryOnly ? 'Zachowano identyfikatory oryginalnej próby.' : 'Zachowano dokładną próbę zapisu.'}</strong>
          <p>
            {io.pending.recoveryOnly ? 'Nowe zapisy są wstrzymane. Nie odtworzono treści ani zgody; odczytaj oryginalny wynik bez ponawiania.' : 'Nowe zapisy są wstrzymane. Nie twórz drugiego zamówienia. Ponowienie użyje tego samego klucza i treści.'}
          </p>
          {!io.pending.recoveryOnly && <button type="button" className="button" disabled={io.busy || io.blocked} onClick={()=>void io.recoverKnownResult()}>Odczytaj oryginalny wynik bez ponawiania</button>}
          {io.pending.recoveryOnly ? <><p>Klucz: {io.recovery?.key ?? 'brak'} · zamówienie: {io.recovery?.resource ?? 'niepotwierdzone'}. Treści klienta ani zgody nie odtworzono.</p><button type="button" className="button" disabled={io.busy || io.blocked} onClick={()=>void io.recoverKnownResult()}>Odczytaj oryginalny wynik bez ponawiania</button></> : <button
            type="button"
            className="button primary"
            disabled={io.busy || !io.canWrite}
            onClick={io.retry}
          >
            Ponów dokładnie tę samą próbę
          </button>}
        </div>
      )}
    </>
  );
}
function AllocationInputs({
  quantity,
  draft,
  onChange,
  options,
  disabled,
}: {
  quantity: number;
  draft: DraftAllocation;
  onChange: (d: DraftAllocation) => void;
  options: Options;
  disabled: boolean;
}) {
  return (
    <div className="intent-allocation">
      {(
        [
          ['local', 'Lokalnie'],
          ['external', 'Do dostawcy'],
          ['unassigned', 'Nieprzydzielone'],
        ] as const
      ).map(([key, label]) => (
        <label key={key}>
          {label}
          <input
            aria-label={label}
            inputMode="numeric"
            value={draft[key]}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, [key]: e.target.value })}
          />
        </label>
      ))}
      <label>
        Dostawca
        <select
          aria-label="Dostawca intencji"
          value={draft.link}
          disabled={disabled || draft.external === '0'}
          onChange={(e) => onChange({ ...draft, link: e.target.value })}
        >
          <option value="">Wybierz dostawcę</option>
          {options.links.data.map((l) => (
            <option key={l.id} value={l.id}>
              {l.supplier_name}
            </option>
          ))}
        </select>
      </label>
      <p className="intent-muted">
        Pełna ilość handlowa: {quantity}. Suma trzech przydziałów musi być równa tej ilości.
        Zewnętrzny zamiar nie jest jeszcze zleceniem dostawcy.
      </p>
    </div>
  );
}
type Product = {
  id: string;
  sku: string;
  name: string;
  kind: string;
  active: boolean;
  version: number | string;
  components?: Component[];
};
type DraftLine = {
  id: string;
  product: Product | null;
  quantity: string;
  allocation: DraftAllocation;
};
const freshLine = (): DraftLine => ({
  id: crypto.randomUUID(),
  product: null,
  quantity: '1',
  allocation: { local: '0', external: '1', unassigned: '0', link: '' },
});
type CreateReview = {
  body: Record<string, unknown>;
  lines: {
    id: string;
    sku: string;
    name: string;
    quantity: number;
    price: number;
    vat: number;
    components: Component[];
    allocation: Allocation;
  }[];
  currency: string;
  total: number;
};
export function B2bExternalOrderCreate({
  contextKey,
  readOnly,
  onCreated,
  onClose,
}: {
  contextKey: string;
  readOnly: boolean;
  onCreated: (id: string) => void;
  onClose?: () => void;
}) {
  const [lines, setLines] = useState<DraftLine[]>([freshLine()]),
    [customer, setCustomer] = useState({
      customer_name: '',
      email: '',
      street: '',
      city: '',
      postal_code: '',
      phone: '',
      country: 'PL',
      payment_mode: 'prepaid',
      shipping: '0.00',
      note: '',
      warehouse: '',
    }),
    [list, setList] = useState<{ id: string; name: string; currency: string } | null>(null),
    [fields, setFields] = useState<InitialOrderFieldsState>({
      ready: false,
      available: false,
      changes: [],
      error: '',
    }),
    [review, setReview] = useState<CreateReview | null>(null),
    [consent, setConsent] = useState(false),
    [fieldReset, setFieldReset] = useState(0),
    [history, setHistory] = useState<(Partial<Intent> & { order_id: string; number?: string })[]>(
      [],
    ),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [historyLoaded, setHistoryLoaded] = useState(false);
  const io = useIntentIO(contextKey, readOnly, 'create', (d) => {
    setReview(null);
    setConsent(false);
    onCreated(d.order.id);
  });
  const [loadedPurge, setLoadedPurge] = useState(-1);
  useEffect(() => {
    if (io.purge === loadedPurge) return;
    setLoadedPurge(io.purge);
    setLines([freshLine()]);
    setCustomer({
      customer_name: '',
      email: '',
      street: '',
      city: '',
      postal_code: '',
      phone: '',
      country: 'PL',
      payment_mode: 'prepaid',
      shipping: '0.00',
      note: '',
      warehouse: '',
    });
    setList(null);
    setFields({ ready: false, available: false, changes: [], error: '' });
    setFieldReset((r) => r + 1);
    setReview(null);
    setConsent(false);
    setHistory([]);
    setHistoryCursor(null);
    setHistoryLoaded(false);
  }, [io.purge, loadedPurge]);
  useEffect(() => {
    setReview(null);
    setConsent(false);
  }, [io.rejection]);
  function invalidate() {
    setReview(null);
    setConsent(false);
  }
  function updateLine(id: string, change: Partial<DraftLine>) {
    if (io.locked) return;
    invalidate();
    setLines((old) => old.map((l) => (l.id === id ? { ...l, ...change } : l)));
  }
  async function prepare(e: FormEvent) {
    e.preventDefault();
    if (io.locked || !io.canWrite || !io.options) return;
    invalidate();
    try {
      if (!fields.ready) throw Error(fields.error || 'Zaczekaj na sprawdzenie dodatkowych pól.');
      if (
        !customer.warehouse ||
        !io.options.warehouses.data.some((w) => w.id === customer.warehouse)
      )
        throw Error('Wybierz własny magazyn dla lokalnej części.');
      if (!lines.length || lines.length > io.options.limits.items)
        throw Error('Wybierz od 1 do ' + io.options.limits.items + ' pozycji.');
      const allocations = lines.map((l) =>
        prepareAllocation(
          l.id,
          integer(l.quantity, io.options!.limits.quantity),
          l.allocation,
          io.options!,
        ),
      );
      if (lines.some((l) => !l.product || integer(l.quantity, io.options!.limits.quantity) < 1))
        throw Error('Wybierz produkt i dodatnią ilość każdej pozycji.');
      const shipping = shippingMinor(customer.shipping);
      const selected = lines.map((l) => ({
        customer_item_id: l.id,
        product_id: l.product!.id,
        quantity: integer(l.quantity, io.options!.limits.quantity),
      }));
      const body = {
        order: {
          customer_name: customer.customer_name.trim(),
          email: customer.email,
          warehouse_id: customer.warehouse,
          source: 'manual',
          payment_mode: customer.payment_mode,
          ...(list ? { price_list_id: list.id } : {}),
          shipping_cost: shipping,
          address: {
            street: customer.street,
            city: customer.city,
            postal_code: customer.postal_code,
            phone: customer.phone,
            country: customer.country,
          },
          note: customer.note,
          items: selected,
          ...(fields.available ? { initial_fields: structuredClone(fields.changes) } : {}),
        },
        allocations,
      };
      if (fields.changes.length && !io.options.can_write_fields)
        throw Error(
          'Ten dostęp nie pozwala zapisać dodatkowych pól. Nie usuwamy wpisanych wartości z żądania.',
        );
      const priceBody = {
        product_ids: [...new Set(selected.map((i) => i.product_id))],
        ...(list ? { price_list_id: list.id } : {}),
      };
      await io.readTask(
        async () => {
          const price = await api<{
            currency: string;
            items: { product_id: string; price: number; vat: number }[];
          }>('/pricing/quote', 'POST', priceBody);
          const products = await Promise.all(
            priceBody.product_ids.map((id) => api<Product & { vat: number }>('/products/' + id)),
          );
          const prepared = selected.map((i) => {
            const product = products.find((p) => p.id === i.product_id),
              quoted = price.items.find((p) => p.product_id === i.product_id);
            if (!product || !quoted || !product.active || product.kind === 'group')
              throw Error('Produkt albo cena nie są dostępne. Odczytaj dane ponownie.');
            const version = String(product.version);
            if (!/^[1-9][0-9]*$/.test(version))
              throw Error('Brak aktualnej wersji produktu. Odczytaj podsumowanie ponownie.');
            const components =
              product.kind === 'bundle'
                ? (product.components ?? [])
                : [{ product_id: product.id, sku: product.sku, name: product.name, quantity: 1 }];
            if (!components.length) throw Error('Zestaw nie ma pełnej receptury.');
            return {
              id: i.customer_item_id,
              sku: product.sku,
              name: product.name,
              quantity: i.quantity,
              price: quoted.price,
              vat: product.vat,
              product_id: product.id,
              product_version: version,
              components,
              allocation: allocations.find((a) => a.customer_item_id === i.customer_item_id)!,
            };
          });
          const total = prepared.reduce((n, l) => n + l.price * l.quantity, shipping);
          if (!Number.isSafeInteger(total) || total > 2147483647)
            throw Error('Wartość zamówienia przekracza limit.');
          const currentAccess = await api<Options>(prefix + '/options');
          if (fields.changes.length && !currentAccess.can_write_fields)
            throw new ApiError(
              'Bieżący dostęp nie pozwala zapisać dodatkowych pól. Odczytaj uprawnienia ponownie.',
              403,
            );
          return {
            ...currentAccess,
            review: {
              body: {
                ...body,
                order: { ...body.order, currency: price.currency },
                expected_commercial_snapshot: {
                  total,
                  currency: price.currency,
                  items: prepared.map((l) => ({
                    customer_item_id: l.id,
                    product_id: l.product_id,
                    quantity: l.quantity,
                    price: l.price,
                    vat: l.vat,
                    product_version: l.product_version,
                    components: l.components.map((c) => ({
                      product_id: c.product_id,
                      quantity: c.quantity,
                    })),
                  })),
                },
              },
              lines: prepared,
              currency: price.currency,
              total,
            },
          };
        },
        (result) => {
          setReview(result.review);
          setConsent(false);
        },
      );
    } catch (e2) {
      io.setError(message(e2));
    }
  }
  async function loadHistory(cursor?: string | null) {
    await io.read<
      Flags & {
        data: (Partial<Intent> & { order_id: string; number?: string })[];
        meta: { cursor: string | null };
      }
    >(
      prefix + '/orders?limit=25' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      (d) => {
        setHistory(d.data);
        setHistoryCursor(d.meta.cursor);
        setHistoryLoaded(true);
      },
    );
  }
  return (
    <section className="external-order-intents">
      <header>
        <h2>Zamówienie z intencją dostawcy</h2>
        <p>
          Tworzysz sprzedaż klienta i podział realizacji. Zlecenie dostawcy powstanie dopiero po
          osobnej wycenie i dwóch zgodach. Część zewnętrzna nie wymaga własnego zapasu i nie tworzy
          PZ.
        </p>
      </header>
      <Access io={io} />
      {io.options?.available && (
        <>
          <form onSubmit={prepare}>
            <fieldset disabled={io.locked || !io.canWrite} onChange={invalidate}>
              <div className="intent-grid">
                {(
                  [
                    ['customer_name', 'Imię i nazwisko'],
                    ['email', 'Email'],
                    ['street', 'Ulica i numer'],
                    ['city', 'Miasto'],
                    ['postal_code', 'Kod pocztowy'],
                    ['phone', 'Telefon'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      type={key === 'email' ? 'email' : 'text'}
                      required={key !== 'phone'}
                      maxLength={
                        key === 'customer_name' || key === 'street'
                          ? 200
                          : key === 'email'
                            ? 254
                            : key === 'city'
                              ? 100
                              : key === 'phone'
                                ? 30
                                : 20
                      }
                      value={customer[key]}
                      onChange={(e) => setCustomer((c) => ({ ...c, [key]: e.target.value }))}
                    />
                  </label>
                ))}
                <label>
                  Kraj (kod dwuliterowy)
                  <input
                    required
                    minLength={2}
                    maxLength={2}
                    value={customer.country}
                    onChange={(e) =>
                      setCustomer((c) => ({ ...c, country: e.target.value.toUpperCase() }))
                    }
                  />
                </label>
                <label>
                  Płatność klienta
                  <select
                    value={customer.payment_mode}
                    onChange={(e) => setCustomer((c) => ({ ...c, payment_mode: e.target.value }))}
                  >
                    <option value="prepaid">Przedpłata</option>
                    <option value="cod">Za pobraniem</option>
                  </select>
                </label>
                <label>
                  Magazyn lokalnej realizacji
                  <select
                    required
                    value={customer.warehouse}
                    onChange={(e) => setCustomer((c) => ({ ...c, warehouse: e.target.value }))}
                  >
                    <option value="">Wybierz własny magazyn</option>
                    {io.options.warehouses.data.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} · {w.code}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Koszt dostawy klienta
                  <input
                    inputMode="decimal"
                    required
                    value={customer.shipping}
                    onChange={(e) => setCustomer((c) => ({ ...c, shipping: e.target.value }))}
                  />
                </label>
              </div>
              <PriceListPicker
                value={list?.id ?? ''}
                onChange={(l) => {
                  setList(l);
                  invalidate();
                }}
              />
              {(io.options.links.capped || io.options.warehouses.capped) && (
                <p className="intent-notice">
                  Lista wyboru jest ograniczona. Niewidocznego dostawcy lub magazynu nie wybieramy
                  automatycznie.
                </p>
              )}
              <h3>Pozycje i przydział</h3>
              {lines.map((l, index) => (
                <article className="intent-line" key={l.id}>
                  <ProductPicker
                    label={'Produkt ' + (index + 1)}
                    value={l.product?.id ?? ''}
                    initial={l.product}
                    filter={(p) => p.active && p.kind !== 'group'}
                    select={(p) => updateLine(l.id, { product: p ?? null })}
                  />
                  <label>
                    Pełna ilość pozycji
                    <input
                      inputMode="numeric"
                      required
                      value={l.quantity}
                      onChange={(e) => updateLine(l.id, { quantity: e.target.value })}
                    />
                  </label>
                  <AllocationInputs
                    quantity={/^[0-9]+$/.test(l.quantity) ? Number(l.quantity) : 0}
                    draft={l.allocation}
                    options={io.options!}
                    disabled={io.locked || !io.canWrite}
                    onChange={(allocation) => updateLine(l.id, { allocation })}
                  />
                  {lines.length > 1 && (
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setLines((v) => v.filter((x) => x.id !== l.id));
                        invalidate();
                      }}
                    >
                      Usuń pozycję {index + 1}
                    </button>
                  )}
                </article>
              ))}
              <button
                type="button"
                className="button"
                disabled={lines.length >= io.options.limits.items}
                onClick={() => {
                  setLines((l) => [...l, freshLine()]);
                  invalidate();
                }}
              >
                Dodaj pozycję
              </button>
              <label>
                Notatka
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={customer.note}
                  onChange={(e) => setCustomer((c) => ({ ...c, note: e.target.value }))}
                />
              </label>
              <OrderInitialFields
                key={fieldReset}
                readOnly={readOnly || !io.canWrite}
                onChange={(f) => {
                  setFields(f);
                  setReview(null);
                  setConsent(false);
                }}
              />
              <button className="button" disabled={!fields.ready}>
                Przygotuj podsumowanie zamówienia
              </button>
            </fieldset>
          </form>
          {review && (
            <div className="intent-review">
              <h3>Podsumowanie do utworzenia</h3>
              <p>
                {customer.customer_name} · {customer.email}
                <br />
                {customer.street}, {customer.postal_code} {customer.city}, {customer.country}
              </p>
              <p>
                Waluta detaliczna: {review.currency} · Wartość:{' '}
                {money(review.total, review.currency)}. Przy utworzeniu serwer porówna te ceny, VAT,
                ilości i receptury. Zmiana wymaga nowego podsumowania i zgody.
              </p>
              <div className="intent-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Pozycja</th>
                      <th>Ilość</th>
                      <th>Cena brutto</th>
                      <th>VAT</th>
                      <th>Lokalnie</th>
                      <th>Do dostawcy</th>
                      <th>Nieprzydzielone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.lines.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {l.sku} · {l.name}
                          <small>
                            {l.components
                              .map((c) => (c.sku || c.product_id) + ' × ' + c.quantity)
                              .join(' · ')}
                          </small>
                        </td>
                        <td>{l.quantity}</td>
                        <td>{money(l.price, review.currency)}</td>
                        <td>{l.vat}%</td>
                        <td>{l.allocation.local_quantity}</td>
                        <td>
                          {l.allocation.external_quantity}
                          <small>
                            {
                              io.options?.links.data.find((x) => x.id === l.allocation.link_id)
                                ?.supplier_name
                            }
                          </small>
                        </td>
                        <td>{l.allocation.unassigned_quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                Rezerwujemy wyłącznie część lokalną. Niezlecony zamiar i nieprzydzielone ilości nie
                potwierdzają rezerwacji ani wydania u dostawcy.
              </p>
              <label className="intent-check">
                <input
                  type="checkbox"
                  disabled={io.locked || !io.canWrite}
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Potwierdzam dane klienta, pozycje i ten podział realizacji. Utworzenie nie składa
                zamówienia u dostawcy.
              </label>
              <button
                className="button primary"
                disabled={io.locked || !io.canWrite || !consent}
                onClick={() =>
                  io.send(prefix + '/orders', { client_key: crypto.randomUUID(), ...review.body })
                }
              >
                Utwórz zamówienie z intencją dostawcy
              </button>
            </div>
          )}
          <section>
            <h3>Odzyskaj wcześniej zapisane zamówienie</h3>
            <button
              type="button"
              className="button"
              disabled={io.busy}
              onClick={() => void loadHistory()}
            >
              Odczytaj historię intencji
            </button>
            {historyLoaded && !history.length && (
              <p>Odczyt zakończony. Brak zapisanych intencji w tym zakresie.</p>
            )}
            {history.map((h) => (
              <p key={h.id}>
                <button
                  type="button"
                  className="button"
                  disabled={io.busy}
                  onClick={() => onCreated(h.order_id)}
                >
                  {h.number ?? 'Otwórz zamówienie'} ·{' '}
                  {h.state === 'closed' ? 'Zamknięta intencja' : 'Otwarta intencja'}
                </button>
                {h.created_at && <small>{date(h.created_at)}</small>}
              </p>
            ))}
            {historyLoaded && (
              <div className="intent-actions">
                <button
                  type="button"
                  className="button"
                  disabled={io.busy}
                  onClick={() => void loadHistory()}
                >
                  Pierwsza strona
                </button>
                {historyCursor && (
                  <button
                    type="button"
                    className="button"
                    disabled={io.busy}
                    onClick={() => void loadHistory(historyCursor)}
                  >
                    Następna strona
                  </button>
                )}
              </div>
            )}
          </section>
        </>
      )}
      {onClose && (
        <button type="button" className="button" onClick={onClose}>
          Zamknij
        </button>
      )}
    </section>
  );
}

export function B2bExternalOrderIntents({
  orderId,
  contextKey,
  readOnly,
  onChanged,
}: {
  orderId: string;
  contextKey: string;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null),
    [drafts, setDrafts] = useState<Record<string, DraftAllocation>>({}),
    [consent, setConsent] = useState(false),
    [actionConsent, setActionConsent] = useState(false),
    [loaded, setLoaded] = useState(false);
  const io = useIntentIO(contextKey, readOnly, orderId, (d) => {
    setDetail(d);
    setDrafts(
      Object.fromEntries(
        d.intent?.items.map((i) => [i.customer_item_id, allocationDraft(i)]) ?? [],
      ),
    );
    setConsent(false);
    setActionConsent(false);
    onChanged();
  });
  useEffect(() => {
    setDetail(null);
    setDrafts({});
    setConsent(false);
    setActionConsent(false);
    setLoaded(false);
  }, [io.purge]);
  useEffect(() => {
    if (io.loading || !io.options?.available || loaded || io.blocked) return;
    void load();
  }, [io.loading, io.options?.available, io.purge]);
  async function load() {
    await io.read<Detail>(prefix + '/orders/' + orderId, (d) => {
      setDetail(d);
      setDrafts(
        Object.fromEntries(
          d.intent?.items.map((i) => [i.customer_item_id, allocationDraft(i)]) ?? [],
        ),
      );
      setLoaded(true);
      setConsent(false);
      setActionConsent(false);
    });
  }
  function allocate() {
    if (!detail?.intent || !io.options || io.locked) return;
    try {
      const allocations = detail.intent.items.map((i) =>
        prepareAllocation(
          i.customer_item_id,
          i.quantity,
          drafts[i.customer_item_id] ?? allocationDraft(i),
          io.options!,
        ),
      );
      io.send(prefix + '/orders/' + orderId + '/allocate', {
        client_key: crypto.randomUUID(),
        version: detail.intent.version,
        allocations,
        confirmed: true,
      });
    } catch (e) {
      io.setError(message(e));
    }
  }
  useEffect(() => {
    setConsent(false);
    setActionConsent(false);
  }, [io.rejection]);
  const intent = detail?.intent;
  // Ordinary orders have no new intent; their existing fulfillment UI remains unchanged.
  if (loaded && !intent && !io.error && !io.pending) return null;
  return (
    <section className="external-order-intents panel">
      <h2>Intencja realizacji zamówienia</h2>
      <Access io={io} />
      {io.options?.available && (
        <>
          <button className="button" disabled={io.busy} onClick={() => void load()}>
            Odczytaj przydział ponownie
          </button>
          {intent && (
            <>
              <p>
                {detail?.order.number} · Wersja przydziału {intent.version} ·{' '}
                {intent.state === 'open' ? 'Otwarty' : 'Zamknięty'}. Status zamówienia:{' '}
                {statusNames[detail?.order.status ?? ''] ?? detail?.order.status}.
              </p>
              <p>
                Zamiar dostawy jest osobny od zlecenia. Następny krok wykonasz w Sieci B2B: wybierz
                wskazanego dostawcę, zamówienie i pełne powiązania składników, a potem wycenę i dwie
                zgody.
              </p>
              <fieldset disabled={io.locked || !io.canWrite || intent.state !== 'open'}>
                {intent.items.map((i) => (
                  <article className="intent-line" key={i.customer_item_id}>
                    <h3>
                      {i.sku} · {i.name}
                    </h3>
                    <p>
                      Handlowo {i.quantity} · Zlecone {i.committed_quantity} · Wydane u dostawcy{' '}
                      {i.dispatched_quantity}
                    </p>
                    <p>
                      Obecny przydział: lokalnie {i.local_quantity}, do dostawcy{' '}
                      {i.external_quantity}, nieprzydzielone {i.unassigned_quantity}.
                    </p>
                    <p className="intent-muted">
                      Zamrożony skład:{' '}
                      {i.components
                        .map((c) => (c.sku || c.product_id) + ' × ' + c.quantity)
                        .join(' · ')}
                    </p>
                    <AllocationInputs
                      quantity={i.quantity}
                      draft={drafts[i.customer_item_id] ?? allocationDraft(i)}
                      options={io.options!}
                      disabled={io.locked || !io.canWrite || intent.state !== 'open'}
                      onChange={(d) => {
                        setDrafts((v) => ({ ...v, [i.customer_item_id]: d }));
                        setConsent(false);
                        setActionConsent(false);
                      }}
                    />
                  </article>
                ))}
              </fieldset>
              <p className="intent-notice">
                Przejście na realizację lokalną wymaga prawdziwego dostępnego zapasu. Zmiana
                zleconego lub wydanego zakresu może być zablokowana; nie przywracamy go milcząco do
                magazynu.
              </p>
              {intent.state === 'open' && (
                <>
                  <label className="intent-check">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={io.locked || !io.canWrite}
                      onChange={(e) => setConsent(e.target.checked)}
                    />
                    Potwierdzam ten pełny podział. Rezerwacje dotyczą wyłącznie lokalnej części.
                  </label>
                  <button
                    className="button primary"
                    disabled={io.locked || !io.canWrite || !consent}
                    onClick={allocate}
                  >
                    Zapisz przydział realizacji
                  </button>
                </>
              )}
              <details className="intent-lifecycle">
                <summary>
                  {intent.state === 'open'
                    ? 'Anulowanie zamówienia i intencji'
                    : 'Ponowne otwarcie intencji'}
                </summary>
                <p>
                  {intent.state === 'open'
                    ? 'Najpierw anuluj aktywne zlecenia dostawców. Nie anulujemy wydania ani nie wykonujemy refundacji tą akcją.'
                    : 'Otwarcie wymaga aktualnego, dopuszczalnego stanu. Nie zleci dostawy automatycznie i nie przywróci zewnętrznej części jako lokalnej rezerwacji.'}
                </p>
                <label className="intent-check">
                  <input
                    type="checkbox"
                    checked={actionConsent}
                    disabled={io.locked || !io.canWrite}
                    onChange={(e) => setActionConsent(e.target.checked)}
                  />
                  Potwierdzam{' '}
                  {intent.state === 'open'
                    ? 'anulowanie niewydanego zamówienia'
                    : 'ponowne otwarcie intencji'}{' '}
                  bez fikcyjnego ruchu lub wpłaty.
                </label>
                <button
                  className="button"
                  disabled={io.locked || !io.canWrite || !actionConsent}
                  onClick={() =>
                    io.send(
                      prefix +
                        '/orders/' +
                        orderId +
                        (intent.state === 'open' ? '/cancel' : '/reopen'),
                      { client_key: crypto.randomUUID(), version: intent.version, confirmed: true },
                    )
                  }
                >
                  {intent.state === 'open'
                    ? 'Anuluj zamówienie i intencję'
                    : 'Otwórz intencję ponownie'}
                </button>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}
