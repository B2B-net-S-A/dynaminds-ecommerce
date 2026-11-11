/** Offline XSD check of FA(3) XML against the official MF schema FA(3) (crd.gov.pl wzór
 * 2025/06/25/13775) vendored in schemas/mf/FA/3 — engine and rules in server/mf-xsd.ts. */
import { Problem } from './errors';
import { MF_SCHEMA_ROOT, firstXsdError, mfXsdValidator, sharedMfXsdValidator, type XsdResult, type XsdValidator } from './mf-xsd';

export type Fa3XsdResult = XsdResult;
export type Fa3XsdValidator = XsdValidator;

/** Root is the schemas/mf directory (tests pass an empty one to see the unavailable state). */
export function fa3XsdValidator(root = MF_SCHEMA_ROOT): Fa3XsdValidator {
  return root === MF_SCHEMA_ROOT ? sharedMfXsdValidator('FA(3)') : mfXsdValidator('FA(3)', root);
}

/** Before a file leaves the application: a FA(3) file that does not conform is refused (422) with
 * the first schema error. Without the schema or the engine (source/dev tree only; a release refuses to start) the check
 * is skipped and reported by the return value, never as a pass. */
export async function ensureFa3Conforms(xml: string, what: string, validate: (xml: string) => Promise<XsdResult> = x => fa3XsdValidator().validate(x), outcome = ''): Promise<XsdResult> {
  const r = await validate(xml);
  if (r.status === 'invalid') throw new Problem(422, `Plik FA(3) ${what} nie jest zgodny ze schematem FA(3) Ministerstwa Finansów: ${firstXsdError(r)}${outcome}`);
  return r;
}
