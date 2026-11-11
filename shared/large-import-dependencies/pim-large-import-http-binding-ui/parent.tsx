import React,{useLayoutEffect,useMemo,useRef,useState} from 'react';
import {CompleteFileReviewPanel,type Props as PanelProps} from '../pim-large-import-complete-file-review-ui2/panel';
import {createLargeImportHttp,type FetchPort,type Scope} from './browser';
import type {Admission} from '../pim-large-import-complete-file-review-ui2/adapter';
import type {LoadProgress} from './hydrate';
export type Props=Omit<PanelProps,'ports'> & {catalogId:string;certifiedAvailable:boolean;independentCreates:boolean;fetchPort?:FetchPort};
/** No optimistic availability, no action on mount other than owned read. StrictMode effect reconnect is explicit. */
export function LargeImportCompleteReview(props:Props){const latest=useRef(props);latest.current=props;
 const [progress,setProgress]=useState<LoadProgress|null>(null);
 const k=JSON.stringify([props.context.tenantId,props.context.userId,props.context.apiKeyId,props.catalogId,props.jobId]);
 const http=useMemo(()=>createLargeImportHttp(():Scope=>{const p=latest.current;return {context:p.context,catalogId:p.catalogId,jobId:p.jobId,available:p.certifiedAvailable,canManage:p.canManage,externalWriteBlocked:p.externalWriteBlocked};},props.fetchPort),[k,props.fetchPort]);
 const ports=useMemo(()=>http.completeReview(():Admission=>{const p=latest.current;return {context:p.context,jobId:p.jobId,available:p.certifiedAvailable,independentCreates:p.independentCreates,canManage:p.canManage,externalWriteBlocked:p.externalWriteBlocked};}),[http]);
 useLayoutEffect(()=>{http.activate();setProgress(null);const unsubscribe=http.onProgress(setProgress);return()=>{unsubscribe();http.deactivate();};},[http]);
 return <><p role="status">{progress?('Odczyt pełnego planu: CORE '+progress.loaded_core_rows+'/'+progress.total_core_rows+', przegląd '+progress.loaded_review_rows+'/'+progress.total_review_rows+(progress.complete?' — wszystkie strony odczytane.':' — trwa odczyt.')):'Pełny odczyt wszystkich stron nie jest jeszcze potwierdzony.'}</p><CompleteFileReviewPanel {...props} ports={props.certifiedAvailable?ports:null}/></>;
}
