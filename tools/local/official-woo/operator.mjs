/** File-only preparation/validation (prepare, resolve, preflight, budget, bindings). Never pulls images or installs
 * WordPress. Two explicit Docker commands after review: `keys` (one REST key through official WP-CLI inside the owned
 * CLI container), `forward` (TCP forwarder inside a scale database container's network namespace) and `renew-tls`
 * (new CA and `localhost` certificate from the same keys, restart of the TLS edge only). */
import assert from 'node:assert/strict';
import fs, {constants} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomBytes, X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `local-builds` beside `development/`: from the checkout `<ws>/development/full-base` and from its git worktrees
 * `<ws>/development/full-base/.claude/worktrees/<name>` (same owned root for both). */
export function localBuildsFor(here) {
  const repo = path.resolve(here, '../../..'), parent = path.dirname(repo);
  const owner = path.basename(parent) === 'worktrees' && path.basename(path.dirname(parent)) === '.claude' ? path.dirname(path.dirname(parent)) : repo;
  return path.resolve(owner, '../../local-builds');
}
const BASE = localBuildsFor(HERE);
export const SLOTS = Object.freeze(['a', 'b', 'c', 'd', 'e']);
export const PORTS = Object.freeze(SLOTS.map((_, i) => 18443 + i));
export const MAX_BYTES = 12 * 1024 ** 3, MIN_FREE_BYTES = 30 * 1024 ** 3;
const IMAGE_RESERVE = 3 * 1024 ** 3, LOG_RESERVE = 32 * 1024 ** 2;
const sha = b => createHash('sha256').update(b).digest('hex');
const json = x => JSON.stringify(x, null, 2) + '\n';
const baseLock = JSON.parse(await fs.readFile(HERE + '/images.lock.json', 'utf8'));
export function resolveIndexes(indexes, observedAt) {
  assert(Number.isFinite(Date.parse(observedAt)), 'actual observation timestamp required');
  assert.deepEqual(Object.keys(indexes).sort(), baseLock.images.map(i => i.id).sort(), 'exact four official image indexes required');
  const images = baseLock.images.map(image => {
    const raw = indexes[image.id]; assert(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 1024 ** 2, 'bounded actual index required');
    const index = JSON.parse(raw.toString('utf8'));
    assert.equal(index.schemaVersion, 2); assert(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].includes(index.mediaType));
    assert(Array.isArray(index.manifests), 'multi-platform official index required');
    const matches = index.manifests.filter(m => m.platform?.os === 'linux' && m.platform?.architecture === 'arm64' && (!m.platform.variant || m.platform.variant === 'v8'));
    assert.equal(matches.length, 1, 'exactly one linux/arm64 manifest required');
    assert(/^sha256:[a-f0-9]{64}$/.test(matches[0].digest), 'actual manifest digest required');
    assert(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(matches[0].mediaType));
    return {...image, digest: matches[0].digest, index_sha256: sha(raw), index_bytes: raw.length,
      source: 'docker.io/library/' + image.tag, platform: 'linux/arm64'};
  });
  return {...baseLock, status: 'root_observed_official_indexes_resolved', observed_at: observedAt, images};
}
export function validateResolved(lock, indexes) {
  assert.equal(lock.status, 'root_observed_official_indexes_resolved', 'unresolved images: no pull/start');
  assert.deepEqual(lock, resolveIndexes(indexes, lock.observed_at), 'lock must reproduce exact official-index observations');
  return lock;
}
export async function usage(root, skipData = false) {
  let logical = 0, allocated = 0;
  async function visit(p) {
    const s = await fs.lstat(p); assert(!s.isSymbolicLink(), 'no symlinks in owned data root');
    if (s.isDirectory()) { for (const name of await fs.readdir(p)) if (!(skipData && p === root && name === 'data')) await visit(path.join(p, name)); }
    else { assert(s.isFile() && s.nlink === 1, 'regular unshared owned files required'); logical += s.size; allocated += s.blocks * 512; }
  }
  await visit(root); return {logical, allocated};
}
export function checkBudget({logical, allocated, free, imageBytes = IMAGE_RESERVE, writableBytes = 0}) {
  for (const n of [logical, allocated, free, imageBytes, writableBytes]) assert(Number.isSafeInteger(n) && n >= 0);
  const total = Math.max(logical, allocated) + imageBytes + writableBytes + LOG_RESERVE;
  assert(total <= MAX_BYTES, 'owned Woo footprint exceeds 12 GiB budget');
  assert(free >= MIN_FREE_BYTES, 'keep at least 30 GiB free');
  return {data_logical_bytes: logical, data_allocated_bytes: allocated, image_bytes: imageBytes,
    container_writable_bytes: writableBytes, log_reserve_bytes: LOG_RESERVE, budgeted_total_bytes: total, free_bytes: free};
}
async function rootPath(root) {
  assert(path.isAbsolute(root) && path.resolve(root) === root && path.dirname(root) === BASE && /^official-woo-scale-[a-zA-Z0-9-]+$/.test(path.basename(root)), 'fresh owned local-builds root required');
  assert.equal(await fs.realpath(BASE), BASE);
  try {
    const s = await fs.lstat(root);
    assert(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700, 'owned private directory required');
    assert.equal(await fs.realpath(root), root);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function environment(root, lock) {
  assert(!/[\r\n#]/.test(root));
  const keys = {wordpress: 'WORDPRESS_IMAGE', cli: 'WPCLI_IMAGE', database: 'MARIADB_IMAGE', tls: 'NGINX_IMAGE'};
  return `DYNA_WOO_ROOT=${root}\nCOMPOSE_PROJECT_NAME=dyna-woo-${sha(root).slice(0, 12)}\n` + lock.images.map(i => `${keys[i.id]}=${i.tag}@${i.digest}\n`).join('');
}
export function materializeCompose(root, lock, template) {
  assert.equal(lock.status, 'root_observed_official_indexes_resolved', 'unresolved images: no Compose materialization');
  assert.deepEqual(lock.images.map(i => [i.id, i.tag]), baseLock.images.map(i => [i.id, i.tag]));
  for (const image of lock.images) assert(/^sha256:[a-f0-9]{64}$/.test(image.digest));
  const values = {
    '${DYNA_WOO_ROOT:?Run file-only prepare and resolve first}': root,
    '${COMPOSE_PROJECT_NAME:?Private owned project name required}': 'dyna-woo-' + sha(root).slice(0, 12),
  };
  const keys = {wordpress: 'WORDPRESS_IMAGE', cli: 'WPCLI_IMAGE', database: 'MARIADB_IMAGE', tls: 'NGINX_IMAGE'};
  for (const image of lock.images) values['${' + keys[image.id] + ':?Actual arm64 manifest lock required}'] = image.tag + '@' + image.digest;
  function render(v) {
    if (typeof v === 'string') { for (const [key, value] of Object.entries(values)) v = v.replaceAll(key, value); assert(!v.includes('${'), 'unresolved Compose value'); return v; }
    if (Array.isArray(v)) return v.map(render);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, render(value)]));
    return v;
  }
  return render(template);
}
export async function verifyPreparedConfiguration(root) {
  const lock = validateResolved(JSON.parse(await fs.readFile(root + '/images.resolved.lock.private.json', 'utf8')), await indexes(root));
  assert.equal(await fs.readFile(root + '/env.private', 'utf8'), environment(root, lock), 'exact own project and pinned images required');
  const compose = materializeCompose(root, lock, JSON.parse(await fs.readFile(HERE + '/compose.yaml', 'utf8')));
  assert.deepEqual(JSON.parse(await fs.readFile(root + '/compose.resolved.private.json', 'utf8')), compose, 'whole resolved Compose must reproduce pinned template, indexes and own root');
  return {lock, compose};
}
async function save(root, name, body) {
  const file = await fs.open(root + '/' + name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
  const dir = await fs.open(path.dirname(root + '/' + name), constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
}
async function budget(root, actualDocker = false) {
  const bytes = await usage(root, actualDocker), stat = await fs.statfs(root);
  let imageBytes = IMAGE_RESERVE, writableBytes = 0;
  if (actualDocker) {
    const {lock, compose} = await verifyPreparedConfiguration(root);
    const composeArgs = ['compose', '--project-name', compose.name, '-f', root + '/compose.resolved.private.json'];
    const images = JSON.parse(execFileSync('docker', ['image', 'inspect', ...lock.images.map(i => i.tag + '@' + i.digest)], {maxBuffer: 2 * 1024 ** 2, encoding: 'utf8'}));
    imageBytes = [...new Map(images.map(i => [i.Id, i.Size])).values()].reduce((a, b) => a + b, 0);
    const ids = execFileSync('docker', [...composeArgs, 'ps', '-q'], {encoding: 'utf8'}).trim().split(/\s+/).filter(Boolean);
    if (ids.length) writableBytes = JSON.parse(execFileSync('docker', ['container', 'inspect', '--size', ...ids], {maxBuffer: 2 * 1024 ** 2, encoding: 'utf8'})).reduce((sum, c) => sum + c.SizeRw, 0);
    // Files can belong to container UIDs. Read allocated data bytes inside the exact owned
    // running containers; never skip unreadable database directories or claim a mount quota.
    for (const [service, directory] of [['database', '/var/lib/mysql'], ...SLOTS.map(s => ['wp-' + s, '/var/www/html'])]) {
      const out = execFileSync('docker', [...composeArgs, 'exec', '-T', '--user', '0', service, 'du', '-sk', directory], {encoding: 'utf8', timeout: 9000, maxBuffer: 65536});
      const blocks = out.match(/^(\d+)\s+/)?.[1]; assert(blocks, 'actual owned container data size required');
      const allocated = Number(blocks) * 1024; bytes.logical += allocated; bytes.allocated += allocated;
    }
  }
  return checkBudget({...bytes, free: Number(stat.bavail) * Number(stat.bsize), imageBytes, writableBytes});
}
async function prepare(root, zip) {
  await rootPath(root);
  const source = await fs.lstat(zip); assert(source.isFile() && !source.isSymbolicLink() && source.nlink === 1);
  const plugin = await fs.readFile(zip); assert.equal(plugin.length, baseLock.plugin.bytes); assert.equal(sha(plugin), baseLock.plugin.sha256);
  const stat = await fs.statfs(BASE); assert(Number(stat.bavail) * Number(stat.bsize) - IMAGE_RESERVE >= MIN_FREE_BYTES, 'reserve image space and retain 30 GiB free');
  await fs.mkdir(root, {mode: 0o700});
  for (const name of ['secrets', 'config', 'vendor', 'manifests', 'data', ...SLOTS.map(s => 'data/wp-' + s), 'data/mariadb']) await fs.mkdir(root + '/' + name, {mode: 0o700});
  await save(root, 'attempt.private.json', json({schema: 'official-woo-preparation/v1', state: 'started', no_automatic_replay: true}));
  for (const name of ['db_root', ...SLOTS.flatMap(s => ['db_' + s, 'admin_' + s])]) await save(root, 'secrets/' + name, randomBytes(32).toString('hex') + '\n');
  await save(root, 'vendor/woocommerce.zip', plugin);
  await save(root, 'config/bootstrap.php', await fs.readFile(HERE + '/bootstrap.php'));
  await save(root, 'config/disable-external.php', "<?php\nadd_filter('pre_wp_mail','__return_false',PHP_INT_MAX);\n");
  await save(root, 'config/php.ini', 'memory_limit=256M\nmax_execution_time=30\n');
  await save(root, 'config/apache.conf', '<IfModule mpm_prefork_module>\nStartServers 1\nMinSpareServers 1\nMaxSpareServers 1\nMaxRequestWorkers 1\nMaxConnectionsPerChild 500\n</IfModule>\n');
  let sql = '';
  for (const s of SLOTS) {
    const password = (await fs.readFile(root + '/secrets/db_' + s, 'utf8')).trim(); assert(/^[a-f0-9]{64}$/.test(password));
    // Infrastructure DB/user initialization only. No WordPress/Woo business rows or DYNAMINDS SQL.
    sql += `CREATE DATABASE woo_${s};\nCREATE USER 'woo_${s}'@'%' IDENTIFIED BY '${password}';\nGRANT ALL ON woo_${s}.* TO 'woo_${s}'@'%';\n`;
  }
  await save(root, 'config/10-stores.sql', sql);
  await save(root, 'config/tls.ext', 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n');
  const openssl = args => execFileSync('openssl', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 ** 2});
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '14', '-subj', '/CN=DYNAMINDS owned Woo local CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', 'secrets/ca.key', '-out', 'secrets/ca.pem']);
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'secrets/tls.key', '-out', 'secrets/tls.csr']);
  openssl(['x509', '-req', '-in', 'secrets/tls.csr', '-CA', 'secrets/ca.pem', '-CAkey', 'secrets/ca.key', '-CAcreateserial', '-days', '14', '-sha256', '-extfile', 'config/tls.ext', '-out', 'secrets/tls.pem']);
  await save(root, 'config/nginx.conf', 'user nginx;\npid /var/run/nginx.pid;\nerror_log /dev/stderr warn;\nevents {}\nhttp {\n' + SLOTS.map((s, i) => `server { listen ${PORTS[i]} ssl; server_name localhost; ssl_certificate /run/secrets/tls_cert; ssl_certificate_key /run/secrets/tls_key; ssl_protocols TLSv1.2 TLSv1.3; client_max_body_size 2m; access_log off; if ($http_host != "localhost:${PORTS[i]}") { return 444; } location / { proxy_pass http://wp-${s}:80; proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Proto https; proxy_read_timeout 30s; } }`).join('\n') + '\n}\n');
  await save(root, 'tenant-bindings.template.private.json', json({schema: 'official-woo-tenant-bindings-pending/v1', runtime_registry_supported: false, accepted: false, stores: SLOTS.map((s, i) => ({slot: s, origin: 'https://localhost:' + PORTS[i], tenant_id: null, actor_id: null, channel_id: null, credentials_path: null}))}));
  await save(root, 'prepared.private.json', json({status: 'FILES_PREPARED_IMAGES_UNRESOLVED_NO_DOCKER_STARTED', ...await budget(root), provider_account_verified: false, scale_accepted: false}));
}
async function indexes(root) { return Object.fromEntries(await Promise.all(baseLock.images.map(async i => [i.id, await fs.readFile(root + '/manifests/' + i.id + '.index.json')]))); }
async function resolve(root) {
  await rootPath(root); const lock = resolveIndexes(await indexes(root), new Date().toISOString());
  await save(root, 'images.resolved.lock.private.json', json(lock));
  await save(root, 'env.private', environment(root, lock));
  await save(root, 'compose.resolved.private.json', json(materializeCompose(root, lock, JSON.parse(await fs.readFile(HERE + '/compose.yaml', 'utf8')))));
}
async function preflight(root) {
  await rootPath(root); await verifyPreparedConfiguration(root);
  for (const port of PORTS) await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => s.close(e => e ? reject(e) : resolve())); });
  return budget(root);
}
// ---- connection of the running stores (after install) ------------------------------------------------------------
const slotList = text => { assert(typeof text === 'string'); const slots = text.split(','); assert(slots.length >= 1 && slots.length <= SLOTS.length && new Set(slots).size === slots.length && slots.every(s => SLOTS.includes(s)), 'distinct owned store slots required'); return slots; };
/** TCP-only forwarder for a database container's network namespace (the packaged release runs there, so its
 * 127.0.0.1 is not the host's). Plain bytes in both directions: TLS stays end to end between the release's pinned
 * CA transport and the owned edge; the forwarder never sees keys or plaintext. */
