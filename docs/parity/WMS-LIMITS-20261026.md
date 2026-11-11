# WMS: limity historii partii zależne od planu i budżet dowodów O(1) (26.10.2026)

Przeszkoda 9 z [MEASUREMENT-MANIFEST-20261025](../scale/MEASUREMENT-MANIFEST-20261025.md) (sekcja 7):
firma z partiami w pełnym profilu etapu 5 potrzebuje ~235 000 operacji WMS (66 724 `reserve`,
136 741 `scan`, 30 571 `dispatch`, 976 `return`), a produkt zatrzymywał ją po 100 000 operacji
i po 128 MiB historii (skan zapisuje pełny JSON zamówienia, ~10 KiB; budżet wyczerpuje się już
po ~13 000 skanów). Decyzja odwracalna z tego biegu: limity zależne od planu, sprawdzanie
budżetu niezależne od długości historii.

## Co było

- `WMS_LOT_LIMITS.operations = 100000`, `layers = 100000`, `previews = 2000`,
  `evidence_bytes = 128 MiB` (`server/wms-lots-schema.ts:4-15`) — jeden zestaw dla każdej firmy,
  liczony od początku istnienia firmy. Historia WMS jest nieusuwalna (`wms_row_guard`, 090),
  więc to trwałe limity: po ich osiągnięciu każda operacja WMS firmy dostaje 429 na zawsze.
- `quota()` przed zapisem: trzy `count(*)` na tabelach firmy; `wmsLotsEvidenceBudgetInTx()` po
  zapisie: te same liczności i `sum(octet_length(to_jsonb(t)::text))` po **wszystkich** wierszach
  15 tabel WMS firmy, przy każdej operacji (`server/wms-lots.ts:185-245` przed zmianą). Koszt O(n).
- **W SQL tych limitów nie ma.** Przejrzane: 090, 092, 093, `wms-stocktake-invariants.sql` i
  wszystkie migracje z `wms_operations`/`to_jsonb`/`134217728` — żadna funkcja, trigger ani CHECK
  nie liczy operacji ani bajtów historii WMS. (128 MiB w SQL mają inne moduły: 089, 098, 099, 102,
  103, 104, 108–113, 115, 120, 123, 124, 151 — nie WMS partii.) Limit jest wyłącznie w TS.

## Co jest teraz (TS, w tym biegu)

`server/wms-lots-limits.ts` (nowy), `server/wms-lots.ts`, `server/wms-lots-transaction.ts`.

1. **Limity per plan** — `WMS_LOT_PLAN_LIMITS`, plan czytany z `tenants.plan` firmy z zakresu
   transakcji (`app.tenant_id`), jak robią to limity planu w `enforce_workspace_quota` (012):

   | plan | operations | layers | previews | evidence_bytes |
   |---|---:|---:|---:|---:|
   | starter, business | 100 000 | 100 000 | 2 000 | 128 MiB (bez zmian) |
   | enterprise | 10 000 000 | 10 000 000 | 2 000 (bez zmian) | 64 GiB |

   Semantyka zostaje **trwała (na cały czas życia firmy)**, nie okno kroczące: celem limitu jest
   ograniczenie nieusuwalnej pamięci, którą jedna firma może zająć, a okno ograniczałoby tylko
   tempo przyrostu, nie sumę. 10 mln operacji to ~20 lat firmy z profilu etapu 5 (235 tys. na
   180 dni); 64 GiB odpowiada ~6,5 KiB na operację. Nieznany albo pusty plan dostaje małe limity.
   `GET /api/wms-lots` (metadane) zwraca teraz limity planu firmy (`limits`), nie stałe.
2. **Budżet O(1), gdy jest licznik** — `wmsEvidenceUsageInTx()`: jeśli w bazie jest tabela
   `wms_evidence_usage` (migracja 235, SQL niżej), sprawdzenie czyta ≤ 32 wiersze licznika po
   rozliczeniu operacji tej transakcji (`wms_evidence_usage_settle()`); `finalizeWmsActorsInTx`
   rozlicza jeszcze raz tuż przed COMMIT. Bez tabeli działa dotychczasowy pełny skan (ta sama
   dokładność, koszt O(n)) — to ścieżka baz sprzed 235; po `migrate()` każda baza ma licznik.
3. Seam testowy `injectWmsLotPlanLimitsForTest()` (tylko `DYNA_TEST=true`) — testy obniżają
   limity zamiast pisać 100 tys. wierszy.

Treść dowodów się nie zmienia: wiersze skanu dalej mają pełny JSON zamówienia, tabele dalej są
nieusuwalne i niezmienne, nic nie jest przycinane. Zmienia się tylko sposób liczenia sumy.

## Dlaczego licznik wymaga SQL i jaki kształt

Dokładny budżet w O(1) potrzebuje trwałego licznika, a więc nowej tabeli — tego nie da się zrobić
w samym TS (pamięć procesu nie jest trwała ani wspólna dla procesów, a znacznik czasu nie jest
bezpiecznym znakiem wodnym przy współbieżnych transakcjach). Pierwotnie była to propozycja bez
migracji; od 26.10.2026 jest migracją `235_wms_evidence_usage` (sekcja „Migracja 235” niżej). Blok SQL
na końcu dokumentu jest bajt w bajt plikiem migracji, a testy to sprawdzają.

