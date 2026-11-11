# API Base — pozostałe funkcje katalogu, Base Connect i magazyny zewnętrzne

**Uzupełnienie dokumentacji z 18.10.2026; wyłącznie kontrakty publicznych stron.** Całe grupy indeksu 204: `Product catalog / Other` (8), `Base Connect / Integrations` (2), `Base Connect / Contractor credit` (3), `External storages / External connections` (7): razem **20 metod**. Bez zmian indeksu, starszych snapshotów i matrycy. Nie obejmuje Price groups/Suppliers/Payers/Tags.

`documentation_only=true`, `official_account_requests_performed=false`, `implementation_verified=false`, `wire_acceptance=false`, `provider_account_acceptance=false`, `acceptance_granted=false`.

## Źródła i HTTP

Wykonano 20 GET oficjalnych stron dokumentacji **18.10.2026, 01:11:27.568809–01:11:30.151531 UTC**, wszystkie HTTP 200. To późniejsze uzupełnienie indeksu z 17.10, nie snapshot treści z 17.10. Dat publikacji wersji metod nie podano. Zachowano HTML UTF-8, final URL, status, Content-Type i dostępne Date/ETag/Last-Modified; bez Set-Cookie. Nie wykonano żądań konta/connector.php ani skryptów stron.

- [Snapshot](base-api-other-connect-external-sources-20261018.json.gz): 204296 B, SHA256 `2f5eda1e2b538cfbea97f87c5a230aba8f89352b4fabdc092a25b51fa2e4f943`.
- JSON: 1169789 B, SHA256 `9b339ad58096b3b4623abea706f8a793487ac77f280a52e242f8af0410b62009`.
- Indeks 204 SHA256 `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`; dokładny zbiór 20 nazw z czterech grup.

| Metoda | Pobranie UTC18.10 | HTML B | SHA256 HTML |
|---|---|---:|---|
| `addInventoryPromotion` | 01:11:28.129570 | 54946 | `fa232ddb2c98b6323b821a2adb3426cbd5b9df8f85319fc7c97fa62ff29ac2bd` |
| `getInventoryAvailableTextFieldKeys` | 01:11:28.040189 | 50827 | `f2dc6b4860f995b03c6aaa74332e3cf76529c91290f1776ae81b2dea8e91bd50` |
| `getInventoryExtraFields` | 01:11:27.902126 | 50174 | `25b33cf24f2666d486a65ec29c309ac59f18f144742e1b1bc943dad58f5b8011` |
| `getInventoryIntegrations` | 01:11:28.081293 | 50389 | `d5b0d71b60bfd3c39b220da1687b189510e4491e021923c6c919e9a1cabda96c` |
| `getInventoryPrintoutTemplates` | 01:11:28.307983 | 49178 | `a68edf5d79b7d7d848692494b49c49332a9ecdc270af78006ede534d56b5d846` |
| `getInventoryPromotionsList` | 01:11:28.546345 | 55461 | `fc24b2623f45b51cedea84a8c756e8f92b079b9f779a64bc5317147b88b89c0d` |
| `getInventoryShippingTemplates` | 01:11:28.596715 | 50706 | `fffbd4867416347d97b88f13f6d69163702005ae6213ed76cf1f5b52b5542220` |
| `getSyncLogList` | 01:11:28.745794 | 51836 | `0e6f688abd9a48ab72482683c4d065f034578aea565d36bb8b2f1306909a7292` |
| `getConnectIntegrationContractors` | 01:11:29.239449 | 49726 | `5c934e5aebd1bd0d3ea0b50721b29ef33c645c256006e36e5194fecc0ccf05b9` |
| `getConnectIntegrations` | 01:11:29.053129 | 49714 | `cded1c22b3fea50d89fa747a3d46bf248d9ba8fa253992d4b20c18614e70d8e4` |
| `addConnectContractorCreditSettlement` | 01:11:29.147841 | 50552 | `6a0e2662e6b7549012f7316e82bea71b815a0e3a0ab9a856ead0a57990eeae31` |
| `getConnectContractorCreditHistory` | 01:11:29.199190 | 50289 | `fe163860e648403c1321e7800ef0f296d973b319446619e251398546e7bde43d` |
| `setConnectContractorCreditLimit` | 01:11:29.549690 | 49185 | `ae8cbd5a8445ad2160bf7ad3ca5538e78ac62a2ad063a27fbb20b70b3573f2a4` |
| `getExternalStorageCategories` | 01:11:29.638106 | 49685 | `3079bbc4fa378ca28b2f0c9fd09c559ef0d8c298a1d7b3ba5651b6497ee27422` |
| `getExternalStorageProductsData` | 01:11:29.597610 | 55204 | `bc318f489b61f5aedaaccc027af8278786269a05e026b39a8dff9528cf20a1da` |
| `getExternalStorageProductsList` | 01:11:29.627988 | 52718 | `3c8c839ade91bcc65a67a143f578cc02c4f6870215248f27e5ca2296ca1801d4` |
| `getExternalStorageProductsPrices` | 01:11:29.874677 | 50043 | `eda1db7e8ff4e207a88f85bf85fa09ce93f4daa94356027df46b4890e9e23ade` |
| `getExternalStorageProductsQuantity` | 01:11:30.080902 | 50061 | `9084a63ae9431e4b861b458bcf974f03725497c352c0ae33f3d8f6e068dadd7a` |
| `getExternalStoragesList` | 01:11:30.151531 | 50273 | `c6d8dca6383e1b6a6cc24179d7f3e913cb6ed509fd8a1c09d94d98f50f5a15f0` |
| `updateExternalStorageProductsQuantity` | 01:11:30.018030 | 49955 | `112961677de205c4e7bee62d285ffef7613bea399ffb4889627ad1d820199309` |

