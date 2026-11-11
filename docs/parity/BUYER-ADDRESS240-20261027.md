# BUYER-ADDRESS240: werdykt 236 bez ponownego zapisu przy wyłączonym wyzwalaczu zdarzeń (27.10.2026)

Migracja `240_buyer_available_events` (`server/240_buyer_available_events.sql`). Jest poprawką bezpieczeństwa
werdyktu `buyer_available236()` z migracji 236 (`docs/parity/BUYER-ADDRESS236-20261027.md`). Lukę znaleziono przez
analogię z blokującym ustaleniem przeglądu 239 (`docs/parity/WZ-ISSUER239-20261027.md`, poprawka `1bbacef`).

## Luka

Werdykt 236 zakłada, że generacja 182 jest wersją schematu, czyli że każdy DDL właściciela ją brudzi. To prawda
tylko wtedy, gdy trzy wyzwalacze zdarzeń 182 się odpalają. Podstawa 236 zawierała wartości kolumn
`pg_event_trigger`, ale nie wersje wierszy, i nie zawiera `pg_proc`.

1. **Wyzwalacz zostaje wyłączony.** Zatwierdzone `ALTER EVENT TRIGGER ordinary182_schema_ddl DISABLE` zmienia
   podstawę. Chybienie uruchamia `buyer_address_guards()`, które nie patrzy na wyzwalacze zdarzeń. Strażnik zwraca
   `true`, a werdykt zapisuje się z podstawą „wyzwalacz wyłączony”. Potem `CREATE OR REPLACE` funkcji
   `buyer_address_hash` nie brudzi generacji i nie zmienia podstawy. `buyer_available236()` daje `true` w 1–2 ms,
   a `buyer_address_available()` rzuca 55000.
2. **Wyzwalacz wraca (przegląd 240).** DISABLE, DDL i ENABLE przywracają wszystkie wartości z podstawy, więc
   stary werdykt trafia. Działa to też z `ENABLE REPLICA` i z `SET LOCAL event_triggers=off`, oraz z pustą
   funkcją `ordinary182_invalidate()` podstawioną przy wyłączonym wyzwalaczu. Ta zachowuje OID, więc każdy
   późniejszy DDL jest niewidoczny.

Reprodukcja przed poprawką. Każdy wariant w transakcji wycofanej, z wywołaniem jako `dyna_app`, skrypty
`scratchpad/m240/repro.cjs` i `rt.cjs`:

| wariant | HEAD 239 (klon `_01`) | pierwsza wersja 240, `90bc71d` (`_06`) |
|---|---|---|
| DISABLE, potem podmiana funkcji | obejście | 55000 |
| ENABLE REPLICA, potem podmiana | obejście | 55000 |
| wyzwalacz odtworzony na pustej funkcji | obejście | 55000 |
| odtworzony z `WHEN TAG` | obejście | 55000 |
| usunięty | obejście | 55000 |
| `SET LOCAL event_triggers=off` | obejście | 55000 |
| ENABLE ALWAYS, zmiana nazwy, `ddl_command_end`, wyłączony `temp_ddl_end` | 55000 (generacja brudna) | 55000 |
| DISABLE → podmiana funkcji / tabeli → ENABLE | obejście | obejście |
| ENABLE REPLICA → podmiana → ENABLE | obejście | obejście |
| `event_triggers=off` → podmiana funkcji / tabeli → `on` | obejście | obejście |
| DISABLE → pusta `ordinary182_invalidate()` → ENABLE → DDL | obejście | obejście |

## Projekt

Plik 236 zostaje bajt w bajt, bo skompilowane kontrakty 237–239 wychodzą od niego. 240 zastępuje
(`CREATE OR REPLACE`) dwie własne funkcje. Żadna nie jest obiektem `buyer_address_*`, więc odcisk kupującego
i przypięcia strażników się nie zmieniają. Dziesięciu strażników zwraca `true` przed 240 i po nim.

`buyer_available236()`: tekst 236 i dwie wstawki.

1. **Po ponownym sprawdzeniu generacji, przed kontrolą TEMP** (jak w 239): muszą istnieć wszystkie trzy
   wyzwalacze 182. Każdy ma `evtenabled='O'`, nie ma tagów i ma oczekiwane zdarzenie i funkcję
   (`ordinary182_schema_ddl`/`ddl_command_start`/`ordinary182_invalidate()`,
   `ordinary182_temp_ddl_end`/`ddl_command_end`, `ordinary182_temp_drop`/`sql_drop`). `event_triggers` w tej
   sesji nie może być `off`. Inaczej odpowiada `buyer_address_available()` i nic nie jest zapisywane.
