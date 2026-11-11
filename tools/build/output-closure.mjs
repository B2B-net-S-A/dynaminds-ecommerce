/** Build output selection only; never grants an installed runtime capability. */
import assert from 'node:assert/strict';
import path from 'node:path';

export function selectRuntimeOutputs(metafile,entrypoints){
  assert(metafile?.outputs&&Array.isArray(entrypoints)&&entrypoints.length>0);
  assert.equal(new Set(entrypoints).size,entrypoints.length,'duplicate-runtime-entry');
  const outputs=metafile.outputs,roots=[];
  for(const entry of entrypoints){
    const matches=Object.entries(outputs).filter(([,value])=>value.entryPoint===entry).map(([file])=>file);
    assert.equal(matches.length,1,'runtime-entry-output-not-unique');roots.push(matches[0]);
  }
  const reachable=new Set(),pending=[...roots];
  while(pending.length){
    const file=pending.pop();if(reachable.has(file))continue;reachable.add(file);
    for(const edge of outputs[file].imports??[]){
      if(edge.external===true)continue;
      const candidates=[...new Set([path.posix.normalize(edge.path),path.posix.normalize(path.posix.join(path.posix.dirname(file),edge.path))])].filter(candidate=>Object.hasOwn(outputs,candidate));
      assert.equal(candidates.length,1,'runtime-output-edge-unresolved-or-ambiguous');pending.push(candidates[0]);
    }
  }
  const sources=new Set(),external=new Set();
  for(const file of reachable){
    for(const [source,identity]of Object.entries(outputs[file].inputs??{}))if(identity.bytesInOutput>0)sources.add(source);
    for(const edge of outputs[file].imports??[])if(edge.external===true)external.add(edge.path);
  }
  return{roots:roots.sort(),files:[...reachable].sort(),excluded_unreachable:Object.keys(outputs).filter(file=>!reachable.has(file)).sort(),emitted_sources:[...sources].sort(),external_specifiers:[...external].sort(),scope:'EMITTED_IMPORT_GRAPH_ONLY_NOT_INSTALLED_AUTHORITY'};
}
