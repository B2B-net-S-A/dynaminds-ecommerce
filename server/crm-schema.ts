import { z } from "zod";
export const CRM_FILE_MAX_BYTES = 2000000;
const text = z.string().regex(/^[^\x00]*$/, "Tekst nie może zawierać NUL");
const uuid = z.uuid().transform((x) => x.toLowerCase());
const country = text.regex(/^(?:[A-Z]{2})?$/);
export const crmProfileShape = {
  status_id: uuid.optional(),
  star: z.number().int().min(0).max(5).optional(),
  contractor_id: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  login: text.max(156).optional(),
  phone: text.max(156).optional(),
  email: text
    .max(220)
    .refine(
      (x) => x === "" || z.email().safeParse(x).success,
      "Nieprawidłowy e-mail",
    )
    .optional(),
  notes: text.max(20000).optional(),
  invoice_company: text.max(500).optional(),
  invoice_fullname: text.max(500).optional(),
  invoice_address: text.max(500).optional(),
  invoice_postcode: text.max(20).optional(),
  invoice_city: text.max(100).optional(),
  invoice_state: text.max(35).optional(),
  invoice_country_code: country.optional(),
  invoice_tax_id: text
    .max(50)
    .transform((x) => x.replace(/[\s-]/g, ""))
    .optional(),
  delivery_company: text.max(500).optional(),
  delivery_fullname: text.max(500).optional(),
  delivery_address: text.max(500).optional(),
  delivery_postcode: text.max(20).optional(),
  delivery_city: text.max(100).optional(),
  delivery_state: text.max(35).optional(),
  delivery_country_code: country.optional(),
  custom_extra_fields: z
    .record(z.uuid(), z.unknown())
    .refine((x) => Object.keys(x).length <= 100)
    .optional(),
};
export const crmCreate = z
  .object({ client_key: uuid, ...crmProfileShape })
  .strict();
export const crmPatch = z
  .object({
    client_key: uuid,
    version: z.number().int().positive(),
    ...crmProfileShape,
  })
  .strict()
  .refine((x) => Object.keys(x).length > 2, "Brak zmian");
export const crmDelete = z
  .object({ client_key: uuid, version: z.number().int().positive() })
  .strict();
export const crmGroupCreate = z
  .object({ client_key: uuid, name: text.trim().min(1).max(15) })
  .strict();
export const crmGroupPatch = crmGroupCreate.extend({
  version: z.number().int().positive(),
});
export const crmStatusCreate = z
  .object({
    client_key: uuid,
    name: text.trim().min(1).max(30),
    color: text.regex(/^#[0-9a-fA-F]{6}$/),
    group_id: uuid.optional(),
  })
  .strict();
export const crmStatusPatch = z
  .object({
    client_key: uuid,
    version: z.number().int().positive(),
    name: text.trim().min(1).max(30).optional(),
    color: text.regex(/^#[0-9a-fA-F]{6}$/).optional(),
    group_id: uuid.optional(),
  })
  .strict()
  .refine((x) => Object.keys(x).length > 2, "Brak zmian");
export const crmStatusDelete = crmDelete.extend({ target_status_id: uuid });
export const crmLink = z
  .object({
    client_key: uuid,
    version: z.number().int().positive(),
    order_id: uuid,
  })
  .strict();
export const crmList = z
  .object({
    search: text.max(220).default(""),
    status_id: uuid.optional(),
    client_id: uuid.optional(),
    email: text.max(220).optional(),
    phone: text.max(156).optional(),
    login: text.max(156).optional(),
    invoice_company: text.max(500).optional(),
    invoice_tax_id: text.max(50).optional(),
    invoice_fullname: text.max(500).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const crmDetail = z
  .object({
    include_custom_extra_fields: z.enum(["true", "false"]).default("false"),
  })
  .strict();
export const crmObserve = z
  .object({
    method: z.enum(["POST", "PATCH", "DELETE"]),
    path: text.max(200),
    body: z.unknown(),
  })
  .strict();
export const crmFileInput = z
  .object({
    title: text
      .trim()
      .min(1)
      .max(40)
      .refine((x) => !/[\r\n\x00/\\]/.test(x)),
    file: text.max(2666673),
  })
  .strict();

export const crmOrderPage = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    after: text.max(300).optional(),
  })
  .strict();
