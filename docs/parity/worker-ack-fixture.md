# Lokalny fixture utraty ACK SMTP

`tools/local/smtp-ack-fixture.mjs` to osobny odbiornik **wyłącznie testowy**.
Nie uruchamia aplikacji, workera ani PG, nie czyta konfiguracji środowiska,
nie wysyła dalej wiadomości. Istniejący `scripts/smtp-sink.ts` pozostaje osobny.

```js
import {createSmtpAckFixture} from './tools/local/smtp-ack-fixture.mjs';
const fixture = await createSmtpAckFixture({directory: '/absolute/private/new-mailbox', port: 0});
// fixture.address = {host:'127.0.0.1', port: assignedPort}
const effects = await fixture.list();
const stored = await fixture.read(effects[0].id); // owner-only, zawiera treść
await fixture.release(effects[0].id); // albo drop(id), nigdy obie decyzje
await fixture.close();
```

Każdy DATA zapisuje nowy `effect-UUID.json` (0600) w katalogu 0700. Zapis
pliku i katalogu jest fsync przed udostępnieniem held ACK. `release(id)`
utrwala `RELEASE_250_REQUESTED`, a potem wysyła 250. Nie dowodzi odebrania
ACK przez klienta. `drop(id)` utrwala `DROP_CONNECTION_WITHOUT_ACK` i zamyka
wyłącznie własne połączenie. Brak deduplikacji: retry ma być widoczny jako
drugi efekt. Zamknięcie fixture nie wysyła sukcesu dla oczekujących DATA.

Po zwykłym close można ponownie otworzyć ten sam katalog z identycznymi
limitami i odczytać efekty/decyzje; nie odtwarza to połączeń ani ACK.
Jednoczesny właściciel jest zabroniony. Lock po awarii nie jest automatycznie
usuwany ani uznawany za stary — należy zachować dowód i użyć nowego katalogu.
Nie przechowywać rzeczywistych danych klientów w tym fixture.

Domyślne limity: 16 wiadomości, 4 połączenia, 256KiB DATA, 4MiB łącznych
przyjętych treści. Maksima: 32/8/256KiB/8MiB. Tylko adresy `.test`, loopback,
brak AUTH/STARTTLS. Odczyt treści jest dostępny tylko posiadaczowi obiektu API,
bez endpointu HTTP i bez logowania treści na stdout.

Testy realnego TCP i plików:

```sh
node --test --test-concurrency=1 tests/smtp-ack-fixture.test.mjs
```

To narzędzie umożliwia osobny odbiór pause → rozpoczęty skutek → owner stop
i drain → restart → odczyt niepewnej próby bez replay. Samo uruchomienie
fixture/testów nie potwierdza trwałości workerów, dostarczenia emaila,
akceptacji dostawcy ani całego procesu biznesowego.

## Prywatna usługa kontrolna fixture

`tools/local/smtp-ack-fixture-service.mjs` opakowuje ten sam fixture w osobny
proces pierwszoplanowy. Nie uruchamia aplikacji, workera ani PG. Potrzebuje
krótkiego, kanonicznego katalogu0700 we własnym prywatnym katalogu0700;
pełna ścieżka `control.sock` ma najwyżej100 bajtów. Przykładowy rodzic to
katalog utworzony przez `mktemp -d /tmp/dyna-ack.XXXXXX`, następnie `realpath`. Nie używać katalogów
z rzeczywistą pocztą. Domyślny port0 wybiera wolny loopback port. Jawny1025
jest dopuszczalny tylko gdy wolny; usługa nigdy nie zatrzymuje starego serwisu.

```sh
node tools/local/smtp-ack-fixture-service.mjs start '<SHORT_PRIVATE_PARENT>/service' 0
node tools/local/smtp-ack-fixture-service.mjs command '<SHORT_PRIVATE_PARENT>/service' inspect '<SHORT_PRIVATE_PARENT>/inspect.json'
node tools/local/smtp-ack-fixture-service.mjs command '<SHORT_PRIVATE_PARENT>/service' list '<SHORT_PRIVATE_PARENT>/list.json'
node tools/local/smtp-ack-fixture-service.mjs command '<SHORT_PRIVATE_PARENT>/service' read '<SHORT_PRIVATE_PARENT>/read.json' '<EFFECT_UUID>'
node tools/local/smtp-ack-fixture-service.mjs command '<SHORT_PRIVATE_PARENT>/service' release '<SHORT_PRIVATE_PARENT>/release.json' '<EFFECT_UUID>'
# Dla innej świeżej próby: drop zamiast release; nigdy oba.
node tools/local/smtp-ack-fixture-service.mjs command '<SHORT_PRIVATE_PARENT>/service' drop '<SHORT_PRIVATE_PARENT>/drop.json' '<OTHER_EFFECT_UUID>'
node tools/local/smtp-ack-fixture-service.mjs command '<SHORT_PRIVATE_PARENT>/service' close '<SHORT_PRIVATE_PARENT>/close.json'
```

