# API Base — pozostałe grupy Orders, uzupełnienie z 18.10.2026

**Dokumentacja, nie implementacja ani odbiór konta.** Obejmuje komplet trzech dotąd nieopisanych grup rodziny Orders w indeksie204 z 17.10: `Order products` (3), `Pick lists` (2), `Other` (9), razem **14 metod**. Nie zmienia starszego indeksu ani snapshotów. Indywidualne HTML pobrano dopiero **18.10.2026, 00:54:25–00:54:27 UTC**; nie jest to dowód treści stron z 17.10.

`documentation_only=true`, `official_account_requests_performed=false`, `implementation_verified=false`, `wire_acceptance=false`, `provider_account_acceptance=false`, `acceptance_granted=false`. Nie mapowano samych nazw na lokalne route jako dowodu wire parity.

## Źródła i transport

Wykonano 14 publicznych GET dokumentacji na `https://api.baselinker.com`, wszystkie HTTP200. Nie wywołano `connector.php`, konta ani skryptów stron. Przykłady opisują POST do tego connectora, nagłówek `X-BLToken` i formularz `method` + `parameters` z JSON; jest to obserwacja przykładów, bez testu transmisji. Datę pobrania, final URL, typ odpowiedzi i dostępne Date/ETag/Last-Modified zachowano; nie zapisano Set-Cookie. Nieznana jest data publikacji wersji metod.

- [Snapshot HTML](base-api-orders-next-sources-20261018.json.gz): 142815 B, SHA256 `0ec4bc405b62e0e7f10b4882d055974db8c7f019a165232f37538b70d5baf289`.
- JSON po rozpakowaniu: 812391 B, SHA256 `36f20fc53d8d5deada52183d591040fe70f868722846913ed8a2013a7eb77f5d`.
- Indeks204: SHA256 `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`; wszystkie14 nazw istnieje w trzech wybranych grupach.

| Metoda | Pobranie UTC18.10 | HTML B | SHA256 HTML |
|---|---|---:|---|
| `addOrderProduct` | 00:54:25.292156 | 52011 | `f806b370b78832dbb35c98cbf331ed3407e0b416cafc74df1572ac1f40e8d312` |
| `deleteOrderProduct` | 00:54:25.533801 | 48776 | `3479e604a48bed0cb3648e1751426462e0251deab646966402f5c25c8ecc65c4` |
| `setOrderProductFields` | 00:54:25.526317 | 51557 | `b0f3682914d5218048de25dcb868cfdc75613e75b6c2f1ae29dc0ad5eff14b02` |
| `addOrderPickList` | 00:54:25.456935 | 48996 | `22cdfb4873d3ba8987d899fe754a8adfbc953a272aad3b0f39a522280e80e7b3` |
| `getOrderPickLists` | 00:54:25.812093 | 50838 | `c164407427468c7778c22eefeba0a9545d9905ab38711862eec1b5fae524bf2c` |
| `getJournalList` | 00:54:26.028824 | 51123 | `5407ade0c7965ff9157ed09b36f38726626d970bfc8bd3c937c5a39e4a4ed398` |
| `getOrderExtraFields` | 00:54:26.069434 | 50234 | `1aa1b6c02d573b5188a1d31bd4e419ee2c1da931c954012ca209e867e4f8ad1e` |
| `getOrderPickPackHistory` | 00:54:26.057983 | 51452 | `6dca4207291e4e7549e4fda259d4f1013a589c5ade84fd981bca58aa6896e0a6` |
| `getOrderPrintoutTemplates` | 00:54:26.278447 | 49386 | `2343e198be6a0466f3dc8058af4696c53072d50e334a62b498176417b86607af` |
| `getOrderSources` | 00:54:26.597427 | 50794 | `fb2ca39313219a2aaef30d472982509816a9b3bf3f07fefcade92f809583408c` |
| `getOrderTransactionData` | 00:54:26.622851 | 52691 | `d2de7a8cbc1cd394afb9b13e63faae63fa94c64d183c46ab654b862f4dde7b60` |
| `getOrdersByEmail` | 00:54:26.638529 | 50101 | `be6681758b9055fe456671014457498103f6ee7335b26945b11aa8da6ff82fab` |
| `getOrdersByPhone` | 00:54:26.813444 | 50360 | `456c534aa8b5b9a504c2f137ca7089e3c1d63414d9511b034c8b6275a61ed97d` |
| `runOrderMacroTrigger` | 00:54:27.103113 | 48810 | `48ac547df1c29c2f1d259b1347b9de34e628fd291caa5097e69a25d2a76f0ac6` |

