# N23: pakiet poprawek podglądu — 19.10.2026

**SOURCE/BUILD/FILE i normalny RUNTIME PASS. Wąski odbiór normalnego Chrome D PASS. Odtworzony podgląd N23 pozostaje OPEN.** Root normalnie zatrzymał N21 i uruchomił N23 dokładnie raz; aktualne wydanie to `c148c9c99f55e4be460daa738caacdcbb8d1cee19978bdd8954475f9f8cb94b7`. Ten raport nie zamyka całego UI read-only ani pełnego Goala.

## Zakres źródłowy

Źródła wydania: commit `2c8d33262973c3a14c87ba10fb677c2ed9381708`. N23 zawiera przygotowane wcześniej poprawki N22 integracji oraz trzy dalsze zmiany UI: `web/main.tsx`, `web/workspaces.tsx`, `web/workspace-billing.tsx`. Względem przygotowanego N22: **1324 wybrane pliki, 3 zmienione/1321 identycznych**. Przygotowany profil N22 również nie był aktywowany; nie jest historycznym runtime baseline.

N22 blokuje w read-only dodawanie/testowanie/podgląd/import konfiguracji integracji i niebezpieczne modale. N23 blokuje wszystkie globalne akcje tworzenia, ustawienia organizacji, role/dostępy/zaproszenia, tworzenie/dołączanie organizacji oraz operacje lokalnego billingu. Aktualne refs i klucz komponentu obejmują kontekst użytkownika/firmy/roli/podglądu; stare callbacki i wymuszone submit nie omijają blokady. Odczyty, historia, filtry i paginacja pozostają dostępne.

Root wykonał **25 focused testów PASS (18+7), 0 pominiętych**, oraz pełny typecheck EXIT0. Testy rzeczywistych komponentów React z zamkniętym transportem obejmują read-only, stare callbacki, zmianę tożsamości, późny ACK i zachowanie normalnego zapisu poza podglądem. Istniejącą fixture ręcznego zamówienia dostosowano do faktycznej trasy GET/settings i rozwinięcia istniejącego panelu cennika; oryginalne asercje biznesowe zachowano. Niezależny przegląd źródeł bez nowych P1/P2.

## Rzeczywisty build i FILE peer

Root wykonał przygotowanie plików EXIT0, świeży Vite EXIT0, check EXIT0 i emit EXIT0. Źródłowy manifest ma SHA256 `856f07205967caccb86b98be3fef2b017f669422e625d56eec354ad2e5fb249e`. Rzeczywisty manifest pakietu: **`c148c9c99f55e4be460daa738caacdcbb8d1cee19978bdd8954475f9f8cb94b7`**, **392 pliki/99 047 859 B**; limit jednego pliku16 MiB i całego pakietu96 MiB zachowany.

Niezależny FILE peer sprawdził pełny fizyczny roster i bytes/SHA każdego z392 plików, wszystkie1324 wybrane źródła w prywatnym project oraz współdzielone zależności bez instalacji. Sześć assetów frontend jest całe równe świeżemu project/dist; index wskazuje `index-Bg2ACiIW.js`. Te same trzy archiwa unreachable co N22 pozostają wyłączone z aktywnego grafu. Nie wykonywano nowego builda ani importu aplikacji podczas peer-review.

**35 Native: całe rekordy, bytes i native_contract identyczne z N22.** Adapter, lock i zależności również bez zmian. Kontrakt źródłowy zachowuje109 członków/68 runtime-source/35 Native, inventory bez zmian, zero runtime-source replacement. Nie ma nowych SQL/migracji ani dołączenia `server/base-wire-codec.ts`; oddzielny codec nie staje się przez to działającym Base API.

## Profil i rzeczywista normalna aktualizacja

Root przygotował profil o SHA256 `0216bd7f47ba91a0d6595c5d3ad1587024e254308492914720118495c351a746` oraz selection `2fdc98216c34c17120e8ee258aaac6a1144345fd589675522a8a55d08dbfa1d3`. Pełny inverse do przygotowanego N22 zmienia wyłącznie entry/cwd, ścieżkę i hash selection, pin wydania oraz powiązane pliki/readiness. Ta sama baza i konfiguracja, schema217, port4105 oraz dotychczasowe flagi pozostały bez zmian. Wszystkie piny plików profilu zgodne z rzeczywistymi plikami.

Wynik samego przygotowania profilu zachowuje historyczne **application_started=false i normal_migration_executed=false**. Później Root normalnie zatrzymał N21 (stop CLOSED/EXIT0, supervisor29988 terminal0), po czym uruchomił N23 dokładnie raz. Supervisor81380 osiągnął READY; zapisany health ma revision c148 i jest zgodny z przygotowanym profilem. Ta sama baza, schema217 i flagi pozostały zachowane. Nie jest to jeszcze uruchomienie odtworzonego podglądu N23.

