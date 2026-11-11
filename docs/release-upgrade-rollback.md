# Aktualizacja wydania N → N+1 i cofnięcie do N (MIG-1, MIG-4, MIG-5)

Procedura operatora dla instalacji lokalnej (jedna baza PostgreSQL, wydanie spakowane `tools/scale/release-build.mjs`
albo start ze źródeł). Uzupełnia runbook MIG-8 w [MIGRATIONS-S1](parity/MIGRATIONS-S1-20261026.md#mig-8-runbook-wydania-kopia--migracja--weryfikacja--cofnięcie).
Down-migracji nie ma i nie będzie: bazę cofamy kopią sprzed aktualizacji, do **nowej** bazy.

## Co gwarantuje start N+1 (MIG-1, MIG-2, MIG-3, MIG-6)

`migrate()` przy starcie, w jednej transakcji pod blokadą doradczą `982376`:

1. czeka na blokadę do 600 s, gdy migruje inna instancja (potem `MIGRATION_LOCK_TIMEOUT`, nic nie zmienione);
2. odmawia bazy nowszej niż wydanie (`MIGRATION_LEDGER_NEWER_THAN_RELEASE`) i zmienionych plików migracji (`MIGRATION_CHECKSUM_MISMATCH`);
3. robi szyfrowaną kopię do `<dane>/backups/pre-migration/<id>.dyna` (+ raport `<id>.dyna.json`), gdy są oczekujące migracje;
4. stosuje całą serię; błąd dowolnej migracji (`MIGRATION_FAILED`, nazwa migracji i przyczyna) wycofuje **całą** serię:
   baza zostaje dokładnie w stanie N i wydanie N startuje na niej bez odtwarzania.

Każda z tych odmów trafia do linii `ORDINARY_LOCAL_START_FAILED` z `code` i `message` (hasło zamaskowane).

## Procedura

### A. Przed aktualizacją (N działa)

1. Zapisz rewizję N (`GET /api/health` → `revision`, `schema_revision`, od 29.10 także `rate_limit`) i ścieżkę wydania N; wydania N nie usuwaj.
2. Opcjonalnie niezależna kopia: `npm run backup -- create --directory <prywatny katalog>`.
3. Przy fizycznym PITR (instancja Docker, `tools/recovery/README.md`): `node tools/recovery/pitr.mjs restore-point --source <kontener> --name before_upgrade_<N+1>`.

### B. Aktualizacja

1. Zatrzymaj wszystkie procesy N (serwer, worker, runtime lokalny).
2. Uruchom N+1 z `DYNA_MIGRATION_BACKUP=required` (domyślnie) i `DYNA_IMAGE_DIR` ze zdjęciami tej bazy.
   Kopia trafia do `<DYNA_DATA_DIR>/backups/pre-migration`, klucz do `<DYNA_DATA_DIR>/.recovery-key`.
   Jeśli N miało `DYNA_RATE_LIMIT_PER_MIN`, przekaż tę samą wartość do N+1.
   - Zmienna oznacza limit żądań na minutę z jednego adresu klienta. Dozwolona wartość to liczba całkowita od 60 do 100 000.
   - Bez zmiennej limit wynosi 600.
   - Inna wartość zatrzymuje start przed `migrate()` z `code: RATE_LIMIT_CONFIG_INVALID`.
   - Wydania sprzed 29.10.2026 mają stałe 600 i ignorują tę zmienną.
   - Decyzja i kontekst: [LOAD-TEST-FULL-20261029 §4.1](scale/LOAD-TEST-FULL-20261029.md#41-limit-600-żądańmin-na-adres-klienta-produkt-serverappts764).
3. Odmowa startu w kroku 1–4 powyżej nic nie zmienia w bazie: popraw przyczynę albo uruchom z powrotem N (sekcja D, wariant 1).

### C. Weryfikacja N+1

Kryteria (wszystkie muszą przejść, inaczej sekcja D):
- `/api/health` → nowa `revision`, `schema_revision` = ostatnia migracja N+1;
- `SELECT count(*), max(name) FROM migrations` = program N+1; strażnicy z MIG-8 (sesja `SET jit=off; SET timezone='UTC'`) `true`;
- logowanie i jeden zapis biznesowy (zamówienie, faktura) działają;
- przy próbie: `tools/parity/table-fingerprints.mjs --compare` z migawką N (różnią się tylko `migrations` i `ordinary182_runtime_generation`).

### D. Cofnięcie do N

**Wariant 1: start N+1 odmówił (seria wycofana).** Ledger jest N. Uruchom wydanie N na tej samej bazie. Nic nie odtwarzamy.

**Wariant 2: N+1 zmigrował bazę, ale nie przechodzi weryfikacji.** Wydanie N na tej bazie nie wystartuje (MIG-6, zamierzone).

1. Zatrzymaj wszystkie procesy N+1. Skrypt sprawdza, że nikt inny nie jest połączony z bazą N+1.
2. Cofnięcie (z checkoutu źródeł N+1, `DATABASE_URL` = baza N+1, `DYNA_LOCAL_CONFIG_PATH` = konfiguracja instalacji):

   ```sh
   npm run release:rollback -- --backup <dane>/backups/pre-migration/<id>.dyna --confirm <nazwa bazy N+1> \
     --key-file <dane>/.recovery-key --directory <dane>/restores
   ```

   Bez `--confirm <nazwa bazy N+1>` nic się nie dzieje. Skrypt odmawia też, gdy raport kopii nie pasuje do pliku
   (sha256), pochodzi z innej bazy albo nie jest starszy niż aktualizacja. Odtwarza kopię do nowej bazy
   `dynaminds_restore_<hex>` (ta sama weryfikacja co podgląd: wiersze, schemat, RLS, uprawnienia, zaszyfrowane rekordy),
   sprawdza, że jej ledger to dokładnie stan sprzed aktualizacji, i zapisuje `rollback.json` w katalogu odtworzenia.
   Inny ledger = odtworzona baza usunięta, nic więcej się nie zmienia.
3. Skieruj wydanie N na bazę z wyniku: `DATABASE_URL` → `database`, konfiguracja → `config`
   (klucz szyfrowania z kopii, hasło klastra bieżące), `DYNA_IMAGE_DIR` → `images`. Uruchom N.
4. Weryfikacja N: `/api/health` → rewizja N i `schema_revision` N; logowanie, odczyt dokumentów, jeden zapis.
5. Baza N+1 zostaje bez zmian do analizy; usuń ją dopiero po decyzji (`DROP DATABASE`, operacja nieodwracalna).
6. Usuń z katalogu odtworzenia `database.dump` (niezaszyfrowany dump zostawiany przez `restoreBackup`), gdy N działa.

**Utrata danych:** kopia jest z chwili tuż przed migracją (`data_lost_after` w wyniku). Zapisy wykonane w N+1 po
aktualizacji nie wracają. Gdy N+1 przyjął już zapisy, których nie wolno stracić: fizyczny PITR do punktu
`before_upgrade_<N+1>` albo do czasu (`tools/recovery/pitr.mjs restore --target-time …` na nowy kontener,
[RECOVERY-DRILL-20261027](scale/RECOVERY-DRILL-20261027.md)) i ręczne odtworzenie zapisów z bazy N+1.
Ścieżka PITR → start N nie była ćwiczona w próbie z 28.10 (niepotwierdzone; sprawdzone tylko odtworzenie do punktu i start tego samego wydania).

## Próba na danych (MIG-5) i cofnięcia (MIG-4), 28.10.2026

Narzędzia w repozytorium (wszystko po zwykłym HTTP z ciasteczkiem sesji, bez SQL w krokach biznesowych):

| Narzędzie | Rola |
|---|---|
| `tools/scale/release-build.mjs --commit <sha>` | wydania N i N+1 z dokładnych commitów |
| `tools/parity/stage3-fakes.mts` | lokalne atrapy: drukarka fiskalna, KSeF 229/243, port sterujący |
| `tools/parity/stage3-acceptance.mjs run` / `after-upgrade` / `after-restart` | finanse etapu 3 (FV 157, FV-S 230, EUR, KOR-S, paragony, PayU, KOR 188/206, KSeF, JPK, rozliczenia, RODO) |
| `tools/parity/upgrade-acceptance.mjs seed` / `verify` / `continue` | portal, zamówienia w toku, płatności, zwrot przez portal, KOR-S 232, KSeF z konfiguracją N, WMS partie (otwarcie, PZ, FIFO, wycena) |
| `tools/parity/table-fingerprints.mjs` | liczność i skrót każdej tabeli na kolumnach N |
| `npm run release:rollback` | cofnięcie (sekcja D) |

Przebieg:

1. Klon `dynaminds_mig145_20261028_05` z szablonu `dynaminds_restore_36751abef3079f3f` (ledger 207); wydanie N
   (`25eabe8`, ostatni commit przed 244 z zielonym rejestrem stock-writer; `8c83dc9` odpada, bo jego `db.ts` nie ma
   przypiętego skrótu) migruje do 243.
2. Na N: `stage3-acceptance run` i `upgrade-acceptance seed` + `verify`. Migawka tabel `fp-N`.
3. Klon `_08` z `_05`; start N+1 (`0c3a405`, HEAD tej gałęzi) z `DYNA_MIGRATION_BACKUP=required`: kopia
   `mvrghy9i-319d2105f5b75ef9` (233 migracje), potem 244–248.
4. Na N+1: porównanie tabel, `upgrade-acceptance verify` i `continue`, `stage3-acceptance after-upgrade`, świeży `stage3-acceptance run` (nowe firmy na zaktualizowanej bazie).
5. Stop N+1, `npm run release:rollback … --confirm dynaminds_mig145_20261028_08` → `dynaminds_restore_b5a252dc7eebd8a4`.
6. Start N na odtworzonej bazie; porównanie tabel z `fp-N`, `verify`, `stage3-acceptance after-restart`, `continue` (zapisy na N).

Konfiguracja próby: hasło PG04 z `local-builds/test-harness/pg04-test-config.json` i klucz szyfrowania szablonu
(jego katalogu odtworzenia), bo szablon ma zaszyfrowane `channels` innym kluczem niż konfiguracja testowa i z samą
konfiguracją testową odtworzenie (słusznie) odmawia (`Unsupported state or unable to authenticate data`).

| Krok | Wynik |
|---|---|
| N: `stage3 run` | 355/357; 2 niezaliczone to znany błąd N (raport rozliczeń bez KOR 206, poprawiony w `7ba753a` po 244) |
| N: `seed` + `verify` | 10/10 + 2/2 (17 modeli odczytu: zamówienia, płatności, portal, dokumenty, konfiguracja KSeF, pozycje/wycena/operacje/alokacje WMS) |
| N+1: tabele vs N | 711/713 identyczne; różnią się tylko `migrations` (233 → 238) i `ordinary182_runtime_generation` (DDL); 17 nowych tabel 244–248; żadna nie zniknęła |
| N+1: `verify` | 2/2: każdy model odczytu N identyczny na polach N, co do grosza |
| N+1: `stage3 after-upgrade` | 20/20: 19 dokumentów, JPK V7M/V7K/FA obu firm bez zmian; raport rozliczeń A bez zmian, B poprawiony przez N+1 do dokładnie oczekiwanych wartości (4401, 2700, −2700, 1701, `zgodne`) |
| N+1: `continue` | 10/10: zamówienie opłacone w N wysłane i zafakturowane (FV 157 = 3×45,50); anulowanie zamówienia z N; FV 157 z N wysłana do KSeF z konfiguracją z N; zwrot przez link portalu z N, zwrot pieniędzy 19,99, KOR-S 232 do FV-S z N (−19,99), rozliczenie `zgodne`; WMS: PZ2 13,00, FIFO przez partię z N (3×12,00) i nową (2×13,00), wycena 2×13,00 |
| N+1: świeży `stage3 run` | 357/357 (drugi przebieg); pierwszy 355/357 — patrz „Otwarte” |
| Cofnięcie | 26,7 s (odtworzenie i kontrola), ledger 233 (`243_ksef_purchase`), usunięte 244–248, baza N+1 bez zmian |
| N na odtworzonej bazie | start czysty (brak oczekujących migracji, bez kopii); tabele 713/713 identyczne z `fp-N`; `verify` 2/2; `stage3 after-restart` 20/20 (ta sama rewizja N); `continue` 10/10 (zapisy na N działają) |

Dowody (bez sekretów): `local-builds/full-base-preview-20261017/mig145-evidence-20261028/` (wyniki JSON każdego kroku,
porównania tabel, `rollback.json`, TAP testów bazodanowych). Wydania: `mig145-N243-20261028-02`, `mig145-N1-20261028-01`.

Testy bazodanowe (opt-in, klony `dynaminds_mig145_20261028_NN` z danymi N):
- `tests/migration-runner.database.test.ts` (MIG-1) 3/3;
- `tests/release-rollback.database.test.ts` (MIG-4: migrate z kopią → odmowa bez zgody i przy działającym N+1 →
  cofnięcie → ledger N, każda tabela N wiersz w wiersz, baza N+1 bez zmian) 1/1.
- Po integracji na `goal/full-base-20261017` za 249 i 250 (28.10.2026) oba testy oczekują serii 244–250 (siedem
  oczekujących migracji; komunikat serii `244_custom_events_checksums … 250_wms_evidence_settle_unlocked`, ciało
  rozliczenia 250 po udanym starcie) i przyjmują też klony `dynaminds_m250_20261028_NN`: na klonach `_04`/`_05`
  (szablon + 218…243 z wierszami ledgera) 3/3 i 1/1 ([WMS-LOCK250](parity/WMS-LOCK250-20261028.md)).
- Po integracji 251 (28.10.2026) seria to 244–251 (osiem oczekujących migracji; komunikat serii kończy się na
  `251_b2b_network_lifecycle`, po udanym starcie jest też `b2b258_link_states`), klony także `dynaminds_m251_20261028_NN`:
  MIG-1 3/3 na `_05`, MIG-4 1/1 na `_07` ([B2B-LIFECYCLE251](parity/B2B-LIFECYCLE251-20261028.md)).
- Po integracji 252 (28.10.2026) seria to 244–252 (dziewięć oczekujących migracji; komunikat serii kończy się na
  `252_mirakl_operations`, po udanym starcie jest też `mirakl262_operations`), klony także `dynaminds_m252_20261028_NN`:
  MIG-1 3/3 na `_05`, MIG-4 1/1 na `_06` ([MIRAKL252](parity/MIRAKL252-20261028.md)).
- Po integracji 253 (28.10.2026) seria to 244–253 (dziesięć oczekujących migracji; komunikat serii kończy się na
  `253_mirakl_webhook_retention`, po udanym starcie jest też indeks `mirakl263_webhook_events_received`), klony także
  `dynaminds_m253_20261028_NN`: MIG-2 1/1 na `_04`, MIG-1 3/3 na `_05`, MIG-4 1/1 na `_06`
  ([MIRAKL252](parity/MIRAKL252-20261028.md), „Integracja retencji jako 253”).
- Po integracji 254 (29.10.2026) seria to 244–254 (jedenaście oczekujących migracji; komunikat serii kończy się na
  `254_carrier_returns`, po udanym starcie jest też `carrier261_returns`), klony także `dynaminds_m254_20261029_NN`:
  MIG-2 1/1 na `_06`, MIG-1 3/3 na `_07`, MIG-4 1/1 na `_08`
  ([CARRIER-DPD-INPOST-L3](parity/CARRIER-DPD-INPOST-L3-20261028.md), „Integracja jako 254”).
- Po integracji 255 (29.10.2026) seria to 244–255 (dwanaście oczekujących migracji; komunikat serii kończy się na
  `255_stock_verdict`; 255 dodaje tylko sześć funkcji `stock_verdict_`), klony także `dynaminds_m255_20261029_NN`
  ([CATALOG-STOCK-GEN270](parity/CATALOG-STOCK-GEN270-20261029.md), „Integracja jako 255”); MIG-1/2/4 na serii
  po 258: dokument 258.
- Po integracji 256 (29.10.2026) seria to 244–256 (trzynaście oczekujących migracji; komunikat serii kończy się na
  `256_return_receipt_verdicts`; 256 dodaje jedną funkcję), klony także `dynaminds_m256_20261029_NN`
  ([RETURN-RECEIPT-GEN272](parity/RETURN-RECEIPT-GEN272-20261029.md), „Integracja jako 256”); MIG-1/2/4 po 258.
- Po integracji 257 (29.10.2026) seria to 244–257 (czternaście oczekujących migracji; komunikat serii kończy się na
  `257_order_merge_snapshot_index_paths`; 257 zmienia tylko ciało migawki 209), klony także `dynaminds_m257_20261029_NN`
  ([MERGE209-SNAPSHOT-GEN271](parity/MERGE209-SNAPSHOT-GEN271-20261029.md), „Integracja jako 257”); MIG-1/2/4 po 258.
- Po integracji 258 (29.10.2026) seria to 244–258 (piętnaście oczekujących migracji; komunikat serii kończy się na
  `258_wz_issuer_refresh`), klony także `dynaminds_m258_20261029_NN`: MIG-2 1/1 na `_06`, MIG-1 3/3 na `_07`, MIG-4 1/1 na
  `_09` (zdjęcie szablonu w `DYNA_IMAGE_DIR` jak w biegu 254; na `_08` bez niego kopia odmówiona)
  ([WZ-ISSUER-GEN273](parity/WZ-ISSUER-GEN273-20261029.md), „Integracja jako 258”).
- Po integracji 259 (29.10.2026) seria to 244–259 (szesnaście oczekujących migracji; komunikat serii kończy się na
  `259_jobs_running_lease`; 259 dodaje tylko jeden indeks częściowy na `jobs`), klony także `dynaminds_m259_20261029_NN`
  ([SCOPED-CLAIM-P275](parity/SCOPED-CLAIM-P275-20261029.md), „Integracja jako 259”); MIG-1/2/4 po 262.
- Po integracji 260 (29.10.2026) seria to 244–260 (siedemnaście oczekujących migracji; 260 dodaje tylko jeden indeks
  częściowy na `automation_runs`), klony także `dynaminds_m260_20261029_NN`
  ([QUEUE-COUNTERS-P276](parity/QUEUE-COUNTERS-P276-20261029.md), „Integracja jako 260”); MIG-1/2/4 po 262.
- Po integracji 261 (29.10.2026) seria to 244–261 (osiemnaście oczekujących migracji; komunikat serii kończy się na
  `261_stocktake_evidence_usage`; 261 dodaje dwie tabele liczników i zmienia dwa ciała 149), klony także
  `dynaminds_m261_20261029_NN` ([STOCKTAKE-USAGE-P277](parity/STOCKTAKE-USAGE-P277-20261029.md), „Integracja jako 261”);
  MIG-1/2/4 po 262.
- Po integracji 262 (29.10.2026) seria to 244–262 (dziewiętnaście oczekujących migracji; komunikat serii kończy się na
  `262_revoke_public_temporary`; 262 zmienia tylko ACL bazy), klony także `dynaminds_m262_20261029_NN`: MIG-2 1/1 na `_06`,
  MIG-1 3/3 na `_07`, MIG-4 1/1 na `_08` (zdjęcie szablonu w `DYNA_IMAGE_DIR` jak w biegu 254/258); odtworzenie kopii z 262
  ponawia blok `DO` 262, a start odmawia, gdy `dyna_app` ma `TEMPORARY`
  ([SECDEF-PGTEMP-P278](parity/SECDEF-PGTEMP-P278-20261029.md), „Integracja jako 262”).
- Po integracji 263 (30.10.2026) seria to 244–263 (dwadzieścia oczekujących migracji; komunikat serii kończy się na
  `263_manual_off_verdict`; 263 dodaje tylko sześć funkcji właściciela), klony także `dynaminds_m263_20261030_NN`: MIG-2 1/1 na `_06`, MIG-1 3/3 na `_07`, MIG-4 1/1 na `_08` (zdjęcie szablonu w `DYNA_IMAGE_DIR` jak w biegu 254/258)
  ([MANUAL-OFF-GEN281](parity/MANUAL-OFF-GEN281-20261030.md), „Integracja jako 263”).

## Otwarte

- Świeży `stage3 run` na N+1: w 1 z 3 przebiegów na tym samym commicie `POST /api/local-consumer-credits/previews`
  (KOR 188) dał 409 „Dane dokumentu, zwrotu lub numeracji zmieniły się” zaraz po odczycie źródła 188; powtórzenie 357/357.
  Przyczyna niepotwierdzona (kandydat: zmiana wersji zwrotu w tle między odczytem źródła a podglądem).
- PITR → start N (wariant z zachowaniem zapisów N+1) niećwiczony.
- `continue` nie obejmuje zwrotu do partii WMS (`wms_lots` w przyjęciu zwrotu).
- Testy pojedynczych migracji (142–149) nadal kopiują pętlę runnera; wspólne `migrateUpTo(n)` niezrobione.
