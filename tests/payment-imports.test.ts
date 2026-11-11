import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { migrate, pool, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, SECOND_TENANT } from './fixtures';
import { decrypt } from '../server/security';
import { registerPaymentImportRoutes } from '../server/payment-import-routes';
import {
  PAYMENT_IMPORT_JOB,
  processPaymentImportJob,
  reapPaymentImportJobs,
  previewPaymentImport,
  uploadPaymentImport,
} from '../server/payment-imports';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(
  new URL(process.env.DATABASE_URL!).pathname,
  /^\/dynaminds_(?:product_rules_)?test_\w+$/,
);
let app: FastifyInstance,
  cookie: string,
  other: string,
  tenant: string,
  warehouse: string,
  user: string,
  product: any;
let clientNumber = 1;
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + url,
    method,
    payload,
    remoteAddress: '127.0.1.' + clientNumber,
    headers: { cookie: auth },
  });
async function ok(url: string, method: any = 'GET', payload?: any, auth = cookie) {
  const r = await req(url, method, payload, auth);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  if (!app.hasRoute({ method: 'GET', url: '/api/payment-imports/profiles' }))
    registerPaymentImportRoutes(app, { available: true, readOnly: false });
  for (const email of ['admin@demo.local', 'other@demo.local']) {
    const r = await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email, password: 'DynaDemo!2026' },
    });
    assert.equal(r.statusCode, 200, r.body);
    const value = String(r.headers['set-cookie']).split(';')[0];
    if (email.startsWith('admin')) cookie = value;
    else other = value;
  }
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  clientNumber++;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'QA bank COD imports','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA finance','FIN')",
    [warehouse, tenant],
  );
  const sw = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(sw.statusCode, 200, sw.body);
  cookie = String(sw.headers['set-cookie']).split(';')[0];
  product = await ok('/products', 'POST', {
    sku: 'FIN-' + randomUUID(),
    name: 'Import finance',
    price: 15000,
    warehouse_id: warehouse,
    quantity: 100,
  });
});
after(async () => {
  await app.close();
  await pool.end();
});
const actor = () => ({ tenantId: tenant, userId: user, role: 'admin' as const });
async function order(mode = 'prepaid') {
  return ok('/orders', 'POST', {
    customer_name: 'QA finance',
    email: 'qa-finance@example.test',
    warehouse_id: warehouse,
    payment_mode: mode,
    items: [{ product_id: product.id, quantity: 1 }],
    address: { street: 'Testowa1', city: 'Warszawa', postal_code: '00-001', phone: '500600700' },
  });
}
async function profile(mode = 'bank_receipt', namespace?: any) {
  const ns =
    namespace ??
    (await ok('/payment-imports/namespaces', 'POST', {
      client_key: randomUUID(),
      label: 'QA bank carrier',
      source_kind: 'shared_settlement',
    }));
  const definition: any = {
    name: 'QA ' + mode,
    source_kind: mode === 'bank_receipt' ? 'bank_statement' : 'carrier_report',
    source_namespace_id: ns.id,
    transaction_id_scope: 'namespace',
    mode,
    encoding: 'utf-8',
    delimiter: ';',
    header: true,
    skip_records: 0,
    decimal_separator: ',',
    grouping_separator: 'none',
    sign: 'credit_positive',
    date_format: 'YYYY-MM-DD',
    fixed_currency: 'PLN',
    columns: {
      transaction_id: { index: 0 },
      booking_date: { index: 1 },
      amount: { index: 2 },
      reference: [{ index: 3 }],
      order_reference: { index: 3 },
    },
    match: { kind: 'order_number', extraction: 'whole_field' },
  };
  if (mode !== 'bank_receipt') {
    definition.columns.tracking_number = { index: 4 };
    definition.match.carrier = 'Symulator lokalny';
  }
  if (mode === 'cod_remittance') definition.columns.fee = { index: 5 };
  const p = await ok('/payment-imports/profiles', 'POST', { client_key: randomUUID(), definition });
  return { ...p, ns };
}
async function preview(p: any, rows: string[], key = randomUUID()) {
  const csv = 'tx;date;amount;order;tracking;fee\n' + rows.join('\n'),
    upload = await ok('/payment-imports/uploads', 'POST', {
      client_key: randomUUID(),
      profile_id: p.id,
      profile_version: p.version,
      filename: 'QA.csv',
      content_base64: Buffer.from(csv).toString('base64'),
    });
  const body = {
    client_key: key,
    file_id: upload.file_id,
    profile_id: p.id,
    profile_version: p.version,
  };
  const head = await ok('/payment-imports/previews', 'POST', body);
  return { ...(await ok('/payment-imports/previews/' + head.id)), body, upload };
}
function line(o: any, tx = 'T-' + randomUUID(), amount = '100,00', tracking = '', fee = '') {
  return `${tx};2026-10-05;${amount};${o.number};${tracking};${fee}`;
}
const queue = (
  p: any,
  rowIds = p.data.filter((r: any) => r.classification === 'ready').map((r: any) => r.row_id),
  key = randomUUID(),
) =>
  ok(`/payment-imports/previews/${p.id}/queue`, 'POST', {
    client_key: key,
    version: p.version,
    row_ids: rowIds,
    scope_hash: p.scope_hash,
    confirmed: true,
    local_ledger_only: true,
  });
