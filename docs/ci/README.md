# CI — GitHub Actions

Repo docelowe: publiczne `B2B-net-S-A/dynaminds-ecommerce`, standardowe runnery `ubuntu-latest`
(4 vCPU / 16 GB, minuty w publicznym repo są darmowe). Wzór: CI NEXUSA (`ci-gate.yml`, `ci.yml`,
`auto-enqueue.yml`). Wszystkie akcje są przypięte do SHA; Dependabot podbija je co tydzień.

## Workflowy

| Plik | Kiedy | Co robi |
|---|---|---|
| `.github/workflows/ci-gate.yml` („CI Gate”) | push na `main`, PR, kolejka merge'ów | Szybka bramka (cel ≤ ~5 min): gitleaks (drzewo + każdy commit PR-a/grupy), `tsc --noEmit`, lint źródeł (`tests/failure-job-kinds.test.ts`, `tests/sql-text-lint.test.ts`), wszystkie testy klasy `static` bez bazy w 3 równoległych częściach (podział po czasach), klasa `darwin` w jobie `Static tests (macOS zlib)` na `macos-15`, testy `web/*.test.mjs`. |
| `.github/workflows/ci.yml` („CI”) | PR, kolejka merge'ów, co noc 01:17 UTC (`schedule`), ręcznie (`workflow_dispatch`) | Testy z bazą (klasa `db`). PR: sito — testy db najbliżej zmiany, do 40 plików i `CI_DB_PR_BUDGET_MIN` szacowanych minut, 1–3 shardy. Kolejka: to samo sito, do 120 plików i `CI_DB_QUEUE_BUDGET_MIN`, do `CI_DB_MAX_SHARDS` shardów po ≤ ~35–40 min. Noc i ręczny bieg: pełny zestaw w `CI_DB_MAX_SHARDS` shardach (limit 180 min na shard), czerwony nocny bieg otwiera issue „Nocny pełny bieg testów db nie przeszedł” (job „Nightly DB alert”), zielony je zamyka. Pełny zestaw biegnie tylko w nocy i na żądanie, nigdy na PR-ze ani w kolejce (decyzja 12.11.2026). Zmiana w `server/db.ts`, migracjach `server/*.sql` albo runnerze/manifeście migracji dokłada do sita pakiet migracji, a zmiana `package*.json`, `tsconfig.json`, `scripts/ci/` albo `ci.yml` — zestaw dymny i pakiet migracji (patrz „Pakiet migracji i zestaw dymny”). Każdy shard: PostgreSQL `postgres:18.4-trixie` (service), losowe `dbPassword`/`encryptionKey` w `$RUNNER_TEMP`, osobna baza na plik. |
| `.github/workflows/auto-enqueue.yml` | zdarzenia PR-a | Gotowy PR (nie-draft, bez `wstrzymaj`, nie Dependabot) dostaje `gh pr merge --squash --auto`; `wstrzymaj` albo draft zdejmuje go z kolejki. |
| `.github/workflows/uptime-probe.yml` | co godzinę (cron), ręcznie | `GET <DEMO_URL>/api/health` → HTTP 200 i `status: "ok"`. Awaria otwiera issue (albo komentuje otwarte), zielony bieg je zamyka. |
| `.github/dependabot.yml` | co tydzień (pon. 06:00) | npm i github-actions; minor+patch zgrupowane w jeden PR. |

Workflow wdrożenia demo jest osobny (inny tor prac) i nie korzysta z tych plików.

## Wymagane checki do rulesetu `main`

Nazwy jobów są stałe — ruleset wiąże się z nimi dosłownie:

- `Gitleaks secret scan`
- `Typecheck`
- `Lint + static tests` — job zbiorczy w `ci-gate.yml` (zależy od `Static tests (part N/3)` i `Static tests (macOS zlib)`); części nie idą do rulesetu.
- `Web tests`
- `DB tests` — job zbiorczy w `ci.yml`. Shardy (`DB tests (shard N)`) i plan (`DB tests (plan)`) **nie**
  idą do rulesetu: ich liczba zmienia się z planem.

