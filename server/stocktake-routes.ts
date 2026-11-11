import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTx } from './db';
import {
  stocktakeInput,
  stocktakeVersion,
  stocktakePost,
  stocktakeCount,
  stocktakePage,
  stocktakeHeader,
  stocktakeDetail,
  createStocktake,
  countStocktake,
  transitionStocktake,
} from './stocktakes';
export function registerStocktakeRoutes(app: FastifyInstance) {
  const id = (v: unknown) => z.object({ id: z.uuid() }).parse(v).id;
  app.get('/api/stocktakes', (req) => {
    const q = stocktakePage.extend({ warehouse_id: z.uuid().optional() }).parse(req.query);
    return tenantTx(req.actor.tenantId, async (c) => {
      const rows = (
        await c.query(
          `SELECT t.*,w.name AS warehouse_name FROM stocktakes t JOIN warehouses w ON (w.tenant_id,w.id)=(t.tenant_id,t.warehouse_id) WHERE ($1::uuid IS NULL OR t.warehouse_id=$1) AND ($2::uuid IS NULL OR (t.created_at,t.id)<(SELECT created_at,id FROM stocktakes WHERE id=$2)) ORDER BY t.created_at DESC,t.id DESC LIMIT $3`,
          [q.warehouse_id ?? null, q.after ?? null, q.limit + 1],
        )
      ).rows;
      return {
        data: rows.slice(0, q.limit),
        meta: { cursor: rows.length > q.limit ? rows[q.limit - 1].id : null },
      };
    });
  });
  app.post('/api/stocktakes', (req) =>
    tenantTx(req.actor.tenantId, (c) =>
      createStocktake(c, req.actor, stocktakeInput.parse(req.body)),
    ),
  );
  app.get('/api/stocktakes/:id', (req) =>
    tenantTx(req.actor.tenantId, (c) =>
      stocktakeDetail(c, req.actor, id(req.params), stocktakePage.parse(req.query)),
    ),
  );
  app.post('/api/stocktakes/:id/counts', (req) =>
    tenantTx(req.actor.tenantId, (c) =>
      countStocktake(
        c,
        req.actor,
        id(req.params),
        stocktakeCount.parse(req.body),
        req.currentUser.name,
      ),
    ),
  );
  for (const action of ['review', 'reopen', 'cancel', 'post'] as const)
    app.post('/api/stocktakes/:id/' + action, (req) =>
      tenantTx(req.actor.tenantId, (c) =>
        transitionStocktake(
          c,
          req.actor,
          id(req.params),
          (action === 'post' ? stocktakePost : stocktakeVersion).parse(req.body),
          action,
        ),
      ),
    );
  app.get('/api/stocktakes/:id/measurements', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      const sid = id(req.params),
        q = stocktakePage.parse(req.query);
      await stocktakeHeader(c, sid);
      const rows = (
        await c.query(
          `SELECT m.*,coalesce((SELECT jsonb_agg(v.value||jsonb_build_object('sku',l.sku,'location',l.location) ORDER BY v.ordinality) FROM jsonb_array_elements(m.inputs) WITH ORDINALITY v(value,ordinality) JOIN stocktake_lines l ON l.stocktake_id=m.stocktake_id AND l.id=(v.value->>'id')::uuid),'[]'::jsonb) AS display_inputs FROM stocktake_measurements m WHERE m.stocktake_id=$1 AND ($2::uuid IS NULL OR (m.created_at,m.id)<(SELECT created_at,id FROM stocktake_measurements WHERE id=$2 AND stocktake_id=$1)) ORDER BY m.created_at DESC,m.id DESC LIMIT $3`,
          [sid, q.after ?? null, q.limit + 1],
        )
      ).rows;
      return {
        data: rows.slice(0, q.limit).map(({ input_hash, ...r }) => {
          // Scan-linked quantity measurements retain a private physical-basis hash
          // for their immutable SQL guard. The legacy read route must not expose it.
          if (!Array.isArray(r.result?.lines)) return r;
          return {
            ...r,
            result: {
              ...r.result,
              lines: r.result.lines.map((line: unknown) => {
                if (!line || typeof line !== 'object' || Array.isArray(line)) return line;
                const { basis_hash, ...publicLine } = line as Record<string, unknown>;
                return publicLine;
              }),
            },
          };
        }),
        meta: { cursor: rows.length > q.limit ? rows[q.limit - 1].id : null },
      };
    }),
  );
}
