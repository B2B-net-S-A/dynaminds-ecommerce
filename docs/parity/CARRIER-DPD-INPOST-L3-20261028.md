# L3: multiparcel i etykiety zwrotne DPD/InPost, DHL points.search (28.10.2026)

Dalsza część toru L3 z [INTEGRATIONS-WAVE1-GAP-20261025.md](INTEGRATIONS-WAVE1-GAP-20261025.md) po kroku 0 i
podłączeniu DHL/Poczty Polskiej (migracja 234, [CARRIER-DHL-20261025.md](CARRIER-DHL-20261025.md),
[CARRIER-POCZTAPOLSKA-20261025.md](CARRIER-POCZTAPOLSKA-20261025.md)). Wszystko zbudowane i sprawdzone wyłącznie na
lokalnych fake; poziom konta w scope v6 bez zmian — „czeka na dostawcę”. Etykiety zwrotne przygotowano jako migrację
261 i zintegrowano 29.10.2026 jako **migrację 254** (`254_carrier_returns`, sekcja „Integracja jako 254” niżej). Nazwy
obiektów zachowują prefiks `carrier261_` (nazwa, nie numer wydania — jak `mirakl262_` i `b2b258_`).

## Co zrobiono

| Operacja | Przewoźnik | Kod | Test | Migracja |
|---|---|---|---|---|
| `multiparcel` | DPD Polska | `server/dpd-shipping.ts:52` `additional_parcels` (do 10 paczek), `:123` `generated(n)`, `:154` `verifiedDpdLabel` komplet numerów, `web/dpd-shipping.tsx` „Dodaj paczkę”, „Paczki (N)” | `tests/dpd-multiparcel.test.ts` 7 testów | nie |
| `multiparcel` | InPost ShipX (kurier) | `server/shipping.ts:66` `additional_parcels`, `:369` `verified()` paczka po paczce, `:486` `parcelResult`, `web/shipping.tsx` | `tests/inpost-multiparcel.test.ts` 7 testów | nie |
| `returns.label` | DPD Polska | `server/carrier-returns.ts:300` `dpdReturn` (`generatePackagesNumbers` nadawca = kupujący, odbiorca = adres zwrotów, `generateSpedLabels` po referencji) | `tests/carrier-returns254.database.test.ts` | 254 |
| `returns.label` | InPost ShipX | `server/carrier-returns.ts:254` `inpostReturn` (`createShipment` → jedna oferta ≤ zatwierdzony limit → `buyShipment` → `label`) | jw. | 254 |
| `points.search` | DHL Parcel Polska | `server/dhl-points.ts:107` `GET /api/integrations/:id/dhl-points`, `web/dhl-points.tsx` (panel DHL) | `tests/dhl-points.test.ts` 5, `tests/dhl-points.database.test.ts` 4, `tests/dhl-points-web.test.tsx` 2 | nie |
| `pickup.availability` | DPD Polska | bez zmian; wiersz luki był nieaktualny | `tests/dpd-collections.test.ts:646` (L2) | nie |

### Multiparcel

- Jedno nadanie, do 10 paczek, **nadal jeden wiersz `shipments`** (numer przesyłki = pierwsza paczka DPD / numer
  przesyłki ShipX). `order_shipments_guard` (234) i wydanie towaru (`dispatchShipping`) bez zmian. Numery paczek:
  `shipping_plans.result.parcels` (`[{index, waybill}]` DPD, `[{index, id, tracking_number}]` InPost).
- DPD: wszystkie paczki niosą referencję pakietu, bo istniejący `Dpd.labels(reference)` szuka po referencji paczki.
  Numery zapisują się razem z fazą `numbers_ready`, więc utracona odpowiedź etykiety jest sprawdzana z pełnym
  zbiorem. **Częściowe potwierdzenie** (jedna z N paczek bez numeru) nigdy nie jest przyjęte: plan zostaje w
  `create_started`, uzgodnienie tylko odczytem etykiet, `generatePackagesNumbers` nigdy drugi raz. Etykieta z
  mniejszą liczbą paczek jest odrzucana, dopóki DPD nie zwróci kompletu.
- InPost: tylko `inpost_courier_standard` (paczkomat = jedna paczka). Przesyłka zwrócona z brakującą lub inną paczką
  jest odrzucana przed zakupem (409, bez `buy`).
- Powiązanie ze stanowiskiem pakowania (pomiar jednej paczki) z dodatkowymi paczkami jest odrzucane (422).

### Etykiety zwrotne (migracja 254, przygotowana jako 261)

- Zwrot to osobna przesyłka od kupującego do sprzedawcy dla **wydanej** przesyłki DPD/InPost z połączenia. Nie jest
  wierszem `shipments` (guard 134/234 odrzuca nową paczkę po wydaniu) i nie zmienia rezerwacji, stanu ani WZ.
