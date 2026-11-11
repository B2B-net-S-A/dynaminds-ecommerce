import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ensure } from './errors';
import type { Allegro } from './integrations';

export const allegroSettingsReadScope = 'allegro:api:sale:settings:read';
export const allegroCreationInput = z
  .object({
    product_id: z.uuid(),
    shipping_rate_id: z.uuid(),
    return_policy_id: z.uuid(),
    implied_warranty_id: z.uuid(),
    responsible_producer_id: z.uuid(),
    handling_time: z.enum([
      'PT0S',
      'PT24H',
      'P2D',
      'P3D',
      'P4D',
      'P5D',
      'P7D',
      'P10D',
      'P14D',
      'P21D',
      'P30D',
      'P60D',
    ]),
    safety_information: z.string().trim().min(1).max(5000),
    parameters: z
      .array(
        z
          .object({
            id: z.string().regex(/^[1-9]\d{0,14}$/),
            valuesIds: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
            values: z.array(z.string().trim().min(1).max(1000)).min(1).max(50).optional(),
            rangeValue: z
              .object({
                from: z.string().trim().min(1).max(100),
                to: z.string().trim().min(1).max(100),
              })
              .strict()
              .optional(),
          })
          .strict()
          .refine(
            (p) => [p.valuesIds, p.values, p.rangeValue].filter(Boolean).length === 1,
            'Wybierz jeden rodzaj wartości parametru',
          ),
      )
      .max(50)
      .default([]),
  })
  .strict();
