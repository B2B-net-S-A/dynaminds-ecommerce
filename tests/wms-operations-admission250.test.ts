import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import {
  beginWmsTransaction,
  endWmsTransaction,
  wmsLotsAdmissionInTx,
  type WmsAdmission,
} from '../server/wms-lots-transaction';

// Without the database: which advisory locks each WMS admission mode takes. Ordinary writers
// share the tenant operations fence (row locks decide between them); serial and activation
// keep it exclusive for the tenant-wide procedures (opening, stocktakes).
function fakeClient(enabled: boolean) {
  const locks: string[] = [];
  const c = {
    async query(sql: string, args: unknown[] = []) {
      if (/to_regclass\('public\.wms_policies'\)/.test(sql)) return { rows: [{ available: true }] };
      if (/FROM wms_policies/.test(sql)) return { rows: enabled ? [{ enabled: true }] : [] };
      const lock = /pg_advisory_xact_lock(_shared)?\(hashtextextended\(\$1,0\)\)/.exec(sql);
      if (lock) {
        locks.push((lock[1] ? 'shared ' : 'exclusive ') + String(args[0]).split(':')[0]);
        return { rows: [{}] };
      }
      throw new Error('unexpected query: ' + sql);
    },
  } as unknown as PoolClient;
  beginWmsTransaction(c);
  return { c, locks };
}
async function admitted(enabled: boolean, ...modes: WmsAdmission[]) {
  const { c, locks } = fakeClient(enabled);
  try {
    for (const mode of modes) await wmsLotsAdmissionInTx(c, { tenantId: 't-1' }, mode);
    return locks;
  } finally {
    endWmsTransaction(c);
  }
}

test('ordinary shared writers take the tenant operations fence in shared mode', async () => {
  assert.deepEqual(await admitted(true, 'shared'), ['shared wms.policy', 'shared wms.operations']);
});

test('serial and activation keep the operations lock exclusive; read takes none', async () => {
  assert.deepEqual(await admitted(true, 'serial'), ['shared wms.policy', 'exclusive wms.operations']);
  assert.deepEqual(await admitted(true, 'activation'), [
    'exclusive wms.policy',
    'exclusive wms.operations',
  ]);
  assert.deepEqual(await admitted(true, 'read'), ['shared wms.policy']);
});

test('a disabled policy takes no operations lock except for activation', async () => {
  assert.deepEqual(await admitted(false, 'shared'), ['shared wms.policy']);
  assert.deepEqual(await admitted(false, 'serial'), ['shared wms.policy']);
  assert.deepEqual(await admitted(false, 'activation'), [
    'exclusive wms.policy',
    'exclusive wms.operations',
  ]);
});

test('a stronger mode must be chosen at admission, never upgraded inside the transaction', async () => {
  for (const [first, then] of [
    ['shared', 'serial'],
    ['read', 'shared'],
    ['read', 'serial'],
    ['shared', 'activation'],
    ['serial', 'activation'],
  ] as const)
    await assert.rejects(admitted(true, first, then), (e: any) => e.status === 409, first + '->' + then);
  // A weaker or equal request after a stronger admission adds no lock.
  assert.deepEqual(await admitted(true, 'serial', 'shared', 'read', 'serial'), [
    'shared wms.policy',
    'exclusive wms.operations',
  ]);
  assert.deepEqual(await admitted(true, 'activation', 'serial', 'shared'), [
    'exclusive wms.policy',
    'exclusive wms.operations',
  ]);
});
