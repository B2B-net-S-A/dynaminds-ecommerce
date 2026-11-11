# Mirakl — ponowne sprawdzenie dostępności, 2026-10-18

Status: **PASS — SYNTHETIC_COMPONENT_UI**. Odebrano rzeczywisty komponent React w Chrome z kontrolowanymi lokalnymi odpowiedziami GET. Ten dowód nie potwierdza wspólnego wydania aplikacji ani rzeczywistego konta Mirakl.

## Poprawka

Po odpowiedzi `/health` z `mirakl_reads_available: false` panel zapamiętywał niedostępność i blokował dalsze odczyty także po zmianie konfiguracji lokalnego serwera. Dodano przycisk **Sprawdź ponownie dostępność**. Sprawdza aktualne uprawnienia przez `/auth/me`, następnie lokalne `/health`; zachowuje filtry. Odczyt ofert, konta lub zamówień nadal wymaga osobnego kliknięcia. Zabezpieczenia przed równoległym żądaniem i spóźnioną odpowiedzią obejmują zmianę filtrów i tożsamości użytkownika.

Podczas odbioru przy 375 px wykryto istniejące rozszerzanie dokumentu przez tabelę: szerokość dokumentu 438 px przy ekranie 375 px. Tabele tego komponentu otrzymały nazwane, dostępne z klawiatury kontenery z lokalnym przewijaniem poziomym. Nie zmieniano globalnych arkuszy stylów.

## Weryfikacja

- `node --test web/mirakl-reads.test.mjs`: **23 PASS, 0 FAIL, 0 SKIP**, EXIT 0 po obu poprawkach. Nowe przypadki obejmują false→true bez automatycznego odczytu dostawcy, zachowanie filtrów, dalszą niedostępność, podwójne kliknięcie, zmianę filtrów podczas żądania, utratę roli i zmianę tożsamości A→B→A.
- `npm run typecheck`: EXIT 0 po końcowej zmianie.
- `git diff --check` dla komponentu i jego testów: EXIT 0.
- Root ponownie wykonał końcowe23 testy:23 PASS,0 FAIL/SKIP, EXIT0/771,111ms, i obejrzał wszystkie cztery końcowe zrzuty: niedostępność, odzyskaną dostępność i wyniki na desktopie oraz375px. Osobno potwierdził brak obu własnych PID i listenerów. To przegląd tego samego kontrolowanego komponentu, bez rozszerzenia zakresu dowodu.
- Chrome: pierwsze kliknięcie odczytu daje niedostępność; osobne ponowienie zmienia false→true i odblokowuje akcje. Do tego momentu zapisano dokładnie **4 lokalne GET**: `/auth/me`, `/health`, `/auth/me`, `/health`; żadnego wywołania ofert. Zachowano limit 2 i SKU `SKU ŻÓŁĆ`.
- Dopiero osobne kliknięcie **Odczytaj oferty** pobrało kontrolowany wynik: 1 pozycja, ilość 7, 29,99 zł, aktywna. Końcowy ślad ma **8 GET**, 3 odczyty health i 1 lokalny endpoint o kształcie odczytu ofert; **0 SQL/PG i 0 zewnętrznych żądań do dostawcy**.
- Desktop 1280 px: wynik i nawigacja widoczne. Przy 375 px: szerokość dokumentu **375 px**, kontener tabeli 285 px, zawartość tabeli 393 px. Trzy naciśnięcia ArrowRight w regionie tabeli przesunęły go z 0 do **108 px**, przy zachowaniu szerokości dokumentu 375 px. Brak błędów konsoli.

## Dowody i odtworzenie

Prywatny katalog końcowego podglądu: [fixture02](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/mirakl-availability-recheck-component-visual-20261018-02>). Zawiera wejście podglądu, serwer GET na losowym porcie localhost, bundle rzeczywistego komponentu, `source-proof.private.json`, `after-recheck.private.json`, `calls.private.json`, `mobile-metrics.private.json`, `closed.private.json` i `result.private.json`. Źródła komponentu/API/CSS sprawdzono ponownie względem pinów po zakończeniu odbioru. Komponent: 20184 B, SHA-256 `3c59be9de8993924e2b0464451cede24afcbbfef0e3ead3a722a892e2bb76bb6`.

Scenariusz odtworzenia: uruchomić świeżą kopię fixture na własnym losowym porcie localhost; pierwsze `/health` zwraca false, kolejne true. W komponencie ustawić limit 2 i SKU, kliknąć odczyt ofert, ponowić dostępność, sprawdzić brak żądania ofert, następnie osobno odczytać oferty. Powtórzyć widok przy 375 px i przewinąć nazwany region tabeli klawiaturą. Zachowany serwer jest zatrzymany; nie trzeba dotykać bazy ani wspólnych serwisów.

Zrzuty: [niedostępność](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/mirakl-availability-recheck-component-visual-20261018-02/unavailable.private.jpg>), [dostępność przed odczytem](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/mirakl-availability-recheck-component-visual-20261018-02/available-before-provider.private.jpg>), [wynik desktop](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/mirakl-availability-recheck-component-visual-20261018-02/offers-after-recheck.private.jpg>), [wynik 375 px](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/mirakl-availability-recheck-component-visual-20261018-02/offers-375px.private.jpg>). Zachowano także [pierwszy zrzut wady 438 px](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/mirakl-availability-recheck-component-visual-20261018-01/offers-375px.private.jpg>).

## Cleanup i granica odbioru

Własne karty Chrome zamknięto, wymuszony viewport cofnięto. Oba własne procesy podglądu zakończyły się EXIT 0; PID 99415 i 99766 nie istnieją, porty 60948 i 61184 nie mają listenera. Pierwszy proces zamknięto SIGTERM dopiero po potwierdzeniu własnego PID/cwd, drugi poleceniem `stop` przez własny uchwyt TTY. Nie zmieniano Main4100, APP164103, SMTP1025, PG03/04 ani operatorów bazy.

Pozostaje odrębny odbiór tej zmiany we wspólnym lokalnym wydaniu oraz potwierdzenie integracji z rzeczywistym dostawcą. Nie wykonano zdalnych zapisów.
