import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, date, statusNames } from './api';
import { WmsReturnLotsFields, type WmsReturnLotsPayload } from './wms-lots';
import {
  ReturnExchangeProductPicker,
  type ReturnExchangeProduct,
} from './return-exchange-product-picker';
import {
  performDropshipReturnWrite,
  purgeDropshipReturnAttempts,
  useDropshipReturnWriteState,
} from './b2b-dropshipping-returns';

type Component = { product_id: string; quantity: number };
type CaseItem = {
  item_id: string;
  product_id?: string;
  sku: string;
  name: string;
  requested: number;
  components?: Component[];
};
type Receipt = {
  id: string;
  return_id: string;
  replacement_order_id: string;
  scope_hash: string;
  created_at: string;
  proof_version?: number;
  replacements?: {
    original_item_id: string;
    replacement_item_id: string;
    replacement_product_id: string;
    quantity: number;
    components: Component[];
    product_snapshot: {
      id: string;
      version: string;
      sku: string;
      name: string;
      vat: number;
      kind: string;
      components: Component[];
    };
  }[];
  replacement_order?: {
    id: string;
    number: string;
    status: string;
    warehouse_id: string;
    shipments: { carrier: string; tracking_number: string | null; mode: string; status: string }[];
  };
};
type Case = {
  id: string;
  kind: string;
  state: string;
  version: string | number;
  warehouse_id: string;
  items: CaseItem[];
  can_exchange?: boolean;
  exchange?: Receipt | null;
  substitution_available?: boolean;
};
type Decision = {
  version: number;
  warehouse_id: string;
  note: string;
  items: {
    item_id: string;
    accepted: number;
    restocked: number;
    replacement_product_id?: string;
  }[];
  origin_id?: string;
  wms_lots?: WmsReturnLotsPayload;
};
type StockPosition = {
  product_id: string;
  sku: string;
  on_hand: number;
  reserved: number;
  available: number;
  version: string | null;
  return_quantity: number;
  replacement_quantity: number;
  after_on_hand: number;
  after_reserved: number;
  after_available: number;
};
type Preview = Decision & {
  return_id: string;
  scope_hash: string;
  original_order_id: string;
  receiver: { customer_name: string; address: Record<string, unknown> };
  rows: {
    item_id: string;
    product_id: string;
    sku: string;
    name: string;
    accepted: number;
    restocked: number;
    components: Component[];
    replacement?: {
      product_id: string;
      product_version: string;
      sku: string;
      name: string;
      vat: number;
      components: Component[];
    };
  }[];
  stock: StockPosition[];
  return_warehouse_id?: string;
  return_stock?: StockPosition[];
  wms_policy: { enabled: boolean; version: string | number };
  refund_amount: 0;
  replacement_total: 0;
  shipping_cost: 0;
  can_execute: boolean;
};
type PreviewReply = {
  preview: Preview;
  available: boolean;
  can_manage: boolean;
  current_role: string;
  substitution_available?: boolean;
};
type ExchangeReply = {
  return: Case;
  replacement_order: { id: string; number: string; status: string };
  exchange: Receipt;
  reused: boolean;
  available: boolean;
  can_manage: boolean;
  current_role: string;
  substitution_available?: boolean;
};
type Warehouse = { id: string; name: string; code: string };
type DraftItem = {
  item_id: string;
  accepted: string;
  restocked: string;
  replacement_mode: 'same' | 'other';
  replacement_product: ReturnExchangeProduct | null;
};

