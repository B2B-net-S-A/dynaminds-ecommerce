import { createHash } from 'node:crypto';
import { ensure } from './errors';
import type { OrderFieldMapping } from './order-field-mappings-schema';
import type { OrderFieldChange } from './order-fields-schema';
import { decrypt } from './security';
import { shopifyCredentialIdentity } from './shopify-auth-input';
export const mappingHash = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, v[k]]),
            )
          : v,
      ),
    )
    .digest('hex');
export const mappingSourceKinds = {
  woocommerce: ['woo_customer_note', 'woo_meta'],
  allegro: ['allegro_message_to_seller', 'allegro_buyer_login', 'allegro_delivery_method_name'],
  shopify: ['shopify_note', 'shopify_name'],
} as const;
export function orderFieldMappingConnectionHash(ch: any, binding?: any) {
  const common = { provider: ch.provider, mode: ch.mode, simulation: !!ch.settings.simulation };
  if (ch.provider === 'allegro' && !ch.settings.simulation) {
    ensure(
      ch.settings.oauth_connection_id && ch.status === 'authorized_read',
      409,
      'Połącz kanał Allegro przez aktualny OAuth',
    );
    return mappingHash({
      ...common,
      epoch: ch.settings.oauth_connection_id,
      scope: [...(ch.oauth_scopes ?? [])].sort(),
    });
  }
  return mappingHash({
    ...common,
    settings: ch.settings,
    identity: ch.provider === 'shopify' ? shopifyCredentialIdentity(ch) : ch.credentials,
    ...(ch.provider === 'shopify'
      ? { shop_id: binding?.shop_id ?? null, grant_id: binding?.grant_id ?? null }
      : {}),
  });
}
export type MappingSourceValue = {
  field_id: string;
  source: OrderFieldMapping['source'];
  status: 'present' | 'missing' | 'invalid';
  value?: string | string[];
  issue?: { code: string; message: string };
};
function literal(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.from(value).toString('utf8') === value &&
    !value.includes('\0') &&
    [...value].length <= 4000 &&
    Buffer.byteLength(value) <= 16384
  );
}
export function captureOrderFieldMappingSources(
  provider: string,
  raw: any,
  mappings: OrderFieldMapping[],
): MappingSourceValue[] {
  return mappings.map((m) => {
    const v: MappingSourceValue = { field_id: m.field_id, source: m.source, status: 'missing' };
    if (!(mappingSourceKinds as any)[provider]?.includes(m.source.kind))
      return {
        ...v,
        status: 'invalid',
        issue: { code: 'source_unsupported', message: 'Źródło nie jest obsługiwane przez adapter' },
      };
    let value: unknown;
    if (m.source.kind === 'woo_meta') {
      if (raw.meta_data !== undefined && !Array.isArray(raw.meta_data))
        return {
          ...v,
          status: 'invalid',
          issue: { code: 'metadata_invalid', message: 'Niepoprawna lista metadata' },
        };
      const matched = (raw.meta_data ?? []).filter((x: any) => x?.key === (m.source as any).key);
      if (matched.length > 1)
        return {
          ...v,
          status: 'invalid',
          issue: { code: 'metadata_duplicate', message: 'Powtórzony dokładny klucz metadata' },
        };
      value = matched[0]?.value;
    } else if (m.source.kind === 'woo_customer_note') value = raw.customer_note;
    else if (m.source.kind === 'allegro_message_to_seller') value = raw.messageToSeller;
    else if (m.source.kind === 'allegro_buyer_login') value = raw.buyer?.login;
    else if (m.source.kind === 'allegro_delivery_method_name') value = raw.delivery?.method?.name;
    else if (m.source.kind === 'shopify_note') value = raw.note;
    else value = raw.name;
    if (value === undefined || value === null) return v;
    if (literal(value) || (Array.isArray(value) && value.length <= 50 && value.every(literal)))
      return { ...v, status: 'present', value };
    return {
      ...v,
      status: 'invalid',
      issue: {
        code: 'source_value_invalid',
        message: 'Źródło wymaga bounded literalnego string lub string array',
      },
    };
  });
}
export function convertOrderFieldMappingSources(
  mappings: OrderFieldMapping[],
  sources: MappingSourceValue[],
) {
  const changes: OrderFieldChange[] = [],
    skipped: { field_id: string; reason: string }[] = [],
    issues: { code: string; message: string }[] = [];
  for (const m of mappings) {
    const source = sources.find((s) => s.field_id === m.field_id);
    if (!source || source.status === 'missing') {
      if (m.on_missing === 'error')
        issues.push({ code: 'source_missing', message: 'Brak wymaganego źródła mapowania' });
      else skipped.push({ field_id: m.field_id, reason: 'source_missing' });
      continue;
    }
    if (source.status === 'invalid') {
      issues.push(source.issue!);
      continue;
    }
    let value: unknown = source.value;
    if (m.conversion.kind === 'direct') {
      if (typeof value !== 'string') {
        issues.push({
          code: 'source_type_invalid',
          message: 'Bezpośrednie mapowanie wymaga string',
        });
        continue;
      }
    } else {
      const codes =
        m.conversion.input === 'array' ? value : typeof value === 'string' ? [value] : null;
      if (
        !Array.isArray(codes) ||
        !codes.every((c) => typeof c === 'string') ||
        new Set(codes).size !== codes.length
      ) {
        issues.push({ code: 'source_type_invalid', message: 'Niepoprawny zakres kodów słownika' });
        continue;
      }
      const dict = new Map(m.conversion.codes.map((c) => [c.code, c.option_id]));
      if (!codes.every((c) => dict.has(c))) {
        issues.push({ code: 'source_code_missing', message: 'Kod nie ma jawnej opcji docelowej' });
        continue;
      }
      const ids = codes.map((c) => dict.get(c)!);
      if (new Set(ids).size !== ids.length) {
        issues.push({ code: 'source_code_duplicate', message: 'Powtórzona opcja docelowa' });
        continue;
      }
      value = m.type === 'multi_select' ? ids.sort() : ids[0];
    }
    changes.push({
      field_id: m.field_id,
      definition_version: m.definition_version,
      type: m.type,
      value,
    } as OrderFieldChange);
  }
  return { changes, skipped, issues };
}
