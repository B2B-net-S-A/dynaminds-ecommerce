import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { catalogCsvText, catalogXmlValue } from '../server/catalog-export';
import { Problem } from '../server/errors';
import { parseLanguageFile } from '../server/language-file-import-parse';
import {
  languageFileImportDefinition,
  type LanguageFileImportDefinition,
} from '../server/language-file-import-schema';

// Pure encoding helpers only: no pool/connect, application, fixtures or mutation calls.
// The native runner pins DYNA_LOCAL_CONFIG_PATH for the export module's lazy DB import.
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const csv = (rows: string[][], newline = '\n') =>
  rows.map((r) => r.map(quote).join(';')).join(newline);
const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
function definition(
  extra: Partial<LanguageFileImportDefinition> = {},
): LanguageFileImportDefinition {
  return languageFileImportDefinition.parse({
    format: 'csv',
    mode: 'columns',
    delimiter: ';',
    spreadsheet_safe: false,
    identity: 'sku',
    mapping: { identity: 'SKU' },
    languages: [
      {
        locale: 'de',
        mapping: { name: 'Name', description: 'Description', operation: 'Operation' },
        empty_name: 'preserve',
        empty_description: 'preserve',
      },
    ],
    ...extra,
  });
}
function nativeDefinition(format: 'csv' | 'xml', locales = ['de', 'fr']) {
  return definition({
    format,
    mode: 'translations_json',
    mapping: { identity: 'sku', translations_json: 'translations_json' },
    languages: locales.map((locale) => ({
      locale,
      empty_name: 'preserve' as const,
      empty_description: 'preserve' as const,
    })),
  });
}
function xmlProduct(sku: string, translations: unknown) {
  return `<product>${[...catalogXmlValue('sku', sku)].join('')}${[...catalogXmlValue('translations_json', translations)].join('')}</product>`;
}
const nativeXml = (products: string[]) => `<catalog currency="PLN">${products.join('')}</catalog>`;
function rejected(fn: () => unknown, status = 422) {
  assert.throws(fn, (error: unknown) => error instanceof Problem && error.status === status);
}

test('language file mapped CSV preserves source text and distinguishes set, none and explicit remove', () => {
  const content = csv([
    ['SKU', 'Name', 'Description', 'Operation'],
    ['001', 'Łódź; „produkt”', 'Pierwszy wiersz\nDrugi "cytat"', 'set'],
    ['KEEP', 'Nie zmieniaj', 'Nie zmieniaj', 'none'],
    ['REMOVE', '', '', 'remove'],
    ['EMPTY', '', '', ''],
    ['TEXT-ZERO', '00', '0', ''],
  ]);
  const parsed = parseLanguageFile(content, definition());
  assert.equal(parsed.source_hash, hash(content));
  assert.deepEqual(
    parsed.rows.map((r) => [r.row_number, r.identity]),
    [
      [1, '001'],
      [2, 'KEEP'],
      [3, 'REMOVE'],
      [4, 'EMPTY'],
      [5, 'TEXT-ZERO'],
    ],
  );
  assert.deepEqual(parsed.rows[0].cells[0].patch, {
    name: 'Łódź; „produkt”',
    description: 'Pierwszy wiersz\nDrugi "cytat"',
  });
  assert.deepEqual(
    parsed.rows.map((r) => r.cells[0].operation),
    ['set', 'none', 'remove', 'none', 'set'],
  );
  assert.deepEqual(parsed.rows[4].cells[0].patch, { name: '00', description: '0' });
  for (const row of parsed.rows) {
    assert.deepEqual(row.issues, []);
    assert.deepEqual(row.cells[0].issues, []);
  }
  for (const i of [1, 2, 3]) assert.equal(parsed.rows[i].cells[0].patch, undefined);
});

