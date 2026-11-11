import { assertNoPartialCommercialInvoiceInTx } from './commercial-sale-scope';
import { assertNoInvoice230InTx } from './invoice230';
import {assertNoFa3DraftProjectInTx} from './fa3-draft-access';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, lockedOrder, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { loadChannel, type IntegrationContext } from './channel-access';
import { safeFetch } from './integrations';
import { decrypt } from './security';
import { sourceHash } from './catalog-source-normalize';
import { connectionHash } from './offer-sync-policy';
import {
  OdooAccounting,
  accountingPayload,
  verifyOdooInvoice,
  simulatedAccounting,
  simulatedInvoice,
} from './odoo-accounting';
import { odooId } from './odoo';
import { assertSaleFinancialOrderInTx } from './order-fulfillment-kind';
const id = z.number().int().positive().max(2147483647),
  vat = z.union([z.literal(0), z.literal(5), z.literal(8), z.literal(23)]);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + 'T12:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });
export const odooExportInput = z
  .object({
    client_key: z.uuid(),
    channel_id: z.uuid(),
    partner_id: id,
    journal_id: id,
    account_id: id,
    invoice_date: date,
    due_date: date,
    shipping_vat: vat,
    taxes: z
      .array(z.object({ vat, tax_id: id }).strict())
      .min(1)
      .max(4),
  })
  .strict();
