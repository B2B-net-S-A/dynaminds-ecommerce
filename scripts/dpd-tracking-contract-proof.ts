import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { DPD_INFO_ENDPOINT } from '../server/dpd-info';
const results = [];
for (const query of ['?wsdl', '?xsd=1']) {
  const r = await fetch(DPD_INFO_ENDPOINT + query, { signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert(text.includes('http://events.dpdinfoservices.dpd.com.pl/'));
  assert(text.includes('getEventsForWaybillV1'));
  if (query === '?wsdl') assert(text.includes('soapAction=""'));
  else
    for (const name of ['eventsList', 'customerEventsResponseV3', 'authDataV1', 'eventDataList'])
      assert(text.includes(name));
  results.push({
    url: DPD_INFO_ENDPOINT + query,
    http: r.status,
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
}
const proof = {
  checked_at: new Date().toISOString(),
  scope: 'official_public_DPD_WSDL_XSD_GET_only',
  results,
  namespace: 'http://events.dpdinfoservices.dpd.com.pl/',
  operation: 'getEventsForWaybillV1',
  soap_action: '',
  event_select: 'ALL',
  authentication: 'separate_InfoServices_account_required',
  authenticated_provider_tracking_verified: false,
  soap_provider_requests: 0,
};
await writeFile('docs/dpd-tracking-contract-qa.json', JSON.stringify(proof, null, 2) + '\n');
console.log(proof);
