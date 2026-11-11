import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure } from './errors';
import { catalogStockControlAvailable } from './catalog-stock-control';
import type { CatalogStockControlActor } from './catalog-stock-control-schema';
import type { CatalogStockCountDocument, CatalogStockCountSource } from './catalog-stock-count-effects';

/** Call from the native execution read transaction, after its own access check.
 * The public projection contains document headings only, never layer costs. */
export async function catalogStockCountDocumentsInTx(c: PoolClient, a: CatalogStockControlActor,
  protocol: CatalogStockCountSource['protocol'], executionId: string): Promise<CatalogStockCountDocument[]> {
  const id = z.uuid().parse(executionId);
  const table = protocol === 'inventory_bulk' ? 'inventory_bulk_edit_executions' : 'stock_file_import_executions';
  ensure((await c.query(`SELECT 1 FROM public.${table} WHERE tenant_id=$1 AND id=$2`,[a.tenantId,id])).rowCount === 1,
    404,'Nie znaleziono własnego wykonania pomiaru');
  const context = (await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(context.owner === 'postgres' && ['postgres','dyna_app'].includes(context.role) && context.tenant === a.tenantId,
    403,'Nieprawidłowy kontekst odczytu dokumentów pomiaru');
  if (context.role === 'dyna_app') await c.query('RESET ROLE');
  let failed = false;
  try {
    if (!await catalogStockControlAvailable(c)) return [];
    const field = protocol === 'inventory_bulk' ? 'inventory_execution_id' : 'stock_file_execution_id';
    const rows = (await c.query(`SELECT d.id,d.receipt_id,a.source_id,a.protocol,d.warehouse_id,d.kind,
      d.number,d.year,d.sequence::text,d.series_id,
      (SELECT count(*)::integer FROM public.catalog_stock_count_rows x WHERE (x.tenant_id,x.document_id)=(d.tenant_id,d.id)) row_count,
      (SELECT sum(abs(x.delta::bigint))::text FROM public.catalog_stock_count_rows x WHERE (x.tenant_id,x.document_id)=(d.tenant_id,d.id)) quantity,
      (a.frame->>'wms_enabled')::boolean wms_enabled,r.created_at
      FROM public.catalog_stock_count_receipts r
      JOIN public.catalog_stock_count_admissions a ON(a.tenant_id,a.id)=(r.tenant_id,r.admission_id)
      JOIN public.catalog_stock_count_documents d ON(d.tenant_id,d.receipt_id)=(r.tenant_id,r.id)
      WHERE r.tenant_id=$1 AND r.${field}=$2 AND a.protocol=$3
      ORDER BY d.warehouse_id,d.kind,d.id LIMIT 201`,[a.tenantId,id,protocol])).rows;
    ensure(rows.length <= 200,413,'Pełny zestaw dokumentów pomiaru przekracza limit');
    return rows.map(row => ({...row,created_at:row.created_at.toISOString()}));
  } catch (error) { failed = true; throw error; }
  finally {
    if (context.role === 'dyna_app') {
      if (failed) await c.query('SET LOCAL ROLE dyna_app').catch(() => {});
      else await c.query('SET LOCAL ROLE dyna_app');
    }
  }
}
