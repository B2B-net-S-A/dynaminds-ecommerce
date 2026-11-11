# Plan ograniczenia kosztu admission przy odczycie zamówienia

Status: **SOURCE_REVIEW_PLAN_NOT_IMPLEMENTED_NOT_BENCHMARKED**.

To przegląd źródeł i warunków bezpiecznej zmiany, bez pomiaru poszczególnych funkcji, SQL, HTTP ani implementacji. Commit `32c9522` przenosi trzy GET harmonogramów do `tenantReadTx`; nie obejmuje GET zamówienia ani nie rozwiązuje timeoutu `ordinary187_valid()`.

## Wykonywana ścieżka

GET `/api/orders/:id` w [app.ts](../../server/app.ts) używa `tenantReadTx`, a następnie `hydrateOrder` w [domain.ts](../../server/domain.ts). `effectiveDeliveryInTx` → `effectiveDeliveryWithInstallationInTx` → `available` w [buyer-address.ts](../../server/buyer-address.ts) wykonuje `buyer_address_available()` przy odczycie bez prywatnego dowodu instalacji. Funkcja SQL z [166](../../server/166_buyer_address_sidecar.sql) wywołuje `buyer_address_guards()`; aktualna definicja w [209](../../server/209_order_merge_delivery_inheritance.sql), od linii 451, rozpoczyna się od pełnych `order_merge_delivery209_valid()` i `partial_sale204_valid()`, następnie sprawdza własne deskryptory i poprzedników. To konkretny dodatkowy graph admission na ścieżce GET. Sam stos wywołań nie dowodzi kosztu żadnej pojedynczej funkcji.

`tenantReadTx` w [db.ts](../../server/db.ts) już rezerwuje wspólną blokadę `982376` przed snapshotem, otwiera `REPEATABLE READ READ ONLY`, wchodzi do bramki sprawdzającej cały zatwierdzony stamp generacji, ustawia rolę `dyna_app`, tenant GUC i limit 8 s. Te zabezpieczenia pozostają obowiązkowe.

## Domknięcie zależności instalacji

Istniejący `readInstallationCut` w [profile-startup.mjs](../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs), linie 302–364, porównuje poniższe fakty. Zimny startup odczytuje cut, wykonuje pełne `buyer_address_available()`, ponownie zamyka cut i dopiero po COMMIT zachowuje go w prywatnym `WeakMap` (linie 160–204).

| Obiekty | Wymaganie dla nowej ścieżki odczytu |
| --- | --- |
| `local_invoice_manifest`, `fa3_draft_manifest`, `b2b_invoice_upgrade`, `b2b_credit_upgrade`, `credit_source_upgrade_certificate`, `financial_return_upgrade_certificate`, `competitor_observation_manifest` | Siedem pełnych certyfikatów czytanych przez `buyer_address_predecessors()`. Świeże porównanie liczby wierszy i SHA całego natywnego wiersza z zatwierdzonym cold cut; same pola `profile` lub `fingerprint` nie wystarczają. |
| `buyer_address_manifest`, `manual_inventory_off_certificate` | Pełne wiersze używane przez buyer guard i manual projection/projected-definition. Tak samo świeże `count=1` i pełny hash. |
| `catalog_stock_control_manifest`, `catalog_stock_count_manifest`, `catalog_stock_legacy_group_manifest`, `catalog_stock_return_manifest` | Zachować istniejący konserwatywny zakres cut. Łącznie dokładnie 13 seals; mała zmiana odczytu nie powinna go redukować. |
| `migrations`: `152_catalog_stock_control`, `166_buyer_address_sidecar`, `169_manual_inventory_off` | Świeży dokładny roster nazw. Aktywne buyer/manual gałęzie używają markerów 166 i 169; ich brak uruchamia inną ścieżkę instalacji. Cut zachowuje również istniejący marker 152. Te predykaty nie opierają się na `applied_at`. |
| `pg_roles` dla `postgres` i `dyna_app`; całe `pg_auth_members` | Świeże porównanie istniejących ośmiu pól ról i sześciu pól członkostw. Sama generacja nie zastępuje kontroli zmian ról i dziedziczenia. |
| `order_merge_delivery209_manifest`, `order_merge_delivery209_projection_basis` — poza 13 seals | Używane przez valid/checked projection. Mają singleton `TRUE` PK+CHECK, odebrane prawa PUBLIC/`dyna_app`, blokadę UPDATE/DELETE oraz TRUNCATE. Można polegać na ich niezmienności **wyłącznie**, jeżeli pełne deskryptory tabel, ograniczeń, triggerów, funkcji i ACL są objęte rzeczywistym cold validation oraz późniejszą bramką generacji i blokadą DDL. Bez tego dowodu wyłączenie ich ze świeżego cut jest niedopuszczalne. |

