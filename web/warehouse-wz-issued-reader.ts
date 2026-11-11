import { api, ApiError } from './api';
import type {
  WzIssuedAccess, WzIssuedDetail, WzIssuedExport, WzIssuedOptions,
  WzIssuedPage, WzIssuedReader,
} from './warehouse-wz-issued-documents';

type Flags = Omit<WzIssuedAccess, 'context_key'>;
type OptionsReply = Flags & Omit<WzIssuedOptions, 'access'>;
type PageReply = Flags & Omit<WzIssuedPage, 'access'>;
type DetailReply = Flags & Omit<WzIssuedDetail, 'access'>;
type ExportReply = Flags & Omit<WzIssuedExport, 'access'>;
type Identity = { tenant_id: string; id: string; role: WzIssuedAccess['current_role'] };
const prefix = '/warehouse-wz-issued';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const roles = ['admin', 'operator', 'viewer'];

function canonicalParts(contextKey: string) {
  const p = contextKey.split(':');
  if (p.length !== 4 || !uuid(p[0]) || !uuid(p[1]) || !roles.includes(p[2]) || !['true', 'false'].includes(p[3])) throw new ApiError('Niepełny kontekst odczytu WZ.', 403);
  return p;
}
async function identity(contextKey: string): Promise<Identity> {
  const p = canonicalParts(contextKey);
  const d = await api<{ user?: Identity }>('/auth/me');
  const u = d?.user;
  if (!u || !uuid(u.tenant_id) || !uuid(u.id) || !roles.includes(u.role) || `${u.tenant_id}:${u.id}:${u.role}` !== p.slice(0, 3).join(':')) throw new ApiError('Zmieniła się firma, użytkownik lub rola podczas odczytu WZ.', 403);
  return u;
}
function flags(d: Flags, actor: Identity, contextKey: string): WzIssuedAccess {
  if (!d || ['available', 'read_only', 'can_read', 'can_read_value'].some(k => typeof d[k as keyof Flags] !== 'boolean') || !roles.includes(d.current_role)) throw new ApiError('Niepełne uprawnienia odczytu WZ.', 503);
  // The role comes from auth/me; the restore bit comes from a real response.
  // Never derive either by echoing the requested context.
  const actual = `${actor.tenant_id}:${actor.id}:${actor.role}:${d.read_only}`;
  if (actual !== contextKey || d.current_role !== actor.role) throw new ApiError('Zmienił się użytkownik lub tryb kopii podczas odczytu WZ.', 403);
  if (!d.can_read) throw new ApiError('Odebrano dostęp do zapisanych WZ.', 403);
  return { context_key: actual, available: d.available, read_only: d.read_only, current_role: actor.role, can_read: d.can_read, can_read_value: d.can_read_value };
}
async function optionsReply(contextKey: string) {
  await identity(contextKey);
  const data = await api<OptionsReply>(prefix + '/options');
  const actor = await identity(contextKey);
  return { data, access: flags(data, actor, contextKey) };
}
async function read<T extends Flags>(contextKey: string, path: string) {
  await identity(contextKey);
  const data = await api<T>(path);
  const actor = await identity(contextKey);
  const responseAccess = flags(data, actor, contextKey);
  // Fresh options after the data response also binds the restore mode and
  // prevents a value-grant loss from being concealed by earlier read flags.
  const final = await optionsReply(contextKey);
  const access: WzIssuedAccess = {
    ...final.access,
    available: responseAccess.available && final.access.available,
    can_read: responseAccess.can_read && final.access.can_read,
    can_read_value: responseAccess.can_read_value && final.access.can_read_value,
  };
  return { data, access };
}
function documentPath(documentId: string) {
  if (!uuid(documentId)) throw new ApiError('Niepełny identyfikator dokumentu WZ.', 422);
  return prefix + '/documents/' + encodeURIComponent(documentId);
}

/** Stable singleton of authenticated GET adapters. The panel validates full
 * manifests and removes cost fields on any observed value-grant loss. This
 * adapter performs no mutation, login, registry reset or automatic retry. */
export const warehouseWzIssuedReader: WzIssuedReader = {
  async access(contextKey) {
    return (await optionsReply(contextKey)).access;
  },
  async options(contextKey) {
    const { data, access } = await optionsReply(contextKey);
    return { access, warehouses: data.warehouses, limits: data.limits };
  },
  async list(filters, cursor, contextKey) {
    const query = new URLSearchParams({ limit: '50' });
    if (filters.warehouse_id) query.set('warehouse_id', filters.warehouse_id);
    if (filters.order_id) query.set('order_id', filters.order_id);
    if (cursor !== null) query.set('cursor', cursor);
    const { data, access } = await read<PageReply>(contextKey, prefix + '/documents?' + query.toString());
    return { access, data: data.data, meta: data.meta };
  },
  async detail(documentId, contextKey) {
    const { data, access } = await read<DetailReply>(contextKey, documentPath(documentId));
    return { access, document: data.document, rows: data.rows, snapshot_at: data.snapshot_at };
  },
  async exportDocument(documentId, format, includeValues, contextKey) {
    const query = new URLSearchParams({ format, include_values: String(includeValues) });
    const { data, access } = await read<ExportReply>(contextKey, documentPath(documentId) + '/export?' + query.toString());
    return { access, document: data.document, format: data.format, values_included: data.values_included, row_count: data.row_count, filename: data.filename, content_type: data.content_type, content: data.content, snapshot_at: data.snapshot_at };
  },
};
