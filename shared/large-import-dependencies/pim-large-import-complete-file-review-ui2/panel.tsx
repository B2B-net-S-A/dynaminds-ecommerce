import React,{useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode}from'react';
import{largeImportCustody}from'../pim-large-import-job-flow-ui2/model';
import{Controller,custody,canApprove,completeReviewLocked,type Latest,type State,type NativeBatch,type Command}from'./model';
export type Props=Latest&{fileLabel:string;renderNativeRow?:(row:NativeBatch['preview']['pages'][number]['rows'][number])=>ReactNode};
/** Proposed producer absent => unavailable; no action or native write on mount. */
export function CompleteFileReviewPanel(props:Props){
 const latest=useRef(props);latest.current=props;const k=JSON.stringify([props.context.tenantId,props.context.userId,props.context.apiKeyId,props.jobId]),c=useMemo(()=>new Controller(()=>latest.current),[k]);
 const v=useSyncExternalStore(f=>c.subscribe(f),c.snapshot,c.snapshot),pending=useSyncExternalStore(custody.subscribe,()=>custody.get(props.context),()=>undefined),[consent,setConsent]=useState(false),[batchConsent,setBatchConsent]=useState(false),[batch,setBatch]=useState(0);
 useEffect(()=>{c.activate();void c.refresh();return()=>c.deactivate();},[c]);
 const legacyPending=useSyncExternalStore(largeImportCustody.subscribe,()=>largeImportCustody.get(props.context),()=>undefined);
 const s=v.state,scope=s?.scope,b=scope?.batches[batch],blocked=!props.ports||!props.canManage||props.externalWriteBlocked||v.busy||completeReviewLocked(props.context)||!!legacyPending;
 useEffect(()=>{setConsent(false);setBatchConsent(false);setBatch(0);},[k,scope?.aggregate_scope_hash]);
 useEffect(()=>setBatchConsent(false),[batch,b?.preview_id,b?.scope_hash]);
 const send=(cmd:Command)=>void c.send(cmd),committed=s?.job.core.filter(x=>x.execution).length??0;
 return <section className="card"><h2>Przegląd całego pliku przed zapisem produktów</h2><p>{props.fileLabel}</p>
  <p>Utworzenie natywnych podglądów zapisuje historię podglądów. Produkty nie są przez to zapisywane. Pełna zgoda nie gwarantuje atomowego zapisu wszystkich partii; każda partia nadal podlega aktualnym uprawnieniom, CAS i limitom. Parametry PIM mają własną późniejszą ważność podglądu.</p>
  {!props.ports&&<p role="status">Producent pełnego planu nie jest podłączony. Obecny import sekwencyjny nie jest pełnym podglądem pliku.</p>}
  <button type="button" disabled={!props.ports||v.busy} onClick={()=>void c.refresh()}>Odczytaj cały zapisany plan</button>
  {legacyPending&&<p role="status">Wcześniejszy import sekwencyjny ma nierozstrzygniętą próbę. Pełny plan pozostaje zablokowany.</p>}
  {v.error&&<p role="alert">{v.error}</p>}
  {pending&&<p role="status">Wynik próby pozostaje niepotwierdzony.{pending.jobId===props.jobId&&<button type="button" disabled={pending.flight||props.externalWriteBlocked||!props.canManage||!props.ports} onClick={()=>void c.send(pending.command,true)}>{pending.flight?'Operacja trwa…':'Ponów dokładnie tę samą próbę'}</button>}</p>}
  {s&&<><p>Zachowane źródło: {s.job.manifest.records} wierszy w {s.job.manifest.total_batches} partiach, {s.job.raw.byte_count} bajtów. Potwierdzony zapis katalogu: {committed} partii. Oryginał i nieznane pola pozostają zachowane.</p>
   {(!s.capability.existing_updates||s.phase==='unavailable')&&<p role="status">Ta instalacja nie gwarantuje pełnego natywnego przeglądu istniejących produktów przed pierwszym zapisem.</p>}
   {s.reasons.length>0&&<ul aria-label="Przyczyny odmowy pełnego planu">{s.reasons.map((r,n)=><li key={n}>{r}</li>)}</ul>}
   <p>Niezależne nowe produkty wymagają potwierdzonego natywnego podglądu z rzeczywiście przydzielonym ID. Powtórzone produkty oraz zależności rodziców lub zestawów między partiami wymagają osobnego natywnego planu grupowego. Zależności wewnątrz partii pozostają w jej pełnym natywnym podglądzie. Brak takiego planu oznacza odmowę pełnego zakresu, a nie pominięcie wierszy.</p>
   {!scope&&s.job.core.some(c=>c.preview)&&<div><h3>Zapisane podglądy partii — pełny plan nie jest jeszcze potwierdzony</h3><p>Odmowa lub brak podglądu jednej partii blokuje zgodę na cały zakres i pierwszy zapis produktów.</p><ol aria-label="Dotychczasowe podglądy i błędy">{s.job.core.map((c,n)=><li key={n}>Partia {n+1}{c.preview?<><p>{c.preview.ack.head.ready?'Podgląd partii gotowy':'Podgląd partii odrzucony'}</p><ul>{c.preview.pages.flatMap(p=>p.rows).map(row=><li key={row.index}>{props.renderNativeRow?.(row)??<span>Wiersz {row.index+1}: {row.identity_value}</span>}{row.errors.length>0&&<ul aria-label="Błędy wiersza">{row.errors.map((e,i)=><li key={i} role="alert">{e}</li>)}</ul>}</li>)}</ul></>:<p>Podgląd nie został jeszcze potwierdzony.</p>}</li>)}</ol></div>}
   {s.capability.existing_updates&&!scope&&committed===0&&s.phase!=='unavailable'&&<button type="button" disabled={blocked||!s.job.approved} onClick={()=>send({kind:'prepare',sourcePlanHash:s.job.plan_hash})}>Przygotuj wszystkie natywne podglądy bez zapisu produktów</button>}
   {scope&&<><p>Pełny natywny zakres: {scope.batches.length} partii. Zapisane podglądy pozostają powiązane z całym plikiem. Limity i źródła są ponownie sprawdzane przed zapisem.</p>
    <button type="button" disabled={blocked||!!s.unknown} onClick={()=>send({kind:'revalidate',scopeHash:scope.aggregate_scope_hash})}>Sprawdź ponownie aktualne źródła całego zachowanego planu</button>
    {!props.renderNativeRow&&<p role="status">Brak pełnego czytelnego przeglądu zmian przed i po. Zgoda i zapis pozostają wyłączone.</p>}
    <ol aria-label="Wszystkie partie natywnego planu">{scope.batches.map(x=><li key={x.preview_id}><h3>Partia {x.index+1}</h3><p>{x.preview.ack.head.total} wierszy · {x.eligibility.eligible?'Aktualny podgląd':'Podgląd nieaktualny — wymaga ponownego planu'}</p>{props.renderNativeRow&&<ul>{x.preview.pages.flatMap(p=>p.rows).map(row=><li key={row.index}>{props.renderNativeRow!(row)}</li>)}</ul>}</li>)}</ol>
    {canApprove(s)&&<fieldset disabled={blocked||!canApprove(s)||!props.renderNativeRow}><legend>Osobna zgoda na pełny plan katalogu</legend><label><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>Sprawdziłem wszystkie wiersze i zmiany przed oraz po, błędy i zachowane nieznane pola całego pliku. Zatwierdzam dokładnie ten pełny plan.</label><button type="button" disabled={!consent} onClick={()=>send({kind:'approve',scopeHash:scope.aggregate_scope_hash})}>Zatwierdź cały natywny plan</button></fieldset>}
    {scope.approved_scope_hash===scope.aggregate_scope_hash&&<><p role="status">Zgoda na pełny plan jest zapisana. Parametry PIM wymagają później oddzielnego świeżego podglądu i zgody.</p><label>Partia do zapisu <select value={batch} onChange={e=>setBatch(Number(e.target.value))}>{scope.batches.map(x=><option key={x.preview_id} value={x.index}>Partia {x.index+1}</option>)}</select></label>
     {b&&!s.job.core[batch].execution&&<fieldset disabled={blocked||!props.renderNativeRow||!scope.batches.every(x=>x.eligibility.eligible)||!!s.unknown||!s.job.core.slice(0,batch).every(x=>x.execution)}><legend>Osobna zgoda na zapis tej partii</legend><label><input type="checkbox" checked={batchConsent} onChange={e=>setBatchConsent(e.target.checked)}/>Potwierdzam zapis tej partii w ramach zatwierdzonego pełnego planu.</label><button type="button" disabled={!batchConsent} onClick={()=>send({kind:'execute',scopeHash:scope.aggregate_scope_hash,batch,previewId:b.preview_id,nativeScope:b.scope_hash})}>Zapisz zatwierdzoną partię</button></fieldset>}</>}
    {(s.phase==='partial'||s.phase==='complete')&&scope.approved_scope_hash===null&&<p role="alert">Zachowane potwierdzenia wykonanych partii pozostają ważne. Zgoda na pełny plan jest obecnie unieważniona; dalszy nowy zapis pozostaje zablokowany do świeżego przeglądu i zgody.</p>}
    {s.phase==='partial'&&<p role="status">Część partii jest już zapisana. Oryginalne klucze, podglądy i potwierdzenia zostają zachowane; ponowienie nie cofa tego zapisu.</p>}
    {s.unknown&&<button type="button" disabled={blocked} onClick={()=>send({kind:'retry_durable',attempt:s.unknown!})}>Rozstrzygnij dokładną zapisaną próbę</button>}
    <details><summary>Szczegóły techniczne pełnego planu</summary><pre>{JSON.stringify(s,null,2)}</pre></details>
   </>}
  </>}
 </section>;
}
