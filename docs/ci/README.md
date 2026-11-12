# CI — GitHub Actions

Repo docelowe: publiczne `B2B-net-S-A/dynaminds-ecommerce`, standardowe runnery `ubuntu-latest`
(4 vCPU / 16 GB, minuty w publicznym repo są darmowe). Wzór: CI NEXUSA (`ci-gate.yml`, `ci.yml`,
`auto-enqueue.yml`). Wszystkie akcje są przypięte do SHA; Dependabot podbija je co tydzień.

## Workflowy

| Plik | Kiedy | Co robi |
|---|---|---|
| `.github/workflows/ci-gate.yml` („CI Gate”) | push na `main`, PR, kolejka merge'ów | Szybka bramka (cel ≤ ~5 min): gitleaks (drzewo + każdy commit PR-a/grupy), `tsc --noEmit`, lint źródeł (`tests/failure-job-kinds.test.ts`, `tests/sql-text-lint.test.ts`), wszystkie testy klasy `static` bez bazy w 3 równoległych częściach (podział po czasach), klasa `darwin` w jobie `Static tests (macOS zlib)` na `macos-15`, testy `web/*.test.mjs`. |
| `.github/workflows/ci.yml` („CI”) | PR, kolejka merge'ów, co noc 01:17 UTC (`schedule`), ręcznie (`workflow_dispatch`) | Testy z bazą (klasa `db`). PR: sito — testy db najbliżej zmiany, do 40 plików i `CI_DB_PR_BUDGET_MIN` szacowanych minut, 1–3 shardy. Kolejka: to samo sito, do 120 plików i `CI_DB_QUEUE_BUDGET_MIN`, do `CI_DB_MAX_SHARDS` shardów po ≤ ~35–40 min. Noc i ręczny bieg: pełny zestaw w `CI_DB_MAX_SHARDS` shardach (limit 180 min na shard), czerwony nocny bieg otwiera issue „Nocny pełny bieg testów db nie przeszedł”, zielony je zamyka. Zmiana w `server/db.ts`, migracjach `server/*.sql`, runnerze/manifeście migracji, `package*.json`, `tsconfig.json`, `scripts/ci/` albo `ci.yml` uruchamia pełny zestaw także na PR-ze i w kolejce. Każdy shard: PostgreSQL `postgres:18.4-trixie` (service), losowe `dbPassword`/`encryptionKey` w `$RUNNER_TEMP`, osobna baza na plik. |
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
W rulesecie ustaw limit czasu checków („Status check timeout” kolejki) na co najmniej 180 min: zwykła grupa
kończy sito w ~35–40 min, ale PR zmieniający `server/db.ts`, migracje albo `package*.json` puszcza w kolejce
pełny zestaw (szacunek ~155 min na shard przed pierwszym pomiarem), a domyślne 60 min wyrzuciłoby go z kolejki.

