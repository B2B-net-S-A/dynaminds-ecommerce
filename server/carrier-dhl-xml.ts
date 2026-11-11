import { SaxesParser } from 'saxes';
import { Problem } from './errors';
// SOAP 1.1 envelope used by DHL24 WebAPI2. The service namespace is the WSDL URL from the public documentation.
export const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
export const DHL_NS = 'https://dhl24.com.pl/webapi2/provider/service.html?ws=1';
export const DHL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export type XmlNode = { name: string; uri: string; text: string; children: XmlNode[] };
export type XmlValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | XmlValue[]
  | { [key: string]: XmlValue };
export function invalidDhl(): never {
  throw new Problem(502, 'Nieprawidłowa odpowiedź DHL24', 'DHL_INVALID_RESPONSE');
}
// Values are escaped and C0 control characters other than tab/newline are refused before they reach the envelope.
export function escapeXml(v: string) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/.test(v))
    throw new Problem(422, 'Niedozwolone znaki sterujące w danych DHL', 'DHL_VALIDATION');
  return v.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
}
const tagName = (n: string) => {
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(n)) throw new Error('Nieprawidłowa nazwa elementu XML');
  return n;
};
// DHL24 encodes lists as <list><item>…</item></list>; null/undefined fields are omitted.
export function xmlElement(name: string, value: XmlValue): string {
  const tag = tagName(name);
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `<${tag}>${value.map((v) => xmlElement('item', v)).join('')}</${tag}>`;
  if (typeof value === 'object')
    return `<${tag}>${Object.entries(value)
      .map(([k, v]) => xmlElement(k, v))
      .join('')}</${tag}>`;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nieprawidłowa liczba XML');
  return `<${tag}>${escapeXml(String(value))}</${tag}>`;
}
export function soapRequest(method: string, params: Record<string, XmlValue>) {
  const m = tagName(method);
  const inner = Object.entries(params)
    .map(([k, v]) => xmlElement(k, v))
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:ns="${DHL_NS}"><soapenv:Body><ns:${m}>${inner}</ns:${m}></soapenv:Body></soapenv:Envelope>`;
}
// Strict parser: no DTD (so no entity declarations or external entities), no processing instructions, bounded size/depth.
export function parseXml(xml: string, maxBytes = DHL_MAX_RESPONSE_BYTES): XmlNode {
  if (Buffer.byteLength(xml) > maxBytes) invalidDhl();
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined,
    count = 0,
    failed = false;
  const fail = () => {
    failed = true;
    throw new Error('xml');
  };
  parser.on('doctype', fail);
  parser.on('processinginstruction', fail);
  parser.on('error', fail);
  parser.on('opentag', (tag) => {
    if (++count > 100000 || stack.length >= 24) fail();
    const node: XmlNode = { name: tag.local, uri: tag.uri, text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else if (root) fail();
    else root = node;
    stack.push(node);
  });
  const text = (v: string) => {
    const node = stack.at(-1);
    if (!node) {
      if (v.trim()) fail();
      return;
    }
    node.text += v;
    // Label PDFs arrive as base64 text; 6 MB of base64 is ~4.5 MB of PDF.
    if (node.text.length > 6 * 1024 * 1024) fail();
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    stack.pop();
  });
  try {
    parser.write(xml).close();
  } catch {
    invalidDhl();
  }
  if (failed || !root) invalidDhl();
  return root;
}
export type SoapFault = { code: string; message: string };
export type SoapBody = { fault: SoapFault } | { fault: null; result: XmlNode };
// Children of the operation response are matched by local name: the public WSDL does not settle element qualification.
export const kids = (n: XmlNode, name: string) => n.children.filter((c) => c.name === name);
export function one(n: XmlNode, name: string) {
  const nodes = kids(n, name);
  if (nodes.length !== 1) invalidDhl();
  return nodes[0];
}
export function text(n: XmlNode, name: string, required = true) {
  const nodes = kids(n, name);
  if (nodes.length > 1 || (required && nodes.length !== 1) || nodes.some((c) => c.children.length))
    invalidDhl();
  return nodes[0]?.text.trim() ?? '';
}
export const items = (n: XmlNode | undefined) => (n ? kids(n, 'item') : []);
export function parseSoapResponse(xml: string, method: string): SoapBody {
  const root = parseXml(xml);
  if (root.name !== 'Envelope' || root.uri !== SOAP_NS) invalidDhl();
  const bodies = root.children.filter((n) => n.name === 'Body' && n.uri === SOAP_NS);
  if (bodies.length !== 1 || bodies[0].children.length !== 1) invalidDhl();
  const response = bodies[0].children[0];
  if (response.name === 'Fault' && response.uri === SOAP_NS)
    return {
      fault: { code: text(response, 'faultcode', false), message: text(response, 'faultstring', false) },
    };
  if (response.name !== method + 'Response' || response.uri !== DHL_NS) invalidDhl();
  const results = kids(response, method + 'Result');
  if (results.length !== 1) invalidDhl();
  return { fault: null, result: results[0] };
}
