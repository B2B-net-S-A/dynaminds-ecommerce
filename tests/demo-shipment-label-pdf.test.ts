import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import {
  DEMO_LABEL_PAGE,
  renderDemoShipmentLabel,
  type DemoShipmentLabelInput,
} from '../server/demo-shipment-label-pdf';
import { validatePrintContent } from '../server/print-job-values';

const input: DemoShipmentLabelInput = {
  order_number: 'DE-20261006-TEST',
  tracking_number: 'DEMO-123456789',
  carrier: 'Przewoźnik testowy',
  recipient: {
    name: 'Łukasz Żółć',
    address: {
      street: 'ul. Świętojańska 12\nLokal 3',
      postal_code: '00-001',
      city: 'Łódź',
      country: 'Polska',
    },
  },
};

test('DEMO label is a real one-page 100×150 mm PDF accepted by the print classifier', async () => {
  const bytes = await renderDemoShipmentLabel(input);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), DEMO_LABEL_PAGE);
  assert.equal(pdf.getTitle(), 'DEMO — etykieta testowa');
  assert.equal(pdf.getCreationDate()?.toISOString(), '2000-01-01T00:00:00.000Z');
  assert.equal(pdf.getModificationDate()?.toISOString(), '2000-01-01T00:00:00.000Z');
  assert.equal(validatePrintContent(bytes.toString('base64'), 'pdf').content_bytes, bytes.length);
  assert(bytes.length < 2 * 1024 * 1024);
  assert(!bytes.toString('latin1').includes('/ObjStm'));
});

test('same frozen input produces identical bytes across independent renderer calls', async () => {
  const first = await renderDemoShipmentLabel(input);
  const second = await renderDemoShipmentLabel(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(first, second);
  assert.notDeepEqual(
    first,
    await renderDemoShipmentLabel({ ...input, tracking_number: 'DEMO-DIFFERENT' }),
  );
});

test('Polish Unicode is embedded with its ToUnicode mapping, not silently replaced', async () => {
  const bytes = await renderDemoShipmentLabel(input);
  // Inspect actual embedded PDF streams independently of the renderer layout.
  const binary = bytes.toString('latin1');
  const streams: string[] = [];
  for (const match of binary.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const encoded = match[1];
    // Renderer emits ASCIIHexDecode before the existing FlateDecode filter.
    assert.match(encoded, /^[0-9A-F]+>$/);
    const raw = Buffer.from(encoded.slice(0, -1), 'hex');
    try {
      streams.push(inflateSync(raw).toString('latin1'));
    } catch {
      streams.push(raw.toString('latin1'));
    }
  }
  const cmap = streams.find((s) => s.includes('beginbfchar'));
  assert(cmap, 'Embedded font needs a real ToUnicode map');
  for (const code of ['0141', '017B', '00F3', '0107', '015A']) assert(cmap.includes(code), code);
  assert(binary.includes('/FontFile2') || binary.includes('/FontFile3'));
});

test('unsupported glyph, malformed Unicode and unsafe control input fail explicitly', async () => {
  await assert.rejects(
    renderDemoShipmentLabel({ ...input, carrier: 'Test\u{10FFFF}' }),
    /DEMO_LABEL_UNSUPPORTED_GLYPH/,
  );
  for (const carrier of ['Test\ud800', 'Test\u0000', 'Test\u202e', 'Test\rInjected'])
    await assert.rejects(renderDemoShipmentLabel({ ...input, carrier }));
});

test('multiline overflow and oversized data are rejected, never truncated or given extra pages', async () => {
  await assert.rejects(
    renderDemoShipmentLabel({
      ...input,
      recipient: { ...input.recipient, name: Array(30).fill('Jan').join('\n') },
    }),
    /DEMO_LABEL_OVERFLOW/,
  );
  await assert.rejects(renderDemoShipmentLabel({ ...input, order_number: 'X'.repeat(201) }));
  const multiline = await renderDemoShipmentLabel({
    ...input,
    recipient: { ...input.recipient, name: 'Łukasz\nŻółć' },
  });
  assert.equal((await PDFDocument.load(multiline)).getPageCount(), 1);
});

test('PDF-looking text stays text and creates no action, URL or attachment objects', async () => {
  const bytes = await renderDemoShipmentLabel({
    ...input,
    tracking_number: '/JavaScript /Launch https://example.com',
  });
  validatePrintContent(bytes.toString('base64'), 'pdf');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(
    pdf.catalog.keys().some((k) => ['OpenAction', 'AA', 'Names'].includes(k.decodeText())),
    false,
  );
  assert.equal(pdf.getPage(0).node.Annots()?.size() ?? 0, 0);
});