Każdy wynik wymaga NOWEJ ścieżki wyjściowej. Klient najpierw tworzy/fsyncuje
intent0600 z pełnym `{command,id?}`, dopiero potem wysyła komendę. Pełną
odpowiedź zapisuje do nowego pliku0600 obok intentu, wykonuje fsync, sprawdza
niezmienioną tożsamość oryginalnego intentu i zastępuje go atomowym rename
oraz fsync katalogu. Przerwanie zachowuje pełny intent albo pełny ACK, nigdy
celowo pusty/obcięty wynik; może pozostać prywatny plik `.ack-UUID`.
stdout zawiera tylko komendę, wynik `ok`, długość i SHA odpowiedzi.
`read.json` zawiera prywatną treść i nie wolno go publikować. Socket0600 oraz
katalog0700 ograniczają sterowanie do właściciela. Protokół ma jedną komendę
JSON na połączenie, maksymalnie4KiB żądania,512KiB odpowiedzi i4 połączenia.
Nadmiar odpowiedzi daje `RESPONSE_TOO_LARGE`; nie ma obciętego sukcesu.

`close` odpowiada potwierdzeniem żądania zamknięcia, a nie końcem procesu.
Końcowy dowód to exit0 oraz `state.json` ze statusem `CLOSED`,
`fixture_closed:true`, `control_closed:true`. SIGTERM/SIGINT używają tej samej
ścieżki. Przy zamknięciu oczekujące DATA tracą ACK, bez dopisania sukcesu.
Po cleanclose można uruchomić ten sam katalog z tym samym wybranym parametrem
portu i odczytać poprzednie wiadomości/decyzje; połączenia nie są odtwarzane.
Istniejący `owner.lock`, socket albo stan awarii odmawia automatycznego startu.
Nie usuwać ich automatycznie ani nie powtarzać `release/drop` po niepewnym ACK
komendy: zachować intent i uzgodnić wynik przez `list/read`.

Testy uruchamiają prawdziwe procesy usługi, Unixsocket, SMTP i pliki:

```sh
node --test --test-concurrency=1 tests/smtp-ack-fixture-service.test.mjs
```

To odbiór narzędzia kontrolnego. Nie dowodzi dwutenantowego lifecycle
aplikacji, trwałego `uncertain` w jej bazie, braku replay po restarcie workera
ani dostarczenia do zewnętrznego odbiorcy.


## Osobny port prywatnego profilu aplikacji

Prywatny plik konfiguracji aplikacji może zawierać opcjonalne pole
`localSmtpPort` — liczbę całkowitą1024..65535. Brak pola zachowuje domyślny1025.
Pole nie jest parametrem HTTP ani zmienną środowiskową. Należy przygotować
osobny plik0600 dla własnej kopii i przypiąć go w nowym profilu; zachować
istniejący encryptionKey/hasło DB bez publikowania wartości. Nie zmieniać
konfiguracji działającego odbiornika ani aplikacji w miejscu.

Ten sam walidowany wybór portu obowiązuje w schema SmtpClient, tworzeniu
kanału smtp-example, opcjach własnej reguły, jej admission i ostatniej kontroli
przed attempted_at. Kanał dla1025 nie jest przepisywany na inny port;
`POST /api/integrations/smtp-example` wybiera tylko własny zgodny kanał albo
utworzy nowy w aktualnym tenant. Inny port profilu odmawia. Nadal wyłącznie
127.0.0.1, sandbox/local_sink i adresy `.test`; lokalne credentials i ograniczenia
zewnętrznego SMTP pozostają bez zmian. `scripts/smtp-sink.ts` nadal słucha1025.

Wybrany wolny port należy przekazać również do `smtp-ack-fixture-service start`.
Sama zgodność liczb nie zastępuje sprawdzenia właściciela, READY obu procesów
i niezmiennego release/config. `tests/local-smtp-ack-client-interop.test.mjs`
zawiera rzeczywisty klient+proces ACKservice na porcie prywatnego profilu,
bez adaptera net.connect, oraz osobne historyczne testy domyślnego1025.
To wciąż transport/konfiguracja; dwutenantowy worker pause/drain/restart
w zwykłej aplikacji wymaga osobnego wykonania i odczytu trwałych wyników.
