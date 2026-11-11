import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { encrypt, decrypt } from './security';
import {
  bankCodProfile,
  parseBankCodCsv,
  BANK_COD_CSV_VERSION,
  BankCodCsvError,
  type BankCodProfile,
  type BankCodParsedRow,
} from './bank-cod-csv';
import {
  paymentBalance,
  recordFinancialPaymentInTx,
  reverseFinancialPaymentInTx,
} from './payments';

export const PAYMENT_IMPORT_JOB = 'payment.import';
const stable = (v: any): any =>
  v instanceof Date
    ? v.toISOString()
    : Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
export const paymentImportHash = (v: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(v)))
    .digest('hex');
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\x00-\x1f\x7f]/.test(v));
export const namespaceCreate = z.strictObject({
  client_key: z.uuid(),
  label: text(120),
  source_kind: z.enum(['bank_statement', 'carrier_report', 'shared_settlement']),
});
export const namespaceUpdate = z.strictObject({
  version: z.number().int().positive(),
  label: text(120),
  enabled: z.boolean(),
});
export const profileCreate = z.strictObject({ client_key: z.uuid(), definition: bankCodProfile });
export const profileUpdate = z.strictObject({
  version: z.number().int().positive(),
  definition: bankCodProfile,
});
export const uploadInput = z.strictObject({
  client_key: z.uuid(),
  profile_id: z.uuid(),
  profile_version: z.number().int().positive(),
  filename: text(200),
  content_base64: z.string().min(4).max(6990508),
});
export const previewInput = z.strictObject({
  client_key: z.uuid(),
  file_id: z.uuid(),
  profile_id: z.uuid(),
  profile_version: z.number().int().positive(),
});
const resolution = z.discriminatedUnion('action', [
  z.strictObject({
    row_id: z.uuid(),
    action: z.literal('assign'),
    order_id: z.uuid(),
    shipment_id: z.uuid().optional(),
    reason: text(2000),
  }),
  z.strictObject({
    row_id: z.uuid(),
    action: z.literal('link_existing_receipt'),
    receipt_id: z.uuid(),
    reason: text(2000),
  }),
]);
export const resolveInput = z.strictObject({
  client_key: z.uuid(),
  version: z.number().int().positive(),
  resolutions: z.array(resolution).min(1).max(100),
});
export const importQueueInput = z.strictObject({
  client_key: z.uuid(),
  version: z.number().int().positive(),
  row_ids: z.array(z.uuid()).min(1).max(100),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  local_ledger_only: z.literal(true),
});
export const correctionPreviewInput = z.strictObject({
  client_key: z.uuid(),
  receipt_ids: z.array(z.uuid()).min(1).max(100),
  reason: text(2000),
});
export const correctionQueueInput = z.strictObject({
  client_key: z.uuid(),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  local_ledger_only: z.literal(true),
});
/** The current finance member, re-read from the database: the administrator, or (266, session only) the
 * accountant "Księgowa", who matches and confirms transfers in Przelewy i pobrania. */
