# Spisy: liczniki zużycia zamiast pełnych sum (przygotowana migracja 277, 29.10.2026)

Dwa punkty z „Czego nie zmieniono” w [STOCKTAKE-LIMITS-20261029](STOCKTAKE-LIMITS-20261029.md). Oba wymagały SQL, więc
idą jako jedna przygotowana migracja z numerem zastępczym **277** (`server/277_stocktake_evidence_usage.sql`),
zintegrowana 29.10.2026 jako **migracja 261** (`261_stocktake_evidence_usage`, sekcja „Integracja jako 261” na końcu).
Nazwy obiektów nie mają numeru. Opisy do sekcji integracji mówią o 277 jak w czasie przygotowania. Wzorzec liczników: 235
([WMS-LIMITS-20261026](WMS-LIMITS-20261026.md)); wzorzec zmiany ciała zapieczętowanej funkcji: 250
([WMS-LOCK250-20261028](WMS-LOCK250-20261028.md)).

## Co było

1. `stocktake_adjustment_budget()` (`server/149_stocktake_adjustments.sql:129-140`), wołana na końcu
   `stocktake_adjustment_create_series` (`:216`), `…_preview` (`:228`), `…_finish` (`:305`) i w każdej transakcji
   rozliczeń w TS, także przy odczycie (`server/stocktake-adjustments.ts:87`):
   - cztery `count(*)` (serie > 100, podglądy > 5000, potwierdzenia > 5000, komendy serii > 5000);
   - suma `pg_column_size` po 9 tabelach firmy wobec 128 MiB;
   - jeden zestaw dla każdego planu, koszt O(historii rozliczeń).
2. Wspólny budżet bajtów skanu (`stocktakeScanBudgetInTx`, `server/stocktake-limits.ts` od `2dec917`):
   - przy każdym skanie dokładna suma `octet_length(to_jsonb(t)::text)` po `stocktake_scan_receipts` i
     `stocktake_measurements` firmy;
   - do tego liczenie paragonów firmy do limitu planu + 1.

## Co robi 277

### 1. Rozliczenia spisu (149)

- `stocktake_adjustment_usage(tenant_id PK, series, series_commands, previews, receipts, bytes)` — jeden wiersz na
  firmę. Każdy zapisujący 149 i tak trzyma `stocktake_adjustment_lock()` i tryb `serial`, więc sloty jak w 235 nie są
  potrzebne. RLS włączone i wymuszone, polityka jak w 149, bez uprawnień dla `dyna_app`.
- Wyzwalacze instrukcyjne z tablicami przejściowymi:
  - AFTER INSERT na 9 tabelach (`stocktake_adjustment_usage_insert`);
  - AFTER UPDATE na `counters` i `admissions` (`stocktake_adjustment_usage_update`), bo tylko te dwie są zmienialne;
  - pozostałe tabele odrzucają UPDATE/DELETE (`stocktake_adjustment_immutable`), a `counters`/`admissions` — DELETE.
  - Funkcje `stocktake_adjustment_usage_track()` i `…_track_update()` (SECURITY DEFINER, `search_path=pg_catalog,public`)
    mieszczą się w `stocktake_adjustment_%`, więc pieczętuje je manifest 149.
- Miara bajtów to rozmiar zapisanego wiersza, jak w 149, czytany po kluczu z tabeli w podzapytaniu skalarnym:
  - krotka przejściowa nie jest jeszcze skompresowana, więc jej rozmiar byłby za duży;
  - mały wiersz (< 127 B) przeczytany w innym kształcie planu, np. przez złączenie lub materializację, wychodzi o 3 B
    krótszy (krótki nagłówek varlena). Stara suma 149 bywa więc niższa od licznika o ≤ 3 B na wiersz;
  - test to sprawdza (licznik = rozmiar zapisanych wierszy, różnica do starej sumy ∈ [0; 3 B × wiersze]).
- Nowe ciało `stocktake_adjustment_budget()`:
  - ta sama sygnatura, właściciel, SECURITY INVOKER i `search_path`, te same komunikaty i `54000`;
  - czyta wiersz licznika i `tenants.plan`, bez żadnego `count(*)`, sumy ani odwołania do 9 tabel.