**Pierwsza wersja (triggery na wszystkich 15 tabelach) odpada.** Sprawdzone na klonie
`dynaminds_wms_20261026_02`: jeden pusty trigger na `wms_operations` zmienia na `false`
10 strażników (`ordinary187_valid`, `buyer_address_guards`, `large_import173_valid`,
`fa3_draft_guards`, `pim_dictionary_valid`, `wave_print177_valid`, `nested172_valid`,
`cooperation171_valid`, `parcel_physical_wz_valid`, `operative_delivery_valid`), a wtedy każda
`tenantTx` w trybie źródłowym kończy się 503 „Niekompletny moduł PIM”. To samo dla
`wms_cost_layers`, `wms_layer_movements`, `wms_issue_fragments`, `wms_return_fragments`
(katalog tych tabel jest w odcisku strażników). Trigger na `wms_previews`, `wms_lots` i 8 tabelach
spisu, nowa tabela, indeks i funkcje — strażnicy zostają `true`.

**Kształt (z propozycji, w 235 bez zmian):**
- `wms_evidence_usage(tenant_id, slot 0–31, operations, layers, previews, bytes)` — licznik
  w 32 slotach; zapisujący bierze wolny slot przez `FOR UPDATE SKIP LOCKED`, więc współbieżne
  zapisy jednej firmy nie stoją w kolejce do jednego gorącego wiersza (i nie tworzą przez niego
  zakleszczeń). Odczyt = suma ≤ 32 wierszy po kluczu głównym.
- `wms_evidence_settled(tenant_id, operation_id, layers, bytes)` — rozliczenie per operacja.
  Pięć tabel z odcisku liczy się per operacja: wiersz operacji + jej `wms_cost_layers`,
  `wms_layer_movements`, `wms_issue_fragments`, `wms_return_fragments` (wszystkie mają
  `operation_id NOT NULL` i indeks `(tenant_id, operation_id, …)`). Na klonie 0 z 86 wierszy
  potomnych ma inny `xmin` niż ich operacja, czyli potomkowie powstają w transakcji operacji.
- `wms_evidence_usage_settle()` (SECURITY DEFINER, `EXECUTE` dla `dyna_app`) rozlicza widoczne
  operacje firmy z `created_at >= transaction_timestamp()` (indeks `wms_operations_page`):
  własne i ewentualnie cudze zatwierdzone, których autor nie rozliczył. Ponowne rozliczenie
  dodaje tylko różnicę, więc wiersz potomny dopisany po wcześniejszym sprawdzeniu w tej samej
  transakcji też się policzy; podwójnego liczenia nie ma (test). Koszt zależy od liczby operacji
  w trakcie tej transakcji, nie od historii.
  **Od 250 (28.10.2026, [WMS-LOCK250](WMS-LOCK250-20261028.md))** zwykli zapisujący WMS jednej firmy
  dzielą blokadę `wms.operations:<firma>` (tryb współdzielony), więc cudze operacje zatwierdzają się w
  trakcie otwartej transakcji. Ciało z 235 blokowało (`FOR UPDATE` do COMMIT) wiersz `wms_evidence_settled`
  każdej widocznej operacji, także cudzej zatwierdzonej; dwie otwarte transakcje dawały wtedy 40P01.
  `250_wms_evidence_settle_unlocked` zastępuje tylko ciało: wiersz rozliczenia czyta bez blokady, aktualizuje
  go tylko, gdy nadal ma przeczytane wartości, brakujący wstawia z `ON CONFLICT DO NOTHING` (bez podwójnego
  liczenia). Liczniki zostają dokładne. Limity trwałe są od 250 **miękkie**: sprawdzenie budżetu przed
  zapisem widzi licznik bez operacji transakcji, które są w tej chwili otwarte, więc limit można przekroczyć
  o wiersze transakcji trwających równocześnie (najwyżej tyle operacji, ile zapisów firmy jest naraz w toku);
  następna transakcja po ich COMMIT dostaje 429.
- `wms_previews`, `wms_lots` i 8 tabel spisu (`wms_stocktake*`) — zwykłe triggery
  instrukcyjne z tablicami przejściowymi; UPDATE tylko na `wms_stocktakes` i `wms_stocktake_lines`
  (jedyne aktualizowalne, wersjonowane), reszta i tak odrzuca UPDATE/DELETE.
- `dyna_app` ma tylko `SELECT` na obu tabelach (RLS `tenant_scope`); zmienia je wyłącznie kod
  SECURITY DEFINER. Backfill w tej samej transakcji migracji pod `LOCK … IN SHARE MODE` pięciu
  tabel, czyli bez okna między skanem a licznikiem (na klonie 184 ms).
- Zastrzeżenie: przyszła migracja, która doda kolumnę do tych tabel, zmienia `to_jsonb` starych
  wierszy (np. 092 dodał 3 kolumny do `wms_operations`); licznik zostaje wtedy przy rozmiarze
  z chwili zapisu. Taka migracja powinna przeliczyć backfill (te same dwa `INSERT … SELECT`
  po `DELETE` z obu tabel).
- Ograniczenie: rozliczenie per operacja zakłada, że wiersze potomne powstają w transakcji swojej
  operacji (tak robi każda ścieżka aplikacji). Wiersz dopisany ręcznie SQL-em do operacji
  rozliczonej wcześniej (robią tak tylko fikstury testów, np. `tests/wms-validation-scopes.test.ts:163`)
  nie trafi do licznika. Kontrola rozjazdu (konserwacja, koszt O(n)): zapytanie niżej.

```sql
-- Rozjazd licznika i pełnej sumy dla jednej firmy ($1); 0 = zgodnie.
SELECT (SELECT coalesce(sum(n),0) FROM (
  SELECT octet_length(to_jsonb(x)::text) n FROM wms_operations x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_previews x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_lots x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_cost_layers x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_layer_movements x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_issue_fragments x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_return_fragments x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_stocktakes x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_stocktake_lines x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_stocktake_scope_layers x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_stocktake_measurements x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_stocktake_measurement_layers x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_stocktake_reviews x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_stocktake_review_rows x WHERE tenant_id=$1
  UNION ALL SELECT octet_length(to_jsonb(x)::text) FROM wms_stocktake_postings x WHERE tenant_id=$1) s)
 -(SELECT coalesce(sum(bytes),0) FROM wms_evidence_usage WHERE tenant_id=$1) drift;
```

