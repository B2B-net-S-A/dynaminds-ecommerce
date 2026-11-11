/** Public shape of the explicit local-only native history fixture driver. */
export const HISTORY206_PREVIEW_DATABASE: 'dynaminds_full_base_preview_20261017';
export const HISTORY206_PREVIEW_REVISION: string;
export const HISTORY206_PREVIEW06_REVISION: string;
export type History206PreviewProfile = 'preview05' | 'preview06';

export type History206PreviewLogin = Readonly<{email: string; password: string}>;
export type History206PreviewLocator = Readonly<{
  schema: 'dynaminds-return-credit206-preview-locator/v1';
  databaseUrl: string;
  baseUrl: 'http://127.0.0.1:4103';
  expectedRevision: string;
  casesFile: string;
  login: History206PreviewLogin;
}>;
export type History206FixtureRequest = {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH';
  payload?: unknown;
  headers?: {cookie: string};
  remoteAddress?: string;
};
export type History206FixtureResponse = {
  statusCode: number;
  headers: {'set-cookie'?: string | string[]};
  json(): unknown;
};
export type History206FixtureApp = {
  inject(request: History206FixtureRequest): Promise<History206FixtureResponse>;
};
export type History206FixtureCase = {
  tenant_id: string;
  receipt_id: string;
  wms: boolean;
  inspection_only?: true;
};
export type History206FixtureOrder = Record<string, unknown> & {
  id: string;
  items: Array<Record<string, unknown> & {id: string; quantity: number; line_total: number}>;
};
export type History206FixtureOk = (
  path: string,
  method?: 'GET' | 'POST' | 'PATCH',
  payload?: unknown,
  status?: number,
) => Promise<Record<string, unknown>>;
export type History206BeforeReturnContext = {
  ok: History206FixtureOk;
  tenantId: string;
  order: History206FixtureOrder;
  wms: boolean;
};
export type History206BeforeReturnExtension = {
  return_items?: Array<{item_id: string; quantity: number}>;
  expected_commercial_minor?: number;
};
export type History206ReceivedContext = {
  tenantId: string;
  order: History206FixtureOrder;
  rma: Record<string, unknown> & {id: string};
  received: {
    operation: Record<string, unknown> & {id: string; created_at: string};
    return_case: Record<string, unknown>;
  };
  rejectedOnly: boolean;
  receiptId: string;
  wms: boolean;
};
/** All options are opt-in; the default remains the two accepted OFF/ON206 cases. */
export type History206FixtureOptions = {
  previewProfile?: History206PreviewProfile;
  beforeReturn?: (context: History206BeforeReturnContext) =>
    void | History206BeforeReturnExtension | Promise<void | History206BeforeReturnExtension>;
  includeRejectedHistory?: boolean;
  modes?: boolean[];
  httpReceiptIdsOnly?: boolean;
  onReceived?: (context: History206ReceivedContext) => void | Promise<void>;
};

export function validateHistory206PreviewLocator(input: unknown, previewProfile?: History206PreviewProfile): History206PreviewLocator;
export function readHistory206PreviewLocator(file: string, previewProfile?: History206PreviewProfile): Promise<History206PreviewLocator>;
export function assertHistory206CasesFileFresh(file: string): Promise<Readonly<{parent: string; cut: string}>>;
export function createHistory206PreviewTransport(input: unknown, fetcher?: typeof fetch, previewProfile?: History206PreviewProfile): Readonly<History206FixtureApp>;
export function assertHistory206PreviewReady(app: History206FixtureApp, locator: History206PreviewLocator, previewProfile?: History206PreviewProfile): Promise<void>;
export function prepareHistory206CasesFromPreview(locatorFile: string, options?: History206FixtureOptions): Promise<History206FixtureCase[]>;
export function prepareHistory206Cases(options: {
  app: History206FixtureApp;
  databaseUrl: string;
  casesFile: string;
  login?: History206PreviewLogin;
  previewAdmission?: object;
} & History206FixtureOptions): Promise<History206FixtureCase[]>;
