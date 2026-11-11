/**
 * Automation rules v2: effects of lane M (org) — the order's owner and priority as real order fields, and manual
 * stock reservation. See server/automation-v2-effect-types.ts.
 *
 * Owner ("Opiekun") and priority ("Priorytet") are tenant order-field definitions (order-fields.ts) created on first
 * use through the module's own create/edit path, so they show on the order card and as list columns like any other
 * extra field, without touching the orders table. Values are written by patchOrderFieldsInTx, as the card does.
 * Older runs stored them as tags ("Opiekun …", "Priorytet wysoki/niski"); those tags are left as they are.
 *
 * assign_warehouse moves the order and its reservations to another warehouse through the same path as "Zmień magazyn"
 * on the order card (order-warehouse-transfer.ts, owner function order_warehouse269_transfer of migration 269); an
 * order already in that warehouse is left as it is.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { result, type EffectEnv, type EffectModule } from './automation-v2-effect-types';
import { lockedOrder, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { createOrderFieldInTx, editOrderFieldInTx, patchOrderFieldsInTx, acquireOrderFieldsAdmissionInTx } from './order-fields';
import { releaseOrderStockInTx, reserveOrderStockInTx } from './order-edit';
import { transferOrderWarehouseInTx } from './order-warehouse-transfer';

type Option = { id: string; label: string };
type FieldSpec = { key: string; label: string; position: number };

const OWNER: FieldSpec = { key: 'opiekun_zamowienia', label: 'Opiekun', position: 0 };
const PRIORITY: FieldSpec = { key: 'priorytet_zamowienia', label: 'Priorytet', position: 1 };
const PRIORITIES = { high: 'Wysoki', normal: 'Normalny', low: 'Niski' } as const;
type Priority = keyof typeof PRIORITIES;

/** A stable UUID (same shape as automation-v2-effects stableUuid). */
function stableUuid(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const priorityOption = (tenantId: string, p: Priority): Option => ({ id: stableUuid('v2-priority', tenantId, p), label: PRIORITIES[p] });

async function eligible(c: PoolClient, userId: string): Promise<{ user_id: string; name: string }> {
  const u = (await c.query('SELECT user_id,name FROM customer_message_eligible_assignees(NULL) WHERE user_id=$1', [userId])).rows[0];
  ensure(u, 422, 'Osoba nie należy do zespołu');
  return u;
}

async function findField(c: PoolClient, key: string) {
  const d = (await c.query('SELECT * FROM order_field_definitions WHERE key=$1', [key])).rows[0];
  if (!d) return null;
  const options = (await c.query('SELECT id,label,enabled FROM order_field_options WHERE field_id=$1 ORDER BY id', [d.id])).rows;
  return { ...d, options } as Record<string, any> & { id: string; version: number; options: Array<Option & { enabled: boolean }> };
}

/** Who may provision the field definition: the acting admin, else the rule's author when still an admin. */
async function provisioner(c: PoolClient, actor: Actor, ruleId: string | null, label: string): Promise<Actor> {
  const role = async (userId: string | null | undefined) =>
    userId ? (await c.query('SELECT order_field_role($1) role', [userId])).rows[0]?.role : null;
  if ((await role(actor.userId)) === 'admin') return { ...actor, role: 'admin' };
  const owner = ruleId ? (await c.query('SELECT actor_id FROM automation_rules WHERE id=$1', [ruleId])).rows[0]?.actor_id : null;
  if (owner && (await role(owner)) === 'admin') return { tenantId: actor.tenantId, userId: owner, role: 'admin' };
  throw new Problem(409, `Pole zamówienia „${label}” jeszcze nie istnieje; administrator musi zapisać regułę ponownie`);
}

/** The select field with the given options enabled; created or extended through the order-fields module. */
async function ensureField(c: PoolClient, actor: Actor, ruleId: string | null, spec: FieldSpec, wanted: Option[]) {
  let d = await findField(c, spec.key);
  if (!d) {
    await acquireOrderFieldsAdmissionInTx(c, actor, true);
    d = await findField(c, spec.key);
  }
  if (!d) {
    const admin = await provisioner(c, actor, ruleId, spec.label);
    await createOrderFieldInTx(c, admin, {
      client_key: randomUUID(),
      key: spec.key,
      type: 'select',
      label: spec.label,
      enabled: true,
      display: 'always',
      position: spec.position,
      read_role: 'team',
      write_role: 'operator',
      required_on: [],
      config: {},
      options: wanted.map((o) => ({ ...o, enabled: true })),
    });
    d = (await findField(c, spec.key))!;
  }
  ensure(d.type === 'select', 409, `Pole o kluczu ${spec.key} ma inny typ niż lista wyboru; zmień je w ustawieniach pól zamówienia`);
  ensure(d.enabled, 409, `Pole zamówienia „${d.label}” jest wyłączone w ustawieniach pól zamówienia`);
  const missing = wanted.filter((w) => !d!.options.some((o) => o.id === w.id && o.enabled));
  if (missing.length) {
    const admin = await provisioner(c, actor, ruleId, d.label);
    // Option labels are immutable: a retired option is re-enabled under its original label.
    const options = [
      ...d.options.map((o) => ({ id: o.id, label: o.label, enabled: o.enabled || missing.some((m) => m.id === o.id) })),
      ...missing.filter((m) => !d!.options.some((o) => o.id === m.id)).map((m) => ({ ...m, enabled: true })),
    ];
    await editOrderFieldInTx(c, admin, d.id, {
      version: d.version,
      label: d.label,
      enabled: d.enabled,
      display: d.display,
      position: d.position,
      read_role: d.read_role,
      write_role: d.write_role,
      required_on: d.required_on,
      config: d.config,
      options,
    });
    d = (await findField(c, spec.key))!;
  }
  return d;
}

/** Sets the select field on the order the way the order card does. */
async function setField(env: EffectEnv, index: number, d: { id: string; version: number }, optionId: string) {
  const o = await lockedOrder(env.c, env.orderId);
  const r = await patchOrderFieldsInTx(env.c, env.actor, env.orderId, {
    // A run_rule chain shares the run id and restarts the index: the rule id keeps the request key unique.
    client_key: stableUuid('v2-org-field', env.runId, env.rule.id, String(index)),
    order_version: Number(o.version),
    changes: [{ field_id: d.id, definition_version: d.version, type: 'select', value: optionId }],
  });
  return Boolean(r.changed);
}

const allPriorities = (tenantId: string) => (Object.keys(PRIORITIES) as Priority[]).map((p) => priorityOption(tenantId, p));
/** The saving admin, when the engine passes it to validate (ctx.actor); otherwise provisioning waits for the first run. */
const savingActor = (ctx: unknown) => (ctx as { actor?: Actor }).actor;

const noParams = z.strictObject({});

export const effects: EffectModule = {
  handlers: {
    assign_user: {
      schema: z.strictObject({ user_id: z.uuid() }),
      validate: async (c, p, ctx) => {
        const u = await eligible(c, p.user_id);
        const actor = savingActor(ctx);
        if (actor) await ensureField(c, actor, null, OWNER, [{ id: u.user_id, label: u.name }]);
      },
      describe: (p, names) => `Ustawi opiekuna zamówienia: ${names[p.user_id] ?? p.user_id}`,
      apply: async (env, p, index) => {
        const u = await eligible(env.c, p.user_id);
        const d = await ensureField(env.c, env.actor, env.rule.id, OWNER, [{ id: u.user_id, label: u.name }]);
        const changed = await setField(env, index, d, u.user_id);
        return result('assign_user', changed, changed ? `Przypisano opiekuna: ${u.name}` : `Opiekun bez zmian: ${u.name}`);
      },
    },
    set_priority: {
      schema: z.strictObject({ priority: z.enum(['high', 'normal', 'low']) }),
      validate: async (c, _p, ctx) => {
        const actor = savingActor(ctx);
        if (actor) await ensureField(c, actor, null, PRIORITY, allPriorities(actor.tenantId));
      },
      describe: (p) => `Ustawi priorytet: ${PRIORITIES[p.priority as Priority].toLowerCase()}`,
      apply: async (env, p, index) => {
        const d = await ensureField(env.c, env.actor, env.rule.id, PRIORITY, allPriorities(env.actor.tenantId));
        const option = priorityOption(env.actor.tenantId, p.priority);
        const changed = await setField(env, index, d, option.id);
        const label = option.label.toLowerCase();
        return result('set_priority', changed, changed ? `Ustawiono priorytet: ${label}` : `Priorytet bez zmian: ${label}`);
      },
    },
    assign_warehouse: {
      schema: z.strictObject({ warehouse_id: z.uuid('Wybierz magazyn') }),
      validate: async (c, p) => {
        ensure((await c.query('SELECT 1 FROM warehouses WHERE id=$1', [p.warehouse_id])).rowCount === 1, 422, 'Magazyn nie należy do tej firmy');
      },
      describe: (p, names) => `Przeniesie zamówienie i jego rezerwacje do magazynu ${names[p.warehouse_id] ?? p.warehouse_id}`,
      apply: async (env, p) => {
        const o = await lockedOrder(env.c, env.orderId);
        if (o.warehouse_id === p.warehouse_id) {
          const name = (await env.c.query('SELECT name FROM warehouses WHERE id=$1', [p.warehouse_id])).rows[0]?.name ?? p.warehouse_id;
          return result('assign_warehouse', false, `Magazyn bez zmian: ${name}`);
        }
        const moved = await transferOrderWarehouseInTx(env.c, env.actor, env.orderId, p.warehouse_id, 'automation');
        return result('assign_warehouse', true, `Przeniesiono do magazynu ${moved.to_warehouse_name} (z ${moved.from_warehouse_name})`);
      },
    },
    reserve_stock: {
      schema: noParams,
      describe: () => 'Zarezerwuje stan dla pozycji zamówienia',
      apply: async (env) => {
        const changed = await reserveOrderStockInTx(env.c, env.actor, env.orderId);
        return result('reserve_stock', changed, changed ? 'Zarezerwowano stan dla pozycji zamówienia' : 'Rezerwacja bez zmian: pozycje są już zarezerwowane');
      },
    },
    release_stock: {
      schema: noParams,
      describe: () => 'Zwolni rezerwację stanu zamówienia (zamówienie zostaje otwarte)',
      apply: async (env) => {
        const changed = await releaseOrderStockInTx(env.c, env.actor, env.orderId);
        return result('release_stock', changed, changed ? 'Zwolniono rezerwację stanu zamówienia' : 'Rezerwacja bez zmian: zamówienie nie ma aktywnej rezerwacji');
      },
    },
  },
  catalogParams: async (c) => {
    const people = (await c.query('SELECT user_id,name FROM customer_message_eligible_assignees(NULL) ORDER BY name,user_id')).rows;
    const warehouses = (await c.query('SELECT id,name FROM warehouses ORDER BY name,id')).rows;
    return {
      assign_user: [
        { key: 'user_id', label: 'Opiekun', kind: 'select', options: people.map((m) => ({ value: m.user_id, label: m.name })), required: true },
      ],
      set_priority: [
        {
          key: 'priority',
          label: 'Priorytet',
          kind: 'select',
          options: (Object.keys(PRIORITIES) as Priority[]).map((p) => ({ value: p, label: PRIORITIES[p] })),
          required: true,
        },
      ],
      assign_warehouse: [
        { key: 'warehouse_id', label: 'Magazyn', kind: 'select', options: warehouses.map((w) => ({ value: w.id, label: w.name })), required: true },
      ],
      reserve_stock: [],
      release_stock: [],
    };
  },
};
