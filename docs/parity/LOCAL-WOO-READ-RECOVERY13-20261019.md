# Odczyty Woo: N13, anulowanie i częściowy odbiór katalogu

**Zwykły start, zachowanie danych, anulowanie oraz dwa naturalne odczyty katalogu PASS w opisanym zakresie. Odczyt zamówień pozostaje nierozstrzygnięty.**

N12 poprawnie zainstalował212, lecz pierwsze włączenie harmonogramu w zwykłym
panelu ujawniło błąd500. PostgreSQL potwierdził42P08 dla odstępu integer/double
precision i42883 dla kanału text/uuid. Zapis konfiguracji nie został ponowiony;
UI zachował oryginalne polecenie, a odczyt jego wyniku zwrócił UNKNOWN.
[Historia N12](LOCAL-WOO-READ-LANES212-20261019.md) zachowuje ten nieudany odbiór.

## Zmiana

- Jawne typy parametrów SQL bez zmiany schematu, limitów ani zakresu kanałów.
- Jawne anulowanie niepotwierdzonego polecenia na podstawie tej samej treści
  i klucza. Konfiguracja i anulowanie blokują ten sam własny kanał.
- Gdy wcześniejszy zapis już się zakończył, anulowanie zwraca jego zapisany ACK
  bez cofania ustawień. Gdy anulowanie wygra, trwały wynik blokuje późniejsze
  wykonanie oryginalnego polecenia. Brak ACK nadal pozostaje UNKNOWN.
- Istniejący control zachowuje wszystkie ustawienia i wersję, również gdy jest
  włączony. Przy pierwszym poleceniu powstaje wyłącznie wstrzymany wpis v1.
- UI zachowuje wynik anulowania i wcześniejszą próbę; kolejne polecenie wymaga
  świeżej wersji konfiguracji oraz nowego klucza. Brak automatycznego ponawiania.

## Weryfikacja źródeł i wydanie

Lokalny commit funkcji: `87f96a559a0ece65cdb04975b69e80bc2c6794f6`.
73 testy core/tras/UI/wiring oraz typecheck PASS. Rzeczywisty PostgreSQL
przeanalizował wszystkie35 literalnych zapytań core przez PREPARE, bez EXECUTE,
w RRRO przy8s/9s; ROLLBACK i zamknięcie potwierdzone.
Receipt: `8188536e02701bbbcec91fe9ec87f0ba747dfd7045ae30b4ef6de5eac4746d31`.
Testy kontrolowane nie zastępują rzeczywistych wyścigów dwóch instancji PG.

Kontrakt źródeł `7d22d93890cae609aea22391988753a86bb8222c45ef17aabf6be0675f829d6f`
zmienia dokładnie core, trasy i UI;74 pozostałe pliki, cały inwentarz i graf30
zasobów Native pozostają identyczne z N12. Pełny inverse manifestu sprawdzony.
Nie powtarzano instalacji DDL. Historyczne testy N12 zachowują dokładne dawne
bajty trzech źródeł i nadal przechodzą7/7.

Świeży Vite i backend z izolowanych1292 plików commita; bez instalacji zależności.
Wszystkie386 plików wydania sprawdzone:100361013B, limity16/96MiB zachowane.
Wydanie: `085237ffe4e46853da344d44cee409df3ae19167f23f08547192a4a5614bf1d3`.

Zwykły stop N12 zakończył się EXIT0. Zwykły start N13 na tej samej bazie,
konfiguracji, pięciu sklepach i porcie4105 osiągnął READY z procesorem odczytów.
Pozostałe workery globalne/scoped wyłączone. Cały health poza rewizją jest
identyczny z N12. READY: `b5c24c16a969cbaa866b513b567f1570c5bc2ecbb9c699f016f07d9502791ea8`.

Odczyt wszystkich631 tabel przed interakcją:630 pełnych hashy identycznych;
w jednym wierszu zatwierdzenia zmienił się wyłącznie release SHA. Generacja1769,
validated1769, dirtyfalse i pozostałe pola bez zmian; cztery tabele212 puste.
Receipt: `eda68f2ed7fbb11193b43f4080eb09b8cd932e9d8bea6dcd3b66803e5b4edd24`.

## Rzeczywiste anulowanie w panelu firmy A

Po przeładowaniu Chrome zachował oryginalną niepewną próbę. Jedno kliknięcie
„Anuluj niepotwierdzone polecenie — Zamówienia” pokazało:
„Nie wykonano polecenia; zachowano dotychczasowe ustawienia”. Harmonogram
pozostał wstrzymany; przycisk wznowienia odblokowany. Katalog nadal bez zgody.

