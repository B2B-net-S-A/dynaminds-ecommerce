# Native210 — skończona projekcja metadanych przed pierwszą kompilacją

Stan18.10.2026: projekt implementacyjny oparty na źródłach. Nie wykonano DDL,
nie odczytywano katalogu żywej bazy ani pełnego archiwum katalogu. Nie jest to
kontrakt E210, odbiór Native ani zgoda na aktywację. Następca209 nadal wymaga
własnej udanej bramy; nie wolno przypisać210 wyniku nieudanego kompilatora209.

## Wejścia i dokładna zmiana fizyczna

| Wejście | SHA256 / znaczenie |
| --- | --- |
| `tools/parity/order-split210-business.sql` | `fb803220a91c2cefcc6953d1aebd69e173dbc079a94d161bf6bb2d326ed0f4a1` |
| `tools/parity/order-split210-terminal.sql` | `cb9620410a63dc6225911ef507ff4423610e577c31f2f700d9e987c111943c60` |
| `tools/parity/order-split210-external-triggers.mjs` | `4ed56921de7cecae28b56bd91ad5e9894aefd25b23f252e449a1d37c0e957a0e` |
| `tools/parity/order-split210-foreign-keys.mjs` | `f95cd46f1ed1976427788ec220dbd082e516b94ccf84bcb4863ae5c5343dc8f4` |
| `tools/parity/order-split210-wms-successor.mjs` | `61e23aa9ed809e566692f4c7d08a5e8e5c97118e2a08679e9298ca8f30e8538d` |

Źródła opisują sześć własnych tabel: `order_split210_previews`, `source_rows`,
`executions`, `targets`, `allocations`, `replay_duties` (każda z pełnym prefiksem).
Powstaje27 jawnych triggerów:15 własnych,12 zewnętrznych bound oraz trzy własne
pary trigger–constraint. Nie ma dawnych39 zewnętrznych financial rechecków.
Osobny generator FK opisuje18 FK i72 wewnętrzne RI:48 na własnych tabelach,
24 na istniejących rodzicach. To99 nowych rekordów rodzaju trigger; liczba nie
obejmuje przyszłych triggerów własnej pieczęci metadanych210.

Dokładne12 tabel bound to `orders`, `order_items`, `order_pick_items`,
`reservations`, `reservation_locations`, `wms_reservation_layers`, `stock`,
`stock_locations`, `wms_layer_positions`, `stock_movements`,
`stock_location_movements`, `wms_layer_movements`. External RI dotykają
`tenants`, `users`, `orders`, `api_keys`; ich właściwy roster pochodzi z FK,
nie z ignorowania prefiksu `RI_ConstraintTrigger` ani zgadywania OID.

Jedynym już wyprowadzonym starym writerem jest `public.wms_row_guard()`:
pełny rekord BEFORE ma SHA256
`c2b12caaf79c2347e1a06557ac62dae1963647edb9527d8fa313e96c85d07669`,
AFTER `f573804fc6f47b5d36e0a451448db22e461a50e718d6bff08114284654b1f556`.
Generator odtwarza literal104 + transformację108, zachowuje nagłówek/ACL
invoker i dodaje wyłącznie owner+exact-current-row-proof dla warstw rezerwacji.
Nie daje ogólnej zgody owner DML. Guardy134/137/145 pozostają literalne:
initial capture odmawia planów paczek, ich historii, MERGE i consumed/released.
Nie ma podstawy do kopiowania zgody MERGE ani wyłączenia tych guardów.

## Które stare obserwatory rzeczywiście widzą zmianę

| Dokładny klucz funkcji | Powód i źródło |
| --- | --- |
| `public.fa3_draft_fingerprint()` | Source204:6693–6711 obserwuje wszystkie nieinternal triggery na `orders`/`order_items` oraz rodzicach auth; jego zbiór funkcji obejmuje `tgfoid` tych tabel. Widzi dwa bound triggery i nową `order_split210_bound_guard()`. |
| `public.b2b_invoice_fingerprint()` | Source204:6713–6731 ma analogiczny parent-trigger/function observer. |
| `public.b2b_credit_fingerprint()` | Source169:475–489 obserwuje ponadto trzy księgi stock movements; widzi pięć bound triggerów na swoich relacjach, a przez `orders` także nową funkcję guarda. Obowiązuje aktualne źródłowe przekształcenie tej funkcji, nie wcześniejsza definicja160. |

Wewnętrzne RI są pomijane przez powyższe `NOT tgisinternal`;18 nowych FK
należy do nowych tabel210, nie do istniejących rodziców. Nadal wymagają pełnej
autentykacji/inverse w ogólnym katalogu. Nie wolno ich usuwać z tego odbioru.

