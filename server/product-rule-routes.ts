import { tenantTx } from './db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import {
  createProductRule,
  updateProductRule,
  disableProductRule,
  listProductRules,
  previewProductRules,
  queueProductRules,
  productRuleRunDetail,
  productRuleHistory,
  productRuleCreate,
  productRuleUpdate,
  productRulePreview,
  productRuleConsent,
} from './product-rules';
export function registerProductRuleRoutes(
  app: FastifyInstance,
  opts: { available: boolean; readOnly: boolean },
) {
  const available = () => ensure(opts.available, 503, 'Kopia nie zawiera automatyzacji produktów');
  const writable = () => {
    available();
    ensure(!opts.readOnly, 423, 'Zmiany reguł i produkty są wyłączone w podglądzie kopii');
  };
  const id = (p: unknown) => z.strictObject({ id: z.uuid() }).parse(p).id;
  app.get('/api/product-rules', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagany administrator');
    if (!opts.available) return { available: false, read_only: opts.readOnly, data: [] };
    return {
      available: true,
      read_only: opts.readOnly,
      price_tags_available: await tenantTx(req.actor.tenantId, async c=>{const m=(await c.query("SELECT to_regprocedure('public.product_rule_price_tags_guards()') p")).rows[0].p;return !!m&&!!(await c.query('SELECT product_rule_price_tags_guards() ok')).rows[0].ok;}),
      ...(await listProductRules(
        req.actor,
        z.strictObject({ after: z.uuid().optional() }).parse(req.query).after,
      )),
    };
  });
  app.post('/api/product-rules', (req) => {
    writable();
    return createProductRule(req.actor, productRuleCreate.parse(req.body));
  });
  app.put('/api/product-rules/:id', (req) => {
    writable();
    return updateProductRule(req.actor, id(req.params), productRuleUpdate.parse(req.body));
  });
  app.delete('/api/product-rules/:id', (req) => {
    writable();
    return disableProductRule(
      req.actor,
      id(req.params),
      z.strictObject({ version: z.number().int().positive() }).parse(req.body).version,
    );
  });
  app.post('/api/product-rule-runs/preview', (req) => {
    writable();
    return previewProductRules(req.actor, productRulePreview.parse(req.body));
  });
  app.post('/api/product-rule-runs/:id/queue', (req) => {
    writable();
    return queueProductRules(req.actor, id(req.params), productRuleConsent.parse(req.body));
  });
  app.get('/api/product-rule-runs', (req) => {
    available();
    return productRuleHistory(
      req.actor,
      z.strictObject({ after: z.uuid().optional() }).parse(req.query).after,
    );
  });
  app.get('/api/product-rule-runs/:id', (req) => {
    available();
    return productRuleRunDetail(req.actor, id(req.params));
  });
}
