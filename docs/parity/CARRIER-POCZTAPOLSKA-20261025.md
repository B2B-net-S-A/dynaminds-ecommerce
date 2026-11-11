# Poczta Polska (eNadawca / Envelo): klient przewoźnika, podłączony 26.10.2026

Tor L3, przygotowanie z [INTEGRATIONS-WAVE1-GAP-20261025.md](INTEGRATIONS-WAVE1-GAP-20261025.md) (sekcja „Poczta Polska”, plan L3). Zakres 25.10: czyste moduły i lokalny fake. Od 26.10.2026 klient jest podłączony (migracja 234, trasy, worker, tracking, UI; sekcja „Podłączenie”). Stany operacji w scope v6 się nie zmieniają: wszystkie sześć nadal „czeka na dostawcę”, bo kontraktu nie potwierdzono na koncie testowym.

**Wszystkie odpowiedzi dostawcy w testach są syntetyczne.** Fake (`server/carrier-pocztapolska-fake.ts`) i pliki `tests/fixtures/pocztapolska/*.xml` przygotowano ręcznie według publicznych opisów usług eNadawca i Sledzenie, a nie z nagrań. Każdy plik fixture ma komentarz `SYNTETYCZNE`. Żaden test nie wykonuje żądania sieciowego.

## Pliki

| Plik | Rola |
|---|---|
| `server/carrier-pocztapolska-xml.ts` | Escapowanie, parser SOAP (saxes, DOCTYPE odrzucany, limity rozmiaru, głębokości i liczby węzłów), odczyt odpowiedzi z limitem bajtów |
| `server/carrier-pocztapolska-values.ts` | Schemat wejścia (zod), limity usług, NRB, gabaryty, rozbicie adresu, payload `PocztaPolskaShipment`, guid z id planu, skrót połączenia, walidacja PDF |
| `server/carrier-pocztapolska.ts` | Klient eNadawca `PocztaPolska` (SOAP, HTTP Basic), mapowanie Fault i `errorType`, ponawianie tylko odczytów, timeout |
| `server/carrier-pocztapolska-tracking.ts` | Klient Sledzenie `PocztaPolskaTracking` (WS-Security UsernameToken), tabela kodów → statusy aplikacji, czas lokalny → UTC |
| `server/carrier-pocztapolska-shipments.ts` | Tworzenie przesyłki co najwyżej raz na klucz (guid) z dziennikiem jako interfejsem; dziennik w pamięci do testów i symulacji |
| `server/carrier-pocztapolska-fake.ts` | Lokalny fake eNadawcy i Sledzenia: bufor, numery `FAKEPP…`, PDF etykiety, sterowane awarie (status, zawieszenie, sieć, utrata odpowiedzi po zapisie) |
| `tests/carrier-pocztapolska*.test.ts` | 28 testów (14 + 7 + 7) |
| `tests/fixtures/pocztapolska/` | 12 syntetycznych odpowiedzi XML |

## Kształt zgodny z DPD/InPost (drop-in)

| DPD / InPost | Poczta Polska |
|---|---|
| `new Dpd(mode, settings, credentials, transport)` w `connector()` | `new PocztaPolska(mode, settings, credentials, transport)`; `settings.urzad_nadania`, `credentials.username/password` |
| `Dpd.test()` | `PocztaPolska.test()` → `{environment, endpoint, office}` |
| `Dpd.create(payload)` + `generated()` | `PocztaPolska.create(shipment)` → `{guid, tracking_number}` po weryfikacji guid i numeru |
| `Dpd.labels(reference)` + `verifiedDpdLabel()` | `PocztaPolska.labels(guid)` → `{guid, label_base64, pdf}` |
| `dpdPdf(base64)` | `pocztaPolskaPdf(base64)` (te same granice: 6 MB base64, 4 MB PDF, `%PDF-`) |
| `dpdConnection(ch)` | `pocztaPolskaConnection(ch)` |
| `dpdInput` | `pocztaPolskaFields` (bez refine, do `.extend({packing})`) + `pocztaPolskaChecks`; gotowy `pocztaPolskaInput` |
| `DpdInfo.tracking(s)` | `PocztaPolskaTracking.tracking(s)`: identyczne klucze wyniku (`tracking_number`, `current_waybill`, `return_leg`, `lineage`, `status`, `tracking_details`, `provider_updated_at`, `provider_created_at`, `scope`, `empty_history`) |
| `dpdStatus(code)` | `pocztaPolskaStatus(code, returning)`; wartości tylko z `BASE_WIRE_TRACKING_STATUS` (sprawdza test) |
| `InPost.points(city)` | `PocztaPolska.points(voivodeship)` + `assertPickupPoint(points, id)` |
| `shipping_plans.phase` create_started / numbers_ready | `PocztaPolskaJournal` started / uncertain / created / rejected / absent |

