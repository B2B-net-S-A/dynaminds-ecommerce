import {
  createScaleLineBuffer,
  createScaleTracker,
  parseScaleFrame,
  scaleFailure,
  SCALE_FAILURE_TEXT,
  SCALE_MAX_GRAMS,
  type ScaleFailure,
} from './scale-frame';

// Web Serial is not in the TypeScript DOM library; only the part used here is typed.
interface SerialPortLike {
  open(options: {
    baudRate: number;
    dataBits: 7 | 8;
    stopBits: 1;
    parity: 'none' | 'even';
  }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(): Promise<SerialPortLike>;
}

export const SCALE_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400] as const;
/** Request commands sent before reading; empty means the scale transmits continuously. */
export const SCALE_COMMANDS = [
  { value: '', label: 'Brak (ciągła transmisja)' },
  { value: 'S', label: 'S (Mettler Toledo)' },
  { value: 'SI', label: 'SI (Radwag, MT-SICS)' },
  { value: 'W', label: 'W (wiele wskaźników)' },
  { value: 'P', label: 'P (Ohaus, Dibal)' },
] as const;

export interface ScaleSettings {
  source: 'serial' | 'bridge';
  baudRate: number;
  frame: '8N1' | '7E1';
  command: string;
  bridgeUrl: string;
}
export const DEFAULT_SCALE_SETTINGS: ScaleSettings = {
  source: 'serial',
  baudRate: 9600,
  frame: '8N1',
  command: '',
  bridgeUrl: 'http://127.0.0.1:4120',
};
const STORAGE_KEY = 'dyna.packing.scale.v1';
const FALLBACK = 'Wpisz masę ręcznie.';

/** Only a loopback origin is accepted: the bridge runs on the packing computer itself. */
export function scaleBridgeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.username || url.password) return null;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readScaleSettings(): ScaleSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<ScaleSettings> | null;
    if (!raw || typeof raw !== 'object') return DEFAULT_SCALE_SETTINGS;
    return {
      source: raw.source === 'bridge' ? 'bridge' : 'serial',
      baudRate: SCALE_BAUD_RATES.includes(raw.baudRate as never) ? Number(raw.baudRate) : 9600,
      frame: raw.frame === '7E1' ? '7E1' : '8N1',
      command: SCALE_COMMANDS.some((c) => c.value === raw.command) ? String(raw.command) : '',
      bridgeUrl:
        typeof raw.bridgeUrl === 'string' && scaleBridgeOrigin(raw.bridgeUrl)
          ? raw.bridgeUrl
          : DEFAULT_SCALE_SETTINGS.bridgeUrl,
    };
  } catch {
    return DEFAULT_SCALE_SETTINGS;
  }
}

export function saveScaleSettings(settings: ScaleSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or blocked storage: the settings stay for this page only.
  }
}

const serialApi = (): SerialLike | undefined =>
  typeof navigator === 'undefined' ? undefined : (navigator as { serial?: SerialLike }).serial;

/** Why the chosen source cannot be offered here, or null when a read can be tried. */
export function scaleUnavailableReason(settings: ScaleSettings): string | null {
  if (settings.source === 'bridge')
    return scaleBridgeOrigin(settings.bridgeUrl)
      ? null
      : 'Adres mostka wagi musi mieć postać http://127.0.0.1:port. ' + FALLBACK;
  if (typeof window === 'undefined') return 'Odczyt z wagi jest niedostępny. ' + FALLBACK;
  if (window.isSecureContext === false)
    return 'Połączenie z wagą działa tylko przez HTTPS lub na localhost. ' + FALLBACK;
  if (!serialApi())
    return (
      'Ta przeglądarka nie obsługuje połączenia z wagą (Web Serial działa w Chrome i Edge na komputerze; ' +
      'Safari i Firefox go nie mają). ' +
      FALLBACK +
      ' Możesz też uruchomić mostek wagi i wybrać go w ustawieniach.'
    );
  return null;
}

export type ScaleResult = { ok: true; grams: number } | { ok: false; message: string };
const fail = (message: string): ScaleResult => ({ ok: false, message });
const failure = (kind: ScaleFailure): ScaleResult => fail(SCALE_FAILURE_TEXT[kind] + ' ' + FALLBACK);

