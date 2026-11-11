# RETURN-RECEIPT-GEN272: przyjęcie zwrotu bez pełnego strażnika w `financial_return_capture` (29.10.2026)

Przygotowana jako migracja `server/272_return_receipt_verdicts.sql` (numer zastępczy 272) i zintegrowana 29.10.2026 jako
**migracja 256** (`256_return_receipt_verdicts`, sekcja „Integracja jako 256” niżej); nazwa obiektu zachowuje prefiks
`return_receipt272_`. Opisy do sekcji integracji mówią o 272 i p270 (= migracja 255) jak w czasie przygotowania. Ścieżka `POST /api/returns/:id/receive`. Część katalogowa tej samej trasy
(`catalog_stock_return_prepare`) należy do toru p270 (`stock_verdict_return_prepare`, gałąź
`worktree-agent-ab7e3be976c99eb68`); 272 jest zaprojektowana na nim i dotyczy tylko `financial_return_capture` (162).
Pierwsza wersja tej gałęzi (`822029e`) miała też własną przednią bramkę prepare; po uwadze koordynatora o własności
plików została usunięta (`1297661`), a `server/catalog-stock-return-effects.ts` wrócił do bajtów sprzed 272.

## 1. Profil: gdzie idą 2,3 s

Pomiar na klonach PG04 (`dynaminds_p272_20261029_NN` = szablon `dynaminds_restore_36751abef3079f3f` + `migrate()` do 253),
przez prawdziwą trasę HTTP (`buildApp` + `inject`, sesja administratora, własna firma, katalog bez ścisłej kontroli, bez
WMS). Zamówienie wysłane przez `ship-demo`, potem w każdej rundzie zgłoszenie zwrotu 1 szt. i przyjęcie
`{accepted:1, restocked:1}` — dokładnie polecenie `return_receive` sterownika obciążenia. Generacja 182 zatwierdzona na
zimno jak przy starcie wydania (`ordinary187_approve`). Każde zapytanie trasy mierzone w kliencie `pg`, statystyki funkcji
(`track_functions=all`) zerowane przed przyjęciem. Skrypty: `…/scratchpad/p272/prof-receive.mts`, `prof.sh`, `prof2.sh`,
`route.cjs` (kopie i surowe logi: `local-builds/full-base-preview-20261017/return-receipt272-source-20261029-01/`).

Przed 270 i 272 (`before-04.txt`), ms:

| runda | trasa całość | 4 walidatory trybu dev (pkt 5) | **trasa bez preflightu** | `catalog_stock_return_prepare` | `financial_return_capture` | reszta trasy |
|---|---|---|---|---|---|---|
| 0 | 13 501 | 11 783 | **1 718** | 721 | 582 | 415 (w tym 287: pierwszy zapis werdyktu `financial_return_guards` po zatwierdzeniu) |
| 1 | 12 316 | 10 993 | **1 323** | 616 | 517 | 190 |
| 2 | 12 146 | 10 880 | **1 266** | 644 | 508 | 114 |

Bez zatwierdzonej generacji (`before-02.txt`, każdy werdykt = pełny strażnik) trasa bez preflightu to ~2,9–3,0 s, co odpowiada
p50 2,3 s z pomiaru 248+250, w którym część werdyktów chybiała.

1. **Dwa zapieczętowane wywołania to 76–91 % czasu bazy trasy.** Reszta (blokady wierszy, zapisy zwrotu i stanu, 5–6 trafień
   `guard_verdict` po 4–6 ms) to ~110–190 ms. Blokady wierszy nie grają roli (zapisy 4–19 ms).
2. **W środku są pełni strażnicy, nie logika.** `catalog_stock_return_prepare` uruchamia 3 × `catalog_stock_control_guards()`
   (przez `catalog_stock_return_require`, `catalog_stock_return_frame`, `catalog_stock_control_effect_prepare`) —
   to zdejmuje p270. `financial_return_capture` uruchamia 2 × `financial_return_guards()` (sam i przez
   `financial_return_frame`) — to zdejmuje 272. Werdykt 248 nie obejmuje wywołań wewnątrz zapieczętowanego SQL.
3. **W zwykłym przypadku capture odpowiada NULL.** Protokół 162 obejmuje tylko przyjęte, nieprzywracane na stan przyjęcie
   zwrotu pieniędzy dla nie-legacy RMA w stanie `requested`, bez WMS, lokalnego pochodzenia B2B i planu paczek, wobec faktury
   `b2b_invoice`. Polecenie obciążenia (`restocked:1`) zawsze trafia w NULL, a mimo to płaci dwa pełne strażniki.
