import { productTags } from './product-tags-schema';
import { assertProductRulePriceTagsInTx, executeProductRulePricesInTx, pinProductRulePriceTagsInTx } from './product-rule-price-tags';
import { productRulePriceFramesInTx } from './price-bulk-edit';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, catalogFields, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { assertProductsNotDeletedInTx } from './product-deletions';

export const PRODUCT_RULE_JOB = 'product.rules';
const text = (max: number, empty = false) =>
  z
    .string()
    .min(empty ? 0 : 1)
    .max(max)
    .refine((v) => !/[\x00-\x1f\x7f]/.test(v) && (empty || !!v.trim()));
const key = text(80).refine((v) => !['__proto__', 'prototype', 'constructor'].includes(v));
const stringOp = z.enum(['eq', 'not_eq', 'contains', 'prefix']);
const condition = z.union([
  z.strictObject({field:z.literal('tag'),op:z.enum(['contains','not_contains']),value:text(80)}),
  z.strictObject({
    field: z.enum(['sku', 'name', 'category', 'kind']),
    op: stringOp,
    value: text(200, true),
  }),
  z.strictObject({ field: z.literal('active'), op: z.literal('eq'), value: z.boolean() }),
  z.strictObject({ field: z.literal('attribute'), key, op: stringOp, value: text(500, true) }),
  z.strictObject({ field: z.literal('attribute'), key, op: z.enum(['exists', 'not_exists']) }),
]);
export const productRuleDefinition = z.strictObject({
  name: text(120),
  event: z.enum(['product.created', 'product.updated']),
  enabled: z.boolean().default(false),
  priority: z.number().int().min(0).max(100).default(50),
  conditions: z.array(condition).max(10),
  actions: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('set_category'), category: text(80) }),
        z.strictObject({ type: z.literal('set_attribute'), key, value: text(500, true) }),
        z.strictObject({ type: z.literal('remove_attribute'), key }),
        z.strictObject({type:z.literal('add_tags'),tags:productTags}),
        z.strictObject({type:z.literal('remove_tags'),tags:productTags}),
        z.strictObject({type:z.literal('replace_tags'),tags:productTags}),
        z.strictObject({type:z.literal('set_price'),price_list_id:z.uuid(),amount_minor:z.number().int().min(0).max(100000000)}),
        z.strictObject({type:z.literal('adjust_price'),price_list_id:z.uuid(),delta_minor:z.number().int().min(-100000000).max(100000000)}),
        z.strictObject({type:z.literal('multiply_price'),price_list_id:z.uuid(),numerator:z.number().int().min(1).max(1000000),denominator:z.number().int().min(1).max(1000000)}),
      ]),
    )
    .min(1)
    .max(5),
});
export const productRuleCreate = z.strictObject({
  client_key: z.uuid(),
  definition: productRuleDefinition,
  confirm_future_changes: z.boolean().default(false),
});
export const productRuleUpdate = z.strictObject({
  version: z.number().int().positive(),
  definition: productRuleDefinition,
  confirm_future_changes: z.boolean().default(false),
});
export const productRulePreview = z
  .strictObject({
    client_key: z.uuid(),
    event: z.enum(['product.created', 'product.updated']),
    rule_ids: z.array(z.uuid()).min(1).max(100),
    items: z
      .array(z.strictObject({ product_id: z.uuid(), version: z.number().int().positive() }))
      .min(1)
      .max(100),
  })
  .refine(
    (v) =>
      new Set(v.rule_ids).size === v.rule_ids.length &&
      new Set(v.items.map((i) => i.product_id)).size === v.items.length,
    'Powtórzona reguła lub produkt',
  );
export const productRuleConsent = z.strictObject({
  confirmed: z.literal(true),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
type Definition = z.infer<typeof productRuleDefinition>;
type FrozenRule = { id: string; version: number; approved_by: string; definition: Definition };
const productSourceEvent = z.strictObject({
  product_id: z.uuid(),
  event: z.enum(['product.created', 'product.updated']),
  cause_id: z.uuid(),
});
export type ProductRuleSourceEvent = z.infer<typeof productSourceEvent>;
const sourceSchema = z.strictObject({
  id: z.uuid(),
  version: z.number().int().positive(),
  sku: z.string().min(1).max(80),
  name: catalogFields.shape.name,
  category: catalogFields.shape.category,
  kind: z.enum(['simple', 'variant', 'group', 'bundle']),
  active: z.boolean(),
  attributes: catalogFields.shape.attributes,
  tags: productTags.optional(),
  price_targets: z.record(z.uuid(),z.any()).optional(),
});
type Source = z.infer<typeof sourceSchema>;
const stable = (v: any): any =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, stable(x)]),
        )
      : v;
export const productRuleHash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(v)))
    .digest('hex');
