# Przegląd lokalnego supervisora stack

Stan: 2026-10-17. Zakres: Source i kontrolowane nowe procesy tymczasowe. Brak uruchomienia stacka na usługach Main/Woo/SMTP/PostgreSQL; brak odbioru biznesowego lub pełnego Goal.

## Wynik

Cztery konkretne problemy zostały odtworzone i poprawione. Po zmianach wszystkie 17 kontroli stacka i dwie kontrole składni przeszły. Ten punktowy wynik nie jest końcowym ACK po późniejszym łącznym teście koordynatora opisanym poniżej. Ostatnie poprawki EPIPE i formatu odpowiedzi DNS wykonał ten sam autor co ten raport; ich końcowy diff wymaga przeglądu koordynatora. Pierwotne wykrycie problemów było niezależne od autora supervisora.

## Zamrożone pliki

- `tools/local/stack.mjs` — SHA256 `a71ef89ce6f75d8a008699ea683ba0ae923fdc36a5b5ae5e1fd45c8dc4462319`, 15865 B.
- `tools/local/stack.test.mjs` — SHA256 `2d900e18149564ceca0b999fa4ffdb78ed68f7cf977a6a143435705688770cda`, 15747 B.
- `docs/parity/LOCAL-STACK.md` — SHA256 `95cd9ee3f369fd48ef5208c38082342068b8acbd69f42746c88b9b9ac9ed1675`, 7060 B.

## Ustalenia i poprawki

1. **P1 — błąd stdout pomijał sprzątanie dzieci.** Zamknięcie czytnika stdout powodowało nieobsłużony asynchroniczny EPIPE i EXIT1 supervisora; jego stan pozostawał `ready`, a własny proces potomny nadal żył. Rzeczywisty kontrolowany reproducer: sesja `14578`, terminal `aaf729` / EXIT0 po niezależnym zamknięciu wyłącznie własnego nowego fixture. Poprawka w `stack.mjs:90`: RAM-only listener przed startupem zapamiętuje pierwszy błąd i budzi istniejący `finally`; CLI utrzymuje obsługę błędów końcowego stdout/stderr także po odpięciu listenerów funkcji. Regresja rzeczywistego procesu potwierdza EPIPE, `closed`, puste cleanup, dwa dzieci EXIT0, odwrotną kolejność zamknięcia, brak ich PID i wolne porty. Brak retry lub eskalacji.
2. **P1 — zmieniony CA mógł zostać użyty bez ponownego porównania pinu.** Pierwotne `probe` czytało CA przez zwykłe `readFileSync`, choć początkowy preflight sprawdzał pin. Kontrolowany test wyekstrahowanego produkcyjnego `probe` (`4119a2` / EXIT0) wykazał użycie zmienionych bajtów po poprawnym preflight; transport był syntetyczny, więc nie jest to dowód obejścia kryptografii TLS. Obecne `stack.mjs:75` wykonuje stabilny odczyt `verifyRef` przy każdym HTTPS probe i przekazuje dokładnie te bajty do TLS. Rzeczywisty test lokalnego TLS potwierdza sukces z właściwym CA oraz odmowę po zmianie treści i po symlinku, także w `status`.
3. **P2 — udany probe po deadline mógł ogłosić gotowość.** Deadline był sprawdzany tylko po nieudanym probe. Rzeczywisty nowy fixture: startup300 ms, odpowiedź opóźniona450 ms, pierwotne `LOCAL_STACK_READY` po około797 ms (`fba6fa` / EXIT0 wraz z normalnym zamknięciem). Obecne `stack.mjs:114` sprawdza czas przed i po `await probe`; regresja odmawia gotowości i zamyka własne dziecko. Limitów produktu nie podniesiono.
4. **P2 — HTTPS lookup miał błędny ABI dla `options.all`.** Aktualny Node prosił o listę adresów, ale callback zwracał string; rzeczywisty kontrolowany HTTPS zwracał `ERR_INVALID_IP_ADDRESS` (`8104df` / EXIT0). `stack.mjs:77` zwraca teraz listę IPv4 dla `all`, a pojedynczy adres dla zwykłego żądania. Połączenie pozostaje wyłącznie z 127.0.0.1, hostname/SNI localhost, z przypiętym CA; brak `rejectUnauthorized:false` i brak fallbacku.

Osobno naprawiono zbyt krótki budżet kontrolowanego testu częściowego startupu: 200→1300 ms wyłącznie w teście. Pierwsze dziecko musi osiągnąć gotowość, drugie rzeczywiście wystartować i dopiero wtedy przekroczyć limit. Test wymaga dwóch zamkniętych dzieci i odwrotnej kolejności `service-1:stop`, `service-0:stop`. Produkcyjne limity i guardy nie zostały osłabione.

## Weryfikacja

- `node --test tools/local/stack.test.mjs`: oryginalna sesja `49737`, start `f2fa42`, terminal `e6d0ac` / EXIT0; 17/17 PASS, 0 skipped, około 17.975 s.
- `node --check tools/local/stack.mjs` i `node --check tools/local/stack.test.mjs`: `cf073d` / EXIT0.
- Wcześniejszy niezależny rerun pierwotnych 14 grup: sesja `21110`, terminal `eb6d54` / EXIT0. Nie zastępuje końcowych 17 kontroli.
- Sprawdzono własność PID/birth, obce zajęte porty bez sygnału, partial startup, pamiętanie SIGTERM, późny crash, niepotwierdzone zamknięcie bez SIGKILL, ograniczone hashowane logi, brak odziedziczonych sekretów, drift profilu i CA oraz puste/ponownie użyte state paths.
- Wszystkie kontrolowane nowe procesy zakończono; katalogi tymczasowe usunięto. Żadne istniejące usługi nie były zatrzymywane ani uruchamiane; PG pozostaje `PG_managed:false`.

## Granice

Stan `ready` jest stanem supervisora; odpowiedź `status` zawiera osobne bieżące `live` i `ready` każdego dziecka. Kontrolowane testy nie dowodzą gotowości biznesowej przypiętych aplikacji, zgodności z Base ani aktualnego stanu Main. Pliki Source, profile i stan nie stanowią sandboxa dla złośliwego entrypointu. Przed odbiorem rzeczywistego stacka potrzebny jest jawny profil oraz zwykły start/status/stop z dowodami wszystkich wymaganych usług.

## Późniejszy łączny test koordynatora — końcowy ACK otwarty

Po powyższym punkcie koordynator zgłosił suite `88038` / EXIT1, 71/73 PASS: odczyt stanu ścigał się z własnym atomic rename (`nlink1→0`/ctime), a test późnej odpowiedzi mógł wysłać SIGTERM przed zainstalowaniem handlera kontrolowanego fixture. Koordynator przejął `stack.mjs` i `stack.test.mjs`, przygotowując ograniczony retry wyłącznie odczytu atomowo podmienionego stanu oraz deterministyczną kontrolę deadline. Raportowane powyżej piny i 17/17 dotyczą wcześniejszego punktu; nie potwierdzają tych późniejszych zmian. Końcowy review i rerun nowego supervisora pozostają po stronie koordynatora. Brak retry usług, dostawców lub biznesu.
