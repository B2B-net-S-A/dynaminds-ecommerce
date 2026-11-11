# API Base — zamówienia zakupu i transfery magazynowe

**Uzupełnienie dokumentacji z 18.10.2026, bez implementacji i odbioru konta.** Pełne grupy istniejącego indeksu204: `Product catalog / Purchase orders` (9) oraz `Transfers` (6), razem **15 metod**. Wszystkie znajdowały się w `remaining` lokalnego spisu pokrycia. Nie zmieniono indeksu, starszych snapshotów ani centralnej matrycy. Odczyt indywidualnych stron **18.10.2026, 01:06:00.697224–01:06:02.694489 UTC** nie jest dowodem ich treści z 17.10.

`documentation_only=true`, `official_account_requests_performed=false`, `implementation_verified=false`, `wire_acceptance=false`, `provider_account_acceptance=false`, `acceptance_granted=false`.

## Źródła i HTTP

Wykonano 15 publicznych GET oficjalnej dokumentacji, wszystkie HTTP200 na `https://api.baselinker.com`, z dokładnym nagłówkiem nazwy metody. Nie wysłano żądań do konta/`connector.php`, tokenów ani cookies konta; nie uruchamiano skryptów stron. Zachowano HTML UTF-8, final URL, status, Content-Type, datę pobrania i dostępne Date/ETag/Last-Modified, bez Set-Cookie. Daty publikacji wersji metod nie podano.

- [Snapshot](base-api-purchase-transfer-sources-20261018.json.gz): 153541 B; SHA256 `401288efad4ec411e73545b123ea041fcb19ac7a0dcc422d891c25b0920a77bc`.
- JSON: 883729 B; SHA256 `b98862dd6c7afaaa018671a9e92e42842921876b622efccdb71ac7a241b975e1`.
- Indeks204 SHA256 `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`; dwie grupy i dokładny zestaw 15 nazw sprawdzono osobno.

| Metoda | Pobranie UTC18.10 | HTML B | SHA256 HTML |
|---|---|---:|---|
| `addInventoryPurchaseOrder` | 01:06:00.835250 | 52772 | `16afc486811850b1f373732e0b78b680e6141d07943b3e51601b964a942756e6` |
| `addInventoryPurchaseOrderFile` | 01:06:00.697224 | 49258 | `42ad0da6712df81ccff0255155acc1f012494f78b82fee2c4520058daa1d2ba1` |
| `addInventoryPurchaseOrderItems` | 01:06:00.804532 | 51690 | `880dcb9c88723e3bd23512915ba396608b9f4fd6506f72742389ee9c41e7d555` |
| `getInventoryPurchaseOrderFile` | 01:06:00.793349 | 49201 | `766995bb55825fa3a25020320ab716c894896d25c816473f64fdb50a6e1218a8` |
| `getInventoryPurchaseOrderItems` | 01:06:01.132865 | 51688 | `184c538be80ac25dbf1a8d3cfd7e8c7b17094acac9d423789ab11213d629d16f` |
| `getInventoryPurchaseOrderLogs` | 01:06:01.264509 | 53503 | `279e251b0a3c49f55e66476101392c81636258a34e8b31b8f4a0e1a8efce8f4e` |
| `getInventoryPurchaseOrderSeries` | 01:06:01.303769 | 49579 | `ddc3c7137e99e774ef7dd39f0f2b374b334235e3ac3a2bb4c79ac47ba00a2b5e` |
| `getInventoryPurchaseOrders` | 01:06:01.374393 | 55242 | `3776779d45c14e854bddebabc57d7ddcac6ef8cdce4629a2d5e4003dc6266089` |
| `setInventoryPurchaseOrderStatus` | 01:06:01.741697 | 49534 | `0f4f6884bc0f6e8ec3309fe3239778b37208ed508de88521690476adc783620c` |
| `addInventoryTransfer` | 01:06:01.803024 | 50778 | `ca4c09db20f0a7e1d2bf00f73bf22c7d07829d23f4f748377c8d4819271018b3` |
| `addInventoryTransferItems` | 01:06:02.694489 | 51464 | `6893c5b3762b8f20370d7c29287ec3c38261fe39d6232b3ee5bea056655c2f03` |
| `getInventoryTransferItems` | 01:06:01.953255 | 51630 | `8f012a25e8b619158b049b49bceaad1a513d8d9c452f06dc62371d5c30099c4d` |
| `getInventoryTransferSeries` | 01:06:02.304134 | 49532 | `93db6889fe19a71dfc7ee13ec8716fa33dc02efdb4c8af08396ad07ef8b96465` |
| `getInventoryTransfers` | 01:06:02.357862 | 54643 | `cbc9e662484336900eb287655025c562772a855a7732fcbaf05b475b82ab28fa` |
| `setInventoryTransferStatus` | 01:06:02.490229 | 49583 | `d97a8a7577f5806e3b385a9d9f50ed6e5e27c890fb02035fc086c70caf3c562f` |