Root wykorzystał niezmieniony istniejący capture e97d w RRRO SQL8s/klient9s: baseline po końcowych odczytach pięciu firm `59fedf16…` → po aktualizacji `d2e058b6…`. **643 całe tabele zachowane; cały wiersz generacji1887 odtworzony po zmianie wyłącznie release_sha256.** Roster644/raw28, migracje, wszystkie kontrole, jobs i sesje zachowane; potwierdzone ROLLBACK/end, 0 zapisów SQL przez capture. Niezależny FILE peer sprawdził pełne liczności/hashe i ścisły inverse całej generacji, nie tylko wybrane pola.

## Wąski normalny Chrome D i brak zmian po odczycie

Root przeładował zwykłą aplikację N23 w Chrome D: dashboard pokazał2 zamówienia, stock9/rezerwacja2. Otworzył nowe `DE-20261019-28A0020E`: płatne12,30 PLN, due0, jedna sztuka/native12 i jawna deklaracja `source_import`. Zachowany zrzut `ui-D-order-after-upgrade.root.png` pokazuje szczegóły zamówienia, kwotę i deklarację kanału; FILE peer obejrzał ten obraz. To odbiór normalnego widoku zamówienia D, nie dowód wyłączenia mutacji w podglądzie read-only.

Capture po Chrome `1343f2ce…` zachowuje **wszystkie644 pary liczności/kanonicznych SHA i wszystkie28 pełnych zestawów raw identyczne do po-upgrade**. Tożsamość, generacja1887,731 jobs,144 sesje i migracje całe bez zmian. Niezależny FILE peer potwierdził tę pełną równość; ROLLBACK/end PASS. Nie powstała nowa sesja w tym odbiorze.

## Następny krok: przygotowane profile BR23

Root przygotował wyłącznie plikowe profile backup/restore BR23: target732 B/SHA `4be580c74b0996a4d926339bbe179d0066235a30f79e0f8437f34f12d6d8fc48`, backup2419 B/`b0e73221dbc5e36961377d4b677b6f570fd3539a8712ea31a03fcb4db56ce3c1`, restore2411 B/`5e2c629fd17c1f2bbcc81b644a5049500d7dc2b26050a69ebc9fc779f51d94f8`. **Fresh backup/restore N23 i uruchomienie/Chrome odtworzonego podglądu nadal OPEN.** Sam binder nie wykonał backupu lub restore; nie przenosimy wcześniejszego odbioru kopii N21 na nową kopię N23.

## Zachowane dowody

Ścieżki względem `/Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrations-settings-readonly-n23-prepared-agent-20261019-01/`; bez publikowania DSN, cookie lub kluczy.

- `prepare-release.result.private.json`,4231 B, SHA256 `238999e18c011efb9d7ae2cd859e8678e8baed4548b95d21830ab633859422b6`.
- `source-cut.private.json`,317441 B, SHA256 `19857337f9c8772e5fae5b67b9db899f97698e7ac21597b77b7b06a3d90d0670`.
- `root-package-emit-ACK.private.json`,5791 B, SHA256 `61ce30c3ab282d14b7c351e7281d7f68d96173570a59498e859cfa8d1f4fe36b`; manifest `release-canonical/release.json` jak powyżej.
- `prepare-profile.result.private.json`,10490 B, SHA256 `6a7906e28474ec17f4108295dc3fbe77efb49593f2163165c13d475ed0896165`; profil3070 B/selection730 B z pełnymi hashami powyżej.
- `root-health-ready.private.json`,3638 B, SHA256 `6de454be62794d2395feee5c4f757415e2e926d1d56562b1b1a0de3e54317cd3`; Root actual READY81380.
- Capture w sąsiednim `readonly-preview-n21-prepared-agent-20261019-01/`: `after-five-closing01/result.private.json`,3172040 B/`59fedf1633da33cd5350f441a6a1e9983c90c54a4f797ad21eb1c5befbf40439`; `after-n23-upgrade01/result.private.json`,3172248 B/`d2e058b69ba437a648ee1e0e5337ddfaee181ed1ab7209cd29cfaa6cd5921aad`; `after-n23-ui01/result.private.json`,3172074 B/`1343f2ce94f7596e542560f35377feb480ed32cb128dfd5b36c1c6bf73aae401`.
- `ui-D-order-after-upgrade.root.png`,118773 B, SHA256 `a277f78818127774c9b7ef3f9f655c5da87d83ea6c0f68255064ee74aabc94a3`.

## Granice

Normalna aktualizacja i wąski normalny Chrome D mają opisany wyżej PASS; nie oznacza to odbioru wszystkich modułów N23 lub działania blokad na odtworzonej kopii. Fresh backup/restore, pełny read-only preview/Chrome N23, czas odczytów pod obciążeniem, odporność na awarie, pełne recovery/prywatny filesystem, skala, Source34/bramka8s, Base wire i cały klon Base pozostają OPEN. [Odebrany zakres N21](RESTORED-PREVIEW-N21-LOCAL-20261019.md) oraz procesy biznesowe B/C/D są osobnymi odbiorami; ten build ich nie zastępuje.
