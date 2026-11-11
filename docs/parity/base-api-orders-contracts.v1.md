# Kontrakty API Base — Orders / Orders, wersja 1

Przegląd 17.10.2026 obejmuje **całą grupę Orders / Orders: 7 metod**. Pozostałe grupy rodziny Orders nie są objęte. [JSON](base-api-orders-contracts.v1.json) zachowuje 103 wiersze wejścia, 73 wiersze wyniku, 14 pól wejścia i 41 pól wyniku z prozy oraz trzy formaty załączników.

[Snapshot 7 oficjalnych stron](base-api-orders-sources-20261017.json.gz): 76890 B, SHA256 `d220a459e9d6050328552d988fbc81a8c73fdfb1b362837e3e441fd5567627c6`. Każda metoda ma URL, czas UTC, HTTP status, rozmiar i SHA256 dokładnego HTML. Indeks SHA256 `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`; wspólny transport ponownie sprawdzono. Wyłącznie publiczne strony i odczyt kodu, bez kont, PG, HTTP410x i uruchamiania usług.

## Metody

| Metoda | Kontrakt i istotna granica |
|---|---|
| [addOrder](https://api.baselinker.com/index.php?method=addOrder) | Tworzy zamówienie i zwraca order_id. paid=1 automatycznie dodaje pełną płatność. Produkty mają osobne storage/product/variant/warehouse IDs. |
| [addOrderBySplit](https://api.baselinker.com/index.php?method=addOrderBySplit) | Przenosi wybrane ilości pozycji do jednego nowego zamówienia, zwraca new_order_id. Opcjonalny koszt dostawy odjęty od źródła i przypisany dziecku. |
| [addOrderDuplicate](https://api.baselinker.com/index.php?method=addOrderDuplicate) | Nowe zamówienie z tymi samymi danymi i innym order_id; skutki finansowe, line IDs i historia nieopisane. |
| [deleteOrders](https://api.baselinker.com/index.php?method=deleteOrders) | Usuwa do 1000 zamówień; deleted_order_ids potwierdza faktycznie usuniętą listę, nie gwarantuje całej partii. |
| [getOrders](https://api.baselinker.com/index.php?method=getOrders) | Do 100 wyników, domyślnie confirmed. Filtry źródeł/dat/ID i opcjonalne extra fields, prowizje, Connect, rabaty. |
| [setOrderFields](https://api.baselinker.com/index.php?method=setOrderFields) | order_id wymagane; inne pola opcjonalne. Zmieniać tylko podane pola, pominięte zachować. |
| [setOrdersMerge](https://api.baselinker.com/index.php?method=setOrdersMerge) | technical_merge tworzy nowe techniczne zamówienie bez zmiany oryginałów; into_main_order przenosi pozycje do głównego i usuwa pozostałe. |

## Pozycje, kwoty i efekty zmian

Tabela pól zachowuje nazwy, typy, pełne opisy i pozycje źródłowe. Pola w prozie mają osobny source_kind. Parser zachowuje br/listy i parametryczne typy, także identyfikatory z cyfrą, np. transaction2_id. `required:null` oznacza brak jawnego wymagania, false jawną opcjonalność, true wyrażone wymaganie. Nie wyprowadzamy wymagalności wyłącznie z nazwy lub przykładu.

- addOrder: paid ma typ bool, opis używa wartości „1” dodającej pełną płatność. Nie zastępuje to osobnego odbioru zapisu finansowego. custom_source_id pominięte wybiera domyślne źródło.
- Produkty zapisu mają 14 pól z prozy. storage=db/shop/warehouse określa domenę produktu. Opis zapisu wskazuje storage_id=0 dla db, a warehouse_id odpowiada **internal_warehouse_id** z getInventoryWarehouses. Pominięcie/0 tego magazynu wybiera domyślny według źródła zamówienia. Nie mapujemy go automatycznie na prefiksowane ID katalogu.
- Split wymaga order_product_id i quantity w każdym przekazanym item; quantity nie przekracza oryginału. Brak jawnego minimum, rozmiaru listy, nowych line IDs i zachowania pustego źródła. Jedno wywołanie tworzy jedno dziecko; sekwencja 1→N nie ma zadeklarowanej atomowości całości.
- delivery_cost_to_split jest opcjonalne, netto lub brutto zależnie od zamówienia. Nie przekracza obecnej ceny dostawy. Brak podanej wartości domyślnej, proporcji i reguł rounding; nie zakładamy zawsze brutto na podstawie zwykłego delivery_price.
- Split i duplicate deklarują dziedziczenie danych, lecz nie definiują kopiowania płatności, refundów, dokumentów, shipments, rezerwacji, WMS, triggerów i nowych identyfikatorów pozycji. Te skutki wymagają osobnego odbioru.
- Merge zachowuje dane wysyłki i faktury głównego. main_order_id nie może wystąpić w order_ids_to_merge. sum_delivery_costs true sumuje, false zachowuje koszt głównego; brak defaultu, limitu partii i pełnych reguł finansów/walut/stock.
- custom_extra_fields jest mapą ID→wartość. Pusty tekst usuwa konkretną wartość; plik zapisu ma title varchar(40) oraz file data:base64 do 2 MB. Odczyt zwraca title/url. Pozostałe teksty nie dostają automatycznie tej samej reguły czyszczenia.

## Odczyt i paginacja

getOrders zwraca najwyżej 100 zamówień. Dokumentacja zaleca getJournalList lub kontynuację date_confirmed_from od date_confirmed ostatniego wyniku plus 1 sekunda, do partii mniejszej niż 100. Deklaruje brak pojawienia się potwierdzenia z wcześniejszą datą. Nie definiuje jednak osobnego tie-breakera dla co najmniej 100 zamówień w tej samej sekundzie ani formalnego sortowania i inkluzywności id_from. Zalecenia nie zamieniamy w bezwarunkowy dowód bezstratnej paginacji.

Unconfirmed są domyślnie wyłączone; mogą mieć niepełne pozycje i zmieniać się. filter_order_source_id wymaga filter_order_source; filter_external_order_id nie powinno łączyć się z filter_shop_order_id. Źródło identyfikuje para order_source/order_source_id. order_source_info jest według dokumentacji aktualnie niedostępne.

Pięć flag domyślnie false: get_unconfirmed_orders, include_custom_extra_fields, include_commissions, include_connect_data, include_discounts_data. Warunkowe wyniki obejmują 5 pól prowizji, 3 Connect, 21 produktu i 12 rabatu. order_lines_details rabatu zawiera te same pola poza samym order_lines_details; schemat pozostaje skończony. Kształt connect_data zadeklarowany jako array nie ma pełnej deklaracji listy/mapy, więc nie zgadujemy reprezentacji.

Read/write nie są jednym schematem: bool przy zapisie versus varchar(1) dla payment_method_cod i want_invoice w odczycie, variant_id int versus varchar(30), różne długości nazw, adresów i komentarzy. Produkty odczytu zachowują bundle_id, transaction_id i transaction2_id. Brak opisanej jednostki weight.

## Błędy, kaskady i recovery

[Oficjalny indeks](https://api.baselinker.com/) opisuje POST connector.php, method/parameters JSON, X-BLToken, UTF-8 i 100 żądań/min. Metody deklarują SUCCESS/ERROR oraz error_message/error_code, bez szczegółowej macierzy HTTP/uprawnień/Retry-After.

Nie ma udokumentowanego client idempotency key, CAS/wersji ani algorytmu rozstrzygnięcia utraconej odpowiedzi. Usunięcie ID, utworzenie dziecka, pełna płatność i wykonanie merge nie mogą być automatycznie powtarzane wyłącznie po timeout. deleted_order_ids potwierdza podzbiór; atomowość, błędne/obce ID, kaskady i odwrócenie nie zostały określone. pick_state/pack_state ustawione przez API nie dowodzą fizycznego kompletowania/pakowania.

## Obecny kod i odbiór

JSON przypina 11 plików i kandydatów tras. Lokalne POST/GET orders, domena manual lines, pola dodatkowe/adresy i płatności mają inne UUID, kwoty minor, wersje, scopes, kursor i limity. Lokalny idempotency-header nie nadaje gwarancji Base. Merge ma podobne nazwy trybów, lecz preview/execute/hash/zgody, limit 100 i własne reguły finansowe nie dowodzą pełnej zgodności Base. Nie znaleziono zgodnych handlerów duplicate lub bulk delete w przejrzanych trasach. Split: od 23.10.2026 lokalny natywny podział 222 (jedno dziecko na wywołanie, `addOrderBySplit` na connector.php i trasy sesji) — mapowanie, odmowy i granice w `ORDER-SPLIT222-20261023.md`; bez odbioru na koncie Base.

Wszystkie metody mają `implementation_verified:false` i `acceptance_granted:false`. Indywidualne kryteria wymagają dokładnego wire, zwykłego UI/API/worker, aktualnych ról/obcych ID, pełnego odczytu efektów oraz 429/timeout/ACK-loss/restart bez duplikatów. Nieopisane skutki finansowe, fizyczne i destrukcyjne pozostają otwartymi granicami. Publiczny przykład, podobny kod lub fixture nie przyznają odbioru konta/sandbox.
