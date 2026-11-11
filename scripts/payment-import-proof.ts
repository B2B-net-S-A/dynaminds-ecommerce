import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db';

const path = 'data/payment-import-stage099.json',
  phase = process.argv[2];
const tables = [
  'products',
  'stock',
  'stock_movements',
  'orders',
  'order_items',
  'order_pick_items',
  'order_events',
  'reservations',
  'shipments',
  'shipping_plans',
  'documents',
  'return_cases',
  'return_items',
  'payment_entries',
  'channels',
  'warehouses',
  'memberships',
  'workspace_usage',
  'workspace_billing_accounts',
  'workspace_billing_entries',
  'product_translations',
  'ai_catalog_drafts',
  'deepl_catalog_drafts',
  'deepl_catalog_batches',
  'shopify_translation_plans',
  'shopify_translation_batches',
  'customer_message_threads',
  'customer_messages',
  'product_rules',
  'product_rule_revisions',
  'product_rule_runs',
  'product_rule_items',
  'product_rule_causes',
];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fingerprints(ids: string[]) {
  const out: Record<string, string> = {};
  for (const t of tables)
    out[t] = digest(
      (
        await pool.query(
          `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
          [ids],
        )
      ).rows,
    );
  out.tenants = digest(
    (
      await pool.query(
        'SELECT to_jsonb(t) row FROM tenants t WHERE id=ANY($1::uuid[]) ORDER BY 1',
        [ids],
      )
    ).rows,
  );
  return out;
}
let cookie = '';
async function api(p: string, method = 'GET', body?: unknown, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, expected, p);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as Promise<any>;
}
async function wait(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await api('/payment-imports/executions/' + id);
    if (r.state !== 'queued') {
      assert.equal(r.state, 'done', r.error);
      return r;
    }
    await setTimeout(200);
  }
  throw Error('Own payment import did not finish');
}
try {
  if (phase === 'baseline') {
    assert.equal(
      (await pool.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
      '076_product_rules',
    );
    assert.equal(
      (await pool.query("SELECT to_regclass('public.payment_import_files') p")).rows[0].p,
      null,
    );
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((x) => x.id),
      users = (await pool.query('SELECT id,email,name,password_hash FROM users ORDER BY id')).rows;
    await writeFile(
      path,
      JSON.stringify(
        {
          ids,
          userIds: users.map((x) => x.id),
          usersHash: digest(users),
          before: await fingerprints(ids),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({
      phase,
      prior_firms: ids.length,
      prior_users: users.length,
      business_tables: tables.length,
    });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8'));
    const save = () => writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600 });
    const h = await api('/health');
    assert.equal(h.schema_revision, '077_payment_imports');
    assert(h.payment_imports_available);
    if (process.env.PROOF_REVISION) assert.equal(h.revision, process.env.PROOF_REVISION);
    if (phase === 'setup') {
      assert(!s.tenant);
      s.email = 'qa-import-099@demo.local';
      s.password = 'DynaImports!2026';
      const signup = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA import 099',
          organization: { name: 'QA przelewy i pobrania 099' },
        },
        201,
      );
      s.tenant = signup.user.tenant_id;
      s.user = signup.user.id;
      await save();
      assert(!s.ids.includes(s.tenant));
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.product = await api(
        '/products',
        'POST',
        {
          sku: 'QA099-CSV',
          name: 'Kubek rozliczeń CSV',
          price: 5000,
          quantity: 20,
          warehouse_id: s.warehouse,
        },
        201,
      );
      const make = (mode: string, quantity: number) =>
        api(
          '/orders',
          'POST',
          {
            customer_name: 'Lokalny test CSV099',
            email: 'qa099@example.test',
            warehouse_id: s.warehouse,
            payment_mode: mode,
            items: [{ product_id: s.product.id, quantity }],
            address: {
              country: 'PL',
              street: 'Testowa 1',
              city: 'Warszawa',
              postal_code: '00-001',
              phone: '500600700',
            },
          },
          201,
        );
      s.bank = await make('prepaid', 3);
      s.cod = await make('cod', 2);
      await api('/orders/' + s.cod.id + '/status', 'PATCH', { status: 'picking' });
      for (let i = 0; i < 2; i++)
        await api('/orders/' + s.cod.id + '/scan', 'POST', { code: s.product.sku });
      await api('/orders/' + s.cod.id + '/status', 'PATCH', { status: 'packed' });
      s.cod = await api('/orders/' + s.cod.id + '/ship-demo', 'POST', {});
      s.shipment = s.cod.shipments[0];
      s.bankNamespace = await api('/payment-imports/namespaces', 'POST', {
        client_key: randomUUID(),
        label: 'Rachunek demonstracyjny 099',
        source_kind: 'bank_statement',
      });
      s.codNamespace = await api('/payment-imports/namespaces', 'POST', {
        client_key: randomUUID(),
        label: 'Rozliczenia DEMO 099',
        source_kind: 'shared_settlement',
      });
      const definition = (mode: string, source_kind: string, namespace: string) => ({
        name: 'QA099 ' + mode,
        description: 'Jawny lokalny plik testowy',
        source_kind,
        source_namespace_id: namespace,
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
          ...(mode !== 'bank_receipt' ? { tracking_number: { index: 4 } } : {}),
          ...(mode === 'cod_remittance' ? { fee: { index: 5 } } : {}),
        },
        match: {
          kind: 'order_number',
          extraction: 'whole_field',
          ...(mode !== 'bank_receipt' ? { carrier: s.shipment.carrier } : {}),
        },
      });
      s.profiles = {};
      for (const [mode, source, ns] of [
        ['bank_receipt', 'bank_statement', s.bankNamespace.id],
        ['cod_collection', 'carrier_report', s.codNamespace.id],
        ['cod_remittance', 'bank_statement', s.codNamespace.id],
      ])
        s.profiles[mode] = await api('/payment-imports/profiles', 'POST', {
          client_key: randomUUID(),
          definition: definition(mode, source, ns),
        });
      await writeFile(
        'data/QA099-bank-first.csv',
        'transaction;date;amount;order;tracking;fee\nQA099-BANK-1;2026-10-05;100,00;' +
          s.bank.number +
          ';;\n',
        { mode: 0o600 },
      );
      s.setupStock = (await api('/products/' + s.product.id)).stock;
      s.setupJobIds = (
        await pool.query('SELECT id FROM jobs WHERE tenant_id=$1 ORDER BY id', [s.tenant])
      ).rows.map((r) => r.id);
      await save();
      console.log({
        phase,
        own_new_firm: true,
        bank_nominal: s.bank.total,
        cod_expected: s.shipment.cod_expected,
        profiles: 3,
        external_requests: 0,
      });
    } else if (phase === 'exercise' || phase === 'observe' || phase === 'verify') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      if (phase === 'exercise') {
        const history = (await api('/payment-imports/executions')).data;
        assert.equal(
          history.filter((r: any) => r.state === 'done').length,
          1,
          'First bank execution must be reviewed in browser',
        );
        s.uiBankExecution = history.find((r: any) => r.state === 'done').id;
        let bank = await api('/orders/' + s.bank.id);
        assert.equal(bank.payment.received, 10000);
        assert.equal(bank.payment.amount_due, 5000);
        assert.equal(bank.status, 'new');
        const preview = async (mode: string, line: string) => {
          const p = s.profiles[mode],
            upload = await api('/payment-imports/uploads', 'POST', {
              client_key: randomUUID(),
              profile_id: p.id,
              profile_version: p.version,
              filename: 'QA099-' + mode + '.csv',
              content_base64: Buffer.from(
                'transaction;date;amount;order;tracking;fee\n' + line + '\n',
              ).toString('base64'),
            });
          const head = await api('/payment-imports/previews', 'POST', {
            client_key: randomUUID(),
            file_id: upload.id ?? upload.file_id,
            profile_id: p.id,
            profile_version: p.version,
          });
          return api('/payment-imports/previews/' + head.id);
        };
        const queue = async (p: any) => {
          const rows = p.data.filter((r: any) => r.classification === 'ready');
          assert(rows.length);
          const q = await api('/payment-imports/previews/' + p.id + '/queue', 'POST', {
            client_key: randomUUID(),
            version: p.version,
            row_ids: rows.map((r: any) => r.row_id),
            scope_hash: p.scope_hash,
            confirmed: true,
            local_ledger_only: true,
          });
          return wait(q.id);
        };
        let second = await preview(
          'bank_receipt',
          'QA099-BANK-2;2026-10-05;50,00;' + s.bank.number + ';;',
        );
        assert.equal(second.data[0].classification, 'review');
        second = await api('/payment-imports/previews/' + second.id + '/resolve', 'POST', {
          client_key: randomUUID(),
          version: second.version,
          resolutions: [
            {
              row_id: second.data[0].row_id,
              action: 'assign',
              order_id: s.bank.id,
              reason: 'Odrębny drugi przelew w lokalnym pliku testowym',
            },
          ],
        });
        second = await api('/payment-imports/previews/' + second.id);
        s.second = await queue(second);
        bank = await api('/orders/' + s.bank.id);
        assert.equal(bank.payment.received, 15000);
        assert.equal(bank.status, 'paid');
        s.collection = await queue(
          await preview(
            'cod_collection',
            'QA099-COLLECT;2026-10-05;100,00;' +
              s.cod.number +
              ';' +
              s.shipment.tracking_number +
              ';',
          ),
        );
        let cod = await api('/orders/' + s.cod.id);
        assert.equal(cod.payment.received, 10000);
        assert.equal(cod.payment.courier_due, 10000);
        s.remittance = await queue(
          await preview(
            'cod_remittance',
            'QA099-REMIT;2026-10-05;98,00;' +
              s.cod.number +
              ';' +
              s.shipment.tracking_number +
              ';2,00',
          ),
        );
        cod = await api('/orders/' + s.cod.id);
        assert.equal(cod.payment.received, 10000);
        assert.equal(cod.payment.remitted, 9800);
        assert.equal(cod.payment.fees, 200);
        assert.equal(cod.payment.courier_due, 0);
        s.beforeCorrection = structuredClone(cod.payment);
        s.duplicate = await preview(
          'cod_remittance',
          'QA099-REMIT;2026-10-05;98,00;' +
            s.cod.number +
            ';' +
            s.shipment.tracking_number +
            ';2,00',
        );
        assert.equal(s.duplicate.data[0].classification, 'duplicate');
        await save();
      }
      const executions = (await api('/payment-imports/executions')).data;
      const correction = executions.find((r: any) => r.kind === 'correction' && r.state === 'done');
      if (phase !== 'exercise') assert(correction, 'Browser COD correction must complete');
      const expectedExecutions = correction ? 5 : 4;
      assert.equal(executions.filter((r: any) => r.state === 'done').length, expectedExecutions);
      if (correction) {
        s.correction = correction.id;
        await save();
      }
      const bank = await api('/orders/' + s.bank.id),
        cod = await api('/orders/' + s.cod.id);
      assert.equal(bank.payment.received, 15000);
      assert.equal(bank.payment.amount_due, 0);
      assert.equal(bank.status, 'paid');
      assert.equal(cod.payment.received, correction ? 0 : 10000);
      assert.equal(cod.payment.courier_due, 0);
      assert.equal(cod.payment.remitted, correction ? 0 : 9800);
      assert.equal(cod.payment.fees, correction ? 0 : 200);
      assert.equal(cod.payment.amount_due, correction ? 10000 : 0);
      assert.equal(cod.payment.refunded, 0);
      assert.equal(cod.status, 'shipped');
      const receipts = (await api('/payment-imports/receipts')).data;
      assert.equal(receipts.length, correction ? 6 : 4);
      const bankReceipts = receipts.filter((r: any) => r.order_id === s.bank.id);
      assert.equal(bankReceipts.length, 2);
      assert.deepEqual(
        bankReceipts.map((r: any) => r.amount).sort((a: number, b: number) => a - b),
        [5000, 10000],
      );
      assert.equal(new Set(bankReceipts.map((r: any) => r.entry_id)).size, 2);
      const codReceipts = receipts.filter((r: any) => r.order_id === s.cod.id);
      assert.equal(codReceipts.length, correction ? 4 : 2);
      assert.equal(
        codReceipts.filter((r: any) => r.operation === 'reverse').length,
        correction ? 2 : 0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM payment_entries WHERE tenant_id=$1 AND order_id=ANY($2::uuid[])',
            [s.tenant, [s.bank.id, s.cod.id]],
          )
        ).rows[0].n,
        correction ? 6 : 4,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM payment_import_claims WHERE tenant_id=$1 AND state='applied'",
            [s.tenant],
          )
        ).rows[0].n,
        4,
      );
      const importTables = [
        'payment_import_namespaces',
        'payment_import_profiles',
        'payment_import_profile_revisions',
        'payment_import_files',
        'payment_import_upload_requests',
        'payment_import_previews',
        'payment_import_rows',
        'payment_import_executions',
        'payment_import_execution_rows',
        'payment_import_claims',
        'payment_import_receipts',
        'order_local_financial_fences',
      ];
      const importHashes: Record<string, string> = {};
      for (const table of importTables)
        importHashes[table] = digest(
          (
            await pool.query(
              `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`,
              [s.tenant],
            )
          ).rows,
        );
      if (phase === 'observe') {
        s.importHashesBeforeRestart = importHashes;
        await save();
      }
      if (phase === 'verify') {
        assert(
          s.importHashesBeforeRestart,
          'Observe must capture import evidence before full restart',
        );
        assert.deepEqual(
          importHashes,
          s.importHashesBeforeRestart,
          'Every import evidence table survives restart exactly',
        );
      }
      assert.deepEqual((await api('/products/' + s.product.id)).stock, s.setupStock);
      assert.deepEqual(await fingerprints(s.ids), s.before);
      const users = (
        await pool.query(
          'SELECT id,email,name,password_hash FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
          [s.userIds],
        )
      ).rows;
      assert.equal(digest(users), s.usersHash);
      const counts = (
        await pool.query(
          'SELECT kind,count(*)::int n FROM jobs WHERE tenant_id=$1 AND NOT(id=ANY($2::uuid[])) GROUP BY kind ORDER BY kind',
          [s.tenant, s.setupJobIds],
        )
      ).rows;
      assert.deepEqual(counts, [{ kind: 'payment.import', n: expectedExecutions }]);
      const report = {
        stage: 99,
        verified_at: new Date().toISOString(),
        scope: 'local_native',
        verification_channels: {
          first_bank_import: 'browser_UI',
          second_bank_and_COD_imports: 'native_HTTP_API',
          COD_correction: correction ? 'browser_UI' : 'pending',
        },
        revision: h.revision,
        schema: h.schema_revision,
        previous_firms_preserved: s.ids.length,
        previous_users_preserved: s.userIds.length,
        previous_business_tables_preserved: tables.length,
        bank: {
          received: bank.payment.received,
          amount_due: bank.payment.amount_due,
          status: bank.status,
          distinct_partial_receipts: 2,
        },
        cod: {
          received: cod.payment.received,
          remitted: cod.payment.remitted,
          fee: cod.payment.fees,
          courier_due: cod.payment.courier_due,
          amount_due: cod.payment.amount_due,
          refunded: cod.payment.refunded,
          provider: 'local_demo',
          before_correction: s.beforeCorrection,
          local_correction_completed: Boolean(correction),
          fulfillment_status: cod.status,
        },
        done_executions: expectedExecutions,
        duplicate_remittance_no_second_entry: true,
        stock_unchanged_by_import: true,
        full_native_restart_preserved: phase === 'verify',
        import_evidence_tables_preserved_after_restart:
          phase === 'verify' ? importTables.length : 0,
        external_requests: 0,
        provider_verified: false,
        goal_complete: false,
      };
      await writeFile('docs/payment-import-native-qa.json', JSON.stringify(report, null, 2) + '\n');
      console.log(report);
    } else throw Error('Unknown proof phase');
  }
} finally {
  await pool.end();
}
