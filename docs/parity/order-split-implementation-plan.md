# OMS split 1→N — plan minimalnego bezpiecznego wdrożenia

**Aktualizacja18.10:** nieaktywny składacz210 został przeniesiony na odebranego
rodzica Source22b; obejmuje14 pełnych zastępstw i19 etapów. Root porównał wszystkie
10 deskryptorów warstwy209 z odebranym kontraktem22b. To dowód wyprowadzenia
źródła, bez nowej kompilacji PostgreSQL, Native210 lub działającego podziału.
[Bieżące bramy](order-split210-native-progress.md) pozostają wymagane przed
rejestracją migracji i włączeniem tras/UI.

Stan przeglądu: **2026-10-18**. `FOUNDATION_WITH_SQL_CAPTURE`, `runtime_implemented=false`, `acceptance_granted=false`. Nie wykonano migracji, DML ani kompilacji schematu split; odczyt źródłowy sprawdzono na istniejącej kopii208 z rollbackiem, bez uruchomienia procesu podziału. Plan rozwija [kontrakt publicznej pomocy](order-split-base-contract.md), a nie zamyka zgodności z Base. Numer **209 został przydzielony dziedziczeniu dostawy MERGE**, a **210** nieaktywnemu kandydatowi splitu; jego [stan i brakujące bramy](order-split210-native-progress.md) nie oznaczają odbioru wykonania SQL.

**Aktualny etap fizyczny.** Commity `a70d17e`, `eeb9ddd` i `2667e58`
dostarczają planner zachowania custody oraz `captureOrderSplitSourcesInTx`
z kompletem czterech rzeczywistych zbiorów i metadanymi lot/FIFO/expiry.
Odczyt używa zwykłej roli `dyna_app`, blokad polityki/operacji WMS i tej samej
transakcji co commercial frame. Pierwszy rzeczywisty odczyt ujawnił42501:
`FOR SHARE` na tabelach dostępnych bez UPDATE. Oryginalny błąd zachowano;
naprawa korzysta z istniejącej synchronizacji i nie zwiększa uprawnień.

Poprawiony [rzeczywisty odczyt](../../../../local-builds/full-base-preview-20261017/order-split-physical-whitebox11-corrected-prepared-1792279076059/run/receipt.private.json)
(`5eb58efa…`, source `dd95da3f…`) przeszedł na dwóch istniejących zamówieniach
podglądu11/208, z końcowym rollbackiem i zamknięciem połączenia. Każde ma WMS OFF:
jedną rezerwację, pick i lokalizację, zero warstw. Oba kalkulatory prawidłowo
odmówiły przez `UNSUPPORTED_SOURCE_BINDING` klasyfikowanego odbiorcy.
Nie jest to dodatni eligible split, rzeczywisty WMS ON, write/API/UI ani odbiór
request IAM. WMS ON i ilości sprawdzono dotąd w testach kontrolowanych;
Root wykonał45/45 przed poprawką oraz10/10 capture po poprawce, bez pominięć.

## Wykonany pierwszy etap: DTO i obliczenia

`server/order-splits-schema.ts` i `server/order-splits-values.ts` zawierają
ścisłe wejścia preview/execute i pełną projekcję faktów źródła oraz czysty
kalkulator przydziałów. Dzieci mają stabilne nazwane sloty, źródło zachowuje
niepustą pozostałość; ilości i kwoty są zachowane bez nowych identyfikatorów,
kopii wpłat lub ponownego rezerwowania towaru. Fakty wejściowe JSON nie są
bieżącą autoryzacją ani dowodem fizycznej custody.