## Wspólne granice interpretacji

Przykłady używają POST connector.php, X-BLToken oraz formularza method/parameters z JSON. Nie wykonano tego protokołu. Wszystkie metody mają status varchar(30) SUCCESS/ERROR; proza wymienia error_message i error_code bez typów, katalogu kodów i mapowania na HTTP. Nie założono pól sukcesu przy błędzie.

Tabele poniżej zachowują nazwy/typy dosłownie. `↳` oznacza źródłowe `| -`; rodzic to poprzedzająca kolekcja w danym kierunku. Pola głębsze opisane w komórkach mają osobne pełne ścieżki. **Brak required oznacza nieokreślone**, nie opcjonalne. Puste wejście oznacza brak zadeklarowanych parametrów; nie wymyślamy filtrów. Typ array nie jest automatycznie listą: jawne mapy i rozbieżności z przykładami pozostają opisane.

Nie przypisano metod do runtime route ani lokalnego adaptera. Pozostają otwarte: autoryzacja konta, wire, izolacja, limity dostawcy, efekty finansowe/stock, współbieżność, utrata ACK i recovery. Nie wyprowadzamy automatycznego retry zapisu z samego słowa SUCCESS.

### addInventoryPromotion

Grupa: **Product catalog / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryPromotion).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `promotion_id` | `int` |
| in | `name` | `varchar(100)` |
| in | `is_enabled` | `bool` |
| in | `products_filter_type` | `int` |
| in | `products_filter_data` | `array` |
| in | `is_include_subcategories` | `bool` |
| in | `source_price_group_id` | `int` |
| in | `target_price_group_id` | `int` |
| in | `duration_type` | `int` |
| in | `date_start` | `int` |
| in | `date_end` | `int` |
| in | `price_multiplier` | `float` |
| in | `price_addition` | `float` |
| in | `price_round` | `int` |
| in | `csv_identifier` | `varchar(10)` |
| out | `status` | `varchar(30)` |
| out | `promotion_id` | `int` |

Tworzy/zmienia definicję promocji dla konta. `promotion_id` pominięte lub **0** tworzy nową. Przy tworzeniu wymagane: `name`, `is_enabled`, `products_filter_type`, `duration_type`. Required dla `target_price_group_id` nie oznaczono; cel to niezależna grupa cenowa.

Filtry: **1** produkty z ceną źródłową (pominąć payload), **2** tagi, **3** kategorie, **4** jawne ceny po `id`/`sku`. Dla 1–3 wymagane źródło i co najmniej mnożnik lub dodatek; dodatek może być ujemny i następuje po mnożniku. Dla 4 wymagane `csv_identifier`, **nie wysyłać `type`**; źródło/mnożnik/dodatek/round ignorowane i zapisywane odpowiednio **0/1/0/0**. Podkategorie są opcjonalne i działają tylko dla 3.

`price_round` jest opcjonalne, bez zadeklarowanego default. Czas: **0** bez końca, daty ignorowane/zapisane0; **1** zakres z oboma wymaganymi timestampami. Format strefy, relacji dat i aktualizacji częściowej nieopisany. Przykład opakowuje cztery scenariusze w `price_group_filter`, `tag_filter`, `category_filter`, `file_filter`; nie są to zadeklarowane parametry ani dowód batch API. Brak idempotencji, waluty, usuwania i readbacku przeliczenia cen.

