# Pełny test obciążenia etapu 5 — bieg `full-20261029-01` (29.10.2026)

**Wynik: NIEZALICZONY.** Przepustowość, opóźnienia, workery i zimny start mieszczą się w progach z dużym zapasem
(57,5 RPS przy 12 klientach, 65,9 RPS przy 24, odczyty p99 ≤ 83 ms, zapisy p99 ≤ 929 ms). Bieg nie spełnia jednak
warunku „zero błędów” ani wierności mieszanki. Trzy przyczyny w kolejności wagi:

1. Limit 600 żądań/min na adres klienta w produkcie: 29 149 odpowiedzi 429 w steady12.
2. Dożywotni limit 2000 podglądów WMS na firmę w produkcie: `stock_operation` firm A/C/E przestaje działać w steady24.
3. Błąd sterownika: `order_detail` nie wysłany w steady24. Poprawiony w `c30ab87`.

Bieg jest ważny: host był cichy, zasilanie z sieci, pokrywa otwarta, sen nie wystąpił, żadna faza nie jest NIEWAŻNA.
Profil: 60 s rozgrzewki (wg zlecenia; profil przewiduje 600 s), 30 min × 12, 30 min × 24 klientów, 2 procesy workerów.

Surowe dane: `data/scale/load/full-20261029-01/`:
- `run.json`, `SUMMARY.md`, `raw/`;
- `diag/` z `pg_stat_user_functions` co 180 s;
- `extra/`: migracja i strażnicy, host przed i po, log biegu.

## 1. Wydanie, dane, host

| Pole | Wartość |
|---|---|
| commit wydania | `c71817420b89c1b3b306d693d79e30dbff34ccc8` = `fcc7b89` + `c718174` (limit pliku pakietu, niżej) |
| katalog | `local-builds/full-base-preview-20261017/scale-release-full-20261029-02` |
| `release.json` / drzewo pakietu | `b0b0a5a3dc22d9cedffa4a4c4f4b4c03c6f6570fdda805956bf7f4265cad345a` / `17e0b06540fa1226138b73951ab09feb08617be5c64c5193533f4d3716b39cc9`, 449 plików, 102 159 408 B |
| kontrakt źródeł | `d7513512…7167`, `1.0.0-full-base-scale-c71817420b89.258`, 76 krawędzi Native, ostatnia `258_wz_issuer_refresh` |
| sterownik | `tools/scale/load/` z `c718174`, czyli tej samej treści co `fcc7b89`; poprawka `c30ab87` powstała w trakcie biegu i nie była użyta |
| baza | `dynaminds_scale_20261029_81` = `CREATE DATABASE … TEMPLATE dynaminds_scale_20261028_71` o 03:02 UTC, przy 0 połączeń do `_71`; potem `track_functions='all'`. `_71`, `_41` i `_81` z 28.10 nietknięte |
| migracja | fabryka wydania (`migrate()` + zimna walidacja) przed biegiem, 88,7 s; ledger 240 → **248** (`250_wms_evidence_settle_unlocked` → `258_wz_issuer_refresh`) |
| strażnicy po migracji | **12/12 `true`**, sesja `jit=off`, `timezone=UTC` (`extra/migrate-guards-81.json`): 10 strażników + `warehouse_wz_issuer_guards` 1,9 s + `email_inbound_guards` |
| polecenie | `run.mjs --warmup 60 --phases steady12:12:1800,steady24:24:1800 --workers 2 --tag 5076fb8f` pod `caffeinate -is` |

Host (Apple M5 Max, 18 rdzeni, 128 GB; VM Dockera 18 CPU / 31 GiB):

| | przed (03:05 UTC) | w biegu | po (04:20 UTC) |
|---|---|---|---|
| load avg | 1,62 / 2,69 / 3,01 | max load1 5,8 (warmup), 11,2 (steady12), 13,0 (steady24): to obciążenie z samego biegu | 1,14 / 3,09 / 6,50 |
| zasilanie | AC, bateria 55 %, ładowanie | AC | AC, 61 % |
| pokrywa / sen | `AppleClamshellState = No`; `sleep 0` (powerd + caffeinate) | `pmset -g log` 04:00–05:21 (+0100): brak Sleep/Wake | — |