export async function paymentImportAdmin(c: PoolClient, a: Actor) {
  const accountants =
    !a.apiKeyId &&
    (await c.query("SELECT to_regprocedure('public.accountant266_finance_member(uuid)') IS NOT NULL ok")).rows[0].ok;
  ensure(
    (await c.query(accountants ? 'SELECT accountant266_finance_member($1) ok' : 'SELECT offer_sync_is_admin($1) ok', [a.userId])).rows[0]?.ok,
    403,
    'Wymagany aktualny administrator finansów',
  );
}
async function admission(c: PoolClient, a: Actor) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'payment.import.admission:' + a.tenantId,
  ]);
}
async function executionLock(c: PoolClient, id: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'payment.import.execution:' + id,
  ]);
}
const flags = { current_role: 'admin', can_write: true };
async function namespaces(c: PoolClient) {
  return (await c.query('SELECT * FROM payment_import_namespaces ORDER BY id LIMIT 101')).rows;
}
export async function paymentImportNamespaces(a: Actor) {
  return tenantTx(a.tenantId, async (c) => {
    await paymentImportAdmin(c, a);
    return { ...flags, data: await namespaces(c), meta: { cursor: null } };
  });
}
export async function createPaymentImportNamespace(
  a: Actor,
  input: z.input<typeof namespaceCreate>,
) {
  const b = namespaceCreate.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    await paymentImportAdmin(c, a);
    const h = paymentImportHash(b),
      old = (
        await c.query('SELECT * FROM payment_import_namespaces WHERE client_key=$1', [b.client_key])
      ).rows[0];
    if (old) {
      ensure(old.request_hash === h, 409, 'Klucz wykorzystano z innymi danymi');
      return { ...old, reused: true };
    }
    ensure((await namespaces(c)).length < 100, 409, 'Limit 100 domen rozliczeń');
    const row = (
      await c.query(
        'INSERT INTO payment_import_namespaces(id,tenant_id,client_key,request_hash,label,source_kind) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [randomUUID(), a.tenantId, b.client_key, h, b.label, b.source_kind],
      )
    ).rows[0];
    await audit(c, a, 'payment.import.namespace.create', row.id, { source_kind: b.source_kind });
    return row;
  });
}
export async function updatePaymentImportNamespace(
  a: Actor,
  id: string,
  input: z.input<typeof namespaceUpdate>,
) {
  const b = namespaceUpdate.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    const old = (
      await c.query('SELECT * FROM payment_import_namespaces WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    await paymentImportAdmin(c, a);
    ensure(old, 404, 'Nie znaleziono domeny');
    ensure(old.version === b.version, 409, 'Domena zmieniła się');
    return (
      await c.query(
        'UPDATE payment_import_namespaces SET label=$2,enabled=$3,version=version+1 WHERE id=$1 RETURNING *',
        [id, b.label, b.enabled],
      )
    ).rows[0];
  });
}
async function namespacePolicy(c: PoolClient, id: string, p: BankCodProfile) {
  const n = (await c.query('SELECT * FROM payment_import_namespaces WHERE id=$1 FOR SHARE', [id]))
    .rows[0];
  ensure(n?.enabled, 409, 'Domena rozliczeń jest niedostępna');
  ensure(
    n.source_kind === 'shared_settlement' || n.source_kind === p.source_kind,
    422,
    'Format nie pasuje do domeny',
  );
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM payment_import_profiles WHERE namespace_id=$1 AND definition->>'transaction_id_scope'<>$2 LIMIT 1",
        [id, p.transaction_id_scope],
      )
    ).rowCount,
    409,
    'Zakres identyfikatorów domeny jest niezmienny',
  );
  if (p.match.channel_id)
    ensure(
      (await c.query('SELECT id FROM channels WHERE id=$1', [p.match.channel_id])).rowCount,
      404,
      'Kanał nie należy do firmy',
    );
  return n;
}
async function revision(c: PoolClient, a: Actor, p: any) {
  await c.query(
    'INSERT INTO payment_import_profile_revisions(tenant_id,profile_id,version,definition,actor_id,deleted) VALUES($1,$2,$3,$4,$5,$6)',
    [a.tenantId, p.id, p.version, JSON.stringify(p.definition), a.userId, !!p.deleted_at],
  );
}
export async function paymentImportProfiles(a: Actor, cursor?: string) {
  return tenantTx(a.tenantId, async (c) => {
    await paymentImportAdmin(c, a);
    const all = (
      await c.query(
        'SELECT * FROM payment_import_profiles WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 51',
        [cursor ?? null],
      )
    ).rows;
    return {
      ...flags,
      data: all.slice(0, 50),
      namespaces: await namespaces(c),
      channels: (await c.query('SELECT id,name,provider FROM channels ORDER BY name,id LIMIT 100'))
        .rows,
      meta: { cursor: all.length > 50 ? all[49].id : null },
    };
  });
}
export async function createPaymentImportProfile(a: Actor, input: z.input<typeof profileCreate>) {
  const b = profileCreate.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    await namespacePolicy(c, b.definition.source_namespace_id, b.definition);
    await paymentImportAdmin(c, a);
    const h = paymentImportHash(b),
      old = (
        await c.query('SELECT * FROM payment_import_profiles WHERE client_key=$1', [b.client_key])
      ).rows[0];
    if (old) {
      ensure(old.request_hash === h, 409, 'Klucz formatu ma inny zakres');
      return { ...old, reused: true };
    }
    ensure(
      (
        await c.query(
          'SELECT count(*)::int n FROM payment_import_profiles WHERE deleted_at IS NULL',
        )
      ).rows[0].n < 100,
      409,
      'Limit 100 formatów',
    );
    const p = (
      await c.query(
        'INSERT INTO payment_import_profiles(id,tenant_id,namespace_id,client_key,request_hash,definition,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [
          randomUUID(),
          a.tenantId,
          b.definition.source_namespace_id,
          b.client_key,
          h,
          JSON.stringify(b.definition),
          a.userId,
        ],
      )
    ).rows[0];
    await revision(c, a, p);
    return p;
  });
}
export async function updatePaymentImportProfile(
  a: Actor,
  id: string,
  input: z.input<typeof profileUpdate> | { version: number },
  remove = false,
) {
  const b = remove
    ? z.strictObject({ version: z.number().int().positive() }).parse(input)
    : profileUpdate.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    const old = (
      await c.query('SELECT * FROM payment_import_profiles WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    ensure(old, 404, 'Nie znaleziono formatu');
    if (!remove) {
      const d = (b as z.infer<typeof profileUpdate>).definition;
      ensure(d.source_namespace_id === old.namespace_id, 409, 'Domena formatu jest niezmienna');
      await namespacePolicy(c, old.namespace_id, d);
    }
    await paymentImportAdmin(c, a);
    ensure(!old.deleted_at && old.version === b.version, 409, 'Format zmienił się');
    const p = (
      await c.query(
        'UPDATE payment_import_profiles SET definition=$2,approved_by=$3,version=version+1,deleted_at=$4 WHERE id=$1 RETURNING *',
        [
          id,
          JSON.stringify(remove ? old.definition : (b as z.infer<typeof profileUpdate>).definition),
          a.userId,
          remove ? new Date() : null,
        ],
      )
    ).rows[0];
    await revision(c, a, p);
    return p;
  });
}
async function profilePolicy(
  c: PoolClient,
  a: Actor,
  id: string,
  version: number,
  checkOwner = true,
) {
  const p = (await c.query('SELECT * FROM payment_import_profiles WHERE id=$1 FOR SHARE', [id]))
    .rows[0];
  ensure(
    p && !p.deleted_at && p.version === version,
    409,
    'Format zmienił się lub jest niedostępny',
  );
  const definition = bankCodProfile.parse(p.definition),
    namespace = await namespacePolicy(c, p.namespace_id, definition);
  if (checkOwner) await paymentImportAdmin(c, { ...a, userId: p.approved_by });
  return { p, definition, namespace };
}
function parse(bytes: Buffer, p: BankCodProfile, a: Actor) {
  try {
    return parseBankCodCsv(bytes, p, { tenant_id: a.tenantId });
  } catch (e) {
    if (e instanceof BankCodCsvError) throw new Problem(422, e.message, e.code);
    throw e;
  }
}
export async function uploadPaymentImport(a: Actor, input: z.input<typeof uploadInput>) {
  const b = uploadInput.parse(input);
  ensure(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.content_base64),
    422,
    'Nieprawidłowe base64',
  );
  const bytes = Buffer.from(b.content_base64, 'base64');
  ensure(
    bytes.toString('base64') === b.content_base64 && bytes.length <= 5242880 && bytes.length > 0,
    422,
    'Nieprawidłowy lub za duży plik',
  );
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    const { definition } = await profilePolicy(c, a, b.profile_id, b.profile_version);
    await paymentImportAdmin(c, a);
    const parsed = parse(bytes, definition, a),
      h = paymentImportHash(b);
    const old = (
      await c.query('SELECT * FROM payment_import_upload_requests WHERE client_key=$1', [
        b.client_key,
      ])
    ).rows[0];
    if (old) {
      ensure(old.request_hash === h, 409, 'Klucz uploadu ma inny plik');
      return fileHead(
        (await c.query('SELECT * FROM payment_import_files WHERE id=$1', [old.file_id])).rows[0],
        true,
      );
    }
    let f = (
      await c.query('SELECT * FROM payment_import_files WHERE file_hash=$1', [parsed.file_hash])
    ).rows[0];
    const reused = !!f;
    if (!f) {
      const quota = (
        await c.query(
          'SELECT count(*)::int n,coalesce(sum(byte_count),0)::bigint bytes FROM payment_import_files',
        )
      ).rows[0];
      ensure(
        quota.n < 100 && BigInt(quota.bytes) + BigInt(bytes.length) <= 52428800n,
        409,
        'Limit dowodów: 100 plików / 50 MiB na firmę',
      );
      f = (
        await c.query(
          'INSERT INTO payment_import_files(id,tenant_id,file_hash,byte_count,encrypted_bytes,filename,parser_version,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [
            randomUUID(),
            a.tenantId,
            parsed.file_hash,
            bytes.length,
            encrypt({ content_base64: b.content_base64 }),
            b.filename,
            BANK_COD_CSV_VERSION,
            a.userId,
          ],
        )
      ).rows[0];
    }
    await c.query(
      'INSERT INTO payment_import_upload_requests(tenant_id,client_key,request_hash,file_id) VALUES($1,$2,$3,$4)',
      [a.tenantId, b.client_key, h, f.id],
    );
    await audit(c, a, 'payment.import.upload', f.id, {
      file_hash: f.file_hash,
      bytes: f.byte_count,
      rows: parsed.rows.length,
    });
    return fileHead(f, reused);
  });
}
const fileHead = (f: any, reused = false) => ({
  file_id: f.id,
  file_hash: f.file_hash,
  byte_count: f.byte_count,
  filename: f.filename,
  parser_version: f.parser_version,
  reused,
});

