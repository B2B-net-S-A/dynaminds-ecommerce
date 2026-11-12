import { automationOnlyEvent } from './automation-v2-triggers';
import { catalogAttributesSchema } from '../shared/catalog-attributes';
import { productTags } from './product-tags-schema';
import { effectiveDeliveryInTx,effectiveDeliveryForOrderReadInTx,effectiveDeliveryForCreatedOrderInTx,prepareCreatedOrderBuyerInstallationInTx,type CreatedOrderBuyerInstallation } from './buyer-address';
import { localConfig } from './db';
import { orderDetailRows } from './order-detail-rows';
import {
  b2bExternalIntentAssertInTx,
  b2bExternalIntentStateInTx,
} from './b2b-external-order-intent-guards';
import {
  b2bDropshipBillToInTx,
  b2bDropshipOrderScopeInTx,
  assertB2bDropshipCancelableInTx,
  assertB2bDropshipDispatchInTx,
} from './b2b-dropship-guards';
import { productLogisticsFields } from './product-logistics-schema';
import { productCatalogsAvailable, resolveProductCatalogInTx, assertProductCatalogWarehouseInTx } from './product-catalogs';
import { assertSaleFinancialOrderInTx } from './order-fulfillment-kind';
import { assertOrderMergeActiveInTx, orderMergeClaimInTx } from './order-merge-guards';
import { productSkuSchema } from './product-sku-schema';
import { manualOrderLines,manualOrderLinesIssue,prepareManualOrderLines } from './manual-order-lines-values';
import { assertNoOrderParcelPlanInTx } from './order-parcel-guards';
import { newLabelTargetInTx, replacedLabelsInTx, writeLabelShipmentInTx } from './shipment-cancelled';
import { productSkuAvailable } from './product-sku';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';
import { enlistDispatchActorInTx } from './dispatch-transaction';
import { prepareAutomaticWzInTx, finishAutomaticWzInTx } from './warehouse-wz-issuer';
import {
  reserveWmsLotsInTx,
  releaseWmsLotsInTx,
  scanWmsLotInTx,
  wmsLotsPolicyInTx,
  wmsScanReplayInTx,
  wmsRecordScanInTx,
} from './wms-lots';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { randomUUID, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  applyMappedInitialOrderFieldsInTx,
  type PreparedMappedInitial,
} from './order-field-mappings-initial';
import { allocations, reserveLocations, scanLocation } from './stock-locations';
import { consumeWholeOrderStockInTx, type WholeOrderIssueWriter } from './warehouse-automatic-wz-physical';
import { ensure } from './errors';
import { acquirePackingFieldAdmissionInTx, assertPackingFieldsCompleteInTx } from './packing-order-field-requirements';
import {
  assertPackingScanInTx,
  assertPackingTransitionInTx,
  cancelPackingForOrderInTx,
  type PackingScanContext,
  type PackingTransitionContext,
} from './packing-workstation-guards';
import { event, type EventContext } from './events';
import { returnOverview, legacyReturn, prepareLegacyReturnCompletionInTx } from './returns';
import { completeReturnCompletionInTx, pinReturnCompletionInTx, type ReturnCompletion } from './return-completion';
import { claimLegacyReturnGroupTransitionInTx, type LegacyReturnGroup } from './legacy-return-group';
import { claimLegacyOnReturnCommandInTx, type LegacyOnReturnCommand } from './legacy-return-on-command';
import { prices } from './pricing';
import { paymentBalance, confirmOutstanding, fulfillmentPayment } from './payments';
import { orderWithStageInTx } from './order-stage-query';
import { initialOrderFieldsSchema } from './order-fields-schema';
import {
  acquireOrderFieldsAdmissionInTx,
  prepareInitialOrderFieldsInTx,
  applyInitialOrderFieldsInTx,
} from './order-fields';
import { insertAuditEvent } from './audit-log';
import { portalDefaultDaysInTx } from './portal-link-default253';
import { insertOrderWithNumberInTx } from './order-number';
import { orderSectionsInTx } from './order-sections';
import { autoDemoLabelAfterPackingInTx } from './order-settings';
import { orderInvoiceParty } from './order-invoice-party';
export { event } from './events';
export type Actor = {
  tenantId: string;
  userId: string;
  role: 'admin' | 'operator' | 'viewer';
  apiKeyId?: string;
  source?: 'manual' | 'api';
  /** A session viewer with the accountant grant (266, server/accountant.ts): may also change the payment
   * section and use payment imports. Never set for API keys. */
  accountant?: boolean;
  /** A session operator with the grant "Automatyzacje: edycja" (267, server/automation-editors.ts): may create and
   * change automation rules v2. Never set for API keys. */
  automationEditor?: boolean;
};
export type AuditActor = {
  tenantId: string;
  userId: string | null;
  role?: Actor['role'];
  apiKeyId?: string;
  source?: 'manual' | 'api' | 'system';
};
const positive = z.number().int().min(1).max(100000);
export const imageUrl = z
  .string()
  .max(2000)
  .refine((s) => {
    if (/^\/api\/product-images\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s)) return true;
    try {
      const u = new URL(s);
      return u.protocol === 'https:' && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'Zdjęcie wymaga HTTPS lub lokalnego pliku aplikacji');
export const catalogFields = z.object({
  tags: productTags.optional(),
  ...productLogisticsFields,
  name: z.string().trim().min(2).max(200),
  ean: z.string().trim().max(32).default(''),
  price: z.number().int().min(0).max(100000000),
  vat: z.union([z.literal(0), z.literal(5), z.literal(8), z.literal(23)]).default(23),
  category: z.string().max(80).default('Pozostałe'),
  description: z.string().max(10000).default(''),
  attributes: catalogAttributesSchema,
  images: z.array(imageUrl).max(10).default([]),
  active: z.boolean().default(true),
});
export const productSchema = z.object({
  ...catalogFields.shape,
  sku: productSkuSchema,
  catalog_id: z.uuid().optional(),
  warehouse_id: z.uuid(),
  quantity: z.number().int().min(0).max(10000000).default(0),
  location: z.string().max(80).default('A-01'),
  kind: z.enum(['simple', 'group', 'variant', 'bundle']).default('simple'),
  parent_id: z.uuid().optional(),
  components: z
    .array(z.object({ product_id: z.uuid(), quantity: positive }))
    .max(100)
    .default([]),
});
export const orderSchema = z
  .object({
    customer_name: z.string().trim().min(2).max(200),
    email: z.email().or(z.literal('')),
    warehouse_id: z.uuid(),
    source: z
      .enum([
        'manual',
        'demo',
        'allegro',
        'woocommerce',
        'prestashop',
        'shopify',
        'odoo',
        'ebay',
        'amazon',
        'mirakl',
        'b2b',
      ])
      .default('manual'),
    currency: z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']).default('PLN'),
    payment_mode: z.enum(['prepaid', 'cod']).default('prepaid'),
    price_list_id: z.uuid().optional(),
    address: z
      .object({
        street: z.string().max(200).default(''),
        city: z.string().max(100).default(''),
        postal_code: z.string().max(20).default(''),
        country: z.string().length(2).default('PL'),
        phone: z.string().max(30).default(''),
        locker_code: z.string().max(30).optional(),
      })
      .default({ street: '', city: '', postal_code: '', country: 'PL', phone: '' }),
    shipping_cost: z.number().int().min(0).max(1000000).default(0),
    items: z
      .array(z.object({ product_id: z.uuid(), quantity: positive }))
      .min(1)
      .max(100),
    note: z.string().max(2000).default(''),
    initial_fields: initialOrderFieldsSchema.optional(),
    manual_lines: manualOrderLines.optional(),
  })
  .superRefine((o,ctx)=>{const issue=manualOrderLinesIssue(o);if(issue)ctx.addIssue({code:'custom',message:issue,path:['manual_lines']});})
  .refine((o) => o.email !== '' || o.source === 'amazon', {
    message: 'Brak email kupującego',
    path: ['email'],
  });
export async function audit(
  c: PoolClient,
  a: AuditActor,
  action: string,
  id: string | null,
  detail: unknown = {},
) {
  // 238: an API key actor also leaves its key (audit238_event_keys) in the same statement.
  await insertAuditEvent(c, a, action, id, detail);
}
async function hydrateOrder(c:PoolClient,id:string,createInstallation?:CreatedOrderBuyerInstallation,orderRead=false) {
  const { orders, items, picking, bins: allocationRows, events, shipments, documents } =
    await orderDetailRows(c, id);
  const o = orders.rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  const bins = allocationRows.rows;
  const lotPolicy = await wmsLotsPolicyInTx(c);
  // Uwagi v3 §1/§7: the card also carries fulfilment_stage and payment_state (server/order-stage-query.ts).
  return orderWithStageInTx(c, {
    ...o,
    effective_delivery: createInstallation
      ? await effectiveDeliveryForCreatedOrderInTx(c,o.tenant_id,id,localConfig.encryptionKey,createInstallation)
      : orderRead
        ? await effectiveDeliveryForOrderReadInTx(c,o.tenant_id,id,localConfig.encryptionKey)
        : await effectiveDeliveryInTx(c, o.tenant_id, id, localConfig.encryptionKey),
    merge_claim: await orderMergeClaimInTx(c, id),
    dropshipping: await b2bDropshipOrderScopeInTx(c, id),
    ...(lotPolicy.enabled ? { wms_lots_enabled: true } : {}),
    workflow_status: o.workflow_status_id
      ? (
          await c.query('SELECT id,name,color,stage,active FROM workflow_statuses WHERE id=$1', [
            o.workflow_status_id,
          ])
        ).rows[0]
      : null,
    invoice_committed: Boolean(
      (
        await c.query(
          "SELECT id FROM invoice_plans WHERE order_id=$1 AND kind='invoice' AND mode='external' AND state NOT IN ('preview','cancelled') UNION ALL SELECT id FROM odoo_invoice_exports WHERE order_id=$1 AND mode='external' AND state NOT IN ('preview','cancelled') LIMIT 1",
          [id],
        )
      ).rowCount,
    ),
    shipping_active: Boolean(
      (
        await c.query(
          "SELECT id FROM shipping_plans WHERE order_id=$1 AND state NOT IN ('preview','cancelled','dispatched') LIMIT 1",
          [id],
        )
      ).rowCount,
    ),
    items: items.rows,
    picking_items: picking.rows.map((i) => ({
      ...i,
      locations: bins.filter((b) => b.product_id === i.product_id),
    })),
    events: events.rows,
    shipments: shipments.rows,
    // Labels cancelled with "Anuluj etykietę" and replaced by a new label (migration 268).
    replaced_labels: await replacedLabelsInTx(c, id),
    documents: documents.rows,
    returns: await returnOverview(c, id),
    payment: await paymentBalance(c, id),
    // Uwagi v3 §6 (lane E): per-section values and order-state locks; the role layer is applied by the routes.
    ...(await orderSectionsInTx(c, o, events.rows)),
  });
}
/** Public reads never carry a createOrder installation proof. */
export async function getOrder(c:PoolClient,id:string){return hydrateOrder(c,id,undefined,true);}
export async function createOrder(
  c: PoolClient,
  a: AuditActor,
  input: z.infer<typeof orderSchema>,
  sourceTotals?: Map<string, number>,
  options: {
    /** Private current-transaction exchange certificate; never accepted from HTTP. */
    replacementAdmissionId?: string;
    fieldSource?: 'manual' | 'api';
    fieldWritesAllowed?: boolean;
    mappedInitial?: PreparedMappedInitial;
    /** Internal import fragments: distinct commercial lines, aggregated physical custody. */
    /** Dedicated external-intent admission; never a public skip-stock option. */
    externalIntentLines?: Array<{
      customer_item_id: string;
      product_id: string;
      quantity: number;
      local_quantity: number;
    }>;
    /** Internal source admission, checked against the current transaction's import certificate. */
    externalImportIntentLines?: {
      admission_id: string;
      lines: Array<{
        customer_item_id: string;
        product_id: string;
        quantity: number;
        local_quantity: number;
      }>;
    };
    importFragments?: Array<{
      id: string;
      product_id: string;
      quantity: number;
      line_total: number;
    }>;
  } = {},
) {
  // Validate this public branch before any certificates, fields or custody writes.
  const manualCommercial=prepareManualOrderLines(input,{
    sourceTotals,importFragments:options.importFragments,replacementAdmissionId:options.replacementAdmissionId,
    externalIntentLines:options.externalIntentLines,externalImportIntentLines:options.externalImportIntentLines,mappedInitial:options.mappedInitial,
  });
  if(manualCommercial){
    sourceTotals=manualCommercial.totals;
    options={...options,importFragments:manualCommercial.lines.map(line=>({...line,id:randomUUID()}))};
  }
  a = enlistWmsActorInTx(c, a, { orders: true });
  const createInstallation=await prepareCreatedOrderBuyerInstallationInTx(c,a.tenantId);
  let replacement: any = null;
  if (options.replacementAdmissionId) {
    ensure(
      !sourceTotals &&
        !options.importFragments &&
        !options.externalIntentLines &&
        !options.externalImportIntentLines &&
        !options.mappedInitial &&
        !input.initial_fields?.length,
      422,
      'Wymiana nie łączy się z importem, cennikiem ani intencją zewnętrzną',
    );
    replacement = (
      await c.query('SELECT return_exchange_order_admission($1) p', [
        options.replacementAdmissionId,
      ])
    ).rows[0].p;
    ensure(
      replacement &&
        replacement.actor_id === a.userId &&
        replacement.api_key_id === (a.apiKeyId ?? null),
      409,
      'Brak bieżącego dowodu zamówienia zastępczego',
    );
    ensure(
      (
        await c.query('SELECT $1::jsonb=$2::jsonb ok', [
          JSON.stringify(input),
          JSON.stringify(orderSchema.parse(replacement.order_input)),
        ])
      ).rows[0].ok,
      409,
      'Zamówienie zastępcze różni się od zatwierdzonej reklamacji',
    );
    // Only a typed current-transaction admission can select a replacement SKU.
    // Normalize its target for the genuine core order; original receipt fields
    // remain in the durable admission and are never rewritten by this adapter.
    if (replacement.proof_version === 2)
      replacement = {
        ...replacement,
        lines: replacement.lines.map((l: any) => ({
          ...l,
          product_id: l.replacement.product_id,
          name: l.replacement.name,
          sku: l.replacement.sku,
          vat: l.replacement.vat,
          components: l.replacement.components,
        })),
      };
    sourceTotals = new Map<string, number>(replacement.lines.map((l: any) => [l.product_id, 0]));
    options = {
      ...options,
      importFragments: replacement.lines.map((l: any) => ({
        id: l.replacement_item_id,
        product_id: l.product_id,
        quantity: l.accepted,
        line_total: 0,
      })),
    };
  }
  const fieldsAvailable = Boolean(
    (await c.query("SELECT to_regclass('public.order_field_definitions') present")).rows[0].present,
  );
  ensure(
    fieldsAvailable || !input.initial_fields?.length,
    503,
    'Kopia nie zawiera pól dodatkowych',
  );
  const manualFields = ['manual', 'demo'].includes(input.source);
  ensure(
    !options.mappedInitial || (!manualFields && !input.initial_fields?.length),
    422,
    'Mapowane initial nie można łączyć z ręcznymi polami',
  );
  let preparedFields: Awaited<ReturnType<typeof prepareInitialOrderFieldsInTx>> | undefined;
  if (fieldsAvailable && (manualFields || input.initial_fields?.length)) {
    await acquireOrderFieldsAdmissionInTx(c, a);
    preparedFields = await prepareInitialOrderFieldsInTx(c, a, input.initial_fields ?? [], {
      manual: manualFields,
      source: options.fieldSource,
      fieldWritesAllowed: options.fieldWritesAllowed,
    });
  }
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    `catalog:${a.tenantId}`,
  ]);
  await lockWarehouseInventoryPoliciesInTx(c, [input.warehouse_id], { sellable: true });
  const w = (await c.query('SELECT id FROM warehouses WHERE id=$1', [input.warehouse_id])).rows[0];
  ensure(w, 404, 'Nie znaleziono magazynu');
  const tenant = (await c.query('SELECT currency FROM tenants WHERE id=$1', [a.tenantId])).rows[0];
  const merged = new Map<string, number>();
  for (const i of input.items)
    merged.set(manualCommercial?i.product_id.toLowerCase():i.product_id, (merged.get(manualCommercial?i.product_id.toLowerCase():i.product_id) ?? 0) + i.quantity);
  ensure(
    !(options.externalIntentLines && options.externalImportIntentLines),
    422,
    'Wybierz jedną ścieżkę intencji realizacji',
  );
  const sourceIntent = options.externalImportIntentLines;
  const rawIntentLines = sourceIntent?.lines ?? options.externalIntentLines;
  const intentLines =
    rawIntentLines &&
    z
      .array(
        z.strictObject({
          customer_item_id: z.uuid(),
          product_id: z.uuid(),
          quantity: positive,
          local_quantity: z.number().int().min(0).max(100000),
        }),
      )
      .min(1)
      .max(100)
      .parse(rawIntentLines);
  if (intentLines) {
    ensure(
      sourceIntent
        ? Boolean(
            sourceTotals && options.importFragments && !manualFields && !options.mappedInitial,
          )
        : !sourceTotals && !options.importFragments && manualFields,
      422,
      'Intencja wymaga zwykłych cen własnego zamówienia',
    );
    ensure(
      new Set(intentLines.map((i) => i.customer_item_id)).size === intentLines.length &&
        intentLines.every((i) => i.local_quantity <= i.quantity),
      422,
      'Nieprawidłowy przydział intencji',
    );
    const iq = new Map<string, number>();
    for (const i of intentLines) iq.set(i.product_id, (iq.get(i.product_id) ?? 0) + i.quantity);
    ensure(
      iq.size === merged.size && [...merged].every(([id, q]) => iq.get(id) === q),
      422,
      'Intencja nie odpowiada pełnej ilości handlowej',
    );
    ensure(
      (
        await c.query(
          "SELECT to_regprocedure('public.b2b_external_intent_complete()') IS NOT NULL present",
        )
      ).rows[0].present,
      503,
      'Kopia nie obsługuje intencji realizacji',
    );
  }
  const fragments = options.importFragments;
  if (fragments) {
    ensure(
      sourceTotals && (manualCommercial || replacement || !['manual', 'demo'].includes(input.source)),
      422,
      'Fragmenty wymagają importu źródłowego',
    );
    const parsed = z
      .array(
        z
          .object({
            id: z.uuid(),
            product_id: z.uuid(),
            quantity: z.number().int().min(1).max(100000),
            line_total: z.number().int().min(0).max(2147483647),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .parse(fragments);
    ensure(
      new Set(parsed.map((f) => f.id)).size === parsed.length,
      422,
      'Powtórzone ID pozycji importu',
    );
    const quantities = new Map<string, number>(),
      totals = new Map<string, number>();
    for (const f of parsed) {
      quantities.set(f.product_id, (quantities.get(f.product_id) ?? 0) + f.quantity);
      totals.set(f.product_id, (totals.get(f.product_id) ?? 0) + f.line_total);
    }
    ensure(
      quantities.size === merged.size &&
        [...merged].every(
          ([id, q]) => quantities.get(id) === q && totals.get(id) === sourceTotals!.get(id),
        ),
      422,
      'Fragmenty nie odpowiadają ilościom i kwotom importu',
    );
  }
  if (sourceIntent) {
    ensure(
      Boolean(intentLines && fragments && sourceTotals && !manualFields && !options.mappedInitial),
      422,
      'Import wymaga pełnych fragmentów i przydziałów źródłowych',
    );
    const admissionId = z.uuid().parse(sourceIntent.admission_id);
    // Product totals cannot distinguish two commercial lines with different prices.
    // Require the exact source UUID and quantity for every allocation before custody changes.
    ensure(
      fragments!.length === intentLines!.length &&
        fragments!.every((f) =>
          intentLines!.some(
            (i) =>
              i.customer_item_id === f.id &&
              i.product_id === f.product_id &&
              i.quantity === f.quantity,
          ),
        ),
      422,
      'Intencja nie odpowiada każdej źródłowej pozycji handlowej',
    );
    ensure(
      (
        await c.query(
          "SELECT to_regprocedure('public.b2b_external_import_admitted(uuid)') IS NOT NULL present",
        )
      ).rows[0].present,
      503,
      'Kopia nie obsługuje importu z intencją realizacji',
    );
    ensure(
      (await c.query('SELECT b2b_external_import_admitted($1) admitted', [admissionId])).rows[0]
        .admitted,
      409,
      'Brak bieżącej zgody na import z intencją realizacji',
    );
  }
  const items: Record<string, any>[] = [],
    physical = new Map<string, number>();
  // Recipes are locked against edits until their immutable order snapshot is persisted.
  const roots = (
    await c.query('SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [
      [...merged.keys()],
    ])
  ).rows;
  if (await productCatalogsAvailable(c)) {
    for (const catalogId of new Set<string>(roots.map(p => p.catalog_id))) {
      await resolveProductCatalogInTx(c, catalogId);
      await assertProductCatalogWarehouseInTx(c, catalogId, input.warehouse_id);
    }
  }
  ensure(
    !sourceTotals || !input.price_list_id,
    422,
    'Import zachowuje ceny źródłowe i nie używa cennika lokalnego',
  );
  const pricing = sourceTotals
    ? null
    : await prices(c, [...merged.keys()], input.price_list_id, a.tenantId);
  ensure(
    (pricing?.currency ?? replacement?.order_input.currency ?? tenant.currency) === input.currency,
    422,
    'Waluta zamówienia nie zgadza się z wybranym cennikiem lub organizacją',
  );
  const quoted = new Map(pricing?.items.map((i) => [i.product_id, i.price]) ?? []);
  let total = input.shipping_cost;
  for (const [productId, quantity] of [...merged.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const p = roots.find((p) => p.id === productId);
    ensure(p, 404, 'Nie znaleziono produktu');
    ensure(p.active && p.kind !== 'group', 422, 'Produkt jest nieaktywny lub jest grupą wariantów');
    ensure(quantity <= 100000, 422, 'Za duża ilość produktu');
    const components =
      p.kind === 'bundle'
        ? (
            await c.query(
              'SELECT product_id,quantity FROM bundle_components WHERE bundle_id=$1 ORDER BY product_id',
              [productId],
            )
          ).rows
        : [{ product_id: productId, quantity: 1 }];
    ensure(components.length > 0, 422, 'Zestaw nie ma składników');
    if (replacement) {
      const frozen = replacement.lines.filter((l: any) => l.product_id === productId);
      const recipeTuples = (recipe: Array<{ product_id: string; quantity: number }>) =>
        recipe
          .map(({ product_id, quantity }): [string, number] => [product_id, quantity])
          .sort(([a], [b]) => a.localeCompare(b));
      ensure(
        frozen.every(
          (l: any) =>
            JSON.stringify(recipeTuples(l.components)) === JSON.stringify(recipeTuples(components)),
        ),
        409,
        'Receptura produktu zmieniła się od pierwotnej sprzedaży',
      );
    }
    const localQuantity = intentLines
      ? intentLines
          .filter((i) => i.product_id === productId)
          .reduce((n, i) => n + i.local_quantity, 0)
      : quantity;
    // Validate every frozen component even when none needs a local stock row.
    if (intentLines) {
      const cp = (
        await c.query(
          'SELECT id,active,kind FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
          [components.map((x: any) => x.product_id)],
        )
      ).rows;
      ensure(
        cp.length === components.length &&
          cp.every((p) => p.active && ['simple', 'variant'].includes(p.kind)),
        422,
        'Nieaktywny fizyczny składnik receptury',
      );
    }
    for (const component of components)
      if (localQuantity > 0)
        physical.set(
          component.product_id,
          (physical.get(component.product_id) ?? 0) + component.quantity * localQuantity,
        );
    const lineTotal = sourceTotals
      ? sourceTotals.get(productId)
      : quoted.get(productId)! * quantity;
    ensure(
      lineTotal !== undefined && Number.isSafeInteger(lineTotal) && lineTotal >= 0,
      422,
      'Nieprawidłowa kwota pozycji',
    );
    for (const fragment of fragments?.filter((f) => f.product_id === productId) ??
      intentLines
        ?.filter((i) => i.product_id === productId)
        .map((i) => ({
          id: i.customer_item_id,
          quantity: i.quantity,
          line_total: quoted.get(productId)! * i.quantity,
        })) ?? [{ id: undefined, quantity, line_total: lineTotal }])
      items.push({
        ...p,
        ...(replacement
          ? (() => {
              const original = replacement.lines.find(
                (l: any) => l.replacement_item_id === fragment.id,
              );
              return { name: original.name, sku: original.sku, vat: original.vat };
            })()
          : {}),
        item_id: fragment.id,
        quantity: fragment.quantity,
        price: sourceTotals
          ? Math.floor(fragment.line_total / fragment.quantity)
          : quoted.get(productId)!,
        line_total: fragment.line_total,
        components,
      });
    total += lineTotal;
  }
  ensure(
    Number.isSafeInteger(total) && total <= 2147483647,
    422,
    'Wartość zamówienia przekracza limit',
  );
  const picks: any[] = [];
  for (const [productId, quantity] of [...physical.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    ensure(Number.isSafeInteger(quantity) && quantity <= 10000000, 422, 'Za duża ilość składnika');
    const p = (
      await c.query(
        'SELECT p.*,s.available FROM products p JOIN stock s ON s.product_id=p.id AND s.tenant_id=p.tenant_id WHERE p.id=$1 AND s.warehouse_id=$2 FOR UPDATE OF s',
        [productId, input.warehouse_id],
      )
    ).rows[0];
    ensure(p, 404, 'Produkt nie istnieje w wybranym magazynie');
    ensure(
      p.active && ['simple', 'variant'].includes(p.kind),
      422,
      'Składnik jest nieaktywny lub nie jest produktem fizycznym',
    );
    ensure(p.available >= quantity, 409, `Za mało towaru: ${p.sku}. Dostępne: ${p.available}`);
    picks.push({ ...p, quantity });
  }
  const id = replacement?.replacement_order_id ?? randomUUID();
  // 245 (COM-PORTAL-4): the tenant's default link validity; null = no end date, as before 245.
  const portalDays = await portalDefaultDaysInTx(c);
  // A taken DE-<date>-<hex> number is redrawn under a savepoint, never surfaced (order-number.ts).
  await insertOrderWithNumberInTx(c, (number) => c.query(
    replacement
      ? "INSERT INTO orders(id,tenant_id,number,source,customer_name,email,address,currency,total,shipping_cost,warehouse_id,note,portal_token,payment_mode,fulfillment_kind,replacement_return_id,portal_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'replacement',$15,now()+make_interval(days=>$16::int))"
      : 'INSERT INTO orders(id,tenant_id,number,source,customer_name,email,address,currency,total,shipping_cost,warehouse_id,note,portal_token,payment_mode,portal_expires_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()+make_interval(days=>$15::int),$16)',
    [
      id,
      a.tenantId,
      number,
      input.source,
      input.customer_name,
      input.email,
      JSON.stringify(input.address),
      input.currency,
      total,
      input.shipping_cost,
      input.warehouse_id,
      input.note,
      randomBytes(24).toString('hex'),
      input.payment_mode,
      ...(replacement ? [replacement.return_id] : []),
      portalDays,
      // Cash on delivery is ready to fulfil at once (paid = "Nowe"); prepaid waits in new = "Nieopłacone".
      ...(replacement ? [] : [input.payment_mode === 'cod' ? 'paid' : 'new']),
    ],
  ));
  if (pricing?.list)
    await c.query('UPDATE orders SET price_list_id=$2,pricing_snapshot=$3 WHERE id=$1', [
      id,
      pricing.list.id,
      JSON.stringify(pricing),
    ]);
  for (const i of items) {
    await c.query(
      'INSERT INTO order_items(id,tenant_id,order_id,product_id,name,sku,quantity,price,vat,line_total,components) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        i.item_id ?? randomUUID(),
        a.tenantId,
        id,
        i.id,
        i.name,
        i.sku,
        i.quantity,
        i.price,
        i.vat,
        i.line_total,
        JSON.stringify(i.components),
      ],
    );
  }
  for (const i of picks) {
    await c.query(
      'INSERT INTO order_pick_items(id,tenant_id,order_id,product_id,sku,name,ean,quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), a.tenantId, id, i.id, i.sku, i.name, i.ean ?? '', i.quantity],
    );
    await c.query('UPDATE stock SET reserved=reserved+$1 WHERE product_id=$2 AND warehouse_id=$3', [
      i.quantity,
      i.id,
      input.warehouse_id,
    ]);
    await c.query(
      'INSERT INTO reservations(tenant_id,order_id,product_id,warehouse_id,quantity) VALUES($1,$2,$3,$4,$5)',
      [a.tenantId, id, i.id, input.warehouse_id, i.quantity],
    );
  }
  for (const i of picks) {
    const layers = await reserveWmsLotsInTx(c, a, {
      order_id: id,
      product_id: i.id,
      warehouse_id: input.warehouse_id,
      quantity: i.quantity,
    });
    if (layers === null) await reserveLocations(c, a, id, i.id, input.warehouse_id, i.quantity);
  }
  if (options.mappedInitial)
    await applyMappedInitialOrderFieldsInTx(
      c,
      { ...a, userId: a.userId!, role: 'admin', source: a.source === 'api' ? 'api' : 'manual' },
      id,
      options.mappedInitial,
    );
  if (preparedFields)
    await applyInitialOrderFieldsInTx(c, a, id, preparedFields, undefined, {
      deferPrincipalPin: Boolean(options.externalIntentLines),
    });
  await event(c, a.tenantId, id, 'order.created');
  await audit(c, a, 'order.create', id);
  return hydrateOrder(c,id,createInstallation);
}
// Status codes are historical; the labels carry the meaning (web/api.ts statusNames, docs/order-status-codes.md):
// new = "Nieopłacone" (prepaid, waiting for payment), paid = "Nowe" (ready to fulfil: paid online, cash on delivery
// or B2B trade credit released). Fulfilment starts only from paid.
const transitions: Record<string, string[]> = {
  new: ['paid', 'cancelled'],
  paid: ['picking', 'cancelled'],
  picking: ['packed', 'cancelled'],
  packed: ['cancelled'],
  shipped: ['delivered', 'return_initiated'],
  delivered: ['completed', 'return_initiated'],
  completed: ['return_initiated'],
  return_initiated: ['return_received'],
  return_received: ['return_completed'],
};
export async function lockedOrder(c: PoolClient, id: string) {
  const head = (await c.query('SELECT warehouse_id FROM orders WHERE id=$1', [id])).rows[0];
  ensure(head, 404, 'Nie znaleziono zamówienia');
  // Cancellation/status/document paths also trigger policy guards. Acquire the
  // warehouse before the order so a queued policy writer cannot invert them.
  await lockWarehouseInventoryPoliciesInTx(c, [head.warehouse_id]);
  const o = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  ensure(o.warehouse_id === head.warehouse_id, 409, 'Magazyn zamówienia zmienił się');
  await assertOrderMergeActiveInTx(c, id);
  return o;
}
/** Allocate real scans across frozen commercial fragments, including bundles.
 * Each physical unit is counted once even when the same SKU has several prices.
 */
export async function refreshCommercialScans(c: PoolClient, id: string) {
  const physical = (
    await c.query(
      'SELECT product_id,scanned FROM order_pick_items WHERE order_id=$1 ORDER BY product_id',
      [id],
    )
  ).rows;
  const remaining = new Map<string, number>(physical.map((p) => [p.product_id, p.scanned]));
  const items = (
    await c.query(
      'SELECT id,product_id,quantity,scanned,components FROM order_items WHERE order_id=$1 ORDER BY id',
      [id],
    )
  ).rows;
  const intent = await b2bExternalIntentStateInTx(c, id);
  const fragments = items.map((item) => {
    const recipe = item.components.length
      ? item.components
      : [{ product_id: item.product_id, quantity: 1 }];
    const needs = new Map<string, number>();
    for (const part of recipe)
      needs.set(part.product_id, (needs.get(part.product_id) ?? 0) + part.quantity);
    for (const [product, quantity] of needs) {
      const available = (remaining.get(product) ?? 0) - item.scanned * quantity;
      ensure(available >= 0, 409, 'Skan pozycji handlowej nie odpowiada skanom fizycznym');
      remaining.set(product, available);
    }
    return { item, needs };
  });
  const updates = fragments.map(({ item, needs }) => {
    const required = intent
      ? intent.items.find((i) => i.customer_item_id === item.id)!.local_quantity
      : item.quantity;
    let scanned = required - item.scanned;
    for (const [product, quantity] of needs)
      scanned = Math.min(scanned, Math.floor((remaining.get(product) ?? 0) / quantity));
    for (const [product, quantity] of needs)
      remaining.set(product, (remaining.get(product) ?? 0) - scanned * quantity);
    return { id: item.id, scanned: item.scanned + scanned };
  });
  await c.query(
    `UPDATE order_items i SET scanned=x.scanned
     FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,scanned integer)
     WHERE i.order_id=$1 AND i.id=x.id AND i.scanned<>x.scanned`,
    [id, JSON.stringify(updates)],
  );
}
export async function cancelOrder(
  c: PoolClient,
  a: AuditActor,
  id: string,
  context?: EventContext,
  options: { externalIntentClose?: string } = {},
) {
  a = enlistWmsActorInTx(c, a, { orders: true });
  const o = await lockedOrder(c, id);
  if (o.status === 'cancelled') return getOrder(c, id);
  await assertNoOrderParcelPlanInTx(c, id);
  await assertB2bDropshipCancelableInTx(c, id);
  const intent = await b2bExternalIntentStateInTx(c, id);
  ensure(
    !intent || options.externalIntentClose,
    409,
    'Zamknij zamówienie przez historię intencji realizacji',
  );
  ensure(transitions[o.status]?.includes('cancelled'), 409, 'Po wydaniu towaru użyj zwrotu');

  ensure(
    !(
      await c.query(
        "SELECT id FROM invoice_plans WHERE order_id=$1 AND kind='invoice' AND mode='external' AND state NOT IN ('preview','cancelled') UNION ALL SELECT id FROM odoo_invoice_exports WHERE order_id=$1 AND mode='external' AND state NOT IN ('preview','cancelled') LIMIT 1",
        [id],
      )
    ).rowCount,
    409,
    'Faktura jest w kolejce, niepewna lub zapisana. Uzgodnij dokument; po wydaniu towaru użyj zwrotu i korekty',
  );
  ensure(
    !(
      await c.query(
        "SELECT id FROM shipping_plans WHERE order_id=$1 AND state NOT IN ('preview','cancelled','dispatched')",
        [id],
      )
    ).rowCount,
    409,
    'Najpierw uzgodnij lub anuluj przygotowaną przesyłkę',
  );

  await cancelPackingForOrderInTx(c, a, o);

  const reservations = (
    await c.query(
      "SELECT * FROM reservations WHERE order_id=$1 AND state='active' ORDER BY product_id",
      [id],
    )
  ).rows;
  for (const r of reservations)
    await c.query('UPDATE stock SET reserved=reserved-$1 WHERE product_id=$2 AND warehouse_id=$3', [
      r.quantity,
      r.product_id,
      r.warehouse_id,
    ]);
  await releaseWmsLotsInTx(c, a, id);
  await c.query("UPDATE reservations SET state='released' WHERE order_id=$1 AND state='active'", [
    id,
  ]);

  await c.query(
    "UPDATE orders SET status='cancelled',workflow_status_id=NULL,updated_at=now() WHERE id=$1",
    [id],
  );
  await event(c, a.tenantId, id, 'order.cancelled', { from: o.status }, context);
  await audit(c, a, 'order.status', id, { from: o.status, to: 'cancelled' });
  return getOrder(c, id);
}
export async function transition(
  c: PoolClient,
  a: Actor,
  id: string,
  status: string,
  context?: EventContext,
  fulfillmentContext?: { packing: PackingTransitionContext },
  legacyReturnGroup?: LegacyReturnGroup,
  legacyOnReturnCommand?: LegacyOnReturnCommand,
  expectedVersion?: string,
) {
  if (status === 'packed') await acquirePackingFieldAdmissionInTx(c,a);
  a = enlistWmsActorInTx(c, a, { orders: true });
  ensure(!legacyOnReturnCommand || (!legacyReturnGroup && !context && !fulfillmentContext &&
    status === 'return_received' && legacyOnReturnCommand.order_id === id),
    403, 'Command ON wymaga własnej bezpośredniej fazy przyjęcia');
  let returnCompletion: {id:string;input:NonNullable<Awaited<ReturnType<typeof prepareLegacyReturnCompletionInTx>>>['input'];completion:ReturnCompletion} | undefined = !legacyReturnGroup && !legacyOnReturnCommand && status === 'return_received' ? await prepareLegacyReturnCompletionInTx(c, a, id) : undefined;
  const o = await lockedOrder(c, id);
  // The original row lock protects this comparison through the managed COMMIT.
  ensure(expectedVersion === undefined || String(o.version) === expectedVersion,
    409, 'Zamówienie zmieniło się. Odśwież dane przed zmianą statusu.');
  if (legacyReturnGroup) returnCompletion = await claimLegacyReturnGroupTransitionInTx(c,a,legacyReturnGroup,id,status);
  if (legacyOnReturnCommand) {
    const claimed = await claimLegacyOnReturnCommandInTx(c, a, legacyOnReturnCommand);
    returnCompletion = { id: legacyOnReturnCommand.return_id, ...claimed };
  }
  if (['picking', 'packed', 'cancelled'].includes(status))
    await assertNoOrderParcelPlanInTx(c, id);
  ensure(
    transitions[o.status]?.includes(status),
    409,
    `Niedozwolona zmiana statusu ${o.status} → ${status}`,
  );
  if (status === 'paid') {
    if (o.fulfillment_kind === 'replacement')
      ensure(
        o.total === 0 && o.shipping_cost === 0 && o.payment_mode === 'prepaid',
        409,
        'Realizacja zastępcza wymaga zerowego rozliczenia',
      );
    else if (context)
      ensure(
        (await paymentBalance(c, id)).amount_due === 0,
        409,
        'Automatyzacja nie może potwierdzić brakującej wpłaty',
      );
    else await confirmOutstanding(c, a, id);
  }
  if (['picking', 'packed'].includes(status)) await fulfillmentPayment(c, o);
  // A reservation released by hand (order-edit releaseOrderStockInTx) must be reserved again before picking.
  if (status === 'picking')
    ensure(
      !(await c.query(
        "SELECT 1 FROM order_pick_items p JOIN reservations r ON (r.tenant_id,r.order_id,r.product_id)=(p.tenant_id,p.order_id,p.product_id) WHERE p.order_id=$1 AND p.quantity>0 AND r.state='released' LIMIT 1",
        [id],
      )).rowCount,
      409,
      'Zamówienie ma zwolnioną rezerwację. Zarezerwuj stan przed kompletacją',
    );
  if (status === 'packed') {
    await assertPackingFieldsCompleteInTx(c,a,id);
    await b2bExternalIntentAssertInTx(c, id, 'packed');
    await assertPackingTransitionInTx(c, a, o, fulfillmentContext?.packing);
    const items = (
      await c.query('SELECT quantity,scanned FROM order_pick_items WHERE order_id=$1', [id])
    ).rows;
    ensure(
      items.every((i) => i.scanned === i.quantity),
      409,
      'Zeskanuj wszystkie produkty przed spakowaniem',
    );
  }
  if (status === 'cancelled') return cancelOrder(c, a, id, context);
  if (status.startsWith('return_')) await legacyReturn(c, a, o, status, returnCompletion);
  await c.query(
    'UPDATE orders SET status=$1,workflow_status_id=NULL,updated_at=now() WHERE id=$2',
    [status, id],
  );
  await event(c, a.tenantId, id, `order.${status}`, { from: o.status }, context);
  await audit(c, a, 'order.status', id, { from: o.status, to: status });
  // uwaga klienta §7 (266): with "Drukuj etykietę przy pakowaniu" on, the packed order gets the DEMO label at once.
  if (status === 'packed') await autoDemoLabelAfterPackingInTx(c, a, id);
  if (returnCompletion && !legacyReturnGroup) {
    await completeReturnCompletionInTx(c, a, returnCompletion.completion);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  }
  const result = await getOrder(c, id);
  if (returnCompletion && !legacyReturnGroup) await pinReturnCompletionInTx(c, a, returnCompletion.completion);
  return result;
}
export async function scan(
  c: PoolClient,
  a: Actor,
  id: string,
  code: string,
  location?: string,
  packingContext?: PackingScanContext,
  lotContext?: { layer_id?: string; client_key?: string; wave_id?: string },
) {
  a = enlistWmsActorInTx(c, a, { orders: true });
  const lotPolicy = await wmsLotsPolicyInTx(c);
  const ordinary = !packingContext && !lotContext?.wave_id;
  let scanInput: Parameters<typeof wmsScanReplayInTx>[2] | undefined;
  if (lotPolicy.enabled && ordinary) {
    ensure(lotContext?.client_key, 422, 'Skan partii wymaga client_key do bezpiecznego ponowienia');
    scanInput = {
      order_id: id,
      client_key: lotContext.client_key,
      code,
      ...(location !== undefined ? { location } : {}),
      ...(lotContext.layer_id ? { layer_id: lotContext.layer_id } : {}),
    };
    const previous = await wmsScanReplayInTx(c, a, scanInput);
    if (previous !== null) return previous;
  }
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    `catalog:${a.tenantId}`,
  ]);
  const o = await lockedOrder(c, id);
  ensure(o.status === 'picking', 409, 'Skanowanie dostępne podczas kompletacji');
  await b2bExternalIntentAssertInTx(c, id, 'scan');
  await assertPackingScanInTx(c, a, o, packingContext);
  if (lotPolicy.enabled) {
    const wave = (
      await c.query(
        `SELECT w.id FROM picking_waves w JOIN picking_wave_orders m
      ON (m.tenant_id,m.wave_id)=(w.tenant_id,w.id)
      WHERE m.order_id=$1 AND w.state='picking'`,
        [id],
      )
    ).rows[0];
    ensure(
      !wave || wave.id === lotContext?.wave_id,
      409,
      'Zamówienie jest w aktywnej partii kompletacji. Skanuj przez jej proces',
    );
    ensure(
      !lotContext?.wave_id || wave?.id === lotContext.wave_id,
      409,
      'Kontekst skanu nie odpowiada aktywnej partii kompletacji',
    );
  }
  const aliases = await productSkuAvailable(c);
  const matches = (
    await c.query(
      `SELECT i.* FROM order_pick_items i JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id)
       WHERE i.order_id=$1 AND (i.sku=$2 OR i.ean=$2 OR p.sku=$2 OR p.ean=$2 ${aliases ? 'OR EXISTS(SELECT 1 FROM product_sku_aliases a WHERE (a.tenant_id,a.product_id)=(i.tenant_id,i.product_id) AND a.sku=$2)' : ''}) ORDER BY i.sku`,
      [id, code],
    )
  ).rows;
  ensure(matches.length > 0, 422, 'Kod nie należy do tego zamówienia');
  ensure(matches.length === 1, 422, 'Kod odpowiada kilku produktom. Użyj unikalnego SKU.');
  const i = matches[0];
  ensure(i.scanned < i.quantity, 409, 'Ten produkt jest już skompletowany');
  const pickedLocation = await scanLocation(c, id, i.product_id, location);
  const pickedLayer = await scanWmsLotInTx(c, a, {
    order_id: id,
    product_id: i.product_id,
    location: pickedLocation,
    ...(lotContext?.layer_id ? { layer_id: lotContext.layer_id } : {}),
  });
  await c.query('UPDATE order_pick_items SET scanned=scanned+1 WHERE id=$1', [i.id]);
  await refreshCommercialScans(c, id);
  const detail = {
    sku: i.sku,
    location: pickedLocation,
    ...(pickedLayer ? { layer_id: pickedLayer.layer_id, lot_id: pickedLayer.lot_id } : {}),
  };
  await event(c, a.tenantId, id, 'item.scanned', detail);
  await audit(c, a, 'order.scan', id, { ...detail, scanned_code: code });
  const result = await getOrder(c, id);
  if (scanInput) await wmsRecordScanInTx(c, a, scanInput, result);
  return result;
}
const DEMO_CARRIER = 'Symulator lokalny';
// A label cancelled with "Anuluj etykietę" (status 'canceled', server/shipment-cancel.ts) is never handed over.
const demoLabelSql = "SELECT * FROM shipments WHERE order_id=$1 AND mode='demo' AND carrier=$2 AND channel_id IS NULL AND dispatched_at IS NULL AND status<>'canceled'";
/** Demo label (Uwagi v3 §7): like a real carrier label, it creates an undispatched shipment, so the
 * packed order reads "Gotowe do nadania"; stock is issued and the order becomes shipped only in shipDemo. */
