// The 16 guards on the demo database, in one read-only transaction (tools/demo/demo.sh guards).
// Same set as the load-test reconciliation (tools/scale/load/lib.mjs RECONCILE_GUARDS) plus manual_off_verdict_valid.
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { RECONCILE_GUARDS } from '../scale/load/lib.mjs';

export const DEMO_GUARDS = [...RECONCILE_GUARDS, 'manual_off_verdict_valid'];

export async function demoGuards(url) {
  const c = new pg.Client({ connectionString: url, options: '-c jit=off -c timezone=UTC' });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query("SET LOCAL statement_timeout='120s'");
    const values = {};
    for (const g of DEMO_GUARDS) values[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v;
    await c.query('ROLLBACK');
    return { values, all_true: Object.values(values).every((v) => v === true), count: DEMO_GUARDS.length };
  } finally { await c.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await demoGuards(process.env.DATABASE_URL);
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.all_true ? 0 : 1);
}
