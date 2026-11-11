// Only a newly created local QA firm. Private baseline never enters the report.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db';
const file = 'data/shopify-stage096.json',
  phase = process.argv[2];
const tables = [
  'channels',
  'products',
  'stock',
  'stock_movements',
  'orders',
  'order_items',
  'order_pick_items',
  'order_events',
  'reservations',
  'shipments',
  'documents',
  'return_cases',
  'return_items',
  'payment_entries',
  'warehouses',
  'memberships',
  'workspace_usage',
  'workspace_invitations',
  'workspace_billing_accounts',
  'workspace_billing_previews',
  'workspace_billing_entries',
  'ai_catalog_drafts',
  'product_translations',
  'deepl_catalog_drafts',
  'deepl_catalog_batches',
  'shopify_account_bindings',
  'shopify_oauth_states',
  'shopify_translation_plans',
  'shopify_translation_observations',
  'shopify_translation_simulations',
];
const hash = (v: any) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function baseline(ids: string[]) {
  const result: Record<string, string> = {};
  for (const t of tables)
    result[t] = hash(
      (
        await pool.query(
          `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
          [ids],
        )
      ).rows,
    );
  result.tenants = hash(
    (
      await pool.query(
        'SELECT to_jsonb(t) row FROM tenants t WHERE id=ANY($1::uuid[]) ORDER BY 1',
        [ids],
      )
    ).rows,
  );
  return result;
}
// The OMS reserve → dispatch → return flow legitimately increments stock.version.
// Preserve every business value and assert exactly those three own-row revisions.
const stockBusiness = ({ version: _version, ...row }: any) => row;
const productBusiness = (products: any[]) =>
  products.map((p) => ({ ...p, stock: p.stock.map(stockBusiness) }));
const stockRowsBusiness = (rows: any[]) =>
  rows
    .map((r) => ({ ...r, row: stockBusiness(r.row) }))
    .sort((a, b) =>
      (a.row.warehouse_id + ':' + a.row.product_id).localeCompare(
        b.row.warehouse_id + ':' + b.row.product_id,
      ),
    );
function verifyOwnProducts(s: any, products: any[]) {
  assert.deepEqual(productBusiness(products), productBusiness(s.publicationProductsBefore));
  const changes = [];
  for (const [n, p] of products.entries()) {
    assert.equal(p.version, 2);
    for (const row of p.stock) {
      const before = s.publicationProductsBefore[n].stock.find(
        (r: any) => r.warehouse_id === row.warehouse_id,
      );
      assert(before);
      assert.equal(BigInt(before.version), 0n);
      const delta = n === 0 ? 3n : 0n;
      assert.equal(
        BigInt(row.version),
        BigInt(before.version) + delta,
        'Only own OMS product may advance stock.version',
      );
      assert.equal(row.on_hand, 10);
      assert.equal(row.reserved, 0);
      assert.equal(row.available, 10);
      changes.push({
        sku: p.sku,
        warehouse_id: row.warehouse_id,
        before: String(before.version),
        after: String(row.version),
        expected_delta: Number(delta),
      });
    }
  }
  return changes;
}

let cookie = '';
async function api(p: string, m = 'GET', b?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method: m,
    headers: { cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  assert.equal(r.status, status, p + ' ' + (await r.clone().text()));
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as any;
}
try {
  if (phase === 'baseline') {
    assert.equal(
      (await pool.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
      '073_shopify_translations',
      'Baseline must precede migration074',
    );
    assert.equal(
      (await pool.query("SELECT to_regclass('public.shopify_translation_batches') present")).rows[0]
        .present,
      null,
    );
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      users = (await pool.query('SELECT id,email,name,password_hash FROM users ORDER BY id')).rows;
    assert.equal(ids.length, 88);
    assert.equal(users.length, 71);
    await writeFile(
      file,
      JSON.stringify(
        {
          ids,
          userIds: users.map((r) => r.id),
          usersHash: hash(users),
          before: await baseline(ids),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({
      prior_firms: ids.length,
      prior_users: users.length,
      business_tables: tables.length,
    });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8')),
      save = () => writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    const health = await api('/health');
    assert.equal(health.schema_revision, '074_shopify_translation_batches');
    assert(health.shopify_translation_batches_available);
    assert(health.shopify_translations_available);
    if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
    if (phase === 'setup' || phase === 'finish-setup') {
      if (phase === 'setup') {
        assert(!s.tenant, 'Setup creates one new own firm; use finish-setup to resume');
        s.email = 'qa-shopify-096@demo.local';
        s.password = 'DynaShopifyBulk!2026';
        const u = await api(
          '/auth/signup',
          'POST',
          {
            email: s.email,
            password: s.password,
            name: 'QA Shopify96',
            organization: { name: 'QA Shopify partie 096' },
          },
          201,
        );
        s.tenant = u.user.tenant_id;
        s.user = u.user.id;
        s.products = [];
        s.drafts = [];
        s.listings = [];
        await save();
      } else await api('/auth/login', 'POST', { email: s.email, password: s.password });
      assert(!s.ids.includes(s.tenant), 'Only the newly created QA firm may change');
      s.warehouse ??= (await api('/warehouses')).data[0].id;
      if (!s.channel) {
        s.channel = (await api('/integrations/shopify-example', 'POST', {})).channel_id;
        await save();
        const start = await api(`/integrations/${s.channel}/shopify-oauth/start`, 'POST', {
          translations_write: true,
        });
        await api('/oauth/shopify/finish', 'POST', { return_url: start.demo_return_url });
      }
      const ownChannel = (
        await pool.query(
          "SELECT ch.id FROM channels ch JOIN shopify_account_bindings b ON (b.tenant_id,b.channel_id)=(ch.tenant_id,ch.id) WHERE ch.tenant_id=$1 AND ch.id=$2 AND ch.provider='shopify' AND ch.settings->>'simulation'='true' AND b.source='simulation'",
          [s.tenant, s.channel],
        )
      ).rows;
      assert.equal(
        ownChannel.length,
        1,
        'Native QA must use its own completed local Shopify simulation',
      );
      s.deepl ??= (await api('/integrations/deepl-example', 'POST', {})).channel_id;
      await save();
      const definitions = [
        {
          sku: 'QA-SHOPIFY-096-A',
          name: 'Kubek stalowy 350 ml',
          description: 'Kubek ze stali nierdzewnej. Pojemność 350 ml.',
          price: 3000,
          review: {
            name: 'Stahlbecher 350 ml',
            description: 'Becher aus Edelstahl. Volumen 350 ml.',
          },
          variant: 'gid://shopify/ProductVariant/701',
          remote: 'gid://shopify/Product/702',
        },
        {
          sku: 'QA-SHOPIFY-096-B',
          name: 'Termos stalowy 500 ml',
          description: 'Termos ze stali nierdzewnej. Pojemność 500 ml.',
          price: 4500,
          review: {
            name: 'Edelstahl-Thermosflasche 500 ml',
            description: 'Thermosflasche aus Edelstahl. Volumen 500 ml.',
          },
          variant: 'gid://shopify/ProductVariant/703',
          remote: 'gid://shopify/Product/704',
        },
      ];
      for (const [n, d] of definitions.entries()) {
        if (!s.products[n]) {
          s.products[n] = await api(
            '/products',
            'POST',
            {
              sku: d.sku,
              name: d.name,
              description: d.description,
              price: d.price,
              quantity: 10,
              warehouse_id: s.warehouse,
            },
            201,
          );
          await save();
        }
        let p = s.products[n];
        if (!s.drafts[n]) {
          const draft = await api(
            `/products/${p.id}/deepl/preview`,
            'POST',
            {
              version: p.version,
              client_key: randomUUID(),
              channel_id: s.deepl,
              source_lang: 'pl',
              target_lang: 'de',
              formality: 'default',
            },
            201,
          );
          s.drafts[n] = draft.id;
          await save();
          await api(`/deepl/drafts/${draft.id}/queue`, 'POST', {
            confirm_external: true,
            max_characters: draft.characters,
          });
        }
        const draftId = s.drafts[n];
        let draft: any;
        for (let i = 0; i < 100; i++) {
          draft = (await api(`/products/${p.id}/deepl`)).data.find((r: any) => r.id === draftId);
          assert(draft);
          if (['ready', 'applied'].includes(draft.state)) break;
          assert(!['failed', 'cancelled'].includes(draft.state));
          await setTimeout(100);
        }
        assert(['ready', 'applied'].includes(draft.state), 'Own DeepL simulation did not finish');
        if (draft.state === 'ready')
          await api(`/deepl/drafts/${draftId}/apply`, 'POST', {
            approve: true,
            version: p.version,
            ...d.review,
          });
        p = await api(`/products/${p.id}`);
        assert.equal(p.version, 2);
        assert.equal(p.name, d.name);
        assert.equal(p.price, d.price);
        s.products[n] = p;
        await save();
        if (!s.listings[n]) {
          s.listings[n] = await api(`/integrations/${s.channel}/mappings`, 'POST', {
            external_id: d.variant,
            sku: p.sku,
          });
          await save();
          // Explicit synthetic identities of two independent products, restricted
          // to this QA firm's already verified DEMO channel. No provider write.
          const updated = await pool.query(
            "UPDATE listings l SET last_result=jsonb_build_object('product_id',$4::text,'sku',$5::text,'fixture','QA096_local_translation_only') FROM channels ch WHERE (ch.tenant_id,ch.id)=(l.tenant_id,l.channel_id) AND l.tenant_id=$1 AND l.id=$2 AND l.product_id=$3 AND l.channel_id=$6 AND ch.provider='shopify' AND ch.settings->>'simulation'='true' AND l.external_id=$7",
            [s.tenant, s.listings[n].id, p.id, d.remote, p.sku, s.channel, d.variant],
          );
          assert.equal(updated.rowCount, 1);
        }
      }
      s.product = s.products[0];
      s.stockBefore = (
        await pool.query('SELECT to_jsonb(s) row FROM stock s WHERE tenant_id=$1 ORDER BY 1', [
          s.tenant,
        ])
      ).rows;
      s.publicationProductsBefore = s.products;
      await save();
      console.log({
        ready_for_UI: true,
        email: s.email,
        products: s.products.map((p: any) => ({
          id: p.id,
          sku: p.sku,
          version: p.version,
          price: p.price,
        })),
        channel: s.channel,
        local_language: 'de',
        target_language: 'de',
        simulation: true,
        external_requests: 0,
      });
    } else {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      if (phase === 'order' || phase === 'finish-order') {
        const p = s.product;
        if (phase === 'order') {
          assert(!s.order);
          s.order = (
            await api(
              '/orders',
              'POST',
              {
                customer_name: 'Kupujący QA96',
                email: 'qa-shopify-buyer@example.test',
                warehouse_id: s.warehouse,
                items: [{ product_id: p.id, quantity: 2 }],
              },
              201,
            )
          ).id;
          await save();
          for (const status of ['paid', 'picking'])
            await api(`/orders/${s.order}/status`, 'PATCH', { status });
          for (let i = 0; i < 2; i++) await api(`/orders/${s.order}/scan`, 'POST', { code: p.sku });
          await api(`/orders/${s.order}/status`, 'PATCH', { status: 'packed' });
          await api(`/orders/${s.order}/ship-demo`, 'POST', {});
          s.invoice = (await api(`/orders/${s.order}/documents`, 'POST', { kind: 'invoice' })).id;
          const current = await api(`/orders/${s.order}`),
            item = current.items[0];
          s.return_id = (
            await api(
              `/orders/${s.order}/returns`,
              'POST',
              {
                client_key: randomUUID(),
                kind: 'return',
                reason: 'QA96 pełny zwrot po masowej publikacji tłumaczeń Shopify',
                items: [{ item_id: item.id, quantity: 2 }],
              },
              201,
            )
          ).id;
          await save();
          await api(`/returns/${s.return_id}/receive`, 'POST', {
            version: (await api(`/returns/${s.return_id}`)).version,
            items: [{ item_id: item.id, accepted: 2, restocked: 2 }],
            note: 'QA96',
          });
          s.correction = (await api(`/returns/${s.return_id}/document`, 'POST', {})).id;
        } else {
          // Recover only already completed own OMS evidence after an assertion
          // failure. No status, shipment, receipt or document is replayed.
          assert(s.order && s.return_id && s.invoice);
          assert(!s.ids.includes(s.tenant));
          const r = await api(`/returns/${s.return_id}`);
          assert.equal(r.tenant_id, s.tenant);
          assert.equal(r.order_id, s.order);
          assert(r.received_at);
          assert.equal(r.items.length, 1);
          assert.equal(r.items[0].requested, 2);
          assert.equal(r.items[0].accepted, 2);
          assert.equal(r.items[0].restocked, 2);
          const docs = (
            await pool.query(
              "SELECT d.id,d.data,d.number FROM documents d JOIN return_cases r ON (r.tenant_id,r.order_id,r.id)=(d.tenant_id,d.order_id,d.return_id) WHERE d.tenant_id=$1 AND d.order_id=$2 AND d.return_id=$3 AND d.kind='correction' AND d.mode='demo'",
              [s.tenant, s.order, s.return_id],
            )
          ).rows;
          assert.equal(docs.length, 1);
          assert.equal(docs[0].data.original.id, s.invoice);
          assert.equal(docs[0].data.return_id, s.return_id);
          assert.equal(docs[0].data.total, -6000);
          s.correction = docs[0].id;
        }

        s.finalOrder = await api(`/orders/${s.order}`);
        assert.equal(s.finalOrder.total, 6000);
        s.finalProduct = await api(`/products/${p.id}`);
        assert.equal(s.finalProduct.version, 2);
        assert.equal(s.finalProduct.price, 3000);
        assert.equal(
          s.finalProduct.stock.reduce((n: number, r: any) => n + Number(r.on_hand), 0),
          10,
        );
        assert.equal(
          s.finalProduct.stock.reduce((n: number, r: any) => n + Number(r.reserved), 0),
          0,
        );
        s.finalProducts = [];
        for (const product of s.products)
          s.finalProducts.push(await api(`/products/${product.id}`));
        s.stockVersionChanges = verifyOwnProducts(s, s.finalProducts);
        assert.deepEqual(
          stockRowsBusiness(
            (
              await pool.query(
                'SELECT to_jsonb(s) row FROM stock s WHERE tenant_id=$1 ORDER BY 1',
                [s.tenant],
              )
            ).rows,
          ),
          stockRowsBusiness(s.stockBefore),
        );
        await save();
        console.log({ order: s.finalOrder.number, total: 6000, full_return: true, stock: '10/0' });
      } else if (phase === 'verify') {
        assert(s.finalOrder && s.finalProducts, 'Run own OMS order/return phase before verify');
        const history = await api('/shopify-translation-batches');
        assert(history.available);
        assert(!history.read_only);
        assert.equal(history.meta.cursor, null, 'Own QA history must fit in one explicit page');
        const batches = [],
          plans = [];
        const expected = s.products.map((p: any) => p.id).sort();
        for (const head of history.data) {
          const batch = await api(`/shopify-translation-batches/${head.id}`);
          assert.equal(batch.summary.total, 2);
          assert.deepEqual(batch.items.map((i: any) => i.product_id).sort(), expected);
          assert.equal(batch.local_locale, 'de');
          assert.equal(batch.target_locale, 'de');
          assert.equal(batch.channel_id, s.channel);
          assert(batch.simulation);
          for (const item of batch.items) {
            const p = await api(`/shopify-translation-plans/${item.plan_id}`);
            assert.equal(p.product_id, item.product_id);
            assert.equal(
              p.listing_id,
              s.listings[s.products.findIndex((product: any) => product.id === item.product_id)].id,
            );
            assert(p.remote_snapshot.simulation);
            assert.equal(p.local_snapshot.product_version, 2);
            assert.equal(p.local_snapshot.translation.version, 1);
            if (p.state === 'done') {
              assert(p.result.confirmed);
              assert.equal(p.result.fields.length, 2);
              assert(p.result.fields.every((f: any) => f.confirmed));
            }
            plans.push(p);
          }
          batches.push(batch);
        }
        const attempted = batches.find(
          (b: any) => b.summary.done === 2 && b.items.every((i: any) => i.plan.attempted_at),
        );
        const noop = batches.find(
          (b: any) => b.summary.done === 2 && b.items.every((i: any) => !i.plan.attempted_at),
        );
        const cancelled = batches.find(
          (b: any) => b.summary.cancelled === 2 && b.items.every((i: any) => !i.plan.attempted_at),
        );
        assert(attempted, 'UI must publish both reviewed SKU and confirm by readback');
        assert(noop, 'UI must queue a second explicit batch which finishes without writes');
        assert(cancelled, 'UI must cancel a third frozen two-SKU preview before any attempt');
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM shopify_translation_claims c JOIN shopify_translation_plans p ON p.id=c.plan_id WHERE p.tenant_id=$1',
              [s.tenant],
            )
          ).rows[0].n,
          0,
        );
        assert.deepEqual(await api(`/orders/${s.order}`), s.finalOrder);
        const finalProducts = [];
        for (const p of s.products) finalProducts.push(await api(`/products/${p.id}`));
        assert.deepEqual(finalProducts, s.finalProducts);
        s.stockVersionChanges = verifyOwnProducts(s, finalProducts);
        assert.deepEqual(
          stockRowsBusiness(
            (
              await pool.query(
                'SELECT to_jsonb(s) row FROM stock s WHERE tenant_id=$1 ORDER BY 1',
                [s.tenant],
              )
            ).rows,
          ),
          stockRowsBusiness(s.stockBefore),
        );
        assert.deepEqual(await baseline(s.ids), s.before);
        assert.equal(
          hash(
            (
              await pool.query(
                'SELECT id,email,name,password_hash FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
                [s.userIds],
              )
            ).rows,
          ),
          s.usersHash,
        );
        for (const table of ['shopify_translation_batches', 'shopify_translation_batch_items'])
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::int n FROM ${table} WHERE tenant_id=ANY($1::uuid[])`,
                [s.ids],
              )
            ).rows[0].n,
            0,
          );
        s.batches = batches.map((b: any) => b.id);
        s.plans = plans.map((p: any) => p.id);
        s.batch = attempted.id;
        s.plan = attempted.items[0].plan_id;
        await save();
        const report = {
          stage: '096',
          health,
          scope: 'own_local_simulation',
          provider_authenticated: false,
          external_writes: 0,
          goal_complete: false,
          local_language: 'de',
          target_language: 'de',
          batches: batches.map((b: any) => ({
            id: b.id,
            state: b.state,
            batch_state: b.batch_state,
            summary: b.summary,
            items: b.items.map((i: any) => ({
              sku: i.sku,
              product_id: i.product_id,
              plan_id: i.plan_id,
              state: i.state,
              attempted: !!i.plan.attempted_at,
              confirmed: i.plan.result.confirmed ?? false,
            })),
          })),
          plans: plans.map((p: any) => ({
            id: p.id,
            state: p.state,
            phase: p.phase,
            attempted: !!p.attempted_at,
            confirmed: p.result.confirmed ?? false,
            fields: p.result.fields ?? [],
            observations: p.observations.length,
            remote_product_id: p.remote_product_id,
            remote_variant_id: p.remote_variant_id,
          })),
          products: finalProducts.map((p: any) => ({
            sku: p.sku,
            source_name: p.name,
            version: p.version,
            price: p.price,
            stock: p.stock.map((r: any) => ({ on_hand: r.on_hand, reserved: r.reserved })),
          })),
          order: s.finalOrder.number,
          total: s.finalOrder.total,
          full_return: true,
          stock_version_changes: s.stockVersionChanges,
          stock_verification_scope:
            'Business quantities and catalog are preserved; own OMS increments product A stock version by3, product B remains unchanged',
          prior_firms: s.ids.length,
          prior_users: s.userIds.length,
          preserved_tables: tables.length + 1,
          preserved: true,
          checked_at: new Date().toISOString(),
        };
        await writeFile(
          'docs/shopify-translation-batches-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      } else throw Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
