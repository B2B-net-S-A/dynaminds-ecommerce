# Kontrakty API Base — faktury, paragony i dokumenty magazynowe, wersja 1

Przegląd 17.10.2026 obejmuje **20 metod w trzech kompletnych grupach indeksu**: Orders / Invoices (6), Orders / Receipts (6), Product catalog / Documents (8). Nie obejmuje pozostałych grup Orders ani katalogu produktów. [JSON](base-api-document-contracts.v1.json) zawiera 89 wierszy wejścia, 156 wierszy wyniku oraz 30 pól wyniku wyrażonych w prozie, z osobnym wskazaniem miejsca źródłowego. Pola pokazane wyłącznie w przykładzie korekty nie zostały uznane za pełny schemat.

Publiczny [snapshot 20 stron](base-api-document-sources-20261017.json.gz): 203503 B, SHA256 `bc78d68758a8a990fdddd3134d3d0676ae75765fee9f75d3d54b91c4cbbb9fe7`. Każda metoda ma własny oficjalny URL, czas UTC, status HTTP, rozmiar i hash dokładnego HTML. Indeks SHA256 `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`. Wspólny przypięty indeks transportu został ponownie sprawdzony. Bez tokenów, żądań konta, SQL i zmian runtime/scope.

## Transport i zasady interpretacji

