import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Problem } from '../server/errors';
import {
  DHL_NS,
  escapeXml,
  parseSoapResponse,
  parseXml,
  soapRequest,
  xmlElement,
} from '../server/carrier-dhl-xml';
import { dhlFixture } from './fixtures/dhl/inputs';
const invalid = (e: unknown) => e instanceof Problem && e.status === 502 && e.code === 'DHL_INVALID_RESPONSE';

test('values are escaped and control characters refused', () => {
  assert.equal(escapeXml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  assert.throws(() => escapeXml('a\u0000b'), (e: unknown) => e instanceof Problem && e.status === 422);
  assert.throws(() => xmlElement('bad name', 'x'));
});

test('request envelope keeps injected markup as text', () => {
  const xml = soapRequest('createShipments', {
    authData: { username: 'u', password: 'p&<x>' },
    shipments: [{ receiver: { name: 'Kowalski</name><admin>1</admin>' } }],
    skip: undefined,
  });
  const root = parseXml(xml);
  const op = root.children[0].children[0];
  assert.equal(op.name, 'createShipments');
  assert.equal(op.uri, DHL_NS);
  const receiver = op.children[1].children[0].children[0];
  assert.equal(receiver.children.length, 1);
  assert.equal(receiver.children[0].text, 'Kowalski</name><admin>1</admin>');
  assert.equal(op.children[0].children[1].text, 'p&<x>');
  assert.doesNotMatch(xml, /<skip>/);
});

test('DTDs are refused: no external entity (XXE) and no entity expansion', () => {
  for (const name of ['xxe-external-entity.xml', 'billion-laughs.xml'])
    assert.throws(() => parseSoapResponse(dhlFixture(name), 'getTrackAndTraceInfo'), invalid, name);
  assert.throws(() => parseXml('<a>&undefined;</a>'), invalid);
});

test('processing instructions, second roots, depth and size limits are refused', () => {
  assert.throws(() => parseXml('<?xml-stylesheet href="x"?><a/>'), invalid);
  assert.throws(() => parseXml('<a/><b/>'), invalid);
  assert.throws(() => parseXml('<a>' + '<b>'.repeat(30) + '</b>'.repeat(30) + '</a>'), invalid);
  assert.throws(() => parseXml('<a>' + 'x'.repeat(100) + '</a>', 50), invalid);
  assert.throws(() => parseXml('<a><b></a>'), invalid);
});

test('envelope: wrong namespace or operation is refused, fault is extracted', () => {
  const ok = dhlFixture('create-shipments-ok.xml');
  assert.equal(parseSoapResponse(ok, 'createShipments').fault, null);
  assert.throws(() => parseSoapResponse(ok, 'getLabels'), invalid);
  assert.throws(() => parseSoapResponse(ok.replaceAll(DHL_NS, 'urn:other'), 'createShipments'), invalid);
  assert.throws(
    () => parseSoapResponse(ok.replaceAll('http://schemas.xmlsoap.org/soap/envelope/', 'urn:x'), 'createShipments'),
    invalid,
  );
  const f = parseSoapResponse(dhlFixture('fault-auth.xml'), 'createShipments');
  assert.equal(f.fault?.code, '100');
  assert.match(f.fault!.message, /autoryzacji/);
});
