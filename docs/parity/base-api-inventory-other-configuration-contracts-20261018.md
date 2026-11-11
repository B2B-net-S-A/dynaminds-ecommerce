# API Base — grupy cenowe, dostawcy, płatnicy i tagi

**Dokumentacja, nie implementacja.** 12 metod z indeksu 204 zamrożonego 17.10.2026: Product catalog / Price groups (3), Suppliers (3), Payers (3), Tags (3). Indywidualne strony pobrano 18.10 jako osobne uzupełnienie; nie zmieniono starszych snapshotów, indeksu ani centralnej matrycy.

`documentation_only=true`, `official_account_requests_performed=false`, `implementation_verified=false`, `wire_acceptance=false`, `provider_account_acceptance=false`, `acceptance_granted=false`.

## Źródła i data

[Snapshot HTML](base-api-inventory-other-configuration-sources-20261018.json.gz): 12 oficjalnych publicznych GET, wszystkie HTTP 200. Zapisano final URL, HTML UTF-8 i jego bajty/SHA256, datę pobrania oraz dostępne HTTP Date/ETag/Last-Modified. Nie użyto konta, tokenu, cookies konta ani connector.php; skrypty stron nie były wykonywane. Odczyt **2026-10-18T01:09:57.952748+00:00 → 2026-10-18T01:09:59.017168+00:00**, nie deklarowana publikacja ani retroaktywny dowód treści z 17.10.

- Gzip 120069 B; SHA256 `f3c578d2e64c63b82287d23094fc7efa7cdfc29a9ac386484fd2da6189aaa412`.
- JSON 687289 B; SHA256 `4ef079ded221e5758f08eb5ec95fefdcbed58e545c16794ba69b27a68c3b5f1c`.
- Indeks JSON 17.10 SHA256 `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`.

Czytnik WWW otworzył 10 stron; addInventoryTag i deleteInventoryTag były dla niego niedostępne bez ujawnionego statusu HTTP. Osobny GET publicznych oficjalnych URL zwrócił HTTP 200 dla wszystkich12; bundle rozróżnia obie obserwacje.

| Metoda | HTML B | SHA256 HTML UTF-8 |
|---|---:|---|
| `addInventoryPriceGroup` | 51439 | `c54971e84cb5e3ea1ce70e92d6cd5a940a5a7891ee0d83fe3fc2e4665db2919a` |
| `deleteInventoryPriceGroup` | 48588 | `ffc5ed01685239cf647e38a50a67edaf788b496ee236d4f79c970f65b018508f` |
| `getInventoryPriceGroups` | 51505 | `38ddc8d0b892f1033c396f55977bcddfe60afb2bb73383d330812280e337cde5` |
| `addInventorySupplier` | 51555 | `3ea389d0a727e9d6510d916541c703768fa0d1f0e2801a2e27601ba326f2005a` |
| `deleteInventorySupplier` | 48567 | `c0dcd8e99afdf1e1d1bdcf1ccaba10a36a783bf56954f4eb035aad3061b87fa7` |
| `getInventorySuppliers` | 51185 | `863156078d93110e6cb322cb7f400acc77b7d5f76038b4718500546144ee3d10` |
| `addInventoryPayer` | 49728 | `58f65cc533ddd4a03c328354ba39e1ef1f0cfe0c08d3a4c85d45d1b2cebbbc57` |
| `deleteInventoryPayer` | 48543 | `ca18fe089613440d0becc1eb27e6f7af2d4336fce01917d5f79aa4ee07e46326` |
| `getInventoryPayers` | 50209 | `4eb4b1ac73cbf8b2c962e3af3aa513c03b32f79f6367d903985099731845cb02` |
| `addInventoryTag` | 48986 | `79e3242f63f3b26ff8cf5b4bf8109b32cd58b2c49da448a04e3dde6dff2a0715` |
| `deleteInventoryTag` | 48716 | `d63dd51a0cc1740279c231f74647aa6d8a24faceee097af56189f4f5b7c8a84d` |
| `getInventoryTags` | 48904 | `cd2f6ffff3bfdf1bfb5944b1010f83ac53d4a17058c710bd89aca4234b56cc97` |

## Wspólna koperta, błędy i typy

