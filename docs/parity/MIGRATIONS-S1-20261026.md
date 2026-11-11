# S1: ścieżka wydania i migracje (26.10.2026)

Tor S1 z [STAGE4-NONINTEGRATION-GAP-20261025](STAGE4-NONINTEGRATION-GAP-20261025.md), obszar 6 (MIG-1…MIG-8).

## MIG-7: jedna lista migracji zamiast ręcznych edycji ok. 28 plików

### Co było

Rejestracja jednej migracji (wzór: 3ad5a7d dla 233) to były ręczne edycje: `server/db.ts`, dwie kopie
`resource-format209.mjs`, `tools/build/package-builder.mjs`, `runtime-resources.mjs`, listy zaślepek w ok. 20
testach `*-resource-packaging`, łańcuch zimnej inspekcji (`packing189-cold-inspection.mjs`: import, rzutowanie,
asercja poprzednika, kolumna znacznika, asercja znacznika, pole wyniku) i porty łańcucha w ok. 20 testach
zgodności i bramek (`*-source-compatibility`, `*-cold-gate`).

### Co jest teraz

Jedno źródło prawdy: `shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs`
(`RELEASE_MIGRATIONS`, wiersze 211…233 w kolejności ledgera). Wiersz ma: `number`, `name` (nazwa w tabeli
`migrations`), `file` (plik w `server/`), `native_id` (krawędź Native), `bytes` i `sha256` (dokładny pin SQL),
`contract` (rdzeń skompilowanej pary zimnego katalogu), `note`. Z rdzenia wynikają nazwy:
`<contract>-source-contract.mjs`, `<contract>-source-compatibility.mjs`, projektor
`projectCompiled<Pascal>Catalogue`, klucz aktywności `<contract z _>_active`. Pola `marker` (211–219) i
`requires:false` (211–215) zachowują tylko dawną pisownię łańcucha.

Z listy wyprowadzają się:

| Miejsce | Jak |
|---|---|
| `server/db.ts` `migrate()` | literalne pary do 209, potem `...RELEASE_MIGRATION_PROGRAM` |
| `tools/build/source-ddl-migration-plan.mjs` | parser rozwija jedyny, ostatni spread do wierszy listy |
| `resource-format209.mjs` (obie kopie, identyczne bajty) | `RELEASE_RESOURCES`, `releaseResource(n)`, `hasReleaseResourceEdge(n,…)`, `releaseResourceSelection(…)`, `definitions209`, `storage209`, `assertStorage209Partition` |
| `tools/build/package-builder.mjs` | etap zasobów w pętli po wierszach; przy budowie pełnej paczki lista z projektu musi być równa liście narzędzia (`fixed-release-migration-manifest-source-equality`) |
| `runtime-resources.mjs` | definicje i piny czytnika z `RELEASE_RESOURCES` |
| `packing189-cold-inspection.mjs` | `projectReleaseColdChain` (od najnowszej, każda odwrotność dostaje katalog następnika, aktywność wymaga poprzednika), `RELEASE_COLD_MARKER_SQL`, `assertReleaseColdMarkers` |
| `release-cold-projectors.mjs` | jedna linia `export{projekt}from'./<contract>-source-compatibility.mjs'` na wiersz (statyczny import dla esbuild); test pilnuje zgodności z listą |
| testy | `tests/release-migrations-resource-packaging.test.mjs` (5 sprawdzeń na wiersz, zastępuje 23 pliki), `tests/release-migrations-cold-chain.test.mjs` (łańcuch, poprzednik, znacznik na wiersz), bramki 207/208/209 i test planu biorą wiersze z listy |

Komunikaty błędów (`resource233-requires232`, `deployment233-full-source-pin`, `fiscal-receipts233-migration-marker`
itd.) są te same co wcześniej.

### Jak dodać migrację N+1