async function claim(e: any) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [e.job_id, randomUUID()],
    )
  ).rows[0];
}
async function apply(e: any) {
  const job = await claim(e);
  const r = await processPaymentImportJob(job);
  return { r, job, detail: await ok('/payment-imports/executions/' + e.id) };
}
const balance = (o: any) => ok('/orders/' + o.id + '/payments');
async function paidEntries(o: any) {
  return (await pool.query('SELECT * FROM payment_entries WHERE order_id=$1 ORDER BY id', [o.id]))
    .rows;
}
test('encrypted upload and immutable preview are local; partial bank receipt then explicit distinct transfer pays once, replay is a tombstone', async () => {
  const o = await order(),
    p = await profile(),
    before = await ok('/products/' + product.id);
  const view = await preview(p, [line(o, 'BANK-ONE', '100,00')]);
  assert.equal(view.data[0].classification, 'ready');
  assert.equal((await paidEntries(o)).length, 0);
  assert.equal((await ok('/orders/' + o.id)).status, 'new');
  const f = (
    await pool.query('SELECT * FROM payment_import_files WHERE id=$1', [view.upload.file_id])
  ).rows[0];
  assert(!f.encrypted_bytes.includes(o.number));
  assert.equal(
    Buffer.from(decrypt(f.encrypted_bytes).content_base64, 'base64').length,
    f.byte_count,
  );
  assert.equal((await ok('/payment-imports/previews', 'POST', view.body)).id, view.id);
  const key = randomUUID(),
    e = await queue(view, undefined, key),
    done = await apply(e);
  assert.equal(done.r.state, 'done');
  assert.equal(done.detail.data[0].receipt.after_balance.amount_due, 5000);
  assert.equal(done.detail.data[0].receipt.order_number, o.number);
  assert.equal((await balance(o)).balance.received, 10000);
  assert.equal((await queue(view, undefined, key)).id, e.id);
  assert.deepEqual(await processPaymentImportJob(done.job), { processed: false });
  const second = await preview(p, [line(o, 'BANK-TWO', '50,00')]);
  assert.equal(second.data[0].classification, 'review');
  const resolved = await ok(`/payment-imports/previews/${second.id}/resolve`, 'POST', {
    client_key: randomUUID(),
    version: second.version,
    resolutions: [
      {
        row_id: second.data[0].row_id,
        action: 'assign',
        order_id: o.id,
        reason: 'Potwierdzam drugi odrębny transfer',
      },
    ],
  });
  assert.notEqual(resolved.scope_hash, second.scope_hash);
  const ready = await ok('/payment-imports/previews/' + resolved.id);
  assert.equal(ready.data[0].classification, 'ready');
  await apply(await queue(ready));
  assert.equal((await balance(o)).balance.received, 15000);
  assert.equal((await ok('/orders/' + o.id)).status, 'paid');
  assert.deepEqual(await ok('/products/' + product.id), before);
  const duplicate = await preview(p, [line(o, 'BANK-ONE', '100,00')]);
  assert.equal(duplicate.data[0].classification, 'duplicate');
  assert(duplicate.data[0].evidence.claim.receipt_id);
  assert.equal((await paidEntries(o)).length, 2);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind=$2', [
        tenant,
        PAYMENT_IMPORT_JOB,
      ])
    ).rows[0].n,
    2,
  );
});
test('two selected rows share one baseline and grouped financial totals reject overpayment atomically', async () => {
  const o = await order(),
    p = await profile();
  const bad = await preview(p, [line(o, 'GROUP-A', '100,00'), line(o, 'GROUP-B', '100,00')]);
  assert(bad.data.every((r: any) => r.classification === 'ready'));
  const response = await req(`/payment-imports/previews/${bad.id}/queue`, 'POST', {
    client_key: randomUUID(),
    version: bad.version,
    row_ids: bad.data.map((r: any) => r.row_id),
    scope_hash: bad.scope_hash,
    confirmed: true,
    local_ledger_only: true,
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal((await paidEntries(o)).length, 0);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_import_claims WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
  const good = await preview(p, [line(o, 'GROUP-C', '100,00'), line(o, 'GROUP-D', '50,00')]);
  const result = await apply(await queue(good));
  assert.equal(result.r.applied, 2);
  assert.equal((await balance(o)).balance.amount_due, 0);
  assert.equal((await paidEntries(o)).length, 2);
});
test('same economic ID across profiles/files is duplicate or conflict and concurrent queue claims exactly one scope', async () => {
  const o = await order(),
    p = await profile(),
    otherProfile = await profile('bank_receipt', p.ns);
  const one = await preview(p, [line(o, 'ECONOMIC', '100,00')]),
    two = await preview(otherProfile, [line(o, 'ECONOMIC', '100,00')]);
  const result = await Promise.all([
    req(`/payment-imports/previews/${one.id}/queue`, 'POST', {
      client_key: randomUUID(),
      version: 1,
      row_ids: [one.data[0].row_id],
      scope_hash: one.scope_hash,
      confirmed: true,
      local_ledger_only: true,
    }),
    req(`/payment-imports/previews/${two.id}/queue`, 'POST', {
      client_key: randomUUID(),
      version: 1,
      row_ids: [two.data[0].row_id],
      scope_hash: two.scope_hash,
      confirmed: true,
      local_ledger_only: true,
    }),
  ]);
  assert.deepEqual(result.map((r) => r.statusCode).sort(), [200, 409]);
  await apply(result.find((r) => r.statusCode === 200)!.json());
  const identical = await preview(otherProfile, [line(o, 'ECONOMIC', '100,00')]);
  assert.equal(identical.data[0].classification, 'duplicate');
  const changed = await preview(p, [line(o, 'ECONOMIC', '90,00')]);
  assert.equal(changed.data[0].classification, 'conflict');
  assert.equal((await paidEntries(o)).length, 1);
  const altered = {
    ...p.definition,
    transaction_id_scope: 'statement',
    columns: { ...p.definition.columns, statement_id: { index: 5 } },
  };
  assert.equal(
    (
      await req('/payment-imports/profiles', 'POST', {
        client_key: randomUUID(),
        definition: altered,
      })
    ).statusCode,
    409,
  );
});
async function dispatched(o: any) {
  await ok('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
  for (const i of o.picking_items)
    for (let n = 0; n < i.quantity; n++)
      await ok('/orders/' + o.id + '/scan', 'POST', { code: i.sku });
  await ok('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
  const s = await ok('/orders/' + o.id + '/ship-demo', 'POST');
  return (await pool.query('SELECT * FROM shipments WHERE order_id=$1', [o.id])).rows[0];
}
test('COD collection and remittance remain separate; bank/carrier alias never credits the customer twice', async () => {
  const o = await order('cod'),
    s = await dispatched(o),
    p = await profile('cod_collection'),
    remit = await profile('cod_remittance', p.ns);
  const unsupported = await preview(remit, [
    line(o, 'REMIT-EARLY', '98,00', s.tracking_number, '2,00'),
  ]);
  assert.equal(unsupported.data[0].classification, 'review');
  const collection = await preview(p, [line(o, 'COLLECT', '100,00', s.tracking_number)]);
  assert.equal(collection.data[0].classification, 'ready');
  await apply(await queue(collection));
  let b = (await balance(o)).balance;
  assert.equal(b.received, 10000);
  assert.equal(b.courier_due, 10000);
  const remittance = await preview(remit, [line(o, 'REMIT', '98,00', s.tracking_number, '2,00')]);
  await apply(await queue(remittance));
  b = (await balance(o)).balance;
  assert.equal(b.received, 10000);
  assert.equal(b.remitted, 9800);
  assert.equal(b.fees, 200);
  assert.equal(b.courier_due, 0);
  const original = (await ok('/payment-imports/receipts?order_id=' + o.id)).data.find(
    (r: any) => r.kind === 'courier_remittance',
  );
  const bankDefinition = {
    ...remit.definition,
    source_kind: 'bank_statement',
    name: 'Bankowy remit',
  };
  const bank = await ok('/payment-imports/profiles', 'POST', {
    client_key: randomUUID(),
    definition: bankDefinition,
  });
  const possible = await preview(bank, [line(o, 'BANK-ALIAS', '98,00', s.tracking_number, '2,00')]);
  assert.equal(possible.data[0].classification, 'review');
  const alias = await ok(`/payment-imports/previews/${possible.id}/resolve`, 'POST', {
    client_key: randomUUID(),
    version: possible.version,
    resolutions: [
      {
        row_id: possible.data[0].row_id,
        action: 'link_existing_receipt',
        receipt_id: original.id,
        reason: 'Ten sam przelew opisany w banku',
      },
    ],
  });
  const detail = await ok('/payment-imports/previews/' + alias.id);
  assert.equal(detail.data[0].operation, 'link_existing');
  const result = await apply(await queue(detail));
  assert.equal(result.detail.result.ledger_entries, 0);
  assert.equal((await paidEntries(o)).length, 2);
  assert.equal((await balance(o)).balance.received, 10000);
  const duplicate = await preview(bank, [
    line(o, 'BANK-ALIAS', '98,00', s.tracking_number, '2,00'),
  ]);
  assert.equal(duplicate.data[0].classification, 'duplicate');
});
test('frozen order/ledger/profile or withdrawn current role blocks all rows and releases only unused claims', async () => {
  const a = await order(),
    b = await order(),
    p = await profile(),
    v = await preview(p, [line(a, 'STALE-A'), line(b, 'STALE-B')]),
    e = await queue(v);
  await pool.query("UPDATE orders SET note='Changed after consent' WHERE id=$1", [b.id]);
  const result = await apply(e);
  assert.equal(result.r.state, 'conflict');
  assert.equal((await paidEntries(a)).length, 0);
  assert.equal((await paidEntries(b)).length, 0);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_import_claims WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
  const fresh = await preview(p, [line(a, 'WITHDRAW')]),
    queued = await queue(fresh);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    tenant,
    user,
  ]);
  const worked = await processPaymentImportJob(await claim(queued));
  assert.equal(worked.state, 'conflict');
  assert.equal((await paidEntries(a)).length, 0);
  assert.equal((await req('/payment-imports/profiles')).statusCode, 403);
});
test('unknown failure after first entry rolls back every effect; retry same durable scope applies once', async () => {
  const a = await order(),
    b = await order(),
    p = await profile(),
    v = await preview(p, [line(a, 'ROLL-A'), line(b, 'ROLL-B')]),
    e = await queue(v),
    job = await claim(e);
  const trigger = 'qa_payment_import_fail';
  await pool.query(
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.order_id='${b.id}'::uuid THEN RAISE EXCEPTION 'controlled second-entry DB failure';END IF;RETURN NEW;END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON payment_entries FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  );
  try {
    await assert.rejects(processPaymentImportJob(job), /controlled second-entry DB failure/);
  } finally {
    await pool.query(`DROP TRIGGER ${trigger} ON payment_entries; DROP FUNCTION ${trigger}()`);
  }
  assert.equal((await paidEntries(a)).length, 0);
  assert.equal((await paidEntries(b)).length, 0);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM payment_import_receipts WHERE execution_id=$1',
        [e.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (await pool.query('SELECT state FROM payment_import_executions WHERE id=$1', [e.id])).rows[0]
      .state,
    'queued',
  );
  assert.equal((await processPaymentImportJob(job)).state, 'done');
  assert.equal((await paidEntries(a)).length, 1);
  assert.equal((await paidEntries(b)).length, 1);
  assert.deepEqual(await processPaymentImportJob(job), { processed: false });
});
test('cancel before attempt and exhausted jobs release reserved claims without undoing applied tombstones', async () => {
  const o = await order(),
    p = await profile(),
    v = await preview(p, [line(o, 'CANCEL')]),
    e = await queue(v);
  const cancel = await ok('/payment-imports/executions/' + e.id + '/cancel', 'POST', {
    client_key: randomUUID(),
  });
  assert.equal(cancel.state, 'cancelled');
  assert.equal(
    (
      await ok('/payment-imports/executions/' + e.id + '/cancel', 'POST', {
        client_key: randomUUID(),
      })
    ).reused,
    true,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_import_claims WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
  const next = await queue(v),
    job = await claim(next);
  assert.equal(
    (
      await req('/payment-imports/executions/' + next.id + '/cancel', 'POST', {
        client_key: randomUUID(),
      })
    ).statusCode,
    409,
  );
  await pool.query("UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL WHERE id=$1", [
    job.id,
  ]);
  assert.equal(await reapPaymentImportJobs(), 1);
  assert.equal(
    (await pool.query('SELECT state FROM payment_import_executions WHERE id=$1', [next.id])).rows[0]
      .state,
    'failed',
  );
  assert.equal((await paidEntries(o)).length, 0);
});
test('correction appends one reversal, retains economic tombstone and preserves fulfillment status', async () => {
  const o = await order(),
    p = await profile(),
    v = await preview(p, [line(o, 'CORRECT', '150,00')]),
    e = await queue(v);
  await apply(e);
  const receipt = (await ok('/payment-imports/receipts?order_id=' + o.id)).data[0];
  assert.equal(receipt.order_number, o.number);
  const correction = await ok('/payment-imports/corrections/preview', 'POST', {
    client_key: randomUUID(),
    receipt_ids: [receipt.id],
    reason: 'Błędny lokalny dowód',
  });
  const body = {
    client_key: randomUUID(),
    scope_hash: correction.scope_hash,
    confirmed: true,
    local_ledger_only: true,
  };
  const queued = await ok('/payment-imports/corrections/' + correction.id + '/queue', 'POST', body);
  await apply(queued);
  assert.equal((await balance(o)).balance.received, 0);
  assert.equal((await ok('/orders/' + o.id)).status, 'paid');
  assert.equal((await paidEntries(o)).filter((e) => e.kind === 'reversal').length, 1);
  assert.equal(
    (await ok('/payment-imports/corrections/' + correction.id + '/queue', 'POST', body)).id,
    queued.id,
  );
  const original = await preview(p, [line(o, 'CORRECT', '150,00')]);
  assert.equal(original.data[0].classification, 'duplicate');
  assert.equal(original.data[0].evidence.claim.reversed, true);
});
test('strict cardinality and CSV boundary preserve all5000 logical rows and reject a101-row queue', async () => {
  const p = await profile(),
    csv =
      'tx;date;amount;order;tracking;fee\n' +
      Array.from({ length: 5000 }, (_, i) => `BAD-${i};2026-10-05;1e3;NO-SUCH-ORDER;;`).join('\n');
  const uploaded = await uploadPaymentImport(actor(), {
    client_key: randomUUID(),
    profile_id: p.id,
    profile_version: 1,
    filename: '5000.csv',
    content_base64: Buffer.from(csv).toString('base64'),
  });
  const head = await previewPaymentImport(actor(), {
    client_key: randomUUID(),
    file_id: uploaded.file_id,
    profile_id: p.id,
    profile_version: 1,
  });
  assert.equal(head.summary.counts.invalid, 5000);
  const positions = (
    await pool.query(
      'SELECT count(*)::int n,min(position) lo,max(position) hi FROM payment_import_rows WHERE preview_id=$1',
      [head.id],
    )
  ).rows[0];
  assert.deepEqual(positions, { n: 5000, lo: 0, hi: 4999 });
  assert.equal(
    (
      await req(`/payment-imports/previews/${head.id}/queue`, 'POST', {
        client_key: randomUUID(),
        version: 1,
        row_ids: Array.from({ length: 101 }, () => randomUUID()),
        scope_hash: head.scope_hash,
        confirmed: true,
        local_ledger_only: true,
      })
    ).statusCode,
    422,
  );
});
test('tenant RLS, immutable evidence, namespace ownership and readOnly/older guards reject sensitive access', async () => {
  const o = await order(),
    p = await profile(),
    v = await preview(p, [line(o)]);
  assert.equal(
    (await req('/payment-imports/previews/' + v.id, 'GET', undefined, other)).statusCode,
    404,
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    for (const table of [
      'payment_import_namespaces',
      'payment_import_profiles',
      'payment_import_files',
      'payment_import_previews',
      'payment_import_rows',
    ])
      assert.equal(
        (await c.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [tenant])).rowCount,
        0,
      );
  });
  await assert.rejects(
    pool.query('UPDATE payment_import_rows SET classification=classification WHERE preview_id=$1', [
      v.id,
    ]),
    /immutable/,
  );
  const readonly = await buildApp({ readOnly: true });
  const login = await readonly.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  const ro = String(login.headers['set-cookie']).split(';')[0];
  const result = await readonly.inject({
    url: '/api/payment-imports/uploads',
    method: 'POST',
    payload: { garbage: true },
    headers: { cookie: ro },
  });
  assert.equal(result.statusCode, 423, result.body);
  await readonly.close();
  const old = await buildApp(); // simulate route availability separately without touching the main migration
  if (old.hasRoute({ method: 'GET', url: '/api/payment-imports/profiles' })) {
    await old.close();
    return;
  }
  registerPaymentImportRoutes(old, { available: false, readOnly: false });
  await old.close();
});
test('COD correction preview blocks collection alone and accepts exactly selected remit-before-collection reversals', async () => {
  const o = await order('cod'),
    s = await dispatched(o),
    p = await profile('cod_collection'),
    remit = await profile('cod_remittance', p.ns);
  await apply(await queue(await preview(p, [line(o, 'DEP-COLLECT', '100,00', s.tracking_number)])));
  await apply(
    await queue(await preview(remit, [line(o, 'DEP-REMIT', '98,00', s.tracking_number, '2,00')])),
  );
  const receipts = (await ok('/payment-imports/receipts?order_id=' + o.id)).data,
    col = receipts.find((r: any) => r.kind === 'courier_collection');
  const blocked = await ok('/payment-imports/corrections/preview', 'POST', {
      client_key: randomUUID(),
      receipt_ids: [col.id],
      reason: 'Jawna próba korekty',
    }),
    details = await ok('/payment-imports/previews/' + blocked.id);
  assert.equal(details.data[0].classification, 'review');
  assert(details.data[0].issues.some((i: any) => i.code === 'correction_dependency'));
  assert.equal(
    (
      await req('/payment-imports/corrections/' + blocked.id + '/queue', 'POST', {
        client_key: randomUUID(),
        scope_hash: blocked.scope_hash,
        confirmed: true,
        local_ledger_only: true,
      })
    ).statusCode,
    409,
  );
  const both = await ok('/payment-imports/corrections/preview', 'POST', {
      client_key: randomUUID(),
      receipt_ids: receipts.map((r: any) => r.id),
      reason: 'Korekta obu dowodów',
    }),
    ready = await ok('/payment-imports/previews/' + both.id);
  assert(ready.data.every((r: any) => r.classification === 'ready'));
  assert.equal(ready.summary.counts.ready, 2);
  assert.deepEqual(ready.summary.totals, [
    {
      currency: 'PLN',
      kind: 'courier_remittance',
      operation: 'reverse',
      amount_minor: '9800',
      fee_minor: '200',
      count: 1,
    },
    {
      currency: 'PLN',
      kind: 'courier_collection',
      operation: 'reverse',
      amount_minor: '10000',
      fee_minor: '0',
      count: 1,
    },
  ]);
  assert.equal(ready.data[0].source.normalized.ledger_kind, 'courier_remittance');
  assert(ready.data.every((r: any) => r.evidence.projected_after));
  const e = await ok('/payment-imports/corrections/' + both.id + '/queue', 'POST', {
    client_key: randomUUID(),
    scope_hash: both.scope_hash,
    confirmed: true,
    local_ledger_only: true,
  });
  assert.equal((await apply(e)).r.state, 'done');
  const b = (await balance(o)).balance;
  assert.equal(b.received, 0);
  assert.equal(b.courier_due, 0);
  assert.equal(b.fees, 0);
  assert.equal((await paidEntries(o)).filter((e) => e.kind === 'reversal').length, 2);
});
test('role withdrawn while queue waits on order row is rechecked after lock and admits no claim or job', async () => {
  const o = await order(),
    p = await profile(),
    v = await preview(p, [line(o, 'WAIT-ROLE')]),
    lock = await pool.connect();
  await lock.query('BEGIN');
  await lock.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [o.id]);
  const pending = req(`/payment-imports/previews/${v.id}/queue`, 'POST', {
    client_key: randomUUID(),
    version: v.version,
    row_ids: [v.data[0].row_id],
    scope_hash: v.scope_hash,
    confirmed: true,
    local_ledger_only: true,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      user,
    ]);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  const r = await pending;
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_import_executions WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal((await paidEntries(o)).length, 0);
});
test('exact100 ready rows execute atomically and receipt pages retain all rows; ledger-only fences match final version', async () => {
  const o = await order(),
    p = await profile(),
    v = await preview(
      p,
      Array.from({ length: 100 }, (_, i) => line(o, 'MAX-' + i, '0,01')),
    ),
    secondPage = await ok('/payment-imports/previews/' + v.id + '?cursor=' + v.meta.cursor),
    e = await queue(
      v,
      [...v.data, ...secondPage.data].map((r: any) => r.row_id),
    );
  assert.equal(e.selected_count, 100);
  assert.equal(e.total_minor, '100');
  const done = await apply(e);
  assert.equal(done.r.applied, 100);
  assert.equal(done.detail.data.length, 50);
  assert(done.detail.meta.cursor);
  const next = await ok(
    '/payment-imports/executions/' + e.id + '?cursor=' + done.detail.meta.cursor,
  );
  assert.equal(next.data.length, 50);
  assert.equal(next.meta.cursor, null);
  assert.equal(new Set([...done.detail.data, ...next.data].map((r: any) => r.row_id)).size, 100);
  assert.equal((await paidEntries(o)).length, 100);
  assert.equal((await balance(o)).balance.received, 100);
  const fence = (
    await pool.query(
      'SELECT f.order_version,o.version FROM order_local_financial_fences f JOIN orders o ON o.id=f.order_id WHERE f.order_id=$1',
      [o.id],
    )
  ).rows[0];
  assert.equal(String(fence.order_version), String(fence.version));
  assert.equal(
    (
      await tenantTx(tenant, (c) =>
        c.query('DELETE FROM payment_import_claims WHERE execution_id=$1', [e.id]),
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    pool.query('DELETE FROM payment_import_claims WHERE execution_id=$1', [e.id]),
    /immutable/,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_import_claims WHERE execution_id=$1', [
        e.id,
      ])
    ).rows[0].n,
    100,
  );
});
test('21 parallel queue attempts serialize tenant capacity and cancellation frees only its unused reservation', async () => {
  const p = await profile(),
    orders = [];
  for (let i = 0; i < 21; i++) orders.push(await order());
  const v = await preview(
    p,
    orders.map((o, i) => line(o, 'CAP-' + i)),
  );
  const results = await Promise.all(
    v.data.map((row: any) =>
      req(`/payment-imports/previews/${v.id}/queue`, 'POST', {
        client_key: randomUUID(),
        version: 1,
        row_ids: [row.row_id],
        scope_hash: v.scope_hash,
        confirmed: true,
        local_ledger_only: true,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 200).length, 20);
  assert.equal(results.filter((r) => r.statusCode === 409).length, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM payment_import_executions WHERE tenant_id=$1 AND state='queued'",
        [tenant],
      )
    ).rows[0].n,
    20,
  );
  const first = results.find((r) => r.statusCode === 200)!.json();
  await ok('/payment-imports/executions/' + first.id + '/cancel', 'POST', {
    client_key: randomUUID(),
  });
  const failed = results.findIndex((r) => r.statusCode === 409);
  await queue(v, [v.data[failed].row_id]);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_import_claims WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    20,
  );
});
test('same-date equal-amount distinct transfer needs explicit evidence and bank receipt never accepts shipment allocation', async () => {
  const o = await order(),
    p = await profile();
  await apply(await queue(await preview(p, [line(o, 'EQUAL-FIRST', '50,00')])));
  const second = await preview(p, [line(o, 'EQUAL-SECOND', '50,00')]);
  assert.equal(second.data[0].classification, 'review');
  const resolved = await ok('/payment-imports/previews/' + second.id + '/resolve', 'POST', {
    client_key: randomUUID(),
    version: 1,
    resolutions: [
      {
        row_id: second.data[0].row_id,
        action: 'assign',
        order_id: o.id,
        reason: 'Potwierdzam niezależny drugi przelew o tej samej kwocie',
      },
    ],
  });
  const ready = await ok('/payment-imports/previews/' + resolved.id);
  assert.equal(ready.data[0].classification, 'ready');
  await apply(await queue(ready));
  assert.equal((await balance(o)).balance.received, 10000);
  const third = await preview(p, [line(o, 'SHIPMENT-INVALID', '10,00')]);
  assert.equal(
    (
      await req('/payment-imports/previews/' + third.id + '/resolve', 'POST', {
        client_key: randomUUID(),
        version: 1,
        resolutions: [
          {
            row_id: third.data[0].row_id,
            action: 'assign',
            order_id: o.id,
            shipment_id: randomUUID(),
            reason: 'Niepoprawna alokacja przesyłki',
          },
        ],
      })
    ).statusCode,
    422,
  );
});
test('older backup metadata remains graceful and readOnly takes priority over missing schema before parsing', async () => {
  const connection = await pool.connect();
  let old: FastifyInstance | undefined;
  try {
    await connection.query(
      'ALTER TABLE payment_import_executions RENAME TO qa_missing_payment_import_executions',
    );
    old = await buildApp();
  } finally {
    await connection.query(
      'ALTER TABLE qa_missing_payment_import_executions RENAME TO payment_import_executions',
    );
    connection.release();
  }
  const login = await old.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    }),
    auth = String(login.headers['set-cookie']).split(';')[0];
  const r = await old.inject({ url: '/api/payment-imports/profiles', headers: { cookie: auth } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().available, false);
  assert.deepEqual(r.json().data, []);
  const write = await old.inject({
    url: '/api/payment-imports/uploads',
    method: 'POST',
    payload: { garbage: true },
    headers: { cookie: auth },
  });
  assert.equal(write.statusCode, 503, write.body);
  await old.close();
});
test('malformed upload saves no partial proof and changed profile fences a previously queued execution', async () => {
  const p = await profile(),
    bad = {
      client_key: randomUUID(),
      profile_id: p.id,
      profile_version: 1,
      filename: 'bad.csv',
      content_base64: Buffer.from('tx;date;amount;order;tracking;fee\n"unfinished').toString(
        'base64',
      ),
    };
  const malformed = await req('/payment-imports/uploads', 'POST', bad);
  assert.equal(malformed.statusCode, 422, malformed.body);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_import_files WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM payment_import_upload_requests WHERE tenant_id=$1',
        [tenant],
      )
    ).rows[0].n,
    0,
  );
  const o = await order(),
    v = await preview(p, [line(o, 'PROFILE-CHANGED')]),
    e = await queue(v);
  await ok('/payment-imports/profiles/' + p.id, 'PUT', {
    version: 1,
    definition: { ...p.definition, name: 'Zmieniony format' },
  });
  assert.equal((await apply(e)).r.state, 'conflict');
  assert.equal((await paidEntries(o)).length, 0);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_import_claims WHERE execution_id=$1', [
        e.id,
      ])
    ).rows[0].n,
    0,
  );
});
test('contradictory order and tracking remains review even after explicit own-order assignment', async () => {
  const o = await order(),
    cod = await order('cod'),
    s = await dispatched(cod),
    p = await profile(),
    definition = {
      ...p.definition,
      columns: { ...p.definition.columns, tracking_number: { index: 4 } },
      match: { ...p.definition.match, carrier: s.carrier },
    };
  const format = await ok('/payment-imports/profiles', 'POST', {
    client_key: randomUUID(),
    definition,
  });
  const v = await preview(format, [line(o, 'CONTRADICT', '100,00', s.tracking_number)]);
  assert.equal(v.data[0].classification, 'review');
  assert(v.data[0].issues.some((i: any) => i.code === 'contradictory_tracking'));
  const resolved = await ok('/payment-imports/previews/' + v.id + '/resolve', 'POST', {
    client_key: randomUUID(),
    version: 1,
    resolutions: [
      {
        row_id: v.data[0].row_id,
        action: 'assign',
        order_id: o.id,
        reason: 'Brak spójnego numeru przesyłki',
      },
    ],
  });
  const detail = await ok('/payment-imports/previews/' + resolved.id);
  assert.equal(detail.data[0].classification, 'review');
  assert.equal((await paidEntries(o)).length, 0);
});
