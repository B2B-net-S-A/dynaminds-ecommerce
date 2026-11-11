# Spisy: trwałe limity zależne od planu i ograniczone sprawdzanie (29.10.2026)

Ten sam problem co w WMS partii ([WMS-LIMITS-20261026](WMS-LIMITS-20261026.md), commity fd7f783 i b42ca1f):
limity historii spisów były jednym zestawem na cały czas życia firmy, niezależnym od planu, a sprawdzano je
pełnym `count(*)`. Decyzja odwracalna z tego biegu: limity per plan, liczenie co najwyżej do limitu + 1.

## Co było

- `WMS_STOCKTAKE_LIMITS.heads` / `reviews` = 2000 na cały czas życia (`server/wms-stocktakes.ts:138-142`
  przed zmianą): `SELECT count(*) FROM wms_stocktakes` / `wms_stocktake_reviews` przy każdym nowym spisie
  i każdym przeglądzie.
- `STOCKTAKE_SCAN_LIMITS.receipts_per_tenant` = 1 000 000 (`server/stocktake-scans.ts:400-443` przed
  zmianą): przy **każdym skanie** `count(*)` wszystkich paragonów firmy (z `FILTER` na spis), potem
  `wmsLotsEvidenceBudgetInTx`, potem `sum(octet_length(to_jsonb(t)::text))` po 17 tabelach (15 tabel WMS
  i dwie tabele skanów) wobec wspólnego budżetu `evidence_bytes` = 128 MiB dla każdego planu.
  Firma z partiami z profilu etapu 5 ma ~1,5 GB historii WMS (~235 tys. operacji po ~6,5 KiB), więc po
  przekroczeniu 128 MiB każdy jej skan spisu dostawał 429, choć budżet WMS planu enterprise to 64 GiB.
- `STOCKTAKE_ADJUSTMENT_LIMITS` previews/receipts = 5000 — **egzekwowane w zapieczętowanym SQL**, nie w TS:
  `stocktake_adjustment_budget()` (`server/149_stocktake_adjustments.sql:129-140`), wołane z funkcji 149
  (`:216`, `:228`, `:305`) i z `server/stocktake-adjustments.ts:87`. Stała TS służy tylko do opisu
  (metadane, OpenAPI). Patrz „Czego nie zmieniono”.

## Co jest teraz (TS, bez nowego SQL)

`server/stocktake-limits.ts` (nowy): `STOCKTAKE_PLAN_LIMITS`, plan z `tenants.plan` firmy z zakresu
transakcji, jak w `wmsLotLimitsInTx`. Nieznany albo pusty plan dostaje małe limity.

| plan | heads | reviews | scan_receipts (firma) | wspólny budżet bajtów skanów |
|---|---:|---:|---:|---:|
| starter, business | 2 000 | 2 000 | 1 000 000 | 128 MiB (bez zmian) |
| enterprise | 200 000 | 200 000 | 2 000 000 | 96 GiB |

Limit na jeden spis (`receipts_per_stocktake` = 100 000) i limit otwartych spisów (20) nie są sumą
z całego życia i zostają bez zmian dla każdego planu.

Uzasadnienie wielkości (profil `acceptance-profile.v1.json`, §10 FULL-BASE-GOAL: na firmę 20 tys. SKU,
≥2 magazyny × ≥20 lokalizacji, 180 dni):
- **heads/reviews 200 000.** Jeden aktywny spis na magazyn (`wms_stocktake_active`). Spis cykliczny każdej
  lokalizacji w każdy dzień roboczy to 2 × 20 × 250 = 10 000 rocznie: 2000 starcza na ~50 dni, 200 000 na
  ~20 lat. Pamięć nadal ogranicza budżet bajtów WMS planu (tabele spisów są w liczniku 235).
- **scan_receipts 2 000 000.** Paragon = jedna zeskanowana sztuka (`increment` = 1). Pełny spis 20 tys. SKU
  po ~10 sztuk to ~200 tys. paragonów, więc 10 pełnych spisów (~4 lata przy dwóch pełnych spisach rocznie
  i spisach cyklicznych). Granica wynika z kosztu: liczenie biegnie przy każdym skanie i kosztuje
  ~80 ns na wiersz, więc 2M to ~190 ms — tyle, ile stary `count(*)` płacił dla business przy 1M (178 ms).
  Większy limit wymaga licznika (niżej), nie liczenia.
- **96 GiB.** Budżet jest wspólny z całą historią WMS (enterprise 64 GiB) plus 2M paragonów po maksimum
  ładunku z CHECK (16 KiB) = 32 GiB. Dla business 128 MiB jak dotąd.

Sprawdzanie:
- spisy i przeglądy: `count(*) FROM (SELECT 1 … WHERE tenant_id=<zakres> LIMIT cap+1)`, Index Only Scan;
- skan: to samo dla paragonów firmy (`LIMIT cap+1`) i osobno dla paragonów spisu (`LIMIT 100 001`, indeks
  `stocktake_scan_receipts_line`), zamiast jednego pełnego skanu z `FILTER`;
