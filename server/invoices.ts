import { automationOnlyEvent } from './automation-v2-triggers';
import {assertNoPartialCommercialInvoiceInTx} from './commercial-sale-scope';
import {assertNoLocalInvoiceForExternalInTx} from './local-invoices';
import {assertNoInvoice230InTx} from './invoice230';
import { b2bDropshipBillToInTx } from './b2b-dropship-guards';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit, lockedOrder, type Actor } from './domain';
import { encrypt } from './security';
import { channelRead, loadChannel, type IntegrationContext } from './channel-access';
import { Fakturownia } from './integrations';
import { returnInvoiceSnapshot, partialCorrectionPositions } from './return-invoices';
import { assertSaleFinancialOrderInTx, assertRefundRemedyInTx } from './order-fulfillment-kind';

const vat = z.union([z.literal(0), z.literal(5), z.literal(8), z.literal(23)]);
const text = z.string().trim().min(1).max(200);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + 'T12:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Nieprawidłowa data');
export const nip = z
  .string()
  .regex(/^\d{10}$/)
  .refine((v) => {
    const sum = [6, 5, 7, 2, 3, 4, 5, 6, 7].reduce((n, w, i) => n + w * Number(v[i]), 0);
    return sum % 11 === Number(v[9]) && !/^0+$/.test(v);
  }, 'Nieprawidłowy NIP');
