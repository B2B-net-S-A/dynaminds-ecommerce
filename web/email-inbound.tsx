import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import './email-inbound.css';

const prefix = '/email-inbound';
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const version = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
type Flags = {
  available: boolean;
  read_only: boolean;
  current_role: string | null;
  can_read: boolean;
  can_write: boolean;
  can_manage_accounts: boolean;
};
type WriteAttempt = {
  context: string;
  action: string;
  path: string;
  method: 'POST' | 'PATCH';
  body: string;
};
let actorContext = '',
  epoch = 0,
  inFlight = false;
let pending: WriteAttempt | null = null;
let outcome: { attempt: WriteAttempt; reply: unknown } | null = null;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((fn) => fn());
export function resetEmailInboundContext(contextKey: string) {
  if (actorContext === contextKey) return;
  actorContext = contextKey;
  epoch++;
  pending = null;
  inFlight = false;
  outcome = null;
  publish();
}
export function subscribeEmailInboundLock(contextKey: string, callback: (locked: boolean) => void) {
  const notify = () => callback(actorContext === contextKey && Boolean(pending || inFlight));
  listeners.add(notify);
  notify();
  return () => {
    listeners.delete(notify);
  };
}
function mutationState(contextKey: string) {
  return {
    epoch,
    active: actorContext === contextKey,
    locked: actorContext === contextKey && Boolean(pending || inFlight),
    inFlight: actorContext === contextKey && inFlight,
    pending: actorContext === contextKey ? pending : null,
    outcome: actorContext === contextKey ? outcome : null,
  };
}
function purgeAccess(contextKey: string) {
  if (actorContext !== contextKey) return;
  epoch++;
  pending = null;
  inFlight = false;
  outcome = null;
  publish();
}
function checkFlags(d: Flags, contextKey: string) {
  if (
    !d ||
    ['available', 'read_only', 'can_read', 'can_write', 'can_manage_accounts'].some(
      (k) => typeof d[k as keyof Flags] !== 'boolean',
    ) ||
    (d.current_role !== null && !['admin', 'operator', 'viewer'].includes(d.current_role))
  )
    throw Error('Niepełny odczyt dostępu do skrzynki email.');
  if ((d.available || d.current_role !== null) && d.current_role !== contextKey.split(':')[2])
    throw new ApiError('Zmieniła się rola użytkownika. Otwórz skrzynkę ponownie.', 403);
}
async function verifyActor(contextKey: string) {
  const parts = contextKey.split(':'),
    d = await api<{ user: { tenant_id: string; id: string; role: string } }>('/auth/me');
  if (
    parts.length !== 4 ||
    !uuid(parts[0]) ||
    !uuid(parts[1]) ||
    !['false', 'true'].includes(parts[3]) ||
    `${d.user?.tenant_id}:${d.user?.id}:${d.user?.role}` !== parts.slice(0, 3).join(':')
  )
    throw new ApiError('Zmienił się użytkownik lub organizacja skrzynki.', 403);
}
async function performWrite<T extends Flags>(args: {
  attempt: WriteAttempt;
  retry: boolean;
  readOnly: boolean;
  access: () => Promise<Options>;
  onAccess?: (access: Options) => void;
  validate: (reply: T, attempt: WriteAttempt) => void;
}): Promise<T | null> {
  const a = args.attempt;
  if (
    actorContext !== a.context ||
    inFlight ||
    args.readOnly ||
    (args.retry ? pending !== a : Boolean(pending))
  )
    return null;
  if (!a.path.startsWith(prefix + '/') || !uuid(JSON.parse(a.body).client_key))
    throw Error('Nieprawidłowa zachowana próba skrzynki.');
  const e = epoch;
  inFlight = true;
  publish();
  let sent = false;
  try {
    await verifyActor(a.context);
    const access = await args.access();
    if (actorContext !== a.context || epoch !== e) return null;
    checkFlags(access, a.context);
    if (
      !access.available ||
      !access.can_write ||
      access.read_only ||
      args.readOnly ||
      (a.path.includes('/accounts') && !a.path.endsWith('/previews') && !access.can_manage_accounts)
    )
      throw new ApiError('Brak aktualnego prawa do zapisu skrzynki.', access.read_only ? 423 : 403);
    pending = a;
    sent = true;
    publish();
    const reply = await api<T>(a.path, a.method, JSON.parse(a.body));
    if (actorContext !== a.context || epoch !== e) return null;
    checkFlags(reply, a.context);
    args.validate(reply, a);
    const last = await args.access();
    if (actorContext !== a.context || epoch !== e) return null;
    checkFlags(last, a.context);
    if (!last.available || !last.can_read)
      throw new ApiError('Dostęp do zapisanego wyniku skrzynki zmienił się.', 403);
    args.onAccess?.(last);
    // A confirmed result needs no request credentials. Only uncertain requests retain their exact body.
    outcome = { attempt: { ...a, body: '{}' }, reply };
    pending = null;
    return reply;
  } catch (error) {
    if (
      actorContext === a.context &&
      epoch === e &&
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      if ([401, 403].includes(error.status)) purgeAccess(a.context);
      else if (sent && ![408, 429].includes(error.status)) pending = null;
    }
    throw error;
  } finally {
    if (actorContext === a.context && epoch === e) {
      inFlight = false;
      publish();
    }
  }
}

export type EmailInboundWorkspaceProps = {
  contextKey: string;
  readOnly: boolean;
  orderId?: string;
  messageId?: string;
  focusToken?: number;
  externalWriteBlocked?: boolean;
  onLockedChange?: (locked: boolean) => void;
  onChanged?: () => void;
  onOpenOrder?: (orderId: string) => void;
  onOpenThread?: (orderId: string, threadId: string) => void;
};

type Account = {
  id: string;
  name: string;
  host: string;
  port: number;
  transport: 'tls' | 'local_fixture';
  folder: string;
  smtp_channel_id: string;
  enabled: boolean;
  version: string;
  has_credentials: boolean;
  username_masked: string;
  uidvalidity: string | null;
  last_uid: string | null;
  created_at: string;
  updated_at: string;
};
type Channel = { id: string; name: string; delivery: 'local_sink' | 'external'; mode: string };
type Options = Flags & {
  accounts: Account[];
  smtp_channels: Channel[];
  limits: Record<string, number>;
};
type Address = { name: string; address: string };
type Headers = {
  message_id: string | null;
  from: Address;
  reply_to: Address | null;
  to: Address[];
  subject: string;
  sent_at: string | null;
  in_reply_to: string | null;
  references: string[];
};
type Attachment = { index: number; filename: string; mime: string; bytes: number; sha256: string };
type MailRow = {
  index: number;
  source_id: string;
  uid: string;
  raw_sha256: string;
  raw_bytes: number;
  headers: Headers;
  text: string;
  attachments: Attachment[];
  duplicate: boolean;
  message_id: string | null;
};
type Preview = {
  id: string;
  acquisition_id: string;
  account_id: string;
  account_version: string;
  client_key: string;
  scope_hash: string;
  uidvalidity: string;
  uidnext: string;
  after_uid: string | null;
  rows: MailRow[];
  summary: {
    rows: number;
    new: number;
    duplicates: number;
    raw_bytes: number;
    attachment_bytes: number;
  };
  created_at: string;
  expires_at: string;
  can_import: boolean;
  import_operation_id: string | null;
};
type Acquisition = {
  id: string;
  account_id: string;
  actor_id: string;
  api_key_id: string | null;
  client_key: string;
  account_version: string;
  folder: string;
  state: 'fetching' | 'ready' | 'unknown' | 'failed' | 'abandoned';
  preview_id: string | null;
  uidvalidity: string | null;
  uidnext: string | null;
  created_at: string;
  updated_at: string;
  error_code: string | null;
  can_reconcile: boolean;
};
type InboundMessage = {
  id: string;
  source_id: string;
  account_id: string;
  version: string;
  state: 'unassigned' | 'bound';
  uid: string;
  uidvalidity: string;
  headers: Headers;
  text: string;
  attachments: Attachment[];
  raw_sha256: string;
  raw_bytes: number;
  order_id: string | null;
  thread_id: string | null;
  core_message_id: string | null;
  binding_id: string | null;
  created_at: string;
  can_bind: boolean;
  can_reply: boolean;
};
type MessageHead = Omit<InboundMessage, 'text' | 'attachments'> & { attachment_count: number };
type ImportReceipt = {
  id: string;
  preview_id: string;
  message_ids: string[];
  new_count: number;
  duplicate_count: number;
};
type Binding = {
  id: string;
  message_id: string;
  order_id: string;
  thread_id: string;
  core_message_id: string;
  order_version: string;
  created_at: string;
};
type ReplyPreview = {
  id: string;
  message_id: string;
  actor_id: string;
  api_key_id: string | null;
  request: Record<string, unknown>;
  scope_hash: string;
  snapshot: {
    message_version: string;
    order: { id: string; number: string; version: string };
    smtp_channel_id: string;
    smtp_channel_hash: string;
    sender: { email: string; name: string; local_sink: boolean };
    payload: {
      recipient: string;
      subject: string;
      text: string;
      html: string;
      in_reply_to: string | null;
      references: string[];
    };
  };
  created_at: string;
  expires_at: string;
  can_queue: boolean;
  queued_reply_id: string | null;
};
type Reply = {
  id: string;
  preview_id: string;
  message_id: string;
  batch_id: string;
  email_message_id: string;
  job_id: string;
  state: 'queued' | 'smtp_accepted' | 'uncertain' | 'failed' | 'cancelled';
  delivered: false;
  snapshot: ReplyPreview;
  created_at: string;
  result: Record<string, unknown> | null;
  error: string | null;
};
type Result = Flags & {
  operation_id?: string;
  reused?: boolean;
  account?: Account;
  acquisition?: Acquisition;
  preview?: Preview | null;
  import?: ImportReceipt;
  message?: InboundMessage;
  binding?: Binding;
  reply_preview?: ReplyPreview;
  reply?: Reply;
};
type Order = {
  id: string;
  number: string;
  version: string | number;
  customer_name: string;
  email?: string;
};
type AccountDraft = {
  id?: string;
  version?: string;
  name: string;
  host: string;
  transport: 'tls' | 'local_fixture';
  folder: string;
  smtp_channel_id: string;
  enabled: boolean;
  credentialAction: 'keep' | 'replace' | 'clear';
  username: string;
  password: string;
};
const blankAccount = (): AccountDraft => ({
  name: '',
  host: '',
  transport: 'tls',
  folder: 'INBOX',
  smtp_channel_id: '',
  enabled: true,
  credentialAction: 'replace',
  username: '',
  password: '',
});
const uid = (v: unknown): v is string =>
  typeof v === 'string' && /^[1-9][0-9]{0,9}$/.test(v) && BigInt(v) <= 4294967295n;
