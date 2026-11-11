# Wydajność eksportów finansowych na wydaniu — 27.10.2026

Etap 3, punkt otwarty: JPK w trybie źródłowym trwał 42–53 s dla 3 dokumentów, FA(3) i raport rozliczeń
ok. 12 s (PG04). Kryterium: pomiar na spakowanym **wydaniu** (bez kontroli schematu przed każdą
transakcją). Jeśli eksport miesiąca trwa > 60 s albo liczy O(n) transakcji tam, gdzie wystarczy jedna,
zmiana na odczyt w jednej transakcji tylko do odczytu, z identycznym wynikiem.

Wynik: JPK_V7M/V7K/JPK_FA przekraczały próg (181–205 s, 7703 transakcje na miesiąc) i po zmianie
trwają ok. 1 s w 3 transakcjach. Pliki przed i po zmianie są bajt w bajt takie same. Raport rozliczeń, FA(3)
i KSeF mieszczą się w progu i nie są zmieniane. Migracja niepotrzebna.

## Środowisko

| | |
|---|---|
| Wydanie „przed” | `scale-release-20261027-fin-01`, commit `8b2b9d9`, manifest `ad687d7d…01df`, pakiet `2df179ed…bbe1` |
| Wydanie „po” | `scale-release-20261027-fin-02`, commit `bbbe4e1` (= `8b2b9d9` + zmiana), z `tools/scale/release-build.mjs` |
| Uruchomienie | fabryka wydania (`createOrdinaryLocalApplication`: prawdziwy `migrate()`, walidacja na zimno, bramka schematu) i jego chunki, jak w `tools/scale/release-runtime.mjs`; trasy przez `app.inject` z prawdziwym ciasteczkiem sesji (`loginWorkspace`) |
| Baza | PG04 (`127.0.0.1:57084`, natywny proces, więc warunek pętli zwrotnej wydania jest spełniony bez `netns-node`), klon `dynaminds_fin_20261027_04` z `dynaminds_restore_36751abef3079f3f`, migracje do 241 przez fabrykę |
| Atrapy | lokalna drukarka fiskalna 233 i lokalny KSeF 229 na pętli zwrotnej (`server/receipt233-fake-printer.ts`, `server/ksef229-fake.ts`); żadnego połączenia z MF ani KSeF |
| Liczenie transakcji | zdarzenia `acquire` puli wydania: każdy `tenantTx`, `tenantReadTx` i `pool.query` pożycza jednego klienta. W 3 transakcjach JPK „po” mieści się odczyt sesji, autoryzacja administratora finansów i jedna migawka |

PG04 był w czasie pomiarów współdzielony z innymi agentami (średnie obciążenie 9–16). Czasy są więc górną
granicą. Liczby transakcji od obciążenia nie zależą.

Skrypty pomiaru (poza repozytorium, w katalogu sesji `scratchpad/fin/`): `seed.mjs` i `finish.mjs` (dane
przez wydanie), `measure.mjs` (pomiar), `fin-rt.mjs` (fabryka wydania i licznik), `fakes.mts` (atrapy).

## Dane: jedna firma, październik 2026

Nowa organizacja (rejestracja przez `/api/auth/signup`, plan enterprise, seria `F…`, drukarka 233, KSeF
`local_fake`). Wszystkie dane powstały przez kod wydania: zamówienia przez funkcje domeny w `tenantTx`, jak w
`tools/scale/writer.mjs` (1–3 pozycje po 23/8/5/0%, ilości 1–3, połowa z wysyłką 15 zł, opłacone,
skompletowane, wysłane), a dokumenty przez zwykłe trasy i funkcje modułów.

| Rodzaj | Liczba |
|---|---|
| FV 157 (konsument, `issueLocalInvoiceWithTax`) | 900 |
| FV-S 230: konsument / B2B (NIP, czynny podatnik) | 450 / 100 |
| KOR-S 232: anulowanie / zwrot (przyjęty zwrot, zwrot pieniędzy) | 100 / 100 |
| Paragony 233 w 5 dniach fiskalnych (20–24.10), raporty dobowe → wiersze RO | 250 / 5 |
| FV-S do paragonu (FP) | 50 |
| **Dokumenty w JPK** (FV, FV-S, KOR-S, FP) | **1700** (+5 RO = 1705 wierszy V7) |
| Zamówienia w raporcie rozliczeń | 1700 |
| Po pomiarze KSeF: dokumenty z numerem KSeF | 150 |

Daty wystawienia i sprzedaży dokumentów to 27.10.2026, bo wydanie wystawia z bieżącą datą. Okres JPK jest
miesięczny, więc rozkład dni w miesiącu nie zmienia kosztu. Odstępstwo przy zasilaniu danych: raport dobowy z
20.10 zapisano wierszem SQL o takich samych sumach jak paragony aplikacji, dokładnie jak robi to
`storeDailyReportInTx`. Wspólna atrapa drukarki wydrukowała go już wcześniej dla firmy testowej. Raporty
21–24.10 przeszły zwykłą trasą.

