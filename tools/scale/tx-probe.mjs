#!/usr/bin/env node
// Fixed cost of one ordinary tenantTx (body: SELECT 1, nothing written) on a scale clone, plus the plain
// round trip of the same pool, so the per-transaction schema preflight of the source runtime and the
// network path can be told apart. Same environment as generate.mjs (DATABASE_URL, DYNA_LOCAL_CONFIG_PATH).
//
//   source:  node node_modules/tsx/dist/cli.mjs tools/scale/tx-probe.mjs [--n 10]
//   release: tools/scale/docker/scale-pg.sh netns-node <db> tools/scale/tx-probe.mjs --release <release-build.json> [--n 10]
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openRuntime } from './writer.mjs';

const { values: a } = parseArgs({ options: { release: { type: 'string' }, n: { type: 'string', default: '10' } } });
if (!/^dynaminds_scale_[0-9]{8}_[0-9]{2}$/.test(new URL(process.env.DATABASE_URL ?? 'invalid://x').pathname.slice(1))) throw new Error('scale clone only');
const t0 = performance.now();
const rt = await openRuntime({ connections: 2, release: a.release ? resolve(a.release) : undefined });
const openMs = performance.now() - t0;
const tenant = (await rt.db.pool.query('SELECT id FROM tenants ORDER BY created_at, id LIMIT 1')).rows[0].id;
const time = async (fn) => { const s = performance.now(); await fn(); return Math.round((performance.now() - s) * 10) / 10; };
const tx = [], rtt = [];
for (let i = 0; i < Number(a.n); i++) {
  tx.push(await time(() => rt.db.tenantTx(tenant, (c) => c.query('SELECT 1'))));
  rtt.push(await time(() => rt.db.pool.query('SELECT 1')));
}
const stat = (v) => { const s = [...v].sort((x, y) => x - y); return { min: s[0], median: s[s.length >> 1], max: s.at(-1) }; };
console.log(JSON.stringify({ runtime: rt.release ? 'release' : 'source', release: rt.release ?? null, open_ms: Math.round(openMs),
  empty_tenant_tx_ms: { ...stat(tx), samples: tx }, pool_select1_ms: stat(rtt) }));
await rt.close();
