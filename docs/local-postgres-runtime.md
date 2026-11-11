# Lokalny operator istniejącego PostgreSQL

[Operator](../tools/local/postgres-runtime.mjs), commit `d49ec98`, obsługuje
`prepare/start/status/stop` istniejącego, wcześniej jawnie utworzonego własnego
klastra PostgreSQL18 na Darwin/ARM64. Import nie uruchamia procesów ani hooków.
**36/36 testów kontrolowanych PASS; rzeczywisty cykl PG tego operatora: NOT_RUN.**
Wcześniejszy PG READY/Native runtime03 pochodzi z osobnego prywatnego bootstrapu.

## Niezależny dowód własności

Operator nie wykonuje `initdb`, nie tworzy markera własności i nie przejmuje
żywego klastra. Wcześniejszy operator inicjalizacji zachowuje swój receipt oraz
`ROOT/ownership.private.json` z dokładnymi polami:

```text
schema = dynaminds-owned-initialized-postgres/v1
uid: integer; dataDirectory: ROOT/data
dataDev, dataIno: decimal strings from the original directory
systemIdentifier: unsigned decimal string; major = 18
initialization: PrivatePin for ROOT/intent.private.json
```

Receipt inicjalizacji ma schemat `dynaminds-owned-postgres-initialization/v1`
lub `dynaminds-owned-accelerated-pg209-bootstrap/v1`, zgodne `root/uid/port`,
`own_cluster_only:true`, `existing_cluster_mutation:false`. Samo wpisanie SID do
nowego JSON nie dowodzi wcześniejszego utworzenia klastra. Nie należy dopisywać
markera do Main lub innego klastra, aby obejść tę granicę.

`ROOT` i `ROOT/data` są kanonicznymi katalogami0700 bieżącego UID. Prywatne
wejścia są zwykłymi plikami0600, bez symlinków/hardlinków. `prepare/start`
wymagają braku `postmaster.pid`, `PG_VERSION=18`, zgodnego SID oraz clean shutdown
w `pg_control`. Narzędzie nie naprawia nieczystego zatrzymania.

## Schemat profilu, bez poświadczeń

Profil jest JSON0600 do64KiB; nieznane pola są odrzucane. `PrivatePin` to dokładnie
`{path,bytes,sha256}`: kanoniczna ścieżka absolutna,1–65536 bajtów,64 małe hex SHA256.
Poniższe typy nie są gotowym profilem ani wygenerowanymi poświadczeniami.

| Pole | Wymaganie |
|---|---|
| `schema` | `dynaminds-owned-postgres-runtime/v1` |
| `uid`, `platform`, `arch` | Bieżący UID, `darwin`, `arm64` |
| `root`, `dataDirectory` | Prywatny `ROOT`, dokładnie `ROOT/data` |
| `port` | Jawny wolny port1024–65535; tylko127.0.0.1, bez gniazda Unix |
| `systemIdentifier`, `version` | Dokładny SID jako string, nie liczba JS; dokładna wersja18.x |
| `ownerMarker`, `credentials` | `PrivatePin` dla `ROOT/ownership.private.json` i `ROOT/credentials.private.json` |
| `configuration` | Cztery piny w `ROOT/data`: `postgresql.conf`, `postgresql.auto.conf`, `pg_hba.conf`, `pg_ident.conf` |
| `runtime` | Dokładnie `directory`, `libraryDirectory=directory/lib`, prywatny `manifest:PrivatePin`, `postgres`, `files` |
| `startupMs`, `shutdownMs` |100–120000ms oraz100–60000ms |
| `logBytes` |1024–1048576 bajtów na segment; cztery segmenty łącznie |

Credentials zawierają dokładnie `user='postgres'`, `database='postgres'`,
`password` będące istniejącym hasłem16–4096 znaków. Nie umieszczaj go w CLI/logach.
Binarium `runtime.postgres` wskazuje `directory/bin/postgres`; ono i każda
pozycja `runtime.files` mają dokładnie:

