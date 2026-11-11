# Trwałe polecenia konfiguracji synchronizacji ofert — Source214

**Kod, testy kontrolowane i niezależna kompilacja schematu PASS. Normalna
aktualizacja N17 oraz lokalny odbiór Chrome/API również PASS.**
To etap pełnej automatyki; nie uruchamia automatycznego importu ani wybranego
wykonawcy zapisów stanów/cen. Działający N17 ma schemat214.
[Odbiór N17 i granice](OFFER-SYNC-N17-LOCAL-20261019.md).

## Zmiana

Panel zapisuje ustawienia przez polecenie z trwałym client_key, pełną treścią
oraz tożsamością firmy, administratora i kanału. Migracja214 dodaje niezmienny
journal z RLS i uprawnieniami SELECT/INSERT. Konfiguracja oraz wynik polecenia
są zatwierdzane w tej samej transakcji. Zachowano dotychczasowe polityki
providerów, zgodę na zapisy zewnętrzne, CAS i zatrzymywanie wyłącznie wskazanych
oczekujących prac. Dotychczasowy PATCH korzysta ze wspólnej funkcji konfiguracji.

Po utracie odpowiedzi panel zachowuje oryginalną próbę i blokuje kolejne
ustawienia. Odczyt wyniku nie ponawia konfiguracji i korzysta z rzeczywistej
transakcji READ ONLY oraz bieżącej roli administratora. Anulowanie nieznanego
polecenia zapisuje tombstone, bez zmiany konfiguracji lub zadań; późno docierający
oryginał zwraca anulowanie. Jeżeli pierwotny zapis już nastąpił, anulowanie
zwraca jego oryginalny wynik i nie cofa zdrowej konfiguracji.

sessionStorage zachowuje próbę karty, wspólny localStorage mirror ujawnia ją
innym kartom, a WebLock serializuje operacje. Uszkodzenie lub odmowa storage
blokuje wysłanie. Historyczny ACK służy uzgodnieniu; aktualne ustawienia zawsze
są odczytywane ponownie. Zmiana firmy/użytkownika ukrywa poprzedni widok.

Nowe trasy zwykłej sesji administratora:

- POST `/api/integrations/:id/offer-sync/commands`;
- POST `/api/integrations/:id/offer-sync/commands/observe`;
- POST `/api/integrations/:id/offer-sync/commands/cancel`.

Obserwacja jest dozwolona w podglądzie tylko do odczytu; globalna polityka
aplikacji dopuszcza wyłącznie tę dokładną trasę POST obserwacji. Zapis i anulowanie
wymagają trybu zapisu. Klucze API i principal source=api nie obsługują tych tras.

## Weryfikacja źródeł

Root:87 testów backendu, tras, zasobów, migracji i pełnych porównań schematu
PASS,0 SKIP. Oddzielnie15 testów rzeczywistego komponentu React i custody
PASS,0 SKIP. Typecheck całego projektu EXIT0. Testy obejmują obie kolejności
configure/cancel, utratę ACK obu operacji, równoległe karty, rollback po odmowie
journalu, świeże odebranie uprawnień, obcą firmę/kanał, uszkodzone ACK,
zmianę tożsamości oraz odmowę zapisów w trybie READ ONLY.

Są to testy kontrolowane z zamkniętymi portami IO, bez rzeczywistych żądań
biznesowych do aplikacji lub dostawcy. Nie zastępują lokalnego odbioru wydania.

## Niezależna kompilacja PostgreSQL

Root uruchomił pełny program poprzedników w nowej pustej bazie na istniejącym
lokalnym PostgreSQL57084. Pełny katalog przed214 jest identyczny z wcześniej
odebranym Source213:40943 rekordy. Migracja214 dodaje43 deskryptory, nie zmienia
ani nie usuwa żadnego wcześniejszego deskryptora. Katalog po214:40986 rekordów.

Przed i po214 wykonano po siedem rzeczywistych kontroli: ordinary187_valid,
buyer_address_guards, order_merge_delivery209_valid, return_credit206_guards,
ordinary188_structure_valid, return_credit211_metadata_valid oraz
large_import173_valid. Wszystkie14 TRUE przy SQL8s/client9s; najdłuższa6191ms.
Nie podnoszono limitu odczytów. Budżet120s dotyczył wyłącznie DDL.

ROLLBACK, zamknięcie obu klientów, zero połączeń przed usunięciem własnej
bazy, jej nieobecność po DROP i zachowanie pełnych ról/membership potwierdzone.
Bez COMMIT i bez dotykania bazy działającej aplikacji.

- SQL214:1527B, `0da356ba9420a2c72fd27b3ef2e31a2459a55283ddf3964a6b34d034b99b9679`.
- Wynik kompilacji:107768B, `4ba734f88fb4ad476feeb4664cc2ada0d03d2fc2bf22f9b18abf7da1cf80f2be`.
- Niezależny pełny inverse:1927B, `1600012dff3af6919658829677bceb0f4a94175bfdef4f45de519ea345cb605a`.

Pliki znajdują się w lokalnym preview pod
`offer-sync214-source-root-20261019-01`. Stały kontrakt zawiera dokładne43
rzeczywiste deskryptory. Niezależna kontrola pełnych plików potwierdziła
40986→40943→40879→40640 przez niezmienione odwzorowania214/213/212.
Wpięto dokładny zasób SQL i marker migracji do normalnego startu; testy odrzucają
niepełny schemat, inne ACL/RLS/FK i zmienione bajty zasobu.

## Następne bramki

Wspólne wydanie, pełną kontrolę pakietu, normalną aktualizację z zachowaniem
danych oraz zapis i odczyt wyniku przez Chrome/API odebrano osobno w N17.
Anulowanie przed spóźnioną konfiguracją również potwierdzono na działającej
aplikacji. Dopiero osobny wybrany executor i odbiór rzeczywistych zapisów domkną
automatyczną synchronizację.
Automatyczne importy, katalog APPLY, odporność procesu, skala i pełny Goal OPEN.
