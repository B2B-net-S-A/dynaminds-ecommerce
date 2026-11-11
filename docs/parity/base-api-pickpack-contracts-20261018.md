# API Base — koszyki PickPack, uzupełnienie z 18.10.2026

**Dokumentacja, nie implementacja.** Osiem metod należy już do grupy
`Orders / PickPack carts` w indeksie z 17.10.2026. Indywidualne strony
pobrano dopiero **18.10.2026, 00:50:41 UTC**; nie jest to wsteczny dowód
treści tych stron z 17.10. Snapshot i kontrakty z wcześniejszą datą oraz
centralna matryca pozostają niezmienione.

`documentation_only=true`, `official_account_requests_performed=false`,
`implementation_verified=false`, `wire_acceptance=false`,
`provider_account_acceptance=false`, `acceptance_granted=false`.
Nie sprawdzono implementacji lokalnej ani wykonania operacji na koncie Base.

## Źródła i sposób odczytu

Wykonano osiem publicznych **GET dokumentacji**, bez tokenu, żądań do
`connector.php`, wywoływania konta ani wykonywania skryptów strony.
Wszystkie odpowiedzi miały HTTP **200** i pozostały na oficjalnym hoście
`api.baselinker.com`. Dokładne HTML UTF-8, URL końcowe, HTTP status,
Content-Type, daty pobrania i dostępne nagłówki Date/ETag/Last-Modified
zawiera [nowy snapshot](base-api-pickpack-sources-20261018.json.gz).
Nie zachowywano nagłówków Set-Cookie.

- Gzip: **79498 B**, SHA256
  `e1c35ce403578f0fbd54fe20e323653cc73bdfd45dc83675aae3a59bfedcb647`.
- Rozpakowany JSON: **451973 B**, SHA256
  `149a3d06fea3030467b543486be7b9d391714be670fb1699268e664358dd4593`.
- Powiązanie metod ze starszym indeksem: `base-api-methods.v1.json`, SHA256
  `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`.

| Metoda | Pobranie UTC, 18.10.2026 | HTML B | SHA256 HTML UTF-8 |
|---|---|---:|---|
| `addPickPackCart` | 00:50:41.094721 | 49504 | `b4abc613ea3f532d3d4797f147f8d1fb4f1bd4e35714a3e124f79eba66a7744c` |
| `addPickPackOrdersToCart` | 00:50:41.194285 | 49485 | `e78e2cb2d01d2a0403212b8a4cb03c158c7e6be8ed50865706d0918db04ebab9` |
| `deletePickPackCart` | 00:50:41.102426 | 48731 | `5f039dad15005e89e83fcc0c384174fef12d9366d5796f3e7f10b25ebc21fc10` |
| `deletePickPackCartOrders` | 00:50:41.185044 | 48949 | `d2fc16826bfb651f5a89e6d112a1cfa7b478be46ef0246f2d07c59c3023c20c2` |
| `deletePickPackOrderFromCart` | 00:50:41.437712 | 48757 | `42fa0344f4e3c2ce89a11338a81b84c93a9c0dbd5737adb3739c645dcf7ed34c` |
| `getPickPackCartOrders` | 00:50:41.622681 | 49146 | `e7db55239b9a7d34e817da15f0a39af24a832977927d123a1e35245fab5778a5` |
| `getPickPackCarts` | 00:50:41.658745 | 49297 | `12d76898e218fd1c3750bf5dc49755d0023cfeed995b2d129b84f3441f345e31` |
| `getPickPackOrderCart` | 00:50:41.621382 | 49314 | `529d1d62a29e1bf78fe17c56097ba5457a2216d112ed64d3f5c0aea6ddd6a0d1` |

## Wspólna koperta i granice typów

Przykłady oficjalnych stron pokazują POST do
`https://api.baselinker.com/connector.php`, nagłówek `X-BLToken` oraz
formularz z polami `method` i `parameters`; to drugie zawiera serializowany
JSON argumentów. To kontrakt pokazany w przykładach, bez testu transmisji,
HTTP błędów, limitu szybkości, uprawnień tokenu lub rzeczywistego konta.

Każda z ośmiu tabel wyniku zawiera `status: varchar(30)` z wartościami
`SUCCESS` / `ERROR`. W opisie błędu wymienia dodatkowo `error_message`
i `error_code`, ale nie podaje ich typów, zbioru kodów ani formatu konkretnego
błędu. Nie zakładamy, że pola wyniku sukcesu występują również przy błędzie.
HTTP status dokumentacji 200 nie jest dowodem HTTP statusu operacji API.

