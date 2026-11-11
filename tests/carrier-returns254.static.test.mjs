/** Static checks of migration 254_carrier_returns (carrier return labels; prepared as 261, registered after 253;
 * docs/parity/CARRIER-DPD-INPOST-L3-20261028.md): own objects only, no core table altered, names outside every sealed
 * fingerprint family, no DELETE/TRUNCATE grant, durable rows, the manifest row pins the exact SQL bytes. No database. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
const root = new URL('../', import.meta.url);
const file = new URL('server/254_carrier_returns.sql', root);
const sql = await readFile(file, 'utf8');
const body = sql.replace(/^--.*$/gm, '');

test('only own carrier261_ objects; no core table altered, replaced or written', () => {
  const names = [...body.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX|FUNCTION|TRIGGER|POLICY) (?:public\.)?(\w+)/g)].map((m) => m[1]);
  assert.ok(names.length >= 8, names.join(','));
  for (const n of names) {
    if (n === 'tenant_scope') continue;
    assert.match(n, /^carrier261_/, n);
  }
  assert.doesNotMatch(body, /CREATE\s+OR\s+REPLACE/i);
  assert.doesNotMatch(body, /ALTER TABLE (?!public\.carrier261_)/);
  assert.doesNotMatch(body, /DROP |TRUNCATE public|DELETE FROM|UPDATE public\.|INSERT INTO public\./);
  for (const m of body.matchAll(/CREATE TRIGGER (\w+)[^;]* ON (public\.\w+)/g)) assert.equal(m[2], 'public.carrier261_returns', m[0]);
  for (const m of body.matchAll(/REFERENCES (public\.\w+)/g)) assert.ok(['public.users', 'public.channels'].includes(m[1]), m[0]);
});

test('names avoid every sealed fingerprint family (LIKE semantics, _ is any character)', () => {
  const families = [/^catalog.stock./, /^financial.return./, /^fa3.draft./, /^local.invoice./, /^buyer.address./, /^warehouse./, /^parcel.physical.wz./,
    /^ordinary18/, /^verdict241/, /^b2b.credit./, /^b2b.dropship./, /^b2b.invoice./, /^order.shipments./, /^shipment.label./, /^guard.verdict/];
  for (const m of body.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX|FUNCTION|TRIGGER) (?:public\.)?(\w+)/g))
    for (const f of families) assert.doesNotMatch(m[1], f, m[1]);
});

test('tenant RLS forced, append-only grants, guard and no-truncate triggers, one live return per shipment', () => {
  assert.match(body, /ENABLE ROW LEVEL SECURITY;\s*ALTER TABLE public\.carrier261_returns FORCE ROW LEVEL SECURITY;/);
  assert.match(body, /CREATE POLICY tenant_scope ON public\.carrier261_returns TO dyna_app USING\(tenant_id=nullif\(current_setting\('app\.tenant_id',true\),''\)::uuid\)/);
  assert.match(body, /GRANT SELECT,INSERT ON public\.carrier261_returns TO dyna_app;/);
  assert.match(body, /GRANT UPDATE\(state,phase,remote_id,tracking_number,label_base64,result,error,job_id,updated_at\) ON public\.carrier261_returns TO dyna_app;/);
  assert.doesNotMatch(body, /GRANT[^;]*(DELETE|TRUNCATE|ALL)/);
  assert.match(body, /BEFORE UPDATE OR DELETE ON public\.carrier261_returns/);
  assert.match(body, /BEFORE TRUNCATE ON public\.carrier261_returns/);
  assert.match(body, /CREATE UNIQUE INDEX carrier261_return_live ON public\.carrier261_returns\(tenant_id,shipment_id\) WHERE state IN\('queued','label_ready','uncertain'\)/);
  assert.match(sql, /^-- Migration 254_carrier_returns \(prepared as 261, registered after 253_mirakl_webhook_retention; object names keep the\n-- carrier261_ prefix; docs\/parity\/CARRIER-DPD-INPOST-L3-20261028\.md\)\.\n/);
  assert.doesNotMatch(sql, /PREPARED|placeholder|INTEGRATION\.md/);
});

test('254 follows 253 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 254), row = RELEASE_MIGRATIONS[i];
  const b = readFileSync(file);
  assert(row, 'manifest row 254');
  assert.equal(row.name, '254_carrier_returns');
  assert.equal(row.file, '254_carrier_returns.sql');
  assert.equal(row.native_id, 'carrier_returns254');
  assert.equal(row.cold.contract, 'carrier-returns254');
  assert.equal(row.cold.project, 'projectCompiledCarrierReturns254Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 5678);
  assert.equal(row.sha256, '37b9394cd6cea92be2f4426c9092840abc14693f4981802b68441173387d7d5e');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '253_mirakl_webhook_retention');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '255_stock_verdict', '255 follows 254');
  assert.doesNotMatch(readFileSync(new URL('server/db.ts', root), 'utf8'), /carrier_returns/, 'db.ts takes 254 from the manifest, not a literal pair');
});