Kolejka merge'ów musi być włączona dla `main` (wszystkie workflowy reagują na `merge_group`).
W rulesecie ustaw limit czasu checków („Status check timeout” kolejki) na co najmniej 90 min: grupa kończy sito
w ~35–40 min, shard ma limit 60 min, a do tego dochodzą plan, czekanie na wolne runnery i job zbiorczy.
Pełny zestaw nie biegnie w kolejce (decyzja 12.11.2026), więc wydłużony limit 180 min nie jest już potrzebny.

Dlaczego PR i kolejka nie biegną pełnym zestawem (decyzje 11.11.2026 i 12.11.2026): pełny zestaw db to wg
szacunku ~3 100 min pracy (z cache strażników i dwoma plikami naraz: ~57 min na 20 shardach, „Czasy shardów”). PR i kolejka sprawdzają testy najbliżej zmiany —
także przy zmianie `server/db.ts`, migracji czy `package*.json` — a całość biegnie co noc i na żądanie
(`workflow_dispatch`); błąd spoza sita wychodzi najpóźniej następnego ranka jako issue.
`ci.yml` nie biegnie na `push: main` — kolejka testuje dokładnie to drzewo, które trafia na maina.
Gdyby kolejkę wyłączyć, trzeba dodać `push: branches: [main]` w `ci.yml`.

### Pakiet migracji i zestaw dymny

Zmiany, które mogą zepsuć dowolny test, nie przełączają sita na pełny zestaw. Kolejność wyboru (pierwsze
wchodzą, dopóki starczy `--limit` plików i `--budget-min` minut):

1. zmienione pliki testów db,
2. dla migracji `server/NNN_*.sql` (albo `…NNN.sql`): testy db z `NNN` w nazwie,
3. zestaw dymny — tylko przy zmianie `package*.json`, `tsconfig.json`, `scripts/ci/`, `ci.yml`: 10 najszybszych
   plików db (czas z `scripts/ci/test-durations.json`, bez pomiaru szacunek `estimateSec`),
4. pakiet migracji — przy zmianie `server/db.ts`, `server/*.sql`, runnera/manifestu migracji i przy zmianach
   z punktu 3: testy db z `migration`, `ledger`, `source-compatibility`, `cold`, `guard` w nazwie (ledger,
   zgodność migracji i źródeł, strażnicy pieczęci), potem `*-contract*` (`MIGRATION_BUNDLE` w skrypcie),
5. reszta powiązanych testów (graf importów, najbliższe najpierw).

Pakiet ma dziś 28 plików db (~113 min szacunku): na PR-ze (40 plików / 75 min) wchodzi jego część, w kolejce
(120 plików / 600 min) całość. Reszta i tak biegnie w nocy.

## Sekrety i zmienne

Sekrety (tylko nazwy):

- `QUEUE_BOT_TOKEN` — fine-grained PAT do tego repo: Contents + Pull requests: Read and write.
  Bez niego `auto-enqueue.yml` tylko ostrzega i nic nie robi. `GITHUB_TOKEN` nie wystarcza: zdarzenia
  z niego nie uruchamiają `merge_group`, więc grupa wisiałaby bez testów.

Hasła bazy w CI nie są sekretami repo: każdy shard generuje je losowo na runnerze i maskuje w logu.

