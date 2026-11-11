# Pełny test obciążenia etapu 5 — bieg `full-20261028-01` (28.10.2026)

**Wynik: NIEZALICZONY, bieg przerwany w steady12 po 15 min; steady24 nie uruchomione.** Profil: 60 s rozgrzewki,
30 min × 12, 30 min × 24 klientów, 2 procesy workerów (`MEASUREMENT-MANIFEST-20261025.md` sekcje 5–6,
`LOAD-TEST-DRYRUN-20261027.md` sekcja 9). Od 10:21:44 UTC aplikacja odpowiadała prawie wyłącznie 503, od 10:28
nie było już żadnego sukcesu. Bieg zakończyłem zatrzymaniem kontenerów klientów (10:28:50); raport, drenaż i sprzątanie
wykonał `run.mjs`. Surowe dane: `data/scale/load/full-20261028-01/` (`run.json`, `SUMMARY.md`, `raw/`, `diag/`, `run.log`).

## 1. Wydanie, dane, host

| Pole | Wartość |
|---|---|
| commit | `c3bf16c14280db518c59f68da8d1f191c9c3496c` (HEAD gałęzi po integracji `6f8dd64`, `f5561aa`, `23cc98e`, `53ce44d`) |
| katalog | `local-builds/full-base-preview-20261017/scale-release-full-20261028-01` |
| `release.json` / drzewo pakietu | `c5fde1f2cb6a5c8703b23d05a98df45f658b22f5853a59817beb03e597cfdf60` / `ba041730102bb3a4823bf45b21b7fd90c0e71ef66949227641f69dee3ab82e16` (kontrakt na N29, wersja `1.0.0-full-base-scale-c3bf16c14280.253`, ostatnia migracja `253_mirakl_webhook_retention`) |
| baza | `dynaminds_scale_20261028_81` = `CREATE DATABASE … TEMPLATE dynaminds_scale_20261028_71` (0 połączeń do `_71`, 1 s); `ALTER DATABASE … SET track_functions='all'`; wydanie zmigrowało kopię do 253. `_71` i `_41` nietknięte |
| sterownik | `--warmup 60 --phases steady12:12:1800,steady24:24:1800 --workers 2 --tag 5076fb8f` |
| diagnostyka | `diag/fast.ndjson` (co 30 s: autovacuum, `pg_stat_progress_vacuum`, `pg_stat_database`), `diag/slow.ndjson` (co 180 s: `pg_stat_user_functions`, `pg_stat_user_tables` z rozmiarami, indeksy, kolejka `jobs`), `diag/catalog.ndjson` (co 15 s: relacje TEMP, katalogi systemowe, `guard_verdicts`). `pg_stat_statements` niedostępne (brak w `shared_preload_libraries`; restartu instancji nie robiłem) |
| host | **niekontrolowane obciążenie sąsiednie**: load1 40–58 w steady12 (18 rdzeni), równolegle testy vitest NEXUS innych sesji (procesy node po 90–126 % CPU). Wg `limits.resources.measurement_host_policy` bieg i tak byłby nieważny; liczby przepustowości nie są porównywalne z `fid61-02` (load 15–36) |

## 2. Wyniki per faza

steady12 podzielone na okno przed zapaścią (10:13:41–10:21:30, 461 s) i całość.

| | warmup (60 s) | steady12 do zapaści (461 s) | steady12 całość (15 min) |
|---|---|---|---|
| RPS sukcesu (próg 10) | 7,93 | **6,29** | 2,06 |
| udział zapisów wysłanych (profil 40 %) | 38 % | 34,7 % | 11,2 % |
| błędy | 5 (4 × `return_receive` HTTP_TIMEOUT, 1 × 500) | 37 × `return_receive` HTTP_TIMEOUT | 15 930, w tym **15 892 × 503** |
| odmowy przygotowania | 1 | 44 × `GET /api/orders/:id` 10-s timeout (prep `return_receive`), 28 × `ship-demo` 500, 25 × `ship-demo` timeout | 16 921 (prawie wszystkie 503) |
| oczekiwane odmowy (409 oznaczone) | 0 | 0 | 0 |
| pominięte z braku stanu | 0 | 0 | 0 (stan ~138,5 tys. szt. na firmę, zapas > 600 min) |
| odczyty p95 / p99 ms (próg 500 / 1000) | 442 / 709 | 480 / 695 | 462 / 679 |
| zapisy p95 / p99 ms (próg 4000 / 8000) | 7 770 / 9 260 | **8 197 / 9 329** | 7 570 / 9 300 |
| najstarsze oczekujące zadanie p95 / max (próg 15 / 60 s) | 3,6 / 4,7 s | 3,6 / 8,3 s | — |

