# P276 — pozostałe koszty z P275 §5: liczniki kolejek, reaper runów, ręczny dispatch, monitor (29.10.2026)

Źródło: `docs/parity/SCOPED-CLAIM-P275-20261029.md` §5. Gałąź `worktree-agent-af07fc65df55142c0` = `goal/full-base-20261017`
(`d3dfa1d`) + 7 commitów p275 (cherry-pick, jeden konflikt w `tests/scale-load.test.mjs` rozwiązany przez zachowanie obu
testów). Commity p276:

- test (czerwony): `tests/queue-counters276.test.mjs`, dwa testy monitora w `tests/scale-load.test.mjs`;
- przygotowana migracja 276 (`server/276_automation_runs_queued_job.sql`, niezarejestrowana);
- przepisanie w TS: liczniki kolejek w 11 plikach i ręczny dispatch;
- sterownik: zapytanie opóźnienia monitora co 30 s.

Integracja: `INTEGRATION-p276.md`.

## 1. Przyczyny i poprawki

### 1.1 Liczniki kolejek: `state IN ('pending','running')`

12 limitów kolejek liczy `count(*) FROM jobs WHERE state IN ('pending','running')` (pod RLS jako `dyna_app`, więc
w obrębie firmy). Predykat `state = ANY(...)` nie implikuje ani predykatu `jobs_claim` (`state='pending'`), ani
`jobs_running_lease` z 275 (`state='running'`), a indeksu z tym samym predykatem nie ma. Każde liczenie to Seq Scan całej
`jobs`, z której gotowe zadania nie są usuwane: 85 ms przy 1,02 mln wierszy.

Poprawka: `(state='pending' OR state='running')`. Każde ramię OR jest udowodnione przez jeden indeks częściowy, planer bierze
BitmapOr `jobs_claim` + `jobs_running_lease` i sprawdza RLS na kilkuset wierszach. Te same wiersze (`state` jest
`NOT NULL`, a dla NULL oba zapisy dają fałsz). Bez 275 plan zostaje tym samym Seq Scanem co dziś (zmierzone,
`drop275-1m.txt`), więc kolejność scalania nie ma znaczenia.

Przepisane miejsca: `email.ts:359`, `sms.ts:306`, `repricing-schedules.ts:102`, `automation-schedules.ts:78` i `:316`,
`odoo-catalog-sync.ts:95`, `dpd-pickup-schedules.ts:170`, `automation-local-effects.ts:64`, `supplier-schedules.ts:50`,
`shopify-fulfillment.ts:1137`, `automations.ts:43`, `customer-message-workflows.ts:99`. Liczba linii plików bez zmian.

Zostawione (lista `KEPT` w teście):
- `tracking.ts`, `source-payments.ts`, `shopify-webhooks.ts` — mają indeksy częściowe z dokładnie tym predykatem
  (`jobs_tracking_channel_active`, `jobs_source_payment_channel`, `shopify_webhook_queue`);
- `wms-lots.ts:1365` — plik należy do toru limitów WMS;
- `b2b-network.ts:332` — przypięty hashem w `server/catalog-stock-writer-coverage.ts` razem z testem odwrócenia
  (`tests/catalog-stock-writer-coverage.test.ts:80`); ręczne odświeżanie katalogu B2B, rzadkie.

`automation-local-effects.ts` jest przypięty w `tests/automation-rule-reconciliation.database.test.mjs` (`sourceSha`,
test domyślnie pomijany): re-pin z notą przeglądu, `git diff 2e35002` pokazuje tylko linię licznika.

### 1.2 Reaper `automation_runs` w `tick()` (`worker.ts:200`)

`UPDATE automation_runs r … FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state='queued'` działa w każdym
`tick()` workera ogólnego (pula `postgres`, bez RLS). Na `automation_runs` nie ma indeksu po `state` ani `job_id`, więc
reaper czyta wszystkie runy, by znaleźć kilka w toku. Przepisanie w TS nie pomaga: po stronie `jobs` stan `failed` też nie
ma indeksu, a nieudane zadania także zostają w tabeli.

