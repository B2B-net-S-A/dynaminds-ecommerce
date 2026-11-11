import {CrmWorkspace} from './crm';
import { reconcileUnknownOrderMutation } from './order-mutation-reconciliation';
import {MiraklConnectionFields} from './mirakl-connection-fields';
import {MiraklReadsPanel} from './mirakl-reads';
import {Mirakl262Panel} from './mirakl262-panel';
import {largeImportCustody as largeImportPimCustody} from '../shared/large-import-dependencies/pim-large-import-job-flow-ui2/model';
import {workspaceCustody} from './large-import/workspace';
import {completeReviewLocked} from '../shared/large-import-dependencies/pim-large-import-complete-file-review-ui2/model';
import {usePimParentLock,pimEditorLocked,type PimContext} from './pim/parent';
import {ManualInventoryOffPanel,subscribeManualOffLock,manualOffLocked as manualInventoryOffLocked} from './manual-inventory-off';
import { DeferredOrderPanel } from './deferred-order-panel';
import { DeferredPrintPanel } from './deferred-print-panel';
import { OrdersMergeLineage } from './order-merges';
import { OrderFiltersPanel } from './order-filters-panel';
import { activeFilterCount, emptyFilters, filtersFromQuery, filtersToApiParams, filtersToQuery, type OrderFilters } from './order-filters';
import { readListQuery, statusInPath, writeListQuery } from './orders-list-url';
import { OrdersBulkBar } from './orders-bulk-bar';
import { ManualAutomationButtons } from './automation-manual-buttons';
import { AutomationNotifications } from './automation-v2-notifications';
import { OrderTable, orderSourceLabel } from './orders-list-table';
import { allOrders, orderStatusBreadcrumb, orderStatusFilterSummary, orderStatusLabel, ordersCountLabel, polishCount, type OrderStatusFilter } from './order-status-panel';
import { resetStocktakeAdjustmentsContext, subscribeStocktakeAdjustmentsLock, stocktakeAdjustmentsLocked } from './stocktake-adjustments';
import { WarehouseDocumentRegister } from './warehouse-document-register';
import { CatalogStockCountRegister } from './catalog-stock-count-register';
import { WarehouseWzIssuedDocuments } from './warehouse-wz-issued-documents';
import { warehouseWzIssuedReader } from './warehouse-wz-issued-reader';
import { CatalogStockControlPanel, resetCatalogStockControlContext, catalogStockControlLocked, subscribeCatalogStockControlLock } from './catalog-stock-control-panel';
import { WarehouseAutomaticWzPanel, resetWarehouseAutomaticWzContext,
  warehouseAutomaticWzLocked, subscribeWarehouseAutomaticWzLock } from './warehouse-automatic-wz';
import { resetReturnDestinationsIntakeContext, subscribeReturnDestinationsIntakeLock,
  returnDestinationsIntakeWriteLocked } from './return-destinations-intake';
import { ReturnDestinationStatusesSettings, resetReturnDestinationStatusesContext, subscribeReturnDestinationStatusesLock,
  returnDestinationStatusesWriteLocked } from './return-destination-statuses';
import { WarehouseInventoryPoliciesPanel, resetWarehouseInventoryPoliciesContext,
  subscribeWarehouseInventoryPoliciesLock, warehouseInventoryPoliciesWriteLocked } from './warehouse-inventory-policies';
import { SalesReports } from './sales-reports';
import { ShopifyOAuthPanel } from './shopify-oauth';
import { ProductLogisticsPanel } from './product-logistics';
import { ShopifyFulfillmentPanel } from './shopify-fulfillment';
import { PasswordRecovery, takePasswordResetToken } from './password-recovery';
import { PickingWorkspace } from './picking-waves';
import { IntegrationCatalog, providerSummaries } from './integration-catalog';
import { InPostPoints } from './inpost-points';
import { NbpRates } from './nbp-rates';
import { AmazonOAuthPanel } from './amazon-oauth';
import { AccountSecurity } from './account-security';
import { MfaGate, WorkspaceSecurityPolicy } from './workspace-security';
import { EbayFulfillmentSchedulePanel } from './ebay-fulfillment-schedules';
import { AmazonFulfillmentPanel } from './amazon-fulfillment';
import { AmazonMcfReadOnlyPanel } from './amazon-mcf-readonly';
import { EbayFulfillmentPanel } from './ebay-fulfillment';
import { B2bNetwork } from './b2b-network';
import { B2bSupplierDirectory } from './b2b-supplier-directory';
import { resetB2bCatalogScopeContext, subscribeB2bCatalogScopeLock, b2bCatalogScopeWriteLocked } from './b2b-catalog-scope';
import { B2bDropshippingOrderScope } from './b2b-network-dropshipping';
import {
  B2bExternalOrderCreate,
  B2bExternalOrderIntents,
  resetExternalOrderIntentContext,
} from './b2b-external-order-intents';
import { EbayOAuthPanel } from './ebay-oauth';
import { B2bPanel, B2bPortal } from './b2b';
import { InventoryPanel, StockPicker } from './inventory';
import { Stocktakes } from './stocktakes';
import { WmsStocktakesPanel } from './wms-stocktakes';
import { SmsPanel } from './sms';
import { EmailPanel } from './email';
import { CustomerMessages } from './customer-messages';
import { OrderCommunicationTimeline } from './messages-order-timeline';
import { BuyerAddressPanel } from './buyer-address';
import { OrderSplitPanel } from './order-split-panel';
import { OrderSplitLineage } from './order-split-lineage';
import { OrderSplit222Panel, hasPendingSplit222 } from './order-split222-panel';
import { OrderDetail } from './order-card';
import { EmailInboundWorkspace, resetEmailInboundContext, subscribeEmailInboundLock } from './email-inbound';
import { CustomerMessageWorkflows } from './customer-message-workflows';
import { AutomationSchedules } from './automation-schedules';
import { LocalAutomationDemo } from './local-automation-demo';
import { AdminProductRules } from './product-rules';
import { AdminPaymentImports } from './payment-imports';
import { canEditAutomations, isAccountant, roleLabel } from './roles';
import { OrderPackingLabelSetting } from './order-settings';
import { resetPaymentImportAllocationsContext } from './payment-import-allocations';
import {
  ProformaPanel,
  ProformaSeriesPanel,
  resetProformaContext,
  subscribeProformaLock,
} from './proformas';
import { TaxOssSettingsPanel } from './tax-oss-settings';
import { NbpRatesPanel } from './nbp227-rates';
import { RodoPage } from './rodo228';
import { JpkFilesPanel } from './jpk-files';
import { KsefQueuePanel, KsefSettingsPanel } from './ksef229';
import { PurchaseInvoicesPanel } from './ksef243';
import './ksef229.css';
import './ksef243.css';
import { LocalInvoicePanel, LocalInvoiceRegister, resetLocalInvoicesContext, subscribeLocalInvoicesLock, localInvoicesLocked } from './local-invoices';
import { Invoice230Panel, Invoice230Register } from './invoice230';
import { Invoice232Register } from './invoice232';
import { FiscalPrinterSettingsPanel, Receipt233Panel } from './receipt233';
import {LocalConsumerCreditRegister,subscribeConsumerCreditsLock,consumerCreditsLocked} from './local-consumer-credits';
import { SettlementReport } from './settlement-report';
import { B2bFa3Projects, b2bFa3ProjectLocked, b2bFa3PendingOrder, subscribeB2bFa3ProjectLock } from './b2b-fa3-projects';
import { b2bFa3HttpTransport } from './b2b-fa3-http';
import { B2bInvoiceIssuePanel, B2bInvoiceRegister, b2bInvoiceLocked, b2bInvoicePendingProject, b2bInvoicePendingOrder, subscribeB2bInvoiceLock } from './b2b-invoices';
import { createB2bInvoiceHttp159 } from './b2b-invoice-http';
import { B2bCorrectionIssuePanel, B2bCorrectionRegister, b2bCorrectionLocked, b2bCorrectionPendingOriginal, b2bCorrectionPendingOrder, subscribeB2bCorrectionLock } from './b2b-corrections';
import { createB2bCorrectionHttp160 } from './b2b-correction-http';
import { PrintJobsPanel, resetPrintJobsContext, subscribePrintJobsLock, getPrintJobsMutationState } from './print-jobs';
import { OrderParcelsPanel, resetOrderParcelsContext, getOrderParcelsLocked, subscribeOrderParcelsLock } from './order-parcels';
import { ShipmentLabelPrintPanel } from './shipment-label-print';
import { OrderFieldBatches } from './order-field-batches';
import { OrderFieldMappings } from './order-field-mappings';
import {
  AdminOrderFields,
  OrderFieldsPanel,
  OrderInitialFields,
  OrderFieldListControls,
  OrderFieldCell,
  type OrderFieldListSelection,
  type InitialOrderFieldsState,
} from './order-fields';
import { StockLocations } from './stock-locations';
import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  LayoutDashboard,
  ShoppingBag,
  Package,
  Warehouse,
  PlugZap,
  Zap,
  FileText,
  ShieldCheck,
  Settings,
  Search,
  Plus,
  ArrowUpRight,
  ChevronRight,
  ChevronDown,
  LogOut,
  ArrowLeft,
  Check,
  ScanLine,
  Truck,
  X,
  RefreshCw,
  ExternalLink,
  Box,
  BarChart3,
  AlertCircle,
  LoaderCircle,
  ArrowDownToLine,
  Printer,
  Building2,
  Code2,
  MessagesSquare,
} from 'lucide-react';
import { api, ApiError, money, date, statusNames, setWorkspace, setRegion } from './api';
import { WorkspaceSwitcher, WorkspaceSettings, invitedToken } from './workspaces';
import { DeveloperPanel } from './developer';
import { CatalogSourcePanel, resetCatalogSourceContext } from './catalog-source';
import './styles.css';
import './integration-workspace.css';
import { IntegrationVerificationHistory } from './integration-workspace';
import { IntegrationRecoveryQueue, type RecoveryIdentity } from './integration-recovery-queue';
import { integrationRecoveryTransport } from './integration-recovery-transport';
import './workspace-security.css';
import {
  AutomationStudio,
  OrderOperationsPanel,
  WorkflowBadge,
} from './operations';
import { OrderChannelStatus, OrderStatusConfig } from './order-status';
import { fulfilmentLabels, isFulfilmentStage, paymentLabels } from './order-stage';
import { FulfilmentBadge } from './order-status-badges';
import { InvoicePanel } from './invoices';
import { OdooInvoicePanel } from './odoo-invoices';
import { ReturnsPanel, type ReturnReceiveFocus } from './returns';
import { PaymentsPanel } from './payments';
import { PayuSessionsPanel, PayuSettings } from './payu';
import { ChannelInbox } from './channel-inbox253';
import { InboundSchedules } from './inbound-schedule253';
import { PortalLinkPolicy } from './portal-link-policy253';
import { SourcePaymentsPanel } from './source-payments';
import { ReturnQueue, PortalAccess } from './return-queue';
import { resetReturnAssistantContext } from './return-assistant';
import { resetReturnAssistantQueuesContext } from './return-assistant-queues';
import { PricingPanel, PriceListPicker, OrderPriceQuote } from './pricing';
import { competitorObservationsLocked, subscribeCompetitorObservationsLock } from './competitor-observations';
import { PriceFileImportWorkspace, resetPriceFileImportContext } from './price-file-import';
import { PriceMatrixImportWorkspace, resetPriceMatrixImportContext } from './price-matrix-import';
import { resetSupplierFileSourcesContext } from './supplier-file-sources';
import { resetSupplierRemoteFeedsContext } from './supplier-remote-feeds';
import {
  LanguageFileImportWorkspace,
  resetLanguageFileImportContext,
  subscribeLanguageFileImportLock,
} from './language-file-import';
import {
  StockFileImportWorkspace,
  resetStockFileImportContext,
  subscribeStockFileImportLock,
} from './stock-file-import';
import { ImportQueue } from './imports';
import { resetExternalImportContext } from './b2b-external-order-imports';
import { resetDropshipReturnContext } from './b2b-dropshipping-returns';
import { SyncPanel } from './sync';
import { CatalogPanel, NewProductModal, ProductPicker } from './catalog';
import {LocalSimulationOffer} from './local-simulation-offer';
import { ProductCatalogsPanel, resetProductCatalogsContext, subscribeProductCatalogsLock } from './product-catalogs';
import { resetCatalogExportContext, subscribeCatalogExportLock, catalogExportLocked } from './catalog-export';
import { WarehouseDocuments } from './warehouse';
import { ShippingPanel } from './shipping';
import { DpdShippingPanel } from './dpd-shipping';
import { CarrierShippingPanel } from './carrier-shipping';
import { DhlPickups } from './dhl-pickups';
import {
  PackingWorkstationPanel,
  AdminPackingSettings,
  type PackingParcelSeed,
} from './packing-workstation';
import { DpdCollections } from './dpd-collections';
import { OffersPanel } from './offers';
import {ConfiguredWooStores} from './configured-woo';
import { TrackingPanel } from './tracking';
import { Purchasing } from './purchasing';
import { WmsLotsWorkspace, WmsOrderLotsPanel } from './wms-lots';
import { orderScanBody, orderScanErrorMessage } from './order-scan';
import { AuditLog } from './audit-log';
import { WmsApp, useWmsRoute } from './wms-app';
import { PAGE_SLUGS, navigateTo, orderStatusPath, pagePath, parseAppPath, type AppRoute, type RoutePage } from './app-route';
import { useAppRouteSync } from './app-route-sync';
import { defaultTarget, hasPanel, moduleOfPage, readPanelHidden, visibleModules, writePanelHidden, type NavModule, type NavTarget } from './module-nav-config';
import { ModuleMenu, ModuleOptionsPanel, NavBreadcrumb, OrdersNavPanel, useOrderStatusNav } from './module-nav';
type Page =
  | 'dashboard'
  | 'orders'
  | 'picking'
  | 'returns'
  | 'b2b'
  | 'b2bNetwork'
  | 'pricing'
  | 'products'
  | 'inventory'
  | 'wmsLots'
  | 'wmsStocktakes'
  | 'purchasing'
  | 'integrations'
  | 'sms'
  | 'email'
  | 'crm'
  | 'customerMessages'
  | 'automations'
  | 'productRules'
  | 'paymentImports'
  | 'orderFields'
  | 'orderFieldBatches'
  | 'orderFieldMappings'
  | 'documents'
  | 'reports'
  | 'audit'
  | 'rodo'
  | 'developer'
  | 'settings';
type Notice = (message: string, error?: boolean) => void;
const pages: { id: Page; label: string; icon: typeof LayoutDashboard; group: string }[] = [
  { id: 'dashboard', label: 'Przegląd', icon: LayoutDashboard, group: 'workspace' },
  { id: 'orders', label: 'Zamówienia', icon: ShoppingBag, group: 'workspace' },
  { id: 'picking', label: 'Kompletacja', icon: ScanLine, group: 'workspace' },
  { id: 'returns', label: 'Zwroty i reklamacje', icon: ShoppingBag, group: 'workspace' },
  { id: 'paymentImports', label: 'Przelewy i pobrania', icon: FileText, group: 'workspace' },
  { id: 'crm', label: 'Klienci CRM', icon: Building2, group: 'workspace' },
  { id: 'b2bNetwork', label: 'Sieć B2B', icon: Building2, group: 'workspace' },
  { id: 'b2b', label: 'Kontrahenci B2B', icon: Building2, group: 'workspace' },
  { id: 'pricing', label: 'Cenniki', icon: Package, group: 'catalog' },
  { id: 'products', label: 'Produkty', icon: Package, group: 'catalog' },
  { id: 'inventory', label: 'Magazyny', icon: Warehouse, group: 'catalog' },
  { id: 'wmsLots', label: 'Partie i FIFO', icon: Warehouse, group: 'catalog' },
  { id: 'wmsStocktakes', label: 'Inwentaryzacje partii', icon: Warehouse, group: 'catalog' },
  { id: 'purchasing', label: 'Zakupy i dostawy', icon: Truck, group: 'catalog' },
  { id: 'integrations', label: 'Integracje', icon: PlugZap, group: 'system' },
  { id: 'email', label: 'Komunikacja email', icon: FileText, group: 'system' },
  { id: 'customerMessages', label: 'Wiadomości klientów', icon: MessagesSquare, group: 'system' },
  { id: 'sms', label: 'Komunikacja SMS', icon: Zap, group: 'system' },
  { id: 'automations', label: 'Automatyzacje', icon: Zap, group: 'system' },
  { id: 'orderFields', label: 'Pola zamówień', icon: FileText, group: 'system' },
  { id: 'orderFieldBatches', label: 'Pola — import i operacje', icon: FileText, group: 'system' },
  { id: 'orderFieldMappings', label: 'Pola — mapowania kanałów', icon: FileText, group: 'system' },
  { id: 'productRules', label: 'Reguły produktów', icon: Zap, group: 'system' },
  { id: 'documents', label: 'Dokumenty', icon: FileText, group: 'system' },
  { id: 'reports', label: 'Raporty', icon: BarChart3, group: 'system' },
  { id: 'audit', label: 'Historia operacji', icon: ShieldCheck, group: 'system' },
  { id: 'rodo', label: 'RODO', icon: ShieldCheck, group: 'system' },
  { id: 'developer', label: 'API i webhooki', icon: Code2, group: 'system' },
  { id: 'settings', label: 'Ustawienia', icon: Settings, group: 'system' },
];
const descriptions: Record<Page, string> = {
  dashboard: 'Wszystkie kanały. Jeden widok na Twój biznes.',
  orders: 'Zarządzaj realizacją zamówień z jednego miejsca.',
  picking: 'Skanuj produkty i przygotowuj zamówienia do wysyłki.',
  returns: 'Rozpatruj zgłoszenia i kontroluj rozliczenia zwrotów.',
  crm: 'Kartoteka klientów, statusy i dodatkowe dane.',
  b2bNetwork: 'Współpraca między firmami i katalogi dostawców.',
  b2b: 'Warunki współpracy i zamówienia kontrahentów.',
  pricing: 'Ceny sprzedaży według kanału i waluty.',
  products: 'Twój katalog produktów i dostępność w magazynach.',
  inventory: 'Kontroluj stany, rezerwacje i ruchy towarów.',
  wmsLots: 'Śledź partie, ich pochodzenie i koszt zapasu.',
  wmsStocktakes: 'Policz partie, sprawdź różnice i rozlicz zapas z ochroną rezerwacji.',
  purchasing: 'Planuj zakupy i przyjmuj dostawy do magazynu.',
  integrations: 'Połącz sprzedaż, dostawy i księgowość.',
  email: 'Szablony, konta SMTP i historia wiadomości do kupujących.',
  customerMessages: 'Rozmowy w portalu, skrzynka email i odpowiedzi SMTP do kupujących.',
  sms: 'Szablony, podgląd wiadomości i historia kontaktu.',
  automations: 'Zdarzenia, które uruchamiają pracę za Ciebie.',
  productRules: 'Warunki i akcje dla lokalnych kategorii i atrybutów produktów.',
  orderFields: 'Zaprojektuj własne pola, wartości i prywatne załączniki zamówień.',
  orderFieldBatches: 'Importuj, przeglądaj i eksportuj lokalne pola zamówień.',
  orderFieldMappings: 'Wersjonowane mapowania źródeł kanałów i jawne uzgodnienie własnych pól.',
  paymentImports: 'Dopasuj wpłaty z pliku i zatwierdź rozliczenie zamówień.',
  documents: 'Dokumenty sprzedaży, korekty i faktury z integracji księgowej.',
  reports: 'Sprzedaż, przyjęte zwroty i koszt towaru według okresu, magazynu i waluty.',
  audit: 'Sprawdź, kto i kiedy wykonał operację.',
  rodo: 'Rejestr dostępu do danych osobowych, eksport i anonimizacja danych klientów.',
  developer: 'Połącz własne narzędzia z zamówieniami, katalogiem i magazynem.',
  settings: 'Organizacja, magazyny i konfiguracja lokalnego środowiska.',
};
function Badge({ status }: { status: string }) {
  // Order stages get the semantic order badge; channel modes and states keep the generic one.
  if (isFulfilmentStage(status)) return <FulfilmentBadge stage={status} />;
  return (
    <span className={`badge status-${status}`}>
      {statusNames[status] ??
        (
          {
            demo: 'DEMO',
            verified_read: 'Odczyt potwierdzony',
            not_verified: 'Do weryfikacji',
            awaiting_oauth: 'Połącz konto',
            shopify_oauth_pending: 'Trwa zgoda Shopify',
            shopify_reauthorization_required: 'Wymagana nowa zgoda Shopify',
            amazon_oauth_pending: 'Trwa zgoda Amazon',
            authorized_read: 'Dostęp autoryzowany',
            simulation: 'Przykład lokalny',
            sync_configuration_error: 'Sprawdź uprawnienia',
            error: 'Błąd połączenia',
            sandbox: 'Sandbox',
            live: 'API produkcyjne',
          } as Record<string, string>
        )[status] ??
        status}
    </span>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <Box size={30} />
      <p>{children}</p>
    </div>
  );
}
function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={24} /> Wczytywanie danych…
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);
  return (
    <div className="modal-shade" onClick={onClose}>
      <section
        className={className ? 'modal ' + className : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Zamknij" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function useData(path: string, refresh = 0, enabled = true) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    setData(null);
    if (!enabled) return () => { active = false; };
    api(path)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [path, refresh, enabled]);
  return { data, error };
}
function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="error-block">
      <AlertCircle size={18} />
      {message}
    </div>
  );
}
function Form({
  onSubmit,
  children,
  submit = 'Zapisz',
  disabled = false,
}: {
  onSubmit: (data: FormData) => Promise<void>;
  children: ReactNode;
  submit?: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(new FormData(e.currentTarget));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send}>
      {children}
      {error && <ErrorBlock message={error} />}
      <footer className="form-footer">
        <button className="button primary" disabled={busy || disabled}>
          {busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />} {submit}
        </button>
      </footer>
    </form>
  );
}
const f = (d: FormData, key: string) => String(d.get(key) ?? '');
// Seed-account hints only in the vite dev server: a packaged release has no such accounts.
const devLoginHints = import.meta.env.DEV;
function Login({ onLogin }: { onLogin: (u: any) => void }) {
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState<'login' | 'signup'>('login'),
    [invite, setInvite] = useState(invitedToken),
    [mfaRequired, setMfaRequired] = useState(false);
  useEffect(() => {
    const onInvitation = () => setInvite(invitedToken());
    window.addEventListener('hashchange', onInvitation);
    return () => window.removeEventListener('hashchange', onInvitation);
  }, []);
  if (recovering) return <PasswordRecovery onBack={() => setRecovering(false)} />;
  return (
    <div className="login-page">
      <div className="login-brand">
        <div className="brand-mark">
          D<span>•</span>
        </div>
        <span>
          DYNAMINDS <small>Ecommerce</small>
        </span>
      </div>
      <section className="login-card">
        <div className="eyebrow">TWOJE CENTRUM OPERACJI</div>
        <h1>{mode === 'signup' ? 'Twoja firma. Jeden system.' : 'Sprzedaż pod kontrolą.'}</h1>
        <p>Zamówienia, produkty i magazyny w jednym miejscu.</p>
        <div className="auth-tabs">
          <button
            className={mode === 'login' ? 'active' : ''}
            onClick={() => {
              setMode('login');
              setMfaRequired(false);
              setError('');
            }}
          >
            Logowanie
          </button>
          <button
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => {
              setMode('signup');
              setMfaRequired(false);
              setError('');
            }}
          >
            Utwórz konto
          </button>
        </div>
        <form
          key={mode}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            const data = new FormData(e.currentTarget);
            try {
              const result = await api(mode === 'signup' ? '/auth/signup' : '/auth/login', 'POST', {
                email: f(data, 'email'),
                password: f(data, 'password'),
                ...(mode === 'login' && mfaRequired ? { code: f(data, 'code') } : {}),
                ...(mode === 'signup'
                  ? {
                      name: f(data, 'name'),
                      ...(invite
                        ? { invitation_token: invite }
                        : {
                            organization: {
                              name: f(data, 'organization'),
                              currency: f(data, 'currency'),
                              locale: 'pl-PL',
                            },
                          }),
                    }
                  : invite
                    ? { invitation_token: invite }
                    : {}),
              });
              if (result.mfa_required) {
                setMfaRequired(true);
                return;
              }
              if (invite) history.replaceState(null, '', location.pathname);
              onLogin(result.user);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Adres email
            <input
              name="email"
              type="email"
              defaultValue={devLoginHints && mode === 'login' && !invite ? 'admin@demo.local' : ''}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Hasło
            <input
              name="password"
              type="password"
              defaultValue={devLoginHints && mode === 'login' && !invite ? 'DynaDemo!2026' : ''}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={mode === 'signup' ? 12 : 1}
              maxLength={200}
              required
            />
          </label>
          {mode === 'login' && mfaRequired && (
            <label>
              Kod z aplikacji lub kod odzyskiwania
              <input
                name="code"
                autoComplete="one-time-code"
                maxLength={80}
                required
                autoFocus
                spellCheck={false}
              />
              <small>
                Kod działa tylko raz. Jeśli został użyty, poczekaj na następny kod w aplikacji.
              </small>
            </label>
          )}
          {mode === 'signup' && (
            <label>
              Imię i nazwisko
              <input name="name" autoComplete="name" minLength={2} maxLength={100} required />
            </label>
          )}
          {mode === 'signup' && !invite && (
            <>
              <label>
                Nazwa organizacji
                <input name="organization" minLength={2} maxLength={100} required />
              </label>
              <label>
                Waluta
                <select name="currency">
                  {['PLN', 'EUR', 'USD', 'GBP', 'CZK'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <p className="muted">
                Pusty katalog, magazyn MAIN i plan Starter. Wszystko lokalnie, bez opłat.
              </p>
            </>
          )}
          {invite && (
            <p className="info-callout">
              Dołączasz przez zaproszenie. Użyj wskazanego w nim adresu email.
              {mode === 'signup' ? ' Hasło: co najmniej 12 znaków.' : ''}
            </p>
          )}
          {invite && (
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                setInvite('');
                history.replaceState(null, '', location.pathname);
                setWorkspace(null);
              }}
            >
              Wyczyść zaproszenie
            </button>
          )}
          {error && <ErrorBlock message={error} />}
          <button className="button primary full" disabled={busy}>
            {busy
              ? 'Zapisywanie…'
              : mode === 'signup'
                ? 'Utwórz konto'
                : invite
                  ? 'Zaloguj i dołącz'
                  : 'Zaloguj się'}
            <ArrowUpRight size={18} />
          </button>
        </form>
        {mode === 'login' && (
          <button
            type="button"
            className="button ghost full"
            disabled={busy}
            onClick={() => setRecovering(true)}
          >
            Nie pamiętam hasła
          </button>
        )}
        <div className="demo-note">
          <span className="dot" /> Środowisko lokalne · dane demonstracyjne
        </div>
        {devLoginHints && (
          <details>
            <summary>Konta demonstracyjne</summary>
            <p>
              admin@demo.local — administrator
              <br />
              operator@demo.local — magazynier
              <br />
              viewer@demo.local — tylko odczyt
              <br />
              other@demo.local — druga firma
              <br />
              Hasło: DynaDemo!2026
            </p>
          </details>
        )}
      </section>
      <div className="login-foot">DYNAMINDS Ecommerce / Local workspace</div>
    </div>
  );
}
// Capture once outside React rendering: StrictMode may invoke state initializers twice.
const initialPasswordResetToken = takePasswordResetToken();
// Every page has an address (app-route.ts); both directions are checked at compile time.
const pageAddresses: Record<Page, string> = PAGE_SLUGS;
const routePageIsPage = (p: RoutePage): Page => p;
void pageAddresses;
/** Invitation (hash) and integration return (?integration=) keep their old landing pages. */
const initialRoute: AppRoute = invitedToken()
  ? { kind: 'page', page: 'settings' }
  : ['connected', 'ebay_denied'].includes(new URLSearchParams(location.search).get('integration') ?? '')
    ? { kind: 'page', page: 'integrations' }
    : parseAppPath(location.pathname);
