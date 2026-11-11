import {CatalogAttributesRead,CatalogAttributesJsonInput,seedCatalogAttributes,parseCatalogAttributesEdit,flatAttributesJson} from './catalog-attributes';
import {CorePimContinuation} from './pim/legacy-files/panel';
import type {StagePort} from './pim/legacy-files/session';
import {AuthenticatedCorePimContinuation} from './pim/legacy-files/authenticated-panel';
import {PimCatalogTools,usePimParentLock,pimEditorLocked,type PimContext} from './pim/parent';
import {PimDictionaryEditor} from './pim/editor';
import { LocalWooFlow } from './local-woo-flow';
import { OdooImages } from './odoo-images';
import { CatalogAi } from './catalog-ai';
import { CatalogAiBatches } from './catalog-ai-batches';
import { CatalogAiAttributes } from './catalog-ai-attributes';
import { CatalogAiImages } from './catalog-ai-image';
import { CatalogAiMatch } from './catalog-ai-match';
import { ShopifyTranslations } from './shopify-translations';
import { ShopifyTranslationBatches } from './shopify-translation-batches';
import { ProductRuleBulkPreview } from './product-rules';
import { CatalogBulkEdit, CatalogBulkEditHistory, normalizeSkuDraft } from './catalog-bulk-edit';
import { InventoryBulkEdit } from './inventory-bulk-edit';
import { PriceBulkEdit } from './price-bulk-edit';
import { ProductTranslationBulkEdit } from './product-translation-bulk-edit';
import { CatalogExportPanel, catalogExportLocked } from './catalog-export';
import { CatalogFileImportPanel } from './catalog-file-import';
import {catalogListQuery,readCatalogList,readCatalogWarehouses,toggleCatalogPage,catalogSelectionSummary} from './catalog-list-model';
import {ProductDeletionConfirm} from './catalog-product-deletion';
import {ProductTaxProfile} from './catalog-tax-profile';
import {
  logisticsFields,
  logisticsLabels,
  logisticsRaw,
  parseLogisticsValue,
  ProductLogisticsDetails,
} from './product-logistics';
import { DeepLCatalog } from './deepl-catalog';
import { DeepLBatches } from './deepl-batches';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Package, Search, X, Plus, Upload, Check, ArrowLeft, ImagePlus } from 'lucide-react';
import { api, ApiError, money } from './api';
import { productCatalogsWriteLocked, type ProductCatalog } from './product-catalogs';
import { stocktakeAdjustmentsLocked } from './stocktake-adjustments';
import { catalogStockControlLocked } from './catalog-stock-control-panel';
export const kinds: Record<string, string> = {
  simple: 'Produkt',
  group: 'Grupa wariantów',
  variant: 'Wariant',
  bundle: 'Zestaw',
};
function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [close]);
  return (
    <div className="modal-shade" onClick={close}>
      <section
        className="modal catalog-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="Zamknij" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function ErrorText({ text }: { text: string }) {
  return text ? (
    <div className="notice import-error" role="alert">
      {text}
    </div>
  ) : null;
}
export function ProductPicker({
  label,
  value,
  select,
  filter,
  initial,
  catalogId,
  contextKey = '',
  disabled = false,
}: {
  label: string;
  value: string;
  select: (p: any) => void;
  filter?: (p: any) => boolean;
  initial?: any;
  catalogId?: string;
  contextKey?: string;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState(''),
    [data, setData] = useState<any[]>([]),
    [error, setError] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [loadingMore, setLoadingMore] = useState(false),
    [loadedPickerScope, setLoadedPickerScope] = useState('');
  const pickerScope = contextKey + ':' + (catalogId ?? '') + ':' + search;
  const latestPickerScope = useRef(pickerScope);
  const pickerAlive = useRef(false), pickerGeneration = useRef(0);
  latestPickerScope.current = pickerScope;
  const pickerQuery = '/products?limit=50&search=' + encodeURIComponent(search) +
    (catalogId ? '&catalog_id=' + encodeURIComponent(catalogId) : '');
  useEffect(() => {
    let active = true;
    pickerAlive.current = true; pickerGeneration.current++;
    setData([]);
    setCursor(null);
    setLoadingMore(false);
    setError('');
    api(pickerQuery)
      .then((d) => {
        if (active) {
          if (!Array.isArray(d.data) || !d.meta || (catalogId && d.data.some((p: any) => p.catalog_id !== catalogId))) throw Error('Niezgodny zakres katalogu wyszukiwania.');
          setData(d.data);
          setLoadedPickerScope(pickerScope);
          setCursor(d.meta.cursor);
          setError('');
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      pickerAlive.current = false; pickerGeneration.current++;
    };
  }, [search, catalogId, contextKey]);
  const options = (loadedPickerScope === pickerScope ? data : []).filter((p) => (!catalogId || p.catalog_id === catalogId) && (filter?.(p) ?? true));
  if (initial?.id === value && (!catalogId || initial.catalog_id === catalogId) && !options.some((p) => p.id === value)) options.unshift(initial);
  return (
    <div className="catalog-picker">
      <label>
        {label}
        <input
          aria-label={'Szukaj: ' + label}
          placeholder="Nazwa lub SKU"
          value={search}
          disabled={disabled}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label={label}
          required
          value={value}
          disabled={disabled}
          onChange={(e) => { if (!disabled) select(options.find((p) => p.id === e.target.value)); }}
        >
          <option value="">Wybierz produkt</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sku} · {p.name}
            </option>
          ))}
        </select>
      </label>
      {loadedPickerScope === pickerScope && cursor && (
        <button
          type="button"
          className="text-button"
          disabled={disabled || loadingMore}
          onClick={async () => {
            const scope = pickerScope;
            const generation = pickerGeneration.current;
            if (disabled || loadingMore) return;
            setLoadingMore(true);
            try {
              const d = await api(pickerQuery + '&after=' + cursor);
              if (!pickerAlive.current || pickerGeneration.current !== generation || latestPickerScope.current !== scope) return;
              if (!Array.isArray(d.data) || !d.meta || (catalogId && d.data.some((p: any) => p.catalog_id !== catalogId))) throw Error('Niezgodny zakres kolejnej strony produktów.');
              if (d.meta.cursor === cursor) throw Error('Powtórzona strona produktów. Odczytaj wyniki ponownie.');
              setData((v) => [...v, ...d.data.filter((p: any) => !v.some((old) => old.id === p.id))]);
              setCursor(d.meta.cursor);
            } catch (e) {
              if (pickerAlive.current && pickerGeneration.current === generation && latestPickerScope.current === scope) setError((e as Error).message);
            } finally {
              if (pickerAlive.current && pickerGeneration.current === generation && latestPickerScope.current === scope) setLoadingMore(false);
            }
          }}
        >
          Więcej wyników
        </button>
      )}
      <ErrorText text={error} />
    </div>
  );
}
type LibraryImage = {id:string;url:string;mime:string;size:number;created_at:string};
export function ProductImageLibrary({scope,selected,disabled,onChoose,onDenied}: {
  scope:string;selected:string[];disabled:boolean;onChoose:(image:LibraryImage,scope:string)=>void;onDenied:()=>void;
}) {
  const [open,setOpen]=useState(false),[mime,setMime]=useState('');
  const [page,setPage]=useState<{scope:string;mime:string;data:LibraryImage[];next:string|null}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),flight=useRef(false),controller=useRef<AbortController|null>(null);
  const currentScope=scope+':'+mime,latest=useRef({scope:currentScope,disabled,onChoose,onDenied});latest.current={scope:currentScope,disabled,onChoose,onDenied};
  useEffect(()=>{generation.current++;controller.current?.abort();flight.current=false;setBusy(false);setPage(null);setError('');setOpen(false);return()=>{generation.current++;controller.current?.abort();};},[scope]);
  const visible=page?.scope===scope&&page.mime===mime?page:null;
  async function load(after?:string){
    if(flight.current)return;
    const epoch=generation.current,original=currentScope,abort=new AbortController();controller.current=abort;flight.current=true;setBusy(true);setError('');
    const current=()=>epoch===generation.current&&latest.current.scope===original&&!abort.signal.aborted;
    try{
      const d=await api('/product-images?'+new URLSearchParams({limit:'25',...(mime?{mime}:{}),...(after?{after}:{})}),'GET',undefined,{},abort.signal);
      if(!current())return;
      if(!Array.isArray(d.data)||d.data.length>25||(d.next!==null&&(typeof d.next!=='string'||!d.next||d.next.length>500)))throw Error('Niepełny odczyt biblioteki zdjęć.');
      const ids=new Set<string>();
      for(const row of d.data){if(typeof row.id!=='string'||!(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i).test(row.id)||row.url!=='/api/product-images/'+row.id||!['image/png','image/jpeg','image/webp'].includes(row.mime)||(mime&&row.mime!==mime)||!Number.isSafeInteger(row.size)||row.size<1||row.size>524288||typeof row.created_at!=='string'||!Number.isFinite(Date.parse(row.created_at))||ids.has(row.id))throw Error('Nieprawidłowe zdjęcie w bibliotece.');ids.add(row.id);}
      setPage(old=>({scope,mime,data:after&&old?.scope===scope&&old.mime===mime?[...old.data,...d.data.filter((r:LibraryImage)=>!old.data.some(p=>p.id===r.id))]:d.data,next:d.next}));setOpen(true);
    }catch(e){if(current()){setPage(null);setError(e instanceof Error?e.message:'Nie udało się odczytać biblioteki.');if(e instanceof ApiError&&[401,403].includes(e.status)){latest.current.onDenied();setOpen(false);}}}
    finally{if(current()){flight.current=false;setBusy(false);controller.current=null;}}
  }
  function filter(value:string){generation.current++;controller.current?.abort();flight.current=false;setBusy(false);setMime(value);setPage(null);setError('');}
  return <div className="catalog-section" aria-label="Biblioteka własnych zdjęć">
    <button type="button" className="button" disabled={busy} onClick={()=>void load()}>Wybierz istniejące zdjęcie</button>
    <p>Wybór używa tego samego prywatnego pliku. Zapisz produkt, aby utrwalić powiązanie; nie wykonuje nowego uploadu.</p>
    {open&&<><label>Format zdjęcia<select value={mime} disabled={busy} onChange={e=>filter(e.target.value)}><option value="">Wszystkie</option><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option><option value="image/webp">WebP</option></select></label>
      <button type="button" className="button" disabled={busy} onClick={()=>void load()}>Odczytaj bibliotekę</button>
      {visible?.data.length===0&&<p>Brak zdjęć w wybranym formacie.</p>}
      <div className="catalog-images">{visible?.data.map((image,index)=><div key={image.id}><img src={image.url} alt={'Zdjęcie z biblioteki '+(index+1)}/><p>{image.mime.split('/')[1].toUpperCase()} · {Math.ceil(image.size/1024)} KiB</p><button type="button" className="button" disabled={disabled||busy||selected.includes(image.url)||selected.length>=10} onClick={()=>{if(latest.current.scope!==currentScope||latest.current.disabled||!visible?.data.some(r=>r.id===image.id&&r.url===image.url)||selected.includes(image.url)||selected.length>=10)return;latest.current.onChoose(image,scope);}}>{selected.includes(image.url)?'Wybrane':'Dodaj do produktu'}</button></div>)}</div>
      {visible?.next&&<button type="button" className="button" disabled={busy} onClick={()=>void load(visible.next!)}>Więcej zdjęć</button>}
    </>}
    {busy&&<p role="status">Odczytywanie biblioteki…</p>}{error&&<p role="alert">{error}</p>}
  </div>;
}

