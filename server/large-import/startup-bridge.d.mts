import type {Client} from '../../shared/large-import-dependencies/pim-large-import173-composed-runtime-backend/storage';
export type Expectation={catalog_sql:string;expectation_origin:'INDEPENDENT_REVIEWED_SOURCE_DDL_EXPECTATION';owner:string;profile:Record<string,unknown>;profile_sha256:string;profile_native_sha256:string};
export function inspectCompositeStartup(owner:Client,input:Expectation):Promise<{status:'INDEPENDENT_COMPLETE173_GRAPH_AND_CERT_MATCHED';certified_graph:true;application_activation:false}>;
