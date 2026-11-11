# Source206: historyczny reader148/169, bez writera i podpięcia runtime

## Aktualny wynik — 17.10.2026, po uruchomieniu podglądu05

**Rzeczywiste PostgreSQL: 3/3 PASS, bez pominięć.** W podglądzie05
`f73f57c3655bf9aeecba2de6a406ba328f3a9ef3d4140d6f93088dcf95c750dc`
utworzono dwa nowe syntetyczne przypadki przez zwykłe HTTP API: WMS OFF i ON,
sale/custody/reject, dwa magazyny, koszt zero/znany/nieznany. SQL generatora
dotyczył wyłącznie własnych tenantów i członkostwa; historia fizyczna i receipt
powstały przez aplikację. Manifest: `local-builds/full-base-preview-20261017/return-credit206-cases05/cases.private.json`.

Z jednego spójnego dumpa przywrócono odrębną numeryczną scratch DB. SQL206
zastosowano wyłącznie tam. Testy potwierdziły powtarzalny odczyt obu historii,
odmowę dla obcej firmy/brakującego ID/roli aplikacyjnej oraz odrzucenie
uszkodzonego lineage, arrival, ilości PZ i wartości WMS z rollbackiem.
Literalne20 funkcji188 zachowano. Po zamknięciu własnych klientów potwierdzono
zero połączeń i normalnie usunięto scratch; podgląd pozostał bez funkcji206.

Dowody w `local-builds/full-base-preview-20261017/return-credit206-native05-1792257398767/`:

- `receipt.private.json`, SHA256 `1d114c9cd223736d339d9620bbf44c635008b7f90d4889658947b829a59fcbab`;
- `postcheck.private.json`, SHA256 `47671a2489d32a9c3d422ba858b8ab1b197e43a4f3922216ab6b58a250491fc9`;
- `Root-review.private.json`: niezależnie sprawdzono15 przypiętych artefaktów,
  surowe TAP3 PASS/0 FAIL/0 SKIP oraz końcowy brak scratch i funkcji206 w podglądzie.

**Granica:** to odbiór readera historii w PostgreSQL. Nie podłączono206 do
runtime ani migratora Main/podglądu; nie wystawiono nowej korekty i nie odebrano
writera207. Te dwa przypadki nie zawierają faktury157 wystawionej przed RMA,
więc nie zastępują kolejnego scenariusza finansowego. Poniższe wyniki
`NOT_RUN`, SKIP i nieudane cold są historyczne i pozostają zachowane.

2026-10-17. `server/206_return_credit_destinations_history.sql` to nowy, addytywny **kandydat źródła**. Nie był zastosowany w DB, zarejestrowany w migratorze ani dołączony do zasobów wydania. Numer206 był wolny. SQL nie jest sprawdzony przez PostgreSQL. Nie przyznaje odbioru procesu korekty.

## Co zawiera ten przekrój

Dwa nowe prywatne readery `public.return_credit206_parent(uuid)` i `public.return_credit206_history(uuid)`; bez nowych tabel, triggerów, markerów, zapisów biznesowych, grantów aplikacji lub zmian starego Source. Wywołuje je wyłącznie właściciel w prawidłowym kontekście własnego tenanta. Nie są HTTP/API kontraktem, nie odświeżają uprawnień operatora i nie wystawiają dokumentów.

Reader parent odczytuje **zakończone historyczne** przyjęcie `destinations_v1`, wiąże native148 admission/preview/assistant receipt/admission/session z sealed169 i152 oraz tenant/order/return/actor/key/tx. Przelicza oryginalny plan148 z zapisanego źródła. Porównuje pełne typowane części sale/custody/reject, arrivals w wielu magazynach, WMS fragmenty i historyczny request operacji148, a także wszystkie urodzone stock/bin/layer journals z before/after148 i152. Nie porównuje historii do dzisiejszego zapasu lub dzisiejszej polityki.

Reader history zachowuje istniejące kontrole188 birth/items/PZ/stock/bin/layer/cost w nowym namespace, z dwoma koniecznymi różnicami: natywny WMS148 używa własnego requestu `{protocol,admission_id,preview_id,parts}`, a fizyczna receptura148 jest związana z każdym arrival (sale **i** custody), zamiast wyłącznie `restocked` zwykłego RMA. Odrzuca current-TX, wymiany, parcel/local/dropship parent; nie poszerza ich boczną ścieżką. Pełne snapshoty mają budżet32MiB, zbiory10000; bez przycinania.

