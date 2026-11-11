import { useState } from 'react';
import { orderCategoryLabels, workflowCategory, workflowNameParts, type OrderCategory } from '../shared/order-categories';
import { statusNames } from './api';
import {
  fulfilmentColors,
  isFulfilmentStage,
  legacyOrderStatusGroups,
  orderStatusGroups,
  panelLabel,
} from './order-stage';

export type OrderStatusCounts = {
  /** Per fulfilment stage; `ready_to_ship` is derived by the server and `packed` excludes it. Missing = 0. */
  statuses: Record<string, number>;
  workflow: Record<string, number>;
  total: number;
};
/** status: one status or a comma list (category); workflow: custom status id. Empty = all orders. */
export type OrderStatusFilter = { status: string; workflow: string };
/** Row of GET /api/workflow-statuses; category null/absent = the category of its stage. */
export type OrderWorkflowStatus = {
  id: string;
  name: string;
  color: string;
  active: boolean;
  stage: string;
  category?: string | null;
};
export const allOrders: OrderStatusFilter = { status: '', workflow: '' };

/** Panel label of a stage ("Nieopłacone" for code `new`), else the legacy name. */
export const orderStatusLabel = (s: string) => (isFulfilmentStage(s) ? panelLabel(s) : (statusNames[s] ?? s));

/** "1 pozycja", "3 pozycje", "12 pozycji". */
export function polishCount(n: number, one: string, few: string, many: string) {
  const tens = n % 100,
    ones = n % 10;
  return n + ' ' + (n === 1 ? one : ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? few : many);
}
export const ordersCountLabel = (n: number) => polishCount(n, 'zamówienie', 'zamówienia', 'zamówień');

/**
 * Custom statuses of one category as panel rows: a two-level name ("Pakowanie / Do zebrania DPD") goes under
 * its parent; a status named exactly like a parent ("Pakowanie") becomes that parent's own, selectable row.
 * Only active statuses; parents and statuses sorted by name.
 */
export type WorkflowPanelNode =
  | { kind: 'status'; status: OrderWorkflowStatus; label: string }
  | {
      kind: 'parent';
      name: string;
      self: OrderWorkflowStatus | null;
      children: Array<{ status: OrderWorkflowStatus; label: string }>;
    };
const byName = (a: string, b: string) => a.localeCompare(b, 'pl');
export function workflowPanelNodes(workflows: OrderWorkflowStatus[], category: OrderCategory): WorkflowPanelNode[] {
  const rows = workflows
    .filter((w) => w.active && workflowCategory(w) === category)
    .map((w) => ({ status: w, ...workflowNameParts(w.name) }));
  const parents = [...new Set(rows.flatMap((r) => (r.parent ? [r.parent] : [])))];
  const used = new Set<string>();
  const nodes: WorkflowPanelNode[] = parents.map((name) => {
    const self = rows.find((r) => !r.parent && r.leaf === name && !used.has(r.status.id))?.status ?? null;
    if (self) used.add(self.id);
    const children = rows
      .filter((r) => r.parent === name)
      .map((r) => ({ status: r.status, label: r.leaf }))
      .sort((a, b) => byName(a.label, b.label));
    return { kind: 'parent', name, self, children };
  });
  for (const r of rows)
    if (!r.parent && !used.has(r.status.id)) nodes.push({ kind: 'status', status: r.status, label: r.leaf });
  return nodes.sort((a, b) => byName(a.kind === 'parent' ? a.name : a.label, b.kind === 'parent' ? b.name : b.label));
}

/** Category selected by a filter; a single stage is the stage itself, even when its category has only that stage. */
const groupOf = (status: string) =>
  status.includes(',')
    ? (orderStatusGroups.find((g) => g.stages.join(',') === status) ??
      legacyOrderStatusGroups.find((g) => g.stages.join(',') === status))
    : undefined;
