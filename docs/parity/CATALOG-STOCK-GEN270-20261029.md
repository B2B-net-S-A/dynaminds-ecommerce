# CATALOG-STOCK-GEN270: nowa generacja adapterów ścisłej kontroli katalogu z werdyktem 248 (29.10.2026)

Przygotowana jako migracja `server/270_stock_verdict.sql` (numer zastępczy) i zintegrowana 29.10.2026 jako **migracja 255**
(`255_stock_verdict`, sekcja „Integracja jako 255” niżej). Nazwy obiektów nie zawierają numeru (`stock_verdict_`). Opisy
niżej, do sekcji integracji, mówią o 270 jak w czasie przygotowania.
Gałąź `worktree-agent-ab7e3be976c99eb68`, podstawa `bcd7196` (`goal/full-base-20261017`, ledger 243, ostatnia `253_mirakl_webhook_retention`).
Wzorzec: nowe obiekty poza zapieczętowanymi rodzinami, wołane z TS zamiast zapieczętowanych (239 `wz_issuer239_prepare_skip`,
248 `guard_verdict`); gwarancje werdyktu: `docs/parity/GUARD-VERDICTS248-20261027.md` (oraz 239/240/241).

## Problem

Pomiar łączny 248+250 (TASKS.md, etap 5) i bieg `p260-before-01` (`pg_stat_user_functions`, 12 klientów, 60 s rozgrzewki + 5 min):

| funkcja | wywołania | czas łącznie | ms/wywołanie |
|---|---|---|---|
| `catalog_stock_control_guards()` | 5 488 | 1 861 s | 339 |
| — z tego przez `guard_verdict_full` (chybienia werdyktu, głównie RR) | 3 268 | 1 114 s | 341 |
| — z tego przez `catalog_stock_control_require()` (z pominięciem werdyktu) | 2 213 | 746 s | 337 |
| `catalog_stock_control_effect_prepare` (TS 536 + w przyjęciu zwrotu 559) | 1 095 | 370 s | 338 |
| `catalog_stock_return_prepare` (`return_require` + `return_frame` + `effect_prepare` = 3 pełne strażniki) | 559 | 568 s | 1 016 |

Każde z 2 213 wywołań `require` pochodzi z trzech zapieczętowanych ciał: `catalog_stock_return_require` (559),
`catalog_stock_return_frame` (559) i `catalog_stock_control_effect_prepare` (1 095); ich suma to dokładnie 2 213. TS woła
`catalogStockControlAvailable(c)` (werdykt 248, trafienie) tuż przed `effect_prepare`, a potem zapieczętowane ciało i tak
uruchamia pełnego strażnika. Zmiana tych ciał w miejscu łamie 9–11 z 13 strażników (`…c4509fbf…/scratchpad/p260/sealprobe.txt`):
ich `prosrc` przypinają odciski 152/169/177/179–187/204/209.

## Projekt

Sześć nowych funkcji `stock_verdict_*` (bez numeru w nazwie). Każda jest kopią zapieczętowanego oryginału: ciało to `prosrc`
oryginału (z `pg_get_functiondef` na klonie z 253) z podmienionymi wyłącznie wywołaniami z tabeli; deklaracje są te same
(argumenty, wynik, `plpgsql`, `SECURITY DEFINER`, `search_path TO 'pg_catalog','public'`, `TimeZone` jak w oryginale,
właściciel, EXECUTE tylko dla właściciela).

| kopia | oryginał | podmiana |
|---|---|---|
| `stock_verdict_require()` | `catalog_stock_control_require()` | `catalog_stock_control_guards()` → `guard_verdict('catalog_stock_control_guards')` |
| `stock_verdict_return_require()` | `catalog_stock_return_require()` | `catalog_stock_control_require()` → `stock_verdict_require()` (`catalog_stock_return_guards()`, ~5 ms, zostaje pełny) |
| `stock_verdict_return_frame(uuid,uuid,jsonb)` | `catalog_stock_return_frame` | jw. |
| `stock_verdict_effect_prepare(uuid,uuid,jsonb)` | `catalog_stock_control_effect_prepare` | jw. |
| `stock_verdict_effect_finish(uuid,uuid,uuid,jsonb)` | `catalog_stock_control_effect_finish` | jw. |
| `stock_verdict_return_prepare(uuid,uuid,jsonb)` | `catalog_stock_return_prepare` | `return_require`, `return_frame` (2×), `effect_prepare` → kopie |

