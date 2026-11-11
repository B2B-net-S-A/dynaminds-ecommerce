import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { tenantTx, tenantReadTx } from "./db";
import { audit, type Actor } from "./domain";
import { encrypt, decrypt } from "./security";
import { ensure } from "./errors";
import { assertBaseWireCrmAuthority, type BaseWireCrmAuthority } from './base-wire-crm-authority';
import type { BaseWireCrmDictionaryPort, CrmDictionaryCommand, CrmDictionaryReceipt, CrmWireGroup, CrmWireStatus, DictionaryKind } from './base-wire-crm-dictionaries';
import {
  CRM_FILE_MAX_BYTES,
  crmCreate,
  crmPatch,
  crmDelete,
  crmGroupCreate,
  crmGroupPatch,
  crmStatusCreate,
  crmStatusPatch,
  crmStatusDelete,
  crmLink,
  crmList,
  crmDetail,
  crmObserve,
  crmFileInput,
  crmOrderPage,
  crmProfileShape,
} from "./crm-schema";
import {
  crmFieldCreate,
  crmFieldPatch,
  crmFieldAck,
  applyCrmFieldCommand,
  readCrmFieldDefinitions,
} from "./crm-field-definitions";
type Row = Record<string, any>;
export const CRM_POLICY = {
  file_max_bytes: CRM_FILE_MAX_BYTES,
  file_limit_basis: "LOCAL_DECIMAL_BYTES_NOT_BASE_WIRE",
  file_mime_types: [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "application/octet-stream",
  ],
  scalar_serialization: "LOCAL_TYPED_JSON_NOT_BASE_WIRE",
  definitions: "LOCAL_SEVEN_STARTER_FIELDS",
  delete_policy: "ARCHIVE_PROFILE_PRESERVE_ORDER_SNAPSHOTS",
} as const;
const defaults: Row = {
  star: 0,
  contractor_id: 0,
  login: "",
  phone: "",
  email: "",
  notes: "",
  invoice_company: "",
  invoice_fullname: "",
  invoice_address: "",
  invoice_postcode: "",
  invoice_city: "",
  invoice_state: "",
  invoice_country_code: "",
  invoice_tax_id: "",
  delivery_company: "",
  delivery_fullname: "",
  delivery_address: "",
  delivery_postcode: "",
  delivery_city: "",
  delivery_state: "",
  delivery_country_code: "",
};
function session(a: Actor) {
  ensure(
    a.userId && !a.apiKeyId && a.source !== "api",
    403,
    "CRM wymaga sesji użytkownika",
  );
}
async function role(c: PoolClient, a: Actor, write = false) {
  session(a);
  const r = (
    await c.query(
      write
        ? "SELECT public.order_field_role($1) AS role"
        : "SELECT public.customer_message_role($1) AS role",
      [a.userId],
    )
  ).rows[0]?.role;
  ensure(
    ["admin", "operator", "viewer"].includes(r),
    403,
    "Brak aktualnego dostępu do firmy",
  );
  if (write) ensure(r === "admin", 403, "Wymagany aktualny administrator");
  return r;
}
function viewClient(r: Row, detail = true) {
  const p = { ...r.profile };
  if (!detail) delete p.notes;
  return {
    ...p,
    id: r.id,
    status_id: r.status_id,
    version: r.version,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
function group(r: Row) {
  return {
    id: r.id,
    name: r.name,
    is_main_group: r.is_main_group ? 1 : 0,
    version: r.version,
  };
}
function status(r: Row) {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    group_id: r.group_id,
    is_primary: r.is_primary ? 1 : 0,
    position: Number(r.position),
    version: r.version,
  };
}
const eq = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function canonical(v: any): string {
  if (v === null) return "null";
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    ensure(Number.isFinite(v), 422, "Nieprawidłowa liczba");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  ensure(
    v && typeof v === "object" && Object.getPrototypeOf(v) !== Date.prototype,
    422,
    "Nieprawidłowa treść polecenia",
  );
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
      .join(",") +
    "}"
  );
}
const digest = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
export function parseCrmFile(raw: unknown) {
  const b = crmFileInput.parse(raw);
  ensure(
    /^data:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      b.file,
    ),
    422,
    "Plik wymaga data: i kanonicznego base64",
  );
  const bytes = Buffer.from(b.file.slice(5), "base64");
  ensure(
    bytes.length > 0 &&
      bytes.length <= CRM_FILE_MAX_BYTES &&
      bytes.toString("base64") === b.file.slice(5),
    422,
    "Nieprawidłowy rozmiar lub kodowanie pliku",
  );
  let mime = "application/octet-stream";
  if (bytes.subarray(0, 5).toString() === "%PDF-") mime = "application/pdf";
  else if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    mime = "image/png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    mime = "image/jpeg";
  return { title: b.title, bytes, mime_type: mime, sha256: digest(bytes) };
}
export function validateCrmExtraValue(
  definition: Row,
  value: unknown,
): unknown {
  if (typeof value === "string")
    ensure(!value.includes("\0"), 422, "Tekst nie może zawierać NUL");
  if (value === "") return "";
  switch (definition.editor_type) {
    case "text":
      return z.string().max(10000).parse(value);
    case "number":
      return z
        .number()
        .finite()
        .min(-999999999999)
        .max(999999999999)
        .parse(value);
    case "select":
    case "radio": {
      const s = z.string().max(120).parse(value);
      ensure(definition.options.includes(s), 422, "Wartość spoza opcji pola");
      return s;
    }
    case "checkbox": {
      const a = z.array(z.string().max(120)).max(50).parse(value);
      ensure(
        new Set(a).size === a.length &&
          a.every((x) => definition.options.includes(x)),
        422,
        "Nieprawidłowe opcje pola",
      );
      return a;
    }
    case "date": {
      const d = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .parse(value);
      const date = new Date(d + "T00:00:00.000Z");
      ensure(
        Number.isFinite(date.getTime()) &&
          date.toISOString().slice(0, 10) === d,
        422,
        "Nieprawidłowa data",
      );
      return d;
    }
    case "file":
      return parseCrmFile(value);
    default:
      ensure(false, 422, "Nieznany typ pola");
  }
}
async function activeClient(c: PoolClient, id: string, lock = false) {
  const r = (
    await c.query(
      `SELECT * FROM crm_clients WHERE id=$1 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  ensure(r, 404, "Nie znaleziono klienta");
  return r;
}
async function extras(c: PoolClient, clientId: string) {
  const rows = (
    await c.query(
      "SELECT v.field_id,v.value,v.editor_type,f.title FROM crm_values v LEFT JOIN crm_files f ON (f.tenant_id,f.client_id,f.field_id,f.id)=(v.tenant_id,v.client_id,v.field_id,v.file_id) WHERE v.client_id=$1 ORDER BY v.field_id",
      [clientId],
    )
  ).rows;
  return Object.fromEntries(
    rows.map((r) => [
      r.field_id,
      r.editor_type === "file"
        ? {
            title: r.title,
            url: `/api/crm/clients/${clientId}/files/${r.field_id}`,
          }
        : r.value,
    ]),
  );
}
async function applyExtras(
  c: PoolClient,
  a: Actor,
  clientId: string,
  values: Record<string, unknown>,
) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([id, value]) => [id.toLowerCase(), value]),
  );
  const ids = Object.keys(normalized);
  ensure(ids.length === Object.keys(values).length, 422, "Powtórzone pole CRM");
  if (!ids.length) return;
  const definitions = (
    await c.query(
      "SELECT * FROM crm_extra_fields WHERE id=ANY($1::uuid[]) ORDER BY id",
      [ids],
    )
  ).rows;
  ensure(definitions.length === ids.length, 422, "Nieznane lub obce pole CRM");
  ensure(
    definitions.every((d) => !d.archived_at),
    409,
    "Archiwalne pole można odczytać; przed zmianą przywróć jego definicję",
  );
  const prepared = definitions.map((d) => ({
    d,
    value: validateCrmExtraValue(d, normalized[d.id]),
  }));
  for (const { d, value } of prepared) {
    if (value === "") {
      await c.query(
        "DELETE FROM crm_values WHERE client_id=$1 AND field_id=$2",
        [clientId, d.id],
      );
      continue;
    }
    let fileId: string | null = null,
      payload = value;
    if (d.editor_type === "file") {
      const f = value as ReturnType<typeof parseCrmFile>;
      fileId = randomUUID();
      await c.query(
        "INSERT INTO crm_files(id,tenant_id,client_id,field_id,actor_id,title,mime_type,byte_count,content_sha256,encrypted_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          fileId,
          a.tenantId,
          clientId,
          d.id,
          a.userId,
          f.title,
          f.mime_type,
          f.bytes.length,
          f.sha256,
          encrypt({ base64: f.bytes.toString("base64") }),
        ],
      );
      payload = { title: f.title };
    }
    await c.query(
      "INSERT INTO crm_values(tenant_id,client_id,field_id,editor_type,value,file_id) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,client_id,field_id) DO UPDATE SET value=EXCLUDED.value,file_id=EXCLUDED.file_id",
      [
        a.tenantId,
        clientId,
        d.id,
        d.editor_type,
        JSON.stringify(payload),
        fileId,
      ],
    );
  }
}
export async function listCrmClients(a: Actor, raw: unknown) {
  const q = crmList.parse(raw);
  session(a);
  return tenantReadTx(a.tenantId, async (c) => {
    const r = await role(c, a);
    const params: any[] = [
      q.status_id ?? null,
      q.client_id ?? null,
      "%" + q.search + "%",
    ];
    let where =
      "deleted_at IS NULL AND ($1::uuid IS NULL OR status_id=$1) AND ($2::uuid IS NULL OR id=$2) AND (profile->>'login' ILIKE $3 OR profile->>'email' ILIKE $3 OR profile->>'phone' ILIKE $3 OR profile->>'invoice_fullname' ILIKE $3 OR profile->>'invoice_company' ILIKE $3 OR profile->>'invoice_tax_id' ILIKE $3)";
    for (const k of [
      "email",
      "phone",
      "login",
      "invoice_company",
      "invoice_tax_id",
      "invoice_fullname",
    ] as const) {
      if (q[k] !== undefined) {
        params.push(
          "%" +
            (k === "invoice_tax_id" ? q[k]!.replace(/[\s-]/g, "") : q[k]) +
            "%",
        );
        where += ` AND profile->>'${k}' ILIKE $${params.length}`;
      }
    }
    params.push(q.limit + 1, (q.page - 1) * q.limit);
    const rows = (
      await c.query(
        `SELECT * FROM crm_clients WHERE ${where} ORDER BY created_at DESC,id LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )
    ).rows;
    return {
      data: rows.slice(0, q.limit).map((x) => viewClient(x, false)),
      meta: { page: q.page, limit: q.limit, has_more: rows.length > q.limit },
      can_write: r === "admin",
    };
  });
}
export async function getCrmClient(a: Actor, id: string, raw: unknown) {
  z.uuid().parse(id);
  const q = crmDetail.parse(raw);
  session(a);
  return tenantReadTx(a.tenantId, async (c) => {
    const r = await role(c, a),
      row = await activeClient(c, id),
      data = viewClient(row);
    if (q.include_custom_extra_fields === "true")
      data.custom_extra_fields = await extras(c, row.id);
    return { data, can_write: r === "admin" };
  });
}
export async function getCrmDictionaries(
  a: Actor,
  kind: "groups" | "statuses" | "fields",
) {
  session(a);
  return tenantReadTx(a.tenantId, async (c) => {
    const r = await role(c, a);
    if (kind === "groups")
      return {
        data: (
          await c.query(
            "SELECT * FROM crm_status_groups ORDER BY is_main_group DESC,name,id",
          )
        ).rows.map(group),
        can_write: r === "admin",
      };
    if (kind === "statuses")
      return {
        data: (
          await c.query(
            "SELECT * FROM crm_statuses ORDER BY group_id,position,id",
          )
        ).rows.map(status),
        can_write: r === "admin",
      };
    const fields = await readCrmFieldDefinitions(c);
    return {
      data: fields.data,
      policy: {
        ...CRM_POLICY,
        definition_editor_available: fields.definition_editor_available,
        definition_limit: 1000,
      },
      can_write: r === "admin",
    };
  });
}
export async function getCrmOrders(a: Actor, id: string, raw: unknown = {}) {
  z.uuid().parse(id);
  session(a);
  const q = crmOrderPage.parse(raw);
  let after: { date: string; id: string } | null = null;
  if (q.after) {
    try {
      after = z
        .object({ date: z.iso.datetime(), id: z.uuid() })
        .strict()
        .parse(JSON.parse(Buffer.from(q.after, "base64url").toString("utf8")));
    } catch {
      ensure(false, 422, "Nieprawidłowy kursor zamówień CRM");
    }
  }
  return tenantReadTx(a.tenantId, async (c) => {
    await role(c, a);
    await activeClient(c, id);
    const rows = (
      await c.query(
        `SELECT o.id,o.number,o.status,o.total,o.currency,o.created_at,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM crm_order_links l JOIN orders o ON (o.tenant_id,o.id)=(l.tenant_id,l.order_id) WHERE l.client_id=$1 AND ($2::timestamptz IS NULL OR (o.created_at,o.id)<($2::timestamptz,$3::uuid)) ORDER BY o.created_at DESC,o.id DESC LIMIT $4`,
        [id, after?.date ?? null, after?.id ?? null, q.limit + 1],
      )
    ).rows;
    const data = rows.slice(0, q.limit),
      last = data.at(-1),
      cursor =
        rows.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({ date: last.cursor_time, id: last.id }),
            ).toString("base64url")
          : null;
    for (const r of data) delete r.cursor_time;
    return { data, meta: { cursor, has_more: rows.length > q.limit } };
  });
}
export async function getCrmFile(a: Actor, clientId: string, fieldId: string) {
  z.uuid().parse(clientId);
  z.uuid().parse(fieldId);
  session(a);
  return tenantReadTx(a.tenantId, async (c) => {
    await role(c, a);
    await activeClient(c, clientId);
    const f = (
      await c.query(
        "SELECT f.* FROM crm_files f JOIN crm_values v ON (v.tenant_id,v.client_id,v.field_id,v.file_id)=(f.tenant_id,f.client_id,f.field_id,f.id) WHERE f.client_id=$1 AND f.field_id=$2",
        [clientId, fieldId],
      )
    ).rows[0];
    ensure(f, 404, "Nie znaleziono pliku");
    const content = decrypt(f.encrypted_bytes),
      bytes = Buffer.from(content.base64, "base64");
    ensure(
      bytes.length === f.byte_count && digest(bytes) === f.content_sha256,
      503,
      "Niespójny plik CRM",
    );
    return { bytes, title: f.title, mime_type: f.mime_type };
  });
}
type Operation = { kind: string; id: string | null; body: any };
export function parseCrmOperation(
  method: string,
  path: string,
  body: unknown,
): Operation {
  const match =
    /^\/api\/crm\/(clients|statuses|status-groups|field-definitions)(?:\/([a-fA-F0-9-]{36}))?(\/orders)?$/.exec(
      path,
    );
  ensure(match, 422, "Nieznana operacja CRM");
  const resource = match[1],
    id = match[2]?.toLowerCase() ?? null;
  if (id) z.uuid().parse(id);
  if (resource === "field-definitions") {
    ensure(
      !match[3] && ((!id && method === "POST") || (id && method === "PATCH")),
      422,
      "Nieznana operacja definicji pola",
    );
    return {
      kind: resource + (id ? ".patch" : ".create"),
      id,
      body: (id ? crmFieldPatch : crmFieldCreate).parse(body),
    };
  }
  if (match[3]) {
    ensure(
      resource === "clients" && id && method === "POST",
      422,
      "Nieznana operacja CRM",
    );
    return { kind: "link", id, body: crmLink.parse(body) };
  }
  if (!id) {
    ensure(method === "POST", 422, "Nieznana operacja CRM");
    return {
      kind: resource + ".create",
      id: null,
      body: (resource === "clients"
        ? crmCreate
        : resource === "statuses"
          ? crmStatusCreate
          : crmGroupCreate
      ).parse(body),
    };
  }
  ensure(
    method === "PATCH" || method === "DELETE",
    422,
    "Nieznana operacja CRM",
  );
  const schema =
    method === "PATCH"
      ? resource === "clients"
        ? crmPatch
        : resource === "statuses"
          ? crmStatusPatch
          : crmGroupPatch
      : resource === "statuses"
        ? crmStatusDelete
        : crmDelete;
  return {
    kind: resource + "." + (method === "PATCH" ? "patch" : "delete"),
    id,
    body: schema.parse(body),
  };
}

