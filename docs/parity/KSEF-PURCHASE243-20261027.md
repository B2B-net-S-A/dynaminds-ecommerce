# Migracja 243: faktury zakupowe z KSeF (27.10.2026)

Etap 4 „KSeF bezpośrednio”, strona zakupowa: faktury kosztowe wystawione na NIP firmy (Subject2) są pobierane z KSeF,
przechowywane bez zmian i obsługiwane w Dokumentach. Klient KSeF 2.0, model i lokalny fake powstały 26.10.2026
(`0050500`, `2ee7bf8`, [KSEF-PURCHASE-20261026](KSEF-PURCHASE-20261026.md)). Ten bieg dokłada migrację, zapis,
zadanie w tle, trasy, UI, RODO i retencję.

Wszystko działa lokalnie na fałszywym KSeF (`server/ksef229-fake-purchase.ts`, 127.0.0.1). `KSEF_REAL_ENABLED` zostaje
`false`, więc klient odrzuca hosty MF przed jakimkolwiek żądaniem. Prawdziwy sandbox MF: pytania niżej.

## Co powstało

| Element | Po co |
|---|---|
| `server/243_ksef_purchase.sql` | sześć własnych tabel `ksef243_purchase_*`, strażnicy, funkcja retencji; bez klucza obcego do rdzenia i do 229 |
| `ksef243_purchase_sync` | jeden wiersz na NIP nabywcy: włączone, oś dat, data początkowa, **punkt kontrolny** (JSON), dzierżawa przebiegu, ostatni przebieg, błąd, limit 429 |
| `ksef243_purchase_invoices` | nagłówek faktury i **plik FA(3) dokładnie jak w KSeF** (`bytea`); baza sama liczy SHA-256 (hex) i `invoiceHash` (base64) i porównuje; `UNIQUE(tenant, numer KSeF)` = klucz deduplikacji; status, numer w księgach, notatka, `retain_until`, `legal_hold` |
| `ksef243_purchase_rates` | sumy według stawek (grosze), tylko wstawianie |
| `ksef243_purchase_corrections` | odwołania KOR (`DaneFaKorygowanej`) i powiązanie z korygowaną fakturą, ustalane raz |
| `ksef243_purchase_rejects` | odrzucony plik **bez treści**: wpis z listy KSeF, kod, polski powód, próby, rozwiązanie |
| `ksef243_purchase_events` | dziennik: przebiegi, strony, odrzucenia, 429, statusy, paczki, purge; bez tokenów i treści plików |
| `server/ksef243-model.ts` | czyste reguły: retencja, następny przebieg, wejścia (zod), filtr listy (parametry), kursor, KOR, CSV, NIP-y podmiotu RODO |
| `server/ksef243.ts` | ustawienia, przebieg z dzierżawą, zapis strony, lista, szczegóły, plik, obieg, ponowne pobranie, paczka |
| `server/ksef243-jobs.ts` + gałąź w `server/worker.ts` | zadanie `ksef.purchase.fetch` |
| `server/ksef243-routes.ts` + 2 linie w `server/app.ts` | trasy `/api/ksef243/…` |
| `server/ksef243-rodo.ts` + 10 linii w `server/rodo228.ts` | eksport i rejestr anonimizacji |
| `web/ksef243.tsx`, `web/ksef243.css`, 3 linie w `web/main.tsx` | Dokumenty → „Faktury zakupowe (KSeF)” |

## Pobieranie (przebieg)

1. Odczyt: wiersz NIP, ustawienia 229 (sekret odszyfrowany tylko na czas przebiegu; 243 go nie zapisuje).
   Wyłączone → `disabled`; aktywny limit 429 → `rate_limited` bez żądania.
2. Transakcja: **dzierżawa** `lease_token` + `leased_until = teraz + 150 s`, tylko gdy wolna albo wygasła. Zajęta → `busy`.
3. Poza transakcją: `syncPurchaseInvoices` (punkt kontrolny → strona metadanych → pliki → zapis). Klient ma budżet
   90 s (`deadline`), a pętla kończy się po 75 % budżetu albo 20 stronach; reaper zadań resetuje „running” po 2 min.
