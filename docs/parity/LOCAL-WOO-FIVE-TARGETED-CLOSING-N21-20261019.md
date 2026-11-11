# N21 — końcowy odczyt pięciu własnych firm Woo

**Targeted closing PASS: 37 rzeczywistych GET, pełne DTO pięciu odebranych zamówień, ich płatności i wybranych stanów zgodne z wcześniejszymi odbiorami; wszystkie 20 konfiguracji wstrzymane.** Osobny capture po GET zachował wszystkie 644 liczności i hashe tabel względem stanu po zakończeniu D. Ten wynik nie zamyka ośmiu kryteriów pełnego Goala ani całej automatyki.

Aktywne wydanie podczas odczytu: N21 `5f5bc6267a6ee465f94e30cbf9894eb5c806d4114ffe9ee4114fc0d327ccb814`, schemat `217_crm_field_definitions`, zwykła aplikacja 4105 i własna baza PG03. Przygotowania późniejszych wydań nie są częścią tego odbioru runtime. Wykonanie HTTP i capture należało do Roota; niezależny peer wykonał wyłącznie przegląd plików.

## Rzeczywisty zakres 37 GET

Root wykonał health na początku i końcu oraz po siedem odczytów w każdej firmie A–E: aktualna sesja, inventory snapshot, odebrane nowe zamówienie, jego płatności, harmonogramy odczytu, konfiguracja importu i konfiguracja zapisu stanów. Wszystkie 37 odpowiedzi miało HTTP200. Nie wykonano POST, logowania, SQL bezpośrednio z czytnika, żądania do Woo ani ponowienia operacji biznesowej.

Każda odpowiedź ma zachowany intent oraz surowy ACK z pełnym body base64 i SHA256, zapisany przed oceną statusu i DTO. Niezależny FILE peer sprawdził rozmiary/SHA wszystkich 74 plików intent/ACK, odtworzył 37 body i porównania pięciu firm. Czytnik korzysta z własnych sesji i `X-Workspace-ID`, stałego loopback 127.0.0.1:4105 oraz rzeczywistego przerwania requestu po 9 s obejmującego pełne body; nie kieruje żądań do dostawcy.

Pełne zamówienia i odpowiedzi historii/bilansu płatności odpowiadają zapisanym odbiorom dwóch naturalnych cykli każdej firmy. Każde zamówienie ma 12,30 PLN, jedną płatność `source_import` i zero pozostałej kwoty do zapłaty. To deklaracja płatności ze źródła, nie potwierdzenie rozliczenia bankowego. W historiach odczytu nadal znajdują się oba odebrane wystąpienia DONE dla każdego z pięciu zamówień. Starszego administracyjnie przerwanego wystąpienia A nie oznaczono jako DONE.

Pełne wybrane DTO inventory odpowiadają końcowemu baseline monitora D, z jego końcowym surowym ACK dla D. Stan fizyczny/rezerwacja/dostępny i wersje konfiguracji w chwili zamknięcia:

| Firma | Stan / rezerwacja / dostępny | Wersja stanu | Odczyt zamówień | Odczyt katalogu | Import | Zapis stanów |
|---|---|---|---|---|---|---|
| A | 10 / 2 / 8 | 4 | 9 | 4 | 2 | 2 |
| B | 9 / 2 / 7 | 3 | 6 | 2 | 2 | 2 |
| C | 9 / 2 / 7 | 3 | 4 | 2 | 2 | 2 |
| D | 9 / 2 / 7 | 3 | 4 | 2 | 2 | 2 |
| E | 9 / 2 / 7 | 3 | 4 | 2 | 2 | 3 |

Każda z ostatnich czterech kolumn opisuje konfigurację z `enabled:false`: 10 harmonogramów odczytu, pięć konfiguracji importu i pięć konfiguracji zapisu stanów. Własność kanału, firmy i magazynu oraz wersje porównano z rzeczywistym capture po zakończeniu D. Ten końcowy odczyt nie uruchamiał żadnego z tych procesorów.

## Zachowanie danych po odczytach

Root wykonał po GET pełny capture RR READ ONLY z limitami SQL8s/klienta9s i potwierdzeniem ROLLBACK/end. Porównanie do `after-d-stock01` zachowuje identyczny roster 644 tabel oraz każdą parę pełnej liczności/canonical SHA256. Wszystkie 28 tabel z zachowanymi surowymi wierszami również są całe identyczne. To porównanie zapisanych wyników rzeczywistych odczytów PostgreSQL; peer nie wykonywał SQL ani normalizacji zapisującej dane.

Tożsamość bazy i cały wiersz generacji 1887 pozostają identyczne. Zachowano m.in. 731 zadań, 144 sesje, migracje, historię poleceń i receiptów. Odbiór 37 GET nie dodał sesji i nie zmienił żadnej tabeli. Zachowanie danych dotyczy przedziału po zakończeniu D → po końcowych GET; skutki wcześniejszych importów i zapisów stanów mają osobne odbiory.

## Dowody

Wszystkie ścieżki prywatne dotyczą `local-builds/full-base-preview-20261017`:

- [Wynik 37 GET](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/woo-five-targeted-n21-closing-prepared-agent-20261019-01/closing02/result.private.json>): 34927 B, SHA256 `aa4d76f1a1628fd9f0ddecedeae5857412d70f74ea54e33d5a52bf16e9cf20a4`.
- [Związane wejście pięciu firm](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/woo-five-targeted-n21-closing-prepared-agent-20261019-01/inputs.bound02.private.json>): 5020 B, SHA256 `1c3a3d8602cd9480ff27fc860ec94cdd85f866f402e575e39b7b5beced89c7df`; przypina wcześniejsze odbiory A–E, rzeczywisty monitor i globalne uzgodnienie D oraz capture po D.
- [Baseline po zakończeniu D](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/readonly-preview-n21-prepared-agent-20261019-01/after-d-stock01/result.private.json>): 3172035 B, SHA256 `c88cc526bbfa1297cae76a810481ed56725ef3a3cce79444b1366ea9da1ebe42`.
- [Capture po końcowych GET](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/readonly-preview-n21-prepared-agent-20261019-01/after-five-closing01/result.private.json>): 3172040 B, SHA256 `59fedf1633da33cd5350f441a6a1e9983c90c54a4f797ad21eb1c5befbf40439`.

Pierwszy wariant czytnika odmówił przed HTTP, ponieważ wymagał 0600 także dla zwykłego manifestu wydania 0644. Osobny `close02` dopuszcza 0644 wyłącznie dla jawnie wyliczonego manifestu, zachowuje 0600 plików prywatnych i ten sam wyjątek przy końcowym odczycie pinów. Canonical release i pierwszy wariant pozostały zachowane. Nie powtórzono z tego powodu operacji biznesowej.

## Pozostaje OPEN

Równoległa ciągła automatyka wszystkich firm przez dłuższy czas, utrata ACK i awaria w toku zapisu, pełny recovery i wznowienie kolejki, kompletna zgodność Base wire, skala, bramka Source34 i pełny Goal pozostają OPEN. Ten czytnik nie mierzy liczby żądań PUT po stronie lokalnego Woo ani nie zastępuje testów pozostałych modułów. Nie stanowi również odbioru nowych wydań N22/N23 ani całego interfejsu readonly.