function journalRequest(request: Row) {
  const copy = structuredClone(request);
  const values = copy.body?.custom_extra_fields;
  if (values && typeof values === "object")
    for (const value of Object.values(values) as any[]) {
      if (value && typeof value === "object" && typeof value.file === "string")
        value.file = {
          sha256: digest(value.file),
          utf8_bytes: Buffer.byteLength(value.file),
        };
    }
  return copy;
}
const { custom_extra_fields: _custom, ...profileAckShape } = crmProfileShape;
const clientAck = z
  .object({
    ...profileAckShape,
    id: z.uuid(),
    version: z.number().int().positive(),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .required()
  .strict();
const groupAck = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(15),
    is_main_group: z.union([z.literal(0), z.literal(1)]),
    version: z.number().int().positive(),
  })
  .strict();
const statusAck = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(30),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    group_id: z.uuid(),
    is_primary: z.union([z.literal(0), z.literal(1)]),
    position: z.number().int().nonnegative(),
    version: z.number().int().positive(),
  })
  .strict();
function validateCrmReceipt(request: Row, response: unknown) {
  if (response && typeof response === "object" && "status" in response) {
    const parsed = z
      .object({
        status: z.literal("CRM_COMMAND_CANCELLED"),
        client_key: z.uuid(),
        method: z.enum(["POST", "PATCH", "DELETE"]),
        path: z.string(),
        automatic_retry: z.literal(false),
      })
      .strict()
      .safeParse(response);
    ensure(parsed.success, 503, "Niespójne anulowanie polecenia CRM");
    const original = parseCrmOperation(
      request.method,
      request.path,
      request.body,
    );
    ensure(
      parsed.data!.client_key === original.body.client_key &&
        parsed.data!.method === request.method &&
        parsed.data!.path === request.path,
      503,
      "Anulowanie nie odpowiada poleceniu CRM",
    );
    return;
  }
  const op = parseCrmOperation(request.method, request.path, request.body),
    deleted = op.kind.endsWith(".delete");
  const schema = op.kind.startsWith("field-definitions.")
    ? crmFieldAck
    : deleted
      ? z.object({ id: z.uuid(), deleted: z.literal(true) }).strict()
      : op.kind.startsWith("status-groups.")
        ? groupAck
        : op.kind.startsWith("statuses.")
          ? statusAck
          : clientAck;
  const result = z.object({ data: schema }).strict().safeParse(response);
  ensure(result.success, 503, "Niespójny wynik polecenia CRM");
  ensure(
    eq(result.data, response),
    503,
    "Niespójna kanoniczna postać wyniku CRM",
  );
  const data = result.data!.data as Row;
  ensure(
    !op.id || data.id.toLowerCase() === op.id,
    503,
    "Wynik wskazuje inny zasób CRM",
  );
  if (!deleted) {
    ensure(
      data.version === (op.kind.endsWith(".create") ? 1 : op.body.version + 1),
      503,
      "Niespójna wersja wyniku CRM",
    );
    if (op.kind === "clients.create" || op.kind === "clients.patch")
      for (const k of Object.keys(defaults)) {
        if (Object.hasOwn(op.body, k) || op.kind === "clients.create")
          ensure(
            eq(data[k], op.body[k] ?? defaults[k]),
            503,
            "Wynik nie odpowiada poleceniu CRM",
          );
      }
    for (const k of [
      "status_id",
      "group_id",
      "name",
      "color",
      "options",
      "position",
      "archived",
    ])
      if (Object.hasOwn(op.body, k))
        ensure(
          eq(data[k], op.body[k]),
          503,
          "Wynik nie odpowiada poleceniu CRM",
        );
    if (op.kind === "field-definitions.create") {
      ensure(
        data.editor_type === op.body.editor_type &&
          data.archived === false &&
          eq(data.options, op.body.options),
        503,
        "Niespójna nowa definicja pola",
      );
    }
    if (op.kind === "status-groups.create")
      ensure(data.is_main_group === 0, 503, "Niespójna nowa grupa CRM");
    if (op.kind === "statuses.create")
      ensure(data.is_primary === 0, 503, "Niespójny nowy status CRM");
  }
}
async function prior(
  c: PoolClient,
  a: Actor,
  clientKey: string,
  request: unknown,
  hash: string,
) {
  const row = (
    await c.query("SELECT * FROM crm_commands WHERE client_key=$1", [clientKey])
  ).rows[0];
  if (!row) return null;
  ensure(
    row.actor_id === a.userId &&
      row.request_hash === hash &&
      eq(
        row.request &&
          Object.fromEntries(
            Object.entries(row.request).filter(
              ([k]) => k !== "response_sha256",
            ),
          ),
        journalRequest(request as Row),
      ),
    409,
    "Klucz polecenia CRM jest już związany z inną operacją",
  );
  ensure(
    typeof row.request?.response_sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(row.request.response_sha256) &&
      row.request.response_sha256 === digest(canonical(row.response)),
    503,
    "Niespójny zapis wyniku CRM",
  );
  validateCrmReceipt(request as Row, row.response);
  return row.response;
}
export async function observeCrmCommand(a: Actor, raw: unknown) {
  session(a);
  const b = crmObserve.parse(structuredClone(raw)),
    op = parseCrmOperation(b.method, b.path, b.body),
    request = { method: b.method, path: b.path, body: b.body },
    hash = digest(canonical(request));
  return tenantReadTx(a.tenantId, async (c) => {
    ensure(
      (await role(c, a)) === "admin",
      403,
      "Wymagany aktualny administrator",
    );
    const ack = await prior(c, a, op.body.client_key, request, hash);
    return ack
      ? { status: "ACKNOWLEDGED" as const, ack }
      : { status: "NOT_OBSERVED" as const, automatic_retry: false as const };
  });
}
export async function executeCrmCommand(
  a: Actor,
  method: string,
  path: string,
  raw: unknown,
) {
  session(a);
  const original = structuredClone(raw),
    op = parseCrmOperation(method, path, original),
    request = { method, path, body: original },
    encoded = canonical(request);
  ensure(
    Buffer.byteLength(encoded) <= 3000000,
    413,
    "Polecenie CRM jest zbyt duże",
  );
  const hash = digest(encoded);
  return tenantTx(a.tenantId, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "crm215:" + a.tenantId,
    ]);
    await role(c, a, true);
    const old = await prior(c, a, op.body.client_key, request, hash);
    if (old) return old;
    const result = await apply(c, a, op);
    const response = JSON.parse(JSON.stringify({ data: result }));
    const journal = await c.query(
      "INSERT INTO crm_commands(tenant_id,client_key,actor_id,request_hash,request,response) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(tenant_id,client_key) DO NOTHING RETURNING client_key",
      [
        a.tenantId,
        op.body.client_key,
        a.userId,
        hash,
        JSON.stringify({
          ...journalRequest(request),
          response_sha256: digest(canonical(response)),
        }),
        JSON.stringify(response),
      ],
    );
    ensure(journal.rowCount === 1, 409, "Równoległe polecenie CRM");
    await audit(c, a, "crm." + op.kind, result.id ?? op.id, {
      client_key: op.body.client_key,
    });
    return response;
  });
}

