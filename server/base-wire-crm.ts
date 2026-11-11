import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { z } from 'zod';
import { ensure } from './errors';
import { crmProfileShape } from './crm-schema';
import { parseBaseWireId, type BaseWireJson } from './base-wire-codec';
import { withBaseWireCrmAuthority, type BaseWireCrmAuthority } from './base-wire-crm-authority';
import type { createCrmClientWirePort } from './crm';

export const BASE_WIRE_CRM_METHODS = ['addCrmClient','getCrmClientData','getCrmClients','deleteCrmClient','getCrmClientExtraFields'] as const;
export const isBaseWireCrmWrite = (method: string) => method === 'addCrmClient' || method === 'deleteCrmClient';
export const baseWireCrmScope = (method: string) => isBaseWireCrmWrite(method) ? 'crm:write' as const : 'crm:read' as const;
export type BaseWireCrmPorts = {
  transaction<T>(actor: Actor, writing: boolean, work: (c: PoolClient) => Promise<T>): Promise<T>;
  authorize(c: PoolClient, actor: Actor, writing: boolean): Promise<BaseWireCrmAuthority>;
  domain(c: PoolClient, actor: Actor, proof: BaseWireCrmAuthority): ReturnType<typeof createCrmClientWirePort>;
};
const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const { status_id: _status, custom_extra_fields: _extras, ...profileShape } = crmProfileShape;
const add = z.object({ crm_client_id: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), ...profileShape, status_id: id.optional(), custom_extra_fields: z.record(z.string().regex(/^[1-9][0-9]*$/),z.unknown()).optional() }).strict();
const detail = z.object({ crm_client_id: id, include_custom_extra_fields: z.boolean().default(false) }).strict();
const remove = z.object({ crm_client_id: id }).strict();
const definitions = z.object({}).strict();
const list = z.object({
  page: z.number().int().min(1).max(100000).default(1),
  filter_crm_client_id: id.optional(), filter_status_id: id.optional(),
  filter_email: z.string().max(220).optional(), filter_phone: z.string().max(156).optional(), filter_login: z.string().max(156).optional(),
  filter_invoice_company: z.string().max(500).optional(), filter_invoice_tax_id: z.string().max(50).optional(), filter_invoice_fullname: z.string().max(500).optional(),
}).strict();
const maps = { client:'base_wire218_client_ids',status:'base_wire218_status_ids',field:'base_wire218_field_ids' } as const;
function publicNumber(raw: unknown): number {
  ensure(typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) && BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER),503,'Niespójna liczbowa tożsamość CRM');
  return parseBaseWireId(Number(raw),false);
}
async function local(c: PoolClient, actor: Actor, kind: keyof typeof maps, publicId: number) {
  const rows=(await c.query(`SELECT local_id FROM ${maps[kind]} WHERE tenant_id=$1::uuid AND public_id=$2::bigint AND local_id IS NOT NULL`,[actor.tenantId,publicId])).rows;
  ensure(rows.length===1,404,'Nie znaleziono własnego zasobu CRM');return rows[0].local_id as string;
}
async function filterId(c: PoolClient, actor: Actor, kind: 'client'|'status', publicId:number) {
  const rows=(await c.query(`SELECT local_id FROM ${maps[kind]} WHERE tenant_id=$1::uuid AND public_id=$2::bigint AND local_id IS NOT NULL`,[actor.tenantId,publicId])).rows;
  ensure(rows.length<=1,503,'Niespójna mapa CRM');return rows[0]?.local_id as string|undefined;
}
async function numeric(c: PoolClient, actor: Actor, kind: keyof typeof maps, uuid: string) {
  const rows=(await c.query(`SELECT public_id::text AS public_id FROM ${maps[kind]} WHERE tenant_id=$1::uuid AND local_id=$2::uuid`,[actor.tenantId,uuid])).rows;
  ensure(rows.length===1,503,'Brak trwałej tożsamości CRM; wymagany poprawny bootstrap');return publicNumber(rows[0].public_id);
}
export function createBaseWireCrmService(ports: BaseWireCrmPorts) {
  const tx = <T>(actor: Actor, writing: boolean, work:(c:PoolClient,domain:ReturnType<typeof createCrmClientWirePort>)=>Promise<T>) => ports.transaction(actor,writing,async c=>{
    if(writing)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['crm215:'+actor.tenantId]);
    return withBaseWireCrmAuthority(c,actor,writing,async proof => work(c,ports.domain(c,actor,proof)),ports.authorize);
  });
  async function output(c:PoolClient,actor:Actor,row:Record<string,any>,extras:boolean) {
    const out:Record<string,BaseWireJson>={};
    for(const k of Object.keys(profileShape))if(Object.hasOwn(row,k))out[k]=row[k];
    out.crm_client_id=await numeric(c,actor,'client',row.id);out.status_id=await numeric(c,actor,'status',row.status_id);
    if(extras){
      const values:Record<string,BaseWireJson>={};
      for(const [uuid,value]of Object.entries(row.custom_extra_fields??{})){
        const fieldId=await numeric(c,actor,'field',uuid);
        values[String(fieldId)]=value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'url')
          ? {title:(value as {title:string}).title,url:`/connector.php/files/clients/${out.crm_client_id}/fields/${fieldId}`}
          : value as BaseWireJson;
      }
      out.custom_extra_fields=values;
    }
    return out;
  }
  return {
    async execute(actor:Actor, method:string, parameters:Record<string,BaseWireJson>, options:{clientKey?:string}={}) {
      ensure(BASE_WIRE_CRM_METHODS.includes(method as any),400,'Nieznana metoda CRM');
      if(method==='addCrmClient'){
        const b=add.parse(parameters),clientKey=options.clientKey??randomUUID();z.uuid().parse(clientKey);
        return tx(actor,true,async(c,domain)=>{
          const requestHash=createHash('sha256').update(JSON.stringify({method,parameters})).digest('hex');
          const retained=await domain.replay(clientKey,requestHash);
          if(retained)return {crm_client_id:await numeric(c,actor,'client',retained.id)};
          const clientId=b.crm_client_id?await local(c,actor,'client',b.crm_client_id):null;
          const profile:Record<string,unknown>=Object.fromEntries(Object.entries(b).filter(([k])=>k!=='crm_client_id'&&k!=='status_id'&&k!=='custom_extra_fields'));
          if(b.status_id!==undefined)profile.status_id=await local(c,actor,'status',b.status_id);
          if(b.custom_extra_fields!==undefined){const values:Record<string,unknown>={};for(const [key,value]of Object.entries(b.custom_extra_fields))values[await local(c,actor,'field',parseBaseWireId(Number(key),false))]=value;profile.custom_extra_fields=values;}
          const row=await domain.save(clientId,profile,clientKey,requestHash);
          return {crm_client_id:await numeric(c,actor,'client',row.id)};
        });
      }
      if(method==='deleteCrmClient'){
        const b=remove.parse(parameters),clientKey=options.clientKey??randomUUID();z.uuid().parse(clientKey);
        return tx(actor,true,async(c,domain)=>{
          const requestHash=createHash('sha256').update(JSON.stringify({method,parameters})).digest('hex');
          const retained=await domain.replay(clientKey,requestHash);
          if(retained){ensure(retained.deleted===true,503,'Niespójne potwierdzenie usunięcia CRM');return {};}
          await domain.remove(await local(c,actor,'client',b.crm_client_id),clientKey,requestHash);
          // The retained contract declares only the common SUCCESS envelope.
          // Repeat-delete/error and HTTP choices remain explicit local policy.
          return {};
        });
      }
      if(method==='getCrmClientExtraFields'){
        definitions.parse(parameters);
        return tx(actor,false,async(c,domain)=>{
          // Retained prose says keyed collection, while its table/example say
          // array. Array output and active-only discovery are explicit LOCAL
          // choices, not proof of undocumented vendor/archive semantics.
          const fields=await domain.fields(),extra_fields:Record<string,BaseWireJson>[]=[];
          for(const field of fields){
            if(field.archived===true)continue;
            const row:Record<string,BaseWireJson>={extra_field_id:await numeric(c,actor,'field',field.extra_field_id),name:field.name,editor_type:field.editor_type};
            if(['select','checkbox','radio'].includes(field.editor_type))row.options=field.options;
            extra_fields.push(row);
          }
          return {extra_fields};
        });
      }
      if(method==='getCrmClientData'){
        const b=detail.parse(parameters);return tx(actor,false,async(c,domain)=>output(c,actor,await domain.detail(await local(c,actor,'client',b.crm_client_id),b.include_custom_extra_fields),b.include_custom_extra_fields));
      }
      const b=list.parse(parameters);return tx(actor,false,async(c,domain)=>{
        const query:Record<string,unknown>={page:b.page,limit:100};
        if(b.filter_crm_client_id!==undefined){const uuid=await filterId(c,actor,'client',b.filter_crm_client_id);if(!uuid)return {clients:[]};query.client_id=uuid;}
        if(b.filter_status_id!==undefined){const uuid=await filterId(c,actor,'status',b.filter_status_id);if(!uuid)return {clients:[]};query.status_id=uuid;}
        for(const key of ['email','phone','login','invoice_company','invoice_tax_id','invoice_fullname']as const)if(b['filter_'+key as keyof typeof b]!==undefined)query[key]=b['filter_'+key as keyof typeof b];
        const rows=await domain.list(query);return {clients:await Promise.all(rows.map(row=>output(c,actor,row,false)))};
      });
    },
    async file(actor:Actor,clientId:number,fieldId:number){return tx(actor,false,async(c,domain)=>domain.file(await local(c,actor,'client',parseBaseWireId(clientId,false)),await local(c,actor,'field',parseBaseWireId(fieldId,false))));},
  };
}
export type BaseWireCrmService = ReturnType<typeof createBaseWireCrmService>;
