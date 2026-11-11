import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, tenantTx } from '../server/db';
import { networkTx, networkScope } from '../server/b2b-network';
import { wmsLotsHash } from '../server/wms-lots';
import { tokenHash } from '../server/security';
import {
  b2bDropshipReturnReceiveInput,
  b2bDropshipReturnReconcileInput,
} from '../server/b2b-dropshipping-returns-schema';
import {
  createReturnHarness,
  freshReturnFixture,
  requestRetail,
  sourcePreview,
  submitReturn,
  submitBody,
  supplierCase,
  receiveBody,
  reconcileBody,
  returnBase,
  waitForLock,
  type Harness,
  type Row,
  type ReturnFixture,
} from './b2b-dropshipping-returns-fixture';

let h: Harness;
before(async () => {
  h = await createReturnHarness();
});

test('raw dyna_app receive with exact consent, receipt and wholesale credit cannot certify stock, bin, journal or WMS effects that never happened', async () => {
  const f = await freshReturnFixture(h, true),
    { retail, c } = await forwarded(f),
    current = await supplierCase(f, c.id),
    input = b2bDropshipReturnReceiveInput.parse(await receiveBody(f, current, 1)),
    actionId = randomUUID();
  assert.equal(input.items.length, 1);
  assert.equal(input.items[0].accepted, 1);
  assert.equal(input.items[0].restocked, 1);
  const receipt = {
    version: input.supplier_return_version,
    shipping_refund: input.shipping_refund_minor,
    note: input.note,
    items: input.items.map((item) => ({
      item_id: item.supplier_item_id,
      accepted: item.accepted,
      restocked: item.restocked,
    })),
    wms_lots: input.wms_lots,
  };
  const requestHash = wmsLotsHash({
    tenant_id: f.supplier.tenant,
    actor_id: f.supplier.user,
    api_key_id: null,
    kind: 'receive',
    parent: c.id,
    body: input,
  });
  const before = await f.snapshot();
  let prepared = false,
    forgedRows = false,
    finishReached = false;
  await assert.rejects(
    tenantTx(
      f.supplier.tenant,
      async (client) => {
        const proof = (
          await client.query("SELECT b2b_dropship_return_prepare($1,$2,$3,NULL,'receive',$4) id", [
            c.id,
            actionId,
            f.supplier.user,
            input,
          ])
        ).rows[0].id;
        assert(proof);
        prepared = true;
        assert.equal(
          (
            await client.query(
              'UPDATE return_items SET accepted=1,restocked=1,refund_amount=700 WHERE tenant_id=$1 AND return_id=$2 AND item_id=$3',
              [f.supplier.tenant, current.supplier_return_id, input.items[0].supplier_item_id],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await client.query(
              "UPDATE return_cases r SET state='refund_pending',received_at=clock_timestamp(),receipt=$3,receipt_sequence=(SELECT coalesce(max(other.receipt_sequence),0)+1 FROM return_cases other WHERE other.tenant_id=r.tenant_id AND other.order_id=r.order_id AND other.id<>r.id),refunded_shipping=0,refund_amount=700,decision_note=$4,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
              [f.supplier.tenant, current.supplier_return_id, receipt, input.note],
            )
          ).rowCount,
          1,
        );
        await client.query(
          "INSERT INTO b2b_dropship_return_actions(id,tenant_id,actor_id,client_key,kind,case_id,return_id,request_hash,request,result) VALUES($1,$2,$3,$4,'receive',$5,$6,$7,$8,$9)",
          [
            actionId,
            f.supplier.tenant,
            f.supplier.user,
            input.client_key,
            c.id,
            retail.id,
            requestHash,
            input,
            { case_id: c.id },
          ],
        );
        forgedRows = true;
        finishReached = true;
        await client.query('SELECT b2b_dropship_return_finish($1)', [proof]);
        assert.fail('A forged receipt must not certify a physical supplier return');
      },
      { purchasingAdmission: true },
    ),
    (error: any) =>
      error.code === '23514' &&
      /Brak rzeczywistego (przywrócenia stanu dostawcy|przyjęcia w lokacjach lub dzienniku)|Brak rzeczywistych fragmentów przyjęcia WMS/.test(
        error.message,
      ),
  );
  assert.equal(prepared && forgedRows && finishReached, true);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
  assert.equal((await f.stock()).on_hand, 17);
});

test('raw dyna_app retail credit after a genuine supplier receipt cannot replace the private apply_partner witness or create partner acceptance', async () => {
  const f = await freshReturnFixture(h, true),
    { retail, c } = await forwarded(f),
    current = await supplierCase(f, c.id);
  await f.ok(
    returnBase + '/cases/' + c.id + '/receive',
    'POST',
    await receiveBody(f, current, 1),
    f.supplier.cookie,
  );
  const received = await supplierCase(f, c.id),
    input = b2bDropshipReturnReconcileInput.parse(await reconcileBody(f, retail, received)),
    actionId = randomUUID();
  assert.equal(input.items.length, 1);
  assert.equal(input.items[0].accepted, 1);
  const requestHash = wmsLotsHash({
    tenant_id: f.buyer.tenant,
    actor_id: f.buyer.user,
    api_key_id: null,
    kind: 'reconcile',
    parent: retail.id,
    body: input,
  });
  const before = await f.snapshot();
  let prepared = false,
    forgedRows = false,
    finishReached = false;
  await assert.rejects(
    tenantTx(
      f.buyer.tenant,
      async (client) => {
        const proof = (
          await client.query(
            "SELECT b2b_dropship_return_prepare($1,$2,$3,NULL,'reconcile',$4) id",
            [c.id, actionId, f.buyer.user, input],
          )
        ).rows[0].id;
        assert(proof);
        prepared = true;
        assert.equal(
          (
            await client.query(
              'UPDATE return_items SET accepted=1,restocked=0,refund_amount=1000 WHERE tenant_id=$1 AND return_id=$2 AND item_id=$3',
              [f.buyer.tenant, retail.id, input.items[0].customer_item_id],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await client.query(
              "UPDATE return_cases r SET state='refund_pending',receipt_sequence=(SELECT coalesce(max(other.receipt_sequence),0)+1 FROM return_cases other WHERE other.tenant_id=r.tenant_id AND other.order_id=r.order_id AND other.id<>r.id),refunded_shipping=0,refund_amount=1000,decision_note=$3,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
              [f.buyer.tenant, retail.id, input.note],
            )
          ).rowCount,
          1,
        );
        await client.query(
          "INSERT INTO b2b_dropship_return_actions(id,tenant_id,actor_id,client_key,kind,return_id,request_hash,request,result) VALUES($1,$2,$3,$4,'reconcile',$5,$6,$7,$8)",
          [
            actionId,
            f.buyer.tenant,
            f.buyer.user,
            input.client_key,
            retail.id,
            requestHash,
            input,
            { return_id: retail.id, case_ids: [c.id] },
          ],
        );
        forgedRows = true;
        assert.equal(
          (await client.query('SELECT b2b_dropship_return_acceptance($1) acceptance', [retail.id]))
            .rows[0].acceptance,
          null,
        );
        finishReached = true;
        await client.query('SELECT b2b_dropship_return_finish($1)', [proof]);
        assert.fail('Direct retail writes must not replace apply_partner');
      },
      { purchasingAdmission: true },
    ),
    (error: any) =>
      error.code === '23514' && /Brak wyprowadzonej decyzji partnerowej/.test(error.message),
  );
  assert.equal(prepared && forgedRows && finishReached, true);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(
    await tenantTx(
      f.buyer.tenant,
      async (client) =>
        (await client.query('SELECT b2b_dropship_return_acceptance($1) acceptance', [retail.id]))
          .rows[0].acceptance,
    ),
    null,
  );
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
  assert.equal((await f.stock()).on_hand, 18);
});
after(async () => {
  if (h) await h.close();
  else await pool.end();
});
const readScopes = ['products:read', 'inventory:read', 'orders:read', 'purchasing:read'];
const writeScopes = [...readScopes, 'inventory:write', 'orders:write', 'purchasing:write'];
const publicRequest = (
  f: ReturnFixture,
  token: string,
  path: string,
  method: any = 'GET',
  payload?: any,
  supplier = false,
) =>
  h.app.inject({
    url: '/api/v1' + path,
    method,
    payload,
    headers: {
      authorization: 'Bearer ' + token,
      'X-Workspace-ID': supplier ? f.supplier.tenant : f.buyer.tenant,
    },
  });
async function business(f: ReturnFixture) {
  const all = await f.snapshot();
  // These are the intentional IAM fixture mutations, not effects of a refused business operation.
  const { memberships, api_keys, workspace_usage, ...protectedRows } = all;
  return protectedRows;
}
function noStore(response: Row) {
  assert.match(String(response.headers['cache-control']), /no-store/);
}
async function mintKey(f: ReturnFixture, name: string, scopes: string[], supplier = false) {
  const actor = supplier ? f.supplier : f.buyer;
  const credential = await f.ok(
    '/developer/keys',
    'POST',
    { name, scopes, expires_days: 30 },
    actor.cookie,
  );
  assert(/^dyna_api_[a-f0-9]{64}$/.test(credential.token), 'Mint returned a valid API token');
  assert(Number.isFinite(Date.parse(credential.expires_at)), 'Mint returned an expiry timestamp');
  const { valid } = (
    await pool.query(
      "SELECT EXISTS(SELECT 1 FROM api_keys k JOIN memberships m ON(m.tenant_id,m.user_id)=(k.tenant_id,k.user_id) WHERE k.id=$1 AND k.tenant_id=$2 AND k.user_id=$3 AND k.token_hash=$4 AND k.revoked_at IS NULL AND k.expires_at>clock_timestamp() AND k.scopes=$5::text[] AND m.role='admin') valid",
      [credential.id, actor.tenant, actor.user, tokenHash(credential.token), scopes],
    )
  ).rows[0];
  assert.equal(
    valid,
    true,
    'The genuine minted key has current own membership, hash, scopes and expiry',
  );
  return credential;
}
async function forwarded(f: ReturnFixture) {
  const retail = await requestRetail(f),
    { preview } = await sourcePreview(f, retail);
  const c = (await submitReturn(f, preview)).cases[0];
  return { retail, preview, c };
}

test('raw bind refuses four committed supplier units despite valid initial RMA identities and the exact own causal order revision after a three-unit dispatch', async () => {
  const f = await freshReturnFixture(h),
    retail = await requestRetail(f),
    { preview } = await sourcePreview(f, retail);
  const sold = (
    await pool.query('SELECT * FROM order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY id', [
      f.supplier.tenant,
      f.forwarded.supplier_order_id,
    ])
  ).rows;
  assert.equal(sold.length, 1);
  assert.equal(sold[0].quantity, 3);
  const supplierVersion = (
    await pool.query('SELECT version::text FROM orders WHERE tenant_id=$1 AND id=$2', [
      f.supplier.tenant,
      f.forwarded.supplier_order_id,
    ])
  ).rows[0].version;
  const before = await f.snapshot(),
    competingReturnId = randomUUID(),
    newReturnId = randomUUID(),
    newCaseId = randomUUID(),
    request = {
      client_key: randomUUID(),
      kind: 'return',
      reason: 'Zwrot klienta przez własną sieć B2B',
      warehouse_id: f.supplier.warehouse,
      shipping_refund: 0,
      items: [{ item_id: sold[0].id, quantity: 1 }],
    };
  let rmaCreated = false,
    bindReached = false;
  await assert.rejects(
    networkTx(f.buyer.tenant, async (client) => {
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      await networkScope(client, f.supplier.tenant);
      // Both are raw application attacks derived from real sold metadata. Neither
      // invokes requestReturn's remaining-quantity check or its order update.
      // The private INSERT witness must still capture the genuine frozen header.
      for (const candidate of [
        { id: competingReturnId, quantity: 3, submittedBy: 'operator' },
        { id: newReturnId, quantity: 1, submittedBy: 'buyer' },
      ]) {
        const body = {
          ...request,
          client_key: candidate.id === newReturnId ? request.client_key : randomUUID(),
          items: [{ item_id: sold[0].id, quantity: candidate.quantity }],
        };
        assert.equal(
          (
            await client.query(
              "INSERT INTO return_cases(id,tenant_id,order_id,warehouse_id,number,kind,reason,legacy,client_key,request,requested_shipping,submitted_by) VALUES($1,$2,$3,$4,$5,'return',$6,false,$7,$8,0,$9)",
              [
                candidate.id,
                f.supplier.tenant,
                f.forwarded.supplier_order_id,
                f.supplier.warehouse,
                'RMA-OWN128-' + randomUUID(),
                body.reason,
                body.client_key,
                body,
                candidate.submittedBy,
              ],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await client.query(
              "INSERT INTO return_items(tenant_id,order_id,return_id,item_id,sku,name,components,requested) SELECT tenant_id,order_id,$3,id,sku,name,CASE WHEN jsonb_array_length(components)>0 THEN components ELSE jsonb_build_array(jsonb_build_object('product_id',product_id,'quantity',1)) END,$4 FROM order_items WHERE tenant_id=$1 AND id=$2",
              [f.supplier.tenant, sold[0].id, candidate.id, candidate.quantity],
            )
          ).rowCount,
          1,
        );
      }
      assert.equal(
        (
          await client.query(
            'SELECT sum(requested)::text quantity FROM return_items WHERE tenant_id=$1 AND return_id=ANY($2::uuid[])',
            [f.supplier.tenant, [competingReturnId, newReturnId]],
          )
        ).rows[0].quantity,
        '4',
      );
      // Reproduce only the coordinated request's own causal update. A genuine
      // ordinary HTTP request here would also bump version and test stale CAS.
      const causal = await client.query(
        'UPDATE orders SET updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING version::text',
        [f.supplier.tenant, f.forwarded.supplier_order_id],
      );
      assert.equal(causal.rowCount, 1);
      assert.equal(causal.rows[0].version, (BigInt(supplierVersion) + 1n).toString());
      rmaCreated = true;
      await networkScope(client, f.buyer.tenant);
      bindReached = true;
      await client.query('SELECT b2b_dropship_return_bind($1,$2,$3,$4,NULL)', [
        preview.id,
        newCaseId,
        newReturnId,
        f.buyer.user,
      ]);
      assert.fail(
        'A genuine INSERT witness cannot admit a fourth supplier unit after three are already committed',
      );
    }),
    (error: any) =>
      error.code === '23514' &&
      error.message === 'Przekazanie przekracza bieżącą dostępną ilość dostawcy',
  );
  assert.equal(rmaCreated && bindReached, true);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
  assert.deepEqual(await f.stock(), { on_hand: 17, reserved: 0, available: 17 });
});

test('strict source/body/foreign identities refuse before any paired RMA or quantity reservation; exact preview retry retains its approved snapshot', async () => {
  const f = await freshReturnFixture(h),
    retail = await requestRetail(f);
  const { preview, body } = await sourcePreview(f, retail),
    foreign = await freshReturnFixture(h);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    f.buyer.tenant,
    f.supplier.user,
  ]);
  const switched = await f.request(
    '/workspaces/switch',
    'POST',
    { tenant_id: f.buyer.tenant },
    f.supplier.cookie,
  );
  assert.equal(switched.statusCode, 200, switched.body);
  const otherActorCookie = String(switched.headers['set-cookie']).split(';')[0];
  const before = await f.snapshot();
  const invalid = [
    { ...body, receiver: { name: 'Arbitrary customer' } },
    { ...body, items: [{ ...body.items[0], quantity: 0 }] },
    { ...body, items: [{ ...body.items[0], physical_sources: [] }] },
    { ...body, items: [body.items[0], body.items[0]] },
    {
      ...body,
      items: [
        {
          ...body.items[0],
          physical_sources: [{ ...body.items[0].physical_sources[0], quantity: 0 }],
        },
      ],
    },
  ];
  for (const input of invalid) {
    const response = await f.request(returnBase + '/returns/' + retail.id + '/previews', 'POST', {
      ...input,
      client_key: randomUUID(),
    });
    assert.equal(response.statusCode, 422, response.body);
    noStore(response);
    assert.deepEqual(await f.snapshot(), before);
  }
  const forged = await f.request(returnBase + '/returns/' + retail.id + '/previews', 'POST', {
    ...body,
    client_key: randomUUID(),
    items: [{ ...body.items[0], customer_item_id: foreign.cheap.id }],
  });
  assert.equal(forged.statusCode, 422, forged.body);
  noStore(forged);
  assert.deepEqual(await f.snapshot(), before);
  const otherBody = await f.request(returnBase + '/returns/' + retail.id + '/previews', 'POST', {
    ...body,
    version: body.version + 1,
  });
  assert.equal(otherBody.statusCode, 409, otherBody.body);
  const replay = await f.ok(returnBase + '/returns/' + retail.id + '/previews', 'POST', body);
  assert.equal(replay.reused, true);
  assert.equal(replay.preview.id, preview.id);
  const otherActor = await f.request(
    returnBase + '/returns/' + retail.id + '/previews',
    'POST',
    body,
    otherActorCookie,
  );
  assert.equal(otherActor.statusCode, 409, otherActor.body);
  assert.deepEqual(await f.snapshot(), before);
  const hidden = await foreign.request(returnBase + '/previews/' + preview.id);
  assert.equal(hidden.statusCode, 404);
  noStore(hidden);
});

test('eight coordinated evidence tables FORCE RLS, private proof access, immutable rows and genuine foreign warehouse FK protect linked history', async () => {
  const f = await freshReturnFixture(h),
    { retail, preview, c } = await forwarded(f);
  const tables = [
    'b2b_dropship_return_settings',
    'b2b_dropship_return_previews',
    'b2b_dropship_return_cases',
    'b2b_dropship_return_lines',
    'b2b_dropship_return_supplier_cases',
    'b2b_dropship_return_actions',
    'b2b_dropship_return_proofs',
    'b2b_dropship_return_created_cases',
  ];
  const flags = (
    await pool.query(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1::text[])",
      [tables],
    )
  ).rows;
  assert.equal(flags.length, tables.length);
  assert(flags.every((r) => r.relrowsecurity && r.relforcerowsecurity));
  await tenantTx(f.buyer.tenant, async (client) => {
    assert.equal(
      (await client.query('SELECT id FROM b2b_dropship_return_cases WHERE id=$1', [c.id])).rowCount,
      1,
    );
    assert.equal(
      (
        await client.query(
          'SELECT return_id FROM b2b_dropship_return_supplier_cases WHERE case_id=$1',
          [c.id],
        )
      ).rowCount,
      0,
    );
  });
  for (const table of ['b2b_dropship_return_proofs', 'b2b_dropship_return_created_cases'])
    await assert.rejects(
      tenantTx(f.buyer.tenant, (client) => client.query(`SELECT * FROM ${table}`)),
      (error: any) => error.code === '42501',
    );
  const noScope = await pool.connect();
  try {
    await noScope.query('BEGIN');
    await noScope.query('SET LOCAL ROLE dyna_app');
    await noScope.query("SELECT set_config('app.tenant_id','',true)");
    const hidden = (
      await noScope.query(
        'SELECT b2b_dropship_return_pair($1) pair,b2b_dropship_return_case_state($1) state',
        [c.id],
      )
    ).rows[0];
    assert.equal(hidden.pair, null);
    assert.equal(
      hidden.state,
      null,
      'A SECURITY DEFINER read must fail closed without an actual tenant',
    );
  } finally {
    await noScope.query('ROLLBACK');
    noScope.release();
  }
  const before = await f.snapshot();
  await assert.rejects(
    pool.query('UPDATE b2b_dropship_return_previews SET scope_hash=$2 WHERE id=$1', [
      preview.id,
      '0'.repeat(64),
    ]),
    (error: any) => error.code === '23514',
  );
  await assert.rejects(
    pool.query('DELETE FROM b2b_dropship_return_lines WHERE tenant_id=$1 AND case_id=$2', [
      f.buyer.tenant,
      c.id,
    ]),
    (error: any) => error.code === '23514',
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(
      client.query(
        'UPDATE b2b_dropship_return_settings SET warehouse_id=$3,version=version+1,return_address=$4 WHERE tenant_id=$1 AND account_id=$2',
        [
          f.supplier.tenant,
          f.accountId,
          f.buyer.warehouse,
          {
            name: 'Own128 supplier',
            street: 'Own128 1',
            city: 'Warszawa',
            postal_code: '00-001',
            country: 'PL',
          },
        ],
      ),
      (error: any) => error.code === '23503',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const forged = await pool.connect();
  try {
    await forged.query('BEGIN');
    await forged.query('SET LOCAL ROLE dyna_app');
    await forged.query("SELECT set_config('app.tenant_id',$1,true)", [f.buyer.tenant]);
    const request = {
      client_key: randomUUID(),
      version: Number(retail.version),
      case_versions: [{ id: c.id, version: c.version }],
      items: [{ customer_item_id: f.cheap.id, accepted: 1 }],
      shipping_refund_minor: 0,
      note: 'Own128 forged public action without private proof',
      confirmed: true,
    };
    const requestHash = wmsLotsHash({
      tenant_id: f.buyer.tenant,
      actor_id: f.buyer.user,
      api_key_id: null,
      kind: 'reconcile',
      parent: retail.id,
      body: request,
    });
    await assert.rejects(
      async () => {
        await forged.query(
          "INSERT INTO b2b_dropship_return_actions(id,tenant_id,actor_id,client_key,kind,case_id,return_id,request_hash,request,result) VALUES($1,$2,$3,$4,'reconcile',$5,$6,$7,$8,$9)",
          [
            randomUUID(),
            f.buyer.tenant,
            f.buyer.user,
            request.client_key,
            c.id,
            retail.id,
            requestHash,
            request,
            { case_ids: [c.id], accepted: 1, refund_amount: 1000 },
          ],
        );
        assert.equal(
          (await forged.query('SELECT b2b_dropship_return_acceptance($1) proof', [retail.id]))
            .rows[0].proof,
          null,
        );
        await forged.query('SET CONSTRAINTS ALL IMMEDIATE');
      },
      (error: any) => error.code === '23514',
    );
  } finally {
    await forged.query('ROLLBACK');
    forged.release();
  }
  assert.deepEqual(await f.snapshot(), before);
});

test('actual submit lock wait observes buyer administrator withdrawal and atomically rolls back supplier RMA, bridge, actions and audits', async () => {
  const f = await freshReturnFixture(h),
    retail = await requestRetail(f),
    { preview } = await sourcePreview(f, retail);
  const before = await business(f),
    holder = await pool.connect();
  let pending: ReturnType<ReturnFixture['request']> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM return_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      f.buyer.tenant,
      retail.id,
    ]);
    pending = f.request(
      returnBase + '/previews/' + preview.id + '/submit',
      'POST',
      submitBody(preview),
    );
    await waitForLock(holder, /return_cases/i);
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      f.buyer.tenant,
      f.buyer.user,
    ]);
    await holder.query('ROLLBACK');
    const response = await pending;
    assert.equal(response.statusCode, 403, response.body);
    noStore(response);
    assert.deepEqual(await business(f), before);
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    holder.release();
    await pending?.catch(() => {});
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      f.buyer.tenant,
      f.buyer.user,
    ]);
  }
});

