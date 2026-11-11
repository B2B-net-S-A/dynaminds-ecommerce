# API Base — układ magazynu: lokalizacje, typy, strefy i regały

**Uzupełnienie dokumentacji z 18.10.2026, nie implementacja.** Wybrano
12 metod z istniejącego indeksu 204 metod z 17.10: `Product catalog /
Locations` (6), `Zones` (3), `Racks` (3). Żadna nie należy do wcześniej
opisanych 12 metod produktów ani 14 konfiguracji. Nie zmieniono starszych
snapshotów, PickPack, indeksu ani centralnej matrycy.

`documentation_only=true`, `official_account_requests_performed=false`,
`implementation_verified=false`, `wire_acceptance=false`,
`provider_account_acceptance=false`, `acceptance_granted=false`.

## Źródła i data

[Snapshot HTML](base-api-products-next-sources-20261018.json.gz) zachowuje
12 publicznych odpowiedzi GET oficjalnej dokumentacji: **12 HTTP 200**,
poprawny nagłówek nazwy każdej metody, dokładne bajty, SHA256, URL końcowe,
czasy i dostępne metadane HTTP. Pobranie nastąpiło **18.10.2026,
00:53:54.825227–00:53:59.478795 UTC**. To data odczytu, nie deklarowana
data publikacji ani dowód treści indywidualnych stron z 17.10.

- Gzip: **121964 B**, SHA256
  `63368c3895d4f92a7d256840173d48d23a3da364973b486120e155e1b5dea940`.
- Rozpakowany JSON: **691619 B**, SHA256
  `b5cf278ed0d0dd9fe7c11c3736357446b194d21cfc870a3110b56899d5bd64e5`.
- Starszy indeks JSON: SHA256
  `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`.

Czytnik WWW otworzył sześć stron lokalizacji; dla sześciu stron stref i
regałów zgłosił niedostępny URL, bez statusu HTTP. Osobny rzeczywisty GET
publicznych URL zwrócił wszystkie 12 stron poprawnie; oba fakty zachowano
w `web_reader_observation` oraz metadanych HTTP. Nie nazwano błędu czytnika
błędem API. Nie użyto tokenów, cookies konta, `connector.php` ani zapisów
na koncie. Nie wykonywano skryptów pobranych stron.

| Metoda | HTML B | SHA256 HTML UTF-8 |
|---|---:|---|
| `addInventoryWarehouseLocation` | 51611 | `ad0a2bda16a55ef01a31b533bbcb358a8c556bf7610b7e494374e72c5ad3ac65` |
| `addInventoryWarehouseLocationType` | 51199 | `2f97686a78607eead2aa178d9084378589d17708924b6348677de5e20bead566` |
| `deleteInventoryWarehouseLocation` | 49434 | `d2f8c84a91ea4127d38e62106161adafd7bd5c52e6312a0107ff9991ca7aeb53` |
| `deleteInventoryWarehouseLocationType` | 48793 | `91024a197e6147e2ce60407375d3751d670af86b25a15934d3ca542d6018f752` |
| `getInventoryWarehouseLocationTypes` | 51528 | `0302b4d68c414952c560137c20c28ba856b2885bce1b92871bfd01995bb39674` |
| `getInventoryWarehouseLocations` | 52578 | `409bb09966d045148b0cc6d9ee532932ed21b62d576c6df8c0c14fb0d7ff6fb9` |
| `addInventoryWarehouseZone` | 49565 | `469d116883481d5d1cd09ea718428737c0b4016d24e3a3b539d6831df0bddb19` |
| `deleteInventoryWarehouseZone` | 48755 | `dfcd5f18f4e8414a5a11397d54f3ee67d44b6268bcc850b9ad86b6032d00c08f` |
| `getInventoryWarehouseZones` | 49763 | `f6a32a24be8f020b4ea6980588563437659efc19bc605f4697e98d7dbc6c1900` |
| `addInventoryWarehouseRack` | 49810 | `cfa448608b8b705c51fbff94f76d458c8f5252f8703f9390f9751dde6082bf7d` |
| `deleteInventoryWarehouseRack` | 48708 | `5366d671f601792ca25757bcbd8c90cbcca3aab3ed7d1a3b14971df7e13be24e` |
| `getInventoryWarehouseRacks` | 49866 | `3aa1b8d5cd3752fb3dc081b22d6ef1a136b301a44f7324c62d53f963e543a47c` |

