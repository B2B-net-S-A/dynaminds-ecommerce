# API Base: źródła kontraktów i otwarty odbiór implementacji

**Aktualizacja18.10.2026 — źródła i odnośniki dla204/204 metod.**
[Rejestr kontraktów](base-api-contract-traceability-20261018.json) wiąże każdą
metodę zamrożonego indeksu ze źródłowym HTML i kontraktem:134 metody mają
pierwotny odnośnik JSON, a70 odnośnik Markdown. [Purchase orders9](base-api-purchase-order-contracts.v1.json),
[Transfers6](base-api-transfer-contracts.v1.json) i [PickPack8](base-api-pickpack-contracts.v1.json)
znormalizowano z zachowanego HTML z18.10; wcześniejsze sekcje Markdown
zachowano jako dodatkową proweniencję. Wszystkie15 paczek źródeł,18 dokumentów
kontraktów, wskaźniki JSON, linie i hashe sekcji sprawdzono niezależnie. Dla11 dawnych źródeł CRM nie zapisano
końcowego URL; rejestr zachowuje NULL/recorded=false zamiast zgadywać przekierowanie.

To komplet odnośników dokumentacyjnych w indeksie204, bez nadania zgodności
implementacji, wire lub konta dostawcy. Te statusy są UNKNOWN;612 pozycji
planu odbioru ma NOT_RUN.70 kontraktów pozostaje wyłącznie w Markdown;
134 kontrakty JSON nadal używa schematów właściwych grupom, bez wspólnego
maszynowego AST wszystkich pól. Rejestr nie mierzy całego pokrycia produktu Base ani
wszystkich integracji. Zachowany spis145/59 poniżej jest historyczny.

**Aktualizacja18.10.2026 — uzupełnienia pobrane po poniższym przeglądzie.**
Zweryfikowano11 paczek i145 różnych indywidualnych stron:111 pobranych17.10
oraz34 pobrane18.10 (8 PickPack,14 Orders i12 układu magazynu). Wszystkie
bajty i SHA HTML są zgodne z wpisami; zestawy są rozłączne i należą do
zamrożonego indeksu204. Pozostaje59 nazw bez indywidualnego HTML w tych
paczkach. [Pełny wykaz145/59](base-api-source-coverage-20261018.json) zachowuje
piny wszystkich11 paczek, daty każdej strony oraz dokładną listę braków.
To pokrycie źródeł dokumentacji, bez pomiaru zgodności implementacji.

Nowe kontrakty: [PickPack8](base-api-pickpack-contracts-20261018.md),
[Orders14](base-api-orders-next-contracts-20261018.md),
[układ magazynu12](base-api-products-next-contracts-20261018.md).
Indeks17.10 i jego historyczne statusy pozostają literalne. Poniższy przegląd
opisuje wcześniejszy stan przed pobraniem tych34 stron; nie jest bieżącą listą
braków. W szczególności brak koszyka ma już udokumentowany wynik w kontrakcie
PickPack, choć dawna tabela poniżej pozostawia go nieznanym.

Przegląd lokalny: **18.10.2026**. Źródła: zapisany indeks i paczki HTML
z **17.10.2026**. Nie pobrano nowych stron. Nie utworzono snapshotu treści
z 18.10 ani nie przypisano takiej treści do wcześniejszej daty.

**Status: documentation-only / source-gap.** Nie jest to kompletny kontrakt
ośmiu metod, implementacja, zgodność wire ani odbiór konta dostawcy.
`implementation_verified=false`, `wire_acceptance=false`,
`provider_account_acceptance=false`, `acceptance_granted=false`.
Centralnego indeksu, matrycy zakresu i kodu nie zmieniono.

## Rzeczywista lokalna dostępność

[Indeks metod](base-api-methods.v1.json) zawiera 204 różne metody.
Osiem lokalnych paczek indywidualnych stron zawiera **111 różnych metod**;
te same 111 nazw występuje w istniejących plikach `*-contracts.v1.json`.
Różnica zbiorów „zapisane indywidualne źródło, lecz brak dokumentu kontraktu”
jest pusta. Pozostają **93 metody indeksowe bez indywidualnego HTML w tych
paczkach**. Liczby opisują dostępność dokumentacji, nie ukończenie produktu
ani jakość implementacji 111 metod.