## Pomiary (PG04, klony szablonu `dynaminds_restore_36751abef3079f3f` po `migrate()`)

Czas jednego sprawdzenia budżetu (`wmsLotsEvidenceBudgetInTx`, rola `dyna_app`, mediana z 7–9),
historia firmy enterprise dobijana kopiami jej wiersza skanu (~10 KiB, pełne zamówienie).

| operacje w historii | przed (pełny skan), klon 01 | po (licznik), klon 05 |
|---:|---:|---:|
| 17 | 1,09 ms | 0,93 ms |
| 1 000 | 25,73 ms | 0,57 ms |
| 3 000 | 78,92 ms | 0,42 ms |
| 6 000 | 148,29 ms | 0,79 ms |
| 12 000 | — | 0,69 ms |

Przed: liniowo ~25 µs na operację historii; ekstrapolacja do 235 tys. operacji pełnego profilu
to ~5,8 s na sprawdzenie (przy `statement_timeout=8s` puli), a budżet 128 MiB kończy się po
~13 tys. skanów. Po: stałe ~0,5–0,9 ms niezależnie od historii. Ten sam przebieg w teście
(`dynaminds_wms_20261026_06`): pełny skan 33,65 ms przy 1 000 → 146,82 ms przy 4 000 operacji;
licznik 0,57 ms przy 4 000 → 0,48 ms przy 8 000. Zastosowanie propozycji z backfillem: 184 ms.
Surowe wyniki: `scratchpad/wmslim/bench-before.txt`, `bench-after.txt`, `t06.txt`.

## Testy

`tests/wms-lots-limits.test.ts` (7 testów, od 235 — 8; świeży klon `dynaminds_(wms|m235)_20261026_NN`;
limity planu obniżone przez `injectWmsLotPlanLimitsForTest`, nie 100 tys. wierszy):

1. tabela planów: enterprise ≥ 1 mln operacji, starter = business = dotychczasowe wartości,
   nieznany plan / `null` / `__proto__` → małe limity;
2. obecny schemat: ta sama firma z historią powyżej limitu małego planu — na `business` skan
   dostaje 429 „Wyczerpano trwały limit dowodów WMS”, na `enterprise` zapisuje; po dojściu do
   limitu enterprise też 429 i nic nie zapisuje;
3. obecny schemat: czas sprawdzenia rośnie z historią (stan przed poprawką, > 2× przy 4× historii);
4. `migrate()` stosuje na klonie 234 dokładnie `235_wms_evidence_usage` (blok SQL dokumentu = plik migracji),
   wszystkie 10 strażników zostaje `true`, backfill = pełny skan (operacje, warstwy, podglądy, bajty)
   (do 26.10.2026: blok propozycji wykonywany przez test, sprawdzane 3 strażniki);
5. jak 2, przez liczniki;
6. prawdziwe zapisy przez `tenantTx` (w tym dwa skany i dwa dodatkowe sprawdzenia w jednej
   transakcji) — licznik = pełny skan; zapis odrzucony budżetem (429 „Wyczerpano budżet…”)
   wycofuje się razem z licznikiem;
7. (od 235) puste INSERT/UPDATE na 10 tabelach z triggerami i podgląd otwarcia przez `createWmsOpeningPreview`
   — działają, podglądy +1, licznik = pełny skan;
8. 235: czas sprawdzenia płaski (4 000 → 8 000 operacji), < 25 ms, licznik nadal = pełny skan.

Kolejność TDD: test 3 na obecnym kodzie pokazuje wzrost (RED dla wymagania O(1)), testy 2/5
nie istniały wcześniej (import `injectWmsLotPlanLimitsForTest` i limit 100 000 dla enterprise).

Istniejące testy WMS (klony `dynaminds_test_20261026NN`, bo ich strażnik wymaga nazwy
`dynaminds_test_<cyfry>`), porównane z tym samym plikiem na czystym HEAD `d6c2714` (worktree bez zmian):

| plik | ze zmianą | HEAD bez zmian |
|---|---|---|
| `wms-lots-values` | 9/9 | — |
| `wms-lots-flow` | 0/4 | 0/4 (te same 4: `PATCH /orders/…/status` 422, `POST /orders` 500) |
| `wms-lots-safety` | 13/21, 7 fail | 13/21, te same 7 (czekanie na blokadę, `POST /products` 500) |
| `wms-stocktakes-boundary` + `-concurrency` + `-values` | 6/10 → `-values` ponownie 7/7 | 7/10 (te same 3 w boundary/concurrency) |
| `wms-stocktakes-flow` + `-safety` + `wms-validation-scopes*` | 22/29; `-safety` ponownie 10/15 | 23/29; jedyna różnica: `-safety` „frozen admin review replay” padł w setupie na `POST /products: 500` (poza WMS), w ponownym biegu przechodzi — te same 5 porażek co HEAD |

Wszystkie odchylenia od HEAD to przekroczenia czasu na współdzielonym PG04 (4 biegi równolegle,
strażniki całej bazy w każdej transakcji) i znikają w ponownym biegu; żadna porażka nie dotyczy
limitów (`429`) — test limitu podglądów (`wms-lots-safety` 14) przechodzi. `npx tsc --noEmit -p .`
czysto, `run-bw.sh` 318/318.

## Uruchomienie testu

Od 235 test wymaga klonu zmigrowanego wydaniem 234 (ledger kończy się na `234_carriers`, np. `migrate()`
z drzewa na `4bbdadb`); sam stosuje 235 przez `migrate()`. Nazwa `dynaminds_wms_…` albo `dynaminds_m235_…`.

