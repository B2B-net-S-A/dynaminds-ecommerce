/** Base.com/BaseLinker documentation captures (docs/parity/base-api-*-sources-*.json.gz,
 * base-api-index-20261017.html.gz, base-catalog-20261017.html.gz and .integrations.js.gz) are
 * third-party material: they stay in local checkouts only (.gitignore) and are not in the public
 * tree. Tests that re-derive facts from them run whenever the files are present and are skipped
 * with this reason when they are not. */
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const BASE_CAPTURE_SKIP_REASON = 'Base.com/BaseLinker documentation capture not in this checkout (third-party material, kept only in local checkouts)';

/** false when every repo-relative path exists, otherwise the skip reason naming the missing ones. */
export function baseCaptureSkip(paths) {
  const missing = paths.filter(p => !existsSync(path.join(ROOT, p)));
  return missing.length ? `${BASE_CAPTURE_SKIP_REASON}: ${missing.join(', ')}` : false;
}