## Wspólne granice interpretacji

Przykłady pokazują POST do `https://api.baselinker.com/connector.php` z nagłówkiem `X-BLToken` i formularzem `method` + `parameters` (JSON argumentów); nie jest to test transmisji. Każda metoda ma `status: varchar(30)` SUCCESS/ERROR oraz w prozie `error_message` i `error_code`, bez typów i katalogu kodów. Nie założono obecności pól sukcesu przy błędzie ani mapowania na HTTP status.

Typy i nazwy tabel pozostają literalne. `↳` odwzorowuje źródłowy prefiks zagnieżdżenia `| -`; odpowiedni rodzic jest poprzedzającą kolekcją w tym samym kierunku. Głębsza proza ma osobne pełne ścieżki. Brak flagi required oznacza **nieokreślone**, nie opcjonalne. Nie dopisano limitów, nullowalności, walut, zaokrągleń, atomiczności, idempotencji ani bezpiecznego replay.

Nazwy identyfikatorów pozostają różne: `order_id` w większości metod zakupu, `purchase_order_id` dla plików/logów, `transfer_id` dla transferów. Odczyt dokumentacji nie wiąże ich z lokalnym UUID ani identyfikatorem zamówienia sprzedaży.

### addInventoryPurchaseOrder

Grupa: **Product catalog / Purchase orders**. [Oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryPurchaseOrder).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `warehouse_id` | `int` |
| in | `supplier_id` | `int` |
| in | `payer_id` | `int` |
| in | `currency` | `varchar(3)` |
| in | `name` | `varchar(80)` |
| in | `notes` | `text` |
| in | `invoice_no` | `varchar(50)` |
| in | `date_cost_invoice_issue` | `int` |
| in | `date_delivery_expected` | `int` |
| in | `additional_costs` | `array` |
| in | `↳name` | `varchar(30)` |
| in | `↳cost` | `decimal(10,2)` |
| in | `packages` | `array` |
| in | `↳courier_code` | `varchar(20)` |
| in | `↳courier_other_name` | `varchar(20)` |
| in | `↳package_number` | `varchar(40)` |
| out | `status` | `varchar(30)` |
| out | `order_id` | `int` |
| out | `document_number` | `varchar(50)` |

Tworzy zakup w magazynie w domyślnym stanie **draft**; zwraca ID i numer dokumentu. `name`, `notes`, `invoice_no`, obie daty i obie kolekcje są opcjonalne. Required dla magazynu/dostawcy/płatnika/waluty nie oznaczono osobno. Daty są Unix timestamps. Koszt dodatkowy ma wartość co najmniej **0.01**. Kody kurierów pobiera się z `getCouriersList`; `courier_other_name` jest opcjonalne ogólnie, ale **wymagane dla `courier_code="other"`**. Nie zakładamy limitu kosztów/paczek, wyboru serii, sposobu sumowania kosztów, zmiany stanów ani idempotencji. `additional_costs` pozostaje liczbą mnogą, w odróżnieniu od getterowego `additional_cost`; `date_delivery_expected` nie jest przemianowywane na getterowe `date_expected_delivery`.