4. **`b2b_credit_fingerprint` nie jest wołany przez trasę bezpośrednio.** To odcisk schematu (md5 definicji funkcji i tabel
   rodzin `b2b_credit_`, `catalog_stock_*`, `fa3_draft_` …), wołany wyłącznie z wnętrza strażników i walidatorów (34 funkcje,
   m.in. `financial_return_upgrade_valid` ×4, `manual_inventory_off_valid` ×3, `buyer_address_guards` ×3, `ordinary17x/18x_valid`).
   Na jedno przyjęcie liczy się 5 razy wewnątrz dwóch zapieczętowanych wywołań (prepare 3, capture 2; licznik
   `pg_stat_xact_user_functions` w teście DB), zawsze jako część pełnego strażnika. Własna pamięć podręczna odcisku
   wymagałaby nowych generacji tych 34 zapieczętowanych funkcji; skuteczna dźwignia to nie uruchamiać pełnego strażnika —
   po 270+272 trasa nie liczy go ani razu.
5. **Uwaga do pomiaru w trybie źródłowym:** bez bramki startowej (`ordinarySchemaGate`) każdy `tenantTx` przed transakcją
   uruchamia cztery walidatory schematu (`pim_dictionary_valid`, `nested172_valid`, `parcel_physical_wz_valid`,
   `operative_delivery_valid`, ~11–17 s na PG04; `server/db.ts:285`). Wydanie ich nie wykonuje, więc w tabelach są odjęte
   („trasa bez preflightu”). To nie jest koszt produkcyjny.

## 2. Projekt

Zapieczętowanego ciała nie można zmienić (zmiana `prosrc` `financial_return_capture` daje `false` w 8 z 13 strażników,
`p260/sealprobe.txt`), a odciski łapią każdą nową funkcję w rodzinach `financial_return_%`, `b2b_credit_%` itd. Dlatego 272
dodaje jedną **przednią bramkę** o nazwie spoza rodzin, wzorem `wz_issuer239_prepare_skip` (239):

- `return_receipt272_financial_capture(uid,kid,h,rid,q)`: `SECURITY DEFINER`, `search_path=pg_catalog,public,pg_temp`,
  `TimeZone=UTC`, bez uprawnień dla `dyna_app` i PUBLIC, bez tabel, zapisów, wyzwalaczy, dynamicznego SQL i blokad wierszy.
- Najpierw `guard_verdict('financial_return_guards')` (248). Wszystko poza dokładnie `true` (fałsz, błąd, izolacja inna niż
  READ COMMITTED, niezatwierdzona generacja, TEMP, zmieniona podstawa) = wywołanie zapieczętowanej funkcji, która rzuca
  dokładnie to co dotąd.
- Potem w kolejności zapieczętowanego ciała: `financial_return_identity(uid,kid,h,rid,false)` (ta sama funkcja, te same
  argumenty, w tym samym miejscu; jej błędy — brak/zły hash, wygasła sesja, MFA, obcy użytkownik, nieznane RMA — padają
  tak samo), istniejące dopuszczenie (= odtworzenie) → zapieczętowana, własne RMA (brak → zapieczętowana), tożsamość drugi
  raz (jak w ramce), warunki NULL ramki dosłownie, brak faktury `b2b_invoice` → NULL, w przeciwnym razie zapieczętowana.
- **NULL tylko tam, gdzie zapieczętowana funkcja odpowiedziałaby NULL bez błędu; w każdym innym przypadku wynikiem jest
  `RETURN public.financial_return_capture(uid,kid,h,rid,q)`.** Test statyczny sprawdza, że każde `RETURN` jest jednym z tych dwóch,
  że werdykt jest pierwszym odczytem i że pełny strażnik ani ramka nie są wołane bezpośrednio.

TS: `prepareFinancialReturn162InTx` (`server/financial-return-completion.ts`) pyta `to_regprocedure(…)` i woła przednią
bramkę, gdy jest; inaczej zapieczętowaną funkcję (kopia bez 272 działa jak dotąd). Odtworzenie
(`replayFinancialReturn162InTx`) zostaje przy zapieczętowanym capture. Wywołanie jest w istniejącym moście właściciela.
Roster stock-writer przepięty z notą `Source272` (odwrócenie do pinu sprzed 272 w `tests/catalog-stock-writer-coverage.test.ts`
i w linii credit208).

