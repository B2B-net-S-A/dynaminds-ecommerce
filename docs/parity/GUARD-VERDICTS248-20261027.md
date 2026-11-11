# GUARD-VERDICTS248: werdykt dla trzech strażników ścieżki zapisu (27.10.2026)

Migracja `248_guard_verdicts` (`server/248_guard_verdicts.sql`), przygotowana w osobnym drzewie pod numerem zastępczym
256 (sekcje „Weryfikacja” i „Bieg obciążeniowy” opisują tamten etap i jego klony `p256`), zarejestrowana po
`247_sales_dimensions_repricing` (sekcja „Integracja jako 248”). Korzystają z niej `server/catalog-stock-control-transaction.ts`,
`server/financial-return-completion.ts` i `server/fa3-draft-access.ts`. Ten sam wzorzec co 239
(`docs/parity/WZ-ISSUER239-20261027.md`), od początku z bramkami 240 i 241
(`docs/parity/BUYER-ADDRESS240-20261027.md`, `docs/parity/VERDICT-GATES241-20261027.md`).

## Problem (B2 z `docs/scale/LOAD-TEST-DRYRUN-20261027.md`)

Pomiar na spakowanym wydaniu pod obciążeniem (`data/scale/load/p256-before-01`, baza `dynaminds_scale_20261027_72`,
`track_functions=all`, próbka `pg_stat_user_functions` co 15 s), steady12 (330 s, 29 860 zatwierdzeń):

| funkcja | wywołania | czas łącznie | ms/wywołanie |
|---|---|---|---|
| `catalog_stock_control_guards()` | 1 780 | 777 s | 437 |
| `financial_return_guards()` | 285 | 143 s | 500 |
| `fa3_draft_guards()` | 75 | 38 s | 502 |
| `local_invoice_guards()` | 601 | 43 s | 71 |
| `catalog_stock_return_prepare` (zapieczętowana, z pełnym strażnikiem w środku) | 95 | 125 s | 1 317 |
| `financial_return_capture` (zapieczętowana) | 95 | 95 s | 1 000 |
| `catalog_stock_control_effect_prepare` (zapieczętowana) | 178 | 78 s | 437 |

Trzej strażnicy wołani z TS to ~960 s czasu bazy na 330 s, czyli ~2,9 rdzenia przy ~700 żądaniach zapisu (średnio
~2,5 pełnego `catalog_stock_control_guards()` na żądanie zapisu: każde `catalogStockControlAvailable(c)` w
`prepareCatalogStockEffectInTx`, efektach zwrotu/pomiaru i rejestrze dokumentów to osobny pełny strażnik).

## Projekt

`guard_verdict(g text)` (SECURITY DEFINER, `search_path=pg_catalog,public,pg_temp`, tylko dla właściciela) dla
`g` z zamkniętej listy (`catalog_stock_control_guards`, `financial_return_guards`, `fa3_draft_guards`; inna nazwa → 22023,
bez dynamicznego SQL). Pełny strażnik odpowiada (ta sama wartość albo ten sam błąd), gdy:

1. transakcja nie jest READ COMMITTED;
2. generacja 182 nie jest zatwierdzona na zimno (także po ponownym odczycie pod współdzielonym `982376`);
3. któryś z trzech wyzwalaczy zdarzeń 182 nie jest włączony w trybie origin, bez tagów, z oczekiwaną funkcją, albo
   `event_triggers=off` w tej sesji (239/240);
4. `verdict241_ddl_intact()` nie zwraca `true` (241: treść maszynerii 182, tryb replica i `event_triggers` sesji,
   trwałe ustawienia ról/bazy, przesłonięcia w `public`);
5. sesja ma jakąkolwiek relację albo typ TEMP (239);
6. podstawa `guard_verdict_basis()` różni się od zapisanej.

Podstawa: wiersz generacji (wartości, `ctid`, `xmin`), `(ctid, xmin)` każdego wiersza 16 tabel czytanych przez
strażników, `pg_authid`, `pg_auth_members`, `pg_db_role_setting`, `pg_tablespace`, `pg_event_trigger`, wiersze
katalogów TEMP wszystkich sesji, `session_user`, `role` i 23 ustawienia sesji, wersje wierszy każdej funkcji w `public`
i `pg_class`/`pg_trigger`/`pg_rewrite` tabeli generacji (240/241). Zbiór 16 tabel to suma zbiorów czytanych przez
każdego strażnika (`pg_stat_xact_all_tables` podczas jednego wywołania na klonie 245); test DB przypina, że każdy
strażnik czyta tylko tabele z podstawy, a razem dokładnie je.

