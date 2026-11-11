/** Import-safe Node parser ports only; no filesystem/network/DB access at import or by default. */
import {createHash} from 'node:crypto';
import {SaxesParser} from 'saxes';
import {catalogXmlPathValid} from '../../catalog-xml-path';

export type Span={ordinal:number;byte_start:number;byte_end:number;line_start:number;line_end:number;raw_sha256:string};
export type XmlNode={name:string;attributes:Record<string,string>;content:XmlPart[]};
export type XmlPart={type:'text'|'cdata';value:string}|{type:'element';element:XmlNode};
export type RecordData={format:'csv';header:string[];cells:string[]}|{format:'xml';ancestors:{name:string;attributes:Record<string,string>}[];element:XmlNode};
export type RecordEntry={span:Span;data:RecordData};
export type Batch={schema:'large-core-import-parser-batch/v1';provisional:true;index:number;id:string;normalized_bytes:number;records:RecordEntry[]};
export type BatchDescriptor={index:number;id:string;rows:number;normalized_bytes:number;record_spans:Span[];ref:string};
export type RawSeal={sha256:string;byte_count:number;completed_eof:boolean;parse_valid:boolean};
export type Manifest={schema:'large-core-import-file/v1';format:'csv'|'xml';raw:RawSeal&{completed_eof:true;parse_valid:true};header?:string[];raw_header?:string[];records:number;total_batches:number;batches:BatchDescriptor[]};
export type Sink={appendOriginal(bytes:Uint8Array,offset:number):Promise<void>;putBatch(batch:Batch):Promise<string>;sealOriginal(raw:RawSeal):Promise<void>;commitManifest(manifest:Manifest):Promise<void>};
export type Policy={maxFileBytes:number;maxRecords:number;batchRows:number;batchBytes:number;maxRecordBytes:number;maxTokenBytes:number;maxColumns:number;xmlDepth:number;xmlNodes:number};
export type Spec=({format:'csv';delimiter:','|';'|'\t'|'|'}|{format:'xml';recordPath:string})&{limits?:Partial<Policy>};
export const DEFAULT_POLICY:Policy={maxFileBytes:30_000_000,maxRecords:100_000,batchRows:500,batchBytes:1_048_576,maxRecordBytes:1_048_576,maxTokenBytes:1_048_576,maxColumns:1000,xmlDepth:16,xmlNodes:1_000_000};
export class StreamImportError extends Error{constructor(public readonly code:string,message:string){super(message);this.name='StreamImportError';}}
const fail=(code:string,message:string):never=>{throw new StreamImportError(code,message);};
const utf8=(s:string)=>Buffer.byteLength(s,'utf8');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function policy(spec:Spec){if(spec.format!=='csv'&&spec.format!=='xml')fail('policy','Supported format required');if(spec.format==='csv'&&![',',';','\t','|'].includes(spec.delimiter))fail('policy','Explicit supported CSV delimiter required');const p={...DEFAULT_POLICY,...spec.limits};for(const [k,v]of Object.entries(p))if(!Number.isSafeInteger(v)||v<=0)fail('policy',`Invalid ${k}`);if(p.batchRows>500)fail('policy','Batch rows must not exceed500');if(p.batchBytes>2_097_152)fail('policy','Parser batch bytes must not exceed2MiB');return p;}

