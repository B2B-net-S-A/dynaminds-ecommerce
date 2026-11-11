import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, pool } from '../server/db';
import { inboundAvailable } from '../server/email-inbound';
import { Problem } from '../server/errors';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL ?? '').pathname, /^\/dynaminds_test_\d+$/);
before(() => migrate());
after(() => pool.end());
const tables = [
  'accounts',
  'acquisitions',
  'sources',
  'previews',
  'messages',
  'bindings',
  'reply_previews',
  'replies',
  'operations',
  'admissions',
].map((s) => 'email_inbound_' + s);
test('real SQL141 installs idempotently with forced tenant RLS and no direct app access', async () => {
  await migrate();
  assert.equal(await inboundAvailable(), true);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM migrations WHERE name='141_email_inbound'"))
      .rows[0].n,
    1,
  );
  for (const table of tables) {
    const result = (
      await pool.query(
        "SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('dyna_app',oid,'SELECT,INSERT,UPDATE,DELETE') direct FROM pg_class WHERE oid=$1::regclass",
        [table],
      )
    ).rows[0];
    assert.deepEqual(result, { relrowsecurity: true, relforcerowsecurity: true, direct: false });
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM pg_constraint WHERE conrelid=$1::regclass AND NOT convalidated',
          [table],
        )
      ).rows[0].n,
      0,
    );
  }
  const funcs = (
    await pool.query(
      "SELECT oid::regprocedure::text name,prosecdef,proconfig,EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_exec FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'email_inbound_%'",
    )
  ).rows;
  assert(funcs.length >= 20);
  for (const fn of funcs) {
    assert.equal(fn.public_exec, false, fn.name);
    if (fn.prosecdef) assert(fn.proconfig.includes('search_path=pg_catalog, public'), fn.name);
  }
});
test('disabled storage guard and missing called helper fail closed instead of partial availability', async () => {
  const c = await pool.connect();
  try {
    for (const statement of [
      'ALTER TABLE email_inbound_accounts DISABLE TRIGGER email_inbound_row_guard',
      'DROP FUNCTION email_inbound_import_reference(uuid,uuid,uuid)',
    ]) {
      await c.query('BEGIN');
      try {
        await c.query(statement);
        await assert.rejects(inboundAvailable(c), (e) => e instanceof Problem && e.status === 503);
      } finally {
        await c.query('ROLLBACK');
      }
      assert.equal(await inboundAvailable(c), true);
    }
  } finally {
    c.release();
  }
});
