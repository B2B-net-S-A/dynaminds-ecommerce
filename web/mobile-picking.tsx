import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { BarcodeScanner, onScanSuffix } from './barcode-scanner';
import {
  groupKey,
  isDefinitiveRejection,
  pickQueue,
  pickStats,
  readStored,
  scanPayload,
  waveScanStorageKey,
  writeStored,
  type WaveDetail,
  type WaveScanInput,
  type WaveScanReceipt,
} from './mobile-picking-model';
import './mobile-picking.css';

interface MobilePickingProps {
  waveId: string;
  workspaceId: string;
  write: boolean;
  onClose: () => void;
}
type Detail = WaveDetail & { scan?: WaveScanReceipt };
const message = (e: unknown) => (e instanceof Error ? e.message : 'Nie udało się wykonać operacji');

/** Phone-first picking for one wave: one location and product at a time, in walking order. */
export function MobilePicking({ waveId, workspaceId, write, onClose }: MobilePickingProps) {
  const storageKey = waveScanStorageKey(workspaceId, waveId);
  const [detail, setDetail] = useState<Detail | null>(null),
    [pending, setPending] = useState<WaveScanInput | null>(() => readStored(storageKey)),
    [receipt, setReceipt] = useState<WaveScanReceipt | null>(null),
    [skipped, setSkipped] = useState<string[]>([]),
    [code, setCode] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null),
    dialog = useRef<HTMLDivElement>(null),
    refocus = useRef(false),
    live = useRef(true);

  useEffect(() => {
    live.current = true;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    void load();
    return () => {
      live.current = false;
      document.body.style.overflow = overflow;
    };
  }, [waveId]);
  useEffect(() => {
    if (!busy && !pending && refocus.current) {
      refocus.current = false;
      input.current?.focus();
    }
  }, [busy, pending]);

  async function load() {
    setBusy(true);
    try {
      const d = await api<Detail>('/picking-waves/' + waveId);
      if (live.current) setDetail(d);
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  function keepPending(next: WaveScanInput | null) {
    writeStored(storageKey, next);
    setPending(next);
  }
  async function commit(scan: WaveScanInput) {
    keepPending(scan);
    setBusy(true);
    setError('');
    setReceipt(null);
    try {
      const d = await api<Detail>('/picking-waves/' + waveId + '/scans', 'POST', scan);
      if (!live.current) return;
      setDetail(d);
      setReceipt(d.scan ?? null);
      keepPending(null);
      setCode('');
    } catch (e) {
      if (!live.current) return;
      if (isDefinitiveRejection(e)) {
        // The server rolled the scan back; nothing was counted, so the operator can scan again.
        keepPending(null);
        setError(message(e));
        if (e.status === 409) void load();
      } else
        setError(
          'Brak potwierdzenia skanu (' +
            message(e) +
            '). Ponów ten sam skan albo sprawdź wynik — sztuka nie zostanie naliczona dwa razy.',
        );
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function checkPending(scan: WaveScanInput) {
    setBusy(true);
    setError('');
    try {
      const d = await api<Detail>('/picking-waves/' + waveId);
      const result = await api<{ version: string; state: string; scan: WaveScanReceipt | null }>(
        '/picking-waves/' + waveId + '/scan-result?client_key=' + scan.client_key,
      );
      if (!live.current) return;
      setDetail(d);
      if (result.scan) {
        setReceipt(result.scan);
        keepPending(null);
      } else if (result.version !== scan.version || result.state !== 'picking') {
        keepPending(null);
        setError('Skan nie został zastosowany, a partia zmieniła się. Sprawdź postęp przed następnym skanem.');
      } else setError('Skan nie jest jeszcze potwierdzony. Ponów ten sam skan.');
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const queue = detail ? pickQueue(detail.groups, skipped) : [],
    current = queue[0],
    stats = detail ? pickStats(detail.groups) : null,
    closed = !!detail && detail.wave.state !== 'picking',
    canScan = write && !closed && !!current;
  function submit(raw: string, fromKeyboard: boolean) {
    if (!detail || !current || busy || pending) return;
    const scan = scanPayload(detail, raw, current.location, crypto.randomUUID());
    if (typeof scan === 'string') {
      setError(scan);
      return;
    }
    refocus.current = fromKeyboard;
    void commit(scan);
  }
  // Shown next to the scan field, so it stays in view while the operator keeps scanning.
  const receiptView = receipt && (
    <section className="mpick-receipt" role="status" aria-label="Wynik skanu">
      <span>ODŁÓŻ DO KOSZYKA</span>
      <strong>{receipt.slot}</strong>
      <p>
        {receipt.number} · {receipt.sku} · {receipt.location}
      </p>
    </section>
  );
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit(code, document.activeElement === input.current);
  }

  return (
    <div
      className="mpick"
      role="dialog"
      aria-modal="true"
      aria-label="Kompletacja na telefonie"
      tabIndex={-1}
      ref={dialog}
    >
      <header className="mpick-bar">
        <button type="button" className="mpick-ghost" onClick={onClose}>
          ← Partia
        </button>
        <div className="mpick-title">
          <span>{detail?.wave.name ?? 'Partia kompletacji'}</span>
          {stats && (
            <strong>
              {stats.scanned} / {stats.pieces} szt.
            </strong>
          )}
        </div>
        <button type="button" className="mpick-ghost" disabled={busy} onClick={() => void load()}>
          Odśwież
        </button>
      </header>
      {stats && (
        <div className="mpick-meter">
          <progress value={stats.scanned} max={stats.pieces || 1} aria-label="Postęp zbierania" />
          <span>
            Pozycje zebrane: {stats.tasksDone} z {stats.tasks}
          </span>
        </div>
      )}
      <main className="mpick-body">
        {error && (
          <p className="mpick-error" role="alert">
            {error}
          </p>
        )}
        {pending && (
          <section className="mpick-notice" aria-label="Skan oczekuje na potwierdzenie">
            <strong>Skan oczekuje na potwierdzenie</strong>
            <p>
              {pending.code} · {pending.location}. Ponowienie używa tego samego klucza i nie nalicza
              sztuki ponownie.
            </p>
            <button type="button" disabled={busy || !write} onClick={() => void commit(pending)}>
              Ponów ten sam skan
            </button>
            <button type="button" disabled={busy} onClick={() => void checkPending(pending)}>
              Sprawdź wynik
            </button>
          </section>
        )}
        {!detail ? (
          !error && <p className="mpick-muted">Odczytywanie partii…</p>
        ) : closed ? (
          <section className="mpick-done">
            <strong>Partia jest zamknięta</strong>
            <p>Status partii nie pozwala na kolejne skany. Wróć do listy partii.</p>
          </section>
        ) : !current ? (
          <section className="mpick-done">
            {receiptView}
            <strong>Wszystko zebrane</strong>
            <p>Wróć do partii, aby sprawdzić koszyki i zakończyć zbieranie.</p>
            <button type="button" className="mpick-primary" onClick={onClose}>
              Wróć do partii
            </button>
          </section>
        ) : (
          <>
            <section className="mpick-task" aria-label="Bieżąca pozycja">
              <div className="mpick-bin">
                <span>IDŹ DO LOKALIZACJI</span>
                <strong>{current.location}</strong>
              </div>
              <h2>{current.name}</h2>
              <p className="mpick-codes">
                SKU {current.sku}
                {current.ean ? ' · EAN ' + current.ean : ''}
              </p>
              <div className="mpick-qty">
                <strong>{current.quantity - current.scanned}</strong>
                <span>
                  do zebrania · {current.scanned} z {current.quantity} gotowe
                </span>
              </div>
              <ul className="mpick-dest" aria-label="Koszyki">
                {current.destinations.map((d) => (
                  <li key={d.order_id} className={d.scanned >= d.quantity ? 'done' : ''}>
                    Koszyk {d.slot}: {d.scanned}/{d.quantity}
                  </li>
                ))}
              </ul>
              {receiptView}
              {canScan ? (
                <form className="mpick-scan" onSubmit={onSubmit}>
                  <BarcodeScanner
                    prominent
                    label="Skanuj kod aparatem"
                    disabled={busy || !!pending}
                    onDetected={(value) => {
                      setCode(value);
                      submit(value, false);
                    }}
                  />
                  <label>
                    Kod produktu (EAN lub SKU)
                    <input
                      ref={input}
                      value={code}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      enterKeyHint="send"
                      disabled={busy || !!pending}
                      onChange={(e) => setCode(e.target.value)}
                      onKeyDown={onScanSuffix(() => submit(code, true))}
                      placeholder="Skaner lub ręczny kod"
                    />
                  </label>
                  <button
                    type="submit"
                    className="mpick-primary"
                    disabled={busy || !!pending || !code.trim()}
                  >
                    Zbierz 1 sztukę
                  </button>
                </form>
              ) : (
                !write && <p className="mpick-muted">Konto ma uprawnienia tylko do odczytu.</p>
              )}
              {queue.length > 1 && (
                <button
                  type="button"
                  className="mpick-skip"
                  disabled={busy}
                  onClick={() => {
                    setReceipt(null);
                    setError('');
                    setSkipped((s) => [...s.filter((k) => k !== groupKey(current)), groupKey(current)]);
                  }}
                >
                  Pomiń — wróć do tej pozycji na końcu
                </button>
              )}
            </section>
            {queue.length > 1 && (
              <section className="mpick-next" aria-label="Następne lokalizacje">
                <h3>Następne</h3>
                <ol>
                  {queue.slice(1, 4).map((g) => (
                    <li key={groupKey(g)}>
                      <strong>{g.location}</strong>
                      <span>
                        {g.name} · {g.quantity - g.scanned} szt.
                      </span>
                    </li>
                  ))}
                </ol>
                {queue.length > 4 && <p className="mpick-muted">i {queue.length - 4} kolejnych</p>}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
