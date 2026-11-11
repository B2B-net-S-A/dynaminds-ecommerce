import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { decrypt } from './security';
import { ensure, Problem } from './errors';
export const SHOPIFY_CALLBACK = '/api/oauth/shopify/callback';
const secret = z
  .string()
  .min(16)
  .max(4096)
  .regex(/^[^\s\x00-\x1f\x7f]+$/);
export const shopifyClient = z.string().regex(/^[A-Za-z0-9_-]{6,128}$/);
export const shopifyConnectionCredentials = z
  .object({
    access_token: secret.optional(),
    client_id: shopifyClient.optional(),
    client_secret: secret.optional(),
  })
  .strict()
  .refine(
    (b) => !!b.access_token || (!!b.client_id && !!b.client_secret),
    'Wymagany token albo Client ID i sekret aplikacji',
  )
  .refine((b) => !!b.client_id === !!b.client_secret, 'Client ID i sekret muszą występować razem');
export function shopifyRedirect(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Problem(422, 'Nieprawidłowy lokalny callback Shopify');
  }
  ensure(
    ['http:', 'https:'].includes(u.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === SHOPIFY_CALLBACK,
    422,
    'Callback Shopify musi wskazywać lokalny serwer aplikacji',
  );
  return u.toString();
}
export const effectiveShopifyScopes = (scopes: string[]) =>
  [
    ...new Set(scopes.flatMap((s) => (s.startsWith('write_') ? [s, 'read_' + s.slice(6)] : [s]))),
  ].sort();
export const shopifyOAuthInput = z
  .object({
    confirm_same_account: z.boolean().default(false),
    products_write: z.boolean().default(false),
    inventory_write: z.boolean().default(false),
    publications_write: z.boolean().default(false),
    fulfillment_write: z.boolean().default(false),
    translations_write: z.boolean().default(false),
  })
  .strict();
export function shopifyRequestedScopes(b: z.infer<typeof shopifyOAuthInput>) {
  return [
    'read_orders',
    b.products_write ? 'write_products' : 'read_products',
    b.inventory_write ? 'write_inventory' : 'read_inventory',
    'read_locations',
    ...(b.publications_write ? ['write_publications'] : []),
    ...(b.fulfillment_write ? ['write_merchant_managed_fulfillment_orders'] : []),
    ...(b.translations_write ? ['write_translations', 'read_locales'] : []),
  ].sort();
}
export const shopifyGrantCredentials = (ch: any) => {
  const v = decrypt(ch.credentials);
  return v.oauth_grant_id
    ? {
        client_id: v.client_id,
        client_secret: v.client_secret,
        oauth_grant_id: v.oauth_grant_id,
        granted_scope: v.granted_scope,
      }
    : v;
};
// Keep manual-token fingerprints unchanged. Managed refresh rotates token bytes, never the grant ID.
export const shopifyCredentialIdentity = (ch: any) =>
  decrypt(ch.credentials).oauth_grant_id
    ? JSON.stringify(shopifyGrantCredentials(ch))
    : ch.credentials;
export const shopifyGrantHash = (ch: any) =>
  createHash('sha256').update(shopifyCredentialIdentity(ch)).digest('hex');
export const shopifyAccountHash = (store: string, client: string) =>
  createHash('sha256')
    .update(JSON.stringify([store, client]))
    .digest('hex');
export function shopifyCallbackParameters(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Problem(422, 'Nieprawidłowy powrót OAuth Shopify');
  }
  const params: Record<string, string> = {};
  ensure(u.search.length <= 8192, 422, 'Zbyt długi powrót OAuth Shopify');
  for (const [k, v] of u.searchParams) {
    ensure(
      /^[a-z_]{1,64}$/.test(k) &&
        !Object.hasOwn(params, k) &&
        v.length <= 4096 &&
        !/[\x00-\x1f\x7f]/.test(v),
      422,
      'Niejednoznaczne parametry powrotu Shopify',
    );
    params[k] = v;
  }
  ensure(
    /^[a-f0-9]{64}$/.test(params.state ?? '') &&
      /^[a-f0-9]{64}$/.test(params.hmac ?? '') &&
      /^\d{10,11}$/.test(params.timestamp ?? '') &&
      params.code &&
      params.code.length <= 2048,
    422,
    'Niekompletny powrót OAuth Shopify',
  );
  ensure(
    Math.abs(Date.now() / 1000 - Number(params.timestamp)) <= 600,
    422,
    'Powrót Shopify wygasł',
  );
  return { url: u, params };
}
export const shopifyOAuthHmac = (params: Record<string, string>, key: string) =>
  createHmac('sha256', key)
    .update(
      Object.entries(params)
        .filter(([k]) => k !== 'hmac')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('&'),
    )
    .digest('hex');
export function verifyShopifyHmac(params: Record<string, string>, key: string) {
  ensure(
    timingSafeEqual(
      Buffer.from(shopifyOAuthHmac(params, key), 'hex'),
      Buffer.from(params.hmac, 'hex'),
    ),
    403,
    'Nieprawidłowy podpis powrotu Shopify',
  );
}
