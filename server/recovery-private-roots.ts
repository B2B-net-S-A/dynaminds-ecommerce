import { isDeepStrictEqual } from 'node:util';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';

const names = ['raw', 'control', 'sourceJournal', 'legacyRaw'] as const;
export type PrivateRoots = Partial<Record<typeof names[number], string>>;
const maxEntries = 20000;
const limits = { raw: 256 * 1024 * 1024, legacyRaw: 256 * 1024 * 1024,
  control: 32 * 1024 * 1024, sourceJournal: 32 * 1024 * 1024 };
const nofollow = constants.O_NOFOLLOW;
const fail = () => new Error('Nieprawidłowy prywatny katalog lub plik kopii');
function component(s: string) {
  return s.length > 0 && Buffer.byteLength(s) <= 255 && s !== '.' && s !== '..' &&
    !/[\\/\x00-\x1f\x7f]/u.test(s) && Buffer.from(s).toString('utf8') === s;
}
function relativePath(s: string) {
  return s.length <= 2048 && !isAbsolute(s) && s.split('/').every(component);
}
const relativeSchema = z.string().refine(relativePath);
const fileSchema = z.strictObject({ path: relativeSchema, mode: z.literal(384),
  bytes: z.number().int().nonnegative().max(limits.raw), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  archive_path: z.string().regex(/^private-root-files\/[0-9]{8}$/) });
