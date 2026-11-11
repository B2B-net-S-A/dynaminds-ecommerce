export type CrmContext = {
  tenantId: string;
  userId: string;
  admin: boolean;
  readOnly: boolean;
  externalWriteBlocked?: boolean;
};
export type CrmRequest = {
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body: Record<string, unknown> & { client_key: string };
};
export type CrmCancelledAck = {
  status: "CRM_COMMAND_CANCELLED";
  client_key: string;
  method: CrmRequest["method"];
  path: string;
  automatic_retry: false;
};
export const isCrmCancelledAck = (value: any): value is CrmCancelledAck =>
  value?.status === "CRM_COMMAND_CANCELLED";
export type CrmCommand = CrmRequest & {
  tenant_id: string;
  user_id: string;
  created_at: string;
  phase: "sent" | "unknown" | "acknowledged" | "rejected";
  ack?: { data: any } | CrmCancelledAck;
  rejection?: { http_status: number };
};
type Store = Pick<Storage, "getItem" | "setItem">;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const crmCommandPending = (m: CrmCommand) =>
  m.phase === "sent" || m.phase === "unknown";
const fail = () => {
  throw Error(
    "Nie można potwierdzić zachowanego polecenia CRM. Kolejne zapisy są zablokowane.",
  );
};
const canonical = (v: any): any =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export const sameCrmValue = (a: any, b: any) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function crmCommandKey(c: CrmContext) {
  if (!UUID.test(c.tenantId) || !UUID.test(c.userId)) fail();
  return `dyna:crm-command:v1:${c.tenantId}:${c.userId}`;
}
export function validateCrmRequest(r: CrmRequest) {
  if (
    !r ||
    !["POST", "PATCH", "DELETE"].includes(r.method) ||
    !/^\/api\/crm\/(clients|statuses|status-groups|field-definitions)(\/[a-f0-9-]{36})?(\/orders)?$/i.test(
      r.path,
    ) ||
    !r.body ||
    typeof r.body !== "object" ||
    Array.isArray(r.body) ||
    !UUID.test(r.body.client_key) ||
    JSON.stringify(r).length > 3000000
  )
    fail();
  if (r.path.includes("/field-definitions") && r.method === "DELETE") fail();
  const part = r.path.split("/").at(-1)!;
  if (part === "orders") {
    if (
      r.method !== "POST" ||
      !/^\/api\/crm\/clients\/[a-f0-9-]{36}\/orders$/i.test(r.path) ||
      !UUID.test(String(r.body.order_id)) ||
      !Number.isSafeInteger(r.body.version) ||
      Number(r.body.version) < 1
    )
      fail();
  } else if (r.method === "POST") {
    if (UUID.test(part)) fail();
  } else if (
    !UUID.test(part) ||
    !Number.isSafeInteger(r.body.version) ||
    Number(r.body.version) < 1
  )
    fail();
  return structuredClone(r);
}
const PROFILE_TEXT = [
  "login",
  "phone",
  "email",
  "notes",
  "invoice_company",
  "invoice_fullname",
  "invoice_address",
  "invoice_postcode",
  "invoice_city",
  "invoice_state",
  "invoice_country_code",
  "invoice_tax_id",
  "delivery_company",
  "delivery_fullname",
  "delivery_address",
  "delivery_postcode",
  "delivery_city",
  "delivery_state",
  "delivery_country_code",
];
const exact = (v: any, keys: string[]) => {
  if (!v || Object.keys(v).sort().join(",") !== [...keys].sort().join(","))
    fail();
};
export function validateCrmAck(m: CrmCommand, ack: any) {
  if (isCrmCancelledAck(ack)) {
    exact(ack, ["status", "client_key", "method", "path", "automatic_retry"]);
    if (
      !UUID.test(ack.client_key) ||
      ack.client_key.toLowerCase() !== m.body.client_key.toLowerCase() ||
      ack.method !== m.method ||
      ack.path !== m.path ||
      ack.automatic_retry !== false
    )
      fail();
    return structuredClone(ack);
  }
  if (
    !ack ||
    typeof ack !== "object" ||
    Array.isArray(ack) ||
    Object.keys(ack).join(",") !== "data" ||
    !ack.data ||
    typeof ack.data !== "object" ||
    Array.isArray(ack.data) ||
    !UUID.test(ack.data.id)
  )
    fail();
  const d = ack.data,
    link = m.path.endsWith("/orders"),
    id = link ? m.path.split("/").at(-2) : m.path.split("/").at(-1),
    resource = m.path.split("/")[3];
  if ((m.method !== "POST" || link) && d.id !== id) fail();
  if (m.method === "DELETE") {
    exact(d, ["id", "deleted"]);
    if (d.deleted !== true) fail();
    return structuredClone(ack);
  }
  if (
    d.version !==
    (m.method === "POST" && !link ? 1 : Number(m.body.version) + 1)
  )
    fail();
  if (resource === "clients") {
    exact(d, [
      ...PROFILE_TEXT,
      "id",
      "status_id",
      "version",
      "star",
      "contractor_id",
      "created_at",
      "updated_at",
    ]);
    if (
      !UUID.test(d.status_id) ||
      !Number.isInteger(d.star) ||
      d.star < 0 ||
      d.star > 5 ||
      !Number.isSafeInteger(d.contractor_id) ||
      d.contractor_id < 0 ||
      !PROFILE_TEXT.every((k) => typeof d[k] === "string") ||
      !["created_at", "updated_at"].every(
        (k) => typeof d[k] === "string" && Number.isFinite(Date.parse(d[k])),
      )
    )
      fail();
    for (const k of [...PROFILE_TEXT, "status_id", "star", "contractor_id"])
      if (Object.hasOwn(m.body, k)) {
        const expected =
          k === "invoice_tax_id"
            ? String(m.body[k]).replace(/[\s-]/g, "")
            : m.body[k];
        if (d[k] !== expected) fail();
      }
  } else if (resource === "field-definitions") {
    exact(d, [
      "id",
      "name",
      "editor_type",
      "options",
      "position",
      "version",
      "archived",
    ]);
    if (
      typeof d.name !== "string" ||
      !d.name.trim() ||
      d.name.length > 120 ||
      ![
        "text",
        "number",
        "select",
        "checkbox",
        "radio",
        "date",
        "file",
      ].includes(d.editor_type) ||
      !Array.isArray(d.options) ||
      !d.options.every(
        (v: any) => typeof v === "string" && v.length > 0 && v.length <= 200,
      ) ||
      new Set(d.options).size !== d.options.length ||
      d.options.length > 100 ||
      !Number.isSafeInteger(d.position) ||
      d.position < 0 ||
      typeof d.archived !== "boolean"
    )
      fail();
    if (
      ["select", "checkbox", "radio"].includes(d.editor_type)
        ? d.options.length === 0
        : d.options.length !== 0
    )
      fail();
    if (
      m.method === "POST" &&
      (d.editor_type !== m.body.editor_type || d.archived !== false)
    )
      fail();
    for (const k of ["name", "options", "position", "archived"])
      if (Object.hasOwn(m.body, k)) {
        const expected =
          k === "name"
            ? String(m.body[k]).trim()
            : k === "options"
              ? (m.body[k] as string[]).map((x) => x.trim())
              : m.body[k];
        if (!sameCrmValue(d[k], expected)) fail();
      }
  } else if (resource === "statuses") {
    exact(d, [
      "id",
      "name",
      "color",
      "group_id",
      "is_primary",
      "position",
      "version",
    ]);
    if (
      typeof d.name !== "string" ||
      !/^#[a-f0-9]{6}$/i.test(d.color) ||
      !UUID.test(d.group_id) ||
      ![0, 1].includes(d.is_primary) ||
      !Number.isSafeInteger(d.position) ||
      d.position < 0 ||
      (m.method === "POST" && d.is_primary !== 0)
    )
      fail();
    for (const k of ["name", "color", "group_id"])
      if (
        Object.hasOwn(m.body, k) &&
        d[k] !== (k === "name" ? String(m.body[k]).trim() : m.body[k])
      )
        fail();
  } else if (resource === "status-groups") {
    exact(d, ["id", "name", "is_main_group", "version"]);
    if (
      typeof d.name !== "string" ||
      ![0, 1].includes(d.is_main_group) ||
      d.name !== String(m.body.name).trim() ||
      (m.method === "POST" && d.is_main_group !== 0)
    )
      fail();
  } else fail();
  return structuredClone(ack);
}
function parse(raw: string | null, c: CrmContext): CrmCommand | null {
  if (raw === null) return null;
  if (raw.length > 3100000) fail();
  let m: any;
  try {
    m = JSON.parse(raw);
  } catch {
    fail();
  }
  if (
    !m ||
    m.tenant_id !== c.tenantId ||
    m.user_id !== c.userId ||
    typeof m.created_at !== "string" ||
    !Number.isFinite(Date.parse(m.created_at)) ||
    !["sent", "unknown", "acknowledged", "rejected"].includes(m.phase) ||
    Object.keys(m).sort().join(",") !==
      [
        "method",
        "path",
        "body",
        "tenant_id",
        "user_id",
        "created_at",
        "phase",
        ...(m.ack === undefined ? [] : ["ack"]),
        ...(m.rejection === undefined ? [] : ["rejection"]),
      ]
        .sort()
        .join(",")
  )
    fail();
  validateCrmRequest(m);
  if (m.phase === "acknowledged") validateCrmAck(m, m.ack);
  else if (m.ack !== undefined) fail();
  if (m.phase === "rejected") {
    if (
      Object.keys(m.rejection ?? {}).join(",") !== "http_status" ||
      ![400, 401, 403, 404, 409, 413, 422, 423].includes(
        m.rejection.http_status,
      )
    )
      fail();
  } else if (m.rejection !== undefined) fail();
  return m;
}
export function readCrmCommand(session: Store, shared: Store, c: CrmContext) {
  const key = crmCommandKey(c),
    a = parse(session.getItem(key), c),
    b = parse(shared.getItem(key), c);
  if (!a) return b;
  if (!b) return a;
  if (a.body.client_key !== b.body.client_key)
    return !crmCommandPending(a) ? b : a;
  for (const k of ["method", "path", "body", "created_at"] as const)
    if (!sameCrmValue(a[k], b[k])) fail();
  if (!crmCommandPending(a) && !crmCommandPending(b) && !sameCrmValue(a, b))
    fail();
  return !crmCommandPending(a)
    ? a
    : !crmCommandPending(b)
      ? b
      : a.phase === "unknown"
        ? a
        : b;
}
export function saveCrmCommand(
  session: Store,
  shared: Store,
  c: CrmContext,
  m: CrmCommand,
) {
  const raw = JSON.stringify(m),
    valid = parse(raw, c)!;
  const before = readCrmCommand(session, shared, c);
  if (
    before &&
    before.body.client_key !== m.body.client_key &&
    crmCommandPending(before)
  )
    fail();
  if (before?.body.client_key === m.body.client_key) {
    if (
      !sameCrmValue(
        {
          method: before.method,
          path: before.path,
          body: before.body,
          created_at: before.created_at,
        },
        {
          method: m.method,
          path: m.path,
          body: m.body,
          created_at: m.created_at,
        },
      )
    )
      fail();
    if (!crmCommandPending(before) && !sameCrmValue(before, valid)) fail();
  }
  const key = crmCommandKey(c),
    local = parse(session.getItem(key), c),
    global = parse(shared.getItem(key), c);
  if (
    local?.body.client_key === m.body.client_key &&
    global &&
    global.body.client_key !== m.body.client_key
  ) {
    session.setItem(key, raw);
    if (session.getItem(key) !== raw) fail();
    return readCrmCommand(session, shared, c)!;
  }
  shared.setItem(key, raw);
  if (shared.getItem(key) !== raw) fail();
  session.setItem(key, raw);
  if (session.getItem(key) !== raw) fail();
  return valid;
}
