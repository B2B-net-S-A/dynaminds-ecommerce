import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {SLOTS, PORTS, resolveIndexes, validateResolved, materializeCompose, verifyPreparedConfiguration, usage, checkBudget, MIN_FREE_BYTES, MAX_BYTES,
  localBuildsFor, forwarderConfig, forwarderArgs, storeBindings} from '../tools/local/official-woo/operator.mjs';

// Pure contract/filesystem tests. OCI bytes below are SYNTHETIC, never a release lock.
const ids = ['wordpress', 'cli', 'database', 'tls'];
const sha = b => createHash('sha256').update(b).digest('hex');
function fixtures(change = x => x) {
  return Object.fromEntries(ids.map((id, i) => [id, Buffer.from(JSON.stringify(change({schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
    {mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:' + String(i + 1).repeat(64), size: 1000, platform: {architecture: 'arm64', os: 'linux', variant: 'v8'}},
    {mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:' + 'a'.repeat(64), size: 1000, platform: {architecture: 'amd64', os: 'linux'}},
  ]}, id)))]));
}
test('shipped lock reproduces the committed official indexes; an unresolved lock cannot authorize image use', async () => {
  const lock = JSON.parse(await fs.readFile(new URL('../tools/local/official-woo/images.lock.json', import.meta.url)));
  const observed = Object.fromEntries(await Promise.all(ids.map(async id => [id, await fs.readFile(new URL(`../tools/local/official-woo/manifests/${id}.index.json`, import.meta.url))])));
  assert.equal(validateResolved(lock, observed), lock);
  assert.deepEqual(lock.images.map(i => i.tag), ['wordpress:7.1.3-php8.3-apache', 'wordpress:cli-2.12.0-php8.3', 'mariadb:11.4.13', 'nginx:1.30.6-alpine']);
  for (const image of lock.images) { assert.match(image.digest, /^sha256:[a-f0-9]{64}$/); assert.equal(image.index_sha256, sha(observed[image.id])); }
  const unresolved = {...structuredClone(lock), status: 'unresolved_no_pull_or_start', images: lock.images.map(i => ({id: i.id, tag: i.tag, digest: null}))};
  assert.throws(() => validateResolved(unresolved, observed), /unresolved/);
  assert.throws(() => materializeCompose('/owned', unresolved, {}), /unresolved/);
});
test('lock is reconstructed from exact arm64 descriptor and whole actual index bytes', () => {
  const indexes = fixtures(), before = Object.fromEntries(ids.map(id => [id, Buffer.from(indexes[id])]));
  const lock = resolveIndexes(indexes, '2026-10-18T20:00:00Z');
  for (const [i, image] of lock.images.entries()) {
    assert.equal(image.platform, 'linux/arm64'); assert.equal(image.digest, 'sha256:' + String(i + 1).repeat(64));
    assert.equal(image.index_sha256, sha(indexes[image.id])); assert.equal(image.index_bytes, indexes[image.id].length);
    assert.deepEqual(indexes[image.id], before[image.id]);
  }
  assert.equal(validateResolved(lock, indexes), lock);
  const tampered = structuredClone(lock); tampered.images[0].digest = 'sha256:' + 'f'.repeat(64);
  assert.throws(() => validateResolved(tampered, indexes), /exact official-index/);
  const differentIndex = fixtures(x => ({...x, annotations: {changed: 'yes'}}));
  assert.throws(() => validateResolved(lock, differentIndex), /exact official-index/);
});
test('missing, duplicate, wrong-platform, malformed and unbounded indexes refuse', () => {
  const when = '2026-10-18T20:00:00Z';
  for (const mutate of [x => ({...x, manifests: x.manifests.slice(1)}), x => ({...x, manifests: [...x.manifests, x.manifests[0]]}), x => ({...x, manifests: [{...x.manifests[0], platform: {architecture: 'arm64', os: 'windows'}}]}), x => ({...x, manifests: [{...x.manifests[0], digest: 'latest'}]}), x => ({...x, mediaType: 'text/html'})]) {
    assert.throws(() => resolveIndexes(fixtures(mutate), when));
  }
  assert.throws(() => resolveIndexes({...fixtures(), extra: Buffer.from('{}')}, when));
  assert.throws(() => resolveIndexes({...fixtures(), cli: Buffer.alloc(1024 ** 2 + 1)}, when));
  assert.throws(() => resolveIndexes(fixtures(), 'not a date'));
});
test('standard Compose has five isolated stores and only five loopback TLS ports', async () => {
  // JSON is valid YAML 1.2, deliberately avoiding another parser dependency.
  const compose = JSON.parse(await fs.readFile(new URL('../tools/local/official-woo/compose.yaml', import.meta.url)));
  assert.equal(SLOTS.length, 5); assert.deepEqual(PORTS, [18443, 18444, 18445, 18446, 18447]);
  assert.equal(compose.networks.owned.internal, true);
  // Docker publishes no port of a container that is only on an internal network (observed 30.10.2026: the edge had
  // no binding). Only the TLS edge also joins the non-internal `edge` network; WordPress/MariaDB/CLI stay internal.
  assert.deepEqual(Object.keys(compose.networks).sort(), ['edge', 'owned']); assert.equal(compose.networks.edge.internal, false);
  for (const [name, service] of Object.entries(compose.services)) assert.deepEqual(service.networks, name === 'tls' ? ['owned', 'edge'] : ['owned'], name);
  const ports = Object.values(compose.services).flatMap(s => s.ports ?? []);
  assert.deepEqual(ports, PORTS.map(p => `127.0.0.1:${p}:${p}`));
  assert(!ports.some(p => /:(8443|8444|4105|57083):/.test(p)));
  const dbNames = new Set(), dbUsers = new Set(), sites = new Set();
  for (const slot of SLOTS) {
    const wp = compose.services['wp-' + slot], cli = compose.services['cli-' + slot];
    assert.equal(wp.platform, 'linux/arm64'); assert.equal(cli.platform, 'linux/arm64');
    assert.deepEqual(wp.networks, ['owned']); assert.equal(wp.depends_on.database.condition, 'service_healthy');
    assert.deepEqual(cli.profiles, ['tools']);
    dbNames.add(wp.environment.WORDPRESS_DB_NAME); dbUsers.add(wp.environment.WORDPRESS_DB_USER); sites.add(wp.volumes[0]);
    assert.equal(wp.secrets[0].source, 'db_' + slot); assert.equal(cli.secrets[0].source, 'db_' + slot);
    assert(wp.environment.WORDPRESS_CONFIG_EXTRA.includes("define('WP_HTTP_BLOCK_EXTERNAL',true)"));
    assert(wp.environment.WORDPRESS_CONFIG_EXTRA.includes("define('DISABLE_WP_CRON',true)"));
    assert(!('WORDPRESS_DB_PASSWORD' in wp.environment));
    assert(wp.environment.WORDPRESS_CONFIG_EXTRA.includes('$$_SERVER'), 'PHP variables must survive Compose interpolation');
    assert(wp.entrypoint[2].includes('$$(cat'), 'shell substitution must survive Compose interpolation');
    assert(cli.entrypoint[2].includes('"$$@"'), 'CLI arguments remain separate after Compose interpolation');
    assert(!JSON.stringify(wp).includes('NODE_TLS_REJECT_UNAUTHORIZED'));
  }
  assert.equal(dbNames.size, 5); assert.equal(dbUsers.size, 5); assert.equal(sites.size, 5);
  for (const service of Object.values(compose.services)) {
    assert.match(service.image, /\$\{[A-Z_]+:\?Actual arm64 manifest lock required\}/);
    assert.equal(service.logging.options['max-size'], '2m'); assert.equal(service.logging.options['max-file'], '2');
    assert.ok(service.mem_limit); assert.ok(service.cpus > 0);
  }
});
test('disk budget accounts actual files, image sizes, writable layers and free-space admission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyna-woo-contract-'));
  try {
    await fs.mkdir(root + '/data'); await fs.writeFile(root + '/fixture.bin', Buffer.alloc(8193)); await fs.writeFile(root + '/data/db.bin', Buffer.alloc(4097));
    const all = await usage(root), withoutData = await usage(root, true);
    assert.equal(all.logical, 12290); assert.equal(withoutData.logical, 8193); assert(all.allocated > 0);
    const result = checkBudget({...all, free: MIN_FREE_BYTES, imageBytes: 100, writableBytes: 200});
    assert.equal(result.budgeted_total_bytes, Math.max(all.logical, all.allocated) + 100 + 200 + 32 * 1024 ** 2);
    assert.throws(() => checkBudget({...all, free: MIN_FREE_BYTES - 1}), /30 GiB/);
    assert.throws(() => checkBudget({...all, free: MIN_FREE_BYTES, imageBytes: MAX_BYTES}), /12 GiB/);
    assert.throws(() => checkBudget({...all, free: MIN_FREE_BYTES, imageBytes: 0, writableBytes: MAX_BYTES}), /12 GiB/);
    await fs.symlink(root + '/fixture.bin', root + '/link'); await assert.rejects(usage(root), /symlinks/);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});
