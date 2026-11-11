# Base API: kontrakty 21 metod Order returns

Stan dokumentacji: 17.10.2026. Pobranie indywidualnych stron: 2026-10-17T17:55:52.930924+00:00–2026-10-17T17:55:55.890599+00:00. Pełne URL, daty, SHA256 i typy pól zapisano w [JSON](base-api-return-contracts.v1.json).

To przegląd oficjalnej dokumentacji i źródeł lokalnego kodu. **Zero wywołań konta dostawcy; brak odbioru implementacji lub parytetu.** Zakres scope.v2 nie został zmieniony.

Źródła: 21 stron GET 200, jeden gzip 211873 B, SHA256 `59834def63733ad30e74b98cfa3c2d2e562b1dbde1fdbe9035bd7c18875baae6`. Źródła: [publiczny snapshot gzip](base-api-return-sources-20261017.json.gz). Manifest SHA256 `0fd7cd609ae02b8193b58220f3be8c3b6841138f3bca143d940125f863ec985b`. Każda strona ma osobny hash surowego HTML.

`!` = jawnie wymagane, `?` = pomijalne według opisu/przykładu, `·` = wymagalność niejednoznaczna. Pola nieoznaczone optional nie są automatycznie wymagane: np. getOrderReturns zawiera filtry, których poprawny przykład nie przesyła.

Wspólne przykłady opisują POST connector.php, nagłówek X-BLToken i pola method/parameters. Odpowiedź używa SUCCESS/ERROR i error_code/error_message; indywidualne kody, HTTP statusy i gwarancje retry/idempotencji pozostają nieopisane. To nie upoważnia do ślepego ponawiania zapisów.

## Najważniejsze rozbieżności

- setOrderReturnRefund zapisuje deklarację i **zastępuje** kwotę; nie wykonuje transferu. Lokalny recordRefund ma odmienny wersjonowany kontrakt i kwoty w minor units.
- getOrderReturns zwraca maksymalnie 100 pozycji; stabilna reguła kolejnych stron nie została opisana. Lokalny after/timestamp/UUID nie jest tym samym kursorem.
- Status nagłówka, status produktu i status destinations to osobne pojęcia. Grupy, słowniki przyczyn, pola dodatkowe, batch statusy i osobiste makra wymagają odrębnego pokrycia.
- W getOrderReturns występują rozbieżności tabeli z przykładem dla refunded, danych konta refund i connect_data; nie rozstrzygamy ich przez zgadywanie.

## Metody

### [addOrderReturn](https://api.baselinker.com/index.php?method=addOrderReturn)

Wejście: `order_id:int`?, `status_id:int`·, `custom_source_id:int`?, `reference_number:varchar(100)`?, `date_add:int`·, `currency:char(3)`·, `refunded:bool`·, `admin_comments:varchar(200)`·, `email:varchar(150)`·, `phone:varchar(100)`·, `user_login:varchar(30)`·, `delivery_price:float`·, `delivery_fullname:varchar(100)`·, `delivery_company:varchar(100)`·, `delivery_address:varchar(100)`·, `delivery_postcode:varchar(100)`·, `delivery_city:varchar(100)`·, `delivery_state:varchar(20)`·, `delivery_country_code:char(2)`·, `extra_field_1:varchar(50)`·, `extra_field_2:varchar(50)`·, `custom_extra_fields:array`·, `products:array`·, `refund_account_number:varchar(50)`·, `refund_iban:varchar(34)`·, `refund_swift:varchar(11)`·.

Wynik: `status:varchar(30)`, `return_id:int`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- custom_source_id pominięty: domyślne źródło zwrotu.
- products[].storage: db/shop/warehouse; storage_id=0 oznacza własny magazyn Base.
- Puste product_id/variant_id oznaczają nieznany identyfikator; warehouse_id i status_id mogą pochodzić z domyślnej konfiguracji.
- custom_extra_fields: mapa ID→wartość; pusty string usuwa wartość; plik title≤40 znaków, body w formacie data:, limit 2 MB.
- tax_rate: 0–100 oraz wyjątki −1,−0.02,−0.03; refunded=1 oznacza już zrefundowany zwrot.
- Niejednoznaczność dokumentacji: Wariant ma typ int tutaj, lecz varchar(30) w metodach produktu i w odpowiedzi getOrderReturns.
- Niejednoznaczność dokumentacji: Brak jawnej deklaracji required dla wielu pól; nie wnioskować jej wyłącznie z braku słowa optional.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-routes.ts:80](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:80>), [server/returns.ts:32](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:32>). Lokalne ścieżki: `POST /api/orders/:id/returns`.

