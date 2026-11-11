import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFArray, PDFRawStream, degrees, PDFName, PDFNumber } from 'pdf-lib';
import {
  renderShipmentLabelBatchPdf,
  validateShipmentLabelBatchContent,
  type ShipmentLabelBatchPdfSource,
} from '../server/shipment-label-batch-pdf';

function envelope(bytes: Buffer, layout: 'A4' | 'A6' = 'A6'): ShipmentLabelBatchPdfSource {
  return {
    shipment_id: randomUUID(),
    asset_id: randomUUID(),
    layout,
    content_base64: bytes.toString('base64'),
    content_bytes: bytes.length,
    content_sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
async function pdf(
  markers: string[],
  size: [number, number] = [297.64, 419.53],
  configure?: (doc: PDFDocument) => void,
) {
  const doc = await PDFDocument.create();
  for (const marker of markers) doc.addPage(size).drawText(marker, { x: 20, y: 20 });
  configure?.(doc);
  return Buffer.from(await doc.save({ useObjectStreams: false, addDefaultPage: false }));
}
function pageText(doc: PDFDocument, index: number) {
  const value = doc.getPage(index).node.Contents();
  const objects =
    value instanceof PDFArray ? value.asArray().map((ref) => doc.context.lookup(ref)) : [value];
  return objects
    .map((object) => {
      assert(object instanceof PDFRawStream);
      const bytes = Buffer.from(object.getContents());
      return object.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode'
        ? inflateSync(bytes).toString('latin1')
        : bytes.toString('latin1');
    })
    .join('\n');
}

test('multi-page content retains caller order, every marker and original page boxes', async () => {
  const first = envelope(await pdf(['FIRST', 'SECOND']));
  const second = envelope(
    await pdf(['THIRD'], [419.53, 297.64], (doc) => doc.getPage(0).setRotation(degrees(90))),
  );
  const originalBytes = first.content_base64;
  const result = await renderShipmentLabelBatchPdf([first, second]);
  const loaded = await PDFDocument.load(Buffer.from(result.content_base64, 'base64'));
  assert.equal(loaded.getPageCount(), 3);
  for (const [index, marker] of ['FIRST', 'SECOND', 'THIRD'].entries())
    assert(pageText(loaded, index).includes(Buffer.from(marker).toString('hex').toUpperCase()));
  assert.deepEqual(loaded.getPage(2).getMediaBox(), { x: 0, y: 0, width: 419.53, height: 297.64 });
  assert.equal(loaded.getPage(2).getRotation().angle, 90);
  assert.deepEqual(result.rows, [
    {
      index: 0,
      shipment_id: first.shipment_id,
      asset_id: first.asset_id,
      pages: 2,
      page_from: 1,
      page_to: 2,
    },
    {
      index: 1,
      shipment_id: second.shipment_id,
      asset_id: second.asset_id,
      pages: 1,
      page_from: 3,
      page_to: 3,
    },
  ]);
  assert.equal(first.content_base64, originalBytes);
  assert.equal(result.layout, 'A6');
  assert.deepEqual(
    await validateShipmentLabelBatchContent(
      result.content_base64,
      result.content_sha256,
      result.content_bytes,
    ),
    {
      content_base64: result.content_base64,
      content_sha256: result.content_sha256,
      content_bytes: result.content_bytes,
      pages: 3,
      layout: 'A6',
    },
  );
});

test('same frozen sources produce deterministic combined bytes and metadata', async () => {
  const sources = [envelope(await pdf(['DETERMINISTIC']))];
  const first = await renderShipmentLabelBatchPdf(sources);
  assert.deepEqual(first, await renderShipmentLabelBatchPdf(JSON.parse(JSON.stringify(sources))));
  const loaded = await PDFDocument.load(Buffer.from(first.content_base64, 'base64'), {
    updateMetadata: false,
  });
  assert.equal(loaded.getCreationDate()?.toISOString(), '2000-01-01T00:00:00.000Z');
  assert.equal(loaded.getModificationDate()?.toISOString(), '2000-01-01T00:00:00.000Z');
});

test('provider layout metadata cannot admit wrong media, cropped or scaled pages', async () => {
  const wrong = envelope(await pdf(['WRONG'], [200, 300]));
  await assert.rejects(renderShipmentLabelBatchPdf([wrong]), /SHIPMENT_LABEL_BATCH_PDF_INVALID/);
  for (const configure of [
    (doc: PDFDocument) => doc.getPage(0).setCropBox(0, 0, 200, 300),
    (doc: PDFDocument) => doc.getPage(0).setCropBox(-1, 0, 297.64, 419.53),
    (doc: PDFDocument) => doc.getPage(0).node.set(PDFName.of('UserUnit'), PDFNumber.of(2)),
  ])
    await assert.rejects(
      renderShipmentLabelBatchPdf([envelope(await pdf(['CROP'], undefined, configure))]),
    );
  const a4 = envelope(await pdf(['A4'], [595.28, 841.89]), 'A4');
  assert.equal((await renderShipmentLabelBatchPdf([a4])).layout, 'A4');
  await assert.rejects(renderShipmentLabelBatchPdf([a4, envelope(await pdf(['A6']))]));
});

test('hash, size, base64, duplicate identities and active PDF bytes fail closed', async () => {
  const source = envelope(await pdf(['SAFE']));
  for (const change of [
    { content_sha256: '0'.repeat(64) },
    { content_bytes: source.content_bytes + 1 },
    { content_base64: source.content_base64 + '\n' },
    { content_bytes: 2097153 },
  ])
    await assert.rejects(renderShipmentLabelBatchPdf([{ ...source, ...change }]));
  await assert.rejects(
    renderShipmentLabelBatchPdf([source, { ...source, asset_id: randomUUID() }]),
  );
  const unsafe = Buffer.from('%PDF-1.7\n/JavaScript /OpenAction\n%%EOF\n');
  await assert.rejects(renderShipmentLabelBatchPdf([envelope(unsafe)]));
  await assert.rejects(
    renderShipmentLabelBatchPdf([envelope(Buffer.from('%PDF-1.7\nmalformed\n%%EOF\n'))]),
  );
});

test('empty documents and cumulative page overflow are rejected without truncation', async () => {
  await assert.rejects(renderShipmentLabelBatchPdf([]));
  await assert.rejects(renderShipmentLabelBatchPdf([envelope(await pdf([]))]));
  const first = envelope(await pdf(Array.from({ length: 250 }, (_, i) => `A${i}`)));
  const second = envelope(await pdf(Array.from({ length: 251 }, (_, i) => `B${i}`)));
  await assert.rejects(renderShipmentLabelBatchPdf([first, second]));
});

test('combined validator admits a genuine PDF above the individual 2 MiB limit', async () => {
  const bytes = await pdf(['LARGE REVIEW']);
  const eof = bytes.lastIndexOf('%%EOF');
  const larger = Buffer.concat([
    bytes.subarray(0, eof),
    Buffer.alloc(2097152, 32),
    bytes.subarray(eof),
  ]);
  const source = envelope(larger);
  const verified = await validateShipmentLabelBatchContent(
    source.content_base64,
    source.content_sha256,
    source.content_bytes,
  );
  assert.equal(verified.pages, 1);
  assert.equal(verified.content_bytes, larger.length);
  assert.equal(verified.layout, 'A6');
  await assert.rejects(renderShipmentLabelBatchPdf([source]));
  await assert.rejects(
    validateShipmentLabelBatchContent(source.content_base64, source.content_sha256, 16777217),
  );
});
