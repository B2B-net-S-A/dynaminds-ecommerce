import type pg from 'pg';
export function normalizeOrdinaryLegacyOwnerAcls(owner: pg.Client): Promise<{owner_default_acls_materialized:number}>;