Nowe triggery nie są na tabelach `buyer_address_*`, `local_invoice_*`,
`financial_return_*`, `local_consumer_credit_*` ani `return_credit206_*`.
Ich same rodzinne fingerprinty nie wymagają więc nowej gałęzi usuwającej210.
W szczególności nie zmieniamy literalnych188/207, ich manifestów ani certyfikatów.
`buyer_address_predecessors()` (166:73–87) wywołuje trzy dotknięte fingerprinty
oraz zachowuje całe dane ich manifestów; po prawdziwej projekcji ich wyniki
muszą pozostać literalne. To pozwala pozostawić sam observer166 bez zmiany.
`pim_dictionary_metadata()` (170:859–884) i `large_import173_metadata()`
(173:245–271) wybierają własne rodziny; nowe FK do wspólnych rodziców nie
stają się przez to ich własnymi RI. Role/default ACL/public schema pozostają
literalne. Pośrednie wywołania starych guardów muszą nadal zwracać prawdziwy
wynik po dokładnej projekcji, nie stałe `true`.

## Zalecany najmniejszy łańcuch następcy

Najpierw generator tworzy13 jawnych zmian funkcji; poniższy roster jest
projektem do udowodnienia kompilatorem, nie zatwierdzonym expected katalogiem:

1. Cztery business/observer zmiany: `public.wms_row_guard()` oraz trzy
   fingerprinty z tabeli powyżej. Fingerprinty dostają źródłowo wygenerowaną,
   wąską projekcję dokładnych nowych triggerów/funkcji. Nie zwracają zapisanej
   starej sumy: nadal obliczają ją z aktualnych metadanych. Obcy dodatkowy
   trigger/overload/ACL nadal zmienia wynik lub powoduje odmowę.
2. Osiem istniejących portów209 dostaje ścisłą warstwę210 PRZED dotychczasową
   projekcją209: `public.order_merge_delivery209_predecessor_descriptor(fn oid)`,
   `predecessor_definition(fn oid)`, `predecessor_source(fn oid)`,
   `predecessor_metadata(value jsonb)` oraz ich przeciążenia odpowiednio
   `(fn oid, entries jsonb)` / `(value jsonb, entries jsonb)` z tym samym
   pełnym prefiksem. Nowa warstwa rozpoznaje wyłącznie cztery exact changed keys
   z pkt1; dane spoza jej zakresu przechodzą bez transformacji. Każda inverse
   najpierw potwierdza pełny aktualny AFTER i zamkniętą pieczęć210.
3. `public.order_merge_delivery209_fingerprint()` dostaje dokładną projekcję
   własnych zmienionych ośmiu portów i samego następcy fingerprintu do literalnej
   postaci rodzica209. Jego stare pole `legacy` (dziesięć funkcji), cztery CHECK,
   payload mapy209 i dane manifestu209 pozostają identyczne. Dopiero wtedy stary
   `order_merge_delivery209_valid()` może pozostać literalny i nadal sprawdzać
   oryginalną pieczęć. Nie dopisujemy ani nie resealujemy istniejącej pieczęci.

Dlaczego rozszerzenie portów209: aktualne205 ma pięć exact changes
`manual_inventory_off_valid()`, `manual_inventory_off_projection_valid()`,
`partial_sale204_predecessor_definition(fn oid)`, `ordinary187_valid()`,
`partial_sale204_valid()` oraz addition `catalog_header205_valid()`.
Te sześć ciał ma już source-authored wariant209. W szczególności
`partial_sale204_valid()` hashuje36 pełnych nagłówków/source SHA bezpośrednio;
sama zmiana `partial_sale204_predecessor_definition` go nie zamknie. Rozszerzenie
istniejących odczytów209 pozwala zachować wszystkie sześć dużych ciał literalnie,
ich dziesięcioelementową mapę BEFORE/AFTER oraz205/204 historyczne wartości.
`checked_projection_map(selected_fn oid)` i `projection_map()` nie muszą się
zmieniać: invocation-local czytnik rozszerzony o210 rozpoznaje nowy scope nawet
przy NULL starego frame poza dziesięcioma nazwami209; przed inverse ma własną
pełną świeżą autentykację210. Nie interpretuje NULL jako zgodę.

Kompilator ma odmówić, jeżeli pojawi się inny stary zmieniony klucz. Nie wolno
rozszerzać listy tylko dlatego, że odczytano inny actual. Wtedy najpierw trzeba
wykazać konkretną brakującą zależność w źródle i wyprowadzić jej successor.

## Pełny rekord, dane mapy i brak cyklu

