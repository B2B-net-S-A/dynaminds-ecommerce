# Base wire — trzy konkretne luki, 19.10.2026

**Audyt FILE-only lokalnego kodu i zachowanych kontraktów.** Bez sieci, wywołań Base/dostawcy, SQL, uruchomienia aplikacji lub testów wire. Własny REST, podobna funkcja i odbiór lokalnego UI nie potwierdzają zgodności protokołu Base. Pełny Goal pozostaje OPEN.

## Istniejący punkt wpięcia

`server/developer-api.ts:1457` wybiera operację po metodzie HTTP i ścieżce `/api/v1`; `:1465` uwierzytelnia własny token `dyna_api_`, a `:1485` sprawdza zakres operacji. `:3798–3840` rejestruje aliasy rzeczywistych handlerów REST, bez drugiego wewnętrznego żądania HTTP. `server/app.ts:752` zwraca błędy `application/problem+json`.

Zachowany [kontrakt CRM](base-api-client-contracts.v1.md) opisuje inną kopertę: POST `connector.php`, nagłówek `X-BLToken`, formularz `method` i JSON w `parameters`, UTF-8 oraz wynik `status: SUCCESS|ERROR` z polami błędu. Przeszukanie źródeł `server` nie znalazło dispatchu tych nazw metod ani tej koperty. Nie jest to pomiar zerowego pokrycia funkcjonalnego: istnieją odpowiednie funkcje domenowe i własne trasy. [DOM-GAP-006](scope-inputs/v4/domains.json) jawnie zachowuje lukę wire.

Po tym rozpoznaniu dodano źródłowy [kodek koperty](../../server/base-wire-codec.ts)
oraz [11 testów kontrolowanych](../../tests/base-wire-codec.test.ts), PASS na Node24.
Kodek nie jest wpięty do aplikacji ani do wydania N21/N22. Ostrzejsze odmowy
niejednoznacznych danych i limity są lokalną polityką; nie dowodzą zgodności Base.
Dispatch metod, autoryzacja, mapowanie błędów i trwałe liczbowe ID nadal pozostają OPEN.

[Rejestr dokumentacji](base-api-remaining-contracts-next.md) obejmuje 204/204 nazw z zamrożonego indeksu. To pokrycie źródeł, bez potwierdzenia implementacji; nie należy ponownie traktować historycznego spisu brakujących stron jako aktualnej listy braków.

## 1. CRM: profile, odczyt i częściowa aktualizacja

Metody: **`addCrmClient`, `getCrmClientData`, `getCrmClients`**; dalsza część rodziny obejmuje usuwanie, statusy, grupy i odczyt definicji pól.

- Kod: `server/crm-routes.ts:37–43,72`, `server/crm-schema.ts:94–112`, `server/crm.ts:332`. Działa własny REST z UUID, osobnym POST/PATCH i limitem domyślnym 50. Listy i szczegóły korzystają z istniejącego profilu klienta.
- Kontrakt: [client JSON](base-api-client-contracts.v1.json), wpisy `addCrmClient` (`:226`), `getCrmClientData` (`:581`), `getCrmClients` (`:850`). Publiczne ID są liczbowe; jedna metoda dodaje lub aktualizuje zależnie od `crm_client_id`, zmieniając wyłącznie przekazane pola. Lista opisuje strony po 100 oraz nazwane filtry. Pola dodatkowe są domyślnie wyłączone w szczególe.
- Luka: brak translacji koperty, stabilnych liczbowych ID i DTO tych metod. CRM nie występuje w `publicOperations`; własny klucz API nie uzyskuje automatycznie dostępu do sesyjnych tras CRM przez podobną nazwę.

**Najbliższy pełny pion:** zwykły UI tworzy profil → `getCrmClients`/`getCrmClientData` odczytują ten sam rekord → `addCrmClient` aktualizuje tylko wskazane pole → UI po reloadzie pokazuje zmianę, zachowując historię, pozostałe pola i powiązanie zamówienia. Odbiór obejmuje stronę 2, filtry, brak wycieku do innej firmy, domyślne pominięcie pól dodatkowych i jawny wynik niepotwierdzonej mutacji. Reuse istniejącego customer store i trwałych poleceń; bez równoległej kopii klientów.