export function forwarderConfig(ports) {
  assert(Array.isArray(ports) && ports.length >= 1 && ports.length <= PORTS.length && new Set(ports).size === ports.length && ports.every(p => PORTS.includes(p)), 'owned store ports only');
  return 'pid /var/run/nginx.pid;\nerror_log /dev/stderr warn;\nevents {}\nstream {\n'
    + ports.map(p => `server { listen 127.0.0.1:${p}; proxy_pass host.docker.internal:${p}; proxy_connect_timeout 5s; proxy_timeout 120s; }`).join('\n') + '\n}\n';
}
const forwarderName = (root, container) => `dyna-woo-${sha(root).slice(0, 12)}-fwd-${container}`;
export function forwarderArgs(root, lock, container, ports) {
  assert(/^dyna-scale-[a-z0-9]+(-[a-z0-9]+)*-pg18$/.test(container), 'dyna-scale-<name>-pg18 database container required');
  forwarderConfig(ports);
  const image = lock.images.find(i => i.id === 'tls'); assert(/^sha256:[a-f0-9]{64}$/.test(image?.digest ?? ''), 'pinned TLS image required');
  return ['run', '-d', '--name', forwarderName(root, container), '--network', 'container:' + container, '--read-only',
    '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/var/run:size=8m', '--tmpfs', '/var/cache/nginx:size=8m', '--memory', '32m', '--cpus', '0.25',
    '--log-driver', 'local', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=2', '--label', 'dynaminds.official-woo.root=' + root,
    '-v', `${root}/config/netns-forward-${container}.conf:/etc/nginx/nginx.conf:ro`, image.tag + '@' + image.digest];
}
const KEY = /^ck_[a-f0-9]{40}$/, SECRET = /^cs_[a-f0-9]{40}$/;
async function pinned(file, restKey) {
  const s = await fs.lstat(file);
  assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600 && s.size > 0 && s.size <= 65536, 'owned 0600 private file required: ' + path.basename(file));
  const bytes = await fs.readFile(file); let key = null;
  if (restKey) {
    try { key = JSON.parse(bytes.toString('utf8')); } catch { key = null; }
    assert(key && Object.keys(key).sort().join() === 'consumer_key,consumer_secret' && KEY.test(key.consumer_key) && SECRET.test(key.consumer_secret), 'Woo REST key file invalid: ' + path.basename(file));
  }
  return {pin: {path: file, sha256: sha(bytes)}, key: key?.consumer_key};
}
/** Paths and digests only (never key values): CA, importer key (release transport) and producer key (load driver,
 * creates source orders and per-run products) of each selected store. */
