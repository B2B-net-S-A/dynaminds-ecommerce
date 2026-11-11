# Migracja 247: wymiary sprzedaży (ANALYTICS-002), nadpisania repricingu (REPRICE-004), wynik kanału (REPRICE-005/006) (27.10.2026)

Migracyjne części torów S7 ([REPORTS-S7](REPORTS-S7-20261026.md)) i S9 ([REPRICING-S9](REPRICING-S9-20261026.md)) z
[STAGE4-NONINTEGRATION-GAP-20261025](STAGE4-NONINTEGRATION-GAP-20261025.md). Migrację przygotowano w osobnym drzewie
pod numerem zastępczym 252 (`4775904` testy czyste, `dfcb0f5` test DB i widok, `7cb5b04` kod, `c224886` poprawka
UI, `c972c21` instrukcja). Tu dostała numer 247, po `246_b2b_trade_credit_directory`.

## Co powstało

`server/247_sales_dimensions_repricing.sql` (5 695 B, sha256 `62fd185e…a9700b`). Trzy własne tabele; żadna tabela
rdzenia nie jest zmieniana, wskazywana kluczem obcym ani zapisywana; brak funkcji, triggera, bloku `DO` i wierszy.
Nazwy nie mają numeru, więc zmiana numeru dotknęła tylko nazwy pliku, nagłówka i artefaktów integracji. Żadna nie
pasuje do zapieczętowanych rodzin odcisku (test statyczny to sprawdza).

| Tabela | Wymaganie | dyna_app | Uwagi |
|---|---|---|---|
| `order_sales_dimensions` (PK tenant_id, order_id) | ANALYTICS-002 | SELECT, INSERT | grupa i etykieta dostawy oraz płatności, dostawca, pochodzenie `import`/`backfill`; tylko dopisywana |
| `repricing_overrides` | REPRICE-004 | SELECT, INSERT, UPDATE | `exclude` albo `fixed` (grosze brutto), powód, autor, czas, `replaces`, odwołanie; jedno aktywne na cennik i produkt (indeks częściowy) |
| `repricing_channel_results` (PK tenant_id, run_id, listing_id) | REPRICE-005/006 | SELECT, INSERT, UPDATE | oczekiwana cena przebiegu per oferta, stan pending/sent/acknowledged/mismatch/failed/superseded, plan, odczytana cena, błąd |

RLS `tenant_scope` z `FORCE` na trzech tabelach; `dyna_app` bez `DELETE` i `TRUNCATE`.

## Zachowanie

- **ANALYTICS-002**: importer kanału (`importOrder`: Woo, Allegro, Shopify, PrestaShop, eBay, Amazon, Mirakl, Odoo)
  zapisuje wymiar w transakcji importu (`server/imports.ts` → `recordOrderSalesDimensionsInTx`). Administrator
  uzupełnia starsze zamówienia z `inbound_orders.raw` (`POST /api/reports/sales/dimensions/backfill`, 500 na
  wywołanie). `GET /api/reports/sales/groups` grupuje po źródle, dostawie albo płatności, z okresem porównawczym i
  sumami per waluta; udziały i zmiany wartości widzi tylko rola z prawem do wartości. Zakładka „Grupy i porównanie”.
  Zamówienia ręczne, podzielone i scalone nie mają wymiaru („Brak danych”); płatność bez wymiaru bierze
  `orders.payment_mode` (cod → „Za pobraniem”). Base wire nadal nie mapuje `delivery_method`/`payment_method`.
- **REPRICE-004**: wykluczenie albo cena stała per cennik i produkt z autorem i czasem; podglądy, apply (409 po
  zmianie) i przebiegi harmonogramu je respektują (wykluczone SKU liczone jako pominięte). Cena stała nie jest
  przycinana do minimum z marżą; wiersz ma `below_floor`. Odwołane nadpisania zostają jako historia.
- **REPRICE-005/006**: przebieg harmonogramu zapisuje w transakcji partii oczekiwane ceny per oferta zsynchronizowana
  z cennika; uzgodnienie z pierwszym planem offer-sync po zapisie (tick workera po pracy harmonogramu i
  `POST /api/repricing-runs/:id/channel/reconcile`). Podsumowanie kanału w przebiegach i historii.
- Na kopii bez 247 aplikacja działa jak przed nią (`to_regclass`): importer nic nie zapisuje, grupowanie tylko po
  źródle (dostawa/płatność 503), nadpisania i kanał `available:false` albo 503.

## Integracja jako 247

- Cherry-pick pięciu commitów na `goal/full-base-20261017` (`f49e221`, `4bbd2a9`, `694648c`, `7d5eb53`, `909784e`)
  bez konfliktów: żaden plik przygotowania nie zmienił się na gałęzi od `f9b3811` (poprawki 243, bezpieczeństwa,
  244/245/246, etap 3, MIG-3), w tym `server/imports.ts`, pliki repricingu i UI raportów. `INTEGRATION.md` wzięty z
  gałęzi i usunięty tutaj; treść jest w tym pliku.
- Zmiana nazwy na `247_sales_dimensions_repricing` (plik SQL i nagłówek bez „placeholder”), komentarze i komunikaty
  „migracja 247”, testy `tests/sales-dimensions-repricing247*.{test.mjs,database.test.ts}`,
  `tests/sales-dimensions247.test.ts`, `tests/repricing247.test.ts`. Wiersz manifestu: `native_id`
  `sales_dimensions_repricing247`, kontrakt `sales-dimensions-repricing247`, 5 695 B.
