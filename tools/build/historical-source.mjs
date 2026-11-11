/** Build-only unresolved archive edges are external until the emitted cut proves them dead. */
import path from 'node:path';

export function historicalSource(args,projectRoot){
 if(!args.importer||!args.path.startsWith('.'))return undefined;
 const absolute=path.resolve(args.resolveDir,args.path);
 const relative=path.relative(projectRoot,absolute).split(path.sep).join('/');
 if(relative.startsWith('data/source-drafts/'))return {path:relative,external:true};
}