2. **Na ścieżce chybienia, przed zapisem:** nic nie jest zapisywane, gdy którykolwiek z tych wierszy jest nowszy
   niż wiersz generacji (zatwierdzenie na zimno; DDL pomiędzy zostawiłby generację brudną):
   - wiersz `pg_event_trigger`;
   - funkcja `public.ordinary182_*`;
   - wiersz `pg_class`, wyzwalacz albo reguła tabeli `ordinary182_runtime_generation`.

   „Nowszy” znaczy `age(xmin)` w przedziale `[0, age(xmin wiersza generacji))`. `VACUUM FREEZE` zostawia
   surowe `xmin` (sprawdzone na klonie), więc zamrożenie niczego nie przestawia. Gdy wiersz generacji ma ponad
   10⁹ transakcji (`age` zawija się przy 2³¹), też nic nie jest zapisywane, co jest bezpieczne. Wiersz generacji
   przepisuje każde zatwierdzenie przy starcie.

`buyer_available236_basis()`: tekst 236 i wersje wierszy:

- `pg_event_trigger` (`ctid`, `xmin`);
- każdej funkcji w `public` (`oid`, `xmin`; 1 679 funkcji);
- `pg_class`, `pg_trigger` i `pg_rewrite` tabeli generacji.

Pętla zmiany wyzwalacza zdarzeń (DISABLE i ENABLE) i podmiana funkcji przy wyłączonych wyzwalaczach dają więc
chybienie. Pełny strażnik wtedy łapie podmianę, a punkt 2 nie zapisuje stanu, który tylko wygląda na zdrowy. Pętla
bez żadnej podmiany kosztuje pełnego strażnika przy każdym wywołaniu aż do następnego zatwierdzenia (restartu).
Taki koszt ponosi tylko nietypowa czynność administratora.

Bez zmian zostają:

- fence `982376` i ponowne sprawdzenie generacji;
- kontrola przesłonięć TEMP;
- zasady zapisu (RW, READ COMMITTED, podstawa niezmieniona, `SKIP LOCKED`);
- `SECURITY DEFINER`, `search_path=pg_catalog,public,pg_temp`, `TimeZone=UTC`;
- `EXECUTE` tylko dla `dyna_app` (funkcja bazowa tylko dla właściciela).

Kontrakt zimnego katalogu potwierdza, że w obu rekordach zmieniły się tylko `definition` i `source`.

## Czego werdykt nadal nie widzi

- **Superużytkownik tłumi wyzwalacze zdarzeń we własnej sesji** (`session_replication_role=replica` albo
  `event_triggers=off`) **i robi DDL, który nie jest funkcją** (tabela, kolumna, ograniczenie, wyzwalacz,
  polityka). Taka zmiana nie zostawia śladu w generacji ani w podstawie. Na klonie `_11`
  `ALTER TABLE buyer_address_state ADD COLUMN` przy `event_triggers=off` nadal trafia w werdykt. To ta sama klasa
  co opisany w 236 i 239 DDL w trybie replica (luka modelu 182). 240 zawęża ją: podmiana funkcji, zmiana
  wyzwalaczy zdarzeń i reguła albo wyzwalacz na tabeli generacji są teraz widoczne. Reguła `DO INSTEAD NOTHING`
  na tabeli generacji sprawia, że następny DDL sam rzuca 55000 (`182 generation missing during DDL`).
- Sfałszowany wiersz generacji, czyli bezpośredni UPDATE `ordinary182_runtime_generation` przez superużytkownika,
  działa jak zatwierdzenie. Model 182 tego nie wykrywa. Do 241 taki UPDATE po podmianie inwalidatora przepuszczał
  też strażnik zapisu (wiersz generacji był najnowszy); 241 sprawdza treść, więc już nie.
- **Poprawione w 241** (`docs/parity/VERDICT-GATES241-20261027.md`): strażnik zapisu (punkt 2 projektu) porównuje
  kolejność xid, a nie zatwierdzeń (drugi przegląd niżej). Został jako dodatkowa warstwa; o zapisie i trafieniu
  decyduje teraz `verdict241_ddl_intact()`.
- Wywołujący w REPEATABLE READ: bez zmian względem 236.

## Przegląd bezpieczeństwa (subagent security-reviewer, 27.10)

Pytanie: „czy `buyer_available236()` może przyjąć stan, który pełny strażnik odrzuca?”. Przegląd dostał tylko diff
i świeży klon.

- **Pierwszy przegląd (`90bc71d`, klon `_07`), blokujące:** pętla DISABLE → DDL → ENABLE (także REPLICA i
  `event_triggers=off`) przywracała podstawę. Pusta `ordinary182_invalidate()` przy wyłączonym wyzwalaczu
  ukrywała każdy późniejszy DDL. Wszystkie warianty z przeglądu 239 przechodziły. Potwierdzone u mnie na `_06`:
  6 z 7 pętli to obejście. Poprawione w `336bea5` (punkt 2 projektu i wersje wierszy w podstawie).
