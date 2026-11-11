// Batch result tools for the email and SMS panels: CSV export of per-recipient results and
// re-selection of the orders whose message never left (invalid or failed before an attempt).
type Item = { order_id: string; number: string; state: string; error?: string | null; recipient?: string | null; payload?: any };

// Only states with no provider attempt can be prepared again; "uncertain" may have been sent.
export const retryableStates = new Set(['invalid', 'failed']);
const cell = (v: unknown) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
  return '"' + s.replace(/"/g, '""') + '"';
};
export function batchResultsCsv(items: Item[], names: Record<string, string>, kind: 'email' | 'sms') {
  const rows = [['Zamówienie', 'Odbiorca', kind === 'email' ? 'Temat' : 'Treść', 'Wynik', 'Błąd']];
  for (const m of items)
    rows.push([
      m.number,
      kind === 'email' ? (m.payload?.recipient ?? '') : (m.recipient ?? ''), // E.164 digits; a leading + would trip the formula guard
      kind === 'email' ? (m.payload?.subject ?? '') : (m.payload ?? ''),
      names[m.state] ?? m.state,
      m.error ?? '',
    ]);
  return '\ufeff' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function BatchResultTools({
  batch,
  names,
  kind,
  busy,
  onRetry,
}: {
  batch: { id: string; items: Item[] };
  names: Record<string, string>;
  kind: 'email' | 'sms';
  busy: boolean;
  onRetry?: (orders: Record<string, { id: string; number: string }>) => void;
}) {
  const retry = batch.items.filter((m) => retryableStates.has(m.state));
  return (
    <div className="ops-actions">
      <button
        type="button"
        className="button"
        onClick={() => download(kind + '-partia-' + batch.id.slice(0, 8) + '.csv', batchResultsCsv(batch.items, names, kind))}
      >
        Pobierz wyniki CSV
      </button>
      {onRetry && retry.length > 0 && (
        <button
          type="button"
          className="button"
          disabled={busy}
          title="Wybiera zamówienia z wiadomościami niepoprawnymi lub zatrzymanymi przed wysyłką. Wyniki niepewne nie są ponawiane."
          onClick={() => onRetry(Object.fromEntries(retry.map((m) => [m.order_id, { id: m.order_id, number: m.number }])))}
        >
          Wybierz ponownie nieudane ({retry.length})
        </button>
      )}
    </div>
  );
}