type FrozenRow = {
  row_id: string;
  position: number;
  classification: string;
  source: any;
  evidence: any;
  issues: any[];
  operation: 'apply' | 'link_existing' | 'reverse';
  allocation: any;
  snapshot: any;
  economic_key: string | null;
  payload_hash: string | null;
  linked_receipt_id: string | null;
};
async function financialSnapshot(c: PoolClient, id: string, shipment?: string) {
  const o = (
    await c.query(
      'SELECT id,number,version,total,currency,payment_mode,status,channel_id,external_id FROM orders WHERE id=$1',
      [id],
    )
  ).rows[0];
  ensure(o, 404, 'Nie znaleziono własnego zamówienia');
  const entries = (
    await c.query(
      'SELECT id,kind,amount,fee,currency,method,shipment_id,return_id,reversal_of,request FROM payment_entries WHERE order_id=$1 ORDER BY id',
      [id],
    )
  ).rows;
  const returns = (
    await c.query(
      'SELECT id,state,refund_amount,settlement FROM return_cases WHERE order_id=$1 ORDER BY id',
      [id],
    )
  ).rows;
  const sourceChecks = (
    await c.query(
      'SELECT id,state,source_amount,previous_amount,delta,currency,order_version,source_hash FROM source_payment_checks WHERE order_id=$1 ORDER BY id',
      [id],
    )
  ).rows;
  const guards = (
    await c.query(
      "SELECT id,state,phase,shipment_id FROM shipping_plans WHERE order_id=$1 AND state NOT IN ('cancelled','dispatched') AND phase IN ('create_started','numbers_ready','buy_started','refresh_started') ORDER BY id",
      [id],
    )
  ).rows;
  const s = shipment
    ? (
        await c.query(
          'SELECT id,order_id,carrier,tracking_number,dispatched_at,cod_expected FROM shipments WHERE order_id=$1 AND id=$2',
          [id, shipment],
        )
      ).rows[0]
    : null;
  if (shipment) ensure(s, 404, 'Przesyłka nie należy do zamówienia');
  const sums = shipment
    ? (
        await c.query(
          "SELECT coalesce(sum(p.amount) FILTER(WHERE coalesce(r.kind,p.kind)='courier_collection'),0)::bigint collected,coalesce(sum(p.amount::bigint+p.fee) FILTER(WHERE coalesce(r.kind,p.kind)='courier_remittance'),0)::bigint settled FROM payment_entries p LEFT JOIN payment_entries r ON r.id=p.reversal_of WHERE p.order_id=$1 AND p.shipment_id=$2",
          [id, shipment],
        )
      ).rows[0]
    : null;
  return {
    order: o,
    balance: await paymentBalance(c, id),
    ledger_hash: paymentImportHash(entries),
    source_evidence_hash: paymentImportHash(sourceChecks),
    return_hash: paymentImportHash(returns),
    shipping_guard_hash: paymentImportHash(guards),
    shipping_uncertain: !!guards.length,
    shipment: s,
    shipment_sums: sums,
    has_credit_evidence:
      entries.some((e) => ['receipt', 'courier_collection'].includes(e.kind)) ||
      sourceChecks.some((e) => e.source_amount > 0),
    has_returns: returns.length > 0,
  };
}
function financialIssue(r: FrozenRow, manual = false) {
  const n = r.source.normalized,
    s = r.snapshot;
  if (!n || !s) return 'Brak zgodnego źródła lub zamówienia';
  if (s.shipping_uncertain) return 'Najpierw uzgodnij niepewną przesyłkę';
  if (s.has_returns || s.order.status === 'cancelled' || s.order.status.startsWith('return_'))
    return 'Zamówienie wymaga procesu uzgodnienia zwrotu/anulowania';
  if (n.currency !== s.order.currency) return 'Waluta różni się od zamówienia';
  if (n.ledger_kind === 'receipt') {
    if (s.order.payment_mode !== 'prepaid') return 'Wpłata bankowa wymaga przedpłaty';
    if (BigInt(n.amount_minor) > BigInt(s.balance.amount_due))
      return 'Wpłata przekracza bieżącą należność';
    if (s.has_credit_evidence && !manual)
      return 'Istniejący dowód wpłaty wymaga jawnego uzgodnienia odrębnej transakcji';
  } else {
    if (s.order.payment_mode !== 'cod' || !s.shipment?.dispatched_at)
      return 'COD wymaga przekazanej przesyłki';
    if (
      n.ledger_kind === 'courier_collection' &&
      BigInt(n.amount_minor) > BigInt(s.shipment.cod_expected) - BigInt(s.shipment_sums.collected)
    )
      return 'Pobranie przekracza pozostały limit';
    if (
      n.ledger_kind === 'courier_remittance' &&
      BigInt(n.gross_minor) > BigInt(s.shipment_sums.collected) - BigInt(s.shipment_sums.settled)
    )
      return 'Rozliczenie nie ma wystarczającego potwierdzonego pobrania';
  }
  return null;
}
async function matchRow(
  c: PoolClient,
  a: Actor,
  raw: BankCodParsedRow,
  p: BankCodProfile,
  choice?: z.infer<typeof resolution>,
  snapshots?: Map<string, any>,
): Promise<FrozenRow> {
  const n = raw.normalized;
  const r: FrozenRow = {
    row_id: raw.row_id,
    position: raw.data_index - 1,
    classification: raw.status === 'valid' ? 'unmatched' : raw.status,
    source: { raw, normalized: n },
    evidence: { candidates: [], more: false },
    issues: [...raw.issues],
    operation: 'apply',
    allocation: null,
    snapshot: null,
    economic_key: raw.economic_key,
    payload_hash: null,
    linked_receipt_id: null,
  };
  if (!n || raw.status === 'invalid' || raw.status === 'conflict' || !raw.economic_key) return r;
  let candidates: any[] = [];
  if (p.match.kind === 'tracking_number')
    candidates = (
      await c.query(
        'SELECT o.id,o.number,s.id shipment_id,s.tracking_number FROM shipments s JOIN orders o ON o.id=s.order_id WHERE s.carrier=$1 AND s.tracking_number=ANY($2::text[]) ORDER BY o.id,s.id LIMIT 6',
        [p.match.carrier, n.match_identifiers],
      )
    ).rows;
  else
    candidates = (
      await c.query(
        'SELECT id,number FROM orders WHERE ' +
          (p.match.kind === 'order_number'
            ? 'number=ANY($1::text[])'
            : 'external_id=ANY($1::text[]) AND channel_id=$2') +
          ' ORDER BY id LIMIT 6',
        p.match.kind === 'order_number'
          ? [n.match_identifiers]
          : [n.match_identifiers, p.match.channel_id],
      )
    ).rows;
  r.evidence = {
    candidates: candidates.slice(0, 5),
    more: candidates.length > 5,
    match: p.match,
    identifiers: n.match_identifiers,
    tracking_number: n.tracking_number,
  };
  let orderId =
    choice?.action === 'assign'
      ? choice.order_id
      : candidates.length === 1 && n.match_identifiers.length === 1
        ? candidates[0].id
        : null;
  let shipmentId =
    choice?.action === 'assign'
      ? choice.shipment_id
      : candidates.length === 1
        ? candidates[0].shipment_id
        : undefined;
  if (choice?.action === 'link_existing_receipt') {
    const receipt = (
      await c.query(
        'SELECT r.*,r.booking_date::text booking_date_text,EXISTS(SELECT 1 FROM payment_entries v WHERE v.reversal_of=r.entry_id) reversed FROM payment_import_receipts r WHERE r.id=$1',
        [choice.receipt_id],
      )
    ).rows[0];
    ensure(
      receipt && !receipt.reversed && receipt.operation !== 'reverse',
      409,
      'Dowód nie jest dostępnym oryginalnym importem',
    );
    ensure(
      receipt.kind === n.ledger_kind &&
        receipt.amount === n.ledger_amount &&
        receipt.fee === n.ledger_fee &&
        receipt.currency === n.currency &&
        receipt.booking_date_text === n.booking_date,
      409,
      'Dowód ma inne kwoty/typ/datę',
    );
    orderId = receipt.order_id;
    shipmentId = receipt.shipment_id ?? undefined;
    r.operation = 'link_existing';
    r.linked_receipt_id = receipt.id;
    r.evidence.receipt_id = receipt.id;
  }
  if (!orderId) {
    r.classification =
      candidates.length > 1 || n.match_identifiers.length > 1 ? 'ambiguous' : 'unmatched';
    return r;
  }
  if (n.ledger_kind === 'receipt') {
    ensure(
      choice?.action !== 'assign' || !choice.shipment_id,
      422,
      'Wpłata bankowa nie ma alokacji przesyłki',
    );
    shipmentId = undefined;
  }
  if (n.ledger_kind !== 'receipt') {
    const shipments = (
      await c.query(
        'SELECT id,order_id FROM shipments WHERE carrier=$1 AND tracking_number=$2 ORDER BY id LIMIT 6',
        [p.match.carrier, n.tracking_number],
      )
    ).rows;
    if (!shipmentId && shipments.length === 1 && shipments[0].order_id === orderId)
      shipmentId = shipments[0].id;
    if (!shipmentId || !shipments.some((s) => s.id === shipmentId && s.order_id === orderId)) {
      r.classification = 'ambiguous';
      r.issues.push({
        code: 'shipment_identity',
        message: 'Wymagana dokładna zgodna przesyłka COD',
      });
      return r;
    }
  }
  r.allocation = { order_id: orderId, ...(shipmentId ? { shipment_id: shipmentId } : {}) };
  const snapshotKey = orderId + ':' + (shipmentId ?? '');
  r.snapshot = snapshots?.get(snapshotKey) ?? (await financialSnapshot(c, orderId, shipmentId));
  snapshots?.set(snapshotKey, r.snapshot);
  if (n.tracking_number) {
    const tracks = (
      await c.query(
        'SELECT order_id,id FROM shipments WHERE tracking_number=$1 AND ($2::text IS NULL OR carrier=$2) ORDER BY id LIMIT 6',
        [n.tracking_number, p.match.carrier ?? null],
      )
    ).rows;
    if (tracks.length !== 1 || tracks[0].order_id !== orderId) {
      r.classification = 'review';
      r.issues.push({
        code: 'contradictory_tracking',
        message: 'Numer przesyłki nie identyfikuje dokładnie wybranego zamówienia',
      });
      return r;
    }
  }
  if (p.match.kind === 'tracking_number' && p.columns.order_reference) {
    const reference = raw.cells[p.columns.order_reference.index];
    if (reference && reference !== r.snapshot.order.number) {
      r.classification = 'review';
      r.issues.push({
        code: 'contradictory_order_reference',
        message: 'Referencja zamówienia jest sprzeczna z przesyłką',
      });
      return r;
    }
  }
  r.payload_hash = paymentImportHash({
    kind: n.ledger_kind,
    amount: n.amount_minor,
    fee: n.fee_minor,
    currency: n.currency,
    date: n.booking_date,
    allocation: r.allocation,
    stage: n.event_stage,
  });
  const claim = (
    await c.query(
      'SELECT c.*,r.id receipt_id,EXISTS(SELECT 1 FROM payment_entries v WHERE v.reversal_of=r.entry_id) reversed FROM payment_import_claims c LEFT JOIN payment_import_receipts r ON r.execution_id=c.execution_id AND r.row_id=c.row_id WHERE c.namespace_id=$1 AND c.economic_key=$2',
      [p.source_namespace_id, r.economic_key],
    )
  ).rows[0];
  if (claim) {
    if (claim.allocation_source_id) {
      r.classification = 'conflict';
      r.evidence.claim = {
        allocation_source_id: claim.allocation_source_id,
        state: claim.state,
      };
      r.issues.push({
        code: 'split_source',
        message:
          'Transakcja ma zapisany podział. Pozostałą kwotę przypisz w panelu podziału wpłaty.',
      });
      return r;
    }
    r.classification =
      claim.payload_hash === r.payload_hash && claim.state === 'applied' ? 'duplicate' : 'conflict';
    r.evidence.claim = {
      execution_id: claim.execution_id,
      receipt_id: claim.receipt_id,
      state: claim.state,
      reversed: claim.reversed,
    };
    return r;
  }
  if (r.operation === 'link_existing') {
    r.classification = 'ready';
    r.evidence.resolution = choice;
    return r;
  }
  const possible = (
    await c.query(
      "SELECT id,execution_id FROM payment_import_receipts WHERE order_id=$1 AND kind=$2 AND amount=$3 AND fee=$4 AND currency=$5 AND booking_date=$6 AND operation<>'reverse' LIMIT 6",
      [orderId, n.ledger_kind, n.ledger_amount, n.ledger_fee, n.currency, n.booking_date],
    )
  ).rows;
  if (possible.length && choice?.action !== 'assign') {
    r.classification = 'review';
    r.issues.push({
      code: 'possible_duplicate',
      message: 'Istnieje podobny dowód; wskaż poprzedni receipt jako alias',
    });
    r.evidence.possible_receipts = possible;
    return r;
  }
  const problem = financialIssue(r, choice?.action === 'assign');
  r.classification = problem ? 'review' : 'ready';
  if (problem) r.issues.push({ code: 'financial_review', message: problem });
  if (choice) r.evidence.resolution = choice;
  if (raw.status === 'duplicate') r.classification = 'duplicate';
  return r;
}
function summarize(rows: FrozenRow[]) {
  const counts: Record<string, number> = {
    ready: 0,
    duplicate: 0,
    invalid: 0,
    unmatched: 0,
    ambiguous: 0,
    conflict: 0,
    review: 0,
  };
  const totals = new Map<string, any>();
  for (const r of rows) {
    counts[r.classification]++;
    const n = r.source.normalized;
    if (!n) continue;
    const k = n.currency + ':' + n.ledger_kind + ':' + r.operation;
    let t = totals.get(k);
    if (!t) {
      t = {
        currency: n.currency,
        kind: n.ledger_kind,
        operation: r.operation,
        amount_minor: '0',
        fee_minor: '0',
        count: 0,
      };
      totals.set(k, t);
    }
    // Corrections show positive magnitudes being reversed; the operation marks
    // their direction. Evidence aliases produce no new ledger amount.
    if (r.classification === 'ready' && r.operation !== 'link_existing') {
      t.amount_minor = (BigInt(t.amount_minor) + BigInt(n.amount_minor)).toString();
      t.fee_minor = (BigInt(t.fee_minor) + BigInt(n.fee_minor)).toString();
      t.count++;
    }
  }
  return { counts, totals: [...totals.values()] };
}
const previewHead = (p: any, reused = false) => ({
  id: p.id,
  kind: p.kind,
  file_id: p.file_id,
  profile_id: p.profile_id,
  profile_version: p.profile_version,
  version: p.version,
  scope_hash: p.scope_hash,
  summary: p.summary,
  expires_at: p.expires_at,
  created_at: p.created_at,
  reused,
});
async function previewCapacity(c: PoolClient) {
  ensure(
    (await c.query('SELECT count(*)::int n FROM payment_import_previews WHERE expires_at>now()'))
      .rows[0].n < 20,
    409,
    'Limit 20 aktywnych podglądów',
  );
}
async function frozenRows(c: PoolClient, id: string) {
  return (
    await c.query('SELECT * FROM payment_import_rows WHERE preview_id=$1 ORDER BY position', [id])
  ).rows as FrozenRow[];
}
async function insertPreview(c: PoolClient, a: Actor, b: any, metadata: any, rows: FrozenRow[]) {
  await previewCapacity(c);
  rows = rows.map((row, position) => ({ ...row, position }));
  const id = randomUUID(),
    summary = summarize(rows),
    scope = paymentImportHash({ policy: 'local_financial_only:1', metadata, rows }),
    p = (
      await c.query(
        'INSERT INTO payment_import_previews(id,tenant_id,client_key,request_hash,kind,file_id,profile_id,profile_version,namespace_id,namespace_version,profile,parent_id,version,scope_hash,summary,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
        [
          id,
          a.tenantId,
          b.client_key,
          paymentImportHash(b),
          metadata.kind,
          metadata.file_id ?? null,
          metadata.profile_id ?? null,
          metadata.profile_version ?? null,
          metadata.namespace_id ?? null,
          metadata.namespace_version ?? null,
          metadata.profile ? JSON.stringify(metadata.profile) : null,
          metadata.parent_id ?? null,
          metadata.version ?? 1,
          scope,
          JSON.stringify(summary),
          a.userId,
        ],
      )
    ).rows[0];
  await c.query(
    'INSERT INTO payment_import_rows(tenant_id,preview_id,row_id,position,classification,source,evidence,issues,operation,allocation,snapshot,economic_key,payload_hash,linked_receipt_id) SELECT $1,$2,row_id,position,classification,source,evidence,issues,operation,allocation,snapshot,economic_key,payload_hash,linked_receipt_id FROM jsonb_to_recordset($3::jsonb) x(row_id uuid,position integer,classification text,source jsonb,evidence jsonb,issues jsonb,operation text,allocation jsonb,snapshot jsonb,economic_key text,payload_hash text,linked_receipt_id uuid)',
    [a.tenantId, id, JSON.stringify(rows)],
  );
  await audit(c, a, 'payment.import.preview', id, { scope_hash: scope, counts: summary.counts });
  return previewHead(p);
}
async function previewReplay(c: PoolClient, b: any) {
  const p = (
    await c.query('SELECT * FROM payment_import_previews WHERE client_key=$1', [b.client_key])
  ).rows[0];
  if (p) {
    ensure(p.request_hash === paymentImportHash(b), 409, 'Klucz podglądu ma inny zakres');
    return previewHead(p, true);
  }
  return null;
}
export async function previewPaymentImport(a: Actor, input: z.input<typeof previewInput>) {
  const b = previewInput.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    const replay = await previewReplay(c, b);
    if (replay) {
      await paymentImportAdmin(c, a);
      return replay;
    }
    const policy = await profilePolicy(c, a, b.profile_id, b.profile_version),
      f = (await c.query('SELECT * FROM payment_import_files WHERE id=$1', [b.file_id])).rows[0];
    ensure(f, 404, 'Nie znaleziono pliku');
    const bytes = Buffer.from(decrypt(f.encrypted_bytes).content_base64, 'base64');
    ensure(
      bytes.length === f.byte_count &&
        createHash('sha256').update(bytes).digest('hex') === f.file_hash,
      409,
      'Dowód nie zgadza się z zapisanym hashem',
    );
    const parsed = parse(bytes, policy.definition, a),
      rows: FrozenRow[] = [],
      snapshots = new Map<string, any>();
    for (const row of parsed.rows)
      rows.push(await matchRow(c, a, row, policy.definition, undefined, snapshots));
    await paymentImportAdmin(c, a);
    return insertPreview(
      c,
      a,
      b,
      {
        kind: 'import',
        file_id: f.id,
        profile_id: policy.p.id,
        profile_version: policy.p.version,
        namespace_id: policy.namespace.id,
        namespace_version: policy.namespace.version,
        profile: policy.definition,
      },
      rows,
    );
  });
}
export async function resolvePaymentImport(
  a: Actor,
  id: string,
  input: z.input<typeof resolveInput>,
) {
  const b = resolveInput.parse(input);
  ensure(
    new Set(b.resolutions.map((r) => r.row_id)).size === b.resolutions.length,
    422,
    'Powtórzone rozwiązanie wiersza',
  );
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    const replay = await previewReplay(c, { ...b, parent_id: id });
    if (replay) {
      await paymentImportAdmin(c, a);
      return replay;
    }
    const p = (await c.query('SELECT * FROM payment_import_previews WHERE id=$1', [id])).rows[0];
    ensure(p?.kind === 'import' && p.version === b.version, 409, 'Podgląd zmienił się');
    const policy = await profilePolicy(c, a, p.profile_id, p.profile_version);
    ensure(policy.namespace.version === p.namespace_version, 409, 'Domena zmieniła się');
    const old = await frozenRows(c, id),
      choices = new Map(b.resolutions.map((r) => [r.row_id, r]));
    ensure(
      b.resolutions.every((r) => old.some((x) => x.row_id === r.row_id)),
      404,
      'Wiersz nie należy do podglądu',
    );
    const rows: FrozenRow[] = [],
      snapshots = new Map<string, any>();
    for (const r of old)
      rows.push(
        await matchRow(
          c,
          a,
          r.source.raw,
          policy.definition,
          choices.get(r.row_id) ?? r.evidence.resolution,
          snapshots,
        ),
      );
    await paymentImportAdmin(c, a);
    return insertPreview(
      c,
      a,
      { ...b, parent_id: id },
      {
        kind: 'import',
        file_id: p.file_id,
        profile_id: p.profile_id,
        profile_version: p.profile_version,
        namespace_id: p.namespace_id,
        namespace_version: p.namespace_version,
        profile: p.profile,
        parent_id: p.id,
        version: p.version + 1,
      },
      rows,
    );
  });
}