export async function storeBindings(root, slots) {
  assert(Array.isArray(slots) && slots.length >= 1 && slots.length <= SLOTS.length && new Set(slots).size === slots.length && slots.every(s => SLOTS.includes(s)), 'distinct owned store slots required');
  const ca = (await pinned(root + '/secrets/ca.pem', false)).pin, seen = new Set(), stores = [];
  for (const slot of slots) {
    const importer = await pinned(`${root}/secrets/rest_importer_${slot}.json`, true), producer = await pinned(`${root}/secrets/rest_producer_${slot}.json`, true);
    for (const k of [importer.key, producer.key]) { assert(!seen.has(k), 'distinct REST keys required per store and purpose'); seen.add(k); }
    stores.push({slot, origin: 'https://localhost:' + PORTS[SLOTS.indexOf(slot)], ca, importer: importer.pin, producer: producer.pin});
  }
  return {schema: 'dynaminds-official-woo-store-bindings/v1', root, stores};
}
async function saveOnce(root, name, body) {
  try { await save(root, name, body); } catch (e) { if (e.code !== 'EEXIST') throw e; assert.equal(await fs.readFile(root + '/' + name, 'utf8'), body, name + ' exists with other content'); }
}
async function composeArgs(root) { const {compose} = await verifyPreparedConfiguration(root); return ['compose', '--project-name', compose.name, '-f', root + '/compose.resolved.private.json']; }
/** One REST key (read_write) of the store's own administrator, created by WooCommerce's own WC_Auth::create_keys
 * inside the owned CLI container (rest-key.php on stdin). Output goes only to a new 0600 file; nothing is printed.
 * No replay: an existing file or an existing key of that purpose refuses (inspect the store first). */
