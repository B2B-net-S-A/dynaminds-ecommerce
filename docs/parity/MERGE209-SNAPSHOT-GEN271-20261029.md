# Migawka 209 — nowa zapieczętowana generacja 271 (29.10.2026)

**Wynik:** migracja przygotowana jako `271_order_merge_snapshot_index_paths` i zintegrowana 29.10.2026 jako **257**
(`257_order_merge_snapshot_index_paths`, sekcja „Integracja jako 257” niżej; teksty błędów i ustawienie
`dyna.order_merge_snapshot271` zachowują 271) zastępuje tylko ciało `public.order_merge_delivery209_validation_snapshot()`. Wartość jest bajtowo równa wartości
Source209 na tym samym katalogu. Wywołanie kosztuje **12,1 ms zamiast 18,1 ms** czasu własnego (−33 %), a pełne
strażniki tracą 13–18 % czasu. Bez obciążenia, na PG04, po rozgrzaniu. Integracja: sekcja „Integracja jako 257”.

## 1. Skąd koszt

`pg_stat_xact_user_functions` na klonie (bieg z §4) pokazuje dwie rzeczy.

**Liczba wywołań.** Migawkę liczy od nowa każdy sealed caller:
- `order_merge_delivery209_checked_projection_map()` na początku każdego z 17 strażników „legacy”;
- `order_merge_delivery209_valid()`, także z `predecessor_metadata`.

| Strażnik | Wywołania migawki na jedno wywołanie strażnika |
|---|---:|
| `ordinary187_valid()` | 90 |
| `pim_dictionary_valid()` | 86 |
| `warehouse_wz_issuer_guards()` | 41 |
| `buyer_address_guards()` | 12 |
| `catalog_stock_control_guards()`, `financial_return_guards()` | po 4 |

**Plan jednego wywołania.** Z 21 ms (zapytanie wklejone, z planowaniem):
- ~6 ms to pełne skany katalogu. `pg_class` (5 011 wierszy), `pg_constraint` (13 780) i `pg_trigger` (9 413)
  idą przez hash join, bo predykaty `OR`/`starts_with` nie mają ścieżki indeksowej;
- ~9 ms to część „legacy”: 17 funkcji, 5,3 MB źródeł, dwa SHA-256 i `pg_get_functiondef`. To koszt wewnętrzny.

## 2. Projekt

Gotowe ciało produkuje `tools/parity/order-merge-delivery271-snapshot.mjs` z pliku 209. Testy cofają każdą zmianę
i odzyskują ciało 209 bajt w bajt.

1. **Ścieżki indeksowe (6 miejsc).** Każdy predykat 209 zostaje dosłownie. Dochodzi koniunkcja zawężająca do
   nadzbioru tych samych wierszy, który znajdzie indeks:
   - zakres nazw `>= 'order_merge_delivery209_' AND < 'order_merge_delivery209\`'` na indeksach `name`
     (kolacja C, porządek bajtowy);
   - listy oid `x.oid = ANY(ARRAY(…))` z gałęzi `conrelid`, `tgrelid`, `tgconstraint` i nazw.

   Wiersze, wartości, `ORDER BY` i agregacja się nie zmieniają, więc wynik nie zależy od planu. Klucze
   (rodzaj, klucz) są unikalne: 259/259, sprawdzone.
2. **Wpis własny.** Ciało 209 hashuje własny deskryptor (24 pola) do odcisku z niezmiennego manifestu. Nowe ciało
   dla swojego jednego rekordu zwraca skrót, który Source209 dałoby dla funkcji o tych samych żywych atrybutach.
   W tym rekordzie podmienia tylko `source` i `definition` na stałe 209 (`ba515fa5…`, `b42da3eb…`).
   Robi to tylko wtedy, gdy żywe `source` i `definition` są dokładnie tym ciałem. W każdym innym przypadku zostaje
   wyrażenie 209 bez zmian.

   Oczekiwany tekst ciało liczy samo. Jest **quine**: literał `$q271$…$q271$` zawiera szablon,
   a `replace(szablon, '#271#', literał)` daje dokładnie `prosrc`. Nie ma zapisanej kopii (tabeli, ustawienia),
   którą dałoby się podmienić. Nie ma też nowego obiektu.
3. **Migracja:**
   - odmawia, jeśli przed nią migawka nie jest dokładnym tekstem Source209 albo `order_merge_delivery209_valid()`
     nie daje true;
   - po `CREATE OR REPLACE` (oid, właściciel i ACL zachowane) przypina oba nowe skróty;
   - sprawdza bajtową równość wartości przed/po;
   - sprawdza `order_merge_delivery209_valid`, `buyer_address_guards` i `return_credit206_guards`.

   Ponowne zastosowanie jest odrzucane (sprawdzone).