const acquisitionNames = {
  fetching: 'Odczyt rozpoczęty',
  ready: 'Podgląd gotowy',
  unknown: 'Wynik odczytu nieznany',
  failed: 'Odczyt zatrzymany',
  abandoned: 'Odczyt jawnie zamknięty',
};
const replyNames = {
  queued: 'W kolejce SMTP',
  smtp_accepted: 'Przyjęta przez SMTP — doręczenie niepotwierdzone',
  uncertain: 'Wynik SMTP niepewny — sprawdź konto',
  failed: 'Wysyłka zatrzymana',
  cancelled: 'Anulowana',
};
function checkAccount(a: Account) {
  if (
    !a ||
    !uuid(a.id) ||
    !version(a.version) ||
    !uuid(a.smtp_channel_id) ||
    !['tls', 'local_fixture'].includes(a.transport) ||
    typeof a.name !== 'string' ||
    typeof a.enabled !== 'boolean' ||
    typeof a.has_credentials !== 'boolean' ||
    typeof a.username_masked !== 'string' ||
    (a.uidvalidity !== null && !uid(a.uidvalidity)) ||
    (a.last_uid !== null && !uid(a.last_uid)) ||
    ['password', 'credentials', 'username'].some((k) => Object.hasOwn(a, k))
  )
    throw Error('Niepełna lub niebezpieczna konfiguracja konta IMAP.');
}
function checkHeaders(h: Headers) {
  const address = (a: Address) =>
    !!a &&
    typeof a.address === 'string' &&
    !/[\r\n\u0000]/.test(a.address) &&
    typeof a.name === 'string';
  if (
    !h ||
    !address(h.from) ||
    (h.reply_to !== null && !address(h.reply_to)) ||
    !Array.isArray(h.to) ||
    !h.to.every(address) ||
    typeof h.subject !== 'string' ||
    !Array.isArray(h.references) ||
    h.references.some((v) => typeof v !== 'string')
  )
    throw Error('Niepełne nagłówki wiadomości email.');
}
function checkAttachments(files: Attachment[]) {
  if (
    !Array.isArray(files) ||
    files.length > 10 ||
    files.some(
      (f, i) =>
        f.index !== i ||
        typeof f.filename !== 'string' ||
        typeof f.mime !== 'string' ||
        !sha(f.sha256) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 0 ||
        f.bytes > 2097152,
    ) ||
    files.reduce((n, f) => n + f.bytes, 0) > 4194304
  )
    throw Error('Niepełny zakres załączników wiadomości.');
}
function checkAcquisition(a: Acquisition) {
  if (
    !a ||
    !uuid(a.id) ||
    !uuid(a.account_id) ||
    !uuid(a.actor_id) ||
    !uuid(a.client_key) ||
    !version(a.account_version) ||
    !Object.hasOwn(acquisitionNames, a.state) ||
    typeof a.can_reconcile !== 'boolean' ||
    (a.preview_id !== null && !uuid(a.preview_id))
  )
    throw Error('Niepełny trwały wynik odczytu IMAP.');
}
function checkPreview(p: Preview) {
  if (
    !p ||
    !uuid(p.id) ||
    !uuid(p.acquisition_id) ||
    !uuid(p.account_id) ||
    !uuid(p.client_key) ||
    !version(p.account_version) ||
    !sha(p.scope_hash) ||
    !uid(p.uidvalidity) ||
    !uid(p.uidnext) ||
    !Array.isArray(p.rows) ||
    p.rows.length > 50 ||
    p.rows.length !== p.summary?.rows ||
    p.summary.new + p.summary.duplicates !== p.rows.length ||
    p.summary.raw_bytes > 67108864 ||
    typeof p.can_import !== 'boolean' ||
    (p.import_operation_id !== null && !uuid(p.import_operation_id)) ||
    !Number.isFinite(Date.parse(p.expires_at))
  )
    throw Error('Niepełny manifest odbioru email.');
  p.rows.forEach((r, i) => {
    checkHeaders(r.headers);
    checkAttachments(r.attachments);
    if (
      r.index !== i ||
      !uuid(r.source_id) ||
      !uid(r.uid) ||
      !sha(r.raw_sha256) ||
      !Number.isSafeInteger(r.raw_bytes) ||
      r.raw_bytes < 1 ||
      r.raw_bytes > 4194304 ||
      typeof r.text !== 'string' ||
      r.text.length > 20000 ||
      typeof r.duplicate !== 'boolean' ||
      (r.message_id !== null && !uuid(r.message_id))
    )
      throw Error('Niepełna pozycja manifestu email.');
  });
  if (
    new Set(p.rows.map((r) => r.source_id)).size !== p.rows.length ||
    new Set(p.rows.map((r) => r.uid)).size !== p.rows.length ||
    p.rows.filter((r) => r.duplicate).length !== p.summary.duplicates ||
    p.rows.reduce((n, r) => n + r.raw_bytes, 0) !== p.summary.raw_bytes ||
    p.rows.reduce((n, r) => n + r.attachments.reduce((v, f) => v + f.bytes, 0), 0) !==
      p.summary.attachment_bytes
  )
    throw Error('Zakres manifestu email nie zgadza się z podsumowaniem.');
}
function checkMessage(m: InboundMessage | MessageHead, full = true) {
  if (
    !m ||
    !uuid(m.id) ||
    !uuid(m.source_id) ||
    !uuid(m.account_id) ||
    !version(m.version) ||
    !uid(m.uid) ||
    !uid(m.uidvalidity) ||
    !sha(m.raw_sha256) ||
    !['unassigned', 'bound'].includes(m.state) ||
    (m.state === 'bound' &&
      ![m.order_id, m.thread_id, m.core_message_id, m.binding_id].every(uuid)) ||
    (m.state === 'unassigned' &&
      [m.order_id, m.thread_id, m.core_message_id, m.binding_id].some((v) => v !== null))
  )
    throw Error('Niepełna wiadomość lub jej powiązanie.');
  checkHeaders(m.headers);
  if (full) {
    if (
      !('attachments' in m) ||
      !('text' in m) ||
      typeof m.text !== 'string' ||
      m.text.length > 20000
    )
      throw Error('Niepełna treść wiadomości.');
    checkAttachments(m.attachments);
  }
}
function checkReplyPreview(p: ReplyPreview, historical = false) {
  if (
    !p ||
    !uuid(p.id) ||
    !uuid(p.message_id) ||
    !sha(p.scope_hash) ||
    !uuid(p.snapshot?.order?.id) ||
    !version(p.snapshot.order.version) ||
    !version(p.snapshot.message_version) ||
    !uuid(p.snapshot.smtp_channel_id) ||
    !sha(p.snapshot.smtp_channel_hash) ||
    !p.snapshot.sender ||
    typeof p.snapshot.sender.local_sink !== 'boolean' ||
    !p.snapshot.payload ||
    typeof p.snapshot.payload.recipient !== 'string' ||
    typeof p.snapshot.payload.subject !== 'string' ||
    typeof p.snapshot.payload.text !== 'string' ||
    !Array.isArray(p.snapshot.payload.references) ||
    (!historical &&
      (typeof p.can_queue !== 'boolean' ||
        (p.queued_reply_id !== null && !uuid(p.queued_reply_id)))) ||
    !Number.isFinite(Date.parse(p.expires_at))
  )
    throw Error('Niepełny podgląd odpowiedzi email.');
}
function checkReply(r: Reply) {
  if (
    !r ||
    ![r.id, r.preview_id, r.message_id, r.batch_id, r.email_message_id, r.job_id].every(uuid) ||
    r.delivered !== false ||
    !Object.hasOwn(replyNames, r.state)
  )
    throw Error('Niepełny trwały wynik odpowiedzi SMTP.');
  checkReplyPreview(r.snapshot, true);
  if (r.snapshot.id !== r.preview_id || r.snapshot.message_id !== r.message_id)
    throw Error('Wynik SMTP nie odpowiada podglądowi odpowiedzi.');
}
function validateMutation(d: Result, a: WriteAttempt) {
  const b = JSON.parse(a.body);
  if (!uuid(d.operation_id) || typeof d.reused !== 'boolean')
    throw Error('Brak potwierdzenia trwałej operacji. Zachowano dokładną próbę.');
  if (
    a.path === prefix + '/accounts' ||
    (a.method === 'PATCH' && /^\/email-inbound\/accounts\/[a-f0-9-]+$/.test(a.path))
  ) {
    checkAccount(d.account!);
    const r = d.account!;
    if (
      r.version !== (b.version ? String(BigInt(b.version) + 1n) : '1') ||
      (b.version && a.path !== prefix + '/accounts/' + r.id) ||
      ['name', 'host', 'folder', 'transport', 'smtp_channel_id', 'enabled'].some(
        (k) => r[k as keyof Account] !== b[k],
      ) ||
      r.port !== b.port
    )
      throw Error('Zapis konta nie odpowiada sprawdzonej konfiguracji.');
  } else if (a.path.endsWith('/previews') && a.path.includes('/accounts/')) {
    checkAcquisition(d.acquisition!);
    const r = d.acquisition!;
    if (
      a.path !== prefix + '/accounts/' + r.account_id + '/previews' ||
      r.client_key !== b.client_key ||
      r.account_version !== b.account_version ||
      r.actor_id !== a.context.split(':')[1]
    )
      throw Error('Odczyt należy do innego konta lub próby.');
    if (r.state === 'ready') {
      checkPreview(d.preview!);
      if (
        d.preview!.id !== r.preview_id ||
        d.preview!.client_key !== b.client_key ||
        d.preview!.acquisition_id !== r.id ||
        d.preview!.account_id !== r.account_id ||
        d.preview!.account_version !== b.account_version ||
        d.preview!.after_uid !== b.after_uid ||
        d.preview!.rows.length > b.limit ||
        (b.expected_uidvalidity !== null && d.preview!.uidvalidity !== b.expected_uidvalidity)
      )
        throw Error('Podgląd nie odpowiada zamówionemu odczytowi IMAP.');
    } else if (d.preview !== null) throw Error('Nieukończony odczyt nie ma sprawdzonego podglądu.');
  } else if (a.path.endsWith('/import')) {
    checkPreview(d.preview!);
    const p = d.preview!,
      r = d.import;
    if (
      !r ||
      r.id !== d.operation_id ||
      a.path !== prefix + '/previews/' + p.id + '/import' ||
      r.preview_id !== p.id ||
      p.scope_hash !== b.scope_hash ||
      p.import_operation_id !== r.id ||
      !Array.isArray(r.message_ids) ||
      !r.message_ids.every(uuid) ||
      new Set(r.message_ids).size !== r.message_ids.length ||
      r.new_count !== p.summary.new ||
      r.duplicate_count !== p.summary.duplicates ||
      r.message_ids.length !== p.rows.length
    )
      throw Error('Niepełne potwierdzenie importu manifestu.');
  } else if (a.path.endsWith('/bind')) {
    checkMessage(d.message!);
    const m = d.message!,
      r = d.binding;
    if (
      !r ||
      ![r.id, r.message_id, r.order_id, r.thread_id, r.core_message_id].every(uuid) ||
      a.path !== prefix + '/messages/' + m.id + '/bind' ||
      r.message_id !== m.id ||
      r.order_id !== b.order_id ||
      r.order_version !== b.order_version ||
      m.state !== 'bound' ||
      m.version !== String(BigInt(b.version) + 1n) ||
      m.order_id !== r.order_id ||
      m.thread_id !== r.thread_id ||
      m.binding_id !== r.id ||
      m.core_message_id !== r.core_message_id
    )
      throw Error('Powiązanie wiadomości nie odpowiada sprawdzonemu zamówieniu.');
  } else if (a.path.endsWith('/reply-previews')) {
    checkReplyPreview(d.reply_preview!);
    const p = d.reply_preview!,
      s = p.snapshot;
    if (
      a.path !== prefix + '/messages/' + p.message_id + '/reply-previews' ||
      s.message_version !== b.version ||
      s.order.version !== b.order_version ||
      s.smtp_channel_id !== b.smtp_channel_id ||
      ['recipient', 'subject', 'text'].some((k) => s.payload[k as keyof typeof s.payload] !== b[k])
    )
      throw Error('Podgląd odpowiedzi nie odpowiada sprawdzonej treści.');
  } else if (a.path.endsWith('/queue')) {
    checkReply(d.reply!);
    const r = d.reply!;
    if (
      a.path !== prefix + '/reply-previews/' + r.preview_id + '/queue' ||
      r.snapshot.scope_hash !== b.scope_hash
    )
      throw Error('Wynik kolejki nie odpowiada zatwierdzonej odpowiedzi.');
  } else if (a.path.endsWith('/reconcile')) {
    checkAcquisition(d.acquisition!);
    if (
      a.path !== prefix + '/acquisitions/' + d.acquisition!.id + '/reconcile' ||
      d.acquisition!.state !== 'abandoned'
    )
      throw Error('Niepełne potwierdzenie zamknięcia odczytu.');
  } else throw Error('Nieznany rodzaj zapisu skrzynki.');
}

