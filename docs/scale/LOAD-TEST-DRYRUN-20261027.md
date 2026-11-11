# Test obciążenia — bieg próbny 27.10.2026 (5 min × 12 i 5 min × 24 klientów)

**Status: BIEG PRÓBNY sterownika na zbiorze 1 %, nie pomiar etapu 5.** Cel: sprawdzić sterownik
`tools/scale/load/` (opis i użycie: `tools/scale/load/README.md`) na spakowanym wydaniu z aktywnymi workerami,
zebrać pierwsze liczby i wąskie gardła. Profil i progi: `docs/scale/MEASUREMENT-MANIFEST-20261025.md` sekcje 5–6.
Poprawki produktu nie wchodzą w to zadanie; wąskie gardła poniżej są opisane z dowodami.

## 1. Wydanie, dane, topologia

| Pole | Wartość |
|---|---|
| wydanie | commit `f9b381115a1548fceadf2403473e5d0a1c4fdeee`, `release.json` `530a2243aa178bfd8961964bff7fcde9062b4b7b761a3054d8fca0c6d1fff929`, drzewo pakietu `3dfdfcede9f21379a2efe7a6edd8a00e79971b579eb283f00ed148cf8cc40ff8`, ostatnia migracja `243_ksef_purchase`; katalog `local-builds/full-base-preview-20261017/scale-release-load-20261027-01` |
| dane | `dynaminds_scale_20261027_41` na `dyna-scale-pg18`: `--tenants 5 --scale-factor 0.01` (5 firm × 200 SKU, 5 × 200 zamówień, 180 dni symulowanych), plan `d3fe708c03f9a3eabbf637ea519625d97a9141be42b6c8c4202bdd3b71cd179c`, seed `dyna-scale-20261025`, generator w wydaniu (`--release --simulate-days --connections 5 --tx-mode batch --order-batch 25`); strażnicy 10/10 `true` przed i po; potem `VACUUM (ANALYZE)` |
| kopia na bieg | `CREATE DATABASE dynaminds_scale_20261027_4N TEMPLATE …_41` (bieg 1: `_43`, bieg 2: `_44`; po biegu usunięte) |
| aplikacja | `dyna-load-app`: CLI wydania `127.0.0.1:4101 --scoped-automation` |
| workery | 2 procesy: worker w `dyna-load-app` i `dyna-load-worker-2` (drugie CLI, `4102`, `--scoped-automation`, bez ruchu klientów); na firmę 1 reguła `order.created → add_note` z włączonym lokalnym workerem (każde zamówienie = zadanie `automation` + `automation.run`) |
| klienci | osobny kontener na klienta w przestrzeni sieciowej `dyna-scale-pg18`, adres źródłowy `127.0.0.(11+N)` (osobny kubełek limitu 600/min na adres) |
| przebieg | 3 fabryki po kolei (setup, app, worker-2) → rozgrzewka 60 s × 12 → **steady12** 300 s → **steady24** 300 s → drenaż ≤120 s |
| host | M5 Max 18 rdzeni, 128 GiB; Docker VM 18 vCPU / 32 GiB; obciążenie od innych agentów: load 1 min 9–41 w czasie biegów |

```sh
node tools/scale/release-build.mjs --out "<local-builds>/full-base-preview-20261017/scale-release-load-20261027-01" \
  --base-contract "<local-builds>/full-base-preview-20261017/base-wire-n29-20261023-01/source-contract" \
  --base-contract-sha 548e34291ded9998cef9c7db7392e7ff4a5f377ed833c332e51f0209cd90cc06
tools/scale/docker/scale-pg.sh clone dynaminds_scale_20261027_41
# generator w przestrzeni sieciowej bazy (jak scale-pg.sh netns-node; montowany cały katalog „DYNA Ecomerce”, bo wydanie leży w local-builds)
docker run --rm --init --name dyna-scale-gen --network container:dyna-scale-pg18 --user "$(id -u):$(id -g)" -v "$W:$W" -w "$REPO" --env-file <0600 env> \
  node:22.23.0-trixie-slim@sha256:cfd8f2a5… node tools/scale/generate.mjs --tenants 5 --scale-factor 0.01 --simulate-days --connections 5 \
  --tx-mode batch --order-batch 25 --release <release-build.json> --checkpoint data/scale/runs/load41.checkpoint.json --report data/scale/runs/load41.report.json
tools/scale/docker/scale-pg.sh psql postgres -c "CREATE DATABASE dynaminds_scale_20261027_44 TEMPLATE dynaminds_scale_20261027_41"
SCALE_PG_STATE=<full-base>/data/scale/pg18-docker node tools/scale/load/run.mjs --release <release-build.json> \
  --db dynaminds_scale_20261027_44 --tag 5076fb8f --out data/scale/load/dryrun-20261027-02 \
  --phases steady12:12:300,steady24:24:300 --warmup 60 --workers 2
```

Raporty (poza gitem): `data/scale/load/dryrun-20261027-01/` (bieg 1, przed poprawkami sterownika z 25684d7) i
`data/scale/load/dryrun-20261027-02/` (bieg 2) — `run.json`, `SUMMARY.md`, `raw/` (próbki, wywołania przygotowania,
monitor, logi kontenerów). Bieg roboczy z fazami 2–24 klientów × 40–90 s: `data/scale/load/dev01/`.

## 2. Wyniki (bieg 2, `dryrun-20261027-02`)

Każde żądanie mierzone przechodzi przez powiązania `scripts/full-base-scale-http-ports.mjs` (`prepare` buduje
żądanie, `complete` sprawdza DTO z dokładnymi oczekiwaniami); sukces = 2xx i zgodne DTO.