function integer(value: string, maximum: number) {
  if (!/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > BigInt(maximum))
    throw Error('Podaj całkowitą ilość w pokazanym zakresie.');
  return Number(value);
}
function draftItems(r: Case): DraftItem[] {
  return r.items.map((item) => ({
    item_id: item.item_id,
    accepted: String(item.requested),
    restocked: '0',
    replacement_mode: 'same',
    replacement_product: null,
  }));
}
function sameItems(left: Decision['items'], right: Decision['items']) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    new Set(left.map((item) => item.item_id)).size === left.length &&
    right.every((item) =>
      left.some(
        (candidate) =>
          candidate.item_id === item.item_id &&
          candidate.accepted === item.accepted &&
          candidate.restocked === item.restocked &&
          candidate.replacement_product_id === item.replacement_product_id,
      ),
    )
  );
}
function completeReturnStock(p: Preview, warehouseId: string) {
  if (p.warehouse_id === warehouseId || !p.rows.some((row) => row.restocked > 0)) return true;
  if (p.return_warehouse_id !== warehouseId || !Array.isArray(p.return_stock)) return false;
  const quantities = new Map<string, number>();
  for (const row of p.rows)
    for (const component of row.components)
      quantities.set(
        component.product_id,
        (quantities.get(component.product_id) ?? 0) + row.restocked * component.quantity,
      );
  const seen = new Set<string>();
  for (const position of p.return_stock) {
    if (
      !position ||
      seen.has(position.product_id) ||
      (!quantities.has(position.product_id) && position.return_quantity !== 0)
    )
      return false;
    seen.add(position.product_id);
    if (
      ![
        position.on_hand,
        position.reserved,
        position.available,
        position.return_quantity,
        position.replacement_quantity,
        position.after_on_hand,
        position.after_reserved,
        position.after_available,
      ].every((quantity) => Number.isSafeInteger(quantity) && quantity >= 0) ||
      position.return_quantity !== (quantities.get(position.product_id) ?? 0) ||
      position.replacement_quantity !== 0 ||
      position.after_on_hand !== position.on_hand + position.return_quantity ||
      position.after_reserved !== position.reserved ||
      position.available !== position.on_hand - position.reserved ||
      position.after_available !== position.available + position.return_quantity
    )
      return false;
  }
  return [...quantities].every(([productId, quantity]) => quantity === 0 || seen.has(productId));
}
function validatePreview(reply: PreviewReply, body: Decision, returnId: string, orderId: string) {
  const p = reply.preview;
  if (
    typeof reply.available !== 'boolean' ||
    typeof reply.can_manage !== 'boolean' ||
    typeof reply.current_role !== 'string'
  )
    throw Error('Brak bieżących uprawnień do wymiany.');
  if (!reply.available) throw new ApiError('Wymiana jest niedostępna w tej kopii.', 503);
  if (!reply.can_manage || reply.current_role !== 'admin')
    throw new ApiError('Wymiana wymaga bieżących uprawnień administratora.', 403);
  if (
    !p ||
    p.return_id !== returnId ||
    p.original_order_id !== orderId ||
    p.version !== body.version ||
    p.warehouse_id !== body.warehouse_id ||
    p.note !== body.note ||
    !/^[a-f0-9]{64}$/i.test(p.scope_hash) ||
    !sameItems(p.items, body.items) ||
    !Array.isArray(p.rows) ||
    p.rows.length !== body.items.length ||
    new Set(p.rows.map((item) => item.item_id)).size !== p.rows.length ||
    p.rows.some(
      (item) =>
        !Array.isArray(item.components) ||
        item.components.some(
          (component) =>
            typeof component.product_id !== 'string' ||
            !Number.isSafeInteger(component.quantity) ||
            component.quantity < 1,
        ),
    ) ||
    !p.rows.every((row) => {
      const decision = body.items.find((item) => item.item_id === row.item_id);
      if (!decision || row.accepted !== decision.accepted || row.restocked !== decision.restocked)
        return false;
      if (!row.replacement) return decision.replacement_product_id === undefined;
      const replacement = row.replacement;
      return (
        replacement.product_id === (decision.replacement_product_id ?? row.product_id) &&
        /^[1-9]\d*$/.test(replacement.product_version) &&
        typeof replacement.sku === 'string' &&
        typeof replacement.name === 'string' &&
        [0, 5, 8, 23].includes(replacement.vat) &&
        Array.isArray(replacement.components) &&
        replacement.components.length > 0 &&
        new Set(replacement.components.map((component) => component.product_id)).size ===
          replacement.components.length &&
        replacement.components.every(
          (component) =>
            typeof component.product_id === 'string' &&
            Number.isSafeInteger(component.quantity) &&
            component.quantity > 0,
        )
      );
    }) ||
    (body.items.some((item) => item.replacement_product_id !== undefined) &&
      reply.substitution_available !== true) ||
    !Array.isArray(p.stock) ||
    p.refund_amount !== 0 ||
    p.replacement_total !== 0 ||
    p.shipping_cost !== 0 ||
    p.can_execute !== true ||
    !p.receiver ||
    !p.wms_policy
  )
    throw Error('Niepełny lub niespójny podgląd wymiany. Odczytaj sprawę ponownie.');
  return p;
}

