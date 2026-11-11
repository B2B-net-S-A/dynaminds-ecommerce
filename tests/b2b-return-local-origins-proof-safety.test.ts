import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, tenantTx } from '../server/db';
import { receiveInput, receiveReturn } from '../server/returns';
import {
  createMixedHarness, freshMixedFixture, requestMixedReturn, localBody, localReceive,
  prefix, type Harness,
} from './b2b-return-local-origins-fixture';

let h: Harness;
before(async () => { h = await createMixedHarness(); });
after(async () => { if (h) await h.close(); else await pool.end(); });

test('the genuine local receipt finish rejects an additional own RMA-bound WMS operation in both OFF and ON, preserving the whole business snapshot', async () => {
  for (const on of [false, true]) {
    const f = await freshMixedFixture(h, on), r = await requestMixedReturn(f);
    const selected = await f.ok(prefix + '/returns/' + r.id + '/local-origin', 'POST', await localBody(f, r));
    const body = receiveInput.parse(await localReceive(f, await f.ok('/returns/' + r.id), selected.origin));
    const before = await f.snapshot();
    let injected = false, reachedFinish = false;
    let finishSqlCode: string | undefined;
    let finishSqlMessage: string | undefined;
    const expectedMessage = on ? 'Dodatkowa lub niezatwierdzona operacja lokalnego WMS'
      : 'WMS OFF lub odbiór bez stanu zmienił lokalne dowody partii';
    await assert.rejects(tenantTx(f.buyer.tenant, async (c) => {
      // This adapter intercepts only the final SQL call; the core executes every
      // authentic stock/bin/journal/WMS mutation and computes the actual credit.
      const originalQuery = c.query;
      const query = originalQuery.bind(c) as any;
      c.query = (async (...args: any[]) => {
        const finishing = typeof args[0] === 'string' && /^SELECT b2b_return_local_finish\(/i.test(args[0]);
        if (finishing) {
          assert.equal(injected, false);
          const head = (await query('SELECT state,refund_amount,received_at FROM return_cases WHERE tenant_id=$1 AND id=$2', [f.buyer.tenant,r.id])).rows[0];
          assert.equal(head.state, 'refund_pending'); assert.equal(head.refund_amount, 2500); assert(head.received_at);
          assert.equal((await query('SELECT on_hand FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [f.buyer.tenant,f.buyer.warehouse,f.product.id])).rows[0].on_hand, 5);
          assert.equal((await query("SELECT sum(delta)::int quantity FROM stock_movements WHERE tenant_id=$1 AND return_id=$2 AND kind='return'", [f.buyer.tenant,r.id])).rows[0].quantity, 1);
          assert.equal((await query('SELECT count(*)::int count FROM wms_operations WHERE tenant_id=$1 AND return_id=$2', [f.buyer.tenant,r.id])).rows[0].count, on ? 1 : 0);
          // All FK references are genuine and own. This is an extra bookkeeping
          // operation, with no fragment or movement that could justify it.
          const extra = await query(`INSERT INTO wms_operations
            (id,tenant_id,actor_id,client_key,request_hash,kind,source,policy_version,order_id,return_id,request,result)
            VALUES($1,$2,$3,$4,$5,'bin_move','manual',1,$6,$7,'{}','{}')`,
            [randomUUID(),f.buyer.tenant,f.buyer.user,randomUUID(),'0'.repeat(64),f.order.id,r.id]);
          assert.equal(extra.rowCount, 1); injected = true; reachedFinish = true;
        }
        try { return await query(...args); }
        catch (error) {
          if (finishing) {
            finishSqlCode = (error as { code?: string }).code;
            finishSqlMessage = (error as Error).message;
          }
          throw error;
        }
      }) as typeof c.query;
      try {
        await receiveReturn(c, { tenantId: f.buyer.tenant, userId: f.buyer.user, role: 'admin' }, r.id, body);
      } finally { c.query = originalQuery; }
    }, { purchasingAdmission: true }), (error: any) => error.status === 409
      && finishSqlCode === '23514' && finishSqlMessage === expectedMessage);
    assert.equal(injected && reachedFinish, true, 'The genuine receipt reached the actual finish with its extra operation present');
    assert.equal(finishSqlCode, '23514');
    assert.equal(finishSqlMessage, expectedMessage);
    assert.deepEqual(await f.snapshot(), before);
  }
});
