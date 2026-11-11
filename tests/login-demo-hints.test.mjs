// The packaged UI must not suggest seed accounts (no such accounts exist in a real or demo company database).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../web/main.tsx', import.meta.url), 'utf8');

test('login prefill and seed-account hints exist only in the vite dev server', () => {
  assert.match(src, /const devLoginHints = import\.meta\.env\.DEV;/);
  assert.match(src, /defaultValue=\{devLoginHints && mode === 'login' && !invite \? 'admin@demo\.local' : ''\}/);
  assert.match(src, /defaultValue=\{devLoginHints && mode === 'login' && !invite \? 'DynaDemo!2026' : ''\}/);
  assert.match(src, /\{devLoginHints && \(\s*<details>\s*<summary>Konta demonstracyjne<\/summary>/);
});
