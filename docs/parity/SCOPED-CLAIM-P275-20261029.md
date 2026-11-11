# P275 — koszt przydziału zadań workera rośnie z tabelą `jobs` (29.10.2026)

Przygotowana migracja `server/275_jobs_running_lease.sql` (numer zastępczy) zintegrowana 29.10.2026 jako **migracja 259**
(`259_jobs_running_lease`, sekcja „Integracja jako 259” na końcu). Nazwa obiektu (`jobs_running_lease`) nie ma numeru.
Opisy do sekcji integracji mówią o 275 jak w czasie przygotowania.

Źródło: `docs/scale/LOAD-TEST-FULL-20261029.md` §4.6. W steady24 opóźnienie noty reguły `order.created` rosło z p50 1,1 s
do 2,9 s, a tabela `jobs` z 7 tys. do 102 tys. wierszy. Zapytanie przydziału `SELECT j.* FROM jobs j JOIN order_events e …`
miało 1 051 próbek aktywnych. Ten dokument potwierdza przyczynę na `EXPLAIN (ANALYZE, BUFFERS)` i opisuje poprawkę.

Gałąź `worktree-agent-a0cc8c47b715ffba0` od `c73d311`. Commity:

- `4d742bc`, `389c32b` — testy (czerwone);
- `dcdce56` — przepisanie zapytań przydziału w TS;
- `cd2b80e` — przygotowana migracja 275;
- `d2897e2`, `97138fe` — monitor sterownika.

## 1. Przyczyna

### Które zapytania

Test obciążenia uruchamia tylko procesor reguł (`--scoped-automation`: `dyna-load-app` i 2 × `dyna-load-worker`).
Przebieg odwiedza każdą włączoną regułę (5, po jednej na firmę) i w `claimAutomaticJob`
(`server/local-automation-worker-control.ts`) wykonuje po kolei cztery zapytania przydziału:

1. `automation.run`;
2. `automation.local_stock`;
3. `email.send`;
4. dyspozytor `automation`.

Próbki z `raw/monitor.ndjson`:

| zapytanie | próbki |
|---|---|
| dyspozytor `automation` | 1 196 |
| `automation.run` | 1 053 |
| `automation.local_stock` | 139 |

1 051 próbek z §4.6 to dyspozytor (`SUMMARY.md:208`). `server/worker.ts` (worker ogólny) w teście nie działa, ale ma ten
sam rodzaj kosztu (punkt 3).

### Mechanizm: klauzula złączenia z rzutowaniem z `j.payload` pod RLS

Zapytania działają jako `dyna_app` z wymuszonym RLS na `jobs`, `automation_runs` i `order_events`. Złączenie
`e.id=(j.payload->>'eventId')::uuid` wywołuje funkcje, które nie są leakproof (`->>`, `uuid_in`). Planer nie może więc
użyć tej klauzuli jako warunku indeksu poniżej kwalifikatorów RLS tabeli `order_events`. Dowód na kopii, ten sam zapis
w toku:

- jako `dyna_app`: Merge Join po `events_order`, 31 734 zdarzeń, 21,3 ms;
- jako superuser (bez RLS): Nested Loop z `order_events_tenant_id_id_key`, 0,08 ms.

Skutki w czterech zapytaniach:

- **Dyspozytor `automation`.** Merge join po indeksie `events_order` przechodzi zdarzenia firmy od aktywacji w kolejności
  `order_id`, aż trafi na `orderId` zadania. Przy 102 tys. jobs to 31 734 wiersze, 21 ms na ciepło (192 ms na zimno);
  przy 1,02 mln to 84 087 wierszy i 32 ms. Licznik `order_events.idx_tup_fetch` z `diag/slow.ndjson` rósł w biegu z 14 mln do
  110–122 mln na 3 minuty, łącznie 1,1 mld. To zgadza się z rosnącym `order_events` i opóźnieniem tylko w steady24.
- **`automation.run`.** Złącza runy po `(tenant_id, job_id)`, a na `automation_runs` nie ma indeksu po `job_id`. Plan
  czyta więc wszystkie runy reguły po indeksie `(tenant_id, event_id, rule_id, rule_version)` i filtruje
  `state='queued'`. Robi to przy każdej wizycie, także gdy nic nie czeka:
  - 102 tys. jobs: 10 202 runy, 6 391 bloków, 17,4 ms;
  - 1,02 mln jobs: 102 021 runów, 27 444 bloki, 56–59 ms.
