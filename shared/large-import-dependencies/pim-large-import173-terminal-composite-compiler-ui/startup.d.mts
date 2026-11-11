import type { CompositeCompileInput, OwnerReader, ReviewedStartup } from './api.js';
export type StartupInspection = {
 status:'INDEPENDENT_COMPLETE173_GRAPH_AND_CERT_MATCHED';certified_graph:true;
 profile_native_sha256:string;application_activation:false;pending:string;
};
/** Runtime authority is minted only after full reviewed compilation; declarations do not create handles. */
export declare function createReviewedStartup(input:CompositeCompileInput):Promise<ReviewedStartup>;
export declare function inspectCompositeStartup(owner:OwnerReader,handle:ReviewedStartup):Promise<StartupInspection>;
