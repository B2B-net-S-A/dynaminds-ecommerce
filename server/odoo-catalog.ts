import { ensure } from './errors';
import { odooId, odooMoney, relation } from './odoo';
import { sourceHash } from './catalog-source-normalize';
const text = (v: unknown) =>
  typeof v === 'string'
    ? v
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
export function normalizeOdooCatalog(raw: any, run: any, group = false) {
  const p = raw.template,
    templateId = relation(raw.product_tmpl_id);
  ensure(p?.id === templateId, 502, 'Niezgodny szablon Odoo');
  const variant = p.product_variant_count > 1;
  const kind = group ? 'group' : variant ? 'variant' : 'simple';
  const id = group ? 'template:' + templateId : String(odooId(raw.id));
  const parent = kind === 'variant' ? 'template:' + templateId : null;
  const issues: string[] = [];
  const unsupported =
    p.type !== 'consu' ||
    (!group && (raw.type !== 'consu' || relation(raw.uom_id) !== run.context.unit_id));
  if (unsupported) issues.push('Usługa, zestaw lub inna jednostka wymaga osobnego procesu');
  const sku = group
    ? `OD-GROUP-${run.channel_id.slice(0, 8)}-${templateId}`
    : text(raw.default_code) || `OD-${run.channel_id.slice(0, 8)}-${id}`;
  if (!group && !text(raw.default_code))
    issues.push('Brak SKU; proponowany symbol lokalny można zmienić');
  let price: number | null = group ? 0 : null;
  if (!group)
    try {
      const n = odooMoney(raw.lst_price);
      price = run.context.prices_include_tax ? n : Math.floor((n * (100 + run.vat) + 50) / 100);
      ensure(price <= 100000000, 422, 'Przekroczono cenę');
    } catch {
      issues.push('Cena wymaga jawnej wartości lokalnej');
      price = null;
    }
  const quantity = group
    ? 0
    : raw.is_storable === true &&
        Number.isInteger(raw.free_qty) &&
        raw.free_qty >= 0 &&
        raw.free_qty <= 10000000
      ? raw.free_qty
      : null;
  if (!group && quantity === null)
    issues.push('Brak całkowitej dostępności ERP; stan nie zwiększa magazynu lokalnego');
  const attributes: Record<string, string> = Object.create(null);
  if (!group) {
    for (const a of raw.attributes ?? []) {
      const name = text(a.name).slice(0, 80),
        value = text(a.value).slice(0, 500);
      if (name && value) attributes[name] = value;
    }
    attributes['Jednostka ERP'] = text(raw.uom_id[1]).slice(0, 500);
    if (typeof raw.weight === 'number' && Number.isFinite(raw.weight) && raw.weight >= 0)
      attributes['Waga ERP (kg)'] = String(raw.weight);
  }
  const source = {
    external_id: id,
    parent_external_id: parent,
    kind,
    unsupported,
    sku,
    source_sku: group ? '' : text(raw.default_code),
    name: (text(group ? p.name : raw.name) || `Odoo ${id}`).slice(0, 200),
    description: group ? '' : text(raw.description_sale).slice(0, 10000),
    ean: group ? '' : text(raw.barcode).slice(0, 32),
    category: 'Odoo',
    attributes,
    images: [],
    price,
    vat: run.vat,
    currency: run.context.currency,
    quantity,
    active: true,
    source_status: 'active',
    erp: {
      company_id: run.context.company_id,
      warehouse_id: run.context.warehouse_id,
      template_id: templateId,
      unit_id: group ? run.context.unit_id : relation(raw.uom_id),
      availability: group
        ? null
        : typeof raw.free_qty === 'number' && Number.isFinite(raw.free_qty)
          ? raw.free_qty
          : null,
      write_date: group ? p.write_date : raw.write_date,
    },
  };
  return {
    external_id: id,
    parent_external_id: parent,
    kind,
    source,
    source_hash: sourceHash(source),
    issues,
  };
}
export const demoOdooContext = {
  currency: 'PLN',
  currency_id: 1,
  prices_include_tax: false,
  company_id: 1,
  warehouse_id: 1,
  unit_id: 1,
  company_name: 'Firma demonstracyjna Odoo',
  warehouse_name: 'Magazyn ERP — przykład',
  unit_name: 'szt.',
};
export const demoOdooCatalog = () =>
  [101, 102].map((id, index) => ({
    id,
    name: `Koszulka Odoo — ${index ? 'czerwona' : 'niebieska'}`,
    default_code: `OD-DEMO-${index ? 'RED' : 'BLUE'}`,
    barcode: '',
    product_tmpl_id: [10, 'Koszulka Odoo'],
    product_template_attribute_value_ids: [id],
    lst_price: index ? 40 : 35,
    uom_id: [1, 'szt.'],
    currency_id: [1, 'PLN'],
    weight: 0.2,
    description_sale: 'Dane syntetyczne — lokalny przykład ERP',
    type: 'consu',
    company_id: [1, 'Firma demonstracyjna Odoo'],
    sale_ok: true,
    active: true,
    is_storable: true,
    free_qty: index ? 8 : 12,
    write_date: '2026-10-04 12:00:00',
    template: {
      id: 10,
      name: 'Koszulka Odoo',
      company_id: [1, 'Firma demonstracyjna Odoo'],
      product_variant_count: 2,
      write_date: '2026-10-04 12:00:00',
      type: 'consu',
      sale_ok: true,
      active: true,
    },
    attributes: [{ name: 'Kolor', value: index ? 'Czerwony' : 'Niebieski' }],
  }));
