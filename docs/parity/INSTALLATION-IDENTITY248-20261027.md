# INSTALLATION-IDENTITY248: wycinek instalacji bez ponownego hashowania pieczęci (27.10.2026)

Zmiana tylko w TS: `shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs`
(`installationIdentitySql`, `readInstallationIdentity`, `readCurrentInstallationCut`, zapis tożsamości w
`activateRuntimeGeneration`). Bez migracji. Druga połowa pracy (B2): `docs/parity/GUARD-VERDICTS248-20261027.md`
(migracja 248; obie przygotowano razem pod numerem zastępczym 256, stąd nazwy klonów `p256` i katalogów biegu niżej).

## Problem (B3 z `docs/scale/LOAD-TEST-DRYRUN-20261027.md`)

Każda zarządzana transakcja porównuje „wycinek instalacji” z zimnym faktem z startu: sha256 `to_jsonb` każdego
pełnego wiersza pieczęci (`installationSealSql`), markery migracji i role.

- RW (`prepareOrdinaryInstallation`, każde `tenantTx`): 14 tabel `FOR SHARE`, ~4,6 ms na bezczynnej bazie.
- RR RO (`prepareOrderReadInstallation`, odczyty zamówień): 16 tabel, w tym wiersz
  `order_merge_delivery209_projection_basis` (~14 MB z TOAST), **~91 ms** na bezczynnej bazie.

W biegu bazowym (`data/scale/load/p256-before-01`) wariant bez `FOR SHARE` (odczyt zamówień) to 652 / 2 012 próbek
aktywnych zapytań (steady12 / steady24) — w steady24 najczęstsze zapytanie; wariant RW 36 / 36. Zadanie mówiło o
„każdej transakcji RW”; pomiar pokazuje, że koszt robi głównie ścieżka odczytu (`order_detail` p50 192–235 ms).

## Projekt

Zimna transakcja (pod wyłącznym `982376`), zaraz po pełnych wycinkach i pod tymi samymi blokadami `FOR SHARE`, czyta
tożsamość: dla każdej pieczęci `(tableoid, ctid, xmin)` widocznego wiersza oraz `(ctid, xmin)` wiersza `pg_class` i
każdego wiersza `pg_attribute` tej tabeli. Przy zamknięciu (po `ordinary187_approve`) czyta ją jeszcze raz i porównuje.
Tożsamość trafia do prywatnego faktu procesu obok pełnego wycinka.

W transakcji: najpierw tożsamość (RW z `FOR SHARE`, RO w migawce RR). Gdy jest identyczna z zimną, wynikiem są
zimne hashe pieczęci oraz świeżo przeczytane markery i role (te same sprawdzenia kształtu i porównanie z zimnym
faktem co dotąd). Każda inna tożsamość (albo fakt bez tożsamości) → dawny pełny odczyt, który rozstrzyga.

### Dlaczego nie przyjmie stanu, który pełny odczyt odrzuca

Pełny odczyt jest funkcją (a) widocznych krotek pieczęci, (b) definicji tabel (lista, nazwy, typy kolumn, szybkie
wartości domyślne `attmissingval`), (c) funkcji wyjściowych typów i ustawień sesji, (d) markerów i ról.

- (a) PostgreSQL nigdy nie zmienia krotki tabeli użytkownika w miejscu (in-place tylko dla katalogów systemowych, a i
  tam nie dla treści). INSERT/UPDATE/DELETE — także w trybie replica, także bez zmiany wartości, także TRUNCATE i
  ponowne wstawienie — daje widoczną wersję z nowym `xmin`. Surowy `xmin` przeżywa `VACUUM FREEZE` (sprawdzone na
  klonie i przez recenzenta: ponowne zajęcie slotu `(0,1)` po zamrożeniu ma inny `xmin`). TOAST: DML na tabelach TOAST
  jest zabroniony nawet superużytkownikowi. Dziecko dziedziczenia z wierszem dodaje wiersz z innym `tableoid`
  (i tak `count=1` odrzuca).
- (b) każda zmiana kolumny (ADD z DEFAULT, RENAME, DROP, ALTER TYPE, SET DEFAULT) to nowa wersja wiersza
  `pg_attribute` (a często `pg_class`); podmiana tabeli to inny `pg_class`. VACUUM FULL/CLUSTER zmieniają tożsamość
  (nowy `relfilenode`) — fałszywe chybienie, pełny odczyt do restartu.
- (c) kolumny pieczęci mają wyłącznie typy `pg_catalog` (`boolean`, `integer`, `text`, `jsonb`, `timestamptz`);
  `to_jsonb` zależy dla nich tylko od `TimeZone`, a kontekst transakcji wymaga `UTC` (jak zimna transakcja).
- (d) markery i role są czytane świeżo przy każdym wywołaniu.

W RR RO migawka katalogu i wierszy jest ta sama; DDL właściciela nie zatwierdzi się w trakcie transakcji, bo
`ordinary182_invalidate()` bierze wyłączne `982376` (`server/182_cold_schema_runtime_admission.sql:59`), a dzierżawa
trzyma współdzielone `982376` od przed `BEGIN`. Pozostaje klasa zaakceptowana w 236/239/241 (superużytkownik z
wyłączonymi wyzwalaczami zdarzeń w innej sesji); dla niej oba warianty są tylko sprawdzeniem w jednym punkcie czasu.

Zapytanie tożsamości zwraca tylko kolumny systemowe i wiersze `pg_catalog`, bez rzutowań i funkcji; operatory
kwalifikowane `OPERATOR(pg_catalog.=)`; porównanie w JS.

