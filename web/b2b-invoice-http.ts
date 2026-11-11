import {api,ApiError} from './api';
import type {B2bInvoiceTransport} from './b2b-invoices';
/** Actual future159 paths only. No404→fake flags,158 approval→issue, provider fallback. */
export function createB2bInvoiceHttp159(workspaceId:string):B2bInvoiceTransport{
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(workspaceId))throw Error('Brak własnej organizacji faktury.');
 return {contract:'b2b-invoice-ui/v1',async request(op,input){
 const id=()=>{if(typeof input.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.id))throw Error('Brak rzeczywistego identyfikatora faktury.');return input.id;};
 const body=()=>{if(typeof input.body!=='string')throw Error('Brak zapisanej próby faktury.');return JSON.parse(input.body);};
 if(op==='options')return api('/b2b-invoices/options');
 if(op==='project')return api('/b2b-fa3/projects/'+id());
 if(op==='preview')return api('/b2b-invoices/projects/'+id()+'/previews','POST',body());
 if(op==='issue')return api('/b2b-invoices/previews/'+id()+'/issue','POST',body());
 if(op==='list'){if(input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor.length||input.cursor.length>2048))throw Error('Niepoprawna strona faktur.');return api('/b2b-invoices/documents?limit=50'+(input.cursor?'&cursor='+encodeURIComponent(input.cursor):''));}
 if(op==='detail')return api('/b2b-invoices/documents/'+id());
 if(op==='xml'){
 const response=await fetch('/api/b2b-invoices/documents/'+id()+'/fa3.xml',{credentials:'same-origin',headers:{'X-Workspace-ID':workspaceId}});
 if(!response.ok)throw new ApiError('Nie udało się pobrać lokalnego XML FA(3).',response.status);
 return{xml:await response.text(),content_type:response.headers.get('content-type')??'',cache_control:response.headers.get('cache-control')??'',content_disposition:response.headers.get('content-disposition')??'',nosniff:response.headers.get('x-content-type-options')??''};
 }
 if(op!=='print')throw Error('Nieznana operacja faktury B2B');
 const response=await fetch('/api/b2b-invoices/documents/'+id()+'/print',{credentials:'same-origin',headers:{'X-Workspace-ID':workspaceId}});if(!response.ok)throw new ApiError('Nie udało się odczytać wydruku faktury B2B',response.status);return{html:await response.text(),content_type:response.headers.get('content-type')??'',cache_control:response.headers.get('cache-control')??''};
}};
}
