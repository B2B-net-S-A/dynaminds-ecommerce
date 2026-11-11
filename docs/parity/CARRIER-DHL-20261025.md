# DHL Parcel Polska (WebAPI2 / DHL24): klient przewoźnika — L3, podłączony do aplikacji (26.10.2026)

Data: 2026-10-25. Tor L3 z `docs/parity/INTEGRATIONS-WAVE1-GAP-20261025.md` (sekcja „DHL Parcel Polska (WebAPI2) — nowy w scope v6”).

Od 26.10.2026 klient jest podpięty do bazy (migracja 234), tras, workera, trackingu i UI (sekcja „Podłączenie” niżej). Kod nie wykonuje żadnych prawdziwych połączeń sieciowych poza skonfigurowanym połączeniem: transport podaje wywołujący. W testach jest to fake z `server/carrier-dhl-fake.ts` albo odtwarzacz fixture'ów.
Fixture'y i odpowiedzi fake'a są **syntetyczne**. Napisałem je ręcznie na podstawie publicznej dokumentacji DHL24 WebAPI2, nie nagrałem ich z DHL. Każdy plik w `tests/fixtures/dhl/` ma taki komentarz.

## Pliki

| Plik | Rola |
|---|---|
| `server/carrier-dhl-xml.ts` | Koperta SOAP 1.1, escapowanie, bezpieczny parser (bez DTD, bez PI, limity rozmiaru i głębokości), odczyt Fault |
| `server/carrier-dhl-values.ts` | Schemat wejścia `dhlInput` (te same klucze co `dpdInput`), walidacja kodu, wagi, COD i NRB, okno odbioru, czas zdarzeń w strefie Europe/Warsaw, mapa statusów, `dhlPdf`, `dhlConnection`, `dhlReference` |
| `server/carrier-dhl.ts` | Klasa `Dhl(mode, settings, credentials, transport, options)`: ten sam kształt co `Dpd` w `server/integrations.ts:650`, mapowanie błędów, ponowienia, idempotencja |
| `server/carrier-dhl-fake.ts` | Stanowy fake WebAPI2 (createShipments, getLabels, getTrackAndTraceInfo, bookCourier, cancelCourierBooking, getNearestServicepoints, getPostalCodeServices, getMyShipments) z wstrzykiwaniem awarii |
| `tests/carrier-dhl*.test.ts` | 34 testy: `carrier-dhl` 20, `carrier-dhl-values` 9, `carrier-dhl-xml` 5 |
| `tests/fixtures/dhl/` | Syntetyczne odpowiedzi SOAP, ataki XXE i „billion laughs”, wspólne dane wejściowe |

## Operacje scope v6 → WebAPI2 → kod

| Operacja (`integration.dhl.*`) | Metoda WebAPI2 | Metoda klienta | Ponawianie | Testy |
|---|---|---|---|---|
| `connection` | `getPostalCodeServices` (odczyt z authData) | `test()`, `postcodeServices()` | tak (odczyt) | konfiguracja, połączenie, błąd autoryzacji |
| `shipment.create` | `createShipments` | `create(input, idempotencyKey)` | **nie** | payload, walidacja, duplikat, utrata ACK, odrzucenie |
| `cod` | `createShipments.service.collectOnDelivery*` | `create()` → `cod {amount, currency, bank_account}` | **nie** | COD, limity, NRB |
| `label.pdf` | `getLabels` (LP, BLP, LBLP PDF; ZBLP ZPL) | `labels(waybill, type)` | tak (odczyt istniejącej) | bajty PDF, ZPL, obcy numer, nie-PDF |
| `tracking.read` | `getTrackAndTraceInfo` | `tracking(shipment)`, `events()` | tak | normalizacja, obcy numer, scalanie historii |
| `pickup.book` | `bookCourier`, `cancelCourierBooking`, `getPostalCodeServices` | `bookPickup(b, key)`, `cancelPickup(id)` | **nie** (rezerwacja i anulowanie) | okno, godziny dla kodu, duplikat, utrata ACK, anulowanie |
| `points.search` | `getNearestServicepoints` | `points({postcode, city, radius})` | tak | POP i Parcelshop, zła kwerenda |
| (uzgodnienie) | `getMyShipments` | `findByReference(ref, date)` | tak | utrata ACK |

