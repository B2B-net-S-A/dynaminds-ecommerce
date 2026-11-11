/** Independent filesystem fault checks. Only owned temporary files; no app/PG/live service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createBoundedPrivateLogs} from './operator.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
function model(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dyna-peer-log-'));
  fs.chmodSync(parent, 0o700);
  t.after(() => fs.rmSync(parent, {recursive: true}));
  const directory = path.join(parent, 'logs'), logs = createBoundedPrivateLogs(directory, 1024);
  t.after(() => { try { logs.close(); } catch {} });
  return {parent, directory, logs};
}
function retained(directory, stream) {
  return Buffer.concat(stream.slots.filter(s => s.bytes).sort((a, b) => a.epoch - b.epoch).map(s => {
    const bytes = fs.readFileSync(path.join(directory, s.file));
    assert.equal(bytes.length, s.bytes); assert.equal(sha(bytes), s.sha256); assert(bytes.length <= 1024);
    return bytes;
  }));
}
test('peer: positive short writes and split UTF8 chunks preserve exact binary suffix and bounded metadata', t => {
  const m = model(t), input = Buffer.from('Zażółć gęślą 🧵\n'.repeat(500)), write = fs.writeSync;
  let calls = 0;
  fs.writeSync = (fd, buffer, offset, length, position) => { calls++; return write(fd, buffer, offset, Math.min(7, length), position); };
  try {
    for (let offset = 0; offset < input.length; offset += 13) m.logs.write('stdout', input.subarray(offset, offset + 13));
  } finally { fs.writeSync = write; }
  assert(calls > input.length / 13);
  const snapshot = m.logs.snapshot(), bytes = retained(m.directory, snapshot.stdout);
  assert.equal(snapshot.stdout.bytes, input.length); assert.equal(snapshot.stdout.sha256, sha(input));
  assert(bytes.equals(input.subarray(input.length - bytes.length))); assert(bytes.length <= 2048);
  assert.equal(snapshot.stderr.bytes, 0); assert.equal(snapshot.retained_bytes_max, 4096);
  assert.equal(fs.readdirSync(m.directory).length, 4); assert.equal(fs.statSync(m.directory).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(m.directory)) assert.equal(fs.statSync(path.join(m.directory, file)).mode & 0o777, 0o600);
});
test('peer: a hardlink added after open refuses before rotating/truncating the linked retained inode', t => {
  const m = model(t), old = Buffer.alloc(1024, 65);
  m.logs.write('stdout', old); m.logs.write('stdout', Buffer.alloc(1024, 66));
  const linked = path.join(m.directory, 'stdout.0.log'), alias = path.join(m.parent, 'retained-alias'); fs.linkSync(linked, alias);
  const truncate = fs.ftruncateSync; let truncations = 0, first;
  fs.ftruncateSync = (...args) => { truncations++; return truncate(...args); };
  try { assert.throws(() => m.logs.write('stdout', Buffer.from('new')), e => { first = e; return true; }); }
  finally { fs.ftruncateSync = truncate; }
  assert.equal(truncations, 0); assert(fs.readFileSync(alias).equals(old)); assert(fs.readFileSync(linked).equals(old));
  assert.throws(() => m.logs.write('stderr', Buffer.from('later')), e => e === first);
  assert.throws(() => m.logs.close(), e => e === first);
  assert(fs.existsSync(alias), 'logger must not unlink the foreign alias');
});
test('peer: path replacement by a different file or symlink never writes or unlinks either target', async t => {
  for (const kind of ['file', 'symlink']) await t.test(kind, sub => {
    const m = model(sub), active = path.join(m.directory, 'stdout.0.log'), held = path.join(m.parent, 'original-inode'), target = path.join(m.parent, 'foreign-target');
    fs.renameSync(active, held); fs.writeFileSync(target, 'FOREIGN_SENTINEL', {mode: 0o600, flag: 'wx'});
    if (kind === 'file') fs.writeFileSync(active, 'OTHER_INODE', {mode: 0o600, flag: 'wx'}); else fs.symlinkSync(target, active);
    assert.throws(() => m.logs.write('stdout', Buffer.from('must-not-write')));
    assert.equal(fs.readFileSync(target, 'utf8'), 'FOREIGN_SENTINEL'); assert.equal(fs.readFileSync(held).length, 0);
    if (kind === 'file') assert.equal(fs.readFileSync(active, 'utf8'), 'OTHER_INODE'); else assert(fs.lstatSync(active).isSymbolicLink());
  });
});
test('peer: ENOSPC after a partial write poisons capture; close attempts every FD and retains primary over close failure', t => {
  const m = model(t), write = fs.writeSync, close = fs.closeSync, diskFull = Object.assign(Error('controlled disk full'), {code: 'ENOSPC'}), closeError = Object.assign(Error('controlled close failure'), {code: 'EIO'});
  const input = Buffer.from('owned bytes '.repeat(80)); let writes = 0;
  fs.writeSync = (fd, buffer, offset, length, position) => { if (writes++) throw diskFull; return write(fd, buffer, offset, Math.min(17, length), position); };
  try { assert.throws(() => m.logs.write('stdout', input), e => e === diskFull); } finally { fs.writeSync = write; }
  const before = m.logs.snapshot(); assert.equal(before.stdout.retained_bytes, 17); assert(retained(m.directory, before.stdout).equals(input.subarray(0, 17)));
  assert.throws(() => m.logs.write('stderr', Buffer.from('no retry')), e => e === diskFull); assert.deepEqual(m.logs.snapshot(), before);
  const attempts = []; let unclosed;
  fs.closeSync = fd => { attempts.push(fd); if (unclosed === undefined) { unclosed = fd; throw closeError; } return close(fd); };
  try { assert.throws(() => m.logs.close(), e => e === diskFull); assert.throws(() => m.logs.close(), e => e === diskFull); }
  finally { fs.closeSync = close; }
  try {
    assert.equal(attempts.length, 5); assert.equal(new Set(attempts).size, 5); assert.equal(m.logs.snapshot().close_unconfirmed, true); assert.equal(m.logs.snapshot().error.code, 'ENOSPC');
    for (const fd of attempts.filter(fd => fd !== unclosed)) assert.throws(() => fs.fstatSync(fd), {code: 'EBADF'});
  } finally { if (unclosed !== undefined) close(unclosed); }
});
