import { useEffect, useRef, useState } from 'react';
import { api, date } from './api';
import { PriceListPicker } from './pricing';
import {offerSyncCommandKey,readOfferSyncCommand,readOfferSyncConfig,readOfferSyncCommands,saveOfferSyncCommand,offerSyncCommandPending,acknowledgeOfferSyncCommand,observeOfferSyncCommand,type OfferSyncContext,type OfferSyncMarker,type OfferSyncCommand} from './offer-sync-commands';
const states: Record<string, string> = {queued:'Zapis w kolejce',verified:'Potwierdzono',unchanged:'Bez zmiany',waiting:'Oczekiwanie na zapis',blocked:'Wymaga uzgodnienia',error:'Błąd'};
const UPDATED='dyna:offer-sync-command-updated';
export function OfferSyncPanel({channelId,context}:{channelId:string;context?:OfferSyncContext}){
 const identity=channelId+':'+(context?[context.tenantId,context.userId,context.admin,context.readOnly,context.externalWriteBlocked].join(':'):'missing'),latest=useRef(identity),alive=useRef(false),generation=useRef(0),flight=useRef(false);latest.current=identity;
 const [cut,setCut]=useState<{scope:string;value:any}|null>(null),[warehouses,setWarehouses]=useState<any[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[query,setQuery]=useState(''),[search,setSearch]=useState(''),[price,setPrice]=useState(true),[list,setList]=useState<any>(null),[notice,setNotice]=useState(''),[commands,setCommands]=useState<OfferSyncMarker[]>([]),[custodyError,setCustodyError]=useState('');
 const data=cut?.scope===identity?cut.value:null,path='/integrations/'+channelId+'/offer-sync?limit=25&search='+encodeURIComponent(query),base='/integrations/'+channelId+'/offer-sync',pending=commands.filter(offerSyncCommandPending),blocked=busy||!context?.admin||context.readOnly||context.externalWriteBlocked||!!custodyError||pending.length>0;
 const current=(stamp:number)=>alive.current&&latest.current===identity&&generation.current===stamp;
 function setData(value:any){if(latest.current!==identity||!alive.current)return;setCut(previous=>({scope:identity,value:typeof value==='function'?value(previous?.scope===identity?previous.value:null):value}));}
 function readJournal(){if(!context)return[];return readOfferSyncCommands(sessionStorage,localStorage,context,channelId);}
 function updateJournal(){try{const rows=readJournal();if(latest.current===identity){setCommands(rows);setCustodyError('');}return rows;}catch{if(latest.current===identity){setCommands([]);setCustodyError('Nie można odczytać zachowanej próby. Zapis ustawień pozostaje zablokowany.');}throw Error('Nie można potwierdzić oryginalnego polecenia.');}}
 function persist(c:OfferSyncContext,m:OfferSyncMarker){const rows=saveOfferSyncCommand(sessionStorage,localStorage,c,channelId,m);if(latest.current===identity)setCommands(rows);window.dispatchEvent(new CustomEvent(UPDATED,{detail:offerSyncCommandKey(c,channelId)}));return rows;}
 async function actor(stamp:number,write:boolean){if(!context||!current(stamp))throw Error('Widok lub firma uległy zmianie.');const me=await api('/auth/me');if(!current(stamp)||me.user?.tenant_id!==context.tenantId||me.user?.id!==context.userId||me.user?.role!=='admin'||!context.admin||write&&(context.readOnly||context.externalWriteBlocked||me.restore_preview!==false||Object.hasOwn(me,'read_only')&&me.read_only!==false))throw Error('Wymagana aktualna sesja administratora tej firmy.');}
 function readData(d:any){if(!context||d?.channel?.id!==channelId||!Array.isArray(d.data)||!Array.isArray(d.jobs)||!d.meta||typeof d.channel.settings?.simulation!=='boolean')throw Error('Odczytano inny kanał lub niepełny harmonogram.');if(d.config!==null)readOfferSyncConfig(d.config,context,channelId);return d;}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;++generation.current;};},[]);
 useEffect(()=>{setCut(null);setWarehouses([]);setCommands([]);setCustodyError('');setError('');setNotice('');setBusy(false);flight.current=false;setPrice(true);setList(null);try{updateJournal();}catch{};const changed=(e:Event)=>{const key=e instanceof StorageEvent?e.key:(e as CustomEvent).detail;if(context&&key===offerSyncCommandKey(context,channelId))try{updateJournal();}catch{}};window.addEventListener('storage',changed);window.addEventListener(UPDATED,changed);return()=>{window.removeEventListener('storage',changed);window.removeEventListener(UPDATED,changed);};},[identity]);
 useEffect(()=>{let active=true;const stamp=++generation.current;if(!context?.admin)return;void(async()=>{await actor(stamp,false);const[d,w]=await Promise.all([api(path),api('/warehouses')]);await actor(stamp,false);if(active&&current(stamp)){readData(d);if(!Array.isArray(w.data))throw Error('Niepełny odczyt magazynów.');setData(d);setWarehouses(w.data);}})().catch(e=>active&&current(stamp)&&setError(e.message));return()=>{active=false;++generation.current;};},[identity,path,refresh]);
 useEffect(()=>{if(data){setPrice(data.config?.price??true);setList(data.price_list??null);}},[identity,data?.config?.version]);
 useEffect(()=>{if(busy||pending.length||data?.data.length>25)return;if(!data?.config?.enabled&&!data?.data.some((i:any)=>i.plan_state==='queued'))return;const t=setInterval(()=>setRefresh(v=>v+1),2000);return()=>clearInterval(t);},[data?.config?.enabled,data?.data,busy,pending.length]);
 async function action(work:(stamp:number)=>Promise<void>){if(flight.current||busy||!context||!alive.current)return;const stamp=generation.current;flight.current=true;setBusy(true);setError('');setNotice('');try{if(!navigator.locks?.request)throw Error('Brak bezpiecznej blokady kart. Zapis ustawień jest niedostępny.');await navigator.locks.request(offerSyncCommandKey(context,channelId),{mode:'exclusive'},async()=>{if(!current(stamp))throw Error('Widok lub firma uległy zmianie.');await work(stamp);});}catch(e){if(current(stamp))setError((e as Error).message);}finally{flight.current=false;if(current(stamp))setBusy(false);}}
 function acknowledge(c:OfferSyncContext,m:OfferSyncMarker,v:any){const done=acknowledgeOfferSyncCommand(m,v);persist(c,done);return done;}
 async function dispatch(c:OfferSyncContext,m:OfferSyncMarker,suffix:string,stamp:number){let acknowledged:OfferSyncMarker|undefined;try{const result=await api(base+suffix,'POST',m.body,{},undefined,(value,response)=>{if(!response.ok)return;if(response.workspace!==c.tenantId)throw Error('Odpowiedź nie należy do oryginalnej firmy.');acknowledged=acknowledge(c,m,value);});if(!acknowledged)acknowledged=acknowledge(c,m,result);await actor(stamp,false);if(current(stamp)){setNotice(acknowledged.phase==='cancelled'?'Nie wykonano polecenia; dotychczasowe ustawienia zachowano.':'Potwierdzono oryginalne polecenie. Aktualne ustawienia zostaną odczytane ponownie.');setRefresh(v=>v+1);}}catch(e){if(!acknowledged){try{const stored=readOfferSyncCommands(sessionStorage,localStorage,c,channelId).find(x=>x.body.client_key===m.body.client_key);if(stored&&offerSyncCommandPending(stored))persist(c,{...stored,phase:'unknown'});}catch{if(current(stamp))setCustodyError('Nie można potwierdzić zapisu próby. Zachowaj jej oryginał; kolejne zmiany są zablokowane.');}}throw e;}}
 async function save(e:React.FormEvent<HTMLFormElement>){e.preventDefault();const f=new FormData(e.currentTarget),draft={version:data?.config?.version??0,enabled:f.get('enabled')==='on',warehouse_id:String(f.get('warehouse')??''),price_list_id:price?(list?.id??null):null,stock:f.get('stock')==='on',price,interval_seconds:Number(f.get('interval')),verify_seconds:Number(f.get('verify')),confirm_external:f.get('confirm_external')==='on'};await action(async stamp=>{await actor(stamp,true);const rows=updateJournal();if(rows.some(offerSyncCommandPending))throw Error('Wcześniejsze polecenie ma niepewny wynik. Odczytaj albo anuluj jego oryginał.');const fresh=readData(await api(path));await actor(stamp,true);if((fresh.config?.version??0)!==draft.version)throw Error('Ustawienia zostały zmienione. Odśwież widok i ponownie przejrzyj formularz.');if(draft.enabled&&!fresh.channel.settings.simulation&&!draft.confirm_external)throw Error('Potwierdź zgodę na cykliczne zapisy na tym koncie.');const body:OfferSyncCommand=readOfferSyncCommand({client_key:crypto.randomUUID(),...draft}),m:OfferSyncMarker={v:1,tenant_id:context!.tenantId,user_id:context!.userId,channel_id:channelId,simulation:fresh.channel.settings.simulation,created_at:new Date().toISOString(),body,phase:'sent'};persist(context!,m);await dispatch(context!,m,'/commands',stamp);});}
 async function original(m:OfferSyncMarker,cancel:boolean){await action(async stamp=>{await actor(stamp,cancel);const c=context!,stored=updateJournal().find(x=>x.body.client_key===m.body.client_key);if(!stored)throw Error('Brak oryginalnego polecenia. Zachowaj dane próby.');if(!offerSyncCommandPending(stored)){setRefresh(v=>v+1);return;}if(cancel){await dispatch(c,stored,'/commands/cancel',stamp);return;}const r=await api(base+'/commands/observe','POST',stored.body),done=observeOfferSyncCommand(stored,r);if(done)persist(c,done);await actor(stamp,false);if(!done)throw Error('Nie znaleziono potwierdzenia. Zachowano oryginalne polecenie; nie ponawiaj zapisu.');if(current(stamp)){setNotice(done.phase==='cancelled'?'Nie wykonano polecenia; dotychczasowe ustawienia zachowano.':'Odczytano potwierdzenie oryginalnego polecenia.');setRefresh(v=>v+1);}});}
 async function run(){await action(async stamp=>{await actor(stamp,true);if(updateJournal().some(offerSyncCommandPending))throw Error('Najpierw uzgodnij oryginalne polecenie ustawień.');const r=await api(base,'POST',{});await actor(stamp,true);if(current(stamp)){setNotice(r.reused?'Trwa już przegląd kanału.':'Zlecono przegląd ofert.');setRefresh(v=>v+1);}});}
  if (!context?.admin) return <p>Brak uprawnienia do konfiguracji harmonogramu ofert.</p>;
  if (!data) return <p>{error || 'Wczytywanie harmonogramu ofert…'}</p>;
  const cfg = data.config;
  return (
    <section className="panel offer-sync-panel">
      <div className="panel-heading">
        <div>
          <h3>Automatyczna synchronizacja ofert</h3>
          <p>Cena z cennika i dostępność po rezerwacjach · tylko powiązane oferty</p>
        </div>
        <span>{cfg?.enabled ? 'Włączona' : 'Wyłączona'}</span>
      </div>
      <div className="info-body">
        <p className="notice">
          {data.channel.settings.simulation
            ? 'PRZYKŁAD LOKALNY — harmonogram używa symulatora, bez żądań do dostawcy.'
            : 'Harmonogram zapisuje ceny i stany na skonfigurowanym koncie dostawcy. Autoryzację zatwierdzasz osobno.'}
        </p>
        {error && (
          <p role="alert" className="error-block">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {custodyError&&<p role="alert">{custodyError}</p>}
        {pending.map(m=><div key={m.body.client_key} aria-label="Niepotwierdzone polecenie harmonogramu"><p role="status">Wynik wcześniejszego polecenia jest niepotwierdzony. Kolejne zmiany ustawień są zablokowane.</p><button type="button" className="button" disabled={busy} onClick={()=>void original(m,false)}>Odczytaj oryginalny wynik</button><button type="button" className="button" disabled={busy||context.readOnly||context.externalWriteBlocked} onClick={()=>void original(m,true)}>Anuluj oryginalne polecenie</button><p>Anulowanie nie cofa wcześniej potwierdzonych ustawień.</p></div>)}
        {cfg?.error && <p role="alert">{cfg.error}</p>}
        <form key={identity+':'+(cfg?.version??0)} onSubmit={save}><fieldset className="form-grid" style={{border:0,minWidth:0,padding:0}} disabled={blocked}>
          <label>
            Magazyn automatycznej synchronizacji
            <select name="warehouse" defaultValue={cfg?.warehouse_id ?? warehouses[0]?.id}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Odstęp przeglądów (sekundy)
            <input
              name="interval"
              type="number"
              min="30"
              max="86400"
              defaultValue={cfg?.interval_seconds ?? 300}
              required
            />
          </label>
          <label>
            Sprawdzaj rozbieżności u dostawcy co (sekundy)
            <input
              name="verify"
              type="number"
              min="60"
              max="86400"
              defaultValue={cfg?.verify_seconds ?? 900}
              required
            />
          </label>
          <label className="inline-check">
            <input name="enabled" type="checkbox" defaultChecked={cfg?.enabled ?? false} />
            Synchronizuj automatycznie
          </label>
          <label className="inline-check">
            <input name="stock" type="checkbox" defaultChecked={cfg?.stock ?? true} />
            Synchronizuj dostępny stan
          </label>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={price}
              onChange={(e) => {
                setPrice(e.target.checked);
                if (!e.target.checked) setList(null);
              }}
            />
            Synchronizuj cenę
          </label>
          {price && (
            <PriceListPicker
              value={list?.id ?? ''}
              initial={list}
              onChange={setList}
              label="Cennik automatycznej synchronizacji"
            />
          )}
          {!data.channel.settings.simulation && (
            <label className="inline-check">
              <input name="confirm_external" type="checkbox" />
              Zezwalam na cykliczne zapisy powiązanych ofert na koncie „{data.channel.name}” (
              {data.channel.mode}).
            </label>
          )}
          <button className="button primary" disabled={blocked || !warehouses.length}>
            Zapisz harmonogram ofert
          </button>
        </fieldset></form>
        <p className="muted">
          Wyłączenie zatrzymuje nowe zapisy. Rozpoczęte żądanie może już być u dostawcy; jego wynik
          uzgadniamy odczytem. Niepewny zapis blokuje następne zmiany tego produktu do czasu
          uzgodnienia w planach ofert.
        </p>
        <div className="toolbar">
          <button className="button" disabled={blocked || !cfg?.enabled} onClick={run}>
            Sprawdź oferty teraz
          </button>
          <span>
            {cfg?.last_run_at
              ? 'Ostatni przegląd: ' + date(cfg.last_run_at)
              : 'Nie zakończono jeszcze przeglądu'}{' '}
            · wersja {cfg?.version ?? 0}
          </span>
        </div>
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || flight.current) return;
            setQuery(search);
          }}
        >
          <input
            aria-label="Szukaj wyników synchronizacji"
            maxLength={100}
            disabled={busy}
            value={search}
            onChange={(e) => {if(!busy&&!flight.current)setSearch(e.target.value);}}
          />
          <button className="button" disabled={busy}>Szukaj wyników</button>
        </form>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Oferta / SKU</th>
                <th>Stan</th>
                <th>Ostatnie potwierdzenie</th>
                <th>Wynik</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((i: any) => (
                <tr key={i.listing_id}>
                  <td>
                    <strong>{i.sku}</strong>
                    <small>
                      {i.name} · ID {i.external_id}
                    </small>
                  </td>
                  <td>
                    {i.plan_state === 'done' && i.result?.desired_applied
                      ? 'Potwierdzony zapis'
                      : states[i.state]}
                  </td>
                  <td>
                    {i.plan_state === 'done' && i.result?.desired_applied && i.plan_completed_at
                      ? date(i.plan_completed_at)
                      : i.last_checked_at
                        ? date(i.last_checked_at)
                        : '—'}
                  </td>
                  <td>
                    {i.error ??
                      (i.result?.unchanged
                        ? 'Dane zgodne; bez żądania zapisu'
                        : i.plan_state === 'done' && i.result?.local_changed
                          ? 'Dane lokalne zmieniły się; kolejny przegląd przeliczy ofertę'
                          : i.result?.scope === 'local_simulation'
                            ? 'Symulacja lokalna'
                            : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.data.length > 25 && (
          <p className="muted">
            Automatyczne odświeżanie widoku wstrzymano podczas przeglądania kolejnych stron.
          </p>
        )}
        <button className="button" disabled={busy} onClick={() => setRefresh((v) => v + 1)}>
          Odśwież wyniki synchronizacji
        </button>
        {!data.data.length && (
          <p className="muted">
            Brak wyników dla wybranego filtra. Harmonogram uwzględnia istniejące powiązania ofert.
          </p>
        )}
        {data.meta.cursor && (
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              const stamp = generation.current;
              setBusy(true);
              try {
                await actor(stamp,false);
                const d = readData(await api(path + '&after=' + encodeURIComponent(data.meta.cursor)));
                await actor(stamp,false);
                if (current(stamp))
                  setData((v: any) => ({ ...d, data: [...v.data, ...d.data] }));
              } catch (e: any) {
                if (stamp === generation.current) setError(e.message);
              } finally {
                if(stamp===generation.current)setBusy(false);
              }
            }}
          >
            Kolejne wyniki ofert
          </button>
        )}
        <h4>Przeglądy kanału</h4>
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Stan</th>
              <th>Sprawdzono / bez odczytu / zapisy / zgodne / oczekują / błędy</th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((j: any) => (
              <tr key={j.id}>
                <td>
                  {date(j.created_at)}
                  <small>Wersja {j.config_version}</small>
                </td>
                <td>
                  {j.state === 'done'
                    ? 'Zakończony'
                    : j.state === 'failed'
                      ? 'Zatrzymany / błąd'
                      : 'W kolejce / przegląd'}
                  <small>{j.error}</small>
                </td>
                <td>
                  {[
                    j.stats.checked,
                    j.stats.skipped,
                    j.stats.queued,
                    j.stats.unchanged,
                    j.stats.waiting,
                    j.stats.errors,
                  ].join(' / ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