Per operacja, steady12 do zapaści (sukcesy): `order_list` p95/p99 350/520, `catalog_search` 480/613, `order_detail`
**617**/805, `order_create` 2 735/4 813, `reserve_and_status` 998/1 467, `payment_or_document` 3 967/5 591,
`stock_operation` 3 915/4 822, `return_receive` **9 573/9 994** ms. Progi niespełnione: `order_detail` (p95),
`return_receive` (p95, p99), przepustowość, zero błędów. `stock_operation` B/D: 66 × `not_bindable` (jak w walidacji).

RPS sukcesu w 60-s kubełkach: warmup 7,85; steady12 6,87 · 6,68 · 7,13 · 5,95 · 6,70 · 6,10 · 5,18 · 5,30 · 2,10 ·
2,82 · 2,93 · 2,68 · 0,55 · 0,92 · 0 (od 10:28). Zimny start: setup 140 s, `dyna-load-app` ~140 s, **`dyna-load-worker-2`
~32 min** (09:40 → 10:12; w łańcuchu zimnej walidacji `parcel_physical_wz_valid()` 1 088 s i `warehouse_wz_issuer_guards()`
570 s w logu PG, przy ~6 s tych samych funkcji później) — próg 180 s niespełniony; przyczyna niepotwierdzona.

## 3. Spadek RPS w fazie — przyczyna

Powtarza się (tu 7,1 → 5,2 RPS w 7 min, `fid61-02` 37,8 → 26,1 w 5 min) bez braku stanu. Przyczyna z dowodami:

1. **Czas klientów idzie w niemierzone przygotowanie, głównie `GET /api/orders/:id`.** `fid61-02` steady24: 202 s na
   833 wywołania (0,24 s) w 1. minucie → 386 s na 521 (0,74 s) w 5.; czas mierzony na żądanie prawie stały (313 → 389 ms).
   Tu w steady12: 0,54 s → 1,5 s na wywołanie, potem 10-s timeouty przygotowania `return_receive`.
2. **Szczegół zamówienia kosztuje jeden pełny strażnik na każdą sprawę zwrotu zamówienia.** `getOrder` →
   `hydrateOrder` → `returnOverview` (`server/domain.ts:230`) → `returnPage` → dla każdej sprawy
   `catalogStockReturnDocumentsInTx` (`server/return-query.ts:96`) → `catalogStockControlAvailable` →
   `guard_verdict('catalog_stock_control_guards')` (`server/catalog-stock-control-transaction.ts:39`). Odczyt idzie przez
   `tenantReadTx` = `REPEATABLE READ` (`server/db.ts:172`), a werdykt 248 poza READ COMMITTED zawsze woła pełnego
   strażnika (`server/248_guard_verdicts.sql:120`). Pomiar na `_81` bez obciążenia: `guard_verdict` w READ COMMITTED
   8–28 ms (trafienie), w `REPEATABLE READ READ ONLY` 736–1 033 ms.
3. **Liczba spraw na zamówieniu rośnie z czasem fazy.** `return_receive` tworzy sprawę na 1 szt. wysłanego zamówienia
   zbioru i bierze ciągle te same zamówienia: w biegu 35 zamówień dostało sprawy, mediana 5, max 11 spraw na zamówienie;
   najwyższa liczba wcześniejszych spraw na zamówieniu rosła 1 → 3 → 4 → 5 → 7 → 8 (10:12–10:17). Przy 11 sprawach i
   ~1,5 s strażnika pod obciążeniem odczyt zamówienia trwa > 10 s (timeout klienta).