- Własna tabela `carrier261_returns` (`server/254_carrier_returns.sql`): RLS `tenant_scope`, `dyna_app` SELECT/INSERT
  i UPDATE wybranych kolumn, wyzwalacz strażnika (tożsamość, payload, odcisk, referencja niezmienne; `label_ready`
  i `cancelled` ostateczne; numer raz nadany niezmienny), brak DELETE/TRUNCATE, jeden żywy zwrot na przesyłkę
  (`queued`/`label_ready`/`uncertain`). Klucze obce tylko do `users` i `channels` (jak `dhl234_pickups`).
- Przepływ: `POST /api/shipments/:id/returns/preview` (idempotentny po `client_key` i odcisku; inny payload z tym
  samym kluczem → 409) → `POST /api/carrier-returns/:id/queue` (`confirm_external`; ponowienie zwraca to samo
  zadanie) → zadanie `shipping.return` → `GET /api/carrier-returns/:id/label` (PDF z bazy, bez wywołania
  przewoźnika); `reconcile` dla niepewnego wyniku (tylko odczyt), `cancel` lokalnie.
- Przed każdym zapisem u przewoźnika trwała faza: DPD `create_started` → `numbers_ready`; InPost `create_started` →
  `created` → `buy_started`. Utracona odpowiedź DPD: odczyt etykiety po referencji; InPost: historia przesyłek po
  referencji; nigdy drugie utworzenie ani drugi zakup.
- Pieniądze (InPost): operator zatwierdza w podglądzie najwyższą cenę (`max_rate_minor`); droższa oferta albo kilka
  ofert → `failed` w fazie `created` (nic nie kupiono), autor może wycofać i przygotować nowy zwrot. Zwrot
  `uncertain` wycofuje tylko administrator po sprawdzeniu w panelu przewoźnika (poprawka po przeglądzie, cf42861).
- UI: sekcja „Etykieta zwrotna DPD/InPost” pod wydaną przesyłką (`web/carrier-returns.tsx`); bez migracji 254 trasa
  odpowiada 503 i sekcja się nie pokazuje. Trasy rejestrowane w `registerShippingRoutes`, więc `server/app.ts`
  (przypięty w `scripts/full-base-scale-http-ports.mjs`) bez zmian.
- Integracja numeru: sekcja „Integracja jako 254” niżej (`INTEGRATION.md` z gałęzi przygotowania usunięty).

### DHL points.search

- Trasa tylko do odczytu, admin/operator, obca firma 404, przykład lokalny bez HTTP, odpowiedź ograniczona (≤ 50
  punktów, znane pola). Zarejestrowana w `registerCollectionRoutes` (`server/dpd-collections.ts`), bo to istniejąca
  rejestracja, która dostaje `IntegrationContext` (fake / egress, 423 w podglądzie kopii); rejestracje DHL w
  `app.ts` go nie dostają, a `app.ts` jest przypięty. Do przeniesienia, gdy ktoś i tak zmieni `app.ts`.
- Tylko informacyjnie: doręczenie do punktu w `createShipments` nie jest wysyłane (pytanie 10 w CARRIER-DHL).

## Weryfikacja

- Przygotowanie, czerwono → zielono (klony PG04 `dynaminds_p261_20261028_NN`, `migrate()` do 251, 261 ręcznie w teście;
  pliki pod nazwami sprzed integracji):
  - `tests/dpd-multiparcel.test.ts`: 1/7 → 7/7; `tests/dpd.test.ts` 25/25 po zmianie.
  - `tests/inpost-multiparcel.test.ts`: 2/7 → 7/7; `tests/shipping.test.ts` 22/23 — jedyny czerwony („worker
    dispatches local example”) jest czerwony także na HEAD sprzed zmian (zaległe zadania innych firm w szablonie).
  - `tests/carrier-returns261.database.test.ts`: na HEAD sprzed zmian 0/6 (404 tras); bieg po zmianie przerwano na
    `_05` — powtórzony po integracji na świeżym klonie m254 (sekcja „Integracja jako 254”).
  - `tests/carrier-returns261.static.test.mjs` 3/3; `tests/failure-job-kinds.test.ts` 6/6 (nowy kind sklasyfikowany).
  - `tests/dhl-points.test.ts` 0/1 (brak modułu) → 5/5; DB 0/4 → 4/4; web 2/2.
- Strażnicy (10 + `warehouse_wz_issuer_guards`) sprawdzani w `before`/`after` testu bazodanowego zwrotów.
- `npx tsc --noEmit -p .` czysto.
- Przeglądarka `p261.localhost:5261` (API bez workerów, zadania uruchamiane skryptem z odmową sieci): przykład
  lokalny DPD z 3 paczkami → „Paczki (3)” → przekazanie → „Przygotuj etykietę zwrotną” → podgląd → utworzenie →
  „Etykieta gotowa” i PDF DEMO; formularz kuriera InPost z „Paczki w przesyłce kurierskiej: 3 z 10”.

