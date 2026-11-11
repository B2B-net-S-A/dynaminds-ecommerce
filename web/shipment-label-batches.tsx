import { useEffect, useRef, useState } from 'react';
import { api, ApiError, date } from './api';
import { PrintLabelPdfPreview, type PrintLabelPdfReady } from './print-label-pdf-preview';
import {
  checkPrintJobFlags, checkPrintJobPrinter, getPrintJobsMutationState,
  performShipmentLabelPrintWrite, purgePrintJobsAccess, resetPrintJobsContext,
  subscribePrintJobsLock, validPrintVersion, verifyPrintJobsActor,
  type PrintJobFlags, type PrintJobPrinter, type PrintJobStation,
  type PrintJobWriteReply, type PrintWriteAttempt,
} from './print-jobs';
import './shipment-label-batches.css';

export type ShipmentLabelBatchProps = {
  selectedOrderIds: string[];
  contextKey: string;
  readOnly: boolean;
  externalWriteBlocked?: boolean;
  onOpenOrder: (id: string) => void;
  onChanged?: () => void;
};
type Options = PrintJobFlags & {
  batch_available?: boolean;
  stations: PrintJobStation[];
  printers: PrintJobPrinter[];
  limits: Record<string, number>;
};
type Summary = { shipments: number; orders: number; source_pages: number; combined_pages: number; copies: number; expected_label_copies: number };
type Row = {
  index: number; shipment_id: string; order_id: string; order_number: string;
  order_version: string; cache_asset_id: string; child_preview_id: string;
  child_scope_hash: string; tracking_number: string; provider: string; mode: string;
  layout: 'A4' | 'A6'; source_hash: string; content_sha256: string; content_bytes: number;
  pages: number; page_from: number; page_to: number;
};
type Preview = {
  id: string; kind: 'preview'; scope_hash: string; created_at: string; expires_at: string;
  station_snapshot: PrintJobStation; printer_snapshot: PrintJobPrinter; copies: number;
  summary: Summary; combined_pdf: { format: 'pdf'; content_sha256: string; content_bytes: number; pages: number; layout: 'A4' | 'A6' };
  rows: Row[]; queued_execution_id: string | null; can_queue: boolean;
};
type Execution = {
  id: string; kind: 'execution'; preview_id: string; scope_hash: string; summary: Summary;
  created_at: string; rows: (Row & { job_id: string; job_create_event_id: string })[];
  progress: { index: number; job_id: string; state: string; version: string }[];
};
type Head = { id: string; kind: 'preview' | 'execution'; scope_hash: string; summary: Summary; created_at: string; expires_at?: string; queued_execution_id?: string | null; preview_id?: string };
type Reply = PrintJobFlags & { preview?: Preview; execution?: Execution; reused?: boolean };
type Cache = { id: string; shipment_id: string; order_id: string; provider: string; mode: string; tracking_number: string; format: string; layout: 'A4' | 'A6'; content_sha256: string; content_bytes: number; source_hash: string };
type Choice = { order_id: string; order_number: string; shipment_id: string; tracking_number: string; carrier: string; order_version: string; cache: Cache | null; reason: string | null; can_queue: boolean };
type Source = PrintJobFlags & { cache: Cache | null; order_version: string | null; source_hash: string | null; can_queue: boolean; unavailable_reason: string | null };
const prefix = '/print-jobs/label-batches';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const states: Record<string, string> = { queued: 'W kolejce', claimed: 'Przejęte przez wykonawcę', file_saved: 'Plik zapisany lokalnie', spool_submitted: 'Przekazane do CUPS', failed: 'Błąd', unknown: 'Wynik nieznany', cancelled: 'Anulowane' };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function summary(s: Summary) {
  if (!s || !integer(s.shipments, 1, 50) || !integer(s.orders, 1, s.shipments) || !integer(s.copies, 1, 10) || !integer(s.source_pages, 1, 500) || s.combined_pages !== s.source_pages || s.expected_label_copies !== s.shipments * s.copies) throw Error('Niepełne podsumowanie całej partii.');
}
function manifest(rows: Row[], s: Summary) {
  summary(s);
  if (!Array.isArray(rows) || rows.length !== s.shipments || new Set(rows.map(r => r.shipment_id)).size !== rows.length || new Set(rows.map(r => r.child_preview_id)).size !== rows.length || new Set(rows.map(r => r.cache_asset_id)).size !== rows.length || new Set(rows.map(r => r.order_id)).size !== s.orders) throw Error('Niepełny zakres przesyłek partii.');
  let page = 1;
  for (const [index, r] of rows.entries()) {
    if (!r || r.index !== index || ![r.shipment_id, r.order_id, r.cache_asset_id, r.child_preview_id].every(uuid) || !validPrintVersion(r.order_version) || !r.order_number || !r.tracking_number || !['inpost','dpd'].includes(r.provider) || !['sandbox','live'].includes(r.mode) || !['A4','A6'].includes(r.layout) || ![r.source_hash,r.content_sha256,r.child_scope_hash].every(sha) || !integer(r.content_bytes,1,2097152) || !integer(r.pages,1,500) || r.page_from !== page || r.page_to !== page+r.pages-1) throw Error('Mapa źródeł i stron PDF jest niepełna.');
    page = r.page_to+1;
  }
  if (page-1 !== s.combined_pages || new Set(rows.map(r => r.layout)).size !== 1) throw Error('Strony lub formaty partii nie są zgodne.');
}
function checkPreview(p: Preview) {
  if (!p || !uuid(p.id) || p.kind !== 'preview' || !sha(p.scope_hash) || !Number.isFinite(Date.parse(p.created_at)) || !Number.isFinite(Date.parse(p.expires_at)) || typeof p.can_queue !== 'boolean' || (p.queued_execution_id !== null && !uuid(p.queued_execution_id))) throw Error('Niepełny trwały podgląd partii.');
  manifest(p.rows,p.summary); checkPrintJobPrinter(p.printer_snapshot);
  if (!p.station_snapshot || !uuid(p.station_snapshot.id) || !validPrintVersion(p.station_snapshot.version) || p.printer_snapshot.station_id !== p.station_snapshot.id || p.printer_snapshot.format !== 'pdf' || p.copies !== p.summary.copies || !p.combined_pdf || p.combined_pdf.format !== 'pdf' || !sha(p.combined_pdf.content_sha256) || !integer(p.combined_pdf.content_bytes,1,16777216) || p.combined_pdf.pages !== p.summary.combined_pages || p.combined_pdf.layout !== p.rows[0].layout) throw Error('Plik podglądu nie odpowiada całej partii.');
}
function checkExecution(e: Execution) {
  if (!e || !uuid(e.id) || e.kind !== 'execution' || !uuid(e.preview_id) || !sha(e.scope_hash) || !Number.isFinite(Date.parse(e.created_at))) throw Error('Niepełny zapis partii.');
  manifest(e.rows,e.summary);
  if (new Set(e.rows.map(r => r.job_id)).size !== e.rows.length || new Set(e.rows.map(r => r.job_create_event_id)).size !== e.rows.length || e.rows.some(r => !uuid(r.job_id) || !uuid(r.job_create_event_id)) || !Array.isArray(e.progress) || e.progress.length !== e.rows.length || e.progress.some((p,i) => p.index !== i || p.job_id !== e.rows[i].job_id || !validPrintVersion(p.version) || !Object.hasOwn(states,p.state))) throw Error('Zadania i wyniki partii nie obejmują całego zakresu.');
}
function checkHead(h: Head, kind: Head['kind']) {
  if (!h || h.kind !== kind || !uuid(h.id) || !sha(h.scope_hash) || !Number.isFinite(Date.parse(h.created_at))) throw Error('Niepełna historia partii.');
  summary(h.summary);
  if (kind === 'preview' ? !Number.isFinite(Date.parse(h.expires_at ?? '')) || (h.queued_execution_id !== null && !uuid(h.queued_execution_id)) : !uuid(h.preview_id)) throw Error('Niepełne powiązanie historii partii.');
}