/** Common deterministic provisional batch builder. Unknown fields never drop from data. */
class Batches{
 readonly descriptors:BatchDescriptor[]=[];records=0;private pending:RecordEntry[]=[];private size=2;
 constructor(private p:Policy,private sink:Sink){}
 async add(data:RecordData,raw:string,start:number,end:number,lineStart:number,lineEnd:number){
  if(++this.records>this.p.maxRecords)fail('records','Whole file record limit exceeded');
  const entry:RecordEntry={span:{ordinal:this.records-1,byte_start:start,byte_end:end,line_start:lineStart,line_end:lineEnd,raw_sha256:hash(raw)},data};
  const n=utf8(JSON.stringify(entry));if(n+2>this.p.batchBytes)fail('row_bytes','One complete normalized record exceeds batch byte limit');
  if(this.pending.length&&(this.pending.length>=this.p.batchRows||this.size+1+n>this.p.batchBytes))await this.flush();
  this.size+=n+(this.pending.length?1:0);this.pending.push(entry);
 }
 async flush(){if(!this.pending.length)return;const records=this.pending,index=this.descriptors.length,id=hash(JSON.stringify({index,records}));const batch:Batch={schema:'large-core-import-parser-batch/v1',provisional:true,index,id,normalized_bytes:this.size,records};const ref=await this.sink.putBatch(batch);if(typeof ref!=='string'||!ref)fail('sink_ref','Provisional storage must return actual opaque ref');this.descriptors.push({index,id,rows:records.length,normalized_bytes:this.size,record_spans:records.map(r=>r.span),ref});this.pending=[];this.size=2;}
}

interface Parser{feed(text:string):Promise<void>;end():Promise<void>;header?:string[];rawHeader?:string[]}
class Csv implements Parser{
 header?:string[];rawHeader?:string[];private cell='';private row:string[]=[];private raw='';private rawBytes=0;private quoted=false;private closed=false;private skipLf=false;private offset=0;private start=0;private line=1;private startLine=1;private first=true;private previousCr=false;
 constructor(private spec:Extract<Spec,{format:'csv'}>,private p:Policy,private batches:Batches){}
 private field(){this.row.push(this.cell);this.cell='';this.closed=false;if(this.row.length>this.p.maxColumns)fail('columns','CSV column limit exceeded');}
 private async finish(end:number){this.field();if(!this.header){this.rawHeader=this.row.slice();this.header=this.row.map(s=>s.trim());if(this.header.some(s=>!s)||new Set(this.header.map(s=>s.toLowerCase())).size!==this.header.length)fail('header','CSV header empty or duplicate');}else{if(this.row.length!==this.header.length)fail('columns','CSV row does not match complete header');await this.batches.add({format:'csv',header:this.header.slice(),cells:this.row.slice()},this.raw,this.start,end,this.startLine,this.line);}this.row=[];this.raw='';this.rawBytes=0;}
 async feed(text:string){for(const ch of text){const at=this.offset,n=utf8(ch);this.offset+=n;if(this.first){this.first=false;if(ch==='\uFEFF'){this.start=this.offset;continue;}}
   if(this.skipLf){this.skipLf=false;if(ch==='\n'){this.start=this.offset;this.startLine=this.line;this.previousCr=false;continue;}}
   if(!this.quoted&&(ch==='\r'||ch==='\n')){await this.finish(at);if(ch==='\r'){this.skipLf=true;this.previousCr=true;}else this.previousCr=false;this.line++;this.start=this.offset;this.startLine=this.line;continue;}
   this.raw+=ch;this.rawBytes+=n;if(this.rawBytes>this.p.maxRecordBytes)fail('row_bytes','Raw CSV record exceeds bound');
   if(this.quoted){if(ch==='"'){this.quoted=false;this.closed=true;}else this.cell+=ch;}
   else if(this.closed){if(ch==='"'){this.cell+='"';this.quoted=true;this.closed=false;}else if(ch===this.spec.delimiter)this.field();else fail('csv_quote','CSV text after closing quote');}
   else if(ch===this.spec.delimiter)this.field();else if(ch==='"'){if(this.cell)fail('csv_quote','Quote inside unquoted CSV field');this.quoted=true;}else this.cell+=ch;
   if(ch==='\r'){this.line++;this.previousCr=true;}else if(ch==='\n'){if(!this.previousCr)this.line++;this.previousCr=false;}else this.previousCr=false;
  }}
 async end(){if(this.quoted)fail('csv_quote','Unterminated CSV quote');if(this.raw.length||this.cell.length||this.row.length||this.closed)await this.finish(this.offset);if(!this.header||!this.batches.records)fail('empty','Import needs header and at least one row');}
}

