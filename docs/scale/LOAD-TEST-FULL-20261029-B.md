# Pełny test obciążenia etapu 5 na pełnym zbiorze — biegi `full-20261029-02…04` (29.10.2026, popołudnie)

**Wynik: NIEZALICZONY.** Pierwszy raz na pełnym zbiorze (5 × 20 000 SKU, 5 × 20 000 zamówień, 180 dni) i na wydaniu
z HEAD `db02405` (migracje do 262):

- **steady12 spełnia wszystkie progi**: 61,97 RPS, 0 błędów, 0 × 429, odczyty p95/p99 50/60 ms, zapisy 359/562 ms,
  mieszanka w tolerancji.
- **steady24 nie został zmierzony.** Proces aplikacji (`dyna-load-app`) padł 15 s po starcie fazy. Wyjątek
  `ERR_HTTP_HEADERS_SENT` z opakowania hooków `server/ordinary-request-lifetime.ts:97` stał się nieobsłużonym
  odrzuceniem obietnicy, a Node zakończył proces. Od tej chwili każde żądanie dostawało `ECONNREFUSED`. Worker
  (`dyna-load-worker-2`) działał dalej. To nie OOM, nie restart i nie wyczerpanie puli (dowody w §4.1).
- Powtórzenie (`-03`) też padło na tym samym wyjątku, ale po 2-minutowym zamrożeniu VM Dockera. Zamrożenie wywołało
  moje ustawienie pamięci (§4.2), więc bieg jest nieważny.
- Trzecia próba (`-04`) nie doszła do rozgrzewki: laptop przeszedł na baterię i zamknął pokrywę, więc host zasnął
  (§4.3). Nie wymuszałem biegu (`--allow-battery`).

Surowe dane: `data/scale/load/full-20261029-0{2,3,4}/` (`run.json`, `SUMMARY.md`, `raw/`, `extra/`: migracja
i strażnicy, `pg_settings`, limity kontenera, host przed/po, `diag/` z `pg_stat_user_functions` co 180 s; w `-03`
i `-04` także `host-ps.log`, w `-03` `vm-oom-dmesg.txt`, w `-04` `vm-mem.log`).

## 1. Wydanie, dane, ustawienia

| Pole | Wartość |
|---|---|
| commit wydania | `db02405633d0abd7449822d08497808c977a7f3a` (HEAD `goal/full-base-20261017`) |
| katalog | `local-builds/full-base-preview-20261017/scale-release-full-20261029-03` (`tools/scale/release-build.mjs`, 7,4 s) |
| `release.json` / drzewo pakietu | `e68f99001d653a798dd2068a330f8a4577008748b05397216ebde79b17f7c61a` / `d82956195766075a9ba216f53ec43a05f0df253c9b4e1dee7134d188dbe48a5a`, 454 pliki, 102 298 127 B |
| kontrakt źródeł | `dea9cacae24f414cb09104bfc5c6af18d50317f71b53dddd7dd8bcae30535e07`, `1.0.0-full-base-scale-db02405633d0.262`, 80 krawędzi Native, ostatnia `262_revoke_public_temporary` |
| sterownik | `tools/scale/load/` z `b92d6b5` (wydanie + port monitora, §6) |
| instancja | `dyna-scale-full-pg18` (`127.0.0.1:57091`), PostgreSQL 18.4 + libfaketime, zegar `+0` |
| baza wzorcowa | `dynaminds_scale_20261029_03` (pełny zbiór z biegu 5 generatora, 6 865 MB, ledger 248 → `258_wz_issuer_refresh`); nietknięta, tak samo jak `_q597` |
| kopie na biegi | `_04` (bieg `-02`), `_05` (`-03`), `_06` (`-04`): `CREATE DATABASE … TEMPLATE dynaminds_scale_20261029_03` przy 0 połączeń do `_03` (16 s), potem `ALTER DATABASE … SET track_functions='all'` |
| polecenie | `SCALE_PG_CONTAINER=dyna-scale-full-pg18 SCALE_PG_PORT=57091 SCALE_PG_STATE=…/pg18-full-docker caffeinate -is node tools/scale/load/run.mjs --release …/scale-release-full-20261029-03/release-build.json --db <kopia> --tag 5076fb8f --warmup 60 --phases steady12:12:1800,steady24:24:1800 --workers 2 --rate-limit-per-min 3000` |