## Integracja jako 254 (29.10.2026)

Wzorzec 252/253. Sześć commitów przygotowania (77a4aae…7d45dc5 z `worktree-agent-a233367e74c90ede8`) przeniesione
cherry-pickiem na `goal/full-base-20261017` (a7a7cb4…bcd7196); jedyny konflikt w `server/worker.ts` (dwa importy obok
siebie: Mirakl 252 i zwroty), rozwiązany zachowaniem obu. Potem dwa commity integracji i ten dokument.

- SQL: `server/261_carrier_returns.sql` → `server/254_carrier_returns.sql`; pierwsze linie komentarza „prepared as 261,
  registered after 253_mirakl_webhook_retention; object names keep the carrier261_ prefix”, reszta SQL bez zmian;
  5 678 B, sha256 `37b9394cd6cea92be2f4426c9092840abc14693f4981802b68441173387d7d5e`.
- Wiersz manifestu `254_carrier_returns` (`native_id` `carrier_returns254`, kontrakt `carrier-returns254`) po 253;
  `server/db.ts` bez zmian (program z manifestu).
- Zimny katalog: kompilacja na `dynaminds_m254_20261029_01` (szablon + 218…253 + ledger; poprzednik = skompilowany
  after253 `29141a3e…aa4c5469`): **105 dodań** (8 relacji, 37 kolumn, 38 ograniczeń, 7 indeksów, 2 typy, 1 polityka,
  2 funkcje, 10 wyzwalaczy: dwa własne i osiem RI kluczy obcych do `users` i `channels`, kluczowane nazwą własnego
  ograniczenia), 0 zmian, 0 usunięć; after254 `ce974595…5574bcf6` (46 982 rekordy); dwunastu strażników true przed
  i po. `carrier-returns254-source-contract.mjs`, `carrier-returns254-source-compatibility.mjs`
  (`projectCompiledCarrierReturns254Catalogue`, łańcuch odwrotny od 253, footprint gołym prefiksem `carrier261_`, bez
  `\b`), jedna linia w `release-cold-projectors.mjs`. Żaden footprint poprzedników nie obejmuje rekordu 254 (test).
  Kompilator i wyniki: `local-builds/full-base-preview-20261017/m254-source-20261029-01/`.
- Ledger 244 (guard: przyszłe `255_…`, `256_…`); MIG-2 z klonu na 243 stosuje 244…254; MIG-1 i MIG-4 oczekują serii
  244…254 (MIG-1 liczy też tabelę `carrier261_returns`); 253 nie jest już ostatnia (254 po 253); rodzina klonów `m254`
  (data 20261029) w testach DB 236…253, installation-identity, settlement report, MIG-1/MIG-2/MIG-4 i
  worker-supervision (bez nowego kroku workera: odzysk zwrotów idzie w istniejącym `tick()`).
- Testy: `tests/carrier-returns254.static.test.mjs` (z przypięciem wiersza manifestu),
  `tests/carrier-returns254.database.test.ts` (prawdziwe `migrate()`, wiersz ledgera 254; ręczny krok SQL usunięty),
  `tests/carrier-returns254-source-compatibility.test.mjs` (7, ostatni opt-in); `tests/dhl-points.database.test.ts`
  na rodzinie m254.
- Komentarze 261 → 254 w `server/carrier-returns.ts`, `server/shipping-routes.ts`, `server/worker.ts`,
  `web/carrier-returns.tsx`; tanie sprawdzenia `to_regclass('public.carrier261_returns')` zostają. `server/app.ts`,
  `server/integrations.ts` i `server/catalog-stock-writer-coverage.ts` bez zmian, więc bez re-pinu scale-ports i
  stock-writer (`tests/full-base-scale-http-ports.test.mjs`, `tests/catalog-stock-writer-coverage.test.ts` zielone).
- `INTEGRATION.md` usunięty (treść tutaj).