type Token={raw:string;start:number;end:number;lineStart:number;lineEnd:number};
/** Lexical boundary feeder: exact UTF8 offsets, bounded markup token, no whole-file tree. */
class Xml implements Parser{
 private sax=new SaxesParser({xmlns:false});private buffer='';private offset=0;private line=1;private previousCr=false;private first=true;private stack:XmlNode[]=[];private selected?:{node:XmlNode;ancestors:{name:string;attributes:Record<string,string>}[];raw:string;bytes:number;start:number;line:number};private current!:Token;private completed?:{data:RecordData;raw:string;start:number;end:number;lineStart:number;lineEnd:number};private count=0;private saxError?:Error;
 constructor(private spec:Extract<Spec,{format:'xml'}>,private p:Policy,private batches:Batches){
  if(!catalogXmlPathValid(spec.recordPath,true,p.xmlDepth)||spec.recordPath.includes('@'))fail('xml_path','Exact element record_path required');
  this.sax.on('error',e=>{this.saxError=e;});this.sax.on('doctype',()=>fail('xml_dtd','DTD forbidden'));this.sax.on('processinginstruction',()=>fail('xml_pi','Processing instruction forbidden'));
  this.sax.on('opentag',tag=>{this.nodeCount(1+Object.keys(tag.attributes).length);if(this.stack.length+1>p.xmlDepth)fail('xml_depth','XML depth exceeded');const node:XmlNode={name:tag.name,attributes:Object.fromEntries(Object.entries(tag.attributes).map(([k,v])=>[k,String(v)])),content:[]};const path='/'+[...this.stack.map(x=>x.name),tag.name].join('/');if(path===spec.recordPath){if(this.selected)fail('xml_record','Nested overlapping selected records');const bytes=utf8(this.current.raw);if(bytes>p.maxRecordBytes)fail('row_bytes','Raw XML record exceeds bound');this.selected={node,ancestors:this.stack.map(x=>({name:x.name,attributes:{...x.attributes}})),raw:this.current.raw,bytes,start:this.current.start,line:this.current.lineStart};}else if(this.selected){const parent=this.stack.at(-1)!;parent.content.push({type:'element',element:node});}this.stack.push(node);});
  const text=(kind:'text'|'cdata',value:string)=>{if(!value)return;this.nodeCount(1);if(this.selected){const parts=this.stack.at(-1)!.content,last=parts.at(-1);if(last&&last.type===kind)last.value+=value;else parts.push({type:kind,value});}};
  this.sax.on('text',s=>text('text',s));this.sax.on('cdata',s=>text('cdata',s));this.sax.on('closetag',()=>{const node=this.stack.pop()!;if(this.selected?.node===node){const s=this.selected;this.completed={data:{format:'xml',ancestors:s.ancestors,element:s.node},raw:s.raw,start:s.start,end:this.current.end,lineStart:s.line,lineEnd:this.current.lineEnd};this.selected=undefined;}});
 }
 private nodeCount(n:number){this.count+=n;if(this.count>this.p.xmlNodes)fail('xml_nodes','XML node count exceeded');}
 private tokenEnd():number{
  if(!this.buffer.startsWith('<')){const n=this.buffer.indexOf('<');return n<0?-1:n;}
  if(this.buffer.startsWith('<!--')){const n=this.buffer.indexOf('-->',4);return n<0?-1:n+3;}
  if(this.buffer.startsWith('<![CDATA[')){const n=this.buffer.indexOf(']]>',9);return n<0?-1:n+3;}
  if(this.buffer.startsWith('<?')){const n=this.buffer.indexOf('?>',2);if(n<0)return-1;if(!/^<\?xml\s/.test(this.buffer))fail('xml_pi','Processing instruction forbidden');return n+2;}
  if(this.buffer.startsWith('<!')&&!('<!--'.startsWith(this.buffer)||'<![CDATA['.startsWith(this.buffer)))fail('xml_dtd','DTD/entity declaration forbidden');
  let quote='';for(let i=1;i<this.buffer.length;i++){const c=this.buffer[i];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>')return i+1;}return-1;
 }
 private async write(raw:string){const t:Token={raw,start:this.offset,end:this.offset+utf8(raw),lineStart:this.line,lineEnd:this.line};for(const ch of raw){if(ch==='\r'){this.line++;this.previousCr=true;}else if(ch==='\n'){if(!this.previousCr)this.line++;this.previousCr=false;}else this.previousCr=false;}t.lineEnd=this.line;this.offset=t.end;this.current=t;
  if(this.selected){this.selected.raw+=raw;this.selected.bytes+=utf8(raw);if(this.selected.bytes>this.p.maxRecordBytes)fail('row_bytes','Raw XML record exceeds bound');}
  this.sax.write(raw);if(this.saxError)fail('xml_syntax','Invalid XML: '+this.saxError.message);if(this.completed){const c=this.completed;this.completed=undefined;await this.batches.add(c.data,c.raw,c.start,c.end,c.lineStart,c.lineEnd);}
 }
 async feed(text:string){if(this.first&&text){this.first=false;if(text[0]==='\uFEFF'){text=text.slice(1);this.offset=3;}}this.buffer+=text;for(;;){const end=this.tokenEnd();if(end<0){if(utf8(this.buffer)>this.p.maxTokenBytes)fail('xml_token','XML token exceeds bound');break;}const token=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end);if(utf8(token)>this.p.maxTokenBytes)fail('xml_token','XML token exceeds bound');await this.write(token);}}
 async end(){if(this.buffer){if(this.buffer.startsWith('<'))fail('xml_syntax','Incomplete XML markup');await this.write(this.buffer);this.buffer='';}this.sax.close();if(this.saxError)fail('xml_syntax','Invalid XML: '+this.saxError.message);if(this.selected||this.stack.length||!this.batches.records)fail('empty','No complete selected XML records');}
}