- Luka: Lokalny zwrot wymaga powiązanego zamówienia UUID, client_key, reason i istniejących item_id; Base dopuszcza brak order_id i podaje rozbudowane pola kupującego/źródła/produktu.
- Luka: Nie potwierdzono importu ani mapowania liczbowych Base return_id/status_id do lokalnych identyfikatorów.

Źródło SHA256: `cc6fdfd5d9db7f819f0acda8b48e146b747e5b143232703ef385281389edbee3`; pobrano 2026-10-17T17:55:53.065341+00:00.

### [getOrderReturnExtraFields](https://api.baselinker.com/index.php?method=getOrderReturnExtraFields)

Wejście: brak parametrów metody w tabeli.

Wynik: `status:varchar(30)`, `extra_fields:array`, `extra_fields[].extra_field_id:int`, `extra_fields[].name:text`, `extra_fields[].editor_type:text`, `extra_fields[].options:array`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Edytory: text, number, select, checkbox, radio, date, file.
- options dotyczy select/checkbox/radio; definicje nie są wartościami zwrotu.
- Niejednoznaczność dokumentacji: Opis mówi o kluczowanej mapie ID pola do definicji, przykład pokazuje listę obiektów; kształt kolekcji wymaga potwierdzenia.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-routes.ts:1](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:1>), [server/returns.ts:32](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:32>). Nie wskazano zgodnej ścieżkiREST.

- Luka: Nie znaleziono dedykowanego słownika dodatkowych pól zwrotów w przejrzanych modułach RMA.
- Luka: Pola dodatkowe zamówień nie dowodzą konfigurowalnych pól zwrotów, typów edytora ani plików.

Źródło SHA256: `bc2a15f3b61b6885a91a9e93829e58008034633cbc172f7e5e7542102258fd3f`; pobrano 2026-10-17T17:55:52.930924+00:00.

### [getOrderReturns](https://api.baselinker.com/index.php?method=getOrderReturns)

Wejście: `order_id:int`?, `return_id:int`?, `date_from:int`·, `id_from:int`?, `status_id:int`?, `filter_order_return_source:varchar(20)`?, `filter_order_return_source_id:int`?, `include_custom_extra_fields:bool`?, `include_connect_data:bool`?.

Wynik: `status:varchar(30)`, `returns:array`, `returns[].return_id:int`, `returns[].order_id:int`, `returns[].shop_order_id:int`, `returns[].external_order_id:varchar(50)`, `returns[].reference_number:varchar(100)`, `returns[].order_return_source:varchar(20)`, `returns[].order_return_source_id:int`, `returns[].status_id:int`, `returns[].date_add:int`, `returns[].date_in_status:int`, `returns[].user_login:varchar(100)`, `returns[].currency:char(3)`, `returns[].refunded:char(3)`, `returns[].email:varchar(150)`, `returns[].phone:varchar(100)`, `returns[].delivery_price:float`, `returns[].delivery_fullname:varchar(100)`, `returns[].delivery_company:varchar(100)`, `returns[].delivery_address:varchar(100)`, `returns[].delivery_postcode:varchar(100)`, `returns[].delivery_city:varchar(100)`, `returns[].delivery_state:varchar(20)`, `returns[].delivery_country:varchar(50)`, `returns[].delivery_country_code:char(2)`, `returns[].extra_field_1:varchar(50)`, `returns[].extra_field_2:varchar(50)`, `returns[].custom_extra_fields:array`, `returns[].admin_comments:varchar(200)`, `returns[].delivery_package_module:varchar(20)`, `returns[].delivery_package_nr:varchar(40)`, `returns[].connect_data:array`, `returns[].products:array`, `returns[].order_return_account_number:varchar(50)`, `returns[].order_return_iban:varchar(34)`, `returns[].order_return_swift:varchar(11)`, `returns[].fulfillment_status:int`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Maksimum100 zwrotów w odpowiedzi.
- filter_order_return_source_id wymaga filter_order_return_source; samo source_id nie ma globalnej unikalności.
- include_custom_extra_fields i include_connect_data domyślnie false.
- products[].order_product_id=0: brak powiązania z pozycją pierwotnego zamówienia; bundle_id=0: brak pochodzenia z rozbicia zestawu.
- fulfillment_status:0 active,5 accepted,1 done,2 canceled.
- Plik dodatkowy zwracany jako title/url, nie body.
- Niejednoznaczność dokumentacji: Pole refunded opisano jako char(3), przykład ma wartość0.00; znaczenie/typ wymagają potwierdzenia.
- Niejednoznaczność dokumentacji: Tabela podaje order_return_account_number/order_return_iban/order_return_swift, przykład JSON używa refund_account_number/refund_iban/refund_swift.
- Niejednoznaczność dokumentacji: connect_data opisano jako array, przykład przedstawia obiekt; zachowano tę niejednoznaczność.