- Manifest jest generowany ponownie tą samą instrukcją co ostatni blok DO 149 (`CREATE OR REPLACE` zachowuje OID i
  odebrane ACL), potem następuje pętla `REVOKE` z 149. Wcześniej migracja sprawdza `stocktake_adjustment_guards()`, żeby
  nie zapieczętować rozjechanego modułu (uwaga z przeglądu bezpieczeństwa).
- Backfill w transakcji migracji pod `LOCK … IN SHARE MODE` na 9 tabelach.

Limity (`STOCKTAKE_ADJUSTMENT_PLAN_LIMITS` w `server/stocktake-limits.ts`; test wiąże literały SQL z tą tabelą):

| plan | serie | komendy serii | podglądy | potwierdzenia | bajty |
|---|---:|---:|---:|---:|---:|
| starter, business (nieznany plan nie istnieje: FK `tenant_service_plan`) | 100 | 5 000 | 5 000 | 5 000 | 128 MiB (bez zmian) |
| enterprise | 100 | 5 000 | 500 000 | 500 000 | 16 GiB |

Uzasadnienie dla enterprise, spójne z `STOCKTAKE_PLAN_LIMITS`:
- Potwierdzenie rozlicza jeden zaksięgowany spis (`UNIQUE(tenant_id,wms_stocktake_id)` i `…quantity_stocktake_id`).
- Business ma 2 000 spisów i 5 000 rozliczeń, czyli 2,5 na spis. Enterprise ma 200 000 spisów (×100), więc 500 000
  (×100). Limit nie wiąże przed limitem spisów; ponowione podglądy (TTL 900 s) mają ten sam zapas co w business.
- 16 GiB / 500 000 = 34 KiB na rozliczenie. Business dostaje 26 KiB (128 MiB / 5 000), więc limit bajtów nie wiąże
  przed limitem liczby przy tej samej mieszance spisów.
- Zmierzone: jedno rozliczenie 6 pozycji to ok. 11,8 KB (test), podgląd z 6 wierszami w zasiewie ~6,8 KB.
  Duże spisy pełne (do 10 000 pozycji) mieszczą się w zapasie po spisach cyklicznych.
- To 1/4 budżetu WMS enterprise (64 GiB).
- Serie i komendy serii to konfiguracja, nie historia (komenda = jedna nowa seria), więc zostają bez zmian.

### 2. Bajty dwóch tabel skanów

- `stocktake_scan_usage(tenant_id, slot 0–31, receipts, bytes)` — kopia kształtu `wms_evidence_usage` (235):
  - zapisujący bierze wolny slot (`FOR UPDATE SKIP LOCKED`), więc nie ma jednego gorącego wiersza;
  - RLS: polityka `TO dyna_app` w zakresie firmy, tylko `SELECT` dla `dyna_app`.
- Wyzwalacze instrukcyjne:
  - AFTER INSERT na `stocktake_scan_receipts` (094 odrzuca UPDATE/DELETE);
  - AFTER INSERT/UPDATE/DELETE na `stocktake_measurements` (pomiar bez skanu właściciel może zmienić lub usunąć, 094).
- Miara: `octet_length(to_jsonb(x)::text)`, ta sama co w sprawdzeniu TS i w 235, niezależna od przechowywania.
- Backfill pod `LOCK … IN SHARE MODE`.
- Nazwy relacji w nowych funkcjach SECURITY DEFINER mają schemat (`public.`): ich `search_path` nie wymienia `pg_temp`,
  więc tabela tymczasowa sesji o tej nazwie byłaby znaleziona pierwsza. Znalezisko przeglądu bezpieczeństwa:
  - czerwony test na ciele bez schematu: licznik 0 zamiast 1;
  - zielony po poprawce;
  - ta sama luka jest w `wms_evidence_usage_add` (235) i nie została tu zmieniona (zapieczętowana migracja).
- TS: `stocktakeScanBudgetInTx` czyta licznik firmy (≤ 32 wiersze), gdy `to_regclass('public.stocktake_scan_usage')`
  istnieje. Licznik daje paragony i bajty, więc liczenie paragonów firmy też znika.
  - Liczenie paragonów jednego spisu (`LIMIT 100 001`, 8,6 ms) zostaje.
  - Bez licznika działa dotychczasowa ścieżka, jak w fd7f783: ograniczone liczenie i dokładna suma.
  - Komunikaty i kody bez zmian.