4. Każda strona to **jedna transakcja**: sprawdzenie i przedłużenie dzierżawy (`WHERE lease_token=$ AND leased_until>now`),
   faktury `ON CONFLICT (tenant_id, ksef_number) DO NOTHING`, stawki, odwołania KOR i powiązania w obie strony,
   odrzucenia (upsert), rozwiązanie wcześniejszych odrzuceń, punkt kontrolny pod dokładną dzierżawą, zdarzenie.
   Inny proces z dzierżawą → `LeaseLost`, strona wycofana, punkt kontrolny nietknięty (`busy`).
5. Plik, którego tabela nie przyjmie (data spoza 1990–2099, za długa nazwa itd.), jest odrzuceniem tej faktury,
   nigdy nieudaną stroną (poprawka B1 z przeglądu).
6. Koniec: zwolnienie dzierżawy (tylko własnej), `last_ok_at`/`last_error`, `rate_limited_until`, zdarzenie,
   `ksef243_purchase_purge()`.

Wyniki: `ok`, `partial` (budżet), `rate_limited`, `unavailable`, `refused` (4xx, brak ustawień), `error`, `busy`, `disabled`.

### Zadanie `ksef.purchase.fetch`
Jedno oczekujące zadanie na NIP (sprawdzenie jak przy `ksef.status`). Po przebiegu zadanie samo kończy się `done`
i dodaje następne: `ok` → 30 min, `partial` → 5 s, `busy` → 60 s, `rate_limited` → Retry-After (min. 10 s),
`unavailable`/`refused`/`error` → 1, 2, 4… min (do 30 min). Błędy KSeF nigdy nie wywracają zadania, bo po
`max_attempts` łańcuch by stanął; ogólny retry `tick()` dostaje tylko nieoczekiwany błąd bazy. Usunięte ustawienia
(404) kończą łańcuch. Zapis ustawień z `enabled=true` dodaje zadanie, „Pobierz teraz” robi krótszy przebieg
(60 s, 10 stron) w żądaniu i dodaje zadanie, gdy przebieg nie skończył.

### Brak luk i duplikatów
Punkt kontrolny (model 26.10) zaczyna kolejną stronę od daty ostatniej faktury włącznie i pamięta numery z tej daty.
Jedynym postępem jest punkt kontrolny zapisany razem ze stroną, więc każda awaria (utracona strona, 5xx, crash,
przejęta dzierżawa) zostawia poprzedni stan i strona jest czytana ponownie; duplikaty łapie unikalny numer KSeF.

## Trasy

| Trasa | Kto |
|---|---|
| `GET /api/ksef243/status` | każda rola (`documents:read`) |
| `PUT /api/ksef243/sync/:nip` `{enabled, date_type, start_from, restart?}` | administrator, tylko sesja |
| `POST /api/ksef243/sync/:nip/run` | administrator, operator (`documents:write`) |
| `GET /api/ksef243/invoices?nip,seller,status,kind,from,to,q,limit,before` | każda rola |
| `GET /api/ksef243/invoices/:id`, `…/fa3.xml` | każda rola |
| `PATCH /api/ksef243/invoices/:id` `{version, status?, accounting_ref?, note?, legal_hold?}` | administrator, operator; cofnięcie zaksięgowania i wstrzymanie usunięcia: administrator |
| `GET /api/ksef243/rejects`, `POST …/rejects/:ksef/retry` | odczyt każda rola; ponowne pobranie admin/operator |
| `GET /api/ksef243/export.zip?filtry` | administrator, operator (`documents:write`); zapisuje zdarzenie `export` |

Bez 243: 503. Kopia tylko do odczytu: zapisy i paczka 423 (paczki nie da się odnotować). Inna firma: 404 (RLS).

