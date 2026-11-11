# Pełny test obciążenia etapu 5 na pełnym zbiorze — bieg `full-20261029-05` (29.10.2026, wieczór)

**Wynik: ZALICZONY we wszystkich kryteriach, które mierzy sterownik.** Obie fazy ważne, bez przerwy hosta:

- **steady12**: 63,61 RPS sukcesu, 0 błędów, odczyty p95/p99 46/52 ms, zapisy 353/538 ms;
- **steady24**: 78,17 RPS sukcesu, 0 błędów, odczyty 112/138 ms, zapisy 462/692 ms;
- obie: 0 × 429, 0 × 5xx, 0 limitów czasu, 0 poleceń pominiętych z braku stanu, mieszanka w tolerancji;
- drenaż 2,0 s, zimny start 113,8 s (aplikacja) i 114,4 s (worker).

Proces aplikacji przeżył całe 30 min przy 24 klientach. W biegu `-02` padł po 15 s na `ERR_HTTP_HEADERS_SENT`;
wydanie z HEAD zawiera poprawkę `ac2377f`/`e90e72d`/`423497f`. Ostrzeżenia odpowiedzi i późne błędy hooków:
**0** (§5).

Poza sterownikiem zostaje to, co w poprzednich biegach (§4.3, manifest §12 „Otwarte” 2–3): import z lokalnego
WooCommerce i synchronizacja stanów jako tło, pomiary zasobów co 1 s po stronie serwera, trzy zimne starty,
rozgrzewka 600 s. Ten bieg nie daje więc pełnego odbioru warunku 10.

Surowe dane: `data/scale/load/full-20261029-05/` (`run.json`, `SUMMARY.md`, `raw/`). W `extra/` są:

- migracja i strażnicy;
- `pg_settings` przed i na pomiar, limity kontenera;
- host przed i po, `host-ps.log` co 30 s, `vm-mem.log` (pamięć VM Dockera co 30 s);
- `diag/` (`pg_stat_database` co 30 s, `pg_stat_user_functions` i tabele co 180 s);
- rozmiary baz `dyna-scale-pg18` przed i po, skrypt migracji (`tooling/`).

## 1. Wydanie, dane, ustawienia

| Pole | Wartość |
|---|---|
| commit wydania | `1b1bb005cd19cbbcefd1297754173e8a001340eb` (HEAD `goal/full-base-20261017`, zawiera `423497f`) |
| katalog | `local-builds/full-base-preview-20261017/scale-release-full-20261029-05` (`tools/scale/release-build.mjs --commit <HEAD>`, 6,6 s) |
| `release.json` / drzewo pakietu | `b6d524dc3c2ce8c480b4a4062e1bb452c959927d0e9653a34902554341968ccf` / `8853d962046351020677e08f2dc45499f4cdcf9a05c8fa89ba9950e879c0ca3e`, 454 pliki, 102 302 094 B |
| kontrakt źródeł | `e5e6daf7e196b6c8b7c545bd014c8d2f2a851a69b1e92ee5831b0da812af1cdc`, `1.0.0-full-base-scale-1b1bb005cd19.262`, 80 krawędzi Native, ostatnia `262_revoke_public_temporary` |
| `/api/health` wydania | `revision` = skrót `release.json`, `schema_revision` `262_revoke_public_temporary`, `rate_limit` 3000/60 s `env`, pola `reply_warnings` i `ordinary_requests.late_hook_failures` obecne |
| sterownik | `tools/scale/load/` z `b92d6b5` (bez zmian względem `-02`; zmiana z §7 weszła po biegu) |
| instancja | `dyna-scale-full-pg18` (`127.0.0.1:57091`), PostgreSQL 18.4 + libfaketime, zegar `+0` |
| baza wzorcowa | `dynaminds_scale_20261029_03`: pełny zbiór, 5 × 20 000 SKU i 5 × 20 000 zamówień, 180 dni, ledger 248 → `258_wz_issuer_refresh`. Nietknięta, tak samo jak `_q597` |
| kopia na bieg | `dynaminds_scale_20261029_07`: `CREATE DATABASE … TEMPLATE dynaminds_scale_20261029_03` przy 0 połączeń do `_03` (19:31 UTC), potem `ALTER DATABASE … SET track_functions='all'` |
| polecenie | `SCALE_PG_CONTAINER=dyna-scale-full-pg18 SCALE_PG_PORT=57091 SCALE_PG_STATE=…/pg18-full-docker caffeinate -is node tools/scale/load/run.mjs --release …/scale-release-full-20261029-05/release-build.json --db dynaminds_scale_20261029_07 --tag 5076fb8f --warmup 60 --phases steady12:12:1800,steady24:24:1800 --workers 2 --rate-limit-per-min 3000` |