Wiersze zapisane z wyłączonymi wyzwalaczami (`session_replication_role=replica`) nie trafiają do liczników, jak w 235.
Testy, które tak zasiewają paragony (`tests/stocktake-plan-limits.test.ts`), dopisują je do licznika same.

## Pomiar (PG04)

PG04 był współdzielony i obciążony równoległymi biegami. Mediany z 3–5 przebiegów, ciepła pamięć.

**Skan** — klon `dynaminds_p277_20261029_09` = kopia `dynaminds_stk29_20261029_02` przez TEMPLATE przy 0 połączeń
(6 000 000 zatwierdzonych paragonów, 7,8 GB: firma `1111…` 5 000 000, firma `acd2…` 1 000 000). Pomiar jako `dyna_app`
w zakresie firmy.

| sprawdzenie | 1 M paragonów firmy | 5 M paragonów firmy |
|---|---:|---:|
| dokładna suma bajtów dwóch tabel (przed) | 3 339 ms | 12 773 ms |
| liczenie paragonów firmy do limitu (przed; business 1 M+1 / enterprise 2 M+1) | 106 ms | 190 ms |
| licznik 277 (po; paragony i bajty) | 0,2 ms | 0,2 ms |

- Licznik po backfillu = dokładna suma dla obu firm: 1 000 000 paragonów / 2 870 556 369 B oraz
  5 000 000 / 6 687 778 541 B.
- Backfill 277 na tych 6 M: 41,5 s w transakcji migracji.
- Uwaga: suma „przed” przy 1 M była liczona na tabeli z 6 M wierszy (filtr RLS). `2dec917` podaje 3,2 s przy 1 M w
  tabeli z ~1 M, czyli ten sam rząd.

**Rozliczenia** — w jednej wycofanej transakcji zasiano N rozliczeń skopiowanych z jednego prawdziwego
(podgląd + 6 pozycji + zgoda + potwierdzenie, wyzwalacze wyłączone). Pomiar jako właściciel w zakresie firmy.

| historia firmy | stare ciało 149 (cała ścieżka) | nowe ciało 277 |
|---|---:|---:|
| 5 000 podglądów / potwierdzeń (34 MB) | 125 ms (klon `_02`, obciążony PG04); 16 ms (klon `_05`, spokojniej) | 0,3 ms |
| 200 000 (1,36 GB) | 454 ms / 386 ms (ciało 149 jako zapytanie; sama funkcja odmawia już na liczeniu) | 0,2 ms |

Stare ciało biegnie w każdej transakcji rozliczeń, także w odczycie listy serii i podglądu, i rośnie liniowo z historią.
Nowe czyta jeden wiersz. Przy 200 000 nowe ciało nie widzi zasianych wierszy, bo zasiano je z wyłączonymi
wyzwalaczami, więc pomiar pokazuje tylko koszt odczytu licznika.

## Strażnicy

Skrypt `guards.mjs` (kopia: `local-builds/full-base-preview-20261017/p277-source-20261029-01/guards.private.mjs`):
- 18 nazwanych strażników:
  - 10 strażników z WMS-LIMITS;
  - `warehouse_wz_issuer_guards`, `email_inbound_guards`, `catalog_stock_control_guards`, `financial_return_guards`,
    `stocktake_adjustment_guards`;
  - `warehouse_inventory_policy_guards`, `catalog_stock_count_guards`, `catalog_stock_return_guards`.
- Wszystkie 79 bezargumentowych funkcji boolowskich `*_guards` / `*_valid` / `*guard`; `jit=off`, UTC.
- Na HEAD 64/79 `true`; 15 to strażnicy historycznych generacji (`ordinary177…186_valid`, `large_import173_parents/pim`,
  …), `false` już na HEAD.

| klon | stan | nazwani | wszyscy | różnice wobec HEAD |
|---|---|---:|---:|---:|
| `_01` | HEAD (`migrate()`, ledger 248, `258_wz_issuer_refresh`) | 18/18 | 64/79 | — |
| `_01` | 277 w wycofanej transakcji | 18/18 | 64/79 | 0 |
| `_05` | `migrate()` + 277 + testy 277 | 18/18 | 64/79 | 0 |
| `_09` | kopia stk29 6 M + 277 | 18/18 | 64/79 | 0 |

