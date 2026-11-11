# VERDICT-GATES241: bramki obu werdyktów sprawdzają treść maszynerii 182 (27.10.2026)

Migracja `241_verdict_gates` (`server/241_verdict_gates.sql`). Poprawka bezpieczeństwa dwóch werdyktów z pamięcią
podręczną: `buyer_available236()` w wersji z 240 (`docs/parity/BUYER-ADDRESS240-20261027.md`) i
`wz_issuer239_verdict()` z 239 (`docs/parity/WZ-ISSUER239-20261027.md`). Commity: `17f51fa` (bramka) i `ac72015`
(poprawki po przeglądzie).

## Luka

Oba werdykty traktują generację 182 jako wersję schematu. To prawda tylko wtedy, gdy maszyneria 182 działa: trzy
wyzwalacze zdarzeń odpalają się, `ordinary182_invalidate()` robi swój UPDATE i nic go nie przechwytuje.

- 239 i 240 sprawdzały tylko wiersze `pg_event_trigger`. Pętla `ALTER EVENT TRIGGER … DISABLE` → podmiana →
  `ENABLE` przywraca te wiersze.
- Strażnik zapisu z 240 nie zapisywał werdyktu, gdy wiersz maszynerii 182 miał `xmin` nowszy niż wiersz generacji.
  To porządek xid, a nie porządek zatwierdzeń. Transakcja, która wzięła xid przed zatwierdzeniem na zimno, a
  zatwierdziła się po nim, wygląda na starszą od zatwierdzenia. Może to być sesja otwarta, bezczynna w transakcji
  albo transakcja przygotowana.

Reprodukcje z drugiego przeglądu 240 (oba werdykty). Sesja B bierze xid, A wywołuje `ordinary187_approve`, potem B
robi swoje i zatwierdza:

| wariant | skutek przed 241 |
|---|---|
| t4: DISABLE, pusta `ordinary182_invalidate()`, ENABLE | chybienie, pełny strażnik `true`, zapis; potem `ALTER TABLE buyer_address_state ADD COLUMN` daje `true`, a pełny strażnik 55000 |
| t5: reguła na `ordinary182_runtime_generation` kieruje UPDATE inwalidatora do tabeli-cienia | to samo |
| sfałszowany `UPDATE ordinary182_runtime_generation SET dirty=dirty` po podmianie (pierwszy przegląd 240, nieblokujące) | wiersz generacji jest najnowszy, więc strażnik xmin przepuszcza |
| wywołujący w `session_replication_role=replica` z własnym DDL | trafienie `true`, pełny strażnik 55000 |
| `ALTER ROLE … SET event_triggers=off` / `session_replication_role` | żadne zdarzenie nie odpala, nic się nie zmienia; WZ zapisuje werdykt mimo takiego ustawienia |

W 239 ta sama pętla z pustym inwalidatorem dawała `true` w 2 ms przy `false` pełnego strażnika (klon `_11` w 240).

## Projekt

`verdict241_ddl_intact()` to nowa funkcja SQL, `STABLE`, bez `SECURITY DEFINER`, tylko dla właściciela. Zwraca
`true` wtedy, gdy wszystkie poniższe warunki są spełnione:

1. **Ta sesja:** `event_triggers` nie jest `off`, a `session_replication_role='origin'`.
2. **Ustawienia trwałe:** w `pg_db_role_setting` (dla wszystkich baz albo dla tej) żaden `setconfig` nie wspomina
   `event_triggers` ani `session_replication_role`. Wielkość liter nie ma znaczenia.
3. **Wyzwalacze zdarzeń:** są dokładnie trzy, wszystkie z 182. Każdy ma `evtenabled='O'`, nie ma tagów, należy do
   `postgres` i ma oczekiwane zdarzenie i funkcję. Dodatkowy wyzwalacz (np. `login` albo `ddl_command_end`) mógłby
   działać wokół nich.