```bash
S=<scratchpad>; bash $S/wmslim/clone.sh dynaminds_wms_20261026_NN   # migrate() z drzewa wydania 234
DATABASE_URL=postgresql://postgres:…@127.0.0.1:57084/dynaminds_wms_20261026_NN \
DYNA_LOCAL_CONFIG_PATH=$S/pg04-test-config.json DYNA_TEST=true \
node node_modules/tsx/dist/cli.mjs --test tests/wms-lots-limits.test.ts
```

Test wymaga świeżego klonu (stosuje 235 i dopisuje historię); limity czasu puli podnosi
tylko w swoim procesie (`relaxPoolTimeouts` z `tests/failure-helpers.ts`).

## Otwarcie WMS: limit wierszy stanu zależny od planu (29.10.2026)

**Co blokowało.** `openingSnapshot` (`server/wms-lots.ts`) ładował do pamięci wszystkie wiersze `stock` i
`stock_locations` firmy, także zerowe, i odrzucał otwarcie powyżej `WMS_LOT_LIMITS.physical_rows = 10000`
(413 „Otwarcie obejmuje za dużo stanów”). Każdy produkt dostaje wiersz stanu przy założeniu
(`server/domain.ts:115`), więc firma z 20 000 SKU (profil akceptacyjny, firmy A/C/E: 19 200 wierszy stanu
i lokalizacji, dodatnich ~950) nie mogła włączyć partii, a pełnego zbioru nie dało się wygenerować
(`docs/scale/FULL-DATASET-GEN-20261029.md`, bieg 3). Gdyby limit sam zniknął, padłoby dalej: cały podzbiór
trafiał do migawki podglądu (`bounded` 5 MiB, zapis w `wms_previews`, `snapshot_summary` w szczególe podglądu).

**Co jest teraz.**

| plan | wiersze `stock` i osobno `stock_locations` w jednym otwarciu |
|---|---:|
| starter, business | 10 000 (bez zmian, dalej 413 i nic nie jest zapisane) |
| enterprise | 200 000 |
| nieznany / pusty | 10 000 |

`WMS_LOT_OPENING_ROWS` i `wmsLotOpeningRowsForPlan()` w `server/wms-lots-limits.ts`, plan z `tenants.plan`
jak przy limitach historii; `GET /api/wms-lots` zwraca go jako `limits.opening_rows`. 200 000 = 100 000 SKU
w obu magazynach profilu skali (MAIN + zapasowy), czyli zapas ×10 nad profilem akceptacyjnym i ×2 nad
wymaganiem „≥ 100 000 SKU na firmę”. Wyżej limit nie idzie, bo blokada wszystkich wierszy jest jedną
instrukcją pod `statement_timeout` 8 s (pomiar niżej: 0,4 s przy 2 × 100 000 wierszy).

Wiersze bez zapasu (stan `on_hand=0 AND reserved=0`, lokalizacja `quantity=0`) nie tworzą partii i nie dają
blokady otwarcia. Dalej są blokowane `FOR UPDATE` w tej samej jednej uporządkowanej instrukcji na tabelę
(kolejność blokad bez zmian), ale do migawki trafiają jako liczba i skrót SHA-256 liczony w SQL
(`zero_stock: {stocks: {rows, digest}, bins: {rows, digest}}`), a nie jako wiersze. Skrót obejmuje wszystkie
kolumny, które te wiersze miały w migawce (wersja stanu, SKU, nazwa, rodzaj, wersja produktu; dla lokalizacji
lokalizacja i wersja stanu), więc każda zmiana, która wcześniej unieważniała podgląd (409 przy aktywacji),
unieważnia go nadal. Wiersze z zapasem i z rezerwacją są w migawce jak dotąd: semantyka otwarcia dla nich się
nie zmienia (wszystkie dodatnie lokalizacje w jednym żądaniu, linie ≤ `physical_rows` = 10 000 i ≤ 2 MiB
żądania na każdym planie). Stronicowanie podglądu nie było potrzebne: rozmiar zależy od liczby wierszy
z zapasem, nie od katalogu.

**Pomiar** (PG04, klon `dynaminds_wmsopen_20261029_05` szablonu po `migrate()`, firmy z rejestracji przez
`POST /api/auth/signup`, 950 produktów z zapasem przez `createProduct`, reszta zerowych wierszy SQL-em
właściciela z włączonymi triggerami; `tests/wms-lots-opening-scale.test.ts`, wyniki
`wms-opening-scale-results`):

| | 19 200 wierszy | 100 000 wierszy |
|---|---:|---:|
| pusty `tenantTx` (koszt stały PG04) | 9 666 ms | 12 180 ms |
| `GET opening-scope` (migawka bez blokad) | 9 819 ms | 14 099 ms |
| podgląd (`createWmsOpeningPreview`, blokady) | 10 058 ms | 14 971 ms |
| aktywacja (950 warstw) | 15 809 ms | 19 556 ms |
| sama blokada obu tabel jako `dyna_app` | 17 ms | 402 ms |
| zapisany podgląd / szczegół podglądu | 929 604 B / 611 298 B | 929 604 B / 611 298 B |

Koszt stały PG04 (~10–12 s na `tenantTx`, strażnicy całej bazy) dominuje. Ponad pusty `tenantTx` otwarcie
kosztuje przy 19 200 wierszach +0,2 s (zakres) / +0,4 s (podgląd), przy 100 000 +1,9 s / +2,8 s; każda
instrukcja SQL migawki mieści się w 8 s z dużym zapasem (sama blokada 0,4 s). Rozmiar podglądu i szczegółu
jest ten sam przy obu rozmiarach katalogu (zależy od 950 wierszy z zapasem). Pomiar jednorazowy na
współdzielonym PG04, bez powtórzeń: liczby porównywalne tylko rzędem wielkości.