Zaokrąglenie `price_round`: **0** bez, **1/2** w górę/dół do pełnej kwoty, **3/4** w górę/dół do .99, **5/6** w górę/dół do najbliższego 0.09, **7** w górę i dół z dokładnością 0.09, **8** do najbliższego 0.10, **9** jednostki do najbliższej 5. Nie dopisano wzoru, rozstrzygania remisu ani waluty.

Dodatkowe pola/pozycje z prozy (nie osobne wiersze HTML; „nie podano” pozostaje unknown):

| Kierunek | Ścieżka | Typ źródłowy | Znaczenie/warunek |
|---|---|---|---|
| in | `products_filter_data.product_prices` | `nie podano` | mapa jawnych cen dla filtra4; klucze według csv_identifier |

### getInventoryAvailableTextFieldKeys

Grupa: **Product catalog / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryAvailableTextFieldKeys).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `inventory_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `text_field_keys` | `array` |

Zwraca pola tekstowe katalogu nadpisywalne dla integracji. `inventory_id` pochodzi z `getInventories.inventory_id`; required nie oznaczono osobno. Wynik `text_field_keys` ma w tabeli typ array, ale opisuje mapę kod→nazwa. Przykład zawiera klucze bazowe oraz kody z separatorami, językiem i integracją; nie tworzymy z przykładu kompletnego języka kodów ani zamkniętego enum. Brak paginacji, kolejności, limitu i gwarancji synchronizacji z listą integracji.

### getInventoryExtraFields

Grupa: **Product catalog / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryExtraFields).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `extra_fields` | `array` |
| out | `↳extra_field_id` | `int` |
| out | `↳name` | `text` |
| out | `↳kind` | `int` |
| out | `↳editor_type` | `text` |
| out | `↳options` | `array` |

Bez parametrów. Zwraca dodatkowe pola katalogu: **kind 0** krótki, maks. 200 znaków; **kind 1** długi bez limitu znaków z możliwością nadpisania dla integracji. Edytory: `text`, `number`, `select`, `checkbox`, `radio`, `date`, `file`. `options` jest opcjonalne i dotyczy select/checkbox/radio. Nie podano formatu daty/pliku, typów wartości opcji, tłumaczeń, paginacji ani limitu liczby pól. Brak `inventory_id` nie jest zgodą na dopisanie filtra.

### getInventoryIntegrations

Grupa: **Product catalog / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryIntegrations).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `inventory_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `integrations` | `array` |
| out | `↳langs` | `array` |
| out | `↳accounts` | `array` |

`inventory_id` odsyła do `getInventories.inventory_id`. Zwraca integracje wspierające nadpisanie tekstów: kluczem mapy jest kod integracji; `langs` zawiera dwuliterowe kody, `accounts` to mapa ID→nazwa konta. Wszystkie trzy kolekcje mają źródłowy typ array mimo map w opisie/przykładzie. Nie jest to `getConnectIntegrations` ani dowód zdolności zapisu oferty. Required, paginacja, kolejność, limity i kompletność języków nie są opisane.

### getInventoryPrintoutTemplates

Grupa: **Product catalog / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryPrintoutTemplates).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `printouts` | `array` |
| out | `↳printout_id` | `int` |
| out | `↳name` | `text` |
| out | `↳type` | `text` |

Bez parametrów. Zwraca skonfigurowane szablony wydruków produktów. `type` określa format; **PDF/HTML/XLS to przykłady**, nie zamknięte enum. Metoda nie generuje pliku i nie dowodzi poprawności wydruku/hardware. Brak paginacji, renderowania, zawartości szablonu, uprawnień do konkretnego szablonu i limitu.

### getInventoryPromotionsList

Grupa: **Product catalog / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryPromotionsList).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `page` | `int` |
| out | `promotions` | `array` |
| out | `↳promotion_id` | `int` |
| out | `↳position` | `int` |
| out | `↳name` | `varchar(100)` |
| out | `↳is_enabled` | `bool` |
| out | `↳products_filter_type` | `int` |
| out | `↳products_filter_data` | `array` |
| out | `↳is_include_subcategories` | `bool` |
| out | `↳source_price_group_id` | `int` |
| out | `↳target_price_group_id` | `int` |
| out | `↳duration_type` | `int` |
| out | `↳date_start` | `int` |
| out | `↳date_end` | `int` |
| out | `↳price_multiplier` | `float` |
| out | `↳price_addition` | `float` |
| out | `↳price_round` | `int` |
| out | `↳csv_identifier` | `varchar(10)` |
| out | `↳date_added` | `int` |
| out | `↳date_updated` | `int` |
| out | `↳date_last_calculated` | `int` |

