// Sito testów db (scripts/ci/select-pr-tests.mjs): zmiana schematu, migracji albo zależności nie wybiera już
// pełnego zestawu (decyzja 12.11.2026) — pakiet migracji i zestaw dymny w budżecie PR-a.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify } from '../scripts/ci/classify-tests.mjs';
import { MIGRATION_BUNDLE, SMOKE_SIZE, migrationNumber, select } from '../scripts/ci/select-pr-tests.mjs';

const db = new Set(classify().db);
const inBundle = (f) => MIGRATION_BUNDLE.some((re) => re.test(f.slice('tests/'.length)));
const PR = { limit: 40, budgetMin: 75 };

test('server/269_x.sql: tryb selected z pakietem migracji, w limicie PR-a', () => {
  const r = select(['server/269_x.sql'], PR);
  assert.equal(r.mode, 'selected');
  assert.ok(r.files.length > 0 && r.files.length <= PR.limit, `plików: ${r.files.length}`);
  assert.ok(r.files.every((f) => db.has(f)));
  assert.ok(r.files.some(inBundle), 'brak testów pakietu migracji');
  assert.ok(r.files.includes('tests/migration-ledger-guard.test.ts'));
  assert.equal(r.bundle, r.files.length);
  assert.equal(r.smoke, 0);
});

test('migracja NNN dokłada testy db z numerem NNN w nazwie', () => {
  const numbered = [...db].filter((f) => /(?<!\d)267(?!\d)/.test(f)).sort();
  assert.ok(numbered.length > 0, 'brak testu db z 267 w nazwie — zmień numer w teście');
  const r = select(['server/267_status_categories_automation_editors.sql'], { limit: numbered.length });
  assert.deepEqual(r.files, numbered);
});

test('pakiet migracji ma pierwszeństwo przed resztą powiązanych (server/db.ts)', () => {
  const r = select(['server/db.ts'], PR);
  assert.equal(r.mode, 'selected');
  assert.ok(r.bundle > 0, 'brak plików pakietu migracji');
  // Bundle files come first: a non-bundle file is picked only once the whole bundle is (the output is sorted by
  // name, so the order of r.files says nothing; which files fit depends on the measured durations).
  const whole = [...db].filter(inBundle);
  assert.ok(r.files.every(inBundle) || whole.every((f) => r.files.includes(f)), r.files.join(', '));
  const wide = select(['server/db.ts'], { limit: 120, budgetMin: 600 });
  assert.ok(wide.files.length > r.files.length && wide.files.some((f) => !inBundle(f)));
});

test('package.json: zestaw dymny i pakiet migracji, nigdy pełny zestaw', () => {
  const r = select(['package.json'], { limit: 1000 });
  assert.equal(r.mode, 'selected');
  assert.equal(r.smoke, SMOKE_SIZE);
  assert.ok(r.bundle > 0);
  assert.ok(r.files.length < db.size, `${r.files.length} z ${db.size}`);
  for (const f of ['tsconfig.json', '.github/workflows/ci.yml', 'tools/build/migration-manifest.mjs']) {
    assert.equal(select([f], PR).mode, 'selected', f);
  }
});

test('zwykła zmiana bez dotkniętego testu db: tryb none', () => {
  assert.equal(select(['docs/ci/README.md'], PR).mode, 'none');
});

test('migrationNumber', () => {
  assert.equal(migrationNumber('server/269_x.sql'), '269');
  assert.equal(migrationNumber('server/catalog-stock-count-schema-fragment169.sql'), '169');
  assert.equal(migrationNumber('server/schema.sql'), null);
});
