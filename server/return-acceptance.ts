import type { PoolClient } from 'pg';
import { ensure } from './errors';

/** A partner credit has an immutable acceptance proof, but no local warehouse receipt. */
export async function partnerReturnAcceptanceAvailable(c: PoolClient): Promise<boolean> {
  const capability = (
    await c.query(`SELECT
    to_regprocedure('public.b2b_dropship_return_installed()') IS NOT NULL marker,
    to_regclass('public.b2b_dropship_return_cases') IS NOT NULL heads,
    to_regclass('public.b2b_dropship_return_actions') IS NOT NULL actions,
    to_regclass('public.b2b_dropship_return_proofs') IS NOT NULL proofs,
    to_regprocedure('public.b2b_dropship_return_acceptance(uuid)') IS NOT NULL acceptance,
    to_regprocedure('public.b2b_dropship_return_finish(uuid)') IS NOT NULL finish,
    to_regprocedure('public.b2b_dropship_return_apply_partner(uuid)') IS NOT NULL apply`)
  ).rows[0];
  if (!Object.values(capability).some(Boolean)) return false;
  ensure(
    Object.values(capability).every(Boolean),
    503,
    'Niekompletny moduł uznania zwrotów partnera',
  );
  const installed = (await c.query('SELECT public.b2b_dropship_return_installed() installed'))
    .rows[0].installed;
  ensure(installed === true, 503, 'Brak potwierdzenia migracji zwrotów partnera');
  return true;
}

export function returnAcceptedExpression(available: boolean, alias = 'r'): string {
  ensure(/^[a-z][a-z0-9_]*$/i.test(alias), 500, 'Niepoprawny alias sprawy zwrotu');
  return available
    ? `coalesce(${alias}.received_at,(public.b2b_dropship_return_acceptance(${alias}.id)->>'accepted_at')::timestamptz)`
    : `${alias}.received_at`;
}

export async function returnAcceptedSql(c: PoolClient, alias = 'r'): Promise<string> {
  return returnAcceptedExpression(await partnerReturnAcceptanceAvailable(c), alias);
}

export async function getReturnAcceptanceInTx(
  c: PoolClient,
  r: { id: string; received_at?: Date | string | null },
) {
  if (r.received_at)
    return {
      accepted_at: r.received_at,
      acceptance_kind: 'physical' as const,
      physical_received_at: r.received_at,
      partner_acceptance: null,
    };
  const proof = (await partnerReturnAcceptanceAvailable(c))
    ? (await c.query('SELECT public.b2b_dropship_return_acceptance($1::uuid) proof', [r.id]))
        .rows[0].proof
    : null;
  if (proof)
    ensure(
      proof.kind === 'partner' &&
        typeof proof.accepted_at === 'string' &&
        Number.isFinite(Date.parse(proof.accepted_at)) &&
        Array.isArray(proof.case_ids) &&
        proof.case_ids.length > 0,
      503,
      'Niekompletny dowód uznania zwrotu przez partnera',
    );
  return {
    accepted_at: proof?.accepted_at ?? null,
    acceptance_kind: proof ? ('partner' as const) : null,
    physical_received_at: null,
    partner_acceptance: proof,
  };
}