export function EmailInboundWorkspace(props: EmailInboundWorkspaceProps) {
  const { contextKey, readOnly, orderId, externalWriteBlocked = false } = props;
  const [shared, setShared] = useState(() => mutationState(contextKey)),
    [options, setOptions] = useState<Options | null>(null);
  const [accountId, setAccountId] = useState(''),
    [accountDraft, setAccountDraft] = useState<AccountDraft | null>(null),
    [afterUid, setAfterUid] = useState(''),
    [newNamespace, setNewNamespace] = useState(false),
    [readLimit, setReadLimit] = useState('50'),
    [readConsent, setReadConsent] = useState(false);
  const [acquisition, setAcquisition] = useState<Acquisition | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [page, setPage] = useState(0),
    [seen, setSeen] = useState(new Set<number>()),
    [importConsent, setImportConsent] = useState(false),
    [importReceipt, setImportReceipt] = useState<ImportReceipt | null>(null),
    [abandonConsent, setAbandonConsent] = useState(false);
  const [messageState, setMessageState] = useState<'unassigned' | 'bound'>('unassigned'),
    [messages, setMessages] = useState<MessageHead[]>([]),
    [messageCursor, setMessageCursor] = useState<string | null>(null),
    [message, setMessage] = useState<InboundMessage | null>(null);
  const [search, setSearch] = useState(''),
    [orders, setOrders] = useState<Order[]>([]),
    [orderCursor, setOrderCursor] = useState<string | null>(null),
    [selectedOrder, setSelectedOrder] = useState<Order | null>(null),
    [bindConsent, setBindConsent] = useState(false);
  const [replyChannel, setReplyChannel] = useState(''),
    [subject, setSubject] = useState(''),
    [text, setText] = useState(''),
    [replyPreview, setReplyPreview] = useState<ReplyPreview | null>(null),
    [replyConsent, setReplyConsent] = useState(false),
    [externalConsent, setExternalConsent] = useState(false),
    [reply, setReply] = useState<Reply | null>(null);
  const [acquisitions, setAcquisitions] = useState<Acquisition[]>([]),
    [acquisitionCursor, setAcquisitionCursor] = useState<string | null>(null),
    [replies, setReplies] = useState<Reply[]>([]),
    [replyCursor, setReplyCursor] = useState<string | null>(null),
    [reading, setReading] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const alive = useRef(false),
    generation = useRef(0),
    scope = useRef(contextKey),
    gate = useRef(false),
    appliedOutcome = useRef<unknown>(null),
    consumedFocus = useRef('');
  const callbacks = useRef(props);
  callbacks.current = props;
  scope.current = contextKey;
  const account = options?.accounts.find((a) => a.id === accountId),
    busy = reading || shared.inFlight;
  const writable = !!options?.available && options.can_write && !options.read_only && !readOnly;
  const freshWrite = writable && !shared.locked && !externalWriteBlocked && !busy;
  const visible = shared.active && scope.current === contextKey;
  const current = (g: number, e: number) =>
    alive.current &&
    generation.current === g &&
    scope.current === contextKey &&
    mutationState(contextKey).active &&
    mutationState(contextKey).epoch === e;
  function clearSensitive() {
    setOptions(null);
    setAccountDraft(null);
    setAccountId('');
    setAfterUid('');
    setNewNamespace(false);
    setReadConsent(false);
    setAcquisition(null);
    setPreview(null);
    setSeen(new Set());
    setImportConsent(false);
    setImportReceipt(null);
    setAbandonConsent(false);
    setMessages([]);
    setMessageCursor(null);
    setMessage(null);
    setSearch('');
    setOrders([]);
    setOrderCursor(null);
    setSelectedOrder(null);
    setBindConsent(false);
    setReplyChannel('');
    setSubject('');
    setText('');
    setReplyPreview(null);
    setReplyConsent(false);
    setExternalConsent(false);
    setReply(null);
    setAcquisitions([]);
    setReplies([]);
    setAcquisitionCursor(null);
    setReplyCursor(null);
  }
  function failure(e: unknown) {
    if (e instanceof ApiError && [401, 403].includes(e.status)) {
      purgeAccess(contextKey);
      clearSensitive();
    } else if (e instanceof ApiError && e.status === 503) {
      setOptions(null);
      setReadConsent(false);
      setImportConsent(false);
      setBindConsent(false);
      setReplyConsent(false);
      setExternalConsent(false);
    }
    setError((e as Error).message);
  }
  async function access() {
    const d = await api<Options>(prefix + '/options');
    checkFlags(d, contextKey);
    if (d.available && !d.can_read) throw new ApiError('Brak prawa odczytu skrzynki email.', 403);
    if (
      !Array.isArray(d.accounts) ||
      d.accounts.length > 20 ||
      new Set(d.accounts.map((a) => a.id)).size !== d.accounts.length ||
      !Array.isArray(d.smtp_channels) ||
      d.smtp_channels.length > 100 ||
      d.smtp_channels.some(
        (c) =>
          !uuid(c.id) ||
          typeof c.name !== 'string' ||
          !['local_sink', 'external'].includes(c.delivery),
      )
    )
      throw Error('Niepełny wykaz kont skrzynki.');
    d.accounts.forEach(checkAccount);
    return d;
  }
  async function read<T>(fn: () => Promise<T>, apply: (d: T) => void) {
    if (gate.current || shared.inFlight) return;
    gate.current = true;
    setReading(true);
    setError('');
    const g = generation.current,
      e = mutationState(contextKey).epoch;
    try {
      await verifyActor(contextKey);
      const d = await fn();
      if (!current(g, e)) return;
      await verifyActor(contextKey);
      if (current(g, e)) apply(d);
    } catch (e) {
      if (alive.current && scope.current === contextKey && generation.current === g) failure(e);
    } finally {
      if (alive.current && scope.current === contextKey && generation.current === g) {
        gate.current = false;
        setReading(false);
      }
    }
  }
  async function get<T extends Flags>(path: string): Promise<T> {
    const d = await api<T>(path);
    checkFlags(d, contextKey);
    if (!d.available || !d.can_read) throw new ApiError('Brak dostępu do odczytu wiadomości.', 403);
    return d;
  }
  function applyResult(d: Result, a?: WriteAttempt) {
    if (d.account) {
      setOptions((o) =>
        o
          ? { ...o, accounts: [...o.accounts.filter((v) => v.id !== d.account!.id), d.account!] }
          : o,
      );
      setAccountId(d.account.id);
      setAccountDraft(null);
      setReadConsent(false);
    }
    if (d.acquisition) {
      setAcquisition(d.acquisition);
      setAbandonConsent(false);
    }
    if (d.preview) {
      checkPreview(d.preview);
      setPreview(d.preview);
      setPage(0);
      setSeen(new Set([0]));
      setImportConsent(false);
    }
    if (d.import) {
      setImportReceipt(d.import);
      setImportConsent(false);
      setNotice('Zapisano manifest wiadomości. Odpowiedź nie została wysłana.');
    }
    if (d.message) {
      setMessage(d.message);
      setSelectedOrder(null);
      setBindConsent(false);
      setReplyPreview(null);
      setReplyConsent(false);
      setReplyChannel(
        options?.accounts.find((v) => v.id === d.message!.account_id)?.smtp_channel_id ?? '',
      );
      setSubject(
        (/^Re:/i.test(d.message.headers.subject) ? '' : 'Re: ') + d.message.headers.subject,
      );
      setText('');
    }
    if (d.reply_preview) {
      setReplyPreview(d.reply_preview);
      setReplyConsent(false);
      setExternalConsent(false);
    }
    if (d.reply) {
      setReply(d.reply);
      setReplyPreview((p) =>
        p?.id === d.reply!.preview_id
          ? { ...p, can_queue: false, queued_reply_id: d.reply!.id }
          : p,
      );
      setReplyConsent(false);
      setExternalConsent(false);
      setNotice(
        'Odpowiedź ma trwały wynik kolejki. Sprawdź status SMTP; nie jest to potwierdzenie doręczenia.',
      );
    }
    if (a && !d.import && !d.reply) setNotice('Operacja skrzynki została zapisana.');
  }
  async function mutate(
    action: string,
    path: string,
    body: Record<string, unknown> | null,
    method: 'POST' | 'PATCH' = 'POST',
    retry = false,
  ) {
    const retained = mutationState(contextKey).pending;
    if (busy || (retry ? !retained || !writable : !freshWrite)) return;
    const a = retry
      ? retained!
      : { context: contextKey, action, path, method, body: JSON.stringify(body) };
    const g = generation.current,
      e = mutationState(contextKey).epoch;
    setError('');
    setNotice('');
    try {
      const d = await performWrite<Result>({
        attempt: a,
        retry,
        readOnly,
        access,
        onAccess: (o) => {
          if (current(g, e)) setOptions(o);
        },
        validate: validateMutation,
      });
      if (d && current(g, e)) {
        appliedOutcome.current = d;
        applyResult(d, a);
        callbacks.current.onChanged?.();
      }
    } catch (error) {
      if (
        current(g, e) ||
        (alive.current && generation.current === g && scope.current === contextKey)
      ) {
        failure(error);
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          setReadConsent(false);
          setImportConsent(false);
          setBindConsent(false);
          setReplyConsent(false);
          setExternalConsent(false);
          if (error.status === 409) {
            setReplyPreview(null);
            setPreview(null);
          }
        }
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    generation.current++;
    gate.current = false;
    resetEmailInboundContext(contextKey);
    clearSensitive();
    setReading(false);
    setError('');
    setNotice('');
    appliedOutcome.current = null;
    consumedFocus.current = '';
    const notify = () => {
      const s = mutationState(contextKey);
      setShared(s);
      callbacks.current.onLockedChange?.(s.locked);
    };
    listeners.add(notify);
    notify();
    void read(access, setOptions);
    return () => {
      alive.current = false;
      generation.current++;
      listeners.delete(notify);
    };
  }, [contextKey, readOnly, orderId]);
  useEffect(() => {
    if (
      !visible ||
      !options?.can_read ||
      !shared.outcome ||
      appliedOutcome.current === shared.outcome.reply
    )
      return;
    const d = shared.outcome.reply as Result;
    checkFlags(d, contextKey);
    appliedOutcome.current = d;
    applyResult(d, shared.outcome.attempt);
  }, [shared.outcome, options?.can_read, visible]);
  useEffect(() => {
    const key = `${props.messageId}:${props.focusToken ?? 0}`;
    if (
      uuid(props.messageId) &&
      options?.available &&
      options.can_read &&
      !busy &&
      consumedFocus.current !== key
    ) {
      consumedFocus.current = key;
      loadMessage(props.messageId);
    }
  }, [props.messageId, props.focusToken, options?.available, options?.can_read, busy]);
  function selectAccount(id: string) {
    const a = options?.accounts.find((v) => v.id === id);
    setAccountId(id);
    setAfterUid(a?.last_uid ?? '');
    setNewNamespace(false);
    setReadConsent(false);
    setAcquisition(null);
    setPreview(null);
    setImportReceipt(null);
    setImportConsent(false);
    setAbandonConsent(false);
    setPage(0);
    setSeen(new Set());
    setAcquisitions([]);
    setAcquisitionCursor(null);
    setMessages([]);
    setMessageCursor(null);
    setMessage(null);
    setSearch('');
    setOrders([]);
    setOrderCursor(null);
    setSelectedOrder(null);
    setBindConsent(false);
    setReplyChannel('');
    setSubject('');
    setText('');
    setReplyPreview(null);
    setReplyConsent(false);
    setExternalConsent(false);
    setReply(null);
    setReplies([]);
    setReplyCursor(null);
    setNotice('');
  }
  function editAccount(a: Account) {
    setAccountDraft({
      id: a.id,
      version: a.version,
      name: a.name,
      host: a.host,
      transport: a.transport,
      folder: a.folder,
      smtp_channel_id: a.smtp_channel_id,
      enabled: a.enabled,
      credentialAction: 'keep',
      username: '',
      password: '',
    });
  }
  function saveAccount() {
    if (!accountDraft || !freshWrite || !options?.can_manage_accounts) return;
    const d = accountDraft,
      credentials = d.id
        ? d.credentialAction === 'replace'
          ? { action: 'replace', username: d.username, password: d.password }
          : { action: d.credentialAction }
        : { username: d.username, password: d.password };
    if (
      !d.name.trim() ||
      !d.host.trim() ||
      !d.folder.trim() ||
      !uuid(d.smtp_channel_id) ||
      (d.credentialAction === 'clear' && d.enabled) ||
      ((d.credentialAction === 'replace' || !d.id) && (!d.username.trim() || !d.password))
    ) {
      setError(
        'Uzupełnij konto, skrzynkę i jawnie wybrane dane logowania. Usunięcie danych wymaga wyłączenia konta.',
      );
      return;
    }
    void mutate(
      'Zapis konta IMAP',
      prefix + '/accounts' + (d.id ? '/' + d.id : ''),
      {
        client_key: crypto.randomUUID(),
        ...(d.id ? { version: d.version } : {}),
        name: d.name.trim(),
        host: d.host.trim().toLowerCase(),
        port: d.transport === 'tls' ? 993 : 4112,
        transport: d.transport,
        folder: d.folder.trim(),
        smtp_channel_id: d.smtp_channel_id,
        enabled: d.enabled,
        credentials,
      },
      d.id ? 'PATCH' : 'POST',
    );
  }
  async function loadMessages(more = false, nextState = messageState) {
    await read(
      async () => {
        const d = await get<Flags & { data: MessageHead[]; next_cursor: string | null }>(
          prefix +
            '/messages?' +
            new URLSearchParams({
              state: nextState,
              limit: '50',
              ...(more && messageCursor ? { cursor: messageCursor } : {}),
              ...(accountId ? { account_id: accountId } : {}),
            }),
        );
        if (
          !Array.isArray(d.data) ||
          d.data.length > 50 ||
          (d.next_cursor !== null && !uuid(d.next_cursor)) ||
          (more && d.next_cursor === messageCursor)
        )
          throw Error('Niepełna strona wiadomości.');
        d.data.forEach((m) => checkMessage(m, false));
        const rows = more ? [...messages, ...d.data] : d.data;
        if (rows.length > 2000 || new Set(rows.map((m) => m.id)).size !== rows.length)
          throw Error('Powtórzony lub zbyt duży wykaz wiadomości.');
        return { rows, cursor: d.next_cursor };
      },
      (d) => {
        setMessageState(nextState);
        setMessages(d.rows);
        setMessageCursor(d.cursor);
      },
    );
  }
  function loadMessage(id: string) {
    void read(
      async () => {
        const d = await get<Result>(prefix + '/messages/' + id);
        checkMessage(d.message!);
        if (d.message!.id !== id || (orderId && d.message!.order_id !== orderId))
          throw Error('Wiadomość należy do innego zakresu.');
        return d;
      },
      (d) => {
        setReply(null);
        setReplies([]);
        setReplyCursor(null);
        applyResult(d);
      },
    );
  }
  function loadAcquisition(id: string) {
    void read(
      async () => {
        const d = await get<Result>(prefix + '/acquisitions/' + id);
        checkAcquisition(d.acquisition!);
        if (d.acquisition!.id !== id || (accountId && d.acquisition!.account_id !== accountId))
          throw Error('Odczyt należy do innego konta.');
        if (d.preview) {
          checkPreview(d.preview);
          if (d.preview.acquisition_id !== id || d.preview.id !== d.acquisition!.preview_id)
            throw Error('Podgląd należy do innego odczytu.');
        }
        return d;
      },
      (d) => {
        setPreview(null);
        setImportReceipt(null);
        applyResult(d);
      },
    );
  }
  function loadImport(p: Preview) {
    if (!uuid(p.import_operation_id)) return;
    void read(async () => {
      const d = await get<Result>(prefix + '/imports/' + p.import_operation_id),
        r = d.import;
      if (
        !r ||
        r.id !== p.import_operation_id ||
        r.preview_id !== p.id ||
        !Array.isArray(r.message_ids) ||
        !r.message_ids.every(uuid) ||
        new Set(r.message_ids).size !== r.message_ids.length ||
        r.message_ids.length !== p.rows.length ||
        r.new_count !== p.summary.new ||
        r.duplicate_count !== p.summary.duplicates
      )
        throw Error('Zapis importu nie odpowiada pełnemu manifestowi.');
      return r;
    }, setImportReceipt);
  }
  function loadAcquisitions(more = false) {
    void read(
      async () => {
        const d = await get<Flags & { data: Acquisition[]; next_cursor: string | null }>(
          prefix +
            '/acquisitions?' +
            new URLSearchParams({
              limit: '50',
              ...(accountId ? { account_id: accountId } : {}),
              ...(more && acquisitionCursor ? { cursor: acquisitionCursor } : {}),
            }),
        );
        if (
          !Array.isArray(d.data) ||
          d.data.length > 50 ||
          (d.next_cursor !== null && !uuid(d.next_cursor)) ||
          (more && d.next_cursor === acquisitionCursor)
        )
          throw Error('Niepełna historia odczytów.');
        d.data.forEach(checkAcquisition);
        const rows = more ? [...acquisitions, ...d.data] : d.data;
        if (rows.length > 2000 || new Set(rows.map((r) => r.id)).size !== rows.length)
          throw Error('Powtórzona historia odczytów.');
        return { rows, cursor: d.next_cursor };
      },
      (d) => {
        setAcquisitions(d.rows);
        setAcquisitionCursor(d.cursor);
      },
    );
  }
  function findOrders(more = false) {
    void read(
      async () => {
        const d = await api<{ data: Order[]; meta: { cursor: string | null } }>(
          '/orders?' +
            new URLSearchParams({
              search: search.trim(),
              limit: '50',
              ...(more && orderCursor ? { after: orderCursor } : {}),
            }),
        );
        if (
          !Array.isArray(d.data) ||
          d.data.length > 50 ||
          d.data.some((o) => !uuid(o.id)) ||
          (d.meta.cursor !== null && !uuid(d.meta.cursor)) ||
          (more && d.meta.cursor === orderCursor)
        )
          throw Error('Niepełny wykaz zamówień.');
        const rows = more ? [...orders, ...d.data] : d.data;
        if (rows.length > 1000 || new Set(rows.map((o) => o.id)).size !== rows.length)
          throw Error('Powtórzony wykaz zamówień.');
        return { rows, cursor: d.meta.cursor };
      },
      (d) => {
        setOrders(d.rows);
        setOrderCursor(d.cursor);
      },
    );
  }
  function chooseOrder(id: string) {
    void read(
      async () => {
        const o = await api<Order>('/orders/' + id);
        if (o.id !== id || !version(String(o.version))) throw Error('Niepełny odczyt zamówienia.');
        return o;
      },
      (o) => {
        setSelectedOrder(o);
        setBindConsent(false);
      },
    );
  }
  function prepareReply() {
    if (!message || !freshWrite || !message.can_reply || !message.order_id) return;
    void read(
      async () => {
        const o = await api<Order>('/orders/' + message.order_id);
        if (o.id !== message.order_id || !version(String(o.version)))
          throw Error('Niepełny odczyt zamówienia odpowiedzi.');
        return o;
      },
      (o) => {
        void mutate(
          'Podgląd odpowiedzi email',
          prefix + '/messages/' + message.id + '/reply-previews',
          {
            client_key: crypto.randomUUID(),
            version: message.version,
            order_version: String(o.version),
            smtp_channel_id: replyChannel,
            recipient: (message.headers.reply_to ?? message.headers.from).address
              .trim()
              .toLowerCase(),
            subject: subject.trim(),
            text: text.trim(),
          },
        );
      },
    );
  }
  function changeReply() {
    setReplyPreview(null);
    setReplyConsent(false);
    setExternalConsent(false);
    setReply(null);
  }
  function loadReplies(more = false) {
    if (!message) return;
    void read(
      async () => {
        const d = await get<Flags & { data: Reply[]; next_cursor: string | null }>(
          prefix +
            '/replies?' +
            new URLSearchParams({
              message_id: message.id,
              limit: '50',
              ...(more && replyCursor ? { cursor: replyCursor } : {}),
            }),
        );
        if (
          !Array.isArray(d.data) ||
          d.data.length > 50 ||
          d.data.some(
            (r) =>
              !uuid(r.id) || r.message_id !== message.id || !Object.hasOwn(replyNames, r.state),
          ) ||
          (d.next_cursor !== null && !uuid(d.next_cursor)) ||
          (more && d.next_cursor === replyCursor)
        )
          throw Error('Niepełna historia odpowiedzi.');
        const rows = more ? [...replies, ...d.data] : d.data;
        if (rows.length > 2000 || new Set(rows.map((r) => r.id)).size !== rows.length)
          throw Error('Powtórzona historia odpowiedzi.');
        return { rows, cursor: d.next_cursor };
      },
      (d) => {
        setReplies(d.rows);
        setReplyCursor(d.cursor);
      },
    );
  }
  function loadReply(id: string) {
    void read(
      async () => {
        const d = await get<Result>(prefix + '/replies/' + id);
        checkReply(d.reply!);
        if (d.reply!.id !== id || (message && d.reply!.message_id !== message.id))
          throw Error('Odpowiedź należy do innej wiadomości.');
        return d;
      },
      (d) => setReply(d.reply!),
    );
  }
  function downloadAttachment(m: InboundMessage, f: Attachment) {
    void read(
      async () => {
        const d = await get<
          Flags & {
            message_id: string;
            index: number;
            filename: string;
            mime: string;
            content_base64: string;
            bytes: number;
            sha256: string;
          }
        >(
          prefix +
            '/messages/' +
            m.id +
            '/attachments/' +
            f.index +
            '/content?workspace_id=' +
            encodeURIComponent(contextKey.split(':')[0]),
        );
        if (
          d.message_id !== m.id ||
          d.index !== f.index ||
          d.filename !== f.filename ||
          d.mime !== f.mime ||
          d.bytes !== f.bytes ||
          d.sha256 !== f.sha256 ||
          typeof d.content_base64 !== 'string' ||
          d.content_base64.length > 2796216
        )
          throw Error('Załącznik nie odpowiada zapisanej wiadomości.');
        const bytes = Uint8Array.from(atob(d.content_base64), (c) => c.charCodeAt(0));
        if (
          bytes.length !== f.bytes ||
          [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('') !== f.sha256
        )
          throw Error('Załącznik nie przeszedł kontroli kompletności.');
        return { bytes, filename: f.filename };
      },
      (d) => {
        const url = URL.createObjectURL(new Blob([d.bytes], { type: 'application/octet-stream' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = d.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    );
  }
  const pages = Math.max(1, Math.ceil((preview?.rows.length ?? 0) / 10));
  if (!visible)
    return (
      <section className="panel email-inbound">
        <p>Zmiana kontekstu skrzynki…</p>
      </section>
    );
  return (
    <section className="panel email-inbound" aria-label="Skrzynka email IMAP">
      <div className="panel-heading">
        <div>
          <h2>Skrzynka email</h2>
          <p>Odczyt IMAP, osobny import, powiązanie z zamówieniem i jawna odpowiedź SMTP.</p>
        </div>
      </div>
      <div className="info-body">
        {error && (
          <p className="error-block" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void read(access, setOptions)}
        >
          Odczytaj dostęp i konta skrzynki
        </button>
        {shared.pending && (
          <div className="notice">
            <p>
              Wynik operacji „{shared.pending.action}” jest nieznany. Nowe zapisy są wstrzymane.
              Odczyt historii nie usuwa dokładnej próby.
            </p>
            <button
              type="button"
              className="button"
              disabled={busy || !writable}
              onClick={() => void mutate('', '', null, 'POST', true)}
            >
              Ponów dokładną próbę skrzynki
            </button>
          </div>
        )}
        {externalWriteBlocked && !shared.pending && (
          <p className="notice">
            Inna operacja komunikacji wymaga potwierdzenia. Nowe zapisy skrzynki są wstrzymane.
          </p>
        )}
        {options && !options.available && (
          <p className="notice">
            Ta kopia nie udostępnia skrzynki IMAP. Dotychczasowe wiadomości portalowe pozostają
            osobnym procesem.
          </p>
        )}
        {(readOnly || options?.read_only || (options && !options.can_write)) && (
          <p className="notice">
            Tryb odczytu: import, konfiguracja, powiązanie i wysyłka są wyłączone.
          </p>
        )}
        {options?.available && (
          <>
            <details>
              <summary>Konta odbioru IMAP</summary>
              <p>
                Hasło jest wyłącznie zapisywane. Nie jest wyświetlane ani zachowywane w pamięci
                trwałej przeglądarki. Konfiguracja nie pobiera wiadomości.
              </p>
              {options.accounts.map((a) => (
                <div className="ei-card" key={a.id}>
                  <strong>{a.name}</strong>
                  <p>
                    {a.host}:{a.port} · {a.folder} · {a.enabled ? 'Włączone' : 'Wyłączone'} ·
                    rewizja {a.version}
                  </p>
                  <small>
                    Login: {a.username_masked || 'Brak'} · dane logowania:{' '}
                    {a.has_credentials ? 'Ustawiono' : 'Brak'}
                  </small>
                  <button
                    type="button"
                    className="button"
                    disabled={!freshWrite || !options.can_manage_accounts}
                    onClick={() => editAccount(a)}
                  >
                    Edytuj konto {a.name}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button"
                disabled={!freshWrite || !options.can_manage_accounts}
                onClick={() => setAccountDraft(blankAccount())}
              >
                Dodaj konto IMAP
              </button>
              {accountDraft && (
                <form
                  className="ei-card"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveAccount();
                  }}
                >
                  <fieldset disabled={!freshWrite || !options.can_manage_accounts}>
                    <div className="ei-grid">
                      <label>
                        Nazwa konta
                        <input
                          value={accountDraft.name}
                          maxLength={120}
                          required
                          onChange={(e) =>
                            setAccountDraft({ ...accountDraft, name: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        Połączenie IMAP
                        <select
                          value={accountDraft.transport}
                          onChange={(e) =>
                            setAccountDraft({
                              ...accountDraft,
                              transport: e.target.value as AccountDraft['transport'],
                              host: e.target.value === 'local_fixture' ? '127.0.0.1' : '',
                            })
                          }
                        >
                          <option value="tls">TLS — publiczny serwer, port 993</option>
                          <option value="local_fixture">
                            Lokalne konto testowe — 127.0.0.1:4112
                          </option>
                        </select>
                      </label>
                      <label>
                        Host serwera IMAP
                        <input
                          value={accountDraft.host}
                          required
                          disabled={accountDraft.transport === 'local_fixture'}
                          onChange={(e) =>
                            setAccountDraft({ ...accountDraft, host: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        Folder skrzynki
                        <input
                          value={accountDraft.folder}
                          maxLength={200}
                          required
                          onChange={(e) =>
                            setAccountDraft({ ...accountDraft, folder: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        Konto odpowiedzi SMTP
                        <select
                          value={accountDraft.smtp_channel_id}
                          required
                          onChange={(e) =>
                            setAccountDraft({ ...accountDraft, smtp_channel_id: e.target.value })
                          }
                        >
                          <option value="">Wybierz konto SMTP</option>
                          {options.smtp_channels.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} —{' '}
                              {c.delivery === 'local_sink'
                                ? 'lokalny odbiornik'
                                : 'zewnętrzne SMTP'}
                            </option>
                          ))}
                        </select>
                      </label>
                      {accountDraft.id && (
                        <label>
                          Dane logowania
                          <select
                            value={accountDraft.credentialAction}
                            onChange={(e) =>
                              setAccountDraft({
                                ...accountDraft,
                                credentialAction: e.target
                                  .value as AccountDraft['credentialAction'],
                                username: '',
                                password: '',
                              })
                            }
                          >
                            <option value="keep">Zachowaj zapisane dane</option>
                            <option value="replace">Zastąp danymi podanymi poniżej</option>
                            <option value="clear">Usuń dane — konto musi być wyłączone</option>
                          </select>
                        </label>
                      )}
                      {(!accountDraft.id || accountDraft.credentialAction === 'replace') && (
                        <>
                          <label>
                            Login IMAP
                            <input
                              value={accountDraft.username}
                              autoComplete="off"
                              required
                              onChange={(e) =>
                                setAccountDraft({ ...accountDraft, username: e.target.value })
                              }
                            />
                          </label>
                          <label>
                            Hasło IMAP
                            <input
                              type="password"
                              value={accountDraft.password}
                              autoComplete="new-password"
                              required
                              onChange={(e) =>
                                setAccountDraft({ ...accountDraft, password: e.target.value })
                              }
                            />
                          </label>
                        </>
                      )}
                    </div>
                    <label className="ei-check">
                      <input
                        type="checkbox"
                        checked={accountDraft.enabled}
                        onChange={(e) =>
                          setAccountDraft({ ...accountDraft, enabled: e.target.checked })
                        }
                      />
                      Konto włączone
                    </label>
                    <button type="submit" className="button">
                      Zapisz konto IMAP
                    </button>
                  </fieldset>
                  <button
                    type="button"
                    className="button"
                    disabled={shared.locked}
                    onClick={() => setAccountDraft(null)}
                  >
                    Zamknij edycję konta
                  </button>
                </form>
              )}
            </details>
            <div className="ei-card">
              <h3>Odczyt wiadomości przed importem</h3>
              <fieldset disabled={!freshWrite}>
                <div className="ei-grid">
                  <label>
                    Konto odbioru
                    <select value={accountId} onChange={(e) => selectAccount(e.target.value)}>
                      <option value="">Wybierz konto</option>
                      {options.accounts
                        .filter((a) => a.enabled)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} — {a.folder}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Odczyt po UID — puste od początku
                    <input
                      value={afterUid}
                      disabled={newNamespace}
                      inputMode="numeric"
                      onChange={(e) => {
                        setAfterUid(e.target.value);
                        setReadConsent(false);
                      }}
                    />
                  </label>
                  <label>
                    Rozmiar okna UID
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={readLimit}
                      onChange={(e) => {
                        setReadLimit(e.target.value);
                        setReadConsent(false);
                      }}
                    />
                  </label>
                </div>
                <p>
                  Okno obejmuje od 1 do 50 kolejnych numerów UID. Luki w numeracji mogą dać mniej
                  wiadomości lub pusty wynik.
                </p>
                {account && (
                  <p>
                    Folder {account.folder} · przestrzeń UID{' '}
                    {account.uidvalidity ?? 'jeszcze nieodczytana — nowy odczyt ustali ją jawnie'} ·
                    rewizja konta {account.version}. Odczyt nie importuje ani nie zmienia flag
                    wiadomości w skrzynce.
                  </p>
                )}
                <label className="ei-check">
                  <input
                    type="checkbox"
                    checked={newNamespace}
                    disabled={!account}
                    onChange={(e) => {
                      setNewNamespace(e.target.checked);
                      if (e.target.checked) setAfterUid('');
                      setReadConsent(false);
                    }}
                  />
                  Odczytaj nową przestrzeń UID od początku
                </label>
                <p>
                  Użyj tej osobnej zgody po zmianie przestrzeni UID w skrzynce. Odczyt ustali nowy
                  zakres od początku; wcześniejsze importy i powiązania pozostaną zachowane.
                </p>
                <label className="ei-check">
                  <input
                    type="checkbox"
                    checked={readConsent}
                    onChange={(e) => setReadConsent(e.target.checked)}
                  />
                  Potwierdzam odczyt wskazanej skrzynki IMAP do podglądu, bez importu i bez
                  odpowiedzi.
                </label>
                <button
                  type="button"
                  className="button"
                  disabled={
                    !account?.has_credentials ||
                    !readConsent ||
                    (afterUid !== '' && !uid(afterUid)) ||
                    (!newNamespace && account?.uidvalidity === null && afterUid !== '') ||
                    !/^(?:[1-9]|[1-4][0-9]|50)$/.test(readLimit)
                  }
                  onClick={() => {
                    if (account)
                      void mutate(
                        'Odczyt IMAP do podglądu',
                        prefix + '/accounts/' + account.id + '/previews',
                        {
                          client_key: crypto.randomUUID(),
                          account_version: account.version,
                          after_uid: newNamespace ? null : afterUid || null,
                          expected_uidvalidity: newNamespace ? null : account.uidvalidity,
                          limit: Number(readLimit),
                          confirmed_read: true,
                        },
                      );
                  }}
                >
                  Przygotuj podgląd odbioru IMAP
                </button>
              </fieldset>
            </div>
            {acquisition && (
              <div className="ei-card">
                <h3>{acquisitionNames[acquisition.state]}</h3>
                <p>
                  {date(acquisition.created_at)} · folder {acquisition.folder}
                </p>
                {acquisition.error_code && (
                  <p>
                    Odczyt nie zakończył się poprawnie: {acquisition.error_code}. Nie uruchamiaj
                    kolejnego pobrania w celu odgadnięcia wyniku.
                  </p>
                )}
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => loadAcquisition(acquisition.id)}
                >
                  Odczytaj trwały wynik pobrania
                </button>
                {acquisition.can_reconcile && (
                  <>
                    <label className="ei-check">
                      <input
                        type="checkbox"
                        checked={abandonConsent}
                        disabled={!freshWrite}
                        onChange={(e) => setAbandonConsent(e.target.checked)}
                      />
                      Potwierdzam zamknięcie nieukończonego odczytu bez importu. To nie uruchamia
                      nowego pobrania.
                    </label>
                    <button
                      type="button"
                      className="button"
                      disabled={!freshWrite || !abandonConsent}
                      onClick={() =>
                        void mutate(
                          'Zamknięcie nieukończonego odczytu',
                          prefix + '/acquisitions/' + acquisition.id + '/reconcile',
                          { client_key: crypto.randomUUID(), confirmed_abandon: true },
                        )
                      }
                    >
                      Zamknij nieukończony odczyt
                    </button>
                  </>
                )}
              </div>
            )}
            {preview && (
              <div className="ei-card">
                <h3>Pełny zapisany podgląd odbioru</h3>
                <p>
                  {preview.summary.rows} wiadomości · nowe {preview.summary.new} · już zapisane{' '}
                  {preview.summary.duplicates} · ważny do {date(preview.expires_at)}
                </p>
                <p>
                  Odczytane UID w przestrzeni {preview.uidvalidity}. Duplikaty zachowają istniejące
                  powiązanie; import nie wysyła odpowiedzi.
                </p>
                {preview.rows.slice(page * 10, (page + 1) * 10).map((r) => (
                  <article className="ei-card" key={r.source_id}>
                    <h3>
                      {r.index + 1}. {r.headers.subject || '(bez tematu)'}
                    </h3>
                    <small>
                      UID {r.uid} · {r.duplicate ? 'Już zapisano' : 'Nowa'} · SHA256 {r.raw_sha256}
                    </small>
                    <MailBody headers={r.headers} text={r.text} attachments={r.attachments} />
                  </article>
                ))}
                <div className="ei-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={page === 0}
                    onClick={() => {
                      setPage(page - 1);
                      setSeen(new Set([...seen, page - 1]));
                    }}
                  >
                    Poprzednia strona podglądu
                  </button>
                  <span>
                    Strona {page + 1} / {pages} · sprawdzone {seen.size} / {pages}
                  </span>
                  <button
                    type="button"
                    className="button"
                    disabled={page + 1 >= pages}
                    onClick={() => {
                      setPage(page + 1);
                      setSeen(new Set([...seen, page + 1]));
                    }}
                  >
                    Następna strona podglądu
                  </button>
                </div>
                {preview.import_operation_id ? (
                  <>
                    <p>Ten manifest ma już trwały zapis importu. Odczytaj wiadomości w skrzynce.</p>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => loadImport(preview)}
                    >
                      Odczytaj zapis importu
                    </button>
                  </>
                ) : (
                  <>
                    <label className="ei-check">
                      <input
                        type="checkbox"
                        checked={importConsent}
                        disabled={
                          !freshWrite ||
                          seen.size !== pages ||
                          !preview.can_import ||
                          Date.parse(preview.expires_at) <= Date.now()
                        }
                        onChange={(e) => setImportConsent(e.target.checked)}
                      />
                      Sprawdziłem wszystkie wiadomości i źródło. Importuję cały manifest do lokalnej
                      skrzynki, bez odpowiedzi.
                    </label>
                    <button
                      type="button"
                      className="button primary"
                      disabled={
                        !freshWrite ||
                        !importConsent ||
                        seen.size !== pages ||
                        !preview.can_import ||
                        Date.parse(preview.expires_at) <= Date.now()
                      }
                      onClick={() =>
                        void mutate(
                          'Import całego manifestu',
                          prefix + '/previews/' + preview.id + '/import',
                          {
                            client_key: crypto.randomUUID(),
                            scope_hash: preview.scope_hash,
                            confirmed: true,
                          },
                        )
                      }
                    >
                      Importuj wiadomości
                    </button>
                  </>
                )}
              </div>
            )}
            {importReceipt && (
              <p className="notice">
                Zapis importu: nowe {importReceipt.new_count}, duplikaty{' '}
                {importReceipt.duplicate_count}. Wiadomości można teraz odczytać i jawnie powiązać z
                zamówieniami.
              </p>
            )}
            <div className="ei-card">
              <h3>Wiadomości w lokalnej skrzynce</h3>
              <div className="ei-tabs">
                <button
                  type="button"
                  className="button"
                  aria-pressed={messageState === 'unassigned'}
                  disabled={busy}
                  onClick={() => void loadMessages(false, 'unassigned')}
                >
                  Do powiązania
                </button>
                <button
                  type="button"
                  className="button"
                  aria-pressed={messageState === 'bound'}
                  disabled={busy}
                  onClick={() => void loadMessages(false, 'bound')}
                >
                  Powiązane
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void loadMessages()}
                >
                  Odczytaj wiadomości
                </button>
              </div>
              {messages
                .filter((m) => !orderId || m.order_id === orderId)
                .map((m) => (
                  <div className="ei-actions" key={m.id}>
                    <span>
                      {m.headers.from.address} · {m.headers.subject} · {date(m.created_at)}
                    </span>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => loadMessage(m.id)}
                    >
                      Otwórz wiadomość {m.headers.subject || m.uid}
                    </button>
                  </div>
                ))}
              {messageCursor && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void loadMessages(true)}
                >
                  Starsze wiadomości
                </button>
              )}
            </div>
            {message && (
              <div className="ei-card">
                <h3>Wiadomość {message.headers.subject || '(bez tematu)'}</h3>
                <MailBody
                  headers={message.headers}
                  text={message.text}
                  attachments={message.attachments}
                />
                <small>
                  Źródło IMAP · UID {message.uid} / {message.uidvalidity} · SHA256{' '}
                  {message.raw_sha256}
                </small>
                {message.attachments.map((f) => (
                  <button
                    type="button"
                    className="button"
                    key={f.index}
                    disabled={busy}
                    onClick={() => downloadAttachment(message, f)}
                  >
                    Pobierz zapisany załącznik {f.index + 1}: {f.filename}
                  </button>
                ))}
                {message.state === 'unassigned' ? (
                  <>
                    <p>
                      Wiadomość nie jest powiązana. Sam adres nadawcy nie rozstrzyga, którego
                      zamówienia dotyczy.
                    </p>
                    <form
                      className="ei-actions"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setOrderCursor(null);
                        findOrders();
                      }}
                    >
                      <label>
                        Numer zamówienia lub klient
                        <input
                          value={search}
                          maxLength={100}
                          disabled={busy || shared.locked}
                          onChange={(e) => {
                            setSearch(e.target.value);
                            setBindConsent(false);
                          }}
                        />
                      </label>
                      <button
                        type="submit"
                        className="button"
                        disabled={busy || shared.locked || !search.trim()}
                      >
                        Wyszukaj zamówienia do powiązania
                      </button>
                    </form>
                    <label>
                      Własne zamówienie
                      <select
                        value={selectedOrder?.id ?? ''}
                        disabled={!freshWrite}
                        onChange={(e) => {
                          setSelectedOrder(null);
                          setBindConsent(false);
                          if (e.target.value) chooseOrder(e.target.value);
                        }}
                      >
                        <option value="">Wybierz konkretne zamówienie</option>
                        {orders.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.number} — {o.customer_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {orderCursor && (
                      <button
                        type="button"
                        className="button"
                        disabled={busy || shared.locked}
                        onClick={() => findOrders(true)}
                      >
                        Następna strona zamówień
                      </button>
                    )}
                    {selectedOrder && (
                      <p>
                        Przed: bez powiązania. Po zapisie: {selectedOrder.number},{' '}
                        {selectedOrder.customer_name}, email zamówienia{' '}
                        {selectedOrder.email ?? 'brak'}. Nadawca wiadomości:{' '}
                        {message.headers.from.address}. Rewizja zamówienia{' '}
                        {String(selectedOrder.version)}.
                      </p>
                    )}
                    <label className="ei-check">
                      <input
                        type="checkbox"
                        checked={bindConsent}
                        disabled={!freshWrite || !selectedOrder || !message.can_bind}
                        onChange={(e) => setBindConsent(e.target.checked)}
                      />
                      Sprawdziłem wiadomość i zamówienie. Potwierdzam powiązanie bez wysyłania
                      odpowiedzi.
                    </label>
                    <button
                      type="button"
                      className="button primary"
                      disabled={!freshWrite || !bindConsent || !selectedOrder || !message.can_bind}
                      onClick={() => {
                        if (selectedOrder)
                          void mutate(
                            'Powiązanie wiadomości z zamówieniem',
                            prefix + '/messages/' + message.id + '/bind',
                            {
                              client_key: crypto.randomUUID(),
                              version: message.version,
                              order_id: selectedOrder.id,
                              order_version: String(selectedOrder.version),
                              confirmed: true,
                            },
                          );
                      }}
                    >
                      Powiąż z zamówieniem
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      Wiadomość ma trwałe powiązanie z zamówieniem. Pozostaje wiadomością email dla
                      pracowników; nie jest wpisem kupującego w portalu.
                    </p>
                    <div className="ei-actions">
                      {props.onOpenOrder && (
                        <button
                          type="button"
                          className="button"
                          disabled={busy || shared.locked}
                          onClick={() => props.onOpenOrder?.(message.order_id!)}
                        >
                          Otwórz zamówienie wiadomości
                        </button>
                      )}
                      {props.onOpenThread && (
                        <button
                          type="button"
                          className="button"
                          disabled={busy || shared.locked}
                          onClick={() =>
                            props.onOpenThread?.(message.order_id!, message.thread_id!)
                          }
                        >
                          Otwórz wątek zamówienia
                        </button>
                      )}
                    </div>
                    <h3>Odpowiedź email</h3>
                    <p>
                      Odbiorca odpowiedzi:{' '}
                      {(message.headers.reply_to ?? message.headers.from).address} (
                      {message.headers.reply_to ? 'Reply-To wiadomości' : 'From wiadomości'}). Adres
                      zamówienia nie zastępuje tego odbiorcy.
                    </p>
                    <fieldset disabled={!freshWrite || !message.can_reply}>
                      <div className="ei-grid">
                        <label>
                          Konto SMTP odpowiedzi
                          <select
                            value={replyChannel}
                            onChange={(e) => {
                              setReplyChannel(e.target.value);
                              changeReply();
                            }}
                          >
                            <option value="">Wybierz konto SMTP</option>
                            {options.smtp_channels.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name} —{' '}
                                {c.delivery === 'local_sink'
                                  ? 'lokalny odbiornik testowy'
                                  : 'zewnętrzne SMTP'}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Temat odpowiedzi
                          <input
                            value={subject}
                            maxLength={200}
                            onChange={(e) => {
                              setSubject(e.target.value);
                              changeReply();
                            }}
                          />
                        </label>
                      </div>
                      <label>
                        Treść odpowiedzi email
                        <textarea
                          rows={6}
                          maxLength={20000}
                          value={text}
                          onChange={(e) => {
                            setText(e.target.value);
                            changeReply();
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="button"
                        disabled={!uuid(replyChannel) || !subject.trim() || !text.trim()}
                        onClick={prepareReply}
                      >
                        Przygotuj podgląd odpowiedzi email
                      </button>
                    </fieldset>
                  </>
                )}
                <details>
                  <summary>Historia odpowiedzi tej wiadomości</summary>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => loadReplies()}
                  >
                    Odczytaj historię odpowiedzi
                  </button>
                  {replies.map((r) => (
                    <div className="ei-actions" key={r.id}>
                      <span>
                        {date(r.created_at)} · {replyNames[r.state]}
                      </span>
                      <button
                        type="button"
                        className="button"
                        disabled={busy}
                        onClick={() => loadReply(r.id)}
                      >
                        Odczytaj odpowiedź z {date(r.created_at)}
                      </button>
                    </div>
                  ))}
                  {replyCursor && (
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => loadReplies(true)}
                    >
                      Starsze odpowiedzi
                    </button>
                  )}
                </details>
              </div>
            )}
            {replyPreview && (
              <div className="ei-card">
                <h3>Pełny zapisany podgląd odpowiedzi SMTP</h3>
                <ReplyReview p={replyPreview} />
                <p>Ważny do {date(replyPreview.expires_at)}. Ta czynność nie wysyła wiadomości.</p>
                {replyPreview.queued_reply_id ? (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => loadReply(replyPreview.queued_reply_id!)}
                  >
                    Odczytaj już zapisaną odpowiedź
                  </button>
                ) : (
                  <>
                    <label className="ei-check">
                      <input
                        type="checkbox"
                        checked={replyConsent}
                        disabled={
                          !freshWrite ||
                          !replyPreview.can_queue ||
                          Date.parse(replyPreview.expires_at) <= Date.now()
                        }
                        onChange={(e) => setReplyConsent(e.target.checked)}
                      />
                      Sprawdziłem nadawcę, odbiorcę, nagłówki i całą treść. Potwierdzam jedną
                      odpowiedź.
                    </label>
                    {!replyPreview.snapshot.sender.local_sink && (
                      <label className="ei-check">
                        <input
                          type="checkbox"
                          checked={externalConsent}
                          disabled={!freshWrite}
                          onChange={(e) => setExternalConsent(e.target.checked)}
                        />
                        Zatwierdzam rzeczywistą wysyłkę przez zewnętrzne SMTP do wskazanego
                        odbiorcy.
                      </label>
                    )}
                    <button
                      type="button"
                      className="button primary"
                      disabled={
                        !freshWrite ||
                        !replyConsent ||
                        !replyPreview.can_queue ||
                        (!replyPreview.snapshot.sender.local_sink && !externalConsent) ||
                        Date.parse(replyPreview.expires_at) <= Date.now()
                      }
                      onClick={() =>
                        void mutate(
                          'Dodanie odpowiedzi do kolejki SMTP',
                          prefix + '/reply-previews/' + replyPreview.id + '/queue',
                          {
                            client_key: crypto.randomUUID(),
                            scope_hash: replyPreview.scope_hash,
                            confirmed: true,
                            confirm_external: externalConsent,
                          },
                        )
                      }
                    >
                      Dodaj odpowiedź do kolejki SMTP
                    </button>
                  </>
                )}
              </div>
            )}
            {reply && (
              <div className="ei-card">
                <h3>{replyNames[reply.state]}</h3>
                <ReplyReview p={reply.snapshot} />
                <p>
                  Przyjęcie przez SMTP nie potwierdza doręczenia. Wynik niepewny wymaga sprawdzenia
                  konta; ten panel nie ponawia wysyłki automatycznie.
                </p>
                {reply.error && <p className="error-block">{reply.error}</p>}
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => loadReply(reply.id)}
                >
                  Odczytaj wynik odpowiedzi SMTP
                </button>
              </div>
            )}
            <details>
              <summary>Historia odczytów IMAP</summary>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => loadAcquisitions()}
              >
                Odczytaj historię pobrań
              </button>
              {acquisitions.map((a) => (
                <div className="ei-actions" key={a.id}>
                  <span>
                    {date(a.created_at)} · {acquisitionNames[a.state]}
                  </span>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => loadAcquisition(a.id)}
                  >
                    Otwórz odczyt z {date(a.created_at)}
                  </button>
                </div>
              ))}
              {acquisitionCursor && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => loadAcquisitions(true)}
                >
                  Starsze pobrania
                </button>
              )}
            </details>
          </>
        )}
      </div>
    </section>
  );
}
function MailBody({
  headers,
  text,
  attachments,
}: {
  headers: Headers;
  text: string;
  attachments: Attachment[];
}) {
  return (
    <>
      <p>
        Od: {headers.from.name} &lt;{headers.from.address}&gt;
        {headers.reply_to && <> · Reply-To: {headers.reply_to.address}</>}
      </p>
      <p>
        Do: {headers.to.map((a) => a.address).join(', ')} · data nadawcy:{' '}
        {headers.sent_at ? date(headers.sent_at) : 'brak'}
      </p>
      <small>
        Message-ID: {headers.message_id ?? 'brak'} · In-Reply-To: {headers.in_reply_to ?? 'brak'}
      </small>
      <div className="ei-text">{text || '(Brak treści tekstowej)'}</div>
      <p>
        Załączniki: {attachments.length}. Treść HTML i zewnętrzne obrazy nadawcy nie są uruchamiane.
      </p>
      {attachments.map((f) => (
        <small key={f.index}>
          {f.index + 1}. {f.filename} · {f.mime} · {f.bytes} bajtów · SHA256 {f.sha256}
        </small>
      ))}
    </>
  );
}
function ReplyReview({ p }: { p: ReplyPreview }) {
  return (
    <>
      <p>
        Zamówienie {p.snapshot.order.number} · od: {p.snapshot.sender.name} &lt;
        {p.snapshot.sender.email}&gt; · do: {p.snapshot.payload.recipient}
      </p>
      <h3>{p.snapshot.payload.subject}</h3>
      <div className="ei-text">{p.snapshot.payload.text}</div>
      <p>In-Reply-To: {p.snapshot.payload.in_reply_to ?? 'brak'}</p>
      <p>References: {p.snapshot.payload.references.join(' · ') || 'brak'}</p>
      <p>
        {p.snapshot.sender.local_sink
          ? 'Lokalny odbiornik testowy — bez przekazywania do Internetu.'
          : 'Zewnętrzne konto SMTP — wymaga odrębnej zgody i aktualnego dostępu.'}
      </p>
    </>
  );
}
