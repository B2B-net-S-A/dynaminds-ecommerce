/** Browser preview only: literal current native CSV/XML parser functions with host-free ensure. Backend reparses authoritatively. */
import {SaxesParser} from 'saxes';import {parseCatalogMappedXmlRecordsBrowser} from './mapped-xml';import {decodeJson,type JsonValue} from '../../../../shared/pim-json';import type {CatalogFileImportInput} from '../../../../server/catalog-file-import-schema';
const LIMITS={rows:500,xml_depth:16,xml_nodes:100000},forbidden=new Set(['__proto__','prototype','constructor']);function ensure(v:unknown,_status:number,message:string):asserts v{if(!v)throw Error(message);}
export function parseCatalogCsvRecords(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const field = () => {
    row.push(cell);
    cell = '';
    closed = false;
  };
  const line = () => {
    field();
    rows.push(row);
    row = [];
    ensure(rows.length <= LIMITS.rows + 1, 422, 'Plik przekracza 500 wierszy produktów');
  };
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quoted) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
    } else if (ch === delimiter) field();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      line();
    } else if (ch === '"') {
      ensure(!cell && !closed, 422, 'Niepoprawny cudzysłów w CSV');
      quoted = true;
    } else {
      ensure(!closed, 422, 'Dane za zamkniętym polem CSV');
      cell += ch;
    }
  }
  ensure(!quoted, 422, 'Niezamknięte pole CSV');
  if (cell || row.length || closed) line();
  return rows;
}
type XmlNode = { name: string; attrs: Record<string, string>; text: string; children: XmlNode[] };
export function parseNativeCatalogXmlRecords(content: string) {
  ensure(!/<!\s*(?:DOCTYPE|ENTITY)/i.test(content), 422, 'DTD i deklaracje encji są zabronione');
  const parser = new SaxesParser({ xmlns: false }),
    stack: XmlNode[] = [];
  let root: XmlNode | undefined,
    nodes = 0;
  parser.on('opentag', (tag) => {
    ensure(++nodes <= LIMITS.xml_nodes, 422, 'XML przekracza 100000 węzłów');
    ensure(stack.length < LIMITS.xml_depth, 422, 'XML przekracza 16 poziomów');
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(tag.attributes)) {
      ensure(typeof value === 'string' && !forbidden.has(key), 422, 'Niepoprawny atrybut XML');
      attrs[key] = value as string;
    }
    const node: XmlNode = { name: tag.name, attrs, text: '', children: [] };
    ensure(!forbidden.has(node.name) && !node.name.includes(':'), 422, 'Niedozwolony tag XML');
    if (stack.length) stack.at(-1)!.children.push(node);
    else {
      ensure(!root, 422, 'XML wymaga jednego korzenia');
      root = node;
    }
    stack.push(node);
  });
  parser.on('text', (text) => {
    ensure(++nodes <= LIMITS.xml_nodes, 422, 'XML przekracza 100000 węzłów');
    if (stack.length) stack.at(-1)!.text += text;
    else ensure(!text.trim(), 422, 'Dane poza korzeniem XML');
  });
  parser.on('cdata', (text) => {
    ensure(++nodes <= LIMITS.xml_nodes, 422, 'XML przekracza 100000 węzłów');
    if (stack.length) stack.at(-1)!.text += text;
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('processinginstruction', () => {
    ensure(false, 422, 'Instrukcje przetwarzania XML są zabronione');
  });
  parser.on('error', () => {
    ensure(false, 422, 'Niepoprawny XML');
  });
  parser.write(content).close();
  ensure(root?.name === 'catalog' && !root.text.trim(), 422, 'XML wymaga korzenia catalog');
  ensure(
    Object.keys(root.attrs).every((k) => ['currency', 'price_source'].includes(k)) &&
      ['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(root.attrs.currency) &&
      (root.attrs.price_source === undefined || root.attrs.price_source === 'catalog'),
    422,
    'Niepoprawna waluta lub źródło katalogu XML',
  );
  ensure(
    root.children.length >= 1 &&
      root.children.length <= LIMITS.rows &&
      root.children.every(
        (n) => n.name === 'product' && !n.text.trim() && !Object.keys(n.attrs).length,
      ),
    422,
    'XML wymaga od 1 do 500 produktów',
  );
  const decode = (node: XmlNode, objectEntry = false): unknown => {
    ensure(
      Object.keys(node.attrs).every((k) =>
        ['type', 'nil', ...(objectEntry ? ['key'] : [])].includes(k),
      ),
      422,
      'Nieznany atrybut pola XML',
    );
    if (node.attrs.nil !== undefined) {
      ensure(
        node.attrs.nil === 'true' &&
          node.attrs.type === undefined &&
          !node.children.length &&
          !node.text,
        422,
        'Niepoprawne null w XML',
      );
      return null;
    }
    const type = node.attrs.type;
    ensure(
      ['string', 'number', 'boolean', 'array', 'object'].includes(type),
      422,
      'Nieznany typ pola XML',
    );
    if (type === 'array' || type === 'object') {
      ensure(!node.text.trim(), 422, 'Struktura XML zawiera dodatkowy tekst');
      if (type === 'array') {
        ensure(
          node.children.every((c) => c.name === 'item'),
          422,
          'Tablica XML wymaga item',
        );
        return node.children.map((c) => decode(c));
      }
      const keys = node.children.map((c) => c.attrs.key);
      ensure(
        node.children.every((c) => c.name === 'entry') &&
          keys.every((k) => typeof k === 'string' && !forbidden.has(k)) &&
          new Set(keys).size === keys.length,
        422,
        'Powtórzone lub niepoprawne klucze XML',
      );
      return Object.fromEntries(node.children.map((c) => [c.attrs.key, decode(c, true)]));
    }
    ensure(!node.children.length, 422, 'Skalar XML nie może zawierać tagów');
    if (type === 'number') {
      ensure(
        /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(node.text) && Number.isFinite(Number(node.text)),
        422,
        'Niepoprawna liczba XML',
      );
      return Number(node.text);
    }
    if (type === 'boolean') {
      ensure(node.text === 'true' || node.text === 'false', 422, 'Niepoprawny boolean XML');
      return node.text === 'true';
    }
    return node.text;
  };
  return {
    currency: root.attrs.currency,
    rows: root.children.map((product) => {
      const names = product.children.map((c) => c.name);
      ensure(new Set(names).size === names.length, 422, 'Powtórzone pola produktu XML');
      return Object.fromEntries(product.children.map((c) => [c.name, decode(c)]));
    }),
  };
}

export function previewCanonicalRows(q:CatalogFileImportInput):Record<string,JsonValue>[] {ensure(new TextEncoder().encode(q.content).byteLength<=1048576,413,'Pełny plik przekracza 1 MiB');if(q.xml_mapping){ensure(q.format==='xml'&&Object.keys(q.mapping).length===0,422,'Mapowany XML wymaga formatu XML i pustego zwykłego mapowania');return parseCatalogMappedXmlRecordsBrowser(q.content,q.xml_mapping).map(row=>{ensure(row.errors.length===0,422,'core_parse_errors');return decodeJson(row.fields) as Record<string,JsonValue>;});}let records:Record<string,unknown>[];
 if(q.format==='xml')records=parseNativeCatalogXmlRecords(q.content.replace(/^\ufeff/,'')).rows;else{const [head,...rows]=parseCatalogCsvRecords(q.content.replace(/^\ufeff/,''),q.delimiter);ensure(head?.length&&head.every(k=>k&&!forbidden.has(k))&&new Set(head.map(k=>k.toLowerCase())).size===head.length,422,'Nieprawidłowy nagłówek');ensure(rows.length>=1&&rows.length<=500,422,'Wymagany cały zakres 1–500');records=rows.map(r=>{ensure(r.length===head.length,422,'Liczba pól CSV');return Object.fromEntries(head.map((k,i)=>[k,r[i]]));});}
 const canonical=['id','sku','ean','name','description','price_minor','vat_rate','category','active','kind','weight_g','length_mm','width_mm','height_mm','manufacturer','attributes_json','images_json','bundle_components_json','parent_id','parent_sku','variants_json','translations_json','inventory_json','prices_json'];const aliases=new Map<string,string>();for(const k of canonical){const s=(q.mapping as Record<string,string>)[k]??k;ensure(!forbidden.has(s)&&!aliases.has(s)&&(s===k||!canonical.includes(s)),422,'Niepoprawne jawne mapowanie core');aliases.set(s,k);}return records.map(raw=>{const fields:Record<string,JsonValue>=Object.create(null);for(const[k,v]of Object.entries(raw)){const field=aliases.get(k);ensure(field,422,'Nieznane pole core: '+k);fields[field]=decodeJson(v);}if(q.format==='csv'&&Object.hasOwn(fields,'attributes_json')){ensure(typeof fields.attributes_json==='string',422,'Kontener CSV wymaga tekstu JSON');fields.attributes_json=decodeJson(JSON.parse(fields.attributes_json as string));}return decodeJson(fields) as Record<string,JsonValue>;});
}
