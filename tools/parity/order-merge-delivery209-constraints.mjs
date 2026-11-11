/** Bounded source-only oracle for the FOUR authored CHECK changes. No DB/IO. */
import assert from 'node:assert/strict';

export function orderMergeDelivery209CheckAst(value){
 assert.equal(typeof value,'string');assert(value.length<=8192);const tokens=[];
 for(let i=0;i<value.length;){
  if(/\s/.test(value[i])){i++;continue;}
  const rest=value.slice(i);let m;
  if((m=/^'(?:[^']|'')*'/.exec(rest))){tokens.push({string:m[0].slice(1,-1).replaceAll("''","'")});i+=m[0].length;}
  else if((m=/^[A-Za-z_][A-Za-z_0-9]*/.exec(rest))){tokens.push(m[0].toLowerCase());i+=m[0].length;}
  else if(rest.startsWith('::')){tokens.push('::');i+=2;}
  else {assert('()[]=~,'.includes(value[i]),'unsupported CHECK token');tokens.push(value[i++]);}
  assert(tokens.length<=512,'bounded CHECK tokens');
 }
 let at=0,depth=0;const peek=()=>tokens[at],take=t=>{assert.equal(tokens[at++],t,'exact CHECK grammar');};
 function text(){const t=tokens[at++];assert(t&&typeof t==='object'&&typeof t.string==='string','text literal required');if(peek()==='::'){take('::');take('text');}return t.string;}
 function comparison(){const key=tokens[at++];assert(['kind','actor_id','api_key_id','token_digest'].includes(key),'known166 column only');
  if(peek()==='is'){take('is');let neg=false;if(peek()==='not'){take('not');neg=true;}take('null');return['is',key,neg?'not_null':'null'];}
  const op=tokens[at++];assert(['=','~','in'].includes(op),'known166 comparison only');
  if(op==='in'){take('(');const values=[text()];while(peek()===','){take(',');values.push(text());}take(')');return['any',key,values];}
  if(peek()==='any'){assert.equal(op,'=');take('any');take('(');take('array');take('[');const values=[text()];while(peek()===','){take(',');values.push(text());}take(']');if(peek()==='::'){take('::');take('text');take('[');take(']');}take(')');return['any',key,values];}
  return[op,key,text()];
 }
 function factor(){assert(++depth<=32,'bounded CHECK nesting');let r;if(peek()==='('){take('(');r=or();take(')');}else r=comparison();depth--;return r;}
 function and(){const values=[factor()];while(peek()==='and'){take('and');values.push(factor());}return values.length===1?values[0]:['and',...values.flatMap(v=>v[0]==='and'?v.slice(1):[v])];}
 function or(){const values=[and()];while(peek()==='or'){take('or');values.push(and());}return values.length===1?values[0]:['or',...values.flatMap(v=>v[0]==='or'?v.slice(1):[v])];}
 take('check');const result=factor();assert.equal(at,tokens.length,'no trailing CHECK tokens');return result;
}

const expressions=Object.freeze({
 kind_before:"CHECK (kind IN('access','delivery'))",
 kind_after:"CHECK (kind IN('access','delivery','merge_inherit'))",
 actor_before:"CHECK ((kind='access' AND actor_id IS NOT NULL AND token_digest IS NULL) OR(kind='delivery' AND actor_id IS NULL AND api_key_id IS NULL AND token_digest IS NOT NULL AND token_digest ~ '^[a-f0-9]{64}$'))",
 actor_after:"CHECK ((kind IN('access','merge_inherit') AND actor_id IS NOT NULL AND token_digest IS NULL) OR(kind='delivery' AND actor_id IS NULL AND api_key_id IS NULL AND token_digest IS NOT NULL AND token_digest ~ '^[a-f0-9]{64}$'))",
});
export const ORDER_MERGE_DELIVERY209_CHECK_EXPRESSIONS=expressions;
/** Input BEFORE must be an independently authenticated Source208 catalogue.
 * Names/other metadata are preserved byte-for-byte. NEW defs are matched to
 * authored boolean ASTs; arbitrary deparser formatting never supplies authority. */
export function assertOrderMergeDelivery209ConstraintChanges(changes){
 assert(Array.isArray(changes)&&changes.length===4,'exact four CHECK changes');const seen=new Set();
 for(const c of changes){
  assert.equal(c.kind,'constraint');assert(c.before&&c.after);assert.equal(typeof c.key,'string');
  const table=['buyer_address_previews','buyer_address_receipts'].find(t=>c.key.startsWith('public.'+t+'.'));
  assert(table,'only166 previews/receipts checks');const before=orderMergeDelivery209CheckAst(c.before.definition);
  const role=['kind','actor'].find(k=>JSON.stringify(before)===JSON.stringify(orderMergeDelivery209CheckAst(expressions[k+'_before'])));
  assert(role,'literal166 predecessor CHECK semantics');assert(!seen.has(table+':'+role),'one change per authored166 check');seen.add(table+':'+role);
  assert.deepEqual(orderMergeDelivery209CheckAst(c.after.definition),orderMergeDelivery209CheckAst(expressions[role+'_after']),'exact209 authored CHECK semantics');
  const {definition:b,...oldMetadata}=c.before,{definition:a,...newMetadata}=c.after;
  assert.deepEqual(newMetadata,oldMetadata,'all other CHECK metadata remains literal');
 }
 assert.equal(seen.size,4);return true;
}