test('language file blank-description clear is an explicit patch, never implicit remove or a blank name', () => {
  const content = csv([
    ['SKU', 'Name', 'Description', 'Operation'],
    ['EMPTY', '', '', ''],
    ['NONE', 'Tekst', '', 'none'],
    ['REMOVE', '', '', 'remove'],
    ['SPACES', '', '  ', ''],
  ]);
  const preserve = parseLanguageFile(content, definition());
  assert.equal(preserve.rows[0].cells[0].operation, 'none');
  const clear = parseLanguageFile(
    content,
    definition({
      languages: [
        {
          locale: 'de',
          mapping: { name: 'Name', description: 'Description', operation: 'Operation' },
          empty_name: 'preserve',
          empty_description: 'clear',
        },
      ],
    }),
  );
  assert.equal(clear.rows[0].cells[0].operation, 'set');
  assert.deepEqual(clear.rows[0].cells[0].patch, { description: '' });
  assert.equal(clear.rows[1].cells[0].operation, 'none');
  assert.equal(clear.rows[1].cells[0].patch, undefined);
  assert.equal(clear.rows[2].cells[0].operation, 'remove');
  assert.deepEqual(clear.rows[3].cells[0].patch, { description: '  ' });
  rejected(() => parseLanguageFile('SKU;Name;Operation\nOWN;Own;set', definition()));
});

test('language file accepts real export-compatible JSON CSV and typed XML without importing unselected locales', () => {
  const translations = [
    { locale: 'fr', name: 'Produit français', description: '', version: 2 },
    { locale: 'de', name: 'Produkt & Zubehör', description: 'Łódź\n001', version: 7 },
    { locale: 'es', name: 'Producto', description: 'Nie wybrano', version: 3 },
  ];
  const rawSku = '001-Ł';
  const content = csv(
    [
      ['sku', 'translations_json'],
      [
        catalogCsvText(rawSku, 'sku', true),
        catalogCsvText(JSON.stringify(translations), 'translations_json', true),
      ],
      [catalogCsvText('EMPTY', 'sku', true), '[]'],
    ],
    '\r\n',
  );
  const encoded = nativeDefinition('csv');
  encoded.spreadsheet_safe = true;
  const parsedCsv = parseLanguageFile(content, encoded);
  const parsedXml = parseLanguageFile(
    nativeXml([xmlProduct(rawSku, translations), xmlProduct('EMPTY', [])]),
    nativeDefinition('xml'),
  );
  for (const result of [parsedCsv, parsedXml]) {
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].identity, rawSku);
    assert.deepEqual(
      result.rows[0].cells.map((c) => c.locale),
      ['de', 'fr'],
    );
    assert.deepEqual(result.rows[0].cells[0].patch, {
      name: 'Produkt & Zubehör',
      description: 'Łódź\n001',
    });
    assert.deepEqual(result.rows[0].cells[1].patch, { name: 'Produit français' });
    assert.deepEqual(result.rows[0].skipped_locales, ['es']);
    assert.deepEqual(result.rows[0].source_translation_versions, { de: 7, fr: 2, es: 3 });
    assert.deepEqual(
      result.rows[1].cells.map((c) => c.operation),
      ['none', 'none'],
    );
    assert.deepEqual(result.rows[1].issues, []);
  }
  assert.equal(parsedCsv.rows[0].raw_cells.sku, "'001-Ł");
  assert.equal(parseLanguageFile(content, nativeDefinition('csv')).rows[0].identity, "'001-Ł");
});

