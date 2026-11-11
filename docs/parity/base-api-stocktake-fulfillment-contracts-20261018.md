# API Base — inwentaryzacje i dostawy fulfillment

**Dokumentacja, nie implementacja.** Uzupełnienie z 18.10.2026 dla 12 metod istniejącego indeksu 204 z 17.10: Stocktakes (6) i Fulfillment deliveries (6). Bez zmian indeksu, starszych snapshotów, centralnej matrycy ani metod Purchase/Transfers.

`documentation_only=true`, `implementation_verified=false`, `wire_acceptance=false`, `provider_account_acceptance=false`, `official_account_requests_performed=false`, `acceptance_granted=false`.

## Źródła i data

[Snapshot HTML](base-api-stocktake-fulfillment-sources-20261018.json.gz) zachowuje dokładne odpowiedzi 12 publicznych GET: HTTP 200, URL końcowe, bajty UTF-8, SHA256 i dostępne metadane nagłówków. Odczyt: **2026-10-18T01:06:30.811582+00:00 → 2026-10-18T01:06:32.131382+00:00**. To czas pobrania, nie publikacji ani dowód stron indywidualnych z 17.10.

- Gzip: 122971 B, SHA256 `6b016b5366c4424dc8311136c9368af0738a0493f9b5208e3c4da9bafe9fea79`.
- JSON: 701988 B, SHA256 `1852345a169e2c8044e4d77d1edaf022ca8f1ca40e6ea087a6992acc9f192546`.
- Indeks 17.10 JSON: SHA256 `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`.

Czytnik WWW otworzył 11 stron; dla getInventoryFulfillmentDeliveryLabels zgłosił niedostępność URL bez kodu HTTP. Osobny GET oficjalnego URL zwrócił HTTP 200 także dla tej strony; oba fakty zapisano w bundle. Nie używano cookies/tokenów konta ani connector.php, nie wykonywano skryptów HTML.

| Metoda | HTML B | SHA256 HTML UTF-8 |
|---|---:|---|
| `addInventoryStocktake` | 52662 | `76d8e9cf567eb65076875fc6ad7fcb81bbb1eb8f2e420e09bf385a7517ffb4e3` |
| `addInventoryStocktakeItems` | 50975 | `fa07ae9a39ed7b0f1a8e79b07335317d436101ea92601cd339f26344ecec2ba0` |
| `getInventoryStocktakeItems` | 51459 | `0dff411720355c06a39efef88780c965d19d49010fedf67d3533cb79212947ea` |
| `getInventoryStocktakeSeries` | 49540 | `a2d685346a672792e6ac059a9de7ec24d737854f3808402260b97b553e9f162b` |
| `getInventoryStocktakes` | 54205 | `eff81c2f2ceee0d8d584ffe3ea0f0e7f351ad1930b1736321239b8abda35e9a6` |
| `setInventoryStocktakeStatus` | 49702 | `d7fe95d74b4ac1b18253ee9db3249f9c58a526e20a300659744fd1127539bf84` |
| `addInventoryFulfillmentDelivery` | 49422 | `394d688b96057f66d4b3d92b25a3c2e728420ab574ba0bd1096c0590978ddecf` |
| `addInventoryFulfillmentDeliveryItems` | 50457 | `29309a7f6aaa664ca4f0287777ef322cdf61fb431ea31c2c22fec51ca4c2312f` |
| `getInventoryFulfillmentDeliveries` | 53802 | `ea72bc9c1e232f57433e29060f74a4fa5bc80c83f9ed5838114993bff5e05e72` |
| `getInventoryFulfillmentDeliveryItems` | 50234 | `1c1664413a2df3ac937c1e287f65326412b976f3e736ff3c33236dcc585485db` |
| `getInventoryFulfillmentDeliveryLabels` | 49902 | `8162c3d3210d4ee89f2a24e157ee98d8d7a7e3ad06d9715ff2f9fceeb2b0a782` |
| `runInventoryFulfillmentDeliverySubmission` | 49673 | `05912bdb488048209d2ed1ff462dbdf0cecc50e3423d854af2445feb8286d82b` |

## Wspólna koperta i granice

Przykłady dokumentują POST do `https://api.baselinker.com/connector.php`, nagłówek X-BLToken oraz formularz method + parameters zawierający JSON. Nie wykonywano takiej transmisji. Każdy wynik ma status: varchar(30), SUCCESS/ERROR. W opisie każdego statusu wymieniono error_message i error_code, lecz bez ich typów, konkretnych kodów i mapowania na HTTP. Nie zakładamy pól sukcesu przy błędzie.

