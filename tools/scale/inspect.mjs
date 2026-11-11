// Read-only checks on the scale database: the ten guards and per-tenant counts.
import pg from 'pg';

export const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards',
  'ordinary188_structure_valid', 'return_credit211_metadata_valid', 'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid',
  'local_invoice_guards'];

async function readOnly(url, timeoutMs, fn) {
  const c = new pg.Client({ connectionString: url, options: '-c jit=off -c timezone=UTC' });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query('SET LOCAL search_path TO "$user",public');
    await c.query(`SET LOCAL statement_timeout='${Math.trunc(timeoutMs)}ms'`);
    const out = await fn(c);
    await c.query('ROLLBACK');
    return out;
  } finally { await c.end(); }
}

/** { values: {guard: bool}, ms: {guard: duration}, all_true } */
export function checkGuards(url, timeoutMs = 60000) {
  return readOnly(url, timeoutMs, async (c) => {
    const values = {}, ms = {};
    for (const g of GUARDS) {
      const t = performance.now();
      values[g] = (await c.query(`SELECT public.${g}() v`)).rows[0].v;
      ms[g] = Math.round(performance.now() - t);
    }
    return { values, ms, all_true: Object.values(values).every((v) => v === true) };
  });
}

export function tenantCounts(url, tenantIds) {
  return readOnly(url, 120000, async (c) => {
    const one = async (sql) => (await c.query(sql, [tenantIds])).rows;
    const by = (rows, key = 'tenant_id') => rows.reduce((m, r) => { (m[r[key]] ??= {})[r.k] = Number(r.n); return m; }, {});
    return {
      products: by(await one('SELECT tenant_id,kind k,count(*) n FROM products WHERE tenant_id=ANY($1) GROUP BY 1,2')),
      orders: by(await one('SELECT tenant_id,status k,count(*) n FROM orders WHERE tenant_id=ANY($1) GROUP BY 1,2')),
      order_items: by(await one("SELECT tenant_id,'lines' k,count(*) n FROM order_items WHERE tenant_id=ANY($1) GROUP BY 1")),
      documents: by(await one('SELECT tenant_id,mode k,count(*) n FROM documents WHERE tenant_id=ANY($1) GROUP BY 1,2')),
      returns: by(await one('SELECT tenant_id,state k,count(*) n FROM return_cases WHERE tenant_id=ANY($1) GROUP BY 1,2')),
      payments: by(await one('SELECT tenant_id,kind k,count(*) n FROM payment_entries WHERE tenant_id=ANY($1) GROUP BY 1,2')),
      warehouses: by(await one("SELECT tenant_id,'warehouses' k,count(*) n FROM warehouses WHERE tenant_id=ANY($1) GROUP BY 1")),
      stock_locations: by(await one("SELECT tenant_id,'distinct_locations' k,count(DISTINCT (warehouse_id,location)) n FROM stock WHERE tenant_id=ANY($1) GROUP BY 1")),
      customers: by(await one("SELECT tenant_id,'distinct_emails' k,count(DISTINCT email) n FROM orders WHERE tenant_id=ANY($1) GROUP BY 1")),
      created_at: by((await one("SELECT tenant_id,'oldest' k,extract(epoch FROM min(created_at))*1000 n FROM orders WHERE tenant_id=ANY($1) GROUP BY 1 UNION ALL SELECT tenant_id,'newest',extract(epoch FROM max(created_at))*1000 FROM orders WHERE tenant_id=ANY($1) GROUP BY 1"))),
    };
  });
}

export function databaseStats(url) {
  return readOnly(url, 30000, async (c) => (await c.query(
    'SELECT tup_inserted::bigint ins,tup_updated::bigint upd,xact_commit::bigint commits,pg_database_size(current_database())::bigint bytes FROM pg_stat_database WHERE datname=current_database()')).rows[0]);
}

/** clock_timestamp() of a fresh session in ms (simulated clock probe). */
export async function clockProbe(url) {
  const c = new pg.Client({ connectionString: url, options: '-c jit=off -c timezone=UTC' });
  await c.connect();
  try { return Number((await c.query('SELECT extract(epoch FROM clock_timestamp())*1000 ms')).rows[0].ms); } finally { await c.end(); }
}

