/** Serializes cooperating tabs for one tenant/user, including manual reconciliation.
 * The durable v1/v2 journal remains authoritative after this temporary lock ends. */
export async function withReturnCreditCustodyLock<T>(actor: string, run: () => Promise<T>, locks: LockManager | undefined = globalThis.navigator?.locks): Promise<T> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(actor)) throw Error('Nie można potwierdzić tożsamości zapisanej próby.');
  if (!locks || typeof locks.request !== 'function') throw Error('Ta przeglądarka nie udostępnia bezpiecznej blokady zapisu między kartami.');
  return locks.request('dyna:consumer-return-credit:v1:' + actor + ':exclusive', {mode: 'exclusive', ifAvailable: true}, async lock => {
    if (!lock) throw Error('Inna karta obsługuje zapis lub odczyt oryginalnego wyniku. Spróbuj ponownie po jej zakończeniu.');
    return run();
  });
}
