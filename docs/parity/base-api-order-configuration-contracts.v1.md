# Base API — płatności i konfiguracja statusów zamówień

Stan dokumentacji publicznej: 2026-10-17. To opis źródeł, nie odbiór implementacji, protokołu ani konta. Brak zmian runtime, scope i wywołań konta.

Całe rzeczywiste grupy indeksu204: Orders / Payments (2) oraz Orders / Statuses (8), razem10 metod. Nie ma grupy Order fields; getOrderExtraFields należy do Other9 i pozostaje poza tym opracowaniem. Pozostałe grupy Orders nie są tu oznaczone jako kompletne.

Snapshot: `base-api-order-configuration-sources-20261017.json.gz`, SHA256 `9f36c3d13f99fb95c8b9cb54390f02dfc2a47bf800e6cb45b900849f6481d559`, 98555 B. Każda strona ma własny URL, czas, kod HTTP, rozmiar i SHA w JSON; tabela jest zachowana 1:1, a pola prozy wyodrębnione po separatorach DOM BR/LI/P/DIV.

24 wierszy wejścia, 24 wyjścia, 7 pól wyjścia z prozy. Brak znacznika required nie oznacza wymagania; nieopisane wartości, błędy, paginacja i idempotencja pozostają unknown.

| Metoda | Grupa | Wejście / wyjście / pola prozy | Źródło |
|---|---|---:|---|
| getOrderPaymentsHistory | Payments | 2 / 2 / 7 | [oficjalna strona](https://api.baselinker.com/index.php?method=getOrderPaymentsHistory) |
| setOrderPayment | Payments | 5 / 1 / 0 | [oficjalna strona](https://api.baselinker.com/index.php?method=setOrderPayment) |
| addOrderStatus | Statuses | 8 / 2 / 0 | [oficjalna strona](https://api.baselinker.com/index.php?method=addOrderStatus) |
| addOrderStatusGroup | Statuses | 2 / 2 / 0 | [oficjalna strona](https://api.baselinker.com/index.php?method=addOrderStatusGroup) |
| deleteOrderStatus | Statuses | 2 / 1 / 0 | [oficjalna strona](https://api.baselinker.com/index.php?method=deleteOrderStatus) |
| deleteOrderStatusGroup | Statuses | 1 / 1 / 0 | [oficjalna strona](https://api.baselinker.com/index.php?method=deleteOrderStatusGroup) |
| getOrderStatusGroups | Statuses | 0 / 5 / 0 | [oficjalna strona](https://api.baselinker.com/index.php?method=getOrderStatusGroups) |
| getOrderStatusList | Statuses | 0 / 8 / 0 | [oficjalna strona](https://api.baselinker.com/index.php?method=getOrderStatusList) |
| setOrderStatus | Statuses | 2 / 1 / 0 | [oficjalna strona](https://api.baselinker.com/index.php?method=setOrderStatus) |
| setOrderStatuses | Statuses | 2 / 1 / 0 | [oficjalna strona](https://api.baselinker.com/index.php?method=setOrderStatuses) |

## getOrderPaymentsHistory

Historia może zawierać wiele wpisów po dopłatach, zmianie wartości zamówienia i ręcznej edycji płatności. Domyślny odczyt zwraca tylko wpisy z external_payment_id; nie jest pełną historią rozrachunku.

show_full_history=true obejmuje także zmiany wartości zamówienia i ręczne edycje. Brak identyfikatora wpisu, paginacji, limitu, kolejności i stabilnego kursora.

Typy float/int w opisie pól są w przykładzie zwracane jako JSON strings; zachowujemy tę rozbieżność bez wymyślania kanonicznej reprezentacji.

Źródło: [oficjalna dokumentacja](https://api.baselinker.com/index.php?method=getOrderPaymentsHistory), pobrano `2026-10-17T21:03:38.270112+00:00`, SHA256 `2a754f7f049521b9d6e8da3b7c7c02570567d6dde42a1f3af43381d4a39c949e`, 50039 B.

Odbiór do wykonania: Default external-ID-only subset versus show_full_history=true on value changes/manual edits; preserve source fields, numerical wire representation conflict and complete authorized history.

## setOrderPayment

payment_done zastępuje aktualną łączną zapłaconą kwotę; nie dodaje kwoty do poprzedniego salda. Opis wstępny add a payment nie zmienia tej jawnej reguły pola.

Gdy kwota jest równa wartości zamówienia, zamówienie zostaje oznaczone jako opłacone. Zachowanie dla obniżenia/ujemnej kwoty/nadpłaty, waluty i zaokrągleń nie jest podane.

external_payment_id opcjonalny; nie opisano jego unikalności ani idempotencji. Brak klucza klienta, expected version i uzgodnienia wyniku nieznanego po timeout.

Źródło: [oficjalna dokumentacja](https://api.baselinker.com/index.php?method=setOrderPayment), pobrano `2026-10-17T21:03:38.773590+00:00`, SHA256 `5735e19fcd77dbffe919b3622e65b7a560ebb394a59cee7dfe9d5d69aab62f9e`, 49446 B.

Odbiór do wykonania: Set totals0→100→70→order value, proving replacement rather than delta; verify paid state, history, external ID behavior, decimals/currency and exact unknown-outcome reconciliation before retry.

## addOrderStatus

status_id pominięte lub puste tworzy, podane aktualizuje. Reprezentacja pustego int nie jest sprecyzowana. Nowy status jest dopisywany na końcu listy w swojej grupie.

name_for_customer puste ukrywa status w historii klienta, a nie usuwa statusu. type jest kategorią analityczną 0..6, nie dowodem efektów fizycznych lub finansowych.

group_id pominięte przy tworzeniu wybiera grupę główną, przy aktualizacji zachowuje grupę. Pominięcie innych pól przy aktualizacji nie ma takiej samej jawnej reguły.

Źródło: [oficjalna dokumentacja](https://api.baselinker.com/index.php?method=addOrderStatus), pobrano `2026-10-17T21:03:39.270681+00:00`, SHA256 `40423835e41d60e50f736d4cebab7b7b204032a7562cc26d3bae7ff7ee42b9d4`, 50826 B.

Odbiór do wykonania: Create versus update with typed ID and default/preserved group; insertion order, analytics type0..6,short name and blank customer-name history visibility.

## addOrderStatusGroup

group_id pominięte lub puste tworzy grupę, podane aktualizuje. Grupy wizualnie organizują statusy w bocznym panelu.

Brak jawnej reguły unikalności nazwy, kolejności grup, pustego ID i aktualizacji częściowej.

Źródło: [oficjalna dokumentacja](https://api.baselinker.com/index.php?method=addOrderStatusGroup), pobrano `2026-10-17T21:03:39.750214+00:00`, SHA256 `e79285464fe975a21d52cafb1e076cead13c635a80c3f7912b52eb767df42051`, 48986 B.

Odbiór do wykonania: Create versus update visual group and returned stableID; determine duplicate names, omission/blank and ordering without assumed group/status interchangeability.

## deleteOrderStatus

Wszystkie zamówienia w usuwanym statusie migrują do target_status_id; status domyślny nie może być usunięty. Cel musi być inny niż usuwany status.

Brak opisu atomowości migracji, automatyzacji, powiadomień, historii, rezerwacji, efektów kanałów i uzgodnienia po nieznanym wyniku.

Źródło: [oficjalna dokumentacja](https://api.baselinker.com/index.php?method=deleteOrderStatus), pobrano `2026-10-17T21:03:40.285819+00:00`, SHA256 `8cedbc1a2775553baa5681f97692505df9af2b12b20c07749d4497a70c175453`, 48920 B.

Odbiór do wykonania: Own non-primary status with multiple orders: migrate every order to different target and delete definition; refuse primary/equal/foreign target, inspect automation/history/notifications and atomic failure.

## deleteOrderStatusGroup

Statusy usuwanej grupy są przenoszone do grupy głównej; same statusy nie są opisane jako usuwane. Grupy głównej nie można usunąć.

Brak opisu pozycji przeniesionych statusów, migracji zamówień, atomowości i ponownego usunięcia.

Źródło: [oficjalna dokumentacja](https://api.baselinker.com/index.php?method=deleteOrderStatusGroup), pobrano `2026-10-17T21:03:40.932770+00:00`, SHA256 `06ae0aec7426f8eda97e8393f6db366d22801e257e52e29f636ee6778d4c82ae`, 48646 B.

Odbiór do wykonania: Own group containing multiple statuses: retain statuses and move them to main, refuse main deletion; inspect order history, ordering and atomic unknown result.

## getOrderStatusGroups

Lista grup ma group_id, name i is_main_group (int 0/1). Nie ma parametrów paginacji, limitu ani gwarancji kolejności/kompletności.

Źródło: [oficjalna dokumentacja](https://api.baselinker.com/index.php?method=getOrderStatusGroups), pobrano `2026-10-17T21:03:41.415737+00:00`, SHA256 `b857a67c097bac2d68238bdf197d7a538c95d755296faa72914f53c0603bdd25`, 49131 B.

Odbiór do wykonania: Read each group ID/name/main flag and reconcile list completeness/ordering with documented unknowns.

## getOrderStatusList

Lista własnych statusów ma id/name/color/group_id/is_primary/name_for_customer. Nie zwraca w tabeli short_name/type/comments, mimo że zapis je przyjmuje.

name/color są w odczycie text, a w zapisie varchar(30)/varchar(7); nie ujednolicamy źródłowych typów. Brak paginacji i gwarancji kolejności.

Źródło: [oficjalna dokumentacja](https://api.baselinker.com/index.php?method=getOrderStatusList), pobrano `2026-10-17T21:03:42.114704+00:00`, SHA256 `8d4dc6107070ddb4a2cebf8985c4bd62e5e11b0a2a5c4c5fca987966e7b956ce`, 49902 B.

Odbiór do wykonania: Read each status ID/group/primary/color/customer name and confirm read/write field asymmetries without synthesizing omitted fields.

## setOrderStatus

Zmienia status wskazanego zamówienia na status pobrany z getOrderStatusList. Brak expected version, klientowego klucza, reguł przejść i jawnego opisu efektów ubocznych.

Źródło: [oficjalna dokumentacja](https://api.baselinker.com/index.php?method=setOrderStatus), pobrano `2026-10-17T21:03:42.853405+00:00`, SHA256 `112ae205b517456cbaa6ab7b46f95165b3c4e988458ee01bc27d6f48bc549807`, 48737 B.

Odbiór do wykonania: Assign own/foreign/invalid status, same-status repeat and stale/concurrent transitions; inspect state/history/automation side effects and unknown-outcome readback.

## setOrderStatuses

Ustawia jeden status dla listy order_ids. Brak limitu rozmiaru, reguł duplikatów, atomowości batcha, wyników per element i ponawiania częściowej porażki.

Źródło: [oficjalna dokumentacja](https://api.baselinker.com/index.php?method=setOrderStatuses), pobrano `2026-10-17T21:03:43.347227+00:00`, SHA256 `2a6229a12299e02fee9c93aae58ae29992a66a2a03784e46fd6ec03af4793c33`, 48821 B.

Odbiór do wykonania: Multiple own and foreign/missing IDs, duplicates and invalid target; discover authorized limit, atomicity, partial errors and reconciliation without blind retries.

## Granice mapowania kodu i odbioru

- `payments`: adjacent_own_ledger_not_Base_wire_or_replace_total. Base setter overwrites cumulative paid total; local receipt adds immutable amount with client_key/version/confirmed, kind/currency/reference. Base history defaults to externally identified subset and contains paid_before/paid_after/total_price; local history returns balance/data/next and own entries/reversals, including merge ownership. Local idempotency is not evidence of Base external_payment_id deduplication or wire compatibility.
- `status_definitions`: adjacent_own_workflow_statuses_not_Base_upsert_delete_migration. Own UUID/version/stage/active differs Base int analytics type, group,short_name,customer name,comments and primary. No reviewed own delete route performing documented all-orders target migration. Deactivate is not delete. No proof of insertion order within group or customer history hidden-by-empty-name semantics.
- `status_groups`: Base_status_group_CRUD_not_located_in_reviewed_routes. No own group ID/name/main flag CRUD or delete-to-main migration located in reviewed files. Workflow stage is not a visual status group.
- `order_status_assignment`: adjacent_own_operations_not_Base_single_or_batch_wire. Own set_status stage or set_workflow UUID are separate from one Base int status_id. Own automation batch/run contract is not proof of undocumented Base setOrderStatuses batch atomicity/limit/partial behavior. Remote channel status mapping/queue must not be substituted for local Base status assignment.

W JSON przypięto7 rzeczywistych plików kodu; są to sąsiednie ścieżki lokalne, bez deklaracji Base wire parity. Lokalny ledger dodaje kwoty w minor units, setter Base zastępuje paid total. Lokalne workflow UUID/stage/active nie odpowiadają automatycznie status_id/type/group/primary. Wyłączenie statusu nie zastępuje usunięcia z migracją zamówień.

Każda mutacja wymaga osobnego odbioru zwykłego UI/API/worker i skutków biznesowych, a dokładny wire oraz sandbox/konto osobnego dowodu. Durably zapisany intent, świeże IAM, obcy tenant, błąd częściowy, timeout/429/ACK-loss, odczyt wyniku i recovery muszą być sprawdzone przed ponowieniem. Źródła nie dokumentują klucza idempotencji; external_payment_id nie wolno za taki uznać. Wszystkie implementation_verified/acceptance_granted są false.
