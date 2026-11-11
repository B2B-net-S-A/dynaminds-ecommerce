/** URL as written to the request log. Secrets that travel in a URL never reach the log: the query of
 * OAuth callbacks, password recovery and the PayU return page and its status poll (?s= return secret,
 * SR4-M3), the 48-hex buyer portal token and the PayU and Mirakl (252) notification path secrets. */
export function requestLogUrl(url: string): string {
  if (url.startsWith('/api/oauth/') || url.startsWith('/api/auth/password/') || url.startsWith('/payu/return/')) return url.split('?')[0]!;
  return url
    .replace(/(\/api\/public\/orders\/)[a-f0-9]{48}/g, '$1[redacted]')
    .replace(/^(\/callbacks\/payu\/[^/?]+\/)[^/?]+/, '$1[redacted]')
    .replace(/^(\/callbacks\/mirakl\/[^/?]+\/)[^/?]+/, '$1[redacted]');
}