## Wspólna koperta, błędy i interpretacja

Przykłady pokazują POST do `https://api.baselinker.com/connector.php`,
nagłówek `X-BLToken` i formularz `method` + `parameters`, gdzie argumenty
są serializowanym JSON. Nie testowano transmisji, limitów szybkości ani
uprawnień tokenu. `warehouse_id` i `warehouse_type` należy brać z
`getInventoryWarehouses`; przykładowe `"bl"` nie stanowi zamkniętego enum.

Wyniki wszystkich metod mają `status: varchar(30)` z `SUCCESS` / `ERROR`.
Opis statusu wymienia `error_message` i `error_code`, ale bez typów,
konkretnych kodów i mapowania na HTTP status. Nie zakładamy obecności pól
sukcesu przy błędzie. Poniżej zachowano dokładne typy tabel, w tym
`char(6)` zamiast PickPackowego `varchar(7)` oraz `bool` zamiast domyślonej
reprezentacji liczbowej. Typ `float` nie dowodzi konkretnej precyzji wire.

„Opcjonalne” i wartości domyślne zapisano tylko tam, gdzie źródło tak
stwierdza. Pozostałe pola wejścia nie mają osobnej flagi required; brak
tej flagi nie upoważnia do ich pomijania. Nie założono nullowalności,
zakresów ID ani sposobu liczenia znaków Unicode. Limity i domyślne
wartości tworzenia nie są automatycznie regułami aktualizacji.

## Kontrakty metod