Pliki: `scratchpad/p277/guards-01-head.json`, `guards-01-probe.json`, `guards-05-after277.json`,
`guards-09-after277.json` (kopie w katalogu `p277-source-20261029-01`).

## Testy

`tests/stocktake-evidence-usage277.test.ts` (13 testów; część bazodanowa tylko na `dynaminds_p277_YYYYMMDD_NN`):
- czerwony `7cb70d1`: 1/11 na `_02` (HEAD, bez SQL 277 i bez ścieżki licznika w TS);
- zielony: 13/13 na świeżym `_05` (prawdziwe `migrate()`, 277 ręcznie w `before()`);
- test podmiany przez tabelę tymczasową: czerwony na `_04` (ciało bez schematu), zielony na `_05`.

Zakres testów:
- tożsamość ciała 149;
- regeneracja manifestu i pętla REVOKE;
- literały limitów;
- ścieżka licznika i ścieżka zapasowa TS (fałszywy klient);
- strażnicy, uprawnienia i RLS nowych obiektów;
- prawdziwe rozliczenia ON i OFF przez HTTP: licznik = zapisane wiersze;
- limity per plan w SQL;
- 413 dla business przy odczycie;
- licznik skanów = dokładna suma po INSERT/UPDATE/DELETE dla dwóch firm, a sprawdzenie TS czyta licznik.

Regresja na `_05` z 277 (pliki po kolei, PG04 obciążony):

| plik | wynik |
|---|---|
| `tests/stocktake-plan-limits.test.ts` | 5/5 (zasiane paragony dopisane do licznika 277) |
| `tests/stocktake-scans-engine.test.ts` | 18/18 (prawdziwe skany przez HTTP, licznik aktywny) |
| `tests/wms-stocktakes-flow.test.ts` | 3/3 |
| `tests/stocktake-scans-safety.test.ts` | 9/15 |
| `tests/stocktake-adjustments.test.ts` | 17/22 |

Porażki `scans-safety`:
- 6 × „Actual scan request never waited on this own held resource”;
- test daje żądaniu 3 s na dojście do celowo trzymanej blokady, a `tenantTx` na PG04 trwa ok. 15 s.

Porażki `stocktake-adjustments`:
- 3 × „Actual posting must reach the deliberately held … lock” (ten sam wzorzec czasu);
- 1 × różnica w `auth237_api_key_state.last_used_at`: `productCatalogFacts` porównuje stan klucza API, który zmienia
  każde jego użycie (237). Nie dotyczy to 277.

- 1 × test 21 (ON, flush): `postStocktakeAdjustmentInTx` w `tenantTx` bez `wmsAdmission:'serial'` dostaje 409
  „Silniejszą blokadę WMS należy wybrać przed rozpoczęciem transakcji” (reguła 250). Test sprzed 250; wariant OFF
  przechodzi. Na HEAD sprawdzone przy integracji: ten sam 409, test poprawiony (sekcja „Integracja jako 261”).

Kontrola na klonie HEAD bez 277 (`_02`, ten sam PG04; biegi przerwane po pierwszych wynikach):
- `scans-safety`: te same porażki 1–4 i 6–9 (8 z pierwszych 10 testów);
- `stocktake-adjustments` (podzbiór): te same porażki testu kluczy API i dwóch testów „fresh role withdrawal”.

Porażki są więc niezależne od 277. Pliki: `scratchpad/p277/control-safety-02-head.txt` i `control-adj-02-head.txt`.

Po wszystkich biegach na `_05` zapytanie rozjazdu (`scratchpad/p277/drift.sql`, pełne przeliczenie) daje 0 rozjazdów:
36 firm z danymi skanów, 23 firmy z rozliczeniami.

## Ryzyka i otwarte

- Backfill trzyma blokady SHARE na 11 tabelach przez czas pełnego odczytu dwóch tabel skanów (41,5 s przy 6 M). Migracja
  powinna iść w oknie bez skanów.
- Limit miękki jak w 250: sloty skanów nie widzą otwartych transakcji innych zapisujących. Pełna suma też ich nie
  widziała.
