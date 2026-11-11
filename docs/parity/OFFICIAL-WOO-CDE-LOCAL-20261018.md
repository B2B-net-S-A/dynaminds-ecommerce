# Trzy dodatkowe oficjalne sklepy WooCommerce C/D/E

Status: **instalacja, normalny start, HTTPS i natywny admin/REST PASS**.
Podłączenie pięciu firm do aplikacji, importy, synchronizacje, workery i profil
skali pozostają otwarte. Konta zewnętrznych dostawców nie były używane.

## Rzeczywiste wykonanie

Root przygotował nowy prywatny CA i certyfikat localhost/127.0.0.1 przez
OpenSSL/EC prime256v1; sprawdził podpis, issuer, SAN i zgodność klucza.
Bez zmiany zaufania systemowego i bez wyłączania walidacji TLS. Konfiguracje
i klucze są prywatne0600, katalogi0700.

Każdy sklep powstał przez świeżą instalację WordPress7.1.3, WooCommerce11.2.1,
PHP8.3 WASM i oficjalny sterownik SQLite. Reużyto wcześniejsze oficjalne źródła
i wspólne node_modules; nie kopiowano istniejącego sklepu/bazy lub zależności.
Jawna, wcześniej sprawdzona poprawka CLI ogranicza nasłuch do loopback.
Wysyłka maili, zewnętrzne HTTP WordPressa i cron są zablokowane w tych fixture'ach.
To oficjalna aplikacja, odrębna od symulatora protokołu.

Root wykonał osobno bootstrap C25723, D65158 i E98512, każdy EXIT0.
Każdy instalator zamknął swój proces i zapisał własny profil. Następnie Root
uruchomił normalne usługi V4, które potwierdziły OFFICIAL_LOCAL_WOO_RESUMED:

| Sklep | HTTPS | Wewnętrzny PHP | PID | Sesja wykonawcza |
|---|---|---|---:|---:|
| C |localhost:18445|127.0.0.1:19402|14240|82272|
| D |localhost:18446|127.0.0.1:19403|14274|23973|
| E |localhost:18447|127.0.0.1:19404|14409|63825|

Root lsof potwierdził wszystkie sześć nasłuchów wyłącznie127.0.0.1.
Dawne A/B, ich źródła, profile i dane pozostały nietknięte; osobne kontrole
plików przed/po są zgodne. Nie nadajemy tutaj nowego odbioru REST A/B.

## Natywne uwierzytelnianie i REST

Root25700/C,87166/D,47159/E: każde wykonanie EXIT0 i dziewięć żądań.
Każdy sklep osobno potwierdził:

- HTTPS przez przypięte CA, rejectUnauthorized=true, SNI localhost i
  rzeczywisty adres połączenia127.0.0.1.
- Zwykły formularz logowania WP i natywną stronę kluczy WooCommerce.
- Aktualny nonce i użytkownika, jeden natywny POST tworzący klucz read_write;
  pełny ACK i zwrócone poświadczenia zapisane prywatnie przed dalszą pracą.
- Uwierzytelnione odczyty system_status i dokładne wersje7.1.3/11.2.1;
  jawne nested_fields wykluczają obie gałęzie zdalnych probe w kodzie Woo.
- Puste products/orders z x-wp-total=0; brak klucza daje401.
- Zwykły logout z nonce, potwierdzoną odpowiedzią i wyczyszczonym cookie jar.

Łącznie27 żądań,6POST: logowanie i utworzenie klucza na sklep.
Nie tworzono produktów lub zamówień; helper nie wykonuje surowego SQL.
Sama instalacja wykonuje oczywiście natywne zapisy bazy WordPressa.
Nie konfigurowano jeszcze tych sklepów w działającym N11.

## Weryfikacja i zużycie zasobów

Root:14 testów pochodnych modułów,8 testów callerów po przygotowaniu plików
i11 testów adaptera HTTPS PASS,0SKIP. Peer review wykrył przed HTTP, że timeout
socketu nie jest pełnym deadline. Nowy native-rest02 dodaje bezwzględne30s,
czyści timer przy zakończeniu i ma test slow-trickle rzeczywistej funkcji.
Poprzedni helper nie został uruchomiony. Połączenia i zapisy nie mają retry;
utrata potwierdzenia zachowuje wynik nieznany do osobnego uzgodnienia.

Pierwotny test callerów zakładał globalny brak outputu; po rzeczywistym
przygotowaniu Root otrzymał7/8. Zachowano wynik i źródło. Nowy test sprawdza
tożsamości istniejących outputów przed/po i przechodzi8/8 bez usuwania danych.

Root sprawdził pełne27 ACK i hashe odpowiedzi oraz prywatne pliki poświadczeń.
Nowe trzy drzewa sklepów mają618576KiB, około604MiB; cały katalog z dowodami
619740KiB. To pomiar plików, nie gwarantowany limit lub wynik testu skali.
W chwili odczytu host miał68GiB wolnego. Współdzielone zużycie RAM/swap nie jest
przypisane wyłącznie tym usługom i nie potwierdza pojemności platformy.

Docker nie był uruchamiany. Wcześniejsza automatyczna kontrola narzędzia
odrzuciła docker compose config i docker info z powodem „Local Docker is
disabled”, mimo zgody użytkownika. Użyto istniejącej ścieżki host-native.

## Dowody

Katalog: `local-builds/full-base-preview-20261017/official-woo-native-cde-prepared-20261018-01`.

| Artefakt | SHA256 |
|---|---|
| root-final-summary.private.json |fcf178a9b5d76e6e2c35cb4518acaf86d9c749d9713d836180ad4c5255d8c4f7|
| native-c-acceptance01/result.private.json |c0e0ef30fa6647b2c8d6f585b15617993b0e08a0f3f19af47a0c5ebfdaa16de0|
| native-d-acceptance01/result.private.json |240d8fefa93b6044c5e83a93b7d6b8240d35817884ba75f0855237bfff6fc854|
| native-e-acceptance01/result.private.json |76ee9a3bdc453897aa833995afc191cd39ebff140607230553690c4160c8995f|

Następny odbiór: pięć własnych firm i kanałów na wspólnym N11, rzeczywisty
import produktu/zamówienia, zapis stocku i izolacja sklepów; następnie trwały
worker i odporność. Te warunki pozostają OPEN, zgodnie z pełnym Goal.