### addInventoryPurchaseOrderFile

Grupa: **Product catalog / Purchase orders**. [Oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryPurchaseOrderFile).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `purchase_order_id` | `int` |
| in | `file` | `text` |
| in | `cost_invoice_no` | `varchar(100)` |
| out | `status` | `varchar(30)` |

Przesyła PDF faktury jako base64 w `file`, ze źródłowym prefiksem **`data:`**. Nie dopisano MIME/data-URI ani formatu multipart. `cost_invoice_no` jest opcjonalne i ma **varchar(100)**, inaczej niż numer w create/list. Tu identyfikator nazywa się `purchase_order_id`, nie `order_id`. Brak limitu bajtów, zachowania po ponownym uploadzie/zastąpieniu, usuwania, walidacji PDF i readback hasha. Nie wykonano uploadu.

### addInventoryPurchaseOrderItems

Grupa: **Product catalog / Purchase orders**. [Oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryPurchaseOrderItems).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| in | `items` | `array` |
| in | `↳product_id` | `int` |
| in | `↳quantity` | `int` |
| in | `↳item_cost` | `decimal(10,2)` |
| in | `↳supplier_code` | `varchar(50)` |
| in | `↳location` | `varchar(255)` |
| in | `↳batch` | `varchar(128)` |
| in | `↳expiry_date` | `text` |
| in | `↳serial_no` | `varchar(128)` |
| in | `↳comments` | `varchar(255)` |
| out | `status` | `varchar(30)` |
| out | `items` | `array` |
| out | `↳item_id` | `int` |
| out | `↳position` | `int` |

Dodaje pozycje do istniejącego zakupu. Opis mówi o aktualizacji poprzedniej pozycji przy zgodnym ID produktu i cenie oraz wszystkich pozostałych parametrach; różnica, np. lokacja, tworzy nową pozycję. Nie domyślamy się jednak zwiększenia versus zastąpienia ilości ani klucza deduplikacji. Koszt, kod dostawcy, lokacja, batch, expiry, serial i komentarz są opcjonalne. `quantity` ma typ int, bez jawnego minimum; nie przeniesiono warunku dodatniości z transferów. `expiry_date` jest tu **text**, bez zadeklarowanego formatu. Brak limitu partii, atomowości, mapowania response do input i zasad ponowienia.

### getInventoryPurchaseOrderFile