## RODO i retencja
- **Retencja podatkowa:** `retain_until = 31.12.(rok wystawienia + 6)` (art. 112 VAT, art. 70 § 1 OP, art. 74 UoR;
  +6 obejmuje grudniową fakturę z terminem w styczniu). CHECK w tabeli pilnuje dolnej granicy; data może tylko rosnąć.
- **Purge:** `ksef243_purchase_purge()` (SECURITY DEFINER, tylko bieżąca firma) usuwa faktury po `retain_until` bez
  `legal_hold` (ze stawkami i odwołaniami), odrzucenia i zdarzenia starsze niż rok. Uruchamiane na końcu każdego
  przebiegu. Strażnik przepuszcza DELETE tylko z flagą purge **i** jako właściciel (poprawka N1).
- **Eksport (art. 15):** gdy NIP z danych do faktury karty CRM (`invoice_tax_id`) jest NIP-em sprzedawcy, ZIP RODO
  dostaje sekcję `faktury_zakupowe_ksef` (dane, bez plików).
- **Anonimizacja (art. 17):** te faktury idą do „Zostanie zachowane” z podstawą `tax_retention`, `retention_end =
  retain_until`, `due_on = retain_until + 1` i są usuwane przez purge, nie zmieniane.
- **Odrzucenia** trzymają wpis listy KSeF (nazwa i NIP sprzedawcy, bez pliku) najwyżej rok od ostatniego zobaczenia;
  nie są w eksporcie RODO (decyzja 7).
- Paczka dla księgowości to masowy eksport danych kontrahentów: tylko admin/operator, odnotowana w zdarzeniach.

## Decyzje odwracalne (wariant bezpieczniejszy)
1. Brak klucza obcego do `ksef229_configs`: ustawienia KSeF sprawdza aplikacja, katalog 229 się nie rusza.
2. Plik w `bytea` jawnie, z hashami liczonymi przez bazę (jak proponował dokument 26.10), zamiast szyfrowania.
   Strona zakupowa nie ma UPO (UPO dostaje wystawca); dowodem jest numer KSeF, `invoiceHash` i data trwałego zapisu.
3. Kwoty w groszach (`bigint`), nie `numeric(18,2)`.
4. Zmiana osi dat albo daty początkowej (albo `restart`) czyta od daty początkowej; duplikaty łapie numer KSeF.
5. Paczka „eksport” w UI = ZIP dla księgowości (CSV + FA(3)), limit 500 faktur / 64 MiB. Eksport KSeF
   (`/invoices/exports`, zaległości > 10 000) nie jest podłączony — otwarte.
6. Cofnięcie zaksięgowania, zmiana zaksięgowanej i `legal_hold`: tylko administrator.
7. Odrzucenia poza eksportem RODO; podstawą jest roczny purge.
8. Paczka 423 w kopii tylko do odczytu (jak eksport RODO).
9. Data spoza 1990–2099 w pliku = odrzucenie.

## Przegląd bezpieczeństwa (niezależny agent `security-reviewer`, klony `_21`–`_24`)
Werdykt: **BLOCK** za jedno: **B1** — plik z datą `0000-01-01` (parser ją przyjmował, Postgres nie) wywracał całą
stronę, punkt kontrolny stał, a dobre faktury z tej strony przepadały przy każdym przebiegu. Pozostałe sprawdzone bez
zarzutu: XXE/DTD/encje/PI/kodowanie/głębokość/3 MiB, limity odpowiedzi, wstrzyknięcia SQL i LIKE, RLS i izolacja,
dzierżawa, purge, role i scope, sekrety, nagłówki pobrań, CSV, UI bez HTML.

| Uwaga | Poprawka | Test |
|---|---|---|
| B1 (blokująca) | `unstorable()`: każda data pliku (wystawienie, sprzedaż, okres, termin, daty korygowanych) w 1990–2099, inaczej odrzucenie tej faktury | DB „a file whose date the table cannot hold…” |
| N1 | flaga purge działa tylko dla właściciela (`current_user='postgres'`) | DB: `dyna_app` z flagą nie zmienia powiązania |
| N2 | test „oryginał później” datowany względem teraz | DB test 2 |
| N3 | znak NUL w `q`/`seller` → 422 | model |
| N4 | wpis listy przy odrzuceniu w formie KSeF, teksty przycięte | model (round trip) |
| N6 | odrzucone ponowne pobranie zostawia ślad (rzut po commicie) | ścieżka kodu |

