// Labels of migration 245: channel inbox, IMAP schedules, portal link validity.
const channels: Record<string, string> = { allegro: 'Allegro', ebay: 'eBay', amazon: 'Amazon', helpdesk: 'Helpdesk' };
export const channelLabel = (c: string): string => channels[c] ?? c;
const methods: Record<string, string> = {
  in_reply_to: 'automatycznie: odpowiedź na naszą wiadomość',
  references: 'automatycznie: wątek naszej wiadomości',
  subject_number: 'automatycznie: numer zamówienia w temacie i adres kupującego',
};
export const matchLabel = (m: string | null): string => (m ? methods[m] ?? m : 'bez dopasowania');
const outcomes: Record<string, string> = {
  bound: 'Przypisano',
  ambiguous: 'Kilka pasujących zamówień — wybierz ręcznie',
  none: 'Brak dopasowania — przypisz ręcznie',
  failed: 'Przypisanie nie powiodło się — przypisz ręcznie',
};
export const matchOutcomeLabel = (o: string): string => outcomes[o] ?? o;
const runs: Record<string, string> = {
  fetched: 'Odczytano nowe wiadomości',
  empty: 'Brak nowych wiadomości',
  failed: 'Błąd odczytu — ponowimy w następnym cyklu',
  refused: 'Wstrzymany: brak uprawnień osoby, która włączyła odbiór',
};
export const scheduleOutcomeLabel = (o: string | null): string => (o ? runs[o] ?? o : 'Jeszcze nie uruchomiono');
export const portalPolicySummary = (days: number | null): string =>
  days === null ? 'Linki bez terminu ważności' : `Nowe linki ważne ${days} ${days === 1 ? 'dzień' : 'dni'}`;
const plural = (n: number, one: string, few: string, many: string) =>
  n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
export const pendingRepliesLabel = (n: number): string =>
  `${n} ${plural(n, 'odpowiedź czeka', 'odpowiedzi czekają', 'odpowiedzi czeka')} na konektor`;
