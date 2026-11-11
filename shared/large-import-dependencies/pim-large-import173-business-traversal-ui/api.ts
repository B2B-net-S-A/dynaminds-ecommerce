import * as implementation from './profile-compiler.mjs';
import * as startup from './profile-startup.mjs';
export type Ref={path:string;sha256:string};
export type SourceSelection={source_graph:{id:string;ref:Ref}[];source_manifests:Ref[];quota_peer:Ref;terminal_peer:Ref;publisher_peer:Ref;business_package:Ref;business_peer:Ref;performance_package:Ref;performance_peer:Ref};
export type CompositeCompileInput={authorization:'ROOT_AUTHORIZED_PURE_173_COMPOSITE_COMPILATION_NO_PG';selection:SourceSelection;selection_ref:Ref;expectation:Ref;authority_peer:Ref;authority_manifest:Ref;native_proof:Ref;native_peer:Ref};
declare const reviewedRetirement:unique symbol;
export type ReviewedEvidenceRetirement={readonly schema:'large-import173-reviewed-evidence-retirement/v1';readonly [reviewedRetirement]:true};
export type RetirementTransition={adoption:Ref;build:Ref;peer:Ref;source_manifest:Ref;source_peer:Ref};
export type StartupRetirementTransition=RetirementTransition&{build_observation:Ref};
export type EvidenceRetirementInput={authorization:'ROOT_AUTHORIZED_REVIEWED_REGISTRY_STARTUP_EVIDENCE_RETIREMENT_NO_NATIVE_ACTION';registry_transition:RetirementTransition;startup_transition:StartupRetirementTransition;correction_transition:StartupRetirementTransition};
export type ReviewedEvidenceOptions={clockPolicy?:'submicrosecond-ctime-required'|'rehash-always';retirement?:ReviewedEvidenceRetirement};
export type OwnerReader={query(sql:string):Promise<{rows:Record<string,unknown>[]}>};
declare const reviewedStartup:unique symbol;
export type ReviewedStartup={readonly schema:'large-import173-reviewed-startup/v1';readonly [reviewedStartup]:true};
export const prepareCompositeCapture=implementation.prepareCompositeCapture as (input:SourceSelection)=>unknown;
export const compileReviewedComposite=implementation.compileReviewedComposite as (input:CompositeCompileInput,options?:{retirement?:ReviewedEvidenceRetirement})=>Promise<unknown>;
export const createReviewedStartup=startup.createReviewedStartup as (input:CompositeCompileInput,reviewedEvidenceOptions?:ReviewedEvidenceOptions)=>Promise<ReviewedStartup>;
export const inspectCompositeStartup=startup.inspectCompositeStartup as (owner:OwnerReader,handle:ReviewedStartup)=>Promise<unknown>;

export const recheckReviewedStartupEvidence=startup.recheckReviewedStartupEvidence as(handle:ReviewedStartup)=>Promise<{hashed_files:number;hashed_bytes:number;cache_hits:number;stat_calls:number;cached_entries:number}>;

export const createReviewedEvidenceRetirement=implementation.createReviewedEvidenceRetirement as(input:EvidenceRetirementInput)=>Promise<ReviewedEvidenceRetirement>;

export const admitReviewedRegistryRetirementPrerequisite=implementation.admitReviewedRegistryRetirementPrerequisite as(input:RetirementTransition)=>Promise<{status:'REVIEWED_REGISTRY_SOURCE_RETIREMENT_PREREQUISITE_ONLY_NOT_STARTUP_AUTHORITY';current_sources:Ref;current_source_count:1584;retired_source_count:1;historical_dist_count:6;forced_ref_count:number;native_actions:0;application_activation:false}>;
