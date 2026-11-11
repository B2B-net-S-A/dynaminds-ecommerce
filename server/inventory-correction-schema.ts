import { z } from 'zod';
/** Intended server module. SOURCE_ONLY: native integration has not been applied. */
const uuid = z.uuid().transform(v => v.toLowerCase());
const pattern = /^(0|[1-9]\d{0,18})$/;
export const correctionDecimal = z.string().refine(v => pattern.test(v) && BigInt(v) <= 9223372036854775807n, 'Wymagana kanoniczna liczba int64');
const positiveVersion = correctionDecimal.refine(v => pattern.test(v) && BigInt(v) > 0n);
const clean = (max: number) => z.string().trim().max(max).refine(v => !v.includes('\0') && Buffer.from(v,'utf8').toString('utf8') === v);
export const inventoryCorrectionPreviewInput = z.strictObject({
 client_key:uuid, policy_version:positiveVersion, kind:z.literal('adjustment'),
 product_id:uuid, warehouse_id:uuid, location:clean(80).min(1).refine(v => !/[\u0000-\u001f\u007f]/.test(v)),
 quantity:z.number().int().min(-1000000).max(1000000).refine(v => v !== 0),
 stock_versions:z.array(z.strictObject({warehouse_id:uuid,product_id:uuid,version:correctionDecimal})).length(1),
 layer_ids:z.array(uuid).min(1).max(10000).optional(), unit_cost_minor:correctionDecimal.optional(),
 currency:z.enum(['PLN','EUR','USD','GBP','CZK']).optional(), lot_code:clean(100).min(1).optional(), note:clean(1000).min(3),
}).superRefine((b,ctx) => {
 const fail=(path:string,message:string) => ctx.addIssue({code:'custom',path:[path],message});
 if(b.stock_versions[0] && (b.stock_versions[0].product_id !== b.product_id || b.stock_versions[0].warehouse_id !== b.warehouse_id))fail('stock_versions','Wersja musi wskazywać dokładnie wybrany produkt i magazyn');
 if(b.quantity>0){
  if(b.unit_cost_minor===undefined)fail('unit_cost_minor','Przychód wymaga jawnego kosztu');
  if(!b.currency)fail('currency','Przychód wymaga waluty');
  if(!b.lot_code)fail('lot_code','Przychód wymaga partii');
  if(b.layer_ids!==undefined)fail('layer_ids','Przychód tworzy nową warstwę');
 }else{
  if(!b.layer_ids)fail('layer_ids','Rozchód wymaga jawnych istniejących warstw');
  if(b.unit_cost_minor!==undefined||b.currency!==undefined||b.lot_code!==undefined)fail('unit_cost_minor','Rozchód zachowuje koszt i partię rzeczywistych warstw');
 }
 if(b.layer_ids && new Set(b.layer_ids).size!==b.layer_ids.length)fail('layer_ids','Powtórzona warstwa');
});
export const inventoryCorrectionExecuteInput=z.strictObject({protocol:z.literal('wms_adjustment090'),preview_id:uuid,client_key:uuid,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
// Unknown legacy properties retain historical stripping, except a protocol marker:
// malformed modern requests must never fall through into the old delta writer.
export const inventoryLegacyAdjustInput=z.object({product_id:z.uuid(),warehouse_id:z.uuid(),delta:z.number().int().min(-1000000).max(1000000).refine(v=>v!==0),note:z.string().trim().min(3).max(500),protocol:z.never().optional()});
export const inventoryAdjustInput=z.union([inventoryCorrectionExecuteInput,inventoryLegacyAdjustInput]);
