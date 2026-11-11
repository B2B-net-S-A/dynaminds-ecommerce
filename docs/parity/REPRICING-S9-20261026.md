# Repricing S9 (bez migracji) — 26.10.2026

Tor S9 z [STAGE4-NONINTEGRATION-GAP-20261025.md](STAGE4-NONINTEGRATION-GAP-20261025.md), sekcja 4. Ta zmiana obejmuje tylko punkty, które nie wymagają migracji. Nowe ustawienia reguły są w istniejącej kolumnie `repricing_rules.config` (jsonb). Kursy pochodzą z tabeli `nbp227_rates` (`server/227_nbp_rates.sql:21`). Migracji, edycji `db.ts` i zmian w pakowaniu nie ma. `server/offers.ts` i `server/offer-sync.ts` są bez zmian: łańcuch do kanału pokrywa test bazodanowy.

## Punkty

| Wymaganie | Stan po S9 | Co zrobiono | Dowód |
|---|---|---|---|
| DOM-REPRICE-003 waluta, baza, zaokrąglenie | gotowe | **Waluta kosztu.** `cost_currency` (PLN, EUR, USD, GBP, CZK) ustawia walutę kosztu netto. Koszt jest przeliczany ostatnim kursem tabeli A z `nbp227_rates` z dnia wyceny (Warszawa) lub wcześniejszego, przez PLN jako walutę pośrednią, i zaokrąglany w górę do grosza. Dzięki temu minimum z marżą nigdy nie spada poniżej rzeczywistego kosztu. Brak kursu albo kurs starszy niż `max_rate_age_days` (domyślnie 7, zakres 1–31) blokuje SKU z komunikatem. Kurs (data, tabela, kurs średni) jest zapisany w wierszu podglądu, a zmiana kursu unieważnia zastosowanie (409).<br>**Zaokrąglenie.** `rounding {step: 5/10/50/100/500/1000 gr, ending < step}` ustawia końcówkę ceny. Cena po zaokrągleniu nigdy nie spada poniżej minimum ani nie przekracza maksimum; gdy zaokrąglenie się nie mieści, SKU jest blokowane. Przy strategiach konkurencji cena jest zaokrąglana w dół, żeby zostać poniżej ceny rywala. Dawna końcówka `ending: 99` działa jak wcześniej i nie łączy się z `rounding`.<br>**Cennik bazowy.** `base_price_list_id` wskazuje cennik, z którego bierze się obecną cenę, gdy cennik nie ma własnego wpisu ani reguły katalogowej. Cena jest przeliczana kursem NBP (zaokrąglenie połówkowe w górę). Wiersz z ceną z cennika bazowego ma stan `change`, więc wpis zostanie zapisany. Cykl, odwołanie do samego siebie i łańcuch dłuższy niż 5 są odrzucane przy zapisie (422, a 404 dla nieznanego cennika). Przy liczeniu cen cykl blokuje SKU, także wtedy, gdy powstał poza API. | `server/repricing-rules.ts` (czyste reguły), `server/repricing.ts` (`repricingRows`, `baseLists`, `basePrice`, `latestRates`, `assertRepricingBaseInTx`), `server/repricing-routes.ts` (PUT reguły) | `tests/repricing-rules.test.ts`; `tests/repricing-s9.database.test.ts` testy 2 i 3 |
| DOM-REPRICE-006 lista z regułą, źródłem, wynikiem | gotowe bez kolumny wyniku kanału; 27.10 kolumna kanału migracją 247 ([SALES-REPRICING247](SALES-REPRICING247-20261027.md)) | Historia podglądów jest posortowana `created_at DESC, id DESC`. Kursor ma postać `ISO µs UTC\|uuid`; błędny kursor zwraca 422. Filtry: `state` (preview, applied, expired), `sku` (fragment, znaki `%` i `_` są escapowane), `strategy`, `source` (manual, schedule). Każda pozycja historii podaje strategię oraz liczby zmian, wierszy bez zmiany i zablokowanych. Przebiegi harmonogramu są posortowane tak samo i mają filtr `state`. W UI są filtry, tabela historii i filtr stanu przebiegów. | `server/repricing-routes.ts` (GET previews), `server/repricing-schedules.ts` (GET runs), `web/repricing.tsx`, `web/repricing-schedules.tsx` | DB test 4; zrzuty 03, 04 |
| DOM-REPRICE-001 trwałość importu obserwacji | gotowe (test) | Test z bazą sprawdza import partii obserwacji przez trasę sesji. Po zamknięciu aplikacji i zbudowaniu nowej te same wiersze są widoczne przez nowe API i przez niezależne połączenie `pg`. Powtórka klucza zwraca tę samą partię, a ranking liczy cenę z zapisanych obserwacji. | — | DB test 5 |
| DOM-REPRICE-002 min/max | gotowe (bez zmian) | Dopisano testy jednostkowe granic oraz właściwość zaokrąglenia, że cena zostaje w przedziale [minimum, maksimum]. | — | `tests/repricing-rules.test.ts` |
| DOM-REPRICE-005 wynik kanału | częściowe (migracja); 27.10 gotowe lokalnie migracją 247 ([SALES-REPRICING247](SALES-REPRICING247-20261027.md)) | Bez migracji jest tylko test łańcucha. Przebieg harmonogramu zapisuje cennik, a offer-sync wysyła cenę do symulowanej oferty Woo. Utracone potwierdzenie planu jest uzgadniane z zapisanego wyniku bez drugiego zapisu, a drugi przebieg i druga synchronizacja niczego nie zmieniają. Do zrobienia zostaje powiązanie przebiegu z `offer_plans` w historii: wymaga kolumn albo tabeli. | — | DB test 1 |
| DOM-REPRICE-004 ręczne nadpisanie | pominięte (migracja); 27.10 gotowe lokalnie migracją 247 ([SALES-REPRICING247](SALES-REPRICING247-20261027.md)) | Wymaga nowej tabeli `repricing_overrides` (247). | — | — |

