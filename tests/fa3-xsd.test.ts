/** The FA(3) XSD check: vendored official schema (schemas/mf/FA/3) through xmllint-wasm with --nonet,
 * imports resolved from the vendored files only; without the schema the check is skipped with the
 * reason; the refusal before a file leaves the application (422, Polish message). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fa3XsdValidator, ensureFa3Conforms } from '../server/fa3-xsd';
import { localSchemaLocations, mfXsdValidator } from '../server/mf-xsd';
import { Problem } from '../server/errors';

const golden = readFileSync(new URL('./fa3-golden/fv-consumer.xml', import.meta.url), 'utf8');

test('without the vendored schema every check is skipped with the Polish reason, never a pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fa3-xsd-none-'));
  try {
    const v = fa3XsdValidator(dir);
    assert.equal(v.available, false); assert.match(v.reason, /Brak oficjalnego schematu FA\(3\)/);
    assert.deepEqual(await v.validate('<x/>'), { status: 'skipped', reason: v.reason });
    // The guard does not refuse a skipped check; the caller sees the skip.
    assert.deepEqual(await ensureFa3Conforms(golden, 'faktury', v.validate), { status: 'skipped', reason: v.reason });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the official FA(3) schema validates a generated file offline and rejects wrong structure, DTD, PI and BOM', async () => {
  const v = fa3XsdValidator();
  assert.equal(v.available, true, v.reason); assert.match(v.source!, /schemas\/mf\/FA\/3\/schemat\.xsd$/);
  assert.deepEqual(await v.validate(golden), { status: 'valid' });
  const wrong = await v.validate(golden.replace('<WariantFormularza>3</WariantFormularza>', '<WariantFormularza>2</WariantFormularza>'));
  assert.equal(wrong.status, 'invalid'); assert.match((wrong as { errors: string }).errors, /WariantFormularza/);
  assert.equal((await v.validate(golden.replace(/<P_15>[^<]*<\/P_15>/, ''))).status, 'invalid', 'P_15 is required');
  assert.equal((await v.validate(golden.replace('<Faktura ', '<!DOCTYPE Faktura [<!ENTITY e SYSTEM "file:///etc/passwd">]><Faktura '))).status, 'invalid');
  assert.equal((await v.validate(golden.replace('<Faktura ', '<?pi x?><Faktura '))).status, 'invalid');
  assert.equal((await v.validate('﻿' + golden)).status, 'invalid');
  assert.equal((await v.validate('<Faktura')).status, 'invalid', 'not well-formed');
});

test('imports resolve from the vendored directory only: an http schemaLocation with no local file fails under --nonet', async () => {
  // Mapping: only names that exist locally are rewritten, the rest stay as they are.
  assert.equal(localSchemaLocations('<i schemaLocation="http://crd.gov.pl/a/b/X.xsd"/><i schemaLocation="https://example.com/Y.xsd"/>', new Set(['X.xsd'])),
    '<i schemaLocation="X.xsd"/><i schemaLocation="https://example.com/Y.xsd"/>');
  const root = mkdtempSync(join(tmpdir(), 'mf-xsd-net-'));
  try {
    mkdirSync(join(root, 'FA', '3'), { recursive: true });
    writeFileSync(join(root, 'FA', '3', 'schemat.xsd'), `<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:o="urn:other" targetNamespace="urn:t" elementFormDefault="qualified">
      <xs:import namespace="urn:other" schemaLocation="http://127.0.0.1:9/Other.xsd"/><xs:element name="Faktura" type="o:T"/></xs:schema>`);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ schemas: { 'FA(3)': { dir: 'FA/3', root: 'schemat.xsd', targetNamespace: 'urn:t' } }, files: [] }));
    const r = await mfXsdValidator('FA(3)', root).validate('<?xml version="1.0"?><Faktura xmlns="urn:t"/>');
    assert.equal(r.status, 'invalid'); assert.match((r as { errors: string }).errors, /network|Walidator XSD|not|Failed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ensureFa3Conforms: a non-conforming file is refused with 422 and the first schema error in Polish context', async () => {
  const bad = golden.replace(/<P_15>[^<]*<\/P_15>/, '');
  await assert.rejects(ensureFa3Conforms(bad, 'FV/LOK/2026/000042'), (e: unknown) => {
    assert.ok(e instanceof Problem); assert.equal(e.status, 422);
    assert.match(e.message, /^Plik FA\(3\) FV\/LOK\/2026\/000042 nie jest zgodny ze schematem FA\(3\) Ministerstwa Finansów: /);
    return true;
  });
  assert.deepEqual(await ensureFa3Conforms(golden, 'FV/LOK/2026/000042'), { status: 'valid' });
});