async function verifyFrozen(c: PoolClient, a: Actor, p: any, rows: FrozenRow[]) {
  if (p.kind === 'import') {
    const policy = await profilePolicy(c, a, p.profile_id, p.profile_version, false);
    ensure(
      policy.namespace.version === p.namespace_version &&
        paymentImportHash(policy.definition) === paymentImportHash(p.profile),
      409,
      'Format lub domena zmieniły się',
    );
  }
  const ids = [...new Set(rows.map((r) => r.allocation?.order_id))].sort();
  ensure(ids.length <= 100 && ids.every(Boolean), 409, 'Niepełny zakres zamówień');
  const locked = (
    await c.query('SELECT id FROM orders WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
  ).rows;
  ensure(locked.length === ids.length, 404, 'Zamówienie nie należy do firmy');
  const shipments = [...new Set(rows.map((r) => r.allocation?.shipment_id).filter(Boolean))].sort();
  if (shipments.length)
    await c.query('SELECT id FROM shipments WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [
      shipments,
    ]);
  await paymentImportAdmin(c, a);
  if (p.kind === 'import') {
    const owner = (
      await c.query('SELECT approved_by FROM payment_import_profiles WHERE id=$1', [p.profile_id])
    ).rows[0];
    await paymentImportAdmin(c, { ...a, userId: owner.approved_by });
  }
  const seen = new Map<string, any>(),
    balances = new Map<string, any>(),
    shipmentSums = new Map<string, any>();
  for (const r of rows) {
    ensure(
      r.classification === 'ready' && r.allocation && r.snapshot,
      409,
      'Wybrano wiersz wymagający uzgodnienia',
    );
    const key = r.allocation.order_id + ':' + (r.allocation.shipment_id ?? '');
    let current = seen.get(key);
    if (!current) {
      current = await financialSnapshot(c, r.allocation.order_id, r.allocation.shipment_id);
      seen.set(key, current);
    }
    ensure(
      paymentImportHash(current) === paymentImportHash(r.snapshot),
      409,
      'Finanse, wersja lub przesyłka zmieniły się od podglądu',
    );
    if (r.operation === 'reverse') {
      const e = (
        await c.query('SELECT * FROM payment_entries WHERE id=$1 AND order_id=$2', [
          r.source.entry_id,
          r.allocation.order_id,
        ])
      ).rows[0];
      ensure(
        e &&
          !e.return_id &&
          e.kind !== 'reversal' &&
          !(await c.query('SELECT 1 FROM payment_entries WHERE reversal_of=$1', [e.id])).rowCount,
        409,
        'Wpis jest niedostępny albo już skorygowany',
      );
      continue;
    }
    if (r.operation === 'link_existing') {
      const e = (
        await c.query(
          'SELECT r.*,r.booking_date::text booking_date_text,EXISTS(SELECT 1 FROM payment_entries v WHERE v.reversal_of=r.entry_id) reversed FROM payment_import_receipts r WHERE r.id=$1',
          [r.linked_receipt_id],
        )
      ).rows[0];
      ensure(
        e && !e.reversed && e.order_id === r.allocation.order_id,
        409,
        'Poprzedni dowód zmienił się',
      );
      continue;
    }
    const issue = financialIssue(r, !!r.evidence.resolution);
    ensure(!issue, 409, issue ?? 'Wymagane uzgodnienie');
    const n = r.source.normalized;
    let b = balances.get(r.allocation.order_id);
    if (!b) {
      b = { due: BigInt(current.balance.amount_due) };
      balances.set(r.allocation.order_id, b);
    }
    if (n.ledger_kind === 'receipt') {
      ensure(BigInt(n.amount_minor) <= b.due, 409, 'Suma wybranych wpłat przekracza należność');
      b.due -= BigInt(n.amount_minor);
    } else {
      let s = shipmentSums.get(r.allocation.shipment_id);
      if (!s) {
        s = {
          collected: BigInt(current.shipment_sums.collected),
          settled: BigInt(current.shipment_sums.settled),
          expected: BigInt(current.shipment.cod_expected),
        };
        shipmentSums.set(r.allocation.shipment_id, s);
      }
      if (n.ledger_kind === 'courier_collection') {
        ensure(
          s.collected + BigInt(n.amount_minor) <= s.expected,
          409,
          'Suma pobrań przekracza limit',
        );
        s.collected += BigInt(n.amount_minor);
      } else {
        ensure(
          s.settled + BigInt(n.gross_minor) <= s.collected,
          409,
          'Suma rozliczeń przekracza pobranie',
        );
        s.settled += BigInt(n.gross_minor);
      }
    }
  }
  const correctionErrors = correctionIssues(rows);
  ensure(!correctionErrors.size, 409, [...correctionErrors.values()][0] ?? 'Korekta narusza saldo');
}
function correctionIssues(rows: FrozenRow[]) {
  const errors = new Map<string, string>(),
    orders = new Map<string, bigint>(),
    ships = new Map<string, { collected: bigint; settled: bigint }>();
  for (const r of ordered(rows)) {
    if (r.operation !== 'reverse') continue;
    const n = r.source.normalized,
      s = r.snapshot;
    let message = s.shipping_uncertain ? 'Najpierw uzgodnij niepewną przesyłkę' : null;
    let net = orders.get(r.allocation.order_id) ?? BigInt(s.balance.net);
    if (['receipt', 'courier_collection'].includes(n.ledger_kind)) {
      if (net < BigInt(n.amount_minor)) message = 'Najpierw skoryguj zwrot środków';
      net -= BigInt(n.amount_minor);
      orders.set(r.allocation.order_id, net);
    }
    if (r.allocation.shipment_id) {
      let ship = ships.get(r.allocation.shipment_id);
      if (!ship) {
        ship = {
          collected: BigInt(s.shipment_sums.collected),
          settled: BigInt(s.shipment_sums.settled),
        };
        ships.set(r.allocation.shipment_id, ship);
      }
      if (n.ledger_kind === 'courier_remittance') ship.settled -= BigInt(n.gross_minor);
      else if (n.ledger_kind === 'courier_collection') {
        ship.collected -= BigInt(n.amount_minor);
        if (ship.collected < ship.settled) message = 'Najpierw skoryguj rozliczenie kuriera';
      }
      if (ship.settled < 0n || ship.collected < 0n) message = 'Korekta przekracza bieżące środki';
    }
    const projectedShip = r.allocation.shipment_id ? ships.get(r.allocation.shipment_id) : null;
    r.evidence.projected_after = {
      currency: s.order.currency,
      net_minor: net.toString(),
      amount_due_minor: (BigInt(s.balance.nominal) > net
        ? BigInt(s.balance.nominal) - net
        : 0n
      ).toString(),
      courier_due_minor: projectedShip
        ? (projectedShip.collected - projectedShip.settled).toString()
        : String(s.balance.courier_due),
      order_status: s.order.status,
      local_ledger_only: true,
    };
    if (message) errors.set(r.row_id, message);
  }
  return errors;
}
const executionHead = (e: any, reused = false) => ({
  id: e.id,
  preview_id: e.preview_id,
  kind: e.kind,
  scope_hash: e.scope_hash,
  selected_count: e.selected_count,
  currency: e.currency,
  total_minor: e.total_minor,
  fee_minor: e.fee_minor,
  state: e.state,
  error: e.error,
  job_id: e.job_id,
  created_at: e.created_at,
  finished_at: e.finished_at,
  result: e.result,
  reused,
});
async function queueInTx(c: PoolClient, a: Actor, p: any, b: any, rows: FrozenRow[]) {
  ensure(
    p.scope_hash === b.scope_hash && new Date(p.expires_at).getTime() > Date.now(),
    409,
    'Zgoda wygasła lub dotyczy innego podglądu',
  );
  await verifyFrozen(c, a, p, rows);
  ensure(
    (await c.query("SELECT count(*)::int n FROM payment_import_executions WHERE state='queued'"))
      .rows[0].n < 20,
    409,
    'Limit 20 aktywnych wykonań',
  );
  const currencies = new Set(rows.map((r) => r.source.normalized.currency));
  ensure(currencies.size === 1, 422, 'Partia wymaga jednej waluty');
  const economic = rows.filter((r) => r.operation !== 'reverse');
  ensure(
    new Set(economic.map((r) => r.economic_key)).size === economic.length,
    409,
    'Wybrano powtórzony przepływ ekonomiczny',
  );
  for (const r of [...economic].sort((x, y) => (x.economic_key! < y.economic_key! ? -1 : 1)))
    ensure(
      !(
        await c.query(
          'SELECT 1 FROM payment_import_claims WHERE namespace_id=$1 AND economic_key=$2',
          [p.namespace_id, r.economic_key],
        )
      ).rowCount,
      409,
      'Transakcja jest już zajęta lub zastosowana; odśwież podgląd',
    );
  const id = randomUUID(),
    job = randomUUID(),
    scope = paymentImportHash({
      preview_scope: p.scope_hash,
      rows: rows.map((r) => ({
        row_id: r.row_id,
        payload_hash: r.payload_hash,
        snapshot: r.snapshot,
        operation: r.operation,
      })),
      policy: 'local_financial_only:1',
    }),
    total = rows
      .filter((r) => r.operation !== 'link_existing')
      .reduce((n, r) => n + BigInt(r.source.normalized.amount_minor), 0n),
    fee = rows
      .filter((r) => r.operation !== 'link_existing')
      .reduce((n, r) => n + BigInt(r.source.normalized.fee_minor), 0n);
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5)', [
    job,
    a.tenantId,
    PAYMENT_IMPORT_JOB,
    JSON.stringify({ execution_id: id }),
    'payment.import:' + id,
  ]);
  const e = (
    await c.query(
      'INSERT INTO payment_import_executions(id,tenant_id,client_key,request_hash,preview_id,kind,scope_hash,consent,selected_count,currency,total_minor,fee_minor,actor_id,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
      [
        id,
        a.tenantId,
        b.client_key,
        paymentImportHash({ ...b, preview_id: p.id }),
        p.id,
        p.kind,
        scope,
        JSON.stringify({ ...b, policy: 'local_financial_only:1' }),
        rows.length,
        [...currencies][0],
        total.toString(),
        fee.toString(),
        a.userId,
        job,
      ],
    )
  ).rows[0];
  for (let position = 0; position < rows.length; position++) {
    const r = rows[position];
    await c.query(
      'INSERT INTO payment_import_execution_rows(tenant_id,execution_id,preview_id,row_id,position) VALUES($1,$2,$3,$4,$5)',
      [a.tenantId, id, p.id, r.row_id, position],
    );
  }
  for (const r of [...economic].sort((x, y) => (x.economic_key! < y.economic_key! ? -1 : 1)))
    await c.query(
      'INSERT INTO payment_import_claims(tenant_id,namespace_id,economic_key,payload_hash,execution_id,row_id) VALUES($1,$2,$3,$4,$5,$6)',
      [a.tenantId, p.namespace_id, r.economic_key, r.payload_hash, id, r.row_id],
    );
  await audit(c, a, 'payment.import.queue', id, {
    preview_id: p.id,
    scope_hash: scope,
    selected_count: rows.length,
    total_minor: total.toString(),
    fee_minor: fee.toString(),
    policy: 'local_financial_only:1',
  });
  return executionHead(e);
}
async function queueReplay(c: PoolClient, b: any, id: string) {
  const e = (
    await c.query('SELECT * FROM payment_import_executions WHERE client_key=$1', [b.client_key])
  ).rows[0];
  if (e) {
    ensure(
      e.request_hash === paymentImportHash({ ...b, preview_id: id }),
      409,
      'Klucz zlecenia ma inny zakres',
    );
    return executionHead(e, true);
  }
  return null;
}
export async function queuePaymentImport(
  a: Actor,
  id: string,
  input: z.input<typeof importQueueInput>,
) {
  const parsed = importQueueInput.parse(input);
  ensure(new Set(parsed.row_ids).size === parsed.row_ids.length, 422, 'Powtórzone ID wiersza');
  const b = { ...parsed, row_ids: [...parsed.row_ids].sort() };
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    const replay = await queueReplay(c, b, id);
    if (replay) {
      await paymentImportAdmin(c, a);
      return replay;
    }
    const p = (await c.query('SELECT * FROM payment_import_previews WHERE id=$1', [id])).rows[0];
    ensure(p?.kind === 'import' && p.version === b.version, 409, 'Nieprawidłowa wersja podglądu');
    const rows = (await frozenRows(c, id)).filter((r) => b.row_ids.includes(r.row_id));
    ensure(rows.length === b.row_ids.length, 404, 'Wiersz nie należy do podglądu');
    return queueInTx(c, a, p, b, ordered(rows));
  });
}
function ordered(rows: FrozenRow[]) {
  return [...rows].sort((a, b) => {
    if (a.operation === 'reverse' && b.operation === 'reverse') {
      const stage = (r: FrozenRow) =>
        r.source.normalized.ledger_kind === 'courier_remittance' ? 0 : 1;
      const d = stage(a) - stage(b);
      if (d) return d;
    }
    const da = a.source.normalized.booking_date,
      db = b.source.normalized.booking_date;
    return da < db ? -1 : da > db ? 1 : a.row_id < b.row_id ? -1 : 1;
  });
}
export async function previewPaymentImportCorrection(
  a: Actor,
  input: z.input<typeof correctionPreviewInput>,
) {
  const b = correctionPreviewInput.parse(input);
  ensure(new Set(b.receipt_ids).size === b.receipt_ids.length, 422, 'Powtórzone receipt');
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    await paymentImportAdmin(c, a);
    const replay = await previewReplay(c, b);
    if (replay) return replay;
    const receipts = (
      await c.query(
        "SELECT r.*,to_char(r.booking_date,'YYYY-MM-DD') date_text,p.kind entry_kind,p.return_id,p.reversal_of,EXISTS(SELECT 1 FROM payment_entries v WHERE v.reversal_of=r.entry_id) reversed FROM payment_import_receipts r JOIN payment_entries p ON p.id=r.entry_id WHERE r.id=ANY($1::uuid[]) ORDER BY r.id",
        [b.receipt_ids],
      )
    ).rows;
    ensure(receipts.length === b.receipt_ids.length, 404, 'Receipt nie należy do firmy');
    ensure(
      new Set(receipts.map((r) => r.entry_id)).size === receipts.length,
      422,
      'Wybrano ten sam wpis przez różne aliasy',
    );
    const rows: FrozenRow[] = [];
    for (const [position, r] of receipts.entries()) {
      ensure(
        r.operation !== 'reverse' && !r.reversed && !r.return_id && r.entry_kind !== 'reversal',
        409,
        'Receipt nie może zostać skorygowany',
      );
      const snapshot = await financialSnapshot(c, r.order_id, r.shipment_id ?? undefined);
      rows.push({
        row_id: randomUUID(),
        position,
        classification: 'ready',
        issues: [],
        source: {
          raw: null,
          entry_id: r.entry_id,
          reason: b.reason,
          normalized: {
            ledger_kind: r.kind,
            amount_minor: String(r.amount),
            fee_minor: String(r.fee),
            gross_minor: String(BigInt(r.amount) + BigInt(r.fee)),
            ledger_amount: r.amount,
            ledger_fee: r.fee,
            currency: r.currency,
            booking_date: r.date_text,
            reference: 'Korekta ' + r.id,
          },
        },
        evidence: { receipt_id: r.id, reason: b.reason },
        operation: 'reverse',
        allocation: {
          order_id: r.order_id,
          ...(r.shipment_id ? { shipment_id: r.shipment_id } : {}),
        },
        snapshot,
        economic_key: null,
        payload_hash: paymentImportHash({ entry: r.entry_id, reason: b.reason, snapshot }),
        linked_receipt_id: r.id,
      });
    }
    ensure(
      new Set(rows.map((r) => r.source.normalized.currency)).size === 1,
      422,
      'Korekta wymaga jednej waluty',
    );
    const errors = correctionIssues(rows);
    for (const r of rows)
      if (errors.has(r.row_id)) {
        r.classification = 'review';
        r.issues.push({ code: 'correction_dependency', message: errors.get(r.row_id) });
      }
    return insertPreview(c, a, b, { kind: 'correction' }, ordered(rows));
  });
}
export async function queuePaymentImportCorrection(
  a: Actor,
  id: string,
  input: z.input<typeof correctionQueueInput>,
) {
  const b = correctionQueueInput.parse(input);
  return tenantTx(a.tenantId, async (c) => {
    await admission(c, a);
    const replay = await queueReplay(c, b, id);
    if (replay) {
      await paymentImportAdmin(c, a);
      return replay;
    }
    const p = (await c.query('SELECT * FROM payment_import_previews WHERE id=$1', [id])).rows[0];
    ensure(p?.kind === 'correction', 404, 'Nie znaleziono korekty');
    return queueInTx(c, a, p, b, ordered(await frozenRows(c, id)));
  });
}
async function executionRows(c: PoolClient, id: string) {
  return (
    await c.query(
      'SELECT r.* FROM payment_import_execution_rows x JOIN payment_import_rows r ON (r.tenant_id,r.preview_id,r.row_id)=(x.tenant_id,x.preview_id,x.row_id) WHERE x.execution_id=$1 ORDER BY x.position',
      [id],
    )
  ).rows as FrozenRow[];
}
async function settleFailure(c: PoolClient, e: any, state: string, message: string) {
  await c.query(
    'UPDATE payment_import_executions SET state=$2,error=$3,result=$4,finished_at=now() WHERE id=$1',
    [e.id, state, message, JSON.stringify({ changed: 0, applied: 0 })],
  );
  await c.query("DELETE FROM payment_import_claims WHERE execution_id=$1 AND state='reserved'", [
    e.id,
  ]);
  await c.query(
    "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error=$2 WHERE id=$1",
    [e.job_id, message],
  );
}
export async function processPaymentImportJob(job: any) {
  z.uuid().parse(job.tenant_id);
  z.uuid().parse(job.lease_token);
  const id = z.strictObject({ execution_id: z.uuid() }).parse(job.payload).execution_id;
  return tenantTx(job.tenant_id, async (c) => {
    await executionLock(c, id);
    const j = (
      await c.query(
        "SELECT * FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rows[0];
    if (!j) return { processed: false };
    ensure(
      j.kind === PAYMENT_IMPORT_JOB &&
        paymentImportHash(j.payload) === paymentImportHash(job.payload),
      409,
      'Zadanie zmieniło się',
    );
    const e = (
      await c.query('SELECT * FROM payment_import_executions WHERE id=$1 FOR UPDATE', [id])
    ).rows[0];
    ensure(e && e.job_id === j.id, 409, 'Wykonanie nie pasuje do zadania');
    if (e.state !== 'queued') {
      await c.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE id=$1", [
        j.id,
      ]);
      return { processed: false };
    }
    const a: Actor = { tenantId: job.tenant_id, userId: e.actor_id, role: 'admin' };
    await c.query('SAVEPOINT payment_import_apply');
    try {
      const claims = (
          await c.query(
            'SELECT * FROM payment_import_claims WHERE execution_id=$1 ORDER BY economic_key FOR UPDATE',
            [id],
          )
        ).rows,
        rows = await executionRows(c, id),
        p = (await c.query('SELECT * FROM payment_import_previews WHERE id=$1', [e.preview_id]))
          .rows[0];
      ensure(rows.length === e.selected_count, 409, 'Niepełny zakres wykonania');
      ensure(
        claims.length === rows.filter((r) => r.operation !== 'reverse').length &&
          rows
            .filter((r) => r.operation !== 'reverse')
            .every((r) =>
              claims.some(
                (k) =>
                  k.row_id === r.row_id &&
                  k.payload_hash === r.payload_hash &&
                  k.state === 'reserved',
              ),
            ),
        409,
        'Niepełne roszczenia transakcji',
      );
      ensure(
        paymentImportHash({
          preview_scope: p.scope_hash,
          rows: rows.map((r) => ({
            row_id: r.row_id,
            payload_hash: r.payload_hash,
            snapshot: r.snapshot,
            operation: r.operation,
          })),
          policy: 'local_financial_only:1',
        }) === e.scope_hash,
        409,
        'Zmieniony zamrożony zakres',
      );
      await verifyFrozen(c, a, p, rows);
      for (const r of ordered(rows)) {
        const n = r.source.normalized,
          order = r.allocation.order_id,
          before = await paymentBalance(c, order),
          context = {
            effects: 'local_financial_only' as const,
            provenance: { execution_id: id, row_id: r.row_id, preview_id: p.id },
          },
          key = 'payment-import:' + id + ':' + r.row_id + ':' + r.operation;
        let entry: string;
        if (r.operation === 'reverse')
          entry = (
            await reverseFinancialPaymentInTx(
              c,
              a,
              order,
              key,
              { scope_hash: e.scope_hash },
              { entry_id: r.source.entry_id, reason: r.source.reason },
              context,
            )
          ).entry_id;
        else if (r.operation === 'link_existing')
          entry = (
            await c.query('SELECT entry_id FROM payment_import_receipts WHERE id=$1', [
              r.linked_receipt_id,
            ])
          ).rows[0].entry_id;
        else
          entry = (
            await recordFinancialPaymentInTx(
              c,
              a,
              order,
              key,
              { scope_hash: e.scope_hash, economic_key: r.economic_key },
              {
                kind: n.ledger_kind,
                amount: n.ledger_amount,
                fee: n.ledger_fee,
                currency: n.currency,
                method: n.method,
                reference: ('CSV ' + n.transaction_id).slice(0, 200),
                note: 'Lokalne uzgodnienie CSV',
                ...(r.allocation.shipment_id ? { shipment_id: r.allocation.shipment_id } : {}),
              },
              context,
            )
          ).entry_id;
        const after = await paymentBalance(c, order),
          version = (await c.query('SELECT version FROM orders WHERE id=$1', [order])).rows[0]
            .version;
        await c.query(
          'INSERT INTO payment_import_receipts(id,tenant_id,execution_id,row_id,order_id,entry_id,shipment_id,kind,amount,fee,currency,booking_date,before_balance,after_balance,result_version,operation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
          [
            randomUUID(),
            a.tenantId,
            id,
            r.row_id,
            order,
            entry,
            r.allocation.shipment_id ?? null,
            n.ledger_kind,
            n.ledger_amount,
            n.ledger_fee,
            n.currency,
            n.booking_date,
            JSON.stringify(before),
            JSON.stringify(after),
            version,
            r.operation,
          ],
        );
      }
      if (claims.length)
        await c.query("UPDATE payment_import_claims SET state='applied' WHERE execution_id=$1", [
          id,
        ]);
      await c.query(
        "UPDATE payment_import_executions SET state='done',result=$2,finished_at=now() WHERE id=$1",
        [
          id,
          JSON.stringify({
            applied: rows.length,
            ledger_entries: rows.filter((r) => r.operation !== 'link_existing').length,
            aliases: rows.filter((r) => r.operation === 'link_existing').length,
          }),
        ],
      );
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
        [j.id],
      );
      await c.query('RELEASE SAVEPOINT payment_import_apply');
      return { processed: true, state: 'done', applied: rows.length };
    } catch (error) {
      await c.query('ROLLBACK TO SAVEPOINT payment_import_apply');
      await c.query('RELEASE SAVEPOINT payment_import_apply');
      if (!(error instanceof Problem) && !(error instanceof z.ZodError)) throw error;
      await settleFailure(
        c,
        e,
        'conflict',
        error instanceof Problem ? error.message : 'Nieprawidłowe dane zamrożonego wykonania',
      );
      return { processed: true, state: 'conflict', applied: 0 };
    }
  });
}
export async function cancelPaymentImport(a: Actor, id: string, clientKey: string) {
  z.uuid().parse(clientKey);
  return tenantTx(a.tenantId, async (c) => {
    await executionLock(c, id);
    const pointer = (
      await c.query('SELECT job_id FROM payment_import_executions WHERE id=$1', [id])
    ).rows[0];
    ensure(pointer, 404, 'Nie znaleziono wykonania');
    const job = (await c.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [pointer.job_id]))
        .rows[0],
      e = (await c.query('SELECT * FROM payment_import_executions WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
    await paymentImportAdmin(c, a);
    if (e.state === 'cancelled') return executionHead(e, true);
    ensure(
      e.state === 'queued' && job.state === 'pending',
      409,
      'Wykonanie rozpoczęło próbę lub zostało zakończone',
    );
    await c.query(
      "UPDATE payment_import_executions SET state='cancelled',result=$2,finished_at=now() WHERE id=$1",
      [id, JSON.stringify({ applied: 0, cancel_key: clientKey })],
    );
    await c.query("DELETE FROM payment_import_claims WHERE execution_id=$1 AND state='reserved'", [
      id,
    ]);
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error='Anulowano przed wykonaniem' WHERE id=$1",
      [e.job_id],
    );
    return executionHead(
      (await c.query('SELECT * FROM payment_import_executions WHERE id=$1', [id])).rows[0],
    );
  });
}
export async function reapPaymentImportJobs() {
  const candidates = (
    await pool.query(
      "SELECT e.id,e.tenant_id FROM payment_import_executions e JOIN jobs j ON j.id=e.job_id WHERE e.state='queued' AND j.state='failed' ORDER BY e.id LIMIT 25",
    )
  ).rows;
  let count = 0;
  for (const item of candidates)
    count += await tenantTx(item.tenant_id, async (c) => {
      await executionLock(c, item.id);
      const pointer = (
        await c.query('SELECT job_id FROM payment_import_executions WHERE id=$1', [item.id])
      ).rows[0];
      const j = (await c.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [pointer.job_id]))
          .rows[0],
        e = (
          await c.query('SELECT * FROM payment_import_executions WHERE id=$1 FOR UPDATE', [item.id])
        ).rows[0];
      if (e.state !== 'queued' || j.state !== 'failed') return 0;
      ensure(
        !(
          await c.query('SELECT 1 FROM payment_import_receipts WHERE execution_id=$1 LIMIT 1', [
            e.id,
          ])
        ).rowCount,
        409,
        'Wykonanie ma trwałe wyniki',
      );
      await settleFailure(c, e, 'failed', 'Zadanie wyczerpało próby; niczego nie zaksięgowano');
      return 1;
    });
  return count;
}