| Faza | Żądania | Sukces | RPS sukcesu (próg) | 60-s kubełki | 5xx | timeouty | 409 | 429 | nie wysłane |
|---|---|---|---|---|---|---|---|---|---|
| steady12 | 1892 | 1878 | **6,26** (≥10) | 6,75 · 6,53 · 6,17 · 5,83 · 5,88 | 6 | 6 | 2 | 0 | 37 bez powiązania, 5 przygotowanie odrzucone |
| steady24 | 1879 | 1871 | **6,24** (≥20) | 6,57 · 4,73 · 6,60 · 6,13 · 6,87 | 6 | 2 | 0 | 0 | 35 bez powiązania, 18 przygotowanie odrzucone |

Udział firm 19,2–20,7 % (próg 20 ± 2 pp). Bieg 1: steady12 5,20 RPS, steady24 6,15 RPS.

Opóźnienia sukcesów (ms, górne granice kubełków; próg odczyt 500/1000, zapis 4000/8000):

| Operacja | steady12 n · p50 · p95 · p99 | steady24 n · p50 · p95 · p99 | próg spełniony |
|---|---|---|---|
| `order_list` | 483 · 8 · 15 · 72 | 490 · 11 · 425 · **1810** | 12: tak, 24: nie |
| `catalog_search` | 398 · 15 · 27 · 54 | 396 · 20 · **1050** · **2300** | 12: tak, 24: nie |
| `order_detail` | 287 · 179 · 242 · 271 | 281 · 194 · **744** · **1110** | 12: tak, 24: nie |
| `order_create` | 288 · 170 · 2850 · 5280 | 286 · 262 · 3190 · 5810 | nie (firmy A/C/E p95 3850–5020) |
| `reserve_and_status` | 184 · 68 · 3490 · 6860 | 189 · 103 · 3860 · 7900 | nie (C p95 6820) |
| `payment_or_document` | 94 · 389 · **4190** · 7700 | 87 · 314 · 2920 · 6170 | 12: nie, 24: nie (firma) |
| `stock_operation` (A, C, E) | 54 · 1410 · 2750 · 7960 | 52 · 1480 · 2950 · **8200** | nie |
| `return_receive` | 90 · **5550** · **7180** · 7550 | 90 · **4930** · **8740** · **9850** | nie |
| wszystkie odczyty | 1168 · 14 · 206 · 244 | 1167 · 59 · 717 · 1880 | |
| wszystkie zapisy | 710 · 195 · 5990 · 7190 | 704 · 327 · 5420 · 8190 | |

Zapis per firma (p95 `order_create`, steady12 / steady24): A 4570 / 4320, B 453 / 597, C 4120 / 5020, D 401 / 658,
E 4010 / 3850 — firmy z partiami WMS (A, C, E) są ~10 × wolniejsze niż B i D.

Workery (zadania utworzone w biegu; opóźnienie efektu = `automation_runs.finished_at − orders.created_at`):

| Faza | kolejka max | najstarsze oczekujące p95 / max (próg 15 / 60 s) | opóźnienie efektu p50 / p95 / p99 |
|---|---|---|---|
| steady12 | 37 | 33,8 / 37,8 s | 11,9 / 32,3 / 36,9 s |
| steady24 | 74 | **62,1 / 67,3 s** | 35,1 / 59,5 / 68,5 s |
| drenaż po fazach | `pending` 0 po ~60 s, ale 1 zadanie `automation.run` zostało `running` (zablokowane od 21:04:20) → drenaż **niezaliczony** w 120 s | | |

Bieg 1 drenaż: 2 s, ale steady24 kolejka max 162, najstarsze 120,9 s.

Zasoby (`docker stats` co ~15 s, steady24): PostgreSQL CPU śr. 581 % / max 1004 % (≈6–10 rdzeni), RSS 4,2 GiB;
aplikacja CPU 29 % / max 60 %, RSS 1,8 GiB; worker-2 RSS 1,5 GiB. Baza, nie Node, jest nasycona.

Start: fabryka setup 245 s, `dyna-load-app` 225 s, `dyna-load-worker-2` 207 s (bieg 1: 229 / 220 / 216 s) — każda
powyżej 180 s zimnego startu z profilu (przy load 9–30 od innych agentów).

## 3. Błędy i ich przyczyny

| Błąd (bieg 2) | Liczba | Przyczyna | Dowód |
|---|---|---|---|
| 500 „Nieoczekiwany błąd serwera” (`order_create` C, `reserve_and_status` C/E, `return_receive` C) | 12 mierzonych + 13 w przygotowaniu | `statement_timeout` 8 s w oczekiwaniu na blokadę doradczą `wms.operations:<firma>` | log PG w oknie biegu: 45 × `canceling statement due to statement timeout`, wszystkie na `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`; 500 trwają ~8 s (np. `POST /api/orders` 8018 ms w `raw/*.prep.ndjson`) |
| `HTTP_TIMEOUT` (10 s sterownika) `return_receive` C/E | 8 | to samo oczekiwanie + ~5 s własnego kosztu odbioru zwrotu | p50 `return_receive` 4,9–5,6 s bez kolejki |
| 409 „Za mało towaru: SC-…” `order_create` A, C | 2 | skończony stan na zbiorze 1 % (stan mówi 0–1 szt.); sterownik czyta katalog co 10 utworzeń na klienta, 12–24 klientów zjada ten sam stan | próbki w `raw/steady12-*.samples.ndjson`; to nie jest oznaczony wyścig profilu, więc liczy się jako błąd |
| `automation.run` `failed` „Błąd wykonania automatyzacji” | 2 (bieg 1: 1) | nieznana — produkt zapisuje tylko ogólny komunikat (`jobs.error` puste, `automation_runs.error` ogólny) | `SELECT … FROM automation_runs WHERE state='failed'` |
| `automation.run` `running` bez końca | 1 | nieznana; zadanie z `lease_token`, `locked_at` 21:04:20, przebieg `queued` | jw.; blokuje zaliczenie drenażu |
| `stock_operation` B, D „nie do powiązania” | 72 (nie wysłane) | powiązania przyjmują tylko `wms_adjustment090` / `wms_transfer`; B i D nie mają partii WMS | `scripts/full-base-scale-http-ports.mjs` `validateCommand`/`complete` |
| przygotowanie: 409 „Stan lub rezerwacja zmieniły wersję” podglądu WMS | 1 | wyścig z innym klientem na tej samej warstwie (normalne zachowanie) | |