Grupa: **Product catalog / Purchase orders**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryPurchaseOrderFile).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `purchase_order_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `file` | `text` |
| out | `cost_invoice_no` | `varchar(100)` |
| out | `file_name` | `varchar(255)` |

Odczytuje zakodowany PDF z prefiksem `data:`, numer faktury i nazwę pliku. Nie zamieniono tego w URL ani binarny body HTTP; URL `cost_invoice_file` w liście zakupów jest osobnym polem. Required dla ID oraz brak pliku, limit rozmiaru, typ MIME, integralność i kod błędu nie są opisane.

### getInventoryPurchaseOrderItems

Grupa: **Product catalog / Purchase orders**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryPurchaseOrderItems).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `items` | `array` |
| out | `↳item_id` | `int` |
| out | `↳order_id` | `int` |
| out | `↳position` | `int` |
| out | `↳product_id` | `int` |
| out | `↳product_name` | `varchar(255)` |
| out | `↳product_ean` | `varchar(32)` |
| out | `↳product_sku` | `varchar(50)` |
| out | `↳inventory_id` | `int` |
| out | `↳quantity` | `int` |
| out | `↳expiry_date` | `varchar(10)` |
| out | `↳batch` | `varchar(128)` |
| out | `↳serial_no` | `varchar(128)` |
| out | `↳supplier_code` | `varchar(50)` |
| out | `↳completed_quantity` | `int` |
| out | `↳item_cost` | `decimal(10,2)` |
| out | `↳location` | `varchar(2550)` |
| out | `↳comments` | `varchar(255)` |

`page` jest opcjonalne: **100 pozycji na stronę, numeracja od 1**; default nie podano. `completed_quantity` oznacza odebraną ilość, `item_cost` jednostkowy koszt. `expiry_date` ma format YYYY-MM-DD i varchar(10). Zachowano nietypowy literalny typ **`location: varchar(2550)`**, nie poprawiono na varchar(255) z zapisu. Kilka lokacji rozdziela średnik. Brak kolejności, total/has_more/kursora, stabilności stron oraz gwarancji wartości 0/NULL dla nieustawionych danych.

### getInventoryPurchaseOrderLogs

Grupa: **Product catalog / Purchase orders**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryPurchaseOrderLogs).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `purchase_order_id` | `int` |
| in | `date_from` | `int` |
| in | `date_to` | `int` |
| in | `log_type` | `array` |
| in | `sort` | `varchar(4)` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `logs` | `array` |
| out | `↳profile` | `text` |
| out | `↳date` | `int` |
| out | `↳entries` | `array` |

`purchase_order_id` identyfikuje zakup/dostawę. Pozostałe filtry są opcjonalne: granice dat Unix, lista numerycznych typów, `sort` (domyślnie **ASC**) i `page` (**100 grup logów**, nie 100 pojedynczych eventów). Logi grupuje data i profil. Nie podano domyślnej strony, jej numeracji, inkluzywności dat ani pełnego enum kierunku sortowania.

Numery filtra 0–11 odpowiadają: 0 utworzeniu, 1 usunięciu, 2 statusowi, 3 emailowi dostawcy, 4 edycji pól tekstowych, 5 pozycjom, 6 kosztom dodatkowym, 7 paczkom, 8 udostępnieniu supply page, 9 negocjacjom, 10 merge, 11 split. Wynik używa **tekstowych kluczy**, nie tych numerów; pełne klucze i warunki pól zapisano poniżej. Nie traktujemy logu jako dowodu efektu księgowego/WMS ani kompletnego audytu poza udokumentowanym zakresem.

Dodatkowe pola wymienione w prozie komórki, nie osobne wiersze HTML:

| Ścieżka | Typ źródłowy | Znaczenie/warunek |
|---|---|---|
| `logs[].entries[].log_type` | `text` | klucz rodzaju; pełny zbiór poniżej |
| `logs[].entries[].status_key` | `text` | tylko status_change |
| `logs[].entries[].field_key` | `text` | tylko text_field_modification |
| `logs[].entries[].previous_value` | `text` | tylko text_field_modification |
| `logs[].entries[].email_recipient` | `text` | tylko email_sent_to_supplier |
| `logs[].entries[].items_changes_count` | `int` | tylko items_modification |
| `logs[].entries[].landed_costs_changes_count` | `int` | tylko landed_costs_modification |
| `logs[].entries[].packages_changes_count` | `int` | tylko packages_modification |
| `logs[].entries[].item_negotiations_count` | `int` | tylko item_negotiations |
| `logs[].entries[].related_purchase_order_id` | `int` | tylko purchase_order_merge/purchase_order_split |
| `logs[].entries[].related_purchase_order_full_number` | `text` | tylko purchase_order_merge/purchase_order_split |

Pełne `log_type` wyniku: `purchase_order_creation`, `purchase_order_deletion`, `status_change`, `email_sent_to_supplier`, `text_field_modification`, `items_modification`, `landed_costs_modification`, `packages_modification`, `shared_via_supply_page`, `item_negotiations`, `purchase_order_merge`, `purchase_order_split`. `status_key`: `draft`, `sent`, `received_not_started`, `received`, `completed`, `completed_partially`, `canceled`. `field_key`: `name`, `status`, `full_number`, `notes`. Nie rozszerzono tych zbiorów ani nie ujednolicono ich z numerycznymi filtrami.

### getInventoryPurchaseOrderSeries

Grupa: **Product catalog / Purchase orders**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryPurchaseOrderSeries).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `warehouse_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `series` | `array` |
| out | `↳series_id` | `int` |
| out | `↳name` | `varchar(20)` |
| out | `↳warehouse_id` | `int` |
| out | `↳format` | `varchar(30)` |