Paginacja: {"documented":true,"max_items":100,"parameters":["date_from","id_from"],"next_cursor_field":null,"unknown":["Inkluzywność date_from/id_from, stabilne sortowanie, reguła kolejnej strony i zachowanie remisów nie są opisane."]}.

Kod powiązany: [server/return-routes.ts:61](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:61>), [server/return-query.ts:11](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-query.ts:11>). Lokalne ścieżki: `GET /api/returns`, `GET /api/orders/:id/returns`, `GET /api/returns/:id`.

- Luka: Lokalny limit/after i kursor timestamp+UUID różnią się od Base date_from/id_from i odpowiedzi returns.
- Luka: Nie potwierdzono filtrów źródła, Base Connect ani pełnego zestawu pól odpowiedzi Base.

Źródło SHA256: `58042d5b838ba07c5abfe9cc4b7871da4a0a9c981a681cc4ad0d9790ecf40e92`; pobrano 2026-10-17T17:55:53.150232+00:00.

### [setOrderReturnFields](https://api.baselinker.com/index.php?method=setOrderReturnFields)

Wejście: `return_id:int`!, `admin_comments:varchar(200)`?, `email:varchar(150)`?, `phone:varchar(100)`?, `user_login:varchar(30)`?, `delivery_price:float`?, `delivery_fullname:varchar(100)`?, `delivery_company:varchar(100)`?, `delivery_address:varchar(100)`?, `delivery_postcode:varchar(100)`?, `delivery_city:varchar(100)`?, `delivery_state:varchar(100)`?, `delivery_country_code:char(2)`?, `extra_field_1:varchar(50)`?, `extra_field_2:varchar(50)`?, `custom_extra_fields:array`?.

Wynik: `status:varchar(30)`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Patch: tylko przesłane pola są zmieniane; pominięte zachować.
- custom_extra_fields: pusty string usuwa wartość; plik title≤40 znaków, body data:, limit 2 MB.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-routes.ts:1](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:1>), [server/returns.ts:32](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:32>). Nie wskazano zgodnej ścieżkiREST.

- Luka: W przejrzanym module brak ogólnego patch nagłówka zwrotu odpowiadającego temu kontraktowi.
- Luka: Nie mapować tego wywołania na decyzję/przyjęcie zwrotu: to inne operacje.

Źródło SHA256: `6a61bcbf4f122b1350ed0f4a6dc885adc6a5594c59badcb1756b4ce318db75e6`; pobrano 2026-10-17T17:55:52.931303+00:00.

### [addOrderReturnProduct](https://api.baselinker.com/index.php?method=addOrderReturnProduct)

Wejście: `return_id:int`!, `order_product_id:int`?, `storage:varchar(9)`?, `storage_id:varchar(50)`?, `product_id:varchar(50)`?, `variant_id:varchar(30)`?, `auction_id:varchar(20)`?, `name:varchar(200)`?, `sku:varchar(50)`?, `ean:varchar(32)`?, `location:varchar(50)`?, `warehouse_id:int`?, `attributes:varchar(350)`?, `price_brutto:float`?, `tax_rate:float`?, `quantity:int`?, `weight:decimal(10,2)`?, `status_id:int`?, `return_reason_id:int`?.

