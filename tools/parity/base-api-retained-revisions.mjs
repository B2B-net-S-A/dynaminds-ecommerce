/** Exact earlier revisions of retained parity documents that the dated 18/19.10
 * registries (contract traceability, operation proposal) still pin. A live
 * document may evolve after them (1702ad9 recorded the native 222 split in the
 * orders contracts); the dated registries keep naming the revision they
 * recorded. The retained bytes are checked against that revision's pin before
 * use; every other path is read from the tree unchanged. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const BASE_API_RETAINED_REVISIONS = Object.freeze({
  'docs/parity/base-api-orders-contracts.v1.json': Object.freeze({
    path: 'docs/parity/base-api-orders-contracts.v1-historical-20261017.json',
    bytes: 146132, sha256: '7c94dea8645a575b4a326dafda86d314bc03bdd44e7e52ffee5a81a37e8a6534',
    revision: '715f03c', superseded_by: '1702ad9',
  }),
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Bytes of repo-relative `name` at the revision the dated registries pin. */
export function readRetainedRevision(root, name) {
  const retained = Object.hasOwn(BASE_API_RETAINED_REVISIONS, name) ? BASE_API_RETAINED_REVISIONS[name] : null;
  const bytes = fs.readFileSync(path.join(root, retained ? retained.path : name));
  if (retained) {
    assert.equal(bytes.length, retained.bytes, 'retained revision size');
    assert.equal(sha(bytes), retained.sha256, 'retained revision digest');
  }
  return bytes;
}
