/** Top scan field of the order card. A company with lots needs a retry key on every scan (server/domain.ts, scan);
 * without lots the request stays exactly as it was. */
export function orderScanBody(input: { code: string; location: string; lotsEnabled: boolean; newKey: () => string }) {
  return {
    code: input.code,
    ...(input.location ? { location: input.location } : {}),
    ...(input.lotsEnabled ? { client_key: input.newKey() } : {}),
  };
}

const LOT_MESSAGES: readonly (readonly [string, string])[] = [
  ['W lokalizacji przypisano kilka warstw', 'W tej lokalizacji jest kilka partii tego produktu. Wybierz partię w sekcji „Partie i alokacje magazynowe” niżej.'],
  ['Brak nieskompletowanej przypisanej warstwy', 'W tej lokalizacji nie ma nieskompletowanej partii tego produktu. Sprawdź lokalizację w sekcji „Partie i alokacje magazynowe” niżej.'],
];

/** The API keeps its wording for API clients; the warehouse worker sees where to go next. */
export function orderScanErrorMessage(message: string) {
  return LOT_MESSAGES.find(([server]) => message.includes(server))?.[1] ?? message;
}