Dlaczego kolejka nie biegnie pełnym zestawem (decyzja 11.11.2026): pełny zestaw db to wg szacunku ~3 100 min
pracy, czyli godziny nawet na 20 runnerach. Kolejka sprawdza testy najbliżej zmiany, a całość biegnie co noc;
błąd spoza sita wychodzi najpóźniej następnego ranka jako issue.
`ci.yml` nie biegnie na `push: main` — kolejka testuje dokładnie to drzewo, które trafia na maina.
Gdyby kolejkę wyłączyć, trzeba dodać `push: branches: [main]` w `ci.yml`.

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
| `CI_DB_CONCURRENCY` | `1` | ile plików db naraz w jednym shardzie (każdy na swojej bazie) |
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
  "freshDatabase":{ "tests/v.test.ts": "migruje pustą bazę sam" }
}
```

Wpis ręczny wygrywa z regułami. Ścieżka musi istnieć — po usunięciu testu skrypt każe usunąć wpis.

**Jak dodać test special:** dopisz plik do `special` z powodem (czego wymaga: klon PG04, port, zmienna)
i sprawdź `node scripts/ci/classify-tests.mjs`. Jeśli test sam asertuje port/nazwę bazy/zmienną,
klasyfikator wykryje go bez wpisu. **Kwarantanna** jest dla testu, który pada na mainie z powodu
niezwiązanego z CI: wpis w `quarantine` z commitem i objawem, a naprawa idzie osobnym zadaniem —
po naprawie wpis usuń. Lista jest dziś pusta: 14 testów z kwarantanny z 11.11.2026 naprawiono w tej gałęzi.

## Skrypty

| Skrypt | Do czego |
|---|---|
| `scripts/ci/classify-tests.mjs` | podsumowanie; `--list static\|db\|darwin\|special`; `--json`; `--why` (sygnał, który przesądził o db) |
| `scripts/ci/shard.mjs` | podział listy na N shardów (LPT po czasach z `scripts/ci/test-durations.json`, bez czasów round-robin); `--plan --target-min M --max K` wylicza N |
| `scripts/ci/select-pr-tests.mjs` | sito PR-a i kolejki z `git diff --name-only` (domyślnie `origin/main...HEAD`, albo `--range A..B`): zmienione testy db + testy importujące zmienione moduły albo nazwane od nich (graf importów wstecz, najbliższe najpierw; `--limit` plików, `--budget-min` szacowanych minut). Zmiana w `server/db.ts`, `server/*.sql`, runnerze/manifeście migracji, `package*.json`, `tsconfig.json`, `scripts/ci/`, `ci.yml` → pełny zestaw |
| `scripts/ci/run-tests.mjs` | uruchamia pliki po jednym procesie `tsx --test`, logi per plik, `summary.txt`, `failed.txt`, `durations.json`; `--kind db` zakłada i sprząta bazy |
| `scripts/ci/migrate-database.ts` | `migrate()` na bazie-szablonie shardu |

Lokalnie (bez portu 55432 — tam stoi lokalna baza aplikacji):

```bash
node scripts/ci/classify-tests.mjs
node scripts/ci/select-pr-tests.mjs --range origin/main...HEAD
DYNA_TEST_PG_PORT=57361 DYNA_LOCAL_CONFIG_PATH=<plik z dbPassword> \
  node scripts/ci/run-tests.mjs --kind db --out /tmp/ci-db tests/<plik>.test.ts
```

## Czasy shardów

`scripts/ci/test-durations.json` trzyma sekundy na plik. Wpisy testów static to lokalny pomiar z 11.11.2026
(obciążona maszyna) — służą tylko jako względne wagi do podziału na 3 części.

Dopóki plik nie ma zmierzonego czasu, plan waży go szacunkiem z liczby testów (`60 s + 45 s × liczba
wywołań test(…)`, `estimateSec` w `scripts/ci/shard.mjs`) — testy db to głównie duże pliki integracyjne,
w których czas rośnie z liczbą testów. Szacunek dla 371 plików db (11.11.2026): ~3 100 min łącznie, czyli przy
20 shardach ~160 min na shard. To zgrubna liczba z lokalnych biegów na obciążonej maszynie — pierwszy pełny
bieg ją zweryfikuje. Do tego czasu shard ma limit 180 min, a plik 45 min (`CI_FILE_TIMEOUT_MIN`).

Po pierwszym nocnym (albo ręcznym) pełnym biegu: wklej `db-test-durations`, sprawdź podsumowanie planu i ewentualnie podnieś
`CI_DB_CONCURRENCY` (2–3 pliki naraz na runner, każdy na swojej bazie) albo `CI_DB_MAX_SHARDS`.

Szablon bazy po migracji dostaje `ANALYZE` (statystyki kopiują się do każdej bazy testu): bez nich natywni
strażnicy wołani przy `buildApp` (np. `pim_dictionary_valid()`) liczyli się lokalnie 13–14 s, po `ANALYZE`
~10 s — przy limicie zapytania 8 s (`server/db.ts`). Lokalnie, na maszynie z load average 60–180, część
testów db pada z tego powodu (`57014 canceling statement due to statement timeout`); na pustym runnerze
nie było jeszcze pomiaru. Job zbiorczy `DB tests` publikuje artefakt
`db-test-durations` (zmierzone sekundy na plik) — skopiuj go do `scripts/ci/test-durations.json`,
a kolejne biegi dzielą pliki po czasie (LPT) i dobierają N do `CI_DB_TARGET_MIN`.
