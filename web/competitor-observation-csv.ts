/** Pure, atomic CSV admission. Product ownership, list currency, observation
 * freshness and pricing authority require the native service after parsing. */
export const COMPETITOR_OBSERVATION_COLUMNS = [
  'product_id', 'source_namespace', 'offer_id', 'seller_id', 'currency',
  'price_gross_minor', 'delivery_gross_minor', 'available', 'observed_at',
] as const;
export const COMPETITOR_OBSERVATION_LIMITS = { bytes: 1_000_000, rows: 1000 } as const;
export type CompetitorObservation = {
  product_id: string; source_namespace: string; offer_id: string; seller_id: string;
  currency: string; price_gross_minor: bigint; delivery_gross_minor: bigint;
  available: boolean;
  /** Canonical UTC with all six fractional digits; no microsecond loss. */
  observed_at: string;
};
export class CompetitorObservationCsvError extends Error {
  constructor(public readonly row: number, public readonly column: number,
    public readonly code: 'encoding'|'size'|'syntax'|'header'|'rows'|'value'|'duplicate') {
    super(`CSV: wiersz ${row}, kolumna ${column} (${code}).`);
    this.name = 'CompetitorObservationCsvError';
  }
}
const fail = (row: number, column: number, code: CompetitorObservationCsvError['code']): never => {
  throw new CompetitorObservationCsvError(row, column, code);
};
function text(input: string | Uint8Array) {
  if (typeof input === 'string') {
    if (input.length > COMPETITOR_OBSERVATION_LIMITS.bytes) fail(1, 1, 'size');
    // Reject lone UTF-16 surrogates rather than silently encode replacement bytes.
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = input.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail(1, 1, 'encoding');
      } else if (c >= 0xdc00 && c <= 0xdfff) fail(1, 1, 'encoding');
    }
    if (new TextEncoder().encode(input).length > COMPETITOR_OBSERVATION_LIMITS.bytes) fail(1, 1, 'size');
    return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  }
  if (!(input instanceof Uint8Array)) fail(1, 1, 'encoding');
  if (input.byteLength > COMPETITOR_OBSERVATION_LIMITS.bytes) fail(1, 1, 'size');
  try {
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  } catch { return fail(1, 1, 'encoding'); }
}
function records(csv: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [], field = '', state: 'plain'|'quoted'|'closed' = 'plain';
  let line = 1, startLine = 1, started = false;
  const cell = () => { cells.push(field); field = ''; state = 'plain'; };
  const record = () => {
    cell(); rows.push({ line: startLine, cells }); cells = []; started = false;
    if (rows.length > COMPETITOR_OBSERVATION_LIMITS.rows + 1) fail(startLine, 1, 'rows');
  };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i], newline = c === '\r' || c === '\n';
    if (state === 'quoted') {
      if (c === '"') {
        if (csv[i + 1] === '"') { field += '"'; i++; } else state = 'closed';
      } else {
        field += c;
        if (newline) { if (c === '\r' && csv[i + 1] === '\n') { field += '\n'; i++; } line++; }
      }
      continue;
    }
    if (c === ',') { cell(); started = true; }
    else if (newline) {
      record(); if (c === '\r' && csv[i + 1] === '\n') i++;
      line++; startLine = line;
    } else if (c === '"') {
      if (state !== 'plain' || field.length) fail(line, cells.length + 1, 'syntax');
      state = 'quoted'; started = true;
    } else {
      if (state === 'closed') fail(line, cells.length + 1, 'syntax');
      field += c; started = true;
    }
  }
  if (state === 'quoted') fail(startLine, cells.length + 1, 'syntax');
  if (started || field.length || cells.length) record();
  return rows;
}
const identifier = (value: string, row: number, column: number) => {
  if (!value.length || value.length > 200 || value.trim() !== value || value.includes('\0')) fail(row, column, 'value');
  return value;
};
const amount = (value: string, row: number, column: number) => {
  if (!/^(?:0|[1-9]\d{0,8})$/.test(value)) fail(row, column, 'value');
  const n = BigInt(value);
  if (n > 100000000n) fail(row, column, 'value');
  return n;
};
function timestamp(value: string, row: number) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  if (!m) return fail(row, 9, 'value');
  const ms = Date.parse(m[1] + 'Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== m[1]) fail(row, 9, 'value');
  return m[1] + '.' + (m[2] ?? '').padEnd(6, '0') + 'Z';
}
export function parseCompetitorObservationCsv(input: string | Uint8Array): CompetitorObservation[] {
  const parsed = records(text(input)), header = parsed[0];
  if (!header || header.cells.length !== COMPETITOR_OBSERVATION_COLUMNS.length) fail(1, 1, 'header');
  for (let i = 0; i < COMPETITOR_OBSERVATION_COLUMNS.length; i++) {
    if (header.cells[i] !== COMPETITOR_OBSERVATION_COLUMNS[i]) fail(1, i + 1, 'header');
  }
  if (parsed.length < 2) fail(2, 1, 'rows');
  const observations: CompetitorObservation[] = [], seen = new Set<string>();
  for (const { line, cells } of parsed.slice(1)) {
    if (cells.length !== 9) fail(line, Math.min(cells.length + 1, 10), 'syntax');
    const [product, namespace, offer, seller, currency, price, delivery, available, observed] = cells;
    const value: CompetitorObservation = {
      product_id: identifier(product, line, 1), source_namespace: identifier(namespace, line, 2),
      offer_id: identifier(offer, line, 3), seller_id: identifier(seller, line, 4), currency,
      price_gross_minor: amount(price, line, 6), delivery_gross_minor: amount(delivery, line, 7),
      available: available === 'true', observed_at: timestamp(observed, line),
    };
    if (!/^[A-Z]{3}$/.test(currency)) fail(line, 5, 'value');
    if (!['true', 'false'].includes(available)) fail(line, 8, 'value');
    const key = JSON.stringify([value.source_namespace, value.offer_id, value.observed_at, value.product_id]);
    if (seen.has(key)) fail(line, 3, 'duplicate');
    seen.add(key); observations.push(value);
  }
  return observations;
}
