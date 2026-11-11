/** Separate recovery capability: genuine reviewed Startup, never importer readiness. Export-only. */
import assert from 'node:assert/strict';
import type {FastifyRequest} from 'fastify';
import {z} from 'zod';
import {createOrdinarySchemaTransactionGate,type ReviewedStartup} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
export const expiryText=z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,23)===v.slice(0,23));
export const renewalExpectation=z.strictObject({expected_job_expires_at:expiryText,expected_review_expires_at:expiryText});
export type RenewalExpectation=z.infer<typeof renewalExpectation>;
export type RenewalPreview={schema:'owned-business-quota-renewal-preview/v1';job_id:string;catalog_id:string;expected_job_expires_at:string;expected_review_expires_at:string;eligible:boolean;blockers:string[];protocol_only:true;importer_ready:false};
export type RenewalResult={schema:'owned-business-quota-renewal/v1';job_id:string;catalog_id:string;job_expires_at:string;review_expires_at:string;renewed:true;accounting_preserved:true;no_business_replay:true;importer_ready:false};
declare const recoveryBrand:unique symbol;
export type BusinessQuotaRecoveryPort={readonly [recoveryBrand]:true};
type Functions={preview(original:FastifyRequest):Promise<RenewalPreview>;renew(original:FastifyRequest,expected:RenewalExpectation,signal:AbortSignal):Promise<RenewalResult>};
const ports=new WeakMap<object,{startup:ReviewedStartup;functions:Functions}>();
/** Only trusted producer construction supplies these functions; route JSON cannot construct a Startup or a port. */
export function createBusinessQuotaRecoveryPort(startup:ReviewedStartup,functions:Functions):BusinessQuotaRecoveryPort{
 createOrdinarySchemaTransactionGate(startup);assert(typeof functions.preview==='function'&&typeof functions.renew==='function');
 const port=Object.freeze(Object.create(null)) as BusinessQuotaRecoveryPort;ports.set(port,{startup,functions:{...functions}});return port;
}
export function assertBusinessQuotaRecoveryPort(port:unknown):asserts port is BusinessQuotaRecoveryPort{
 assert(port&&typeof port==='object'&&ports.has(port),'business-quota-genuine-recovery-capability');createOrdinarySchemaTransactionGate(ports.get(port)!.startup);
}
export function inspectBusinessQuotaRecovery(port:BusinessQuotaRecoveryPort,original:FastifyRequest){assertBusinessQuotaRecoveryPort(port);return ports.get(port)!.functions.preview(original);}
export function renewBusinessQuotaRecovery(port:BusinessQuotaRecoveryPort,original:FastifyRequest,input:unknown,signal:AbortSignal){assertBusinessQuotaRecoveryPort(port);const expected=renewalExpectation.parse(input);signal.throwIfAborted();return ports.get(port)!.functions.renew(original,expected,signal);}
