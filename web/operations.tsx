import {createAutomationCrudGuard,automationCrudKey,type RuleWriteAttempt} from './automation-crud-guard';
import {AutomaticEffects,LocalWooStockActionFields} from './automation-local-effects';
import {LocalAutomationWorkerControl} from './local-automation-worker-control';
import { DeferredOrderPanel } from './deferred-order-panel';
import { EmailActionFields, EmailActionReceipts } from './email-action';
import { SmsActionFields, OrderSmsHistory, SmsActionReceipts } from './sms-action';
import { useEffect, useRef, useState } from 'react';
import { Plus, X, Zap } from 'lucide-react';
import { api, date, statusNames, money } from './api';
import { ReconciliationQueue } from './reconciliation-queue';
import { CustomEventActionFields, CustomEventsPanel, useCustomEventTriggers } from './custom-events';
import { AutomationRulesV2 } from './automation-v2';
import { ORDER_CATEGORIES, isOrderCategory, orderCategoryLabels, workflowCategory, workflowNameParts } from '../shared/order-categories';
import { fulfilmentColors, statusPalette } from './order-stage';
import { composeWorkflowName, workflowNameError, workflowParentOptions } from './workflow-status-form';
const actionNames: Record<string, string> = {
  sms: 'Przygotuj wiadomość SMS',
  email: 'Przygotuj wiadomość email',
  add_note: 'Dodaj notatkę',
  add_tag: 'Dodaj tag',
  remove_tag: 'Usuń tag',
  set_status: 'Zmień etap',
  set_workflow: 'Ustaw własny status',
  sync_local_woo_stock: 'Synchronizuj stan lokalnego Woo',
  raise_event: 'Wywołaj zdarzenie własne',
};
const stateNames: Record<string, string> = {
  preview: 'Podgląd',
  queued: 'W kolejce',
  done: 'Wykonano',
  failed: 'Błąd',
  skipped: 'Pominięto',
  pending: 'Oczekuje',
  cancelled: 'Anulowano',
};
const triggerNames: Record<string, string> = {
  'order.created': 'Utworzono zamówienie',
  ...Object.fromEntries(
    Object.entries(statusNames).map(([id, name]) => ['order.' + id, 'Etap: ' + name]),
  ),
  'order.workflow_changed': 'Zmieniono własny status',
  'order.note_added': 'Dodano notatkę',
  'order.tags_changed': 'Zmieniono tagi',
  'return.photo_created': 'Wykonano zdjęcie produktów zwrotu',
};
const fieldNames: Record<string, string> = {
  total: 'Wartość zamówienia',
  item_count: 'Liczba sztuk',
  source: 'Źródło',
  status: 'Etap',
  country: 'Kraj',
  currency: 'Waluta',
  warehouse_id: 'Magazyn',
  workflow_status_id: 'Własny status',
  tag: 'Tag',
  sku: 'SKU',
};
const opNames: Record<string, string> = {
  eq: 'jest równe',
  neq: 'jest inne',
  gte: 'co najmniej',
  lte: 'co najwyżej',
  contains: 'zawiera',
  not_contains: 'nie zawiera',
};
function AutomationActionDetails({ definition, results }: { definition: any; results: any[] }) {
  const actions = Array.isArray(definition?.actions) && definition.actions.length === results.length
    ? definition.actions : null;
  const labels = results.map((result, index) => {
    if (result?.changed !== true) return null;
    const type = actions?.[index]?.type;
    const stage = Object.hasOwn(statusNames, result.status) ? statusNames[result.status] : null;
    if (type === 'set_status' && stage) return 'Zmieniono etap: ' + stage;
    if (type === 'set_workflow' && stage) return 'Ustawiono własny status (etap: ' + stage + ')';
    if (type === 'add_note') return 'Dodano notatkę';
    if (type === 'add_tag') return 'Dodano tag';
    if (type === 'remove_tag') return 'Usunięto tag';
    if (type === 'raise_event') return 'Wywołano zdarzenie własne';
    return 'Zapisano zmianę';
  });
  return labels.some(Boolean) ? <ol aria-label="Zapisane wyniki akcji">{labels.map((label, index) =>
    label ? <li key={index}>Akcja {index + 1}: {label}</li> : null,
  )}</ol> : null;
}
function useRemote(path: string, refresh = 0, pollEvery = 0) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function load() {
      api(path)
        .then((r) => {
          if (live) {
            setData(r);
            setError('');
          }
        })
        .catch((e) => live && setError(e.message))
        .finally(() => {
          if (live && pollEvery > 0) timer = setTimeout(load, pollEvery);
        });
    }
    load();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [path, refresh, pollEvery]);
  return { data, error };
}
const sourceNames: Record<string, string> = {
  manual: 'Ręczne',
  demo: 'Demo',
  allegro: 'Allegro',
  woocommerce: 'WooCommerce',
  prestashop: 'PrestaShop',
};
function operationError(s: string) {
  return s.replace(
    /\b(new|paid|picking|packed|shipped|delivered|completed|cancelled|return_initiated|return_received|return_completed)\b/g,
    (k) => statusNames[k] ?? k,
  );
}
function ErrorNotice({ error }: { error: string }) {
  return error ? (
    <p className="notice import-error" role="alert">
      {operationError(error)}
    </p>
  ) : null;
}
const initialAction = () => ({ type: 'add_note', note: '' }) as any;
function newAction(type: string) {
  return ['sms', 'email'].includes(type)
    ? { type, template_id: '', mode: 'local', client_key: crypto.randomUUID() }
    : type === 'add_note'
      ? { type, note: '' }
      : type === 'set_status'
        ? { type, status: 'paid' }
        : type === 'set_workflow'
          ? { type, status_id: '' }
          : type === 'raise_event'
            ? { type, event_key: '', client_key: crypto.randomUUID() }
            : { type, tag: '' };
}
function actionText(a: any, statuses: any[]) {
  if (a.type === 'sync_local_woo_stock') return 'Stan lokalnego Woo · ' + (a.listing_id ? 'wybrana oferta' : 'powiązane fizyczne pozycje zamówienia');
  if (a.type === 'email') return 'Email · ' + (a.mode === 'smtp' ? 'SMTP' : 'symulacja lokalna');
  if (a.type === 'raise_event') return actionNames.raise_event + ': custom.' + (a.event_key || '…');
  if (a.type === 'sms')
    return 'SMS · ' + (a.mode === 'provider_test' ? 'test SMSAPI' : 'symulacja lokalna');
  return (
    actionNames[a.type] +
    ': ' +
    (a.note ??
      a.tag ??
      statusNames[a.status] ??
      statuses.find((s) => s.id === a.status_id)?.name ??
      'Wybierz status')
  );
}
export function ActionEditor({
  value,
  onChange,
  statuses,
  versioned = false,
  localEffectsContext,
}: {
  versioned?: boolean;
  localEffectsContext?: string;
  value: any;
  onChange: (v: any) => void;
  statuses: any[];
}) {
  return (
    <div className="ops-action">
      <select
        aria-label="Rodzaj akcji"
        value={value.type}
        onChange={(e) => onChange(e.target.value==='sync_local_woo_stock'?{type:e.target.value,channel_id:'',warehouse_id:''}:e.target.value==='email'&&localEffectsContext?{...newAction('email'),mode:'smtp',confirm_external:false}:newAction(e.target.value))}
      >
        {Object.entries(actionNames).filter(([id])=>id!=='sync_local_woo_stock'||!!localEffectsContext||value.type===id).map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      {value.type === 'sync_local_woo_stock' ? (
        localEffectsContext ? <LocalWooStockActionFields contextKey={localEffectsContext} value={value} onChange={onChange}/> : <p>Ta akcja jest dostępna w automatyzacjach.</p>
      ) : value.type === 'email' ? (
        <EmailActionFields key={localEffectsContext??'manual'} value={value} onChange={onChange} versioned={versioned} localAutomaticContext={localEffectsContext} />
      ) : value.type === 'sms' ? (
        <SmsActionFields value={value} onChange={onChange} versioned={versioned} />
      ) : value.type === 'raise_event' ? (
        <CustomEventActionFields value={value} onChange={onChange} />
      ) : value.type === 'add_note' ? (
        <input
          aria-label="Treść notatki"
          placeholder="Treść notatki"
          maxLength={500}
          value={value.note}
          onChange={(e) => onChange({ ...value, note: e.target.value })}
        />
      ) : ['add_tag', 'remove_tag'].includes(value.type) ? (
        <input
          aria-label="Nazwa tagu"
          placeholder="Nazwa tagu"
          maxLength={40}
          value={value.tag}
          onChange={(e) => onChange({ ...value, tag: e.target.value })}
        />
      ) : value.type === 'set_status' ? (
        <select
          aria-label="Docelowy etap"
          value={value.status}
          onChange={(e) => onChange({ ...value, status: e.target.value })}
        >
          {Object.entries(statusNames).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      ) : (
        <select
          aria-label="Docelowy własny status"
          value={value.status_id}
          onChange={(e) =>
            onChange({
              ...value,
              status_id: e.target.value,
              ...(versioned
                ? { status_version: statuses.find((s) => s.id === e.target.value)?.version }
                : {}),
            })
          }
        >
          <option value="">Wybierz własny status</option>
          {statuses
            .filter((s) => s.active)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {statusNames[s.stage]}
              </option>
            ))}
        </select>
      )}
    </div>
  );
}
export function WorkflowBadge({ status }: { status: any }) {
  return status ? (
    <span className="workflow-badge" style={{ borderColor: status.color, color: status.color }}>
      {status.name}
      {!status.active ? ' · nieaktywny' : ''}
    </span>
  ) : null;
}
export function OrderOperationsPanel({
  order,
  write,
  onChanged,
}: {
  order: any;
  write: boolean;
  onChanged: () => void;
}) {
  const remote = useRemote('/workflow-statuses'),
    [action, setAction] = useState(initialAction),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [messagePreview, setMessagePreview] = useState<any>(null);
  useEffect(() => setMessagePreview(null), [JSON.stringify(action), order.version]);
  return (
    <section className="panel ops-panel">
      <div className="panel-heading">
        <div>
          <h2>Organizacja pracy</h2>
          <p>Własne statusy, tagi i notatki</p>
        </div>
      </div>
      <div className="ops-summary">
        <WorkflowBadge status={order.workflow_status} />
        {order.tags.map((t: string) => (
          <span className="tag-pill" key={t}>
            {t}
          </span>
        ))}
      </div>
      {write && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              if (['sms', 'email'].includes(action.type)) {
                setMessagePreview(
                  await api('/orders/' + order.id + '/operations/preview', 'POST', action),
                );
              } else await api('/orders/' + order.id + '/operations', 'POST', action);
              setError('');
              if (action.type === 'add_note') setAction(initialAction());
              if (!['sms', 'email'].includes(action.type)) onChanged();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <ActionEditor
            value={action}
            onChange={setAction}
            statuses={remote.data?.data ?? []}
            versioned
          />
          <ErrorNotice error={error || remote.error} />
          <button className="button primary" disabled={busy}>
            {busy
              ? 'Zapisywanie…'
              : ['sms', 'email'].includes(action.type)
                ? 'Podgląd akcji ' + (action.type === 'email' ? 'email' : 'SMS')
                : 'Zastosuj do zamówienia'}
          </button>
          {messagePreview && (
            <div className="sms-preview">
              <h3>Podgląd {action.type === 'email' ? 'email' : 'SMS'}</h3>
              {messagePreview.allowed ? (
                <>
                  <SmsActionReceipts actions={messagePreview.result} preview />
                  <EmailActionReceipts actions={messagePreview.result} preview />
                </>
              ) : (
                <p className="error">{messagePreview.error}</p>
              )}
              <button
                type="button"
                className="button primary"
                disabled={busy || !messagePreview.allowed}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api('/orders/' + order.id + '/operations', 'POST', {
                      ...messagePreview.actions[0],
                      confirmed: true,
                      order_version: messagePreview.order_version,
                    });
                    setMessagePreview(null);
                    setAction({ ...action, client_key: crypto.randomUUID() });
                    setError('');
                    onChanged();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Zatwierdź{' '}
                {action.type === 'email'
                  ? action.mode === 'smtp'
                    ? 'email SMTP'
                    : 'symulację email'
                  : action.mode === 'provider_test'
                    ? 'test SMSAPI'
                    : 'symulację SMS'}
              </button>
            </div>
          )}
        </form>
      )}
      <DeferredOrderPanel key={order.id} title="Wiadomości SMS zamówienia"><OrderSmsHistory orderId={order.id} /></DeferredOrderPanel>
    </section>
  );
}
export function BulkOperations({
  selected,
  onChanged,
  refresh,
  fixedAction,
}: {
  selected: string[];
  onChanged: () => void;
  refresh: number;
  /** Entry from the list's bulk bar: the action type is fixed (status chosen in the bar, note typed here). */
  fixedAction?: any;
}) {
  const statuses = useRemote('/workflow-statuses', refresh),
    [action, setAction] = useState(() => fixedAction ?? initialAction()),
    [plan, setPlan] = useState<any>(null),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [historyCursor, setHistoryCursor] = useState(''),
    [historyRefresh, setHistoryRefresh] = useState(0);
  const history = useRemote(
    '/order-batches?' + new URLSearchParams(historyCursor ? { after: historyCursor } : {}),
    refresh + historyRefresh,
  );
  useEffect(() => {
    if (plan?.state === 'preview') {
      setPlan(null);
      setConfirm(false);
    }
  }, [selected.join(','), JSON.stringify(action)]);
  useEffect(() => {
    if (plan?.state !== 'queued') return;
    let live = true;
    const timer = setInterval(
      () =>
        api('/order-batches/' + plan.id)
          .then((p) => {
            if (live) {
              setPlan(p);
              if (p.state !== 'queued') {
                onChanged();
                setHistoryRefresh((n) => n + 1);
              }
            }
          })
          .catch((e) => live && setError(e.message)),
      1500,
    );
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [plan?.id, plan?.state]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ops-panel bulk-operations">
      <div className="panel-heading">
        <div>
          <h2>{fixedAction ? actionNames[fixedAction.type] : 'Operacje masowe'}</h2>
          <p>Zaznaczono {selected.length} zamówień · podgląd ważny 30 minut</p>
        </div>
      </div>
      {!fixedAction ? (
        <ActionEditor
          value={action}
          onChange={setAction}
          statuses={statuses.data?.data ?? []}
          versioned
        />
      ) : action.type === 'add_note' ? (
        <div className="ops-action">
          <input
            aria-label="Treść notatki"
            placeholder="Treść notatki"
            maxLength={500}
            value={action.note}
            onChange={(e) => setAction({ ...action, note: e.target.value })}
          />
        </div>
      ) : (
        <p>{actionText(action, statuses.data?.data ?? [])}</p>
      )}
      <ErrorNotice error={error || statuses.error || history.error} />
      <button
        className="button"
        disabled={busy || !selected.length || plan?.state === 'queued' || (fixedAction && action.type === 'add_note' && !action.note.trim())}
        onClick={() =>
          run(async () => {
            const p = await api('/orders/batches/preview', 'POST', { order_ids: selected, action });
            setPlan(p);
            setConfirm(false);
            setHistoryRefresh((n) => n + 1);
          })
        }
      >
        Sprawdź wybrane zamówienia
      </button>
      {plan && (
        <div className="ops-result">
          <h3>
            {stateNames[plan.state]} · {plan.items.filter((i: any) => i.state === 'done').length}{' '}
            wykonanych / {plan.items.length}
          </h3>
          <p>{actionText(plan.action ?? action, statuses.data?.data ?? [])}</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Zamówienie</th>
                  <th>Wynik</th>
                  <th>Powód</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((i: any) => (
                  <tr key={i.order_id}>
                    <td>{i.number}</td>
                    <td>
                      {plan.state === 'preview'
                        ? (i.allowed ?? i.preview?.allowed)
                          ? 'Można wykonać'
                          : 'Pominięcie'
                        : (stateNames[i.state] ?? 'Oczekuje')}
                    </td>
                    <td>
                      {operationError(
                        i.error ?? (plan.state === 'preview' ? i.preview?.error : null) ?? '—',
                      )}
                      <SmsActionReceipts
                        actions={
                          plan.state === 'preview'
                            ? (i.result ?? i.preview?.result)
                            : [i.result ?? {}]
                        }
                        preview={plan.state === 'preview'}
                      />
                      <EmailActionReceipts
                        actions={
                          plan.state === 'preview'
                            ? (i.result ?? i.preview?.result)
                            : [i.result ?? {}]
                        }
                        preview={plan.state === 'preview'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.job_error && <ErrorNotice error={plan.job_error} />}{' '}
          {plan.state === 'preview' && (
            <>
              <label className="ops-confirm">
                <input
                  type="checkbox"
                  checked={confirm}
                  onChange={(e) => setConfirm(e.target.checked)}
                />
                Potwierdzam akcję dla zamówień, które przeszły podgląd. Zmienione zamówienia zostaną
                pominięte.
              </label>
              <button
                className="button primary"
                disabled={
                  busy || !confirm || !plan.items.some((i: any) => i.allowed ?? i.preview?.allowed)
                }
                onClick={() =>
                  run(async () => {
                    await api('/order-batches/' + plan.id + '/queue', 'POST', { confirmed: true });
                    setPlan(await api('/order-batches/' + plan.id));
                  })
                }
              >
                Uruchom operację masową
              </button>
            </>
          )}
        </div>
      )}
      <details className="ops-history">
        <summary>Historia operacji masowych</summary>
        {history.data?.data.map((b: any) => (
          <button
            key={b.id}
            className="button small-btn"
            onClick={() =>
              run(async () => {
                setPlan(await api('/order-batches/' + b.id));
                setConfirm(false);
              })
            }
          >
            {date(b.created_at)} · {stateNames[b.state]} · {actionNames[b.action.type]}
          </button>
        ))}
        {historyCursor && (
          <button className="button" onClick={() => setHistoryCursor('')}>
            Najnowsze
          </button>
        )}
        {history.data?.meta.cursor && (
          <button className="button" onClick={() => setHistoryCursor(history.data.meta.cursor)}>
            Starsze operacje
          </button>
        )}
      </details>
    </section>
  );
}
function StatusManager({
  admin,
  readOnly = false,
  refresh,
  onChanged,
}: {
  admin: boolean;
  readOnly?: boolean;
  refresh: number;
  onChanged: () => void;
}) {
  const { data, error } = useRemote('/workflow-statuses', refresh),
    [draft, setDraft] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState('');
  const writeAccess = useRef(false);
  writeAccess.current = admin && !readOnly;
  useEffect(() => { if (!admin || readOnly) setDraft(null); }, [admin, readOnly]);
  // Category shown in the form: the one picked, else the category of the chosen stage (null is saved as "follow the stage").
  const draftCategory = draft ? workflowCategory(draft) : 'other';
  const parents = draft ? workflowParentOptions(data?.data ?? [], draftCategory, draft.id) : [];
  if (draft?.parent && !parents.includes(draft.parent)) parents.unshift(draft.parent);
  const nameError = draft ? workflowNameError(draft.parent ?? '', draft.name) : '';
  const sameColor = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const swatches = draft
    ? [
        ...statusPalette,
        ...(statusPalette.some((p) => sameColor(p.color, draft.color))
          ? []
          : [{ color: draft.color, label: 'Własny kolor (' + draft.color + ')' }]),
      ]
    : [];
  return (
    <section className="panel ops-panel">
      <div className="panel-heading">
        <div>
          <h2>Własne statusy</h2>
          <p>
            Każdy status należy do etapu realizacji i do jednej z kategorii panelu zamówień. Zmiana etapu
            zachowuje kontrole magazynu i wysyłki.
          </p>
        </div>
        {admin && (
          <button
            className="button"
            disabled={busy || readOnly}
            onClick={() => {
              if (writeAccess.current)
                setDraft({ name: '', parent: '', color: fulfilmentColors.paid, stage: 'paid', category: null, active: true });
            }}
          >
            <Plus size={16} />
            Dodaj status
          </button>
        )}
      </div>
      <ErrorNotice error={error || failure} />
      <div className="ops-summary">
        {data?.data.map((s: any) => (
          <button
            className="workflow-choice"
            key={s.id}
            disabled={!admin || readOnly || busy}
            onClick={() => {
              if (!writeAccess.current) return;
              const { parent, leaf } = workflowNameParts(s.name);
              setDraft({ ...s, name: leaf, parent: parent ?? '' });
              setFailure('');
            }}
          >
            <WorkflowBadge status={s} />
            <small>
              {statusNames[s.stage] ?? s.stage} · {orderCategoryLabels[workflowCategory(s)]}
            </small>
          </button>
        ))}
      </div>
      {draft && admin && !readOnly && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!writeAccess.current) return;
            if (nameError) {
              setFailure(nameError);
              return;
            }
            const { parent, category, ...rest } = draft;
            const body = {
              ...rest,
              name: composeWorkflowName(parent ?? '', draft.name),
              ...(isOrderCategory(category) ? { category } : {}),
            };
            setBusy(true);
            try {
              await api(
                '/workflow-statuses' + (draft.id ? '/' + draft.id : ''),
                draft.id ? 'PATCH' : 'POST',
                body,
              );
              setDraft(null);
              setFailure('');
              onChanged();
            } catch (e) {
              setFailure((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <label>
              Nazwa
              <input
                required
                minLength={2}
                maxLength={80}
                value={draft.name}
                aria-invalid={nameError ? true : undefined}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              Etap
              <select
                value={draft.stage}
                onChange={(e) => setDraft({ ...draft, stage: e.target.value })}
              >
                {Object.entries(statusNames).map(([id, n]) => (
                  <option key={id} value={id}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Kategoria
              <select value={draftCategory} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                {ORDER_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {orderCategoryLabels[c]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Status nadrzędny
              <select value={draft.parent ?? ''} onChange={(e) => setDraft({ ...draft, parent: e.target.value })}>
                <option value="">— brak —</option>
                {parents.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="status-palette">
              <legend>Kolor</legend>
              {swatches.map((p) => {
                const on = sameColor(p.color, draft.color);
                return (
                  <label key={p.color} className={'status-swatch' + (on ? ' selected' : '')}>
                    <input
                      type="radio"
                      name="workflow-status-color"
                      value={p.color}
                      checked={on}
                      onChange={() => setDraft({ ...draft, color: p.color })}
                    />
                    <span className="status-swatch-dot" style={{ background: p.color }} aria-hidden="true" />
                    {p.label}
                  </label>
                );
              })}
            </fieldset>
            <label>
              Aktywny
              <input
                type="checkbox"
                checked={draft.active}
                onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
              />
            </label>
          </div>
          {nameError && (
            <p className="error" role="alert">
              {nameError}
            </p>
          )}
          <button className="button primary" disabled={busy || !!nameError}>
            Zapisz status
          </button>
          <button className="button" type="button" onClick={() => setDraft(null)}>
            Zamknij
          </button>
        </form>
      )}
    </section>
  );
}
export function ConditionEditor({
  totalLabel = 'PLN',
  value,
  onChange,
  statuses,
  warehouses,
}: {
  totalLabel?: string;
  value: any;
  onChange: (v: any) => void;
  statuses: any[];
  warehouses: any[];
}) {
  const numeric = ['total', 'item_count'].includes(value.field),
    array = ['tag', 'sku'].includes(value.field),
    ops = numeric ? ['gte', 'lte', 'eq'] : array ? ['contains', 'not_contains'] : ['eq', 'neq'];
  const options =
    value.field === 'status'
      ? Object.entries(statusNames).map(([id, name]) => ({ id, name }))
      : value.field === 'workflow_status_id'
        ? statuses
        : value.field === 'warehouse_id'
          ? warehouses
          : value.field === 'source'
            ? ['manual', 'demo', 'allegro', 'woocommerce', 'prestashop'].map((id) => ({
                id,
                name: sourceNames[id] ?? id,
              }))
            : null;
  return (
    <div className="ops-condition">
      <select
        aria-label="Pole warunku"
        value={value.field}
        onChange={(e) => {
          const field = e.target.value;
          onChange({
            field,
            op: ['total', 'item_count'].includes(field)
              ? 'gte'
              : ['tag', 'sku'].includes(field)
                ? 'contains'
                : 'eq',
            value: ['total', 'item_count'].includes(field)
              ? 0
              : field === 'status'
                ? 'paid'
                : field === 'country'
                  ? 'PL'
                  : field === 'currency'
                    ? 'PLN'
                    : field === 'source'
                      ? 'manual'
                      : '',
          });
        }}
      >
        {Object.entries(fieldNames).map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      <select
        aria-label="Operator warunku"
        value={value.op}
        onChange={(e) => onChange({ ...value, op: e.target.value })}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {opNames[op]}
          </option>
        ))}
      </select>
      {options ? (
        <select
          aria-label="Wartość warunku"
          value={value.value}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        >
          <option value="">Wybierz</option>
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={
            value.field === 'total' ? 'Wartość warunku w ' + totalLabel : 'Wartość warunku'
          }
          placeholder={value.field === 'total' ? totalLabel : 'Wartość'}
          type={numeric ? 'number' : 'text'}
          min={numeric ? 0 : undefined}
          step={value.field === 'total' ? '0.01' : 1}
          value={value.field === 'total' ? value.value / 100 : value.value}
          onChange={(e) =>
            onChange({
              ...value,
              value: numeric
                ? Math.round(Number(e.target.value) * (value.field === 'total' ? 100 : 1))
                : e.target.value,
            })
          }
        />
      )}
    </div>
  );
}
export function PreviewChain({
  chain,
  definition,
  statuses,
  warehouses,
}: {
  chain: any;
  definition: any;
  statuses: any[];
  warehouses: any[];
}) {
  const mark = (v: boolean) => (v ? '✓ ' : '✗ ');
  return (
    <div className="automation-chain" aria-label="Łańcuch reguły">
      <h3>Łańcuch reguły</h3>
      <ol>
        <li>
          Zdarzenie: {triggerNames[chain.trigger] ?? chain.trigger}
          {chain.delay_seconds ? ' · opóźnienie ' + chain.delay_seconds + ' s' : ' · bez opóźnienia'}
        </li>
        <li>
          {mark(chain.matched)}Warunki ({chain.match === 'any' ? 'dowolny' : 'wszystkie'}):
          {!chain.conditions.length && ' brak — każde zdarzenie'}
          <ul>
            {chain.conditions.map((c: any, i: number) => (
              <li key={i}>
                {c.group ? (
                  <>
                    {mark(c.group.matched)}
                    {groupLabel(c.group.match)}:
                    <ul>
                      {c.group.conditions.map((l: any, k: number) => (
                        <li key={k}>{mark(l.matched) + conditionLabel(l, statuses, warehouses)}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  mark(c.matched) + conditionLabel(c, statuses, warehouses)
                )}
              </li>
            ))}
          </ul>
        </li>
        <li>
          Akcje:
          <ol>
            {chain.actions.map((a: any, i: number) => (
              <li key={i}>
                {definition?.actions?.[i] ? actionText(definition.actions[i], statuses) : a.type}
                {!a.emits.length && ' · bez kolejnego zdarzenia'}
                {a.emits.map((e: any) => (
                  <div key={e.trigger}>
                    → {triggerNames[e.trigger] ?? e.trigger}:{' '}
                    {e.rules.length
                      ? e.rules
                          .map(
                            (d: any) =>
                              (d.estimate ? '✓ ' : '✗ ') +
                              d.name +
                              ' (priorytet ' +
                              d.priority +
                              (d.delay_seconds ? ', opóźnienie ' + d.delay_seconds + ' s' : '') +
                              ')',
                          )
                          .join(' · ')
                      : 'brak zależnych reguł'}
                    {e.skips_self && ' · ta reguła nie uruchomi się ponownie w łańcuchu'}
                  </div>
                ))}
              </li>
            ))}
          </ol>
        </li>
      </ol>
      <p>
        Zależne reguły sprawdzają warunki na danych swojego zdarzenia; ✓/✗ przy nich to szacunek
        na bieżącym zamówieniu. Łańcuch zatrzymuje się po {chain.depth_limit} zdarzeniach i nie
        powtarza reguły.
      </p>
    </div>
  );
}
const newLeaf = () => ({ field: 'source', op: 'eq', value: 'manual' });
const leafCount = (conditions: any[]) =>
  conditions.reduce((n, c) => n + (c.group ? c.group.conditions.length : 1), 0);
function conditionLabel(c: any, statuses: any[], warehouses: any[]) {
  return (
    fieldNames[c.field] +
    ' ' +
    opNames[c.op] +
    ' ' +
    (c.field === 'total'
      ? money(c.value)
      : (sourceNames[c.value] ??
        statusNames[c.value] ??
        statuses.find((s: any) => s.id === c.value)?.name ??
        warehouses.find((s: any) => s.id === c.value)?.name ??
        c.value))
  );
}
const groupLabel = (match: string) => (match === 'any' ? 'Dowolny z' : 'Wszystkie z');
const groupBox = {
  border: '1px solid #dce3f4',
  borderLeft: '3px solid #9db0dc',
  borderRadius: 8,
  padding: '4px 12px 12px',
  margin: '12px 0',
  minWidth: 0,
};
const emptyRule = () =>
  ({
    name: '',
    trigger: 'order.paid',
    priority: 50,
    delay_seconds: 0,
    match: 'all',
    enabled: true,
    conditions: [],
    actions: [initialAction()],
  }) as any;
function isCustomerMessageWorkflow(r: any) {
  return r.trigger === 'customer_message.received' || r.definition?.trigger === 'customer_message.received';
}
const workerStepStates: Record<string, string> = {
  idle: 'Jeszcze nie uruchomiony',
  running: 'W toku',
  ok: 'Działa',
  backoff: 'Błąd · ponowienie z opóźnieniem',
  paused: 'Wstrzymany',
  timeout: 'Przekroczony limit czasu · nadal działa',
};
const workerLaneNames: Record<string, string> = { main: 'Harmonogramy', jobs: 'Kolejka zadań' };
const clock = (s: string | null | undefined) => (s ? new Date(s).toLocaleTimeString('pl-PL') : '—');
const STALE_HEARTBEAT_MS = 30_000;
const waited = (s: number) =>
  s < 120 ? s + ' s' : s < 7200 ? Math.round(s / 60) + ' min' : s < 172_800 ? Math.round(s / 3600) + ' h' : Math.round(s / 86_400) + ' d';
/** Global loop heartbeat, per-scheduler state with pause/resume, and this workspace's job queue. */
export function WorkerSupervision({ refresh, readOnly, notify }: { refresh: number; readOnly: boolean; notify: (s: string, error?: boolean) => void }) {
  const [local, setLocal] = useState(0),
    [busy, setBusy] = useState('');
  const view = useRemote('/operations/workers', refresh + local, 10_000);
  const d = view.data;
  const runtime = d?.runtime && Array.isArray(d.runtime.steps) ? d.runtime : null;
  const kinds: any[] = Array.isArray(d?.queue?.kinds) ? d.queue.kinds : [];
  const lanes: any[] = runtime && Array.isArray(runtime.lanes) ? runtime.lanes : [];
  const age = (s: string | null | undefined) => (s ? Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 1000)) : null);
  const stale = lanes.filter((l) => (age(l.heartbeat_at) ?? 0) * 1000 > STALE_HEARTBEAT_MS);
  // Pause/resume acts on every workspace of the installation: only its operator gets the buttons (SR4-H1).
  const control = d?.scheduler_control === true;
  async function toggle(name: string, paused: boolean) {
    setBusy(name);
    try {
      await api('/operations/workers/schedulers/' + encodeURIComponent(name) + (paused ? '/resume' : '/pause'), 'POST', {});
      notify(paused ? 'Scheduler wznowiony' : 'Scheduler wstrzymany do restartu procesu');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Nie udało się zmienić stanu schedulera', true);
    } finally {
      setBusy('');
      setLocal((n) => n + 1);
    }
  }
  async function processor(action: 'start' | 'stop') {
    setBusy('scoped-processor');
    try {
      await api('/operations/workers/scoped-processor/' + action, 'POST', {});
      notify(action === 'start' ? 'Procesor reguł uruchomiony dla tej firmy do restartu procesu' : 'Procesor reguł zatrzymany; trwające zadanie zostało dokończone');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Nie udało się zmienić stanu procesora', true);
    } finally {
      setBusy('');
      setLocal((n) => n + 1);
    }
  }
  return (
    <section className="panel ops-panel worker-supervision" aria-label="Nadzór workerów">
      <div className="panel-heading">
        <div>
          <h2>Nadzór workerów</h2>
          <p>Heartbeat pętli w tle, stan każdego schedulera i kolejka zadań tej firmy · odświeżanie co 10 s</p>
        </div>
        <button className="button" onClick={() => setLocal((n) => n + 1)}>
          Odśwież
        </button>
      </div>
      <ErrorNotice error={view.error} />
      {d && !runtime && (
        <p className="notice" role="status">
          {d.not_started_reason ?? 'Stan workera niepotwierdzony.'}
        </p>
      )}
      {runtime && (
        <div className="notice" role="status">
          <div>
            <strong>
              {runtime.state === 'STOPPING' ? 'Pętla się zatrzymuje' : 'Pętla działa'} od {clock(runtime.started_at)} · co {Math.round(runtime.interval_ms / 1000)} s
            </strong>
            {lanes.map((l) => (
              <div key={l.lane} data-lane={l.lane}>
                {workerLaneNames[l.lane] ?? l.lane}: heartbeat {clock(l.heartbeat_at)} · cykli {l.cycles}
                {l.cycle_running ? ' · cykl w toku od ' + (age(l.last_cycle_started_at) ?? 0) + ' s' : ''}
              </div>
            ))}
          </div>
        </div>
      )}
      {stale.map((l) => (
        <p key={l.lane} className="notice import-error" role="alert">
          {workerLaneNames[l.lane] ?? l.lane}: brak heartbeat od {age(l.heartbeat_at)} s. Trwa długie zadanie albo pętla stanęła; sprawdź log serwera.
        </p>
      ))}
      {d?.scoped_processor?.message && (
        <div className="notice" aria-label="Procesor reguł automatycznych">
          <div>
            <strong>Procesor reguł automatycznych · Stan: {d.scoped_processor.running ? 'działa' : 'zatrzymany'}</strong>
            <div>{d.scoped_processor.message}</div>
          </div>
          {d.scoped_processor.can_control && (
            <button
              className="button small-btn"
              disabled={readOnly || !!busy}
              onClick={() => void processor(d.scoped_processor.running ? 'stop' : 'start')}
            >
              {d.scoped_processor.running ? 'Zatrzymaj procesor' : 'Uruchom procesor dla tej firmy'}
            </button>
          )}
        </div>
      )}
      {runtime && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Scheduler</th>
                <th>Stan</th>
                <th>Ostatnie uruchomienie</th>
                <th>Błędy</th>
                <th>Następne</th>
                {control && <th>Akcja</th>}
              </tr>
            </thead>
            <tbody>
              {runtime.steps.map((s: any) => (
                <tr key={s.name} data-scheduler={s.name}>
                  <td>
                    <strong>{s.label}</strong>
                    <small>{s.name}</small>
                  </td>
                  <td>
                    {workerStepStates[s.state] ?? s.state}
                    {(s.state === 'running' || s.state === 'timeout') && <small>od {age(s.last_started_at)} s</small>}
                    {s.timeout_ms > 0 && <small>limit {Math.round(s.timeout_ms / 1000)} s</small>}
                  </td>
                  <td>
                    {clock(s.last_finished_at)}
                    <small>
                      sukces {clock(s.last_success_at)}
                      {s.last_duration_ms !== null ? ' · ' + s.last_duration_ms + ' ms' : ''}
                    </small>
                  </td>
                  <td>
                    {s.consecutive_failures ? s.consecutive_failures + ' pod rząd · ' : ''}
                    {s.failures} łącznie
                    {s.last_error && (
                      <small>
                        {clock(s.last_error.at)}: {s.last_error.message}
                      </small>
                    )}
                  </td>
                  <td>{s.paused ? 'po wznowieniu' : clock(s.next_run_at)}</td>
                  {control && (
                    <td>
                      <button
                        className="button small-btn"
                        disabled={readOnly || !!busy || runtime.state !== 'RUNNING'}
                        onClick={() => void toggle(s.name, s.paused)}
                      >
                        {s.paused ? 'Wznów' : 'Wstrzymaj'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runtime && control && <p className="muted">Pauza działa do restartu procesu i obejmuje wszystkie firmy tej instalacji. Każda zmiana trafia do dziennika zdarzeń.</p>}
      {runtime && !control && d?.installation_operator !== true && (
        <p className="muted">
          {d?.scheduler_control_rule ?? 'Wstrzymanie schedulera może wykonać tylko operator instalacji.'} Szczegóły błędów widzi operator instalacji.
        </p>
      )}
      <h3>Kolejka zadań tej firmy</h3>
      {d && !kinds.length && <p className="muted">Brak oczekujących, trwających i nieudanych zadań.</p>}
      {kinds.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Rodzaj</th>
                <th>Do wykonania</th>
                <th>Najstarsze zaległe</th>
                <th>Ponowienia</th>
                <th>W toku</th>
                <th>Nieudane</th>
                <th>Ostatni błąd</th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((k) => (
                <tr key={k.kind}>
                  <td>{k.kind}</td>
                  <td>
                    {k.due} / {k.pending}
                    {k.provider_wait_until && <small>limit dostawcy do {clock(k.provider_wait_until)}</small>}
                  </td>
                  <td>{k.oldest_due_age_s === null ? '—' : waited(k.oldest_due_age_s)}</td>
                  <td>{k.retrying}</td>
                  <td>
                    {k.running}
                    {k.stale_running > 0 && <small>{k.stale_running} z wygasłą dzierżawą</small>}
                  </td>
                  <td>{k.failed}</td>
                  <td>{k.last_error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d?.replay_rule && <p className="muted">Zasada ponowień: {d.replay_rule}</p>}
    </section>
  );
}
/** Automatyzacje: rules v2 (default) and the legacy v1 studio as "Reguły (starsze)". */
export function AutomationStudio(props: Parameters<typeof LegacyAutomationStudio>[0] & { automationEditor?: boolean }) {
  const [view, setView] = useState<'v2' | 'legacy'>('v2');
  return (
    <>
      {/* Custom statuses serve both rule kinds and are where „+ Dodaj status” / „Zarządzaj” in the order panel lead. */}
      <StatusManager admin={props.admin} readOnly={props.readOnly} refresh={props.refresh} onChanged={props.reload} />
      <div className="av2-tabs av2-studio-tabs" role="tablist" aria-label="Rodzaj reguł">
        <button type="button" role="tab" className="button small-btn" aria-selected={view === 'v2'} onClick={() => setView('v2')}>Reguły</button>
        <button type="button" role="tab" className="button small-btn" aria-selected={view === 'legacy'} onClick={() => setView('legacy')}>Reguły (starsze)</button>
      </div>
      {view === 'v2'
        ? <AutomationRulesV2 admin={props.admin} editor={props.automationEditor} readOnly={props.readOnly} refresh={props.refresh} notify={props.notify} />
        : <LegacyAutomationStudio {...props} />}
    </>
  );
}
export function LegacyAutomationStudio({
  workerContextKey,
  admin,
  readOnly = false,
  refresh,
  reload,
  notify,
}: {
  workerContextKey?: string;
  admin: boolean;
  readOnly?: boolean;
  refresh: number;
  reload: () => void;
  notify: (s: string, error?: boolean) => void;
}) {
  const writeAccess = useRef(false);
  writeAccess.current = admin && !readOnly;
  const crudAlive=useRef(true),crudRef=useRef<{context:string;guard:ReturnType<typeof createAutomationCrudGuard>}|null>(null),crudFlight=useRef(false);
  const [crudView,setCrudView]=useState<{context:string;attempt:RuleWriteAttempt|null;candidates:string[];error:string}|null>(null);
  if(workerContextKey&&crudRef.current?.context!==workerContextKey){
    let guard:ReturnType<typeof createAutomationCrudGuard>;
    guard=createAutomationCrudGuard({context:workerContextKey,request:api,read:k=>localStorage.getItem(k),write:(k,v)=>localStorage.setItem(k,v),newId:()=>crypto.randomUUID(),current:()=>crudAlive.current&&writeAccess.current&&crudRef.current?.guard===guard,
      lock:async(key,fn)=>{if(!navigator.locks?.request)throw Error('Przeglądarka nie zapewnia blokady kart. Zapis reguły niedostępny.');return navigator.locks.request(key,{mode:'exclusive'},fn);}});
    crudRef.current={context:workerContextKey,guard};
  }else if(!workerContextKey)crudRef.current=null;
  const crud=crudRef.current&&crudRef.current.context===workerContextKey?crudRef.current.guard:null;
  const visibleCrud=crudView?.context===workerContextKey?crudView:null;
  const crudBlocked=!crud||!visibleCrud||!!visibleCrud.error||!!visibleCrud.attempt&&!['confirmed','refused'].includes(visibleCrud.attempt.phase);
  useEffect(()=>{crudAlive.current=true;return()=>{crudAlive.current=false;};},[]);
  useEffect(()=>{
    const capture=()=>{if(!crud||!workerContextKey)return;try{setCrudView({context:workerContextKey,attempt:crud.inspect(),candidates:[],error:''});}catch(e){setCrudView({context:workerContextKey,attempt:null,candidates:[],error:e instanceof Error?e.message:'Nie można odczytać próby reguły.'});}};
    capture();const changed=(e:StorageEvent)=>{if(e.key===automationCrudKey(workerContextKey??''))capture();};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);
  },[crud,workerContextKey]);
  const customTriggers = useCustomEventTriggers(refresh),
    allTriggers = { ...triggerNames, ...customTriggers };
  const rules = useRemote('/automations', refresh),
    statuses = useRemote('/workflow-statuses', refresh),
    settings = useRemote('/settings', refresh),
    orders = useRemote('/orders?limit=50', refresh),
    [runCursor, setRunCursor] = useState(''),
    [localRefresh, setLocalRefresh] = useState(0),
    [draft, setDraft] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [testRule, setTestRule] = useState<any>(null),
    [orderId, setOrderId] = useState(''),
    [result, setResult] = useState<any>(null);
  const runs = useRemote(
    '/automation-runs?' + new URLSearchParams(runCursor ? { after: runCursor } : {}),
    refresh + localRefresh,
    5000,
  );
  useEffect(() => {
    if (!admin || readOnly) { setDraft(null); setTestRule(null); setResult(null); }
  }, [admin, readOnly,workerContextKey]);
  useEffect(()=>{setDraft(null);setTestRule(null);setResult(null);setError('');},[workerContextKey]);
  async function mutateRule(payload:any){
    if(!crud||!workerContextKey||crudFlight.current||!writeAccess.current)return;
    crudFlight.current=true;setBusy(true);setError('');
    const guard=crud,context=workerContextKey;
    try{
      const result=await guard.submit(structuredClone(payload));
      if(crudAlive.current&&crudRef.current?.guard===guard){
        setCrudView({context,attempt:result.attempt,candidates:result.candidate_ids,error:''});
        if(result.confirmed){setDraft(null);reload();notify('Zapis reguły potwierdzony odczytem.');}
        else setError('Wynik zapisu wymaga odczytu. Nie ponawiaj zapisu.');
      }
    }catch(e){if(crudAlive.current&&crudRef.current?.guard===guard){setError(e instanceof Error?e.message:'Niepotwierdzony zapis reguły.');try{setCrudView({context,attempt:guard.inspect(),candidates:[],error:''});}catch{setCrudView({context,attempt:null,candidates:[],error:'Nie można odczytać trwałej próby reguły. Zapis zablokowany.'});}}}
    finally{crudFlight.current=false;if(crudAlive.current)setBusy(false);}
  }
  async function reconcileRule(){
    if(!crud||!workerContextKey||crudFlight.current||!writeAccess.current)return;
    crudFlight.current=true;setBusy(true);setError('');const guard=crud,context=workerContextKey;
    try{const result=await guard.reconcile();if(crudAlive.current&&crudRef.current?.guard===guard){setCrudView({context,attempt:result.attempt,candidates:result.candidate_ids,error:''});if(result.confirmed){setDraft(null);reload();notify('Bieżący stan reguły potwierdzony.');}}}
    catch(e){if(crudAlive.current&&crudRef.current?.guard===guard)setError(e instanceof Error?e.message:'Nie potwierdzono odczytu reguły.');}
    finally{crudFlight.current=false;if(crudAlive.current)setBusy(false);}
  }
  async function run(fn: () => Promise<void>) {
    if (!writeAccess.current) { setError('Tryb tylko do odczytu. Reguły i historia pozostają dostępne.'); return; }
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {readOnly && <p className="notice" role="status">Kopia odtworzona · tylko odczyt. Reguły i historia są dostępne; zapis i sprawdzanie reguły są wyłączone.</p>}
      <CustomEventsPanel admin={admin} readOnly={readOnly} refresh={refresh} notify={notify} />
      <section className="panel ops-panel">
        <div className="panel-heading">
          <div>
            <h2>Reguły automatyczne</h2>
            <p>Zdarzenie → warunki → akcje · wszystkie akcje reguły wykonywane razem</p>
          </div>
          {admin && (
            <button
              className="button primary"
              disabled={busy || readOnly || crudBlocked}
              onClick={() => {
                if (!writeAccess.current || crudBlocked) return;
                setDraft(emptyRule());
                setError('');
              }}
            >
              <Plus size={16} />
              Nowa reguła
            </button>
          )}
        </div>
        <ErrorNotice error={error || rules.error || statuses.error || visibleCrud?.error || ''} />
        {visibleCrud?.attempt&&!['confirmed','refused'].includes(visibleCrud.attempt.phase)&&<div className="ops-result" role="status">
          <p>Zapis reguły został wysłany. Nie ponawiaj POST ani PATCH; odczyt nie wysyła zmian.</p>
          {visibleCrud.attempt.kind==='create'&&!visibleCrud.attempt.ack_id&&<p>Brak potwierdzonego ID nowej reguły. Sama nazwa lub zgodna treść nie potwierdza wykonania tej próby.</p>}
          {visibleCrud.candidates.length>0&&<p>Nowe reguły zgodne z całą zapisaną definicją i autorem (kandydatury, bez potwierdzenia źródła): {visibleCrud.candidates.join(', ')}.</p>}
          <button type="button" className="button" disabled={busy||!admin||readOnly} onClick={()=>void reconcileRule()}>Odczytaj wynik zapisu reguły</button>
        </div>}
        {draft && admin && !readOnly && (
          <form
            className="rule-editor"
            onSubmit={(e) => {
              e.preventDefault();
              if(!crudBlocked)void mutateRule(draft);
            }}
          >
            <div className="form-grid">
              <label>
                Nazwa reguły
                <input
                  required
                  minLength={2}
                  maxLength={120}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                Zdarzenie
                <select
                  value={draft.trigger}
                  onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
                >
                  {Object.entries(allTriggers).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Priorytet (0 = pierwszy)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={draft.priority}
                  onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                />
              </label>
              <label>
                Opóźnienie w sekundach
                <input
                  type="number"
                  min={0}
                  max={604800}
                  value={draft.delay_seconds}
                  onChange={(e) => setDraft({ ...draft, delay_seconds: Number(e.target.value) })}
                />
              </label>
            </div>
            <h3>Warunki</h3>
            <select
              aria-label="Łączenie warunków"
              value={draft.match}
              onChange={(e) => setDraft({ ...draft, match: e.target.value })}
            >
              <option value="all">Wszystkie warunki (AND)</option>
              <option value="any">Dowolny warunek (OR)</option>
            </select>
            {!draft.conditions.length && <p>Bez warunków — każde zdarzenie tego rodzaju.</p>}
            {draft.conditions.map((c: any, i: number) => {
              const set = (v: any) =>
                setDraft({
                  ...draft,
                  conditions: draft.conditions.map((n: any, j: number) => (j === i ? v : n)),
                });
              const remove = () =>
                setDraft({
                  ...draft,
                  conditions: draft.conditions.filter((_: any, j: number) => j !== i),
                });
              const lookups = {
                statuses: statuses.data?.data ?? [],
                warehouses: settings.data?.warehouses ?? [],
              };
              if (!c.group)
                return (
                  <div className="ops-editor-row" key={i}>
                    <ConditionEditor value={c} onChange={set} {...lookups} />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={'Usuń warunek ' + (i + 1)}
                      onClick={remove}
                    >
                      <X size={18} />
                    </button>
                  </div>
                );
              const setGroup = (g: any) => set({ group: { ...c.group, ...g } });
              return (
                <fieldset className="ops-condition-group" key={i} style={groupBox}>
                  <legend className="muted">Grupa warunków {i + 1}</legend>
                  <div className="ops-editor-row">
                    <select
                      aria-label={'Łączenie warunków w grupie ' + (i + 1)}
                      value={c.group.match}
                      onChange={(e) => setGroup({ match: e.target.value })}
                    >
                      <option value="all">Grupa: wszystkie warunki (AND)</option>
                      <option value="any">Grupa: dowolny warunek (OR)</option>
                    </select>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={'Usuń grupę ' + (i + 1)}
                      onClick={remove}
                    >
                      <X size={18} />
                    </button>
                  </div>
                  {c.group.conditions.map((l: any, k: number) => (
                    <div className="ops-editor-row" key={k}>
                      <ConditionEditor
                        value={l}
                        onChange={(v) =>
                          setGroup({
                            conditions: c.group.conditions.map((n: any, j: number) =>
                              j === k ? v : n,
                            ),
                          })
                        }
                        {...lookups}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        disabled={c.group.conditions.length <= 1}
                        aria-label={'Usuń warunek ' + (k + 1) + ' z grupy ' + (i + 1)}
                        onClick={() =>
                          setGroup({
                            conditions: c.group.conditions.filter((_: any, j: number) => j !== k),
                          })
                        }
                      >
                        <X size={18} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="button small-btn"
                    disabled={leafCount(draft.conditions) >= 10}
                    onClick={() => setGroup({ conditions: [...c.group.conditions, newLeaf()] })}
                  >
                    Dodaj warunek do grupy
                  </button>
                </fieldset>
              );
            })}
            <div className="ops-buttons">
              <button
                type="button"
                className="button"
                disabled={draft.conditions.length >= 10 || leafCount(draft.conditions) >= 10}
                onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, newLeaf()] })}
              >
                Dodaj warunek
              </button>
              <button
                type="button"
                className="button"
                disabled={draft.conditions.length >= 10 || leafCount(draft.conditions) >= 10}
                onClick={() =>
                  setDraft({
                    ...draft,
                    conditions: [...draft.conditions, { group: { match: 'any', conditions: [newLeaf()] } }],
                  })
                }
              >
                Dodaj grupę warunków
              </button>
            </div>
            <p className="muted">Najwyżej 10 warunków łącznie z grupami · grupa nie zawiera kolejnych grup.</p>
            <h3>Akcje w kolejności</h3>
            {draft.actions.map((a: any, i: number) => (
              <div className="ops-editor-row" key={i}>
                <ActionEditor
                  value={a}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      actions: draft.actions.map((n: any, j: number) => (j === i ? v : n)),
                    })
                  }
                  statuses={statuses.data?.data ?? []}
                  localEffectsContext={workerContextKey}
                />
                <button
                  type="button"
                  className="icon-button"
                  disabled={draft.actions.length <= 1}
                  aria-label={'Usuń akcję ' + (i + 1)}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      actions: draft.actions.filter((_: any, j: number) => j !== i),
                    })
                  }
                >
                  <X size={18} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button"
              disabled={draft.actions.length >= 5}
              onClick={() => setDraft({ ...draft, actions: [...draft.actions, initialAction()] })}
            >
              Dodaj akcję
            </button>
            <div className="ops-buttons">
              <button className="button primary" disabled={busy || crudBlocked}>
                Zapisz regułę
              </button>
              <button type="button" className="button" onClick={() => setDraft(null)}>
                Zamknij edytor
              </button>
            </div>
          </form>
        )}
        <div className="rule-grid automation-rule-grid">
          {rules.data?.data.filter((r: any) => !isCustomerMessageWorkflow(r)).map((r: any) => (
            <article className="rule-card" key={r.id}>
              <div className="rule-header">
                <Zap size={21} />
                <button
                  className={'switch ' + (r.enabled ? 'on' : '')}
                  role="switch"
                  aria-label={'Reguła ' + r.name}
                  aria-checked={r.enabled}
                  disabled={!admin || busy || readOnly || crudBlocked}
                  onClick={() => {if(!crudBlocked)void mutateRule({id:r.id,enabled:!r.enabled,version:r.version});}}
                >
                  <span />
                </button>
              </div>
              <h3>{r.name}</h3>
              <p>
                {allTriggers[r.trigger] ?? r.trigger} · priorytet {r.priority} · opóźnienie{' '}
                {r.delay_seconds} s
              </p>
              <p>
                {r.definition.match === 'all' ? 'Wszystkie' : 'Dowolny'} z{' '}
                {r.definition.conditions.length} warunków
              </p>
              <ul>
                {r.definition.conditions.map((c: any, i: number) => (
                  <li key={i}>
                    {c.group
                      ? groupLabel(c.group.match) +
                        ': ' +
                        c.group.conditions
                          .map((l: any) =>
                            conditionLabel(l, statuses.data?.data ?? [], settings.data?.warehouses ?? []),
                          )
                          .join(' / ')
                      : conditionLabel(c, statuses.data?.data ?? [], settings.data?.warehouses ?? [])}
                  </li>
                ))}
              </ul>
              <ol>
                {r.definition.actions.map((a: any, i: number) => (
                  <li key={i}>{actionText(a, statuses.data?.data ?? [])}</li>
                ))}
              </ol>
              {admin && workerContextKey && <LocalAutomationWorkerControl key={workerContextKey+':'+r.id} contextKey={workerContextKey} rule={r} admin={admin} readOnly={readOnly} onChanged={reload} />}
              {admin && (
                <div className="ops-buttons">
                  <button
                    className="button small-btn"
                    disabled={busy || readOnly || crudBlocked}
                    onClick={() => { if (writeAccess.current && !crudBlocked) setDraft({ ...r.definition, id: r.id, version: r.version }); }}
                  >
                    Edytuj
                  </button>
                  <button
                    className="button small-btn"
                    disabled={busy || readOnly}
                    onClick={() => {
                      if (!writeAccess.current) return;
                      setTestRule(r);
                      setResult(null);
                      setOrderId('');
                    }}
                  >
                    Sprawdź na zamówieniu
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
        {testRule && admin && !readOnly && (
          <div className="ops-result">
            <h3>Podgląd: {testRule.name}</h3>
            <p>Sprawdzamy bieżące dane i kontrole akcji. Podgląd nie zapisuje zmian ani zadań.</p>
            <select
              aria-label="Zamówienie do sprawdzenia reguły"
              value={orderId}
              onChange={(e) => {
                setOrderId(e.target.value);
                setResult(null);
              }}
            >
              <option value="">Wybierz zamówienie</option>
              {orders.data?.data.map((o: any) => (
                <option key={o.id} value={o.id}>
                  {o.number} · {o.customer_name} · {statusNames[o.status]}
                </option>
              ))}
            </select>
            <button
              className="button"
              disabled={!orderId || busy}
              onClick={() =>
                run(async () => {
                  setResult(
                    await api('/automations/' + testRule.id + '/preview', 'POST', {
                      order_id: orderId,
                    }),
                  );
                })
              }
            >
              Sprawdź regułę bez zmian
            </button>
            <button className="button" onClick={() => setTestRule(null)}>
              Zamknij podgląd
            </button>
            {result && (
              <>
                <SmsActionReceipts actions={result.result} preview />
                <EmailActionReceipts actions={result.result} preview />
              </>
            )}
            {result?.chain && (
              <PreviewChain
                chain={result.chain}
                definition={testRule.definition}
                statuses={statuses.data?.data ?? []}
                warehouses={settings.data?.warehouses ?? []}
              />
            )}
            {result && (
              <p role="status">
                {result.matched
                  ? result.allowed
                    ? 'Warunki spełnione. Wszystkie akcje dozwolone.'
                    : 'Warunki spełnione. Akcja zablokowana: ' + result.error
                  : 'Warunki nie są spełnione.'}
              </p>
            )}
          </div>
        )}
      </section>
      <section className="panel ops-panel">
        <div className="panel-heading">
          <div>
            <h2>Historia wykonań</h2>
            <p>Wynik, pominięcia i błędy każdej reguły · automatyczne odświeżanie po zakończeniu odczytu</p>
          </div>
          <button className="button" onClick={() => setLocalRefresh((n) => n + 1)}>
            Odśwież historię
          </button>
        </div>
        <ErrorNotice error={runs.error} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Data / reguła</th>
                <th>Zamówienie</th>
                <th>Wynik</th>
                <th>Szczegóły</th>
              </tr>
            </thead>
            <tbody>
              {runs.data?.data.filter((r: any) => !isCustomerMessageWorkflow(r)).map((r: any) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.rule_name}</strong>
                    <small>
                      {date(r.created_at)} · wersja {r.rule_version}
                    </small>
                  </td>
                  <td>{r.number}</td>
                  <td>{stateNames[r.state]}</td>
                  <td>
                    {r.error ??
                      r.result?.reason ??
                      (r.state === 'done'
                        ? (Array.isArray(r.result?.actions) ? 'Zapisano ' + r.result.actions.length + ' akcji' : 'Wykonanie zakończone')
                        : 'Oczekiwanie na wykonanie')}
                    {r.state === 'done' && Array.isArray(r.result?.actions) && (
                      <AutomationActionDetails definition={r.definition} results={r.result.actions} />
                    )}
                    <SmsActionReceipts actions={r.result?.actions} />
                    <EmailActionReceipts actions={r.result?.actions} />
                    <AutomaticEffects effects={r.child_effects}/>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="ops-buttons">
          {runCursor && (
            <button className="button" onClick={() => setRunCursor('')}>
              Najnowsze wykonania
            </button>
          )}
          {runs.data?.meta.cursor && (
            <button className="button" onClick={() => setRunCursor(runs.data.meta.cursor)}>
              Starsze wykonania
            </button>
          )}
        </div>
      </section>
      {admin && <WorkerSupervision refresh={refresh} readOnly={readOnly} notify={notify} />}
      {admin && <ReconciliationQueue refresh={refresh} />}
    </>
  );
}
