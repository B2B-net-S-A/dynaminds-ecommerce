/**
 * ASCII weight frames from warehouse scales (USB/RS-232). Pure parsing, no IO, shared by
 * the browser reader (Web Serial) and scripts/scale-bridge.ts.
 *
 * Recognised shapes (one frame per line):
 * - A&D / CAS / many OEM indicators: "ST,GS,+  1.234kg", "US,NT,+0001.234 kg", "OL,GS,..."
 * - Mettler Toledo MT-SICS and Radwag responses: "S S     1.234 kg", "S D ...", "S +", "SI ?  1.234 kg"
 * - Plain continuous output (Dibal, Ohaus, simple indicators): "   1234 g", "1.234 kg ?", "2.72 lb"
 * Frames without a stability flag are "unknown" and become stable only after identical repeats.
 */

export const SCALE_MAX_GRAMS = 1000000;
export const SCALE_UNKNOWN_REPEATS = 3;

export type ScaleStability = 'stable' | 'unstable' | 'unknown';
export type ScaleFrame =
  | { kind: 'weight'; grams: number; stability: ScaleStability }
  | { kind: 'unstable' }
  | { kind: 'overload' }
  | { kind: 'negative' }
  | { kind: 'zero' }
  | { kind: 'out_of_range' }
  | { kind: 'invalid' }
  | { kind: 'empty' };

// Unit factors to grams as exact rationals [numerator, denominator].
const UNITS: Record<string, [bigint, bigint]> = {
  kg: [1000n, 1n],
  g: [1n, 1n],
  lb: [45359237n, 100000n],
  lbs: [45359237n, 100000n],
  oz: [28349523125n, 1000000000n],
};

const WEIGHT = /([+-])?\s*(?<![\d.])(\d{1,9}(?:[.,]\d{1,6})?)[\s,]*(kg|g|lbs?|oz)(?![a-z])/gi;
const OVERLOAD = /(?:^|[^A-Z])(?:OL|O-L|OVER|OVERLOAD|OVL)(?:$|[^A-Z])|\^/;
const UNSTABLE = /(?:^|[^A-Z])(?:US|UNSTABLE|MOTION)(?:$|[^A-Z])|\?/;
const STABLE = /(?:^|[^A-Z])(?:ST|STABLE)(?:$|[^A-Z])/;

/** Exact decimal × rational, rounded half up to whole grams. */
function toGrams(number: string, unit: string): number {
  const [whole, fraction = ''] = number.split(/[.,]/);
  const [num, den] = UNITS[unit.toLowerCase()];
  const n = BigInt(whole + fraction) * num;
  const d = 10n ** BigInt(fraction.length) * den;
  const grams = (2n * n + d) / (2n * d);
  return grams > BigInt(SCALE_MAX_GRAMS) ? SCALE_MAX_GRAMS + 1 : Number(grams);
}

function weightFrame(body: string, stability: ScaleStability, signHint = ''): ScaleFrame {
  const matches = [...body.matchAll(WEIGHT)];
  // No unit is ambiguous (g or kg?); two weights in one frame (gross/tare) cannot be chosen safely.
  if (matches.length !== 1) return { kind: 'invalid' };
  const [, sign = '', number, unit] = matches[0];
  const grams = toGrams(number, unit);
  if (grams < 1) return { kind: 'zero' };
  if (sign === '-' || signHint === '-') return { kind: 'negative' };
  if (grams > SCALE_MAX_GRAMS) return { kind: 'out_of_range' };
  if (stability === 'unstable') return { kind: 'unstable' };
  return { kind: 'weight', grams, stability };
}

