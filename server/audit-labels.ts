/** Polish names of audit actions and the before/after changes of an audit detail (SEC-009). Pure and
 * browser-safe: the audit log UI and the CSV export use the same text. Unknown actions stay readable as
 * "<area>: <rest>" or as the raw code; nothing is hidden. */
const ACTIONS: Readonly<Record<string, string>> = {
  'order.create': 'Utworzenie zamówienia',
  'order.status': 'Zmiana statusu zamówienia',
  'order.tags': 'Zmiana tagów zamówienia',
  'order.note': 'Notatka do zamówienia',
  'order.scan': 'Skan przy kompletacji',
  'order.workflow': 'Zmiana etapu zamówienia',
  'order.fields_changed': 'Zmiana pól dodatkowych zamówienia',
  'product.create': 'Utworzenie produktu',
  'product.update': 'Zmiana produktu',
  'product.delete': 'Usunięcie produktu',
  'product.image.upload': 'Dodanie zdjęcia produktu',
  'stock.adjust': 'Korekta stanu magazynowego',
  'warehouse.create': 'Utworzenie magazynu',
  'warehouse.document.create': 'Utworzenie dokumentu magazynowego',
  'warehouse.document.post': 'Zatwierdzenie dokumentu magazynowego',
  'warehouse.document.cancel': 'Anulowanie dokumentu magazynowego',
  'document.issue': 'Wystawienie dokumentu',
  'local_invoice.issue': 'Wystawienie faktury',
  'payment.receipt': 'Zapis wpłaty',
  'return.requested': 'Zgłoszenie zwrotu',
  'return.received': 'Przyjęcie zwrotu',
  'shipment.demo': 'Przesyłka demonstracyjna',
  'automation.create': 'Utworzenie automatyzacji',
  'automation.update': 'Zmiana automatyzacji',
  'automation.executed': 'Wykonanie automatyzacji',
  'api_key.created': 'Utworzenie klucza API',
  'api_key.revoked': 'Unieważnienie klucza API',
  'api_key.rotated': 'Rotacja klucza API',
  'workspace.created': 'Utworzenie organizacji',
  'workspace.updated': 'Zmiana ustawień organizacji',
  'workspace.invited': 'Zaproszenie do organizacji',
  'workspace.invitation_revoked': 'Cofnięcie zaproszenia',
  'workspace.plan_changed': 'Zmiana planu',
  'workspace.mfa_policy_changed': 'Zmiana polityki MFA',
  'audit.exported': 'Eksport dziennika audytu',
};
const AREAS: Readonly<Record<string, string>> = {
  order: 'Zamówienie', orders: 'Zamówienia', order_field: 'Pola zamówień', product: 'Produkt', product_catalog: 'Katalog produktów',
  catalog: 'Katalog', stock: 'Stan magazynowy', stocktake: 'Inwentaryzacja', warehouse: 'Magazyn', wms: 'WMS',
  payment: 'Płatność', shipping: 'Wysyłka', shipment: 'Przesyłka', tracking: 'Śledzenie przesyłek', return: 'Zwrot',
  return_reason: 'Powód zwrotu', return_destination_status: 'Status zwrotu', integration: 'Integracja', offer: 'Oferta',
  automation: 'Automatyzacja', workflow: 'Etapy zamówień', workspace: 'Organizacja', api_key: 'Klucz API', webhook: 'Webhook',
  outbound: 'Powiadomienie wychodzące', crm: 'CRM', customer: 'Klient', supplier: 'Dostawca', purchase: 'Zamówienie do dostawcy',
  replenishment: 'Uzupełnianie zapasów', pricing: 'Cennik', repricing: 'Repricing', print: 'Wydruk', packing: 'Pakowanie',
  picking_wave: 'Fala kompletacji', proforma: 'Proforma', local_invoice: 'Faktura', document: 'Dokument', receipt233: 'Paragon',
  sms: 'SMS', shopify: 'Shopify', translation: 'Tłumaczenia', tax: 'Podatki', audit: 'Dziennik audytu', account: 'Konto',
  buyer: 'Kupujący', b2b: 'B2B', local_woo: 'WooCommerce (lokalnie)',
};
const VERBS: Readonly<Record<string, string>> = {
  create: 'utworzenie', created: 'utworzenie', update: 'zmiana', updated: 'zmiana', changed: 'zmiana', edit: 'edycja',
  delete: 'usunięcie', preview: 'podgląd', previewed: 'podgląd', execute: 'wykonanie', executed: 'wykonanie',
  apply: 'zastosowanie', applied: 'zastosowanie', committed: 'zatwierdzenie', post: 'zatwierdzenie', approve: 'akceptacja',
  approved: 'akceptacja', queue: 'zlecenie', queued: 'zlecenie', enqueue: 'zlecenie', cancel: 'anulowanie',
  cancelled: 'anulowanie', configure: 'konfiguracja', issue: 'wystawienie', scan: 'skan', scanned: 'skan', start: 'rozpoczęcie',
  revoked: 'unieważnienie', rotated: 'rotacja', exported: 'eksport', received: 'przyjęcie', done: 'zakończenie',
  failed: 'błąd', retry: 'ponowienie', status: 'zmiana statusu', upload: 'przesłanie pliku', read: 'odczyt',
};
/** The Polish name of an audit action code. */
export function auditActionLabel(action: string): string {
  const exact = ACTIONS[action];
  if (exact) return exact;
  const dot = action.indexOf('.');
  const area = dot > 0 ? AREAS[action.slice(0, dot)] : undefined;
  if (!area) return action;
  const rest = action.slice(dot + 1), last = rest.lastIndexOf('.');
  if (VERBS[rest]) return area + ': ' + VERBS[rest];
  const verb = last > 0 ? VERBS[rest.slice(last + 1)] : undefined;
  return area + ': ' + (verb ? rest.slice(0, last) + ' — ' + verb : rest);
}
const text = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
};
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Before → after lines of a detail with {from,to} or {before,after}; [] when the detail holds no change. */
export function auditChanges(detail: unknown): string[] {
  if (!record(detail)) return [];
  if ('from' in detail || 'to' in detail) return [text(detail.from) + ' → ' + text(detail.to)];
  if (!('before' in detail) && !('after' in detail)) return [];
  const { before, after } = detail;
  if (!record(before) || !record(after)) return [text(before) + ' → ' + text(after)];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => k + ': ' + text(before[k]) + ' → ' + text(after[k]));
}