Koordynator wykonał25 testów, wszystkie PASS/0 skip, oraz pełny typecheck
aktualnego etapu. Niezależny test obejmuje1080 małych przypadków z własnym
modelem niepodzielnych groszy. To testy prawdziwego kalkulatora na syntetycznych
faktach źródła, bez przyznania odbioru API, Native lub UI.
Zwykłe API ujawniło błędne pierwotne założenie receptury w teście: prosta
pozycja zamówienia przechowuje jeden fizyczny składnik będący samym produktem,
a pusta definicja dotyczy produktu w katalogu. Kontrakt poprawiono do
dokładnego self-tuple ilości1. Nowy test wykonuje rzeczywistą gałąź
`domain.createOrder`, z zabronionym dostępem do DB. Puste/obce/wielokrotne
receptury pozostają odrzucane; nie podmieniono ich na domniemany poprawny stan.
Niezależny mały oracle sprawdził744 kombinacje:744 zgodne, w tym376 planów
prawidłowo zablokowanych przez konflikt zaokrąglenia VAT; aktualny ponowny
pomiar używa prawdziwej receptury pozycji zamówienia. Przykład:3 sztuki
po1 groszu przy23% VAT zachowują sumy pierwotnej linii, ale standardowe
ponowne przeliczenie każdej nowej linii gubi grosz VAT. Kalkulator zachowuje
kandydata i zwraca `ready=false` oraz `VAT_ROUNDING_CONFLICT`; przyszły service
i Native muszą tę odmowę egzekwować. Pełna obsługa reszt w FV/korektach
pozostaje wymagana. Historyczne kwoty pozycji różne od ceny razy ilość są już
zachowywane jako autorytatywna wartość źródłowa, bez ponownej wyceny. Jawnie
przekazany rabat jest osobnym faktem i musi uzgadniać się z ceną, ilością oraz
wartością pozycji; samą różnicę kwot pokazujemy jako korektę wartości, bez
zgadywania jej przyczyny. Przydział netto według skumulowanych groszy brutto
zachowuje całe źródłowe netto i VAT oraz nie tworzy ujemnego podatku. Konflikt
ze standardowym przeliczeniem faktury zwraca `VAT_ROUNDING_CONFLICT`, a
niedopuszczalna reszta wartości pozycji według obecnej reguły157 zwraca
`INVOICE_LINE_ROUNDING_CONFLICT`; oba pozostawiają `ready=false`.
Wcześniejszy split/merge, historie płatności, dokumentów, RMA i częściowej
realizacji pozostają w tym etapie odrzucane.

Dostawa ma odrębny jawny budżet brutto; nie wywodzimy jej VAT ze stawki
produktu. Komponent `web/order-split-allocation.tsx` umożliwia edycję wielu
wyników, ilości i jawnych kosztów dostawy, pokazuje pozostałe sztuki i zachowuje
tożsamość przydziałów. Nie oblicza autorytatywnych kwot dzieci ani VAT.
Koordynator wykonał15/15 testów rzeczywistego React bez transportu; sprawdził
także usunięcie dwóch wyników w jednym obiegu zdarzeń i wiele odrębnych pozycji
przekraczających pozorny zbiorczy limit pojedynczego produktu. Trwały stan
nieuzgodnionej komendy pozostaje odpowiedzialnością przyszłego rodzica.
Nie ma endpointu, tabel, transferu rezerwacji ani aktywowanej funkcji;
komponent nie jest jeszcze osadzony w procesie obsługi zamówienia.
Ten etap nie nadaje odbioru podziału zamówienia.

Dodano również `web/order-split-custody.ts`: osobny trwały zapis dokładnego
body/klucza, blokadę Web Locks i ręczne uzgodnienie pierwotnej komendy po
utracie odpowiedzi. Pełny odczyt źródłowych ilości, przydziałów wszystkich
dzieci i pozostałego kosztu dostawy poprzedza wyczyszczenie intencji;404,
niepełne strony i utrata uprawnień zachowują zapis. Sloty wyników są wiązane
po tożsamości, niezależnie od kolejności UUID i stron. Koordynator potwierdził
11/11 testów rzeczywistych eksportów; niezależny przegląd odtworzył i zamknął
dwie luki dotyczące kosztu dostawy i kolejności slotów. Moduł nie wykonuje
transportu, nie jest osadzony w kontrolerze i opisuje przyszły kontrakt API.
Kwoty netto/VAT, stock, finanse i wykonanie Native nadal wymagają integracji
oraz rzeczywistego odbioru; sam ten zapis nie stanowi działającego splitu.

`server/order-split-source.ts` przechwytuje aktualne fakty pod blokadą źródła:
pozycje, rezerwacje, bieżące warstwy fizyczne oraz pełną historię finansową,
dokumentową i realizacji. Liczy rzeczywiste kontrole płatności024, próby importu077
(także queued przed ledgerem), alokacje124 i zadania źródłowe; zerowe saldo po
odwróceniu wpisu nie ukrywa historii. Zastąpiono wcześniejsze umowne nazwy
liczników faktycznym modelem bazy. Brak obsługi seriali pozostaje luką produktu.
Po instalacji jakiegokolwiek namespace split wymagany będzie rzeczywisty reader
lineage; obecne zero jest dozwolone wyłącznie po potwierdzeniu nieobecności
tego schematu. Minimalny frame kwalifikacji nie zastępuje przyszłego snapshotu
całego nagłówka, dziedziczenia cennika/adresu ani dowodu transferu.

