/** Private ordinary-runtime opt-in; creation performs no DNS, requests or configuration IO. */
import assert from 'node:assert/strict';
import {createProviderReadTransport,type ProviderReadPolicy,type ProviderReadTransport} from './provider-read-transport';
export type {ProviderReadPolicy} from './provider-read-transport';

export function prepareOrdinaryProviderReads(policy:ProviderReadPolicy|undefined,context:{readOnly:boolean;localWooFixture:boolean}):ProviderReadTransport|undefined{
 if(policy===undefined)return undefined;
 assert(!context.readOnly,'ordinary-readonly-no-provider-reads');
 assert(!context.localWooFixture,'ordinary-provider-reads-no-local-woo-fixture');
 assert(policy&&typeof policy==='object'&&!Array.isArray(policy),'ordinary-private-provider-read-policy');
 assert.deepEqual(Object.keys(policy),['routes'],'ordinary-private-provider-read-policy-keys');
 // The policy is trusted construction material, never a public request parameter.
 // Snapshot once; transport validates exact origins/routes/methods and keeps its own caps.
 return createProviderReadTransport(structuredClone(policy));
}


import {nbpLatestTableAReadPolicy,readLatestNbpTableARate} from './nbp-exchange-rates';
import {nbp227ReadPolicy,readNbp227TableA} from './nbp227-fetch';
import type {NbpRatesPort} from './nbp-routes';
export type OrdinaryNbpRatesConfiguration={currencies:readonly string[];maxAgeDays:number};
/** Exact opt-in consumes an already declared transport route; it never adds an allowlist. */
export function prepareOrdinaryNbpRates(configuration:OrdinaryNbpRatesConfiguration|undefined,policy:ProviderReadPolicy|undefined,transport:ProviderReadTransport|undefined,context:{readOnly:boolean;localWooFixture:boolean}):NbpRatesPort|undefined{
 if(configuration===undefined)return undefined;
 assert(!context.readOnly,'ordinary-readonly-no-nbp-rates');assert(!context.localWooFixture,'ordinary-nbp-rates-no-local-woo-fixture');
 assert(configuration&&typeof configuration==='object'&&!Array.isArray(configuration),'ordinary-private-nbp-rates');
 assert.deepEqual(Object.keys(configuration).sort(),['currencies','maxAgeDays']);
 const snapshot=structuredClone(configuration);assert.deepEqual(snapshot.currencies,['EUR'],'ordinary-nbp-eur-only');
 assert(Number.isSafeInteger(snapshot.maxAgeDays)&&snapshot.maxAgeDays>=0&&snapshot.maxAgeDays<=31,'ordinary-nbp-freshness');
 assert(policy&&transport,'ordinary-nbp-declared-provider-reads-required');
 const required=nbpLatestTableAReadPolicy('EUR').routes[0]!;
 assert(policy.routes.some(r=>r.origin===required.origin&&r.path===required.path&&r.methods?.length===1&&r.methods[0]==='GET'&&r.queryKeys?.length===1&&r.queryKeys[0]==='format'),'ordinary-nbp-exact-route-required');
 // 227: day and range reads only when both exact routes are declared too.
 const history=nbp227ReadPolicy('EUR').routes.every(want=>policy.routes.some(r=>r.origin===want.origin&&r.path===want.path&&r.methods?.length===1&&r.methods[0]==='GET'&&r.queryKeys?.length===1&&r.queryKeys[0]==='format'));
 return Object.freeze({currencies:Object.freeze(['EUR']),maxAgeDays:snapshot.maxAgeDays,read:(currency:string,signal?:AbortSignal)=>{assert(currency==='EUR','ordinary-nbp-selected-currency');return readLatestNbpTableARate({currency,mode:'public_read_only',maxAgeDays:snapshot.maxAgeDays,transport,signal});},
  ...(history?{readTableA:(currency:string,start:string,end:string|undefined,signal?:AbortSignal)=>{assert(currency==='EUR','ordinary-nbp-selected-currency');return readNbp227TableA({currency,start,end,transport,signal});}}:{})});
}

import {createAmazonMcfReadTransport,type AmazonMcfReadConfiguration,type AmazonMcfReadTransport} from './provider-read-transport';
export type {AmazonMcfReadConfiguration} from './provider-read-transport';
/** Separate trusted MCF-read opt-in; ordinary GET/HEAD policy never gains POST. */
export function prepareOrdinaryAmazonMcfReads(configuration:AmazonMcfReadConfiguration|undefined,context:{readOnly:boolean;localWooFixture:boolean}):AmazonMcfReadTransport|undefined{
 if(configuration===undefined)return undefined;
 assert(!context.readOnly,'ordinary-readonly-no-amazon-mcf-reads');
 assert(!context.localWooFixture,'ordinary-amazon-mcf-reads-no-local-woo-fixture');
 return createAmazonMcfReadTransport(structuredClone(configuration));
}

import {createOrdinaryConnectorTransport,type OrdinaryConnectorTransport,type OrdinaryConnectorAccessConfiguration} from './provider-read-transport';
import {assertDisjointConnectorOrigins} from './ordinary-connector-routing';
import {LOCAL_WOO_ORIGINS} from './local-woo-http-transport';
export type {OrdinaryConnectorAccessConfiguration} from './provider-read-transport';
/** Trusted constructor option connectorAccess. Default disabled; never an arbitrary public request policy. */
export function prepareOrdinaryConnectorAccess(configuration:OrdinaryConnectorAccessConfiguration|undefined,context:{readOnly:boolean;localWooFixture:boolean}):OrdinaryConnectorTransport|undefined{
 if(configuration===undefined)return undefined;
 assert(!context.readOnly,'ordinary-readonly-no-connector-access');
 const transport=createOrdinaryConnectorTransport(structuredClone(configuration));
 if(context.localWooFixture)assertDisjointConnectorOrigins(transport,LOCAL_WOO_ORIGINS);
 return transport;
}
