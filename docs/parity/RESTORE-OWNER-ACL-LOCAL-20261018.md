# Lokalne odtworzenie jawnych ACL — 18.10.2026

**PASS w zakresie publicznego normalizatora po świeżym restore209.** Rzeczywisty proces Root24018 zakończył się EXIT0 ze statusem `ACTUAL_PUBLIC_NORMALIZER_RESTORE_ACCEPTED_NO_APP_ACTIVATION`.

## Co odebrano

`pg_dump` pomija jawną reprezentację ACL równą prawom domyślnym. Efektywne uprawnienia pozostają takie same, lecz zmienia się `acl_null`, co narusza ścisłe porównanie metadanych. Poprzedni normalizator walidował209 przed naprawą i nie obejmował pięciu nowszych tabel po projekcji do189.

Poprawiony `server/ordinary-legacy-schema.mjs` dopuszcza wyłącznie `acl_null:true→false`, gdy cały zmieniony rekord odpowiada stałemu oczekiwaniu źródłowemu189 lub pełnemu rekordowi207/208/209. Pełne porównanie proponowanego katalogu poprzedza pierwszy GRANT; końcowa kontrola pozostaje przed COMMIT. Kontrakty i oczekiwania nie zostały zmienione.

- Utworzono tylko nową bazę `dynaminds_acl_normalizer_1792323576772` na istniejącym PG03:57083, z właścicielem `postgres` i osobnym znacznikiem własności. Przywrócono istniejące archiwum37901216B przez przypięty `pg_restore18.6`: EXIT0, zero stderr i potwierdzone zamknięcie procesu.
- Bez ręcznego GRANT ani wstępnej naprawy wywołano bezpośrednio publiczny normalizator. Przywrócił232 jawne ACL. Cała procedura trwała **22,170s**; nie jest to czas jednej bramy ani pomiar p95.
- Wszystkie **40503 rekordy metadanych** po normalizacji odpowiadają źródłu: rodzaj/klucz, długości i SHA256 całych rekordów. Wektor naprawionej kopii odpowiada źródłowemu digestowi `84a6bc9a…`; początkowo kopia różniła się dokładnie232 reprezentacjami ACL. Potwierdzono37 tenantów, migrację209 i zero włączonych lokalnych opt-inów workerów.
- Na odtworzonej bazie209 zwróciło TRUE w23,059ms, a187 TRUE w4473,649ms. Odczyty źródła przed i po próbie również były TRUE. Odczyty i kontrole miały limit8s; utworzenie i oznaczenie nowej bazy, jako administracyjny DDL, miały limit120s.
- Zachowano normalne triggery: generacja182 **1469→1701(+232)**, `dirty=true`; `validated_generation`, `contract_id`, `release_sha256`, `native_sha256` i `profile_native_sha256` są NULL. Bez resetu epoki, zatwierdzenia runtime lub reseal.
- Potwierdzono zamknięcie klientów target/source/admin. Nie zmieniono źródłowej bazy ani istniejącej kopii workerów. Nie uruchomiono aplikacji ani workerów.

## Testy i dowody

Skupiony zestaw `tests/ordinary-legacy-schema.test.mjs`: **7/7PASS,0SKIP**,12,361s. Rzeczywiste projektory209→208→207 obejmują pięć nowszych tabel, starsze obiekty/prywatny schemat/sekwencję, idempotencję, odmowę przed GRANT przy zmianie właściciela/praw/nagłówka/zakresu oraz rollback po końcowej niezgodności. IO i starsza baza hashy189 są kontrolowane; te testy nie są odbiorem aplikacji.

Przebieg przypinał32 pliki zależności:31 zgodnych bajtowo z kanonicznym grafem730 źródeł i zmieniony normalizator `8f218bdb…`. Piny sprawdzono przed i po wykonaniu; finalny test ma SHA256 `673dd3da…`.

Dowody prywatne, bez danych połączenia:

- [Receipt rzeczywistego przebiegu](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/durable-normalizer-restore-prepared-1792323576719/receipt.private.json):7807B, SHA256 `48ae6f519a81f19e8b27c26a62a1dc1e7d869fab114584859048c03f61363dec`.
- [Specyfikacja](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/durable-normalizer-restore-prepared-1792323576719/spec.private.json):14635B, SHA256 `3fa0ea4eaa9ace8c11e7c922676a751234598a8c4572c84815ee674617b307b7`.
- [Graf i jedyna zmiana źródła](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/durable-normalizer-restore-prepared-1792323576719/source-graph-proof.private.json):2089B, SHA256 `8ebb4a39de8634c6fdb0d15c6415a70e5a10fd5989ad8fcdd4646d737545f80c`.
- [Przegląd Root przed wykonaniem](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/durable-normalizer-restore-prepared-1792323576719/root-acceptance-review.private.json):724B, SHA256 `de422154e38d5e094f5dedc8d06457e0340b075bf7c44322696a45772fd1ca0e`.
- [Przegląd Root po zakończeniu](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/durable-normalizer-restore-prepared-1792323576719/root-terminal-review.private.json):748B, SHA256 `43bbd433cfcd6969da4838a53007a0b4105cd3dc7bf97c458b8491aa64fbde25`.

**Granica:** wykonano bezpośrednio nowy kod źródłowy normalizatora. Kanoniczne wydanie09158 go nie zawiera; jego oddzielną kopię workerów naprawiono wcześniej ręcznie, zgodnie ze źródłem. Ten wynik nie stanowi odbioru jednego wspólnego wydania, pełnego restore przez UI, wszystkich danych biznesowych, lifecycle workerów ani Split210.

## Następny odbiór: normalny start z poprawką we wspólnym pakiecie

Root uruchomił nowe kanoniczne wydanie `bd46ebfaaa0e3c4f8d260243ce6ea175e892bd204f6b8ab8b4b7eff0335afa7d`, zawierające normalizator oraz poprawkę prezentacji UI. Niezależny pełny validator potwierdził379 plików i99411351B, w dotychczasowym limicie96MiB. Przed startem na nowej kopii `dynaminds_worker_acceptance_1792324608467` nie wykonano ręcznych GRANT ani bezpośredniego wywołania normalizatora. Odtworzenie przypiętego archiwum zakończyło się EXIT0; kopia miała dokładnie232 różnice reprezentacji domyślnych ACL i kontrolę209 FALSE.

Zwykły `tools/local/stack.mjs start`, z oryginalnym kluczem szyfrowania, osiągnął READY. Niezależny odczyt Root zakończył się EXIT0 ze statusem `PASS_BUNDLED_NORMALIZER_GENUINE_ORDINARY_STARTUP`:

- Wszystkie40503 rekordy metadanych odpowiadają źródłowemu wektorowi `84a6bc9a618d570971bea1b72fd101ca235da6505fd0816882de831ac81fe05d`.
- Normalna generacja182 zmieniła się1469→1702:232 naprawy ACL i jeden zwykły DDL migratora. `dirty=false`, `validated_generation=1702`, zatwierdzone wydanie dokładnie `bd46ebfa…`; pozostałe pola kontrolne odpowiadają źródłowemu profilowi. Bez resetu epoki lub ręcznego zatwierdzenia.
- Kontrole209 i187 zwróciły TRUE odpowiednio w25,594ms oraz4712,852ms, z niezmienionym limitem8s. To pojedyncze odczyty, bez deklaracji p95.
- Przed utworzeniem nowych fikstur potwierdzono37 tenantów i globalnie0 lokalnych opt-inów. Health wskazał209, `restore_preview=false`, scoped automation włączone i globalne background workers wyłączone. Transakcja odczytowa została wycofana, a klient zamknięty.

[Przegląd zwykłego startu Root](../../../../local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-normal-startup-review.private.json):1956B, SHA256 `3bdc86c21fcdc3d18a3e905b70ded990e655c4576e274d385c0c2c44fbfac0fa`.

Ten wynik domyka brak potwierdzenia poprawki normalizatora w zwykłym starcie aplikacji. Nie obejmuje jeszcze pełnego backup/restore plików i niepustej kolejki, uzgodnienia wszystkich danych biznesowych, skali ani całego Goala. Późniejszy [odbiór sterowania regułami przez UI dwóch firm](WORKER-UI-CONTROL-LOCAL-20261018.md) na tym samym wydaniu zakończył się końcową kontrolą Root. Własny stack i SMTP zamknięto poprawnie; porty4104/50171 są wolne, Main/APP16 i dotychczasowy SMTP1025 zachowane.