### 1.1 Migracja na pełnych danych

Migrację wykonała fabryka wydania (`openReleaseRuntime`: prawdziwe `migrate()` i zimna walidacja), uruchomiona przez
`scale-pg.sh netns-node` w przestrzeni sieciowej instancji. Kontener pomocniczy dostał nazwę `SCALE_GEN_NAME=dyna-scale-full-mig`.
Domyślna `dyna-scale-full-gen` jest zajęta przez zatrzymany kontener generatora z 06:13, z jego logami, którego
nie ruszałem. Wynik jest w `extra/migrate-guards-07.json`.

| kopia | ledger przed → po | `migrate_ms` | zimna walidacja | fabryka razem |
|---|---|---|---|---|
| `_07` | 248 (`258_wz_issuer_refresh`) → **252** (`262_revoke_public_temporary`) | **1 803 ms** | 84,9 s | 113,3 s |

Strażnicy po migracji, sprawdzani w transakcji tylko do odczytu (`jit=off`, `timezone=UTC`): **15/15 `true`**.
To ten sam zestaw co w `-02`. Najdłużej trwały `pim_dictionary_valid` (4,9 s), `large_import173_valid` (4,4 s),
`ordinary187_valid` (4,3 s) i `warehouse_wz_issuer_guards` (2,3 s).

### 1.2 Pamięć: 16 GB `shared_buffers`, `dyna-scale-pg18` zatrzymany na czas biegu

Decyzja z TASKS.md (29.10 19:30): zostaje `shared_buffers=16GB` z manifestu, a na czas biegu bezczynny
`dyna-scale-pg18` jest zatrzymany.

| | przed (stan po `-04`) | na pomiar |
|---|---|---|
| `ALTER SYSTEM` | `shared_buffers='8GB'` | `RESET shared_buffers` → z `postgresql.scale.conf`: **16GB**; `maintenance_work_mem` 2GB, `autovacuum_work_mem` -1 (plik) |
| limity kontenera | 18 CPU, 12 GiB | **18 CPU, 20 GiB** (`--memory-swap 20g`) |
| reszta | bez zmian względem manifestu: `effective_cache_size 64GB`, `work_mem 32MB`, `max_wal_size 16GB`, `jit off`, `archive_mode on`, `fsync`/`synchronous_commit on` | |

Przebieg:

- `dyna-scale-pg18`: przed zatrzymaniem tylko moje połączenie kontrolne. `docker stop -t 120` o 19:30:22 UTC,
  czysty `shutdown immediate` z checkpointem, kod wyjścia 0.
- Potem `RESET` na `dyna-scale-full-pg18`, `docker update`, restart (healthy).
- Pamięć VM Dockera w biegu (`extra/vm-mem.log`, 138 próbek):
  - `MemAvailable` min **11,3 GiB**;
  - `Shmem` max 6,4 GiB, czyli bufor zapełnił się do ~6,4 z 16 GB;
  - `SwapFree` 6–15 MiB przez cały bieg. Swap VM (1 GiB) był zajęty już przed biegiem i nie rósł.
- Bez zamrożenia VM i bez OOM.

## 2. Host

