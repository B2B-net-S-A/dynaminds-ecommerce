/** Public-document discovery only. No token, provider requests or product acceptance. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';

export const BASE_API_INDEX_URL='https://api.baselinker.com/';
const MAX=2*1024*1024;
const digest=b=>createHash('sha256').update(b).digest('hex');
export function parseBaseApiIndex(bytes){
 assert(bytes instanceof Uint8Array&&bytes.length>0&&bytes.length<=MAX,'bounded-document-required');
 const html=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 // JSDOM does not execute scripts or load linked resources with these defaults.
 const dom=new JSDOM(html,{url:BASE_API_INDEX_URL});
 try{
  const document=dom.window.document,containers=document.querySelectorAll('.main_text');
  assert.equal(containers.length,1,'one-public-index-container-required');
  const container=containers[0],methods=[],seen=new Set(),methodAnchors=new Set();
  let family=null,group=null;
  for(const element of container.children){
   if(element.matches('div.header')){family=element.textContent.trim();group=null;continue;}
   if(element.tagName==='H3'){group=element.textContent.trim();continue;}
   if(element.tagName!=='TABLE')continue;
   assert(family&&group,'method-family-and-group-required');
   const rows=[...element.querySelectorAll('tr')];assert(rows.length,'nonempty-method-table-required');
   for(const row of rows){
    const links=row.querySelectorAll('td:first-child a[href]');
    assert.equal(links.length,1,'one-method-link-per-row-required');
    const link=links[0],url=new URL(link.getAttribute('href'),BASE_API_INDEX_URL);
    assert.equal(url.origin,new URL(BASE_API_INDEX_URL).origin,'official-method-origin-required');
    assert(url.pathname==='/index.php'&&!url.hash&&!url.username&&!url.password,'official-method-path-required');
    assert.deepEqual([...url.searchParams.keys()],['method'],'exact-method-query-required');
    const method=url.searchParams.get('method');
    assert(/^[a-z][A-Za-z0-9]{1,95}$/.test(method??'')&&link.textContent.trim()===method,'exact-method-name-required');
    assert(!seen.has(method),'duplicate-method-refused');seen.add(method);methodAnchors.add(link);
    methods.push({id:'BASE-API-'+method,method,family,group,source_url:url.href,
     status:'index_only_contract_unreviewed',contract_reviewed:false,implementation_verified:false,
     acceptance_granted:false});
   }
  }
  assert(methods.length,'nonempty-method-index-required');
  // A method link outside the recognized tables is a changed index, not a silent omission.
  for(const anchor of document.querySelectorAll('a[href]')){
   const url=new URL(anchor.getAttribute('href'),BASE_API_INDEX_URL);
   if(url.searchParams.has('method'))assert(methodAnchors.has(anchor),'unclassified-method-link-refused');
  }
  const counts={};for(const method of methods)counts[method.family]=(counts[method.family]??0)+1;
  return{schema:'dynaminds-base-public-api-index/v1',as_of:'2026-10-17',
   source:{url:BASE_API_INDEX_URL,sha256:digest(bytes),bytes:bytes.length},
   index_entries:methods.length,families:counts,index_snapshot_enumerated:true,
   full_contract_inventory_complete:false,implementation_coverage_measured:false,acceptance_granted:false,
   open_work:['Review each method input, output, errors and pagination from its own documentation.',
    'Map every operation to actual local UI/API behavior and identify confirmed gaps.',
    'Version the required scope additively before granting any operation acceptance.',
    'Verify wire compatibility separately from functional similarity.'],methods};
 }finally{dom.window.close();}
}

export async function main(args){
 assert(args.length===2,'usage-base-api-index-local-html-fresh-json');
 const [input,output]=args.map(p=>path.resolve(p));assert.notEqual(input,output);
 const stat=await fs.lstat(input);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=MAX,'bounded-regular-input-required');
 const result=parseBaseApiIndex(await fs.readFile(input));
 await fs.writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 return{index_entries:result.index_entries,families:result.families,acceptance_granted:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).then(x=>process.stdout.write(JSON.stringify(x)+'\n')).catch(()=>{process.stderr.write('Public API index discovery failed; no acceptance granted.\n');process.exitCode=1;});
}