async function keys(root, slot, purpose) {
  assert(SLOTS.includes(slot) && ['importer', 'producer'].includes(purpose), 'slot and purpose importer|producer required');
  const name = `secrets/rest_${purpose}_${slot}.json`;
  await assert.rejects(fs.lstat(root + '/' + name), {code: 'ENOENT'}, name + ' exists; no replay');
  const out = execFileSync('docker', [...await composeArgs(root), 'run', '--rm', '-T', 'cli-' + slot, '--user=fixture_' + slot, 'eval-file', '-', purpose],
    {input: await fs.readFile(HERE + '/rest-key.php'), stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 65536, timeout: 120000, encoding: 'utf8'});
  const key = JSON.parse(out.trim().split('\n').pop());
  assert(Object.keys(key).sort().join() === 'consumer_key,consumer_secret' && KEY.test(key.consumer_key) && SECRET.test(key.consumer_secret), 'unexpected WP-CLI key output');
  await save(root, name, JSON.stringify(key) + '\n');
  return {status: 'REST_KEY_SAVED', slot, purpose, file: name};
}
async function forward(root, container, slots) {
  const {lock} = await verifyPreparedConfiguration(root), ports = slots.map(s => PORTS[SLOTS.indexOf(s)]);
  const args = forwarderArgs(root, lock, container, ports);
  await saveOnce(root, `config/netns-forward-${container}.conf`, forwarderConfig(ports));
  execFileSync('docker', args, {stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000});
  return {status: 'FORWARDER_STARTED', container: forwarderName(root, container), namespace: container, ports};
}
// ---- renewal of the TLS edge (prepare issues the CA and the `localhost` certificate for 14 days) ---------------------
export const MAX_TLS_DAYS = 825;
const CA_SUBJECT = '/CN=DYNAMINDS owned Woo local CA', TLS_FILES = ['ca.pem', 'ca.srl', 'tls.csr', 'tls.pem'];
/** File-only part of `renew-tls`: a new self-signed CA from the SAME secrets/ca.key and subject, and a new `localhost`
 * certificate from the same secrets/tls.key, both valid for `days`. The new files are checked before anything moves;
 * the old ones stay beside as `<name>.superseded-NN`. The CA bytes and so its sha256 change: woo-store-bindings is
 * rewritten with the new CA pin (key pins unchanged), and every copy of the CA (demo: seed-woo.mjs --refresh-ca)
 * has to follow before the release is started again. */
