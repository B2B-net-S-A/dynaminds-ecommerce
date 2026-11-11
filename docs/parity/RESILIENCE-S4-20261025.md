# S4 — testy awarii: restart, duplikat, timeout, utracony ACK (25–26.10.2026)

Tor S4 z `docs/parity/STAGE4-NONINTEGRATION-GAP-20261025.md` (obszar 3, RES-21, RES-13, RES-18, RES-02).
RES-04 (KSeF) należy do toru L1, RES-07 (DHL/Poczta Polska) do toru L3 — tu pominięte.
Wymóg celu: restart, duplikat, timeout, utracony ACK — zero podwójnych skutków.

## Jak testy symulują awarię

- **Restart procesu** — w tym samym procesie: stary worker jest porzucany w trakcie wywołania (jego
  transport nie odpowiada, dopóki test go nie zwolni), dzierżawa zadania jest postarzana ponad próg
  reapera (2 min), a nowy `tick()` gra rolę procesu po restarcie. Wspólnych serwerów nikt nie zatrzymuje.
- **Awaria po COMMIT, przed potwierdzeniem** — test wykonuje kroki procesu ręcznie (przejęcie zadania,
  wywołanie drukarki) i „umiera” przed zapisem wyniku.
- **Utracona odpowiedź drukarki** — proxy TCP (`tests/failure-helpers.ts`, `lostAnswerProxy`) przed
  lokalną fałszywą drukarką z migracji 233: polecenie trafia do drukarki, drukarka drukuje, a połączenie
  z aplikacją jest zrywane przed linią odpowiedzi.
- Testy z bazą działają na świeżych klonach PG04 `dynaminds_s4_20261025_NN` (szablon
  `dynaminds_restore_36751abef3079f3f` + prawdziwe `migrate()`); kopia ma setki oczekujących zadań
  prawdziwych kanałów, więc testy najpierw je parkują (`quiesceJobs`), żeby `tick()` przejął tylko
  zadania testu. Webhook lokalny nigdy nie idzie na port 4100 (`PORT=59997`, zawsze transport testu).

## Pliki

| Plik | Co sprawdza | Baza |
|---|---|---|
| `tests/failure-job-kinds.test.ts` | statycznie, z kodu: każdy kolejkowany kind ma właściciela, kindy z I/O mają własną obsługę błędu, wiersze stanu są uzgadniane po wygaśnięciu dzierżawy ostatniej próby, zewnętrzne zapisy mają trwały znacznik przed wywołaniem | nie |
| `tests/failure-worker-claims.test.ts` | `tick()` a kindy innych pętli (AI, DeepL, `automation.local_stock`) | tak |
| `tests/failure-outbound-webhooks.test.ts` | RES-13 i RES-21 przez prawdziwy `tick()`: restart w trakcie HTTP, stary worker, timeout po przyjęciu, backoff, wyczerpanie prób, reaper, dwa procesy naraz | tak |
| `tests/failure-fiscal-documents.test.ts` | RES-18 paragon (restart po przejęciu, po wydruku, utracona odpowiedź na CLOSE, podwójne kliknięcie) i RES-02 równoległa seria 230 | tak |
| `tests/failure-helpers.ts`, `tests/failure-helpers-fiscal.ts` | pomocnicze | — |

## Wyniki: scenariusz → wynik

Biegi: klony `_02`–`_05` (pierwszy `_01` służył do strojenia). Dwa znaleziska oznaczone pierwotnie jako `todo`
(test opisuje poprawne zachowanie, wtedy padał) są poprawione 26.10.2026 i `todo` zdjęte — opis przy wierszach
„poprawione” niżej.

### RES-21 restart procesu i reapery (`failure-outbound-webhooks`, `failure-worker-claims`, `failure-job-kinds`)