test('supplier receive after a genuine RMA lock wait rechecks revocation, expiry and compound write scopes with zero stock or retail effects', async () => {
  const f = await freshReturnFixture(h, true),
    { c } = await forwarded(f);
  for (const mutation of ['revoke', 'expiry', 'scope'] as const) {
    const credential = await mintKey(f, 'Own128 late ' + mutation, writeScopes, true);
    const freshRead = await publicRequest(
      f,
      credential.token,
      returnBase + '/cases/' + c.id,
      'GET',
      undefined,
      true,
    );
    assert.equal(freshRead.statusCode, 200, freshRead.body);
    noStore(freshRead);
    const current = await supplierCase(f, c.id),
      body = await receiveBody(f, current),
      before = await business(f);
    const holder = await pool.connect();
    let pending: ReturnType<typeof publicRequest> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM return_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        f.supplier.tenant,
        current.supplier_return_id,
      ]);
      pending = publicRequest(
        f,
        credential.token,
        returnBase + '/cases/' + c.id + '/receive',
        'POST',
        body,
        true,
      );
      // The SD function locks our held RMA; pg_stat_activity exposes its outer SELECT.
      await waitForLock(holder, /b2b_dropship_return_prepare/i);
      await pool.query(
        mutation === 'revoke'
          ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
          : mutation === 'expiry'
            ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
            : 'UPDATE api_keys SET scopes=$2::text[] WHERE id=$1',
        mutation === 'scope'
          ? [credential.id, writeScopes.filter((s) => s !== 'inventory:write')]
          : [credential.id],
      );
      await holder.query('ROLLBACK');
      const response = await pending;
      assert.equal(response.statusCode, mutation === 'scope' ? 403 : 401, response.body);
      noStore(response);
      assert.deepEqual(await business(f), before);
      assert.deepEqual(await f.stock(), { on_hand: 17, reserved: 0, available: 17 });
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
      await pending?.catch(() => {});
    }
  }
});

