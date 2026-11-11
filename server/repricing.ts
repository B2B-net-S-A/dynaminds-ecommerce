import { z } from 'zod';
import type { PoolClient } from 'pg';
import { ensure } from './errors';
import {shopifyCollectionDefinition} from './competitor-shopify-schedule';
import { currencies } from './pricing';
import {
  costInListCurrency, convertMinor, ratesFor, roundPrice, walkBaseChain,
  REPRICING_RATE_AGE_DAYS, type RepricingFx, type RepricingRate, type RepricingRounding,
} from './repricing-rules';
import { activeOverrides, applyRepricingOverride } from './repricing-overrides';

const amount = z.number().int().min(0).max(100000000);
export const repricingConfig = z
  .object({
    enabled: z.boolean().default(true),
    strategy: z.enum(['cost_margin', 'competitor', 'competitor_rank']).default('cost_margin'),
    min_margin_bps: z.number().int().min(0).max(9000).default(1000),
    target_margin_bps: z.number().int().min(0).max(9000).default(2000),
    fee_bps: z.number().int().min(0).max(5000).default(0),
    fixed_net_cost: amount.default(0),
    min_price: amount.default(0),
    max_price: amount.default(100000000),
    undercut_amount: amount.default(1),
    observation_minutes: z.number().int().min(1).max(10080).default(60),
    direction: z.enum(['both', 'down', 'up']).default('both'),
    ending: z.union([z.literal(99), z.null()]).default(null),
    // S9 (optional, so stored rules keep their exact config): price step with an ending in
    // grosze, net cost currency converted with NBP table A rates, and a base price list.
    rounding: z
      .object({
        step: z.union([z.literal(5), z.literal(10), z.literal(50), z.literal(100), z.literal(500), z.literal(1000)]),
        ending: z.number().int().min(0).max(999),
      })
      .strict()
      .refine((r) => r.ending < r.step, 'Końcówka musi być mniejsza od kroku zaokrąglenia')
      .optional(),
    cost_currency: currencies.optional(),
    max_rate_age_days: z.number().int().min(1).max(31).optional(),
    base_price_list_id: z.uuid().optional(),
    shopify_collection: shopifyCollectionDefinition.optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.min_margin_bps <= b.target_margin_bps &&
      b.target_margin_bps + b.fee_bps < 10000 &&
      b.min_price <= b.max_price &&
      (!b.shopify_collection||b.shopify_collection.mode==='collection_only'||b.strategy==='competitor_rank'),
    'Nieprawidłowe granice marży, prowizji lub ceny',
  )
  .refine((b) => !(b.ending === 99 && b.rounding), 'Wybierz końcówkę ,99 albo krok zaokrąglenia, nie oba');
export const repricingRuleInput = z
  .object({ version: z.number().int().min(0), config: repricingConfig })
  .strict();
export const repricingInputsInput = z
  .object({
    version: z.number().int().positive(),
    items: z
      .array(
        z
          .object({
            product_id: z.uuid(),
            net_cost: amount,
            competitor_price: amount.nullable().default(null),
            observed_at: z.iso.datetime({ offset: true }).nullable().default(null),
            source: z.string().trim().min(2).max(200),
          })
          .strict()
          .refine(
            (i) => (i.competitor_price === null) === (i.observed_at === null),
            'Cena konkurencji wymaga czasu obserwacji',
          ),
      )
      .min(1)
      .max(500),
  })
  .strict();
export const repricingPreviewInput = z
  .object({ client_key: z.uuid(), product_ids: z.array(z.uuid()).min(1).max(500) })
  .strict();
export const repricingApplyInput = z.object({ confirmed: z.literal(true) }).strict();
type Config = z.infer<typeof repricingConfig>;
type RepricedProduct = { id: string; sku: string; version: number; vat: number; active?: boolean; kind?: string };
const rowBase = (config: Config, product: RepricedProduct, current: number | null) => ({
  product_id: product.id,
  sku: product.sku,
  product_version: product.version,
  vat: product.vat,
  current_price: current,
  strategy: config.strategy,
});
export function blockedRow(config: Config, product: RepricedProduct, current: number | null, reason: string) {
  return {
    ...rowBase(config, product, current),
    proposed_price: null,
    floor: null as number | null,
    state: 'blocked',
    reason,
  };
}
export type RepricingRankCandidate = {
  state: 'ready' | 'blocked';
  reason: string | null;
  raw_target_gross_minor: string | null;
};
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
// Margin and fee share net sale revenue. Costs are net; output is gross, in list currency.
export function calculateReprice(
  config: Config,
  product: any,
  input: any,
  current: number | null,
  now: number,
  ranked?: RepricingRankCandidate,
) {
  const base = rowBase(config, product, current);
  const blocked = (reason: string) => blockedRow(config, product, current, reason);
  if (!product.active || product.kind === 'group')
    return blocked('Produkt nieaktywny lub grupa wariantów');
  if (!input) return blocked('Brak jawnego kosztu netto w walucie cennika');
  const total = BigInt(input.net_cost) + BigInt(config.fixed_net_cost);
  const gross = (margin: number) =>
    Number(
      ceil(
        total * BigInt(100 + product.vat) * 10000n,
        100n * BigInt(10000 - margin - config.fee_bps),
      ),
    );
  const floor = Math.max(config.min_price, gross(config.min_margin_bps));
  if (floor > config.max_price)
    return { ...blocked('Koszt i minimalna marża przekraczają cenę maksymalną'), floor };
  let candidate: number;
  if (config.strategy === 'competitor_rank') {
    if (!ranked || ranked.state !== 'ready' || ranked.raw_target_gross_minor === null)
      return { ...blocked(ranked?.reason ?? 'Brak profilu lub dostatecznej liczby ofert konkurencji'), floor };
    const target = ranked.raw_target_gross_minor;
    if (!/^(?:0|[1-9]\d{0,8})$/.test(target) || BigInt(target) > 100000000n)
      return { ...blocked('Cena rankingu wykracza poza zakres ceny'), floor };
    // The ranking already subtracts the undercut and our delivery charge.
    candidate = Number(target);
  } else if (config.strategy === 'competitor') {
    if (input.competitor_price === null)
      return { ...blocked('Brak obserwacji konkurencji'), floor };
    const age = now - new Date(input.observed_at).getTime();
    if (!Number.isFinite(age) || age < 0 || age > config.observation_minutes * 60000)
      return {
        ...blocked('Obserwacja konkurencji jest nieaktualna lub pochodzi z przyszłości'),
        floor,
      };
    candidate = input.competitor_price - config.undercut_amount;
  } else candidate = gross(config.target_margin_bps);
  candidate = Math.min(config.max_price, Math.max(floor, candidate));
  const rounding: RepricingRounding | null =
    config.rounding ?? (config.ending === 99 ? { step: 100, ending: 99 } : null);
  if (rounding) {
    // New rounding keeps a competitor undercut below the rival; ,99 keeps its original rule.
    const prefer = config.rounding && config.strategy !== 'cost_margin' ? 'down' : 'up';
    const rounded = roundPrice(candidate, floor, config.max_price, rounding, prefer);
    if (rounded === null)
      return {
        ...blocked(
          config.ending === 99
            ? 'Końcówka ,99 nie mieści się w granicach ceny'
            : 'Zaokrąglenie ceny nie mieści się w granicach ceny',
        ),
        floor,
      };
    candidate = rounded;
  }
  if (
    current !== null &&
    ((config.direction === 'down' && candidate > current) ||
      (config.direction === 'up' && candidate < current))
  )
    return { ...blocked('Zmiana ceny nie spełnia wybranego kierunku'), floor };
  return {
    ...base,
    proposed_price: candidate,
    floor,
    state: candidate === current ? 'unchanged' : 'change',
    reason:
      config.strategy === 'competitor_rank'
        ? 'Ranking ofert z dostawą i ochroną marży'
        : config.strategy === 'competitor' ? 'Cena konkurencji z ochroną marży'
        : 'Docelowa marża netto',
  };
}
export async function repricingRows(
  c: PoolClient,
  tenant: string,
  list: any,
  rule: any,
  ids: string[],
) {
  const config = repricingConfig.parse(rule.config);
  const products = (
    await c.query(
      'SELECT id,sku,price,version,vat,active,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [ids],
    )
  ).rows;
  ensure(products.length === ids.length, 404, 'Nie znaleziono produktu');
  const inputs = new Map(
    (
      await c.query(
        'SELECT * FROM repricing_inputs WHERE price_list_id=$1 AND product_id=ANY($2::uuid[])',
        [list.id, ids],
      )
    ).rows.map((r) => [r.product_id, r]),
  );
  const entries = new Map(
    (
      await c.query(
        'SELECT product_id,price FROM price_list_items WHERE price_list_id=$1 AND product_id=ANY($2::uuid[])',
        [list.id, ids],
      )
    ).rows.map((r) => [r.product_id, r.price]),
  );
  const currency = (await c.query('SELECT currency FROM tenants WHERE id=$1', [tenant])).rows[0]
    .currency;
  const clock = (
    await c.query(
      "SELECT extract(epoch FROM clock_timestamp())*1000 AS ms,to_char((clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date,'YYYY-MM-DD') AS today",
    )
  ).rows[0];
  const now = Number(clock.ms),
    today: string = clock.today;
  const bases = await baseLists(c, list, config, ids);
  const latest = await latestRates(
    c,
    [config.cost_currency ?? list.currency, list.currency, ...('chain' in bases ? bases.chain.map((b) => b.currency) : [])],
    today,
  );
  const maxAge = config.max_rate_age_days ?? REPRICING_RATE_AGE_DAYS;
  const rankings = new Map<string, any>();
  if (config.strategy === 'competitor_rank') {
    const { collectCompetitorRankingInTx, enlistCompetitorRankingBasisInTx } = await import('./competitor-observations');
    let observationCount = 0;
    let rankingBytes = 0;
    for (const product of products) {
      const ranking = await collectCompetitorRankingInTx(c, tenant, list, rule, product.id, Math.floor(now));
      observationCount += ranking.ranked_offers.length + ranking.excluded_offers.length;
      rankingBytes += Buffer.byteLength(JSON.stringify(ranking));
      ensure(observationCount <= 5000 && rankingBytes <= 2_000_000, 413,
        'Ranking przekracza limit podglądu; wybierz mniejszą liczbę produktów');
      await enlistCompetitorRankingBasisInTx(c, ranking);
      rankings.set(product.id, ranking);
    }
  }
  // REPRICE-004: the active manual override of each SKU (none without migration 247).
  const overrides = await activeOverrides(c, list.id, ids);
  const rowFor = (p: any) => {
    const ranking = rankings.get(p.id);
    const withRank = <T extends object>(r: T) => (ranking ? { ...r, rank_basis: ranking } : r);
    let current = entries.get(p.id) ?? null,
      source: 'list' | 'fallback' | 'base' | null = current === null ? null : 'list';
    if (current === null) {
      current = fallbackPrice(list, p.price, currency);
      if (current !== null) source = 'fallback';
    }
    if (current === null && 'refusal' in bases)
      return withRank(blockedRow(config, p, null, bases.refusal));
    if (current === null && 'chain' in bases) {
      const found = basePrice(bases.chain, p, currency, list.currency, latest, today, maxAge);
      if (found && 'refusal' in found) return withRank(blockedRow(config, p, null, found.refusal));
      if (found) {
        current = found.price;
        source = 'base';
      }
    }
    const raw = inputs.get(p.id);
    const cost = raw ? costInListCurrency(raw, config, list.currency, latest, today) : null;
    if (cost && 'refusal' in cost) return withRank(blockedRow(config, p, current, cost.refusal));
    const result = calculateReprice(config, p, cost?.input, current, now, ranking);
    const fx: RepricingFx | null = cost?.fx ?? null;
    // A price taken from the base list is not this list's price yet: it must be written.
    const state = source === 'base' && result.state === 'unchanged' ? 'change' : result.state;
    return withRank({
      ...result,
      state,
      current_source: source,
      ...(fx ? { fx } : {}),
    });
  };
  return products.map((p) => applyRepricingOverride(rowFor(p), overrides.get(p.id) ?? null, p));
}

function fallbackPrice(list: any, catalogPrice: number, tenantCurrency: string): number | null {
  if (!list.fallback || list.currency !== tenantCurrency) return null;
  const computed =
    Number((BigInt(catalogPrice) * BigInt(10000 + list.adjustment_bps) + 5000n) / 10000n) +
    list.adjustment_amount;
  return computed >= 0 && computed <= 100000000 ? computed : null;
}
type BaseList = { id: string; currency: string; active: boolean; fallback: boolean; adjustment_bps: number; adjustment_amount: number; base: string | null; items: Map<string, number> };
/** The configured base chain (cycle and depth checked) with each list's prices for ids. */
async function baseLists(c: PoolClient, list: any, config: Config, ids: string[]): Promise<{ chain: BaseList[] } | { refusal: string }> {
  if (!config.base_price_list_id) return { chain: [] };
  const found = new Map<string, BaseList>();
  for (let id: string | null = config.base_price_list_id, n = 0; id && id !== list.id && !found.has(id) && n <= 5; n++) {
    const row: any = (
      await c.query(
        // FOR SHARE: a base price edit (price list row FOR UPDATE) cannot slip between the
        // recompute of an apply and its write.
        "SELECT l.id,l.currency,l.active,l.fallback,l.adjustment_bps,l.adjustment_amount,r.config->>'base_price_list_id' AS base FROM price_lists l LEFT JOIN repricing_rules r ON (r.tenant_id,r.price_list_id)=(l.tenant_id,l.id) WHERE l.id=$1 FOR SHARE OF l",
        [id],
      )
    ).rows[0];
    if (!row) return { refusal: 'Nie znaleziono cennika bazowego' };
    found.set(id, { ...row, items: new Map() });
    id = row.base;
  }
  const walked = walkBaseChain(list.id, (id) => (id === list.id ? config.base_price_list_id! : found.get(id)?.base ?? null));
  if ('refusal' in walked) return walked;
  const chain = walked.chain.map((id) => found.get(id)!);
  const items = (
    await c.query(
      'SELECT price_list_id,product_id,price FROM price_list_items WHERE price_list_id=ANY($1::uuid[]) AND product_id=ANY($2::uuid[])',
      [chain.map((b) => b.id), ids],
    )
  ).rows;
  for (const i of items) found.get(i.price_list_id)!.items.set(i.product_id, i.price);
  return { chain };
}
/** The price a customer of the first active base list pays (own entry, then its catalog
 * rule), converted to the list currency with NBP rates (half up to a grosz). */
function basePrice(chain: BaseList[], p: any, tenantCurrency: string, listCurrency: string,
  latest: ReadonlyMap<string, RepricingRate>, today: string, maxAge: number): { price: number } | { refusal: string } | null {
  for (const b of chain) {
    if (!b.active) return null;
    const price = b.items.get(p.id) ?? fallbackPrice(b, p.price, tenantCurrency);
    if (price === null) continue;
    if (b.currency === listCurrency) return { price };
    const chosen = ratesFor([b.currency, listCurrency], latest, today, maxAge);
    if ('refusal' in chosen) return chosen;
    const converted = convertMinor(price, b.currency, listCurrency, new Map(chosen.rates.map((r) => [r.currency, r])), 'half_up');
    return converted === null ? { refusal: 'Cena cennika bazowego po przeliczeniu przekracza zakres' } : { price: converted };
  }
  return null;
}
/** Latest stored NBP table A rate on or before the pricing day for each foreign currency. */
async function latestRates(c: PoolClient, wanted: string[], today: string): Promise<Map<string, RepricingRate>> {
  const foreign = [...new Set(wanted)].filter((v) => v !== 'PLN');
  if (new Set(wanted).size < 2 || !foreign.length) return new Map();
  if (!(await c.query("SELECT to_regclass('public.nbp227_rates') IS NOT NULL AS ok")).rows[0].ok) return new Map();
  const rows = (
    await c.query(
      "SELECT DISTINCT ON (currency) currency,to_char(effective_date,'YYYY-MM-DD') effective_date,table_no,mid::text mid FROM nbp227_rates WHERE currency=ANY($1::text[]) AND effective_date<=$2::date ORDER BY currency,effective_date DESC",
      [foreign, today],
    )
  ).rows as RepricingRate[];
  return new Map(rows.map((r) => [r.currency, r]));
}

/** Rule save: the base list exists, is not the list itself and does not close a cycle. */
export async function assertRepricingBaseInTx(c: PoolClient, list: any, config: Config): Promise<void> {
  if (!config.base_price_list_id) return;
  ensure(config.base_price_list_id !== list.id, 422, 'Cennik nie może być własnym cennikiem bazowym');
  const bases = await baseLists(c, list, config, []);
  ensure(!('refusal' in bases), 'refusal' in bases && bases.refusal === 'Nie znaleziono cennika bazowego' ? 404 : 422,
    'refusal' in bases ? bases.refusal : '');
}

// Caller holds the price-list lock and validates the complete batch before writing.
export async function applyRepricingPrices(c: PoolClient, tenant: string, list: any, rows: any[]) {
  const changes = rows.filter((i) => i.state === 'change');
  if (changes.length) {
    await c.query(
      'INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) SELECT $1,$2,product_id,proposed_price FROM jsonb_to_recordset($3::jsonb) AS x(product_id uuid,proposed_price integer) ON CONFLICT(tenant_id,price_list_id,product_id) DO UPDATE SET price=excluded.price',
      [tenant, list.id, JSON.stringify(changes)],
    );
    await c.query('UPDATE price_lists SET version=version+1,updated_at=now() WHERE id=$1', [
      list.id,
    ]);
  }
  return { changed: changes.length, version: list.version + (changes.length ? 1 : 0) };
}