### Dlaczego przednia bramka nie może przyjąć stanu, który zapieczętowana funkcja odrzuca

1. **Strażnik.** Zapieczętowana funkcja zaczyna od `financial_return_guards()` i rzuca 55000, gdy jest fałszywy. Bramka
   pomija go tylko przy `guard_verdict('financial_return_guards')=true`; argument 248 (ta sama wartość pełnego strażnika
   przy tej samej zatwierdzonej generacji i tej samej podstawie) przenosi się bez zmian — to ten sam werdykt dla tej samej
   nazwy strażnika. Ramka wołałaby tego samego strażnika drugi raz w tej samej transakcji READ COMMITTED; werdykt
   odpowiada na oba miejsca tą samą wartością, bo jego podstawa obejmuje wszystko, od czego strażnik zależy.
2. **Pozostałe odmowy.** Każde sprawdzenie zapieczętowanego ciała przed odpowiedzią NULL jest albo wykonywane przez tę samą
   funkcję (tożsamość, dwa razy jak w oryginale), albo jego niespełnienie kieruje do zapieczętowanej funkcji. Jedyne własne
   wyjście bramki to NULL.
3. **Kolejność.** Odczyty idą w kolejności zapieczętowanego ciała w tej samej transakcji (każde polecenie READ COMMITTED ma
   nową migawkę, jak w oryginale). Zapieczętowany NULL nie bierze żadnej blokady ani nie zapisuje niczego; NULL bramki też.
4. **Sama bramka.** Pełni strażnicy jej nie przypinają (jak `guard_verdict` 248 i `wz_issuer239_prepare_skip` 239): jej
   definicję przypina zimny kontrakt katalogu przy starcie wydania (dodanie w parze zimnej, `INTEGRATION-p272.md` §3), a
   wymiana w działającej instalacji wymaga DDL właściciela — ten sam aktor może wymienić `guard_verdict` albo samych strażników
   (klasa zaakceptowana w 236/239/241/248). 272 nie dodaje nowej klasy.

## 3. Weryfikacja

Klony PG04 `dynaminds_p272_20261029_NN` z `_01` (= szablon + `migrate()` gałęzi, ledger 243, ostatnia
`253_mirakl_webhook_retention`), SQL nakładany przez właściciela w jednej transakcji z ustawieniami `migrate()` (`apply.cjs`),
strażnicy w sesji `jit=off`, `timezone=UTC`, READ COMMITTED READ ONLY (`guards.mjs`).

- **Strażnicy:** 10 + `warehouse_wz_issuer_guards` + `email_inbound_guards` (+ `catalog_stock_control_guards`,
  `financial_return_guards`) `true` przed 272, po 272 i po teście DB: `guards-before-11.json`, `guards-after-11.json`,
  `guards-posttest-11.json` (14/14 `true`); tak samo dla pierwszej wersji (`_03`, `_08`, `_10`) i po 270+272 na jednym klonie
  (`guards-both-14.json`, `guards-only270-13.json`).
- **`tests/return-receipt272.test.mjs`** (bez bazy): 0/6 na eksporcie HEAD po commicie testów (`4c86376`, bez SQL i TS;
  `red-static.txt`); po zawężeniu 5/5.
- **`tests/return-receipt272.database.test.ts`**: 0/7 na klonie bez 272 (`_05`, `red-db.txt`, pierwsza wersja testu);
  po zawężeniu **6/6** na `_11` (`green-db4.txt`). Każdy przypadek porównuje odpowiedź albo błąd (kod i komunikat)
  zapieczętowanej funkcji i bramki w punktach zapisu jednej transakcji właściciela:
  - 11 przypadków: `restocked` 1, `restocked` 0 bez faktury B2B, nic nie przyjęto, sprawa już przyjęta, żądanie z `wms_lots`
    — NULL bez pełnego strażnika i bez wywołania zapieczętowanej funkcji; brak/zły hash, brak sesji (28000), obcy
    użytkownik (42501), nieznane RMA (P0002), ilość jako tekst (przekazane zapieczętowanej) — równe zapieczętowanym;
  - **manipulacje** w punkcie zapisu: DDL właściciela na `financial_return_receipts`, zmiana `prosrc` zapieczętowanych
    `financial_return_frame`, `financial_return_capture`, `financial_return_identity` i `b2b_credit_fingerprint` (bez
    wyzwalaczy zdarzeń) — bramka rzuca 55000 tak jak zapieczętowana (werdykt chybia, pełny strażnik `false`);
  - REPEATABLE READ: werdykt = pełny strażnik, odpowiedzi równe;
  - koszt na trafieniu (mediana z 5): **541,7 → 6,3 ms** (pierwsza wersja: 601,0 → 5,3 ms);
  - trasa HTTP: 200, `receive_receipt` z numerem przyjęcia, stan `refund_pending`, bramka wywołana (`pg_stat_user_functions`).