4. **Baza to potwierdza.** Udział pełnego strażnika w wywołaniach `guard_verdict` (`diag/slow.ndjson`, okna 180 s):
   15 % → 23 % → 40 % → 56 %, średni `guard_verdict` 231 → 373 → 658 → 831 ms; `catalog_stock_control_guards` 1,3–1,6 s
   pod obciążeniem (0,35 s w zimnym starcie), ~4 rdzenie bazy. Wszystkie pełne przebiegi wypadają przed
   `guard_verdict_basis()` (wywołania `guard_verdict` − `guard_verdict_basis` = `guard_verdict_full`, np. 769 − 460 = 309),
   a tabele podstawy werdyktu mają 0 zapisów i wiersz `guard_verdicts` nie zmienił się od 10:12:36 — to gałąź izolacji, nie
   unieważnienie werdyktu. Próbki aktywnych backendów: `guard_verdict('catalog_stock_control_guards')` 1,4 → 5,2
   (tu), 1,4 → 4,6 (`fid61-02` steady24).
5. Wykluczone: relacje TEMP (0 w każdej próbce `diag/catalog.ndjson`), wzrost danych (strażnicy na `_71` i `_81` bez
   obciążenia: `manual_inventory_off_valid` 765–840 ms vs 645–700 ms, w granicach szumu hosta), brak stanu (0 pominiętych).

Dlaczego RPS wraca na początku następnej fazy — niepotwierdzone (podział kandydatów `index mod clients` zmienia się z liczbą
klientów; nie sprawdzałem, czy nowi klienci biorą zamówienia z mniejszą liczbą spraw).

## 4. Zapaść 503 (10:21:44)

- Treść każdej odpowiedzi: `{"statusCode":503,"code":"ERR_ASSERTION","message":"ordinary-original-request-required"}`, także
  dla `/api/health`. To odmowa przyjęcia w `admitOrdinaryRequest` (`server/ordinary-request-lifetime.ts`, limit
  `ACTIVE_REQUESTS=128`), po której kolejny hak nie znajduje żądania — czyli aplikacja liczyła ≥ 128 aktywnych żądań przy
  12 klientach z jednym żądaniem w locie.
- W tym czasie baza była prawie bezczynna: aplikacja miała 2–3 połączenia (pula `max: 12`), połączeń bazy 15 → 5–7,
  aktywnych backendów 8 → 0,1; CPU `dyna-load-app` 71 %. Tuż przed zapaścią (10:21:23–10:22:15) 8 × `statement timeout`
  w `order_merge_delivery209_validation_snapshot` / `…_predecessor_metadata` (ciało strażnika pod obciążeniem hosta).
- Po zamrożeniu procesów klientów (`kill -STOP`, 10:26:37–10:27:19) `/api/health` zwracało 200 po ~25 s; po wznowieniu
  zapaść wróciła w ciągu minuty, od 10:28 bez sukcesów. Nie jest to więc trwały wyciek, tylko stan podtrzymywany ruchem.
- Hipoteza (niepotwierdzona): żądania porzucone przez klienta po 10 s (76 timeoutów i 59 × 500 przed zapaścią) dalej trzymają
  miejsce do końca pracy po stronie serwera, a odpowiedzi 503 bez namysłu (1–3 ms, ~120 żądań/s) utrzymują licznik przy
  limicie. Brak w wydaniu podglądu `inspectOrdinaryRequests`, więc licznika nie odczytałem.
- 28 × 500 na `POST /api/orders/:id/ship-demo` w przygotowaniu: bez błędu w logu PG — przyczyna niepotwierdzona
  (aplikacja działa z `logging:false`).

## 5. Stan po biegu

- Procesy: żadnego kontenera `dyna-load-*`, samplery diagnostyki zatrzymane.
- Bazy: `dynaminds_scale_20261028_81` **zostaje** do analizy (596 MB przed biegiem, ledger 253, 35 zamówień ze sprawami
  zwrotu z biegu); `_71`, `_61`, `_41` bez zmian.