### 1.1 Migracja na pełnych danych (dowód „dane N działają w N+1”)

Fabryka wydania (`createOrdinaryLocalApplication`: prawdziwe `migrate()` + zimna walidacja) na każdej kopii, w
przestrzeni sieciowej instancji (skrypt w scratchpadzie sesji; wynik w `extra/migrate-guards-0N.json`).

| kopia | ledger przed → po | `migrate_ms` | zimna walidacja | fabryka razem |
|---|---|---|---|---|
| `_04` | 248 (`258_wz_issuer_refresh`) → **252** (`262_revoke_public_temporary`) | **1 398 ms** | 76,1 s | 102,2 s |
| `_05` | 248 → 252 | 1 971 ms | 82,7 s | 110,8 s |
| `_06` | 248 → 252 | 1 673 ms | 99,4 s | 136,0 s |

Migracje 259–262 (dwa indeksy częściowe, liczniki stocktake, REVOKE TEMPORARY) trwają na 6,9 GB danych 1,4–2,0 s.

Strażnicy po migracji, w transakcji tylko do odczytu, sesja `jit=off`, `timezone=UTC`: **15/15 `true`** na każdej kopii.
To 12 strażników z biegu porannego (w tym `local_invoice_guards`, `warehouse_wz_issuer_guards` 2,1 s,
`email_inbound_guards`) oraz `catalog_stock_control_guards`, `financial_return_guards` i `stocktake_adjustment_guards`.

### 1.2 Ustawienia PostgreSQL i limity kontenera

Manifest (`MEASUREMENT-MANIFEST-20261025.md` §3) przewiduje na pomiar `shared_buffers=16GB` i `maintenance_work_mem=2GB`.
Generowanie zostawiło w `postgresql.auto.conf` `shared_buffers=3GB`, `maintenance_work_mem=1GB` i
`autovacuum_work_mem=512MB`. Kontener miał limity `--cpus 6 --memory 10g`, a `dyna-scale-pg18` z porannego biegu
nie miał limitów.

| | generowanie (zastane) | biegi `-02`, `-03` | bieg `-04` |
|---|---|---|---|
| `ALTER SYSTEM` | 3GB / 1GB / 512MB | `RESET` wszystkich trzech, czyli wartości z `postgresql.scale.conf`: **16GB / 2GB / -1** | `shared_buffers='8GB'` (odstępstwo, §4.2), reszta jak w `-02` |
| limity kontenera | 6 CPU, 10 GiB | **18 CPU (cała VM), 20 GiB** | 18 CPU, 12 GiB |
| reszta | bez zmian względem manifestu: `effective_cache_size 64GB`, `work_mem 32MB`, `max_wal_size 16GB`, `checkpoint_timeout 15min`, `random_page_cost 1.1`, `jit off`, `archive_mode on` (60 s), `autovacuum` 0,05/0,02, `fsync/synchronous_commit on` | | |

Pełny zrzut `pg_settings` przed resetem i na pomiar: `extra/pg_settings-*.txt`. Stan instancji po sesji opisuje §7.

### 1.3 Limit żądań na adres: 3000/min

- Klient profilu to pętla zamknięta bez przerw. W steady12 biegu `-02`, bez limitu w zasięgu, jeden klient wysłał
  p50 649, p99 776 i max **795** wywołań na minutę, licząc pomiar i przygotowanie razem. Rano przy limicie 600 było to
  ≤ 708 bez 429.
- Przy 24 klientach na klienta przypada ~420–540 wywołań na minutę (rano).
- 3000/min (50/s z adresu) daje ~3,8× zapasu nad najszybszym klientem profilu. Zostaje ochrona: jeden adres nie
  weźmie więcej niż ~⅓ zmierzonej zdolności serwera (~170 wywołań/s przy 24 klientach).
- Zapisane w `run.json` → `rate_limit`: `{"per_address_per_minute":3000,"source":"env","requested":3000,"reported_by_release":true}`
  (z `/api/health` obu CLI). W żadnym biegu nie było 429.

## 2. Host