Strona wywołująca w TS się nie zmienia. Migawkę wołają wyłącznie zapieczętowane funkcje SQL, po nazwie.

## 3. Argument bezpieczeństwa

Sonda (wycofana transakcja na `_01`): migawka zastąpiona funkcją zwracającą stałą, poprawną wartość. Wszystkie
14 strażników (12 kontrolnych + `catalog_stock_control_guards` + `financial_return_guards`) dało true. **Tekst
migawki przypina więc tylko ona sama, przez swój wpis własny.** Każdy inny strażnik zależy wyłącznie od jej
wartości. Z tego wynikają dwa warunki równoważności:

- **Na każdym stanie, w którym funkcja migawki ma ciało 271,** wartość 271 jest równa wartości 209 dla tego
  samego stanu z ciałem 209 i tymi samymi atrybutami. Wiersze i wyrażenia są te same, a wpis własny jest
  przemapowany 1:1.
- **Gdy zmieniono samą migawkę,** obie wersje odrzucają zmianę:
  - zmiana atrybutu zostaje w żywych polach;
  - edycja tekstu nie pasuje do quine, więc zostaje żywy skrót;
  - spójny przepisany quine to pełna podmiana kodu. Tak samo działa w 209, gdzie podmiana na stałą przechodzi
    (sonda wyżej). Superużytkownik zmieniający kod migawki obchodzi oba warianty jednym krokiem.

  Żadnej pojedynczej zmiany, którą 209 wykrywa, 271 nie przepuszcza.

Sprawdzono na `dynaminds_p271_20261029_02` (`tests/order-merge-delivery271.database.test.ts`, 39/39). Każdy
przypadek wykonano w wycofanej transakcji: zmiana, odpowiedź 271, podmiana na ciało 209 (z powtórzeniem zmiany
celującej w migawkę) i odpowiedź 209.

- **28 zmian katalogu poza migawką: bajtowo ta sama odpowiedź i ten sam werdykt.** Wśród nich:
  - 5 kontroli niewykrywanych przez obie wersje: komentarz, nazwa bez `_`, pierwsza nazwa za zakresem,
    209 poza `public`, wyzwalacz za zakresem;
  - granice: goły prefiks, nazwa wielobajtowa;
  - wyzwalacze z gałęzi nazwy i gałęzi `tgconstraint` (wewnętrzny wyzwalacz FK na `orders`);
  - ograniczenia z gałęzi nazwy;
  - typ złożony i domena `_order_merge_delivery209_…`;
  - ciało, atrybut i grant funkcji legacy;
  - część `constraints`;
  - kolumny, indeks, polityka, granty.
- **7 zmian samej migawki: obie wersje odrzucają.** Grant, `SET work_mem`, koszt, `VOLATILE`, właściciel, dopisany
  komentarz (sonda p260) i edycja wyłącznie wewnątrz literału quine.
- **Niezależność od planu.** Ta sama wartość przy wyłączonych kolejno: skanach indeksowych, seq scan i hash join,
  nested loop i merge join, material i memoize.
- 12 strażników true. Pliki:
  - `local-builds/full-base-preview-20261017/p271-source-20261029-01/guards-02.json` (po 271);
  - `guards-01-before.json` (bez 271).

## 4. Przed / po (poziom funkcji)

Bieg: `node …/scratchpad/p271/bench.cjs dynaminds_p271_20261029_01 dynaminds_p271_20261029_02 31 5`. Warunki:
- `_01` = Source209, `_02` = Source271, ten sam szablon i ten sam ledger 243;
- przeplatane wywołania, każde we własnej transakcji READ ONLY;
- `track_functions=all`, różnica `pg_stat_xact_user_functions` w obrębie wywołania;
- load hosta 7–11 (sąsiednie sesje), więc liczby względne są pewniejsze niż bezwzględne.