Native210 potrzebuje własnego zamkniętego8-kind fingerprintu według tego samego
`packing189-catalogue-sql.mjs` co reader. Dla funkcji wiążemy cały rekord:
owner/language/kind/cost/rows/security/strict/leakproof/volatility/parallel,
support/variadic, args/names/modes/defaults/result/config, binary/SQL-body,
source/definition i kompletne ACL z odróżnieniem NULL. Triggery wiążemy po
exact table/key/function/type/enabled/internal/constraint/deferral/attrs/args,
a constrainty po pełnej definicji i flagach. FK/RI wymagają dokładnych
partnerów, przeciwnej relacji i akcji; brak/extra/missing pair odmawia.

Mapa13 zmian ma być owner-only, RLS+immutable DATA z source-derived literalnym
payload i hash/bytecount, nie tekstem megabajtów SQL w ciałach funkcji. Nowe
helpere210 odwołują się do nazw innych helperów, nie osadzają ich definicji
ani hashy we wzajemnie zależnych ciałach. Własny fingerprint czyta metadane,
nie wykonuje guardów209 ani funkcji210. `210_valid → 210_fingerprint → catalogue`
ma być grafem bez wywołania `209_valid`; inaczej powstanie pętla przez
`209_valid → successor209_fingerprint → 210_projection → 210_valid`.
Manifest210 osobno przypina literalne dane starego209/166 oraz bieżący
zamknięty fingerprint. Nie hashuje własnego pola fingerprint jako oczekiwania.
Program instalacji najpierw przypina nienaruszonego rodzica209, potem tworzy
cały210 i wszystkie jawne następce, a na końcu pieczęć. W przejściowym stanie
nie może żądać udanej walidacji częściowo wymienionego209 ani zastępować jej
bootstrap-GUC/stałą zgodą. Pieczęć oblicza metadane, nie uruchamia tego DAG.

Nie kopiujemy modelu190 powtarzanych pełnych odczytów. Jedno prawdziwe wywołanie
obserwatora pobiera własny świeżo zweryfikowany frame; prywatne lookupy mogą
korzystać wyłącznie z tego lokalnego frame. Nie ma GUC, TTL, cache IAM ani
session-ready verdict. Zmiana nagłówka SQL→PL/pgSQL wymaga jawnego pełnego AFTER,
nie ukrytego textpatcha. Definicje przechowywane w historycznych SQL literals
pozostają bajtowo identyczne; transformacja dotyczy tylko executable spans.

## Konkretne następne pliki i pierwsza rzeczywista brama

Proponowana następna własność, po zaakceptowaniu tego projektu:

- `tools/parity/order-split210-source.mjs` + test: assembler core→terminal→WMS,
  cztery business/observer delty, pełny własny manifest i closed namespace.
- `tools/parity/order-split210-predecessor.mjs` + test: osiem portów209 + jego
  fingerprint, source-derived dane13 changes; test braku cyklu i zachowania
  wszystkich innych starych bajtów/nagłówków/map/certyfikatów.
- Nowy `order-split210-source-compatibility.mjs` + test w dotychczasowym katalogu
  shared: exact210→209 recordset inverse z jawnie przekazanym expectation;
  E210 dopiero po rzeczywistej kompilacji i niezależnym przeglądzie.

Limit readera pozostaje64MiB/rekord8MiB. Obecny209 ma mały zapas; przed DDL
assembler musi policzyć dokładne największe pełne source+definition rekordy
oraz przewidywany przyrost. Po kompilacji obowiązuje rzeczywisty pomiar całego
payloadu. Przekroczenie blokuje wydanie i wymaga zmniejszenia reprezentacji,
nie zwiększenia limitów. Payload mapy będący DATA nie jest zwolniony z limitów
odczytu własnego helpera ani kontroli bieżących generowanych metadanych.

**Pierwsza rzeczywista brama:** po zaakceptowaniu działającego rodzica209 jeden
nowy własny numeric source-compiler DB i przypięty uporządkowany program od
pustego schema do209, potem wyłącznie frozen210. Porównać pełny BEFORE209 z
niezależnym source parentem; po210 dokładnie13 old-function deltas, wszystkie
autorskie additions,27 triggerów/3 pairs/18FK/72RI oraz metadane pieczęci210.
Wszystkie pozostałe rekordy, role, default ACL i dane dawnych certyfikatów mają
być identyczne. Bez actual-as-expected. Następnie Native integrity negatives,
prawdziwy unpaid manual OFF/ON z conservation i limitami8s; cleanup własnej
bazy po zamknięciu klientów i0 innych połączeń. Dopiero udany wynik pozwala
utworzyć source contract; nie nadaje automatycznie odbioru API/Chrome, restartu,
workerów, skali ani pozostałych płatnych/B2B/MERGE odmian pełnego split.