| Scenariusz | Wynik |
|---|---|
| Restart w trakcie HTTP: odbiorca przyjął, ACK utracony; dzierżawa wygasa, nowy `tick()` wysyła ponownie | bez podwójnego skutku: ten sam Delivery-ID, Event-ID i body, nowy ważny podpis; lokalny odbiorca ma 1 wpis; `attempts=2`, `done` |
| Żywa dzierżawa (< 2 min) | drugi proces jej nie przejmuje (0 wysyłek) |
| Stary worker „budzi się” z 200 albo z błędem po przejęciu | fence: nic nie zapisuje (`delivered`/`done` zostają), nic nie wysyła |
| Awaria po COMMIT przejęcia, przed HTTP | po wygaśnięciu dzierżawy dokładnie 1 wysyłka |
| Trzy `tick()` naraz na jedno zadanie | przejęte raz, 1 wysyłka (`SKIP LOCKED`) |
| Wygasła dzierżawa ostatniej próby | reaper: zadanie i dostawa `failed` w tym samym cyklu, bez wysyłki |
| Statycznie: każdy kolejkowany kind (45) ma właściciela; kindy z I/O mają własną obsługę błędu; wiersze stanu obsługi błędu są uzgadniane po wygaśnięciu dzierżawy; zewnętrzne zapisy mają znacznik przed wywołaniem | przechodzi; listy wyjątków mają powód przy każdej pozycji, a test mutacyjny (usunięcie pozycji) pada |
| `tick()` a kindy innych pętli: `catalog.ai`, `catalog.deepl`, `catalog.deepl.batch` | nie przejmuje |
| `tick()` a `automation.local_stock` | **poprawione 26.10.2026** (było: utracony skutek — `tick()` przejmował zadanie pętli reguł i kończył je `failed` „Nieobsługiwane zadanie”, `max_attempts=1`, więc zmiana stanu z reguły przepadała; zmierzone przed poprawką `[true,'failed',1,'Nieobsługiwane zadanie: automation.local_stock']`). Teraz `server/worker.ts` wyłącza `'automation.local_stock'` z przejęcia (`kind NOT IN (...)`): `tick()` zwraca `false`, zadanie zostaje `pending`, `attempts=0` dla pętli reguł. Inne kindy tylko pętli z zakresem: brak (`automation`, `automation.run`, `email.send` mają procesor w `tick()`; test statyczny sprawdza wszystkie 45). Reaper `tick()` nadal obejmuje `automation.local_stock` celowo: wygasła dzierżawa po przejęciu przez pętlę reguł (`attempts=1=max_attempts`) kończy się `failed` bez ponowienia, czyli wynik do uzgodnienia, a nie drugi skutek; bez reapera zadanie zostałoby `running` na zawsze. `server/worker-supervisor.ts` nie przejmuje zadań (tylko planuje kroki), więc nie wymaga zmiany. |

### RES-13 webhooki wychodzące (`failure-outbound-webhooks`)

| Scenariusz | Wynik |
|---|---|
| Timeout zewnętrznego odbiorcy (HTTPS) po przyjęciu | bez podwójnego skutku: retry po 30 s z tym samym Delivery-ID i body, nowym podpisem; odbiorca deduplikujący ma 1 skutek |
| Retry przed terminem | brak wcześniejszej wysyłki |
| Backoff | 30, 60, 120 s (30·2^(n−1)); `Retry-After: 900` wygrywa; treść błędu odbiorcy nie trafia do bazy |
| Wyczerpanie 8 prób | `failed`, dalsze `tick()` nic nie wysyłają |

Kontrakt pozostaje at-least-once: zero podwójnych skutków zależy od deduplikacji po `X-Dyna-Delivery-ID`
u odbiorcy (lokalny odbiorca to robi). Luka z audytu „UI i OpenAPI nie mówią, że odbiorca musi
deduplikować” zostaje (pliki toru S0/UI, nie S4).

### RES-18 paragon fiskalny (`failure-fiscal-documents`, fałszywa drukarka 233)

| Scenariusz | Wynik |
|---|---|
| Restart po COMMIT przejęcia (`sent`), przed drukarką | bez podwójnego skutku: faktura 230 i 157 odmawiane („w trakcie druku”), drugi paragon odmawiany, „Ponów druk” drukuje raz (`attempts=1`, audyt `recovery: true`) |
| Restart po wydruku, przed zapisem wyniku | bez podwójnego skutku: ponowienie robi QUERY, zapisuje ten sam numer, `already_printed: true`, 1 paragon w pamięci drukarki |
| Utracona odpowiedź na CLOSE, potem „Ponów druk” | bez drugiego druku: QUERY → ten sam numer, 1 paragon |
| Utracona odpowiedź na CLOSE, przed ponowieniem | **poprawione 26.10.2026** (było: podwójny skutek — paragon w pamięci drukarki, a aplikacja zapisywała `failed` (OFFLINE), więc podgląd faktury 230 dla tej sprzedaży przechodził, a 157 nie blokował; zmierzone przed poprawką na `_22`: `['failed', 201]`). Teraz paragon zostaje `sent` („Wysłany do drukarki”, przycisk „Sprawdź i ponów druk”), podgląd 230 odpowiada 409, a 157 odmawia „w trakcie druku”: `['sent', 409]`. |
| Podwójne kliknięcie (ten sam `client_key`) i 3 różne żądania naraz | bez podwójnego skutku: 1 paragon w drukarce, odpowiedzi 200/201/409, bez 500 |