1. Plik `server/<N>_<nazwa>.sql`.
2. Jeden wiersz na końcu `RELEASE_MIGRATIONS` w `migration-manifest.mjs`:
   `row({number:N,name:'N_nazwa',file:'N_nazwa.sql',native_id:'…',bytes:…,sha256:'…',contract:'rdzen-N',note:'…'})`.
   `bytes`/`sha256`: `node -e "const b=require('fs').readFileSync('server/N_nazwa.sql');console.log(b.length,require('crypto').createHash('sha256').update(b).digest('hex'))"`.
3. Skompilowana para zimnego katalogu `rdzen-N-source-contract.mjs` i `rdzen-N-source-compatibility.mjs`
   (kompilacja na klonie jak dotąd) oraz jedna linia w `release-cold-projectors.mjs`.
4. Testy własne migracji (DDL, zgodność odwrotności). Pakowania, łańcucha, znaczników, planu i bramek nie trzeba
   edytować: obejmują nowy wiersz same.

Sprawdzenie: `node --test tests/release-migrations-*.test.mjs tests/source-ddl-migration-plan.test.mjs`
i realne `migrate()` na klonie.

### Dowód, że paczka się nie zmieniła

Etap zasobów paczki (`buildFixedRuntimeResources209`, prawdziwe SQL z `server/` i prawdziwy `db.ts`, kontrakt
Native z krawędziami 209 i 211–233; skrypt w katalogu sesji `s1/pkgstage.mjs`):

| | przed (HEAD 4e276d2) | po |
|---|---|---|
| `resource_contract` (wchodzi do `release.json`) sha256 | `4a7249e7…5e6b` | `4a7249e7…5e6b` |
| 228 plików zasobów/Native, łączny sha listy | `a6b6b1c7…50fd4` | `a6b6b1c7…50fd4` |
| cięcia źródeł poza `server/db.ts` (228) | identyczne | identyczne |

Jedyna różnica to sha256 samego źródła `server/db.ts` w liście cięć (plik źródłowy się zmienił). Emisja
runtime (esbuild 11 punktów wejścia, opcje buildera): 0 ostrzeżeń, 146 plików przed i po, 2 nowe wejścia
(`migration-manifest.mjs`, `release-cold-projectors.mjs`), łącznie 29 619 556 → 29 575 858 B; nazwy chunków
zmieniają hash, bo zmienił się kod `db.ts`, `resource-format209.mjs`, `runtime-resources.mjs` i
`packing189-cold-inspection.mjs`. Bajtowo identyczny jest więc cały wkład zasobów i Native, nie kod runtime.

## MIG-6: wydanie N nie uruchomi bazy zmigrowanej przez N+1

`migrate()` (start `server/index.ts` i `ordinary-local-runtime.ts`) pod blokadą doradczą, w tej samej
transakcji, najpierw zbiera cały program wydania (literalne 001–209 i lista wydania), potem
`assertLedgerKnownToRelease` (`server/migration-bootstrap.ts`) porównuje każdy wiersz `migrations` z tym
programem. Wiersz nieznany wydaniu (nowsza migracja, zmieniona nazwa, nie-tekst) przerywa start przed
zastosowaniem czegokolwiek, cała seria jest wycofana:

> Ta wersja aplikacji nie uruchomi bazy danych zmigrowanej przez nowszą wersję. Migracje nieznane tej wersji:
> 234_future_release. Uruchom wersję, która je zna, albo odtwórz kopię bazy sprzed migracji (…).

Błąd ma `name='NewerDatabaseError'`, `code='MIGRATION_LEDGER_NEWER_THAN_RELEASE'`, `unknown=[…]`.

Sprawdzone: `tests/migration-ledger-guard.test.ts` (4 testy, w tym kolejność w `db.ts`) oraz realne klony PG04:
`dynaminds_s1_20261026_02` (218–233 zastosowane, dopisany `234_future_release` → odmowa, ledger 224 wiersze
z tym samym md5 przed i po, po usunięciu wiersza `migrate()` przechodzi) i `dynaminds_s1_20261026_03` (szablon
217 z dopisanym 234 → odmowa, 208 wierszy przed i po, tabele 218 i 233 nie powstały).

## MIG-3: kopia przed migracją przy starcie