- `b2b_credit_fingerprint` na wywołanie capture: 2 → 0 (błędy tożsamości 1 → 0).
- Pierwsza wersja (z bramką prepare, przed zawężeniem): test DB 7/7 na `_08` i `_10` (16 przypadków prepare równych
  zapieczętowanym, w tym produkt ze ścisłą kontrolą, historia i manipulacje) — `green-db2.txt`, `green-db3.txt`; zostaje jako
  dowód dla p270, że szybka ścieżka NULL prepare jest wykonalna, ale nie jest częścią 272.
- Bez bazy (`nodb.txt`): zestaw run-bw (base-wire, pakowanie zasobów), `tests/release-migrations-*.test.mjs`,
  `tests/source-ddl-migration-plan.test.mjs`, testy ledgera, roster stock-writer, credit208, 248, order-split-composition i
  272: **550/550**; `npx tsc --noEmit -p .` czysto.

## 4. Przed / po (trasa, z p270)

Ten sam scenariusz, zatwierdzona generacja, „trasa bez preflightu”, ms. 270 i jego dwa pliki TS wzięte z gałęzi p270
(`…/scratchpad/p272/overlay.sh`: eksport HEAD tej gałęzi + `server/270_stock_verdict.sql`, `server/catalog-stock-control.ts`,
`server/catalog-stock-return-effects.ts` z `worktree-agent-ab7e3be976c99eb68`; nic nie scalono).

| wariant (log) | runda 0 | runda 1 | runda 2 | prepare (ms, r1/r2) | capture (ms, r1/r2) |
|---|---|---|---|---|---|
| bez 270 i 272 (`before-04`) | 1 718 | 1 323 | 1 266 | sealed 616 / 644 | sealed 517 / 508 |
| tylko 272 (`only272-12`) | 1 046 | 784 | 903 | sealed 651 / 753 | **front 5 / 6** |
| tylko 270 (`only270-13`) | 996 | 905 | 750 | `stock_verdict_return_prepare` 27 / 20 | sealed 693 / 591 |
| **270 + 272** (`both-14`) | 446 | **149** | **150** | `stock_verdict_return_prepare` 17 / 18 | **front 6 / 5** |

Dla porównania pierwsza wersja 272 z własną bramką prepare (`after-07`, `after-09`): 412/121/121 i 419/124/184 ms — ten sam
poziom co 270+272, więc rozdział pracy na dwa tory nic nie traci.

Runda 0 zawiera jednorazowy zapis werdyktu `financial_return_guards` (~280–295 ms) po zatwierdzeniu generacji; w wydaniu
robi to pierwszy zapis po starcie. **W stanie ustalonym czas bazy przyjęcia: ~1,3 s → ~0,75–0,9 s z samym 270 → ~0,15 s z
270+272 (~8,5×)**; pełne strażniki na przyjęcie: 3 × `catalog_stock_control_guards` + 2 × `financial_return_guards` → 0.

Komendy (cwd = worktree): `bash …/scratchpad/p272/base.sh` (klon `_01`); `bash …/scratchpad/p272/prof.sh 04 before-04 0 3 0`
(bez SQL); `bash …/scratchpad/p272/overlay.sh`, potem `bash …/scratchpad/p272/chain.sh` (270 sam, 270+272) i
`W=<worktree> SQLFILES=…/scratchpad/p272/272.sql bash …/scratchpad/p272/prof2.sh 12 only272-12 3 0` (272 sam);
`node …/scratchpad/p272/route.cjs <logi>`. Test DB: `KEEP=1 bash …/scratchpad/p272/test.sh 11 green-db4 1
tests/return-receipt272.database.test.ts`.

Pod obciążeniem (niemierzone — pełnego testu obciążenia nie uruchamiałem zgodnie ze zleceniem): pełny strażnik kosztuje tam
1,3–1,6 s (`LOAD-TEST-FULL-20261028.md` §3), więc dwa zdjęte przez 272 pełne strażniki to więcej niż ~0,55 s z bezczynnej bazy.
Pięć firm zbioru obciążenia nie ma katalogów ze ścisłą kontrolą (odczyt `dynaminds_scale_20261028_71` w transakcji READ ONLY:
0 wierszy `catalog_stock_control_policies` dla każdej z 5 firm po 800 zamówień; 3 z nich mają WMS), a polecenie
`return_receive` przywraca na stan, więc idzie szybką ścieżką bramki (także z `wms_lots`, przypadek w teście DB).