## Operacje scope v6 → kod → test

| Operacja | SOAP | Kod | Test |
|---|---|---|---|
| `connection` | `hello`, `getUrzedyNadania` | `PocztaPolska.test()`, `offices()` | konto, urząd nadania spoza konta, złe hasło (401), 403, endpoint sandbox/live |
| `shipment.create` | `addShipment`, `getEnvelopeBufor`, `sendEnvelope`, `getEnvelopeStatus`, `clearEnvelopeByGuids`, `clearEnvelope` | `create()`, `buffer()`, `findShipment()`, `sendEnvelope()`, `envelopeStatus()`, `cancel()`, `clearEnvelope()`; `createPocztaPolskaShipment()` | sukces, odrzucenie `errorType`, Fault Client/Server, utrata odpowiedzi, timeout, 5xx, śmieci, duplikat, równoległa próba |
| `label.pdf` | `getPrintForParcel` (ADDRESS_LABEL, EACH_PARCEL_SEPARATELY) | `labels()` | PDF niepusty z `%PDF-`, brak przesyłki → 404, zły PDF, zły guid przed żądaniem |
| `tracking.read` | Sledzenie `sprawdzPrzesylke` | `PocztaPolskaTracking.events()`, `tracking()` | doręczona, zwrot, statusy -1/-2/1/-99, Fault uwierzytelnienia, cudzy numer, XXE, scalanie historii, ponawianie |
| `pickup_point` | `getPlacowkiPocztowe` + dostawa do punktu w `addShipment` | `points()`, `assertPickupPoint()`, `service: 'pocztex_punkt'` | punkt aktywny, punkt bez wydawania, nieistniejący, zły kod województwa |
| `cod` | `pobranie` w `addShipment` | `pocztaPolskaChecks`, `polishNrb()` | brak/zły NRB, kwota > wartość, kwota ponad limit, ułamek grosza, pobranie w Paczce pocztowej, rachunek bez kwoty |

## Bezpieczeństwo i niezawodność

- **XML.** Żądania z szablonów; każda wartość przez `escapeXml`, znaki sterujące odrzucane (422). Odpowiedzi: DOCTYPE = błąd (bez encji, bez XXE), niezdefiniowana encja = błąd, limity 10 MB (eNadawca) / 2 MB (Sledzenie), głębokość 24, 50 000 węzłów. Tekst dostawcy w komunikatach jest oczyszczany i obcinany do 200 znaków.
- **Uwierzytelnianie per tenant.** Login i hasło z kanału, żadnych stałych w kodzie. eNadawca: HTTP Basic. Sledzenie: osobne `tracking_login`/`tracking_password` (WS-Security PasswordText). Endpoint wybiera tylko `mode` (`sandbox`/`live`); dowolny URL nie jest przyjmowany. Domyślny transport to `safeFetch` (HTTPS, publiczne adresy, bez przekierowań).
- **Ponawianie.** Tylko odczyty (`hello`, `getUrzedyNadania`, `getEnvelopeBufor`, `getPrintForParcel`, `getEnvelopeStatus`, `getPlacowkiPocztowe`, `sprawdzPrzesylke`): 3 próby przy 429/502/503/504, timeoucie i błędzie sieci, Retry-After do 5 s, inaczej 200/400 ms. Zapisy (`addShipment`, `sendEnvelope`, `clearEnvelopeByGuids`, `clearEnvelope`) idą raz; brak odpowiedzi, 5xx bez Fault albo nieczytelna odpowiedź = `PP_OUTCOME_UNCERTAIN`.
- **Idempotencja.** Klucz = guid eNadawcy = id planu bez myślników (32 hex). Ten sam klucz z tym samym body zwraca zapisany wynik bez żądania. Inne body daje 409. Niepewny wynik rozstrzyga odczyt bufora po guid, nigdy powtórne `addShipment`. Gdy odczyt nic nie znajduje, stan to `absent` i ponowne utworzenie wymaga jawnego `retryAfterAbsent` (krok operatora). Duplikat guid zgłoszony przez dostawcę uruchamia odczyt od razu.
- **Bufor.** `clearEnvelope` czyści cały bufor, także cudze paczki, więc wymaga `confirmWholeBuffer: true`. Anulowanie pojedynczej paczki idzie przez `clearEnvelopeByGuids`.
- **Kody błędów (`Problem.code`).** `PROVIDER_HTTP_UNAUTHORIZED` (401, jak `ApiClient`), `PP_FORBIDDEN`, `PP_REJECTED`, `PP_SOAP_FAULT_CLIENT`, `PP_SOAP_FAULT_SERVER`, `PP_OUTCOME_UNCERTAIN`, `PP_DUPLICATE_GUID`, `PP_TIMEOUT`, `PP_LABEL_MISSING`, `PP_RECONCILE_ABSENT`, `PP_CREATE_IN_PROGRESS`, `PP_TRACKING_*`.

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