Przed poprawką (HEAD `90a821d`, klon `_01`): ta sama firma 19 200 wierszy na `enterprise` → 413
„Otwarcie obejmuje za dużo stanów” (`wms-lots.ts:1321`); `business` 413 przed i po.

**Testy.** `tests/wms-lots-opening-limits.test.ts` (bez bazy, 3): tabela planów, nieznane plany i
`__proto__` → 10 000, enterprise ≥ 200 000, `openingSnapshot` czyta limit planu i ma po jednej blokadzie
`FOR UPDATE` na tabelę. `tests/wms-lots-opening-scale.test.ts` (PG04, 3): 19 200 wierszy — `business` 413
bez zapisu podglądu, `enterprise` podgląd + aktywacja (warstwy = dodatnie lokalizacje); zmiana nazwy produktu
bez zapasu po podglądzie → aktywacja 409, polityka nie powstaje; 100 000 wierszy na `enterprise` otwiera się,
podgląd < 2 MiB i szczegół < 1 MiB. Istniejące testy otwarcia na klonach tej samej rodziny (strażnik nazwy
`wms-lots-safety`/`-flow` dopuszcza `dynaminds_wmsopen_20261029_NN`): `wms-lots-safety` 21/21 (`_03`, przed
dołożeniem SKU/nazwy do skrótu; `_06` na końcowym kodzie: 21/21), `wms-lots-flow` 4/4 (`_04`).
Re-pin `wms-lots.ts` (`dc86556a…`, 97 981 B) w `catalog-stock-writer-coverage.ts` i
`scripts/full-base-scale-http-ports.mjs`; testy pinów i lineage 123/123, `npx tsc --noEmit -p .` czysto.

```bash
S=<scratchpad>; bash $S/clone.sh dynaminds_wmsopen_20261029_NN   # CREATE DATABASE … TEMPLATE + migrate()
DATABASE_URL=postgresql://postgres:…@127.0.0.1:57084/dynaminds_wmsopen_20261029_NN \
DYNA_LOCAL_CONFIG_PATH=$S/pg04-test-config.json DYNA_TEST=true \
node node_modules/tsx/dist/cli.mjs --test tests/wms-lots-opening-scale.test.ts   # ~12 min, nowy klon na bieg
```

## Do decyzji poza tym biegiem

- Otwarcie wymaga wszystkich dodatnich lokalizacji firmy w jednym żądaniu (≤ 10 000 linii, ≤ 2 MiB). Firma
  z ponad ~10 000 lokalizacjami z zapasem nie otworzy partii na żadnym planie; profil etapu 5 ma ~950.
  Zmiana (otwarcie partiami lub limit linii per plan) to zmiana semantyki otwarcia, poza tym biegiem.
- ~~Migracja z propozycją~~ — weszła jako 235 (26.10.2026), sekcja niżej.
- `business` (50 tys. zamówień/mies.) zostaje przy 100 tys. operacji na całe życie firmy, czyli
  przy ~12 operacjach na zamówienie wystarcza na ~8 tys. zamówień z partiami. Zgodnie z zadaniem
  bez zmian; podniesienie to decyzja produktowa.
- ~~`previews` 2 000 na całe życie firmy (podglądy otwarcia i przesunięć) też zostaje dla każdego
  planu; nie blokuje profilu etapu 5.~~ Błędne założenie: w teście obciążenia 29.10 firmy A/C/E wyczerpały
  2 000 podglądów w ~50 min i od tej chwili każda korekta i przesunięcie dostawało 429
  (`docs/scale/LOAD-TEST-FULL-20261029.md` §4.2). Od 29.10 `enterprise` ma 10 mln podglądów (jak operacje:
  podgląd staje się najwyżej jedną operacją); starter/business zostają przy 2 000. Liczone licznikiem 235
  (≤ 32 wiersze), budżet bajtów 64 GiB nadal ogranicza pamięć (podgląd ~4 KiB). Test
  `tests/wms-preview-plan-cap.test.ts`.

## Migracja 235 (26.10.2026): co przeszło z propozycji do migracji

| | propozycja (fd7f783) | migracja 235 |
|---|---|---|
| SQL | blok `wms-evidence-usage-proposal` w tym dokumencie, nagłówek „Proposal 236” | `server/235_wms_evidence_usage.sql` (9 724 B, sha256 `ef7b232d…d04d`); blok niżej = plik. Zmiany: nagłówek i **poprawka triggera** (niżej) |
| trigger INSERT/UPDATE | jedna `wms_evidence_usage_track()` dla obu, z gałęzią `… FROM wms_evidence_old x WHERE TG_OP='UPDATE'` | `wms_evidence_usage_track()` tylko dla INSERT (czyta wyłącznie `wms_evidence_new`) i nowa `wms_evidence_usage_track_update()` dla UPDATE dwóch nagłówków spisu (różnica rozmiaru) |
| rejestracja | brak | wiersz 235 w `migration-manifest.mjs` (`native_id` `wms_evidence_usage235`, kontrakt `wms-evidence-usage235`), program wydania 225 migracji |
| zimny katalog | brak | skompilowana para `wms-evidence-usage235-source-contract.mjs` / `-source-compatibility.mjs` (70 dodań: 4 relacje, 14 kolumn, 20 ograniczeń, 2 indeksy, 2 polityki, 4 funkcje, 4 typy, 20 triggerów — 12 własnych instrukcyjnych i 8 wewnętrznych RI kluczy obcych, w tym 2 na `wms_operations`; 0 zmian), poprzednik = skompilowany after234 `00c125e6…`, projektor w `release-cold-projectors.mjs` |
| stosowanie | test wykonywał blok w swojej transakcji | `migrate()` w transakcji serii (MIG-6/MIG-3 jak dla każdej migracji); backfill pod `LOCK … IN SHARE MODE` w tej samej transakcji |
| testy | `wms-lots-limits` stosował blok z dokumentu | `wms-lots-limits` (8 testów) na klonie po wydaniu 234 wywołuje `migrate()` w połowie pliku (ścieżka aktualizacji), sprawdza wszystkie 10 strażników i zapis do tabel z triggerami; nowe `wms-evidence-usage235.test.mjs` (bez bazy, 6) i `wms-evidence-usage235-source-compatibility.test.mjs` (6) |

