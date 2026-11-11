import {PickingWavePrint} from './picking-wave-print';
import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { api, date, statusNames } from './api';
import { BarcodeScanner, onScanSuffix, submitForm } from './barcode-scanner';
import { MobilePicking } from './mobile-picking';
import { waveScanStorageKey } from './mobile-picking-model';
import './picking-waves.css';
const names: Record<string, string> = {
  picking: 'W kompletacji',
  completed: 'Zebrana',
  cancelled: 'Anulowana',
};

export function PickingPdfPreview({waveId, version, workspaceId, disabled}: {waveId:string;version:string;workspaceId:string;disabled:boolean}) {
  const [document,setDocument]=useState<{url:string;filename:string;version:string}|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),flight=useRef(false),url=useRef<string|null>(null),controller=useRef<AbortController|null>(null);
  const scope=workspaceId+':'+waveId+':'+version,latest=useRef(scope);latest.current=scope;
  useEffect(()=>{
    generation.current++;flight.current=false;controller.current?.abort();setLoading(false);setDocument(null);setError('');
    if(url.current){URL.revokeObjectURL(url.current);url.current=null;}
    return ()=>{generation.current++;controller.current?.abort();if(url.current){URL.revokeObjectURL(url.current);url.current=null;}};
  },[scope]);
  async function load(){
    if(disabled||flight.current)return;
    flight.current=true;setLoading(true);setError('');
    const epoch=generation.current,original=scope,abort=new AbortController();controller.current=abort;
    const current=()=>epoch===generation.current&&latest.current===original&&!abort.signal.aborted;
    try{
      const d=await api('/picking-waves/'+waveId+'/pdf','GET',undefined,{},abort.signal);
      if(!current())return;
      if(d.wave_id!==waveId||typeof d.version!=='string'||!(/^[1-9][0-9]{0,29}$/).test(d.version)||BigInt(d.version)<BigInt(version)||d.mime!=='application/pdf'||!Number.isSafeInteger(d.byte_count)||d.byte_count<1||d.byte_count>8*1024*1024||typeof d.content_base64!=='string'||d.content_base64.length>11184812||typeof d.content_sha256!=='string'||!(/^[a-f0-9]{64}$/).test(d.content_sha256)||typeof d.snapshot_sha256!=='string'||!(/^[a-f0-9]{64}$/).test(d.snapshot_sha256)||d.filename!=='lista-kompletacyjna-'+waveId+'-v'+d.version+'.pdf')throw Error('Nieprawidłowe potwierdzenie dokumentu partii.');
      const decoded=atob(d.content_base64),buffer=new ArrayBuffer(decoded.length),bytes=new Uint8Array(buffer);
      for(let i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);
      if(bytes.length!==d.byte_count||btoa(decoded)!==d.content_base64||!decoded.startsWith('%PDF-1.')||!(/%%EOF[\r\n\t ]*$/).test(decoded))throw Error('Nieprawidłowa zawartość PDF.');
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');
      if(!current())return;if(hash!==d.content_sha256)throw Error('Skrót dokumentu nie zgadza się z odczytem.');
      const next=URL.createObjectURL(new Blob([buffer],{type:'application/pdf'}));
      if(url.current)URL.revokeObjectURL(url.current);url.current=next;setDocument({url:next,filename:d.filename,version:d.version});
    }catch(e){if(current())setError(e instanceof Error?e.message:'Nie udało się odczytać listy.');}
    finally{if(current()){flight.current=false;setLoading(false);controller.current=null;}}
  }
  return <section className="wave-preview" aria-label="Lista kompletacyjna PDF">
    <button disabled={disabled||loading} onClick={()=>void load()}>{loading?'Odczytywanie listy…':'Podgląd listy kompletacyjnej PDF'}</button>
    <p>Pełny odczyt wybranej partii. Pobranie nie zleca drukowania ani nie potwierdza zebrania produktów.</p>
    {error&&<p role="alert">{error}</p>}
    {document&&<><p>Wersja partii: {document.version}</p><a href={document.url} download={document.filename}>Pobierz listę kompletacyjną PDF</a><iframe title="Podgląd listy kompletacyjnej PDF" src={document.url} style={{width:'100%',height:'70vh',border:'1px solid #d8dde5'}} /></>}
  </section>;
}

