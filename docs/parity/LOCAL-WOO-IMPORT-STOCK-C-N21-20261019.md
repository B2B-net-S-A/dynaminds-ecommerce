# N21 C: naturalny import i osobny stock — 19.10.2026

**PASS w opisanym zakresie: zwykły UI opt-in C, dwa naturalne cykle i jeden import oraz osobny naturalny stock.** Globalne zachowanie danych potwierdzone. Pełny Goal pozostaje OPEN.

## Istniejące wydanie i jeden zakup

Normalne N21 `5f5bc6267a6ee465f94e30cbf9894eb5c806d4114ffe9ee4114fc0d327ccb814`, źródła `522fac7…`, schema217, ta sama baza i pięć oddzielnych lokalnych firm. Bez nowego builda, migracji lub ręcznego run-once w tym odbiorze. [Wydanie N21](RESTORED-PREVIEW-N21-LOCAL-20261019.md); [wcześniejszy odbiór B](LOCAL-WOO-IMPORT-STOCK-B-N21-20261019.md).

Jeden natywny POST201 utworzył w oficjalnym lokalnym Woo C zamówienie **#12**: jedna sztuka istniejącego zmapowanego produktu **#10**, 12,30 PLN, processing/bacs/set_paid. Etap zawiera 9 GET i 1 POST; świeży GET nowego zamówienia jest równy zachowanemu ACK. Bez ponowienia POST.

## Dwa naturalne cykle, jeden import

Monitor Root60448 zapisał pełną wcześniejszą historię przy orders C **v2 paused** i katalogu **v2 paused**, przed włączeniem harmonogramu. Po UI enable orders v3 uchwycił pierwszy przyszły termin **19.10.2026 05:14:36.214 lokalnie** o05:13:38.623. Dwa nowe wykonania DONE dotyczą tego terminu i **05:15:36.498**. Oba mają własny job DONE/attempts0/max1/lease_active=false i dokładnie powiązany dispatch ACK.

Jeden receipt `f630a1fa-6929-463d-b715-3ffd9904a07c` wiąże inbound `1c9dc2f3-7113-464d-bc0d-ddbe0f300857` i order `ca078e48-8724-4ca8-9dd7-a3760a462244` z pierwszym occurrence/job/dispatch. source_hash=imported_hash. Drugie wykonanie zachowało cały ten sam receipt/order/payment/inventory i inbound ID/source_hash/imported_hash/order_id; brak duplikatu.

Jedna płatność **1230 minor = 12,30 PLN**, metoda `source_import`, należność0: deklaracja źródła Woo, nie potwierdzenie bankowe. Jedna rezerwacja zmieniła inventory C **8/1/7 v1→8/2/6 v2** (on_hand/reserved/available). Monitor wykonał **70 GET/0 POST/0 SQL**. Świeży baseline i zamknięcie zachowują całe inventory czterech innych firm, pięć wcześniejszych app order/payment DTO i całą wcześniejszą historię. Root zobaczył potwierdzenie nowego importu oraz dwa DONE w UI i osobno wstrzymał orders **v4** i import **v2**; katalog pozostał v2 paused.

## Osobny naturalny stock i natywne zamknięcie

Root w zwykłym UI skorygował stock **+1: 8/2/6 v2→9/2/7 v3** oraz włączył nową konfigurację stock-only v1: stock=true, price=false, interwał60s/weryfikacja900s. Naturalny parent `dd59d4b7-6944-4be9-bef0-c20d2fbf91b6` i plan `ac8a77a0-9e41-4163-9b1f-b0068f7d1fb6` zakończyły się DONE.

Żądany i zweryfikowany payload to dokładnie `{manage_stock:true,stock_quantity:7,backorders:'no'}`; wynik external_api_verified, desired_applied=true, local_changed=false. Monitor **72 GET/0 zapisów HTTP/0 SQL** potwierdził natywne **6→7**, ceny i total_sales2 bez zmian względem etapu po zakupie, nowy order/payment oraz pięć wcześniejszych par i cztery inne inventory bez zmian. Po osobnej pauzie konfiguracja stock C **v2 wyłączona**.

Dwa osobne końcowe natywne GET używają loopback18445, własnego CA/TLS. Stare zamówienie jest całe identyczne; jedyne nowe #12 całe równe oryginalnemu ACK. Jeden produkt #10 porównano po wszystkich polach: stan **7 przed zakupem→7 po imporcie i stocku**, total_sales **1→2**, zmienione wyłącznie sales i dwie daty modyfikacji. related_ids obu pełnych DTO jest pustą listą; walidacja ogranicza je do znanych ID, nie dopuszcza cudzych. To porównanie DTO, nie hash całej natywnej bazy ani dowód liczby PUT.

