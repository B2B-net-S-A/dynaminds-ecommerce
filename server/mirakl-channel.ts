/** Mirakl channel admission. No account acceptance, writes, simulation or implicit transport.
 * The injected repository MUST persist atomic budgets across tenants for each instance/operation.
 * Tenant-local RLS state or an in-memory fallback cannot implement this contract. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ensure, Problem} from './errors';
import {Mirakl, MiraklReadDeferred, miraklInstance, type MiraklAccount, type MiraklOrdersQuery,
  type MiraklOffersQuery, type MiraklOrderIdsQuery, parseMiraklOrderIdsQuery} from './mirakl';
import type {Transport} from './integrations';
export {MiraklReadDeferred} from './mirakl';

const DAY = 86400000;
const settingsSchema = z.strictObject({instance_url: z.string().transform(miraklInstance),
  shop_id: z.string().regex(/^[1-9]\d{0,15}$/).refine(v => BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER)),
  currency: z.enum(['PLN','EUR','USD','GBP','CZK'])});
const credentialsSchema = z.strictObject({api_key: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/)});
const orderPageSchema = z.strictObject({offset: z.number().int().min(0).max(10000),
  max: z.number().int().min(1).max(100).default(50), window: z.strictObject({
    start_update_date: z.iso.datetime({offset: true}), end_update_date: z.iso.datetime({offset: true})})
    .refine(w => {const span = Date.parse(w.end_update_date)-Date.parse(w.start_update_date);
      return span > 0 && span <= 31*DAY;})});
const offerQuerySchema = z.strictObject({max: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(10000).default(0),
  sku: z.string().min(1).max(160).refine(v => !/[\x00-\x1f\x7f]/.test(v)).optional()});
function parsed<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const out = schema.safeParse(value);
  ensure(out.success, 422, 'Mirakl: nieprawidłowa konfiguracja');
  return out.data;
}
export const parseMiraklSettings = (value: unknown) => parsed(settingsSchema, value);
export const parseMiraklCredentials = (value: unknown) => parsed(credentialsSchema, value);
/** Only the three public configuration values; never credentials or cached account evidence. */
export const safeMiraklPublicSettings = (value: unknown) => ({...parseMiraklSettings(value)});
export type MiraklChannel = {id: string; tenant_id: string; provider: string; mode: string;
  settings: unknown; credentials: string};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function miraklChannelConnectionHash(channel: MiraklChannel): string {
  ensure(channel.provider === 'mirakl' && ['live','sandbox'].includes(channel.mode)
    && typeof channel.id === 'string' && channel.id.length > 0
    && typeof channel.tenant_id === 'string' && channel.tenant_id.length > 0
    && typeof channel.credentials === 'string' && channel.credentials.length > 0,
  422, 'Mirakl: nieprawidłowe powiązanie kanału');
  return hash(['mirakl-channel/v1', channel.tenant_id, channel.id, channel.mode,
    parseMiraklSettings(channel.settings), channel.credentials]);
}
export type MiraklReadOperation = 'A01'|'OR11'|'OF21';
export type MiraklAccountCache = {schema: 'mirakl-a01-cache/v1'; accountKey: string;
  observedAt: number; expiresAt: number; account: MiraklAccount};
export interface MiraklReadRepository {
  readAccount(accountKey: string): Promise<MiraklAccountCache|null>;
  /** Atomically reserve the GLOBAL instance×operation slot, including durable notBefore.
   * Even failed/unknown attempts retain their fence. Never silently shorten an existing cooldown. */
  reserveRead(input: {budgetKey: string; accountKey: string; operation: MiraklReadOperation;
    now: number; notBefore: number}): Promise<{claimId: string}|{retryAt: number}>;
  storeAccount(input: {claimId: string; entry: MiraklAccountCache}): Promise<void>;
  deferRead(input: {claimId: string; budgetKey: string; operation: MiraklReadOperation;
    now: number; notBefore: number}): Promise<void>;
}
export type MiraklOrderPageRequest = MiraklOrdersQuery & {offset: number};
export type MiraklOfferPageRequest = MiraklOffersQuery & {offset?: number};
export type MiraklChannelReader = ReturnType<typeof createMiraklChannelReader>;