function stored(key: string) {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}
export function PickingWorkspace({
  individual,
  packing,
  refresh,
  workspaceId,
  write,
  onOrder,
}: {
  individual: ReactNode;
  packing?: ReactNode;
  refresh: number;
  workspaceId: string;
  write: boolean;
  onOrder: (id: string) => void;
}) {
  const [mode, setMode] = useState('batch');
  return (
    <div className="wave-workspace">
      <div className="wave-tabs" role="tablist" aria-label="Tryb kompletacji">
        <button role="tab" aria-selected={mode === 'batch'} onClick={() => setMode('batch')}>
          Zbiorcza kompletacja
        </button>
        <button role="tab" aria-selected={mode === 'single'} onClick={() => setMode('single')}>
          Pojedyncze zamówienia
        </button>
        {packing && (
          <button role="tab" aria-selected={mode === 'packing'} onClick={() => setMode('packing')}>
            Stanowisko pakowania
          </button>
        )}
      </div>
      {mode === 'packing' && packing ? (
        packing
      ) : mode === 'single' ? (
        individual
      ) : (
        <WaveBoard workspaceId={workspaceId} refresh={refresh} write={write} onOrder={onOrder} />
      )}
    </div>
  );
}
function WaveBoard({
  refresh,
  workspaceId,
  write,
  onOrder,
}: {
  refresh: number;
  workspaceId: string;
  write: boolean;
  onOrder: (id: string) => void;
}) {
  const createKey = 'dyna.wave-create.' + workspaceId;
  const [warehouses, setWarehouses] = useState<any[]>([]),
    [warehouse, setWarehouse] = useState(''),
    [rows, setRows] = useState<any[]>([]),
    [next, setNext] = useState<string | null>(null),
    [state, setState] = useState('picking'),
    [after, setAfter] = useState(''),
    [tick, setTick] = useState(0),
    [candidates, setCandidates] = useState<any[]>([]),
    [candidateAfter, setCandidateAfter] = useState(''),
    [candidateNext, setCandidateNext] = useState<string | null>(null),
    [selected, setSelected] = useState<Record<string, any>>({}),
    [preview, setPreview] = useState<any>(null),
    [name, setName] = useState(''),
    [creating, setCreating] = useState<any>(() => stored(createKey)),
    [detail, setDetail] = useState<any>(null),
    [pending, setPending] = useState<any>(null),
    [code, setCode] = useState(''),
    [location, setLocation] = useState(''),
    [receipt, setReceipt] = useState<any>(null),
    [confirm, setConfirm] = useState(''),
    [busy, setBusy] = useState(false),
    [mobile, setMobile] = useState(false),
    [error, setError] = useState('');
  const scanKey = (id: string) => waveScanStorageKey(workspaceId, id);
  const codeInput = useRef<HTMLInputElement>(null),
    refocusCode = useRef(false);
  useEffect(() => {
    // Keep keyboard-wedge scanners typing into the code field after each accepted scan.
    if (!busy && !pending && refocusCode.current) {
      refocusCode.current = false;
      codeInput.current?.focus();
    }
  }, [busy, pending]);
  useEffect(() => {
    let live = true;
    api('/warehouses')
      .then((d) => {
        if (live) {
          setWarehouses(d.data);
          setWarehouse(d.data[0]?.id ?? '');
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    if (!warehouse) return;
    api(
      '/picking-waves?' +
        new URLSearchParams({
          warehouse_id: warehouse,
          state,
          limit: '25',
          ...(after ? { after } : {}),
        }),
    )
      .then((d) => {
        if (live) {
          setRows(d.data);
          setNext(d.next);
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [warehouse, state, after, tick, refresh]);
  useEffect(() => {
    let live = true;
    if (!warehouse || !write) return;
    api(
      '/picking-waves/candidates?' +
        new URLSearchParams({
          warehouse_id: warehouse,
          limit: '25',
          ...(candidateAfter ? { after: candidateAfter } : {}),
        }),
    )
      .then((d) => {
        if (live) {
          setCandidates(d.data);
          setCandidateNext(d.next);
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [warehouse, candidateAfter, tick, write, refresh]);
  useEffect(() => {
    let live = true;
    const id = detail?.wave.id;
    if (!id) return;
    api('/picking-waves/' + id)
      .then((d) => {
        if (live)
          setDetail((current: any) =>
            current?.wave.id === id && BigInt(current.wave.version) <= BigInt(d.wave.version)
              ? d
              : current,
          );
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [refresh, detail?.wave.id]);
  async function perform(run: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    await perform(async () => {
      const d = await api('/picking-waves/' + id);
      setDetail(d);
      setPending(stored(scanKey(id)));
      setReceipt(null);
      setConfirm('');
      setCode('');
      setLocation('');
    });
  }
  function chooseWarehouse(id: string) {
    setWarehouse(id);
    setAfter('');
    setCandidateAfter('');
    setRows([]);
    setCandidates([]);
    setSelected({});
    setPreview(null);
    setName('');
    setDetail(null);
    setPending(null);
    setError('');
  }
  function choose(o: any) {
    setPreview(null);
    setSelected((prev) => {
      const next = { ...prev };
      if (next[o.id]) delete next[o.id];
      else if (Object.keys(next).length < 100) next[o.id] = o;
      return next;
    });
  }
  async function commitCreate(input: any) {
    setCreating(input);
    sessionStorage.setItem(createKey, JSON.stringify(input));
    await perform(async () => {
      let d: any;
      try {
        d = await api('/picking-waves', 'POST', input);
      } catch (e: any) {
        if ([409, 422, 403, 423].includes(e.status)) {
          sessionStorage.removeItem(createKey);
          setCreating(null);
          setPreview(null);
          setTick((n) => n + 1);
        }
        throw e;
      }
      sessionStorage.removeItem(createKey);
      setCreating(null);
      setDetail(d);
      setPending(stored(scanKey(d.wave.id)));
      setSelected({});
      setPreview(null);
      setTick((n) => n + 1);
    });
  }
  async function commitScan(input: any) {
    const id = detail.wave.id;
    setPending(input);
    sessionStorage.setItem(scanKey(id), JSON.stringify(input));
    await perform(async () => {
      const d = await api('/picking-waves/' + id + '/scans', 'POST', input);
      setDetail(d);
      setReceipt(d.scan);
      sessionStorage.removeItem(scanKey(id));
      setPending(null);
      setCode('');
      setConfirm('');
      refocusCode.current = true;
    });
  }
  async function submitScan(e: FormEvent) {
    e.preventDefault();
    if (pending || busy) return;
    await commitScan({
      version: detail.wave.version,
      code,
      location,
      client_key: crypto.randomUUID(),
    });
  }
  function cameraScan(value: string) {
    setCode(value);
    // A camera read is an explicit scan, like a wedge scanner's Enter; it needs the location first.
    if (!pending && !busy && location.trim())
      void commitScan({ version: detail.wave.version, code: value, location, client_key: crypto.randomUUID() });
    else codeInput.current?.focus();
  }
  const selection = Object.values(selected),
    closed = detail && detail.wave.state !== 'picking';
  return (
    <section className="wave-board" aria-label="Zbiorcza kompletacja">
      {error && (
        <p className="wave-error" role="alert">
          {error}
        </p>
      )}
      {creating && (
        <div className="wave-notice">
          <strong>Tworzenie partii wymaga potwierdzenia wyniku.</strong>
          <p>{creating.name}. Ponów tę samą operację, aby bezpiecznie odzyskać wynik.</p>
          <button disabled={busy || !write} onClick={() => commitCreate(creating)}>
            Ponów utworzenie partii
          </button>
        </div>
      )}
      {detail ? (
        <>
          <div className="wave-heading">
            <div>
              <span className="wave-eyebrow">PARTIA KOMPLETACJI</span>
              <h2>{detail.wave.name}</h2>
              <p>
                {detail.wave.warehouse_name} · {names[detail.wave.state]} · {detail.orders.length}{' '}
                zamówień
              </p>
            </div>
            <div className="wave-actions">
              {!closed && (
                <button disabled={busy} onClick={() => setMobile(true)}>
                  Zbieraj na telefonie
                </button>
              )}
              <button disabled={busy} onClick={() => open(detail.wave.id)}>
                Odśwież
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setDetail(null);
                  setTick((n) => n + 1);
                }}
              >
                Lista partii
              </button>
            </div>
          </div>
          {mobile && (
            <MobilePicking
              key={workspaceId + ':mobile:' + detail.wave.id}
              waveId={detail.wave.id}
              workspaceId={workspaceId}
              write={write}
              onClose={() => {
                setMobile(false);
                void open(detail.wave.id);
              }}
            />
          )}
          <PickingPdfPreview key={workspaceId+':'+detail.wave.id} waveId={detail.wave.id} version={detail.wave.version} workspaceId={workspaceId} disabled={busy} />
          <PickingWavePrint key={workspaceId+':wave-print:'+detail.wave.id} waveId={detail.wave.id} waveVersion={detail.wave.version} warehouseId={detail.wave.warehouse_id} orders={detail.orders} workspaceId={workspaceId} write={write} disabled={busy||Boolean(pending)} />
          <div className="wave-progress">
            <strong>
              {detail.progress.scanned} / {detail.progress.quantity}
            </strong>
            <span>zebranych sztuk</span>
            <progress value={detail.progress.scanned} max={detail.progress.quantity || 1} />
            {detail.progress.cancelled_orders > 0 && (
              <span>Pominięte anulowane zamówienia: {detail.progress.cancelled_orders}</span>
            )}
          </div>
          {receipt && (
            <div className="wave-receipt" role="status">
              <span>ODŁÓŻ DO KOSZYKA</span>
              <strong>{receipt.slot}</strong>
              <p>
                {receipt.number} · {receipt.sku} · {receipt.location}
              </p>
              <button onClick={() => onOrder(receipt.order_id)}>Otwórz zamówienie</button>
            </div>
          )}
          {pending && (
            <div className="wave-notice">
              <strong>Skan oczekuje na potwierdzenie.</strong>
              <p>
                {pending.code} · {pending.location}. Ponowienie zachowuje klucz operacji i nie
                naliczy sztuki ponownie.
              </p>
              <button disabled={busy || !write} onClick={() => commitScan(pending)}>
                Ponów ten sam skan
              </button>
              <button
                disabled={busy || !write}
                onClick={() =>
                  perform(async () => {
                    const d = await api('/picking-waves/' + detail.wave.id);
                    setDetail(d);
                    const result = await api(
                      '/picking-waves/' +
                        detail.wave.id +
                        '/scan-result?client_key=' +
                        pending.client_key,
                    );
                    if (result.scan) {
                      setReceipt(result.scan);
                      sessionStorage.removeItem(scanKey(d.wave.id));
                      setPending(null);
                    } else if (result.version !== pending.version || result.state !== 'picking') {
                      sessionStorage.removeItem(scanKey(d.wave.id));
                      setPending(null);
                      setError(
                        'Skan nie został zastosowany, a partia zmieniła się. Sprawdź postęp i koszyki przed następnym skanem.',
                      );
                    } else
                      throw new Error('Skan nie jest jeszcze potwierdzony. Ponów ten sam skan.');
                  })
                }
              >
                Sprawdź wynik i aktualny postęp
              </button>
            </div>
          )}
          {!closed && write && (
            <form className="wave-scan" onSubmit={submitScan}>
              <label>
                Kod produktu
                <input
                  ref={codeInput}
                  autoComplete="off"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={busy || !!pending}
                  required
                  placeholder="Skanuj EAN lub SKU"
                />
              </label>
              <label>
                Lokalizacja
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  onKeyDown={onScanSuffix(submitForm)}
                  disabled={busy || !!pending}
                  required
                  placeholder="np. A2"
                />
              </label>
              <button
                className="primary"
                disabled={busy || !!pending || !code.trim() || !location.trim()}
              >
                Zbierz 1 sztukę
              </button>
              <BarcodeScanner
                label="Skanuj kod produktu aparatem"
                disabled={busy || !!pending}
                onDetected={cameraScan}
              />
            </form>
          )}
          <Groups
            groups={detail.groups}
            onLocation={
              write && !closed && !pending
                ? (g) => {
                    setLocation(g.location);
                    setCode(g.sku);
                  }
                : undefined
            }
          />
          <h3>Koszyki i pakowanie</h3>
          <p className="wave-help">
            Po zebraniu towaru spakuj każde zamówienie osobno. Zakończenie partii zwalnia
            przypisania; nie nadaje przesyłek.
          </p>
          <div className="wave-baskets">
            {detail.orders.map((o: any) => (
              <button key={o.id} onClick={() => onOrder(o.id)}>
                <strong>Koszyk {o.slot}</strong>
                <span>{o.number}</span>
                <span>{statusNames[o.status] ?? o.status}</span>
              </button>
            ))}
          </div>
          {!closed && write && (
            <div className="wave-close">
              <button disabled={busy || !!pending} onClick={() => setConfirm('complete')}>
                Zakończ zbieranie
              </button>
              <button disabled={busy || !!pending} onClick={() => setConfirm('cancel')}>
                Anuluj partię
              </button>
              {confirm && (
                <div className="wave-notice">
                  <p>
                    {confirm === 'complete'
                      ? 'Zakończyć partię? Wymagane jest zebranie wszystkich sztuk z nieanulowanych zamówień.'
                      : 'Anulować partię? Skany, statusy zamówień i rezerwacje pozostaną zachowane. Zamówienia będzie można przypisać ponownie.'}
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        setDetail(
                          await api('/picking-waves/' + detail.wave.id + '/' + confirm, 'POST', {
                            version: detail.wave.version,
                          }),
                        );
                        setConfirm('');
                        setTick((n) => n + 1);
                      })
                    }
                  >
                    Potwierdź {confirm === 'complete' ? 'zakończenie' : 'anulowanie'}
                  </button>
                  <button disabled={busy} onClick={() => setConfirm('')}>
                    Wróć
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="wave-heading">
            <div>
              <span className="wave-eyebrow">KILKA ZAMÓWIEŃ · JEDNA TRASA</span>
              <h2>Zbierz razem, spakuj osobno</h2>
              <p>
                Lista według lokalizacji, produkty pogrupowane i koszyk wskazany po każdym skanie.
              </p>
            </div>
            <label>
              Magazyn
              <select
                value={warehouse}
                disabled={busy || !!creating}
                onChange={(e) => chooseWarehouse(e.target.value)}
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {write && (
            <div className="wave-create">
              <h3>Przygotuj nową partię</h3>
              <p className="wave-help">
                Do 100 zamówień z jednego magazynu. Podgląd sprawdzi płatności, rezerwacje i
                aktualne przypisania.
              </p>
              <div className="wave-selection">
                <label>
                  Nazwa partii
                  <input
                    value={name}
                    disabled={busy || !!creating}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="np. Poranna trasa / magazyn główny"
                    maxLength={100}
                  />
                </label>
                <strong>Wybrano: {selection.length} / 100</strong>
                <button
                  disabled={busy || !!creating || !selection.length}
                  onClick={() =>
                    perform(async () => {
                      setPreview(
                        await api('/picking-waves/preview', 'POST', {
                          warehouse_id: warehouse,
                          order_ids: selection.map((o: any) => o.id),
                        }),
                      );
                    })
                  }
                >
                  Podgląd partii
                </button>
                <button
                  disabled={busy || !!creating || !selection.length}
                  onClick={() => {
                    setSelected({});
                    setPreview(null);
                  }}
                >
                  Wyczyść wybór
                </button>
              </div>
              <div className="wave-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Wybór</th>
                      <th>Zamówienie</th>
                      <th>Status</th>
                      <th>Zebrane / sztuki</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <input
                            aria-label={'Wybierz ' + o.number}
                            type="checkbox"
                            checked={!!selected[o.id]}
                            disabled={
                              busy || !!creating || (!selected[o.id] && selection.length >= 100)
                            }
                            onChange={() => choose(o)}
                          />
                        </td>
                        <td>
                          <button className="wave-link" onClick={() => onOrder(o.id)}>
                            {o.number}
                          </button>
                        </td>
                        <td>{statusNames[o.status]}</td>
                        <td>
                          {o.scanned} / {o.quantity}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!candidates.length && <p>Brak zamówień oczekujących na przypisanie do partii.</p>}
              <div className="wave-actions">
                <button disabled={busy || !candidateAfter} onClick={() => setCandidateAfter('')}>
                  Pierwsza strona
                </button>
                <button
                  disabled={busy || !candidateNext}
                  onClick={() => setCandidateAfter(candidateNext!)}
                >
                  Kolejne zamówienia
                </button>
              </div>
              {selection.length > 0 && (
                <p className="wave-help">
                  Wybrane także z wcześniejszych stron:{' '}
                  {selection.map((o: any) => o.number).join(', ')}
                </p>
              )}
              {preview && (
                <div className="wave-preview">
                  <h3>Podgląd: {preview.orders.length} zamówień</h3>
                  <Groups groups={preview.groups} />
                  <button
                    className="primary"
                    disabled={busy || !!creating || name.trim().length < 2}
                    onClick={() =>
                      commitCreate({
                        warehouse_id: warehouse,
                        order_ids: selection.map((o: any) => o.id),
                        name: name.trim(),
                        preview_hash: preview.preview_hash,
                        client_key: crypto.randomUUID(),
                      })
                    }
                  >
                    Zatwierdź partię i rozpocznij kompletację
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="wave-history">
            <div className="wave-heading">
              <h3>Partie kompletacji</h3>
              <label>
                Status
                <select
                  value={state}
                  disabled={busy}
                  onChange={(e) => {
                    setState(e.target.value);
                    setAfter('');
                  }}
                >
                  {Object.entries(names).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                  <option value="all">Wszystkie</option>
                </select>
              </label>
              <button disabled={busy} onClick={() => setTick((n) => n + 1)}>
                Odśwież listę
              </button>
            </div>
            <div className="wave-list">
              {rows.map((w) => (
                <button key={w.id} disabled={busy} onClick={() => open(w.id)}>
                  <strong>{w.name}</strong>
                  <span>
                    {w.order_count} zamówień · {names[w.state]}
                  </span>
                  <span>{date(w.created_at)}</span>
                </button>
              ))}
            </div>
            {!rows.length && <p>Brak partii dla wybranych filtrów.</p>}
            <div className="wave-actions">
              <button disabled={busy || !after} onClick={() => setAfter('')}>
                Pierwsza strona partii
              </button>
              <button disabled={busy || !next} onClick={() => setAfter(next!)}>
                Kolejne partie
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function Groups({ groups, onLocation }: { groups: any[]; onLocation?: (g: any) => void }) {
  return (
    <div className="wave-groups">
      {groups.map((g) => (
        <article
          key={g.product_id + ':' + g.location}
          className={g.scanned === g.quantity ? 'wave-group done' : 'wave-group'}
        >
          <div className="wave-bin">{g.location}</div>
          <div className="wave-product">
            <strong>{g.name}</strong>
            <span>
              {g.sku}
              {g.ean ? ' · ' + g.ean : ''}
            </span>
            <div className="wave-destinations">
              {g.destinations.map((d: any) => (
                <span key={d.order_id}>
                  Koszyk {d.slot}: {d.scanned}/{d.quantity}
                </span>
              ))}
            </div>
          </div>
          <strong className="wave-count">
            {g.scanned}/{g.quantity}
          </strong>
          {onLocation && g.scanned < g.quantity && (
            <button onClick={() => onLocation(g)}>Wybierz miejsce</button>
          )}
        </article>
      ))}
    </div>
  );
}
