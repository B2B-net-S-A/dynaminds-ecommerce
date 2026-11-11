/** CI only: applies the release migrations to DATABASE_URL (the per-run template, scripts/ci/run-tests.mjs). */
import { migrate, pool } from '../../server/db';

const started = Date.now();
try {
  await migrate();
  console.log(`migrate() ${Date.now() - started} ms`);
} finally {
  await pool.end();
}