export async function createDemoLabel(c: PoolClient, a: Actor, id: string) {
  a = enlistWmsActorInTx(c, a, { orders: true });
  const o = await lockedOrder(c, id);
  await assertNoOrderParcelPlanInTx(c, id);
  await assertB2bDropshipDispatchInTx(c, id);
  ensure(o.status === 'packed', 409, 'Najpierw skompletuj i spakuj zamówienie');
  ensure(
    !(
      await c.query(
        "SELECT id FROM shipping_plans WHERE order_id=$1 AND state NOT IN ('preview','cancelled','dispatched')",
        [id],
      )
    ).rowCount,
    409,
    'Najpierw uzgodnij lub anuluj przygotowaną przesyłkę',
  );
  // After "Anuluj etykietę" the new label takes over the cancelled row (migration 268).
  const target = await newLabelTargetInTx(c, id, 'Zamówienie ma już etykietę');
  const codExpected = await fulfillmentPayment(c, o);
  const shipmentId = await writeLabelShipmentInTx(c, target, randomUUID(), {
    tenantId: a.tenantId, orderId: id, carrier: DEMO_CARRIER, trackingNumber: `DEMO-${randomBytes(6).toString('hex').toUpperCase()}`, mode: 'demo', codExpected,
  });
  await event(c, a.tenantId, id, 'shipment.label_created', { mode: 'demo', shipmentId });
  await audit(c, a, 'shipment.demo_label', id, target ? { replaced_cancelled_label: shipmentId } : undefined);
  return getOrder(c, id);
}
/** Demo dispatch ("Przekaż kurierowi"): hands over the demo label from createDemoLabel, or, for an order
 * without one, creates and dispatches the demo shipment in one step (seed, Base wire). */