**Błąd propozycji znaleziony przy migracji.** Funkcja triggera planuje każde zapytanie przy pierwszym
wykonaniu, a w triggerze INSERT nie ma tablicy przejściowej OLD — `WHERE TG_OP='UPDATE'` tego nie ratuje.
Każdy INSERT do `wms_previews`, `wms_lots` i 8 tabel spisu kończył się błędem
`relation "wms_evidence_old" does not exist` (w aplikacji: `POST /wms-lots/opening-previews` → 500,
`wms-stocktakes-flow` 1. test). Propozycja przeszła wcześniej testy, bo żaden nie pisał do tych tabel
(skany piszą tylko do pięciu tabel rozliczanych per operacja). Teraz: test 7 `wms-lots-limits` (puste
INSERT/UPDATE na wszystkich 10 tabelach + podgląd otwarcia przez `createWmsOpeningPreview`, licznik = pełny
skan) i test 6 `wms-evidence-usage235.test.mjs` (funkcja triggera INSERT nie odwołuje się do OLD).

Bez zmian zostały: kształt tabel, `wms_evidence_usage_add`, `wms_evidence_usage_settle`, uprawnienia, backfill
i zastrzeżenia z sekcji „Dlaczego licznik wymaga SQL” (dodanie kolumny do tych 15 tabel wymaga przeliczenia
backfillu w tej samej migracji; wiersz potomny dopisany ręcznie do rozliczonej operacji nie trafia do licznika —
zapytanie rozjazdu wyżej). Kod TS (`server/wms-lots-limits.ts`) nie zmienił się: przełącza się na licznik, gdy
tabela istnieje.

**Sprawdzone (PG04, klony `dynaminds_m235_20261026_NN` szablonu `dynaminds_restore_36751abef3079f3f`):**

- TDD, wymaganie O(1): `wms-evidence-usage235.test.mjs` na HEAD `4bbdadb` 0/5; `wms-lots-limits` na klonie 01
  z kodem HEAD 5/7 (test 4: `migrate()` nic nie stosuje; test 7: sprawdzenie 106,55 → 212,36 ms przy 4 000 →
  8 000 operacji).
- TDD, błąd triggera: z SQL propozycji (commit `2b8d9da`) `wms-lots-limits` na klonie 10 7/8 (nowy test 7:
  `relation "wms_evidence_old" does not exist`), statyczny 4/6; po poprawce klon 13 8/8 (`migrate()` 234→235
  180 ms, pełny skan 29,49 → 117,51 ms przy 1 000 → 4 000, licznik 0,35 → 0,36 ms przy 4 000 → 8 000),
  statyczny 6/6.
- Świeży klon 12: `migrate()` 218→235, ledger 225 wierszy, ostatni `235_wms_evidence_usage`; 10 strażników
  `true` (sesja z opcjami puli `timezone=UTC`, `jit=off`; bez nich `order_merge_delivery209_valid`,
  `return_credit206_guards`, `return_credit211_metadata_valid` i `local_invoice_guards` dają `false`/błąd
  także na 234 — to właściwość strażników, nie 235); zimna inspekcja `COLD_INSPECTION_PASSED`,
  `wms_evidence_usage235_active: true`, 44 420 rekordów, 37 s.
- Istniejące testy WMS po 235 (świeże klony 15/16, `migrate()` 218→235; strażnik nazwy bazy w tych dwóch plikach
  rozluźniony tylko w kopii roboczej na `dynaminds_m235_…`): `wms-lots-values` + `wms-stocktakes-values` 16/16,
  `wms-stocktakes-flow` 3/3 (na 234 też 3/3; z SQL propozycji 1. test padał na 500 podglądu otwarcia). Po nich
  licznik = pełny skan (bajty, operacje, warstwy, podglądy) dla każdej firmy: 12 firm (7 ze spisami) i 8 firm
  (3 ze spisami), rozjazd 0 — czyli INSERT i UPDATE nagłówków spisu z prawdziwych przepływów liczą się dokładnie.
- Kompilacja na klonie 11 (218…234 ręcznie, potem 235): 10 strażników `true` przed i po 235 w tej samej transakcji.
- Bez bazy: `tests/release-migrations-*.test.mjs` + plan + 234/235 compat 201/202 (1 pominięty opt-in 234; opt-in
  dokładnej odwrotności prawdziwych katalogów 235→234 przechodzi), `migration-ledger-guard` 4/4, `run-bw.sh` 323/323,
  bramki/zasoby 207–211 + `tools/build/local-package` 116/118 (te same 2 porażki 207-snapshot co na HEAD),
  `npx tsc --noEmit -p .` czysto.

**Pomiar na prawdziwej migracji** (klon 14, firma enterprise `c89e1600…`, historia dobijana kopiami jej
wiersza skanu ~10 KiB, mediana z 7, rola `dyna_app`): przed — klon po `migrate()` wydania 234; po — ten sam
klon po `migrate()` 234→235 (backfill całej historii, w tym 12 000 dobitych operacji, 130 MB: 537 ms).