## 5. Otwarte

1. **Przypadki delegowane kosztują tyle co dotąd plus werdykt** (trafienie ~5 ms, chybienie = jeden pełny strażnik ~0,3 s):
   odtworzenie, ścieżka 162 z fakturą B2B bez przywrócenia na stan, nieliczbowe ilości.
2. **Duplikacja warunków NULL.** Bramka powtarza ~10 wierszy warunków ramki 162. Zapieczętowane ciało nie zmieni się bez nowej
   generacji; wtedy trzeba ponownie uruchomić test różnicowy.
3. **Nie pokryte testem DB, tylko testem statycznym i argumentem:** istniejące dopuszczenie 162 (odtworzenie) i ścieżka z
   fakturą B2B — obie od razu idą do zapieczętowanego capture.
4. **`b2b_credit_fingerprint` poza tą trasą** nadal liczy się w każdym pełnym strażniku i walidatorze (34 funkcje). Dalszy zysk
   to zdejmowanie pełnych strażników z kolejnych ścieżek (jak 248/270/272); pozostałe ścieżki zapieczętowanego
   `financial_return_*` (`finish`, `terminal`, `replay`) wołają `financial_return_guards()` tylko na protokole 162
   (faktura B2B bez przywrócenia), poza poleceniem obciążenia — nie ruszane.
5. Klony: zostają `dynaminds_p272_20261029_01` (baza, bez 272) i `_11` (272 + test DB); pozostałe usunięte.

## Integracja jako 256 (29.10.2026)

Na migracji 255 (p270, `stock_verdict_`). Pięć commitów przygotowania (4c86376…ff0e892 z
`worktree-agent-a34bc742f445482d4`): 4c86376 i ff0e892 cherry-pickiem (2ff3a7c, 7a113a0), a trzy środkowe (822029e, c81808c,
1297661) jako jedna zmiana netto 3c2c42d, bo wycofana w 1297661 bramka katalogowa z 822029e koliduje z przełącznikiem 255 w tych
samych liniach `server/catalog-stock-return-effects.ts` (netto 272 tego pliku nie zmienia). Konflikty pinów tekstowe, jak
przewiduje `INTEGRATION-p272.md`: w `server/catalog-stock-writer-coverage.ts` obie noty (Source270, potem Source272), piny 255 dla
`catalog-stock-control.ts` i `catalog-stock-return-effects.ts`, pin 272 dla `financial-return-completion.ts` przeliczony z bajtów
końcowych (`a61101fb…`/12 341 → `b43a9629ffe12fe54a325d8678473d1eee0bcb4861bc85ce5faa269935c0e424`/12 727); w
`tests/catalog-stock-writer-coverage.test.ts` oba testy odwrócenia (270 i 272); w `tests/return-credit208-resources.test.mjs`
najpierw nota 272, potem 270. Potem dwa commity integracji (09d1549 testy, 5eb8004 migracja), poprawka testu (c30e149) i ten dokument.

- SQL: `server/272_return_receipt_verdicts.sql` → `server/256_return_receipt_verdicts.sql`; pierwsza linia komentarza
  „Migration 256_return_receipt_verdicts (prepared as 272; the object name keeps the return_receipt272_ prefix).”, reszta bez
  zmian; 4 362 B, sha256 `6ce76ac9f8af8d1900a620ee4e37e96802101b106193a0cd8d2513945d81319c`.
- Wiersz manifestu `256_return_receipt_verdicts` (`native_id` `return_receipt_verdicts256`, kontrakt
  `return-receipt-verdicts256`) po 255. `server/db.ts` bez zmian: `INTEGRATION-p272.md` każe dopisać parę w `db.ts`, ale od 244
  program wydania pochodzi z manifestu, a test statyczny odrzuca literalną parę (decyzja integratora).
