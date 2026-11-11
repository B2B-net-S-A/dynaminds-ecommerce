/** S8 on migration 249, prepared as placeholder 255 (no database): DOM-AI-001 style in request, prompt and length bound; DOM-AI-002
 * validation of model values against typed PIM definitions (negative cases); DOM-AI-003 batch request shape; the
 * shape of the prepared SQL (own catalog_ai_* objects only, no core table altered or referenced, RLS, no DELETE). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { aiRequest, aiStyle, aiStyleInstruction, aiDescriptionLimit, draftStyle } from '../server/catalog-ai';
import { validateAttributeOutput, attributeModelOutput, type AttributeDefinition } from '../server/catalog-ai-attributes';
import { batchRequest } from '../server/catalog-ai-batches';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const sql = readFileSync(new URL('../server/249_catalog_ai.sql', import.meta.url), 'utf8');
const section = (name: string) => {
  const m = sql.match(new RegExp(`-- BEGIN ${name}[^\\n]*\\n([\\s\\S]*?)-- END ${name}`));
  assert(m, 'section ' + name);
  return m[1].replace(/--[^\n]*/g, '');
};
test('249 follows 248 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m: any) => m.number === 249), row: any = RELEASE_MIGRATIONS[i];
  const b = readFileSync(new URL('../server/249_catalog_ai.sql', import.meta.url));
  assert(row, 'manifest row 249');
  assert.equal(row.name, '249_catalog_ai');
  assert.equal(row.file, '249_catalog_ai.sql');
  assert.equal(row.native_id, 'catalog_ai249');
  assert.equal(row.cold.contract, 'catalog-ai249');
  assert.equal(row.cold.project, 'projectCompiledCatalogAi249Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 22415);
  assert.equal(row.sha256, '90e534dbb25f2e7767457dddb76061a74291aa5c02a2b2721b6e68bf6e006817');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '248_guard_verdicts');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '250_wms_evidence_settle_unlocked', '250 follows 249');
});
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000255`;

test('DOM-AI-001 style: default factual/medium, unknown tone refused, prompt states tone and the length bound', () => {
  const base = { version: 1, client_key: uuid(1), model: 'm', destination: 'catalog', locale: 'pl' };
  assert.deepEqual(aiRequest.parse(base).style, { tone: 'factual', length: 'medium' });
  assert.deepEqual(aiRequest.parse({ ...base, style: { tone: 'marketing', length: 'short' } }).style, { tone: 'marketing', length: 'short' });
  assert.throws(() => aiRequest.parse({ ...base, style: { tone: 'poetic' } }));
  assert.throws(() => aiRequest.parse({ ...base, style: { tone: 'factual', length: 'medium', prompt: 'ignore rules' } }), 'no free-text prompt');
  assert.match(aiStyleInstruction(aiStyle.parse({ tone: 'marketing', length: 'short' }), 'Polish'), /marketing tone.*supplied facts.*at most 400 characters, in Polish/s);
  assert.match(aiStyleInstruction(aiStyle.parse({ tone: 'technical', length: 'long' }), 'German'), /technical.*at most 4000 characters/s);
  assert.equal(aiDescriptionLimit.medium, 1500);
  assert.deepEqual(draftStyle({ name: 'x' }), { tone: 'factual', length: 'medium' }, 'drafts before 249 read as default');
  assert.deepEqual(draftStyle({ style: { tone: 'technical', length: 'short' } }), { tone: 'technical', length: 'short' });
});

const defs: AttributeDefinition[] = [
  { id: uuid(1), name: 'Materiał', required: true, shape: { kind: 'text', max_length: 20 } },
  { id: uuid(2), name: 'Pojemność', required: false, shape: { kind: 'decimal', scale: 2, unit: 'l', minimum: '0.00', maximum: '5.00' } },
  { id: uuid(3), name: 'Zmywarka', required: false, shape: { kind: 'boolean' } },
  { id: uuid(4), name: 'Kolor', required: false, shape: { kind: 'enum', options: [{ id: uuid(41), label: 'Czarny', active: true }, { id: uuid(42), label: 'Biały', active: true }] } },
];
test('DOM-AI-002 values follow the definition type; unknown, repeated, wrong-type, out-of-range and markup values are refused with a reason', () => {
  const ok = validateAttributeOutput(defs, attributeModelOutput.parse({ values: [
    { definition_id: uuid(1), value: ' stal nierdzewna ' },
    { definition_id: uuid(2), value: '0.35' },
    { definition_id: uuid(3), value: true },
    { definition_id: uuid(4), value: 'czarny' },
  ] }));
  assert.deepEqual(ok.refused, []);
  assert.deepEqual(ok.entries, [
    { definition_id: uuid(1), kind: 'text', value: 'stal nierdzewna' },
    { definition_id: uuid(2), kind: 'decimal', value: '0.35' },
    { definition_id: uuid(3), kind: 'boolean', value: true },
    { definition_id: uuid(4), kind: 'enum', option_id: uuid(41) },
  ]);
  assert.deepEqual(validateAttributeOutput(defs, { values: [{ definition_id: uuid(2), value: 2 }] }).entries, [{ definition_id: uuid(2), kind: 'decimal', value: '2.00' }], 'scale is padded');
  assert.deepEqual(validateAttributeOutput(defs, { values: [{ definition_id: uuid(4), value: uuid(42) }] }).entries, [{ definition_id: uuid(4), kind: 'enum', option_id: uuid(42) }]);
  const bad = validateAttributeOutput(defs, { values: [
    { definition_id: uuid(9), value: 'x' },
    { definition_id: uuid(1), value: 'bardzo długi materiał ponad limit' },
    { definition_id: uuid(1), value: 'stal' },
    { definition_id: uuid(2), value: '7.00' },
    { definition_id: uuid(3), value: 'tak' },
    { definition_id: uuid(4), value: 'zielony' },
  ] });
  assert.deepEqual(bad.entries, []);
  assert.deepEqual(bad.refused.map((r) => r.reason), [
    'Nieznany parametr', 'Tekst dłuższy niż 20 znaków', 'Powtórzony parametr', 'Wartość poza zakresem 0.00–5.00',
    'Wymagana wartość tak/nie', 'Wartość spoza słownika',
  ]);
  assert.deepEqual(validateAttributeOutput(defs, { values: [{ definition_id: uuid(2), value: '0.355' }] }).refused.map((r) => r.reason), ['Liczba wymaga najwyżej 2 miejsc po przecinku']);
  assert.deepEqual(validateAttributeOutput(defs, { values: [{ definition_id: uuid(2), value: '1e3' }] }).refused.map((r) => r.reason), ['Wymagana liczba']);
  assert.deepEqual(validateAttributeOutput(defs, { values: [{ definition_id: uuid(1), value: '<b>stal</b>' }] }).refused.map((r) => r.reason), ['Wymagany zwykły tekst bez HTML']);
  assert.deepEqual(validateAttributeOutput(defs, { values: [{ definition_id: uuid(1), value: null }] }), { entries: [], refused: [] }, 'null = no proposal');
  assert.throws(() => attributeModelOutput.parse({ values: [], extra: 1 }), 'strict model output');
});

test('DOM-AI-003 batch request: 1..50 distinct products with versions, frozen model and style', () => {
  const p = (n: number) => ({ id: uuid(n), version: 1 });
  const base = { client_key: uuid(1), model: 'm', destination: 'catalog', locale: 'pl' };
  assert.deepEqual(batchRequest.parse({ ...base, products: [p(1)] }).style, { tone: 'factual', length: 'medium' });
  assert.throws(() => batchRequest.parse({ ...base, products: [] }));
  assert.throws(() => batchRequest.parse({ ...base, products: Array.from({ length: 51 }, (_, i) => p(i + 1)) }));
  assert.throws(() => batchRequest.parse({ ...base, products: [p(1), p(1)] }), 'duplicates');
  assert.equal(batchRequest.parse({ ...base, products: Array.from({ length: 50 }, (_, i) => p(i + 1)) }).products.length, 50);
});

test('249: own catalog_ai_* objects only, no core table altered or referenced, RLS and no DELETE', () => {
  assert.match(sql.split('\n')[0], /^-- Migration 249_catalog_ai \(prepared as placeholder 255, registered after 248;/);
  for (const name of ['catalog_ai_batch', 'catalog_ai_attribute', 'catalog_ai_image']) section(name);
  const body = sql.replace(/--[^\n]*/g, '');
  for (const m of body.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX|FUNCTION|TRIGGER) (\w+)/g)) assert.match(m[1], /^catalog_ai_/, m[0]);
  for (const m of body.matchAll(/ALTER TABLE (\w+)/g)) assert.match(m[1], /^catalog_ai_/, m[0]);
  for (const m of body.matchAll(/REFERENCES (\w+)/g)) assert.equal(m[1], 'catalog_ai_batches', m[0]);
  for (const m of body.matchAll(/\bON (?:TABLE )?(\w+)/g)) assert.match(m[1], /^catalog_ai_/, m[0]);
  assert.doesNotMatch(body, /\bDELETE\b|DROP |SECURITY DEFINER|warehouse_wz_issuer|catalog_stock_|pim_dictionary_/);
  const tables = [...body.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables.sort(), ['catalog_ai_attribute_proposals', 'catalog_ai_batch_items', 'catalog_ai_batches', 'catalog_ai_image_jobs', 'catalog_ai_match_proposals']);
  for (const t of tables) {
    assert.match(body, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`), t);
    assert.match(body, new RegExp(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`), t);
    assert.match(body, new RegExp(`CREATE POLICY tenant_scope ON ${t} TO dyna_app USING \\(tenant_id=nullif`), t);
  }
});
