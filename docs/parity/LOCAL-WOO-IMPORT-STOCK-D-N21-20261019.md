# N21 D: naturalny import i osobny stock — 19.10.2026

**PASS w opisanym zakresie: zwykły UI opt-in D, dwa naturalne cykle, jeden import z płatnością/rezerwacją oraz osobny naturalny stock.** Globalne zachowanie danych D potwierdzone. Wspólny końcowy odczyt pięciu firm jeszcze przed odbiorem; pełny Goal pozostaje OPEN.

## Jeden zakup i dwa naturalne wykonania

Normalne wydanie N21 `5f5bc6267a6ee465f94e30cbf9894eb5c806d4114ffe9ee4114fc0d327ccb814`, źródła `522fac7…`, schema217, ta sama baza i pięć oddzielnych lokalnych firm. Bez nowego builda, migracji lub ręcznego run-once w tym odbiorze. [Wydanie N21](RESTORED-PREVIEW-N21-LOCAL-20261019.md); [poprzedni odbiór C](LOCAL-WOO-IMPORT-STOCK-C-N21-20261019.md).

Jeden natywny POST201 utworzył w oficjalnym lokalnym Woo D zamówienie **#12**: jedna sztuka istniejącego zmapowanego produktu **#10**, 12,30 PLN, processing/bacs/set_paid. Etap zawiera 9 GET i 1 POST; świeży GET nowego zamówienia jest równy zachowanemu ACK. Nie ponawiano POST.

Monitor Root68477 zapisał pełną wcześniejszą historię przy orders **v2 paused** i katalogu **v2 paused**. Po zwykłym UI enable orders v3 uchwycił pierwszy przyszły termin **19.10.2026 05:23:07.795 lokalnie** o05:22:10.332. Dwa różne nowe wykonania DONE dotyczą tego terminu i **05:24:08.765**; oba mają własny job DONE, attempts0/max1/lease_active=false i powiązany dispatch ACK.

Jeden receipt `8328fd69-b2ce-4eb9-8fef-91209bfd1aeb` wiąże order `dac50255-e5f5-4881-acf7-1dd94db457d9` z dokładnym pierwszym occurrence/job/dispatch i zgodnym source_hash/imported_hash. Drugie wykonanie zachowało cały ten sam receipt/order/payment/inventory oraz inbound ID/source_hash/imported_hash/order_id. Nie powstał drugi import.

Jedna płatność **1230 minor = 12,30 PLN**, metoda `source_import`, jest deklaracją Woo, nie potwierdzeniem bankowym. Jedna rezerwacja zmieniła inventory D **8/1/7 v1→8/2/6 v2** (on_hand/reserved/available). Monitor wykonał **70 GET/0 POST/0 SQL**. Po odbiorze Root osobno wstrzymał orders **v4** i import **v2**; katalog pozostał v2 paused.

## Osobny naturalny stock i natywne zamknięcie

Root w zwykłym UI wykonał korektę **+1: 8/2/6 v2→9/2/7 v3** i włączył konfigurację stock-only v1: stock=true, price=false, interwał60s/weryfikacja900s. Naturalny parent `6c8539e5-498c-4b4c-b197-2a4b67239612` i plan `f0c48576-4229-4a19-b712-ed2150b94ff1` zakończyły się DONE. Żądany i zweryfikowany payload to dokładnie `{manage_stock:true,stock_quantity:7,backorders:'no'}`; external_api_verified, desired_applied=true, local_changed=false.

Monitor wykonał **74 GET/0 zapisów HTTP/0 SQL**. Natywny stan zmienił się **6→7**, ceny i total_sales2 zachowane względem etapu po zakupie. Świeże pełne porównania zachowały inventory pozostałych czterech firm oraz pięć wcześniejszych app order/payment DTO i nową parę zamówienia/płatności D. Po osobnej pauzie stock D **v2 wyłączony**; odczyt i import pozostają wstrzymane.

Dwa końcowe natywne GET używają loopback18446 i własnego CA/TLS. Stare zamówienie jest całe identyczne; jedyne nowe #12 całe równe ACK utworzenia. Produkt #10 porównano po wszystkich polach: stan **7 przed zakupem→7 po imporcie i stocku**, total_sales **1→2**, zmienione tylko sales i dwie daty modyfikacji. related_ids obu DTO jest pustą listą; walidacja nie dopuszcza nieznanych ID. Jest to porównanie DTO, nie hash całej natywnej bazy ani liczba provider PUT.

## Globalne zachowanie danych