Opcjonalny `warehouse_id` filtruje serie numeracji. Nazwa, przypisany magazyn i wzorzec numeru są oddzielnymi polami. Nie podano paginacji, kolejności, limitu, sposobu wyboru domyślnej serii ani sposobu rezerwacji numeru; przykład wzorca nie staje się językiem formatowania.

### getInventoryPurchaseOrders

Grupa: **Product catalog / Purchase orders**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryPurchaseOrders).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `warehouse_id` | `int` |
| in | `supplier_id` | `int` |
| in | `series_id` | `int` |
| in | `date_from` | `int` |
| in | `date_to` | `int` |
| in | `filter_document_number` | `varchar(50)` |
| in | `filter_product_id` | `int` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `purchase_orders` | `array` |
| out | `↳id` | `int` |
| out | `↳name` | `varchar(80)` |
| out | `↳series_id` | `int` |
| out | `↳document_number` | `varchar(50)` |
| out | `↳date_created` | `int` |
| out | `↳date_sent` | `int` |
| out | `↳date_received` | `int` |
| out | `↳date_completed` | `int` |
| out | `↳date_expected_delivery` | `int` |
| out | `↳warehouse_id` | `int` |
| out | `↳assigned_to` | `int` |
| out | `↳supplier_id` | `int` |
| out | `↳payer_id` | `int` |
| out | `↳currency` | `varchar(3)` |
| out | `↳total_quantity` | `int` |
| out | `↳completed_total_quantity` | `int` |
| out | `↳total_cost` | `decimal(10,2)` |
| out | `↳additional_cost` | `array` |
| out | `↳completed_total_cost` | `decimal(10,2)` |
| out | `↳items_count` | `int` |
| out | `↳completed_items_count` | `int` |
| out | `↳cost_invoice_no` | `varchar(50)` |
| out | `↳date_cost_invoice_issue` | `int` |
| out | `↳cost_invoice_file` | `varchar(255)` |
| out | `↳notes` | `text` |
| out | `↳status` | `int` |

Wszystkie filtry są opcjonalne; `page` daje **100 dokumentów**, bez jawnego default/numeracji. Numer dokumentu wspiera pełne lub częściowe dopasowanie, a filtr produktu wybiera zakupy zawierające produkt. Magazyn pochodzi z `getInventoryWarehouses`, lecz nie dopisano tu aliasu `internal_warehouse_id` z API pozycji sprzedażowych. Daty są Unix timestamps, a `assigned_to=0` oznacza brak pracownika.

Opcjonalne pola wyniku to daty received/completed/expected, płatnik, `additional_cost`, numer/data/URL faktury kosztowej i notes. Ilości/koszty completed dotyczą odebranych pozycji. Statusy tabeli: **0 draft, 1 sent, 2 received, 3 completed, 4 completed partially, 5 canceled**. Setter dodatkowo wymienia **6 received (not started)** — brak tej wartości w getterowym opisie pozostaje rozbieżnością, nie zamkniętym wspólnym enum. Typy kosztów to decimal(10,2), bez potwierdzonych reguł walut/zaokrągleń. Brak total/cursora/kolejności i definicji stabilnego snapshotu.

Dodatkowe pola wymienione w prozie komórki, nie osobne wiersze HTML:

| Ścieżka | Typ źródłowy | Znaczenie/warunek |
|---|---|---|
| `purchase_orders[].additional_cost[].name` | `varchar(30)` | nazwa kosztu |
| `purchase_orders[].additional_cost[].cost` | `decimal(10,2)` | wartość kosztu |

### setInventoryPurchaseOrderStatus

