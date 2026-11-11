/** Trusted, inert origin routing. Select once; a failed request never falls through. */
import assert from 'node:assert/strict';
import type {Transport} from './integrations';
import {inspectOrdinaryConnectorTransport, ProviderReadError, type OrdinaryConnectorTransport} from './provider-read-transport';
import {SOAP_CARRIER_ENDPOINTS} from './ordinary-connector-policy';

export function ordinaryConnectorOrigins(connector: OrdinaryConnectorTransport): readonly string[] {
  const capability = inspectOrdinaryConnectorTransport(connector);
  return [...new Set(capability.providers.flatMap(p => {
    if (p.provider === 'woocommerce') return [new URL(p.storeUrl).origin];
    if (p.provider === 'mirakl') return [p.instanceUrl];
    if (p.provider === 'allegro') {
      const domain = p.mode === 'sandbox' ? 'allegro.pl.allegrosandbox.pl' : 'allegro.pl';
      return ['https://' + domain, 'https://api.' + domain];
    }
    if (p.provider === 'inpost') return [p.mode === 'sandbox' ? 'https://sandbox-api-shipx-pl.easypack24.net' : 'https://api-shipx-pl.easypack24.net'];
    if (p.provider === 'dhl') return [new URL(SOAP_CARRIER_ENDPOINTS.dhl[p.mode]).origin];
    if (p.provider === 'pocztapolska') return [new URL(SOAP_CARRIER_ENDPOINTS.pocztapolska[p.mode]).origin,
      ...(p.mode === 'live' ? [new URL(SOAP_CARRIER_ENDPOINTS.pocztapolska_tracking).origin] : [])];
    return [p.mode === 'sandbox' ? 'https://dpdservicesdemo.dpd.com.pl' : 'https://dpdservices.dpd.com.pl',
      ...(p.mode === 'live' ? ['https://dpdinfoservices.dpd.com.pl'] : [])];
  }))];
}

export function assertDisjointConnectorOrigins(connector: OrdinaryConnectorTransport, localOrigins: readonly string[]) {
  const publicOrigins = new Set(ordinaryConnectorOrigins(connector));
  for (const origin of localOrigins) {
    assert.equal(new URL(origin).origin, origin, 'local-transport-exact-origin');
    assert(!publicOrigins.has(origin), 'connector-and-local-Woo-origin-overlap');
  }
}

export function bindOrdinaryConnectorTransport(fallback: Transport | undefined, connector: OrdinaryConnectorTransport | undefined): Transport | undefined {
  if (connector === undefined) return fallback;
  const origins = new Set(ordinaryConnectorOrigins(connector));
  return (url, init) => {
    let origin: string;
    try {origin = new URL(url).origin;} catch {return connector(url, init);}
    if (origins.has(origin)) return connector(url, init);
    if (fallback) return fallback(url, init);
    throw new ProviderReadError('ROUTE');
  };
}