## Wspólne granice kontraktu

Każda metoda ma `status: varchar(30)` z SUCCESS/ERROR. Proza wskazuje `error_message` i `error_code`, ale bez typów, katalogu kodów i reguł HTTP. Nie zakładamy pól sukcesu przy błędzie. Brak osobnego required oznacza **nieokreślone**, nie „opcjonalne”; jawne wyjątki opisano niżej. Typy tabel pozostają literalne, konflikty przykładów są jawne. `↳` odwzorowuje źródłowy prefiks zagnieżdżenia `| -`; pola z prozy mają osobne tabele. Żadnej precyzji pieniędzy, nullowalności, idempotencji, retry ani atomowości nie dopisano na podstawie intuicji.

### addOrderProduct

Grupa indeksu: **Orders / Order products**. [Oficjalna strona](https://api.baselinker.com/index.php?method=addOrderProduct).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| in | `storage` | `varchar(9)` |
| in | `storage_id` | `varchar(50)` |
| in | `product_id` | `varchar(50)` |
| in | `variant_id` | `varchar(30)` |
| in | `auction_id` | `varchar(20)` |
| in | `name` | `varchar(200)` |
| in | `sku` | `varchar(50)` |
| in | `ean` | `varchar(32)` |
| in | `location` | `varchar(50)` |
| in | `warehouse_id` | `int` |
| in | `attributes` | `varchar(350)` |
| in | `price_brutto` | `float` |
| in | `tax_rate` | `float` |
| in | `quantity` | `int` |
| in | `weight` | `decimal(10,2)` |
| out | `status` | `varchar(30)` |
| out | `order_product_id` | `int` |

Dodaje pozycję zamówienia, zwraca jej `order_product_id`. `storage` dopuszcza `db`, `shop`, `warehouse`; identyfikatory produktu/wariantu mogą być puste, gdy nieznane. `location` pozwala na kilka lokalizacji rozdzielonych średnikiem. `warehouse_id` pochodzi z **`getInventoryWarehouses.internal_warehouse_id`** (nie pola `warehouse_id` tamtej metody) i dotyczy magazynu Base: pominięcie dziedziczy kompatybilne źródło lub domyślny magazyn źródła zamówienia, `0` usuwa konkretny wybór. Cena jest jednostkowa brutto; VAT 0–100 ma wyjątki `-1` (EXPT/ZW), `-0.02` (NP), `-0.03` (OO). Waga jednostkowa ma tu **decimal(10,2)**. Required nie oznaczono; minimum ilości, skutki stock/rezerwacji, zaokrąglenia i idempotencja są nieokreślone. Przykład liczb dla `storage_id`/`variant_id` nie zmienia ich tabelarycznych typów tekstowych.

### deleteOrderProduct

Grupa indeksu: **Orders / Order products**. [Oficjalna strona](https://api.baselinker.com/index.php?method=deleteOrderProduct).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| in | `order_product_id` | `int` |
| out | `status` | `varchar(30)` |

Usuwa wskazaną pozycję z zamówienia, nie produkt katalogowy. Osobnych znaczników required nie ma. Brak reguł dla obcej/brakującej pozycji, ponowienia, wystawionych dokumentów, rezerwacji i WMS; `SUCCESS` nie potwierdza tych nieopisanych skutków.

### setOrderProductFields

Grupa indeksu: **Orders / Order products**. [Oficjalna strona](https://api.baselinker.com/index.php?method=setOrderProductFields).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| in | `order_product_id` | `int` |
| in | `storage` | `varchar(9)` |
| in | `storage_id` | `varchar(50)` |
| in | `product_id` | `varchar(50)` |
| in | `variant_id` | `varchar(30)` |
| in | `auction_id` | `varchar(20)` |
| in | `name` | `varchar(200)` |
| in | `sku` | `varchar(50)` |
| in | `ean` | `varchar(32)` |
| in | `location` | `varchar(50)` |
| in | `warehouse_id` | `int` |
| in | `attributes` | `varchar(350)` |
| in | `price_brutto` | `float` |
| in | `tax_rate` | `float` |
| in | `quantity` | `int` |
| in | `weight` | `float` |
| out | `status` | `varchar(30)` |

`order_id` i `order_product_id` są jawnie wymagane; przesyła się tylko edytowane pola, pozostałe można pominąć. Znaczenie źródła, ceny jednostkowej, identyfikatorów oraz wyjątków VAT jest jak opisano na tej stronie; `warehouse_id` odwzorowuje **`getInventoryWarehouses.internal_warehouse_id`**; `warehouse_id=0` pozostawia brak konkretnego magazynu. Waga ma tu **float**, inaczej niż przy dodaniu. Brak domyślania kasowania przez null/pusty tekst, walidacji ilości/ceny, stock i historii finansowej. Opis `location` nie powtarza obsługi średników z dodawania; nie przeniesiono jej automatycznie.

### addOrderPickList

Grupa indeksu: **Orders / Pick lists**. [Oficjalna strona](https://api.baselinker.com/index.php?method=addOrderPickList).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `order_ids` | `array` |
| out | `status` | `varchar(30)` |
| out | `pick_list_id` | `int` |

Tworzy papierową listę dla własnych zamówień. `order_ids` musi zawierać **1–100 dodatnich liczb całkowitych**. Utworzenie nie drukuje listy i nie oznacza zamówień jako zebranych ani spakowanych. Zwraca `pick_list_id`. Nie opisano duplikatów, częściowej odmowy, kolejności, powtórnego tworzenia ani późniejszego polecenia drukowania.

### getOrderPickLists

Grupa indeksu: **Orders / Pick lists**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getOrderPickLists).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `pick_list_id` | `int` |
| in | `id_from` | `int` |
| out | `status` | `varchar(30)` |
| out | `picklists` | `array` |
| out | `↳pick_list_id` | `int` |
| out | `↳barcode` | `varchar(15)` |
| out | `↳date_added` | `int` |
| out | `↳orders_count` | `int` |
| out | `↳order_ids` | `array` |
| out | `↳creator_profile_id` | `int` |
| out | `↳is_printed` | `bool` |

Oba filtry są opcjonalne, ale `pick_list_id` i `id_from` **nie mogą wystąpić razem**. Maksimum 100 list; kolejność rosnąca po `pick_list_id`, a `order_ids` również rosnąco. `date_added` jest Unix timestamp; `creator_profile_id=-1` oznacza API. `is_printed` opisuje skuteczny wydruk. `id_from` jest punktem pobierania kolejnych list, lecz proza nie precyzuje inkluzywności ani stabilności równoległego odczytu; przykład zawiera sam wskazany identyfikator. Brak kursora następnej strony i gwarancji kompletności jednym wywołaniem.

### getJournalList

Grupa indeksu: **Orders / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getJournalList).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `last_log_id` | `int` |
| in | `logs_types` | `array` |
| in | `order_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `logs` | `array` |
| out | `↳id` | `int` |
| out | `↳order_id` | `int` |
| out | `↳log_type` | `int` |
| out | `↳object_id` | `int` |
| out | `↳date` | `int` |

Obejmuje ostatnie **3 dni**; funkcja musi być włączona w ustawieniach API konta. Pusta odpowiedź może oznaczać jej wyłączenie, nie brak zdarzeń. Required, wielkość partii, kolejność oraz inkluzywność `last_log_id` są nieokreślone. `logs_types` opisano jako listę ID zdarzeń; przykład sugeruje typy, ale nie rozstrzyga tej niejednoznaczności.

**Konflikt źródła:** tabela daje `logs[].id`, przykład JSON `logs[].log_id`. Zachowano obie obserwacje, bez wyboru schematu przewodowego.

Typy `log_type`: 1 utworzenie; 2 DOF; 3 płatność; 4 usunięcie zamówienia/faktury/paragonu; 5 merge; 6 split; 7 faktura; 8 paragon; 9 paczka; 10 usunięcie paczki; 11 edycja danych dostawy; 12 dodanie pozycji; 13 edycja pozycji; 14 usunięcie pozycji; 15 blacklist; 16 dane zamówienia; 17 kopia; 18 status; 19 usunięcie faktury; 20 usunięcie paragonu; 21 edycja faktury; 22 status paczki.

`object_id`: 5 scalone zamówienie, 6 nowe po split, 7 faktura, 9/10 paczka, 14 pozycja, 17 kopia, 18 status, 22 paczka. Pozostałych znaczeń nie podano.

### getOrderExtraFields

Grupa indeksu: **Orders / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getOrderExtraFields).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `extra_fields` | `array` |
| out | `↳extra_field_id` | `int` |
| out | `↳name` | `text` |
| out | `↳editor_type` | `text` |
| out | `↳options` | `array` |

Brak pól wejściowych; przykład `{}`. Zwraca definicje pól, a nie wartości zamówienia. Wartości ustawia `setOrderFields`, odczytuje `getOrders` z `include_custom_extra_fields`. `editor_type`: text, number, select, checkbox, radio, date, file. `options` jest opcjonalne i dotyczy select/checkbox/radio; typu jego elementów nie zadeklarowano. **Niejednoznaczność:** proza opisuje kolekcję kluczowaną identyfikatorem, a przykład listę obiektów. Tabela `array` nie rozstrzyga JSON object kontra list. Brak paginacji i stabilności definicji.

### getOrderPickPackHistory

Grupa indeksu: **Orders / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getOrderPickPackHistory).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| in | `action_type` | `int` |
| out | `status` | `varchar(30)` |
| out | `history` | `array` |

Odczytuje historię jednego zamówienia. `action_type` jest opcjonalny; tabela mówi **int**, opis „lista typów” — konflikt pozostaje otwarty. Brak paginacji, porządku, retencji i required dla `order_id`.

Typy akcji 1–19: 1 rezerwacja zbierania; 2 start zbierania; 3 anulowanie zbierania; 4 zbieranie w toku; 5 zebrano; 6 błąd zbierania; 7 rezerwacja pakowania; 8 start pakowania; 9 anulowanie pakowania; 10 pakowanie w toku; 11 spakowano; 12 błąd pakowania; 13 inicjalizacja zdjęcia; 14 zdjęcie wykonane; 15 zdjęcie usunięte; 16 błąd zapisu zdjęcia; 17 zbyt duży obraz; 18 zdjęcie przez Base Connect; 19 wyczyszczenie koszyka.

`profile_id` jest tekstową nazwą profilu mimo nazwy z `_id`; nie zamieniono go na identyfikator liczbowy.

Pola zagnieżdżone wymienione w **prozie komórki**, poza wierszami tabeli HTML:

| Ścieżka | Typ źródłowy |
|---|---|
| `history[].action_type` | `int` |
| `history[].profile_id` | `varchar` |
| `history[].station_id` | `int` |
| `history[].cart_id` | `int` |
| `history[].entry_date` | `niepodany` |

`entry_date` opisano jako czas Unix, ale nie podano osobnego typu; nie zamieniono go na int z przykładu.

### getOrderPrintoutTemplates

Grupa indeksu: **Orders / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getOrderPrintoutTemplates).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `printouts` | `array` |
| out | `↳printout_id` | `int` |
| out | `↳name` | `text` |
| out | `↳file_format` | `text` |
| out | `↳language` | `text` |

Brak pól wejściowych; przykład `{}`. Odczytuje wszystkie skonfigurowane szablony i identyfikatory używane przy wykonaniu wydruku; sam niczego nie drukuje. PDF/HTML/XLS to przykłady `file_format`, nie zamknięte enum. Nie opisano paginacji, kolejności, domyślnego języka ani uprawnień do konkretnego szablonu.

### getOrderSources

Grupa indeksu: **Orders / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getOrderSources).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `sources` | `array` |
| out | `↳personal` | `array` |
| out | `↳shop` | `array` |
| out | `↳blconnect` | `array` |
| out | `↳allegro` | `array` |
| out | `↳ebay` | `array` |
| out | `↳amazon` | `array` |
| out | `↳amazon_vendor` | `array` |
| out | `↳order_return` | `array` |
| out | `↳[marketplace_code]` | `array` |

Brak pól wejścia; przykład `{}`. Kolekcje grupowane według typu odpowiadają `order_source` w `getOrders`. Dla personal/shop/blconnect/marketplace klucz jest identyfikatorem, wartość nazwą; nie podano typów tych kluczy/wartości jako osobnych pól. `order_return` opisuje zastąpienie klucza 0 identyfikatorem zwrotu. `[marketplace_code]` oznacza dynamiczną grupę, np. ceneo/emag, nie dosłowny stały klucz.

**Konflikt kształtu:** tabele nazywają kolekcje `array`, przykład pokazuje obiekty kluczowane, ale `order_return` jako listę. Nie normalizujemy ich do jednego modelu. Brak paginacji, pełnego enum marketplace i gwarancji stabilności źródeł.

### getOrderTransactionData

Grupa indeksu: **Orders / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getOrderTransactionData).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| in | `include_complex_taxes` | `bool` |
| in | `include_amazon_data` | `bool` |
| out | `status` | `varchar(30)` |
| out | `currency` | `char(3)` |
| out | `fulfillment_shipments` | `array` |
| out | `fulfillment_center_id` | `varchar(10)` |
| out | `ship_date_from` | `int` |
| out | `ship_date_to` | `int` |
| out | `delivery_date_from` | `int` |
| out | `delivery_date_to` | `int` |
| out | `marketplace_transaction_id` | `varchar(60)` |
| out | `account_id` | `int` |
| out | `transaction_date` | `int` |
| out | `order_items` | `array` |

`include_complex_taxes` jest opcjonalne, domyślnie false; `include_amazon_data` opcjonalne, domyślnie true. Required `order_id` nie oznaczono. Dane fulfillment są warunkowe dla Amazon, center dla Amazon Vendor; `order_items` tylko przy complex taxes.

**Konflikty:** opis flagi mówi `order_lines`, tabela/przykład `order_items`; center opisano jako zależne od przekazania Amazon flag, lecz przykład zwraca je przy false. Daty mają w tabeli `int`, przykład zawiera puste teksty. Nie rozstrzygnięto kontraktu konta.

Głębsze pola przykładu (bez zadeklarowanych typów): `order_items[].shipping.{netValue,taxValue,grossValue,currency,taxes}`, `shipping.taxes[].{code,value,rate}` oraz `order_items[].taxes[].{code,value,rate}`. Nie są normatywnymi wierszami tabeli ani podstawą reguł sumowania, waluty, VAT lub zaokrągleń. Brak paginacji i gwarancji księgowej zgodności.

Pola zagnieżdżone wymienione w **prozie komórki**, poza wierszami tabeli HTML:

| Ścieżka | Typ źródłowy |
|---|---|
| `fulfillment_shipments[].product_sku` | `varchar(40)` |
| `fulfillment_shipments[].product_name` | `varchar(200)` |
| `fulfillment_shipments[].quantity` | `int` |
| `fulfillment_shipments[].fba` | `varchar(10)` |
| `order_items[].itemId` | `varchar(50)` |
| `order_items[].outerItemId` | `varchar(51)` |
| `order_items[].shipping` | `object` |
| `order_items[].taxes` | `array` |

### getOrdersByEmail

Grupa indeksu: **Orders / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getOrdersByEmail).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `email` | `varchar(50)` |
| out | `status` | `varchar(30)` |
| out | `orders` | `array` |
| out | `↳order_id` | `int` |
| out | `↳order_status_id` | `int` |
| out | `↳date_in_status` | `int` |
| out | `↳date_add` | `int` |

Wyszukuje po adresie e-mail; opis wskazuje wtyczki pocztowe. Required, normalizacja, wielkość liter, limit, kolejność i paginacja nie są określone. Status pochodzi z `getOrderStatusList`, daty są Unix timestamps. **Konflikt typów:** tabela deklaruje cztery `int`, przykład zwraca je jako teksty; nie wymuszono konwersji.

### getOrdersByPhone

Grupa indeksu: **Orders / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=getOrdersByPhone).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `phone` | `varchar(50)` |
| out | `status` | `varchar(30)` |
| out | `orders` | `array` |
| out | `↳order_id` | `int` |
| out | `↳order_status_id` | `int` |
| out | `↳delivery_fullname` | `varchar(100)` |
| out | `↳delivery_company` | `varchar(100)` |
| out | `↳date_in_status` | `int` |
| out | `↳date_add` | `int` |

Wyszukuje po telefonie; opis wskazuje rozpoznawanie dzwoniącego. Nie określono required, normalizacji numeru/prefiksu, dopasowania, limitu ani paginacji. Zwraca również nazwę i firmę odbiorcy. **Konflikt typów:** tabela ma `int`, przykład miesza liczby/teksty dla ID i dat; zachowano typy tabeli oraz jawne zastrzeżenie.

### runOrderMacroTrigger

Grupa indeksu: **Orders / Other**. [Oficjalna strona](https://api.baselinker.com/index.php?method=runOrderMacroTrigger).

| Kierunek | Pole źródłowe | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| in | `trigger_id` | `int` |
| out | `status` | `varchar(30)` |

Uruchamia osobisty trigger automatycznych akcji dla zamówienia. Nie oznaczono required, uprawnień, synchronizacji wykonania, wyniku poszczególnych akcji ani idempotencji. Odpowiedź nie zawiera job/operation ID ani readback skutków. Przykład tekstowych ID nie zastępuje tabelarycznego `int`. Nie wolno utożsamić `SUCCESS` z ukończeniem wszystkich skutków automatyzacji ani automatycznie ponawiać po utracie odpowiedzi.

## Kontrola kompletności i granice odbioru

Niezależny parser DOM HTML porównuje każdą nazwę/typ z tabelami Markdown, zachowując `<br>`/`<li>` i strukturę wierszy. Osobno sprawdza13 pól z prozy, wszystkie14 odpowiedzi HTTP, bajty/SHA HTML i dokładny zestaw metod/grup indeksu. Liczniki nie zastępują porównania pól.

| Metoda | in | out | out zagnieżdżone w tabeli | zagnieżdżone z prozy |
|---|---:|---:|---:|---:|
| `addOrderProduct` | 16 | 2 | 0 | 0 |
| `deleteOrderProduct` | 2 | 1 | 0 | 0 |
| `setOrderProductFields` | 17 | 1 | 0 | 0 |
| `addOrderPickList` | 1 | 2 | 0 | 0 |
| `getOrderPickLists` | 2 | 9 | 7 | 0 |
| `getJournalList` | 3 | 7 | 5 | 0 |
| `getOrderExtraFields` | 0 | 6 | 4 | 0 |
| `getOrderPickPackHistory` | 2 | 2 | 0 | 5 |
| `getOrderPrintoutTemplates` | 0 | 6 | 4 | 0 |
| `getOrderSources` | 0 | 11 | 9 | 0 |
| `getOrderTransactionData` | 3 | 12 | 0 | 8 |
| `getOrdersByEmail` | 1 | 6 | 4 | 0 |
| `getOrdersByPhone` | 1 | 8 | 6 | 0 |
| `runOrderMacroTrigger` | 2 | 1 | 0 | 0 |
| **Razem** | 50 | 74 | 39 | 13 |

Dodatkowo28 wystąpień dwóch pól błędów w prozie (po2 na metodę); nie doliczono ich do tabel. Pola wyłącznie w przykładowym JSON transakcji są oznaczone jako przykład, nie pełny zadeklarowany schema.

Późniejszy odbiór wymaga zgodnych request/response fixtures i rzeczywistego readback, uprawnień/izolacji, walidacji granic1/100/101, konfliktów filtrów, nieznanego wyniku zapisu oraz kontroli skutków stock/finansów/automatyzacji. Katalog wydarzeń nie dowodzi obsługi eventów przez lokalne workers. Papierowa lista nie jest dowodem picking/packing/drukowania. Rzeczywiste zachowanie Base i niejednoznaczności wymagają odrębnej autoryzowanej próby konta; publiczna dokumentacja nie nadaje acceptance.
