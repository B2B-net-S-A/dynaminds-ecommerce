import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderDemoShipmentLabel } from '../server/demo-shipment-label-pdf';
import { recoveredLabelBytes } from '../server/recovery-label-files';

test('recovery retains the full binary PDF and embedded Polish font bytes', async () => {
  const pdf = await renderDemoShipmentLabel({
    order_number: 'RECOVERY-QA147',
    tracking_number: 'DEMO-QA147',
    carrier: 'Symulator lokalny',
    recipient: {
      name: 'Łukasz Żółć',
      address: {
        street: 'Świętojańska 147',
        postal_code: '00-147',
        city: 'Warszawa',
        country: 'PL',
      },
    },
  });
  const body = { content_base64: pdf.toString('base64') },
    head = {
      format: 'pdf',
      content_bytes: pdf.length,
      content_sha256: createHash('sha256').update(pdf).digest('hex'),
    };
  assert.deepEqual(recoveredLabelBytes(body, head), pdf);
  const changed = Buffer.from(pdf);
  changed[changed.length - 12] ^= 1;
  assert.throws(
    () => recoveredLabelBytes({ content_base64: changed.toString('base64') }, head),
    /nie odpowiada/,
  );
  assert.throws(
    () => recoveredLabelBytes({ content_base64: pdf.subarray(0, -1).toString('base64') }, head),
    /nie odpowiada/,
  );
  assert.throws(
    () => recoveredLabelBytes({ content_base64: body.content_base64 + '\n' }, head),
    /nie odpowiada/,
  );
  assert.throws(() => recoveredLabelBytes(body, { ...head, format: 'zpl' }), /nie odpowiada/);
});

test('recovery rejects missing content, malformed metadata and mislabeled HTML without exposing data', () => {
  const html = Buffer.from('<html>private label contents</html>'),
    head = {
      format: 'pdf',
      content_bytes: html.length,
      content_sha256: createHash('sha256').update(html).digest('hex'),
    };
  for (const body of [null, [], {}, { content_base64: html.toString('base64') }])
    assert.throws(() => recoveredLabelBytes(body, head), {
      message: 'Odtworzona etykieta nie odpowiada metadanym',
    });
  assert.throws(
    () => recoveredLabelBytes({ content_base64: 'JVBERg==' }, { ...head, content_bytes: '4' }),
    /nie odpowiada/,
  );
  assert.throws(
    () => recoveredLabelBytes({ content_base64: 'JVBERg==' }, { ...head, content_bytes: 2097153 }),
    /nie odpowiada/,
  );
});