| Wywołanie (n) | 209 ściana mediana/p95 ms | 271 ściana mediana/p95 ms | migawka self 209 → 271 ms |
|---|---|---|---|
| `…validation_snapshot()` (31) | 18,4 / 21,6 | 12,3 / 13,1 | 18,1 → 12,1 |
| `order_merge_delivery209_valid()` (31) | 18,4 / 19,3 | 12,4 / 13,3 | 17,9 → 11,9 |
| `manual_inventory_off_projection_valid()` (5) | 36,4 / 41,3 | 29,3 / 30,8 | 18,7 → 12,4 |
| `catalog_stock_control_guards()` (5) | 216,9 / 240,3 | 186,5 / 195,0 | 75,0 → 48,4 |
| `financial_return_guards()` (5) | 264,9 / 267,4 | 226,7 / 233,3 | 74,1 → 48,2 |
| `buyer_address_guards()` (5) | 482,7 / 513,1 | 397,3 / 414,1 | 247,4 → 167,9 |
| `warehouse_wz_issuer_guards()` (5) | 2 622 / 2 858 | 2 252 / 2 320 | 900,5 → 584,8 |
| `pim_dictionary_valid()` (5) | 4 786 / 5 324 | 4 269 / 4 647 | 1 630,9 → 1 121,6 |
| `ordinary187_valid()` (5) | 4 136 / 4 220 | 3 579 / 3 851 | 1 626,3 → 1 082,8 |

Surowe próbki: `…/scratchpad/p271/bench-*.json`, `bench-run1.txt`. Liczba wywołań migawki się nie zmienia, więc
w teście obciążenia oczekuję ~1/3 mniej z 3,1 rdzenia migawki (l250). Niepotwierdzone: pełny test obciążenia
uruchamia koordynator.

## 5. Prototyp a44cceb — odrzucony

`order-merge-delivery209-snapshot-opt.mjs` wycina bajty źródła z jednego `pg_get_functiondef` zamiast drugi raz
rozpakowywać `prosrc`. Zmierzyłem najlepszy przypadek tej idei (ogólna ramka `$function$\n`, CTE legacy osobno, 15
par): **16,00 ms wobec 15,41 ms oryginału**. Bez `OFFSET 0` było 31,6 ms, bo planner wkleja wyrażenie
czterokrotnie. Zysku nie ma: koszt to `pg_get_functiondef`, kopie i dwa SHA-256, a nie samo rozpakowanie. Do tego
prototyp zmienia semantykę wyścigu: skrót źródła brałby z cache katalogu zamiast z migawki MVCC. Ma też 17
zapieczętowanych ramek. Pliki zostają nietknięte, w integracji można je usunąć osobno.

## 6. Kompromis, który zostaje do decyzji

Zostaje głównie liczba wywołań (90 na `ordinary187_valid`), nie koszt jednego. Memo w obrębie instrukcji
skróciłoby czas self migawki dla `ordinary187_valid` z ~1 083 ms do ~12 ms, a 3,1 rdzenia do ~0,1. Takie memo
wymaga trzech rzeczy:
- **Stan sesji.** W funkcji STABLE dostępne jest tylko `set_config`, a ten może ustawić także `dyna_app`.
- **Uwierzytelnienie.** HMAC z sekretem właściciela, czyli nowa tabela i nowy korzeń zaufania.
- **Klucz.** `pg_current_snapshot()` + `txid_current_if_assigned() IS NULL`.

Zmienia to gwarancję w dwóch miejscach. Po pierwsze, zmiana zatwierdzona przez inną sesję w trakcie instrukcji
przestaje być widoczna w kolejnych wywołaniach. Dziś bywa widoczna częściowo, przez funkcje czytające cache
katalogu. Po drugie, bezpieczeństwo opiera się na sekrecie zamiast na samym katalogu. To osłabienie, więc go nie
zrobiłem.

## 7. Kontrole

- `node --test tests/order-merge-delivery271.test.mjs`: 7/7.
- Razem z `release-migrations-*`, `source-ddl-migration-plan` i testami 209 snapshot: 331/331.
- `npx tsc --noEmit -p .`: 0 błędów.
- `tests/order-merge-delivery271.database.test.ts` na `_02`: 39/39, ok. 18 s. Przed SQL testy były czerwone
  (brak pliku). Dwie asercje testu poprawiłem w drodze do zieleni (d6ff4c6).
- Klony: `dynaminds_p271_20261029_01` (bez 271) i `_02` (271 ręcznie, bez wiersza w ledgerze). Oba zostają do
  integracji, potem do usunięcia.

## Integracja jako 257 (29.10.2026)

Wzorzec 250 (jeden zmieniony rekord funkcji w parze zimnej, nic nie dodane). Cztery commity przygotowania (a738cd6…39399f9 z
`worktree-agent-a3257b06b9f952ede`) przeniesione cherry-pickiem na `goal/full-base-20261017` (1a2af0d…e281869) bez
konfliktów; potem dwa commity integracji (d7d105b testy, 14d9081 migracja) i ten dokument.