Gdy `migrate()` ma oczekujące migracje, a baza ma już historię (`migrations` nie jest pusta), po sprawdzeniu
MIG-6 i przed pierwszą oczekującą migracją wykonuje pełną szyfrowaną kopię lokalną
(`server/recovery.ts` `createBackup`: `pg_dump` jednego snapshotu, zdjęcia, konfiguracja; AES-256-GCM) do
skonfigurowanego katalogu (`server/migration-backup.ts`). Porażka kopii = żadna migracja nie jest wykonana,
seria wycofana, start przerwany z `MigrationBackupError` (`MIGRATION_BACKUP_FAILED`), np.:

> Nie udało się wykonać kopii bazy przed migracją, więc migracje (218_base_wire_crm, …) nie zostały wykonane.
> Popraw przyczynę i uruchom ponownie; świadome pominięcie kopii: DYNA_MIGRATION_BACKUP=off. Przyczyna: …

Ustawienia (czytane przed połączeniem; zła wartość przerywa start):

| Zmienna | Domyślnie | |
|---|---|---|
| `DYNA_MIGRATION_BACKUP` | `required`; `off` przy `DYNA_TEST=true` | `required` albo `off` |
| `DYNA_DATA_DIR` | katalog `DYNA_LOCAL_CONFIG_PATH` | katalog danych instalacji, ścieżka bezwzględna |
| `DYNA_MIGRATION_BACKUP_DIR` | `<dane>/backups/pre-migration` | ścieżka bezwzględna; katalog musi być prywatny (0700) |
| `DYNA_MIGRATION_BACKUP_KEY_FILE` | `<dane>/.recovery-key` | ścieżka bezwzględna; klucz szyfrowania kopii |

Poprawka 27.10 (próba Etapu 3): CLI wydania startuje z katalogu wydania, więc dawne domyślne ścieżki względne
(`data/backups/pre-migration`, `.recovery-key`) trafiały do `release-canonical/` i każdy kolejny start padał na
`emitted-exact-inventory`. Teraz:

- ścieżki są wyłącznie bezwzględne (względna = błąd ustawienia); `<dane>` to `DYNA_DATA_DIR`, a bez niego katalog
  wybranej konfiguracji lokalnej (`DYNA_LOCAL_CONFIG_PATH`; wydanie ustawia ją zawsze z `localConfigurationPath`);
- brak miejsca (start ze źródeł bez tych zmiennych) albo miejsce w katalogu wydania (`release.json` + `runtime/`
  nad uruchomionym modułem) = odmowa `MigrationBackupError` z instrukcją, zanim cokolwiek zostanie zapisane;
- `createBackup` najpierw sprawdza narzędzie `pg_dump` i połączenie z bazą, dopiero potem tworzy katalog i klucz;
  porażka usuwa wszystko, co ta kopia utworzyła (nowy katalog, nowy klucz); istniejące zostają;
- CLI wydania wypisuje przy `MIGRATION_BACKUP_FAILED` linię `ORDINARY_LOCAL_START_FAILED` z `code` i `message`
  (przyczyna; hasło w adresie bazy zamaskowane). Inne błędy startu nadal tylko z nazwą.

Przyczyna porażki w próbie to nie `pg_dump` (przechodzi: pg_dump 18.6, PG04 18.4), tylko brak pliku zdjęcia:
szablon `dynaminds_restore_36751abef3079f3f` ma 1 wiersz `product_images`, a `DYNA_IMAGE_DIR` próby wskazywał
pusty katalog. Wymaganie: `DYNA_IMAGE_DIR` musi zawierać zdjęcia migrowanej bazy (kopia jest kompletna albo
żadna). Komunikat mówi to teraz wprost zamiast surowego `ENOENT`.

Kopia musi dotyczyć migrowanej bazy (nazwa i port z `DATABASE_URL` migracji = cel `createBackup`), plik musi
leżeć w skonfigurowanym katalogu. Pierwsza instalacja (pusta historia) i brak oczekujących migracji nie robią
kopii. Paragon kopii (id, plik, sha256, oczekujące migracje) daje `lastMigrationBackup()`; `server/index.ts`
wypisuje go jedną linią JSON `pre-migration-backup`, a `createBackup` zapisuje obok pliku raport `<id>.dyna.json`.

