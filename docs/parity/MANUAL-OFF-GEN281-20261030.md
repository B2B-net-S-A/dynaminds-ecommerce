# MANUAL-OFF-GEN281: korekta ręczna OFF (B/D) bez pełnego strażnika `manual_inventory_off_valid()` (30.10.2026)

Przygotowana jako migracja `server/281_manual_off_verdict.sql` (numer zastępczy 281; nazwy obiektów bez numeru, prefiks
`manual_off_verdict_`) ze zmianą `server/manual-inventory-off.ts` i zintegrowana 30.10.2026 jako **migracja 263**
(`263_manual_off_verdict`, sekcja „Integracja jako 263” na końcu). Opisy do sekcji integracji mówią o 281 jak w czasie
przygotowania.
Gałąź `worktree-agent-a256b2777475909a3`, podstawa `589bf64` (`goal/full-base-20261017`, ledger 252, ostatnia
`262_revoke_public_temporary`). Wzorzec: 248 (werdykt), 255 (kopie zapieczętowanych ciał z podmienionym strażnikiem), 256
(funkcja spoza rodzin wołana z TS zamiast zapieczętowanej). Dowody i skrypty:
`local-builds/full-base-preview-20261017/manual-off-verdict281-source-20261030-01/`.

## 1. Problem

`docs/scale/LOAD-DRIVER-PROFILE-COMPLIANCE-20261029.md` (biegi próbne `-41`/`-42`): `stock_operation` firm B i D (bez partii
WMS, korekta ręczna OFF PW/RW z migracji 169) ma w steady24 p95 3 430 / 3 400 ms (maks. 4 427 ms w `-41`) przy progu 4 000 ms;
A/C/E (WMS) 218–253 ms. Najczęstsze aktywne zapytanie: `SELECT manual_inventory_off_valid()`.

## 2. Profil (gdzie idzie czas)

Kopia pełnego zbioru `dynaminds_p281_full_20261030_01` (TEMPLATE `dynaminds_scale_20261029_03`, 0 połączeń, na
`dyna-scale-full-pg18`, `track_functions=all`), generacja 182 zatwierdzona. Prawdziwe trasy (`buildApp` + `inject`, sesja
właściciela firmy B, gorący SKU jak w sterowniku), każde zapytanie mierzone w kliencie `pg`, `pg_stat_user_functions` zerowane
przed każdym żądaniem (`prof-manual.mts`, `before-01.txt`). Bez obciążenia; na kontenerze była w tym czasie tylko jedna sesja
innego agenta (baza `dynaminds_scale_20261030_62`, 1 połączenie), bez biegu.

Jeden `manual_inventory_off_valid()` na pełnym zbiorze: 225–290 ms (bez obciążenia; ~260 ms w `-05`). Każde żądanie to
transakcja `tx()` z `server/manual-inventory-off.ts`: preflight `manualOffAvailable(pool)` (osobne połączenie), sprawdzenie na
początku transakcji, ciało, sprawdzenie po ciele („metadata changed”).

| żądanie (izolacja) | trasa ms (rundy 1–2) | pełne `manual_inventory_off_valid()` | skąd |
|---|---|---|---|
| `GET …/source` (RR READ ONLY + RC) | 910–952 | 4 | preflight, TS w RR, `frame(false)` → `require` (RR), TS po COMMIT (RC) |
| `POST …/previews` (RC RW) | 1 382–1 390 | 6 | preflight, TS ×2, `preview` → `require`, `preview` → `frame(true)` → `require`, `preview_can_apply` → `frame(false)` → `require` |
| `POST …/previews/:id/apply` (RC RW, mierzone) | 1 380–1 517 | 6 (w tym 1 przez `catalog_stock_control_guards`) | preflight, TS ×2, `apply` → `require`, `apply` → `frame(true)` → `require`, `catalog_stock_control_effect_prepare` → `catalog_stock_control_require` → `catalog_stock_control_guards()` → `manual_inventory_off_valid()` |