export function ShipmentLabelBatchPanel(props: ShipmentLabelBatchProps) {
  const selectionKey = JSON.stringify(props.selectedOrderIds);
  const identity = `${props.contextKey}:${props.readOnly}:${selectionKey}`;
  const owner = `${props.contextKey}:label-batches`;
  const scope = useRef(identity); scope.current = identity;
  const alive = useRef(false), generation = useRef(0), handled = useRef<PrintJobWriteReply | null>(null);
  const [, redraw] = useState(0);
  const [options,setOptions] = useState<Options | null>(null), [loaded,setLoaded] = useState(''), [loadedEpoch,setLoadedEpoch] = useState(-1);
  const [reading,setReading] = useState(false), [error,setError] = useState(''), [success,setSuccess] = useState('');
  const [choices,setChoices] = useState<Choice[]>([]), [selected,setSelected] = useState<string[]>([]);
  const [stationId,setStationId] = useState(''), [printerId,setPrinterId] = useState(''), [copies,setCopies] = useState('1');
  const [preview,setPreview] = useState<Preview | null>(null), [execution,setExecution] = useState<Execution | null>(null);
  const [pdf,setPdf] = useState<{ previewId:string; hash:string; data:Uint8Array; epoch:number } | null>(null), [ready,setReady] = useState<PrintLabelPdfReady | null>(null);
  const [manifestConsent,setManifestConsent] = useState(false), [consent,setConsent] = useState(false), [retryConsent,setRetryConsent] = useState(false);
  const [history,setHistory] = useState<Head[]>([]), [historyKind,setHistoryKind] = useState<Head['kind']>('execution'), [cursor,setCursor] = useState<string | null>(null);
  const cursors = useRef(new Set<string>()), rejected = useRef(new Set<string>());
  const io = getPrintJobsMutationState(props.contextKey);
  const visible = loaded === identity && loadedEpoch === io.epoch;
  const busy = reading || io.inFlight;
  const canWrite = visible && !!options?.available && options.batch_available !== false && options.can_write && !options.read_only && !props.readOnly;
  const blocked = !canWrite || busy || io.locked || !!props.externalWriteBlocked;
  const ownPending = io.pending?.owner === owner && ['batch_preview','batch_queue'].includes(io.pending.kind) ? io.pending : null;
  const current = (n:number,e:number,id=identity) => alive.current && generation.current === n && scope.current === id && getPrintJobsMutationState(props.contextKey).epoch === e && getPrintJobsMutationState(props.contextKey).active;
  function invalidate() { setPreview(null); setExecution(null); setPdf(null); setReady(null); setConsent(false); setManifestConsent(false); setSuccess(''); }
  function purge() { setOptions(null); setChoices([]); setSelected([]); setStationId(''); setPrinterId(''); setCopies('1'); invalidate(); setHistory([]); setCursor(null); cursors.current.clear(); }
  function fail(err:unknown) {
    if (err instanceof ApiError && [401,403].includes(err.status)) { purgePrintJobsAccess(props.contextKey); purge(); }
    if (err instanceof ApiError && err.status === 503) purge();
    setError(err instanceof Error ? err.message : 'Nie udało się odczytać partii etykiet.');
  }
  async function access() {
    await verifyPrintJobsActor(props.contextKey);
    const o = await api<Options>(prefix+'/options'); checkPrintJobFlags(o);
    if (o.available && !o.can_read) throw new ApiError('Brak bieżącego dostępu do partii etykiet.',403);
    if (o.available && o.batch_available !== false) {
      if (!Array.isArray(o.stations) || o.stations.length > 100 || new Set(o.stations.map(s=>s.id)).size !== o.stations.length || o.stations.some(s=>!uuid(s.id) || !validPrintVersion(s.version) || typeof s.enabled !== 'boolean') || !Array.isArray(o.printers) || o.printers.length > 100 || new Set(o.printers.map(p=>p.id)).size !== o.printers.length) throw Error('Niepełny wybór własnych stanowisk i drukarek.');
      o.printers.forEach(checkPrintJobPrinter);
    }
    await verifyPrintJobsActor(props.contextKey); return o;
  }
  async function read<T>(run:(o:Options)=>Promise<T>,force=false):Promise<T|null> {
    if ((!force && reading) || io.inFlight) return null;
    const n=++generation.current,e=getPrintJobsMutationState(props.contextKey).epoch,id=identity;
    setReading(true); setError('');
    try { const o=await access(); if (!current(n,e,id)) return null; const r=await run(o); const last=await access(); if (!current(n,e,id)) return null; if (!last.available || last.batch_available === false) purge(); setOptions(last); setLoaded(id); setLoadedEpoch(e); return last.available && last.batch_available !== false ? r : null; }
    catch(err) { if(current(n,e,id)) fail(err); return null; }
    finally { if(alive.current && scope.current===id && generation.current===n) setReading(false); }
  }
  async function loadSources() {
    const result=await read(async o=>{
      if (!o.available || o.batch_available === false) return [];
      if (!props.selectedOrderIds.length) return [];
      if (props.selectedOrderIds.length>50 || props.selectedOrderIds.some(id=>!uuid(id)) || new Set(props.selectedOrderIds).size!==props.selectedOrderIds.length) throw Error('Wybierz od 1 do 50 własnych zamówień.');
      const all:Choice[]=[];
      for (const id of props.selectedOrderIds) {
        const order=await api<{id:string;number:string;version:string|number;shipments:{id:string;tracking_number:string;carrier:string}[]}>('/orders/'+id);
        const version=String(order.version);
        if (order.id!==id || !validPrintVersion(version) || (typeof order.version==='number' && !Number.isSafeInteger(order.version)) || !order.number || !Array.isArray(order.shipments) || order.shipments.length>1000 || new Set(order.shipments.map(s=>s.id)).size!==order.shipments.length) throw Error('Niepełny zakres przesyłek wybranego zamówienia.');
        if (!order.shipments.length) all.push({order_id:id,order_number:order.number,shipment_id:'',tracking_number:'',carrier:'',order_version:version,cache:null,reason:'Zamówienie nie ma przesyłki.',can_queue:false});
        for (const shipment of order.shipments) {
          if (!uuid(shipment.id) || all.length>=1000) throw Error('Zakres przesyłek przekracza pełny dostępny podgląd. Wybierz mniej zamówień.');
          const m=await api<Source>('/print-jobs/shipments/'+shipment.id+'/label-cache'); checkPrintJobFlags(m);
          if (m.available && (!m.can_read || m.current_role!==o.current_role || m.read_only!==o.read_only || m.can_write!==o.can_write)) throw Error('Dostęp do źródeł etykiet zmienił się.');
          const c=m.cache;
          if (c && (!uuid(c.id) || c.order_id!==id || c.shipment_id!==shipment.id || !['inpost','dpd'].includes(c.provider) || c.format!=='pdf' || !['A4','A6'].includes(c.layout) || !sha(c.content_sha256) || !sha(c.source_hash) || c.source_hash!==m.source_hash || !integer(c.content_bytes,1,2097152) || m.order_version!==version || !c.tracking_number)) throw Error('Cache nie odpowiada bieżącej własnej przesyłce.');
          all.push({order_id:id,order_number:order.number,shipment_id:shipment.id,tracking_number:shipment.tracking_number,carrier:shipment.carrier,order_version:version,cache:c,reason:m.unavailable_reason || (!c?'Brak zapisanego PDF. Pobierz istniejącą etykietę osobno w zamówieniu.':null),can_queue:m.available && m.can_queue && !!c});
        }
      }
      return all;
    });
    if(result) {setChoices(result);setSelected([]);invalidate();}
  }
  async function load(force=false) {
    await read(async()=>true,force);
  }
  async function loadHistory(kind:Head['kind'],next:string|null=null) {
    const r=await read(async()=>{
      const h=await api<PrintJobFlags & {data:Head[];next_cursor:string|null}>(prefix+'/history?'+new URLSearchParams({kind,limit:'50',...(next?{cursor:next}:{})})); checkPrintJobFlags(h);
      if(!h.can_read || !Array.isArray(h.data) || h.data.length>50 || (h.next_cursor!==null && (!uuid(h.next_cursor) || h.next_cursor===next || cursors.current.has(h.next_cursor))) || new Set(h.data.map(v=>v.id)).size!==h.data.length) throw Error('Niepełna strona historii partii.');
      h.data.forEach(v=>checkHead(v,kind)); return h;
    });
    if(r) { if(!next)cursors.current.clear();if(r.next_cursor)cursors.current.add(r.next_cursor);setHistoryKind(kind);setHistory(r.data);setCursor(r.next_cursor); }
  }
  async function detail(kind:Head['kind'],id:string) {
    const r=await read(async()=>{const v=await api<Reply>(prefix+(kind==='preview'?'/previews/':'/executions/')+id);checkPrintJobFlags(v);if(!v.can_read)throw new ApiError('Brak dostępu do szczegółów partii.',403);if(kind==='preview'){checkPreview(v.preview!);if(v.preview!.id!==id)throw Error('Podgląd pochodzi z innej partii.');}else{checkExecution(v.execution!);if(v.execution!.id!==id)throw Error('Wynik pochodzi z innej partii.');}return v;});
    if(r)consume(r);
  }
  function consume(r:Reply) {
    invalidate();
    if(r.preview) {setPreview(r.preview);setSuccess(r.preview.queued_execution_id?'Ta partia ma już trwały zapis kolejki.':'Podgląd partii zapisany. Odczytaj cały PDF i sprawdź mapę źródeł.');}
    if(r.execution) {setExecution(r.execution);setSuccess('Cała partia została zapisana w kolejce. Nie oznacza to wydruku na papierze.');}
  }
  async function validate(r:PrintJobWriteReply,a:PrintWriteAttempt) {
    const body=JSON.parse(a.body),reply=r as Reply;
    if(a.kind==='batch_preview') {
      checkPreview(reply.preview!);const p=reply.preview!;
      if(p.station_snapshot.id!==body.station_id || p.station_snapshot.version!==body.station_version || p.printer_snapshot.id!==body.printer_id || p.printer_snapshot.version!==body.printer_version || p.copies!==body.copies || p.rows.length!==body.shipments.length || p.rows.some((row,i)=>row.shipment_id!==body.shipments[i].shipment_id || row.order_version!==body.shipments[i].order_version || row.cache_asset_id!==body.shipments[i].asset_id)) throw Error('Podgląd nie odpowiada dokładnej zachowanej próbie.');
      const evidence=a.evidence as Choice[];
      if(!Array.isArray(evidence) || evidence.length!==p.rows.length || p.rows.some((row,i)=>row.order_id!==evidence[i].order_id || row.source_hash!==evidence[i].cache?.source_hash || row.content_sha256!==evidence[i].cache?.content_sha256 || row.content_bytes!==evidence[i].cache?.content_bytes || row.provider!==evidence[i].cache?.provider || row.mode!==evidence[i].cache?.mode || row.layout!==evidence[i].cache?.layout || row.tracking_number!==evidence[i].cache?.tracking_number)) throw Error('Podgląd zmienił wybrane źródłowe pliki.');
    } else {
      checkExecution(reply.execution!);const e=reply.execution!,p=a.evidence as Preview;checkPreview(p);
      if(a.path!==prefix+'/previews/'+p.id+'/queue' || e.preview_id!==p.id || e.scope_hash!==body.scope_hash || e.scope_hash!==p.scope_hash || !same(e.summary,p.summary) || e.rows.some((row,i)=>Object.entries(p.rows[i]).some(([k,v])=>row[k as keyof Row]!==v))) throw Error('Zapis kolejki nie odpowiada pełnemu zatwierdzonemu podglądowi.');
    }
  }
  async function write(a:PrintWriteAttempt,retry=false) {
    if(!canWrite || busy || (retry?ownPending!==a:blocked))return;
    setError('');setRetryConsent(false);
    const id=identity,n=++generation.current;
    try {
      const r=await performShipmentLabelPrintWrite({attempt:a,retry,readOnly:props.readOnly,access,validate});
      if(r && alive.current && scope.current===id && generation.current===n) {handled.current=r;consume(r as Reply);if(a.kind==='batch_queue')props.onChanged?.();}
    } catch(err) {
      if(alive.current && scope.current===id && generation.current===n) {
        if(err instanceof ApiError && err.status>=400 && err.status<500 && ![408,429].includes(err.status) && a.kind==='batch_queue' && !getPrintJobsMutationState(props.contextKey).pending) {const p=a.evidence as Preview;rejected.current.add(p.id);setConsent(false);setManifestConsent(false);setReady(null);}
        fail(err);
      }
    }
  }
  function prepare() {
    if(blocked || !integer(Number(copies),1,10) || !/^(?:[1-9]|10)$/.test(copies))return;
    const station=options?.stations.find(s=>s.id===stationId && s.enabled),printer=options?.printers.find(p=>p.id===printerId && p.station_id===stationId && p.enabled && p.format==='pdf');
    const rows=selected.map(id=>choices.find(c=>c.shipment_id===id));
    if(!station || !printer || !rows.length || rows.length>50 || rows.some(c=>!c?.cache || !c.can_queue) || new Set(rows.map(c=>c!.cache!.layout)).size!==1) {setError('Wybierz od 1 do 50 przesyłek z zapisanym PDF w jednym formacie A4 albo A6.');return;}
    invalidate();
    void write({context:props.contextKey,owner,kind:'batch_preview',path:prefix+'/previews',body:JSON.stringify({client_key:crypto.randomUUID(),station_id:station.id,station_version:station.version,printer_id:printer.id,printer_version:printer.version,copies:Number(copies),shipments:rows.map(c=>({shipment_id:c!.shipment_id,order_version:c!.order_version,asset_id:c!.cache!.id}))}),evidence:rows});
  }
  async function readPdf() {
    if(!preview || preview.queued_execution_id || !canWrite || busy || io.locked)return;
    const p=preview;setPdf(null);setReady(null);setConsent(false);
    const result=await read(async()=>{
      const r=await api<PrintJobFlags & {preview_id:string;format:string;content_base64:string;content_sha256:string;content_bytes:number;pages:number}>(prefix+'/previews/'+p.id+'/content');checkPrintJobFlags(r);
      if(!r.can_read || !r.can_write || r.read_only || r.preview_id!==p.id || r.format!=='pdf' || r.content_sha256!==p.combined_pdf.content_sha256 || r.content_bytes!==p.combined_pdf.content_bytes || r.pages!==p.combined_pdf.pages || typeof r.content_base64!=='string' || r.content_base64.length>22369624 || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.content_base64))throw Error('Niepełne bajty wspólnego PDF.');
      const data=Uint8Array.from(atob(r.content_base64),c=>c.charCodeAt(0));
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(b=>b.toString(16).padStart(2,'0')).join('');
      if(data.length!==r.content_bytes || hash!==r.content_sha256 || String.fromCharCode(...data.slice(0,5))!=='%PDF-')throw Error('Suma kontrolna wspólnego PDF nie jest zgodna.');
      return {previewId:p.id,hash,data,epoch:getPrintJobsMutationState(props.contextKey).epoch};
    });
    if(result)setPdf(result);
  }
  const completePdf=!!preview && !!pdf && pdf.previewId===preview.id && pdf.hash===preview.combined_pdf.content_sha256 && pdf.epoch===io.epoch && !!ready?.ready && ready.previewId===preview.id && ready.contentSha256===pdf.hash && ready.pageCount===preview.combined_pdf.pages && ready.viewedPages===ready.pageCount;
  const queueable=!!preview && !preview.queued_execution_id && preview.can_queue && !rejected.current.has(preview.id) && Date.parse(preview.expires_at)>Date.now() && completePdf && manifestConsent;
  function queue() {if(blocked || !preview || !queueable || !consent)return;void write({context:props.contextKey,owner,kind:'batch_queue',path:prefix+'/previews/'+preview.id+'/queue',body:JSON.stringify({client_key:crypto.randomUUID(),scope_hash:preview.scope_hash,confirmed:true}),evidence:preview});}
  useEffect(()=>{alive.current=true;resetPrintJobsContext(props.contextKey);const off=subscribePrintJobsLock(props.contextKey,()=>redraw(v=>v+1));return()=>{alive.current=false;generation.current++;off();};},[props.contextKey]);
  useEffect(()=>{generation.current++;purge();setReading(false);setLoaded('');setLoadedEpoch(-1);setError('');setSuccess('');setRetryConsent(false);handled.current=null;void load(true);},[identity]);
  useEffect(()=>{
    if(loadedEpoch!==io.epoch && loadedEpoch!==-1)purge();
    const value=io.outcome;
    if(visible && value?.attempt?.owner===owner && ['batch_preview','batch_queue'].includes(value.kind) && handled.current!==value.reply) {handled.current=value.reply;consume(value.reply as Reply);}
  },[visible,loadedEpoch,io.epoch,io.outcome,owner]);
  useEffect(()=>{const timer=window.setInterval(()=>redraw(v=>v+1),5000);return()=>window.clearInterval(timer);},[]);
  function configChange() {invalidate();setError('');}
  return <section className="panel shipment-label-batches">
    <div className="slb-heading"><div><h3>Zbiorcza kolejka etykiet</h3><p>Wybierz konkretne przesyłki z zapisanymi PDF. Przygotowanie partii nie pobiera etykiet ani nie nadaje paczek.</p></div><button className="button" disabled={busy} onClick={()=>void load()}>Odczytaj dostęp do partii</button></div>
    {error && <p className="error" role="alert">{error}</p>}{success && <p className="notice" role="status">{success}</p>}
    {!visible ? <p>Odczytaj aktualny dostęp do drukowania.</p> : !options?.available || options.batch_available===false ? <p>Ta kopia nie udostępnia zbiorczej kolejki etykiet.</p> : <>
      {(props.readOnly || options.read_only || !options.can_write) && <p>Tryb odczytu. Historia pozostaje dostępna.</p>}
      {io.locked && <p className="notice">Trwa zapis lub wynik zapisu drukowania jest nieznany. Świeże operacje są wstrzymane; odczyt historii nie ponawia zapisu.</p>}
      {props.externalWriteBlocked && !io.locked && <p>Nowe operacje są wstrzymane przez inną operację na zamówieniach.</p>}
      {ownPending && <div className="slb-pending"><p>Wynik zachowanej próby jest nieznany. Ponowienie wysyła dokładnie ten sam zakres i klucz.</p>
        {ownPending.kind==='batch_queue' ? <><BatchSummary value={(ownPending.evidence as Preview).summary}/><Manifest rows={(ownPending.evidence as Preview).rows}/></> : <><p>Zachowane przygotowanie podglądu · kopie każdej etykiety: {JSON.parse(ownPending.body).copies}</p><ul>{(ownPending.evidence as Choice[]).map(c=><li key={c.shipment_id}>{c.order_number} · {c.tracking_number} · PDF {c.cache?.layout}</li>)}</ul></>}
        <label className="slb-check"><input type="checkbox" checked={retryConsent} disabled={!canWrite || busy} onChange={e=>setRetryConsent(e.target.checked)}/>Potwierdzam ręczne ponowienie tej samej próby</label><button className="button" disabled={!canWrite || busy || !retryConsent} onClick={()=>void write(ownPending,true)}>Ponów dokładnie zachowaną próbę</button></div>}
      <fieldset disabled={blocked} className="slb-config"><legend>Jawny wybór przesyłek</legend><p>Wybrane zamówienia: {props.selectedOrderIds.length}. Wybór nie oznacza wyboru wszystkich ich paczek.</p><button className="button" onClick={()=>void loadSources()}>Odczytaj przesyłki wybranych zamówień</button>
        {!!choices.length && <div className="slb-table"><table><thead><tr><th>Wybór</th><th>Zamówienie / przesyłka</th><th>Zapisany plik</th><th>Dostępność</th></tr></thead><tbody>{choices.map((c,i)=><tr key={c.shipment_id || `${c.order_id}:none:${i}`}><td><input type="checkbox" aria-label={`Wybierz przesyłkę ${c.tracking_number} zamówienia ${c.order_number}`} disabled={!c.can_queue || !c.cache || (!selected.includes(c.shipment_id) && selected.length>=50)} checked={selected.includes(c.shipment_id)} onChange={e=>{setSelected(v=>e.target.checked?[...v,c.shipment_id]:v.filter(id=>id!==c.shipment_id));configChange();}}/></td><td>{c.order_number}<br/>{c.carrier} · {c.tracking_number || 'Brak przesyłki'}</td><td>{c.cache?`PDF ${c.cache.layout} · ${c.cache.content_bytes} B`:'Brak cache'}</td><td>{c.reason || 'Gotowe do wyboru'}{!c.cache && <button className="button small-btn" onClick={()=>props.onOpenOrder(c.order_id)}>Otwórz zamówienie i cache etykiety</button>}</td></tr>)}</tbody></table></div>}
        <div className="slb-grid"><label>Stanowisko<select value={stationId} onChange={e=>{setStationId(e.target.value);setPrinterId('');configChange();}}><option value="">Wybierz stanowisko</option>{options.stations.filter(s=>s.enabled).map(s=><option key={s.id} value={s.id}>{s.label} · {s.code}</option>)}</select></label><label>Drukarka PDF<select value={printerId} onChange={e=>{setPrinterId(e.target.value);configChange();}}><option value="">Wybierz drukarkę</option>{options.printers.filter(p=>p.enabled && p.format==='pdf' && p.station_id===stationId).map(p=><option key={p.id} value={p.id}>{p.name} · {p.output_mode==='file'?'Plik lokalny':'CUPS'}</option>)}</select></label><label>Kopie każdej etykiety<input value={copies} inputMode="numeric" onChange={e=>{setCopies(e.target.value);configChange();}}/></label></div>
        <p>Wybrane przesyłki: {selected.length}. Jedna partia wymaga jednego formatu A4 albo A6. Kolejność wyboru jest kolejnością podglądu; nie gwarantuje kolejności wyjścia drukarki.</p><button className="button primary" disabled={!selected.length || !stationId || !printerId} onClick={prepare}>Przygotuj pełny podgląd partii</button>
      </fieldset>
      {preview && <div className="slb-review"><h4>Trwały podgląd partii</h4><p>{date(preview.created_at)} · ważny do {date(preview.expires_at)} · {preview.printer_snapshot.name} · {preview.station_snapshot.label}</p><BatchSummary value={preview.summary}/><Manifest rows={preview.rows}/>
        {preview.queued_execution_id ? <button className="button" disabled={busy} onClick={()=>void detail('execution',preview.queued_execution_id!)}>Odczytaj zapis tej partii</button> : <>
          {rejected.current.has(preview.id) && <p className="error">Zapis tego podglądu został odrzucony. Odczytaj przesyłki i przygotuj nowy pełny podgląd.</p>}
          {Date.parse(preview.expires_at)<=Date.now() && <p>Podgląd wygasł. Przygotuj nowy podgląd przed świeżym zapisem.</p>}
          <button className="button" disabled={!canWrite || busy || io.locked} onClick={()=>void readPdf()}>Odczytaj cały wspólny PDF</button>
          {pdf?.previewId===preview.id && pdf.epoch===io.epoch && <PrintLabelPdfPreview contextKey={identity+':'+io.epoch} previewId={preview.id} contentSha256={pdf.hash} data={pdf.data} maxBytes={16777216} maxPages={500} onReady={r=>{if(scope.current!==identity || getPrintJobsMutationState(props.contextKey).epoch!==pdf.epoch || r.previewId!==pdf.previewId || r.contentSha256!==pdf.hash)return;setReady(r);if(!r.ready)setConsent(false);}}/>}
          <a href={`/api${prefix}/previews/${preview.id}/pdf?workspace_id=${encodeURIComponent(props.contextKey.split(':')[0])}`}>Pobierz sprawdzony PDF podglądu</a>
          <label className="slb-check"><input type="checkbox" checked={manifestConsent} disabled={blocked || !completePdf} onChange={e=>{setManifestConsent(e.target.checked);setConsent(false);}}/>Sprawdziłem wszystkie źródła, zakresy stron i kopie całej partii</label>
          <label className="slb-check"><input type="checkbox" checked={consent} disabled={blocked || !queueable} onChange={e=>setConsent(e.target.checked)}/>Potwierdzam zapis wszystkich zadań. Kolejka użyje oryginalnych PDF; wspólny PDF służy do przeglądu. Dodatkowa partia może oznaczać dodatkowe kopie.</label><button className="button primary" disabled={blocked || !queueable || !consent} onClick={queue}>Zapisz całą partię w kolejce</button>
        </>}
      </div>}
      {execution && <div className="slb-review"><h4>Zapisana partia · aktualne wyniki zadań</h4><BatchSummary value={execution.summary}/><p>Atomowy zapis kolejki obejmuje całą partię. Wykonawca obsługuje zadania oddzielnie; zapis pliku i przekazanie do CUPS nie potwierdzają papieru.</p><Manifest rows={execution.rows}/><div className="slb-table"><table><thead><tr><th>Pozycja</th><th>Zadanie</th><th>Wynik ostatniego odczytu</th></tr></thead><tbody>{execution.progress.map(p=><tr key={p.job_id}><td>{p.index+1}</td><td>{p.job_id}</td><td>{states[p.state]}</td></tr>)}</tbody></table></div><button className="button" disabled={busy} onClick={()=>void detail('execution',execution.id)}>Odczytaj aktualne wyniki partii</button></div>}
      <div className="slb-history"><h4>Historia partii</h4><div className="slb-actions"><button className="button" disabled={busy} onClick={()=>void loadHistory('preview')}>Odczytaj podglądy</button><button className="button" disabled={busy} onClick={()=>void loadHistory('execution')}>Odczytaj zapisane partie</button></div>{history.map(h=><div className="slb-history-row" key={h.id}><span>{date(h.created_at)} · {h.kind==='preview'?'Podgląd':'Zapis kolejki'} · przesyłki {h.summary.shipments} · kopie {h.summary.copies}</span><button className="button small-btn" disabled={busy} onClick={()=>void detail(h.kind,h.id)}>Odczytaj pełne szczegóły</button></div>)}{cursor && <button className="button" disabled={busy} onClick={()=>void loadHistory(historyKind,cursor)}>Następna strona historii</button>}</div>
    </>}
  </section>;
}
function BatchSummary({value:s}:{value:Summary}) {return <p>Przesyłki: {s.shipments} · zamówienia: {s.orders} · strony: {s.combined_pages} · kopie każdej etykiety: {s.copies} · zaplanowane kopie etykiet: {s.expected_label_copies}</p>;}
function Manifest({rows}:{rows:Row[]}) {return <div className="slb-table"><table><thead><tr><th>Pozycja</th><th>Zamówienie / tracking</th><th>Źródłowy PDF</th><th>Strony podglądu</th><th>Suma kontrolna źródła</th></tr></thead><tbody>{rows.map(r=><tr key={r.shipment_id}><td>{r.index+1}</td><td>{r.order_number}<br/>{r.provider} · {r.mode}<br/>{r.tracking_number}</td><td>{r.layout} · {r.content_bytes} B · {r.pages} stron</td><td>{r.page_from}–{r.page_to}</td><td><code>{r.content_sha256}</code></td></tr>)}</tbody></table></div>;}