type CatalogFormScope = { contextKey?: string; initialCatalogId?: string; readOnly?: boolean; externalWriteBlocked?: boolean; pimContext?:PimContext };
export function NewProductModal({ close, saved, ...scope }: { close: () => void; saved: () => void } & CatalogFormScope) {
  return (
    <Dialog title="Nowy produkt" close={close}>
      <ProductForm close={close} saved={saved} {...scope} />
    </Dialog>
  );
}
function ProductForm({
  pimContext,
  product,
  close,
  saved,
  canEditSku = false,
  contextKey = '',
  initialCatalogId = '',
  readOnly = false,
  externalWriteBlocked = false,
}: {
  product?: any;
  close: () => void;
  saved: () => void;
  canEditSku?: boolean;
} & CatalogFormScope) {
  const [kind, setKind] = useState(product?.kind ?? 'simple'),
    [parent, setParent] = useState<any>(
      product?.parent_id ? { id: product.parent_id, sku: 'Grupa', name: 'wariantów' } : null,
    ),
    [parts, setParts] = useState<any[]>(product?.components ?? []),
    [attrs, setAttrs] = useState<[string, string][]>(() => seedCatalogAttributes(product?.attributes ?? {}).rows),
    [attributesJson, setAttributesJson] = useState<string|null>(() => seedCatalogAttributes(product?.attributes ?? {}).json),
    [images, setImages] = useState<string[]>(product?.images ?? []),
    [imageUrl, setImageUrl] = useState(''),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [catalogs, setCatalogs] = useState<ProductCatalog[]>([]),
    [catalogAvailable, setCatalogAvailable] = useState(false),
    [catalogRead, setCatalogRead] = useState(false),
    [catalogId, setCatalogId] = useState(product?.catalog_id ?? initialCatalogId),
    [logisticsAvailable, setLogisticsAvailable] = useState(false),
    [skuAvailable, setSkuAvailable] = useState(false),
    [skuDraft, setSkuDraft] = useState<string>(product?.sku ?? ''),
    [writeBlocked, setWriteBlocked] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api('/warehouses')
      .then((d) => active && setWarehouses(d.data))
      .catch((e) => active && setError(e.message));
    api('/health')
      .then((d) => {
        if (!active) return;
        setLogisticsAvailable(d.product_logistics_available === true && !d.restore_preview);
        setSkuAvailable(d.product_sku_edit_available === true && !d.restore_preview);
      })
      .catch((e) => active && setError(e.message));
    setCatalogRead(false);
    api('/product-catalogs/options')
      .then((d) => {
        if (!active) return;
        if (typeof d.available !== 'boolean' || typeof d.can_read !== 'boolean') throw Error('Niepełny odczyt katalogów produktu.');
        if (d.available && (!d.can_read || !Array.isArray(d.catalogs))) throw Error('Brak odczytu katalogów produktu.');
        setCatalogAvailable(d.available);
        setCatalogs(d.catalogs ?? []);
        setCatalogRead(true);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [contextKey]);
  const hasPim=()=>!!pimContext&&pimEditorLocked(pimContext);
  const formBlocked = hasPim() || busy || writeBlocked || readOnly || externalWriteBlocked || productCatalogsWriteLocked(contextKey) || catalogExportLocked(contextKey) || (!product && (stocktakeAdjustmentsLocked(contextKey) || catalogStockControlLocked(contextKey)));
  const libraryAdded = useRef(new Set<string>());
  const chosenCatalog = catalogs.find((c) => c.id === catalogId);
  const formWarehouses = catalogAvailable ? warehouses.filter((w) => chosenCatalog?.settings.warehouse_ids.includes(w.id)) : warehouses;
  const formScope = contextKey + ':' + readOnly + ':' + externalWriteBlocked + ':' + catalogId;
  const formScopeRef = useRef(formScope);
  const formAlive = useRef(false);
  formScopeRef.current = formScope;
  useEffect(() => { formAlive.current = true; return () => { formAlive.current = false; }; }, [contextKey]);
  const clearLibrarySelection = () => { const old=new Set(libraryAdded.current);libraryAdded.current.clear();if(old.size)setImages(images=>images.filter(url=>!old.has(url))); };
  useEffect(()=>{clearLibrarySelection();},[contextKey,product?.id,catalogId]);
  useEffect(() => {
    let active = true;
    if (product?.catalog_id && (product.kind === 'bundle' || product.parent_id)) {
      const ids = [...new Set<string>([...(product.components ?? []).map((p: any) => String(p.product_id)), ...(product.parent_id ? [product.parent_id] : [])])];
      void Promise.all(ids.map((id) => api('/products/' + id))).then((rows) => {
        if (!active) return;
        if (rows.some((p) => p.catalog_id !== product.catalog_id)) throw Error('Niezgodny katalog istniejącego rodzica lub składników.');
        setParts((old) => old.map((part) => { const p = rows.find((p) => p.id === part.product_id); return p ? { ...part, catalog_id: p.catalog_id, sku: p.sku, name: p.name } : part; }));
        if (product.parent_id) setParent(rows.find((p) => p.id === product.parent_id));
      }).catch((e) => { if (active) setError(e.message); });
    }
    return () => { active = false; };
  }, [contextKey, product?.id]);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (hasPim() || formBlocked || !catalogRead) return;
    const submittedScope = formScope;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (catalogAvailable) {
        if (!chosenCatalog || (!product && !chosenCatalog.active)) throw Error('Wybierz własny aktywny katalog produktu.');
        const access = await api('/product-catalogs/options');
        if (hasPim() || !formAlive.current || formScopeRef.current !== submittedScope) return;
        if (!access.available || !access.can_read || !access.can_manage || access.read_only || (contextKey && access.current_role !== contextKey.split(':')[2]) || !access.catalogs?.some((c: any) => c.id === catalogId && (product || c.active))) throw new ApiError('Katalog lub dostęp do produktu zmienił się. Odczytaj formularz ponownie.', access.read_only ? 423 : 403);
      }
      const fields = Object.fromEntries(f.entries());
      let skuChange: { sku?: string } = {};
      if (product) {
        delete fields.sku;
        if (skuDraft !== product.sku) {
          if (!canEditSku || !skuAvailable)
            throw new Error(
              'Zmiana SKU jest niedostępna w tej kopii. Szkic zachowano; przywróć dotychczasowe SKU, aby zapisać pozostałe pola.',
            );
          const sku = normalizeSkuDraft(skuDraft);
          if (sku !== product.sku) skuChange = { sku };
        }
      }
      const logistics = logisticsAvailable
        ? Object.fromEntries(
            logisticsFields.map((field) => [
              field,
              parseLogisticsValue(field, String(fields[field] ?? '')),
            ]),
          )
        : {};
      for (const field of logisticsFields) delete fields[field];
      const clean = attrs.filter(([k, v]) => k || v);
      if (
        attributesJson === null && (clean.some(([k]) => !k.trim()) ||
        new Set(clean.map(([k]) => k.trim())).size !== clean.length)
      )
        throw new Error('Parametry wymagają unikalnych nazw.');
      const body = {
        ...fields,
        ...skuChange,
        ...logistics,
        price: Math.round(Number(fields.price) * 100),
        vat: Number(fields.vat),
        active: fields.active === 'on',
        attributes: attributesJson === null ? Object.fromEntries(clean.map(([k, v]) => [k.trim(), v])) : parseCatalogAttributesEdit(attributesJson),
        images,
        components:
          kind === 'bundle'
            ? parts.map((p) => ({ product_id: p.product_id, quantity: Number(p.quantity) }))
            : [],
        kind,
        parent_id: kind === 'variant' ? parent?.id : undefined,
        quantity: ['simple', 'variant'].includes(kind) ? Number(fields.quantity ?? 0) : 0,
        version: product?.version,
        ...(catalogAvailable ? { catalog_id: catalogId } : {}),
      };
      if (catalogAvailable && ((kind === 'variant' && parent?.catalog_id !== catalogId) || (kind === 'bundle' && parts.some((p) => p.catalog_id !== catalogId)))) throw Error('Rodzic i wszystkie składniki muszą należeć do katalogu produktu. Wybierz je ponownie w tym katalogu.');
      if (hasPim() || !formAlive.current || formScopeRef.current !== submittedScope || productCatalogsWriteLocked(contextKey) || catalogExportLocked(contextKey) || (!product && (stocktakeAdjustmentsLocked(contextKey) || catalogStockControlLocked(contextKey)))) return;
      await api(
        product ? '/products/' + product.id : '/products',
        product ? 'PATCH' : 'POST',
        body,
      );
      if (!formAlive.current || formScopeRef.current !== submittedScope) return;
      saved();
      close();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && [401, 403, 423].includes(e.status)) setWriteBlocked(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={formBlocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="form-body catalog-workspace">
        <ErrorText text={error} />
        {catalogAvailable && <label>Katalog produktu<select aria-label="Katalog produktu" value={catalogId} disabled={Boolean(product)} required onChange={(e) => { setCatalogId(e.target.value); setParent(null); setParts([]); }}><option value="">Wybierz katalog</option>{catalogs.filter((c) => c.active || c.id === product?.catalog_id).map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' · domyślny' : ''}</option>)}</select>{product && <small>Przenoszenie istniejącego produktu do innego katalogu jest niedostępne.</small>}</label>}
        <div className="form-grid">
          <label>
            Typ produktu
            <select
              aria-label="Typ produktu"
              value={kind}
              disabled={Boolean(product)}
              onChange={(e) => {
                setKind(e.target.value);
                setParts([]);
                setParent(null);
              }}
            >
              {Object.entries(kinds).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            SKU
            <input
              name="sku"
              required
              value={skuDraft}
              onChange={(e) => setSkuDraft(e.target.value)}
              disabled={
                busy || writeBlocked || (Boolean(product) && (!canEditSku || !skuAvailable))
              }
            />
            {product && <small>Wielkość liter ma znaczenie. Kod: 1–80 znaków.</small>}
            {product && !skuAvailable && <small>Ta kopia nie udostępnia zmiany SKU.</small>}
          </label>
          <label>
            Nazwa produktu
            <input name="name" required minLength={2} defaultValue={product?.name ?? ''} />
          </label>
          <label>
            EAN
            <input name="ean" defaultValue={product?.ean ?? ''} />
          </label>
          <label>
            Cena brutto (PLN)
            <input
              name="price"
              type="number"
              min="0"
              step="0.01"
              required
              defaultValue={(product?.price ?? 0) / 100}
            />
          </label>
          <label>
            VAT
            <select name="vat" defaultValue={product?.vat ?? 23}>
              {[23, 8, 5, 0].map((v) => (
                <option key={v} value={v}>
                  {v}%
                </option>
              ))}
            </select>
          </label>
          <label>
            Kategoria
            <input name="category" defaultValue={product?.category ?? 'Pozostałe'} />
          </label>
          <label className="catalog-checkbox">
            <input type="checkbox" name="active" defaultChecked={product?.active ?? true} />
            Aktywny
          </label>
        </div>
        {product && (
          <p className="notice">
            Zmiana SKU zachowuje tożsamość produktu. Istniejące zamówienia i ich kody kompletacji
            zachowują zapisane SKU. Historyczne kody pozostają zarezerwowane dla tego produktu; kod
            innego produktu jest niedostępny. Zmiana dotyczy lokalnego katalogu i nie publikuje kodu
            do kanałów. Nowy kod może kolidować z EAN przy skanowaniu.
          </p>
        )}
        {product && skuDraft !== product.sku && (
          <p className="notice">
            Zmiana w szkicu: {product.sku} → {skuDraft || '(puste — niedozwolone)'}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => setSkuDraft(product.sku)}
            >
              Przywróć dotychczasowe SKU
            </button>
          </p>
        )}
        <section className="catalog-section product-logistics">
          <h3>Waga, wymiary i producent</h3>
          {!logisticsAvailable && (
            <p className="muted">
              Dane logistyczne są niedostępne do zapisu w tej kopii. Dotychczasowe wartości
              pozostają bez zmian.
            </p>
          )}
          <p className="muted">
            Waga w kg (do 3 miejsc), wymiary produktu w cm (do 1 miejsca). Puste pole oznacza brak
            danych; zapis pustego pola usuwa jego dotychczasową wartość. Producent jest tekstem, bez
            zarządzanego słownika.
          </p>
          <div className="form-grid">
            {logisticsFields.map((field) => (
              <label key={field}>
                {logisticsLabels[field]}
                <input
                  name={field}
                  aria-label={logisticsLabels[field]}
                  inputMode={field === 'manufacturer' ? undefined : 'decimal'}
                  disabled={busy || writeBlocked || !logisticsAvailable}
                  defaultValue={logisticsRaw(field, product?.[field])}
                  placeholder={
                    field === 'weight_grams'
                      ? 'np. 1.250'
                      : field === 'manufacturer'
                        ? 'np. Nazwa producenta'
                        : 'np. 12.5'
                  }
                />
              </label>
            ))}
          </div>
        </section>
        {!product && (
          <div className="form-grid">
            <label>
              Magazyn
              <select name="warehouse_id">
                {formWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            {['simple', 'variant'].includes(kind) && (
              <>
                <label>
                  Stan początkowy
                  <input name="quantity" type="number" min="0" step="1" defaultValue="0" required />
                </label>
                <label>
                  Lokalizacja
                  <input name="location" defaultValue="A-01" />
                </label>
              </>
            )}
          </div>
        )}
        {kind === 'variant' && !product && (
          <ProductPicker
            label="Grupa nadrzędna"
            value={parent?.id ?? ''}
            select={setParent}
            filter={(p) => p.kind === 'group'}
            initial={parent}
            catalogId={catalogAvailable ? catalogId : undefined}
            contextKey={contextKey}
            disabled={formBlocked || (catalogAvailable && !catalogId)}
          />
        )}
        {kind === 'bundle' && (
          <section className="catalog-section">
            <h3>Skład zestawu</h3>
            <p className="muted">
              Rezerwacja i kompletacja dotyczą składników. Cena zestawu jest niezależna od ich cen.
            </p>
            {parts.map((p, i) => (
              <div className="catalog-part" key={i}>
                <ProductPicker
                  label={`Składnik ${i + 1}`}
                  value={p.product_id ?? ''}
                  select={(v) =>
                    setParts((rows) =>
                      rows.map((r, j) => (j === i ? { ...r, ...v, product_id: v?.id ?? '' } : r)),
                    )
                  }
                  filter={(v) => v.active && ['simple', 'variant'].includes(v.kind)}
                  initial={p.product_id ? { ...p, id: p.product_id } : undefined}
                  catalogId={catalogAvailable ? catalogId : undefined}
                  contextKey={contextKey}
                  disabled={formBlocked || (catalogAvailable && !catalogId)}
                />
                <label>
                  Ilość w zestawie
                  <input
                    aria-label={`Ilość składnika ${i + 1}`}
                    type="number"
                    min="1"
                    step="1"
                    value={p.quantity}
                    onChange={(e) =>
                      setParts((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, quantity: e.target.value } : r)),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Usuń składnik ${i + 1}`}
                  onClick={() => setParts((r) => r.filter((_, j) => j !== i))}
                >
                  <X size={18} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button"
              onClick={() => setParts((r) => [...r, { product_id: '', quantity: 1 }])}
            >
              <Plus size={16} />
              Dodaj składnik
            </button>
          </section>
        )}
        <label>
          Opis
          <textarea
            name="description"
            rows={3}
            maxLength={10000}
            defaultValue={product?.description ?? ''}
          />
        </label>
        <section className="catalog-section">
          <h3>Parametry</h3>
          {attributesJson !== null ? <CatalogAttributesJsonInput value={attributesJson} onChange={setAttributesJson}/> : <>          {attrs.map(([k, v], i) => (
            <div className="catalog-part" key={i}>
              <input
                aria-label={`Nazwa parametru ${i + 1}`}
                placeholder="np. Kolor"
                value={k}
                onChange={(e) =>
                  setAttrs((a) => a.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))
                }
              />
              <input
                aria-label={`Wartość parametru ${i + 1}`}
                placeholder="np. czarny"
                value={v}
                onChange={(e) =>
                  setAttrs((a) => a.map((r, j) => (j === i ? [r[0], e.target.value] : r)))
                }
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={`Usuń parametr ${i + 1}`}
                onClick={() => setAttrs((a) => a.filter((_, j) => j !== i))}
              >
                <X size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button"
            onClick={() => setAttrs((a) => [...a, ['', '']])}
          >
            <Plus size={16} />
            Dodaj parametr
          </button>
          <button type="button" className="button" onClick={()=>{try{setAttributesJson(flatAttributesJson(attrs));setError('');}catch(e){setError((e as Error).message);}}}>Edytuj pełną strukturę JSON</button>
          </>}
        </section>
        <section className="catalog-section">
          <h3>Zdjęcia</h3>
          <div className="catalog-images">
            {images.map((src, i) => (
              <div key={src}>
                <img src={src} alt={`Zdjęcie ${i + 1}`} />
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setImages((a) => a.filter((_, j) => j !== i))}
                >
                  Usuń z produktu
                </button>
              </div>
            ))}
          </div>
          <ProductImageLibrary key={contextKey+':'+(product?.id??'new')} scope={formScope} selected={images} disabled={formBlocked} onDenied={clearLibrarySelection} onChoose={(image,originalScope)=>{
            if(!formAlive.current||formScopeRef.current!==originalScope||hasPim()||formBlocked||productCatalogsWriteLocked(contextKey)||catalogExportLocked(contextKey))return;
            setImages(old=>{if(old.includes(image.url)||old.length>=10)return old;libraryAdded.current.add(image.url);return [...old,image.url];});
          }} />
          <label>
            Zdjęcie lokalne (PNG, JPEG, WebP, do 512 KiB)
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy || images.length >= 10}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setBusy(true);
                setError('');
                try {
                  if (file.size > 524288) throw new Error('Maksymalny rozmiar zdjęcia to 512 KiB.');
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  let s = '';
                  for (const b of bytes) s += String.fromCharCode(b);
                  const image = await api('/product-images', 'POST', { data: btoa(s) });
                  setImages((a) => [...a, image.url]);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
          <div className="catalog-part">
            <input
              aria-label="Adres zdjęcia HTTPS"
              type="url"
              placeholder="https://…"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
            />
            <button
              type="button"
              className="button"
              disabled={images.length >= 10}
              onClick={() => {
                try {
                  const u = new URL(imageUrl);
                  if (u.protocol !== 'https:' || u.username || u.password) throw 0;
                  setImages((a) => [...a, imageUrl]);
                  setImageUrl('');
                } catch {
                  setError('Zdjęcie wymaga poprawnego adresu HTTPS.');
                }
              }}
            >
              <ImagePlus size={16} />
              Dodaj adres
            </button>
          </div>
        </section>
      </div>
      </fieldset>
      <div className="form-footer">
        <button type="button" className="button" onClick={close}>
          Anuluj
        </button>
        <button className="button primary" disabled={formBlocked || !formWarehouses.length || !catalogRead || (catalogAvailable && !catalogId)}>
          {writeBlocked ? 'Zapis zablokowany' : busy ? 'Zapisywanie…' : 'Zapisz produkt'}
        </button>
      </div>
    </form>
  );
}
const sample =
  'sku;name;price;kind;parent_sku;attributes;components;quantity\nQA-GRUPA;Koszulka QA;0;group;;;;0\nQA-CZARNA-M;Koszulka czarna M;79,90;variant;QA-GRUPA;"{""Kolor"":""czarny"",""Rozmiar"":""M""}";;6\nQA-DODATEK;Dodatek QA;15,00;simple;;;;10\nQA-ZESTAW;Zestaw QA;89,90;bundle;;;"[{""sku"":""QA-CZARNA-M"",""quantity"":1},{""sku"":""QA-DODATEK"",""quantity"":2}]";0';
function ImportModal({ close, saved, contextKey = '', initialCatalogId = '', readOnly = false, externalWriteBlocked = false, pimContext }: { close: () => void; saved: () => void } & CatalogFormScope) {
  const [csv, setCsv] = useState(''),
    [warehouse, setWarehouse] = useState(''),
    [warehouses, setWarehouses] = useState<any[]>([]),
    [catalogs, setCatalogs] = useState<ProductCatalog[]>([]),
    [catalogId, setCatalogId] = useState(initialCatalogId),
    [catalogAvailable, setCatalogAvailable] = useState(false),
    [catalogRead, setCatalogRead] = useState(false),
    [preview, setPreview] = useState<any>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [applied, setApplied] = useState<any>();
  useEffect(() => {
    let active = true;
    api('/warehouses')
      .then((d) => {
        if (!active) return;
        setWarehouses(d.data);
        setWarehouse(d.data[0]?.id ?? '');
      })
      .catch((e) => active && setError(e.message));
    api('/product-catalogs/options').then((d) => {
      if (!active) return;
      if (typeof d.available !== 'boolean' || (d.available && (!d.can_read || !Array.isArray(d.catalogs)))) throw Error('Niepełny odczyt katalogów importu.');
      setCatalogAvailable(d.available); setCatalogs(d.catalogs ?? []); setCatalogRead(true);
    }).catch((e) => active && setError(e.message));
    return () => { active = false; };
  }, [contextKey]);
  const hasPim=()=>!!pimContext&&pimEditorLocked(pimContext);
  const importBlocked = hasPim() || readOnly || externalWriteBlocked || productCatalogsWriteLocked(contextKey) || catalogExportLocked(contextKey) || (stocktakeAdjustmentsLocked(contextKey) || catalogStockControlLocked(contextKey)) || !catalogRead || !warehouse || (catalogAvailable && !catalogId);
  const importWarehouses = catalogAvailable ? warehouses.filter((w) => catalogs.find((c) => c.id === catalogId)?.settings.warehouse_ids.includes(w.id)) : warehouses;
  useEffect(() => { if (catalogAvailable && !importWarehouses.some((w) => w.id === warehouse)) { setWarehouse(''); setPreview(undefined); } }, [catalogId, catalogs, catalogAvailable]);
  const importScope = contextKey + ':' + readOnly + ':' + externalWriteBlocked + ':' + catalogId;
  const importScopeRef = useRef(importScope); importScopeRef.current = importScope;
  async function act(apply: boolean) {
    if (hasPim() || busy || importBlocked) return;
    const scope = importScope;
    setBusy(true);
    setError('');
    try {
      if (catalogAvailable) {
        const access = await api('/product-catalogs/options');
        if (scope !== importScopeRef.current) return;
        if (!access.available || access.read_only || !access.can_manage || !access.catalogs?.some((c: any) => c.id === catalogId && c.active)) throw Error('Brak aktualnego dostępu do katalogu importu.');
      }
      if (hasPim() || scope !== importScopeRef.current || productCatalogsWriteLocked(contextKey) || catalogExportLocked(contextKey) || (stocktakeAdjustmentsLocked(contextKey) || catalogStockControlLocked(contextKey))) return;
      if (apply) {
        const d = await api('/catalog/imports/' + preview.id + '/apply', 'POST');
        if (scope !== importScopeRef.current) return;
        setApplied(d);
        saved();
      } else
        { const d = await api('/catalog/imports/preview', 'POST', { warehouse_id: warehouse, csv, ...(catalogAvailable ? { catalog_id: catalogId } : {}) }); if (scope === importScopeRef.current) setPreview(d); }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Import katalogu CSV" close={close}>
      <div className="form-body catalog-workspace">
        <p className="notice">
          Najpierw sprawdź podgląd. Zatwierdzenie zapisuje cały plik atomowo. Stan początkowy jest
          dostępny tylko dla nowych SKU.
        </p>
        <ErrorText text={error} />
        {applied ? (
          <p role="status" className="notice">
            <Check />
            Import zakończony: {applied.created ?? 0} nowych, {applied.updated ?? 0} zmienionych
            produktów. Zarządzane parametry wymagają oddzielnego pełnego importu CSV/XML z trwałym wynikiem wierszy. Ten szybki zapis nie nadaje drugiemu etapowi ID produktów.
          </p>
        ) : (
          <>
            {catalogAvailable && <label>Katalog importu<select aria-label="Katalog importu" value={catalogId} disabled={busy || readOnly || externalWriteBlocked} onChange={(e) => { setCatalogId(e.target.value); setPreview(undefined); }}><option value="">Wybierz katalog</option>{catalogs.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><small>Tożsamość SKU, rodzic i składniki są sprawdzane w tym katalogu. SKU pozostaje unikalne w całej firmie.</small></label>}
            <label>
              Magazyn importu
              <select
                value={warehouse}
                onChange={(e) => {
                  setWarehouse(e.target.value);
                  setPreview(undefined);
                }}
              >
                <option value="">Wybierz magazyn</option>
                {importWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Plik CSV
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 500000) {
                    setError('Plik przekracza 500 kB.');
                    return;
                  }
                  setCsv(await f.text());
                  setPreview(undefined);
                }}
              />
            </label>
            <label>
              Treść CSV
              <textarea
                aria-label="Treść CSV"
                rows={9}
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setPreview(undefined);
                }}
              />
            </label>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setCsv(sample);
                setPreview(undefined);
              }}
            >
              Wstaw przykład: wariant i zestaw
            </button>
            <p className="muted">
              Obowiązkowe kolumny: sku, name, price. Separator średnik lub przecinek. Parametry i
              skład zestawu jako JSON; szczegóły w instrukcji katalogu.
            </p>
            <button className="button" disabled={busy || importBlocked || !csv} onClick={() => act(false)}>
              Sprawdź podgląd
            </button>
            {preview && (
              <>
                <h3>Podgląd: {preview.rows.length} produktów</h3>
                {preview.errors.map((e: any) => (
                  <p key={e.row + e.message} role="alert" className="import-error">
                    Wiersz {e.row}: {e.message}
                  </p>
                ))}
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>Produkt</th>
                        <th>Typ</th>
                        <th>Cena</th>
                        <th>Operacja</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r: any) => (
                        <tr key={r.row}>
                          <td>
                            {r.sku}
                            {r.matched_historical_sku === true && (
                              <p className="muted">
                                Historyczne SKU z pliku: {r.sku}. Aktualne SKU: {r.current_sku}.
                                Import zaktualizuje ten sam produkt, zachowa aktualne SKU i nie
                                utworzy duplikatu.
                              </p>
                            )}
                          </td>
                          <td>{r.name}</td>
                          <td>{kinds[r.kind]}</td>
                          <td>{money(r.price)}</td>
                          <td>{r.operation === 'create' ? 'Nowy' : 'Aktualizacja'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button
                  className="button primary"
                  disabled={busy || importBlocked || !preview.valid}
                  onClick={() => act(true)}
                >
                  Zatwierdź import
                </button>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
import {LargeImportWorkspace} from './large-import/workspace';
import {LargeImportPimRenderer} from './large-import/pim/panel';
export function CatalogPanel({
  pimContext,pimEnabled=false,pimLegacyStage,pimLegacyStageReady=false,pimNestedMappingAvailable=false,openProductId,openProductToken,
  largeImportAvailable=false,largeImportIndependentCreates=false,largeImportUnavailableReason=null,onLargeImportLockedChange,
  localWooFlowEnabled = false,
  workspaceId,
  actorId,
  readOnly,
  contextKey = '',
  onCatalogChange,
  externalWriteBlocked = false,
  exportExternalWriteBlocked = externalWriteBlocked,
  onExportLockedChange,
  refresh,
  search,
  setSearch,
  admin,
  reload,
  notify,
}: {
  pimContext?:PimContext;pimEnabled?:boolean;pimLegacyStage?:StagePort;pimNestedMappingAvailable?:boolean;pimLegacyStageReady?:boolean;openProductId?:string;openProductToken?:number;
  largeImportAvailable?:boolean;largeImportIndependentCreates?:boolean;largeImportUnavailableReason?:string|null;onLargeImportLockedChange?:(locked:boolean)=>void;
  localWooFlowEnabled?: boolean;
  workspaceId: string;
  actorId: string;
  readOnly: boolean;
  contextKey?: string;
  onCatalogChange?: (catalogId: string) => void;
  externalWriteBlocked?: boolean;
  exportExternalWriteBlocked?: boolean;
  onExportLockedChange?: (locked: boolean) => void;
  refresh: number;
  search: string;
  setSearch: (s: string) => void;
  admin: boolean;
  reload: () => void;
  notify: (s: string, error?: boolean) => void;
}) {
  const [data, setData] = useState<any>(),
    [catalogId, setCatalogId] = useState(''),
    [warehouseId,setWarehouseId]=useState(''),
    [warehouses,setWarehouses]=useState<{id:string;name:string}[]>([]),
    [warehouseError,setWarehouseError]=useState(''),
    [listFailure,setListFailure]=useState<{scope:string;message:string}|null>(null),
    [listRefresh,setListRefresh]=useState(0),
    [catalogs, setCatalogs] = useState<ProductCatalog[]>([]),
    [catalogAvailable, setCatalogAvailable] = useState(false),
    [error, setError] = useState(''),
    [page, setPage] = useState(''),
    [previous, setPrevious] = useState<string[]>([]),
    [selected, setSelected] = useState<any>(),
    [edit, setEdit] = useState(false),
    [deleting, setDeleting] = useState(false),
    [deletionBusy, setDeletionBusy] = useState(false),
    [importing, setImporting] = useState(false),
    [fileImportOpen, setFileImportOpen] = useState(false),
    [largeImportOpen,setLargeImportOpen]=useState(false),
    [largeImportPending,setLargeImportPending]=useState(false),
    [bulkOpen, setBulkOpen] = useState(false),
    [aiBatchOpen, setAiBatchOpen] = useState(false),
    [publicationOpen, setPublicationOpen] = useState(false),
    [productRulesOpen, setProductRulesOpen] = useState(false),
    [bulkEditOpen, setBulkEditOpen] = useState(false),
    [bulkEditHistoryOpen, setBulkEditHistoryOpen] = useState(false),
    [bulkEditPending, setBulkEditPending] = useState(false),
    [inventoryBulkOpen, setInventoryBulkOpen] = useState(false),
    [inventoryBulkTab, setInventoryBulkTab] = useState<'editor' | 'history'>('editor'),
    [inventoryBulkPending, setInventoryBulkPending] = useState(false),
    [priceBulkOpen, setPriceBulkOpen] = useState(false),
    [priceBulkTab, setPriceBulkTab] = useState<'editor' | 'history'>('editor'),
    [priceBulkPending, setPriceBulkPending] = useState(false),
    [translationBulkOpen, setTranslationBulkOpen] = useState(false),
    [translationBulkTab, setTranslationBulkTab] = useState<'editor' | 'history'>('editor'),
    [translationBulkPending, setTranslationBulkPending] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [bulkSelection, setBulkSelection] = useState<
      Record<string, { id: string; version: number; sku: string }>
    >({});
  const selectionLocked=bulkEditOpen||bulkEditPending||inventoryBulkOpen||inventoryBulkPending||priceBulkOpen||priceBulkPending||translationBulkOpen||translationBulkPending;
  const bulkEditAnchor = useRef<HTMLDivElement>(null);
  const [dataScope,setDataScope]=useState(''),[selectedScope,setSelectedScope]=useState('');
  const pimPending=usePimParentLock(pimContext??null);
  const hasPim=()=>!!pimContext&&pimEditorLocked(pimContext);
  const legacyBlocked=externalWriteBlocked||pimPending||largeImportPending;
  const largeImportOtherBlocked=externalWriteBlocked||pimPending||bulkEditPending||inventoryBulkPending||priceBulkPending||translationBulkPending;
  const pimOtherBlocked=externalWriteBlocked||largeImportPending||bulkEditPending||inventoryBulkPending||priceBulkPending||translationBulkPending;
  const reportLargeImportLocked=useCallback((v:boolean)=>{setLargeImportPending(v);onLargeImportLockedChange?.(v);},[onLargeImportLockedChange]);
  const loadLargeImportWarehouses=useCallback(async(signal:AbortSignal)=>{const d=await api('/warehouses','GET',undefined,{},signal);return d.data as {id:string;name:string}[];},[workspaceId,actorId,contextKey]);
  // Explicit rollout gate defaults false until the authenticated Stage route is jointly accepted.
  const stageAllowed = useRef(false);
  stageAllowed.current = pimLegacyStageReady && pimEnabled && !!pimContext && !readOnly && admin && !pimOtherBlocked && !hasPim();
  const panelScope = `${workspaceId}:${actorId}:${contextKey}:${readOnly}:${catalogId}:${warehouseId}`;
  const listScope=JSON.stringify([panelScope,search,page,refresh,listRefresh]);
  const currentListScope=useRef(listScope);currentListScope.current=listScope;
  const panelScopeRef = useRef(panelScope);
  panelScopeRef.current = panelScope;
  const selectionEpoch=useRef(0),selectionRequest=useRef<{epoch:number;abort:AbortController}|null>(null);
  const [openingProduct,setOpeningProduct]=useState(false),[selectedEpoch,setSelectedEpoch]=useState(0);
  useEffect(()=>{setOpeningProduct(false);return()=>{selectionEpoch.current++;selectionRequest.current?.abort.abort();selectionRequest.current=null;};},[panelScope]);
  useEffect(() => {
    setCatalogId('');setWarehouseId('');setWarehouses([]);setWarehouseError(''); setCatalogs([]); setCatalogAvailable(false); setSelected(undefined); setBulkSelection({}); setPage(''); setPrevious([]); onCatalogChange?.('');
  }, [workspaceId, actorId, contextKey, readOnly]);
  useEffect(()=>{
    let active=true;setWarehouseError('');
    api('/warehouses').then(d=>{if(active)setWarehouses(readCatalogWarehouses(d));})
      .catch(e=>{if(active){setWarehouses([]);setWarehouseId('');setWarehouseError(e.message);}});
    return()=>{active=false;};
  },[workspaceId,actorId,contextKey,readOnly,refresh]);
  useEffect(() => {
    let active = true;
    api('/product-catalogs/options').then((d) => {
      if (!active) return;
      if (typeof d.available !== 'boolean' || (d.available && (!d.can_read || !Array.isArray(d.catalogs)))) throw Error('Niepełny odczyt katalogów produktów.');
      setCatalogAvailable(d.available); setCatalogs(d.catalogs ?? []);
    }).catch((e) => active && setError(e.message));
    return () => { active = false; };
  }, [workspaceId, actorId, contextKey, readOnly, refresh]);
  useEffect(() => {
    if (
      bulkEditOpen ||
      bulkEditHistoryOpen ||
      inventoryBulkOpen ||
      priceBulkOpen ||
      translationBulkOpen ||
      fileImportOpen ||
      exportOpen
    )
      bulkEditAnchor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [
    bulkEditOpen,
    bulkEditHistoryOpen,
    inventoryBulkOpen,
    priceBulkOpen,
    translationBulkOpen,
    fileImportOpen,
    exportOpen,
  ]);
  useEffect(() => {
    let active=true;const abort=new AbortController();
    setData(undefined);setListFailure(null);
    Promise.resolve().then(()=>api(catalogListQuery({search,page,catalogId,warehouseId}),'GET',undefined,{},abort.signal))
      .then(d=>{if(active&&currentListScope.current===listScope){const pageData=readCatalogList(d,catalogId,page);setDataScope(listScope);setData(pageData);}})
      .catch(e=>{if(active&&currentListScope.current===listScope)setListFailure({scope:listScope,message:e.message});});
    return()=>{active=false;abort.abort();};
  },[listScope]);
  useEffect(()=>{if(openProductId&&!hasPim())void open(openProductId);},[openProductId,openProductToken,workspaceId,actorId,contextKey,readOnly]);
  async function open(id: string) {
    if(hasPim())return;
    const captured = panelScope,epoch=++selectionEpoch.current,abort=new AbortController();
    selectionRequest.current?.abort.abort();selectionRequest.current={epoch,abort};
    setSelected(undefined);setSelectedScope('');setEdit(false);setDeleting(false);setOpeningProduct(true);
    const current=()=>selectionEpoch.current===epoch&&selectionRequest.current?.epoch===epoch&&panelScopeRef.current===captured&&!abort.signal.aborted;
    try {
      const product = await api('/products/' + id,'GET',undefined,{},abort.signal);
      if (!current() || hasPim()) return;
      if (product?.id !== id) throw Error('Odczyt nie odpowiada wybranemu produktowi.');
      if (catalogId && product.catalog_id !== catalogId) throw Error('Produkt nie należy do wybranego katalogu.');
      setSelectedScope(captured);
      setSelectedEpoch(epoch);
      setSelected(product);
    } catch (e) {
      if(current()&&!hasPim())notify((e as Error).message, true);
    } finally {
      if(current()){selectionRequest.current=null;setOpeningProduct(false);}
    }
  }
  const visibleData=dataScope===listScope?data:undefined;
  const visibleListFailure=listFailure?.scope===listScope?listFailure.message:'';
  const selectionSummary=catalogSelectionSummary(bulkSelection,visibleData?.data??[]);
  const visibleWarehouses=catalogId&&catalogAvailable?warehouses.filter(w=>catalogs.find(c=>c.id===catalogId)?.settings.warehouse_ids.includes(w.id)):warehouses;
  function clearListSelection(){setPage('');setPrevious([]);setBulkSelection({});setSelected(undefined);setError('');}
  return (
    <>
      {externalWriteBlocked && <p role="status">Pozostałe kontrolki katalogu, także historia starszych edytorów, są chwilowo zablokowane. Dokładne ponowienie eksportu i lista jego profili pozostają dostępne poniżej.</p>}
      <fieldset disabled={legacyBlocked} aria-label="Lista i pozostałe operacje katalogu" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <section className="panel">
        <div className="table-toolbar catalog-publication-toolbar">
          {catalogAvailable && <label>Katalog listy produktów<select aria-label="Katalog listy produktów" value={catalogId} disabled={legacyBlocked || selectionLocked} onChange={(e) => { const id = e.target.value; setCatalogId(id);setWarehouseId(''); onCatalogChange?.(id);clearListSelection(); }}><option value="">Wszystkie katalogi</option>{catalogs.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' · domyślny' : ''}{!c.active ? ' · nieaktywny' : ''}</option>)}</select></label>}
          <label>Stany w magazynie<select aria-label="Stany w magazynie" value={warehouseId} disabled={selectionLocked||!!warehouseError} onChange={e=>{setWarehouseId(e.target.value);clearListSelection();}}><option value="">Wszystkie magazyny</option>{visibleWarehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
          <div className="search-field">
            <Search size={17} />
            <input
              aria-label="Szukaj produktów"
              placeholder="Nazwa, SKU lub EAN"
              value={search}
              disabled={selectionLocked}
              maxLength={200}
              onChange={(e) => {
                setSearch(e.target.value);
                clearListSelection();
              }}
            />
          </div>
          {admin && (
            <button
              className="button"
              disabled={translationBulkOpen || translationBulkPending}
              onClick={() => setBulkOpen(true)}
            >
              Masowe tłumaczenia · {Object.keys(bulkSelection).length}
            </button>
          )}
          {admin && (
            <button
              className="button"
              disabled={Object.keys(bulkSelection).length < 1 || Object.keys(bulkSelection).length > 50}
              title="Zaznacz od 1 do 50 produktów."
              onClick={() => setAiBatchOpen(true)}
            >
              Partia AI (maks. 50) · {Object.keys(bulkSelection).length}
            </button>
          )}
          {admin && (
            <button
              className="button"
              disabled={translationBulkOpen || translationBulkPending}
              onClick={() => setPublicationOpen(true)}
            >
              Publikacja tłumaczeń Shopify · {Object.keys(bulkSelection).length}
            </button>
          )}
          {admin && (
            <button
              className="button"
              disabled={
                Object.keys(bulkSelection).length < 1 || Object.keys(bulkSelection).length > 100
              }
              title="Jawnie zaznacz od 1 do 100 produktów. Większego wyboru nie obcinamy."
              onClick={() => setProductRulesOpen(true)}
            >
              Reguły produktów (maks. 100) · {Object.keys(bulkSelection).length}
            </button>
          )}
          {admin && (
            <button
              className="button"
              disabled={
                bulkEditPending ||
                inventoryBulkPending ||
                priceBulkPending ||
                translationBulkPending ||
                Object.keys(bulkSelection).length < 1 ||
                Object.keys(bulkSelection).length > 500
              }
              onClick={() => {
                setBulkEditOpen(true);
                setBulkEditHistoryOpen(false);
                setInventoryBulkOpen(false);
                setPriceBulkOpen(false);
                setTranslationBulkOpen(false);
              }}
            >
              Edytuj w arkuszu · {Object.keys(bulkSelection).length}
            </button>
          )}
          <button
            className="button"
            disabled={
              bulkEditPending || inventoryBulkPending || priceBulkPending || translationBulkPending
            }
            onClick={() => {
              setBulkEditHistoryOpen(true);
              setBulkEditOpen(false);
              setInventoryBulkOpen(false);
              setPriceBulkOpen(false);
              setTranslationBulkOpen(false);
            }}
          >
            Historia edycji
          </button>
          {admin && (
            <button
              className="button"
              disabled={
                bulkEditPending ||
                inventoryBulkPending ||
                priceBulkPending ||
                translationBulkPending ||
                Object.keys(bulkSelection).length < 1 ||
                Object.keys(bulkSelection).length > 500
              }
              onClick={() => {
                setBulkEditOpen(false);
                setBulkEditHistoryOpen(false);
                setPriceBulkOpen(false);
                setTranslationBulkOpen(false);
                setInventoryBulkTab('editor');
                setInventoryBulkOpen(true);
              }}
            >
              Stany i lokalizacje · {Object.keys(bulkSelection).length}
            </button>
          )}
          <button
            className="button"
            disabled={
              bulkEditPending || inventoryBulkPending || priceBulkPending || translationBulkPending
            }
            onClick={() => {
              setBulkEditOpen(false);
              setBulkEditHistoryOpen(false);
              setPriceBulkOpen(false);
              setTranslationBulkOpen(false);
              setInventoryBulkTab('history');
              setInventoryBulkOpen(true);
            }}
          >
            Historia stanów i lokalizacji
          </button>
          {admin && (
            <button
              className="button"
              disabled={
                bulkEditPending ||
                inventoryBulkPending ||
                priceBulkPending ||
                translationBulkPending ||
                Object.keys(bulkSelection).length < 1 ||
                Object.keys(bulkSelection).length > 500
              }
              onClick={() => {
                setBulkEditOpen(false);
                setBulkEditHistoryOpen(false);
                setInventoryBulkOpen(false);
                setTranslationBulkOpen(false);
                setPriceBulkTab('editor');
                setPriceBulkOpen(true);
              }}
            >
              Ceny w cenniku · {Object.keys(bulkSelection).length}
            </button>
          )}
          <button
            className="button"
            disabled={
              bulkEditPending || inventoryBulkPending || priceBulkPending || translationBulkPending
            }
            onClick={() => {
              setBulkEditOpen(false);
              setBulkEditHistoryOpen(false);
              setInventoryBulkOpen(false);
              setTranslationBulkOpen(false);
              setPriceBulkTab('history');
              setPriceBulkOpen(true);
            }}
          >
            Historia cen w cennikach
          </button>
          {admin && (
            <button
              className="button"
              disabled={
                bulkEditPending ||
                inventoryBulkPending ||
                priceBulkPending ||
                translationBulkPending ||
                Object.keys(bulkSelection).length < 1 ||
                Object.keys(bulkSelection).length > 500
              }
              onClick={() => {
                setBulkEditOpen(false);
                setBulkEditHistoryOpen(false);
                setInventoryBulkOpen(false);
                setPriceBulkOpen(false);
                setTranslationBulkTab('editor');
                setTranslationBulkOpen(true);
              }}
            >
              Wersje językowe · {Object.keys(bulkSelection).length}
            </button>
          )}
          <button
            className="button"
            disabled={
              bulkEditPending || inventoryBulkPending || priceBulkPending || translationBulkPending
            }
            onClick={() => {
              setBulkEditOpen(false);
              setBulkEditHistoryOpen(false);
              setInventoryBulkOpen(false);
              setPriceBulkOpen(false);
              setTranslationBulkTab('history');
              setTranslationBulkOpen(true);
            }}
          >
            Historia wersji językowych
          </button>
          {Object.keys(bulkSelection).length > 0 && (
            <button
              className="button"
              disabled={
                bulkEditPending ||
                bulkEditOpen ||
                inventoryBulkOpen ||
                inventoryBulkPending ||
                priceBulkOpen ||
                priceBulkPending ||
                translationBulkOpen ||
                translationBulkPending
              }
              onClick={() => setBulkSelection({})}
            >
              Wyczyść wybór
            </button>
          )}
          <span className="result-count">{visibleData?.data.length ?? '…'} na stronie</span>
          <button type="button" className="button" disabled={selectionLocked} onClick={()=>{setBulkSelection({});setListRefresh(v=>v+1);}}>Odśwież listę</button>
          <button
            className="button"
            disabled={
              bulkEditPending || inventoryBulkPending || priceBulkPending || translationBulkPending
            }
            onClick={() => setFileImportOpen(true)}
          >
            <Upload size={16} />
            Import CSV / XML i historia
          </button>
          {admin && (
            <button className="button" onClick={() => setImporting(true)}>
              <Upload size={16} />
              Import CSV — szybki
            </button>
          )}
        </div>
        <ErrorText text={error} />
        <ErrorText text={warehouseError} />
        <ErrorText text={visibleListFailure} />
        <p className="info-body" role="status">Stany: {warehouseId?visibleWarehouses.find(w=>w.id===warehouseId)?.name??'wybrany magazyn':'suma magazynów zgodnie z polityką dostępności'}. Wybrano {selectionSummary.total} z maksymalnie 500 produktów: {selectionSummary.visible} na tej stronie, {selectionSummary.otherPages} na pozostałych. Zmiana wyszukiwania, katalogu lub magazynu oraz odświeżenie listy czyści wybór.</p>
        {!visibleData ? (
          <p className="info-body">{visibleListFailure?'Lista nie została wczytana. Użyj „Odśwież listę”, aby ponowić odczyt.':'Wczytywanie katalogu…'}</p>
        ) : visibleData.data.length===0 ? (
          <p className="info-body">Brak produktów dla tego wyszukiwania i katalogu. Zmień kryteria lub zaimportuj plik CSV / XML.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Wybierz produkty z tej strony"
                      disabled={
                        bulkEditPending ||
                        bulkEditOpen ||
                        inventoryBulkOpen ||
                        inventoryBulkPending ||
                        priceBulkOpen ||
                        priceBulkPending ||
                        translationBulkOpen ||
                        translationBulkPending
                      }
                      checked={
                        visibleData.data.length > 0 && visibleData.data.every((p: any) => !!bulkSelection[p.id])
                      }
                      onChange={(e) => {
                        const checked = e.target.checked;
                        try{setBulkSelection(toggleCatalogPage(bulkSelection,visibleData.data,checked));setError('');}catch(e){setError((e as Error).message);}
                      }}
                    />
                  </th>
                  <th>Produkt</th>
                  <th>SKU / EAN</th>
                  <th>Typ</th>
                  <th>Cena brutto</th>
                  <th>Dostępne</th>
                  <th>Rezerwacje</th>
                </tr>
              </thead>
              <tbody>
                {visibleData.data.map((p: any) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={'Wybierz ' + p.sku}
                        checked={!!bulkSelection[p.id]}
                        disabled={
                          bulkEditPending ||
                          inventoryBulkOpen ||
                          inventoryBulkPending ||
                          priceBulkOpen ||
                          priceBulkPending ||
                          translationBulkOpen ||
                          translationBulkPending ||
                          bulkEditOpen ||
                          (!bulkSelection[p.id] && Object.keys(bulkSelection).length >= 500)
                        }
                        onChange={(e) => {
                          const checked = e.target.checked;
                          try{setBulkSelection(toggleCatalogPage(bulkSelection,[p],checked));setError('');}catch(e){setError((e as Error).message);}
                        }}
                      />
                    </td>
                    <td>
                      <div className="product-cell">
                        {p.images[0] ? (
                          <img className="catalog-thumb" src={p.images[0]} alt="" />
                        ) : (
                          <div className="product-icon color-0">
                            <Package size={23} />
                          </div>
                        )}
                        <div>
                          <button className="text-button" onClick={() => open(p.id)}>
                            {p.name}
                          </button>
                          <small>
                            {p.category} · {p.active ? 'Aktywny' : 'Nieaktywny'}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      {p.sku}
                      <small>{p.ean || 'Brak EAN'}</small>
                    </td>
                    <td>{kinds[p.kind]}</td>
                    <td>{money(p.price)}</td>
                    <td>
                      {p.kind === 'group' ? '—' : p.available + ' szt.'}
                      {p.kind === 'bundle' && <small>Ze składników</small>}
                    </td>
                    <td>{['group', 'bundle'].includes(p.kind) ? '—' : p.reserved}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <button
            className="button"
            disabled={!previous.length||selectionLocked||!visibleData}
            onClick={() => {
              setPage(previous.at(-1)!);
              setPrevious((p) => p.slice(0, -1));
            }}
          >
            <ArrowLeft size={16} />
            Poprzednia
          </button>
          <span>Strona {previous.length + 1}</span>
          <button
            className="button"
            disabled={!visibleData?.meta.has_more||selectionLocked}
            onClick={() => {
              setPrevious((p) => [...p, page]);
              setPage(visibleData.meta.cursor);
            }}
          >
            Następna
          </button>
        </div>
      </section>
      </fieldset>
      <button
        className="button"
        disabled={pimPending || bulkEditPending || inventoryBulkPending || priceBulkPending || translationBulkPending}
        onClick={() => {if(!hasPim())setExportOpen(true);}}
      >
        Eksport CSV / XML
      </button>
      {pimContext&&<PimCatalogTools enabled={pimEnabled} context={pimContext} catalogId={catalogId} products={(visibleData?.data??[]).filter((x:any)=>x.catalog_id===catalogId)} transport={api} externalWriteBlocked={pimOtherBlocked} onChanged={reload}/>}
      <button type="button" disabled={!catalogId||!catalogAvailable||largeImportOtherBlocked} onClick={()=>setLargeImportOpen(v=>!v)}>Duży import CSV / XML</button>
      {!catalogId&&<p>Wybierz katalog produktów, aby otworzyć duży import.</p>}
      {largeImportUnavailableReason==='LEGACY_IMPORT_RECONCILIATION_REQUIRED'&&<p role="status">Duży import w tej organizacji jest wstrzymany. Wcześniejsze importy wymagają ustalenia wyniku; ich dane zostały zachowane.</p>}
      {largeImportOpen&&catalogId&&<LargeImportWorkspace key={workspaceId+':'+actorId+':'+contextKey+':'+catalogId} context={{tenantId:workspaceId,userId:actorId,apiKeyId:null}} catalogId={catalogId} catalogName={catalogs.find(c=>c.id===catalogId)?.name??'Wybrany katalog'} available={largeImportAvailable} independentCreates={largeImportIndependentCreates} canManage={admin} readOnly={readOnly} externalWriteBlocked={largeImportOtherBlocked} onLockedChange={reportLargeImportLocked} loadWarehouses={loadLargeImportWarehouses} renderPim={pimEnabled&&pimContext?({job,http,blocked,refresh})=><LargeImportPimRenderer job={job} http={http} context={pimContext} catalogId={catalogId} transport={api} blocked={blocked} nestedAvailable={pimNestedMappingAvailable} onChanged={refresh}/>:undefined}/>}
      <div ref={bulkEditAnchor}>
      {exportOpen && (
        <CatalogExportPanel
          key={contextKey}
          workspaceId={workspaceId}
          contextKey={contextKey}
          selectedIds={Object.keys(bulkSelection)}
          initialFilter={{ search, active: 'all' }}
          readOnly={readOnly}
          externalWriteBlocked={pimPending || exportExternalWriteBlocked || bulkEditPending || inventoryBulkPending || priceBulkPending || translationBulkPending}
          onLockedChange={onExportLockedChange}
          onError={(message) => notify(message, true)}
          onClose={() => setExportOpen(false)}
        />
      )}
        {fileImportOpen && (
          <CatalogFileImportPanel
            key={workspaceId + ':' + actorId + ':' + admin + ':' + readOnly}
            contextKey={workspaceId + ':' + actorId + ':' + admin + ':' + readOnly}
            readOnly={readOnly}
            onClose={() => {if(!hasPim())setFileImportOpen(false);}}
            onApplied={reload}
            isExternalWriteBlocked={()=>legacyBlocked||hasPim()}
            renderTypedContinuation={pimEnabled&&pimContext ? custody=>pimLegacyStage ? <CorePimContinuation key={'core-pim:'+custody.context_key+':'+custody.execution.id} context={pimContext} custody={custody} transport={api} stagePort={pimLegacyStage} nestedMappingAvailable={pimNestedMappingAvailable===true} externalWriteBlocked={pimOtherBlocked} onChanged={reload}/> : <AuthenticatedCorePimContinuation key={'core-pim-auth:'+custody.context_key+':'+custody.execution.id} context={pimContext} custody={custody} transport={api} nestedMappingAvailable={pimNestedMappingAvailable===true} stageReady={pimLegacyStageReady&&pimEnabled} canStage={()=>stageAllowed.current} externalWriteBlocked={pimOtherBlocked} onChanged={reload}/> : undefined}
            onError={(message) => notify(message, true)}
          />
        )}
      <fieldset disabled={legacyBlocked} aria-label="Pozostałe edytory katalogu" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div>
        {translationBulkOpen && (
          <ProductTranslationBulkEdit
            key={
              workspaceId + ':' + actorId + ':' + admin + ':' + readOnly + ':' + translationBulkTab
            }
            selection={Object.values(bulkSelection)}
            readOnly={readOnly}
            initialTab={translationBulkTab}
            onChanged={reload}
            onPendingChange={setTranslationBulkPending}
            onClose={() => {
              if (!translationBulkPending) setTranslationBulkOpen(false);
            }}
          />
        )}
        {priceBulkOpen && (
          <PriceBulkEdit
            key={workspaceId + ':' + actorId + ':' + admin + ':' + readOnly + ':' + priceBulkTab}
            selection={Object.values(bulkSelection)}
            readOnly={readOnly}
            initialTab={priceBulkTab}
            onChanged={reload}
            onPendingChange={setPriceBulkPending}
            onClose={() => {
              if (!priceBulkPending) setPriceBulkOpen(false);
            }}
          />
        )}
        {inventoryBulkOpen && (
          <InventoryBulkEdit
            contextKey={contextKey}
            key={
              workspaceId + ':' + actorId + ':' + admin + ':' + readOnly + ':' + inventoryBulkTab
            }
            productIds={Object.keys(bulkSelection)}
            readOnly={readOnly}
            externalWriteBlocked={legacyBlocked}
            initialTab={inventoryBulkTab}
            onChanged={reload}
            onPendingChange={setInventoryBulkPending}
            onClose={() => {
              if (!inventoryBulkPending) setInventoryBulkOpen(false);
            }}
          />
        )}
        {bulkEditOpen && (
          <CatalogBulkEdit
            key={'catalog-bulk-edit:' + workspaceId + ':' + actorId + ':' + admin + ':' + readOnly}
            selection={Object.values(bulkSelection)}
            workspaceId={workspaceId}
            actorId={actorId}
            admin={admin}
            readOnly={readOnly}
            onChanged={reload}
            onPendingChange={setBulkEditPending}
            onClose={() => {
              if (!bulkEditPending) setBulkEditOpen(false);
            }}
          />
        )}
        {bulkEditHistoryOpen && (
          <CatalogBulkEditHistory
            key={'catalog-bulk-edit-history:' + workspaceId + ':' + actorId + ':' + admin + ':' + readOnly}
            readOnly={readOnly}
            onClose={() => setBulkEditHistoryOpen(false)}
          />
        )}
      </div>
      {aiBatchOpen && (
        <Dialog title="Partia AI katalogu" close={() => setAiBatchOpen(false)}>
          <CatalogAiBatches selection={Object.values(bulkSelection)} saved={() => reload()} />
        </Dialog>
      )}
      {bulkOpen && (
        <Dialog title="Masowe tłumaczenia DeepL" close={() => setBulkOpen(false)}>
          <DeepLBatches
            selection={Object.values(bulkSelection)}
            saved={(id) => {
              setBulkSelection((old) => {
                const next = { ...old };
                delete next[id];
                return next;
              });
              reload();
            }}
          />
        </Dialog>
      )}
      {publicationOpen && (
        <Dialog title="Masowa publikacja tłumaczeń Shopify" close={() => setPublicationOpen(false)}>
          <ShopifyTranslationBatches selection={Object.values(bulkSelection)} />
        </Dialog>
      )}
      {admin && productRulesOpen && (
        <Dialog title="Reguły dla wybranych produktów" close={() => setProductRulesOpen(false)}>
          <ProductRuleBulkPreview
            key={workspaceId + ':' + actorId + ':admin'}
            workspaceId={workspaceId}
            admin={admin}
            readOnly={readOnly}
            refresh={refresh}
            products={Object.values(bulkSelection).map((p) => ({
              product_id: p.id,
              version: p.version,
              sku: p.sku,
            }))}
            onChanged={reload}
          />
        </Dialog>
      )}
      {importing && <ImportModal pimContext={pimContext} close={() => setImporting(false)} saved={reload} contextKey={contextKey} initialCatalogId={catalogId} readOnly={readOnly} externalWriteBlocked={legacyBlocked} />}
      {openingProduct&&<p role="status">Odczytywanie karty produktu…</p>}
      {selected && selectedScope===panelScope && selectedEpoch===selectionEpoch.current && !openingProduct && (
        <Dialog
          title={edit ? 'Edycja produktu' : deleting ? 'Usuń produkt' : 'Karta produktu'}
          close={() => {if(deletionBusy)return;if(deleting){setDeleting(false);return;}if(!hasPim())setSelected(undefined);}}
        >
          {deleting ? (
            <ProductDeletionConfirm
              key={'deletion-' + selected.id}
              product={selected}
              blocked={readOnly || legacyBlocked || hasPim() || productCatalogsWriteLocked(contextKey)}
              cancel={() => setDeleting(false)}
              onBusyChange={setDeletionBusy}
              deleted={(result) => {
                setBulkSelection((current) => {const {[result.id]: _deleted, ...rest} = current; return rest;});
                setDeleting(false);
                setSelected(undefined);
                reload();
                notify(`Usunięto produkt ${result.sku}. SKU pozostaje zarezerwowane.`);
              }}
            />
          ) : edit ? (
            <ProductForm
              pimContext={pimContext}
              key={selected.id}
              product={selected}
              canEditSku={admin && !readOnly}
              contextKey={contextKey}
              readOnly={readOnly}
              externalWriteBlocked={legacyBlocked}
              close={() => {if(!hasPim())setSelected(undefined);}}
              saved={() => {
                reload();
                notify('Zapisano produkt.');
              }}
            />
          ) : (
            <div className="form-body catalog-workspace">
              <div className="panel-heading">
                <div>
                  <h2>{selected.name}</h2>
                  <p>
                    {selected.sku} · {kinds[selected.kind]} · {money(selected.price)} · VAT{' '}
                    {selected.vat}%
                  </p>
                </div>
                {admin && (
                  <div className="inline-actions">
                  <button className="button primary" disabled={openingProduct || readOnly || legacyBlocked || productCatalogsWriteLocked(contextKey)} onClick={() => { if (selectedEpoch===selectionEpoch.current && !selectionRequest.current && !openingProduct && !readOnly && !legacyBlocked && !hasPim() && !productCatalogsWriteLocked(contextKey)) setEdit(true); }}>
                    Edytuj produkt
                  </button>
                  <button className="button danger" disabled={openingProduct || readOnly || legacyBlocked || productCatalogsWriteLocked(contextKey)} onClick={() => { if (selectedEpoch===selectionEpoch.current && !selectionRequest.current && !openingProduct && !readOnly && !legacyBlocked && !hasPim() && !productCatalogsWriteLocked(contextKey)) setDeleting(true); }}>
                    Usuń produkt
                  </button>
                  </div>
                )}
              </div>
              <div className="catalog-images">
                {selected.images.map((src: string, i: number) => (
                  <img src={src} key={src} alt={`Zdjęcie produktu ${i + 1}`} />
                ))}
              </div>
              <fieldset disabled={legacyBlocked} style={{border:0,padding:0,margin:0,minWidth:0}}>
              <OdooImages
                key={'odoo-images-' + selected.id}
                product={selected}
                admin={admin}
                saved={() => {
                  open(selected.id);
                  reload();
                  notify('Dodano zdjęcie Odoo.');
                }}
              />
              <p className="catalog-description">{selected.description || 'Brak opisu'}</p>
              <ProductLogisticsDetails product={selected} />
              {localWooFlowEnabled && (
                <LocalWooFlow
                  key={workspaceId + ':' + actorId + ':' + selected.id}
                  tenantId={workspaceId}
                  userId={actorId}
                  productId={selected.id}
                  admin={admin}
                  readOnly={readOnly}
                  externalWriteBlocked={externalWriteBlocked || legacyBlocked}
                />
              )}
              {admin && (
                <CatalogAi
                  key={'catalog-ai-' + selected.id}
                  product={selected}
                  saved={() => {
                    open(selected.id);
                    reload();
                    notify('Zapisano treść po przeglądzie AI.');
                  }}
                />
              )}
              {admin && (
                <>
                  <CatalogAiAttributes
                    key={'catalog-ai-attributes-' + selected.id}
                    product={selected}
                    saved={() => {
                      open(selected.id);
                      notify('Zapisano parametry PIM po przeglądzie AI.');
                    }}
                  />
                  <CatalogAiImages
                    key={'catalog-ai-images-' + selected.id}
                    product={selected}
                    saved={() => {
                      open(selected.id);
                      reload();
                      notify('Zapisano nowe zdjęcie po przeglądzie AI.');
                    }}
                  />
                  <CatalogAiMatch
                    key={'catalog-ai-match-' + selected.id}
                    product={selected}
                    saved={() => notify('Zapisano dopasowanie kategorii do oferty.')}
                  />
                </>
              )}
              {admin && (
                <DeepLCatalog
                  key={'deepl-' + selected.id}
                  product={selected}
                  saved={() => {
                    open(selected.id);
                    reload();
                    notify('Zapisano tłumaczenie DeepL po przeglądzie.');
                  }}
                />
              )}
              {admin && (
                <ShopifyTranslations
                  key={'shopify-translations-' + selected.id}
                  product={selected}
                />
              )}
              </fieldset>
              {pimContext&&selected.catalog_id&&(pimEnabled||hasPim())&&<PimDictionaryEditor key={'typed-product:'+panelScope+':'+selected.id} context={pimContext} catalogId={selected.catalog_id} productId={selected.id} transport={api} externalWriteBlocked={pimOtherBlocked} onChanged={()=>{reload();}}/>}
              <CatalogAttributesRead attributes={selected.attributes}/>
              <ProductTaxProfile key={'tax-profile-' + selected.id} productId={selected.id} admin={admin} readOnly={readOnly} blocked={legacyBlocked || hasPim() || productCatalogsWriteLocked(contextKey)} />
              {selected.variants.length > 0 && (
                <section className="catalog-section">
                  <h3>Warianty</h3>
                  {selected.variants.map((v: any) => (
                    <p key={v.id}>
                      <button className="text-button" onClick={() => open(v.id)}>
                        {v.sku} · {v.name}
                      </button>
                    </p>
                  ))}
                </section>
              )}
              {selected.components.length > 0 && (
                <section className="catalog-section">
                  <h3>Skład zestawu</h3>
                  {selected.components.map((v: any) => (
                    <p key={v.product_id}>
                      <button className="text-button" onClick={() => open(v.product_id)}>
                        {v.sku} · {v.name}
                      </button>{' '}
                      × {v.quantity}
                    </p>
                  ))}
                  <p className="muted">Zmiana składu nie zmieni istniejących zamówień.</p>
                </section>
              )}
              {selected.stock.length > 0 && (
                <section className="catalog-section">
                  <h3>Stany magazynowe</h3>
                  {selected.stock.map((v: any) => (
                    <p key={v.warehouse_id}>
                      {v.warehouse_name}: {v.available} dostępnych, {v.reserved} zarezerwowanych ·{' '}
                      {v.location}
                    </p>
                  ))}
                </section>
              )}
            </div>
          )}
        </Dialog>
      )}
      </fieldset>
      </div>
    </>
  );
}
