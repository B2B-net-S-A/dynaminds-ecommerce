import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/odoo-invoice-pdf-stage058.json',
  phase = process.argv[2],
  email = 'qa-odoo-pdf@demo.local';
let cookie = '';
const save = (s: any) => writeFile(path, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
async function api(p: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method,
    headers: {
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(p === '/orders' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, `${method} ${p}: ${r.status} ${await r.clone().text()}`);
  return (await r.json()) as any;
}
async function fingerprint(t: string, tenants: string[]) {
  const rows = (
    await pool.query(
      `SELECT to_jsonb(t)::text row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
try {
  if (phase === 'baseline') {
    const previous = JSON.parse(await readFile('data/odoo-catalog-sync-stage056.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of [
      ...new Set([
        ...Object.keys(previous.before),
        'odoo_catalog_schedules',
        'odoo_catalog_sync_runs',
        'odoo_catalog_sync_items',
      ]),
    ])
      before[t] = await fingerprint(t, tenants);
    await save({ tenants, before, excluded: previous.excluded });
    console.log({ tenants: tenants.length, tables: Object.keys(before).length });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!s.fixture);
      await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA Odoo PDF',
        organization: { name: 'QA Odoo PDF 20261004', currency: 'PLN', locale: 'pl-PL' },
      });
      const f: any = (s.fixture = { email, tenant: (await api('/auth/me')).user.tenant_id });
      await save(s);
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/odoo-example', 'POST', {})).channel_id;
      await save(s);
      f.product = (
        await api('/products', 'POST', {
          name: 'Produkt QA eksport Odoo',
          sku: 'OD-FV-QA-' + randomUUID().slice(0, 8),
          price: 12300,
          vat: 23,
          warehouse_id: f.warehouse,
          quantity: 12,
        })
      ).id;
      await save(s);
      let o = await api('/orders', 'POST', {
        customer_name: 'Syntetyczny nabywca QA Odoo',
        email: 'qa@example.test',
        warehouse_id: f.warehouse,
        items: [{ product_id: f.product, quantity: 2 }],
        address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
        shipping_cost: 1499,
        note: 'QA lokalnej symulacji eksportu faktury do Odoo',
      });
      f.order = o.id;
      await save(s);
      await api(`/orders/${f.order}/payments`, 'POST', {
        client_key: randomUUID(),
        version: o.version,
        kind: 'receipt',
        amount: o.total,
        currency: o.currency,
        method: 'other',
        reference: 'QA SYMULACJA WPŁATY',
        confirmed: true,
      });
      o = await api(`/orders/${f.order}`);
      f.document = (await api(`/orders/${f.order}/documents`, 'POST', { kind: 'invoice' })).id;
      f.payments_before = (
        await pool.query(
          'SELECT to_jsonb(p) row FROM payment_entries p WHERE order_id=$1 ORDER BY id',
          [f.order],
        )
      ).rows;
      f.stock_before = (
        await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
      ).rows;
      f.document_before = (
        await pool.query('SELECT to_jsonb(d) row FROM documents d WHERE id=$1', [f.document])
      ).rows[0].row;
      await save(s);
      const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(
        new Date(f.document_before.created_at),
      );
      const p = await api(`/documents/${f.document}/odoo-export/preview`, 'POST', {
        client_key: randomUUID(),
        channel_id: f.channel,
        partner_id: 1,
        journal_id: 1,
        account_id: 1,
        invoice_date: day,
        due_date: day,
        shipping_vat: 23,
        taxes: [{ vat: 23, tax_id: 24 }],
      });
      f.export = p.id;
      await api(`/odoo-invoice-exports/${p.id}/queue`, 'POST', { confirm_data: true });
      await save(s);
      console.log({
        phase,
        order: o.number,
        source_invoice: f.document,
        PDF_capture: 'pending_in_Chrome',
        scope: 'local_simulation',
      });
    } else {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      const history = await api(`/orders/${f.order}/odoo-invoices`);
      assert.equal(history.data.length, 1);
      const p = history.data[0];
      assert.equal(p.state, 'done');
      assert.equal(p.phase, 'verified');
      assert.equal(p.document_id, f.document);
      assert.equal(p.result.scope, 'local_simulation');
      assert.match(p.result.number, /^DEMO-ODOO/);
      assert.equal(p.result.accounting_payment_not_imported, true);
      const stock = (
        await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
      ).rows;
      assert.deepEqual(stock, f.stock_before);
      assert.deepEqual(
        (await pool.query('SELECT to_jsonb(d) row FROM documents d WHERE id=$1', [f.document]))
          .rows[0].row,
        f.document_before,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT to_jsonb(p) row FROM payment_entries p WHERE order_id=$1 ORDER BY id',
            [f.order],
          )
        ).rows,
        f.payments_before,
      );
      for (const [table, hash] of Object.entries(s.before))
        assert.deepEqual(
          await fingerprint(table, s.tenants),
          hash,
          table + ' changed for previous firm',
        );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM odoo_invoice_files WHERE tenant_id=ANY($1::uuid[])',
            [s.tenants],
          )
        ).rows[0].n,
        0,
      );
      const h = await api('/health');
      assert.equal(h.schema_revision, '044_odoo_invoice_files');
      if (process.argv[3]) assert.equal(h.revision, process.argv[3]);
      assert(p.pdf && p.pdf.mode === 'simulation');
      const r = await fetch(`http://127.0.0.1:4100/api/odoo-invoice-exports/${p.id}/pdf`, {
        headers: { cookie },
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'application/pdf');
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.deepEqual(bytes, await readFile('output/pdf/odoo-demo.pdf'));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), p.pdf.sha256);
      await writeFile('data/odoo-pdf-qa/native-demo.pdf', bytes);
      const archived = (
        await pool.query('SELECT * FROM odoo_invoice_files WHERE export_id=$1', [p.id])
      ).rows[0];
      assert.equal(archived.sha256, p.pdf.sha256);
      const report = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_Odoo_invoice_PDF_simulation',
        revision: h.revision,
        schema_revision: h.schema_revision,
        provider_authenticated: false,
        whole_goal_complete: false,
        existing_tenants_preserved: s.tenants.length,
        stable_tables_preserved: Object.keys(s.before).length + 1,
        source_invoice_unchanged: true,
        invoice_total: p.result.total,
        pdf_size: bytes.length,
        pdf_sha256: p.pdf.sha256,
        PDF_download_HTTP: 200,
        immutable_cached_pdf: true,
        provider_requests: 0,
        source_number: p.snapshot.source.number,
        ERP_number: p.result.number,
        ERP_state: p.result.state,
        export_state: p.state,
        export_phase: p.phase,
        physical_stock_unchanged: true,
        stock: stock[0],
        payment_entries: f.payments_before.length,
        payment_ledger_unchanged: true,
        real_provider_mutations: 0,
      };
      f.export = p.id;
      s.verification = report;
      await save(s);
      await writeFile(
        phase === 'verify'
          ? 'data/odoo-invoice-pdf-runtime-058.json'
          : 'docs/odoo-invoice-pdf-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    }
  }
} finally {
  await pool.end();
}
