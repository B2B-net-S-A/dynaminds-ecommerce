/** Offline code generation only: node --import tsx scripts/build-buyer-address-portal.ts.
 * esbuild is supplied by the installed tsx dependency. No app/db/network imports.
 * The maintained DOM source and its pure validator are bundled into one nonce-safe IIFE. */
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const file = fileURLToPath(new URL('../server/buyer-address-portal.ts', import.meta.url));
const marker = '\n// Generated browser IIFE; regenerate with scripts/build-buyer-address-portal.ts.\n';
const source = readFileSync(file, 'utf8').split(marker)[0];
const built = buildSync({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('../server', import.meta.url)), sourcefile: 'buyer-address-portal.ts', loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'BuyerAddressPortal166', platform: 'browser', target: 'es2022', minify: false }).outputFiles[0].text;
// HTML parser recognizes </script even within JS strings; escape the delimiter.
const script = built.replace(/<\/script/gi, '<\\/script').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
writeFileSync(file, source + marker + 'export const browserScript166 = ' + JSON.stringify(script) + ';\n');