- Do pełnego biegu potrzebne: odczyt szczegółu zamówienia bez pełnego strażnika na sprawę (decyzja produktowa, SQL
  zapieczętowany), wyjaśnienie zapaści 503 i zimnego startu workera, host bez obciążenia sąsiedniego.

## 6. Analiza po biegu (28.10, popołudnie)

- **Zapaść 503: przyczyna potwierdzona i naprawiona (`0565110`).** Klient porzuca żądanie po 10 s, `close` ustawia
  `finished`. Gdy trasa kończy się później, `reply.send` uruchamia haki `onSend`, a `tracked()` odrzuca je na zakończonym
  żądaniu (`ORDINARY_RUNTIME_CLOSING`). Ten błąd przechodzi przez własny hak `onError` (`awaitingError=true`), handler
  błędów aplikacji go czyści, ale jego `reply.send` trafia na tę samą odmowę: drugi błąd znów ustawia `awaitingError=true`
  i idzie już do domyślnego handlera Fastify, który nie woła `runOrdinaryRequestError`. Slot nie zwalnia się nigdy.
  Przed zapaścią było ~125 porzuceń (59 × `GET /api/orders/:id`, 29 × `ship-demo`, 37 × `return_receive` HTTP_TIMEOUT)
  przy limicie 128. Po zamrożeniu klientów zwalniały się tylko sloty żądań jeszcze pracujących, więc `/api/health`
  wracało na chwilę. Naprawa: po zakończonym ostatnim etapie błędu późniejsze błędy nie wstrzymują zwolnienia. Slot nadal
  trzyma żądanie, którego handler jeszcze pracuje po zamknięciu gniazda. Test `tests/ordinary-request-lifetime-abort.test.ts`
  (czerwony przed, zielony po). `/api/health` podaje teraz `ordinary_requests` (`active_requests`,
  `active_requests_limit`, `active_tasks`, `refused_admissions`).
- Treść 503 `ERR_ASSERTION ordinary-original-request-required`: odmowa przyjęcia idzie przez handler błędów, a jego
  `reply.send` uruchamia opakowany hak `onSend` dla nieprzyjętego żądania. Asercja kończy się odpowiedzią domyślnego
  handlera Fastify ze statusem 503. Status jest właściwy, treść myląca; nie zmieniane.
- **28 × 500 na `ship-demo`: `statement timeout` 8 s w `wz_issuer239_prepare_skip`.** Wpis w logu PG jest
  (`docker logs dyna-scale-pg18`, np. 10:15:51.511, 10:15:52.687, 10:16:01.835 = chwile końca 500 w
  `raw/steady12-c*.prep.ndjson`): `canceling statement due to statement timeout`, CONTEXT
  `wz_issuer239_prepare_skip` → `wz_issuer239_verdict()` → `warehouse_wz_issuer_guards()` → `parcel_physical_wz_valid()`
  → `wave_print177_valid()`. W 09:30–10:30 59 takich timeoutów = 30 × 500 (9,1–9,99 s) + 29 × HTTP_TIMEOUT klienta na
  `ship-demo`. Kod 57014 nie jest mapowany w handlerze błędów (`server/app.ts`), stąd „Nieoczekiwany błąd serwera”.
  Wcześniejsze „bez śladu w logu PG” było błędne.
- **Zimny start `dyna-load-worker-2` ~32 min: uśpienie hosta.** `pmset -g log` (+0100): 10:40:40 Clamshell Sleep na
  baterii (7 %), 10:43:42 Maintenance Sleep 1079 s, 11:01:59 Maintenance Sleep 564 s, wybudzenie 11:11:49. W logu PG
  `parcel_physical_wz_valid()` 1 087 613 ms (koniec 10:02:00Z) i `warehouse_wz_issuer_guards()` 569 697 ms (koniec
  10:11:58Z), czyli długości snu; zegar VM Dockera stoi, więc `statement_timeout` nie zadziałał. Bez zmian w kodzie.
  Skutek uboczny: 11 × timeout `pg_advisory_lock_shared(982376)` w app-1, gdy worker-2 trzymał wyłączną blokadę zimnej
  aktywacji.