- bajty: część WMS (15 tabel) z licznika 235 (`wmsEvidenceUsageInTx(c, true)`, ten sam wzór
  `octet_length(to_jsonb(x)::text)`, rozjazd 0 według WMS-LIMITS; bez 235 — dokładny skan jak dotąd);
  dokładnie sumowane zostają tylko `stocktake_scan_receipts` i `stocktake_measurements`.

Komunikaty i kody błędów bez zmian (429 „Wyczerpano budżet historii spisów”, „Wyczerpano trwały limit
skanów”, „Wyczerpano wspólny budżet dowodów skanowania”).

## Pomiar (PG04, klon `dynaminds_stk29_20261029_02`, historia zatwierdzona i po VACUUM ANALYZE)

Jako `dyna_app` w zakresie firmy (RLS), ciepła pamięć, mediana z 5 (3 przy 5M). PG04 był w tym czasie
obciążony równoległym biegiem testów, więc liczby są górnym oszacowaniem.

| sprawdzenie | historia | stare | nowe |
|---|---|---:|---:|
| heads, business | 2 000 | 0,4 ms | 0,4 ms (LIMIT 2001) |
| heads, enterprise | 200 000 | 10,0 ms | 10,8 ms (LIMIT 200 001, przy nowym limicie) |
| reviews, enterprise | 200 000 | — | 9,4 ms |
| paragony firmy, business | 1 000 000 | 178 ms (count + FILTER, równoległy) | 82 ms (LIMIT 1 000 001) |
| paragony spisu | 100 000 w spisie | (w tym samym skanie) | 8,6 ms (LIMIT 100 001) |
| paragony firmy, enterprise | 5 000 000 | 714 ms | 88 ms przy LIMIT 1M+1; **191 ms przy nowym limicie 2M** |
| paragony firmy, 5M bez limitu | 5 000 000 | — | 470 ms (dlatego nie 5M) |
| bajty części WMS | licznik 235 | skan 15 tabel, O(historii WMS) | 0,2 ms (≤ 32 wiersze) |
| bajty tabel skanów (bez zmian) | 1M paragonów × ~2,9 KB | 3,2 s | 3,2 s |

Każde liczenie to Index Only Scan po indeksie zaczynającym się od `tenant_id`, `Heap Fetches` 0–4.

## Czego nie zmieniono i dlaczego

Punkty 1 i 2 rozwiązuje migracja 261 (przygotowana jako 277):
[STOCKTAKE-USAGE-P277-20261029](STOCKTAKE-USAGE-P277-20261029.md).

1. **Dokładna suma bajtów dwóch tabel skanów** zostaje O(historii skanów): 3,2 s przy 1M paragonów.
   Dla business budżet 128 MiB ogranicza ją do ~0,15 s; dla enterprise to ona, nie liczenie paragonów,
   spowolni skan na długo przed limitem 2M. Rozwiązaniem jest licznik jak 235
   (`stocktake_scan_usage`, wyzwalacze instrukcyjne AFTER INSERT z tablicą przejściową na
   `stocktake_scan_receipts` i `stocktake_measurements`), który usunąłby też liczenie paragonów.
   Sprawdzone w wycofanej transakcji na klonie `_01`: pusty wyzwalacz instrukcyjny na każdej z tych tabel
   zostawia 18 strażników `true` (10 z WMS-LIMITS, `warehouse_wz_issuer_guards`, `email_inbound_guards`,
   `order_merge_delivery209_valid`, `return_credit206_guards`, `ordinary188_structure_valid`,
   `return_credit211_metadata_valid`, `local_invoice_guards`, `stocktake_adjustment_guards`).
   To nowa migracja, więc decyzja i numer należą do koordynatora.
2. **Limity rozliczeń spisu (5000 podglądów, 5000 potwierdzeń, 5000 komend serii, 100 serii, 128 MiB)**
   są w zapieczętowanej `stocktake_adjustment_budget()` (149). Ta sama funkcja przy każdej transakcji
   rozliczeń, także przy odczycie, sumuje `pg_column_size` po 9 tabelach firmy (O(historii)).
   Zmiana w TS nic by nie dała. Sprawdzone w wycofanej transakcji na klonie `_01`: podmiana ciała
   `stocktake_adjustment_budget()` i ponowne wygenerowanie `stocktake_adjustment_manifest()` (jak blok DO
   w 149) zostawia te same 18 strażników `true`. Możliwa jest więc nowa generacja (migracja z limitami
   per plan i licznikiem zamiast sumy), ale to zmiana zapieczętowanej funkcji — poza tym torem.
   Dla business limit 5000 nie jest wiążący (spisów jest najwyżej 2000). Dla enterprise wiąże
   po ~5000 rozliczonych spisach (mniej przy ponawianych podglądach, TTL 900 s).
3. Metadane `GET` spisów i skanów (`limits`) nadal pokazują stałe schematu, nie limity planu (UI ich nie
   używa).
