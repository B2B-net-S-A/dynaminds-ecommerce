/** Trusted server construction option, never a request-controlled allowlist.
 * Accept only a canonical origin with an explicit non-default TCP port. */
export function validateTrustedLocalUiOrigin(origin: string): string {
  const invalid = () => new TypeError('trustedLocalUiOrigin requires a canonical loopback HTTP(S) origin with an explicit port');
  if (typeof origin !== 'string') throw invalid();
  let url: URL;
  try { url = new URL(origin); } catch { throw invalid(); }
  const hostname = url.hostname;
  const localhost = hostname === 'localhost' || (
    hostname.endsWith('.localhost') && hostname.length <= 253 &&
    hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  );
  if (!['http:', 'https:'].includes(url.protocol) ||
    (!['127.0.0.1', '[::1]'].includes(hostname) && !localhost) ||
    url.username !== '' || url.password !== '' || url.pathname !== '/' ||
    url.search !== '' || url.hash !== '' || url.port === '' ||
    !/^[1-9][0-9]{0,4}$/.test(url.port) || Number(url.port) > 65535 ||
    url.origin !== origin) throw invalid();
  return origin;
}