### addInventoryWarehouseLocation

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryWarehouseLocation).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `location_id` | `int` |
| in | `warehouse_id` | `int` |
| in | `warehouse_type` | `varchar(20)` |
| in | `name` | `varchar(20)` |
| in | `color` | `char(6)` |
| in | `is_pickable` | `bool` |
| in | `priority` | `int` |
| in | `location_type_id` | `int` |
| in | `zone_id` | `int` |
| in | `rack_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `location_id` | `int` |

Pominięte opcjonalne `location_id` oznacza tworzenie; podane — aktualizację.
`name` wymagane przy tworzeniu, opcjonalne przy zmianie: unikalne
w magazynie, do 20 znaków, bez `;`. Opcjonalny `color` to sześć znaków
hex, normalizowanych do małych liter; nowy domyślny `4285f4`.
Opcjonalne: `is_pickable` (nowe: true), `priority` (1..99999, nowe: 1;
mniejsze pierwsze), `location_type_id` (istniejący typ użytkownika;
pominięty przy tworzeniu daje jego domyślny typ), `zone_id`, `rack_id`.

Zero strefy/regału oznacza brak przypisania. Niezerowy regał ustawia
strefę według regału; jawna strefa musi się zgadzać, a pominięta może być
uzupełniona. Zmiana strefy bez przekazania regału zeruje regał. Nie
dopisano zachowania `location_id=0`, zerowania strefy po samym `rack_id=0`
ani wpływu zmian na istniejące rezerwacje. Wynik identyfikuje lokację.

### addInventoryWarehouseLocationType

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryWarehouseLocationType).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `location_type_id` | `int` |
| in | `name` | `varchar(50)` |
| in | `max_quantity` | `int` |
| in | `max_weight` | `float` |
| in | `width` | `float` |
| in | `height` | `float` |
| in | `depth` | `float` |
| in | `is_transfer_bin` | `bool` |
| in | `is_receiving_bin` | `bool` |
| out | `status` | `varchar(30)` |
| out | `location_type_id` | `int` |

Opcjonalny identyfikator wybiera aktualizację; pominięty — nowy typ.
`name` jest wymagane przy tworzeniu, opcjonalne przy aktualizacji,
unikalne wśród typów użytkownika, do 50 znaków. Pozostałe ustawienia
są opcjonalne. Nowe wartości domyślne: wszystkie wielkości 0, obie flagi
false. `max_quantity`: 0..999999999; `max_weight` w kg: 0..9999.99;
wymiary w cm: 0..9999.99. Zero pojemności/masy oznacza brak limitu,
zero wymiaru — brak ustawienia. Flagi transferu i przyjęć wzajemnie się
wykluczają. Nie założono kontroli zajętych lokacji po obniżeniu limitów.

### deleteInventoryWarehouseLocation

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=deleteInventoryWarehouseLocation).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `warehouse_id` | `int` |
| in | `warehouse_type` | `varchar(20)` |
| in | `location_id` | `int` |
| out | `status` | `varchar(30)` |

Usuwa jedną lokację; musi należeć do magazynu określonego parą
`warehouse_type` + `warehouse_id`. ID lokacji pochodzi z listy lokacji.
Nie opisano zajętej lokacji, rezerwacji, kaskad stock/WMS, ponowienia
ani konkretnego błędu niezgodnego magazynu.

### deleteInventoryWarehouseLocationType

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=deleteInventoryWarehouseLocationType).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `location_type_id` | `int` |
| out | `status` | `varchar(30)` |

Usuwa wskazany typ. **Domyślnego typu nie można usunąć.** Nie określono
zachowania typu używanego przez lokacje, ewentualnego przepięcia na
domyślny, nieistniejącego ID ani kodu odmowy.

### getInventoryWarehouseLocationTypes

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryWarehouseLocationTypes).

Tabela wejścia jest pusta; przykład `{}`. Lista jest sortowana po nazwie.

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `location_types` | `array` |
| out | `location_types[].location_type_id` | `int` |
| out | `location_types[].name` | `varchar(50)` |
| out | `location_types[].max_quantity` | `int` |
| out | `location_types[].max_weight` | `float` |
| out | `location_types[].width` | `float` |
| out | `location_types[].height` | `float` |
| out | `location_types[].depth` | `float` |
| out | `location_types[].is_transfer_bin` | `bool` |
| out | `location_types[].is_receiving_bin` | `bool` |
| out | `location_types[].is_default` | `bool` |

ID służy tworzeniu/aktualizacji lokacji oraz zmianie/usuwaniu typu.
Masa jest w kg, wymiary w cm; zera mają znaczenia opisane wyżej.
`is_default` wskazuje automatyczny wybór dla nowych lokacji bez typu
i blokadę usunięcia tego typu. Nie udokumentowano pola do zmiany
domyślności, paginacji, maksymalnej liczby wyników ani reguł kolacji.

### getInventoryWarehouseLocations

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryWarehouseLocations).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `warehouse_id` | `int` |
| in | `warehouse_type` | `varchar(20)` |
| in | `page` | `int` |
| in | `filter_location_id` | `int` |
| in | `filter_name` | `varchar(200)` |
| in | `filter_rack_id` | `int` |
| in | `filter_zone_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `locations` | `array` |
| out | `locations[].location_id` | `int` |
| out | `locations[].name` | `varchar(20)` |
| out | `locations[].color` | `char(6)` |
| out | `locations[].is_pickable` | `bool` |
| out | `locations[].priority` | `int` |
| out | `locations[].location_type_id` | `int` |
| out | `locations[].zone_id` | `int` |
| out | `locations[].rack_id` | `int` |

Strony po 100 lokacji, od numeru 1, domyślnie 1; sortowanie po nazwie.
`page` i wszystkie filtry są opcjonalne. Filtr ID wybiera jedną lokację;
`filter_name` bez `*` dopasowuje dokładnie, a `*` dowolny ciąg znaków.
Filtry regału/strefy przyjmują 0 dla braku przypisania. Wynikowy kolor
ma sześć małych znaków hex, bez `#`; `priority` jest w zakresie 1..99999,
a brak strefy/regału reprezentuje 0.