Osobny końcowy odczyt PG potwierdził dokładny hash oryginalnej treści i własnego
scope, jeden trwały wynik anulowania pod tym samym kluczem, jeden wstrzymany
control v1 i jeden nowy wpis audytu. Pozostałe628 tabel w całości identyczne;
cały dawny hash audytu odzyskany po odjęciu dokładnie nowego wiersza. Brak
nowych jobs, occurrences lub dispatches. RRRO/ROLLBACK/end PASS.
Receipt: `746f8b75b055c6449c3ebe88153c715f8d36e1592a4af87a6e03c554b02e467a`.

## Naturalne odczyty: katalog PASS, zamówienia nadal OPEN

Nowy baseline37 GET potwierdził w firmie A wyłącznie wstrzymany wpis zamówień
v1 po anulowaniu, bez katalogu i historii; B–E bez konfiguracji i historii.
Pełne biznesowe i natywne DTO pięciu sklepów zgodne z wcześniejszym odbiorem.
Receipt: `48abf59fe0430cc175631e7f723146a635951e8a33a14f6f1c5e9d34354ea334`.

Po włączeniu przez UI zamówień v2 i katalogu v1 obserwator naturalnych terminów
zakończył się EXIT1 po180s: zamówienia nie osiągnęły DONE. Zachowano próbę,
bez ponawiania polecenia lub zadania. Firma A została wstrzymana przez UI;
audyt odczytał zamówienia v3 i katalog v2, oba wyłączone z next_at=NULL.
Nieudana próba: `f760f6ff96637c2fa65b49f6dec74cdf9dbaf809a994d248a793fe1bac3ceb94`.

Osobny audyt GET zakończył się EXIT0:45 GET200,0 POST/SQL i0 zapisów natywnych.
Potwierdził:

- Dwa naturalne wykonania katalogu v1: każde DONE, po7 wpisów staged o ID
  `11,12,15,17,19,21,29`, po jednym potwierdzonym dispatchu, zgodny łańcuch
  checkpointu i job DONE bez aktywnej dzierżawy. Nie zatwierdzano katalogu.
- Jedno wykonanie zamówień v2 nadal running; job running z aktywną dzierżawą.
  Odczytano jego stan, bez przetwarzania, resetu lub ponowienia. Brak odbioru
  automatycznego odczytu zamówień i brak deklaracji jego bezpiecznego zakończenia.
- Początkowa i końcowa historia zawierały dokładnie te same trzy wykonania.
  Nie usunięto ani nie pominięto późniejszego katalogu; w tym oknie go nie było.
- B–E nadal bez konfiguracji i historii. Wszystkie pięć porównań inventory,
  zamówienia i płatności oraz natywnych products/orders zgodne z odbiorem stocku
  A7→8 i pozostałych Woo7. Jedyną projekcją porównania produktów jest wcześniej
  zweryfikowane, ograniczone related_ids; pozostałe pola porównano w całości.

Wynik audytu: `16f8adc424481f833111fb652c7d5e866c7c3929ed753e5dc2149592f0ad53a2`
(253821B), `local-woo-read212-recovery13-partial-audit-prepared-agent-20261019-01/partial-audit01/result.private.json`.
Wszystkie45 zapisanych intent/ACK, statusy200, hashe odpowiedzi i przypięty TLS
natywnych GET sprawdzono niezależnie na plikach. Nie powtarzano żądań.

Dodatkowa diagnostyka tylko do odczytu nadal widzi job running/page1/errorNULL.
Jedyny integration_run DONE oraz12 inboundów pochodzą ze starego ręcznego
odczytu; brak nowego run dla próby23:00. Nie dowodzi to wyjątku ani potwierdzonego
rollbacku procesora. Receipt: `5f3947a435a5e9282bc4e5f06ceae3284483a76004b28ebcae6868206d16a7ac`;
ROLLBACK/end tej diagnostyki potwierdzone.

To częściowy odbiór katalogu oraz zachowania opisanych DTO, nie całej automatyki
ani pełne uzgodnienie wszystkich tabel po cyklach. Otwarte pozostają zamówienia,
bezpieczne zakończenie aktywnej pracy po pauzie, wznowienie i restart, utrata ACK
anulowania i rzeczywiste wyścigi PG, pięć aktywnych firm, zatwierdzanie wyników automatycznych odczytów,
automatyczne zapisy stocku/cen, skala oraz pełny Goal.