- **Ponowny przegląd (`336bea5`, klon `_13`), blokujące:** strażnik zapisu porównuje kolejność xid, nie
  zatwierdzeń. Sesja B bierze xid i zostaje otwarta, A zatwierdza generację (`ordinary187_approve`), B robi
  DISABLE → pusta `ordinary182_invalidate()` → ENABLE i zatwierdza (t4). Chybienie zapisuje `true`, potem
  `ALTER TABLE buyer_address_state ADD COLUMN` daje `true`, a `buyer_address_available()` 55000. To samo z regułą
  na tabeli generacji (t5) i z sesją bezczynną w transakcji. Nieblokujące z pierwszego ponownego czytania:
  sfałszowany UPDATE wiersza generacji przepuszczał zneutralizowany inwalidator. Poprawione w 241
  (`docs/parity/VERDICT-GATES241-20261027.md`, commity `17f51fa`, `ac72015`).

## Weryfikacja

Klony PG04 szablonu `dynaminds_restore_36751abef3079f3f`, ustawienia puli aplikacji (`timezone=UTC`, `jit=off`).

| | przed (239) | 240 |
|---|---|---|
| trafienie `buyer_available236()` jako `dyna_app`, RC RW, mediana z 10 | 1,28 ms (`_02`) | 2,21 ms (`_10`; 1,25 ms w `90bc71d` bez wersji wierszy) |
| pierwsze wywołanie po zatwierdzeniu (pełny strażnik i zapis) | 443 ms | 397 ms |

Dodatkowe ~1 ms to agregacja 1 679 wersji funkcji. Pełny strażnik kosztuje ~400–450 ms.

Czerwono→zielono:

- `tests/buyer-available240.test.mjs` (bez bazy): 0/3 bez 240, 4/4 po.
- `tests/buyer-available240.test.ts` (klon): 1/5 na świeżym klonie HEAD 239 (`_02`). Na klonie z pierwszą
  wersją 240 (`_06`) 4/6, czerwone są przypadek pętli i krok ponownego zatwierdzenia. 6/6 na świeżym `_10`.
- `tests/buyer-available240-source-compatibility.test.mjs`: 6/6, w tym opt-in dokładnej odwrotności na
  prawdziwych katalogach (`DYNA_BUYER_AVAILABLE240_COMPILED_CATALOGUES`).

Kontrakt zimnego katalogu: 0 dodatków, 2 zmiany (`buyer_available236()`, `buyer_available236_basis()`). Poprzednik
to skompilowany after239 `d12733e7…`. Dziesięciu strażników `true` przed i po (`_08`). Wiersz manifestu: 11 961 B,
`3362d11e…`.

Świeży klon 218→240 (`_11`):

- ledger 230;
- dziesięciu strażników i `warehouse_wz_issuer_guards` `true`;
- zimna inspekcja `COLD_INSPECTION_PASSED` (44 559 rekordów, `ead72d1b…` = skompilowany after240,
  `buyer_available240_active`);
- wszystkie warianty z tabeli wyżej dają 55000 i niczego nie zapisują, poza opisanym `event_triggers=off` z DDL
  tabeli.

Pozostałe sprawdzenia:

- test DB 236 9/9 na klonie 240 (`_12`);
- run-bw 348/348;
- testy zależne od manifestu 365/365 (3 pominięte);
- `npx tsc --noEmit -p .` czysto.

## Do osobnej pracy

`wz_issuer239_verdict()` (239) ma w podstawie `ctid`/`xmin` wierszy `pg_event_trigger`, więc zwykłą pętlę widzi
jako chybienie. Nie ma jednak odpowiednika punktu 2. Pętla DISABLE → pusta `ordinary182_invalidate()` → ENABLE
daje chybienie, pełny strażnik zwraca `true`, a werdykt zapisuje się ponownie. Nie ma też wersji funkcji w
podstawie (`event_triggers=off` i podmiana funkcji). Potwierdzone na klonie `_11` w transakcji wycofanej. Sekwencja: DISABLE, pusta `ordinary182_invalidate()`,
ENABLE. Pierwsze wywołanie werdyktu to chybienie (2,5 s) i zapis. Potem podmiana `warehouse_wz_issuer_hash`
nie brudzi generacji. `wz_issuer239_verdict()` zwraca `true` w 2 ms, a `warehouse_wz_issuer_guards()` zwraca
`false`. Wymaga to migracji 241 według tego samego wzoru. Zrobione w 241 (`docs/parity/VERDICT-GATES241-20261027.md`).
