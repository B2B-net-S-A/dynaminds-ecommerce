/** Browser-safe complete catalog attribute codec. No authority, I/O or truncation. */
import {z} from 'zod';
import{decodeJson,type JsonValue}from'./pim-json';
export const legacyCatalogAttributes=z.record(z.string().min(1).max(80),z.string().max(500)).refine(v=>Object.keys(v).length<=50);
export function isFlatStringAttributes(raw:unknown):raw is Record<string,string>{
 if(raw===null||typeof raw!=='object'||Array.isArray(raw))return false;
 const prototype=Object.getPrototypeOf(raw);if(prototype!==Object.prototype&&prototype!==null)return false;
 if(Object.getOwnPropertySymbols(raw).length)return false;
 return Object.values(Object.getOwnPropertyDescriptors(raw)).every(d=>d.enumerable&&'value'in d&&typeof d.value==='string');
}
const legacyEntries=z.array(z.tuple([z.string().min(1).max(80),z.string().max(500)])).max(50);
export function decodeCatalogAttributes(raw:unknown):Record<string,JsonValue>{
 if(isFlatStringAttributes(raw))return Object.fromEntries(legacyEntries.parse(Object.entries(raw)));
 const tree=decodeJson(raw,{bytes:1048576,depth:16,nodes:100000});
 if(tree===null||typeof tree!=='object'||Array.isArray(tree))throw new Error('Parametry wymagają obiektu JSON');
 return tree;
}
const nestedCatalogAttributes=z.unknown().transform((raw,ctx)=>{
 try{if(isFlatStringAttributes(raw))throw new Error('Legacy string limits');return decodeCatalogAttributes(raw);}
 catch{ctx.addIssue({code:'custom',message:'Parametry wymagają pełnego poprawnego obiektu JSON w granicach 1 MiB, 16 poziomów i 100000 węzłów'});return z.NEVER;}
});
/** Explicit branch dispatch: invalid legacy strings never fall back to nested. */
export const catalogAttributesSchema=z.unknown().transform((raw,ctx):Record<string,JsonValue>=>{
 const flat=isFlatStringAttributes(raw),result=flat?legacyEntries.safeParse(Object.entries(raw as Record<string,string>)):nestedCatalogAttributes.safeParse(raw);
 if(!result.success){for(const issue of result.error.issues)ctx.addIssue({...issue});return z.NEVER;}
 return flat?Object.fromEntries(result.data as [string,string][]):result.data as Record<string,JsonValue>;
}).default({});
