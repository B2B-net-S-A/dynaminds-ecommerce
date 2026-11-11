import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantTx } from './db';
import { audit, type Actor, type AuditActor } from './domain';
import { ensure, Problem } from './errors';
import { packingFieldsAvailableInTx } from './packing-order-field-requirements';
import { encrypt, decrypt } from './security';
import {
  orderFieldDefinitionSchema,
  orderFieldDefinitionPatchSchema,
  orderFieldPatchSchema,
  orderFieldFileSchema,
  orderFieldFiltersSchema,
  orderFieldColumnsSchema,
  initialOrderFieldsSchema,
  type OrderFieldChange,
} from './order-fields-schema';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Definition = Record<string, any>;
type Prepared = {
  definitions: Definition[];
  changes: OrderFieldChange[];
  manual: boolean;
  source?: 'manual' | 'api' | 'channel_import';
};
export async function acquireOrderFieldsAdmissionInTx(
  c: PoolClient,
  a: AuditActor,
  exclusive = false,
) {
  await c.query(
    `SELECT pg_advisory_xact_lock${exclusive ? '' : '_shared'}(hashtextextended($1,0))`,
    [`order-fields:${a.tenantId}`],
  );
}
export async function orderFieldCurrentRole(c: PoolClient, a: AuditActor) {
  ensure(a.userId, 403, 'Wymagany aktualny użytkownik');
  const role = (await c.query('SELECT order_field_role($1) role', [a.userId])).rows[0]?.role;
  ensure(role, 403, 'Brak aktualnego dostępu do firmy');
  return role as Actor['role'];
}
async function initialFieldRole(c: PoolClient, a: AuditActor, deferPrincipalPin = false) {
  if (!deferPrincipalPin) return orderFieldCurrentRole(c, a);
  ensure(a.userId, 403, 'Wymagany aktualny użytkownik');
  // External-intent creation has further proof/FK waits; its caller pins current
  // member/key grants only after those writes and deferred constraints complete.
  const role = (await c.query('SELECT b2b_dropship_current_role($1,false) role', [a.userId]))
    .rows[0]?.role;
  ensure(role, 403, 'Brak aktualnego dostępu do firmy');
  return role as Actor['role'];
}
const readable = (d: Definition, role: string) => role === 'admin' || d.read_role === 'team';
function writable(d: Definition, role: string) {
  ensure(
    readable(d, role) && (role === 'admin' || (role === 'operator' && d.write_role === 'operator')),
    403,
    'Brak aktualnego prawa do zapisu pola',
  );
}
function admin(role: string) {
  ensure(role === 'admin', 403, 'Wymagany aktualny administrator');
}
async function definitions(c: PoolClient, ids?: string[], lock = false): Promise<Definition[]> {
  const rows = (
    await c.query(
      `SELECT * FROM order_field_definitions ${ids ? 'WHERE id=ANY($1::uuid[])' : ''} ORDER BY id${lock ? ' FOR SHARE' : ''}`,
      ids ? [ids] : [],
    )
  ).rows;
  if (!rows.length) return [];
  const options = (
    await c.query(
      'SELECT id,field_id,label,enabled FROM order_field_options WHERE field_id=ANY($1::uuid[]) ORDER BY id',
      [rows.map((d) => d.id)],
    )
  ).rows;
  return rows.map((d) => ({
    ...d,
    options: options.filter((o) => o.field_id === d.id).map(({ field_id, ...o }) => o),
  }));
}
function viewDefinition(d: Definition, role: string) {
  return {
    ...d,
    scopes: ['order'],
    portal_visible: false,
    can_write:
      d.enabled && (role === 'admin' || (role === 'operator' && d.write_role === 'operator')),
  };
}
function canonicalDecimal(value: unknown, scale: number) {
  ensure(typeof value === 'string', 422, 'Liczba musi być stringiem dziesiętnym');
  const re = new RegExp(`^-?(?:0|[1-9][0-9]*)${scale ? `\\.[0-9]{${scale}}` : ''}$`);
  ensure(re.test(value as string), 422, 'Liczba wymaga kanonicznego formatu i dokładnej skali');
  const digits = (value as string).replace(/[-.]/g, '');
  ensure(digits.length <= 18, 422, 'Liczba przekracza 18 cyfr');
  const n = BigInt((value as string).replace('.', ''));
  ensure(!(n === 0n && (value as string).startsWith('-')), 422, 'Ujemne zero nie jest kanoniczne');
  return n;
}
function calendar(value: unknown) {
  ensure(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
    422,
    'Data wymaga YYYY-MM-DD',
  );
  const [y, m, d] = (value as string).split('-').map(Number),
    leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  ensure(
    y >= 1 &&
      m >= 1 &&
      m <= 12 &&
      d >= 1 &&
      d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1],
    422,
    'Niepoprawna data gregoriańska',
  );
}
function validateValue(d: Definition, value: unknown, allowRetired = false) {
  const config = d.config ?? {};
  switch (d.type) {
    case 'text':
      ensure(
        typeof value === 'string' &&
          Buffer.from(value, 'utf8').toString('utf8') === value &&
          !value.includes('\0') &&
          [...value].length <= (config.max_length ?? 4000) &&
          Buffer.byteLength(value) <= 16384,
        422,
        'Niepoprawny tekst lub przekroczony limit',
      );
      break;
    case 'number': {
      const n = canonicalDecimal(value, config.scale);
      if (config.min !== undefined)
        ensure(n >= canonicalDecimal(config.min, config.scale), 422, 'Liczba poniżej minimum');
      if (config.max !== undefined)
        ensure(n <= canonicalDecimal(config.max, config.scale), 422, 'Liczba powyżej maksimum');
      break;
    }
    case 'date':
      calendar(value);
      break;
    case 'select':
    case 'radio':
    case 'multi_select': {
      const ids =
        d.type === 'multi_select'
          ? z.array(z.uuid()).max(50).parse(value)
          : [z.uuid().parse(value)];
      ensure(new Set(ids).size === ids.length, 422, 'Powtórzone opcje');
      for (const id of ids)
        ensure(
          d.options.some((o: any) => o.id === id && (o.enabled || allowRetired)),
          422,
          'Opcja nie istnieje lub jest wycofana',
        );
      value = d.type === 'multi_select' ? [...ids].sort() : ids[0];
      break;
    }
    case 'file':
      z.uuid().parse(value);
      break;
  }
  return value;
}
function validateDefinition(input: any) {
  for (const text of [input.label, ...input.options.map((o: any) => o.label)])
    ensure(
      Buffer.from(text, 'utf8').toString('utf8') === text && !text.includes('\0'),
      422,
      'Etykieta wymaga poprawnego UTF-8 bez NUL',
    );
  ensure(
    input.read_role !== 'admin' || input.write_role === 'admin',
    422,
    'Pole admin-only nie może być zapisywane przez operatora',
  );
  ensure(
    new Set(input.required_on).size === input.required_on.length,
    422,
    'Powtórzony moment wymagania',
  );
  // pack_complete requires the exact installed native descriptor inside the writer TX.
  const choice = ['select', 'radio', 'multi_select'].includes(input.type);
  ensure(choice || input.options.length === 0, 422, 'Ten typ nie ma opcji');
  ensure(
    new Set(input.options.map((o: any) => o.id)).size === input.options.length,
    422,
    'Powtórzone opcje',
  );
  if (input.type === 'text')
    input.config = z
      .strictObject({
        max_length: z.number().int().min(1).max(4000).default(4000),
        default: z.string().optional(),
      })
      .parse(input.config);
  else if (input.type === 'number')
    input.config = z
      .strictObject({
        scale: z.number().int().min(0).max(6),
        min: z.string().optional(),
        max: z.string().optional(),
        default: z.string().optional(),
      })
      .parse(input.config);
  else if (input.type === 'file') {
    input.config = z.strictObject({}).parse(input.config);
    ensure(
      !input.required_on.includes('manual_create'),
      422,
      'Plik można dodać dopiero do istniejącego zamówienia',
    );
  } else input.config = z.strictObject({ default: z.unknown().optional() }).parse(input.config);
  if (input.type === 'number') {
    const { scale, min, max } = input.config;
    if (min !== undefined) canonicalDecimal(min, scale);
    if (max !== undefined) canonicalDecimal(max, scale);
    if (min !== undefined && max !== undefined)
      ensure(
        canonicalDecimal(min, scale) <= canonicalDecimal(max, scale),
        422,
        'Minimum przekracza maksimum',
      );
  }
  if (Object.hasOwn(input.config, 'default'))
    input.config.default = validateValue(input, input.config.default);
  return input;
}
async function request(c: PoolClient, a: Actor, kind: string, key: string, hash: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `order-fields-request:${a.tenantId}:${a.userId}:${kind}:${key}`,
  ]);
  const old = (
    await c.query(
      'SELECT * FROM order_field_requests WHERE actor_id=$1 AND kind=$2 AND client_key=$3',
      [a.userId, kind, key],
    )
  ).rows[0];
  if (old) ensure(old.request_hash === hash, 409, 'Klucz wykorzystano dla innych danych');
  return old;
}
async function persistRequest(
  c: PoolClient,
  a: Actor,
  kind: string,
  key: string,
  hash: string,
  result: unknown,
  orderId: string | null,
  fieldId: string | null,
) {
  await c.query(
    'INSERT INTO order_field_requests(tenant_id,actor_id,kind,client_key,order_id,field_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [a.tenantId, a.userId, kind, key, orderId, fieldId, hash, JSON.stringify(result)],
  );
}
async function revision(c: PoolClient, a: Actor, d: Definition) {
  await c.query(
    'INSERT INTO order_field_definition_revisions(tenant_id,field_id,version,snapshot,actor_id) VALUES($1,$2,$3,$4,$5)',
    [a.tenantId, d.id, d.version, JSON.stringify(d), a.userId],
  );
  await audit(c, a, 'order_field.definition', d.id, {
    version: d.version,
    snapshot_hash: digest(d),
  });
}
async function saveOptions(c: PoolClient, a: Actor, d: Definition, options: any[]) {
  const old = (await c.query('SELECT * FROM order_field_options WHERE field_id=$1', [d.id])).rows;
  for (const o of options) {
    const exists = old.find((e) => e.id === o.id);
    ensure(
      !exists || exists.label === o.label,
      409,
      'Etykieta opcji jest niezmienna; wycofaj i dodaj nową opcję',
    );
    await c.query(
      'INSERT INTO order_field_options(tenant_id,field_id,id,label,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,field_id,id) DO UPDATE SET enabled=excluded.enabled',
      [a.tenantId, d.id, o.id, o.label, o.enabled],
    );
  }
  const ids = options.map((o) => o.id);
  await c.query(
    'UPDATE order_field_options SET enabled=false WHERE field_id=$1 AND NOT(id=ANY($2::uuid[]))',
    [d.id, ids],
  );
  const count = (
    await c.query('SELECT count(*)::int n FROM order_field_options WHERE field_id=$1', [d.id])
  ).rows[0].n;
  ensure(count <= 100, 422, 'Słownik ma limit 100 opcji, w tym wycofanych');
}
export async function listOrderFields(a: Actor) {
  return tenantTx(a.tenantId, (c) => listOrderFieldsInTx(c, a));
}
/** GET /api/order-fields inside the caller's tenant transaction. */
export async function listOrderFieldsInTx(c: PoolClient, a: Actor) {
  await acquireOrderFieldsAdmissionInTx(c, a);
  const ds = await definitions(c),
    role = await orderFieldCurrentRole(c, a);
  return {
    current_role: role,
    can_admin: role === 'admin',
    pack_complete_requirements_available: await packingFieldsAvailableInTx(c),
    data: ds
      .filter((d) => readable(d, role))
      .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
      .map((d) => viewDefinition(d, role)),
  };
}
export async function createOrderField(a: Actor, body: z.infer<typeof orderFieldDefinitionSchema>) {
  return tenantTx(a.tenantId, (c) => createOrderFieldInTx(c, a, body));
}
/** POST /api/order-fields inside the caller's tenant transaction (also used by automation effects). */
export async function createOrderFieldInTx(c: PoolClient, a: Actor, body: z.infer<typeof orderFieldDefinitionSchema>) {
  const input = validateDefinition(orderFieldDefinitionSchema.parse(body)),
    hash = digest(body);
  {
    await acquireOrderFieldsAdmissionInTx(c, a, true);
    admin(await orderFieldCurrentRole(c, a));
    if (input.required_on.includes('pack_complete')) ensure(await packingFieldsAvailableInTx(c),503,'Wymagania pól potrzebują kompletnej instalacji');
    const replay = await request(c, a, 'definition', input.client_key, hash);
    if (replay) return { ...replay.result, reused: true };
    ensure(
      !(await c.query('SELECT id FROM order_field_definitions WHERE key=$1', [input.key])).rowCount,
      409,
      'Klucz pola już istnieje',
    );
    ensure(
      !input.enabled ||
        (await c.query('SELECT count(*)::int n FROM order_field_definitions WHERE enabled')).rows[0]
          .n < 100,
      429,
      'Limit 100 aktywnych definicji',
    );
    const id = randomUUID();
    await c.query(
      'INSERT INTO order_field_definitions(id,tenant_id,key,type,label,enabled,display,position,read_role,write_role,required_on,config) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        id,
        a.tenantId,
        input.key,
        input.type,
        input.label,
        input.enabled,
        input.display,
        input.position,
        input.read_role,
        input.write_role,
        input.required_on,
        JSON.stringify(input.config),
      ],
    );
    await saveOptions(c, a, { id }, input.options);
    const d = (await definitions(c, [id]))[0];
    await revision(c, a, d);
    await persistRequest(c, a, 'definition', input.client_key, hash, d, null, id);
    return { ...d, reused: false };
  }
}
export async function editOrderField(
  a: Actor,
  id: string,
  body: z.infer<typeof orderFieldDefinitionPatchSchema>,
) {
  return tenantTx(a.tenantId, (c) => editOrderFieldInTx(c, a, id, body));
}
/** PATCH /api/order-fields/:id inside the caller's tenant transaction (also used by automation effects). */
export async function editOrderFieldInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  body: z.infer<typeof orderFieldDefinitionPatchSchema>,
) {
  {
    await acquireOrderFieldsAdmissionInTx(c, a, true);
    const d = (await definitions(c, [id]))[0];
    ensure(d, 404, 'Nie znaleziono pola');
    admin(await orderFieldCurrentRole(c, a));
    ensure(d.version === body.version, 409, 'Definicja zmieniła się');
    const input = validateDefinition({
      ...orderFieldDefinitionPatchSchema.parse(body),
      type: d.type,
    });
    if (input.required_on.includes('pack_complete')) ensure(await packingFieldsAvailableInTx(c),503,'Wymagania pól potrzebują kompletnej instalacji');
    ensure(
      !input.enabled ||
        d.enabled ||
        (await c.query('SELECT count(*)::int n FROM order_field_definitions WHERE enabled')).rows[0]
          .n < 100,
      429,
      'Limit 100 aktywnych definicji',
    );
    await saveOptions(c, a, d, input.options);
    await c.query(
      'UPDATE order_field_definitions SET label=$2,enabled=$3,display=$4,position=$5,read_role=$6,write_role=$7,required_on=$8,config=$9,version=version+1,updated_at=now() WHERE id=$1',
      [
        id,
        input.label,
        input.enabled,
        input.display,
        input.position,
        input.read_role,
        input.write_role,
        input.required_on,
        JSON.stringify(input.config),
      ],
    );
    const next = (await definitions(c, [id]))[0];
    await revision(c, a, next);
    return next;
  }
}
export async function disableOrderField(a: Actor, id: string, version: number) {
  const ds = await tenantTx(a.tenantId, (c) => definitions(c, [id]));
  ensure(ds[0], 404, 'Nie znaleziono pola');
  const d = ds[0];
  return editOrderField(a, id, {
    version,
    label: d.label,
    enabled: false,
    display: d.display,
    position: d.position,
    read_role: d.read_role,
    write_role: d.write_role,
    required_on: d.required_on,
    config: d.config,
    options: d.options,
  });
}
async function lockOrder(c: PoolClient, id: string, write = true) {
  const o = (
    await c.query(
      'SELECT id,version::float8 version FROM orders WHERE id=$1' +
        (write ? ' FOR UPDATE' : ' FOR SHARE'),
      [id],
    )
  ).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  return o;
}
function fileHead(f: any) {
  return {
    id: f.id,
    filename: f.filename,
    mime_type: f.mime_type,
    byte_count: f.byte_count,
    file_hash: f.file_hash,
  };
}
async function freezeValue(
  c: PoolClient,
  d: Definition,
  change: any,
  orderId: string,
  files?: Map<string, any>,
) {
  ensure(d.enabled, 409, 'Definicja jest wyłączona');
  ensure(d.version === change.definition_version, 409, 'Definicja zmieniła się');
  ensure(d.type === change.type, 422, 'Nieprawidłowy typ wartości');
  const value = validateValue(d, change.value);
  let file: any;
  if (d.type === 'file') {
    file = files
      ? files.get(`${orderId}:${d.id}:${value}`)
      : (
          await c.query(
            'SELECT id,filename,mime_type,byte_count,file_hash FROM order_field_files WHERE id=$1 AND order_id=$2 AND field_id=$3',
            [value, orderId, d.id],
          )
        ).rows[0];
    ensure(file, 422, 'Plik nie należy do tego zamówienia i pola');
  }
  const ids: string[] =
    d.type === 'multi_select'
      ? (value as string[])
      : ['select', 'radio'].includes(d.type)
        ? [value as string]
        : [];
  return {
    type: d.type,
    value,
    definition_version: d.version,
    options_snapshot: d.options
      .filter((o: any) => ids.includes(o.id))
      .map((o: any) => ({ id: o.id, label: o.label })),
    ...(file ? { file: fileHead(file) } : {}),
  };
}
export type OrderFieldBatchInputRow = {
  row_id: string;
  position: number;
  order_id: string | null;
  order_version: number | null;
  changes: OrderFieldChange[];
  issues?: { code: string; message: string }[];
};
export type OrderFieldBatchPreparedRow = OrderFieldBatchInputRow & {
  order_number: string | null;
  status: 'ready' | 'no_op' | 'invalid' | 'conflict';
  before: { field_id: string; value: any }[];
  after: { field_id: string; value: any }[];
  skipped: { field_id: string; reason: string }[];
  issues: { code: string; message: string }[];
  effective_changes: OrderFieldChange[];
};
export async function orderFieldBatchReadableDefinitionsInTx(
  c: PoolClient,
  a: Actor,
  ids: string[],
  write = false,
  beforeRole?: () => Promise<unknown>,
) {
  const ds = await definitions(c, [...new Set(ids)].sort(), true);
  await beforeRole?.();
  const role = await orderFieldCurrentRole(c, a);
  ensure(ds.length === new Set(ids).size, 403, 'Definicja pola jest niedostępna');
  for (const d of ds) {
    ensure(readable(d, role), 403, 'Definicja pola jest niedostępna');
    if (write) writable(d, role);
  }
  return { definitions_snapshot: ds, current_role: role };
}
export async function prepareOrderFieldBatchRowsInTx(
  c: PoolClient,
  a: Actor,
  inputs: OrderFieldBatchInputRow[],
  opts: { policy: 'fill_unset' | 'replace'; writeLocks: boolean },
) {
  ensure(inputs.length <= (opts.writeLocks ? 100 : 5000), 422, 'Przekroczony zakres partii');
  await acquireOrderFieldsAdmissionInTx(c, a);
  const ids = [...new Set(inputs.flatMap((r) => (r.order_id ? [r.order_id] : [])))].sort(),
    orders = ids.length
      ? (
          await c.query(
            `SELECT id,number,version::float8 version FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${opts.writeLocks ? 'UPDATE' : 'SHARE'}`,
            [ids],
          )
        ).rows
      : [];
  const fieldIds = [...new Set(inputs.flatMap((r) => r.changes.map((ch) => ch.field_id)))].sort(),
    { definitions_snapshot: ds, current_role: role } = await orderFieldBatchReadableDefinitionsInTx(
      c,
      a,
      fieldIds,
      true,
    );
  const values = ids.length
    ? (
        await c.query(
          'SELECT order_id,field_id,payload FROM order_field_values WHERE order_id=ANY($1::uuid[]) AND field_id=ANY($2::uuid[])',
          [ids, fieldIds],
        )
      ).rows
    : [];
  const byOrder = new Map(orders.map((o) => [o.id, o])),
    byField = new Map(ds.map((d) => [d.id, d])),
    byValue = new Map(values.map((v) => [`${v.order_id}:${v.field_id}`, v.payload]));
  const fileIds = [
      ...new Set(
        inputs.flatMap((r) =>
          r.changes.flatMap((ch) => ('type' in ch && ch.type === 'file' ? [ch.value] : [])),
        ),
      ),
    ],
    files = new Map<string, any>();
  if (fileIds.length)
    for (const f of (
      await c.query(
        'SELECT id,order_id,field_id,filename,mime_type,byte_count,file_hash FROM order_field_files WHERE id=ANY($1::uuid[])',
        [fileIds],
      )
    ).rows)
      files.set(`${f.order_id}:${f.field_id}:${f.id}`, f);
  const duplicate = new Set<string>(),
    seen = new Set<string>();
  for (const r of inputs)
    if (r.order_id) {
      if (seen.has(r.order_id)) duplicate.add(r.order_id);
      seen.add(r.order_id);
    }
  const rows: OrderFieldBatchPreparedRow[] = [];
  for (const r of inputs) {
    const order = r.order_id ? byOrder.get(r.order_id) : null,
      row: OrderFieldBatchPreparedRow = {
        ...r,
        order_id: order?.id ?? null,
        order_number: order?.number ?? null,
        status: 'no_op',
        before: [],
        after: [],
        skipped: [],
        issues: [...(r.issues ?? [])],
        effective_changes: [],
      };
    if (!order) row.issues.push({ code: 'order_missing', message: 'Zamówienie jest niedostępne' });
    else if (duplicate.has(order.id))
      row.issues.push({ code: 'duplicate_order', message: 'Powtórzone zamówienie w podglądzie' });
    else if (order.version !== r.order_version)
      row.issues.push({ code: 'order_stale', message: 'Zamówienie zmieniło wersję' });
    if (row.issues.length) {
      row.status = row.issues.some((i) => ['order_stale', 'duplicate_order'].includes(i.code))
        ? 'conflict'
        : 'invalid';
      rows.push(row);
      continue;
    }
    try {
      ensure(
        new Set(r.changes.map((ch) => ch.field_id)).size === r.changes.length,
        422,
        'Powtórzone pola',
      );
      for (const ch of r.changes) {
        const d = byField.get(ch.field_id)!;
        ensure(d.enabled && d.version === ch.definition_version, 409, 'Definicja zmieniła się');
        const before = byValue.get(`${order.id}:${d.id}`) ?? null;
        row.before.push({ field_id: d.id, value: before });
        const candidate =
          'operation' in ch
            ? (ensure(opts.policy === 'replace', 422, 'Czyszczenie wymaga policy replace'), null)
            : await freezeValue(c, d, ch, order.id, files);
        if (opts.policy === 'fill_unset' && before !== null) {
          row.after.push({ field_id: d.id, value: before });
          row.skipped.push({ field_id: d.id, reason: 'protected_existing' });
          continue;
        }
        const same =
          (before === null && candidate === null) ||
          (before &&
            candidate &&
            before.type === candidate.type &&
            eq(before.value, candidate.value));
        row.after.push({ field_id: d.id, value: same ? before : candidate });
        if (same)
          row.skipped.push({ field_id: d.id, reason: before ? 'unchanged' : 'already_unset' });
        else row.effective_changes.push(ch);
      }
      row.status = row.effective_changes.length ? 'ready' : 'no_op';
    } catch (e) {
      if (e instanceof Problem && e.status === 403) throw e;
      row.status = e instanceof Problem && e.status === 409 ? 'conflict' : 'invalid';
      row.issues.push({
        code: row.status === 'conflict' ? 'definition_stale' : 'value_invalid',
        message: e instanceof Problem ? e.message : 'Niepoprawna wartość pola',
      });
      row.effective_changes = [];
    }
    rows.push(row);
  }
  return { rows, definitions_snapshot: ds, current_role: role };
}
export async function applyPreparedOrderFieldBatchInTx(
  c: PoolClient,
  a: Actor,
  prepared: Awaited<ReturnType<typeof prepareOrderFieldBatchRowsInTx>>,
  opts: {
    requestHash: string;
    source: 'manual' | 'api' | 'csv_import' | 'channel_import';
    provenance?: (row: OrderFieldBatchPreparedRow) => Record<string, unknown>;
  },
) {
  ensure(
    prepared.rows.length <= 100 &&
      prepared.rows.every((r) => ['ready', 'no_op'].includes(r.status)),
    409,
    'Partia nie jest gotowa',
  );
  const results = [];
  for (const row of prepared.rows) {
    const count = await apply(
      c,
      a,
      row.order_id!,
      prepared.definitions_snapshot,
      row.effective_changes,
      opts.requestHash,
      opts.source,
      opts.provenance?.(row),
    );
    if (count)
      await c.query('UPDATE orders SET version=version+1,updated_at=now() WHERE id=$1', [
        row.order_id,
      ]);
    results.push({
      row_id: row.row_id,
      order_id: row.order_id,
      changed: count > 0,
      order_version: row.order_version! + (count ? 1 : 0),
    });
  }
  return {
    rows: results,
    changed_orders: results.filter((r) => r.changed).length,
    no_op_orders: results.filter((r) => !r.changed).length,
  };
}
async function apply(
  c: PoolClient,
  a: Actor,
  orderId: string,
  ds: Definition[],
  changes: OrderFieldChange[],
  hash: string,
  source = 'manual',
  provenance?: Record<string, unknown>,
  opts: { deferPrincipalPin?: boolean } = {},
) {
  ensure(new Set(changes.map((ch) => ch.field_id)).size === changes.length, 422, 'Powtórzone pola');
  const role = await initialFieldRole(c, a, opts.deferPrincipalPin),
    frozen: { d: Definition; before: any; after: any }[] = [];
  for (const change of changes) {
    const d = ds.find((d) => d.id === change.field_id);
    ensure(d, 404, 'Nie znaleziono pola');
    writable(d, role);
    ensure(d.enabled, 409, 'Definicja jest wyłączona');
    ensure(d.version === change.definition_version, 409, 'Definicja zmieniła się');
    const before =
      (
        await c.query('SELECT payload FROM order_field_values WHERE order_id=$1 AND field_id=$2', [
          orderId,
          d.id,
        ])
      ).rows[0]?.payload ?? null;
    const after = 'operation' in change ? null : await freezeValue(c, d, change, orderId);
    // Updating a definition alone does not rewrite an unchanged value or its original label evidence.
    const same = before && after && before.type === after.type && eq(before.value, after.value);
    if ((!before && !after) || same) continue;
    frozen.push({ d, before, after });
  }
  for (const { d, before, after } of frozen) {
    if (!after)
      await c.query('DELETE FROM order_field_values WHERE order_id=$1 AND field_id=$2', [
        orderId,
        d.id,
      ]);
    else {
      const v = after.value;
      await c.query(
        'INSERT INTO order_field_values(tenant_id,order_id,field_id,type,definition_version,payload,text_value,number_value,date_value,option_values,file_id,source,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(tenant_id,order_id,field_id) DO UPDATE SET definition_version=excluded.definition_version,payload=excluded.payload,text_value=excluded.text_value,number_value=excluded.number_value,date_value=excluded.date_value,option_values=excluded.option_values,file_id=excluded.file_id,source=excluded.source,provenance=excluded.provenance,updated_at=now()',
        [
          a.tenantId,
          orderId,
          d.id,
          d.type,
          d.version,
          JSON.stringify(after),
          d.type === 'text' ? v : null,
          d.type === 'number' ? v : null,
          d.type === 'date' ? v : null,
          ['select', 'radio'].includes(d.type) ? [v] : d.type === 'multi_select' ? v : null,
          d.type === 'file' ? v : null,
          source,
          JSON.stringify(provenance ?? {}),
        ],
      );
    }
    await c.query(
      `INSERT INTO order_field_value_events(id,tenant_id,order_id,field_id,definition_version,actor_id,definition_snapshot,before_payload,after_payload,source,request_hash${provenance ? ',provenance' : ''}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${provenance ? ',$12' : ''})`,
      [
        randomUUID(),
        a.tenantId,
        orderId,
        d.id,
        d.version,
        a.userId,
        JSON.stringify(d),
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        source,
        hash,
        ...(provenance ? [JSON.stringify(provenance)] : []),
      ],
    );
  }
  ensure(
    (await c.query('SELECT count(*)::int n FROM order_field_values WHERE order_id=$1', [orderId]))
      .rows[0].n <= 100,
    429,
    'Limit 100 wartości zamówienia',
  );
  if (frozen.length)
    await audit(c, a, 'order.fields_changed', orderId, {
      field_ids: frozen.map((f) => f.d.id),
      request_hash: hash,
      source,
    });
  return frozen.length;
}
async function detail(c: PoolClient, a: Actor, id: string, role?: Actor['role']) {
  const o = await lockOrder(c, id, false),
    ds = await definitions(c),
    r = role ?? (await orderFieldCurrentRole(c, a)),
    vs = (
      await c.query(
        'SELECT field_id,payload,updated_at FROM order_field_values WHERE order_id=$1',
        [id],
      )
    ).rows;
  return {
    order_id: id,
    order_version: o.version,
    current_role: r,
    pack_complete_requirements_available: await packingFieldsAvailableInTx(c),
    data: ds
      .filter((d) => readable(d, r))
      .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
      .map((d) => ({
        definition: viewDefinition(d, r),
        value: vs.find((v) => v.field_id === d.id)
          ? {
              ...vs.find((v) => v.field_id === d.id)!.payload,
              updated_at: vs.find((v) => v.field_id === d.id)!.updated_at,
            }
          : null,
      })),
  };
}
export async function getOrderFields(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    return detail(c, a, id);
  });
}
export async function patchOrderFields(
  a: Actor,
  id: string,
  body: z.infer<typeof orderFieldPatchSchema>,
  source: 'manual' | 'api' = 'manual',
) {
  return tenantTx(a.tenantId, (c) => patchOrderFieldsInTx(c, a, id, body, source));
}
/** PATCH /api/orders/:id/fields inside the caller's tenant transaction. */
export async function patchOrderFieldsInTx(
  c: PoolClient,
  a: Actor,
  id: string,
  body: z.infer<typeof orderFieldPatchSchema>,
  source: 'manual' | 'api' = 'manual',
) {
  const input = orderFieldPatchSchema.parse(body),
    hash = digest({ order_id: id, input, source });
  await acquireOrderFieldsAdmissionInTx(c, a);
  const order = await lockOrder(c, id),
    ds = await definitions(
      c,
      input.changes.map((ch) => ch.field_id),
      true,
    ),
    role = await orderFieldCurrentRole(c, a);
  for (const ch of input.changes) {
    const d = ds.find((d) => d.id === ch.field_id);
    ensure(d, 404, 'Nie znaleziono pola');
    writable(d, role);
  }
  const old = await request(c, a, 'values', input.client_key, hash);
  if (old) return { ...(await detail(c, a, id, role)), ...old.result, reused: true };
  ensure(order.version === input.order_version, 409, 'Zamówienie zmieniło się');
  const changed = await apply(c, a, id, ds, input.changes, hash, source);
  if (changed)
    await c.query('UPDATE orders SET version=version+1,updated_at=now() WHERE id=$1', [id]);
  const result = {
    changed: changed > 0,
    applied_order_version: order.version + (changed ? 1 : 0),
  };
  await persistRequest(c, a, 'values', input.client_key, hash, result, id, null);
  return { ...(await detail(c, a, id, role)), ...result, reused: false };
}
export async function prepareInitialOrderFieldsInTx(
  c: PoolClient,
  a: AuditActor,
  changes: unknown,
  opts: {
    manual: boolean;
    source?: 'manual' | 'api' | 'channel_import';
    fieldWritesAllowed?: boolean;
  },
): Promise<Prepared> {
  await acquireOrderFieldsAdmissionInTx(c, a);
  const input = initialOrderFieldsSchema.parse(changes ?? []);
  ensure(
    opts.fieldWritesAllowed !== false || input.length === 0,
    403,
    'Brak prawa do początkowego zapisu pól',
  );
  const ds = await definitions(c, undefined, true);
  ensure(new Set(input.map((ch) => ch.field_id)).size === input.length, 422, 'Powtórzone pola');
  for (const ch of input) {
    const d = ds.find((d) => d.id === ch.field_id);
    ensure(d, 404, 'Nie znaleziono pola');
    ensure(d.enabled && d.version === ch.definition_version, 409, 'Definicja zmieniła się');
    ensure(d.type === ch.type, 422, 'Nieprawidłowy typ');
    validateValue(d, ch.value);
    ensure(d.type !== 'file', 422, 'Plik można dodać dopiero po utworzeniu zamówienia');
  }
  return {
    definitions: ds,
    changes: input,
    manual: opts.manual && opts.fieldWritesAllowed !== false,
    source: opts.source,
  };
}
export async function applyInitialOrderFieldsInTx(
  c: PoolClient,
  a: AuditActor,
  orderId: string,
  prepared: Prepared,
  provenance?: Record<string, unknown>,
  opts: { deferPrincipalPin?: boolean } = {},
) {
  // Called by createOrder only after every catalogue/stock/reservation wait.
  const role = await initialFieldRole(c, a, opts.deferPrincipalPin),
    changes = [...prepared.changes],
    actor: Actor = { ...a, userId: a.userId!, role, source: a.source === 'api' ? 'api' : 'manual' };
  ensure(
    role === 'admin' || role === 'operator',
    403,
    'Wymagany aktualny administrator lub operator',
  );
  if (prepared.manual)
    for (const d of prepared.definitions.filter((d) => d.enabled)) {
      if (
        !changes.some((ch) => ch.field_id === d.id) &&
        Object.hasOwn(d.config, 'default') &&
        readable(d, role) &&
        (role === 'admin' || (role === 'operator' && d.write_role === 'operator'))
      )
        changes.push({
          field_id: d.id,
          definition_version: d.version,
          type: d.type,
          value: d.config.default,
        } as any);
      if (d.required_on.includes('manual_create'))
        ensure(
          changes.some((ch) => ch.field_id === d.id),
          422,
          'Brak wymaganego pola przy tworzeniu zamówienia',
        );
    }
  ensure(changes.length <= 100, 422, 'Limit 100 początkowych wartości');
  return apply(
    c,
    actor,
    orderId,
    prepared.definitions,
    changes,
    digest({ order_id: orderId, changes, ...(provenance ? { provenance } : {}) }),
    prepared.source ?? (prepared.manual ? 'manual' : 'api'),
    provenance,
    opts,
  );
}
export async function freezeMappedInitialValuesInTx(
  c: PoolClient,
  a: Actor,
  changes: OrderFieldChange[],
  fieldIds: string[],
  beforeRole?: () => Promise<unknown>,
) {
  const access = await orderFieldBatchReadableDefinitionsInTx(c, a, fieldIds, true, beforeRole);
  const after = [];
  for (const ch of changes) {
    ensure('type' in ch && ch.type !== 'file', 422, 'Mapowanie pliku nie jest dostępne');
    const d = access.definitions_snapshot.find((d) => d.id === ch.field_id)!;
    after.push({
      field_id: ch.field_id,
      value: await freezeValue(c, d, ch, '00000000-0000-0000-0000-000000000000'),
    });
  }
  return { ...access, after };
}
export async function orderFieldHistory(a: Actor, id: string, cursor?: string) {
  let page: any;
  try {
    page = cursor
      ? z
          .tuple([z.iso.datetime(), z.uuid()])
          .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()))
      : null;
  } catch {
    throw new Problem(422, 'Nieprawidłowy kursor pól');
  }
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    await lockOrder(c, id, false);
    const role = await orderFieldCurrentRole(c, a),
      args: any[] = [id, role];
    if (page) args.push(...page);
    const rows = (
      await c.query(
        `SELECT e.id,e.field_id,e.definition_snapshot,e.before_payload "before",e.after_payload "after",e.source,e.created_at,to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM order_field_value_events e JOIN order_field_definitions d ON (d.tenant_id,d.id)=(e.tenant_id,e.field_id) WHERE e.order_id=$1 AND ($2='admin' OR d.read_role='team') ${page ? 'AND (e.created_at,e.id)<($3::timestamptz,$4::uuid)' : ''} ORDER BY e.created_at DESC,e.id DESC LIMIT 21`,
        args,
      )
    ).rows;
    return {
      current_role: role,
      data: rows.slice(0, 20).map(({ cursor_time, ...r }) => r),
      meta: {
        cursor:
          rows.length > 20
            ? Buffer.from(JSON.stringify([rows[19].cursor_time, rows[19].id])).toString('base64url')
            : null,
      },
    };
  });
}
function bytesInput(base64: string) {
  ensure(
    base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64),
    422,
    'Niepoprawne base64',
  );
  const bytes = Buffer.from(base64, 'base64');
  ensure(
    bytes.length > 0 && bytes.length <= 5242880 && bytes.toString('base64') === base64,
    422,
    'Plik przekracza 5 MiB lub nie jest kanoniczny',
  );
  return bytes;
}
function mime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) &&
    bytes.subarray(-2).equals(Buffer.from([255, 217]))
  )
    return 'image/jpeg';
  if (
    bytes.subarray(0, 5).toString() === '%PDF-' &&
    bytes.subarray(-1024).includes(Buffer.from('%%EOF'))
  )
    return 'application/pdf';
  throw new Problem(422, 'Dozwolone są pliki PDF, JPEG i PNG z poprawną sygnaturą');
}
export async function uploadOrderFieldFile(a: Actor, body: z.infer<typeof orderFieldFileSchema>) {
  const input = orderFieldFileSchema.parse(body),
    bytes = bytesInput(input.content_base64),
    kind = mime(bytes),
    hash = digest(input),
    fileHash = createHash('sha256').update(bytes).digest('hex');
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `order-field-file-quota:${a.tenantId}`,
    ]);
    await lockOrder(c, input.order_id);
    const d = (await definitions(c, [input.field_id], true))[0];
    ensure(d, 404, 'Nie znaleziono pola');
    writable(d, await orderFieldCurrentRole(c, a));
    ensure(d.type === 'file', 422, 'Definicja nie jest plikiem');
    const old = (
      await c.query('SELECT * FROM order_field_files WHERE actor_id=$1 AND client_key=$2', [
        a.userId,
        input.client_key,
      ])
    ).rows[0];
    if (old) {
      ensure(old.request_hash === hash, 409, 'Klucz pliku wykorzystano dla innych danych');
      return { ...fileHead(old), reused: true };
    }
    ensure(d.enabled && d.version === input.definition_version, 409, 'Definicja zmieniła się');
    const quota = (
      await c.query(
        'SELECT count(*)::int n,coalesce(sum(byte_count),0)::bigint bytes FROM order_field_files',
      )
    ).rows[0];
    ensure(
      quota.n < 100 && BigInt(quota.bytes) + BigInt(bytes.length) <= 52428800n,
      429,
      'Limit firmy: 100 plików / 50 MiB',
    );
    const id = randomUUID();
    await c.query(
      'INSERT INTO order_field_files(id,tenant_id,order_id,field_id,definition_version,actor_id,client_key,request_hash,filename,mime_type,byte_count,file_hash,encrypted_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [
        id,
        a.tenantId,
        input.order_id,
        d.id,
        d.version,
        a.userId,
        input.client_key,
        hash,
        input.filename,
        kind,
        bytes.length,
        fileHash,
        encrypt({ content_base64: input.content_base64 }),
      ],
    );
    await audit(c, a, 'order_field.file_uploaded', id, {
      order_id: input.order_id,
      field_id: d.id,
      file_hash: fileHash,
      byte_count: bytes.length,
    });
    return {
      id,
      filename: input.filename,
      mime_type: kind,
      byte_count: bytes.length,
      file_hash: fileHash,
      reused: false,
    };
  });
}
export async function downloadOrderFieldFile(a: Actor, id: string) {
  return tenantTx(a.tenantId, async (c) => {
    await acquireOrderFieldsAdmissionInTx(c, a);
    const f = (await c.query('SELECT * FROM order_field_files WHERE id=$1', [id])).rows[0];
    ensure(f, 404, 'Nie znaleziono pliku');
    await lockOrder(c, f.order_id, false);
    const d = (await definitions(c, [f.field_id], true))[0],
      role = await orderFieldCurrentRole(c, a);
    ensure(d && readable(d, role), 403, 'Brak prawa odczytu pliku');
    const plain = decrypt(f.encrypted_bytes) as { content_base64: string },
      bytes = bytesInput(plain.content_base64);
    ensure(
      bytes.length === f.byte_count &&
        createHash('sha256').update(bytes).digest('hex') === f.file_hash,
      409,
      'Integralność pliku nie została potwierdzona',
    );
    return { ...fileHead(f), bytes };
  });
}
export async function orderFieldListScopeInTx(
  c: PoolClient,
  a: Actor,
  filters: z.infer<typeof orderFieldFiltersSchema>,
  columns: z.infer<typeof orderFieldColumnsSchema>,
  opts: { alias: 'o'; paramOffset: number },
) {
  filters = orderFieldFiltersSchema.parse(filters);
  columns = orderFieldColumnsSchema.parse(columns);
  ensure(new Set(columns).size === columns.length, 422, 'Powtórzone kolumny');
  await acquireOrderFieldsAdmissionInTx(c, a);
  const ids = [...new Set([...filters.map((f) => f.field_id), ...columns])],
    ds = await definitions(c, ids, true),
    role = await orderFieldCurrentRole(c, a),
    params: any[] = [];
  let sql = '';
  for (const id of ids) {
    const d = ds.find((d) => d.id === id);
    ensure(d, 404, 'Nie znaleziono pola');
    ensure(d.enabled && readable(d, role), 403, 'Pole niedostępne do filtrowania lub kolumn');
  }
  const bind = (v: unknown) => {
    params.push(v);
    return '$' + (opts.paramOffset + params.length);
  };
  for (const f of filters) {
    const d = ds.find((d) => d.id === f.field_id)!;
    ensure(d.version === f.definition_version, 409, 'Definicja filtra zmieniła się');
    const field = bind(f.field_id),
      base = `v.tenant_id=o.tenant_id AND v.order_id=o.id AND v.field_id=${field}::uuid`;
    if (f.operator === 'is_set' || f.operator === 'is_unset') {
      ensure(f.value === undefined, 422, 'Ten filtr nie ma operandu');
      sql += ` AND ${f.operator === 'is_unset' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM order_field_values v WHERE ${base})`;
      continue;
    }
    let cond: string;
    if (['contains', 'prefix'].includes(f.operator)) {
      ensure(
        d.type === 'text' &&
          typeof f.value === 'string' &&
          [...f.value].length >= 3 &&
          f.value.length <= 100,
        422,
        'Wyszukiwanie tekstu wymaga 3..100 znaków',
      );
      const escaped = (f.value as string).replace(/[\\%_]/g, '\\$&');
      cond = `v.type='text' AND v.text_value LIKE ${bind(f.operator === 'prefix' ? escaped + '%' : '%' + escaped + '%')} ESCAPE '\\'`;
    } else if (f.operator === 'contains_option') {
      ensure(d.type === 'multi_select', 422, 'Operator wymaga multiselect');
      const id = z.uuid().parse(f.value);
      ensure(
        d.options.some((o: any) => o.id === id),
        422,
        'Nieznana opcja',
      );
      cond = `v.type='multi_select' AND v.option_values @> ARRAY[${bind(id)}::uuid]`;
    } else {
      ensure(
        !['gte', 'lte'].includes(f.operator) || ['number', 'date'].includes(d.type),
        422,
        'Operator wymaga liczby lub daty',
      );
      const value = validateValue(d, f.value, true),
        op = { eq: '=', neq: '<>', gte: '>=', lte: '<=' }[f.operator as 'eq'];
      if (d.type === 'number')
        cond = `v.type='number' AND v.number_value ${op} ${bind(value)}::numeric`;
      else if (d.type === 'date')
        cond = `v.type='date' AND v.date_value ${op} ${bind(value)}::date`;
      else if (d.type === 'text') cond = `v.type='text' AND v.text_value ${op} ${bind(value)}`;
      else if (d.type === 'file') cond = `v.file_id ${op} ${bind(value)}::uuid`;
      else
        cond = `v.option_values ${op} ${bind(d.type === 'multi_select' ? value : [value])}::uuid[]`;
    }
    sql += ` AND EXISTS(SELECT 1 FROM order_field_values v WHERE ${base} AND ${cond})`;
  }
  return { sql, params, columns, current_role: role };
}
export async function projectOrderFieldColumnsInTx(
  c: PoolClient,
  a: Actor,
  orderIds: string[],
  columns: string[],
) {
  ensure(orderIds.length <= 200 && columns.length <= 10, 422, 'Za duża projekcja');
  await acquireOrderFieldsAdmissionInTx(c, a);
  const ds = await definitions(c, columns, true),
    role = await orderFieldCurrentRole(c, a);
  for (const id of columns) {
    const d = ds.find((d) => d.id === id);
    ensure(d && readable(d, role), 403, 'Niedostępna kolumna');
  }
  const rows = (
    await c.query(
      'SELECT order_id,field_id,payload FROM order_field_values WHERE order_id=ANY($1::uuid[]) AND field_id=ANY($2::uuid[])',
      [orderIds, columns],
    )
  ).rows;
  return new Map(
    orderIds.map((id) => [
      id,
      columns.map((field) => {
        const d = ds.find((d) => d.id === field)!,
          value = rows.find((r) => r.order_id === id && r.field_id === field)?.payload;
        return {
          field_id: field,
          key: d.key,
          type: d.type,
          value: value?.value ?? null,
          definition_version: value?.definition_version ?? d.version,
          options_snapshot: value?.options_snapshot ?? [],
          ...(value?.file ? { file: value.file } : {}),
        };
      }),
    ]),
  );
}
