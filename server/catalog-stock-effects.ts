import type { PoolClient } from 'pg';
import { ensure } from './errors';
import type { CatalogStockEffectAdmission, CatalogStockEffectProof } from './catalog-stock-control-schema';

const journalTables = {
  stock_movement_ids: 'stock_movements',
  location_movement_ids: 'stock_location_movements',
  layer_movement_ids: 'wms_layer_movements',
} as const;
type JournalKey = keyof typeof journalTables;
type Baseline = Readonly<{ admission: CatalogStockEffectAdmission }>;
const baselines = new WeakMap<Baseline, {
  client: PoolClient;
  ids: Record<JournalKey, Set<string>>;
}>();

// Read only journals born in this transaction. Existing journal history is not
// loaded into the server or mistaken for proof of the current physical write.
async function journals(c: PoolClient, admission: CatalogStockEffectAdmission) {
  const p=(await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(p.owner==='postgres'&&['postgres','dyna_app'].includes(p.role)&&p.tenant===admission.tenant_id,403,'Obcy kontekst dowodu ruchów');
  if(p.role==='dyna_app')await c.query('RESET ROLE');let failed=false;
  try{
  const result = {} as Record<JournalKey, Set<string>>;
  for (const key of Object.keys(journalTables) as JournalKey[]) {
    const rows = (await c.query(
      `SELECT id FROM public.${journalTables[key]}
       WHERE tenant_id=$1 AND warehouse_id=ANY($2::uuid[])
         AND product_id=ANY($3::uuid[]) AND public.catalog_stock_control_owns_xmin(xmin)
       ORDER BY id LIMIT 10001`,
      [admission.tenant_id, admission.source.warehouse_ids, admission.source.product_ids],
    )).rows;
    ensure(rows.length <= 10000, 413, 'Pełny dowód ruchów magazynowych przekracza limit');
    result[key] = new Set(rows.map(row => row.id as string));
  }
  return result;
  }catch(e){failed=true;throw e;}finally{
    if(p.role==='dyna_app'){if(failed)await c.query('SET LOCAL ROLE dyna_app').catch(()=>{});else await c.query('SET LOCAL ROLE dyna_app');}
  }
}

export async function captureCatalogStockEffectJournalsInTx(
  c: PoolClient, admission: CatalogStockEffectAdmission | null,
): Promise<Baseline | null> {
  if (!admission) return null;
  const baseline = Object.freeze({ admission });
  baselines.set(baseline, { client: c, ids: await journals(c, admission) });
  return baseline;
}

export async function catalogStockEffectProofInTx(
  c: PoolClient, baseline: Baseline,
  links: Pick<CatalogStockEffectProof, 'warehouse_document_id' | 'operation_id' | 'location_operation_id' | 'receipt_id'>,
): Promise<CatalogStockEffectProof> {
  const retained = baselines.get(baseline);
  ensure(retained?.client === c, 409, 'Brak zachowanego źródła ruchów magazynowych');
  const current = await journals(c, baseline.admission);
  const result = { ...links } as CatalogStockEffectProof;
  for (const key of Object.keys(journalTables) as JournalKey[]) {
    ensure([...retained.ids[key]].every(id => current[key].has(id)), 409,
      'Historia ruchów w tej transakcji została zmieniona');
    result[key] = [...current[key]].filter(id => !retained.ids[key].has(id));
  }
  return result;
}
