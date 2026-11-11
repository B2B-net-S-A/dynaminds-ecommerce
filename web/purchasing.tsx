import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { Plus, X, ArrowLeft, Truck, PackageCheck } from 'lucide-react';
import { api, ApiError, money, date } from './api';
import { ProductPicker } from './catalog';
import { SupplierCatalog } from './supplier-catalog';
import { SupplierFileSources, subscribeSupplierFileSourcesLock } from './supplier-file-sources';
import { subscribeSupplierRemoteFeedsLock } from './supplier-remote-feeds';
import { ReplenishmentPlans } from './replenishment-plans';
const states: Record<string, string> = {
  draft: 'Szkic',
  ordered: 'Oczekuje na dostawę',
  partial: 'Częściowo przyjęte',
  received: 'Przyjęte w całości',
  closed: 'Zamknięte',
  cancelled: 'Anulowane',
};
function Dialog({
  title,
  close,
  busy,
  children,
}: {
  title: string;
  close: () => void;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <div className="modal-shade">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal catalog-modal purchase-modal"
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Zamknij" disabled={busy} onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <div className="notice import-error" role="alert">
      {error}
    </div>
  ) : null;
}
export function Purchasing({
  admin,
  refresh,
  reload,
  notify,
  contextKey,
  readOnly,
  productWriteBlocked = false,
}: {
  admin: boolean;
  refresh: number;
  reload: () => void;
  notify: (s: string) => void;
  contextKey: string;
  readOnly: boolean;
  productWriteBlocked?: boolean;
}) {
  const [tab, setTab] = useState('orders'),
    [search, setSearch] = useState(''),
    [state, setState] = useState(''),
    [rows, setRows] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<any>(null),
    [modal, setModal] = useState(''),
    [supplier, setSupplier] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [reason, setReason] = useState('');
  const detailEpoch = useRef(0);
  const [supplierFileLocked, setSupplierFileLocked] = useState(false);
  const [supplierFileRetainedLocked, setSupplierFileRetainedLocked] = useState(false);
  const [supplierRemoteLocked, setSupplierRemoteLocked] = useState(false);
  useEffect(
    () => subscribeSupplierRemoteFeedsLock(contextKey, setSupplierRemoteLocked),
    [contextKey],
  );
  useEffect(
    () => subscribeSupplierFileSourcesLock(contextKey, setSupplierFileRetainedLocked),
    [contextKey],
  );
  useEffect(
    () => () => {
      detailEpoch.current++;
    },
    [contextKey, readOnly],
  );
  function changeTab(next: string) {
    detailEpoch.current++;
    setTab(next);
    setRows([]);
    setCursor(null);
    setSearch('');
    setSelected(null);
    setError('');
  }
  const path =
    (tab === 'orders' ? '/purchase-orders' : '/suppliers') +
    '?' +
    new URLSearchParams({ limit: '25', search, ...(tab === 'orders' && state ? { state } : {}) });
  useEffect(() => {
    if (tab === 'replenishment') {
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    api(path)
      .then((r) => {
        if (live) {
          setRows(r.data);
          setCursor(r.meta.cursor);
          setError('');
        }
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, refresh, tab]);
  async function open(id: string) {
    const epoch = ++detailEpoch.current;
    try {
      const detail = await api('/purchase-orders/' + id);
      if (epoch !== detailEpoch.current) return;
      setSelected(detail);
      setError('');
    } catch (e: any) {
      if (epoch === detailEpoch.current) setError(e.message);
    }
  }
  function saved(d: any) {
    setModal('');
    setSelected(d);
    reload();
    notify('Zamówienie zakupowe zapisane.');
  }
  async function action(action: string) {
    setBusy(true);
    setError('');
    try {
      setSelected(
        await api('/purchase-orders/' + selected.id + '/' + action, 'POST', {
          version: selected.version,
          ...(action === 'place' ? {} : { reason }),
        }),
      );
      setModal('');
      setReason('');
      reload();
      notify(
        action === 'place'
          ? 'Zatwierdzono lokalnie. Oczekiwanie na dostawę.'
          : 'Zamówienie rozliczone.',
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel purchasing-panel">
      <div className="panel-heading">
        <div>
          <h2>Zakupy i dostawy</h2>
          <p>Dostawca → zamówienie zakupowe → przyjęcie PZ → dostępny towar</p>
        </div>
        {admin && tab !== 'replenishment' && (
          <button
            className="button primary"
            onClick={() => {
              setError('');
              setSupplier(null);
              setModal(tab === 'orders' ? 'new' : 'supplier');
            }}
          >
            <Plus size={16} />
            {tab === 'orders' ? 'Nowy zakup' : 'Dodaj dostawcę'}
          </button>
        )}
      </div>
      <div className="warehouse-actions purchase-tabs">
        <button
          className={'button ' + (tab === 'orders' ? 'primary' : '')}
          onClick={() => {
            changeTab('orders');
          }}
        >
          Zamówienia zakupowe
        </button>
        <button
          className={'button ' + (tab === 'suppliers' ? 'primary' : '')}
          onClick={() => {
            changeTab('suppliers');
          }}
        >
          Dostawcy
        </button>
        <button
          className={'button ' + (tab === 'replenishment' ? 'primary' : '')}
          onClick={() => changeTab('replenishment')}
        >
          Planowanie dostaw
        </button>
      </div>
      <ErrorNotice error={error} />
      <div
        hidden={tab !== 'replenishment'}
        style={tab !== 'replenishment' ? { display: 'none' } : undefined}
      >
        <ReplenishmentPlans
          contextKey={contextKey}
          readOnly={readOnly}
          onOpenPurchase={(id) => {
            changeTab('orders');
            void open(id);
          }}
        />
      </div>
      {tab === 'replenishment' ? null : selected && tab === 'orders' ? (
        <div className="warehouse-detail">
          <button
            className="button subtle"
            onClick={() => {
              detailEpoch.current++;
              setSelected(null);
            }}
          >
            <ArrowLeft size={16} />
            Lista zakupów
          </button>
          <div className="panel-heading">
            <div>
              <h3>{selected.number}</h3>
              <p>
                {selected.supplier_snapshot.name} · {selected.warehouse_name}
              </p>
            </div>
            <span className={'purchase-state purchase-' + selected.state}>
              {states[selected.state]}
            </span>
          </div>
          <div className="purchase-metrics">
            <div>
              <small>Zamówiono netto</small>
              <strong>{money(selected.total_net, selected.currency)}</strong>
            </div>
            <div>
              <small>Przyjęto netto</small>
              <strong>{money(selected.received_net, selected.currency)}</strong>
            </div>
            <div>
              <small>Pozostało do dostawy</small>
              <strong>
                {selected.lines.reduce((n: number, l: any) => n + l.remaining_quantity, 0)} szt.
              </strong>
            </div>
            <div>
              <small>Oczekiwana dostawa</small>
              <strong>
                {selected.expected_date
                  ? new Date(selected.expected_date + 'T12:00:00').toLocaleDateString('pl-PL')
                  : 'Nie ustalono'}
              </strong>
            </div>
          </div>
          <p>
            Referencja: {selected.reference || '—'}
            {selected.note && ' · ' + selected.note}
          </p>
          {admin && (
            <div className="warehouse-actions">
              {selected.state === 'draft' && (
                <>
                  <button className="button" onClick={() => setModal('edit')}>
                    Edytuj szkic
                  </button>
                  <button className="button primary" onClick={() => setModal('place')}>
                    <Truck size={16} />
                    Zatwierdź zakup
                  </button>
                </>
              )}
              {['ordered', 'partial'].includes(selected.state) && (
                <>
                  <button className="button primary" onClick={() => setModal('receive')}>
                    <PackageCheck size={16} />
                    Przyjmij dostawę
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      setReason('');
                      setModal('close');
                    }}
                  >
                    Zamknij pozostałą ilość
                  </button>
                </>
              )}
              {['draft', 'ordered'].includes(selected.state) && (
                <button
                  className="button"
                  onClick={() => {
                    setReason('');
                    setModal('cancel');
                  }}
                >
                  Anuluj zakup
                </button>
              )}
              <button className="button subtle" disabled={busy} onClick={() => open(selected.id)}>
                Odśwież szczegóły
              </button>
            </div>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Produkt / SKU dostawcy</th>
                  <th>Cena zakupu netto</th>
                  <th>Zamówiono</th>
                  <th>Przyjęto</th>
                  <th>Zamknięto</th>
                  <th>Pozostało</th>
                  <th>Stan / rezerwacje</th>
                </tr>
              </thead>
              <tbody>
                {selected.lines.map((l: any) => (
                  <tr key={l.product_id}>
                    <td>
                      <strong>{l.sku}</strong>
                      <small>
                        {l.name}
                        {l.supplier_sku && ' · ' + l.supplier_sku}
                      </small>
                    </td>
                    <td>{money(l.unit_cost, selected.currency)}</td>
                    <td>{l.quantity}</td>
                    <td>{l.received_quantity}</td>
                    <td>{l.closed_quantity}</td>
                    <td>{l.remaining_quantity}</td>
                    <td>
                      {l.on_hand ?? 0} / {l.reserved ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected.close_reason && (
            <div className="notice">Powód zamknięcia: {selected.close_reason}</div>
          )}
          <h3>Przyjęcia magazynowe</h3>
          {!selected.receipts.length ? (
            <p className="warehouse-empty">
              Brak przyjęć. Zatwierdzenie zakupu nie zmienia stanu magazynu.
            </p>
          ) : (
            <div className="purchase-receipts">
              {selected.receipts.map((r: any) => (
                <article key={r.id}>
                  <PackageCheck size={20} />
                  <div>
                    <strong>{r.document_number}</strong>
                    <small>
                      {date(r.created_at)} ·{' '}
                      {r.lines.reduce((n: number, l: any) => n + l.quantity, 0)} szt. ·{' '}
                      {r.reference || 'Bez referencji'}
                    </small>
                    {r.note && <small>{r.note}</small>}
                  </div>
                  <span className="stock-pill">PZ zatwierdzone</span>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="warehouse-filters">
            <label>
              Szukaj
              <input
                value={search}
                maxLength={200}
                placeholder={
                  tab === 'orders' ? 'Numer, dostawca lub referencja' : 'Nazwa lub kod dostawcy'
                }
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            {tab === 'orders' && (
              <label>
                Status
                <select value={state} onChange={(e) => setState(e.target.value)}>
                  <option value="">Wszystkie statusy</option>
                  {Object.entries(states).map(([k, v]) => (
                    <option value={k} key={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {loading ? (
            <p>Wczytywanie…</p>
          ) : !rows.length ? (
            <p className="warehouse-empty">
              {tab === 'orders'
                ? 'Zaplanuj pierwszy zakup od dostawcy.'
                : 'Dodaj dostawcę, aby rozpocząć zakupy.'}
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                {tab === 'orders' ? (
                  <>
                    <thead>
                      <tr>
                        <th>Numer / referencja</th>
                        <th>Dostawca</th>
                        <th>Magazyn</th>
                        <th>Wartość netto</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((d) => (
                        <tr key={d.id}>
                          <td>
                            <button className="warehouse-link" onClick={() => open(d.id)}>
                              {d.number}
                            </button>
                            <small>{d.reference || date(d.created_at)}</small>
                          </td>
                          <td>{d.supplier_snapshot.name}</td>
                          <td>{d.warehouse_name}</td>
                          <td>{money(d.total_net, d.currency)}</td>
                          <td>
                            <span className={'purchase-state purchase-' + d.state}>
                              {states[d.state]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </>
                ) : (
                  <>
                    <thead>
                      <tr>
                        <th>Dostawca / kod</th>
                        <th>Kontakt</th>
                        <th>Kraj / NIP</th>
                        <th>Status</th>
                        {admin && <th>Operacje</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((d) => (
                        <tr key={d.id}>
                          <td>
                            <strong>{d.name}</strong>
                            <small>{d.code}</small>
                          </td>
                          <td>
                            {d.email || '—'}
                            <small>{d.phone}</small>
                          </td>
                          <td>
                            {d.country}
                            <small>{d.tax_id}</small>
                          </td>
                          <td>{d.active ? 'Aktywny' : 'Archiwalny'}</td>
                          {admin && (
                            <td>
                              <button
                                className="button"
                                onClick={() => {
                                  setSupplier(d);
                                  setModal('supplier');
                                }}
                              >
                                Edytuj dostawcę
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </>
                )}
              </table>
            </div>
          )}
          {cursor && (
            <button
              className="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api(path + '&after=' + cursor);
                  setRows([...rows, ...r.data]);
                  setCursor(r.meta.cursor);
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Wczytaj kolejne
            </button>
          )}
        </>
      )}
      <SupplierFileSources
        key={`${contextKey}:${readOnly}`}
        contextKey={contextKey}
        readOnly={readOnly}
        admin={admin}
        refresh={refresh}
        reload={reload}
        notify={notify}
        onLockedChange={setSupplierFileLocked}
        externalWriteBlocked={supplierRemoteLocked}
      />
      {(supplierFileLocked || supplierFileRetainedLocked || supplierRemoteLocked) && (
        <p className="notice">
          Trwa odczyt, pobranie lub nierozstrzygnięta próba źródła. Nowe zapisy w katalogu dostawcy
          są wstrzymane; historia i dokładne ponowienie pozostają w panelu powyżej.
        </p>
      )}
      <SupplierCatalog
        admin={admin}
        refresh={refresh}
        reload={reload}
        notify={notify}
        contextKey={contextKey}
        readOnly={readOnly}
        productWriteBlocked={productWriteBlocked}
        externalWriteBlocked={
          supplierFileLocked || supplierFileRetainedLocked || supplierRemoteLocked
        }
      />
      {modal === 'supplier' && (
        <SupplierForm
          initial={supplier}
          close={() => setModal('')}
          saved={() => {
            setModal('');
            reload();
            notify('Dostawca zapisany.');
          }}
        />
      )}
      {['new', 'edit'].includes(modal) && (
        <PurchaseForm
          initial={modal === 'edit' ? selected : null}
          close={() => setModal('')}
          saved={saved}
        />
      )}
      {modal === 'receive' && (
        <ReceiptForm
          key={selected.id + ':' + selected.version}
          order={selected}
          close={() => setModal('')}
          saved={(d) => {
            setSelected(d);
            setModal('');
            reload();
            notify('Dostawa przyjęta. Towar jest dostępny w magazynie.');
          }}
        />
      )}
      {['place', 'close', 'cancel'].includes(modal) && (
        <Dialog
          title={
            modal === 'place'
              ? 'Zatwierdź zakup'
              : modal === 'close'
                ? 'Zamknij pozostałą ilość'
                : 'Anuluj zakup'
          }
          close={() => setModal('')}
          busy={busy}
        >
          <form
            className="warehouse-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action(modal);
            }}
          >
            <ErrorNotice error={error} />
            <div className="notice">
              {modal === 'place'
                ? 'Zatwierdzenie zamraża pozycje i ceny zakupu. Nie wysyła zamówienia do dostawcy. Stany zmienią się po przyjęciu dostawy.'
                : modal === 'close'
                  ? 'Niedostarczona reszta zostanie zamknięta. Przyjęty towar pozostaje w magazynie.'
                  : 'Anulowanie nie zmienia stanu magazynu. Zamówienie z przyjęciami można wyłącznie zamknąć.'}
            </div>
            {modal !== 'place' && (
              <label>
                Powód
                <textarea
                  required
                  maxLength={1000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
            <footer>
              <button className="button" type="button" disabled={busy} onClick={() => setModal('')}>
                Wróć
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Zapisywanie…' : 'Potwierdź'}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </section>
  );
}
function SupplierForm({
  initial,
  close,
  saved,
}: {
  initial: any;
  close: () => void;
  saved: () => void;
}) {
  const [b, setB] = useState(
      initial ?? {
        name: '',
        code: '',
        contact_name: '',
        email: '',
        phone: '',
        address: '',
        tax_id: '',
        country: 'PL',
        active: true,
      },
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const labels: Record<string, string> = {
    name: 'Nazwa dostawcy',
    code: 'Kod dostawcy',
    contact_name: 'Osoba kontaktowa',
    email: 'E-mail',
    phone: 'Telefon',
    tax_id: 'NIP / identyfikator podatkowy',
    country: 'Kraj',
    address: 'Adres',
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/suppliers' + (initial ? '/' + initial.id : ''), initial ? 'PATCH' : 'POST', b);
      saved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={initial ? 'Edytuj dostawcę' : 'Dodaj dostawcę'} close={close} busy={busy}>
      <form className="warehouse-form" onSubmit={submit}>
        <ErrorNotice error={error} />
        <div className="purchase-fields">
          {Object.entries(labels).map(([k, v]) => (
            <label key={k}>
              {v}
              <input
                required={['name', 'code', 'country'].includes(k)}
                minLength={k === 'name' ? 2 : undefined}
                maxLength={
                  k === 'country'
                    ? 2
                    : k === 'address'
                      ? 1000
                      : k === 'code' || k === 'tax_id'
                        ? 80
                        : k === 'phone'
                          ? 40
                          : 200
                }
                type={k === 'email' ? 'email' : 'text'}
                value={b[k]}
                onChange={(e) =>
                  setB({
                    ...b,
                    [k]: k === 'country' ? e.target.value.toUpperCase() : e.target.value,
                  })
                }
              />
            </label>
          ))}
        </div>
        <label className="warehouse-check">
          <input
            type="checkbox"
            checked={b.active}
            onChange={(e) => setB({ ...b, active: e.target.checked })}
          />
          Aktywny dostawca
        </label>
        <footer>
          <button type="button" className="button" disabled={busy} onClick={close}>
            Wróć
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? 'Zapisywanie…' : 'Zapisz dostawcę'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
function SupplierPicker({
  value,
  select,
  initial,
}: {
  value: string;
  select: (id: string) => void;
  initial?: any;
}) {
  const [search, setSearch] = useState(''),
    [rows, setRows] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const path = '/suppliers?active=true&limit=50&search=' + encodeURIComponent(search);
  useEffect(() => {
    let live = true;
    api(path)
      .then((r) => {
        if (live) {
          setRows(r.data);
          setCursor(r.meta.cursor);
          setError('');
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [path]);
  return (
    <div>
      <label>
        Szukaj dostawcy
        <input
          aria-label="Szukaj dostawcy"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <label>
        Dostawca
        <select
          required
          aria-label="Dostawca"
          value={value}
          onChange={(e) => select(e.target.value)}
        >
          <option value="">Wybierz dostawcę</option>
          {initial && !rows.some((r) => r.id === initial.id) && (
            <option value={initial.id}>{initial.name}</option>
          )}
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.code} · {r.name}
            </option>
          ))}
        </select>
      </label>
      <ErrorNotice error={error} />
      {cursor && (
        <button
          type="button"
          className="button subtle"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api(path + '&after=' + cursor);
              setRows([...rows, ...r.data]);
              setCursor(r.meta.cursor);
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Więcej dostawców
        </button>
      )}
    </div>
  );
}
function PurchaseForm({
  initial,
  close,
  saved,
}: {
  initial: any;
  close: () => void;
  saved: (d: any) => void;
}) {
  const [b, setB] = useState(
      initial ?? {
        supplier_id: '',
        warehouse_id: '',
        currency: 'PLN',
        reference: '',
        note: '',
        expected_date: null,
      },
    ),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [lines, setLines] = useState<any[]>(
      initial?.lines.map((l: any) => ({ ...l, key: l.product_id })) ?? [
        { key: crypto.randomUUID(), product_id: '', quantity: 1, unit_cost: 0, supplier_sku: '' },
      ],
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api('/warehouses')
      .then((r) => {
        if (live) {
          setWarehouses(r.data);
          if (!initial) setB((x: any) => ({ ...x, warehouse_id: r.data[0]?.id ?? '' }));
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [initial]);
  const update = (key: string, p: any) =>
    setLines(lines.map((l) => (l.key === key ? { ...l, ...p } : l)));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      saved(
        await api(
          '/purchase-orders' + (initial ? '/' + initial.id : ''),
          initial ? 'PATCH' : 'POST',
          {
            ...b,
            lines: lines.map((l) => ({
              product_id: l.product_id,
              quantity: Number(l.quantity),
              unit_cost: Number(l.unit_cost),
              supplier_sku: l.supplier_sku,
            })),
          },
        ),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title={initial ? 'Edytuj zakup' : 'Nowy zakup'} close={close} busy={busy}>
      <form className="warehouse-form" onSubmit={submit}>
        <ErrorNotice error={error} />
        <div className="purchase-fields">
          <SupplierPicker
            value={b.supplier_id}
            initial={initial?.supplier_snapshot}
            select={(id) => setB({ ...b, supplier_id: id })}
          />
          <div>
            <label>
              Magazyn
              <select
                required
                value={b.warehouse_id}
                onChange={(e) => setB({ ...b, warehouse_id: e.target.value })}
              >
                <option value="">Wybierz magazyn</option>
                {warehouses.map((w) => (
                  <option value={w.id} key={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Waluta
              <select value={b.currency} onChange={(e) => setB({ ...b, currency: e.target.value })}>
                {['PLN', 'EUR', 'USD', 'GBP', 'CZK'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Oczekiwana dostawa
            <input
              type="date"
              value={b.expected_date?.slice(0, 10) ?? ''}
              onChange={(e) => setB({ ...b, expected_date: e.target.value || null })}
              onInput={(e) => setB({ ...b, expected_date: e.currentTarget.value || null })}
            />
          </label>
          <label>
            Referencja zakupu
            <input
              maxLength={200}
              value={b.reference}
              onChange={(e) => setB({ ...b, reference: e.target.value })}
            />
          </label>
        </div>
        {lines.map((l, i) => (
          <div className="warehouse-line" key={l.key}>
            <ProductPicker
              label={'Produkt ' + (i + 1)}
              value={l.product_id}
              initial={l.product_id ? { id: l.product_id, sku: l.sku, name: l.name } : undefined}
              filter={(p) => ['simple', 'variant'].includes(p.kind)}
              select={(p) => p && update(l.key, { product_id: p.id, sku: p.sku, name: p.name })}
            />
            <div className="purchase-fields">
              <label>
                Ilość
                <input
                  aria-label={'Ilość ' + (i + 1)}
                  required
                  type="number"
                  min={1}
                  max={1000000}
                  step={1}
                  value={l.quantity}
                  onChange={(e) => update(l.key, { quantity: e.target.value })}
                />
              </label>
              <label>
                Cena zakupu netto ({b.currency})
                <input
                  aria-label={'Cena zakupu ' + (i + 1)}
                  required
                  type="number"
                  min={0}
                  max={10000000}
                  step="0.01"
                  value={l.unit_cost / 100}
                  onChange={(e) =>
                    update(l.key, { unit_cost: Math.round(Number(e.target.value) * 100) })
                  }
                />
              </label>
              <label>
                SKU dostawcy
                <input
                  aria-label={'SKU dostawcy ' + (i + 1)}
                  maxLength={80}
                  value={l.supplier_sku}
                  onChange={(e) => update(l.key, { supplier_sku: e.target.value })}
                />
              </label>
              <div className="purchase-line-total">
                <small>Wartość netto</small>
                <strong>{money(Number(l.quantity) * Number(l.unit_cost), b.currency)}</strong>
              </div>
            </div>
            {lines.length > 1 && (
              <button
                type="button"
                className="button subtle"
                onClick={() => setLines(lines.filter((x) => x.key !== l.key))}
              >
                Usuń pozycję {i + 1}
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="button"
          disabled={busy || lines.length >= 200}
          onClick={() =>
            setLines([
              ...lines,
              {
                key: crypto.randomUUID(),
                product_id: '',
                quantity: 1,
                unit_cost: 0,
                supplier_sku: '',
              },
            ])
          }
        >
          <Plus size={16} />
          Dodaj pozycję
        </button>
        <label>
          Notatka
          <textarea
            maxLength={1000}
            value={b.note}
            onChange={(e) => setB({ ...b, note: e.target.value })}
          />
        </label>
        <div className="notice">
          Ceny zakupu są kwotami netto. Przyjęcie nie zmienia cen sprzedaży produktów.
        </div>
        <footer>
          <strong>
            Razem netto:{' '}
            {money(
              lines.reduce((n, l) => n + Number(l.quantity) * Number(l.unit_cost), 0),
              b.currency,
            )}
          </strong>
          <button className="button" type="button" disabled={busy} onClick={close}>
            Wróć
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? 'Zapisywanie…' : 'Zapisz szkic'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
function ReceiptForm({
  order,
  close,
  saved,
}: {
  order: any;
  close: () => void;
  saved: (d: any) => void;
}) {
  const [lines, setLines] = useState<any[]>(
      order.lines
        .filter((l: any) => l.remaining_quantity > 0)
        .map((l: any) => ({ ...l, quantity: 0, location: 'A-01', lot_code: '', expiry_date: '' })),
    ),
    [reference, setReference] = useState(''),
    [note, setNote] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState<any>(null);
  const [lotPolicy, setLotPolicy] = useState<any>(null),
    [lotReady, setLotReady] = useState(false),
    [stockVersions, setStockVersions] = useState<any[]>([]),
    [denied, setDenied] = useState(false);
  const [sourceVersion] = useState(order.version);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const health = await api('/health');
        if (!health.wms_lots_available) {
          if (active) setLotReady(true);
          return;
        }
        const meta = await api('/wms-lots');
        if (!active) return;
        if (!meta.available || meta.read_only || (meta.policy.enabled && !meta.can_receive)) {
          setDenied(true);
          setLotReady(false);
          setLines([]);
          setStockVersions([]);
          setReference('');
          setNote('');
          throw Error('Bieżący dostęp nie pozwala przyjąć dostawy w tej kopii');
        }
        setLotPolicy(meta.policy);
        if (meta.policy.enabled) {
          const ids = lines.map((line) => line.product_id);
          const snapshot = await api(
            '/inventory/snapshot?warehouse_id=' +
              encodeURIComponent(order.warehouse_id) +
              '&product_ids=' +
              encodeURIComponent(ids.join(',')),
          );
          if (!active) return;
          setStockVersions(
            ids.map((id: string) => ({
              warehouse_id: order.warehouse_id,
              product_id: id,
              version: snapshot.data.find((s: any) => s.product_id === id)?.version ?? '0',
            })),
          );
        }
        if (active) setLotReady(true);
      } catch (e: any) {
        if (active) {
          setError(e.message);
          setLotReady(false);
          if (e instanceof ApiError && [401, 403, 423].includes(e.status)) {
            setDenied(true);
            setLotPolicy(null);
            setStockVersions([]);
            setLines([]);
            setReference('');
            setNote('');
          }
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [order.id]);
  const update = (id: string, p: any) =>
    setLines(lines.map((l) => (l.product_id === id ? { ...l, ...p } : l)));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!lotReady || denied) return;
    const received = lines.filter((l) => Number(l.quantity) > 0);
    if (!attempt && lotPolicy?.enabled && received.some((l) => !l.lot_code.trim())) {
      setError('Wprowadź kod partii każdej przyjmowanej pozycji.');
      return;
    }
    const body = attempt ?? {
      version: sourceVersion,
      client_key: crypto.randomUUID(),
      reference,
      note,
      lines: lines
        .filter((l) => Number(l.quantity) > 0)
        .map((l) => ({
          product_id: l.product_id,
          quantity: Number(l.quantity),
          location: l.location,
        })),
      ...(lotPolicy?.enabled
        ? {
            wms_lots: {
              policy_version: lotPolicy.version,
              stock_versions: stockVersions.filter((s) =>
                received.some((l) => l.product_id === s.product_id),
              ),
              lines: received.map((l) => ({
                product_id: l.product_id,
                quantity: Number(l.quantity),
                location: l.location,
                lot_code: l.lot_code.trim(),
                expiry_date: l.expiry_date || null,
              })),
            },
          }
        : {}),
    };
    if (!body.lines.length) {
      setError('Wprowadź dodatnią ilość przynajmniej jednej pozycji.');
      return;
    }
    setAttempt(body);
    setBusy(true);
    setError('');
    try {
      const r = await api('/purchase-orders/' + order.id + '/receive', 'POST', body);
      saved(r.order);
    } catch (e: any) {
      if (e instanceof ApiError && [401, 403, 423].includes(e.status)) {
        setDenied(true);
        setAttempt(null);
        setLines([]);
        setStockVersions([]);
        setLotPolicy(null);
        setReference('');
        setNote('');
        setLotReady(false);
        setError(e.message + ' Formularz został wyczyszczony. Zamknij go i odśwież dostęp.');
      } else if (e instanceof ApiError && [400, 409, 413, 422].includes(e.status)) {
        setAttempt(null);
        setError(
          e.message +
            (e.status === 409
              ? ' Zamknij formularz i odczytaj aktualne wersje całego przyjęcia.'
              : ' Popraw szkic przed nowym zatwierdzeniem.'),
        );
        if (e.status === 409) setLotReady(false);
      } else setError(e.message + ' Ponowienie użyje tego samego zakresu dostawy.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Przyjmij dostawę" close={close} busy={busy || Boolean(attempt)}>
      <form className="warehouse-form" onSubmit={submit}>
        <ErrorNotice error={error} />
        {attempt && !busy && (
          <p className="notice">
            Wynik przyjęcia wymaga potwierdzenia. Ponów ten sam zapis, aby sprawdzić wynik dla
            podanych ilości i partii.
          </p>
        )}
        <div className="notice">
          Wprowadź ilości fizycznie otrzymane. Zero pomija pozycję. Zatwierdzenie utworzy PZ i
          udostępni towar w magazynie: {order.warehouse_name}.
        </div>
        {lotPolicy?.enabled && (
          <p className="notice">
            Magazyn partii FIFO jest aktywny. Koszt netto każdej partii pochodzi z zatwierdzonego
            zakupu ({order.currency}). Całe przyjęcie wymaga zgodnych wersji zapasu; przy konflikcie
            zamknij formularz i odczytaj go ponownie.
          </p>
        )}
        <fieldset disabled={busy || !!attempt} className="purchase-fieldset">
          <label>
            Referencja dostawy
            <input
              maxLength={200}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
          {lines.map((l, i) => (
            <div className="warehouse-line" key={l.product_id}>
              <strong>
                {l.sku} · {l.name}
              </strong>
              <small>Pozostało: {l.remaining_quantity} szt.</small>
              <div className="purchase-fields">
                <label>
                  Przyjmowana ilość
                  <input
                    aria-label={'Przyjmowana ilość ' + (i + 1)}
                    type="number"
                    required
                    min={0}
                    max={l.remaining_quantity}
                    step={1}
                    value={l.quantity}
                    onChange={(e) => update(l.product_id, { quantity: e.target.value })}
                  />
                </label>
                <label>
                  Lokalizacja nowego stanu
                  <input
                    aria-label={'Lokalizacja ' + (i + 1)}
                    required
                    maxLength={80}
                    value={l.location}
                    onChange={(e) => update(l.product_id, { location: e.target.value })}
                  />
                </label>
                {lotPolicy?.enabled && (
                  <>
                    <label>
                      Kod przyjmowanej partii
                      <input
                        aria-label={'Partia zakupu ' + (i + 1)}
                        maxLength={100}
                        required={Number(l.quantity) > 0}
                        value={l.lot_code}
                        onChange={(e) => update(l.product_id, { lot_code: e.target.value })}
                      />
                    </label>
                    <label>
                      Data ważności (opcjonalna)
                      <input
                        type="date"
                        value={l.expiry_date}
                        onChange={(e) => update(l.product_id, { expiry_date: e.target.value })}
                      />
                    </label>
                  </>
                )}
              </div>
            </div>
          ))}
          <label>
            Notatka
            <textarea maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </fieldset>
        <footer>
          <button
            className="button"
            type="button"
            disabled={busy || Boolean(attempt)}
            onClick={close}
          >
            Wróć
          </button>
          <button className="button primary" disabled={busy || !lotReady}>
            {busy
              ? 'Przyjmowanie…'
              : attempt
                ? 'Ponów to samo przyjęcie'
                : 'Zatwierdź przyjęcie PZ'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