test('whole literal prepared configuration binds image, project, ports and volumes before Docker access', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyna-woo-materialized-'));
  try {
    const indexes = fixtures(), lock = resolveIndexes(indexes, '2026-10-18T20:00:00Z');
    const template = JSON.parse(await fs.readFile(new URL('../tools/local/official-woo/compose.yaml', import.meta.url)));
    const compose = materializeCompose(root, lock, template);
    assert.equal(compose.name, 'dyna-woo-' + sha(root).slice(0, 12));
    assert.equal(compose.services['wp-a'].image, 'wordpress:7.1.3-php8.3-apache@' + lock.images[0].digest);
    assert.equal(compose.services['wp-a'].volumes[0], root + '/data/wp-a:/var/www/html');
    assert(!JSON.stringify(compose).includes('${'));
    await fs.mkdir(root + '/manifests');
    for (const id of ids) await fs.writeFile(root + '/manifests/' + id + '.index.json', indexes[id]);
    await fs.writeFile(root + '/images.resolved.lock.private.json', JSON.stringify(lock));
    await fs.writeFile(root + '/compose.resolved.private.json', JSON.stringify(compose));
    const names = ['WORDPRESS_IMAGE', 'WPCLI_IMAGE', 'MARIADB_IMAGE', 'NGINX_IMAGE'];
    const env = `DYNA_WOO_ROOT=${root}\nCOMPOSE_PROJECT_NAME=${compose.name}\n` + lock.images.map((i, n) => `${names[n]}=${i.tag}@${i.digest}\n`).join('');
    await assert.rejects(verifyPreparedConfiguration(root), {code: 'ENOENT'});
    await fs.writeFile(root + '/env.private', env.replace(compose.name, 'unrelated-project'));
    await assert.rejects(verifyPreparedConfiguration(root), /exact own project/);
    await fs.writeFile(root + '/env.private', env);
    assert.deepEqual((await verifyPreparedConfiguration(root)).compose, compose);
    for (const mutate of [c => { c.name = 'other-project'; }, c => { c.services['wp-a'].image = 'wordpress:latest'; }, c => { c.services.tls.ports[0] = '0.0.0.0:8443:18443'; }, c => { c.services['wp-a'].volumes[0] = '/foreign:/var/www/html'; }, c => { c.extra = true; }]) {
      const changed = structuredClone(compose); mutate(changed);
      await fs.writeFile(root + '/compose.resolved.private.json', JSON.stringify(changed));
      await assert.rejects(verifyPreparedConfiguration(root), /whole resolved Compose/);
    }
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});
test('local-builds root is the workspace sibling from the main checkout and from a .claude worktree', () => {
  assert.equal(localBuildsFor('/w/DYNA Ecomerce/development/full-base/tools/local/official-woo'), '/w/DYNA Ecomerce/local-builds');
  assert.equal(localBuildsFor('/w/DYNA Ecomerce/development/full-base/.claude/worktrees/agent-1/tools/local/official-woo'), '/w/DYNA Ecomerce/local-builds');
  assert.equal(localBuildsFor('/w/DYNA Ecomerce/development/full-base/worktrees/agent-1/tools/local/official-woo'), '/w/DYNA Ecomerce/development/full-base/local-builds', 'only .claude/worktrees is a worktree of the checkout');
});
test('namespace forwarder: TCP only, loopback listeners, same port on the host edge, pinned image, bounded container', () => {
  const conf = forwarderConfig([18443, 18444]);
  assert.match(conf, /^stream \{/m); assert.doesNotMatch(conf, /\bhttp\s*\{/); assert.doesNotMatch(conf, /\bssl\b/);
  assert.deepEqual([...conf.matchAll(/listen ([^;]+);/g)].map(m => m[1]), ['127.0.0.1:18443', '127.0.0.1:18444']);
  assert.deepEqual([...conf.matchAll(/proxy_pass ([^;]+);/g)].map(m => m[1]), ['host.docker.internal:18443', 'host.docker.internal:18444']);
  for (const bad of [[], [8443], [18448], [18443, 18443], [18443, 18444, 18445, 18446, 18447, 18443]]) assert.throws(() => forwarderConfig(bad));
  const lock = resolveIndexes(fixtures(), '2026-10-18T20:00:00Z');
  const args = forwarderArgs('/x/local-builds/official-woo-scale-t', lock, 'dyna-scale-full-pg18', [18443, 18444]);
  assert.equal(args[0], 'run'); assert(args.includes('--read-only')); assert(args.includes('container:dyna-scale-full-pg18'));
  assert.equal(args.at(-1), 'nginx:1.30.6-alpine@' + lock.images[3].digest);
  assert(args.includes('/x/local-builds/official-woo-scale-t/config/netns-forward-dyna-scale-full-pg18.conf:/etc/nginx/nginx.conf:ro'));
  assert(!args.some(a => /^-p$|--publish|--privileged|host$/.test(a)));
  assert(args.includes('no-new-privileges:true')); assert.deepEqual(args.filter((x, i) => args[i - 1] === '--cap-add'), ['SETUID', 'SETGID']); assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  for (const c of ['dyna-scale-pg18x;', 'other-pg18', 'dyna-scale-full', '../dyna-scale-full-pg18']) assert.throws(() => forwarderArgs('/x/local-builds/official-woo-scale-t', lock, c, [18443]));
});
test('store bindings pin CA and both REST key files of owned stores; malformed or shared keys refuse', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyna-woo-bindings-'));
  try {
    await fs.mkdir(root + '/secrets', {mode: 0o700});
    const ca = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'; await fs.writeFile(root + '/secrets/ca.pem', ca, {mode: 0o600});
    const key = (c, n) => JSON.stringify({consumer_key: 'ck_' + c.repeat(40), consumer_secret: 'cs_' + n.repeat(40)});
    const keys = {importer_a: key('1', '2'), producer_a: key('3', '4'), importer_b: key('5', '6'), producer_b: key('7', '8')};
    for (const [name, body] of Object.entries(keys)) await fs.writeFile(`${root}/secrets/rest_${name}.json`, body, {mode: 0o600});
    const b = await storeBindings(root, ['a', 'b']);
    assert.equal(b.schema, 'dynaminds-official-woo-store-bindings/v1');
    assert.deepEqual(b.stores.map(s => [s.slot, s.origin]), [['a', 'https://localhost:18443'], ['b', 'https://localhost:18444']]);
    assert.deepEqual(b.stores[0].ca, {path: root + '/secrets/ca.pem', sha256: sha(ca)});
    assert.deepEqual(b.stores[1].importer, {path: root + '/secrets/rest_importer_b.json', sha256: sha(keys.importer_b)});
    assert.deepEqual(b.stores[1].producer, {path: root + '/secrets/rest_producer_b.json', sha256: sha(keys.producer_b)});
    assert(!JSON.stringify(b).includes('ck_1'), 'bindings carry paths and digests, never key values');
    await assert.rejects(storeBindings(root, ['a', 'a'])); await assert.rejects(storeBindings(root, ['f']));
    await fs.writeFile(root + '/secrets/rest_producer_b.json', keys.importer_b, {mode: 0o600});
    await assert.rejects(storeBindings(root, ['a', 'b']), /distinct/);
    await fs.writeFile(root + '/secrets/rest_producer_b.json', '{"consumer_key":"ck_x","consumer_secret":"cs_y"}', {mode: 0o600});
    await assert.rejects(storeBindings(root, ['a', 'b']), /REST key/);
    await fs.writeFile(root + '/secrets/rest_producer_b.json', keys.producer_b); await fs.chmod(root + '/secrets/rest_producer_b.json', 0o644);
    await assert.rejects(storeBindings(root, ['a', 'b']), /0600/);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});