Zmienne repo (opcjonalne, Settings → Secrets and variables → Actions → Variables):

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `DEMO_URL` | `https://demo.dynaminds.pl` | adres sondy uptime |
| `CI_DB_MAX_SHARDS` | `20` | górny limit shardów kolejki i pełnego zestawu (darmowy plan: 20 jobów naraz) |
| `CI_DB_PR_BUDGET_MIN` | `75` | budżet szacowanych minut sita PR-a (3 shardy po ~30 min z narzutem) |
| `CI_DB_QUEUE_BUDGET_MIN` | `600` | budżet szacowanych minut sita kolejki (20 shardów po ~35 min) |
| `CI_DB_TARGET_MIN` | `35` | docelowy czas sharda z narzutem joba |
| `CI_DB_CONCURRENCY` | `2` | ile plików db naraz w jednym shardzie (każdy na swojej bazie; runner ma 4 vCPU) |
| `CI_FILE_TIMEOUT_MIN` | `45` | limit na jeden plik testu db; po nim proces jest zabijany |

## Klasy testów

`node scripts/ci/classify-tests.mjs` dzieli `tests/*.test.*` (pliki śledzone przez gita) na cztery klasy:

- **static** — bez bazy. Plik nie ma żadnego sygnału bazy: nazwa `*.database.test.*`, import `server/db`,
  `DATABASE_URL`, pakiet `pg`, `migrate()`, `scripts/test.ts`, ani import helpera z `tests/`, który go ma.
  W CI biegną z `DATABASE_URL` na zamkniętym porcie — test, który jednak sięgnie do bazy, pada od razu.
- **db** — zwykła baza na plik. Nazwa bazy `dynaminds_test_<13 cyfr>` (spełnia strażników
  `^/dynaminds_test_\d+$` i `[0-9]{13}` w testach), port 55432, `DYNA_TEST=true`.
  Baza to kopia szablonu zmigrowanego raz na shard (`CREATE DATABASE … TEMPLATE`, ~3 s zamiast ~1–2 min
  `migrate()` na plik); po kopii CI odtwarza ACL bazy z migracji 262 (TEMPLATE go nie kopiuje).
  Plik, który musi sam migrować pustą bazę, wpisz do `freshDatabase`.
- **darwin** — static, ale przypina bajty, które powstają tylko na macOS: sumy wyniku `gzipSync` (zlib na
  Linuksie wpisuje w nagłówek gzip bajt OS 3 zamiast 19, strumień deflate jest ten sam). Tylko ręcznie, wpis
  `darwin` w konfiguracji; biegną w jobie `Static tests (macOS zlib)` na `macos-15`, części Linux ich nie dostają.
- **special** — pomijane w CI, z powodem w podsumowaniu każdego biegu. Automatycznie: plik wymaga klastra
  na innym porcie niż 55432 (asercja portu, np. klony PG04 na 57084), bazy o konkretnej nazwie (asercja
  `pathname` adresu bazy, np. `dynaminds_m236_…`), albo prywatnej zmiennej (`assert(process.env.X…)`
  poza `DYNA_TEST`, `DATABASE_URL`, `DYNA_TEST_PG_PORT`, `DYNA_LOCAL_CONFIG_PATH`). Ręcznie: wpisy
  `special` i `quarantine` w konfiguracji.

### Ręczne wyjątki — `scripts/ci/test-classes.json`

```json
{
  "ciDatabasePort": 55432,
  "special":      { "tests/x.test.ts": "powód: czego wymaga" },
  "quarantine":   { "tests/y.test.ts": "pada na main od <commit>: <objaw>" },
  "darwin":       { "tests/u.test.mjs": "przypina bajty z macOS: co i gdzie" },
  "db":           { "tests/z.test.ts": "wymuś db mimo braku sygnału" },
  "static":       { "tests/w.test.ts": "wymuś static" },
  "freshDatabase":{ "tests/v.test.ts": "migruje pustą bazę sam" },
  "noGuardCache": { "tests/t.test.ts": "liczy wywołania strażników: bez cache strażników" }
}
```

Wpis ręczny wygrywa z regułami. Ścieżka musi istnieć — po usunięciu testu skrypt każe usunąć wpis.