### Poczta Polska w szczegółach

- Plan: `input` = zwalidowane `pocztaPolskaInput` (+ `packing`), `payload` = `PocztaPolskaShipment` (guid = id planu bez myślników). Przed utworzeniem payload jest porównywany ze świeżo wyliczonym z `input` (skrót body).
- `PocztaPolskaJournal` to wiersz planu: `started`/`uncertain` → `create_started`, `created` → `numbers_ready` + `remote_id` = numer nadania, `rejected` → `rejected`, `absent` → `absent` (plan do anulowania i nowy plan; ponowne `addShipment` bez guid nie istnieje). Utracona odpowiedź → odczyt bufora po guid, nigdy drugie `addShipment`.
- Etykieta `getPrintForParcel` pobierana raz przy utworzeniu i zapisana w planie; wynik planu ma `guid` i `cod` (kwota, rachunek NRB).
- Tracking: `PocztaPolskaTracking` (osobny login `tracking_login`/`tracking_password`, opcjonalny przy zakładaniu połączenia); usługa Śledzenie jest jedna dla obu środowisk eNadawcy, więc tracking działa w sandbox i live, gdy login jest podany.

### Co zostaje

- Druk etykiety przez kolejkę drukarek — zablokowane przypięciem 177 (wyżej).
- `pickup_point`: sprawdzenie punktu (`assertPickupPoint(points(województwo))`) przed zapisem planu nie jest podpięte (brak kodu województwa w danych zamówienia); punkt idzie do eNadawcy jak wpisany.
- `sendEnvelope` (nadanie zbioru) i `envelopeStatus` — brak trasy/UI; dziś przesyłki zostają w buforze eNadawcy.
- Ręczne zadania zwykłego runtime (`ordinary-connector-jobs.ts`) i stanowisko pakowania — jak przy DHL.

### Weryfikacja (26.10.2026)

- Strażnicy (9 + `local_invoice_guards`, oraz `order_shipments_guards`, `label_cache_guards`, `label_print_guards`) prawdziwi przed i po 234: w transakcji na `_01`, przy kompilacji na `_41`, po realnym `migrate()` 218–234 na `_02`–`_07`, przed i po teście bazodanowym.
- Skompilowana odwrotność 234→233 na własnym klonie `dynaminds_l3_20261026_41`: 92 dodania (7 relacji, 31 kolumn, 33 ograniczenia, 6 indeksów, 1 polityka, 2 funkcje, 10 wyzwalaczy w tym RI kluczy obcych na `channels` i `users`, 2 typy), 2 zmiany (`order_shipments_guard()`, `shopify_capture_dispatch()`), 0 usunięć; poprzednik = skompilowany after233 `cde32ce2…`, after234 `00c125e6…`. Dokładna odwrotność prawdziwych katalogów sprawdzona (`tests/carriers234-source-compatibility.test.mjs` 6/6 z katalogami opt-in).
- Prawdziwa zimna inspekcja PASSED: `_41` i `_03` (44 350 rekordów, `carriers234_active` true), `_01` (tylko 233, 44 258, 234 nieaktywna). Krok właściciela zwykłego runtime na `_03` PASSED (`00c125e6…`). Katalog 67 667 800 z 134 217 728 B; zapas **66 549 928 B** (−45 395 B wobec 233).
- `node --test tests/release-migrations-*.test.mjs tests/source-ddl-migration-plan.test.mjs` 177/177; zimne zestawy (98 plików) 950 testów, 938 pass, 0 fail, 12 skipped; `scratchpad/run-bw.sh` 318/318; `npx tsc --noEmit -p .` czysto; testy klientów i polityki egress 79/79; `tests/failure-job-kinds.test.ts` 6/6; testy web 446/447 (jedyny błąd `product-catalogs-refresh` czyta plik z innego worktree, niezależny).
- **Test bazodanowy** `tests/carriers234.database.test.ts` na świeżym klonie `dynaminds_l3_20261026_06` (realne `migrate()` 218–234, prawdziwe trasy `buildApp`, procesory zadań, tylko lokalne fake): **7/7** — kanały i test połączenia, przesyłka DHL z COD → zapisana etykieta PDF (bez ponownego wywołania dostawcy) → tracking → wydanie; utracona odpowiedź `createShipments` → ponowienie uzgadnia przez `getMyShipments` (jedno utworzenie); Poczta Polska z COD → utracona odpowiedź `addShipment` → odczyt bufora po guid (jedno utworzenie) → etykieta → tracking → wydanie; przykład lokalny bez HTTP; zlecenie i anulowanie kuriera DHL, druga rezerwacja tej samej paczki odrzucona; guard SQL odrzuca przesyłkę DHL bez działającego zadania planu; trasy InPost odrzucają plan DHL.
- **Przeglądarka** na `_03` (API 4341 z fake jako jedynym transportem, Vite 5341, osobny `cacheDir`, proxy bez `Origin`; serwery zatrzymane): formularz połączenia DHL, podgląd i utworzenie przesyłki DHL z COD (numer 90000000001, etykieta PDF), tracking „W doręczeniu”, przesyłka Poczty Polskiej (FAKEPP0000000001, COD 40,99 zł) z trackingiem i wydaniem, zlecenie kuriera DHL (K700002). Zrzuty `scratchpad/l3-shots/01…11`. Znalezione i poprawione: pola SAP/urzędu nadania typu URL (blokowały zapis formularza), lista zleceń DHL bez odświeżania po zakolejkowaniu.

