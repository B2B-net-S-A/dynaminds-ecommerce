# Jawna usługa lokalna macOS — operator i cały stack

`tools/local/service.mjs` zarządza jednym nowym LaunchAgentem dla istniejącego
profilu `operator.mjs` albo wielousługowego `stack.mjs`. Import modułu niczego nie uruchamia. Nie zmienia obecnych
usług Main/Woo/SMTP, PostgreSQL, danych, pakietów ani współdzielonych zależności.
Tryb stack używa istniejącego supervisora i jego reguł gotowości, kolejności oraz zamknięcia.

## Użycie

Przygotuj pusty katalog należący do użytkownika z uprawnieniami `700`. Wskaż
istniejący, zweryfikowany profil operatora (`600`) oraz nową etykietę w przestrzeni
`pl.dynaminds.ecommerce.*`. Nie używaj etykiety działającej usługi.

```sh
node tools/local/service.mjs prepare '/absolute/profile.private.json' '/absolute/fresh-service-directory' pl.dynaminds.ecommerce.preview-new
# Alternatywnie: istniejący profil całego stacka, nowy pusty katalog i osobna etykieta
node tools/local/service.mjs prepare-stack '/absolute/stack-profile.private.json' '/absolute/fresh-stack-service-directory' pl.dynaminds.ecommerce.stack-new

# Start/status/stop wskazuje deskryptor wybranego trybu
node tools/local/service.mjs start '/absolute/fresh-service-directory/service.private.json'
node tools/local/service.mjs status '/absolute/fresh-service-directory/service.private.json'
node tools/local/service.mjs stop '/absolute/fresh-service-directory/service.private.json'
```

`prepare` zapisuje wyłącznie deskryptor, plist i puste logi, z uprawnieniami `600`.
Nie kopiuje aplikacji, bazy, obrazów ani `node_modules`. Przypina SHA-256 profilu,
operatora, wrappera, Node i plist; tryb stack przypina także jego entrypoint.
Istniejący descriptor v1 zachowuje tryb operatora. Nowy descriptor v2 ma ścisłe
`kind=stack`, oddzielny plik stanu i przypięty profil stacka; tryby nie są zgadywane
na podstawie zawartości lub nazwy pliku. Późniejsza zmiana któregokolwiek z tych plików
powoduje odmowę; przygotowanie wykonuje się dla stabilnego wydania.

`start` zapisuje oryginalną próbę i wykonuje **jeden** `launchctl bootstrap`.
`START_REQUESTED` oznacza potwierdzenie polecenia, nie gotowość aplikacji.
Niepewne potwierdzenie pozostawia `START_UNCONFIRMED`; narzędzie nie ponawia startu.
Start wymaga nowych plików stanu. Po zamknięciu zachowaj poprzednie dowody i przygotuj
kolejny pusty katalog; nie kasuj stanu w celu ponowienia nieuzgodnionej próby.

Własny proces `run` pozostaje na pierwszym planie LaunchAgenta i uruchamia oryginalny
operator albo stack. Rejestruje tożsamości procesów: PID, UID, czas utworzenia i hash polecenia.
`status` rozróżnia `STARTING`, `READY`, `CLOSING`, `CLOSED` i wyniki niepotwierdzone.
`READY` wymaga żywych oryginalnych procesów oraz lokalnego health z dokładną rewizją.
Dla stacka `READY` wymaga każdego ID usługi z profilu, oryginalnych tożsamości jej
procesów i jednoczesnego live/ready z istniejącego `stackStatus`. Częściowy start,
niepełny zbiór lub brak gotowości jednej usługi nie nadaje `READY`.
Nie jest to odbiór biznesowy ani pomiar wydajności. Brak gotowości
nie powoduje restartu, nowej kopii ani uruchomienia kolejnej instancji.

`stop` najpierw deleguje zamknięcie do istniejącego operatora albo `stopStack`. Wymaga jego czystego
wyniku, stanu zamknięcia wrappera i potwierdzenia, że oryginalne procesy już nie żyją.
Dla stacka wymaga ponadto braku błędu/cleanup, EXIT0 bez sygnału każdego rozpoczętego
dziecka oraz potwierdzenia, że oryginalne procesy dzieci już nie żyją. Niepewny drain
nie jest czystym zamknięciem. Dopiero potem usuwa nieaktywną rejestrację przez `bootout`. Nigdy nie używa `bootout`
jako sposobu zatrzymania żywej aplikacji, `kickstart -k` ani eskalacji do `SIGKILL`.
Nieznany wynik zamknięcia pozostaje niepotwierdzony; należy dalej obserwować tę samą
próbę. Odczyt `launchctl print` jest tylko dodatkowym warunkiem odmowy: zmieniony
format lub żywy PID blokuje `bootout`; nie nadaje `READY` ani prawa do sygnału.

## Granice i konfiguracja

- Wygenerowany plist: `RunAtLoad=true`, `KeepAlive=false`, `ExitTimeOut=120`,
  `Umask=077`, `ProcessType=Standard`. Brak harmonogramów, watch paths i restartów.
- Usługa działa w domenie GUI bieżącego użytkownika. Przetrwanie zamknięcia polecenia
  nie oznacza startu po restarcie komputera lub ponownym logowaniu. Nie instalujemy
  niczego w `~/Library/LaunchAgents` ani w domenie systemowej.