Brak 429 (limit 600/min na adres zadziałał osobno dla każdego klienta), brak duplikatów i przecieków między
firmami w odpowiedziach (powiązania sprawdzają `tenant_id`, świeże `reused:false` i tożsamość efektów).

## 4. Wąskie gardła produktu (bez poprawek w tym zadaniu)

1. **Blokada `wms.operations:<firma>` serializuje każdy zapis firmy z partiami.** `server/wms-lots-transaction.ts:69-71`
   (każda transakcja zapisu przy włączonej polityce) i `server/wms-lots.ts:1144` (`admit`) biorą wyłączną
   `pg_advisory_xact_lock(hashtextextended('wms.operations:'||tenant,0))` na całą transakcję. Monitor: 2561 / 2680
   oczekujących na tę jedną blokadę (suma próbek co 0,5 s, steady12 / steady24); `Lock:advisory` to ~45 % próbek
   aktywnych backendów (2571 z 5568, 2681 z 6117), reszta to głównie CPU. Próbki posiadaczy blokady w steady24 (`holders.sh`, 121 próbek): transakcja posiadacza ma średnio
   2,7 s, max 9,8 s, a w tym czasie wykonuje głównie strażników: `catalog_stock_control_guards()` 43,
   `catalog_stock_return_prepare` 17, `financial_return_capture` 16, `catalog_stock_control_effect_prepare` 11.
   Skutek: zapisy A/C/E p95 4–5 s wobec 0,4–0,7 s w B/D, 500 po 8 s, worker reguł czeka w tej samej kolejce.
2. **Strażnicy wykonywani wewnątrz transakcji zapisu.** Na bezczynnej bazie `catalog_stock_control_guards()` 414 ms,
   `financial_return_guards()` 368 ms, `fa3_draft_guards()` 417 ms, `local_invoice_guards()` 53 ms (`\timing`, baza
   `_44` po biegu). `catalog_stock_control_guards()` to 1213 / 917 próbek aktywnych zapytań (steady12 / steady24).
   Odbiór zwrotu łączy kilku strażników → p50 ~5 s bez obciążenia kolejką.
3. **Odczyt pieczęci instalacji przy każdej transakcji RW.** `shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs:363`
   (`prepareOrdinaryInstallation` → `readInstallationCut(owner,true,…)`, SQL z `installationSealSql`, linia 316–322):
   `WITH s0 AS MATERIALIZED (SELECT t.* FROM public.b2b_credit_upgrade t), …` z sha256 każdego wiersza 13–14 tabel
   manifestów (`INSTALLATION_SEALS`, linia 312), `FOR SHARE`. 651 / 1381 próbek (steady12 / steady24) — w steady24 najczęstsze aktywne zapytanie.
4. **Przepustowość nie rośnie z liczbą klientów.** 12 → 24 klientów: 6,26 → 6,24 RPS, CPU bazy 505 → 581 % średnio
   (max 1004 %), aplikacja 20–30 % jednego rdzenia. Odczyty w steady24 przekraczają progi (p99 1,1–2,3 s), bo dzielą CPU
   bazy z powyższymi.
5. **Workery nie nadążają pod obciążeniem.** Najstarsze oczekujące p95 34 s (steady12) i 62 s (steady24) przy
   progu 15 s; po zdjęciu ruchu kolejka znika w sekundy (bieg 1: 2 s), więc to współdzielenie blokady/CPU, nie
   wydajność samego workera (wcześniejszy pomiar drenażu: ~30 ms na zadanie).
6. **`order_detail` ~180 ms p50 już przy 12 klientach** (odczyt jednego zamówienia), wobec 8–15 ms list.
7. **Zimny start i równoległy start fabryk.** Każda fabryka 206–245 s (> 180 s). Trzy fabryki uruchomione naraz kończą
   się `ORDINARY_LOCAL_START_FAILED`; w logu PG 21–38 × `statement timeout` na `SELECT pg_advisory_lock_shared(982376)`
   (`profile-startup.mjs:446`, blokada schematu z `server/182_cold_schema_runtime_admission.sql`) w czasie startu drugiej
   fabryki. Raz (bieg roboczy `dev01`) setup trwał 2972 s: `parcel_physical_wz_valid()` 961,8 s i
   `wave_print177_valid()` 341,1 s w logu PG; ten sam `wave_print177_valid()` na bezczynnej bazie 3,9 s — przyczyny nie
   ustalono (host load 17–19 od innych agentów).

## 5. Błędy sterownika znalezione i poprawione w biegu

