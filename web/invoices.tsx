import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FileText, Printer, RefreshCw } from 'lucide-react';
import { api, money, date } from './api';
import { readTogether } from './read-polling';
import { useVisibleReadPolling } from './use-visible-read-polling';
const states: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'Zapis w kolejce',
  done: 'Zapisana w Fakturowni',
  failed: 'Wymaga uzgodnienia',
  cancelled: 'Podgląd anulowany',
};
const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date());
export function InvoicePanel({
  order,
  write,
  admin,
  onChanged,
}: {
  order: any;
  write: boolean;
  admin: boolean;
  onChanged: () => void;
}) {
  const [data, setData] = useState<any>({ data: [], meta: {} }),
    [channels, setChannels] = useState<any[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [form, setForm] = useState<'invoice' | 'correction' | null>(null),
    [checked, setChecked] = useState<Record<string, boolean>>({}),
    [external, setExternal] = useState<Record<string, boolean>>({});
  const observed = useRef<string | undefined>(undefined);
  async function readData(current: () => boolean) {
    const [d, ch] = await readTogether([
      api('/orders/' + order.id + '/invoicing'),
      api('/invoicing/channels'),
    ]);
    if (!current()) return;
    const version = JSON.stringify(d.data.map((p: any) => [p.id, p.state, p.updated_at]));
    if (observed.current !== undefined && observed.current !== version) onChanged();
    observed.current = version;
    setData(d);
    setChannels(ch.data);
  }
  const load = useVisibleReadPolling(order.id, readData, e => setError((e as Error).message));
  useEffect(() => {
    observed.current = undefined;
  }, [order.id]);
  async function run(path: string, body: any = {}) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api(path, 'POST', body);
      if (path.endsWith('/email-file'))
        setNotice(
          'PDF gotowy do załączenia: ' +
            result.filename +
            ' · ' +
            (result.size / 1024).toFixed(1) +
            ' KiB',
        );
      await load();
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const originals = order.documents.filter((d: any) => d.channel_id && d.kind === 'invoice');
  const original = originals.find(
    (d: any) =>
      !data.data.some(
        (p: any) =>
          p.kind === 'correction' &&
          !p.return_id &&
          p.mode === d.mode &&
          !['preview', 'cancelled'].includes(p.state),
      ),
  );
  const invoiceChannels = channels.filter(
    (ch: any) =>
      !data.data.some(
        (p: any) =>
          p.kind === 'invoice' &&
          p.mode === (ch.settings.simulation ? 'simulation' : 'external') &&
          !['preview', 'cancelled'].includes(p.state),
      ),
  );
  const correctionCases = (order.returns?.invoice_cases ?? order.returns?.cases ?? [])
    .filter(
      (r: any) =>
        (r.accepted_at || r.received_at) &&
        !r.legacy &&
        r.refund_amount > 0 &&
        !data.data.some(
          (p: any) => p.return_id === r.id && !['preview', 'cancelled'].includes(p.state),
        ),
    )
    .sort((a: any, b: any) => a.receipt_sequence - b.receipt_sequence);
  const correction =
    original &&
    (correctionCases.length > 0 ||
      (['return_received', 'return_completed'].includes(order.status) &&
        !order.returns?.has_partial));
  const eligible =
    write &&
    !['new', 'cancelled'].includes(order.status) &&
    order.currency === 'PLN' &&
    order.address.country === 'PL';
  return (
    <section className="panel invoicing-panel">
      <div className="panel-heading">
        <div>
          <h2>
            <FileText size={20} /> Faktury — Fakturownia
          </h2>
          <p>Podgląd danych, zapis i korekty przyjętych zwrotów</p>
        </div>
        {eligible && (
          <div className="toolbar-actions">
            {admin && !channels.some((c) => c.settings.simulation) && (
              <button className="button" disabled={busy} onClick={() => run('/invoicing/example')}>
                Dodaj przykład DEMO
              </button>
            )}
            {invoiceChannels.length > 0 && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => setForm(form === 'invoice' ? null : 'invoice')}
              >
                Przygotuj fakturę
              </button>
            )}
            {correction && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => setForm(form === 'correction' ? null : 'correction')}
              >
                Przygotuj korektę
              </button>
            )}
          </div>
        )}
      </div>
      <div className="info-body">
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <div className="error-block" role="alert">
            {error}
          </div>
        )}
        {!channels.length && (
          <p className="muted">
            Połącz konto Fakturowni w Integracjach lub dodaj lokalny przykład.
          </p>
        )}
        {form && eligible && (
          <InvoiceForm
            order={order}
            key={form}
            channels={form === 'invoice' ? invoiceChannels : channels}
            original={form === 'correction' ? original : undefined}
            correctionCases={correctionCases}
            busy={busy}
            onCancel={() => setForm(null)}
            onSubmit={async (b: any) => {
              setBusy(true);
              setError('');
              try {
                await api('/orders/' + order.id + '/invoicing/preview', 'POST', b);
                setForm(null);
                await load();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
        {!data.data.length && !form && (
          <p className="muted">
            Brak planów faktur. Kwoty pochodzą z zamówienia; przed zapisem zatwierdzisz VAT, strony
            i daty.
          </p>
        )}
        {data.data.map((p: any) => (
          <article className="invoice-plan" key={p.id}>
            <div className="invoice-plan-heading">
              <div>
                <strong>
                  {p.kind === 'invoice'
                    ? 'Faktura sprzedaży'
                    : p.return_id
                      ? 'Korekta ' + p.order_snapshot.return_snapshot.number
                      : 'Korekta pełnego zwrotu'}{' '}
                  · {p.result?.number ?? states[p.state]}
                </strong>
                <small>
                  {p.channel_name} · {date(p.created_at)} ·{' '}
                  {p.simulation === 'true'
                    ? 'DEMO — bez API i skutków księgowych'
                    : 'konto dostawcy'}
                </small>
              </div>
              <span
                className={
                  'badge ' +
                  (p.state === 'failed' ? 'cancelled' : p.state === 'done' ? 'completed' : 'new')
                }
              >
                {p.simulation === 'true' && p.state === 'done'
                  ? 'Zapisana lokalnie DEMO'
                  : states[p.state]}
              </span>
            </div>
            <p>
              <strong>
                {money(
                  (p.kind === 'correction' ? -1 : 1) *
                    (p.order_snapshot.return_snapshot?.refund_amount ?? p.order_snapshot.total),
                )}
              </strong>{' '}
              · {p.input.seller.name} → {p.input.buyer.name}
            </p>
            {p.error && (
              <p className="invoice-error" role="alert">
                {p.error}
              </p>
            )}
            <details>
              <summary>Pozycje, VAT i zatwierdzone dane</summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Pozycja</th>
                      <th>Ilość</th>
                      <th>VAT</th>
                      <th className="right">Brutto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.payload.positions.map((i: any, n: number) => (
                      <tr key={n}>
                        <td>{i.name}</td>
                        <td>{i.quantity}</td>
                        <td>{i.tax}%</td>
                        <td className="right">
                          {money(Math.round(Number(i.total_price_gross) * 100))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p>
                Sprzedawca: {p.input.seller.name}, NIP {p.input.seller.tax_no},{' '}
                {p.input.seller.street}, {p.input.seller.postal_code} {p.input.seller.city}
                <br />
                Nabywca: {p.input.buyer.name},{' '}
                {p.input.buyer.tax_no ? 'NIP ' + p.input.buyer.tax_no : 'osoba prywatna'},{' '}
                {p.input.buyer.street}, {p.input.buyer.postal_code} {p.input.buyer.city},{' '}
                {p.input.buyer.email}
                <br />
                Wystawienie {p.input.issue_date} · Sprzedaż {p.input.sell_date} · Płatność do{' '}
                {p.input.payment_to}
              </p>
            </details>
            {p.result && (
              <p className="muted">
                Status dokumentu: {p.result.status || 'brak'} · KSeF:{' '}
                {p.result.gov_status ?? 'brak potwierdzenia'}
                {p.result.gov_id && ' · ' + p.result.gov_id}
              </p>
            )}
            {write && p.state === 'preview' && (
              <div className="invoice-confirm">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(checked[p.id])}
                    onChange={(e) => setChecked({ ...checked, [p.id]: e.target.checked })}
                  />{' '}
                  Sprawdziłem dane stron, VAT wszystkich pozycji i dostawy oraz daty.
                </label>
                {p.simulation !== 'true' && (
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(external[p.id])}
                      onChange={(e) => setExternal({ ...external, [p.id]: e.target.checked })}
                    />{' '}
                    Zatwierdzam wystawienie na tym koncie Fakturowni. Sprawdziłem automatyczną
                    wysyłkę KSeF i wiadomości w ustawieniach konta. Tryb sandbox aplikacji nie
                    izoluje konta dostawcy.
                  </label>
                )}
                <div className="toolbar-actions">
                  <button
                    className="button primary"
                    disabled={
                      busy || !checked[p.id] || (p.simulation !== 'true' && !external[p.id])
                    }
                    onClick={() =>
                      run('/invoice-plans/' + p.id + '/queue', {
                        confirm_data: checked[p.id],
                        confirm_external: external[p.id] ?? false,
                      })
                    }
                  >
                    {p.simulation === 'true' ? 'Zapisz przykład DEMO' : 'Wystaw w Fakturowni'}
                  </button>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => run('/invoice-plans/' + p.id + '/cancel')}
                  >
                    Anuluj podgląd
                  </button>
                </div>
              </div>
            )}
            {write && p.state === 'failed' && (
              <div className="toolbar-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => run('/invoice-plans/' + p.id + '/reconcile')}
                >
                  <RefreshCw size={16} /> Uzgodnij wynik
                </button>
                {p.phase === 'ready' && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => run('/invoice-plans/' + p.id + '/cancel')}
                  >
                    Anuluj plan bez zapisu
                  </button>
                )}
              </div>
            )}
            {p.document_id && (
              <div className="toolbar-actions">
                <a
                  className="button"
                  href={'/api/documents/' + p.document_id + '/print'}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Printer size={16} />{' '}
                  {p.simulation === 'true' ? 'Wydruk DEMO' : 'PDF z Fakturowni'}
                </a>
                {write && p.simulation !== 'true' && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      run('/documents/' + p.document_id + '/email-file', { confirmed: true })
                    }
                  >
                    Przygotuj PDF do emaila
                  </button>
                )}
                {write && p.simulation !== 'true' && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => run('/documents/' + p.document_id + '/provider-status')}
                  >
                    <RefreshCw size={16} /> Odczytaj status / KSeF
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
              try {
                const d = await api('/orders/' + order.id + '/invoicing?after=' + data.meta.cursor);
                setData({ data: [...data.data, ...d.data], meta: d.meta });
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            Starsze plany
          </button>
        )}
      </div>
    </section>
  );
}
function InvoiceForm({
  order,
  channels,
  original,
  correctionCases,
  busy,
  onCancel,
  onSubmit,
}: any) {
  const prev = original?.data.input;
  const [channel, setChannel] = useState(original?.channel_id ?? channels[0]?.id),
    [seller, setSeller] = useState(
      prev?.seller ?? { name: '', tax_no: '', street: '', city: '', postal_code: '' },
    ),
    [buyer, setBuyer] = useState(
      prev?.buyer ?? {
        name: order.customer_name,
        tax_no: '',
        street: order.address.street,
        city: order.address.city,
        postal_code: order.address.postal_code,
        email: order.email,
      },
    ),
    [taxes, setTaxes] = useState<Record<string, number>>(
      Object.fromEntries(
        order.items.map((i: any) => [
          i.id,
          prev?.item_vat.find((v: any) => v.item_id === i.id)?.vat ?? i.vat,
        ]),
      ),
    ),
    [shippingVat, setShippingVat] = useState(prev?.shipping_vat ?? 23),
    [returnId, setReturnId] = useState(original ? (correctionCases[0]?.id ?? '') : '');
  const simulation = channels.find((c: any) => c.id === channel)?.settings.simulation;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await onSubmit({
      channel_id: channel,
      kind: original ? 'correction' : 'invoice',
      ...(returnId ? { return_id: returnId } : {}),
      seller,
      buyer,
      issue_date: f.get('issue_date'),
      sell_date: f.get('sell_date'),
      payment_to: f.get('payment_to'),
      payment_type: f.get('payment_type'),
      item_vat: order.items.map((i: any) => ({ item_id: i.id, vat: taxes[i.id] })),
      shipping_vat: shippingVat,
      correction_reason: f.get('reason') ?? '',
    });
  }
  const taxSelect = (value: number, change: (v: number) => void, label: string) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => change(Number(e.target.value))}
      disabled={Boolean(original)}
    >
      {[0, 5, 8, 23].map((v) => (
        <option key={v} value={v}>
          {v}%
        </option>
      ))}
    </select>
  );
  return (
    <form className="invoice-form" onSubmit={submit}>
      <label>
        Konto Fakturowni
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          disabled={Boolean(original)}
        >
          {channels.map((c: any) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.settings.simulation ? ' · DEMO' : ' · API konta'}
            </option>
          ))}
        </select>
      </label>
      {original && correctionCases.length > 0 && (
        <label>
          Sprawa do korekty
          <select
            aria-label="Sprawa do korekty"
            value={returnId}
            onChange={(e) => setReturnId(e.target.value)}
          >
            {correctionCases.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.number} · {money(r.refund_amount, order.currency)}
              </option>
            ))}
          </select>
          <small>
            Korekty zapisuje się w kolejności przyjęć. VAT wszystkich pozycji pozostaje zgodny z
            dokumentem pierwotnym.
          </small>
        </label>
      )}
      {simulation && !original && (
        <button
          type="button"
          className="button"
          onClick={() =>
            setSeller({
              name: 'Sprzedawca QA DEMO',
              tax_no: '5252445767',
              street: 'Testowa 1',
              city: 'Warszawa',
              postal_code: '00-001',
            })
          }
        >
          Wypełnij sprzedawcę DEMO
        </button>
      )}
      <div className="invoice-parties">
        {(['seller', 'buyer'] as const).map((who) => {
          const p = who === 'seller' ? seller : buyer,
            setter = who === 'seller' ? setSeller : setBuyer;
          return (
            <fieldset key={who}>
              <legend>{who === 'seller' ? 'Sprzedawca' : 'Nabywca — dane do faktury'}</legend>
              {[
                { key: 'name', label: 'Nazwa' },
                {
                  key: 'tax_no',
                  label: who === 'seller' ? 'NIP (10 cyfr)' : 'NIP (puste dla osoby prywatnej)',
                },
                { key: 'street', label: 'Ulica i numer' },
                { key: 'postal_code', label: 'Kod pocztowy' },
                { key: 'city', label: 'Miasto' },
                ...(who === 'buyer' ? [{ key: 'email', label: 'E-mail' }] : []),
              ].map((f) => (
                <label key={f.key}>
                  {f.label}
                  <input
                    aria-label={(who === 'seller' ? 'Sprzedawca: ' : 'Nabywca: ') + f.label}
                    value={p[f.key] ?? ''}
                    onChange={(e) => setter({ ...p, [f.key]: e.target.value })}
                    readOnly={Boolean(original)}
                    required={f.key !== 'tax_no' || who === 'seller'}
                    type={f.key === 'email' ? 'email' : 'text'}
                    maxLength={200}
                    pattern={
                      f.key === 'tax_no'
                        ? '[0-9]{10}'
                        : f.key === 'postal_code'
                          ? '[0-9]{2}-[0-9]{3}'
                          : undefined
                    }
                  />
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
      <div className="invoice-dates">
        <label>
          Data wystawienia
          <input name="issue_date" type="date" defaultValue={today()} required />
        </label>
        <label>
          Data sprzedaży
          <input
            name="sell_date"
            type="date"
            defaultValue={
              original
                ? today()
                : new Date(order.created_at).toLocaleDateString('sv-SE', {
                    timeZone: 'Europe/Warsaw',
                  })
            }
            required
          />
        </label>
        <label>
          Termin płatności
          <input name="payment_to" type="date" defaultValue={today()} required />
        </label>
        <label>
          Forma płatności
          <select name="payment_type" defaultValue={prev?.payment_type ?? 'transfer'}>
            {[
              ['transfer', 'Przelew'],
              ['card', 'Karta'],
              ['cash', 'Gotówka'],
              ['payu', 'PayU'],
              ['paypal', 'PayPal'],
              ['other', 'Inna'],
            ].map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted">
        Kwoty brutto uwzględniają rabaty zamówienia. Stawki VAT podpowiada katalog — sprawdź je dla
        tej sprzedaży. Dostawa ma osobną stawkę.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Pozycja</th>
              <th>Ilość</th>
              <th>{original ? 'Brutto dokumentu pierwotnego' : 'Brutto'}</th>
              <th>VAT</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((i: any) => (
              <tr key={i.id}>
                <td>
                  {i.name}
                  <small>{i.sku}</small>
                </td>
                <td>{i.quantity}</td>
                <td>{money(i.line_total)}</td>
                <td>
                  {taxSelect(taxes[i.id], (v) => setTaxes({ ...taxes, [i.id]: v }), 'VAT ' + i.sku)}
                </td>
              </tr>
            ))}
            {order.shipping_cost > 0 && (
              <tr>
                <td>Dostawa</td>
                <td>1</td>
                <td>{money(order.shipping_cost)}</td>
                <td>{taxSelect(shippingVat, setShippingVat, 'VAT dostawy')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {original && (
        <label>
          Przyczyna korekty
          <input
            name="reason"
            defaultValue={
              returnId ? 'Zwrot pozycji przyjętych w sprawie' : 'Pełny zwrot zamówienia'
            }
            maxLength={256}
            required
          />
        </label>
      )}
      <div className="toolbar-actions">
        <button className="button primary" disabled={busy}>
          Zapisz podgląd {original ? 'korekty' : 'faktury'}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Zamknij
        </button>
      </div>
    </form>
  );
}
