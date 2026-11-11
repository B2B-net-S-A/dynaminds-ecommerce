/**
 * Bulk action bar of the order list (Uwagi v3 §3): appears after selecting orders and opens the
 * existing batch flows (status and note via preview → queue, labels, proformas, merge) one at a time.
 * A kept or unknown attempt of a flow keeps its panel open even without a selection, because it is
 * resolved there.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { BulkOperations } from './operations';
import { OrdersMergePanel } from './order-merges';
import { ProformaBatchPanel } from './proforma-batches';
import { ShipmentLabelBatchPanel } from './shipment-label-batches';
import { fulfilmentColors, fulfilmentLabels, type FulfilmentStage } from './order-stage';
import { downloadOrdersCsv, ordersCsv } from './orders-list-csv';
import { polishCount } from './order-status-panel';

/** Stages a person may set in bulk; "Gotowe do nadania" is derived and returns go through return cases. */
export const BULK_STAGES: FulfilmentStage[] = ['paid', 'picking', 'packed', 'shipped', 'delivered', 'completed', 'cancelled'];

export interface BulkWorkflowStatus {
  id: string;
  name: string;
  color: string;
  active: boolean;
  version?: number;
}
export interface BulkLocks {
  merge: boolean;
  proforma: boolean;
  print: boolean;
  invoice: boolean;
}
type Panel =
  | { kind: 'action'; action: Record<string, unknown> }
  | { kind: 'labels' }
  | { kind: 'proformas' }
  | { kind: 'invoices' }
  | { kind: 'merge' };