export const privateRootsManifestSchema = z.array(z.strictObject({ name: z.enum(names),
  directories: z.array(z.string().refine(s => s === '' || relativePath(s))).min(1).max(maxEntries),
  files: z.array(fileSchema).max(maxEntries),
})).max(4).superRefine((roots, ctx) => {
  const issue = () => ctx.addIssue({code: 'custom', message: 'Nieprawidłowy spis prywatnych katalogów kopii'});
  if (new Set(roots.map(r => r.name)).size !== roots.length) issue();
  const payloads = new Set<string>(); let count = 0;
  for (const root of roots) {
    const paths = [...root.directories, ...root.files.map(f => f.path)];
    count += paths.length;
    if (root.directories[0] !== '' || new Set(paths).size !== paths.length || count > maxEntries) issue();
    if (root.files.reduce((n, f) => n + f.bytes, 0) > limits[root.name]) issue();
    const dirs = new Set(root.directories);
    const aliases = new Set<string>();
    for (const p of paths) {
      const alias = p.normalize('NFC').toLocaleLowerCase('en-US');
      if (aliases.has(alias)) issue(); aliases.add(alias);
      if (p !== '' && !dirs.has(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')) issue();
    }
    for (const f of root.files) { if (payloads.has(f.archive_path)) issue(); payloads.add(f.archive_path); }
  }
});
export type PrivateRootsManifest = z.infer<typeof privateRootsManifestSchema>;
type Identity = { dev: number; ino: number; uid: number; mode: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number };
const identity = (s: Stats): Identity => ({dev:s.dev, ino:s.ino, uid:s.uid,
  mode:s.mode, size:s.size, mtimeMs:s.mtimeMs, ctimeMs:s.ctimeMs, nlink:s.nlink});
const equal = isDeepStrictEqual;
function owner(s: Stats, directory: boolean) {
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) ||
    (s.mode & 0o7777) !== (directory ? 0o700 : 0o600) || s.uid !== process.getuid?.() ||
    (!directory && s.nlink !== 1)) throw fail();
}
async function canonicalDirectory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw fail();
  let current = path;
  for (;;) {
    const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw fail();
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const s = await lstat(path); owner(s, true); return identity(s);
}
async function heldFile(path: string, expected: Identity, work: (f: Awaited<ReturnType<typeof open>>) => Promise<void>) {
  const f = await open(path, constants.O_RDONLY | nofollow);
  try {
    const s = await f.stat(); owner(s, false);
    if (!equal(identity(s), expected)) throw fail();
    await work(f);
    if (!equal(identity(await f.stat()), expected) || !equal(identity(await lstat(path)), expected)) throw fail();
  } finally { await f.close(); }
}
async function hashHeld(path: string, expected: Identity) {
  const h = createHash('sha256');
  await heldFile(path, expected, async f => {
    const buffer = Buffer.alloc(1024 * 1024); let offset = 0;
    for (;;) { const {bytesRead} = await f.read(buffer, 0, buffer.length, offset); if (!bytesRead) break;
      offset += bytesRead; if (offset > expected.size) throw fail(); h.update(buffer.subarray(0, bytesRead)); }
    if (offset !== expected.size) throw fail();
  });
  return h.digest('hex');
}
type Entry = {path: string; identity: Identity; directory: boolean; sha256?: string};
async function inspect(root: string, budget: number): Promise<Entry[]> {
  await canonicalDirectory(root); const entries: Entry[] = []; let bytes = 0;
  async function visit(relative: string) {
    if (entries.length >= maxEntries) throw fail();
    const path = relative ? join(root, relative) : root, s = await lstat(path), directory = s.isDirectory();
    owner(s, directory); const entry: Entry = {path:relative, identity:identity(s), directory}; entries.push(entry);
    if (directory) {
      const raw = await readdir(path, {encoding:'buffer'}); const aliases = new Set<string>();
      const children = raw.map(b => { const name = b.toString('utf8');
        if (!Buffer.from(name).equals(b) || !component(name)) throw fail();
        const alias = name.normalize('NFC').toLocaleLowerCase('en-US'); if (aliases.has(alias)) throw fail();
        aliases.add(alias); return name; }).sort();
      for (const name of children) await visit(relative ? relative + '/' + name : name);
      if (!equal(identity(await lstat(path)), entry.identity)) throw fail();
    } else {
      bytes += s.size; if (bytes > budget || s.size > budget) throw fail();
      entry.sha256 = await hashHeld(path, entry.identity);
    }
  }
  await visit(''); return entries;
}
function inputRoots(input: PrivateRoots) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    Object.keys(input).some(k => !names.includes(k as typeof names[number]))) throw fail();
  const roots = names.filter(n => Object.hasOwn(input, n)).map(name => {
    const path = input[name]; if (typeof path !== 'string' || !isAbsolute(path)) throw fail(); return {name,path}; });
  for (const a of roots) for (const b of roots)
    if (a !== b && (a.path === b.path || a.path.startsWith(b.path + sep))) throw fail();
  return roots;
}
export async function capturePrivateRoots(input: PrivateRoots, bundle: string) {
  const roots = inputRoots(input), retained: {path:string; budget:number; entries:Entry[]}[] = [];
  const manifest: PrivateRootsManifest = []; let index = 0, count = 0;
  const storage = resolve(bundle, 'private-root-files');
  for (const root of roots) {
    if (resolve(bundle) === root.path || resolve(bundle).startsWith(root.path + sep) || root.path.startsWith(resolve(bundle) + sep)) throw fail();
    const entries = await inspect(root.path, limits[root.name]); count += entries.length;
    if (count > maxEntries) throw fail(); retained.push({path:root.path,budget:limits[root.name],entries});
    const record: PrivateRootsManifest[number] = {name:root.name,directories:[],files:[]}; manifest.push(record);
    for (const entry of entries) {
      if (entry.directory) { record.directories.push(entry.path); continue; }
      await mkdir(storage, {recursive:true,mode:0o700});
      const archive_path = 'private-root-files/' + String(index++).padStart(8,'0');
      const target = await open(resolve(bundle, archive_path), 'wx', 0o600);
      const digest = createHash('sha256'); let offset = 0;
      try {
        // Recheck every ancestor before opening the NOFOLLOW regular source file.
        await canonicalDirectory(root.path);
        let parent = dirname(join(root.path, entry.path));
        while (parent !== root.path) {
          const saved = entries.find(e => e.directory && join(root.path,e.path) === parent);
          if (!saved || !equal(identity(await lstat(parent)), saved.identity)) throw fail(); parent = dirname(parent);
        }
        await heldFile(join(root.path,entry.path), entry.identity, async f => {
          const buffer = Buffer.alloc(1024*1024);
          for (;;) { const {bytesRead} = await f.read(buffer,0,buffer.length,offset); if (!bytesRead) break;
            if (offset + bytesRead > entry.identity.size) throw fail();
            const bytes = buffer.subarray(0,bytesRead); digest.update(bytes);
            let written = 0; while (written < bytesRead) { const r = await target.write(bytes,written,bytesRead-written,offset+written); if (!r.bytesWritten) throw fail(); written += r.bytesWritten; }
            offset += bytesRead;
          }
        });
        if (offset !== entry.identity.size || digest.digest('hex') !== entry.sha256) throw fail(); await target.sync();
      } finally { await target.close(); }
      record.files.push({path:entry.path,mode:384,bytes:offset,sha256:entry.sha256!,archive_path});
    }
  }
  const parsed = privateRootsManifestSchema.parse(manifest);
  return {manifest:parsed, async verifyUnchanged() {
    for (const root of retained) if (!equal(await inspect(root.path,root.budget),root.entries)) throw fail();
  }};
}
export function privateRootArchiveFiles(input: PrivateRootsManifest | undefined) {
  return privateRootsManifestSchema.parse(input ?? []).flatMap(r => r.files.map(f => f.archive_path));
}
export async function restorePrivateRoots(input: PrivateRootsManifest | undefined, bundle: string) {
  const roots = privateRootsManifestSchema.parse(input ?? []);
  // Validate every authenticated payload before materializing the first root.
  if (roots.some(r => r.files.length)) {
    const storage = resolve(bundle,'private-root-files'), s = await lstat(storage);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || await realpath(storage) !== storage) throw fail();
    const f = await open(storage,constants.O_RDONLY | nofollow); try { await f.chmod(0o700); } finally { await f.close(); }
  }
  for (const root of roots) for (const file of root.files) {
    const path = resolve(bundle,file.archive_path), s = await lstat(path);
    // tar --no-same-permissions may apply a stricter umask; set the sealed private mode.
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.size !== file.bytes) throw fail();
    const f = await open(path, constants.O_RDONLY | nofollow); try { await f.chmod(0o600); } finally { await f.close(); }
    if (await hashHeld(path,identity(await lstat(path))) !== file.sha256) throw fail();
  }
  if (roots.length) await mkdir(resolve(bundle,'private-roots'), {mode:0o700});
  for (const root of roots) {
    const target = resolve(bundle,'private-roots',root.name);
    for (const dir of [...root.directories].sort((a,b)=>a.split('/').length-b.split('/').length))
      await mkdir(dir ? join(target,dir) : target, {mode:0o700});
    for (const file of root.files) await rename(resolve(bundle,file.archive_path),join(target,file.path));
    const actual = await inspect(target,limits[root.name]);
    const directories = actual.filter(e=>e.directory).map(e=>e.path).sort();
    const files = actual.filter(e=>!e.directory).map(e=>({path:e.path,bytes:e.identity.size,mode:e.identity.mode&0o7777,sha256:e.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
    const expected = root.files.map(({archive_path:_archive,...f})=>f).sort((a,b)=>a.path.localeCompare(b.path));
    if (!equal(directories,[...root.directories].sort()) || !equal(files,expected)) throw fail();
  }
  return {root_names:roots.map(r=>r.name),file_count:roots.reduce((n,r)=>n+r.files.length,0),
    directory_count:roots.reduce((n,r)=>n+r.directories.length,0),bytes:roots.reduce((n,r)=>n+r.files.reduce((sum,f)=>sum+f.bytes,0),0),
    hashes_verified:true as const,restored_importer_authority:false as const,requires_fresh_census:true as const};
}