export function createMiraklChannelReader(input: {channel: MiraklChannel; credentials: {api_key: string};
  repository: MiraklReadRepository; transport: Transport; guard: () => Promise<void>; now?: () => number}) {
  const settings = Object.freeze(parseMiraklSettings(input.channel.settings));
  const credentials = Object.freeze(parseMiraklCredentials(input.credentials));
  const connectionHash = miraklChannelConnectionHash(input.channel);
  const repo = input.repository, now = input.now ?? Date.now;
  ensure(repo && ['readAccount','reserveRead','storeAccount','deferRead'].every(k =>
    typeof (repo as unknown as Record<string, unknown>)[k] === 'function')
    && typeof input.guard === 'function' && typeof input.transport === 'function',
  422, 'Mirakl: wymagane trwałe repozytorium, autoryzacja i jawny transport');
  const accountKey = hash(['mirakl-account/v1', settings.instance_url, settings.shop_id,
    settings.currency, hash(credentials.api_key)]);
  const clock = () => {const t = now(); ensure(Number.isSafeInteger(t) && t >= 0,
    502, 'Mirakl: nieprawidłowy zegar'); return t;};
  async function repository<T>(fn: () => Promise<T>): Promise<T> {
    try {return await fn();} catch {throw new Problem(503, 'Mirakl: trwały stan odczytu jest niedostępny');}
  }
  async function run<T>(operation: (client: Mirakl) => Promise<T>): Promise<T> {
    await input.guard();
    let cached: MiraklAccountCache|null = await repository(() => repo.readAccount(accountKey));
    if (cached !== null) {
      ensure(cached.schema === 'mirakl-a01-cache/v1' && cached.accountKey === accountKey
        && Number.isSafeInteger(cached.observedAt) && Number.isSafeInteger(cached.expiresAt)
        && cached.observedAt >= 0 && cached.observedAt <= clock()
        && cached.expiresAt > cached.observedAt && cached.expiresAt <= cached.observedAt + DAY,
      502, 'Mirakl: nieprawidłowy zapis tożsamości sklepu');
      if (cached.expiresAt <= clock()) cached = null;
    }
    let accountClaim: {claimId: string; observedAt: number}|undefined;
    let admissionFailure: unknown;
    const transport: Transport = async (url, init) => {
      try {
        const u = new URL(url);
        const op: MiraklReadOperation = u.pathname === '/api/account' ? 'A01'
          : u.pathname === '/api/orders' ? 'OR11' : 'OF21';
        ensure(u.origin === settings.instance_url && ['/api/account','/api/orders','/api/offers'].includes(u.pathname)
          && u.searchParams.get('shop_id') === settings.shop_id && init.method === 'GET',
        422, 'Mirakl: odczyt poza zakresem kanału');
        await input.guard();
        if (op === 'A01' && cached && cached.expiresAt > clock()) return new Response(JSON.stringify(cached.account),
          {headers: {'content-type': 'application/json'}});
        const t = clock(), budgetKey = hash(['mirakl-instance-operation/v1', settings.instance_url, op]);
        const slot = await repository(() => repo.reserveRead({budgetKey, accountKey, operation: op,
          now: t, notBefore: t + (op === 'A01' ? DAY : op === 'OR11' ? 900000 : 0)}));
        if ('retryAt' in slot) {
          ensure(Number.isSafeInteger(slot.retryAt) && slot.retryAt > t, 503, 'Mirakl: nieprawidłowa rezerwacja budżetu');
          throw new MiraklReadDeferred(Math.max(1, Math.ceil((slot.retryAt-t)/1000)));
        }
        ensure(typeof slot.claimId === 'string' && slot.claimId.length > 0, 503, 'Mirakl: nieprawidłowa rezerwacja budżetu');
        await input.guard();
        if (op === 'A01') accountClaim = {claimId: slot.claimId, observedAt: t};
        let response: Response, cooldownSeconds: number|null = null;
        try {
          response = await input.transport(url, init);
          // Response accessors belong to the transport trust boundary too. They may
          // throw arbitrary errors (including Problem); never promote their code to IAM.
          if (response instanceof Response) {
            const status = response.status;
            ensure(Number.isInteger(status) && status >= 100 && status <= 599,
              502, 'Mirakl: nieprawidłowy status odczytu');
            if (status === 429 || status >= 500) {
              const retry = response.headers.get('retry-after');
              const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 60;
              ensure(Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 2147483647,
                502, 'Mirakl: nieprawidłowy limit oczekiwania');
              cooldownSeconds = Math.max(1, seconds);
            }
          }
        } catch {throw new Problem(502, 'Mirakl: niepotwierdzona odpowiedź odczytu');}
        if (cooldownSeconds !== null) {
          const deferredAt = clock(), notBefore = deferredAt + cooldownSeconds*1000;
          await repository(() => repo.deferRead({claimId: slot.claimId, budgetKey, operation: op,
            now: deferredAt, notBefore}));
        }
        return response;
      } catch (e) {
        // Low-level transport deliberately redacts thrown errors. Preserve only local admission
        // failure to let the job defer/stop without exposing arbitrary transport payloads.
        admissionFailure = e instanceof MiraklReadDeferred ? e
          : e instanceof Problem ? new Problem(e.status, 'Mirakl: odczyt zatrzymany przed potwierdzeniem', e.code)
            : new Problem(502, 'Mirakl: niepotwierdzona odpowiedź odczytu');
        throw admissionFailure;
      }
    };
    const client = new Mirakl(settings, credentials, transport);
    try {
      const account = await client.account();
      await input.guard();
      if (accountClaim) await repository(() => repo.storeAccount({claimId: accountClaim!.claimId,
        entry: {schema: 'mirakl-a01-cache/v1', accountKey, observedAt: accountClaim!.observedAt,
          expiresAt: accountClaim!.observedAt+DAY, account}}));
      const result = await operation(client);
      await input.guard();
      return result;
    } catch (e) {if (admissionFailure) throw admissionFailure; throw e;}
  }
  return Object.freeze({connectionHash,
    account: () => run(client => client.account()),
    readOrderPage: (request: MiraklOrderPageRequest) => {
      const {offset, ...query} = parsed(orderPageSchema, request);
      return run(client => client.ordersPage(query, offset));
    },
    readOrdersByIds: (query: MiraklOrderIdsQuery) => {
      const plan = parseMiraklOrderIdsQuery(query);
      return run(client => client.ordersByIds({order_ids: plan.order_ids, group: plan.group}));
    },
    readOffers: (query: MiraklOfferPageRequest = {}) => {
      const {offset, ...validated} = parsed(offerQuerySchema, query);
      return run(client => client.offersPage(validated, offset));
    },
  });
}
