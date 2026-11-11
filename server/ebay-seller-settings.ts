import { z } from 'zod';
import { Ebay, ebayBase, ebayJson, ebaySecret, EBAY_TRADING_SCOPE } from './ebay';
import { EbayApiWait } from './ebay-api-limits';
import { ebayInventoryPage } from './ebay-inventory';
import { ensure, Problem } from './errors';
import type { EbayCreationInput } from './ebay-creation';
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const categoryId = z.string().regex(/^[1-9]\d{0,14}$/);
const treeId = z.string().regex(/^\d{1,10}$/);
const policyKinds = ['payment', 'return', 'fulfillment'] as const;
const policyList = (kind: string) => kind + 'Policies';
const policyKey = (kind: string) => kind + 'PolicyId';
function policy(value: any, kind: string, market: string, selected?: string) {
  ensure(
    value &&
      identifier.safeParse(value[policyKey(kind)]).success &&
      value.marketplaceId === market &&
      (!selected || value[policyKey(kind)] === selected) &&
      typeof value.name === 'string' &&
      value.name.length > 0 &&
      value.name.length <= 200,
    502,
    'Niepełne lub obce warunki eBay',
  );
  ensure(
    Array.isArray(value.categoryTypes) &&
      value.categoryTypes.length > 0 &&
      value.categoryTypes.length <= 10 &&
      value.categoryTypes.every((x: any) => typeof x.name === 'string'),
    502,
    'Brak rodzaju kategorii w warunkach eBay',
  );
  return value;
}
const eligible = (p: any) =>
  p.categoryTypes.some((x: any) => x.name === 'ALL_EXCLUDING_MOTORS_VEHICLES');