Inne kontenery w tym czasie:
- `nexus-staging-*` (8): po < 1 % CPU;
- `cpro-chain-test` i `adoring_bouman`: po ~10 % CPU, nie należą do tego zadania, nie ruszane;
- `dyna-scale-full-pg18`: bez ruchu;
- bazy testowe: bez ruchu.

Jedna przerwa `host_pause` (`process_stall`) 03:05:41–03:07:10, 89,4 s. To `run.mjs` zablokowany w synchronicznym
`spawnSync` kroku setup: zegar ścienny i monotoniczny przesunęły się o tyle samo. Przerwa wypadła przed rozgrzewką,
nie nachodzi na żadną fazę i żadna faza nie jest NIEWAŻNA. To fałszywy alarm detektora, bez wpływu na wynik.

## 2. Zimny start

| Proces | Czas | Próg 180 s |
|---|---|---|
| setup (fabryka wydania na zmigrowanej bazie, sesje, reguły) | 89,4 s (fabryka 87,4 s) | — |
| `dyna-load-app` do `ORDINARY_LOCAL_APP_LISTENING` | **88,3 s** | spełniony |
| `dyna-load-worker-2` | **90,3 s** | spełniony |
| razem, sekwencyjnie | 267,9 s | — |
| dla porównania: 28.10 | app ~140 s, worker-2 ~32 min (sen hosta) | — |
| dla porównania: `l250-head-01` | 196 s | — |

To po jednej próbie na proces. Profil (`timing.cold`) wymaga 3 kolejnych prób i pierwszego uwierzytelnionego odczytu.
Ten odczyt to pierwszy sukces rozgrzewki, kilka sekund po starcie. Wynik jest wskazaniem, nie formalnym odbiorem.

## 3. Wyniki per faza

| | warmup (60 s, 12 kl.) | steady12 (1800 s) | steady24 (1800 s) | próg |
|---|---|---|---|---|
| RPS sukcesu | 60,0 | **57,54** | **65,90** | 10 / 20 |
| najsłabszy 60-s kubełek | 59,98 | 55,25 | 56,57 | ≥ 5 / ≥ 10 |
| dryf w fazie (1. → ostatni kubełek) | — | 58,7 → 56,8 (−3 %) | 73,7 → 58,5 (−21 %) | — |
| żądania wysłane / sukcesy | 4 795 / 3 600 | 132 726 / 103 574 | 118 624 / 118 616 | — |
| błędy | 1 195 × 429 | **29 149 × 429**, 0 × 5xx, 0 timeoutów | **3**: 409 × 1 duplikat numeru, 409 × 2 `stock_shortage` | 0 |
| odmowy przygotowania | 553 × 429 | 16 942 × 429, 2 × 409 wersji | 20 928 `order_detail` (sterownik), 1 583 × 429 limit WMS, 5 brak stanu, 2 × 409 wersji | — |
| oczekiwane odmowy (oznaczone 409) | 0 | 3 (`return_stock_version` 1, `stock_version` 2), brak skutku 3/3 | 5 (`return_stock_version`), brak skutku 5/5 | ≤ 1 % |
| udział zapisów wysłanych | 33 % | 33,2 % | 44,5 % | 40 % ± 2 pp |
| odczyty p95 / p99 ms | 23 / 27 | **22 / 25** | **60 / 83** | 500 / 1000 |
| zapisy p95 / p99 ms | 493 / 680 | **505 / 659** | **659 / 929** | 4000 / 8000 |
| operacje z niespełnionym progiem | 0 | 0 | 0 (`order_detail` bez próbek) | 0 |
| najstarsze oczekujące zadanie p95 / max | 1,07 / 1,48 s | **1,11 / 1,51 s** | **3,54 / 4,63 s** | 15 / 60 s |
| opóźnienie reguły p50 / p95 / p99 | 0,47 / 1,14 / 1,37 s | 0,44 / 1,20 / 1,41 s | 1,96 / 3,41 / 4,03 s | — |
| zadania workerów | 806 | 23 125 | 30 548 | — |
| drenaż po biegu | — | — | 2,0 s | ≤ 120 s |
| CPU `dyna-scale-pg18` średnio / max | 534 / 791 % | 600 / 878 % | 870 / 1029 % | — |
| CPU `dyna-load-app` / `worker-2` średnio | 66 / 17 % | 75 / 16 % | 88 / 19 % | — |

