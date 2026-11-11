import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { assertCatalogExportAccess, catalogExportDefinitionInput } from './catalog-export';
import { catalogExportSourceFrame } from './catalog-export-sources';

export const CATALOG_EXPORT_PROFILE_LIMIT = 200;
const uuid = z.uuid().transform((s) => s.toLowerCase());
const name = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (s) =>
      s.length <= 120 &&
      !/[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/u.test(s) &&
      Buffer.from(s).toString('utf8') === s,
    'Nieprawidłowa nazwa profilu',
  );
const version = z.number().int().positive().max(2147483647);
export const catalogExportProfileCreateInput = z.strictObject({
  name,
  definition: catalogExportDefinitionInput,
  client_key: uuid,
});
export const catalogExportProfilePatchInput = z.strictObject({
  version,
  name,
  definition: catalogExportDefinitionInput,
});
export const catalogExportProfileVersionInput = z.strictObject({ version });
export type CatalogExportProfile = {
  id: string;
  name: string;
  version: number;
  definition: z.infer<typeof catalogExportDefinitionInput>;
  archived: boolean;
  created_at: string;
  updated_at: string;
};
type StoredProfile = Omit<CatalogExportProfile, 'created_at' | 'updated_at'> & {
  created_at: Date | string;
  updated_at: Date | string;
  actor_id: string;
  client_key: string;
  request_hash: string;
  initial_request: unknown;
};
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}
export function catalogExportProfileHash(v: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
}
function view(p: StoredProfile): CatalogExportProfile {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    definition: p.definition,
    archived: p.archived,
    created_at: new Date(p.created_at).toISOString(),
    updated_at: new Date(p.updated_at).toISOString(),
  };
}
export async function catalogExportProfilesAvailable(c: PoolClient) {
  return (
    await c.query<{ available: boolean }>(
      "SELECT to_regclass('public.catalog_export_profiles') IS NOT NULL AS available",
    )
  ).rows[0].available;
}
async function available(c: PoolClient) {
  ensure(
    await catalogExportProfilesAvailable(c),
    503,
    'Profile eksportu nie są dostępne w tej kopii',
  );
}
async function grant(c: PoolClient, a: Actor, write = false) {
  const role = (
    await c.query<{ role: string | null }>('SELECT catalog_export_profile_role($1,true) AS role', [
      a.userId,
    ])
  ).rows[0].role;
  ensure(
    role && ['admin', 'operator', 'viewer'].includes(role),
    403,
    'Brak aktualnego dostępu do katalogu',
  );
  ensure(
    !write || role === 'admin',
    403,
    'Zarządzanie profilami wymaga aktualnej roli administratora',
  );
  let canManage = role === 'admin';
  if (a.apiKeyId) {
    const result = (
      await c.query<{ grant_result: string }>(
        'SELECT catalog_export_profile_key_grant($1,$2,$3) AS grant_result',
        [a.userId, a.apiKeyId, write],
      )
    ).rows[0].grant_result;
    ensure(result !== 'invalid', 401, 'Klucz API został cofnięty lub wygasł');
    ensure(
      result === 'ok' || (!write && result === 'read_only'),
      403,
      'Klucz API nie ma aktualnych uprawnień do profili eksportu',
    );
    canManage = canManage && result === 'ok';
  }
  return { role, canManage };
}
function flags(access: { role: string; canManage: boolean }) {
  return {
    available: true,
    current_role: access.role,
    can_read: true,
    can_manage: access.canManage,
  };
}
async function admission(c: PoolClient, a: Actor) {
  const role = (
    await c.query<{ role: string | null }>('SELECT catalog_export_profile_role($1,false) AS role', [
      a.userId,
    ])
  ).rows[0].role;
  ensure(role === 'admin', 403, 'Zarządzanie profilami wymaga aktualnej roli administratora');
  // Configuration commits use catalog-exclusive before resource/profile waits.
  // Keep the same order, including exact replay and archive-only operations.
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['catalog:' + a.tenantId]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'catalog-export-profiles:' + a.tenantId,
  ]);
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const serialized = JSON.stringify(input);
  ensure(
    typeof serialized === 'string' && Buffer.byteLength(serialized) <= 65536,
    413,
    'Konfiguracja profilu przekracza 64 KiB',
  );
  return schema.parse(input);
}
async function own(c: PoolClient, id: string, lock = false) {
  const p = (
    await c.query<StoredProfile>(
      'SELECT * FROM catalog_export_profiles WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
      [uuid.parse(id)],
    )
  ).rows[0];
  ensure(p, 404, 'Nie znaleziono profilu eksportu');
  return p;
}
async function uniqueName(c: PoolClient, n: string, id?: string) {
  const duplicate = (
    await c.query(
      'SELECT id FROM catalog_export_profiles WHERE NOT archived AND lower(name)=lower($1) AND ($2::uuid IS NULL OR id<>$2)',
      [n, id ?? null],
    )
  ).rowCount;
  ensure(!duplicate, 409, 'Aktywny profil o tej nazwie już istnieje');
}
async function finish(c: PoolClient, a: Actor, p: StoredProfile, reused: boolean) {
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const role = await grant(c, a, true);
  return { profile: view(p), reused, ...flags(role) };
}
export async function catalogExportProfiles(a: Actor) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      if (!(await catalogExportProfilesAvailable(c))) {
        const role = await assertCatalogExportAccess(a);
        return {
          available: false,
          current_role: role,
          can_read: true,
          can_manage: false,
          data: [] as CatalogExportProfile[],
          limit: CATALOG_EXPORT_PROFILE_LIMIT,
        };
      }
      const rows = (
        await c.query<StoredProfile>(
          'SELECT * FROM catalog_export_profiles ORDER BY created_at DESC,id DESC LIMIT 201',
        )
      ).rows;
      ensure(
        rows.length <= CATALOG_EXPORT_PROFILE_LIMIT,
        409,
        'Przekroczony limit zapisanych profili eksportu',
      );
      const role = await grant(c, a);
      return { ...flags(role), data: rows.map(view), limit: CATALOG_EXPORT_PROFILE_LIMIT };
    },
    { wmsAdmission: 'read' },
  );
}
export async function catalogExportProfileDetail(a: Actor, id: string) {
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      const p = await own(c, id);
      const role = await grant(c, a);
      return { profile: view(p), ...flags(role) };
    },
    { wmsAdmission: 'read' },
  );
}
export async function createCatalogExportProfile(a: Actor, input: unknown) {
  const b = parse(catalogExportProfileCreateInput, input),
    request = { name: b.name, definition: b.definition },
    hash = catalogExportProfileHash({ actor_id: a.userId, request });
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      await admission(c, a);
      const old = (
        await c.query<StoredProfile>(
          'SELECT * FROM catalog_export_profiles WHERE client_key=$1 FOR UPDATE',
          [b.client_key],
        )
      ).rows[0];
      if (old) {
        ensure(
          old.actor_id === a.userId &&
            old.request_hash === hash &&
            catalogExportProfileHash(old.initial_request) === catalogExportProfileHash(request),
          409,
          'Klucz żądania został użyty dla innego profilu lub aktora',
        );
        return finish(c, a, old, true);
      }
      const count = Number(
        (
          await c.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM catalog_export_profiles',
          )
        ).rows[0].count,
      );
      ensure(
        count < CATALOG_EXPORT_PROFILE_LIMIT,
        429,
        'Limit 200 profili obejmuje również archiwum',
      );
      await uniqueName(c, b.name);
      if (b.definition.catalog_id || b.definition.warehouse_ids || b.definition.price_list_ids)
        await catalogExportSourceFrame(c, b.definition, a.tenantId);
      const p = (
        await c.query<StoredProfile>(
          `INSERT INTO catalog_export_profiles(id,tenant_id,actor_id,client_key,request_hash,initial_request,name,definition)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            randomUUID(),
            a.tenantId,
            a.userId,
            b.client_key,
            hash,
            JSON.stringify(request),
            b.name,
            JSON.stringify(b.definition),
          ],
        )
      ).rows[0];
      await audit(c, a, 'catalog.export_profile.create', p.id, {
        before: null,
        after: view(p),
        before_hash: null,
        after_hash: catalogExportProfileHash({
          name: p.name,
          definition: p.definition,
          archived: p.archived,
        }),
      });
      return finish(c, a, p, false);
    },
    { wmsAdmission: 'read' },
  );
}
export async function patchCatalogExportProfile(a: Actor, id: string, input: unknown) {
  const b = parse(catalogExportProfilePatchInput, input);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      await admission(c, a);
      const old = await own(c, id, true);
      ensure(old.version === b.version, 409, 'Profil został zmieniony; odczytaj bieżącą wersję');
      ensure(old.version < 2147483647, 409, 'Wyczerpana wersja profilu');
      if (!old.archived) await uniqueName(c, b.name, old.id);
      if (b.definition.catalog_id || b.definition.warehouse_ids || b.definition.price_list_ids)
        await catalogExportSourceFrame(c, b.definition, a.tenantId);
      const p = (
        await c.query<StoredProfile>(
          'UPDATE catalog_export_profiles SET name=$2,definition=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
          [old.id, b.name, JSON.stringify(b.definition)],
        )
      ).rows[0];
      await auditChange(c, a, 'update', old, p);
      return finish(c, a, p, false);
    },
    { wmsAdmission: 'read' },
  );
}
async function auditChange(
  c: PoolClient,
  a: Actor,
  kind: string,
  before: StoredProfile,
  after: StoredProfile,
) {
  await audit(c, a, 'catalog.export_profile.' + kind, after.id, {
    before: view(before),
    after: view(after),
    before_hash: catalogExportProfileHash({
      name: before.name,
      definition: before.definition,
      archived: before.archived,
    }),
    after_hash: catalogExportProfileHash({
      name: after.name,
      definition: after.definition,
      archived: after.archived,
    }),
  });
}
export async function setCatalogExportProfileArchived(
  a: Actor,
  id: string,
  input: unknown,
  archived: boolean,
) {
  const b = parse(catalogExportProfileVersionInput, input);
  return tenantTx(
    a.tenantId,
    async (c) => {
      await available(c);
      await admission(c, a);
      const old = await own(c, id, true);
      ensure(old.version === b.version, 409, 'Profil został zmieniony; odczytaj bieżącą wersję');
      if (old.archived === archived) return finish(c, a, old, true);
      ensure(old.version < 2147483647, 409, 'Wyczerpana wersja profilu');
      if (!archived) await uniqueName(c, old.name, old.id);
      const p = (
        await c.query<StoredProfile>(
          'UPDATE catalog_export_profiles SET archived=$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
          [old.id, archived],
        )
      ).rows[0];
      await auditChange(c, a, archived ? 'archive' : 'restore', old, p);
      return finish(c, a, p, false);
    },
    { wmsAdmission: 'read' },
  );
}
