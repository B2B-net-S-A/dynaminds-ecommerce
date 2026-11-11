import type {PortableStartupInput,StartupEvidenceClosure,ReviewedStartupOperation,PortableEvidenceClosure} from './runtime-api.js';
import type { CompositeCompileInput, OwnerReader, ReviewedStartup, ReviewedEvidenceOptions } from './api.js';
export type StartupInspection = {
 status:'INDEPENDENT_COMPLETE173_GRAPH_AND_CERT_MATCHED'|'RUNTIME_GENERATION_MATCHED_AFTER_OWNER_COLD_VALIDATION';certified_graph:true;
 profile_native_sha256:string;application_activation:false;pending:string;
};
/** Runtime authority is minted only after full reviewed compilation; declarations do not create handles. */
export declare function createReviewedStartup(input:CompositeCompileInput,reviewedEvidenceOptions?:ReviewedEvidenceOptions):Promise<ReviewedStartup>;
/** Trusted build-selected source-release only; not installer/public readiness. Same private handle brand. */
export declare function createPortableReviewedStartup(input:PortableStartupInput):Promise<ReviewedStartup>;
export declare function inspectCompositeStartup(owner:OwnerReader,handle:ReviewedStartup):Promise<StartupInspection>;

export declare function recheckReviewedStartupEvidence(handle:ReviewedStartup):Promise<StartupEvidenceClosure>;

export declare function beginReviewedStartupOperation(handle:ReviewedStartup):Promise<ReviewedStartupOperation>;
export declare function inspectCompositeStartupInOperation(owner:OwnerReader,handle:ReviewedStartup,operation:ReviewedStartupOperation):Promise<StartupInspection>;
export declare function closeReviewedStartupOperation(handle:ReviewedStartup,operation:ReviewedStartupOperation):Promise<PortableEvidenceClosure>;

/** Dedicated idle node-pg owner only; explicit write TX, never an injected active reader. */
export declare function activateRuntimeGeneration(owner:OwnerReader,handle:ReviewedStartup):Promise<StartupInspection|{status:'LEGACY_CADENCE_NO_GENERATION_ACTIVATION';application_activation:false}>;

export type OrdinarySchemaTransactionGate={enter:(owner:OwnerReader)=>Promise<void>;reserve:(owner:OwnerReader)=>Promise<{enter:()=>Promise<void>;close:()=>Promise<void>}>};
export declare function createOrdinarySchemaTransactionGate(handle:ReviewedStartup):OrdinarySchemaTransactionGate;
export declare function assertOwnedOrdinarySchemaTransactionGate(gate:OrdinarySchemaTransactionGate):void;