Per operacja, sukcesy, p95 / p99 ms:

| operacja | steady12 | steady24 |
|---|---|---|
| `order_list` | 9 / 11 | 50 / 74 |
| `catalog_search` | 24 / 27 | 66 / 90 |
| `order_detail` | 21 / 25 | — (0 wysłanych) |
| `order_create` | 294 / 463 | 403 / 595 |
| `reserve_and_status` | 48 / 55 | 90 / 113 |
| `payment_or_document` | 736 / 878 | 995 / 1 160 |
| `stock_operation` | 100 / 112 | 147 / 172 |
| `return_receive` | 303 / 336 | 356 / 391 |

Udział firm 19,1–20,8 % (tolerancja ± 2 pp). Opóźnienie pętli zdarzeń klientów: p99 ≤ 14,6 ms. CPU kontenera klienta:
≤ 5 %. Najczęstsze oczekiwania backendów w obu fazach: CPU (~89 %), potem `Lock:advisory` i `Lock:transactionid`.

### PASS/FAIL per kryterium

| Kryterium | steady12 | steady24 |
|---|---|---|
| RPS sukcesu ≥ 10 / ≥ 20 przez całą fazę | PASS (57,5) | PASS (65,9) |
| żaden pełny 60-s kubełek < ½ minimum | PASS | PASS |
| odczyty p95 ≤ 500, p99 ≤ 1000 ms | PASS | PASS (bez `order_detail`) |
| zapisy p95 ≤ 4000, p99 ≤ 8000 ms | PASS | PASS |
| zero nieoczekiwanych błędów / 5xx / timeoutów | **FAIL** (29 149 × 429; 0 × 5xx, 0 timeoutów) | **FAIL** (3 × 409; 0 × 5xx, 0 timeoutów) |
| oczekiwane odmowy ≤ 1 %, z dokładnym powodem i bez skutku | PASS (0,002 %) | PASS (0,004 %) |
| mieszanka ± 2 pp | **FAIL** (zapisy 33,2 %) | **FAIL** (`order_detail` 0 %, zapisy 44,5 %) |
| 0 poleceń pominiętych z braku stanu | PASS | **FAIL** (5) |
| najstarsze oczekujące zadanie p95 ≤ 15 s, max ≤ 60 s | PASS | PASS |
| drenaż ≤ 120 s | — | PASS (2 s) |
| zimny start ≤ 180 s | PASS (88–90 s, jedna próba) | — |
| sen hosta / przerwa w fazie | brak | brak |

## 4. Przyczyny niezaliczenia, z dowodami

### 4.1 Limit 600 żądań/min na adres klienta (produkt, `server/app.ts:764`)

Dane:
- `@fastify/rate-limit` z `max: 600, timeWindow: '1 minute'`, klucz = adres klienta (`server/http-peer-ip.ts`).
- Każdy klient ma własny adres 127.0.0.(11+N), więc limit to 10 żądań/s na klienta, licząc pomiar i przygotowanie razem.
- Wydanie jest teraz na tyle szybkie, że klient w pętli zamkniętej bez przerw wysyła więcej. Wywołania na minutę
  (mierzone + przygotowanie) w minutach 0–7 steady12:
  - `c00`: 800–890 (z czego 177–277 × 429);
  - `c03`: 620–680 (6–66 × 429);
  - `c07`: 560–690.
- Przygotowanie to ~½ ruchu klienta (`GET /api/orders/:id`, `GET /api/products`, podglądy). Sufit z limitu to ~5
  mierzonych żądań/s na klienta, czyli ~60 RPS przy 12 klientach. Zmierzone 57,5 RPS to właśnie ten sufit.
- Przy 24 klientach serwer jest wolniejszy niż limit: 0 × 429 w mierzonych żądaniach, tylko 211 × 429 w przygotowaniu
  `stock_operation`.
- Profil (`limits.expected_contention`) uznaje każde nieplanowane 429 za błąd.

**Decyzja dla koordynatora i Artura.** Do wyboru:
- profil z 12 klientami bez przerw przekracza limit produktu na pojedynczym adresie, przy realnej zdolności
  serwera > 60 RPS;