Razem **14 pełnych strażników manual OFF na jedną operację** sterownika (~3,2 s czasu bazy bez obciążenia, z czego mierzone
`apply` ~1,4 s). Reszta trasy (tożsamość, bramki WMS/zakupów/katalogu, zapisy) to ~20–40 ms; blokady nie grają roli.

Czy werdykt 248 to pokrywa? **Nie, omija go** tak samo jak `catalog_stock_control_require` przed 255:
`guard_verdict()` zna tylko `catalog_stock_control_guards`, `financial_return_guards`, `fa3_draft_guards`; TS woła
`manual_inventory_off_valid()` wprost, a zapieczętowane `manual_inventory_off_require()` (w `frame`, `preview`, `apply`) też.
Jedyne trafienie werdyktu na tej ścieżce to bramka `catalogStockControlAdmissionInTx` (5 ms). `apply` dodatkowo woła
zapieczętowany `catalog_stock_control_effect_prepare` zamiast kopii 255.

Odczyty p95 w steady24 (161 ms w `-42` wobec 112 ms w `-05`): szacunek, **niepotwierdzony pomiarem pod obciążeniem**. W
steady24 `-42` B+D mają 145 operacji w 180 s, czyli ~2 030 pełnych strażników × ~0,25 s CPU ≈ 510 s CPU / 180 s ≈ 2,8 rdzenia
przy średnim zajęciu kontenera bazy ~8 rdzeni i dominującym oczekiwaniu „CPU” w `pg_stat_activity`. W `-05` B/D nie wysyłały
`stock_operation` (`not_bindable`). Spójne z tym, że to manual OFF podnosi odczyty przez nasycenie CPU; potwierdzi to bieg
koordynatora (po 281 ~2 pełne strażniki na operację, ~0,4 rdzenia).

## 3. Projekt

Zapieczętowanych ciał 169 nie wolno zmieniać (ich `prosrc` przypinają certyfikaty i odciski; `manual_inventory_off_valid()`
sam sprawdza `manual_inventory_off_fingerprint()` dla `starts_with(proname,'manual_inventory_off_')`). 281 dodaje sześć funkcji
właściciela poza rodzinami:

| funkcja | co to jest |
|---|---|
| `manual_off_verdict_valid()` | strażnik: w READ COMMITTED, gdy `catalog_stock_control_guards()` ma przypięte ciało (sha256 `prosrc` `ef9c31fb…baf225`, język plpgsql) i `guard_verdict('catalog_stock_control_guards')` jest `true` → `true`; w każdym innym przypadku `RETURN public.manual_inventory_off_valid()` |
| `manual_off_verdict_require()` | `manual_inventory_off_require()`, `manual_inventory_off_valid()` → `manual_off_verdict_valid()` |
| `manual_off_verdict_frame(uuid,uuid,boolean)` | `manual_inventory_off_frame`, `require` → kopia |
| `manual_off_verdict_preview(uuid,uuid,jsonb)` | `manual_inventory_off_preview`, `require` i `frame` → kopie |
| `manual_off_verdict_preview_can_apply(uuid)` | `manual_inventory_off_preview_can_apply`, `frame` → kopia |
| `manual_off_verdict_apply(uuid,uuid,uuid,jsonb)` | `manual_inventory_off_apply`, `require` i `frame` → kopie, `catalog_stock_control_effect_prepare/_finish` → `stock_verdict_effect_prepare/_finish` (255) |

Ciała kopii wygenerowane z `pg_get_functiondef` na klonie PG04 przy 262 (`gen.cjs`; identyczne `md5(prosrc)` na pełnym zbiorze
przy 258); deklaracje te same (argumenty, wynik, plpgsql, SECURITY DEFINER, `search_path`, `TimeZone`, właściciel, EXECUTE tylko
właściciel). SQL poza ciałami: tylko `CREATE FUNCTION public.manual_off_verdict_*` i `REVOKE ALL … FROM PUBLIC,dyna_app`.

