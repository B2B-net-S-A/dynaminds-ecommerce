import { SaxesParser } from 'saxes';
import { ensure } from './mapped-xml-schema';
import {
  catalogMappedXmlInput,
  CATALOG_FILE_IMPORT_LIMITS as LIMITS,
  type CatalogFileImportInput,
} from './mapped-xml-schema';

type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  text: string;
  children: XmlNode[];
};
type Mapping = NonNullable<CatalogFileImportInput['xml_mapping']>;
type ScalarType = NonNullable<Mapping['fields']['price_minor']>['value_type'];
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function decodeScalar(value: string, type: ScalarType): unknown {
  // Empty is distinct from absent: the ordinary import empty_policy owns its meaning.
  if (value === '' || type === 'text') return value;
  if (type === 'boolean') {
    ensure(value === 'true' || value === 'false', 422, 'Boolean XML wymaga true lub false');
    return value === 'true';
  }
  if (type === 'integer') {
    ensure(
      /^-?(?:0|[1-9][0-9]*)$/.test(value),
      422,
      'Liczba całkowita XML wymaga dokładnego zapisu',
    );
    return value === '-0' ? '0' : value;
  }
  ensure(
    /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(value),
    422,
    'Kwota XML wymaga kropki i najwyżej dwóch cyfr ułamka',
  );
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  // The scalar is independently bounded before BigInt work, including adversarial files.
  ensure(whole.length <= 100, 422, 'Kwota XML przekracza 100 cyfr');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return (negative ? -minor : minor).toString();
}

export function parseCatalogMappedXmlRecordsBrowser(content: string, input: Mapping) {
  const mapping = catalogMappedXmlInput.parse(input);
  ensure(new TextEncoder().encode(content).byteLength <= LIMITS.file_bytes, 413, 'Plik przekracza 2 MiB');
  ensure(
    !content.includes('\0') && new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(content)) === content,
    422,
    'Plik wymaga poprawnego Unicode bez NUL',
  );
  ensure(!/<!\s*(?:DOCTYPE|ENTITY)/i.test(content), 422, 'DTD i deklaracje encji są zabronione');
  const parser = new SaxesParser({ xmlns: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let nodes = 0;
  const countNode = () => {
    ensure(++nodes <= LIMITS.xml_nodes, 422, 'XML przekracza 100000 węzłów');
  };
  parser.on('opentag', (tag) => {
    countNode();
    ensure(stack.length < LIMITS.xml_depth, 422, 'XML przekracza 16 poziomów');
    ensure(!tag.name.split(':').some((part) => forbidden.has(part)), 422, 'Niedozwolony tag XML');
    const attributes: Record<string, string> = Object.create(null);
    for (const attribute of Object.values(tag.attributes)) {
      countNode();
      ensure(typeof attribute !== 'string', 422, 'Niepoprawny atrybut przestrzeni nazw XML');
      ensure(
        !attribute.name.split(':').some((part) => forbidden.has(part)),
        422,
        'Niedozwolony atrybut XML',
      );
      if (attribute.uri !== 'http://www.w3.org/2000/xmlns/')
        attributes[attribute.name] = attribute.value;
    }
    const node: XmlNode = { name: tag.name, attributes, text: '', children: [] };
    if (stack.length) stack.at(-1)!.children.push(node);
    else {
      ensure(!root, 422, 'XML wymaga jednego korzenia');
      root = node;
    }
    stack.push(node);
  });
  const text = (value: string) => {
    countNode();
    if (stack.length) stack.at(-1)!.text += value;
    else ensure(!value.trim(), 422, 'Dane poza korzeniem XML');
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('comment', countNode);
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('processinginstruction', () => {
    ensure(false, 422, 'Instrukcje przetwarzania XML są zabronione');
  });
  parser.on('doctype', () => {
    ensure(false, 422, 'DTD i deklaracje encji są zabronione');
  });
  parser.on('error', () => {
    ensure(false, 422, 'Niepoprawny XML lub przestrzeń nazw');
  });
  // XML declarations are handled by saxes; processing instructions remain forbidden.
  parser.write(content.replace(/^\ufeff/, '')).close();
  ensure(root, 422, 'XML wymaga jednego korzenia');
  const recordParts = mapping.record_path.slice(1).split('/');
  let records = root.name === recordParts[0] ? [root] : [];
  for (const part of recordParts.slice(1))
    records = records.flatMap((node) => node.children.filter((child) => child.name === part));
  ensure(
    records.length >= 1 && records.length <= LIMITS.rows,
    422,
    'Mapowany XML wymaga od 1 do 500 produktów',
  );

  return records.map((record) => {
    const fields: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const [field, definition] of Object.entries(mapping.fields)) {
      if (!definition) continue;
      const parts = definition.path.split('/');
      const last = parts.at(-1)!;
      const attribute = last.startsWith('@');
      let candidates = [record];
      for (const part of attribute ? parts.slice(0, -1) : parts)
        candidates = candidates.flatMap((node) =>
          node.children.filter((child) => child.name === part),
        );
      const values = attribute
        ? candidates
            .filter((node) => Object.hasOwn(node.attributes, last.slice(1)))
            .map((node) => node.attributes[last.slice(1)])
        : candidates.map((node) => {
            ensure(node.children.length === 0, 422, 'Mapowane pole XML wymaga skalarnego liścia');
            return node.text;
          });
      ensure(values.length <= 1, 422, `Niejednoznaczne mapowane pole XML: ${field}`);
      if (values.length === 0) continue;
      try {
        fields[field] = decodeScalar(values[0], definition.value_type);
      } catch {
        // Preserve the original value alongside a durable invalid-row diagnostic.
        fields[field] = values[0];
        errors.push(`Niepoprawna wartość mapowanego pola XML: ${field}`);
      }
    }
    return { fields, errors };
  });
}