function assertQuantityProjection(value: any) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(
      ![
        'refund_amount',
        'refund_minor',
        'retail_refund_minor',
        'wholesale_refund_minor',
        'retail_line_total_minor',
        'supplier_shipping_refund_minor',
        'shipping_refund_available_minor',
        'unit_cost_minor',
        'value_minor',
        'line_total',
        'price',
      ].includes(key),
      'Quantity-only payload exposed ' + key,
    );
    assertQuantityProjection(child);
  }
}
test('viewer and read key get deeply redacted context, sources, preview rows, case history and events; mutations require full current grants', async () => {
  const f = await freshReturnFixture(h),
    { retail, preview, c } = await forwarded(f);
  const reader = await mintKey(
    f,
    'Own128 quantity reader',
    readScopes.filter((s) => s !== 'purchasing:read'),
  );
  const routes = [
    returnBase + '/returns/' + retail.id + '/context',
    returnBase + '/returns/' + retail.id + '/sources',
    returnBase + '/previews/' + preview.id,
    returnBase + '/previews/' + preview.id + '/rows',
    returnBase + '/cases?side=buyer',
    returnBase + '/cases/' + c.id,
    returnBase + '/cases/' + c.id + '/rows',
    returnBase + '/cases/' + c.id + '/events',
  ];
  const before = await business(f);
  // Exercise this freshly minted key before demotion, which permanently revokes all of its owner's keys.
  for (const path of routes) {
    const response = await publicRequest(f, reader.token, path);
    assert.equal(response.statusCode, 200, response.body);
    noStore(response);
    assert.equal(response.json().can_read_value, false);
    assertQuantityProjection(response.json());
  }
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    f.buyer.tenant,
    f.buyer.user,
  ]);
  try {
    for (const path of routes) {
      const response = await f.request(path);
      assert.equal(response.statusCode, 200, response.body);
      noStore(response);
      assert.equal(response.json().can_read_value, false);
      assertQuantityProjection(response.json());
    }
    const denied = await f.request(returnBase + '/cases/' + c.id + '/withdraw', 'POST', {
      client_key: randomUUID(),
      version: c.version,
      reason: 'Own128 viewer must not mutate',
      confirmed: true,
    });
    assert.equal(denied.statusCode, 403);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      f.buyer.tenant,
      f.buyer.user,
    ]);
  }
  assert.deepEqual(await business(f), before);
});

