/** Pure retained Markdown table codec. Literal source facts only; never evaluates
 * HTML/prose, infers defaults/requiredness/parents, changes scope or grants acceptance. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveBaseApiOperationProposal,BASE_API_OPERATION_LIMITS as LIMITS} from './base-api-operation-requirements.mjs';

export const BASE_API_MARKDOWN_PROPOSAL_REF=Object.freeze({
  path:'docs/parity/base-api-operation-proposal-20261019.json',bytes:441717,
  sha256:'c398b819b9d04f80d0b7a7c040968c309035f5c814b639c4ebcaab93978275f9',
});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const decode=bytes=>new TextDecoder('utf8',{fatal:true}).decode(bytes);
const width=value=>Buffer.byteLength(value,'utf8');
const HEADERS=Object.freeze([
  ['Kierunek','Pole źródłowe','Typ źródłowy'],['Kierunek','Ścieżka','Typ źródłowy'],
  ['Kierunek','Ścieżka','Typ źródłowy','Znaczenie/warunek'],['Ścieżka','Typ źródłowy'],
]);
function lines(text,byteStart=0,lineStart=1) {
  let offset=byteStart;
  return (text.match(/[^\n]*\n|[^\n]+$/g)??[]).map((raw,index)=>{
    const start=offset;offset+=width(raw);
    return {raw,body:raw.replace(/\r?\n$/,''),line:lineStart+index,range:[start,offset]};
  });
}
function literal(raw) {
  const trimmed=raw.trim(),opening=/^(`+)/.exec(trimmed);
  let value=trimmed,code=false;
  if(opening && trimmed.length>=2*opening[1].length && trimmed.endsWith(opening[1])) {
    const interior=trimmed.slice(opening[1].length,-opening[1].length);
    if(!interior.includes(opening[1])) { value=interior;code=true; }
  }
  return {raw,decoded_text:value.replaceAll('\\|','|'),whole_cell_code_span:code,
    interpretation:'MARKDOWN_SYNTAX_ONLY_NOT_JSON_TYPE'};
}
function cells(line) {
  assert(line.body.startsWith('|'),'unindented Markdown table row');
  const separators=[];
  for(let i=0;i<line.body.length;i++) {
    if(line.body[i]==='\\') {i++;continue;}
    if(line.body[i]==='|')separators.push(i);
  }
  assert(separators[0]===0&&line.body.slice(separators.at(-1)+1).trim()==='','closed Markdown row');
  return separators.slice(0,-1).map((at,index)=>{
    const start=at+1,end=separators[index+1];
    return {...literal(line.body.slice(start,end)),line:line.line,
      range:[line.range[0]+width(line.body.slice(0,start)),line.range[0]+width(line.body.slice(0,end))]};
  });
}
const separator=line=>/^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line.body);
function table(selected) {
  assert(selected.length>=2&&separator(selected[1]),'table header separator');
  const header=cells(selected[0]),names=header.map(cell=>cell.decoded_text);
  const kind=HEADERS.findIndex(expected=>JSON.stringify(expected)===JSON.stringify(names));
  assert(kind>=0,'unknown Markdown contract table header');
  assert.equal(cells(selected[1]).length,names.length,'separator column count');
  const directed=names[0]==='Kierunek',fieldColumn=directed?1:0,typeColumn=directed?2:1;
  const rows=selected.slice(2).map(line=>{
    const values=cells(line);assert.equal(values.length,names.length,'exact table row width');
    const direction=directed?values[0].decoded_text:'UNKNOWN';
    assert(!directed||direction==='in'||direction==='out','explicit source direction');
    return {line:line.line,range:line.range,raw:line.raw,cells:values,direction,
      field:values[fieldColumn],documented_type:values[typeColumn],
      parent_resolution:values[fieldColumn].decoded_text.includes('↳')?'UNKNOWN':'LITERAL_SOURCE_TEXT_ONLY',
      path_resolution:'LITERAL_SOURCE_TEXT_ONLY_NOT_JSON_POINTER',
      required:{status:'UNKNOWN',column_present:false},default:{status:'UNKNOWN',column_present:false},
      meaning:directed&&values.length===4?values[3]:null};
  });
  return {header_kind:kind,header_names:names,header_cells:header,separator_raw:selected[1].raw,
    start_line:selected[0].line,end_line_exclusive:selected.at(-1).line+1,
    range:[selected[0].range[0],selected.at(-1).range[1]],raw:selected.map(line=>line.raw).join(''),rows};
}

/** Source-codec inverse only. Reparse each table to bind all derived cell facts,
 * line numbers and UTF8 spans, then enforce the whole retained section digest. */
