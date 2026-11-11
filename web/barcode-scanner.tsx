import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import './barcode-scanner.css';

// BarcodeDetector is not in the TypeScript DOM library yet; only the part used here is typed.
interface DetectedBarcode {
  rawValue: string;
  format: string;
}
interface Detector {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
interface DetectorClass {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
}

export const SCAN_FORMATS = ['ean_13', 'ean_8', 'code_128', 'qr_code'] as const;
const FALLBACK = 'Wpisz kod ręcznie albo użyj skanera USB/Bluetooth.';
const POLL_MS = 150;

const detectorClass = (): DetectorClass | undefined =>
  (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;

/** Why the camera cannot be offered in this browser, or null when it can be tried. */
export function cameraUnavailableReason(): string | null {
  if (typeof window === 'undefined') return 'Skanowanie aparatem jest niedostępne. ' + FALLBACK;
  if (window.isSecureContext === false)
    return 'Aparat działa tylko przez HTTPS lub na localhost. ' + FALLBACK;
  if (!detectorClass())
    return 'Ta przeglądarka nie obsługuje skanowania kodów aparatem. ' + FALLBACK;
  if (!navigator.mediaDevices?.getUserMedia)
    return 'Ta przeglądarka nie udostępnia aparatu. ' + FALLBACK;
  return null;
}

export function cameraErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(name))
    return 'Brak zgody na użycie aparatu. Zezwól na dostęp w ustawieniach przeglądarki. ' + FALLBACK;
  if (['NotFoundError', 'OverconstrainedError', 'DevicesNotFoundError'].includes(name))
    return 'Nie znaleziono aparatu w tym urządzeniu. ' + FALLBACK;
  if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(name))
    return 'Aparat jest zajęty przez inną aplikację. Zamknij ją i spróbuj ponownie. ' + FALLBACK;
  if (error instanceof Error && error.message === 'formats')
    return 'Ta przeglądarka nie rozpoznaje kodów EAN, Code 128 ani QR. ' + FALLBACK;
  return 'Nie udało się uruchomić aparatu. ' + FALLBACK;
}

async function usableFormats(Detector: DetectorClass): Promise<string[]> {
  if (!Detector.getSupportedFormats) return [...SCAN_FORMATS];
  const supported = await Detector.getSupportedFormats();
  return SCAN_FORMATS.filter((f) => supported.includes(f));
}

/**
 * Keyboard-wedge suffix: Enter or Tab after a non-empty value submits once.
 * Use it on the last scan field of a form, so Tab from earlier fields still moves focus for manual entry.
 */
export function onScanSuffix(submit: (input: HTMLInputElement) => void) {
  return (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' && e.key !== 'Tab') return;
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return;
    if (!e.currentTarget.value.trim()) return;
    e.preventDefault();
    if (e.repeat) return;
    submit(e.currentTarget);
  };
}
export const submitForm = (input: HTMLInputElement): void => input.form?.requestSubmit();

interface BarcodeScannerProps {
  /** Called once per camera read; the camera stops before the call. */
  onDetected: (code: string) => void;
  disabled?: boolean;
  label?: string;
  /** Large tap target and viewfinder for the phone picking screen. */
  prominent?: boolean;
}

/** Back-camera barcode reader; the host keeps its text input as the fallback. */
export function BarcodeScanner({
  onDetected,
  disabled = false,
  label = 'Skanuj aparatem',
  prominent = false,
}: BarcodeScannerProps) {
  const [unavailable] = useState(cameraUnavailableReason);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'scanning'>('idle');
  const [message, setMessage] = useState('');
  const video = useRef<HTMLVideoElement>(null),
    stream = useRef<MediaStream | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    run = useRef(0),
    detected = useRef(onDetected);
  detected.current = onDetected;

  function release() {
    run.current++;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }
  function stop() {
    release();
    setPhase('idle');
  }
  useEffect(() => release, []);
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);

  async function start() {
    const reason = cameraUnavailableReason();
    if (reason) {
      setMessage(reason);
      return;
    }
    release();
    const epoch = run.current;
    setMessage('');
    setPhase('starting');
    try {
      const Detector = detectorClass()!;
      const formats = await usableFormats(Detector);
      if (!formats.length) throw new Error('formats');
      const detector = new Detector({ formats });
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (epoch !== run.current) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = media;
      setPhase('scanning');
      const el = video.current;
      if (!el) throw new Error('video');
      el.srcObject = media;
      try {
        await el.play();
      } catch {
        // Autoplay of a muted inline video is allowed; detect() below simply waits for frames.
      }
      const tick = async () => {
        if (epoch !== run.current) return;
        try {
          const hit = (await detector.detect(el)).find((c) => c.rawValue?.trim());
          if (hit && epoch === run.current) {
            stop();
            detected.current(hit.rawValue.trim());
            return;
          }
        } catch {
          // A frame that is not ready yet; keep polling.
        }
        if (epoch === run.current) timer.current = setTimeout(tick, POLL_MS);
      };
      void tick();
    } catch (error) {
      if (epoch !== run.current) return;
      stop();
      setMessage(cameraErrorMessage(error));
    }
  }

  const cls = 'scanner' + (prominent ? ' scanner-prominent' : '');
  if (unavailable)
    return (
      <div className={cls}>
        <p className="scanner-note">{unavailable}</p>
      </div>
    );
  return (
    <div className={cls}>
      <div className="scanner-view" hidden={phase === 'idle'}>
        <video ref={video} muted playsInline aria-label="Podgląd aparatu" />
        <span className="scanner-frame" aria-hidden="true" />
      </div>
      {phase === 'idle' ? (
        <button
          type="button"
          className="scanner-start"
          disabled={disabled}
          onClick={() => void start()}
        >
          {message ? 'Spróbuj aparatu ponownie' : label}
        </button>
      ) : (
        <>
          <p className="scanner-status" role="status">
            {phase === 'starting'
              ? 'Uruchamianie aparatu…'
              : 'Skieruj aparat na kod kreskowy lub QR.'}
          </p>
          <button type="button" className="scanner-stop" onClick={stop}>
            Zatrzymaj aparat
          </button>
        </>
      )}
      {message && (
        <p className="scanner-error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
