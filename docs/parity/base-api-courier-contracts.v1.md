# Kontrakty API Base — przesyłki kurierskie, wersja 1

Przegląd 17.10.2026 obejmuje wszystkie **16 metod Courier shipments** z przypiętego indeksu. [JSON](base-api-courier-contracts.v1.json) zawiera 49 wierszy parametrów (z polami zagnieżdżonymi) i 106 zadeklarowanych pól wyniku. To przegląd dokumentacji; nie przyznaje implementacji, zgodności wire ani odbioru konta.

Pobrano jedynie publiczne strony dokumentacji. Bez żądań konta, tokenów, SQL i zmian runtime/scope. [Snapshot 16 stron](base-api-courier-sources-20261017.json.gz): 161622 B, SHA256 `b3dc3fee5e1ff738c5e97fc0828ebbc73ee5514070bfb2e262f2a3e90b8c515f`. Każda metoda ma w JSON własny URL, czas UTC, HTTP status, rozmiar i SHA256 dokładnego HTML. Gzip ma 16 dokumentów, nie dane konta.

## Transport i wymagania

[Oficjalny indeks](https://api.baselinker.com/) opisuje POST do connector.php, formularz method + parameters(JSON), nagłówek X-BLToken i 100 żądań/min. Źródło wspólnego transportu zachowano w istniejącym przypiętym snapshocie indeksu; jego hash został ponownie sprawdzony. Szczegóły zakresu limitu, algorytmu i retry nie są dopowiadane.

Każda strona opisuje status SUCCESS/ERROR oraz przy błędzie error_message/error_code. Nie podano kodów poszczególnych błędów, mapowania HTTP ani macierzy uprawnień. required:null oznacza brak formalnego oznaczenia. false wynika z jawnej opcjonalności, true tylko z wyrażonego wymagania. Warunki alternatywnych ID i zależności od metadanych zapisano osobno. Nie zakładamy obsługi null, nieznanych parametrów ani nieopisanych wartości domyślnych.

## Szesnaście metod

| Metoda | Wejście / zależności | Wynik / granica |
|---|---|---|
| [createPackage](https://api.baselinker.com/index.php?method=createPackage) | order_id, courier_code; opcjonalne account_id→pierwsze konto; fields[].id/value; dynamiczne packages z wagą. | package_id/package_number/courier_inner_number oraz packages[] dla wszystkich paczek. |
| [createPackageManual](https://api.baselinker.com/index.php?method=createPackageManual) | order_id, courier_code lub własna nazwa, package_number, pickup_date; return_shipment=false. | package_id, package_number; tylko dopisanie zewnętrznego nadania. |
| [deleteCourierPackage](https://api.baselinker.com/index.php?method=deleteCourierPackage) | courier_code; package_id lub package_number; force_delete=false. | Status; usunięcie u kuriera zależy od możliwości jego API. |
| [getCourierPackagesStatusHistory](https://api.baselinker.com/index.php?method=getCourierPackagesStatusHistory) | package_ids, najwyżej 100. | packages_history{ID}[]: data, kod kuriera, status 0..13; paginacja i retencja nieopisane. |
| [getOrderPackages](https://api.baselinker.com/index.php?method=getOrderPackages) | order_id. | packages[] z courier_package_nr, kontem, statusem 0..11, typem paczki 0..3 i tracking_url/is_return. |
| [getPackageDetails](https://api.baselinker.com/index.php?method=getPackageDetails) | package_id. | package_details[] dla podpaczek: masa/wymiary/jednostki, 3 kwoty+waluty, typ/usługi; additional_fields. |
| [getPricePackage](https://api.baselinker.com/index.php?method=getPricePackage) | order_id, courier_code, account_id; fields; packages warunkowo wg metadanych. Liczby JSON, daty sekundy Unix. | prices[]:name, price, currency, info; selected tylko przy dopasowaniu; opcjonalne header/notices. |
| [getCourierAccounts](https://api.baselinker.com/index.php?method=getCourierAccounts) | courier_code. | accounts[]:id, name; kolejność pierwszego konta nieokreślona. |
| [getCourierFields](https://api.baselinker.com/index.php?method=getCourierFields) | courier_code. | multi_packages, fields[] i package_fields[]; zależne opcje/show_field/function, bez pełnej flagi required. |
| [getCourierServices](https://api.baselinker.com/index.php?method=getCourierServices) | courier_code, order_id, account_id, fields, packages. | services{ID:nazwa}; tylko BrokerSystem/Wysyłam z Allegro/ErliPRO; konflikt kształtu fields. |
| [getCouriersList](https://api.baselinker.com/index.php?method=getCouriersList) | Brak zadeklarowanych parametrów; {} w przykładzie. | couriers[]:code, name; przykład nie zamyka katalogu kurierów. |
| [getCourierDocument](https://api.baselinker.com/index.php?method=getCourierDocument) | courier_code, document_type, account_id; opcjonalne package_ids/package_numbers. | extension, document base64; manifest/protocol/label/customs_document. |
| [getLabel](https://api.baselinker.com/index.php?method=getLabel) | courier_code; package_id lub package_number. | extension, label base64; siedem wymienionych formatów, bez wyboru formatu w wejściu. |
| [getProtocol](https://api.baselinker.com/index.php?method=getProtocol) | courier_code; package_ids lub package_numbers; account_id bez oznaczenia wymagalności. | extension, protocol base64; pdf/html, zależnie od kuriera. |
| [getRequestParcelPickupFields](https://api.baselinker.com/index.php?method=getRequestParcelPickupFields) | courier_code. | fields[]:id, name, type, desc, options, value; schemat zależny od kuriera. |
| [runRequestParcelPickup](https://api.baselinker.com/index.php?method=runRequestParcelPickup) | courier_code; package_ids lub package_numbers; account_id i dynamiczne fields. | pickup_number; brak opisanej idempotencji/anulowania/zmiany odbioru. |

Żadna z 16 stron nie deklaruje parametrów paginacji. Limit 100 w historii dotyczy wejściowej partii, nie stron ani kompletności historii. Dla pozostałych list limit i gwarancja kompletności pozostają nieokreślone.

## Zależności i sprzeczności, których nie rozstrzygamy za kuriera

1. getCourierFields udostępnia pola, opcje, show_field, function i package_fields; konkretne ID/warunki zależą od kuriera i konta. Metadane nie opisują ogólnej flagi required. Przykładowe pola paczki i nazwy usług nie są globalnym słownikiem.
2. Niepuste function wymaga getCourierServices z aktualnym kontekstem. fields w opisie usług sugeruje mapę, a przykład listę id/value. Obsługa jest opisana tylko dla trzech integracji.
3. createPackage zawiera nazwę packages_fields zamiast package_fields; przykłady różnią się kluczami length/size_length i liczbami jako tekst/liczba. getPricePackage ma odrębną, wyraźną regułę JSON numbers/decimal_places/sekundy Unix oraz warunkowej wagi pierwszej paczki. Nie przenosimy reguł między metodami.
4. Tabela package_fields nie definiuje formalnie decimal_places/options/default, choć pokazuje je przykład i quotation odwołuje się do decimal_places. getCourierFields.value ma typ varchar, a przykładowa data jest liczbą.
5. Tracking ma różne słowniki 0..11 oraz 0..13. packages_history i additional_fields nazwano array, lecz opis/przykład wskazują mapy. Nie dopowiadamy kolejności, retencji i jednostki daty historii.
6. getCourierDocument oznacza obie listy paczek jako opcjonalne bez reguły co najmniej jednej; pozostałe selektory mają jawne alternatywy. Reguła pierwszego konta występuje tylko tam, gdzie została opisana. Przykład getProtocol pomija nieoznaczone account_id.
7. force_delete dotyczy także lokalnego usunięcia mimo niepowodzenia kuriera. Brak klucza idempotencji, reguł częściowego sukcesu, rozstrzygania utraconej odpowiedzi, zmian/anulowania odbioru i pełnych gwarancji kosztu. Nie wprowadzamy automatycznego ponowienia niepewnego tworzenia/odbioru.

## Obecny kod i granice odbioru

Przeszukanie server/web TypeScript/TSX po 16 nazwach metod i connector.php/X-BLToken nie znalazło zgodnego dispatchu. JSON przypina hashe dziewięciu przejrzanych plików i mapowanie kandydatów; podobna funkcja nie dowodzi zgodności protokołu:

- shipping-routes.ts/shipping.ts: własny preview/queue/buy/refresh/cancel/reconcile, lista planów i kanały inpost/dpd. UUID, własne statusy i jeden parcel nie zastępują Base integer ID, dynamicznych formularzy i wielu paczek. Ręczne dopisanie zewnętrznej przesyłki nie zostało znalezione w przejrzanych trasach.
- dpd-shipping.ts: osobne tworzenie/uzgadnianie/dispatch/etykieta DPD. cancel odmawia niektórych gotowych i niepewnych przypadków; brak dowodu force_delete.
- tracking-routes.ts: monitoring/odczyt trackingu dostawców. Nie potwierdza kluczowanej historii partii 100 ani słownika Base.
- app.ts, shipment-label-cache-routes.ts, shipment-label-print-routes.ts: etykiety, cache, PDF i druk. Nie potwierdzają Base JSON z extension+base64 ani wszystkich formatów/dokumentów celnych.
- dpd-collections.ts/dpd-pickup-schedules.ts: protokoły, odbiory i harmonogramy DPD. Nie zastępują ogólnych metadanych i zamówień odbioru dla wszystkich kurierów.

Odbiór wymaga osobno: zgodnego wire na metodę, zwykłego UI/API/worker, powiązania own tenant/account/courier, dynamicznych formularzy i wielu paczek, odczytu wyniku u dostawcy, odmów uprawnień/obcych ID oraz uzgodnienia niepewnego wyniku bez duplikatu. Dokumentacyjne przykłady, istniejące trasy i lokalna symulacja nie nadają poziomu sandbox/account. Dokładne przykłady odbioru i otwarte zależności są przy każdej metodzie w JSON.