TS (`server/manual-inventory-off.ts`): jedna sonda `to_regprocedure` na transakcję (sześć funkcji 281 oraz `guard_verdict(text)`
i `stock_verdict_effect_prepare/_finish`, które kopie wołają); gdy cała rodzina jest, wywołania `valid`, `frame`, `preview`,
`preview_can_apply`, `apply` idą do kopii (wybór z dwóch literałów), inaczej do zapieczętowanych jak dotąd. Preflight
`manualOffAvailable` dostaje tę samą sondę w swoim istniejącym zapytaniu. Bez zmian: trasy, DTO, kolejność transakcji,
mapowanie błędów, `manual_inventory_off_validate`, walidator odtworzenia (RR, więc i tak pełny strażnik). Re-pin
`scripts/full-base-scale-http-ports.mjs` z notą `ManualOff281` (`a864e682…` → `d8172934…6c81d`, 14 648 B).

## 4. Dlaczego nowa generacja nie przyjmie stanu, który odrzucają zapieczętowane funkcje

1. **Strażnik.** Zapieczętowane `catalog_stock_control_guards()` (pin sha256 `prosrc` + plpgsql) ma trzy wyjścia `RETURN false`,
   ostatnią instrukcją jest `RETURN public.manual_inventory_off_valid()`, bez bloku EXCEPTION. Jego `true` jest więc `true`
   z `manual_inventory_off_valid()` w tym samym stanie. `guard_verdict('catalog_stock_control_guards') = true` oznacza (248):
   wartość pełnego strażnika przy tej samej zatwierdzonej generacji 182 i tej samej podstawie, a podstawa 248 obejmuje wszystkie
   tabele czytane przez `manual_inventory_off_valid()` (`manual_inventory_off_certificate`, `catalog_stock_control_manifest`,
   `migrations`, `buyer_address_manifest`, `order_merge_delivery209_*`; test 248 i recenzja: `pg_stat_xact_all_tables`), wersje
   wierszy wszystkich funkcji `public`, wspólne katalogi, TEMP i stan sesji. Zatem `manual_off_verdict_valid() = true` ⇒
   `manual_inventory_off_valid() = true`. Każda inna odpowiedź werdyktu (`false`, chybienie z `false`), REPEATABLE READ, inne ciało
   strażnika katalogu → pełny `manual_inventory_off_valid()`, czyli ta sama wartość. Błąd pełnego strażnika katalogu przy chybieniu
   przechodzi jako błąd (odmowa, nigdy `true`).
2. **Pin.** Bez pinu podmiana `catalog_stock_control_guards()` na `RETURN true` (DDL właściciela → generacja brudna → werdykt woła
   podmienione ciało) przepuściłaby zepsuty moduł manual OFF; test 6 to pokazuje (wariant bez pinu: czerwony).
3. **Kopie.** Różnią się od oryginałów tylko zadeklarowanymi wywołaniami (test porównuje `prosrc` po podmianie i wszystkie
   pozostałe kolumny `pg_proc`). `IF NOT x` daje to samo dla `true/false`; każda inna instrukcja, blokada, zapis, kolejność i błąd
   są identyczne. `stock_verdict_effect_prepare/_finish` mają ten sam argument 255.
4. **Kontekst.** Kopie są SECURITY DEFINER jak oryginały; werdykt w ich ciele widzi te same wejścia podstawy (`session_user`,
   GUC `role` nie zmieniają się). W RR strażnik zawsze pełny (jak 248, decyzja Artura, wariant A).
5. **Integralność samych kopii.** Nie są w odciskach zapieczętowanych strażników (to jest nowa generacja); chroni je zimny katalog
   wydania i kontrola generacji ordinary184, jak funkcje 236/239/248/255/256. Klasa zaakceptowana bez zmian: superużytkownik
   z `event_triggers=off`/replica podmienia funkcję — ten sam aktor może podmienić `manual_inventory_off_valid()`.

## 5. Przed / po

