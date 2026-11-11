// Every HTTP call of the automation rules v2 editor (contract: shared/automation-v2.ts header).
import { api, ApiError } from './api';
import type {
  AutomationCatalog,
  AutomationRuleInput,
  AutomationRuleV2,
  AutomationRuleVersion,
  AutomationRunSummary,
  AutomationTestResult,
} from '../shared/automation-v2';

const BASE = '/automations/v2';
const rule = (id: string) => BASE + '/rules/' + encodeURIComponent(id);
/** 204 endpoints: api() always parses JSON, so an empty body surfaces as SyntaxError. The caller re-reads the
 * rule list afterwards, which confirms the outcome either way. */
const noContent = (p: Promise<unknown>): Promise<void> =>
  p.then(
    () => undefined,
    (e) => {
      if (e instanceof SyntaxError) return;
      throw e;
    },
  );

export interface ManualRule {
  id: string;
  name: string;
  group: string;
}
export interface PreviewResult {
  matching: number;
  sample: Array<{ id: string; number: string }>;
}
export interface OrderHit {
  id: string;
  number: string;
  customer_name?: string;
}

export const automationV2Api = {
  catalog: () => api<AutomationCatalog>(BASE + '/catalog'),
  rules: () => api<{ data: AutomationRuleV2[] }>(BASE + '/rules').then((r) => r.data),
  create: (input: AutomationRuleInput) => api<AutomationRuleV2>(BASE + '/rules', 'POST', input),
  update: (id: string, input: AutomationRuleInput, version: number) =>
    api<AutomationRuleV2>(rule(id), 'PUT', { ...input, version }),
  copy: (id: string) => api<AutomationRuleV2>(rule(id) + '/copy', 'POST', {}),
  remove: (id: string) => noContent(api(rule(id), 'DELETE')),
  order: (ids: string[]) => noContent(api(BASE + '/rules/order', 'PATCH', { ids })),
  preview: (id: string) => api<PreviewResult>(rule(id) + '/preview', 'POST', {}),
  test: (id: string, orderId: string) => api<AutomationTestResult>(rule(id) + '/test', 'POST', { order_id: orderId }),
  run: (id: string, orderIds: string[]) =>
    api<{ runs: AutomationRunSummary[] }>(rule(id) + '/run', 'POST', { order_ids: orderIds }).then((r) => r.runs),
  versions: (id: string) => api<{ data: AutomationRuleVersion[] }>(rule(id) + '/versions').then((r) => r.data),
  runs: (filter: { rule_id?: string; order_id?: string } = {}) => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => !!v) as [string, string][]).toString();
    return api<{ data: AutomationRunSummary[] }>(BASE + '/runs' + (q ? '?' + q : '')).then((r) => r.data);
  },
  manual: (orderId?: string) =>
    api<{ data: ManualRule[] }>(BASE + '/manual' + (orderId ? '?order_id=' + encodeURIComponent(orderId) : '')).then((r) => r.data),
  /** Orders matching a typed number (existing list endpoint), for "Testuj na zamówieniu". */
  findOrders: (search: string) =>
    api<{ data: OrderHit[] }>('/orders?' + new URLSearchParams({ search, limit: '10' })).then((r) => r.data),
};

/** A save rejected because another user saved a newer version first. */
export const isStaleVersion = (e: unknown): boolean => e instanceof ApiError && e.status === 409;
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Nie udało się wykonać operacji');
