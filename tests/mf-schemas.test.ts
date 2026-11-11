/** The vendored MF schemas are exactly the downloaded bytes: every file of schemas/mf is in
 * manifest.json with its source URL (*.gov.pl only), size and sha256, nothing else is there, and the
 * structures match the namespaces the generators write. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MF_SCHEMA_ROOT } from '../server/mf-xsd';
import { FA3_XML_NAMESPACE } from '../server/fa3-xml';
import { JPK_V7M_NAMESPACE, JPK_V7K_NAMESPACE } from '../server/jpk-v7';
import { JPK_FA_NAMESPACE } from '../server/jpk-fa';

type Manifest = { retrieved: string; schemas: Record<string, { dir: string; root: string; targetNamespace: string; kodSystemowy: string; wersjaSchemy: string }>;
  files: { path: string; url: string; fetchedFrom: string; bytes: number; sha256: string; retrieved: string }[] };
const manifest = JSON.parse(readFileSync(join(MF_SCHEMA_ROOT, 'manifest.json'), 'utf8')) as Manifest;
const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]);
const gov = (url: string) => { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && (u.hostname === 'gov.pl' || u.hostname.endsWith('.gov.pl')); };

test('every vendored schema file has its manifest bytes and sha256; no unlisted file', () => {
  const listed = new Set(manifest.files.map(f => f.path));
  const present = walk(MF_SCHEMA_ROOT).map(f => relative(MF_SCHEMA_ROOT, f).split('\\').join('/')).filter(f => f !== 'manifest.json').sort();
  assert.deepEqual(present, [...listed].sort());
  for (const f of manifest.files) {
    const bytes = readFileSync(join(MF_SCHEMA_ROOT, f.path));
    assert.equal(bytes.length, f.bytes, f.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), f.sha256, f.path);
    assert.ok(gov(f.url) && gov(f.fetchedFrom), 'gov.pl source only: ' + f.path);
    assert.match(f.retrieved, /^2026-10-30T/);
    assert.doesNotMatch(bytes.toString('utf8'), /<!DOCTYPE|<!ENTITY/, 'no DTD in ' + f.path);
  }
});

test('the four structures: root file, fixed kodSystemowy/wersjaSchemy and the namespace the generators write', () => {
  const expected: Record<string, [string, string, string]> = {
    'FA(3)': [FA3_XML_NAMESPACE, 'FA (3)', '1-0E'], 'JPK_V7M(3)': [JPK_V7M_NAMESPACE, 'JPK_V7M (3)', '1-0E'],
    'JPK_V7K(3)': [JPK_V7K_NAMESPACE, 'JPK_V7K (3)', '1-0E'], 'JPK_FA(4)': [JPK_FA_NAMESPACE, 'JPK_FA (4)', '1-0'],
  };
  assert.deepEqual(Object.keys(manifest.schemas).sort(), Object.keys(expected).sort());
  for (const [name, s] of Object.entries(manifest.schemas)) {
    const [ns, code, version] = expected[name]!, text = readFileSync(join(MF_SCHEMA_ROOT, s.dir, s.root), 'utf8');
    assert.equal(s.targetNamespace, ns, name);
    assert.ok(text.includes(`targetNamespace="${ns}"`), name + ' targetNamespace');
    assert.ok(text.includes(`fixed="${code}"`) && text.includes(`fixed="${version}"`), name + ' kodSystemowy/wersjaSchemy');
    assert.deepEqual([s.kodSystemowy, s.wersjaSchemy], [code, version]);
    // Every import/include of the structure has its file next to the root (resolved offline by name).
    const dir = join(MF_SCHEMA_ROOT, s.dir), names = new Set(readdirSync(dir));
    for (const f of names) for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/schemaLocation="([^"]+)"/g))
      assert.ok(names.has(m[1]!.split('/').at(-1)!), `${name}: ${f} imports ${m[1]}`);
  }
});