Wynik: `status:varchar(30)`, `order_return_product_id:int`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- return_id jest jedynym jawnie wymaganym polem; dokumentacja określa pozostałe jako opcjonalne.
- storage:db/shop/warehouse; warehouse_id domyślnie z istniejących produktów zwrotu, następnie ze źródła zwrotu.
- status_id domyślnie z ustawień użytkownika; tax_rate ma wyjątki −1/−0.02/−0.03.
- Niejednoznaczność dokumentacji: storage_id i variant_id opisano jako varchar, przykład przesyła liczby; nie zakładamy reguł konwersji JSON.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/returns.ts:32](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:32>), [server/return-routes.ts:80](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:80>). Lokalne ścieżki: `POST /api/orders/:id/returns`.

- Luka: Lokalne pozycje są częścią żądania utworzenia RMA; brak potwierdzonego późniejszego dodania dowolnej pozycji do istniejącego zwrotu.
- Luka: Base przechowuje własne metadane SKU/ceny/źródła; lokalna pozycja referencjonuje istniejący item_id.

Źródło SHA256: `ee1b4063ef03188c76746b3769489838cda65ed93c3c20cd13ff7763f18ad85b`; pobrano 2026-10-17T17:55:53.368997+00:00.

### [deleteOrderReturnProduct](https://api.baselinker.com/index.php?method=deleteOrderReturnProduct)

Wejście: `return_id:int`·, `order_return_product_id:int`·.

Wynik: `status:varchar(30)`. Zagnieżdżone pola produktów/Connect zapisano w JSON.


Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-routes.ts:1](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:1>), [server/returns.ts:32](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:32>). Nie wskazano zgodnej ścieżkiREST.

- Luka: Nie znaleziono endpointu usunięcia jednej pozycji istniejącego RMA w przejrzanych routes.
- Luka: Usunięcie danych nie może omijać istniejących rezerwacji, audytu i skutków fizycznych.

Źródło SHA256: `3854be9702f18b0c9a05d7613182f1e7a47a6d6d969739ee57c450662a99b399`; pobrano 2026-10-17T17:55:53.394172+00:00.

### [setOrderReturnProductFields](https://api.baselinker.com/index.php?method=setOrderReturnProductFields)

Wejście: `return_id:int`!, `order_return_product_id:int`!, `storage:varchar(9)`?, `storage_id:varchar(50)`?, `product_id:varchar(50)`?, `variant_id:varchar(30)`?, `auction_id:varchar(20)`?, `name:varchar(200)`?, `sku:varchar(50)`?, `ean:varchar(32)`?, `location:varchar(50)`?, `warehouse_id:int`?, `attributes:varchar(350)`?, `price_brutto:float`?, `tax_rate:float`?, `quantity:int`?, `weight:decimal(10,2)`?, `status_id:int`?, `return_reason_id:int`?.

Wynik: `status:varchar(30)`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Patch zachowuje pominięte pola; wymagane return_id i order_return_product_id.
- storage:db/shop/warehouse; tax_rate ma wyjątki −1/−0.02/−0.03.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-routes.ts:1](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:1>), [server/returns.ts:44](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:44>). Nie wskazano zgodnej ścieżkiREST.

- Luka: Przyjęcie accepted/restocked to proces fizyczny, nie dowód edycji ceny/SKU/quantity/status_id/reason_id pojedynczej pozycji.
- Luka: Nie potwierdzono zgodnego PATCH pozycji ani zachowania pominiętych pól.

Źródło SHA256: `cb4fa86f104b1e08acc671027059c93d70f61286a39c567679b55145150965ed`; pobrano 2026-10-17T17:55:54.551576+00:00.

### [addOrderReturnStatus](https://api.baselinker.com/index.php?method=addOrderReturnStatus)

Wejście: `status_id:int`?, `name:varchar(100)`·, `name_for_customer:text`?, `color:varchar(7)`·, `group_id:int`?.

