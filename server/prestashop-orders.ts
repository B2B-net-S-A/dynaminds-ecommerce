import { ensure } from './errors';

export const psId = (value: unknown, zero = false): string => {
  const id = String(value ?? '');
  ensure(
    (zero ? /^(0|[1-9]\d{0,9})$/ : /^[1-9]\d{0,9}$/).test(id),
    422,
    'Nieprawidłowy identyfikator PrestaShop',
  );
  return id;
};
export function psStateIds(value: unknown) {
  ensure(
    typeof value === 'string' && value.length <= 550,
    422,
    'Podaj ID statusów PrestaShop dopuszczonych do realizacji',
  );
  const ids = [...new Set(value.split(',').map((v) => psId(v.trim())))];
  ensure(ids.length > 0 && ids.length <= 50, 422, 'Podaj od 1 do 50 ID statusów');
  return ids;
}
export function psMicros(value: unknown) {
  ensure(
    typeof value === 'string' && /^\d{1,10}(\.\d{1,6})?$/.test(value),
    422,
    'Nieprawidłowa kwota PrestaShop (do 6 miejsc po przecinku)',
  );
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  ensure(amount <= 21474836470000n, 422, 'Kwota przekracza limit');
  return amount;
}
function roundMicros(amount: bigint, mode: number) {
  ensure(
    Number.isInteger(mode) && mode >= 0 && mode <= 5,
    422,
    'Nieznany tryb zaokrąglania PrestaShop',
  );
  const whole = amount / 10000n,
    rest = amount % 10000n;
  const up =
    mode === 0
      ? rest > 0n
      : mode === 1
        ? false
        : rest > 5000n ||
          (rest === 5000n &&
            (mode === 2 || (mode === 4 && whole % 2n === 1n) || (mode === 5 && whole % 2n === 0n)));
  return Number(whole + (up ? 1n : 0n));
}
export const psCents = (value: unknown, mode = 2) => roundMicros(psMicros(value), mode);
const yes = (value: unknown) => value === '1' || value === 1 || value === true;
const quantity = (value: unknown) => {
  const n = Number(value);
  ensure(
    String(value).match(/^\d+$/) && Number.isSafeInteger(n) && n >= 1 && n <= 100000,
    422,
    'Nieprawidłowa ilość PrestaShop',
  );
  return n;
};
// Largest remainders keep the exact order subtotal, including six-decimal source prices.
export function allocatePs(total: number, weights: bigint[]) {
  const sum = weights.reduce((s, v) => s + v, 0n);
  ensure(
    Number.isSafeInteger(total) && total >= 0 && (sum > 0n || total === 0),
    422,
    'Nie można rozdzielić rabatu',
  );
  if (sum === 0n) return weights.map(() => 0);
  const shares = weights.map((weight, index) => ({
    index,
    amount: Number((BigInt(total) * weight) / sum),
    remainder: (BigInt(total) * weight) % sum,
  }));
  let rest = total - shares.reduce((s, v) => s + v.amount, 0);
  for (const share of [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  )) {
    if (rest-- > 0) share.amount++;
  }
  return shares.map((v) => v.amount);
}
export function normalizePrestaShop(
  raw: any,
  settings: Record<string, unknown>,
  sourceLines = false,
) {
  const r = raw?._dyna;
  ensure(
    r && Array.isArray(r.details) && Array.isArray(r.cart_rules),
    422,
    'Zamówienie PrestaShop wymaga odczytu powiązanych zasobów',
  );
  const id = psId(raw.id),
    shop = psId(raw.id_shop);
  ensure(shop === psId(settings.shop_id), 422, 'Zamówienie pochodzi z innego sklepu PrestaShop');
  for (const [related, expected] of [
    [r.customer, raw.id_customer],
    [r.address, raw.id_address_delivery],
    [r.country, r.address?.id_country],
    [r.currency, raw.id_currency],
    [r.state, raw.current_state],
  ])
    ensure(
      related && psId(related.id) === psId(expected),
      422,
      'Niezgodne powiązane zasoby PrestaShop',
    );
  ensure(
    psId(r.address.id_customer) === psId(raw.id_customer),
    422,
    'Adres nie należy do klienta zamówienia',
  );
  const rows = raw.associations?.order_rows;
  ensure(
    Array.isArray(rows) &&
      rows.length > 0 &&
      rows.length <= 100 &&
      r.details.length === rows.length,
    422,
    'Niekompletne pozycje zamówienia PrestaShop',
  );
  const rowIds = rows.map((v: any) => psId(v.id));
  ensure(
    new Set(rowIds).size === rows.length &&
      new Set(r.details.map((v: any) => psId(v.id))).size === rows.length,
    422,
    'Powtórzone pozycje PrestaShop',
  );
  const blockers: string[] = [];
  for (const field of ['paid', 'shipped', 'delivery', 'deleted'])
    ensure(
      ['0', '1', 0, 1, true, false].includes(r.state[field]),
      422,
      'Niekompletny status PrestaShop',
    );
  if (!psStateIds(settings.order_state_ids).includes(psId(raw.current_state)))
    blockers.push('Status źródłowy nie został dopuszczony do realizacji');
  if (yes(r.state.shipped) || yes(r.state.delivery) || yes(r.state.deleted) || raw.shipping_number)
    blockers.push('Zamówienie wysłane, dostarczone lub usunięte wymaga uzgodnienia');
  const cod = raw.module === 'ps_cashondelivery';
  if (psMicros(raw.total_wrapping_tax_incl) !== 0n)
    blockers.push('Opakowanie prezentowe wymaga osobnej pozycji rozliczenia');
  const details = rows.map((row: any) => {
    const d = r.details.find((v: any) => psId(v.id) === psId(row.id));
    ensure(
      d &&
        psId(d.id_order) === id &&
        psId(d.id_shop) === shop &&
        psId(d.product_id) === psId(row.product_id) &&
        psId(d.product_attribute_id, true) === psId(row.product_attribute_id, true) &&
        quantity(d.product_quantity) === quantity(row.product_quantity),
      422,
      'Pozycja nie należy do zamówienia lub została zmieniona',
    );
    for (const field of [
      'product_quantity_return',
      'product_quantity_refunded',
      'id_customization',
    ])
      ensure(/^\d+$/.test(String(d[field])), 422, 'Niekompletne dane zwrotu lub personalizacji');
    if (
      Number(d.product_quantity_return) ||
      Number(d.product_quantity_refunded) ||
      psMicros(d.total_refunded_tax_incl) > 0n
    )
      blockers.push('Zwrot lub refundacja w sklepie wymaga uzgodnienia');
    if (Number(d.id_customization))
      blockers.push('Personalizacja produktu wymaga osobnego procesu kompletacji');
    return d;
  });
  const mode = raw.round_mode === undefined ? 2 : Number(raw.round_mode);
  const money = (value: unknown) => psCents(value, mode);
  const total = money(raw.total_paid_tax_incl),
    products = money(raw.total_products_wt),
    discount = money(raw.total_discounts_tax_incl),
    shipping = money(raw.total_shipping_tax_incl);
  const weights = details.map((d: any) => psMicros(d.total_price_tax_incl));
  // Only rounding differences, never arbitrary fees, can be absorbed into line allocations.
  ensure(
    Math.abs(
      roundMicros(
        weights.reduce((s: bigint, v: bigint) => s + v, 0n),
        mode,
      ) - products,
    ) <= details.length,
    422,
    'Suma pozycji PrestaShop nie zgadza się z wartością produktów',
  );
  ensure(
    products + shipping + money(raw.total_wrapping_tax_incl) - discount === total,
    422,
    'Kwoty PrestaShop wymagają uzgodnienia',
  );
  let freeShipping = false;
  let rulesTotal = 0;
  for (const rule of r.cart_rules) {
    ensure(psId(rule.id_order) === id, 422, 'Rabat nie należy do zamówienia');
    ensure(!yes(rule.deleted), 422, 'Usunięty rabat wymaga uzgodnienia');
    for (const field of ['free_shipping', 'deleted'])
      ensure(
        ['0', '1', 0, 1, true, false].includes(rule[field]),
        422,
        'Niekompletna reguła rabatu PrestaShop',
      );
    rulesTotal += money(rule.value);
    freeShipping ||= yes(rule.free_shipping);
  }
  ensure(
    Math.abs(rulesTotal - discount) <= r.cart_rules.length,
    422,
    'Niekompletne rabaty PrestaShop',
  );
  const shippingDiscount = freeShipping ? Math.min(shipping, discount) : 0;
  const productDiscount = discount - shippingDiscount;
  ensure(productDiscount <= products, 422, 'Rabat przekracza wartość produktów');
  const amounts = allocatePs(products - productDiscount, weights);
  const paidAmount = money(raw.total_paid_real);
  // PrestaShop accumulates actual payments in order currency in total_paid_real.
  // An unpaid state may therefore legitimately contain a partial receipt.
  const paid = !cod && yes(r.state.paid) && paidAmount === total;
  if (paidAmount > total) blockers.push('Nadpłata w źródle wymaga uzgodnienia');
  if (cod && paidAmount > 0) blockers.push('Pobranie z wpłatą w źródle wymaga uzgodnienia');
  if (!cod && yes(r.state.paid) && !paid)
    blockers.push('Status opłacony bez pełnej kwoty płatności wymaga uzgodnienia');
  if (!cod && !yes(r.state.paid) && paidAmount > 0 && paidAmount >= total)
    blockers.push('Płatność bez zgodnego statusu wymaga uzgodnienia');
  return {
    external_id: id,
    currency: r.currency.iso_code,
    customer_name: [r.address.firstname, r.address.lastname].filter(Boolean).join(' '),
    email: r.customer.email,
    address: {
      street: [r.address.address1, r.address.address2].filter(Boolean).join(' '),
      city: r.address.city,
      postal_code: r.address.postcode,
      country: r.country.iso_code,
      phone: r.address.phone_mobile || r.address.phone || '',
    },
    shipping_cost: shipping - shippingDiscount,
    total,
    paid,
    payment_mode: cod ? 'cod' : 'prepaid',
    paid_amount: cod ? 0 : paidAmount,
    source_status: psId(raw.current_state),
    note: raw.note || '',
    blockers: [...new Set(blockers)],
    items: details.map((d: any, index: number) => ({
      ...(sourceLines ? { remote_line_id: psId(d.id) } : {}),
      external_id: `${psId(d.product_id)}:${psId(d.product_attribute_id, true)}`,
      name: d.product_name,
      sku: d.product_reference || '',
      quantity: quantity(d.product_quantity),
      line_total: amounts[index],
    })),
  };
}