| operacje w historii | przed (pełny skan, 234) | po (licznik, 235) |
|---:|---:|---:|
| 17 | 1,49 ms | — |
| 1 000 | 31,11 ms | — |
| 3 000 | 90,26 ms | — |
| 6 000 | 183,84 ms | — |
| 12 000 | 359,42 ms | 0,60 ms |
| 24 000 | — | 0,46 ms |
| 48 000 | — | 0,50 ms |

Rozjazd licznika i pełnej sumy po backfillu i na końcu: 0 z 5 firm z historią WMS. (Ten sam pomiar na klonie 02
z SQL propozycji: 157,29 ms przy 6 000, 319,78 ms przy 12 000 → 0,65 / 0,44 / 0,48 ms; backfill 654 ms.)
Surowe wyniki w katalogu sesji `scratchpad/m235/`: `bench-before2.txt`, `bench-after2.txt`, `db-red.txt`,
`db-red2.txt`, `db-green2.txt`, `cold12.txt`, `guards12.txt`.

## SQL migracji 235 (`server/235_wms_evidence_usage.sql`)

Blok poniżej to bajt w bajt treść pliku migracji (pilnują tego `tests/wms-evidence-usage235.test.mjs` i
`tests/wms-lots-limits.test.ts`). Od propozycji różni się nagłówkiem i rozdzieleniem funkcji triggera.