**Jak dodać test special:** dopisz plik do `special` z powodem (czego wymaga: klon PG04, port, zmienna)
i sprawdź `node scripts/ci/classify-tests.mjs`. Jeśli test sam asertuje port/nazwę bazy/zmienną,
klasyfikator wykryje go bez wpisu. **Kwarantanna** jest dla testu, który pada na mainie z powodu
niezwiązanego z CI: wpis w `quarantine` z commitem i objawem, a naprawa idzie osobnym zadaniem —
po naprawie wpis usuń. Od 12.11.2026 w kwarantannie jest 155 plików db: 153 czerwone w pełnym biegu 43322230795 i 2 niestabilne bez oznaki czasu
(decyzja Artura: kwarantanna i naprawa w osobnych sesjach); przy każdym wpisie plik:linia i objaw pierwszego padu.

## Skrypty

| Skrypt | Do czego |
|---|---|
| `scripts/ci/classify-tests.mjs` | podsumowanie; `--list static\|db\|darwin\|special`; `--json`; `--why` (sygnał, który przesądził o db) |
| `scripts/ci/shard.mjs` | podział listy na N shardów (LPT po czasach z `scripts/ci/test-durations.json`, bez czasów round-robin); `--plan --target-min M --max K` wylicza N |
| `scripts/ci/select-pr-tests.mjs` | sito PR-a i kolejki z `git diff --name-only` (domyślnie `origin/main...HEAD`, albo `--range A..B`): zmienione testy db + testy importujące zmienione moduły albo nazwane od nich (graf importów wstecz, najbliższe najpierw; `--limit` plików, `--budget-min` szacowanych minut). Zmiana w `server/db.ts`, `server/*.sql`, runnerze/manifeście migracji → najpierw pakiet migracji; `package*.json`, `tsconfig.json`, `scripts/ci/`, `ci.yml` → zestaw dymny i pakiet migracji. Nigdy pełny zestaw; testy: `tests/ci-select-pr-tests.test.mjs` |
| `scripts/ci/run-tests.mjs` | uruchamia pliki po jednym procesie `tsx --test`, logi per plik, `summary.txt`, `failed.txt`, `durations.json`; `--kind db` zakłada i sprząta bazy, a plik padnięty na czasie (`statement timeout`/57014, także jako 503 API „Operacja trwała zbyt długo”, `lock timeout`/55P03, `test timed out`; nie limit pliku 45 min ani plik, który trwał już ponad jego trzecią część) puszcza drugi raz, sam, na nowej bazie — zielony za drugim razem liczy się jako zielony, ale trafia do `flaky.txt`, do Step Summary („Niestabilne”) i do artefaktu `db-failed-logs-shard-N` jako `<plik>.attempt1.log` (decyzja 13.11.2026: testy czekania na blokadę i limitu zapytania padają losowo przy dwóch plikach naraz) |
| `scripts/ci/migrate-database.ts` | `migrate()` na bazie-szablonie shardu |
| `scripts/ci/guard-cache.mjs` | cache odpowiedzi strażników schematu, ładowany tylko przez `run-tests.mjs --kind db` (niżej); testy: `tests/ci-guard-cache.database.test.ts` |

Lokalnie (bez portu 55432 — tam stoi lokalna baza aplikacji):

```bash
node scripts/ci/classify-tests.mjs
node scripts/ci/select-pr-tests.mjs --range origin/main...HEAD
DYNA_TEST_PG_PORT=57361 DYNA_LOCAL_CONFIG_PATH=<plik z dbPassword> \
  node scripts/ci/run-tests.mjs --kind db --out /tmp/ci-db tests/<plik>.test.ts
```

## Cache strażników (tylko CI)