Opcjonalna `page`: **100 promocji, numeracja od 1**; default strony nie podano. Wynik także zawiera numer strony. Kolejność priorytetów: niższe `position` najpierw, bez reguły remisu i stabilności stron.

Filtry 1–4 jak w create: **1** pusty array, **2/3** tablice ID int, **4** obiekt z `type` równym `csv_identifier` oraz `product_prices`. To **asymetria read/write**: create zabrania `type`, getter je zwraca. Dla4 źródło/mnożnik/dodatek/round wynoszą **0/1/0/0**; `csv_identifier` tylko wtedy. Podkategorie true tylko dla 3 z włączoną opcją. Czas0/1; dla 0 daty0. `date_added`, `date_updated`, `date_last_calculated` dotyczą stworzenia, definicji i ostatniego przebiegu aktywnej promocji; sam timestamp nie potwierdza efektu cen. Brak total/has_more, usuwania i zasad nakładania promocji.

Zaokrąglenie `price_round`: **0** bez, **1/2** w górę/dół do pełnej kwoty, **3/4** w górę/dół do .99, **5/6** w górę/dół do najbliższego 0.09, **7** w górę i dół z dokładnością 0.09, **8** do najbliższego 0.10, **9** jednostki do najbliższej 5. Nie dopisano wzoru, rozstrzygania remisu ani waluty.

Dodatkowe pola/pozycje z prozy (nie osobne wiersze HTML; „nie podano” pozostaje unknown):

| Kierunek | Ścieżka | Typ źródłowy | Znaczenie/warunek |
|---|---|---|---|
| out | `promotions[].products_filter_data.type` | `nie podano` | wartość csv_identifier dla filtra4 |
| out | `promotions[].products_filter_data.product_prices` | `nie podano` | mapa jawnych cen dla filtra4 |

### getInventoryShippingTemplates

Grupa: **Product catalog / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryShippingTemplates).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `shipping_templates` | `array` |
| out | `↳source` | `text` |
| out | `↳site` | `mixed` |
| out | `↳id` | `text` |
| out | `↳name` | `text` |

Bez parametrów. Płaska lista schematów dostawy marketplace. `source` ma format `[type]_[account_id]`; współdzielone schematy mogą mieć konto **0**, np. Amazon. `site` jest **mixed**, kodem rynku lub **null** przy braku podziału. `id` to tekst przekazywany jako `addInventoryProduct.shipping_template`; nie zamieniamy go na int. Brak paginacji, gwarancji obsługi przewoźnika, generowania paczki, kosztów czy przyjęcia etykiety.

### getSyncLogList

Grupa: **Product catalog / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getSyncLogList).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `last_log_id` | `int` |
| in | `source` | `varchar(50)` |
| in | `errors_only` | `bool` |
| out | `status` | `varchar(30)` |
| out | `logs` | `array` |
| out | `↳log_id` | `int` |
| out | `↳group_id` | `int` |
| out | `↳order_from` | `varchar(50)` |
| out | `↳item_id` | `varchar(60)` |
| out | `↳type` | `int` |
| out | `↳from` | `float` |
| out | `↳to` | `float` |
| out | `↳date_added` | `int` |
| out | `↳error_code` | `varchar(50)` |
| out | `↳error_text` | `text` |

Maksymalnie **1000 wpisów**, rosnąco po `log_id`. `last_log_id` jest **inkluzywne (`id >= last_log_id`)**, a ID unikalne wyłącznie w rodzinie marketplace: należy łączyć je z `source`. Brak source wybiera logi ogólne; podane kody to `allegro`, `ebay`, `amazon`, `amazon_vendor`, bez deklaracji zamkniętego enum. `errors_only` domyślnie **false**, true wybiera `error_id > 0` (to opis filtra, nie pole wyniku).

`type0` oznacza ilość, `type1` cenę; `from`/`to` są wartościami przed/po próbie, `date_added` Unix. `error_code`/`error_text` obecne tylko dla błędu. Brak total/has_more, okresu retencji, reguły kolejnego kursora i bezpiecznego dowodu efektu u dostawcy; nie zamieniono inkluzywnego offsetu na ekskluzywny.

### getConnectIntegrationContractors