### Poziom funkcji (pełny zbiór, bez obciążenia)

| wywołanie | przed | po (trafienie werdyktu) |
|---|---|---|
| `manual_inventory_off_valid()` / `manual_off_verdict_valid()` (RC) | 250–400 ms | 5–6 ms |
| `preview` (zapieczętowany / kopia, TS) | 450 ms, 2 pełne | 18 ms, 0 |
| `preview_can_apply` | 234 ms, 1 pełny | 7–8 ms, 0 |
| `apply` | 695–763 ms, 3 pełne (w tym 1 przez `catalog_stock_control_guards`) | 37–40 ms, 0 |
| `frame(false)` w RR (źródło) | 231–240 ms, 1 pełny | 246–268 ms, 1 pełny (RR, bez zmian) |

Klon PG04 (szablon + `migrate()`), 32 pary zapieczętowany/kopia w RC RW: ta sama wartość lub błąd, oryginał 1–4 pełne strażniki,
kopia 0 (`green-db-06.txt`).

### Poziom trasy (pełny zbiór, firma B, ms, rundy 1–2 po rozgrzaniu)

| trasa | przed (`before-01`) | po (`after-02`) | po, firma D (`after-d-02`) | nowy TS bez 281 (`fallback-01`) |
|---|---|---|---|---|
| `GET source` | 910–952 | 496–548 | 491–552 | 968–1 000 |
| `POST previews` | 1 382–1 390 | 72–74 | 74 | 1 586–1 747 |
| `POST apply` (mierzone) | 1 380–1 517 | 87–91 | 87–120 | 1 537–1 788 |
| pełne strażniki na operację | 14 | 2 (oba w RR źródła) | 2 | 14 |

Pierwsza runda po starcie: apply 1 608 → 126 ms, preview 1 925 → 197 ms. Pomiar „po” na kopii `_02` z 281 nałożonym ręcznie i
zatwierdzoną generacją, przed kosmetyczną poprawką po recenzji (komentarz w ciele strażnika, 3 dodatkowe `to_regprocedure` w sondzie);
ciała kopii i logika bez zmian. Bieg obciążeniowy robi koordynator; szacunek: p95 B/D w steady24 z ~3,4 s do rzędu A/C/E.

## 6. Testy (czerwone → zielone)

- `tests/manual-off-verdict281.test.mjs` (bez bazy, 7): **0/7** na `e0d18cf` (bez SQL i TS), 5/7 z samym SQL, **7/7** po
  (`red-static.txt`).
- `tests/manual-off-verdict281.test.ts` (klon PG04 `dynaminds_p281_20261030_NN`, prawdziwe `migrate()` do 262, 281 nakładany
  ręcznie, `ordinary187_approve`): **0/10** na `_03` bez pliku SQL (`red-db-03.txt`); z SQL bez zmiany TS 8/10 (czerwony test TS:
  „copies 0, sealed 20”, plus błąd testu poprawiony w `6f46fbf`); **10/10** na świeżych `_06` i `_10` (bajty końcowe,
  `green-db-10.txt`). Przypadki: rodzina tylko dla właściciela; kopia = oryginał z podmianami; strażnicy `true`; trafienie RC/RC RO
  bez pełnego strażnika, RR i brudna generacja pełny; stan odrzucony (certyfikat w trybie replica, DDL tabeli manual OFF):
  strażnik `false`, wszystkie kopie 55000/`false` jak oryginały; pin strażnika katalogu; 32 pary RC; RR; zmiana wiersza podstawy
  = chybienie; trasy przez `buildApp` z rodziną wołają kopie, po `DROP` rodziny zapieczętowane, ta sama odpowiedź (RW, PW).
- Kontrola testów na osłabionych wariantach SQL: bez pinu 7/10 (czerwone 4, 6, 8), bez warunku READ COMMITTED 8/10 (4, 8).
- Bez bazy w tym drzewie: `release-migrations-*`, `source-ddl-migration-plan`, ledger guard, scale-load, scale http-ports,
  stock-writer coverage, 248/255 statyczne 495/495; `sql-text-lint` 221/221; base-wire + pakowanie zasobów 458/458; `tsc` czysto.