Grupa: **Product catalog / Purchase orders**. [Oficjalna strona](https://api.baselinker.com/index.php?method=setInventoryPurchaseOrderStatus).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| in | `status` | `int` |
| in | `completed_items` | `array` |
| in | `↳item_id` | `int` |
| in | `↳completed_quantity` | `int` |
| out | `status` | `varchar(30)` |

Zapisuje nowy status: **0 draft, 1 sent, 2 received, 3 completed, 4 completed partially, 5 canceled, 6 received (not started)**. `completed_items` jest opcjonalną listą odebranych ilości. Required dla ID/statusu nie oznaczono osobno. Nie opisano dozwolonego grafu przejść, cofania, sumowania versus zastępowania ilości, ponowienia, pominiętych pozycji ani skutków stock/finansów. Nie przeniesiono semantyki „pominięte=missing” z setteru transferów.

### addInventoryTransfer

Grupa: **Product catalog / Transfers**. [Oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryTransfer).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `warehouse_id` | `int` |
| in | `target_warehouse_id` | `int` |
| in | `transfer_type` | `int` |
| in | `name` | `varchar(100)` |
| in | `priority` | `int` |
| in | `assigned_to` | `int` |
| in | `date_scheduled` | `int` |
| in | `date_due` | `int` |
| in | `notes` | `varchar(255)` |
| out | `status` | `varchar(30)` |
| out | `transfer_id` | `int` |
| out | `transfer_number` | `varchar(30)` |

Tworzy transfer w stanie **draft**. Oba magazyny muszą należeć do katalogów z **advanced WMS**; źródłowy i docelowy mogą być tym samym magazynem dla zmiany lokacji. Pozostałe wejścia są opcjonalne: typ **0 replenishment (default), 1 putaway, 2 location change**; priorytet **0 low (default), 1 medium, 2 high, 3 urgent**; nazwa/pracownik/daty/notes. Daty są Unix, `date_due >= date_scheduled`. Nie opisano wyniku pominięcia tylko jednej daty, rezerwacji stanów, wykonania ruchu przy utworzeniu, doboru serii ani idempotencji.

### addInventoryTransferItems

Grupa: **Product catalog / Transfers**. [Oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryTransferItems).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `transfer_id` | `int` |
| in | `items` | `array` |
| in | `↳product_id` | `int` |
| in | `↳quantity` | `int` |
| in | `↳location_name` | `varchar(20)` |
| in | `↳target_location_name` | `varchar(20)` |
| in | `↳expiry_date` | `varchar(10)` |
| in | `↳batch` | `varchar(128)` |
| in | `↳serial_no` | `varchar(128)` |
| out | `status` | `varchar(30)` |
| out | `items` | `array` |
| out | `↳item_id` | `int` |
| out | `↳position` | `int` |

Dodaje **planowane** pozycje wyłącznie do transferu draft. Zgodny produkt i wszystkie inne parametry aktualizują wcześniejszą pozycję; różnica, np. lokacja, tworzy nową. Nie domyślono zwiększenia versus zastąpienia ilości. `quantity` musi być **dodatnim int**. Lokacje, expiry, batch i serial są opcjonalne; źródłowa lokacja musi odpowiadać istniejącej jednostce stock WMS. Expiry ma YYYY-MM-DD; expiry/batch/serial służą dopasowaniu jednostki. Brak limitu partii, atomowości, rozróżnienia pustych wartości i null, współbieżności oraz readback wykonania fizycznego.

### getInventoryTransferItems

Grupa: **Product catalog / Transfers**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryTransferItems).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `transfer_id` | `int` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `items` | `array` |
| out | `↳item_id` | `int` |
| out | `↳transfer_id` | `int` |
| out | `↳position` | `int` |
| out | `↳product_id` | `int` |
| out | `↳product_name` | `varchar(255)` |
| out | `↳product_ean` | `varchar(32)` |
| out | `↳product_sku` | `varchar(50)` |
| out | `↳inventory_id` | `int` |
| out | `↳quantity` | `int` |
| out | `↳expiry_date` | `varchar(10)` |
| out | `↳batch` | `varchar(128)` |
| out | `↳serial_no` | `varchar(128)` |
| out | `↳completed_quantity` | `int` |
| out | `↳is_completed` | `bool` |
| out | `↳location_name` | `varchar(20)` |
| out | `↳target_location_name` | `varchar(20)` |

