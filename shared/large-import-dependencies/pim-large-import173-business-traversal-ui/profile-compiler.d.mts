import type { Ref, SourceSelection, CompositeCompileInput, ReviewedEvidenceRetirement, EvidenceRetirementInput, RetirementTransition } from './api.js';
export type SourceGraph = {id:string;ref:Ref}[];
export type CaptureSpecification = {
 schema:'large-import173-composite-upgrade-capture/v1'; selection:SourceSelection; source_graph:SourceGraph;
 source_contract_sha256:string; catalog_query:Ref;
 settings:{search_path:'pg_catalog,public';TimeZone:'UTC';standard_conforming_strings:'on';jit:'off'};
 prerequisites:{original_583_rows_sequences_literal:true;parent_guards:28;zones:string[];protected_baseline:string;exclusive_owner:true;reserved_families_absent:false;existing_installed_full595_preserved:true;predecessor_compiled:Ref;current_native_baseline:Ref;source_only_upgrade:Ref};
 remnant_sql:string;capture_sql:string;capture_sql_sha256:string;ddl_sql:string;ddl_sha256:string;catalog_sql:string;
 transaction:'ROOT_BEGIN_REPEATABLE_READ_EXISTING595_UPGRADE_AND_EXACT_QUERY_THEN_ALWAYS_ROLLBACK';certificate_rows_inserted:0;ledger_rows_appended:0;activation:'NOT_APPLY_READY';
};
export type CompiledComposite = {
 schema:'large-import173-reviewed-composite-bootstrap/v1';existing_candidate_upgrade:true;predecessor_compiled:Ref;current_native_baseline:Ref;upgrade_sql:Ref;sql:string;sql_sha256:string;catalog_sql:string;
 source_graph:SourceGraph;profile_sha256:string;profile_native_sha256:string;evidence:CompositeCompileInput;
 loaded_refs:(Ref & {privateFile:boolean})[];expected_owner:string;expected_profile:Record<string,unknown>;
 expected_certificate_rows:1;ledger:'NOT_APPENDED';activation:'NOT_APPLY_READY';native_install_restore_IAM_quota_hooks:'OPEN';
};
export declare const remnantQuery:string;
export declare function prepareCompositeCapture(selection:SourceSelection):CaptureSpecification;
/** Structural parity is additional to, and cannot replace, complete independent native-profile evidence. */
export declare function assertCompositeInventory(profile:Record<string,unknown>,owner:string):{
 status:'COMPOSITE_SOURCE_STRUCTURE_VERIFIED';descriptor_parity:'REQUIRES_INDEPENDENT_EXACT_PROFILE';counts:Record<string,number>;
};
export declare function compileReviewedComposite(input:CompositeCompileInput,options?:{retirement?:ReviewedEvidenceRetirement}):Promise<CompiledComposite>;

export declare function createReviewedEvidenceRetirement(input:EvidenceRetirementInput):Promise<ReviewedEvidenceRetirement>;
export declare function reviewedEvidenceReferences(originalRefs:(Ref&{privateFile:boolean})[],handle?:ReviewedEvidenceRetirement):(Ref&{privateFile:boolean})[];

export declare function admitReviewedRegistryRetirementPrerequisite(input:RetirementTransition):Promise<{status:'REVIEWED_REGISTRY_SOURCE_RETIREMENT_PREREQUISITE_ONLY_NOT_STARTUP_AUTHORITY';current_sources:Ref;current_source_count:1584;retired_source_count:1;historical_dist_count:6;forced_ref_count:number;native_actions:0;application_activation:false}>;