function sourceOf(p: any, extension?:{tags?:boolean;prices?:Record<string,unknown>}): Source {
  return sourceSchema.parse(
    {...Object.fromEntries(Object.keys(sourceSchema.shape).filter(k=>!['tags','price_targets'].includes(k)).map(k=>[k,p[k]])),...(extension?.tags?{tags:p.tags}:{}),...(extension?.prices?{price_targets:extension.prices}:{})},
  );
}
function matches(p: Source, c: z.infer<typeof condition>) {
  if(c.field==='tag'){ensure(p.tags!==undefined,503,'Brak źródła tagów');return c.op==='contains'?p.tags.includes(c.value):!p.tags.includes(c.value);}
  const value = c.field === 'attribute' ? p.attributes[c.key] : p[c.field];
  if (c.op === 'exists') return Object.hasOwn(p.attributes, (c as any).key);
  if (c.op === 'not_exists') return !Object.hasOwn(p.attributes, (c as any).key);
  if (!('value' in c)) return false;
  if (c.op === 'eq') return value === c.value;
  if (c.op === 'not_eq') return value !== c.value;
  return (
    typeof value === 'string' &&
    (c.op === 'prefix' ? value.startsWith(c.value as string) : value.includes(c.value as string))
  );
}
export function projectProductRules(source: Source, rules: FrozenRule[]) {
  source = sourceSchema.parse(source);
  const category = catalogFields.shape.category;
  let nextCategory = source.category;
  const attributes = Object.fromEntries(Object.entries(source.attributes));
  const matched: string[] = [];
  let tags=source.tags===undefined?undefined:[...source.tags];
  const prices:Record<string,number|null>={};
  const touchedPrices=new Set<string>();
  for(const [id,target] of Object.entries(source.price_targets??{}))prices[id]=(target as any).snapshot.effective_price;
  for (const r of rules) {
    const definition = productRuleDefinition.parse(r.definition);
    if (!definition.conditions.every((c) => matches(source, c))) continue;
    matched.push(r.id);
    for (const a of definition.actions) {
      if (a.type === 'set_category') nextCategory = category.parse(a.category);
      else if (a.type === 'set_attribute')
        Object.defineProperty(attributes, a.key, {
          value: a.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else if(a.type==='remove_attribute')delete attributes[a.key];
      else if('tags' in a){ensure(tags!==undefined,503,'Brak źródła tagów');
        tags=productTags.parse(a.type==='replace_tags'?a.tags:a.type==='add_tags'?[...new Set([...tags,...a.tags])]:tags.filter(t=>!a.tags.includes(t)));
      }else{
        ensure(Object.hasOwn(prices,a.price_list_id),503,'Brak źródła ceny cennika');
        const target=source.price_targets![a.price_list_id];
        ensure(source.kind!=='group',422,'Grupa wariantów nie ma ceny sprzedaży');
        ensure(target.assigned&&target.frame.list.active,409,'Cennik jest nieaktywny lub nieprzypisany do katalogu');
        const prior=prices[a.price_list_id];
        ensure(a.type==='set_price'||prior!==null,422,'Brak ceny wyjściowej; użyj akcji Ustaw cenę');
        const value=a.type==='set_price'?BigInt(a.amount_minor):a.type==='adjust_price'?BigInt(prior!)+BigInt(a.delta_minor):(BigInt(prior!)*BigInt(a.numerator)+BigInt(a.denominator)/2n)/BigInt(a.denominator);
        ensure(value>=0n&&value<=100000000n,422,'Cena wynikowa poza zakresem 0–100000000');prices[a.price_list_id]=Number(value);touchedPrices.add(a.price_list_id);
      }
    }
  }
  return {
    projected: {
      category: nextCategory,
      attributes: catalogFields.shape.attributes.parse(attributes),
      ...(tags===undefined?{}:{tags}),
      ...(source.price_targets===undefined?{}:{price_targets:Object.fromEntries([...touchedPrices].sort().map(id=>[id,prices[id]]))}),
    },
    matched_rules: matched,
  };
}
async function lock(c: PoolClient, tenant: string) {
  // Same catalogue lock used by createProduct/editProduct and source imports.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`catalog:${tenant}`]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `product.rules:${tenant}`,
  ]);
}
async function admin(c: PoolClient, a: Actor) {
  ensure(!a.apiKeyId,403,'Reguły produktów wymagają własnej sesji; publiczny zakres API nie jest zarejestrowany');
  ensure(
    a.role === 'admin' &&
      (await c.query('SELECT offer_sync_is_admin($1) ok', [a.userId])).rows[0]?.ok,
    403,
    'Wymagany aktualny administrator',
  );
}
async function owners(c: PoolClient, rules: FrozenRule[]) {
  for (const id of [...new Set(rules.map((r) => r.approved_by))].sort())
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) ok', [id])).rows[0]?.ok,
      403,
      'Administrator zatwierdzający regułę utracił uprawnienia',
    );
}
async function activeBudget(c: PoolClient, excluding?: string) {
  ensure(
    (
      await c.query(
        'SELECT count(*)::int n FROM product_rules WHERE enabled AND ($1::uuid IS NULL OR id<>$1)',
        [excluding ?? null],
      )
    ).rows[0].n < 100,
    409,
    'Limit 100 aktywnych reguł produktów',
  );
}
async function revision(c: PoolClient, a: Actor, r: any) {
  await c.query(
    'INSERT INTO product_rule_revisions(tenant_id,rule_id,version,actor_id,definition,deleted) VALUES($1,$2,$3,$4,$5,$6)',
    [a.tenantId, r.id, r.version, a.userId, JSON.stringify(r.definition), !!r.deleted_at],
  );
  await audit(c, a, 'product.rule.save', r.id, {
    version: r.version,
    enabled: r.enabled,
    deleted: !!r.deleted_at,
  });
}
export async function createProductRule(a: Actor, input: z.input<typeof productRuleCreate>) {
  const b = productRuleCreate.parse(input),
    hash = productRuleHash(b);
  return tenantTx(a.tenantId, async (c) => {
    await lock(c, a.tenantId);
    await admin(c, a);
    if(extendedRules([{definition:b.definition}]))await assertProductRulePriceTagsInTx(c);
    const old = (await c.query('SELECT * FROM product_rules WHERE client_key=$1', [b.client_key]))
      .rows[0];
    if (old) {
      ensure(old.request_hash === hash, 409, 'Klucz żądania użyty dla innej reguły');
      return old;
    }
    ensure(
      !b.definition.enabled || b.confirm_future_changes,
      422,
      'Włączenie wymaga zgody na przyszłe zmiany produktów',
    );
    if (b.definition.enabled) await activeBudget(c);
    const r = (
      await c.query(
        'INSERT INTO product_rules(id,tenant_id,name,event,enabled,definition,approved_by,approved_at,client_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $5 THEN now() END,$8,$9) RETURNING *',
        [
          randomUUID(),
          a.tenantId,
          b.definition.name,
          b.definition.event,
          b.definition.enabled,
          JSON.stringify(b.definition),
          a.userId,
          b.client_key,
          hash,
        ],
      )
    ).rows[0];
    await revision(c, a, r);
    return r;
  });
}
export async function updateProductRule(
  a: Actor,
  id: string,
  input: z.input<typeof productRuleUpdate>,
) {
  z.uuid().parse(id);
  const b = productRuleUpdate.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await lock(c, a.tenantId);
    await admin(c, a);
    if(extendedRules([{definition:b.definition}]))await assertProductRulePriceTagsInTx(c);
    const old = (await c.query('SELECT * FROM product_rules WHERE id=$1 FOR UPDATE', [id])).rows[0];
    ensure(old && !old.deleted_at, 404, 'Nie znaleziono aktywnej definicji reguły');
    ensure(old.version === b.version, 409, 'Reguła zmieniła się');
    ensure(
      !b.definition.enabled || b.confirm_future_changes,
      422,
      'Włączenie lub zmiana aktywnej reguły wymaga zgody na przyszłe zmiany',
    );
    if (b.definition.enabled) await activeBudget(c, id);
    const r = (
      await c.query(
        'UPDATE product_rules SET name=$2,event=$3,enabled=$4,definition=$5,version=version+1,approved_by=$6,approved_at=CASE WHEN $4 THEN now() END,updated_at=now() WHERE id=$1 RETURNING *',
        [
          id,
          b.definition.name,
          b.definition.event,
          b.definition.enabled,
          JSON.stringify(b.definition),
          a.userId,
        ],
      )
    ).rows[0];
    await revision(c, a, r);
    return r;
  });
}
export async function disableProductRule(a: Actor, id: string, version: number) {
  z.uuid().parse(id);
  z.number().int().positive().parse(version);
  return tenantTx(a.tenantId, async (c) => {
    await lock(c, a.tenantId);
    await admin(c, a);
    const old = (await c.query('SELECT * FROM product_rules WHERE id=$1 FOR UPDATE', [id])).rows[0];
    ensure(old, 404, 'Nie znaleziono reguły');
    if (old.deleted_at) {
      ensure(old.version === version + 1, 409, 'Reguła zmieniła się');
      return old;
    }
    ensure(old.version === version, 409, 'Reguła zmieniła się');
    const r = (
      await c.query(
        "UPDATE product_rules SET enabled=false,definition=jsonb_set(definition,'{enabled}','false'),deleted_at=now(),version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
    await revision(c, a, r);
    return r;
  });
}
export async function listProductRules(a: Actor, after?: string) {
  if (after) z.uuid().parse(after);
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const data = (
      await c.query(
        'SELECT * FROM product_rules WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 51',
        [after ?? null],
      )
    ).rows;
    const more = data.length > 50;
    if (more) data.pop();
    return { data, meta: { cursor: more ? data.at(-1).id : null } };
  });
}
async function freezeRules(
  c: PoolClient,
  ids: string[],
  event: string,
  deferredOwners?: FrozenRule[],
) {
  const rows = (
    await c.query('SELECT * FROM product_rules WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [
      ids,
    ])
  ).rows;
  ensure(
    rows.length === ids.length &&
      rows.every(
        (r) =>
          r.enabled &&
          r.approved_at &&
          !r.deleted_at &&
          r.event === event &&
          r.definition.enabled === true &&
          r.definition.event === r.event,
      ),
    409,
    'Reguła jest niedostępna, wyłączona lub ma inne zdarzenie',
  );
  const frozen: FrozenRule[] = rows.map((r) => ({
    id: r.id,
    version: r.version,
    approved_by: r.approved_by,
    definition: productRuleDefinition.parse(r.definition),
  }));
  frozen.sort((a, b) => a.definition.priority - b.definition.priority || a.id.localeCompare(b.id));
  if (deferredOwners) deferredOwners.push(...frozen);
  else await owners(c, frozen);
  return frozen;
}
async function verifyRules(c: PoolClient, run: any, deferredOwners?: FrozenRule[]) {
  const current = await freezeRules(
    c,
    run.rules.map((r: FrozenRule) => r.id),
    run.event,
    deferredOwners,
  );
  ensure(
    productRuleHash(current) === productRuleHash(run.rules),
    409,
    'Reguły zmieniły się po podglądzie',
  );
}
async function items(c: PoolClient, id: string) {
  return (await c.query('SELECT * FROM product_rule_items WHERE run_id=$1 ORDER BY position', [id]))
    .rows;
}
async function getRun(c: PoolClient, id: string) {
  const r = (await c.query('SELECT * FROM product_rule_runs WHERE id=$1', [id])).rows[0];
  ensure(r, 404, 'Nie znaleziono wykonania');
  return r;
}
function extendedRules(rules:readonly {definition:Definition}[]){return rules.some(r=>r.definition.conditions.some(c=>c.field==='tag')||r.definition.actions.some(a=>'tags' in a||'price_list_id' in a));}
async function ruleExtensions(c:PoolClient,rules:FrozenRule[],ids:string[],writing=false){
  const tags=rules.some(r=>r.definition.conditions.some(x=>x.field==='tag')||r.definition.actions.some(x=>'tags' in x));
  const lists=[...new Set(rules.flatMap(r=>r.definition.actions.flatMap(a=>'price_list_id' in a?[a.price_list_id]:[])))].sort();
  if(tags||lists.length)await assertProductRulePriceTagsInTx(c);
  const prices=lists.length?await productRulePriceFramesInTx(c,lists,[...ids].sort(),writing):new Map<string,Record<string,unknown>>();
  return (id:string)=>({tags,prices:prices.get(id)});
}
async function buildRun(
  c: PoolClient,
  a: Actor,
  b: z.infer<typeof productRulePreview>,
  origin: 'manual' | 'catalog',
  cause?: string,
  sourceEvents?: ProductRuleSourceEvent[],
  deferredOwners?: FrozenRule[],
) {
  const hash = productRuleHash({
    b,
    origin,
    cause: cause ?? null,
    ...(sourceEvents ? { sourceEvents } : {}),
  });
  const prior = (
    await c.query('SELECT * FROM product_rule_runs WHERE client_key=$1', [b.client_key])
  ).rows[0];
  if (prior) {
    ensure(prior.request_hash === hash, 409, 'Klucz użyty dla innego podglądu');
    return { ...prior, items: await items(c, prior.id), reused: true };
  }
  const rules = await freezeRules(c, b.rule_ids, b.event, deferredOwners);
  const extensions=await ruleExtensions(c,rules,b.items.map(i=>i.product_id));
  const products = (
    await c.query('SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
      b.items.map((i) => i.product_id),
    ])
  ).rows;
  ensure(products.length === b.items.length, 404, 'Co najmniej jeden produkt nie należy do firmy');
  await assertProductsNotDeletedInTx(c, products.map((p) => p.id));
  const frozen = b.items.map((i, position) => {
    const p = products.find((p) => p.id === i.product_id);
    ensure(p.version === i.version, 409, 'Produkt zmienił się przed podglądem');
    const source = sourceOf(p,extensions(p.id));
    return {
      position,
      product_id: p.id,
      source_version: p.version,
      source_hash: productRuleHash(source),
      source,
      ...projectProductRules(source, rules),
    };
  });
  const scopeHash = productRuleHash({
    event: b.event,
    rules,
    items: frozen,
    ...(sourceEvents ? { sourceEvents } : {}),
  });
  const id = randomUUID(),
    run = (
      await c.query(
        'INSERT INTO product_rule_runs(id,tenant_id,actor_id,event,origin,cause_id,client_key,request_hash,scope_hash,rules) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [
          id,
          a.tenantId,
          a.userId,
          b.event,
          origin,
          cause ?? null,
          b.client_key,
          hash,
          scopeHash,
          JSON.stringify(rules),
        ],
      )
    ).rows[0];
  for (const i of frozen)
    await c.query(
      'INSERT INTO product_rule_items(tenant_id,run_id,position,product_id,source_version,source_hash,source,projected,matched_rules) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        a.tenantId,
        id,
        i.position,
        i.product_id,
        i.source_version,
        i.source_hash,
        JSON.stringify(i.source),
        JSON.stringify(i.projected),
        JSON.stringify(i.matched_rules),
      ],
    );
  await audit(c, a, 'product.rules.preview', id, {
    origin,
    products: frozen.length,
    scope_hash: scopeHash,
  });
  return { ...run, items: await items(c, id), reused: false };
}
export async function previewProductRules(a: Actor, input: z.input<typeof productRulePreview>) {
  const b = productRulePreview.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await lock(c, a.tenantId);
    await admin(c, a);
    return buildRun(c, a, b, 'manual');
  });
}
async function verifyProducts(c: PoolClient, run: any,writing=false) {
  const frozen = await items(c, run.id);
  const extensions=await ruleExtensions(c,run.rules,frozen.map(i=>i.product_id),writing);
  ensure(frozen.length > 0 && frozen.length <= 100, 409, 'Nieprawidłowa paczka produktów');
  const rows = (
    await c.query('SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
      frozen.map((i) => i.product_id),
    ])
  ).rows;
  ensure(rows.length === frozen.length, 409, 'Produkt z podglądu nie istnieje');
  for (const i of frozen) {
    const p = rows.find((p) => p.id === i.product_id);
    ensure(
      p.version === i.source_version && productRuleHash(sourceOf(p,extensions(p.id))) === i.source_hash,
      409,
      'Produkt zmienił się po podglądzie',
    );
    const projected = projectProductRules(sourceOf(p,extensions(p.id)), run.rules);
    ensure(
      productRuleHash(projected) ===
        productRuleHash({ projected: i.projected, matched_rules: i.matched_rules }),
      409,
      'Wynik reguł nie odpowiada podglądowi',
    );
  }
  return frozen;
}
async function queueInTx(
  c: PoolClient,
  a: Actor,
  run: any,
  consent: unknown,
  automatic = false,
  deferredOwners?: FrozenRule[],
) {
  if (run.state !== 'preview') {
    ensure(run.job_id, 409, 'Wykonanie nie ma zadania');
    return { id: run.id, job_id: run.job_id, state: run.state, reused: true };
  }
  ensure(new Date(run.expires_at).getTime() > Date.now(), 409, 'Podgląd wygasł');
  await verifyRules(c, run, deferredOwners);
  await verifyProducts(c, run);
  ensure(
    (await c.query("SELECT count(*)::int n FROM product_rule_runs WHERE state='queued'")).rows[0]
      .n < 100,
    409,
    'Limit 100 aktywnych wykonań produktów',
  );
  const job = randomUUID();
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5)', [
    job,
    a.tenantId,
    PRODUCT_RULE_JOB,
    JSON.stringify({ run_id: run.id }),
    'product.rules:' + run.id,
  ]);
  await c.query(
    "UPDATE product_rule_runs SET state='queued',job_id=$2,consent=$3,queued_actor=$4,queued_at=now() WHERE id=$1",
    [run.id, job, JSON.stringify(consent), automatic ? null : a.userId],
  );
  await audit(c, a, 'product.rules.queue', run.id, { automatic, scope_hash: run.scope_hash });
  return { id: run.id, job_id: job, state: 'queued', reused: false };
}
export async function queueProductRules(
  a: Actor,
  id: string,
  input: z.infer<typeof productRuleConsent>,
) {
  z.uuid().parse(id);
  const b = productRuleConsent.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await lock(c, a.tenantId);
    await admin(c, a);
    const r = await getRun(c, id);
    ensure(
      r.origin === 'manual' && r.scope_hash === b.scope_hash,
      409,
      'Zgoda dotyczy innego zakresu wykonania',
    );
    return queueInTx(c, a, r, b);
  });
}
export async function productRuleRunDetail(a: Actor, id: string) {
  z.uuid().parse(id);
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    const run=await getRun(c,id);
    const children=(await c.query("SELECT to_regclass('public.product_rule_price_executions') present")).rows[0].present?(await c.query('SELECT price_list_id,preview_id,execution_id FROM product_rule_price_executions WHERE run_id=$1 ORDER BY price_list_id',[id])).rows:[];
    await admin(c,a);
    return { ...run, items: await items(c, id), price_executions:children };
  });
}
export async function productRuleHistory(a: Actor, after?: string) {
  if (after) z.uuid().parse(after);
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    if (after) await getRun(c, after);
    const data = (
      await c.query(
        `SELECT r.id,r.event,r.origin,r.state,r.scope_hash,r.actor_id,r.queued_actor,r.error,r.result,r.created_at,r.finished_at,(SELECT count(*)::int FROM product_rule_items i WHERE i.run_id=r.id) product_count
      FROM product_rule_runs r WHERE ($1::uuid IS NULL OR (r.created_at,r.id)<(SELECT created_at,id FROM product_rule_runs WHERE id=$1)) ORDER BY r.created_at DESC,r.id DESC LIMIT 51`,
        [after ?? null],
      )
    ).rows;
    const more = data.length > 50;
    if (more) data.pop();
    return { data, meta: { cursor: more ? data.at(-1).id : null } };
  });
}
export async function processProductRuleJob(job: any) {
  ensure(job.kind === PRODUCT_RULE_JOB, 422, 'Nieprawidłowy rodzaj zadania');
  z.uuid().parse(job.id);
  z.uuid().parse(job.tenant_id);
  z.uuid().parse(job.lease_token);
  return tenantTx(job.tenant_id, async (c) => {
    await lock(c, job.tenant_id);
    const j = (
      await c.query(
        "SELECT * FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rows[0];
    if (!j) return { processed: false };
    ensure(
      j.kind === PRODUCT_RULE_JOB && productRuleHash(j.payload) === productRuleHash(job.payload),
      409,
      'Zadanie zmieniło się',
    );
    const run = await getRun(c, z.strictObject({ run_id: z.uuid() }).parse(j.payload).run_id);
    ensure(run.job_id === j.id && run.state === 'queued', 409, 'Wykonanie nie odpowiada zadaniu');
    const a: Actor = {
      tenantId: job.tenant_id,
      userId: run.queued_actor ?? run.actor_id,
      role: 'admin',
    };
    await c.query('SAVEPOINT product_rules_apply');
    try {
      if (run.origin === 'manual') {
        await admin(c, a);
        productRuleConsent.parse(run.consent);
        ensure(run.consent.scope_hash === run.scope_hash, 409, 'Brak zgody na zakres');
      } else
        ensure(
          run.consent?.kind === 'approved_future_changes' &&
            run.consent?.scope_hash === run.scope_hash,
          409,
          'Brak zgody reguł na przyszłe zmiany',
        );
      await verifyRules(c, run);
      const rows = await verifyProducts(c, run,true);
      const priceActor:Actor=run.origin==='manual'?a:{...a,userId:[...new Set<string>(run.rules.map((r:FrozenRule)=>r.approved_by))].sort()[0]!,role:'admin'};
      const priceExecutions=await executeProductRulePricesInTx(c,priceActor,run,rows);
      let changed = 0;
      for (const i of rows) {
        const differs =
          productRuleHash({ category: i.source.category, attributes: i.source.attributes,...(i.source.tags===undefined?{}:{tags:i.source.tags}) }) !==
          productRuleHash({category:i.projected.category,attributes:i.projected.attributes,...(i.projected.tags===undefined?{}:{tags:i.projected.tags})});
        const priceChanged=Object.entries(i.projected.price_targets??{}).some(([id,value])=>(!i.source.price_targets[id].snapshot.override_present||i.source.price_targets[id].snapshot.override_price!==value));
        let version = i.source_version;
        if (differs) {
          const saved = (
            await c.query(
              'UPDATE products SET category=$2,attributes=$3,version=version+1'+(i.projected.tags===undefined?'':',tags=$5')+' WHERE id=$1 AND version=$4 RETURNING version',
              [
                i.product_id,
                i.projected.category,
                JSON.stringify(i.projected.attributes),
                i.source_version,
                ...(i.projected.tags===undefined?[]:[i.projected.tags]),
              ],
            )
          ).rows[0];
          ensure(saved, 409, 'Produkt zmienił się podczas wykonania');
          version = saved.version;
        }
        if(differs||priceChanged)changed++;
        await c.query(
          'UPDATE product_rule_items SET state=$3,result_version=$4,finished_at=now() WHERE run_id=$1 AND product_id=$2',
          [run.id, i.product_id, differs||priceChanged ? 'changed' : 'skipped', version],
        );
        await audit(c, a, 'product.rules.apply', i.product_id, {
          run_id: run.id,
          origin: 'product.rules',
          source_version: i.source_version,
          result_version: version,
          changed: differs||priceChanged,
          matched_rules: i.matched_rules,
          before: { category: i.source.category, attributes: i.source.attributes,...(i.source.tags===undefined?{}:{tags:i.source.tags}),...(i.source.price_targets===undefined?{}:{price_targets:i.source.price_targets}) },
          after: i.projected,
        });
      }
      await c.query(
        "UPDATE product_rule_runs SET state='done',finished_at=now(),result=$2 WHERE id=$1",
        [
          run.id,
          JSON.stringify({ products: rows.length, changed, skipped: rows.length - changed,price_executions:priceExecutions }),
        ],
      );
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
        [j.id],
      );
      await owners(c,run.rules);
      if(run.origin==='manual')await admin(c,a);
      if(extendedRules(run.rules))await pinProductRulePriceTagsInTx(c,priceActor,run);
      await (await import('./product-rule-schedules')).pinProductRuleScheduleInTx(c,run.id);
      await c.query('RELEASE SAVEPOINT product_rules_apply');
      return { processed: true, state: 'done', changed };
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT product_rules_apply');
      await c.query('RELEASE SAVEPOINT product_rules_apply');
      if (!(e instanceof Problem) && !(e instanceof z.ZodError)) throw e;
      const error = e instanceof Problem ? e.message : 'Nieprawidłowe dane reguły lub produktu';
      await c.query(
        "UPDATE product_rule_items SET state='failed',error=$2,finished_at=now() WHERE run_id=$1 AND state='pending'",
        [run.id, error],
      );
      await c.query(
        "UPDATE product_rule_runs SET state='failed',error=$2,finished_at=now(),result=$3 WHERE id=$1",
        [run.id, error, JSON.stringify({ changed: 0, rolled_back: true })],
      );
      await audit(c, a, 'product.rules.failed', run.id, { error, changed: 0, rolled_back: true });
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=$2 WHERE id=$1",
        [j.id, error],
      );
      return { processed: true, state: 'failed', changed: 0 };
    }
  });
}
// Call after the shared worker's failed-job recovery, including lease exhaustion.
// A local transaction has either committed all actions or rolled them all back;
// failed generic jobs can therefore close the queued run without replaying actions.
export async function reapProductRuleJobs() {
  const candidates = (
    await pool.query(`SELECT j.id,j.tenant_id FROM jobs j JOIN product_rule_runs r ON (r.tenant_id,r.job_id)=(j.tenant_id,j.id)
    WHERE j.kind='product.rules' AND j.state='failed' AND r.state='queued' ORDER BY j.created_at,j.id LIMIT 25`)
  ).rows;
  let failed = 0;
  for (const candidate of candidates) {
    failed += await tenantTx(candidate.tenant_id, async (c) => {
      await lock(c, candidate.tenant_id);
      const j = (
        await c.query(
          "SELECT * FROM jobs WHERE id=$1 AND kind='product.rules' AND state='failed' FOR UPDATE",
          [candidate.id],
        )
      ).rows[0];
      if (!j) return 0;
      const r = (
        await c.query(
          "SELECT * FROM product_rule_runs WHERE job_id=$1 AND state='queued' FOR UPDATE",
          [j.id],
        )
      ).rows[0];
      if (!r) return 0;
      const error =
        'Zadanie zakończono po wyczerpaniu prób; zmiany produktów nie zostały zatwierdzone';
      await c.query(
        "UPDATE product_rule_items SET state='failed',error=$2,finished_at=now() WHERE run_id=$1 AND state='pending'",
        [r.id, error],
      );
      await c.query(
        "UPDATE product_rule_runs SET state='failed',error=$2,finished_at=now(),result=$3 WHERE id=$1",
        [r.id, error, JSON.stringify({ changed: 0, rolled_back: true, job_failed: true })],
      );
      await audit(
        c,
        { tenantId: candidate.tenant_id, userId: r.queued_actor ?? r.actor_id, role: 'admin' },
        'product.rules.failed',
        r.id,
        { changed: 0, job_failed: true },
      );
      return 1;
    });
  }
  return { failed };
}
export async function scheduleProductRulesInTx(
  c: PoolClient,
  a: Actor,
  productId: string,
  event: 'product.created' | 'product.updated',
  cause: { origin: 'catalog' | 'product.rules'; cause_id: string },
) {
  z.uuid().parse(productId);
  z.enum(['product.created', 'product.updated']).parse(event);
  z.strictObject({ origin: z.enum(['catalog', 'product.rules']), cause_id: z.uuid() }).parse(cause);
  if (cause.origin === 'product.rules') return { suppressed: true };
  const result = await scheduleProductRuleBatchInTx(c, a, [
    { product_id: productId, event, cause_id: cause.cause_id },
  ]);
  return result.runs[0] ?? { scheduled: false };
}

