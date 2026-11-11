/** Preparatory pure core. No persistence, public access policy, CAS or shipment authority. */
export type DeliveryKind166 = 'address' | 'pickup_point' | 'unknown';
export type BuyerDeliveryAddress166 = Readonly<{
  recipient_name: string;
  street: string;
  city: string;
  postal_code: string;
  country: string;
  phone: string;
}>;
export type OriginalDeliverySource166 = {
  customer_name: string;
  address: {
    street: string;
    city: string;
    postal_code: string;
    country: string;
    phone: string;
    locker_code?: string;
    /** Delivery recipient edited on the order card (Uwagi v3 §6); customer_name when absent. */
    recipient?: string;
  };
};
export type EffectiveDelivery166 =
  | { kind: 'address'; origin: 'original' | 'override'; delivery: BuyerDeliveryAddress166; reason: null }
  | { kind: 'pickup_point' | 'unknown'; origin: null; delivery: null;
      reason: 'pickup_point_delivery' | 'delivery_kind_unknown' };

export class BuyerDeliveryAddressError166 extends Error {
  constructor(public readonly code: string, public readonly field: string | null = null) {
    // Never place the address, telephone, token or submitted value in error text.
    super(`Niepoprawny adres dostawy: ${code}${field ? ` (${field})` : ''}`);
    this.name = 'BuyerDeliveryAddressError166';
  }
}
const fail = (code: string, field: string | null = null): never => {
  throw new BuyerDeliveryAddressError166(code, field);
};
const fields = ['recipient_name', 'street', 'city', 'postal_code', 'country', 'phone'] as const;
// ISO 3166-1 alpha-2; no guessed aliases such as UK or an arbitrary uppercase pair.
const countries = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

function kind(input: unknown): DeliveryKind166 {
  if (input !== 'address' && input !== 'pickup_point' && input !== 'unknown')
    return fail('delivery_kind_invalid');
  return input;
}
function record(input: unknown, field: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    return fail('object_required', field);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== 'string' || !('value' in descriptor) || !descriptor.enumerable)
      return fail('plain_data_required', field);
  }
  return input as Record<string, unknown>;
}
function text(input: unknown, field: string, min: number, max: number, trim: boolean): string {
  if (typeof input !== 'string') return fail('text_required', field);
  // Test raw input before trim, so newline/tab cannot disappear through normalization.
  if (/[\p{Cc}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(input))
    return fail('invalid_unicode_or_control', field);
  const value = trim ? input.trim() : input;
  const length = Array.from(value).length;
  if (length < min || length > max) return fail('text_length', field);
  return value;
}
function country(input: unknown, field: string): string {
  const value = text(input, field, 2, 2, false);
  if (!countries.has(value)) return fail('country_invalid', field);
  return value;
}

/** Validate a NEW correction; normalization is explicit trim, never telephone/country guessing. */
export function validateBuyerDeliveryAddress166(
  input: unknown,
  basis: { originalCountry: string; deliveryKind: DeliveryKind166 },
): BuyerDeliveryAddress166 {
  const deliveryKind = kind(basis.deliveryKind);
  if (deliveryKind !== 'address')
    return fail(deliveryKind === 'pickup_point' ? 'pickup_point_delivery' : 'delivery_kind_unknown');
  const originalCountry = country(basis.originalCountry, 'original_country');
  const value = record(input, 'delivery');
  if (Object.keys(value).length !== fields.length || fields.some((f) => !(f in value)) ||
      Object.keys(value).some((f) => !(fields as readonly string[]).includes(f)))
    return fail('delivery_fields');
  const result = {
    recipient_name: text(value.recipient_name, 'recipient_name', 2, 200, true),
    street: text(value.street, 'street', 3, 200, true),
    city: text(value.city, 'city', 2, 100, true),
    postal_code: text(value.postal_code, 'postal_code', 1, 20, true),
    country: country(value.country, 'country'),
    phone: text(value.phone, 'phone', 9, 16, true),
  };
  if (result.country !== originalCountry) return fail('country_change_not_supported', 'country');
  if (result.country === 'PL' && !/^[0-9]{2}-[0-9]{3}$/.test(result.postal_code))
    return fail('postal_code_invalid', 'postal_code');
  if (!/^\+[1-9][0-9]{7,14}$/.test(result.phone)) return fail('phone_e164_required', 'phone');
  return Object.freeze(result);
}

/**
 * Read operational delivery only. Caller supplies the actual verified sidecar value and canonical
 * delivery kind. Never derive kind from a shipping-method label or reinterpret billing data.
 * Historical fallback preserves original bytes (including a noncanonical telephone) for review;
 * it is not an assertion that the source address is eligible for a carrier or a new write.
 */
export function effectiveDelivery166(input: {
  original: OriginalDeliverySource166;
  sidecarOverride: unknown | null;
  deliveryKind: DeliveryKind166;
}): EffectiveDelivery166 {
  const deliveryKind = kind(input.deliveryKind);
  if (deliveryKind !== 'address') return {
    kind: deliveryKind, origin: null, delivery: null,
    reason: deliveryKind === 'pickup_point' ? 'pickup_point_delivery' : 'delivery_kind_unknown',
  };
  const source = record(input.original, 'original');
  const address = record(source.address, 'original_address');
  // Explicit contradictory point evidence must not be silently treated as address delivery.
  if (address.locker_code !== undefined && address.locker_code !== '')
    return fail('pickup_point_delivery');
  if (input.sidecarOverride !== null) return {
    kind: 'address', origin: 'override', reason: null,
    delivery: validateBuyerDeliveryAddress166(input.sidecarOverride, {
      originalCountry: country(address.country, 'original_country'), deliveryKind,
    }),
  };
  return {
    kind: 'address', origin: 'original', reason: null,
    delivery: Object.freeze({
      recipient_name: typeof address.recipient === 'string' && address.recipient.trim()
        ? text(address.recipient, 'recipient_name', 0, 200, false)
        : text(source.customer_name, 'recipient_name', 0, 200, false),
      street: text(address.street, 'street', 0, 200, false),
      city: text(address.city, 'city', 0, 100, false),
      postal_code: text(address.postal_code, 'postal_code', 0, 20, false),
      country: country(address.country, 'original_country'),
      phone: text(address.phone, 'phone', 0, 30, false),
    }),
  };
}
