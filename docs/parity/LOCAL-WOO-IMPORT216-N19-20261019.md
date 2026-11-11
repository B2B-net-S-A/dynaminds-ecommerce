# N19: naturalny import jednego zamówienia Local Woo — 19.10.2026

Status: **lokalny odbiór importu E i zachowania danych PASS**. Raport nie oznacza pełnej zgodności z Base ani odbioru interfejsu CRM217. Goal pozostaje otwarty.

## Wydanie i zwykła aktualizacja

N19 zbudowano z commita `f647c80a7240e02f923824bbc40d6b3643c4bdf1`. Manifest wydania ma SHA-256 `d20b86eb673bfc2443ac703745a2af51a36fffc08974c5dd4ce60f878b6c36fe`: 392 pliki, 99 042 851 B, zachowane limity 16 MiB na plik i 96 MiB na pakiet. Instalowania zależności nie wykonywano. Zwykły supervisor zatrzymał N18 i uruchomił N19 na tym samym lokalnym DB, konfiguracji i rejestrze pięciu firm; globalne workery i split210 pozostały wyłączone.

- [Rzeczywisty build i emisja](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/full217-n19-release-prepared-agent-20261019-01/root-build-emission.private.json>): SHA-256 `54e26f2235b561671ee8fe3dbf1806d1f3f750ce59775c2e7399cb6e7a4b5bef`.
- [Rzeczywiste READY i health](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/full217-n19-release-prepared-agent-20261019-01/root-health-ready.private.json>): SHA-256 `c585666d29a367b6fd7bd0d14ea4ddb6c016f1bb45db1c864a39ccf3b2578fa1`.
- [Odbiór aktualizacji](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/full217-n19-release-prepared-agent-20261019-01/upgrade01/result.private.json>): SHA-256 `c44a29642c05dbc7fa32763a4f6888f8658137fc749c4075a9611a01712b073f`.

Aktualizacja dała 641→644 tabele, w tym trzy nowe tabele importu216. Zachowano pełne hashe 638 starych tabel. Dla `crm_extra_fields` sprawdzono dokładne nowe wartości `version=1`, `archived_at=NULL`, a po usunięciu wyłącznie tych dwóch kluczy z projekcji porównawczej odtworzono pełny stary hash wszystkich 315 definicji. Stare migracje zachowano w całości; dozwolona zmiana generation dotyczyła wyłącznie `generation`, `validated_generation` i przypięcia wydania. Obserwator działał w RRRO, bez zapisów, z potwierdzonym ROLLBACK i zamknięciem klienta.

## Jeden nowy zakup E i naturalne wykonanie

Root włączył import E przez zwykły interfejs, osobno od harmonogramu odczytu. Następnie pojedynczy autoryzowany POST do oficjalnego lokalnego WooCommerce E utworzył zamówienie **#12** na istniejący zmapowany produkt #10, ilość 1. Odpowiedź 201 oraz świeży GET zapisano przed dalszym odbiorem. TLS używał własnego CA, dokładnego originu `https://localhost:18447` i połączenia loopback; nie użyto zewnętrznego konta dostawcy ani ponowienia POST.

- [Jedyny POST i odczyt utworzonego zamówienia](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/woo-import216-n19-local-e-prepared-agent-20261019-01/bound01/create01/result.private.json>): SHA-256 `38019ba4644a8ff20be4deb3a4f274df9bd8bd2fe7b8724001029f448041bbd2`.
- [Końcowy odbiór 21 GET / 0 POST](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/woo-import216-n19-local-e-prepared-agent-20261019-01/root-closing03/result.private.json>): SHA-256 `ee37c002d78fc120c4090a7425acf4e16019cb3664adaec45ddca7cdacc03c6d`.

Zwykły worker odczytu utworzył nową próbę w zachowanym przyszłym terminie; pierwszy i drugi naturalny cykl osiągnęły DONE z potwierdzonym łańcuchem dispatch ACK. Import216 utworzył jeden inbound, jeden receipt DONE i jedno lokalne zamówienie `b41b41b4-5919-493c-b434-91de05b36ad8`. Drugi cykl zwrócił tę samą pełną odpowiedź receipt oraz te same całe DTO zamówienia, płatności i zapasu — bez duplikatu.

Lokalny zapas zmienił się z **8 / 1 / 7** na **8 / 2 / 6**: ilość fizyczna / rezerwacja / dostępna; wersja wzrosła dokładnie o 1. Nowa rezerwacja dotyczy jednej sztuki. WooCommerce zmienił stock produktu #10 z 7 na 6 oraz `total_sales` z 1 na 2; porównanie dopuszczało jeszcze wyłącznie daty modyfikacji tego produktu i udokumentowaną projekcję `related_ids`. Stare pełne DTO zamówień Woo zachowano po wyłączeniu wyłącznie nowego #12.

Płatność źródłowa to dokładnie **1230 jednostek minor = 12,30 PLN**, jedna pozycja `source_import`, z kluczem `source-import:<inbound_id>` i saldem należności 0. To zapis informacji z lokalnego Woo (`processing`, `bacs`, `set_paid=true`), a nie potwierdzenie rozliczenia bankowego. Zachowano pełne stare DTO zamówienia i płatności każdej z pięciu firm oraz zapas pozostałych czterech firm.