Wynik nie deklaruje `total_count`, `has_more` ani kursora. Nie określono
stabilności stron podczas zmian, kolacji/remisów, walidacji page<=0,
interakcji wielu filtrów ani sposobu uciekania dosłownej gwiazdki.

### addInventoryWarehouseZone

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryWarehouseZone).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `zone_id` | `int` |
| in | `name` | `varchar(50)` |
| in | `color` | `char(6)` |
| in | `location_prefix` | `varchar(10)` |
| out | `status` | `varchar(30)` |
| out | `zone_id` | `int` |

Opcjonalny `zone_id`: pominięty lub 0 tworzy strefę, podany istniejący
identyfikator wybiera aktualizację. Źródłowe „leave blank” nie rozstrzyga
przyjmowania JSON `""` lub `null`. Nazwa niepusta, do 50 znaków; kolor
sześciocyfrowy hex, normalizowany do małych liter. `name`/`color` nie
oznaczono osobno jako opcjonalnych. Opcjonalny prefiks do 10 znaków,
domyślnie `""`. Nie opisano unikalności nazwy, pomijania pól przy zmianie
ani przeliczania istniejących nazw lokacji po zmianie prefiksu.

### deleteInventoryWarehouseZone

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=deleteInventoryWarehouseZone).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `zone_id` | `int` |
| out | `status` | `varchar(30)` |

Usuwa strefę **wraz z przypisanymi regałami**, a lokacje w strefie tracą
przypisanie. Nie jest to opis usunięcia samych lokacji ani stock.
Nie udokumentowano atomowości kaskady, zajętych lokacji, zamówień,
powtórnego usunięcia ani szczegółowych błędów.

### getInventoryWarehouseZones

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryWarehouseZones).

Tabela wejścia jest pusta; przykład `{}`. Sortowanie po nazwie.

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `zones` | `array` |
| out | `zones[].zone_id` | `int` |
| out | `zones[].name` | `varchar(50)` |
| out | `zones[].color` | `char(6)` |
| out | `zones[].location_prefix` | `varchar(10)` |

ID można wykorzystać przy przypisaniu regału lub lokacji. Kolor ma małe
znaki hex bez `#`; brak prefiksu jest pustym stringiem. Nie podano
paginacji, filtrów, limitu wyników, parametru magazynu ani gwarancji kolacji.
Nie dopisano `warehouse_id` na podstawie podobieństwa do listy lokacji.

### addInventoryWarehouseRack

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=addInventoryWarehouseRack).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `rack_id` | `int` |
| in | `name` | `varchar(100)` |
| in | `zone_id` | `int` |
| in | `layout` | `int` |
| in | `location_prefix` | `varchar(10)` |
| out | `status` | `varchar(30)` |
| out | `rack_id` | `int` |

Opcjonalny `rack_id`, pominięty lub 0, oznacza tworzenie; podany — zmianę.
Nazwa niepusta, do 100 znaków. Opcjonalna strefa musi istnieć dla użytkownika;
0 lub pominięcie oznacza brak strefy, wartość domyślna 0. `layout` ma enum
0=góra, 1=prawo, 2=dół, 3=lewo. `name`/`layout` nie oznaczono osobno jako
opcjonalnych. Opcjonalny prefiks do 10 znaków, domyślnie `""`.
Nie określono unikalności nazw, dokładnego znaczenia „blank”, propagacji
zmiany strefy do istniejących lokacji ani przekształcania nazw po prefiksie.

### deleteInventoryWarehouseRack

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=deleteInventoryWarehouseRack).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `rack_id` | `int` |
| out | `status` | `varchar(30)` |

Usuwa regał i odpina przypisane lokacje. Nie opisuje kasowania lokacji
lub strefy. Szczegółowe zmiany pól lokacji, zachowanie zajętych lokacji,
konkretne błędy oraz ponowienie nie zostały udokumentowane.

### getInventoryWarehouseRacks

