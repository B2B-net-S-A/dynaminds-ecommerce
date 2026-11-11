/** Central normal/v1 operations use exactly the installed child aliases. No generic root clone. */
import {z} from 'zod';
import {largeImportPublicOperations,applyLargeImportOpenApiContract,LARGE_IMPORT_SAME_PARSER_ALIAS} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/public-contract';
import {doneCoreListOperation} from '../../shared/large-import-dependencies/pim-large-import-native-pim-driver-ui/list-routes';
import {jobHistoryOperation} from './job-history-routes';
export {LARGE_IMPORT_SAME_PARSER_ALIAS};
export const registeredLargeImportPublicOperations=[...largeImportPublicOperations,{...doneCoreListOperation,scope:'products:read',input:undefined},{...jobHistoryOperation,scope:'products:read',input:undefined}];
export function applyRegisteredLargeImportOpenApiContract(document:any,method:string,path:string){
 if(method===jobHistoryOperation.method&&path===jobHistoryOperation.path){
  document.description='Własny postęp i historia importów. Odczyt RR z bieżącym IAM bez lease/CAS/DML. Przed działaniem wymagany pełny aktualny odczyt zadania.';document['x-required-scopes']=['products:read','products:write'];document['x-required-role']='admin';document['x-maximum-response-bytes']=1048576;const schema=z.toJSONSchema(jobHistoryOperation.query,{io:'input',unrepresentable:'any'});document.parameters??=[];for(const[name,value]of Object.entries(schema.properties??{}))document.parameters.push({in:'query',name,required:schema.required?.includes(name)??false,schema:value});document.responses??={};document.responses['413']={description:'Pełna strona przekracza limit; bez ucięcia wpisów.'};document.responses['503']={description:'Brak autoryzowanego odczytu historii.'};return;
 }
 if(method!==doneCoreListOperation.method||path!==doneCoreListOperation.path)return applyLargeImportOpenApiContract(document,method,path);
 document.description='Lekka lista własnych zadań z zakończonym Core. SELECT-only RR z bieżącym IAM; bez lease/CAS/DML. Przed PIM pełne strony zadania są odczytywane oddzielnie.';
 document['x-required-scopes']=['products:read','products:write'];document['x-required-role']='admin';document['x-maximum-response-bytes']=1048576;
 const schema=z.toJSONSchema(doneCoreListOperation.query,{io:'input',unrepresentable:'any'});document.parameters??=[];
 for(const[name,value]of Object.entries(schema.properties??{}))document.parameters.push({in:'query',name,required:schema.required?.includes(name)??false,schema:value});
 document.responses??={};document.responses['413']={description:'Pełna strona przekracza limit; bez ucięcia wpisów.'};document.responses['503']={description:'Brak certyfikowanego własnego odczytu i zarejestrowanych portów.'};
}
