# Rozdzielanie zamówień Base — kontrakt źródłowy i kryteria pionu OMS

Przegląd publicznych źródeł: **2026-10-17**. Status: `DOCUMENTED_PARTIAL_CONTRACT`, `implementation_verified=false`, `acceptance_granted=false`, `provider_account_verified=false`. Nie zmieniono scope ani istniejących kryteriów odbioru. To przygotowanie implementacji, bez aplikacji, SQL, kont dostawców i testów operacyjnych. Nie zapisano lokalnego snapshotu HTML; nie deklarujemy hasha archiwum, którego nie ma.

## Bezpośrednie źródła oficjalne

| ID | Źródło | Co rzeczywiście ustala |
|---|---|---|
| S1 | [Rozdzielanie zamówień — nowa funkcja w Managerze Zamówień](https://base.com/pl-PL/blog/rozdzielanie-zamowien-nowa-funkcja-w-managerze-zamowien/) — publikacja 19.10.2017, aktualizacja 10.12.2025 | Formularz podziału, punkty wejścia, tryb ręczny/transakcyjny, produkty, wysyłka i opłacenie. |
| S2 | [Spis aktualizacji — styczeń 2026](https://base.com/pl-PL/blog/spis-aktualizacji-styczen-2026/) — publikacja 15.02.2026, aktualizacja 10.03.2026; sekcja „Zamówienia” | Rozszerzenie z dwóch na wiele wynikowych zamówień; górna granica zależy od liczby sztuk. |
| S3 | [Karta zamówienia](https://base.com/pl-PL/pomoc/wiedza/karta-zamowien/) — sekcje „Informacje o zamówieniu”, „Informacje dodatkowe”, FAQ | Osobna akcja rozdzielania; historia zamówienia; starsza instrukcja duplikacji i ręcznej edycji. |
| S4 | [Paragony](https://base.com/pl-PL/pomoc/wiedza/paragony/) — opis zakresu dokumentu | Paragon dotyczy całego zamówienia; wystawienie dla części wymaga wcześniejszego rozdzielenia. |
| S5 | [Spis aktualizacji — wrzesień 2025](https://base.com/pl-PL/blog/?p=23326) — publikacja 13.10.2025, aktualizacja 3.11.2025 | Akcja automatyczna podziału działa analogicznie do podziału z listy zamówień. Szczegółowego schematu wejścia nie podano. |

Daty publikacji nie są datami wdrożenia na konkretnym koncie. Przejrzano publiczną treść, bez wykonania operacji w Base.

## Potwierdzone zachowanie produktu

1. **Osobne zamówienia.** Użytkownik rozdziela jedno zamówienie na kilka zamówień z wyborem produktów dla poszczególnych wyników. Punkty wejścia to lista zamówień → Akcje oraz karta → Informacje o zamówieniu → Akcje. To dedykowany formularz, opisany niezależnie od kopiowania. [S1](https://base.com/pl-PL/blog/rozdzielanie-zamowien-nowa-funkcja-w-managerze-zamowien/), [S3](https://base.com/pl-PL/pomoc/wiedza/karta-zamowien/).
2. **Więcej niż dwa wyniki.** Zmiana ze stycznia 2026 pozwala użytkownikowi określić liczbę wynikowych zamówień, najwyżej równą liczbie sztuk produktów. Pion ograniczony do dwóch wyników nie pokrywa tego udokumentowanego rozszerzenia. Nie wynika z niego precyzyjna reguła dla ilości ułamkowych, pustego wyniku ani zachowania ID pierwotnego zamówienia. [S2](https://base.com/pl-PL/blog/spis-aktualizacji-styczen-2026/).
3. **Wariant ręczny i transakcyjny.** Starszy opis podaje podział ręczny oraz zgodny z transakcjami Allegro/eBay, gdy istnieją dwa FOD. Nie ustala współczesnego schematu transakcji, bieżących ograniczeń tych integracji ani zewnętrznych skutków podziału. [S1](https://base.com/pl-PL/blog/rozdzielanie-zamowien-nowa-funkcja-w-managerze-zamowien/).
4. **Decyzje per wynik.** Formularz pozwala wskazać produkty, sposób i cenę wysyłki oraz oznaczenie opłacenia wynikowych zamówień. Oznaczenie opłacenia nie dowodzi podziału rzeczywistych wpłat lub wywołania transferu pieniędzy. [S1](https://base.com/pl-PL/blog/rozdzielanie-zamowien-nowa-funkcja-w-managerze-zamowien/).
5. **Związek z dokumentami i automatyzacją.** Rozdzielenie poprzedza wystawienie paragonu obejmującego tylko część pierwotnego koszyka; dostępna jest też akcja automatyczna podziału. Nie opisano migracji już wystawionych dokumentów ani wire/API tej akcji. [S4](https://base.com/pl-PL/pomoc/wiedza/paragony/), [S5](https://base.com/pl-PL/blog/?p=23326).

**Rozbieżność źródeł:** FAQ karty nadal zaleca kopię i usuwanie wybranych pozycji z obu zamówień. S1 przedstawia tę procedurę jako poprzedni sposób, zastąpiony formularzem; S2 opisuje dalsze rozszerzenie. Nie uznajemy starszego FAQ za dowód, że aktualny split jest sekwencją nieatomowych operacji kopiowania/usuwania. Nie ustalono też pełnych reguł aktualnego formularza na podstawie samego changelogu.

## Granice: zamówienie, paczka, merge

| Operacja | Jednostka wyniku | Granica niniejszego kontraktu |
|---|---|---|
| Split OMS | Kilka odrębnych zamówień z przypisaniem produktów | Właściwy zakres; potrzebne osobne ID, pozycje i późniejszy odczyt każdego wyniku. |
| Wiele paczek/przesyłek | Przesyłki przypięte do zamówienia | Samo dodanie trackingów, etykiet, paczek lub koszyków zbierania nie dowodzi utworzenia zamówień. Karta opisuje przesyłki jako osobną sekcję. [S3](https://base.com/pl-PL/pomoc/wiedza/karta-zamowien/). |
| Merge OMS | Połączenie kilku zamówień | Istniejący merge nie definiuje odwracalnego splitu. Nie wolno odwracać jego zapisów finansowych, fizycznych czy dowodów jako domniemanej semantyki Base. |

## Jawnie nieustalone przez te źródła

| Obszar | Unknown wymagający osobnej decyzji i dowodu |
|---|---|
| Pozycje i ilości | Precyzja, dzielenie pojedynczego wiersza na części, ilości ułamkowe, zestawy i komponenty, rabaty jako pozycje, warianty, granice sum oraz puste wyniki. Limit sztuk z S2 nie rozstrzyga tych przypadków. |
| ID i pochodzenie | Który wynik zachowuje pierwotne ID; nowe ID zamówień/pozycji; oryginalne marketplace/order-product IDs; przechowanie zewnętrznych numerów; źródło, import i deduplikacja ponownego pobrania. |
| Historia | Czy i jak kopiowane są wcześniejsze logi, komentarze, załączniki, daty, statusy, kontakty i zdjęcia. Ogólna historia karty nie definiuje lineage splitu. |
| Koszty i podatki | Domyślne rozłożenie wysyłki, rabatów, walut, netto/VAT/brutto oraz reszt zaokrągleń. Możliwość podania ceny dostawy nie dowodzi zasady zachowania jej sumy. |
| Płatności | Podział rzeczywistych zdarzeń wpłat, sald, pobrań, zwrotów, provider payment IDs i linków płatności; różnica między oznaczeniem „opłacone” a rozliczeniem księgowym. |
| Rezerwacje i fizyczna realizacja | WMS OFF/ON, rezerwacje, alokacje lokalizacji/partii/seriali, pobrane i zeskanowane sztuki, rozpoczęte pakowanie, WZ, paczki, etykiety i wysyłki częściowe. |
| Dokumenty | Split po fakturze/paragonie/korekcie, relacje dokument→pozycja/odbiorca, numeracja, anulowanie, zewnętrzne załączniki, fiskalizacja i zgłoszenia państwowe. |
| Dostęp i atomowość | Role, API scopes, powtórzenia, klucz idempotencji, transakcja, rollback, timeout, utrata ACK, konflikty równoległych edycji, schemat request/response i kody błędów. |
| Automaty i integracje | Parametry/warunki akcji split, wyzwalanie kolejnych reguł, rekurencja, import/sync po podziale oraz rzeczywiste skutki w Allegro/eBay. |

## Mierzalne kryteria proponowane dla DYNAMINDS

Poniższe warunki są **naszą specyfikacją poprawności**, nie twierdzeniem o nieopisanej implementacji Base. Wszystkie pozostają niewykonane. Początkowy pion może odmówić przypadków bez uzgodnionej semantyki; odmowa jest bezpieczną granicą, a nie odbiorem pełnej zgodności.

| ID | Wymagany wynik i dowód odbioru |
|---|---|
| SPLIT-01 | Zwykły UI/API tworzy wybrane N odrębnych wyników w jednym logicznym wykonaniu, w tym N=2, N=3 i granicę N=suma sztuk dla dodatnich ilości całkowitych. Przypadki poza ustalonym modelem mają jawną odmowę bez zapisów. Odczyt każdego wyniku potwierdza własne ID i dokładny zakres. |
| SPLIT-02 | Dla każdej pierwotnej pozycji suma przydzielonych ilości jest dokładnie równa ilości wejściowej; brak utraty, zdublowania i niejawnego pominięcia. Próby ilości ujemnych, przekroczenia, obcego item ID, pustego przydziału i zmiany produktu odmawiają. Sposób reprezentacji ilości i zestawów musi być jawnie uzgodniony przed obsługą. |
| SPLIT-03 | Trwały dowód zapisuje oryginalny actor/tenant, klucz, dokładne body/hash, wersję źródła, mapę source_order/source_item→wynikowe order/item/ilość oraz odczytywalne before/after. To pochodzenie nowej operacji, nie przerobione stare logi. Historia pozwala przejść od każdego wyniku do źródła i wszystkich pozostałych wyników. |
| SPLIT-04 | Wysyłka i oznaczenie opłacenia mają jawne decyzje per wynik oraz potwierdzony podgląd. Wybrany model rozdziału wartości obejmuje grosze, podatki, rabaty, sumy i reszty; test wykazuje dokładne uzgodnienie lub osobno zatwierdzoną zmianę wartości. Nie tworzy się fikcyjnych wpłat przez samo ustawienie statusu opłacenia. |
| SPLIT-05 | Rzeczywiste wpłaty/zwroty i provider IDs mają jeden ślad źródłowy. Przed/po uzgadnia się wszystkie efekty finansowe; zero podwójnego rozliczenia. Dopóki model podziału finansów nie został zaprojektowany i sprawdzony, finansowo obciążone przypadki odmawiają zamiast kopiowania sald do każdego wyniku. |
| SPLIT-06 | Dla WMS OFF i ON uzgadnia się stock, rezerwacje, picks/scans, lokalizacje, partie/seriale i dokumenty ruchu. Dozwolony transfer przypisania jest ilościowo zachowawczy, bez nowego przychodu/rozchodu; brak oversell i utraty custody. Rozpoczęta realizacja, istniejąca paczka/WZ lub dokument sprzedaży wymagają osobnej polityki i rzeczywistego testu albo jawnej odmowy bez zmian. |
| SPLIT-07 | Aktualne IAM i tenant/source-version obowiązują przed blokadą, po oczekiwaniu i przed COMMIT. Obcy actor/tenant/key, cofnięcie dostępu i równoległy merge/split/edycja nie mogą dać częściowego wyniku. Failure injection przed COMMIT pozostawia wszystkie źródłowe fakty bez zmian. |
| SPLIT-08 | Oryginalne body/key są zachowane przed POST także po remount/odświeżeniu i między kartami. Utrata ACK zatrzymuje nowe zapisy dla nierozstrzygniętej próby. Odczyt oryginalnej komendy sprawdza actor/tenant/key/body i wszystkie wyniki; 404 nie dowodzi rollbacku ani nie uprawnia do nowego klucza. Brak automatycznego POST/replay. |
| SPLIT-09 | Worker/akcja automatyczna używa tej samej reguły podziału i dowodu, z kontrolą uprawnień, deduplikacją, ograniczeniem rekurencji i uzgodnieniem nieznanego wyniku. Sam przycisk UI nie jest odbiorem akcji automatycznej. |
| SPLIT-10 | Na tej samej końcowej lokalnej rewizji potwierdza się: wizualny UI, zwykły API readback, trwałe fakty PG, niezmienione dokumenty/journale poza jawnym efektem, restart/recovery i zachowanie importu/synchronizacji. Lokalny model protokołu nie nadaje zgodności konta dostawcy; tryb transakcyjny Allegro/eBay wymaga osobnego dowodu, gdy dostęp będzie autoryzowany. |

Następna decyzja implementacyjna: zamrozić dokładny model przydziałów i macierz dozwolonych stanów źródłowego zamówienia, z osobnym modelem płatności i rezerwacji. Nie zaczynać od „inverse merge” ani sekwencji clone/delete. Ten dokument nie aktywuje modułu i nie zamyka żadnego z powyższych kryteriów.