## Zachowanie

- **Interfejs jak przy DPD.** Konstruktor przyjmuje `(mode, settings, credentials, transport)`. Ustawienia: `sap_account`, opcjonalnie `endpoint`. Dane logowania: `username`, `password`. Wynik `tracking()` ma te same klucze co `DpdInfo.tracking()` (`server/dpd-info.ts:253`) plus `received_by`, więc `server/tracking.ts` zapisze go bez `normalizeTracking`, jak DPD. `labels()` zwraca `{waybill, label_base64, trace_id}`, tak jak `verifiedDpdLabel`. `dhlConnection(ch)` liczy ten sam skrót co `dpdConnection`.
- **Środowiska.** Sandbox: `https://sandbox.dhl24.com.pl/webapi2`. Produkcja: `https://dhl24.com.pl/webapi2`. Nadpisanie `endpoint` przyjmuje tylko HTTPS na `*.dhl24.com.pl` i musi zgadzać się z trybem: host `sandbox.` tylko w trybie sandbox. Przekierowanie (3xx) jest odrzucane (`DHL_REDIRECT`), a do transportu idzie `redirect: 'error'`.
- **XML.** Koperta jest budowana z drzewa wartości: każda wartość jest escapowana, a znaki sterujące C0 są odrzucane (422). Parser odrzuca DOCTYPE, więc nie ma deklaracji encji ani encji zewnętrznych (XXE, billion laughs). Odrzuca też instrukcje przetwarzania, drugi korzeń, głębokość ponad 24 i odpowiedź ponad 8 MB. Envelope, Body i Response sprawdza ściśle po namespace. Dzieci odpowiedzi dopasowuje po nazwie lokalnej (patrz pytania).
- **Błędy.** Kategoria SOAP Fault jest rozpoznawana po kodzie i tekście, a do użytkownika trafia polski komunikat bez tekstu dostawcy. `Problem.code` ma postać `RODZAJ:kodFault`. Rodzaje:
  - `DHL_AUTH` (401),
  - `DHL_FORBIDDEN` (403),
  - `DHL_VALIDATION` (422: kod pocztowy, waga, pobranie, ubezpieczenie, termin odbioru, ogólne),
  - `DHL_NOT_FOUND` (404),
  - `DHL_RATE_LIMIT` (429),
  - `DHL_FAULT` (502).

  Transport zgłasza: `DHL_TIMEOUT`, `DHL_UNCERTAIN` (504), `DHL_UNAVAILABLE`, `DHL_INVALID_RESPONSE` (502).
- **Ponowienia** dotyczą tylko odczytów: 3 próby przy 429, 502, 503 i 504, przekroczeniu czasu i błędzie sieci. Backoff wynosi 250 i 500 ms albo tyle, ile każe `Retry-After` (do 5 s). `createShipments`, `bookCourier` i `cancelCourierBooking` mają jedną próbę. Brak odpowiedzi, 5xx albo nieczytelna odpowiedź 500 po wysłaniu zapisu daje `DHL_UNCERTAIN`.
- **Idempotencja.** Wywołujący podaje klucz. `dhlReference(key)` daje `DY` + 20 znaków hex SHA-256 i ta wartość trafia do pola `reference` przesyłki. Przed wywołaniem sieci klucz jest zajmowany w `DhlIdempotencyStore`. Skrót obejmuje znormalizowane wejście i numer SAP. Możliwe przypadki:
  - zakończony z tym samym skrótem → zwracany jest zapisany wynik (`replayed: true`), bez wywołania sieci,
  - inny skrót → 409,
  - stan niepewny → **bez ponownego createShipments**. Klient czyta `getMyShipments` (dzień przesyłki ±1) i szuka po `reference`. Jedna przesyłka oznacza zakończenie. Brak albo kilka daje 409 z prośbą o sprawdzenie w panelu DHL24,
  - jednoznaczne odrzucenie (Fault, 4xx) zwalnia klucz, więc poprawione dane można wysłać z tym samym kluczem.

  Zamówienie kuriera działa tak samo, ale stanu niepewnego nie uzgadnia automatycznie (409). Domyślny magazyn kluczy żyje w pamięci (`memoryDhlStore`). Przy podpięciu zastąpi go wiersz planu (patrz niżej).
