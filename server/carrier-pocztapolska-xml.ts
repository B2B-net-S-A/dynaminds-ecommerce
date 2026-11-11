import { SaxesParser } from 'saxes';
import { Problem } from './errors';

// XML used by the Poczta Polska SOAP services. Requests are built from escaped
// templates; responses are parsed without DTDs, entities or external resources.
export const SOAP_11 = 'http://schemas.xmlsoap.org/soap/envelope/';
export const SOAP_12 = 'http://www.w3.org/2003/05/soap-envelope';
export type XmlNode = {
  name: string;
  uri: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
};
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿]/;

export function escapeXml(v: string | number | boolean) {
  const s = String(v);
  if (CONTROL.test(s))
    throw new Problem(422, 'Niedozwolone znaki sterujące w danych dla Poczty Polskiej');
  return s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
}

/** Element with escaped text, omitted when the value is empty. */
export function el(name: string, value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === '') return '';
  return `<${name}>${escapeXml(value)}</${name}>`;
}

export type XmlLimits = { maxBytes: number; maxDepth?: number; maxNodes?: number; maxText?: number };

export function parseXml(xml: string, invalid: () => never, limits: XmlLimits): XmlNode {
  if (Buffer.byteLength(xml) > limits.maxBytes) invalid();
  const maxDepth = limits.maxDepth ?? 24,
    maxNodes = limits.maxNodes ?? 50000,
    maxText = limits.maxText ?? 20000;
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined,
    count = 0;
  // A DOCTYPE is the only way to declare entities; refuse it outright (XXE, billion laughs).
  parser.on('doctype', invalid);
  parser.on('error', invalid);
  parser.on('opentag', (tag) => {
    if (++count > maxNodes || stack.length >= maxDepth) invalid();
    const attrs: Record<string, string> = {};
    for (const a of Object.values(tag.attributes)) {
      if (a.prefix === 'xmlns' || a.name === 'xmlns') continue;
      attrs[a.local] = a.value;
    }
    const node: XmlNode = { name: tag.local, uri: tag.uri, attrs, text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else if (root) invalid();
    else root = node;
    stack.push(node);
  });
  const text = (v: string) => {
    const node = stack.at(-1);
    if (!node) return;
    node.text += v;
    if (node.text.length > maxText) invalid();
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
  if (!root) invalid();
  return root;
}

export type SoapResult =
  | { kind: 'body'; node: XmlNode }
  | { kind: 'fault'; code: string; message: string };

/** Envelope → exactly one Body child, or a SOAP Fault. */
export function parseSoap(xml: string, invalid: () => never, limits: XmlLimits): SoapResult {
  const root = parseXml(xml, invalid, limits);
  const soap = root.uri;
  if (root.name !== 'Envelope' || (soap !== SOAP_11 && soap !== SOAP_12)) invalid();
  const bodies = root.children.filter((n) => n.name === 'Body' && n.uri === soap);
  if (bodies.length !== 1 || bodies[0].children.length !== 1) invalid();
  const node = bodies[0].children[0];
  if (node.name === 'Fault' && node.uri === soap) {
    // SOAP 1.1: faultcode/faultstring; SOAP 1.2: Code/Value and Reason/Text.
    const code =
      node.children.find((c) => c.name === 'faultcode')?.text ??
      node.children.find((c) => c.name === 'Code')?.children.find((c) => c.name === 'Value')
        ?.text ??
      '';
    const message =
      node.children.find((c) => c.name === 'faultstring')?.text ??
      node.children.find((c) => c.name === 'Reason')?.children.find((c) => c.name === 'Text')
        ?.text ??
      '';
    return { kind: 'fault', code: code.trim(), message: message.trim() };
  }
  return { kind: 'body', node };
}

/** Children by local name, ignoring namespace (the PP services mix qualified and unqualified elements). */
export const kids = (n: XmlNode, name: string) => n.children.filter((c) => c.name === name);

export function textOf(n: XmlNode, name: string, invalid: () => never, required = true) {
  const nodes = kids(n, name);
  if (nodes.length > 1 || (required && nodes.length !== 1) || nodes.some((c) => c.children.length))
    invalid();
  return nodes[0]?.text.trim() ?? '';
}

/** Provider text shown to operators: no control characters, bounded length. */
export function providerText(v: string, max = 200) {
  return v
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export async function readLimited(res: Response, maxBytes: number, invalid: () => never) {
  const reader = res.body?.getReader();
  if (!reader) invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) invalid();
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (e) {
    if (e instanceof Problem) throw e;
    invalid();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
