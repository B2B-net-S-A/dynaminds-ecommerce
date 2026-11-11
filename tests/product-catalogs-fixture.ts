import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../server/db';
import { returnAssistantFixture } from './return-assistant-fixture';

/** Genuine OFF/ON commerce and issued RMA; catalog settings never seed stock directly. */
export async function productCatalogFixture(app: FastifyInstance, on = false) {
  const f = await returnAssistantFixture(app, on);
  const list = await f.ok('/price-lists', 'POST', { name: 'Own catalog PLN ' + randomUUID(), currency: 'PLN' }, 201);
  const spare = await f.ok('/warehouses', 'POST', { name: 'Own empty catalog warehouse', code: 'PC-' + randomUUID().slice(0, 8) });
  const request = (path: string, method: any = 'GET', body?: any, key?: any) => app.inject({
    url: '/api' + (key ? '/v1' : '') + path, method, payload: body,
    headers: { ...(key ? { authorization: 'Bearer ' + key.token } : { cookie: f.cookie }),
      ...(path === '/orders' && method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) }, remoteAddress: '127.157.0.1',
  });
  const ok = async (path: string, method: any = 'GET', body?: any, status = 200, key?: any): Promise<any> => {
    const reply = await request(path, method, body, key);
    assert.equal(reply.statusCode, status, method + ' ' + path);
    return reply.json();
  };
  const defaultCatalog = (await pool.query('SELECT * FROM product_catalogs WHERE tenant_id=$1 AND is_default', [f.tenant])).rows[0];
  assert(defaultCatalog, 'New own tenant must receive its default catalog');
  return { ...f, list, spare, defaultCatalog, request, ok };
}
export async function productCatalogFacts(tenant: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names: string[] = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns x WHERE x.table_schema=t.table_schema AND x.table_name=t.table_name AND x.column_name='tenant_id') ORDER BY 1")).rows.map(r => r.table_name);
    const result: Record<string, any[]> = {};
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      result[name] = (await c.query(`SELECT to_jsonb(x) row FROM "${name}" x WHERE tenant_id=$1 ORDER BY 1`, [tenant])).rows;
    }
    await c.query('COMMIT'); return result;
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
export const productCatalogSettings = (f: any, extra: any = {}) => ({
  name: 'Own independent catalog ' + randomUUID().slice(0, 8), active: true,
  languages: ['pl', 'en'], default_language: 'pl',
  warehouse_ids: [f.spare.id], price_list_ids: [f.list.id], ...extra,
});
export const productCatalogCreate = (f: any, extra: any = {}) => ({
  client_key: randomUUID(), kind: 'create', settings: productCatalogSettings(f, extra),
});
export const productCatalogConsent = (preview: any) => ({ client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true });
