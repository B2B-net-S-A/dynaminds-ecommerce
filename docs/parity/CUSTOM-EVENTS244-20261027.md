# Migracja 244: zdarzenia własne (AUTO-07) i sumy kontrolne migracji (MIG-2) (27.10.2026)

Dwie pozycje Etapu 4 z [STAGE4-NONINTEGRATION-GAP-20261025](STAGE4-NONINTEGRATION-GAP-20261025.md), które czekały
tylko na numer migracji: AUTO-07 (DOM-AUTO-008, zdarzenia własne) i MIG-2 (niezmienność zastosowanych migracji).
Migrację przygotowano w osobnym drzewie pod numerem zastępczym 251 (`5bb7538` testy, `66dada5` kod, `5d11107`
instrukcja integracji). Tu dostała numer 244, po `243_ksef_purchase`, i weszła do listy wydania.

## Co powstało

`server/244_custom_events_checksums.sql` (4 515 B, sha256 `b809ceb0…cdfcb204`) tworzy tylko własne obiekty:

- `custom_event_defs`: definicja zdarzenia per tenant (klucz `^[a-z][a-z0-9_]{1,39}$`, unikalny w tenancie,
  niezmienny), nazwa, opis, `active`, `version`. Definicję się wyłącza, nie usuwa.
- `custom_event_calls`: historia wywołań, tylko dopisywana. `client_key` unikalny w tenancie, `request_sha256`,
  źródło `ui/api/rule/schedule/batch`, `operation_id` dla reguły, harmonogramu i partii, wersja definicji.
  Jedyny klucz obcy w migracji prowadzi do `custom_event_defs(tenant_id, id)`.
- `migration_checksums(name, file, bytes, sha256, origin, recorded_at)`: rejestr MIG-2, tylko dla właściciela.

RLS `tenant_scope` na obu tabelach zdarzeń. `dyna_app` dostaje `SELECT, INSERT, UPDATE` na definicjach i
`SELECT, INSERT` na historii, bez `DELETE`. Do rejestru nie ma dostępu. Żadna tabela rdzenia nie jest zmieniana,
wskazywana kluczem obcym (na `orders`, `order_events` ani `migrations` nie trafia trigger RI) ani zapisywana, więc
żaden strażnik ani odcisk nie przesuwa się. Danych osobowych brak.

## AUTO-07: zdarzenie własne

- Wywołanie (`raiseCustomEventInTx`, `server/custom-events.ts`) w transakcji tenanta: blokada doradcza na kluczu
  wywołania, ten sam klucz z tą samą treścią zwraca to samo wywołanie, inna treść pod tym kluczem daje 409.
  Nieznana definicja 404, nieaktywna 422. Pod blokadą zamówienia powstaje jedno zdarzenie zamówienia
  `custom.<key>`, które uruchamia reguły nasłuchujące przez istniejące trwałe zadanie `automation`, jeden wiersz
  historii i wpis audytu `custom_event.raised`.
- Skąd: panel zamówienia i `POST /api/custom-events/:key/raise` (administrator lub operator), `/api/v1` z kluczem API
  `orders:write`, akcja reguły `raise_event` (także z harmonogramu i partii). Definicje (`GET/POST/PATCH
  /api/custom-events`) zmienia tylko administrator. Historia z przebiegami reguł: `GET /api/custom-events/:id/calls`.
- Reguła nasłuchująca `custom.<key>` albo wywołująca zdarzenie musi wskazywać własną definicję (aktywną, gdy reguła
  jest włączona). Pętla reguł zatrzymuje się na istniejącym limicie łańcucha.
- Trasy rejestrują się w `registerOperationRoutes`, więc `server/app.ts` się nie zmienia i pin
  `scripts/full-base-scale-http-ports.mjs` zostaje.
- UI: panel „Zdarzenia własne” w Automatyzacjach, akcja „Wywołaj zdarzenie własne” i wyzwalacze `custom.<key>`.
- Na kopii bez 244 zapisy odpowiadają 503, a lista jest pusta.
- Zdarzenia własne nie wysyłają webhooka ani sygnału statusu.

## MIG-2: sumy kontrolne

