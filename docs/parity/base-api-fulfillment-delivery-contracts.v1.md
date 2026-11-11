# BaseAPI — dostawy fulfillment: kontrakty źródłowe v1

**SOURCE_ONLY / DOCUMENTATION_ONLY.** Normalizacja sześciu istniejących metod grupy `Product catalog / Fulfillment deliveries` do [JSON](base-api-fulfillment-delivery-contracts.v1.json); nie implementacja ani odbiór integracji.

W aktualnym przekroju przed tym plikiem istnieje 140 unikalnych metod w 12 plikach kontraktów JSON. Centralny [rejestr](base-api-contract-traceability-20261018.json) ma już odnośniki dla 204 metod, lecz zachowuje projekcję 134 JSON / 70 Markdown. Nie zmieniono go. Nie powstało sześć nowych metod i nie zamknięto rzekomych 93 braków; to liczba historyczna. Wybrane sześć nie występowało w dotychczasowych JSON, a ich opisy Markdown pozostają [zachowane](base-api-stocktake-fulfillment-contracts-20261018.md#addinventoryfulfillmentdelivery).

## Źródła i kompletność pól

Wykorzystano wyłącznie zapisane oficjalne HTML z 18.10.2026 w [paczce](base-api-stocktake-fulfillment-sources-20261018.json.gz); nie wykonywano sieciowego GET, connector.php, wywołań konta ani kodu HTML. Czasy pobrania wybranych stron: 2026-10-18T01:06:31.600749+00:00 → 2026-10-18T01:06:32.131382+00:00. To uzupełnienie indeksu z 17.10, nie dowód treści indywidualnych stron 17.10.

- Gzip: 122971 B / `6b016b5366c4424dc8311136c9368af0738a0493f9b5208e3c4da9bafe9fea79`.
- Rozpakowany JSON: 701988 B / `1852345a169e2c8044e4d77d1edaf022ca8f1ca40e6ea087a6992acc9f192546`.
- Indeks 17.10: `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`.
- Nowy JSON: 71923 B / `111efced26a3e5847cdda74ae89ca67c5220d0ce5589ae3c35a7f9c9b100c2b5`.

| Metoda | Wiersze wejścia | Wiersze wyniku | HTML B | SHA256 HTML |
|---|---:|---:|---:|---|
| `addInventoryFulfillmentDelivery` | 3 | 3 | 49422 | `394d688b96057f66d4b3d92b25a3c2e728420ab574ba0bd1096c0590978ddecf` |
| `addInventoryFulfillmentDeliveryItems` | 4 | 6 | 50457 | `29309a7f6aaa664ca4f0287777ef322cdf61fb431ea31c2c22fec51ca4c2312f` |
| `getInventoryFulfillmentDeliveries` | 11 | 17 | 53802 | `ea72bc9c1e232f57433e29060f74a4fa5bc80c83f9ed5838114993bff5e05e72` |
| `getInventoryFulfillmentDeliveryItems` | 2 | 10 | 50234 | `1c1664413a2df3ac937c1e287f65326412b976f3e736ff3c33236dcc585485db` |
| `getInventoryFulfillmentDeliveryLabels` | 2 | 7 | 49902 | `8162c3d3210d4ee89f2a24e157ee98d8d7a7e3ad06d9715ff2f9fceeb2b0a782` |
| `runInventoryFulfillmentDeliverySubmission` | 2 | 3 | 49673 | `05912bdb488048209d2ed1ff462dbdf0cecc50e3423d854af2445feb8286d82b` |

JSON zachowuje wszystkie 24 wiersze wejścia i 46 wyniku: nazwy, literalne typy, opisy DOM, numer wiersza, hierarchię tablic i osobny literalny spis trzech komórek z SHA. JSDOM i normalizacja trzech komórek są takie jak w istniejącym teście Stocktakes; nie dodano parsera ani fixture. Osobno zapisano 12 pól error_code/error_message z prozy oraz nazwę zfs_advice_id bez wymyślania jej typu lub kształtu kontenera. Brak oznaczenia optional nie oznacza automatycznie required.

## Konkretne zachowania i granice

| Metoda | Wejście i wynik | Udokumentowane ograniczenia / niejasności |
|---|---|---|
| [addInventoryFulfillmentDelivery](https://api.baselinker.com/index.php?method=addInventoryFulfillmentDelivery) | warehouse_id:int, fulfillment_warehouse_id:int, name:varchar(80); wynik delivery_id:int i document_number:text. | Tworzy szkic wysyłki z magazynu źródłowego do centrum fulfillment. Opcjonalność tych trzech pól, zgodność magazynów, numeracja i ruch stanów nie są opisane. |
| [addInventoryFulfillmentDeliveryItems](https://api.baselinker.com/index.php?method=addInventoryFulfillmentDeliveryItems) | delivery_id:int, items z product_id:int i quantity:int; wynik item_id, product_id, product_sku i quantity. | Tylko draft; produkt istnieje w inventory, nie jest draft ani głównym produktem wariantowym; zestawy wymagają funkcji konta. Wynik quantity to „Total quantity after addition”; nie przyjęto idempotencji ani reguły scalania powtórzeń. Brak zakresu ilości i limitu batcha. |
| [getInventoryFulfillmentDeliveries](https://api.baselinker.com/index.php?method=getInventoryFulfillmentDeliveries) | Opcjonalne filtry pojedynczych/wielu magazynów i statusów, dat Unix, częściowego document_number; wynik deliveries z 15 polami potomnymi. | **page od 0, 100 wyników/stronę**; default, sortowanie, koniec listy i precedence filtrów nieopisane. Statusy wyniku: 0/10/20/30/40/50/60/70. received_items ma typ int\|null i domyślne null; additional_data ma literalny typ array, lecz kształt zfs_advice_id nie jest określony. |
| [getInventoryFulfillmentDeliveryItems](https://api.baselinker.com/index.php?method=getInventoryFulfillmentDeliveryItems) | delivery_id:int, opcjonalny page:int; pozycje z ID, position, danymi produktu, quantity i received_quantity. | **page od 0, 100 wyników/stronę**. received_quantity:int\|null, domyślnie null. Nie założono stabilnej paginacji podczas zmian ani interpretacji rozbieżności ilości. |
| [getInventoryFulfillmentDeliveryLabels](https://api.baselinker.com/index.php?method=getInventoryFulfillmentDeliveryLabels) | delivery_id:int, type:varchar(10); labels zawierają type, position, box_position, extension i base64 label. | Wynik wymienia delivery/box/item; box_position=0 dla delivery. Wejście nie ma jawnie zamkniętego enum. Nie opisano limitu bajtów, MIME, listy rozszerzeń, paginacji ani semantyki pustego wyniku. |
| [runInventoryFulfillmentDeliverySubmission](https://api.baselinker.com/index.php?method=runInventoryFulfillmentDeliverySubmission) | delivery_id:int, opcjonalny date_arrival:Unix; wynik delivery_id i external_id:varchar(100). | Draft lub packing, wybrane integracje z simple packing. Produkty traktowane jako spakowane, rejestracja w centrum. date_arrival może być wymagane przez integrację, np. DHL Fulfillment; pełnej listy nie ma. Ponowienie, wynik częściowy i finalny status nie są opisane. |

## Błędy, ponowienia i odbiór

Wspólna koperta z istniejącego kontraktu: POST connector.php, X-BLToken, formularz method/parameters z JSON; nie wykonywano transmisji. Każdy wynik dokumentuje status:varchar(30), SUCCESS/ERROR, a przy ERROR nazwy error_message/error_code bez typów, konkretnych kodów lub mapowania HTTP. Limity rate, Retry-After, prawa konta/firmy i walidacja nieznanych/null pól pozostają nieustalone.

Dla mutacji brak udokumentowanego klucza idempotencji i kontraktu po utracie odpowiedzi. Nie wolno uznać bezpiecznego replay za potwierdzony, zwłaszcza rejestracji zewnętrznej dostawy. Odczyt strony lub pola nie stanowi dowodu zgodności wire ani działania lokalnego adaptera.

`documentation_only=true`; `operational_contract_fully_resolved=false`, `implementation_verified=false`, `wire_acceptance=false`, `provider_account_acceptance=false`, `acceptance_granted=false`, `scope_mutated=false`. Dalsze bramki: niezależny test kontraktu wire, rzeczywisty lokalny proces przez UI/API/worker oraz osobne potwierdzenie dostawcy/konta.