- limit per adres ustawić konfiguracją pomiaru albo planu;
- zmienić model klienta w profilu.

Obchodzenie limitu przez rotację adresów źródłowych odrzuciłem, bo to obejście zabezpieczenia.

**Decyzja Artura 29.10.2026: limit konfigurowalny per instalacja.**
- Zmienna `DYNA_RATE_LIMIT_PER_MIN` = liczba żądań na minutę z jednego adresu klienta.
  - Bez zmiennej limit wynosi 600, czyli tyle co do 29.10.
  - Klucz bez zmian: adres peera (`server/http-peer-ip.ts`), bez nagłówków przekazujących.
- Dozwolona jest liczba całkowita dziesiętna od 60 do 100 000.
  - Każda inna wartość zatrzymuje start z polskim komunikatem: `server/index.ts` przed `migrate()`,
    CLI wydania przed odczytem selekcji (`ORDINARY_LOCAL_START_FAILED`, `code: RATE_LIMIT_CONFIG_INVALID`).
  - Pusta wartość też zatrzymuje start. Domyślne 600 nie zostaje wtedy przyjęte po cichu.
- Kod: `server/rate-limit-config.ts`, wywołany w `buildApp` (`server/app.ts`).
- Wartość efektywna jest w `GET /api/health` → `rate_limit`.
  Przykład: `{"per_address_per_minute":600,"window_seconds":60,"source":"default"}`; przy ustawionej zmiennej `"source":"env"`.

Jak ustawić:
- Start ze źródeł: `DYNA_RATE_LIMIT_PER_MIN=1200 npm start`. Tak samo działa w środowisku procesu CLI wydania
  (`ordinary-local-cli.mjs`).
- Generator i setup w wydaniu (`scale-pg.sh netns-node`): zmienna z powłoki trafia do kontenera tylko wtedy, gdy jest
  ustawiona (`-e DYNA_RATE_LIMIT_PER_MIN`).
  - `tools/scale/release-runtime.mjs` zapisuje odczytaną wartość w `release.rate_limit`.
  - Wydanie sprzed 29.10 daje `null`.
- Test obciążenia: `node tools/scale/load/run.mjs … --rate-limit-per-min 1200`.
  - Wartość trafia do `app.env` setupu i każdego CLI wydania.
  - `run.json` → `rate_limit` zapisuje to, co każde CLI zwraca w `/api/health`; `SUMMARY.md` ma ją w nagłówku.
  - Niezgodność z opcją przerywa bieg przed rozgrzewką. Tak samo przerywa go opcja podana dla wydania bez tego pola.
  - Bez opcji bieg wymaga 600 z `source: default`. Wydanie sprzed 29.10 zapisuje się jako `source: release-fixed`.

Profil (`limits.expected_contention`) nadal liczy każde 429 jako błąd. Wartość limitu jest więc częścią warunków
biegu, a porównanie dwóch biegów wymaga tej samej wartości.

### 4.2 Dożywotni limit 2000 podglądów WMS (produkt, `server/wms-lots-limits.ts:17`, `:29`; `server/wms-lots-schema.ts:11`)

- `wmsLotsQuotaInTx(c, true)` odrzuca nowy podgląd 429 „Wyczerpano trwały limit dowodów WMS” przy
  `count(*) FROM wms_previews ≥ 2000`. Wiersze są nieusuwalne, a limit jest ten sam dla każdego planu, także enterprise
  (komentarz: „Previews are not the scale blocker”).
- Po biegu A, C i E mają dokładnie 2000 podglądów, a operacji 59 369 / 64 794 / 59 257 (limit enterprise 10 mln).
- Pierwsza odmowa: C 03:56:33, E 04:02:53, A 04:03:06. Od tej chwili każda korekta i przesunięcie WMS tych firm jest
  odrzucane: 1 583 odmowy, `stock_operation` w ostatnich 5 min 0 sukcesów na 719 prób.
- W prawdziwym magazynie 2000 korekt i przesunięć zajmie kilka tygodni. To luka produktu, nie artefakt pomiaru.

### 4.3 `order_detail` bez kandydatów w steady24 (sterownik, poprawione `c30ab87`)