test('bound supplier ordinary receive and buyer phantom restock cannot bypass coordination; received case body collisions and overacceptance leave both firms unchanged', async () => {
  const f = await freshReturnFixture(h),
    { retail, c } = await forwarded(f),
    current = await supplierCase(f, c.id),
    before = await f.snapshot();
  const ordinary = await f.request(
    '/returns/' + current.supplier_return_id + '/receive',
    'POST',
    {
      version: current.supplier_return_version,
      note: 'Own128 bypass attempt',
      items: current.supplier_items.map((i: Row) => ({
        item_id: i.supplier_item_id,
        accepted: 1,
        restocked: 1,
      })),
    },
    f.supplier.cookie,
  );
  assert.equal(ordinary.statusCode, 409, ordinary.body);
  const phantom = await f.request('/returns/' + retail.id + '/receive', 'POST', {
    version: retail.version,
    note: 'Own128 buyer phantom receipt',
    items: [{ item_id: f.cheap.id, accepted: 1, restocked: 1 }],
  });
  assert.equal(phantom.statusCode, 409, phantom.body);
  const body = await receiveBody(f, current);
  const excess = await f.request(
    returnBase + '/cases/' + c.id + '/receive',
    'POST',
    {
      ...body,
      items: body.items.map((i: Row) => ({
        ...i,
        accepted: i.accepted + 1,
        restocked: i.restocked + 1,
      })),
    },
    f.supplier.cookie,
  );
  assert.equal(excess.statusCode, 422, excess.body);
  assert.deepEqual(await f.snapshot(), before);
  await f.ok(returnBase + '/cases/' + c.id + '/receive', 'POST', body, f.supplier.cookie);
  const after = await f.snapshot();
  const changed = await f.request(
    returnBase + '/cases/' + c.id + '/receive',
    'POST',
    { ...body, note: 'Own128 same key different request' },
    f.supplier.cookie,
  );
  assert.equal(changed.statusCode, 409, changed.body);
  assert.deepEqual(await f.snapshot(), after);
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
});