export async function paymentImportHistory(
  a: Actor,
  kind: 'previews' | 'executions',
  cursor?: string,
) {
  return tenantTx(a.tenantId, async (c) => {
    await paymentImportAdmin(c, a);
    const table = kind === 'previews' ? 'payment_import_previews' : 'payment_import_executions';
    const rows = (
      await c.query(
        `SELECT * FROM ${table} WHERE ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM ${table} WHERE id=$1)) ORDER BY created_at DESC,id DESC LIMIT 51`,
        [cursor ?? null],
      )
    ).rows;
    return {
      ...flags,
      data: rows.slice(0, 50).map((r) => (kind === 'previews' ? previewHead(r) : executionHead(r))),
      meta: { cursor: rows.length > 50 ? rows[49].id : null },
    };
  });
}
export async function paymentImportPreviewDetail(a: Actor, id: string, cursor?: string) {
  return tenantTx(a.tenantId, async (c) => {
    await paymentImportAdmin(c, a);
    const p = (await c.query('SELECT * FROM payment_import_previews WHERE id=$1', [id])).rows[0];
    ensure(p, 404, 'Nie znaleziono podglądu');
    const rows = (
      await c.query(
        'SELECT * FROM payment_import_rows WHERE preview_id=$1 AND ($2::uuid IS NULL OR position>(SELECT position FROM payment_import_rows WHERE preview_id=$1 AND row_id=$2)) ORDER BY position LIMIT 51',
        [id, cursor ?? null],
      )
    ).rows;
    return {
      ...flags,
      ...previewHead(p),
      profile_snapshot: p.profile,
      data: rows.slice(0, 50),
      meta: { cursor: rows.length > 50 ? rows[49].row_id : null },
    };
  });
}
export async function paymentImportExecutionDetail(a: Actor, id: string, cursor?: string) {
  return tenantTx(a.tenantId, async (c) => {
    await paymentImportAdmin(c, a);
    const e = (await c.query('SELECT * FROM payment_import_executions WHERE id=$1', [id])).rows[0];
    ensure(e, 404, 'Nie znaleziono wykonania');
    const rows = (
      await c.query(
        "SELECT r.*,to_jsonb(y)||jsonb_build_object('order_number',o.number,'reversed',EXISTS(SELECT 1 FROM payment_entries v WHERE v.reversal_of=y.entry_id)) receipt FROM payment_import_execution_rows x JOIN payment_import_rows r ON (r.tenant_id,r.preview_id,r.row_id)=(x.tenant_id,x.preview_id,x.row_id) LEFT JOIN payment_import_receipts y ON (y.tenant_id,y.execution_id,y.row_id)=(x.tenant_id,x.execution_id,x.row_id) LEFT JOIN orders o ON (o.tenant_id,o.id)=(y.tenant_id,y.order_id) WHERE x.execution_id=$1 AND ($2::uuid IS NULL OR x.position>(SELECT position FROM payment_import_execution_rows WHERE execution_id=$1 AND row_id=$2)) ORDER BY x.position LIMIT 51",
        [id, cursor ?? null],
      )
    ).rows;
    return {
      ...flags,
      ...executionHead(e),
      data: rows.slice(0, 50),
      meta: { cursor: rows.length > 50 ? rows[49].row_id : null },
    };
  });
}
export async function paymentImportReceipts(a: Actor, cursor?: string, orderId?: string) {
  return tenantTx(a.tenantId, async (c) => {
    await paymentImportAdmin(c, a);
    const rows = (
      await c.query(
        "SELECT r.*,o.number order_number,to_char(r.booking_date,'YYYY-MM-DD') booking_date,EXISTS(SELECT 1 FROM payment_entries v WHERE v.reversal_of=r.entry_id) reversed FROM payment_import_receipts r JOIN orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id) WHERE ($2::uuid IS NULL OR r.order_id=$2) AND ($1::uuid IS NULL OR (r.created_at,r.id)<(SELECT created_at,id FROM payment_import_receipts WHERE id=$1)) ORDER BY r.created_at DESC,r.id DESC LIMIT 51",
        [cursor ?? null, orderId ?? null],
      )
    ).rows;
    return {
      ...flags,
      data: rows.slice(0, 50),
      meta: { cursor: rows.length > 50 ? rows[49].id : null },
    };
  });
}