```sql wms-evidence-usage235
-- Migration 235_wms_evidence_usage: per-tenant usage of undeletable WMS history in O(1)
-- (docs/parity/WMS-LIMITS-20261026.md). Read by server/wms-lots-limits.ts when the table exists.
-- No trigger or column touches wms_operations, wms_cost_layers, wms_layer_movements,
-- wms_issue_fragments or wms_return_fragments: their catalog is fingerprinted by
-- buyer_address_guards/ordinary187_valid/pim_dictionary_valid (one trigger there turns
-- 10 guards false). Rows of those five tables are settled per operation instead.
CREATE TABLE wms_evidence_usage (
 tenant_id uuid NOT NULL REFERENCES tenants,slot smallint NOT NULL CHECK(slot BETWEEN 0 AND 31),
 operations bigint NOT NULL DEFAULT 0 CHECK(operations>=0),layers bigint NOT NULL DEFAULT 0 CHECK(layers>=0),
 previews bigint NOT NULL DEFAULT 0 CHECK(previews>=0),bytes bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,slot)
);
-- One row per settled operation: its bytes (row + lots-free children) and layer count.
CREATE TABLE wms_evidence_settled (
 tenant_id uuid NOT NULL,operation_id uuid NOT NULL,layers bigint NOT NULL CHECK(layers>=0),
 bytes bigint NOT NULL CHECK(bytes>0),PRIMARY KEY(tenant_id,operation_id),
 FOREIGN KEY(tenant_id,operation_id) REFERENCES wms_operations(tenant_id,id)
);
ALTER TABLE wms_evidence_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_evidence_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON wms_evidence_usage TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE wms_evidence_settled ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_evidence_settled FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON wms_evidence_settled TO dyna_app
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON wms_evidence_usage,wms_evidence_settled TO dyna_app;
-- A writer takes a free slot (SKIP LOCKED) instead of queueing behind one hot row.
CREATE FUNCTION wms_evidence_usage_add(t uuid,ops bigint,lay bigint,pre bigint,b bigint) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s smallint;BEGIN
 IF ops=0 AND lay=0 AND pre=0 AND b=0 THEN RETURN;END IF;
 SELECT slot INTO s FROM wms_evidence_usage WHERE tenant_id=t ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1;
 IF s IS NULL THEN
  INSERT INTO wms_evidence_usage(tenant_id,slot) SELECT t,g FROM generate_series(0,31) g ON CONFLICT DO NOTHING;
  SELECT slot INTO s FROM wms_evidence_usage WHERE tenant_id=t ORDER BY slot FOR UPDATE SKIP LOCKED LIMIT 1;
 END IF;
 s:=coalesce(s,(pg_current_xact_id()::text::bigint%32)::smallint); -- all slots busy: wait, never skip
 UPDATE wms_evidence_usage SET operations=operations+ops,layers=layers+lay,previews=previews+pre,bytes=bytes+b
 WHERE tenant_id=t AND slot=s;
END $$;
-- Settles every visible operation of the tenant created since this transaction began (own ones,
-- and any committed one whose writer did not settle). Re-settling adds only the difference, so a
-- child row inserted after an earlier settle in the same transaction is still counted.
CREATE FUNCTION wms_evidence_usage_settle() RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t uuid=nullif(current_setting('app.tenant_id',true),'')::uuid;r record;old record;
 dops bigint=0;dlay bigint=0;db bigint=0;BEGIN
 IF t IS NULL THEN RETURN;END IF;
 FOR r IN SELECT o.id,
  octet_length(to_jsonb(o)::text)
  +(SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) FROM wms_cost_layers x WHERE (x.tenant_id,x.operation_id)=(t,o.id))
  +(SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) FROM wms_layer_movements x WHERE (x.tenant_id,x.operation_id)=(t,o.id))
  +(SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) FROM wms_issue_fragments x WHERE (x.tenant_id,x.operation_id)=(t,o.id))
  +(SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) FROM wms_return_fragments x WHERE (x.tenant_id,x.operation_id)=(t,o.id)) b,
  (SELECT count(*) FROM wms_cost_layers x WHERE (x.tenant_id,x.operation_id)=(t,o.id)) layers
  FROM wms_operations o WHERE o.tenant_id=t AND o.created_at>=transaction_timestamp() ORDER BY o.id
 LOOP
  SELECT * INTO old FROM wms_evidence_settled WHERE (tenant_id,operation_id)=(t,r.id) FOR UPDATE;
  IF NOT FOUND THEN
   INSERT INTO wms_evidence_settled VALUES(t,r.id,r.layers,r.b) ON CONFLICT DO NOTHING;
   IF FOUND THEN dops:=dops+1;dlay:=dlay+r.layers;db:=db+r.b;END IF;
  ELSIF (old.layers,old.bytes)<>(r.layers,r.b) THEN
   UPDATE wms_evidence_settled SET layers=r.layers,bytes=r.b WHERE (tenant_id,operation_id)=(t,r.id);
   dlay:=dlay+r.layers-old.layers;db:=db+r.b-old.bytes;
  END IF;
 END LOOP;
 PERFORM wms_evidence_usage_add(t,dops,dlay,0,db);
END $$;
-- Tables outside the fingerprinted five keep plain statement triggers. INSERT and UPDATE get separate
-- functions: an INSERT trigger has no OLD transition table, and a query naming it fails at parse time
-- even behind WHERE TG_OP='UPDATE' (found on the clone: every insert into wms_previews raised).
CREATE FUNCTION wms_evidence_usage_track() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;BEGIN
 FOR r IN SELECT tenant_id,count(*) n,sum(octet_length(to_jsonb(x)::text)) b FROM wms_evidence_new x GROUP BY tenant_id ORDER BY tenant_id
 LOOP
  PERFORM wms_evidence_usage_add(r.tenant_id,0,0,CASE WHEN TG_TABLE_NAME='wms_previews' THEN r.n ELSE 0 END,r.b);
 END LOOP;RETURN NULL;
END $$;
-- UPDATE (only the two versioned stocktake heads): the size difference; the row count does not change.
CREATE FUNCTION wms_evidence_usage_track_update() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;BEGIN
 FOR r IN
  SELECT tenant_id,sum(b) b FROM (
   SELECT tenant_id,octet_length(to_jsonb(x)::text) b FROM wms_evidence_new x
   UNION ALL SELECT tenant_id,-octet_length(to_jsonb(x)::text) FROM wms_evidence_old x
  ) d GROUP BY tenant_id ORDER BY tenant_id
 LOOP
  PERFORM wms_evidence_usage_add(r.tenant_id,0,0,0,r.b);
 END LOOP;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION wms_evidence_usage_add(uuid,bigint,bigint,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION wms_evidence_usage_track() FROM PUBLIC;
REVOKE ALL ON FUNCTION wms_evidence_usage_track_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION wms_evidence_usage_settle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wms_evidence_usage_settle() TO dyna_app;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY[
 'wms_previews','wms_lots','wms_stocktakes','wms_stocktake_lines','wms_stocktake_scope_layers',
 'wms_stocktake_measurements','wms_stocktake_measurement_layers','wms_stocktake_reviews',
 'wms_stocktake_review_rows','wms_stocktake_postings'] LOOP
 EXECUTE format('CREATE TRIGGER wms_evidence_usage_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS wms_evidence_new FOR EACH STATEMENT EXECUTE FUNCTION wms_evidence_usage_track()',t);
 -- Only the two versioned stocktake heads are updatable; every other table rejects UPDATE/DELETE.
 IF t IN ('wms_stocktakes','wms_stocktake_lines') THEN
  EXECUTE format('CREATE TRIGGER wms_evidence_usage_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS wms_evidence_old NEW TABLE AS wms_evidence_new FOR EACH STATEMENT EXECUTE FUNCTION wms_evidence_usage_track_update()',t);
 END IF;
END LOOP;END $$;
-- Backfill inside the migration transaction. The five settled tables are locked against writers
-- first, so no operation lands between the scan and the ledger.
LOCK TABLE wms_operations,wms_cost_layers,wms_layer_movements,wms_issue_fragments,wms_return_fragments IN SHARE MODE;
INSERT INTO wms_evidence_settled(tenant_id,operation_id,layers,bytes)
SELECT o.tenant_id,o.id,coalesce(l.n,0),octet_length(to_jsonb(o)::text)+coalesce(l.b,0)+coalesce(m.b,0)+coalesce(i.b,0)+coalesce(f.b,0)
FROM wms_operations o
LEFT JOIN (SELECT tenant_id,operation_id,count(*) n,sum(octet_length(to_jsonb(x)::text)) b FROM wms_cost_layers x GROUP BY 1,2) l ON (l.tenant_id,l.operation_id)=(o.tenant_id,o.id)
LEFT JOIN (SELECT tenant_id,operation_id,sum(octet_length(to_jsonb(x)::text)) b FROM wms_layer_movements x GROUP BY 1,2) m ON (m.tenant_id,m.operation_id)=(o.tenant_id,o.id)
LEFT JOIN (SELECT tenant_id,operation_id,sum(octet_length(to_jsonb(x)::text)) b FROM wms_issue_fragments x GROUP BY 1,2) i ON (i.tenant_id,i.operation_id)=(o.tenant_id,o.id)
LEFT JOIN (SELECT tenant_id,operation_id,sum(octet_length(to_jsonb(x)::text)) b FROM wms_return_fragments x GROUP BY 1,2) f ON (f.tenant_id,f.operation_id)=(o.tenant_id,o.id);
INSERT INTO wms_evidence_usage(tenant_id,slot,operations,layers,previews,bytes)
SELECT tenant_id,0,sum(o),sum(l),sum(p),sum(b) FROM (
 SELECT tenant_id,1 o,layers l,0 p,bytes b FROM wms_evidence_settled
 UNION ALL SELECT tenant_id,0,0,1,octet_length(to_jsonb(x)::text) FROM wms_previews x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_lots x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktakes x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_lines x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_scope_layers x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_measurements x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_measurement_layers x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_reviews x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_review_rows x
 UNION ALL SELECT tenant_id,0,0,0,octet_length(to_jsonb(x)::text) FROM wms_stocktake_postings x
) e GROUP BY tenant_id;
```