Przykłady wskazują POST https://api.baselinker.com/connector.php z nagłówkiem X-BLToken oraz formularzem method + parameters (JSON). Nie testowano tej transmisji. Wszystkie metody zwracają status: varchar(30), SUCCESS/ERROR; proza wymienia error_message/error_code bez ich typów, katalogu kodów i mapowania HTTP. Nie zakładamy pól sukcesu przy błędzie.

Poniżej wszystkie pola tabel, także nested; [] oznacza element kolekcji. Brak osobnej flagi required nie dowodzi optional. Pustej tabeli input nie zastępujemy nowymi parametrami. Zachowano literalne char/varchar/text/float/bool; float nie określa precyzji/zaokrągleń. Optional nie oznacza null ani pustego stringa. Żadna z12 stron nie opisuje paginacji, limitów szybkości, idempotency key ani bezpiecznego retry; nie dopisujemy wspólnego mechanizmu.

## Kontrakty metod

### addInventoryPriceGroup

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryPriceGroup).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `price_group_id` | `int` |
| in | `name` | `varchar(100)` |
| in | `description` | `text` |
| in | `currency` | `char(3)` |
| in | `price_group_type` | `text` |
| in | `source_price_group_id` | `int` |
| in | `price_multiplier` | `float` |
| in | `price_addition` | `float` |
| in | `is_bundle_price_calculated` | `bool` |
| in | `bundle_price_multiplier` | `float` |
| in | `bundle_price_addition` | `float` |
| out | `status` | `varchar(30)` |
| out | `price_group_id` | `int` |

Tworzy grupę, jeśli price_group_id pominięto lub wynosi 0; ID>0 oznacza aktualizację. Grupę można później przypisać przez addInventory. currency to trzy litery (char(3)). price_group_type: standard (domyślny; ręczne ceny produktów), dependent_on_price_group (cena z grupy źródłowej, source_price_group_id wymagane), dependent_on_average_cost (średni koszt zakupu). price_multiplier domyślnie 1; price_addition domyślnie 0, może być ujemne, dodawane po mnożniku. is_bundle_price_calculated steruje wyliczeniem zestawu ze składników; bundle_price_multiplier=1 i bundle_price_addition=0 to udokumentowane defaulty. Brak default boola/flag optional pozostałych pól. Nieznane: graf zależności/cykle, FX, VAT/netto, dokładne zaokrąglenia i minima, koszt przy braku historii, moment przeliczeń oraz semantyka pominięcia pól przy update.

### deleteInventoryPriceGroup

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=deleteInventoryPriceGroup).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `price_group_id` | `int` |
| out | `status` | `varchar(30)` |

Usuwa wskazaną grupę cenową; wynik tylko status. Nie opisano zakazu usunięcia grupy domyślnej/zależnej, propagacji do produktów/katalogów/dostawców, historycznych cen, odpowiedzi not-found i ponowienia. Brak dowodu usunięcia cen lub zastąpienia ich inną grupą.

### getInventoryPriceGroups

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryPriceGroups).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `price_groups` | `array` |
| out | `price_groups[].price_group_id` | `int` |
| out | `price_groups[].name` | `varchar(100)` |
| out | `price_groups[].description` | `text` |
| out | `price_groups[].currency` | `char(3)` |
| out | `price_groups[].is_default` | `bool` |
| out | `price_groups[].price_group_type` | `text` |
| out | `price_groups[].source_price_group_id` | `int` |
| out | `price_groups[].price_multiplier` | `float` |
| out | `price_groups[].price_addition` | `float` |
| out | `price_groups[].is_bundle_price_calculated` | `bool` |
| out | `price_groups[].bundle_price_multiplier` | `float` |
| out | `price_groups[].bundle_price_addition` | `float` |

Tabela wejściowa: brak pól; przykład używa `{}`.

Brak parametrów wejścia w tabeli. is_default wskazuje grupę domyślną. source_price_group_id=0, gdy typ nie jest dependent_on_price_group; standard ma price_multiplier=1 i price_addition=0. Gdy wyliczanie zestawów wyłączone, bundle_price_multiplier=1 i bundle_price_addition=0. Zachowano text dla typu i float dla mnożników/dodatków. Nieznane: paginacja/limit/kolejność, zakres katalogów i unikalność domyślnej, nullowalność, wybór FX oraz readback wszystkich ustawień po zapisie.

