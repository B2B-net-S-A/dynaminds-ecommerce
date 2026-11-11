import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Wallet, RefreshCw } from 'lucide-react';
import { api, money, date } from './api';
const labels: Record<string, string> = {
  receipt: 'Wpłata',
  courier_collection: 'Pobranie przez kuriera',
  courier_remittance: 'Przekazanie środków',
  refund: 'Zwrot środków',
  reversal: 'Korekta wpisu',
};
const methods: Record<string, string> = {
  historical_status: 'Historyczna deklaracja statusu',
  historical_confirmation: 'Historyczne potwierdzenie',
  source_import: 'Deklaracja kanału sprzedaży',
  source_sync: 'Aktualizacja deklaracji kanału',
  status_confirmation: 'Deklaracja operatora',
  return_confirmation: 'Rozliczenie sprawy zwrotowej',
  bank_transfer: 'Przelew',
  cash: 'Gotówka',
  card: 'Karta',
  other: 'Inne',
  correction: 'Korekta',
  payu: 'PayU',
};
function minor(v: FormDataEntryValue | null) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s))
    throw Error('Kwota wymaga maksymalnie dwóch miejsc po przecinku');
  const [whole, f = ''] = s.split('.');
  const n = Number(whole) * 100 + Number(f.padEnd(2, '0'));
  if (!Number.isSafeInteger(n) || n > 2147483647) throw Error('Kwota przekracza limit');
  return n;
}
export function PaymentsPanel({
  order,
  write,
  admin,
  onChanged,
  readOnly = false,
}: {
  order: any;
  write: boolean;
  readOnly?: boolean;
  admin: boolean;
  onChanged: () => void;
}) {
  write = write && !readOnly;
  admin = admin && !readOnly;
  const scope = JSON.stringify([order.tenant_id, order.id, String(order.version), readOnly]);
  const reads = useRef({scope, ticket:0, controller:null as AbortController|null, page:false, alive:true});
  const writeFlight = useRef(false);
  reads.current.scope = scope;
  const [historyState, setHistoryState] = useState<any>({scope, value:{data:[],next:null}}),
    [error, setError] = useState(''),
    [writeBusy, setWriteBusy] = useState(false),
    [pageBusy, setPageBusy] = useState(false),
    [kind, setKind] = useState('receipt'),
    [form, setForm] = useState(false),
    [key, setKey] = useState(crypto.randomUUID()),
    [correction, setCorrection] = useState<any>(null);
  const history = historyState.scope === scope ? historyState.value : {data:[],next:null};
  const busy = writeBusy || pageBusy;
  function setHistory(value:any) {
    if (reads.current.alive && reads.current.scope === scope) setHistoryState({scope,value});
  }
  function invalidateReads() {
    reads.current.ticket++;
    reads.current.controller?.abort();
    reads.current.controller=null;
    reads.current.page=false;
    setPageBusy(false);
  }
  function beginRead() {
    reads.current.controller?.abort();
    const controller=new AbortController(),ticket=++reads.current.ticket;
    reads.current.controller=controller;
    const current=()=>reads.current.alive && reads.current.scope===scope &&
      reads.current.ticket===ticket && !controller.signal.aborted;
    return{controller,current};
  }
  useEffect(()=>{reads.current.alive=true;return()=>{reads.current.alive=false;reads.current.controller?.abort();};},[]);
  useEffect(() => {
    invalidateReads();
    setHistory({ data: [], next: null });
    setError('');
    const {controller,current}=beginRead();
    api('/orders/' + order.id + '/payments','GET',undefined,{},controller.signal)
      .then(value=>{if(current())setHistory(value);})
      .catch(e=>{if(current())setError(e.message);});
    return()=>controller.abort();
  }, [scope]);
  const b = order.payment;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (writeFlight.current || !write || (correction && !admin)) return;
    const f = new FormData(e.currentTarget);
    writeFlight.current=true;
    const current=()=>reads.current.alive && reads.current.scope===scope;
    setWriteBusy(true);
    setError('');
    try {
      const body = correction
        ? {
            client_key: key,
            version: Number(order.version),
            entry_id: correction.id,
            reason: f.get('note'),
            confirmed: f.get('confirmed') === 'on',
          }
        : {
            client_key: key,
            version: Number(order.version),
            kind,
            amount: minor(f.get('amount')),
            fee: kind === 'courier_remittance' ? minor(f.get('fee')) : 0,
            currency: order.currency,
            method: f.get('method'),
            reference: f.get('reference'),
            note: f.get('note'),
            ...(kind.startsWith('courier_') ? { shipment_id: f.get('shipment_id') } : {}),
            confirmed: f.get('confirmed') === 'on',
          };
      // A mutation supersedes older reads even before order.version refreshes.
      invalidateReads();
      const h = await api(
        '/orders/' + order.id + '/payments' + (correction ? '/reverse' : ''),
        'POST',
        body,
      );
      if(!current())return;
      // Also invalidate a read started in the same event turn. A different
      // order version keeps its own refresh; it must not be cancelled here.
      if(reads.current.scope===scope)invalidateReads();
      setHistory(h);
      setForm(false);
      setCorrection(null);
      setKey(crypto.randomUUID());
      onChanged();
    } catch (e: any) {
      if(current())setError(e.message);
    } finally {
      writeFlight.current=false;
      setWriteBusy(false);
    }
  }
  async function more() {
    if (busy || writeFlight.current || reads.current.page || !history.next) return;
    reads.current.page=true;
    const {controller,current}=beginRead();
    setPageBusy(true);
    try {
      const p = await api('/orders/' + order.id + '/payments?before=' + encodeURIComponent(history.next),'GET',undefined,{},controller.signal);
      if(current())setHistory({ ...p, data: [...history.data, ...p.data] });
    } catch (e: any) {
      if(current())setError(e.message);
    } finally {
      if(current()){reads.current.page=false;setPageBusy(false);}
    }
  }
  return (
    <section className="panel payments-panel">
      <div className="panel-heading">
        <h2>
          <Wallet size={18} /> Płatności i pobrania
        </h2>
        <span>
          {order.payment_mode === 'cod' ? 'Za pobraniem' : 'Przedpłata'} · {order.currency}
        </span>
      </div>
      <div className="shipping-body">
        <div className="payment-balances">
          <p>
            Wpłaty: <strong>{money(b.received, order.currency)}</strong>
          </p>
          <p>
            Do zapłaty: <strong>{money(b.amount_due, order.currency)}</strong>
          </p>
          <p>
            Do oddania: <strong>{money(b.overpayment, order.currency)}</strong>
          </p>
          <p>
            Zwrócono: <strong>{money(b.refunded, order.currency)}</strong>
          </p>
        </div>
        {order.payment_mode === 'cod' && (
          <p className="payment-courier">
            Pobrane przez kuriera: {money(b.collected, order.currency)} · przekazane:{' '}
            {money(b.remitted, order.currency)} · prowizje: {money(b.fees, order.currency)} ·
            oczekujące rozliczenie: <strong>{money(b.courier_due, order.currency)}</strong>
          </p>
        )}
        <p className="muted">
          Rejestr potwierdzeń. Zapis nie pobiera ani nie zwraca pieniędzy. Doręczenie przesyłki nie
          potwierdza płatności.
        </p>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {write && !form && (
          <button
            className="button"
            onClick={() => {
              setForm(true);
              setCorrection(null);
              setKey(crypto.randomUUID());
              setError('');
            }}
          >
            Dodaj potwierdzenie
          </button>
        )}
        {form && write && (
          <form className="payment-form" onSubmit={submit}>
            {correction ? (
              <p>
                Korekta wpisu: {labels[correction.kind]} ·{' '}
                {money(correction.amount, order.currency)}. Oryginał pozostanie w historii.
              </p>
            ) : (
              <>
                <label>
                  Rodzaj potwierdzenia
                  <select
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value);
                      setKey(crypto.randomUUID());
                    }}
                  >
                    <option value="receipt">Wpłata bezpośrednia / zaliczka</option>
                    {order.payment_mode === 'cod' && (
                      <>
                        <option value="courier_collection">
                          Kurier pobrał środki od kupującego
                        </option>
                        <option value="courier_remittance">
                          Kurier przekazał środki sprzedawcy
                        </option>
                      </>
                    )}
                    <option value="refund">Zwrot środków dostępnych do oddania</option>
                  </select>
                </label>
                {kind.startsWith('courier_') && (
                  <label>
                    Przesyłka
                    <select name="shipment_id" required>
                      {order.shipments
                        .filter((s: any) => s.dispatched_at)
                        .map((s: any) => (
                          <option key={s.id} value={s.id}>
                            {s.tracking_number} · zlecone pobranie{' '}
                            {money(s.cod_expected, order.currency)}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <label>
                  Kwota ({order.currency})
                  <input
                    name="amount"
                    inputMode="decimal"
                    required
                    defaultValue={(
                      (kind === 'refund'
                        ? b.overpayment
                        : kind === 'courier_remittance'
                          ? b.courier_due
                          : b.amount_due) / 100
                    ).toFixed(2)}
                    key={kind}
                  />
                </label>
                {kind === 'courier_remittance' && (
                  <label>
                    Prowizja potrącona przez kuriera ({order.currency})
                    <input name="fee" inputMode="decimal" defaultValue="0.00" required />
                  </label>
                )}
                <label>
                  Metoda
                  <select name="method">
                    <option value="bank_transfer">Przelew</option>
                    <option value="cash">Gotówka</option>
                    <option value="card">Karta</option>
                    <option value="other">Inne</option>
                  </select>
                </label>
                <label>
                  Referencja potwierdzenia
                  <input name="reference" minLength={3} maxLength={200} required />
                </label>
              </>
            )}
            <label>
              {correction ? 'Powód korekty' : 'Notatka'}
              <textarea
                name="note"
                maxLength={2000}
                minLength={correction ? 3 : 0}
                required={Boolean(correction)}
              />
            </label>
            <label className="checkbox-label">
              <input name="confirmed" type="checkbox" required />
              Potwierdzam zgodność wpisu z rzeczywistym rozliczeniem
              {order.shipments.some((s: any) => s.mode === 'demo') ? ' lub zdarzeniem DEMO' : ''}
            </label>
            <div className="payment-actions">
              <button className="button primary" disabled={busy}>
                Zapisz potwierdzenie
              </button>
              <button
                className="button"
                type="button"
                onClick={() => {
                  setForm(false);
                  setCorrection(null);
                }}
              >
                Anuluj
              </button>
            </div>
          </form>
        )}
        {history.data.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Zdarzenie</th>
                  <th>Kwota</th>
                  <th>Źródło / referencja</th>
                  <th>Data</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.data.map((p: any) => (
                  <tr key={p.id}>
                    <td>
                      {labels[p.kind]}
                      {p.reversed && <small>Skorygowano</small>}
                    </td>
                    <td>
                      {money(p.amount, order.currency)}
                      {p.fee !== 0 && <small>Prowizja: {money(p.fee, order.currency)}</small>}
                    </td>
                    <td>
                      {methods[p.method] ?? p.method}
                      <small>{p.reference}</small>
                      {p.note && <small>{p.note}</small>}
                    </td>
                    <td>{date(p.created_at)}</td>
                    <td>
                      {write && admin && p.kind !== 'reversal' && !p.reversed && !p.return_id && (
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => {
                            setCorrection(p);
                            setForm(true);
                            setKey(crypto.randomUUID());
                          }}
                        >
                          <RefreshCw size={14} />
                          Koryguj
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {history.next && (
          <button className="button" disabled={busy} onClick={more}>
            Starsze potwierdzenia
          </button>
        )}
      </div>
    </section>
  );
}