Wynik: `status:varchar(30)`, `status_id:int`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- status_id podany: update; pusty/pominięty:create.
- Nowy status na końcu swojej grupy; color ma format #RRGGBB.
- name_for_customer: zwykły tekst albo JSON-encoded string mapa języków; łączny serialized JSON ≤1000 znaków; create bez wartości używa name.
- group_id pominięty:create do głównej grupy, update zachowuje istniejącą.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-destination-statuses-routes.ts:7](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-destination-statuses-routes.ts:7>), [server/return-destination-statuses-schema.ts:20](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-destination-statuses-schema.ts:20>). Lokalne ścieżki: `POST /api/return-assistant/statuses/previews`, `POST /api/return-assistant/statuses/previews/:id/commit`.

- Luka: Status destinations opisuje accept/reject i sale/custody/none; nie jest potwierdzonym odpowiednikiem statusu nagłówka Base.
- Luka: Brak potwierdzenia Base group_id, name_for_customer z językami, kolejności i create/update przez status_id.

Źródło SHA256: `65612b57998ef5c936319267067cf0dd93d55359914fd5265401ce3a5ec46051`; pobrano 2026-10-17T17:55:53.631642+00:00.

### [addOrderReturnStatusGroup](https://api.baselinker.com/index.php?method=addOrderReturnStatusGroup)

Wejście: `group_id:int`?, `name:varchar(15)`·.

Wynik: `status:varchar(30)`, `group_id:int`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- group_id podany:update; pusty/pominięty:create.
- name ma limit 15 znaków.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-destination-statuses-schema.ts:20](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-destination-statuses-schema.ts:20>). Nie wskazano zgodnej ścieżkiREST.

- Luka: Nie potwierdzono grup statusów zwrotów, main group ani upsert przez group_id.

Źródło SHA256: `94ff0ad14943ab0b73c5a33b5939507c0fd2c5ce8dae296e66d7422bc82924a1`; pobrano 2026-10-17T17:55:53.714660+00:00.

### [deleteOrderReturnStatus](https://api.baselinker.com/index.php?method=deleteOrderReturnStatus)

Wejście: `status_id:int`·, `target_status_id:int`·.

Wynik: `status:varchar(30)`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Wszystkie zwroty usuwanego statusu przechodzą do target_status_id; target różny od usuwanego.
- Nie można usunąć primary/default status.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-destination-statuses-routes.ts:7](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-destination-statuses-routes.ts:7>), [server/return-destination-statuses-schema.ts:20](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-destination-statuses-schema.ts:20>). Nie wskazano zgodnej ścieżkiREST.

- Luka: Nie potwierdzono usuwania statusu Base z atomową migracją wszystkich zwrotów do target_status_id i ochroną primary.
- Luka: Dezaktywacja lokalnego statusu destinations nie dowodzi tej semantyki.

Źródło SHA256: `e418f5bb445d5979dd6b16f49e1ee6403101c14edc814d4bf5f87e3e35dd583e`; pobrano 2026-10-17T17:55:53.750349+00:00.

### [deleteOrderReturnStatusGroup](https://api.baselinker.com/index.php?method=deleteOrderReturnStatusGroup)

Wejście: `group_id:int`·.

Wynik: `status:varchar(30)`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Statusy usuwanej grupy przenoszone do głównej; nie można usunąć głównej grupy.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-destination-statuses-schema.ts:20](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-destination-statuses-schema.ts:20>). Nie wskazano zgodnej ścieżkiREST.

- Luka: Nie potwierdzono grup, migracji statusów do main group ani zakazu usunięcia main group.

Źródło SHA256: `3f37924a995cd491a02ae57cdf9e3a0b9f816150a56bedf7cb9e616862f559f3`; pobrano 2026-10-17T17:55:54.241162+00:00.

### [getOrderReturnProductStatuses](https://api.baselinker.com/index.php?method=getOrderReturnProductStatuses)

Wejście: brak parametrów metody w tabeli.