type Input = z.infer<typeof odooExportInput>;
export function exportSource(d: any, input: Input) {
  ensure(
    d.kind === 'invoice',
    422,
    'Eksport dotyczy faktury sprzedaży; korekty wymagają osobnego procesu',
  );
  const v = d.data;
  ensure(v && typeof v === 'object', 422, 'Brak danych źródłowej faktury');
  const a = v.input?.buyer ?? v.address;
  ensure(a && typeof a === 'object', 422, 'Brak adresu nabywcy');
  ensure(
    v &&
      Array.isArray(v.items) &&
      v.items.length > 0 &&
      v.items.length <= 100 &&
      Number.isInteger(v.total) &&
      v.total > 0 &&
      v.total <= 2147483647 &&
      Number.isInteger(v.shipping_cost) &&
      v.shipping_cost >= 0,
    422,
    'Nieprawidłowe dane źródłowego dokumentu',
  );
  const lines = v.items.map((i: any) => {
    const gross = i.gross ?? i.line_total;
    ensure(
      typeof i.name === 'string' &&
        i.name.length > 0 &&
        i.name.length <= 200 &&
        Number.isInteger(i.quantity) &&
        i.quantity > 0 &&
        i.quantity <= 100000 &&
        Number.isInteger(gross) &&
        gross >= 0 &&
        vat.safeParse(i.vat).success,
      422,
      'Nieprawidłowa pozycja źródłowej faktury',
    );
    return { name: i.name, quantity: i.quantity, gross, vat: i.vat };
  });
  if (v.shipping_cost) {
    ensure(
      v.input?.shipping_vat === undefined || v.input.shipping_vat === input.shipping_vat,
      422,
      'VAT dostawy różni się od źródłowego dokumentu',
    );
    lines.push({ name: 'Dostawa', quantity: 1, gross: v.shipping_cost, vat: input.shipping_vat });
  }
  ensure(
    lines.reduce((n: number, i: any) => n + i.gross, 0) === v.total,
    422,
    'Pozycje dokumentu nie sumują się do jego kwoty',
  );
  const rates = [...new Set(lines.map((l: any) => l.vat))].sort();
  ensure(
    new Set(input.taxes.map((t) => t.vat)).size === input.taxes.length &&
      new Set(input.taxes.map((t) => t.tax_id)).size === input.taxes.length &&
      isDeepStrictEqual(input.taxes.map((t) => t.vat).sort(), rates),
    422,
    'Powiąż każdą stawkę VAT z jednym osobnym podatkiem Odoo',
  );
  const issue =
    v.input?.issue_date ??
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date(d.created_at));
  ensure(
    input.invoice_date === issue &&
      input.due_date >= issue &&
      (!v.input?.payment_to || input.due_date === v.input.payment_to),
    422,
    'Daty eksportu różnią się od dokumentu lub termin poprzedza wystawienie',
  );
  const buyer = z
    .object({
      name: z.string().min(2).max(200),
      email: z.email(),
      street: z.string().min(1).max(200),
      city: z.string().min(1).max(200),
      postal_code: z.string().min(1).max(30),
      country: z.string().regex(/^[A-Z]{2}$/),
      tax_no: z.string().max(50),
    })
    .parse({
      name: v.input?.buyer?.name ?? v.customer,
      email: v.email,
      street: a.street,
      city: a.city,
      postal_code: a.postal_code,
      country: a.country ?? (v.input ? 'PL' : undefined),
      tax_no: a.tax_no ?? '',
    });
  return {
    document_id: d.id,
    number: d.number,
    currency: z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']).parse(v.currency),
    total: v.total,
    buyer,
    lines,
    source_mode: d.mode,
    seller: v.seller,
    invoice_date: issue,
  };
}
const credentialsHash = (ch: any) => sourceHash(ch.credentials);
function connection(ch: any, p: any) {
  ensure(
    ch?.provider === 'odoo' &&
      connectionHash(ch) === p.connection_hash &&
      credentialsHash(ch) === p.credentials_hash &&
      p.mode === (ch.settings.simulation ? 'simulation' : 'external'),
    409,
    'Połączenie Odoo zmieniło się od podglądu; uzgodnij eksport przed dalszym zapisem',
  );
}
async function source(c: PoolClient, documentId: string, input: Input) {
  const d = (await c.query('SELECT * FROM documents WHERE id=$1', [documentId])).rows[0];
  ensure(d, 404, 'Nie znaleziono faktury');
  const o = await lockedOrder(c, d.order_id);
  await assertNoFa3DraftProjectInTx(c,o.id);
  await assertNoPartialCommercialInvoiceInTx(c,o.id);await assertNoInvoice230InTx(c,o.id);
  await assertSaleFinancialOrderInTx(c, o.id);
  ensure(
    !['new', 'cancelled'].includes(o.status),
    409,
    'Dokument wymaga zamówienia dopuszczonego do realizacji',
  );
  return { d, o, normalized: exportSource(d, input) };
}
export async function previewOdooExport(
  actor: Actor,
  documentId: string,
  input: Input,
  ctx: IntegrationContext = {},
) {
  const initial = await tenantTx(actor.tenantId, async (c) => {
    const data = await source(c, documentId, input);
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [input.channel_id])).rows[0];
    ensure(ch?.provider === 'odoo', 404, 'Wybierz własną integrację Odoo');
    return { ...data, ch };
  });
  const fence = async () =>
    tenantTx(actor.tenantId, async (c) => {
      ensure(
        ['admin', 'operator'].includes(
          (
            await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
              actor.tenantId,
              actor.userId,
            ])
          ).rows[0]?.role,
        ),
        403,
        'Autor utracił prawo eksportu faktur',
      );
      const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [input.channel_id])).rows[0];
      ensure(
        ch &&
          connectionHash(ch) === connectionHash(initial.ch) &&
          credentialsHash(ch) === credentialsHash(initial.ch),
        409,
        'Połączenie zmieniło się podczas podglądu',
      );
    });
  await fence();
  const metadata = initial.ch.settings.simulation
    ? simulatedAccounting(initial.normalized, input)
    : await new OdooAccounting(
        initial.ch.settings,
        decrypt(initial.ch.credentials),
        ctx.transport ?? safeFetch,
      ).metadata(initial.normalized, input, fence);
  await fence();
  return tenantTx(actor.tenantId, async (c) => {
    const current = await source(c, documentId, input),
      ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [input.channel_id]))
        .rows[0];
    ensure(
      isDeepStrictEqual(current.normalized, initial.normalized) &&
        connectionHash(ch) === connectionHash(initial.ch) &&
        credentialsHash(ch) === credentialsHash(initial.ch),
      409,
      'Dane lub połączenie zmieniły się podczas podglądu',
    );
    const hash = sourceHash(input),
      prior = (
        await c.query('SELECT * FROM odoo_invoice_exports WHERE document_id=$1 AND client_key=$2', [
          documentId,
          input.client_key,
        ])
      ).rows[0];
    if (prior) {
      ensure(
        prior.input_hash === hash && prior.source_hash === sourceHash(current.normalized),
        409,
        'Klucz podglądu użyto z innymi danymi',
      );
      return prior;
    }
    const reference = `DYNA-${actor.tenantId}-${documentId}`,
      payload = accountingPayload(reference, current.normalized, input, metadata),
      planId = randomUUID();
    const p = (
      await c.query(
        'INSERT INTO odoo_invoice_exports(id,tenant_id,document_id,order_id,channel_id,actor_id,client_key,input_hash,source_hash,connection_hash,credentials_hash,reference,input,snapshot,payload,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
        [
          planId,
          actor.tenantId,
          documentId,
          current.o.id,
          ch.id,
          actor.userId,
          input.client_key,
          hash,
          sourceHash(current.normalized),
          connectionHash(ch),
          credentialsHash(ch),
          reference,
          JSON.stringify(input),
          JSON.stringify({ source: current.normalized, metadata }),
          JSON.stringify(payload),
          ch.settings.simulation ? 'simulation' : 'external',
        ],
      )
    ).rows[0];
    await audit(c, actor, 'odoo.invoice.preview', p.id, { document_id: documentId });
    return p;
  });
}
async function locked(c: PoolClient, id: string) {
  const initial = (await c.query('SELECT order_id FROM odoo_invoice_exports WHERE id=$1', [id]))
    .rows[0];
  ensure(initial, 404, 'Nie znaleziono eksportu');
  await lockedOrder(c, initial.order_id);
  await assertSaleFinancialOrderInTx(c, initial.order_id);
  return (await c.query('SELECT * FROM odoo_invoice_exports WHERE id=$1 FOR UPDATE', [id])).rows[0];
}
async function enqueue(c: PoolClient, actor: Actor, p: any) {
  const jobId = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'odoo.invoice',$3,$4)",
    [
      jobId,
      actor.tenantId,
      JSON.stringify({ plan_id: p.id, actor_id: actor.userId }),
      `odoo.invoice:${jobId}`,
    ],
  );
  await c.query(
    "UPDATE odoo_invoice_exports SET state='queued',job_id=$2,error=NULL,updated_at=now() WHERE id=$1",
    [p.id, jobId],
  );
  return { id: p.id, job_id: jobId };
}
export async function queueOdooExport(
  c: PoolClient,
  actor: Actor,
  id: string,
  confirmData: boolean,
  confirmPost: boolean,
) {
  const p = await locked(c, id);
  ensure(p.actor_id === actor.userId, 403, 'Eksport zatwierdza autor podglądu');
  if (['queued', 'done'].includes(p.state)) return { id: p.id, job_id: p.job_id };
  ensure(
    p.state === 'preview' && Date.now() - new Date(p.created_at).getTime() < 1800000,
    409,
    'Przygotuj nowy podgląd',
  );
  const current = await source(c, p.document_id, p.input);
  ensure(sourceHash(current.normalized) === p.source_hash, 409, 'Dokument zmienił się od podglądu');
  connection((await c.query('SELECT * FROM channels WHERE id=$1', [p.channel_id])).rows[0], p);
  ensure(
    confirmData && (p.mode === 'simulation' || confirmPost),
    422,
    'Potwierdź dane i rzeczywiste zaksięgowanie w Odoo',
  );
  ensure(
    !(
      await c.query(
        "SELECT id FROM odoo_invoice_exports WHERE document_id=$1 AND mode=$2 AND state NOT IN ('preview','cancelled')",
        [p.document_id, p.mode],
      )
    ).rowCount,
    409,
    'Dokument ma już eksport lub niepewny zapis ERP',
  );
  await audit(c, actor, 'odoo.invoice.queue', p.id, {
    confirm_data: confirmData,
    confirm_post: confirmPost,
  });
  return enqueue(c, actor, p);
}
export async function controlOdooExport(
  c: PoolClient,
  actor: Actor,
  id: string,
  action: 'cancel' | 'reconcile',
) {
  const p = await locked(c, id);
  ensure(p.actor_id === actor.userId, 403, 'Eksport obsługuje autor');
  if (action === 'cancel') {
    if (p.state === 'cancelled') return { id };
    ensure(
      ['preview', 'failed'].includes(p.state) && p.phase === 'ready',
      409,
      'Nie można anulować rozpoczętego lub niepewnego eksportu; sprawdź ERP',
    );
    await c.query(
      "UPDATE odoo_invoice_exports SET state='cancelled',updated_at=now() WHERE id=$1",
      [id],
    );
    await audit(c, actor, 'odoo.invoice.cancel', id);
    return { id };
  }
  ensure(p.state === 'failed', 409, 'Uzgodnienie dostępne po błędzie');
  connection((await c.query('SELECT * FROM channels WHERE id=$1', [p.channel_id])).rows[0], p);
  await audit(c, actor, 'odoo.invoice.reconcile', id, { phase: p.phase });
  return enqueue(c, actor, p);
}
async function guard(job: any, fn: (c: PoolClient, p: any) => Promise<void>, renew = false) {
  return tenantTx(job.tenant_id, async (c) => {
    const p = await locked(c, job.payload.plan_id);
    if (p.state !== 'queued' || p.job_id !== job.id) return false;
    const j = await c.query(
      renew
        ? "UPDATE jobs SET locked_at=now() WHERE id=$1 AND state='running' AND lease_token=$2 RETURNING id"
        : "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
      [job.id, job.lease_token],
    );
    if (!j.rowCount) return false;
    await fn(c, p);
    return true;
  });
}
export async function processOdooExport(job: any, ctx: IntegrationContext = {}) {
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'odoo-exports');
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
    const initial = await tenantTx(
      job.tenant_id,
      async (c) =>
        (await c.query('SELECT * FROM odoo_invoice_exports WHERE id=$1', [job.payload.plan_id]))
          .rows[0],
    );
    ensure(initial, 404, 'Nie znaleziono eksportu');
    await lock.query("SET statement_timeout='20s'");
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
      'invoice:' + job.tenant_id + ':' + initial.order_id,
    ]);
    let p: any;
    if (
      !(await guard(job, async (_, current) => {
        p = current;
      }))
    )
      return;
    const ch = await loadChannel(job.tenant_id, p.channel_id),
      actor: Actor = { tenantId: job.tenant_id, userId: p.actor_id, role: 'operator' };
    const policy = async (c: PoolClient, current: any) => {
      ensure(
        current.actor_id === job.payload.actor_id &&
          ['admin', 'operator'].includes(
            (
              await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
                job.tenant_id,
                current.actor_id,
              ])
            ).rows[0]?.role,
          ),
        403,
        'Autor utracił prawo eksportu faktur',
      );
      connection(
        (await c.query('SELECT * FROM channels WHERE id=$1', [current.channel_id])).rows[0],
        current,
      );
      const data = await source(c, current.document_id, current.input);
      ensure(
        data.o.id === current.order_id && sourceHash(data.normalized) === current.source_hash,
        409,
        'Źródłowa faktura zmieniła się po zatwierdzeniu',
      );
    };
    const fence = async () =>
      ensure(await guard(job, policy, true), 409, 'Eksport zatrzymano lub dzierżawa wygasła');
    const phase = async (value: string, remote?: number) =>
      ensure(
        await guard(job, async (c, current) => {
          await policy(c, current);
          await c.query(
            'UPDATE odoo_invoice_exports SET phase=$2,remote_id=coalesce($3,remote_id),updated_at=now() WHERE id=$1',
            [p.id, value, remote ? String(remote) : null],
          );
          p.phase = value;
          if (remote) p.remote_id = String(remote);
        }),
        409,
        'Nieaktualna dzierżawa eksportu',
      );
    await fence();
    let move: any;
    if (ch.settings.simulation) {
      if (p.phase === 'ready') await phase('create_started');
      move = simulatedInvoice(p, 'draft');
      await phase('draft_saved', move.id);
      verifyOdooInvoice(p, move);
      await phase('post_started');
      move = simulatedInvoice(p);
      await phase('posted', move.id);
    } else {
      const client = new OdooAccounting(
        ch.settings,
        decrypt(ch.credentials),
        ctx.transport ?? safeFetch,
      );
      const metadata = await client.metadata(p.snapshot.source, p.input, fence);
      ensure(
        isDeepStrictEqual(metadata, p.snapshot.metadata),
        409,
        'Dane księgowe ERP zmieniły się od podglądu',
      );
      if (p.remote_id) move = await client.invoice(odooId(p.remote_id), fence);
      else {
        const found = await client.find(p.reference, fence);
        if (found) {
          move = await client.invoice(odooId(found.id), fence);
          await phase(
            move.state === 'posted'
              ? 'posted'
              : p.phase === 'post_started'
                ? 'post_started'
                : 'draft_saved',
            move.id,
          );
        } else {
          ensure(
            p.phase === 'ready',
            409,
            'Niepewny zapis nie jest widoczny w Odoo; drugi create zablokowany',
          );
          await phase('create_started');
          const remote = await client.create(p.payload, fence);
          await phase('draft_saved', remote);
          move = await client.invoice(remote, fence);
        }
      }
      verifyOdooInvoice(p, move);
      if (move.state === 'draft') {
        ensure(
          p.phase === 'draft_saved',
          409,
          'Niepewne zatwierdzenie wymaga sprawdzenia w Odoo; drugi action_post zablokowany',
        );
        ensure(
          isDeepStrictEqual(
            await client.metadata(p.snapshot.source, p.input, fence),
            p.snapshot.metadata,
          ),
          409,
          'Dane księgowe ERP zmieniły się przed księgowaniem',
        );
        await phase('post_started', move.id);
        await client.post(move.id, fence);
        await phase('posted', move.id);
        move = await client.invoice(move.id, fence);
      }
    }
    const result = {
      ...verifyOdooInvoice(p, move, true),
      scope: ch.settings.simulation ? 'local_simulation' : 'external_api_verified',
    };
    await guard(job, async (c, current) => {
      await policy(c, current);
      await c.query(
        "UPDATE odoo_invoice_exports SET state='done',phase='verified',remote_id=$2,result=$3,error=NULL,updated_at=now() WHERE id=$1",
        [p.id, result.id, JSON.stringify(result)],
      );
      await c.query(
        "UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL WHERE id=$1",
        [job.id],
      );
      await audit(c, actor, 'odoo.invoice.saved', p.id, { document_id: p.document_id, ...result });
    });
    });
  } finally {
    await lock.end();
  }
}
export async function failOdooExport(job: any, error: unknown) {
  return guard(job, async (c, p) => {
    const terminal =
      (error instanceof Problem && [401, 403, 404, 409, 422].includes(error.status)) ||
      job.attempts >= job.max_attempts;
    const message = error instanceof Problem ? error.message : 'Błąd eksportu Odoo; uzgodnij wynik';
    await c.query(
      'UPDATE odoo_invoice_exports SET state=$2,error=$3,updated_at=now() WHERE id=$1',
      [p.id, terminal ? 'failed' : 'queued', message],
    );
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', message],
    );
  });
}
