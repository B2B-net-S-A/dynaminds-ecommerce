import { readRuntimeResource } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFRawStream, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { z } from 'zod';

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value.trim().length > 0 &&
        Buffer.from(value, 'utf8').toString('utf8') === value &&
        !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value),
      'DEMO_LABEL_TEXT_INVALID',
    );
const inputSchema = z.strictObject({
  order_number: text(200),
  tracking_number: text(200),
  carrier: text(200),
  recipient: z.strictObject({
    name: text(200),
    address: z.strictObject({
      street: text(300),
      postal_code: text(40),
      city: text(150),
      country: text(80),
    }),
  }),
});
export type DemoShipmentLabelInput = z.infer<typeof inputSchema>;
export const DEMO_LABEL_PAGE = { width: (100 * 72) / 25.4, height: (150 * 72) / 25.4 } as const;
const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z');

// Preserve every code point and explicit newline. Long unbroken identifiers are
// wrapped by glyph width, never cut or silently replaced with an ellipsis.
function wrap(value: string, font: PDFFont, size: number, width: number): string[] {
  const result: string[] = [];
  for (const paragraph of value.split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (font.widthOfTextAtSize(character, size) > width) throw new Error('DEMO_LABEL_OVERFLOW');
      if (line && font.widthOfTextAtSize(line + character, size) > width) {
        result.push(line);
        line = '';
      }
      line += character;
    }
    result.push(line);
  }
  return result;
}

/** Fixed font accessor; this resource's original source consumer owns the URL. */
export function readNotoDocumentFont(): Promise<Uint8Array> {
  return readRuntimeResource('font:demo-shipment-label', import.meta.url);
}

/** Local demonstration document. It is not a carrier label or postage evidence. */
export async function renderDemoShipmentLabel(input: DemoShipmentLabelInput): Promise<Buffer> {
  const value = inputSchema.parse(input);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setTitle('DEMO — etykieta testowa');
  doc.setAuthor('Dynaminds');
  doc.setCreator('Dynaminds DEMO label renderer');
  doc.setProducer('Dynaminds DEMO label renderer');
  const font = await doc.embedFont(await readRuntimeResource('font:demo-shipment-label', import.meta.url), { subset: true });
  const fields: [string, string][] = [
    ['Zamówienie', value.order_number],
    ['Numer śledzenia DEMO', value.tracking_number],
    ['Przewoźnik (opis testowy)', value.carrier],
    ['Odbiorca', value.recipient.name],
    ['Ulica / adres', value.recipient.address.street],
    [
      'Kod pocztowy / miejscowość',
      value.recipient.address.postal_code + ' ' + value.recipient.address.city,
    ],
    ['Kraj', value.recipient.address.country],
  ];
  const fixed = [
    'DEMO',
    'NOT A CARRIER LABEL',
    'ETYKIETA TESTOWA — NIE NADAWAĆ',
    'Dokument lokalny. Nie potwierdza nadania ani opłaty.',
  ];
  const supported = new Set(font.getCharacterSet());
  for (const s of [...fixed, ...fields.flat()])
    for (const ch of s) {
      if (ch !== '\n' && !supported.has(ch.codePointAt(0)!))
        throw new Error('DEMO_LABEL_UNSUPPORTED_GLYPH');
    }
  const { width, height } = DEMO_LABEL_PAGE;
  const margin = 14,
    usableWidth = width - 2 * margin,
    size = 10,
    lineHeight = 13;
  const layout = fields.map(([label, s]) => ({ label, lines: wrap(s, font, size, usableWidth) }));
  const top = height - 91,
    footerTop = 41;
  if (layout.reduce((h, f) => h + 12 + f.lines.length * lineHeight + 7, 0) > top - footerTop)
    throw new Error('DEMO_LABEL_OVERFLOW');
  const page = doc.addPage([width, height]);
  page.drawRectangle({
    x: margin,
    y: height - 75,
    width: usableWidth,
    height: 61,
    borderWidth: 2,
    borderColor: rgb(0, 0, 0),
  });
  page.drawText(fixed[0], { x: margin + 8, y: height - 40, size: 24, font });
  page.drawText(fixed[1], { x: margin + 8, y: height - 55, size: 11, font });
  page.drawText(fixed[2], { x: margin + 8, y: height - 68, size: 8.5, font });
  let y = top;
  for (const field of layout) {
    page.drawText(field.label, { x: margin, y, size: 8, font });
    y -= 12;
    for (const line of field.lines) {
      if (line) page.drawText(line, { x: margin, y, size, font });
      y -= lineHeight;
    }
    y -= 7;
  }
  page.drawLine({ start: { x: margin, y: 35 }, end: { x: width - margin, y: 35 }, thickness: 1 });
  for (const [i, line] of wrap(fixed[3], font, 8, usableWidth).entries())
    page.drawText(line, { x: margin, y: 23 - i * 10, size: 8, font });
  const saved = await doc.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
  // Binary font/content streams can accidentally resemble escaped PDF names to
  // the unchanged print classifier. Encode every emitted stream as ASCII hex;
  // PDF readers decode this outer filter before the original compression.
  const printable = await PDFDocument.load(saved, { updateMetadata: false });
  for (const [ref, object] of printable.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict.clone(printable.context);
    const filter = dict.lookup(PDFName.of('Filter'));
    const filters = filter instanceof PDFArray ? filter.asArray() :
      filter instanceof PDFName ? [filter] : [];
    if (filter && filter !== PDFNull && !(filter instanceof PDFName) && !(filter instanceof PDFArray))
      throw new Error('DEMO_LABEL_STREAM_FILTER_INVALID');
    const parameters = dict.lookup(PDFName.of('DecodeParms'));
    if (parameters && parameters !== PDFNull) {
      if (parameters instanceof PDFArray && parameters.size() === filters.length) {
        dict.set(PDFName.of('DecodeParms'), printable.context.obj([PDFNull, ...parameters.asArray()]));
      } else if (parameters instanceof PDFDict && filter instanceof PDFName) {
        dict.set(PDFName.of('DecodeParms'), printable.context.obj([PDFNull, parameters]));
      } else {
        throw new Error('DEMO_LABEL_STREAM_PARAMETERS_INVALID');
      }
    }
    dict.set(PDFName.of('Filter'), printable.context.obj([PDFName.of('ASCIIHexDecode'), ...filters]));
    const hex = Buffer.from(object.getContents()).toString('hex').toUpperCase() + '>';
    printable.context.assign(ref, PDFRawStream.of(dict, Buffer.from(hex, 'ascii')));
  }
  return Buffer.from(
    await printable.save({
      useObjectStreams: false,
      addDefaultPage: false,
      updateFieldAppearances: false,
    }),
  );
}