Wynik: `status:varchar(30)`, `order_return_product_statuses:array`, `order_return_product_statuses[].status_id:int`, `order_return_product_statuses[].name:text`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Niejednoznaczność dokumentacji: Opis odsyła do setOrderReturnFields, chociaż ten nie dokumentuje statusu produktu; nie zakładać kompletności tego odnośnika.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-destination-statuses-routes.ts:26](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-destination-statuses-routes.ts:26>), [server/return-destination-statuses-schema.ts:20](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-destination-statuses-schema.ts:20>). Lokalne ścieżki: `GET /api/return-assistant/statuses`.

- Luka: Istnieje lista własnych statusów destinations; ich rola i UUID różnią się od słownika Base status_id/name.
- Luka: Wymagana jawna mapa semantyki i przypisania do pozycji, bez utożsamiania z nagłówkiem zwrotu.

Źródło SHA256: `3a2e9067d43f62fa35907e23b6feed5a1642de8c069a1d71bc0dc55e3a28e580`; pobrano 2026-10-17T17:55:54.396022+00:00.

### [getOrderReturnReasonsList](https://api.baselinker.com/index.php?method=getOrderReturnReasonsList)

Wejście: brak parametrów metody w tabeli.

Wynik: `status:varchar(30)`, `return_reasons:array`, `return_reasons[].return_reason_id:int`, `return_reasons[].name:text`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Niejednoznaczność dokumentacji: Opis odsyła do setOrderReturnFields, chociaż pola return_reason_id dokumentują metody produktu.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/returns.ts:37](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:37>). Nie wskazano zgodnej ścieżkiREST.

- Luka: Lokalne reason jest tekstem zgłoszenia; nie potwierdzono słownika return_reason_id/name.

Źródło SHA256: `82024d74d800667796805ad30932658e54b5d4271078962a0ca1cdb7a738933e`; pobrano 2026-10-17T17:55:54.248805+00:00.

### [getOrderReturnStatusGroups](https://api.baselinker.com/index.php?method=getOrderReturnStatusGroups)

Wejście: brak parametrów metody w tabeli.

Wynik: `status:varchar(30)`, `status_groups:array`, `status_groups[].group_id:int`, `status_groups[].name:text`, `status_groups[].is_main_group:int`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- is_main_group: 0/1.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-destination-statuses-schema.ts:20](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-destination-statuses-schema.ts:20>). Nie wskazano zgodnej ścieżkiREST.

- Luka: Nie potwierdzono słownika grup zwrotów z is_main_group.

Źródło SHA256: `09c28d79d4d0c91a218dd2312471d9809460e1a3d85c6884f1ab70d093b200e8`; pobrano 2026-10-17T17:55:54.607397+00:00.

### [getOrderReturnStatusList](https://api.baselinker.com/index.php?method=getOrderReturnStatusList)

Wejście: brak parametrów metody w tabeli.

Wynik: `status:varchar(30)`, `statuses:array`, `statuses[].id:int`, `statuses[].name:text`, `statuses[].color:text`, `statuses[].group_id:int`, `statuses[].is_primary:int`, `statuses[].name_for_customer:text`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- is_primary: 0/1; group_id odsyła do getOrderReturnStatusGroups.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-query.ts:14](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-query.ts:14>), [server/return-destination-statuses-schema.ts:20](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-destination-statuses-schema.ts:20>). Nie wskazano zgodnej ścieżkiREST.

- Luka: Stałe lokalne state oraz osobne statusy destinations nie dowodzą konfigurowalnego katalogu Base id/name/color/group_id/is_primary/name_for_customer.

Źródło SHA256: `97505346176d84250033cb907a1c975376bf65363b8c114468cda3213563a699`; pobrano 2026-10-17T17:55:54.596589+00:00.

### [setOrderReturnStatus](https://api.baselinker.com/index.php?method=setOrderReturnStatus)

Wejście: `return_id:int`·, `status_id:int`·.

Wynik: `status:varchar(30)`. Zagnieżdżone pola produktów/Connect zapisano w JSON.


Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-routes.ts:84](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:84>), [server/return-routes.ts:91](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:91>), [server/returns.ts:54](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:54>). Lokalne ścieżki: `POST /api/returns/:id/receive`, `POST /api/returns/:id/decision`.

