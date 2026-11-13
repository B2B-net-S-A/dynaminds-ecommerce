/** validateRecoveredPimBeforeReadonly (buildApp readOnly) runs pim_dictionary_valid() on an owner pool connection.
 * Like the construction preflight (server/app.ts preflightUngatedConstructionPim, db.ts 120 s), its RR READ ONLY
 * transaction gets the 120 s statement budget; the pooled session keeps 8 s after COMMIT/ROLLBACK (SET LOCAL).
 * CI run 43235730710: 34 files failed with 57014 here. No database: a recording fake owner. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecoveredPimBeforeReadonly } from '../server/pim-dictionaries/recovery-gate';

function owner(failOn?: RegExp) {
  const seen: string[] = [];
  let released: boolean | undefined;
  const client = {
    async query(text: string) {
      seen.push(text);
      if (failOn?.test(text)) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      if (text.includes("current_setting('transaction_isolation')")) return { rows: [{ owner: true, isolation: 'repeatable read', readonly: 'on', zone: 'UTC' }] };
      if (text.includes("starts_with(relname,'pim_dictionary_')")) return { rows: [{ remnants: false, ledger: false }] };
      return { rows: [] };
    },
    release(discard?: boolean) { released = discard ?? false; },
  };
  return { seen, released: () => released, pool: { connect: async () => client } as any };
}

test('the readonly PIM validation runs with the 120 s owner budget inside its own transaction', async () => {
  const o = owner();
  assert.deepEqual(await validateRecoveredPimBeforeReadonly(o.pool), { available: false, previews: 0, operations: 0 });
  const begin = o.seen.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const budget = o.seen.indexOf("SET LOCAL statement_timeout='120s'");
  assert(begin === 0 && budget > begin, 'SET LOCAL right after BEGIN');
  assert(budget < o.seen.findIndex((q) => q.includes('pim_dictionary_')), 'before any validator');
  assert.equal(o.seen.at(-1), 'COMMIT');
  assert.equal(o.released(), false);
});

test('a failing validator still rolls back, so the 8 s session limit returns', async () => {
  const o = owner(/pim_dictionary_/);
  await assert.rejects(validateRecoveredPimBeforeReadonly(o.pool), (e: any) => e.code === '57014');
  assert.equal(o.seen.at(-1), 'ROLLBACK');
  assert(o.seen.includes("SET LOCAL statement_timeout='120s'"));
});