export type AllegroCreationInput = z.infer<typeof allegroCreationInput>;
function canonical(v: any): any {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
const fingerprint = (v: any) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
export async function allegroCreationContext(client: Allegro, input: AllegroCreationInput) {
  const product = await client.catalogProduct(input.product_id);
  ensure(
    product.id === input.product_id && /^[1-9]\d{0,14}$/.test(product.category?.id),
    502,
    'Nieprawidłowy produkt katalogu Allegro',
  );
  const resources = [
    ['/sale/shipping-rates/', input.shipping_rate_id],
    ['/after-sales-service-conditions/return-policies/', input.return_policy_id],
    ['/after-sales-service-conditions/implied-warranties/', input.implied_warranty_id],
    ['/sale/responsible-producers/', input.responsible_producer_id],
  ];
  const selected = [];
  for (const [path, id] of resources) {
    const item = await client.creationResource(path, id);
    ensure(item?.id === id, 502, 'Allegro zwróciło inne ustawienie sprzedawcy');
    selected.push({ id: item.id, name: item.name ?? null, fingerprint: fingerprint(item) });
  }
  const definitions = await client.categoryOfferParameters(product.category.id);
  const values = new Map<string, any>(
    [...(product.parameters ?? []), ...input.parameters].map((p: any) => [p.id, p]),
  );
  ensure(
    new Set(input.parameters.map((p) => p.id)).size === input.parameters.length,
    422,
    'Parametry oferty nie mogą się powtarzać',
  );
  for (const def of definitions) {
    const item = input.parameters.find((p) => p.id === def.id);
    const conditional = def.requiredIf;
    const condition =
      conditional &&
      [...(conditional.parametersWithValue ?? []), ...(conditional.parametersWithoutValue ?? [])]
        .length > 0 &&
      (conditional.parametersWithValue ?? []).every((v: any) =>
        v.oneOfValueIds?.some((id: string) => values.get(v.id)?.valuesIds?.includes(id)),
      ) &&
      (conditional.parametersWithoutValue ?? []).every(
        (v: any) => !values.has(typeof v === 'string' ? v : v.id),
      );
    ensure(!(def.required || condition) || item, 422, 'Uzupełnij parametr oferty: ' + def.name);
    if (!item) continue;
    if (def.dictionary)
      ensure(
        item.valuesIds &&
          item.valuesIds.every((id) => def.dictionary.some((v: any) => v.id === id)),
        422,
        'Wybierz wartość słownikową: ' + def.name,
      );
    else if (def.restrictions?.range) {
      ensure(item.rangeValue, 422, 'Podaj zakres parametru: ' + def.name);
      const from = Number(item.rangeValue.from),
        to = Number(item.rangeValue.to);
      ensure(
        Number.isFinite(from) && Number.isFinite(to) && from <= to,
        422,
        'Nieprawidłowy zakres: ' + def.name,
      );
    } else ensure(item.values && !item.valuesIds, 422, 'Podaj wartość parametru: ' + def.name);
    const count = (item.valuesIds ?? item.values ?? []).length;
    ensure(
      item.rangeValue ||
        (def.restrictions?.multipleChoices
          ? true
          : count <= (def.restrictions?.allowedNumberOfValues ?? 1)),
      422,
      'Parametr wymaga jednej wartości: ' + def.name,
    );
    const numeric = item.rangeValue ? [item.rangeValue.from, item.rangeValue.to] : item.values;
    if (['integer', 'float'].includes(def.type) && numeric)
      ensure(
        numeric.every(
          (v) =>
            /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) &&
            Number.isFinite(Number(v)) &&
            (def.type !== 'integer' || Number.isInteger(Number(v))) &&
            (def.restrictions?.precision === undefined ||
              (v.split('.')[1]?.length ?? 0) <= def.restrictions.precision) &&
            (def.restrictions?.min === undefined || Number(v) >= def.restrictions.min) &&
            (def.restrictions?.max === undefined || Number(v) <= def.restrictions.max),
        ),
        422,
        'Wartość poza zakresem parametru: ' + def.name,
      );
    if (def.type === 'string' && item.values)
      ensure(
        item.values.every(
          (v) =>
            v.length >= (def.restrictions?.minLength ?? 0) &&
            v.length <= (def.restrictions?.maxLength ?? 1000),
        ),
        422,
        'Długość wartości parametru: ' + def.name,
      );
  }
  ensure(
    input.parameters.every((p) => definitions.some((d: any) => d.id === p.id)),
    422,
    'Parametr nie należy do wybranej kategorii oferty',
  );
  return {
    product: {
      id: product.id,
      name: product.name,
      category_id: product.category.id,
      fingerprint: fingerprint(product),
    },
    selected,
    definitions,
  };
}
export function allegroDraftPayload(
  input: AllegroCreationInput,
  p: any,
  quantity: number,
  currency: string,
  planId: string,
) {
  ensure(
    ['simple', 'variant'].includes(p.kind),
    422,
    'Oferta katalogowa Allegro wymaga pojedynczego produktu lub wariantu',
  );
  ensure(currency === 'PLN', 422, 'Nowa oferta Allegro PL wymaga cennika PLN');
  ensure(p.price > 0, 422, 'Oferta wymaga dodatniej ceny');
  ensure(
    p.name.length >= 12 && p.name.length <= 75 && p.name.trim().split(/\s+/).length >= 3,
    422,
    'Tytuł Allegro wymaga 12–75 znaków i co najmniej trzech słów',
  );
  return {
    name: p.name,
    language: 'pl-PL',
    external: { id: 'dyna-' + planId },
    productSet: [
      {
        product: { id: input.product_id },
        responsibleProducer: { type: 'ID', id: input.responsible_producer_id },
        safetyInformation: { type: 'TEXT', description: input.safety_information },
      },
    ],
    parameters: input.parameters,
    sellingMode: { format: 'BUY_NOW', price: { amount: (p.price / 100).toFixed(2), currency } },
    stock: { available: quantity, unit: 'UNIT' },
    publication: { status: 'INACTIVE' },
    delivery: { shippingRates: { id: input.shipping_rate_id }, handlingTime: input.handling_time },
    afterSalesServices: {
      returnPolicy: { id: input.return_policy_id },
      impliedWarranty: { id: input.implied_warranty_id },
    },
  };
}
export function allegroCreatedMatches(plan: any, r: any) {
  const p = plan.payload,
    expected = p.productSet[0],
    actual = r.productSet?.[0];
  return (
    r.external?.id === p.external.id &&
    r.name === p.name &&
    r.productSet?.length === 1 &&
    actual?.product?.id === expected.product.id &&
    actual?.responsibleProducer?.id === expected.responsibleProducer.id &&
    actual?.safetyInformation?.type === 'TEXT' &&
    actual.safetyInformation.description === expected.safetyInformation.description &&
    r.delivery?.shippingRates?.id === p.delivery.shippingRates.id &&
    r.delivery?.handlingTime === p.delivery.handlingTime &&
    r.afterSalesServices?.returnPolicy?.id === p.afterSalesServices.returnPolicy.id &&
    r.afterSalesServices?.impliedWarranty?.id === p.afterSalesServices.impliedWarranty.id &&
    p.parameters.every((item: any) =>
      r.parameters?.some(
        (actual: any) =>
          actual.id === item.id &&
          (item.rangeValue
            ? actual.rangeValue?.from === item.rangeValue.from &&
              actual.rangeValue?.to === item.rangeValue.to
            : JSON.stringify([...(actual.valuesIds ?? actual.values ?? [])].sort()) ===
              JSON.stringify([...(item.valuesIds ?? item.values ?? [])].sort())),
      ),
    )
  );
}