Opcjonalna `page`: **100 pozycji na stronę, od 1**, bez jawnego default. Pola produktu i metryki planu są oddzielone od `completed_quantity` (ilość rzeczywiście przeniesiona) oraz `is_completed` (zweryfikowanie w WMS). Expiry jest YYYY-MM-DD. `location_name` i `target_location_name` mają po varchar(20); nie zastąpiono ich lokacją z dokumentu zakupowego. Brak kolejności, total/kursora/has_more, stabilności oraz formatów braku wartości.

### getInventoryTransferSeries

Grupa: **Product catalog / Transfers**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryTransferSeries).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `warehouse_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `series` | `array` |
| out | `↳series_id` | `int` |
| out | `↳name` | `varchar(20)` |
| out | `↳warehouse_id` | `int` |
| out | `↳format` | `varchar(30)` |

Opcjonalny magazyn filtruje serie transferów; wynik podaje ID, nazwę, magazyn i wzorzec numeru. Nie przeniesiono na te serie formatu numeracji zakupów, nie podano paginacji, kolejności, limitu ani zasad blokowania numerów.

### getInventoryTransfers

Grupa: **Product catalog / Transfers**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryTransfers).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `filter_transfer_id` | `int` |
| in | `filter_warehouse_id` | `int` |
| in | `filter_target_warehouse_id` | `int` |
| in | `filter_transfer_status` | `int` |
| in | `filter_transfer_type` | `int` |
| in | `filter_series_id` | `int` |
| in | `filter_date_from` | `int` |
| in | `filter_date_to` | `int` |
| in | `filter_transfer_number` | `varchar(30)` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `transfers` | `array` |
| out | `↳transfer_id` | `int` |
| out | `↳transfer_number` | `varchar(30)` |
| out | `↳name` | `varchar(100)` |
| out | `↳transfer_type` | `int` |
| out | `↳transfer_status` | `int` |
| out | `↳series_id` | `int` |
| out | `↳warehouse_id` | `int` |
| out | `↳target_warehouse_id` | `int` |
| out | `↳priority` | `int` |
| out | `↳assigned_to` | `int` |
| out | `↳items_count` | `int` |
| out | `↳total_quantity` | `int` |
| out | `↳completed_items_count` | `int` |
| out | `↳completed_total_quantity` | `int` |
| out | `↳compliant_items_count` | `int` |
| out | `↳not_compliant_items_count` | `int` |
| out | `↳missing_items_count` | `int` |
| out | `↳date_created` | `int` |
| out | `↳date_scheduled` | `int` |
| out | `↳date_due` | `int` |
| out | `↳date_status_change` | `int` |
| out | `↳notes` | `varchar(255)` |

Wszystkie filtry są opcjonalne; strona ma **100 transferów, od 1**, bez jawnego default. Numer dopasowuje częściowo; daty filtrowania dotyczą utworzenia. Typy: **0 replenishment, 1 putaway, 2 location change**; statusy: **0 draft, 1 commissioned, 2 in progress, 3 completed**; priorytety 0–3 jak przy tworzeniu. `assigned_to=0` i zerowe daty scheduled/due/status_change oznaczają brak ustawienia/zmiany.

Completed liczy zweryfikowane pozycje/ilości; compliant to zgodna ilość, not_compliant różna, missing zerowa ilość completed. Nie wywiedziono stąd równań między licznikami, stanu ledgerów ani rozliczenia kosztów. Brak total/kursora, kolejności, inkluzywności dat i stabilności stron podczas pracy.

### setInventoryTransferStatus

Grupa: **Product catalog / Transfers**. [Oficjalna strona](https://api.baselinker.com/index.php?method=setInventoryTransferStatus).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `transfer_id` | `int` |
| in | `status` | `int` |
| in | `completed_items` | `array` |
| in | `↳item_id` | `int` |
| in | `↳completed_quantity` | `int` |
| out | `status` | `varchar(30)` |

Zmienia status na **0 draft, 1 commissioned, 2 in progress, 3 completed**. `completed_items` jest opcjonalne. Przy **kończeniu** pominięte i wcześniej niezweryfikowane pozycje są oznaczane jako brakujący towar — to istotny udokumentowany skutek, nie neutralny patch. `completed_quantity` to ilość przeniesiona do docelowej lokacji. Nie opisano grafu przejść/cofania, dozwolonych odchyleń, zachowania już zweryfikowanych pozycji przy replay, atomowości WMS ani trwałej idempotencji. Nie wykonano żadnego status-write.

## Pokrycie i późniejszy odbiór

Niezależny parser DOM całych stron porównuje każdy kierunek, nazwę i typ z Markdown, z zachowaniem separatorów `<br>`/`<li>`. Osobno porównuje 13 głębszych pól z prozy, warunki i zbiory enum logów; liczby nie zastępują zgodności pól. Każdy HTML ma sprawdzone bajty, SHA, HTTP, nagłówek metody i przynależność do indeksu.

| Metoda | in | out | nested in | nested out | pola z prozy |
|---|---:|---:|---:|---:|---:|
| `addInventoryPurchaseOrder` | 16 | 3 | 5 | 0 | 0 |
| `addInventoryPurchaseOrderFile` | 3 | 1 | 0 | 0 | 0 |
| `addInventoryPurchaseOrderItems` | 11 | 4 | 9 | 2 | 0 |
| `getInventoryPurchaseOrderFile` | 1 | 4 | 0 | 0 | 0 |
| `getInventoryPurchaseOrderItems` | 2 | 19 | 0 | 17 | 0 |
| `getInventoryPurchaseOrderLogs` | 6 | 5 | 0 | 3 | 11 |
| `getInventoryPurchaseOrderSeries` | 1 | 6 | 0 | 4 | 0 |
| `getInventoryPurchaseOrders` | 8 | 28 | 0 | 26 | 2 |
| `setInventoryPurchaseOrderStatus` | 5 | 1 | 2 | 0 | 0 |
| `addInventoryTransfer` | 9 | 3 | 0 | 0 | 0 |
| `addInventoryTransferItems` | 9 | 4 | 7 | 2 | 0 |
| `getInventoryTransferItems` | 2 | 18 | 0 | 16 | 0 |
| `getInventoryTransferSeries` | 1 | 6 | 0 | 4 | 0 |
| `getInventoryTransfers` | 10 | 24 | 0 | 22 | 0 |
| `setInventoryTransferStatus` | 5 | 1 | 2 | 0 | 0 |
| **Razem** | 89 | 127 | 25 | 96 | 13 |

W prozie statusów potwierdzono 30 wystąpień dwóch pól błędu; nie doliczono ich do tabel. Wszystkie 15 metod ma wyłącznie dowód dokumentacyjny, bez przypisania do runtime route i bez pozytywnego acceptance.

Odbiór implementacji wymaga osobno zwykłego UI/API i odczytu efektu: tworzenia draft, dopasowania versus dodania pozycji, partii/lokacji/serial/expiry, domknięcia częściowego, omitted-unverified→missing przy transferze, plików i numerów dokumentów, paginacji ponad100, uprawnień i izolacji. WMS/stock i finanse muszą mieć niezmienne lub dokładnie oczekiwane skutki, także po błędzie i utracie ACK; sama zmiana statusu lub log nie wystarcza. Zewnętrzne konto i wire Base pozostają osobnymi otwartymi próbami. Żadnego domyślnego retry mutacji nie wyprowadzono z tych stron.
