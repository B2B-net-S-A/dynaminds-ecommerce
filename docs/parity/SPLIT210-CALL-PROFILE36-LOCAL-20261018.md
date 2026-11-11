# Split210 — aktualny profil Source32 i plan odczytu katalogu

Status: **diagnostyka wykonana i rozliczona; podział zamówień nadal nieodebrany**.
Root uruchomił D36 raz, session75245, terminal EXIT0. Kod0 oznacza zakończenie
pomiaru z oczekiwanym timeoutem i cleanup, bez akceptacji kompilacji lub produktu.
Nie wykonano COMMIT, Native, aktywacji ani operacji biznesowej. Działające N09
pozostaje bez zmiany, z `order_splits_available:false`.

## Rzeczywisty pomiar

W osobnej własnej bazie PG04/57084 wykonano199 etapów poprzednika i27 etapów210.
Wszystkie494 dodatki i22 pełne podmiany odpowiadały V32. Cały inverse odtworzył
40502 rekordy i dokładną serializację64011475B, SHA256
`b3300ea8ae4933715ef1bdd7d36318b7908a56db321cbef01d2845ecfa10fcf3`.
Nie zmieniono definicji walidacji ani limitów w celu uzyskania wyniku.

Włączono `track_functions=all` przed czterema kontrolami210/209/buyer/return206.
Wszystkie cztery zwróciły TRUE. Po nich zapisano bazowe statystyki OID i wykonano
**jedno ordinary187_valid przy8s**, bez warmupu i ponowienia. Wynik:
**57014 po8001,589291ms; wynik logiczny nieznany**. Po odzyskaniu SAVEPOINT
natychmiast odczytano statystyki, przed zapytaniem o nazwy lub definicje funkcji.
Przywrócono `track_functions=none` i zachowano `statement_timeout=8s`.

Statystyki obejmują116 OID:50 ma bazę i porównywalną deltę,66 pozostaje z deltą
NULL. Największe zakończone, porównywalne wywołania:

| Funkcja | Przyrost liczby wywołań | SELF ms | TOTAL ms |
|---|---:|---:|---:|
| order_split210_valid |277|4289,805449|4289,805449|
| order_merge_delivery209_validation_snapshot |40|864,188037|1493,799998|
| order_split210_try_function_projection |3792|167,875078|2054,579452|
| order_merge_delivery209_predecessor_descriptor |129|108,582449|647,971163|
| order_split210_is_added_trigger |1944|54,230710|512,943711|

TOTAL zawiera czas funkcji zagnieżdżonych; nie sumujemy go między wierszami.
Anulowane ramki mogą nie być raportowane, a tracking zwiększa koszt. To nie
pełne drzewo wywołań, p95 ani porównanie wydajności z wcześniejszym Source31.

## Osobny plan niezmienionego captureSQL

Po statystykach i przywróceniu trackingu wykonano jeden
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING TRUE, SUMMARY TRUE)`.
Zapytanie wydzielono z pełnego źródłowego valid przez usunięcie wyłącznie
końcowego PL/pgSQL INTO. SHA256 zapytania:
`0dfdef3651ea239e02ab8c4bfa73537d25b5466d3edad263e4b1ff927e8fa3be`.
To osobne zapytanie i snapshot obserwatora, bez twierdzenia o identycznym planie
lub koszcie każdego zagnieżdżonego wykonania SPI.

SQL wall19,332ms; planning2,051ms; execution15,224ms. Plan raportuje6209 shared
buffer hits. `live_changed`22 rekordy zajmuje1,335ms, `live_own`494 rekordy11,020ms.
Największe ramiona own to constraints168:3,007ms i triggers103:2,865ms; kolumny132
zajmują0,810ms. Globalny scan constraints odrzuca11573 wiersze, selected_triggers
8818, a scan funkcji5035. Czasy węzłów nadrzędnych obejmują podwęzły.

Następna uzasadniona próba powinna ograniczyć koszt tych skanów, zachowując cały
zakres wykrywania i wszystkie pola metadanych. Przed promocją zmiany potrzebne
są pełne porównania wyników i pomiar. Nie stosować cache verdict, pomijania
kontroli po OID/signaturze ani zwiększania limitu8s. Historyczne plany tego samego
tekstu z comparison34 dotyczyły Source29/515 rekordów, nie Source31 ani Source32.

## Rozliczenie i granice

Końcowy katalog40996 rekordów jest bajtowo równy katalogowi po210. Samodzielny
przegląd odczytał trzy komplety po28 dawnych payloadów certyfikatów, odtworzył
profil z zapisanych statystyk i potwierdził213 przypięć w148 aktualnych plikach.
Pełne wiersze generacji i nowego manifestu nie mają osobnych artefaktów: ich
równość i równość rodziców209/166 potwierdzają zakończone literalne asercje
przypiętego operatora; nie nazywamy ich niezależnym porównaniem utrwalonych wierszy.
ROLLBACK, oba zamknięcia, DROP przy zero połączeń i zgodność18 ról potwierdzono.

Pierwszy helper przeglądu błędnie oczekiwał27 testów Native zamiast0 dla tego
diagnostycznego profilu i zatrzymał się przed porównaniem katalogu. Zachowano
FAILED. Wersja02 poprawia tę asercję i zapisuje osobny raport; operatora i SQL
nie ponowiono. Root91645: EXIT0, **PASS_SOURCE32_PROFILE36_FILE_RECONCILIATION_ONLY**.

Wszystkie pliki poniżej są w katalogu
`local-builds/full-base-preview-20261017/order-split210-full187-diagnostic36-source32-prepared-20261018-01`:

| Artefakt | Bajty | SHA256 |
|---|---:|---|
| run.private.mjs |108529|26788ce6eee7796f8dd2ad6f9bdae57dcea5de7d1a6489645a57e499cdda16eb|
| spec.private.json |178129|2d6697551e99589ad2fb1acb82102ba4351f0a8c1e9688469a2074655eb08673|
| run/receipt.private.json |131481|3a92f033a047fb8eb561a17092a285a5048369cc01d032009e9fcd6bceed50ad|
| run/profile36.function-runtime-profile.private.json |85698|d2ef0a97f549206797faea3b611b570523237e5688bd7f05d4fba8341c4a6bb1|
| run/profile36.capture-explain.private.json |205052|665e0638281b1ed6929bc050314ebd6fef0b7d84e25cbc8bb32a1b3cd3a40733|
| root-terminal-file-review02.private.json |2249|1383e12caed5568cfad0f91e45b7d67b5a180e60721613b4c1c97c1922fefac2|

Aktualny pomiar usuwa niepewność co do dominującego kosztu. Nie zamyka biznesowego
splitu, wspólnego210+211, Native, WMS ON, skali ani żadnego z ośmiu pełnych kryteriów Goala.
