import { z } from 'zod';
import { ensure, Problem } from './errors';
import type { Transport } from './integrations';

export const bigbuyId = z
  .union([z.string(), z.number().int().safe()])
  .transform(String)
  .pipe(z.string().regex(/^[1-9]\d{0,15}$/));
export const bigbuyToken = z
  .string()
  .trim()
  .min(1)
  .max(10000)
  .regex(/^[^\s\r\n]+$/);
export class BigBuyRetry extends Problem {
  constructor(
    public seconds: number,
    status = 429,
  ) {
    super(status, 'BigBuy: odczyt wymaga ponowienia po limicie lub awarii');
  }
}
export const bigbuyBulkResources = [
  'products',
  'productsinformation',
  'productsimages',
  'productsstockbyhandlingdays',
  'productsvariations',
  'productsvariationsstockbyhandlingdays',
] as const;
export type BigBuyBulkResource = (typeof bigbuyBulkResources)[number];
export class BigBuy {
  readonly base: string;
  constructor(
    mode: string,
    private credentials: Record<string, string>,
    private transport: Transport,
  ) {
    ensure(['live', 'sandbox'].includes(mode), 422, 'Nieprawidłowe środowisko BigBuy');
    this.base = mode === 'sandbox' ? 'https://api.sandbox.bigbuy.eu' : 'https://api.bigbuy.eu';
  }
  async read(resource: string, id?: string, language = 'pl') {
    ensure(
      [
        'taxonomies',
        'product',
        'productinformation',
        'productstockbyhandlingdays',
        'productimages',
        'productvariations',
        'productvariationsstockbyhandlingdays',
      ].includes(resource),
      422,
      'Nieobsługiwany odczyt BigBuy',
    );
    ensure(
      resource === 'taxonomies' ? !id : !!id,
      422,
      'Wymagany identyfikator punktowego odczytu BigBuy',
    );
    const u = new URL(
      this.base + '/rest/catalog/' + resource + (id ? '/' + bigbuyId.parse(id) : '') + '.json',
    );
    if (resource === 'taxonomies') u.searchParams.set('firstLevel', '');
    if (resource === 'productinformation')
      u.searchParams.set(
        'isoCode',
        z
          .string()
          .regex(/^[a-z]{2}$/)
          .parse(language),
      );
    return this.json(u, 5);
  }
  async bulk(
    resource: BigBuyBulkResource,
    page: number,
    pageSize: number,
    language = 'pl',
    taxonomy: string | null = null,
  ) {
    ensure(bigbuyBulkResources.includes(resource), 422, 'Nieobsługiwany zbiór BigBuy');
    z.number().int().min(0).max(1000000).parse(page);
    z.number().int().min(1).max(10000).parse(pageSize);
    const u = new URL(this.base + '/rest/catalog/' + resource + '.json');
    u.searchParams.set('page', String(page));
    u.searchParams.set('pageSize', String(pageSize));
    if (resource === 'productsinformation')
      u.searchParams.set(
        'isoCode',
        z
          .string()
          .regex(/^[a-z]{2}$/)
          .parse(language),
      );
    if (taxonomy) u.searchParams.set('parentTaxonomy', bigbuyId.parse(taxonomy));
    const rows = await this.json(u, 64);
    ensure(
      Array.isArray(rows) && rows.length <= pageSize,
      502,
      'BigBuy nie zwrócił strony zgodnej z limitem',
    );
    return rows as any[];
  }
  private async json(u: URL, maxMB: number) {
    const r = await this.transport(u.toString(), {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + bigbuyToken.parse(this.credentials.api_key),
        Accept: 'application/json',
      },
    });
    if (r.status === 429 || r.status >= 500) {
      const h = r.headers.get('retry-after'),
        n = Number(h),
        date = h ? Date.parse(h) : NaN;
      await r.body?.cancel();
      throw new BigBuyRetry(
        Math.max(
          5,
          Math.min(
            86400,
            Number.isFinite(n) && n > 0
              ? n
              : Number.isFinite(date)
                ? Math.ceil((date - Date.now()) / 1000)
                : 60,
          ),
        ),
        r.status === 429 ? 429 : 502,
      );
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new Problem(r.status === 401 ? 401 : 502, 'BigBuy: HTTP ' + r.status);
    }
    const reader = r.body?.getReader();
    ensure(reader, 502, 'Brak odpowiedzi JSON BigBuy');
    let size = 0;
    const parts: Uint8Array[] = [];
    try {
      while (true) {
        const p = await reader.read();
        if (p.done) break;
        size += p.value.byteLength;
        ensure(size <= maxMB * 1024 * 1024, 502, 'Odpowiedź BigBuy przekracza ' + maxMB + ' MB');
        parts.push(p.value);
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch (e) {
      if (e instanceof Problem) throw e;
      throw new Problem(502, 'Nieprawidłowy JSON BigBuy');
    } finally {
      await reader.cancel();
    }
  }
  async test() {
    const rows = await this.read('taxonomies');
    ensure(Array.isArray(rows), 502, 'Nieprawidłowe kategorie BigBuy');
    return { read_only: true, categories: rows.length };
  }
}
export function bigbuyMoney(value: unknown) {
  const s = String(value);
  ensure(
    /^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(s),
    502,
    'Cena BigBuy wymaga nieujemnej kwoty z maksymalnie dwiema cyframi po przecinku',
  );
  const [major, fraction = ''] = s.split('.');
  const n = Number(major) * 100 + Number(fraction.padEnd(2, '0'));
  ensure(Number.isSafeInteger(n) && n <= 1000000000, 502, 'Cena BigBuy przekracza limit');
  return n;
}
const stockBucket = z.object({
  quantity: z.number().int().min(0).max(10000000),
  minHandlingDays: z.number().int().min(0).max(365),
  maxHandlingDays: z.number().int().min(0).max(365),
  warehouse: z.number().int().positive().nullable().optional(),
});
export function normalizeBigBuy(
  parts: Record<string, any>,
  root: string,
  variant: string | null,
  language: string,
  maxDays: number,
) {
  const product = parts.product,
    info = parts.productinformation;
  ensure(
    bigbuyId.parse(product?.id) === root && bigbuyId.parse(info?.id) === root,
    502,
    'BigBuy zwrócił inny produkt',
  );
  ensure(info.isoCode === language, 502, 'BigBuy zwrócił inny język');
  ensure(product.active === 0 || product.active === 1, 502, 'Brak aktywności produktu BigBuy');
  let p = product;
  if (variant) {
    ensure(
      Array.isArray(parts.productvariations) && parts.productvariations.length <= 10000,
      502,
      'Nieprawidłowe warianty BigBuy',
    );
    const found = parts.productvariations.filter(
      (v: any) => String(v.id) === variant && String(v.product) === root,
    );
    ensure(found.length === 1, 502, 'Nie znaleziono jednoznacznego wariantu BigBuy');
    p = found[0];
  } else
    ensure(
      product.attributes === false,
      422,
      'Produkt ma warianty lub nieznany typ; podaj ID wariantu',
    );
  const sku = z.string().trim().min(1).max(80).parse(p.sku),
    stock = parts[variant ? 'productvariationsstockbyhandlingdays' : 'productstockbyhandlingdays'];
  ensure(
    String(stock?.id) === (variant ?? root) && stock?.sku === sku,
    502,
    'Stan BigBuy nie odpowiada wybranemu SKU',
  );
  const buckets = z.array(stockBucket).max(1000).parse(stock.stocks);
  ensure(
    buckets.every((b) => b.minHandlingDays <= b.maxHandlingDays),
    502,
    'Nieprawidłowy czas przygotowania BigBuy',
  );
  ensure(
    new Set(
      buckets.map((b) =>
        JSON.stringify([b.warehouse ?? null, b.minHandlingDays, b.maxHandlingDays]),
      ),
    ).size === buckets.length,
    502,
    'Powtórzony koszyk stanu BigBuy',
  );
  const quantity = buckets
    .filter((b) => b.maxHandlingDays <= maxDays)
    .reduce((a, b) => a + b.quantity, 0);
  ensure(quantity <= 10000000, 502, 'Stan BigBuy przekracza limit');
  const image = parts.productimages;
  ensure(
    String(image?.id) === root && Array.isArray(image.images),
    502,
    'Nieprawidłowe zdjęcia produktu BigBuy',
  );
  const images = image.images.slice(0, 20).map((i: any) => {
    const u = new URL(i.url);
    ensure(
      u.protocol === 'https:' && !u.username && !u.password,
      502,
      'Nieprawidłowy URL zdjęcia BigBuy',
    );
    return u.toString();
  });
  const tiers = (p.priceLargeQuantities ?? [])
    .map((t: any) => ({
      quantity: z.number().int().positive().max(1000000).parse(t.quantity),
      unit_cost: bigbuyMoney(t.price),
    }))
    .sort((a: any, b: any) => a.quantity - b.quantity);
  ensure(
    tiers.length <= 100 && new Set(tiers.map((t: any) => t.quantity)).size === tiers.length,
    502,
    'Nieprawidłowe progi cen BigBuy',
  );
  return {
    remote_product_id: root,
    remote_variant_id: variant,
    sku,
    name: z.string().trim().min(2).max(200).parse(info.name),
    ean: z
      .string()
      .max(32)
      .nullable()
      .parse(p.ean13 ?? null),
    description: z
      .string()
      .max(100000)
      .parse(info.description ?? ''),
    images,
    unit_cost: bigbuyMoney(p.wholesalePrice),
    tiers,
    quantity,
    active: product.active === 1,
    handling: buckets,
    condition: z
      .string()
      .max(100)
      .parse(product.condition ?? 'nieznany'),
  };
}