Nazwa: żadna nie pasuje do skanów rodzin w zapieczętowanym SQL (`LIKE 'catalog_stock_control_%'`, `catalog_stock_return_%`,
`return_%`, `starts_with(…,'manual_inventory_off_')` itd.; wyciąg wszystkich wzorców `LIKE`/`starts_with`/`left(proname…)` z `prosrc`
funkcji `public`). SQL poza ciałami: tylko `CREATE FUNCTION public.stock_verdict_*` i `REVOKE ALL … FROM PUBLIC,dyna_app`;
nic nie jest zastępowane, zmieniane, usuwane ani nadawane.

TS (`to_regprocedure` z dokładną sygnaturą przy każdym wywołaniu; przed 270 zapieczętowana funkcja jak dotąd):
- `server/catalog-stock-control.ts` `prepareCatalogStockEffectInTx` → `stock_verdict_effect_prepare`,
  `finishCatalogStockEffectInTx` → `stock_verdict_effect_finish`;
- `server/catalog-stock-return-effects.ts` `prepareCatalogStockReturnInTx` → `stock_verdict_return_prepare`.

Oba pliki są w rosterze zapisu stanów: przypięte ponownie z notą `Source270` (`server/catalog-stock-writer-coverage.ts`),
test odwrócenia w `tests/catalog-stock-writer-coverage.test.ts` (odwrócenie edycji 270 daje dokładnie piny sprzed 270, które dalej
są odrzucane), linia credit208 (`tests/return-credit208-resources.test.mjs`) najpierw cofa oba piny i notę 270.

| plik | przed 270 | po 270 |
|---|---|---|
| `server/catalog-stock-control.ts` | `a37ebf48…0531d` 29 004 B | `e2e2c8411f8b87bdbe2659ae15fab3118fa43fac213a5cca11ccba776e40bf0a` 29 701 B |
| `server/catalog-stock-return-effects.ts` | `a56ab5b2…e99d5` 8 218 B | `9477925717a4a21dfbbb8c14a96e881e28068b48db6b960d7f1fb6fc4bd277d0` 8 630 B |

Przegląd re-pinu: w obu plikach zmienia się tylko nazwa wołanej funkcji (wybór z dwóch stałych literałów po sondzie
`to_regprocedure`), argumenty, `owner()`, mapowanie błędów, kolejność blokad i zapisy są te same; bez nowego zapisu stanu,
wywołania stock-writer ani obejścia bramki.

## Dlaczego kopia nie przyjmie stanu, który odrzuca zapieczętowany oryginał

1. **Ciała.** Kopia różni się od oryginału tylko zadeklarowanymi wywołaniami (test DB porównuje `prosrc` po podmianie i
   wszystkie pozostałe kolumny `pg_proc`: argumenty, wynik, język, `prosecdef`, zmienność, `proconfig`, właściciel, ACL…).
   Każda inna instrukcja, blokada, zapis, błąd i kolejność są identyczne.
2. **Strażnik.** `guard_verdict('catalog_stock_control_guards')` zwraca wartość pełnego strażnika albo jego błąd (248: pełny
   strażnik, gdy transakcja nie jest READ COMMITTED, generacja 182 nie jest zatwierdzona na zimno, maszyneria 182 nie jest nietknięta
   (239/240/241), sesja ma obiekt TEMP albo podstawa się zmieniła; zapis werdyktu tylko z RW, przy niezmienionej podstawie,
   SKIP LOCKED). `IF NOT x` daje ten sam wynik dla `true`/`false`/`NULL`, a błąd przechodzi tak samo. Ten sam werdykt TS woła już
   od 248 w tych samych transakcjach (`catalogStockControlAvailable`) bezpośrednio przed oryginałem.