| | przed (19:34 UTC) | w biegu | po (20:43 UTC) |
|---|---|---|---|
| load avg | 5,71 / 6,58 / 7,42 | mediana 1-min 14,2; max 1-min: rozgrzewka 14,4, steady12 **36,5**, steady24 26,5 | 8,30 / 12,39 / 13,86 |
| zasilanie | AC, 35 %, ładowanie | AC | AC, 37 %, ładowanie |
| pokrywa / sen | otwarta (`AppleClamshellState = No`), `sleep 0`, `caffeinate -is` | `pmset -g log` 20:30–21:45 czasu lokalnego: tylko asercje, brak `Sleep`/`Wake`/`Using Batt` | otwarta |

Sterownik nie odmówił startu: zasilanie AC, `run.json` `host.power: "ac"`, `allow_battery: false`.

Inne obciążenie hosta (`extra/host-ps.log`, średnie z próbek):

- proces `tsx` innego agenta (`local-app`, ~99 % przez 4 h);
- testy na PG04: `dynaminds_m260_20261029_10/11` i `dynaminds_wireret_20261023_80`, po ~1 rdzeniu w 64–96 ze 138 próbek;
- WindowServer ~20 %.

Skoki load do 25–35 (19:44–19:48 UTC, początek steady12) zbiegają się z kubełkiem 52,57 RPS (3. minuta). Na
progi nie wpływają.

Jedna przerwa `process_stall` (114 s, 19:34:30–19:36:24) wypadła w kroku setup. To synchroniczny `spawnSync`
fabryki, ten sam fałszywy alarm co w `-02`. Żadna faza nie nakłada się na nią: wszystkie fazy mają `valid: true`.

## 3. Wyniki per faza

| | warmup (60 s, 12 kl.) | steady12 (1800 s) | steady24 (1800 s) | próg |
|---|---|---|---|---|
| RPS sukcesu | 64,55 | **63,61** | **78,17** | 10 / 20 |
| najsłabszy 60-s kubełek | 64,40 | 52,57 | 68,15 | ≥ 5 / ≥ 10 |
| żądania / sukcesy | 3 873 / 3 873 | 114 506 / 114 504 | 140 715 / 140 712 | — |
| błędy (nieoczekiwane) | 0 | **0** (0 × 429, 0 × 5xx, 0 timeoutów) | **0** (0 × 429, 0 × 5xx, 0 timeoutów) | 0 |
| statusy | 200: 3 067, 201: 806 | 200: 90 494, 201: 24 010, 409: 2 | 200: 111 279, 201: 29 433, 409: 3 | — |
| oczekiwane odmowy (oznaczone 409) | 0 | 2 × `return_stock_version` (0,002 %), brak skutku potwierdzony 2/2 | 3 × `return_stock_version` (0,002 %), brak skutku 3/3 | ≤ 1 % |
| odmowy przygotowania (niemierzone) | 0 | 1 × 409 „Stan lub rezerwacja zmieniły wersję” (podgląd korekty) | 2 × to samo (podgląd ruchu WMS, podgląd korekty) | — |
| pominięte z braku stanu | 0 | 0 | 0 | 0 |
| udział firm | 19,2–20,4 % | 19,2–20,4 % | 19,2–20,4 % | 20 ± 2 pp |
| udział zapisów wysłanych | 38,4 % (odchylenie 2,1 pp; tylko 1 kubełek) | 38,3 % (kubełki 38,2–38,5), max odchylenie 2,0 pp: w tolerancji | 38,3 % (38,1–38,5), 2,0 pp: w tolerancji | 40 % ± 2 pp (≈ 38,8 % z `not_bindable` B/D) |
| odczyty p95 / p99 ms | 46 / 60 | **46 / 52** | **112 / 138** | 500 / 1000 |
| zapisy p95 / p99 ms | 315 / 597 | **353 / 538** | **462 / 692** | 4000 / 8000 |
| najgorsza para operacja × firma p95 / p99 | — | odczyt `catalog_search` D 50 / 57; zapis `order_create` C 516 / 728 | odczyt `catalog_search` D 125 / 152; zapis `order_create` C 668 / 1 030 | 500/1000; 4000/8000 |
| najstarsze oczekujące zadanie p95 / max | 1,33 / 3,24 s | **1,22 / 3,50 s** | **1,58 / 2,45 s** | 15 / 60 s |
| opóźnienie reguły p50 / p95 / p99 | 0,53 / 1,33 / 1,83 s | 0,49 / 1,28 / 1,55 s | 0,69 / 1,50 / 1,90 s | — |
| zadania workerów | 799 | 23 423 | 28 816 | — |
| aktywne backendy średnio | 6,38 | 6,30 | 8,07 | — |
| CPU `dyna-scale-full-pg18` średnio / max | 640 / 760 % | 620 / 840 % | 781 / 887 % | — |
| CPU `dyna-load-app` średnio / max | 91 / 94 % | 88 / 129 % | **96 / 131 %** | — |
| CPU `dyna-load-worker-2` średnio / max | 17 / 24 % | 23 / 74 % | 31 / 73 % | — |
| RSS max: baza / aplikacja / worker | 2,86 / 2,00 / 1,69 GiB | 4,99 / 3,04 / 1,78 GiB | 6,01 / 3,04 / 1,81 GiB | razem ≤ 12 GiB |
| pętla zdarzeń klientów p99 / max | 16,3 / 74,8 ms | 14,0 / 163,2 ms | 12,3 / 66,3 ms | — |
| stan MAIN na firmę: zużycie / zapas | 1 408–1 570 szt./min | 1 394–1 454 szt./min, zapas 214–226 min | 1 673–1 714 szt./min, zapas 152–157 min, ≥ 8 szt.: 11 770–11 981 SKU | 0 pominiętych |

