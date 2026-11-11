# BUYER-ADDRESS236: tani werdykt `buyer_address_available()` (27.10.2026)

Migracja `236_buyer_available_verdict` (`server/236_buyer_available_verdict.sql`), wywołanie w
`server/buyer-address.ts` `available()`.

## Problem

Pomiar 26.10 (próbkowanie `pg_stat_activity` podczas generatora skali na paczce wydania):
`buyer_address_available()` w 70% próbek, 0,3–0,5 s na wywołanie, bo za każdym razem uruchamia pełne
`buyer_address_guards()`. Zamówienie kosztowało ~7,4 s, pełny etap 5 (100 tys. zamówień) szacowany na ~41 h.

## Co musi odpowiedzieć sprawdzenie, a co sprawdza strażnik

| Miejsce | Po co pyta |
|---|---|
| `server/buyer-address.ts:236` `available(c)` (wywoływane z `prepareCreatedOrderBuyerInstallationInTx`, `effectiveDeliveryWithInstallationInTx`, transakcji portalu/administratora) | „czy moduł adresu kupującego jest zainstalowany i nienaruszony”: `false` = brak modułu (odczyt bez nadpisania adresu), wyjątek 55000 = moduł niekompletny/naruszony, `true` = można czytać/zmieniać nadpisanie |
| `166:407` `buyer_address_prepare`, `166:436` `buyer_address_apply`, `166:489` `buyer_address_terminal` | to samo przed zapisem podglądu/potwierdzenia adresu (rzadkie ścieżki portalu i administratora) |

Gorąca ścieżka to `available(c)`: każdy `getOrder()` po zmianie statusu, skanie, pakowaniu i wysyłce w transakcji
RW (proof instalacji bramki ma tylko `createOrder` i odczyty RRRO). W pomiarze 6 zamówień: 67 wywołań, 24,2 s.

`buyer_address_guards()` (dziś ~83 KB po 189/204/209) to kontrola integralności całej instalacji: odcisk
katalogu własnych obiektów `buyer_address_*` (tabele, kolumny, ograniczenia, indeksy, wyzwalacze w dowolnym
schemacie, polityki, funkcje z ACL, atrybuty roli `dyna_app`), odciski poprzedników 157–165 i ich certyfikaty,
`order_merge_delivery209_valid()`, `partial_sale204_valid()`, rzutowania 214/219. Jest deterministyczną funkcją
(a) katalogu, (b) zawartości tabel, które czyta, (c) wspólnych katalogów ról/tablespace’ów. Zbiór tabel (b)
wyznaczony na żywym klonie (`pg_stat_xact_user_tables` podczas jednego wywołania): 12 tabel —
`b2b_credit_upgrade`, `b2b_invoice_upgrade`, `buyer_address_manifest`, `competitor_observation_manifest`,
`credit_source_upgrade_certificate`, `fa3_draft_manifest`, `financial_return_upgrade_certificate`,
`local_invoice_manifest`, `manual_inventory_off_certificate`, `migrations`, `order_merge_delivery209_manifest`,
`order_merge_delivery209_projection_basis`. Z katalogów wspólnych czyta `pg_authid`, `pg_auth_members`, `pg_tablespace`.

## Rozważone warianty

1. **Zmienić `buyer_address_available()`/strażnika.** Odpada: każda funkcja `buyer_address_*` jest w odcisku
   (`pg_get_functiondef`), który pieczętuje manifest, a definicje są przypięte w 189/204/209 (`expected359`,
   rzutowania 209). Zmiana wymaga nowej projekcji wstecznej w łańcuchu 209 — duża, ryzykowna zmiana zabezpieczeń.
2. **Pamięć na transakcję.** Bezpieczna, ale bez zysku: gorące ścieżki mają zwykle jedno wywołanie na transakcję.
3. **Dowód instalacji bramki dla wszystkich transakcji RW (tylko TS).** Ta sama własność co `createOrder`, ale
   działa wyłącznie w wydaniu z bramką i zmienia świadomie wąski zakres dowodu („Generic/RW/direct consumers keep
   the full guard”). Nie migracja.