export function restoreBaseApiMarkdownSection(method) {
  const [start,end]=method.section.range;let cursor=start,text='';const used=new Set();
  assert(Number.isSafeInteger(method.section.start_line)&&method.section.start_line>0,'1based source line');
  assert.equal(method.section.start_line,method.contract.line,'pinned section line');
  for(const segment of method.segments) {
    assert.equal(segment.range[0],cursor,'contiguous whole section segments');
    let raw;
    if(segment.kind==='PROSE')raw=segment.raw;
    else {
      assert.equal(segment.kind,'TABLE');assert(Number.isSafeInteger(segment.table_index)&&!used.has(segment.table_index),'one table segment');
      const value=method.tables[segment.table_index];assert(value,'existing table segment');used.add(segment.table_index);
      assert.deepEqual(value.range,segment.range);
      const sourceLine=method.section.start_line+(text.match(/\n/g)??[]).length;
      assert.deepEqual(table(lines(value.raw,value.range[0],sourceLine)),value,'exact decoded table/source spans');
      raw=value.raw;
    }
    assert.equal(width(raw),segment.range[1]-segment.range[0],'UTF8 segment bytes');cursor=segment.range[1];text+=raw;
  }
  assert.equal(cursor,end,'whole section range');assert.equal(used.size,method.tables.length,'all tables represented');
  assert.equal(sha(Buffer.from(text)),method.section.sha256,'whole retained method section');
  assert.equal(lines(text,start,method.section.start_line).at(-1).line+1,method.section.end_line_exclusive,'whole section line range');
  assert.equal(lines(text)[0].body,'### '+method.method,'exact method heading');return text;
}