## 7. Strażnicy

15 strażników uzgodnienia (`RECONCILE_GUARDS`: dziesięciu + `warehouse_wz_issuer_guards`, `email_inbound_guards`,
`catalog_stock_control_guards`, `financial_return_guards`, `stocktake_adjustment_guards`) i `manual_inventory_off_valid` `true`
przed 281 (`_01`, `_09`), oraz z `manual_off_verdict_valid` (17) po 281 (`_09`) i po pełnym teście DB (`_06`, `_10`, generacja
zatwierdzona, `dirty=false`); `jit=off`, UTC, RC READ ONLY.

## 8. Przegląd bezpieczeństwa (subagent security-reviewer, 30.10)

Pytanie: „czy kopie albo ścieżka TS mogą przyjąć stan lub dać zapis, którego zapieczętowane funkcje by nie przyjęły?”.
**Wynik: brak blokujących.** Sprawdził argument pinu, tabele czytane przez `manual_inventory_off_valid()` ⊂ podstawy 248, `prosrc`
i atrybuty `pg_proc` sześciu par, ACL, macierz 22 zaburzeń × 2 kolejności w RC/RC RO/RR (DDL, GRANT, RLS, wyzwalacze,
`event_triggers=off`, replica, TEMP, TimeZone, `row_security`, `SET ROLE dyna_app`): 0 przypadków „kopia true, oryginał false”;
dwie sesje (płot 982376, zmiany `migrations`, certyfikatu, konfiguracji funkcji); 125/126 bezargumentowych strażników przed/po: ta
sama lista; wzorce nazw; lint SQL. Nieblokujące i co z nimi zrobiono:
1. błąd pełnego strażnika katalogu przy chybieniu przechodzi zamiast odpowiedzi samego `manual_inventory_off_valid()` (ostrzej,
   nigdy luźniej) — opisane w komentarzu strażnika (`cc68cd6`);
2. sonda TS nie sprawdzała `guard_verdict`/`stock_verdict_effect_*` — dodane (`cc68cd6`), brak = ścieżka zapieczętowana;
3. częściowa rodzina = cała ścieżka zapieczętowana (sprawdzone);
4. preflight z puli i start używają teraz werdyktu (248 zostawił pulę na pełnym strażniku) — ta sama podstawa i generacja; w
   transakcji i tak dwa sprawdzenia pod płotem;
5. druga (RC RW) część odczytu może zapisać wiersz werdyktu i czeka na wyłączne 982376 przy DDL — bezpieczne, możliwe krótkie
   wstrzymanie w czasie migracji;
6. pin wyłącza werdykt po prawowitej zmianie ciała strażnika katalogu (wolniej, nie luźniej; test to wykrywa);
7. przesłonięcie operatora w `public` przed `verdict241_ddl_intact()` — klasa zaakceptowana (DDL właściciela);
8. kontrakt zimnego katalogu i projektor dla 281 jeszcze nie istnieją — do integracji (`INTEGRATION-p281.md`).

## 9. Ryzyka i co zostaje

1. **Źródło (RR) dalej płaci 2 pełne strażniki** (TS w RR i `frame` → `require` w RR), ~0,5 s bez obciążenia; tak samo
   `previewDetail`, `history`, `receiptDetail`. Werdykt 248 celowo nie działa w RR; zmiana wymagałaby osobnej decyzji. Dla
   sterownika źródło jest niemierzone, ale obciąża CPU (~0,4 rdzenia w steady24 `-42`).
2. Integralność kopii opiera się na zimnym katalogu i generacji ordinary184 (jak 255).
3. Trafienie werdyktu zależy od podstawy 248: TEMP innych sesji, `pg_db_role_setting` innych baz (współdzielony PG04) dają
   chybienia — wtedy jeden pełny strażnik katalogu (~= `manual_inventory_off_valid()`).