3. **Kontekst wywołania.** Werdykt w ciele SECURITY DEFINER widzi te same wejścia podstawy co z TS: `session_user` i GUC `role`
   nie zmieniają się przy SECURITY DEFINER, `TimeZone` kopii (UTC) to ustawienie puli; inny `TimeZone` sesji = chybienie, nie
   błędna odpowiedź. Własne zapisy transakcji w 16 tabelach podstawy zmieniają `xmin` → chybienie i pełny strażnik (test 7).
   `pg_advisory_xact_lock_shared(982376)` werdyktu jest już trzymane przez bramkę ordinary184 transakcji (bez nowego czekania).
4. **Integralność samych kopii.** Kopie nie są w odciskach zapieczętowanych strażników (to jest właśnie nowa generacja). Chroni je
   to samo co funkcje 236/239/248: zimny katalog wydania (startowa inspekcja odmawia bazy z innym ciałem; para 270 = 6 dodań)
   i kontrola generacji ordinary184 w każdej zwykłej transakcji (DDL właściciela brudzi generację → `runtime-generation-changed-
   restart-required`, potem zimna inspekcja przy starcie).

Klasa zaakceptowana (bez zmian względem 236/239/241/248): superużytkownik w innej sesji z `event_triggers=off` albo w trybie
replica podmienia funkcję. Dla oryginału podmiana `effect_prepare` byłaby widoczna dla strażnika przy następnym pełnym przebiegu;
dla kopii nie — ale ten sam aktor może podmienić `catalog_stock_control_guards()` na `RETURN true`, co wyłącza również starą ścieżkę.

Odrzucone warianty: (a) zmiana zapieczętowanych ciał — łamie strażników; (b) wpięcie kopii w odciski (`catalog_stock_control_manifest`,
certyfikaty 169/177/204/209) — nowa generacja wszystkich odcisków w skali 204/209 (13–28 MB SQL), poza zakresem i bez zysku
bezpieczeństwa względem (4); (c) zmiana `search_path` kopii na `…,pg_temp` — odbiega od oryginału; zostawione identycznie
(werdykt i tak odpowiada pełnym strażnikiem, gdy sesja ma obiekt TEMP).

## Weryfikacja (PG04 127.0.0.1:57084, klony `dynaminds_p270_20261029_NN` = szablon `dynaminds_restore_36751abef3079f3f` + `migrate()` do 253)

Dowody: `local-builds/full-base-preview-20261017/stock-verdict270-source-20261029-01/` (guards, bench, wyniki testu DB, generator).

- `tests/stock-verdict270.test.mjs` (bez bazy): **0/5** na `07a0ae0` (bez SQL i zmian TS), **5/5** po.
- `tests/stock-verdict270.test.ts` (klon, SQL nakładany jako właściciel, generacja zatwierdzana `ordinary187_approve`):
  **0/8** na `_03` (bez pliku SQL), **8/8** na świeżym `_07`. Przypadki: rodzina sześciu funkcji tylko dla właściciela; kopia = oryginał
  z zadeklarowanymi podmianami (wszystkie kolumny `pg_proc`); strażnicy `true` z rodziną; RC RW: 8 par (require, return require,
  effect prepare bez/z ścisłym katalogiem, obcy operator 42501, finish 23514, frame i prepare zamkniętego RMA 23514) — ta sama
  wartość lub błąd, oryginał 1–2 pełne strażniki, kopia 0; RR: ten sam pełny strażnik; stan odrzucany przez strażnika (DDL
  właściciela; zmiana `catalog_stock_control_manifest` w trybie replica bez brudzenia generacji): wszystkie pary 55000, kopia bez
  odpowiedzi z pamięci; zmiana wiersza podstawy w transakcji = chybienie; TS przez `prepareCatalogStockEffectInTx` i
  `prepareCatalogStockReturnInTx` woła kopie, a po `DROP` kopii (wycofanym) — oryginały, z tym samym wynikiem.
- Strażnicy (`jit=off`, UTC, RO): dziesięciu + `warehouse_wz_issuer_guards` + `email_inbound_guards` + `catalog_stock_control_guards`,
  `financial_return_guards`, `catalog_stock_return_guards` `true` przed 270 (`guards-before-02.json`), po 270 (`guards-after-02.json`)
  i po pełnym teście DB na `_07` (`guards-after-07.json`, generacja zatwierdzona, `dirty=false`).