## Do potwierdzenia na koncie testowym (sandbox eNadawcy)

Wszystko poniżej jest założeniem z publicznych opisów, nie sprawdzonym kontraktem.

1. Endpointy `https://en-testwebapi.poczta-polska.pl/websrv/en.php` i `https://e-nadawca.poczta-polska.pl/websrv/en.php`, przestrzeń nazw `http://e-nadawca.poczta-polska.pl`, format SOAPAction, HTTP Basic (a nie np. nagłówek SOAP).
2. Typy przesyłek: czy Pocztex Kurier to `pocztex2021KurierType`, Paczka pocztowa `paczkaPocztowaType`, i jak WSDL wyraża doręczenie do punktu (`odbiorWPunkcie` / `idPunktuOdbioru` to robocze nazwy). Czy punkty odbioru (także sieci partnerskie) pochodzą z `getPlacowkiPocztowe`, czy z osobnego API.
3. Nazwy pól `adresType` (`mobile` vs `telefon`), limity długości (`PP_LIMITS`), `opis`, `wartosc` w groszach, `masa` w gramach, formaty S–2XL i gabaryty A/B.
4. `pobranie`: `sposobPobrania=RACHUNEK_BANKOWY`, `kwotaPobrania` w groszach, `nrb`, `tytulem` (długość), limit kwoty (`PP_COD_MAX` = 5 000 zł to wartość ostrożna) i czy Paczka pocztowa może mieć pobranie.
5. `guid`: atrybut czy element, format (32 hex), czy eNadawca odrzuca powtórzony guid w buforze i jakim `errorNumber` (dziś rozpoznanie po treści `errorDesc`).
6. Odczyt bufora `getEnvelopeBufor` (czy zwraca `numerNadania` i guid) i czy po `sendEnvelope` istnieje odczyt przesyłki po guid (uzgodnienie po nadaniu zbioru).
7. `getPrintForParcel`: parametry `kind`/`method`, format A6/A4, czy PDF jest jedną etykietą.
8. Numery `errorNumber` i ich znaczenie; które błędy są trwałe, a które przejściowe.
9. Sledzenie: endpoint, wymóg WS-Security dla konta firmowego, znaczenie statusów (0, 1, -1, -2, -99), lista kodów zdarzeń (tabela w `carrier-pocztapolska-tracking.ts` jest robocza), format `czas` i strefa.
10. Limity zapytań eNadawcy i Sledzenia (scope v6: `official_rate_limit` = source_missing).
11. Czy konto testowe wymaga umowy (dla COD scope v6 wskazuje „konto + umowa”).

## Weryfikacja

```
cd "development/full-base"
npx tsc --noEmit -p .
npx tsx --test tests/carrier-pocztapolska.test.ts tests/carrier-pocztapolska-tracking.test.ts tests/carrier-pocztapolska-shipments.test.ts
```

Wynik 25.10.2026: tsc bez błędów, 28 testów, 28 zaliczonych, 0 błędów.