const groupOfStage = (stage: string) => orderStatusGroups.find((g) => (g.stages as string[]).includes(stage));

/** Heading of the list for the selected filter; count is null until counters load. */
export function orderStatusFilterSummary(
  filter: OrderStatusFilter,
  counts: OrderStatusCounts | null,
  workflows: OrderWorkflowStatus[],
): { title: string; count: number | null } {
  if (filter.workflow)
    return {
      title: workflows.find((w) => w.id === filter.workflow)?.name ?? 'Status własny',
      count: counts ? (counts.workflow[filter.workflow] ?? 0) : null,
    };
  if (!filter.status) return { title: 'Wszystkie zamówienia', count: counts?.total ?? null };
  const statuses = filter.status.split(',');
  const sum = counts ? statuses.reduce((s, x) => s + (counts.statuses[x] ?? 0), 0) : null;
  return {
    title: groupOf(filter.status)?.label ?? statuses.map(orderStatusLabel).join(', '),
    count: sum,
  };
}

/** Breadcrumb above the list: ["Zamówienia", "Nowe", "Nieopłacone"], ["Zamówienia", "W realizacji", "Pakowanie", "Do zebrania DPD"]. */
export function orderStatusBreadcrumb(filter: OrderStatusFilter, workflows: OrderWorkflowStatus[]): string[] {
  if (filter.workflow) {
    const w = workflows.find((x) => x.id === filter.workflow);
    if (!w) return ['Zamówienia', 'Status własny'];
    const { parent, leaf } = workflowNameParts(w.name);
    return ['Zamówienia', orderCategoryLabels[workflowCategory(w)], ...(parent ? [parent] : []), leaf];
  }
  if (!filter.status) return ['Zamówienia'];
  const group = groupOf(filter.status);
  if (group) return ['Zamówienia', group.label];
  if (!filter.status.includes(',')) {
    const parent = groupOfStage(filter.status);
    return ['Zamówienia', ...(parent ? [parent.label] : []), orderStatusLabel(filter.status)];
  }
  return ['Zamówienia', filter.status.split(',').map(orderStatusLabel).join(', ')];
}