Per operacja, sukcesy, p95 / p99 ms:

| operacja | steady12 | steady24 |
|---|---|---|
| `order_list` | 11 / 14 | 89 / 113 |
| `catalog_search` | 50 / 56 | 124 / 150 |
| `order_detail` | 29 / 37 | 107 / 131 |
| `order_create` | 424 / 641 | 564 / 840 |
| `reserve_and_status` | 65 / 78 | 141 / 165 |
| `payment_or_document` (połowa faktur ścieżką 230) | 247 / 281 | 466 / 521 |
| `stock_operation` (A/C/E) | 127 / 148 | 201 / 224 |
| `return_receive` | 385 / 442 | 469 / 513 |

Każda operacja i każda para operacja × firma mieści się w progach (`within_threshold`, `tenants_within_threshold`: true).

Najczęstsze oczekiwania backendów:

| oczekiwanie | steady12 | steady24 |
|---|---|---|
| CPU | 19 892 | 24 969 |
| `Lock:transactionid` | 1 258 | 2 491 |
| `Client:ClientRead` | 802 | 1 026 |
| `Lock:advisory` | 388 | 169 |
| `Lock:tuple` | — | 139 |

Przyrost RPS z 12 do 24 klientów to tylko +23 % (63,6 → 78,2). W tym czasie:

- proces aplikacji (jeden proces Node) zajmuje średnio 96 % rdzenia;
- baza zajmuje 7,8 z 18 rdzeni;
- odczyty rosną z ~17 do ~67 ms p50.

Wygląda to na sufit jednego procesu HTTP, a nie bazy. **Niepotwierdzone:** procesu Node nie profilowałem. Gdzie szukałem:
`docker stats` w `run.json` → `monitor.containers` oraz próbki oczekiwań. Przy obu liczbach klientów CPU dominuje
w próbkach backendów, a baza ma wolne rdzenie.

Wzrost bazy w biegu: 7 198 537 407 → 9 004 136 127 B, czyli +1,81 GB (`extra/diag/fast.ndjson`, próg 10 GiB).
`deadlocks` 0, `temp_files` 8.

## 4. PASS/FAIL per kryterium (`FULL-BASE-GOAL.md` warunek 10, `acceptance-profile.v1.json`)

### 4.1 Mierzone przez sterownik

