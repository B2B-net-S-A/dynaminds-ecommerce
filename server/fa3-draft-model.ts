/** SOURCE ONLY. Pure proposal: no persistence, authorization, numbering or issuance. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
const uuid=z.uuid().transform(s=>s.toLowerCase());
const max=999999999999999999n; // FA3 TKwotowy: 16 integer PLN digits +2 fractional.
const decimalInRange=(s:string,limit:bigint)=>s.length<=18&&/^(0|[1-9][0-9]*)$/.test(s)&&BigInt(s)<=limit;
const minor=z.string().max(18).regex(/^(0|[1-9][0-9]*)$/).refine(x=>decimalInRange(x,max));
const positive=z.string().regex(/^[1-9][0-9]{0,9}$/);
const version=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(s=>/^[1-9][0-9]{0,18}$/.test(s)&&BigInt(s)<=9223372036854775807n);
function legalXml(s:string){for(const c of s){const n=c.codePointAt(0)!;if(!(n===9||n===10||n===13||n>=32&&n<=0xd7ff||n>=0xe000&&n<=0xfffd||n>=0x10000&&n<=0x10ffff)||n>=0x7f&&n<=0x9f||n>=0xfdd0&&n<=0xfdef||(n&0xffff)>=0xfffe)return false;}return true;}
const text=(n:number)=>z.string().min(1).max(n).refine(s=>s.trim()===s&&legalXml(s));
// Actual FA3 P_1/P_6 are TDataT (2006..2050), distinct from TData (2016..2050).
export const b2bFa3Date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T12:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s&&s>='2006-01-01'&&s<='2050-01-01';});
const nip=z.string().regex(/^\d{10}$/).refine(s=>s!=='0000000000'&&[6,5,7,2,3,4,5,6,7].reduce((v,w,i)=>v+w*Number(s[i]),0)%11===Number(s[9]));
export const b2bFa3Party=z.strictObject({kind:z.literal('business'),name:text(512),tax_id:nip,address:z.strictObject({country:z.literal('PL'),line1:text(512),line2:text(512).optional()})});
const source=z.strictObject({tenant_id:uuid,order_id:uuid,order_version:version,item_ids:z.array(uuid).min(1).max(100),order_total_minor:minor,shipping_gross_minor:minor,buyer_basis:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('ordinary_explicit'),confirmed_bill_to_hash:z.string().regex(/^[a-f0-9]{64}$/)}),
 z.strictObject({kind:z.literal('native_b2b_bill_to'),binding_id:uuid,binding_version:positive,snapshot_hash:z.string().regex(/^[a-f0-9]{64}$/)})
])});
const line=z.strictObject({ordinal:z.number().int().min(1).max(101),line_id:uuid,kind:z.enum(['item','shipping']),source_item_id:uuid.nullable(),name:text(512),unit:text(50),quantity:positive,
 unit_gross_minor:minor.refine(x=>decimalInRange(x,9999999999999999n)),discount_gross_minor:minor.refine(x=>decimalInRange(x,9999999999999999n)),rounding_gross_minor:minor,gross_minor:minor,net_minor:minor,vat_minor:minor,
 vat_code:z.enum(['23','8','5','0 KR']),zero_domestic_basis:text(512).nullable()});
export const b2bFa3DraftSchema=z.strictObject({schema:z.literal('b2b-fa3-draft/v1'),state:z.literal('draft'),currency:z.literal('PLN'),invoice_kind:z.literal('VAT'),tax_method:z.literal('gross_line_half_up'),
 seller:b2bFa3Party,buyer:b2bFa3Party,source,sale_date:b2bFa3Date,
 ordinary_scope:z.strictObject({cash_method:z.literal(false),self_billing:z.literal(false),reverse_charge:z.literal(false),split_payment:z.literal(false),exemption:z.literal(false),new_transport:z.literal(false),triangular:z.literal(false),margin:z.literal(false),jst:z.literal(false),vat_group:z.literal(false),advance:z.literal(false)}),
 lines:z.array(line).min(2).max(101),totals:z.strictObject({gross_minor:minor,net_minor:minor,vat_minor:minor})});
export type B2bFa3Draft=z.infer<typeof b2bFa3DraftSchema>;
export class B2bFa3Error extends Error{constructor(public readonly code:'INVALID_DRAFT'|'ROUNDING_MAPPING_REQUIRED'|'XML_BYTES_EXCEEDED',message:string){super(message);this.name='B2bFa3Error';}}
function check(ok:unknown,m:string):asserts ok{if(!ok)throw new B2bFa3Error('INVALID_DRAFT',m);}
export function validateB2bFa3Draft(input:unknown):B2bFa3Draft{
 const parsed=b2bFa3DraftSchema.safeParse(input);if(!parsed.success)throw new B2bFa3Error('INVALID_DRAFT','Niepełny lub nieobsługiwany draft B2B/FA3');const d=parsed.data;
 const ids=new Set<string>(),items=new Set<string>();let gross=0n,net=0n,vat=0n;
 d.lines.forEach((r,i)=>{check(r.ordinal===i+1&&!ids.has(r.line_id),'Niepełne ordinal/UUID pozycji');ids.add(r.line_id);
  if(i===d.lines.length-1)check(r.kind==='shipping'&&r.source_item_id===null&&r.quantity==='1'&&r.gross_minor===d.source.shipping_gross_minor,'Brak dokładnej pozycji dostawy');
  else{check(r.kind==='item'&&r.source_item_id!==null&&!items.has(r.source_item_id),'Powtórzona albo obca tożsamość pozycji');items.add(r.source_item_id!);}
  const q=BigInt(r.quantity),g=BigInt(r.gross_minor),discount=BigInt(r.discount_gross_minor),rounding=BigInt(r.rounding_gross_minor);
  check(!(discount>0n&&rounding>0n)&&rounding<q&&BigInt(r.unit_gross_minor)*q-discount+rounding===g,'Niespójna historyczna cena/rabat/zaokrąglenie');
  check((r.vat_code==='0 KR')===(r.zero_domestic_basis!==null),'Stawka0 wymaga jawnej podstawy krajowej; nie zastępuje zwolnienia/NULL');
  const rate=BigInt(r.vat_code==='0 KR'?0:r.vat_code),den=100n+rate,v=(2n*g*rate+den)/(2n*den);
  check(v===BigInt(r.vat_minor)&&g-v===BigInt(r.net_minor),'Niespójne kwoty VAT pozycji');gross+=g;net+=g-v;vat+=v;
 });
 check(new Set(d.source.item_ids).size===d.source.item_ids.length&&items.size===d.source.item_ids.length&&d.source.item_ids.every(id=>items.has(id)),'Pozycje nie pokrywają pełnego deklarowanego źródła');
 check(gross<=max&&net<=max&&vat<=max&&gross.toString()===d.source.order_total_minor&&gross.toString()===d.totals.gross_minor&&net.toString()===d.totals.net_minor&&vat.toString()===d.totals.vat_minor,'Niepełne sumy całego zamówienia');
 return d;
}
function canonical(x:unknown):unknown{return Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])):x;}
export function b2bFa3DraftHash(input:unknown){return createHash('sha256').update(JSON.stringify(canonical(validateB2bFa3Draft(input)))).digest('hex');}
export const b2bFa3XmlTextValid=legalXml;
