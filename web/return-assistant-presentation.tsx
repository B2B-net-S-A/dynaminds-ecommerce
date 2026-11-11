import { useState } from 'react';
import { date } from './api';
import type { ReturnAssistantViewSettings } from './return-assistant-queues';
import './return-assistant-queues.css';

export type ReturnAssistantPresentationLine = { item_id: string; product_id: string; ordinal: number; sku: string; name: string; requested: number; original_quantity: number; line_total?: number; components: { product_id: string; quantity: number }[] };
export type ReturnAssistantPresentationData = {
  return_id: string; read_at: string;
  case: { number: string; order_number: string; created_at: string; kind: string; customer: string | null; commercial_value: number | null; currency: string };
  lines: { item_id: string; product_id: string; ordinal: number; historical_name: string; sku: string; requested: number; original_quantity: number; line_total?: number; components: { product_id: string; quantity: number }[]; current_catalog: { name: string; sku: string; ean: string | null; image_url: string | null } | null; locations: { product_id: string; warehouse_id: string; location: string; quantity: number }[]; stock: { product_id: string; warehouse_id: string; on_hand: number; reserved: number; available: number; version: string }[] }[];
};
const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
function checked(p: ReturnAssistantPresentationData | null | undefined, returnId: string, lines: ReturnAssistantPresentationLine[]) {
  if (!p || p.return_id !== returnId || !uuid(returnId) || !Number.isFinite(Date.parse(p.read_at)) || !p.case || !Array.isArray(p.lines) || p.lines.length !== lines.length || p.lines.length > 100 || new Set(p.lines.map(l => l.item_id)).size !== p.lines.length || new Set(lines.map(l => l.item_id)).size !== lines.length) return null;
  if ([p.case.number, p.case.order_number, p.case.kind, p.case.currency].some(v => typeof v !== 'string') || !Number.isFinite(Date.parse(p.case.created_at)) || (p.case.customer !== null && typeof p.case.customer !== 'string') || (p.case.commercial_value !== null && (!Number.isSafeInteger(p.case.commercial_value) || p.case.commercial_value < 0))) return null;
  for (const row of p.lines) {
    const original = lines.find(l => l.item_id === row.item_id);
    if (!original || row.product_id !== original.product_id || row.sku !== original.sku || row.historical_name !== original.name || row.requested !== original.requested || row.original_quantity !== original.original_quantity || row.line_total !== original.line_total || !Array.isArray(row.components) || !Array.isArray(original.components)) return null;
    const recipe = (v: { product_id: string; quantity: number }[]) => v.map(c => c.product_id + ':' + c.quantity).sort().join('|');
    if (recipe(row.components) !== recipe(original.components) || !Array.isArray(row.locations) || !Array.isArray(row.stock) || row.locations.length > 500 || row.stock.length > 500) return null;
    const componentIds = new Set(original.components.map(c => c.product_id));
    if (row.locations.some(l => !componentIds.has(l.product_id) || !uuid(l.warehouse_id) || typeof l.location !== 'string' || !Number.isSafeInteger(l.quantity) || l.quantity < 0) || row.stock.some(s => !componentIds.has(s.product_id) || !uuid(s.warehouse_id) || [s.on_hand, s.reserved, s.available].some(q => !Number.isSafeInteger(q) || q < 0))) return null;
    if (row.current_catalog && (typeof row.current_catalog.name !== 'string' || typeof row.current_catalog.sku !== 'string' || (row.current_catalog.ean !== null && typeof row.current_catalog.ean !== 'string') || (row.current_catalog.image_url !== null && typeof row.current_catalog.image_url !== 'string'))) return null;
  }
  return p;
}
export function sortedReturnAssistantLines<T extends ReturnAssistantPresentationLine>(lines: T[], presentation: ReturnAssistantPresentationData | null | undefined, settings?: ReturnAssistantViewSettings | null): T[] {
  const p = presentation ? checked(presentation, presentation.return_id, lines) : null;
  // Never change immutable ordinals or item IDs; only reorder the visible array.
  if (!settings || settings.product_sort === 'historical') return [...lines].sort((a, b) => a.ordinal - b.ordinal);
  const name = (line: T) => settings.name_source === 'current' ? p?.lines.find(l => l.item_id === line.item_id)?.current_catalog?.name ?? line.name : line.name;
  return [...lines].sort((a, b) => (settings.product_sort === 'sku' ? a.sku.localeCompare(b.sku, 'pl') : name(a).localeCompare(name(b), 'pl')) || a.ordinal - b.ordinal || a.item_id.localeCompare(b.item_id));
}
function amount(value: number | null | undefined, currency: string) {
  if (value == null || !Number.isSafeInteger(value) || value < 0) return 'Brak danych';
  const n = BigInt(value); return `${n / 100n},${String(n % 100n).padStart(2, '0')} ${currency}`;
}
function Thumbnail({ url, size }: { url: string | null; size: 'small' | 'large' }) {
  const [failed, setFailed] = useState(false);
  let safe = !!url && url.startsWith('/api/product-images/') && uuid(url.slice('/api/product-images/'.length));
  try { if (url && !safe) { const u = new URL(url); safe = ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } } catch { /* Invalid catalog image is never requested. */ }
  return safe && !failed ? <img className={'raq-thumbnail ' + size} src={url!} alt="Pomocnicza miniaturka z aktualnego katalogu" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/> : <small>Miniaturka niedostępna</small>;
}
function PhysicalDetails({ row, locations, stock }: { row: ReturnAssistantPresentationData['lines'][number]; locations: boolean; stock: boolean }) {
  const [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(row.locations.length / 50));
  return <>
    {locations && <details><summary>Lokalizacje składników ({row.locations.length})</summary>{!row.locations.length && <p>Brak zapisanych lokalizacji.</p>}<ul>{row.locations.slice(page * 50, (page + 1) * 50).map((l, i) => <li key={l.product_id + ':' + l.warehouse_id + ':' + l.location + ':' + i}>{l.location} · {l.quantity} szt. · składnik {l.product_id}</li>)}</ul>{pages > 1 && <div className="raq-actions"><button type="button" className="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Poprzednie lokalizacje</button><span>{page + 1} / {pages}</span><button type="button" className="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Następne lokalizacje</button></div>}</details>}
    {stock && <div><h4>Aktualny stan składników w magazynie RMA</h4>{row.stock.length ? row.stock.map(s => <p key={s.product_id + ':' + s.warehouse_id}>Składnik {s.product_id}: stan {s.on_hand}, rezerwacja {s.reserved}, dostępne {s.available} szt.</p>) : <p>Brak zapisanej pozycji zapasu.</p>}</div>}
  </>;
}
export function ReturnAssistantPresentation({ presentation, settings, returnId, lines }: { presentation?: ReturnAssistantPresentationData | null; settings?: ReturnAssistantViewSettings | null; returnId: string; lines: ReturnAssistantPresentationLine[] }) {
  if (!settings || !presentation) return null;
  const p = checked(presentation, returnId, lines);
  if (!p) return <p className="notice" role="alert">Pomocnicze dane prezentacji nie odpowiadają tej sprawie. Zachowano historyczne pozycje i decyzje.</p>;
  const wantedCase = new Set(settings.case_fields), wantedProduct = new Set(settings.product_fields);
  const caseRows: [ReturnAssistantViewSettings['case_fields'][number], string, string][] = [
    ['number', 'Numer RMA', p.case.number], ['order_number', 'Numer zamówienia', p.case.order_number], ['created_at', 'Data zgłoszenia', date(p.case.created_at)], ['kind', 'Rodzaj sprawy', p.case.kind === 'complaint' ? 'Reklamacja' : 'Zwrot'], ['customer', 'Klient', p.case.customer ?? 'Brak danych'], ['commercial_value', 'Wartość zamówienia', amount(p.case.commercial_value, p.case.currency)],
  ];
  return <section className="return-assistant-presentation" aria-label="Wybrana prezentacja sprawy i produktów">
    <p>Pomocnicze dane katalogu i stanów z odczytu {date(p.read_at)}. Przyjęcie nadal używa historycznej receptury i osobnego podglądu.</p>
    {!!wantedCase.size && <dl className="raq-presentation-case">{caseRows.filter(([key]) => wantedCase.has(key)).map(([key, title, value]) => <div key={key}><dt>{title}</dt><dd>{value}</dd></div>)}</dl>}
    <div className="raq-presentation-lines">{sortedReturnAssistantLines(lines, p, settings).map(line => {
      const row = p.lines.find(l => l.item_id === line.item_id)!;
      return <article className="raq-card" key={line.item_id}><h3>Pozycja {line.ordinal} · {line.sku} — {line.name}</h3><p>Historycznie {line.original_quantity} szt. / {amount(line.line_total, p.case.currency)} za całą pozycję · zgłoszone {line.requested} szt.</p>
        {settings.name_source === 'current' && <p>Aktualna nazwa katalogu: {row.current_catalog?.name ?? 'Brak produktu w aktualnym katalogu'}</p>}
        {settings.thumbnail_size !== 'none' && <Thumbnail key={row.current_catalog?.image_url ?? 'missing'} url={row.current_catalog?.image_url ?? null} size={settings.thumbnail_size}/>}
        <dl>{wantedProduct.has('sku') && <div><dt>Historyczne SKU</dt><dd>{line.sku}</dd></div>}{wantedProduct.has('name') && <div><dt>Historyczna nazwa</dt><dd>{line.name}</dd></div>}{wantedProduct.has('quantity') && <div><dt>Ilość zgłoszona / oryginalna</dt><dd>{line.requested} / {line.original_quantity}</dd></div>}{wantedProduct.has('line_total') && <div><dt>Oryginalna kwota całej pozycji</dt><dd>{amount(line.line_total, p.case.currency)}</dd></div>}{wantedProduct.has('ean') && <div><dt>EAN aktualnego katalogu z chwili odczytu</dt><dd>{row.current_catalog?.ean ?? 'Brak danych'}</dd></div>}{wantedProduct.has('components') && <div><dt>Historyczna receptura na jedną sztukę</dt><dd>{line.components.map(c => <span key={c.product_id}>Składnik {c.product_id} × {c.quantity} </span>)}</dd></div>}</dl>
        <PhysicalDetails key={p.read_at + ':' + line.item_id} row={row} locations={wantedProduct.has('locations')} stock={wantedProduct.has('stock')}/>
      </article>;
    })}</div>
  </section>;
}
