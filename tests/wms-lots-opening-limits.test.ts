/** Plan-dependent cap of the WMS opening (stock rows per table, zero rows included); no database.
 * The opening itself at 19 200 / 100 000 rows: tests/wms-lots-opening-scale.test.ts on a PG04 clone. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WMS_LOT_LIMITS } from '../server/wms-lots-schema';
import { WMS_LOT_OPENING_ROWS, wmsLotOpeningRowsForPlan } from '../server/wms-lots-limits';

test('starter and business keep 10 000 rows; unknown, missing and prototype plans get the small cap', () => {
  assert.equal(WMS_LOT_LIMITS.physical_rows, 10_000);
  assert.equal(wmsLotOpeningRowsForPlan('starter'), 10_000);
  assert.equal(wmsLotOpeningRowsForPlan('business'), 10_000);
  for (const plan of ['platinum', '', null, undefined, '__proto__', 'constructor', 'toString'])
    assert.equal(wmsLotOpeningRowsForPlan(plan), 10_000, String(plan));
  assert(Object.isFrozen(WMS_LOT_OPENING_ROWS));
});

test('enterprise covers 100 000 SKU in both warehouses of the scale profile (20 000 SKU = 19 200 rows)', () => {
  const cap = wmsLotOpeningRowsForPlan('enterprise');
  assert(cap >= 2 * 100_000, `enterprise cap ${cap}`);
  assert(cap > 19_200);
});

test('openingSnapshot reads the plan cap and keeps one ordered locking statement per table', () => {
  const source = readFileSync(new URL('../server/wms-lots.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function openingSnapshot('), source.indexOf('function previewHead('));
  assert.match(body, /wmsLotOpeningRowsInTx\(c\)/);
  assert.doesNotMatch(body, /WMS_LOT_LIMITS\.physical_rows/);
  // Both tables keep one ordered locking statement each (lock order unchanged).
  assert.equal(body.match(/FOR UPDATE OF s/g)?.length, 1);
  assert.equal(body.match(/FOR UPDATE OF b/g)?.length, 1);
});
