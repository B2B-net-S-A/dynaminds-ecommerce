import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ensure } from "./errors";
import {
  executeCrmCommand,
  cancelCrmCommand,
  observeCrmCommand,
  listCrmClients,
  getCrmClient,
  getCrmDictionaries,
  getCrmOrders,
  getCrmFile,
} from "./crm";
/** One customer whose personal data a read returned (228 access register). */
export type CrmAccessEntry = {
  crm_client_id: string;
  action: "read" | "list";
  resource: string;
  email?: unknown;
  phone?: unknown;
};
export function registerCrmRoutes(
  app: FastifyInstance,
  opts: {
    available: boolean;
    readOnly: boolean;
    /** Records the read before the data leaves; buildApp installs it with 228. */
    access?: (actor: any, entries: CrmAccessEntry[]) => Promise<void>;
  },
) {
  const access = (req: any, write = false) => {
    ensure(opts.available, 503, "Kopia nie zawiera kartoteki CRM");
    ensure(
      !req.actor?.apiKeyId && req.actor?.source !== "api" && !req.apiScopes,
      403,
      "CRM wymaga sesji użytkownika",
    );
    if (write)
      ensure(!opts.readOnly, 423, "Podgląd kopii: zapis CRM jest wyłączony");
  };
  const id = (p: unknown) =>
    z.object({ id: z.uuid().transform((x) => x.toLowerCase()) }).parse(p).id;
  const read = (x: Record<string, any>) => ({
    ...x,
    ...(Object.hasOwn(x, "can_write")
      ? { can_write: x.can_write && !opts.readOnly }
      : {}),
    read_only: opts.readOnly,
  });
  app.get("/api/crm/clients", async (req) => {
    access(req);
    const page = await listCrmClients(req.actor, req.query);
    await opts.access?.(
      req.actor,
      page.data.map((x: Record<string, any>) => ({
        crm_client_id: x.id,
        action: "list",
        resource: "GET /api/crm/clients",
        email: x.email,
        phone: x.phone,
      })),
    );
    return read(page);
  });
  app.get("/api/crm/clients/:id", async (req) => {
    access(req);
    const card = await getCrmClient(req.actor, id(req.params), req.query);
    await opts.access?.(req.actor, [
      {
        crm_client_id: card.data.id,
        action: "read",
        resource: "GET /api/crm/clients/:id",
        email: (card.data as Record<string, unknown>).email,
        phone: (card.data as Record<string, unknown>).phone,
      },
    ]);
    return read(card);
  });
  app.get("/api/crm/clients/:id/orders", async (req) => {
    access(req);
    const clientId = id(req.params),
      orders = await getCrmOrders(req.actor, clientId, req.query);
    await opts.access?.(req.actor, [
      {
        crm_client_id: clientId,
        action: "read",
        resource: "GET /api/crm/clients/:id/orders",
      },
    ]);
    return read(orders);
  });
  app.get("/api/crm/clients/:id/files/:fieldId", async (req, reply) => {
    access(req);
    const p = z.object({ id: z.uuid(), fieldId: z.uuid() }).parse(req.params),
      f = await getCrmFile(req.actor, p.id, p.fieldId);
    await opts.access?.(req.actor, [
      {
        crm_client_id: p.id.toLowerCase(),
        action: "read",
        resource: "GET /api/crm/clients/:id/files/:fieldId",
      },
    ]);
    reply
      .header("Content-Type", f.mime_type)
      .header(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(f.title),
      )
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store");
    return reply.send(f.bytes);
  });
  for (const [resource, kind] of [
    ["status-groups", "groups"],
    ["statuses", "statuses"],
    ["extra-fields", "fields"],
  ] as const)
    app.get("/api/crm/" + resource, async (req) => {
      access(req);
      return read(await getCrmDictionaries(req.actor, kind));
    });
  for (const resource of ["clients", "statuses", "status-groups"]) {
    app.post(
      "/api/crm/" + resource,
      { bodyLimit: 3000000 },
      async (req, reply) => {
        access(req, true);
        const result = await executeCrmCommand(
          req.actor,
          "POST",
          "/api/crm/" + resource,
          req.body,
        );
        reply.code(201);
        return result;
      },
    );
    app.patch(
      "/api/crm/" + resource + "/:id",
      { bodyLimit: 3000000 },
      async (req) => {
        access(req, true);
        return executeCrmCommand(
          req.actor,
          "PATCH",
          "/api/crm/" + resource + "/" + id(req.params),
          req.body,
        );
      },
    );
    app.delete("/api/crm/" + resource + "/:id", async (req) => {
      access(req, true);
      return executeCrmCommand(
        req.actor,
        "DELETE",
        "/api/crm/" + resource + "/" + id(req.params),
        req.body,
      );
    });
  }
  app.post("/api/crm/field-definitions", async (req, reply) => {
    access(req, true);
    const result = await executeCrmCommand(
      req.actor,
      "POST",
      "/api/crm/field-definitions",
      req.body,
    );
    reply.code(201);
    return result;
  });
  app.patch("/api/crm/field-definitions/:id", async (req) => {
    access(req, true);
    return executeCrmCommand(
      req.actor,
      "PATCH",
      "/api/crm/field-definitions/" + id(req.params),
      req.body,
    );
  });
  app.post("/api/crm/clients/:id/orders", async (req) => {
    access(req, true);
    return executeCrmCommand(
      req.actor,
      "POST",
      "/api/crm/clients/" + id(req.params) + "/orders",
      req.body,
    );
  });
  app.post("/api/crm/commands/cancel", { bodyLimit: 3000000 }, async (req) => {
    access(req, true);
    return cancelCrmCommand(req.actor, req.body);
  });
  app.post("/api/crm/commands/observe", { bodyLimit: 3000000 }, async (req) => {
    access(req);
    return observeCrmCommand(req.actor, req.body);
  });
}