- **`automation.local_stock`.** Ta sama blokada na `r.id=(j.payload->>'run_id')::uuid`. Gdy czeka zadanie stanu, plan
  czyta wszystkie zakończone runy reguły; bez takiego zadania kosztuje 0,05 ms.
- **`email.send`.** Złącza Var = Var, więc tego problemu nie ma.

Gotowych zadań się nie usuwa. Zapytania przydziału przez `jobs_claim` (`WHERE state='pending'`) i tak ich nie widzą.
Koszt rośnie przez `order_events` i `automation_runs`, które rosną razem z `jobs`.

## 2. Poprawka

### 2.1 TS: identyfikatory z `LATERAL(… OFFSET 0)` (`dcdce56`)

`CROSS JOIN LATERAL(SELECT (j.payload->>'eventId')::uuid event_id, … OFFSET 0)x` rzutuje identyfikatory w podzapytaniu,
którego planer nie spłaszcza. Złączenia stają się Var = Var (`uuid_eq` jest leakproof) i schodzą do indeksu:

- dyspozytor: `order_events` po `(tenant_id, order_id, id)`;
- `automation.run` i `automation.local_stock`: `automation_runs_pkey` po `x.run_id`.

Warunki na samym zadaniu, kolejność, `FOR UPDATE OF j SKIP LOCKED` i liczba linii pliku są bez zmian.

`automation.run` złącza teraz run z payloadu, który dodatkowo wskazuje to zadanie: `(r.id, r.job_id)=(x.run_id, j.id)`.
`dispatchAutomation` zapisuje oba pola. W danych biegu żadna z 50 899 par się nie różni, a duplikatów `job_id` jest 0.
Różnica pojawia się tylko przy uszkodzonych danych, gdy payload wskazuje inny run niż `job_id`:
- dawniej przydział rzucał 409 „Niezgodny run/job” przy każdej wizycie, więc reguła stała;
- teraz takie zadanie jest pomijane i zostaje `pending` (widoczne w liczbach zadań reguły).

W obu przypadkach zadanie się nie wykona.

### 2.2 Przygotowana migracja 275 (`cd2b80e`, niezarejestrowana)

```sql
CREATE INDEX jobs_running_lease ON public.jobs(id) WHERE state='running';
```

Indeks obsługuje dwa zapytania o trzymane dzierżawy, które czytały całą `jobs`:

- reaper na początku każdego `tick()` workera ogólnego (`server/worker.ts:134`): do 10 razy na sekundę, gdy worker
  przydziela zadania;
- `expireAutomationLeases()` (`server/automations.ts:341`): co 30 s na proces procesora reguł.

Kluczem jest `id`, które się nie zmienia, a nie `locked_at`. Dzięki temu odnowienia dzierżawy, które ustawiają tylko
`locked_at` (synchronizacje dostawców, raz na stronę), zostają HOT. Zmiany `state` nie były HOT już wcześniej, bo `state`
jest w predykacie `jobs_claim`. Na `automation_runs` świadomie nie dodano indeksu. Indeks z `state` w predykacie
odebrałby HOT przejściu `queued → done` każdego runu, a reaper `automation_runs` (`worker.ts:200`, 142 ms przy 509 tys.
runów) działa tylko w workerze ogólnym (punkt 5).

Retencji gotowych zadań nie wprowadzono. Wiersze `jobs` to historia prób: odczytują je runy, plany, panel workera
i 42 klucze obce. Usuwanie danych to decyzja Artura, a dla przydziału nie jest potrzebne.

### 2.3 Monitor sterownika (`97138fe`)

`count … FROM jobs WHERE created_at >= …` co 1 s to równoległy skan całej `jobs`. Na `created_at` nie ma indeksu, a gotowe
zadania zostają w tabeli. Zmiana w `tools/scale/load/lib.mjs` (`queueSample`, `queueDrained`) i `run.mjs`:

- co 1 s liczone są tylko oczekujące zadania z `jobs_claim` (index-only scan);
- co 30 s, a w czasie drenażu co 1 s, idzie pełne liczenie po stanach (`full: true`);
- drenaż kończy tylko pełna próbka, bo próbka samych oczekujących nie widzi `running`.

`summarizeMonitor` czyta `pending` i `oldest_pending_s`, a oba pola są w obu rodzajach próbek.

## 3. Przed / po