| | `-02` przed (16:07 UTC) | `-02` w biegu | `-02` po (16:56) | `-03` (16:59–17:19) | `-04` (17:23–18:20) |
|---|---|---|---|---|---|
| load avg | 3,45 / 4,82 / 5,99 | warmup ≤ 10,3; steady12 12–16, dwa skoki **29,5–33,6** (16:18–16:22, 16:32–16:36) | 7,24 / 6,88 / 9,32 | do 38,9 w zamrożeniu VM | 15,8 na starcie, 108,9 po wybudzeniu |
| zasilanie | AC, 54 %, ładowanie | AC | AC | AC | AC na starcie; od 17:25 **bateria** (clamshell sleep) |
| pokrywa / sen | otwarta, `sleep 0`, `caffeinate -is` | brak Sleep/Wake w `pmset -g log` | — | — | `Entering Sleep state due to 'Clamshell Sleep' … Using Batt` 17:25:16 UTC |

Inne obciążenie hosta (próbki `ps`):
- przez cały czas testy na PG04 (`dynaminds_m260_20261029_10/11`, ~1 rdzeń) i proces `tsx` innego agenta (~1 rdzeń);
- `cpro-chain-test` ~10 % CPU;
- `dyna-scale-pg18` bezczynny.

Skoki load do 30–34 w steady12 biegu `-02` zbiegają się z kubełkami 48,45 i 51,53 RPS. Ich źródła nie ustaliłem,
bo sampler procesów dodałem dopiero w `-03`. Faza mieści się w progach z dużym zapasem, a polityka sterownika
unieważnia fazę tylko przy przerwie hosta. Fazę uznaję za ważną, z tym zastrzeżeniem.

Przerwa `process_stall` przed rozgrzewką: 106 s w `-02` i 117 s w `-03`. To synchroniczny `spawnSync` kroku setup,
ten sam fałszywy alarm co rano (`LOAD-TEST-FULL-20261029.md` §1). Żadna faza nie jest NIEWAŻNA.

## 3. Wyniki biegu `full-20261029-02` per faza

| | warmup (60 s, 12 kl.) | steady12 (1800 s) | steady24 (1800 s) | próg |
|---|---|---|---|---|
| RPS sukcesu | 65,92 | **61,97** | 0,59 (padło po 15 s) | 10 / 20 |
| najsłabszy 60-s kubełek | 65,82 | 48,45 | 0 | ≥ 5 / ≥ 10 |
| żądania / sukcesy | 3 955 / 3 955 | 111 539 / 111 539 | 59 193 / 1 055 | — |
| błędy | 0 | **0** (0 × 429, 0 × 5xx, 0 timeoutów) | **58 138** (`ECONNREFUSED`/`ECONNRESET`, 0 × 5xx, 0 × 429) | 0 |
| odmowy przygotowania | 0 | 0 | 79 760 (`ECONNREFUSED`) + 1 × 409 „Zamówienie ma już fakturę” | — |
| oczekiwane odmowy (oznaczone 409) | 0 | 0 | 0 | ≤ 1 % |
| udział zapisów wysłanych | 38,3 % | 38,3 % (kubełki 38,0–38,5); odchylenie max 2,0 pp: w tolerancji | 1,6 % | 40 % ± 2 pp (≈ 38,8 % z `not_bindable` B/D) |
| odczyty p95 / p99 ms | 49 / 56 | **50 / 60** | — | 500 / 1000 |
| zapisy p95 / p99 ms | 299 / 540 | **359 / 562** | — | 4000 / 8000 |
| najstarsze oczekujące zadanie p95 / max | 1,12 / 1,26 s | **1,25 / 3,25 s** | — | 15 / 60 s |
| opóźnienie reguły p50 / p95 / p99 | 0,47 / 1,28 / 1,50 s | 0,51 / 1,32 / 1,61 s | — | — |
| zadania workerów | 816 | 22 821 | — | — |
| CPU `dyna-scale-full-pg18` średnio / max | 634 / 698 % | 630 / 823 % | — | — |
| CPU `dyna-load-app` średnio / max | 84 / 90 % | **85 / 110 %** | — | — |
| stan MAIN na firmę: zużycie / zapas | — | 1 369–1 422 szt./min, zapas 220–229 min, ≥ 8 szt.: 13 370–13 479 SKU | — | 0 pominiętych |

Per operacja w steady12, sukcesy, p95 / p99 ms:
- `order_list` 12 / 18;
- `catalog_search` 55 / 67;
- `order_detail` 33 / 54;
- `order_create` 438 / 660;
- `reserve_and_status` 74 / 112;
- `payment_or_document` 267 / 318 (faktura ścieżką 230);
- `stock_operation` 144 / 190;
- `return_receive` 402 / 515.

