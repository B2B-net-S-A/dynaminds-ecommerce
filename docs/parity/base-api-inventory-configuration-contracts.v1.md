# Kontrakty API Base — konfiguracja katalogu, wersja 1

Przegląd 17.10.2026 obejmuje **14 metod w czterech pełnych grupach Product catalog**: Inventories (3), Categories (3), Warehouses (5), Manufacturers (3). [JSON](base-api-inventory-configuration-contracts.v1.json) zachowuje 41 wierszy wejścia, 77 wierszy wyniku i dwa pola zadeklarowane w prozie. Nie obejmuje pozostałych grup katalogu ani nie nadaje zgodności implementacji.

[Snapshot 14 oficjalnych stron](base-api-inventory-configuration-sources-20261017.json.gz): 140312 B, SHA256 `55e6a8b29cc4882c372b5ed6a6add7e7f005917719e96c43b8b7c3c9c8a1c679`. Każda metoda ma URL, czas UTC, status HTTP, rozmiar i SHA256 dokładnego HTML. Indeks ma SHA256 `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`; przypięty wspólny indeks transportu ponownie sprawdzono. Wyłącznie publiczna dokumentacja i odczyt kodu, bez kont, tokenów, HTTP410x, PG i uruchamiania usług.

## Metody i granice

| Grupa | Metoda | Kontrakt |
|---|---|---|
| Inventories | [addInventory](https://api.baselinker.com/index.php?method=addInventory) | Ten sam ID aktualizuje. Domyślny język, grupa cen i magazyn muszą należeć do odpowiednich list. |
| Inventories | [deleteInventory](https://api.baselinker.com/index.php?method=deleteInventory) | Usunięcie katalogu; kaskady produktów, rezerwacji i referencji nieopisane. |
| Inventories | [getInventories](https://api.baselinker.com/index.php?method=getInventories) | Katalogi z listami języków/cen/magazynów, domyślnymi referencjami, reservations i is_default. |
| Categories | [addInventoryCategory](https://api.baselinker.com/index.php?method=addInventoryCategory) | inventory_id pominięte oznacza kategorię wspólną; parent_id=0 dla korzenia, rodzic musi istnieć przed dzieckiem. |
| Categories | [deleteInventoryCategory](https://api.baselinker.com/index.php?method=deleteInventoryCategory) | Usuwa kategorię i bezpośrednie produkty; zachowuje produkty podkategorii, podkategorie przenosi na najwyższy poziom. |
| Categories | [getInventoryCategories](https://api.baselinker.com/index.php?method=getInventoryCategories) | Pominięcie inventory_id wybiera kategorie wspólne; wynik ID/nazwa/parent_id. |
| Warehouses | [addInventoryWarehouse](https://api.baselinker.com/index.php?method=addInventoryWarehouse) | Tworzenie/aktualizacja magazynu, adres i country; automatycznych magazynów zewnętrznych nie można edytować. |
| Warehouses | [deleteInventoryWarehouse](https://api.baselinker.com/index.php?method=deleteInventoryWarehouse) | Usunięcie natywnego magazynu; automatyczne magazyny stanów zewnętrznych wyłączone. |
| Warehouses | [getInventoryWarehouses](https://api.baselinker.com/index.php?method=getInventoryWarehouses) | Magazyny natywne i integracyjne, osobne ID/internal_warehouse_id, typ, adres i stock_edition. |
| Warehouses | [getInventoryMaps](https://api.baselinker.com/index.php?method=getInventoryMaps) | Mapy z adresem i listą par warehouse_id/warehouse_type; bez formalnego map_data w tym wyniku. |
| Warehouses | [getInventoryMapDetails](https://api.baselinker.com/index.php?method=getInventoryMapDetails) | Szczegóły jednej mapy i pełny JSON układu; {} gdy układu brak. |
| Manufacturers | [addInventoryManufacturer](https://api.baselinker.com/index.php?method=addInventoryManufacturer) | Producent z unikalną nazwą w koncie, adresem, kontaktami i logo; name deprecated na rzecz manufacturer_name. |
| Manufacturers | [deleteInventoryManufacturer](https://api.baselinker.com/index.php?method=deleteInventoryManufacturer) | Usunięcie producenta; skutki przypisanych produktów i powtórzenia nieopisane. |
| Manufacturers | [getInventoryManufacturers](https://api.baselinker.com/index.php?method=getInventoryManufacturers) | Z page: 1000 na stronę; bez page: do 10 000. Nazwy, kontakty i zdjęcie jako URL. |

## Pola i znaczenie pominięcia

Każdy wiersz JSON zachowuje nazwę, typ, opis i numer źródłowy. Pola z prozy mają oddzielne source_kind/source_table_row. Parser zachowuje separatory HTML, a typ `varchar(30)` w zagnieżdżonej prozie pozostaje pełny. `required:null` oznacza brak jawnego oznaczenia; false wynika z opisanej opcjonalności lub pominięcia. Nie uznajemy parametrów za obowiązkowe wyłącznie na podstawie nazwy lub przykładu.

- addInventory i addInventoryWarehouse pokazują tworzenie bez ID w przykładzie, ale tabela nie formalizuje pominięcia/pustego ID. Pozostaje to nieokreślone. Puste category_id/manufacturer_id przy tworzeniu są opisane jawnie, lecz ich konkretna reprezentacja w JSON nie jest zdefiniowana.
- default_language należy do languages; default_price_group do price_groups; default_warehouse do warehouses. Referencje magazynów w katalogu używają type_id. Nie utożsamiamy ich z int warehouse_id lub internal_warehouse_id.
- stock_edition=false zabrania ręcznej edycji stanu, **nie zabrania zmiany przez API**. Lokalna polityka dostępności/sellability nie jest jego automatycznym odpowiednikiem.
- country pominięte przy tworzeniu magazynu korzysta z regionu konta; pominięte przy aktualizacji zachowuje kraj; pusty tekst go czyści. Nie przenosimy tej reguły na inne pola adresowe.
- inventory_id pominięte w metodach kategorii oznacza zakres wspólny, a nie domyślnie unię wszystkich prywatnych kategorii. Dokumentacja używa też historycznych nazw addCategory/addProducts/deleteCategory; nie nadajemy im nieudokumentowanych aliasów.
- Producent ma nazwę unikalną w koncie. Gdy podano name i manufacturer_name jednocześnie, pierwszeństwo nie jest opisane. Logo: data:base64 lub url:adres; pusty tekst usuwa. Brak pełnych limitów pliku, MIME i reguły pominięcia.

## Mapy, paginacja i błędy

map_data zadeklarowano jako array, ale opis i przykład wskazują JSON object. Pola przykładu cells/position/size/attrs nie stanowią pełnego, wersjonowanego schematu. Nie udokumentowano metod zapisu mapy w tym zakresie. warehouse_type=bl oznacza magazyn natywny; shop/warehouse/fulfillment/blconnect są przykładami, nie zamkniętym słownikiem integracji.

Jedynie getInventoryManufacturers dokumentuje paginację: page po 1000, bez page do 10 000. Brak numeru pierwszej strony, końca, total/next, kolejności i gwarancji stabilnego obrazu. Pozostałe listy nie deklarują parametrów paginacji ani gwarantowanej kompletności.

[Oficjalny indeks](https://api.baselinker.com/) opisuje POST connector.php z method/parameters JSON, X-BLToken, UTF-8 i 100 żądań/min. Strony deklarują SUCCESS/ERROR oraz error_message/error_code. Nie podają szczegółowych kodów, mapowania HTTP, Retry-After, uprawnień, klientowego klucza idempotencji lub uzgadniania nieznanego wyniku. Sam upsert po istniejącym ID nie rozstrzyga utraconej odpowiedzi tworzenia/usuwania.

## Kod i odbiór

JSON przypina 11 plików i rzeczywiste kandydaty do mapowania. Lokalne katalogi mają UUID, wersje, preview/commit i kursor po 50 oraz inny model języków/referencji; nie jest to protokół Base. Lokalne magazyny name/code i osobne polityki nie implementują automatycznie address/country/stock_edition lub typów zewnętrznych. Lokalizacje stock nie są wizualną mapą. Tekstowa kategoria i producent na produkcie nie dowodzą kategorii z hierarchią/usuwaniem ani osobnej, unikalnej encji producenta z kontaktami/logo.

Każda metoda ma indywidualne kryteria oraz `implementation_verified:false` i `acceptance_granted:false`. Odbiór wymaga dokładnego protokołu, zwykłego UI/API/worker, aktualnych uprawnień, obcych ID, odczytu skutku, 429/timeout/ACK-loss i recovery bez duplikowania skutków. Destrukcyjna semantyka usunięcia kategorii wymaga osobnego, rzeczywistego scenariusza na uprawnionych danych testowych. Publiczny opis, podobna lokalna trasa lub fixture nie nadaje odbioru konta/sandbox.
