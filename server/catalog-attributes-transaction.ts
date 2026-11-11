/** Producer context derives only from owner preflight BEFORE pool borrow. */
import type{PoolClient}from'pg';
import{decodeCatalogAttributes,isFlatStringAttributes}from'../shared/catalog-attributes';
import{Problem}from'./errors';
const contexts=new WeakMap<PoolClient,boolean>();
export function beginCatalogAttributesTransaction(c:PoolClient,nestedAvailable:boolean){if(contexts.has(c))throw new Problem(503,'Powtórzony kontekst parametrów katalogu');contexts.set(c,nestedAvailable===true);}
export function endCatalogAttributesTransaction(c:PoolClient){contexts.delete(c);}
export async function assertCatalogAttributesWriteInTx(c:PoolClient,raw:unknown):Promise<void>{
 const attributes=decodeCatalogAttributes(raw);
 if(isFlatStringAttributes(attributes))return;
 if(contexts.get(c)!==true)throw new Problem(503,'Zagnieżdżone parametry wymagają zweryfikowanego modułu 172');
 // Built-in under the current app role; never call owner-only172 helpers or borrow
 // another pool connection after tenant locks. No metadata/security role change.
 const bytes=(await c.query('SELECT octet_length($1::jsonb::text)::integer bytes',[JSON.stringify(attributes)])).rows[0]?.bytes;
 if(!Number.isSafeInteger(bytes)||bytes<2)throw new Problem(503,'Nie można sprawdzić rozmiaru parametrów');
 if(bytes>2097152)throw new Problem(413,'Zagnieżdżone parametry przekraczają 2 MiB w natywnym JSONB');
}