| Kryterium | steady12 | steady24 |
|---|---|---|
| RPS sukcesu ≥ 10 / ≥ 20 przez całą fazę | **PASS** (63,61) | **PASS** (78,17) |
| żaden pełny 60-s kubełek < ½ minimum | **PASS** (min 52,57 ≥ 5) | **PASS** (min 68,15 ≥ 10) |
| odczyty p95 ≤ 500, p99 ≤ 1000 ms (każda operacja i firma) | **PASS** (46 / 52; najgorzej 50 / 57) | **PASS** (112 / 138; najgorzej 125 / 152) |
| zapisy p95 ≤ 4000, p99 ≤ 8000 ms (każda operacja i firma) | **PASS** (353 / 538; najgorzej 516 / 728) | **PASS** (462 / 692; najgorzej 668 / 1 030) |
| zero nieoczekiwanych błędów, 5xx, timeoutów; nieplanowane 401/403/404/409/422/429 = błąd | **PASS** (0) | **PASS** (0) |
| oczekiwane odmowy ≤ 1 %, 409 z dokładnym powodem, bez skutku, bez ponawiania | **PASS** (2; 0,002 %; 2/2 bez skutku) | **PASS** (3; 0,002 %; 3/3 bez skutku) |
| mieszanka ± 2 pp | **PASS** (2,0 pp) | **PASS** (2,0 pp) |
| udział firm 20 ± 2 pp | **PASS** (19,2–20,4) | **PASS** (19,2–20,4) |
| 0 poleceń pominiętych z braku stanu | **PASS** | **PASS** |
| najstarsze oczekujące zadanie p95 ≤ 15 s, max ≤ 60 s | **PASS** (1,22 / 3,50 s) | **PASS** (1,58 / 2,45 s) |
| aktywne workery (≥ 2 procesy) przez całą fazę | **PASS** (`dyna-load-app` + `dyna-load-worker-2`, 23 423 zadania) | **PASS** (28 816 zadań) |
| drenaż ≤ 120 s | — | **PASS** (2,0 s, `drained: true`) |
| zimny start ≤ 180 s | **PASS** (113,8 / 114,4 s; jedna próba na proces) | — |
| ostrzeżenia odpowiedzi / późne błędy hooków (§5) | **PASS** (0) | **PASS** (0) |
| sen hosta / przerwa w fazie | brak (`valid: true`) | brak (`valid: true`) |

### 4.2 Zasoby (częściowo, `docker stats` co ~15 s i próbki hosta co 30 s)

| Kryterium profilu | Wynik |
|---|---|
| RSS aplikacja + baza + workery ≤ 12 GiB | **PASS**: max 6,01 + 3,04 + 1,81 = 10,86 GiB (suma maksimów z różnych chwil, więc z zapasem) |
| przyrost swapu ≤ 256 MiB | **PASS** dla VM: `SwapFree` 6–15 MiB przez cały bieg, bez przyrostu. Swapu macOS nie zapisałem przed biegiem |
| wolne miejsce ≥ 30 GiB | **PASS** (1,7 TB w VM, 2,7 TiB na hoście) |
| wzrost bazy w biegu ≤ 10 GiB | **PASS** (+1,81 GB) |
| CPU hosta średnio na 60 s ≤ 85 %, pętla zdarzeń serwera p99 ≤ 100 ms, czekanie na pulę p95/p99, in-flight serwera | **niezmierzone** (manifest §12 „Otwarte” 3). Pętla zdarzeń klientów p99 ≤ 16 ms. `ordinary_requests.active_requests` z `/api/health`: 22 przy 24 klientach (20:21 UTC); `refused_admissions` 0 |

### 4.3 Odstępstwa i obszary poza sterownikiem (bez zmian względem `-01`/`-02`)

- **Rozgrzewka 60 s zamiast 600 s**, zgodnie z poleceniem biegu, jak w `-02`. Profil wymaga 600 s.
- **Zimny start: jedna próba na proces.** Profil wymaga trzech kolejnych.
- **Tło profilu: tylko automatyzacje.** Każda firma ma regułę `order.created → add_note`, z workerem w obu procesach.
  Brak importu zamówień z lokalnego WooCommerce (6/min) i synchronizacji stanów (12/min). `importer_available: false`
  w logu startu. Manifest §12 „Otwarte” 2.