Zapis `true` tylko z transakcji RW, gdy podstawa nie zmieniła się w czasie pełnego strażnika, żaden wiersz maszynerii
182 nie jest nowszy od wiersza generacji (240) i `verdict241_ddl_intact()` nadal jest `true` (241), z `SKIP LOCKED`.
Wiersz werdyktu na strażnika (`guard_verdicts`, RLS z FORCE, bez uprawnień dla `dyna_app` i PUBLIC).

TS: każde z trzech miejsc pyta `to_regprocedure('public.guard_verdict(text)')` i, gdy jest, woła werdykt zamiast
strażnika; `catalogStockControlAvailabilityInTx` tylko na kliencie transakcji (`'release' in c`), Pool (start, poza
transakcją) zostaje przy pełnym strażniku, jak w 239. `fa3DraftModuleAvailable` (Pool) bez zmian.

`local_invoice_guards()` (~70 ms, 601 wywołań/330 s) zostaje przy pełnym strażniku: `server/local-invoices.ts` jest
przypięty sha256 w powiązaniach skali (`scripts/full-base-scale-http-ports.mjs`, test `nbp227-issue-hooks`), a zysk
(~0,13 rdzenia) nie uzasadnia przepinania sterownika.

### Dlaczego werdykt nie może przyjąć stanu, który pełny strażnik odrzuca

Pełny strażnik jest funkcją (a) katalogu, (b) zawartości tabel, które czyta, (c) wspólnych katalogów i (d) stanu sesji.
Zapisane `true` jest użyte tylko przy tej samej zatwierdzonej generacji i tej samej podstawie:

- (a) DDL właściciela brudzi generację, a współdzielony `982376` nie pozwala zatwierdzić DDL w trakcie transakcji.
  Generacja jest wersją schematu tylko, gdy maszyneria 182 działa — to sprawdza punkt 3 i 4 przy każdym wywołaniu,
  a wersje wierszy funkcji `public` i tabeli generacji są w podstawie (podmiana przy wyłączonych wyzwalaczach = chybienie).
  Strażnik zapisu 240 i ponowne 241 nie zapisują werdyktu nad zneutralizowaną maszynerią (kolejność xid ≠ kolejność
  zatwierdzeń: obie warstwy, jak w buyer 236).
- (b) każda nowa wersja wiersza ma nowe `xmin` (także w trybie replica i bez zmiany wartości), więc każdy
  INSERT/UPDATE/DELETE w 16 tabelach zmienia podstawę.
- (c) role, członkostwa, ustawienia ról i tablespace’y nie odpalają wyzwalaczy zdarzeń — są w podstawie.
- (d) sesja: tryb replica i `event_triggers` (punkt 4), ustawienia wpływające na wynik i `session_user`/`role`
  (podstawa), obiekty TEMP (punkt 5 i podstawa). REPEATABLE READ zawsze pełny strażnik.
- Strażnik nie zależy od firmy: `app.tenant_id` występuje w wykonywanych funkcjach tylko w literałach treści dawnych
  funkcji (skan `prosrc` 45 funkcji wykonanych przez czterech strażników); test DB pokazuje trafienie dla trzech firm.

Klasa zaakceptowana (bez zmian względem 236/239/241): superużytkownik w innej sesji z `event_triggers=off` albo
`session_replication_role=replica` robi DDL, który nie jest funkcją; ten sam aktor może podmienić strażnika.

## Weryfikacja

Klony PG04 `dynaminds_p256_20261027_NN` szablonu `dynaminds_restore_36751abef3079f3f`, `migrate()` do 245, potem 256
ręcznie (`…/scratchpad/p256/run.sh`), ustawienia puli aplikacji (`timezone=UTC`, `jit=off`).

- `tests/guard-verdicts248.test.mjs` (bez bazy): 0/5 bez pliku i zmian TS (`91c9aa9`), 5/5 po.
- `tests/guard-verdicts248.test.ts` (klon): 0/18 na klonie bez 256 (`_02`), 18/18 na świeżym `_07`.
- Kontrola testów na osłabionych wariantach SQL (`…/scratchpad/p256w/weak/`, wersja jeszcze z czterema strażnikami): bez `verdict241_ddl_intact()` 13/18
  (czerwone: obie pętle kolejności zatwierdzeń, sfałszowany wiersz generacji, przesłonięcie `convert_to`, trwałe
  ustawienia — wszędzie werdykt `true` z pamięci przy pełnym strażniku `false`); bez `migrations` w podstawie 16/18;
  bez kontroli TEMP 18/18 — kontrola TEMP sesji jest drugą warstwą (podstawa ma wiersze TEMP wszystkich sesji, a
  zapis wymaga niezmienionej podstawy; próba z kopią TEMP każdej tabeli podstawy i podmianą jej wierszy nie dała
  rozbieżności także bez niej).