Udział firm 19,2–20,4 %. Opóźnienie pętli klientów p99 ≤ 12,5 ms, CPU kontenera klienta ≤ 1,3 %. Najczęstsze
oczekiwania backendów: CPU 19 891, `Lock:transactionid` 1 276, `Lock:advisory` 371.

Aplikacja to jeden proces Node. Przy 12 klientach zajmuje średnio 85 % rdzenia (max 110 %), baza 6,3 z 18 rdzeni.
Przyrost RPS względem rana (57,5, wtedy z sufitem limitu 600) jest mały, bo aplikacja jest blisko jednego rdzenia.
**Niepotwierdzone:** że to ona jest sufitem przy 12 klientach. Nie profilowałem CPU procesu Node.

Zimny start w `-02`: `dyna-load-app` 116,1 s, `dyna-load-worker-2` 105,3 s (próg 180 s; po jednej próbie, jak rano).

### PASS/FAIL per kryterium (bieg `-02`)

| Kryterium | steady12 | steady24 |
|---|---|---|
| RPS sukcesu ≥ 10 / ≥ 20 przez całą fazę | PASS (61,97) | **FAIL** (0,59; aplikacja padła) |
| żaden pełny 60-s kubełek < ½ minimum | PASS (min 48,45) | **FAIL** |
| odczyty p95 ≤ 500, p99 ≤ 1000 ms | PASS (50 / 60) | nie zmierzone |
| zapisy p95 ≤ 4000, p99 ≤ 8000 ms | PASS (359 / 562) | nie zmierzone |
| zero nieoczekiwanych błędów / 5xx / timeoutów | PASS (0) | **FAIL** (58 138 błędów połączenia) |
| oczekiwane odmowy ≤ 1 %, z powodem, bez skutku | PASS (0) | — |
| mieszanka ± 2 pp | PASS (2,0 pp) | **FAIL** |
| 0 poleceń pominiętych z braku stanu | PASS | PASS (0) |
| najstarsze oczekujące zadanie p95 ≤ 15 s, max ≤ 60 s | PASS (1,25 / 3,25 s) | — |
| drenaż ≤ 120 s | — | nie wykonany (bieg przerwany po awarii) |
| zimny start ≤ 180 s | PASS (116 / 105 s, jedna próba) | — |
| sen hosta / przerwa w fazie | brak | brak |

## 4. Przyczyny niezaliczenia, z dowodami

### 4.1 Awaria procesu aplikacji: `ERR_HTTP_HEADERS_SENT` jako nieobsłużone odrzucenie (produkt)

Przebieg w `-02`:
- steady24 start 16:44:06 UTC.
- 16:44:21,689: wszystkie 11 mierzonych żądań w locie kończy się `ECONNRESET`.
- Od 16:44:21,90 każde połączenie z `127.0.0.1:4101` dostaje `ECONNREFUSED` (`raw/steady24-c*.samples.ndjson`,
  `*.prep.ndjson`).

`raw/dyna-load-app.log` kończy się tak (cały log procesu ma 1 088 B):

```
Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client
    at ServerResponse.writeHead (node:_http_server:354:11)
    at safeWriteHead (…/fastify/lib/reply.js:586:9)
    at onSendEnd (…/fastify/lib/reply.js:658:5)
    at wrapOnSendEnd (…/fastify/lib/reply.js:579:5)
    at next (…/fastify/lib/hooks.js:292:7)
    at file:///…/scale-release-full-20261029-03/release-canonical/runtime/chunks/chunk-CFVL23JG.mjs:1:65317
Node.js v22.23.0
```

Co wykluczyłem:

- **OOM.** `dmesg` VM Dockera obejmuje dni od 27.10 i ma jedno zdarzenie OOM, o 17:09:09 UTC, w biegu `-03` (§4.2).
  O 16:44 nie ma żadnego. Kontener `dyna-scale-full-pg18` w tym czasie: 6,1 GiB z 20 GiB.
- **Restart.** Kontener aplikacji (`docker run --rm`) zniknął po zakończeniu procesu i nie został uruchomiony ponownie.
  `docker inspect` nie był już możliwy, bo `--rm` usuwa kontener. Dowodem końca procesu jest log: wyjątek nieobsłużony
  i stopka `Node.js v22.23.0`, czyli wyjście Node z kodem ≠ 0.
