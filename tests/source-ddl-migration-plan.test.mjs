import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sourceDdlMigrationPlan} from '../tools/build/source-ddl-migration-plan.mjs';
import {RELEASE_MIGRATIONS} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
const program = body => `async function migrate(){for (const [name, file] of [${body}]) { await use(name,file); }}`;

test('multiline pairs and trailing commas preserve every ordered migration', () => {
  const entries = sourceDdlMigrationPlan(program("['124_before', './124.sql'],\r\n[\r\n'125_projection',\r\n'./125.sql',\r\n],\n['126_balances','./126.sql',],"));
  assert.deepEqual(entries.map(x => x.name), ['124_before','125_projection','126_balances']);
  assert(entries.every(Object.isFrozen));assert(Object.isFrozen(entries));
});
test('unparsed syntax cannot silently omit a stage', () => {
  for (const body of ["['001_ok','./001.sql'],buildOtherStage()", "['001_ok','./001.sql'],['002_bad', './nested/002.sql']", "['001_ok','./001.sql'],['002_bad', './002.ts']"])
    assert.throws(() => sourceDdlMigrationPlan(program(body)), /entire migration program/);
});
test('duplicate stage identities and ambiguous programs refuse compilation', () => {
  for (const body of ["['001_ok','./001.sql'],['001_ok','./002.sql']", "['001_ok','./001.sql'],['002_other','./001.sql']"])
    assert.throws(() => sourceDdlMigrationPlan(program(body)), /duplicate migration/);
  assert.throws(() => sourceDdlMigrationPlan(program("['001_ok','./001.sql']") + program("['002_ok','./002.sql']")), /one literal/);
});
test('actual migrator includes both previously omitted payment projection and COD stages', async () => {
  const entries = sourceDdlMigrationPlan(await readFile(new URL('../server/db.ts', import.meta.url), 'utf8'));
  const index = entries.findIndex(x => x.name === '124_payment_import_allocations');
  assert.deepEqual(entries.slice(index,index+3), [
    {name:'124_payment_import_allocations',file:'124_payment_import_allocations.sql'},
    {name:'125_payment_import_allocation_source_projection',file:'125_payment_import_allocation_source_projection.sql'},
    {name:'126_payment_import_allocation_cod_balances',file:'126_payment_import_allocation_cod_balances.sql'},
  ]);
  // History up to 205 is immutable: 196 stages, pinned by count and last name.
  // 206-209 are literal in db.ts; every later stage comes from the release list in
  // ledger order (a new migration is one manifest row); the total is derived.
  const historical = entries.findIndex(x => x.name === '205_header_metadata_projection') + 1;
  assert.equal(historical, 196);
  const registered = [
    ['206_return_credit_destinations_history','206_return_credit_destinations_history.sql'],
    ['207_consumer_return_credit','207_consumer_return_credit.sql'],
    ['208_consumer_return_credit_guard_dedup','208_consumer_return_credit_guard_dedup.sql'],
    ['209_order_merge_delivery_inheritance','209_order_merge_delivery_inheritance.sql'],
    // 211 onward: the one release list (migration-manifest.mjs), appended by db.ts as ...RELEASE_MIGRATION_PROGRAM.
    ...RELEASE_MIGRATIONS.map(m => [m.name, m.file]),
  ].map(([name,file]) => ({name,file}));
  assert.deepEqual(entries.slice(historical), registered);
  assert.equal(entries.length, historical + registered.length);
  const numbers = registered.map(x => Number(x.name.slice(0,3)));
  assert(numbers.every((n,i) => i === 0 || n > numbers[i-1]), 'registered stages ascend');
  assert(!entries.some(x=>/^210_/.test(x.name)||/^210_/.test(x.file)));
});
test('the release list is appended once, only as the last element, and expands to its manifest rows', () => {
  const release = RELEASE_MIGRATIONS.map(m => ({name: m.name, file: m.file}));
  assert.deepEqual(sourceDdlMigrationPlan(program("['209_ok','./209.sql'],\n      ...RELEASE_MIGRATION_PROGRAM,\n")), [{name: '209_ok', file: '209.sql'}, ...release]);
  for (const body of ["...RELEASE_MIGRATION_PROGRAM,['209_ok','./209.sql']", "['209_ok','./209.sql'],...RELEASE_MIGRATION_PROGRAM,...RELEASE_MIGRATION_PROGRAM", "['209_ok','./209.sql'],...OTHER_PROGRAM"])
    assert.throws(() => sourceDdlMigrationPlan(program(body)), /entire migration program/);
  assert.throws(() => sourceDdlMigrationPlan(program("['211_return_credit148_acceptance','./211_return_credit148_acceptance_install.sql'],...RELEASE_MIGRATION_PROGRAM")), /duplicate migration/);
});