/** Explicit API-key entry into the same CRM business implementation. The old
 * native-session routes keep their original session gate. No actor rewriting. */
export function createCrmClientWirePort(c: PoolClient, a: Actor, proof: BaseWireCrmAuthority) {
  const authorized = (write = false) => assertBaseWireCrmAuthority(c, a, proof, write);
  async function replay(clientKey: string, wireHash: string) {
    authorized(true);
    const stored = (await c.query('SELECT * FROM crm_commands WHERE client_key=$1', [clientKey])).rows[0];
    if (!stored) return null;
    ensure(stored.actor_id === a.userId && stored.request?.wire_api_key_id === a.apiKeyId && stored.request?.wire_request_sha256 === wireHash, 409, 'Klucz polecenia wskazuje inną treść lub aktora Base CRM');
    const request = Object.fromEntries(Object.entries(stored.request).filter(([key]) => !['response_sha256','wire_redacted_request_sha256'].includes(key)));
    ensure(stored.request.wire_redacted_request_sha256 === digest(canonical(request)) && stored.request.response_sha256 === digest(canonical(stored.response)), 503, 'Niespójne potwierdzenie Base CRM');
    // Upload plaintext is intentionally absent from the immutable journal.
    // The caller proves the original wire hash; independently verify the full
    // retained redacted request and response instead of hashing redacted bytes
    // as if they were the original upload request.
    validateCrmReceipt(request, stored.response);
    ensure(stored.response?.data, 503, 'Niespójne potwierdzenie Base CRM');
    return stored.response.data;
  }
  return {
    replay,
    async detail(id: string, includeExtras: boolean) {
      authorized();
      const row = await activeClient(c, id), data = viewClient(row);
      if (includeExtras) data.custom_extra_fields = await extras(c, row.id);
      return data;
    },
    async list(raw: unknown) {
      authorized();
      const q = crmList.parse(raw), params: unknown[] = [q.status_id ?? null, q.client_id ?? null];
      let where = 'deleted_at IS NULL AND ($1::uuid IS NULL OR status_id=$1) AND ($2::uuid IS NULL OR id=$2)';
      for (const key of ['email','phone','login','invoice_company','invoice_tax_id','invoice_fullname'] as const) {
        if (q[key] !== undefined) {
          // Literal substring matching: SQL wildcard characters are data.
          const value = key === 'invoice_tax_id' ? q[key]!.replace(/[\s-]/g, '') : q[key]!;
          params.push(value.replace(/[\\%_]/g, '\\$&'));
          where += ` AND profile->>'${key}' ILIKE '%' || $${params.length} || '%' ESCAPE E'\\\\'`;
        }
      }
      params.push(q.limit, (q.page - 1) * q.limit);
      const rows = (await c.query(`SELECT * FROM crm_clients WHERE ${where} ORDER BY created_at DESC,id LIMIT $${params.length-1} OFFSET $${params.length}`, params)).rows;
      return rows.map(row => viewClient(row, false));
    },
    async fields() {
      authorized();
      return (await readCrmFieldDefinitions(c)).data;
    },
    async save(id: string | null, profile: Record<string, unknown>, clientKey: string, wireHash: string) {
      authorized(true);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['crm215:' + a.tenantId]);
      const retained = await replay(clientKey, wireHash);
      if (retained) return retained;
      const existing = id ? await activeClient(c, id, true) : null;
      const method = id ? 'PATCH' : 'POST', path = '/api/crm/clients' + (id ? '/' + id : '');
      const body = { ...profile, client_key: clientKey, ...(existing ? { version: existing.version } : {}) };
      const op = parseCrmOperation(method, path, body), request = { method, path, body, wire_request_sha256: wireHash, wire_api_key_id: a.apiKeyId }, hash = digest(canonical(request));
      const old = await prior(c, a, clientKey, request, hash);
      if (old) return old.data;
      const result = await apply(c, a, op), response = JSON.parse(JSON.stringify({ data: result }));
      const journal = await c.query('INSERT INTO crm_commands(tenant_id,client_key,actor_id,request_hash,request,response) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(tenant_id,client_key) DO NOTHING RETURNING client_key',
        [a.tenantId, clientKey, a.userId, hash, JSON.stringify({ ...journalRequest(request), wire_redacted_request_sha256: digest(canonical(journalRequest(request))), response_sha256: digest(canonical(response)) }), JSON.stringify(response)]);
      ensure(journal.rowCount === 1, 409, 'Równoległe polecenie CRM');
      await audit(c, a, 'crm.' + op.kind, result.id ?? id, { client_key: clientKey });
      return result;
    },
    async remove(id: string, clientKey: string, wireHash: string) {
      authorized(true);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['crm215:' + a.tenantId]);
      const retained = await replay(clientKey, wireHash);
      if (retained) return retained;
      const existing = await activeClient(c, id, true);
      const method = 'DELETE', path = '/api/crm/clients/' + id;
      const body = { client_key: clientKey, version: existing.version };
      const op = parseCrmOperation(method, path, body), request = { method, path, body, wire_request_sha256: wireHash, wire_api_key_id: a.apiKeyId }, hash = digest(canonical(request));
      const old = await prior(c, a, clientKey, request, hash);
      if (old) return old.data;
      const result = await apply(c, a, op), response = JSON.parse(JSON.stringify({ data: result }));
      const journal = await c.query('INSERT INTO crm_commands(tenant_id,client_key,actor_id,request_hash,request,response) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(tenant_id,client_key) DO NOTHING RETURNING client_key',
        [a.tenantId, clientKey, a.userId, hash, JSON.stringify({ ...journalRequest(request), wire_redacted_request_sha256: digest(canonical(journalRequest(request))), response_sha256: digest(canonical(response)) }), JSON.stringify(response)]);
      ensure(journal.rowCount === 1, 409, 'Równoległe polecenie CRM');
      await audit(c, a, 'crm.' + op.kind, result.id, { client_key: clientKey });
      return result;
    },
    async file(clientId: string, fieldId: string) {
      authorized();
      await activeClient(c, clientId);
      const f = (await c.query('SELECT f.* FROM crm_files f JOIN crm_values v ON (v.tenant_id,v.client_id,v.field_id,v.file_id)=(f.tenant_id,f.client_id,f.field_id,f.id) WHERE f.client_id=$1 AND f.field_id=$2', [clientId, fieldId])).rows[0];
      ensure(f, 404, 'Nie znaleziono pliku');
      const bytes = Buffer.from(decrypt(f.encrypted_bytes).base64, 'base64');
      ensure(bytes.length === f.byte_count && digest(bytes) === f.content_sha256, 503, 'Niespójny plik CRM');
      return { bytes, title: f.title, mime_type: f.mime_type };
    },
  };
}
/** Future dictionary integration only: requires the NOT YET INSTALLED219 group
 * identity map as well as218 status identities. No router/startup registration.
 * All callbacks use the existing CRM store, parser, apply, journal and audit in
 * the caller's transaction; its fresh SQL authority proof is client-bound.
 */