export async function ebayTaxonomyClient(user: Ebay, fence = async () => {}) {
  const c = z
    .object({ client_id: ebaySecret.regex(/^[^:]+$/), client_secret: ebaySecret })
    .parse(user.credentials);
  await fence();
  const response = await user
    .transport(ebayBase(user.mode) + '/identity/v1/oauth2/token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization:
          'Basic ' + Buffer.from(c.client_id + ':' + c.client_secret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: EBAY_TRADING_SCOPE,
      }).toString(),
    })
    .catch((e) => {
      if (e instanceof EbayApiWait) throw e;
      throw new Problem(502, 'Brak odpowiedzi OAuth aplikacji eBay');
    });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Problem(
      response.status === 401 ? 401 : 502,
      'OAuth aplikacji eBay: HTTP ' + response.status,
    );
  }
  const parsed = z
    .object({
      access_token: ebaySecret,
      expires_in: z.number().int().min(1).max(86400),
      token_type: z
        .string()
        .refine((v) => ['bearer', 'application access token'].includes(v.toLowerCase())),
      scope: z.string().optional(),
    })
    .safeParse(await ebayJson(response, 64 * 1024));
  ensure(parsed.success, 502, 'Nieprawidłowa odpowiedź OAuth aplikacji eBay');
  ensure(
    parsed.data.scope === undefined || parsed.data.scope.split(' ').includes(EBAY_TRADING_SCOPE),
    401,
    'OAuth aplikacji nie potwierdziło wymaganego zakresu eBay',
  );
  await fence();
  // Application token is confined to this read; it never replaces the seller's cached token.
  return new Ebay(user.mode, { access_token: parsed.data.access_token }, user.transport);
}
// Analytics getRateLimits uses the same application-token grant and base scope.
// Keep the existing Taxonomy export and seller-token behavior unchanged.
export const ebayApplicationClient = ebayTaxonomyClient;
async function defaultTree(client: Ebay, market: string, fence: () => Promise<void>) {
  const tree = await client.request(
    'get_default_category_tree_id?' + new URLSearchParams({ marketplace_id: market }),
    fence,
    'taxonomy',
  );
  ensure(
    treeId.safeParse(tree.categoryTreeId).success &&
      typeof tree.categoryTreeVersion === 'string' &&
      tree.categoryTreeVersion.length <= 100,
    502,
    'Brak drzewa kategorii eBay',
  );
  return tree;
}
export async function readEbaySellerOptions(
  client: Ebay,
  market: string,
  language: string,
  fence = async () => {},
) {
  const locations: any[] = [];
  let offset = 0,
    total: number | undefined;
  for (let n = 0; n < 10; n++) {
    const page = await ebayInventoryPage(client, 'location', 'locations', offset, {}, fence);
    ensure(
      total === undefined || total === page.total,
      409,
      'Lista lokalizacji eBay zmieniła się podczas odczytu',
    );
    total = page.total;
    ensure(page.total <= 250, 422, 'Przekroczono limit 250 lokalizacji eBay');
    locations.push(...page.rows);
    if (page.next === null) {
      ensure(locations.length === total, 502, 'Niepełna lista lokalizacji eBay');
      break;
    }
    ensure(n < 9, 422, 'Przekroczono limit stron lokalizacji eBay');
    offset = page.next;
  }
  ensure(
    new Set(locations.map((v) => v.merchantLocationKey)).size === locations.length &&
      locations.every(
        (v) =>
          typeof v.merchantLocationKey === 'string' &&
          v.merchantLocationKey.length > 0 &&
          v.merchantLocationKey.length <= 36 &&
          typeof v.merchantLocationStatus === 'string',
      ),
    502,
    'Nieprawidłowe lokalizacje eBay',
  );
  const policies: any = {};
  for (const kind of policyKinds) {
    const raw = await client.request(
      kind + '_policy?' + new URLSearchParams({ marketplace_id: market }),
      fence,
      'account',
      language,
    );
    const rows = raw[policyList(kind)] ?? (raw.total === 0 ? [] : undefined);
    ensure(
      Number.isSafeInteger(raw.total) &&
        raw.total >= 0 &&
        raw.total <= 1000 &&
        Array.isArray(rows) &&
        rows.length === raw.total &&
        !raw.next,
      502,
      'Niepełna lista warunków eBay',
    );
    rows.forEach((v: any) => policy(v, kind, market));
    ensure(
      new Set(rows.map((v: any) => v[policyKey(kind)])).size === rows.length,
      502,
      'Powtórzone ID warunków eBay',
    );
    policies[kind] = rows.map((v: any) => ({
      id: v[policyKey(kind)],
      name: v.name,
      eligible: eligible(v),
    }));
  }
  return {
    marketplace: market,
    language,
    locations: locations.map((v) => ({
      key: v.merchantLocationKey,
      name: v.name ?? v.merchantLocationKey,
      status: v.merchantLocationStatus,
      address: v.location?.address ?? null,
    })),
    policies,
  };
}
export async function readEbayCategorySuggestions(
  user: Ebay,
  market: string,
  phrase: string,
  fence = async () => {},
) {
  const client = await ebayTaxonomyClient(user, fence),
    tree = await defaultTree(client, market, fence);
  const raw = await client.request(
    'category_tree/' +
      tree.categoryTreeId +
      '/get_category_suggestions?' +
      new URLSearchParams({ q: phrase }),
    fence,
    'taxonomy',
  );
  ensure(
    raw.categoryTreeId === tree.categoryTreeId &&
      raw.categoryTreeVersion === tree.categoryTreeVersion &&
      Array.isArray(raw.categorySuggestions) &&
      raw.categorySuggestions.length <= 100,
    502,
    'Niepełne lub zmienione sugestie kategorii eBay',
  );
  const data = raw.categorySuggestions.map((v: any) => {
    ensure(
      categoryId.safeParse(v.category?.categoryId).success &&
        typeof v.category?.categoryName === 'string' &&
        v.category.categoryName.length <= 200 &&
        Array.isArray(v.categoryTreeNodeAncestors ?? []),
      502,
      'Nieprawidłowa sugestia kategorii eBay',
    );
    const ancestors = v.categoryTreeNodeAncestors ?? [];
    ensure(
      ancestors.length <= 30 &&
        ancestors.every(
          (a: any) =>
            typeof a.categoryName === 'string' &&
            a.categoryName.length <= 200 &&
            Number.isSafeInteger(a.categoryTreeNodeLevel),
        ),
      502,
      'Niepełna ścieżka kategorii eBay',
    );
    return {
      id: v.category.categoryId,
      name: v.category.categoryName,
      path: ancestors
        .toSorted((a: any, b: any) => a.categoryTreeNodeLevel - b.categoryTreeNodeLevel)
        .map((a: any) => a.categoryName)
        .concat(v.category.categoryName)
        .join(' / '),
    };
  });
  ensure(
    new Set(data.map((v: any) => v.id)).size === data.length,
    502,
    'Powtórzone kategorie eBay',
  );
  return { marketplace: market, tree, data };
}
export async function readEbayCategory(
  user: Ebay,
  market: string,
  id: string,
  fence = async () => {},
) {
  categoryId.parse(id);
  const client = await ebayTaxonomyClient(user, fence),
    tree = await defaultTree(client, market, fence);
  const raw = await client.request(
      'category_tree/' +
        tree.categoryTreeId +
        '/get_category_subtree?' +
        new URLSearchParams({ category_id: id }),
      fence,
      'taxonomy',
    ),
    node = raw.categorySubtreeNode;
  ensure(
    raw.categoryTreeId === tree.categoryTreeId &&
      raw.categoryTreeVersion === tree.categoryTreeVersion &&
      node?.category?.categoryId === id &&
      typeof node.category.categoryName === 'string',
    502,
    'Niepełna lub zmieniona kategoria eBay',
  );
  ensure(
    node.leafCategoryTreeNode === true && !node.childCategoryTreeNodes?.length,
    422,
    'Wybierz końcową kategorię eBay',
  );
  const result = await client.request(
    'category_tree/' +
      tree.categoryTreeId +
      '/get_item_aspects_for_category?' +
      new URLSearchParams({ category_id: id }),
    fence,
    'taxonomy',
  );
  ensure(
    Array.isArray(result.aspects) && result.aspects.length <= 300,
    502,
    'Niepełne parametry kategorii eBay',
  );
  const aspects = result.aspects;
  ensure(
    new Set(aspects.map((a: any) => a.localizedAspectName)).size === aspects.length,
    502,
    'Powtórzone parametry kategorii eBay',
  );
  for (const a of aspects) {
    const c = a.aspectConstraint;
    ensure(
      typeof a.localizedAspectName === 'string' &&
        a.localizedAspectName.length > 0 &&
        a.localizedAspectName.length <= 40 &&
        c &&
        typeof c.aspectRequired === 'boolean' &&
        ['FREE_TEXT', 'SELECTION_ONLY'].includes(c.aspectMode) &&
        ['SINGLE', 'MULTI'].includes(c.itemToAspectCardinality),
      502,
      'Niepełny parametr kategorii eBay',
    );
    ensure(
      c.aspectMaxLength === undefined ||
        (Number.isSafeInteger(c.aspectMaxLength) && c.aspectMaxLength > 0),
      502,
      'Nieprawidłowa długość parametru eBay',
    );
    ensure(
      Array.isArray(a.aspectValues ?? []) && (a.aspectValues ?? []).length <= 10000,
      502,
      'Niepełny słownik parametru eBay',
    );
    for (const v of a.aspectValues ?? []) {
      ensure(
        typeof v.localizedValue === 'string' &&
          v.localizedValue.length > 0 &&
          v.localizedValue.length <= 1000 &&
          Array.isArray(v.valueConstraints ?? []) &&
          (v.valueConstraints ?? []).length <= 50,
        502,
        'Nieprawidłowa wartość parametru eBay',
      );
      for (const d of v.valueConstraints ?? [])
        ensure(
          typeof d.applicableForLocalizedAspectName === 'string' &&
            Array.isArray(d.applicableForLocalizedAspectValues) &&
            d.applicableForLocalizedAspectValues.length > 0 &&
            d.applicableForLocalizedAspectValues.every((x: any) => typeof x === 'string'),
          502,
          'Niepełna zależność wartości eBay',
        );
    }
  }
  return { marketplace: market, tree, category: node.category, aspects };
}
export function validateEbayAspects(metadata: any, aspects: Record<string, string[]>) {
  for (const [name, values] of Object.entries(aspects))
    ensure(
      metadata.aspects.some((a: any) => a.localizedAspectName === name) &&
        Array.isArray(values) &&
        values.length > 0 &&
        new Set(values).size === values.length,
      422,
      'Parametr nie należy do kategorii lub zawiera duplikaty: ' + name,
    );
  for (const a of metadata.aspects) {
    const name = a.localizedAspectName,
      c = a.aspectConstraint,
      values = aspects[name] ?? [];
    ensure(
      !c.aspectRequired || values.length > 0,
      422,
      'Uzupełnij wymagany parametr eBay: ' + name,
    );
    ensure(
      c.itemToAspectCardinality === 'MULTI' || values.length <= 1,
      422,
      'Parametr eBay przyjmuje jedną wartość: ' + name,
    );
    for (const value of values) {
      ensure(
        value.length <= Math.min(50, c.aspectMaxLength ?? 50),
        422,
        'Wartość parametru eBay jest za długa: ' + name,
      );
      const selected = (a.aspectValues ?? []).find((v: any) => v.localizedValue === value);
      ensure(
        c.aspectMode !== 'SELECTION_ONLY' || selected,
        422,
        'Wybierz wartość ze słownika eBay: ' + name,
      );
      if (selected?.valueConstraints?.length)
        ensure(
          selected.valueConstraints.some((d: any) =>
            (aspects[d.applicableForLocalizedAspectName] ?? []).some((v) =>
              d.applicableForLocalizedAspectValues.includes(v),
            ),
          ),
          422,
          'Wartość nie pasuje do zależnego parametru eBay: ' + name,
        );
    }
  }
}
export async function readEbayDraftRequirements(
  client: Ebay,
  cfg: EbayCreationInput,
  market: string,
  fence = async () => {},
) {
  const policies: any = {};
  for (const kind of policyKinds) {
    const id = cfg[(kind + '_policy_id') as keyof EbayCreationInput] as string;
    policies[kind] = policy(
      await client.request(
        kind + '_policy/' + encodeURIComponent(id),
        fence,
        'account',
        cfg.content_language,
      ),
      kind,
      market,
      id,
    );
    ensure(
      eligible(policies[kind]),
      422,
      'Wybrane warunki eBay dotyczą pojazdów; wybierz warunki dla pozostałych kategorii',
    );
  }
  const category = await readEbayCategory(client, market, cfg.category_id, fence);
  return { policies, category };
}
export function demoEbaySellerOptions(market: string, language: string) {
  return {
    marketplace: market,
    language,
    locations: [
      {
        key: 'DEMO-LOCATION-069',
        name: 'Magazyn DEMO eBay',
        status: 'ENABLED',
        address: { country: 'PL', postalCode: '00-001' },
      },
      {
        key: 'DEMO-LOCATION-DISABLED',
        name: 'Wyłączony magazyn DEMO',
        status: 'DISABLED',
        address: { country: 'PL', postalCode: '00-001' },
      },
    ],
    policies: Object.fromEntries(
      policyKinds.map((kind) => [
        kind,
        [
          {
            id: 'DEMO-' + kind.toUpperCase() + '-069',
            name:
              kind === 'payment'
                ? 'Płatność DEMO'
                : kind === 'return'
                  ? 'Zwrot DEMO 30 dni'
                  : 'Dostawa DEMO Polska',
            eligible: true,
          },
        ],
      ]),
    ),
  };
}
export function demoEbayCategory(market: string, id = '123') {
  ensure(id === '123', 404, 'Nie znaleziono kategorii w lokalnym przykładzie');
  return {
    marketplace: market,
    tree: { categoryTreeId: '0', categoryTreeVersion: 'DEMO-069' },
    category: { categoryId: id, categoryName: 'Akcesoria DEMO' },
    aspects: [
      {
        localizedAspectName: 'Marka',
        aspectConstraint: {
          aspectRequired: true,
          aspectMode: 'FREE_TEXT',
          itemToAspectCardinality: 'SINGLE',
        },
      },
      {
        localizedAspectName: 'Kolor',
        aspectConstraint: {
          aspectRequired: true,
          aspectMode: 'SELECTION_ONLY',
          itemToAspectCardinality: 'SINGLE',
        },
        aspectValues: [{ localizedValue: 'Czarny' }, { localizedValue: 'Biały' }],
      },
    ],
  };
}
export function demoEbayRequirements(cfg: EbayCreationInput, market: string) {
  const opts = demoEbaySellerOptions(market, cfg.content_language),
    policies: any = {};
  ensure(
    opts.locations.some((v) => v.key === cfg.merchant_location_key && v.status === 'ENABLED'),
    422,
    'Wybierz lokalizację DEMO z listy',
  );
  for (const kind of policyKinds) {
    const v = opts.policies[kind].find(
      (v: any) => v.id === cfg[(kind + '_policy_id') as keyof EbayCreationInput],
    );
    ensure(v, 422, 'Wybierz warunki DEMO z listy');
    policies[kind] = {
      [policyKey(kind)]: v.id,
      name: v.name,
      marketplaceId: market,
      categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }],
    };
  }
  return { policies, category: demoEbayCategory(market, cfg.category_id) };
}
