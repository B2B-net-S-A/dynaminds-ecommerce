/** Main menu (expanded list or icon rail) and the options panel of the active module (Uwagi v3 §2). */
import { useEffect, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Box,
  Building2,
  ChevronsLeft,
  LayoutDashboard,
  MessagesSquare,
  Package,
  PlugZap,
  RotateCcw,
  ScanLine,
  Settings,
  ShoppingBag,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { api } from './api';
import { hasPanel, isOptionActive, type NavIcon, type NavModule, type NavOption } from './module-nav-config';
import {
  OrderStatusPanel,
  type OrderStatusCounts,
  type OrderStatusFilter,
  type OrderWorkflowStatus,
} from './order-status-panel';
import type { RoutePage } from './app-route';
import './module-nav.css';

const icons: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  orders: ShoppingBag,
  picking: ScanLine,
  returns: RotateCcw,
  payments: Wallet,
  customers: Building2,
  catalog: Package,
  communication: MessagesSquare,
  automations: Zap,
  integrations: PlugZap,
  reports: BarChart3,
  settings: Settings,
  warehouse: Box,
};

export function ModuleMenu({
  modules,
  activeId,
  panelOpen = false,
  collapsed,
  onModule,
  onWarehouse,
}: {
  modules: NavModule[];
  /** Highlighted module: the one whose options are shown, else the module of the current view. */
  activeId: string | undefined;
  /** The options panel of the active module is visible (aria-expanded on its button). */
  panelOpen?: boolean;
  /** Icon rail: names only as tooltips. */
  collapsed: boolean;
  onModule: (module: NavModule) => void;
  /** Packer module (/pakowanie), shown below the modules. */
  onWarehouse: () => void;
}) {
  const link = (key: string, label: string, icon: NavIcon, active: boolean, onClick: () => void, expandable = false) => {
    const Icon = icons[icon];
    return (
      <button
        key={key}
        type="button"
        className={'nav-link module-link' + (active ? ' active' : '')}
        aria-current={active ? 'page' : undefined}
        aria-expanded={expandable ? active && panelOpen : undefined}
        aria-label={collapsed ? label : undefined}
        data-tooltip={collapsed ? label : undefined}
        onClick={onClick}
      >
        <Icon size={18} aria-hidden="true" />
        <span className="module-link-label">{label}</span>
      </button>
    );
  };
  return (
    <nav className="module-menu" aria-label="Moduły">
      {modules.map((m) => link(m.id, m.label, m.icon, m.id === activeId, () => onModule(m), hasPanel(m)))}
      <div className="module-menu-separator" aria-hidden="true" />
      {link('warehouse', 'Moduł magazyniera', 'warehouse', false, onWarehouse)}
    </nav>
  );
}

export function ModuleOptionsPanel({
  module,
  view,
  onOption,
  onHide,
  children,
}: {
  module: NavModule;
  view: { page: RoutePage; path: string; order: boolean };
  onOption: (option: NavOption) => void;
  onHide: () => void;
  /** Custom content (the order status panel) instead of the option list. */
  children?: ReactNode;
}) {
  return (
    <aside className="module-panel" aria-label={'Opcje: ' + module.label}>
      <div className="module-panel-head">
        <strong>{module.label}</strong>
        <button type="button" className="module-panel-hide" onClick={onHide} title="Ukryj panel" aria-label="Ukryj panel">
          <ChevronsLeft size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="module-panel-body">
        {children ?? (
          <ul className="module-options">
            {module.options.map((o) => {
              const active = isOptionActive(o, view);
              return (
                <li key={o.key}>
                  <button
                    type="button"
                    className={'module-option' + (active ? ' selected' : '')}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onOption(o)}
                  >
                    {o.label}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** Counters and custom statuses for the Zamówienia panel; refetched with the app's refresh counter. */
export function useOrderStatusNav(refresh: number, enabled: boolean) {
  const [counts, setCounts] = useState<OrderStatusCounts | null>(null);
  const [workflows, setWorkflows] = useState<OrderWorkflowStatus[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    Promise.all([api<OrderStatusCounts>('/orders/status-counts'), api<{ data: OrderWorkflowStatus[] }>('/workflow-statuses')])
      .then(([c, w]) => {
        if (!live) return;
        setCounts(c);
        setWorkflows(w?.data ?? []);
        setError('');
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : 'Nie udało się pobrać liczników.');
      });
    return () => {
      live = false;
    };
  }, [refresh, enabled]);
  return { counts, workflows, error };
}

export function OrdersNavPanel({
  data,
  filter,
  onSelect,
  onManage,
}: {
  data: ReturnType<typeof useOrderStatusNav>;
  filter: OrderStatusFilter;
  onSelect: (filter: OrderStatusFilter) => void;
  onManage?: () => void;
}) {
  return (
    <OrderStatusPanel
      counts={data.counts}
      workflows={data.workflows}
      filter={filter}
      onSelect={onSelect}
      onManage={onManage}
      error={data.error}
    />
  );
}

export function NavBreadcrumb({ items }: { items: string[] }) {
  return (
    <nav className="nav-breadcrumb" aria-label="Ścieżka">
      <ol>
        {items.map((item, i) => (
          <li key={i} aria-current={i === items.length - 1 ? 'page' : undefined}>
            {item}
          </li>
        ))}
      </ol>
    </nav>
  );
}