- Bez bazy w tym drzewie: zestaw run-bw (base-wire + pakowanie zasobów) 413/413; `stock-verdict270`, 248, roster stock-writer,
  credit208, split/210, 239, plan source-ddl i `release-migrations-*` 365/365; `npx tsc --noEmit -p .` czysto.

## Przegląd bezpieczeństwa (subagent security-reviewer, 29.10)

Pytanie: „czy kopia (albo ścieżka TS, która ją woła) może przyjąć stan lub dać zapis, którego zapieczętowany oryginał by nie
przyjął lub nie dał?”. Recenzent dostał tylko diff `bcd7196..93a371b` i klon `_07`. **Wynik: brak blokujących.** Sprawdził:
`prosrc` sześciu par po odwróceniu nazw i wszystkie atrybuty `pg_proc`; tabele czytane przez `catalog_stock_control_guards` i
`catalog_stock_return_guards` (`pg_stat_xact_all_tables`) ⊂ podstawy 248; manipulacje w trybie replica (`catalog_stock_control_manifest`,
`catalog_stock_return_manifest`: oba `*_require` 55000 z tym samym komunikatem), RR, podmianę zapieczętowanego `require` przy
`event_triggers=off`; 125 bezargumentowych strażników/predykatów z rodziną i bez niej: 0 różnic; z 29 funkcji odcisków/podstaw zmieniają
się tylko `buyer_available236_basis` i `wz_issuer239_basis` (wersje wierszy wszystkich funkcji `public`: jedno chybienie po dodaniu);
ACL `{postgres=X/postgres}`, brak EXECUTE dla `dyna_app`/PUBLIC; wybór funkcji w TS z dwóch literałów. Nieblokujące: (1) kopie poza
odciskami w czasie działania — podmiana kopii przy `event_triggers=off` nie zmienia żadnego strażnika (ta sama klasa co podmiana samego
strażnika; zostaje zimny katalog i generacja 182 — integrator ma potwierdzić, że para 270 ma sześć dodań); (2) dodatkowa sonda
`to_regprocedure`; (3) `catalog_stock_return_guards()` dalej pełny w każdym `return_require` (~5 ms bez obciążenia); (4) z 248:
`statement_timeout`/`lock_timeout` poza podstawą. Strażnicy na `_07` po przeglądzie `true` (`guards-after-review-07.json`).

## Pomiar na poziomie funkcji (klon `_02` z 270, bez obciążenia)

`node bench.cjs dynaminds_p270_20261029_02 10` (w katalogu dowodów): każda próbka to osobna transakcja jak `tenantTx`
(`BEGIN` READ COMMITTED RW, `track_functions=all`, `app.tenant_id`, jedno wywołanie jako właściciel, ROLLBACK), oryginał i kopia
na przemian; przed każdą parą zatwierdzone `guard_verdict()` (jak następny zatwierdzony zapis aplikacji). Mediana z 10:

| wywołanie | oryginał | kopia | pełne strażniki oryginał / kopia | wynik równy |
|---|---|---|---|---|
| `require` | 228 ms | 4,8 ms | 1 / 0 (1 chybienie z 10) | tak |
| `effect_prepare`, bez ścisłego katalogu (`NULL`) | 215 ms | 4,9 ms | 1 / 0 | tak |
| `effect_prepare`, ścisły katalog (przyjęcie) | 240 ms | 7,9 ms | 1 / 0 (1 chybienie z 10) | tak |
| `return_prepare`, zamknięte RMA (23514) | 474 ms | 13,8 ms | 2 / 0 | tak |

REPEATABLE READ (`… 5 rr`): oryginał i kopia po tyle samo (208–401 ms, ten sam pełny strażnik). Pojedyncze chybienia w RC to
wspólne katalogi klastra: inne bazy na PG04 zmieniają `pg_db_role_setting` (`basisdiff.cjs`: wiersz `(0,31)` zniknął w 4 min); w
produkcji jest jedna baza.