test('language file rejects malformed or duplicate locale records as whole rows and retains later valid records', () => {
  const valid = { locale: 'de', name: 'Gültig', description: 'Original', version: 4 };
  const bad = [
    '{broken',
    'null',
    JSON.stringify({ de: valid }),
    JSON.stringify([valid, { ...valid, locale: 'DE', name: 'Nie nadpisuj' }]),
    JSON.stringify([valid, { locale: 'fr', name: 12, description: '' }]),
  ];
  const result = parseLanguageFile(
    csv([
      ['sku', 'translations_json'],
      ...bad.map((value, i) => [`BAD-${i}`, value]),
      ['LAST', JSON.stringify([valid])],
    ]),
    nativeDefinition('csv'),
  );
  assert.equal(result.rows.length, bad.length + 1);
  for (const row of result.rows.slice(0, bad.length)) {
    assert(row.issues.length > 0 || row.cells.some((c) => c.issues.length > 0));
    assert(row.cells.every((c) => c.operation === 'none' && c.patch === undefined));
  }
  assert.equal(result.rows.at(-1)?.identity, 'LAST');
  assert.deepEqual(result.rows.at(-1)?.cells[0].patch, { name: 'Gültig', description: 'Original' });
  const missingXml = parseLanguageFile(
    nativeXml([
      '<product><sku type="string">MISSING</sku></product>',
      xmlProduct('VALID', [valid]),
    ]),
    nativeDefinition('xml'),
  );
  assert.equal(missingXml.rows.length, 2);
  assert(
    missingXml.rows[0].issues.length > 0 ||
      missingXml.rows[0].cells.some((c) => c.issues.length > 0),
  );
  assert(missingXml.rows[0].cells.every((c) => c.operation === 'none'));
  assert.equal(missingXml.rows[1].cells[0].operation, 'set');
});

test('language file preserves BOM and CRLF in exact source hash while decoding CSV text losslessly', () => {
  const plain =
    csv(
      [
        ['SKU', 'Name', 'Description', 'Operation'],
        ['001', 'Łódź 😀', 'Pierwszy\r\nDrugi; "cytat"', 'set'],
      ],
      '\r\n',
    ) + '\r\n';
  const content = '\ufeff' + plain;
  const parsed = parseLanguageFile(content, definition());
  assert.equal(parsed.source_hash, hash(content));
  assert.notEqual(parsed.source_hash, hash(plain));
  assert.notEqual(parsed.source_hash, hash(content.replaceAll('\r\n', '\n')));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].raw_cells.Description, 'Pierwszy\r\nDrugi; "cytat"');
  assert.deepEqual(parsed.rows[0].cells[0].patch, {
    name: 'Łódź 😀',
    description: 'Pierwszy\r\nDrugi; "cytat"',
  });
  for (const bad of [content + '\0', content + '\ud800'])
    rejected(() => parseLanguageFile(bad, definition()));
});

test('language file safe CSV reverses exporter prefixes once without deleting genuine text apostrophes', () => {
  const originals = [
    { sku: '001', name: '001', description: '=SUM(1;2)' },
    { sku: "'OWN", name: "'Oryginalny", description: "'Zachowaj apostrof" },
    { sku: 'LAST', name: '+Nazwa', description: '\tPierwszy wiersz' },
  ];
  const content = csv([
    ['SKU', 'Name', 'Description', 'Operation'],
    ...originals.map((r) => [
      catalogCsvText(r.sku, 'sku', true),
      catalogCsvText(r.name, 'name', true),
      catalogCsvText(r.description, 'description', true),
      'set',
    ]),
  ]);
  const decoded = parseLanguageFile(
    content,
    definition({
      spreadsheet_safe: true,
      spreadsheet_text_prefix: 'decode_export',
    }),
  );
  for (const [i, expected] of originals.entries()) {
    assert.equal(decoded.rows[i].identity, expected.sku);
    assert.deepEqual(decoded.rows[i].cells[0].patch, {
      name: expected.name,
      description: expected.description,
    });
    assert.deepEqual(decoded.rows[i].cells[0].issues, []);
  }
  assert.equal(decoded.rows[1].raw_cells.SKU, "''OWN");
  const raw = parseLanguageFile(content, definition({ spreadsheet_safe: false }));
  assert.equal(raw.rows[0].identity, "'001");
  assert.deepEqual(raw.rows[0].cells[0].patch, { name: "'001", description: "'=SUM(1;2)" });
  assert.equal(raw.rows[1].identity, "''OWN");
  assert.deepEqual(raw.rows[1].cells[0].patch, {
    name: "'Oryginalny",
    description: "'Zachowaj apostrof",
  });
});