- Skompilowana para zimnego katalogu na klonie `dynaminds_m247_20261027_01` (szablon + 218…246 + ledger, poprzednik
  = skompilowany after246 `f8d560c1…d7771cc2`): **140 dodań, 0 zmian, 0 usunięć** (11 relacji, 59 kolumn,
  53 ograniczenia, 8 indeksów, 6 typów wierszy, 3 polityki). After247 = `daec0d29…15156bcbf0` (45 913 rekordów).
  Dwunastu strażników `true` przed i po. Kompilator i wyniki:
  `local-builds/full-base-preview-20261017/sales-dimensions-repricing247-source-20261027-01/` (limit strażników
  w kompilatorze podniesiony do 60 s, bo pierwszy bieg na obciążonym PG04 przekroczył 8 s; odczyt katalogu zostaje
  na 8 s, czytnik wymaga skończonego limitu).
- `sales-dimensions-repricing247-source-contract.mjs`, `sales-dimensions-repricing247-source-compatibility.mjs`
  (`projectCompiledSalesDimensionsRepricing247Catalogue`: usuwa dodania, a pełnych poprzedników 246…217 czyta przez
  łańcuch odwrotności zaczynający się od 246), jedna linia w `release-cold-projectors.mjs`. Ślad rodziny to zwykły
  prefiks `(?:^|[.:"])_?(?:order_sales_dimensions|repricing_overrides|repricing_channel_results)` (bez `\b`).
- Ledger: 237 migracji, przyszłe nazwy w teście to `248_future_release`, `249_after_that`. Test MIG-2 od klonu na
  243 oczekuje czterech migracji `applied` (244–247). Test 246 sprawdza, że po nim idzie 247.
- Test bazodanowy 247 działa na prawdziwym `migrate()` (rodzina `m247`); rodzina `m247` jest dopisana w testach
  236/239/240/241/242/243/244/245/246 i w `tests/settlement-report.database.test.ts`.
- Piny: żaden plik zmieniony przez 247 nie jest przypięty przez stock-writer, scale http-ports ani linię credit208
  (`server/imports.ts`, pliki repricingu i raportów nie występują w tych listach), więc pinów nie przeliczano;
  testy cofnięcia zostają dokładne do obecnych pinów sprzed 247. `server/app.ts` i `web/main.tsx` bez zmian.

## Weryfikacja (PG04 127.0.0.1:57084, klony `dynaminds_m247_20261027_NN`)

- `_01`: kompilacja pary zimnego katalogu (wyżej); strażnicy przed i po `true`.
- `_02`: `migrate()` od szablonu (217) do 247: ledger 237, ostatnia `247_sales_dimensions_repricing`. Dziesięciu
  strażników, `warehouse_wz_issuer_guards` i `email_inbound_guards` `true` (jit=off, UTC, READ ONLY). Inspekcja zimna
  `COLD_INSPECTION_PASSED`, 45 913 rekordów, `native_catalogue_sha256` = skompilowany after247 (`daec0d29…15156bcbf0`),
  `sales_dimensions_repricing247_active: true`, wszystkie wcześniejsze `*_active: true`, `mode209: active209_inverse`.
- `_03`: `tests/sales-dimensions-repricing247.database.test.ts` testy 1 i 2 zielone, test 3 przerwany limitem pliku
  20 min (PG04 obciążony innymi torami); strażnicy po biegu `true`.
- `_05`: ten sam test 3/3 na świeżym 247 z limitem 3 h (36 min): grupy dostawy courier/parcel_locker/personal_pickup,
  backfill 2 rekordy; kanał pierwszego przebiegu 3 potwierdzone, drugiego 1 potwierdzony, 1 błąd, 1 zastąpiony;
  strażnicy po biegu `true`.
- `_04` (klon zmigrowany przez `c856f6a` do 243, ledger 233): `tests/migration-checksums244.database.test.ts` 1/1
  (244, 245, 246, 247 `applied`, 001…243 `baseline`).
- Zostaje jeden klon: `dynaminds_m247_20261027_02` (świeży, 247). Pozostałe usunięte.

- Bez bazy: statyczne 247, czyste 247 (wymiary, repricing), ledger, `tests/release-migrations-*.test.mjs`,
  `tests/source-ddl-migration-plan.test.mjs`, statyczne 246, s5comm245, stock-writer, scale http-ports, credit208,
  local-woo ports, reguły repricingu 380/380; zgodność 246 i 247 12/12 (z prawdziwymi katalogami); raporty i
  repricing (jednostkowe) 34/34; web (`web/*.test.*` i `tests/*.component.test.*`) 501/501; run-bw 383/383;
  `npx tsc --noEmit -p .` czysto.

## Otwarte

1. Base wire nie przenosi formy dostawy i płatności (`server/base-wire-orders.ts` `unmapped`); zamówienia z Base
   nie mają wymiaru. To decyzja parytetu Base, poza 247.
2. Nadpisanie jest per cennik i produkt, nie per oferta; cena per oferta wymagałaby osobnego cennika oferty.
3. Stare testy DB `tests/repricing.test.ts` i `tests/repricing-schedules.test.ts`: w przygotowaniu 31/32 na
   obciążonym PG04 (jedna porażka z czasu żądań 20–35 s przy `observation_minutes: 1`), niepotwierdzone na
   nieobciążonej bazie; tu ich nie uruchamiano.