## Weryfikacja

- `tests/installation-identity248.test.mjs` (źródło profile-startup z kontrolowanymi portami, RW i RO): 0/9 na HEAD
  `d2024f6`, 9/9 po; `tests/order-read-installation.test.mjs` 11/11 bez zmian (fakt bez tożsamości → pełny odczyt);
  `tests/cold-approval-budget.test.mjs` 4/4 (port tożsamości).
- `tests/installation-identity248.database.test.mjs` (prawdziwe SQL na klonie `dynaminds_p256_20261027_01`): 16/16 —
  13 zmian (replica UPDATE tej samej wartości, także wiersza 209, fałszywa wartość, DELETE+INSERT, UPDATE tam i z
  powrotem, ADD COLUMN DEFAULT, RENAME, ALTER TYPE, DROP COLUMN, SET DEFAULT, dziecko z wierszem, tabela podmieniona
  kopią, TRUNCATE i ponowne wstawienie) zmieniają tożsamość; zmiany bez treści (GRANT/REVOKE, COMMENT, FOR UPDATE,
  wycofany savepoint, VACUUM FREEZE, ANALYZE, VACUUM FULL, CLUSTER) — tożsamość stała albo wycinek identyczny.
- Koszt wycinka odczytu (16 pieczęci, RR RO, mediana z 9): tożsamość 0,7 ms, pełny odczyt 91–104 ms.

## Bieg obciążeniowy (obie zmiany razem, 27.10)

Sterownik `tools/scale/load/` (commity sterownika jak w biegu próbnym), zbiór 1 % `dynaminds_scale_20261027_41`, kopia
na bieg, `--phases steady12:12:300,steady24:24:300 --warmup 60 --workers 2`, `track_functions=all` na kopii.

- **przed:** wydanie z `b976827` (HEAD bazowy + sterownik), kopia `_72`, `data/scale/load/p256-before-01`;
- **po:** wydanie z `7fff30f` na gałęzi `p256-loadtest-tmp` = ta gałąź (`6ffcfba`) + **tylko na potrzeby biegu**
  rejestracja 256 (wiersz manifestu, skompilowana para zimnego katalogu z klonu 245, linia projektora). Zimna inspekcja
  wydania przeszła z 256 (`SETUP_DONE`), ledger 236. Kopia `_75`, `data/scale/load/p256-after-03` (biegi `-01`/`-02`
  przerwał konflikt nazw kontenerów z równoległym biegiem innego agenta przy starcie setup; bez wyników).

| | steady12 przed | steady12 po | steady24 przed | steady24 po |
|---|---|---|---|---|
| RPS sukcesu (próg 10 / 20) | 6,11 | **13,58** | 5,77 | **13,68** |
| odczyty p50 / p95 / p99 ms | 15 / 210 / 235 | 12 / 23 / 28 | 20 / 269 / 541 | 12 / 29 / 93 |
| zapisy p50 / p95 / p99 ms | 252 / 6 400 / 7 930 | 175 / 2 500 / 2 880 | 407 / 6 200 / 7 520 | 151 / 2 450 / 3 150 |
| `order_detail` p50 / p95 / p99 | 192 / 231 / 330 | 20 / 27 / 41 | 235 / 484 / 782 | 19 / 36 / 106 |
| `order_create` p95 / p99 | 4 910 / 7 670 | 1 900 / 2 520 | 4 700 / 6 670 | 1 890 / 2 900 |
| `return_receive` p50 / p95 | 5 570 / 8 300 | 2 390 / 2 800 | 5 230 / 7 560 | 2 290 / 2 860 |
| operacje z progiem niespełnionym | 6 z 8 | 0 z 8 | 6 z 8 | 0 z 8 |
| błędy | 10 (6×500, 4 timeouty) | 1 | 1 | 67 × 409 „Za mało towaru” |
| najstarsze oczekujące zadanie p95 (próg 15 s) | 35,8 s | 14,0 s | 81,9 s | 33,0 s |
| CPU bazy średnio | 470 % | 478 % | 667 % | 450 % |
| obciążenie hosta (1 min) max | 22,7 | 15,6 | 83,6 | 16,2 |

Zastrzeżenia: obciążenie hosta przez innych agentów było w biegu „przed” wyższe (steady24 do 83,6), więc różnica nie
jest czystym efektem zmiany. 67 błędów 409 w steady24 „po” to wyczerpany stan magazynu zbioru 1 % przy ponad
dwukrotnie większej liczbie utworzonych zamówień (sterownik liczy je jako błędy; nie są błędem produktu). Próg 20 RPS
dla 24 klientów nadal nie jest osiągnięty; przepustowość nie rośnie z 12 do 24 klientów — dominuje blokada
`wms.operations` (B1: `Lock:advisory` 2 231 / 2 379 próbek) i strażnicy wewnątrz zapieczętowanych funkcji.

Funkcje (`pg_stat_user_functions`, steady12, 315–330 s): `catalog_stock_control_guards` wywoływane z TS przez werdykt:
4 484 wywołań `guard_verdict`, z tego 1 065 chybień (24 %; steady24 19 %) → czas strażników z TS ~960 s → ~470 s
mimo ~2,2× większego ruchu. Najczęstsza przyczyna chybień: `server/168_physical_parcel_wz.sql:244` tworzy w transakcjach
wysyłki tabelę `pg_temp.parcel_physical_wz_context ON COMMIT DROP`, a podstawa obejmuje wiersze TEMP wszystkich sesji
(239/248), więc każda równoległa transakcja wysyłki unieważnia podstawę na czas swojego trwania.
