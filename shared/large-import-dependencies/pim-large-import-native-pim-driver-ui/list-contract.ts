/** Browser-safe owned metadata summary; selection MUST use the existing full paged inspect/custody reader. */
export type DoneCoreJob={id:string;revision:number;state_sha256:string;plan_hash:string;created_at:string;catalog_id:string;records:number;batches:number;executions:{batch:number;id:string;preview_id:string;scope_hash:string;total:number}[]};
export type DoneCorePage={schema:'large-import-owned-done-core-list/v1';catalog_id:string;items:DoneCoreJob[];next:string|null};
