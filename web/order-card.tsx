/** Order card (Uwagi v3 §4, §6, §9; client mockup "Karta zamówienia"): breadcrumb and header with
 * stage-dependent actions, timeline, products with the scan bar, right-column section cards with
 * per-section editing, and bottom tabs holding every former "Szczegóły" group. */
import { reconcileUnknownOrderMutation } from './order-mutation-reconciliation';
import { DeferredOrderPanel } from './deferred-order-panel';
import { OrdersMergeLineage } from './order-merges';
import { ProductLogisticsPanel } from './product-logistics';
import { ShopifyFulfillmentPanel } from './shopify-fulfillment';
import { AmazonFulfillmentPanel } from './amazon-fulfillment';
import { AmazonMcfReadOnlyPanel } from './amazon-mcf-readonly';
import { EbayFulfillmentPanel } from './ebay-fulfillment';
import { B2bDropshippingOrderScope } from './b2b-network-dropshipping';
import { B2bExternalOrderIntents } from './b2b-external-order-intents';
import { EmailPanel } from './email';
import { OrderCommunicationTimeline } from './messages-order-timeline';
import { BuyerAddressPanel } from './buyer-address';
import { OrderSplitPanel } from './order-split-panel';
import { OrderSplitLineage } from './order-split-lineage';
import { OrderSplit222Panel, hasPendingSplit222 } from './order-split222-panel';
import { OrderFlowStepper, OrderNotesPanel } from './order-detail-parts';
import { subscribeEmailInboundLock } from './email-inbound';
import { ProformaPanel } from './proformas';
import { LocalInvoicePanel, subscribeLocalInvoicesLock, localInvoicesLocked } from './local-invoices';
import { Invoice230Panel } from './invoice230';
import { Receipt233Panel } from './receipt233';
import { subscribeConsumerCreditsLock, consumerCreditsLocked } from './local-consumer-credits';
import { B2bFa3Projects, b2bFa3ProjectLocked, b2bFa3PendingOrder, subscribeB2bFa3ProjectLock } from './b2b-fa3-projects';
import { b2bFa3HttpTransport } from './b2b-fa3-http';
import { B2bInvoiceIssuePanel, b2bInvoiceLocked, b2bInvoicePendingProject, b2bInvoicePendingOrder, subscribeB2bInvoiceLock } from './b2b-invoices';
import { createB2bInvoiceHttp159 } from './b2b-invoice-http';
import { B2bCorrectionIssuePanel, b2bCorrectionLocked, b2bCorrectionPendingOriginal, b2bCorrectionPendingOrder, subscribeB2bCorrectionLock } from './b2b-corrections';
import { createB2bCorrectionHttp160 } from './b2b-correction-http';
import { PrintJobsPanel, subscribePrintJobsLock, getPrintJobsMutationState } from './print-jobs';
import { OrderParcelsPanel, getOrderParcelsLocked, subscribeOrderParcelsLock } from './order-parcels';
import { ShipmentLabelPrintPanel } from './shipment-label-print';
import { OrderFieldsPanel } from './order-fields';
import { useState, useEffect, useRef, useMemo } from 'react';
import { ErrorBlock, Loading, type Notice } from './order-card-common';
import type { OrderSection, SectionChange } from '../shared/order-sections';
import {
  cardPaymentState, cardStage, channelNote, fromDraft, neighbours, requestEdit, sectionChanges, sectionLocks, sourceName, startEdit,
  type EditableSection, type EditState, type Row,
} from './order-card-model';
import { saveOrderSection, SectionSaveError } from './order-section-api';
import { OrderBreadcrumb, OrderCardHeader } from './order-card-header';
import { OrderProductsCard } from './order-card-products';
import { OrderAside } from './order-card-aside';
import { SectionCard, SectionConfirmDialog, SectionSwitchDialog, type SectionControl } from './order-card-section';
import { OrderMessageDialog, type MessageKind } from './order-card-message';
import { CardTabBar, CardTabPanel, type CardTab } from './order-card-tabs';
import { FileText, Check, ScanLine, Truck, X } from 'lucide-react';
import { DemoCarrierStatus } from './order-carrier-demo';
import { api, ApiError } from './api';
import { OrderOperationsPanel } from './operations';
import { OrderChannelStatus } from './order-status';
import { InvoicePanel } from './invoices';
import { OdooInvoicePanel } from './odoo-invoices';
import { ReturnsPanel, type ReturnReceiveFocus } from './returns';
import { PaymentsPanel } from './payments';
import { PayuSessionsPanel } from './payu';
import { SourcePaymentsPanel } from './source-payments';
import { ShippingPanel } from './shipping';
import { DpdShippingPanel } from './dpd-shipping';
import { CarrierShippingPanel } from './carrier-shipping';
import { PackingWorkstationPanel, type PackingParcelSeed } from './packing-workstation';
import { WmsOrderLotsPanel } from './wms-lots';
import { ManualAutomationButtons } from './automation-manual-buttons';
import { navigateTo, packingPath } from './app-route';
import { orderScanBody, orderScanErrorMessage } from './order-scan';
import { isRuleBarcode, ruleBarcodeBody } from './automation-barcode';
import { OrderChannelData } from './order-channel-data';

// This loader retains only the same principal/order snapshot during revalidation.
function useOrderDetailSnapshot(id: string, context: string, refresh: number) {
  const scope = context + ':' + id;
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<{scope:string;refresh:number;retry:number;readEpoch:number;data:any}|null>(null);
  const [failure, setFailure] = useState<{scope:string;refresh:number;retry:number;message:string;denied:boolean}|null>(null);
  const epoch = useRef(0);
  const liveScope = useRef(scope); liveScope.current = scope;
  const allowed = useRef(false);
  const data = snapshot?.scope === scope ? snapshot.data : null;
  const error = failure?.scope === scope && failure.refresh === refresh && failure.retry === retry ? failure.message : '';
  const blocked = !data || !!error || snapshot?.refresh !== refresh || snapshot.retry !== retry;
  allowed.current = !blocked;
  useEffect(() => {
    const ownEpoch = ++epoch.current;
    const controller = new AbortController();
    setFailure(null);
    api('/orders/' + encodeURIComponent(id), 'GET', undefined, {}, controller.signal).then(data => {
      if (epoch.current !== ownEpoch || liveScope.current !== scope) return;
      if (!data || data.id !== id) throw new Error('Odczyt dotyczy innego zamówienia. Odśwież kartę.');
      setSnapshot({scope,refresh,retry,readEpoch:ownEpoch,data});
    }).catch(e => {
      if (epoch.current !== ownEpoch || liveScope.current !== scope) return;
      const denied = e instanceof ApiError && [401,403].includes(e.status);
      if (denied) setSnapshot(null);
      setFailure({scope,refresh,retry,message:(e as Error).message,denied});
    });
    return () => { ++epoch.current; controller.abort(); allowed.current = false; };
  }, [scope, id, refresh, retry]);
  return {data,error,blocked,readEpoch:snapshot?.scope===scope?snapshot.readEpoch:0,canWrite:()=>allowed.current,reload:()=>{allowed.current=false;setRetry(v=>v+1);}};
}
/** Source fields are the actual current order detail, never a local fixture or
 * private Native plan. Result navigation re-reads even the retained source. */