Grupa: **Base Connect / Integrations**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getConnectIntegrationContractors).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `connect_integration_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `contractors` | `array` |
| out | `↳connect_contractor_id` | `int` |
| out | `↳name` | `text` |
| out | `↳credit_data` | `array` |
| out | `↳settings` | `array` |

Wybiera kontrahentów jednej integracji Base Connect po `connect_integration_id`. `credit_data` to podsumowanie kredytu, `settings` opcje; ich struktur nie zadeklarowano. Tabela nazywa kolekcję array, przykład używa mapy: klucz **12** ma wewnętrzne `connect_contractor_id=34`, więc nie wolno utożsamiać klucza i ID. Required, paginacja, kolejność i kompletność nieopisane; nie rekonstruujemy kredytu z innych metod.

### getConnectIntegrations

Grupa: **Base Connect / Integrations**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getConnectIntegrations).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `integrations` | `array` |
| out | `↳connect_integration_id` | `int` |
| out | `↳name` | `varchar(100)` |
| out | `↳settings` | `array` |

Bez parametrów. Zwraca integracje konta w dwóch sekcjach: `own_integrations` utworzone tutaj oraz `connected_integrations` przyłączone. Wspólne zagnieżdżone pola dotyczą integracji w obu sekcjach, a struktura `settings` pozostaje nieokreślona. `integrations: array` jest w przykładzie obiektem z dwiema tablicami. Brak paginacji, kolejności, konfiguracji połączenia i gwarancji dostępu do kontrahentów.

Dodatkowe pola/pozycje z prozy (nie osobne wiersze HTML; „nie podano” pozostaje unknown):

| Kierunek | Ścieżka | Typ źródłowy | Znaczenie/warunek |
|---|---|---|---|
| out | `integrations.own_integrations` | `nie podano` | integracje własne; przykład tablicy |
| out | `integrations.connected_integrations` | `nie podano` | integracje przyłączone; przykład tablicy |

### addConnectContractorCreditSettlement

Grupa: **Base Connect / Contractor credit**. [Oficjalna strona](https://api.baselinker.com/index.php?method=addConnectContractorCreditSettlement).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `connect_contractor_id` | `int` |
| in | `amount` | `float` |
| in | `message` | `varchar(255)` |
| in | `order_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `credit_entry_id` | `int` |
| out | `new_blocked_credit` | `float` |
| out | `new_available_credit` | `float` |

Rejestruje ręczną spłatę wcześniej obciążonych zamówień, zmniejszając zablokowany kredyt. `amount` musi być **dodatnie i nie większe niż bieżące `credit_to_pay`**; mimo typu float proza jawnie dopuszcza JSON **number lub string**. `message` maks.255 znaków. `order_id=0` lub pominięte oznacza brak konkretnego zamówienia. ID kontrahenta z `getConnectIntegrationContractors`; required pozostałych pól nie oznaczono osobno. Wynik podaje wpis, nowy zablokowany i dostępny kredyt. Brak waluty na wejściu, precyzji, współbieżności, atomowości, klucza idempotencji i uzgadniania płatności bankowej. Nie wykonano spłaty.

### getConnectContractorCreditHistory