- **Walidacja przed siecią:**
  - kod `00-000` lub `00000` (do DHL idzie 5 cyfr),
  - waga 0,01–31,5 kg co 0,01; do DHL idzie zaokrąglona w górę do pełnych kg,
  - wymiary 1–175 cm; `nonStandard`, gdy długość > 120 lub szerokość/wysokość > 60,
  - treść 2–30 znaków,
  - COD w groszach do 11 000 PLN, wymaga poprawnego NRB (mod 97) i ubezpieczenia ≥ COD,
  - ubezpieczenie do 50 000 PLN,
  - ulica z numerem domu, rozbijana na `street`/`houseNumber`/`apartmentNumber`.
- **Okno odbioru:**
  - w przyszłości i najpóźniej za 14 dni (czas polski),
  - od poniedziałku do piątku; sobota tylko, gdy `getPostalCodeServices.pickupOnSaturday`,
  - co najmniej 120 minut,
  - w godzinach `drPickupFrom`–`drPickupTo` dla podanego kodu nadawcy,
  - od 1 do 200 różnych przesyłek.
- **Tracking.** Czas lokalny DHL jest przeliczany ze strefy Europe/Warsaw: luka wiosenna jest odrzucana, przy jesiennym nakładaniu brana jest późniejsza chwila. Odpowiedź z innym `shipmentId` jest odrzucana, więc obcy numer nie zmienia lokalnej przesyłki. Nieznane kody zostają w historii ze `status: null` i nie zmieniają statusu. Historia scala się z poprzednim `tracking_data`.
- **Etykieta.** Dla PDF sprawdzany jest kanoniczny base64, nagłówek `%PDF-` i rozmiar do 4 MB. Dla ZPL: `^XA` i rozmiar do 1 MB. Jeśli w odpowiedzi jest dokładnie jedna pozycja z innym numerem, jest odrzucana.

## Podłączenie (26.10.2026, migracja 234)

### Wspólne podłączenie (migracja 234, L3 krok 0)

- **Migracja `server/234_carriers.sql`** (17 379 B, sha256 `5a2c9ea6…`; wiersz w `migration-manifest.mjs`, para zimnego katalogu `carriers234-source-*.mjs`):
  - `order_shipments_guard()` (ostatnio ze 134) zastąpiona przez `CREATE OR REPLACE` (wyzwalacz i jego OID zostają): plan w locie przyjmuje przesyłkę z planu `dhl` (`shipping.dhl`, przewoźnik `DHL Parcel Polska`) albo `pocztapolska` (`shipping.pocztapolska`, `Poczta Polska`) tak jak DPD: przykład lokalny z numerem `DEMO-DHL-…`/`DEMO-PP-…` w `create_started`, inaczej `numbers_ready` i `external_id = tracking_number = plan.remote_id`. Gałęzie InPost i DPD bez zmian.
  - `shopify_capture_dispatch()` (ostatnio ze 108): odbiorca DHL/Poczty z `input.receiver` planu (punkt odbioru Poczty nie dowodzi adresu); jako InPost czytany jest tylko plan bez dostawcy albo z `inpost`.
  - Własna tabela `dhl234_pickups` (zlecenia kuriera DHL; fazy `ready → book_started → booked | rejected`, `cancel_started → cancelled`; trwałe dane zatwierdzenia, bez DELETE/TRUNCATE).
  - **Nie zmieniono 131 (cache etykiet) ani źródeł wydruku.** Zmiana `print_label_assets_source_kind_check` (dopisanie `dhl_cached`/`pocztapolska_cached`) psuje trzech strażników: `ordinary187_valid`, `large_import173_valid`, `pim_dictionary_valid` — definicja tego CHECK jest przypięta w certyfikacie `wave_print177_certificate` (`packed_metadata`, `metadata_after`). Sprawdzone próbą w wycofanej transakcji na klonie `dynaminds_l3_20261026_01`. Dlatego etykiety DHL/Poczty są zapisywane z planem (`shipping_plans.result.label_base64`) i serwowane trasą `GET /api/shipments/:id/label` bez wywołania dostawcy; druk przez kolejkę drukarek (`print_label_assets`) dla tych przewoźników nie działa.
