import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Amazon } from './amazon';
import { ensure, Problem } from './errors';
import { imageUrl } from './domain';
export const AMAZON_REPORT = 'GET_MERCHANT_LISTINGS_ALL_DATA';
export const AMAZON_LISTING_DATA =
  'summaries,attributes,offers,fulfillmentAvailability,relationships,productTypes';
const remoteId = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
export const amazonSku = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const unzip = promisify(gunzip);
const canonical = (v: any): any =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const amazonCatalogHash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');

export async function createAmazonCatalogReport(client: Amazon, fence: () => Promise<void>) {
  ensure(
    client.settings.selling_partner_id,
    422,
    'Import katalogu Amazon wymaga identyfikatora sprzedawcy',
  );
  const r = await client.read('/reports/2021-06-30/reports', {}, fence, {
    reportType: AMAZON_REPORT,
    marketplaceIds: [client.settings.marketplace_id],
    reportOptions: { preferredReportDocumentLocale: 'en_US', custom: 'false' },
  });
  return remoteId.parse(r.reportId);
}
export async function amazonCatalogReport(client: Amazon, id: string, fence: () => Promise<void>) {
  remoteId.parse(id);
  const r = await client.read('/reports/2021-06-30/reports/' + id, {}, fence);
  ensure(
    r.reportId === id &&
      r.reportType === AMAZON_REPORT &&
      Array.isArray(r.marketplaceIds) &&
      r.marketplaceIds.length === 1 &&
      r.marketplaceIds[0] === client.settings.marketplace_id,
    409,
    'Raport Amazon pochodzi z innego rynku lub typu',
  );
  ensure(
    ['IN_QUEUE', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FATAL'].includes(r.processingStatus),
    502,
    'Nieprawidłowy status raportu Amazon',
  );
  ensure(
    !['CANCELLED', 'FATAL'].includes(r.processingStatus),
    422,
    'Amazon nie wygenerował raportu katalogu: ' + r.processingStatus,
  );
  return r.processingStatus === 'DONE' ? remoteId.parse(r.reportDocumentId) : null;
}

// Signed URLs are used only in memory, without an access token, cookies or redirects.
export function amazonDocumentUrl(value: unknown) {
  ensure(typeof value === 'string' && value.length <= 16000, 502, 'Brak adresu raportu Amazon');
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Problem(502, 'Nieprawidłowy adres raportu Amazon');
  }
  ensure(
    u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.hash &&
      (!u.port || u.port === '443') &&
      (/^(?:[a-z0-9-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(u.hostname) ||
        /^[a-z0-9-]+\.cloudfront\.net$/.test(u.hostname)),
    502,
    'Nieprawidłowa domena raportu Amazon',
  );
  return u.toString();
}
async function boundedBody(r: Response, max: number) {
  ensure(
    r.body && (!r.headers.has('content-length') || Number(r.headers.get('content-length')) <= max),
    422,
    'Raport Amazon przekracza limit pobierania',
  );
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = r.body.getReader();
  try {
    for (;;) {
      const p = await reader.read();
      if (p.done) break;
      size += p.value.length;
      ensure(size <= max, 422, 'Raport Amazon przekracza limit pobierania');
      parts.push(p.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(parts, size);
}
export async function downloadAmazonCatalog(
  client: Amazon,
  documentId: string,
  fence: () => Promise<void>,
) {
  remoteId.parse(documentId);
  const doc = await client.read('/reports/2021-06-30/documents/' + documentId, {}, fence);
  ensure(
    doc.reportDocumentId === documentId &&
      (!doc.compressionAlgorithm || doc.compressionAlgorithm === 'GZIP'),
    502,
    'Nieprawidłowy dokument raportu Amazon',
  );
  const url = amazonDocumentUrl(doc.url);
  await fence();
  const r = await client.documentTransport(url, {
    method: 'GET',
    redirect: 'error',
    headers: { Accept: 'text/plain,application/octet-stream' },
  });
  ensure(r.ok, 502, `Pobieranie raportu Amazon: HTTP ${r.status}`);
  let bytes = await boundedBody(r, 64 * 1024 * 1024);
  if (doc.compressionAlgorithm === 'GZIP') {
    try {
      bytes = await unzip(bytes, { maxOutputLength: 256 * 1024 * 1024 });
    } catch {
      throw new Problem(422, 'Nieprawidłowa kompresja lub zbyt duży raport Amazon');
    }
  }
  const charset =
    /charset\s*=\s*"?([^;"\s]+)/i.exec(r.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    throw new Problem(422, 'Nieobsługiwane lub nieprawidłowe kodowanie raportu Amazon');
  }
  // Discard descriptions, prices and quantities from the report. Listings supplies current data.
  return parseAmazonCatalogSkus(text);
}

export function parseAmazonCatalogSkus(text: string) {
  ensure(text.length <= 256 * 1024 * 1024, 422, 'Raport Amazon przekracza 256 MiB');
  text = text.replace(/^\uFEFF/, '');
  let fields: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    width = 0,
    skuIndex = -1,
    header = true;
  const skus = new Set<string>();
  const row = () => {
    fields.push(field);
    field = '';
    closed = false;
    if (fields.every((v) => !v)) {
      fields = [];
      return;
    }
    if (header) {
      const names = fields.map((v) => v.trim());
      ensure(
        names.filter((v) => v === 'seller-sku').length === 1,
        422,
        'Raport Amazon wymaga angielskiego nagłówka seller-sku; raport z pamięci dostawcy może mieć inny język',
      );
      width = fields.length;
      skuIndex = names.indexOf('seller-sku');
      header = false;
    } else {
      ensure(fields.length === width, 422, 'Niepełny wiersz raportu Amazon');
      const sku = amazonSku.parse(fields[skuIndex]);
      ensure(!skus.has(sku), 409, 'Powtórzone SKU w raporcie Amazon');
      skus.add(sku);
      ensure(skus.size <= 1000000, 422, 'Raport Amazon przekracza milion SKU');
    }
    fields = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += ch;
    } else if (ch === '"') {
      ensure(!field && !closed, 422, 'Nieprawidłowe pole raportu Amazon');
      quoted = true;
    } else if (ch === '\t') {
      fields.push(field);
      field = '';
      closed = false;
      ensure(fields.length <= 200, 422, 'Zbyt wiele kolumn raportu Amazon');
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row();
    } else {
      ensure(!closed, 422, 'Tekst po zamknięciu pola raportu Amazon');
      field += ch;
    }
    ensure(field.length <= 1000000, 422, 'Zbyt długie pole raportu Amazon');
  }
  ensure(!quoted, 422, 'Niezamknięte pole raportu Amazon');
  if (fields.length || field) row();
  ensure(!header, 422, 'Brak nagłówka raportu Amazon');
  return [...skus];
}

export async function readAmazonCatalogBatch(
  client: Amazon,
  skus: string[],
  fence: () => Promise<void>,
) {
  ensure(
    client.settings.selling_partner_id &&
      skus.length > 0 &&
      skus.length <= 20 &&
      new Set(skus).size === skus.length,
    422,
    'Nieprawidłowa partia SKU Amazon',
  );
  skus.forEach((s) => amazonSku.parse(s));
  if (skus.some((s) => s.includes(','))) {
    ensure(skus.length === 1, 422, 'SKU zawierające przecinek wymaga odczytu pojedynczej oferty');
    const item = await client.read(
      '/listings/2021-08-01/items/' +
        client.settings.selling_partner_id +
        '/' +
        encodeURIComponent(skus[0]),
      { marketplaceIds: client.settings.marketplace_id, includedData: AMAZON_LISTING_DATA },
      fence,
    );
    ensure(item.sku === skus[0], 409, 'Amazon zwrócił inne SKU');
    return [item];
  }
  const body = await client.read(
    '/listings/2021-08-01/items/' + client.settings.selling_partner_id,
    {
      marketplaceIds: client.settings.marketplace_id,
      includedData: AMAZON_LISTING_DATA,
      identifiersType: 'SKU',
      identifiers: skus.join(','),
      pageSize: '20',
    },
    fence,
  );
  ensure(
    Array.isArray(body.items) &&
      body.items.length === skus.length &&
      body.numberOfResults === skus.length &&
      !body.pagination?.nextToken,
    409,
    'Niepełna partia SKU Amazon; katalog zmienił się lub brakuje uprawnień',
  );
  const seen = new Set<string>();
  for (const item of body.items) {
    const sku = amazonSku.parse(item?.sku);
    ensure(skus.includes(sku) && !seen.has(sku), 409, 'Amazon zwrócił obce lub powtórzone SKU');
    seen.add(sku);
  }
  return body.items as any[];
}

const plain = (s: any) =>
  typeof s === 'string'
    ? s
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
export function normalizeAmazonCatalog(raw: any, run: any) {
  const id = amazonSku.parse(raw?.sku),
    market = run.context.marketplace_id;
  const summaries = (raw.summaries ?? []).filter((s: any) => s.marketplaceId === market);
  ensure(summaries.length === 1, 409, 'SKU Amazon nie ma jednoznacznych danych wybranego rynku');
  const summary = summaries[0],
    issues: string[] = [];
  const relationships = (raw.relationships ?? [])
    .filter((s: any) => s.marketplaceId === market)
    .flatMap((s: any) => s.relationships ?? []);
  const parents: string[] = [
    ...new Set<string>(
      relationships
        .filter((r: any) => r.type === 'VARIATION')
        .flatMap((r: any) => r.parentSkus ?? []),
    ),
  ].sort();
  const children: string[] = [
    ...new Set<string>(
      relationships
        .filter((r: any) => r.type === 'VARIATION')
        .flatMap((r: any) => r.childSkus ?? []),
    ),
  ].sort();
  [...parents, ...children].forEach((s) => amazonSku.parse(s));
  ensure(
    !parents.includes(id) &&
      !children.includes(id) &&
      parents.length <= 1 &&
      !(parents.length && children.length),
    409,
    'Nieprawidłowa rodzina wariantów Amazon',
  );
  const unsupported = relationships.some((r: any) => r.type !== 'VARIATION');
  if (unsupported) issues.push('Hierarchia opakowań Amazon wymaga osobnej konfiguracji zestawów');
  const kind = unsupported
    ? 'unsupported'
    : children.length
      ? 'group'
      : parents.length
        ? 'variant'
        : 'simple';
  const offers = (raw.offers ?? []).filter(
    (o: any) =>
      o.marketplaceId === market &&
      o.offerType === 'B2C' &&
      (!o.audience || o.audience.value === 'ALL'),
  );
  let currency: string | null =
      offers.length === 1 ? (offers[0].price?.currencyCode ?? null) : null,
    price: number | null = null;
  if (kind === 'group') price = 0;
  else if (
    offers.length === 1 &&
    typeof offers[0].price?.amount === 'string' &&
    /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(offers[0].price.amount) &&
    ['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(currency ?? '')
  ) {
    const [whole, fraction = ''] = offers[0].price.amount.split('.');
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    if (minor <= 100000000n) price = Number(minor);
  }
  if (price === null)
    issues.push('Brak jednoznacznej ceny B2C w obsługiwanej walucie; podaj cenę lokalną');
  const availability = Array.isArray(raw.fulfillmentAvailability)
    ? raw.fulfillmentAvailability
    : [];
  const merchant = availability.filter((a: any) => a.fulfillmentChannelCode === 'DEFAULT');
  const quantity =
    kind === 'group'
      ? 0
      : merchant.length === 1 &&
          Number.isInteger(merchant[0].quantity) &&
          merchant[0].quantity >= 0 &&
          merchant[0].quantity <= 10000000
        ? merchant[0].quantity
        : null;
  if (quantity === null && kind !== 'group')
    issues.push('Brak dostępności FBM; stany FBA pozostają osobną informacją');
  const values = (key: string) =>
    Array.isArray(raw.attributes?.[key])
      ? raw.attributes[key].filter((v: any) => !v.marketplace_id || v.marketplace_id === market)
      : [];
  const scalar = (key: string) =>
    values(key)
      .map((v: any) => plain(v.value))
      .filter(Boolean)
      .join(', ');
  const attributes: Record<string, string> = Object.create(null);
  for (const key of Object.keys(raw.attributes ?? {})
    .sort()
    .slice(0, 50)) {
    const v = scalar(key);
    if (v) attributes[key.slice(0, 80)] = v.slice(0, 500);
  }
  const link = summary.mainImage?.link;
  const images =
    link && imageUrl.safeParse(link).success && link.startsWith('https://') ? [link] : [];
  const source = {
    external_id: id,
    parent_external_id: parents[0] ?? null,
    kind,
    unsupported,
    sku: id.trim(),
    source_sku: id,
    name: (plain(summary.itemName) || scalar('item_name') || `Amazon ${id}`).slice(0, 200),
    description: scalar('product_description').slice(0, 10000),
    ean:
      values('externally_assigned_product_identifier').find((v: any) => v.type === 'ean')?.value ??
      '',
    category: 'Amazon',
    attributes,
    images,
    price,
    vat: run.vat,
    currency,
    quantity,
    active: (summary.status ?? []).some((v: string) => ['BUYABLE', 'DISCOVERABLE'].includes(v)),
    source_status: (summary.status ?? []).join(', '),
    amazon: {
      attributes: raw.attributes ?? {},
      relationships,
      asin: summary.asin ?? null,
      product_type: summary.productType ?? null,
      condition: summary.conditionType ?? null,
      children,
      parents,
      availability,
      offers: raw.offers ?? [],
      marketplace_id: market,
      seller_id: run.context.selling_partner_id,
      stock_scope: 'external_availability',
      price_scope: 'current_B2C',
    },
  };
  if (source.sku.length > 80) issues.push('SKU przekracza 80 znaków; podaj krótszy symbol lokalny');
  ensure(
    typeof source.ean === 'string' && source.ean.length <= 32,
    422,
    'Nieprawidłowy EAN Amazon',
  );
  return {
    external_id: id,
    parent_external_id: parents[0] ?? null,
    kind,
    source,
    source_hash: amazonCatalogHash(source),
    issues,
  };
}