Sprawdzone: `tests/migration-backup.test.ts` (5 testów: ustawienia, kopia przed migracją, brak kopii bez potrzeby,
odmowa przy porażce i obcym pliku, kolejność w `db.ts`) i realne klony szablonu 217 (oczekujące 218–233):
`dynaminds_s1_20261026_04` z `DYNA_MIGRATION_BACKUP=required` → kopia 14 131 236 B (`schema: 207`, czyli stan
sprzed migracji), potem 218–233 zastosowane (223 wiersze); `dynaminds_s1_20261026_05` z katalogiem 0755 →
odmowa, 207 wierszy, tabele 218 i 233 nie powstały, katalog pusty.

Sprawdzone 27.10 (poprawka katalogu): `tests/migration-backup.test.ts` (9 testów, m.in. ścieżki, odmowa bez miejsca
i w katalogu wydania, wykrycie katalogu wydania, sprzątanie po porażce), `tests/ordinary-local-cli.test.ts`
(linia błędu startu) i `tests/migration-backup-release.database.test.ts` na wydaniu zbudowanym z poprawki
(`tools/scale/release-build.mjs`) i klonie szablonu 217: start bez zdjęć → odmowa z przyczyną, w katalogu danych
tylko konfiguracja, wydanie i ledger bez zmian; start ze zdjęciem → kopia w `<dane>/backups/pre-migration`, klucz
`<dane>/.recovery-key` (0600), ledger 207 → 234; drugi start przechodzi `emitted-exact-inventory` bez nowej kopii.
Ten sam test na wydaniu sprzed poprawki: czerwony (brak `code` w linii błędu, `.recovery-key` w wydaniu).

## MIG-8: runbook wydania (kopia → migracja → weryfikacja → cofnięcie)

Dotyczy lokalnej instalacji; Main (port 4100, `app/data/postgres`) zmienia tylko operator.

1. **Przed wydaniem** (stare wydanie N jeszcze działa): `npm run backup -- create --directory <prywatny katalog>`
   i zapisać `id`, `sha256`, `schema` z wyniku. To kopia niezależna od automatycznej.
2. **Zatrzymać N** (wszystkie procesy: serwer, worker, runtime lokalny), żeby nikt nie pisał w trakcie.
3. **Start N+1**. `migrate()` pod blokadą: (a) MIG-6 sprawdza ledger, (b) MIG-3 robi kopię do
   `DYNA_MIGRATION_BACKUP_DIR` i wypisuje `pre-migration-backup`, (c) stosuje oczekujące migracje w jednej
   transakcji. Odmowa w (a) albo (b) nic nie zmienia w bazie.
4. **Weryfikacja** po starcie:
   - ledger: `SELECT count(*), max(name) FROM migrations` = liczba programu wydania (dziś 258, ostatnia `269_order_warehouse_transfer`);
   - strażnicy, wszystkie `true`: `ordinary187_valid`, `buyer_address_guards`, `order_merge_delivery209_valid`,
     `return_credit206_guards`, `ordinary188_structure_valid`, `return_credit211_metadata_valid`, `large_import173_valid`,
     `fa3_draft_guards`, `pim_dictionary_valid`, `local_invoice_guards` (`SELECT public.<nazwa>()` w transakcji READ ONLY);
     sesja z ustawieniami puli aplikacji (`server/db.ts:65`): `SET jit=off; SET timezone='UTC'` przed zapytaniem —
     bez nich `order_merge_delivery209_valid`, `return_credit206_guards`, `return_credit211_metadata_valid`
     i `local_invoice_guards` dają false albo błąd także na zdrowej bazie (fałszywy alarm, sprawdzone na 234 i 235);
   - od 262: `has_database_privilege('dyna_app', current_database(), 'TEMPORARY')` = false (start sam odmawia, gdy ledger
     ma 262, a wynik jest true; po `CREATE DATABASE … TEMPLATE` albo odtworzeniu z dumpa właściciel wykonuje ponownie blok
     `DO` z `server/262_revoke_public_temporary.sql`; `restoreBackup()` robi to sam);
   - od 263: `manual_off_verdict_valid()` = `manual_inventory_off_valid()` = true (w tej samej sesji READ ONLY; strażnik 263
     odpowiada z werdyktu 248 tylko w READ COMMITTED, inaczej woła pełny strażnik korekty ręcznej OFF);
   - `/api/health` odpowiada, logowanie i jeden zapis biznesowy (np. notatka zamówienia) działają.