- SQL: `server/271_order_merge_snapshot_index_paths.sql` → `server/257_order_merge_snapshot_index_paths.sql`; zmienia się
  tylko pierwsza linia komentarza („Migration 257_order_merge_snapshot_index_paths (prepared as 271, registered after
  256_return_receipt_verdicts; the error texts and the setting dyna.order_merge_snapshot271 keep 271)”). Ciało-quine
  w `$snapshot271$…$snapshot271$` i jego dwa odciski bez zmian; 39 793 B, sha256
  `fe4b14ce3c2c7ae4889a37b03ef5a4418581f46df9bbbd683ffb3df411728c42`.
- Wiersz manifestu `257_order_merge_snapshot_index_paths` (`native_id` `order_merge_snapshot257`, kontrakt
  `order-merge-snapshot257`) po 256; `server/db.ts` bez zmian.
- Zimny katalog: kompilacja na `dynaminds_m257_20261029_01` (szablon + 218…256 + ledger; poprzednik = skompilowany after256
  `c64efb24…0752203d`): **0 dodań, 1 zmiana, 0 usunięć** — potwierdza oczekiwanie z przygotowania: rekord
  `function public.order_merge_delivery209_validation_snapshot()`, różnią się tylko `source` i `definition` (sygnatura,
  atrybuty, właściciel i ACL bez zmian); after257 `1b725aaa…9452971c` (46 989 rekordów, liczniki bez zmian); dwunastu
  strażników + `catalog_stock_control_guards` + `financial_return_guards` true przed i po.
  `order-merge-snapshot257-source-contract.mjs`, `order-merge-snapshot257-source-compatibility.mjs`
  (`projectCompiledOrderMergeSnapshot257Catalogue`, jak 250: aktywny dokładnie wtedy, gdy migawka nie jest rekordem Source209;
  czyta ją z powrotem, potem łańcuch odwrotny od 256), jedna linia w `release-cold-projectors.mjs`. Wyniki:
  `local-builds/full-base-preview-20261017/m257-source-20261029-01/`.
- Ledger 247 (guard: przyszłe `258_…`, `259_…`); MIG-2 stosuje 244…257; MIG-1 i MIG-4 oczekują serii 244…257; 256 nie jest
  już ostatnia; rodzina klonów `m257` w testach DB 236…256, installation-identity, settlement report, MIG-1/2/4 i
  worker-supervision. Testy DB MIG-1/2/4 biegną raz, po 258.
- Testy: `tests/order-merge-delivery257.test.mjs` (dodane przypięcie wiersza manifestu; test nagłówka oczekuje „prepared
  as 271, registered after 256…”), `tests/order-merge-delivery257.database.test.ts` (prawdziwe `migrate()`, wiersz ledgera
  257), `tests/order-merge-snapshot257-source-compatibility.test.mjs` (6, ostatni opt-in). Generator
  `tools/parity/order-merge-delivery271-snapshot.mjs` zostaje pod swoją nazwą (Source271).
- Bez zmian TS i plików przypiętych (roster stock-writer, scale http-ports). `INTEGRATION-p271.md` usunięty (treść tutaj).
  Niepodpięty prototyp `tools/parity/order-merge-delivery209-snapshot-opt.mjs` zostaje, jak był.

| Sprawdzenie (PG04, klon `dynaminds_m257_20261029_02` na 14d9081; wyniki w `m257-source-20261029-01/tests/`) | Wynik |
|---|---|
| `_02` świeży klon, prawdziwe `migrate()` | ledger 247, ostatnia `257_order_merge_snapshot_index_paths` |
| strażnicy na `_02` (jit=off, UTC; `guards-A-02.json`) | dziesięciu + `warehouse_wz_issuer_guards` + `email_inbound_guards` + `catalog_stock_control_guards` + `financial_return_guards` = true |
| inspekcja zimna na `_02` (`cold-A-02.json`) | COLD_INSPECTION_PASSED, `native_catalogue_sha256` = after257 `1b725aaa…`, flagi `*_active` 216…257 true, tryb 209 `active209_inverse` |
| `tests/order-merge-delivery257.database.test.ts` (`_02`) | 39/39; strażnicy po teście true (`guards-after-02.json`) |
| bez bazy: zestaw jak przy 256 + `order-merge-delivery257`, `order-merge-snapshot257-source-compatibility`, `wms-evidence-settle250-source-compatibility` | 597/606, 7 pominiętych opt-in, 2 czerwone znane sprzed integracji |
| `tests/order-merge-snapshot257-source-compatibility.test.mjs` z opt-in na prawdziwych katalogach 257 | 6/6 |
| `npx tsc --noEmit -p .` | czysto |