// Caller owns the source transaction. Failures must roll it back; no source writes
// or individual groups may be committed after swallowing an admission conflict.
export async function scheduleProductRuleBatchInTx(
  c: PoolClient,
  a: Actor,
  input: ProductRuleSourceEvent[],
  options: { origin: 'catalog' | 'product.rules' } = { origin: 'catalog' },
) {
  return scheduleProductRuleBatchCoreInTx(c, a, input, options);
}

/**
 * A source import can finalize its immutable evidence and force deferred FK
 * checks before approved rule owners are pinned. Owner admission always runs
 * here; callers cannot accidentally omit it. The caller then checks its own
 * fresh write grant and commits the same transaction.
 */
export async function scheduleProductRuleBatchAndFinalizeInTx<T>(
  c: PoolClient,
  a: Actor,
  input: ProductRuleSourceEvent[],
  finalize: (rules: Awaited<ReturnType<typeof scheduleProductRuleBatchCoreInTx>>) => Promise<T>,
): Promise<T> {
  const deferredOwners: FrozenRule[] = [];
  const result = await scheduleProductRuleBatchCoreInTx(
    c,
    a,
    input,
    { origin: 'catalog' },
    deferredOwners,
  );
  const output = await finalize(result);
  await owners(c, deferredOwners);
  return output;
}

