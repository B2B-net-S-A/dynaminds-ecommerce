# N21 B: naturalny import i osobny stock — 19.10.2026

**PASS w opisanym zakresie: zwykły UI opt-in, dwa naturalne cykle, jeden import oraz osobny naturalny stock.** Globalne zachowanie danych B potwierdzone; pełny Goal pozostaje OPEN.

## Istniejące wydanie i jeden zakup

Normalne N21 `5f5bc6267a6ee465f94e30cbf9894eb5c806d4114ffe9ee4114fc0d327ccb814`, źródła `522fac7…`, schema217, ta sama baza i pięć oddzielnych lokalnych firm. Bez nowego builda, migracji lub ręcznego run-once w tym odbiorze. [Wydanie i odtworzony podgląd N21](RESTORED-PREVIEW-N21-LOCAL-20261019.md).

Jeden natywny POST201 utworzył w oficjalnym lokalnym Woo B zamówienie **#27**: jedna sztuka istniejącego zmapowanego produktu **#25**, 12,30 PLN, processing/bacs/set_paid. Etap utworzenia zawiera 9 GET i 1 POST; świeży GET nowego zamówienia jest równy zachowanemu ACK. Bez ponowienia POST.

## Dwa naturalne cykle, jeden import

Monitor rozpoczął przy orders B v4 paused i zapisał pełną historię przed UI enable v5. Pierwszy przyszły termin to **19.10.2026 04:53:12.246 lokalnie**; zapisano go przed wykonaniem. Dwa nowe wykonania DONE dotyczą tego terminu i kolejnego **04:54:12.363**; każde ma potwierdzony dispatch/job ACK, job DONE, attempts0/max1 i brak aktywnej dzierżawy.

Jedyny receipt `c0af1e61-056d-4b62-b359-396f80308b5a` wskazuje inbound `b974485b-3b1a-4464-934c-18c421b82abf`, order `fb8a4907-8f7f-4acc-b13d-5d838edd9296` oraz dokładny pierwszy occurrence/job/dispatch. source_hash i imported_hash są zgodne. Drugie wykonanie zachowało ten sam cały receipt, zamówienie, płatność i inventory, bez drugiego importu.

Płatność **1230 minor = 12,30 PLN**, `source_import`, jest deklaracją Woo, nie potwierdzeniem bankowym. Jedna rezerwacja zmieniła inventory B **8/1/7 v1→8/2/6 v2** (on_hand/reserved/available). Monitor wykonał **70 GET/0 POST/0 SQL**. Świeży baseline i zamknięcie zachowują pełne inventory pozostałych czterech firm oraz pięć wcześniejszych app order/payment DTO. Cała wcześniejsza historia odczytów zachowana.

Po odbiorze Root osobno wstrzymał orders **v6** i import **v2**; katalog **v2 paused**. Nie resetowano historycznych zadań ani nie przejęto dawnego stagingu.

## Osobny naturalny stock

Root wykonał w zwykłym UI korektę **+1: 8/2/6 v2→9/2/7 v3** i włączył nową konfigurację stock-only v1: price=false, stock=true, interwał60s/weryfikacja900s. Naturalny parent `e6785012-6b60-4bd4-a6fb-5b74e86ec165` i plan `156240e1-6ce5-4fdc-a3f5-c52de476c082` osiągnęły DONE. Żądany i zweryfikowany payload to dokładnie `{manage_stock:true,stock_quantity:7,backorders:'no'}`; wynik external_api_verified, desired applied, bez lokalnej zmiany wykonanej przez executor.

Monitor wykonał **92 GET/0 zapisów HTTP/0 SQL**. Stan natywnego produktu zmienił się **6→7**, ceny i total_sales2 pozostały identyczne. Nowe zamówienie/płatność, pięć wcześniejszych app order/payment DTO i inventory czterech innych firm zachowane. Porównanie produktu jawnie wyłącza related_ids oraz oczekiwane stock/daty modyfikacji; sam monitor nie dowodzi całego native DTO ani liczby PUT.

Po osobnej pauzie konfiguracja stock B **v2 wyłączona**. Dwa końcowe natywne GET zachowują 14 wcześniejszych pełnych DTO zamówień, a nowe #27 jest całe równe ACK utworzenia. Dla produktów raport końcowy jawnie wydziela related_ids i oczekiwane zmiany docelowych sales/dat; nie jest to hash całej natywnej bazy.

## Globalne zachowanie danych: dwa dokładne etapy

Root w RRRO ponownie sprawdził roster i **wszystkie 644 bieżące pełne liczności/kanoniczne SHA256**, równe capture po stocku. Następnie uzgodnił oba etapy na tej samej końcowej bazie: **stock 632 tabele całe/12 zmienionych**, potem **import 622 całe/22 zmienione**. Wszystkie 8+10 projekcji odtworzyły pełne historyczne liczności i hashe, również nakładające się stock i markery.