5. **Cofnięcie przy porażce** (down-migracji nie ma, cofamy kopią): zatrzymać N+1;
   `npm run release:rollback -- --backup <kopia z kroku 3b> --confirm <baza N+1>` tworzy nową bazę
   `dynaminds_restore_<hex>` ze stanem N (kontrola ledgera, `rollback.json`); skierować na nią `DATABASE_URL`,
   konfigurację i zdjęcia wydania N i uruchomić N. Wydanie N na bazie po migracji N+1 nie wystartuje (MIG-6) — to
   zamierzone. Pełna procedura i próba: MIG-4 (poniżej) i [release-upgrade-rollback.md](../release-upgrade-rollback.md).

## Preflight schematu w runtime bez bramki startowej

Bez bramki startowej (`ordinarySchemaGate` nieustawiony: uruchomienie ze źródeł, dev, testy) każde `tenantTx`
przed pobraniem klienta transakcji uruchamia walidatory schematu `preflightPim`, `preflightNestedPim`,
`preflightPhysicalParcelWz`, `preflightOperationalDeliveryConsumers`. Wcześniej szły przez `pool.query`, czyli
z sesyjnym limitem puli `statement_timeout=8000`; pod obciążeniem PG04 samo `pim_dictionary_valid()` trwa 5–13 s,
więc losowe 57014 pojawiały się w dowolnym teście bazodanowym. Wydanie z bramką uruchamia te same walidatory raz
przy starcie z budżetem 120 s (`preflightOrdinaryConstructionPim`).

Teraz (`server/db.ts`, `preflightUngatedTenantSchema`) bez bramki cztery walidatory idą na jednym kliencie puli
w krótkiej transakcji `READ COMMITTED READ ONLY` z `SET LOCAL statement_timeout='120s'`; klient jest zwalniany
przed pobraniem klienta tenanta. Bez zmian: `lock_timeout` 8 s, `SET LOCAL statement_timeout='8s'` w `tenantTx`,
`tenantReadTx`, `tenantAppendTx`, sesyjne 8 s puli (SET LOCAL kończy się z transakcją), ścieżka z bramką
(walidatory przy starcie, w `tenantTx` stałe `true`). Wyników nie zapamiętujemy — walidatory biegną przy każdym
`tenantTx` jak dotąd.

Pomocnicze obejścia w testach (`relaxPoolTimeouts` w `tests/failure-helpers.ts`, podmiana
`statement_timeout=8000` → `120000` w opcjach puli w `tests/developer.test.ts` i podobnych) nie są już potrzebne
dla preflightu; zostają bez zmian, bo należą do innych torów i mogą nadal chronić długie zapytania fikstur.

Sprawdzone: `tests/db-runtime-preflight-timeout.database.test.ts` (opt-in:
`DYNA_PREFLIGHT_TIMEOUT_TEST_DATABASE=<klon>`) na `dynaminds_s0_20261026_01` — walidator spowolniony
`pg_sleep(9)` dopisanym do `SELECT operative_delivery_valid()` na klientach puli: przed zmianą 57014
(2 z 4 niezaliczone), po zmianie 4/4; w środku `tenantTx` nadal `statement_timeout` i `lock_timeout` = `8s`,
`pg_sleep(9)` w transakcji tenanta pada z 57014, a sesja puli po preflighcie ma `8s`. Smoke
`tests/developer.test.ts` na świeżym `dynaminds_s0_20261026_02`: 22/22 zaliczone, 0 niezaliczonych (ok. 29 min, `scratchpad/pf/dev02.txt`); order-split po przeniesieniu eksportu (b5f8ad8) 28/28. `npx tsc --noEmit -p .` czysto, testy base-wire 318/318, `tests/release-migrations-*.test.mjs` 172/172.