- Przygotowanie czytało 3 najnowsze strony (600) zamówień `new/paid/picking/packed/cancelled` z notą `scale:`.
- Po steady12 (~10 tys. nowych zamówień na firmę) były to wyłącznie zamówienia biegu, więc każde `order_detail` padało
  z komunikatem „no stable dataset orders”: 20 928 razy, 15 % mieszanki.
- Poprawka: kandydaci sprzed `run_started_at` (kursor `cursorBefore`). Test w `tests/scale-load.test.mjs`: czerwony
  przed, zielony po, cały plik 22/22.

### 4.4 Pozostałe błędy steady24 (3 na 118 624)

- **409 „Rekord już istnieje”** (E, 03:57:36): log PG `duplicate key … "orders_tenant_id_number_key"`. Numer zamówienia
  to `DE-<data>-<8 hex losowych>` (`server/domain.ts:659`), bez ponowienia przy kolizji. Przy ~10 160 zamówieniach
  firmy w jednym dniu oczekiwana liczba kolizji to ~0,012 na firmę. Rzadki, ale prawdziwy błąd produktu przy dużym
  wolumenie dziennym.
- **2 × 409 `stock_shortage`** (A, `SC-A-007116`, 04:11): wyścig o skończony stan między przygotowaniem a wysłaniem.
  Nie należy do oznaczonych wyścigów (`EXPECTED_RACES`), więc liczy się jako błąd. Wynika z wyczerpywania stanu
  (punkt 4.5).

### 4.5 Zapas stanu `_71` za mały dla tej przepustowości

- Zużycie: ~1 230–1 320 szt./min na firmę w steady12 i ~1 500–1 540 w steady24. Zbiór był dobrany na ~570–790 szt./min
  (`LOAD-TEST-DRYRUN-20261027.md` §9).
- Pod koniec steady24 zostało 52,8–55,7 tys. szt. na firmę. SKU z ≥ 8 szt. spadło z 4 525–4 631 do 1 663–1 993.
  Okno katalogu dawało „only 24 products with stock ≥ 8”: 5 poleceń pominiętych i 2 × `stock_shortage`.
- Powtórny bieg potrzebuje zbioru o ~2× większym stanie (np. `--skus 80000`) albo krótszych faz.

### 4.6 Dryf RPS w steady24 (−21 %): oczekiwanie klientów na worker, nie wolniejsze żądania

- Czas mierzonych żądań nie rośnie: średnia na próbkę 85 → 64 ms w kolejnych 5-min oknach.
- Rośnie czas niemierzonego przygotowania `reserve_and_status` i `payment_or_document`: 1 373 → 1 880 s i
  2 106 → 2 436 s na 5 min.
- Te przygotowania czekają w pętli co 1 s na notę reguły `order.created` (`prepare.mjs:109`). Opóźnienie reguły rośnie
  w steady24 z p50 1,1 s do 2,9 s (p95 2,0 → 4,0 s), w steady12 jest płaskie (0,42–0,51 s).
- Kandydat na przyczynę wzrostu opóźnienia: zapytanie przydziału zadań workera
  (`SELECT j.* FROM jobs j JOIN order_events e …`, 1 051 próbek aktywnych w steady24). Tabela `jobs` urosła w biegu
  z 7 tys. do 102 tys. wierszy. **Niepotwierdzone:** bez `EXPLAIN` na tym zapytaniu.
  Potwierdzone później w p275 (`docs/parity/SCOPED-CLAIM-P275-20261029.md`): pod RLS złączenie z rzutowaniem z
  `j.payload` nie schodzi do indeksu. Przydział dyspozytora robił merge join po wszystkich zdarzeniach firmy, a przydział
  `automation.run` czytał wszystkie runy reguły.
- Monitor sterownika robi co 1 s `count … FROM jobs WHERE created_at >= …` (sekwencyjny skan całej `jobs`, ~180 skanów
  na 180 s). To własny, rosnący koszt pomiaru; w steady24 jest dodatkowo ~2 skany/s spoza monitora.
- Progi workera (15 / 60 s) są daleko.

### 4.7 Zbliżający się limit historii faktur lokalnych (produkt, `server/157_local_invoices.sql:137`, zapieczętowany)