- **Kod:** `server/carrier-shipping.ts` (wspólna maszyna planu na wzór `dpd-shipping.ts`: podgląd, kolejka, zadanie pod blokadą zamówienia, przyjęcie przesyłki, wydanie; lekka bramka dzierżawy i konta przed każdym żądaniem do dostawcy), `server/dhl-shipping.ts`, `server/pocztapolska-shipping.ts`, `server/dhl-pickups.ts`; `worker.ts`: `shipping.dhl`, `shipping.pocztapolska`, `dhl.pickup` (z wygasaniem dzierżawy zleceń DHL); `integrations.ts`: wpisy rejestru i `connector()`; `app.ts`: dostawcy w `POST /api/integrations`, walidacja `sap_account`/`urzad_nadania` i loginów, trasa etykiety; tracking (`tracking-connection.ts`, `tracking.ts`, `tracking-routes.ts`); egress (`ordinary-connector-policy.ts`, `ordinary-connector-routing.ts`: stałe adresy, tylko POST, operacja SOAP z treści równa SOAPAction, zapisy tylko z dostępem `write`, Śledzenie tylko dla `live`); Base wire (`COURIER_NAMES`, kurierzy asynchroniczni, etykieta z planu).
- **Siedem miejsc „nie-DPD = InPost”** nazywa teraz InPost wprost: kolejka/zakup/odświeżenie/anulowanie/uzgodnienie planu w `shipping.ts`/`shipping-routes.ts`, źródło etykiety, `packing-shipping-binding.ts`, `b2b-dropship-guards.ts`, `base-wire-fulfillment*.ts`, panel InPost (`web/shipping.tsx`) i nazwa w `web/tracking.tsx`.
- **UI:** karta zamówienia „Wysyłka DHL Parcel” / „Wysyłka Poczta Polska” (`web/carrier-shipping.tsx`), Integracje: pola połączenia, automatyczny tracking, „Odbiór kurierem DHL” (`web/dhl-pickups.tsx`).
- **COD:** `shipments.cod_expected` = kwota pobrania (należność zamówienia, `fulfillmentPayment`); rachunek NRB zostaje w `shipping_plans.result.cod` do uzgodnienia wpływu w payment-imports.

### DHL w szczegółach

- Plan: `input` = zwalidowane `dhlInput` (+ `packing`), `payload` = `{reference: dhlReference(plan.id), shipment}`. Klucz idempotencji = id planu; `DhlIdempotencyStore` to wiersz planu (`Dhl.withStore`): `ready` → `create_started` przed `createShipments`, sukces → `numbers_ready` + `remote_id`, jednoznaczne odrzucenie → `rejected` (plan do anulowania), niepewny wynik → ponowienie zadania uzgadnia po referencji (`getMyShipments`), nigdy drugie `createShipments`.
- Etykieta `BLP` (PDF) pobierana raz przy utworzeniu i zapisana w planie; trasa etykiety jej nie pobiera ponownie.
- Tracking: `new Dhl(...).tracking()` bez normalizacji (kształt `DpdInfo`); sandbox i live (DHL24 ma własny sandbox), wymaga loginu i hasła. Polityka i konto sprawdzane raz przed odczytem i ponownie w transakcji zapisu (żądanie ma własny limit czasu klienta).
- Zlecenie kuriera: `POST /api/integrations/:id/dhl-pickups/preview` (klucz klienta, przesyłki DHL z etykietą i nieprzekazane, okno), `/api/dhl-pickups/:id/queue` (potwierdzenie), `/api/dhl-pickups/:id/cancel`; zadanie `dhl.pickup`; magazyn idempotencji `bookPickup` = wiersz `dhl234_pickups`; niepewny wynik → `uncertain` (sprawdzenie w DHL24).

