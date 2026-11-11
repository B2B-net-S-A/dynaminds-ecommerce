# Końcowy przegląd poprawek supervisora lokalnego

2026-10-17. Wynik: **ACK ograniczonej poprawki Source**, bez znalezionego blokera w zakresie odczytu atomowo zastępowanego stanu, deadline gotowości i ich integracji ze sprzątaniem. Autor raportu jest autorem pierwotnego supervisora; niezależność dotyczy późniejszych poprawek koordynatora, nie ponownej niezależnej certyfikacji całego narzędzia.

## Przejrzany stan

- `tools/local/stack.mjs`: SHA256 `c6f28d96e4430079d4f43734b8d0c9fcb0338ea2d3eb4a87aa8efbf738c4e24f`, 16732 B.
- `tools/local/stack.test.mjs`: SHA256 `595bb63ccd4b30411ab855a8ace336492ed817354c9172ce3658e425b16a8cc3`, 17731 B.
- Oba pliki w `local-app` i `development/full-base` mają te same hashe; oba bezpośrednie `cmp` zakończyły się EXIT0 (`9323a2`). W DEV są nowymi plikami nieśledzonymi, dlatego brak diffu względem lokalnego Git nie jest dowodem braku zmian. Przegląd objął bieżące ciała funkcji i wcześniejszy raport `docs/parity/stack-review.md`.

## Asercje i granice

1. `stateRead` (`stack.mjs:62–74`) dopuszcza najwyżej cztery pełne próby odczytu. Po błędzie musi wykazać różne `(dev, ino)` oraz bezpieczne regularne pliki przed i po: własny UID, brak symlinka, pojedynczy hardlink, dokładnie 0600, maksymalnie 128 KiB. Ten sam inode, niebezpieczny nowy plik lub czwarta nieudana próba zachowują odmowę. `privateFile` nadal wykonuje stabilny odczyt przez `O_NOFOLLOW` i porównuje metadane deskryptora/ścieżki; bajty odczytu są zerowane. To retry wyłącznie odczytu, bez restartu procesu, ponownego sygnału lub wywołania dostawcy.
2. Odczyt nie uznaje samej podmiany za autoryzację stanu. `writeState`, `stackStatus` i `stopStack` nadal sprawdzają hash profilu, a operacje sygnałów i kolejne obserwacje zamykania wiążą rzeczywiste birth supervisora. Model zaufania pozostaje lokalny: własny UID i bezpieczna ścieżka nie stanowią izolacji od złośliwego procesu tego samego użytkownika.
3. `awaitStackReadiness` (`stack.mjs:97–107`) sprawdza deadline przed i po `await probe`, wliczając udaną odpowiedź. Po stopie podczas probe wraca do istniejącego drenażu, nie ogłasza gotowości. Budżet pozostaje budżetem startu danego dziecka; nie zmieniono timeoutów ani kryteriów HTTP/TLS.
4. Integracja (`stack.mjs:133–159`) nadal sprawdza `stopping` i rzeczywiste zakończenie dziecka przed `ready`, zamyka w odwrotnej kolejności, tylko własny zgodny PID/birth i tylko SIGTERM, bez SIGKILL/restartu. Ograniczone odczyty nie dodają retry do tego protokołu. Niepotwierdzone zamknięcie pozostaje błędem. Listener błędu wyjścia nadal budzi ten sam `finally`; pierwsza przyczyna nie jest zastępowana błędem cleanup.
5. Każdy HTTPS probe nadal używa tych samych stabilnie odczytanych i zweryfikowanych bajtów CA; podmiana stanu nie dotyczy retry profilu, referencji entry/import/config ani CA. Istniejące odmowy driftu i brak odziedziczonego `DATABASE_URL` pozostają w Source.
6. Nowy test atomowej podmiany rzeczywiście zastępuje własny plik podczas odczytu deskryptora: jednorazowa podmiana jest ponownie odczytana, ciągłe podmiany kończą się po czterech. Hook FS jest przywracany w `finally`, a własny fixture normalnie zamykany. Test deterministycznego probe używa rzeczywistego helpera z kontrolowanym zegarem, bez serwera. Starszy test rzeczywistej późnej odpowiedzi jawnie dopuszcza niepotwierdzony close po SIGTERM przed handlerem fixture; nie przedstawia go jako czystego EXIT0 dziecka.

## Weryfikacja tego przeglądu

- Wykonano rzeczywisty nowy deterministyczny test helpera: `node --test --test-name-pattern='successful probe completing beyond its whole startup budget' tools/local/stack.test.mjs`; oryginalna sesja `58787`, start `52e015`, terminal `589247` EXIT0, 1/1 PASS. Sprawdza późny sukces 450/300 ms → odmowa i sukces 250/300 ms → przyjęcie; po jednej próbie.
- Dziesięć dodatkowych kontroli wykonało wyekstrahowane, niezmienione ciało `stateRead` z jawnymi portami FS w RAM (`ac3bb3`, EXIT0): poprawna podmiana, ten sam inode, obcy UID, 0644, hardlink, nadmiar rozmiaru, symlink, nieregularny plik, cztery kolejne podmiany, wadliwy JSON na tym samym inode. Wszystkie PASS, bez mutacji FS.
- Koordynator podał wcześniejsze wyniki 19/19 w P oraz 89/89 zintegrowanych w DEV. Są to dowody przekazane przez koordynatora; ten przegląd nie uruchamiał ponownie całych zestawów ani nie obserwował ich oryginalnych terminali.

Nie uruchamiano rzeczywistych usług Main/Woo/SMTP/PostgreSQL ani nowych procesów fixture w ramach tego przeglądu. Nie czytano profili, sekretów lub danych biznesowych i nie zmieniono Source. Wynik nie jest odbiorem docelowego stacka, gotowości biznesowej ani całego Goal.
