/** DOM-AI-005 (migration 249, prepared as placeholder 255): category and parameter match proposals. Unit and static checks without a
 * database: the model output is validated against the frozen candidates and parameter definitions (unknown id,
 * wrong type, value outside the dictionary → rejected entry with a reason, never silently kept), the Allegro
 * definitions are compacted for the model, and the SQL fragment creates only its own objects (no ALTER of core
 * tables, no foreign keys, RLS + FORCE, no DELETE grant). Route guards that run before any database access. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import {
  validateMatchOutput,
  compactAllegroParameters,
  matchModelOutput,
  matchAcceptInput,
  demoAllegroMatchSnapshot,
  matchModelInput,
} from '../server/catalog-ai-matching';
import { registerCatalogAiMatchRoutes } from '../server/catalog-ai-matching-routes';

const C1 = '10000000-0000-4000-8000-000000000001',
  C2 = '10000000-0000-4000-8000-000000000002';
const def = (extra: any) => ({
  required: false,
  unit: null,
  multiple: false,
  max_values: 1,
  range: false,
  min: null,
  max: null,
  max_length: null,
  dictionary: null,
  ...extra,
});
const snapshot: any = {
  provider: 'allegro',
  scope: 'local_simulation',
  phrase: 'Kubek',
  candidates: [
    { id: C1, name: 'Kubek stalowy', category_id: '123' },
    { id: C2, name: 'Termos', category_id: '124' },
  ],
  categories: {
    '123': {
      parameters: [
        def({
          id: '11323',
          name: 'Stan',
          type: 'dictionary',
          required: true,
          dictionary: [
            { id: '11323_1', value: 'Nowy' },
            { id: '11323_2', value: 'Używany' },
          ],
        }),
        def({
          id: '200',
          name: 'Kolor',
          type: 'dictionary',
          multiple: true,
          max_values: 3,
          dictionary: [
            { id: '200_1', value: 'czarny' },
            { id: '200_2', value: 'biały' },
          ],
        }),
        def({ id: '300', name: 'Pojemność', type: 'integer', unit: 'ml', min: 1, max: 5000 }),
        def({ id: '400', name: 'Materiał', type: 'string', max_length: 20 }),
        def({ id: '500', name: 'Wymiary', type: 'float', range: true }),
        def({ id: '600', name: 'Marka', type: 'string', required: true }),
      ],
    },
    '124': { parameters: [def({ id: '700', name: 'Pojemność termosu', type: 'integer' })] },
  },
};
const source = {
  name: 'Kubek QA',
  description: 'Stalowy kubek 350 ml.',
  category: 'Kuchnia',
  attributes: { Kolor: 'czarny', Materiał: 'stal' },
};
const reasons = (p: any) => Object.fromEntries(p.rejected.map((r: any) => [r.id, r.reason]));

test('valid entries are kept in the Allegro offer format, with current product value', () => {
  const p: any = validateMatchOutput(snapshot, source, {
    candidate_id: C1,
    reason: 'Kubek ze stali',
    parameters: [
      { id: '11323', value_ids: ['11323_1'] },
      { id: '200', values: ['Czarny'] },
      { id: '300', values: ['350'] },
      { id: '400', values: ['stal'] },
      { id: '500', range: { from: '8', to: '9.5' } },
    ],
  });
  assert.deepEqual(p.candidate, snapshot.candidates[0]);
  assert.equal(p.category_id, '123');
  assert.deepEqual(
    p.parameters.map((x: any) => [x.id, x.value]),
    [
      ['11323', { valuesIds: ['11323_1'] }],
      ['200', { valuesIds: ['200_1'] }],
      ['300', { values: ['350'] }],
      ['400', { values: ['stal'] }],
      ['500', { rangeValue: { from: '8', to: '9.5' } }],
    ],
  );
  assert.equal(p.parameters.find((x: any) => x.id === '200').current, 'czarny');
  assert.equal(p.parameters.find((x: any) => x.id === '200').display, 'czarny');
  assert.equal(p.parameters.find((x: any) => x.id === '300').current, null);
  assert.deepEqual(p.rejected, []);
  assert.deepEqual(p.missing_required, [{ id: '600', name: 'Marka' }]);
});

test('unknown id, wrong type and values outside the dictionary are rejected with a reason', () => {
  const p: any = validateMatchOutput(snapshot, source, {
    candidate_id: C1,
    reason: '',
    parameters: [
      { id: '11323', value_ids: ['11323_9'] },
      { id: '999', values: ['x'] },
      { id: '700', values: ['5'] },
      { id: '300', values: ['dużo'] },
      { id: '400', value_ids: ['1'] },
      { id: '200', values: ['zielony'] },
      { id: '600', values: ['<b>Marka</b>'] },
      { id: '500', range: { from: '9', to: '8' } },
    ],
  });
  assert.deepEqual(p.parameters, []);
  const r = reasons(p);
  assert.match(r['11323'], /słownik/);
  assert.match(r['999'], /nie należy do kategorii/);
  assert.match(r['700'], /nie należy do kategorii/, 'a parameter of another candidate category');
  assert.match(r['300'], /liczb/);
  assert.match(r['400'], /rodzaj wartości/);
  assert.match(r['200'], /słownik/);
  assert.match(r['600'], /zwykły tekst/);
  assert.match(r['500'], /zakres/i);
  assert.equal(p.rejected.length, 8);
  assert.deepEqual(
    p.missing_required.map((m: any) => m.id),
    ['11323', '600'],
  );
});

test('limits: duplicates, number of values, bounds, length and one kind of value', () => {
  const p: any = validateMatchOutput(snapshot, source, {
    candidate_id: C1,
    reason: '',
    parameters: [
      { id: '300', values: ['6000'] },
      { id: '300', values: ['350'] },
      { id: '11323', value_ids: ['11323_1', '11323_2'] },
      { id: '400', values: ['x'.repeat(21)] },
      { id: '200', value_ids: ['200_1'], values: ['czarny'] },
      { id: '600', values: [] },
    ],
  });
  const r = reasons(p);
  assert.match(r['300'], /zakresu|minimum|maksimum|powtórz/i);
  assert.equal(p.rejected.filter((x: any) => x.id === '300').length, 2, 'the duplicate is rejected too');
  assert.match(r['11323'], /jedną wartość|liczba wartości/i);
  assert.match(r['400'], /długa/);
  assert.match(r['200'], /rodzaj wartości/);
  assert.match(r['600'], /rodzaj wartości|wartość/);
  assert.deepEqual(p.parameters, []);
  // integer type refuses a fraction.
  const q: any = validateMatchOutput(snapshot, source, {
    candidate_id: C1,
    reason: '',
    parameters: [{ id: '300', values: ['350.5'] }],
  });
  assert.match(reasons(q)['300'], /całkowit/);
});

test('a candidate outside the list leaves no category and rejects every parameter', () => {
  const p: any = validateMatchOutput(snapshot, source, {
    candidate_id: '10000000-0000-4000-8000-000000000099',
    reason: 'Wymyślona kategoria',
    parameters: [{ id: '11323', value_ids: ['11323_1'] }],
  });
  assert.equal(p.candidate, null);
  assert.equal(p.category_id, null);
  assert.deepEqual(p.parameters, []);
  assert.equal(p.rejected[0].kind, 'candidate');
  assert.match(p.rejected[0].reason, /spoza listy/);
  assert.equal(p.rejected[1].id, '11323');
});

test('model output schema is strict and bounded', () => {
  assert.equal(
    matchModelOutput.safeParse({ candidate_id: C1, reason: '', parameters: [], category_id: '1' })
      .success,
    false,
  );
  assert.equal(
    matchModelOutput.safeParse({
      candidate_id: C1,
      reason: '',
      parameters: [{ id: '1', values: ['a'], extra: 1 }],
    }).success,
    false,
  );
  assert.equal(
    matchModelOutput.safeParse({
      candidate_id: C1,
      reason: '',
      parameters: Array.from({ length: 101 }, (_, i) => ({ id: String(i + 1), values: ['a'] })),
    }).success,
    false,
  );
  assert(matchModelOutput.safeParse({ candidate_id: C1, reason: 'ok', parameters: [] }).success);
});

test('accept input requires explicit consent and a parameter list', () => {
  const base = { approve: true, version: 2, candidate_id: C1, category_id: '123', parameters: ['11323'] };
  assert(matchAcceptInput.safeParse(base).success);
  assert.equal(matchAcceptInput.safeParse({ ...base, approve: false }).success, false);
  assert.equal(matchAcceptInput.safeParse({ ...base, category_id: 'abc' }).success, false);
  assert.equal(matchAcceptInput.safeParse({ ...base, parameters: ['1', '1'] }).success, false);
  assert.equal(matchAcceptInput.safeParse({ ...base, values: {} }).success, false);
});

test('Allegro definitions are compacted: describesProduct dropped, dictionaries bounded', () => {
  const out = compactAllegroParameters([
    {
      id: '11323',
      name: 'Stan',
      type: 'dictionary',
      required: true,
      options: { describesProduct: false },
      restrictions: { multipleChoices: false },
      dictionary: Array.from({ length: 80 }, (_, i) => ({ id: '11323_' + i, value: 'W' + i })),
    },
    { id: '1234', name: 'EAN', type: 'string', options: { describesProduct: true } },
    {
      id: '300',
      name: 'Pojemność',
      type: 'integer',
      unit: 'ml',
      restrictions: { min: 1, max: 5000, range: false },
    },
    { id: '400', name: 'Opis', type: 'string', restrictions: { maxLength: 40, allowedNumberOfValues: 2 } },
    { id: 'zły', name: 'X', type: 'string' },
  ]);
  assert.deepEqual(
    out.parameters.map((p: any) => p.id),
    ['11323', '300', '400'],
  );
  assert.equal(out.parameters[0].dictionary!.length, 50);
  assert.equal(out.truncated, true);
  assert.equal(out.parameters[1].min, 1);
  assert.equal(out.parameters[1].unit, 'ml');
  assert.equal(out.parameters[2].max_values, 2);
  assert.equal(out.parameters[2].max_length, 40);
});

test('the model sees only product name, description, category, attributes and the frozen lists', () => {
  const demo = demoAllegroMatchSnapshot('Kubek');
  assert.equal(demo.scope, 'local_simulation');
  assert(demo.candidates.length >= 2);
  for (const c of demo.candidates) assert(demo.categories[c.category_id], 'definitions for ' + c.category_id);
  const input = matchModelInput(
    { ...source, ean: '5901234123457', price: 2500, sku: 'SKU-1' } as any,
    demo,
  );
  assert.deepEqual(Object.keys(input.product).sort(), ['attributes', 'category', 'description', 'name']);
  assert.deepEqual(
    input.candidates.map((c: any) => c.id),
    demo.candidates.map((c) => c.id),
  );
  assert(!JSON.stringify(input).includes('5901234123457'));
  assert(!JSON.stringify(input).includes('SKU-1'));
});

function fragment() {
  const text = readFileSync('server/249_catalog_ai.sql', 'utf8');
  const start = text.indexOf('-- DOM-AI-005:'),
    end = text.indexOf('-- END DOM-AI-005');
  assert(start >= 0 && end > start, 'DOM-AI-005 fragment markers');
  return text.slice(start, end);
}

test('SQL fragment: own objects only, no ALTER of or REFERENCES to core tables, RLS forced', () => {
  const sql = fragment().replace(/--.*$/gm, '');
  const created = [
    ...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|FUNCTION|TRIGGER|POLICY)\s+([a-z0-9_]+)/gi),
  ].map((m) => [m[1].toUpperCase(), m[2]]);
  assert(created.length >= 5);
  for (const [kind, name] of created) {
    if (kind === 'POLICY') assert.equal(name, 'tenant_scope');
    else assert.match(name, /^catalog_ai_match[a-z_]*$/, kind + ' ' + name);
    assert.doesNotMatch(
      name,
      /^(warehouse_wz_issuer|catalog_stock_|local_invoice_|pim_dictionary_|large_import_)/,
    );
  }
  assert.doesNotMatch(sql, /\bREFERENCES\b/i);
  assert.doesNotMatch(sql, /\bFOREIGN\s+KEY\b/i);
  assert.doesNotMatch(sql, /\bDROP\b/i);
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+([a-z0-9_]+)/gi))
    assert.match(m[1], /^catalog_ai_match/, 'ALTER only on own table: ' + m[1]);
  for (const m of sql.matchAll(/\bON\s+(?:TABLE\s+)?([a-z0-9_]+)/gi))
    if (!/^(catalog_ai_match|DELETE|UPDATE|INSERT)/i.test(m[1]))
      assert.fail('object on a foreign table: ' + m[1]);
  assert.match(sql, /ALTER TABLE catalog_ai_match_proposals ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE catalog_ai_match_proposals FORCE ROW LEVEL SECURITY/);
  assert.match(
    sql,
    /CREATE POLICY tenant_scope ON catalog_ai_match_proposals TO dyna_app USING \(tenant_id=nullif\(current_setting\('app\.tenant_id',true\),''\)::uuid\) WITH CHECK \(tenant_id=nullif\(current_setting\('app\.tenant_id',true\),''\)::uuid\)/,
  );
  const grants = [...sql.matchAll(/GRANT\s+([^;]+?)\s+ON/gi)].map((m) => m[1]);
  assert.deepEqual(grants, ['SELECT,INSERT,UPDATE']);
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE/i);
  assert.match(sql, /state IN \('queued','running','ready','accepted','rejected','failed','conflict','cancelled','expired'\)/);
  for (const c of ['request_hash', 'source_hash', 'snapshot_hash', 'model_digest'])
    assert.match(sql, new RegExp(c + " text NOT NULL CHECK \\(" + c + " ~ '\\^\\[a-f0-9\\]\\{64\\}\\$'\\)"));
  assert.match(sql, /BEFORE UPDATE ON catalog_ai_match_proposals/);
  assert.match(sql, /lease_token uuid/);
  assert.match(sql, /locked_at timestamptz/);
});

async function guardApp(options: { available: boolean; readOnly: boolean }, role = 'admin') {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.actor = { tenantId: '00000000-0000-4000-8000-000000000001', userId: C1, role };
  });
  app.setErrorHandler((e: any, _req, reply) => {
    reply.code(e.status ?? e.statusCode ?? 500).send({ detail: e.message });
  });
  registerCatalogAiMatchRoutes(app, options);
  await app.ready();
  return app;
}
const body = {
  version: 1,
  client_key: '20000000-0000-4000-8000-000000000001',
  model: 'qa-local:small',
  integration_id: C2,
};

test('routes: read-only copy refuses writes, missing table gives 503 / available:false, roles 403', async () => {
  const product = '/api/products/' + C1 + '/ai/matches';
  let app = await guardApp({ available: true, readOnly: true });
  for (const [url, payload] of [
    [product, body],
    ['/api/ai/catalog/matches/' + C1 + '/accept', {}],
    ['/api/ai/catalog/matches/' + C1 + '/reject', {}],
    ['/api/ai/catalog/matches/' + C1 + '/cancel', {}],
  ] as const) {
    const r = await app.inject({ url, method: 'POST', payload });
    assert.equal(r.statusCode, 423, url + ' ' + r.body);
  }
  await app.close();
  app = await guardApp({ available: false, readOnly: false });
  let r = await app.inject({ url: product, method: 'POST', payload: body });
  assert.equal(r.statusCode, 503, r.body);
  r = await app.inject({ url: product + '?integration_id=' + C2 });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { available: false, accepted: null, data: [] });
  await app.close();
  for (const role of ['viewer', 'operator']) {
    app = await guardApp({ available: true, readOnly: false }, role);
    assert.equal((await app.inject({ url: product })).statusCode, 403);
    assert.equal((await app.inject({ url: product, method: 'POST', payload: body })).statusCode, 403);
    assert.equal(
      (await app.inject({ url: '/api/ai/catalog/matches/' + C1 + '/accept', method: 'POST', payload: {} }))
        .statusCode,
      403,
    );
    await app.close();
  }
});
