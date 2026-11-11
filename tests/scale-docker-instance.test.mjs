// Second dedicated scale instance next to dyna-scale-pg18 (tools/scale/docker/scale-pg.sh `config`).
// Offline: `docker compose config` only interpolates the file; nothing is built, started or read.
// Run: node --test tests/scale-docker-instance.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../tools/scale/docker/scale-pg.sh', import.meta.url));
const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

function config(env) {
  const state = mkdtempSync(join(tmpdir(), 'scale-instance-'));
  try {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SCALE_')));
    const r = spawnSync('bash', [SCRIPT, 'config'], { encoding: 'utf8', env: { ...base, SCALE_PG_STATE: state, ...env } });
    const [head, ...rest] = r.stdout.split('\n');
    const instance = r.status === 0 ? JSON.parse(head) : null;
    const compose = r.status === 0 ? JSON.parse(rest.join('\n')) : null;
    // `config` resolves names only; it must not create the state (password, local config).
    return { status: r.status, stderr: r.stderr, instance, compose, wroteState: existsSync(join(state, 'secrets')) };
  } finally { rmSync(state, { recursive: true, force: true }); }
}

test('default instance keeps its names: project dyna-scale-pg, container dyna-scale-pg18, port 57090', { skip: !docker }, () => {
  const r = config({});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.instance, { container: 'dyna-scale-pg18', project: 'dyna-scale-pg', generator: 'dyna-scale-gen', vacuum: 'dyna-scale-vacuum', port: '57090' });
  assert.equal(r.compose.name, 'dyna-scale-pg');
  assert.equal(r.compose.services.pg.container_name, 'dyna-scale-pg18');
  assert.deepEqual(Object.values(r.compose.volumes).map((v) => v.name).sort(), ['dyna-scale-pg18-data', 'dyna-scale-pg18-wal-archive']);
  assert.equal(r.compose.services.pg.ports[0].published, '57090');
  assert.equal(r.wroteState, false);
});

test('a second instance gets its own project, container, volumes, generator name and port', { skip: !docker }, () => {
  const r = config({ SCALE_PG_CONTAINER: 'dyna-scale-full-pg18', SCALE_PG_PORT: '57091' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.instance, { container: 'dyna-scale-full-pg18', project: 'dyna-scale-full-pg18', generator: 'dyna-scale-full-gen', vacuum: 'dyna-scale-full-vacuum', port: '57091' });
  assert.equal(r.compose.name, 'dyna-scale-full-pg18');
  assert.equal(r.compose.services.pg.container_name, 'dyna-scale-full-pg18');
  assert.deepEqual(Object.values(r.compose.volumes).map((v) => v.name).sort(), ['dyna-scale-full-pg18-data', 'dyna-scale-full-pg18-wal-archive']);
  assert.equal(r.compose.services.pg.ports[0].published, '57091');
});

test('a second instance refuses the first instance port 57090 and the reserved ports', { skip: !docker }, () => {
  for (const port of ['57090', '4100', '5432', '57084']) {
    const r = config({ SCALE_PG_CONTAINER: 'dyna-scale-full-pg18', SCALE_PG_PORT: port });
    assert.notEqual(r.status, 0, port);
    assert.match(r.stderr, /port/);
  }
});

test('container names outside dyna-scale-* are refused (never another stack)', { skip: !docker }, () => {
  for (const name of ['nexus-staging-postgres-1', 'dyna-scale-', 'dyna-scale-X', 'dyna-scale-a;b']) {
    const r = config({ SCALE_PG_CONTAINER: name, SCALE_PG_PORT: '57091' });
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /container/);
  }
});

// vacuum-loop: periodic VACUUM (ANALYZE) while the simulated clock keeps autovacuum from running. Its arguments
// are checked before docker is called, so a refusal starts nothing.
test('vacuum-loop refuses a database outside dynaminds_scale_* and an interval under 60 s', () => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SCALE_')));
  const env = { ...base, SCALE_PG_CONTAINER: 'dyna-scale-full-pg18', SCALE_PG_PORT: '57091', SCALE_PG_STATE: tmpdir() };
  for (const args of [['dynaminds'], ['postgres', '600'], ['dynaminds_scale_20261029_01', '30'], ['dynaminds_scale_20261029_01', '10m']]) {
    const r = spawnSync('bash', [SCRIPT, 'vacuum-loop', ...args], { encoding: 'utf8', env });
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, /scale-pg: (database|interval)/, args.join(' '));
  }
});

// netns-node passes the release app's per-address limit (DYNA_RATE_LIMIT_PER_MIN, server/rate-limit-config.ts)
// only when it is set. A fake `docker` first on PATH prints its arguments; no container is started.
test('netns-node passes DYNA_RATE_LIMIT_PER_MIN to the generator container only when set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-netns-'));
  try {
    mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'state', 'secrets', 'postgres.password'), 'synthetic\n', { mode: 0o600 });
    writeFileSync(join(dir, 'bin', 'docker'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SCALE_') && k !== 'DYNA_RATE_LIMIT_PER_MIN'));
    const env = { ...base, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, SCALE_PG_STATE: join(dir, 'state') };
    const args = (extra) => {
      const r = spawnSync('bash', [SCRIPT, 'netns-node', 'dynaminds_scale_20261029_01', 'x.mjs'], { encoding: 'utf8', env: { ...env, ...extra } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.split('\n');
    };
    const unset = args({});
    assert(unset.includes('DYNA_WORKER_DISABLED=true') && !unset.some((a) => a.startsWith('DYNA_RATE_LIMIT_PER_MIN')));
    const set = args({ DYNA_RATE_LIMIT_PER_MIN: '1200' });
    // `-e NAME` without a value: docker takes it from this environment, so the value is never on the command line.
    assert.equal(set[set.indexOf('DYNA_RATE_LIMIT_PER_MIN') - 1], '-e');
    assert.equal(set.filter((a) => a.startsWith('DYNA_RATE_LIMIT_PER_MIN')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
