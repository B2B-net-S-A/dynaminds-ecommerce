import {useEffect, useRef, useState, type ComponentType} from 'react';
import {api} from './api';
import {Fa3DownloadButton} from './fa3-download';
import {withReturnCreditCustodyLock} from './consumer-return-credit-lock';
import type {ReturnCredit206Document, ReturnCredit206Preview, ReturnCredit206Series} from '../server/return-credit206-values';

const root = '/consumer-return-credits';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const amount = (v: unknown): v is string => typeof v === 'string' && /^-?(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) >= -9223372036854775807n && BigInt(v) <= 9223372036854775807n;
const text = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
function need(v: unknown): asserts v { if (!v) throw Error('Nie można potwierdzić danych korekty. Odśwież widok i sprawdź uprawnienia.'); }
function actorOf(context: string) { const p = context.split(':'); need(uuid(p[0]) && uuid(p[1]) && ['admin', 'operator', 'viewer'].includes(p[2])); return p.slice(0, 2).join(':'); }
function money(v: string) { need(amount(v)); const n = BigInt(v), a = n < 0n ? -n : n; return `${n < 0n ? '-' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')} PLN`; }
function checkMoney(v: any) { need(v && amount(v.net_minor) && amount(v.vat_minor) && amount(v.gross_minor) && BigInt(v.net_minor) + BigInt(v.vat_minor) === BigInt(v.gross_minor)); }
function series(v: any): ReturnCredit206Series { need(v && uuid(v.id) && version(v.version) && text(v.name, 120) && typeof v.prefix === 'string' && /^[A-Z0-9][A-Z0-9-]{0,23}$/.test(v.prefix) && typeof v.enabled === 'boolean'); return v; }
function flags(v: any, role: string) { need(v?.available === true && v.can_read === true && typeof v.read_only === 'boolean' && v.current_role === role && typeof v.can_preview === 'boolean' && typeof v.can_issue === 'boolean' && (!v.read_only || (!v.can_preview && !v.can_issue))); }
function calculation(c: any, orderDocument: string, returnId: string) {
  need(c?.schema === 'consumer-return-credit-calculation/v2' && c.currency === 'PLN' && c.tax_method === 'gross_line_half_up' && c.original_document_id === orderDocument && c.return_id === returnId && uuid(c.original_receipt_id) && uuid(c.return_receipt_id) && hash(c.original_scope_hash) && hash(c.financial_hash) && hash(c.previous_chain_hash) && hash(c.physical_history_hash) && Number.isInteger(c.receipt_sequence) && c.receipt_sequence >= 1 && c.receipt_sequence <= 1000 && Array.isArray(c.rows) && c.rows.length >= 2 && c.rows.length <= 101 && Array.isArray(c.vat_totals));
  for (const [i, r] of c.rows.entries()) {
    need(r.ordinal === i && ['item', 'shipping'].includes(r.kind) && text(r.name) && [0, 5, 8, 23].includes(r.vat_rate));
    for (const k of ['before', 'after', 'delta']) { checkMoney(r[k]); need(amount(r[k].quantity)); }
    for (const k of ['quantity', 'gross_minor', 'net_minor', 'vat_minor']) need(BigInt(r.after[k]) - BigInt(r.before[k]) === BigInt(r.delta[k]));
  }
  need(c.vat_totals.length >= 1 && c.vat_totals.length <= 4 && new Set(c.vat_totals.map((r: any) => r.vat_rate)).size === c.vat_totals.length);
  for (const k of ['before', 'after', 'delta']) {
    checkMoney(c.totals?.[k]);
    for (const m of ['gross_minor', 'net_minor', 'vat_minor']) need(c.rows.reduce((n: bigint, r: any) => n + BigInt(r[k][m]), 0n) === BigInt(c.totals[k][m]));
    for (const v of c.vat_totals) {
      need([0, 5, 8, 23].includes(v.vat_rate)); checkMoney(v[k]);
      for (const m of ['gross_minor', 'net_minor', 'vat_minor']) need(c.rows.filter((r: any) => r.vat_rate === v.vat_rate).reduce((n: bigint, r: any) => n + BigInt(r[k][m]), 0n) === BigInt(v[k][m]));
    }
    need(c.rows.every((r: any) => c.vat_totals.some((v: any) => v.vat_rate === r.vat_rate)));
  }
}
function preview(v: any, orderId: string, returnId: string): ReturnCredit206Preview {
  need(v && uuid(v.id) && uuid(v.original_document_id) && v.return_id === returnId && hash(v.scope_hash) && hash(v.calculation_hash) && typeof v.can_issue === 'boolean' && Number.isFinite(Date.parse(v.expires_at)) && (v.issued_document_id === null || uuid(v.issued_document_id)));
  const s = v.snapshot;
  need(s?.schema === 'consumer-return-credit/v2' && s.original_document?.id === v.original_document_id && s.original_document.order_id === orderId && s.original_document.kind === 'invoice' && s.original_document.mode === 'local_invoice' && text(s.original_document.number, 120) && s.local_only === true && s.ksef_state === 'not_submitted' && s.fiscalized === false && text(s.reason) && s.reason.trim().length >= 3 && version(s.return_version));
  series({...s.correction_series, enabled: true}); calculation(s.calculation, v.original_document_id, returnId); return v;
}
function documentValue(v: any, orderId: string, returnId: string, held?: Held): ReturnCredit206Document {
  const d = v?.document, r = v?.receipt;
  need(d && r && uuid(d.id) && uuid(r.id) && d.order_id === orderId && d.return_id === returnId && d.kind === 'correction' && d.mode === 'consumer_return_credit' && text(d.number, 120) && d.data?.number === d.number && r.document_id === d.id && r.return_id === returnId && uuid(r.preview_id) && r.preview_id === d.data.preview_id && r.scope_hash === d.data.scope_hash && hash(r.calculation_hash) && r.original_document_id === d.original_document_id && r.original_receipt_id === d.data.calculation?.original_receipt_id && r.return_receipt_id === d.data.calculation.return_receipt_id && r.receipt_sequence === d.data.calculation.receipt_sequence && r.number === d.number);
  if (held) need(r.client_key === held.clientKey && r.preview_id === held.previewId && r.actor_id === held.actor.split(':')[1] && r.api_key_id === null);
  preview({id: r.preview_id, original_document_id: d.original_document_id, return_id: returnId, scope_hash: r.scope_hash, calculation_hash: r.calculation_hash, snapshot: d.data, expires_at: d.created_at, can_issue: false, issued_document_id: d.id}, orderId, returnId);
  return d;
}
function sourceValue(v: any, orderId: string, returnId: string, role: string) {
  flags(v, role);
  need(v.original?.document?.order_id === orderId && uuid(v.original.document.id) && v.original.document.kind === 'invoice' && v.original.document.mode === 'local_invoice' && text(v.original.document.number, 120) && Array.isArray(v.series) && v.series.length <= 100 && Array.isArray(v.previous_credits) && v.previous_credits.length <= 1000 && Array.isArray(v.credit_families) && hash(v.physical_history_hash) && typeof v.eligible === 'boolean' && [null, 'no_commercial_change', 'earlier_acceptance_required', 'already_credited'].includes(v.eligibility_reason));
  for (const s of v.series) need(series(s).enabled);
  need(new Set(v.series.map((s: any) => s.id)).size === v.series.length);
  if (v.eligible) { need(v.eligibility_reason === null && v.next_return_id === returnId && version(v.current_return_version)); calculation(v.calculation, v.original.document.id, returnId); need(v.calculation.physical_history_hash === v.physical_history_hash); }
  else need(v.eligibility_reason !== null && v.calculation === null);
  for (const c of v.previous_credits) need(uuid(c.return_id) && uuid(c.document_id));
  for (const f of v.credit_families) need(uuid(f.document_id) && uuid(f.receipt_id) && ['legacy', 'destinations'].includes(f.family));
  if (v.eligibility_reason === 'already_credited') need(v.previous_credits.some((c: any) => c.return_id === returnId));
  return v;
}

