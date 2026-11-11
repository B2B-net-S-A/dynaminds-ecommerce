# Kontrakty API Base — produkty katalogu, wersja 1

Przegląd 17.10.2026 obejmuje całą grupę **Product catalog / Products: 12 metod** z indeksu 204. Osobna grupa Inventories (3 metody) i pozostałe grupy katalogu nie są objęte. [JSON](base-api-inventory-products-contracts.v1.json) zachowuje 92 wiersze wejścia, 87 wierszy wyniku, 2 pola wejścia i 30 pól wyniku opisanych w prozie oraz dwa formaty załączników: title/file i title/url.

[Snapshot 12 oficjalnych stron](base-api-inventory-products-sources-20261017.json.gz): 130602 B, SHA256 `f775b0673b090433b39f20598daf857b3c0f5953ecdbde7917021237bdeac5db`. Każda metoda ma własny URL, czas UTC, status HTTP, rozmiar i SHA256 dokładnego HTML. Indeks ma SHA256 `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`; przypięty wspólny transport został ponownie sprawdzony. Pobierano wyłącznie publiczną dokumentację. Bez kont, tokenów, HTTP410x, PG, startów i zmian scope/runtime.

## Metody

| Metoda | Najważniejszy kontrakt |
|---|---|
| [addInventoryProduct](https://api.baselinker.com/index.php?method=addInventoryProduct) | Tworzenie bez product_id, aktualizacja po ID. Osobne reguły wariantów, bundle, kosztu, mediów i zastępowania kolekcji. |
| [deleteInventoryProduct](https://api.baselinker.com/index.php?method=deleteInventoryProduct) | Usunięcie po product_id; nieopisane kaskady, odwrócenie i powtórzenie. |
| [getInventoryParameters](https://api.baselinker.com/index.php?method=getInventoryParameters) | Definicje parametrów, wszystkie zapisane tłumaczenia, opcje i powiązania grup. Brak parametrów wejścia. |
| [getInventoryProductLogs](https://api.baselinker.com/index.php?method=getInventoryProductLogs) | Wariant przez jego ID; filtry dat/typu, ASC domyślnie, 100 edycji na stronę, grupy daty i profilu. |
| [getInventoryProductsData](https://api.baselinker.com/index.php?method=getInventoryProductsData) | Szczegóły wskazanych ID; warunkowe ERP/WMS, dodatkowe EAN, dostawcy, relacje, kategorie, szablony i media kanałów. |
| [getInventoryProductsList](https://api.baselinker.com/index.php?method=getInventoryProductsList) | Lista po 1000 produktów, filtry i opcjonalne warianty; mapa produktów po ID. |
| [getInventoryProductsPrices](https://api.baselinker.com/index.php?method=getInventoryProductsPrices) | Strony po 1000, ceny brutto po grupach; warianty w osobnej mapie. |
| [getInventoryProductsStock](https://api.baselinker.com/index.php?method=getInventoryProductsStock) | Strony po 1000; stock i warunkowe rezerwacje, warianty i niezerowe rezerwacje wariantów. |
| [runFulfillmentLinkProducts](https://api.baselinker.com/index.php?method=runFulfillmentLinkProducts) | Synchroniczne dopasowanie przez skonfigurowane extra_field; 1–100 dodatnich ID, liczniki linked/skipped_no_match. |
| [runProductMacroTrigger](https://api.baselinker.com/index.php?method=runProductMacroTrigger) | Uruchomienie osobistego triggera dla produktu; odpowiedź tylko status, bez kontraktu ukończenia i replay. |
| [updateInventoryProductsPrices](https://api.baselinker.com/index.php?method=updateInventoryProductsPrices) | Do 1000 produktów/wariantów; mapa ID → grupa cenowa → cena brutto, counter i warnings błędnych ID. |
| [updateInventoryProductsStock](https://api.baselinker.com/index.php?method=updateInventoryProductsStock) | Do 1000 produktów/wariantów; mapa ID → magazyn → stan, z zakazem zapisu automatycznych magazynów zewnętrznych. |

## Pola i zachowanie zmian

Każdy wiersz zachowuje nazwę, typ, pełny opis i pozycję źródłową. Pola w prozie są odrębne od wierszy tabel; separator HTML pozostaje granicą nazw, dzięki czemu końcówka opisu nie skleja się z następnym polem. Zagnieżdżenia rozróżniają mapy produktów, magazynów, grup cen, wariantów i list jednostek. `required:null` oznacza brak jawnej deklaracji; false wynika z opisanej opcjonalności/pominięcia, true z wyrażonego wymagania niepustej listy. Nie dopowiadamy null, typów dynamicznych komórek ani domyślnych flag.

- `tags` i `relations`: pominięcie zachowuje, przekazana lista zastępuje, [] usuwa. `suppliers`: przekazana lista zastępuje, [] usuwa. `thresholds` zmienia tylko podane wpisy; {} nic nie zmienia, 0 czyści próg.
- Relacje: do 1000, własne produkty z wybranego katalogu; bez duplikowania parent/variant, kompozycji bundle i bez relacji między dwoma bundle. `bundle_products` tylko dla bundle.
- `text_fields` ma standardową składnię pole/język/kanał. `marketplace_category_id` używa innej składni źródło/site bez języka: site wymagane dla eBay/Amazon, zabronione dla Allegro; Amazon przyjmuje konto 0, amazon_vendor jest wyłączone.
- Załącznik extra_field ma zapis title/file z data:base64 do 2 MB, a odczyt title/url. Nazwa ma varchar(40). `shipping_template` z pustym tekstem czyści przypisanie; odczyt po fladze zwraca tylko niepuste przypisania jako tekstowe ID.
- Zdjęcia: zapis pozycji 0–15, odczyt 1–16; filmy: zapis 0–5, odczyt 1–6, MP4/WEBM do 15 MB. Pominięte media pozostają. Pusty wpis domyślny usuwa; pusty kanałowy tworzy blank override. Kanałowe `url:` bez adresu usuwa override. `media_options`: 0 domyślne, 1 osobne, 2 dziedziczone z nadpisaniem. Dokumentacja ostrzega przed ponownym wgrywaniem istniejących URL Base CDN.
- Stock, rezerwacje, incoming i jednostki ERP/WMS nie są zamienne. Zaawansowane WMS i metoda kosztu są warunkami odczytu jednostek. Przy dokumentach magazynowych average_cost można ustawić przy tworzeniu lub gdy obecny koszt wynosi 0.

## Paginacja, błędy i otwarte kwestie

List/prices/stock mają strony po 1000 produktów, logi po 100 edycji z wieloma entries. Nie podano pierwszej/domyslnej strony, końca, total ani stabilnego obrazu. Szczegóły po wskazanych ID nie mają podanego limitu partii. Limit 1000 dla bulk i 1–100 dla fulfillment są osobnymi limitami wejścia.

[Oficjalny indeks](https://api.baselinker.com/) opisuje POST connector.php, method/parameters JSON, X-BLToken, UTF-8 i 100 żądań/min. Zakres limitu, algorytm i retry nie są określone. SUCCESS/ERROR oraz error_message/error_code nie dają szczegółowej macierzy HTTP/błędów/uprawnień. SUCCESS może mieć warnings; counter nie dowodzi atomowości całej partii.

JSON wylicza 12 niejednoznaczności, m.in.:

- `array` często opisuje mapę po ID, nie listę indeksowaną.
- Zapis is_bundle mówi „part of a bundle”, natomiast pozostały opis i odczyt mówią o produkcie będącym bundle.
- SKU zapis/filtr ma varchar(50), odczyt varchar(32); zapis logistyki decimal(10,2), odczyt float. Wysokość/szerokość/długość zapisu nie mają osobno jawnej jednostki, odczyt wskazuje cm.
- Proza include_channels_media mówi o top-level media_options, a tabela umieszcza pole pod produktem.
- log_type deklaruje int, proza mówi o liście. Info dla typu 3 opisuje pole tekstowe, choć słownik przypisuje 3 utworzeniu, a 5 zmianie tekstu. Nie poprawiamy tego domysłem.
- Różne kolekcje mają różne reguły zastępowania i czyszczenia. Nie istnieje udokumentowany uniwersalny PATCH, klucz idempotencji ani gwarancja skutku dla całej partii.
- Liczniki fulfillment i status triggera nie dostarczają kompletnego wyniku po każdym ID ani kontraktu uzgadniania nieznanego wykonania.

## Kod i odbiór

JSON przypina 15 przejrzanych plików: katalog, PIM, media, logistyka, ceny, inventory, audit i reguły. Są kandydatami do mapowania. Własne UUID, kursory, limity 200/500, preview/apply/execute, kwoty minor i jednostki gram/mm nie ustanawiają zgodności z Base ID, mapami, page1000 i cenami brutto. Kolejkowanie reguł nie dowodzi osobistego triggera; fulfillment zamówienia nie dowodzi linkowania produktów przez extra_field. Deklaracja rejestracji PIM nie potwierdza bieżącej dostępności wydania.

Każda metoda ma własne kryteria oraz `implementation_verified:false` i `acceptance_granted:false`. Potrzebny jest dokładny protokół oraz zwykły proces UI/API/worker, aktualne uprawnienia, obce ID, pełna paginacja i odczyt skutku. Zapisy wymagają sprawdzenia warnings/counter, 429, timeoutów, utraty ACK i restartu bez duplikowania skutków. Odbiór konfiguracji WMS/kosztów/rezerwacji/kanałów i prawdziwego konta pozostaje odrębny. Dokumentacja, lokalne źródło lub fixture nie przyznają poziomu sandbox/account.