Bez zmian (opisane): N5 (odrzucenia poza RODO, decyzja 7), N7 (paczka do 64 MiB w pamięci, GET z wpisem zdarzenia).

### Ponowny przegląd (koordynator, po `ac3e361`)
B1, N1, N3, N4 i N6 potwierdzone. Nowa blokująca **M1**, ta sama klasa co B1: wpis listy KSeF odrzucony przez parser
metadanych (kwota 16 cyfr, czyli ≥ 1e15, albo nazwa i numer liczone w jednostkach UTF-16, np. 200 emoji w `P_2`, 300 emoji
w nazwie sprzedawcy) rzucał wyjątek dla całej strony, więc przebieg kończył się `error`, nic nie było zapisane, a punkt
kontrolny stał. Sondy na klonie `_37`: 63 z 64 przypadków zielone po poprawce, a `feb30` poprawiony osobno (niżej).

| Uwaga | Poprawka | Test |
|---|---|---|
| M1 | długości liczone w punktach kodowych (`P_2`, teksty listy, `unstorable`); kwota listy poza bezpiecznym zakresem → `null` (to tylko informacja, źródłem jest plik); inny zły wpis, który ma czytelny numer KSeF, skrót i datę przyjęcia, dostaje `problem` i staje się odrzuceniem tej faktury (bez pobierania pliku), a punkt kontrolny przechodzi dalej; wpis bez numeru, skrótu albo daty przyjęcia nadal odrzuca stronę; nieczytelna data wystawienia przyjmuje dzień przyjęcia | DB „a listing entry the parser refuses…”, model (wpisy listy, 200 znaków `P_2`) |
| a | NUL w notatce i numerze księgowym → 422 | DB workflow, model |
| b | odwołania KOR jednym `INSERT … unnest … WITH ORDINALITY`; zapis punktu kontrolnego sprawdza liczbę wierszy i przedłuża dzierżawę | ścieżka kodu, DB testy dzierżawy |
| c | 512/1000/256 znaków w `unstorable` liczone w punktach kodowych | model |
| d | wpis listy przy odrzuceniu bez NUL, teksty przycięte po punktach kodowych | model |

Zmiana kontraktu `parsePurchaseMetadata`: zła waluta albo zły rodzaj faktury nie odrzucają już strony, tylko oznaczają
wpis (test `ksef-purchase-model` zaktualizowany). „Pobierz ponownie” takiego wpisu odpowiada 409, bo wpis z listy KSeF
nadal jest nieprawidłowy. SQL się nie zmienił, więc kontrakt zimny zostaje bez zmian.
Dodatkowo notatka i numer księgowy z samotnym surogatem UTF-16 dostają 422.

Weryfikacja M1 (27.10.2026, wieczór):
- czerwono: model 9/11 (dwa nowe testy); sonda `poison.test.ts` przed poprawką: `error`, 0 z 3 zapisanych dla każdej
  z pięciu trucizn;
- zielono:
  - DB 16/16 na świeżym `_15` (bieg ok. 26 min, maszyna obciążona; budżet przebiegu w teście poszerzony do 300 s,
    bo każda transakcja strony płaci tu wstępne sprawdzenie strażników; przebieg `partial` jest tolerowany w pętli testu
    duplikatów);
  - sondy koordynatora: `poison.test.ts` 64/64 (61 na `_37`, a `feb30`, `currencyLower` i `nulRaw` na `_39`; na
    obciążonym `_38` dwa przypadki przekroczyły czas, bez związku z poprawką), `iso.test.ts` zielona na `_36`;
  - model 11/11, trasy 6/6, UI 3/3, statyczne 4/4, zgodność 6/6, klient i model zakupowy 16/16, run-bw 363/363,
    `tsc` czysto. Kontrakt zimny jest bez zmian, bo SQL się nie zmienił.

