/** Source-program extraction only. Does not open PostgreSQL or approve a catalogue. */
import assert from 'node:assert/strict';
import {RELEASE_MIGRATION_PROGRAM} from './migration-manifest.mjs';

/** The one literal token that appends the release migration list (migration-manifest.mjs) after the literal pairs. */
export const RELEASE_MIGRATION_SPREAD = '...RELEASE_MIGRATION_PROGRAM';

export function sourceDdlMigrationPlan(source) {
  assert.equal(typeof source, 'string');
  const marker = 'for (const [name, file] of [';
  const start = source.indexOf(marker);
  assert(start >= 0 && source.indexOf(marker, start + marker.length) < 0, 'one literal migration program required');
  const end = source.indexOf(']) {', start + marker.length);
  assert(end >= 0, 'literal migration program closing required');
  let body = source.slice(start + marker.length, end);
  // At most one spread of the release list, and only as the last element of the program.
  const spread = /\.\.\.RELEASE_MIGRATION_PROGRAM\s*,?\s*$/;
  const release = spread.test(body);
  if (release) body = body.replace(spread, '');
  assert(!body.includes('...'), 'entire migration program must be parsed');
  const entry = /\[\s*'([a-z0-9_]+)'\s*,\s*'\.\/([a-zA-Z0-9_-]+\.sql)'\s*,?\s*\]\s*,?/g;
  const entries = [...body.matchAll(entry)].map(m => Object.freeze({name: m[1], file: m[2]}));
  assert(entries.length > 0 && /^\s*$/.test(body.replace(entry, '')), 'entire migration program must be parsed');
  if (release) entries.push(...RELEASE_MIGRATION_PROGRAM.map(([name, file]) => Object.freeze({name, file: file.slice(2)})));
  assert.equal(new Set(entries.map(x => x.name)).size, entries.length, 'duplicate migration name');
  assert.equal(new Set(entries.map(x => x.file)).size, entries.length, 'duplicate migration source');
  return Object.freeze(entries);
}
