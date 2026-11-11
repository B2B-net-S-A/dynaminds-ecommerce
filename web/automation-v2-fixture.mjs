// Fixture AutomationCatalog for editor tests (shape of shared/automation-v2.ts; the server owns the real lists).
const statusOptions = [
  { group: 'Nowe', value: 'paid', label: 'Nowe' },
  { group: 'Nowe', value: 'new', label: 'Nieopłacone' },
  { group: 'W realizacji', value: 'picking', label: 'W kompletacji' },
  { group: 'W realizacji', value: 'packed', label: 'Spakowane' },
  { group: 'W realizacji', value: 'wf:paczkomat', label: 'W realizacji paczkomat' },
  { group: 'Zakończone', value: 'shipped', label: 'Nadane' },
  { group: 'Zakończone', value: 'cancelled', label: 'Anulowane' },
];
export const catalog = {
  groups: ['Wysyłka', 'Płatności'],
  operators: {
    list: ['in', 'not_in'],
    text: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'empty', 'not_empty'],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
    date: ['newer_than', 'older_than', 'between', 'within_last', 'weekday_in', 'hour_between'],
    bool: ['is_true', 'is_false'],
  },
  fields: [
    { key: 'order.status', group: 'Zamówienie', label: 'Status zamówienia', type: 'list', options: statusOptions },
    { key: 'order.total', group: 'Zamówienie', label: 'Wartość zamówienia', type: 'number' },
    { key: 'order.line_count', group: 'Zamówienie', label: 'Liczba pozycji', type: 'number' },
    { key: 'order.created_at', group: 'Zamówienie', label: 'Data złożenia', type: 'date' },
    {
      key: 'source.channel',
      group: 'Źródło',
      label: 'Kanał sprzedaży',
      type: 'list',
      options: [
        { value: 'allegro', label: 'Allegro' },
        { value: 'shop', label: 'Sklep' },
      ],
    },
    {
      key: 'shipping.method',
      group: 'Wysyłka',
      label: 'Metoda dostawy',
      type: 'list',
      options: [
        { value: 'inpost', label: 'InPost Paczkomat' },
        { value: 'dpd', label: 'Kurier DPD' },
      ],
    },
    { key: 'customer.email', group: 'Klient', label: 'E-mail klienta', type: 'text' },
    { key: 'customer.has_phone', group: 'Klient', label: 'Klient ma telefon', type: 'bool' },
    { key: 'product.sku', group: 'Produkty', label: 'SKU produktu', type: 'text', per_line: true },
    { key: 'ghost.field', group: 'Inne', label: 'Pole w przygotowaniu', type: 'text', supported: false, hint: 'Silnik jeszcze nie obsługuje' },
  ],
  effects: [
    { type: 'add_tag', group: 'Status i organizacja', label: 'Dodaj tag', params: [{ key: 'tag', label: 'Tag', kind: 'text', required: true }] },
    {
      type: 'set_status',
      group: 'Status i organizacja',
      label: 'Zmień status',
      params: [{ key: 'status', label: 'Status', kind: 'select', required: true, options: statusOptions.map(({ value, label }) => ({ value, label })) }],
    },
    {
      type: 'email',
      group: 'Komunikacja',
      label: 'Wyślij e-mail',
      params: [
        { key: 'template', label: 'Szablon', kind: 'select', required: true, options: [{ value: 't1', label: 'Wysłano paczkę' }] },
        { key: 'attach_invoice', label: 'Dołącz fakturę', kind: 'bool' },
      ],
    },
    { type: 'set_payment', group: 'Status i organizacja', label: 'Ustaw płatność', params: [{ key: 'amount', label: 'Kwota', kind: 'money', required: true }] },
  ],
  triggers: [
    { key: 'order.matches', group: 'Zamówienie', label: 'Gdy zamówienie spełni warunki' },
    { key: 'order.created', group: 'Zamówienie', label: 'Nowe zamówienie' },
    { key: 'shipment.created', group: 'Wysyłka', label: 'Utworzenie przesyłki' },
  ],
};