export async function shipDemo(c: PoolClient, a: Actor, id: string, onPhysical?:WholeOrderIssueWriter) {
  a = enlistDispatchActorInTx(c, a);
  a = enlistWmsActorInTx(c, a, { orders: true });
  const head = (await c.query('SELECT warehouse_id FROM orders WHERE id=$1', [id])).rows[0];
  ensure(head, 404, 'Nie znaleziono zamówienia');
  const label = (await c.query(demoLabelSql, [id, DEMO_CARRIER])).rows[0];
  // A cancelled label is never handed over; the order needs a new label first ("Nowa etykieta", migration 268).
  ensure(
    label || !(await c.query("SELECT 1 FROM shipments WHERE order_id=$1 AND status='canceled'", [id])).rowCount,
    409,
    'Etykietę tego zamówienia anulowano; utwórz nową etykietę (Więcej → Nowa etykieta) i przekaż ją kurierowi',
  );
  const warehouseIds = [...new Set([head.warehouse_id as string, ...(await c.query<{warehouse_id:string}>(
    'SELECT DISTINCT warehouse_id FROM reservations WHERE order_id=$1 ORDER BY warehouse_id', [id],
  )).rows.map(r => r.warehouse_id)])].sort();
  await lockWarehouseInventoryPoliciesInTx(c, warehouseIds, { sellable: true });
  const shipmentId: string = label?.id ?? randomUUID();
  const source = { kind: 'demo' as const, order_id: id, shipment_id: shipmentId };
  const wz = await prepareAutomaticWzInTx(c, a, source);
  const o = await lockedOrder(c, id);
  ensure(o.warehouse_id === head.warehouse_id, 409, 'Magazyn zamówienia zmienił się');
  await assertNoOrderParcelPlanInTx(c, id);
  await assertB2bDropshipDispatchInTx(c, id);
  ensure(
    !(
      await c.query(
        "SELECT id FROM shipping_plans WHERE order_id=$1 AND state NOT IN ('preview','cancelled','dispatched')",
        [id],
      )
    ).rowCount,
    409,
    'Najpierw uzgodnij lub anuluj przygotowaną przesyłkę',
  );

  ensure(o.status === 'packed', 409, 'Najpierw skompletuj i spakuj zamówienie');
  const shipments = (await c.query('SELECT * FROM shipments WHERE order_id=$1 FOR UPDATE', [id])).rows;
  ensure(
    label ? shipments.length === 1 && shipments[0].id === label.id && !shipments[0].dispatched_at : !shipments.length,
    409,
    'Zamówienie ma już przesyłkę; nie powtarzaj wydania całego magazynu',
  );
  const codExpected = await fulfillmentPayment(c, o, label ? shipments[0].cod_expected : undefined);
  const rs = (
    await c.query(
      "SELECT * FROM reservations WHERE order_id=$1 AND state='active' ORDER BY product_id",
      [id],
    )
  ).rows;
  ensure(rs.length > 0, 409, 'Brak aktywnych rezerwacji');
  const physical=await consumeWholeOrderStockInTx(c,a,{order_id:id,reservations:rs});
  await c.query("UPDATE reservations SET state='consumed' WHERE order_id=$1", [id]);
  if (label) await c.query('UPDATE shipments SET dispatched_at=now() WHERE id=$1', [shipmentId]);
  else
    await c.query(
      'INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,cod_expected,dispatched_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())',
      [
        shipmentId,
        a.tenantId,
        id,
        DEMO_CARRIER,
        `DEMO-${randomBytes(6).toString('hex').toUpperCase()}`,
        'demo',
        codExpected,
      ],
    );
  await c.query("UPDATE orders SET status='shipped',updated_at=now() WHERE id=$1", [id]);
  await event(c, a.tenantId, id, 'order.shipped', { mode: 'demo', shipmentId });
  await audit(c, a, 'shipment.demo', id);
  await finishAutomaticWzInTx(c, a, wz, { source, physical });
  if(onPhysical)await onPhysical({source:{kind:'demo',order_id:id,shipment_id:shipmentId},physical});
  return getOrder(c, id);
}
export async function issueDocument(
  c: PoolClient,
  a: Actor,
  id: string,
  kind: 'invoice' | 'correction',
) {
  const o = await lockedOrder(c, id);
  await assertSaleFinancialOrderInTx(c, id);
  const { assertCommercialSaleClosedInTx } = await import('./commercial-sale-scope');
  const saleScope = await assertCommercialSaleClosedInTx(c,id);
  ensure(kind==='invoice'||!saleScope||BigInt(saleScope.cancelled_credit_minor)===0n,409,'Korekta częściowej sprzedaży wymaga osobnego zakresu zwrotu');
  ensure(
    !['new', 'cancelled'].includes(o.status),
    409,
    'Dokument dostępny po opłaceniu zamówienia',
  );
  if (kind === 'correction')
    ensure(
      ['return_received', 'return_completed'].includes(o.status),
      409,
      'Korekta dostępna po przyjęciu zwrotu',
    );
  if (kind === 'correction')
    ensure(
      !(await c.query('SELECT id FROM return_cases WHERE order_id=$1 AND NOT legacy', [id]))
        .rowCount,
      409,
      'Dla spraw częściowych wystaw korektę na karcie konkretnego zwrotu',
    );
  const prev = (
    await c.query("SELECT * FROM documents WHERE order_id=$1 AND kind=$2 AND mode='demo'", [
      id,
      kind,
    ])
  ).rows[0];
  if (prev) {
    if(saleScope&&kind==='invoice'){
      const issued=saleScope.lines.filter(l=>l.issued_quantity>0),lines=prev.data?.items;
      ensure(prev.data?.total===Number(saleScope.commercial_total_minor)&&prev.data?.shipping_cost===Number(saleScope.shipping_minor)&&Array.isArray(lines)&&lines.length===issued.length&&new Set(lines.map((i:any)=>i.id)).size===lines.length&&issued.every(l=>lines.some((i:any)=>i.id===l.item_id&&i.quantity===l.issued_quantity&&i.gross===Number(l.issued_gross_minor)&&i.line_total===Number(l.issued_gross_minor))),409,'Istniejąca faktura wymaga odrębnej korekty częściowej sprzedaży');
    }
    return prev;
  }
  const original = (
    await c.query(
      "SELECT id,number FROM documents WHERE order_id=$1 AND kind='invoice' AND mode='demo'",
      [id],
    )
  ).rows[0];
  if (kind === 'correction') ensure(original, 409, 'Najpierw wystaw dokument pierwotny');
  const tenant = (await c.query('SELECT name FROM tenants')).rows[0],
    items = (await c.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY sku', [id])).rows;
  const billing = await b2bDropshipBillToInTx(c, id);
  // Uwagi v3 §6: without a B2B bill-to the buyer is the invoice data edited on the order card, else the order.
  const party = billing ? null : await orderInvoiceParty(c, a.tenantId, id);
  const edited = party?.source === 'invoice_section' ? party : null;
  const data = {
    seller: tenant.name,
    customer: billing?.name ?? edited?.name ?? o.customer_name,
    email: billing?.email ?? o.email,
    address: billing?.address ?? edited?.address ?? o.address,
    ...(billing ? { tax_id: billing.tax_id } : edited?.tax_id ? { tax_id: edited.tax_id } : {}),
    currency: o.currency,
    total: (kind === 'correction' ? -1 : 1) * Number(saleScope?.commercial_total_minor??o.total),
    ...(saleScope?{commercial_scope:saleScope,original_total:o.total}:{}),
    shipping_cost: o.shipping_cost,
    imported: Boolean(o.source_snapshot),
    vat_source: 'local_catalog',
    items: items.filter(i=>!saleScope||saleScope.lines.find(l=>l.item_id===i.id)!.issued_quantity>0).map((i) => ({
      ...i,
      ...(saleScope?{quantity:saleScope.lines.find(l=>l.item_id===i.id)!.issued_quantity,line_total:Number(saleScope.lines.find(l=>l.item_id===i.id)!.issued_gross_minor)}:{}),
      gross: Number(saleScope?.lines.find(l=>l.item_id===i.id)?.issued_gross_minor??i.line_total),
      net: Math.round((Number(saleScope?.lines.find(l=>l.item_id===i.id)?.issued_gross_minor??i.line_total) * 100) / (100 + i.vat)),
    })),
    original: kind === 'correction' ? original : null,
  };
  const docId = randomUUID(),
    number = `${kind === 'invoice' ? 'DEMO-FV' : 'DEMO-KOR'}/${new Date().getUTCFullYear()}/${randomBytes(4).toString('hex').toUpperCase()}`;
  const d = (
    await c.query(
      'INSERT INTO documents(id,tenant_id,order_id,number,kind,data) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [docId, a.tenantId, id, number, kind, JSON.stringify(data)],
    )
  ).rows[0];
  await automationOnlyEvent(c, a.tenantId, id, 'document.issued', { document_id: docId, kind, mode: 'demo' });
  await audit(c, a, 'document.issue', docId, { kind, mode: 'demo' });
  return d;
}