### addInventorySupplier

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventorySupplier).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `supplier_id` | `int` |
| in | `name` | `varchar(40)` |
| in | `take_product_cost_from` | `varchar(20)` |
| in | `take_product_code_from` | `varchar(20)` |
| in | `address` | `varchar(200)` |
| in | `postcode` | `varchar(20)` |
| in | `city` | `varchar(80)` |
| in | `phone` | `varchar(40)` |
| in | `email` | `varchar(200)` |
| in | `email_copy_to` | `varchar(200)` |
| in | `currency` | `varchar(3)` |
| in | `tax_no` | `varchar(16)` |
| out | `status` | `varchar(30)` |
| out | `supplier_id` | `int` |

supplier_id opcjonalne: podane aktualizuje; bez niego dodaje. name wymagane przy tworzeniu, pominięte przy update pozostaje bez zmian. take_product_cost_from: "cost" albo ID grupy z getInventoryPriceGroups; take_product_code_from: "sku", "ean", "code" albo ID extra field z getInventoryExtraFields. Oba selektory są varchar(20), nie int mimo odwołania do ID; brak jawnego required/default. Adres, postcode, city, phone, email, email_copy_to, currency i tax_no opcjonalne; currency to domyślna waluta dostawcy. Nieznane: zapis ID w stringu, czyszczenie innych pominiętych pól, format wielu emaili, walidacja podatkowa, brak wskazanej grupy i idempotencja create.

### deleteInventorySupplier

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=deleteInventorySupplier).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `supplier_id` | `int` |
| out | `status` | `varchar(30)` |

Usuwa wskazanego dostawcę. Nie opisano zachowania przy istniejących zakupach, produktach dostawcy, historii kosztowej, usuwania powiązań, not-found ani powtórzeń. Brak podstaw do kaskadowego usuwania historycznych dokumentów.

### getInventorySuppliers

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventorySuppliers).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `filter_id` | `int` |
| in | `filter_name` | `varchar(40)` |
| out | `status` | `varchar(30)` |
| out | `suppliers` | `array` |
| out | `suppliers[].supplier_id` | `int` |
| out | `suppliers[].name` | `varchar(40)` |
| out | `suppliers[].address` | `varchar(200)` |
| out | `suppliers[].postcode` | `varchar(20)` |
| out | `suppliers[].city` | `varchar(80)` |
| out | `suppliers[].phone` | `varchar(40)` |
| out | `suppliers[].email` | `varchar(200)` |
| out | `suppliers[].email_copy_to` | `varchar(200)` |
| out | `suppliers[].currency` | `varchar(3)` |
| out | `suppliers[].tax_no` | `varchar(16)` |

filter_id i filter_name opcjonalne; nazwa dopuszcza pełne lub częściowe dopasowanie. W wynikach address/postcode/city/phone/email/email_copy_to/currency/tax_no są oznaczone optional; supplier_id i name nie. tax_no ma varchar(16), inaczej niż płatnik. Brak selektorów take_product_cost_from/take_product_code_from w tabeli wyniku — nie dopisujemy ich jako potwierdzonego readback. Nieznane: łączenie filtrów/case/Unicode, paginacja/limit/sortowanie oraz brak/null/pusty string.

### addInventoryPayer

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryPayer).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `payer_id` | `int` |
| in | `name` | `varchar(40)` |
| in | `address` | `varchar(200)` |
| in | `postcode` | `varchar(20)` |
| in | `city` | `varchar(80)` |
| in | `tax_no` | `varchar(40)` |
| out | `status` | `varchar(30)` |
| out | `payer_id` | `int` |

payer_id opcjonalne: podane aktualizuje, bez niego nowy płatnik. name wymagane przy tworzeniu, pominięte przy update zachowuje dotychczasową nazwę. address/postcode/city/tax_no opcjonalne; tax_no varchar(40), nie dostawcowe varchar(16). Nieznane: zerowe/nieistniejące ID, czyszczenie pól, kraj/format podatkowy, unikalność nazwy i retry. Konfiguracja płatnika sama nie wykonuje płatności ani rozliczenia.

### deleteInventoryPayer

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=deleteInventoryPayer).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `payer_id` | `int` |
| out | `status` | `varchar(30)` |

Usuwa wskazanego płatnika; wynik tylko status. Nie opisano zachowania dla płatnika przypisanego do zakupu, historii dokumentów, powiązań podatkowych, not-found ani powtórnego usunięcia. Nie domniemywamy anulowania lub kasowania płatności.