Odbiór dwóch wskazanych cykli nie oznacza, że wykonano tylko dwa: przed końcową pauzą E wykonało **łącznie cztery** nowe naturalne odczyty, wszystkie DONE/ACK. Końcowy pełny snapshot zawiera cztery nowe jobs, integration_runs, occurrences i dispatches; pozostaje jeden nowy inbound/import/receipt/zamówienie/płatność. UI zakończył z odczytem E w wersji **4**, importem E w wersji **2**, oba wyłączone. Stara konfiguracja stock pozostała wyłączona.

- [UI: import DONE i końcowa pauza](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/full217-n19-release-prepared-agent-20261019-01/ui-E-import-DONE-paused.root.png>): SHA-256 `d0131d892e54ab82ea5989abc074de78237ac53f711acc7ed7dd04b5d9f99fb0`.

## Zachowanie całej bazy N19

- [Końcowy snapshot 644 tabel](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/full217-n19-release-prepared-agent-20261019-01/final-ui01/result.private.json>): SHA-256 `8fa2b8f31fbc5ba301df8bad8a56d7ca6254658d0e8a3cd5968bdb35aba31542`.
- [Rzeczywiste globalne uzgodnienie](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/full217-n19-release-prepared-agent-20261019-01/root-global-reconciliation02.private.json>): SHA-256 `fd7c25196d5ead8ff55a27cbaacf26d79110b96bc896884a10547d971ebc3c1a`.

Wszystkie 644 aktualne hashe ponownie porównano z końcowym snapshotem. **622 tabele są w całości identyczne**, a 22 zmienione rozliczono dokładnie. Stare dane CRM, 140 sesji, 709 jobs oraz wszystkie stare inboundy, historie i potwierdzenia zachowano. Spośród 3912 zapisanych starych wierszy RAW 3910 pozostało dosłownie identycznych; dwa pozostałe mają jawnie ograniczone różnice: kanał E wyłącznie `last_sync_at`/`next_sync_at`, kontrolka odczytu E wyłącznie `version` 2→4 i `updated_at`. Pełne stare migracje oraz generation pozostały identyczne po biznesowym teście N19.

Osiem projekcji wyłączało tylko nowe wiersze wskazane dokładnym nowym order UUID, a w `purchasing_stock_changes` wyłącznie nowy marker #1093. Dwie dalsze projekcje odwróciły dokładnie jeden krok `reserved/available/version` zapasu konkretnego produktu E oraz `used+1` tylko dla limitu E/orders/październik2026. Wszystkie dziesięć pełnych hashy i liczności projekcji odtworzyło stare wartości. Nie zastosowano wyłączenia całej firmy ani tabeli. To wyłącznie projekcje SELECT: **0 zapisów**, RRRO, timeout SQL 8 s / klient 9 s, potwierdzone ROLLBACK/end.

Pierwszy czytnik globalny zakończył się 42703 przez błędne założenie kolumny `id` w `reservation_locations`; wynik zachowano jako historyczny FAILED. Wersja02 użyła rzeczywistego `order_id`. Czytnik wykonano jako literalne polecenie Root zapisane w transkrypcie, nie jako wcześniej przypięty plik operatora. Poprzedni observer E również zachowano jako FAILED: jego błędne porównanie wersji zapasu 1→2 nie oznaczało niepowodzenia importu; dalszy odbiór był tylko odczytem, bez ponowienia utworzenia lub importowania zamówienia.

## Osobny błąd CRM217 i granice

W N19 zwykły ekran edycji pól CRM217 zwrócił **HTTP500**. Rzeczywisty odczyt roli `dyna_app` potwierdził SQLSTATE **42501**: tabela pól była czytelna, ale owner-only `migrations` nie. Nie jest to przyjęty odbiór UI217.

- [HTTP500 CRM217](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/full217-n19-release-prepared-agent-20261019-01/root-crm217-http-failure.private.json>): SHA-256 `82e9ee92f2b43c24b6eea69b86e41eea54564995f58b49230e91d4922b8a7a6d`.
- [Rzeczywiste uprawnienia i SQLSTATE42501](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/full217-n19-release-prepared-agent-20261019-01/root-crm217-read-failure.private.json>): SHA-256 `e85aee22685af96be4a8ad17c71728f8ebb51245924bf6b3e1fefdf0fd2af7da`.

Poprawka source `3212ef1dcb154b02d149cf9b8f467d55071242f5` wykrywa capability przez dokładne metadane katalogowe, bez odczytu dziennika migracji i bez zmiany DDL lub grantów. Osobny rzeczywisty test roli potwierdził sześć kształtów schematu. Późniejszy odbiór Chrome/API CRM217 oraz naturalnego zapisu stock E opisuje [raport N20](CRM217-N20-LOCAL-20261019.md); nie są one częścią odbioru wydania N19.

W N19 nie odebrano automatycznego executora stock. Import innych firm/produktów/wariantów, awarie i restart importu, skala, zgodność Base API oraz pełna zgodność wszystkich domen nadal są **OPEN**. Samo READY i obecność workerów nie stanowią ich odbioru. Raport dotyczy lokalnego oficjalnego WooCommerce E, nie usług live dostawców.