export function createCrmDictionaryWirePort(c: PoolClient, a: Actor, proof: BaseWireCrmAuthority): BaseWireCrmDictionaryPort {
  const methods = {
    addCrmClientStatusGroup: ['status-groups.create', 'status-groups.patch'],
    addCrmClientStatus: ['statuses.create', 'statuses.patch'],
    deleteCrmClientStatusGroup: ['status-groups.delete'],
    deleteCrmClientStatus: ['statuses.delete'],
  } as const;
  const commandSchema = z.object({ clientKey: z.uuid(), wireHash: z.string().regex(/^[a-f0-9]{64}$/), method: z.enum([
    'addCrmClientStatusGroup', 'addCrmClientStatus', 'deleteCrmClientStatusGroup', 'deleteCrmClientStatus',
  ]) }).strict();
  async function ready(writing = false) {
    assertBaseWireCrmAuthority(c, a, proof, writing);
    const rows = (await c.query("SELECT to_regclass('public.base_wire218_status_ids') IS NOT NULL AS status_ready,to_regclass('public.base_wire219_group_ids') IS NOT NULL AS group_ready")).rows;
    ensure(rows.length === 1 && rows[0].status_ready === true && rows[0].group_ready === true, 503, 'Słowniki Base CRM wymagają modułu map grup219');
  }
  const table = (kind: DictionaryKind) => {
    ensure(kind === 'group' || kind === 'status', 422, 'Nieznany typ słownika CRM');
    return kind === 'group' ? 'base_wire219_group_ids' : 'base_wire218_status_ids';
  };
  function receipt(command: CrmDictionaryCommand, data: Row): CrmDictionaryReceipt {
    return { method: command.method, resourceId: z.uuid().parse(data.id).toLowerCase() };
  }
  async function replayInside(raw: CrmDictionaryCommand) {
    const command = commandSchema.parse(raw), stored = (await c.query('SELECT * FROM crm_commands WHERE client_key=$1', [command.clientKey])).rows[0];
    if (!stored) return null;
    ensure(stored.actor_id === a.userId && stored.request?.wire_api_key_id === a.apiKeyId && stored.request?.wire_request_sha256 === command.wireHash, 409, 'Klucz polecenia wskazuje inną treść lub aktora Base CRM');
    const request = Object.fromEntries(Object.entries(stored.request).filter(([key]) => !['response_sha256', 'wire_redacted_request_sha256'].includes(key))) as Row;
    const hash = digest(canonical(request));
    ensure(stored.request_hash === hash && stored.request.wire_redacted_request_sha256 === hash && stored.request.response_sha256 === digest(canonical(stored.response)), 503, 'Niespójne potwierdzenie słownika Base CRM');
    const op = parseCrmOperation(request.method, request.path, request.body);
    ensure((methods[command.method] as readonly string[]).includes(op.kind), 409, 'Potwierdzenie wskazuje inną operację słownika CRM');
    validateCrmReceipt(request, stored.response);
    return receipt(command, stored.response.data);
  }
  async function execute(resource: 'status-groups' | 'statuses', id: string | null, input: Row, raw: CrmDictionaryCommand, removing = false) {
    await ready(true);
    const command = commandSchema.parse(raw);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['crm215:' + a.tenantId]);
    const retained = await replayInside(command);
    if (retained) return retained;
    const nativeTable = resource === 'status-groups' ? 'crm_status_groups' : 'crm_statuses';
    const existing = id ? (await c.query(`SELECT * FROM ${nativeTable} WHERE id=$1 FOR UPDATE`, [z.uuid().parse(id)])).rows[0] : null;
    ensure(!id || existing, 404, 'Nie znaleziono własnego słownika CRM');
    const method = removing ? 'DELETE' : id ? 'PATCH' : 'POST', path = '/api/crm/' + resource + (id ? '/' + id : '');
    const body = { ...input, client_key: command.clientKey, ...(existing ? { version: existing.version } : {}) };
    const op = parseCrmOperation(method, path, body);
    ensure((methods[command.method] as readonly string[]).includes(op.kind), 422, 'Nieprawidłowa operacja słownika Base CRM');
    const request = { method, path, body, wire_request_sha256: command.wireHash, wire_api_key_id: a.apiKeyId }, hash = digest(canonical(request));
    const old = await prior(c, a, command.clientKey, request, hash);
    if (old) return receipt(command, old.data);
    const result = await apply(c, a, op), response = JSON.parse(JSON.stringify({ data: result }));
    validateCrmReceipt(request, response);
    const journal = await c.query('INSERT INTO crm_commands(tenant_id,client_key,actor_id,request_hash,request,response) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(tenant_id,client_key) DO NOTHING RETURNING client_key',
      [a.tenantId, command.clientKey, a.userId, hash, JSON.stringify({ ...journalRequest(request), wire_redacted_request_sha256: hash, response_sha256: digest(canonical(response)) }), JSON.stringify(response)]);
    ensure(journal.rowCount === 1, 409, 'Równoległe polecenie słownika CRM');
    await audit(c, a, 'crm.' + op.kind, result.id ?? id, { client_key: command.clientKey });
    return receipt(command, result);
  }
  return {
    async groups() { await ready(); return (await c.query('SELECT * FROM crm_status_groups ORDER BY is_main_group DESC,name,id')).rows.map(row => group(row) as CrmWireGroup); },
    async statuses() { await ready(); return (await c.query('SELECT * FROM crm_statuses ORDER BY group_id,position,id')).rows.map(row => status(row) as CrmWireStatus); },
    async resolve(kind, publicId) {
      await ready(); z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(publicId);
      const rows = (await c.query(`SELECT local_id FROM ${table(kind)} WHERE tenant_id=$1::uuid AND public_id=$2::bigint AND local_id IS NOT NULL`, [a.tenantId, publicId])).rows;
      ensure(rows.length <= 1, 503, 'Niespójna mapa słownika CRM');
      return rows.length ? z.uuid().parse(rows[0].local_id).toLowerCase() : null;
    },
    async publicId(kind, resourceId) {
      await ready(); z.uuid().parse(resourceId);
      const rows = (await c.query(`SELECT public_id::text AS public_id FROM ${table(kind)} WHERE tenant_id=$1::uuid AND resource_id=$2::uuid`, [a.tenantId, resourceId])).rows;
      ensure(rows.length <= 1 && (!rows.length || typeof rows[0].public_id === 'string'), 503, 'Niespójna trwała tożsamość słownika CRM');
      return rows[0]?.public_id ?? null;
    },
    async replay(command) {
      await ready(true);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['crm215:' + a.tenantId]);
      return replayInside(command);
    },
    saveGroup: (id, input, command) => execute('status-groups', id, input, command),
    saveStatus: (id, input, command) => execute('statuses', id, input, command),
    removeGroup: (id, command) => execute('status-groups', id, {}, command, true),
    removeStatus: (id, targetId, command) => execute('statuses', id, { target_status_id: targetId }, command, true),
  };
}

