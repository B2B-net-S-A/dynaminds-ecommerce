import {api,ApiError} from './api';
import {uuid} from './b2b-correction-model';
import type {B2bCorrectionTransport} from './b2b-corrections';
/** Genuine staged160 namespace. No absence fake200, no synthetic receipt. */
export function createB2bCorrectionHttp160(workspaceId:string):B2bCorrectionTransport{
 if(!uuid(workspaceId))throw Error('Brak własnej organizacji korekty.');
 return {contract:'b2b-correction-ui/v1',async request(op,input){
 const id=()=>{if(!uuid(input.id))throw Error('Brak rzeczywistego identyfikatora korekty.');return input.id;};
 const body=()=>{if(typeof input.body!=='string')throw Error('Brak zachowanej próby korekty.');return JSON.parse(input.body);};
 if(op==='options')return api('/b2b-corrections/options');
 if(op==='source')return api('/b2b-corrections/documents/'+id()+'/source');
 if(op==='preview')return api('/b2b-corrections/previews','POST',body());
 if(op==='preview-detail')return api('/b2b-corrections/previews/'+id());
 if(op==='issue')return api('/b2b-corrections/previews/'+id()+'/issue','POST',body());
 if(op==='list'){if(input.cursor!==undefined&&(typeof input.cursor!=='string'||input.cursor.length<1||input.cursor.length>2048))throw Error('Niepoprawna strona korekt.');return api('/b2b-corrections/documents?limit=50'+(input.cursor?'&cursor='+encodeURIComponent(input.cursor):''));}
 if(op==='detail')return api('/b2b-corrections/documents/'+id());
 if(op!=='print')throw Error('Nieznana operacja korekty.');
 const response=await fetch('/api/b2b-corrections/documents/'+id()+'/print',{credentials:'same-origin',headers:{'X-Workspace-ID':workspaceId}});if(!response.ok)throw new ApiError('Nie udało się odczytać wydruku korekty',response.status);return {html:await response.text(),content_type:response.headers.get('content-type')??'',cache_control:response.headers.get('cache-control')??''};
 }};
}