export async function renewTlsFiles(root, days, now = new Date()) {
  assert(Number.isSafeInteger(days) && days >= 1 && days <= MAX_TLS_DAYS, `whole days 1..${MAX_TLS_DAYS} required`);
  const secrets = root + '/secrets', bindingsFile = root + '/woo-store-bindings.private.json';
  await pinned(bindingsFile, false); const old = JSON.parse(await fs.readFile(bindingsFile, 'utf8'));
  const current = (await pinned(secrets + '/ca.pem', false)).pin;
  assert(old.schema === 'dynaminds-official-woo-store-bindings/v1' && old.root === root && Array.isArray(old.stores) && old.stores.length >= 1
    && old.stores.every(s => s.ca?.path === current.path), 'bindings of this root required');
  if (!old.stores.every(s => s.ca.sha256 === current.sha256)) {
    // A renewal killed between moving the files and rewriting bindings: name the generation to put back.
    const generation = (await fs.readdir(secrets)).filter(f => /^ca\.pem\.superseded-\d{2}$/.test(f)).sort().pop();
    const back = generation && sha(await fs.readFile(secrets + '/' + generation)) === old.stores[0].ca.sha256 && generation.slice('ca.pem.'.length);
    assert.fail(back ? `interrupted renewal: bindings still pin the CA in ${generation}; put the ${back} files of ${TLS_FILES.join(', ')} back in secrets/ (or rewrite bindings) and run renew-tls again`
      : 'bindings of this root pinning its current CA required');
  }
  for (const key of ['ca.key', 'tls.key']) await pinned(secrets + '/' + key, false);
  let n = 1; const suffix = () => '.superseded-' + String(n).padStart(2, '0');
  const taken = async () => (await Promise.all([...TLS_FILES.map(f => secrets + '/' + f), bindingsFile].map(f => fs.lstat(f + suffix()).then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false; })))).some(Boolean);
  while (await taken()) { n++; assert(n < 100, 'too many superseded TLS generations'); }
  for (const f of TLS_FILES) await assert.rejects(fs.lstat(`${secrets}/${f}.renew`), {code: 'ENOENT'}, f + '.renew exists; inspect and remove it first');
  const openssl = args => execFileSync('openssl', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 ** 2, timeout: 60000});
  try {
    openssl(['req', '-x509', '-new', '-key', 'secrets/ca.key', '-sha256', '-days', String(days), '-subj', CA_SUBJECT, '-addext', 'basicConstraints=critical,CA:TRUE', '-out', 'secrets/ca.pem.renew']);
    openssl(['req', '-new', '-key', 'secrets/tls.key', '-subj', '/CN=localhost', '-out', 'secrets/tls.csr.renew']);
    openssl(['x509', '-req', '-in', 'secrets/tls.csr.renew', '-CA', 'secrets/ca.pem.renew', '-CAkey', 'secrets/ca.key', '-CAserial', 'secrets/ca.srl.renew', '-CAcreateserial', '-days', String(days), '-sha256', '-extfile', 'config/tls.ext', '-out', 'secrets/tls.pem.renew']);
    for (const f of TLS_FILES) await fs.chmod(`${secrets}/${f}.renew`, 0o600);
    const ca = new X509Certificate(await fs.readFile(secrets + '/ca.pem.renew')), leaf = new X509Certificate(await fs.readFile(secrets + '/tls.pem.renew'));
    const previous = new X509Certificate(await fs.readFile(secrets + '/ca.pem')), floor = now.getTime() + (days - 1) * 86400000;
    assert(ca.ca && ca.subject === previous.subject && ca.publicKey.equals(previous.publicKey) && ca.verify(ca.publicKey), 'renewed CA must keep the subject and key of the current CA');
    assert(!leaf.ca && leaf.checkIssued(ca) && leaf.verify(ca.publicKey) && leaf.checkHost('localhost') && leaf.checkIP('127.0.0.1'), 'renewed certificate must be the localhost edge issued by the renewed CA');
    assert(Date.parse(ca.validTo) >= floor && Date.parse(leaf.validTo) >= floor, 'renewed validity shorter than requested');
  } catch (e) { await Promise.all(TLS_FILES.map(f => fs.rm(`${secrets}/${f}.renew`, {force: true}))); throw e; }
  for (const f of TLS_FILES) {
    await fs.rename(`${secrets}/${f}`, `${secrets}/${f}${suffix()}`).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await fs.rename(`${secrets}/${f}.renew`, `${secrets}/${f}`);
  }
  const pin = (await pinned(secrets + '/ca.pem', false)).pin, renewed = {...old, stores: old.stores.map(s => ({...s, ca: pin}))};
  await fs.rename(bindingsFile, bindingsFile + suffix());
  await save(root, 'woo-store-bindings.private.json', json(renewed));
  const leaf = new X509Certificate(await fs.readFile(secrets + '/tls.pem'));
  return {previous_ca_sha256: current.sha256, ca_sha256: pin.sha256, not_after: new Date(leaf.validTo).toISOString(), superseded: suffix().slice(1),
    stores: renewed.stores.map(s => s.origin), fingerprint256: leaf.fingerprint256};
}
/** TLS handshake against the owned edge with the renewed CA; succeeds only when the edge serves the renewed certificate. */
function handshake(port, ca, fingerprint256, deadline, stop) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = tls.connect({host: '127.0.0.1', port, servername: 'localhost', ca, minVersion: 'TLSv1.2', rejectUnauthorized: true}, () => {
        const served = socket.getPeerCertificate().fingerprint256; socket.end();
        served === fingerprint256 ? resolve(port) : retry(new Error(`edge ${port} still serves the old certificate`));
      });
      socket.setTimeout(5000, () => socket.destroy(new Error(`edge ${port} handshake timeout`)));
      socket.once('error', retry);
    };
    const retry = e => stop.done || Date.now() > deadline ? reject(e) : setTimeout(attempt, 1000);
    attempt();
  });
}
/** `renew-tls`: renewTlsFiles, then a restart of only the owned TLS edge (bind-mounted files are read at container
 * start) and a handshake on every bound port. Stores, databases, REST keys and forwarders are not touched. */
