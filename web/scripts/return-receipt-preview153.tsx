import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReturnsPanel } from '../returns';
import { setWorkspace } from '../api';
import { resetDropshipReturnContext } from '../b2b-dropshipping-returns';
import '../styles.css';

// Deliberately isolated visual sample: no original actor, cookie, DB or provider data.
// All component HTTP is intercepted. No request is forwarded to a native server.
const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1530-4153-8153-153153153153`;
const tenant = id(1), user = id(2), warehouse = id(3), orderId = id(4), returnId = id(5);
const productA = id(6), productB = id(7), bundle = id(8), itemCheap = id(9), itemExpensive = id(10), itemBundle = id(11);
const fragmentA = id(12), fragmentB = id(13), dispatch = id(14), shipment = id(15);
const context = `${tenant}:${user}:admin:false`;
const flags = { available: true, read_only: false, current_role: 'admin', can_read: true, can_write: true, can_manage: true, can_admin: true, can_read_value: true };
const item = (item_id: string, product_id: string, sku: string, name: string, quantity: number, line_total: number, components: {product_id: string; quantity: number}[]) => ({
  id: item_id, item_id, product_id, sku, name, quantity, line_total, price: Math.floor(line_total / quantity), vat: 23,
  requested: 1, accepted: 0, restocked: 0, refund_amount: 0, components,
});
const lines = [
  item(itemCheap, productA, 'QA153-ON-A-VISUAL', 'QA153 ON Component A', 1, 1000, [{product_id: productA, quantity: 1}]),
  item(itemExpensive, productA, 'QA153-ON-A-VISUAL', 'QA153 ON Component A', 2, 3400, [{product_id: productA, quantity: 1}]),
  item(itemBundle, bundle, 'QA153-ON-BUNDLE-VISUAL', 'QA153 Frozen A1 B2 Bundle', 3, 7500, [{product_id: productA, quantity: 1}, {product_id: productB, quantity: 2}]),
];
const origins = lines.map((line, index) => ({
  origin_id: id(20 + index), item_id: line.item_id, dispatch_id: dispatch, parcel_index: 0, shipment_id: shipment,
  quantity: 1, requested: 1, available: 1, components: line.components,
  fragments: line.components.map(component => ({fragment_id: component.product_id === productA ? fragmentA : fragmentB, product_id: component.product_id, quantity: component.quantity, available: component.quantity})),
}));
const r = { id: returnId, number: 'VISUAL-153-RMA', version: 1, kind: 'return', state: 'requested', warehouse_id: warehouse,
  created_at: '2026-10-06T10:00:00Z', reason: 'Próbka wizualna formularza — nie jest natywnym zgłoszeniem.',
  requested_shipping: 0, legacy: false, exchange: null, can_exchange: false, documents: [], items: lines,
  parcel_origins_required: true, parcel_origins: origins,
};
const order = { id: orderId, number: 'VISUAL-153-ORDER', version: 1, status: 'packed', currency: 'PLN', warehouse_id: warehouse,
  wms_lots_enabled: true, items: lines, documents: [], returns: {items: lines.map(line => ({...line, returned: 0, available: 0})), cases: [r], refund_total: 0, settled_total: 0, shipping_available: 0, meta: {cursor: null}, parcel_origins_required: true, parcel_origins: origins},
};
const fragments = [
  {id: fragmentA, product_id: productA, lot_id: id(30), lot_code: 'QA153-0-VISUAL', layer_id: id(31), quantity: 3, returned_quantity: 0, remaining: 3, unit_cost_minor: '0', value_minor: '0', currency: 'PLN', location: 'QA153-01'},
  {id: fragmentB, product_id: productB, lot_id: id(32), lot_code: 'QA153-1-VISUAL', layer_id: id(33), quantity: 2, returned_quantity: 0, remaining: 2, unit_cost_minor: '1000', value_minor: '2000', currency: 'PLN', location: 'QA153-01'},
];

window.fetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : null;
  const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') throw Error('SIMULATED_COMPONENT_VISUAL: każdy zapis jest zablokowany; nie wysłano żądania do serwera.');
  const url = new URL(request?.url ?? String(input), window.location.origin);
  if (url.origin !== window.location.origin) throw Error('Próbka wizualna blokuje połączenia zewnętrzne.');
  const json = (data: unknown) => Response.json(data);
  if (url.pathname === `/api/b2b/dropshipping-returns/returns/${returnId}/context`) return json({...flags, can_preview: false, can_submit: false,
    context: {side: null, fulfillment_origin: 'ordinary', can_receive_locally: true, local_origin: null, retail_items: [], case_refs: []}});
  if (url.pathname === '/api/wms-lots') return json({...flags, can_return: true, can_receive: true, can_issue: true, can_adjust: true, can_transfer: true, can_activate: false,
    policy: {enabled: true, version: '1', method: 'FIFO', currency: 'PLN', exponent: 2}, warehouses: [{id: warehouse, name: 'MAIN — wizualny', code: 'MAIN'}], limits: {}});
  if (url.pathname === `/api/wms-lots/orders/${orderId}/return-fragments` && !url.search) return json({...flags, data: fragments, meta: {cursor: null}});
  if (url.pathname === '/api/inventory/snapshot' && url.searchParams.get('warehouse_id') === warehouse) {
    const ids = (url.searchParams.get('product_ids') ?? '').split(',');
    if (!ids.length || ids.some(product => ![productA, productB].includes(product))) throw Error('Próbka dopuszcza wyłącznie własne dwa produkty wizualne.');
    return json({...flags, data: ids.map(product_id => ({product_id, version: '1'}))});
  }
  throw Error('SIMULATED_COMPONENT_VISUAL: nieobsługiwany odczyt; nie wysłano żądania do serwera.');
};
setWorkspace(tenant);
resetDropshipReturnContext(context, false);
createRoot(document.getElementById('visual-root')!).render(
  <React.StrictMode>
    <aside className="sidebar"><div className="visual-fixture-side"><strong>Próbka UI 153</strong><p>SIMULATED_COMPONENT_VISUAL</p><p>Dane syntetyczne.<br/>Brak zapisów i połączeń z API.</p></div></aside>
    <div className="main-shell"><main>
      <div className="visual-fixture-note" role="note"><strong>SIMULATED_COMPONENT_VISUAL — nie jest odbiorem biznesowym</strong><p>Otwórz „Rozpatrz i przyjmij”, następnie „Wczytaj wszystkie fragmenty i wersje stanów zwrotu”. Przykład ma dwa wiersze tego samego SKU o różnych kwotach oraz bundle. Można edytować pola lokalnie; każdy POST jest blokowany. Odczyty są syntetyczne, bez serwera, danych istniejących firm ani przyjęcia magazynowego.</p></div>
      <ReturnsPanel order={order} write={true} contextKey={context} readOnly={false} onChanged={() => {throw Error('Próbka wizualna nie może potwierdzić zapisu.');}} />
    </main></div>
  </React.StrictMode>,
);