- Luka: Lokalne przejścia są wersjonowanymi operacjami biznesowymi; nie potwierdzono dowolnego przypisania Base status_id.
- Luka: Nie wolno zakładać skutków fizycznych/refund tylko ze zmiany statusu Base.

Źródło SHA256: `84f540b19e0ff9b0b5874d39be540b19cfd33fef9cb2d92e4bbb1d54ae1d1493`; pobrano 2026-10-17T17:55:55.150647+00:00.

### [setOrderReturnStatuses](https://api.baselinker.com/index.php?method=setOrderReturnStatuses)

Wejście: `return_ids:array`·, `status_id:int`·.

Wynik: `status:varchar(30)`. Zagnieżdżone pola produktów/Connect zapisano w JSON.


Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-routes.ts:1](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:1>). Nie wskazano zgodnej ścieżkiREST.

- Luka: Nie potwierdzono operacji zbiorczej ani jej atomowości/odpowiedzi częściowej.

Źródło SHA256: `01d8189b8eca447f9265610fd397c044f668c63b74eeb39270ebf8c7360d7768`; pobrano 2026-10-17T17:55:55.890599+00:00.

### [getOrderReturnPaymentsHistory](https://api.baselinker.com/index.php?method=getOrderReturnPaymentsHistory)

Wejście: `return_id:int`·, `show_full_history:bool`?.

Wynik: `status:varchar(30)`, `payments:array`, `payments[].paid_before:float`, `payments[].paid_after:float`, `payments[].total_price:float`, `payments[].currency:text`, `payments[].external_payment_id:text`, `payments[].date:int`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- show_full_history domyślnie false: tylko wpisy zawierające external_payment_id; true obejmuje także zmiany wartości i ręczne edycje.
- Zwraca historię zapisów, bez dowodu wykonania refund przez dostawcę.
- Niejednoznaczność dokumentacji: Opis mówi o wybranym order, ale parametr to return_id; nie utożsamiać z historią płatności zamówienia bez potwierdzenia.
- Niejednoznaczność dokumentacji: Typy kwot/date w tabeli są float/int, przykład JSON zawiera stringi; reguły serializacji wymagają potwierdzenia.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/developer-api.ts:1184](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/developer-api.ts:1184>), [server/returns.ts:705](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:705>). Lokalne ścieżki: `GET /api/v1/orders/:id/payments`.

- Luka: Historia płatności zamówienia nie dowodzi historii zwrotu w kształcie paid_before/paid_after/total_price/external_payment_id.
- Luka: Brak potwierdzenia show_full_history i filtrowania wpisów bez identyfikatora zewnętrznego.

Źródło SHA256: `4a9152d4a4d44a1c2b9f8411b801a960fa41686933d0de07f4805f00f71e5157`; pobrano 2026-10-17T17:55:55.194552+00:00.

### [setOrderReturnRefund](https://api.baselinker.com/index.php?method=setOrderReturnRefund)

Wejście: `return_id:int`·, `order_refund_done:float`·, `refund_date:int`·, `refund_comment:varchar(50)`·, `external_refund_id:varchar(50)`?.

Wynik: `status:varchar(30)`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Wyłącznie deklaracja stanu refund, bez wykonania transferu pieniężnego.
- order_refund_done zastępuje bieżącą kwotę, nie sumuje; według opisu kwota zgodna z order value oznacza zrefundowanie; znaczenie order value wymaga potwierdzenia.
- refund_date:Unix timestamp; external_refund_id opcjonalny.
- Niejednoznaczność dokumentacji: Dokumentacja porównuje kwotę z order value; nie rozstrzygamy, czy chodzi o całe pierwotne zamówienie czy wartość konkretnego zwrotu.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/return-routes.ts:97](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-routes.ts:97>), [server/returns.ts:705](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:705>). Lokalne ścieżki: `POST /api/returns/:id/refund`.

- Luka: Lokalny recordRefund wymaga version/confirmed/reference, dokładnego salda i kwoty w minor units; dopisuje lokalną deklarację refund i zamyka stan.
- Luka: To nie jest potwierdzenie Base replacement semantics order_refund_done ani zgodności float/date/external_refund_id; żadna z tych metod sama nie dowodzi przelewu.