function Menu({ label, disabled, children }: { label: string; disabled?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="ob-menu-wrap" ref={root} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
      <button type="button" className="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((v) => !v)}>
        {label} <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="ob-menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function InvoiceLinks({ rows, selected }: { rows: any[]; selected: string[] }) {
  const chosen = rows.filter((r) => selected.includes(r.id));
  const withInvoice = chosen.filter((r) => r.invoice_documents?.length);
  const without = chosen.length - withInvoice.length;
  return (
    <section className="ops-panel ob-panel">
      <h2>Faktury wybranych zamówień</h2>
      <p>Zbiorczy wydruk faktur nie jest jeszcze dostępny. Otwórz fakturę i wydrukuj ją z podglądu.</p>
      {withInvoice.length ? (
        <ul className="ob-invoices">
          {withInvoice.flatMap((r) =>
            r.invoice_documents.map((d: { id: string; number: string }) => (
              <li key={d.id}>
                {r.number} ·{' '}
                <a href={'/api/documents/' + encodeURIComponent(d.id) + '/print'} target="_blank" rel="noreferrer">
                  {d.number}
                </a>
              </li>
            )),
          )}
        </ul>
      ) : (
        <p>Żadne z wybranych zamówień nie ma faktury.</p>
      )}
      {without > 0 && withInvoice.length > 0 && <p>Bez faktury: {polishCount(without, 'zamówienie', 'zamówienia', 'zamówień')}.</p>}
    </section>
  );
}

export function OrdersBulkBar({
  selected,
  rows,
  workflows,
  write,
  readOnly,
  contextKey,
  printContextKey,
  refresh,
  locks,
  onMergeLockedChange,
  onChanged,
  onOpenOrder,
  onClear,
  sourceLabel,
  automationSlot,
  openMerge,
}: {
  selected: string[];
  /** Rows of the current page (the selection never spans pages). */
  rows: any[];
  workflows: BulkWorkflowStatus[];
  write: boolean;
  readOnly: boolean;
  contextKey: string;
  printContextKey: string;
  refresh: number;
  locks: BulkLocks;
  onMergeLockedChange: (locked: boolean) => void;
  onChanged: () => void;
  onOpenOrder: (id: string) => void;
  onClear: () => void;
  sourceLabel: (source: string) => string;
  /** Lane G: manual automation buttons for the selection (<ManualAutomationButtons orderIds={selected} />). */
  automationSlot?: ReactNode;
  /** Token of a rule's merge proposal (bell): opens the merge panel once the proposed orders are selected. */
  openMerge?: number;
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const mergeOpened = useRef<number | undefined>(undefined);
  const locked = locks.merge || locks.proforma || locks.print || locks.invoice;
  useEffect(() => {
    if (!selected.length) setPanel(null);
  }, [selected.length]);
  useEffect(() => {
    if (openMerge === undefined || mergeOpened.current === openMerge || selected.length < 2) return;
    mergeOpened.current = openMerge;
    setPanel({ kind: 'merge' });
  }, [openMerge, selected.length]);
  // The merge panel locks the list while it reads its options, so a merge lock alone shows only its panel.
  const show = selected.length > 0 || locks.proforma || locks.print || locks.invoice;
  const open = (p: Panel) => setPanel(p);
  const is = (kind: Panel['kind']) => panel?.kind === kind;
  const canAct = write && !readOnly && !locked && selected.length > 0;
  const active = workflows.filter((w) => w.active);
  return (
    <>
      {show && (
        <div className="ob-bar" role="toolbar" aria-label="Akcje dla zaznaczonych zamówień">
          <span className="ob-count">Zaznaczono {selected.length}</span>
          <Menu label="Zmień status" disabled={!canAct}>
            {(close) => (
              <>
                <h4>Etap realizacji</h4>
                {BULK_STAGES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      open({ kind: 'action', action: { type: 'set_status', status: s } });
                      close();
                    }}
                  >
                    <span className="ob-dot" style={{ background: fulfilmentColors[s] }} aria-hidden="true" />
                    {fulfilmentLabels[s]}
                  </button>
                ))}
                <h4>Statusy własne</h4>
                {active.length ? (
                  active.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        open({ kind: 'action', action: { type: 'set_workflow', status_id: w.id, status_version: w.version } });
                        close();
                      }}
                    >
                      <span className="ob-dot" style={{ background: w.color }} aria-hidden="true" />
                      {w.name}
                    </button>
                  ))
                ) : (
                  <small>Brak aktywnych statusów własnych</small>
                )}
              </>
            )}
          </Menu>
          <Menu label="Drukuj" disabled={!selected.length || locked}>
            {(close) => (
              <>
                <button type="button" role="menuitem" disabled={!write || readOnly} onClick={() => (open({ kind: 'labels' }), close())}>
                  Etykiety
                </button>
                <button type="button" role="menuitem" onClick={() => (open({ kind: 'invoices' }), close())}>
                  <span>
                    Faktury
                    <small>lista faktur do otwarcia i wydruku</small>
                  </span>
                </button>
                <button type="button" role="menuitem" disabled={!write || readOnly} onClick={() => (open({ kind: 'proformas' }), close())}>
                  Proformy
                </button>
              </>
            )}
          </Menu>
          <button type="button" className="button" disabled={!canAct} onClick={() => open({ kind: 'action', action: { type: 'add_note', note: '' } })}>
            Dodaj notatkę
          </button>
          <button
            type="button"
            className="button"
            disabled={!selected.length}
            onClick={() => downloadOrdersCsv(ordersCsv(rows.filter((r) => selected.includes(r.id)), sourceLabel))}
          >
            Eksport
          </button>
          <button type="button" className="button" disabled={!write || readOnly || locks.proforma || locks.print || locks.invoice || selected.length < 2} onClick={() => open({ kind: 'merge' })}>
            Połącz zamówienia
          </button>
          {automationSlot}
          <span className="ob-spacer" />
          <button type="button" className="button subtle" disabled={locked} onClick={onClear}>
            Odznacz
          </button>
        </div>
      )}
      {panel && (panel.kind === 'action' || panel.kind === 'invoices' || panel.kind === 'labels') && (
        <div className="ob-panel-head">
          <span />
          <button type="button" className="icon-btn" aria-label="Zamknij panel akcji" onClick={() => setPanel(null)}>
            <X size={18} />
          </button>
        </div>
      )}
      {panel?.kind === 'action' && write && (
        <BulkOperations key={JSON.stringify(panel.action)} fixedAction={panel.action} selected={selected} refresh={refresh} onChanged={onChanged} />
      )}
      {panel?.kind === 'invoices' && <InvoiceLinks rows={rows} selected={selected} />}
      {(is('labels') || locks.print) && (
        <ShipmentLabelBatchPanel
          selectedOrderIds={selected}
          contextKey={printContextKey}
          readOnly={readOnly}
          externalWriteBlocked={locks.merge || locks.proforma || locks.invoice || !write}
          onOpenOrder={onOpenOrder}
          onChanged={onChanged}
        />
      )}
      {/* Proformas and merge stay mounted (as before) so their kept attempts and locks survive. */}
      <div hidden={!is('proformas') && !locks.proforma}>
        <ProformaBatchPanel
          selectedIds={selected}
          contextKey={printContextKey}
          readOnly={readOnly}
          externalWriteBlocked={locks.merge || locks.print || locks.invoice || !write}
          onChanged={onChanged}
          onOpenOrder={onOpenOrder}
        />
      </div>
      {locks.invoice && <p>Wynik wystawienia lokalnej faktury wymaga sprawdzenia w jej panelu przed następną zmianą zamówienia.</p>}
      {locks.print && <p>Trwa zapis drukowania lub jego wynik jest nieznany. Nowe operacje na liście zamówień są wstrzymane; ponowienie zachowanej próby jest dostępne w jej panelu.</p>}
      <div hidden={!is('merge') && !locks.merge}>
        <fieldset disabled={locks.proforma || locks.print || locks.invoice} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <OrdersMergePanel
            selectedIds={selected}
            contextKey={contextKey}
            readOnly={readOnly || !write}
            onOpenOrder={onOpenOrder}
            onLockedChange={onMergeLockedChange}
          />
        </fieldset>
      </div>
    </>
  );
}
