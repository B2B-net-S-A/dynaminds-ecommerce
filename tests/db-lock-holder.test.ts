/** Source checks for fail-closed session locks (db-lock-holder.ts); the behaviour is in db-lock-holder.database.test.ts.
 * Every dedicated client that takes a session advisory lock is a lockDbClient whose work runs in holdingDbLock, and
 * the transaction runners such work commits through check the lock right before COMMIT. No database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
function sources(dir = join(root, 'server')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sources(join(dir, e.name))
    : /\.ts$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : []);
}
/** Its own session lease: poisons itself on the client's 'error' and 'end' (renewal202), so it stays as it is. */
const OWN_LEASE = ['server/large-import/shared-session-writer.ts'];

test('every dedicated client taking a session advisory lock is a lockDbClient used through holdingDbLock', () => {
  const holders: string[] = [];
  for (const file of sources()) {
    const at = relative(root, file), text = readFileSync(file, 'utf8');
    if (at === 'server/db-lock-holder.ts' || OWN_LEASE.includes(at)) continue;
    const dedicated = /new\s+pg(?:\.default)?\.Client\s*\(/.test(text);
    const sessionLock = /pg_(?:try_)?advisory_lock(?:_shared)?\s*\(/.test(text);
    if (dedicated && sessionLock) assert.match(text, /lockDbClient\(\s*new\s+pg\.Client/, at + ' takes a session lock on a dedicated client');
    for (const m of text.matchAll(/(\w+)\s*=\s*lockDbClient\(/g)) {
      holders.push(at);
      assert.match(text, new RegExp('holdingDbLock\\(' + m[1] + ','), `${at}: the work of ${m[1]} runs in holdingDbLock(${m[1]}, …)`);
    }
  }
  assert.equal(holders.length, 23, 'the 23 lock clients in 22 files: ' + holders.join(' '));
});

test('tenantTx and the local transaction runners in lock-holder files check the locks right before COMMIT', () => {
  const db = readFileSync(join(root, 'server/db.ts'), 'utf8');
  const tenantTx = db.slice(db.indexOf('export async function tenantTx<T>('), db.indexOf('export async function migrate('));
  assert.match(tenantTx, /await assertDbLocksHeldInTx\(c\);\n\s*commitAttempted = true;\n\s*await c\.query\('COMMIT'\);/);
  for (const file of ['server/carrier-shipping.ts', 'server/ebay-oauth.ts']) {
    const text = readFileSync(join(root, file), 'utf8');
    const commits = [...text.matchAll(/await c\.query\('COMMIT'\);/g)].length;
    assert.equal(commits, [...text.matchAll(/await assertDbLocksHeldInTx\(c\);\n\s*await c\.query\('COMMIT'\);/g)].length, file);
  }
});