Bez bramki startowej każdy `tenantTx` i każdy `buildApp` w teście woła od nowa natywnych strażników schematu
(`server/db.ts` `preflightUngatedTenantSchema`, ~70 sond w `server/app.ts`); jeden strażnik to 2–5 s na
zmigrowanej bazie. Bieg 43121830853 bez cache w 180 min skończył 83 z 367 plików. `run-tests.mjs --kind db`
ładuje więc `scripts/ci/guard-cache.mjs` (`NODE_OPTIONS=--import`): zapytanie w kształcie strażnika
(`SELECT f() alias[, …]`, funkcje bez argumentów) biegnie naprawdę raz, a potem jego odpowiedź wraca z cache,
dopóki nie zmieni się nic, co strażnik czytał — cały `pg_catalog`, wiersze tabel czytanych przez strażnika,
ustawienia sesji, placeholdery (`app.tenant_id`…), blokady własnej sesji (wszystkich sesji tylko dla funkcji,
które próbują blokady albo czytają `pg_locks` bez filtra `pid=pg_backend_pid()`), pid/xid, gdy strażnik czytał
taką kolumnę. Strażnik, który coś zapisał, wziął xid albo zmienił klucz, nie trafia do cache; sesja bez
superusera (`dyna_app` w `tenantTx`) zawsze biegnie naprawdę. Kod serwera i produkcja są bez zmian.

Odpowiedzi przechodzą na kolejne pliki shardu (`_guard-cache-template.jsonl`, każdy plik dostaje kopię tego
samego szablonu). Linia podsumowania pliku pokazuje `guards=<trafienia>hit(<z pliku shardu>shared)/<chybienia>miss(<s>:<przyczyny>)/…`.
Plik, który sam czyta `pg_stat_xact_*` albo `track_functions`, biegnie bez cache (wykrywane automatycznie);
inny wyjątek wpisz do `noGuardCache`. Pliki wołające `bootstrap151169()` dostają pustą bazę (bez wpisu
`freshDatabase`). Diagnostyka: `DYNA_CI_GUARD_CACHE_DEBUG=1` wypisuje przyczynę każdego chybienia.

## Czasy shardów

`scripts/ci/test-durations.json` trzyma sekundy na plik. Wpisy testów static to lokalny pomiar z 11.11.2026
(obciążona maszyna) — służą tylko jako względne wagi do podziału na 3 części. Testy db: pomiar z pełnego biegu
(plik bez pomiaru waży `estimateSec` w `scripts/ci/shard.mjs`: `60 s + 45 s × liczba wywołań test(…)`).
Czasy są mierzone przy jednym pliku naraz; plan mnoży cel shardu przez `CI_DB_CONCURRENCY`, a przy kilku
plikach naraz shard zaczyna od najdłuższego.

| Bieg (12.11.2026) | Ustawienie | Wynik |
|---|---|---|
| 43121830853 | bez cache | 83 z 367 plików w 180 min |
| 43262334505 | cache, 1 plik naraz | ~1 690 min plików łącznie, shardy 58–120 min |
| 43286339319 | cache (blokady własnej sesji), 2 pliki naraz | cały bieg 57 min, shardy 29–57 min |

Pełny zestaw: 20 shardów, limit shardu 180 min (zapas), limit pliku 45 min (`CI_FILE_TIMEOUT_MIN`; po nim
cała grupa procesów pliku jest zabijana). Po zmianie czasów skopiuj artefakt `db-test-durations` do
`scripts/ci/test-durations.json`.

Szablon bazy po migracji dostaje `ANALYZE` (statystyki kopiują się do każdej bazy testu): bez nich natywni
strażnicy wołani przy `buildApp` (np. `pim_dictionary_valid()`) liczyli się lokalnie 13–14 s, po `ANALYZE`
~10 s — przy limicie zapytania 8 s (`server/db.ts`). Lokalnie, na maszynie z load average 60–180, część
testów db pada z tego powodu (`57014 canceling statement due to statement timeout`); na pustym runnerze
nie było jeszcze pomiaru. Job zbiorczy `DB tests` publikuje artefakt
`db-test-durations` (zmierzone sekundy na plik) — skopiuj go do `scripts/ci/test-durations.json`,
a kolejne biegi dzielą pliki po czasie (LPT) i dobierają N do `CI_DB_TARGET_MIN`.
