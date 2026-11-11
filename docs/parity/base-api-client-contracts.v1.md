# Kontrakty API Base — klienci CRM, wersja1

Przegląd17.10.2026 obejmuje wszystkie **11 metod rodziny Clients (CRM)** z przypiętego indeksu204 metod. [Pełny kontrakt JSON](base-api-client-contracts.v1.json) zawiera45 parametrów wejścia i76 zadeklarowanych pól wyniku, typy, ograniczenia, źródła oraz proponowane przypadki odbioru. To przegląd dokumentacji; implementacja i odbiór pozostają niepotwierdzone.

Pobrano wyłącznie publiczne strony dokumentacji. Nie wykonywano żądań konta, nie używano tokenów, nie zmieniano runtime ani scope.v2. Dokładne HTML11 stron zachowano w [jednym snapshotcie](base-api-client-sources-20261017.json.gz):109499B, SHA256 `b1f15949d2101be724136ec8ea561cfe26a518e7eb8c31314deda7c2a56a7b18`. JSON przypina osobny URL, datę UTC, rozmiar i SHA256 każdej strony. Indeks pozostaje niezmieniony.

## Wspólny transport i oznaczenia

[Indeks oficjalnego API](https://api.baselinker.com/) opisuje POST do `https://api.baselinker.com/connector.php`, formularz z `method` i JSON w `parameters`, zalecany nagłówek `X-BLToken`, UTF-8 oraz100 żądań/minutę. Token formularzowy jest przestarzały. Znak `+` w base64 wymaga kodowania `%2B` w formularzu. Zakres rozliczania limitu i jego algorytm nie są dopowiadane.

Każda strona metody opisuje JSON `status: SUCCESS|ERROR`; przy błędzie dodatkowe `error_message` i `error_code`. Brakuje indywidualnych kodów błędów, ich typów, mapowania HTTP oraz kontraktu retry. Nazwane odmowy biznesowe poniżej nie oznaczają odgadniętego kodu HTTP.

**Wymagalność:** `required:false` zapisano wyłącznie przy jawnej opcjonalności lub opisanym pominięciu. `required:null` oznacza brak formalnego określenia, także dla nieoznaczonych identyfikatorów celu. Przykład nie rozstrzyga pełnej wymagalności. Nie zakładamy obsługi `null`, pustych wartości, nieznanych parametrów ani domyślnych wartości poza opisanymi wprost.

## Jedenaście metod

| Oficjalna metoda | Wejście i semantyka | Wynik / ograniczenia |
|---|---|---|
| [addCrmClient](https://api.baselinker.com/index.php?method=addCrmClient) |24 pola. `crm_client_id` pominięte/0 tworzy, dodatnie aktualizuje. Kontakt, `status_id`, `star`0–5, `contractor_id`, `notes`, osobne dane `invoice_*`/`delivery_*`, `custom_extra_fields`. Aktualizacja zachowuje pominięte pola. | `crm_client_id`. Wymiary varchar w JSON; NIP bez spacji/myślników; kraje ISOalpha2. Pole dodatkowe usuwa się pustym tekstem. Plik: `title`≤40, `file: data:<base64>`, limit2MB bez doprecyzowania liczby bajtów. |
| [deleteCrmClient](https://api.baselinker.com/index.php?method=deleteCrmClient) | `crm_client_id`. | Tylko wspólny status; zamówienia pozostają nienaruszone. Wynik ponownego usunięcia nieopisany. |
| [getCrmClientData](https://api.baselinker.com/index.php?method=getCrmClientData) | `crm_client_id`, jawnie opcjonalne `include_custom_extra_fields`, domyślnie false. | Profil w głównym obiekcie, łącznie z `notes`. Wartości dodatkowe warunkowo; plik zwraca `title`/`url`, nie upload base64. |
| [getCrmClientExtraFields](https://api.baselinker.com/index.php?method=getCrmClientExtraFields) | Brak zadeklarowanych parametrów; przykład `{}`. | `extra_fields`: `extra_field_id`, `name`, `editor_type`; opcjonalne `options` dla select/checkbox/radio. Siedem typów edytora wymieniono w JSON. Kształt kolekcji jest sprzecznie opisany. |
| [getCrmClients](https://api.baselinker.com/index.php?method=getCrmClients) | `page`; filtry exact ID/status oraz partial email/telefon/login/firma/NIP/nazwa odbiorcy faktury. | `clients[]`, bez notes i custom fields; maksymalnie100, strony od1. Brak opisanych total/has_more, sortowania, domyślnej strony i reguły końca. |
| [addCrmClientStatus](https://api.baselinker.com/index.php?method=addCrmClientStatus) | Opcjonalny `status_id` wybiera aktualizację; `name`≤30, `color`≤7 hex, opcjonalny `group_id`. | `status_id`. Pominięcie grupy przy tworzeniu wybiera główną; przy aktualizacji zachowuje przypisanie. Wymagalność nazwy/koloru nieoznaczona. |
| [addCrmClientStatusGroup](https://api.baselinker.com/index.php?method=addCrmClientStatusGroup) | Opcjonalny `group_id` wybiera aktualizację; `name`≤15. | `group_id`. Reprezentacji słowa „empty” dla integer ID dokumentacja nie precyzuje. |
| [deleteCrmClientStatus](https://api.baselinker.com/index.php?method=deleteCrmClientStatus) | `status_id`, różny od niego `target_status_id`. | Przenosi wszystkich klientów do statusu docelowego. Główny status nie podlega usunięciu. |
| [deleteCrmClientStatusGroup](https://api.baselinker.com/index.php?method=deleteCrmClientStatusGroup) | `group_id`. | Statusy przenoszą się do głównej grupy. Główna grupa nie podlega usunięciu. |
| [getCrmClientStatusGroups](https://api.baselinker.com/index.php?method=getCrmClientStatusGroups) | Brak zadeklarowanych parametrów. | `status_groups[]`: `group_id`, `name`, `is_main_group` jako integer0/1. |
| [getCrmClientStatuses](https://api.baselinker.com/index.php?method=getCrmClientStatuses) | Brak zadeklarowanych parametrów. | `statuses[]`: `id`, `name`, `color`, `group_id`, `is_primary` jako integer0/1. Identyfikator wyniku ma nazwę `id`, nie `status_id`. |

Poza `getCrmClients` dokumentacja nie deklaruje parametrów paginacji. Nie dopisano własnych limitów ani gwarancji kompletności list.

## Konkretne niejasności dokumentacji

1. Strona dodatkowych pól wspomina `include_custom_extra_fields` dla `getCrmClients`; sama strona listy nie zawiera tego argumentu i wyklucza dodatkowe pola. Jawny argument występuje w `getCrmClientData`.
2. `extra_fields` opisano jako kolekcję według ID, ale przykład jest tablicą obiektów. `custom_extra_fields` nazwano array, podczas gdy wejściowy przykład jest obiektem z kluczami ID. JSON zachowuje te rozbieżności.
3. Nie określono pełnej wymagalności, błędów brakującego ID, serializacji wartości wszystkich edytorów, spójności stron ani idempotencji tworzenia. Nie traktujemy aktualizacji przez ID jako bezpiecznego ponowienia nieznanego wyniku tworzenia.

## Mapowanie do obecnego kodu i następna implementacja

Przeszukanie `server/web` TypeScript/TSX nie znalazło tych nazw metod ani dispatchu `connector.php`/`X-BLToken`. Poniższe moduły dostarczają sąsiednich funkcji; nie potwierdzają kontraktu CRM:

- `server/schema.sql`: dane kupującego należą do zamówienia. `server/buyer-address-routes.ts` i `web/buyer-address.tsx` zmieniają dostawę konkretnego zamówienia; potrzebny jest niezależny profil klienta i stabilne mapowanie Base integer ID↔lokalna tożsamość.
- `server/customer-messages.ts` i `server/customer-message-routes.ts`: notatki/wątki oraz open/closed dotyczą rozmowy przypiętej do zamówienia. Nie zastępują profilu, gwiazdek ani statusów i grup CRM.
- `server/order-status.ts`: statusy zamówień nie są słownikiem statusów klientów. Usunięcie statusu CRM wymaga atomowej migracji klientów; usunięcie grupy migracji statusów, z ochroną głównych wpisów.
- `server/b2b.ts`: własne konta B2B są kandydatem powiązania; nie dowodzą zgodności `contractor_id` Base Connect. Pola niestandardowe i pliki wymagają osobnego kontraktu klienta.

JSON przypina hash każdego przejrzanego pliku kodu i proponowane przypadki odbioru per metoda. Najpierw należy rozstrzygnąć wymienione niejasności, następnie wdrożyć warstwę zgodności i normalny UI/API, a dopiero później przyznawać dowody lokalne/konta. Sam ten dokument nie zamyka wymagania funkcjonalnego ani Goala.