## Weryfikacja
Klony PG04 `dynaminds_m243_20261027_NN` szablonu `dynaminds_restore_36751abef3079f3f`, sesja `jit=off`, `timezone=UTC`.
- Czerwono (worktree HEAD `ce93efd` z samymi nowymi testami): 9/9 nie przechodzi — model, trasy, UI i zgodność nie ładują się
  (brak modułów), statyczne 0/4 (brak SQL i wiersza listy), ledger 232 ≠ 233.
- Kontrakt skompilowany na `_05` (`local-builds/…/ksef-purchase243-source-20261027-02`): 354 dodania
  (22 relacje, 134 kolumny, 128 ograniczeń, 16 indeksów, 6 polityk, 32 wyzwalacze w tym RI, 4 funkcje, 12 typów),
  0 zmian, 0 usunięć, poprzednik = skompilowany after242 `899b5d8b…`, jedenastu strażników `true` przed i po.
- Świeży `migrate()` 218→243 (`_07`): ledger 233 (`243_ksef_purchase`), dziesięciu strażników i
  `warehouse_wz_issuer_guards` `true`; zimna inspekcja `COLD_INSPECTION_PASSED`, 45 147 rekordów,
  `a962091c…` = skompilowany after243, `ksef_purchase243_active: true`.
- Zielono:
  - `tests/ksef243.test.ts` 15/15 na świeżym `_08` (ok. 14 min; każda transakcja zapisu płaci tu kilka sekund wstępnego
    sprawdzenia strażników), wcześniej na `_02`/`_06` znalazł trzy błędy testów i błąd zapisu wpisu odrzucenia (forma KSeF);
  - model 9/9, trasy 6/6, UI 3/3, statyczne 4/4, klient i model zakupowy 16/16, ledger 4/4;
  - lista i zgodność 760/760 (24 pominięte, opt-in), z prawdziwymi katalogami `before243`/`after243`;
  - run-bw 363/363; web 454/454; scale http-ports 43/43 po ponownym przypięciu `server/app.ts`;
    stock-writer 11/11 i credit208 5/5 bez zmian (pliki z list nietknięte); `npx tsc --noEmit -p .` czysto.
- Przeklikane (API 4243 + Vite `ksefp.localhost:5243`, klon `_07`, fake 127.0.0.1:4244), zrzuty w katalogu sesji
  `m243/shots`: wyłączone → ustawienia admina → włączone → „Pobierz teraz” (11 nowych, 1 odrzucona) → lista z KOR/MPP
  → szczegóły korekty z łańcuchem → zaksięgowana z numerem → odrzucone pliki → viewer bez przycisków (375 px, bez
  przewijania strony w poziomie).

## Pytania do sandboxa MF (otwarte, bez zmian względem 26.10)
1–10 z [KSEF-PURCHASE-20261026](KSEF-PURCHASE-20261026.md#sandbox-questions-to-confirm-against-the-mf-test-environment-and-openapi):
stronicowanie i limit `isTruncated`, stabilność kolejności w tej samej dacie, HWM, nazwy pól metadanych, bajty pobrania,
eksport, limity zapytań, uprawnienie tokenu (`InvoiceRead`), Subject3/SubjectAuthorized, odwołania korekt offline.
Dochodzą: 11) zakres dat dopuszczany przez XSD FA(3) (B1 zakłada 1990–2099); 12) czy pobieranie tym samym tokenem
co wysyłka nie narusza limitów sesji 229.

## Otwarte
- Eksport KSeF (`ksef.purchase.export`) dla zaległości i okien > 10 000 faktur.
- JPK_V7 strona zakupowa (`K_40`–`K_47`, `NrKSeF`) — właściciel `server/jpk-*`.
- `ksef243_available` w `/api/health`.