| Błąd | Poprawka |
|---|---|
| generator: `--connections` ≥ liczba firm → `timeout exceeded when trying to connect` (każdy tor trzyma transakcję partii, `authTx` nie ma połączenia) | pula = tory + 1 (`tools/scale/generate.mjs`, cd9bef2) |
| generator: przy `--simulate-days` wygasła sesja (8 h czasu bazy) dochodziła do kroku FV — 401 „Sesja lub klucz FV wygasły” w dniach 71 i 107; brak wiersza `sessions` z tego dnia | nowa sesja na każde zamówienie przy symulowanym zegarze (`tools/scale/writer.mjs`, cd9bef2); wznowienie z checkpointu bez duplikatów |
| fabryki startowane naraz nie wstają | setup → app → worker po kolei (`run.mjs`) |
| ścieżki importów klienta, nieobsłużone odrzucenie przy wyjściu usługi (zostawał kontener) | 5109f10 |
| pula `order_detail` zawierała zamówienia tworzone przez test (wersja zmieniana przez workera → DTO `'5' !== '4'`) | tylko zamówienia generatora (`note` `scale:…`) |
| użycie własnego zamówienia przed efektem reguły → 409 „Zamówienie zmieniło się” (wyścig z workerem) | zamówienie wraca do zapisu dopiero z notatką reguły; czekanie do 120 s (25684d7) |
| skan WMS 422 „Wybierz layer_id” (lokalizacje w szczególe zamówienia nie mają warstwy) | warstwy z `GET /api/wms-lots/orders/:id/allocations` (25684d7) |
| 409 braku towaru ze stanu sprzed wielu utworzeń | odczyt katalogu co 10 utworzeń, ilość ≤ ¼ dostępnego (25684d7; 2 przypadki zostały) |

## 6. Otwarte przed pełnym biegiem

1. Profil nie jest osiągalny na tym wydaniu: steady12 6,3 RPS (próg 10), steady24 6,2 RPS (próg 20), zapisy i
   kolejki ponad progi — decyzja produktowa o pkt 4.1–4.3 (zakres blokady `wms.operations`, strażnicy w transakcji,
   pieczęć instalacji na transakcję) przed 41-godzinnym generowaniem.
2. Brak w sterowniku: tło profilu (import zamówień z lokalnego WooCommerce 6/min, synchronizacja stanów 12/min,
   ≥ 2 instancje WooCommerce); automatyzacje idą z tempem tworzenia zamówień (~11–12/min na firmę), nie 5/min.
3. Brak w sterowniku: wyścig o gorące SKU (połowa `stock_operation` i oznaczone 409 profilu), warianty zwrotu
   sale/custody/reject i `return_destinations`, `stock_operation` B/D (powiązania nie mają wariantu bez WMS),
   uzgodnienie fizyczne i finansowe po biegu, pętla zdarzeń, czekanie na pulę, licznik in-flight serwera.
4. Przygotowanie poleceń jest niemierzone, ale zajmuje klienta (pętla zamknięta): przy kolejce workera 60 s
   klient czeka na efekt reguły, zanim zapłaci/zmieni status własnego zamówienia — to obniża oferowane obciążenie.
5. Zadanie `automation.run` zostające w `running` po 4 min i ogólny błąd „Błąd wykonania automatyzacji” bez przyczyny.
6. Zimny start > 180 s; jednorazowe 2972 s startu (pkt 4.7) bez ustalonej przyczyny.
7. Generator z `--simulate-days` przesuwa zegar przy zapytaniach w toku: log PG ma ~40 instrukcji z „czasem”
   ~86 390 s (doba) — bariera dnia nie jest pusta (np. `catalog_stock_control_guards()`), wymaga sprawdzenia w
   `tools/scale/generate.mjs`/`simclock.mjs`.

## 7. Po 248: B2 (werdykt strażników) i B3 (tożsamość pieczęci) — przed/po

Punkty 4.2 i 4.3 zmienia migracja `248_guard_verdicts` (B2, [GUARD-VERDICTS248](../parity/GUARD-VERDICTS248-20261027.md))
i zmiana TS w `profile-startup.mjs` (B3, [INSTALLATION-IDENTITY248](../parity/INSTALLATION-IDENTITY248-20261027.md)).
Commity sterownika z tej gałęzi (`cd9bef2`, `5109f10`, `25684d7`, `a223b9b` wyżej) są na `goal/full-base-20261017`
jako `92fafcb`, `74bd082`, `ac335df`, `89b43c2`.

Bieg „przed” to wydanie z `b976827` (`data/scale/load/p256-before-01`), bieg „po” to wydanie z gałęzi
`p256-loadtest-tmp` (`7fff30f`: obie zmiany na podstawie z 245 i rejestracja zastępcza 256 tylko na bieg,
`data/scale/load/p256-after-03`). Na wydaniu z 248 (po 246 i 247) biegu obciążeniowego nie powtórzono.

| | steady12 przed | steady12 po | steady24 przed | steady24 po |
|---|---|---|---|---|
| RPS sukcesu (próg 10 / 20) | 6,11 | 13,58 | 5,77 | 13,68 |
| odczyty p95 ms | 210 | 23 | 269 | 29 |
| zapisy p95 ms | 6 400 | 2 500 | 6 200 | 2 450 |
| `order_detail` p50 ms | 192 | 20 | 235 | 19 |
| operacje z progiem niespełnionym | 6 z 8 | 0 z 8 | 6 z 8 | 0 z 8 |
| najstarsze oczekujące zadanie p95 (próg 15 s) | 35,8 s | 14,0 s | 81,9 s | 33,0 s |

Próg 20 RPS dla 24 klientów nadal nie jest osiągnięty; dominuje blokada `wms.operations` (4.1) i strażnicy wewnątrz
zapieczętowanych funkcji (`catalog_stock_return_prepare`, `financial_return_capture`,
`catalog_stock_control_effect_prepare`), których 248 nie zmienia. Obciążenie hosta w biegu „przed” było wyższe
(szczegóły i zastrzeżenia w INSTALLATION-IDENTITY248, sekcja „Bieg obciążeniowy”).

## 8. HEAD z 248 i 250 razem (B1 + B2 + B3), 28.10