## Dlaczego nie ma `CREATE OR REPLACE` starego188

`local_consumer_credit_guards()` porównuje immutable manifest z fingerprintem **pełnych definicji wszystkich** `local_consumer_credit_*`. `ordinary188_structure_valid()` dodatkowo wymaga dokładnie20funkcji i pinuje body `local_consumer_credit_history` (SHA `a08cbbcb4492846f921990a6a84f0c8aba8985b8ee3ca8bed01a282fcefcd9b1`). Nowy history body albo trigger na starych tabelach unieważniłyby profil. Manifest188 i jego20funkcji pozostają literalne.

Obecne preview/issue188 nie mogą użyć nowego readera: frame188 wywołuje swój stary history; admission/document/counter guards również wymagają tego samego frame. Dlatego ten plik **nie udaje działającego rozszerzenia188**. Jest weryfikowalnym elementem źródła dla odrębnego successora. Stary issue188 nadal odmawia148.

## Minimalne wymagane hooki kolejnego przekroju

1. Osobny successor source/preview/issue/detail/original-command, z bieżącą autoryzacją i końcowym sprawdzeniem sesji/klucza. Własny namespace i certyfikacja metadanych nowych funkcji. Root dopina migrator, zasoby i kontrakt nowego wydania po niezależnym review; pakiet205 pozostaje niezmieniony.
2. Pełny uporządkowany graf FV157 → wszystkie przyjęcia → **wszystkie wcześniejsze188 i successor korekty**, bez podwójnego przyjęcia tego samego RMA. Kwoty VAT/przed/po i pozostałe limity wynikają z tego grafu; reader206 sam tego nie zapewnia. Przed zapisami blokować oryginalne zamówienie i sprawdzić dokładny snapshot po oczekiwaniu.
3. Jawna polityka współistnienia. Stare188 analizuje pełną historię i odmawia, gdy zawiera148, co może wyznaczać rodzinę obsługi successora; trzeba potwierdzić także stare preview/replay i wcześniejsze niezaksięgowane zwykłe RMA. Nie zakładać bezpieczeństwa jedynie na podstawie nowego UNIQUE we własnej tabeli. Nowy writer nie może sprawić, że188 nie zauważy wcześniejszego successor credit.
4. Numeracja: stary188 ma osobne immutable namespace/counter i format `KOR/prefix/year/seq`. Nowy writer nie może po prostu pobrać `max+1` lub dotykać counter188. Potrzebna rozłączna numeracja successora albo certyfikowany wspólny kontrakt, z concurrency/restart/rollback/readback. Root wybiera i odbiera tę strategię.
5. Zwykły UI wyboru właściwej strategii dokumentu i odczytu obu rejestrów, custody oryginalnego klucza po utracie odpowiedzi. Dopiero wtedy zwykły odbiór FV157→skany148/sale-custody-reject→PZ/WMS→korekta→lokalne rozliczenie. Rzeczywista wypłata przez dostawcę jest odrębną otwartą integracją.

## Weryfikacja wykonana teraz

- `node --test tests/return-credit206-history.source.test.mjs`: **7/7 PASS**, 0,41s (wynik narzędzia z bieżącej tury). To kontrole plikowe: stare148/152/188/structure piny, brak replace/DML/grantów, zachowanie pełnych188 kontroli fizycznych i obecność natywnych powiązań. Nowy test sprawdza także inertny import generatora przypadków i SQL ograniczony do metadanych tenant/IAM. Nie wykonują SQL206.
- `node --import tsx --test tests/return-credit206-history.database.test.ts`: **3 SKIP, 0 PASS**, chunk `2111b5`, handle `97987` zakończony EXIT0. Tylko potwierdzenie bezpiecznego domyślnego uruchomienia i transpilacji; **bez połączenia z DB**.
- Nie wykonywano builda, migracji, providera, Chrome ani Main. SQL i zachowanie w PostgreSQL pozostają do sprawdzenia; funkcjonalna akceptacja jest otwarta.

## Przygotowane, ale niewykonane testy DB

`return-credit206-history-fixture.ts` nie bootstrapuje ani nie wstawia prywatnych proofów. Root musi dostarczyć dwa autentyczne przypadki wykonane przez zwykłe API (OFF/ON, sale+custody+reject, co najmniej dwaWH) i samodzielnie zainstalować206 w osobnym numerycznym `dynaminds_test_<liczba>` na loopback. Jedyny opt-in to `DYNA_RETURN_CREDIT206_TEST=true`; manifest `DYNA_RETURN_CREDIT206_CASES_FILE` ma schema `dynaminds-native-return-credit206-cases/v1` oraz dwa wpisy `{tenant_id,receipt_id,wms}` o różnych tenantach i trybachWMS. Bez opt-in testy niczego nie łączą.