Koordynator potwierdził pełny typecheck projektu i42 testy bez pominięć
(6 capture,25 kalkulatora i11 custody). Następnie [rzeczywisty odczyt SQL dwóch
istniejących zamówień](../../../local-builds/full-base-preview-20261017/order-split-source-whitebox11-prepared-1792278012592/run/receipt.private.json)
na kopii11/208 zakończył się EXIT0: dwa kompletne frame, ten sam tenant/backend/
transakcja, przywrócona rola, ROLLBACK i zamknięcie klienta. Oba miały istniejący
sidecar adresowy, więc kalkulator prawidłowo odmówił `UNSUPPORTED_SOURCE_BINDING`.
Nie wykonano DML, HTTP, nowego seedowania ani modyfikacji zamówień. To odbiór
rzeczywistego odczytu i odmowy; dodatnia kwalifikacja na PG, request IAM,
wykonanie splitu, Native, publiczne API/UI i transfer rezerwacji pozostają otwarte.

## Dwa osobne kontrakty wejściowe

Publiczne [addOrderBySplit](https://api.baselinker.com/index.php?method=addOrderBySplit) tworzy jedno nowe zamówienie przez przeniesienie wybranych produktów z istniejącego. Przyjmuje `order_id:int`, `items_to_split:array` z `order_product_id:int` i `quantity:int` nieprzekraczającym ilości źródłowej, a opcjonalnie `delivery_cost_to_split:float`. Przenoszony koszt dostawy jest odejmowany od źródła i przypisywany nowemu zamówieniu; nie może przekroczyć ceny źródłowej. Wynik zawiera `status` i `new_order_id:int`. Opis mówi o dziedziczeniu wszystkich pól/informacji; nie rozstrzyga dziedziczenia zdarzeń płatności, rezerwacji czy wystawionych dokumentów.

Źródło odczytane z istniejącego publicznego [snapshotu Orders](base-api-orders-sources-20261017.json.gz), SHA256 `d220a459e9d6050328552d988fbc81a8c73fdfb1b362837e3e441fd5567627c6`; strona pobrana `2026-10-17T20:56:19.933479+00:00`, 50278 B, HTML SHA256 `9686d4f42a2d53476505475f208d74b6455abaaabb8a2dc0e58546784c69b258`. Szczegółowy [kontrakt siedmiu metod Orders](base-api-orders-contracts.v1.json), SHA256 `7c94dea8645a575b4a326dafda86d314bc03bdd44e7e52ffee5a81a37e8a6534`, pochodzi z odrębnego zakresu dokumentacji; nie powtarzamy jego inwentaryzacji ani nie nadajemy zgodności wire.

Lokalny formularz 1→N może proponować jednoczesny plan podziału na pozostałość źródła i N−1 nowych zamówień. Atomowość całej tej operacji będzie **własną gwarancją lokalną**. Nie wywodzimy jej z wielokrotnego wywołania publicznego addOrderBySplit. Dokumentacja funkcji UI Base opisuje wiele wyników; API opisuje jeden nowy wynik na wywołanie. Identyfikatory lokalne UUID nie staną się integer ID Base przez zmianę nazwy DTO; adapter wire i jawne mapowanie ID wymagają osobnego odbioru.

## Istniejące mechanizmy i granice ponownego użycia

| Kod / Native | Co wykorzystać | Czego nie traktować jako gotowego splitu |
|---|---|---|
| `server/order-merges.ts`: `capture`, `admission`, `requestHash`, preview/execute, paginowane dowody | Zamrożony scope, jawne blokery, wersje, źródłowe pozycje, current IAM, oryginalne klucze, audit, końcowe constraints i readback | Modele zakładają wiele źródeł i jeden cel. Nie zapisujemy splitu w tabelach merge. |
| `server/103_order_merges.sql` | Wzorzec tenant RLS/FORCE, niezmiennych dowodów, limitów bajtów, deferred completeness i ACL | `order_merge_claims` ma pojedynczego właściciela realizacji; nie jest krawędzią przydziału ilości 1→N. |
| `server/104_order_merge_custody.sql`, następca `145_order_merge_counters.sql`; `order-merge-custody.ts` | Rzeczywiste snapshoty reservations/locations/layers/picks/stock/bins/positions; lock order; kontrola consumed/released i planów paczek | Transfer wymaga autentycznego execution merge, ≥2 źródeł, jednego celu. Wpisanie fałszywego merge albo podanie GUC „skip” jest niedopuszczalne. Stan `transferred` jest chroniony istniejącym row guardem. |
| `server/domain.ts`: `createOrder`, `getOrder`; `buyer-address.ts` | Enlist aktora, buyer-installation/effective delivery, bezpieczne generowanie lokalnych tożsamości, końcowy standardowy odczyt | `createOrder` ponownie wycenia/tworzy linie i zwiększa `stock.reserved`, tworzy reservations, lokalizacje/warstwy. N takich wywołań podwójnie rezerwuje ten sam towar. |
| `server/order-merge-payments.ts`, `payments.ts`, `source-payments.ts` | Oryginalne payment entries pozostają niezmienne; odczyt obejmuje wpłaty/zwroty/odwrócenia, powiązania i walutę | Rozwiązywanie source→jeden owner i agregacja incoming ledgers nie przydziela jednego wpisu do wielu dzieci. Kopia `payment_mode` lub statusu nie jest alokacją wpłaty. |
| `server/order-merge-guards.ts`, `domain.ts`, `app.ts` operational predicate, `sales-reports.ts` | Kontrola aktualnego właściciela po order lock; odrębne historyczne i aktywne widoki | Nie dodajemy pozornych merge claims, aby ukryć duplikaty. Po split należy liczyć rzeczywiste pozostałe i nowe linie, nie źródłowy before-snapshot jako kolejną sprzedaż. |
| `server/commercial-sale-scope.ts`, Native136/137/204 | Przykład zachowania kwot/ilości, granic częściowej realizacji i jawnego historycznego pochodzenia | Komercyjna paczka nadal należy do jednego zamówienia; nie jest osobnym zamówieniem split. |
| `web/order-merge-custody.ts` i aktualny merge UI | Trwałe body/key, lookup zamiast ponowienia, Web Lock między kartami, finalny IAM przed clear | Split ma odrębny namespace i schemat. Nie czyści ani nie interpretuje custody merge. Nie powstaje nowy ogólny framework retry. |
| `tenantTx`, `wms-lots-transaction.ts`, `catalog-stock-writer-coverage.ts`, startup/resource/source inverse | Aktualny actor, transakcyjne fences/Native, dokładne piny źródeł i realna instalacja | Obecna zgoda na merge/writer nie obejmuje automatycznie nowego writer split. Nie wyłączamy generation, guards, quota lub timeoutów. |

## Zamrażany model pierwszego pionu

**Źródło zachowuje ID i nieprzeniesioną pozostałość**, a pozostałe zamówienia otrzymują nowe lokalne ID. Pierwotne pozycje, cały nagłówek i historia przed zmianą zostają zachowane w niezmiennym dowodzie splitu. Jest to najmniejszy model zgodny z opisem przenoszenia do nowego zamówienia, bez fikcyjnego merge i bez ukrywania całego źródła w raportach.

Pierwszy pion obsługuje ręczne, lokalne zamówienie sprzedażowe, dodatnie całkowite ilości prostych produktów, jeden magazyn/walutę, niezerową pozostałość i wyłącznie pierwotne aktywne rezerwacje bez skanów, wydań lub zwolnień. WMS OFF i ON są osobnymi wymaganymi przypadkami; transfer rezerwacji jest częścią pionu, nie późniejszym dodatkiem. Limit np. 100 wyników / 10000 przydziałów jest proponowanym lokalnym budżetem, nie limitem Base; odmowy ponad budżet pozostają jawną luką pełnego zakresu.

Plan request zawiera oryginalny `client_key`, `source_order_id`, `expected_source_version`, N−1 nazwanych slotów nowych zamówień z mapą `source_item_id → quantity` i jawnym `delivery_minor`. Pozostałość jest wyliczana, nie dopisywana drugim niezależnym requestem. Preview ustala przyszłe ID zamówień i linii; execute nie losuje ponownie przy replay. Kwoty przechodzą przez integer minor units/BigInt i jawne granice kolumn, nigdy float podczas alokacji. Typ float publicznego API wymaga osobnej walidacji konwersji na granicy adaptera.

Dane kupującego, adresy, uwagi i jawnie obsługiwane pola biznesowe dziedziczy się z zamrożonego źródła. Tożsamości systemowe, portal tokens, wersje i audit nie są kopiowanymi poświadczeniami. Powiązania marketplace/import oraz pola dodatkowe wymagają osobnej macierzy dziedziczenia; początkowe odmowy nie mogą zostać opisane jako pełne „all fields” Base. Każda częściowo przeniesiona linia zachowuje cenę/VAT i dokładną łączną wartość. Dla linii z rabatem/niestandardowym `line_total` trzeba jawnie ustalić kumulatywny podział reszt; do tego czasu odmowa, nie cicha ponowna wycena.

## Minimalny zestaw plików i odpowiedzialności

Nazwy Source209 poniżej są propozycją, dopóki koordynator nie przydzieli numeru.

| Nowe pliki | Zakres |
|---|---|
| `server/209_order_split.sql` | Osobny namespace `order_split209_*`: previews, preview allocations, executions, execution allocations, lineage, custody receipts oraz prywatne current-TX admissions. RLS/FORCE, tenant FKs, immutable history, closed ACL, byte/row quotas i deferred completeness. Bez wykonywalnego DML przed zatwierdzeniem modelu i dowodu instalacji. |
| `server/order-splits-schema.ts`, `order-splits-values.ts` | Strict DTO, limity, deterministyczny podział ilości/kwot, konflikty i pełna macierz odmów. Bez dostępu do bazy w kalkulatorze. |
| `server/order-splits.ts`, `order-split-custody.ts`, `order-split-order-creation.ts` | Jedna autoryzowana TX: snapshot/lock/recapture, typed Native admission do utworzenia nagłówków i linii bez drugiej rezerwacji, transfer istniejącej custody, before/after, final IAM i COMMIT. Nie dodawać publicznego `skipStock` do createOrder. |
| `server/order-split-routes.ts` | Własne `/api/order-splits/options`, `/previews`, `/execute`, `/commands/:key?operation=…`, paginowane źródła/przydziały/wyniki/lineage. GET lookup czyta istniejącą komendę; brak wyniku nie dowodzi rollbacku. |
| `server/order-split-payments.ts` i osobny Source alokacji, gdy dojrzeje model | Obowiązkowy pełny financial snapshot/refusal w pierwszym pionie; później jawne alokacje oryginalnych wpisów i odwróceń, nigdy kopie wpłat. Płatne zamówienia nie są pomijane w planie odbioru. |
| `web/order-splits.tsx`, `web/order-split-custody.ts` | Wybór 1→N, podgląd pozostałości/nowych wyników/kosztów, zgoda, trwały dokładny intent przed POST, actor-scoped Web Lock, oryginalny command lookup i pełny readback. Brak API locka/persistence → brak POST/clear. |
| `tools/parity/order-split-source.mjs`, odpowiedni `H/order-split…-source-contract.mjs` i `…-compatibility.mjs` | Źródłowy manifest programu, odrębny compiler scratch i dokładny inverse do poprzednika; niezależna walidacja dodatków oraz ewentualnych wąskich zmian istniejących guardów. Brak observed-as-expected. |

Kontrolowane punkty integracji: `server/app.ts`, `server/db.ts`, build/runtime resource definitions, stock-writer coverage, ordinary cold gates i **normalizer ACL**. Nową projekcję należy komponować przed208→207 we wszystkich tych miejscach, także przy historycznym/inactive katalogu. Zmiany źródłowych pinów robi się po review całego zakresu, nie przez osłabienie starego kontraktu. Stare SQL103/104/145/152/188/206/207/208 i stare manifest rows pozostają literalne.

## Transakcja i Native — warunki przed pierwszym wykonaniem

1. Bieżący actor/session/key/role i scope, prawdziwy tenantTx oraz schema-generation fence. Lock order musi współpracować z istniejącymi writerami: aktualne warehouse policy/catalog admission, rodzic `orders FOR UPDATE`, linie/picks, uporządkowane `(warehouse,product)` stock rows, następnie reservations/locations/layers. Nie projektować przeciwnej kolejności na podstawie samego merge; potwierdzić ją z bieżącym standardowym create/fulfillment.
2. Po wszystkich oczekiwaniach ponowny odczyt source version, całego commercial/physical/financial frame i blockerów. Suma ilości każdego source item = pozostałość + wszystkie dzieci. Suma fizycznych komponentów musi zgadzać się niezależnie od sumy linii handlowych.
3. **Typed current-TX admission** wiąże tenant/actor/key, exact body/hash, source version, preview, sloty i przyszłe ID oraz rzeczywisty before/after. Dopiero ten dowód pozwala utworzyć docelowe rekordy i przemieścić przypisanie custody. Nie używać istniejącego admission wymiany/importu jako obejścia rezerwacji.
4. Native wylicza dokładne docelowe rezerwacje wraz z lokalizacją/partią. Łączne `stock.reserved`, stock quantity/available, bins, physical layer positions i journale ruchu pozostają bez nowego ruchu fizycznego. Zmieniają się tylko udowodnione przypisania zamówień i ich liczniki. Redukcja źródłowego wiersza, całkowite przeniesienie produktu oraz pozostałość tego samego produktu wymagają osobnych przypadków — nie wolno założyć, że stan `transferred` lub klucz `(order,product)` przyjmie te zmiany bez Native successor.
5. Istniejące row guards pozostają skuteczne. Jeżeli potrzebny jest wąski następca funkcji 104/145 lub innego guarda, nowy Source musi jawnie przypiąć oryginalny descriptor, exact nowy descriptor i własny append-only manifest; kompilator dowodzi delty i niezmienności pozostałych rekordów. Nie wykonywać disable trigger, owner-DML do tabel biznesowych, reseal dawnych manifestów ani ogólnego inverse ignorującego namespace. Sam nowy JS checker nie naprawia odmowy starego Native guarda.
6. Dowód execution obejmuje wszystkie źródłowe i nowe linie, custody, pozostałość i audit. `SET CONSTRAINTS ALL IMMEDIATE`, finalne realne Native/current IAM/version checks i COMMIT są obowiązkowe; pierwotne błędy/niepotwierdzony COMMIT zachowują swój status. Admission nie przeżywa root TX i nie jest odtwarzany z JSON/browsera.

## Płatności: wymagany etap, nie „brak wymagań”

W pierwszym pionie eligibility sprawdza **wszystkie istniejące financial facts**, a nie wyłącznie saldo netto. Jakakolwiek wpłata, refund, reversal, cash-on-delivery collection/remittance/fee, source-payment/import allocation, link lub rozpoczęta próba rozliczenia wymaga odmowy, nawet gdy suma netto wynosi zero. Tak samo niezgodne historyczne oznaczenie „opłacone” bez ledger proof. Preview pokazuje przyczynę; execute sprawdza ją ponownie po order lock. Nie kopiuje się `paid` do nowych zamówień jako fikcyjnego potwierdzenia wpłaty.

Następny wymagany etap finansowy wprowadza append-only alokacje `(oryginalny payment entry, execution, wynik, kwota, fee)` i nowe projekcje sald. Suma alokacji nie przekracza rzeczywistego źródła; reversal/refund odnosi się do oryginalnego wpisu i dziedziczy jawny podział z dokładnym zaokrągleniem. Źródłowy wpis nie jest usuwany, przepisywany ani liczony jednocześnie w pełni u źródła i dzieci. Trzeba zintegrować manual payments, source payments, import allocations i COD — stare `resolveOrderMergeOwnerInTx` nie jest rozwiązaniem 1→N. Późna płatność dostawcy na stary source ID, której nie można jednoznacznie przydzielić, pozostaje do uzgodnienia, bez automatycznej fikcyjnej alokacji. Bez tego etapu odbiór płatnych splitów pozostaje false.

## Początkowe odmowy i ich powody

| Przypadek | Powód odmowy do czasu odrębnego wdrożenia |
|---|---|
| Wystawiony dokument, invoice/export plan, korekta, paragon, return/exchange | Dokumenty wiążą konkretne ilości, zamówienie i numerację; nie kopiujemy sprzedaży ani nie wykonujemy nieudokumentowanej korekty. |
| Shipment, tracking/etykieta, provider plan z próbą wysłania, fulfillment zewnętrzny | Skutki mogły już wystąpić poza TX; podział nie może spowodować kolejnego wydania lub błędnego retry. |
| Plan paczek/partial commercial scope, consumed/released >0, aktywna fala/pakowanie lub scans >0 | Istnieją przydziały/custody, których whole-order model nie może nadpisać; Native145 już jawnie odmawia analogicznego ryzyka. |
| Płatność lub historia finansowa dowolnego rodzaju | Brak zatwierdzonej alokacji 1→N; zerowe saldo nie usuwa historii wpisów. |
| Replacement, B2B/dropship/fulfillment zewnętrzny, merge lineage lub wcześniejszy split | Istnieją inne ścieżki ownership/źródłowe zobowiązania; najpierw wymagany mieszany graph i jego obsługa we wszystkich writerach. |
| Zestaw, serial, ilość ułamkowa, rabat/ujemna lub niespójna linia, inny magazyn/waluta | Brak ustalonej semantyki ilości, komponentów, wartości lub przypisania warstw w początkowym modelu. |
| Zewnętrzny channel/import, nieobsługiwane pola lub cały koszyk przenoszony bez pozostałości | Nie ustalono mapowania ID, dziedziczenia/synchronizacji i losu pustego źródła. To otwarte coverage, nie „niewspierane w Base”. |

Każda odmowa wymaga sprawdzenia source/current facts, jawnego kodu biznesowego i dowodu braku zmiany wszystkich faktów. Przypadki z tej tabeli pozostają w matrycy pełnego produktu; nie są wyłączane ze scope.

## Konkretne testy i kolejność odbioru

| Nowy test / warstwa | Wymagany wynik |
|---|---|
| `tests/order-split-values.test.ts` | 1→2, 1→3, maksymalna liczba wyników, ten sam SKU w dwóch source rows, częściowa ilość, grosze dostawy i reszty; brak duplikatów, over-allocation, pustych wyników, overflow i cichej zmiany cen. |
| `tests/order-split-source.test.mjs` + exact inverse | Manifest kolejności/źródeł, oryginalne certy literalne, complete namespace/parent-trigger delty; missing/extra/body/ACL/type/reloptions drift odmawia. |
| `tests/order-split.database.test.mjs` — realny oddzielny scratch po zgodzie | Genuine ordinary API-created source z WMS OFF i ON. Native wykonuje 1→N, pokazuje exact before/after i zero dodatkowego stock reservation/movement. Uszkodzenie jednego fragmentu dowodu/guardu/tenant odmawia; deferred checks wykrywają niepełne dzieci. |
| `tests/order-split-concurrency.database.test.mjs` | Split kontra split/merge/edycja/ship/nowa wpłata, expiry/revoke po oczekiwaniu; brak częściowego COMMIT, deadlockowego przeciwnego lock order i zgubionych ilości. Wstrzyknięte błędy na etapach header/items/custody/audit pozostawiają rollback. |
| `tests/order-split-financial.database.test.mjs` | Początkowe odmowy także dla netto-zero/reversed entries i raced payment. Etap alokacji: wpłata częściowa/nadpłata/refund/reversal/COD/fee/import oraz późny ACK; uzgodniona każda kwota i oryginalny ID, zero kopii wpisów. |
| `web/order-split-custody.test.mjs` | Trwałe exact body/key przed POST, quota/storage failures, remount, obcy actor/workspace, równoległe karty z Web Lock, lost ACK, 404 held, wrong-body lookup i late IAM. Brak automatycznego POST; komplet wyników przed clear. |
| `tests/order-split-ordinary-api-acceptance.mjs` + realny browser | Jedna zamrożona końcowa rewizja: preview→zgoda→execute→źródłowa pozostałość i wszystkie nowe zamówienia→lineage/history→magazyn/płatności/dokumenty. Lookup i trwały receipt oryginalnych kluczy; wizualne UI oraz rzeczywisty API/PG readback, nie wyłącznie controlled transport. |
| Recovery / workers / synchronizacja | Restart i restore zachowują wszystkie ID, ilości, oryginalne komendy i brak częściowych wyników. Odrębny etap akcji automatycznej używa tego samego admission/proof; import/sync nie odtwarza już przeniesionych ilości ani nie dubluje płatności. |

Kolejność: zamrozić pure/DTO i polityki → niezależny Native model custody → source-derived compiler i negatywy → kontrolowany zwykły API/browser w jednym lokalnym release → restart/recovery → etap finansowy i mieszane lineage → akcja automatyczna/integracje. Nie rejestrować migracji/resource/cold readiness, zanim istnieje kompletny źródłowy descriptor i realny Native dowód. Żaden etap tego planu nie został jeszcze odebrany.
