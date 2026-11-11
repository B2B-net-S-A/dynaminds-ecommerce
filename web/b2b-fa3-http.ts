import {api} from './api';
import type {B2bFa3UiTransport} from './b2b-fa3-projects';

// Bind only after the real158 namespace is installed. No capability fallback,
// invented receipt or conversion of an unavailable response into success.
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
function requireValue(v:unknown):asserts v{if(!v)throw Error('Niepełny kontrakt HTTP projektu B2B.');}
function exact(v:unknown,keys:readonly string[]){requireValue(v&&typeof v==='object'&&!Array.isArray(v));requireValue(Object.keys(v).sort().join('|')===[...keys].sort().join('|'));}
function body(value:unknown){requireValue(typeof value==='string');let b:unknown;try{b=JSON.parse(value);}catch{throw Error('Niepełny request projektu B2B.');}requireValue(b&&typeof b==='object'&&!Array.isArray(b)&&JSON.stringify(b)===value);return b as Record<string,unknown>;}
export const b2bFa3HttpTransport:B2bFa3UiTransport={contract:'b2b-fa3-ui/v1',async request(operation,input){
 if(operation==='options'){exact(input,[]);return api('/b2b-fa3/options');}
 if(operation==='source'){exact(input,['order_id']);requireValue(uuid(input.order_id));return api('/b2b-fa3/orders/'+input.order_id+'/source');}
 if(operation==='project'){exact(input,['id']);requireValue(uuid(input.id));return api('/b2b-fa3/projects/'+input.id);}
 if(operation==='preview'){
  exact(input,['order_id','body']);requireValue(uuid(input.order_id));const b=body(input.body);requireValue(b.order_id===input.order_id);
  const v=await api('/b2b-fa3/orders/'+input.order_id+'/previews','POST',b);
  // The actual route unwraps its private service {preview,reused}; accept only
  // the exact public preview. Never unwrap arbitrary HTTP wrappers or candidate.
  exact(v,['id','order_id','series_id','scope_hash','expires_at','draft','draft_hash','xml_mapping_ready','can_approve']);requireValue(v.order_id===input.order_id);return v;
 }
 if(operation==='approve'){
  exact(input,['order_id','id','body']);requireValue(uuid(input.order_id)&&uuid(input.id));const b=body(input.body);
  exact(b,['client_key','scope_hash','confirmed','project_only']);requireValue(uuid(b.client_key)&&typeof b.scope_hash==='string'&&/^[a-f0-9]{64}$/.test(b.scope_hash)&&b.confirmed===true&&b.project_only===true);
  return api('/b2b-fa3/previews/'+input.id+'/approve','POST',b);
 }
 throw Error('Nieobsługiwana operacja projektu B2B.');
}};
