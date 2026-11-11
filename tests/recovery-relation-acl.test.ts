import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { captureRelationAclSnapshot, relationAclSnapshotSchema, restoreRelationAclSnapshot } from '../server/recovery-relation-acl';

const row = { name: 'example', kind: 'r', owner: 'postgres', explicit: true, rls: false, force_rls: false, acl: ['postgres=arwdDxtm/postgres'] };
test('ACL snapshot refuses ambiguous relations and unbounded or extra metadata', () => {
  assert.equal(relationAclSnapshotSchema.safeParse([row]).success, true);
  for (const value of [[row, row], [{ ...row, name: 'public.example' }], [{ ...row, kind: 'f' }], [{ ...row, injected: true }], [{ ...row, acl: ['x'.repeat(1025)] }]])
    assert.equal(relationAclSnapshotSchema.safeParse(value).success, false);
});

// Opt in to the already retained, isolated restore copy. No new database or
// cluster is created, and all fixture DDL/data is rolled back in the finalizer.
test('actual PostgreSQL preserves explicit defaults and rejects changed privileges before repair', {
  skip: !process.env.DYNA_ACL_MAIN_LOCATOR || !process.env.DYNA_ACL_RESTORE_RECEIPT,
}, async t => {
  const locator = JSON.parse(await readFile(process.env.DYNA_ACL_MAIN_LOCATOR!, 'utf8'));
  const selection = JSON.parse(await readFile(locator.selectionPath, 'utf8'));
  const receipt = JSON.parse(await readFile(process.env.DYNA_ACL_RESTORE_RECEIPT!, 'utf8'));
  const database = receipt.result.database;
  assert.match(database, /^dynaminds_restore_[a-f0-9]{16}$/);
  const url = new URL(selection.databaseUrl);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.notEqual(url.pathname.slice(1), database);
  url.pathname = '/' + database;
  const client = new pg.Client({ connectionString: url.href });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'");
    await client.query('CREATE TABLE public.qa_recovery_acl_proof(id integer PRIMARY KEY)');
    await client.query('INSERT INTO public.qa_recovery_acl_proof VALUES(7)');
    await client.query('GRANT ALL PRIVILEGES ON TABLE public.qa_recovery_acl_proof TO postgres');
    const expected = await captureRelationAclSnapshot(client);
    assert.equal(expected.find(r => r.name === 'qa_recovery_acl_proof')?.explicit, true);
    await client.query('DROP TABLE public.qa_recovery_acl_proof');
    await client.query('CREATE TABLE public.qa_recovery_acl_proof(id integer PRIMARY KEY)');
    await client.query('INSERT INTO public.qa_recovery_acl_proof VALUES(7)');
    await t.test('restores a default-equivalent physical ACL without changing data or effective rights', async () => {
      const before = await captureRelationAclSnapshot(client);
      const target = before.find(r => r.name === 'qa_recovery_acl_proof')!;
      assert.equal(target.explicit, false);
      assert.equal(await restoreRelationAclSnapshot(client, expected), 1);
      assert.deepEqual(await captureRelationAclSnapshot(client), expected);
      assert.deepEqual((await client.query('SELECT * FROM public.qa_recovery_acl_proof')).rows, [{ id: 7 }]);
      assert.deepEqual(expected.find(r => r.name === target.name)?.acl, target.acl);
      assert.equal(await restoreRelationAclSnapshot(client, expected), 0);
    });
    for (const [label, sql] of [
      ['additional application grant', 'GRANT SELECT ON TABLE public.qa_recovery_acl_proof TO dyna_app'],
      ['changed owner', 'ALTER TABLE public.qa_recovery_acl_proof OWNER TO dyna_app'],
      ['changed row security', 'ALTER TABLE public.qa_recovery_acl_proof ENABLE ROW LEVEL SECURITY'],
      ['extra relation', 'CREATE TABLE public.qa_recovery_acl_extra(id integer)'],
      ['missing relation', 'DROP TABLE public.qa_recovery_acl_proof'],
    ]) await t.test('refuses ' + label + ' without repairing it', async () => {
      await client.query('SAVEPOINT negative_case');
      await client.query(sql);
      const before = await captureRelationAclSnapshot(client);
      await assert.rejects(restoreRelationAclSnapshot(client, expected));
      assert.deepEqual(await captureRelationAclSnapshot(client), before);
      await client.query('ROLLBACK TO SAVEPOINT negative_case');
    });
    await t.test('refuses to erase an explicit default omitted from metadata', async () => {
      const changed = expected.map(r => r.name === 'qa_recovery_acl_proof' ? { ...r, explicit: false } : r);
      await assert.rejects(restoreRelationAclSnapshot(client, changed));
      assert.deepEqual(await captureRelationAclSnapshot(client), expected);
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
    url.password = '';
  }
});