| Paczka źródłowa w `docs/parity` | Metody | SHA256 dokładnego gzip |
|---|---:|---|
| `base-api-client-sources-20261017.json.gz` | 11 | `b1f15949d2101be724136ec8ea561cfe26a518e7eb8c31314deda7c2a56a7b18` |
| `base-api-courier-sources-20261017.json.gz` | 16 | `b3dc3fee5e1ff738c5e97fc0828ebbc73ee5514070bfb2e262f2a3e90b8c515f` |
| `base-api-document-sources-20261017.json.gz` | 20 | `bc78d68758a8a990fdddd3134d3d0676ae75765fee9f75d3d54b91c4cbbb9fe7` |
| `base-api-inventory-configuration-sources-20261017.json.gz` | 14 | `55e6a8b29cc4882c372b5ed6a6add7e7f005917719e96c43b8b7c3c9c8a1c679` |
| `base-api-inventory-products-sources-20261017.json.gz` | 12 | `f775b0673b090433b39f20598daf857b3c0f5953ecdbde7917021237bdeac5db` |
| `base-api-order-configuration-sources-20261017.json.gz` | 10 | `9f36c3d13f99fb95c8b9cb54390f02dfc2a47bf800e6cb45b900849f6481d559` |
| `base-api-orders-sources-20261017.json.gz` | 7 | `d220a459e9d6050328552d988fbc81a8c73fdfb1b362837e3e441fd5567627c6` |
| `base-api-return-sources-20261017.json.gz` | 21 | `59834def63733ad30e74b98cfa3c2d2e562b1dbde1fdbe9035bd7c18875baae6` |

Zweryfikowano także wszystkie **111** wpisów źródłowych: długość UTF-8 i
SHA256 `html_utf8`/`html` zgadzają się z zapisanymi `bytes`/`sha256`.
Nie było powtórzonych nazw, kontraktów bez odpowiadającego wpisu źródłowego
ani wpisów źródłowych bez dokumentu kontraktu. Sprawdzenie nazw wykonano
przez odczyt JSON paczek i niezależne zbudowanie zbioru z dokumentów
kontraktów; nie polegało na liczniku wpisanym w README.

Przeszukanie nazw lokalnych plików w `local-builds/full-base-preview-20261017`
odnalazło dodatkową prywatną paczkę dawnych 21 stron zwrotów, już objętych
powyższym zakresem. Nie znaleziono tam kolejnej paczki indywidualnych stron
dla wybranej grupy. To ograniczony przegląd lokalnych źródeł, nie twierdzenie
o zawartości wszystkich katalogów użytkownika.

## Wybrana spójna grupa: Orders / PickPack carts

W indeksie z 17.10 znajduje się osiem poniższych metod. Żadna nie występuje
w 111 zapisanych indywidualnych stronach ani w istniejących kontraktach.
Odnośniki są adresami do późniejszego pobrania; podczas tego przeglądu nie
odwiedzono ich przez sieć.

