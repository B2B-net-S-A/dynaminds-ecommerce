import { isDeepStrictEqual } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { ensure, Problem } from './errors';
import type { Transport } from './integrations';
import { productImageData } from './product-image-format';

export const ODOO_VERSION = '19 JSON-2';
export const odooId = (v: unknown) => {
  const n = typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) ? Number(v) : v;
  ensure(
    typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 2147483647,
    422,
    'Nieprawidłowe ID Odoo',
  );
  return n;
};
export function odooConfig(settings: Record<string, any>, credentials: Record<string, string>) {
  let u: URL;
  try {
    u = new URL(settings.server_url);
  } catch {
    throw new Problem(422, 'Wymagany adres serwera Odoo HTTPS');
  }
  ensure(
    u.protocol === 'https:' &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === '/' &&
      /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) &&
      !u.hostname.endsWith('.local'),
    422,
    'Wymagana publiczna domena serwera Odoo HTTPS bez ścieżki',
  );
  ensure(
    typeof settings.database === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(settings.database),
    422,
    'Nieprawidłowa nazwa bazy Odoo',
  );
  ensure(
    ['net', 'gross'].includes(settings.price_mode),
    422,
    'Wybierz jawnie ceny Odoo netto lub brutto',
  );
  ensure(
    typeof credentials.api_key === 'string' && /^[\x21-\x7e]{16,1000}$/.test(credentials.api_key),
    422,
    'Nieprawidłowy klucz API Odoo',
  );
  return {
    origin: u.origin,
    database: settings.database,
    company: odooId(settings.company_id),
    warehouse: odooId(settings.warehouse_id),
    unit: odooId(settings.unit_id),
    included: settings.price_mode === 'gross',
    key: credentials.api_key,
  };
}
export function odooMoney(v: unknown) {
  ensure(typeof v === 'number' && Number.isFinite(v) && v >= 0, 422, 'Nieprawidłowa kwota Odoo');
  const minor = Math.round(v * 100);
  ensure(
    Number.isSafeInteger(minor) && minor <= 100000000 && Math.abs(v * 100 - minor) < 0.000001,
    422,
    'Cena Odoo wymaga najwyżej dwóch miejsc po przecinku',
  );
  return minor;
}
export const relation = (v: any) => {
  ensure(
    Array.isArray(v) && v.length === 2 && typeof v[1] === 'string',
    502,
    'Niepełna relacja Odoo',
  );
  return odooId(v[0]);
};
const productFields = [
  'id',
  'name',
  'default_code',
  'barcode',
  'product_tmpl_id',
  'product_template_attribute_value_ids',
  'lst_price',
  'uom_id',
  'currency_id',
  'weight',
  'description_sale',
  'type',
  'company_id',
  'sale_ok',
  'active',
  'is_storable',
  'free_qty',
  'write_date',
];
const templateFields = [
  'id',
  'name',
  'company_id',
  'product_variant_count',
  'write_date',
  'type',
  'sale_ok',
  'active',
];
const readModels = new Set([
  'res.company',
  'res.currency',
  'stock.warehouse',
  'uom.uom',
  'product.template',
  'product.product',
  'product.template.attribute.value',
  'sale.order',
  'sale.order.line',
  'res.partner',
  'res.country',
  'payment.transaction',
  'stock.picking',
]);
export type OdooFence = () => Promise<void>;
/** Every remotely callable method is a fixed read; no arbitrary RPC method is exposed. */
export class Odoo {
  private config: ReturnType<typeof odooConfig>;
  constructor(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    private transport: Transport,
  ) {
    this.config = odooConfig(settings, credentials);
  }
  protected async rpc(
    model: string,
    method: 'read' | 'search_read',
    args: any,
    fence?: OdooFence,
  ): Promise<any[]>;
  protected async rpc(
    model: string,
    method: 'fields_get',
    args: any,
    fence?: OdooFence,
  ): Promise<Record<string, { type: string }>>;
  protected async rpc(
    model: string,
    method: 'read' | 'search_read' | 'fields_get',
    args: any,
    fence?: OdooFence,
  ): Promise<any> {
    ensure(
      readModels.has(model) &&
        (method === 'read' ||
          (method === 'search_read' && ['product.product', 'sale.order'].includes(model)) ||
          (method === 'fields_get' && model === 'sale.order.line')),
      422,
      'Niedozwolona operacja Odoo',
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      await fence?.();
      const r = await this.transport(`${this.config.origin}/json/2/${model}/${method}`, {
        method: 'POST',
        signal: AbortSignal.timeout(12000),
        redirect: 'error',
        headers: {
          Authorization: 'Bearer ' + this.config.key,
          'X-Odoo-Database': this.config.database,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ...args,
          context: {
            allowed_company_ids: [this.config.company],
            warehouse_id: this.config.warehouse,
            lang: 'en_US',
            ...(model === 'product.product' && args.fields?.includes('image_1920')
              ? { bin_size: false }
              : {}),
          },
        }),
      }).catch(() => {
        throw new Problem(502, 'Nie udało się odczytać API Odoo');
      });
      if ([429, 502, 503, 504].includes(r.status) && attempt < 2) {
        const retry = r.headers.get('retry-after');
        const seconds =
          retry && /^\d+(\.\d+)?$/.test(retry)
            ? Number(retry)
            : retry
              ? (Date.parse(retry) - Date.now()) / 1000
              : 0.1 * (attempt + 1);
        await r.body?.cancel();
        await setTimeout(
          Math.min(5000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : 200)),
        );
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new Problem(
          r.status === 401 || r.status === 403 ? r.status : 502,
          'Odoo: HTTP ' + r.status + ' podczas odczytu',
        );
      }
      const reader = r.body?.getReader();
      ensure(reader, 502, 'Brak odpowiedzi Odoo');
      const parts: Uint8Array[] = [];
      let bytes = 0,
        value: any;
      try {
        while (true) {
          const p = await reader.read();
          if (p.done) break;
          bytes += p.value.byteLength;
          ensure(bytes <= 4 * 1024 * 1024, 502, 'Odpowiedź Odoo przekracza 4 MB');
          parts.push(p.value);
        }
        value = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch (e) {
        if (e instanceof Problem) throw e;
        throw new Problem(502, 'Nieprawidłowy JSON Odoo');
      } finally {
        await reader.cancel();
      }
      // Odoo exceptions may contain database names, SQL and credentials. Never forward their payload.
      if (method === 'fields_get') {
        ensure(
          value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).every((k) => k === 'is_delivery') &&
            (!value.is_delivery || value.is_delivery.type === 'boolean'),
          502,
          'Nieprawidłowe metadane dostawy Odoo',
        );
      } else
        ensure(Array.isArray(value) && value.length <= 100, 502, 'Nieprawidłowa lista danych Odoo');
      return value;
    }
    throw new Problem(502, 'Wyczerpano próby odczytu Odoo');
  }
  protected async read(model: string, ids: number[], fields: string[], fence?: OdooFence) {
    const unique = [...new Set(ids.map(odooId))];
    ensure(unique.length <= 100, 502, 'Przekroczono partię odczytu Odoo');
    if (!unique.length) return [];
    const data = await this.rpc(model, 'read', { ids: unique, fields }, fence);
    ensure(
      data.length === unique.length &&
        new Set(data.map((r) => odooId(r?.id))).size === data.length &&
        data.every((r) => unique.includes(r.id)),
      502,
      'Niepełne lub obce rekordy Odoo',
    );
    return data;
  }
  private company(v: any) {
    ensure(
      v === false || relation(v) === this.config.company,
      502,
      'Produkt Odoo należy do innej firmy',
    );
  }
  async primaryImage(id: number, fence?: OdooFence) {
    const fields = [
      'id',
      'product_tmpl_id',
      'company_id',
      'active',
      'sale_ok',
      'write_date',
      'image_1920',
    ];
    const [first] = await this.read('product.product', [odooId(id)], fields, fence);
    this.company(first.company_id);
    ensure(first.active === true && first.sale_ok === true, 409, 'Produkt ERP jest nieaktywny');
    const template = relation(first.product_tmpl_id);
    ensure(
      typeof first.write_date === 'string' && first.write_date.length > 0,
      502,
      'Brak wersji produktu ERP',
    );
    ensure(first.image_1920, 404, 'Produkt Odoo nie ma głównego zdjęcia');
    const image = productImageData(first.image_1920, 502);
    const [after] = await this.read('product.product', [id], fields, fence);
    ensure(
      isDeepStrictEqual(first, after),
      409,
      'Zdjęcie lub produkt ERP zmieniły się podczas odczytu',
    );
    await fence?.();
    return { ...image, template_id: template, write_date: first.write_date };
  }
  async catalogSettings(fence?: OdooFence) {
    const [company] = await this.read(
      'res.company',
      [this.config.company],
      ['id', 'name', 'currency_id'],
      fence,
    );
    const [warehouse] = await this.read(
      'stock.warehouse',
      [this.config.warehouse],
      ['id', 'name', 'company_id'],
      fence,
    );
    ensure(
      relation(warehouse.company_id) === this.config.company,
      502,
      'Magazyn Odoo należy do innej firmy',
    );
    const [currency] = await this.read(
      'res.currency',
      [relation(company.currency_id)],
      ['id', 'name', 'rounding', 'decimal_places', 'active'],
      fence,
    );
    ensure(
      ['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(currency.name) &&
        currency.active === true &&
        currency.decimal_places === 2 &&
        currency.rounding === 0.01,
      422,
      'Waluta Odoo wymaga osobnego procesu rozliczeń',
    );
    const [unit] = await this.read(
      'uom.uom',
      [this.config.unit],
      ['id', 'name', 'rounding'],
      fence,
    );
    ensure(unit.rounding === 1, 422, 'Jednostka magazynu wymaga całkowitych ilości');
    return {
      currency: currency.name as string,
      currency_id: currency.id as number,
      prices_include_tax: this.config.included,
      company_id: company.id as number,
      warehouse_id: warehouse.id as number,
      unit_id: unit.id as number,
      company_name: String(company.name).slice(0, 200),
      warehouse_name: String(warehouse.name).slice(0, 200),
      unit_name: String(unit.name).slice(0, 80),
    };
  }
  async test() {
    return { read_only: true, version: ODOO_VERSION, ...(await this.catalogSettings()) };
  }
  async catalogPage(after = 0, fence?: OdooFence) {
    odooId(after || 1);
    const context = await this.catalogSettings(fence);
    const data = await this.rpc(
      'product.product',
      'search_read',
      {
        domain: [
          ['id', '>', after],
          ['active', '=', true],
          ['sale_ok', '=', true],
          '|',
          ['company_id', '=', false],
          ['company_id', '=', this.config.company],
        ],
        fields: productFields,
        order: 'id asc',
        limit: 50,
      },
      fence,
    );
    ensure(data.length <= 50, 502, 'Przekroczono stronę katalogu Odoo');
    let last = after;
    for (const p of data) {
      const id = odooId(p.id);
      ensure(id > last, 502, 'Brak postępu lub powtórzone ID Odoo');
      last = id;
      this.company(p.company_id);
      ensure(
        p.active === true && p.sale_ok === true && relation(p.currency_id) === context.currency_id,
        502,
        'Niezgodna waluta lub status produktu Odoo',
      );
    }
    const result = await this.enrichCatalog(data, context, fence);
    return { ...result, has_more: data.length === 50, next_cursor: last };
  }
  async catalogVariants(ids: number[], fence?: OdooFence) {
    ensure(ids.length > 0 && ids.length <= 50, 422, 'Wymagane 1–50 wariantów Odoo');
    const context = await this.catalogSettings(fence);
    const data = await this.read('product.product', ids, productFields, fence);
    for (const p of data) {
      this.company(p.company_id);
      ensure(
        p.active === true && p.sale_ok === true && relation(p.currency_id) === context.currency_id,
        422,
        'Wariant Odoo nie jest aktywną sprzedażą w walucie firmy',
      );
    }
    const result = await this.enrichCatalog(data, context, fence);
    const again = await this.read('product.product', ids, productFields, fence);
    const sort = (r: any[]) => [...r].sort((a, b) => a.id - b.id);
    ensure(
      isDeepStrictEqual(sort(data), sort(again)) &&
        isDeepStrictEqual(context, await this.catalogSettings(fence)),
      409,
      'Cena lub dostępność Odoo zmieniły się podczas odczytu',
    );
    return result;
  }
  private async enrichCatalog(data: any[], context: any, fence?: OdooFence) {
    const templates = await this.read(
      'product.template',
      data.map((p) => relation(p.product_tmpl_id)),
      templateFields,
      fence,
    );
    for (const t of templates) {
      this.company(t.company_id);
      ensure(
        Number.isInteger(t.product_variant_count) &&
          t.product_variant_count > 0 &&
          t.active === true &&
          t.sale_ok === true,
        502,
        'Niepełny szablon produktu Odoo',
      );
    }
    const values: number[] = [];
    for (const p of data) {
      ensure(
        Array.isArray(p.product_template_attribute_value_ids) &&
          p.product_template_attribute_value_ids.length <= 50,
        502,
        'Niepełne parametry wariantu Odoo',
      );
      values.push(...p.product_template_attribute_value_ids.map(odooId));
    }
    const attributes: any[] = [];
    const unique = [...new Set(values)];
    for (let i = 0; i < unique.length; i += 100)
      attributes.push(
        ...(await this.read(
          'product.template.attribute.value',
          unique.slice(i, i + 100),
          ['id', 'name', 'attribute_id', 'product_tmpl_id'],
          fence,
        )),
      );
    const rows = data.map((p) => {
      const template = templates.find((t) => t.id === relation(p.product_tmpl_id));
      const attrs = p.product_template_attribute_value_ids.map((id: number) => {
        const a = attributes.find((a) => a.id === id);
        ensure(
          a && relation(a.product_tmpl_id) === template.id,
          502,
          'Parametr Odoo należy do innego produktu',
        );
        relation(a.attribute_id);
        return { name: a.attribute_id[1], value: a.name };
      });
      return { ...p, template, attributes: attrs };
    });
    // JSON-2 calls each use a different transaction. Reject modified product/template rows
    // observed while enriching the page; this is a bounded preview, not a database snapshot.
    if (data.length) {
      const check = await this.read(
        'product.product',
        data.map((p) => p.id),
        ['id', 'write_date'],
        fence,
      );
      const checkTemplates = await this.read(
        'product.template',
        templates.map((t) => t.id),
        ['id', 'write_date'],
        fence,
      );
      ensure(
        data.every(
          (p) =>
            typeof p.write_date === 'string' &&
            check.find((c) => c.id === p.id)?.write_date === p.write_date,
        ) &&
          templates.every(
            (t) =>
              typeof t.write_date === 'string' &&
              checkTemplates.find((c) => c.id === t.id)?.write_date === t.write_date,
          ),
        409,
        'Katalog Odoo zmienił się podczas pobierania; ponów przegląd',
      );
    }
    return { data: rows, context };
  }
}
