import { useState, type FormEvent } from 'react';
import { FileText } from 'lucide-react';
import { api, money, date } from './api';
import { readTogether } from './read-polling';
import { useVisibleReadPolling } from './use-visible-read-polling';
const states: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'Eksport w kolejce',
  done: 'Zaksięgowana w Odoo',
  failed: 'Wymaga uzgodnienia',
  cancelled: 'Anulowany',
};
const day = (d: any) =>
  d.data.input?.issue_date ??
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date(d.created_at));
export function OdooInvoicePanel({
  order,
  write,
  admin,
}: {
  order: any;
  write: boolean;
  admin: boolean;
}) {
  const [data, setData] = useState<any>({ data: [], meta: {} }),
    [channels, setChannels] = useState<any[]>([]),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [checks, setChecks] = useState<Record<string, boolean>>({});
  async function readData(current: () => boolean) {
    const [d, ch] = await readTogether([
      api(`/orders/${order.id}/odoo-invoices`),
      api('/odoo-invoicing/channels'),
    ]);
    if (!current()) return;
    setData(d);
    setChannels(ch.data);
  }
  const load = useVisibleReadPolling(order.id, readData, e => setError((e as Error).message));
  async function run(path: string, body: any = {}) {
    setBusy(true);
    setError('');
    try {
      await api(path, 'POST', body);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const docs = order.documents.filter((d: any) => d.kind === 'invoice');
  const eligible = write && !['new', 'cancelled'].includes(order.status);
  return (
    <section className="panel invoicing-panel">
      <div className="panel-heading">
        <div>
          <h2>
            <FileText size={20} /> Faktury — Odoo ERP
          </h2>
          <p>Eksport istniejącej faktury, kontrola szkicu i księgowanie</p>
        </div>
        <div className="toolbar-actions">
          {admin && !channels.some((c) => c.settings.simulation) && (
            <button
              className="button"
              disabled={busy}
              onClick={() => run('/integrations/odoo-example')}
            >
              Dodaj przykład Odoo
            </button>
          )}
          {eligible && docs.length > 0 && channels.length > 0 && (
            <button className="button primary" onClick={() => setOpen(!open)} disabled={busy}>
              Przygotuj eksport Odoo
            </button>
          )}
        </div>
      </div>
      <div className="info-body">
        {error && (
          <p className="error-block" role="alert">
            {error}
          </p>
        )}
        {!channels.length && (
          <p className="muted">Dodaj integrację Odoo w Integracjach lub lokalny przykład.</p>
        )}
        {!docs.length && (
          <p className="muted">Wystaw fakturę w zamówieniu, aby przygotować eksport do ERP.</p>
        )}
        {open && eligible && (
          <ExportForm
            key={order.id}
            docs={docs}
            channels={channels}
            busy={busy}
            onCancel={() => setOpen(false)}
            onSubmit={async (doc: string, b: any) => {
              setBusy(true);
              setError('');
              try {
                await api(`/documents/${doc}/odoo-export/preview`, 'POST', b);
                setOpen(false);
                await load();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
        {data.data.map((p: any) => (
          <article className="invoice-plan" key={p.id}>
            <div className="invoice-plan-heading">
              <div>
                <strong>
                  {p.result?.number ?? states[p.state]} · {p.snapshot.source.number}
                </strong>
                <small>
                  {p.channel_name} · {date(p.created_at)} ·{' '}
                  {p.mode === 'simulation' ? 'DEMO — symulacja lokalna' : 'konto Odoo'}
                </small>
              </div>
              <span
                className={
                  'badge ' +
                  (p.state === 'done' ? 'completed' : p.state === 'failed' ? 'cancelled' : 'new')
                }
              >
                {p.state === 'done' && p.mode === 'simulation'
                  ? 'Zaksięgowana lokalnie DEMO'
                  : states[p.state]}
              </span>
            </div>
            <p>
              <strong>{money(p.snapshot.source.total, p.snapshot.source.currency)}</strong> ·{' '}
              {p.snapshot.metadata.company.name} → {p.snapshot.source.buyer.name}
            </p>
            <p>
              Dziennik: {p.snapshot.metadata.journal.name} (ID {p.input.journal_id}) · Konto:{' '}
              {p.snapshot.metadata.account.name} (ID {p.input.account_id}) · Kontrahent ID{' '}
              {p.input.partner_id}
            </p>
            <details>
              <summary>Pozycje i dane eksportu Odoo</summary>
              <table>
                <thead>
                  <tr>
                    <th>Pozycja</th>
                    <th>Ilość</th>
                    <th>VAT / ID Odoo</th>
                    <th>Brutto</th>
                  </tr>
                </thead>
                <tbody>
                  {p.snapshot.source.lines.map((l: any, i: number) => (
                    <tr key={i}>
                      <td>{l.name}</td>
                      <td>{l.quantity}</td>
                      <td>
                        {l.vat}% / {p.input.taxes.find((t: any) => t.vat === l.vat).tax_id}
                      </td>
                      <td>{money(l.gross, p.snapshot.source.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                {p.snapshot.source.buyer.street}, {p.snapshot.source.buyer.postal_code}{' '}
                {p.snapshot.source.buyer.city}, {p.snapshot.source.buyer.country} ·{' '}
                {p.snapshot.source.buyer.email}
              </p>
              <p>
                Wystawienie: {p.input.invoice_date} · Termin: {p.input.due_date}
              </p>
            </details>
            {p.error && (
              <p className="invoice-error" role="alert">
                {p.error}
              </p>
            )}
            {p.result && (
              <p className="muted">
                Status ERP: {p.result.state} · Płatność ERP: {p.result.payment_state}. Eksport nie
                zmienia rejestru płatności zamówienia.
              </p>
            )}
            {p.state === 'done' && (
              <div className="info-body">
                {p.pdf ? (
                  <>
                    <a
                      className="button"
                      href={`/api/odoo-invoice-exports/${p.id}/pdf`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Pobierz zapisany PDF Odoo{p.pdf.mode === 'simulation' ? ' DEMO' : ''}
                    </a>
                    <p className="muted">
                      Kopia z {date(p.pdf.created_at)} · {p.pdf.size} bajtów · SHA-256{' '}
                      {p.pdf.sha256}. To zapisany plik; późniejszych zmian ERP nie pobieramy
                      automatycznie.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="muted">
                      Pobierz istniejący PDF powiązanej faktury. Plik zostanie zapisany lokalnie.
                      Brak PDF w Odoo wymaga jego wygenerowania w ERP; ta operacja nie wysyła
                      wiadomości ani nie generuje dokumentu w ERP.
                    </p>
                    {write && (
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => run(`/odoo-invoice-exports/${p.id}/pdf`)}
                      >
                        {p.mode === 'simulation'
                          ? 'Zapisz przykład PDF Odoo'
                          : 'Pobierz i zapisz PDF z Odoo'}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {write && p.can_control && (
              <div className="toolbar-actions">
                {p.state === 'preview' && (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!checks[p.id + 'data']}
                        onChange={(e) =>
                          setChecks({ ...checks, [p.id + 'data']: e.target.checked })
                        }
                      />{' '}
                      Potwierdzam firmę, nabywcę, pozycje, VAT i kwoty
                    </label>
                    {p.mode === 'external' && (
                      <label>
                        <input
                          type="checkbox"
                          checked={!!checks[p.id + 'post']}
                          onChange={(e) =>
                            setChecks({ ...checks, [p.id + 'post']: e.target.checked })
                          }
                        />{' '}
                        Zatwierdzam utworzenie i zaksięgowanie rzeczywistej faktury w Odoo
                      </label>
                    )}
                    <button
                      className="button primary"
                      disabled={
                        busy ||
                        !checks[p.id + 'data'] ||
                        (p.mode === 'external' && !checks[p.id + 'post'])
                      }
                      onClick={() =>
                        run(`/odoo-invoice-exports/${p.id}/queue`, {
                          confirm_data: true,
                          confirm_post: !!checks[p.id + 'post'],
                        })
                      }
                    >
                      {p.mode === 'simulation'
                        ? 'Zaksięguj DEMO Odoo'
                        : 'Eksportuj i zaksięguj w Odoo'}
                    </button>
                  </>
                )}
                {['preview', 'failed'].includes(p.state) && p.phase === 'ready' && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => run(`/odoo-invoice-exports/${p.id}/cancel`)}
                  >
                    Anuluj podgląd Odoo
                  </button>
                )}
                {p.state === 'failed' && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => run(`/odoo-invoice-exports/${p.id}/reconcile`)}
                  >
                    Uzgodnij wynik Odoo
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
        {data.meta.cursor && (
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const next = await api(
                  `/orders/${order.id}/odoo-invoices?after=${data.meta.cursor}`,
                );
                setData({ data: [...data.data, ...next.data], meta: next.meta });
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Starsze eksporty Odoo
          </button>
        )}
        <p className="muted">
          Eksport faktury sprzedaży nie obejmuje korekt ani rejestracji płatności w ERP. Istniejący
          PDF pobierasz osobno. Dane księgowe Odoo są sprawdzane przed zapisem.
        </p>
      </div>
    </section>
  );
}
function ExportForm({ docs, channels, busy, onCancel, onSubmit }: any) {
  const [doc, setDoc] = useState(docs[0].id),
    [channel, setChannel] = useState(channels[0].id),
    [shipping, setShipping] = useState(23);
  const d = docs.find((d: any) => d.id === doc),
    rates = [
      ...new Set<number>([
        ...d.data.items.map((l: any) => l.vat),
        ...(d.data.shipping_cost ? [shipping] : []),
      ]),
    ].sort((a, b) => a - b);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await onSubmit(doc, {
      client_key: crypto.randomUUID(),
      channel_id: channel,
      partner_id: Number(f.get('partner')),
      journal_id: Number(f.get('journal')),
      account_id: Number(f.get('account')),
      invoice_date: day(d),
      due_date: String(f.get('due')),
      shipping_vat: shipping,
      taxes: rates.map((v) => ({ vat: v, tax_id: Number(f.get('tax-' + v)) })),
    });
  }
  return (
    <form className="form-grid" onSubmit={submit} key={doc}>
      <label>
        Faktura źródłowa
        <select value={doc} onChange={(e) => setDoc(e.target.value)}>
          {docs.map((d: any) => (
            <option key={d.id} value={d.id}>
              {d.number} · {money(d.data.total, d.data.currency)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Połączenie Odoo
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          {channels.map((c: any) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.settings.simulation ? ' · DEMO' : ''}
            </option>
          ))}
        </select>
      </label>
      {[
        ['partner', 'ID kontrahenta Odoo'],
        ['journal', 'ID dziennika sprzedaży Odoo'],
        ['account', 'ID konta przychodów Odoo'],
      ].map(([name, label]) => (
        <label key={name}>
          {label}
          <input
            name={name}
            type="number"
            min="1"
            max="2147483647"
            required
            defaultValue={
              channels.find((c: any) => c.id === channel)?.settings.simulation ? 1 : undefined
            }
          />
        </label>
      ))}
      <label>
        Data wystawienia
        <input value={day(d)} type="date" readOnly />
      </label>
      <label>
        Termin płatności
        <input
          name="due"
          type="date"
          min={day(d)}
          defaultValue={d.data.input?.payment_to ?? day(d)}
          readOnly={!!d.data.input?.payment_to}
          required
        />
      </label>
      {!!d.data.shipping_cost && (
        <label>
          VAT dostawy
          <select value={shipping} onChange={(e) => setShipping(Number(e.target.value))}>
            {[0, 5, 8, 23].map((v) => (
              <option key={v} value={v}>
                {v}%
              </option>
            ))}
          </select>
        </label>
      )}
      {rates.map((v) => (
        <label key={v}>
          ID podatku Odoo dla VAT {v}%
          <input
            name={'tax-' + v}
            type="number"
            min="1"
            max="2147483647"
            required
            defaultValue={
              channels.find((c: any) => c.id === channel)?.settings.simulation ? v + 1 : undefined
            }
          />
        </label>
      ))}
      <div className="toolbar-actions">
        <button className="button primary" disabled={busy} type="submit">
          Sprawdź dane eksportu Odoo
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Zamknij
        </button>
      </div>
    </form>
  );
}