4. **Werdykt związany ze znacznikiem (wybrany).** Zapisany wynik `true` pełnego strażnika jest ważny, dopóki nie
   zmieniło się nic, od czego strażnik zależy. Znacznik katalogu już istnieje: generacja 182
   (`ordinary182_runtime_generation`). Wyzwalacz zdarzeń `ordinary182_schema_ddl` (ddl_command_start, wszystkie
   tagi) przy każdym DDL właściciela podnosi `generation` i ustawia `dirty`; start wydania zatwierdza ją
   (`ordinary187_approve`: pełne `ordinary187_valid()` pod wyłącznym `982376`; zimna inspekcja dodatkowo woła
   `buyer_address_available()`), a każda transakcja bramki trzyma `982376` współdzielone. Tego samego modelu
   bramka używa już dla `createOrder` i odczytów zamówień.

## Projekt

`buyer_available236()` (SECURITY DEFINER, EXECUTE tylko dla `dyna_app`):

1. Generacja niezatwierdzona (źródła/dev/testy nigdy jej nie zatwierdzają; każdy DDL ją brudzi) →
   `RETURN buyer_address_available()` — dokładnie jak przed 236.
2. Inaczej `pg_advisory_xact_lock_shared(982376)` (żaden DDL nie zatwierdzi się przed końcem transakcji),
   ponowne sprawdzenie generacji jak `ordinary182_require_generation()`, potem podstawa `buyer_available236_basis()`:
   sha256 z wiersza generacji (wartości oraz `ctid`/`xmin`), `(ctid, xmin)` każdego wiersza 12 tabel, ról
   (`pg_roles`), członkostw, tablespace’ów, wyzwalaczy zdarzeń i nazw wyzwalaczy `buyer_address_*` we wszystkich
   schematach. Nowa wersja wiersza zawsze ma nowe `xmin`, więc każdy INSERT/UPDATE/DELETE (także w trybie replica,
   także „bez zmiany wartości”) zmienia podstawę, bez czytania 55 MB `order_merge_delivery209_projection_basis`.
3. Sesja ma obiekt TEMP (relację albo typ) o nazwie relacji/typu z `public` lub `pg_catalog` → pełne
   `buyer_address_available()`, bez zapisu werdyktu (sekcja „Obiekty TEMP” niżej).
4. Werdykt (`buyer_available236_verdict`, wiersz jedyny, bez uprawnień dla `dyna_app` i PUBLIC) z tą samą
   generacją i podstawą → `true` (~1 ms). Inaczej pełne `buyer_address_available()` (ten sam wyjątek 55000),
   a werdykt jest zapisywany tylko, gdy podstawa po strażniku jest taka sama jak przed nim, transakcja jest RW
   READ COMMITTED, a wiersz da się zablokować bez czekania (`SKIP LOCKED`).

Dlaczego to nie osłabia ochrony: wynik pełnego strażnika może się zmienić tylko przez zmianę katalogu (DDL
właściciela → generacja brudna → pełny strażnik), obiekt TEMP bieżącej sesji (sprawdzany przy każdym wywołaniu,
niżej), zmianę jednego z 12 wierszy, ról/członkostw/tablespace’ów (DDL wspólnych obiektów nie odpala wyzwalaczy
zdarzeń — dlatego są w podstawie) albo wyłączenie samego wyzwalacza zdarzeń (też w podstawie). Wszystkie te
przypadki kończą się pełnym strażnikiem w następnym wywołaniu. (Wyłączony wyzwalacz zdarzeń: tylko w następnym,
potem werdykt zapisywał się ponownie — luka poprawiona w 240, niżej.)

### Obiekty TEMP (poprawka po przeglądzie bezpieczeństwa 27.10)

Pierwsza wersja 236 twierdziła, że strażnik widzi obiekty TEMP tylko przez nazwy wyzwalaczy. To było fałszywe.
DDL TEMP wykonany przez `dyna_app` przepuszczają `ordinary182_invalidate`/`ordinary182_temp_ddl_end`
(`server/182_cold_schema_runtime_admission.sql:60-91`) i nie przesuwa on generacji. Schemat TEMP sesji jest jednak
przeszukiwany przed `public` dla relacji i przed `pg_catalog` dla typów (funkcji i operatorów nigdy), więc
`CREATE TEMP TABLE buyer_address_state (…)` przesłania tabelę w każdym niekwalifikowanym odwołaniu strażnika i
aplikacji (np. odczyty w `server/buyer-address.ts`; `dyna_app` jest właścicielem tabeli TEMP, więc RLS jej nie
dotyczy, a połączenie z puli zachowuje ją dla żądań innych firm). Pełny strażnik wtedy rzuca 55000, a pierwsza
wersja werdyktu zwracała `true`.