Szacunek pod obciążeniem (niezmierzony; bieg łączny robi koordynator): 2 213 wywołań `require` z `p260-before-01` przechodzi z
~337 ms na trafienie werdyktu (5–14 ms bez obciążenia), czyli ~730 s z 1 861 s czasu `catalog_stock_control_guards` (~2 rdzenie w
oknie 360 s); przyjęcie zwrotu traci 3 z 3 pełnych strażników katalogu (`financial_return_capture` zostaje).

## Czego nie zmieniono (pełny strażnik zostaje)

- `catalog_stock_return_finish`/`_abandon`/`_complete` i `financial_return_capture` (tor przyjęcia/rozliczenia zwrotu, inny agent);
  w mieszance obciążenia `finish` nie był wołany (token `NULL`).
- `catalog_stock_count_prepare`/`_require`, `manual_inventory_off_apply`, `catalog_stock_legacy_group_require`,
  `catalog_stock_control_commit`/`_preview` — wołają zapieczętowane `require`/`effect_prepare`; poza gorącą ścieżką.
- TS `SELECT public.catalog_stock_return_require()` w `b2b-credit-physical.ts`, `b2b-credit-source.ts`, `legacy-return-on-command.ts`
  (0 wywołań w biegu; pliki toru B2B).
- Chybienia werdyktu w REPEATABLE READ (decyzja Artura, wariant A) — bez zmian.

## Otwarte ryzyka

1. Integralność kopii opiera się na zimnym katalogu i generacji ordinary184, nie na odciskach w czasie działania (wyżej, pkt 4).
2. `stock_verdict_return_prepare` to kopia `catalog_stock_return_prepare`, który graniczy z torem przyjęcia zwrotu. Jeśli tamten tor
   da własną generację prepare, powinna wołać `stock_verdict_return_require/_return_frame/_effect_prepare`, a integrator zostawia jedną.
3. Sonda `to_regprocedure` to jedno dodatkowe zapytanie na wywołanie (~0,2 ms).
4. Zysk pod obciążeniem niezmierzony; chybienia z powodu wspólnych katalogów na współdzielonym PG04 mogą zaniżyć pomiar.

## Integracja jako 255 (29.10.2026)

Wzorzec 248 (funkcje właściciela, sonda `to_regprocedure` w TS) i 254 (kolejność commitów). Cztery commity przygotowania
(07a0ae0…4ef12c8 z `worktree-agent-ab7e3be976c99eb68`) przeniesione cherry-pickiem na `goal/full-base-20261017`
(3d7b775…c1e9c26) bez konfliktów; potem dwa commity integracji (f67d146 testy, e13578c migracja) i ten dokument.

- SQL: `server/270_stock_verdict.sql` → `server/255_stock_verdict.sql`; pierwsza linia komentarza „Migration
  255_stock_verdict (prepared as 270, registered after 254_carrier_returns)”, w nagłówku „before 270” → „before 255”;
  ciała funkcji bez zmian; 22 347 B, sha256 `90137a151d1524681eb57fdd8f088a2272727d00b23e359d33b7d1510c0e4902`.
- Wiersz manifestu `255_stock_verdict` (`native_id` `stock_verdict255`, kontrakt `stock-verdict255`) po 254;
  `server/db.ts` bez zmian (program z manifestu).
- Zimny katalog: kompilacja na `dynaminds_m255_20261029_01` (szablon + 218…254 + ledger; poprzednik = skompilowany
  after254 `ce974595…5574bcf6`): **6 dodań** (sześć funkcji `stock_verdict_require()`, `_return_require()`,
  `_return_frame`, `_effect_prepare`, `_effect_finish`, `_return_prepare`; SECURITY DEFINER, właściciel `postgres`, ACL
  `{postgres=X/postgres}` — potwierdzenie, o które prosi przegląd bezpieczeństwa), 0 zmian, 0 usunięć; after255
  `79ae0d32…98908a50` (46 988 rekordów); dwunastu strażników oraz `catalog_stock_control_guards` i
  `financial_return_guards` true przed i po. `stock-verdict255-source-contract.mjs`,
  `stock-verdict255-source-compatibility.mjs` (`projectCompiledStockVerdict255Catalogue`, łańcuch odwrotny od 254,
  footprint gołym prefiksem `stock_verdict_`, bez kluczy obcych), jedna linia w `release-cold-projectors.mjs`. Nic na
  after254 nie pasuje do footprintu i żaden footprint poprzedników nie obejmuje rekordu 255 (test). Kompilator
  (uogólniony na wiersze manifestu 218…N) i wyniki: `local-builds/full-base-preview-20261017/m255-source-20261029-01/`.