4. **Funkcje:** `ordinary182_invalidate`, `_temp_ddl_end`, `_temp_drop` i `_is_temp_object` są dokładnie takie, jak
   przypina je `ordinary182_valid()`. Predykaty 182 są wklejone dosłownie: sha256 `prosrc`, nagłówek, właściciel,
   `proconfig` i ACL. Podmienione ciało jest widoczne bez względu na `xmin`.
5. **Tabela generacji:** taka, jak przypina ją 182 (właściciel, RLS z FORCE, ACL, kolumny). Do tego żadnej reguły
   (`ordinary182_valid()` nie patrzy na `pg_rewrite`), polityki ani własnego wyzwalacza.
6. **Przesłanianie (przegląd 241):**
   - Żadna funkcja w `public` nie ma nazwy funkcji z `pg_catalog`.
   - W `public` nie ma operatora `=`, `<>`, `<`, `>`, `<=`, `>=`, `||`, `~`, `!~`, `~~`, `!~~`, `+` ani `-`.
   - Przy `search_path=pg_catalog,public` przeciążenie z `public` o dokładnych typach wygrywa z kandydatem z
     `pg_catalog`, który wymaga rzutowania. Tak `public.convert_to(text,text)` wygrywa z
     `pg_catalog.convert_to(text,name)`, co oślepiało przypięcia sha256 i podstawy.
   - Oba sprawdzenia używają wyłącznie `OPERATOR(pg_catalog.=)`.
   - Operatory `pg_trgm` w `public` (`%`, `<->`, …) nie są na liście.

Oba werdykty wywołują tę funkcję w dwóch miejscach:

- po sprawdzeniu wyzwalaczy zdarzeń z 239/240 i przed kontrolą TEMP: `false` albo `NULL` oznacza, że odpowiada pełny
  strażnik i nic nie jest zapisywane;
- jeszcze raz tuż przed zapisem, po przebiegu pełnego strażnika.

Strażnik `xmin` z 240 zostaje w `buyer_available236()` jako dodatkowa warstwa.

`wz_issuer239_basis()` (przegląd 241): tekst 239 plus `public_functions` i `generation_relation`, czyli te same
linie co w 240. Bez nich inwalidator podmieniony i przywrócony przy `SET LOCAL event_triggers=off`, z DDL właściciela
pomiędzy, dawał w WZ trafienie `true`. Wszystkie sprawdzenia treści po przywróceniu znów przechodzą, a ślad zostaje
tylko w wersjach wierszy.

Bez zmian zostają:

- fence `982376`;
- kontrola TEMP;
- zasady zapisu (RW, READ COMMITTED, `SKIP LOCKED`);
- `SECURITY DEFINER` i `search_path` werdyktów, `TimeZone` w 236;
- ACL: `buyer_available236()` dla `dyna_app`, funkcje WZ tylko dla właściciela.

Nazwa `verdict241_` nie pasuje do żadnego zapieczętowanego odcisku: `warehouse_wz_issuer_%` (`_` to dowolny znak),
`warehouse_automatic_wz_%`, `buyer_address_%`, `parcel_physical_wz_`, `ordinary18x_`. Żaden obiekt tych rodzin nie
jest tworzony ani zmieniany.

Kontrakt zimnego katalogu: 1 dodatek (`verdict241_ddl_intact()`) i 3 zmiany (`buyer_available236()`,
`wz_issuer239_verdict()`, `wz_issuer239_basis()`). W każdej zmianie różnią się tylko `definition` i `source`.
Projektor 241 jest aktywny, gdy w katalogu jest dodatek albo któreś z trzech nowych ciał. Każde inne ciało ocenia
odwrotność 240 i 239, więc starsza instalacja (239) zostaje tożsamością, a podmieniona jest odrzucana.

## Czego werdykty nadal nie widzą

- **Klasa zaakceptowana, bez zmian:** superużytkownik w innej sesji z `event_triggers=off` albo
  `session_replication_role=replica` robi DDL, który nie jest funkcją. Generacja zostaje czysta. Ten sam aktor może
  też podmienić strażników.