test('language file reports genuine exporter text collisions until decode or literal intent is explicit', () => {
  const exportedName = catalogCsvText('001', 'name', true);
  const exportedDescription = catalogCsvText('=SUM(1;2)', 'description', true);
  assert.equal(exportedName, catalogCsvText("'001", 'name', true));
  assert.equal(exportedDescription, catalogCsvText("'=SUM(1;2)", 'description', true));
  assert.equal(exportedName, "'001");
  assert.equal(exportedDescription, "'=SUM(1;2)");
  // Two different original text pairs yield the very same bytes: no automatic inverse exists.
  const content = csv([
    ['SKU', 'Name', 'Description', 'Operation'],
    [catalogCsvText('001', 'sku', true), exportedName, exportedDescription, 'set'],
  ]);
  const configured = definition({ spreadsheet_safe: true });
  assert.equal(configured.spreadsheet_text_prefix, 'reject_ambiguous');
  const rejectedText = parseLanguageFile(content, configured).rows[0];
  assert.equal(rejectedText.identity, '001');
  assert.deepEqual(rejectedText.issues, []);
  assert.equal(rejectedText.cells[0].operation, 'set');
  assert(
    rejectedText.cells[0].issues.some(
      (i) => i.startsWith('name:') && i.includes('niejednoznaczny'),
    ),
  );
  assert(
    rejectedText.cells[0].issues.some(
      (i) => i.startsWith('description:') && i.includes('niejednoznaczny'),
    ),
  );
  assert.deepEqual(rejectedText.cells[0].patch, { name: "'001", description: "'=SUM(1;2)" });
  assert.equal(rejectedText.raw_cells.Name, "'001");
  assert.equal(rejectedText.raw_cells.Description, "'=SUM(1;2)");

  const decoded = parseLanguageFile(
    content,
    definition({
      spreadsheet_safe: true,
      spreadsheet_text_prefix: 'decode_export',
    }),
  ).rows[0];
  assert.deepEqual(decoded.cells[0].patch, { name: '001', description: '=SUM(1;2)' });
  assert.deepEqual(decoded.cells[0].issues, []);
  const literal = parseLanguageFile(
    content,
    definition({
      spreadsheet_safe: true,
      spreadsheet_text_prefix: 'preserve_literal',
    }),
  ).rows[0];
  assert.deepEqual(literal.cells[0].patch, { name: "'001", description: "'=SUM(1;2)" });
  assert.deepEqual(literal.cells[0].issues, []);
  // Text policy does not alter identifiers or the raw source evidence.
  for (const row of [decoded, literal]) {
    assert.equal(row.identity, '001');
    assert.deepEqual(row.raw_cells, rejectedText.raw_cells);
  }
});

test('language file explicit none ignores ambiguous text while a name identity still requires its own decision', () => {
  const content = csv([
    ['SKU', 'Name', 'Description', 'Operation'],
    [
      catalogCsvText('001', 'sku', true),
      catalogCsvText('001', 'name', true),
      catalogCsvText('=SUM(1)', 'description', true),
      'none',
    ],
    [catalogCsvText('ALPHA', 'sku', true), "'Oryginalny", "'Zachowaj apostrof", 'set'],
  ]);
  const result = parseLanguageFile(content, definition({ spreadsheet_safe: true }));
  assert.equal(result.rows[0].identity, '001');
  assert.deepEqual(result.rows[0].issues, []);
  assert.equal(result.rows[0].cells[0].operation, 'none');
  assert.equal(result.rows[0].cells[0].patch, undefined);
  assert.deepEqual(result.rows[0].cells[0].issues, []);
  assert.equal(result.rows[0].raw_cells.Name, "'001");
  assert.deepEqual(result.rows[1].cells[0].patch, {
    name: "'Oryginalny",
    description: "'Zachowaj apostrof",
  });
  assert.deepEqual(result.rows[1].cells[0].issues, []);

  const byName = definition({
    spreadsheet_safe: true,
    identity: 'name',
    mapping: { identity: 'Name' },
  });
  const identity = parseLanguageFile(content, byName).rows[0];
  assert.equal(identity.identity, "'001");
  assert(identity.issues.some((i) => i.includes('niejednoznaczny')));
  assert.equal(identity.cells[0].operation, 'none');
  assert.deepEqual(identity.cells[0].issues, []);
  const explicitIdentity = parseLanguageFile(content, {
    ...byName,
    spreadsheet_text_prefix: 'decode_export',
  }).rows[0];
  assert.equal(explicitIdentity.identity, '001');
  assert.deepEqual(explicitIdentity.issues, []);
});