- Ręczne zapisy z wyłączonymi wyzwalaczami rozjeżdżają liczniki. Zapytanie rozjazdu:
  `exactScan`/`exactAdjustment` w teście.
- `stocktake_adjustment_usage` nie jest w liście tabel `stocktake_adjustment_guards()`/`metadata()`. Dodanie wymagałoby
  trzeciej zmiany funkcji 149. Wyzwalacze i funkcje licznika manifest pieczętuje.
- Ta sama luka `pg_temp` w `wms_evidence_usage_add` (235): do osobnej generacji.
- (W czasie przygotowania) para zimnego katalogu nie była skompilowana; przy integracji skompilowana dokładnie w oczekiwanym kształcie.

## Integracja jako 261 (29.10.2026)

Wzorzec 250/257 (zmiana ciała zapieczętowanej funkcji) i 235 (liczniki). Cztery commity przygotowania (7cb70d1, 362e833,
0e941d1, 59ed8ca z `worktree-agent-a719ac1d0e629b92e`) przeniesione cherry-pickiem (cdfcaf0…b09063c); `4345f4d` pominięty,
bo to kopia `2dec917`, już na gałęzi jako `f788f4e`. Dwa konflikty, oba w regexach rodzin klonów
(`tests/stocktake-plan-limits.test.ts`: `int29b` z HEAD i `p277` z toru; `tests/stocktake-scans-safety.test.ts`: `lk29` i
`p277`), rozwiązane przez zachowanie obu. Potem commity integracji (4f8d1c8 testy, 3dfc500 migracja, 124dbda test 21,
niżej) i ten dokument.

- SQL: `server/277_stocktake_evidence_usage.sql` → `server/261_stocktake_evidence_usage.sql`; zmienia się tylko pierwsza
  linia komentarza („Migration 261_stocktake_evidence_usage (prepared as 277, registered after
  260_automation_runs_queued_job; …)”); 15 265 B, sha256 `8637a541e4022ceee631e4e191e894bee1d441c6c7ee91b6f5c4f5757d83203d`.
  Wiersz manifestu `261_stocktake_evidence_usage` (`native_id` `stocktake_evidence_usage261`, kontrakt
  `stocktake-evidence-usage261`) po 260; `server/db.ts` bez zmian.
- Zimny katalog: kompilacja na `dynaminds_m261_20261029_01` (szablon + 218…260 + ledger; poprzednik = skompilowany after260
  `49bcaf55…96543906`), dokładnie jak przewidywał §3 `INTEGRATION-p277.md`: **2 zmiany** (`stocktake_adjustment_budget()` i
  zregenerowany `stocktake_adjustment_manifest()`: tylko `source` i `definition`), **74 dodania** (tabele
  `stocktake_adjustment_usage` i `stocktake_scan_usage` z 13 kolumnami, 20 ograniczeniami, 2 indeksami PK i ich relacjami,
  4 typami wierszy, 2 politykami; 6 funkcji SECURITY DEFINER tylko dla właściciela; 15 wyzwalaczy instrukcji na tabelach
  149/029/094 i 8 wyzwalaczy RI dwóch kluczy obcych do `tenants`), 0 usunięć. Rekordy tabel nie zawierają list wyzwalaczy,
  więc żaden rekord tabeli się nie zmienia. after261 `34f306f3…569e30d8` (47 070 rekordów); osiemnastu strażników true przed
  i po (w tym `stocktake_adjustment_guards`: zregenerowany manifest 149 pieczętuje nowe ciało, funkcje i wyzwalacze).
  `stocktake-evidence-usage261-source-contract.mjs`, `-source-compatibility.mjs` (`projectCompiledStocktakeEvidenceUsage261Catalogue`:
  usuwa dodania, czyta oba ciała z powrotem do rekordów 149, potem łańcuch od 260; footprint: gołe nazwy
  `stocktake_adjustment_usage` i `stocktake_scan_usage`), jedna linia w `release-cold-projectors.mjs`. Wyniki:
  `local-builds/full-base-preview-20261017/m261-source-20261029-01/`.
