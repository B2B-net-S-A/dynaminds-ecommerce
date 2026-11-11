/** Ordinary runtime entry: no historical compiler/source/receipt module evaluation.
 * Startup authority lives only in profile-startup.mjs; types below are erased aliases. */
import * as startup from './profile-startup.mjs';
import type {ReviewedStartup,OwnerReader} from './api';
import type {StartupInspection} from './profile-startup.mjs';
export type {ReviewedStartup,OwnerReader} from './api';
export type PortableStartupInput={releaseDirectory:string;manifestSha:string;expectedOwner:string};
export type HistoricalEvidenceMetrics={hashed_files:number;hashed_bytes:number;cache_hits:number;stat_calls:number;cached_entries:number};
export type PortableEvidenceClosure={status:'PORTABLE_STARTUP_FORCED_FULL_SOURCE_RELEASE_RECHECK_COMPLETE';file_count:number;bytes:number;complete:true;force_full_hash:true;release_manifest_sha256:string;scope:'PORTABLE_RELEASE_FULL_BYTES_NO_CACHE'|'EMITTED_RELEASE_FULL_BYTES_NO_CACHE';installation:'NOT_RUN';application_activation:false};
export type StartupEvidenceClosure=HistoricalEvidenceMetrics|PortableEvidenceClosure;
export const createPortableReviewedStartup=startup.createPortableReviewedStartup as(input:PortableStartupInput)=>Promise<ReviewedStartup>;
export const activateRuntimeGeneration=startup.activateRuntimeGeneration as(owner:OwnerReader,handle:ReviewedStartup)=>Promise<StartupInspection|{status:'LEGACY_CADENCE_NO_GENERATION_ACTIVATION';application_activation:false}>;
export const inspectCompositeStartup=startup.inspectCompositeStartup as(owner:OwnerReader,handle:ReviewedStartup)=>Promise<StartupInspection>;
export const recheckReviewedStartupEvidence=startup.recheckReviewedStartupEvidence as(handle:ReviewedStartup)=>Promise<StartupEvidenceClosure>;

/** Opaque package-check lifetime; foreign/JSON/closed handles are refused. */
declare const operationBrand: unique symbol;
export type ReviewedStartupOperation=Readonly<{schema:'large-import173-private-release-operation/v1';readonly [operationBrand]:true}>;
export const beginReviewedStartupOperation=startup.beginReviewedStartupOperation as(handle:ReviewedStartup)=>Promise<ReviewedStartupOperation>;
export const inspectCompositeStartupInOperation=startup.inspectCompositeStartupInOperation as(owner:OwnerReader,handle:ReviewedStartup,operation:ReviewedStartupOperation)=>Promise<StartupInspection>;
export const closeReviewedStartupOperation=startup.closeReviewedStartupOperation as(handle:ReviewedStartup,operation:ReviewedStartupOperation)=>Promise<PortableEvidenceClosure>;

export type OrdinarySchemaTransactionGate={prepareReadInstallation:(owner:OwnerReader,tenant:string,identity:object)=>Promise<object|undefined>;consumeReadInstallation:(owner:OwnerReader,tenant:string,identity:object,fact:object)=>Promise<void>;prepareInstallation:(owner:OwnerReader,tenant:string)=>Promise<object|undefined>;verifyInstallation:(owner:OwnerReader,tenant:string,fact:object)=>Promise<void>;enter:(owner:OwnerReader)=>Promise<void>;reserve:(owner:OwnerReader)=>Promise<{enter:()=>Promise<void>;close:()=>Promise<void>}>};
export const createOrdinarySchemaTransactionGate=startup.createOrdinarySchemaTransactionGate as(handle:ReviewedStartup)=>OrdinarySchemaTransactionGate;
export const assertOwnedOrdinarySchemaTransactionGate=startup.assertOwnedOrdinarySchemaTransactionGate as(gate:OrdinarySchemaTransactionGate)=>void;
