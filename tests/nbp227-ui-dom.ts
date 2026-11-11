/** Side effect for nbp227-ui.test.ts: react-dom decides at import whether the DOM has input
 * events, so a window must exist before it loads (this module is imported first). */
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const boot = new JSDOM('<!doctype html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: boot.window, document: boot.window.document });