```text
{path: absolute path under runtime.directory,
 realPath: canonical resolved file, bytes: integer,
 sha256: lowercase hex64, loaded: boolean}
```

Lista ma2–128 pozycji, każdy plik do64MiB, suma z binarium do256MiB. To osobne
limity runtime, bez rozszerzenia limitów pakietu aplikacji. Jawne symlinki
zależności wymagają zgodnego `realPath` i hasha; pliki nie mogą być zapisywalne
przez grupę/innych. Binarium, `libcrypto.3.dylib`, `libssl.3.dylib` wymagają
`loaded:true`. Niepinowane załadowane `.dylib/.so/.bundle` spoza systemu odmawiają
READY. Aktywne `include/include_if_exists/include_dir` w konfiguracjach są
odrzucane. Nie ma dowolnych flag; narzucone są m.in. `jit=off`, LZ4, UTC,
`lc_messages=C`, stderr bez logging collector. DYLD jest ustawiane tylko dziecku.

## Jawne komendy

Zmienne są parametrami operatora, a nie rzeczywistymi ścieżkami/sekretami.
Z katalogu `development/full-base`:

```sh
node tools/local/postgres-runtime.mjs prepare "$DRAFT_PROFILE" "$DRAFT_SHA256" "$PREPARED_PROFILE"
node tools/local/postgres-runtime.mjs start "$PREPARED_PROFILE" "$PROFILE_SHA256" "$STATE"
```

`DRAFT_SHA256` dotyczy dokładnych bajtów draftu. `prepare` sprawdza dowody i piny,
zapisuje nowy profil0600 pod `ROOT` i zwraca jego `profile_sha256`; nie uruchamia
PG ani nie nadpisuje profilu. `start` pozostaje na pierwszym planie. `STATE`
musi być nowym plikiem bezpośrednio pod `ROOT`, innym niż marker/credentials/intent.
Zachowuje tożsamość supervisora i dziecka; powtórzenie tej próby odmawia startu.

W drugim terminalu, z tym samym profilem/hash/state:

```sh
node tools/local/postgres-runtime.mjs status "$PREPARED_PROFILE" "$PROFILE_SHA256" "$STATE"
node tools/local/postgres-runtime.mjs stop "$PREPARED_PROFILE" "$PROFILE_SHA256" "$STATE"
```

READY wymaga zgodnego SQL SID/portu/adresu/wersji/katalogu oraz bazy/roli
`postgres`, pliku PID, birth procesu, pinów i załadowanych bibliotek. Sam stderr
nie wystarcza. `stop` sprawdza zapisany birth i sygnalizuje własny supervisor;
ten wysyła jeden SIGINT potwierdzonemu dziecku i czeka na rzeczywiste close.
SIGINT/SIGTERM/SIGHUP do supervisora również żądają normalnego stopu, także podczas
startu. Nie ma restartu, reinit, adoption, SIGKILL lub sygnalizowania obcych PID.

## Wynik i granice

Stan/logi są prywatne0600/0700, zachowane logi do `4 × logBytes`. Publiczne błędy
zawierają kod/hash wiadomości, bez surowych przyczyn lub credentiali. Poprawny
stop wymaga kodu0 bez sygnału, shutdown w logu, braku PID i clean shutdown/SID.
Po `shutdownMs` wynik pozostaje niezaliczony; supervisor nadal czeka na faktyczne
close bez eskalacji. Późne zamknięcie nie zamienia FAILURE w PASS.

`CLOSED` dotyczy wskazanej próby, nie późniejszych uruchomień klastra przez inne
narzędzie. Nowy jawny start ponownie sprawdza plik PID, stan i wolny port.
`CLOSE_UNCONFIRMED` wymaga uzgodnienia przez właściciela; nie usuwaj stanu/danych,
aby ukryć niepewność. Wszystkie odpowiedzi zachowują `native_acceptance:false`.

Pozostaje rzeczywisty cykl na nowym własnym fixture:
prepare→start→SQL identity→status→normalny stop→status, bez przełączania03/Main.
Testy kontrolowane nie odbierają aplikacji, upgrade, backup/restore lub skali.