Poprawka: przygotowana migracja 276, `CREATE INDEX automation_runs_queued_job ON public.automation_runs(job_id) WHERE
state='queued'`. Indeks ma tyle wpisów, ile runów w toku; reaper czyta go w całości i sonduje `jobs` po `id`.

Koszt: `state` jest w predykacie, więc zakończenie runu (`queued → done`, `automations.ts:262`) przestaje być
aktualizacją HOT. Na kopii `_02` w wycofywanej transakcji: 262 z 2 000 zakończeń HOT bez indeksu, 0 z indeksem
(`hot-02.txt`). Dlatego 276 jest osobno od 275 (275 nie kosztuje nic na ścieżce zapisu). Jeśli ten koszt jest
niepożądany, 276 można pominąć samą; reaper zostaje wtedy przy 117–147 ms na `tick()` przy 509 tys. runów.

### 1.3 Ręczny dispatch (`local-automation-routes.ts:142`)

`SELECT j.* FROM jobs j JOIN order_events e ON e.id=(j.payload->>'eventId')::uuid WHERE j.tenant_id=$1 AND
j.kind='automation' AND j.payload->>'orderId'=$2 …`. Wzorzec z p275 (rzutowanie z payloadu w złączeniu pod RLS), ale
główny koszt to strona `jobs`: żaden indeks nie prowadzi do zadań dyspozytora jednego zamówienia, więc plan czyta zadania
firmy. Sama projekcja `LATERAL(… OFFSET 0)` jak w p275 nic nie daje (zmierzone: 77 → 77 ms).

Poprawka: zapytanie zaczyna od zdarzeń `order.paid` zamówienia (indeks `(tenant_id, order_id, id)`) i sonduje `jobs` po
`(tenant_id, dedup_key) = (e.tenant_id, 'event:'||e.id)` z `LATERAL(… OFFSET 0)`, więc złączenie jest Var = Var
(`texteq` jest leakproof) i schodzi do `jobs_tenant_id_dedup_key_key`. Oba wstawienia zadań dyspozytora
(`server/events.ts:88` i `:146`) zapisują `dedup_key = event:<id>`; w SQL (`server/*.sql`) zadań `automation` nie
wstawia nikt. Wszystkie warunki payloadu zostają (`orderId`, `eventId`, `rules @>`), więc wynik jest podzbiorem dawnego,
a przy tym kluczu równy mu. Unikalność `(tenant_id, dedup_key)` daje co najwyżej jedno zadanie na zdarzenie, jak
oczekuje `ensure(jobs.length===1)`.

### 1.4 Monitor sterownika: zapytanie opóźnienia (`tools/scale/load/run.mjs`)

`… FROM automation_runs r JOIN orders o … WHERE r.rule_id=ANY($1) AND r.finished_at > $2` co 1 s. Na `finished_at` nie ma
indeksu; plan przechodzi zamówienia firm i sonduje runy: 6 ms przy 51 tys. runów, 134–139 ms przy 509 tys. Indeks
produkcyjny dla narzędzia pomiarowego nie jest uzasadniony, a ograniczenie po `created_at` gubiłoby runy z długą kolejką
(czyli właśnie to, co metryka mierzy).

Poprawka (jak próbka kolejki z p275): zapytanie co 30 s, a co 1 s w czasie drenażu i z `--hold` (`lagDue` w
`lib.mjs`). Kursor `finished_at > lastLag` nie gubi żadnego runu przy rzadszym odczycie. Wiersze `lag` niosą
`finished_ms`, a `summarizeMonitor` przypisuje opóźnienie do fazy po czasie zakończenia (wiersze bez tego pola, sprzed
p276, po czasie próbki), więc 30-sekundowa próbka na granicy faz dzieli się poprawnie. Koszt: 139 ms co 30 s zamiast co
1 s. README sterownika opisuje nową częstotliwość.

## 2. Przed / po