- **Ustawienie trwałe wykrywane tylko w czasie istnienia.** Sekwencja `ALTER DATABASE … SET event_triggers=off`, DDL
  z nowej sesji, `RESET` nie zostawia śladu: wiersz `pg_db_role_setting` znika. To ta sama klasa co wyżej
  (potwierdził przegląd 241: wynik identyczny z `SET event_triggers=off` w innej sesji).
- **Reguła na tabeli generacji utworzona i usunięta przy `event_triggers=off`.** Widać ją tylko po zmianie wiersza
  `pg_class` (`relhasrules`). Pierwsze takie okno jest widoczne. Dwa okna po sobie (pierwsze bez DDL, werdykt
  zapisany, drugie z DDL) dają w WZ nieaktualne `true`; buyer odmawia dzięki strażnikowi `xmin` z 240 (ponowny
  przegląd, `rv/rule2.cjs`). Ta sama klasa zaakceptowana.
- Same funkcje werdyktów i `verdict241_ddl_intact()` nie są przypięte w zapieczętowanych strażnikach: właściciel,
  który je podmieni w ukrytym oknie, ma nieaktualne `true` (jak dla każdej warstwy podręcznej; odmawia dopiero zimna
  inspekcja przy starcie).
- Sfałszowany wiersz generacji jest w modelu 182 zatwierdzeniem. Po 241 nie przepuszcza już zneutralizowanej
  maszynerii (testy niżej).
- Fałszywe odmowy kosztują tylko czas. Baza z dodatkowym wyzwalaczem zdarzeń (np. pgaudit), z takim ustawieniem roli
  albo z funkcją w `public` o nazwie z `pg_catalog` nigdy nie trafia w pamięć i zawsze dostaje pełnego strażnika.
  Przyszła migracja, która zmieni funkcję `ordinary182_*`, musi zaktualizować kopie przypięć w bramce, inaczej
  pamięć podręczna wyłączy się po cichu.
- Bez związku z 241 (to samo w 239/240): typ TEMP o nazwie `jsonb`, `text`, `name` itp. sprawia, że werdykt rzuca
  błąd zamiast `true`.

## Przegląd bezpieczeństwa (subagent security-reviewer, 27.10)

Pytanie: „czy któryś werdykt może zwrócić `true` z pamięci w stanie, który pełny strażnik odrzuca?”. Recenzent
dostał diff, skrypty t4/t5 i klony `dynaminds_m241_20261027_20…29` (wszystkie usunięte).

Pierwszy przegląd (`17f51fa`): **brak blokujących, można scalić.**

- Kontrola uprzęży: na kopii cofniętej do tekstu 240/239 t4 i t5 dają nieaktualne `true` w obu werdyktach. Na 241
  nie dają.
- Bez nieaktualnego `true` zakończyły się: t4, t5, wyzwalacze `BEFORE UPDATE` (`RETURN OLD`, nadpisanie `NEW`),
  odroczony wyzwalacz ograniczenia, polityka, `ALTER FUNCTION` (SECURITY INVOKER, `SET`, `OWNER`),
  `ENABLE ALWAYS`/`REPLICA`, dodatkowe wyzwalacze `login`/`ddl_command_end`/`table_rewrite`, fałszywe zatwierdzenia,
  bezpośredni UPDATE `pg_event_trigger`, sesja wywołująca z `event_triggers=off` i w trybie replica, REPEATABLE READ,
  ustawienia trwałe obecne w chwili wywołania, 90 s fuzzingu wyścigów (zero naruszeń).
- `max_prepared_transactions=0`, więc transakcji przygotowanych nie dało się sprawdzić. Sesja bezczynna w
  transakcji daje ten sam układ.
- Nieblokujące 1 (WZ bez wersji wierszy 240), poprawione w `ac72015`.
- Nieblokujące 2 (ustawienie trwałe tylko w czasie istnienia): poprawiony opis.
- Nieblokujące 3 (przesłonięcie `convert_to`), poprawione w `ac72015`: punkt 6 projektu.

Ponowny przegląd poprawek (`ac72015`): **brak blokujących, można scalić.**

- `swap_off`, `rule_off` (jedno okno) i bezpośredni UPDATE `pg_proc.prosrc`: oba werdykty bez nieaktualnego `true`.
  Przed poprawką WZ dawał nieaktualne `true`.
