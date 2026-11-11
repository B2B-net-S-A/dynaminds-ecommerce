import { useEffect, useState, useRef, type ReactNode } from 'react';
import { catalogStockControlLocked } from './catalog-stock-control-panel';
import { Plus, X, ArrowLeft } from 'lucide-react';
import { api, date } from './api';
import { ProductPicker } from './catalog';
import { StockPicker, fetchStockSnapshot } from './inventory';
const kinds: Record<string, string> = {
  receipt: 'Przyjęcie PZ',
  transfer: 'Przesunięcie MM',
  count: 'Inwentaryzacja',
  issue: 'Wydanie WZ',
};
const statuses: Record<string, string> = {
  draft: 'Szkic',
  posted: 'Zatwierdzony',
  cancelled: 'Anulowany',
};
function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice import-error" role="alert">
      {children}
    </div>
  );
}
export function WarehouseDocuments({
  contextKey = '',
  admin,
  refresh,
  reload,
  notify,
  externalWriteBlocked = false,
  readOnly = false,
}: {
  contextKey?: string;
  admin: boolean;
  refresh: number;
  reload: () => void;
  notify: (s: string) => void;
  externalWriteBlocked?: boolean;
  readOnly?: boolean;
}) {
  const [rows, setRows] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [kind, setKind] = useState(''),
    [status, setStatus] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [selected, setSelected] = useState<any>(null),
    [editing, setEditing] = useState(false),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const writeAccess = useRef({ contextKey, readOnly, externalWriteBlocked });
  writeAccess.current = { contextKey, readOnly, externalWriteBlocked };
  const writable = () => !writeAccess.current.readOnly && !writeAccess.current.externalWriteBlocked && !catalogStockControlLocked(writeAccess.current.contextKey);
  const path =
    '/warehouse-documents?limit=25&' +
    new URLSearchParams({ ...(kind ? { kind } : {}), ...(status ? { status } : {}) });
  useEffect(() => {
    let active = true;
    setLoading(true);
    api(path)
      .then((r) => {
        if (active) {
          setRows(r.data);
          setCursor(r.meta.cursor);
          setError('');
        }
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [path, refresh]);
  async function open(id: string) {
    setError('');
    try {
      setSelected(await api('/warehouse-documents/' + id));
      setConfirm(false);
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function action(type: 'post' | 'cancel') {
    if (!writable() || busy || !admin || !selected) return;
    setBusy(true);
    setError('');
    try {
      const d = await api('/warehouse-documents/' + selected.id + '/' + type, 'POST', {
        version: selected.version,
      });
      setSelected(d);
      setConfirm(false);
      reload();
      notify(
        type === 'post' ? 'Dokument zatwierdzony. Stany zostały rozliczone.' : 'Szkic anulowany.',
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const saved = (d: any) => {
    setCreating(false);
    setEditing(false);
    setSelected(d);
    setConfirm(false);
    setError('');
    reload();
    notify('Szkic zapisany. Stany zmienią się po zatwierdzeniu.');
  };
  return (
    <section className="panel warehouse-documents">
      <div className="panel-heading">
        <div>
          <h2>Dokumenty magazynowe</h2>
          <p>Przyjęcia, wydania, przesunięcia i pomiary stanów · szkic → zatwierdzenie</p>
        </div>
        {admin && (
          <button
            className="button primary"
            disabled={readOnly || externalWriteBlocked || busy}
            onClick={() => {
              if (writable()) setCreating(true);
            }}
          >
            <Plus size={16} />
            Nowy dokument
          </button>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
      {readOnly && (
        <p className="notice">
          Tryb tylko do odczytu. Zapisy i zatwierdzanie dokumentów są wyłączone.
        </p>
      )}
      {externalWriteBlocked && (
        <p className="notice">
          Nowe zapisy i zatwierdzanie dokumentów są zablokowane do czasu rozstrzygnięcia importu
          stanów. Dokumenty i historię można nadal odczytywać.
        </p>
      )}
      {selected ? (
        <div className="warehouse-detail">
          <button
            className="button subtle"
            onClick={() => {
              setSelected(null);
              setConfirm(false);
              setError('');
            }}
          >
            <ArrowLeft size={16} />
            Lista dokumentów
          </button>
          <div className="panel-heading">
            <div>
              <h3>
                {selected.number} · {kinds[selected.kind]}
              </h3>
              <p>
                {selected.warehouse_name}
                {selected.destination_name ? ' → ' + selected.destination_name : ''} ·{' '}
                {statuses[selected.status]}
              </p>
            </div>
            {admin && selected.status === 'draft' && (
              <div className="warehouse-actions">
                <button
                  className="button"
                  disabled={readOnly || externalWriteBlocked || busy}
                  onClick={() => {
                    if (writable()) setEditing(true);
                  }}
                >
                  {selected.kind === 'count' ? 'Wprowadź nowy pomiar' : 'Edytuj szkic'}
                </button>
                <button
                  className="button"
                  disabled={readOnly || externalWriteBlocked || busy}
                  onClick={() => action('cancel')}
                >
                  Anuluj szkic
                </button>
                <button
                  className="button primary"
                  disabled={readOnly || externalWriteBlocked || busy}
                  onClick={() => {
                    if (writable()) setConfirm(true);
                  }}
                >
                  Zatwierdź dokument
                </button>
              </div>
            )}
          </div>
          <p>
            Referencja: {selected.reference || '—'} · {selected.note || 'Bez notatki'}
          </p>
          {selected.kind === 'count' && (
            <div className="notice">
              Pomiar dotyczy całego stanu, razem z rezerwacjami. Każda zmiana stanu lub rezerwacji
              po zapisaniu szkicu wymaga ponownego przeliczenia i zapisania całego pomiaru.
            </div>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SKU / produkt</th>
                  <th>{selected.kind === 'count' ? 'Zmierzono' : 'Ilość'}</th>
                  <th>Stan przy zapisie</th>
                  <th>Rezerwacje przy zapisie</th>
                  <th>Stan obecny</th>
                  <th>Lokalizacja nowego stanu</th>
                </tr>
              </thead>
              <tbody>
                {selected.lines.map((l: any) => (
                  <tr key={l.product_id}>
                    <td>
                      <strong>{l.sku}</strong>
                      <small>{l.name}</small>
                    </td>
                    <td>{l.quantity}</td>
                    <td>{l.expected_on_hand}</td>
                    <td>{l.expected_reserved}</td>
                    <td>
                      {l.current_on_hand ?? 0}
                      {selected.kind === 'count' &&
                        selected.status === 'draft' &&
                        l.current_version !== l.expected_version && (
                          <small className="negative">Wymaga ponownego pomiaru</small>
                        )}
                    </td>
                    <td>{l.location}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected.posted_at && (
            <p>Zatwierdzono: {date(selected.posted_at)}. Dokument jest nieedytowalny.</p>
          )}
          {confirm && (
            <div className="notice warehouse-confirm">
              <p>
                Zatwierdzenie zmieni stany wszystkich pozycji w jednej operacji. Dokumentu nie
                będzie można edytować ani anulować.
              </p>
              <button
                className="button primary"
                disabled={readOnly || externalWriteBlocked || busy}
                onClick={() => action('post')}
              >
                {busy ? 'Zatwierdzanie…' : 'Potwierdzam zatwierdzenie'}
              </button>
              <button className="button" disabled={busy} onClick={() => setConfirm(false)}>
                Wróć do podglądu
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="warehouse-filters">
            <label>
              Rodzaj
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">Wszystkie rodzaje</option>
                {Object.entries(kinds).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Wszystkie statusy</option>
                {Object.entries(statuses).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {loading ? (
            <p>Wczytywanie dokumentów…</p>
          ) : !rows.length ? (
            <p className="warehouse-empty">Brak dokumentów. Zacznij od przyjęcia dostawy.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Numer / data</th>
                    <th>Rodzaj</th>
                    <th>Magazyny</th>
                    <th>Referencja</th>
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
                        <small>{date(d.created_at)}</small>
                      </td>
                      <td>{kinds[d.kind]}</td>
                      <td>
                        {d.warehouse_name}
                        {d.destination_name && <small>→ {d.destination_name}</small>}
                      </td>
                      <td>{d.reference || '—'}</td>
                      <td>
                        <span className="stock-pill">{statuses[d.status]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
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
              Więcej dokumentów
            </button>
          )}
        </>
      )}
      {(creating || editing) && (
        <WarehouseForm
          initial={editing ? selected : null}
          close={() => {
            setCreating(false);
            setEditing(false);
          }}
          saved={saved}
          externalWriteBlocked={externalWriteBlocked}
          contextKey={contextKey}
          readOnly={readOnly}
        />
      )}
    </section>
  );
}
function WarehouseForm({
  contextKey,
  initial,
  close,
  saved,
  externalWriteBlocked,
  readOnly,
}: {
  initial: any;
  close: () => void;
  saved: (d: any) => void;
  contextKey: string;
  externalWriteBlocked: boolean;
  readOnly: boolean;
}) {
  const writeAccess = useRef({ contextKey, readOnly, externalWriteBlocked });
  writeAccess.current = { contextKey, readOnly, externalWriteBlocked };
  const writable = (scope: string) => writeAccess.current.contextKey === scope && !writeAccess.current.readOnly && !writeAccess.current.externalWriteBlocked && !catalogStockControlLocked(scope);
  const [kind, setKind] = useState(initial?.kind ?? 'receipt'),
    [warehouse, setWarehouse] = useState(initial?.warehouse_id ?? ''),
    [destination, setDestination] = useState(initial?.destination_id ?? ''),
    [reference, setReference] = useState(initial?.reference ?? ''),
    [note, setNote] = useState(initial?.note ?? ''),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [inventory, setInventory] = useState<any[]>([]),
    [lines, setLines] = useState<any[]>(
      initial?.lines.map((l: any) => ({
        ...l,
        id: l.product_id,
        quantity: initial.kind === 'count' ? '' : l.quantity,
      })) ?? [{ id: crypto.randomUUID(), product_id: '', quantity: 1, location: 'A-01' }],
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [snapshotLoading, setSnapshotLoading] = useState(false),
    [remeasured, setRemeasured] = useState(false);
  useEffect(() => {
    let active = true;
    api('/warehouses')
      .then((w) => {
        if (active) {
          setWarehouses(w.data);
          if (!initial) setWarehouse(w.data[0]?.id ?? '');
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [initial]);
  useEffect(() => {
    let active = true;
    setInventory([]);
    setRemeasured(false);
    if (kind !== 'count' || !warehouse) {
      setSnapshotLoading(false);
      return;
    }
    setSnapshotLoading(true);
    fetchStockSnapshot(
      warehouse,
      lines.map((l) => l.product_id),
    )
      .then((rows) => active && setInventory(rows))
      .catch((e) => active && setError(e.message))
      .finally(() => active && setSnapshotLoading(false));
    return () => {
      active = false;
    };
  }, [kind, warehouse, initial]);
  const update = (id: string, patch: any) =>
    setLines(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!writable(contextKey) || busy || snapshotLoading) return;
    const submittedScope = contextKey;
    if (kind === 'count' && !remeasured) {
      setError('Potwierdź ponowne przeliczenie wszystkich pozycji.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (!writable(submittedScope)) return;
      const d = await api(
        '/warehouse-documents' + (initial ? '/' + initial.id : ''),
        initial ? 'PATCH' : 'POST',
        {
          kind,
          warehouse_id: warehouse,
          destination_id: kind === 'transfer' ? destination : null,
          reference,
          note,
          lines: lines.map((l) => ({
            product_id: l.product_id,
            quantity: Number(l.quantity),
            location: l.location,
            ...(kind === 'count'
              ? {
                  expected_version: inventory.find(
                    (s) => s.product_id === l.product_id && s.warehouse_id === warehouse,
                  )?.version,
                }
              : {}),
          })),
          ...(initial ? { version: initial.version } : {}),
        },
      );
      saved(d);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-shade">
      <section
        className="modal catalog-modal"
        role="dialog"
        aria-modal="true"
        aria-label={initial ? 'Edytuj dokument magazynowy' : 'Nowy dokument magazynowy'}
      >
        <header>
          <h2>
            {initial
              ? kind === 'count'
                ? 'Nowy pomiar całego szkicu'
                : 'Edytuj szkic'
              : 'Nowy dokument magazynowy'}
          </h2>
          <button className="icon-btn" disabled={busy} onClick={close} aria-label="Zamknij">
            <X size={20} />
          </button>
        </header>
        {readOnly && <p className="notice">Tryb tylko do odczytu. Nie można zapisać szkicu.</p>}
        <form onSubmit={submit} className="warehouse-form">
          <fieldset
            className="warehouse-fieldset"
            disabled={readOnly || externalWriteBlocked || busy || snapshotLoading}
          >
            {error && <Notice>{error}</Notice>}
            <div className="warehouse-filters">
              <label>
                Rodzaj dokumentu
                <select
                  disabled={!!initial || busy}
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    if (e.target.value === 'count')
                      setLines(lines.map((l) => ({ ...l, quantity: '' })));
                    setRemeasured(false);
                  }}
                >
                  {Object.entries(kinds).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Magazyn źródłowy
                <select
                  disabled={!!initial || busy}
                  required
                  value={warehouse}
                  onChange={(e) => {
                    setWarehouse(e.target.value);
                    setRemeasured(false);
                    if (kind === 'count')
                      setLines(lines.map((l) => ({ ...l, product_id: '', quantity: '' })));
                  }}
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              {kind === 'transfer' && (
                <label>
                  Magazyn docelowy
                  <select
                    disabled={!!initial || busy}
                    required
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  >
                    <option value="">Wybierz magazyn</option>
                    {warehouses
                      .filter((w) => w.id !== warehouse)
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
            <label>
              Referencja dostawy / pomiaru
              <input
                maxLength={200}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </label>
            <label>
              Notatka
              <textarea maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            {kind === 'count' && (
              <div className="notice">
                Wprowadź policzony fizycznie stan każdej pozycji, razem z towarem zarezerwowanym.
                Zero oznacza brak towaru. Baza stanu pochodzi z odczytu wybranej pozycji lub
                otwarcia szkicu. Zmiana stanu lub rezerwacji blokuje zapis albo zatwierdzenie;
                rozpocznij wtedy ponowny pomiar wszystkich pozycji.
              </div>
            )}
            {kind === 'count' && (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  setRemeasured(false);
                  setLines(lines.map((l) => ({ ...l, quantity: '' })));
                  setInventory([]);
                  try {
                    const rows = await fetchStockSnapshot(
                      warehouse,
                      lines.map((l) => l.product_id),
                    );
                    setInventory(rows);
                    setLines(lines.map((l) => ({ ...l, quantity: '' })));
                    setRemeasured(false);
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Rozpocznij ponowny pomiar
              </button>
            )}
            {lines.map((l, i) => {
              const s = inventory.find(
                (s) => s.product_id === l.product_id && s.warehouse_id === warehouse,
              );
              return (
                <div key={l.id} className="warehouse-line">
                  {kind === 'count' ? (
                    <StockPicker
                      key={warehouse + ':' + l.id}
                      label={'Produkt ' + (i + 1)}
                      warehouse={warehouse}
                      value={l.product_id}
                      initial={
                        s ??
                        (l.product_id
                          ? { product_id: l.product_id, sku: l.sku, name: l.name }
                          : undefined)
                      }
                      select={(p) => {
                        if (
                          p &&
                          lines.some(
                            (other) => other.id !== l.id && other.product_id === p.product_id,
                          )
                        ) {
                          setError('Produkt jest już w pomiarze. Wybierz inną pozycję.');
                          return;
                        }
                        update(l.id, {
                          product_id: p?.product_id ?? '',
                          sku: p?.sku,
                          name: p?.name,
                          quantity: '',
                        });
                        setRemeasured(false);
                        if (p)
                          setInventory((rows) => [
                            ...rows.filter((row) => row.product_id !== p.product_id),
                            p,
                          ]);
                      }}
                    />
                  ) : (
                    <ProductPicker
                      label={'Produkt ' + (i + 1)}
                      value={l.product_id}
                      initial={
                        l.product_id ? { id: l.product_id, sku: l.sku, name: l.name } : undefined
                      }
                      filter={(p) => ['simple', 'variant'].includes(p.kind)}
                      select={(p) =>
                        p && update(l.id, { product_id: p.id, sku: p.sku, name: p.name })
                      }
                    />
                  )}
                  <div className="warehouse-filters">
                    <label>
                      {kind === 'count' ? 'Policzona ilość' : 'Ilość'}
                      <input
                        aria-label={'Ilość ' + (i + 1)}
                        type="number"
                        required
                        min={kind === 'count' ? 0 : 1}
                        max={1000000}
                        step={1}
                        value={l.quantity}
                        onChange={(e) => update(l.id, { quantity: e.target.value })}
                      />
                    </label>
                    {kind !== 'issue' && (
                      <label>
                        Lokalizacja dla nowego stanu
                        <input
                          aria-label={'Lokalizacja ' + (i + 1)}
                          maxLength={80}
                          required
                          value={l.location}
                          onChange={(e) => update(l.id, { location: e.target.value })}
                        />
                      </label>
                    )}
                  </div>
                  {kind === 'count' && l.product_id && (
                    <small>
                      Obecny stan: {s?.on_hand ?? 0} · rezerwacje: {s?.reserved ?? 0} · dostępne:{' '}
                      {s?.available ?? 0}
                    </small>
                  )}
                  {lines.length > 1 && (
                    <button
                      type="button"
                      className="button subtle"
                      onClick={() => setLines(lines.filter((x) => x.id !== l.id))}
                    >
                      Usuń pozycję {i + 1}
                    </button>
                  )}
                </div>
              );
            })}
            <button
              className="button"
              type="button"
              disabled={busy || lines.length >= 200}
              onClick={() =>
                setLines([
                  ...lines,
                  {
                    id: crypto.randomUUID(),
                    product_id: '',
                    quantity: kind === 'count' ? '' : 1,
                    location: 'A-01',
                  },
                ])
              }
            >
              <Plus size={16} />
              Dodaj pozycję
            </button>
            {kind === 'count' && (
              <label className="warehouse-check">
                <input
                  type="checkbox"
                  checked={remeasured}
                  onChange={(e) => setRemeasured(e.target.checked)}
                />
                Wszystkie ilości pochodzą z aktualnego przeliczenia fizycznego towaru.
              </label>
            )}
            <footer>
              <button type="button" className="button" disabled={busy} onClick={close}>
                Wróć
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Zapisywanie…' : 'Zapisz szkic'}
              </button>
            </footer>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