export function parseScaleFrame(line: string): ScaleFrame {
  // STX/ETX and other control bytes frame the data on some indicators.
  const text = line.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
  if (!text) return { kind: 'empty' };
  const upper = text.toUpperCase();

  // MT-SICS: "S S <weight>", "S D <weight>", "S +" overload, "S -" underload, "S I" busy.
  const sics = /^S\s+([SD+\-I])(?:\s+(.*))?$/i.exec(text);
  if (sics) {
    const status = sics[1].toUpperCase();
    if (status === '+') return { kind: 'overload' };
    if (status === '-') return { kind: 'negative' };
    if (status === 'I') return { kind: 'unstable' };
    return weightFrame(sics[2] ?? '', status === 'S' ? 'stable' : 'unstable');
  }

  // Radwag "SI"/"SU" mass frame: marker after the command is space (stable), ? (unstable), ^ / v (limits).
  const radwag = /^S[IU]\s?([ ?^v])\s*(-?)(.*)$/.exec(line.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trimStart());
  if (radwag) {
    if (radwag[1] === '^') return { kind: 'overload' };
    if (radwag[1] === 'v') return { kind: 'negative' };
    return weightFrame(radwag[2] + radwag[3], radwag[1] === '?' ? 'unstable' : 'stable');
  }

  // Header with status and optional gross/net/tare: "ST,GS,+  1.234kg", "US,+0001.234 kg".
  const header = /^(ST|US|OL)\s*,\s*(?:(?:GS|NT|TR|GR|NET|G|N)\s*,\s*)?(.*)$/i.exec(text);
  if (header) {
    const status = header[1].toUpperCase();
    if (status === 'OL') return { kind: 'overload' };
    return weightFrame(header[2], status === 'ST' ? 'stable' : 'unstable');
  }

  // Indicators show "OL", "OVER" or a row of dashes instead of a number when overloaded.
  if (OVERLOAD.test(upper) || (/-{3,}/.test(text) && !/\d/.test(text))) return { kind: 'overload' };
  const stability: ScaleStability = UNSTABLE.test(upper)
    ? 'unstable'
    : STABLE.test(upper)
      ? 'stable'
      : 'unknown';
  return weightFrame(text, stability);
}

/** Splits a byte stream into lines on CR, LF or ETX; keeps a bounded tail between chunks. */
export function createScaleLineBuffer(maxLine = 256) {
  let tail = '';
  return (chunk: string): string[] => {
    const parts = (tail + chunk).split(/[\r\n\x03]+/);
    tail = parts.pop() ?? '';
    if (tail.length > maxLine) tail = '';
    return parts.filter((p) => p.trim() !== '');
  };
}

/**
 * Turns frames into a single accepted reading: a flagged stable frame at once, an unflagged
 * frame only after SCALE_UNKNOWN_REPEATS identical frames in a row. Anything else resets.
 */
export function createScaleTracker(repeats = SCALE_UNKNOWN_REPEATS) {
  let streak = 0;
  let streakGrams = -1;
  let last: ScaleFrame | null = null;
  return {
    push(frame: ScaleFrame): number | null {
      if (frame.kind === 'empty') return null;
      last = frame;
      if (frame.kind !== 'weight') {
        streak = 0;
        return null;
      }
      if (frame.stability === 'stable') {
        streak = 0;
        return frame.grams;
      }
      streak = frame.grams === streakGrams ? streak + 1 : 1;
      streakGrams = frame.grams;
      return streak >= repeats ? frame.grams : null;
    },
    last: (): ScaleFrame | null => last,
  };
}

export type ScaleFailure = 'unstable' | 'overload' | 'negative' | 'zero' | 'out_of_range' | 'invalid' | 'no_data';

/** Why no reading was accepted, from the last frame seen before the time ran out. */
export function scaleFailure(last: ScaleFrame | null): ScaleFailure {
  if (!last) return 'no_data';
  if (last.kind === 'weight') return 'unstable';
  if (last.kind === 'empty') return 'no_data';
  return last.kind;
}

export const SCALE_FAILURE_TEXT: Record<ScaleFailure, string> = {
  unstable: 'Odczyt z wagi jest niestabilny. Poczekaj, aż paczka przestanie się ruszać, i spróbuj ponownie.',
  overload: 'Waga zgłasza przeciążenie. Zdejmij paczkę i sprawdź zakres wagi.',
  negative: 'Waga pokazuje masę ujemną. Wytaruj wagę bez paczki i spróbuj ponownie.',
  zero: 'Waga pokazuje zero. Połóż gotową paczkę na wadze i spróbuj ponownie.',
  out_of_range: 'Odczyt z wagi jest poza zakresem formularza 0,001–1000 kg.',
  invalid:
    'Nie rozpoznano danych z wagi. Sprawdź prędkość transmisji i format ramki w ustawieniach wagi.',
  no_data:
    'Waga nie przesłała danych. Włącz w wadze transmisję ciągłą albo ustaw polecenie odczytu.',
};