Pomiary: `EXPLAIN (ANALYZE, BUFFERS)` jako `dyna_app` z ustawionym tenantem, `jit=off`, na ciepło.

Kopie w `dyna-scale-pg18`:
- `dynaminds_p275perf_20261029_02` = `TEMPLATE dynaminds_scale_20261029_81` (przy 0 połączeń): 102 511 jobs,
  50 899 runów, 315 378 zdarzeń;
- `_01` = to samo plus 9 kopii każdego łańcucha `order.created` biegu (`gen-1m.sql`, wszystkie `done`): 1 018 531 jobs,
  508 909 runów, 773 388 zdarzeń. Kopiowane są tylko zdarzenia `order.created`. W prawdziwym zbiorze 1 mln zdarzeń
  byłoby ~3 razy więcej, więc wartości „przed” dla dyspozytora są zaniżone.

Stan „w toku” (`inflight-setup.sql`, w transakcji wycofywanej) to najnowsze zadanie dyspozytora `pending` oraz jeden run
`queued` z zadaniem `pending`. Firma `f73e2008…` (C), reguła `21f1e7a1…`.

| zapytanie | 102 tys. przed | 102 tys. po | 1,02 mln przed | 1,02 mln po |
|---|---|---|---|---|
| przydział `automation.run`, nic nie czeka (każda wizyta) | 17,4 ms (zimno) | 0,11 ms | 56,5 ms | 0,10 ms |
| przydział `automation.run`, run w toku | 10,7 ms | 0,13 ms | 58,6 ms | 0,11 ms |
| przydział dyspozytora, zadanie w toku | 21,3 ms (192,6 zimno) | 0,40 ms | 32,1 ms | 0,08 ms |
| `automation.local_stock` / `email.send` (brak zadań) | 0,05 / 0,04 ms | 0,03 ms / bez zmian | 0,06 / 0,03 ms | 0,04 ms / bez zmian |
| reaper `tick()` (`worker.ts:134`), z 275 | 51,8 ms | 0,05 ms | 229,7 ms | 0,04 ms |
| `expireAutomationLeases` (stale), z 275 | 22,0 ms | 0,02 ms | 145,8 ms | 0,02 ms |
| monitor: liczenie `jobs` co 1 s | 18,5 ms | 0,10 ms (+17 ms co 30 s) | 98,0 ms | 0,14 ms (+106 ms co 30 s) |

Pliki (EXPLAIN-y, skrypty, strażnicy): `local-builds/full-base-preview-20261017/p275-source-20261029-01/`.

Przy 5 regułach i 3 procesach jedna wizyta `automation.run` kosztowała przy 1 mln jobs ~56 ms. Daje to ok. 0,85 s
pracy bazy na sekundę przebiegów bez pracy, nie licząc dyspozytora. Po poprawce to ~1,5 ms.

## 4. Testy i strażnicy

Klony PG04 `dynaminds_p275_20261029_NN` = `TEMPLATE dynaminds_restore_36751abef3079f3f` + `migrate()` tej gałęzi
(ledger 248, `258_wz_issuer_refresh`). Skrypty: `…/scratchpad/p275/base.sh`, `dbtest.sh`, `apply.cjs`.

- `tests/scoped-automation-claim275.test.mjs`. Część statyczna sprawdza zapytania przydziału w źródle. Część na klonie
  w wycofywanej transakcji zakłada 200 tys. zdarzeń i 50 tys. łańcuchów reguły (jak bieg 29.10), potem jako `dyna_app`
  wymaga sondy po `id` w każdym skanie `order_events` i `automation_runs` oraz przydziału dokładnie założonych zadań.
  - na źródle HEAD 2/4 (dwa razy, `red-claim275.txt`, `red2-claim275.txt`): `automation_runs` i `order_events` przez Seq
    Scan;
  - po `dcdce56` 4/4.
  - Przy 5 tys. łańcuchów skan runów reguły jest naprawdę tańszy i planer go wybiera, dlatego objętość jest jak w biegu.
- `tests/jobs-running-lease275.test.mjs`: 1/3 bez 275 (reaper przez Seq Scan), 3/3 z 275 nałożonym ręcznie na `_01`.
- `tests/scale-load.test.mjs`: czerwony bez eksportów (plik się nie importował), potem 24/24.
- `tests/scoped-automation-drain.database.test.ts` (koniec do końca: dyspozytor → run → nota, restart, dwa procesory,
  utracona dzierżawa) na świeżym `_02` z `dcdce56`: 2/2 (651 s, `drain-02.txt`). Regex rodziny
  klonów dostał `p275_20261029`.