Z modułów JPK w danych brakuje KOR 188 i 206/207. Wymagają ścisłej kontroli magazynu (dokument przyjęcia 169)
albo asystenta zwrotów 206, których ta firma nie ma. Oba moduły są czytane w tej samej migawce i ich
równość bajtowa jest sprawdzona w teście bazodanowym na wierszach szablonu (niżej).

## Pomiary

| Eksport | Przed: czas | Przed: transakcje | Po: czas | Po: transakcje | Plik |
|---|---|---|---|---|---|
| JPK_V7M 2026-10 (`/api/jpk/v7m.xml`) | **181,5 s** (199,1 s po KSeF) | 7703 (4,5 na dokument) | **1,0 s** (1,4 s w 1. przebiegu) | **3** | 1705 wierszy, 556 kB, identyczny |
| JPK_V7K 2026-10 | 200,0 s (196,6 s po KSeF) | 7703 | 1,1 s | 3 | identyczny |
| JPK_FA 01–31.10 | 205,3 s (189,6 s po KSeF) | 7703 | 1,05 s | 3 | 1700 faktur, 1,9 MB, identyczny |
| Raport rozliczeń JSON (`/api/settlement-report`) | 0,18–0,23 s | 3 | 0,06 s | 3 | 1700 zamówień, identyczny (bez `generated_at`) |
| Raport rozliczeń CSV (`/file`) | 0,05 s | 3 | 0,04 s | 3 | identyczny |
| FA(3) XML × 1700 (`/api/fa3/documents/:id/fa3.xml`, kolejno) | 193–229 s; p50 112–126 ms, **p95 122–160 ms**, max 2,6 s | 5,53 na dokument | 219 s; p50 115 ms, p95 165 ms | 5,53 | sha256 wszystkich 1700 odpowiedzi identyczny |
| KSeF online × 100 (`POST /api/ksef229/documents/:id/send`) | 75,4 s; p50 707 ms, **p95 976 ms** | 11 na dokument | bez zmiany | | 100 przyjętych |
| KSeF „Kolejka → Wyślij wszystkie”, 50 offline (`POST /api/ksef229/queue/send`) | 27,1 s (542 ms na dokument) | 252 (~5 na dokument) | bez zmiany | | 50 przyjętych |

Uwagi:
- „Po KSeF”: drugi pomiar wydania „przed” po wysłaniu 150 faktur do KSeF. Ich wiersze V7 mają wtedy `NrKSeF`
  zamiast `BFK`, więc pliki V7 porównano z tym drugim pomiarem. JPK_FA numerów KSeF nie zawiera i jest równy
  także pierwszemu pomiarowi.
- Bajty porównano po zastąpieniu `DataWytworzeniaJPK` (czas wygenerowania) w JPK i `generated_at` w raporcie
  JSON. Każdy przebieg tej samej wersji dawał ten sam sha256. sha256 „po” = sha256 „przed”: V7M
  `9c54733b…fc7a`, V7K `d1e97b9d…7a04`, FA `b83b847b…8944`, JSON `ea87e85a…94ca8`, CSV `391074f7…74ab7`,
  FA(3) ×1700 `f7b2ca0c…462b`.
- Ekstrapolacja „przed”: koszt rośnie liniowo (ok. 105 ms i 4,5 transakcji na dokument). Próg 60 s przekracza
  już miesiąc z ok. 550 dokumentami.

## Co zmieniono i dlaczego tylko JPK

**JPK (zmienione).** `loadJpkDocuments` (`server/jpk-source.ts`) czytał każdy dokument natywnym odczytem
modułu, czyli osobnymi transakcjami: szczegóły, migawka 226 i kurs 227, numer KSeF. Teraz listę, raporty
dobowe 233 i fakty FA(3) wszystkich dokumentów 157/230/232/188/206 czyta jedna transakcja `tenantReadTx`
(REPEATABLE READ, READ ONLY, rola `dyna_app`, RLS) w `server/fa3-document-batch.ts`:
- Te same odczyty i kontrole spójności co natywne szczegóły: 157 `documentView` (dokument równy swojemu
  niezmiennemu pokwitowaniu), 230 `invoice230DocumentInTx` i powiązanie z paragonem 233, 232
  `invoice232DocumentInTx`, 188/206 wiersz rejestru równy pokwitowaniu i hash wyliczenia, 226/227/229 jak w
  `fa3DocumentFacts`. Moduły 157, 188 i 206 mają przypięte sha256 w innych testach, więc ich kontrole są
  skopiowane, a nie eksportowane, tak jak wcześniej w `tax226-local-invoices.ts`.
