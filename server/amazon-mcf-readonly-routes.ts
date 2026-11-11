import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx, localConfig } from './db';
import { effectiveDeliveryInTx } from './buyer-address';
import { ensure } from './errors';
import type { Actor } from './domain';
import type { IntegrationContext } from './channel-access';
import { decrypt } from './security';
import {inspectAmazonMcfReadTransport,type AmazonMcfReadTransport} from './provider-read-transport';
import { Amazon } from './amazon';
import { amazonAccountPolicy } from './amazon-account';
import { amazonApiTransport } from './amazon-api-limits';
import { AmazonMcf, mcfId, mcfSku, mcfPreviewInput, mcfPackageTracking } from './amazon-mcf-api';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const scopeInput = z.strictObject({
  channel_id: z.uuid(), order_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  origin_country: z.string().regex(/^[A-Z]{2}$/),
  fulfillment_service_id: mcfId.optional(),
});
export const mcfOrderPreviewInput = scopeInput.extend({
  sku_map: z.array(z.strictObject({ item_id: z.uuid(), amazon_sku: mcfSku })).min(1).max(100),
  service_tiers: z.array(z.enum(['STANDARD','EXPEDITED','PRIORITY','SCHEDULED'])).min(1).max(4),
});
const lookupInput = scopeInput.extend({ order_version: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER), order_id: mcfId });
// Existing local quantities/address are authoritative. SKU mapping is explicit, never inferred.
export function buildMcfOrderPreview(order: any, items: any[], input: z.infer<typeof mcfOrderPreviewInput>) {
  ensure(order.version === input.order_version, 409, 'Zamówienie zmieniło się. Odśwież szczegóły.');
  ensure(order.payment_mode !== 'cod', 422, 'Ten podgląd MCF nie obsługuje pobrania.');
  ensure(order.effective_delivery?.kind === 'address' && order.effective_delivery.delivery,422,
    'Podgląd MCF wymaga aktualnego, rozpoznanego adresu dostawy.');
  const delivery = order.effective_delivery.delivery;
  ensure(items.length > 0 && items.length <= 100 && input.sku_map.length === items.length,
    422, 'Podaj mapowanie wszystkich pozycji zamówienia.');
  ensure(new Set(input.sku_map.map(x => x.item_id)).size === items.length &&
    new Set(input.sku_map.map(x => x.amazon_sku)).size === items.length &&
    new Set(input.service_tiers).size === input.service_tiers.length,
    422, 'Powtórzone pozycje, SKU lub usługi MCF.');
  const mapped = new Map(input.sku_map.map(x => [x.item_id, x.amazon_sku]));
  return mcfPreviewInput.parse({
    origin: { countryCode: input.origin_country },
    destination: { deliveryAddress: {
      name: delivery.recipient_name,
      addressLine1: delivery.street, city: delivery.city,
      postalCode: delivery.postal_code, countryCode: delivery.country,
      ...(delivery.phone ? { phone: delivery.phone } : {}),
    } },
    lineItems: items.map(item => {
      ensure(mapped.has(item.id) && Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 1000000,
        422, 'Nieprawidłowa pozycja lub ilość MCF.');
      return { product: { productIdentifier: { amazonSku: mapped.get(item.id) } },
        amount: { unit: 'EACHES', value: String(item.quantity) } };
    }),
    fulfillmentConfiguration: { serviceLevel: { serviceTiers: input.service_tiers } },
    excludeEstimatedFees: false, includePaymentOnDelivery: false,
  });
}
async function localOrder(c: any, actor: Actor, id: string) {
  ensure((await c.query('SELECT offer_sync_is_admin($1) ok',[actor.userId])).rows[0]?.ok,
    403, 'Wymagana aktualna rola administratora.');
  const order = (await c.query('SELECT id,version,customer_name,address,payment_mode,status FROM orders WHERE id=$1',[id])).rows[0];
  ensure(order,404,'Nie znaleziono zamówienia.');
  order.effective_delivery = await effectiveDeliveryInTx(c,actor.tenantId,id,localConfig.encryptionKey);
  const items = (await c.query('SELECT id,sku,name,quantity FROM order_items WHERE order_id=$1 ORDER BY id LIMIT 101',[id])).rows;
  ensure(items.length <= 100,422,'Panel MCF obsługuje do 100 pozycji zamówienia.');
  return { order, items };
}
async function capture(actor: Actor, id: string, input: z.infer<typeof scopeInput>) {
  return tenantTx(actor.tenantId, async c => {
    const local = await localOrder(c,actor,id);
    ensure(local.order.version === input.order_version,409,'Zamówienie zmieniło się. Odśwież szczegóły.');
    const channel = (await c.query('SELECT * FROM channels WHERE id=$1',[input.channel_id])).rows[0];
    ensure(channel?.provider === 'amazon',404,'Nie znaleziono kanału Amazon.');
    ensure(!channel.settings.simulation,422,'Podgląd MCF wymaga połączonego konta Amazon.');
    const binding = await amazonAccountPolicy(c,channel);
    ensure(binding,409,'Połącz i zweryfikuj konto Amazon przez OAuth przed odczytem MCF.');
    return { ...local, channel, binding };
  });
}
const channelCut = (x: Awaited<ReturnType<typeof capture>>) => hash({
  channel: { id:x.channel.id,provider:x.channel.provider,mode:x.channel.mode,settings:x.channel.settings,
    credentials:x.channel.credentials,oauth_scopes:x.channel.oauth_scopes,status:x.channel.status }, binding:x.binding,
});
export function registerAmazonMcfReadOnlyRoutes(app: FastifyInstance, ctx: IntegrationContext = {}, readOnly = false, mcfTransport?:AmazonMcfReadTransport) {
  const capability=mcfTransport===undefined?undefined:inspectAmazonMcfReadTransport(mcfTransport);
  const admin = (req: any, external = false) => {
    ensure(req.actor?.role === 'admin' && !req.actor.apiKeyId && req.apiScopes === undefined,
      403,'Wymagana sesja administratora.');
    ensure(!external || !readOnly,423,'Połączenia z Amazon są wyłączone w podglądzie kopii.');
  };
  const orderId = (params: unknown) => z.strictObject({ id:z.uuid() }).parse(params).id;
  app.get('/api/orders/:id/amazon-mcf', async req => {
    admin(req); z.strictObject({}).parse(req.query);
    return tenantTx(req.actor.tenantId, async c => {
      const local = await localOrder(c,req.actor,orderId(req.params));
      const channels = capability&&!readOnly?(await c.query("SELECT id,name,mode FROM channels WHERE provider='amazon' AND mode=$1 AND settings->>'region'=$2 AND coalesce((settings->>'simulation')::boolean,false)=false ORDER BY name,id LIMIT 100",[capability.mode,capability.region])).rows:[];
      return { order_id:local.order.id,order_version:local.order.version,items:local.items,channels,
        external_read_available:!readOnly&&capability!==undefined,external_read_reason:readOnly?'RESTORE_READ_ONLY':capability===undefined?'MCF_TRANSPORT_DISABLED':null,read_only:true,creates_fulfillment:false };
    });
  });
  async function read<T>(req: any, input: z.infer<typeof scopeInput>, operation: (client: AmazonMcf, fence: () => Promise<void>, snapshot: Awaited<ReturnType<typeof capture>>) => Promise<T>) {
    admin(req,true);
    ensure(mcfTransport&&capability,503,'Odczyt MCF nie jest włączony w tym uruchomieniu.');
    const id = orderId(req.params), snapshot = await capture(req.actor,id,input);
    ensure(snapshot.channel.mode===capability.mode&&snapshot.channel.settings.region===capability.region,409,'Konto Amazon jest poza zakresem włączonego odczytu MCF.');
    const
      frozenChannel = channelCut(snapshot), frozenLocal = hash({ order:snapshot.order,items:snapshot.items });
    const fence = async () => {
      const latest = await capture(req.actor,id,input);
      ensure(channelCut(latest) === frozenChannel,409,'Konto, grant lub ustawienia Amazon zmieniły się.');
      ensure(hash({order:latest.order,items:latest.items}) === frozenLocal,409,'Dane zamówienia zmieniły się podczas odczytu.');
    };
    const credentials = decrypt(snapshot.channel.credentials),
      transport = amazonApiTransport(snapshot.channel.mode,snapshot.channel.settings.region,credentials.client_id,mcfTransport),
      guardedTransport: typeof transport = async (url,init) => {
        await fence();
        // The same guard runs again AFTER the durable API permit, immediately before HTTP.
        ensure(transport.mutation,500,'Brak kontrolowanego transportu Amazon.');
        return transport.mutation(url,init,fence);
      },
      auth = new Amazon(snapshot.channel.mode,snapshot.channel.settings,credentials,guardedTransport),
      client = new AmazonMcf(auth,guardedTransport,{originCountry:input.origin_country,fulfillmentServiceId:input.fulfillment_service_id});
    const result = await operation(client,fence,snapshot);await fence();
    return { order_id:id,order_version:input.order_version,channel_id:input.channel_id,
      origin_country:input.origin_country,fulfillment_service_id:input.fulfillment_service_id ?? null,
      mode:snapshot.channel.mode,observed_at:new Date().toISOString(),read_only:true,creates_fulfillment:false,result };
  }
  app.post('/api/orders/:id/amazon-mcf/preview',{bodyLimit:32768},async req => {
    admin(req,true); z.strictObject({}).parse(req.query);
    const input = mcfOrderPreviewInput.parse(req.body);
    return read(req,input,(client,fence,snapshot) => client.preview(buildMcfOrderPreview(snapshot.order,snapshot.items,input),fence));
  });
  app.get('/api/orders/:id/amazon-mcf/order',async req => {
    admin(req,true);const input = lookupInput.parse(req.query);
    return read(req,input,async (client,fence) => {
      const order = await client.order(input.order_id,fence);
      return { external_order_id:order.orderId,status:order.status ?? null,
        scope:'authorized_amazon_account_not_verified_local_order_link',tracking:mcfPackageTracking(order) };
    });
  });
}
