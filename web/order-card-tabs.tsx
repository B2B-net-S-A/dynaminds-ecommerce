/** Bottom tabs of the order card. Hidden panels stay mounted (like the former collapsed groups),
 * so pending recoveries, lock subscriptions and parcel seeds keep working whatever tab is open. */
import { forwardRef, type ReactNode } from 'react';

export type CardTab = 'history' | 'fields' | 'returns' | 'channel' | 'integrations' | 'address' | 'documents' | 'logistics' | 'more';
export const CARD_TABS: { id: CardTab; label: string }[] = [
  { id: 'history', label: 'Historia i notatki' },
  { id: 'fields', label: 'Pola dodatkowe' },
  { id: 'returns', label: 'Zwroty i reklamacje' },
  { id: 'channel', label: 'Kanał sprzedaży' },
  { id: 'integrations', label: 'Integracje (Amazon MCF)' },
  { id: 'address', label: 'Historia adresu' },
  { id: 'documents', label: 'Dokumenty i faktury' },
  { id: 'logistics', label: 'Magazyn i wysyłka' },
  { id: 'more', label: 'Więcej szczegółów' },
];

export const CardTabBar = forwardRef<HTMLDivElement, { active: CardTab; onSelect: (tab: CardTab) => void }>(function CardTabBar({ active, onSelect }, ref) {
  return (
    <div className="order-tabs" role="tablist" aria-label="Szczegóły zamówienia" ref={ref}>
      {CARD_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={'order-tab-' + t.id}
          aria-selected={active === t.id}
          aria-controls={'order-tabpanel-' + t.id}
          className={active === t.id ? 'active' : ''}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
});

export function CardTabPanel({ id, active, children }: { id: CardTab; active: CardTab; children: ReactNode }) {
  return (
    <div role="tabpanel" id={'order-tabpanel-' + id} aria-labelledby={'order-tab-' + id} hidden={active !== id} className="order-tabpanel">
      {children}
    </div>
  );
}