const initialPage: Page =
  initialRoute.kind === 'page' ? routePageIsPage(initialRoute.page) : initialRoute.kind === 'orders' || initialRoute.kind === 'order' ? 'orders' : 'dashboard';
function App() {
  const [resetToken, setResetToken] = useState(initialPasswordResetToken);
  const wms = useWmsRoute();
  useEffect(() => {
    const onReset = () => {
      const token = takePasswordResetToken();
      if (token) setResetToken(token);
    };
    window.addEventListener('hashchange', onReset);
    return () => window.removeEventListener('hashchange', onReset);
  }, []);
  const [user, setUser] = useState<any>(null),
    [checked, setChecked] = useState(false),
    [page, setPage] = useState<Page>(initialPage),
    [selected, setSelected] = useState<string | null>(null),
    [mergeProposal, setMergeProposal] = useState<{ ids: string[]; token: number } | null>(null),
    [refresh, setRefresh] = useState(0),
    [modal, setModal] = useState<string | null>(null),
    [integrationProvider, setIntegrationProvider] = useState('allegro'),
    [toast, setToast] = useState<{ message: string; error: boolean } | null>(null),
    [search, setSearch] = useState(''),
    [orderListIds, setOrderListIds] = useState<string[]>([]),
    [orderFilter, setOrderFilter] = useState<OrderStatusFilter>(initialRoute.kind === 'orders' ? initialRoute.filter : allOrders),
    [restorePreview, setRestorePreview] = useState(false),
    [workspaceMfaAvailable, setWorkspaceMfaAvailable] = useState(false),
    [pickingWavesAvailable, setPickingWavesAvailable] = useState(false),
    [returnDestinationsAvailable, setReturnDestinationsAvailable] = useState(false),
    [stocktakeAdjustmentsAvailable, setStocktakeAdjustmentsAvailable] = useState(false),
    [automaticWzConfigurationAvailable, setAutomaticWzConfigurationAvailable] = useState(false);
  const [automaticWzIssuerAvailable, setAutomaticWzIssuerAvailable] = useState(false);
  const [catalogStockControlAvailable, setCatalogStockControlAvailable] = useState(false);
  const [catalogStockControlWriteLocked, setCatalogStockControlWriteLocked] = useState(false);
  const [blindStocktakeScope, setBlindStocktakeScope] = useState<string | null>(null);
  const [quantityNavigationLockedScope, setQuantityNavigationLockedScope] = useState<string | null>(null);
  const [priceFileImportLocked, setPriceFileImportLocked] = useState(false);
  const [priceMatrixImportLocked, setPriceMatrixImportLocked] = useState(false);
  const [competitorObservationLocked, setCompetitorObservationLocked] = useState(false);
  const [stockFileImportLocked, setStockFileImportLocked] = useState(false);
  const [languageFileImportLocked, setLanguageFileImportLocked] = useState(false);
  const [emailInboundLocked, setEmailInboundLocked] = useState(false);
  const [productCatalogsLocked, setProductCatalogsLocked] = useState(false);
  const [catalogExportPending, setCatalogExportPending] = useState(false);
  const [b2bCatalogScopeLocked, setB2bCatalogScopeLocked] = useState(false);
  const [warehousePolicyLocked, setWarehousePolicyLocked] = useState(false);
  const [returnDestinationSettingsLocked, setReturnDestinationSettingsLocked] = useState(false);
  const [returnDestinationsIntakeLocked, setReturnDestinationsIntakeLocked] = useState(false);
  const [stocktakeAdjustmentsWriteLocked, setStocktakeAdjustmentsWriteLocked] = useState(false);
  const [catalogProductFocus,setCatalogProductFocus]=useState<{id:string;token:number}|null>(null);
  const [pimAvailable,setPimAvailable]=useState(false);
  const [localWooFlowAvailable,setLocalWooFlowAvailable]=useState(false);
  const [largeImportAvailable,setLargeImportAvailable]=useState(false);
  const [largeImportUnavailableReason,setLargeImportUnavailableReason]=useState<string|null>(null);
  const [largeImportCapabilityScope,setLargeImportCapabilityScope]=useState('');
  const [orderSplitCapability,setOrderSplitCapability]=useState<{scope:string;available:boolean}|null>(null);
  const [orderSplit222Capability,setOrderSplit222Capability]=useState<{scope:string;available:boolean}|null>(null);
  const [largeImportCreates,setLargeImportCreates]=useState(false);
  const [largeImportLocked,setLargeImportLocked]=useState(false);
  const [pimNestedMappingAvailable,setPimNestedMappingAvailable]=useState(false);
  const [manualOffLocked, setManualOffLocked] = useState(false);
  const [automaticWzWriteLocked, setAutomaticWzWriteLocked] = useState(false);
  const [stocktakeAdjustmentsCapabilityKnown, setStocktakeAdjustmentsCapabilityKnown] = useState(false);
  const [emailInboundFocus, setEmailInboundFocus] = useState<{ id: string; token: number } | undefined>();
  const [customerThreadFocus, setCustomerThreadFocus] = useState<{ id: string; token: number } | undefined>();
  const [adjustmentStocktakeFocus, setAdjustmentStocktakeFocus] = useState<{
    scope: string; sourceKind: 'quantity' | 'wms'; id: string; token: number;
  } | null>(null);
  const adjustmentFocusSerial = useRef(0);
  const manualOffContext = user ? {tenant_id:user.tenant_id,user_id:user.id,role:user.role,read_only:restorePreview} : null;
  const hasPendingManualOff = () => !!manualOffContext && manualInventoryOffLocked(manualOffContext);
  const pimContext:PimContext|null=user?{tenant_id:user.tenant_id,user_id:user.id,role:user.role,restore_preview:restorePreview}:null;
  const pimLocked=usePimParentLock(pimContext);
  const hasPendingPim=()=>!!pimContext&&pimEditorLocked(pimContext);
  const expiredActorScope = useRef<string | null>(null);
  const currentActorScope = user
    ? user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview
    : '';
  const currentActorScopeRef = useRef(currentActorScope);
  currentActorScopeRef.current = currentActorScope;
  // Suspend only custody context while Login replaces the private panels.
  const stocktakeActorScope = currentActorScope || expiredActorScope.current || '';
  useEffect(()=>setLargeImportLocked(false),[stocktakeActorScope]);
  useEffect(() => {
    if (!user) { setManualOffLocked(false); return; }
    return subscribeManualOffLock({tenant_id:user.tenant_id,user_id:user.id,role:user.role,read_only:restorePreview},setManualOffLocked);
  }, [stocktakeActorScope]);
  const competitorObservationContext = user ? { tenant_id: user.tenant_id, user_id: user.id,
    role: user.role, restore_preview: restorePreview } : null;
  useEffect(() => {
    if (!competitorObservationContext) { setCompetitorObservationLocked(false); return; }
    return subscribeCompetitorObservationsLock(competitorObservationContext, setCompetitorObservationLocked);
  }, [stocktakeActorScope]);
  useEffect(() => resetExternalOrderIntentContext(stocktakeActorScope), [stocktakeActorScope]);
  useEffect(() => {
    resetPriceFileImportContext(stocktakeActorScope);
    resetPriceMatrixImportContext(stocktakeActorScope);
    resetStockFileImportContext(stocktakeActorScope);
    resetLanguageFileImportContext(stocktakeActorScope);
    resetSupplierFileSourcesContext(stocktakeActorScope);
    resetSupplierRemoteFeedsContext(stocktakeActorScope);
    resetPaymentImportAllocationsContext(stocktakeActorScope);
    resetProformaContext(stocktakeActorScope);
    resetLocalInvoicesContext(stocktakeActorScope);
    resetPrintJobsContext(stocktakeActorScope);
    resetOrderParcelsContext(stocktakeActorScope);
    resetEmailInboundContext(stocktakeActorScope);
    resetProductCatalogsContext(stocktakeActorScope);
    resetCatalogSourceContext(stocktakeActorScope);
    resetCatalogExportContext(stocktakeActorScope);
    resetB2bCatalogScopeContext(stocktakeActorScope);
    resetReturnDestinationStatusesContext(stocktakeActorScope);
    resetReturnDestinationsIntakeContext(stocktakeActorScope);
    resetStocktakeAdjustmentsContext(stocktakeActorScope);
    resetWarehouseAutomaticWzContext(stocktakeActorScope);
    resetCatalogStockControlContext(stocktakeActorScope);
    setCatalogStockControlWriteLocked(catalogStockControlLocked(stocktakeActorScope));
    setAutomaticWzWriteLocked(warehouseAutomaticWzLocked(stocktakeActorScope));
    setStocktakeAdjustmentsWriteLocked(stocktakeAdjustmentsLocked(stocktakeActorScope));
    setReturnDestinationsIntakeLocked(returnDestinationsIntakeWriteLocked(stocktakeActorScope));
    setReturnDestinationSettingsLocked(returnDestinationStatusesWriteLocked(stocktakeActorScope));
    resetWarehouseInventoryPoliciesContext(stocktakeActorScope);
    setWarehousePolicyLocked(warehouseInventoryPoliciesWriteLocked(stocktakeActorScope));
    setB2bCatalogScopeLocked(b2bCatalogScopeWriteLocked(stocktakeActorScope));
    setEmailInboundFocus(undefined);
    setCustomerThreadFocus(undefined);
    setEmailInboundLocked(false);
    setProductCatalogsLocked(false);
    setCatalogExportPending(catalogExportLocked(stocktakeActorScope));
    setPriceFileImportLocked(false);
    setPriceMatrixImportLocked(false);
    setStockFileImportLocked(false);
    setLanguageFileImportLocked(false);
  }, [stocktakeActorScope]);
  useEffect(() => subscribeEmailInboundLock(stocktakeActorScope, setEmailInboundLocked), [stocktakeActorScope]);
  useEffect(() => subscribeProductCatalogsLock(stocktakeActorScope, setProductCatalogsLocked), [stocktakeActorScope]);
  useEffect(() => subscribeCatalogExportLock(stocktakeActorScope, setCatalogExportPending), [stocktakeActorScope]);
  useEffect(() => subscribeB2bCatalogScopeLock(stocktakeActorScope, setB2bCatalogScopeLocked), [stocktakeActorScope]);
  useEffect(() => subscribeWarehouseInventoryPoliciesLock(stocktakeActorScope, setWarehousePolicyLocked), [stocktakeActorScope]);
  useEffect(() => subscribeReturnDestinationStatusesLock(stocktakeActorScope, setReturnDestinationSettingsLocked), [stocktakeActorScope]);
  useEffect(() => subscribeReturnDestinationsIntakeLock(stocktakeActorScope, setReturnDestinationsIntakeLocked), [stocktakeActorScope]);
  useEffect(() => subscribeStocktakeAdjustmentsLock(stocktakeActorScope, setStocktakeAdjustmentsWriteLocked), [stocktakeActorScope]);
  useEffect(() => subscribeWarehouseAutomaticWzLock(stocktakeActorScope, setAutomaticWzWriteLocked), [stocktakeActorScope]);
  useEffect(() => subscribeCatalogStockControlLock(stocktakeActorScope, setCatalogStockControlWriteLocked), [stocktakeActorScope]);
  useEffect(
    () => subscribeStockFileImportLock(stocktakeActorScope, setStockFileImportLocked),
    [stocktakeActorScope],
  );
  useEffect(
    () => subscribeLanguageFileImportLock(stocktakeActorScope, setLanguageFileImportLocked),
    [stocktakeActorScope],
  );

  useEffect(
    () =>
      resetExternalImportContext(
        user ? user.tenant_id + ':' + user.id + ':' + user.role : '',
        restorePreview,
      ),
    [stocktakeActorScope],
  );
  useEffect(
    () =>
      resetDropshipReturnContext(
        user ? user.tenant_id + ':' + user.id + ':' + user.role : '',
        restorePreview,
      ),
    [stocktakeActorScope],
  );
  useEffect(
    () => resetReturnAssistantContext(
      user ? user.tenant_id + ':' + user.id + ':' + user.role : '',
      restorePreview,
    ),
    [stocktakeActorScope],
  );
  useEffect(
    () => resetReturnAssistantQueuesContext(
      user ? user.tenant_id + ':' + user.id + ':' + user.role : '',
      restorePreview,
    ),
    [stocktakeActorScope],
  );
  const onBlindStocktakeChange = useCallback(
    (active: boolean) => {
      setBlindStocktakeScope((current) =>
        active ? stocktakeActorScope : current === stocktakeActorScope ? null : current,
      );
    },
    [stocktakeActorScope],
  );
  const onQuantityNavigationLockedChange = useCallback((active: boolean) => {
    setQuantityNavigationLockedScope((current) => active ? stocktakeActorScope : current === stocktakeActorScope ? null : current);
  }, [stocktakeActorScope]);
  useEffect(() => {
    const onExpired = () => {
      if (currentActorScopeRef.current) expiredActorScope.current = currentActorScopeRef.current;
      setWorkspace(null);
      setUser(null);
      setChecked(true);
      setModal(null);
      setSelected(null);
      setToast({ message: 'Sesja wygasła. Zaloguj się ponownie.', error: true });
    };
    window.addEventListener('dyna:session-expired', onExpired);
    return () => window.removeEventListener('dyna:session-expired', onExpired);
  }, []);
  useEffect(() => {
    api('/auth/me')
      .then((r) => {
        setWorkspace(r.user.tenant_id);
        setRegion(r.user);
        setUser(r.user);
      })
      .catch(() => {})
      .finally(() => setChecked(true));
  }, []);
  useEffect(() => {
    let active = true;
    setPimAvailable(false);
    setOrderSplitCapability(null);
    setOrderSplit222Capability(null);
    setLocalWooFlowAvailable(false);
    setLargeImportAvailable(false);setLargeImportCreates(false);setLargeImportUnavailableReason(null);setLargeImportCapabilityScope('');
    setReturnDestinationsAvailable(false);
    setStocktakeAdjustmentsAvailable(false);
    setAutomaticWzConfigurationAvailable(false);
    setAutomaticWzIssuerAvailable(false);
    setCatalogStockControlAvailable(false);
    setStocktakeAdjustmentsCapabilityKnown(false);
    Promise.all([api('/health'), user ? api('/auth/me').catch(() => null) : Promise.resolve(null)])
      .then(([h, scoped]) => {
        if (active) {
          setRestorePreview(!!h.restore_preview);
          setWorkspaceMfaAvailable(!!h.workspace_mfa_available);
          setPickingWavesAvailable(!!h.picking_waves_available);
          setPimAvailable(h.pim_dictionaries_available===true);
          setLocalWooFlowAvailable(h.local_woo_flow_available===true);
          setLargeImportCapabilityScope(currentActorScope);
          const sameImportContext=!!user&&scoped?.user?.id===user.id&&scoped?.user?.tenant_id===user.tenant_id&&scoped?.user?.role===user.role;
          setOrderSplitCapability({scope:currentActorScope,available:h.order_splits_available===true&&sameImportContext&&typeof h.restore_preview==='boolean'&&scoped?.restore_preview===h.restore_preview});
          const ownImportAvailable=h.large_import_available===true&&sameImportContext&&scoped?.large_import_availability?.available===true;
          setLargeImportAvailable(ownImportAvailable);
          setLargeImportCreates(ownImportAvailable&&scoped?.large_import_availability?.independent_creates===true);
          setLargeImportUnavailableReason(sameImportContext&&scoped?.large_import_availability?.reason==='LEGACY_IMPORT_RECONCILIATION_REQUIRED'?'LEGACY_IMPORT_RECONCILIATION_REQUIRED':null);
          setOrderSplit222Capability({scope:currentActorScope,available:h.order_split222_available===true&&sameImportContext});
        setPimNestedMappingAvailable(h.pim_nested_mapping_available===true);
          setReturnDestinationsAvailable(h.return_destinations_available === true);
          setStocktakeAdjustmentsAvailable(h.stocktake_adjustments_available === true);
          setAutomaticWzConfigurationAvailable(h.warehouse_automatic_wz_configuration_available === true);
          setAutomaticWzIssuerAvailable(h.warehouse_automatic_wz_issuer_available === true);
          setCatalogStockControlAvailable(h.catalog_stock_control_available === true);
          setStocktakeAdjustmentsCapabilityKnown(
            typeof h.stocktake_adjustments_available === 'boolean' ||
            (h.stocktake_adjustments_available === undefined && typeof h.schema_revision === 'string' &&
              /^\d{3}_/.test(h.schema_revision) && Number(h.schema_revision.slice(0, 3)) < 149),
          );
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [user?.id, user?.tenant_id, user?.role, restorePreview]);
  useEffect(() => {
    const onInvitation = () => {
      if (invitedToken()) {
        setPage('settings');
        setSelected(null);
        setModal(null);
      }
    };
    window.addEventListener('hashchange', onInvitation);
    return () => window.removeEventListener('hashchange', onInvitation);
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const notify: Notice = (message, error = false) => setToast({ message, error });
  useEffect(() => {
    if (!user) return;
    let active = true;
    const onRequired = (event: Event) => {
      if ((event as CustomEvent).detail.workspace !== user.tenant_id) return;
      setUser((current: any) =>
        current?.tenant_id === user.tenant_id ? { ...current, mfa_required: true } : current,
      );
      setModal(null);
      setSelected(null);
      api('/auth/me')
        .then((r) => {
          if (active) setUser(r.user);
        })
        .catch((e) => {
          if (active) notify(e.message, true);
        });
    };
    window.addEventListener('dyna:mfa-required', onRequired);
    return () => {
      active = false;
      window.removeEventListener('dyna:mfa-required', onRequired);
    };
  }, [user?.id, user?.tenant_id]);
  const reload = () => setRefresh((r) => r + 1);
  const hasPendingLargeImport=()=>!!user&&(workspaceCustody.locked({tenantId:user.tenant_id,userId:user.id,apiKeyId:null})||completeReviewLocked({tenantId:user.tenant_id,userId:user.id,apiKeyId:null})||!!largeImportPimCustody.get({tenantId:user.tenant_id,userId:user.id,apiKeyId:null}));
  // /wms opens from the nav button, the address bar or the back button; every entry respects pending operations.
  const wmsBlocked = () => hasPendingLargeImport() || hasPendingPim() || pimLocked || manualOffLocked || hasPendingManualOff();
  useEffect(() => {
    if (wms.active && user && wmsBlocked()) { notify('Najpierw dokończ rozpoczętą operację.', true); wms.refuse(); }
  }, [wms.active, user, pimLocked, manualOffLocked]);
  const changedUser = (u: any) => {
    if(hasPendingLargeImport()){notify('Najpierw rozstrzygnij oryginalną próbę dużego importu.',true);return;}
    if(hasPendingPim()){notify('Najpierw rozstrzygnij dokładną próbę parametrów produktu.',true);return;}
    const switching = !u || !user || u.tenant_id !== user.tenant_id;
    // A normal login/logout or different actor keeps the existing reset semantics.
    expiredActorScope.current = null;
    setWorkspace(u?.tenant_id ?? null);
    setRegion(u);
    setUser(u);
    setModal(null);
    setSelected(null);
    setSearch('');
    setOrderFilter(allOrders);
    setCatalogProductFocus(null);
    setToast(null);
    setAdjustmentStocktakeFocus(null);
    if (switching) setPage(invitedToken() ? 'settings' : 'dashboard');
    reload();
  };
  const go = (p: Page) => {
    if(hasPendingLargeImport()){notify('Najpierw rozstrzygnij oryginalną próbę dużego importu.',true);return false;}
    if(hasPendingPim()){notify('Najpierw rozstrzygnij dokładną próbę parametrów produktu.',true);return false;}
    if (manualOffLocked || hasPendingManualOff()) { notify('Najpierw rozstrzygnij dokładną próbę ręcznej korekty PW/RW.',true); return false; }
    if (p !== 'pricing' && competitorObservationContext && competitorObservationsLocked(competitorObservationContext)) {
      notify('Najpierw sprawdź wynik zapisu obserwacji lub ceny w otwartym cenniku.', true);
      return false;
    }
    setPage(p);
    setSelected(null);
    setSearch('');
    setOrderFilter(allOrders);
    setAdjustmentStocktakeFocus(null);
    return true;
  };
  const openAdjustmentStocktake = (sourceKind: 'quantity' | 'wms', id: string) => {
    if (!['quantity', 'wms'].includes(sourceKind) || !/^[a-f0-9-]{36}$/.test(id)) return;
    if (largeImportLocked || quantityNavigationLockedScope === stocktakeActorScope) {
      notify('Najpierw zapisz pomiary i rozstrzygnij ewentualny niepotwierdzony skan.', true);
      return;
    }
    go(sourceKind === 'wms' ? 'wmsStocktakes' : 'inventory');
    setAdjustmentStocktakeFocus({ scope: stocktakeActorScope, sourceKind, id,
      token: ++adjustmentFocusSerial.current });
  };
  const openOrder = (id: string) => {
    if(hasPendingLargeImport()){notify('Najpierw rozstrzygnij oryginalną próbę dużego importu.',true);return false;}
    setPage('orders');
    setSelected(id);
    return true;
  };
  /** Bell proposal of the rule effect "Połącz zamówienia": the list with the set selected in the merge panel. */
  const openMergeProposal = (ids: string[]) => {
    if(hasPendingLargeImport()){notify('Najpierw rozstrzygnij oryginalną próbę dużego importu.',true);return;}
    setPage('orders');
    setSelected(null);
    setMergeProposal({ ids, token: Date.now() });
  };
  // Address bar <-> view (Uwagi v3 §8). Back/forward and links go through the same guards as the menu.
  useAppRouteSync({
    enabled: !!user && !user.mfa_required && !resetToken && !(wms.active && !wmsBlocked()),
    view: { page, orderId: selected, filter: orderFilter },
    initialRoute,
    apply: (route) => {
      if (route.kind === 'page') return (page === route.page && !selected) || go(route.page);
      if (page === 'orders' && selected) setSelected(null);
      else if (page !== 'orders' && !go('orders')) return false;
      setOrderFilter(route.filter);
      return true;
    },
    openOrder,
    openPacking: (ref) => {
      if (wmsBlocked()) { notify('Najpierw dokończ rozpoczętą operację.', true); return; }
      wms.open(ref);
    },
    onMissingOrder: (message) => notify(message, true),
  });
  // Options panel next to the menu: hidden or shown, remembered per workspace and person.
  const [panelHidden, setPanelHidden] = useState(false);
  useEffect(() => {
    if (user) setPanelHidden(readPanelHidden(user.tenant_id, user.id));
  }, [user?.tenant_id, user?.id]);
  const showPanel = (shown: boolean) => {
    setPanelHidden(!shown);
    if (user) writePanelHidden(user.tenant_id, user.id, !shown);
  };
  // A module clicked in the menu shows its options without leaving the current view; it counts only for that view.
  const [openedModule, setOpenedModule] = useState<{ id: string; view: string } | null>(null);
  const currentView = page + ':' + (selected ?? '');
  const openedModuleId = openedModule?.view === currentView ? openedModule.id : null;
  const orderNav = useOrderStatusNav(
    refresh,
    !!user && !user.mfa_required && (openedModuleId ? openedModuleId === 'orders' : page === 'orders'),
  );
  if (resetToken)
    return (
      <PasswordRecovery
        key={resetToken}
        token={resetToken}
        onBack={() => setResetToken(null)}
        onDone={() => {
          setResetToken(null);
          setUser(null);
          setWorkspace(null);
          setChecked(true);
        }}
      />
    );
  if (!checked) return <Loading />;
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          changedUser(u);
        }}
      />
    );
  if (user.mfa_required)
    return (
      <MfaGate
        key={user.tenant_id}
        user={user}
        changed={changedUser}
        notify={notify}
        readOnly={restorePreview}
      />
    );
  const admin = user.role === 'admin',
    write = user.role !== 'viewer' && !manualOffLocked;
  if (wms.active && !wmsBlocked())
    return <WmsApp key={user.tenant_id + ':' + user.id} user={user} readOnly={restorePreview || !write}
      routeOrder={wms.ref} onRouteOrder={wms.setOrder}
      onOffice={wms.close} onLogout={async () => { await api('/auth/logout', 'POST'); changedUser(null); }} />;
  const action =
    restorePreview ? null : page === 'products' && admin
      ? 'product'
      : page === 'orders' && write
        ? 'order'
        : page === 'inventory' && admin
          ? 'adjust'
          : page === 'integrations' && admin && !restorePreview
            ? 'integration'
            : page === 'settings' && admin
              ? 'warehouse'
              : null;
  const actionText: Record<string, string> = {
    product: 'Dodaj produkt',
    order: 'Nowe zamówienie',
    adjust: 'Korekta stanu',
    automation: 'Nowa reguła',
    integration: 'Dodaj integrację',
    warehouse: 'Dodaj magazyn',
  };
  const modules = visibleModules(admin, isAccountant(user));
  const activeModule = moduleOfPage(modules, page);
  const shownModule = modules.find((m) => m.id === openedModuleId) ?? (activeModule && hasPanel(activeModule) ? activeModule : undefined);
  const navCollapsed = !!shownModule;
  const navPanelOpen = navCollapsed && !panelHidden;
  const goTarget = (t: NavTarget) => navigateTo('page' in t ? pagePath(t.page) : t.path);
  /** Plain modules navigate; a module with options opens its panel, and an option is one click to the view. */
  const onModule = (m: NavModule) => {
    if (!hasPanel(m)) { goTarget(defaultTarget(m)); return; }
    setOpenedModule(m.id === activeModule?.id ? null : { id: m.id, view: currentView });
    showPanel(true);
  };
  const viewPath = page === 'orders' ? orderStatusPath(orderFilter) : pagePath(page);
  const pageLabel = pages.find((p) => p.id === page)?.label ?? '';
  const breadcrumb = selected
    ? ['Zamówienia', 'Szczegóły zamówienia']
    : page === 'orders'
      ? orderStatusBreadcrumb(orderFilter, orderNav.workflows)
      : activeModule && activeModule.options.length > 1
        ? [activeModule.label, activeModule.options.find((o) => 'page' in o.to && o.to.page === page)?.label ?? pageLabel]
        : [pageLabel];
  return (
    <div className={'app-shell' + (navCollapsed ? ' nav-collapsed' : '') + (navPanelOpen ? ' nav-panel-open' : '')} key={user.tenant_id + ':' + user.role}>
      <aside className="sidebar">
        <button className="brand" onClick={() => go('dashboard')}>
          <div className="brand-mark">
            D<span>•</span>
          </div>
          <div>
            DYNAMINDS<small>Ecommerce</small>
          </div>
        </button>
        <fieldset className="sidebar-workspace" disabled={pimLocked || manualOffLocked} style={{border:0,padding:0,margin:0,minWidth:0}}>
          <WorkspaceSwitcher user={user} changed={changedUser} notify={notify} />
        </fieldset>
        <ModuleMenu
          modules={modules}
          activeId={shownModule?.id ?? activeModule?.id}
          panelOpen={navPanelOpen}
          collapsed={navCollapsed}
          onModule={onModule}
          onWarehouse={() => {
            if (wmsBlocked()) { notify('Najpierw dokończ rozpoczętą operację.', true); return; }
            wms.open();
          }}
        />
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="dot" /> Lokalny workspace
          </div>
          <button
            className="user-button"
            disabled={pimLocked || manualOffLocked}
            onClick={async () => {
              if (hasPendingPim() || hasPendingManualOff()) return;
              await api('/auth/logout', 'POST');
              changedUser(null);
            }}
            title="Wyloguj"
          >
            <div className="avatar">{user.name.slice(0, 1)}</div>
            <div>
              {user.name}
              <small>{roleLabel(user)}</small>
            </div>
            <LogOut size={17} />
          </button>
          <button
            type="button"
            className="button ghost full"
            disabled={(stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
            title={(automaticWzWriteLocked || catalogStockControlWriteLocked) ? 'Najpierw potwierdź wynik zmiany magazynowej' : (stocktakeAdjustmentsWriteLocked || manualOffLocked) ? 'Najpierw potwierdź wynik rozliczenia PW/RW' : 'Zmień konto'}
            onClick={async () => {
              if (hasPendingPim() || hasPendingManualOff() || stocktakeAdjustmentsLocked(stocktakeActorScope) || (warehouseAutomaticWzLocked(stocktakeActorScope) || catalogStockControlLocked(stocktakeActorScope))) return;
              // changedUser refuses during a pending large import, so check first: the session must not end while the app stays open.
              if (hasPendingLargeImport()) { notify('Najpierw rozstrzygnij oryginalną próbę dużego importu.', true); return; }
              try {
                await api('/auth/logout', 'POST');
              } catch (error) {
                notify(error instanceof Error ? error.message : 'Nie udało się zmienić konta.', true);
                return;
              }
              changedUser(null);
            }}
          >
            Zmień konto
          </button>
        </div>
      </aside>
      {shownModule && (
        <ModuleOptionsPanel
          module={shownModule}
          view={{ page, path: viewPath, order: !!selected }}
          onOption={(o) => goTarget(o.to)}
          onHide={() => showPanel(false)}
        >
          {shownModule.panel === 'orders' ? (
            <OrdersNavPanel
              data={orderNav}
              filter={orderFilter}
              onSelect={(f) => navigateTo(orderStatusPath(f))}
              onManage={admin ? () => go('automations') : undefined}
            />
          ) : undefined}
        </ModuleOptionsPanel>
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <NavBreadcrumb items={breadcrumb} />
          </div>
          <div className="topbar-right">
            <span className="local-chip">
              <span className="dot" />{' '}
              {restorePreview ? 'Kopia odtworzona · tylko odczyt' : 'Tryb lokalny'}
            </span>
            <AutomationNotifications onOpenOrder={openOrder} onOpenMerge={openMergeProposal} />
            <span className="avatar small">{user.name.slice(0, 1)}</span>
          </div>
        </header>
        <main>
          {restorePreview && (
            <p className="notice">
              Podgląd odtworzonej kopii. Worker i połączenia z dostawcami są wyłączone; zmiany
              danych są zablokowane.
            </p>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">DYNAMINDS ECOMMERCE</div>
              <h1>{selected ? 'Szczegóły zamówienia' : pages.find((p) => p.id === page)?.label}</h1>
              <p>{descriptions[page]}</p>
            </div>
            <div className="heading-actions">
              <button className="button" onClick={reload} title="Odśwież dane">
                <RefreshCw size={16} />
                <span>Odśwież</span>
              </button>
              {action && !selected && (
                <button
                  className="button primary"
                  disabled={
                    (action === 'adjust' && ((stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked))) ||
                    (action === 'product' && (languageFileImportLocked || stockFileImportLocked || productCatalogsLocked || catalogExportPending || b2bCatalogScopeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)))
                  }
                  onClick={() => {
                    if (restorePreview || currentActorScopeRef.current !== currentActorScope) return;
                    if ((action === 'adjust' || action === 'product') && (hasPendingPim() || hasPendingManualOff() || stocktakeAdjustmentsLocked(stocktakeActorScope) || (warehouseAutomaticWzLocked(stocktakeActorScope) || catalogStockControlLocked(stocktakeActorScope)))) return;
                    if (action === 'product' && (languageFileImportLocked || stockFileImportLocked || productCatalogsLocked || catalogExportPending || b2bCatalogScopeLocked || b2bCatalogScopeWriteLocked(stocktakeActorScope) || catalogExportLocked(stocktakeActorScope)))
                      return;
                    setModal(action);
                  }}
                >
                  <Plus size={17} />
                  {actionText[action]}
                </button>
              )}
              {page === 'orders' && admin && !restorePreview && !selected && (
                <button className="button" onClick={() => setModal('externalOrder')}>
                  Zamówienie do dostawcy
                </button>
              )}
            </div>
          </div>
          {selected ? (
            <OrderDetail
              key={
                user.tenant_id +
                ':' +
                user.id +
                ':' +
                user.role +
                ':' +
                restorePreview +
                ':' +
                selected
              }
              workspaceId={user.tenant_id}
              packingContextKey={user.tenant_id + ':' + user.id + ':' + user.role}
              splitAvailable={orderSplitCapability?.scope===currentActorScope&&orderSplitCapability.available===true&&!(orderSplit222Capability?.scope===currentActorScope&&orderSplit222Capability.available===true)}
              split222Available={orderSplit222Capability?.scope===currentActorScope&&orderSplit222Capability.available===true}
              userId={user.id}
              warehousePolicyWriteBlocked={warehousePolicyLocked || returnDestinationsIntakeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
              readOnly={restorePreview}
              admin={admin}
              id={selected}
              refresh={refresh}
              write={write}
              paymentWrite={isAccountant(user) && !manualOffLocked}
              notify={notify}
              reload={reload}
              onOpenOrder={openOrder}
              onBack={() => setSelected(null)}
              listIds={orderListIds.includes(selected) ? orderListIds : undefined}
              onOpenStage={(stage) => navigateTo(orderStatusPath({ status: stage, workflow: '' }))}
            />
          ) : page === 'reports' ? (
            <SalesReports
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              workspaceId={user.tenant_id}
              contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
              readOnly={restorePreview}
              refresh={refresh}
              onOpenOrder={openOrder}
              onError={(message) => notify(message, true)}
            />
          ) : page === 'dashboard' ? (
            <Dashboard
              refresh={refresh}
              onOrder={openOrder}
              onNavigate={go}
              onStatus={(status) => {
                if (go('orders')) setOrderFilter({ status, workflow: '' });
              }}
              report={false}
            />
          ) : page === 'picking' && pickingWavesAvailable ? (
            <PickingWorkspace
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              refresh={refresh}
              workspaceId={user.tenant_id}
              write={write && !restorePreview}
              onOrder={openOrder}
              packing={
                <>
                <PackingWorkstationPanel
                  key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                  contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
                  readOnly={restorePreview}
                  refresh={refresh}
                  onOrder={openOrder}
                  onChanged={reload}
                />
                <DeferredPrintPanel contextKey={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview} title="Kolejka wydruków">
                  <PrintJobsPanel
                    contextKey={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                    readOnly={restorePreview}
                  />
                </DeferredPrintPanel>
                </>
              }
              individual={
                <Orders
                  key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                  refresh={refresh}
                  onOrder={openOrder}
                  search={search}
                  setSearch={setSearch}
                  contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
                  readOnly={restorePreview}
                  picking={true}
                  write={write}
                  reload={reload}
                />
              }
            />
          ) : page === 'orders' || page === 'picking' ? (
            <Orders
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              refresh={refresh}
              onOrder={openOrder}
              search={search}
              setSearch={setSearch}
              contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
              readOnly={restorePreview}
              picking={page === 'picking'}
              write={write}
              reload={reload}
              filter={orderFilter}
              onFilter={setOrderFilter}
              onManageStatuses={admin ? () => go('automations') : undefined}
              onRows={setOrderListIds}
              mergeProposal={page === 'orders' ? mergeProposal : null}
            />
          ) : page === 'returns' ? (
            <>
            {admin && <ReturnDestinationStatusesSettings
              contextKey={stocktakeActorScope}
              readOnly={restorePreview}
              externalWriteBlocked={pimLocked || warehousePolicyLocked || stockFileImportLocked || productCatalogsLocked || catalogExportPending || returnDestinationsIntakeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
              onChanged={reload}
            />}
            <ReturnQueue
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              refresh={refresh}
              onOrder={openOrder}
              contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
              readOnly={restorePreview}
              write={write}
              destinationsAvailable={returnDestinationsAvailable}
              externalWriteBlocked={pimLocked || warehousePolicyLocked || stockFileImportLocked || productCatalogsLocked || catalogExportPending || returnDestinationSettingsLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
              onChanged={reload}
            />
            </>
          ) : page === 'b2bNetwork' ? (
            <>
            <B2bNetwork
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              admin={admin}
              contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
              readOnly={restorePreview}
              catalogContextKey={stocktakeActorScope}
              externalWriteBlocked={pimLocked || manualOffLocked || stockFileImportLocked || languageFileImportLocked || productCatalogsLocked || catalogExportPending}
            />
            <B2bSupplierDirectory
              key={'directory:' + user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              admin={admin}
              readOnly={restorePreview}
              contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
            />
            </>
          ) : page === 'b2b' ? (
            <B2bPanel
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              admin={admin}
              contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
              readOnly={restorePreview}
              catalogContextKey={stocktakeActorScope}
              externalWriteBlocked={pimLocked || manualOffLocked || stockFileImportLocked || languageFileImportLocked || productCatalogsLocked || catalogExportPending}
            />
          ) : page === 'pricing' ? (
            <>
              <PricingPanel
                key={'pricing:' + stocktakeActorScope}
                context={competitorObservationContext!}
                navigationLocked={competitorObservationLocked}
                externalWriteBlocked={pimLocked || manualOffLocked || priceFileImportLocked || priceMatrixImportLocked}
                write={write && !restorePreview && !priceFileImportLocked && !priceMatrixImportLocked && !competitorObservationLocked}
                admin={user.role === 'admin'}
                refresh={refresh}
              />
              <PriceFileImportWorkspace
                key={'price-file:' + stocktakeActorScope}
                contextKey={stocktakeActorScope}
                readOnly={restorePreview}
                onApplied={reload}
                onError={(message) => notify(message, true)}
                externalWriteBlocked={pimLocked || manualOffLocked || priceMatrixImportLocked || competitorObservationLocked}
                onLockedChange={setPriceFileImportLocked}
              />
              <PriceMatrixImportWorkspace
                key={'price-matrix:' + stocktakeActorScope}
                contextKey={stocktakeActorScope}
                readOnly={restorePreview}
                externalWriteBlocked={pimLocked || manualOffLocked || priceFileImportLocked || competitorObservationLocked}
                onApplied={reload}
                onError={(message) => notify(message, true)}
                onLockedChange={setPriceMatrixImportLocked}
              />
            </>
          ) : page === 'products' ? (
            <>
              <ProductCatalogsPanel key={'product-catalogs:' + stocktakeActorScope} contextKey={stocktakeActorScope} readOnly={restorePreview} refresh={refresh} externalWriteBlocked={largeImportLocked || pimLocked || manualOffLocked || stockFileImportLocked || languageFileImportLocked || catalogExportPending || b2bCatalogScopeLocked || catalogStockControlWriteLocked} onLockedChange={setProductCatalogsLocked} onChanged={reload} />
              {productCatalogsLocked && <p role="status">Trwa ustalanie wyniku zmiany katalogu. Wróć do dokładnej próby powyżej, aby wznowić pozostałe zapisy produktów.</p>}
              {languageFileImportLocked && (
                <p className="info-body" role="status">
                  Trwa rozstrzyganie importu tłumaczeń. Pozostałe operacje katalogu będą dostępne po
                  potwierdzeniu wyniku; ponowienie i historia importu są poniżej.
                </p>
              )}
              <LocalSimulationOffer key={'local-demo-offer:'+user.tenant_id+':'+user.id+':'+user.role+':'+restorePreview}
                tenantId={user.tenant_id} userId={user.id} admin={admin} readOnly={restorePreview}
                externalWriteBlocked={largeImportLocked || pimLocked || manualOffLocked || stockFileImportLocked || languageFileImportLocked || productCatalogsLocked || catalogExportPending || b2bCatalogScopeLocked || automaticWzWriteLocked || catalogStockControlWriteLocked}
                refresh={refresh} />
                <CatalogPanel
                  key={user.tenant_id + ':' + user.id + ':' + user.role}
                  workspaceId={user.tenant_id}
                  actorId={user.id}
                  contextKey={stocktakeActorScope}
                  readOnly={restorePreview}
                  externalWriteBlocked={manualOffLocked || stockFileImportLocked || languageFileImportLocked || productCatalogsLocked || catalogExportPending || b2bCatalogScopeLocked || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
                  localWooFlowEnabled={localWooFlowAvailable}
                  largeImportAvailable={largeImportAvailable&&largeImportCapabilityScope===currentActorScope}
                  largeImportUnavailableReason={largeImportCapabilityScope===currentActorScope?largeImportUnavailableReason:null}
                  largeImportIndependentCreates={largeImportCreates&&largeImportCapabilityScope===currentActorScope}
                  onLargeImportLockedChange={setLargeImportLocked}
                  pimContext={pimContext!}
                  pimEnabled={pimAvailable}
                  pimLegacyStageReady={pimAvailable} pimNestedMappingAvailable={pimNestedMappingAvailable}
                  openProductId={catalogProductFocus?.id}
                  openProductToken={catalogProductFocus?.token}
                  exportExternalWriteBlocked={pimLocked || stockFileImportLocked || languageFileImportLocked || productCatalogsLocked || b2bCatalogScopeLocked}
                  onExportLockedChange={setCatalogExportPending}
                  refresh={refresh}
                  search={search}
                  setSearch={setSearch}
                  admin={admin}
                  reload={reload}
                  notify={notify}
                />
              <LanguageFileImportWorkspace
                key={'language-file-import:' + stocktakeActorScope}
                contextKey={stocktakeActorScope}
                readOnly={restorePreview}
                externalWriteBlocked={largeImportLocked || pimLocked || manualOffLocked || stockFileImportLocked || productCatalogsLocked || catalogExportPending || b2bCatalogScopeLocked}
                onLockedChange={setLanguageFileImportLocked}
                onApplied={reload}
              />
            </>
          ) : page === 'purchasing' ? (
            <Purchasing
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              contextKey={stocktakeActorScope}
              readOnly={restorePreview}
              productWriteBlocked={manualOffLocked || stockFileImportLocked || languageFileImportLocked || productCatalogsLocked || catalogExportPending || b2bCatalogScopeLocked || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
              admin={admin && !restorePreview}
              refresh={refresh}
              reload={reload}
              notify={notify}
            />
          ) : page === 'wmsLots' ? (
            <WmsLotsWorkspace
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
              readOnly={restorePreview}
              externalWriteBlocked={pimLocked || stockFileImportLocked || warehousePolicyLocked || returnDestinationSettingsLocked || returnDestinationsIntakeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
              refresh={refresh}
              onChanged={reload}
            />
          ) : page === 'wmsStocktakes' ? (
            <WmsStocktakesPanel
              key={
                'wms-stocktakes:' +
                user.tenant_id +
                ':' +
                user.id +
                ':' +
                user.role +
                ':' +
                restorePreview
              }
              contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
              readOnly={restorePreview}
              adjustmentsContextKey={stocktakeActorScope}
              adjustmentsAvailable={stocktakeAdjustmentsAvailable}
              focusStocktakeId={adjustmentStocktakeFocus?.scope === stocktakeActorScope && adjustmentStocktakeFocus.sourceKind === 'wms' ? adjustmentStocktakeFocus.id : undefined}
              focusToken={adjustmentStocktakeFocus?.token}
              externalWriteBlocked={pimLocked || manualOffLocked || stockFileImportLocked || warehousePolicyLocked || returnDestinationSettingsLocked || returnDestinationsIntakeLocked || !stocktakeAdjustmentsCapabilityKnown || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
              refresh={refresh}
              onChanged={reload}
            />
          ) : page === 'inventory' ? (
            <>
              <CatalogStockControlPanel key={'catalog-stock-control:' + stocktakeActorScope}
                contextKey={stocktakeActorScope} available={catalogStockControlAvailable}
                readOnly={restorePreview} refresh={refresh}
                externalWriteBlocked={pimLocked || stockFileImportLocked || languageFileImportLocked || productCatalogsLocked || catalogExportPending || b2bCatalogScopeLocked || warehousePolicyLocked || returnDestinationSettingsLocked || returnDestinationsIntakeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || automaticWzWriteLocked}
                onChanged={reload} />
              <WarehouseWzIssuedDocuments key={'warehouse-wz-issued:' + stocktakeActorScope}
                contextKey={stocktakeActorScope} available={automaticWzIssuerAvailable}
                readOnly={restorePreview} refresh={refresh} reader={warehouseWzIssuedReader}
                onOpenOrder={(id) => { if (!hasPendingManualOff()) setSelected(id); }} />
              {admin && <WarehouseAutomaticWzPanel
                key={'warehouse-automatic-wz:' + stocktakeActorScope}
                contextKey={stocktakeActorScope}
                available={automaticWzConfigurationAvailable}
                readOnly={restorePreview}
                refresh={refresh}
                externalWriteBlocked={pimLocked || stockFileImportLocked || productCatalogsLocked || catalogExportPending || warehousePolicyLocked || returnDestinationSettingsLocked || returnDestinationsIntakeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || catalogStockControlWriteLocked}
                onChanged={reload}
              />}
              {admin && <WarehouseInventoryPoliciesPanel
                key={'warehouse-policy:' + stocktakeActorScope}
                contextKey={stocktakeActorScope}
                readOnly={restorePreview}
                externalWriteBlocked={pimLocked || stockFileImportLocked || productCatalogsLocked || catalogExportPending || returnDestinationSettingsLocked || returnDestinationsIntakeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
                onChanged={reload}
              />}
              <ManualInventoryOffPanel key={'manual-off:' + stocktakeActorScope}
                context={{tenant_id:user.tenant_id,user_id:user.id,role:user.role,read_only:restorePreview}}
                externalWriteBlocked={pimLocked || stockFileImportLocked || warehousePolicyLocked || returnDestinationSettingsLocked || returnDestinationsIntakeLocked || stocktakeAdjustmentsWriteLocked || automaticWzWriteLocked || catalogStockControlWriteLocked}
                onChanged={reload} />
              <Stocktakes
                key={
                  'spisy:' + user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview
                }
                admin={admin && !restorePreview}
                contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
                readOnly={restorePreview}
              adjustmentsContextKey={stocktakeActorScope}
              adjustmentsAvailable={stocktakeAdjustmentsAvailable}
                focusStocktakeId={adjustmentStocktakeFocus?.scope === stocktakeActorScope && adjustmentStocktakeFocus.sourceKind === 'quantity' ? adjustmentStocktakeFocus.id : undefined}
                focusToken={adjustmentStocktakeFocus?.token}
                externalWriteBlocked={pimLocked || manualOffLocked || stockFileImportLocked || warehousePolicyLocked || returnDestinationSettingsLocked || returnDestinationsIntakeLocked || !stocktakeAdjustmentsCapabilityKnown || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
                write={write && !restorePreview}
                refresh={refresh}
                reload={reload}
                onOpenWms={() => go('wmsStocktakes')}
                onBlindCountingChange={onBlindStocktakeChange}
                onNavigationLockedChange={onQuantityNavigationLockedChange}
              />
              {(admin || blindStocktakeScope !== stocktakeActorScope) && (
                <>
                  <StockFileImportWorkspace
                    key={stocktakeActorScope}
                    contextKey={stocktakeActorScope}
                    readOnly={restorePreview}
                    externalWriteBlocked={pimLocked || languageFileImportLocked || catalogExportPending || warehousePolicyLocked || returnDestinationSettingsLocked || returnDestinationsIntakeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
                    onApplied={reload}
                    onError={(message) => notify(message, true)}
                    onLockedChange={setStockFileImportLocked}
                  />
                  <StockLocations
                    key={user.tenant_id}
                    admin={admin}
                    externalWriteBlocked={pimLocked || stockFileImportLocked || warehousePolicyLocked || returnDestinationSettingsLocked || returnDestinationsIntakeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
                    readOnly={restorePreview}
                    write={write}
                    refresh={refresh}
                    reload={reload}
                  />
                  <WarehouseDocumentRegister
                    key={'warehouse-document-register:' + stocktakeActorScope}
                    contextKey={stocktakeActorScope}
                    available={stocktakeAdjustmentsAvailable}
                    readOnly={restorePreview}
                    refresh={refresh}
                    onOpenStocktake={openAdjustmentStocktake}
                  />
                  <CatalogStockCountRegister
                    key={'catalog-stock-count-register:' + stocktakeActorScope}
                    contextKey={stocktakeActorScope}
                    available={catalogStockControlAvailable}
                    readOnly={restorePreview}
                    refresh={refresh}
                  />
                  <details>
                    <summary>Tworzenie i obsługa szkiców magazynowych</summary>
                    <WarehouseDocuments
                      contextKey={stocktakeActorScope}
                      key={'warehouse-document-tools:' + stocktakeActorScope}
                      admin={admin}
                      externalWriteBlocked={pimLocked || stockFileImportLocked || warehousePolicyLocked || returnDestinationSettingsLocked || returnDestinationsIntakeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
                      readOnly={restorePreview}
                      refresh={refresh}
                      reload={reload}
                      notify={notify}
                    />
                  </details>
                  <InventoryPanel refresh={refresh} onOpenProduct={(id)=>{if(hasPendingPim()||hasPendingManualOff())return;setPage('products');setSearch('');setSelected(null);setAdjustmentStocktakeFocus(null);setCatalogProductFocus({id,token:Date.now()});}} />
                </>
              )}
            </>
          ) : page === 'integrations' ? (
            <Integrations
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              contextKey={stocktakeActorScope}
              readOnly={restorePreview}
              recoveryContext={{ tenant_id: user.tenant_id, user_id: user.id, role: user.role, restore_preview: restorePreview }}
              onOpenOrder={openOrder}
              catalogWriteBlocked={languageFileImportLocked || stockFileImportLocked || productCatalogsLocked || catalogExportPending || b2bCatalogScopeLocked}
              onFieldMappings={() => go('orderFieldMappings')}
              add={(provider) => {
                setIntegrationProvider(provider);
                setModal('integration');
              }}
              refresh={refresh}
              admin={admin}
              write={write}
              notify={notify}
              reload={reload}
            />
          ) : page === 'crm' ? (
            <CrmWorkspace key={'crm:'+stocktakeActorScope} context={{tenantId:user.tenant_id,userId:user.id,admin,readOnly:restorePreview,externalWriteBlocked:largeImportLocked}} refresh={refresh}/>
          ) : page === 'email' ? (
            <><p className="notice" hidden={!emailInboundLocked}>Niepewny zapis skrzynki email wstrzymuje świeże zapisy SMTP. Wróć do dokładnej próby w Wiadomościach klientów.</p><fieldset disabled={emailInboundLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><EmailPanel key={user.tenant_id} admin={admin} write={write && !emailInboundLocked} refresh={refresh} /></fieldset></>
          ) : page === 'customerMessages' ? (
            <><CustomerMessages
              key={'customer-messages:' + user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              write={write}
              readOnly={restorePreview}
              externalWriteBlocked={pimLocked || manualOffLocked || emailInboundLocked}
              focusThreadId={customerThreadFocus?.id}
              focusToken={customerThreadFocus?.token}
              onEmail={id => setEmailInboundFocus(v => ({ id, token: (v?.token ?? 0) + 1 }))}
              refresh={refresh}
              onOrder={openOrder}
            /><EmailInboundWorkspace key={stocktakeActorScope} contextKey={stocktakeActorScope} readOnly={restorePreview} messageId={emailInboundFocus?.id} focusToken={emailInboundFocus?.token} onChanged={reload} onOpenOrder={openOrder} onOpenThread={(_orderId, id) => setCustomerThreadFocus(v => ({ id, token: (v?.token ?? 0) + 1 }))} /><ChannelInbox key={'channel-inbox:' + stocktakeActorScope} readOnly={restorePreview} onOrder={openOrder} />{user.role === 'admin' && <><InboundSchedules key={'inbound-schedules:' + stocktakeActorScope} readOnly={restorePreview} onOpenOrder={openOrder} /><PortalLinkPolicy key={'portal-link-policy:' + stocktakeActorScope} readOnly={restorePreview} /></>}</>
          ) : page === 'sms' ? (
            <SmsPanel
              key={user.tenant_id}
              admin={admin}
              write={write}
              refresh={refresh}
              reload={reload}
            />
          ) : page === 'automations' ? (
            <>
              <AutomationStudio workerContextKey={user.tenant_id+':'+user.id} refresh={refresh} admin={admin} automationEditor={canEditAutomations(user)} readOnly={restorePreview} reload={reload} notify={notify} />
              <LocalAutomationDemo key={user.tenant_id+':'+user.id} tenantId={user.tenant_id} userId={user.id} admin={admin} readOnly={restorePreview} externalWriteBlocked={hasPendingLargeImport()} refresh={refresh} onOpenOrder={openOrder} />
              <CustomerMessageWorkflows
                key={'customer-message-workflows:' + user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                admin={admin}
                readOnly={restorePreview}
                refresh={refresh}
                onChanged={reload}
              />
              <AutomationSchedules
                key={'automation-schedules:' + user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                refresh={refresh}
                admin={admin}
                readOnly={restorePreview}
                reload={reload}
              />
            </>
          ) : page === 'productRules' ? (
            <AdminProductRules
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              workspaceId={user.tenant_id}
              admin={admin}
              readOnly={restorePreview}
              refresh={refresh}
              onChanged={reload}
            />
          ) : page === 'orderFieldMappings' ? (
            <OrderFieldMappings
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              workspaceId={user.tenant_id}
              userId={user.id}
              role={user.role}
              readOnly={restorePreview}
              onError={(message) => notify(message, true)}
            />
          ) : page === 'orderFieldBatches' ? (
            <OrderFieldBatches
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              workspaceId={user.tenant_id}
              userId={user.id}
              role={user.role}
              readOnly={restorePreview}
              onError={(message) => notify(message, true)}
            />
          ) : page === 'orderFields' ? (
            <AdminOrderFields
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              workspaceId={user.tenant_id}
              readOnly={restorePreview}
              refresh={refresh}
              onChanged={reload}
              onError={(message) => notify(message, true)}
            />
          ) : page === 'paymentImports' ? (
            <>
              <AdminPaymentImports
                key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                contextKey={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                readOnly={restorePreview}
                onError={(message) => notify(message, true)}
              />
              {user.role === 'admin' && <PayuSettings key={'payu-settings:' + user.tenant_id + ':' + user.id} readOnly={restorePreview} />}
            </>
          ) : page === 'documents' ? (
            <Documents
              refresh={refresh}
              contextKey={stocktakeActorScope}
              readOnly={restorePreview}
            />
          ) : page === 'audit' ? (
            <AuditLog refresh={refresh} />
          ) : page === 'rodo' ? (
            <RodoPage key={'rodo:' + user.tenant_id + ':' + user.id} tenantId={user.tenant_id} admin={admin} readOnly={restorePreview} />
          ) : page === 'developer' ? (
            <DeveloperPanel
              key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
              contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
              admin={admin} readOnly={restorePreview} refresh={refresh} notify={notify}
            />
          ) : (
            <>
              <WorkspaceSettings
                key={user.tenant_id + ':' + user.id + ':' + user.role}
                readOnly={restorePreview}
                user={user}
                changed={changedUser}
                notify={notify}
                refresh={refresh}
              />
              <AccountSecurity
                key={'account-security:' + user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
                readOnly={restorePreview}
                changed={changedUser}
                notify={notify}
                refresh={refresh}
              />
              {workspaceMfaAvailable && (
                <WorkspaceSecurityPolicy
                  key={'workspace-security-policy:' + user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                  user={user}
                  changed={changedUser}
                  notify={notify}
                  readOnly={restorePreview}
                  refresh={refresh}
                />
              )}
              <SettingsPage refresh={refresh} />
              <KsefSettingsPanel key={'ksef229:' + user.tenant_id + ':' + user.id + ':' + user.role} admin={user.role === 'admin'} readOnly={restorePreview} />
              <FiscalPrinterSettingsPanel key={'receipt233:' + user.tenant_id + ':' + user.id + ':' + user.role} admin={user.role === 'admin'} readOnly={restorePreview} />
              <OrderPackingLabelSetting
                key={'order-packing-label:' + user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                admin={user.role === 'admin'}
                readOnly={restorePreview}
              />
              <AdminPackingSettings
                key={'admin-packing-settings:' + user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
                contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
                readOnly={restorePreview}
                refresh={refresh}
                onChanged={reload}
              />
            </>
          )}
          <footer className="workspace-footer">
            <span>DYNAMINDS Ecommerce</span>
            <span>Dane demonstracyjne · przesyłki i dokumenty lokalne</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status">
          {toast.error ? <AlertCircle size={20} /> : <Check size={20} />} {toast.message}
          <button aria-label="Zamknij powiadomienie" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {modal === 'product' ? (
        <fieldset
          disabled={pimLocked || languageFileImportLocked || stockFileImportLocked || productCatalogsLocked || catalogExportPending || b2bCatalogScopeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked)}
          style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
        >
          <NewProductModal
            pimContext={pimContext!}
            contextKey={stocktakeActorScope}
            readOnly={restorePreview}
            externalWriteBlocked={pimLocked || languageFileImportLocked || stockFileImportLocked || productCatalogsLocked || catalogExportPending || b2bCatalogScopeLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
            close={() => setModal(null)}
            saved={() => {
              reload();
              notify('Dodano produkt.');
            }}
          />
        </fieldset>
      ) : modal === 'externalOrder' ? (
        <Modal
          title="Zamówienie z intencją dostawcy"
          className="external-order-intent-modal"
          onClose={() => setModal(null)}
        >
          <B2bExternalOrderCreate
            key={user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview}
            contextKey={user.tenant_id + ':' + user.id + ':' + user.role}
            readOnly={restorePreview}
            onClose={() => setModal(null)}
            onCreated={(id) => {
              setModal(null);
              reload();
              openOrder(id);
            }}
          />
        </Modal>
      ) : (
        modal && (
          <CreateModal
            key={
              user.tenant_id + ':' + user.id + ':' + user.role + ':' + restorePreview + ':' + modal
            }
            readOnly={restorePreview}
            inventoryContextKey={stocktakeActorScope}
            inventoryWriteBlocked={pimLocked || (stocktakeAdjustmentsWriteLocked || manualOffLocked) || (automaticWzWriteLocked || catalogStockControlWriteLocked)}
            kind={modal}
            initialProvider={integrationProvider}
            onClose={() => setModal(null)}
            onSaved={(text, id) => {
              setModal(null);
              reload();
              notify(text);
              if (id) openOrder(id);
            }}
          />
        )
      )}
    </div>
  );
}
function Dashboard({
  refresh,
  onOrder,
  onNavigate,
  onStatus,
  report = false,
}: {
  refresh: number;
  onOrder: (id: string) => void;
  onNavigate: (p: Page) => void;
  /** Opens the order list filtered to one status. */
  onStatus?: (status: string) => void;
  report?: boolean;
}) {
  const { data, error } = useData('/dashboard', refresh);
  // Stage counters incl. the derived ready_to_ship; /dashboard statuses stand in while they load.
  const stageCounts = useData('/orders/status-counts', refresh);
  if (error) return <ErrorBlock message={error} />;
  if (!data) return <Loading />;
  const count = data.orders.reduce((sum: number, o: any) => sum + o.count, 0),
    ready = data.orders
      .filter((o: any) => ['paid', 'picking', 'packed'].includes(o.status))
      .reduce((sum: number, o: any) => sum + o.count, 0),
    shipped = data.orders
      .filter((o: any) => ['shipped', 'delivered', 'completed'].includes(o.status))
      .reduce((sum: number, o: any) => sum + o.count, 0);
  const revenue = new Map<string, number>([[data.currency, 0]]);
  const statuses = new Map<string, number>();
  for (const o of data.orders) {
    statuses.set(o.status, (statuses.get(o.status) ?? 0) + o.count);
    if (!['cancelled', 'new'].includes(o.status))
      revenue.set(
        o.currency,
        (revenue.get(o.currency) ?? 0) + Number(o.total) - Number(o.refund_total ?? 0),
      );
  }
  const stageCount = (s: string): number | string =>
    stageCounts.data
      ? (stageCounts.data.statuses?.[s] ?? 0)
      : s === 'ready_to_ship'
        ? stageCounts.error ? '–' : '…'
        : (statuses.get(s) ?? 0);
  return (
    <>
      <section className="overview-banner">
        <div>
          <span className="banner-tag">CENTRUM OPERACJI</span>
          <h2>{report ? 'Wyniki, które możesz sprawdzić.' : 'Dobry dzień na sprawną sprzedaż.'}</h2>
          <p>{ready} zamówień czeka na realizację. Każdy kolejny krok w jednym miejscu.</p>
          <button onClick={() => onNavigate('orders')}>
            Przejdź do zamówień <ArrowUpRight size={18} />
          </button>
        </div>
        <div className="banner-art">
          <div className="orbit" />
          <div className="box-art">
            <Package size={58} />
          </div>
          <span className="float-tag tag-top">
            <Check size={14} /> Stany zarezerwowane
          </span>
          <span className="float-tag tag-bottom">
            <Truck size={16} /> Sprawna realizacja
          </span>
        </div>
      </section>
      <p className="muted">
        Zestawienia obejmują bieżące zamówienia, także nowe i anulowane. Po połączeniu
        zarchiwizowane źródła nie są liczone ponownie; historia zamówień źródłowych pozostaje
        dostępna.
      </p>
      <div className="metrics">
        {[
          {
            label: 'Wartość po przyjętych zwrotach',
            value: [...revenue]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([currency, amount]) => (
                <span className="currency-total" key={currency}>
                  {money(amount, currency)}
                </span>
              )),
            icon: BarChart3,
            hint: 'Według walut; bez nieopłaconych i anulowanych. Wartość zamówień, nie otrzymane wpłaty.',
          },
          {
            label: 'Bieżące zamówienia',
            value: count,
            icon: ShoppingBag,
            hint: 'Bez źródeł zarchiwizowanych po połączeniu',
          },
          {
            label: 'Do realizacji',
            value: ready,
            icon: Package,
            hint: 'Nowe, kompletacja, spakowane',
          },
          {
            label: 'Wysłane zamówienia',
            value: shipped,
            icon: Truck,
            hint: 'Nadane, dostarczone i zakończone',
          },
        ].map((m) => (
          <div className="metric" key={m.label}>
            <div className="metric-top">
              <span>{m.label}</span>
              <m.icon size={18} />
            </div>
            <strong>{m.value}</strong>
            <small>{m.hint}</small>
          </div>
        ))}
      </div>
      <p className="muted">
        Wartość zamówień pomniejsza się o kwotę przyjętych zwrotów, niezależnie od wypłaty
        refundacji. Wpłaty i refundacje sprawdzisz w rozliczeniach zamówienia.
      </p>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{report ? 'Statusy bieżących zamówień' : 'Ostatnie bieżące zamówienia'}</h2>
              <p>
                {report
                  ? 'Liczba bieżących zamówień w każdym statusie'
                  : 'Sześć najnowszych bieżących zamówień'}
              </p>
            </div>
            <button className="text-button" onClick={() => onNavigate('orders')}>
              Wszystkie <ArrowUpRight size={16} />
            </button>
          </div>
          {report ? (
            <div className="status-chart">
              {[...statuses].map(([status, countInStatus]) => (
                <div className="chart-row" key={status}>
                  <span>{orderStatusLabel(status)}</span>
                  <div className="bar-track">
                    <div style={{ width: `${(countInStatus / Math.max(count, 1)) * 100}%` }} />
                  </div>
                  <strong>{countInStatus}</strong>
                </div>
              ))}
            </div>
          ) : (
            <OrderTable rows={data.recent} onOrder={onOrder} compact />
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Realizacja zamówień</h2>
              <p>Aktualny stan procesu</p>
            </div>
            <Package size={20} />
          </div>
          <div className="pipeline">
            {(['paid', 'picking', 'packed', 'ready_to_ship', 'shipped'] as const).map((s) => {
              const n = stageCount(s);
              return (
                <button
                  className="pipeline-row"
                  key={s}
                  onClick={() =>
                    s === 'picking' || !onStatus ? onNavigate(s === 'picking' ? 'picking' : 'orders') : onStatus(s)
                  }
                >
                  <span className={`order-status-dot order-stage-${s}`} />
                  <span>{fulfilmentLabels[s]}</span>
                  <strong>{n}</strong>
                  <ChevronRight size={16} />
                </button>
              );
            })}
          </div>
          <div className="pipeline">
            <span className="order-pipeline-heading">Płatności</span>
            <button className="pipeline-row" onClick={() => (onStatus ? onStatus('new') : onNavigate('orders'))}>
              <span className="order-status-dot order-pay-unpaid" />
              <span>{paymentLabels.unpaid}</span>
              <strong>{stageCount('new')}</strong>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="stock-summary">
            <Warehouse size={24} />
            <div>
              <strong>{data.stock.on_hand ?? 0} szt. w magazynach</strong>
              <small>{data.stock.reserved ?? 0} szt. zarezerwowanych</small>
            </div>
          </div>
        </section>
      </div>
      <section className="panel source-panel">
        <div className="panel-heading">
          <div>
            <h2>Źródła bieżących zamówień</h2>
            <p>
              Podział według źródła bieżącego zamówienia. Połączenie do głównego przypisuje całą
              kwotę do jego źródła. Wartości przed zwrotami obejmują również nowe i anulowane
              zamówienia.
            </p>
          </div>
        </div>
        <div className="source-grid">
          {data.sources.map((s: any) => (
            <div key={s.source + s.currency}>
              <div className="source-icon">
                <ShoppingBag size={20} />
              </div>
              <div>
                <strong>
                  {s.source === 'demo'
                    ? 'Dane demonstracyjne'
                    : s.source === 'manual'
                      ? 'Zamówienia ręczne'
                      : (
                          {
                            b2b: 'Kontrahenci B2B',
                            order_merge: 'Połączone zamówienia',
                            prestashop: 'PrestaShop',
                            shopify: 'Shopify',
                            ebay: 'eBay',
                            amazon: 'Amazon',
                            odoo: 'Odoo',
                            woocommerce: 'WooCommerce',
                            allegro: 'Allegro',
                          } as Record<string, string>
                        )[s.source] || s.source}
                </strong>
                <small>
                  {s.count} zamówień · {money(Number(s.total), s.currency)} przed zwrotami
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
/** Status list of the panel selection ("a,b"), limited to known stages for the filter's multi-select. */
const panelStages = (status: string) => status.split(',').filter(isFulfilmentStage);
function Orders({
  refresh,
  onOrder,
  search,
  setSearch,
  picking,
  write,
  reload,
  contextKey,
  readOnly,
  filter: sharedFilter,
  onFilter,
  onManageStatuses,
  onRows,
  mergeProposal,
}: {
  contextKey: string;
  readOnly: boolean;
  refresh: number;
  onOrder: (id: string) => void;
  search: string;
  setSearch: (s: string) => void;
  picking: boolean;
  write: boolean;
  reload: () => void;
  /** Status panel selection kept by the app, so it survives opening an order. */
  filter?: OrderStatusFilter;
  onFilter?: (f: OrderStatusFilter) => void;
  onManageStatuses?: () => void;
  /** Ids of the rows shown, in order: the order card steps through them ("‹ Poprzednie · Następne ›"). */
  onRows?: (ids: string[]) => void;
  /** Rule proposal opened from the bell: select these orders and open the merge panel (token = one opening). */
  mergeProposal?: { ids: string[]; token: number } | null;
}) {
  const [mergeLocked, setMergeLocked] = useState(false);
  const [proformaLocked, setProformaLocked] = useState(false);
  const [printLocked, setPrintLocked] = useState(false);
  const [invoiceLocked, setInvoiceLocked] = useState(false);
  const proformaContextKey = contextKey + ':' + readOnly;
  useEffect(
    () => subscribeProformaLock(proformaContextKey, setProformaLocked),
    [proformaContextKey],
  );
  useEffect(() => subscribePrintJobsLock(proformaContextKey, setPrintLocked), [proformaContextKey]);
  useEffect(() => subscribeLocalInvoicesLock(proformaContextKey, setInvoiceLocked), [proformaContextKey]);
  const listLocked = mergeLocked || proformaLocked || printLocked || invoiceLocked;
  const workflows = useData('/workflow-statuses', refresh);
  const [fieldScope, setFieldScope] = useState<OrderFieldListSelection>({
    columns: [],
    filters: [],
  });
  const fieldScopeKey = JSON.stringify({
    columns: fieldScope.columns.map((d) => d.id),
    filters: fieldScope.filters,
  });
  const [localFilter, setLocalFilter] = useState<OrderStatusFilter>(allOrders),
    [selected, setSelected] = useState<string[]>([]);
  const filter = sharedFilter ?? localFilter,
    setFilter = onFilter ?? setLocalFilter;
  const { status, workflow } = filter;
  // Filter panel (not on the picking screen): applied filters live in the URL so back/refresh keep them;
  // the status is the status panel's selection, shown in the panel's multi-select.
  const [applied, setApplied] = useState<OrderFilters>(() =>
    picking ? emptyFilters : { ...filtersFromQuery(readListQuery()), status: [] },
  );
  useEffect(() => {
    if (picking) return;
    const q = readListQuery();
    const urlStatus = q.get('status') ?? '',
      urlWorkflow = q.get('workflow') ?? '';
    if ((urlStatus || urlWorkflow) && (urlStatus !== status || urlWorkflow !== workflow))
      setFilter({ status: panelStages(urlStatus).join(','), workflow: /^[0-9a-f-]{36}$/i.test(urlWorkflow) ? urlWorkflow : '' });
  }, []);
  const appliedKey = JSON.stringify(applied);
  useEffect(() => {
    if (picking) return;
    // A status (or custom status) with its own path stays out of the query; a free combination goes there.
    const inPath = statusInPath({ status, workflow });
    const q = filtersToQuery({ ...applied, status: inPath ? [] : panelStages(status) }, readListQuery());
    if (workflow && !inPath) q.set('workflow', workflow);
    else q.delete('workflow');
    writeListQuery(q);
  }, [appliedKey, status, workflow, picking]);
  const filterOptions = useData('/orders/filter-options', refresh, !picking);
  const counts = useData('/orders/status-counts', refresh, !picking);
  const lastCounts = useRef<any>(null);
  if (counts.data) lastCounts.current = counts.data;
  const workflowRows = workflows.data?.data ?? [];
  const summary = orderStatusFilterSummary(filter, lastCounts.current, workflowRows);
  const [cursor, setCursor] = useState<string | null>(null),
    [stack, setStack] = useState<(string | null)[]>([]);
  useEffect(() => {
    setCursor(null);
    setStack([]);
    setSelected([]);
  }, [status, search, picking, workflow, fieldScopeKey, appliedKey]);
  useEffect(() => setSelected([]), [cursor]);
  // After the resets above, so a proposal opened on mount keeps its selection.
  useEffect(() => {
    if (mergeProposal) setSelected(mergeProposal.ids);
  }, [mergeProposal?.token]);
  // Picking keeps packed orders whose label is bought ("Gotowe do nadania" is a derived stage).
  const statusParam = picking ? 'paid,picking,packed,ready_to_ship' : status;
  const path =
    '/orders?' +
    new URLSearchParams({
      ...(search ? { search } : {}),
      ...(workflow ? { workflow_status_id: workflow } : {}),
      ...(statusParam ? { status: statusParam } : {}),
      ...(picking ? {} : filtersToApiParams(applied)),
      ...(cursor ? { after: cursor } : {}),
      ...(fieldScope.columns.length
        ? { field_columns: JSON.stringify(fieldScope.columns.map((d) => d.id)) }
        : {}),
      ...(fieldScope.filters.length ? { field_filters: JSON.stringify(fieldScope.filters) } : {}),
    });
  const { data, error } = useData(path, refresh);
  const rowIdsKey = (data?.data ?? []).map((r: { id: string }) => r.id).join(',');
  useEffect(() => {
    if (onRows && !picking) onRows(rowIdsKey ? rowIdsKey.split(',') : []);
  }, [rowIdsKey, picking]);
  const narrowed = search || fieldScope.filters.length || activeFilterCount(applied) > 0;
  const list = (
    <section className="panel orders-list-panel">
      {!picking && (
        <div className="panel-heading">
          <div>
            <h2>{summary.title}</h2>
            <p>
              {summary.count === null ? '…' : ordersCountLabel(summary.count)}
              {narrowed ? ' · lista zawężona filtrami' : ''}
            </p>
          </div>
        </div>
      )}
      {!picking && (
        <OrderFiltersPanel
          value={{ ...applied, status: panelStages(status) }}
          options={filterOptions.data}
          contextKey={contextKey}
          sourceLabel={orderSourceLabel}
          disabled={listLocked}
          onApply={(f) => {
            setApplied({ ...f, status: [] });
            const next = f.status.join(',');
            if (next !== status) setFilter({ status: next, workflow: next ? '' : workflow });
          }}
        />
      )}
      {filterOptions.error && !picking && <ErrorBlock message={'Nie udało się pobrać list filtrów: ' + filterOptions.error} />}
      <OrdersBulkBar
        selected={selected}
        rows={data?.data ?? []}
        workflows={workflowRows}
        write={write}
        readOnly={readOnly}
        contextKey={contextKey}
        printContextKey={proformaContextKey}
        refresh={refresh}
        locks={{ merge: mergeLocked, proforma: proformaLocked, print: printLocked, invoice: invoiceLocked }}
        onMergeLockedChange={setMergeLocked}
        onChanged={reload}
        onOpenOrder={onOrder}
        onClear={() => setSelected([])}
        openMerge={mergeProposal?.token}
        sourceLabel={orderSourceLabel}
        automationSlot={<ManualAutomationButtons orderIds={selected} disabled={readOnly || !write} onDone={reload} />}
      />
      <fieldset disabled={listLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="table-toolbar">
          {picking && (
            <>
              <div className="search-field">
                <Search size={17} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Szukaj numeru, klienta lub emaila"
                  aria-label="Szukaj zamówień"
                />
              </div>
              <select
                aria-label="Filtr własnego statusu"
                value={workflow}
                onChange={(e) => setFilter({ ...filter, workflow: e.target.value })}
              >
                <option value="">Wszystkie własne statusy</option>
                {workflowRows.map((w: any) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <span className="result-count">{data?.data.length ?? '…'} zamówień na stronie</span>
        </div>
        <OrderFieldListControls refresh={refresh} onChange={setFieldScope} />
        {error ? (
          <ErrorBlock message={error} />
        ) : !data ? (
          <Loading />
        ) : (
          <OrderTable
            rows={data.data}
            fieldColumns={fieldScope.columns}
            onOrder={(id) => {
              if (!mergeLocked && !proformaLocked && !printLocked && !localInvoicesLocked(proformaContextKey)) onOrder(id);
            }}
            selected={selected}
            onToggle={write ? setSelected : undefined}
          />
        )}
      </fieldset>
      <div className="table-footer">
        <span>Wybierz zamówienie, aby przejść do realizacji.</span>
        <div>
          <button
            className="button small-btn"
            disabled={listLocked || !stack.length}
            onClick={() => {
              setCursor(stack.at(-1) ?? null);
              setStack((s) => s.slice(0, -1));
            }}
          >
            Poprzednia
          </button>
          <button
            className="button small-btn"
            disabled={listLocked || !data?.meta.has_more}
            onClick={() => {
              setStack((s) => [...s, cursor]);
              setCursor(data.meta.cursor);
            }}
          >
            Następna
          </button>
        </div>
      </div>
    </section>
  );
  // The status panel is drawn by the app shell (left options panel); the list keeps only filters and table.
  return list;
}
function Documents({
  refresh,
  contextKey,
  readOnly,
}: {
  refresh: number;
  contextKey: string;
  readOnly: boolean;
}) {
  const invoiceTransport = useMemo(() => createB2bInvoiceHttp159(contextKey.split(':')[0]), [contextKey]);
  const correctionTransport = useMemo(() => createB2bCorrectionHttp160(contextKey.split(':')[0]), [contextKey]);
  const [correctionSelection, setCorrectionSelection] = useState<{context:string;id:string}|null>(null);
  const [creditLocked, setCreditLocked] = useState(() => b2bCorrectionLocked(contextKey));
  useEffect(() => subscribeB2bCorrectionLock(contextKey, setCreditLocked), [contextKey]);
  const [documentSiblingLocked, setDocumentSiblingLocked] = useState(false);
  useEffect(() => {const update=()=>setDocumentSiblingLocked(b2bInvoiceLocked(contextKey) || b2bFa3ProjectLocked(contextKey) || localInvoicesLocked(contextKey) || getPrintJobsMutationState(contextKey).locked);const cleanups=[subscribeB2bInvoiceLock(contextKey,update),subscribeB2bFa3ProjectLock(contextKey,update),subscribeLocalInvoicesLock(contextKey,update),subscribePrintJobsLock(contextKey,update)];update();return()=>{for(const cleanup of cleanups)cleanup();};},[contextKey]);
  const selectedOriginal = b2bCorrectionPendingOriginal(contextKey) ?? (correctionSelection?.context === contextKey ? correctionSelection.id : undefined);
  const { data, error } = useData('/documents', refresh);
  if (error) return <ErrorBlock message={error} />;
  if (!data) return <Loading />;
  const legacyDocuments = data.data.filter((d: any) => d.mode !== 'local_invoice' && d.mode !== 'b2b_invoice' && d.mode !== 'b2b_correction' && d.mode !== 'invoice230');
  return (
    <>
      <SettlementReport key={'settlement:' + contextKey} contextKey={contextKey} admin={contextKey.split(':')[2] === 'admin'} />
      <B2bInvoiceRegister contextKey={contextKey} readOnly={readOnly} refresh={refresh} transport={invoiceTransport} onSelectInvoice={document => setCorrectionSelection({context:contextKey,id:document.id})} />
      {selectedOriginal && <B2bCorrectionIssuePanel key={'correction-source:' + contextKey + ':' + selectedOriginal} originalDocumentId={selectedOriginal} contextKey={contextKey} readOnly={readOnly} refresh={refresh} transport={correctionTransport} externalWriteBlocked={documentSiblingLocked} />}
      <B2bCorrectionRegister contextKey={contextKey} readOnly={readOnly} refresh={refresh} transport={correctionTransport} />
      <LocalInvoiceRegister contextKey={contextKey} readOnly={readOnly} refresh={refresh} externalWriteBlocked={creditLocked} />
      <Invoice230Register key={'invoice230:' + contextKey} contextKey={contextKey} readOnly={readOnly} refresh={refresh} />
      <Invoice232Register key={'invoice232:' + contextKey} contextKey={contextKey} readOnly={readOnly} refresh={refresh} />
      <LocalConsumerCreditRegister contextKey={contextKey} refresh={refresh} />
      <TaxOssSettingsPanel key={'tax-oss:' + contextKey} contextKey={contextKey} readOnly={readOnly} admin={contextKey.split(':')[2] === 'admin'} />
      <NbpRatesPanel key={'nbp227:' + contextKey} contextKey={contextKey} readOnly={readOnly} />
      <JpkFilesPanel key={'jpk:' + contextKey} contextKey={contextKey} admin={contextKey.split(':')[2] === 'admin'} />
      <KsefQueuePanel key={'ksef229:' + contextKey + ':' + refresh} role={contextKey.split(':')[2] ?? ''} readOnly={readOnly} />
      <PurchaseInvoicesPanel key={'ksef243:' + contextKey + ':' + refresh} readOnly={readOnly} />
      <ProformaSeriesPanel contextKey={contextKey} readOnly={readOnly} externalWriteBlocked={creditLocked} />
      <DeferredPrintPanel contextKey={contextKey} title="Kolejka wydruków"><PrintJobsPanel contextKey={contextKey} readOnly={readOnly} externalWriteBlocked={creditLocked} /></DeferredPrintPanel>
      <section className="panel">
        <div className="notice">
          <FileText size={20} />
          <span>
            Lokalne faktury B2C są w osobnym rejestrze powyżej. Tu znajdują się proformy, dokumenty DEMO i faktury z Fakturowni. Podgląd dostawcy otwiera PDF z
            konta integracji.
          </span>
        </div>
        {!legacyDocuments.length ? (
          <Empty>Proformę wystawisz na karcie zamówienia po skonfigurowaniu serii numeracji.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Dokument</th>
                  <th>Zamówienie</th>
                  <th>Rodzaj</th>
                  <th className="right">Wartość</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {legacyDocuments.map((d: any) => (
                  <tr key={d.id}>
                    <td>
                      <strong>{d.number}</strong>
                      <small>{date(d.created_at)}</small>
                    </td>
                    <td>{d.order_number}</td>
                    <td>
                      {d.kind === 'proforma'
                        ? 'Pro forma'
                        : d.kind === 'invoice'
                          ? 'Sprzedaż'
                          : 'Korekta'}{' '}
                      <span className="badge">
                        {d.kind === 'proforma' && d.mode === 'local'
                          ? 'Lokalna'
                          : d.mode === 'external'
                            ? 'Fakturownia'
                            : 'DEMO'}
                      </span>
                    </td>
                    <td className="right">
                      {money(
                        d.kind === 'proforma' ? Number(d.data.totals.gross_minor) : d.data.total,
                        d.data.currency,
                      )}
                    </td>
                    <td>
                      <a
                        className="text-button"
                        href={`/api/documents/${d.id}/print`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Printer size={16} />
                        Podgląd
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
function Integrations({
  contextKey,
  readOnly,
  recoveryContext,
  onOpenOrder,
  catalogWriteBlocked,
  refresh,
  add,
  admin,
  write,
  reload,
  notify,
  onFieldMappings,
}: {
  contextKey: string;
  readOnly: boolean;
  recoveryContext: RecoveryIdentity;
  onOpenOrder: (orderId: string) => void;
  catalogWriteBlocked: boolean;
  refresh: number;
  add: (provider: string) => void;
  admin: boolean;
  write: boolean;
  reload: () => void;
  notify: Notice;
  onFieldMappings: () => void;
}) {
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const addIntegration = (provider: string) => { if (!readOnlyRef.current) add(provider); };
  const { data, error } = useData('/integrations/workspace', refresh),
    [view, setView] = useState('connections'),
    [providerDetail, setProviderDetail] = useState<any>(null),
    [manageChannel, setManageChannel] = useState<any>(null),
    [searchInput, setSearchInput] = useState(''),
    [filters, setFilters] = useState({ search: '', provider: '', mode: '', status: '' }),
    [cursors, setCursors] = useState<string[]>(['']),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<any>(null),
    [importChannel, setImportChannel] = useState<string | null>(null),
    [syncChannel, setSyncChannel] = useState<string | null>(null),
    [catalogChannel, setCatalogChannel] = useState<string | null>(null),
    [ebayOAuthChannel, setEbayOAuthChannel] = useState<any>(null),
    [amazonOAuthChannel, setAmazonOAuthChannel] = useState<any>(null),
    [shopifyOAuthChannel, setShopifyOAuthChannel] = useState<any>(null),
    [ebayScheduleChannel, setEbayScheduleChannel] = useState<any>(null),
    [offersChannel, setOffersChannel] = useState<string | null>(null),
    [miraklChannel, setMiraklChannel] = useState<string | null>(null),
    [offersLocal,setOffersLocal]=useState(false),[syncLocal,setSyncLocal]=useState(false),
    [trackingChannel, setTrackingChannel] = useState<string | null>(null),
    [dpdChannel, setDpdChannel] = useState<string | null>(null),
    [dhlChannel, setDhlChannel] = useState<string | null>(null),
    [statusChannel, setStatusChannel] = useState<string | null>(null);
  const params = new URLSearchParams({ limit: '25' });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (cursors.at(-1)) params.set('after', cursors.at(-1)!);
  const { data: connections, error: connectionError } = useData(
    '/integrations/connections?' + params,
    refresh,
  );
  const updateFilters = (next: typeof filters) => {
    setFilters(next);
    setCursors(['']);
  };
  if (error) return <ErrorBlock message={error} />;
  if (!data) return <Loading />;
  return (
    <>
      <nav className="integration-tabs" aria-label="Widoki integracji">
        {[
          ['connections', 'Twoje połączenia'],
          ['catalog', 'Katalog integracji'],
          ['localWoo', 'Lokalne sklepy Woo'],
          ['history', 'Historia weryfikacji'],
          ['recovery', 'Problemy operacji'],
          ['points', 'Punkty InPost'],
          ['nbp', 'Kurs NBP'],
        ].map(([id, label]) => (
          <button
            key={id}
            className="button"
            aria-pressed={view === id}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {view==='localWoo'&&<ConfiguredWooStores key={contextKey} tenantId={recoveryContext.tenant_id} userId={recoveryContext.user_id} admin={admin} readOnly={readOnly} externalWriteBlocked={catalogWriteBlocked||!write} refresh={refresh} onChanged={reload} onOpenOffers={id=>{setOffersLocal(true);setOffersChannel(id);}} onOpenSync={id=>{setSyncLocal(true);setSyncChannel(id);}} onOpenOrders={setImportChannel}/>}
      {view === 'recovery' && (
        <IntegrationRecoveryQueue context={recoveryContext} transport={integrationRecoveryTransport} refresh={refresh} onOpenOrder={onOpenOrder} />
      )}
      {new URLSearchParams(location.search).get('integration') === 'ebay_denied' && (
        <p className="notice" role="status">
          Zgoda eBay została odrzucona. Harmonogramy pozostają wyłączone.
        </p>
      )}
      {view === 'catalog' && (
        <IntegrationCatalog
          registry={data.registry}
          admin={admin}
          details={setProviderDetail}
          add={addIntegration}
          readOnly={readOnly}
        />
      )}
      {view === 'connections' && (
        <>
          <div className="integration-summary" aria-label="Podsumowanie połączeń firmy">
            <div>
              <strong>{data.summary.total}</strong>
              <span>Wszystkie połączenia</span>
            </div>
            <div>
              <strong>{data.summary.attention}</strong>
              <span>Wymagają uwagi</span>
            </div>
            <div>
              <strong>{data.summary.simulation}</strong>
              <span>Przykłady lokalne</span>
            </div>
            <div>
              <strong>{data.summary.verified_read}</strong>
              <span>Odczyt API potwierdzony</span>
            </div>
          </div>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Twoje połączenia</h2>
                <p>Sekrety są przechowywane w bazie w postaci zaszyfrowanej.</p>
              </div>
              {admin && (
                <button className="button primary small-btn" disabled={readOnly} onClick={() => { if (!readOnlyRef.current) setView('catalog'); }}>
                  <Plus size={16} />
                  Dodaj połączenie
                </button>
              )}
            </div>
            <details className="integration-demo">
              <summary>Dane demonstracyjne — lokalne przykłady bez kont dostawców</summary>
              <div className="inline-actions">
                {admin && !readOnly && (
                  <button
                    className="button small-btn"
                    disabled={readOnly || busy}
                    onClick={async () => {
                      if (readOnlyRef.current) return;
                      setBusy(true);
                      try {
                        const r = await api('/integrations/amazon-example', 'POST');
                        reload();
                        setImportChannel(r.channel_id);
                      } catch (e) {
                        notify((e as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Przykład Amazon
                  </button>
                )}
                {admin && !readOnly && (
                  <button
                    className="button small-btn"
                    disabled={readOnly || busy}
                    onClick={async () => {
                      if (readOnlyRef.current) return;
                      setBusy(true);
                      try {
                        const r = await api('/integrations/odoo-example', 'POST');
                        reload();
                        setCatalogChannel(r.channel_id);
                      } catch (e) {
                        notify((e as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Przykład Odoo
                  </button>
                )}
                {admin && !readOnly && (
                  <button
                    className="button small-btn"
                    disabled={readOnly || busy}
                    onClick={async () => {
                      if (readOnlyRef.current) return;
                      setBusy(true);
                      try {
                        const r = await api('/integrations/shopify-example', 'POST');
                        reload();
                        setImportChannel(r.channel_id);
                      } catch (e) {
                        notify((e as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Przykład Shopify
                  </button>
                )}
                {admin && !readOnly && (
                  <button
                    className="button small-btn"
                    disabled={readOnly || busy}
                    onClick={async () => {
                      if (readOnlyRef.current) return;
                      setBusy(true);
                      try {
                        const r = await api('/integrations/ebay-example', 'POST');
                        reload();
                        setImportChannel(r.channel_id);
                      } catch (e) {
                        notify((e as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Przykład eBay
                  </button>
                )}
                {admin && !readOnly && (
                  <button
                    className="button small-btn"
                    disabled={readOnly || busy}
                    onClick={async () => {
                      if (readOnlyRef.current) return;
                      setBusy(true);
                      try {
                        const r = await api('/integrations/prestashop-example', 'POST');
                        reload();
                        setImportChannel(r.channel_id);
                      } catch (e) {
                        notify((e as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Przykład PrestaShop
                  </button>
                )}
                {admin && !readOnly && (
                  <button
                    className="button small-btn"
                    disabled={readOnly || busy}
                    onClick={async () => {
                      if (readOnlyRef.current) return;
                      setBusy(true);
                      try {
                        const r = await api('/integrations/demo-import', 'POST');
                        reload();
                        setImportChannel(r.channel_id);
                      } catch (e) {
                        notify((e as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Przykład importu
                  </button>
                )}
                {admin && !readOnly && (
                  <button
                    className="button small-btn"
                    disabled={readOnly || busy}
                    onClick={async () => {
                      if (readOnlyRef.current) return;
                      setBusy(true);
                      try {
                        const r = await api('/integrations/allegro-example', 'POST');
                        reload();
                        setImportChannel(r.channel_id);
                      } catch (e) {
                        notify((e as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Przykład Allegro
                  </button>
                )}
              </div>
            </details>
            <form
              className="integration-filters"
              onSubmit={(e) => {
                e.preventDefault();
                updateFilters({ ...filters, search: searchInput.trim() });
              }}
            >
              <label>
                Wyszukaj połączenie
                <input
                  aria-label="Wyszukaj połączenie"
                  value={searchInput}
                  maxLength={100}
                  placeholder="Nazwa lub dostawca"
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              </label>
              <label>
                Dostawca
                <select
                  aria-label="Filtr dostawcy połączeń"
                  value={filters.provider}
                  onChange={(e) => updateFilters({ ...filters, provider: e.target.value })}
                >
                  <option value="">Wszyscy dostawcy</option>
                  {data.registry.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Środowisko
                <select
                  aria-label="Filtr środowiska połączeń"
                  value={filters.mode}
                  onChange={(e) => updateFilters({ ...filters, mode: e.target.value })}
                >
                  <option value="">Wszystkie</option>
                  <option value="sandbox">Sandbox / konto testowe</option>
                  <option value="live">API produkcyjne</option>
                </select>
              </label>
              <label>
                Status
                <select
                  aria-label="Filtr statusu połączeń"
                  value={filters.status}
                  onChange={(e) => updateFilters({ ...filters, status: e.target.value })}
                >
                  <option value="">Wszystkie statusy</option>
                  <option value="attention">Wymagają uwagi</option>
                  <option value="simulation">Przykłady lokalne</option>
                  <option value="verified_read">Odczyt API potwierdzony</option>
                  <option value="authorized_read">Zgoda przyznana</option>
                  <option value="not_verified">Niezweryfikowane</option>
                </select>
              </label>
              <button className="button" type="submit">
                <Search size={16} />
                Szukaj
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setSearchInput('');
                  updateFilters({ search: '', provider: '', mode: '', status: '' });
                }}
              >
                Wyczyść filtry
              </button>
            </form>
            {connectionError ? (
              <ErrorBlock message={connectionError} />
            ) : !connections ? (
              <Loading />
            ) : !connections.data.length ? (
              <Empty>
                {data.summary.total
                  ? 'Brak połączeń dla wybranych filtrów.'
                  : 'Dodaj połączenie z katalogu lub rozwiń dane demonstracyjne.'}
              </Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Połączenie</th>
                      <th>Środowisko</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {connections.data.map((ch: any) => (
                      <tr key={ch.id}>
                        <td>
                          <strong>{ch.name}</strong>
                          <small>
                            {data.registry.find((p: any) => p.id === ch.provider)?.name ??
                              ch.provider}
                          </small>
                        </td>
                        <td>
                          <Badge status={ch.mode} />
                        </td>
                        <td>
                          <Badge status={ch.status} />
                        </td>
                        <td>
                          <div className="inline-actions">
                            <button
                              className="button small-btn"
                              aria-label={`Zarządzaj połączeniem ${ch.name}`}
                              onClick={() => setManageChannel(ch)}
                            >
                              Zarządzaj
                            </button>
                            <button
                              className="text-button"
                              aria-label={`Zakres dostawcy ${ch.name}`}
                              onClick={() =>
                                setProviderDetail(
                                  data.registry.find((p: any) => p.id === ch.provider),
                                )
                              }
                            >
                              Zakres
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {connections && (
              <div className="table-footer integration-pagination">
                <span role="status">
                  Wyświetlono {connections.data.length} z {connections.total} połączeń · strona{' '}
                  {cursors.length}
                </span>
                <div className="inline-actions">
                  <button
                    className="button small-btn"
                    disabled={cursors.length === 1}
                    onClick={() => setCursors(cursors.slice(0, -1))}
                  >
                    Poprzednia strona
                  </button>
                  <button
                    className="button small-btn"
                    disabled={!connections.next}
                    onClick={() => setCursors([...cursors, connections.next])}
                  >
                    Następna strona
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}
      {view === 'nbp' && <NbpRates contextKey={contextKey} readOnly={readOnly} />}
      {view === 'points' && (
        <InPostPoints contextKey={contextKey} readOnly={readOnly} refresh={refresh} />
      )}
      {view === 'history' && (
        <IntegrationVerificationHistory contextKey={contextKey} tenantId={recoveryContext.tenant_id}
          userId={recoveryContext.user_id} refresh={refresh} recentRuns={data.runs} />
      )}
      {manageChannel && (
        <Modal title={manageChannel.name + ' — zarządzanie'} onClose={() => setManageChannel(null)}>
          <div className="integration-connection-heading">
            <Badge status={manageChannel.mode} />
            <Badge status={manageChannel.status} />
            <span>
              {data.registry.find((p: any) => p.id === manageChannel.provider)?.name ??
                manageChannel.provider}
            </span>
          </div>
          {manageChannel.settings.simulation && (
            <p className="notice compact-notice">
              Lokalny przykład bez połączenia z kontem dostawcy.
            </p>
          )}
          {!admin && !write && (
            <p className="muted">
              Konto ma uprawnienia tylko do odczytu. Konfigurację i synchronizację obsługuje
              administrator firmy.
            </p>
          )}
          <div
            className="integration-connection-actions"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('button')) setManageChannel(null);
            }}
          >
            {[manageChannel].map((ch: any) => (
              <React.Fragment key={ch.id}>
                <div className="inline-actions">
                  {admin&&ch.provider==='mirakl'&&<button className="button small-btn" disabled={readOnly||busy} onClick={()=>{if(!readOnlyRef.current)setMiraklChannel(ch.id);}}>Odczyty Mirakl</button>}
                  {admin && ch.provider === 'shopify' && (
                    <button className="button small-btn" disabled={readOnly || busy} onClick={() => { if (!readOnlyRef.current) setShopifyOAuthChannel(ch); }}>
                      Konto Shopify i OAuth
                    </button>
                  )}
                  {admin && ch.provider === 'amazon' && (
                    <button className="button small-btn" disabled={readOnly || busy} onClick={() => { if (!readOnlyRef.current) setAmazonOAuthChannel(ch); }}>
                      Konto Amazon i OAuth
                    </button>
                  )}
                  {admin && ch.provider === 'ebay' && (
                    <button className="button small-btn" disabled={readOnly || busy} onClick={() => { if (!readOnlyRef.current) setEbayScheduleChannel(ch); }}>
                      Automatyczne wysyłki eBay
                    </button>
                  )}
                  {admin && ch.provider === 'ebay' && (
                    <button className="button small-btn" disabled={readOnly || busy} onClick={() => { if (!readOnlyRef.current) setEbayOAuthChannel(ch); }}>
                      Konto eBay i OAuth
                    </button>
                  )}
                  {admin && ch.provider === 'allegro' && !ch.settings.simulation && (
                    <button
                      className="button small-btn"
                      disabled={readOnly || busy}
                      onClick={async () => {
                        if (readOnlyRef.current) return;
                        setBusy(true);
                        try {
                          const r = await api(`/integrations/${ch.id}/oauth/start`, 'POST');
                          location.assign(r.url);
                        } catch (e) {
                          notify((e as Error).message, true);
                          setBusy(false);
                        }
                      }}
                    >
                      Połącz konto Allegro
                    </button>
                  )}
                  {admin && !ch.settings.simulation && (
                    <button
                      className="button small-btn"
                      disabled={readOnly || busy}
                      onClick={async () => {
                        if (readOnlyRef.current) return;
                        setBusy(true);
                        try {
                          await api(`/integrations/${ch.id}/test`, 'POST');
                          notify('Dostęp do odczytu API potwierdzony.');
                        } catch (e) {
                          notify((e as Error).message, true);
                        } finally {
                          reload();
                          setBusy(false);
                        }
                      }}
                    >
                      Test połączenia
                    </button>
                  )}
                  {admin &&
                    !ch.settings.simulation &&
                    !['inpost', 'dpd', 'dhl', 'pocztapolska', 'bigbuy', 'odoo', 'mirakl'].includes(ch.provider) && (
                      <button
                        className="button small-btn"
                        disabled={readOnly || busy}
                        onClick={async () => {
                          if (readOnlyRef.current) return;
                          setBusy(true);
                          try {
                            setPreview(
                              await api(
                                `/integrations/${ch.id}/preview?resource=${ch.provider === 'fakturownia' ? 'invoices' : 'orders'}`,
                              ),
                            );
                          } catch (e) {
                            notify((e as Error).message, true);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Podgląd danych
                      </button>
                    )}
                  {ch.provider === 'bigbuy' && (
                    <span className="muted">Katalog w Zakupach i dostawach</span>
                  )}
                  {admin &&
                    !ch.settings.simulation &&
                    ['prestashop', 'shopify', 'odoo'].includes(ch.provider) && (
                      <button
                        className="button small-btn"
                        disabled={readOnly || busy}
                        onClick={async () => {
                          if (readOnlyRef.current) return;
                          setBusy(true);
                          try {
                            setPreview(
                              await api(`/integrations/${ch.id}/preview?resource=products`),
                            );
                          } catch (e) {
                            notify((e as Error).message, true);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Podgląd produktów
                      </button>
                    )}
                  {admin &&
                    [
                      'allegro',
                      'woocommerce',
                      'prestashop',
                      'shopify',
                      'odoo',
                      'ebay',
                      'amazon',
                      'mirakl',
                    ].includes(ch.provider) && (
                      <button className="button small-btn" disabled={readOnly || busy} onClick={() => { if (!readOnlyRef.current) setImportChannel(ch.id); }}>
                        {['allegro', 'woocommerce', 'shopify'].includes(ch.provider)
                          ? 'Import bez mapowania pól'
                          : 'Import i powiązania'}
                      </button>
                    )}
                  {['allegro', 'woocommerce', 'shopify'].includes(ch.provider) && (
                    <button className="button small-btn" onClick={onFieldMappings}>
                      Pola — mapowania kanałów
                    </button>
                  )}
                  {admin &&
                    [
                      'allegro',
                      'woocommerce',
                      'prestashop',
                      'shopify',
                      'odoo',
                      'ebay',
                      'amazon',
                    ].includes(ch.provider) && (
                      <button className="button small-btn" onClick={() => setSyncChannel(ch.id)}>
                        Synchronizacja
                      </button>
                    )}
                  {admin &&
                    ['woocommerce', 'shopify', 'odoo', 'ebay', 'amazon'].includes(ch.provider) && (
                      <button className="button small-btn" onClick={() => setCatalogChannel(ch.id)}>
                        Import katalogu
                      </button>
                    )}
                  {admin && ['inpost', 'dpd', 'dhl', 'pocztapolska'].includes(ch.provider) && (
                    <button className="button small-btn" disabled={readOnly || busy} onClick={() => { if (!readOnlyRef.current) setTrackingChannel(ch.id); }}>
                      Automatyczny tracking
                    </button>
                  )}
                  {write && ch.provider === 'dpd' && (
                    <button className="button small-btn" disabled={readOnly || busy} onClick={() => { if (!readOnlyRef.current) setDpdChannel(ch.id); }}>
                      Odbiór i protokoły DPD
                    </button>
                  )}
                  {write && ch.provider === 'dhl' && (
                    <button className="button small-btn" disabled={readOnly || busy} onClick={() => { if (!readOnlyRef.current) setDhlChannel(ch.id); }}>
                      Odbiór kurierem DHL
                    </button>
                  )}
                  {admin &&
                    ['allegro', 'woocommerce', 'prestashop', 'shopify', 'ebay', 'amazon'].includes(
                      ch.provider,
                    ) && (
                      <button className="button small-btn" onClick={() => setOffersChannel(ch.id)}>
                        Oferty i zapis
                      </button>
                    )}
                  {admin && ['allegro', 'woocommerce', 'prestashop'].includes(ch.provider) && (
                    <button className="button small-btn" onClick={() => setStatusChannel(ch.id)}>
                      Statusy zamówień
                    </button>
                  )}
                  {admin && ch.provider === 'allegro' && !ch.settings.simulation && (
                    <button
                      className="button small-btn"
                      disabled={readOnly || busy}
                      onClick={async () => {
                        if (readOnlyRef.current) return;
                        setBusy(true);
                        try {
                          const r = await api('/integrations/' + ch.id + '/oauth/start', 'POST', {
                            orders_write: true,
                            offers_write: (ch.oauth_scopes ?? '').includes(
                              'allegro:api:sale:offers:write',
                            ),
                          });
                          location.assign(r.url);
                        } catch (e) {
                          notify((e as Error).message, true);
                          setBusy(false);
                        }
                      }}
                    >
                      Połącz z prawem zapisu statusów
                    </button>
                  )}
                  {admin && ch.provider === 'allegro' && !ch.settings.simulation && (
                    <button
                      className="button small-btn"
                      disabled={readOnly || busy}
                      onClick={async () => {
                        if (readOnlyRef.current) return;
                        setBusy(true);
                        try {
                          const r = await api('/integrations/' + ch.id + '/oauth/start', 'POST', {
                            offers_write: true,
                            orders_write: (ch.oauth_scopes ?? '').includes(
                              'allegro:api:orders:write',
                            ),
                          });
                          location.assign(r.url);
                        } catch (e) {
                          notify((e as Error).message, true);
                          setBusy(false);
                        }
                      }}
                    >
                      Połącz z prawem zapisu ofert
                    </button>
                  )}
                </div>
              </React.Fragment>
            ))}
          </div>
        </Modal>
      )}
      {providerDetail && (
        <Modal
          title={providerDetail.name + ' — zakres i wymagania'}
          onClose={() => setProviderDetail(null)}
        >
          <div className="integration-provider-detail">
            <p className="provider-summary">{providerSummaries[providerDetail.id]}</p>
            <p>{providerDetail.note}</p>
            <div className="notice compact-notice">
              Implementacja konektora i lokalne przykłady nie potwierdzają działania na Twoim
              koncie. Test połączenia potwierdza wyłącznie odczyt API.
            </div>
            <details className="integration-scope">
              <summary>Dokładny zakres techniczny</summary>
              <strong>Dostępne w konektorze</strong>
              <small>{providerDetail.implemented.join(' · ')}</small>
              {providerDetail.planned.length > 0 && (
                <>
                  <strong>Do realizacji</strong>
                  <small>{providerDetail.planned.join(' · ')}</small>
                </>
              )}
            </details>
            <div className="inline-actions">
              <a className="button" href={providerDetail.docs} target="_blank" rel="noreferrer">
                Dokumentacja API <ExternalLink size={14} />
              </a>
              {admin && (
                <button
                  className="button primary"
                  disabled={readOnly}
                  onClick={() => {
                    if (readOnlyRef.current) return;
                    const id = providerDetail.id;
                    setProviderDetail(null);
                    addIntegration(id);
                  }}
                >
                  Dodaj połączenie {providerDetail.name}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal title="Podgląd danych API — bez importu" onClose={() => setPreview(null)}>
          <pre className="api-preview">{JSON.stringify(preview, null, 2)}</pre>
        </Modal>
      )}
      {importChannel && (
        <Modal title="Import zamówień i powiązania ofert" onClose={() => setImportChannel(null)}>
          <ImportQueue
            key={contextKey + ':' + importChannel + ':' + readOnly}
            contextKey={contextKey}
            readOnly={readOnly}
            channelId={importChannel}
            onImported={(number) => {
              notify(`Zaimportowano ${number}.`);
            }}
          />
        </Modal>
      )}
      {!readOnly && dhlChannel && (
        <Modal title="Odbiór kurierem DHL" onClose={() => setDhlChannel(null)}>
          <DhlPickups key={dhlChannel} channelId={dhlChannel} />
        </Modal>
      )}
      {!readOnly && dpdChannel && (
        <Modal title="Odbiór i protokoły DPD" onClose={() => setDpdChannel(null)}>
          <DpdCollections channelId={dpdChannel} admin={admin} connectorContext={{tenantId:recoveryContext.tenant_id,userId:recoveryContext.user_id,admin,readOnly,externalWriteBlocked:catalogWriteBlocked||!write}} />
        </Modal>
      )}
      {syncChannel && (
        <Modal title="Synchronizacja i powiadomienia" onClose={() => {setSyncChannel(null);setSyncLocal(false);}}>
          <SyncPanel key={syncChannel} channelId={syncChannel} localWooContext={syncLocal?{tenantId:recoveryContext.tenant_id,userId:recoveryContext.user_id,admin,readOnly,externalWriteBlocked:catalogWriteBlocked||!write}:undefined} connectorContext={!syncLocal?{tenantId:recoveryContext.tenant_id,userId:recoveryContext.user_id,admin,readOnly,externalWriteBlocked:catalogWriteBlocked||!write}:undefined} />
        </Modal>
      )}
      {catalogChannel && (
        <Modal title="Import katalogu" onClose={() => setCatalogChannel(null)}>
          <CatalogSourcePanel channelId={catalogChannel} contextKey={contextKey} readOnly={readOnly} externalWriteBlocked={catalogWriteBlocked || !write} />
        </Modal>
      )}
      {!readOnly && ebayScheduleChannel && (
        <Modal title="Automatyczne wysyłki eBay" onClose={() => setEbayScheduleChannel(null)}>
          <EbayFulfillmentSchedulePanel channel={ebayScheduleChannel} />
        </Modal>
      )}
      {!readOnly && shopifyOAuthChannel && (
        <Modal
          title="Połączenie sklepu Shopify"
          onClose={() => {
            setShopifyOAuthChannel(null);
            reload();
          }}
        >
          <ShopifyOAuthPanel channel={shopifyOAuthChannel} />
        </Modal>
      )}
      {!readOnly && amazonOAuthChannel && (
        <Modal
          title="Połączenie konta Amazon"
          onClose={() => {
            setAmazonOAuthChannel(null);
            reload();
          }}
        >
          <AmazonOAuthPanel channel={amazonOAuthChannel} />
        </Modal>
      )}
      {!readOnly && ebayOAuthChannel && (
        <Modal
          title="Połączenie konta eBay"
          onClose={() => {
            setEbayOAuthChannel(null);
            reload();
          }}
        >
          <EbayOAuthPanel channel={ebayOAuthChannel} />
        </Modal>
      )}
      {miraklChannel&&<Modal title="Mirakl — konto, harmonogram i zapisy" onClose={()=>setMiraklChannel(null)}>
        <MiraklReadsPanel key={recoveryContext.tenant_id+':'+recoveryContext.user_id+':'+miraklChannel} channelId={miraklChannel} tenantId={recoveryContext.tenant_id} userId={recoveryContext.user_id} admin={admin} readOnly={readOnly}/>
        <Mirakl262Panel key={'262:'+recoveryContext.tenant_id+':'+recoveryContext.user_id+':'+miraklChannel} channelId={miraklChannel} admin={admin} readOnly={readOnly}/>
      </Modal>}
      {offersChannel && (
        <Modal title="Oferty i zapis do kanału" onClose={() => {setOffersChannel(null);setOffersLocal(false);}}>
          <OffersPanel key={offersChannel} channelId={offersChannel} localWooContext={offersLocal?{tenantId:recoveryContext.tenant_id,userId:recoveryContext.user_id,admin,readOnly,externalWriteBlocked:catalogWriteBlocked||!write}:undefined} connectorContext={!offersLocal?{tenantId:recoveryContext.tenant_id,userId:recoveryContext.user_id,admin,readOnly,externalWriteBlocked:catalogWriteBlocked||!write}:undefined} />
        </Modal>
      )}
      {statusChannel && (
        <Modal title="Statusy zamówień w kanale" onClose={() => setStatusChannel(null)}>
          <OrderStatusConfig key={statusChannel} channelId={statusChannel} readOnly={readOnly} />
        </Modal>
      )}
      {!readOnly && trackingChannel && (
        <Modal title="Automatyczny tracking przesyłek" onClose={() => setTrackingChannel(null)}>
          <TrackingPanel key={trackingChannel} channelId={trackingChannel} />
        </Modal>
      )}
    </>
  );
}
function SettingsPage({ refresh }: { refresh: number }) {
  const { data, error } = useData('/settings', refresh);
  if (error) return <ErrorBlock message={error} />;
  if (!data) return <Loading />;
  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="panel-heading">
          <h2>Magazyny organizacji</h2>
          <Warehouse size={20} />
        </div>
        <div className="warehouse-list">
          {data.warehouses.map((w: any) => (
            <div key={w.id}>
              <div className="integration-icon">
                <Warehouse size={22} />
              </div>
              <div>
                <strong>{w.name}</strong>
                <small>Kod: {w.code}</small>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Środowisko lokalne</h2>
        </div>
        <div className="info-body">
          <p>Sesje: {data.capabilities.sessions}. Uprawnienia sprawdzane przy każdym żądaniu.</p>
          <p>
            Zapisy do API dostawców wymagają skonfigurowanego połączenia i jawnego zatwierdzenia
            operacji. Przykłady lokalne są oznaczone DEMO.
          </p>
          <p>
            Pełny zakres Base jest rozwijany etapami. Aktualne pokrycie i ograniczenia opisuje
            dokumentacja projektu.
          </p>
        </div>
      </section>
    </div>
  );
}
type ManualCreateRow = { draftKey:string; product_id:string; quantity:number; lineAmount?:string; cataloguePrice?:number; amountEdited?:boolean; priceLoading?:boolean; priceError?:string };
function manualCreateMinor(value:string,max=2147483647):number {
  const raw=value.trim();
  if(!/^(?:0|[1-9][0-9]*)(?:[.,][0-9]{1,2})?$/.test(raw))throw Error('Kwota brutto wymaga nieujemnej wartości i najwyżej dwóch miejsc dziesiętnych.');
  const [whole,decimal='']=raw.replace(',','.').split('.');
  const minor=BigInt(whole)*100n+BigInt(decimal.padEnd(2,'0'));
  if(minor>BigInt(max))throw Error('Kwota brutto przekracza dozwolony limit.');
  return Number(minor);
}
const manualCreateAmount=(minor:bigint)=>`${minor/100n}.${String(minor%100n).padStart(2,'0')}`;
export function CreateModal({
  kind,
  readOnly,
  inventoryContextKey = '',
  inventoryWriteBlocked = false,
  initialProvider = 'allegro',
  onClose,
  onSaved,
}: {
  kind: string;
  readOnly: boolean;
  inventoryContextKey?: string;
  inventoryWriteBlocked?: boolean;
  initialProvider?: string;
  onClose: () => void;
  onSaved: (text: string, id?: string) => void;
}) {
  // The existing settings route reads only this tenant and its warehouses.
  // Organization usage, invitations and provider configuration are not order options.
  const needsWarehouses = ['product', 'order', 'adjust'].includes(kind);
  const { data: warehouseData, error: warehouseError } = useData('/warehouses', 0, kind === 'product' || kind === 'adjust'),
    { data: integrations, error: integrationError } = useData('/integrations/workspace', 0, kind === 'integration'),
    { data: workspaceSettings, error: settingsError } = useData('/settings', 0, kind === 'order');
  const warehouses = kind === 'order' ? workspaceSettings && { data: workspaceSettings.warehouses } : warehouseData;
  const error = kind === 'order'
    ? settingsError || (workspaceSettings && (!Array.isArray(workspaceSettings.warehouses) || !['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(workspaceSettings.tenant?.currency)) ? 'Niepełny odczyt magazynów lub waluty firmy.' : '')
    : kind === 'integration' ? integrationError : warehouseError;
  const [items, setItems] = useState<ManualCreateRow[]>([
      { draftKey:crypto.randomUUID(),product_id: '', quantity: 1 },
    ]),
    [selectedProducts, setSelectedProducts] = useState<Record<string, any>>({}),
    [adjustWarehouse, setAdjustWarehouse] = useState(''),
    [adjustStock, setAdjustStock] = useState<any>(null),
    [selectedPriceList, setSelectedPriceList] = useState<any>(null),
    [provider, setProvider] = useState(initialProvider),
    [orderKey, setOrderKey] = useState(() => crypto.randomUUID()),
    [initialFields, setInitialFields] = useState<InitialOrderFieldsState>({
      ready: false,
      available: false,
      changes: [],
      error: '',
    }),
    [fieldReset, setFieldReset] = useState(0),
    [orderAttempt, setOrderAttempt] = useState<unknown | null>(null),
    [manualPrices,setManualPrices]=useState(false),
    [manualAvailable,setManualAvailable]=useState<boolean|null>(null),
    [manualCurrency,setManualCurrency]=useState(''),
    [manualPriceError,setManualPriceError]=useState(''),
    [shippingDraft,setShippingDraft]=useState('14.99'),
    [orderPreflight,setOrderPreflight]=useState(false);
  const frozenOrder = useRef<unknown | null>(null);
  const inventoryAccess = useRef({ contextKey: inventoryContextKey, blocked: inventoryWriteBlocked, readOnly });
  inventoryAccess.current = { contextKey: inventoryContextKey, blocked: inventoryWriteBlocked, readOnly };
  const createAlive=useRef(false),createScope=useRef({kind,readOnly});
  if(createScope.current.kind!==kind || createScope.current.readOnly!==readOnly)createScope.current={kind,readOnly};
  useEffect(()=>{createAlive.current=true;return()=>{createAlive.current=false;};},[]);
  const priceIdentity=JSON.stringify(items.map(item=>[item.draftKey,item.product_id]));
  useEffect(()=>{
    let active=true;setManualAvailable(null);
    if(kind==='order')void api('/health').then(reply=>{if(active)setManualAvailable(reply.manual_order_lines_available===true);}).catch(()=>{if(active)setManualAvailable(false);});
    return()=>{active=false;};
  },[kind,readOnly]);
  useEffect(()=>{
    let active=true;
    setManualCurrency('');setManualPriceError('');
    if(!manualPrices || readOnly || kind!=='order')return()=>{active=false;};
    const ids=[...new Set(items.map(item=>item.product_id).filter(Boolean))];
    if(!ids.length)return()=>{active=false;};
    setItems(rows=>rows.map(row=>({...row,priceLoading:!!row.product_id,priceError:''})));
    void api('/pricing/quote','POST',{product_ids:ids}).then(reply=>{
      if(!active)return;
      if(!['PLN','EUR','USD','GBP','CZK'].includes(reply.currency) || !Array.isArray(reply.items) || reply.items.length!==ids.length || new Set(reply.items.map((row:any)=>row.product_id)).size!==ids.length || ids.some(id=>!reply.items.some((row:any)=>row.product_id===id && Number.isSafeInteger(row.price) && row.price>=0 && row.price<=100000000)))throw Error('Niepełny odczyt cen katalogowych wybranych produktów.');
      setManualCurrency(reply.currency);
      setItems(rows=>rows.map(row=>{
        const quoted=reply.items.find((item:any)=>item.product_id===row.product_id);
        return quoted?{...row,cataloguePrice:quoted.price,priceLoading:false,priceError:'',...(row.amountEdited?{}:{lineAmount:manualCreateAmount(BigInt(quoted.price)*BigInt(Number.isSafeInteger(row.quantity)&&row.quantity>0?row.quantity:0))})}:{...row,priceLoading:false};
      }));
    }).catch(error=>{if(active){setManualPriceError(error instanceof Error?error.message:'Nie udało się odczytać cen katalogowych.');setItems(rows=>rows.map(row=>({...row,priceLoading:false,priceError:'Odczytaj cenę ponownie, wybierając produkt.'})));}});
    return()=>{active=false;};
  },[manualPrices,priceIdentity,kind,readOnly]);
  function changeManualPrices(enabled:boolean){
    if(readOnly || frozenOrder.current || enabled && manualAvailable!==true)return;
    setManualPrices(enabled);setSelectedPriceList(null);
    setItems(rows=>rows.map(row=>({...row,lineAmount:undefined,cataloguePrice:undefined,amountEdited:false,priceError:'',priceLoading:false})));
  }
  let manualReview:{lines:{product_id:string;quantity:number;line_total:number}[];items:{product_id:string;quantity:number}[];goods:number;shipping:number;total:number}|null=null,manualIssue='';
  if(manualPrices){
    try{
      if(manualAvailable!==true)throw Error('Ta kopia nie potwierdziła obsługi osobnych kwot pozycji.');
      if(selectedPriceList)throw Error('Własnych kwot pozycji nie można łączyć z cennikiem.');
      if(!manualCurrency || manualCurrency!==workspaceSettings?.tenant.currency)throw Error('Zaczekaj na zgodny odczyt cen i waluty katalogu firmy.');
      const quantities=new Map<string,number>(),totals=new Map<string,number>();
      if(!items.length || items.length>100)throw Error('Zamówienie wymaga od 1 do 100 osobnych pozycji.');
      const lines=items.map((row,index)=>{
        if(!row.product_id || !Number.isSafeInteger(row.quantity) || row.quantity<1 || row.quantity>100000)throw Error(`Pozycja ${index+1}: wybierz produkt i pełną ilość od 1 do 100000.`);
        if(row.priceLoading || row.priceError || row.cataloguePrice===undefined)throw Error(`Pozycja ${index+1}: zaczekaj na pełny odczyt ceny katalogowej.`);
        const line_total=manualCreateMinor(row.lineAmount??'');
        quantities.set(row.product_id,(quantities.get(row.product_id)??0)+row.quantity);
        totals.set(row.product_id,(totals.get(row.product_id)??0)+line_total);
        return {product_id:row.product_id,quantity:row.quantity,line_total};
      });
      if([...quantities.values()].some(quantity=>quantity>100000))throw Error('Łączna ilość jednego produktu nie może przekroczyć 100000.');
      if([...totals.values()].some(value=>value>2147483647))throw Error('Łączna kwota jednego produktu przekracza limit.');
      const goods=lines.reduce((sum,row)=>sum+row.line_total,0),shipping=manualCreateMinor(shippingDraft,1000000),total=goods+shipping;
      if(!Number.isSafeInteger(total) || total>2147483647)throw Error('Wartość całego zamówienia przekracza limit.');
      manualReview={lines,items:[...quantities].map(([product_id,quantity])=>({product_id,quantity})),goods,shipping,total};
    }catch(error){manualIssue=error instanceof Error?error.message:'Sprawdź wszystkie osobne kwoty pozycji.';}
  }
  const title: Record<string, string> = {
    product: 'Nowy produkt',
    order: 'Nowe zamówienie',
    adjust: 'Korekta stanu',
    automation: 'Nowa automatyzacja',
    integration: 'Nowe połączenie API',
    warehouse: 'Nowy magazyn',
  };
  const warehouseOptions = warehouses?.data.map((w: any) => (
    <option key={w.id} value={w.id}>
      {w.name}
    </option>
  ));
  const p = integrations?.registry.find((p: any) => p.id === provider);
  async function save(d: FormData) {
    if (!createAlive.current || createScope.current.kind !== kind || inventoryAccess.current.readOnly || inventoryAccess.current.contextKey !== inventoryContextKey)
      throw Error('Podgląd kopii jest tylko do odczytu lub kontekst tworzenia zmienił się.');
    if ((kind === 'product' || kind === 'adjust') &&
      (inventoryAccess.current.readOnly || inventoryAccess.current.blocked ||
        inventoryAccess.current.contextKey !== inventoryContextKey || stocktakeAdjustmentsLocked(inventoryContextKey) || warehouseAutomaticWzLocked(inventoryContextKey) || catalogStockControlLocked(inventoryContextKey)))
      throw Error('Najpierw potwierdź wynik rozliczenia inwentaryzacji.');
    if (kind === 'product') {
      await api('/products', 'POST', {
        name: f(d, 'name'),
        sku: f(d, 'sku'),
        ean: f(d, 'ean'),
        price: Math.round(Number(f(d, 'price')) * 100),
        vat: Number(f(d, 'vat')),
        category: f(d, 'category'),
        warehouse_id: f(d, 'warehouse_id'),
        quantity: Number(f(d, 'quantity')),
        location: f(d, 'location'),
      });
      onSaved('Dodano produkt do katalogu.');
    }
    if (kind === 'order') {
      if (readOnly) throw Error('Kopia jest tylko do odczytu.');
      if (!frozenOrder.current && !['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(workspaceSettings?.tenant?.currency))
        throw Error('Zaczekaj na prawidłowy odczyt waluty firmy. Zamówienia nie wysłano.');
      if (!frozenOrder.current && !initialFields.ready)
        throw Error(initialFields.error || 'Zaczekaj na sprawdzenie dodatkowych pól zamówienia.');
      if(!frozenOrder.current && manualPrices && !manualReview)throw Error(manualIssue || 'Sprawdź pełne kwoty pozycji.');
      const body = frozenOrder.current ?? {
        customer_name: f(d, 'customer_name'),
        payment_mode: f(d, 'payment_mode'),
        email: f(d, 'email'),
        warehouse_id: f(d, 'warehouse_id'),
        currency: manualPrices?manualCurrency:selectedPriceList?.currency ?? workspaceSettings?.tenant.currency ?? 'PLN',
        ...(selectedPriceList ? { price_list_id: selectedPriceList.id } : {}),
        shipping_cost: manualPrices?manualReview!.shipping:Math.round(Number(f(d, 'shipping_cost')) * 100),
        address: {
          street: f(d, 'street'),
          city: f(d, 'city'),
          postal_code: f(d, 'postal_code'),
          country: 'PL',
        },
        items:manualPrices?manualReview!.items:items.map(({product_id,quantity})=>({product_id,quantity})),
        ...(manualPrices?{manual_lines:manualReview!.lines}:{}),
        note: f(d, 'note'),
        ...(initialFields.available
          ? { initial_fields: structuredClone(initialFields.changes) }
          : {}),
      };
      const manual=(body as {manual_lines?:{product_id:string;quantity:number;line_total:number}[];shipping_cost:number}).manual_lines;
      if(manual){
        const scope=createScope.current;
        setOrderPreflight(true);
        try{
          const health=await api('/health');
          if(!createAlive.current || createScope.current!==scope || scope.readOnly)throw Error('Kontekst tworzenia zamówienia zmienił się. Zamówienia nie wysłano.');
          if(health.manual_order_lines_available!==true){setManualAvailable(false);throw Error('Bieżący serwer nie potwierdził obsługi osobnych kwot pozycji. Zamówienia nie wysłano.');}
        }finally{if(createAlive.current)setOrderPreflight(false);}
      }
      frozenOrder.current = body;
      setOrderAttempt(body);
      try {
        const o = await api('/orders', 'POST', body, { 'Idempotency-Key': orderKey });
        if(manual){
          const tuple=(row:{product_id:string;quantity:number;line_total:number})=>JSON.stringify([row.product_id,row.quantity,row.line_total]);
          if(!Array.isArray(o.items) || o.items.length!==manual.length || o.items.some((row:any)=>typeof row.id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)) || new Set(o.items.map((row:any)=>row.id)).size!==manual.length || JSON.stringify(o.items.map(tuple).sort())!==JSON.stringify(manual.map(tuple).sort()) || o.total!==manual.reduce((sum,row)=>sum+row.line_total,0)+(body as {shipping_cost:number}).shipping_cost || o.currency!==(body as {currency:string}).currency)throw Error('Niepełne potwierdzenie osobnych pozycji zamówienia. Zachowano tę samą próbę; sprawdź zapisane zamówienie przed nową operacją.');
        }
        frozenOrder.current = null;
        setOrderAttempt(null);
        onSaved('Utworzono zamówienie i zarezerwowano towar.', o.id);
      } catch (e) {
        if (e instanceof ApiError && [401, 403, 409, 422, 423].includes(e.status)) {
          frozenOrder.current = null;
          setOrderAttempt(null);
          if ([401, 403].includes(e.status)) {
            setFieldReset((v) => v + 1);
            setInitialFields({
              ready: false,
              available: false,
              changes: [],
              error: 'Odśwież uprawnienia do pól.',
            });
          }
          if ([409, 422].includes(e.status)) setOrderKey(crypto.randomUUID());
        }
        throw e;
      }
    }
    if (kind === 'adjust') {
      const s = adjustStock;
      if (!s || s.warehouse_id !== adjustWarehouse) throw new Error('Wybierz stan w magazynie.');
      await api('/inventory/adjust', 'POST', {
        product_id: s.product_id,
        warehouse_id: s.warehouse_id,
        delta: Number(f(d, 'delta')),
        note: f(d, 'note'),
      });
      onSaved('Zapisano korektę stanu.');
    }
    if (kind === 'automation') {
      await api('/automations', 'POST', {
        name: f(d, 'name'),
        trigger: f(d, 'trigger'),
        note: f(d, 'note'),
      });
      onSaved('Utworzono regułę automatyzacji.');
    }
    if (kind === 'warehouse') {
      await api('/warehouses', 'POST', { name: f(d, 'name'), code: f(d, 'code') });
      onSaved('Dodano magazyn.');
    }
    if (kind === 'integration') {
      const credentials = Object.fromEntries(p.fields.map((key: string) => [key, f(d, key)])),
        settings = Object.fromEntries(p.settings.map((key: string) => [key, f(d, key)]));
      await api('/integrations', 'POST', {
        provider,
        name: f(d, 'name'),
        mode: f(d, 'mode'),
        credentials,
        settings,
      });
      onSaved('Zapisano połączenie. Sprawdź dostęp do API.');
    }
  }
  return (
    <Modal title={title[kind]} onClose={onClose}>
      {error ? (
        <ErrorBlock message={error} />
      ) : (needsWarehouses && !warehouses) || (kind === 'integration' && !integrations) ? (
        <Loading />
      ) : (
        <Form
          onSubmit={save}
          disabled={readOnly || ((kind === 'adjust' || kind === 'product') && inventoryWriteBlocked) || (kind === 'order' && !['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(workspaceSettings?.tenant?.currency))}
          submit={
            kind === 'order'
              ? 'Utwórz i zarezerwuj'
              : kind === 'integration'
                ? 'Zapisz konfigurację'
                : 'Zapisz'
          }
        >
          {kind === 'order' && orderAttempt !== null && (
            <p className="notice">
              Trwa próba utworzenia zamówienia. Jeśli odpowiedź zostanie utracona, ponowienie wyśle
              tę samą treść i klucz; pola szkicu są zablokowane. Przed nowym zamówieniem sprawdź
              listę.
            </p>
          )}
          <fieldset
            className="form-body order-create-fieldset"
            disabled={readOnly || (kind === 'order' && (orderAttempt !== null || orderPreflight))}
          >
            {kind === 'product' && (
              <>
                <label>
                  Nazwa produktu
                  <input name="name" placeholder="np. Lampa biurkowa Aura" required minLength={2} />
                </label>
                <div className="form-grid">
                  <label>
                    SKU
                    <input name="sku" required />
                  </label>
                  <label>
                    EAN
                    <input name="ean" />
                  </label>
                  <label>
                    Cena brutto (PLN)
                    <input name="price" type="number" min="0" step="0.01" required />
                  </label>
                  <label>
                    VAT
                    <select name="vat" defaultValue="23">
                      {[23, 8, 5, 0].map((v) => (
                        <option key={v} value={v}>
                          {v}%
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Kategoria
                    <input name="category" defaultValue="Pozostałe" />
                  </label>
                  <label>
                    Lokalizacja
                    <input name="location" defaultValue="A-01" required />
                  </label>
                  <label>
                    Magazyn<select name="warehouse_id">{warehouseOptions}</select>
                  </label>
                  <label>
                    Stan początkowy
                    <input
                      name="quantity"
                      type="number"
                      min="0"
                      step="1"
                      defaultValue="0"
                      required
                    />
                  </label>
                </div>
              </>
            )}
            {kind === 'order' && (
              <>
                <div className="form-grid">
                  <label>
                    Imię i nazwisko
                    <input name="customer_name" required minLength={2} />
                  </label>
                  <label>
                    Email
                    <input name="email" type="email" required />
                  </label>
                  <label>
                    Ulica i numer
                    <input name="street" required />
                  </label>
                  <label>
                    Miasto
                    <input name="city" required />
                  </label>
                  <label>
                    Sposób płatności
                    <select name="payment_mode">
                      <option value="prepaid">Przedpłata</option>
                      <option value="cod">Za pobraniem</option>
                    </select>
                  </label>
                  <label>
                    Kod pocztowy
                    <input name="postal_code" required />
                  </label>
                  <label>
                    Koszt dostawy (
                    {selectedPriceList?.currency ?? workspaceSettings?.tenant.currency ?? 'PLN'})
                    <input
                      name="shipping_cost"
                      type="number"
                      min="0"
                      step="0.01"
                      value={shippingDraft}
                      onChange={e=>setShippingDraft(e.target.value)}
                      required
                    />
                  </label>
                </div>
                <label>
                  Magazyn realizacji<select name="warehouse_id">{warehouseOptions}</select>
                </label>
                <label className="notice compact-notice">
                  <input type="checkbox" checked={manualPrices} disabled={manualAvailable!==true} onChange={e=>changeManualPrices(e.target.checked)}/>
                  Osobne pozycje z własną kwotą brutto
                </label>
                {manualAvailable!==true && <p className="muted">{manualAvailable===null?'Sprawdzanie obsługi osobnych kwot pozycji…':'W tej kopii własne kwoty osobnych pozycji nie są dostępne.'}</p>}
                {!manualPrices?<><DeferredOrderPanel title="Opcjonalny cennik — domyślnie cena katalogowa"><PriceListPicker
                  value={selectedPriceList?.id ?? ''}
                  onChange={setSelectedPriceList}
                /></DeferredOrderPanel><OrderPriceQuote
                  ids={items.map((i) => i.product_id)}
                  listId={selectedPriceList?.id ?? ''}
                /></>:<p className="notice compact-notice">Cennik jest wyłączony. Początkowa kwota wiersza pochodzi z aktualnej ceny katalogowej w walucie firmy. Każdy wiersz pozostaje osobną pozycją sprzedaży, także przy tym samym SKU. Edytujesz kwotę brutto całego wiersza; VAT pochodzi z produktu. Zmiana ilości przelicza kwotę katalogową do pierwszej ręcznej edycji.</p>}
                <div className="form-section-title">Produkty</div>
                {items.map((item, i) => (
                  <div className="order-item-form" key={item.draftKey} style={manualPrices?{flexWrap:'wrap',alignItems:'flex-start'}:undefined}>
                    <ProductPicker
                      label={`Produkt ${i + 1}`}
                      value={item.product_id}
                      initial={selectedProducts[item.product_id]}
                      filter={(p) => p.active && p.kind !== 'group'}
                      select={(p) => {
                        setItems((rows) =>
                          rows.map((v, n) => (n === i ? { ...v, product_id: p?.id ?? '',lineAmount:undefined,cataloguePrice:undefined,amountEdited:false,priceError:'',priceLoading:false } : v)),
                        );
                        if (p) setSelectedProducts((v) => ({ ...v, [p.id]: p }));
                      }}
                    />
                    <input
                      aria-label={`Ilość ${i + 1}`}
                      type="number"
                      min="1"
                      max={manualPrices?100000:undefined}
                      step="1"
                      value={item.quantity}
                      onChange={(e) =>
                        setItems(
                          items.map((v, n) =>
                            n === i ? { ...v, quantity: Number(e.target.value),...(manualPrices && !v.amountEdited && v.cataloguePrice!==undefined && Number.isSafeInteger(Number(e.target.value)) && Number(e.target.value)>0?{lineAmount:manualCreateAmount(BigInt(v.cataloguePrice)*BigInt(Number(e.target.value)))}:{}) } : v,
                          ),
                        )
                      }
                      required
                    />
                    {manualPrices && <label style={{flex:'1 1 220px',minWidth:0}}>Kwota całej pozycji brutto ({manualCurrency || workspaceSettings?.tenant.currency || 'waluta firmy'})
                      <input style={{width:'100%'}} aria-label={`Kwota brutto pozycji ${i+1}`} inputMode="decimal" value={item.lineAmount??''} required onChange={e=>setItems(rows=>rows.map((row,index)=>index===i?{...row,lineAmount:e.target.value,amountEdited:true}:row))}/>
                      <small>{item.priceLoading?'Odczyt ceny katalogowej…':item.priceError?item.priceError:item.cataloguePrice!==undefined && manualCurrency?`Katalog: ${money(item.cataloguePrice,manualCurrency)} za jednostkę. Kwota wiersza jest rozliczana dokładnie.`:item.cataloguePrice!==undefined?'Zaczekaj na odczyt waluty ceny katalogowej.':'Wybierz produkt, aby odczytać cenę.'}</small>
                    </label>}
                    {items.length > 1 && (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Usuń pozycję"
                        onClick={() => setItems(items.filter((_, n) => n !== i))}
                      >
                        <X size={17} />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="text-button"
                  disabled={manualPrices && items.length>=100}
                  onClick={() => setItems([...items, { draftKey:crypto.randomUUID(),product_id: '', quantity: 1 }])}
                >
                  <Plus size={16} />
                  Dodaj pozycję
                </button>
                {manualPrices && <div className="notice compact-notice">
                  {manualPriceError && <p className="error-block" role="alert">{manualPriceError}</p>}
                  {manualIssue?<p role="alert">{manualIssue}</p>:manualReview && <><p>Osobne pozycje: {manualReview.lines.length} · produkty do rezerwacji: {manualReview.items.length}</p><p>Produkty brutto: {money(manualReview.goods,manualCurrency)} · dostawa: {money(manualReview.shipping,manualCurrency)} · razem: <strong>{money(manualReview.total,manualCurrency)}</strong></p></>}
                  <p>Ręczna kwota zero jest dozwolona. Nie zmienia ceny katalogowej. Przełączenie trybu lub produktu odczyta ceny katalogowe ponownie.</p>
                </div>}
                <label>
                  Notatka
                  <textarea name="note" rows={2} />
                </label>
                <OrderInitialFields
                  key={fieldReset}
                  readOnly={readOnly}
                  onChange={setInitialFields}
                />
                <div className="notice compact-notice">
                  Towar zostanie zarezerwowany atomowo w wybranym magazynie.
                </div>
              </>
            )}
            {kind === 'adjust' && (
              <>
                <label>
                  Magazyn korekty
                  <select
                    aria-label="Magazyn korekty"
                    required
                    value={adjustWarehouse}
                    onChange={(e) => {
                      setAdjustWarehouse(e.target.value);
                      setAdjustStock(null);
                    }}
                  >
                    <option value="">Wybierz magazyn</option>
                    {warehouseOptions}
                  </select>
                </label>
                <StockPicker
                  key={adjustWarehouse}
                  label="Produkt korekty"
                  warehouse={adjustWarehouse}
                  value={adjustStock?.product_id ?? ''}
                  initial={adjustStock}
                  select={setAdjustStock}
                />
                <label>
                  Zmiana ilości (+ / −)
                  <input name="delta" type="number" step="1" required placeholder="np. 10 lub -2" />
                </label>
                <label>
                  Powód korekty
                  <textarea name="note" required minLength={3} rows={3} />
                </label>
              </>
            )}
            {kind === 'automation' && (
              <>
                <label>
                  Nazwa reguły
                  <input name="name" required minLength={2} />
                </label>
                <label>
                  Zdarzenie
                  <select name="trigger">
                    {['created', 'paid', 'picking', 'packed', 'shipped', 'return_received'].map(
                      (s) => (
                        <option key={s} value={'order.' + s}>
                          {s === 'created' ? 'Utworzenie zamówienia' : statusNames[s]}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  Notatka do dopisania
                  <textarea name="note" rows={3} required />
                </label>
                <div className="notice compact-notice">
                  Akcja: dodanie notatki do zamówienia. Nowa reguła będzie aktywna.
                </div>
              </>
            )}
            {kind === 'warehouse' && (
              <>
                <label>
                  Nazwa magazynu
                  <input name="name" required minLength={2} />
                </label>
                <label>
                  Kod magazynu
                  <input name="code" required />
                </label>
              </>
            )}
            {kind === 'integration' && p && (
              <>
                <label>
                  Dostawca
                  <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                    {integrations?.registry.map((p: any) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div key={provider}>
                  <label>
                    Nazwa połączenia
                    <input name="name" defaultValue={p?.name + ' • moje konto'} required />
                  </label>
                  <label>
                    Środowisko
                    <select name="mode" defaultValue={['deepl','mirakl'].includes(provider) ? 'live' : 'sandbox'}>
                      {provider !== 'deepl' && (
                        <option value="sandbox">
                          {provider === 'smsapi'
                            ? 'Test=1 — bez doręczenia'
                            : provider === 'mirakl' ? 'Własna instancja testowa operatora'
                            : 'Sandbox / konto testowe'}
                        </option>
                      )}
                      {provider !== 'smsapi' && (
                        <option value="live">
                          {provider === 'deepl'
                            ? 'API DeepL — plan Free lub Pro'
                            : provider === 'mirakl' ? 'Instancja operatora — odczyty'
                            : 'API produkcyjne — zapis po zatwierdzeniu'}
                        </option>
                      )}
                    </select>
                  </label>
                  {provider==='mirakl'?<MiraklConnectionFields/>:p?.settings.map((key: string) => (
                    <label key={key}>
                      {(
                        {
                          api_plan: 'Plan API DeepL',
                          host: 'Serwer SMTP (DNS)',
                          port: 'Port SMTP (465 TLS lub 587 STARTTLS)',
                          from_email: 'Adres email nadawcy',
                          from_name: 'Nazwa nadawcy',
                          sender: 'Pole nadawcy SMS (do 11 znaków)',
                          organization_id: 'ID organizacji ShipX',
                          master_fid: 'Master FID DPD',
                          sap_account: 'Numer klienta SAP DHL',
                          urzad_nadania: 'ID urzędu nadania eNadawcy',
                          shop_id: 'ID sklepu PrestaShop',
                          order_state_ids: 'ID statusów dopuszczonych do realizacji',
                          store_url: 'Adres sklepu',
                          server_url: 'Adres serwera Odoo 19 (HTTPS)',
                          database: 'Nazwa bazy Odoo',
                          company_id: 'ID firmy Odoo',
                          warehouse_id: 'ID magazynu Odoo',
                          unit_id: 'ID jednostki sztukowej Odoo',
                          price_mode:
                            provider === 'ebay'
                              ? 'Sposób naliczania cen ofert eBay'
                              : 'Ceny cennikowe Odoo',
                          inventory_access: 'Zakres zgody użytkownika eBay',
                          region: 'Region Amazon',
                          listing_write: 'Zapis cen i dostępności Amazon',
                          shipment_write: 'Przekazywanie wysyłek Amazon',
                          selling_partner_id: 'Oczekiwany identyfikator sprzedawcy Amazon',
                          application_id: 'ID aplikacji SP-API (OAuth)',
                          oauth_redirect_uri: 'Lokalny adres powrotu OAuth',
                          oauth_beta: 'Wersja aplikacji Amazon',
                          marketplace_id:
                            provider === 'amazon' ? 'Marketplace Amazon' : 'Marketplace ofert eBay',
                          fulfillment_write: 'Przekazywanie wysyłki do eBay',
                          seller_settings_read: 'Odczyt warunków sprzedaży eBay',
                        } as Record<string, string>
                      )[key] || key}
                      {provider === 'deepl' && key === 'api_plan' ? (
                        <select name={key} defaultValue="free">
                          <option value="free">API Free — klucz z końcówką :fx</option>
                          <option value="pro">API Pro</option>
                        </select>
                      ) : provider === 'smtp' ? (
                        <input
                          name={key}
                          type={key === 'from_email' ? 'email' : key === 'port' ? 'number' : 'text'}
                          defaultValue={key === 'port' ? '587' : undefined}
                          placeholder={key === 'host' ? 'smtp.example.com' : undefined}
                          required
                        />
                      ) : provider === 'amazon' && key === 'region' ? (
                        <select name={key} defaultValue="eu">
                          <option value="eu">Europa (EU)</option>
                          <option value="na">Ameryka (NA)</option>
                          <option value="fe">Daleki Wschód (FE)</option>
                        </select>
                      ) : provider === 'amazon' && key === 'marketplace_id' ? (
                        <input
                          name={key}
                          defaultValue="A1C3SOZRARQ6R3"
                          placeholder="ID marketplace"
                          required
                        />
                      ) : provider === 'amazon' && key === 'selling_partner_id' ? (
                        <input
                          name={key}
                          type="text"
                          placeholder="ID sprzedawcy z Seller Central"
                          maxLength={32}
                          pattern="[A-Z0-9]{1,32}"
                        />
                      ) : provider === 'amazon' && key === 'application_id' ? (
                        <input name={key} type="text" placeholder="amzn1.sellerapps.app.…" />
                      ) : ['amazon', 'shopify'].includes(provider) &&
                        key === 'oauth_redirect_uri' ? (
                        <input
                          name={key}
                          type="url"
                          defaultValue={`http://127.0.0.1:4100/api/oauth/${provider}/callback`}
                          required
                        />
                      ) : provider === 'amazon' && key === 'oauth_beta' ? (
                        <select name={key} defaultValue="true">
                          <option value="true">Draft — version=beta</option>
                          <option value="false">Opublikowana aplikacja</option>
                        </select>
                      ) : key === 'shipment_write' ? (
                        <select name={key} defaultValue="false">
                          <option value="false">Wyłączone</option>
                          <option value="true">
                            Włączone — wymaga Inventory and Order Tracking
                          </option>
                        </select>
                      ) : key === 'listing_write' ? (
                        <select name={key} defaultValue="false">
                          <option value="false">Wyłączony — tylko odczyt</option>
                          <option value="true">Włączony — wymaga roli Product Listing</option>
                        </select>
                      ) : key === 'seller_settings_read' ? (
                        <select name={key} defaultValue="false">
                          <option value="false">Wyłączony</option>
                          <option value="true">Odczyt — wymaga sell.account.readonly</option>
                        </select>
                      ) : key === 'fulfillment_write' ? (
                        <select name={key} defaultValue="false">
                          <option value="false">Wyłączone</option>
                          <option value="true">
                            Wysyłka i numer śledzenia — wymaga sell.fulfillment
                          </option>
                        </select>
                      ) : key === 'inventory_access' ? (
                        <select name={key} defaultValue="orders">
                          <option value="orders">Tylko zamówienia</option>
                          <option value="orders_inventory_write">
                            Zamówienia, katalog i zapis ofert — wymaga sell.inventory
                          </option>
                          <option value="orders_inventory">
                            Zamówienia i katalog — wymaga sell.inventory.readonly
                          </option>
                        </select>
                      ) : key === 'marketplace_id' ? (
                        <input
                          name={key}
                          type="text"
                          defaultValue="EBAY_DE"
                          pattern="EBAY_[A-Z_]{2,20}"
                          required
                        />
                      ) : key === 'price_mode' ? (
                        <select name={key} required defaultValue="">
                          <option value="" disabled>
                            Wybierz sposób naliczania cen
                          </option>
                          <option value="net">Netto — lokalny VAT przy imporcie</option>
                          <option value="gross">Brutto — bez doliczania VAT</option>
                        </select>
                      ) : (
                        <input
                          name={key}
                          type={
                            [
                              'database',
                              'company_id',
                              'warehouse_id',
                              'unit_id',
                              'sender',
                              'organization_id',
                              'master_fid',
                              'shop_id',
                              'order_state_ids',
                              'sap_account',
                              'urzad_nadania',
                            ].includes(key)
                              ? 'text'
                              : 'url'
                          }
                          inputMode={['organization_id', 'sap_account', 'urzad_nadania'].includes(key) ? 'numeric' : undefined}
                          pattern={key === 'organization_id' ? '[1-9][0-9]{0,17}' : key === 'sap_account' ? '[0-9]{4,10}' : key === 'urzad_nadania' ? '[1-9][0-9]{0,9}' : undefined}
                          placeholder={
                            key === 'sender'
                              ? 'Test'
                              : key === 'order_state_ids'
                                ? 'np. 2,3 — sprawdź statusy w swoim sklepie'
                                : [
                                      'organization_id',
                                      'master_fid',
                                      'shop_id',
                                      'company_id',
                                      'warehouse_id',
                                      'unit_id',
                                    ].includes(key)
                                  ? 'np. 1'
                                  : key === 'sap_account'
                                    ? 'np. 1234567'
                                  : key === 'urzad_nadania'
                                    ? 'np. 123456'
                                  : key === 'database'
                                    ? 'np. moja-firma'
                                    : 'https://…'
                          }
                          required
                        />
                      )}
                    </label>
                  ))}
                  {p?.fields.map((key: string) => (
                    <label key={key}>
                      {provider === 'deepl'
                        ? 'Klucz API DeepL'
                        : provider === 'smtp'
                          ? key === 'username'
                            ? 'Login SMTP'
                            : 'Hasło SMTP'
                          : provider === 'shopify'
                            ? (
                                {
                                  access_token: 'Token API (opcjonalny zamiast OAuth)',
                                  client_id: 'Client ID aplikacji Shopify',
                                  client_secret: 'Sekret aplikacji Shopify',
                                } as Record<string, string>
                              )[key]
                            : provider === 'amazon'
                              ? (
                                  {
                                    client_id: 'Identyfikator aplikacji (LWA)',
                                    client_secret: 'Sekret aplikacji (LWA)',
                                    refresh_token: 'Refresh token (opcjonalny zamiast OAuth)',
                                  } as Record<string, string>
                                )[key]
                              : provider === 'smsapi' && key === 'access_token'
                                ? 'Token API SMSAPI (Bearer)'
                                : provider === 'ebay' && key === 'ru_name'
                                  ? 'RuName eBay (OAuth)'
                                  : provider === 'ebay' && key === 'refresh_token'
                                    ? 'Refresh token eBay (opcjonalny zamiast OAuth)'
                                    : provider === 'dhl' || provider === 'pocztapolska'
                                      ? ({
                                          username: provider === 'dhl' ? 'Login DHL24 WebAPI2' : 'Login eNadawcy',
                                          password: provider === 'dhl' ? 'Hasło DHL24 WebAPI2' : 'Hasło eNadawcy',
                                          tracking_login: 'Login usługi Śledzenie (opcjonalny, do trackingu)',
                                          tracking_password: 'Hasło usługi Śledzenie (opcjonalne)',
                                        } as Record<string, string>)[key] ?? key
                                      : key}
                      <input
                        name={key}
                        type="password"
                        autoComplete="new-password"
                        required={
                          provider === 'shopify' || (provider === 'pocztapolska' && key.startsWith('tracking_'))
                            ? false
                            : ['ebay', 'amazon'].includes(provider)
                              ? ['client_id', 'client_secret'].includes(key)
                              : provider !== 'allegro' || key === 'access_token'
                        }
                      />
                    </label>
                  ))}
                  <p className="muted">{p?.note}</p>
                  {provider === 'shopify' && (
                    <p className="notice">
                      Podaj Client ID i sekret, aby połączyć sklep przez OAuth, albo sam token API
                      istniejącej aplikacji. Adres sklepu musi być domeną myshopify.com.
                    </p>
                  )}
                </div>
              </>
            )}
          </fieldset>
        </Form>
      )}
    </Modal>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/^\/b2b\/[0-9a-f-]{36}$/.test(location.pathname) ? (
      <B2bPortal accountId={location.pathname.split('/')[2]} />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