Wydanie z `1f353067676c6f0132dba8e138a59794f701721d` (`release.json` `e0ebc6e1b89aaa7814494a28caec22f53a6828ff60efc625c92cfde15971e718`,
drzewo pakietu `38a1549c550860965dd78ccd7cc25417b692f863a392cf0dc02794c75382af8d`, kontrakt źródłowy
`a1fc7745984b6695cee282877c2fab3e1d93c73c028f2bdcca8cd0296acd049b` na N29, wersja `1.0.0-full-base-scale-1f353067676c.250`,
ostatnia migracja `250_wms_evidence_settle_unlocked`; katalog `local-builds/full-base-preview-20261017/scale-release-head-20261028-01`,
`--commit` podany jawnie, bo w czasie budowy HEAD gałęzi przesunął się na `a286d2b` z niezarejestrowanym 258). Kopia
`dynaminds_scale_20261028_51` z `_41` (ledger 243), `track_functions=all` na kopii; wydanie przy starcie stosuje 244–250
(7 wierszy ledgera, `applied_at` 03:31:51 UTC). Ten sam sterownik i profil: `--warmup 60 --phases steady12:12:300,steady24:24:300
--workers 2`, raport `data/scale/load/l250-head-01/`. Obciążenie hosta (1 min) w fazach 14,8–36,1, mediana 19,2.

| | baseline `dryrun-20261027-02` | B2/B3 `p256-after-03` | B1 (TS) `p257-after-04` | **B1+B2+B3 `l250-head-01`** |
|---|---|---|---|---|
| RPS sukcesu steady12 / steady24 (próg 10 / 20) | 6,26 / 6,24 | 13,58 / 13,68 | 12,93 / 14,02 | **27,75 / 31,98** ¹ |
| 60-s kubełki steady12 | 6,8 · 6,5 · 6,2 · 5,8 · 5,9 | 15,0 · 13,4 · 13,3 · 13,1 · 12,9 | 16,2 · 13,8 · 12,1 · 10,8 · 11,9 | 34,1 · 29,8 · 27,6 · 23,9 · 23,2 |
| odczyty p95 / p99 ms steady12 | 206 / 244 | 23 / 28 | 256 / 280 | 24 / 33 |
| odczyty p95 / p99 ms steady24 | 717 / 1 880 | 29 / 93 | 886 / 1 320 | **633 / 1 020** |
| zapisy p95 / p99 ms steady12 | 5 990 / 7 190 | 2 500 / 2 880 | 6 190 / 8 700 | 2 180 / 2 330 |
| zapisy p95 / p99 ms steady24 | 5 420 / 8 190 | 2 450 / 3 150 | 6 400 / 7 970 | 2 970 / 3 480 ¹ |
| operacje z progiem niespełnionym steady12 | 5 z 8 | 0 | 1 (`return_receive`) | **0** |
| operacje z progiem niespełnionym steady24 | 8 z 8 | 0 | 6 | **3** (`order_list`, `catalog_search`, `order_detail`) |
| błędy steady12 / steady24 | 14 / 8 | 1 / 67 | 27 / 141 | 47 / 93 (bez 5xx i timeoutów) |
| najstarsze oczekujące p95 steady12 / steady24 (próg 15 s) | 33,8 / 62,1 s | 14,0 / 33,0 s | 1,0 / 2,7 s | **1,0 / 5,8 s** |
| opóźnienie efektu reguły p95 steady12 / steady24 | 32,3 / 59,5 s | 14,7 / 33,0 s | 1,4 / 2,4 s | 1,2 / 6,9 s |
| `Lock:advisory` próbki steady12 / steady24 | 2 571 / 2 681 | 2 231 / 2 379 | 54 / 29 | 46 / 3 |
| CPU bazy średnio steady12 / steady24 | 505 / 581 % | 478 / 450 % | 1 068 / 1 091 % | 996 / 1 103 % (max 1 179 %) |
| 40P01 / `statement_timeout` w fazach (log PG) | 0 / 45 | 0 / 0 | 14 / — | **0 / 0** |
| start setup / app / worker-2 (próg 180 s) | 249 / 225 / 207 s | 232 / 222 / 220 s | 255 / 243 / 227 s | 196 / 194 / 199 s |
| drenaż ≤ 120 s | nie (1 zadanie `running`) | 2 s | 2 s | **2 s**, 4 562 zadań `done`, 0 `failed`/`running` |

¹ steady24 nie jest ważnym profilem: zbiór 1 % wyczerpał stan. 4 154 polecenia nie zostały wysłane („only N products with
stock ≥ 8”, „no lot position with available stock”), więc zapisy spadły z 37 % (3 092 z 8 326, steady12) do 10,5 % żądań
(1 007 z 9 593; `order_create` 119 sukcesów wobec 1 261 w steady12). 31,98 RPS to głównie odczyty. Spadek kubełków
steady12 (34 → 23 RPS) idzie z rosnącą liczbą odrzuceń przygotowania.

Błędy (żadnego 5xx ani timeoutu sterownika w fazach mierzonych):

| Błąd | steady12 | steady24 | Przyczyna |
|---|---|---|---|
| `order_create` 409 „Za mało towaru” | 33 | 82 | wyczerpany stan zbioru 1 % (niżej) |
| `return_receive` 409 „Zapas zwrotu zmienił wersję. Odczytaj ponownie cały zakres” | 11 | 8 | kontrola wersji zapasu zwrotu: przygotowanie czyta wersję, inny zapisujący tej firmy zmienia ją przed odbiorem; przy wyłącznej `wms.operations` (przed B1) te zapisy szły po kolei; jest też w `p257-after-04` (4 w steady12), nie ma w `p256-after-03`; sterownik nie ponawia |
| `stock_operation` 409 „Stan lub rezerwacja zmieniły wersję” | 3 | 3 | wyścig z innym klientem na tej samej warstwie (jak w biegu 2) |

