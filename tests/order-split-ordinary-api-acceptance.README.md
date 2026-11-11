# Ordinary split API — przygotowany odbiór początkowego pionu

`order-split-ordinary-api-acceptance.mjs` eksportuje
`runOrderSplitOrdinaryAcceptance` oraz osobny
`reconcileOrderSplitOrdinaryAcceptance`. Wymaga istniejącego projektowego loadera:

```sh
node --import tsx --test tests/order-split-ordinary-api-acceptance.test.mjs
```

Import pozostaje inert. `runOrderSplitOrdinaryAcceptance` bez pełnych wejść
zwraca `PREPARED_NOT_RUN` bez sieci i plików. Ten moduł nie instaluje210, nie rejestruje tras/flag i nie zmienia
autoryzacji transportu ani bramki Native. Obecnie nie istnieje odebrane wydanie210 do wykonania
tego scenariusza. Brak rzeczywistej flagi gotowości daje
`NOT_RUN_NATIVE210_UNAVAILABLE`, bez loginu ani mutacji biznesowej. Nie wolno
wstrzykiwać flagi do rzeczywistego health ani traktować modelu testowego jako
zainstalowanego Native.

Jawny caller dostarcza:

- `profile: {baseUrl:'http://127.0.0.1:<port wskazany przez Root>', expectedRevision, expectedSchema}`;
  pełna rewizja SHA256 i rzeczywista, wcześniej odebrana nazwa schematu210.
  Port musi należeć do osobnej, jawnie wskazanej kopii: liczba całkowita1024–65535,
  z wyłączeniem Main na4100 i zachowanego APP16 na4103. Nie ma domyślnego portu ani
  fallbacku. Dopuszczalny jest wyłącznie kanoniczny `http://127.0.0.1:PORT`, bez
  ścieżki, aliasu hosta, query, userinfo lub przekierowań. Sam poprawny adres nie
  potwierdza własności kopii; Root musi wcześniej związać profil i wydanie.
  Oczekiwań rewizji/schematu nie pobieramy z health.
- `login: {email,password}` ładowany wyłącznie z istniejącego prywatnego pliku;
  hasło/cookie nie trafiają do wyniku, dziennika ani błędów.
- `outputDirectory`: nowy absolutny podkatalog istniejącego kanonicznego
  prywatnego katalogu. Runner tworzy0700 i wyłączne pliki0600. Po utworzeniu katalogu synchronizuje również katalog nadrzędny; po utworzeniu
  attempt i events synchronizuje katalog próby przed pierwszym HTTP. Błąd
  któregokolwiek fsync odmawia przed siecią. Sam fsync pliku nie wystarcza
  do utrwalenia wpisu katalogu po utracie zasilania. Istniejącego
  katalogu nie wznawia, nie nadpisuje ani automatycznie ponawia.
- `fixture` w ścisłym formacie poniżej. `onProgress` jest opcjonalnym dodatkowym
  oczekiwanym sinkiem; własny dziennik jest zawsze zapisywany i fsync przed POST.

```json
{
  "schema":"dynaminds-order-split-ordinary-fixture/v2",
  "evidence":"genuine_http_manual_unpaid_fresh_order",
  "purpose":"ordinary_api",
  "tenant_id":"<rzeczywisty UUID firmy>",
  "actor_id":"<rzeczywisty UUID operatora>",
  "warehouse_id":"<dokładny UUID magazynu nowych fixtures>",
  "wms_mode":"OFF",
  "source_order_id":"<NOWE zamówienie API, nigdy źródło finansowe ani UI>",
  "source_version":"<aktualna wersja>",
  "children":[
    {"slot_id":"<stabilny UUID>","name":"Pierwszy wynik","delivery_minor":2,
     "items":[{"source_item_id":"<rzeczywisty UUID pozycji>","quantity":1}]},
    {"slot_id":"<drugi stabilny UUID>","name":"Drugi wynik","delivery_minor":3,
     "items":[{"source_item_id":"<ten sam UUID pozycji>","quantity":1}]}
  ],
  "ui_reserved_order_ids":["<ODRĘBNE nowe źródło przeznaczone wyłącznie do Chrome>"]
}
```

Format v2 wymaga dokładnego magazynu; wynik nowego buildera
`tools/parity/order-split-ordinary-fixture.mjs` przekazuje go w `fixture`.
Historyczny v1 jest odrzucany, bez dopisywania zgadywanego magazynu lub
przepisywania starego dziennika. To deklaracja pochodzenia do sprawdzenia przez
koordynatora, nie dowód ani admission. Przygotować osobne nowe genuine zamówienie WMS OFF i ON zwykłym
UI/API, niezapłacone/manual/new, bez dokumentów, zwrotów, wysyłek, lineage i
scan/consumed/released; zwykły operator, poprawna firma i zapisywalna kopia.
Native musi samodzielnie sprawdzić pełną historię, aktualne uprawnienia i custody.
Minimalny golden:3 sztuki po123gr,23% VAT, dostawa7gr; dwoje dzieci po1 sztuce
z dostawą2/3gr, pozostałość1 sztuka/dostawa2gr. Każdy wynik brutto123/netto100/
VAT23; całe zamówienie razem376gr. Sam JSON fixture nie tworzy danych ani dowodów SQL.