Źródło SHA256: `98b4488bfe626ec9d41180b81204e1c635f0f5f380e9cbb5b2e48b7f1e5cb09e`; pobrano 2026-10-17T17:55:55.096976+00:00.

### [getOrderReturnJournalList](https://api.baselinker.com/index.php?method=getOrderReturnJournalList)

Wejście: `last_log_id:int`·, `logs_types:array`·, `return_id:int`?.

Wynik: `status:varchar(30)`, `logs:array`, `logs[].id:int`, `logs[].return_id:int`, `logs[].log_type:int`, `logs[].object_id:int`, `logs[].date:int`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Okno historii: ostatnie 3 dni; last_log_id, logs_types i return_id są parametrami filtrowania.
- log_type: 1 utworzenie, 2 przyjęcie, 3 zakończenie, 4 anulowanie, 5 refund, 6 edycja dostawy, 7 dodanie produktu, 8 edycja produktu, 9 usunięcie produktu, 10 edycja zwrotu, 11 status nagłówka, 12 status pozycji.
- object_id podaje produkt dla 9 i paczkę dla 14/15; typy 14/15 nie są wyjaśnione w enum log_type tej strony.
- Niejednoznaczność dokumentacji: object_id opisuje typy 14/15, których brak w wyliczeniu log_type.
- Niejednoznaczność dokumentacji: Tabela nazywa klucz zdarzenia id, przykład JSON używa log_id; przykład zawiera też niewyjaśniony typ13.

Paginacja: {"documented":true,"history_window_days":3,"parameters":["last_log_id"],"max_items":null,"next_cursor_field":null,"unknown":["Limit odpowiedzi, inkluzywność last_log_id, sortowanie i reguła następnej strony nie są opisane."]}.

Kod powiązany: [server/return-assistant-routes.ts:21](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/return-assistant-routes.ts:21>), [server/app.ts:1480](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/app.ts:1480>), [server/returns.ts:182](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/returns.ts:182>). Lokalne ścieżki: `GET /api/return-assistant/history`, `GET /api/audit`.

- Luka: Audyt i historia Asystenta istnieją, ale nie potwierdzono 3-dniowego dziennika Base ani liczbowych log_type/object_id i last_log_id.

Źródło SHA256: `4b5a6c2a42d50b59fb33f3885cca3e9452560f74f7d6c829c5b282768830d187`; pobrano 2026-10-17T17:55:55.613648+00:00.

### [runOrderReturnMacroTrigger](https://api.baselinker.com/index.php?method=runOrderReturnMacroTrigger)

Wejście: `return_id:int`·, `trigger_id:int`·.

Wynik: `status:varchar(30)`. Zagnieżdżone pola produktów/Connect zapisano w JSON.

- Uruchamia osobisty trigger automatycznych akcji dla wskazanego zwrotu.

Paginacja: brak opisanego mechanizmu; kompletność/limit niepotwierdzone.

Kod powiązany: [server/automation-schedule-routes.ts:122](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/automation-schedule-routes.ts:122>), [server/automation-schedule-routes.ts:136](</Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/automation-schedule-routes.ts:136>). Lokalne ścieżki: `POST /api/automation-schedules/:id/preview`, `POST /api/automation-schedules/:id/run`.

- Luka: Uruchomienie własnego harmonogramu nie dowodzi osobistego trigger_id dla konkretnego return_id Base.
- Luka: Wymagane osobne sprawdzenie uprawnień, selekcji zwrotu, skutków i nieznanego wyniku.

Źródło SHA256: `10988a0d9d969dc28e29dc7153fec2cc337a9700e5b5527f4302918a0472b614`; pobrano 2026-10-17T17:55:55.736298+00:00.

## Warunki dalszego odbioru

Dla każdej metody oddzielnie:rozstrzygnąć pola niejednoznaczne i limity, uzgodnić mapę identyfikatorów/typów/kwot/statusów, zaimplementować zgodny kontrakt UI/API, sprawdzić sukces i błędy/izolację/revoke/duplikat/utraconyACK oraz uzgodnić skutki. Test protokołu lokalnego pozostaje osobny od autoryzowanego sandboxa i konta dostawcy. Zgodność dokumentacyjna nie zamyka tych wymagań.