Testy DB sprawdzają powtarzalny odczyt bez zapisów, literalny188, odmowę starego188 dla148, obcy tenant/brak ID/rolędyna_app oraz kontrolowane uszkodzenie lineage, usunięcie arrival, ilośćPZ i wartośćfragmentu. Uszkodzenia wymagają ownera w jawnie jednorazowej DB; każdy przypadek jest w savepoint i cofany, a `origin` przywrócony **przed** sprawdzeniem, aby metadata/origin refusal nie zastępowało testu historycznego dowodu. Następny odbiór musi jeszcze dodać quota/capacity, deadlock/concurrency oraz pełny nowy writer; te testy czytają tylko historię.

## Wznowiony odbiór na odrębnej scratch DB — zatrzymany przed API przez rzeczywisty cold

Istniejący `local-builds/full-base-preview-20261017/source.dump` został zweryfikowany względem zapisanego SHA256 i odtworzony na działającym PG57081 do nowej `dynaminds_test_1792232454681`. Nie tworzono kolejnego dumpa, nie zmieniano MainDB, oryginalnej previewDB ani usług. Kopia nie zawierała gotowych native148/169 przyjęć spełniających wymagane sale/custody/reject w wielu magazynach. Prywatna konfiguracja i kontekst odtworzenia są w `local-builds/return-credit206-20261017/`; pliki z poświadczeniami mają0600.

Nowy `tests/return-credit206-api-fixture.mjs` przygotowuje OFF/ON przez zwykłe `app.inject`: rzeczywiste magazyny, produkty, opening WMS dla kosztów zero/known/unknown, fulfillment, strict BO, RMA, stację i skany, statusy sale/custody/reject oraz przyjęcie do dwóch magazynów. SQL tworzy wyłącznie własny tenant i członkostwo operatora; nie fabrykuje stanów fizycznych ani native proof. Import nie łączy się z DB. Harness readera ma jawne UTC/jitoff i ograniczone statement/lock timeouts.

Pierwsza zwykła factory niezmienionego wydania68ab zakończyła się terminalnym `57014` w `readPackingCatalogue` przy `q(COUNT_SQL)`, po527436ms, zanim wystartował generator przypadków. Nie stosowano SQL206. Zapisano `failure-68ab.json`. Po terminalu użyto wskazanego przez Root niezmiennego wydania02 (`a66ad16ce17732104f7505dbff82249cebf1b9085a505632aee7c900344c2b43`). Druga factory również zakończyła się terminalnym `57014`, po554044ms, tym razem w `activateRuntimeGeneration` na `SELECT public.ordinary187_approve(...)`. Zapisano `failure-02.json`. Emitowany helper ustawia przed tym miejscem `SET LOCAL statement_timeout TO '8s'`, więc początkowe120s klienta factory nie jest budżetem tej zgody. Próby nakładały się z innymi cold na obciążonej lokalnej maszynie; nie stanowią miarodajnego pomiaru wydajności w izolacji.

Generator API nie wystartował w żadnej próbie. SQL206 nie został zastosowany, a trzech testów DB nie wykonano z opt-in; nie ma runtime akceptacji readerów206. Nie omijano gate, nie wstawiano prywatnych proofów i nie tworzono następnej factory po drugim terminalu. Po zamknięciu wszystkich własnych klientów potwierdzono0połączeń do scratch i usunięto wyłącznie tę DB (`evidence.json`: `scratch_dropped:true`).

Najmniejszy następny zakres to jeden odizolowany zwykły cold/Startup po stabilizacji Main, z pomiarem czasu rzeczywistej zgody `ordinary187_approve` oraz jej8s budżetu; następnie uruchomienie gotowego generatora API i trzech opt-in testów. Nie wymaga to writera206 ani zmiany starego188. Gdy cold zacznie przechodzić, przypadki należy utworzyć przy literalnym schema205, zamknąć zwykły runtime, dopiero wtedy zastosować206 w tej samej jednorazowej kopii i uruchomić readery. Inaczej dodanie namespace206 przed native205 snapshotem zmieniłoby badany profil.