- `local_invoice_budget` odrzuca każdą kolejną fakturę lokalną (23514 „Limit historii faktur”), gdy firma ma
  > 2000 podglądów albo > 2000 przyjęć faktur, albo > 64 MiB historii. Liczy to pełnym skanem całej historii przy
  każdym zapisie.
- Po biegu firma C ma 1 703 przyjęcia (A 1 317, B 1 473, D 1 686, E 1 272), ~11,6 KB historii na fakturę.
- Średni czas funkcji rośnie liniowo w biegu: 12,6 → 67,2 ms.
- Ten sam limit blokuje pełny zbiór danych: plan ma ~7 400 faktur lokalnych na firmę (0,8 × 40 % wysłanych
  + 5 % zwróconych z 20 000 zamówień). Opis w `FULL-DATASET-GEN-20261029.md`, bieg 4.

## 5. Koszty CPU bazy: najdroższe funkcje (`pg_stat_user_functions`, self time) wobec 28.10

| | 28.10 steady12 przed zapaścią (360 s, 6,3 RPS) | 29.10 steady12 (1800 s, 57,5 RPS) | 29.10 steady24 (1800 s, 65,9 RPS) |
|---|---|---|---|
| suma self time funkcji | 6,95 rdzenia | 4,00 rdzenia | 6,36 rdzenia |
| `warehouse_inventory_policy_guards` | 0,51 r., 4,8 ms/wyw. | **0,98 r.**, 0,9 ms × 1,95 mln | **1,48 r.**, 1,0 ms × 2,57 mln |
| `order_merge_delivery209_validation_snapshot` | **1,85 r., 122,6 ms** | 0,67 r., 17,0 ms | 0,96 r., 17,9 ms |
| `order_merge_delivery209_predecessor_source_sha` | 0,21 r., 1,4 ms | 0,48 r., 0,4 ms × 2,0 mln | 0,68 r., 0,5 ms |
| `local_invoice_budget` | — | 0,17 r., 23,6 ms | 0,49 r., 51,9 ms (rośnie, punkt 4.7) |
| `guard_verdict_basis` | — | 0,31 r., 3,4 ms | 0,45 r., 3,7 ms |
| `enforce_workspace_quota` | — | 0,17 r., 3,4 ms | 0,40 r., 6,0 ms |
| `manual_inventory_off_valid` (pełny strażnik) | 0,55 r., 1 494 ms | 0,10 r., 233 ms × 5 184 | 0,15 r., 246 ms × 7 192 |
| `b2b_credit_fingerprint` | 0,41 r., 414 ms | 0,06 r., 66 ms | — |
| `order_merge_delivery209_predecessor_metadata` | 0,56 r., 437 ms | poza top 12 | poza top 12 |
| `guard_verdict` (całość, mean_total) | 231–831 ms | 11,6 ms × 169 883 | — |
| `catalog_stock_control_guards` / `guard_verdict_full` | 1,3–1,6 s | 245 ms × 5 184 (2,9/s) | — |
| `wz_issuer239_prepare_skip` | timeouty 8 s (500 w `ship-demo`) | 4,3 ms × 2 764 | — |

Wąskie gardła z 28.10 przestały dominować:
- migawka 209: 7× taniej (257);
- strażnik stanu na sprawę zwrotu: werdykt i memo (`f1acaa5`, 255);
- strażnik WZ przy `ship-demo`: 258;
- `b2b_credit_fingerprint`.

Najdroższa jest teraz `warehouse_inventory_policy_guards`: tania na wywołanie (~1 ms), ale ~1 080 wywołań/s przy
12 klientach i ~1 430/s przy 24.

## 6. Porównanie z poprzednimi biegami