test('language file accepts the whole 500 by six matrix and refuses 501 rows or a seventh locale without truncation', () => {
  const locales = ['pl', 'de', 'fr', 'es', 'it', 'en'];
  const languages = locales.map((locale) => ({
    locale,
    mapping: { name: `Name-${locale}` },
    empty_name: 'preserve' as const,
    empty_description: 'preserve' as const,
  }));
  const configured = definition({ languages });
  const rows = Array.from({ length: 500 }, (_, index) => [
    `SKU-${index}`,
    ...locales.map((locale) => `${locale} tekst ${index}`),
  ]);
  const header = ['SKU', ...locales.map((locale) => `Name-${locale}`)];
  const accepted = parseLanguageFile(csv([header, ...rows]), configured);
  assert.equal(accepted.rows.length, 500);
  assert.equal(
    accepted.rows.reduce((n, r) => n + r.cells.length, 0),
    3000,
  );
  for (const [index, row] of accepted.rows.entries()) {
    assert.equal(row.row_number, index + 1);
    assert.equal(row.identity, `SKU-${index}`);
    assert.deepEqual(
      row.cells.map((c) => c.locale),
      [...locales].sort(),
    );
    for (const cell of row.cells) {
      assert.equal(cell.operation, 'set');
      assert.deepEqual(cell.patch, { name: `${cell.locale} tekst ${index}` });
      assert.deepEqual(cell.issues, []);
    }
  }
  rejected(() =>
    parseLanguageFile(
      csv([header, ...rows, ['OVER', ...locales.map((l) => `${l} extra`)]]),
      configured,
    ),
  );
  assert.equal(
    languageFileImportDefinition.safeParse({
      ...configured,
      languages: [...languages, { ...languages[0], locale: 'cs' }],
    }).success,
    false,
  );
  assert.equal(
    languageFileImportDefinition.safeParse({
      ...configured,
      languages: [
        { ...languages[0], locale: 'de' },
        { ...languages[1], locale: 'DE' },
      ],
    }).success,
    false,
  );
  const xmlRows = Array.from({ length: 500 }, (_, i) =>
    xmlProduct(`XML-${i}`, [{ locale: 'de', name: `Produkt ${i}`, description: '', version: 1 }]),
  );
  const xml = parseLanguageFile(nativeXml(xmlRows), nativeDefinition('xml', ['de']));
  assert.equal(xml.rows.length, 500);
  assert.equal(xml.rows[499].identity, 'XML-499');
  rejected(() =>
    parseLanguageFile(
      nativeXml([...xmlRows, xmlProduct('XML-500', [])]),
      nativeDefinition('xml', ['de']),
    ),
  );
});

test('language file refuses unsafe XML structures and repeated CSV headers rather than guessing a field', () => {
  const valid = nativeXml([
    xmlProduct('OWN', [{ locale: 'de', name: 'Produkt', description: '', version: 1 }]),
  ]);
  for (const content of [
    '<!DOCTYPE catalog [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + valid,
    '<catalog currency="PLN"><product><sku type="string">A</sku><sku type="string">B</sku></product></catalog>',
    '<catalog currency="PLN"><product><constructor type="string">x</constructor></product></catalog>',
  ])
    rejected(() => parseLanguageFile(content, nativeDefinition('xml')));
  rejected(() =>
    parseLanguageFile('SKU;Name;Name;Description;Operation\nA;First;Second;;set', definition()),
  );
  rejected(() => parseLanguageFile('SKU;Name;Description;Operation\nA;"unclosed', definition()));
});