async function renewTls(root, days) {
  const args = await composeArgs(root), result = await renewTlsFiles(root, days);
  execFileSync('docker', [...args, 'restart', 'tls'], {stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000});
  const ca = await fs.readFile(root + '/secrets/ca.pem'), deadline = Date.now() + 30000, stop = {done: false};
  // The first failing port ends the check; the other ports stop retrying instead of reconnecting until the deadline.
  const verified = await Promise.all(result.stores.map(o => handshake(Number(new URL(o).port), ca, result.fingerprint256, deadline, stop))).finally(() => { stop.done = true; });
  return {status: 'TLS_RENEWED', ...result, edge_restarted: true, handshake_ports: verified};
}
export async function main(args) {
  process.umask(0o077); const [command, root, zip] = args;
  const arity = {prepare: 3, resolve: 2, preflight: 2, budget: 2, bindings: 3, keys: 4, forward: 4, 'renew-tls': 3};
  assert(Object.hasOwn(arity, command)); assert.equal(args.length, arity[command]);
  if (command === 'prepare') await prepare(root, zip);
  else if (command === 'resolve') await resolve(root);
  else if (command === 'preflight') return preflight(root);
  else if (command === 'bindings') { await rootPath(root); const b = await storeBindings(root, slotList(args[2])); await saveOnce(root, 'woo-store-bindings.private.json', json(b)); return {status: 'BINDINGS_SAVED', file: root + '/woo-store-bindings.private.json', sha256: sha(json(b)), stores: b.stores.map(s => s.origin)}; }
  else if (command === 'keys') { await rootPath(root); return keys(root, args[2], args[3]); }
  else if (command === 'forward') { await rootPath(root); return forward(root, args[2], slotList(args[3])); }
  else if (command === 'renew-tls') { await rootPath(root); assert(/^[1-9]\d*$/.test(args[2]), 'whole days required'); return renewTls(root, Number(args[2])); }
  else { await rootPath(root); return budget(root, true); }
  return {status: command.toUpperCase() + '_FILE_ONLY_COMPLETE', Docker_started: false, WordPress_installed: false};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(e => { console.error(JSON.stringify({status: 'OFFICIAL_WOO_PREPARATION_REFUSED', name: e.name, message: e.message})); process.exitCode = 1; });
