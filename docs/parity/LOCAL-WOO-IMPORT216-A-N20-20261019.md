# N20 A: naturalny import i osobna synchronizacja stanu — 19.10.2026

**PASS: zwykły UI opt-in A, dwa naturalne odczyty i jeden import z rezerwacją/płatnością.** Pełny globalny inverse po A i końcowy odczyt natywnego Woo również PASS. Osobny naturalny executor stock A również PASS w opisanym niżej zakresie; pełny Goal pozostaje OPEN.

## Istniejące wydanie i nowy zakup

Bez nowego builda lub migracji: normalne N20 `221a27ddc7d6fd22ea2381d19f4a92d542c58dae283c4ce058da14bc15d4fbeb`, schema217, ta sama baza i pięć oddzielnych firm. [Wydanie i wcześniejszy odbiór CRM/stock E](CRM217-N20-LOCAL-20261019.md).

Root jawnie włączył import A v1 w UI. Odczyt orders był nadal wstrzymany v7, katalog v4. Następnie jeden natywny POST201 do oficjalnego lokalnego Woo A utworzył zamówienie **#31**, jedna sztuka istniejącego zmapowanego produktu, 12,30 PLN, processing/bacs/set_paid. Łącznie 10 żądań utworzenia obejmuje 1 POST i 9 GET; pełny świeży GET zamówienia równy surowemu ACK. Brak ponowienia POST, ręcznego importu lub run-once.

## Dwa naturalne cykle, jeden wynik

Monitor Root56274 uruchomiono przed włączeniem harmonogramu. Zapisał całą wcześniejszą historię przy pauzie, a po zwykłym UI enable orders v8 uchwycił pierwszy przyszły termin **19.10.2026 04:03:37.158 lokalnie**. Dwa różne nowe wykonania osiągnęły DONE: 04:03:37.158 i 04:04:37.432; oba z łańcuchem dispatch ACK, jobs DONE/attempts0/max1/bez aktywnej dzierżawy. Nie zaadoptowano starego joba lub stagingu.

Pierwsze wykonanie utworzyło receipt `b0fd2302-fa4b-4af4-bd09-25c4a40483c0`, inbound `d78364b8-59a6-4046-bc55-5c8dd8fdbf42` i zamówienie `265ece16-2444-4a95-a2be-33568d73078c`. Receipt wskazuje dokładnie pierwszy occurrence, jego job i potwierdzony dispatch; source_hash i imported_hash są zgodne.

Płatność źródłowa jest jedna: 1230 minor = **12,30 PLN**, metoda `source_import`, klucz `source-import:<inbound_id>`, należność 0. Jest to deklaracja płatności Woo, **nie potwierdzenie bankowe**. Rezerwacja jednej sztuki zmieniła inventory A z **9/1/8 v2→9/2/7 v3** (on_hand/reserved/available). Drugie naturalne wykonanie zwróciło ten sam cały receipt, zamówienie, płatność i inventory; inbound zachował dokładnie ten sam ID/source_hash/imported_hash/order_id, bez duplikatu.

Monitor wykonał **53 GET/0 POST/0 SQL**; wszystkie 106 plików intent/ACK i 53 SHA surowych odpowiedzi zweryfikowano. Pełne DTO inventory pozostałych czterech firm oraz pięciu dawnych zamówień i ich płatności są identyczne do zachowanego baseline po stock E. Odbiór nie dotyczy jedynie liczników lub statusu DONE.

Root obejrzał w Chrome zaimportowane zamówienie i dwa DONE, potem osobno wstrzymał odczyt orders A **v9** i import A **v2**; katalog nadal **v4 paused**. Zrzut: `crm217-read-fix-n20-prepared-agent-20261019-01/ui-A-import-two-cycles-paused.root.png`. Poniżej opisano późniejszy, osobny odbiór executora stock A.

## Zachowanie danych i dowody

Root ponownie sprawdził wszystkie 644 aktualne hashe względem końcowego capture. **622 tabele całe bez zmian, 22 dokładnie rozliczone zmiany; globalne zachowanie danych A PASS.** Dziesięć projekcji odtworzyło pełne historyczne liczności i hashe: siedem tabel powiązanych wyłącznie z nowym order UUID, `purchasing_stock_changes` po wyłączeniu dokładnie markera 1096, `stock` po podstawieniu wyłącznie starego pełnego wiersza A 9/1/8 v2 oraz `workspace_usage` po odtworzeniu użycia A/orders/październik 2026 z 2 na 1.

Pozostałe 12 raw tabel uzgodniono po całych wierszach: 18 nowych audytów, po 2 jobs/integration_runs/occurrences/dispatches, po 2 polecenia odczytu i importu oraz 1 inbound, 1 import-control i 1 receipt. Dawny kanał A zmienił tylko `last_sync_at`/`next_sync_at`; dawna kontrolka orders tylko version 7→9 i updated_at. Wszystkie pozostałe stare wiersze zachowane; nie zaadoptowano historycznych zadań. Projekcje były wyłącznie porównawczymi SELECT w RRRO, 8s SQL/9s klient; 0 zapisów, potwierdzone ROLLBACK/end. Nie odwracano fizycznie nowych operacji biznesowych.

Końcowe dwa GET do oficjalnego lokalnego Woo A używały własnego CA/TLS i loopback. Wszystkie 12 wcześniejszych pełnych DTO zamówień są identyczne; jedyne nowe #31 jest dokładnie równe zachowanemu ACK utworzenia. Siedem produktów porównano z jawną projekcją wyłącznie niedeterministycznego `related_ids`; dla docelowego produktu #29 doszły tylko zmiany stock 8→7, total_sales+1 i dat modyfikacji. **Nie twierdzimy pełnej równości wcześniejszych produktów.** Sam spadek stanu po zakupie nie jest odbiorem executora stock A; jego osobny odbiór opisano poniżej.