Opis rejestru, zapisu i odmowy jest w [MIGRATIONS-S1-20261026](MIGRATIONS-S1-20261026.md#mig-2-suma-kontrolna-zastosowanej-migracji-migracja-244-27102026).
W skrócie: po kontroli ledgera (MIG-6) `migrate()` porównuje zapisane sumy z plikami wydania i przy różnicy odmawia
startu (`MIGRATION_CHECKSUM_MISMATCH`), niczego nie zmieniając. Przed `COMMIT` dopisuje brakujące wiersze: `applied`
dla migracji z tego biegu, `baseline` dla zastosowanych wcześniej.

## Integracja jako 244

- Cherry-pick `5bb7538`, `66dada5`, `5d11107` na `goal/full-base-20261017` bez konfliktów. `web/operations.tsx`
  scalił się sam z poprawką SR4-H1 (`450a267`). Sprawdzone: obie zmiany są w pliku.
- Zmiana nazwy na `244_custom_events_checksums` (plik SQL, pierwszy komentarz, testy, komentarze z „251”),
  `native_id` `custom_events_checksums244`, kontrakt `custom-events-checksums244`, wiersz manifestu (4 515 B).
- Skompilowana para zimnego katalogu na klonie `dynaminds_m244_20261027_01` (szablon + 218…243 + ledger, poprzednik =
  skompilowany after243 `a9620911…6cd5ce180`): **133 dodania, 0 zmian, 0 usunięć** (12 relacji, 49 kolumn,
  51 ograniczeń, 9 indeksów, 6 typów wierszy, 2 polityki, 4 triggery RI). Jedenastu strażników `true` przed i po.
  `custom-events-checksums244-source-contract.mjs`, `custom-events-checksums244-source-compatibility.mjs` (odwrotność
  244→243 i pełni poprzednicy 243…217), jedna linia w `release-cold-projectors.mjs`. Kompilator i wyniki są w
  `local-builds/full-base-preview-20261017/custom-events-checksums244-source-20261027-01/`.
- Regex śladu rodziny to prefiks `(?:^|[.:"])_?(?:custom_event_(?:defs|calls)|migration_checksums)` bez `\b` z
  INTEGRATION.md: z `\b` klucze indeksów i ograniczeń (`custom_event_calls_pkey`, `migration_checksums_pkey`) nie
  pasowały, bo `_` jest znakiem słowa. Odwrotność na prawdziwym katalogu after243 daje nadal tożsamość.
- Ledger: 234 migracje, przyszłe nazwy w teście to `245_future_release`, `246_after_that`.
- Testy bazodanowe AUTO-07 i MIG-2 działają na prawdziwym `migrate()`, bez ręcznie stosowanego SQL. Test MIG-2
  zaczyna od klonu zmigrowanego przez wydanie sprzed 244 (`c856f6a`). Rodzina `m244` jest dopisana w testach
  236/239/240/241/242/243.
- Stock-writer: `db.ts` (wywołania MIG-2 w `migrate()`) i `developer-api.ts` (trzy operacje publiczne AUTO-07) mają
  nowy pin w `server/catalog-stock-writer-coverage.ts` z notatką z przeglądu: nie ma nowego zapisu stanu, wywołania
  stock-writera ani obejścia bramki. Test pokrycia cofa zadeklarowane zmiany do dokładnych bajtów Source243
  (`430fb682…`, 48 726 B; `395afaf6…`, 233 663 B) i potwierdza, że te piny są odrzucane. Linia credit208 najpierw
  usuwa komentarz 244.
- INTEGRATION.md (instrukcja dla numeru zastępczego) jest usunięty, bo jego treść jest w tym pliku.

## Weryfikacja (PG04 127.0.0.1:57084, klony `dynaminds_m244_20261027_NN`)

- Na czerwono przed rejestracją: test statyczny (brak wiersza manifestu), ledger (233 zamiast 234), zgodność
  (brak kontraktu).
- `_02`: `migrate()` od szablonu (217) do 244: ledger 234, ostatnia `244_custom_events_checksums`. Dziesięciu
  strażników i `warehouse_wz_issuer_guards` `true` (jit=off, UTC). Rejestr: 211 `baseline` (001…217) i 27 `applied`
  (218…244).
- `_02`: inspekcja zimna `COLD_INSPECTION_PASSED`, `custom_events_checksums244_active: true`,
  `mode209: active209_inverse`.
- `_03` (klon zmigrowany przez `c856f6a` do 243, bez rejestru): `tests/migration-checksums244.database.test.ts` 1/1.
- `_04`: `tests/custom-events244.database.test.ts` 6/6.
- Bez bazy: statyczny 244 6/6, zgodność 244 6/6 (z prawdziwymi katalogami), MIG-2, AUTO-07, ledger, kopia 30/30,
  `tests/release-migrations-*.test.mjs` i `tests/source-ddl-migration-plan.test.mjs` 253/253 (z testem statycznym),
  web 54/54, run-bw 368/368, scale http-ports, stock-writer i credit208 150/150 (15 pominiętych jak wcześniej),
  `npx tsc --noEmit -p .` czysto.

## Otwarte

- Brak.