| | `l250-head-01` (248+250, 28.10, zbiór 1 %) | `fid61-02` (28.10, `_61`) | `full-20261028-01` (253, host obciążony) | **`full-20261029-01` (258)** |
|---|---|---|---|---|
| RPS sukcesu 12 / 24 kl. | 27,75 / 32,0 (stan wyczerpany, 10,5 % zapisów) | 25,35 / 30,46 (5 min) | 6,29 do zapaści / — | **57,54 / 65,90** |
| dryf RPS w fazie | — | 31,6 → 18,9 / 37,8 → 26,1 | 7,1 → 5,2, potem zapaść 503 | −3 % / −21 % |
| odczyty p95/p99 ms (24 kl.) | 633 / 1 020 | 351 / 519 | 480 / 695 (12 kl.) | **60 / 83** |
| zapisy p95/p99 ms (24 kl.) | 2 970 / 3 480 | 2 480 / 2 690 | 8 197 / 9 329 (12 kl.) | **659 / 929** |
| błędy | 93 | 0 | 15 930 (503) | 29 149 × 429 / 3 |
| zimny start | 196 s | — | app 140 s, worker 32 min (sen) | **88 / 90 s** |
| najstarsze zadanie p95 | — | — | 3,6 s | 1,1 / 3,5 s |

Dryf RPS w steady12 zniknął (−3 %, wcześniej −40 %): pełny strażnik na każdą sprawę zwrotu był przyczyną z 28.10.
Spadek RPS w steady24 ma inną przyczynę (punkt 4.6).

## 7. Narzędzia zmienione w tej sesji

- `c718174` `fix(release)`: wydania z HEAD `fcc7b89` nie dało się zbudować.
  - Wspólny chunk runtime esbuild ma 16 821 474 B, 44 258 B ponad limit członka 16 MiB w `package-builder.mjs` `put()`.
    Wzrost dały pary zimne migracji 255–258; przy 254 było 16 733 899 B.
  - Limit pliku wydania i członka pakietu podniesiony do 32 MiB we wszystkich miejscach, które go sprawdzają:
    `package-builder.mjs`, `emitted-release.mjs`, `portable-release.mjs` `MAX_FILE` (oba z kopią w `shared/…`).
  - Sumy 128 MiB (pakiet) i 64 MiB (kontrakt) bez zmian. Wzorzec: `7720aa1`.
  - Test `tests/emitted-release-member-bound.test.mjs`: 0/2 przed zmianą, 2/2 po. Zestawy pakowania mają te same
    liczby co na HEAD.
  - Decyzja odwracalna, do przejrzenia. `tools/local/restore-preview-operator.mjs:26` nadal czyta moduły z limitem
    16 777 216 B. Sprawdzone 29.10 na wydaniu `scale-release-full-20261029-02`: operator czyta tylko trzy moduły
    profilu (`app`, `db`, `resources`), a każdy musi eksportować `buildApp`, `pool` albo `installRuntimeResources`.
    To `app-LUD5XFRW.mjs` 1 973 706 B, `db-NWMUNJQA.mjs` 1 246 B i `chunk-ONOGCJ77.mjs` 43 324 B. Chunk
    `chunk-FWPRL2LO.mjs` (16 821 474 B) eksportuje tylko program migracji i zimne kontrakty, żadnej z tych trzech
    nazw. Ładuje go `import()` Node jako zależność przechodnią, poza `read()` operatora. Limitu nie zmieniam.
- `c30ab87` `fix(scale-load)`: kandydaci `order_detail` sprzed startu biegu (punkt 4.3).
- `d3dfa1d` `fix(scale-load)`, po biegu: faktury sterownika idą podglądem 230 (`POST /api/invoice230/orders/:id/previews`).
  Mierzone żądanie zostaje aliasem `…/local-invoices/previews/:id/issue`; nowy wariant `invoice230_issue` w bindingach.
  Powód: limit 4.7. Bieg z tą zmianą jeszcze się nie odbył.

## 8. Stan po biegu

- Kontenery `dyna-load-*` usunięte przez `run.mjs`, sampler diagnostyki zatrzymany, `private/` usunięte.
- Baza `dynaminds_scale_20261029_81` zostaje do analizy:
  - ledger 248;
  - ~51 tys. zamówień biegu;
  - 2000 podglądów WMS u A/C/E;
  - 1 272–1 703 faktur lokalnych na firmę.
- `_71`, `_41`, `_61` i `_81` z 28.10 bez zmian.
- Do kolejnego pełnego biegu potrzebne:
  - decyzja o limicie 4.1;
  - zmiana limitu podglądów WMS 4.2 (produkt);
  - zbiór z ~2× większym stanem 4.5;
  - dla dłuższych biegów albo pełnego zbioru: limit faktur 4.7 (zapieczętowany SQL 157, nowa generacja).