## Uprawnienia (po stronie serwera)

- Zapis reguły, danych i podglądu oraz zastosowanie podglądu: rola inna niż `viewer` (bez zmian).
- Zmiana `base_price_list_id`, `cost_currency` lub `max_rate_age_days`: tylko `admin` (403 „Cennik bazowy i walutę kosztu może zmienić tylko administrator”). Operator może zmieniać pozostałe pola, jeśli wysyła te trzy bez zmian. UI dla operatora blokuje te pola i wysyła zapisane wartości.
- Harmonogram: tylko `admin` (bez zmian).

## Znane ograniczenia

- Podgląd utworzony przed wdrożeniem nie zawiera pól `strategy` ani `current_source`. Jego zastosowanie w ciągu 15 minut ważności zwraca 409 i trzeba utworzyć nowy podgląd. Filtr strategii nie obejmuje takich podglądów; UI opisuje je jako „Reguła sprzed zapisu strategii”.
- Sortowanie po `created_at` nie ma własnego indeksu (istniejący to `tenant_id, price_list_id, id`). Indeks wymaga migracji. Dla historii jednego cennika to odczyt ograniczony do tego cennika.
- Kursy NBP są tylko odczytywane. Pobieranie i ręczne wpisy obsługuje moduł 227 (Dokumenty → Kursy NBP).
- Dwa równoległe zapisy reguł mogą stworzyć cykl, bo każdy zapis blokuje tylko swój cennik. Wtedy przy liczeniu cen SKU jest blokowane z komunikatem o cyklu.

## Weryfikacja

Wyniki z 26.10.2026:

- `tests/repricing-rules.test.ts` + `tests/repricing-competitor-rank.test.ts`: 12/12; razem z `tests/competitor-ranking.test.ts`: 17/17 (bez bazy).
- `tests/repricing-s9.database.test.ts` na `dynaminds_s9_20261026_04` (szablon `dynaminds_restore_36751abef3079f3f`, rzeczywisty `migrate()` do 233): 5/5, 46 min. Przebieg 1 zmienił 3 SKU (ceny 154,99 / 153,99 / 399,99 zł przy minimum 153,75 zł), przebieg 2 zmienił 0, plany Woo 3, druga i trzecia synchronizacja 0 nowych zapisów.
- Klony 01–03 padły tylko na limicie 8 s dla strażników instalacji (`pim_dictionary_valid` i pokrewne trwały 4–9 s przy load average 15–20 wspólnego PG04). Test podnosi limit połączenia wyłącznie dla własnej puli; każda transakcja tenanta nadal ustawia własne 8 s.
- `npx tsc --noEmit -p .`: bez błędów w plikach toru. Jedyny błąd dotyczy `tests/ksef229-res04.database.test.ts`, pracy w toku toru L1-A.
- `bash scratchpad/run-bw.sh`: 312/312.
- Zrzuty (`scratchpad/s9-shots/`, UI na 5291 → API na 4291, sam `buildApp()` bez migracji przy starcie, bo w drzewie jest już 234 innego toru):
  1. `01-rule-cost-currency-rounding-base.jpg`: reguła z walutą kosztu EUR, zaokrągleniem, wiekiem kursu i cennikiem bazowym.
  2. `02-preview-nbp-rate-and-source.jpg`: podgląd z przeliczeniem 25,01 € → 106,33 zł, kursem NBP 4,2512 z datą i numerem tabeli oraz źródłem obecnej ceny.
  3. `03-history-newest-first-with-result.jpg`: historia od najnowszych ze strategią, źródłem i wynikiem.
  4. `04-history-filter-expired.jpg`: filtr stanu „Wygasły”.
  5. `05-runs-newest-first-idempotent-second-run.jpg`: przebiegi automatu od najnowszych; drugi przebieg ma 0 zmian.

Sposób uruchomienia:


- Testy jednostkowe: `DYNA_TEST=true node node_modules/tsx/dist/cli.mjs --test tests/repricing-rules.test.ts tests/repricing-competitor-rank.test.ts`.
- Test z bazą: świeży klon PG04 `dynaminds_s9_20261026_NN` z szablonu `dynaminds_restore_36751abef3079f3f` po rzeczywistym `migrate()`. Uruchomienie: `tests/repricing-s9.database.test.ts`, skrypty `scratchpad/s9/migrate.sh` i `scratchpad/s9/dbtest.sh`. Ponowne uruchomienie wymaga nowego klonu.
- `npx tsc --noEmit -p .` oraz `bash scratchpad/run-bw.sh`.
- Zrzuty ekranu: `scratchpad/s9-shots/`.