### Co zostaje

- Druk etykiety DHL przez kolejkę drukarek (`print_label_assets` / cache 131) — zablokowane przypięciem 177 (wyżej); wymaga osobnej decyzji o ponownym certyfikowaniu 177.
- ~~`points.search`~~ — trasa `GET /api/integrations/:id/dhl-points` i wyszukiwarka w panelu DHL zrobione 28.10.2026 na fake ([CARRIER-DPD-INPOST-L3-20261028.md](CARRIER-DPD-INPOST-L3-20261028.md)); zostaje doręczenie do punktu w `createShipments` (pytanie 10).
- Ręczne uruchamianie zadań w zwykłym runtime (`ordinary-connector-jobs.ts`) obejmuje dziś tylko InPost/DPD/Allegro; DHL tam nie dodano.
- Pozycja przewoźnika w stanowisku pakowania (`web/packing-workstation.tsx`, nasiona paczki tylko InPost/DPD).
- Wszystko z sekcji pytań niżej (kontrakt WSDL, kody statusów, COD per przesyłka) — konto sandbox DHL24.

### Weryfikacja (26.10.2026)

- Strażnicy (9 + `local_invoice_guards`, oraz `order_shipments_guards`, `label_cache_guards`, `label_print_guards`) prawdziwi przed i po 234: w transakcji na `_01`, przy kompilacji na `_41`, po realnym `migrate()` 218–234 na `_02`–`_07`, przed i po teście bazodanowym.
- Skompilowana odwrotność 234→233 na własnym klonie `dynaminds_l3_20261026_41`: 92 dodania (7 relacji, 31 kolumn, 33 ograniczenia, 6 indeksów, 1 polityka, 2 funkcje, 10 wyzwalaczy w tym RI kluczy obcych na `channels` i `users`, 2 typy), 2 zmiany (`order_shipments_guard()`, `shopify_capture_dispatch()`), 0 usunięć; poprzednik = skompilowany after233 `cde32ce2…`, after234 `00c125e6…`. Dokładna odwrotność prawdziwych katalogów sprawdzona (`tests/carriers234-source-compatibility.test.mjs` 6/6 z katalogami opt-in).
- Prawdziwa zimna inspekcja PASSED: `_41` i `_03` (44 350 rekordów, `carriers234_active` true), `_01` (tylko 233, 44 258, 234 nieaktywna). Krok właściciela zwykłego runtime na `_03` PASSED (`00c125e6…`). Katalog 67 667 800 z 134 217 728 B; zapas **66 549 928 B** (−45 395 B wobec 233).
- `node --test tests/release-migrations-*.test.mjs tests/source-ddl-migration-plan.test.mjs` 177/177; zimne zestawy (98 plików) 950 testów, 938 pass, 0 fail, 12 skipped; `scratchpad/run-bw.sh` 318/318; `npx tsc --noEmit -p .` czysto; testy klientów i polityki egress 79/79; `tests/failure-job-kinds.test.ts` 6/6; testy web 446/447 (jedyny błąd `product-catalogs-refresh` czyta plik z innego worktree, niezależny).
- **Test bazodanowy** `tests/carriers234.database.test.ts` na świeżym klonie `dynaminds_l3_20261026_06` (realne `migrate()` 218–234, prawdziwe trasy `buildApp`, procesory zadań, tylko lokalne fake): **7/7** — kanały i test połączenia, przesyłka DHL z COD → zapisana etykieta PDF (bez ponownego wywołania dostawcy) → tracking → wydanie; utracona odpowiedź `createShipments` → ponowienie uzgadnia przez `getMyShipments` (jedno utworzenie); Poczta Polska z COD → utracona odpowiedź `addShipment` → odczyt bufora po guid (jedno utworzenie) → etykieta → tracking → wydanie; przykład lokalny bez HTTP; zlecenie i anulowanie kuriera DHL, druga rezerwacja tej samej paczki odrzucona; guard SQL odrzuca przesyłkę DHL bez działającego zadania planu; trasy InPost odrzucają plan DHL.
- **Przeglądarka** na `_03` (API 4341 z fake jako jedynym transportem, Vite 5341, osobny `cacheDir`, proxy bez `Origin`; serwery zatrzymane): formularz połączenia DHL, podgląd i utworzenie przesyłki DHL z COD (numer 90000000001, etykieta PDF), tracking „W doręczeniu”, przesyłka Poczty Polskiej (FAKEPP0000000001, COD 40,99 zł) z trackingiem i wydaniem, zlecenie kuriera DHL (K700002). Zrzuty `scratchpad/l3-shots/01…11`. Znalezione i poprawione: pola SAP/urzędu nadania typu URL (blokowały zapis formularza), lista zleceń DHL bez odświeżania po zakolejkowaniu.

