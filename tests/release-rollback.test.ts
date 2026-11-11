/** MIG-4 without a database: the rollback refuses without consent, while N+1 still runs, with a backup of another
 * database or a damaged one, and drops the restored database again when its ledger is not the state before the upgrade. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rollbackToBackup, RollbackRefusedError, type RollbackDeps } from '../server/release-rollback';

const N = Array.from({ length: 233 }, (_, i) => String(i + 1).padStart(3, '0') + '_m');
const N1 = [...N, '244_custom_events_checksums', '248_guard_verdicts'];
const FILE = '/data/backups/pre-migration/k1-abc.dyna';
function deps(over: Partial<RollbackDeps> & { restoredLedger?: string[]; report?: object } = {}) {
  const calls: string[] = [];
  const d: RollbackDeps = {
    source: () => ({ database: 'dyna_n1', password: 'x', host: '127.0.0.1', port: 57084, user: 'postgres' }),
    sessions: async () => 0,
    ledger: async (_db, database) => { calls.push('ledger ' + database); return database === 'dyna_n1' ? N1 : over.restoredLedger ?? N; },
    restore: async (file, o) => { calls.push('restore ' + file + ' ' + o.purpose); return { id: 'r1', database: 'dynaminds_restore_00112233aabbccdd', directory: '/data/restores/r1',
      config: '/data/restores/r1/local-config.json', images: '/data/restores/r1/images', snapshot_at: '2026-10-28T01:00:00.000Z', source: 'dyna_n1', status: 'verified', preview_only: false, purpose: 'rollback' }; },
    drop: async (_db, database) => { calls.push('drop ' + database); },
    sha256: async () => 'a'.repeat(64),
    readText: async () => JSON.stringify(over.report ?? { id: 'k1-abc', created_at: '2026-10-28T01:00:00.000Z', file: FILE, sha256: 'a'.repeat(64), schema: '233', source: 'dyna_n1', status: 'created' }), // createBackup writes count(*) as text
    writeResult: async (f) => { calls.push('write ' + f); },
    now: () => new Date('2026-10-28T02:00:00.000Z'),
    operator: () => 'artur',
    ...over,
  };
  return { d, calls };
}
const refused = (re: RegExp) => (e: unknown) => e instanceof RollbackRefusedError && e.code === 'ROLLBACK_REFUSED' && re.test(e.message);

test('without --confirm naming the N+1 database nothing is read or restored', async () => {
  for (const confirm of [undefined, '', 'dynaminds', 'DYNA_N1']) {
    const { d, calls } = deps();
    await assert.rejects(() => rollbackToBackup({ backup: FILE, confirm }, d), refused(/jawnej zgody operatora: podaj --confirm dyna_n1/));
    assert.deepEqual(calls, []);
  }
});
test('while another session uses the N+1 database the rollback is refused before the restore', async () => {
  const { d, calls } = deps({ sessions: async () => 2 });
  await assert.rejects(() => rollbackToBackup({ backup: FILE, confirm: 'dyna_n1' }, d), refused(/ma 2 inne połączenia: zatrzymaj wydanie N\+1/));
  assert.deepEqual(calls, []);
});
test('a backup of another database, a changed file or a backup not older than the upgrade is refused before the restore', async () => {
  for (const [report, re] of [
    [{ id: 'k', created_at: 't', file: FILE, sha256: 'a'.repeat(64), schema: 233, source: 'other', status: 'created' }, /pochodzi z bazy other/],
    [{ id: 'k', created_at: 't', file: FILE, sha256: 'b'.repeat(64), schema: 233, source: 'dyna_n1', status: 'created' }, /inną sumę sha256/],
    [{ id: 'k', created_at: 't', file: FILE, sha256: 'a'.repeat(64), schema: '235', source: 'dyna_n1', status: 'created' }, /to nie jest kopia sprzed tej aktualizacji/],
    [{ id: 'k', created_at: 't', file: FILE, sha256: 'a'.repeat(64), schema: 'x1', source: 'dyna_n1', status: 'created' }, /nie opisuje utworzonej kopii/],
  ] as const) {
    const { d, calls } = deps({ report });
    await assert.rejects(() => rollbackToBackup({ backup: FILE, confirm: 'dyna_n1' }, d), refused(re));
    assert(!calls.some((c) => c.startsWith('restore')), calls.join());
  }
});
test('a restored ledger that is not the state before the upgrade drops the restored database', async () => {
  for (const restoredLedger of [N.slice(1), [...N.slice(1), '999_foreign']]) {
    const { d, calls } = deps({ restoredLedger });
    await assert.rejects(() => rollbackToBackup({ backup: FILE, confirm: 'dyna_n1' }, d), refused(/nie jest stanem sprzed aktualizacji.*usunięta/));
    assert.equal(calls.at(-1), 'drop dynaminds_restore_00112233aabbccdd');
    assert(!calls.some((c) => c.startsWith('write')));
  }
});
test('the confirmed rollback restores for release N, names what N+1 added and when data stops, and keeps the N+1 database', async () => {
  const { d, calls } = deps();
  const r = await rollbackToBackup({ backup: FILE, confirm: 'dyna_n1' }, d);
  assert.deepEqual(calls, ['ledger dyna_n1', 'restore ' + FILE + ' rollback', 'ledger dynaminds_restore_00112233aabbccdd', 'write /data/restores/r1/rollback.json']);
  assert.equal(r.status, 'rolled_back'); assert.equal(r.preview_only, false); assert.equal(r.rollback_of, 'dyna_n1');
  assert.deepEqual(r.ledger, { restored: 233, restored_last: '233_m', failed: 235, removed: ['244_custom_events_checksums', '248_guard_verdicts'] });
  assert.equal(r.data_lost_after, '2026-10-28T01:00:00.000Z');
  assert.deepEqual(r.consent, { confirmed_database: 'dyna_n1', by: 'artur', at: '2026-10-28T02:00:00.000Z' });
  assert.match(r.next, /bazę dynaminds_restore_00112233aabbccdd.*baza dyna_n1 zostaje bez zmian/);
});