**Niezamknięta bramka dla obu tabel209:** ich zwykłe triggery nie mają `ENABLE ALWAYS`. Właściciel z `session_replication_role=replica` może ominąć zwykły trigger przy DML bez zmiany DDL/generacji. Samo sprawdzenie `origin` po stronie późniejszego czytelnika tego nie wyklucza. Domyślny projekt musi więc zachować świeże porównanie pełnych wierszy obu tabel209 w tej samej transakcji albo pełny dotychczasowy guard. Pominięcie wymaga osobnego dowodu obejmującego wszystkie ścieżki zapisu, również właściciela; powyższe deskryptory i blokada DDL same nie wystarczają.

W przejrzanym aktywnym closure buyer209/partial204/manual projection nie znaleziono dodatkowego certyfikatu lub markera poza powyższym zakresem. Historyczne definicje zapisane w literałach JSON/SQL nie są dodatkowymi wykonywanymi odczytami danych biznesowych. Orders, buyer state, receipts, sesje i IAM nadal wymagają bieżących kontroli biznesowych; nie są dowodem instalacji.

## Proponowana osobna zmiana

Wprowadzić odrębny, niepodrabialny dowód instalacji dla odczytu, przechowywany wyłącznie w module-private `WeakMap`. Dowód może powstać tylko z rzeczywiście zatwierdzonego cold startup i aktywnej zarządzanej transakcji po świeżym porównaniu pełnego cut oraz stampu. Związać go z klientem, tenantem, bramką, prywatną tożsamością transakcji, PID i początkiem transakcji; zweryfikować `REPEATABLE READ`, `READ ONLY`, oczekiwaną rolę/właściciela, `session_replication_role=origin`, UTC i limit 8 s. Nie alokować XID przez `pg_current_xact_id()` w transakcji odczytu.

Dowód jest jednorazowy, usuwany również po błędzie i zakończeniu transakcji. Stary stamp, zmieniony cut lub błędne powiązanie oznaczają odmowę. Wywołanie spoza normalnego runtime albo bez dowodu zachowuje pełną dotychczasową ścieżkę `available(c)`. Nie wprowadzać flagi od klienta, GUC z deklaracją zaufania, TTL ani globalnego `validated=true`.

Istniejący `CreatedOrderBuyerInstallation` pozostaje dowodem RW wyłącznie dla createOrder; nie adaptować go przez usunięcie warunku odrzucającego RO. Nie zmieniać frame, identity, RLS, IAM, polityk ani obliczania delivery. Nowy proof zastępuje tylko powtarzane sprawdzenie faktów instalacji. RRRO jest warunkiem projektu; nie wolno przenosić tego uzasadnienia na dowolną transakcję READ COMMITTED ani przepisywać granic VOLATILE.

## Odbiór przed kolejnym wydaniem

- Odmowa dla fałszywego dowodu, obcego klienta/tenanta, ponownego użycia, kolejnej transakcji, nieprawidłowej izolacji i braku rzeczywistego cold startup; sprzątanie po każdym błędzie.
- Odmowa po zmianie całego stampu, release/profile, dirty generation, dowolnego z 13 seals, trzech markerów, ról lub członkostw. Zmiana dowolnej tabeli209 również musi powodować odmowę; sprawdzić osobno DML właściciela z pominięciem zwykłych triggerów. Wyłączenie ochron przez DDL musi unieważnić generację. Bez takiego odbioru nie pomijać świeżego porównania209.
- Równoważny wynik rzeczywistego GET zamówienia, nadal poprawne odmowy tenant/IAM i brak zmiany danych; osobno zachowany pełny fallback i createOrder RW.
- Dopiero potem porównanie rzeczywistych czasów GET na tym samym zestawie danych i przypiętym wydaniu, przy normalnym UI oraz współbieżnym workerze. Test źródłowy lub szybszy helper nie stanowi odbioru produktu ani rozwiązania problemu `ordinary187_valid()`.

Implementacja i odbiór tego planu wymagają osobnego delivery; niniejszy dokument ich nie deklaruje.