- **`stock_operation` B/D** jest `not_bindable` (2 281 / 2 853 zadań). Celowanego wyścigu o gorące SKU nie ma.
- **Brak uzgodnienia poprawności po biegu**: księga zapisów, sprzedaż ponad stan, duplikaty. To część profilu
  `correctness`, poza sterownikiem.

## 5. Ostrzeżenia odpowiedzi i późne błędy hooków

Źródło 1: `/api/health` obu procesów, próbkowane co 60 s z przestrzeni sieciowej instancji (kontener pomocniczy,
tylko odczyt). Wyniki z sesji: `reply_warnings` = `{FST_ERR_REP_ALREADY_SENT: 0, ERR_HTTP_HEADERS_SENT: 0,
FST_REPLY_SENT_PROMISE_ERROR: 0, ORDINARY_LATE_HOOK_FAILURE: 0}` oraz `late_hook_failures` 0, `refused_admissions` 0.

| czas UTC | faza | 4101 (`dyna-load-app`) | 4102 (`dyna-load-worker-2`) | `active_requests` 4101 |
|---|---|---|---|---|
| 19:39:37 | setup | 0 / 0 | jeszcze nie słuchał | 1 |
| 19:50:37 | steady12 | 0 / 0 | 0 / 0 | 8 |
| 20:10:38 | koniec steady12 | 0 / 0 | 0 / 0 | 5 |
| 20:21:38 | steady24, 10. minuta | 0 / 0 | 0 / 0 | 22 |

Plik próbek nie przetrwał końca biegu. `run.mjs` w `finally` usuwa wszystkie kontenery `dyna-load-*`, więc usunął
też mój kontener pomocniczy (`dyna-load-health05`). Pętla zapisu nadpisała wtedy `extra/health.ndjson` komunikatem
„No such container”. To mój błąd w próbkowaniu, nie produktu. Tabela wyżej to odczyty z tej sesji. Po 20:21:38
próbek z `/api/health` nie ma.

Źródło 2, pokrywające cały bieg: stderr obu procesów (`raw/dyna-load-app.log`, `raw/dyna-load-worker-2.log`, po 114 B).

- `createReplyWarningLog` (`server/reply-warning-log.ts`) zapisuje każde zliczone ostrzeżenie jako linię
  `ORDINARY_HTTP_REPLY_WARNING` na stderr. Wyjątek: trasy z `logLevel: 'silent'`, a są nimi tylko trasy Mirakl 262,
  których profil nie używa.
- CLI loguje każde późne odrzucenie jako `ORDINARY_LOCAL_UNHANDLED_REJECTION` (`server/ordinary-local-cli.ts:60-61`).
- `run.mjs` zapisuje stdout i stderr obu procesów do tych plików.
- Oba logi zawierają tylko linię `ORDINARY_LOCAL_APP_LISTENING`: **0 ostrzeżeń, 0 późnych odrzuceń** od startu do
  zatrzymania (20:41:49).

Wniosek: `reply_warnings` = 0 i `late_hook_failures` = 0 przez cały bieg. Oba procesy działały do końca: 0 błędów
połączenia, drenaż 2 s. Żeby kolejne biegi nie zależały od kontenera pomocniczego, sterownik czyta teraz
`/api/health` po drenażu sam (§7).

## 6. Koszty CPU bazy: najdroższe funkcje (`pg_stat_user_functions`, self time; okno 1 626 s na fazę)