- **Worker.** `dyna-load-worker-2` działał do końca (`Up 43 minutes` o 16:53) i nie przyjmuje ruchu klientów.
- **Pula i deskryptory.** W PG o 16:44:21,689 jest 11 × „unexpected EOF on client connection with an open
  transaction”: połączenia puli aplikacji zamknął koniec procesu. Wcześniej nie ma błędów ani limitów czasu. Do
  awarii żądania szły normalnie: 12 400 na minutę, 0 błędów. Wyczerpania puli ani deskryptorów nic nie wskazuje.
- **Limit i baza.** 0 × 429; brak 5xx; `checkpoint complete` 16:44:20 bez skutków.

Mechanizm, potwierdzony w kodzie:

- `server/ordinary-request-lifetime.ts:92-97` opakowuje każdy hook w stylu callbacku (`onSend` ma arność 4, np.
  `fastifyCookieOnSendHandler` z `@fastify/cookie`, `index.js:177`) w obietnicę. Wywołanie `done` przenosi do
  `.then(values=>done(...values), first=>done(first))`, poprzedzonego `void`.
- Gdy `done` rzuci synchronicznie (tu: `onSendEnd` → `safeWriteHead` → `writeHead` po wysłanych nagłówkach), wyjątek
  odrzuca obietnicę, której nikt nie obsługuje. Node 22 kończy wtedy proces (`--unhandled-rejections=throw`).
- Bez opakowania `done` wołany jest synchronicznie z hooka. Fastify ma guard podwójnej odpowiedzi
  (`reply.sent` = `raw.writableEnded`, `fastify/lib/reply.js:107-111`, `:161` → `FST_ERR_REP_ALREADY_SENT` tylko
  jako ostrzeżenie w logu).
- Opakowanie przesuwa koniec `onSend` do mikrozadania. Druga odpowiedź tego samego żądania może więc wejść w
  `onSend`, zanim pierwsza zakończy strumień. Guard tego nie łapie, a druga gałąź pada na `writeHead`.
- Gałąź `reply.js:658` to odpowiedź z pustym ładunkiem (`payload` null/undefined).

**Niepotwierdzone: która trasa wysyła drugą odpowiedź.**
- Fastify loguje przed rzutem URL trasy („Reply was already sent … in the "<url>" route”, `reply.js:589`), ale
  logger wydania jest wyłączony i w logu go nie ma.
- Przez 183 ms przed awarią nie zakończyło się żadne żądanie wobec ~36 oczekiwanych. Ostatnią odpowiedzią przed
  awarią była odmowa przygotowania 409 „Zamówienie ma już fakturę” z
  `POST /api/invoice230/orders/:id/previews` (klient 0, firma B, 16:44:21,506).
- To kandydat, nie dowód. Odtworzenie wymaga testu z dwiema równoległymi odpowiedziami jednego żądania na
  zainstalowanym `installOrdinaryRequestLifetime`.

Powtórzenie w `-03`: ten sam stos w `raw/dyna-load-app.log`. Proces padł o ~17:09:20 UTC, 3 min po starcie
steady12, ale dopiero po zamrożeniu VM (§4.2). Każde żądanie dostawało tam przez 2 min limit czasu 10 s. Ten sam
wyjątek pojawia się więc w dwóch różnych warunkach: zwykłe obciążenie przy 24 klientach i zamrożenie z limitami czasu.

Skutek dla odbioru:
- jeden błąd programistyczny w dowolnej trasie zabija cały proces HTTP instalacji, z workerem w tym samym procesie;
- przy 24 klientach zdarzyło się to po 15 s, przy 12 klientach przez 30 min wcale.

Poprawka należy do produktu i jest poza tym zadaniem. Kierunek:
- `done` w `.then` w `try/catch`, wyjątek przekazany do `onError`/logu;
- ustalenie trasy z podwójną odpowiedzią.

### 4.2 Bieg `-03`: zamrożenie i OOM VM Dockera przez moje ustawienie pamięci (pomiar, nieważny)

- Od 17:06:52 do 17:09:27 UTC instancja `dyna-scale-full-pg18` stała. `SHOW transaction_read_only` trwało 125 267 ms,
  a zapytanie monitora 129 501 ms (log PG). VM Dockera zajmowała w tym czasie 1 500–1 600 % CPU hosta
  (`extra/host-ps.log`).