test('read-only copy projections remain readable and every coordinated malformed write is423 before parsing with no stock or proof effects', async () => {
  const f = await freshReturnFixture(h),
    { retail, preview, c } = await forwarded(f);
  const readonly = await buildApp({ readOnly: true });
  try {
    const mainCookie = await readonly.inject({
      url: '/api' + returnBase + '/cases/' + c.id,
      headers: { cookie: f.buyer.cookie },
    });
    assert.equal(mainCookie.statusCode, 401);
    const login = await readonly.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'other@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const switchWorkspace = await readonly.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: f.buyer.tenant },
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0] },
    });
    assert.equal(switchWorkspace.statusCode, 200, switchWorkspace.body);
    const cookie = String(switchWorkspace.headers['set-cookie']).split(';')[0];
    const response = await readonly.inject({
      url: '/api' + returnBase + '/cases/' + c.id,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().read_only, true);
    assert.equal(response.json().can_manage, false);
    const before = await f.snapshot();
    const writes: Array<[string, string]> = [
      [returnBase + '/settings/' + f.accountId, 'PATCH'],
      [returnBase + '/returns/' + retail.id + '/previews', 'POST'],
      [returnBase + '/previews/' + preview.id + '/submit', 'POST'],
      [returnBase + '/cases/' + c.id + '/receive', 'POST'],
      [returnBase + '/cases/' + c.id + '/decision', 'POST'],
      [returnBase + '/cases/' + c.id + '/withdraw', 'POST'],
      [returnBase + '/returns/' + retail.id + '/reconcile', 'POST'],
    ];
    for (const [path, method] of writes) {
      const r = await readonly.inject({
        url: '/api' + path,
        method: method as any,
        headers: { cookie, 'content-type': 'application/json' },
        payload: '{',
      });
      assert.equal(r.statusCode, 423, r.body);
      noStore(r);
    }
    assert.deepEqual(await f.snapshot(), before);
  } finally {
    await readonly.close();
  }
  let older: Awaited<ReturnType<typeof buildApp>> | undefined;
  const originalSupplierCase = await supplierCase(f, c.id);
  const shipmentId = (
    await pool.query('SELECT id FROM shipments WHERE tenant_id=$1 AND order_id=$2', [
      f.supplier.tenant,
      f.forwarded.supplier_order_id,
    ])
  ).rows[0].id;
  await pool.query(
    'ALTER FUNCTION b2b_dropship_return_prepare(uuid,uuid,uuid,uuid,text,jsonb) RENAME TO qa_128_missing_prepare',
  );
  try {
    older = await buildApp();
    const options = await older.inject({
      url: '/api' + returnBase + '/options',
      headers: { cookie: f.buyer.cookie },
    });
    assert.equal(options.statusCode, 200, options.body);
    assert.equal(options.json().available, false);
    const refused = await older.inject({
      url: '/api' + returnBase + '/returns/' + retail.id + '/previews',
      method: 'POST',
      headers: { cookie: f.buyer.cookie },
      payload: {
        client_key: randomUUID(),
        version: Number(retail.version),
        items: [
          {
            customer_item_id: f.cheap.id,
            dropship_order_id: f.forwarded.id,
            quantity: 1,
            physical_sources: [
              {
                supplier_item_id: originalSupplierCase.supplier_items[0].supplier_item_id,
                shipment_id: shipmentId,
                quantity: 1,
              },
            ],
          },
        ],
        confirmed: true,
      },
    });
    assert.equal(refused.statusCode, 503, refused.body);
    noStore(refused);
    const ordinary = await older.inject({
      url: '/api/orders/' + f.forwarded.supplier_order_id + '/returns',
      method: 'POST',
      headers: { cookie: f.supplier.cookie },
      payload: {
        client_key: randomUUID(),
        reason: 'Own128 older copy ordinary RMA remains available',
        items: [{ item_id: originalSupplierCase.supplier_items[0].supplier_item_id, quantity: 1 }],
      },
    });
    assert.equal(ordinary.statusCode, 201, ordinary.body);
    assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
  } finally {
    try {
      await older?.close();
    } finally {
      await pool.query(
        'ALTER FUNCTION qa_128_missing_prepare(uuid,uuid,uuid,uuid,text,jsonb) RENAME TO b2b_dropship_return_prepare',
      );
    }
  }
});