## MIG-2: suma kontrolna zastosowanej migracji (migracja 244, 27.10.2026)

- **Rejestr**: `migration_checksums(name, file, bytes, sha256, origin, recorded_at)` z
  `server/244_custom_events_checksums.sql`, klucz `(name, file)`; jeden wiersz na każdy plik, który `migrate()`
  wykonuje: plik główny migracji i pliki towarzyszące (`MIGRATION_COMPANION_FILES` w
  `server/migration-bootstrap.ts`: 199 przy 198, 188_consumer_credit_structure, wms-stocktake-invariants,
  108_b2b_dropship_dispatch). Tylko właściciel: bez RLS, bez uprawnień dla `PUBLIC` i `dyna_app`, brak danych
  tenantów. Pliki czyta ten sam czytnik zasobów wydania co `migrate()` (`readRuntimeResource('sql:server/…')`).
- **Zapis**: po serii, przed `COMMIT` (`recordMigrationChecksums`, `server/db.ts`), każdy wykonany plik bez wiersza
  dostaje jeden: `origin='applied'`, gdy jego migracja przeszła w tym biegu, `origin='baseline'`, gdy była
  zastosowana wcześniej (pierwszy start z rejestrem dopisuje 001…243 jako `baseline` z plików tego wydania). Gdy
  wszystko jest zapisane, nic się nie pisze.
- **Odmowa**: zaraz po kontroli ledgera (MIG-6), przed kopią MIG-3 i przed jakąkolwiek migracją,
  `assertMigrationChecksums` porównuje zapisane wiersze z plikami wydania (bajty i sha256). Różnica albo brak
  pliku = `MigrationChecksumError`, kod `MIGRATION_CHECKSUM_MISMATCH`, lista `changed` (nazwa i plik) i polski
  komunikat; ledger i rejestr zostają bez zmian. Kopia starsza niż 244 nie ma rejestru: nic się nie czyta ani
  nie pisze, do czasu zastosowania 244.
- **Dowód**: `tests/migration-checksums.test.ts` (bez bazy) i `tests/migration-checksums244.database.test.ts` na
  klonie zmigrowanym przez wydanie sprzed 244: `migrate()` stosuje 244 i późniejsze (od 27.10.2026 także 245, 246 i 247, od 28.10.2026 także 248, 249, 250, 251, 252 i 253, od 29.10.2026 także 254, 255, 256, 257, 258, 259, 260, 261 i 262, od 30.10.2026 także 263), ich
  wiersze to `applied`, 001…243 `baseline`, drugi start nic nie pisze, podmieniona suma = odmowa bez zmian w bazie. Szczegóły:
  [CUSTOM-EVENTS244-20261027](CUSTOM-EVENTS244-20261027.md).

## MIG-1: runner migracji (28.10.2026)

- **Kolejność:** program wydania z `server/db.ts` (literalne 001–209, potem lista `RELEASE_MIGRATIONS`); jedyny
  wyjątek historyczny 198 przed 189 pilnuje `tests/source-ddl-migration-plan.test.mjs` (5/5, zielony od MIG-7).
- **Transakcja:** cała oczekująca seria w jednej transakcji, świadomie: błąd dowolnej migracji wycofuje wszystkie,
  więc baza zostaje w stanie N i wydanie N startuje bez odtwarzania (MIG-6 odmówiłby bazy częściowo zmigrowanej).
  Błąd ma `MigrationFailedError` (`MIGRATION_FAILED`, `migration`, `file`, `series`, `cause`).