async function scheduleProductRuleBatchCoreInTx(
  c: PoolClient,
  a: Actor,
  input: ProductRuleSourceEvent[],
  options: { origin: 'catalog' | 'product.rules' },
  deferredOwners?: FrozenRule[],
) {
  const events = z.array(productSourceEvent).max(500).parse(input);
  z.strictObject({ origin: z.enum(['catalog', 'product.rules']) }).parse(options);
  const result = {
    runs: [] as { id: string; job_id: string; state: string; reused: boolean }[],
    scheduled: 0,
    reused: 0,
    suppressed: options.origin === 'product.rules' ? events.length : 0,
    unmatched: 0,
  };
  if (!events.length || options.origin === 'product.rules') return result;
  const unique = new Map<string, ProductRuleSourceEvent>();
  for (const e of events) {
    const old = unique.get(e.cause_id);
    ensure(
      !old || (old.product_id === e.product_id && old.event === e.event),
      409,
      'Zdarzenie użyte dla innego produktu',
    );
    unique.set(e.cause_id, e);
  }
  await lock(c, a.tenantId);
  const causes = [...unique.keys()];
  // Index lookups only, including legacy singleton runs whose consent predates
  // source_events. Do not scan historical JSON on each source product mutation.
  const previous = (
    await c.query(
      `WITH ids AS (
         SELECT run_id id FROM product_rule_causes WHERE cause_id=ANY($1::uuid[])
         UNION SELECT id FROM product_rule_runs WHERE origin='catalog' AND cause_id=ANY($1::uuid[]) AND NOT coalesce(consent ? 'source_events',false)
       ) SELECT r.id,r.job_id,r.state,r.event,r.cause_id,r.consent,
       (SELECT jsonb_agg(jsonb_build_object('product_id',i.product_id)) FROM product_rule_items i WHERE i.run_id=r.id) source_items,
       (SELECT jsonb_agg(jsonb_build_object('cause_id',k.cause_id,'product_id',k.product_id,'event',k.event)) FROM product_rule_causes k WHERE k.run_id=r.id AND k.cause_id=ANY($1::uuid[])) matched_causes
       FROM ids JOIN product_rule_runs r ON r.id=ids.id ORDER BY r.id LIMIT 501`,
      [causes],
    )
  ).rows;
  ensure(previous.length <= 500, 409, 'Niejednoznaczna historia zdarzenia produktu');
  const seen = new Map<string, any>();
  for (const run of previous) {
    const stored = run.consent?.source_events
      ? z.array(productSourceEvent).min(1).max(100).parse(run.consent.source_events)
      : [
          {
            cause_id: run.cause_id,
            event: run.event,
            product_id: run.source_items?.length === 1 ? run.source_items[0].product_id : null,
          },
        ];
    for (const e of stored) {
      if (!unique.has(e.cause_id)) continue;
      const requested = unique.get(e.cause_id)!;
      ensure(
        e.product_id === requested.product_id &&
          e.event === requested.event &&
          run.event === e.event &&
          run.source_items?.some((i: any) => i.product_id === e.product_id) &&
          (!run.consent?.source_events ||
            run.matched_causes?.some(
              (k: any) =>
                k.cause_id === e.cause_id && k.product_id === e.product_id && k.event === e.event,
            )) &&
          !seen.has(e.cause_id),
        409,
        'Zdarzenie użyte dla innego produktu lub ma niejednoznaczną historię',
      );
      ensure(run.job_id, 409, 'Zdarzenie nie ma trwałego zadania');
      seen.set(e.cause_id, run);
      result.reused++;
    }
  }
  for (const run of new Map([...seen.values()].map((r) => [r.id, r])).values())
    result.runs.push({ id: run.id, job_id: run.job_id, state: run.state, reused: true });
  const fresh = [...unique.values()].filter((e) => !seen.has(e.cause_id));
  const perProduct = new Set<string>();
  for (const e of fresh) {
    const key = `${e.event}:${e.product_id}`;
    ensure(!perProduct.has(key), 422, 'Wiele nowych zdarzeń tej samej wersji produktu');
    perProduct.add(key);
  }
  const groups: {
    event: ProductRuleSourceEvent['event'];
    ruleIds: string[];
    events: ProductRuleSourceEvent[];
    products: any[];
  }[] = [];
  for (const event of ['product.created', 'product.updated'] as const) {
    const selected = fresh
      .filter((e) => e.event === event)
      .sort((a, b) => (a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0));
    if (!selected.length) continue;
    const rules = (
      await c.query(
        'SELECT id FROM product_rules WHERE enabled AND event=$1 ORDER BY id LIMIT 101',
        [event],
      )
    ).rows;
    ensure(rules.length <= 100, 409, 'Limit 100 aktywnych reguł');
    if (!rules.length) {
      result.unmatched += selected.length;
      continue;
    }
    const ruleIds = rules.map((r) => r.id),
      frozen = await freezeRules(c, ruleIds, event, deferredOwners);
    const extensions=await ruleExtensions(c,frozen,selected.map(e=>e.product_id));
    const products = (
      await c.query('SELECT * FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
        selected.map((e) => e.product_id),
      ])
    ).rows;
    ensure(
      products.length === selected.length,
      404,
      'Co najmniej jeden produkt nie należy do firmy',
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    const matching = selected.filter(
      (e) => projectProductRules(sourceOf(byId.get(e.product_id),extensions(e.product_id)), frozen).matched_rules.length,
    );
    result.unmatched += selected.length - matching.length;
    for (let offset = 0; offset < matching.length; offset += 100) {
      const chunk = matching.slice(offset, offset + 100);
      groups.push({
        event,
        ruleIds,
        events: chunk,
        products: chunk.map((e) => byId.get(e.product_id)),
      });
    }
  }
  if (groups.length)
    ensure(
      (await c.query("SELECT count(*)::int n FROM product_rule_runs WHERE state='queued'")).rows[0]
        .n +
        groups.length <=
        100,
      409,
      'Limit 100 aktywnych wykonań produktów',
    );
  for (const group of groups) {
    // Group UUID is derived from its exact causes; singleton identity stays
    // compatible with the old indexed cause_id contract.
    const h = productRuleHash(group.events),
      cause =
        group.events.length === 1
          ? group.events[0].cause_id
          : `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    const run = await buildRun(
      c,
      a,
      productRulePreview.parse({
        client_key: randomUUID(),
        event: group.event,
        rule_ids: group.ruleIds,
        items: group.products.map((p) => ({ product_id: p.id, version: p.version })),
      }),
      'catalog',
      cause,
      group.events,
      deferredOwners,
    );
    const queued = await queueInTx(
      c,
      a,
      run,
      { kind: 'approved_future_changes', scope_hash: run.scope_hash, source_events: group.events },
      true,
      deferredOwners,
    );
    await c.query(
      'INSERT INTO product_rule_causes(tenant_id,run_id,cause_id,product_id,event) SELECT $1,$2,cause_id,product_id,event FROM jsonb_to_recordset($3::jsonb) x(cause_id uuid,product_id uuid,event text)',
      [a.tenantId, run.id, JSON.stringify(group.events)],
    );
    result.runs.push(queued);
    result.scheduled += group.events.length;
  }
  return result;
}

/** Same actual writer for recurring approval. Caller holds catalog ancestor. */
export async function previewProductRulesInTx(c:PoolClient,a:Actor,input:z.input<typeof productRulePreview>){
  await lock(c,a.tenantId);await admin(c,a);return buildRun(c,a,productRulePreview.parse(input),'manual');
}
export async function verifyProductRuleSchedulePreviewInTx(c:PoolClient,a:Actor,id:string){
  await lock(c,a.tenantId);await admin(c,a);const run=await getRun(c,id);ensure(run.state==='preview',409,'Podgląd został użyty');await verifyRules(c,run);return {...run,items:await verifyProducts(c,run)};
}
export async function enqueueProductRuleScheduleInTx(c:PoolClient,a:Actor,input:z.input<typeof productRulePreview>){
  const run=await previewProductRulesInTx(c,a,input);
  return {...await queueInTx(c,a,run,{confirmed:true,scope_hash:run.scope_hash}),scope_hash:run.scope_hash};
}