| funkcja | `-02` steady12 (61,97 RPS) | **`-05` steady12 (63,61 RPS)** | **`-05` steady24 (78,17 RPS)** |
|---|---|---|---|
| suma self time funkcji | 4,16 rdzenia | 4,19 r. | **5,57 r.** |
| `warehouse_inventory_policy_guards` | 1,28 r., 1,09 ms × 1 176/s | 1,31 r., 1,11 ms × 1 183/s | **1,69 r.**, 1,16 ms × 1 463/s |
| `enforce_workspace_quota` | 0,36 r., 6,75 ms | 0,36 r., 6,63 ms × 54/s | **0,72 r., 10,72 ms** × 67/s |
| `guard_verdict_basis` | 0,46 r., 4,3 ms | 0,48 r., 4,42 ms × 108/s | 0,58 r., 4,58 ms × 126/s |
| `order_merge_delivery209_validation_snapshot` | 0,46 r., 19,8 ms | 0,45 r., 19,15 ms × 24/s | 0,57 r., 19,60 ms × 29/s |
| `order_merge_delivery209_predecessor_source_sha` | 0,22 r., 0,47 ms | 0,21 r., 0,45 ms × 480/s | 0,27 r., 0,46 ms × 594/s |
| `order_merge_delivery209_predecessor_descriptor` | 0,15 r., 3,0 ms | 0,15 r., 2,86 ms | 0,18 r., 2,92 ms |
| `manual_inventory_off_valid` (total) | 0,13 r., 277 ms | 0,13 r., 262 ms × 3/s | 0,16 r., 268 ms × 4/s |
| `verdict241_ddl_intact` | 0,12 r., 0,87 ms | 0,12 r., 0,88 ms | 0,15 r., 0,89 ms |
| `manual_inventory_off_projection_valid` (total) | 0,11 r., 49 ms | 0,10 r., 46 ms | 0,13 r., 47 ms |
| `buyer_available236_basis` | 0,09 r., 3,3 ms | 0,09 r., 3,23 ms | 0,12 r., 3,32 ms |
| `b2b_credit_fingerprint` (total) | 0,08 r., 77 ms | 0,07 r., 73 ms | 0,09 r., 74 ms |

Najczęstsze aktywne zapytania (próbki `pg_stat_activity` co 0,5 s):

| zapytanie | steady12 | steady24 |
|---|---|---|
| `guard_verdict('catalog_stock_control_guards')` | **21,1 %** | **19,7 %** |
| `local_invoice_guards()` | 7,6 % | 7,7 % |
| `INSERT INTO orders` | 6,4 % | 9,6 % |
| `warehouse_policy_map` / `warehouse_inventory_policy_lock` | 5,9 % / 5,4 % | 5,6 % / 5,3 % |
| `warehouse_inventory_policy_guards()` | 3,1 % | 3,0 % |

Wnioski:

- Profil kosztów przy 12 klientach jest taki sam jak w `-02`, w granicach ±3 %.
- Przy 24 klientach koszt na wywołanie się nie zmienia. Wyjątek to `enforce_workspace_quota`: 6,6 → 10,7 ms na
  wywołanie (+62 %), łącznie 0,72 rdzenia.
- Rośnie też udział `INSERT INTO orders` (6,4 → 9,6 %) i `Lock:transactionid` (1 258 → 2 491).
- To kandydaci na rywalizację przy tworzeniu zamówień, czyli wiersz limitu firmy albo numeracja. **Niepotwierdzone**,
  nie badałem planu ani blokad tych funkcji. Progi nie są zagrożone (`order_create` p95 564 ms przy progu 4 000).

## 7. Narzędzia zmienione w tej sesji

Commit `e7272b1` `fix(scale-load)`:

- Sterownik nie zapisywał stanu `/api/health` na końcu biegu. Odczyt `rate_limit` był tylko po starcie, więc
  `reply_warnings` i `late_hook_failures` trzeba było zbierać z zewnątrz, a próba z kontenerem pomocniczym przegrała
  ze sprzątaniem `run.mjs` (§5).
- Teraz `run.mjs` w `finally`, przed `stopAll()`, czyta `/api/health` każdego procesu wydania (`healthOf`, ten sam
  odczyt co `rate_limit`). Zapis trafia do `run.json` `reply_health` przez `replyHealthRecord` (`lib.mjs`).
  Nagłówek `SUMMARY.md` pokazuje sumy per proces.
- Oznaczenie NOT CLEAN dostaje każda niezerowa liczba, proces nieosiągalny (np. po awarii) i wydanie bez pól.
- Test w `tests/scale-load.test.mjs`: przed zmianą czerwony (brak eksportu `replyHealthRecord`), po zmianie 31/31.
  README uzupełnione.