Runner sprawdza dokładny release/schema/health, zwykły login+wybór firmy i IAM,
aktualny source GET i zgodność magazynu. Przed preview oraz ponownie przed
execute sprawdza rzeczywiste GET `buyer-address-access` i `buyer-address-history`:
polityka i wersja dostawy0, unknown/disabled, brak ostatniej zmiany i pusta historia.
Dla wyników ponawia te odczyty, wiążąc wersję każdego zamówienia. Zapisuje oryginalny klucz/body przed pojedynczym preview
POST, wykonuje original-command GET oraz wszystkie source-items/children pages,
head i commercial. Po zweryfikowanym preview wysyła jeden jawny execute POST
z oddzielnym zachowanym kluczem. Weryfikuje pełny oryginalny wynik i zwykłe
szczegóły wszystkich zamówień; ponowny odczyt jest wyłącznie GET. Kontroluje
ilości, historyczne G/N/VAT bez repricing, dostawę, źródłowe ceny, nagłówek
odbiorcy oraz publiczne picking/location quantities. Wynik nie zawiera adresów,
portaltokenów, kosztów warstw ani credentials. Po dispatch komendy ACK loss,404,
niepełne strony lub niezgodność actor/kwot/custody zachowują pending i kończą
próbę bez retry. Odmowa przed dispatch nie tworzy nowej niepewnej komendy.
Oryginalne klucze i body zostają w append-only dzienniku także po rozwiązaniu.
Przed dispatch zapisuje również zweryfikowany intent i ograniczone źródłowe
ilości/kwoty/public custody oraz SHA odbiorcy; nie zapisuje surowego adresu,
e-maila klienta ani portaltokenu w tym dowodzie odzyskiwania.

## Jawne uzgodnienie utraconego ACK — bez ponowienia splitu

`reconcileOrderSplitOrdinaryAcceptance` przyjmuje te same `profile`, `fixture`,
`login` i nowy prywatny `outputDirectory` oraz `retainedAttempt` z
`error.acceptanceProgress` albo odpowiadającego mu oryginalnego zapisanego
`progress` w dzienniku. Wymaga pełnego zachowanego intentu, źródłowego dowodu,
oryginalnego klucza/body i nierozwiązanej ostatniej komendy. Nie rekonstruuje
ich z dzisiejszego zamówienia ani nie przyjmuje starej próby bez tych danych.

Nowy dziennik `order-split-ordinary-progress/v2` wiąże także oryginalny
`origin`, rewizję i `schema_revision`. Inny port tej samej kopii danych lub
brak tego związania odmawia przed plikami i siecią. Starego v1 nie dopasowuje
się do obecnie wybranego portu ani nie przepisuje. Pliki attempt/v2 buildera
fixtures i runnera zachowują jawny origin; biznesowy format fixture/v2 i body
komend pozostają bez zmian.

```js
await reconcileOrderSplitOrdinaryAcceptance({
  profile, fixture, login, retainedAttempt,
  outputDirectory: freshPrivateReconciliationDirectory
});
```

Po sprawdzeniu dokładnego release/schema/health wykonuje wyłącznie biznesowe
GET: rzeczywistą trasę `/api/order-splits/commands/:key?operation=...`, pełne
strony oryginalnego wyniku, commercial i odpowiednie odczyty zamówień/adresów.
**POST `/api/auth/login` i `/api/workspaces/switch` są jedynymi wyjątkami** —
służą wyłącznie zwykłej autoryzacji. Nie wysyła preview/execute ani innego POST
biznesowego. Po odzyskaniu preview nie kontynuuje execute. Po utracie ACK execute
porównuje także oryginalne preview i wykonanie, kwoty, magazyn, odbiorcę,
historię i publiczne ilości/lokalizacje wszystkich wyników.

404, obcy actor lub niezgodny wynik pozostawiają oryginalną próbę niepewną;
nie są zgodą na ponowienie POST. Osobny dziennik uzgodnienia nie zmienia starego
dziennika ani przekazanego obiektu `retainedAttempt`. Wynik rzeczywistego odczytu
ma status `PASS_ORIGINAL_COMMAND_GET_ONLY_RECONCILIATION`, a podmieniony transport
wyłącznie `PASS_CONTROLLED_GET_ONLY_RECONCILIATION`. Żaden z nich nie jest odbiorem
wykonania nowego splitu ani upoważnieniem do automatycznego ponowienia.

`PASS_ORDINARY_API_ONLY` nie jest odbiorem pełnego splitu. Publiczny DTO nie
udostępnia całych reservations/layers/stock/bin/lot/FIFO, globalnego reserved ani
pełnej historii finansowej. Wymagany jest późniejszy autentyczny SQL stock/layer
oracle przed/po operacji, równoległość, restart/restore/lostACK oraz wizualne
wykonanie z odrębnego źródła Chrome na tym samym wydaniu. Dlatego wynik zawsze
ma `physical_transfer_acceptance:false`, `sql_stock_layer_oracle_performed:false`,
`ui_acceptance:false`, `full_split_acceptance:false`. Podmieniony transport
zwraca wyłącznie `PASS_CONTROLLED_API`.

Płatne/historyczne/dokumentowe przypadki, classified delivery, kolejne splity,
merge lineage, partial fulfillment, import/workery i pełna zgodność Base
pozostają w nadrzędnym zakresie; ten początkowy odbiór ich nie usuwa.

Runner i builder fixtures mają łącznie43 kontrolowane testy protokołu i trwałości. Nie wykonano tu
rzeczywistych żądań API, PostgreSQL ani Chrome; Native210 i odbiór biznesowy
pozostają oddzielnymi, wymaganymi bramkami.