export function serialErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'NotFoundError')
    return 'Nie wybrano portu wagi. Podłącz wagę kablem USB/RS-232 i wybierz jej port. ' + FALLBACK;
  if (['SecurityError', 'NotAllowedError'].includes(name))
    return 'Brak zgody na dostęp do portu wagi. Zezwól na dostęp w ustawieniach przeglądarki. ' + FALLBACK;
  if (['NetworkError', 'InvalidStateError'].includes(name))
    return 'Port wagi jest zajęty przez inną aplikację lub kartę. Zamknij ją i spróbuj ponownie. ' + FALLBACK;
  return 'Nie udało się odczytać wagi. ' + FALLBACK;
}

/** Reads frames from the scale until one stable reading or the time limit; always closes the port. */
export async function readSerialScale(settings: ScaleSettings, timeoutMs: number): Promise<ScaleResult> {
  const serial = serialApi();
  if (!serial) return fail(scaleUnavailableReason(settings) ?? FALLBACK);
  let port: SerialPortLike;
  try {
    // A port granted earlier is reused; otherwise the browser asks the packer to pick one.
    port = (await serial.getPorts())[0] ?? (await serial.requestPort());
    await port.open({
      baudRate: settings.baudRate,
      dataBits: settings.frame === '7E1' ? 7 : 8,
      stopBits: 1,
      parity: settings.frame === '7E1' ? 'even' : 'none',
    });
  } catch (error) {
    return fail(serialErrorMessage(error));
  }
  const reader = port.readable?.getReader();
  let poll: ReturnType<typeof setInterval> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    if (!reader) return failure('no_data');
    if (settings.command && port.writable) {
      const out = port.writable.getWriter();
      writer = out;
      const bytes = new TextEncoder().encode(settings.command + '\r\n');
      const send = () => void out.write(bytes).catch(() => undefined);
      send();
      poll = setInterval(send, 500);
    }
    const lines = createScaleLineBuffer();
    const tracker = createScaleTracker();
    const decoder = new TextDecoder('ascii');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      let wait: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => (wait = setTimeout(() => resolve(null), left))),
      ]);
      clearTimeout(wait);
      if (!chunk || chunk.done) break;
      for (const line of lines(decoder.decode(chunk.value, { stream: true }))) {
        const grams = tracker.push(parseScaleFrame(line));
        if (grams !== null) return { ok: true, grams };
      }
    }
    return failure(scaleFailure(tracker.last()));
  } catch (error) {
    return fail(serialErrorMessage(error));
  } finally {
    clearInterval(poll);
    writer?.releaseLock();
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    await port.close().catch(() => undefined);
  }
}

/** Polls the local bridge (scripts/scale-bridge.ts) until it reports a current stable reading. */
export async function readBridgeScale(settings: ScaleSettings, timeoutMs: number): Promise<ScaleResult> {
  const origin = scaleBridgeOrigin(settings.bridgeUrl);
  if (!origin) return fail(scaleUnavailableReason(settings) ?? FALLBACK);
  const deadline = Date.now() + timeoutMs;
  let last: ScaleFailure = 'no_data';
  for (;;) {
    let body: unknown;
    try {
      const response = await fetch(origin + '/reading', {
        cache: 'no-store',
        credentials: 'omit',
        signal: AbortSignal.timeout(Math.max(500, Math.min(2000, deadline - Date.now()))),
      });
      if (!response.ok) throw new Error('status');
      body = await response.json();
    } catch {
      return fail(
        'Mostek wagi nie odpowiada pod adresem ' + origin + '. Uruchom „npm run scale:bridge” na tym komputerze. ' + FALLBACK,
      );
    }
    const reading = body as { status?: unknown; grams?: unknown };
    if (
      reading.status === 'stable' &&
      Number.isSafeInteger(reading.grams) &&
      Number(reading.grams) >= 1 &&
      Number(reading.grams) <= SCALE_MAX_GRAMS
    )
      return { ok: true, grams: Number(reading.grams) };
    last =
      typeof reading.status === 'string' && reading.status in SCALE_FAILURE_TEXT
        ? (reading.status as ScaleFailure)
        : reading.status === 'stale'
          ? 'no_data'
          : 'invalid';
    if (Date.now() + 250 >= deadline) return failure(last);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function readScale(settings: ScaleSettings, timeoutMs: number): Promise<ScaleResult> {
  return settings.source === 'bridge'
    ? readBridgeScale(settings, timeoutMs)
    : readSerialScale(settings, timeoutMs);
}