| Oficjalna strona metody | Zachowanie potwierdzone tylko opisem indeksu |
|---|---|
| [addPickPackCart](https://api.baselinker.com/index.php?method=addPickPackCart) | Tworzenie lub aktualizacja koszyka. Przy tworzeniu wymagane `name`, opcjonalne `color`; bez koloru jest on losowany. Aktualizacja wymaga `cart_id`, a `name`/`color` są opcjonalne. Nowy koszyk trafia do bieżącego użytkownika na koniec jego listy. |
| [addPickPackOrdersToCart](https://api.baselinker.com/index.php?method=addPickPackOrdersToCart) | Przypisanie do 20 zamówień w jednym wywołaniu. Zamówienie ma najwyżej jeden koszyk; ponowne przypisanie przenosi je z poprzedniego. |
| [deletePickPackCart](https://api.baselinker.com/index.php?method=deletePickPackCart) | Usunięcie własnego koszyka usuwa również jego przypisania zamówień. |
| [deletePickPackCartOrders](https://api.baselinker.com/index.php?method=deletePickPackCartOrders) | Wyczyszczenie własnego koszyka pozostawia koszyk i usuwa jego przypisania. |
| [deletePickPackOrderFromCart](https://api.baselinker.com/index.php?method=deletePickPackOrderFromCart) | Usunięcie przypisania jednego zamówienia; opis ogranicza operację do zamówień uwierzytelnionego użytkownika. |
| [getPickPackCartOrders](https://api.baselinker.com/index.php?method=getPickPackCartOrders) | Lista ID wszystkich zamówień koszyka, od ostatnio przypisanego; opis wyraźnie nie przewiduje ograniczeń paginacji. |
| [getPickPackCarts](https://api.baselinker.com/index.php?method=getPickPackCarts) | Koszyki bieżącego użytkownika; opis wymienia ID, nazwę i kolor, bez pełnego schematu wyniku. |
| [getPickPackOrderCart](https://api.baselinker.com/index.php?method=getPickPackOrderCart) | Odczyt koszyka jednego zamówienia, jeśli przypisanie istnieje. Dokładna reprezentacja braku przypisania pozostaje nieznana. |

Nie utożsamiamy koszyków PickPack z dzieleniem zamówień, paczkami,
falami kompletacji ani dowodem rezerwacji magazynowej. Tych zależności nie
potwierdza sam opis indeksowy.

## Brakujące części kontraktu

Indeks zawiera opisy i skryptowe przykłady wywołań, lecz nie zastępuje
indywidualnych tabel parametrów i wyników. Przykładu nie traktujemy jako
zamkniętego schematu żądania ani jako dowodu opcjonalności pominiętych pól.

- **Żądanie:** pełne nazwy i typy pól, typ ID, struktura listy zamówień,
  zakresy, wartości domyślne, format koloru i reguły pustych danych są
  niezweryfikowane poza dosłownie wskazanymi wyżej `name`/`color`/`cart_id`.
- **Wynik:** dokładne klucze, typy, opakowanie odpowiedzi, wynik mutacji,
  zwracany identyfikator koszyka i reprezentacja braku przypisania są
  nieznane. „ID, nazwa, kolor” w prozie nie jest pełnym DTO.
- **Błędy:** nie ustalono kodów, komunikatów, częściowego sukcesu,
  zachowania 21. zamówienia, obcych ID, nieistniejących ID ani duplikatów.
  Opis „do 20” nie dowodzi atomowego odrzucenia całej niepoprawnej listy.
- **Spójność:** nieznane są atomowość przenoszenia, współbieżne przypisania,
  idempotencja, zachowanie po utracie odpowiedzi i skutki usuwania ponownie.
- **Odczyty:** brak paginacji jest potwierdzony opisem wyłącznie
  `getPickPackCartOrders`; nie rozszerzono tej właściwości na inne metody.
  Nie określono stabilności kolejności przy równoczesnych zmianach.

## Źródło i granica dalszego kroku

Źródło zachowań: [oficjalny indeks](https://api.baselinker.com/), lokalnie
`base-api-index-20261017.html.gz`, 109757 B po rozpakowaniu.

- SHA256 gzip: `e393496b7277f06e5f49cb81b26acc7f0ea9c65c715f31c439ad2b72ae1a7f3d`.
- SHA256 HTML UTF-8: `142d98570834624cf3889b1d7623410dd6f1470441481a55470f6945386cbe58`.
- SHA256 indeksu JSON: `7e6b10f8fd105973ec99926372fcc7ae3ec6a2496514d3d45d2cc59af4c7d992`.

Zestaw ośmiu nazw/URL porównano z rzeczywistymi wierszami tabeli HTML
`PickPack carts`; nie użyto zgadywania nazw na podstawie podobnych metod.
Nie uznano tej kontroli za kompletność pól indywidualnych stron.

Następny krok to osobne pobranie ośmiu oficjalnych stron i zapis ich
rzeczywistej daty, bajtów i SHA256. Jeśli będzie to 18.10 lub później,
powstanie jawnie późniejszy snapshot uzupełniający zakres indeksu z 17.10.
Przed uznaniem dokumentacji za kompletną trzeba niezależnie policzyć
wszystkie wiersze i zagnieżdżone pola wejścia/wyjścia, zachować separatory
DOM oraz zanotować sprzeczności i braki. Implementacja, test wire oraz
test z rzeczywistym kontem pozostają odrębnymi etapami bez przyznanego PASS.