`EXPLAIN (ANALYZE, BUFFERS)`, `jit=off`, na ciepło, kopie z p275 w `dyna-scale-pg18`:
`dynaminds_p275perf_20261029_02` (102 511 jobs, 50 899 runów) i `_01` (1 018 531 jobs, 508 909 runów). Obie mają już
`jobs_running_lease` (275); 276 tworzone w wycofywanej transakcji (`-v with276=1`), brak 275 symulowany `DROP INDEX` w
wycofywanej transakcji (`-v drop275=1`). Liczniki i dispatch jako `dyna_app` z tenantem C (`f73e2008…`, 20 404 / 204 052
jobs firmy); reaper i monitor jako `postgres`, jak pula workera i monitor. Skrypt `explain.sql`.

| zapytanie | 102 tys. przed | 102 tys. po | 1,02 mln przed | 1,02 mln po |
|---|---|---|---|---|
| licznik kolejki (10 miejsc, np. `email.ts:359`) | 12,2 ms | 0,96 ms | 73,6 ms | 0,22 ms |
| licznik z `id<>$1` (`automation-schedules.ts:316`) | 10,8 ms | 0,97 ms | 68,0 ms | 0,22 ms |
| licznik Shopify fulfillment (`shopify-fulfillment.ts:1137`) | 10,7 ms | 0,93 ms | 68,6 ms | 0,14 ms |
| licznik wiadomości klientów (`automations.ts:43`, `customer-message-workflows.ts:99`) | 16,1 ms | 0,97 ms | 235 ms | 12,6 ms |
| licznik bez 275 (przepisany) | — | — | 70,7 ms | 71,5 ms (bez zmian) |
| reaper `automation_runs` (`worker.ts:200`), z 276 | 13,3 ms¹ | 0,02 ms | 117–147 ms | 0,015 ms |
| ręczny dispatch (`local-automation-routes.ts:142`) | 10,9 ms | 0,05 ms | 70,7 ms | 0,045 ms |
| monitor: opóźnienie | 6,4 ms co 1 s | 6,4 ms co 30 s | 134–139 ms co 1 s | ~139 ms co 30 s |

Pliki: `local-builds/full-base-preview-20261017/p276-source-20261029-01/with276-100k.txt`, `with276-1m.txt`,
`drop275-1m.txt` (spokojny host). `before-*.txt` / `after-*.txt` to powtórka przy obciążonym hoście (testy PG04 i
generacja zbioru równolegle): wartości 1,3–1,6 × wyższe, te same plany. ¹ wartość z pierwszego spokojnego biegu (plik
nadpisany powtórką; w `before-100k.txt` 23,8 ms przy obciążeniu).

Licznik wiadomości klientów przy 1 mln: planer łączy BitmapOr z `jobs_tenant_id_id_key` (BitmapAnd, 1 601 bloków
indeksu), bo podplan `EXISTS` na `automation_runs` ma wysoki koszt szacunkowy. Gdy firma ma oczekujące zadania
`automation.run`, ten podplan (hashed SubPlan) czyta runy firmy — tak samo przed i po zmianie (punkt 4).

## 3. Testy i strażnicy

Klony PG04 `dynaminds_p276_20261029_NN` = `TEMPLATE dynaminds_restore_36751abef3079f3f` + `migrate()` tej gałęzi (ledger
248, `258_wz_issuer_refresh`), 275 i 276 nałożone ręcznie (`apply.cjs`). Skrypty w katalogu pomiarów.