export function ReturnExchangePanel({
  r,
  order,
  contextKey,
  readOnly,
  write,
  disabled = false,
  localOriginId,
  onChanged,
  onOpenOrder,
  onLockedChange,
}: {
  r: Case;
  order: {
    id: string;
    currency: string;
    wms_lots_enabled?: boolean;
    items?: { id: string; product_id: string }[];
  };
  contextKey: string;
  readOnly: boolean;
  write: boolean;
  disabled?: boolean;
  localOriginId: string | null;
  onChanged: () => void;
  onOpenOrder?: (id: string) => void;
  onLockedChange?: (locked: boolean) => void;
}) {
  const identity = `${contextKey}:${readOnly}:${order.id}:${r.id}:${write}`;
  const scope = `${contextKey}:${readOnly}:exchange:${r.id}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const generation = useRef(0),
    gate = useRef(false);
  const shared = useDropshipReturnWriteState(contextKey, readOnly);
  const pending = shared.entries.find((entry) => entry.scope === scope);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouse, setWarehouse] = useState(''),
    [note, setNote] = useState('');
  const [items, setItems] = useState<DraftItem[]>(() => draftItems(r));
  const [lots, setLots] = useState<WmsReturnLotsPayload | null>(null),
    [lotsReady, setLotsReady] = useState(false);
  const [review, setReview] = useState<{ preview: Preview; body: Decision } | null>(null);
  const [confirmed, setConfirmed] = useState(false),
    [denied, setDenied] = useState(false);
  const [currentRole, setCurrentRole] = useState<string | null>(null);
  const [result, setResult] = useState<ExchangeReply | null>(null);
  const [loadedIdentity, setLoadedIdentity] = useState(identity);
  const visible = loadedIdentity === identity;
  const allowed = visible && write && !readOnly && !denied && currentRole === 'admin';
  const substitutionAvailable = r.substitution_available === true;
  const freshDisabled = !allowed || disabled || busy || shared.locked;
  const returnStockComplete = review ? completeReturnStock(review.preview, r.warehouse_id) : false;
  const receipt = visible ? (result?.exchange ?? r.exchange ?? null) : null;
  const replacement = visible
    ? (result?.replacement_order ?? receipt?.replacement_order ?? null)
    : null;
  const physicalProductIds = [
    ...new Set(
      r.items.flatMap((item) => {
        const draft = items.find((entry) => entry.item_id === item.item_id);
        return draft && /^(0|[1-9]\d*)$/.test(draft.restocked) && BigInt(draft.restocked) > 0n
          ? (item.components ?? []).map((component) => component.product_id)
          : [];
      }),
    ),
  ].sort();
  const needsLots = Boolean(order.wms_lots_enabled && physicalProductIds.length);
  const lotsScope = `${identity}:${JSON.stringify(items)}:${localOriginId ?? ''}`;
  const currentLotsScope = useRef(lotsScope);
  currentLotsScope.current = lotsScope;
  const lotsNotify = useRef(onLockedChange);
  lotsNotify.current = onLockedChange;
  useEffect(() => {
    lotsNotify.current?.(busy);
    return () => lotsNotify.current?.(false);
  }, [busy]);
  function invalidate() {
    setReview(null);
    setConfirmed(false);
  }
  function clear() {
    setOpen(false);
    setWarehouses([]);
    setWarehouse('');
    setNote('');
    setItems(draftItems(r));
    setLots(null);
    setLotsReady(false);
    invalidate();
    setResult(null);
    setNotice('');
  }
  useEffect(() => {
    ++generation.current;
    gate.current = false;
    setBusy(false);
    clear();
    setError('');
    setDenied(false);
    setCurrentRole(null);
    setLoadedIdentity(identity);
    const version = generation.current;
    if (r.kind === 'complaint' || r.exchange) {
      void api<{ user: { role: string } }>('/auth/me')
        .then((reply) => {
          if (version !== generation.current || currentIdentity.current !== identity) return;
          if (!reply.user || !['admin', 'operator', 'viewer'].includes(reply.user.role))
            throw Error('Nie można potwierdzić bieżącej roli.');
          setCurrentRole(reply.user.role);
        })
        .catch((e) => {
          if (version === generation.current && currentIdentity.current === identity) fail(e);
        });
    }
    return () => {
      ++generation.current;
      gate.current = false;
    };
  }, [identity]);
  useEffect(() => {
    invalidate();
    setLots(null);
    setLotsReady(false);
    setItems(draftItems(r));
  }, [r.version, localOriginId, r.substitution_available]);
  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : 'Nie udało się wykonać wymiany.');
    if (e instanceof ApiError && [401, 403, 423].includes(e.status)) {
      purgeDropshipReturnAttempts(contextKey, readOnly);
      clear();
      setDenied(true);
    }
    if (e instanceof ApiError && [400, 404, 409, 413, 422, 429].includes(e.status)) invalidate();
  }
  async function run(work: (current: () => boolean) => Promise<void>) {
    if (gate.current || !visible) return;
    const version = generation.current,
      sentIdentity = identity;
    const current = () =>
      version === generation.current && sentIdentity === currentIdentity.current;
    gate.current = true;
    setBusy(true);
    setError('');
    try {
      await work(current);
    } catch (e) {
      if (current()) fail(e);
    } finally {
      if (current()) {
        gate.current = false;
        setBusy(false);
      }
    }
  }
  function decision(): Decision {
    if (!warehouses.some((choice) => choice.id === warehouse))
      throw Error('Wybierz własny magazyn realizacji zamiennika.');
    if (note.trim().length < 3 || note.trim().length > 2000)
      throw Error('Podaj uzasadnienie wymiany (3–2000 znaków).');
    if (items.length !== r.items.length || r.items.length > 100)
      throw Error('Odczytaj pełny zakres zgłoszenia.');
    const values = r.items.map((item) => {
      const draft = items.find((entry) => entry.item_id === item.item_id);
      if (!draft) throw Error('Brak decyzji dla pozycji zgłoszenia.');
      const accepted = integer(draft.accepted, item.requested);
      const originalProductId =
        item.product_id ?? order.items?.find((line) => line.id === item.item_id)?.product_id;
      if (
        draft.replacement_mode === 'other' &&
        (!substitutionAvailable ||
          accepted < 1 ||
          !draft.replacement_product ||
          !draft.replacement_product.active)
      )
        throw Error(
          'Wybierz aktywny zamiennik dla każdej przyjętej pozycji albo pozostaw ten sam produkt.',
        );
      return {
        item_id: item.item_id,
        accepted,
        restocked: integer(draft.restocked, accepted),
        ...(draft.replacement_mode === 'other' &&
        draft.replacement_product?.id !== originalProductId
          ? { replacement_product_id: draft.replacement_product!.id }
          : {}),
      };
    });
    if (!values.some((item) => item.accepted > 0))
      throw Error('Wymiana wymaga przyjęcia co najmniej jednej sztuki.');
    if (needsLots && (!lotsReady || !lots))
      throw Error('Wczytaj i wybierz pierwotne partie całego przywracanego zakresu.');
    const version = integer(String(r.version), 2147483647);
    if (version < 1) throw Error('Odczytaj aktualną wersję reklamacji.');
    return {
      version,
      warehouse_id: warehouse,
      note: note.trim(),
      items: values,
      ...(localOriginId ? { origin_id: localOriginId } : {}),
      ...(needsLots && lots ? { wms_lots: structuredClone(lots) } : {}),
    };
  }
  function start() {
    if (freshDisabled || r.can_exchange !== true || r.state !== 'requested') return;
    void run(async (current) => {
      const reply = await api<{ data: Warehouse[] }>('/warehouses');
      if (!current()) return;
      if (
        !Array.isArray(reply.data) ||
        new Set(reply.data.map((entry) => entry.id)).size !== reply.data.length
      )
        throw Error('Niepełna lista własnych magazynów.');
      setWarehouses(reply.data);
      setOpen(true);
    });
  }
  function prepare(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (freshDisabled || r.can_exchange !== true || r.state !== 'requested') return;
    void run(async (current) => {
      invalidate();
      const body = decision();
      const reply = await api<PreviewReply>(`/returns/${r.id}/exchange-preview`, 'POST', body);
      if (!current()) return;
      const preview = validatePreview(reply, body, r.id, order.id);
      setReview({ preview: structuredClone(preview), body: structuredClone(body) });
      setConfirmed(false);
    });
  }
  function execute(exactRetry = false) {
    if (
      !allowed ||
      busy ||
      pending?.inFlight ||
      (!exactRetry &&
        (freshDisabled ||
          !review ||
          !returnStockComplete ||
          !confirmed ||
          r.can_exchange !== true ||
          r.state !== 'requested'))
    )
      return;
    const attempt = exactRetry
      ? pending?.attempt
      : review
        ? {
            action: 'wymiana reklamacyjna',
            path: `/returns/${r.id}/exchange`,
            method: 'POST' as const,
            body: JSON.stringify({
              ...review.body,
              client_key: crypto.randomUUID(),
              scope_hash: review.preview.scope_hash,
              confirmed: true,
            }),
          }
        : null;
    if (!attempt || attempt.path !== `/returns/${r.id}/exchange`) return;
    void run(async (current) => {
      // Fresh membership is checked even when a completed uncertain exchange can no longer be previewed.
      const actor = await api<{ user: { role: string } }>('/auth/me');
      if (!current()) return;
      if (!actor.user || actor.user.role !== 'admin')
        throw new ApiError('Wymiana wymaga bieżących uprawnień administratora.', 403);
      const reply = await performDropshipReturnWrite<ExchangeReply>(
        contextKey,
        readOnly,
        scope,
        attempt,
      );
      if (!current()) return;
      const expected = JSON.parse(attempt.body) as Decision & { scope_hash: string };
      const selectedTargetsMatch =
        !expected.items.some((item) => item.replacement_product_id) ||
        (reply.substitution_available === true &&
          reply.exchange?.proof_version === 2 &&
          Array.isArray(reply.exchange.replacements) &&
          reply.exchange.replacements.length ===
            expected.items.filter((item) => item.accepted > 0).length &&
          new Set(reply.exchange.replacements.map((line) => line.original_item_id)).size ===
            reply.exchange.replacements.length &&
          expected.items
            .filter((item) => item.accepted > 0)
            .every((item) => {
              const line = reply.exchange.replacements!.find(
                (candidate) => candidate.original_item_id === item.item_id,
              );
              return (
                line &&
                line.quantity === item.accepted &&
                (item.replacement_product_id === undefined ||
                  line.replacement_product_id === item.replacement_product_id) &&
                line.product_snapshot?.id === line.replacement_product_id &&
                typeof line.product_snapshot.sku === 'string' &&
                typeof line.product_snapshot.name === 'string' &&
                /^[1-9]\d*$/.test(line.product_snapshot.version) &&
                Array.isArray(line.components)
              );
            }));
      if (
        reply.available !== true ||
        reply.can_manage !== true ||
        reply.current_role !== 'admin' ||
        typeof reply.reused !== 'boolean' ||
        !reply.exchange ||
        reply.exchange.return_id !== r.id ||
        reply.exchange.scope_hash !== expected.scope_hash ||
        reply.return?.id !== r.id ||
        !reply.replacement_order ||
        reply.replacement_order.id !== reply.exchange.replacement_order_id ||
        !selectedTargetsMatch
      ) {
        setDenied(true);
        throw Error(
          'Odczytaj sprawę ponownie, aby potwierdzić zapisany zamiennik. Nie twórz kolejnej wymiany.',
        );
      }
      setResult(reply);
      invalidate();
      setOpen(false);
      setNotice(
        reply.reused
          ? 'Odnaleziono wcześniej zapisaną wymianę.'
          : 'Zapisano wymianę i realizację zamiennika.',
      );
      onChanged();
    });
  }
  if (r.kind !== 'complaint' && !r.exchange) return null;
  return (
    <section className="info-section" aria-label="Wymiana reklamacyjna">
      <h4>Wymiana reklamacyjna</h4>
      <p>
        Wymiana bez dopłaty. Realizacja zamiennika nie jest drugą sprzedażą ani zwrotem środków.
        Odrębne wydanie wymaga rzeczywistego zapasu, kompletacji i przesyłki.
      </p>
      {visible && currentRole && currentRole !== 'admin' && (
        <p className="muted">Wymianę zatwierdza administrator. Historia pozostaje dostępna.</p>
      )}
      {visible && error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      {visible && notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {receipt && (
        <div className="notice">
          <p>
            Wymianę zapisano {date(receipt.created_at)}. {replacement?.number}
            {replacement?.status
              ? ` · ${replacement.status === 'paid' ? 'Gotowe do kompletacji' : (statusNames[replacement.status] ?? replacement.status)}`
              : ''}
          </p>
          {receipt.replacement_order?.shipments?.map((shipment, index) => (
            <p key={`${shipment.carrier}:${shipment.tracking_number}:${index}`}>
              {shipment.carrier} · {shipment.tracking_number ?? 'Brak numeru śledzenia'} ·{' '}
              {shipment.status}
              {shipment.mode === 'demo' ? ' · DEMO (bez potwierdzenia nadania u przewoźnika)' : ''}
            </p>
          ))}
          {receipt.replacements?.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Przyjęty towar</th>
                    <th>Zapisany zamiennik</th>
                    <th>Ilość bezpłatna</th>
                  </tr>
                </thead>
                <tbody>
                  {receipt.replacements.map((line) => {
                    const original = r.items.find((item) => item.item_id === line.original_item_id);
                    return (
                      <tr key={line.original_item_id}>
                        <td>
                          {original?.sku ?? 'Pozycja reklamacji'}
                          <small>{original?.name}</small>
                        </td>
                        <td>
                          {line.product_snapshot.sku}
                          <small>{line.product_snapshot.name}</small>
                          <small>
                            Wersja produktu przy wymianie: {line.product_snapshot.version}
                          </small>
                          <details>
                            <summary>Fizyczny zakres zamiennika</summary>
                            {line.components.map((component) => (
                              <p key={component.product_id}>
                                {component.product_id} × {component.quantity}
                              </p>
                            ))}
                          </details>
                        </td>
                        <td>
                          {line.quantity} · 0,00 {order.currency}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <small>
                Etykiety i receptura pochodzą z zapisu wymiany, nie z aktualnego katalogu.
              </small>
            </div>
          ) : null}
          {onOpenOrder && (
            <button
              type="button"
              className="button"
              disabled={busy || shared.locked}
              onClick={() => onOpenOrder(receipt.replacement_order_id)}
            >
              Otwórz realizację zamiennika
            </button>
          )}
        </div>
      )}
      {pending && (
        <div className="notice">
          <p>
            {pending.inFlight ? 'Trwa zapis wymiany.' : 'Wynik wymiany wymaga potwierdzenia.'}{' '}
            Dokładna treść i klucz są zachowane w pamięci także po nawigacji. Odczyt sprawy nie
            usuwa próby; nie odświeżaj strony.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={!allowed || busy || pending.inFlight}
            onClick={() => execute(true)}
          >
            Ponów dokładną próbę wymiany
          </button>
        </div>
      )}
      {(pending || receipt) && (
        <button type="button" className="button" disabled={busy} onClick={onChanged}>
          Odczytaj sprawę i historię
        </button>
      )}
      {!receipt && r.state === 'requested' && r.can_exchange === true && !open && (
        <button type="button" className="button" disabled={freshDisabled} onClick={start}>
          Przygotuj wymianę
        </button>
      )}
      {visible && open && (
        <form className="return-form" onSubmit={prepare}>
          <fieldset disabled={freshDisabled}>
            <label>
              Magazyn realizacji zamiennika
              <select
                value={warehouse}
                required
                onChange={(e) => {
                  setWarehouse(e.target.value);
                  setItems((old) => old.map((item) => ({ ...item, replacement_product: null })));
                  invalidate();
                }}
              >
                <option value="">Wybierz magazyn</option>
                {warehouses.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name} · {choice.code}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Przyjęcie reklamowanego towaru dotyczy magazynu zgłoszenia. Uszkodzony towar: ustaw
              ilość „Do sprzedaży” na 0.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Pozycja</th>
                    <th>Zgłoszono</th>
                    <th>Przyjęte / zamienniki</th>
                    <th>Do sprzedaży</th>
                    {substitutionAvailable && <th>Produkt zamienny</th>}
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((item) => {
                    const draft = items.find((entry) => entry.item_id === item.item_id);
                    return (
                      <tr key={item.item_id}>
                        <td>
                          {item.sku}
                          <small>{item.name}</small>
                        </td>
                        <td>{item.requested}</td>
                        {(['accepted', 'restocked'] as const).map((field) => (
                          <td key={field}>
                            <input
                              type="number"
                              min={0}
                              max={item.requested}
                              step={1}
                              required
                              aria-label={`${field === 'accepted' ? 'Przyjęte do wymiany' : 'Do sprzedaży'} ${item.sku}`}
                              value={draft?.[field] ?? ''}
                              onChange={(e) => {
                                setItems((old) =>
                                  old.map((entry) =>
                                    entry.item_id === item.item_id
                                      ? {
                                          ...entry,
                                          [field]: e.target.value,
                                          ...(field === 'accepted' && e.target.value === '0'
                                            ? {
                                                replacement_mode: 'same' as const,
                                                replacement_product: null,
                                              }
                                            : {}),
                                        }
                                      : entry,
                                  ),
                                );
                                setLots(null);
                                setLotsReady(false);
                                invalidate();
                              }}
                            />
                          </td>
                        ))}
                        {substitutionAvailable && (
                          <td>
                            <label>
                              Rodzaj zamiennika · {item.sku}
                              <select
                                value={draft?.replacement_mode ?? 'same'}
                                disabled={
                                  freshDisabled || !draft || !/^[1-9]\d*$/.test(draft.accepted)
                                }
                                onChange={(e) => {
                                  const mode = e.target.value === 'other' ? 'other' : 'same';
                                  setItems((old) =>
                                    old.map((entry) =>
                                      entry.item_id === item.item_id
                                        ? {
                                            ...entry,
                                            replacement_mode: mode,
                                            replacement_product: null,
                                          }
                                        : entry,
                                    ),
                                  );
                                  invalidate();
                                }}
                              >
                                <option value="same">Ten sam produkt</option>
                                <option value="other">Inny produkt — bez dopłaty</option>
                              </select>
                            </label>
                            {draft?.replacement_mode === 'other' && (
                              <ReturnExchangeProductPicker
                                key={`replacement-picker:${identity}:${r.version}:${warehouse}:${item.item_id}:${draft.accepted}`}
                                contextKey={identity + ':' + r.version}
                                warehouseId={warehouse}
                                itemId={item.item_id}
                                readOnly={readOnly}
                                disabled={freshDisabled || !/^[1-9]\d*$/.test(draft.accepted)}
                                value={draft.replacement_product}
                                onError={fail}
                                onChange={(product) => {
                                  if (currentIdentity.current !== identity || freshDisabled) return;
                                  const originalId =
                                    item.product_id ??
                                    order.items?.find((line) => line.id === item.item_id)
                                      ?.product_id;
                                  setItems((old) =>
                                    old.map((entry) =>
                                      entry.item_id === item.item_id
                                        ? {
                                            ...entry,
                                            replacement_mode:
                                              product?.id === originalId ? 'same' : 'other',
                                            replacement_product:
                                              product?.id === originalId ? null : product,
                                          }
                                        : entry,
                                    ),
                                  );
                                  invalidate();
                                }}
                              />
                            )}
                            <small>
                              Liczba zamienników jest równa liczbie przyjętej. Przywrócenie na stan
                              dotyczy oryginalnego towaru.
                            </small>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!substitutionAvailable && (
              <p className="muted">
                W tej kopii dostępna jest wymiana na ten sam produkt. Wybór innego produktu wymaga
                dostępnego modułu zamienników.
              </p>
            )}
            {needsLots && (
              <WmsReturnLotsFields
                key={lotsScope}
                orderId={order.id}
                warehouseId={r.warehouse_id}
                physicalProductIds={physicalProductIds}
                contextKey={contextKey}
                readOnly={readOnly}
                onChange={(payload, ready) => {
                  if (
                    currentIdentity.current !== identity ||
                    currentLotsScope.current !== lotsScope
                  )
                    return;
                  setLots(payload);
                  setLotsReady(ready);
                  invalidate();
                }}
              />
            )}
            <label>
              Uzasadnienie wymiany
              <textarea
                value={note}
                minLength={3}
                maxLength={2000}
                required
                onChange={(e) => {
                  setNote(e.target.value);
                  invalidate();
                }}
              />
            </label>
            <button className="button primary" disabled={needsLots && !lotsReady}>
              Sprawdź pełny podgląd wymiany
            </button>
          </fieldset>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              invalidate();
            }}
          >
            Zamknij formularz
          </button>
        </form>
      )}
      {visible && review && (
        <div className="info-body">
          <h4>Pełny podgląd wymiany</h4>
          <p>
            Odbiorca: {review.preview.receiver.customer_name} ·{' '}
            {['street', 'postal_code', 'city', 'country']
              .map((key) => String(review.preview.receiver.address?.[key] ?? ''))
              .filter(Boolean)
              .join(', ')}
          </p>
          <p>
            Magazyn zamiennika:{' '}
            {warehouses.find((choice) => choice.id === review.preview.warehouse_id)?.name ?? '—'}.
            Zamiennik: 0,00 · dostawa: 0,00 · zwrot środków: 0,00 {order.currency}. Zapis nie
            wykonuje żadnej płatności.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pozycja źródłowa</th>
                  <th>Przyjęte / zamienniki</th>
                  <th>Do sprzedaży</th>
                  <th>Zamiennik · bez dopłaty</th>
                </tr>
              </thead>
              <tbody>
                {review.preview.rows.map((item) => (
                  <tr key={item.item_id}>
                    <td>
                      {item.sku}
                      <small>{item.name}</small>
                      <small>
                        Przyjmowany zakres jednej sztuki:{' '}
                        {item.components
                          .map(
                            (component) =>
                              `${[...review.preview.stock, ...(review.preview.return_stock ?? [])].find((position) => position.product_id === component.product_id)?.sku ?? component.product_id} × ${component.quantity}`,
                          )
                          .join(', ') || 'Brak udokumentowanego zakresu'}
                      </small>
                    </td>
                    <td>{item.accepted}</td>
                    <td>{item.restocked}</td>
                    <td>
                      {item.replacement?.sku ?? item.sku}
                      <small>{item.replacement?.name ?? item.name}</small>
                      <small>
                        {item.accepted} szt. · 0,00 {order.currency}
                      </small>
                      <small>
                        Rezerwowany zakres jednej sztuki:{' '}
                        {(item.replacement?.components ?? item.components)
                          .map(
                            (component) =>
                              `${review.preview.stock.find((position) => position.product_id === component.product_id)?.sku ?? component.product_id} × ${component.quantity}`,
                          )
                          .join(', ') || 'Brak udokumentowanego zakresu'}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4>
            Magazyn realizacji zamiennika ·{' '}
            {warehouses.find((choice) => choice.id === review.preview.warehouse_id)?.name ?? '—'}
          </h4>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Produkt fizyczny</th>
                  <th>Stan przed</th>
                  <th>Rezerwacje przed</th>
                  <th>Dostępne przed</th>
                  <th>Przywrócenie</th>
                  <th>Nowa rezerwacja</th>
                  <th>Stan po</th>
                  <th>Rezerwacje po</th>
                  <th>Dostępne po</th>
                </tr>
              </thead>
              <tbody>
                {review.preview.stock.map((item) => (
                  <tr key={item.product_id}>
                    <td>{item.sku}</td>
                    <td>{item.on_hand}</td>
                    <td>{item.reserved}</td>
                    <td>{item.available}</td>
                    <td>{item.return_quantity}</td>
                    <td>{item.replacement_quantity}</td>
                    <td>{item.after_on_hand}</td>
                    <td>{item.after_reserved}</td>
                    <td>{item.after_available}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {review.preview.warehouse_id !== r.warehouse_id &&
            review.preview.rows.some((row) => row.restocked > 0) &&
            (returnStockComplete ? (
              <>
                <h4>
                  Magazyn przyjęcia reklamacji ·{' '}
                  {warehouses.find((choice) => choice.id === r.warehouse_id)?.name ?? '—'}
                </h4>
                <p>
                  Towar wraca do magazynu zgłoszenia. W tym magazynie nie powstaje rezerwacja
                  zamiennika; realizacja korzysta z magazynu wskazanego powyżej.
                </p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Produkt fizyczny</th>
                        <th>Stan przed</th>
                        <th>Rezerwacje przed</th>
                        <th>Dostępne przed</th>
                        <th>Przywrócenie</th>
                        <th>Nowa rezerwacja</th>
                        <th>Stan po</th>
                        <th>Rezerwacje po</th>
                        <th>Dostępne po</th>
                      </tr>
                    </thead>
                    <tbody>
                      {review.preview
                        .return_stock!.filter((item) => item.return_quantity > 0)
                        .map((item) => (
                          <tr key={item.product_id}>
                            <td>{item.sku}</td>
                            <td>{item.on_hand}</td>
                            <td>{item.reserved}</td>
                            <td>{item.available}</td>
                            <td>{item.return_quantity}</td>
                            <td>{item.replacement_quantity}</td>
                            <td>{item.after_on_hand}</td>
                            <td>{item.after_reserved}</td>
                            <td>{item.after_available}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <p className="error-block" role="alert">
                Brakuje pełnego podglądu stanu magazynu przyjęcia reklamacji. Zatwierdzenie jest
                wstrzymane. Odczytaj sprawę i przygotuj podgląd ponownie po udostępnieniu pełnego
                zakresu przez serwer.
              </p>
            ))}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={freshDisabled || !returnStockComplete}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Potwierdzam cały pokazany zakres przyjęcia i bezpłatnej wymiany oraz rezerwację
            zamienników.
          </label>
          <button
            type="button"
            className="button primary"
            disabled={freshDisabled || !returnStockComplete || !confirmed}
            onClick={() => execute()}
          >
            Zatwierdź wymianę i utwórz realizację
          </button>
        </div>
      )}
    </section>
  );
}