- Testy bez bazy: `scoped-automation-drain|diagnostics|lease-expiry`, `automation-local-effects`, `failure-job-kinds`:
  48/48. `npx tsc --noEmit -p .` czysto.
- **Strażnicy** (14: dziesięciu, `warehouse_wz_issuer_guards`, `email_inbound_guards`, `catalog_stock_control_guards`,
  `financial_return_guards`; `jit=off`, UTC, READ ONLY) na `_01`: `GUARDS_TRUE` w trzech stanach:
  - przed 275 (`guards-01-head.json`);
  - po 275 (`guards-01-275.json`, generacja brudna);
  - po `ordinary187_approve` (`guards-01-275-approved.json`).

  Indeks na `jobs` nie psuje żadnego strażnika.

## 5. Ryzyka i co zostaje

- (W czasie przygotowania) 275 nie była zarejestrowana; od integracji to migracja 259. Poprawka TS działa bez niej.
- `OFFSET 0` jako bariera optymalizacji to ustalone zachowanie PostgreSQL, ale nie jest gwarancją. Test planu na klonie
  pilnuje, że sonda po `id` zostaje.
- Plan zależy od kosztów. Przy małej liczbie runów reguły planer może zacząć od `automation_runs`, co przy małych
  tabelach jest tanie. Przydział jest ograniczony liczbą oczekujących zadań w `jobs_claim`, w tym starymi `pending`
  innych firm (597 w zbiorze).
- Poza zakresem, nie zmienione:
  - liczniki `state IN ('pending','running')` (limity kolejek w `email.ts:359`, `automation-local-effects.ts:64`,
    `automation-schedules.ts:78`, …) nadal skanują `jobs`: 85 ms przy 1 mln. `= ANY` nie łączy dwóch indeksów
    częściowych; zapis `state='pending' OR state='running'` z 275 dałby BitmapOr;
  - reaper `automation_runs` w `worker.ts:200` (142 ms przy 509 tys. runów, worker ogólny);
  - zapytanie opóźnienia w monitorze (`automation_runs` co 1 s, 17–164 ms);
  - ręczny `dispatch` w `local-automation-routes.ts:142` (ten sam wzorzec, jednorazowy);
  - ~2 dodatkowe skany `jobs` na sekundę w steady24 spoza monitora (§4.6) nie są przypisane: niepotwierdzone.

## Integracja jako 259 (29.10.2026)

Wzorzec 253 (indeks na istniejącej tabeli). Siedem commitów przygotowania (4d742bc…d979d07 z
`worktree-agent-a0cc8c47b715ffba0`) przeniesione cherry-pickiem (4217894…afcf051). Jeden konflikt: `tests/scale-load.test.mjs`
— test podglądu faktury 230 z HEAD (d3dfa1d) i dwa testy monitora z toru stoją obok siebie. Potem commity integracji
(239aee9 testy, 0b567e8 migracja, 60ac80e poprawka testu planu, niżej) i ten dokument.

- SQL: `server/275_jobs_running_lease.sql` → `server/259_jobs_running_lease.sql`; zmienia się tylko pierwsza linia komentarza
  („Migration 259_jobs_running_lease (prepared as 275, registered after 258_wz_issuer_refresh; …)”); 1 376 B, sha256
  `8f8916b2798b98c5a0eef182ad590b47e24cbd69284e8b485cd7d944f63b4524`.
- Wiersz manifestu `259_jobs_running_lease` (`native_id` `jobs_running_lease259`, kontrakt `jobs-running-lease259`) po 258;
  `server/db.ts` bez zmian.
- Zimny katalog: kompilacja na `dynaminds_m259_20261029_01` (szablon + 218…258 + ledger; poprzednik = skompilowany after258
  `96d34764…2b831e2b`): jeden indeks, jak przewidywał tor, czyli **3 rekordy dodane** (indeks `public.jobs_running_lease` na
  `jobs`, `USING btree (id) WHERE (state = 'running'::text)`; jego relacja rodzaju `i`, właściciel `postgres`; jego kolumna
  `id uuid`), **0 zmian** (rekord tabeli `jobs` nie wymienia indeksów), 0 usunięć; after259 `f06d7569…e93462ad` (46 993
  rekordy); czternastu strażników true przed i po. `jobs-running-lease259-source-contract.mjs`,
  `jobs-running-lease259-source-compatibility.mjs` (`projectCompiledJobsRunningLease259Catalogue`, ogólna postać 258 z łańcuchem
  przesuniętym o jeden; footprint: nazwa `jobs_running_lease` zaraz po kropce schematu — indeks 249
  `catalog_ai_image_jobs_running` jej nie pasuje), jedna linia w `release-cold-projectors.mjs`. Kompilator (wiersze manifestu
  218…N, `EXTRA_GUARDS` dla 261) i wyniki: `local-builds/full-base-preview-20261017/m259-source-20261029-01/`.
