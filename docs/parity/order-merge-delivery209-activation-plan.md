# Aktywacja209: wykonawcza lista integracji

Status18.10.2026: **Source18 Native37/37 i file-only inverse zaakceptowane; integracja źródłowa oraz pakiet12 gotowe, rzeczywisty start i odbiór biznesowy w toku**. Wszystko lokalnie, bez zwiększenia limitów. Poniższa lista rozdziela wykonany kod od wymaganych rzeczywistych bramek. [Dowody Source18](order-merge-delivery-inheritance.md).

`H` poniżej oznacza `shared/large-import-dependencies/pim-large-import173-business-traversal-ui`.

Warunek wejścia spełnił Source18 SQL9e25: pełny source compiler, niezależny przegląd metadanych, niezmienione certyfikaty poprzedników oraz rzeczywiste37/37 Native QA (pierwotne30 i7 nowych grup kolumn/CHECK) przy istniejących budżetach. Native nie zastępuje późniejszej instalacji ani biznesowego MERGE. Historyczne nieudane próby pozostają zachowane.

## 1. Utrwalić dokładny kontrakt bieżącego209

Punkty kodu: `tools/parity/order-merge-delivery209-inverse.mjs`, `tools/parity/order-merge-delivery209-catalogue.mjs:41`; proponowany nowy, źródłowy kontrakt runtime w `H/order-merge-delivery209-source-contract.mjs`.

- [ ] Z udanej, przypiętej kompilacji utrwalić pełne14 zmian BEFORE/AFTER i cały roster dodatków, włącznie z zewnętrznymi triggerami/constraint oraz wszystkimi powiązanymi RI. Przypiąć SQL, program źródłowy, receipt i pełne katalogi. Nie wyprowadzać oczekiwania z działającej biznesowej bazy.
- [ ] Runtime ma podawać wrapperowi **stały, źródłowo przypięty expected**, nigdy argument HTTP ani wybrany przez operatora JSON. Sam wymagany argument wrappera nie uwierzytelnia oczekiwania.
- [ ] Sprawdzić bieżący pełny209→208: wszystkie rekordy, osiem liczników, kanoniczny SHA oraz pełna serializacja readera mają być równe literalnemu poprzednikowi. Missing/extra/overload/header/ACL/config/CHECK/FK/RI drift musi odmawiać. Historyczny193 jest tylko zachowanym wynikiem poprzedniego kandydata.

Bramka: focused inverse/wrapper tests oraz **nowy file-only pełny roundtrip dokładnie zaakceptowanego kandydata**. Nie tworzyć kontraktu z flagą Native/source-complete na podstawie samego roundtripu.

## 2. Zarejestrować migrację i zapewnić rzeczywisty transport zasobu

Punkty kodu: `server/db.ts:606` (obecny koniec208), `tools/build/resource-definitions.mjs` i `H/resource-definitions.mjs`.

- [ ] Dopisać jedyny następny wpis `209_order_merge_delivery_inheritance` → `./209_order_merge_delivery_inheritance.sql`, zachowując cały wcześniejszy porządek i dosłowne stare źródła. Obie listy zasobów muszą zawierać ten sam jawny zasób SQL209 dla `server/db.ts`.
- [ ] **Rozwiązać format zasobu przed buildem:** SQL209 ma około27MB, podczas gdy `H/resource-io.mjs:14–18` i oba `portable-release.mjs:13,34` dopuszczają16MiB na plik. Oba `emitted-release.mjs:17–18` sprawdzają także16MiB na członka i96MiB całości; osobna ścieżka portable ma64MiB całości. Obecny pakiet jest już blisko limitu emitted. Sam append listy nie przejdzie rzeczywistego intake.
- [ ] W implementacji wybrać i przetestować wąski, nadal ograniczony format/wyjątek dla tego źródłowo przypiętego zasobu, zgodny po stronie emitera, manifestu, readera i runtime resource IO. Ponownie zmierzyć faktyczny nowy pakiet. **Ta notatka nie zatwierdza podwyższenia limitów ani SLA.**
- [ ] Dopasować udowodnione zmienione piny źródeł, w tym wpis `server/db.ts` w `server/catalog-stock-writer-coverage.ts`; pozostałych pinów nie przyjmować automatycznie z mieszanego WIP.

Bramka: exact append/order, deepEqual obu list, hash/bytes zużywanego zasobu, odmowa podmiany/oversize/path/symlink oraz niezależny pełny przegląd faktycznego pakietu. Bez podmiany starego Source04 i starego grafu Native tylko po to, żeby intake przeszedł.

## 3. Wpiąć209 przed wszystkimi istniejącymi projekcjami katalogu

Punkty kodu: `H/packing189-cold-inspection.mjs:42,97–100,141–151`; `server/ordinary-legacy-schema.mjs:17,39`.

- [ ] W `assertPackingNativeInstallation` i `comparePackingCompiledExpectation` komponować dokładne209→208→207 przed dotychczasowym wave/full-parent compare.
- [ ] W `inspectPackingColdCompartment` wymagać aktywnego209 na rzeczywistym surowym katalogu. Do208 i dalszych kontroli207/205/204/203 przekazywać reprezentację po odwróceniu209: obecne bezpośrednie wywołania205/204 na raw209 zobaczą zmienione funkcje. Nie usuwać żadnej z dotychczasowych aktywnych kontroli ani pełnego porównania.
- [ ] Dodać ścisły marker migracji209 do istniejącego odczytu markerów189/206/207/208 w tej samej trzymanej transakcji. Zachować listener cleanup, rzeczywisty reader-root/context/XID i oryginalny raw observation. Projekcja metadanych nie staje się readerem ani autoryzacją.
- [ ] Tę samą kompozycję zastosować przed wyborem celów normalizacji ACL w `normalizeOrdinaryLegacyOwnerAcls`; jej końcowy pełny compare nadal ma wykrywać każdy inny drift.