### getInventoryPayers

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryPayers).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `filter_id` | `int` |
| in | `filter_name` | `varchar(40)` |
| out | `status` | `varchar(30)` |
| out | `payers` | `array` |
| out | `payers[].payer_id` | `int` |
| out | `payers[].name` | `varchar(40)` |
| out | `payers[].address` | `varchar(200)` |
| out | `payers[].postcode` | `varchar(20)` |
| out | `payers[].city` | `varchar(80)` |
| out | `payers[].tax_no` | `varchar(40)` |

filter_id i filter_name opcjonalne; nazwa dopuszcza pełne lub częściowe dopasowanie. Zwracane dane adresowe i tax_no są optional; ID/nazwa nie mają tego oznaczenia. Nie opisano strony/kursora, limitu, kolejności, kombinacji filtrów, dopasowania bez rozróżniania wielkości liter ani reprezentacji nieustawionych pól.

### addInventoryTag

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryTag).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `tag_id` | `int` |
| in | `name` | `varchar(25)` |
| out | `status` | `varchar(30)` |
| out | `tag_id` | `int` |

Powtórne podanie tag_id aktualizuje tag; dla nowego ID pozostawia się puste lub ustawia 0. Nie utożsamiamy nieprecyzyjnego "blank" z potwierdzonym JSON null albo pustym stringiem przy tabelarycznym int. name musi być unikalne w obrębie konta, maksymalnie 25 znaków. Nieznane: normalizacja/case/Unicode, zachowanie istniejących przypisań przy rename, konflikt nazwy, cudzy/nieistniejący ID i idempotencja create.

### deleteInventoryTag

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=deleteInventoryTag).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `tag_id` | `int` |
| out | `status` | `varchar(30)` |

Usunięcie tagu automatycznie odpina go od WSZYSTKICH przypisanych produktów; źródłem ID jest getInventoryTags. Nie jest to operacja usunięcia produktów. Nieznane: atomowość odpinania, zachowanie historii/aktywnych procesów, uprawnienia na pełny zbiór, not-found i powtórzenie po utracie ACK.

### getInventoryTags

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryTags).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `tags` | `array` |
| out | `tags[].tag_id` | `int` |
| out | `tags[].name` | `varchar(25)` |

Tabela wejściowa: brak pól; przykład używa `{}`.

Brak parametrów w tabeli; zwraca listę tag_id/name dla katalogu Base. Brak inventory_id w sygnaturze: nie dopisujemy domyślnego katalogu ani zakresu filtrowania. Nieznane: strona/limit/kolejność, stan przy pustej liście i zakres konta wobec katalogu.

## Weryfikacja pokrycia i odbiór

| Metoda | input top-level | output top-level | nested tabelaryczne |
|---|---:|---:|---:|
| `addInventoryPriceGroup` | 11 | 2 | 0 |
| `deleteInventoryPriceGroup` | 1 | 1 | 0 |
| `getInventoryPriceGroups` | 0 | 2 | 12 |
| `addInventorySupplier` | 12 | 2 | 0 |
| `deleteInventorySupplier` | 1 | 1 | 0 |
| `getInventorySuppliers` | 2 | 2 | 10 |
| `addInventoryPayer` | 6 | 2 | 0 |
| `deleteInventoryPayer` | 1 | 1 | 0 |
| `getInventoryPayers` | 2 | 2 | 6 |
| `addInventoryTag` | 2 | 2 | 0 |
| `deleteInventoryTag` | 1 | 1 | 0 |
| `getInventoryTags` | 0 | 2 | 2 |

Łącznie **39 input top-level / 20 output top-level / 30 nested tabelarycznych**, bez dodatkowych typed nested pól z prozy; 24 wzmianki nazw błędów. Osobny checker event-DOM, bez importowania generatora, porównuje pełne kierunek/ścieżka/typ w HTML z Markdown i sprawdza12 SHA/bajtów/URL/HTTP/dat/grup indeksu. Prozę/defaulty i rozbieżności sprawdzono oddzielnie.

Odbiór wymaga osobnych rzeczywistych procesów UI/API: create/update/delete i odczytu dokładnych ustawień, zależności cen/FX/zaokrągleń/zestawów, zachowania historii zakupów po zmianach konfiguracji, unikalności/odpięcia tagów, current IAM/izolacji oraz utraty ACK i współbieżności. Tabele dokumentacji nie są działającym adapterem ani dowodem konta dostawcy lub wire compatibility.