- **Blokada:** ta sama `pg_advisory_xact_lock(982376)`, ale druga instancja czeka na nią do 600 s
  (`acquireMigrationLock` w `server/migration-bootstrap.ts`: `SET LOCAL lock_timeout`/`statement_timeout` na czas
  jednej instrukcji, potem `TO DEFAULT`, czyli z powrotem 8 s / 120 s sesji). Wcześniej czekała 8 s i padała surowym
  55P03. Dłużej = `MigrationLockTimeoutError` (`MIGRATION_LOCK_TIMEOUT`), nic nie zmienione.
- **Tabela wersji:** `public.migrations(name, applied_at)` z kontrolą tożsamości (`ensureMigrationRegistry`) i sumy
  `migration_checksums` (MIG-2).
- CLI wydania wypisuje `code` i `message` dla `MIGRATION_FAILED`, `MIGRATION_LOCK_TIMEOUT`,
  `MIGRATION_LEDGER_NEWER_THAN_RELEASE`, `MIGRATION_CHECKSUM_MISMATCH` (jak dotąd `MIGRATION_BACKUP_FAILED`).
- **Dowód:** `tests/migration-runner.database.test.ts` na klonach z danymi wydania N (243, oczekujące 244–248):
  przed zmianą czerwony (surowe 42P07; 55P03 po 8 s w obu testach blokady), po zmianie 3/3: 248 pada po 244–247 w tej
  samej transakcji → ledger, rejestr i obiekty 244–248 jak przed startem, po usunięciu przyczyny ten sam start stosuje
  wszystko; budżet 2 s → odmowa po 2,0 s; dwa starty czekają 11 s za trzymaną blokadą, jeden stosuje serię, drugi nie
  ma nic do zrobienia. Bez bazy: `tests/migration-bootstrap.test.ts`, `tests/ordinary-local-cli.test.ts` (czerwony
  14/15 → 15/15). `server/db.ts` ponownie przypięty w rejestrze stock-writer (odwrócenie do Source244 w teście pokrycia).

## MIG-4: sprawdzone cofnięcie N+1 → N (28.10.2026)

`npm run release:rollback -- --backup <kopia MIG-3> --confirm <baza N+1>` (`server/release-rollback.ts`): zgoda
operatora, N+1 zatrzymane, kopia pasuje do bazy i jest starsza od aktualizacji, odtworzenie do nowej bazy
(`restoreBackup` z `purpose:'rollback'`, `preview_only:false`), kontrola ledgera, `rollback.json`; baza N+1 bez
zmian. Procedura, kryteria i wariant PITR: [release-upgrade-rollback.md](../release-upgrade-rollback.md).
Dowód: próba 28.10 (N+1 zmigrowane z kopią → cofnięcie 26,7 s → N startuje na odtworzonej bazie, 713/713 tabel
identycznych z N, odczyty i zapisy N przechodzą), `tests/release-rollback.test.ts` 5/5,
`tests/release-rollback.database.test.ts` 1/1.

## MIG-5: dane N w N+1 (28.10.2026)

Wspólna uprząż na danych zamiast pojedynczych testów migracji: wydanie N (`25eabe8`, 243) zapisuje dane przez HTTP
(`stage3-acceptance run`, `upgrade-acceptance seed`), N+1 (HEAD) migruje je z kopią, potem porównanie tabel
(`table-fingerprints.mjs`), modele odczytu N (`upgrade-acceptance verify`, `stage3 after-upgrade`) i dalsze procesy
na danych N (`upgrade-acceptance continue`: zamówienia, dokumenty, płatności, zwrot przez portal, KOR-S, KSeF, WMS
partie), wszystko co do grosza. Wyniki: [release-upgrade-rollback.md](../release-upgrade-rollback.md#próba-na-danych-mig-5-i-cofnięcia-mig-4-28102026).

## Co zostaje w S1

- Wspólne `migrateUpTo(n)` dla testów pojedynczych migracji (142–149 kopiują pętlę runnera) — niezrobione.
- PITR → start N (zachowanie zapisów N+1 po aktualizacji) — opisane, niećwiczone.
- Zwrot do partii WMS w uprzęży MIG-5 (`wms_lots` w przyjęciu zwrotu) — niepokryte.