const party = z.object({
  name: text,
  street: text,
  city: text,
  postal_code: z.string().regex(/^\d{2}-\d{3}$/),
  tax_no: z.union([nip, z.literal('')]).default(''),
});
export const invoiceInput = z.object({
  channel_id: z.uuid(),
  kind: z.enum(['invoice', 'correction']).default('invoice'),
  return_id: z.uuid().optional(),
  seller: party.extend({ tax_no: nip }),
  buyer: party.extend({ email: z.email() }),
  issue_date: date,
  sell_date: date,
  payment_to: date,
  payment_type: z.enum(['transfer', 'card', 'cash', 'payu', 'paypal', 'other']).default('transfer'),
  item_vat: z
    .array(z.object({ item_id: z.uuid(), vat }))
    .min(1)
    .max(100),
  shipping_vat: vat,
  correction_reason: z.string().trim().max(256).default('Pełny zwrot zamówienia'),
});
type Input = z.infer<typeof invoiceInput>;
const decimal = (v: number) => (v / 100).toFixed(2);
export function invoiceMinor(v: unknown) {
  const s = String(v ?? '');
  ensure(/^-?\d{1,10}(\.\d{1,2})?$/.test(s), 502, 'Nieprawidłowa kwota dokumentu');
  const negative = s.startsWith('-'),
    [a, b = ''] = s.replace('-', '').split('.');
  const n = Number(a) * 100 + Number(b.padEnd(2, '0'));
  ensure(Number.isSafeInteger(n), 502, 'Za duża kwota');
  return negative ? -n : n;
}
const same = isDeepStrictEqual;
function snapshot(o: any, items: any[]) {
  return {
    total: o.total,
    currency: o.currency,
    shipping_cost: o.shipping_cost,
    customer_name: o.customer_name,
    email: o.email,
    address: o.address,
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      quantity: i.quantity,
      line_total: i.line_total,
      vat: i.vat,
    })),
  };
}
function allowed(o: any, kind: string, returnId?: string | null) {
  ensure(
    !['new', 'cancelled'].includes(o.status),
    409,
    'Dokument dostępny po opłaceniu zamówienia',
  );
  ensure(
    o.currency === 'PLN' && o.address.country === 'PL',
    422,
    'Obecnie faktury krajowe PL w PLN',
  );
  if (kind === 'correction' && !returnId)
    ensure(
      ['return_received', 'return_completed'].includes(o.status),
      409,
      'Najpierw przyjmij pełny zwrot',
    );
}
function parties(input: Input) {
  const fields: Record<string, unknown> = {};
  for (const who of ['seller', 'buyer'] as const) {
    const p = input[who];
    Object.assign(fields, {
      [who + '_name']: p.name,
      [who + '_street']: p.street,
      [who + '_city']: p.city,
      [who + '_post_code']: p.postal_code,
      [who + '_country']: 'PL',
      [who + '_tax_no']: p.tax_no,
      [who + '_tax_no_kind']: p.tax_no ? '' : 'empty',
    });
  }
  return { ...fields, buyer_email: input.buyer.email, buyer_company: Boolean(input.buyer.tax_no) };
}
/** Wholesale documents use the frozen purchasing firm, separately from ship-to. */
async function invoiceOrderInTx(c: PoolClient, order: any) {
  await assertSaleFinancialOrderInTx(c, order.id);
  const billTo = await b2bDropshipBillToInTx(c, order.id);
  return billTo
    ? { ...order, customer_name: billTo.name, email: billTo.email, address: billTo.address }
    : order;
}
export async function previewInvoice(a: Actor, orderId: string, input: Input) {
  return tenantTx(a.tenantId, async (c) => {
    const locked = await lockedOrder(c, orderId);
    const billTo = await b2bDropshipBillToInTx(c, orderId);
    const o = await invoiceOrderInTx(c, locked);
    if (billTo)
      input = invoiceInput.parse({
        ...input,
        buyer: {
          name: billTo.name,
          email: billTo.email,
          street: billTo.address.street,
          city: billTo.address.city,
          postal_code: billTo.address.postal_code,
          tax_no: billTo.tax_id,
        },
      });
    allowed(o, input.kind, input.return_id);
    if (input.return_id) await assertRefundRemedyInTx(c, input.return_id);
    ensure(
      !input.return_id || input.kind === 'correction',
      422,
      'Sprawa zwrotowa dotyczy wyłącznie korekty',
    );
    if (input.kind === 'correction' && !input.return_id)
      ensure(
        !(await c.query('SELECT id FROM return_cases WHERE order_id=$1 AND NOT legacy', [orderId]))
          .rowCount,
        409,
        'Wybierz sprawę częściową zamiast pełnej korekty',
      );
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [input.channel_id])).rows[0];
    ensure(ch?.provider === 'fakturownia', 422, 'Wybierz Fakturownię');
    await assertNoPartialCommercialInvoiceInTx(c,orderId);await assertNoInvoice230InTx(c,orderId);
    if(!ch.settings.simulation)await assertNoLocalInvoiceForExternalInTx(c,orderId);
    const items = (
      await c.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [orderId])
    ).rows;
    ensure(
      items.length === input.item_vat.length &&
        new Set(input.item_vat.map((v) => v.item_id)).size === items.length &&
        items.every((i) => input.item_vat.some((v) => v.item_id === i.id)),
      422,
      'Potwierdź VAT wszystkich pozycji',
    );
    ensure(input.payment_to >= input.issue_date, 422, 'Termin płatności poprzedza wystawienie');
    ensure(
      items.reduce((n, i) => n + i.line_total, o.shipping_cost) === o.total,
      409,
      'Pozycje nie sumują się do zamówienia',
    );
    const id = randomUUID();
    const returnSnapshot = input.return_id
      ? await returnInvoiceSnapshot(
          c,
          input.return_id,
          orderId,
          ch.id,
          ch.settings.simulation ? 'simulation' : 'external',
        )
      : null;
    let original: any;
    let positions = items.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      tax: input.item_vat.find((v) => v.item_id === i.id)!.vat,
      total_price_gross: decimal(i.line_total),
    }));
    if (o.shipping_cost)
      positions.push({
        name: 'Dostawa',
        quantity: 1,
        tax: input.shipping_vat,
        total_price_gross: decimal(o.shipping_cost),
      });
    let payload: any = {
      ...parties(input),
      kind: 'vat',
      income: '1',
      exclude_from_stock_level: true,
      number: null,
      currency: 'PLN',
      lang: 'pl',
      issue_date: input.issue_date,
      sell_date: input.sell_date,
      payment_to: input.payment_to,
      payment_type: input.payment_type,
      status: 'issued',
      positions,
      oid: `DYNA-${a.tenantId}-${orderId}-${input.kind}${input.return_id ? '-' + input.return_id : ''}`,
      oid_unique: 'yes',
      description: o.number,
    };
    if (input.kind === 'correction') {
      ensure(input.correction_reason.length > 0, 422, 'Podaj przyczynę korekty');
      original = (
        await c.query(
          "SELECT d.*,p.payload FROM documents d JOIN invoice_plans p ON p.document_id=d.id AND p.tenant_id=d.tenant_id WHERE d.order_id=$1 AND d.kind='invoice' AND d.channel_id=$2 AND p.state='done'",
          [orderId, ch.id],
        )
      ).rows[0];
      ensure(original, 409, 'Najpierw faktura z tej samej integracji');
      ensure(
        original.data.total === o.total && same(parties(input), parties(original.data.input)),
        409,
        'Dane stron korekty muszą zgadzać się z fakturą',
      );
      positions = original.payload.positions;
      ensure(
        positions.every((p: any, i: number) => p.tax === payload.positions[i]?.tax) &&
          positions.length === payload.positions.length,
        409,
        'Korekta zachowuje VAT dokumentu pierwotnego',
      );
      payload = {
        ...payload,
        kind: 'correction',
        invoice_id: original.external_id,
        from_invoice_id: original.external_id,
        correction_reason: input.correction_reason,
        positions: returnSnapshot
          ? partialCorrectionPositions(original, items, returnSnapshot)
          : positions.map((p: any) => ({
              ...p,
              quantity: -p.quantity,
              total_price_gross: decimal(-invoiceMinor(p.total_price_gross)),
              kind: 'correction',
              correction_before_attributes: { ...p, kind: 'correction_before' },
              correction_after_attributes: {
                ...p,
                quantity: 0,
                total_price_gross: '0.00',
                kind: 'correction_after',
              },
            })),
      };
    }
    const s = {
      ...snapshot(o, items),
      original: original
        ? { id: original.id, external_id: original.external_id, number: original.number }
        : null,
      ...(returnSnapshot ? { return_snapshot: returnSnapshot } : {}),
    };
    await c.query(
      'INSERT INTO invoice_plans(id,tenant_id,order_id,channel_id,actor_id,kind,input,payload,order_snapshot,mode,return_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        id,
        a.tenantId,
        orderId,
        ch.id,
        a.userId,
        input.kind,
        JSON.stringify(input),
        JSON.stringify(payload),
        JSON.stringify(s),
        ch.settings.simulation ? 'simulation' : 'external',
        input.return_id ?? null,
      ],
    );
    await audit(c, a, 'invoice.preview', id, { kind: input.kind });
    return { id, payload, order_snapshot: s, state: 'preview' };
  });
}
export async function lockedInvoice(c: PoolClient, id: string) {
  const initial = (await c.query('SELECT order_id FROM invoice_plans WHERE id=$1', [id])).rows[0];
  ensure(initial, 404, 'Nie znaleziono planu');
  const o = await lockedOrder(c, initial.order_id);
  const p = (await c.query('SELECT * FROM invoice_plans WHERE id=$1 FOR UPDATE', [id])).rows[0];
  return { o: await invoiceOrderInTx(c, o), p };
}
export async function invoiceJob(c: PoolClient, a: Actor, p: any) {
  const id = randomUUID();
  await c.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,$3,$4,$5)', [
    id,
    a.tenantId,
    'invoice.write',
    JSON.stringify({ plan_id: p.id, actor_id: a.userId }),
    'invoice:' + p.id + ':' + id,
  ]);
  await c.query(
    "UPDATE invoice_plans SET state='queued',job_id=$2,error=NULL,updated_at=now() WHERE id=$1",
    [p.id, id],
  );
  return { id: p.id, job_id: id };
}
async function validateReturnSnapshot(c: PoolClient, o: any, p: any) {
  if (p.return_id) await assertRefundRemedyInTx(c, p.return_id);
  if (p.return_id)
    ensure(
      same(
        await returnInvoiceSnapshot(c, p.return_id, o.id, p.channel_id, p.mode, p.id),
        p.order_snapshot.return_snapshot,
      ),
      409,
      'Sprawa lub poprzednie korekty zmieniły się; przygotuj nowy podgląd',
    );
  else if (p.kind === 'correction')
    ensure(
      !(await c.query('SELECT id FROM return_cases WHERE order_id=$1 AND NOT legacy', [o.id]))
        .rowCount,
      409,
      'Pełna korekta nie może objąć częściowych spraw',
    );
}
const invoiceAmount = (p: any) =>
  p.order_snapshot.return_snapshot?.refund_amount ?? p.order_snapshot.total;
