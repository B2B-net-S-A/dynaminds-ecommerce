/** The JPK XSD check: vendored official schemas JPK_V7M(3), JPK_V7K(3), JPK_FA(4) (schemas/mf) through
 * the same offline engine as FA(3); without a schema the check is skipped with the reason; the
 * refusal before a JPK file is handed out (422, Polish message). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jpkXsdValidator, ensureJpkConforms, type JpkSchema } from '../server/jpk-xsd';
import { renderJpkV7 } from '../server/jpk-v7';
import { renderJpkFa } from '../server/jpk-fa';
import { Problem } from '../server/errors';
import { JPK_GENERATED_AT, taxpayer, address, fvA } from './jpk-fixtures';

const SCHEMAS: JpkSchema[] = ['JPK_V7M', 'JPK_V7K', 'JPK_FA'];
const v7m = () => renderJpkV7({ variant: 'M', year: 2026, month: 10, taxpayer, generated_at: JPK_GENERATED_AT, documents: [fvA().jpk], surplus_zloty: 0n }).xml;

test('without the vendored schemas every JPK check is skipped with the Polish reason per structure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jpk-xsd-none-'));
  try {
    for (const schema of SCHEMAS) {
      const v = jpkXsdValidator(schema, dir);
      assert.equal(v.available, false); assert.match(v.reason, /Brak oficjalnego schematu JPK_/);
      assert.deepEqual(await v.validate('<x/>'), { status: 'skipped', reason: v.reason });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the official schemas validate generated files offline; each structure rejects the others and a broken file', async () => {
  const files: Record<JpkSchema, string> = {
    JPK_V7M: v7m(),
    JPK_V7K: renderJpkV7({ variant: 'K', year: 2026, month: 11, taxpayer, generated_at: JPK_GENERATED_AT, documents: [], surplus_zloty: 0n }).xml,
    JPK_FA: renderJpkFa({ from: '2026-10-01', to: '2026-10-31', taxpayer, address, generated_at: JPK_GENERATED_AT, documents: [fvA().jpk] }).xml,
  };
  for (const schema of SCHEMAS) {
    const v = jpkXsdValidator(schema);
    assert.equal(v.available, true, v.reason);
    for (const other of SCHEMAS) assert.equal((await v.validate(files[other])).status, other === schema ? 'valid' : 'invalid', `${schema} on ${other}`);
  }
  const broken = files.JPK_V7M.replace(/<SprzedazCtrl>.*<\/SprzedazCtrl>/, '');
  assert.equal((await jpkXsdValidator('JPK_V7M').validate(broken)).status, 'invalid', 'SprzedazCtrl is required');
  assert.equal((await jpkXsdValidator('JPK_V7M').validate('<!DOCTYPE JPK>' + files.JPK_V7M.slice(files.JPK_V7M.indexOf('<JPK')))).status, 'invalid', 'DTD refused');
});

test('ensureJpkConforms: a non-conforming file is refused with 422 naming the structure; a conforming one passes', async () => {
  const bad = v7m().replace('<Pouczenia>1</Pouczenia>', '');
  await assert.rejects(ensureJpkConforms('JPK_V7M', bad), (e: unknown) => {
    assert.ok(e instanceof Problem); assert.equal(e.status, 422);
    assert.match(e.message, /^Plik JPK_V7M\(3\) nie jest zgodny ze schematem Ministerstwa Finansów: .*Pouczenia/);
    return true;
  });
  assert.deepEqual(await ensureJpkConforms('JPK_V7M', v7m()), { status: 'valid' });
});