function OrderSplitDetailPanel({available,order,contextKey,readOnly,onOpenOrder,onRefresh}:{available:boolean;order:any;contextKey:string;readOnly:boolean;onOpenOrder:(id:string)=>void;onRefresh:()=>void}){
 if(available!==true)return null;
 return <OrderSplitPanel source={{order_id:order.id,version:String(order.version),currency:order.currency,shipping_cost:order.shipping_cost,
  items:order.items.map((i:any)=>({id:i.id,name:i.name,sku:i.sku,quantity:i.quantity,price:i.price,line_total:i.line_total}))}}
  contextKey={contextKey} readOnly={readOnly} onOpenOrder={id=>{onRefresh();onOpenOrder(id);}}/>;
}
export function OrderDetail({
  splitAvailable,
  split222Available,
  admin,
  workspaceId,
  userId,
  packingContextKey,
  warehousePolicyWriteBlocked,
  readOnly,
  id,
  refresh,
  write,
  paymentWrite = false,
  notify,
  reload,
  onBack,
  onOpenOrder,
  listIds,
  onOpenStage,
  onOpenPacking,
}: {
  splitAvailable: boolean;
  split222Available: boolean;
  admin: boolean;
  workspaceId: string;
  packingContextKey: string;
  userId: string;
  warehousePolicyWriteBlocked: boolean;
  readOnly: boolean;
  id: string;
  refresh: number;
  write: boolean;
  /** The accountant "Księgowa": no other writes, but the Płatność section opens (the server locks the rest). */
  paymentWrite?: boolean;
  notify: Notice;
  reload: () => void;
  onBack: () => void;
  onOpenOrder: (id: string) => void;
  /** Ids of the list the card was opened from, for "‹ Poprzednie · Następne ›" (omitted when absent). */
  listIds?: readonly string[];
  /** Breadcrumb status link to the list of that stage; plain text when absent. */
  onOpenStage?: (stage: string) => void;
  /** "Kontynuuj pakowanie"; defaults to the packer module at /wms. */
  onOpenPacking?: () => void;
}) {
  const detail = useOrderDetailSnapshot(id, packingContextKey + ':' + readOnly, refresh);
  const { data: o, error } = detail;
  const actionFlight = useRef(false);
  const actionReadOnly = useRef(readOnly);
  actionReadOnly.current = readOnly;
  const actionContext = useRef(packingContextKey + ':' + readOnly + ':' + id);
  actionContext.current = packingContextKey + ':' + readOnly + ':' + id;
  useEffect(() => () => {actionContext.current='';}, []);
  const
    [busy, setBusy] = useState(false),
    [code, setCode] = useState(''),
    [pickLocation, setPickLocation] = useState('');
  const [parcelSeed, setParcelSeed] = useState<PackingParcelSeed | undefined>();
  const [printShipmentId, setPrintShipmentId] = useState<string | null>(null);
  const [returnReceiveFocus, setReturnReceiveFocus] = useState<ReturnReceiveFocus | undefined>();
  // Per-section editing (§6): one section at a time, confirm before save, ask before switching.
  const [edit, setEdit] = useState<EditState | null>(null);
  const [editErrors, setEditErrors] = useState<string[]>([]);
  const [confirmSave, setConfirmSave] = useState<{ section: EditableSection; values: Row; changes: SectionChange[]; then?: OrderSection } | null>(null);
  const [switchTo, setSwitchTo] = useState<OrderSection | null>(null);
  const [compose, setCompose] = useState<MessageKind | null>(null);
  const [tab, setTab] = useState<CardTab>('history');
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setEdit(null); setEditErrors([]); setConfirmSave(null); setSwitchTo(null); setCompose(null); setTab('history'); }, [id, readOnly]);
  const printActorContext = packingContextKey + ':' + readOnly;
  useEffect(() => setReturnReceiveFocus(undefined), [id, printActorContext]);
  const [inboundLocked, setInboundLocked] = useState(false);
  useEffect(() => subscribeEmailInboundLock(printActorContext, setInboundLocked), [printActorContext]);
  useEffect(() => { setPrintShipmentId(null); }, [id, printActorContext]);
  const [parcelLocked, setParcelLocked] = useState(() => getOrderParcelsLocked(printActorContext));
  useEffect(() => subscribeOrderParcelsLock(printActorContext, setParcelLocked), [printActorContext]);
  const [invoiceLocked, setInvoiceLocked] = useState(() => localInvoicesLocked(printActorContext));
  useEffect(() => subscribeLocalInvoicesLock(printActorContext, setInvoiceLocked), [printActorContext]);
  const [consumerCreditLocked,setConsumerCreditLocked]=useState(()=>consumerCreditsLocked(printActorContext));
  useEffect(()=>subscribeConsumerCreditsLock(printActorContext,setConsumerCreditLocked),[printActorContext]);
  const [orderPrintLocked, setOrderPrintLocked] = useState(() => getPrintJobsMutationState(printActorContext).locked);
  useEffect(() => subscribePrintJobsLock(printActorContext, setOrderPrintLocked), [printActorContext]);
  const [b2bProjectLocked, setB2bProjectLocked] = useState(() => b2bFa3ProjectLocked(printActorContext));
  useEffect(() => subscribeB2bFa3ProjectLock(printActorContext, setB2bProjectLocked), [printActorContext]);
  const [b2bIssuedLocked, setB2bIssuedLocked] = useState(() => b2bInvoiceLocked(printActorContext));
  useEffect(() => subscribeB2bInvoiceLock(printActorContext, setB2bIssuedLocked), [printActorContext]);
  const [b2bCreditLocked, setB2bCreditLocked] = useState(() => b2bCorrectionLocked(printActorContext));
  useEffect(() => subscribeB2bCorrectionLock(printActorContext, setB2bCreditLocked), [printActorContext]);
  const [issuedOriginal, setIssuedOriginal] = useState<{context:string;order:string;document:string}|null>(null);
  const b2bCorrectionTransport = useMemo(() => createB2bCorrectionHttp160(printActorContext.split(':')[0]), [printActorContext]);
  const correctionOriginalId = b2bCorrectionPendingOrder(printActorContext) === id ? b2bCorrectionPendingOriginal(printActorContext) : issuedOriginal?.context === printActorContext && issuedOriginal.order === id ? issuedOriginal.document : undefined;
  const [approvedB2b, setApprovedB2b] = useState<{context:string;order:string;project:string}|null>(null);
  const b2bInvoiceTransport = useMemo(() => createB2bInvoiceHttp159(printActorContext.split(':')[0]), [printActorContext]);
  const invoiceProjectId = b2bInvoicePendingOrder(printActorContext) === id
    ? b2bInvoicePendingProject(printActorContext)
    : approvedB2b?.context === printActorContext && approvedB2b.order === id ? approvedB2b.project : undefined;
  // A pending recovery opens the tab that holds it, as the former collapsed groups opened themselves.
  const b2bPending = b2bFa3PendingOrder(printActorContext) === id || Boolean(invoiceProjectId) || Boolean(correctionOriginalId);
  const split222Pending = hasPendingSplit222(packingContextKey, id);
  useEffect(() => { if (returnReceiveFocus) setTab('returns'); }, [returnReceiveFocus]);
  useEffect(() => { if (parcelSeed !== undefined) setTab('logistics'); }, [parcelSeed]);
  useEffect(() => { if (b2bPending) setTab('documents'); }, [b2bPending]);
  useEffect(() => { if (split222Pending) setTab('more'); }, [split222Pending]);
  if (!o) return error ? <ErrorBlock message={error} /> : <Loading />;
  const detailWriteBlocked = detail.blocked || busy;
  const replacement = o.fulfillment_kind === 'replacement';
  const cardWritable = !readOnly && !o.merge_claim && !parcelLocked && !invoiceLocked && !consumerCreditLocked && !(b2bProjectLocked || b2bIssuedLocked || b2bCreditLocked);
  write = write && cardWritable;
  // Section editing: everyone who writes, plus the accountant for whom the server leaves only Płatność open.
  const sectionWrite = write || (paymentWrite && cardWritable);
  admin = admin && !o.merge_claim && !parcelLocked && !invoiceLocked && !consumerCreditLocked && !(b2bProjectLocked || b2bIssuedLocked || b2bCreditLocked);
  readOnly = readOnly || Boolean(o.merge_claim);
  const mutationAdmin = admin && !readOnly;
  actionReadOnly.current = readOnly;
  /** Every write of the card: the same custody (read-only, pending recoveries, one write at a time). */
  async function mutate(run: () => Promise<unknown>, options: { scan?: boolean; onError?: (e: unknown) => boolean } = {}): Promise<boolean> {
    if (actionReadOnly.current || readOnly || !detail.canWrite() || actionFlight.current) return false;
    const ownContext = actionContext.current;
    if (b2bCorrectionLocked(printActorContext)) {
      notify('Najpierw sprawdź wynik zachowanej korekty B2B.', true);
      return false;
    }
    if (b2bInvoiceLocked(printActorContext)) {
      notify('Najpierw sprawdź wynik zachowanego wystawienia FV B2B.', true);
      return false;
    }
    if (b2bFa3ProjectLocked(printActorContext)) {
      notify('Najpierw sprawdź wynik zachowanego zapisu projektu B2B.', true);
      return false;
    }
    if (localInvoicesLocked(printActorContext)) {
      notify('Najpierw sprawdź wynik wystawienia lokalnej faktury.', true);
      return false;
    }
    if (getOrderParcelsLocked(printActorContext)) {
      notify('Najpierw uzgodnij wynik operacji paczek.', true);
      return false;
    }
    actionFlight.current = true;
    setBusy(true);
    try {
      await run();
      if (actionContext.current !== ownContext) return false;
      detail.reload();
      // Scanning changes the picking detail, without changing stock or documents.
      // Other mutations still refresh all related panels.
      if (!options.scan) reload();
      notify('Operacja została zapisana.');
      setCode('');
      return true;
    } catch (e) {
      if (actionContext.current === ownContext && !options.onError?.(e)) {
        if (reconcileUnknownOrderMutation(e, detail.reload)) {
          notify('Wynik operacji wymaga sprawdzenia. Odczytuję aktualny stan zamówienia.', true);
        } else {
          notify(orderScanErrorMessage((e as Error).message), true);
          if (e instanceof ApiError && e.status === 409 &&
            ['Zamówienie zmieniło się. Odśwież dane przed zmianą statusu.',
              'Zamówienie zmieniło się. Odśwież dane przed edycją.'].includes(e.message))
            detail.reload();
        }
      }
      return false;
    } finally {
      actionFlight.current = false;
      if (actionContext.current === ownContext) setBusy(false);
    }
  }
  const action = (path: string, body?: unknown, method = 'POST'): Promise<boolean> =>
    mutate(() => api(path, method, body), { scan: path === `/orders/${id}/scan` });
  // Main flow (statusNames): new = Nieopłacone, paid = Nowe (ready to fulfil). The server refuses new -> picking
  // for every order (264 moved cash-on-delivery orders to paid), so new always goes to paid first.
  // Picking and packed have their own header actions (Kontynuuj pakowanie, Generuj etykietę).
  // Code new waits for its payment: it is confirmed in the Płatność section, not by a status button.
  const next: Record<string, string> = {
      paid: 'picking',
      shipped: 'delivered',
      delivered: 'completed',
      return_initiated: 'return_received',
      return_received: 'return_completed',
    },
    nextLabel: Record<string, string> = {
      picking: 'Przekaż do kompletacji',
      delivered: 'Potwierdź dostarczenie',
      completed: 'Zakończ zamówienie',
      return_received: 'Przyjmij cały zwrot',
      return_completed: 'Zakończ zwrot',
    };
  const b2bLocked = b2bProjectLocked || b2bIssuedLocked || b2bCreditLocked;
  const allScanned = o.picking_items.every((i: any) => i.scanned === i.quantity);
  const nextStep = next[o.status];
  const showNext = write && Boolean(nextStep) && !(o.status.startsWith('return_') && o.returns?.has_partial);
  const stage = cardStage(o);
  const paymentState = cardPaymentState(o);
  const { prev, next: nextOrder } = neighbours(listIds, id);
  const locks = sectionLocks(o);
  // An open section closes when writes stop being allowed or a fresh read locks it.
  const activeEdit = edit && sectionWrite && !locks[edit.section].locked ? edit : null;
  function openTab(target: CardTab) {
    setTab(target);
    requestAnimationFrame(() => tabsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  }
  function openEdit(section: OrderSection) {
    setEditErrors([]);
    setEdit(startEdit(o, section));
  }
  /** Validates the open section and asks for confirmation; `then` opens another section afterwards. */
  function prepareSave(then?: OrderSection) {
    if (!activeEdit || activeEdit.section === 'products') return;
    const section = activeEdit.section;
    const { values, errors } = fromDraft(section, activeEdit.draft, o);
    setEditErrors(errors);
    if (errors.length) return;
    const changes = sectionChanges(section, activeEdit.initial, values, o.currency);
    if (!changes.length) {
      setEdit(null);
      if (then) openEdit(then);
      return;
    }
    setConfirmSave({ section, values, changes, then });
  }
  async function saveSection() {
    const pending = confirmSave;
    if (!pending) return;
    const saved = await mutate(() => saveOrderSection(o, pending.section, pending.values), {
      onError: (e) => {
        if (!(e instanceof SectionSaveError)) return false;
        setEditErrors([e.message]);
        notify(e.message, true);
        if (e.status === 423) setEdit(null);
        if (e.status === 409 || e.status === 423) detail.reload();
        return true;
      },
    });
    setConfirmSave(null);
    if (!saved) return;
    setEdit(null);
    setEditErrors([]);
    if (pending.then) openEdit(pending.then);
  }
  const control: SectionControl = {
    edit: activeEdit,
    locks,
    canEdit: sectionWrite,
    busy: detailWriteBlocked,
    errors: editErrors,
    onEdit: (section) => {
      const decision = requestEdit(activeEdit, section);
      if (decision === 'ask') setSwitchTo(section);
      else if (decision === 'open') openEdit(section);
    },
    onDraft: (draft) => setEdit((current) => (current ? { ...current, draft } : current)),
    onCancel: () => { setEdit(null); setEditErrors([]); },
    onSave: () => prepareSave(),
    onLockAction: (lock) => openTab(lock.action === 'correction' ? 'documents' : 'logistics'),
  };
  const canIssueDocument = write && !replacement && !['new', 'cancelled'].includes(o.status) && !o.documents.length;
  // /pakowanie/<number> opens the packing screen for this order (App applies its navigation guards).
  const openPacking = onOpenPacking ?? (() => navigateTo(packingPath(o.number)));
  const primary = (
    <>
      {o.status === 'picking' && !readOnly && (
        <button type="button" className="button primary order-primary" onClick={openPacking}>
          <ScanLine size={17} /> Kontynuuj pakowanie
        </button>
      )}
      {o.status === 'packed' && write && (
        <button type="button" className="button primary order-primary" disabled={busy} onClick={() => openTab('logistics')}>
          <Truck size={17} /> {stage === 'ready_to_ship' ? 'Przejdź do nadania' : 'Generuj etykietę'}
        </button>
      )}
      {showNext && (
        <button
          className="button primary order-primary"
          disabled={busy || (nextStep === 'return_received' && o.wms_lots_enabled === true && (readOnly || warehousePolicyWriteBlocked))}
          onClick={() => {
            if (nextStep === 'return_received' && o.wms_lots_enabled === true) {
              if (readOnly || warehousePolicyWriteBlocked || getOrderParcelsLocked(printActorContext)) {
                notify('Przyjęcie jest teraz wstrzymane. Sprawdź tryb odczytu i wynik wcześniejszych zapisów.', true);
                return;
              }
              setReturnReceiveFocus({ contextKey: printActorContext, orderId: id,
                orderVersion: String(o.version), token: crypto.randomUUID() });
            } else void action(`/orders/${id}/status`, { status: nextStep, expected_version: String(o.version) }, 'PATCH');
          }}
        >
          <Check size={17} />
          {nextStep === 'return_received' && o.wms_lots_enabled === true ? 'Rozpatrz zwrot i wybierz partie' : nextLabel[nextStep]}
        </button>
      )}
    </>
  );
  const canReturn = !replacement && ['shipped', 'delivered', 'completed'].includes(o.status) && !o.returns?.has_partial;
  const canCancel = ['new', 'paid', 'picking', 'packed'].includes(o.status);
  const menu = write ? (
    <>
      <ManualAutomationButtons orderIds={[id]} notify={notify} disabled={busy} onDone={() => { detail.reload(); reload(); }} />
      {o.status === 'picking' && (
        <button
          className="button"
          disabled={busy || !allScanned}
          title={!allScanned ? 'Zeskanuj wszystkie produkty przed spakowaniem.' : undefined}
          onClick={() => action(`/orders/${id}/status`, { status: 'packed', expected_version: String(o.version) }, 'PATCH')}
        >
          <Check size={16} /> Oznacz jako spakowane
        </button>
      )}
      {/* §7: a label is not a dispatch. DEMO label → Gotowe do nadania; hand-over to the courier → Nadane. */}
      {o.status === 'packed' && stage !== 'ready_to_ship' && (
        <button className="button" disabled={busy || o.shipping_active} onClick={() => action(`/orders/${id}/demo-label`)}>
          <Truck size={16} /> Generuj etykietę DEMO
        </button>
      )}
      {o.status === 'packed' && stage === 'ready_to_ship' && (
        <button className="button" disabled={busy || o.shipping_active} onClick={() => action(`/orders/${id}/ship-demo`)}>
          <Truck size={16} /> Przekaż kurierowi (DEMO)
        </button>
      )}
      {/* Lane J: shipment.cancelled. The shipment row stays (status 'canceled'); a second label is not possible yet. */}
      {o.status === 'packed' && stage === 'ready_to_ship' && (
        <button
          className="button danger subtle"
          disabled={busy || o.shipping_active}
          onClick={() => {
            if (confirm('Anulować etykietę? Zamówienie wróci do „Spakowane”. Nowej etykiety dla tego zamówienia nie utworzysz w tej wersji.'))
              action(`/orders/${id}/cancel-label`);
          }}
        >
          <X size={16} /> Anuluj etykietę
        </button>
      )}
      <DemoCarrierStatus order={o} busy={busy} onPick={(status) => action(`/orders/${id}/demo-shipment-status`, { status })} />
      {canReturn && (
        <button
          className="button"
          disabled={busy}
          onClick={() => action(`/orders/${id}/status`, { status: 'return_initiated', expected_version: String(o.version) }, 'PATCH')}
        >
          Zgłoś cały zwrot
        </button>
      )}
      {canCancel && (
        <button
          className="button danger subtle"
          disabled={busy || o.shipping_active || o.invoice_committed}
          onClick={() => {
            if (confirm('Anulować zamówienie i zwolnić rezerwacje?'))
              action(`/orders/${id}/status`, { status: 'cancelled', expected_version: String(o.version) }, 'PATCH');
          }}
        >
          Anuluj zamówienie
        </button>
      )}
    </>
  ) : undefined;
  const pickingBlock = (
    <div className="catalog-picking">
      <h3>Kompletacja fizycznych produktów</h3>
      <p className="muted">
        {o.dropshipping?.external_quantity > 0
          ? 'Tabela pokazuje lokalną kompletację po przekazaniu części dostawcom. Pełny zakres handlowy i wydania dostawców widoczne w zakładce „Kanał sprzedaży”.'
          : 'Każdą sztukę potwierdź kodem SKU lub EAN. Zestawy są rozłożone na składniki.'}
      </p>
      <table>
        <thead>
          <tr>
            <th>SKU / produkt</th>
            <th>{o.dropshipping?.external_quantity > 0 ? 'Lokalne skany / ilość lokalna' : 'Potwierdzone sztuki'}</th>
          </tr>
        </thead>
        <tbody>
          {o.picking_items.map((i: any) => (
            <tr key={i.id}>
              <td>
                <strong>{i.sku}</strong>
                <small>{i.name}</small>
                {i.locations?.map((b: any) => (
                  <small key={b.location}>
                    <code>{b.location}</code> · skany {b.scanned}/{b.quantity} ·{' '}
                    {b.state === 'active'
                      ? `zarezerwowane ${b.quantity - (b.consumed_quantity ?? 0) - (b.released_quantity ?? 0)} szt.`
                      : b.state === 'consumed'
                        ? 'wydane'
                        : b.state === 'transferred'
                          ? 'przeniesione do zamówienia wynikowego'
                          : 'zwolnione'}
                  </small>
                ))}
              </td>
              <td>
                <span className={`scan-count ${i.scanned === i.quantity ? 'complete' : ''}`}>
                  {i.scanned} / {i.quantity}
                  {i.scanned === i.quantity && <Check size={14} />}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const scanForm = o.status === 'picking' && write ? (
    <form
      className="scan-form"
      onSubmit={(e) => {
        e.preventDefault();
        // A printed rule code (AR-…) runs that automation rule for this order (Uwagi v3 §0).
        if (isRuleBarcode(code)) action('/automations/v2/barcode', ruleBarcodeBody(code, id));
        else action(`/orders/${id}/scan`, orderScanBody({ code, location: pickLocation, lotsEnabled: o.wms_lots_enabled === true, newKey: () => crypto.randomUUID() }));
      }}
    >
      <ScanLine size={23} />
      <input
        aria-label="Lokalizacja kompletacji"
        value={pickLocation}
        onChange={(e) => setPickLocation(e.target.value)}
        placeholder="Lokalizacja (wymagana przy kilku miejscach)"
        maxLength={80}
      />
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Zeskanuj lub wpisz SKU / EAN"
        aria-label="Kod produktu"
        autoFocus
        required
      />
      <button className="button primary" disabled={busy}>
        Skanuj
      </button>
    </form>
  ) : undefined;
  const confirmNotes = confirmSave
    ? [
        ...(confirmSave.section === 'payment' ? ['Zapis uruchomi reguły automatyzacji dla zmiany płatności.'] : []),
        ...(channelNote(o) ? [channelNote(o) as string] : []),
      ]
    : [];
  return (
    <>
      {readOnly && <p className="notice" role="status">Podgląd tylko do odczytu — zmiany zamówienia i płatności są wyłączone.</p>}
      {detail.blocked && <div className="notice" role={error ? 'alert' : 'status'}>
        {error ? 'Nie udało się odświeżyć zamówienia. Zachowano ostatni odczyt; zapis jest zablokowany.' : 'Odświeżanie zamówienia — zapis jest chwilowo zablokowany.'}
        {error && <><p>{error}</p><button className="button" onClick={detail.reload}>Odczytaj ponownie</button></>}
      </div>}
      <OrderBreadcrumb order={o} stage={stage} prev={prev} next={nextOrder} onBack={onBack} onOpenStage={onOpenStage} onOpenOrder={onOpenOrder} />
      <fieldset disabled={detailWriteBlocked} className="order-plain-fieldset">
      {b2bProjectLocked && <p className="notice">Wynik zapisu projektu B2B wymaga sprawdzenia przed kolejną zmianą zamówienia.{b2bFa3PendingOrder(printActorContext) !== id && <button className="text-button" onClick={() => { const own = b2bFa3PendingOrder(printActorContext); if (own) onOpenOrder(own); }}>Wróć do zachowanej próby B2B</button>}</p>}
      {b2bIssuedLocked && <p className="notice">Wynik wystawienia FV B2B wymaga sprawdzenia przed kolejną zmianą zamówienia.{b2bInvoicePendingOrder(printActorContext) !== id && <button className="text-button" onClick={() => { const own = b2bInvoicePendingOrder(printActorContext); if (own) onOpenOrder(own); }}>Wróć do zachowanego wystawienia FV B2B</button>}</p>}
      {b2bCreditLocked && <p className="notice">Wynik zapisu korekty B2B wymaga sprawdzenia przed kolejną zmianą zamówienia.{b2bCorrectionPendingOrder(printActorContext) !== id && <button className="text-button" onClick={() => {const own=b2bCorrectionPendingOrder(printActorContext);if(own)onOpenOrder(own);}}>Wróć do zachowanej korekty</button>}</p>}
      <fieldset disabled={b2bLocked} className="order-plain-fieldset">
      {o.merge_claim && (
        <div className="panel">
          <strong>Źródło po połączeniu — historia zamówienia</strong>
          <p>Realizacja i rezerwacje zostały przeniesione do zamówienia wynikowego.</p>
          <button className="button" onClick={() => onOpenOrder(o.merge_claim.target_order_id)}>
            Otwórz zamówienie wynikowe
          </button>
        </div>
      )}
      <OrderCardHeader
        order={o}
        stage={stage}
        paymentState={paymentState}
        actions={!replacement && (
          <button
            type="button"
            className="button"
            disabled={busy}
            title={canIssueDocument ? 'Dokument sprzedaży DEMO' : 'Faktury, paragony i korekty: zakładka „Dokumenty i faktury”'}
            onClick={() => (canIssueDocument ? action(`/orders/${id}/documents`, { kind: 'invoice' }) : openTab('documents'))}
          >
            <FileText size={16} /> Wystaw dokument
          </button>
        )}
        primary={primary}
        menu={menu}
      />
      {o.source_snapshot && (
        <p className="notice">
          Kwoty brutto pochodzą z kanału sprzedaży. Stawki VAT do dokumentu demonstracyjnego
          pochodzą z lokalnego katalogu i wymagają sprawdzenia.
        </p>
      )}
      {replacement && (
        <p className="notice">
          Bezpłatna realizacja reklamacji. Rezerwacja i wydanie zamiennika obciążają magazyn; ta
          realizacja nie nalicza nowej sprzedaży ani płatności.
        </p>
      )}
      <OrderFlowStepper order={o} />
      <div className="detail-grid order-card-grid">
        <div className="order-card-main">
          <OrderProductsCard order={o} control={control} action={action} scanForm={scanForm} />
        </div>
        <OrderAside
          order={o}
          control={control}
          write={write}
          busy={detailWriteBlocked}
          portalAdmin={mutationAdmin}
          emailBlocked={inboundLocked}
          action={action}
          onCompose={setCompose}
          onOpenTab={openTab}
          onPrintShipment={setPrintShipmentId}
        />
      </div>
      </fieldset>
      </fieldset>
      <CardTabBar ref={tabsRef} active={tab} onSelect={setTab} />
      <fieldset disabled={detailWriteBlocked} className="order-plain-fieldset order-tabpanels">
      <CardTabPanel id="history" active={tab}>
        <fieldset disabled={b2bLocked} className="order-plain-fieldset">
          <OrderNotesPanel order={o} write={write && !readOnly} busy={busy} action={action} />
          <DeferredOrderPanel title="Historia komunikacji z kupującym"><OrderCommunicationTimeline orderId={id} refresh={refresh} /></DeferredOrderPanel>
          <DeferredOrderPanel title="Email do kupującego">
            {inboundLocked && <p className="notice">Niepewny zapis skrzynki email wstrzymuje świeże zapisy SMTP. Wróć do dokładnej próby w Wiadomościach klientów.</p>}
            <fieldset disabled={inboundLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><EmailPanel key={id} orderId={id} admin={mutationAdmin} write={write && !inboundLocked} refresh={refresh} /></fieldset>
          </DeferredOrderPanel>
        </fieldset>
      </CardTabPanel>
      <CardTabPanel id="fields" active={tab}>
        <fieldset disabled={b2bLocked} className="order-plain-fieldset">
          <SectionCard section="extra" title="Notatka zamówienia" control={control}>
            {o.note ? <p className="order-note-text">{o.note}</p> : <p className="muted">Brak notatki.</p>}
          </SectionCard>
          <OrderFieldsPanel
            key={workspaceId + ':' + o.id}
            workspaceId={workspaceId}
            orderId={o.id}
            readOnly={readOnly}
            refresh={refresh}
            onChanged={reload}
            onError={(message) => notify(message, true)}
          />
          <OrderOperationsPanel order={o} write={write} onChanged={reload} />
        </fieldset>
      </CardTabPanel>
      <CardTabPanel id="returns" active={tab}>
        <fieldset disabled={b2bLocked} className="order-plain-fieldset">
          <ReturnsPanel
            receiveFocus={returnReceiveFocus}
            externalWriteBlocked={detailWriteBlocked || warehousePolicyWriteBlocked}
            order={o}
            write={write && !readOnly}
            onChanged={reload}
            onOpenOrder={onOpenOrder}
            contextKey={packingContextKey}
            readOnly={readOnly}
          />
        </fieldset>
      </CardTabPanel>
      <CardTabPanel id="channel" active={tab}>
        <fieldset disabled={b2bLocked} className="order-plain-fieldset">
          <p className="muted order-tab-intro">Kanał: <strong>{sourceName(o.source)}</strong>{o.external_id && ` · ID źródłowe ${o.external_id}`}</p>
          <OrderChannelData orderId={o.id} version={o.version} />
          {admin && o.channel_id && ['woocommerce', 'allegro', 'prestashop'].includes(o.source) && (
            <OrderChannelStatus key={'channel-status:' + o.id} order={o} readOnly={readOnly} localWooContext={o.source === 'woocommerce' ? {tenantId:workspaceId,userId:packingContextKey.split(':')[1],admin,readOnly,externalWriteBlocked:detailWriteBlocked || warehousePolicyWriteBlocked || !write} : undefined} />
          )}
          <B2bDropshippingOrderScope scope={o.dropshipping} items={o.items} />
          <B2bExternalOrderIntents
            key={packingContextKey + ':' + id + ':' + readOnly}
            contextKey={packingContextKey}
            readOnly={readOnly}
            orderId={id}
            onChanged={reload}
          />
          {admin && o.channel_id && o.source === 'ebay' && <EbayFulfillmentPanel order={o} readOnly={readOnly} />}
          {admin && (
            <ShopifyFulfillmentPanel
              key={packingContextKey + ':' + o.id}
              order={o}
              refreshSignal={refresh}
              readOnly={readOnly}
            />
          )}
        </fieldset>
      </CardTabPanel>
      <CardTabPanel id="integrations" active={tab}>
        <fieldset disabled={b2bLocked} className="order-plain-fieldset">
          {admin && <AmazonMcfReadOnlyPanel key={packingContextKey + ':mcf:' + o.id + ':' + readOnly} order={o} readOnly={readOnly} />}
          {admin && o.channel_id && o.source === 'amazon' && (
            <AmazonFulfillmentPanel order={o} refreshSignal={refresh} readOnly={readOnly} />
          )}
          {!admin && <p className="muted">Integracje zamówienia są dostępne dla administratora.</p>}
        </fieldset>
      </CardTabPanel>
      <CardTabPanel id="logistics" active={tab}>
        <fieldset disabled={b2bLocked} className="order-plain-fieldset">
          {pickingBlock}
          <DeferredOrderPanel key={"deferred-wms-order-lots:" + printActorContext + ":" + id} title="Partie i alokacje magazynowe">
          <WmsOrderLotsPanel
            externalWriteBlocked={detailWriteBlocked || b2bLocked}
            key={'wms-order-lots:' + packingContextKey + ':' + readOnly + ':' + id}
            contextKey={packingContextKey}
            readOnly={readOnly || parcelLocked}
            orderId={id}
            refresh={refresh}
            onChanged={reload}
          />
          </DeferredOrderPanel>
          <DeferredOrderPanel key={"product-logistics:" + printActorContext + ":" + o.id} title="Waga i wymiary produktów"><ProductLogisticsPanel key={o.id} orderId={o.id} /></DeferredOrderPanel>
          <DeferredOrderPanel key={"deferred-order-parcels:" + printActorContext + ":" + id} title="Podział zamówienia na paczki">
          <OrderParcelsPanel
            key={'order-parcels:' + printActorContext + ':' + id}
            contextKey={printActorContext}
            readOnly={readOnly}
            externalWriteBlocked={detailWriteBlocked || busy || b2bLocked}
            orderId={id}
            refresh={detail.readEpoch}
            onChanged={reload}
          />
          </DeferredOrderPanel>
          <PackingWorkstationPanel
              externalWriteBlocked={detailWriteBlocked}
            key={packingContextKey + ':' + readOnly + ':' + id}
            contextKey={packingContextKey}
            readOnly={readOnly || parcelLocked}
            orderId={id}
            refresh={detail.readEpoch}
            onChanged={reload}
            onParcelSeed={setParcelSeed}
          />
          <ShippingPanel
            key={'shipping:'+printActorContext+':'+id}
            contextKey={printActorContext}
            connectorContext={{tenantId:workspaceId,userId,admin,readOnly,externalWriteBlocked:detailWriteBlocked||busy||parcelLocked||warehousePolicyWriteBlocked||b2bLocked||!write}}
            order={o}
            write={write && !readOnly}
            admin={admin}
            onChanged={reload}
            parcelSeed={parcelSeed?.provider === 'inpost_courier' ? parcelSeed : undefined}
            onPrintLabel={setPrintShipmentId}
          />
          <DeferredOrderPanel key={"deferred-dpd-shipping:" + printActorContext + ":" + id} title="Wysyłka DPD" openSignal={parcelSeed?.provider === 'dpd' ? parcelSeed : undefined}><DpdShippingPanel
            connectorContext={{tenantId:workspaceId,userId,admin,readOnly,externalWriteBlocked:detailWriteBlocked||busy||parcelLocked||warehousePolicyWriteBlocked||b2bLocked||!write}}
            order={o}
            write={write && !readOnly}
            admin={admin}
            onChanged={reload}
            parcelSeed={parcelSeed?.provider === 'dpd' ? parcelSeed : undefined}
            onPrintLabel={setPrintShipmentId}
          /></DeferredOrderPanel>
          <DeferredOrderPanel key={"deferred-dhl-shipping:" + printActorContext + ":" + id} title="Wysyłka DHL Parcel"><CarrierShippingPanel provider="dhl" order={o} write={write && !readOnly && !(detailWriteBlocked||busy||parcelLocked||warehousePolicyWriteBlocked||b2bLocked)} admin={admin} onChanged={reload} /></DeferredOrderPanel>
          <DeferredOrderPanel key={"deferred-pocztapolska-shipping:" + printActorContext + ":" + id} title="Wysyłka Poczta Polska"><CarrierShippingPanel provider="pocztapolska" order={o} write={write && !readOnly && !(detailWriteBlocked||busy||parcelLocked||warehousePolicyWriteBlocked||b2bLocked)} admin={admin} onChanged={reload} /></DeferredOrderPanel>
          <DeferredOrderPanel key={"deferred-print-jobs:" + printActorContext + ":" + id} title="Kolejka wydruków">
          <PrintJobsPanel
            externalWriteBlocked={detailWriteBlocked || b2bLocked}
            contextKey={printActorContext}
            readOnly={readOnly || parcelLocked}
            orderId={id}
          />
          </DeferredOrderPanel>
        </fieldset>
      </CardTabPanel>
      <CardTabPanel id="documents" active={tab}>
        <fieldset disabled={b2bLocked} className="order-plain-fieldset">
          {!replacement && !o.merge_claim && <DeferredOrderPanel key={"deferred-local-invoice:" + printActorContext + ":" + id} title="Lokalne faktury B2C"><LocalInvoicePanel order={o} contextKey={printActorContext} readOnly={readOnly} refresh={refresh} externalWriteBlocked={detailWriteBlocked || busy || parcelLocked || warehousePolicyWriteBlocked || b2bLocked} onChanged={reload} /></DeferredOrderPanel>}
          {!replacement && !o.merge_claim && <DeferredOrderPanel key={"deferred-receipt233:" + printActorContext + ":" + id} title="Paragon fiskalny"><Receipt233Panel order={o} contextKey={printActorContext} readOnly={readOnly} onChanged={reload} /></DeferredOrderPanel>}
          {!replacement && !o.merge_claim && <DeferredOrderPanel key={"deferred-invoice230:" + printActorContext + ":" + id} title="Faktura VAT: B2B, EUR, ZW/NP/OO/OSS"><Invoice230Panel order={o} contextKey={printActorContext} readOnly={readOnly} refresh={refresh} externalWriteBlocked={detailWriteBlocked || busy || parcelLocked || warehousePolicyWriteBlocked || b2bLocked || invoiceLocked} onChanged={reload} /></DeferredOrderPanel>}
          {!replacement && !o.merge_claim && (
            <DeferredOrderPanel key={"deferred-proforma:" + printActorContext + ":" + id} title="Proforma lokalna"><ProformaPanel
              order={o}
              contextKey={packingContextKey + ':' + readOnly}
              readOnly={readOnly}
              externalWriteBlocked={detailWriteBlocked || busy || parcelLocked || invoiceLocked || consumerCreditLocked || b2bLocked}
              onChanged={reload}
            /></DeferredOrderPanel>
          )}
          {!replacement && <DeferredOrderPanel title="Faktury — Fakturownia"><InvoicePanel order={o} write={write} admin={mutationAdmin} onChanged={reload} /></DeferredOrderPanel>}
          {!replacement && <DeferredOrderPanel title="Faktury — Odoo ERP"><OdooInvoicePanel order={o} write={write} admin={mutationAdmin} /></DeferredOrderPanel>}
        </fieldset>
        {/* B2B invoices and corrections stay usable while their own recovery locks the rest of the card. */}
        <section className="order-tab-group" aria-label="Faktury B2B i korekty">
          <h3>Faktury B2B i korekty</h3>
          {!replacement && !o.merge_claim && !(['shipped', 'delivered'].includes(o.status) || b2bFa3PendingOrder(printActorContext) === id) && <p className="muted">Projekt B2B / FA(3) jest dostępny po nadaniu zamówienia.</p>}
          {!replacement && !o.merge_claim && (['shipped', 'delivered'].includes(o.status) || b2bFa3PendingOrder(printActorContext) === id) && <DeferredOrderPanel key={"deferred-b2b-fa3:" + printActorContext + ":" + id} title="Projekt B2B / FA(3)" openSignal={b2bFa3PendingOrder(printActorContext) === id ? id : undefined}><B2bFa3Projects
            key={'b2b-fa3-project:' + printActorContext + ':' + id}
            order={{ id: o.id, version: String(o.version) }} contextKey={printActorContext}
            readOnly={readOnly} refresh={refresh} transport={b2bFa3HttpTransport}
            externalWriteBlocked={detailWriteBlocked || busy || parcelLocked || invoiceLocked || consumerCreditLocked || orderPrintLocked || inboundLocked || warehousePolicyWriteBlocked || b2bIssuedLocked || b2bCreditLocked}
            onApprovedProject={project => setApprovedB2b(current => project ? current?.context === printActorContext && current.order === id && current.project === project ? current : {context:printActorContext,order:id,project} : current?.context === printActorContext && current.order === id ? null : current)}
          /></DeferredOrderPanel>}
          {!replacement && !o.merge_claim && invoiceProjectId && <B2bInvoiceIssuePanel
            key={'b2b-issued-invoice:' + printActorContext + ':' + invoiceProjectId}
            projectId={invoiceProjectId} contextKey={printActorContext} readOnly={readOnly}
            refresh={refresh} transport={b2bInvoiceTransport}
            onSelectInvoice={document => setIssuedOriginal({context:printActorContext,order:document.order_id,document:document.id})}
            externalWriteBlocked={detailWriteBlocked || busy || parcelLocked || invoiceLocked || consumerCreditLocked || orderPrintLocked || inboundLocked || warehousePolicyWriteBlocked || b2bProjectLocked || b2bCreditLocked}
          />}
          {!replacement && !o.merge_claim && correctionOriginalId && <B2bCorrectionIssuePanel
            key={'b2b-correction:' + printActorContext + ':' + correctionOriginalId}
            originalDocumentId={correctionOriginalId} contextKey={printActorContext} readOnly={readOnly}
            refresh={refresh} transport={b2bCorrectionTransport}
            externalWriteBlocked={detailWriteBlocked || busy || parcelLocked || invoiceLocked || consumerCreditLocked || orderPrintLocked || inboundLocked || warehousePolicyWriteBlocked || b2bProjectLocked || b2bIssuedLocked}
          />}
        </section>
      </CardTabPanel>
      <CardTabPanel id="more" active={tab}>
        <fieldset disabled={b2bLocked} className="order-plain-fieldset">
          <section className="order-tab-group" aria-label="Szczegóły płatności">
            <h3>Szczegóły płatności</h3>
            {replacement ? (
              <p className="muted">Wymiana reklamacyjna nie ma płatności.</p>
            ) : (
              <>
                <PaymentsPanel order={o} write={write} admin={mutationAdmin} readOnly={readOnly} onChanged={reload} />
                <PayuSessionsPanel key={'payu:' + o.id} order={o} write={write} admin={mutationAdmin} readOnly={readOnly} onChanged={reload} />
              </>
            )}
            {admin && o.channel_id && ['woocommerce', 'allegro', 'prestashop'].includes(o.source) && (
              <SourcePaymentsPanel key={'source-payments:' + o.id} order={o} readOnly={readOnly} onChanged={reload} />
            )}
          </section>
          <section className="order-tab-group" aria-label="Pochodzenie i podział zamówienia">
            <h3>Pochodzenie i podział zamówienia</h3>
            <OrdersMergeLineage
              orderId={id}
              contextKey={packingContextKey}
              readOnly={readOnly}
              onOpenOrder={onOpenOrder}
            />
            <OrderSplitDetailPanel available={splitAvailable} order={o} contextKey={packingContextKey}
              readOnly={readOnly || !write || detailWriteBlocked || warehousePolicyWriteBlocked || orderPrintLocked || inboundLocked}
              onOpenOrder={onOpenOrder} onRefresh={reload}/>
            <OrderSplitLineage orderId={o.id} events={o.events} contextKey={packingContextKey} readOnly={readOnly}
              onOpenOrder={orderId=>{reload();onOpenOrder(orderId);}}/>
            {split222Available && <DeferredOrderPanel key={'deferred-split222:' + printActorContext + ':' + id} title="Podział zamówienia" openSignal={hasPendingSplit222(packingContextKey, id) ? id : undefined}>
              <OrderSplit222Panel order={o} contextKey={packingContextKey}
                writeBlocked={readOnly || !write || detailWriteBlocked || warehousePolicyWriteBlocked || orderPrintLocked || inboundLocked}
                onOpenOrder={orderId=>{reload();onOpenOrder(orderId);}} onChanged={reload}/>
            </DeferredOrderPanel>}
          </section>
        </fieldset>
      </CardTabPanel>
      <CardTabPanel id="address" active={tab}>
        <fieldset disabled={b2bLocked} className="order-plain-fieldset">
          <BuyerAddressPanel
            key={'buyer-address:' + printActorContext + ':' + id}
            orderId={id} contextKey={printActorContext} readOnly={readOnly}
            admin={admin} refresh={refresh}
            externalWriteBlocked={detailWriteBlocked || busy || parcelLocked || invoiceLocked || consumerCreditLocked || orderPrintLocked || inboundLocked || warehousePolicyWriteBlocked || b2bLocked}
            onChanged={reload}
          />
        </fieldset>
      </CardTabPanel>
      </fieldset>
      {printShipmentId && <ShipmentLabelPrintPanel
        externalWriteBlocked={detailWriteBlocked || b2bLocked}
        key={printActorContext + ":" + id + ":" + printShipmentId}
        contextKey={printActorContext} readOnly={readOnly || parcelLocked}
        orderId={id} shipmentId={printShipmentId} onClose={() => setPrintShipmentId(null)}
      />}
      {confirmSave && (
        <SectionConfirmDialog
          section={confirmSave.section}
          changes={confirmSave.changes}
          notes={confirmNotes}
          busy={detailWriteBlocked}
          onBack={() => setConfirmSave(null)}
          onConfirm={() => void saveSection()}
        />
      )}
      {switchTo && activeEdit && (
        <SectionSwitchDialog
          from={activeEdit.section}
          to={switchTo}
          onClose={() => setSwitchTo(null)}
          onDiscard={() => { const target = switchTo; setSwitchTo(null); openEdit(target); }}
          onSave={() => { const target = switchTo; setSwitchTo(null); prepareSave(target); }}
        />
      )}
      {compose && write && <OrderMessageDialog order={o} kind={compose} blocked={detailWriteBlocked || b2bLocked || !detail.canWrite()} onClose={() => setCompose(null)} onSent={() => { detail.reload(); reload(); notify('Wiadomość zapisana w kolejce.'); }} />}
    </>
  );
}