- Ledger 251 (guard: przyszłe `262_…`, `263_…`); MIG-2 stosuje 244…261; MIG-1 i MIG-4 oczekują serii 244…261 (MIG-1/2/4
  uruchomione raz po 262: dokument SECDEF-PGTEMP-P278); rodzina `m261` w testach DB 236…260, installation-identity,
  settlement report, MIG-1/2/4, worker-supervision i pięciu plikach spisu otwartych przez tor dla p277.
- Testy: `tests/stocktake-evidence-usage261.test.ts` (było `…277`; przypięcie wiersza manifestu zamiast „prepared, not
  registered”, `before()` nie nakłada SQL ręcznie, tylko sprawdza, że prawdziwe `migrate()` założyło liczniki i wiersz
  ledgera), `tests/stocktake-evidence-usage261-source-compatibility.test.mjs` (7, ostatni opt-in).
- **Test 21 `tests/stocktake-adjustments.test.ts` (124dbda).** „ON genuine post and explicit deferred flush …” wołał
  `postStocktakeAdjustmentInTx` w `tenantTx` z domyślnym przyjęciem WMS i dostawał 409 „Silniejszą blokadę WMS należy wybrać
  przed rozpoczęciem transakcji” (reguła 250). Na HEAD przed 261 (58d7e96, klon `dynaminds_m260_20261029_03`, regex pliku
  otwarty dla tego klonu tylko w jednorazowym worktree): OFF 1/1, ON 0/1 z tym 409, więc test był nieaktualny, nie zepsuty
  przez 277. Trzeci argument `{ wmsAdmission: 'serial' }` (jak własna transakcja trasy: zapis → `serial`): 2/2 na tym samym
  klonie; na klonie 261 test 21 przechodzi. Zamiar bez zmian (późny dodatkowy fragment dziennika po prawdziwym PW/RW → 23514,
  wycofanie całości).
- `INTEGRATION-p277.md` usunięty (treść tutaj).

| Sprawdzenie (PG04, klony `dynaminds_m261_20261029_NN`; wyniki w `m261-source-20261029-01/tests/`) | Wynik |
|---|---|
| `_02` świeży klon na 124dbda (drzewo `int261-prep`), prawdziwe `migrate()` | ledger 251, ostatnia `261_stocktake_evidence_usage` |
| strażnicy na `_02` (jit=off, UTC; `guards-A-02.json`) | 14 + `stocktake_adjustment_guards`, `warehouse_inventory_policy_guards`, `catalog_stock_count_guards`, `catalog_stock_return_guards` = 18 true; po testach true |
| wszystkie 79 boolowskich strażników (`allguards-261-02.json` wobec klonu 260 `allguards-260-02.json`) | 64/79 true, wszystkie 79 wartości identyczne (15 false to strażnicy historycznych generacji, jak na HEAD) |
| inspekcja zimna na `_02` (`cold-A-02.json`) | COLD_INSPECTION_PASSED, `native_catalogue_sha256` = after261 `34f306f3…`, flagi 216…261 true |
| `tests/stocktake-evidence-usage261.test.ts` (`_02`) | 13/14 (test 9: HTTP 503 w przygotowaniu fikstury, 57014 przy obciążeniu PG04) / powtórzenie raz: **14/14** |
| `tests/stocktake-plan-limits.test.ts` (`_02`) | 5/5 |
| `tests/stocktake-adjustments.test.ts` (`_02`) | 17/22: test 21 przechodzi; 5 (różnica `auth237_api_key_state.last_used_at`) i 15–17 („Actual posting must reach the deliberately held … lock”, 3 s wobec ok. 15 s `tenantTx` na PG04) to te same porażki co kontrola HEAD toru; 14: HTTP 503 (57014) przy obciążeniu PG04 |
| test 21 na HEAD przed 261 (`dynaminds_m260_20261029_03`) przed / po poprawce | 1/2 (ON: 409) / 2/2 |
| bez bazy (drzewo `int261-prep`): zestaw jak przy 260 + testy 261 | 704/726, 21 pominiętych opt-in; 1 czerwony to `tests/stocktake-adjustments-migration.test.ts`, test bazodanowy odmawiający bez `dynaminds_test_N` (dodany do zestawu omyłkowo) |
| `tests/stocktake-evidence-usage261-source-compatibility.test.mjs` z opt-in na prawdziwych katalogach 261 | 7/7 |
| `npx tsc --noEmit -p .` | czysto |
