// Mirrors server/message-variables.ts (rowVariables + orderVariables); the server validates.
export const messageVariables: { key: string; label: string }[] = [
  { key: 'order_number', label: 'numer zamówienia' },
  { key: 'customer_name', label: 'kupujący' },
  { key: 'total', label: 'wartość' },
  { key: 'currency', label: 'waluta' },
  { key: 'status', label: 'status' },
  { key: 'source', label: 'źródło' },
  { key: 'tracking_number', label: 'numer przesyłki' },
  { key: 'portal_link', label: 'link do strony zamówienia' },
  { key: 'products', label: 'produkty i ilości' },
  { key: 'delivery_address', label: 'adres dostawy' },
  { key: 'delivery_method', label: 'sposób dostawy' },
  { key: 'invoice_number', label: 'numer faktury' },
];
export const usesPortalLink = (t: { subject?: string; body?: string; html?: string }) =>
  [t.subject, t.body, t.html].some((v) => (v ?? '').includes('{{portal_link}}'));