Tabele poniżej zachowują wszystkie nazwy/typy input, output i pól zagnieżdżonych. in/out oznacza kierunek; znak [] oznacza element tablicy. Pionowa kreska w int\|null należy do literalnego typu. Optional/default zapisano tylko według prozy; brak osobnej flagi required nie dowodzi opcjonalności. ID int nie oznacza lokalnego UUID ani autoryzacji. Nie zakładamy pomijania/null zamiennie, precyzji pieniędzy, limitów rate/batch, ogólnej idempotencji ani bezpiecznych ponowień.

## Kontrakty metod

### addInventoryStocktake

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryStocktake).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `warehouse_id` | `int` |
| in | `scope` | `int` |
| in | `name` | `varchar(80)` |
| in | `priority` | `int` |
| in | `assigned_to` | `int` |
| in | `date_scheduled` | `int` |
| in | `date_due` | `int` |
| in | `approval_method` | `text` |
| in | `blind_count` | `bool` |
| in | `confirm_location` | `bool` |
| in | `allow_add_remove_items` | `bool` |
| in | `product_ids` | `array` |
| in | `scope_zones` | `array` |
| in | `scope_locations_prefix` | `varchar(255)` |
| in | `scope_random_count` | `int` |
| out | `status` | `varchar(30)` |
| out | `stocktake_id` | `int` |
| out | `stocktake_number` | `varchar(50)` |
| out | `items_preparation_status` | `text` |

Tworzy szkic; zakresy niemanualne automatycznie przygotowują pozycje. `warehouse_id` pochodzi z `getInventoryWarehouses`. `scope`: 0 wszystkie, 1 ręczny, 3 strefy, 4 prefiksy, 5 losowy; 2 nie opisano. Opcjonalne: name, priority (0 domyślnie; 1/2/3), assigned_to, oba terminy Unix, approval_method (immediate domyślnie lub confirm), trzy bool (false domyślnie). `date_due>=date_scheduled`. immediate kończy po liczeniu, confirm wymaga drugiej akceptacji; blind_count ukrywa ilość oczekiwaną, confirm_location wymusza skan/potwierdzenie lokalizacji. Ręczny scope wymaga product_ids prostych produktów/wariantów i wymusza allow_add_remove_items=true; 3 wymaga scope_zones; 4 scope_locations_prefix z separatorem średnik; 5 dodatniego scope_random_count. Wynik przygotowania: ready/pending. Nieznane: typ elementów tablic, limit, wybór serii, determinizm losowania, czas przygotowania i błędy async.

### addInventoryStocktakeItems

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryStocktakeItems).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `stocktake_id` | `int` |
| in | `items` | `array` |
| in | `items[].product_id` | `int` |
| in | `items[].quantity` | `int` |
| in | `items[].location_name` | `varchar(255)` |
| in | `items[].expiry_date` | `varchar(10)` |
| in | `items[].batch` | `varchar(128)` |
| in | `items[].serial_no` | `varchar(128)` |
| out | `status` | `varchar(30)` |
| out | `items` | `array` |
| out | `items[].item_id` | `int` |
| out | `items[].position` | `int` |

Dodaje tylko do szkicu. Ten sam produkt z takimi samymi parametrami aktualizuje pozycję; różnica parametru tworzy nową. `quantity` oznacza oczekiwaną ilość całkowitą >=0, nie wynik liczenia. location_name, expiry_date, batch, serial_no opcjonalne; expiry_date ma format YYYY-MM-DD. Wynik zawiera item_id i position. Nieznane: które dokładnie parametry tworzą klucz dopasowania, znaczenie pominięcia kontra pustego tekstu, zastąpienie kontra przyrost ilości, limit batcha, atomowość i retry.

### getInventoryStocktakeItems

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryStocktakeItems).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `stocktake_id` | `int` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `items` | `array` |
| out | `items[].item_id` | `int` |
| out | `items[].stocktake_id` | `int` |
| out | `items[].position` | `int` |
| out | `items[].product_id` | `int` |
| out | `items[].product_name` | `varchar(255)` |
| out | `items[].product_ean` | `varchar(32)` |
| out | `items[].product_sku` | `varchar(50)` |
| out | `items[].inventory_id` | `int` |
| out | `items[].quantity` | `int` |
| out | `items[].expiry_date` | `varchar(10)` |
| out | `items[].batch` | `varchar(128)` |
| out | `items[].serial_no` | `varchar(128)` |
| out | `items[].verified_quantity` | `int` |
| out | `items[].is_verified` | `bool` |
| out | `items[].location_name` | `varchar(2550)` |

