/** Local CRM definition editor. No Base wire mutation API is inferred. */
import type { PoolClient } from "pg";
import { z } from "zod";
import { ensure } from "./errors";
const text = z.string().regex(/^[^\x00]*$/),
  types = z.enum([
    "text",
    "number",
    "select",
    "checkbox",
    "radio",
    "date",
    "file",
  ]);
const options = z
  .array(text.trim().min(1).max(200))
  .max(100)
  .refine((v) => new Set(v).size === v.length, "Opcje nie mogą się powtarzać");
export const crmFieldCreate = z
  .object({
    client_key: z.uuid().transform((v) => v.toLowerCase()),
    name: text.trim().min(1).max(120),
    editor_type: types,
    options: options.default([]),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      ["select", "checkbox", "radio"].includes(v.editor_type)
        ? v.options.length === 0
        : v.options.length !== 0
    )
      c.addIssue({
        code: "custom",
        message: "Opcje są wymagane wyłącznie dla pól wyboru",
      });
  });
export const crmFieldPatch = z
  .object({
    client_key: z.uuid().transform((v) => v.toLowerCase()),
    version: z.number().int().positive(),
    name: text.trim().min(1).max(120).optional(),
    options: options.optional(),
    position: z.number().int().min(0).max(1000).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 2, "Brak zmian");
export const crmFieldAck = z
  .object({
    id: z.uuid(),
    name: text.min(1).max(120),
    editor_type: types,
    options,
    position: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    archived: z.boolean(),
  })
  .strict();
type Row = Record<string, any>;
export function fieldDefinition(r: Row) {
  return {
    id: r.id,
    name: r.name,
    editor_type: r.editor_type,
    options: r.options,
    position: r.position,
    version: r.version,
    archived: r.archived_at !== null && r.archived_at !== undefined,
  };
}
async function installed(c: PoolClient) {
  const r = (
    await c.query(
      `SELECT
 EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.crm_extra_fields') AND attname='version' AND attnum>0 AND NOT attisdropped) AS version_present,
 EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.crm_extra_fields') AND attname='archived_at' AND attnum>0 AND NOT attisdropped) AS archive_present,
 EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.crm_extra_fields') AND attname='version' AND attnum>0 AND NOT attisdropped AND atttypid='pg_catalog.int4'::pg_catalog.regtype AND attnotnull) AS version_valid,
 EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass('public.crm_extra_fields') AND attname='archived_at' AND attnum>0 AND NOT attisdropped AND atttypid='pg_catalog.timestamptz'::pg_catalog.regtype AND NOT attnotnull) AS archive_valid`,
    )
  ).rows[0];
  // Tenant transactions cannot read the owner-only migrations journal. Detect
  // this additive capability from public catalog metadata in the same snapshot.
  const keys = [
    "version_present",
    "archive_present",
    "version_valid",
    "archive_valid",
  ];
  ensure(
    r &&
      Object.keys(r).length === keys.length &&
      keys.every((k) => typeof r[k] === "boolean"),
    503,
    "Nie można potwierdzić edytora pól",
  );
  if (
    !r.version_present &&
    !r.archive_present &&
    !r.version_valid &&
    !r.archive_valid
  )
    return false; // Full legacy215: read definitions, refuse definition writes.
  ensure(
    r.version_present &&
      r.archive_present &&
      r.version_valid &&
      r.archive_valid,
    503,
    "Niepełna instalacja edytora pól",
  );
  return true;
}
export async function readCrmFieldDefinitions(c: PoolClient) {
  const ready = await installed(c);
  return {
    data: ready
      ? (
          await c.query(
            "SELECT id AS extra_field_id,name,editor_type,options,position,version,(archived_at IS NOT NULL) AS archived FROM crm_extra_fields ORDER BY position,id",
          )
        ).rows
      : (
          await c.query(
            "SELECT id AS extra_field_id,name,editor_type,options FROM crm_extra_fields ORDER BY position,id",
          )
        ).rows,
    definition_editor_available: ready,
  };
}
/** Called only inside CRM's existing tenant mutex and fresh locked admin transaction. */
export async function applyCrmFieldCommand(
  c: PoolClient,
  tenantId: string,
  op: { kind: string; id: string | null; body: any },
) {
  ensure(
    await installed(c),
    503,
    "Edycja definicji pól jest niedostępna w tej wersji aplikacji",
  );
  const rows = (
    await c.query(
      "SELECT * FROM crm_extra_fields ORDER BY position,id LIMIT 1001 FOR UPDATE",
    )
  ).rows;
  ensure(rows.length <= 1000, 422, "Lokalny limit definicji pól wynosi 1000");
  const create = op.kind === "field-definitions.create",
    b = op.body,
    row = create ? null : rows.find((x) => x.id === op.id);
  ensure(create || row, 404, "Nie znaleziono definicji pola");
  if (row)
    ensure(row.version === b.version, 409, "Definicja pola została zmieniona");
  const editor = create ? b.editor_type : row!.editor_type,
    nextOptions = b.options ?? row!.options;
  ensure(
    ["select", "checkbox", "radio"].includes(editor)
      ? nextOptions.length > 0
      : nextOptions.length === 0,
    422,
    "Opcje są wymagane wyłącznie dla pól wyboru",
  );
  if (
    row &&
    b.options !== undefined &&
    ["select", "checkbox", "radio"].includes(editor)
  ) {
    const compatibility = (
      await c.query(
        "SELECT EXISTS(SELECT 1 FROM crm_values WHERE field_id=$1 AND NOT CASE WHEN $3::text='checkbox' THEN jsonb_typeof(value)='array' AND value <@ $2::jsonb ELSE jsonb_typeof(value)='string' AND $2::jsonb @> jsonb_build_array(value) END) AS incompatible",
        [row.id, JSON.stringify(nextOptions), editor],
      )
    ).rows[0];
    ensure(
      typeof compatibility?.incompatible === "boolean",
      503,
      "Nie potwierdzono zgodności opcji",
    );
    ensure(
      !compatibility.incompatible,
      422,
      "Nie można usunąć opcji zapisanej u klienta",
    );
  }
  if (create)
    ensure(rows.length < 1000, 422, "Lokalny limit definicji pól wynosi 1000");
  const position = b.position ?? (row ? row.position : rows.length);
  if (create || b.position !== undefined)
    ensure(
      position <= (create ? rows.length : rows.length - 1),
      422,
      "Kolejność pola jest poza listą",
    );
  if (create || b.position !== undefined) {
    const order = rows.filter((x) => x !== row);
    order.splice(position, 0, row ?? { id: null });
    for (let i = 0; i < order.length; i++) {
      const r = order[i];
      if (r.id && r !== row && r.position !== i)
        await c.query(
          "UPDATE crm_extra_fields SET position=$2,version=version+1 WHERE id=$1",
          [r.id, i],
        );
    }
  }
  const result = create
    ? (
        await c.query(
          "INSERT INTO crm_extra_fields(tenant_id,name,editor_type,options,position) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *",
          [tenantId, b.name, editor, JSON.stringify(nextOptions), position],
        )
      ).rows[0]
    : (
        await c.query(
          "UPDATE crm_extra_fields SET name=$2,options=$3::jsonb,position=$4,version=version+1,archived_at=CASE WHEN $5::boolean IS NULL THEN archived_at WHEN $5 THEN coalesce(archived_at,clock_timestamp()) ELSE NULL END WHERE id=$1 RETURNING *",
          [
            row!.id,
            b.name ?? row!.name,
            JSON.stringify(nextOptions),
            position,
            b.archived ?? null,
          ],
        )
      ).rows[0];
  ensure(result, 503, "Nie potwierdzono zapisu definicji pola");
  return fieldDefinition(result);
}