Typy `int`, `array`, `varchar(5)`, `varchar(7)` i `varchar(30)` poniżej
pochodzą z tabel źródłowych. Nie dopisano zakresu liczbowego, nullowalności,
typu elementu tablicy ani reguł Unicode. Brak osobnego znacznika „required”
nie oznacza opcjonalności; jawnie opisane wyjątki zapisano przy metodach.

## Kontrakty metod

### addPickPackCart

Źródło: [oficjalna strona addPickPackCart](https://api.baselinker.com/index.php?method=addPickPackCart).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `cart_id` | `int` |
| in | `name` | `varchar(5)` |
| in | `color` | `varchar(7)` |
| out | `status` | `varchar(30)` |
| out | `cart_id` | `int` |

Bez `cart_id` tworzy koszyk; tworzenie wymaga `name`, a `color` jest
opcjonalne. Aktualizacja wymaga `cart_id`, zaś `name` i `color` są opcjonalne.
Limit nazwy wynosi pięć znaków; opis koloru wskazuje format hex, np.
`#FF0000`. Bez koloru przy tworzeniu jest on losowany. Nowy koszyk należy
do bieżącego użytkownika i trafia na koniec jego listy. Wynik identyfikuje
dodany lub zaktualizowany koszyk. Nie określono normalizacji koloru,
pustej nazwy, aktualizacji bez zmiany ani zachowania obcego ID.

### addPickPackOrdersToCart

Źródło: [oficjalna strona addPickPackOrdersToCart](https://api.baselinker.com/index.php?method=addPickPackOrdersToCart).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `order_ids` | `array` |
| in | `cart_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `orders_assigned` | `int` |
| out | `orders_failed` | `array` |

Wywołanie przypisuje do 20 zamówień. Zamówienie należące już do innego
koszyka jest przenoszone: przypisanie jest pojedyncze. `orders_assigned`
jest liczbą udanych przypisań, `orders_failed` listą ID nieprzypisanych
z powodu błędów walidacji. Tablice opisano jako identyfikatory zamówień,
bez osobnego deklarowanego typu elementu. Nie ma osobnej adnotacji required
dla obu wierszy wejścia; nie przyjmujemy przez to opcjonalności.

Wynik przewiduje rozróżnienie sukcesów i błędów pozycji; nie zakładamy
atomowości całej listy ani `ERROR` przy każdym częściowym niepowodzeniu.
Nie określono 21. ID, pustej listy, powtórzeń, kolejności failed IDs ani
równości `orders_assigned + len(orders_failed)` z długością wejścia.

### deletePickPackCart

Źródło: [oficjalna strona deletePickPackCart](https://api.baselinker.com/index.php?method=deletePickPackCart).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `cart_id` | `int` |
| out | `status` | `varchar(30)` |

Usuwa koszyk uwierzytelnionego użytkownika i czyści wszystkie jego
przypisania zamówień. Brak osobnego znacznika required dla identyfikatora.
Nie udokumentowano kodu odmowy obcego koszyka, wyniku ponownego usunięcia
ani dodatkowego potwierdzenia listy odpiętych zamówień.

### deletePickPackCartOrders

Źródło: [oficjalna strona deletePickPackCartOrders](https://api.baselinker.com/index.php?method=deletePickPackCartOrders).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `cart_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `orders_removed` | `int` |

Czyści przypisania we własnym koszyku, zachowując sam koszyk. Wynik zawiera
liczbę odpiętych zamówień. Osobnego required nie oznaczono. Nie opisano
nieistniejącego koszyka, ponowienia, współbieżnego dopisywania ani kodu
odmowy obcego koszyka.

### deletePickPackOrderFromCart

Źródło: [oficjalna strona deletePickPackOrderFromCart](https://api.baselinker.com/index.php?method=deletePickPackOrderFromCart).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| out | `status` | `varchar(30)` |

Odpina jedno zamówienie od jego koszyka. Opis ogranicza operację do
zamówień uwierzytelnionego użytkownika. Nie oznaczono osobnego required,
nie określono zachowania już nieprzypisanego zamówienia ani konkretnych
błędów obcego lub nieistniejącego ID. Nie jest to usunięcie zamówienia.

### getPickPackCartOrders

Źródło: [oficjalna strona getPickPackCartOrders](https://api.baselinker.com/index.php?method=getPickPackCartOrders).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `cart_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `orders` | `array` |
| out | `total_count` | `int` |

Zwraca ID wszystkich zamówień koszyka, od ostatnio przypisanego.
Dokumentacja wyraźnie mówi o braku ograniczeń paginacji; nie podaje
parametrów kursora lub strony. `total_count` oznacza liczbę zamówień
w koszyku. Typ elementów `orders` opisano jako ID, bez osobnego typu.
Nie oznaczono required identyfikatora ani stabilności odczytu i kolejności
przy równoległych przypisaniach. Nie dopisano limitu wyniku z innych metod.

### getPickPackCarts

Źródło: [oficjalna strona getPickPackCarts](https://api.baselinker.com/index.php?method=getPickPackCarts).

Tabela wejścia jest pusta; przykład przekazuje `{}`. Nie oznacza to
potwierdzonego zachowania nieznanych dodatkowych parametrów.

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| out | `status` | `varchar(30)` |
| out | `carts` | `array` |
| out | `carts[].cart_id` | `int` |
| out | `carts[].name` | `varchar(5)` |
| out | `carts[].color` | `varchar(7)` |

Zwraca koszyki uwierzytelnionego użytkownika. Trzy pola zagnieżdżone
występują w osobnych wierszach HTML z etykietami `| - cart_id`, `| - name`,
`| - color`; zapis `carts[]` jest ich jawnym odwzorowaniem, nie sklejeniem
nazw. Strona nie deklaruje paginacji, kolejności, filtra ani maksymalnej
liczby koszyków; nie przenosimy tu gwarancji z `getPickPackCartOrders`.

### getPickPackOrderCart

Źródło: [oficjalna strona getPickPackOrderCart](https://api.baselinker.com/index.php?method=getPickPackOrderCart).

| Kierunek | Ścieżka | Typ źródłowy |
|---|---|---|
| in | `order_id` | `int` |
| out | `status` | `varchar(30)` |
| out | `cart_id` | `int` |
| out | `cart_name` | `varchar(5)` |
| out | `cart_color` | `varchar(7)` |

Odczytuje przypisanie jednego zamówienia. Brak przypisania jest
udokumentowany konkretnie jako `cart_id=0`, `cart_name=""`, `cart_color=""`.
Nie zastąpiono tego przez `null`, brak pól lub pustą tablicę. Nie oznaczono
required dla ID, kodów błędów ani odrębnego zachowania obcego zamówienia.

## Niezależna kontrola kompletności pól

Pola spisano z tabel HTML po nagłówkach `Input parameters` / `Output data`,
z zachowaniem separatorów `<br>` i etykiet zagnieżdżeń. Niezależny odczyt
DOM (`HTMLParser`) porównuje każdą nazwę i dokładny typ z powyższymi tabelami
Markdown; nie porównuje jedynie deklarowanych liczników.

| Metoda | Wiersze in | Wiersze out | Z tego out zagnieżdżone |
|---|---:|---:|---:|
| `addPickPackCart` | 3 | 2 | 0 |
| `addPickPackOrdersToCart` | 2 | 3 | 0 |
| `deletePickPackCart` | 1 | 1 | 0 |
| `deletePickPackCartOrders` | 1 | 2 | 0 |
| `deletePickPackOrderFromCart` | 1 | 1 | 0 |
| `getPickPackCartOrders` | 1 | 3 | 0 |
| `getPickPackCarts` | 0 | 5 | 3 |
| `getPickPackOrderCart` | 1 | 4 | 0 |
| **Razem** | **10** | **21** | **3** |

Wynik pokrycia tabel: 10/10 wejść, 21/21 wyjść, w tym 3/3 zagnieżdżenia.
W każdej z ośmiu stron dodatkowo potwierdzono dwa pola błędu wymienione
w prozie (`error_message`, `error_code`): **16 wystąpień**, dwa unikalne
pola o niepodanym typie. Nie policzono ich jako osobnych wierszy tabeli.
Zweryfikowano osiem HTTP statusów, bajtów, hashy HTML, URL i przynależność
wszystkich nazw do grupy indeksu z 17.10. Wszystkie te wyniki dotyczą
źródeł dokumentacyjnych; nie przyznają PASS wykonaniu API.

## Warunki późniejszego sprawdzenia implementacji

Pozostają nieznane: konkretne błędy i ich kody, zakres tokenu/użytkownika,
atomiczność częściowych przypisań, duplikaty, współbieżność, idempotencja
i utrata odpowiedzi. Nie należy automatycznie powtarzać tworzenia lub
przenoszenia po nieznanym wyniku. Zachowanie stock/WMS, zamówień i paczek
nie zostało opisane jako skutek tych metod; nie utożsamiono koszyków
z falami kompletacji, rezerwacją ani operacją split/merge.

Odbiór implementacji wymaga osobnych testów pełnych żądań i odczytu
wyników, własności użytkownika, limitu 20/21, przeniesienia między
koszykami, częściowych odmów, rozróżnienia usunięcia i wyczyszczenia,
kolejności przypisań oraz dokładnego braku przypisania `0/""/""`.
Rzeczywiste zachowanie dostawcy wymaga późniejszej autoryzowanej próby
z kontem; nie zastępuje jej ten publiczny snapshot ani model protokołu.