Bramka: rzeczywiste focused cold/normalizer bodies z kontrolowanymi portami: kolejność209 przed208, wszystkie markery, nieaktywne/partial209 odmawia, brak strat przy inactive/pre205, zamknięcie tej samej TX/listenerów. Następnie rzeczywisty cold startup jednego dokładnego lokalnego wydania, bez pomijania kontroli i bez podnoszenia ich deadline.

## 4. Domknąć oddzielną28-elementową mapę poprzedników173

Punkty kodu: `H/profile-startup.mjs:101–102`; `H/packing189-cold-inspection.mjs:54` (`projectPackingOriginal173Predecessors`).

- [ ] Dodać wąską projekcję pełnych, stałych metadanych209→BEFORE209 **przed** istniejącą204/205/C30. `large_import173_predecessor_map()` jest innym wejściem niż katalog: zawiera m.in. zmienione209 `buyer_address_guards` i `manual_inventory_off_valid`. Samo wpięcie wrappera katalogu nie domknie tego porównania.
- [ ] Zachować dokładny roster28, pełne definicje/nagłówki/ACL i wszystkie stare porównania certyfikatów. Projektować tylko źródłowo określone rekordy po exact AFTER-check; nie zastępować oczekiwanych wartości aktualnym odczytem.
- [ ] Pozostawić literalny historyczny profil i certyfikaty173/166/204/205/207/208. Nowy manifest wydania ma wiązać zmieniony runtime, nie oznaczać ponownego zapieczętowania dawnych certyfikatów.

Bramka: oddzielne negatywy mapy28 (brak/extra/zmieniona definicja/ACL) oraz realny `inspectCompositeStartup` na tym samym wydaniu co katalog209. Nie utożsamiać poprawności kompozycji JS z ważnością świeżych Native guardów.

## 5. Wydać jeden preview i wykonać prawdziwy classified MERGE

Istniejące wpięcie: `server/order-merges.ts:76–88` (availability), `:184` (capture), `:1060` (technical inheritance); `server/buyer-address.ts:573–602`; `server/order-merge-routes.ts:49` i `server/app.ts:562,905,1163`. Nie potrzeba drugiej alternatywnej trasy ani flagi obchodzącej dostępność.

- [ ] Zbudować i niezależnie zweryfikować jeden immutable lokalny pakiet z powyższymi zmianami. Przygotować nowe selection/profile/manifest/revision dla zwykłego preview, zachowując wybrany lokalny DB/config, kontrolowany start/stop i brak autorestartów. Wymagać exact revision, schema `209_order_merge_delivery_inheritance`, `restore_preview:false` i rzeczywistego READY. Nie używać Main jako celu próby.
- [ ] Użyć istniejącego `tests/order-merge-ordinary-api-acceptance.mjs` z jawnym209-profile (`http://127.0.0.1:4103`, exact revision/schema), genuine fixture i trwałym sinkiem body/key przed każdym POST. Odbiór209 wykorzystuje już `tests/order-merge-delivery209-ordinary-readback.mjs`.
- [ ] Istniejący prywatny manifest `local-builds/full-base-preview-20261017/order-merge-delivery209-fixtures11-1792276127376/fixtures.private.json` opisuje realnie przygotowane źródła: główne z rzeczywistym portalowym override i włączonym opt-in oraz drugie z klasyfikacją adresu. **MERGE209 na tej parze: NOT RUN.** Przed operacją sprawdzić świeże wersje, przynależność i brak claimów. Nie rekonstruować adresu/override ani historii w SQL. Nie publikować tokenów, linku portalu lub danych adresowych.
- [ ] Odebrać oba tryby na oddzielnych przeznaczonych do tego genuine parach; wykonanie pierwszego MERGE nie uprawnia do ponownego użycia zajętych źródeł. `technical_merge` tworzy nowy cel z faktycznym effective delivery wybranego main, świeżym tokenem, zachowaną ogólną polityką/expiry portalu, ale `enabled:false` dla opt-in edycji adresu; historia celu zawiera własne `merge_inherit`, bez fikcyjnego kliknięcia kupującego. `into_main` zachowuje istniejący sidecar głównego. Zweryfikować receiver, płatność, kwoty, pozycje, ilości, dostawę i lineage po pełnym readbacku.
- [ ] W zwykłym UI odebrać wybór main przy konflikcie odbiorcy, preview, jawne potwierdzenie, wynik i ponowny odczyt po refresh. Sprawdzić original-command recovery bez nowego klucza/auto-POST oraz odmowę po zmianie IAM/źródła; odtworzona kopia pozostaje tylko do odczytu. Publiczny readback nie udaje niewidocznego parent/actor proof: jego ograniczenia pozostają jawne.

Bramka końcowa: ten sam package/revision/schema dla cold, ordinary API i Chrome; trwałe oryginalne klucze/body, postcommit GET całego wyniku i historia oraz zachowany receipt/screenshot bez sekretów. Pure tests, historyczny roundtrip i odczyt formularza nie zastępują wykonania tych operacji. Dopiero ten odbiór zamyka dziedziczenie dostawy MERGE; nie zamyka pełnego Goala Base ani split210.