- t4, t5 i warianty z przesunięciem: miss nie jest zapisywany, a każde wywołanie przechodzi przez pełnego strażnika.
- Przesłonięcie `convert_to` sprawdzone w świeżej sesji. Bramka z `ac72015` je odrzuca. Bramka z `17f51fa` (bez nowego
  warunku) daje nieaktualne `true` w obu werdyktach.
- Operatory faktycznie wiązane w bramce, podstawach i werdyktach recenzent wyliczył przez `debug_print_parse`.
  Wszystkie są na liście, a funkcje i operatory rozwiązują się do `pg_catalog`.
- Na przesłonięcie funkcji z `public` (`convert_to`, `encode`, `lower`, `current_setting`, `to_regprocedure`,
  `sha256`, `jsonb_agg`, `age` i inne) bramka odpowiada `false`. Na `public.unnest(varchar[])` rzuca błąd 42725, czyli
  też odmawia. Typy i tabele o nazwach z katalogu nie mają wpływu, bo `pg_catalog` jest pierwszy.
- Własne rzutowania `xid`/`tid`→`text` nie oślepiają przypięcia sha256.
- Funkcje w `pg_temp` nie są szukane.
- Nieblokujące, opisane w limitach wyżej: reguła w dwóch oknach (WZ), niepinowana warstwa podręczna, wyłączenie
  pamięci przy kolizji nazw (np. `citext`).

## Weryfikacja

Klony PG04 szablonu `dynaminds_restore_36751abef3079f3f`, ustawienia puli aplikacji (`timezone=UTC`, `jit=off`).

Czerwono→zielono:

- `tests/verdict-gates241.test.ts`, dwie sesje właściciela dla przesunięcia kolejności zatwierdzeń:
  - świeży klon HEAD 240 (`_04`): 10/11 czerwonych, każdy przypadek t4, t5, ukrycia, replica i ustawienia roli daje
    `true` z pamięci po późniejszym DDL;
  - 11/11 na `_07`;
  - po przeglądzie 12/15 na SQL z `17f51fa` (`_13`), czerwone: przesłonięcie w obu werdyktach i podmiana przy
    `event_triggers=off` w WZ;
  - 15/15 na świeżym `_15`.
- `tests/verdict-gates241.test.mjs` (bez bazy): 0/5 bez pliku, 6/6 po.
- `tests/verdict-gates241-source-compatibility.test.mjs`: 6/6, w tym opt-in dokładnej odwrotności na prawdziwych
  katalogach (`DYNA_VERDICT_GATES241_COMPILED_CATALOGUES`).

Kontrakt skompilowany na `_14`:

- poprzednik to skompilowany after240 `ead72d1b…`;
- jedenastu strażników `true` przed i po;
- wiersz manifestu: 30 946 B, `d74aac13…`.

Świeży klon 218→241 (`_16`):

- ledger 231 (`241_verdict_gates`);
- dziesięciu strażników i `warehouse_wz_issuer_guards` `true`;
- zimna inspekcja `COLD_INSPECTION_PASSED` (44 560 rekordów, `c86ae065…` = skompilowany after241,
  `verdict_gates241_active`).

Koszt (trafienie w transakcji RC jak aplikacja, mediana z 41; HEAD `_04` / 241 `_15`):

| | HEAD | 241 |
|---|---|---|
| `buyer_available236()` | 2,2 ms | 2,9 ms |
| `wz_issuer239_verdict()` | 1,6 ms | 3,5 ms |
| `verdict241_ddl_intact()` (serwer) | — | 0,8 ms |
| `wz_issuer239_basis()` (serwer) | 1,6 ms | 2,7 ms |

Pozostałe sprawdzenia:

- testy DB 236 9/9, 239 13/13 i 240 6/6 na świeżych klonach 241 (testy przyjmują teraz też nazwy `m241`);
- testy zależne od manifestu 637/637 (23 pominięte);
- run-bw 353/353;
- `npx tsc --noEmit -p .` czysto.