Pierwsza próba CLI zamknięcia została odrzucona przed utworzeniem katalogu i przed HTTP: wielkie C w nazwie wyjścia nie spełniało formatu małych liter. Niezmieniony helper po korekcie argumentu `native-closing-c-stock01` zakończył2 GET PASS. Nie powtarzano zakupu ani zapisu stocku.

## Globalne zachowanie danych

W jednym RRRO Root ponownie sprawdził **roster i wszystkie644 bieżące pełne liczności/kanoniczne SHA256** względem capture po stocku. **Stock:632 tabele całe/12 dokładnych zmian; import:622 całe/22 dokładne zmiany.** Wszystkie8+10 projekcji odtworzyły pełne historyczne hashe/liczności, z poprawną kompozycją wspólnych stock i markerów na końcowym stanie bazy.

Stock: osiem projekcji obejmuje dokładny listing, plan/item, dwa markery stock, wybrany stock/lokalizację oraz po jednym nowym ruchu. Cztery raw tabele zachowują całe stare wiersze; doszło13 audytów,2 jobs,2 polecenia i1 konfiguracja. Listing C z publish i nowym last_result jest zgodny ze źródłowym zapisem Woo; przywrócenie całego historycznego linked+catalog_run_id wyłącznie w projekcji odtwarza pełny hash wszystkich11 listings `1276c7c6…`, identyczny przed C i po imporcie.

Import: dziesięć projekcji obejmuje siedem tabel wyłącznie nowego order UUID, dokładnie trzy markery łącznie z późniejszym stockiem, cały dawny stock C oraz dawny wiersz C/orders/period workspace_usage. Pozostałe12 raw tabel zachowuje stare wiersze: kanał C tylko last_sync_at/next_sync_at, kontrolka orders tylko version2→4/updated_at. Doszło18 audytów, po2 jobs/integration_runs/occurrences/dispatches/polecenia odczytu/importu oraz po1 inbound/import-control/receipt. Nowe rekordy mają zamknięte zbiory akcji i dokładne channel/actor/owner/warehouse bindings oraz ID job/occurrence/dispatch/receipt z monitorów. Nie wyłączono ogólnie danych tenanta.

Projekcje były wyłącznie porównawczymi SELECT, nie zapisem cofającym operacje: RRRO, statement/lock8s, klient9s, potwierdzone ROLLBACK/end, 0 SQL zapisów i0 HTTP w czytniku. Niezależny FILE peer zweryfikował wszystkie przypięte wejścia, stare raw multiset i dokładne nowe raw zbiory oraz18 wyników count/SHA względem właściwego baseline.

## Zachowane dowody

Ścieżki względem `/Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/`; dowody prywatne, bez publikowania cookie/DSN/kluczy.

- Utworzenie: `woo-import216-n21-BCD-bindings-prepared-agent-20261019-01/run-C01/result.private.json`,16092 B, SHA256 `1dcc6246552fdfa6b571d8e7d458b79ff57868daa02dd983ef2b76a52c42b699`.
- Import: `woo-import216-n21-BCD-bindings-prepared-agent-20261019-01/observe-C01/result.private.json`,116259 B, SHA256 `41fea90ab923b14e102e8e9435c4a0a3e60cfd48b20096d9e5756a144bb87db7`.
- Stock: `woo-stock-n21-BCD-observer-prepared-agent-20261019-01/run-C01/result.private.json`,97478 B, SHA256 `61d88770b2f1a7769e74e7bfc5d25e1482d0421be21c6d901fc755f094738854`.
- Natywne zamknięcie: `woo-import216-n21-BCD-bindings-prepared-agent-20261019-01/native-closing-c-stock01/result.private.json`,4343 B, SHA256 `d5bccf393da49b96b2d252bd48998b358b17b34cfee61c6f11d127b4eecfbdba`.
- Globalny wynik: `woo-import216-n21-CD-prepared-agent-20261019-01/c-global01.private.json`,76718 B, SHA256 `bc06559bc20db2763db2857f8ec42a93ca3bdff19f5f4ca7f2450cd4d71dde5a`; source02 `0ca9de45…`, actualinput `795f7ed0…`.

Globalny wynik wiąże capture przed C `0964acb5…`, po imporcie `e3e1a810…`, po stocku `54b52486…` i świeże pełne businessrows wszystkich pięciu firm `58c7a910…`, w tym pełny listing C. Niezależnie sprawdzono wszystkie154 pary intent/ACK i SHA surowych body:9+70+72+2 GET oraz1 natywny POST.

## Granice

Odbiór dotyczy oficjalnego lokalnego Woo C i zwykłego UI/API tej wersji. Nie dowodzi liczby provider PUT, utraty ACK w locie, crash/reclaim/restartu, odzyskiwania automatyki, skali, wariantów lub kont dostawców live. Import/stock D i pełna automatyka wszystkich pięciu firm pozostają nieodebrane w tym raporcie. N22 podgląd integracji, Source34/pełna bramka8s, Base wire i pełny klon Base nadal OPEN.