- Ledger 249 (guard: przyszłe `260_…`, `261_…`); MIG-2 stosuje 244…259; MIG-1 i MIG-4 oczekują serii 244…259 (259 nie dodaje
  tabeli, MIG-1 liczy dalej 10); 258 nie jest już ostatnia; rodzina `m259` w testach DB 236…258, installation-identity,
  settlement report, MIG-1/2/4 i worker-supervision; test planu przydziału (`scoped-automation-claim275.test.mjs`) i drain
  przyjmują też klony m259…m261. MIG-1/2/4 uruchamiane raz po 261.
- Testy: `tests/jobs-running-lease259.test.mjs` (było `jobs-running-lease275`; przypięcie wiersza manifestu zamiast „prepared,
  not registered”, test planu na klonie po prawdziwym `migrate()`), `tests/jobs-running-lease259-source-compatibility.test.mjs`
  (7, ostatni opt-in).
- **Test planu (60ac80e).** Na pierwszym świeżym klonie `_02` test planu dał raz 3/4: „reaper: Bitmap Heap Scan:”. Planer
  wybrał skan bitmapowy `jobs`, a test czytał nazwę indeksu tylko z węzła `jobs`, której Bitmap Heap Scan nie ma (ma ją jego
  dziecko Bitmap Index Scan). Ten sam test: 4/4 trzy razy na `_03`, 4/4 na nowym `_04` i 4/4 starym testem na nowym `_05`
  (Index Scan using `jobs_running_lease`); na `_02` po pozostałych testach 4/4. Wybór zależy od statystyk w danej chwili.
  Test liczy teraz Bitmap Heap Scan jako skan indeksów nazwanych przez dzieci; asercja (każdy skan `jobs` przez
  `jobs_running_lease`, bez Seq Scan) bez zmian. Planu bitmapowego nie udało się powtórzyć, więc nazwa jego indeksu jest
  niepotwierdzona; poprawiony test nazwie ją przy następnym takim planie.
- `INTEGRATION-p275.md` usunięty (treść tutaj).

| Sprawdzenie (PG04, klony `dynaminds_m259_20261029_NN`; wyniki w `m259-source-20261029-01/tests/`) | Wynik |
|---|---|
| `_02` świeży klon na 0b567e8, prawdziwe `migrate()` | ledger 249, ostatnia `259_jobs_running_lease` |
| strażnicy na `_02` (jit=off, UTC; `guards-A-02.json`) | dziesięciu + `warehouse_wz_issuer_guards` + `email_inbound_guards` + `catalog_stock_control_guards` + `financial_return_guards` = true |
| inspekcja zimna na `_02` (`cold-A-02.json`) | COLD_INSPECTION_PASSED, `native_catalogue_sha256` = after259 `f06d7569…`, flagi `*_active` 216…259 true, tryb 209 `active209_inverse` |
| `tests/jobs-running-lease259.test.mjs` (`_02` / `_03` ×3 / `_04` / `_05` / `_02` po testach) | 3/4 (plan bitmapowy, wyżej) / 4/4 / 4/4 / 4/4 / 4/4 |
| `tests/scoped-automation-claim275.test.mjs` (`_02`) | 4/4 |
| `tests/scoped-automation-drain.database.test.ts` (`_02`) | 2/2 (1 424 s przy obciążeniu PG04); strażnicy po testach true |
| bez bazy: zestaw jak przy 258 + `jobs-running-lease259`, zgodność 259, `scoped-automation-claim275`, `scale-load` i testy 255–258 | 641/649, 8 pominiętych opt-in, 0 czerwonych |
| `tests/jobs-running-lease259-source-compatibility.test.mjs` z opt-in na prawdziwych katalogach 259 | 7/7 |
| `npx tsc --noEmit -p .` | czysto |