type HeldBase = {actor: string; operation: 'series' | 'preview' | 'issue'; clientKey: string; orderId: string; returnId: string; previewId: string | null; seriesName: string | null; seriesPrefix: string | null};
type ExactHeld = HeldBase & {schema: 'consumer-return-credit-custody/v3'; method: 'POST'; resource: string; requestBody: Record<string, unknown>};
type Held = ExactHeld | (HeldBase & {schema: 'consumer-return-credit-custody/v1' | 'consumer-return-credit-custody/v2'});
function exactKeys(value: any, keys: string[]) { need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')); }
/** Only the business fields actually dispatched are retained, never headers or credentials. */
function exactIntent(h: ExactHeld) {
  need(h.method === 'POST'); const b = h.requestBody;
  if (h.operation === 'series') {
    need(h.resource === root + '/series'); exactKeys(b, ['client_key', 'name', 'prefix']);
    need(b.name === h.seriesName && b.prefix === h.seriesPrefix);
  } else if (h.operation === 'preview') {
    need(h.resource === root + '/previews');
    exactKeys(b, ['client_key', 'original_document_id', 'return_id', 'expected_return_version', 'series_id', 'expected_series_version', 'reason', 'ordinary_domestic_confirmed', 'local_only']);
    need(uuid(b.original_document_id) && b.return_id === h.returnId && version(b.expected_return_version) && uuid(b.series_id) && version(b.expected_series_version) && text(b.reason) && b.reason.trim() === b.reason && b.reason.length >= 3 && b.ordinary_domestic_confirmed === true && b.local_only === true);
  } else {
    need(h.resource === root + '/previews/' + h.previewId + '/issue');
    exactKeys(b, ['client_key', 'scope_hash', 'confirmed', 'local_only']);
    need(hash(b.scope_hash) && b.confirmed === true && b.local_only === true);
  }
  need(b.client_key === h.clientKey);
}
function matchesOriginalIntent(h: ExactHeld, v: any) {
  exactIntent(h); const b = h.requestBody;
  // Current original-command DTO does NOT expose its stored request. Compare
  // actual immutable snapshot/receipt semantics; never reconstruct that request.
  if (Object.hasOwn(v, 'request')) { exactKeys(v.request, Object.keys(b)); need(Object.keys(b).every(k => v.request[k] === b[k])); }
  if (Object.hasOwn(v, 'resource')) need(v.resource === h.resource);
  if (h.operation === 'preview') {
    const p = v.preview, s = p.snapshot;
    need(p.original_document_id === b.original_document_id && p.return_id === b.return_id && s.reason === b.reason && s.return_version === b.expected_return_version && s.correction_series.id === b.series_id && s.correction_series.version === b.expected_series_version);
  } else if (h.operation === 'issue') need(v.receipt.scope_hash === b.scope_hash && v.receipt.preview_id === h.previewId);
}
const listeners = new Set<() => void>(), journalKey = (actor: string) => 'dyna:consumer-return-credit:v1:' + actor;
function read(actor: string): Held | null {
  const raw = localStorage.getItem(journalKey(actor)); if (raw === null) return null;
  need(new TextEncoder().encode(raw).byteLength <= 4096); const h = JSON.parse(raw);
  const legacy = h.schema === 'consumer-return-credit-custody/v1';
  const exact = h.schema === 'consumer-return-credit-custody/v3';
  exactKeys(h, ['actor', 'clientKey', 'operation', 'orderId', 'previewId', 'returnId', 'schema', ...(!legacy ? ['seriesName', 'seriesPrefix'] : []), ...(exact ? ['method', 'resource', 'requestBody'] : [])]);
  need((legacy || exact || h.schema === 'consumer-return-credit-custody/v2') && h.actor === actor && ['series', 'preview', 'issue'].includes(h.operation) && uuid(h.clientKey) && uuid(h.orderId) && uuid(h.returnId) && (h.operation === 'issue' ? uuid(h.previewId) : h.previewId === null));
  // Existing opaque v1 attempts could only create the original default series.
  const held = legacy ? {...h, seriesName: h.operation === 'series' ? 'Korekty zwrotów' : null, seriesPrefix: h.operation === 'series' ? 'KOR-ZWROT' : null} : h;
  if (h.operation === 'series') { need(text(held.seriesName, 120) && typeof held.seriesPrefix === 'string' && /^[A-Z0-9][A-Z0-9-]{0,23}$/.test(held.seriesPrefix)); }
  else need(held.seriesName === null && held.seriesPrefix === null);
  if (exact) exactIntent(held);
  return held;
}
function notify() { for (const fn of listeners) fn(); }
function retain(h: Held) { need(read(h.actor) === null); const raw = JSON.stringify(h); need(new TextEncoder().encode(raw).byteLength <= 4096); if (h.schema === 'consumer-return-credit-custody/v3') exactIntent(h); localStorage.setItem(journalKey(h.actor), raw); need(localStorage.getItem(journalKey(h.actor)) === raw); need(JSON.stringify(read(h.actor)) === raw); notify(); }
function clear(h: Held) { need(JSON.stringify(read(h.actor)) === JSON.stringify(h)); localStorage.removeItem(journalKey(h.actor)); need(read(h.actor) === null); notify(); }
export function returnCreditsLocked(context: string) { try { return read(actorOf(context)) !== null; } catch { return true; } }
export function subscribeReturnCreditsLock(context: string, fn: () => void) { listeners.add(fn); window.addEventListener('storage', fn); return () => { listeners.delete(fn); window.removeEventListener('storage', fn); }; }
export type CreditPanelProps = {orderId: string; returnId: string; contextKey: string; readOnly: boolean; externalWriteBlocked: boolean; onChanged: () => void; inspectionOnly?: boolean};
type PanelProps = CreditPanelProps & {isOtherPending: () => boolean};
async function identity(context: string, write = false) {
  const actor = actorOf(context), me = await api('/auth/me');
  need(typeof me.restore_preview === 'boolean' && me.user?.tenant_id === actor.split(':')[0] && me.user?.id === actor.split(':')[1] && me.user?.role === context.split(':')[2]);
  if (write) need(me.restore_preview === false && me.read_only !== true && ['admin', 'operator'].includes(me.user.role));
}

/** The authoritative strategy is checked before either financial family is read. */
export function ConsumerCreditStrategyPanel(props: PanelProps & {legacy: ComponentType<CreditPanelProps>}) {
  const stamp = [props.contextKey, props.orderId, props.returnId, props.readOnly, !!props.inspectionOnly].join('|');
  const live = useRef({stamp, mounted: true}); live.current.stamp = stamp;
  const [result, setResult] = useState<{stamp: string; strategy?: 'legacy' | 'destinations'; error?: string} | null>(null);
  useEffect(() => {
    let active = true; live.current.mounted = true; setResult(null);
    void (async () => {
      await identity(props.contextKey); need(active && live.current.stamp === stamp);
      const v = await api(root + '/orders/' + props.orderId + '/strategy');
      need(active && live.current.stamp === stamp && v?.order_id === props.orderId && ['legacy', 'destinations'].includes(v.strategy) && typeof v.available === 'boolean' && typeof v.read_only === 'boolean');
      await identity(props.contextKey); need(active && live.current.stamp === stamp);
      if (v.available === false && v.strategy === 'destinations' && v.unavailable_reason === 'catalog_receipt_required') {
        setResult({stamp, error: 'Zwrot zapisano bez dokumentu magazynowego wymaganego do korekty; korekta jest niedostępna. Dla kolejnych zwrotów włącz kontrolę stanów katalogu z bilansem otwarcia przed przyjęciem — nie uzupełni to obecnego zwrotu.'});
        return;
      }
      need(v.available === true && v.unavailable_reason === undefined);
      setResult({stamp, strategy: v.strategy});
    })().catch(() => { if (active && live.current.stamp === stamp) setResult({stamp, error: 'Korekta jest obecnie niedostępna. Odśwież widok i sprawdź uprawnienia. Nie wykonano nowego zapisu.'}); });
    return () => { active = false; live.current.mounted = false; };
  }, [stamp]);
  const own = result?.stamp === stamp ? result : null;
  if (own?.error) return <p className="notice error" role="alert">{own.error}</p>;
  if (!own?.strategy) return <p className="notice">Sprawdzanie dostępności korekty…</p>;
  if (props.inspectionOnly && own.strategy === 'legacy') return null;
  const Legacy = props.legacy;
  return own.strategy === 'legacy' ? <Legacy key={stamp} {...props} externalWriteBlocked={props.externalWriteBlocked || returnCreditsLocked(props.contextKey)}/> : <ConsumerReturnCreditPanel key={stamp} {...props}/>;
}

function ConsumerReturnCreditPanel({orderId, returnId, contextKey, readOnly, externalWriteBlocked, onChanged, isOtherPending}: PanelProps) {
  const actor = actorOf(contextKey), role = contextKey.split(':')[2];
  const live = useRef({mounted: true, contextKey, orderId, returnId, readOnly, externalWriteBlocked}); live.current = {...live.current, contextKey, orderId, returnId, readOnly, externalWriteBlocked};
  const flight = useRef(false);
  const [source, setSource] = useState<any>(null), [p, setPreview] = useState<ReturnCredit206Preview | null>(null), [document, setDocument] = useState<ReturnCredit206Document | null>(null), [existingLink, setExistingLink] = useState<string | null>(null);
  const [selectedSeries, setSelectedSeries] = useState(''), [reason, setReason] = useState('Zwrot towaru'), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [held, setHeld] = useState<Held | null>(null), [storageFailed, setStorageFailed] = useState(false);
  const [seriesName, setSeriesName] = useState('Korekty zwrotów'), [seriesPrefix, setSeriesPrefix] = useState('KOR-ZWROT');
  const [addingSeries, setAddingSeries] = useState(false);
  function current(write = false) { need(live.current.mounted && live.current.contextKey === contextKey && live.current.orderId === orderId && live.current.returnId === returnId); if (write) need(!live.current.readOnly && ['admin', 'operator'].includes(role) && !live.current.externalWriteBlocked && !isOtherPending()); }
  async function iam(write = false) { current(); if (write) need(!live.current.readOnly); await identity(contextKey, write); current(); if (write) need(!live.current.readOnly); }
  async function load() {
    await iam(); const v = sourceValue(await api(root + '/orders/' + orderId + '/source?return_id=' + returnId), orderId, returnId, role); current(); await iam();
    let doc: ReturnCredit206Document | null = null, link: string | null = null;
    const existing = v.previous_credits.find((c: any) => c.return_id === returnId);
    if (existing) {
      const families = v.credit_families.filter((f: any) => f.document_id === existing.document_id); need(families.length === 1);
      if (families[0].family === 'destinations') { const d = await api(root + '/documents/' + existing.document_id); flags(d, role); doc = documentValue(d, orderId, returnId); need(doc.original_document_id === v.original.document.id); await iam(); }
      else link = '/api/local-consumer-credits/documents/' + existing.document_id + '/print';
    }
    current(); setSource(v); setDocument(doc); setExistingLink(link);
    setSelectedSeries((old: string) => v.series.some((s: any) => s.id === old) ? old : v.series[0]?.id ?? ''); return v;
  }
  useEffect(() => {
    live.current.mounted = true;
    const update = () => { if (!live.current.mounted) return; try { setHeld(read(actor)); setStorageFailed(false); } catch { setStorageFailed(true); setError('Nie można bezpiecznie odczytać zapisanej próby. Nowy zapis jest zablokowany.'); } };
    update(); const unsubscribe = subscribeReturnCreditsLock(contextKey, update);
    void load().catch(() => { if (live.current.mounted) { setSource(null); setError('Nie można odczytać danych korekty. Odśwież widok i sprawdź uprawnienia.'); } });
    return () => { live.current.mounted = false; unsubscribe(); };
  }, []);
  async function resolve(h: Held, v: any) {
    current(); flags(v, role); need(h.actor === actor && v.actor_id === actor.split(':')[1] && v.api_key_id === null && v.operation === h.operation && v.client_key === h.clientKey);
    let nextPreview: ReturnCredit206Preview | null = null, nextDocument: ReturnCredit206Document | null = null;
    if (h.operation === 'preview') nextPreview = preview(v.preview, h.orderId, h.returnId);
    else if (h.operation === 'issue') nextDocument = documentValue(v, h.orderId, h.returnId, h);
    else need(series(v.series).enabled && v.series.name === h.seriesName && v.series.prefix === h.seriesPrefix);
    if (h.schema === 'consumer-return-credit-custody/v3') matchesOriginalIntent(h, v);
    else if (h.operation !== 'series') throw Error('LEGACY_INTENT_LIMITED');
    await iam(true); clear(h); setHeld(null); setConsent(false);
    if (h.orderId === orderId && h.returnId === returnId) { if (nextPreview) setPreview(nextPreview); if (nextDocument) setDocument(nextDocument); }
    if (h.operation !== 'preview') { onChanged(); if (h.operation === 'series') { await load(); current(); setSelectedSeries(v.series.id); setAddingSeries(false); } }
  }
  async function run(operation: Held['operation']) {
    if (flight.current) return; flight.current = true; setBusy(true); setError(''); let h: Held | undefined, failedBeforeWrite = false;
    try {
      await withReturnCreditCustodyLock(actor, async () => {
      current(true); need(!storageFailed && read(actor) === null); const fresh = await load(); current(true); need(fresh.eligible === true && fresh.can_preview === true && fresh.can_issue === true);
      const clientKey = crypto.randomUUID(), base = {actor, operation, clientKey, orderId, returnId, previewId: operation === 'issue' ? p?.id ?? null : null, seriesName: operation === 'series' ? seriesName.trim() : null, seriesPrefix: operation === 'series' ? seriesPrefix.trim() : null};
      let path: string, body: any;
      if (operation === 'series') { need(fresh.series.length < 100 && p === null && text(base.seriesName, 120) && typeof base.seriesPrefix === 'string' && /^[A-Z0-9][A-Z0-9-]{0,23}$/.test(base.seriesPrefix)); path = root + '/series'; body = {client_key: clientKey, name: base.seriesName, prefix: base.seriesPrefix}; }
      else if (operation === 'preview') {
        need(consent && text(reason.trim()) && reason.trim().length >= 3); const s = fresh.series.find((s: any) => s.id === selectedSeries); need(s?.enabled);
        path = root + '/previews'; body = {client_key: clientKey, original_document_id: fresh.original.document.id, return_id: returnId, expected_return_version: fresh.current_return_version, series_id: s.id, expected_series_version: s.version, reason: reason.trim(), ordinary_domestic_confirmed: true, local_only: true};
      } else {
        need(p && consent && p.can_issue && p.issued_document_id === null && Date.parse(p.expires_at) > Date.now());
        const d = await api(root + '/previews/' + p.id); current(); flags(d, role); const freshPreview = preview(d.preview, orderId, returnId);
        need(d.can_issue && freshPreview.can_issue && freshPreview.issued_document_id === null && Date.parse(freshPreview.expires_at) > Date.now() && freshPreview.scope_hash === p.scope_hash && JSON.stringify(freshPreview.snapshot) === JSON.stringify(p.snapshot));
        await iam(); path = root + '/previews/' + p.id + '/issue'; body = {client_key: clientKey, scope_hash: p.scope_hash, confirmed: true, local_only: true};
      }
      h = {...base, schema: 'consumer-return-credit-custody/v3', method: 'POST', resource: path, requestBody: body};
      await iam(true); current(true); need(read(actor) === null); retain(h); setHeld(h);
      const persisted = read(actor); need(persisted?.schema === 'consumer-return-credit-custody/v3' && JSON.stringify(persisted) === JSON.stringify(h)); exactIntent(persisted);
      let failed: any;
      const v = await api(persisted.resource, persisted.method, persisted.requestBody, {}, undefined, (data, response) => { if (!response.ok) failed = data; }).catch(async e => {
        if (failed?.write_outcome === 'failed_before_write' && failed.actor_id === actor.split(':')[1] && failed.tenant_id === actor.split(':')[0] && failed.operation === operation && failed.client_key === clientKey) { await iam(true); clear(h!); setHeld(null); failedBeforeWrite = true; }
        throw e;
      });
      await resolve(h, v);
      });
    } catch { if (live.current.mounted) { setSource(null); setDocument(null); setExistingLink(null); setPreview(null); setConsent(false); setError(h && !failedBeforeWrite ? 'Nie potwierdzono wyniku operacji. Odczytaj oryginalny wynik; nie ponawiaj zapisu.' : 'Nie wykonano nowego zapisu. Odśwież widok i sprawdź dane oraz uprawnienia.'); } }
    finally { flight.current = false; if (live.current.mounted) setBusy(false); }
  }
  async function recover() {
    if (!held || flight.current) return; flight.current = true; setBusy(true); setError('');
    try { await withReturnCreditCustodyLock(actor, async () => { await iam(true); const v = await api(root + '/commands/' + held.clientKey + '?operation=' + held.operation); await resolve(held, v); if (held.operation !== 'series') await load(); }); }
    catch (e) { if (live.current.mounted) { setSource(null); setPreview(null); setDocument(null); setExistingLink(null); setError(e instanceof Error && e.message === 'LEGACY_INTENT_LIMITED' ? 'Starsza zapisana próba nie zawiera pełnych danych żądania. Odczytano wynik, lecz nie można bezpiecznie zwolnić blokady ani przygotować kolejnej korekty.' : 'Nie potwierdzono oryginalnego wyniku. Zapisana próba nadal blokuje nowy zapis.'); } }
    finally { flight.current = false; if (live.current.mounted) setBusy(false); }
  }
  const blocked = busy || !!held || storageFailed || readOnly || externalWriteBlocked || !['admin', 'operator'].includes(role);
  return <section className="panel"><h3>Korekta do zwrotu konsumenckiego</h3><p>Lokalna korekta do krajowej faktury VAT w PLN. Bez wysyłki do KSeF i fiskalizacji. Zwrot pieniędzy jest osobną operacją.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {held && <div className="notice">Nieustalony wynik operacji. Nowe zapisy są zablokowane.<button className="button" disabled={busy || readOnly || !['admin', 'operator'].includes(role)} onClick={() => void recover()}>Odczytaj oryginalny wynik</button></div>}
    {source && <p>Faktura źródłowa: {source.original.document.number}</p>}
    {source?.eligibility_reason === 'no_commercial_change' && <p className="notice">Przyjęcie zwrotu nie zmienia ilości ani wartości sprzedaży. Korekta nie jest potrzebna. Nie powstaje dokument ani numer korekty.</p>}
    {source?.eligibility_reason === 'earlier_acceptance_required' && <p className="notice">Najpierw wystaw korektę wcześniejszego przyjęcia zwrotu. Korekta ilościowa może mieć wartość 0 zł.</p>}
    {document ? <div className="notice"><strong>{document.number}</strong> · {money(document.data.calculation.totals.delta.gross_minor)} <a className="button" target="_blank" rel="noreferrer" href={'/api' + root + '/documents/' + document.id + '/print'}>Otwórz korektę / druk</a><Fa3DownloadButton documentId={document.id} workspaceId={contextKey.split(':')[0]} number={document.number}/></div> : existingLink ? <a className="button" target="_blank" rel="noreferrer" href={existingLink}>Otwórz wystawioną korektę / druk</a> : source?.eligible && <>
      {!p && (source.series.length === 0 || addingSeries) ? <div className="notice"><p>Dodaj serię numeracji korekt. Dla kolejnego obszaru roboczego tej samej firmy wybierz osobny prefiks.</p><label>Nazwa serii<input aria-label="Nazwa serii korekt" value={seriesName} maxLength={120} disabled={blocked} onChange={e => setSeriesName(e.target.value)}/></label><label>Prefiks numeru<input aria-label="Prefiks serii korekt" value={seriesPrefix} maxLength={24} disabled={blocked} onChange={e => setSeriesPrefix(e.target.value)}/></label><p>Przykład: {(/^[A-Z0-9][A-Z0-9-]{0,23}$/.test(seriesPrefix.trim()) ? seriesPrefix.trim() : 'KOR-ZWROT')}/rok/kolejny numer. Użyj wielkich liter, cyfr i myślnika.</p><button className="button" disabled={blocked || !source.can_issue || !text(seriesName.trim(), 120) || !/^[A-Z0-9][A-Z0-9-]{0,23}$/.test(seriesPrefix.trim())} onClick={() => void run('series')}>Utwórz serię korekt</button>{source.series.length > 0 && <button className="button" disabled={blocked} onClick={() => setAddingSeries(false)}>Anuluj dodawanie serii</button>}</div> : <>
        <label>Seria korekt{p ? <input aria-label="Seria korekt z podglądu" readOnly value={`${p.snapshot.correction_series.name} · ${p.snapshot.correction_series.prefix} · wersja ${p.snapshot.correction_series.version}`}/> : <select aria-label="Seria korekt" value={selectedSeries} disabled={blocked || !!p} onChange={e => { setSelectedSeries(e.target.value); setPreview(null); setConsent(false); }}>{source.series.map((s: ReturnCredit206Series) => <option key={s.id} value={s.id}>{s.name} · {s.prefix}</option>)}</select>}</label><button className="button" disabled={blocked || !!p || source.series.length >= 100} onClick={() => setAddingSeries(true)}>Dodaj serię korekt</button>
        <label>Przyczyna korekty<input aria-label="Przyczyna korekty" value={p ? p.snapshot.reason : reason} maxLength={500} disabled={blocked || !!p} onChange={e => { setReason(e.target.value); setPreview(null); setConsent(false); }}/></label>
        {p && <><p>Podgląd bez numeru · {p.snapshot.original_document.number}</p><table><thead><tr><th>Pozycja</th><th>Ilość przed / po</th><th>Zmiana netto</th><th>Zmiana VAT</th><th>Zmiana brutto</th></tr></thead><tbody>{p.snapshot.calculation.rows.map(r => <tr key={r.ordinal}><td>{r.name}</td><td>{r.before.quantity} / {r.after.quantity}</td><td>{money(r.delta.net_minor)}</td><td>{money(r.delta.vat_minor)}</td><td>{money(r.delta.gross_minor)}</td></tr>)}</tbody></table><strong>Łączna korekta {money(p.snapshot.calculation.totals.delta.gross_minor)}</strong><p>Korekta ilościowa może mieć wartość 0 zł.</p></>}
        <label><input aria-label="Potwierdzenie korekty" type="checkbox" checked={consent} disabled={blocked} onChange={e => setConsent(e.target.checked)}/>{p ? 'Potwierdzam pełny podgląd i wystawienie lokalnej numerowanej korekty.' : 'Potwierdzam zwykłą krajową sprzedaż VAT konsumentowi i przygotowanie lokalnego podglądu.'}</label>
        <button className="button primary" disabled={blocked || !source.can_issue || !source.can_preview || !consent || (!p && reason.trim().length < 3) || (p !== null && !p.can_issue)} onClick={() => void run(p ? 'issue' : 'preview')}>{p ? 'Wystaw numerowaną korektę' : 'Przygotuj podgląd korekty'}</button>
      </>}
    </>}
  </section>;
}

export function ConsumerReturnCreditRegister({contextKey, refresh}: {contextKey: string; refresh: number}) {
  const stamp = contextKey + '|' + refresh;
  const live = useRef({contextKey, mounted: true, stamp, generation: 0});
  if (live.current.stamp !== stamp) { live.current.stamp = stamp; live.current.generation++; }
  live.current.contextKey = contextKey;
  const [result, setResult] = useState<{context: string; value: any} | null>(null), [error, setError] = useState<{context: string; message: string} | null>(null), [busy, setBusy] = useState(false);
  async function load(cursor?: string) {
    const generation = live.current.generation;
    const current = () => need(live.current.mounted && live.current.contextKey === contextKey && live.current.generation === generation);
    need(!cursor || uuid(cursor)); await identity(contextKey); current();
    const v = await api(root + '/documents' + (cursor ? '?cursor=' + cursor : '')); flags(v, contextKey.split(':')[2]); need(Array.isArray(v.data) && v.data.length <= 50 && (v.next_cursor === null || uuid(v.next_cursor)));
    for (const d of v.data) { need(uuid(d.id) && uuid(d.order_id) && uuid(d.return_id) && uuid(d.original_document_id) && text(d.number, 120)); checkMoney(d.totals); }
    current(); await identity(contextKey); current(); setResult({context: stamp, value: v});
  }
  useEffect(() => { let active = true; live.current.mounted = true; setResult(null); setError(null); setBusy(true); void load().catch(() => { if (active) setError({context: stamp, message: 'Nie można odczytać rejestru korekt do zwrotów.'}); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; live.current.mounted = false; }; }, [contextKey, refresh]);
  const value = result?.context === stamp ? result.value : null;
  if (error?.context === stamp) return <p className="notice error" role="alert">{error.message}</p>;
  if (!value) return null;
  return <section className="panel"><h2>Korekty do zwrotów konsumenckich</h2><table><thead><tr><th>Numer</th><th>Faktura źródłowa</th><th>Zmiana brutto</th><th>Dokument</th></tr></thead><tbody>{value.data.map((d: any) => <tr key={d.id}><td>{d.number}</td><td><a target="_blank" rel="noreferrer" href={'/api/local-invoices/documents/' + d.original_document_id + '/print'}>Faktura źródłowa</a></td><td>{money(d.totals.gross_minor)}</td><td><a target="_blank" rel="noreferrer" href={'/api' + root + '/documents/' + d.id + '/print'}>Otwórz / drukuj</a><Fa3DownloadButton documentId={d.id} workspaceId={contextKey.split(':')[0]} number={d.number}/></td></tr>)}</tbody></table>{value.next_cursor && <button className="button" disabled={busy} onClick={() => { const generation = live.current.generation; setBusy(true); void load(value.next_cursor).catch(() => { if (live.current.mounted && live.current.generation === generation) setError({context: stamp, message: 'Nie można odczytać następnej strony korekt.'}); }).finally(() => { if (live.current.mounted && live.current.generation === generation) setBusy(false); }); }}>Następne 50 korekt do zwrotów</button>}</section>;
}