Log PG (`docker logs dyna-scale-pg18`, 03:31:40–03:54:30 UTC): 0 × 40P01 (ciało 250 `wms_evidence_usage_settle()` usuwa
14 deadlocków z `p257-after-04`); 20 × `statement timeout`, wszystkie na `SELECT pg_advisory_lock_shared(982376)`
między 03:38:32 a 03:41:09, czyli w starcie fabryk przed rozgrzewką (pkt 4.7), żadnego w fazach.

**Warunek pełnego biegu niespełniony, 30 min × 12 i 30 min × 24 nie uruchomione.** steady24 ma ≥ 20 RPS, ale 11 błędów
409 innych niż brak towaru (8 `return_receive`, 3 `stock_operation`), progi odczytów przekroczone, a mieszanka nie jest
profilem z powodu wyczerpania stanu; 30 min na zbiorze 1 % wyczerpałoby go jeszcze wcześniej.

### Pozostałe koszty (steady12 03:43:21–03:47:52 i steady24 03:48:22–03:52:53, `pg_stat_user_functions` co 30 s)

Baza jest nasycona CPU, nie blokadami: steady24 6 421 z ~6 560 próbek aktywnych backendów to `CPU`, `Lock:advisory` 3.
Suma czasu własnego funkcji to 8,8 rdzenia (steady12) i 10,4 rdzenia (steady24), czyli prawie cały CPU bazy
(996 / 1 103 %). Najczęstsze aktywne zapytania steady24: `guard_verdict('catalog_stock_control_guards')` 3 257,
`catalog_stock_return_prepare` 1 425, `financial_return_capture` 1 114. Instrukcje > 1 s w logu PG w fazach:
`catalog_stock_return_prepare` 1 007 × (śr. 1 125 ms), `financial_return_capture` 43 ×.

| Funkcja (steady24, 271 s) | wywołania | czas łączny s | czas własny s | śr. ms |
|---|---|---|---|---|
| `catalog_stock_control_guards` | 5 614 | 2 122 | 4,9 | 378 |
| `manual_inventory_off_valid` | 5 614 | 2 019 | 292 | 360 |
| `guard_verdict_full` (chybienie werdyktu) | 3 713 | 1 406 | 0 | 379 |
| `catalog_stock_control_require` | 1 901 | 716 | 0 | 377 |
| `manual_inventory_off_projection_valid` | 19 158 | 1 221 | 256 | 64 |
| `order_merge_delivery209_checked_projection_map` | 27 728 | 865 | 30 | 31 |
| `order_merge_delivery209_validation_snapshot` | 27 728 | 835 | **835** | 30 |
| `b2b_credit_fingerprint` | 6 772 | 679 | 218 | 100 |
| `catalog_stock_return_prepare` | 579 | 659 | 0 | 1 138 |
| `financial_return_capture` / `financial_return_guards` | 579 / 1 158 | 514 / 514 | 0 / 0 | 888 / 443 |
| `order_merge_delivery209_predecessor_descriptor` | 99 088 | 333 | **333** | 3,4 |

1. **`catalog_stock_control_guards()` nadal ~378 ms i 5 614 razy w 271 s (≈ 7,8 rdzenia łącznie).** 3 713 przebiegów to
   chybienia werdyktu 248 (`guard_verdict_full`), 1 901 to `catalog_stock_control_require`, które woła strażnika z
   pominięciem werdyktu (3 713 + 1 901 = 5 614 dokładnie; w steady12 2 815 + 1 440 = 4 255). Jego koszt to prawie w całości
   `manual_inventory_off_valid()` (2 019 z 2 122 s).
2. **Największy koszt własny: `order_merge_delivery209_validation_snapshot()`** — 835 s własnego czasu (≈ 3,1 rdzenia),
   27 728 wywołań po 30 ms, ~4,9 na przebieg strażnika (`server/209_order_merge_delivery_inheritance.sql:327`), plus
   `…_predecessor_descriptor` 333 s. Kto dokładnie woła migawkę w łańcuchu strażnika — niepotwierdzone (liczby wskazują
   `manual_inventory_off_projection_valid` / `…_checked_projection_map`, statystyki funkcji nie dają drzewa wywołań).
3. **Odbiór zwrotu ~2,3 s p50 bez kolejki**: `catalog_stock_return_prepare` 1 138 ms + `financial_return_capture` 888 ms
   (dwa `financial_return_guards` po 443 ms na odbiór, `catalog_stock_return_require` 383 ms). `return_receive` ma
   p95 3 200 ms przy 24 klientach — najbliżej progu 4 000 ms.
4. **`b2b_credit_fingerprint`** 100 ms × 6 772 (218 s własnego).
5. **Zbiór 1 % jest za mały na 24 klientów × 5 min** — wyczerpanie stanu, nie produkt; pełny bieg wymaga większego zbioru
   albo uzupełniania stanu w sterowniku.
6. **409 wersji przy zwrotach (B1)** — patrz tabela błędów.
7. Zimny start 194–199 s, nadal > 180 s (z migracjami 244–250 w pierwszej fabryce).

## 9. Wierność profilu sterownika (28.10): stan, odmowy 409, mieszanka

Cel: sterownik daje dla 30 min × 12 i 30 min × 24 mieszankę dokładnie z profilu, bez poleceń pominiętych z braku
stanu, z każdym 409 sklasyfikowanym. Commity `6f8dd64` (generator), `f5561aa`, `23cc98e` (sterownik); opis w
`tools/scale/load/README.md` „Profile fidelity”. Punkty 5 i 6 sekcji 8 są tym zamknięte.

### Decyzje