Root w RRRO ponownie sprawdził roster i **wszystkie644 bieżące pełne liczności/kanoniczne SHA256** względem capture po stocku. **Stock:632 tabele całe/12 dokładnych zmian; import:622 całe/22 dokładne zmiany.** Wszystkie8+10 projekcji odtworzyły pełne historyczne hashe/liczności. Oba etapy obliczono na tej samej końcowej bazie, z dokładną kompozycją wspólnych stock i markerów.

Stock: osiem projekcji obejmuje dokładny listing, plan/item, dwa markery stock, wybrany stock/lokalizację oraz po jednym nowym ruchu każdej tabeli. Cztery raw tabele zachowują wszystkie całe stare wiersze; doszło13 audytów,2 jobs,2 polecenia i1 konfiguracja. Cały historyczny listing odtworzono wyłącznie w projekcji; nowy publish/last_result musi być zgodny z przypiętym natywnym produktem i źródłowym zapisem Woo.

Import: dziesięć projekcji obejmuje siedem tabel wyłącznie nowego order UUID, trzy dokładne markery łącznie z późniejszym stockiem, dawny cały stock D oraz dawny wiersz D/orders/period workspace_usage. Pozostałe12 raw tabel zachowuje stare wiersze, z jawnymi wyjątkami: kanał D tylko last_sync_at/next_sync_at, kontrolka orders tylko version2→4/updated_at. Doszło18 audytów, po2 jobs/integration_runs/occurrences/dispatches/polecenia odczytu/importu oraz po1 inbound/import-control/receipt. Zamknięte zbiory akcji i dokładne channel/actor/owner/warehouse bindings nowych rekordów oraz ID job/occurrence/dispatch/receipt odpowiadają monitorom; bez ogólnego wyłączenia danych tenanta.

Inverse to **wyłącznie porównawcze SELECT**, nie zapis cofający operacje: RRRO, statement/lock8s, klient9s, potwierdzone ROLLBACK/end, 0 zapisów SQL i0 HTTP w czytniku. Niezależny FILE peer sprawdził wszystkie przypięte wejścia, pełne stare raw multiset, dokładne nowe zbiory raw oraz18 wyników count/SHA względem właściwego baseline.

## Zachowane dowody

Ścieżki względem `/Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/`; pliki prywatne, bez publikowania cookie/DSN/kluczy.

- Utworzenie: `woo-import216-n21-BCD-bindings-prepared-agent-20261019-01/run-D01/result.private.json`,16092 B, SHA256 `09730049b094673cf8db88a3d1baf5f85a50ec247e5604fbc861143d4af804b8`.
- Import: `woo-import216-n21-BCD-bindings-prepared-agent-20261019-01/observe-D01/result.private.json`,116260 B, SHA256 `ade0a738dfd75e4c40c9a5d2b4aa476639519f27cb4aec666204c6f025f51945`.
- Stock: `woo-stock-n21-BCD-observer-prepared-agent-20261019-01/run-D01/result.private.json`,99064 B, SHA256 `82f800ca5e1578ae5b5aa9672b223d5e12046184c5eb3679d9966ee14546f0bf`.
- Natywne zamknięcie: `woo-import216-n21-BCD-bindings-prepared-agent-20261019-01/native-closing-d-stock01/result.private.json`,4343 B, SHA256 `7746c00ff7f3563639ca5e4aa0d746a6a90ae679fb57e108153508a051d39a41`.
- Globalny wynik: `woo-import216-n21-CD-prepared-agent-20261019-01/d-global01.private.json`,76731 B, SHA256 `dd9657734cae2636d2de03162fe72759dec6945b70883e2a72caba49feee90ab`; source02 `0ca9de45…`, actualinput `811df172…`.

Globalny wynik wiąże capture przed D `ccb9504c…`, po imporcie `c579cb72…`, po stocku `c88cc526…` i świeże pełne businessrows wszystkich pięciu firm `2cfa14a2…`. Sprawdzono wszystkie156 par intent/ACK i SHA surowych body:9+70+74+2 GET oraz1 natywny POST.

## Granice

Odbiór dotyczy oficjalnego lokalnego Woo D i zwykłego UI/API tej wersji. Wspólne końcowe37 GET wszystkich pięciu firm jeszcze przed odbiorem w chwili tego raportu. Nie dowiedziono liczby provider PUT, utraty ACK w locie, crash/reclaim/restartu, odzyskiwania automatyki, skali, wariantów ani kont dostawców live. Szersza pełna automatyka pięciu firm, N23 podgląd ustawień, Source34/pełna bramka8s, Base wire i pełny klon Base nadal OPEN.
