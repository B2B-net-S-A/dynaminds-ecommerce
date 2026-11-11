import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { demoAmazonCatalog } from '../server/amazon-example';
import { AMAZON_REPORT, AMAZON_LISTING_DATA } from '../server/amazon-catalog';
import { amazonConfig, amazonSecrets } from './amazon-fixture';
import type { Transport } from '../server/integrations';
export const amazonCatalogConfig = { ...amazonConfig, selling_partner_id: 'ADEMO074' };
export function amazonCatalogFixture(count?: number) {
  const template = demoAmazonCatalog().at(-1)!;
  const items =
    count === undefined
      ? demoAmazonCatalog()
      : Array.from({ length: count }, (_, i) => ({
          ...structuredClone(template),
          sku: 'AMZ-' + String(i).padStart(6, '0'),
        }));
  const calls: { path: string; method: string }[] = [];
  const state = {
    token: 0,
    status: 'DONE',
    gzip: true,
    edit: undefined as undefined | ((path: string, value: any) => void),
    hook: undefined as undefined | ((u: URL) => Promise<void>),
    fail429: false,
    skus: items.map((i) => i.sku),
    documentUrl:
      'https://qa-amazon.s3.eu-west-1.amazonaws.com/listings.tsv?X-Amz-Signature=PRIVATE-DEMO',
  };
  const transport: Transport = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: String(init.method) });
    assert.equal(init.redirect, 'error');
    await state.hook?.(u);
    let value: any;
    if (u.origin === 'https://api.amazon.com') {
      assert.equal(init.method, 'POST');
      assert.equal(
        new URLSearchParams(init.body as string).get('refresh_token'),
        amazonSecrets.refresh_token,
      );
      value = {
        access_token: 'CATALOG-DEMO-' + ++state.token,
        token_type: 'bearer',
        expires_in: 3600,
      };
    } else if (u.hostname === 'qa-amazon.s3.eu-west-1.amazonaws.com') {
      assert.equal(init.method, 'GET');
      assert.equal((init.headers as any)['x-amz-access-token'], undefined);
      assert.equal((init.headers as any).Authorization, undefined);
      const quote = (v: string) => '"' + v.replace(/"/g, '""') + '"';
      const tsv =
        '\uFEFFitem-name\tseller-sku\tprice\tquantity\r\n' +
        state.skus
          .map((sku) => '"Description\twith\nnewline"\t' + quote(sku) + '\t999.99\t9000')
          .join('\r\n');
      return new Response(state.gzip ? gzipSync(tsv) : tsv, {
        headers: { 'content-type': 'text/plain; charset=UTF-8' },
      });
    } else {
      assert.equal(u.origin, 'https://sandbox.sellingpartnerapi-eu.amazon.com');
      assert.equal((init.headers as any)['x-amz-access-token'], 'CATALOG-DEMO-' + state.token);
      if (state.fail429 && u.pathname.startsWith('/listings/'))
        return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
      if (u.pathname === '/reports/2021-06-30/reports') {
        assert.equal(init.method, 'POST');
        const p = JSON.parse(String(init.body));
        assert.equal(p.reportType, AMAZON_REPORT);
        assert.deepEqual(p.marketplaceIds, [amazonConfig.marketplace_id]);
        assert.equal(p.reportOptions.preferredReportDocumentLocale, 'en_US');
        value = { reportId: 'REPORT074' };
      } else if (u.pathname === '/reports/2021-06-30/reports/REPORT074') {
        value = {
          reportId: 'REPORT074',
          reportType: AMAZON_REPORT,
          marketplaceIds: [amazonConfig.marketplace_id],
          processingStatus: state.status,
          reportDocumentId: 'DOC074',
        };
      } else if (u.pathname === '/reports/2021-06-30/documents/DOC074') {
        value = {
          reportDocumentId: 'DOC074',
          url: state.documentUrl,
          ...(state.gzip ? { compressionAlgorithm: 'GZIP' } : {}),
        };
      } else if (u.pathname.startsWith('/listings/2021-08-01/items/ADEMO074')) {
        assert.equal(init.method, 'GET');
        assert.equal(u.searchParams.get('marketplaceIds'), amazonConfig.marketplace_id);
        assert.equal(u.searchParams.get('includedData'), AMAZON_LISTING_DATA);
        if (u.pathname.endsWith('/ADEMO074')) {
          assert.equal(u.searchParams.get('identifiersType'), 'SKU');
          assert.equal(u.searchParams.get('pageSize'), '20');
          const skus = u.searchParams.get('identifiers')!.split(',');
          assert(skus.length <= 20);
          const found = items.filter((i) => skus.includes(i.sku));
          value = { numberOfResults: found.length, items: found };
        } else
          value = items.find((i) => i.sku === decodeURIComponent(u.pathname.split('/').at(-1)!));
      } else throw new Error('Unexpected Amazon resource ' + u.pathname);
    }
    value = structuredClone(value);
    state.edit?.(u.pathname, value);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  return { items, calls, state, transport };
}