export function OrderStatusPanel({
  counts,
  workflows,
  filter,
  onSelect,
  onManage,
  onAddStatus,
  error = '',
  disabled = false,
}: {
  counts: OrderStatusCounts | null;
  workflows: OrderWorkflowStatus[];
  filter: OrderStatusFilter;
  onSelect: (filter: OrderStatusFilter) => void;
  /** Present only for administrators: opens the custom status manager. */
  onManage?: () => void;
  /** "+ Dodaj status"; defaults to onManage (the manager has the add form). */
  onAddStatus?: () => void;
  error?: string;
  /** Pending list operations (merge, print, invoice) freeze the filter like the old selects. */
  disabled?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const n = (s: string) => counts?.statuses[s] ?? 0;
  const shown = (v: number) => (counts ? v : '…');
  const item = (
    key: string,
    label: string,
    count: number,
    next: OrderStatusFilter,
    dot?: { className?: string; color?: string },
  ) => {
    const selected = next.status === filter.status && next.workflow === filter.workflow;
    return (
      <li key={key}>
        <button
          type="button"
          className={'status-panel-item' + (selected ? ' selected' : '')}
          aria-current={selected ? 'true' : undefined}
          disabled={disabled}
          onClick={() => onSelect(next)}
        >
          {dot && (
            <span
              className={'status-dot ' + (dot.className ?? '')}
              style={dot.color ? { color: dot.color } : undefined}
              aria-hidden="true"
            />
          )}
          <span className="status-panel-label">{label}</span>
          <strong>{shown(count)}</strong>
        </button>
      </li>
    );
  };
  const toggle = (key: string, label: string) => {
    const closed = !!collapsed[key];
    return (
      <button
        type="button"
        className="status-panel-toggle"
        aria-expanded={!closed}
        aria-label={(closed ? 'Rozwiń: ' : 'Zwiń: ') + label}
        onClick={() => setCollapsed((c) => ({ ...c, [key]: !closed }))}
      >
        <span aria-hidden="true">{closed ? '▸' : '▾'}</span>
      </button>
    );
  };
  const wn = (id: string) => counts?.workflow[id] ?? 0;
  const custom = (w: OrderWorkflowStatus, label: string) =>
    item('w:' + w.id, label, wn(w.id), { status: '', workflow: w.id }, { color: w.color });
  /** Parent of two-level custom statuses: collapsible; selectable only when a status carries its exact name. */
  const parentRow = (category: string, node: Extract<WorkflowPanelNode, { kind: 'parent' }>) => {
    const key = 'p:' + category + ':' + node.name;
    const closed = !!collapsed[key];
    const self = node.self;
    const sum = node.children.reduce((s, c) => s + wn(c.status.id), self ? wn(self.id) : 0);
    const selected = !!self && !filter.status && filter.workflow === self.id;
    return (
      <li key={key}>
        <div className="status-panel-group-row">
          {toggle(key, node.name)}
          {self ? (
            <button
              type="button"
              className={'status-panel-item' + (selected ? ' selected' : '')}
              aria-current={selected ? 'true' : undefined}
              disabled={disabled}
              onClick={() => onSelect({ status: '', workflow: self.id })}
            >
              <span className="status-dot" style={{ color: self.color }} aria-hidden="true" />
              <span className="status-panel-label">{node.name}</span>
              <strong>{shown(sum)}</strong>
            </button>
          ) : (
            <button
              type="button"
              className="status-panel-parent"
              aria-expanded={!closed}
              onClick={() => setCollapsed((c) => ({ ...c, [key]: !closed }))}
            >
              <span className="status-panel-label">{node.name}</span>
              <strong>{shown(sum)}</strong>
            </button>
          )}
        </div>
        {!closed && <ul className="status-panel-children">{node.children.map((c) => custom(c.status, c.label))}</ul>}
      </li>
    );
  };
  const addStatus = onAddStatus ?? onManage;
  return (
    <nav className="order-status-panel" aria-label="Statusy zamówień">
      {error && (
        <p className="status-panel-error" role="alert">
          Nie udało się pobrać liczników: {error}
        </p>
      )}
      <ul className="status-panel-all">
        {item('all', 'Wszystkie zamówienia', counts?.total ?? 0, allOrders)}
      </ul>
      {orderStatusGroups.map((g) => {
        const status = g.stages.join(',');
        const selected = g.stages.length > 1 && filter.status === status && !filter.workflow;
        return (
          <section className="status-panel-group" key={g.key} aria-label={g.label}>
            <div className="status-panel-group-row">
              {toggle(g.key, g.label)}
              <button
                type="button"
                className={'status-panel-group-head' + (selected ? ' selected' : '')}
                aria-current={selected ? 'true' : undefined}
                disabled={disabled}
                onClick={() => onSelect({ status, workflow: '' })}
              >
                <span>{g.label}</span>
                <span>{shown(g.stages.reduce((sum, s) => sum + n(s), 0))}</span>
              </button>
            </div>
            {!collapsed[g.key] && (
              <ul>
                {g.stages.map((s) =>
                  item(s, panelLabel(s), n(s), { status: s, workflow: '' }, { color: fulfilmentColors[s] }),
                )}
                {workflowPanelNodes(workflows, g.key as OrderCategory).map((node) =>
                  node.kind === 'parent' ? parentRow(g.key, node) : custom(node.status, node.label),
                )}
              </ul>
            )}
          </section>
        );
      })}
      {addStatus && (
        <div className="status-panel-actions">
          <button type="button" className="status-panel-add" onClick={addStatus}>
            + Dodaj status
          </button>
          {onManage && (
            <button type="button" className="text-button" onClick={onManage}>
              Zarządzaj
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
