import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';
import { paymentBalance } from './payments';
import {
  packingMeasurementsInput,
  projectPackingToDpd,
  projectPackingToInPostCourier,
} from './packing-measurements';
import {
  assertPackingActorInTx,
  packingReceiptCurrentInTx,
  packingWorkstationAvailable,
} from './packing-workstation-guards';
import type { PackingActor } from './packing-workstation-schema';

export const packingShippingBindingInput = z.strictObject({
  receipt_id: z.uuid().transform((value) => value.toLowerCase()),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  profile_revision: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(19),
});

const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

// The key identity is taken from authenticated server context, never from a request body.
export function packingShippingActor(req: any): PackingActor {
  const apiKeyId = req.currentUser?.api_key_id;
  ensure(
    !req.apiScopes || typeof apiKeyId === 'string',
    401,
    'Brak uwierzytelnionej tożsamości klucza API',
  );
  return { ...req.actor, ...(req.apiScopes ? { apiKeyId, source: 'api' as const } : {}) };
}

export async function packingShippingSnapshotInTx(
  c: PoolClient,
  actor: PackingActor,
  order: any,
  input: any,
  provider: 'inpost' | 'dpd' | 'dhl' | 'pocztapolska',
) {
  if (!input.packing) return null;
  ensure(
    await packingWorkstationAvailable(c),
    503,
    'Kopia nie zawiera zatwierdzonych pomiarów paczek',
  );
  const binding = packingShippingBindingInput.parse(input.packing);
  const proof = await packingReceiptCurrentInTx(c, order, binding.receipt_id);
  ensure(
    proof.current && proof.receipt && proof.profile,
    409,
    'Pomiar paczki jest nieaktualny. Przygotuj nowy podgląd przesyłki',
  );
  const receipt = proof.receipt;
  ensure(
    binding.profile_revision === String(proof.profile.revision) &&
      binding.scope_hash === hash(receipt.full_snapshot),
    409,
    'Dowód pomiaru paczki lub jego wersja nie odpowiada bieżącemu profilowi',
  );
  const balanceHash = hash(await paymentBalance(c, order.id));
  ensure(
    receipt.full_snapshot.payment_hash === balanceHash,
    409,
    'Płatność zmieniła się od pomiaru paczki',
  );
  const measurements = packingMeasurementsInput.parse(receipt.full_snapshot.measurements);
  if (provider === 'inpost')
    ensure(
      input.service === 'inpost_courier_standard',
      422,
      'Pomiar paczki wymaga kuriera InPost. Dopasowanie szablonu paczkomatu nie zostało potwierdzone',
    );
  const projected =
    provider === 'inpost'
      ? projectPackingToInPostCourier(measurements)
      : projectPackingToDpd(measurements);
  ensure(
    input.weight === projected.weight && isDeepStrictEqual(input.dimensions, projected.dimensions),
    422,
    'Waga i wymiary przesyłki muszą dokładnie odpowiadać zatwierdzonemu pomiarowi',
  );
  return {
    receipt_id: receipt.id,
    scope_hash: binding.scope_hash,
    profile_revision: binding.profile_revision,
    measurements,
    after_fulfillment_hash: receipt.after_fulfillment_hash,
    order_version: String(receipt.after_order_version),
    payment_hash: balanceHash,
  };
}

export async function assertPackingShippingPlanInTx(
  c: PoolClient,
  actor: PackingActor,
  order: any,
  plan: any,
) {
  if (!plan.input.packing && !plan.input.packing_snapshot) return;
  ensure(
    plan.input.packing && plan.input.packing_snapshot,
    409,
    'Plan nie zawiera kompletnego powiązania pomiaru paczki',
  );
  const snapshot = await packingShippingSnapshotInTx(
    c,
    actor,
    order,
    plan.input,
    (plan.input.provider ?? 'inpost') as 'inpost' | 'dpd' | 'dhl' | 'pocztapolska',
  );
  ensure(
    isDeepStrictEqual(snapshot, plan.input.packing_snapshot),
    409,
    'Pomiar paczki zmienił się od podglądu przesyłki',
  );
  ensure(snapshot, 409, 'Brak zatwierdzonego pomiaru paczki');
  if (plan.input.provider === 'dpd') {
    const packages = plan.payload?.packages;
    const parcels = packages?.[0]?.parcels;
    const projected = projectPackingToDpd(snapshot.measurements);
    ensure(
      Array.isArray(packages) &&
        packages.length === 1 &&
        Array.isArray(parcels) &&
        parcels.length === 1,
      409,
      'Plan DPD musi zawierać jedną zatwierdzoną paczkę',
    );
    ensure(
      parcels[0].weight === projected.weight &&
        parcels[0].sizeX === projected.dimensions.length &&
        parcels[0].sizeY === projected.dimensions.width &&
        parcels[0].sizeZ === projected.dimensions.height,
      409,
      'Dane paczki wysyłane do DPD różnią się od dowodu pomiaru',
    );
  } else if (['dhl', 'pocztapolska'].includes(plan.input.provider)) {
    // DHL and Poczta Polska send the plan input's kilograms and centimetres (the DPD projection).
    const projected = projectPackingToDpd(snapshot.measurements);
    ensure(
      plan.input.weight === projected.weight &&
        isDeepStrictEqual(plan.input.dimensions, projected.dimensions),
      409,
      'Dane paczki wysyłane do przewoźnika różnią się od dowodu pomiaru',
    );
  } else {
    const parcels = plan.payload?.parcels;
    const projected = projectPackingToInPostCourier(snapshot.measurements);
    ensure(
      Array.isArray(parcels) && parcels.length === 1,
      409,
      'Plan InPost musi zawierać jedną zatwierdzoną paczkę',
    );
    ensure(
      isDeepStrictEqual(parcels[0].weight, { amount: projected.weight, unit: 'kg' }) &&
        isDeepStrictEqual(parcels[0].dimensions, { ...projected.dimensions, unit: 'mm' }) &&
        !parcels[0].template,
      409,
      'Dane paczki wysyłane do InPost różnią się od dowodu pomiaru',
    );
  }
}

export async function pinPackingShippingActorInTx(
  c: PoolClient,
  actor: PackingActor,
  bound: boolean,
) {
  if (!bound) return;
  // Resolve every FK/deferred guard before pinning the current membership and key grants.
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  await assertPackingActorInTx(c, actor, true);
}

export function packingShippingJobActor(job: any, role: PackingActor['role']): PackingActor {
  return {
    tenantId: job.tenant_id,
    userId: job.payload.actor_id,
    role,
    ...(job.payload.packing_api_key_id
      ? { apiKeyId: job.payload.packing_api_key_id, source: 'api' as const }
      : {}),
  };
}
