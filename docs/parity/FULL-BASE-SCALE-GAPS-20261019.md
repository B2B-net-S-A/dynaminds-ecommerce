# Pełny profil skali Base — luki narzędzi, 19.10.2026

**Status: OPEN / pomiar niewykonany.** To przegląd plików, nie wynik obciążenia.
Nie uruchomiono benchmarku, HTTP, SQL, aplikacji ani workerów. Raport nie zmienia
Goala, zakresu z 17.10.2026 ani zamrożonej specyfikacji skali.
Odwołania `plik:wiersz` dotyczą źródeł odczytanych przy sporządzaniu raportu.

Wymagany profil już istnieje w `docs/parity/acceptance-profile.v1.json:14`:
100 tys. SKU i 100 tys. zamówień, po 20 tys. każdego rodzaju w pięciu firmach,
180 dni historii (`:60`, `:85`), 600 s rozgrzewki i dwie fazy po 1800 s przy
12 i 24 klientach (`:113`). Progi p95 wynoszą 500 ms dla odczytów i 4000 ms
dla zapisów (`:283`); dotyczą operacji, firm i faz, a nie wyłącznie jednej
zbiorczej średniej. Specyfikacja pozostaje `measurement_performed:false`.

## Co rzeczywiście robi istniejący benchmark

- `package.json:27` kieruje `benchmark:scale` do `scripts/scale.ts:26`.
  Operator używa osobnej bazy, lecz ma stały port 55432 (`:11`) i uruchamia
  źródłowy skrypt, nie normalny, przypięty pakiet docelowego wydania.
- `scripts/scale-measure.ts:35` ładuje syntetyczne dane z tymczasowo wyłączonymi
  triggerami: 100 firm, po 10 tys. produktów i 1000 zamówień cancelled
  (`:40`, `:56`, `:65`). Globalne 1 mln SKU / 100 tys. zamówień nie zastępuje
  wymaganego rozkładu 5 × 20 tys. / 20 tys., historii i zwykłych przejść biznesowych.
- `scripts/scale-measure.ts:213` uruchamia `buildApp()` bez konfiguracji
  wymaganych scoped workerów. Pomiar to 400 żądań przy 100 klientach (`:244`),
  nie godzina 12/24. P95 jest wyliczane (`:426`), ale nie sprawdzane względem SLO.
  Sam raport uczciwie ogranicza wynik do krótkiego burstu (`:507`).
- `tests/benchmark.test.ts:12` to jeszcze mniejszy test 20 firm / 200 SKU /
  400 żądań przez Fastify inject. Nie dowodzi sieciowej ani docelowej skali.

## Siedem jawnych bramek pełnego sterownika

Lepszą podstawą jest istniejący `scripts/full-base-scale-executor.mjs:30`:
monotoniczny zegar, fazy, rzeczywiste przedziały in-flight, osiem klas operacji
i histogramy osobno dla firmy/fazy/wyniku. Nie trzeba budować nowego load frameworka.
Pełny entrypoint nadal celowo odmawia: `scripts/full-base-scale-http-ports.mjs:258`
oraz `:267` wskazują następujące brakujące warunki:

1. Egzekwowanie proporcji przypadków odczytu i wariantów.
2. Pełne przejścia rezerwacji/statusów i uzgodniona konkurencja o zapas.
3. Bieżące wersje zapasu i wymagany udział gorących SKU.
4. Pełny zestaw zwrotów wraz z uzgodnieniem fizycznym i finansowym.
5. Równy udział płatności/dokumentów oraz uzgodnienie ich efektów.
6. Godzinny lifecycle poleceń, aktualnych wersji i wygasających podglądów.
7. Rzeczywiste tożsamości pięciu firm, zbiór danych oraz praca worker/import/sync.

## Najmniejsza adaptacja istniejących narzędzi

1. **Legalny lifecycle zamiast powielania fixture.** Obecny format dopuszcza do
   100 przypadków na firmę/operację i 60 kB całej fixture
   (`scripts/full-base-scale-http-ports.mjs:177`), a zapisy konsumuje jednokrotnie
   (`:249`). To najwyżej 2500 zapisów w pięciu klasach i pięciu firmach.
   Przy wymaganych 10/20 udanych RPS oraz 40% zapisów godzina potrzebuje co najmniej
   21 600 zapisów, dodatkowo rozgrzewki. Należy rozszerzyć istniejący driver o jawne
   zwykłe kroki preview/CAS/readback, mierzone i rejestrowane w tym samym budżecie
   klientów. Nie ukrywać dodatkowego HTTP w synchronicznych prepare/complete,
   nie ponawiać UNKNOWN i nie uznawać starych kluczy za nowe zapisy.
2. **Zbiór i działające tło.** Przygotować izolowane 5 × 20 tys. / 20 tys.
   z wymaganą historią i WMS; potwierdzić zwykłe sesje/IAM oraz rzeczywiste
   scoped opt-in. W obu fazach mierzyć na firmę i minutę co najmniej 5 efektów
   automatyki, 6 importów i 12 aktualizacji stock (`acceptance-profile.v1.json:236`).
   Liczyć efekty, nie samo włączenie flag czy cykle. Globalny legacy worker/reaper
   pozostaje wyłączony; brak którejkolwiek wymaganej ścieżki blokuje pełny pomiar.
3. **Weryfikator wyniku, nie nowy generator dowodów.** Wykorzystać obecne próbki
   i dodać ocenę SLO/RPS, minimum próbek, 95% aktywności klientów i niezależnego
   server ingress, pool/RSS/CPU/backlog (`acceptance-profile.v1.json:200`, `:216`,
   `:306`). Executor obecnie zwraca wyłącznie `scale_acceptance:false`
   (`scripts/full-base-scale-executor.mjs:75`), nawet po zakończeniu faz.
4. **Uzgodnienie i jedno wydanie.** Powiązać pełny ledger HTTP/import/stock
   z końcowymi stanami, brakiem duplikatów/oversell oraz izolacją firm; wykonać
   cold start, awarie i restore na tej samej linii wydania/konfiguracji/danych
   (`acceptance-profile.v1.json:333`, `:347`). Dotychczasowe małe odbiory naturalne
   są dowodem możliwości ścieżek, nie zastępstwem godzinnego profilu.

Przed adaptacją potrzebny jest ponowny przegląd code→DTO: 3 z 24 zapisanych pinów
`SCALE_HTTP_PORT_SOURCE_PINS` różniły się od bieżących plików (`server/app.ts`,
`server/domain.ts`, `server/payment-routes.ts`). Nie wystarczy podmienić hashy.
Zachować runtime SQL/lock 8 s, normalny klient PG 9 s i osobny deadline HTTP
drivera 10 s z profilu; nie obniżać wymagań ani usuwać siedmiu bramek przed
ich rzeczywistym wdrożeniem. Pełna skala nadal **OPEN**.
