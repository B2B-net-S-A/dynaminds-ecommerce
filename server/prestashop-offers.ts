import type { PrestaShop } from './integrations';
import { ensure } from './errors';
import { psId, psMicros } from './prestashop-orders';

export function psOfferId(value: string) {
  const parts = value.split(':');
  ensure(
    parts.length === 2,
    422,
    'Oferta PrestaShop wymaga ID produktu:kombinacji (0 dla prostego)',
  );
  return { product: psId(parts[0]), combination: psId(parts[1], true) };
}
export function psMoney(n: bigint) {
  const sign = n < 0n ? '-' : '';
  n = n < 0n ? -n : n;
  return sign + n / 1000000n + '.' + String(n % 1000000n).padStart(6, '0');
}
function signedPrice(v: unknown) {
  ensure(typeof v === 'string', 502, 'Brak ceny kombinacji PrestaShop');
  return v.startsWith('-') ? -psMicros(v.slice(1)) : psMicros(v);
}
export function psDesiredPrice(price: number, vat: number) {
  const denominator = BigInt(100 + vat);
  return psMoney((BigInt(price) * 1000000n + denominator / 2n) / denominator);
}
const fields = (s: string) => '[' + s + ']';
export async function readPrestaOffer(
  client: PrestaShop,
  external: string,
  price: boolean,
  stock = true,
  validateWrites = true,
) {
  const { product, combination } = psOfferId(external);
  const rows = await client.offerRows(
    'products',
    { 'filter[id]': '[' + product + ']', display: 'full', limit: 1 },
    1,
  );
  ensure(
    rows.length === 1 && psId(rows[0].id) === product,
    502,
    'Brak powiązanego produktu PrestaShop',
  );
  const p = rows[0];
  ensure(
    !validateWrites ||
      (!['1', 1, true].includes(p.is_virtual) &&
        !['1', 1, true].includes(p.cache_is_pack) &&
        !p.associations?.product_bundle?.length &&
        p.type !== 'virtual' &&
        p.type !== 'pack'),
    422,
    'Wybierz fizyczny produkt PrestaShop; pakiety natywne mają osobną politykę stanu',
  );
  let variant: any;
  if (combination !== '0') {
    const combinations = await client.offerRows(
      'combinations',
      {
        'filter[id]': '[' + combination + ']',
        display: fields('id,id_product,reference,price'),
        limit: 1,
      },
      1,
    );
    ensure(
      combinations.length === 1 &&
        psId(combinations[0].id) === combination &&
        psId(combinations[0].id_product) === product,
      502,
      'Kombinacja należy do innego produktu PrestaShop',
    );
    variant = combinations[0];
  } else
    ensure(
      !validateWrites ||
        (!p.associations?.combinations?.length &&
          (!p.id_default_combination || String(p.id_default_combination) === '0')),
      422,
      'Produkt ma kombinacje; powiąż konkretne ID produktu:kombinacji',
    );
  const stocks = await client.offerRows(
    'stock_availables',
    {
      'filter[id_product]': '[' + product + ']',
      'filter[id_product_attribute]': '[' + combination + ']',
      display: fields(
        'id,id_product,id_product_attribute,id_shop,id_shop_group,quantity,depends_on_stock,out_of_stock',
      ),
      limit: 101,
    },
    100,
  );
  ensure(
    stocks.every(
      (s: any) =>
        psId(s.id_product) === product && psId(s.id_product_attribute, true) === combination,
    ),
    502,
    'API zwróciło stan innego produktu lub kombinacji',
  );
  let scoped = stocks.filter(
    (s: any) => String(s.id_shop) === client.offerShopId && String(s.id_shop_group) === '0',
  );
  if (
    !scoped.length &&
    stocks.some((s: any) => String(s.id_shop) === '0' && String(s.id_shop_group) !== '0')
  ) {
    const shops = await client.offerRows(
      'shops',
      {
        'filter[id]': '[' + client.offerShopId + ']',
        display: fields('id,id_shop_group'),
        limit: 1,
      },
      1,
    );
    ensure(
      shops.length === 1 && psId(shops[0].id) === client.offerShopId,
      502,
      'Nie można ustalić grupy sklepu PrestaShop',
    );
    const group = psId(shops[0].id_shop_group);
    const groups = await client.offerRows(
      'shop_groups',
      { 'filter[id]': '[' + group + ']', display: fields('id,share_stock'), limit: 1 },
      1,
    );
    ensure(
      groups.length === 1 && psId(groups[0].id) === group && String(groups[0].share_stock) === '1',
      422,
      'Grupa sklepu nie potwierdziła współdzielenia stanów',
    );
    scoped = stocks.filter(
      (s: any) => String(s.id_shop) === '0' && String(s.id_shop_group) === group,
    );
  }
  ensure(scoped.length === 1, 422, 'Brak jednoznacznego stanu dla sklepu PrestaShop');
  const s = scoped[0];
  ensure(
    ['0', '1'].includes(String(s.depends_on_stock)),
    502,
    'Nieprawidłowa polityka magazynu PrestaShop',
  );
  ensure(
    !validateWrites || !stock || String(s.depends_on_stock) === '0',
    422,
    'Stan PrestaShop zależy od zaawansowanego magazynu',
  );
  ensure(
    /^-?\d{1,10}$/.test(String(s.quantity)) &&
      Number.isSafeInteger(Number(s.quantity)) &&
      Math.abs(Number(s.quantity)) <= 2147483647,
    502,
    'Nieprawidłowa ilość PrestaShop',
  );
  ensure(
    ['0', '1', '2'].includes(String(s.out_of_stock)),
    502,
    'Nieprawidłowa polityka dostępności PrestaShop',
  );
  let currency: string | undefined;
  let specificPrices = false;
  if (price) {
    const configs = await client.offerRows(
      'configurations',
      {
        'filter[name]': '[PS_CURRENCY_DEFAULT]',
        display: fields('id,name,value,id_shop,id_shop_group'),
        limit: 101,
      },
      100,
    );
    ensure(
      configs.every((c: any) => c.name === 'PS_CURRENCY_DEFAULT'),
      502,
      'API zwróciło inną konfigurację waluty',
    );
    for (const c of configs)
      for (const field of ['id_shop', 'id_shop_group'])
        if (c[field] !== null && c[field] !== undefined && c[field] !== '') psId(c[field], true);
    const perShop = configs.filter((c: any) => String(c.id_shop) === client.offerShopId);
    let perGroup: any[] = [];
    if (
      !perShop.length &&
      configs.some((c: any) => !Number(c.id_shop) && Number(c.id_shop_group))
    ) {
      const shops = await client.offerRows(
        'shops',
        {
          'filter[id]': '[' + client.offerShopId + ']',
          display: fields('id,id_shop_group'),
          limit: 1,
        },
        1,
      );
      ensure(
        shops.length === 1 && psId(shops[0].id) === client.offerShopId,
        502,
        'Nie można ustalić grupy waluty sklepu PrestaShop',
      );
      const group = psId(shops[0].id_shop_group);
      perGroup = configs.filter(
        (c: any) => !Number(c.id_shop) && String(c.id_shop_group) === group,
      );
    }
    const defaults = perShop.length
      ? perShop
      : perGroup.length
        ? perGroup
        : configs.filter((c: any) => !Number(c.id_shop) && !Number(c.id_shop_group));
    ensure(defaults.length === 1, 422, 'Nie można ustalić domyślnej waluty sklepu PrestaShop');
    const currencyId = psId(defaults[0].value);
    const currencies = await client.offerRows(
      'currencies',
      {
        'filter[id]': '[' + currencyId + ']',
        display: fields('id,iso_code,active,deleted'),
        limit: 1,
      },
      1,
    );
    ensure(
      currencies.length === 1 &&
        psId(currencies[0].id) === currencyId &&
        String(currencies[0].active) === '1' &&
        String(currencies[0].deleted) === '0' &&
        /^[A-Z]{3}$/.test(currencies[0].iso_code),
      502,
      'Waluta PrestaShop jest niedostępna',
    );
    currency = currencies[0].iso_code;
    const promotions = await client.offerRows(
      'specific_prices',
      { 'filter[id_product]': '[0|' + product + ']', display: '[id]', limit: 1 },
      1,
    );
    specificPrices = promotions.length > 0;
  }
  ensure(
    !validateWrites || !price || psMicros(String(p.ecotax ?? '0')) === 0n,
    422,
    'Produkt z ecotax wymaga osobnej polityki ceny',
  );
  const productPrice = psMicros(String(p.price));
  const effective = productPrice + (variant ? signedPrice(String(variant.price)) : 0n);
  ensure(effective >= 0n, 502, 'Ujemna cena całego wariantu PrestaShop');
  return {
    id: external,
    sku: variant?.reference || p.reference || '',
    product_id: product,
    combination_id: combination,
    product_price: psMoney(productPrice),
    regular_price: psMoney(effective),
    tax_rules_group: String(p.id_tax_rules_group ?? ''),
    stock_id: psId(s.id),
    stock_shop: String(s.id_shop),
    stock_group: String(s.id_shop_group),
    stock_quantity: Number(s.quantity),
    out_of_stock: Number(s.out_of_stock),
    depends_on_stock: Number(s.depends_on_stock),
    status: String(p.active) === '1' ? 'active' : 'inactive',
    currency,
    specific_prices: specificPrices,
  };
}
export function prestaSnapshot(r: any) {
  return Object.fromEntries(
    [
      'id',
      'sku',
      'product_id',
      'combination_id',
      'product_price',
      'regular_price',
      'tax_rules_group',
      'stock_id',
      'stock_shop',
      'stock_group',
      'stock_quantity',
      'out_of_stock',
      'depends_on_stock',
      'status',
      'currency',
      'specific_prices',
    ].map((k) => [k, r[k] ?? null]),
  );
}
export function prestaMatches(payload: any, r: any) {
  return (
    (!('regular_price' in payload) ||
      psMicros(r.regular_price) === psMicros(payload.regular_price)) &&
    (!('stock_quantity' in payload) ||
      (r.stock_quantity === payload.stock_quantity &&
        r.out_of_stock === 0 &&
        r.depends_on_stock === 0))
  );
}
// Compare the frozen resource while allowing only changes made by this plan.
export function prestaExpected(snapshot: any, payload: any, steps: any) {
  const expected = { ...snapshot };
  if (steps.price) {
    expected.regular_price = payload.regular_price;
    if (snapshot.combination_id === '0') expected.product_price = payload.regular_price;
  }
  if (steps.stock) {
    expected.stock_quantity = payload.stock_quantity;
    expected.out_of_stock = 0;
  }
  return expected;
}