1. **Stan: większy zbiór, nie uzupełnianie w sterowniku.** Mieszanka profilu nie ma przyjęć PZ, a profil zabrania
   ukrytych klientów i niemierzonych pętli w godzinie pomiaru (`http.instrumentation`); tło ma tylko trzy ścieżki
   (automatyzacje, import, synchronizacja). Klient uzupełniający przez PZ dokładałby niezmierzone zapisy (PZ to
   ciężkie transakcje ze strażnikami) i zmieniał profil, a B/D (bez partii) nie mają ścieżki PZ. Większy zbiór
   zostawia mieszankę dokładnie jak w sekcji 5 manifestu.
2. **Rozmiar: SKU decydują o stanie, zamówienia o czasie generowania.** Stan otwarcia = popyt historii + bufor 5–40
   szt. na SKU (`plan.mjs` `productPlan`), więc dostępny stan rośnie z liczbą SKU, nie zamówień. Zmierzony koszt
   zamówienia w wydaniu HEAD: 3,4 s (A/C/E) i 1,2 s (B/D) na tor; jednolite `--scale-factor 0.2` (4 000 zamówień na
   firmę) to ~4 h według tej stawki, a pierwsze 89 zamówień na tor szło po ~6,9 s (bieg przerwany, ~7,7 h). Wybrane:
   `--tenants 5 --skus 20000 --orders 4000` (4 000 SKU i 800 zamówień na firmę, plan `1d1eae6f…903f`): 1 h 22 min.
   Proporcja SKU : zamówienia (5 : 1) różni się od pełnego profilu (1 : 1); żaden z mniejszych zbiorów nie ma jego tabel.
3. **409 wersji stanu: oznaczone wyścigi, bez ponawiania.** Profil (`limits.expected_contention`): odmawiać mogą
   tylko wcześniej oznaczone wyścigi gorących SKU/wersji, 409 z dokładnym powodem, ≤ 1 % żądań, poza przepustowością,
   z uzgodnieniem braku skutku; `http.model`: bez automatycznego ponawiania zapisów. Oznaczone (`EXPECTED_RACES`):
   `return_receive` „Zapas zwrotu zmienił wersję. Odczytaj ponownie cały zakres” i `stock_operation` „Stan lub
   rezerwacja zmieniły wersję” — oba to wersja wiersza `stock` (magazyn, produkt), którą podbija każda rezerwacja
   tego produktu przez innego klienta. Klient nie ponawia, czyta zwrotnie brak skutku; pozostałe 409 to błędy z przyczyną.

### Zbiór `dynaminds_scale_20261028_61`

Generowany na osobnej instancji `dyna-scale-pg18-gen` (ten sam obraz, `127.0.0.1:57091`, `shared_buffers=4GB`, bez
archiwum WAL), bo `--simulate-days` przesuwa zegar libfaketime całej instancji, a na `dyna-scale-pg18` biegał w tym
czasie test innego agenta (`_64`). Szablon `dynaminds_restore_36751abef3079f3f` z `pg_dump` instancji głównej, ACL
właściciela odtworzone `compare-template.mjs --apply-owner-acl` (pg_dump pomija ACL równe domyślnemu; bez tego
fabryka wydania odmawia: „211 exact complete addition roster and descriptors required”), `migrate()` źródła commita
wydania `1f35306` (ledger 250, 240 wpisów), strażnicy 10/10 `true` przed i po. Potem `pg_dump`/`pg_restore` do
`dyna-scale-pg18`, ACL jak wyżej: 737 tabel i 727 982 wiersze identycznie, skróty ACL równe; **485 MB**. Przy 4 000
SKU generator stawał na pierwszej partii produktów („Zestaw wymaga składników”: od 880 SKU na firmę wszystkie proste
SKU bloku 0 są gorące) — poprawka planu `6f8dd64` (dotyczy też pełnego profilu: skrót `ca7c640f…`).

Stan na MAIN na firmę: 3 072 SKU, dostępne 68 877–69 747 szt., SKU z ≥ 8: 2 827–2 858, użyteczne dla sterownika
(Σ max(0, dostępne − 7)) 47 607–48 478 szt.; w zbiorze 1 % `_41` dostępnych było 4 136–4 741.

### Bieg walidacyjny (HEAD `1f35306`, 250; `--warmup 60 --phases steady12:12:300,steady24:24:300 --workers 2`)

`data/scale/load/fid61-01` (kopia `_62`) i `fid61-02` (kopia `_63`, po poprawce odczytu zwrotnego `23cc98e`).

| | fid61-01 steady12 | fid61-01 steady24 | fid61-02 steady12 | fid61-02 steady24 | l250-head-01 steady24 (zbiór 1 %) |
|---|---|---|---|---|---|
| żądania / RPS sukcesu | 7 750 / 25,83 | 9 543 / 31,81 | 7 605 / 25,35 | 9 139 / 30,46 | 9 686 / 31,98 |
| udział zapisów wysłanych (60-s kubełki) | 37,9 % (37,5–38,3) | 38,1 % (37,9–38,2) | 37,9 % (37,6–38,3) | 38,1 % (37,7–38,3) | 11,4 % (18,2 → 7,9) |
| pominięte z braku stanu | **0** | **0** | **0** | **0** | 4 151 |
| inne odmowy przygotowania | 1 | 0 | 2 | 2 | 3 |
| odczyty p95 / p99 ms | 31 / 46 | 351 / 520 | 39 / 67 | 351 / 519 | 633 / 1 020 |
| zapisy p95 / p99 ms | 2 300 / 2 460 | 2 450 / 2 640 | 2 320 / 2 530 | 2 480 / 2 690 | 2 970 / 3 480 |
| operacje z niespełnionym progiem | 0 | 0 | 0 | 0 | 3 |
| błędy | 1 ¹ | 0 | 0 | 0 | 93 |
| odmowy oczekiwane (brak skutku potwierdzony) | 0 | 0 | 0 | 2 (2) | — |
| 409 wg przyczyny | `return_stock_version` 1 | — | — | `return_stock_version` 2 | `stock_shortage` 82, `return_stock_version` 8, `stock_version` 3 ² |
| zużycie stanu na firmę | 538–631 szt./min | 664–787 szt./min | 533–592 szt./min | 658–786 szt./min | — |

