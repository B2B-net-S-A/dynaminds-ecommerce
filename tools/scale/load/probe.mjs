#!/usr/bin/env node
// Business readiness of one fresh release CLI (profile timing.cold.scope: "one successful authenticated ordinary read
// plus worker eligibility; readiness HTTP 200 alone is insufficient"). Runs in the database container's network
// namespace like the CLI; started by run.mjs right after the CLI's ORDINARY_LOCAL_APP_LISTENING line.
//   /api/health → 200 and scoped_automation_enabled (the process's scoped worker runs the run's rules)
//   GET /api/orders?limit=1 with each tenant owner's session → 200 (sessions of setup.mjs, never printed)
//
//   node tools/scale/load/probe.mjs <sessions.private.json> <port>
import { readFileSync } from 'node:fs';

const [sessionsFile, port] = process.argv.slice(2);
const origin = `http://127.0.0.1:${Number(port)}`;
const sessions = JSON.parse(readFileSync(sessionsFile, 'utf8'));
const out = { health_status: null, scoped_automation_enabled: null, reads: {} };
try {
  const h = await fetch(`${origin}/api/health`); out.health_status = h.status;
  const j = await h.json().catch(() => null); out.scoped_automation_enabled = j?.scoped_automation_enabled ?? null;
  for (const t of sessions.tenants) {
    const r = await fetch(`${origin}/api/orders?limit=1`, { headers: { cookie: t.cookie } });
    await r.arrayBuffer(); out.reads[t.slot] = r.status;
  }
} catch (e) { out.error = String(e.message).slice(0, 200); }
process.stdout.write(JSON.stringify(out) + '\n');
