import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx, pool } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { encrypt, decrypt } from './security';
import { shopifyAccountPolicy } from './shopify-oauth';
import {
  acquireOrderFieldsAdmissionInTx,
  orderFieldCurrentRole,
  listOrderFields,
  orderFieldBatchReadableDefinitionsInTx,
  prepareOrderFieldBatchRowsInTx,
  applyPreparedOrderFieldBatchInTx,
  freezeMappedInitialValuesInTx,
} from './order-fields';
import {
  orderFieldMappingProfileSchema,
  orderFieldMappingProfilePatchSchema,
  orderFieldMappingPreviewSchema,
  orderFieldMappingQueueSchema,
  type OrderFieldMapping,
  type OrderFieldMappingPreviewInput,
} from './order-field-mappings-schema';
import {
  mappingHash as hash,
  orderFieldMappingConnectionHash,
  captureOrderFieldMappingSources,
  convertOrderFieldMappingSources,
  mappingSourceKinds,
} from './order-field-mappings-source';
export const ORDER_FIELD_MAPPING_JOB = 'order.fields.mapping';
export const mappingInstant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const epoch = (column: string) => `${mappingInstant(column)} source_epoch_text`;
const historyCursor = (r: any) =>
  Buffer.from(JSON.stringify([r.cursor_time, r.id])).toString('base64url');
function cp(value?: string): [string, string] | null {
  if (!value) return null;
  try {
    return z
      .tuple([z.iso.datetime(), z.uuid()])
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new Problem(422, 'Niepoprawny kursor');
  }
}
function rowCp(value?: string): number | null {
  if (!value) return null;
  try {
    return z
      .number()
      .int()
      .min(0)
      .max(99)
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new Problem(422, 'Niepoprawny kursor wiersza');
  }
}
export const mappingFlags = (role: string) => ({
  current_role: role,
  can_admin: role === 'admin',
  can_import: role === 'admin',
  can_reconcile: ['admin', 'operator'].includes(role),
});
const writer = (role: string) =>
  ensure(['admin', 'operator'].includes(role), 403, 'Wymagany aktualny administrator lub operator');
export const mappingAdmin = (role: string) =>
  ensure(role === 'admin', 403, 'Wymagany aktualny administrator');