- **Przyczyna:** wyczerpana pamięć VM, z wymianą do pełna (swap 1 GiB).
  - Mój `RESET shared_buffers` (16 GB) w `dyna-scale-full-pg18` działał obok bezczynnego `dyna-scale-pg18`.
    Ten trzymał 10,4 GB bufora wspólnego z porannych biegów (`docker stats` 10,7 GiB).
  - VM ma 31,3 GiB, a `shmem` sięgnął 20,5 GB.
  - Przy drugiej kopii (`_05`) bufory wspólne pełnej instancji rosły dalej (8,5 GiB w 17:06).
- `dmesg` VM:
  `17:09:09 UTC global_oom … task_memcg=/docker/b15a061f… (dyna-scale-pg18), Killed process 78426 (postgres.real) … shmem-rss:10415920kB`
  (`extra/vm-oom-dmesg.txt`).
- Skutek dla `dyna-scale-pg18`:
  - zabity bezczynny checkpointer, postmaster zrobił restart z odtwarzaniem;
  - „redo done at 7/87000028”, ostatnia aktywność 09:33, gotowy 17:09:32, healthy, `RestartCount 0`;
  - baz `_71/_41/_61/_81/_82` nikt nie zmieniał, a odtwarzanie WAL nie miało czego powtarzać.
  - Ten restart spowodowało moje ustawienie.
- Bieg `-03` jest nieważny jako pomiar. Odstępstwo w `-04`: `shared_buffers=8GB`, limit kontenera 12 GiB, bo baza
  ma 6,9 GB. 16 GB z manifestu nie mieści się w VM z 31 GiB obok drugiej instancji 16 GB.

### 4.3 Bieg `-04`: host zasnął na baterii (nieważny, nie wymuszany)

- `pmset -g log`:
  - 17:25:16 UTC `Entering Sleep state due to 'Clamshell Sleep' … Using Batt (Charge:92%)`;
  - potem cykle `DarkWake`/`Maintenance Sleep`;
  - `Wake … lid` dopiero o 18:18:44 UTC.
- Setup trwał przez to 37,8 min (fabryka 1 341,6 s zamiast ~105 s), a `dyna-load-app` nie wstał w 15 min
  („dyna-load-app not listening in 15 min”). Żadna faza nie ruszyła.
- Po wybudzeniu: zasilanie z baterii, load 34–109 (inne sesje). Sterownik odmawia pełnego biegu na baterii,
  a polityka profilu każe w takim stanie raportować, nie wymuszać.

## 5. Koszty CPU bazy: najdroższe funkcje steady12 (`pg_stat_user_functions`, self time) wobec rana

| | 29.10 rano steady12 (`_81`, 8 000 SKU/firmę, 57,5 RPS) | **29.10 `-02` steady12 (pełny zbiór, 62,0 RPS)** |
|---|---|---|
| suma self time funkcji | 4,00 rdzenia | 4,16 rdzenia (okno 1 627 s) |
| `warehouse_inventory_policy_guards` | 0,98 r., 0,9 ms × 1,95 mln | **1,28 r.**, 1,09 ms × 1,91 mln (1 176/s) |
| `order_merge_delivery209_validation_snapshot` | 0,67 r., 17,0 ms | 0,46 r., 19,8 ms × 37 809 |
| `guard_verdict_basis` | 0,31 r., 3,4 ms | 0,46 r., 4,3 ms × 172 685 |
| `enforce_workspace_quota` | 0,17 r., 3,4 ms | **0,36 r., 6,75 ms** × 86 944 (2× drożej na wywołanie: rośnie z danymi) |
| `order_merge_delivery209_predecessor_source_sha` | 0,48 r., 0,4 ms | 0,22 r., 0,47 ms |
| `order_merge_delivery209_predecessor_descriptor` | — | 0,15 r., 3,0 ms |
| `manual_inventory_off_valid` (pełny strażnik) | 0,10 r., 233 ms × 5 184 | 0,13 r., 277 ms (total) × 5 122 |
| `verdict241_ddl_intact` | — | 0,12 r., 0,87 ms × 221 522 |
| `manual_inventory_off_projection_valid` | — | 0,11 r., 49 ms (total) |
| `buyer_available236_basis` | — | 0,09 r., 3,3 ms |
| `b2b_credit_fingerprint` | 0,06 r., 66 ms | 0,08 r., 77 ms (total) |
| `local_invoice_budget` | 0,17 r., 23,6 ms (rosło) | **zniknęło**: faktury ścieżką 230 (FV-S) |