- Jawny `stop` jest obsługiwaną ścieżką zamknięcia. Wylogowanie lub zakończenie przez
  system podlega także polityce launchd; `ExitTimeOut` nie dowodzi wykonania recovery.
- Środowisko zawiera tylko HOME i stały PATH. Sekrety pozostają w istniejących prywatnych
  plikach. Błędy CLI zwracają hash komunikatu, bez DSN i treści prywatnych plików.
- Nie dodaje ani nie uruchamia usługi PostgreSQL. Profil stacka musi obejmować wyłącznie
  jawnie przejrzane lokalne procesy aplikacji i jej zależności; istniejący PG pozostaje
  zewnętrzny. Nie dodaje się automatycznie brakujących usług.
- Operator przechwytuje surowe stdout/stderr aplikacji do prywatnego katalogu
  `<statePath>.logs` (0700), z dwoma stałymi plikami0600 na każdy strumień.
  Domyślny limit wynosi1MiB/pliki, czyli maksymalnie4MiB na uruchomienie;
  opcjonalne `logBytes` profilu operatora ustala1KiB–1MiB na plik.
  Zachowywany jest binarny końcowy fragment logów, bez dzielenia na linie;
  znaki UTF-8 mogą przechodzić między segmentami. Stan zawiera liczniki, epoki
  i hashe. Surowy payload dziecka nie trafia do plików launchd.
- Stack nadal używa własnego limitu/hash stdout/stderr każdego dziecka
  z profilu i zatrzymuje stack po przekroczeniu limitu. Nie stosuje powyższej
  rotacji operatora. Wrapper zapisuje prywatne komunikaty lifecycle;
  automatyczna retencja jego plików oraz historycznych uruchomień pozostaje otwarta.
- Błąd przechwytywania logu zachowuje pierwszą przyczynę i rozpoczyna drain.
  Przed SIGTERM operator zapisuje `draining`; taki stan nie daje gotowości.
  Jeśli zapis stanu nie może zaalokować miejsca, operator próbuje unieważnić
  odczyt zwykłych narzędzi przez zmianę uprawnień własnego zweryfikowanego
  inode600→400. Jednoczesna odmowa zapisu i tej operacji pozostaje jawnym
  `state_close_unconfirmed`; nie deklarujemy gwarancji przy pełnej awarii FS.
- Testy obejmują wstrzyknięte launchctl i procesy oraz rzeczywisty tymczasowy health HTTP.
  Koordynator wykonał następnie także rzeczywisty cykl LaunchAgenta: PREPARED →
  START_REQUESTED → READY → CLOSED_AND_UNREGISTERED → CLOSED. Użyto małej syntetycznej
  aplikacji health na porcie4104, bez połączenia z PostgreSQL i bez zmiany Main lub
  podglądu04. Wynik zapisano w `local-builds/full-base-preview-20261017/service-lifecycle04/result.private.json`.
  To odbiór mechanizmu usług, nie rzeczywistej aplikacji OMS, całego stacka lub recovery danych.

Rozszerzenie trybu stack sprawdzono ponadto rzeczywistym, kontrolowanym uruchomieniem
wrappera i dwóch małych serwerów health na tymczasowych portach: pełne READY, delegacja
do stopStack, zamknięcie wszystkich dzieci i wrappera oraz CLOSED. W tym teście launchctl
był wstrzyknięty; nie uruchamiano nowego LaunchAgenta ani bieżących Main/Woo/SMTP/podglądu.
Odbiór całego rzeczywistego lokalnego stacka przez launchd pozostaje osobnym krokiem.

## Kontrola ograniczonych logów operatora — 17.10.2026

Zintegrowano zmianę w lokalnym commicie `fecf9d2`. Koordynator uruchomił
wspólnie testy bounded-logs, niezależne bounded-logs-peer, operator, stack
i service: **61/61 PASS, zero pominięć**. Kontrole obejmują rzeczywiste
syntetyczne dzieci, rotację, krótkie zapisy, UTF-8/bajty, ENOSPC/EIO/EPIPE,
gotowość podczas drain, podmianę inode i brak osieroconych procesów.
Nie uruchamiano nowego Main, podglądu ani połączenia z PostgreSQL.
Poprawka dotyczy następnych uruchomień nowym operatorem; istniejące procesy
nie otrzymują jej automatycznie. Limit4MiB jest limitem jednego uruchomienia,
nie sumy całej historii projektu.

## Rzeczywisty LaunchAgent dla dwóch usług — 17.10.2026

Koordynator wykonał także test z prawdziwym `launchctl bootstrap` i dwoma
syntetycznymi serwerami health: `START_REQUESTED → READY →
CLOSED_AND_UNREGISTERED → CLOSED`. Obie usługi miały jednocześnie potwierdzone
`live/ready`; po delegowanym zamknięciu usunięto nieaktywną rejestrację.
Wynik: `local-builds/full-base-preview-20261017/service-stack-lifecycle05/result.private.json`.
Przypięty wrapper miał SHA256
`1d0fdbcc25efd604c0b2bac4517b9571061c96c369d77a62ec6156b7fb9c4080`.
Test nie łączył się z PostgreSQL i nie zmieniał Main ani podglądu05.
To rzeczywisty odbiór mechanizmu wielousługowego LaunchAgenta, nadal bez odbioru
restartu całego OMS, startu po zalogowaniu lub recovery danych.
