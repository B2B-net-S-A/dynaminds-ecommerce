import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { ProductPicker } from './catalog';
import {ShopifyCompetitorConfiguration, storedShopifyUiDefinition,type StoredShopifyUiDefinition, type CollectionCadence} from './competitor-shopify-configuration';
import {
  COMPETITOR_OBSERVATION_COLUMNS,
  parseCompetitorObservationCsv,
  type CompetitorObservation,
} from './competitor-observation-csv';

export type CompetitorObservationContext = {
  tenant_id: string;
  user_id: string;
  role: string;
  restore_preview: boolean;
};
type ProfileDraft = {
  source_namespace: string;
  own_seller_id: string;
  rank: number;
  own_delivery_gross_minor: string;
  max_age_minutes: number;
};
type Profile = ProfileDraft & {
  price_list_id: string;
  version: number;
  config_version: number;
  data_version: number;
  updated_at: string;
};
type ObservationWire = Omit<CompetitorObservation, 'price_gross_minor' | 'delivery_gross_minor'> & {
  price_gross_minor: string;
  delivery_gross_minor: string;
};
type Observation = ObservationWire & {
  id: string;
  batch_id: string;
  ordinal: number;
  created_at: string;
};
type Batch = {
  id: string;
  price_list_id: string;
  client_key: string;
  profile_version: number;
  profile_config_version: number;
  profile_data_version: number;
  request_hash: string;
  count: number;
  created_at: string;
};
type Options = {
  available: boolean;
  can_read: boolean;
  can_write: boolean;
  read_only: boolean;
  current_role: string | null;
  limits: { batch_rows: 1000; batch_bytes: 1000000; page: 50 };
  observation_origin: 'manual_local';
  ranking_strategy: 'competitor_rank';
};
type ProfileReply = {
  list: { id: string; name: string; currency: string; version: number; active: boolean };
  rule_version: number | null;
  profile: Profile | null;
};
type Pending = {
  context: string;
  listId: string;
  path: string;
  method: 'POST' | 'PUT';
  body: string;
  kind: 'profile' | 'batch' | 'rank_preview' | 'rank_apply' | 'shopify_batch' | 'shopify_schedule';
  expected?: string;
};
const attempts = new Map<string, Pending>();
const subscriptions = new Map<string, Set<(locked: boolean) => void>>();
const actorScope = (c: CompetitorObservationContext) =>
  JSON.stringify([c.tenant_id, c.user_id, c.role, c.restore_preview]);
const actorSubscriptions = new Map<string, Set<(locked: boolean) => void>>();
export function competitorObservationsLocked(
  context: CompetitorObservationContext,
  listId?: string,
) {
  if (listId) return attempts.has(scope(context, listId));
  return [...attempts.values()].some((p) => p.context === scope(context, p.listId));
}
export function subscribeCompetitorObservationsLock(
  context: CompetitorObservationContext,
  callback: (locked: boolean) => void,
) {
  const key = actorScope(context),
    set = actorSubscriptions.get(key) ?? new Set<(locked: boolean) => void>();
  set.add(callback);
  actorSubscriptions.set(key, set);
  callback(competitorObservationsLocked(context));
  return () => {
    set.delete(callback);
    if (!set.size) actorSubscriptions.delete(key);
  };
}
const notify = (key: string) => {
  for (const callback of subscriptions.get(key) ?? []) callback(attempts.has(key));
  const c = JSON.parse(key) as [string, string, string, boolean, string];
  const context = { tenant_id: c[0], user_id: c[1], role: c[2], restore_preview: c[3] };
  for (const callback of actorSubscriptions.get(actorScope(context)) ?? [])
    callback(competitorObservationsLocked(context));
};
const scope = (c: CompetitorObservationContext, id: string) =>
  JSON.stringify([c.tenant_id, c.user_id, c.role, c.restore_preview, id]);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const stamp = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
const canonical = (v: unknown): string =>
  v && typeof v === 'object'
    ? Array.isArray(v)
      ? '[' + v.map(canonical).join(',') + ']'
      : '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k]))
          .join(',') +
        '}'
    : JSON.stringify(v);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function need(v: unknown, message = 'Niepoprawne dane obserwacji konkurencji.'): asserts v {
  if (!v) throw new Error(message);
}
function object(v: unknown): Record<string, unknown> {
  need(v && typeof v === 'object' && !Array.isArray(v));
  return v as Record<string, unknown>;
}
function exact(v: unknown, keys: readonly string[]) {
  const p = object(v);
  need(Object.keys(p).sort().join(',') === [...keys].sort().join(','));
  return p;
}
const text = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= 200 && v.trim() === v && !v.includes('\0');
const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const minor = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9]\d{0,8})$/.test(v) && BigInt(v) <= 100000000n;
const currency = (v: unknown) => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
export const competitorObservationMoney = (v: string, unit: string) => {
  need(minor(v) && currency(unit));
  const n = BigInt(v);
  return `${n / 100n},${String(n % 100n).padStart(2, '0')} ${unit}`;
};
const observationKeys = [...COMPETITOR_OBSERVATION_COLUMNS];
function wire(v: unknown): ObservationWire {
  const p = exact(v, observationKeys);
  need(
    uuid(p.product_id) &&
      text(p.source_namespace) &&
      text(p.offer_id) &&
      text(p.seller_id) &&
      currency(p.currency) &&
      minor(p.price_gross_minor) &&
      minor(p.delivery_gross_minor) &&
      typeof p.available === 'boolean' &&
      stamp(p.observed_at),
  );
  return p as ObservationWire;
}
const serialize = (o: CompetitorObservation): ObservationWire =>
  wire({
    ...o,
    price_gross_minor: o.price_gross_minor.toString(),
    delivery_gross_minor: o.delivery_gross_minor.toString(),
  });