- **Niepotwierdzone w biegu:** nowa ścieżka `run.mjs` nie przeszła jeszcze pełnego biegu. Ten bieg używał
  sterownika z `b92d6b5`.

## 8. Porównanie z biegiem `-02` (wydanie `db02405`, ten sam zbiór i ustawienia pomiaru)

| | `-02` steady12 | **`-05` steady12** | `-02` steady24 | **`-05` steady24** |
|---|---|---|---|---|
| RPS sukcesu | 61,97 | **63,61** (+2,6 %) | 0,59 (aplikacja padła po 15 s) | **78,17** |
| najsłabszy kubełek | 48,45 | 52,57 | 0 | 68,15 |
| błędy | 0 | 0 | 58 138 (`ECONNREFUSED`/`ECONNRESET`) | **0** |
| oczekiwane odmowy | 0 | 2 | — | 3 |
| odczyty p95 / p99 | 50 / 60 | 46 / 52 | — | 112 / 138 |
| zapisy p95 / p99 | 359 / 562 | 353 / 538 | — | 462 / 692 |
| najstarsze zadanie p95 / max | 1,25 / 3,25 s | 1,22 / 3,50 s | — | 1,58 / 2,45 s |
| CPU aplikacji średnio | 85 % | 88 % | — | 96 % |
| CPU bazy średnio | 630 % | 620 % | — | 781 % |
| zimny start aplikacja / worker | 116,1 / 105,3 s | 113,8 / 114,4 s | | |
| migracja 248 → 252 | 1,4 s, 15/15 | 1,8 s, 15/15 | | |
| `shared_buffers` / limit kontenera | 16 GB / 20 GiB, `dyna-scale-pg18` działał (10,7 GiB) | 16 GB / 20 GiB, `dyna-scale-pg18` **zatrzymany** | | |
| host load max 1-min | 33,6 | 36,5 | — | 26,5 |

Steady12 w obu biegach jest równoważny: różnice mieszczą się w zmienności hosta. Steady24 jest zmierzony pierwszy raz
na pełnym zbiorze. Poprzednio, na zbiorze `_71` z 8 000 SKU na firmę (`-01`), dał 65,9 RPS z 429 i błędami
przygotowania, co nie jest porównywalne.

## 9. Stan po sesji

- `dynaminds_scale_20261029_07` zostaje do analizy: ledger 252, 9,0 GB, zamówienia biegu z obu faz.
- `_04`, `_05`, `_06` zostają bez zmian (opis w `-B` §7).
- `_03` i `_q597` nietknięte, czytane tylko jako `TEMPLATE`.
- `dyna-scale-full-pg18`:
  - ustawienia pomiaru zostają: `shared_buffers` 16GB z pliku, bez `ALTER SYSTEM`; limity 18 CPU / 20 GiB;
  - po biegu zrestartowany, bezczynny, żeby oddać ~6,4 GiB zajętej pamięci współdzielonej VM (healthy, 386 MiB);
  - powrót do ustawień generowania jak w `-B` §7.
- `dyna-scale-pg18` uruchomiony ponownie o 20:46:43 UTC:
  - czysty start: „database system was shut down at 2026-10-29 19:30:22 UTC”, bez odtwarzania;
  - healthy, `RestartCount 0`;
  - rozmiary baz `_20261027_41`, `_20261028_61`, `_71`, `_81`, `_20261029_81`, `_82` identyczne przed i po
    (`extra/pg18-dbs-*.txt`);
  - LSN 7/87000110 → 7/880000A0 przez checkpoint zamknięcia i start, bez zapisów do baz.
- Kontenery `dyna-load-*` usunięte przez `run.mjs`, `dyna-scale-full-mig` przez `--rm`.
- `private/` biegu usunięte. W `run.json`, `SUMMARY.md`, `raw/` i `extra/` nie ma adresów bazy, haseł ani kluczy
  (sprawdzone `grep` na `postgres://`, `dbPassword`, `encryptionKey`).
- Main (4100), bazy PG04, `dyna-recovery-full-t1`, `data/recovery/full-20261029` i worktree
  `development/full-base-w1-login` nietknięte.