4. Zysk pod obciążeniem niezmierzony (bieg koordynatora). Pomiar trasy był sekwencyjny, bez równoległego biegu.
5. Kopie pełnego zbioru `dynaminds_p281_full_20261030_01` (bez 281) i `_02` (z 281) zostały na `dyna-scale-full-pg18`
   (~7 GB każda) do wglądu; klony PG04 `dynaminds_p281_20261030_01…10` (`_21`, `_22` recenzenta mają zmieniony stan).

## Integracja jako 263 (30.10.2026)

Wzorzec 255 (kopie zapieczętowanych ciał, sonda `to_regprocedure` w TS) i 262 (kolejność commitów). Pięć commitów
przygotowania (e0d18cf, 6f46fbf, ee778f6, cc68cd6, f97588e z `worktree-agent-a256b2777475909a3`) weszło na
`goal/full-base-20261017` przez fast-forward (podstawa gałęzi = `589bf64` = HEAD), z tymi samymi hashami; potem dwa commity
integracji (36c2c0a testy, czerwone; 89c79c2 migracja) i ten dokument.

- SQL: `server/281_manual_off_verdict.sql` → `server/263_manual_off_verdict.sql`; pierwsze dwie linie komentarza „Migration
  263_manual_off_verdict (prepared as 281, registered after 262_revoke_public_temporary; no object name contains the
  number)”, w nagłówku „before 281” → „before 263”; ciała funkcji bez zmian (bez numeru w nazwach obiektów); 18 915 B,
  sha256 `5588862afd2e689b12934875b73fa4117f18f4a352405c120f0f7012b9dc11c9`.
- Wiersz manifestu `263_manual_off_verdict` (`native_id` `manual_off_verdict263`, kontrakt `manual-off-verdict263`) po 262;
  `server/db.ts` bez zmian (program z manifestu).
- Zimny katalog: kompilacja na `dynaminds_m263_20261030_01` (szablon + 218…262 + ledger; poprzednik = skompilowany after262
  `34f306f3…569e30d8`): **6 dodań** (sześć funkcji `manual_off_verdict_valid()`, `_require()`, `_frame(uuid,uuid,boolean)`,
  `_preview(uuid,uuid,jsonb)`, `_preview_can_apply(uuid)`, `_apply(uuid,uuid,uuid,jsonb)`; SECURITY DEFINER, właściciel
  `postgres`, ACL `{postgres=X/postgres}`), 0 zmian, 0 usunięć; after263 `df6a2a01…d11db6ad` (47 076 rekordów); 15
  strażników uzgodnienia i `manual_inventory_off_valid` true przed i po. `manual-off-verdict263-source-contract.mjs`,
  `manual-off-verdict263-source-compatibility.mjs` (`projectCompiledManualOffVerdict263Catalogue`, łańcuch odwrotny od 262,
  ślad po gołym prefiksie `manual_off_verdict_`, bez kluczy obcych; na after262 nic go nie ma). To zamyka punkt 8 przeglądu
  bezpieczeństwa (§8). Jedna linia w `release-cold-projectors.mjs`. Kompilator (uogólnienie z m262, przyjmuje m263 i datę
  20261030) i wyniki: `local-builds/full-base-preview-20261017/m263-source-20261030-01/`.
- TS i przypięcia: `server/manual-inventory-off.ts` bez zmian (etykiety „281” w komentarzach i `VERDICT281`/`v281` zostają jak
  „// 270:” przy 255), więc przypięcie w `scripts/full-base-scale-http-ports.mjs` (nota `ManualOff281`,
  `d8172934…b2d6c81d`) jest równe bajtom HEAD i się nie zmienia; `server/catalog-stock-writer-coverage.ts` i
  `server/app.ts` nietknięte.
