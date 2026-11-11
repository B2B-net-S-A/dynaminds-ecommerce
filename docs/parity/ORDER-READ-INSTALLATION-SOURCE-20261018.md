# Dowód instalacji dla odczytu zamówienia — implementacja źródłowa

Status: **SOURCE_IMPLEMENTED_CONTROLLED_TESTS_PASS_RUNTIME_ACCEPTANCE_OPEN**.

Wdrożono źródłową część [wcześniejszego planu](ORDER-READ-ADMISSION-COST-PLAN-20261018.md). Nie wykonano jeszcze porównania czasów rzeczywistych GET, odbioru PostgreSQL ani odbioru nowego wydania. Dokument nie potwierdza progu 500 ms, rozwiązania timeoutu `ordinary187_valid()` ani gotowości split210.

## Zakres zmiany

`getOrder` → prywatny `hydrateOrder` w [domain.ts](../../server/domain.ts) wybiera dedykowany odczyt delivery. [buyer-address.ts](../../server/buyer-address.ts) uzyskuje jednorazowy dowód wyłącznie od [db.ts](../../server/db.ts). Po jego zużyciu wykonuje ten sam odczyt frame i te same obliczenia effective delivery. Dowód zastępuje jedynie powtarzane `available()`; nie poświadcza użytkownika, zamówienia, polityki ani danych biznesowych. Pozostałe odczyty i wywołania bez dowodu zachowują pełny dotychczasowy guard. Dowód RW dla `createOrder` zachowuje istniejący warunek odrzucający RO.

[profile-startup.mjs](../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/profile-startup.mjs) utrzymuje osobny, prywatny cold cut:

- 13 dotychczasowych pełnych seals oraz pełne wiersze `order_merge_delivery209_manifest` i `order_merge_delivery209_projection_basis` — razem 15 singletonów;
- dokładny roster trzech markerów migracji;
- osiem pól obu ról i sześć pól całego rosteru członkostw.

Cold startup blokuje wiersze `FOR SHARE`, wykonuje istniejący pełny `buyer_address_available()` i dotychczasowy proces zatwierdzenia generacji, ponownie porównuje cut, a publikuje go w prywatnym `WeakMap` dopiero po potwierdzonym COMMIT. Nie zmieniono SQL migracji, źródłowych oczekiwań katalogu, ACL ani limitu 8 s.

## Granice autoryzacji i świeżości

Każda rzeczywista zarządzana `tenantReadTx` nadal rezerwuje fence przed snapshotem, otwiera `REPEATABLE READ READ ONLY` i weryfikuje pełny zatwierdzony stamp. Tylko jej faktyczny klient puli otrzymuje prywatną tożsamość transakcji. Wystawienie dowodu porównuje świeży pełny cut 15 wierszy, markerów i ról z zatwierdzonym cold cut w tym samym snapshotcie.

Pełne wiersze obu tabel 209 pozostają obowiązkowe. Właściciel może zmienić je przez replica-mode DML z pominięciem zwykłych triggerów bez zmiany generacji; sam stamp nie zastępuje ich porównania. Hash obejmuje cały natywny wiersz, także payload, JSONB i pozostałe kolumny, a liczba wierszy musi wynosić 1.

Dowód jest związany z klientem, tenantem, rzeczywistą bramką, prywatną tożsamością transakcji, bazą, backend PID i dokładnym początkiem transakcji. Sprawdzane są RR, RO, rola `dyna_app`, właściciel `postgres`, tenant GUC, `session_replication_role=origin`, UTC i timeout 8 s. Ścieżka RO nie wywołuje `pg_current_xact_id()`.

Dowód jest zużywany przed pierwszym oczekiwaniem; nie można użyć go ponownie. Zakończenie dzierżawy i `finally` runnera usuwają niewykorzystane dowody również po błędzie, COMMIT lub ROLLBACK. Nie ma flagi od klienta HTTP, TTL, globalnego `validated=true` ani cache między transakcjami.

## Weryfikacja i pozostały odbiór

[Focused test](../../tests/order-read-installation.test.mjs) wykonuje rzeczywiste fragmenty źródeł z kontrolowanymi portami transakcji i katalogu. Obejmuje zmienione seals 209 /pozostałe seals, markery i role, fałszywe lub obce dowody, zmianę kontekstu, ponowne użycie, kolejną transakcję, sprzątanie oraz pełny fallback. Cold fixture jest wyłącznie kontrolowanym wejściem testu; nie jest dowodem rzeczywistego startupu PostgreSQL.

- Autor: 10/10 PASS, 0 skip, 116.832417 ms.
- Niezależny przebieg Root: 10/10 PASS, 106.854 ms.
- Wspólny `npm run typecheck`: Root handle 30836, EXIT0.
- Niezależny przegląd wszystkich sześciu plików: GO, bez P1/P2.

Nadal wymagane są rzeczywiste próby odmowy po DML właściciela i zmianie generacji, ról lub kontekstu; pełna równoważność UI/API; oraz porównanie GET na przypiętym wspólnym wydaniu, także z workerem. Payload tabeli209 ma źródłowo 21 756 960 B, a pełny wiersz obejmuje również zapisane reprezentacje JSONB i pochodne. Koszt ich świeżego hashowania pozostaje istotną niewiadomą pomiarową. Żaden wynik testu źródłowego nie zamyka odbioru wydajności ani nadrzędnego Goala.
