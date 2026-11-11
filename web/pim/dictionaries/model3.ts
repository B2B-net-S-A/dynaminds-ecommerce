/** Pure immutable successor. Model2 validation remains literal; adds namespace birth semantics. */
export * from './model2';
import {z} from 'zod';
import {validateDictionary,PimValidationError,type DictionaryData} from './model2';
export function validateNamespace(raw:unknown):DictionaryData&{dictionary_version:string}{
 const shape=z.strictObject({dictionary_version:z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)<=9223372036854775807n),categories:z.array(z.unknown()),definitions:z.array(z.unknown())}).safeParse(raw);
 if(!shape.success)throw new PimValidationError([{row:0,field:'namespace',code:'shape',definition_id:null}]);
 const dictionary=validateDictionary({categories:shape.data.categories,definitions:shape.data.definitions});
 if(shape.data.dictionary_version==='0'&&(dictionary.categories.length||dictionary.definitions.length))throw new PimValidationError([{row:0,field:'dictionary_version',code:'nonempty_absent_namespace',definition_id:null}]);
 return {...dictionary,dictionary_version:shape.data.dictionary_version};
}
