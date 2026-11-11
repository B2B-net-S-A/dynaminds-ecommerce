import { createHash } from 'node:crypto';
import { connectionHash } from './offer-sync-policy';
import { decrypt } from './security';
const TRACKING_PROVIDERS = ['inpost', 'dpd', 'dhl', 'pocztapolska'];
export const trackingSupported = (ch: any) => TRACKING_PROVIDERS.includes(ch?.provider);
export const trackingConnection = (ch: any) =>
  ['dpd', 'dhl', 'pocztapolska'].includes(ch?.provider)
    ? createHash('sha256')
        .update(
          JSON.stringify({
            provider: ch.provider,
            mode: ch.mode,
            settings: ch.settings,
            credentials: ch.credentials,
          }),
        )
        .digest('hex')
    : connectionHash(ch);
export function trackingReady(ch: any) {
  if (!trackingSupported(ch)) return false;
  if (ch.settings.simulation) return true;
  // DHL24 has its own sandbox track and trace; the Poczta Polska tracking service is one public
  // service for both eNadawca environments and needs its own login (tracking_login/password).
  if (ch.provider === 'dhl') {
    const creds = decrypt(ch.credentials);
    return Boolean(creds.username && creds.password);
  }
  if (ch.provider === 'pocztapolska') {
    const creds = decrypt(ch.credentials);
    return Boolean(creds.tracking_login && creds.tracking_password);
  }
  if (ch.mode !== 'live') return false;
  if (ch.provider === 'inpost') return true;
  const creds = decrypt(ch.credentials);
  return Boolean(creds.info_login && creds.info_password);
}
