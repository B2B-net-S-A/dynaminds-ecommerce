/** Top of the order card: breadcrumb with previous/next order, number with the fulfilment and
 * payment badges, meta line and the stage-dependent actions with the "⋯ Więcej" menu. */
import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { date, money } from './api';
import { fulfilmentLabel, type PaymentState } from './order-stage';
import { WorkflowBadge } from './operations';
import { FulfilmentBadge, PaymentBadge } from './order-status-badges';
import { sourceName, type Row } from './order-card-model';

export function OrderBreadcrumb({ order: o, stage, prev, next, onBack, onOpenStage, onOpenOrder }: {
  order: Row;
  stage: string;
  prev?: string;
  next?: string;
  onBack: () => void;
  onOpenStage?: (stage: string) => void;
  onOpenOrder: (id: string) => void;
}) {
  return (
    <nav className="order-breadcrumb" aria-label="Ścieżka">
      <ol>
        <li>
          <button type="button" className="text-button" title="Lista zamówień" onClick={onBack}>Zamówienia</button>
        </li>
        <li>
          {onOpenStage ? (
            <button type="button" className="text-button" onClick={() => onOpenStage(stage)}>{fulfilmentLabel(stage)}</button>
          ) : (
            <span>{fulfilmentLabel(stage)}</span>
          )}
        </li>
        <li aria-current="page">{o.number}</li>
      </ol>
      {(prev || next) && (
        <div className="order-neighbours">
          <button type="button" className="text-button" disabled={!prev} onClick={() => prev && onOpenOrder(prev)}>
            <ChevronLeft size={15} /> Poprzednie
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" className="text-button" disabled={!next} onClick={() => next && onOpenOrder(next)}>
            Następne <ChevronRight size={15} />
          </button>
        </div>
      )}
    </nav>
  );
}

/** Keeps the open menu inside the viewport: right-aligned to its button, flipped to the left edge of
 * the button when it would leave the screen on the left; closed by Escape, an outside click or a
 * click on one of its actions. */
export function useMoreMenu() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const menu = el.querySelector<HTMLElement>('.order-more-menu');
      if (!menu) return;
      menu.classList.remove('flip');
      if (el.open && menu.getBoundingClientRect().left < 8) menu.classList.add('flip');
    };
    const outside = (e: MouseEvent) => { if (el.open && !el.contains(e.target as Node)) el.open = false; };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && el.open) el.open = false; };
    // A button that opens an inline form inside the menu (data-keep-open, e.g. Zmień magazyn) keeps it open.
    const picked = (e: MouseEvent) => { if ((e.target as HTMLElement).closest('.order-more-menu button:not([data-keep-open])')) el.open = false; };
    el.addEventListener('toggle', place);
    el.addEventListener('click', picked);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('toggle', place);
      el.removeEventListener('click', picked);
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
    };
  }, []);
  return ref;
}

export function OrderCardHeader({ order: o, stage, paymentState, actions, primary, menu }: {
  order: Row;
  stage: string;
  paymentState: PaymentState | null;
  /** Always-present actions (Wystaw dokument). */
  actions?: ReactNode;
  /** Stage-dependent main action. */
  primary?: ReactNode;
  /** Items of "⋯ Więcej"; the menu is shown with a placeholder when there are none. */
  menu?: ReactNode;
}) {
  const replacement = o.fulfillment_kind === 'replacement';
  const more = useMoreMenu();
  return (
    <section className="panel order-card-header">
      <div className="order-card-top">
        <div>
          <span className="eyebrow">{replacement ? 'WYMIANA REKLAMACYJNA' : 'ZAMÓWIENIE'}</span>
          <div className="order-card-title">
            <h2>{o.number}</h2>
            {replacement && o.status === 'paid' ? <span className="badge">Gotowe do kompletacji</span> : <FulfilmentBadge stage={stage} />}
            {paymentState && <PaymentBadge state={paymentState} />}
            <WorkflowBadge status={o.workflow_status} />
            {/* Tags set by people or automation rules (e.g. "Wysoka wartość"), as on the list. */}
            {(o.tags ?? []).map((t: string) => (
              <span className="tag-pill" key={t}>
                {t}
              </span>
            ))}
          </div>
          <div className="order-card-meta">
            <span>{date(o.created_at)}</span>
            <span>· <strong>{sourceName(o.source)}</strong></span>
            {o.external_id && <span>· ID źródłowe {o.external_id}</span>}
            <span>· {money(o.total, o.currency)}</span>
          </div>
          {o.pricing_snapshot?.list && (
            <p className="muted">
              Cennik: {o.pricing_snapshot.list.name} · {o.pricing_snapshot.currency} · wersja {o.pricing_snapshot.list.version}
            </p>
          )}
        </div>
        <div className="order-card-total">
          <span className="muted">Razem brutto</span>
          <strong className="order-total">{money(o.total, o.currency)}</strong>
        </div>
      </div>
      <div className="order-card-actions">
        {actions}
        <div className="order-card-actions-end">
          {primary}
          <details className="order-more" ref={more}>
            <summary className="button" aria-label="Więcej akcji">⋯ Więcej</summary>
            <div className="order-more-menu">{menu ?? <p className="muted">Brak dodatkowych akcji dla tego etapu.</p>}</div>
          </details>
        </div>
      </div>
    </section>
  );
}