- Zimny katalog: kompilacja na `dynaminds_m256_20261029_01` (szablon + 218…255 + ledger; poprzednik = skompilowany after255
  `79ae0d32…98908a50`): **1 dodanie** (`return_receipt272_financial_capture(uuid,uuid,text,uuid,jsonb)`, SECURITY DEFINER,
  właściciel `postgres`, ACL `{postgres=X/postgres}`), 0 zmian, 0 usunięć; after256 `c64efb24…0752203d` (46 989 rekordów);
  dwunastu strażników + `catalog_stock_control_guards` + `financial_return_guards` true przed i po.
  `return-receipt-verdicts256-source-contract.mjs`, `return-receipt-verdicts256-source-compatibility.mjs`
  (`projectCompiledReturnReceiptVerdicts256Catalogue`, łańcuch odwrotny od 255, footprint gołym prefiksem `return_receipt272_`),
  jedna linia w `release-cold-projectors.mjs`. Wyniki: `local-builds/full-base-preview-20261017/m256-source-20261029-01/`.
- Ledger 246 (guard: przyszłe `257_…`, `258_…`); MIG-2 stosuje 244…256; MIG-1 i MIG-4 oczekują serii 244…256; 255 nie jest już
  ostatnia; rodzina klonów `m256` w testach DB 236…255 (także `stock-verdict255.test.ts`), installation-identity, settlement
  report, MIG-1/2/4 i worker-supervision. Testy DB MIG-1/2/4 biegną raz, po 258 (dokument 258).
- Testy: `tests/return-receipt256.test.mjs` (test „prepared, not registered” zastąpiony przypięciem wiersza manifestu),
  `tests/return-receipt256.database.test.ts` (prawdziwe `migrate()`, wiersz ledgera 256),
  `tests/return-receipt-verdicts256-source-compatibility.test.mjs` (7, ostatni opt-in; jedno dodanie jest całym footprintem,
  więc katalog bez niego to katalog 255 — tożsamość, nie odmowa).
- Przypadek HTTP testu DB liczy wywołania w `pg_stat_user_functions`, a trasa działa na puli aplikacji z domyślnym
  `track_functions=none`; klon przygotowania (`dynaminds_p272_20261029_11`) miał `ALTER DATABASE … SET track_functions=all`
  od swojego skryptu. Na `_05` bez tego ustawienia przypadek był czerwony (5/6: 0 nowych wywołań mimo 200 i numeru przyjęcia).
  c30e149: test sprawdza ten warunek w `before()` (jasna odmowa zamiast mylącej czerwieni), skrypt integracji ustawia go na klonie.
  Bez zmiany produktu i SQL.
- `INTEGRATION-p272.md` usunięty (treść tutaj).

| Sprawdzenie (PG04, klony `dynaminds_m256_20261029_NN`; wyniki w `m256-source-20261029-01/tests/`) | Wynik |
|---|---|
| `_05` świeży klon na 5eb8004 (stan 256), prawdziwe `migrate()` | ledger 246, ostatnia `256_return_receipt_verdicts` |
| strażnicy na `_05` (jit=off, UTC; `guards-A-05.json`) | dziesięciu + `warehouse_wz_issuer_guards` + `email_inbound_guards` + `catalog_stock_control_guards` + `financial_return_guards` = true |
| inspekcja zimna na `_05` (`cold-A-05.json`) | COLD_INSPECTION_PASSED, `native_catalogue_sha256` = after256 `c64efb24…`, flagi `*_active` 216…256 true |
| `tests/return-receipt256.database.test.ts` na `_05` (bez `track_functions=all`) | 5/6 — przypadek HTTP (warunek środowiska, wyżej) |
| ten sam test na `_08` (świeży klon na c30e149, `track_functions=all` na bazie; ledger 247, bo w tym stanie jest już 257) | 6/6 (front door 3,8 ms wobec 409,5 ms zapieczętowanej funkcji); strażnicy i inspekcja zimna (after257) true/PASSED przed, strażnicy true po |
| `tests/guard-verdicts248.test.ts` (`_06`) | 18/18, strażnicy true przed i po |
| `tests/stock-verdict255.test.ts` (`_07`, z 256) | 8/8, strażnicy true przed i po |
| bez bazy: zestaw jak przy 255 + `return-receipt256`, `return-receipt-verdicts256-source-compatibility` | 577/585, 6 pominiętych opt-in, 2 czerwone znane sprzed integracji (`failure-job-kinds`, `buyer-address-carrier-ui166`) |
| `tests/return-receipt-verdicts256-source-compatibility.test.mjs` z opt-in na prawdziwych katalogach 256 | 7/7 |
| `tests/catalog-stock-writer-coverage.test.ts`, `tests/return-credit208-resources.test.mjs` | zielone (31/31 razem z `stock-verdict255.test.mjs`) |
| `npx tsc --noEmit -p .` | czysto |