- Ledger 245 (guard: przyszłe `256_…`, `257_…`); MIG-2 z klonu na 243 stosuje 244…255; MIG-1 i MIG-4 oczekują serii
  244…255 (255 dodaje tylko funkcje, licznik tabel MIG-1 zostaje 10); 254 nie jest już ostatnia (255 po 254); rodzina
  klonów `m255` (data 20261029) w testach DB 236…254, installation-identity, settlement report, MIG-1/MIG-2/MIG-4 i
  worker-supervision. Testy DB MIG-1/2/4 biegną raz, po integracji 258 (dokument 258).
- Testy: `tests/stock-verdict255.test.mjs` (pierwszy test „prepared placeholder” zastąpiony przypięciem wiersza
  manifestu), `tests/stock-verdict255.test.ts` (prawdziwe `migrate()`, wiersz ledgera 255; ręczny krok SQL w `before()`
  usunięty), `tests/stock-verdict255-source-compatibility.test.mjs` (7, ostatni opt-in).
- Komentarze `// 270:` w `server/catalog-stock-control.ts` i `server/catalog-stock-return-effects.ts` oraz nota
  `Source270` w rosterze zostają jako etykiety, więc piny w `server/catalog-stock-writer-coverage.ts` są tymi z gałęzi
  przygotowania (`tests/catalog-stock-writer-coverage.test.ts`, `tests/return-credit208-resources.test.mjs` zielone);
  `server/app.ts` bez zmian, więc bez re-pinu scale-ports.
- `INTEGRATION-p270.md` usunięty (treść tutaj). Tor przyjęcia zwrotu (p272) wchodzi jako 256 na tej generacji: jego
  front door dotyczy tylko `financial_return_capture`, `catalog_stock_return_prepare` zostaje przy 255 (ryzyko 2 wyżej
  rozstrzygnięte: jedna generacja prepare).

| Sprawdzenie (PG04, klony `dynaminds_m255_20261029_NN`) | Wynik |
|---|---|
| `_02` świeży klon, prawdziwe `migrate()` | ledger 245, ostatnia `255_stock_verdict` |
| strażnicy na `_02` (jit=off, UTC; `guards-A-02.json`) | dziesięciu + `warehouse_wz_issuer_guards` + `email_inbound_guards` + `catalog_stock_control_guards` + `financial_return_guards` = true |
| inspekcja zimna na `_02` (`cold-A-02.json`) | COLD_INSPECTION_PASSED, `native_catalogue_sha256` = after255 `79ae0d32…`, wszystkie flagi `*_active` 216…255 true (`stock_verdict255_active`), tryb 209 `active209_inverse` |
| `tests/stock-verdict255.test.ts` (`_02`) | 8/8; strażnicy po teście true (`guards-after-02.json`) |
| `tests/guard-verdicts248.test.ts` (`_03`, świeży klon) | 18/18; strażnicy na `_03` true przed i po |
| bez bazy: zestaw jak przy 254 + `stock-verdict255`, `stock-verdict255-source-compatibility`, 254 statyczne/zimne, `guard-verdicts248.test.mjs`, `scoped-automation-lease-expiry`, `scale-docker-instance` | 558/565, 5 pominiętych opt-in, 2 czerwone znane sprzed integracji (`failure-job-kinds`: „mirakl262.ts: kind of INSERT INTO jobs not resolved ($3)”; `buyer-address-carrier-ui166`: „Runtime import ../server/shipment-status-labels”) |
| `tests/stock-verdict255-source-compatibility.test.mjs` z opt-in na prawdziwych katalogach 255 | 7/7 |
| `npx tsc --noEmit -p .` | czysto |
