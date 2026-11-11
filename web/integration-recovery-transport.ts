import { api } from './api';
import type { IntegrationRecoveryTransport, RecoveryFilter, RecoveryIdentity } from './integration-recovery-queue';

type QueueQuery = RecoveryFilter & { limit: 50; after: string | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bad = () => new Error('Niepoprawny kontekst lub zapytanie kolejki integracji.');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad();
  return value as Record<string, unknown>;
}
export function recoveryIdentityFromNative(value: unknown): RecoveryIdentity {
  const p = record(value);
  if (Object.keys(p).sort().join(',') !== 'restore_preview,role,tenant_id,user_id' ||
    typeof p.restore_preview !== 'boolean' || typeof p.user_id !== 'string' || !uuid.test(p.user_id) ||
    typeof p.tenant_id !== 'string' || !uuid.test(p.tenant_id) || typeof p.role !== 'string' ||
    !['admin','operator','viewer'].includes(p.role)) throw bad();
  return { tenant_id: p.tenant_id, user_id: p.user_id, role: p.role, restore_preview: p.restore_preview };
}
export function recoveryQueuePath(value: QueueQuery): string {
  const q = record(value);
  if (Object.keys(q).sort().join(',') !== 'after,execution,limit,provider' || q.limit !== 50 ||
    (q.provider !== null && (typeof q.provider !== 'string' || !['shopify','amazon','ebay'].includes(q.provider))) ||
    typeof q.execution !== 'string' || !['all','live','simulation'].includes(q.execution) ||
    (q.after !== null && (typeof q.after !== 'string' || q.after.length < 1 || q.after.length > 2048))) throw bad();
  const params = new URLSearchParams({ execution: value.execution, limit: '50' });
  if (value.provider !== null) params.set('provider', value.provider);
  if (value.after !== null) params.set('after', value.after);
  return '/integrations/recovery-queue?' + params.toString();
}
/** Stable singleton; both native reads retain api's cookie and workspace fence. */
export const integrationRecoveryTransport: IntegrationRecoveryTransport = Object.freeze({
  async identity(): Promise<unknown> {
    return recoveryIdentityFromNative(await api<unknown>('/integrations/recovery-queue/identity', 'GET'));
  },
  async list(query: QueueQuery): Promise<unknown> {
    return api<unknown>(recoveryQueuePath(query), 'GET');
  },
});
