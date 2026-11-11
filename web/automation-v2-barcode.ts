// Code 128 (code set B) for the rule's activation barcode, generated client-side so it prints without a server image.
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104,
  STOP = 106;

/** Symbol values: start B, data, checksum, stop. Throws for an empty code or a character outside ASCII 32–126. */
export function code128Symbols(text: string): number[] {
  if (!text) throw new Error('Kod kreskowy jest pusty');
  const data = [...text].map((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 32 || c > 126) throw new Error('Niedozwolony znak w kodzie: ' + ch);
    return c - 32;
  });
  const checksum = data.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103;
  return [START_B, ...data, checksum, STOP];
}

/** Alternating bar/space widths in modules, starting with a bar. */
export function code128Modules(text: string): number[] {
  return code128Symbols(text).flatMap((s) => [...CODE128_PATTERNS[s]].map(Number));
}

/** SVG markup (quiet zone 10 modules, human-readable text below). */
export function code128Svg(text: string, module = 2, height = 70): string {
  const widths = code128Modules(text),
    quiet = 10 * module;
  let x = quiet,
    rects = '';
  widths.forEach((w, i) => {
    if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${w * module}" height="${height}"/>`;
    x += w * module;
  });
  const width = x + quiet,
    safe = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + 18}" width="${width}" height="${height + 18}" role="img" aria-label="Kod kreskowy ${safe}">` +
    `<rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g>` +
    `<text x="${width / 2}" y="${height + 14}" font-family="monospace" font-size="13" text-anchor="middle">${safe}</text></svg>`
  );
}