Na klonie (`dynaminds_m236_20261027_12`, przed poprawką) pełny strażnik zawodzi przy: tabelach TEMP
`buyer_address_state`/`_previews`/`_receipts` (`LIKE` i `(x int)`), `orders`, `migrations`, widokach TEMP
`buyer_address_state` i `orders`, typie `pg_temp.jsonb` i domenie `pg_temp.text` (przesłaniają typy wbudowane).
Nie zawodzi przy tabeli TEMP `buyer_address_manifest`, sekwencji TEMP `buyer_address_state`, typie
`pg_temp.buyer_address_x` ani tabeli o własnej nazwie. Poprawka sprawdza przy każdym wywołaniu, przed podstawą i
werdyktem: jeśli `pg_my_temp_schema()` istnieje i ma relację lub typ o nazwie relacji/typu z `public` albo
`pg_catalog`, odpowiada pełny strażnik i nic nie jest zapisywane. Po poprawce wszystkie 14 przypadków dają ten
sam wynik co pełny strażnik, a tabela TEMP o niekolidującej nazwie zostaje na szybkiej ścieżce. Same funkcje 236
mają `search_path=pg_catalog,public,pg_temp` (pg_temp jawnie na końcu), więc przesłonięcia ich nie dotyczą.

### Czego werdykt nie widzi

- **Poprawione w 240** (`docs/parity/BUYER-ADDRESS240-20261027.md`). Zdanie wyżej, że wyłączenie wyzwalacza
  zdarzeń „kończy się pełnym strażnikiem”, było prawdziwe tylko dla pierwszego wywołania. Zatwierdzone
  `ALTER EVENT TRIGGER ordinary182_schema_ddl DISABLE` zmieniało podstawę. Przy chybieniu pełny strażnik, który
  nie patrzy na wyzwalacze zdarzeń, zwracał `true` i werdykt zapisywał się z podstawą „wyzwalacz wyłączony”. Potem
  DDL właściciela nie brudził generacji, a `pg_proc` nie jest w podstawie: po `CREATE OR REPLACE` funkcji
  `buyer_address_hash` werdykt dawał `true` w 1–2 ms, a `buyer_address_available()` rzucało 55000. To samo
  przy `ENABLE REPLICA`, wyzwalaczu odtworzonym na pustej funkcji, z `WHEN TAG`, usuniętym i przy
  `event_triggers=off`. Drugi wariant, z przeglądu 240: DISABLE, DDL i ENABLE przywracały wartości z podstawy.
  Migracja 240 zastępuje `buyer_available236()` i `buyer_available236_basis()`; plik 236 zostaje bez zmian.
- **Poprawione w 241** (`docs/parity/VERDICT-GATES241-20261027.md`). Strażnik zapisu z 240 porównywał kolejność xid,
  nie zatwierdzeń: transakcja otwarta przed zatwierdzeniem na zimno mogła podmienić inwalidator albo założyć regułę
  na tabeli generacji. 241 sprawdza treść maszynerii 182 (sha256 funkcji, wyzwalacze, tabela generacji, brak
  przesłonięć w `public`), tryb replica wywołującego i trwałe ustawienia `event_triggers`/`session_replication_role`.
- DDL superużytkownika w `session_replication_role=replica`: wyzwalacze zdarzeń `O` się wtedy nie odpalają, więc
  generacja się nie zmienia. Przypadkowa „poprawka na gorąco” w trybie replica, którą dawny strażnik na każdym
  wywołaniu by wychwycił, zostanie ukryta do następnej zmiany podstawy, DDL w trybie origin albo restartu
  (zatwierdzenie przy starcie przepisuje wiersz generacji, czyli nową podstawę). To samo dotyczy bezpośrednich
  UPDATE katalogów systemowych. Ten sam aktor może podmienić `buyer_address_available()` na `RETURN true`, więc
  przed złośliwym superużytkownikiem nie chroniło to także wcześniej; to luka modelu bramki 182.