Poprawka RES-18 (26.10.2026, bez migracji; UI już obsługuje `sent` przyciskiem „Sprawdź i ponów druk”):
1. `server/receipt233-printer.ts`, `printReceipt`: błąd `OFFLINE` (zerwane połączenie, brak odpowiedzi w czasie)
   w bloku po `OPEN` (LINE/PAY/CLOSE) jest rzucany jako niepewny:
   `new PrinterError('OFFLINE', 'odpowiedź utracona po otwarciu paragonu', { uncertain: true })` (nowe pole
   `uncertain` w `PrinterError`, domyślnie `false`); `attemptPrint` przenosi je do `PrintOutcome`
   (`{ ok: false, code, message, uncertain }`). OFFLINE przed `OPEN` (HELLO, PTUCHECK, QUERY, NIP, OPEN) zostaje
   pewnym błędem: bez `OPEN` drukarka nic nie drukuje.
2. `server/receipt233.ts`, `recordReceiptOutcomeInTx`: przy `uncertain` stan zostaje `sent` (CHECK tabeli
   nie pozwala na `error_code` w `sent`), zapisuje się tylko audyt `receipt233.uncertain` (`code`, `attempts`).
   Stan `sent` blokuje faktury 230 i 157, a ponowienie najpierw pyta drukarkę (QUERY), więc nie drukuje drugi raz.
3. `todo` zdjęte z testu w `tests/failure-fiscal-documents.test.ts`; nowy test jednostkowy w
   `tests/receipt233-printer.test.ts` (zerwanie na CLOSE → `OFFLINE`, `uncertain: true`, potem QUERY znajduje
   ten sam paragon, 1 w pamięci drukarki; OFFLINE przed OPEN → `uncertain: false`).

### RES-02 numeracja faktur 230 (`failure-fiscal-documents`)

| Scenariusz | Wynik |
|---|---|
| Dwie faktury naraz w nowej serii (bez wiersza licznika), potem dwie naraz z licznikiem | bez podwójnego skutku: numery 1–4 bez luk i duplikatów, bez 500 |

## Liczby testów (ostatnie biegi)

- `failure-job-kinds.test.ts`: 6 testów, 6 pass, 0 todo (bez bazy; przed poprawką 26.10 test 2 padał:
  „automation.local_stock would be claimed by tick()…”).
- `failure-worker-claims.test.ts`: 2 testy, 2 pass (klon `_24`; przed poprawką na `_21`: 1 pass, 1 fail
  `[true,'failed',1,'Nieobsługiwane zadanie: automation.local_stock']`).
- `failure-outbound-webhooks.test.ts`: 7 testów, 7 pass.
- `failure-fiscal-documents.test.ts`: 6 testów, 6 pass (klon `_23`; przed poprawką na `_22`: 5 pass, 1 fail
  `['failed', 201]`).
- Po poprawce RES-18 także `tests/receipt233-printer.test.ts`, `receipt233-model`, `receipt233-settlement`
  17/17 i `web/receipt233.test.mjs` 6/6.

## Uwagi środowiskowe

- Na kopii produkcyjnej utworzenie produktu i zamówienia trwa ok. 14 s każde (globalne strażniki, np.
  `pim_dictionary_valid()`, przy wspólnym PG04 z kilkoma torami). Przy 8 s `statement_timeout` puli
  przygotowanie zamówień w teście paragonów padało (57014), więc ten plik podnosi limity sesji puli tylko
  w swoim procesie (`relaxPoolTimeouts`). Transakcje `tenantTx` zachowują swoje `SET LOCAL 8s`.
- Każdy plik z bazą wymaga świeżego klonu (testy fiskalne odmawiają ponownego biegu na tym samym klonie).
- Nie testowano: drenażu `startWorker()` przy SIGTERM (pętla uruchamia harmonogramy wszystkich kanałów
  kopii, a e-mail idzie bez transportu testu — ryzyko prawdziwej wysyłki z kopii produkcyjnej).
