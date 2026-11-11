import { z } from 'zod';
// PostgreSQL bigint revisions stay exact across JSON; numbers must be safe integers.
const orderVersion = z.union([
  z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v => /^[1-9][0-9]{0,18}$/.test(v) && v.trim() === v && BigInt(v) <= 9223372036854775807n),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String),
]);
export const orderStatusInput = z.object({
  status: z.string().max(40),
  expected_version: orderVersion,
});