function profile(v: unknown, listId: string): Profile {
  const p = exact(v, [
    'price_list_id',
    'version',
    'config_version',
    'data_version',
    'source_namespace',
    'own_seller_id',
    'rank',
    'own_delivery_gross_minor',
    'max_age_minutes',
    'updated_at',
  ]);
  need(
    p.price_list_id === listId &&
      positive(p.version) &&
      positive(p.config_version) &&
      typeof p.data_version === 'number' &&
      Number.isSafeInteger(p.data_version) &&
      p.data_version >= 0 &&
      text(p.source_namespace) &&
      text(p.own_seller_id) &&
      positive(p.rank) &&
      Number(p.rank) <= 1000 &&
      minor(p.own_delivery_gross_minor) &&
      positive(p.max_age_minutes) &&
      Number(p.max_age_minutes) <= 10080 &&
      stamp(p.updated_at),
  );
  return p as Profile;
}
function batch(v: unknown, listId: string): Batch {
  const p = exact(v, [
    'id',
    'price_list_id',
    'client_key',
    'profile_version',
    'profile_config_version',
    'profile_data_version',
    'request_hash',
    'count',
    'created_at',
  ]);
  need(
    uuid(p.id) &&
      p.price_list_id === listId &&
      uuid(p.client_key) &&
      positive(p.profile_version) &&
      positive(p.profile_config_version) &&
      typeof p.profile_data_version === 'number' &&
      Number.isSafeInteger(p.profile_data_version) &&
      p.profile_data_version >= 0 &&
      typeof p.request_hash === 'string' &&
      /^[0-9a-f]{64}$/.test(p.request_hash) &&
      positive(p.count) &&
      Number(p.count) <= 1000 &&
      stamp(p.created_at),
  );
  return p as Batch;
}
function observation(v: unknown): Observation {
  const p = exact(v, [...observationKeys, 'id', 'batch_id', 'ordinal', 'created_at']);
  const fields = Object.fromEntries(observationKeys.map((k) => [k, p[k]]));
  wire(fields);
  need(
    uuid(p.id) &&
      uuid(p.batch_id) &&
      positive(p.ordinal) &&
      Number(p.ordinal) <= 1000 &&
      stamp(p.created_at),
  );
  return p as Observation;
}
function options(v: unknown, c: CompetitorObservationContext): Options {
  const p = exact(v, [
      'available',
      'can_read',
      'can_write',
      'read_only',
      'current_role',
      'limits',
      'observation_origin',
      'ranking_strategy',
    ]),
    limits = exact(p.limits, ['batch_rows', 'batch_bytes', 'page']);
  need(
    ['available', 'can_read', 'can_write', 'read_only'].every((k) => typeof p[k] === 'boolean') &&
      p.read_only === c.restore_preview &&
      limits.batch_rows === 1000 &&
      limits.batch_bytes === 1000000 &&
      limits.page === 50 &&
      p.observation_origin === 'manual_local' &&
      p.ranking_strategy === 'competitor_rank',
  );
  if (!p.available)
    need(!p.can_read && !p.can_write && (p.current_role === null || p.current_role === c.role));
  else
    need(
      p.can_read &&
        p.current_role === c.role &&
        (!p.can_write || (c.role === 'admin' && !p.read_only)),
    );
  return p as Options;
}
function profileReply(v: unknown, listId: string): ProfileReply {
  const p = exact(v, ['list', 'rule_version', 'profile']),
    l = exact(p.list, ['id', 'name', 'currency', 'version', 'active']);
  need(
    l.id === listId &&
      text(l.name) &&
      currency(l.currency) &&
      positive(l.version) &&
      typeof l.active === 'boolean' &&
      (p.rule_version === null || positive(p.rule_version)),
  );
  if (p.profile !== null) profile(p.profile, listId);
  return p as ProfileReply;
}
function page<T>(v: unknown, parse: (v: unknown) => T): { data: T[]; next_cursor: string | null } {
  const p = exact(v, ['data', 'next_cursor']);
  need(
    Array.isArray(p.data) &&
      p.data.length <= 50 &&
      (p.next_cursor === null ||
        (typeof p.next_cursor === 'string' &&
          p.next_cursor.length > 0 &&
          p.next_cursor.length <= 2048 &&
          p.data.length === 50)),
  );
  return { data: p.data.map(parse), next_cursor: p.next_cursor as string | null };
}
function ObservationTable({ rows }: { rows: readonly ObservationWire[] }) {
  return (
    <div className="table-scroll">
      <table>
        <caption>Pełne obserwacje — kwoty brutto, bez pobierania marketplace</caption>
        <thead>
          <tr>
            {[
              'Produkt',
              'Przestrzeń źródła',
              'Oferta',
              'Sprzedawca',
              'Waluta',
              'Cena brutto',
              'Dostawa brutto',
              'Dostępność',
              'Czas obserwacji UTC',
            ].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.product_id}</td>
              <td>{r.source_namespace}</td>
              <td>{r.offer_id}</td>
              <td>{r.seller_id}</td>
              <td>{r.currency}</td>
              <td>{competitorObservationMoney(r.price_gross_minor, r.currency)}</td>
              <td>{competitorObservationMoney(r.delivery_gross_minor, r.currency)}</td>
              <td>{r.available ? 'Dostępna' : 'Niedostępna'}</td>
              <td>
                <time dateTime={r.observed_at}>{r.observed_at}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
type RankedOffer = Observation & { total_gross_minor: string; rank: number };
type ExcludedOffer = Observation & { reason: string };
type RankBasis = {
  schema: 'competitor-ranking/v1';
  profile_version: number | null;
  config_version: number | null;
  data_version: number | null;
  source_hash: string;
  currency: string;
  product_id: string;
  source_namespace: string | null;
  own_seller_id: string | null;
  rank: number | null;
  own_delivery_gross_minor: string | null;
  undercut_gross_minor: string | null;
  max_age_minutes: number | null;
  state: 'ready' | 'blocked';
  reason: string | null;
  selected: RankedOffer | null;
  raw_target_gross_minor: string | null;
  ranked_offers: RankedOffer[];
  excluded_offers: ExcludedOffer[];
};
type PriceRow = {
  product_id: string;
  sku: string;
  product_version: number;
  vat: number;
  current_price: number | null;
  floor: number | null;
  proposed_price: number | null;
  state: 'blocked' | 'unchanged' | 'change';
  reason: string;
  rank_basis?: RankBasis;
};
type PricePreview = {
  id: string;
  price_list_id: string;
  client_key: string;
  product_ids: string[];
  rule_version: number;
  list_version: number;
  currency: string;
  state: 'preview' | 'applied';
  created_at: string;
  expires_at: string;
  applied_at: string | null;
  applied_list_version: number | null;
  result: PriceRow[];
};
type PreviewSummary = {
  id: string;
  state: 'preview' | 'applied';
  count: number;
  created_at: string;
  list_version: number;
  rule_version: number;
  currency: string;
};
const wideMoney = (v: string, unit: string) => {
  need(/^(0|[1-9]\d*)$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER) && currency(unit));
  const n = BigInt(v);
  return `${n / 100n},${String(n % 100n).padStart(2, '0')} ${unit}`;
};
const integerMinor = (v: unknown) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 100000000;
const timestamp = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const exclusionText: Record<string, string> = {
  other_product: 'Inny produkt',
  own_seller: 'Własny sprzedawca',
  unavailable: 'Oferta niedostępna',
  other_currency: 'Inna waluta',
  future_observation: 'Obserwacja z przyszłości',
  stale_observation: 'Obserwacja zbyt stara',
  profile_missing: 'Brak zapisanego profilu',
  insufficient_offers: 'Za mało ofert dla wybranego miejsca',
  target_below_zero: 'Cena po odjęciu dostawy i obniżki jest ujemna',
  target_above_price_bound: 'Cena poza dozwolonym zakresem',
};
function rankBasis(v: unknown, productId: string, unit: string): RankBasis {
  const p = exact(v, [
    'schema',
    'profile_version',
    'config_version',
    'data_version',
    'source_hash',
    'currency',
    'product_id',
    'source_namespace',
    'own_seller_id',
    'rank',
    'own_delivery_gross_minor',
    'undercut_gross_minor',
    'max_age_minutes',
    'state',
    'reason',
    'selected',
    'raw_target_gross_minor',
    'ranked_offers',
    'excluded_offers',
  ]);
  need(
    p.schema === 'competitor-ranking/v1' &&
      p.product_id === productId &&
      p.currency === unit &&
      typeof p.source_hash === 'string' &&
      /^[a-f0-9]{64}$/.test(p.source_hash) &&
      Array.isArray(p.ranked_offers) &&
      Array.isArray(p.excluded_offers) &&
      p.ranked_offers.length + p.excluded_offers.length <= 1000,
  );
  if (p.reason === 'profile_missing') {
    need(
      p.state === 'blocked' &&
        [
          'profile_version',
          'config_version',
          'data_version',
          'source_namespace',
          'own_seller_id',
          'rank',
          'own_delivery_gross_minor',
          'undercut_gross_minor',
          'max_age_minutes',
          'selected',
          'raw_target_gross_minor',
        ].every((k) => p[k] === null) &&
        p.ranked_offers.length === 0 &&
        p.excluded_offers.length === 0,
    );
    return p as RankBasis;
  }
  need(
    positive(p.profile_version) &&
      positive(p.config_version) &&
      typeof p.data_version === 'number' &&
      Number.isSafeInteger(p.data_version) &&
      p.data_version >= 0 &&
      text(p.source_namespace) &&
      text(p.own_seller_id) &&
      positive(p.rank) &&
      Number(p.rank) <= 1000 &&
      minor(p.own_delivery_gross_minor) &&
      minor(p.undercut_gross_minor) &&
      positive(p.max_age_minutes) &&
      Number(p.max_age_minutes) <= 10080,
  );
  const seen = new Set<string>();
  const parseOffer = (v: unknown, ranked: boolean) => {
    const o = exact(v, [
      ...observationKeys,
      'id',
      'batch_id',
      'ordinal',
      'created_at',
      ...(ranked ? ['total_gross_minor', 'rank'] : ['reason']),
    ]);
    const basic = Object.fromEntries(
      [...observationKeys, 'id', 'batch_id', 'ordinal', 'created_at'].map((k) => [k, o[k]]),
    );
    observation(basic);
    need(
      o.product_id === productId &&
        o.source_namespace === p.source_namespace &&
        !seen.has(String(o.offer_id)),
    );
    seen.add(String(o.offer_id));
    return o;
  };
  const ranked = p.ranked_offers.map((v, i) => {
    const o = parseOffer(v, true);
    need(
      o.rank === i + 1 &&
        o.currency === unit &&
        o.available &&
        o.seller_id !== p.own_seller_id &&
        typeof o.total_gross_minor === 'string' &&
        BigInt(o.total_gross_minor) ===
          BigInt(String(o.price_gross_minor)) + BigInt(String(o.delivery_gross_minor)) &&
        /^(0|[1-9]\d*)$/.test(o.total_gross_minor),
    );
    return o as RankedOffer;
  });
  const excluded = p.excluded_offers.map((v) => {
    const o = parseOffer(v, false);
    need(
      typeof o.reason === 'string' &&
        [
          'own_seller',
          'unavailable',
          'other_currency',
          'future_observation',
          'stale_observation',
        ].includes(o.reason),
    );
    return o as ExcludedOffer;
  });
  for (let i = 1; i < ranked.length; i++) {
    const a = ranked[i - 1],
      b = ranked[i];
    need(
      BigInt(a.total_gross_minor) < BigInt(b.total_gross_minor) ||
        (a.total_gross_minor === b.total_gross_minor &&
          (a.seller_id < b.seller_id || (a.seller_id === b.seller_id && a.offer_id < b.offer_id))),
    );
  }
  const selected = ranked[Number(p.rank) - 1] ?? null;
  need(same(p.selected, selected));
  const target = selected
    ? BigInt(selected.total_gross_minor) -
      BigInt(p.undercut_gross_minor as string) -
      BigInt(p.own_delivery_gross_minor as string)
    : null;
  if (p.state === 'ready')
    need(
      p.reason === null &&
        minor(p.raw_target_gross_minor) &&
        target === BigInt(p.raw_target_gross_minor),
    );
  else
    need(
      p.state === 'blocked' &&
        p.raw_target_gross_minor === null &&
        p.reason ===
          (target === null
            ? 'insufficient_offers'
            : target < 0n
              ? 'target_below_zero'
              : target > 100000000n
                ? 'target_above_price_bound'
                : null) &&
        p.reason !== null,
    );
  return { ...p, ranked_offers: ranked, excluded_offers: excluded } as RankBasis;
}
function pricePreview(v: unknown, listId: string): PricePreview {
  const p = object(v);
  need(
    uuid(p.id) &&
      p.price_list_id === listId &&
      uuid(p.client_key) &&
      Array.isArray(p.product_ids) &&
      p.product_ids.length > 0 &&
      p.product_ids.length <= 500 &&
      p.product_ids.every(uuid) &&
      new Set(p.product_ids).size === p.product_ids.length &&
      positive(p.rule_version) &&
      positive(p.list_version) &&
      currency(p.currency) &&
      ['preview', 'applied'].includes(String(p.state)) &&
      timestamp(p.created_at) &&
      timestamp(p.expires_at) &&
      Array.isArray(p.result) &&
      p.result.length === p.product_ids.length,
  );
  need(
    p.state === 'preview'
      ? p.applied_at === null && p.applied_list_version === null
      : timestamp(p.applied_at) && positive(p.applied_list_version),
  );
  let offers = 0;
  const ids = new Set<string>();
  const result = p.result.map((v) => {
    const r = object(v);
    need(
      uuid(r.product_id) &&
        p.product_ids instanceof Array &&
        p.product_ids.includes(r.product_id) &&
        !ids.has(r.product_id) &&
        text(r.sku) &&
        positive(r.product_version) &&
        typeof r.vat === 'number' &&
        Number.isSafeInteger(r.vat) &&
        r.vat >= 0 &&
        r.vat <= 100 &&
        ['blocked', 'unchanged', 'change'].includes(String(r.state)) &&
        typeof r.reason === 'string' &&
        r.reason.length <= 2000 &&
        ['current_price', 'proposed_price'].every((k) => r[k] === null || integerMinor(r[k])) &&
        (r.floor === null ||
          (typeof r.floor === 'number' && Number.isSafeInteger(r.floor) && r.floor >= 0)),
    );
    ids.add(r.product_id);
    need(r.state === 'blocked' ? r.proposed_price === null : r.proposed_price !== null);
    if (r.rank_basis !== undefined) {
      r.rank_basis = rankBasis(r.rank_basis, r.product_id, String(p.currency));
      const rank = r.rank_basis as RankBasis;
      offers += rank.ranked_offers.length + rank.excluded_offers.length;
    }
    return r as PriceRow;
  });
  need(offers <= 5000 && new TextEncoder().encode(JSON.stringify(p)).length <= 3000000);
  return { ...p, result } as PricePreview;
}
function previewHistory(v: unknown) {
  const p = object(v),
    meta = object(p.meta);
  need(Array.isArray(p.data) && p.data.length <= 50 && (meta.cursor === null || uuid(meta.cursor)));
  const data = p.data.map((v) => {
    const r = object(v);
    need(
      uuid(r.id) &&
        ['preview', 'applied'].includes(String(r.state)) &&
        positive(r.count) &&
        Number(r.count) <= 500 &&
        timestamp(r.created_at) &&
        positive(r.list_version) &&
        positive(r.rule_version) &&
        currency(r.currency),
    );
    return r as PreviewSummary;
  });
  return { data, cursor: meta.cursor as string | null };
}
function RankTable({ basis: r }: { basis: RankBasis }) {
  return (
    <section aria-label={'Zapisana podstawa rankingu ' + r.product_id}>
      <p>
        Profil v{r.profile_version ?? '—'} · konfiguracja v{r.config_version ?? '—'} · dane v
        {r.data_version ?? '—'} · źródło {r.source_namespace ?? '—'} · miejsce {r.rank ?? '—'} ·
        ważność {r.max_age_minutes ?? '—'} minut.
      </p>
      <p>
        Własna dostawa{' '}
        {r.own_delivery_gross_minor === null
          ? '—'
          : competitorObservationMoney(r.own_delivery_gross_minor, r.currency)}{' '}
        · obniżka{' '}
        {r.undercut_gross_minor === null
          ? '—'
          : competitorObservationMoney(r.undercut_gross_minor, r.currency)}{' '}
        · surowy cel{' '}
        {r.raw_target_gross_minor === null
          ? '—'
          : competitorObservationMoney(r.raw_target_gross_minor, r.currency)}
        .
      </p>
      {r.reason && <p className="notice">{exclusionText[r.reason] ?? r.reason}</p>}
      <div className="table-scroll">
        <table>
          <caption>Wszystkie porównane oferty wraz z dostawą</caption>
          <thead>
            <tr>
              {[
                'Miejsce',
                'Oferta',
                'Sprzedawca',
                'Cena brutto',
                'Dostawa brutto',
                'Suma brutto',
                'Dostępność',
                'Czas UTC',
                'Uwzględnienie',
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.ranked_offers.map((o) => (
              <tr key={o.id}>
                <td>
                  {o.rank}
                  {r.selected?.id === o.id ? ' · wybrana' : ''}
                </td>
                <td>{o.offer_id}</td>
                <td>{o.seller_id}</td>
                <td>{competitorObservationMoney(o.price_gross_minor, o.currency)}</td>
                <td>{competitorObservationMoney(o.delivery_gross_minor, o.currency)}</td>
                <td>
                  {String(BigInt(o.total_gross_minor) / 100n)},
                  {String(BigInt(o.total_gross_minor) % 100n).padStart(2, '0')} {o.currency}
                </td>
                <td>Dostępna</td>
                <td>{o.observed_at}</td>
                <td>Uwzględniona</td>
              </tr>
            ))}
            {r.excluded_offers.map((o) => (
              <tr key={o.id}>
                <td>—</td>
                <td>{o.offer_id}</td>
                <td>{o.seller_id}</td>
                <td>{competitorObservationMoney(o.price_gross_minor, o.currency)}</td>
                <td>{competitorObservationMoney(o.delivery_gross_minor, o.currency)}</td>
                <td>—</td>
                <td>{o.available ? 'Dostępna' : 'Niedostępna'}</td>
                <td>{o.observed_at}</td>
                <td>{exclusionText[o.reason] ?? o.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
const blankProfile: ProfileDraft = {
  source_namespace: '',
  own_seller_id: '',
  rank: 1,
  own_delivery_gross_minor: '0',
  max_age_minutes: 60,
};
const blankManual = {
  offer_id: '',
  seller_id: '',
  price_gross_minor: '0',
  delivery_gross_minor: '0',
  available: true,
  observed_at: '',
};
export function CompetitorObservations({
  listId,
  context,
  refresh = 0,
  externalWriteBlocked = false,
  onApplied,
  onLockedChange,
  rankEnabled = false,
}: {
  listId: string;
  context: CompetitorObservationContext;
  rankEnabled?: boolean;
  refresh?: number;
  externalWriteBlocked?: boolean;
  onApplied?: () => void;
  onLockedChange?: (locked: boolean) => void;
}) {
  const key = scope(context, listId),
    root = '/price-lists/' + listId + '/competitor-observations';
  const revision = useRef(0),
    callbacks = useRef({ onApplied, onLockedChange });
  callbacks.current = { onApplied, onLockedChange };
  const epoch = useRef(0),
    alive = useRef(false),
    flight = useRef<{ g: number } | null>(null),
    fileRead = useRef(0),
    live = useRef({ key, refresh, externalWriteBlocked, rankEnabled });
  live.current = { key, refresh, externalWriteBlocked, rankEnabled };
  const [tag, setTag] = useState(''),
    [caps, setCaps] = useState<Options | null>(null),
    [basis, setBasis] = useState<ProfileReply | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [locked, setLocked] = useState(attempts.has(key));
  const [draft, setDraft] = useState<ProfileDraft>(blankProfile),
    [profileConsent, setProfileConsent] = useState(false),
    [manual, setManual] = useState(blankManual),
    [product, setProduct] = useState<{ id: string; sku: string; name: string } | null>(null),
    [csv, setCsv] = useState(''),
    [review, setReview] = useState<ObservationWire[] | null>(null),
    [importConsent, setImportConsent] = useState(false);
  const [rankProduct, setRankProduct] = useState<{ id: string; sku: string; name: string } | null>(
      null,
    ),
    [selectedIds, setSelectedIds] = useState<string[]>([]),
    [price, setPrice] = useState<PricePreview | null>(null),
    [priceConsent, setPriceConsent] = useState(false),
    [priceHistory, setPriceHistory] = useState<PreviewSummary[]>([]),
    [priceCursor, setPriceCursor] = useState<string | null>(null);
  const [collectionState,setCollectionState]=useState<{schedule:CollectionCadence;ruleConfigVersion:number;initial:StoredShopifyUiDefinition|null}|null>(null);
  const [rows, setRows] = useState<Observation[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [batches, setBatches] = useState<Batch[]>([]),
    [batchCursor, setBatchCursor] = useState<string | null>(null),
    [detail, setDetail] = useState<{ batch: Batch; observations: Observation[] } | null>(null),
    [saved, setSaved] = useState<Batch | null>(null);
  function check(g: number) {
    need(
      alive.current &&
        g === epoch.current &&
        live.current.key === key &&
        live.current.refresh === refresh,
      'Kontekst obserwacji zmienił się.',
    );
  }
  function clearReview() {
    ++revision.current;
    setPriceConsent(false);
    setPrice(null);
    setReview(null);
    setImportConsent(false);
    setSaved(null);
  }
  function purge() {
    setRankProduct(null);
    setSelectedIds([]);
    setPriceHistory([]);
    setPriceCursor(null);
    setTag('');
    setCaps(null);
    setBasis(null);
    setCollectionState(null);
    setRows([]);
    setCursor(null);
    setBatches([]);
    setBatchCursor(null);
    setDetail(null);
    setDraft({ ...blankProfile });
    setProfileConsent(false);
    setManual({ ...blankManual });
    setProduct(null);
    setCsv('');
    clearReview();
    fileRead.current++;
  }
  async function auth(g: number) {
    check(g);
    const m = object(await api<unknown>('/auth/me'));
    check(g);
    const u = object(m.user);
    need(
      u.tenant_id === context.tenant_id &&
        u.id === context.user_id &&
        u.role === context.role &&
        m.restore_preview === context.restore_preview,
      'Kontekst obserwacji zmienił się.',
    );
  }
  async function access(g: number, write = false) {
    await auth(g);
    const f = options(await api<unknown>(root + '/options'), context);
    check(g);
    await auth(g);
    check(g);
    if (write)
      need(
        f.available &&
          f.can_write &&
          !context.restore_preview &&
          !live.current.externalWriteBlocked,
        'Zapis obserwacji jest zablokowany.',
      );
    return f;
  }
  async function read(path: string, g: number) {
    check(g);
    const v = await api<unknown>(path);
    check(g);
    return v;
  }
  async function load(g: number) {
    const f = await access(g);
    check(g);
    if (!f.available) {
      setCaps(f);
      setTag(key);
      return;
    }
    const b = profileReply(await read(root + '/profile', g), listId),
      o = page(await read(root + '/observations?limit=50', g), observation),
      h = page(await read(root + '/batches?limit=50', g), (v) => batch(v, listId)),
      ph = previewHistory(await read('/price-lists/' + listId + '/repricing/previews?limit=50', g));
    let collection:null|{schedule:CollectionCadence;ruleConfigVersion:number;initial:StoredShopifyUiDefinition|null}=null;
    if(b.profile){
      const rs=object(await read('/price-lists/'+listId+'/repricing',g)),r=object(rs.rule),rc=object(r.config),
        cs=object(await read('/price-lists/'+listId+'/repricing/schedule',g)),cfg=cs.schedule===null?null:object(cs.schedule);
      need(positive(r.config_version)&&['repricing','collection_only','collect_then_reprice'].includes(String(cs.purpose)));
      if(cfg)need(cfg.price_list_id===listId&&positive(cfg.version)&&typeof cfg.enabled==='boolean'&&positive(cfg.interval_minutes)&&Number(cfg.interval_minutes)>=5&&Number(cfg.interval_minutes)<=10080);
      collection={initial:Object.hasOwn(rc,'shopify_collection')?storedShopifyUiDefinition.parse(rc.shopify_collection):null,ruleConfigVersion:Number(r.config_version),schedule:{version:cfg?Number(cfg.version):0,enabled:cfg?Boolean(cfg.enabled):false,interval_minutes:cfg?Number(cfg.interval_minutes):30,purpose:String(cs.purpose)}};
    }
    await auth(g);
    check(g);
    setCaps(f);
    setBasis(b);
    setCollectionState(collection);
    setDraft(
      b.profile
        ? {
            source_namespace: b.profile.source_namespace,
            own_seller_id: b.profile.own_seller_id,
            rank: b.profile.rank,
            own_delivery_gross_minor: b.profile.own_delivery_gross_minor,
            max_age_minutes: b.profile.max_age_minutes,
          }
        : { ...blankProfile },
    );
    setRows(o.data);
    setCursor(o.next_cursor);
    setBatches(h.data);
    setBatchCursor(h.next_cursor);
    setPriceHistory(ph.data);
    setPriceCursor(ph.cursor);
    setTag(key);
  }
  async function task(fn: (g: number) => Promise<void>) {
    const g = epoch.current;
    if (flight.current?.g === g) return;
    const token = { g };
    flight.current = token;
    setBusy(true);
    setError('');
    try {
      await fn(g);
    } catch (e) {
      if (!alive.current || g !== epoch.current || live.current.key !== key) return;
      setError(e instanceof Error ? e.message : 'Nie udało się odczytać obserwacji.');
      if (
        (e instanceof ApiError && [401, 403].includes(e.status)) ||
        (e instanceof Error &&
          ['Kontekst obserwacji zmienił się.', 'Niepoprawne dane obserwacji konkurencji.'].includes(
            e.message,
          ))
      )
        purge();
    } finally {
      if (flight.current === token) {
        flight.current = null;
        if (alive.current && g === epoch.current) setBusy(false);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    ++epoch.current;
    flight.current = null;
    setBusy(false);
    setError('');
    purge();
    const listeners = subscriptions.get(key) ?? new Set<(v: boolean) => void>();
    const listener = (v: boolean) => {
      setLocked(v);
      callbacks.current.onLockedChange?.(v);
    };
    listeners.add(listener);
    subscriptions.set(key, listeners);
    listener(attempts.has(key));
    void task(load);
    return () => {
      alive.current = false;
      ++epoch.current;
      fileRead.current++;
      listeners.delete(listener);
      if (!listeners.size) subscriptions.delete(key);
    };
  }, [key, refresh]);
  useEffect(() => {
    ++revision.current;
    setPriceConsent(false);
  }, [rankEnabled]);
  async function mutate(p: Pending, g: number, retry = false, reviewRevision = revision.current) {
    await access(g, true);
    check(g);
    need(
      retry || reviewRevision === revision.current,
      'Dane lub zgoda zmieniły się przed zapisem.',
    );
    need(p.context === key && p.listId === listId);
    need(retry ? attempts.get(key) === p : !attempts.has(key));
    need(attempts.has(key) || attempts.size < 32);
    need(!live.current.externalWriteBlocked && !context.restore_preview);
    if (p.kind === 'rank_preview' || p.kind === 'rank_apply')
      need(live.current.rankEnabled, 'Reguła nie używa rankingu konkurencji.');
    need(new TextEncoder().encode(p.body).length <= 1000000);
    attempts.set(key, p);
    notify(key);
    let v: unknown;
    try {
      v = await api<unknown>(p.path, p.method, JSON.parse(p.body));
    } catch (e) {
      if (
        e instanceof ApiError &&
        [400, 401, 403, 404, 409, 410, 413, 422, 423].includes(e.status) &&
        attempts.get(key) === p
      ) {
        attempts.delete(key);
        notify(key);
        setPriceConsent(false);
      }
      throw e;
    }
    let next: Profile;
    let nextSaved: Batch | null = null;
    let nextPrice: PricePreview | null = null;
    if(p.kind==='shopify_schedule'){
      const r=exact(v,['schedule','purpose']),cfg=object(r.schedule),original=JSON.parse(p.body);
      need(cfg.price_list_id===listId&&cfg.version===original.version+1&&cfg.rule_config_version===original.rule_config_version+1&&cfg.actor_id===context.user_id&&cfg.enabled===original.enabled&&cfg.interval_minutes===original.interval_minutes&&r.purpose===original.mode);
      need(basis?.profile);next=basis.profile;
    } else if(p.kind==='shopify_batch'){
      const outer=exact(v,['batch','origin','delivery_origin']);
      need(outer.origin==='public_shopify_ajax_with_configured_delivery'&&outer.delivery_origin==='operator_configured');
      const r=exact(outer.batch,['batch','profile','rule_version','reused']),original=JSON.parse(p.body);
      next=profile(r.profile,listId);nextSaved=batch(r.batch,listId);
      need(typeof r.reused==='boolean'&&positive(r.rule_version)&&nextSaved.client_key===original.client_key&&nextSaved.profile_version===original.profile_version&&nextSaved.count===original.sources.length);
    } else if (p.kind === 'profile') {
      const r = exact(v, ['profile', 'rule_version']);
      next = profile(r.profile, listId);
      need(positive(r.rule_version));
      const original = JSON.parse(p.body) as { version: number; profile: ProfileDraft };
      need(
        next.version === original.version + 1 &&
          Object.entries(original.profile).every(([k, value]) =>
            same(next[k as keyof Profile], value),
          ),
      );
    } else if (p.kind === 'batch') {
      const r = exact(v, ['batch', 'profile', 'rule_version', 'reused']);
      next = profile(r.profile, listId);
      nextSaved = batch(r.batch, listId);
      const original = JSON.parse(p.body) as {
        client_key: string;
        profile_version: number;
        observations: ObservationWire[];
      };
      need(
        typeof r.reused === 'boolean' &&
          positive(r.rule_version) &&
          nextSaved.client_key === original.client_key &&
          nextSaved.profile_version === original.profile_version &&
          nextSaved.count === original.observations.length,
      );
    } else {
      nextPrice = pricePreview(v, listId);
      const original = JSON.parse(p.body) as { client_key?: string; product_ids?: string[] };
      if (p.kind === 'rank_preview')
        need(
          nextPrice.client_key === original.client_key &&
            same([...nextPrice.product_ids].sort(), [...(original.product_ids ?? [])].sort()) &&
            nextPrice.result.every((r) => r.rank_basis),
        );
      else {
        need(p.expected);
        const expected = pricePreview(JSON.parse(p.expected), listId);
        need(
          nextPrice.id === expected.id &&
            nextPrice.state === 'applied' &&
            same(nextPrice.result, expected.result) &&
            same(nextPrice.product_ids, expected.product_ids) &&
            nextPrice.list_version === expected.list_version &&
            nextPrice.rule_version === expected.rule_version &&
            nextPrice.currency === expected.currency,
        );
      }
    }
    check(g);
    const final = await access(g);
    check(g);
    need(final.available && final.can_read && attempts.get(key) === p);
    attempts.delete(key);
    notify(key);
    clearReview();
    setProfileConsent(false);
    await load(g);
    check(g);
    setSaved(nextSaved);
    setPrice(nextPrice);
    callbacks.current.onApplied?.();
  }
  async function inspectProfile(p: Pending, g: number) {
    need(p.kind === 'profile' && attempts.get(key) === p);
    await access(g);
    check(g);
    const current = profileReply(await read(root + '/profile', g), listId),
      original = JSON.parse(p.body) as { version: number; profile: ProfileDraft };
    await auth(g);
    check(g);
    need(attempts.get(key) === p);
    need(
      current.profile &&
        current.profile.version === original.version + 1 &&
        Object.entries(original.profile).every(([k, value]) =>
          same(current.profile![k as keyof Profile], value),
        ),
      'Odczytany profil nie potwierdza dokładnego oczekiwanego stanu. Intencja pozostaje zachowana; nie ponowiono zapisu.',
    );
    attempts.delete(key);
    notify(key);
    clearReview();
    setProfileConsent(false);
    await load(g);
    check(g);
    setError(
      'Odczyt potwierdził oczekiwaną wersję i wartości profilu. Nie jest to dowód ponownego wykonania ani nowy zapis.',
    );
  }
  function previewManual() {
    need(product && basis?.profile, 'Wybierz produkt i zapisz profil.');
    const value = wire({
      product_id: product.id,
      source_namespace: basis.profile.source_namespace,
      currency: basis.list.currency,
      ...manual,
    });
    setReview([value]);
    setImportConsent(false);
    setSaved(null);
  }
  function previewCsv() {
    const values = parseCompetitorObservationCsv(csv).map(serialize);
    need(basis?.profile, 'Najpierw zapisz profil.');
    need(
      values.every(
        (v) =>
          v.source_namespace === basis.profile!.source_namespace &&
          v.currency === basis.list.currency,
      ),
      'CSV wymaga przestrzeni źródła i waluty bieżącego profilu.',
    );
    setReview(values);
    setImportConsent(false);
    setSaved(null);
  }
  const visible = tag === key,
    b = visible ? basis : null,
    f = visible ? caps : null,
    writable =
      visible &&
      f?.can_write &&
      !context.restore_preview &&
      !externalWriteBlocked &&
      !busy &&
      !locked;
  const pending = attempts.get(key);
  const changeManual = (next: typeof manual) => {
    setManual(next);
    clearReview();
  };
  const changeDraft = (next: ProfileDraft) => {
    setDraft(next);
    setProfileConsent(false);
    clearReview();
  };
  return (
    <section className="panel" aria-label="Obserwacje konkurencji">
      <div className="panel-heading">
        <div>
          <h2>Oferty konkurencji i ranking</h2>
          <p>Jawne dane operatora, CSV lub skonfigurowane publiczne produkty Shopify. Dostawa z Shopify jest założeniem operatora; nie pobieramy ofert marketplace.</p>
        </div>
        <button className="button" type="button" disabled={busy} onClick={() => void task(load)}>
          Odśwież obserwacje
        </button>
      </div>
      {context.restore_preview && (
        <p className="notice">Kopia tylko do odczytu. Obserwacje i historia pozostają dostępne.</p>
      )}
      {busy && <p role="status">Wczytywanie obserwacji…</p>}
      {error && (
        <p className="error-block" role="alert">
          {error}
        </p>
      )}
      {visible && f && !f.available && (
        <p className="notice">
          Trwałe obserwacje nie są dostępne. Brak danych nie oznacza braku ofert.
        </p>
      )}
      {locked && pending && (
        <div className="notice">
          <p>
            Wynik zapisu wymaga sprawdzenia. Zachowano dokładnie tę samą próbę dla tego cennika.
          </p>
          <button
            className="button"
            disabled={
              busy ||
              ((pending.kind==='shopify_batch'||pending.kind==='shopify_schedule') ? false : pending.kind !== 'profile' && (context.restore_preview || externalWriteBlocked))
            }
            onClick={() =>
              void task((g) =>
                pending.kind==='shopify_batch'||pending.kind==='shopify_schedule' ? load(g) : pending.kind === 'profile' ? inspectProfile(pending, g) : mutate(pending, g, true),
              )
            }
          >
            {pending.kind==='shopify_batch'||pending.kind==='shopify_schedule'
              ? 'Odczytaj historię i bieżący stan — bez ponawiania zapisu'
              : pending.kind === 'profile'
              ? 'Odczytaj wynik zapisania profilu'
              : pending.kind === 'batch'
                ? 'Sprawdź tę samą próbę obserwacji'
                : 'Sprawdź tę samą próbę ceny'}
          </button>
          {(pending.kind==='shopify_batch'||pending.kind==='shopify_schedule')&&<p>Wynik tej próby jest niepewny. Nie wysłano jej ponownie. Odczyt stanu nie zwalnia blokady bez potwierdzenia dokładnej intencji.</p>}
        </div>
      )}
      {visible && b && (
        <>
          <p className="notice">
            Cennik {b.list.name} · {b.list.currency} · wersja {b.list.version}. Ranking obejmuje
            oferty, także kilka ofert jednego sprzedawcy; własny sprzedawca jest wykluczony.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void task(async (g) => {
                need(writable && profileConsent);
                const p: Pending = {
                  context: key,
                  listId,
                  path: root + '/profile',
                  method: 'PUT',
                  kind: 'profile',
                  body: JSON.stringify({ version: b.profile?.version ?? 0, profile: draft }),
                };
                await mutate(p, g);
              });
            }}
          >
            <fieldset disabled={!writable}>
              <legend>Profil rankingu</legend>
              <div className="integration-filters">
                <label>
                  Przestrzeń źródła
                  <input
                    value={draft.source_namespace}
                    maxLength={200}
                    required
                    onChange={(e) => changeDraft({ ...draft, source_namespace: e.target.value })}
                  />
                </label>
                <label>
                  Identyfikator własnego sprzedawcy
                  <input
                    value={draft.own_seller_id}
                    maxLength={200}
                    required
                    onChange={(e) => changeDraft({ ...draft, own_seller_id: e.target.value })}
                  />
                </label>
                <label>
                  Miejsce cenowe oferty
                  <input
                    type="number"
                    value={draft.rank}
                    min={1}
                    max={1000}
                    required
                    onChange={(e) => changeDraft({ ...draft, rank: Number(e.target.value) })}
                  />
                </label>
                <label>
                  Własna dostawa brutto w groszach
                  <input
                    value={draft.own_delivery_gross_minor}
                    inputMode="numeric"
                    pattern="0|[1-9][0-9]{0,8}"
                    required
                    onChange={(e) =>
                      changeDraft({ ...draft, own_delivery_gross_minor: e.target.value })
                    }
                  />
                </label>
                <label>
                  Ważność obserwacji w minutach
                  <input
                    type="number"
                    value={draft.max_age_minutes}
                    min={1}
                    max={10080}
                    required
                    onChange={(e) =>
                      changeDraft({ ...draft, max_age_minutes: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={profileConsent}
                  onChange={(e) => (++revision.current, setProfileConsent(e.target.checked))}
                />{' '}
                Potwierdzam jawny profil, własnego sprzedawcę i koszt dostawy.
              </label>
              <button className="button" disabled={!profileConsent}>
                Zapisz profil rankingu
              </button>
            </fieldset>
          </form>
          {b.profile&&collectionState&&<ShopifyCompetitorConfiguration
            key={key+':'+b.profile.version+':'+collectionState.ruleConfigVersion+':'+collectionState.schedule.version}
            scopeKey={key} writable={Boolean(writable)} namespace={b.profile.source_namespace} currency={b.list.currency}
            profileVersion={b.profile.version} ruleConfigVersion={collectionState.ruleConfigVersion} schedule={collectionState.schedule} initial={collectionState.initial} rankEnabled={rankEnabled}
            onCollect={sources=>void task(async g=>{need(writable&&b.profile);await mutate({context:key,listId,path:root+'/collect/shopify',method:'POST',kind:'shopify_batch',body:JSON.stringify({client_key:crypto.randomUUID(),profile_version:b.profile.version,sources,local_observations_confirmed:true})},g);})}
            onSchedule={body=>void task(async g=>{need(writable);await mutate({context:key,listId,path:root+'/collection-schedule',method:'PUT',kind:'shopify_schedule',body:JSON.stringify(body)},g);})}
          />}
          <fieldset disabled={!writable || !b.profile}>
            <legend>Jedna obserwacja operatora</legend>
            <ProductPicker
              key={key}
              contextKey={key}
              label="Produkt obserwacji"
              value={product?.id ?? ''}
              initial={product}
              disabled={!writable || !b.profile}
              filter={(p) => p.kind !== 'group'}
              select={(p) => {
                setProduct(p ? { id: p.id, sku: p.sku, name: p.name } : null);
                clearReview();
              }}
            />
            <div className="integration-filters">
              <label>
                Identyfikator oferty
                <input
                  value={manual.offer_id}
                  maxLength={200}
                  onChange={(e) => changeManual({ ...manual, offer_id: e.target.value })}
                />
              </label>
              <label>
                Identyfikator sprzedawcy
                <input
                  value={manual.seller_id}
                  maxLength={200}
                  onChange={(e) => changeManual({ ...manual, seller_id: e.target.value })}
                />
              </label>
              <label>
                Cena brutto w groszach
                <input
                  value={manual.price_gross_minor}
                  inputMode="numeric"
                  onChange={(e) => changeManual({ ...manual, price_gross_minor: e.target.value })}
                />
              </label>
              <label>
                Dostawa brutto w groszach
                <input
                  value={manual.delivery_gross_minor}
                  inputMode="numeric"
                  onChange={(e) =>
                    changeManual({ ...manual, delivery_gross_minor: e.target.value })
                  }
                />
              </label>
              <label>
                Czas obserwacji UTC
                <input
                  value={manual.observed_at}
                  placeholder="2026-10-08T12:00:00.123456Z"
                  onChange={(e) => changeManual({ ...manual, observed_at: e.target.value })}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={manual.available}
                  onChange={(e) => changeManual({ ...manual, available: e.target.checked })}
                />{' '}
                Oferta dostępna
              </label>
            </div>
            <p>
              Produkt wybierasz z własnego katalogu. Przestrzeń źródła i waluta pochodzą z
              zapisanego profilu/cennika.
            </p>
            <button
              className="button"
              type="button"
              onClick={() => void task(async () => previewManual())}
            >
              Sprawdź obserwację operatora
            </button>
          </fieldset>
          <fieldset disabled={!writable || !b.profile}>
            <legend>Pełny import CSV</legend>
            <p>
              UTF-8, maksymalnie 1000 wierszy i 1 MB. Dokładny nagłówek:{' '}
              <code>{COMPETITOR_OBSERVATION_COLUMNS.join(',')}</code>. Kwoty są całkowitymi
              groszami; dostępność true/false; czas UTC zachowuje 6 cyfr ułamkowych.
            </p>
            <label>
              CSV obserwacji
              <textarea
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  clearReview();
                }}
              />
            </label>
            <label>
              Plik CSV
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0],
                    g = epoch.current,
                    serial = ++fileRead.current;
                  clearReview();
                  if (!file) return;
                  void task(async () => {
                    need(file.size <= 1000000);
                    const raw = new Uint8Array(await file.arrayBuffer());
                    check(g);
                    if (serial !== fileRead.current) return;
                    parseCompetitorObservationCsv(raw);
                    setCsv(new TextDecoder('utf-8', { fatal: true }).decode(raw));
                  });
                }}
              />
            </label>
            <button
              className="button"
              type="button"
              onClick={() => void task(async () => previewCsv())}
            >
              Sprawdź cały CSV
            </button>
          </fieldset>
          {review && (
            <section aria-label="Podgląd zapisu obserwacji">
              <h3>Pełny podgląd {review.length} obserwacji — jeszcze niezapisane</h3>
              <ObservationTable rows={review} />
              <label>
                <input
                  type="checkbox"
                  checked={importConsent}
                  disabled={!writable}
                  onChange={(e) => (++revision.current, setImportConsent(e.target.checked))}
                />{' '}
                Potwierdzam zapis wyświetlonych lokalnych obserwacji. Nie jest to pobranie danych u
                dostawcy ani zmiana cen.
              </label>
              <button
                className="button primary"
                disabled={!writable || !importConsent}
                onClick={() =>
                  void task(async (g) => {
                    need(writable && importConsent && review && b.profile);
                    const p: Pending = {
                      context: key,
                      listId,
                      path: root + '/batches',
                      method: 'POST',
                      kind: 'batch',
                      body: JSON.stringify({
                        client_key: crypto.randomUUID(),
                        profile_version: b.profile.version,
                        observations: review,
                        local_observations_confirmed: true,
                      }),
                    };
                    await mutate(p, g);
                  })
                }
              >
                Zapisz dokładnie te obserwacje
              </button>
            </section>
          )}
          {saved && (
            <p role="status">
              Zapisano partię {saved.id}: {saved.count} obserwacji. Ceny w cenniku nie zostały
              zmienione przez ten zapis.
            </p>
          )}
          <section aria-label="Ranking i osobna zgoda ceny">
            <h3>Podgląd chronionej ceny na podstawie rankingu</h3>
            {!rankEnabled && (
              <p className="notice">
                W istniejącej regule repricingu wybierz strategię rankingu konkurencji. Koszty
                netto, marża, granice i kierunek nadal obowiązują.
              </p>
            )}
            <fieldset disabled={!writable || !rankEnabled || !b.profile}>
              <legend>Produkty do podglądu</legend>
              <ProductPicker
                key={'rank:' + key}
                contextKey={key}
                label="Produkt do rankingu"
                value={rankProduct?.id ?? ''}
                initial={rankProduct}
                disabled={!writable || !rankEnabled || !b.profile}
                filter={(p) => p.kind !== 'group'}
                select={(p) => {
                  setRankProduct(p ? { id: p.id, sku: p.sku, name: p.name } : null);
                  clearReview();
                }}
              />
              <button
                type="button"
                className="button"
                disabled={
                  !rankProduct || selectedIds.includes(rankProduct.id) || selectedIds.length >= 500
                }
                onClick={() => {
                  need(rankProduct);
                  setSelectedIds([...selectedIds, rankProduct.id]);
                  clearReview();
                }}
              >
                Dodaj produkt do podglądu rankingu
              </button>
              <p>Wybrano {selectedIds.length} produktów (maksymalnie 500).</p>
              {selectedIds.map((id) => (
                <button
                  type="button"
                  className="button"
                  key={id}
                  onClick={() => {
                    setSelectedIds(selectedIds.filter((v) => v !== id));
                    clearReview();
                  }}
                >
                  Usuń produkt {id}
                </button>
              ))}
              <button
                className="button"
                type="button"
                disabled={!selectedIds.length}
                onClick={() =>
                  void task((g) => {
                    need(writable && rankEnabled && selectedIds.length);
                    return mutate(
                      {
                        context: key,
                        listId,
                        path: '/price-lists/' + listId + '/repricing/previews',
                        method: 'POST',
                        kind: 'rank_preview',
                        body: JSON.stringify({
                          client_key: crypto.randomUUID(),
                          product_ids: [...selectedIds].sort(),
                        }),
                      },
                      g,
                    );
                  })
                }
              >
                Wylicz pełny podgląd rankingu
              </button>
            </fieldset>
            {price && (
              <section aria-label="Zapisany podgląd ceny rankingu">
                <h4>
                  {price.state === 'applied'
                    ? 'Zastosowana cena'
                    : 'Podgląd ceny — jeszcze bez zmiany cennika'}
                </h4>
                <p>
                  Zapisany cennik v{price.list_version} · reguła v{price.rule_version} · waluta{' '}
                  {price.currency} · ważny do {price.expires_at}.
                </p>
                <div className="table-scroll">
                  <table>
                    <caption>
                      Chroniony wynik ceny po uwzględnieniu kosztu, marży i ograniczeń
                    </caption>
                    <thead>
                      <tr>
                        {[
                          'SKU',
                          'Obecna cena',
                          'Minimum z marżą',
                          'Docelowa cena w cenniku',
                          'Wynik',
                          'Powód',
                        ].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {price.result.map((r) => (
                        <tr key={r.product_id}>
                          <td>{r.sku}</td>
                          <td>
                            {r.current_price === null
                              ? '—'
                              : competitorObservationMoney(String(r.current_price), price.currency)}
                          </td>
                          <td>
                            {r.floor === null ? '—' : wideMoney(String(r.floor), price.currency)}
                          </td>
                          <td>
                            {r.proposed_price === null
                              ? '—'
                              : competitorObservationMoney(
                                  String(r.proposed_price),
                                  price.currency,
                                )}
                          </td>
                          <td>
                            {r.state === 'blocked'
                              ? 'Zablokowana'
                              : r.state === 'unchanged'
                                ? 'Bez zmiany'
                                : 'Zmiana'}
                          </td>
                          <td>{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {price.result.map((r) =>
                  r.rank_basis ? (
                    <RankTable key={r.product_id} basis={r.rank_basis} />
                  ) : (
                    <p key={r.product_id} className="notice">
                      Historyczny wynik {r.sku} nie zawiera podstawy rankingu. Nie można go
                      zastosować z tego panelu.
                    </p>
                  ),
                )}
                {price.state === 'preview' && (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={priceConsent}
                        disabled={
                          !writable ||
                          !rankEnabled ||
                          price.result.some((r) => r.state === 'blocked' || !r.rank_basis)
                        }
                        onChange={(e) => {
                          ++revision.current;
                          setPriceConsent(e.target.checked);
                        }}
                      />{' '}
                      Potwierdzam osobno zastosowanie pełnych docelowych cen z tego zapisanego
                      podglądu.
                    </label>
                    <button
                      className="button primary"
                      disabled={
                        !writable ||
                        !rankEnabled ||
                        !priceConsent ||
                        price.result.some((r) => r.state === 'blocked' || !r.rank_basis)
                      }
                      onClick={() =>
                        void task((g) => {
                          need(writable && priceConsent && rankEnabled && price);
                          return mutate(
                            {
                              context: key,
                              listId,
                              path: '/repricing-previews/' + price.id + '/apply',
                              method: 'POST',
                              kind: 'rank_apply',
                              body: JSON.stringify({ confirmed: true }),
                              expected: JSON.stringify(price),
                            },
                            g,
                          );
                        })
                      }
                    >
                      Zastosuj dokładnie te ceny w cenniku
                    </button>
                  </>
                )}
                {price.state === 'applied' && (
                  <p role="status">
                    Zapis zastosowany atomowo · wersja cennika {price.applied_list_version}. To nie
                    jest potwierdzenie synchronizacji cen u marketplace.
                  </p>
                )}
              </section>
            )}
            <h4>Historia zapisanych podglądów cen</h4>
            {priceHistory.map((p) => (
              <p key={p.id}>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void task(async (g) => {
                      await access(g);
                      const readback = pricePreview(
                        await read('/repricing-previews/' + p.id, g),
                        listId,
                      );
                      need(readback.id === p.id);
                      await auth(g);
                      check(g);
                      clearReview();
                      setPrice(readback);
                    })
                  }
                >
                  Podgląd {p.id} · {p.count} produktów ·{' '}
                  {p.state === 'applied' ? 'zastosowany' : 'do zastosowania'} · {p.created_at}
                </button>
              </p>
            ))}
            {priceCursor && (
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void task(async (g) => {
                    await access(g);
                    const next = previewHistory(
                      await read(
                        '/price-lists/' +
                          listId +
                          '/repricing/previews?limit=50&after=' +
                          encodeURIComponent(priceCursor),
                        g,
                      ),
                    );
                    await auth(g);
                    check(g);
                    need(next.cursor !== priceCursor);
                    setPriceHistory(next.data);
                    setPriceCursor(next.cursor);
                  })
                }
              >
                Następna strona podglądów cen
              </button>
            )}
          </section>
          <h3>Zapisane obserwacje</h3>
          <ObservationTable rows={rows} />
          {cursor && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void task(async (g) => {
                  const selected = cursor;
                  await access(g);
                  const next = page(
                    await read(
                      root + '/observations?limit=50&after=' + encodeURIComponent(selected),
                      g,
                    ),
                    observation,
                  );
                  await auth(g);
                  check(g);
                  need(next.next_cursor !== selected);
                  setRows(next.data);
                  setCursor(next.next_cursor);
                })
              }
            >
              Następna strona obserwacji
            </button>
          )}
          <h3>Historia partii</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Partia</th>
                  <th>Obserwacje</th>
                  <th>Profil / konfiguracja / dane</th>
                  <th>Czas UTC</th>
                  <th>Szczegóły</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((row) => (
                  <tr key={row.id}>
                    <td>{row.id}</td>
                    <td>{row.count}</td>
                    <td>
                      {row.profile_version} / {row.profile_config_version} /{' '}
                      {row.profile_data_version}
                    </td>
                    <td>{row.created_at}</td>
                    <td>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          void task(async (g) => {
                            await access(g);
                            const r = exact(await read(root + '/batches/' + row.id, g), [
                                'batch',
                                'observations',
                              ]),
                              savedBatch = batch(r.batch, listId);
                            need(
                              savedBatch.id === row.id &&
                                Array.isArray(r.observations) &&
                                r.observations.length === savedBatch.count,
                            );
                            const all = r.observations.map(observation);
                            need(
                              all.every(
                                (o, i) => o.batch_id === savedBatch.id && o.ordinal === i + 1,
                              ),
                            );
                            await auth(g);
                            check(g);
                            setDetail({ batch: savedBatch, observations: all });
                          })
                        }
                      >
                        Pełna partia {row.id}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {batchCursor && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void task(async (g) => {
                  const selected = batchCursor;
                  await access(g);
                  const next = page(
                    await read(root + '/batches?limit=50&after=' + encodeURIComponent(selected), g),
                    (v) => batch(v, listId),
                  );
                  await auth(g);
                  check(g);
                  need(next.next_cursor !== selected);
                  setBatches(next.data);
                  setBatchCursor(next.next_cursor);
                })
              }
            >
              Następna strona partii
            </button>
          )}
          {detail && (
            <section aria-label="Pełna zapisana partia">
              <h3>
                Zapisana partia {detail.batch.id} · {detail.batch.count} obserwacji
              </h3>
              <ObservationTable rows={detail.observations} />
            </section>
          )}
        </>
      )}
    </section>
  );
}