Grupa: **Base Connect / Contractor credit**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getConnectContractorCreditHistory).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `connect_contractor_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `credit_data` | `array` |
| out | `↳credit_entry_id` | `int` |
| out | `↳date_add` | `int` |
| out | `↳description` | `text` |
| out | `↳currency` | `char(3)` |
| out | `↳type` | `text` |
| out | `↳amount` | `float` |
| out | `↳is_accepted` | `int` |

Historia kredytu kontrahenta. `date_add` jest Unix, `currency` char(3); `type` ma **charge/payment**, `is_accepted` **0 oczekujące /1 aktywne**. W przykładzie int/float (`date_add`, `amount`, `is_accepted`) bywają zapisane jako string, co pozostaje różnicą tabeli i przykładu. Brak paginacji, kolejności, salda początkowego, retencji, precyzji, reguł znaków i cofania wpisów; nie wywiedziono tych zasad z nazwy historii.

### setConnectContractorCreditLimit

Grupa: **Base Connect / Contractor credit**. [Oficjalna strona](https://api.baselinker.com/index.php?method=setConnectContractorCreditLimit).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `connect_contractor_id` | `int` |
| in | `new_limit` | `float` |
| in | `message` | `text` |
| out | `status` | `varchar(30)` |
| out | `new_limit_set` | `text` |

Ustawia limit kontrahenta; `message` jest tekstem widocznym w historii. `new_limit` ma float, ale wynik **`new_limit_set: text`** zawiera sformatowaną kwotę z walutą, nie numeryczne saldo. Required, zakres/znak, waluta wejścia, reguły obniżenia poniżej wykorzystania, atomowość i idempotencja nieopisane. Nie utożsamiamy tej operacji z dopisaniem spłaty ani nie wykonano zmiany limitu.

### getExternalStorageCategories

Grupa: **External storages / External connections**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getExternalStorageCategories).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `storage_id` | `varchar(30)` |
| out | `status` | `varchar(30)` |
| out | `storage_id` | `varchar(30)` |
| out | `categories` | `array` |
| out | `↳category_id` | `int` |
| out | `↳name` | `varchar(200)` |
| out | `↳parent_id` | `int` |

Odczytuje kategorie sklepu/hurtowni. `storage_id` jest tekstem `[type:shop/warehouse]_[id:int]` (źródłowy zapis alternatywy `shop|warehouse`), np. shop_2445. Typy kategorii i rodzica to int; przykład używa rodzica 0, bez ogólnej definicji korzenia. Brak paginacji, kolejności, limitu głębokości, gwarancji kompletności oraz wymagania tworzenia kategorii. Required dla ID nieoznaczone.

### getExternalStorageProductsData

Grupa: **External storages / External connections**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getExternalStorageProductsData).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `storage_id` | `varchar(30)` |
| in | `products` | `array` |
| out | `status` | `varchar(30)` |
| out | `storage_id` | `varchar(30)` |
| out | `products` | `array` |
| out | `↳product_id` | `varchar(30)` |
| out | `↳sku` | `varchar(50)` |
| out | `↳ean` | `varchar(50)` |
| out | `↳asin` | `varchar(50)` |
| out | `↳name` | `varchar(255)` |
| out | `↳quantity` | `int` |
| out | `↳price_netto` | `float` |
| out | `↳price_brutto` | `float` |
| out | `↳price_wholesale_netto` | `float` |
| out | `↳tax_rate` | `float` |
| out | `↳weight` | `float` |
| out | `↳description` | `text` |
| out | `↳description_extra1` | `text` |
| out | `↳description_extra2` | `text` |
| out | `↳man_name` | `varchar(50)` |
| out | `↳man_image` | `varchar(100)` |
| out | `↳category_id` | `int` |
| out | `↳images` | `array` |
| out | `↳features` | `array` |
| out | `↳variants` | `array` |
| out | `↳[inne]` | `text` |

Odczytuje szczegóły wybranych ID; brak limitu partii i zasad brakujących/duplikowanych produktów. ID produktu varchar(30), wariantu w prozie int; ceny/ilości w przykładzie mieszają liczby i string. `weight` jest w kg. VAT: **0–100**, wyjątki **−1=EXPT/ZW, −0.02=NP, −0.03=OO**. Nie przenosimy tych wartości do lokalnego VAT automatycznie.

`features` opisano jako listę par, ale przykład ma mapę nazwa→wartość. `variants` ma własne 7 pól (poniżej); główne `products: array` jest w przykładzie mapą ID→obiekt. `images` to osobne zdjęcia, `man_image` pełny adres. SKU może pomóc odbudowie skojarzeń. `[inne]` jawnie dopuszcza pola indywidualnego pliku integracji. Kategoria musi być **wcześniej utworzona przez addCategories**; nie podmieniono tej źródłowej nazwy na inną metodę. Brak waluty, zaokrągleń, cen wariantu netto/brutto, paginacji i nullowalności.

Dodatkowe pola/pozycje z prozy (nie osobne wiersze HTML; „nie podano” pozostaje unknown):

| Kierunek | Ścieżka | Typ źródłowy | Znaczenie/warunek |
|---|---|---|---|
| out | `products[].features[][0]` | `varchar` | nazwa parametru |
| out | `products[].features[][1]` | `varchar` | wartość parametru |
| out | `products[].variants[].variant_id` | `int` | ID wariantu |
| out | `products[].variants[].name` | `varchar` | pełna nazwa |
| out | `products[].variants[].price` | `float` | cena |
| out | `products[].variants[].quantity` | `int` | ilość |
| out | `products[].variants[].sku` | `varchar` | SKU |
| out | `products[].variants[].ean` | `varchar` | EAN |
| out | `products[].variants[].asin` | `varchar` | ASIN |

### getExternalStorageProductsList

Grupa: **External storages / External connections**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getExternalStorageProductsList).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `storage_id` | `varchar(30)` |
| in | `filter_category_id` | `varchar(30)` |
| in | `filter_sort` | `varchar(30)` |
| in | `filter_id` | `varchar(30)` |
| in | `filter_sku` | `varchar(50)` |
| in | `filter_ean` | `varchar(320)` |
| in | `filter_asin` | `varchar(50)` |
| in | `filter_name` | `varchar(255)` |
| in | `filter_price_from` | `float` |
| in | `filter_price_to` | `float` |
| in | `filter_quantity_from` | `int` |
| in | `filter_quantity_to` | `int` |
| in | `filter_available` | `int` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `storage_id` | `varchar(30)` |
| out | `products` | `array` |
| out | `↳product_id` | `varchar(30)` |
| out | `↳sku` | `varchar(50)` |
| out | `↳ean` | `varchar(50)` |
| out | `↳asin` | `varchar(50)` |
| out | `↳name` | `varchar(255)` |
| out | `↳quantity` | `int` |
| out | `↳price_brutto` | `float` |

Poza magazynem wszystkie filtry i `page` są opcjonalne. Sort: **id/name/quantity/price**, każde ASC/DESC. Nazwa dopasowuje fragment lub pustą wartość; availability **1 dostępne /0 niedostępne /puste wszystkie**. Zachowano `filter_ean: varchar(320)` i `filter_category_id: varchar(30)` mimo int w przykładzie. Zakresy ceny/ilości nie definiują inkluzywności. Wynik podaje **price_brutto**, metoda jawnie nie daje ceny netto. Brak rozmiaru/default/numeracji strony, total/has_more, stabilności, domyślnego sortu i reguł wariantów.

### getExternalStorageProductsPrices

Grupa: **External storages / External connections**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getExternalStorageProductsPrices).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `storage_id` | `varchar(30)` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `storage_id` | `varchar(30)` |
| out | `products` | `array` |
| out | `↳product_id` | `varchar(30)` |
| out | `↳price` | `float` |
| out | `↳variants` | `array` |

Odczyt cen, opcjonalna `page`, lecz bez rozmiaru, default, numeracji, total/has_more i kolejności. Produkt/variant mają varchar(30); cena float. **Nie podano netto/brutto, waluty, zaokrągleń ani relacji ceny wariantu do głównej**; nie przeniesiono znaczenia `price_brutto` z innego endpointu. Warianty mogą być pustą listą w przykładzie, bez ogólnej gwarancji kształtu braku.

Dodatkowe pola/pozycje z prozy (nie osobne wiersze HTML; „nie podano” pozostaje unknown):

| Kierunek | Ścieżka | Typ źródłowy | Znaczenie/warunek |
|---|---|---|---|
| out | `products[].variants[].variant_id` | `varchar(30)` | ID wariantu |
| out | `products[].variants[].price` | `float` | cena |

### getExternalStorageProductsQuantity

Grupa: **External storages / External connections**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getExternalStorageProductsQuantity).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `storage_id` | `varchar(30)` |
| in | `page` | `int` |
| out | `status` | `varchar(30)` |
| out | `storage_id` | `varchar(30)` |
| out | `products` | `array` |
| out | `↳product_id` | `varchar(30)` |
| out | `↳quantity` | `int` |
| out | `↳variants` | `array` |

Odczyt ilości produktu i jego wariantów; opcjonalna `page` bez rozmiaru/default/numeracji/total/kolejności. ID varchar(30), ilość int. Nie określono minimum, rezerwacji, dostępności handlowej, sumowania wariantów do produktu ani spójnego snapshotu. Brak strony w wejściu nie jest dowodem pełnej odpowiedzi.

Dodatkowe pola/pozycje z prozy (nie osobne wiersze HTML; „nie podano” pozostaje unknown):

| Kierunek | Ścieżka | Typ źródłowy | Znaczenie/warunek |
|---|---|---|---|
| out | `products[].variants[].variant_id` | `varchar(30)` | ID wariantu |
| out | `products[].variants[].quantity` | `int` | ilość |

### getExternalStoragesList

Grupa: **External storages / External connections**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getExternalStoragesList).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `storages` | `array` |
| out | `↳storage_id` | `varchar(30)` |
| out | `↳name` | `varchar(100)` |
| out | `↳methods` | `array` |
| out | `↳read` | `bool` |
| out | `↳write` | `bool` |

Bez parametrów. Udostępnione sklepy/hurtownie opisują wspierane nazwy `methods` oraz osobne flagi **read/write**. Sama obecność metody nie zastępuje uprawnienia: przykład ma metodę zapisu, ale `write=false`. ID tekstowe shop_/warehouse_ nie jest lokalnym UUID. Brak paginacji, kolejności i zasad zmiany uprawnień; ta lista nie dowodzi działającego połączenia ani testu konta.

### updateExternalStorageProductsQuantity

Grupa: **External storages / External connections**. [Oficjalna strona](https://api.baselinker.com/index.php?method=updateExternalStorageProductsQuantity).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `storage_id` | `varchar(30)` |
| in | `products` | `array` |
| out | `status` | `varchar(30)` |
| out | `counter` | `int` |
| out | `warnings` | `array` |

Zbiorczy zapis ilości produktów/wariantów, maks. **1000 produktów na wywołanie**. Każdy element jest dokładnie opisaną **3-elementową tablicą**: produkt varchar, wariant int (**0** = główny), ilość int. Nie zamieniono tej struktury na obiekt i nie dopisano minimum ilości.

`counter` liczy odebrane elementy, nie potwierdzone sukcesy. Opis `warnings: array` mówi omyłkowo o identyfikatorze kategorii i błędzie dodawania; nie poprawiamy tego w wymyślony protokół. Przykład ma 2 wiersze, counter 4, warnings pusty string i numeryczne ID zamiast varchar. Te rozbieżności zostają otwarte. Brak atomowości, częściowego sukcesu, readbacku, trwałej idempotencji i bezpiecznego automatycznego retry. Nie wykonano zapisu.

Dodatkowe pola/pozycje z prozy (nie osobne wiersze HTML; „nie podano” pozostaje unknown):

| Kierunek | Ścieżka | Typ źródłowy | Znaczenie/warunek |
|---|---|---|---|
| in | `products[][0]` | `varchar` | ID produktu |
| in | `products[][1]` | `int` | ID wariantu lub 0 |
| in | `products[][2]` | `int` | ilość |

## Pokrycie i późniejszy odbiór

Niezależny parser DOM całych stron sprawdza każdy kierunek, nazwę i typ, z separatorami br/li; oddzielnie sprawdza 16 typowanych pozycji z prozy oraz 5 nazw bez osobnego typu. Kontrola bajtów/SHA/statusu/final URL/dat/nagłówka i grupy dotyczy każdej strony. Liczba pól nie zastępuje zgodności treści.

| Metoda | in | out | nested in | nested out | pola/pozycje z prozy |
|---|---:|---:|---:|---:|---:|
| `addInventoryPromotion` | 15 | 2 | 0 | 0 | 1 |
| `getInventoryAvailableTextFieldKeys` | 1 | 2 | 0 | 0 | 0 |
| `getInventoryExtraFields` | 0 | 7 | 0 | 5 | 0 |
| `getInventoryIntegrations` | 1 | 4 | 0 | 2 | 0 |
| `getInventoryPrintoutTemplates` | 0 | 5 | 0 | 3 | 0 |
| `getInventoryPromotionsList` | 1 | 22 | 0 | 19 | 2 |
| `getInventoryShippingTemplates` | 0 | 6 | 0 | 4 | 0 |
| `getSyncLogList` | 3 | 12 | 0 | 10 | 0 |
| `getConnectIntegrationContractors` | 1 | 6 | 0 | 4 | 0 |
| `getConnectIntegrations` | 0 | 5 | 0 | 3 | 2 |
| `addConnectContractorCreditSettlement` | 4 | 4 | 0 | 0 | 0 |
| `getConnectContractorCreditHistory` | 1 | 9 | 0 | 7 | 0 |
| `setConnectContractorCreditLimit` | 3 | 2 | 0 | 0 | 0 |
| `getExternalStorageCategories` | 1 | 6 | 0 | 3 | 0 |
| `getExternalStorageProductsData` | 2 | 24 | 0 | 21 | 9 |
| `getExternalStorageProductsList` | 14 | 10 | 0 | 7 | 0 |
| `getExternalStorageProductsPrices` | 2 | 6 | 0 | 3 | 2 |
| `getExternalStorageProductsQuantity` | 2 | 6 | 0 | 3 | 2 |
| `getExternalStoragesList` | 0 | 7 | 0 | 5 | 0 |
| `updateExternalStorageProductsQuantity` | 2 | 3 | 0 | 0 | 3 |
| **Razem** | 53 | 148 | 0 | 99 | 21 |

Potwierdzono 40 wystąpień error_message/error_code w prozie statusów; nie są wliczone do tabel. Wszystkie 20 metod ma wyłącznie dowód dokumentacyjny i acceptance=false.

Odbiór wymaga oddzielnie pełnego UI/API: create/update/list promocji i faktycznego przeliczenia, map tekstów/języków/schematów, readback kredytu po spłacie/limicie, wszystkich stron oraz pełnych/niepełnych błędnych partii magazynu. Rzeczywisty odczyt konta, potwierdzenie skutków, uprawnienia i bezpieczne uzgodnienie utraconego ACK pozostają otwarte. Dla zapisów z nieopisanym replay nie uznano ponowienia za bezpieczne.