- Koszt (trafienie, transakcja RC jak aplikacja, mediana z 7): ~10–11 ms wobec 480–530 ms pełnego strażnika.
- Dziesięciu strażników i `warehouse_wz_issuer_guards` `true` przed i po 256 (`_01`).
- Roster zapisu stanów: ponownie przypięte `catalog-stock-control-transaction.ts` i `financial-return-completion.ts`
  (odwrócenie do pinów Source245 w `tests/catalog-stock-writer-coverage.test.ts`, linia `return-credit208`).

Obciążenie przed/po (obie zmiany razem): `docs/parity/INSTALLATION-IDENTITY248-20261027.md`, sekcja „Bieg
obciążeniowy”: 6,11 → 13,58 RPS (12 klientów), 5,77 → 13,68 RPS (24 klientów). Werdykt trafia w 76–81 % wywołań;
chybienia wynikają głównie z tabel TEMP `parcel_physical_wz_context` (168) w równoległych transakcjach wysyłki.

## Integracja jako 248 (28.10.2026)

- Cherry-pick na `goal/full-base-20261017` (podstawa przygotowania `750aca2`): najpierw cztery commity sterownika
  obciążenia z `worktree-agent-ab9fd833fee389ca8` (`cd9bef2`, `5109f10`, `25684d7`, `a223b9b` → `92fafcb`, `74bd082`,
  `ac335df`, `89b43c2`), potem pięć commitów przygotowania (`91c9aa9`, `d2024f6`, `ca0a979`, `6ffcfba`, `363b6dd`).
  Gałęzi `p256-loadtest-tmp` (`7fff30f`, rejestracja tylko na bieg) nie scalano. Konflikty: roster stock-writer
  w `server/catalog-stock-writer-coverage.ts` (komentarz Source246 i Source256 oba zostają; piny dwóch plików
  przeliczone z bajtów), linia credit208 (komentarz Source256 zdejmowany pierwszy, potem Source246), test pokrycia
  (definicje odwrócenia 256 i nazwa testu `reviewed246`), `INTEGRATION.md` (usunięty tutaj; treść jest w tym pliku).
- Zmiana nazwy: `server/248_guard_verdicts.sql` (17 084 B, sha256 `5dd54b8a…08776b85`), nagłówek bez „placeholder”,
  komunikat `248 unknown guard`; nazwy obiektów bez numeru, więc SQL poza komentarzami i komunikatem bez zmian. Trzy
  miejsca TS mają komentarz `// 248:`. Testy `tests/guard-verdicts248.test.{mjs,ts}`,
  `tests/installation-identity248{,.database}.test.mjs`. Wiersz manifestu: `native_id` `guard_verdicts248`, kontrakt
  `guard-verdicts248`.
- Skompilowana para zimnego katalogu na klonie `dynaminds_m248_20261028_01` (szablon + 218…247 + ledger, poprzednik =
  skompilowany after247 `daec0d29…15156bcbf0`): **18 dodań, 0 zmian, 0 usunięć** (2 relacje, 5 kolumn,
  5 ograniczeń, 1 indeks, 2 typy, 3 funkcje), jak w przygotowaniu na 245. After248 = `a50f4eea…5ca016cd`
  (45 931 rekordów). Dwunastu strażników `true` przed i po. Kompilator (limit strażników 60 s, jak w 247) i wyniki:
  `local-builds/full-base-preview-20261017/guard-verdicts248-source-20261028-01/`.
- `guard-verdicts248-source-contract.mjs`, `guard-verdicts248-source-compatibility.mjs`
  (`projectCompiledGuardVerdicts248Catalogue`: usuwa dodania, pełnych poprzedników 247…217 czyta przez łańcuch
  odwrotności zaczynający się od 247), jedna linia w `release-cold-projectors.mjs`. Ślad rodziny to zwykły prefiks
  `(?:^|[.:"])_?guard_verdict` (bez `\b`; brak klucza obcego). Na after247 nic poza dodaniami do niego nie pasuje.
- Ledger: 238 migracji, przyszłe nazwy w teście `249_future_release`, `250_after_that`. MIG-2 od klonu na 243 oczekuje
  pięciu migracji `applied` (244–248). Test 247 sprawdza, że po nim idzie 248.
- Testy bazodanowe 248 działają na prawdziwym `migrate()` (rodzina `m248`, pierwszy test sprawdza wiersz ledgera);
  rodzina `m248` dopisana w testach 236/239/240/241/242/243/244/245/246/247 i w `tests/settlement-report.database.test.ts`.