Odczyt pozycji konkretnej inwentaryzacji: opcjonalne page, 100 pozycji na stronę, numeracja od 1. Brak jawnej domyślnej strony, total/cursora i reguły końca. quantity to ilość pozycji; verified_quantity i is_verified opisują faktyczne liczenie. location_name ma literalny typ varchar(2550), a wiele lokalizacji rozdziela średnik; input innej metody ma varchar(255). expiry_date YYYY-MM-DD. Nieznane: kolejność/stabilność stron, nullowalność nieopisanych pól oraz czy blind_count redaguje quantity w API.

### getInventoryStocktakeSeries

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryStocktakeSeries).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `warehouse_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `series` | `array` |
| out | `series[].series_id` | `int` |
| out | `series[].name` | `varchar(20)` |
| out | `series[].warehouse_id` | `int` |
| out | `series[].format` | `varchar(30)` |

Zwraca serie związane z magazynem i format numeracji; opcjonalny warehouse_id filtruje magazyn. Tabela nie opisuje paginacji, flagi domyślnej serii, wyboru serii podczas create ani reguł interpretacji wszystkich symboli format. Nie zakładamy limitu liczby serii ani operacji ich edycji.

### getInventoryStocktakes

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryStocktakes).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `filter_stocktake_id` | `int` |
| in | `filter_warehouse_id` | `int` |
| in | `filter_stocktake_status` | `int` |
| in | `filter_series_id` | `int` |
| in | `filter_stocktake_number` | `varchar(50)` |
| in | `filter_date_from` | `int` |
| in | `filter_date_to` | `int` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `stocktakes` | `array` |
| out | `stocktakes[].stocktake_id` | `int` |
| out | `stocktakes[].stocktake_number` | `varchar(50)` |
| out | `stocktakes[].name` | `varchar(80)` |
| out | `stocktakes[].stocktake_status` | `int` |
| out | `stocktakes[].series_id` | `int` |
| out | `stocktakes[].warehouse_id` | `int` |
| out | `stocktakes[].priority` | `int` |
| out | `stocktakes[].assigned_to` | `int` |
| out | `stocktakes[].items_count` | `int` |
| out | `stocktakes[].verified_items_count` | `int` |
| out | `stocktakes[].total_quantity` | `int` |
| out | `stocktakes[].verified_total_quantity` | `int` |
| out | `stocktakes[].compliant_items_count` | `int` |
| out | `stocktakes[].not_compliant_items_count` | `int` |
| out | `stocktakes[].missing_items_count` | `int` |
| out | `stocktakes[].date_created` | `int` |
| out | `stocktakes[].date_completed` | `int` |
| out | `stocktakes[].date_scheduled` | `int` |
| out | `stocktakes[].date_due` | `int` |
| out | `stocktakes[].notes` | `text` |
| out | `stocktakes[].items_preparation_status` | `text` |

Wszystkie filtry i page opcjonalne. Statusy: 0 draft, 1 commissioned, 2 in progress, 3 completed, 4 counted, 5 rejected; filtr numeru jest częściowym dopasowaniem. Daty filtrują utworzenie i są Unix. Page: 100 wyników, od 1; brak jawnego default/total/końca. Priority 0/1/2/3; assigned_to=0 brak pracownika; date_completed=0 niezakończona, date_scheduled/date_due=0 nieustawione. Liczniki odróżniają pozycje/sztuki, oczekiwane/policzone oraz zgodne/niezgodne/brakujące (oczekiwane>0, policzone=0). items_preparation_status: ready/pending/error. Nieznane: stabilność stron, granice dat, pełna macierz przejść i przyczyny przygotowania error.

### setInventoryStocktakeStatus

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=setInventoryStocktakeStatus).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `stocktake_id` | `int` |
| in | `status` | `int` |
| in | `completed_items` | `array` |
| in | `completed_items[].item_id` | `int` |
| in | `completed_items[].completed_quantity` | `int` |
| out | `status` | `varchar(30)` |

Przyjmuje statusy 0 draft, 1 commissioned, 2 in progress, 3 completed, 4 counted, 5 rejected. Opcjonalne completed_items wolno podać dla 2/4/3; completed_quantity >=0. Zakończenie stosuje policzone ilości do stanów magazynowych i generuje dokumenty; sam SUCCESS nie dowodzi ich fizycznego wykonania w lokalnym klonie. Nieznane: dozwolone przejścia ze wszystkich stanów, cofanie zakończenia, reguły confirm/approval, zakres korygowanego stanu, typy dokumentów, atomowość, idempotencja i rozstrzygnięcie utraty ACK.

### addInventoryFulfillmentDelivery

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryFulfillmentDelivery).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `warehouse_id` | `int` |
| in | `fulfillment_warehouse_id` | `int` |
| in | `name` | `varchar(80)` |
| out | `status` | `varchar(30)` |
| out | `delivery_id` | `int` |
| out | `document_number` | `text` |

Tworzy szkic przesunięcia produktów z warehouse_id do fulfillment_warehouse_id; name opisuje dostawę. Nie opisano osobnej flagi optional tych trzech pól. Zwraca delivery_id i wygenerowany document_number jako text. Nieznane: dostępne integracje, zgodność magazynów, numeracja, natychmiastowa rezerwacja/ruch stanów, limity, duplikaty i retry.

### addInventoryFulfillmentDeliveryItems

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryFulfillmentDeliveryItems).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `delivery_id` | `int` |
| in | `items` | `array` |
| in | `items[].product_id` | `int` |
| in | `items[].quantity` | `int` |
| out | `status` | `varchar(30)` |
| out | `items` | `array` |
| out | `items[].item_id` | `int` |
| out | `items[].product_id` | `int` |
| out | `items[].product_sku` | `text` |
| out | `items[].quantity` | `int` |

Dodaje produkty wyłącznie do szkicu; muszą istnieć w inventory. Zestawy wymagają włączenia odpowiedniej funkcji konta; drafty produktów i produkty główne z wariantami są wykluczone. quantity wyniku to łączna ilość po dodaniu; nie zakładamy, że input zastępuje stan. Nieznane: minimalna/dodatnia ilość, limity batcha, duplikaty w tablicy, dozwolone warianty poza wykluczeniem rodzica, częściowy sukces/atomowość, rezerwacje i replay.

### getInventoryFulfillmentDeliveries

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryFulfillmentDeliveries).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `fulfillment_warehouse_id` | `int` |
| in | `fulfillment_warehouse_ids` | `array` |
| in | `external_warehouse_id` | `text` |
| in | `external_warehouse_ids` | `array` |
| in | `warehouse_id` | `int` |
| in | `status` | `int` |
| in | `statuses` | `array` |
| in | `date_from` | `int` |
| in | `date_to` | `int` |
| in | `filter_document_number` | `varchar(30)` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `deliveries` | `array` |
| out | `deliveries[].delivery_id` | `int` |
| out | `deliveries[].name` | `varchar(80)` |
| out | `deliveries[].document_number` | `varchar(30)` |
| out | `deliveries[].date_created` | `int` |
| out | `deliveries[].items_count` | `int` |
| out | `deliveries[].received_items` | `int\|null` |
| out | `deliveries[].status` | `int` |
| out | `deliveries[].notes` | `text` |
| out | `deliveries[].external_delivery_id` | `varchar(255)` |
| out | `deliveries[].warehouse_id` | `int` |
| out | `deliveries[].fulfillment_warehouse_id` | `int` |
| out | `deliveries[].external_warehouse_id` | `varchar(64)` |
| out | `deliveries[].unit_type` | `varchar(20)` |
| out | `deliveries[].unit_count` | `int` |
| out | `deliveries[].additional_data` | `array` |

Wszystkie filtry opcjonalne; mnogie fulfillment_warehouse_ids/statuses to array of ints, external_warehouse_ids array of strings. Numer dokumentu: dopasowanie częściowe; daty Unix. Page: 100 wyników, OD 0 (inaczej niż Stocktakes), bez jawnego default/total/końca. Statusy 0 draft, 10 packing, 20 pending_registration, 30 registered, 40 in_transit, 50 unpacking, 60 completed, 70 cancelled. received_items domyślnie null. unit_type: carton/pallet/container. Proza dodatkowego pola: `deliveries[].additional_data.zfs_advice_id` — typ nieokreślony; additional_data nazwano array, przykład daje obiekt. Nieznane: priorytet filtrów pojedynczych/mnogich, zakres dat, przejścia, synchronizacja i kompletna struktura integracji.

### getInventoryFulfillmentDeliveryItems

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryFulfillmentDeliveryItems).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `delivery_id` | `int` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `items` | `array` |
| out | `items[].item_id` | `int` |
| out | `items[].position` | `int` |
| out | `items[].product_id` | `int` |
| out | `items[].product_name` | `varchar(255)` |
| out | `items[].product_ean` | `varchar(32)` |
| out | `items[].product_sku` | `varchar(50)` |
| out | `items[].quantity` | `int` |
| out | `items[].received_quantity` | `int\|null` |

delivery_id wybiera dostawę; opcjonalne page: 100 pozycji, od 0. received_quantity jest int|null, domyślnie null; nie wolno utożsamiać z zerem odebranych. Brak jawnego default strony, total/cursora, warunku końca, stabilnego sortowania i czasu aktualizacji odbioru. Przykładowe position=0 nie jest odrębnie udokumentowaną normą indeksowania wszystkich pozycji.

### getInventoryFulfillmentDeliveryLabels

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryFulfillmentDeliveryLabels).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `delivery_id` | `int` |
| in | `type` | `varchar(10)` |
| out | `status` | `varchar(30)` |
| out | `labels` | `array` |
| out | `labels[].type` | `varchar(10)` |
| out | `labels[].position` | `int` |
| out | `labels[].box_position` | `int` |
| out | `labels[].extension` | `varchar(10)` |
| out | `labels[].label` | `text` |

Pobiera wybrany typ etykiet wskazanej dostawy. Input type ma varchar(10); lista dozwolonych input wartości nie jest osobno podana. Wynik type opisuje delivery/box/item; label to base64, extension rozszerzenie pliku. position oznacza pozycję obiektu, box_position pudełko dla box/item, a 0 dla delivery. Nieznane: formaty/PDF/MIME, liczba/rozmiar etykiet, paginacja, gotowość integracji, błąd braku etykiet i zakres uprawnień. Pobranie nie dowodzi wydruku, nadania ani dostawy.

### runInventoryFulfillmentDeliverySubmission

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=runInventoryFulfillmentDeliverySubmission).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `delivery_id` | `int` |
| in | `date_arrival` | `int` |
| out | `status` | `varchar(30)` |
| out | `delivery_id` | `int` |
| out | `external_id` | `varchar(100)` |

Rejestruje dostawę ze stanu draft lub packing; przy prostym pakowaniu produkty uznaje za spakowane, a przesyłkę zgłasza centrum fulfillment. Obsługa dotyczy wybranych integracji z simple packing. date_arrival opcjonalna w tabeli, lecz wymagana przez niektóre integracje, np. DHL Fulfillment; Unix. Zwraca delivery_id oraz external_id po rejestracji (varchar(100), podczas gdy lista używa external_delivery_id varchar(255)). Nieznane: pełna lista integracji, walidacja dat/stanu, synchroniczność rejestracji, zewnętrzna idempotencja, retry, rollback i reconciliation po utracie ACK.

## Weryfikacja pokrycia i pozostałe niewiadome

| Metoda | in top-level | out top-level | nested tabelaryczne |
|---|---:|---:|---:|
| `addInventoryStocktake` | 15 | 4 | 0 |
| `addInventoryStocktakeItems` | 2 | 2 | 8 |
| `getInventoryStocktakeItems` | 2 | 2 | 15 |
| `getInventoryStocktakeSeries` | 1 | 2 | 4 |
| `getInventoryStocktakes` | 8 | 2 | 21 |
| `setInventoryStocktakeStatus` | 3 | 1 | 2 |
| `addInventoryFulfillmentDelivery` | 3 | 3 | 0 |
| `addInventoryFulfillmentDeliveryItems` | 2 | 2 | 6 |
| `getInventoryFulfillmentDeliveries` | 11 | 2 | 15 |
| `getInventoryFulfillmentDeliveryItems` | 2 | 2 | 8 |
| `getInventoryFulfillmentDeliveryLabels` | 2 | 2 | 5 |
| `runInventoryFulfillmentDeliverySubmission` | 2 | 3 | 0 |

Łącznie **53 input top-level / 27 output top-level / 84 nested tabelarycznych**, plus 1 nazwane pole z prozy (`additional_data.zfs_advice_id`, bez deklarowanego typu), 24 wzmianki pól błędu (2×12). Parser DOM tabel z separatorami nie scala nazw przez usunięcie br. Drugi niezależny checker porównuje wielozbiór kierunek/ścieżka/typ po normalizacji białych znaków z tabelami MD; sprawdza też 12 SHA/bajtów, URL/datę, przynależność indeksu i wszystkie 24 nazwy błędów.

Dokumentacja nie rozstrzyga zgodności skutków stanów i dokumentów z lokalnymi Native guardami, ruchu między magazynami, wyceny/FIFO/partii/seriali, aktualizacji przez worker, wyścigów, recovery ani skutków na koncie fulfillment. Wymagają osobnego działającego adaptera/UI/API oraz testów autoryzowanych procesów i kont dostawców. Ten batch nie przyznaje żadnej z tych akceptacji.
