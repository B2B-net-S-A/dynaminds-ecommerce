# Lokalny staging na laptopie

Decyzja Artura z 12.11.2026. Demo publiczne (`https://demo.dynaminds.pl`, `demo-deploy.yml`) dalej wdraża się
samo po zielonym `main`. Dodatkowo co noc lokalne demo na `http://127.0.0.1:4300` (`tools/demo/demo.sh`) dostaje
kod z `main` tego repo, przechodzi strażników i smoke, a potem rutyna „E-commerce Tester” przeklikuje PR-y scalone
od poprzedniego biegu. Wzór: staging NEXUSA (`scripts/staging/refresh_code.sh`): nowy kod, ta sama baza.

## Jak działa

`tools/staging/refresh.sh`:

1. `git fetch` publicznego repo (remote, którego URL wskazuje `B2B-net-S-A/dynaminds-ecommerce`) i `main`
   w osobnym worktree (domyślnie `staging-main` obok checkoutu źródłowego, odłączony na SHA z maina).
   W tym worktree nic nie edytuj: zmiany zatrzymują bieg (kod 1), skrypt ich nie nadpisuje.
2. `tools/demo/demo.sh build` z tego worktree, czyli wydanie dokładnie z commita `main`.
   Gdy build padnie, demo działa dalej na poprzednim wydaniu.
3. `demo.sh stop` i `demo.sh start` z nowym wydaniem. Migracje wykonuje wydanie przy starcie na bazie
   `dynaminds_demo`. Migawka `dynaminds_demo_snapshot` i kopia obrazów zostają bez zmian, więc
   `tools/demo/demo.sh reset` dalej wraca do danych z seeda. Gdy nowe wydanie nie wstanie, skrypt raz uruchamia
   poprzednie.
4. `demo.sh guards`: 16 strażników bazy, tylko odczyt. Wymagane 16/16.
5. `tools/staging/smoke.mjs`: `/api/health` → 200 i `status: "ok"`, potem każde konto testowe demo loguje się,
   czyta `/api/auth/me` i wylogowuje. Hasła czyta tylko z prywatnej kopii seeda w `$DEMO_ROOT/private/`
   (0600, poza repo) i nigdzie ich nie wypisuje.
6. Ślad: jedna linia JSON (`stan`: `ok`, `degraded`, `failed`, `skipped`, do tego `kod`, `sha`, `powod`,
   `liczniki`) w `~/.claude/dyna-ecommerce-rutyny/odswiezenie.ok` (zmienna `STAGING_TRACE`).

Gdy demo jest już na SHA z `main`, skrypt pomija build i restart, a strażników i smoke sprawdza dalej.

| Kod | Stan | Znaczenie |
|---|---|---|
| 0 | `ok` | demo na wydaniu z `main`, strażnicy 16/16, smoke zielony |
| 1 | `failed` | fetch, worktree albo build nie przeszedł; demo bez restartu, na poprzednim wydaniu |
| 2 | `failed` | brak konfiguracji: repo źródłowe, remote, `node_modules`, stan demo, konta testowe, Docker; albo zły argument |
| 3 | `failed` | nowe wydanie nie wstało (start, migracje, `/api/health`); w `powod` wynik powrotu na poprzednie wydanie |
| 4 | `degraded` | nowe wydanie działa, strażnicy nie 16/16 |
| 5 | `degraded` | nowe wydanie działa, strażnicy 16/16, smoke nie przeszedł |
| 6 | `skipped` | trwa inny bieg odświeżenia |

## Godziny (Warszawa)

| Godzina | Co | Gdzie |
|---|---|---|
| 04:10, pon.–pt. | Odświeżenie stagingu (`refresh.sh`, bez modelu) | launchd `pl.dynaminds.ecommerce-odswiezenie` |
| 04:40, pon.–pt. | E-commerce Tester: PR-y scalone od poprzedniego biegu, najwyżej 10 | zadanie w aplikacji Claude |
| 07:35, pon.–pt. | E-commerce raport | zadanie w aplikacji Claude |

04:10, a nie 03:10: o 03:17 na tym samym laptopie odświeża się staging NEXUSA, a o 03:30 rusza jego Tester.

launchd uruchamia kopię skryptu spoza repo, nie kod z `main`: scalony PR nie zmienia sam tego, co biegnie nocą
bez modelu. Build, strażnicy i `demo.sh` idą z kodu `main` w worktree stagingu. Po zmianie `refresh.sh` albo
`smoke.mjs` kopię odnawia się ręcznie (`~/.claude/dyna-ecommerce-rutyny/ZASADY.md`). Zasady rutyn, raporty
i ślady leżą poza repo, bo repo jest publiczne.

## Ręczne uruchomienie

```bash
tools/staging/refresh.sh --dry-run   # konfiguracja i plan, bez zmian
tools/staging/refresh.sh             # pełny bieg, kilka minut
cat ~/.claude/dyna-ecommerce-rutyny/odswiezenie.ok
```

Zmienne (opcjonalne): `STAGING_SOURCE_REPO`, `STAGING_REMOTE`, `STAGING_BRANCH`, `STAGING_WORKTREE`,
`STAGING_DEPS`, `STAGING_TRACE` (pusta = bez śladu), `DEMO_ROOT`, `DEMO_HTTP_PORT`; opis w nagłówku skryptu.
Testy bez Dockera i bez demo: `node --test tests/staging-refresh.test.mjs`.

## Co robić przy czerwieni

| Ślad | Co zrobić |
|---|---|
| kod 1, build | log `$DEMO_ROOT/logs/build.log`. Zmiana `package-lock.json` w `main` wymaga odświeżenia lokalnych `node_modules` (`STAGING_DEPS`); bez tego build albo start może paść. Demo działa na poprzednim wydaniu. |
| kod 1, checkout | ktoś zmienił pliki w worktree stagingu: `git -C <worktree> status`, przenieś zmiany na zwykłą gałąź, potem bieg ponownie. |
| kod 2 | `powod` mówi, czego brakuje. Brak kont albo stanu demo: `tools/demo/demo.sh seed` (nowe hasła i nowa migawka, to decyzja Artura). Docker: uruchom Docker Desktop. |
| kod 3 | `$DEMO_ROOT/logs/app.log`: odmowy migracji (`MIG-*`) i startu są tam po polsku. Gdy powrót na poprzednie wydanie też nie wstał, demo nie działa: `tools/demo/demo.sh reset` wraca do migawki (dane z seeda, zmiany z dnia giną). |
| kod 4 | `tools/demo/demo.sh guards` pokazuje, który strażnik jest `false`. To błąd danych albo migracji w `main`: issue z wynikiem strażnika, bez danych z bazy. |
| kod 5 | `powod` i log pokazują, które konto nie weszło. Po `demo.sh seed` hasła są nowe, a stara kopia kont prywatnych może nie pasować. |
| kod 6 | poprzedni bieg jeszcze trwa albo został przerwany: blokada `$DEMO_ROOT/staging-refresh.lock` z martwym pid jest zdejmowana sama. |

Brak świeżego śladu rano oznacza, że launchd nie wystartował (laptop wyłączony, Docker zamknięty): bieg ręcznie.
