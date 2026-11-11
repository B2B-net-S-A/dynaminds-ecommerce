/** Offline XSD check of the JPK files against the official MF schemas vendored in schemas/mf
 * (JPK_V7M(3) crd.gov.pl 2025/12/19/14090, JPK_V7K(3) 2025/12/19/14089, JPK_FA(4) from gov.pl/web/kas)
 * — engine and rules in server/mf-xsd.ts. */
import { Problem } from './errors';
import { MF_SCHEMA_ROOT, firstXsdError, mfXsdValidator, sharedMfXsdValidator, type MfSchema, type XsdResult, type XsdValidator } from './mf-xsd';

export type JpkSchema = 'JPK_V7M' | 'JPK_V7K' | 'JPK_FA';
const STRUCTURE: Record<JpkSchema, MfSchema> = { JPK_V7M: 'JPK_V7M(3)', JPK_V7K: 'JPK_V7K(3)', JPK_FA: 'JPK_FA(4)' };

export function jpkXsdValidator(schema: JpkSchema, root = MF_SCHEMA_ROOT): XsdValidator {
  return root === MF_SCHEMA_ROOT ? sharedMfXsdValidator(STRUCTURE[schema]) : mfXsdValidator(STRUCTURE[schema], root);
}

/** Before a JPK file is handed out: a file that does not conform is refused (422) with the first
 * schema error. Without the schema or the engine (source/dev tree only; a release refuses to start) the check is skipped (returned, never a pass). */
export async function ensureJpkConforms(schema: JpkSchema, xml: string, validate: (schema: JpkSchema, xml: string) => Promise<XsdResult> = (s, x) => jpkXsdValidator(s).validate(x)): Promise<XsdResult> {
  const r = await validate(schema, xml);
  if (r.status === 'invalid') throw new Problem(422, `Plik ${STRUCTURE[schema]} nie jest zgodny ze schematem Ministerstwa Finansów: ${firstXsdError(r)}`);
  return r;
}