export async function acquireMappingOAuthInTx(
  c: PoolClient,
  a: { tenantId: string },
  provider: string,
) {
  if (provider === 'shopify')
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
      `shopify-oauth:${a.tenantId}`,
    ]);
}
export async function mappingChannelInTx(c: PoolClient, a: Actor, id: string, provider?: string) {
  const head = (await c.query('SELECT provider FROM channels WHERE id=$1', [id])).rows[0];
  ensure(head && (!provider || head.provider === provider), 404, 'Kanał jest niedostępny');
  await acquireMappingOAuthInTx(c, a, head.provider);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [id])).rows[0];
  ensure(Object.hasOwn(mappingSourceKinds, ch.provider), 422, 'Adapter nie obsługuje tych mapowań');
  if (ch.provider === 'shopify') await shopifyAccountPolicy(c, ch);
  const binding =
    ch.provider === 'shopify'
      ? (await c.query('SELECT * FROM shopify_account_bindings WHERE channel_id=$1', [id])).rows[0]
      : undefined;
  return { ch, connection_hash: orderFieldMappingConnectionHash(ch, binding) };
}
export async function mappingProfileInTx(c: PoolClient, id: string) {
  const p = (await c.query('SELECT * FROM order_field_mapping_profiles WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono profilu');
  return p;
}
const profileHead = (p: any) => ({
  id: p.id,
  channel_id: p.channel_id,
  provider: p.provider,
  label: p.label,
  enabled: p.enabled,
  version: p.version,
  mappings: p.mappings,
  approved_by: p.approved_by,
  connection_hash: p.connection_hash,
  created_at: p.created_at,
  updated_at: p.updated_at,
});
export const mappingPreviewHead = (p: any) => ({
  id: p.id,
  kind: p.kind,
  profile_snapshot: p.profile_snapshot,
  definitions_snapshot: p.definitions_snapshot,
  scope_hash: p.scope_hash,
  policy: p.policy,
  warehouse_id: p.warehouse_id,
  summary: p.summary,
  expires_at: p.expires_at,
  created_at: p.created_at,
});
export const mappingExecutionHead = (e: any) => ({
  id: e.id,
  kind: e.kind,
  preview_id: e.preview_id,
  state: e.state,
  selected_count: e.selected_count,
  origin: e.origin,
  created_at: e.created_at,
  finished_at: e.finished_at,
  result: e.result,
  error: e.error,
});
export async function mappingPreviewInTx(c: PoolClient, id: string) {
  const p = (await c.query('SELECT * FROM order_field_mapping_previews WHERE id=$1', [id])).rows[0];
  ensure(p, 404, 'Nie znaleziono podglądu');
  return p;
}
export async function mappingExecutionInTx(c: PoolClient, id: string) {
  const e = (await c.query('SELECT * FROM order_field_mapping_executions WHERE id=$1', [id]))
    .rows[0];
  ensure(e, 404, 'Nie znaleziono wykonania');
  return e;
}
export async function mappingAclInTx(c: PoolClient, a: Actor, p: any, write = false) {
  return orderFieldBatchReadableDefinitionsInTx(
    c,
    a,
    (p.definitions_snapshot ?? p.mappings).map((d: any) => d.id ?? d.field_id),
    write,
    write
      ? () => mappingFinalGrantsInTx(c, a, p.profile_snapshot ?? p, p.kind === 'initial')
      : undefined,
  );
}
async function validateProfile(c: PoolClient, a: Actor, ch: any, mappings: OrderFieldMapping[]) {
  for (const m of mappings)
    ensure(
      (mappingSourceKinds as any)[ch.provider].includes(m.source.kind),
      422,
      'Źródło nie pasuje do adaptera',
    );
  const access = await orderFieldBatchReadableDefinitionsInTx(
    c,
    a,
    mappings.map((m) => m.field_id),
    true,
  );
  mappingAdmin(access.current_role);
  for (const m of mappings) {
    const d = access.definitions_snapshot.find((d) => d.id === m.field_id)!;
    ensure(
      d.enabled && d.version === m.definition_version && d.type === m.type,
      409,
      'Definicja profilu zmieniła się',
    );
    if (m.conversion.kind === 'option_map')
      for (const code of m.conversion.codes)
        ensure(
          d.options.some((o: any) => o.id === code.option_id && o.enabled),
          422,
          'Opcja nie należy do aktywnego własnego słownika',
        );
  }
  return access;
}
export async function orderFieldMappingMetadata(a: Actor) {
  const definitions = (await listOrderFields(a)).data.filter((d: any) => d.type !== 'file');
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const access = await orderFieldBatchReadableDefinitionsInTx(
      c,
      a,
      definitions.map((d: any) => d.id),
    );
    return {
      ...mappingFlags(access.current_role),
      definitions: access.definitions_snapshot,
      channels: (
        await c.query(
          "SELECT id,name,provider,coalesce((settings->>'simulation')::boolean,false) simulation FROM channels WHERE provider=ANY($1::text[]) ORDER BY name,id",
          [Object.keys(mappingSourceKinds)],
        )
      ).rows,
      warehouses: (await c.query('SELECT id,name FROM warehouses ORDER BY name,id')).rows,
      capabilities: Object.entries(mappingSourceKinds).map(([provider, source_kinds]) => ({
        provider,
        source_kinds,
        types: ['text', 'number', 'date', 'select', 'radio', 'multi_select'],
        verified_account_identity: provider === 'shopify',
      })),
      limits: {
        mappings: 20,
        reconcile_orders: 100,
        active_previews: 20,
        queued_executions: 20,
        stored_evidence_bytes: 104857600,
        observation_bytes: 5242880,
        preview_minutes: 15,
      },
    };
  });
}
export async function saveOrderFieldMappingProfile(a: Actor, body: unknown, id?: string) {
  const input = id
      ? orderFieldMappingProfilePatchSchema.parse(body)
      : orderFieldMappingProfileSchema.parse(body),
    requestHash = hash({ id: id ?? null, input });
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a, true);
    const old = (
      await c.query(
        'SELECT * FROM order_field_mapping_revisions WHERE actor_id=$1 AND client_key=$2',
        [a.userId, input.client_key],
      )
    ).rows[0];
    if (old) {
      ensure(old.request_hash === requestHash, 409, 'Klucz profilu wykorzystano dla innego body');
      const access = await mappingAclInTx(c, a, old.snapshot, true);
      mappingAdmin(access.current_role);
      return { ...mappingFlags(access.current_role), profile: old.snapshot, reused: true };
    }
    const p = id ? await mappingProfileInTx(c, id) : null,
      channelId = p?.channel_id ?? (input as any).channel_id;
    if (p) ensure(p.version === (input as any).version, 409, 'Profil zmienił wersję');
    else
      ensure(
        !(
          await c.query('SELECT id FROM order_field_mapping_profiles WHERE channel_id=$1', [
            channelId,
          ])
        ).rowCount,
        409,
        'Kanał ma już profil',
      );
    const { ch, connection_hash } = await mappingChannelInTx(c, a, channelId),
      access = await validateProfile(c, a, ch, input.mappings);
    let saved: any;
    if (p)
      saved = (
        await c.query(
          'UPDATE order_field_mapping_profiles SET label=$2,enabled=$3,mappings=$4,version=version+1,connection_hash=$5,approved_by=$6,updated_at=now() WHERE id=$1 RETURNING *',
          [
            id,
            input.label,
            input.enabled,
            JSON.stringify(input.mappings),
            connection_hash,
            a.userId,
          ],
        )
      ).rows[0];
    else
      saved = (
        await c.query(
          'INSERT INTO order_field_mapping_profiles(id,tenant_id,channel_id,provider,label,enabled,mappings,connection_hash,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [
            randomUUID(),
            a.tenantId,
            channelId,
            ch.provider,
            input.label,
            input.enabled,
            JSON.stringify(input.mappings),
            connection_hash,
            a.userId,
          ],
        )
      ).rows[0];
    const snapshot = profileHead(saved);
    await c.query(
      'INSERT INTO order_field_mapping_revisions(tenant_id,profile_id,version,actor_id,client_key,request_hash,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        a.tenantId,
        saved.id,
        saved.version,
        a.userId,
        input.client_key,
        requestHash,
        JSON.stringify(snapshot),
      ],
    );
    await audit(c, a, 'order.fields_mapping_profile', saved.id, {
      version: saved.version,
      snapshot_hash: hash(snapshot),
    });
    return { ...mappingFlags(access.current_role), profile: snapshot, reused: false };
  });
}
export async function orderFieldMappingProfileDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const p = await mappingProfileInTx(c, id),
      access = await mappingAclInTx(c, a, p);
    return { ...mappingFlags(access.current_role), profile: profileHead(p) };
  });
}
export async function orderFieldMappingProfiles(a: Actor, after?: string, id?: string) {
  let revisionPage: [string, number] | null = null;
  if (id && after)
    try {
      revisionPage = z
        .tuple([z.iso.datetime(), z.number().int().positive()])
        .parse(JSON.parse(Buffer.from(after, 'base64url').toString()));
    } catch {
      throw new Problem(422, 'Niepoprawny kursor rewizji');
    }
  const page = id ? revisionPage : cp(after);
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const args: any[] = id ? [id] : [];
    if (page) args.push(...page);
    const table = id ? 'order_field_mapping_revisions' : 'order_field_mapping_profiles';
    const data = (
      await c.query(
        `SELECT *,${mappingInstant('created_at')} cursor_time FROM ${table} WHERE true ${id ? 'AND profile_id=$1' : ''} ${page ? `AND (created_at,${id ? 'version' : 'id'})<($${id ? 2 : 1}::timestamptz,$${id ? 3 : 2}::${id ? 'int' : 'uuid'})` : ''} ORDER BY created_at DESC,${id ? 'version' : 'id'} DESC LIMIT 21`,
        args,
      )
    ).rows;
    for (const p of data.slice(0, 20)) await mappingAclInTx(c, a, id ? p.snapshot : p);
    const role = await orderFieldCurrentRole(c, a);
    return {
      ...mappingFlags(role),
      data: data
        .slice(0, 20)
        .map((p) =>
          id
            ? {
                profile_id: p.profile_id,
                version: p.version,
                snapshot: p.snapshot,
                created_at: p.created_at,
              }
            : profileHead(p),
        ),
      meta: {
        cursor:
          data.length > 20
            ? id
              ? Buffer.from(JSON.stringify([data[19].cursor_time, data[19].version])).toString(
                  'base64url',
                )
              : historyCursor(data[19])
            : null,
      },
    };
  });
}
export async function observeOrderFieldSourceInTx(
  c: PoolClient,
  a: Actor,
  ch: any,
  inbound: any,
  raw: any,
  opts: { sourceHash: string },
) {
  if (
    !Object.hasOwn(mappingSourceKinds, ch.provider) ||
    !(await c.query("SELECT to_regclass('public.order_field_source_observations') present")).rows[0]
      .present
  )
    return null;
  const p = (
    await c.query('SELECT * FROM order_field_mapping_profiles WHERE channel_id=$1 AND enabled', [
      ch.id,
    ])
  ).rows[0];
  if (!p) return null;
  // No definition/admission/member locks: staging records evidence only.
  const current = (await c.query('SELECT * FROM channels WHERE id=$1', [ch.id])).rows[0];
  const binding =
    ch.provider === 'shopify'
      ? (await c.query('SELECT * FROM shopify_account_bindings WHERE channel_id=$1', [ch.id]))
          .rows[0]
      : undefined;
  let connection: string;
  try {
    connection = orderFieldMappingConnectionHash(current, binding);
    if (
      connection !== orderFieldMappingConnectionHash(ch, binding) ||
      connection !== p.connection_hash
    )
      return null;
  } catch (e) {
    if (e instanceof Problem) return null;
    throw e;
  }
  const live = (
    await c.query(
      `SELECT id,source_hash,${epoch('updated_at')} FROM inbound_orders WHERE id=$1 AND channel_id=$2`,
      [inbound.id, ch.id],
    )
  ).rows[0];
  ensure(live?.source_hash === opts.sourceHash, 409, 'Źródło zmieniło się podczas obserwacji');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `order-field-observation-quota:${a.tenantId}`,
  ]);
  const old = (
    await c.query(
      'SELECT id FROM order_field_source_observations WHERE inbound_id=$1 AND profile_id=$2 AND profile_version=$3 AND source_hash=$4 AND connection_hash=$5 AND source_epoch=$6::timestamptz',
      [inbound.id, p.id, p.version, opts.sourceHash, connection, live.source_epoch_text],
    )
  ).rows[0];
  if (old) return old.id;
  const values = captureOrderFieldMappingSources(ch.provider, raw, p.mappings),
    bytes = Buffer.from(JSON.stringify(values));
  ensure(bytes.length <= 5242880, 422, 'Dowód źródła przekracza 5 MiB');
  // Capacity doesn't turn an existing source/payment flow into a field mutation.
  const total = Number(
    (
      await c.query(
        'SELECT coalesce(sum(byte_count),0)::bigint n FROM order_field_source_observations',
      )
    ).rows[0].n,
  );
  if (total + bytes.length > 104857600) return null;
  const id = randomUUID();
  await c.query(
    'INSERT INTO order_field_source_observations(id,tenant_id,inbound_id,channel_id,profile_id,profile_version,provider,external_id,source_hash,connection_hash,source_epoch,encrypted_bytes,byte_count,file_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
    [
      id,
      a.tenantId,
      inbound.id,
      ch.id,
      p.id,
      p.version,
      ch.provider,
      String(raw.id),
      opts.sourceHash,
      connection,
      live.source_epoch_text,
      encrypt({ content_base64: bytes.toString('base64') }),
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
    ],
  );
  return id;
}
export async function mappingObservationInTx(c: PoolClient, id: string) {
  const o = (
    await c.query(
      `SELECT *,${epoch('source_epoch')} FROM order_field_source_observations WHERE id=$1`,
      [id],
    )
  ).rows[0];
  ensure(o, 404, 'Brak własnej obserwacji źródła');
  return o;
}
export function mappingObservationValues(o: any) {
  const bytes = Buffer.from(decrypt(o.encrypted_bytes).content_base64, 'base64');
  ensure(
    bytes.length === o.byte_count &&
      createHash('sha256').update(bytes).digest('hex') === o.file_hash,
    409,
    'Dowód źródła nie przechodzi hash/size',
  );
  return JSON.parse(bytes.toString());
}
export async function orderFieldMappingSourceDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const o = await mappingObservationInTx(c, id),
      rev = (
        await c.query(
          'SELECT snapshot FROM order_field_mapping_revisions WHERE profile_id=$1 AND version=$2',
          [o.profile_id, o.profile_version],
        )
      ).rows[0];
    const access = await mappingAclInTx(c, a, rev.snapshot);
    return {
      ...mappingFlags(access.current_role),
      id: o.id,
      inbound_id: o.inbound_id,
      profile_id: o.profile_id,
      profile_version: o.profile_version,
      source_hash: o.source_hash,
      source_epoch: o.source_epoch_text,
      connection_hash: o.connection_hash,
      provider: o.provider,
      observed_at: o.created_at,
      values: mappingObservationValues(o),
      issues: [],
    };
  });
}
export async function orderFieldMappingSources(a: Actor, channelId: string, after?: string) {
  const page = cp(after);
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const p = (
      await c.query('SELECT * FROM order_field_mapping_profiles WHERE channel_id=$1', [channelId])
    ).rows[0];
    const access = p
      ? await mappingAclInTx(c, a, p)
      : { current_role: await orderFieldCurrentRole(c, a) };
    const args: any[] = [channelId];
    if (page) args.push(...page);
    const data = (
      await c.query(
        `SELECT i.id,i.id inbound_id,i.external_id,i.state,i.source_hash,${mappingInstant('i.updated_at')} source_epoch,o.version::float8 order_version,i.order_id,s.id observation_id,s.created_at observed_at,${mappingInstant('i.updated_at')} cursor_time FROM inbound_orders i LEFT JOIN orders o ON(o.tenant_id,o.id)=(i.tenant_id,i.order_id) LEFT JOIN order_field_mapping_profiles p ON(p.tenant_id,p.channel_id)=(i.tenant_id,i.channel_id) LEFT JOIN LATERAL(SELECT s.id,s.created_at FROM order_field_source_observations s WHERE s.tenant_id=i.tenant_id AND s.inbound_id=i.id AND s.profile_id=p.id AND s.profile_version=p.version AND s.source_hash=i.source_hash AND s.source_epoch=i.updated_at AND s.connection_hash=p.connection_hash ORDER BY s.created_at DESC,s.id DESC LIMIT 1)s ON true WHERE i.channel_id=$1 ${page ? 'AND (i.updated_at,i.id)<($2::timestamptz,$3::uuid)' : ''} ORDER BY i.updated_at DESC,i.id DESC LIMIT 21`,
        args,
      )
    ).rows;
    return {
      ...mappingFlags(access.current_role),
      data: data
        .slice(0, 20)
        .map(({ cursor_time, id, ...r }) => ({ ...r, needs_observation: !r.observation_id })),
      meta: { cursor: data.length > 20 ? historyCursor(data[19]) : null },
    };
  });
}
export async function lockMappingOrdersInTx(c: PoolClient, ids: string[], write: boolean) {
  if (ids.length)
    await c.query(
      `SELECT id FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [[...new Set(ids)].sort()],
    );
}
export async function lockMappingInboundsInTx(c: PoolClient, ids: string[]) {
  return (
    await c.query(
      `SELECT *,${epoch('updated_at')} FROM inbound_orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[...new Set(ids)].sort()],
    )
  ).rows;
}
export async function mappingFinalGrantsInTx(c: PoolClient, a: Actor, p: any, initial = false) {
  const roles = new Map<string, string>();
  for (const id of [...new Set([a.userId, p.approved_by])].sort())
    roles.set(id, await orderFieldCurrentRole(c, { ...a, userId: id }));
  mappingAdmin(roles.get(p.approved_by)!);
  if (initial) mappingAdmin(roles.get(a.userId)!);
  else writer(roles.get(a.userId)!);
  return roles.get(a.userId)!;
}
export async function mappingSourceFenceInTx(
  c: PoolClient,
  a: Actor,
  p: any,
  selected: any[],
  inbounds?: any[],
) {
  const current = await mappingProfileInTx(c, p.profile_id),
    { connection_hash } = await mappingChannelInTx(c, a, current.channel_id, current.provider);
  ensure(
    current.enabled &&
      current.version === p.profile_version &&
      hash(profileHead(current)) === hash(p.profile_snapshot) &&
      connection_hash === current.connection_hash,
    409,
    'Profil lub połączenie zmieniło się',
  );
  const live =
    inbounds ??
    (await lockMappingInboundsInTx(
      c,
      selected.map((r) => (r.snapshot ?? r).inbound_id),
    ));
  for (const r of selected) {
    const s = r.snapshot ?? r,
      i = live.find((i) => i.id === s.inbound_id),
      o = await mappingObservationInTx(c, s.observation_id),
      values = mappingObservationValues(o),
      converted = convertOrderFieldMappingSources(current.mappings, values);
    ensure(
      i &&
        i.channel_id === current.channel_id &&
        i.source_hash === s.source_hash &&
        i.source_epoch_text === s.source_epoch &&
        (p.kind === 'initial' ? !i.order_id : i.order_id === s.order_id) &&
        o.inbound_id === i.id &&
        o.profile_id === current.id &&
        o.profile_version === current.version &&
        o.source_hash === s.source_hash &&
        o.source_epoch_text === s.source_epoch &&
        o.connection_hash === connection_hash &&
        hash(values) === hash(s.source_values) &&
        !converted.issues.length &&
        hash(converted.changes) === hash(s.changes),
      409,
      'Obserwacja, źródło lub powiązanie zamówienia zmieniły się',
    );
  }
  return current;
}
export async function mappingRowsInTx(
  c: PoolClient,
  id: string,
  selected?: string[],
  after?: string,
) {
  const pos = rowCp(after);
  return (
    await c.query(
      `SELECT * FROM order_field_mapping_rows WHERE preview_id=$1 ${selected ? 'AND id=ANY($2::uuid[])' : pos !== null ? 'AND position>$2' : ''} ORDER BY position,id ${selected ? '' : 'LIMIT 51'}`,
      selected ? [id, selected] : pos !== null ? [id, pos] : [id],
    )
  ).rows;
}
export async function verifyMappingPreviewScopeInTx(c: PoolClient, p: any) {
  const all = (
    await c.query(
      'SELECT * FROM order_field_mapping_rows WHERE preview_id=$1 ORDER BY position,id',
      [p.id],
    )
  ).rows;
  ensure(
    all.length === p.summary.total &&
      all.length >= 1 &&
      all.length <= 100 &&
      all.every(
        (r) =>
          r.id === r.snapshot.row_id &&
          r.position === r.snapshot.position &&
          r.inbound_id === r.snapshot.inbound_id &&
          r.observation_id === r.snapshot.observation_id &&
          r.order_id === r.snapshot.order_id &&
          Number(r.order_version ?? 0) === Number(r.snapshot.order_version ?? 0) &&
          r.status === r.snapshot.status,
      ),
    409,
    'Niezmienny zakres podglądu nie jest spójny',
  );
  ensure(
    hash({
      profile: p.profile_snapshot,
      definitions: p.definitions_snapshot,
      kind: p.kind,
      policy: p.policy,
      warehouse_id: p.warehouse_id,
      rows: all.map((r) => r.snapshot),
    }) === p.scope_hash,
    409,
    'Niezmienny zakres podglądu zmienił się',
  );
}
export const mappingPublicRow = (r: any) => {
  const { effective_changes, ...wire } = r.snapshot ?? r;
  return wire;
};
const rowsPage = (data: any[]) => ({
  data: data.slice(0, 50).map(mappingPublicRow),
  meta: {
    cursor:
      data.length > 50
        ? Buffer.from(JSON.stringify(data[49].position)).toString('base64url')
        : null,
  },
});
export async function createOrderFieldMappingPreview(
  a: Actor,
  body: OrderFieldMappingPreviewInput,
  origin: 'manual' | 'api' = 'manual',
) {
  const input = orderFieldMappingPreviewSchema.parse(body),
    requestHash = hash({ input, origin });
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `order-field-mapping-preview:${a.tenantId}`,
    ]);
    const old = (
      await c.query(
        'SELECT * FROM order_field_mapping_previews WHERE actor_id=$1 AND client_key=$2',
        [a.userId, input.client_key],
      )
    ).rows[0];
    if (old) {
      ensure(old.request_hash === requestHash, 409, 'Klucz podglądu wykorzystano dla innego body');
      const access = await mappingAclInTx(c, a, old, true);
      if (old.kind === 'initial') mappingAdmin(access.current_role);
      else writer(access.current_role);
      return {
        ...mappingPreviewHead(old),
        ...rowsPage(await mappingRowsInTx(c, old.id)),
        ...mappingFlags(access.current_role),
        reused: true,
      };
    }
    ensure(
      (
        await c.query(
          'SELECT count(*)::int n FROM order_field_mapping_previews WHERE expires_at>now()',
        )
      ).rows[0].n < 20,
      429,
      'Limit 20 aktywnych podglądów',
    );
    const profile = await mappingProfileInTx(c, input.profile_id);
    ensure(profile.enabled && profile.version === input.profile_version, 409, 'Profil zmienił się');
    await acquireMappingOAuthInTx(c, a, profile.provider);
    if (input.kind === 'reconcile')
      await lockMappingOrdersInTx(
        c,
        input.orders.map((o) => o.order_id),
        false,
      );
    const selectors = input.kind === 'initial' ? [input] : input.orders,
      inbounds = await lockMappingInboundsInTx(
        c,
        selectors.map((s) => s.inbound_id),
      );
    const { connection_hash } = await mappingChannelInTx(
      c,
      a,
      profile.channel_id,
      profile.provider,
    );
    ensure(
      connection_hash === profile.connection_hash,
      409,
      'Zatwierdź profil dla aktualnego połączenia',
    );
    const fieldIds = profile.mappings.map((m: any) => m.field_id),
      access = await orderFieldBatchReadableDefinitionsInTx(c, a, fieldIds, true, () =>
        mappingFinalGrantsInTx(c, a, profile, input.kind === 'initial'),
      );
    if (input.kind === 'initial') mappingAdmin(access.current_role);
    else writer(access.current_role);
    await mappingFinalGrantsInTx(c, a, profile, input.kind === 'initial');
    const snapshots: any[] = [],
      observed: any[] = [];
    for (let position = 0; position < selectors.length; position++) {
      const s = selectors[position],
        i = inbounds.find((i) => i.id === s.inbound_id),
        o = await mappingObservationInTx(c, s.observation_id);
      ensure(
        i &&
          i.channel_id === profile.channel_id &&
          o.inbound_id === i.id &&
          o.profile_id === profile.id &&
          o.profile_version === profile.version &&
          o.source_hash === s.source_hash &&
          i.source_hash === s.source_hash &&
          o.source_epoch_text === i.source_epoch_text &&
          o.connection_hash === connection_hash,
        409,
        'Brak bieżącej obserwacji tego źródła/profilu',
      );
      ensure(
        input.kind === 'initial' ? !i.order_id : i.order_id === (s as any).order_id,
        409,
        'Źródło nie jest związane z wybranym zamówieniem',
      );
      const source_values = mappingObservationValues(o),
        converted = convertOrderFieldMappingSources(profile.mappings, source_values),
        row_id = randomUUID();
      const listing_snapshot =
        input.kind === 'initial'
          ? (
              await c.query(
                'SELECT id,external_id,product_id FROM listings WHERE channel_id=$1 AND external_id=ANY($2::text[]) ORDER BY id',
                [
                  profile.channel_id,
                  (i.normalized?.items ?? []).map((item: any) => item.external_id),
                ],
              )
            ).rows
          : undefined;
      if (
        input.kind === 'initial' &&
        (!i.normalized ||
          i.normalized.blockers?.length ||
          (i.normalized.items ?? []).some(
            (item: any) => !listing_snapshot!.some((l) => l.external_id === item.external_id),
          ))
      )
        converted.issues.push({
          code: 'import_not_ready',
          message: 'Źródło lub powiązanie pozycji wymaga poprawy przed importem',
        });
      const row = {
        row_id,
        position,
        inbound_id: i.id,
        observation_id: o.id,
        source_hash: s.source_hash,
        source_epoch: o.source_epoch_text,
        connection_hash,
        external_id: i.external_id,
        order_id: input.kind === 'initial' ? null : (s as any).order_id,
        order_version: input.kind === 'initial' ? null : (s as any).order_version,
        order_number: null,
        source_values,
        changes: converted.changes,
        skipped: converted.skipped,
        issues: converted.issues,
        before: [],
        after: [],
        effective_changes: [],
        status: 'invalid',
        ...(input.kind === 'initial'
          ? {
              listing_snapshot,
              order_summary: {
                customer_name: i.normalized?.customer_name,
                currency: i.normalized?.currency,
                total: i.normalized?.total,
                shipping_cost: i.normalized?.shipping_cost,
                items: (i.normalized?.items ?? []).map(
                  ({ external_id, name, quantity, line_total }: any) => ({
                    external_id,
                    name,
                    quantity,
                    line_total,
                  }),
                ),
                warehouse_id: input.warehouse_id,
                stock_action: 'reserve_on_import',
              },
            }
          : {}),
      };
      observed.push(row);
    }
    if (input.kind === 'initial') {
      ensure(
        (await c.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouse_id])).rowCount,
        404,
        'Brak własnego magazynu',
      );
      const row = observed[0];
      if (!row.issues.length)
        try {
          const frozen = await freezeMappedInitialValuesInTx(c, a, row.changes, fieldIds);
          row.before = row.changes.map((ch: any) => ({ field_id: ch.field_id, value: null }));
          row.after = frozen.after;
          row.effective_changes = row.changes;
          row.status = row.changes.length ? 'ready' : 'no_op';
        } catch (e) {
          if (e instanceof Problem && e.status === 403) throw e;
          row.issues.push({
            code: 'value_invalid',
            message: e instanceof Problem ? e.message : 'Niepoprawna wartość',
          });
          row.status = e instanceof Problem && e.status === 409 ? 'conflict' : 'invalid';
        }
      snapshots.push(row);
    } else {
      const prepared = await prepareOrderFieldBatchRowsInTx(c, a, observed, {
        policy: input.policy,
        writeLocks: false,
      });
      for (let i = 0; i < prepared.rows.length; i++) {
        const r = prepared.rows[i];
        snapshots.push({ ...observed[i], ...r, skipped: [...observed[i].skipped, ...r.skipped] });
      }
    }
    const summary = {
        total: snapshots.length,
        ready: snapshots.filter((r) => r.status === 'ready').length,
        no_op: snapshots.filter((r) => r.status === 'no_op').length,
        invalid: snapshots.filter((r) => r.status === 'invalid').length,
        conflict: snapshots.filter((r) => r.status === 'conflict').length,
      },
      id = randomUUID(),
      scopeHash = hash({
        profile: profileHead(profile),
        definitions: access.definitions_snapshot,
        kind: input.kind,
        policy: input.kind === 'initial' ? 'fill_unset' : input.policy,
        warehouse_id: input.kind === 'initial' ? input.warehouse_id : null,
        rows: snapshots,
      });
    const p = (
      await c.query(
        "INSERT INTO order_field_mapping_previews(id,tenant_id,actor_id,client_key,request_hash,scope_hash,kind,policy,origin,profile_id,profile_version,profile_snapshot,definitions_snapshot,warehouse_id,summary,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now()+interval '15 minutes') RETURNING *",
        [
          id,
          a.tenantId,
          a.userId,
          input.client_key,
          requestHash,
          scopeHash,
          input.kind,
          input.kind === 'initial' ? 'fill_unset' : input.policy,
          origin,
          profile.id,
          profile.version,
          JSON.stringify(profileHead(profile)),
          JSON.stringify(access.definitions_snapshot),
          input.kind === 'initial' ? input.warehouse_id : null,
          JSON.stringify(summary),
        ],
      )
    ).rows[0];
    await c.query(
      'INSERT INTO order_field_mapping_rows(id,tenant_id,preview_id,profile_id,profile_version,position,inbound_id,observation_id,order_id,order_version,status,snapshot) SELECT x.id,$1,$2,$3,$4,x.position,x.inbound_id,x.observation_id,x.order_id,x.order_version,x.status,x.snapshot FROM jsonb_to_recordset($5::jsonb) AS x(id uuid,position int,inbound_id uuid,observation_id uuid,order_id uuid,order_version bigint,status text,snapshot jsonb)',
      [
        a.tenantId,
        id,
        profile.id,
        profile.version,
        JSON.stringify(
          snapshots.map((s) => ({
            id: s.row_id,
            position: s.position,
            inbound_id: s.inbound_id,
            observation_id: s.observation_id,
            order_id: s.order_id,
            order_version: s.order_version,
            status: s.status,
            snapshot: s,
          })),
        ),
      ],
    );
    await audit(c, a, 'order.fields_mapping_preview', id, {
      scope_hash: scopeHash,
      kind: input.kind,
      summary,
    });
    return {
      ...mappingPreviewHead(p),
      ...rowsPage(await mappingRowsInTx(c, id)),
      ...mappingFlags(access.current_role),
      reused: false,
    };
  });
}
export async function orderFieldMappingPreviewDetail(a: Actor, id: string, after?: string) {
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const p = await mappingPreviewInTx(c, id),
      access = await mappingAclInTx(c, a, p);
    return {
      ...mappingPreviewHead(p),
      ...rowsPage(await mappingRowsInTx(c, id, undefined, after)),
      ...mappingFlags(access.current_role),
    };
  });
}
export async function orderFieldMappingHistory(
  a: Actor,
  kind: 'previews' | 'executions',
  after?: string,
) {
  const page = cp(after);
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const table =
        kind === 'previews' ? 'order_field_mapping_previews' : 'order_field_mapping_executions',
      data = (
        await c.query<any>(
          `SELECT *,${mappingInstant('created_at')} cursor_time FROM ${table} ${page ? 'WHERE (created_at,id)<($1::timestamptz,$2::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`,
          page ? [...page] : [],
        )
      ).rows;
    for (const row of data.slice(0, 20))
      await mappingAclInTx(
        c,
        a,
        kind === 'previews' ? row : await mappingPreviewInTx(c, row.preview_id),
      );
    const role = await orderFieldCurrentRole(c, a);
    return {
      ...mappingFlags(role),
      data: data
        .slice(0, 20)
        .map((row) => (kind === 'previews' ? mappingPreviewHead(row) : mappingExecutionHead(row))),
      meta: { cursor: data.length > 20 ? historyCursor(data[19]) : null },
    };
  });
}
export async function verifyMappingReconcileInTx(c: PoolClient, a: Actor, p: any, selected: any[]) {
  ensure(
    p.kind === 'reconcile' && new Date(p.expires_at).getTime() > Date.now(),
    409,
    'Podgląd wygasł lub ma inny typ',
  );
  await acquireMappingOAuthInTx(c, a, p.profile_snapshot.provider);
  await verifyMappingPreviewScopeInTx(c, p);
  await lockMappingOrdersInTx(
    c,
    selected.map((r) => r.snapshot.order_id),
    true,
  );
  const inbounds = await lockMappingInboundsInTx(
      c,
      selected.map((r) => r.snapshot.inbound_id),
    ),
    current = await mappingSourceFenceInTx(c, a, p, selected, inbounds);
  const access = await mappingAclInTx(c, a, p, true);
  writer(access.current_role);
  await mappingFinalGrantsInTx(c, a, current);
  ensure(
    hash(access.definitions_snapshot) === hash(p.definitions_snapshot),
    409,
    'Definicje mapowania zmieniły się',
  );
  const inputs = selected.map((r) => {
    const {
      skipped,
      before,
      after,
      status,
      effective_changes,
      order_number,
      source_values,
      source_epoch,
      connection_hash,
      external_id,
      inbound_id,
      observation_id,
      source_hash,
      ...base
    } = r.snapshot;
    return { ...base, issues: [] };
  });
  const fresh = await prepareOrderFieldBatchRowsInTx(c, a, inputs, {
    policy: p.policy,
    writeLocks: true,
  });
  ensure(
    fresh.rows.every((r) => ['ready', 'no_op'].includes(r.status)),
    409,
    'Wybrany zakres nie jest gotowy',
  );
  for (let i = 0; i < selected.length; i++) {
    const old = selected[i].snapshot,
      n = fresh.rows[i];
    ensure(
      hash({
        before: n.before,
        after: n.after,
        effective_changes: n.effective_changes,
        status: n.status,
      }) ===
        hash({
          before: old.before,
          after: old.after,
          effective_changes: old.effective_changes,
          status: old.status,
        }),
      409,
      'Zamrożone wartości lub wersje zmieniły się',
    );
  }
  return fresh;
}
export async function queueOrderFieldMapping(
  a: Actor,
  id: string,
  body: z.infer<typeof orderFieldMappingQueueSchema>,
  origin: 'manual' | 'api' = 'manual',
) {
  const input = orderFieldMappingQueueSchema.parse(body),
    requestHash = hash({ preview_id: id, input, origin });
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `order-field-mapping-execution:${a.tenantId}`,
    ]);
    const p = await mappingPreviewInTx(c, id),
      old = (
        await c.query(
          'SELECT * FROM order_field_mapping_executions WHERE actor_id=$1 AND client_key=$2',
          [a.userId, input.client_key],
        )
      ).rows[0];
    if (old) {
      ensure(old.request_hash === requestHash, 409, 'Klucz wykonania wykorzystano dla innego body');
      const access = await mappingAclInTx(c, a, p, true);
      writer(access.current_role);
      return {
        ...mappingFlags(access.current_role),
        execution: mappingExecutionHead(old),
        reused: true,
      };
    }
    ensure(
      new Set(input.selected_rows).size === input.selected_rows.length &&
        input.consent.selected_count === input.selected_rows.length &&
        input.consent.scope_hash === p.scope_hash &&
        input.consent.policy === p.policy,
      422,
      'Zgoda nie odpowiada podglądowi',
    );
    const selected = await mappingRowsInTx(c, id, input.selected_rows);
    ensure(
      selected.length === input.selected_rows.length &&
        selected.every((r) => ['ready', 'no_op'].includes(r.status)),
      409,
      'Wybór nie jest gotowy lub nie należy do podglądu',
    );
    const fresh = await verifyMappingReconcileInTx(c, a, p, selected);
    ensure(
      (
        await c.query(
          "SELECT count(*)::int n FROM order_field_mapping_executions WHERE state='queued'",
        )
      ).rows[0].n < 20,
      429,
      'Limit 20 queued wykonań',
    );
    const executionId = randomUUID(),
      jobId = randomUUID();
    await c.query(
      'INSERT INTO jobs(id,tenant_id,kind,dedup_key,payload,max_attempts) VALUES($1,$2,$3,$4,$5,1)',
      [
        jobId,
        a.tenantId,
        ORDER_FIELD_MAPPING_JOB,
        ORDER_FIELD_MAPPING_JOB + ':' + executionId,
        JSON.stringify({ execution_id: executionId }),
      ],
    );
    const e = (
      await c.query(
        'INSERT INTO order_field_mapping_executions(id,tenant_id,preview_id,kind,actor_id,client_key,request_hash,selection_hash,selected_count,consent,origin,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [
          executionId,
          a.tenantId,
          id,
          'reconcile',
          a.userId,
          input.client_key,
          requestHash,
          hash(selected.map((r) => r.id)),
          selected.length,
          JSON.stringify(input.consent),
          origin,
          jobId,
        ],
      )
    ).rows[0];
    await c.query(
      'INSERT INTO order_field_mapping_execution_rows(tenant_id,execution_id,preview_id,row_id) SELECT $1,$2,$3,unnest($4::uuid[])',
      [a.tenantId, e.id, id, selected.map((r) => r.id)],
    );
    await audit(c, a, 'order.fields_mapping_queued', e.id, {
      preview_id: id,
      scope_hash: p.scope_hash,
      selection_hash: e.selection_hash,
      selected_count: selected.length,
    });
    return {
      ...mappingFlags(fresh.current_role),
      execution: mappingExecutionHead(e),
      reused: false,
    };
  });
}
export async function mappingSelectedRowsInTx(c: PoolClient, e: any) {
  return (
    await c.query(
      'SELECT r.* FROM order_field_mapping_execution_rows s JOIN order_field_mapping_rows r ON(r.tenant_id,r.preview_id,r.id)=(s.tenant_id,s.preview_id,s.row_id) WHERE s.execution_id=$1 ORDER BY r.position,r.id',
      [e.id],
    )
  ).rows;
}
export const mappingProvenance = (p: any, e: any, s: any) => ({
  profile_id: p.profile_id,
  profile_version: p.profile_version,
  observation_id: s.observation_id,
  preview_id: p.id,
  execution_id: e.id,
  row_id: s.row_id,
  channel_id: p.profile_snapshot.channel_id,
  inbound_id: s.inbound_id,
  source_hash: s.source_hash,
  source_epoch: s.source_epoch,
  connection_hash: s.connection_hash,
});
export async function orderFieldMappingExecutionDetail(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const e = await mappingExecutionInTx(c, id),
      p = await mappingPreviewInTx(c, e.preview_id),
      access = await mappingAclInTx(c, a, p);
    return {
      ...mappingExecutionHead(e),
      ...mappingFlags(access.current_role),
      consent: e.consent,
      data: (await mappingSelectedRowsInTx(c, e)).map((r) => ({
        ...mappingPublicRow(r),
        result: e.result?.rows?.find((v: any) => v.row_id === r.id) ?? null,
      })),
    };
  });
}
export async function processOrderFieldMappingJob(job: any) {
  z.uuid().parse(job.id);
  z.uuid().parse(job.tenant_id);
  z.uuid().parse(job.lease_token);
  z.strictObject({ execution_id: z.uuid() }).parse(job.payload);
  return tenantTx(job.tenant_id, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, { tenantId: job.tenant_id, userId: null });
    const live = (
      await c.query(
        "SELECT * FROM jobs WHERE id=$1 AND kind=$2 AND state='running' AND lease_token=$3 FOR UPDATE",
        [job.id, ORDER_FIELD_MAPPING_JOB, job.lease_token],
      )
    ).rows[0];
    if (!live) return;
    const e = (
      await c.query('SELECT * FROM order_field_mapping_executions WHERE job_id=$1 FOR UPDATE', [
        live.id,
      ])
    ).rows[0];
    ensure(
      e && live.payload.execution_id === e.id && hash(live.payload) === hash(job.payload),
      409,
      'Zadanie nie odpowiada wykonaniu',
    );
    if (e.state !== 'queued') {
      await c.query("UPDATE jobs SET state='done',locked_at=NULL,lease_token=NULL WHERE id=$1", [
        live.id,
      ]);
      return;
    }
    const a: Actor = { tenantId: job.tenant_id, userId: e.actor_id, role: 'operator' };
    await c.query('SAVEPOINT mapping_effects');
    try {
      const p = await mappingPreviewInTx(c, e.preview_id),
        selected = await mappingSelectedRowsInTx(c, e);
      ensure(
        e.kind === 'reconcile' &&
          selected.length === e.selected_count &&
          e.selected_count === e.consent.selected_count &&
          hash(selected.map((r) => r.id)) === e.selection_hash &&
          e.consent.scope_hash === p.scope_hash &&
          e.consent.policy === p.policy &&
          e.consent.local_only === true,
        409,
        'Zgoda nie odpowiada dokładnemu wyborowi',
      );
      const prepared = await verifyMappingReconcileInTx(c, a, p, selected),
        byRow = new Map(selected.map((r) => [r.id, r.snapshot]));
      const result = await applyPreparedOrderFieldBatchInTx(c, a, prepared, {
        requestHash: e.request_hash,
        source: 'channel_import',
        provenance: (r) => mappingProvenance(p, e, byRow.get(r.row_id)),
      });
      await c.query(
        "UPDATE order_field_mapping_executions SET state='done',result=$2,finished_at=now() WHERE id=$1",
        [e.id, JSON.stringify(result)],
      );
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
        [live.id],
      );
      await c.query('RELEASE SAVEPOINT mapping_effects');
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT mapping_effects');
      const state = error instanceof Problem ? 'conflict' : 'failed',
        message =
          error instanceof Problem
            ? 'Zakres, wersja lub prawa zmieniły się'
            : 'Lokalne wykonanie nie zostało zatwierdzone';
      await c.query(
        'UPDATE order_field_mapping_executions SET state=$2,error=$3,finished_at=now() WHERE id=$1',
        [e.id, state, message],
      );
      await c.query(
        "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error=$2 WHERE id=$1",
        [live.id, message],
      );
    }
  });
}
export async function cancelOrderFieldMapping(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const head = await mappingExecutionInTx(c, id);
    ensure(head.kind === 'reconcile', 409, 'Initial receipt nie można anulować');
    await c.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [head.job_id]);
    const e = (
        await c.query('SELECT * FROM order_field_mapping_executions WHERE id=$1 FOR UPDATE', [id])
      ).rows[0],
      p = await mappingPreviewInTx(c, e.preview_id),
      access = await mappingAclInTx(c, a, p, true);
    writer(access.current_role);
    if (e.state === 'cancelled')
      return { ...mappingExecutionHead(e), ...mappingFlags(access.current_role) };
    ensure(e.state === 'queued', 409, 'Wykonanie jest zakończone');
    await c.query(
      "UPDATE order_field_mapping_executions SET state='cancelled',finished_at=now() WHERE id=$1",
      [id],
    );
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error='Anulowano przed zapisem' WHERE id=$1",
      [e.job_id],
    );
    await audit(c, a, 'order.fields_mapping_cancelled', id, { preview_id: p.id });
    return {
      ...mappingExecutionHead(await mappingExecutionInTx(c, id)),
      ...mappingFlags(access.current_role),
    };
  });
}
export async function reapOrderFieldMappingJobs() {
  const candidates = (
    await pool.query(
      "SELECT e.tenant_id,e.job_id FROM order_field_mapping_executions e JOIN jobs j ON(j.tenant_id,j.id)=(e.tenant_id,e.job_id) WHERE e.state='queued' AND j.state IN('failed','done') ORDER BY e.created_at,e.id LIMIT 25",
    )
  ).rows;
  let count = 0;
  for (const d of candidates)
    await tenantTx(d.tenant_id, async (c) => {
      await acquireOrderFieldsAdmissionInTx(c, { tenantId: d.tenant_id, userId: null });
      const j = (await c.query('SELECT state FROM jobs WHERE id=$1 FOR UPDATE', [d.job_id]))
        .rows[0];
      if (!j || !['failed', 'done'].includes(j.state)) return;
      count +=
        (
          await c.query(
            "UPDATE order_field_mapping_executions SET state='failed',error='Zadanie zakończyło się bez zatwierdzonego wyniku',finished_at=now() WHERE job_id=$1 AND state='queued'",
            [d.job_id],
          )
        ).rowCount ?? 0;
    });
  return count;
}