- **Tożsamość żądania raz na migawkę.** Sprawdzane są sesja lub klucz, MFA, rola i uprawnienie FV: `frame()`
  z `base-wire-invoices-runtime.ts`, czyli `local_invoice_identity(..., pin=false)` i `local_invoice_access`.
  Natywny odczyt brał przy każdym dokumencie blokadę FOR SHARE wierszy tożsamości (`pin=true`), a
  transakcja READ ONLY takiej blokady nie przyjmuje. W jednej migawce REPEATABLE READ nie jest też potrzebna,
  bo wszystkie dokumenty widzą ten sam stan tożsamości. Kontrola modułów 188/206
  (`local_consumer_credit_require` / `return_credit206_require`, `pin=false`) idzie raz, jako właściciel, jak
  w ich `owner()`. Pierwszy błąd wygrywa i jest mapowany jak w ich `mapped()`, więc zepsuty strażnik daje 503,
  nie 500 (uwaga z przeglądu kodu).
- Odmowy i błędy są zapisywane i odtwarzane w kolejności listy, więc lista 409 i zasada „pierwszy rzucony
  błąd przerywa plik” się nie zmieniają.
- Faktury B2B 159/160 (zarządzany odczyt `managed()`) zostają przy natywnym odczycie dokument po dokumencie.
- Różnica tylko w tekście błędu, nie w kodzie odpowiedzi: przy odmowie tożsamości (np. brak MFA) plik JPK
  zwraca komunikat `nativeProblem` („Brak dostępu do FV”, 403), a nie komunikat bazy dla pierwszego
  dokumentu.

**Raport rozliczeń (bez zmian).** Od początku jest jedną migawką `tenantReadTx` z autoryzacją. Tryb
źródłowy (~12 s) płacił tylko za kontrolę schematu przed `tenantTx` autoryzacji.

**FA(3) XML (bez zmian).** Jedno żądanie na dokument, stała liczba transakcji (5,5), p95 122–165 ms. Trasy
zbiorczej nie ma. 1700 plików jedno po drugim to 193–229 s, ale to 1700 osobnych żądań, nie jeden eksport.
Jeśli potrzebny będzie eksport zbiorczy (np. ZIP miesiąca), ma czytać przez `fa3DocumentFactsBatchInTx`.

**KSeF (bez zmian).** Wysyłka to zapis: dzierżawa, sesja, znacznik wysyłki, potwierdzenie i UPO w osobnych
transakcjach z ogrodzeniem dzierżawy (`docs/parity/KSEF229-20261023.md`). Nie da się jej zamknąć w jednej
transakcji tylko do odczytu. Czas zależy od opóźnień API KSeF (atrapa: kilka zapytań stanu na dokument).

## Testy

- `tests/fa3-document-batch.test.ts` (5, bez bazy):
  - ramka tożsamości: sesja, klucz API, obca tożsamość i brak poświadczenia dają 401;
  - zbiór trybów objętych migawką;
  - odtwarzanie w kolejności listy: 409 z listą, Problem przerywa plik na swojej pozycji, odczyt natywny tylko dla B2B;
  - kontrola modułów 188/206: rola przywrócona, zepsuty strażnik zwraca swój kod (503/401/403/409), a nie 25P02 przerwanej transakcji.
- `tests/jpk-batch.database.test.ts` (2, świeże klony PG04 `dynaminds_fin_20261027_NN`):
  - Ładowanie po staremu (odtworzone w teście dokładnie jak przed zmianą) i po nowemu przez prawdziwe trasy z autoryzacją administratora finansów i stałym czasem dają te same bajty V7M, V7K i JPK_FA.
  - Pokrycie: 4 organizacje. W szablonie: FV 157 + KOR 188 + KOR 206/207, KOR 206/207, B2B 159. Dodatkowo firma zasilona w teście: FV-S konsument i B2B wysłana do atrapy KSeF (wiersz z `NrKSeF`), KOR-S, paragon z raportem dobowym (RO) i FV-S do paragonu (FP).
  - Transakcje na wczytanie pliku: 19 → 1, 13 → 1, 26 → 1; B2B 3 → 3.
  - Odmowy: nieznana sesja i podrobiona tożsamość dają 401, zanim cokolwiek zostanie przeczytane.
  - RED na `8b2b9d9` (klon 02): „19 !== 1”. GREEN na klonach 05 i 06 (06 na zatwierdzonym `bbbe4e1`): 2/2.
- Bez zmian zielone: `tests/jpk.test.ts`, `tests/jpk-routes.test.ts`, `tests/jpk-receipts.test.ts`,
  `tests/fa3-documents.test.ts` (38 pass, 6 pominiętych testów XSD jak wcześniej), `run-bw` 358/358,
  `npx tsc --noEmit -p .` bez błędów.