- Piny przeliczone z końcowych bajtów: roster stock-writer `server/catalog-stock-control-transaction.ts`
  (15 908 B, `ccf8dbc0…54e7700ef`) i `server/financial-return-completion.ts` (12 341 B, `a61101fb…b3416dec`);
  testy odwrócenia (`tests/catalog-stock-writer-coverage.test.ts` „the 248 re-pins…”, linia credit208) wracają dokładnie
  do pinów sprzed 248 (`6b69b0f5…`/15 542 B, `45fca034…`/12 115 B). `server/fa3-draft-access.ts` i
  `profile-startup.mjs` nie są przypięte (ani w rosterze, ani w scale http-ports, ani w kontrakcie zasobów; jedyny
  dawny sha `profile-startup.mjs` jest w historycznym pochodzeniu `tests/order-split210-catalogue.test.mjs`, test zielony).
  `server/local-invoices.ts` bez zmian.

### Weryfikacja integracji (PG04 127.0.0.1:57084, klony `dynaminds_m248_20261028_NN`)

- `migrate()` 218→248 na świeżym klonie `_02`: ledger 238, ostatnia `248_guard_verdicts`; dziesięciu strażników,
  `warehouse_wz_issuer_guards` i `email_inbound_guards` `true` (jit=off, UTC); zimna inspekcja `COLD_INSPECTION_PASSED`,
  45 931 rekordów, `a50f4eea…`, `guard_verdicts248_active` i `sales_dimensions_repricing247_active` `true`.
- `tests/guard-verdicts248.test.ts` 18/18 (`_03`, trafienie 5,2–5,5 ms wobec 276–305 ms pierwszego pełnego
  strażnika), strażnicy po teście `true`; `tests/installation-identity248.database.test.mjs` 16/16 (`_04`, wycinek
  odczytu 0,69 ms wobec 86 ms).
- Testy werdyktów na rodzinie `m248`: 236 9/9 (`_05`), 239 13/13 (`_06`), 240 6/6 (`_07`), 241 15/15 (`_08`); MIG-2 1/1
  (`_09`, od 243).
- Bez bazy: `tests/release-migrations-*.test.mjs` + `tests/source-ddl-migration-plan.test.mjs` 275/275, ledger 4/4,
  statyczne 248 i kontrakt zimny (6/6 z prawdziwymi katalogami), stock-writer 15/15, credit208 5/5, scale http-ports,
  scale-load i pozostałe jednostkowe 105/105, web + komponenty 501/501, `run-bw.sh` 388/388, `npx tsc --noEmit -p .` czysto.

## Przegląd bezpieczeństwa (subagent security-reviewer, 28.10)

Pytanie: „czy cache może przyjąć stan, który pełne sprawdzenie odrzuca?”. Recenzent dostał tylko diff obu zmian i klon
`_08`. **Wynik: brak blokujących.** Sprawdził m.in. DDL (RLS, GRANT, polityka, indeks, tabela, REINDEX, DROP OWNED,
reguła, operator, rozszerzenie, obiekty TEMP), zmiany ról bez wyzwalaczy zdarzeń (BYPASSRLS, SUPERUSER, NOINHERIT,
członkostwo, RENAME), nowy i wyłączony wyzwalacz zdarzeń, fence `982376` przy niezatwierdzonym DDL innej sesji, własny
DDL wywołującego, RR, RO, wycofany zapis; dla tożsamości: ponowne zajęcie slotu `(0,1)` po `VACUUM (FREEZE)` (inny surowy
`xmin`), brak kolumn wirtualnych, TRUNCATE, zmiany kolumn. Nieblokujące:
1. Bezpośredni UPDATE katalogu (`pg_class.relrowsecurity`, `pg_index.indisvalid`) przez superużytkownika nie zmienia
   podstawy — ta sama klasa co zaakceptowana (model 182 ma tę samą lukę).
2. RR RO: DDL zatwierdzony po migawce mógłby być widoczny dla pełnego odczytu (`t.*` z relcache), a nie dla tożsamości.
   Niemożliwe poza klasą zaakceptowaną: inwalidator bierze wyłączne `982376`
   (`server/182_cold_schema_runtime_admission.sql:59`), dzierżawa odczytu trzyma współdzielone od przed `BEGIN`.
3. `statement_timeout`/`lock_timeout` nie są w podstawie: przy limicie < 0,5 s pełny strażnik kończy się błędem
   czasu, a trafienie zwraca `true` (to nie stan odrzucony przez strażnika; aplikacja ma 8 s).
4. Wydajność: GRANT/ALTER na tabeli pieczęci kieruje każdy wycinek do pełnego odczytu do restartu; TEMP innych sesji
   i `jit` w podstawie powodują chybienia werdyktu.

## Co zostaje na pełnym strażniku

- Zapieczętowane `catalog_stock_return_prepare`, `financial_return_capture`, `catalog_stock_control_effect_prepare`
  wołają strażników w środku (~300 s/330 s w steady12). Zmiana wymaga nowej wersji zapieczętowanych rodzin i ich
  odcisków — osobna praca.
- `local_invoice_guards()` (wyżej), Pool przy starcie.