- Wywołujący w REPEATABLE READ widzą wiersz generacji z migawki transakcji, więc mogą zobaczyć nieaktualną
  generację — to samo ograniczenie co `ordinary182_require_generation()`. W transakcjach bramki DDL i tak nie
  zatwierdzi się w ich trakcie (współdzielone `982376`).
- Różnica poza integralnością: pełny strażnik daje fałszywe `false` w sesji bez `timezone=UTC`/`jit=off`; werdykt
  zapisany w sesji aplikacji tego nie powtarza.

Bez zmian: start wydania i zimna inspekcja nadal wołają pełne `buyer_address_available()`; `buyer_address_prepare`,
`_apply`, `_terminal` nadal wołają je wewnątrz (to obiekty zapieczętowane, a ścieżki są rzadkie). Migracja nie
tworzy ani nie zmienia żadnego obiektu `buyer_address_*`.

## Weryfikacja

Klony PG04 szablonu `dynaminds_restore_36751abef3079f3f`, ustawienia puli aplikacji (`timezone=UTC`, `jit=off`).

| | przed (235) | po (236) |
|---|---|---|
| sprawdzenie jako `dyna_app` w transakcji RW, generacja zatwierdzona, mediana z 10 | `buyer_address_available()` 353 ms | `buyer_available236()` 1,01 ms (pierwsze 431 ms); ~1,2 ms, gdy sesja ma niekolidującą tabelę TEMP |
| 6 zamówień generatora skali (tenant B, `tx-mode batch`, źródła), czas w funkcjach dostępności | 67 wywołań, 24 232 ms | 67 wywołań, 69 ms (pierwsza wersja), 78 ms (z kontrolą TEMP) |
| zamówienie bez preflightu źródeł (ściana − tx × pusty tenantTx) | 5 361 ms | 1 193 ms |

Czerwono→zielono: `tests/buyer-available236.test.mjs` (bez bazy) 0/4 na HEAD 3e1c7fb, 4/4 po;
`tests/buyer-available236.test.ts` (klon) 0/8 na klonie zmigrowanym przez HEAD, 8/8 na świeżym klonie 236
(m.in.: zbiór tabel czytanych przez strażnika ⊆ podstawa; brak zapisu dla `dyna_app`; pełny strażnik bez
zatwierdzonej generacji; zmieniony wiersz w trybie replica, usunięte wiersze, podmieniony odcisk, przepisany
wiersz generacji, `ALTER ROLE`, nowe członkostwo, wyłączony wyzwalacz zdarzeń, DDL i podmiana funkcji
`buyer_address_hash` → pełny strażnik albo 55000). Poprawka TEMP: nowy przypadek 9 czerwony na pierwszej wersji
236 (8/9, klon 12), zielony po poprawce (9/9, świeży klon 14). Kontrakt zimnego katalogu: 17 dodatków, 0 zmian,
poprzednik = skompilowany after235 `29f0260d…`; dziesięciu strażników `true` przed i po. Świeży klon 218→236:
ledger 226, dziesięciu strażników `true`, zimna inspekcja `COLD_INSPECTION_PASSED`, `buyer_available236_active`.

## `warehouse_wz_issuer_prepare` (tylko raport)

Drugie 18% próbek. `warehouse_wz_issuer_prepare()` (151, potem 168/171/172) zaczyna od
`warehouse_wz_issuer_require()` → pełne `warehouse_wz_issuer_guards()`: 1,85 s na wywołanie (czyta 21 tabel
certyfikatów/manifestów). W pomiarze: 2 wywołania (zamówienia wysłane), 3,5 s. Ten sam wzorzec, ale wywołanie
jest wewnątrz zapieczętowanych funkcji `warehouse_wz_issuer_prepare`/`_finish` (rodzina `warehouse_wz_issuer_` ma
własny odcisk i przypięcia w łańcuchu), więc nie da się go podmienić w tej migracji bez zmiany obiektów
zapieczętowanych. Do osobnej pracy; TS woła też bezpośrednio `warehouse_wz_issuer_guards()` w
`server/warehouse-wz-issued.ts:21`, gdzie wystarczyłby analogiczny werdykt.