| Sprawdzenie (PG04, klony `dynaminds_m254_20261029_NN`, po biegu usunięte) | Wynik |
|---|---|
| `_02` świeży klon, prawdziwe `migrate()` | ledger 244, ostatnia `254_carrier_returns` |
| strażnicy na `_02` (jit=off, UTC; `guards-A-02.json`) | dziesięciu + `warehouse_wz_issuer_guards` + `email_inbound_guards` = true |
| inspekcja zimna na `_02` (`cold-A-02.json`) | PASSED, 46 982 rekordy, `native_catalogue_sha256` = after254, `carrier_returns254_active` i `mirakl_webhook_retention253_active` true |
| `tests/carrier-returns254.database.test.ts` (`_02`; powtórzenie przerwanego biegu z `p261_…_05`) | 6/6 (strażnicy true w `before`/`after`) |
| `tests/dhl-points.database.test.ts` (`_03`) | 4/4 |
| `tests/dpd-multiparcel.test.ts` (`_04`) | 7/7 |
| `tests/inpost-multiparcel.test.ts` (`_05`) | 7/7 |
| MIG-2 `tests/migration-checksums244.database.test.ts` (`_06`, 218…243) | 1/1 |
| MIG-1 `tests/migration-runner.database.test.ts` (`_07`, 218…243) | 3/3 |
| MIG-4 `tests/release-rollback.database.test.ts` (`_08`, 218…243; konfiguracja z kluczem szablonu i zdjęcia jak w biegu 253) | 1/1 (przywrócona baza usunięta przez test) |
| `tests/worker-supervision.database.test.ts` (`_09`) | 4/4 |
| bez bazy: statyczne i zimne 254/253/252, `b2b-network-lifecycle251.static`, `wms-evidence-settle250`, `release-migrations-*`, `source-ddl-migration-plan`, `migration-ledger-guard`, `worker-loop`, `request-log`, `full-base-scale-http-ports`, `release-rollback`, `base-provider-roster-mirakl`, `failure-job-kinds`, `catalog-stock-writer-coverage`, `return-credit208-resources`, `buyer-address-carrier-ui166`, `dhl-points`, `dhl-points-web`, `scoped-automation-drain`, `ordinary-local-worker`, `ordinary-local-schedule-worker` | 524/530, 4 pominięte opt-in, 2 czerwone także na a44cceb sprzed integracji (`failure-job-kinds`: „mirakl262.ts: kind of INSERT INTO jobs not resolved ($3)”; `buyer-address-carrier-ui166`: „Runtime import ../server/shipment-status-labels”); z opt-in na prawdziwych katalogach 254: 7/7 |
| `node --test tools/parity/*.test.mjs` | 133/133 |
| `run-bw.sh` | 418/418 |
| `npx tsc --noEmit -p .` | czysto |

## Pytania do sandboxów (czeka na dostawcę)

DPD Polska
1. Czy `generatePackagesNumbers` przyjmuje tę samą `reference` dla kilku paczek jednego pakietu?
2. Czy `generateSpedLabels` po jednej referencji paczki zwraca wszystkie paczki tej referencji w jednym pakiecie?
   Od tego zależy uzgodnienie po utraconej odpowiedzi.
3. Limit paczek w pakiecie (przyjęto 10) i czy PDF obejmuje wszystkie paczki jednym `documentData`.
4. Czy przy `STOP_ON_FIRST_ERROR` może wrócić odpowiedź częściowa (część paczek z numerami) i czy te numery są
   utworzone? Dziś traktowana jako niepewna, nigdy jako odrzucona.
5. Kolejność numerów w odpowiedzi = kolejność paczek? (pierwszy numer = numer przesyłki).
6. Etykieta zwrotna: czy konto wymaga osobnej usługi lub endpointu zwrotu (np. etykieta zwrotna do numeru
   oryginalnej przesyłki) zamiast zwykłej przesyłki z odwróconymi stronami i `payerFID` sprzedawcy?

InPost ShipX
7. Czy paczki przesyłki wielopaczkowej mogą nieść własne `id` i czy ShipX zwraca ich numery i `tracking_number`
   paczek? Jak mają się do `tracking_number` przesyłki?
8. Czy `GET /shipments/:id/label` obejmuje wszystkie paczki w jednym PDF? Limit paczek (przyjęto 10)? Czy
   paczkomat naprawdę odrzuca wiele paczek?
9. Zwroty: czy konto używa produktu zwrotów (Szybkie Zwroty / kod zwrotu, rozliczenie za użycie) zamiast zwykłej
   przesyłki paczkomatowej z kupującym jako nadawcą; czy oferta zwrotu przychodzi tak samo (`offers` → `buy`)?

DHL Parcel Polska
10. Struktura `getNearestServicepoints` i adresowanie doręczenia do punktu — pytanie 10 w CARRIER-DHL (bez zmian).

## Co zostaje w L3

- DPD `pickup.update` (nowy `kind` w CHECK `dpd_collections`, zmiana tabeli rdzenia — osobna migracja).
- InPost `dispatch_order` (trwałe zlecenia odbioru — nowa tabela).
- Poczta Polska `sendEnvelope`/`envelopeStatus` i sprawdzenie punktu przed zapisem planu.
- Protokół odbioru DPD dla przesyłki wielopaczkowej: `server/dpd-collections.ts` `verifiedProtocol` oczekuje jednej
  paczki na referencję („inny zestaw paczek”).
