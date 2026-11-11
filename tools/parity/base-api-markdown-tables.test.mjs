/** Actual retained70 Markdown sections. These are source-codec tests, not API acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {
  deriveBaseApiMarkdownTables,restoreBaseApiMarkdownSection,
  BASE_API_MARKDOWN_PROPOSAL_REF as REF,
} from './base-api-markdown-tables.mjs';

import {readRetainedRevision} from './base-api-retained-revisions.mjs';

const D=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const proposal=JSON.parse(await fs.readFile(D+REF.path));
const refs=[...Object.values(proposal.source_refs).filter(value=>!Array.isArray(value)),
  ...proposal.source_refs.bundles,...proposal.source_refs.contracts,REF];
const names=[...new Set(refs.map(ref=>ref.path))];
// Dated registry pins name exact FILE revisions; superseded ones come from their retained copy.
const files=Object.fromEntries(names.map(name=>[name,readRetainedRevision(D,name)]));
const before=new Map(Object.entries(files).map(([name,bytes])=>[name,sha(bytes)]));
const derived=deriveBaseApiMarkdownTables({files});
const rows=derived.methods.flatMap(method=>method.tables.flatMap(table=>table.rows));
const get=name=>{const method=derived.methods.find(row=>row.method===name);assert(method,name);return method;};
const slice=(document,range)=>document.subarray(...range).toString('utf8');

test('actual70 sections/79 tables/700 rows have wholebyte inverse and leave all pinned v5 source inputs unchanged',()=>{
  assert.deepEqual(derived.summary,{methods:70,documents:5,tables:79,data_rows:700,
    header_kinds:[34,36,7,2],arrow_rows:138,escaped_pipe_rows:2,
    index_observation_date:'2026-10-17',detail_observation_dates:{'2026-10-18':70}});
  assert.equal(derived.methods.length,70);assert.equal(rows.length,700);
  assert.equal(derived.parent_scope.requirements,2589);assert.equal(derived.parent_scope.open_gaps,33);
  assert.deepEqual(derived.parent_scope,proposal.parent_scope);
  assert.deepEqual(derived.source_refs,proposal.source_refs);
  for(const method of derived.methods) {
    const source=files[method.contract.document];
    assert.equal(restoreBaseApiMarkdownSection(method),slice(source,method.section.range),method.method);
    assert.equal(sha(source.subarray(...method.section.range)),method.section.sha256);
    assert.deepEqual(method.contract,proposal.rows.find(row=>row.id===method.id).contract);
    assert.equal(method.section.start_line,method.contract.line);
    assert.equal(source.subarray(0,method.section.range[0]).toString('utf8').split('\n').length,method.section.start_line);
  }
  for(const [name,digest]of before)assert.equal(sha(files[name]),digest,'input buffer unchanged:'+name);
  assert(Buffer.byteLength(JSON.stringify(derived,null,2)+'\n')<=8*1024*1024);
});

test('every raw table/row/cell is bound to absolute UTF8 halfopen bytes and 1based source lines',()=>{
  let nonAsciiCell=false;
  for(const method of derived.methods) {
    const source=files[method.contract.document];
    for(const table of method.tables) {
      assert.equal(slice(source,table.range),table.raw);
      assert.equal(source.subarray(0,table.range[0]).toString('utf8').split('\n').length,table.start_line);
      assert.equal(table.end_line_exclusive-table.start_line,table.rows.length+2);
      for(const row of table.rows) {
        assert.equal(slice(source,row.range),row.raw);
        assert.equal(source.subarray(0,row.range[0]).toString('utf8').split('\n').length,row.line);
      }
      for(const cell of [...table.header_cells,...table.rows.flatMap(row=>row.cells)]) {
        assert.equal(slice(source,cell.range),cell.raw);
        assert.equal(source.subarray(0,cell.range[0]).toString('utf8').split('\n').length,cell.line);
        assert.equal(cell.range[1]-cell.range[0],Buffer.byteLength(cell.raw));
        if(Buffer.byteLength(cell.raw)>cell.raw.length)nonAsciiCell=true;
      }
    }
  }
  assert(nonAsciiCell,'actual Polish and arrow cells exercise byte offsets rather than JS character offsets');
});

test('escaped pipes and code spans decode Markdown syntax only; arrows and undirected tables remain UNKNOWN',()=>{
  const pipes=rows.filter(row=>row.raw.includes('\\|'));
  assert.equal(pipes.length,2);
  assert.deepEqual(pipes.map(row=>row.field.decoded_text).sort(),['deliveries[].received_items','items[].received_quantity']);
  for(const row of pipes) {
    assert(row.documented_type.raw.includes('`int\\|null`'));
    assert.equal(row.documented_type.decoded_text,'int|null');
    assert.equal(row.documented_type.whole_cell_code_span,true);
    assert.equal(row.documented_type.interpretation,'MARKDOWN_SYNTAX_ONLY_NOT_JSON_TYPE');
    assert(!Object.hasOwn(row,'json_type'));
  }
  const arrows=rows.filter(row=>row.field.decoded_text.includes('↳'));
  assert.equal(arrows.length,138);assert(arrows.every(row=>row.parent_resolution==='UNKNOWN'));
  const undirected=derived.methods.flatMap(method=>method.tables).filter(table=>table.header_kind===3);
  assert.equal(undirected.length,2);assert(undirected.flatMap(table=>table.rows).every(row=>row.direction==='UNKNOWN'));
  assert(rows.every(row=>row.path_resolution==='LITERAL_SOURCE_TEXT_ONLY_NOT_JSON_POINTER'));
});

test('absent required/default columns never become rules and full conditional prose survives untouched',()=>{
  for(const row of rows) {
    assert.deepEqual(row.required,{status:'UNKNOWN',column_present:false});
    assert.deepEqual(row.default,{status:'UNKNOWN',column_present:false});
  }
  for(const name of ['addInventoryPriceGroup','addInventoryWarehouseLocation','addInventoryStocktake','getInventoryPromotionsList']) {
    const method=get(name),raw=restoreBaseApiMarkdownSection(method);
    const prose=method.segments.filter(segment=>segment.kind==='PROSE').map(segment=>segment.raw).join('');
    assert(prose.length>0);assert(raw.includes(prose.split('\n')[0]));
    assert.equal(raw,slice(files[method.contract.document],method.section.range));
    assert.equal(method.requiredness_resolution,'UNKNOWN');assert.equal(method.default_resolution,'UNKNOWN');
    assert.equal(method.operational_contract_fully_resolved,'UNKNOWN');
  }
  const price=restoreBaseApiMarkdownSection(get('addInventoryPriceGroup'));
  assert.match(price,/domyśln/i);assert.match(price,/Nieznane/);
});

test('all18.10 detail provenance remains distinct from17.10 index and grants no implementation/vendor/product acceptance',()=>{
  for(const method of derived.methods) {
    const source=proposal.rows.find(row=>row.id===method.id).source;
    assert.deepEqual(method.source,source);
    assert.equal(method.source.capture_date,'2026-10-18');
    assert.equal(method.source.relation_to_20261017_index,'later_supplement_not_retroactive_proof');
    for(const key of ['implementation_verified','wire_verified','provider_account_verified','acceptance_granted'])assert.equal(method[key],false);
  }
  for(const key of ['full_contract_inventory_complete','coverage_complete','scope_mutated','scope_complete','acceptance_granted','full_goal_complete'])assert.equal(derived[key],false);
});

test('inverse rejects unknown headers, row width drift, decoded facts, spans, missing tables and changed prose',()=>{
  const current=derived.methods.find(method=>method.tables.length===2);assert(current);
  const mutations=[
    method=>{method.tables[0].raw=method.tables[0].raw.replace('Kierunek','Wymyślone');},
    method=>{const table=method.tables[0];table.raw=table.raw.replace(table.rows[0].raw,table.rows[0].raw.replace('|','| extra |'));},
    method=>{method.tables[0].rows[0].documented_type.decoded_text='number';},
    method=>{method.tables[0].rows[0].cells[0].range[0]++;},
    method=>{method.tables[0].start_line++;},
    method=>{method.section.start_line++;},
    method=>{method.section.end_line_exclusive++;},
    method=>{method.segments=method.segments.filter(segment=>segment.kind!=='TABLE');},
    method=>{const segment=method.segments.find(segment=>segment.kind==='TABLE');method.segments.push(structuredClone(segment));},
    method=>{const segment=method.segments.find(segment=>segment.kind==='PROSE');segment.raw=segment.raw.replace('###','##!');},
  ];
  for(const mutate of mutations) {const method=structuredClone(current);mutate(method);assert.throws(()=>restoreBaseApiMarkdownSection(method));}
  const unknown=structuredClone(current);unknown.tables[0].raw=unknown.tables[0].raw.replace('Kierunek','Nieznany');
  assert.throws(()=>restoreBaseApiMarkdownSection(unknown),/unknown Markdown contract table header/);
});

test('literal proposal/source pins, closed input and8MiB/16MiB bounds reject selfauthenticated or accessor inputs',()=>{
  const forged=structuredClone(proposal);forged.rows[0].source.http_status=299;
  assert.throws(()=>deriveBaseApiMarkdownTables({files:{...files,[REF.path]:Buffer.from(JSON.stringify(forged))}}));
  assert.throws(()=>deriveBaseApiMarkdownTables({files,refs:{...REF,sha256:'0'.repeat(64)}}),/only pinned FILE input/);
  const document=derived.methods[0].contract.document,changed=Buffer.from(files[document]);changed[0]^=1;
  assert.throws(()=>deriveBaseApiMarkdownTables({files:{...files,[document]:changed}}),/source digest/);
  const missing={...files};delete missing[document];assert.throws(()=>deriveBaseApiMarkdownTables({files:missing}));
  const accessor={...files};Object.defineProperty(accessor,REF.path,{enumerable:true,get(){assert.fail('getter must not run');}});
  assert.throws(()=>deriveBaseApiMarkdownTables({files:accessor}),/own byte data/);
  assert.throws(()=>deriveBaseApiMarkdownTables({files:{...files,oversized:Buffer.alloc(8*1024*1024+1)}}),/8MiB member/);
  assert.throws(()=>deriveBaseApiMarkdownTables({files:{a:Buffer.alloc(8*1024*1024),b:Buffer.alloc(8*1024*1024),c:Buffer.from('x')}}),/16MiB aggregate/);
});