¹ Odczyt zwrotny po odmowie uznał skutek, bo sprawdzał `receipt_sequence IS NULL`, a nieprzyjęta sprawa ma 0 (sprawa
`397920d1…` w `_62`: `requested`, wersja 1, `receipt_sequence` 0, czyli bez skutku). Poprawka `23cc98e` z testem;
w `fid61-02` obie odmowy mają potwierdzony brak skutku. ² Przeliczone `report.mjs` na kopii surowych danych.

Udział zapisów 37,9–38,1 % zamiast 40 % to tylko `stock_operation` B/D bez wariantu w powiązaniach (`not_bindable`,
2 % zadań: 158–203 na fazę); pozostałe operacje są w ±1,2 pp od profilu, `stock_operation` wysłane 2,8 % (−2,2 pp),
dlatego raport pokazuje „OUTSIDE”. Inne odmowy przygotowania: `GET /api/orders/:id` po 10 s (`HTTP_TIMEOUT`,
przygotowanie zwrotu) i 409 wersji przy tworzeniu podglądu korekty (niemierzone przygotowanie). RPS sukcesu spada
w każdej fazie (steady12 31,6 → 18,9, steady24 37,8 → 26,1 w `fid61-02`) bez braku stanu i bez błędów — przyczyna
niezbadana.

### Progi odczytów przy 24 klientach — czy to kolejka sterownika (bez zmian w produkcie)

Nie. Dowody z próbek `l250-head-01` i `fid61-01`:

- jedno żądanie w locie na klienta: przedziały mierzonych żądań i wywołań przygotowania jednego klienta nie nachodzą
  na siebie (`fid61-01`: 0 nakładań; `l250-head-01`: 13 nakładań po 2–6 ms między kolejnymi żądaniami jednego klienta,
  czyli skok zegara ściennego `Date.now()` wobec monotonicznego czasu trwania, nie współbieżność);
- jedno gniazdo keep-alive na klienta (`maxSockets: 1`), zegar od `http.request` do ostatniego bajtu; treść po
  pierwszym bajcie odczytów przy 24 klientach p50 0,07 / p95 0,13 / max 2,6 ms (`ttfb_ms`), więc czas to oczekiwanie
  na serwer;
- opóźnienie pętli zdarzeń klientów p99 ≤ 12–14 ms przy rozdzielczości pomiaru 10 ms (nadwyżka ≤ 2–4 ms), CPU
  kontenera klienta 0,5–1 %;
- p95 odczytów jest podobne u wszystkich klientów (steady24 `fid61-01`: 273–399 ms; `l250-head-01`: 500–740 ms);
  te same trasy w niemierzonym przygotowaniu mają ten sam rozkład (np. `GET /api/products` p95 325 ms);
- p95 odczytów rośnie z liczbą zapisów w locie w chwili startu odczytu (`l250-head-01` steady24: 136 ms przy 0 →
  605–757 ms przy 4–8; `fid61-01`: 119 → 339–491 ms), a baza pracuje na ~10–11 rdzeniach (`CPU` ≈ 98 % próbek
  aktywnych backendów).

Odczyty `l250-head-01` przy 24 klientach to kolejka CPU bazy pod zapisami, nie sterownik. Na `_61` (ten sam produkt)
progi odczytów są spełnione (p95 351 / p99 520 ms).

### Pełny bieg: zapas stanu

Zużycie w `fid61-02`: ~570 szt./min na firmę przy 12 klientach i ~660–790 przy 24. Pełny profil (600 s ×12 +
1 800 s ×12 + 1 800 s ×24) ≈ 5,7 + 17,1 + 23,7 = **~46,5 tys. szt. na firmę** wobec 47,6–48,5 tys. użytecznych w `_61`:
za mało zapasu, bo zużycie rośnie z przepustowością. Pełny bieg: zbiór **`dynaminds_scale_20261028_71`**
(`--tenants 5 --skus 40000 --orders 4000`, plan `a370c1c2…82e2`, 1 h 56 min, 596 MB, 1 132 379 wierszy przeniesionych
identycznie): 6 144 SKU na MAIN i 95 983–96 653 szt. użytecznych na firmę, ~2× potrzeby. Próba `fid71-smoke`
(kopia `_72`, 120 s × 24): 35,17 RPS, 0 błędów, 0 pominiętych z braku stanu, oczekiwane odmowy
`return_stock_version` 1 i `stock_version` 1 z potwierdzonym brakiem skutku, odczyty p95/p99 333/533 ms.

```sh
# pełny bieg (kopia na bieg; _71 zostaje wzorcem)
tools/scale/docker/scale-pg.sh psql postgres -c "CREATE DATABASE dynaminds_scale_20261028_NN TEMPLATE dynaminds_scale_20261028_71"
SCALE_PG_STATE=<full-base>/data/scale/pg18-docker node tools/scale/load/run.mjs --release <scale-release-head-20261028-01>/release-build.json \
  --db dynaminds_scale_20261028_NN --tag 5076fb8f --out docs/scale/results/<YYYYMMDD-HHMM>-<sha12> \
  --warmup 600 --phases steady12:12:1800,steady24:24:1800 --workers 2
```

Raporty generatora (poza gitem): `data/scale/runs/gen61.report.json`, `gen71.report.json` (+ `.log`, przerwany bieg
`--scale-factor 0.2`: `gen61-sf02-stopped.log`). Instancja `dyna-scale-pg18-gen` i jej wolumin usunięte po przeniesieniu.