Najczęstsze aktywne zapytania (próbki `pg_stat_activity`, steady12):

| zapytanie | rano | `-02` |
|---|---|---|
| `guard_verdict('catalog_stock_control_guards')` | 18 % | **21,5 %** |
| `local_invoice_guards()` | 8,1 % | 7,9 % |
| `INSERT INTO orders` | — | 6,5 % |
| `warehouse_policy_map` / `warehouse_inventory_policy_lock` | 4,7 % | 5,6 % / 5,3 % |

Wniosek:
- Pełny zbiór (2,5× więcej SKU, 25× więcej zamówień na firmę) nie zmienia profilu kosztów bazy przy 12 klientach.
- Najdroższy jest nadal `warehouse_inventory_policy_guards`: tani na wywołanie, ale ~1 200 wywołań/s.
- Rośnie `enforce_workspace_quota`, z 3,4 do 6,75 ms.
- Ubył `local_invoice_budget`.

Steady24 nie ma danych funkcji, bo awaria wypadła przed pierwszą próbką.

## 6. Narzędzia zmienione w tej sesji

`b92d6b5` `fix(scale-load)`:
- Monitor `run.mjs` łączył się zawsze z `127.0.0.1:57090`, czyli z `dyna-scale-pg18`. Przy pełnym zbiorze baza
  biegu jest w `dyna-scale-full-pg18` (57091), więc monitor czytałby inną instancję albo nie znalazłby bazy.
- Teraz port pochodzi z `monitorPort(process.env)` (`lib.mjs`): `SCALE_PG_PORT` (domyślnie 57090) z regułą parowania
  z `scale-pg.sh`. 57090 przysługuje tylko `dyna-scale-pg18`; porty Main i PG04 (4100, 5432, 57084) są odrzucane.
- Test w `tests/scale-load.test.mjs` przed zmianą był czerwony (brak eksportu `monitorPort`). Po zmianie cały plik
  30/30. README uzupełnione o zmienne instancji pełnego zbioru.

Poza tym sterownik bez zmian. Okno katalogu, kandydaci `order_detail` sprzed startu i faktury 230 działały na pełnym
zbiorze bez poprawek: steady12 miał 0 odmów przygotowania, 0 pominiętych z braku stanu i 0 × 409.

## 7. Stan po sesji

- Kopie `dynaminds_scale_20261029_04`, `_05` i `_06` zostają do analizy (ledger 252):
  - `_04`: 23 839 zamówień biegu;
  - `_05`: 1 071;
  - `_06`: 0.
- `_03` i `_q597` nietknięte (tylko odczyt jako wzorzec `TEMPLATE`).
- `dyna-scale-full-pg18` zostaje z ustawieniami pomiaru biegu `-04`: `ALTER SYSTEM shared_buffers='8GB'`
  (`maintenance_work_mem`/`autovacuum_work_mem` z pliku: 2GB / -1), limity 18 CPU / 12 GiB.
  - Powrót do ustawień generowania:
    `ALTER SYSTEM SET shared_buffers='3GB', maintenance_work_mem='1GB', autovacuum_work_mem='512MB'` +
    `docker update --cpus 6 --memory 10g --memory-swap 10g dyna-scale-full-pg18` + restart.
- `dyna-scale-pg18` po restarcie z odtwarzaniem (§4.2), healthy, bazy bez zmian.
- Kontenery `dyna-load-*` usunięte przez `run.mjs`. `private/` każdego biegu usunięte. Sekretów nie ma w plikach
  `extra/` ani w logach.
- Do pełnego zaliczenia potrzebne:
  1. poprawka produktu 4.1: wyjątek `done` w opakowaniu hooków nie może kończyć procesu; ustalić trasę z podwójną
     odpowiedzią;
  2. bieg na AC z otwartą pokrywą;
  3. decyzja o budżecie pamięci VM. 16 GB `shared_buffers` z manifestu wymaga, żeby `dyna-scale-pg18` był w tym
     czasie zatrzymany albo miał mniejszy bufor. Inaczej zostaje 8 GB (zbiór 6,9 GB) i trzeba to wpisać do manifestu.