- Testy: `tests/manual-off-verdict263.test.mjs` (wcześniej …281) — test placeholdera zastąpiony przypięciem manifestu;
  `tests/manual-off-verdict263.test.ts` — klon `dynaminds_m263_YYYYMMDD_NN`, prawdziwe `migrate()` stosuje 263, test sprawdza
  wiersz ledgera zamiast nakładać plik ręcznie (`install()` zostaje tylko do odtworzenia rodziny po `DROP` w teście TS);
  nowy `tests/manual-off-verdict263-source-compatibility.test.mjs`.
- Ledger 253 (guard: przyszłe `264_…`, `265_…`); MIG-2 stosuje 244…263; MIG-1 i MIG-4 oczekują serii 244…263 (263 dodaje
  tylko funkcje, licznik tabel MIG-1 zostaje 10); po 262 jest 263; rodzina `m263` (i data 20261030 tam, gdzie regex ją
  ustala) w testach DB 236…262, testach torów 259–262, installation-identity, settlement report, MIG-1/2/4 i
  worker-supervision.
- Pin `ef9c31fb…baf225` w `manual_off_verdict_valid()` to sha256 `prosrc` zapieczętowanego `catalog_stock_control_guards()`;
  gdy późniejsza migracja zapieczętuje nowe ciało, trzeba go przypiąć ponownie (pierwszy padnie test DB „each copy is…”);
  do tego czasu strażnik jest tylko wolniejszy (pełny), nigdy luźniejszy.
- `INTEGRATION-p281.md` usunięty (treść tutaj).

| Sprawdzenie (PG04, klony `dynaminds_m263_20261030_NN`; wyniki w `m263-source-20261030-01/`) | Wynik |
|---|---|
| bez bazy: `manual-off-verdict263.test.mjs`, zgodność 263 (z opt-in na prawdziwych katalogach), `full-base-scale-http-ports`, `sql-text-lint`, `release-migrations-*`, `source-ddl-migration-plan`, ledger guard, 262 statyczny i zgodność 262 | 671/671 (2 pominięte opt-in 262); zgodność 263 z katalogami 7/7 |
| ledger na `_02` (szablon + prawdziwe `migrate()`) | 253, ostatnia `263_manual_off_verdict` |
| strażnicy na `_02` (jit=off, UTC, RC READ ONLY; `guards-A-02.json`): 15 uzgodnienia + `manual_inventory_off_valid` + `manual_off_verdict_valid` | 17/17 true |
| inspekcja zimna na `_02` (`cold-A-02.json`) | COLD_INSPECTION_PASSED, sha = after263 `df6a2a01…`, flagi 216…263 true |
| `tests/manual-off-verdict263.test.ts` na `_02` po prawdziwym `migrate()` | 10/10 (rodzina tylko dla właściciela, kopie = oryginały z podmianami, strażnicy, trafienie/chybienie werdyktu, stan odrzucony, pin strażnika katalogu, pary RC, RR, podstawa, trasy TS przez `buildApp` z rodziną i po `DROP`) |
| strażnicy na `_02` po teście DB (`guards-after-02.json`) | 17/17 true, ledger 253 |
| MIG-2 (`_06`, 218…243 ręcznie, potem `migrate()` 244…263) / MIG-1 (`_07`) / MIG-4 (`_08`, zdjęcie szablonu w `DYNA_IMAGE_DIR`) | MIG-2 1/1 na `_06`, MIG-1 3/3 na `_07`, MIG-4 1/1 na `_08` (zdjęcie szablonu w `DYNA_IMAGE_DIR` jak w biegu 254/258) |
| `run-bw.sh` | 463/463 |
| `tools/build` / `tools/parity` | 25/25 / 133/133 |
| przypięcia, obciążenie, pokrycie (`catalog-stock-writer-coverage`, `full-base-scale-http-ports`, `rate-limit-config`, `scale-load`, `scale-load-profile`, `scale-docker-instance`, `scale-release-runtime`) | 131/131 |
| `sql-text-lint` / `npx tsc --noEmit -p .` | 221/221 / czysto |