## Osobny naturalny stock A i zachowanie danych

Po zakończeniu i pauzie importu Root w zwykłym UI wykonał korektę+1: **9/2/7 v3→10/2/8 v4**. Oddzielnie włączył pierwszą konfigurację synchronizacji stock A v1. Naturalny parent i plan zakończyły się DONE; UI pokazał „Potwierdzony zapis” i „Zakończony”. Po osobnej pauzie konfiguracja stock A **v2 wyłączona**, odczyty/import nadal wstrzymane. To osobna korekta i synchronizacja, nie twierdzenie, że sam import wywołał zapis stocku. Root zapisał i obejrzał zrzut `crm217-read-fix-n20-prepared-agent-20261019-01/ui-A-stock-confirmed-paused.root.png`.

Obserwator wykonał 42 GET/0 zapisów HTTP/0 SQL. Woo produktu #29 zmienił stock 7→8; wszystkie ceny i `total_sales` 2 są identyczne. Dopuszczono tylko daty modyfikacji i jawnie zweryfikowane niedeterministyczne `related_ids`. Pełne wcześniejsze app order/payment DTO oraz nowe zamówienie A/płatność zachowane. **Po tym stocku nie wykonywano nowego GET natywnych zamówień** — ich pełne porównanie 12 dawnych/#31 powyżej dotyczy zamknięcia etapu importu przed stockiem.

Globalny odbiór stock A: ponownie uzgodnione 644 aktualne hashe, **633 tabele całe bez zmian, 11 dokładnych zmian**. Listing pozostał **w całości identyczny**. Siedem projekcji odtworzyło pełne stare liczności/hashe `offer_plans`, `offer_sync_items`, `purchasing_stock_changes`, `stock`, `stock_locations`, `stock_movements`, `stock_location_movements`. Ograniczenie dotyczyło dokładnego nowego planu/itemu, markerów 1097/1098, wybranego produktu/magazynu/lokalizacji oraz jednego wskazanego nowego ruchu każdej tabeli. Cztery raw tabele zachowały wszystkie całe stare wiersze; doszło 13 audytów, 2 jobs, 2 polecenia i 1 konfiguracja A. Projekcje były wyłącznie SELECT przy RRRO; ROLLBACK/end potwierdzone, 0 zapisów. **Globalne zachowanie danych stock A PASS.** Nie dowodzi to liczby surowych PUT lub crash recovery.

Kluczowe ścieżki względem `/Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/`:

1. Utworzenie: `woo-import216-n20-A-create-prepared-agent-20261019-01/run-A01/result.private.json`,15948 B, SHA256 `2ea3b0f7a92febdf64e2b1d17289e5404660580537a31c44e29cd99145e39048`.
2. Monitor importu: `woo-import216-n20-A-observer-prepared-agent-20261019-01/observe01/result.private.json`,63015 B, SHA256 `bc3b8d44c34737435adb89d2466cb5b95b1e08029362a1f78f4cf8a2ddabdb06`.
3. Końcowy natywny odczyt przed stockiem: `woo-import216-n20-A-create-prepared-agent-20261019-01/native-closing-A01/result.private.json`,3323 B, SHA256 `da91c9034dd4ca39f8a3590cc13185dfbd397c86d369af4844c91dc2d30562a0`.
4. Globalny inverse importu: `crm217-read-fix-n20-prepared-agent-20261019-01/root-A-import-global-reconciliation.private.json`,14617 B, SHA256 `a00357021288ac99854b9fcd1b0152438dfb1eb446561f68c9ce2c1b92f3eabe`. Czytnik `root-A-import-global-reader.private.mjs` pozostaje zachowany; wynik opiera się na przed/po capture 644 oraz monitorze A, nie na przewidywanych rekordach.

Stock: `woo-stock-n20-A-observer-prepared-agent-20261019-01/run01/result.private.json`,33089 B, SHA256 `e317999356f35e81dcb4e914ca561f32448c2ec5951f71b5dfc31d7af937db19`; globalny proof `crm217-read-fix-n20-prepared-agent-20261019-01/root-A-stock-global-reconciliation.private.json`,24997 B, SHA256 `3b539da566c856ad64051957df0be57a9c686a00310043635594a9dcd3b19fb4`. Pełny końcowy produkt A zachowano w `run01/020-ack.private.json` obserwatora stock; audyt plikowy Acceptance i niniejszego autora zgadza się z bazowym natywnym GET przed stockiem.

## Granice

Nie odebrano importu/stocku wszystkich pięciu firm i wariantów, utraty ACK w locie, awarii/restartu/restore importu, skali, Base wire lub pełnego klona Base. Liczba surowych PUT lokalnego Woo oraz pełne odzyskiwanie aplikacji i prywatnego filesystemu nadal OPEN. Osobny [backup i odtworzenie bazy, konfiguracji i obrazu](N20-BACKUP-RESTORE-LOCAL-20261019.md) mają PASS: wszystkie 644 tabele i 719 zadań zachowane w nowej bazie PG04; podgląd odtworzonej aplikacji pozostaje odebrany częściowo (PARTIAL), z otwartymi poprawkami UI/API. Dane i klucze dostawcy są lokalne; nie użyto konta live. Dwa naturalne odczyty i stabilny receipt nie dowodzą odporności na każdą awarię. Pełny Goal OPEN.
