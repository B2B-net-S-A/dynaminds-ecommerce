import { bootstrapCrmTenantInOwnerTx } from './crm-bootstrap';
import { randomUUID } from 'node:crypto';
import { pool } from './db';
import { hashPassword } from './security';
import { beginDispatchTransaction, endDispatchTransaction, finalizeDispatchActorsInTx } from './dispatch-transaction';
import { beginCatalogStockControlTransaction, endCatalogStockControlTransaction,
  catalogStockControlAdmissionInTx, finalizeCatalogStockControlActorsInTx, finalizeCatalogStockCountTerminalInTx } from './catalog-stock-control-transaction';
import { beginPurchasingTransaction, endPurchasingTransaction, purchasingStockAdmissionInTx } from './purchasing-transaction';
import {
  beginWmsTransaction,
  endWmsTransaction,
  finalizeWmsActorsInTx,
  wmsLotsAdmissionInTx,
} from './wms-lots-transaction';
import {
  createOrder,
  transition,
  scan,
  shipDemo,
  issueDocument,
  type Actor,
  orderSchema,
} from './domain';
export const DEMO_TENANT = '11111111-1111-4111-8111-111111111111';
export const SECOND_TENANT = '22222222-2222-4222-8222-222222222222';
export async function seed() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    beginWmsTransaction(c);
    beginDispatchTransaction(c);
    beginPurchasingTransaction(c);
    beginCatalogStockControlTransaction(c);
    await c.query('SELECT pg_advisory_xact_lock(982377)');
    if ((await c.query('SELECT 1 FROM tenants WHERE id=$1', [DEMO_TENANT])).rowCount) {
      await finalizeCatalogStockCountTerminalInTx(c);
      await c.query('COMMIT');
      return;
    }
    const admin = randomUUID(),
      viewer = randomUUID(),
      operator = randomUUID(),
      other = randomUUID();
    for (const [id, email, name] of [
      [admin, 'admin@demo.local', 'Aleksandra Nowak'],
      [viewer, 'viewer@demo.local', 'Podgląd'],
      [operator, 'operator@demo.local', 'Magazynier'],
      [other, 'other@demo.local', 'Druga organizacja'],
    ])
      await c.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
        id,
        email,
        name,
        hashPassword('DynaDemo!2026'),
      ]);
    await c.query('INSERT INTO tenants(id,name) VALUES($1,$2),($3,$4)', [
      DEMO_TENANT,
      'DYNAMINDS Demo',
      SECOND_TENANT,
      'Druga firma — izolacja',
    ]);
    await bootstrapCrmTenantInOwnerTx(c, DEMO_TENANT);
    await bootstrapCrmTenantInOwnerTx(c, SECOND_TENANT);
    for (const tenantId of [DEMO_TENANT, SECOND_TENANT].sort()) {
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await wmsLotsAdmissionInTx(c, { tenantId });
    }
    for (const tenantId of [DEMO_TENANT, SECOND_TENANT].sort()) {
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await purchasingStockAdmissionInTx(c, { tenantId });
    }
    for (const tenantId of [DEMO_TENANT, SECOND_TENANT].sort()) {
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await catalogStockControlAdmissionInTx(c, { tenantId });
    }
    await c.query("SELECT set_config('app.tenant_id','',true)");
    for (const [id, t, role] of [
      [admin, DEMO_TENANT, 'admin'],
      [viewer, DEMO_TENANT, 'viewer'],
      [operator, DEMO_TENANT, 'operator'],
      [other, SECOND_TENANT, 'admin'],
    ])
      await c.query('INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,$3)', [
        id,
        t,
        role,
      ]);
    const warehouse = randomUUID(),
      secondWarehouse = randomUUID();
    await c.query(
      'INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4),($5,$2,$6,$7)',
      [
        warehouse,
        DEMO_TENANT,
        'Warszawa • magazyn główny',
        'WAW',
        secondWarehouse,
        'Poznań • magazyn zapasowy',
        'POZ',
      ],
    );
    const otherWarehouse = randomUUID();
    await c.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4)', [
      otherWarehouse,
      SECOND_TENANT,
      'Magazyn drugiej firmy',
      'DRUGI',
    ]);
    const products = [
      ['LAMP-001', 'Lampa biurkowa Aura', '5901234123457', 14900, 'Dom i ogród', 120],
      ['BAG-002', 'Plecak miejski Nomad 20L', '5901234123464', 22900, 'Akcesoria', 86],
      ['CUP-003', 'Kubek ceramiczny Studio', '5901234123471', 4900, 'Dom i ogród', 250],
      ['HEAD-004', 'Słuchawki bezprzewodowe Air', '5901234123488', 31900, 'Elektronika', 64],
      ['BOTTLE-005', 'Butelka termiczna 750 ml', '5901234123495', 8900, 'Sport', 180],
      ['DESK-006', 'Organizer na biurko', '5901234123501', 7900, 'Dom i ogród', 42],
      ['CABLE-007', 'Przewód USB-C 2 m', '5901234123518', 3900, 'Elektronika', 350],
      ['MAT-008', 'Mata treningowa Flow', '5901234123525', 11900, 'Sport', 95],
    ];
    const ids: string[] = [];
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [DEMO_TENANT]);
    for (let n = 0; n < products.length; n++) {
      const [sku, name, ean, price, category, qty] = products[n],
        id = randomUUID();
      ids.push(id);
      await c.query(
        'INSERT INTO products(id,tenant_id,sku,name,ean,price,category) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, DEMO_TENANT, sku, name, ean, price, category],
      );
      for (const w of [warehouse, secondWarehouse])
        await c.query(
          'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,location) VALUES($1,$2,$3,$4,$5)',
          [DEMO_TENANT, w, id, w === warehouse ? qty : 20, `A-0${n + 1}`],
        );
    }
    const otherProduct = randomUUID();
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [SECOND_TENANT]);
    await c.query('INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,$3,$4,$5)', [
      otherProduct,
      SECOND_TENANT,
      'PRIVATE-001',
      'Produkt drugiej firmy',
      1000,
    ]);
    await c.query(
      'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,10)',
      [SECOND_TENANT, otherWarehouse, otherProduct],
    );
    const a: Actor = { tenantId: DEMO_TENANT, userId: admin, role: 'admin' };
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]);
    await wmsLotsAdmissionInTx(c, a);
    const names = [
      'Anna Kowalska',
      'Michał Wiśniewski',
      'Katarzyna Wójcik',
      'Piotr Kamiński',
      'Zofia Lewandowska',
      'Tomasz Zieliński',
      'Julia Szymańska',
      'Jakub Woźniak',
      'Natalia Dąbrowska',
      'Adam Mazur',
      'Maria Krawczyk',
      'Paweł Kaczmarek',
    ];
    for (let n = 0; n < names.length; n++) {
      const o = await createOrder(
        c,
        a,
        orderSchema.parse({
          customer_name: names[n],
          email: `klient${n + 1}@example.test`,
          warehouse_id: warehouse,
          source: 'demo',
          address: { street: `Testowa ${n + 1}`, city: 'Warszawa', postal_code: '00-001' },
          items: [{ product_id: ids[n % ids.length], quantity: (n % 3) + 1 }],
          shipping_cost: 1499,
        }),
      );
      if (n % 5 >= 1) await transition(c, a, o.id, 'paid');
      if (n % 5 >= 2) await transition(c, a, o.id, 'picking');
      if (n % 5 >= 3) {
        for (let s = 0; s < (n % 3) + 1; s++)
          await scan(c, a, o.id, String(products[n % ids.length][0]));
        await transition(c, a, o.id, 'packed');
      }
      if (n % 5 === 4) {
        await shipDemo(c, a, o.id);
        await issueDocument(c, a, o.id, 'invoice');
      }
    }
    await c.query(
      'INSERT INTO automation_rules(id,tenant_id,name,trigger,action,config,enabled) VALUES($1,$2,$3,$4,$5,$6,false)',
      [
        randomUUID(),
        DEMO_TENANT,
        'Notatka po opłaceniu',
        'order.paid',
        'add_note',
        JSON.stringify({ note: 'Opłacono — przygotuj do wysyłki.' }),
      ],
    );
    // Default custom status of the demo data (Uwagi v3 §0): "Problem", red, in the category Niezrealizowane.
    // A custom status (stage Nowe), not a new orders.status code: orders and its CHECK stay as they are.
    const problem = randomUUID();
    await c.query("INSERT INTO workflow_statuses(id,tenant_id,name,color,stage,active) VALUES($1,$2,'Problem','#D23B3B','paid',true)", [
      problem,
      DEMO_TENANT,
    ]);
    if ((await c.query("SELECT to_regclass('public.workflow_status267_categories') IS NOT NULL ok")).rows[0].ok)
      await c.query(
        "INSERT INTO workflow_status267_categories(tenant_id,workflow_status_id,category) VALUES($1,$2,'not_completed')",
        [DEMO_TENANT, problem],
      );
    await finalizeWmsActorsInTx(c);
    await finalizeCatalogStockControlActorsInTx(c);
    await finalizeDispatchActorsInTx(c);
    await finalizeCatalogStockCountTerminalInTx(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    endWmsTransaction(c);
    endDispatchTransaction(c);
    endPurchasingTransaction(c);
    endCatalogStockControlTransaction(c);
    c.release();
  }
}
