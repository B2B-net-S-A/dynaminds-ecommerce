import { useEffect, useRef, useState } from 'react';
import { api, money, date } from './api';
import {importActor,importCustodyKey,readImportReceipts,saveImportReceipt,assertOriginalImportOrder,reconcileImportReceipt,type ImportReceipt} from './ordinary-import-custody';
import {captureImportRollbackRefusal,latestImportRefusals,type ImportRefusal} from './ordinary-import-refusal';
import { ArrowDownToLine, Link, RefreshCw, Check, AlertCircle } from 'lucide-react';
import { B2bExternalOrderImport, hasExternalImportAttempt, resetExternalImportContext } from './b2b-external-order-imports';
export function ImportQueue({
  channelId,
  onImported,
  contextKey,
  readOnly,
}: {
  channelId: string;
  onImported: (number: string) => void;
  contextKey: string;
  readOnly: boolean;
}) {
  const identity=contextKey+':'+readOnly+':'+channelId;
  const latest=useRef(identity),epoch=useRef(0),alive=useRef(false),flight=useRef(false);
  latest.current=identity;
  useEffect(()=>{alive.current=true;++epoch.current;return()=>{alive.current=false;++epoch.current;};},[identity]);
  const [dataIdentity,setDataIdentity]=useState('');
  const [refusals,setRefusals]=useState<Record<string,ImportRefusal>>({}),[reviewedRefusals,setReviewedRefusals]=useState<Record<string,{sequence:number;source_hash:string;warehouse_id:string}>>({});
  const [receipts,setReceipts]=useState<Record<string,ImportReceipt>>({}),[custodyError,setCustodyError]=useState('');
  useEffect(()=>{setReceipts({});setRefusals({});setReviewedRefusals({});setCustodyError('');try{setReceipts(readImportReceipts(contextKey,channelId));setRefusals(latestImportRefusals(contextKey,channelId));}catch(e){setCustodyError((e as Error).message);}},[identity]);
  const [miraklStart,setMiraklStart]=useState(''),[miraklEnd,setMiraklEnd]=useState(''),[miraklMax,setMiraklMax]=useState('50'),[miraklOffset,setMiraklOffset]=useState('0'),[miraklUncertain,setMiraklUncertain]=useState(false);
  const [externalInbound, setExternalInbound] = useState<string | null>(null);
  useEffect(() => {
    resetExternalImportContext(contextKey, readOnly);
    setExternalInbound(null);
  }, [contextKey, readOnly, channelId]);
  const [data, setData] = useState<any>(null),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [warehouse, setWarehouse] = useState('');
  const [revision, setRevision] = useState(0),
    [page, setPage] = useState(1),
    [sourcePage, setSourcePage] = useState(1),
    [sourceCursor, setSourceCursor] = useState<string | null>(null),
    [sourceDone, setSourceDone] = useState(false);
  useEffect(() => {
    setMiraklStart('');setMiraklEnd('');setMiraklMax('50');setMiraklOffset('0');setMiraklUncertain(false);
    setSourceCursor(null);
    setSourceDone(false);
    setSourcePage(1);
    setPage(1);
    setData(null);
    setDataIdentity('');
    setWarehouses([]);
    setWarehouse('');
    setSkus({});
    setError('');
    setMessage('');
    setBusy('');
  }, [identity]);
  const [skus, setSkus] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([api(`/integrations/${channelId}/imports?page=${page}`), api('/warehouses')])
      .then(([queue, stock]) => {
        if (!active) return;
        if(queue.channel?.id!==channelId||!Array.isArray(queue.data)||!Array.isArray(queue.mappings)||!Array.isArray(stock.data))throw Error('Odczytano inny kanał lub niepełne magazyny. Odśwież kolejkę.');
        setData(queue);
        setDataIdentity(identity);
        setWarehouses(stock.data);
        setWarehouse((w) => stock.data.some((row:any)=>row.id===w)?w:stock.data[0]?.id||'');
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [identity, revision, page]);
  async function act(key: string, fn: (current:()=>boolean) => Promise<void>, allowReadOnly=false) {
    if (readOnly&&!allowReadOnly || busy || flight.current || !alive.current || latest.current!==identity) return;
    const generation=epoch.current,current=()=>alive.current&&latest.current===identity&&epoch.current===generation;
    flight.current=true;
    setBusy(key);
    setError('');
    setMessage('');
    try {
      await fn(current);
    } catch (e) {
      if(current())setError((e as Error).message);
    } finally {
      flight.current=false;
      if(current()){setBusy('');setRevision((r)=>r+1);}
    }
  }
  async function custodyLock<T,>(work:()=>Promise<T>){if(!navigator.locks?.request)throw Error('Brak bezpiecznej blokady kart. Import zapisu jest niedostępny.');return navigator.locks.request(importCustodyKey(contextKey,channelId),{mode:'exclusive'},work);}
  async function sameImportActor(current:()=>boolean){if(!current())throw Error('Widok importu zmienił się.');const me=await api('/auth/me'),a=importActor(contextKey);if(!current()||me.restore_preview!==false||(Object.hasOwn(me,'read_only')&&me.read_only!==false)||me.user?.tenant_id!==a.tenant_id||me.user?.id!==a.user_id||me.user?.role!=='admin')throw Error('Wymagana aktualna sesja administratora tej firmy.');}
  async function stageMirakl(current:()=>boolean){
    const iso=(v:string)=>{if(!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(v)||!Number.isFinite(Date.parse(v)))return false;const day=new Date(v.slice(0,10)+'T00:00:00Z');return day.toISOString().slice(0,10)===v.slice(0,10);};
    const span=Date.parse(miraklEnd)-Date.parse(miraklStart);
    if(!iso(miraklStart)||!iso(miraklEnd)||!(span>0&&span<=31*86400000)||!/^(?:[1-9]|[1-9]\d|100)$/.test(miraklMax)||!/^(?:0|[1-9]\d{0,3}|10000)$/.test(miraklOffset))throw Error('Podaj daty ISO ze strefą czasu, zakres do 31 dni, limit od 1 do 100 i pozycję od 0 do 10000.');
    await sameImportActor(current);const health=await api('/health');if(!current())return;
    if(health.mirakl_reads_available!==true)throw Error('Pobieranie Mirakl jest niedostępne w tym uruchomieniu.');
    let sent=false;
    try{
      sent=true;
      const r=await api(`/integrations/${channelId}/mirakl/orders-stage`,'POST',{start_update_date:miraklStart,end_update_date:miraklEnd,max:Number(miraklMax),offset:Number(miraklOffset)});
      await sameImportActor(current);if(!current())return;
      if(!r||r.channel_id!==channelId||r.scope!=='external_read_local_stage'||r.stages_orders!==true||r.imports_orders!==false||!Array.isArray(r.data)||r.data.length>Number(miraklMax)||r.offset!==Number(miraklOffset)||!Number.isSafeInteger(r.total_count)||r.total_count<0||r.total_count>1000000||typeof r.has_more!=='boolean'||r.offset+r.data.length>r.total_count||r.has_more!==(r.offset+r.data.length<r.total_count)||(r.has_more&&r.data.length===0)||new Set(r.data.map((row:any)=>row?.id)).size!==r.data.length||r.data.some((row:any)=>!row||typeof row.id!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(row.id)||!['staged','error','imported'].includes(row.state)||!/^[a-f0-9]{64}$/.test(row.source_hash??'')))throw Error('Nie potwierdzono odpowiedzi pobierania.');
      setMessage(`Zapisano do przeglądu ${r.data.length} zamówień z pozycji ${r.offset}. ${r.has_more?'Są dalsze pozycje; podaj kolejną pozycję i pobierz ją świadomie.':'Koniec wyników.'}`);
    }catch(e){if(sent){if(current())setMiraklUncertain(true);throw Error('Wynik pobierania Mirakl nie jest potwierdzony. Odśwież kolejkę i sprawdź dane przed kolejną ręczną próbą. Import nie jest wykonywany automatycznie.');}throw e;}
  }
  async function recoverImport(r:ImportReceipt,current:()=>boolean){
    await sameImportActor(current);
    const queue=await api(`/imports/${r.inbound_id}`);if(!current())throw Error('Widok importu zmienił się.');
    if(queue.channel?.id!==r.channel_id||!queue.data||Array.isArray(queue.data))throw Error('Odczytano inny kanał importu.');
    const row=queue.data;if(row.id!==r.inbound_id||!row.order_id)throw Error('Oryginalny import nie jest potwierdzony w odczycie. Próba pozostaje zablokowana.');
    const order=await api(`/orders/${row.order_id}`);await sameImportActor(current);
    const confirmed=reconcileImportReceipt(r,row,order);saveImportReceipt(contextKey,channelId,confirmed);if(current()){setReceipts(readImportReceipts(contextKey,channelId));setMessage(`Potwierdzono oryginalny import ${order.number}.`);}return order;
  }
  async function reviewRefusedImport(inbound:string,current:()=>boolean){await custodyLock(async()=>{
    await sameImportActor(current);const refusal=latestImportRefusals(contextKey,channelId)[inbound];if(!refusal||readImportReceipts(contextKey,channelId)[inbound])throw Error('Zachowano nieuzgodnioną próbę. Odczytaj jej oryginalny wynik.');
    const original=await api(`/imports/${inbound}`);await sameImportActor(current);const row=original.data;
    if(original.channel?.id!==channelId||original.channel.provider!==refusal.disposition.provider||!row||Array.isArray(row)||row.id!==inbound||String(row.external_id)!==refusal.original.external_id||!/^[a-f0-9]{64}$/.test(row.source_hash??'')||row.source_changed!==false||row.order_id!==null||row.state==='imported'||!warehouses.some(w=>w.id===warehouse))throw Error('Źródło jest zmienione lub zaimportowane. Ponownie przejrzyj kolejkę; nie wysyłaj tej próby.');
    if(current()){setData((old:any)=>({...old,data:old.data.map((r:any)=>r.id===inbound?row:r)}));setRefusals(latestImportRefusals(contextKey,channelId));setReviewedRefusals(old=>({...old,[inbound]:{sequence:refusal.sequence,source_hash:row.source_hash,warehouse_id:warehouse}}));setMessage('Odczytano aktualne źródło po potwierdzonej odmowie. Przejrzyj dane i powiązania, a następnie świadomie wybierz Importuj.');}
  });}
  async function commitOriginal(r:any,current:()=>boolean){await custodyLock(async()=>{
    await sameImportActor(current);if(hasExternalImportAttempt(contextKey,readOnly,r.id))throw Error('Zachowano próbę importu z podziałem realizacji. Odczytaj jej oryginalny wynik.');const existing=readImportReceipts(contextKey,channelId);if(existing[r.id])throw Error('Zachowano oryginalną próbę. Użyj tylko odczytu jej wyniku.');
    const refusal=latestImportRefusals(contextKey,channelId)[r.id],reviewed=reviewedRefusals[r.id];if(refusal&&(!reviewed||reviewed.sequence!==refusal.sequence||reviewed.source_hash!==r.source_hash||reviewed.warehouse_id!==warehouse))throw Error('Najpierw odczytaj i przejrzyj oryginalne źródło po odmowie.');
    const original=await api(`/imports/${r.id}`);await sameImportActor(current);const row=original.data;if(original.channel?.id!==channelId||!row||Array.isArray(row)||row.id!==r.id||String(row.external_id)!==String(r.external_id)||row.source_hash!==r.source_hash||row.source_changed!==false||row.order_id!==null||row.state==='imported')throw Error('Źródło zmieniło się lub jest już zaimportowane. Odczytaj jego oryginalny wynik.');
    const a=importActor(contextKey);let sent:ImportReceipt={v:1,...a,original_context:contextKey,channel_id:channelId,inbound_id:r.id,source_hash:r.source_hash,warehouse_id:warehouse,external_id:String(r.external_id),page,phase:'sent'};
    saveImportReceipt(contextKey,channelId,sent);if(current())setReceipts(readImportReceipts(contextKey,channelId));
    try{const order=await api(`/imports/${r.id}/commit`,'POST',{warehouse_id:sent.warehouse_id,expected_hash:sent.source_hash},{},undefined,(received,response)=>{if(!response.ok){captureImportRollbackRefusal(contextKey,channelId,sent,original.channel.provider,received,response);return;}if(response.workspace!==sent.tenant_id)throw Error('Odpowiedź nie należy do oryginalnej firmy importu.');assertOriginalImportOrder(sent,received);sent={...sent,ack_order_id:(received as {id:string}).id};saveImportReceipt(contextKey,channelId,sent);});await sameImportActor(current);await recoverImport(sent,current);if(current())onImported(order.number);}
    catch(first){try{const stored=readImportReceipts(contextKey,channelId)[r.id];if(current()&&stored&&stored.phase!=='confirmed'){saveImportReceipt(contextKey,channelId,{...stored,phase:'unknown'});}if(current()){setReceipts(readImportReceipts(contextKey,channelId));setRefusals(latestImportRefusals(contextKey,channelId));setReviewedRefusals({});}}catch{if(current())setCustodyError('Nie można potwierdzić zapisu oryginalnej próby lub odmowy. Zapis jest zablokowany.');}throw first;}
  });}
  async function openSplitImport(inbound:string,current:()=>boolean){await custodyLock(async()=>{if(!current())throw Error('Widok importu zmienił się.');const original=readImportReceipts(contextKey,channelId)[inbound];if(original&&original.phase!=='confirmed'){if(current())setReceipts(readImportReceipts(contextKey,channelId));throw Error('Zachowano nieuzgodnioną zwykłą próbę. Odczytaj jej oryginalny wynik.');}if(current())setExternalInbound(inbound);});}
  if (externalInbound && dataIdentity===identity && data?.channel?.provider!=='mirakl') return <B2bExternalOrderImport
    inboundId={externalInbound} contextKey={contextKey} readOnly={readOnly} warehouseId={warehouse}
    onClose={() => { setExternalInbound(null); setRevision(r => r + 1); }}
    onImported={order => { onImported(order.number); setRevision(r => r + 1); }}
  />;
  if (!data || dataIdentity!==identity) return <div className="info-body">{error || 'Wczytywanie kolejki importu…'}</div>;
  const rows = data.data.slice(0, 50);
  const offers = [
    ...new Map<string, any>(
      rows.flatMap((o: any) => (o.normalized?.items ?? []).map((i: any) => [i.external_id, i])),
    ).values(),
  ];
  return (
    <div className="import-workspace">
      <div className="notice">
        <ArrowDownToLine size={22} />
        <span>
          {data.channel.simulation
            ? `Lokalny przykład ${data.channel.provider === 'amazon' ? 'Amazon' : data.channel.provider === 'ebay' ? 'eBay' : data.channel.provider === 'odoo' ? 'Odoo' : data.channel.provider === 'shopify' ? 'Shopify' : data.channel.provider === 'prestashop' ? 'PrestaShop' : data.channel.provider === 'allegro' ? 'Allegro' : 'WooCommerce'} — dane syntetyczne. Nie korzysta z API dostawcy.`
            : 'Pobieranie odczytuje API kanału. Import tworzy zamówienie i rezerwacje wyłącznie w lokalnej bazie.'}
        </span>
      </div>
      {data.channel.provider === 'amazon' && (
        <p className="notice">
          Mapuj SKU sprzedawcy Amazon. Import FBM zachowuje kwoty źródła i ponownie sprawdza
          zamówienie przed rezerwacją. Gotowość do wysyłki nie potwierdza wpłaty — uzgodnij płatność
          osobno. Brak email jest zachowany; dostęp do adresu wymaga zgody Amazon. FBA i anulowania
          wymagają osobnego procesu.
        </p>
      )}
      {data.channel.provider === 'ebay' && (
        <p className="notice">
          Mapuj SKU sprzedawcy eBay na lokalny produkt. Import zachowuje kwoty brutto kupującego;
          VAT pochodzi z lokalnego katalogu. Przed rezerwacją ponownie sprawdzamy źródło. Brak
          email, anulowania i złożone rozliczenia wymagają uzgodnienia.
        </p>
      )}
      {data.channel.provider === 'odoo' && (
        <p className="notice">
          Kwoty pochodzą z zamówienia ERP. Wpłaty obejmują tylko zakończone transakcje powiązane z
          jednym zamówieniem; autoryzacja nie jest wpłatą. Przy połączeniu z dostawcą przed importem
          ponownie sprawdzamy dane ERP. Powiązania produktów wykorzystują ID wariantów Odoo.
        </p>
      )}
      {data.channel.provider === 'shopify' && (
        <p className="notice">
          Przy połączeniu ze sklepem przed importem ponownie sprawdzamy dane w Shopify. Zmiana
          danych wymaga odświeżenia podglądu i ponownego zatwierdzenia. Starszy odczyt nie cofa
          danych; aktualizacja źródła nie zmienia automatycznie zamówienia już zaimportowanego.
        </p>
      )}
      {data.channel.provider==='mirakl'&&<p className="notice">Wybierz ograniczony zakres dat ostatniej zmiany. Pobranie zapisuje podgląd w lokalnej kolejce; zamówienie i rezerwacja powstają dopiero po sprawdzeniu danych, powiązaniu SKU i wybraniu Importuj. Nie uruchamia zdalnej realizacji.</p>}
      <div className="import-toolbar">
        <label>
          Magazyn importu
          <select value={warehouse} disabled={Boolean(busy) || readOnly} onChange={(e) => setWarehouse(e.target.value)}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        {data.channel.simulation && data.channel.provider === 'odoo' && (
          <button
            className="button primary"
            disabled={Boolean(busy) || readOnly}
            onClick={() =>
              act('example', async (current) => {
                await api(`/integrations/${channelId}/odoo-order-example`, 'POST', {});
                if(!current())return;
                setMessage('Dodano syntetyczne zamówienie Odoo do przeglądu.');
              })
            }
          >
            Dodaj zamówienie DEMO Odoo
          </button>
        )}
        {data.channel.provider==='mirakl'&&!data.channel.simulation&&<fieldset disabled={Boolean(busy)||readOnly||contextKey.split(':')[2]!=='admin'}><legend>Pobieranie zamówień Mirakl</legend>
          <label>Od (ISO ze strefą)<input aria-label="Mirakl zamówienia od" value={miraklStart} placeholder="2026-10-01T00:00:00Z" onChange={e=>{setMiraklStart(e.target.value);setMessage('');setError('');}}/></label>
          <label>Do (ISO ze strefą)<input aria-label="Mirakl zamówienia do" value={miraklEnd} placeholder="2026-10-02T00:00:00Z" onChange={e=>{setMiraklEnd(e.target.value);setMessage('');setError('');}}/></label>
          <label>Limit<input aria-label="Mirakl limit" inputMode="numeric" value={miraklMax} onChange={e=>{setMiraklMax(e.target.value);setMessage('');setError('');}}/></label>
          <label>Pozycja początkowa<input aria-label="Mirakl pozycja" inputMode="numeric" value={miraklOffset} onChange={e=>{setMiraklOffset(e.target.value);setMessage('');setError('');}}/></label>
          {miraklUncertain&&<p className="notice">Wynik ostatniego pobrania pozostaje niepewny. Wybierz Odśwież kolejkę Mirakl i sprawdź dane przed kolejnym pobraniem.</p>}
          <button type="button" className="button primary" disabled={miraklUncertain} onClick={()=>void act('mirakl-stage',stageMirakl)}>Pobierz Mirakl do kolejki</button>
          <button type="button" className="button" onClick={()=>void act('mirakl-review',async current=>{const queue=await api(`/integrations/${channelId}/imports?page=${page}`);if(!current())return;if(queue.channel?.id!==channelId||queue.channel.provider!=='mirakl'||!Array.isArray(queue.data)||!Array.isArray(queue.mappings))throw Error('Nie potwierdzono kolejki Mirakl.');setData(queue);setDataIdentity(identity);setMiraklUncertain(false);setMessage('Odczytano aktualną kolejkę. Sprawdź zamówienia i powiązania przed kolejnym pobraniem lub importem.');})}>Odśwież kolejkę Mirakl</button>
        </fieldset>}
        {!data.channel.simulation && data.channel.provider!=='mirakl' && (
          <>
            {!['shopify', 'odoo', 'ebay', 'amazon'].includes(data.channel.provider) && (
              <label>
                Strona API
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={sourcePage}
                  onChange={(e) => setSourcePage(Number(e.target.value))}
                />
              </label>
            )}
            <button
              className="button primary"
              disabled={
                Boolean(busy) || readOnly ||
                (['shopify', 'odoo', 'ebay', 'amazon'].includes(data.channel.provider) &&
                  sourceDone)
              }
              onClick={() =>
                act('fetch', async (current) => {
                  const r = await api(`/integrations/${channelId}/fetch-orders`, 'POST', {
                    page: sourcePage,
                    ...(['shopify', 'odoo', 'ebay', 'amazon'].includes(data.channel.provider) &&
                    sourceCursor
                      ? { cursor: sourceCursor }
                      : {}),
                  });
                  if(!current())return;
                  setMessage(
                    `Pobrano ${r.data.length} zamówień ze strony ${r.page}. ${r.has_more ? 'Dostępna kolejna strona.' : 'Koniec wyników.'}`,
                  );
                  if (['shopify', 'odoo', 'ebay', 'amazon'].includes(data.channel.provider)) {
                    setSourceCursor(r.next_cursor ?? null);
                    setSourceDone(!r.has_more);
                  }
                  if (r.has_more) setSourcePage((p) => p + 1);
                })
              }
            >
              <RefreshCw size={16} />
              Pobierz zamówienia
            </button>
            {['shopify', 'odoo', 'ebay', 'amazon'].includes(data.channel.provider) && (
              <button
                className="button small-btn"
                disabled={Boolean(busy)}
                onClick={() => {
                  setSourceCursor(null);
                  setSourcePage(1);
                  setSourceDone(false);
                }}
              >
                Od początku
              </button>
            )}
          </>
        )}
      </div>
      {custodyError&&<p role="alert" className="notice import-error">{custodyError} Zapis importu jest zablokowany.</p>}
      {Object.values(receipts).map(r=><div className="notice" key={r.inbound_id}><span>Import źródłowy #{r.external_id}: {r.phase==='confirmed'?'Potwierdzono':'Wynik niepewny — nie ponawiaj'}.</span><details><summary>Szczegóły oryginalnej próby</summary><p>Magazyn {r.warehouse_id} · źródło {r.inbound_id} · hash {r.source_hash} · zamówienie {r.ack_order_id??'brak potwierdzonego ID'}</p></details><button type="button" className="button" disabled={Boolean(busy)||!data||dataIdentity!==identity} onClick={()=>void act(`recover:${r.inbound_id}`,current=>custodyLock(async()=>{const saved=readImportReceipts(contextKey,channelId)[r.inbound_id];if(!saved)throw Error('Brak zachowanej oryginalnej próby.');await recoverImport(saved,current);}))}>Odczytaj oryginalny import #{r.external_id}</button></div>)}
      {Object.values(refusals).map(r=><div className="notice" key={r.sequence}><span>Import źródłowy #{r.original.external_id}: potwierdzono odmowę przed zatwierdzeniem zamówienia. Przed kolejnym zatwierdzeniem odczytaj źródło i sprawdź dane.</span><details><summary>Szczegóły zachowanej odmowy</summary><p>Oryginalne źródło {r.original.inbound_id} · magazyn {r.original.warehouse_id} · hash {r.original.source_hash} · odczyt {r.request_id}. {r.disposition.issues_update==='committed'?'Zapisano uwagi walidacji w źródle.':'Odmowa nie wymagała zapisu uwag.'}</p></details><button type="button" className="button" disabled={Boolean(busy)||readOnly||Boolean(custodyError)||Boolean(receipts[r.original.inbound_id])} onClick={()=>void act(`review-refusal:${r.original.inbound_id}`,current=>reviewRefusedImport(r.original.inbound_id,current))}>Przejrzyj źródło po odmowie #{r.original.external_id}</button></div>)}
      {error && (
        <div role="alert" className="notice import-error">
          <AlertCircle size={20} />
          {error}
        </div>
      )}
      {message && (
        <div role="status" className="notice">
          <Check size={20} />
          {message}
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Powiązania ofert</h2>
            <p>Wpisz SKU produktu z własnego katalogu. Identyfikator oferty pochodzi z kanału.</p>
          </div>
          <Link size={20} />
        </div>
        {!offers.length ? (
          <p className="info-body">Pobierz zamówienia, aby zobaczyć wymagane powiązania.</p>
        ) : (
          offers.map((i) => {
            const mapping = data.mappings.find((m: any) => m.external_id === i.external_id);
            return (
              <form
                className="mapping-row"
                key={i.external_id}
                onSubmit={(e) => {
                  e.preventDefault();
                  act(`map:${i.external_id}`, async (current) => {
                    await api(`/integrations/${channelId}/mappings`, 'POST', {
                      external_id: i.external_id,
                      sku: skus[i.external_id] ?? mapping?.sku ?? '',
                    });
                    if(!current())return;
                    setMessage(`Zapisano powiązanie oferty ${i.external_id}.`);
                  });
                }}
              >
                <div>
                  <strong>{i.name}</strong>
                  <small>
                    Oferta {i.external_id} · SKU źródłowe: {i.sku || 'brak'}
                  </small>
                </div>
                <label>
                  SKU lokalne
                  <input
                    aria-label={`SKU lokalne oferty ${i.external_id}`}
                    value={skus[i.external_id] ?? mapping?.sku ?? ''}
                    placeholder="np. UI-QA-20261003"
                    onChange={(e) => setSkus((s) => ({ ...s, [i.external_id]: e.target.value }))}
                    required
                    disabled={Boolean(busy) || readOnly}
                  />
                </label>
                <button
                  className="button small-btn"
                  disabled={Boolean(busy) || readOnly}
                  aria-label={`Powiąż ofertę ${i.external_id}`}
                >
                  {mapping ? 'Zmień powiązanie' : 'Powiąż produkt'}
                </button>
              </form>
            );
          })
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Zamówienia do przeglądu</h2>
            <p>Zatwierdź sprawdzony podgląd. Po niepewnym wyniku odczytaj oryginalną próbę bez ponawiania.</p>
          </div>
          <span className="source-label">Strona {page}</span>
        </div>
        {!rows.length && <p className="info-body">Kolejka jest pusta.</p>}
        {rows.map((r: any) => (
          <article className="inbound-order" key={r.id}>
            <div className="inbound-header">
              <div>
                <strong>
                  #{r.external_id} · {r.normalized?.customer_name ?? 'Błąd danych źródłowych'}
                </strong>
                <small>
                  {date(r.updated_at)} · {r.normalized?.source_status ?? 'Nieprawidłowy format'}
                </small>
              </div>
              <strong>{r.normalized && money(r.normalized.total, r.normalized.currency)}</strong>
            </div>
            {r.normalized?.items.map((i: any, index: number) => (
              <div className="inbound-item" key={index}>
                <span>
                  {i.quantity} × {i.name}
                </span>
                <span>{money(i.line_total, r.normalized.currency)}</span>
              </div>
            ))}
            {r.normalized && (
              <p className="muted">
                Dostawa {money(r.normalized.shipping_cost, r.normalized.currency)} ·{' '}
                {r.normalized.paid
                  ? 'Płatność potwierdzona w źródle'
                  : 'Bez potwierdzenia płatności'}{' '}
                · Stawki VAT z lokalnego katalogu
              </p>
            )}
            {r.source_changed && (
              <p className="import-error">
                Dane źródłowe zmieniły się po imporcie. Wymagane ręczne uzgodnienie.
              </p>
            )}
            {r.issues.length > 0 && (
              <ul className="import-issues">
                {r.issues.map((issue: string, index: number) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            )}
            {!r.order_id&&!/^[a-f0-9]{64}$/.test(r.source_hash??'')&&<p className="import-error">Brak potwierdzonego podglądu źródła. Odczytaj ponownie kolejkę przed importem.</p>}
            <div className="inbound-actions">
              {data.channel.provider === 'shopify' && (
                <button
                  className="button"
                  disabled={Boolean(busy) || readOnly}
                  aria-label={`Odśwież zamówienie Shopify ${r.external_id}`}
                  onClick={() =>
                    act(`refresh:${r.id}`, async (current) => {
                      const refreshed = await api(
                        `/integrations/${channelId}/fetch-order`,
                        'POST',
                        { external_id: r.external_id },
                      );
                      if(!current())return;
                      setMessage(
                        refreshed.scope === 'local_simulation'
                          ? 'Sprawdzono lokalny przykład Shopify. Nie korzysta z API dostawcy.'
                          : refreshed.data[0]?.observation === 'older_ignored'
                            ? 'Shopify zwrócił starsze dane. Zachowano nowszy podgląd.'
                            : 'Sprawdzono aktualne zamówienie Shopify. Przejrzyj dane przed importem.',
                      );
                    })
                  }
                >
                  <RefreshCw size={16} /> Odśwież źródło
                </button>
              )}
              {r.order_id && (!receipts[r.id]||receipts[r.id].phase==='confirmed') ? (
                <span className="source-label">
                  <Check size={15} />
                  Zaimportowano do lokalnej bazy
                </span>
              ) : (
                <button
                  className="button primary"
                  disabled={
                    Boolean(busy) || readOnly || Boolean(custodyError) || Boolean(receipts[r.id]) || Boolean(refusals[r.id]&&(!reviewedRefusals[r.id]||reviewedRefusals[r.id].sequence!==refusals[r.id].sequence||reviewedRefusals[r.id].source_hash!==r.source_hash||reviewedRefusals[r.id].warehouse_id!==warehouse)) || hasExternalImportAttempt(contextKey, readOnly, r.id) || !warehouses.some(w=>w.id===warehouse) || !/^[a-f0-9]{64}$/.test(r.source_hash??'') || !r.normalized || r.normalized.blockers.length > 0
                  }
                  onClick={() =>
                    act(`import:${r.id}`, async (current) => {
                      if(!/^[a-f0-9]{64}$/.test(r.source_hash??'')||!warehouses.some(w=>w.id===warehouse))throw Error('Odczytaj aktualne źródło i wybierz własny magazyn przed importem.');
                      await commitOriginal(r,current);
                    })
                  }
                >
                  <ArrowDownToLine size={16} />
                  Importuj #{r.external_id}
                </button>
              )}
              {data.channel.provider!=='mirakl'&&<button type="button" className="button"
                disabled={Boolean(busy) || Boolean(custodyError) || Boolean(receipts[r.id]&&receipts[r.id].phase!=='confirmed') || !r.normalized}
                onClick={()=>void act(`split:${r.id}`,current=>openSplitImport(r.id,current),true)}>
                {hasExternalImportAttempt(contextKey, readOnly, r.id) ? 'Odzyskaj wynik importu z intencją' : r.order_id ? 'Podział realizacji i historia' : 'Import z podziałem realizacji'}
              </button>}
            </div>
          </article>
        ))}
        <div className="table-footer inline-actions">
          <button
            className="button small-btn"
            disabled={page === 1 || Boolean(busy)}
            onClick={() => setPage((p) => p - 1)}
          >
            Poprzednia strona
          </button>
          <button
            className="button small-btn"
            disabled={data.data.length <= 50 || Boolean(busy)}
            onClick={() => setPage((p) => p + 1)}
          >
            Następna strona
          </button>
        </div>
      </section>
    </div>
  );
}
