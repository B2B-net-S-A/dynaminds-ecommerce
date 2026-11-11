import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, PDFNumber, type PDFPage } from 'pdf-lib';
import { printUuid, validatePrintContent } from './print-job-values';
import { SHIPMENT_LABEL_BATCH_LIMITS as limits } from './shipment-label-batch-values';

export type ShipmentLabelBatchPdfSource = {
  shipment_id: string;
  asset_id: string;
  content_base64: string;
  content_sha256: string;
  content_bytes: number;
  layout: 'A4' | 'A6';
};
function fail(): never {
  throw new Error('SHIPMENT_LABEL_BATCH_PDF_INVALID');
}
const dimensions = { A4: [595.2756, 841.8898], A6: [297.6378, 419.5276] } as const;

function decode(base64: string, sha: string, expectedBytes: number, maximum: number) {
  if (
    typeof base64 !== 'string' ||
    base64.length > 4 * Math.ceil(maximum / 3) ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
    !/^[a-f0-9]{64}$/.test(sha) ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > maximum
  )
    fail();
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.length !== expectedBytes ||
    bytes.toString('base64') !== base64 ||
    createHash('sha256').update(bytes).digest('hex') !== sha
  )
    fail();
  const text = bytes.toString('latin1');
  // Same conservative active-content boundary as the individual print job;
  // this is not a general PDF sanitiser.
  if (
    !/^%PDF-1\.[0-9]/.test(text) ||
    !/%%EOF[\r\n\t ]*$/.test(text) ||
    /\/(?:JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile)\b/i.test(text) ||
    /#[0-9a-f]{2}/i.test(text)
  )
    fail();
  return bytes;
}

async function load(bytes: Buffer) {
  try {
    const doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    if (doc.isEncrypted || doc.getPageCount() < 1 || doc.getPageCount() > limits.max_pages) fail();
    return doc;
  } catch {
    return fail();
  }
}

function validatePage(page: PDFPage, layout: 'A4' | 'A6') {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const [width, height] = dimensions[layout];
  const fits = (w: number, h: number) =>
    (Math.abs(w - width) <= 2 && Math.abs(h - height) <= 2) ||
    (Math.abs(w - height) <= 2 && Math.abs(h - width) <= 2);
  const rotation = page.getRotation().angle;
  const unit = page.node.get(PDFName.of('UserUnit'));
  if (
    [
      media.x,
      media.y,
      media.width,
      media.height,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      rotation,
    ].some((v) => !Number.isFinite(v)) ||
    !fits(media.width, media.height) ||
    !fits(crop.width, crop.height) ||
    crop.x < media.x ||
    crop.y < media.y ||
    crop.x + crop.width > media.x + media.width + 0.001 ||
    crop.y + crop.height > media.y + media.height + 0.001 ||
    !Number.isInteger(rotation) ||
    rotation % 90 !== 0 ||
    (unit !== undefined && (!(unit instanceof PDFNumber) || unit.asNumber() !== 1))
  )
    fail();
}

/** Combined review artifact has its own 16 MiB bound, unlike an individual job. */
export async function validateShipmentLabelBatchContent(
  base64: string,
  expectedSha256: string,
  expectedBytes: number,
) {
  const bytes = decode(base64, expectedSha256, expectedBytes, limits.max_combined_bytes);
  const doc = await load(bytes);
  const first = doc.getPage(0).getMediaBox();
  const layout = (Object.keys(dimensions) as ('A4' | 'A6')[]).find((key) => {
    const [w, h] = dimensions[key];
    return (
      (Math.abs(first.width - w) <= 2 && Math.abs(first.height - h) <= 2) ||
      (Math.abs(first.width - h) <= 2 && Math.abs(first.height - w) <= 2)
    );
  });
  if (!layout) fail();
  for (const page of doc.getPages()) validatePage(page, layout);
  return {
    content_base64: base64,
    content_sha256: expectedSha256,
    content_bytes: bytes.length,
    pages: doc.getPageCount(),
    layout,
  };
}

export async function renderShipmentLabelBatchPdf(sources: ShipmentLabelBatchPdfSource[]) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > limits.max_shipments)
    fail();
  const layout = sources[0].layout;
  if (!(layout in dimensions)) fail();
  const combined = await PDFDocument.create();
  combined.setCreationDate(new Date('2000-01-01T00:00:00Z'));
  combined.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  combined.setProducer('Dynaminds shipment label batch');
  combined.setCreator('Dynaminds');
  const seen = new Set<string>();
  let bytesTotal = 0;
  let pagesTotal = 0;
  const rows: {
    index: number;
    shipment_id: string;
    asset_id: string;
    pages: number;
    page_from: number;
    page_to: number;
  }[] = [];
  for (const [index, source] of sources.entries()) {
    const shipment = printUuid.parse(source.shipment_id);
    const asset = printUuid.parse(source.asset_id);
    if (seen.has(shipment) || source.layout !== layout) fail();
    seen.add(shipment);
    const bytes = decode(
      source.content_base64,
      source.content_sha256,
      source.content_bytes,
      limits.max_source_bytes,
    );
    validatePrintContent(source.content_base64, 'pdf');
    bytesTotal += bytes.length;
    if (bytesTotal > limits.max_combined_bytes) fail();
    const doc = await load(bytes);
    const pages = doc.getPageCount();
    if (pagesTotal + pages > limits.max_pages) fail();
    for (const page of doc.getPages()) validatePage(page, layout);
    const copied = await combined.copyPages(doc, doc.getPageIndices());
    copied.forEach((page) => combined.addPage(page));
    rows.push({
      index,
      shipment_id: shipment,
      asset_id: asset,
      pages,
      page_from: pagesTotal + 1,
      page_to: pagesTotal + pages,
    });
    pagesTotal += pages;
  }
  const bytes = Buffer.from(await combined.save({ useObjectStreams: false }));
  const sha = createHash('sha256').update(bytes).digest('hex');
  const verified = await validateShipmentLabelBatchContent(
    bytes.toString('base64'),
    sha,
    bytes.length,
  );
  if (verified.pages !== pagesTotal) fail();
  return { format: 'pdf' as const, ...verified, layout, rows };
}