const HISTORY_TABLES = ['orders', 'order_events', 'documents', 'payment_entries', 'stock_movements', 'return_cases', 'warehouse_documents', 'wms_lots', 'wms_operations'];
/** Per tenant and table: rows, oldest/newest created_at and the number of distinct UTC days. */
export function historySpread(url, tenantIds) {
  return readOnly(url, 120000, async (c) => {
    const out = {};
    for (const t of HISTORY_TABLES) {
      const has = (await c.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name IN ('tenant_id','created_at')`, [t])).rows[0].n === 2;
      if (!has) continue;
      for (const r of (await c.query(`SELECT tenant_id, count(*)::int n, min(created_at) oldest, max(created_at) newest,
          count(DISTINCT (created_at AT TIME ZONE 'UTC')::date)::int days FROM ${t} WHERE tenant_id=ANY($1) GROUP BY 1`, [tenantIds])).rows)
        (out[r.tenant_id] ??= {})[t] = { rows: r.n, oldest: r.oldest.toISOString(), newest: r.newest.toISOString(), days: r.days };
    }
    return out;
  });
}

/**
 * WMS lot evidence per tenant: policy, lots by origin, cost layers by known/zero/unknown cost, operations by
 * kind, bundle lines, and a FIFO replay: orders in plan order reserve layers; a reservation is a FIFO
 * violation when an earlier layer (fifo_sequence) of the same product and warehouse still had units that
 * no earlier order held (cancellations give their units back right after their own reservation; return
 * restocks are not credited, which can only hide a violation, never invent one).
 */
export function wmsCounts(url, tenantIds) {
  return readOnly(url, 120000, async (c) => {
    const q = async (sql) => (await c.query(sql, [tenantIds])).rows;
    const out = {};
    const put = (rows, key) => { for (const r of rows) { const { tenant_id, ...v } = r; ((out[tenant_id] ??= {})[key] ??= []).push(v); } };
    put(await q('SELECT tenant_id,enabled,version::text,currency FROM wms_policies WHERE tenant_id=ANY($1)'), 'policy');
    put(await q('SELECT tenant_id,origin,count(*)::int n,count(expiry_date)::int with_expiry FROM wms_lots WHERE tenant_id=ANY($1) GROUP BY 1,2 ORDER BY 1,2'), 'lots');
    put(await q(`SELECT tenant_id,CASE WHEN unit_cost_minor IS NULL THEN 'unknown' WHEN unit_cost_minor=0 THEN 'zero' ELSE 'known' END cost,count(*)::int layers,sum(quantity_received)::int units
      FROM wms_cost_layers WHERE tenant_id=ANY($1) GROUP BY 1,2 ORDER BY 1,2`), 'cost_layers');
    put(await q('SELECT tenant_id,kind,count(*)::int n FROM wms_operations WHERE tenant_id=ANY($1) GROUP BY 1,2 ORDER BY 1,2'), 'operations');
    put(await q(`SELECT o.tenant_id,count(*)::int lines,count(DISTINCT o.id)::int orders FROM order_items i JOIN orders o ON o.id=i.order_id
      JOIN products p ON p.id=i.product_id WHERE o.tenant_id=ANY($1) AND p.kind='bundle' GROUP BY 1`), 'bundle_lines');
    const layers = await q(`SELECT l.tenant_id,l.id,l.product_id,l.fifo_sequence::text seq,l.quantity_received q,x.warehouse_id
      FROM wms_cost_layers l JOIN LATERAL (SELECT warehouse_id FROM wms_layer_positions p WHERE p.layer_id=l.id LIMIT 1) x ON true
      WHERE l.tenant_id=ANY($1) ORDER BY l.fifo_sequence`);
    const res = await q(`SELECT a.tenant_id,a.order_id,a.product_id,a.warehouse_id,a.layer_id,a.quantity,a.released_quantity,o.note
      FROM wms_reservation_layers a JOIN orders o ON o.id=a.order_id WHERE a.tenant_id=ANY($1)`);
    const avail = new Map(), byKey = new Map();
    for (const l of layers) {
      avail.set(l.id, l.q);
      const k = `${l.tenant_id}|${l.warehouse_id}|${l.product_id}`;
      (byKey.get(k) ?? byKey.set(k, []).get(k)).push(l);
    }
    const ord = (n) => Number(String(n).slice(String(n).lastIndexOf(':') + 1));
    res.sort((x, y) => ord(x.note) - ord(y.note) || String(x.layer_id).localeCompare(String(y.layer_id)));
    const fifo = {};
    let i = 0;
    while (i < res.length) {
      const order = res[i].order_id, group = [];
      while (i < res.length && res[i].order_id === order) group.push(res[i++]);
      const chainOf = (r) => byKey.get(`${r.tenant_id}|${r.warehouse_id}|${r.product_id}`) ?? [];
      const posOf = (r) => chainOf(r).findIndex((l) => l.id === r.layer_id);
      group.sort((x, y) => String(x.product_id).localeCompare(String(y.product_id)) || posOf(x) - posOf(y));
      for (const r of group) {
        const f = (fifo[r.tenant_id] ??= { reservations: 0, units: 0, from_later_layers: 0, violations: 0 });
        const chain = chainOf(r), pos = posOf(r);
        if (pos > 0) f.from_later_layers++;
        if (chain.slice(0, Math.max(0, pos)).some((l) => avail.get(l.id) > 0)) f.violations++;
        f.reservations++; f.units += r.quantity;
        avail.set(r.layer_id, (avail.get(r.layer_id) ?? 0) - r.quantity);
      }
      for (const r of group) if (r.released_quantity) avail.set(r.layer_id, avail.get(r.layer_id) + r.released_quantity);
    }
    for (const [t, f] of Object.entries(fifo)) (out[t] ??= {}).fifo = f;
    return out;
  });
}