Źródło: [oficjalna strona](https://api.baselinker.com/index.php?method=getInventoryWarehouseRacks).

Tabela wejścia jest pusta; przykład `{}`. Sortowanie po nazwie.

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `racks` | `array` |
| out | `racks[].rack_id` | `int` |
| out | `racks[].name` | `varchar(100)` |
| out | `racks[].zone_id` | `int` |
| out | `racks[].layout` | `int` |
| out | `racks[].location_prefix` | `varchar(10)` |

Brak strefy oznacza 0; brak prefiksu `""`. `layout` zachowuje enum
0=góra, 1=prawo, 2=dół, 3=lewo. ID służy przypisaniu lokacji do regału.
Nie podano paginacji, filtrów, limitu wyników, parametru magazynu ani
szczegółowej kolejności nazw równych według kolacji.

## Pokrycie pól i niezależna kontrola

Pełne tabele odczytano po nagłówkach wejścia/wyjścia. Etykiety HTML
`| - pole` odwzorowano jawnie na `tablica[].pole`, bez sklejania nazw
po usuwaniu znaczników. Oddzielny parser DOM porównuje **każdą nazwę,
typ i kierunek** z tabelami Markdown, nie tylko ich liczby.

| Metoda | Wiersze in | Wiersze out | Zagnieżdżone out |
|---|---:|---:|---:|
| `addInventoryWarehouseLocation` | 10 | 2 | 0 |
| `addInventoryWarehouseLocationType` | 9 | 2 | 0 |
| `deleteInventoryWarehouseLocation` | 3 | 1 | 0 |
| `deleteInventoryWarehouseLocationType` | 1 | 1 | 0 |
| `getInventoryWarehouseLocationTypes` | 0 | 12 | 10 |
| `getInventoryWarehouseLocations` | 7 | 10 | 8 |
| `addInventoryWarehouseZone` | 4 | 2 | 0 |
| `deleteInventoryWarehouseZone` | 1 | 1 | 0 |
| `getInventoryWarehouseZones` | 0 | 6 | 4 |
| `addInventoryWarehouseRack` | 5 | 2 | 0 |
| `deleteInventoryWarehouseRack` | 1 | 1 | 0 |
| `getInventoryWarehouseRacks` | 0 | 7 | 5 |
| **Razem** | **41** | **47** | **27** |

Sprawdzono 41/41 wejść, 47/47 wyjść, w tym 27/27 zagnieżdżonych,
oraz 24 wystąpienia dwóch pól błędu w prozie 12 statusów. Te dodatkowe
`error_message`/`error_code` nie mają typów i nie stanowią wierszy tabel.
Każdy z 12 HTML ma sprawdzone bajty/SHA, poprawną nazwę strony i URL;
zbiór nazw jest dokładnie równy trzem grupom starego indeksu i rozłączny
z istniejącymi 12 produktami oraz 14 konfiguracjami.

## Otwarte granice przed odbiorem implementacji

Nie potwierdzono błędów, uprawnień, zachowania nieistniejących/obcych ID,
konkurencyjnych zmian, idempotencji i odzyskiwania po utracie odpowiedzi.
Nie przenosimy semantyki tworzenia przez ID=0 ze stref/regałów na lokacje
i typy. Nie zakładamy, że brak pola w aktualizacji zawsze zachowuje starą
wartość albo stosuje domyślną tworzenia. Nie utożsamiamy dokumentowanych
parametrów geometrii z dowodem ograniczeń w fizycznym WMS.

Osobny odbiór powinien objąć: właściciela i parę magazynu, unikalność nazw
w zadanym zakresie, domyślny typ i jego nieusuwalność, limity/wykluczające
się flagi, kolor bez `#`, powiązania strefa–regał–lokacja, reset regału po
zmianie strefy, skutki obu kaskad usuwania, filtry 0/`*` i wiele stron
po 100 rekordów. Operacje na zajętych lokacjach i stock wymagają własnych
testów — publiczna dokumentacja nie stanowi ich pozytywnego dowodu.
Nie przyznano zgodności wire, implementacji ani konta dostawcy.