## 2. OMS: zamówienia, kontynuacja listy i skutki płatności

Metody: **`getOrders`, `addOrder`, `setOrderFields`**.

- Kod: `server/app.ts:1277–1288` przyjmuje własne filtry, `limit` domyślnie 50/maksymalnie 200 i `after`. `server/developer-api.ts:1181,1258,1496` udostępnia REST i wymaga własnego `Idempotency-Key` dla tworzenia zamówień.
- Kontrakt: [orders JSON](base-api-orders-contracts.v1.json), `addOrder` (`:367`), `getOrders` (`:1351`), paginacja (`:2437–2447`); [opis](base-api-orders-contracts.v1.md). `getOrders` ma limit 100 i kontynuację według daty. `paid=1` w `addOrder` oznacza pełną płatność, a nie samą flagę widoku.
- Luka: brak wire DTO/ID, filtrów i kontynuacji Base oraz odbioru skutków tych metod. Własnego kursora nie można przedstawić jako zgodnego z Base. **Zachowanie ponad 100 zamówień z tą samą sekundą i reguła rozstrzygania remisu pozostają nieudokumentowane/OPEN.** Nie deklarować bezstratnej kontynuacji na podstawie samego zalecenia daty.

Następny pion: zamówienie z UI → odczyt `getOrders` → częściowa zmiana `setOrderFields` → UI; osobne utworzenie `addOrder(paid=1)` z dokładną płatnością i rezerwacją. Sprawdzić tożsamość pozycji/wariantów, kwoty, obce ID i niezmienność wcześniejszych zamówień.

## 3. PIM: listy, szczegóły i mapa stanów magazynowych

Metody: **`getInventoryProductsList`, `getInventoryProductsData`, `updateInventoryProductsStock`**.

- Kod: `server/catalog-routes.ts:25–41` udostępnia własne UUID, `limit≤200`, `after` i lokalne DTO; `server/developer-api.ts:1303,1426–1430` wystawia własne odczyty i korekty magazynu.
- Kontrakt: [inventory products JSON](base-api-inventory-products-contracts.v1.json), lista (`:2344`), aktualizacja stock (`:3359`), oraz [opis](base-api-inventory-products-contracts.v1.md). Lista opisuje strony po 1000 i mapę produktów po ID. Szczegóły mają osobne flagi/mapy. Stock przyjmuje mapę produkt→magazyn→ilość, maksymalnie 1000 produktów; wynik zawiera licznik/ostrzeżenia.
- Luka: brak zgodnej translacji ID, map, filtrów, flag i wyników. Nie utożsamiać liczników/ostrzeżeń z gwarancją atomowości. Kontrakt nie rozstrzyga wszystkich skutków dla rezerwacji, dokumentów, partii i kosztów; nie dopisywać ich jako faktów Base.

Następny pion: produkt utworzony w UI → lista/szczegóły przez metody Base → jawna korekta jednego własnego magazynu → UI, inventory i historia ruchów. Obcy magazyn oraz istniejące rezerwacje muszą pozostać chronione.

## Warunki przed uznaniem pierwszego pionu wire

Najmniejszy kolejny zakres to trzy metody CRM na jednej ograniczonej kopercie delegującej do istniejącej domeny. Przed implementacją trzeba rozstrzygnąć:

- stabilne liczbowe ID i ich powiązanie z własnymi UUID, bez dopasowania klienta po zmiennym e-mailu;
- uwierzytelnianie `X-BLToken`, firma/aktor, świeże prawa i zakresy — własny token REST nie dowodzi tej zgodności;
- kodowanie formularza/JSON, UTF-8 i `+` w base64, kopertę sukcesu/błędu oraz nieznane kody i mapowanie HTTP;
- utratę ACK, ponowienie i świadome powtórzenie tej samej operacji. Własny journal lub `Idempotency-Key` nie są udokumentowaną gwarancją Base; nie dodawać po cichu wymaganego `client_key` do jego metod ani deduplikować dwóch zamierzonych operacji wyłącznie po identycznym body;
- udokumentowane limity i paginację, z jawnym zachowaniem pozostałych niewiadomych.

Testy koperty i rzeczywisty wspólny przepływ UI/API stanowią osobny odbiór. Nie zamykają pozostałych metod, konta Base, integracji dostawców ani pełnego Goala.
