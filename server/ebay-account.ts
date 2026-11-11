import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { ensure, Problem } from './errors';
import { ebayBase, ebaySecret, EBAY_TRADING_SCOPE } from './ebay';
import type { Transport } from './integrations';
import {
  EbayApiWait,
  ebayLimitedTransport,
  sendEbayReserved,
  type EbayApiPermit,
} from './ebay-api-limits';

export { EBAY_TRADING_SCOPE };
export const EBAY_TRADING_VERSION = '1477';
const NS = 'urn:ebay:apis:eBLBaseComponents';
const LIMIT = 128 * 1024;
type Node = { name: string; uri: string; text: string; children: Node[] };
function invalid(): never {
  throw new Problem(502, 'Nieprawidłowa odpowiedź identyfikacji konta eBay');
}
// Never retain the full profile (email, address, phones) or treat a mutable username as identity.
export function parseEbayAccount(xml: string, mode: string) {
  if (Buffer.byteLength(xml) > LIMIT) invalid();
  const parser = new SaxesParser({ xmlns: true }),
    stack: Node[] = [];
  let root: Node | undefined,
    count = 0;
  parser.on('doctype', invalid);
  parser.on('error', invalid);
  parser.on('opentag', (tag) => {
    if (++count > 5000 || stack.length >= 20) invalid();
    const n: Node = { name: tag.local, uri: tag.uri, text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(n);
    else root = n;
    stack.push(n);
  });
  const text = (s: string) => {
    const n = stack.at(-1);
    if (n) {
      n.text += s;
      if (n.text.length > 10000) invalid();
    }
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch {
    invalid();
  }
  if (!root || root.name !== 'GetUserResponse' || root.uri !== NS) invalid();
  const children = (n: Node, name: string) =>
    n.children.filter((c) => c.name === name && c.uri === NS);
  const value = (n: Node, name: string, required = true) => {
    const nodes = children(n, name);
    if (
      nodes.length > 1 ||
      (required && nodes.length !== 1) ||
      nodes.some((n) => n.children.length)
    )
      invalid();
    return nodes[0]?.text.trim() ?? '';
  };
  const ack = value(root, 'Ack');
  ensure(
    ['Success', 'Warning'].includes(ack),
    502,
    'eBay odrzucił identyfikację konta; sprawdź zgodę i ponów odczyt',
  );
  ensure(
    !children(root, 'Errors').some((n) => value(n, 'SeverityCode') !== 'Warning'),
    502,
    'eBay odrzucił identyfikację konta',
  );
  const users = children(root, 'User');
  if (users.length !== 1) invalid();
  const eias = value(users[0], 'EIASToken'),
    username = value(users[0], 'UserID', false);
  // EIAS is an opaque stable identifier; masked examples and missing EIAS cannot bind an account.
  ensure(
    /^[A-Za-z0-9+/_=-]{1,2048}$/.test(eias),
    502,
    'eBay nie zwrócił pełnego stałego identyfikatora EIAS; konto nie zostało przypisane',
  );
  if (username.length > 160 || /[\u0000-\u001f\u007f]/.test(username)) invalid();
  return {
    account_hash: createHash('sha256').update(JSON.stringify({ mode, eias })).digest('hex'),
    username: username || null,
  };
}
export async function readEbayAccount(
  mode: string,
  token: string,
  transport: Transport,
  clientId?: string,
  permit?: EbayApiPermit,
) {
  ensure(['sandbox', 'live'].includes(mode), 422, 'Nieprawidłowe środowisko eBay');
  ebaySecret.parse(token);
  const r = await sendEbayReserved(
    ebayLimitedTransport(mode, clientId, transport),
    permit,
    ebayBase(mode) + '/ws/api.dll',
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-IAF-TOKEN': token,
        'X-EBAY-API-CALL-NAME': 'GetUser',
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': EBAY_TRADING_VERSION,
      },
      body:
        '<?xml version="1.0" encoding="utf-8"?><GetUserRequest xmlns="' +
        NS +
        '"><DetailLevel>ReturnSummary</DetailLevel></GetUserRequest>',
    },
  ).catch((e) => {
    if (e instanceof EbayApiWait) throw e;
    throw new Problem(502, 'Brak odpowiedzi identyfikacji konta eBay; ponów odczyt');
  });
  if (r.status !== 200) {
    await r.body?.cancel();
    throw new Problem(r.status === 401 ? 401 : 502, 'Identyfikacja konta eBay: HTTP ' + r.status);
  }
  const reader = r.body?.getReader();
  ensure(reader, 502, 'Brak odpowiedzi identyfikacji konta eBay');
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const p = await reader.read();
      if (p.done) break;
      bytes += p.value.byteLength;
      if (bytes > LIMIT) invalid();
      parts.push(p.value);
    }
    return parseEbayAccount(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
      mode,
    );
  } catch (e) {
    if (e instanceof Problem) throw e;
    return invalid();
  } finally {
    await reader.cancel();
  }
}