export async function queueInvoice(
  c: PoolClient,
  a: Actor,
  id: string,
  confirmed: boolean,
  checked: boolean,
) {
  const { o, p } = await lockedInvoice(c, id);
  await assertNoPartialCommercialInvoiceInTx(c,o.id);await assertNoInvoice230InTx(c,o.id);
  if(p.mode==='external')await assertNoLocalInvoiceForExternalInTx(c,o.id);
  ensure(p.actor_id === a.userId, 403, 'Dokument zatwierdza autor podglądu');
  if (['queued', 'done'].includes(p.state)) return { id: p.id, job_id: p.job_id };
  ensure(
    p.state === 'preview' && Date.now() - new Date(p.created_at).getTime() < 30 * 60 * 1000,
    409,
    'Przygotuj nowy podgląd',
  );
  allowed(o, p.kind, p.return_id);
  const items = (await c.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [o.id]))
    .rows;
  ensure(
    same(
      snapshot(o, items),
      Object.fromEntries(
        Object.entries(p.order_snapshot).filter(
          ([k]) => !['original', 'return_snapshot'].includes(k),
        ),
      ),
    ),
    409,
    'Zamówienie zmieniło się; przygotuj nowy podgląd',
  );
  await validateReturnSnapshot(c, o, p);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [p.channel_id])).rows[0];
  ensure(
    ch?.settings.simulation || confirmed,
    422,
    'Potwierdź wystawienie w Fakturowni i ustawienia automatycznej wysyłki konta',
  );
  ensure(checked, 422, 'Potwierdź dane stron, VAT i daty');
  ensure(
    !(
      await c.query(
        "SELECT id FROM invoice_plans WHERE order_id=$1 AND kind=$2 AND mode=$3 AND return_id IS NOT DISTINCT FROM $4::uuid AND state NOT IN ('preview','cancelled')",
        [o.id, p.kind, p.mode, p.return_id],
      )
    ).rowCount,
    409,
    'Zamówienie ma już dokument lub niepewny zapis tego rodzaju',
  );
  await audit(c, a, 'invoice.queue', id, { confirm_external: confirmed, confirm_data: checked });
  return invoiceJob(c, a, p);
}
export async function invoiceExample(a: Actor) {
  return tenantTx(a.tenantId, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'invoice-example:' + a.tenantId,
    ]);
    const existing = (
      await c.query(
        "SELECT id FROM channels WHERE provider='fakturownia' AND settings->>'simulation'='true'",
        [],
      )
    ).rows[0];
    if (existing) return existing;
    const id = randomUUID();
    await c.query(
      'INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        a.tenantId,
        'fakturownia',
        'Fakturownia — przykład lokalny',
        'sandbox',
        encrypt({}),
        JSON.stringify({ simulation: true, account_url: 'https://example.fakturownia.pl' }),
        'local_simulation',
      ],
    );
    await audit(c, a, 'invoice.example', id);
    return { id };
  });
}
const remoteId = (v: unknown) => {
  ensure(
    typeof v !== 'number' || Number.isSafeInteger(v),
    502,
    'ID faktury przekracza bezpieczny zakres',
  );
  const s = String(v ?? '');
  ensure(/^[1-9]\d{0,17}$/.test(s), 502, 'Nieprawidłowe ID faktury');
  return s;
};
export function verifiedInvoice(p: any, r: any) {
  ensure(r && typeof r === 'object' && !Array.isArray(r), 502, 'Nieprawidłowy dokument Fakturowni');
  remoteId(r.id);
  ensure(!p.remote_id || String(r.id) === p.remote_id, 409, 'Inny dokument Fakturowni');
  const x = p.payload;
  for (const key of [
    'oid',
    'kind',
    'currency',
    'issue_date',
    'sell_date',
    'payment_to',
    'payment_type',
    'buyer_email',
    'seller_name',
    'buyer_name',
    'seller_street',
    'buyer_street',
    'seller_city',
    'buyer_city',
    'seller_post_code',
    'buyer_post_code',
    'seller_country',
    'buyer_country',
  ])
    ensure(r[key] === x[key], 409, 'Dane faktury różnią się od zatwierdzonego podglądu');
  for (const key of ['seller_tax_no', 'buyer_tax_no'])
    ensure(
      String(r[key] ?? '').replace(/[^0-9]/g, '') === x[key],
      409,
      'NIP faktury różni się od podglądu',
    );
  ensure(
    typeof r.number === 'string' && r.number.length > 0 && r.number.length <= 200,
    502,
    'Brak numeru faktury',
  );
  ensure(
    invoiceMinor(r.price_gross) === (p.kind === 'correction' ? -1 : 1) * invoiceAmount(p),
    409,
    'Suma dokumentu różni się od zamówienia',
  );
  const positions = r.positions;
  ensure(
    Array.isArray(positions) && positions.length === x.positions.length,
    409,
    'Pozycje faktury różnią się od podglądu',
  );
  // Match a multiset rather than trusting provider order or silently dropping duplicate names.
  const key = (i: any) => {
    ensure(
      i && /^-?\d+(\.0+)?$/.test(String(i.quantity)) && /^(0|5|8|23)(\.0+)?$/.test(String(i.tax)),
      409,
      'Nieprawidłowa ilość lub VAT pozycji',
    );
    return JSON.stringify([
      i.name,
      Number(i.quantity),
      Number(i.tax),
      invoiceMinor(i.total_price_gross),
    ]);
  };
  ensure(
    same(positions.map(key).sort(), x.positions.map(key).sort()),
    409,
    'Kwoty, ilości lub VAT pozycji różnią się od podglądu',
  );
  if (p.kind === 'correction') {
    ensure(
      String(r.from_invoice_id) === String(x.from_invoice_id) &&
        String(r.invoice_id) === String(x.invoice_id) &&
        r.correction_reason === x.correction_reason,
      409,
      'Korekta dotyczy innej faktury',
    );
    for (const i of positions) {
      const expected = x.positions.find((e: any) => key(e) === key(i));
      for (const side of ['correction_before_attributes', 'correction_after_attributes'])
        ensure(
          i[side] && key(i[side]) === key(expected[side]),
          409,
          'Treść przed / po korekcie różni się od podglądu',
        );
    }
  }
  return {
    id: String(r.id),
    number: r.number,
    status: String(r.status ?? '').slice(0, 80),
    gov_status: r.gov_status == null ? null : String(r.gov_status).slice(0, 80),
    gov_id: r.gov_id == null ? null : String(r.gov_id).slice(0, 120),
  };
}
async function findRemote(client: Fakturownia, oid: string) {
  const found: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await client.invoiceByOrder(oid, page);
    ensure(Array.isArray(rows) && rows.length <= 100, 502, 'Nieprawidłowa lista faktur');
    found.push(...rows.filter((r: any) => r.oid === oid));
    ensure(found.length <= 1, 409, 'Kilka faktur z tym identyfikatorem; sprawdź konto');
    if (rows.length < 100) return found[0] ?? null;
  }
  throw new Problem(409, 'Przekroczono 2000 wyników uzgodnienia; sprawdź filtr OID na koncie');
}
async function fence(c: PoolClient, job: any) {
  return Boolean(
    (
      await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rowCount,
  );
}
async function phase(job: any, value: string, remote?: string) {
  return tenantTx(job.tenant_id, async (c) => {
    if (!(await fence(c, job))) return false;
    return Boolean(
      (
        await c.query(
          'UPDATE invoice_plans SET phase=$2,remote_id=coalesce($3,remote_id),updated_at=now() WHERE id=$1 AND job_id=$4',
          [job.payload.plan_id, value, remote ?? null, job.id],
        )
      ).rowCount,
    );
  });
}
export async function processInvoice(job: any, ctx: IntegrationContext = {}) {
  const membership = (
    await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
      job.tenant_id,
      job.payload.actor_id,
    ])
  ).rows[0];
  ensure(
    membership && ['admin', 'operator'].includes(membership.role),
    403,
    'Autor utracił prawo wystawiania dokumentów',
  );
  const actor: Actor = {
    tenantId: job.tenant_id,
    userId: job.payload.actor_id,
    role: membership.role,
  };
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'invoices');
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
    const initial = await tenantTx(
      job.tenant_id,
      async (c) =>
        (await c.query('SELECT * FROM invoice_plans WHERE id=$1', [job.payload.plan_id])).rows[0],
    );
    ensure(initial, 404, 'Nie znaleziono planu');
    await lock.query("SET statement_timeout='20s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      'invoice:' + job.tenant_id + ':' + initial.order_id,
    ]);
    if (!(await tenantTx(job.tenant_id, (c) => fence(c, job)))) return;
    const p = await tenantTx(job.tenant_id, async (c) => {
      const { p, o } = await lockedInvoice(c, initial.id);
      await assertNoPartialCommercialInvoiceInTx(c,o.id);await assertNoInvoice230InTx(c,o.id);
      if(p.mode==='external')await assertNoLocalInvoiceForExternalInTx(c,o.id);
      ensure(
        p.state === 'queued' && p.job_id === job.id && p.actor_id === actor.userId,
        409,
        'Nieaktualne zadanie',
      );
      if (p.phase === 'ready') {
        allowed(o, p.kind, p.return_id);
        const items = (
          await c.query('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [o.id])
        ).rows;
        ensure(
          same(
            snapshot(o, items),
            Object.fromEntries(
              Object.entries(p.order_snapshot).filter(
                ([k]) => !['original', 'return_snapshot'].includes(k),
              ),
            ),
          ),
          409,
          'Zamówienie zmieniło się przed zapisem faktury',
        );
        await validateReturnSnapshot(c, o, p);
      }
      return p;
    });
    const ch = await loadChannel(job.tenant_id, p.channel_id);
    ensure(ch.provider === 'fakturownia', 422, 'Wymagana Fakturownia');
    ensure(
      p.mode === (ch.settings.simulation ? 'simulation' : 'external'),
      409,
      'Tryb integracji zmienił się po podglądzie',
    );
    let r: any;
    if (ch.settings.simulation) {
      if (!(await phase(job, 'create_started'))) return;
      r = {
        ...p.payload,
        id: String(BigInt('0x' + p.id.replaceAll('-', '').slice(0, 12))),
        number: `DEMO-API-${p.kind === 'invoice' ? 'FV' : 'KOR'}/${p.id.slice(0, 8)}`,
        price_gross: decimal((p.kind === 'correction' ? -1 : 1) * invoiceAmount(p)),
        gov_status: null,
        gov_id: null,
      };
    } else
      r = await channelRead(
        job.tenant_id,
        ch.id,
        async (client) => {
          ensure(client instanceof Fakturownia, 422, 'Wymagana Fakturownia');
          if (p.remote_id) return client.invoice(p.remote_id);
          const found = await findRemote(client, p.payload.oid);
          if (found) {
            p.remote_id = remoteId(found.id);
            return client.invoice(p.remote_id);
          }
          ensure(
            p.phase === 'ready',
            409,
            'Niepewny zapis nie jest widoczny w API. Sprawdź konto; drugi POST zablokowany',
          );
          if (p.kind === 'correction') {
            const original = await tenantTx(
              job.tenant_id,
              async (c) =>
                (
                  await c.query('SELECT * FROM invoice_plans WHERE document_id=$1', [
                    p.order_snapshot.original.id,
                  ])
                ).rows[0],
            );
            ensure(original, 409, 'Brak dokumentu pierwotnego');
            verifiedInvoice(original, await client.invoice(original.remote_id));
          }
          if (!(await phase(job, 'create_started'))) return null;
          const created = await client.createInvoice(p.payload);
          const id = remoteId(created.id);
          if (!(await phase(job, 'created', id))) return null;
          p.remote_id = id;
          return client.invoice(id);
        },
        ctx,
        false,
      );
    if (!r) return;
    const result = {
      ...verifiedInvoice(p, r),
      scope: ch.settings.simulation ? 'local_simulation' : 'external_api_verified',
    };
    await tenantTx(job.tenant_id, async (c) => {
      if (!(await fence(c, job))) return;
      const { p: current } = await lockedInvoice(c, p.id);
      ensure(current.job_id === job.id, 409, 'Nieaktualne zadanie');
      const documentId = randomUUID(),
        s = p.order_snapshot;
      const data = {
        seller: p.input.seller.name,
        customer: p.input.buyer.name,
        email: p.input.buyer.email,
        address: p.input.buyer,
        currency: 'PLN',
        total: (p.kind === 'correction' ? -1 : 1) * invoiceAmount(p),
        shipping_cost: s.return_snapshot?.shipping_cost ?? s.shipping_cost,
        input: p.input,
        original: s.original,
        items: (s.return_snapshot
          ? s.items
              .filter((i: any) => s.return_snapshot.items.some((l: any) => l.item_id === i.id))
              .map((i: any) => {
                const l = s.return_snapshot.items.find((l: any) => l.item_id === i.id);
                return { ...i, quantity: l.accepted, line_total: l.refund_amount };
              })
          : s.items
        ).map((i: any) => ({
          ...i,
          gross: i.line_total,
          vat: p.input.item_vat.find((v: any) => v.item_id === i.id).vat,
        })),
        provider: 'fakturownia',
        result,
      };
      await automationOnlyEvent(c, actor.tenantId, p.order_id, 'document.issued', { document_id: documentId, kind: p.kind });
      await c.query(
        'INSERT INTO documents(id,tenant_id,order_id,number,kind,mode,data,channel_id,external_id,return_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          documentId,
          actor.tenantId,
          p.order_id,
          result.number,
          p.kind,
          ch.settings.simulation ? 'simulation' : 'external',
          JSON.stringify(data),
          ch.id,
          result.id,
          p.return_id,
        ],
      );
      await c.query(
        "UPDATE invoice_plans SET state='done',phase='created',remote_id=$2,document_id=$3,result=$4,error=NULL,updated_at=now() WHERE id=$1",
        [p.id, result.id, documentId, JSON.stringify(result)],
      );
      await c.query(
        "UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL WHERE id=$1",
        [job.id],
      );
      await audit(c, actor, 'invoice.saved', documentId, {
        plan_id: p.id,
        kind: p.kind,
        ...result,
      });
    });
    });
  } finally {
    await lock.end();
  }
}
export async function failInvoice(job: any, e: unknown) {
  return tenantTx(job.tenant_id, async (c) => {
    if (!(await fence(c, job))) return;
    const terminal =
      (e instanceof Problem && [403, 404, 409, 422].includes(e.status)) ||
      job.attempts >= job.max_attempts;
    const error = e instanceof Problem ? e.message : 'Błąd integracji Fakturownia; uzgodnij zapis';
    await c.query(
      'UPDATE invoice_plans SET state=$2,error=$3,updated_at=now() WHERE id=$1 AND job_id=$4',
      [job.payload.plan_id, terminal ? 'failed' : 'queued', error, job.id],
    );
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', error],
    );
  });
}