export function deriveBaseApiMarkdownTables(input) {
  assert(input&&typeof input==='object'&&!Array.isArray(input));assert.deepEqual(Object.keys(input),['files'],'only pinned FILE input');
  const files={};let total=0;
  for(const[name,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(input.files))) {
    assert(Object.hasOwn(descriptor,'value')&&descriptor.value instanceof Uint8Array,'own byte data');
    const bytes=Buffer.from(descriptor.value);assert(bytes.length>0&&bytes.length<=LIMITS.member_bytes,'8MiB member bound');
    total+=bytes.length;assert(total<=LIMITS.input_bytes,'16MiB aggregate bound');files[name]=bytes;
  }
  const ref=BASE_API_MARKDOWN_PROPOSAL_REF,raw=files[ref.path];assert(raw,'literal proposal required');
  assert.equal(raw.length,ref.bytes);assert.equal(sha(raw),ref.sha256,'literal proposal pin');
  const proposal=JSON.parse(decode(raw));delete files[ref.path];
  assert.deepEqual(deriveBaseApiOperationProposal({files}),proposal,'whole proposal from literal retained inputs');
  const documents=new Map();let tableCount=0,rowCount=0,arrows=0,escaped=0;const kinds=[0,0,0,0];
  const methods=proposal.rows.filter(row=>row.contract.format==='markdown_tables_and_prose').map(row=>{
    assert.equal(row.source.capture_date,'2026-10-18');
    if(!documents.has(row.contract.document))documents.set(row.contract.document,lines(decode(files[row.contract.document])));
    const document=documents.get(row.contract.document),start=row.contract.line-1;
    assert.equal(document[start].body,'### '+row.method,'pinned method line');
    let end=start+1;while(end<document.length&&!/^#{1,3} /.test(document[end].body))end++;
    const selected=document.slice(start,end),tables=[],segments=[];let position=0,proseStart=0;
    const prose=(from,to)=>{if(from<to)segments.push({kind:'PROSE',range:[selected[from].range[0],selected[to-1].range[1]],raw:selected.slice(from,to).map(line=>line.raw).join('')});};
    while(position<selected.length) {
      if(!selected[position].body.startsWith('|')) {position++;continue;}
      assert(position+1<selected.length&&separator(selected[position+1]),'unclassified Markdown table row');
      prose(proseStart,position);let finish=position+2;
      while(finish<selected.length&&selected[finish].body.startsWith('|'))finish++;
      const parsed=table(selected.slice(position,finish));segments.push({kind:'TABLE',table_index:tables.length,range:parsed.range});tables.push(parsed);
      tableCount++;kinds[parsed.header_kind]++;rowCount+=parsed.rows.length;
      arrows+=parsed.rows.filter(row=>row.field.decoded_text.includes('↳')).length;
      escaped+=parsed.rows.filter(row=>row.raw.includes('\\|')).length;
      position=finish;proseStart=finish;
    }
    prose(proseStart,selected.length);
    const text=selected.map(line=>line.raw).join('');assert.equal(sha(Buffer.from(text)),row.contract.section_sha256,'pinned full Markdown section');
    const method={id:row.id,method:row.method,family:row.family,group:row.group,source:structuredClone(row.source),contract:structuredClone(row.contract),
      section:{range:[selected[0].range[0],selected.at(-1).range[1]],start_line:row.contract.line,end_line_exclusive:selected.at(-1).line+1,sha256:row.contract.section_sha256},
      tables,segments,normalization_status:'TABLE_SOURCE_FACTS_ONLY_PROSE_UNINTERPRETED',
      operational_contract_fully_resolved:'UNKNOWN',requiredness_resolution:'UNKNOWN',default_resolution:'UNKNOWN',
      implementation_verified:false,wire_verified:false,provider_account_verified:false,acceptance_granted:false};
    assert.equal(restoreBaseApiMarkdownSection(method),text,'whole Markdown section inverse');return method;
  });
  assert.equal(methods.length,70);assert.equal(documents.size,5);assert.equal(tableCount,79);assert.equal(rowCount,700);
  assert.deepEqual(kinds,[34,36,7,2]);assert.equal(arrows,138);assert.equal(escaped,2);
  const result={schema:'dynaminds-base-api-markdown-table-facts/v1',mode:'RETAINED_TABLE_SYNTAX_ONLY_NOT_RUNTIME_VALIDATION',
    proposal_ref:ref,parent_scope:structuredClone(proposal.parent_scope),source_refs:structuredClone(proposal.source_refs),
    summary:{methods:70,documents:5,tables:79,data_rows:700,header_kinds:kinds,arrow_rows:138,escaped_pipe_rows:2,
      index_observation_date:'2026-10-17',detail_observation_dates:{'2026-10-18':70}},
    full_contract_inventory_complete:false,coverage_complete:false,scope_mutated:false,scope_complete:false,
    acceptance_granted:false,full_goal_complete:false,
    boundary:'Exact Markdown table cells/spans and full prose are retained source facts. Decoded code spans and escaped pipes do not define JSON types or validators. Arrow parents, missing direction, requiredness/defaults and all prose semantics remain UNKNOWN. All70 detail pages were observed18.10, not17.10. No scope or implementation/wire/provider acceptance is granted.',methods};
  assert(width(JSON.stringify(result,null,2)+'\n')<=LIMITS.output_bytes,'8MiB output bound');return result;
}