export async function cancelCrmCommand(a: Actor, raw: unknown) {
  session(a);
  const b = crmObserve.parse(structuredClone(raw)),
    op = parseCrmOperation(b.method, b.path, b.body),
    request = { method: b.method, path: b.path, body: b.body },
    encoded = canonical(request);
  ensure(
    Buffer.byteLength(encoded) <= 3000000,
    413,
    "Polecenie CRM jest zbyt duże",
  );
  const hash = digest(encoded);
  return tenantTx(a.tenantId, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "crm215:" + a.tenantId,
    ]);
    await role(c, a, true);
    const old = await prior(c, a, op.body.client_key, request, hash);
    if (old) return old;
    const response = {
      status: "CRM_COMMAND_CANCELLED" as const,
      client_key: op.body.client_key,
      method: b.method,
      path: b.path,
      automatic_retry: false as const,
    };
    const r = await c.query(
      "INSERT INTO crm_commands(tenant_id,client_key,actor_id,request_hash,request,response) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(tenant_id,client_key) DO NOTHING RETURNING client_key",
      [
        a.tenantId,
        op.body.client_key,
        a.userId,
        hash,
        JSON.stringify({
          ...journalRequest(request),
          response_sha256: digest(canonical(response)),
        }),
        JSON.stringify(response),
      ],
    );
    ensure(r.rowCount === 1, 409, "Równoległe polecenie CRM");
    await audit(c, a, "crm.command.cancel", op.id, {
      client_key: op.body.client_key,
    });
    return response;
  });
}
async function apply(c: PoolClient, a: Actor, op: Operation): Promise<Row> {
  if (op.kind.startsWith("field-definitions."))
    return applyCrmFieldCommand(c, a.tenantId, op);
  const b = op.body,
    id = op.id;
  if (op.kind === "clients.create" || op.kind === "clients.patch") {
    const existing = id ? await activeClient(c, id, true) : null;
    if (existing)
      ensure(existing.version === b.version, 409, "Klient został zmieniony");
    const statusId =
      b.status_id ??
      existing?.status_id ??
      (await c.query("SELECT id FROM crm_statuses WHERE is_primary")).rows[0]
        ?.id;
    ensure(statusId, 503, "Brak głównego statusu CRM");
    ensure(
      (
        await c.query("SELECT id FROM crm_statuses WHERE id=$1 FOR SHARE", [
          statusId,
        ])
      ).rows.length === 1,
      422,
      "Nieznany lub obcy status",
    );
    const profile = { ...(existing?.profile ?? defaults) };
    for (const k of Object.keys(defaults))
      if (Object.hasOwn(b, k)) profile[k] = b[k];
    ensure(
      Buffer.byteLength(JSON.stringify(profile)) <= 60000,
      422,
      "Profil klienta jest zbyt duży",
    );
    let row: Row;
    if (existing)
      row = (
        await c.query(
          "UPDATE crm_clients SET profile=$2::jsonb,status_id=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [id, JSON.stringify(profile), statusId],
        )
      ).rows[0];
    else
      row = (
        await c.query(
          "INSERT INTO crm_clients(tenant_id,status_id,profile) VALUES($1,$2,$3::jsonb) RETURNING *",
          [a.tenantId, statusId, JSON.stringify(profile)],
        )
      ).rows[0];
    if (b.custom_extra_fields)
      await applyExtras(c, a, row.id, b.custom_extra_fields);
    return viewClient(row);
  }
  if (op.kind === "clients.delete") {
    const row = await activeClient(c, id!, true);
    ensure(row.version === b.version, 409, "Klient został zmieniony");
    await c.query(
      "UPDATE crm_clients SET deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1",
      [id],
    );
    return { id, deleted: true };
  }
  if (op.kind === "link") {
    const row = await activeClient(c, id!, true);
    ensure(row.version === b.version, 409, "Klient został zmieniony");
    ensure(
      (
        await c.query("SELECT id FROM orders WHERE id=$1 FOR SHARE", [
          b.order_id,
        ])
      ).rows.length === 1,
      404,
      "Nie znaleziono własnego zamówienia",
    );
    const link = (
      await c.query("SELECT client_id FROM crm_order_links WHERE order_id=$1", [
        b.order_id,
      ])
    ).rows[0];
    ensure(
      !link || link.client_id === id,
      409,
      "Zamówienie jest przypisane do innego klienta",
    );
    await c.query(
      "INSERT INTO crm_order_links(tenant_id,client_id,order_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [a.tenantId, id, b.order_id],
    );
    const next = (
      await c.query(
        "UPDATE crm_clients SET version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
    return viewClient(next);
  }
  if (op.kind === "status-groups.create")
    return group(
      (
        await c.query(
          "INSERT INTO crm_status_groups(tenant_id,name) VALUES($1,$2) RETURNING *",
          [a.tenantId, b.name],
        )
      ).rows[0],
    );
  if (op.kind === "status-groups.patch" || op.kind === "status-groups.delete") {
    const g = (
      await c.query("SELECT * FROM crm_status_groups WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    ensure(g, 404, "Nie znaleziono grupy");
    ensure(g.version === b.version, 409, "Grupa została zmieniona");
    if (op.kind.endsWith("patch"))
      return group(
        (
          await c.query(
            "UPDATE crm_status_groups SET name=$2,version=version+1 WHERE id=$1 RETURNING *",
            [id, b.name],
          )
        ).rows[0],
      );
    ensure(!g.is_main_group, 409, "Nie można usunąć grupy głównej");
    const main = (
      await c.query(
        "SELECT * FROM crm_status_groups WHERE is_main_group FOR UPDATE",
      )
    ).rows[0];
    ensure(main, 503, "Brak grupy głównej");
    await c.query(
      "WITH moved AS (SELECT id,row_number() OVER(ORDER BY position,id) AS n FROM crm_statuses WHERE group_id=$1),last_position AS (SELECT coalesce(max(position),-1) AS p FROM crm_statuses WHERE group_id=$2) UPDATE crm_statuses s SET group_id=$2,position=last_position.p+moved.n,version=version+1 FROM moved,last_position WHERE s.id=moved.id",
      [id, main.id],
    );
    await c.query("DELETE FROM crm_status_groups WHERE id=$1", [id]);
    return { id, deleted: true };
  }
  if (op.kind === "statuses.create") {
    const groupId =
      b.group_id ??
      (await c.query("SELECT id FROM crm_status_groups WHERE is_main_group"))
        .rows[0]?.id;
    ensure(groupId, 503, "Brak grupy głównej");
    ensure(
      (
        await c.query(
          "SELECT id FROM crm_status_groups WHERE id=$1 FOR SHARE",
          [groupId],
        )
      ).rows.length === 1,
      422,
      "Nieznana lub obca grupa",
    );
    return status(
      (
        await c.query(
          "INSERT INTO crm_statuses(tenant_id,group_id,name,color,position) SELECT $1,$2,$3,$4,coalesce(max(position),-1)+1 FROM crm_statuses WHERE group_id=$2 RETURNING *",
          [a.tenantId, groupId, b.name, b.color],
        )
      ).rows[0],
    );
  }
  const s = (
    await c.query("SELECT * FROM crm_statuses WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  ensure(s, 404, "Nie znaleziono statusu");
  ensure(s.version === b.version, 409, "Status został zmieniony");
  if (op.kind === "statuses.patch") {
    const groupId = b.group_id ?? s.group_id;
    ensure(
      (
        await c.query(
          "SELECT id FROM crm_status_groups WHERE id=$1 FOR SHARE",
          [groupId],
        )
      ).rows.length === 1,
      422,
      "Nieznana lub obca grupa",
    );
    ensure(
      !s.is_primary || groupId === s.group_id,
      409,
      "Status główny zachowuje swoją grupę",
    );
    const position =
      groupId === s.group_id
        ? s.position
        : (
            await c.query(
              "SELECT coalesce(max(position),-1)+1 AS position FROM crm_statuses WHERE group_id=$1",
              [groupId],
            )
          ).rows[0].position;
    return status(
      (
        await c.query(
          "UPDATE crm_statuses SET name=$2,color=$3,group_id=$4,position=$5,version=version+1 WHERE id=$1 RETURNING *",
          [id, b.name ?? s.name, b.color ?? s.color, groupId, position],
        )
      ).rows[0],
    );
  }
  ensure(!s.is_primary, 409, "Nie można usunąć statusu głównego");
  ensure(id !== b.target_status_id, 422, "Status docelowy musi być inny");
  ensure(
    (
      await c.query("SELECT id FROM crm_statuses WHERE id=$1 FOR SHARE", [
        b.target_status_id,
      ])
    ).rows.length === 1,
    422,
    "Nieznany lub obcy status docelowy",
  );
  await c.query(
    "UPDATE crm_clients SET status_id=$2,version=version+1,updated_at=clock_timestamp() WHERE status_id=$1",
    [id, b.target_status_id],
  );
  await c.query("DELETE FROM crm_statuses WHERE id=$1", [id]);
  return { id, deleted: true };
}
