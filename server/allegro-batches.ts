import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';
import { allegroCreationInput, allegroSettingsReadScope } from './allegro-creation';
import { offerWriteScope } from './channel-access';
import { connectionHash } from './offer-sync-policy';
import { offerSnapshotHash } from './offers';

const batchBase = z.object({
  name: z.string().trim().min(1).max(100),
  warehouse_id: z.uuid(),
  client_key: z.uuid(),
});
export const allegroBatchInput = z
  .union([
    batchBase
      .extend({
        operation: z.literal('create_draft').default('create_draft'),
        price_list_id: z.uuid().optional(),
        items: z
          .array(z.object({ product_id: z.uuid(), allegro: allegroCreationInput }).strict())
          .min(1)
          .max(200),
      })
      .strict(),
    batchBase
      .extend({
        operation: z.literal('publish'),
        items: z
          .array(z.object({ product_id: z.uuid(), listing_id: z.uuid() }).strict())
          .min(1)
          .max(200),
      })
      .strict(),
  ])
  .refine(
    (b) => new Set(b.items.map((i) => i.product_id)).size === b.items.length,
    'SKU nie mogą się powtarzać w partii',
  );
export const allegroBatchActionInput = z.object({ version: z.number().int().positive() }).strict();
export const allegroBatchApproveInput = allegroBatchActionInput.extend({
  confirm_external: z.boolean().default(false),
});
export async function startAllegroBatch(
  c: PoolClient,
  actor: Actor,
  channel: string,
  b: z.infer<typeof allegroBatchInput>,
) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + actor.tenantId,
  ]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `allegro-batch:${channel}:${b.client_key}`,
  ]);
  const existing = (
    await c.query('SELECT * FROM variant_offer_batches WHERE channel_id=$1 AND client_key=$2', [
      channel,
      b.client_key,
    ])
  ).rows[0];
  // Keep stage043 creation keys replayable after adding the operation discriminator.
  const inputHash = offerSnapshotHash(
    b.operation === 'create_draft'
      ? Object.fromEntries(Object.entries(b).filter(([key]) => key !== 'operation'))
      : b,
  );
  if (existing) {
    ensure(
      existing.kind === 'allegro_catalog' &&
        existing.actor_id === actor.userId &&
        existing.input_hash === inputHash,
      409,
      'Klucz partii użyty dla innych danych',
    );
    return existing;
  }
  const ch = (
    await c.query("SELECT * FROM channels WHERE id=$1 AND provider='allegro' FOR SHARE", [channel])
  ).rows[0];
  ensure(ch, 404, 'Nie znaleziono kanału Allegro');
  ensure(
    ch.settings.simulation ||
      (b.operation === 'publish'
        ? [offerWriteScope]
        : [offerWriteScope, allegroSettingsReadScope]
      ).every((scope) => ch.oauth_scopes.split(' ').includes(scope)),
    422,
    b.operation === 'publish'
      ? 'Połącz Allegro z prawem zapisu ofert'
      : 'Połącz Allegro z zapisem ofert i odczytem ustawień sprzedawcy',
  );
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1', [b.warehouse_id])).rowCount,
    404,
    'Nie znaleziono magazynu',
  );
  if (b.operation === 'create_draft' && b.price_list_id)
    ensure(
      (
        await c.query("SELECT id FROM price_lists WHERE id=$1 AND active AND currency='PLN'", [
          b.price_list_id,
        ])
      ).rowCount,
      422,
      'Partia wymaga aktywnego cennika PLN',
    );
  const products = (
    await c.query(
      "SELECT id FROM products WHERE id=ANY($1::uuid[]) AND kind IN ('simple','variant')",
      [b.items.map((i) => i.product_id)],
    )
  ).rows;
  ensure(
    products.length === b.items.length,
    422,
    'Wybierz produkty lub warianty własnej organizacji',
  );
  await assertProductsNotDeletedInTx(c, products.map((p) => p.id));
  if (b.operation === 'publish') {
    const mapped = (
      await c.query(
        'SELECT id,product_id FROM listings WHERE channel_id=$1 AND id=ANY($2::uuid[])',
        [channel, b.items.map((i) => i.listing_id)],
      )
    ).rows;
    ensure(
      b.items.every((i) =>
        mapped.some((l) => l.id === i.listing_id && l.product_id === i.product_id),
      ),
      422,
      'Wybierz istniejące powiązania SKU w tym kanale Allegro',
    );
  }
  const id = randomUUID(),
    job = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'offer.variants',$3,$4)",
    [
      job,
      actor.tenantId,
      JSON.stringify({ batch_id: id, actor_id: actor.userId, channel_id: channel }),
      'allegro:preview:' + id,
    ],
  );
  const { items, ...settings } = b;
  const row = (
    await c.query(
      "INSERT INTO variant_offer_batches(id,tenant_id,channel_id,group_id,actor_id,client_key,input_hash,connection_hash,input,job_id,kind) VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,'allegro_catalog') RETURNING *",
      [
        id,
        actor.tenantId,
        channel,
        actor.userId,
        b.client_key,
        inputHash,
        connectionHash(ch),
        JSON.stringify(settings),
        job,
      ],
    )
  ).rows[0];
  // One bounded insert, independent of the number of API reads performed later by the worker.
  await c.query(
    'INSERT INTO variant_offer_batch_items(id,tenant_id,batch_id,product_id,creation_input) SELECT gen_random_uuid(),$1,$2,x.product_id,x.allegro FROM jsonb_to_recordset($3::jsonb) x(product_id uuid,allegro jsonb)',
    [
      actor.tenantId,
      id,
      JSON.stringify(
        items.map((i) => ({
          product_id: i.product_id,
          allegro: 'allegro' in i ? i.allegro : { listing_id: i.listing_id },
        })),
      ),
    ],
  );
  await audit(c, actor, 'offer.allegro.batch.preview', id, {
    count: items.length,
    operation: b.operation,
  });
  return row;
}