- `tests/queue-counters276.test.mjs` (5 testów). Statyczne: każdy z 12 liczników ma formę OR; żadnego innego `count`
  po `jobs` z `state IN` poza `KEPT`; plik 276 istnieje, nie jest zarejestrowany, tworzy dokładnie jeden indeks; zapytania
  reapera i dispatchu w źródle; oba wstawienia dyspozytora w `events.ts` mają `event:${id}`. Bazowy: w wycofywanej
  transakcji 50 tys. zdarzeń `order.paid` z zadaniami dyspozytora `done`, 50 tys. zadań `automation.run` `done` z runami,
  4 runy `queued` (2 z zadaniem `failed`, 1 `pending`, 1 `running`), 7 innych aktywnych zadań, własne zdarzenie zamówienia
  z oczekującym dyspozytorem. Wymaga: reaper przez `automation_runs_queued_job` bez Seq Scan i dokładnie tyle
  zmienionych wierszy co niezależne liczenie; każdy licznik (jako `dyna_app`) przez BitmapOr `jobs_claim` +
  `jobs_running_lease` bez Seq Scan i liczba równa dawnemu zapisowi i oczekiwanej (10 / 7 / 0); dispatch przez
  `jobs_tenant_id_dedup_key_key` i dokładnie założone zadanie.
  - czerwony: bez pliku 276 i na kodzie sprzed zmiany 4/5 statycznych; bazowy na `_01` z 275+276 i starym kodem: 12 ×
    Seq Scan po `jobs` (liczby poprawne) (`red-db-276.txt`);
  - zielony: 5/5 na `_01` (`green-db-276.txt`).
- `tests/scale-load.test.mjs`: czerwony (brak eksportu `lagDue`, plik się nie importował), potem 27/27.
- Testy bez bazy p275 i pokrewne: `jobs-running-lease275`, `scoped-automation-claim275`, `scoped-automation-drain`,
  `-diagnostics`, `-lease-expiry`, `failure-job-kinds`, `ordinary-local-*`, `automation-local-effects`,
  `automation-schedule-batch-iam`, `customer-message-workflows-safety` i 10 plików z bazą (`unit-after.txt`, na `_01`):
  215/307, 90 porażek. Testy limitów kolejek przechodzą (`limit kolejki…`, `200 wiadomości…`, `kolejka pełna odracza
  due…`; w `pełna kolejka odkłada termin…` przechodzi asercja „Kolejka firmy”, pada tylko próg czasu 55 s przy 54 s biegu
  na PG04). Pozostałe porażki to środowisko gołego klonu (strażnicy DPD/Shopify, brak `shopify_fulfillment_plans`, testy
  wymagające bazy `dynaminds_test_N`, czas) i `Unexpected import ./repricing-channel` (to samo na kodzie bazowym).
  **Niepotwierdzone:** porównanie baza/po (`cmp-base.txt`, `cmp-after.txt`) jest nieważne — dwa biegi równolegle
  na PG04 dały masowe 57014, drugi zawisł przy awarii sieci 12:00–12:45.
- `run-bw.sh` (główny checkout): 438/438; ten sam zestaw w tym worktree: 438/438. `npx tsc --noEmit -p .` czysto.
- **Strażnicy** (14, `jit=off`, UTC, READ ONLY) na `_01`: `GUARDS_TRUE` przed 275/276 (`guards-01-head.json`), po 275+276
  (`guards-01-275-276.json`, generacja brudna) i po `ordinary187_approve` (`guards-01-275-276-approved.json`).

## 4. Ryzyka i co zostaje

- Liczniki zależą od 275; bez niej zysk jest zerowy, ale bez regresji. 276 jest niezależna od obu części TS.
- Wybór BitmapOr to decyzja kosztowa planera. Gdy planer dołoży BitmapAnd z indeksem tenanta (jak przy 102 tys. albo przy
  liczniku wiadomości), koszt rośnie z liczbą zadań firmy w indeksie (1,3 ms / 20 tys., 14 ms / 204 tys.), nadal bez
  czytania sterty historii. Test planu pilnuje braku Seq Scan i użycia obu indeksów częściowych.
- 276 zabiera HOT przejściu `queued → done` runu (punkt 1.2); świadoma wymiana, do decyzji integratora.
- Podplan `EXISTS` liczników wiadomości klientów czyta runy firmy, gdy czekają zadania `automation.run` (bez indeksu po
  `automation_runs.job_id`). Nie zmienione: sonda po `payload.run_id` zmieniłaby semantykę (wymagałaby zgodności
  `run_id` z `job_id`, czego schemat nie wymusza).
- `wms-lots.ts:1365` i `b2b-network.ts:332` zostają przy `state IN` (punkt 1.1).
- Monitor: przy błędzie biegu (nie drenaż) ostatnie ≤30 s opóźnień może nie trafić do `monitor.ndjson`.