Stock: osiem projekcji obejmuje dokładny listing, plan/item, dwa markery stock, wybrany stock/lokalizację oraz po jednym nowym ruchu każdej tabeli. Cztery raw tabele zachowały wszystkie całe stare wiersze: doszło 13 audytów, 2 jobs, 2 polecenia i 1 konfiguracja. Nowe parent/child jobs DONE, bez aktywnych lease; liczba attempts nie jest tutaj uogólniana z zachowania innych kanałów.

Import: dziesięć projekcji obejmuje siedem tabel wyłącznie nowego order UUID, dokładnie trzy markery łącznie z późniejszym stockiem, cały dawny wybrany stock B oraz dawny wiersz B/orders/period workspace_usage. Pozostałe 12 raw tabel zachowuje wszystkie stare wiersze z dwoma jawnymi wyjątkami: kanał B tylko last_sync_at/next_sync_at, kontrolka orders tylko version4→6/updated_at. Doszło 18 audytów, po2 jobs/integration_runs/occurrences/dispatches i polecenia odczytu/importu oraz po1 inbound/import-control/receipt. Brak szerokiego wyłączenia danych tenanta.

**Pierwszy czytnik nie przeszedł błędnej asercji o stałym statusie listingu.** Historyczny linked legalnie zmienił się na publish przez `server/offers.ts:2347–2424`; Woo last_result jest nowym obiektem `{stock_quantity:7,status:'publish',scope:'external_api_verified'}`, bez historycznego catalog_run_id. Wersja02 wymaga dokładnie tego bieżącego wyniku i statusu z przypiętego natywnego ACK. Dopiero projekcja przywraca cały historyczny linked+last_result: pełny hash wszystkich11 listings jest równy baseline sprzed B i po imporcie `39922e48…`. Pierwszy FAILED_NO_RETRY zachowany; nie jest awarią biznesową ani dowodem ponowienia operacji.

Wszystkie inverse są **wyłącznie porównawczymi SELECT**, nie zapisem cofającym operacje. RRRO, statement/lock8s, klient9s, potwierdzone ROLLBACK/end, 0 SQL zapisów i 0 HTTP w czytniku. Niezależny audyt FILE sprawdził wszystkie10 przypiętych wejść, pełne stare raw multiset oraz18 wyników count/SHA względem właściwych capture.

## Zachowane dowody

Ścieżki poniżej względem `/Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/`; pliki prywatne, bez publikowania cookie/DSN/kluczy.

- Utworzenie: `woo-import216-n21-BCD-bindings-prepared-agent-20261019-01/run-B01/result.private.json`,16051 B, SHA256 `b9fc3d589498ce3d51c1ad554cf090ae29a842018e0ad6001bb8e83ded0c198e`.
- Import: `woo-import216-n21-BCD-bindings-prepared-agent-20261019-01/observe-B01/result.private.json`,116270 B, SHA256 `62672c9f9a3abf48bf629d5366c7641d7e1d65c7d06dc01e62156cacc09b3599`.
- Stock: `woo-stock-n21-BCD-observer-prepared-agent-20261019-01/run-B01/result.private.json`,113339 B, SHA256 `3bfafaf09cf4f172fb72d450dbc4756a35d29461087e5b72ce9d9af119f569d7`.
- Natywne zamknięcie po stocku: `woo-import216-n21-BCD-bindings-prepared-agent-20261019-01/native-closing-B-stock01/result.private.json`,2426 B, SHA256 `896651ca7282ba486f19f14905f6804d223c6f0e1f2d548d33f8a6f64b369dea`.
- Globalny wynik02: `readonly-preview-n21-prepared-agent-20261019-01/root-B-import-stock-global-reconciliation02.private.json`,75871 B, SHA256 `410a340600800198b19299a74876a3775f831d83eb78a76be912cb922a1fc4bc`; czytnik02 `4908ee37…`. Historyczny wynik01 FAILED `74fd394a…` i czytnik01 `118a685f…` pozostają zachowane.

Pełne intent/ACK i SHA odpowiedzi zachowano:10 żądań utworzenia,70 monitorowania importu,92 monitorowania stocku; razem172 pary intent/ACK. Natywne zamknięcie zawiera osobne2 GET. Globalny wynik wiąże dokładne capture przed B `f976c1cd…`, po imporcie `027974ee…` i po stocku `5f5ed881…`.

## Granice

Odbiór dotyczy lokalnego oficjalnego Woo B i zwykłego UI/API tej wersji. Nie dowodzi liczby rzeczywistych provider PUT, utraty ACK w locie, crash/reclaim/restartu, odzyskiwania automatyki, skali, wariantów lub kont dostawców live. Import/stock C i D oraz pełna automatyka wszystkich pięciu firm pozostają nieodebrane w tym raporcie. N22 poprawki podglądu integracji nie są tutaj odbiorem runtime. Source34/pełna bramka8s, Base wire i pełny klon Base nadal OPEN.