export async function retainAndChunkImport(chunks:AsyncIterable<Uint8Array>,spec:Spec,sink:Sink):Promise<Manifest>{
 const p=policy(spec),batches=new Batches(p,sink),parser:Parser=spec.format==='csv'?new Csv(spec,p,batches):new Xml(spec,p,batches),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),digest=createHash('sha256');let bytes=0,error:unknown,failed=false,complete=false;const retainError=(e:unknown)=>{if(!failed){failed=true;error=e;}};
 try{for await(const chunk of chunks){if(!(chunk instanceof Uint8Array))fail('input','Expected byte chunks');for(let i=0;i<chunk.length;i+=65536){const part=chunk.subarray(i,Math.min(chunk.length,i+65536));if(bytes+part.length>p.maxFileBytes)fail('file_bytes','Whole original file exceeds byte limit');await sink.appendOriginal(part.slice(),bytes);digest.update(part);bytes+=part.length;if(!failed){try{await parser.feed(decoder.decode(part,{stream:true}));}catch(e){retainError(e);}}}}complete=true;if(!failed){try{await parser.feed(decoder.decode());await parser.end();await batches.flush();}catch(e){retainError(e);}}}
 catch(e){retainError(e);}
 const raw:RawSeal={sha256:digest.digest('hex'),byte_count:bytes,completed_eof:complete,parse_valid:complete&&!failed};try{await sink.sealOriginal(raw);}catch(e){retainError(e);}if(failed)throw error;if(!raw.parse_valid)fail('incomplete','Original file incomplete');
 const manifest:Manifest={schema:'large-core-import-file/v1',format:spec.format,raw:{...raw,completed_eof:true,parse_valid:true},...(parser.header?{header:parser.header,raw_header:parser.rawHeader}:{}),records:batches.records,total_batches:batches.descriptors.length,batches:batches.descriptors};await sink.commitManifest(manifest);return manifest;
}
