import { useEffect, useRef, useState } from "react";
import { api, date, money } from "./api";
import {
  crmCommandKey,
  crmCommandPending,
  isCrmCancelledAck,
  readCrmCommand,
  saveCrmCommand,
  validateCrmAck,
  type CrmCommand,
  type CrmContext,
  type CrmRequest,
} from "./crm-commands";
import "./crm.css";
import { RodoCustomerPanel } from "./rodo228";
type Group = {
  id: string;
  name: string;
  is_main_group: 0 | 1;
  version: number;
};
type Status = {
  id: string;
  name: string;
  color: string;
  group_id: string;
  is_primary: 0 | 1;
  position: number;
  version: number;
};
type Definition = {
  extra_field_id: string;
  name: string;
  editor_type:
    "text" | "number" | "select" | "checkbox" | "radio" | "date" | "file";
  options: string[];
  version?: number;
  position?: number;
  archived?: boolean;
};
type Client = {
  id: string;
  version: number;
  status_id: string;
  star: number;
  contractor_id: number;
  created_at: string;
  updated_at: string;
  custom_extra_fields?: Record<string, any>;
  [key: string]: any;
};
type Metadata = {
  scope: string;
  groups: Group[];
  statuses: Status[];
  fields: Definition[];
  fileMax: number;
  definitionEditor: boolean;
};
type Page = {
  scope: string;
  key: string;
  data: Client[];
  meta: { page: number; limit: number; has_more: boolean };
  can_write: boolean;
  read_only: boolean;
};
async function crmApi(...args: Parameters<typeof api>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await api(
      args[0],
      args[1],
      args[2],
      args[3],
      controller.signal,
      args[5],
    );
  } finally {
    clearTimeout(timer);
  }
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const UPDATED = "dyna:crm-command-updated";
const groupsOfFields = [
  {
    name: "Kontakt",
    fields: [
      ["login", "Login", 156],
      ["phone", "Telefon", 156],
      ["email", "Email", 220],
    ],
  },
  {
    name: "Dane do faktury",
    fields: [
      ["invoice_company", "Firma", 500],
      ["invoice_fullname", "Imię i nazwisko", 500],
      ["invoice_address", "Adres", 500],
      ["invoice_postcode", "Kod pocztowy", 20],
      ["invoice_city", "Miasto", 100],
      ["invoice_state", "Region", 35],
      ["invoice_country_code", "Kod kraju", 2],
      ["invoice_tax_id", "NIP", 50],
    ],
  },
  {
    name: "Dane dostawy",
    fields: [
      ["delivery_company", "Firma odbiorcy", 500],
      ["delivery_fullname", "Imię i nazwisko odbiorcy", 500],
      ["delivery_address", "Adres dostawy", 500],
      ["delivery_postcode", "Kod pocztowy dostawy", 20],
      ["delivery_city", "Miasto dostawy", 100],
      ["delivery_state", "Region dostawy", 35],
      ["delivery_country_code", "Kod kraju dostawy", 2],
    ],
  },
] as const;
function rows<T>(x: any, valid: (r: any) => boolean): T[] {
  if (
    !Array.isArray(x?.data) ||
    !x.data.every(valid) ||
    new Set(x.data.map((r: any) => r.id ?? r.extra_field_id)).size !==
      x.data.length
  )
    throw Error("Otrzymano niepełny odczyt kartoteki.");
  return x.data;
}
function client(c: any) {
  return (
    c &&
    groupsOfFields.every((g) =>
      g.fields.every(([key]) => typeof c[key] === "string"),
    ) &&
    ["created_at", "updated_at"].every(
      (k) => typeof c[k] === "string" && Number.isFinite(Date.parse(c[k])),
    ) &&
    UUID.test(c.id) &&
    Number.isSafeInteger(c.version) &&
    c.version > 0 &&
    UUID.test(c.status_id) &&
    Number.isInteger(c.star) &&
    c.star >= 0 &&
    c.star <= 5 &&
    Number.isSafeInteger(c.contractor_id) &&
    c.contractor_id >= 0
  );
}
function getDetail(r: any, id: string, include: boolean) {
  if (
    !client(r?.data) ||
    r.data.id !== id ||
    typeof r.can_write !== "boolean" ||
    typeof r.read_only !== "boolean" ||
    (include &&
      (!r.data.custom_extra_fields ||
        typeof r.data.custom_extra_fields !== "object" ||
        Array.isArray(r.data.custom_extra_fields))) ||
    (!include && Object.hasOwn(r.data, "custom_extra_fields"))
  )
    throw Error("Nie potwierdzono szczegółów wybranego klienta.");
  return r;
}
export function CrmWorkspace({
  context,
  refresh = 0,
}: {
  context: CrmContext;
  refresh?: number;
}) {
  const scope = [
      context.tenantId,
      context.userId,
      context.admin,
      context.readOnly,
      context.externalWriteBlocked,
    ].join(":"),
    latest = useRef(scope),
    mounted = useRef(false),
    writing = useRef<object | null>(null),
    loadId = useRef(0),
    detailId = useRef(0);
  latest.current = scope;
  const [tab, setTab] = useState<"clients" | "statuses" | "fields">("clients"),
    [metadata, setMetadata] = useState<Metadata | null>(null),
    [list, setList] = useState<Page | null>(null),
    [detail, setDetail] = useState<{
      scope: string;
      id: string;
      data: Client;
      can_write: boolean;
      read_only: boolean;
      include: boolean;
    } | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [creating, setCreating] = useState(false),
    [filters, setFilters] = useState({ search: "", status_id: "" }),
    [query, setQuery] = useState({ search: "", status_id: "", page: 1 }),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(false),
    [busyScope, setBusyScope] = useState<string | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [cancelConsent, setCancelConsent] = useState<string | null>(null),
    [journal, setJournal] = useState<{
      scope: string;
      value: CrmCommand | null;
      error: boolean;
    } | null>(null);
  const live = () => mounted.current && latest.current === scope,
    meta = metadata?.scope === scope ? metadata : null,
    pageKey = JSON.stringify(query),
    page = list?.scope === scope && list.key === pageKey ? list : null,
    chosen = detail?.scope === scope && detail.id === selected ? detail : null,
    busy = busyScope === scope,
    pending =
      journal?.scope === scope &&
      journal.value &&
      crmCommandPending(journal.value)
        ? journal.value
        : null,
    custodyBad = journal?.scope === scope && journal.error,
    writeBlocked =
      busy ||
      loading ||
      !context.admin ||
      context.readOnly ||
      context.externalWriteBlocked ||
      !!pending ||
      !!custodyBad ||
      page?.read_only === true ||
      page?.can_write === false;
  function readJournal() {
    const value = readCrmCommand(sessionStorage, localStorage, context);
    if (live()) setJournal({ scope, value, error: false });
    return value;
  }
  function persist(c: CrmContext, m: CrmCommand) {
    const value = saveCrmCommand(sessionStorage, localStorage, c, m);
    if (live()) setJournal({ scope, value, error: false });
    window.dispatchEvent(
      new CustomEvent(UPDATED, { detail: crmCommandKey(c) }),
    );
    return value;
  }
  async function actor(write = false) {
    if (!live()) throw Error("Firma lub użytkownik ulegli zmianie.");
    const me = await crmApi("/auth/me");
    if (
      !live() ||
      me.user?.tenant_id !== context.tenantId ||
      me.user?.id !== context.userId ||
      !["admin", "operator", "viewer"].includes(me.user?.role) ||
      (write &&
        (!context.admin ||
          me.user.role !== "admin" ||
          context.readOnly ||
          context.externalWriteBlocked ||
          me.restore_preview !== false))
    )
      throw Error("Wymagana aktualna sesja i uprawnienia tej firmy.");
    return me;
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++loadId.current;
      ++detailId.current;
    };
  }, []);
  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setCreating(false);
    setMetadata(null);
    setList(null);
    setError("");
    setNotice("");
    setFilters({ search: "", status_id: "" });
    setQuery({ search: "", status_id: "", page: 1 });
    setBusyScope(null);
    writing.current = null;
    const update = () => {
      try {
        readJournal();
      } catch {
        if (live()) setJournal({ scope, value: null, error: true });
      }
    };
    update();
    const changed = (e: Event) => {
      if (
        (e instanceof StorageEvent ? e.key : (e as CustomEvent).detail) ===
        crmCommandKey(context)
      )
        update();
    };
    window.addEventListener("storage", changed);
    window.addEventListener(UPDATED, changed);
    return () => {
      window.removeEventListener("storage", changed);
      window.removeEventListener(UPDATED, changed);
    };
  }, [scope]);
  useEffect(() => {
    const token = ++loadId.current;
    setLoading(true);
    void (async () => {
      await actor();
      const [c, g, s, f] = await Promise.all([
        crmApi(
          "/crm/clients?" +
            new URLSearchParams({
              search: query.search,
              ...(query.status_id ? { status_id: query.status_id } : {}),
              page: String(query.page),
              limit: "50",
            }),
        ),
        crmApi("/crm/status-groups"),
        crmApi("/crm/statuses"),
        crmApi("/crm/extra-fields"),
      ]);
      await actor();
      const data = rows<Client>(c, client),
        groups = rows<Group>(
          g,
          (r) =>
            UUID.test(r.id) &&
            typeof r.name === "string" &&
            [0, 1].includes(r.is_main_group) &&
            Number.isSafeInteger(r.version),
        ),
        statuses = rows<Status>(
          s,
          (r) =>
            UUID.test(r.id) &&
            UUID.test(r.group_id) &&
            typeof r.name === "string" &&
            /^#[a-f0-9]{6}$/i.test(r.color) &&
            [0, 1].includes(r.is_primary) &&
            Number.isSafeInteger(r.version),
        ),
        fields = rows<Definition>(
          f,
          (r) =>
            UUID.test(r.extra_field_id) &&
            typeof r.name === "string" &&
            [
              "text",
              "number",
              "select",
              "checkbox",
              "radio",
              "date",
              "file",
            ].includes(r.editor_type) &&
            Array.isArray(r.options) &&
            r.options.every((v: any) => typeof v === "string"),
        );
      if (
        f.policy?.definition_editor_available === true &&
        fields.some(
          (r) =>
            !Number.isSafeInteger(r.version) ||
            Number(r.version) < 1 ||
            !Number.isSafeInteger(r.position) ||
            Number(r.position) < 0 ||
            typeof r.archived !== "boolean",
        )
      )
        throw Error("Nie potwierdzono wersji definicji pól.");
      if (
        data.some(
          (r) =>
            Object.hasOwn(r, "notes") ||
            Object.hasOwn(r, "custom_extra_fields"),
        )
      )
        throw Error("Lista zwróciła dane spoza żądanego zakresu.");
      if (
        c.meta?.page !== query.page ||
        c.meta?.limit !== 50 ||
        typeof c.meta.has_more !== "boolean" ||
        typeof c.can_write !== "boolean" ||
        typeof c.read_only !== "boolean" ||
        !Number.isSafeInteger(f.policy?.file_max_bytes) ||
        f.policy.file_max_bytes < 1 ||
        f.policy.file_max_bytes > 2000000
      )
        throw Error("Nie potwierdzono strony lub zasad kartoteki.");
      if (live() && token === loadId.current) {
        setMetadata({
          scope,
          groups,
          statuses,
          fields,
          fileMax: f.policy.file_max_bytes,
          definitionEditor: f.policy.definition_editor_available === true,
        });
        setList({
          scope,
          key: pageKey,
          data,
          meta: c.meta,
          can_write: c.can_write,
          read_only: c.read_only,
        });
      }
    })()
      .catch((e) => live() && token === loadId.current && setError(e.message))
      .finally(() => live() && token === loadId.current && setLoading(false));
  }, [scope, pageKey, refresh, revision]);
  async function open(id: string, include = false) {
    const token = ++detailId.current;
    setSelected(id);
    setCreating(false);
    setDetail(null);
    setError("");
    try {
      await actor();
      const d = getDetail(
        await crmApi(
          "/crm/clients/" + id + "?include_custom_extra_fields=" + include,
        ),
        id,
        include,
      );
      await actor();
      if (live() && token === detailId.current)
        setDetail({
          scope,
          id,
          data: d.data,
          can_write: d.can_write,
          read_only: d.read_only,
          include,
        });
    } catch (e) {
      if (live() && token === detailId.current) setError((e as Error).message);
    }
  }
  async function locked(work: () => Promise<void>) {
    if (writing.current || !live()) return;
    const token = {};
    writing.current = token;
    setBusyScope(scope);
    setError("");
    setNotice("");
    try {
      if (!navigator.locks?.request)
        throw Error(
          "Nie można bezpiecznie zablokować równoległego zapisu z innych kart.",
        );
      await navigator.locks.request(
        crmCommandKey(context),
        { mode: "exclusive" },
        async () => {
          if (!live()) throw Error("Firma uległa zmianie.");
          await work();
        },
      );
    } catch (e) {
      if (live()) setError((e as Error).message);
    } finally {
      if (writing.current === token) {
        writing.current = null;
        if (live()) setBusyScope(null);
      }
    }
  }
  async function mutate(
    method: CrmRequest["method"],
    path: string,
    body: Record<string, unknown>,
  ) {
    await locked(async () => {
      await actor(true);
      const previous = readJournal();
      if (previous && crmCommandPending(previous))
        throw Error("Najpierw odczytaj wynik oryginalnego polecenia.");
      const c = { ...context },
        m: CrmCommand = {
          tenant_id: c.tenantId,
          user_id: c.userId,
          created_at: new Date().toISOString(),
          method,
          path: "/api" + path,
          body: { ...body, client_key: crypto.randomUUID() },
          phase: "sent",
        };
      persist(c, m);
      let acked = false,
        rejected = false;
      try {
        const result = await crmApi(
          path,
          method,
          m.body,
          {},
          undefined,
          (value, response) => {
            if (!response.ok) {
              if (
                response.workspace === c.tenantId &&
                [400, 401, 403, 404, 409, 413, 422, 423].includes(
                  response.status,
                )
              ) {
                persist(c, {
                  ...m,
                  phase: "rejected",
                  rejection: { http_status: response.status },
                });
                rejected = true;
              }
              return;
            }
            if (response.workspace !== c.tenantId)
              throw Error("Odpowiedź dotyczy innej firmy.");
            const ack = validateCrmAck(m, value);
            persist(c, { ...m, phase: "acknowledged", ack });
            acked = true;
          },
        );
        if (!acked) {
          const ack = validateCrmAck(m, result);
          persist(c, { ...m, phase: "acknowledged", ack });
          acked = true;
        }
        if (live()) {
          if (isCrmCancelledAck(result)) {
            setNotice("Oryginalne polecenie anulowano. Nie wykonano zapisu.");
            setRevision((v) => v + 1);
            return;
          }
          setNotice(
            method === "DELETE"
              ? "Usunięto wskazany wpis. Historia zamówień została zachowana."
              : "Zapis potwierdzony.",
          );
          setRevision((v) => v + 1);
          if (path.startsWith("/crm/clients")) {
            if (method === "DELETE") {
              setSelected(null);
              setDetail(null);
            } else {
              setCreating(false);
              void open(result.data.id, chosen?.include ?? false);
            }
          } else if (selected) void open(selected, chosen?.include ?? false);
        }
      } catch (e) {
        if (!acked && !rejected) {
          try {
            const current = readCrmCommand(sessionStorage, localStorage, c);
            if (
              current?.body.client_key === m.body.client_key &&
              crmCommandPending(current)
            )
              persist(c, { ...m, phase: "unknown" });
          } catch {
            if (live()) setJournal({ scope, value: m, error: true });
          }
        }
        throw e;
      }
    });
  }
  async function observe() {
    await locked(async () => {
      const me = await actor();
      if (!context.admin || me.user.role !== "admin")
        throw Error("Wymagana aktualna sesja administratora.");
      const m = readJournal();
      if (!m || !crmCommandPending(m)) return;
      const response = await crmApi("/crm/commands/observe", "POST", {
        method: m.method,
        path: m.path,
        body: m.body,
      });
      if (
        response?.status === "NOT_OBSERVED" &&
        response.automatic_retry === false
      ) {
        setNotice(
          "Nie znaleziono potwierdzenia. Oryginalne polecenie pozostaje zachowane; nie ponawiaj zapisu.",
        );
        return;
      }
      if (
        response?.status !== "ACKNOWLEDGED" ||
        Object.keys(response).sort().join(",") !== "ack,status"
      )
        throw Error("Nie potwierdzono oryginalnego wyniku.");
      const ack = validateCrmAck(m, response.ack);
      persist(context, { ...m, phase: "acknowledged", ack });
      await actor();
      if (live()) {
        if (isCrmCancelledAck(ack)) {
          setNotice(
            "Odczytano anulowanie oryginalnego polecenia. Nie wykonano zapisu.",
          );
          setRevision((v) => v + 1);
          return;
        }
        setNotice(
          "Odczytano oryginalny wynik. Aktualna kartoteka zostanie odświeżona.",
        );
        setRevision((v) => v + 1);
        if (m.path.includes("/clients")) {
          if (m.method === "DELETE") {
            setSelected(null);
            setDetail(null);
          } else void open(ack.data.id, chosen?.include ?? false);
        } else if (selected) void open(selected, chosen?.include ?? false);
      }
    });
  }
  async function cancelOriginal() {
    await locked(async () => {
      await actor(true);
      const m = readJournal();
      if (!m || !crmCommandPending(m)) return;
      if (cancelConsent !== scope + ":" + m.body.client_key)
        throw Error("Potwierdź anulowanie tego oryginalnego polecenia.");
      const c = { ...context };
      let originalAck: any;
      const response = await crmApi(
        "/crm/commands/cancel",
        "POST",
        {
          method: m.method,
          path: m.path,
          body: m.body,
        },
        {},
        undefined,
        (value, evidence) => {
          if (evidence.ok && evidence.workspace === c.tenantId) {
            originalAck = validateCrmAck(m, value);
            persist(c, { ...m, phase: "acknowledged", ack: originalAck });
          }
        },
      );
      const ack = originalAck ?? validateCrmAck(m, response);
      if (!originalAck) persist(c, { ...m, phase: "acknowledged", ack });
      await actor(true);
      if (!live()) return;
      setNotice(
        isCrmCancelledAck(ack)
          ? "Oryginalne polecenie anulowano. Nie wykonano zapisu."
          : "Zapis nastąpił wcześniej. Odczytano jego wynik; zmiany zostały zachowane.",
      );
      setRevision((v) => v + 1);
      if (!isCrmCancelledAck(ack)) {
        if (m.path.includes("/clients")) {
          if (m.method === "DELETE") {
            setSelected(null);
            setDetail(null);
          } else {
            setCreating(false);
            void open(ack.data.id, chosen?.include ?? false);
          }
        } else if (selected) void open(selected, chosen?.include ?? false);
      }
    });
  }
  async function download(
    id: string,
    field: string,
    file: { title: string; url: string },
  ) {
    await locked(async () => {
      await actor();
      const expected = "/api/crm/clients/" + id + "/files/" + field;
      if (file.url !== expected)
        throw Error("Otrzymano inny adres załącznika.");
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 15000);
      try {
        const r = await fetch(expected, {
          credentials: "same-origin",
          headers: { "X-Workspace-ID": context.tenantId },
          signal: controller.signal,
        });
        if (!r.ok) throw Error("Nie udało się odczytać prywatnego załącznika.");
        const reader = r.body?.getReader();
        if (!reader) throw Error("Brak pliku.");
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > (meta?.fileMax ?? 0)) {
            await reader.cancel();
            throw Error("Załącznik przekracza dopuszczalny rozmiar.");
          }
          chunks.push(new Uint8Array(next.value));
        }
        await actor();
        const url = URL.createObjectURL(
            new Blob(chunks, { type: "application/octet-stream" }),
          ),
          a = document.createElement("a");
        a.href = url;
        a.download = file.title.replace(/[\x00-\x1f\x7f/\\]/g, "_");
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } finally {
        clearTimeout(timer);
      }
    });
  }
  return (
    <section className="crm-workspace" aria-label="Kartoteka CRM">
      <header>
        <h2>Klienci CRM</h2>
        <p>Profile klientów, statusy i dodatkowe dane w obrębie firmy.</p>
      </header>
      {error && (
        <p className="crm-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {custodyBad && (
        <p role="alert">
          Nie można odczytać zachowanej próby. Zapis pozostaje zablokowany.
        </p>
      )}
      {pending && (
        <aside className="notice">
          <p role="status">
            Wynik wcześniejszego zapisu jest niepotwierdzony. Zachowano jego
            oryginał; kolejne zmiany są zablokowane.
          </p>
          <button
            className="button"
            disabled={busy || !context.admin}
            onClick={() => void observe()}
          >
            Odczytaj oryginalny wynik CRM
          </button>
          <label>
            <input
              type="checkbox"
              checked={cancelConsent === scope + ":" + pending.body.client_key}
              disabled={
                busy ||
                !context.admin ||
                context.readOnly ||
                !!context.externalWriteBlocked ||
                page?.read_only === true ||
                page?.can_write === false
              }
              onChange={(e) =>
                setCancelConsent(
                  e.target.checked
                    ? scope + ":" + pending.body.client_key
                    : null,
                )
              }
            />
            Potwierdzam anulowanie niewykonanego polecenia. Wcześniejszy zapis
            pozostanie zachowany.
          </label>
          <button
            className="button"
            disabled={
              busy ||
              !context.admin ||
              context.readOnly ||
              !!context.externalWriteBlocked ||
              page?.read_only === true ||
              page?.can_write === false ||
              cancelConsent !== scope + ":" + pending.body.client_key
            }
            onClick={() => void cancelOriginal()}
          >
            Anuluj niewykonane polecenie CRM
          </button>
        </aside>
      )}
      {!context.admin && (
        <p>Możesz przeglądać kartotekę. Zmiany wymagają administratora.</p>
      )}
      {context.readOnly && <p>Podgląd tylko do odczytu.</p>}
      <nav className="crm-tabs" aria-label="Sekcje CRM">
        {[
          ["clients", "Klienci"],
          ["statuses", "Statusy i grupy"],
          ["fields", "Pola dodatkowe"],
        ].map(([id, label]) => (
          <button
            className="button"
            key={id}
            disabled={busy}
            aria-pressed={tab === id}
            onClick={() => setTab(id as typeof tab)}
          >
            {label}
          </button>
        ))}
      </nav>
      {loading && !meta && <p>Wczytywanie kartoteki…</p>}
      {meta && tab === "clients" && (
        <div className="crm-columns">
          <section className="crm-card">
            <h3>Lista klientów</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy && !writing.current) {
                  setSelected(null);
                  setDetail(null);
                  setQuery({ ...filters, page: 1 });
                }
              }}
            >
              <fieldset className="crm-fields" disabled={busy}>
                <label className="crm-wide">
                  Szukaj klienta
                  <input
                    value={filters.search}
                    maxLength={220}
                    onChange={(e) =>
                      setFilters((v) => ({ ...v, search: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Status
                  <select
                    value={filters.status_id}
                    onChange={(e) =>
                      setFilters((v) => ({ ...v, status_id: e.target.value }))
                    }
                  >
                    <option value="">Wszystkie statusy</option>
                    {meta.statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="button">Szukaj klientów</button>
              </fieldset>
            </form>
            <div className="crm-actions">
              <button
                className="button primary"
                disabled={writeBlocked}
                onClick={() => {
                  setCreating(true);
                  setSelected(null);
                  setDetail(null);
                }}
              >
                Nowy klient
              </button>
              <button
                className="button"
                disabled={busy || loading}
                onClick={() => {
                  setRevision((v) => v + 1);
                  if (selected) void open(selected, chosen?.include ?? false);
                }}
              >
                Odśwież kartotekę
              </button>
            </div>
            {page?.data.map((c) => (
              <article
                className={
                  "crm-item " + (selected === c.id ? "crm-selected" : "")
                }
                key={c.id}
              >
                <div>
                  <h4>
                    {c.invoice_fullname ||
                      c.login ||
                      c.invoice_company ||
                      c.email ||
                      "Klient bez nazwy"}
                  </h4>
                  <p>
                    {c.email} {c.phone}
                  </p>
                  <small>
                    {meta.statuses.find((s) => s.id === c.status_id)?.name} ·
                    Ocena {c.star}/5
                  </small>
                </div>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void open(c.id)}
                >
                  Otwórz klienta
                </button>
              </article>
            ))}
            {page?.data.length === 0 && (
              <p>Brak klientów dla wybranego filtra.</p>
            )}
            <div className="crm-actions">
              <button
                className="button"
                disabled={busy || loading || query.page <= 1}
                onClick={() => {
                  setSelected(null);
                  setDetail(null);
                  setQuery((v) => ({ ...v, page: v.page - 1 }));
                }}
              >
                Poprzednia strona
              </button>
              <span>Strona {query.page}</span>
              <button
                className="button"
                disabled={busy || loading || !page?.meta.has_more}
                onClick={() => {
                  setSelected(null);
                  setDetail(null);
                  setQuery((v) => ({ ...v, page: v.page + 1 }));
                }}
              >
                Następna strona
              </button>
            </div>
          </section>
          <section className="crm-card">
            {creating ? (
              <ClientForm
                key={scope + ":new"}
                statuses={meta.statuses}
                disabled={writeBlocked}
                submit={(body) => mutate("POST", "/crm/clients", body)}
                cancel={() => setCreating(false)}
              />
            ) : chosen ? (
              <>
                <ClientForm
                  key={scope + chosen.id + ":" + chosen.data.version}
                  value={chosen.data}
                  statuses={meta.statuses}
                  disabled={
                    writeBlocked || !chosen.can_write || chosen.read_only
                  }
                  submit={(body) =>
                    mutate("PATCH", "/crm/clients/" + chosen.id, {
                      version: chosen.data.version,
                      ...body,
                    })
                  }
                />
                <ClientOrders
                  key={scope + chosen.id + chosen.data.version + ":orders"}
                  clientId={chosen.id}
                  disabled={
                    writeBlocked || !chosen.can_write || chosen.read_only
                  }
                  busy={busy}
                  load={async (path) => {
                    await actor();
                    const r = await crmApi(path);
                    await actor();
                    return r;
                  }}
                  link={(id) =>
                    mutate("POST", "/crm/clients/" + chosen.id + "/orders", {
                      version: chosen.data.version,
                      order_id: id,
                    })
                  }
                />
                <h3>Dodatkowe pola klienta</h3>
                {!chosen.include ? (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void open(chosen.id, true)}
                  >
                    Wczytaj dodatkowe pola klienta
                  </button>
                ) : (
                  meta.fields
                    .filter(
                      (f) =>
                        !f.archived ||
                        Object.hasOwn(
                          chosen.data.custom_extra_fields ?? {},
                          f.extra_field_id,
                        ),
                    )
                    .map((f) => (
                      <ExtraValue
                        key={chosen.id + f.extra_field_id + chosen.data.version}
                        field={f}
                        value={
                          chosen.data.custom_extra_fields?.[f.extra_field_id]
                        }
                        fileMax={meta.fileMax}
                        disabled={
                          writeBlocked ||
                          Boolean(f.archived) ||
                          !chosen.can_write ||
                          chosen.read_only
                        }
                        busy={busy}
                        save={(value) =>
                          mutate("PATCH", "/crm/clients/" + chosen.id, {
                            version: chosen.data.version,
                            custom_extra_fields: { [f.extra_field_id]: value },
                          })
                        }
                        download={(file) =>
                          download(chosen.id, f.extra_field_id, file)
                        }
                      />
                    ))
                )}
                <DeleteClient
                  key={chosen.id + chosen.data.version}
                  disabled={
                    writeBlocked || !chosen.can_write || chosen.read_only
                  }
                  remove={() =>
                    mutate("DELETE", "/crm/clients/" + chosen.id, {
                      version: chosen.data.version,
                    })
                  }
                />
                <RodoCustomerPanel
                  key={scope + chosen.id + ":rodo"}
                  subject={{ crm_client_id: chosen.id }}
                  tenantId={context.tenantId}
                  admin={context.admin}
                  readOnly={context.readOnly}
                  onChanged={() => {
                    setRevision((v) => v + 1);
                    void open(chosen.id, chosen.include);
                  }}
                />
              </>
            ) : (
              <p>Wybierz klienta lub utwórz nowy profil.</p>
            )}
          </section>
        </div>
      )}
      {meta && tab === "statuses" && (
        <Dictionaries
          key={scope + ":" + revision}
          groups={meta.groups}
          statuses={meta.statuses}
          disabled={writeBlocked}
          mutate={mutate}
        />
      )}
      {meta && tab === "fields" && (
        <DefinitionEditor
          key={scope + ":" + revision}
          fields={meta.fields}
          available={meta.definitionEditor}
          disabled={writeBlocked}
          mutate={mutate}
        />
      )}
    </section>
  );
}
const fieldLabels = {
  text: "Tekst",
  number: "Liczba",
  select: "Lista wyboru",
  checkbox: "Wybór wielokrotny",
  radio: "Wybór pojedynczy",
  date: "Data",
  file: "Plik",
};
function ClientForm({
  value,
  statuses,
  disabled,
  submit,
  cancel,
}: {
  value?: Client;
  statuses: Status[];
  disabled: boolean;
  submit: (b: Record<string, unknown>) => Promise<void>;
  cancel?: () => void;
}) {
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        const f = new FormData(e.currentTarget),
          body: Record<string, unknown> = {};
        for (const g of groupsOfFields)
          for (const [name] of g.fields) {
            const next = String(f.get(name) ?? "");
            if (value ? next !== (value[name] ?? "") : next !== "")
              body[name] = next;
          }
        for (const name of ["notes", "status_id", "star", "contractor_id"]) {
          const next =
            name === "star" || name === "contractor_id"
              ? Number(f.get(name))
              : String(f.get(name) ?? "");
          if (value ? next !== (value[name] ?? "") : next !== "" && next !== 0)
            body[name] = next;
        }
        if (!Object.keys(body).length) {
          setError("Nie zmieniono danych klienta.");
          return;
        }
        setError("");
        void submit(body);
      }}
    >
      <h3>{value ? "Profil klienta" : "Nowy profil klienta"}</h3>
      {error && <p role="alert">{error}</p>}
      <fieldset className="crm-fields" disabled={disabled}>
        <label>
          Status
          <select
            name="status_id"
            defaultValue={
              value?.status_id ??
              statuses.find((s) => s.is_primary)?.id ??
              statuses[0]?.id
            }
            required
          >
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ocena
          <select name="star" defaultValue={value?.star ?? 0}>
            {[0, 1, 2, 3, 4, 5].map((v) => (
              <option key={v} value={v}>
                {v}/5
              </option>
            ))}
          </select>
        </label>
        {groupsOfFields.map((g) => (
          <fieldset className="crm-fields crm-wide" key={g.name}>
            <legend>{g.name}</legend>
            {g.fields.map(([name, label, max]) => (
              <label key={name}>
                {label}
                <input
                  name={name}
                  defaultValue={value?.[name] ?? ""}
                  maxLength={max}
                  type={name === "email" ? "email" : "text"}
                />
              </label>
            ))}
          </fieldset>
        ))}
        <label>
          Identyfikator kontrahenta
          <input
            name="contractor_id"
            type="number"
            min="0"
            step="1"
            defaultValue={value?.contractor_id ?? 0}
          />
        </label>
        <label className="crm-wide">
          Notatki
          <textarea
            name="notes"
            defaultValue={value?.notes ?? ""}
            maxLength={20000}
          />
        </label>
        <div className="crm-actions crm-wide">
          <button className="button primary">
            {value ? "Zapisz zmienione dane klienta" : "Utwórz klienta"}
          </button>
          {cancel && (
            <button type="button" className="button" onClick={cancel}>
              Zamknij nowy profil
            </button>
          )}
        </div>
      </fieldset>
      {value && <small>Aktualizacja: {date(value.updated_at)}</small>}
    </form>
  );
}
function DeleteClient({
  disabled,
  remove,
}: {
  disabled: boolean;
  remove: () => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <section className="crm-danger">
      <h3>Usuń klienta</h3>
      <p>Usunięcie kartoteki zachowuje historyczne zamówienia i ich dane.</p>
      <label className="crm-check">
        <input
          type="checkbox"
          disabled={disabled}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        Potwierdzam usunięcie tego profilu
      </label>
      <button
        className="button"
        disabled={disabled || !confirmed}
        onClick={() => void remove()}
      >
        Usuń profil klienta
      </button>
    </section>
  );
}
function ExtraValue({
  field,
  value,
  fileMax,
  disabled,
  busy,
  save,
  download,
}: {
  field: Definition;
  value: any;
  fileMax: number;
  disabled: boolean;
  busy: boolean;
  save: (v: any) => Promise<void>;
  download: (f: { title: string; url: string }) => Promise<void>;
}) {
  const [draft, setDraft] = useState<any>(
      value ?? (field.editor_type === "checkbox" ? [] : ""),
    ),
    [file, setFile] = useState<File | null>(null),
    [error, setError] = useState(""),
    [reading, setReading] = useState(false);
  const name = "Pole " + field.name + (field.archived ? " (archiwalne)" : "");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled || reading) return;
    setError("");
    try {
      let next = draft;
      if (field.editor_type === "number") {
        if (draft === "") next = "";
        else {
          next = Number(draft);
          if (!Number.isFinite(next)) throw Error("Podaj skończoną liczbę.");
        }
      }
      if (field.editor_type === "file") {
        if (!file) throw Error("Wybierz nowy plik.");
        const title = file.name;
        if (title.length > 40)
          throw Error("Nazwa pliku może mieć maksymalnie 40 znaków.");
        if (file.size > fileMax)
          throw Error("Plik przekracza dopuszczalny rozmiar.");
        setReading(true);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 8192),
          );
        next = { title, file: "data:" + btoa(binary) };
      }
      await save(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  }
  return (
    <form className="crm-danger" onSubmit={submit}>
      <h4>
        {field.name} · {fieldLabels[field.editor_type]}
        {field.archived ? " · archiwalne" : ""}
      </h4>
      {error && <p role="alert">{error}</p>}
      {field.editor_type === "file" && (
        <>
          <p className="crm-file">{value?.title ?? "Brak załącznika"}</p>
          {value?.url && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void download(value)}
            >
              Pobierz {value.title}
            </button>
          )}
        </>
      )}
      <fieldset className="crm-fields" disabled={disabled || reading}>
        <div className="crm-wide">
          {field.editor_type === "file" ? (
            <>
              <label>
                {name}
                <input
                  aria-label={name}
                  type="file"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <small>
                Maksymalnie {fileMax} bajtów; nazwa do 40 znaków. Dowolny format
                pliku; pobieranie jako prywatny załącznik.
              </small>
            </>
          ) : field.editor_type === "checkbox" ? (
            <fieldset>
              <legend>{name}</legend>
              {field.options.map((o) => (
                <label className="crm-check" key={o}>
                  <input
                    type="checkbox"
                    checked={Array.isArray(draft) && draft.includes(o)}
                    onChange={(e) =>
                      setDraft((v: string[]) =>
                        e.target.checked ? [...v, o] : v.filter((x) => x !== o),
                      )
                    }
                  />
                  {o}
                </label>
              ))}
            </fieldset>
          ) : field.editor_type === "radio" ? (
            <fieldset>
              <legend>{name}</legend>
              {field.options.map((o) => (
                <label className="crm-check" key={o}>
                  <input
                    type="radio"
                    name={field.extra_field_id}
                    value={o}
                    checked={draft === o}
                    onChange={() => setDraft(o)}
                  />
                  {o}
                </label>
              ))}
            </fieldset>
          ) : field.editor_type === "select" ? (
            <label>
              {name}
              <select value={draft} onChange={(e) => setDraft(e.target.value)}>
                <option value="">Brak wartości</option>
                {field.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              {name}
              <input
                type={
                  field.editor_type === "number"
                    ? "number"
                    : field.editor_type === "date"
                      ? "date"
                      : "text"
                }
                step={field.editor_type === "number" ? "any" : undefined}
                min={field.editor_type === "number" ? -999999999999 : undefined}
                max={field.editor_type === "number" ? 999999999999 : undefined}
                value={draft}
                maxLength={field.editor_type === "text" ? 10000 : undefined}
                onChange={(e) => setDraft(e.target.value)}
              />
            </label>
          )}
        </div>
        <div className="crm-actions crm-wide">
          <button className="button">Zapisz pole {field.name}</button>
          <button
            className="button"
            type="button"
            disabled={value === undefined || value === ""}
            onClick={() => void save("")}
          >
            Usuń wartość {field.name}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
function Dictionaries({
  groups,
  statuses,
  disabled,
  mutate,
}: {
  groups: Group[];
  statuses: Status[];
  disabled: boolean;
  mutate: (
    m: CrmRequest["method"],
    p: string,
    b: Record<string, unknown>,
  ) => Promise<void>;
}) {
  return (
    <div className="crm-columns">
      <section className="crm-card">
        <h3>Grupy statusów</h3>
        <DictionaryForm
          kind="group"
          disabled={disabled}
          submit={(b) => mutate("POST", "/crm/status-groups", b)}
        />
        {groups.map((g) => (
          <article className="crm-danger" key={g.id}>
            <h4>
              {g.name}
              {g.is_main_group ? " · Grupa główna" : ""}
            </h4>
            <DictionaryForm
              key={g.id + ":" + g.version}
              kind="group"
              value={g}
              disabled={disabled}
              submit={(b) =>
                mutate("PATCH", "/crm/status-groups/" + g.id, {
                  version: g.version,
                  ...b,
                })
              }
            />
            <DeleteDictionary
              disabled={disabled || g.is_main_group === 1}
              label={"grupę " + g.name}
              text="Statusy tej grupy zostaną przeniesione do grupy głównej z zachowaniem klientów."
              submit={() =>
                mutate("DELETE", "/crm/status-groups/" + g.id, {
                  version: g.version,
                })
              }
            />
          </article>
        ))}
      </section>
      <section className="crm-card">
        <h3>Statusy klientów</h3>
        <DictionaryForm
          kind="status"
          groups={groups}
          disabled={disabled}
          submit={(b) => mutate("POST", "/crm/statuses", b)}
        />
        {groups.map((g) => (
          <section key={g.id}>
            <h4>{g.name}</h4>
            {statuses
              .filter((s) => s.group_id === g.id)
              .sort((a, b) => a.position - b.position)
              .map((s) => (
                <article className="crm-danger" key={s.id}>
                  <h4>
                    <span
                      className="crm-color"
                      style={{ background: s.color }}
                    />
                    {s.name}
                    {s.is_primary ? " · Status główny" : ""}
                  </h4>
                  <DictionaryForm
                    key={s.id + ":" + s.version}
                    kind="status"
                    value={s}
                    groups={groups}
                    disabled={disabled}
                    submit={(b) =>
                      mutate("PATCH", "/crm/statuses/" + s.id, {
                        version: s.version,
                        ...b,
                      })
                    }
                  />
                  <DeleteDictionary
                    disabled={disabled || s.is_primary === 1}
                    label={"status " + s.name}
                    text="Wszyscy klienci otrzymają wybrany status docelowy."
                    targets={statuses.filter((t) => t.id !== s.id)}
                    submit={(target) =>
                      mutate("DELETE", "/crm/statuses/" + s.id, {
                        version: s.version,
                        target_status_id: target,
                      })
                    }
                  />
                </article>
              ))}
          </section>
        ))}
      </section>
    </div>
  );
}
function DictionaryForm({
  kind,
  value,
  groups = [],
  disabled,
  submit,
}: {
  kind: "group" | "status";
  value?: Group | Status;
  groups?: Group[];
  disabled: boolean;
  submit: (b: Record<string, unknown>) => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        const f = new FormData(e.currentTarget),
          body: Record<string, unknown> = {},
          name = String(f.get("name") ?? "").trim();
        if (!value || name !== value.name) body.name = name;
        if (kind === "status") {
          const color = String(f.get("color")),
            group = String(f.get("group_id") ?? "");
          if (!value || color !== (value as Status).color) body.color = color;
          if (group && (!value || group !== (value as Status).group_id))
            body.group_id = group;
        }
        if (!Object.keys(body).length) {
          setError("Nie zmieniono danych.");
          return;
        }
        setError("");
        void submit(body);
      }}
    >
      {error && <p role="alert">{error}</p>}
      <fieldset className="crm-fields" disabled={disabled}>
        <label>
          {kind === "group" ? "Nazwa grupy" : "Nazwa statusu"}
          <input
            name="name"
            required
            maxLength={kind === "group" ? 15 : 30}
            defaultValue={value?.name ?? ""}
          />
        </label>
        {kind === "status" && (
          <>
            <label>
              Kolor statusu
              <input
                type="color"
                name="color"
                defaultValue={(value as Status)?.color ?? "#64748b"}
              />
            </label>
            <label>
              Grupa statusu
              <select
                name="group_id"
                disabled={!!(value as Status)?.is_primary}
                defaultValue={(value as Status)?.group_id ?? ""}
              >
                <option value="">
                  {value ? "Zachowaj obecną grupę" : "Grupa główna"}
                </option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <button className="button">
          {value
            ? "Zapisz " + (kind === "group" ? "grupę" : "status")
            : "Dodaj " + (kind === "group" ? "grupę" : "status")}
        </button>
      </fieldset>
    </form>
  );
}
function DeleteDictionary({
  disabled,
  label,
  text,
  targets,
  submit,
}: {
  disabled: boolean;
  label: string;
  text: string;
  targets?: Status[];
  submit: (id?: string) => Promise<void>;
}) {
  const [target, setTarget] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  return (
    <div className="crm-danger">
      <p>{text}</p>
      {targets && (
        <label>
          Status docelowy dla {label}
          <select
            disabled={disabled}
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setConfirmed(false);
            }}
          >
            <option value="">Wybierz status docelowy</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="crm-check">
        <input
          type="checkbox"
          disabled={disabled}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        Potwierdzam usunięcie: {label}
      </label>
      <button
        className="button"
        disabled={disabled || !confirmed || (!!targets && !target)}
        onClick={() => void submit(target || undefined)}
      >
        Usuń {label}
      </button>
    </div>
  );
}
function ClientOrders({
  clientId,
  disabled,
  busy,
  load,
  link,
}: {
  clientId: string;
  disabled: boolean;
  busy: boolean;
  load: (path: string) => Promise<any>;
  link: (id: string) => Promise<void>;
}) {
  const [history, setHistory] = useState<any[] | null>(null),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [search, setSearch] = useState(""),
    [candidates, setCandidates] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [chosen, setChosen] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    request = useRef(0),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++request.current;
    };
  }, []);
  async function read(kind: "history" | "search", after?: string) {
    if (busy) return;
    const token = ++request.current;
    setLoading(true);
    setError("");
    try {
      const r = await load(
        kind === "history"
          ? "/crm/clients/" +
              clientId +
              "/orders?" +
              new URLSearchParams({ limit: "50", ...(after ? { after } : {}) })
          : "/orders?" +
              new URLSearchParams({ search, ...(after ? { after } : {}) }),
      );
      const data = rows<any>(
        r,
        (o) =>
          UUID.test(o.id) &&
          typeof o.number === "string" &&
          typeof o.currency === "string" &&
          Number.isSafeInteger(o.total),
      );
      if (alive.current && token === request.current) {
        if (kind === "history") {
          if (
            typeof r.meta?.has_more !== "boolean" ||
            !(
              r.meta.cursor === null ||
              (typeof r.meta.cursor === "string" &&
                r.meta.cursor.length <= 2048)
            )
          )
            throw Error("Niepełna strona zamówień klienta.");
          setHistory((v) =>
            after
              ? [
                  ...(v ?? []),
                  ...data.filter((o) => !v?.some((old) => old.id === o.id)),
                ]
              : data,
          );
          setHistoryCursor(r.meta.cursor);
        } else {
          setCandidates(data);
          setCursor(r.meta?.cursor ?? null);
          setChosen("");
        }
      }
    } catch (e) {
      if (alive.current && token === request.current)
        setError((e as Error).message);
    } finally {
      if (alive.current && token === request.current) setLoading(false);
    }
  }
  return (
    <section className="crm-danger">
      <h3>Zamówienia klienta</h3>
      <p>
        Powiązania są przypisane do profilu, niezależnie od późniejszych zmian
        danych kontaktowych.
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        className="button"
        disabled={busy || loading}
        onClick={() => void read("history")}
      >
        Odczytaj zamówienia klienta
      </button>
      {history && (
        <ul>
          {history.map((o) => (
            <li key={o.id}>
              {o.number} · {money(o.total, o.currency)} · {o.status}
            </li>
          ))}
        </ul>
      )}
      {history?.length === 0 && <p>Brak powiązanych zamówień.</p>}
      {historyCursor && (
        <button
          className="button"
          disabled={busy || loading}
          onClick={() => void read("history", historyCursor)}
        >
          Kolejne zamówienia klienta
        </button>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled) void read("search");
        }}
      >
        <fieldset className="crm-fields" disabled={disabled || loading}>
          <label>
            Szukaj zamówienia do powiązania
            <input
              value={search}
              maxLength={200}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <button className="button">Wyszukaj zamówienia</button>
          {candidates.length > 0 && (
            <>
              <label className="crm-wide">
                Zamówienie do powiązania
                <select
                  value={chosen}
                  onChange={(e) => setChosen(e.target.value)}
                >
                  <option value="">Wybierz zamówienie</option>
                  {candidates.map((o) => (
                    <option value={o.id} key={o.id}>
                      {o.number} · {o.customer_name ?? ""} ·{" "}
                      {money(o.total, o.currency)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button"
                disabled={!chosen}
                onClick={() => void link(chosen)}
              >
                Powiąż wybrane zamówienie
              </button>
            </>
          )}
          {cursor && (
            <button
              type="button"
              className="button"
              onClick={() => void read("search", cursor)}
            >
              Kolejne zamówienia do wyboru
            </button>
          )}
        </fieldset>
      </form>
    </section>
  );
}

function DefinitionEditor({
  fields,
  available,
  disabled,
  mutate,
}: {
  fields: Definition[];
  available: boolean;
  disabled: boolean;
  mutate: (
    method: CrmRequest["method"],
    path: string,
    body: Record<string, unknown>,
  ) => Promise<void>;
}) {
  return (
    <section className="crm-card crm-definitions">
      <h3>Definicje dodatkowych pól</h3>
      <p>
        Typ pola jest stały. Archiwizacja zachowuje wartości i prywatne pliki
        klientów. Opcji użytej u klienta nie można usunąć.
      </p>
      {available ? (
        <>
          <DefinitionForm
            disabled={disabled}
            submit={(b) => mutate("POST", "/crm/field-definitions", b)}
          />
          {fields.map((f) => (
            <article
              className="crm-danger"
              key={f.extra_field_id + ":" + f.version}
            >
              <h4>
                {f.name}
                {f.archived ? " · Archiwum" : ""}
              </h4>
              <DefinitionForm
                value={f}
                disabled={disabled}
                submit={(b) =>
                  mutate(
                    "PATCH",
                    "/crm/field-definitions/" + f.extra_field_id,
                    { version: f.version, ...b },
                  )
                }
              />
              <button
                className="button"
                disabled={disabled}
                onClick={() =>
                  void mutate(
                    "PATCH",
                    "/crm/field-definitions/" + f.extra_field_id,
                    { version: f.version, archived: !f.archived },
                  )
                }
              >
                {f.archived
                  ? "Przywróć pole " + f.name
                  : "Archiwizuj pole " + f.name}
              </button>
            </article>
          ))}
        </>
      ) : (
        <>
          <p>Edycja definicji jest niedostępna w tej wersji aplikacji.</p>
          <table>
            <thead>
              <tr>
                <th>Nazwa</th>
                <th>Typ</th>
                <th>Opcje</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.extra_field_id}>
                  <td>{f.name}</td>
                  <td>{fieldLabels[f.editor_type]}</td>
                  <td>{f.options.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
function DefinitionForm({
  value,
  disabled,
  submit,
}: {
  value?: Definition;
  disabled: boolean;
  submit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [kind, setKind] = useState<Definition["editor_type"]>(
      value?.editor_type ?? "text",
    ),
    [error, setError] = useState("");
  const choices = ["select", "checkbox", "radio"].includes(kind);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        const f = new FormData(e.currentTarget),
          name = String(f.get("definition_name") ?? "").trim(),
          opts = choices
            ? String(f.get("definition_options") ?? "")
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)
            : [],
          position = String(f.get("definition_position") ?? "").trim(),
          body: Record<string, unknown> = {};
        if (
          !name ||
          name.length > 120 ||
          opts.length > 100 ||
          opts.some((x) => x.length > 200) ||
          new Set(opts).size !== opts.length ||
          (choices && !opts.length)
        ) {
          setError("Sprawdź nazwę i unikalne opcje (jedna opcja w wierszu).");
          return;
        }
        if (!value) {
          body.name = name;
          body.editor_type = kind;
          body.options = opts;
        } else {
          if (name !== value.name) body.name = name;
          if (JSON.stringify(opts) !== JSON.stringify(value.options))
            body.options = opts;
        }
        if (position !== "") {
          const p = Number(position);
          if (!Number.isSafeInteger(p) || p < 0 || p > 1000) {
            setError("Kolejność musi być liczbą od 0 do 1000.");
            return;
          }
          if (!value || p !== value.position) body.position = p;
        }
        if (!Object.keys(body).length) {
          setError("Nie zmieniono definicji pola.");
          return;
        }
        setError("");
        void submit(body);
      }}
    >
      <fieldset className="crm-fields" disabled={disabled}>
        <legend>
          {value ? "Edytuj definicję " + value.name : "Nowa definicja pola"}
        </legend>
        <label>
          Nazwa pola
          <input
            name="definition_name"
            aria-label={
              value ? "Nazwa definicji " + value.name : "Nazwa nowej definicji"
            }
            defaultValue={value?.name ?? ""}
            maxLength={120}
            required
          />
        </label>
        <label>
          Typ pola
          <select
            name="definition_type"
            aria-label={
              value ? "Typ definicji " + value.name : "Typ nowej definicji"
            }
            value={kind}
            disabled={Boolean(value)}
            onChange={(e) =>
              setKind(e.target.value as Definition["editor_type"])
            }
          >
            {Object.entries(fieldLabels).map(([type, label]) => (
              <option value={type} key={type}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kolejność (od 0)
          <input
            type="number"
            name="definition_position"
            aria-label={
              value
                ? "Kolejność definicji " + value.name
                : "Kolejność nowej definicji"
            }
            min={0}
            max={1000}
            step={1}
            defaultValue={value?.position ?? ""}
          />
        </label>
        {choices && (
          <label className="crm-wide">
            Opcje — jedna w wierszu
            <textarea
              name="definition_options"
              aria-label={
                value
                  ? "Opcje definicji " + value.name
                  : "Opcje nowej definicji"
              }
              defaultValue={value?.options.join("\n") ?? ""}
              required
            />
          </label>
        )}
        <button className="button">
          {value ? "Zapisz definicję " + value.name : "Dodaj definicję pola"}
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
