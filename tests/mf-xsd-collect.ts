/** Every XML a test file renders goes through `keep(name, xml)`; `conformAll()` at the end of the file
 * registers one test that validates all of them against the vendored official MF schema chosen by the
 * root namespace (FA(3), JPK_V7M(3), JPK_V7K(3), JPK_FA(4)). Unknown namespace or missing schema fails. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedMfXsdValidator, type MfSchema } from '../server/mf-xsd';
import { FA3_XML_NAMESPACE } from '../server/fa3-xml';
import { JPK_V7M_NAMESPACE, JPK_V7K_NAMESPACE } from '../server/jpk-v7';
import { JPK_FA_NAMESPACE } from '../server/jpk-fa';

const BY_NAMESPACE: Record<string, MfSchema> = { [FA3_XML_NAMESPACE]: 'FA(3)', [JPK_V7M_NAMESPACE]: 'JPK_V7M(3)', [JPK_V7K_NAMESPACE]: 'JPK_V7K(3)', [JPK_FA_NAMESPACE]: 'JPK_FA(4)' };
export function mfSchemaOf(xml: string): MfSchema {
  const ns = /<(?:Faktura|JPK)\s[^>]*xmlns="([^"]+)"/.exec(xml)?.[1], s = ns ? BY_NAMESPACE[ns] : undefined;
  if (!s) throw new Error('Nieznana przestrzeń nazw pliku: ' + ns);
  return s;
}
/** Official schema verdict for one file; the schema must be present (it is vendored). */
export async function conforms(xml: string): Promise<{ status: string; errors?: string }> {
  const v = sharedMfXsdValidator(mfSchemaOf(xml));
  assert.equal(v.available, true, v.reason);
  return v.validate(xml) as Promise<{ status: string; errors?: string }>;
}

export function xsdCollector(label: string) {
  const files: { name: string; xml: string }[] = [];
  return {
    keep(name: string, xml: string): string { files.push({ name, xml }); return xml; },
    conformAll(): void {
      test(`XSD: every ${label} file of this test conforms to its official MF schema`, async t => {
        assert.ok(files.length > 0, 'no file collected');
        const bad: string[] = [];
        for (const f of files) {
          const r = await conforms(f.xml);
          t.diagnostic(`${mfSchemaOf(f.xml)} ${f.name}: ${r.status}`);
          if (r.status !== 'valid') bad.push(`${f.name}: ${r.status} ${r.errors ?? ''}`);
        }
        assert.deepEqual(bad, []);
      });
    },
  };
}