[Oficjalny indeks](https://api.baselinker.com/) opisuje POST connector.php, formularz method + parameters jako JSON, X-BLToken, UTF-8 i limit 100 żądań/min. Nie podano zakresu/algorytmu limitu ani retry. Każda metoda opisuje status SUCCESS/ERROR i przy błędzie error_message/error_code, bez metodycznych kodów błędów lub mapowania HTTP.

required:null oznacza brak formalnego oznaczenia; false wynika z jawnej opcjonalności/domyślności, true tylko z jawnego warunku. Nie zgadujemy null, nieznanych parametrów, domyślnych wartości, idempotencji ani kolejności walidacji. Opis każdego wiersza zachowano obok typu i numeru wiersza; pola z prozy mają odrębne source_kind.

## Zakres metod

| Grupa | Metoda | Kluczowa granica |
|---|---|---|
| Orders / Invoices | [addInvoice](https://api.baselinker.com/index.php?method=addInvoice) | Tworzy fakturę dla zamówienia i wskazanej serii. vat_rate=DEFAULT jest domyślne i używa ustawień serii; ITEM używa stawki pozycji zamówienia. |
| Orders / Invoices | [addInvoiceCorrection](https://api.baselinker.com/index.php?method=addInvoiceCorrection) | Wymagane original_invoice_id lub return_order_id. Gdy przekazano return_order_id, wszystkie pozostałe pola poza series_id są ignorowane, a dane pochodzą ze zwrotu. Nie zastępujemy tej reguły pierwszeństwa własną. |
| Orders / Invoices | [addOrderInvoiceFile](https://api.baselinker.com/index.php?method=addOrderInvoiceFile) | Zastępuje standardowy plik wcześniej wystawionej faktury plikiem zewnętrznym. external_invoice_number nadpisuje numer Base. |
| Orders / Invoices | [getInvoiceFile](https://api.baselinker.com/index.php?method=getInvoiceFile) | get_external=false jest domyślne. true pobiera zewnętrzny plik ERP/API, jeśli istnieje; gdy go brak, zwraca format Base. |
| Orders / Invoices | [getInvoices](https://api.baselinker.com/index.php?method=getInvoices) | Najwyżej100 faktur na wywołanie. id_from wskazuje punkt pobierania kolejnych ID; strona nie definiuje wprost inkluzywności ani kolejności i zakończenia skanowania. |
| Orders / Invoices | [getSeries](https://api.baselinker.com/index.php?method=getSeries) | Brak zadeklarowanych parametrów; przykład przesyła {}. Typy serii: INVOICE/CORRECTION/RECEIPT. |
| Orders / Receipts | [addOrderReceiptFile](https://api.baselinker.com/index.php?method=addOrderReceiptFile) | Zastępuje standardowy plik wcześniej wystawionego paragonu zewnętrznym. external_receipt_number nadpisuje numer Base. |
| Orders / Receipts | [addReceipt](https://api.baselinker.com/index.php?method=addReceipt) | Tworzy paragon dla zamówienia; pominięcie series_id wybiera domyślną serię paragonów. |
| Orders / Receipts | [getNewReceipts](https://api.baselinker.com/index.php?method=getNewReceipts) | Kolejka paragonów oczekujących na druk; po wydruku setOrderReceipt potwierdza wykonanie i usuwa pozycję z oczekujących. Odpytywanie co10s jest przykładem, nie gwarancją SLA. |
| Orders / Receipts | [getReceipt](https://api.baselinker.com/index.php?method=getReceipt) | Wymagany receipt_id lub order_id; nie opisano pierwszeństwa ani odmowy przy podaniu obu sprzecznych identyfikatorów. |
| Orders / Receipts | [getReceipts](https://api.baselinker.com/index.php?method=getReceipts) | Najwyżej100 paragonów. id_from jest jawnie inkluzywne; date_from/date_to to Unix timestamp, bez jawnych granic włącznie/wyłącznie i kolejności listy. |
| Orders / Receipts | [setOrderReceipt](https://api.baselinker.com/index.php?method=setOrderReceipt) | Oznacza paragon z getNewReceipts jako wydrukowany. receipt_nr może być pusty, jeśli drukarka nie zwraca numeru. |
| Product catalog / Documents | [addInventoryDocument](https://api.baselinker.com/index.php?method=addInventoryDocument) | Tworzy szkic dokumentu. Potwierdzenie przez użytkownika lub API powoduje wpływ na stan magazynu. |
| Product catalog / Documents | [addInventoryDocumentFile](https://api.baselinker.com/index.php?method=addInventoryDocumentFile) | Załącza plik zewnętrznego systemu do dokumentu magazynowego: PDF data:base64. |
| Product catalog / Documents | [addInventoryDocumentItems](https://api.baselinker.com/index.php?method=addInventoryDocumentItems) | Dodaje pozycje do dokumentu; zwraca utworzone item_id i position. |
| Product catalog / Documents | [getInventoryDocumentFile](https://api.baselinker.com/index.php?method=getInventoryDocumentFile) | get_external=false jest domyślne; true pobiera zewnętrzny plik, a przy jego braku wraca do formatu Base. |
| Product catalog / Documents | [getInventoryDocumentItems](https://api.baselinker.com/index.php?method=getInventoryDocumentItems) | Strony numerowane od1, po100 pozycji. Domyślna strona, sortowanie, total/next i warunek końca nie zostały opisane. |
| Product catalog / Documents | [getInventoryDocumentSeries](https://api.baselinker.com/index.php?method=getInventoryDocumentSeries) | Opcjonalny filtr warehouse_id. document_series zawiera ID, nazwę, typ0..5, magazyn i format. |
| Product catalog / Documents | [getInventoryDocuments](https://api.baselinker.com/index.php?method=getInventoryDocuments) | Strony od1, po100 dokumentów; filtry źródła, ID, typu0..5, statusu0/1, daty utworzenia i magazynu. |
| Product catalog / Documents | [setInventoryDocumentStatusConfirmed](https://api.baselinker.com/index.php?method=setInventoryDocumentStatusConfirmed) | Potwierdza szkic i wpływa na stany magazynowe. |

## Stronicowanie i wybór

- getInvoices i getReceipts zwracają najwyżej 100; id_from jest jawnie inkluzywne tylko dla paragonów. Brak gwarantowanego porządku/końca/stabilnego obrazu i reguł kombinacji filtrów.
- getInventoryDocuments i getInventoryDocumentItems: page od 1, po 100. Brak opisanej domyślnej strony, total/next i warunku końca.
- getNewReceipts: kolejka oczekujących, id_from=0, opcjonalne series_id/device_id. Nie przenosimy limitu 100 z innych metod. Przykład odpytywania co 10 s nie jest SLA; brak opisanego claim/lease/wyłączności drukarki.
- getReceipt wymaga receipt_id lub order_id; konflikt obu nieopisany. addInvoiceCorrection przy return_order_id ignoruje wszystkie inne pola poza series_id.

## Otwarte niejednoznaczności

1. Pełny schemat items nie jest zadeklarowany; order_product_id tylko w prozie, inne klucze tylko w przykładzie. Powód9 wymaga komentarza, ale pola komentarza brak.
2. Typ int identyfikatora różni się od tekstu w przykładzie; format numeracji nie ma pełnej gramatyki.
3. exchange_rate deklarowany decimal(10,4), przykład pusty tekst; getInvoices używa decimal(10,6).
4. Długości numeru paragonu20 w upload/potwierdzeniu i30 w odczycie; nie wyrównujemy ich bez dowodu.
5. Listy używają invoices/items, orders/products, receiptroot/items i receipts/products; nie są wymienne.
6. Przykłady prefiksów/nazw i typów0..5 nie są konsekwentne; tworzenie nie podaje series_id.
7. connection_* i source_object_* mają osobne wartości;0 udokumentowane tylko dla źródła w wyniku, nie dla filtra/connection_type.
8. get_external=true może zwrócić Base fallback; nie jest flagą potwierdzającą obecność pliku zewnętrznego.
9. id_from inkluzywne tylko jawnie w getReceipts; waiting queue nie ma limitu100 ani udokumentowanego claim/lease.
10. Raw JWS paragonu, PDF data:base64 i krajowo dopuszczony XML faktury mają odrębne kontrakty; brak pełnej macierzy MIME/limitów/krajów.

Schemat korekty items pozostaje częściowy: order_product_id wspomina proza; item_name/item_sku/item_ean/item_quantity/item_price_brutto/item_tax_rate występują w przykładzie. Nie nadajemy im nieudokumentowanej wymagalności, typów ani pełnej semantyki zastąpienia. Warunkowe gov_* zapisano osobno z prozy get_government_data; tax_rate zachowuje zwykłe0–100 oraz wyjątki−1/−0.02/−0.03.

## Mapowanie obecnego kodu

JSON przypina hashe 14 plików i rzeczywiste kandydaty tras. Przegląd source nie znalazł dispatchu tych 20 metod ani transportu connector.php/X-BLToken w server/web TypeScript. Podobne funkcje pozostają kandydatami do mapowania, bez przyznania zgodności wire:

- Faktury: local-invoice-routes, osobne B2B i provider invoice plans. Własne UUID, zgody, preview/issue, kursor, HTML/FA3 oraz ograniczenia consumer PL/PLN nie odpowiadają automatycznie pełnym integer ID, stawkom, seriom, krajom i gov_* Base.
- Korekty: historyczne consumer, destinations oraz B2B. Odbiór zwrotu i bezpieczny replay lokalnego łańcucha nie dowodzą dowolnej korekty ceny/podatku/adresu lub dopisania nowej pozycji Base.
- Pliki sprzedaży: Odoo export/cache PDF i lokalny druk HTML. Nie odnaleziono w przejrzanych trasach ogólnego uploadu data:base64/numery zewnętrzne/fallback zgodnego z tym wire.
- Paragony: nie znaleziono zgodnego dispatchu/kolejki/fiskalnego potwierdzania/raw JWS. Lokalna faktura z fiscalized=false i potwierdzeniem, że nie powstaje do paragonu, nie stanowi takiej implementacji.
- Dokumenty magazynowe: istnieją receipt/transfer/count/issue, draft/post/cancel, UUID, kursor i pełna edycja draft. To odrębny model od typów0..5, page100, append items i par source/connection. Rejestr dokumentów jest odczytowy; serie spisu nie zastępują wszystkich serii magazynowych.
- Eksport rejestru/spisu nie dowodzi uploadu zewnętrznego PDF ani Base/external fallback dokumentu magazynowego.

## Odbiór

Wszystkie metody mają implementation_verified=false i acceptance_granted=false. To komplet przeglądu dokumentacji wybranych trzech grup, nie ukończona integracja. Każda metoda ma własne kryteria: dokładny wire, zwykły UI/API/worker, bieżące uprawnienia i obce ID, odczyt utworzonego wyniku oraz kontrola nieznanego wyniku i duplikatu. Fiskalizacja wymaga uprawnionego urządzenia/środowiska; potwierdzenie magazynowe — odczytu rzeczywistych stanów i journali. Kod, publiczny przykład lub lokalny test controlled nie nadaje poziomu sandbox/account.

Kontrola pól z prozy zachowuje separatory HTML (w tym br i elementy list), dzięki czemu nazwy sku/ean/tax_rate/is_shipment nie sklejają się z poprzednim opisem. Poprawiono wyłącznie struktury embedded_documented_fields i ich opisy; źródłowy gzip, pełne wiersze tabel i poziomy odbioru pozostają bez zmian.
