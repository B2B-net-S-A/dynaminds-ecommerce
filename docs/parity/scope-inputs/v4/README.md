# Zakres v4: cztery wymagania CRM, nadal częściowy

[scope.v4.json](../../scope.v4.json) zawiera **2589 wymagań**, w tym **139 wierszy domenowych**. Istniejący `createScopeSnapshot` odtworzył rodzica z przypiętych wejść i wygenerował nową wersję. Wszystkie 2585 wcześniejszych rekordów wymagań zachowano w całości: klucze, definicje, poziomy dowodów i stany. Pierwsze 135 wierszy nowego [domains.json](domains.json) jest identyczne wartościowo z zamrożonym wejściem v2; nie pobrano ich z później zmienianego `domains.json` w katalogu nadrzędnym.

Dodano wyłącznie:

- [DOM-CRM-001](crm-client-profile.addition.v1.json): niezależny profil klienta, utworzenie/odczyt/lista, częściowa aktualizacja i usunięcie z zachowaniem zamówień. Pierwotny plik propozycji zachowano bez zmiany bajtów.
- [DOM-CRM-002 i DOM-CRM-003](crm-status-groups.addition.v1.json): statusy klientów i ich grupy; przy usuwaniu statusu przeniesienie klientów do innego statusu, przy usuwaniu grupy przeniesienie statusów do głównej grupy, ochrona głównych wpisów.
- [DOM-CRM-004](crm-extra-fields.addition.v1.json): definicje pól dodatkowych, ich wartości w profilu klienta oraz odrębny zapis/odczyt pliku.

Źródłem jest zachowane oficjalne HTML wszystkich **11 metod rodziny Clients (CRM)** z 17.10.2026: [kontrakt](../../base-api-client-contracts.v1.json) i [snapshot](../../base-api-client-sources-20261017.json.gz). Przegląd plików z 19.10 zweryfikował rozmiary i SHA każdego HTML, bez ponownego HTTP ani uwierzytelnionego konta Base. Pokrycie nazw tych 11 metod nie oznacza pełnego discovery zalogowanych ekranów CRM, opcji planu/kraju ani odbioru implementacji. Wszystkie cztery nowe wymagania mają status `unverified` / **OPEN**, puste dowody odbioru i `full_goal_acceptance:not_evaluated`.

Niejasności pozostają jawne: tablica kontra obiekt indeksowany ID dla pól dodatkowych, serializacja siedmiu edytorów, dokładne znaczenie limitu pliku „2MB”, wymagane/puste/null pola, szczegółowe kody i mapowanie HTTP błędów oraz domyślna i końcowa strona listy. Nie dopisano API tworzenia definicji pól na podstawie metody ich odczytu. Atomowość lokalnego przeniesienia, restart, utrata ACK i izolacja firm są wymaganiami projektu; nie przypisują Base nieudokumentowanych mechanizmów.

## Zachowanie historii dowodów

Nowe [archiwum](../../evidence-archives/mirakl-v4-20261019/archive.json) zachowuje dokładnie wszystkie osiem mapowań rodzica i ponownie wykorzystuje ich istniejące pliki. Dodaje tylko historyczne `ordinary-local-runtime.ts`: 20676 B, SHA256 `9f900fe402966df6d6864d2840a1f7ca6bc002e0ef64d8fc2e1a6ef105c43ce9`, Git blob `103108883e4787c25187ec3c22b03944b939d81d`. Jest to dokładny plik wskazany przez stare dowody, a nie odświeżony pin aktualnego runtime. Nie zmieniono v1/v2/v3 ani wcześniejszego archiwum.

Walidator dopuszcza rozszerzenie archiwum wyłącznie przy zachowaniu wszystkich mapowań rodzica, ich pochodzenia i lokalizacji zachowanych bajtów. Odmawia usunięcia, zastąpienia oraz zmiany bajtów. Dzięki temu zmiana bieżącego kodu nie niszczy odtwarzalności historycznego zakresu i nie pozwala go przepisać.

## Co nadal jest otwarte

V4 ma `snapshot_kind:partial`, `scope_complete:false`, `acceptance_granted:false`. Wszystkie **33 wcześniejsze luki** pozostają: 11 domenowych, 15 integracyjnych i 7 katalogowych. Nadal wymagają pracy m.in. warianty/import, inwentaryzacja i blokady lokalizacji, opcje zalogowanego konta, głębokość finansów/retencji, bezpieczeństwo i zgodność API oraz operacje konkretnych dostawców. 2052 kody katalogowe i 2060 wpisów dostawców są zachowane oddzielnie; nie stają się działającymi integracjami przez dodanie CRM. Pełny Goal pozostaje otwarty.

Weryfikacja plikowa: `node --test tools/parity/scope-v4-crm.test.mjs tools/parity/evidence-archive.test.mjs tools/parity/scope-freeze.test.mjs`. Obejmuje odtworzenie całego snapshotu rzeczywistym generatorem, wszystkie stare rekordy, źródłowe HTML oraz odmowę zmiany wymagania, usunięcia starego wiersza, obniżenia poziomu dowodu i fałszywej deklaracji kompletności. Nie wykonuje aplikacji, SQL ani HTTP.