## Otwarte pytania (wymagają konta sandbox DHL24)

1. Dokładny WSDL: kwalifikacja elementów dzieci (ns czy bez) i wartość nagłówka `SOAPAction`. Kod wysyła `"<ns>#<metoda>"`, a odpowiedź dopasowuje po nazwie lokalnej.
2. Czy WebAPI2 ma metodę odczytu tożsamości konta lub numeru SAP. Dziś `connection` potwierdza tylko login i hasło odczytem `getPostalCodeServices`. Numer SAP pochodzi z ustawień i zostaje sprawdzony dopiero przy `createShipments.payment.accountNumber`.
3. Rachunek COD: czy można podać NRB per przesyłka (jakie pole), czy wypłata idzie zawsze na rachunek z umowy SAP. Dziś NRB jest walidowany i zapisywany do uzgodnienia, ale nie trafia do SOAP.
4. Typ i limit wagi (`pieceList.item.weight` int kg czy decimal), limit 31,5 kg przy zaokrągleniu w górę (31,01–31,5 → 32), progi `nonStandard` i maksymalne wymiary.
5. Limity pól: `content`, `reference` (używamy 22 znaków), `comment`, nazwa, ulica, miasto, `additionalInfo` dla kuriera (przyjęte 50).
6. Limity kwot: COD (przyjęte 11 000 PLN), ubezpieczenie (przyjęte 50 000 PLN); czy ubezpieczenie jest wymagane przy COD.
7. Kody statusów `getTrackAndTraceInfo` i format `timestamp`. Mapa w `carrier-dhl-values.ts` jest tymczasowa (PNO, PODJ, SORT, LP, LK, DWP, POP, AWI, BRG, DOR, ZWN, ZWD, ANUL).
8. Czy `getMyShipments` zwraca `reference` i jaki ma limit strony. Od tego zależy uzgodnienie utraconej odpowiedzi `createShipments`. Alternatywą jest `getShipmentScan` albo panel.
9. Okno kuriera: minimalna długość (przyjęte 120 min), najpóźniejsza godzina zamówienia na dziś, horyzont dni (przyjęte 14), soboty; czy `bookCourier` zwraca jedno czy kilka `orderId`.
10. Struktura `getNearestServicepoints` (nazwy pól godzin otwarcia, `sap` jako ID punktu, typy POP/Parcelshop/automaty) i sposób adresowania doręczenia do punktu w `createShipments`. Doręczenie do punktu nie jest jeszcze wysyłane.
11. Kody i teksty SOAP Fault dla autoryzacji i walidacji, potrzebne do zawężenia klasyfikacji w `dhlFaultProblem`, oraz zachowanie przy limicie zapytań (HTTP 429 czy Fault).
12. Format etykiet: czy `labelData` dla BLP to A6 PDF, a LBLP to A4, i jaki jest MIME ZPL.
