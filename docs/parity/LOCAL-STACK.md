# Lokalny stack — foreground start / status / stop

`tools/local/stack.mjs` nadzoruje istniejące node entrypoints usług. Nie tworzy bazy, tenantów, fixtures, proofów, credentials ani konfiguracji providerów i nie zatrzymuje PostgreSQL. Ten nowy supervisor nie został uruchomiony na odebranym Main/Woo/SMTP. Przyjęte V2 i jego dotychczasowy operator pozostają zachowane.

```sh
node tools/local/stack.mjs start /ABS/private-stack-profile.json /ABS/fresh-stack-state.json
node tools/local/stack.mjs status /ABS/private-stack-profile.json /ABS/fresh-stack-state.json
node tools/local/stack.mjs stop /ABS/private-stack-profile.json /ABS/fresh-stack-state.json
```

Wykonywać w `local-app`. Start jest procesem foreground, zachowuje oryginalny terminal i czeka na stop; nie uruchamia siebie w tle. Ctrl-C/SIGTERM zatrzymuje nowe starty i zamyka własne procesy w odwrotnej kolejności. Kolejny start wymaga nowej ścieżki state. Nie nadpisywać state ani równolegle prowadzić tej samej usługi starym operatorem. Status weryfikuje profil i birth procesów; historyczny closed nie jest LIVE.

## Profil

Właściciel bieżącego użytkownika, plik0600, bez symlinków, canonical absolute path. Pole `schema` to `dynaminds-local-stack/v1`. Wymagane są wszystkie poniższe pola; dodatkowe klucze są odrzucane:

```json
{
  "schema": "dynaminds-local-stack/v1",
  "startupMs": 180000,
  "shutdownMs": 30000,
  "logBytes": 65536,
  "services": [{
    "id": "app",
    "entry": {"path": "/ABS/release/runtime/server/ordinary-local-cli.mjs", "sha256": "EXACT_64_HEX"},
    "imports": [],
    "args": ["/ABS/private-selection.json", "EXACT_SELECTION_SHA", "4100"],
    "cwd": "/ABS/owned-app-working-directory",
    "envPaths": {
      "DYNA_IMAGE_DIR": {"path": "/ABS/owned-images", "kind": "directory"}
    },
    "files": [{"path": "/ABS/private-selection.json", "sha256": "EXACT_SELECTION_SHA"}],
    "ports": [4100],
    "ready": {
      "kind": "http", "port": 4100, "path": "/api/health", "status": 200,
      "json": {"status": "ok", "revision": "EXACT_RELEASE_SHA"}, "ca": null
    }
  }]
}
```

To schemat z placeholderami, nie gotowy profil Main. Każdy entry/import/files musi być własnym przypiętym plikiem bez symlinka i group/other-write; `files` przypina też dependency selections/config wymagane przez dany service. Nie wpisywać DSN/sekretów w args. Prywatne runtime selection/config nadal waliduje właściwy entrypoint. Supervisor przekazuje wyłącznie ograniczony systemowy environment; nie dziedziczy DATABASE_URL, NODE_OPTIONS, tokenów ani dowolnych zmiennych terminala. `envPaths` przekazuje **ścieżkę**, nie zawartość pliku: file ref wymaga0600 i dokładnego SHA; directory variant to owned canonical directory bez group/other-write.

Usługi występują w kolejności zależności: np. SMTP, WooA, WooB, Main. Użyć istniejących canonical service `.mjs` + ich prywatne profile/args. Main może użyć bezpośrednio tego samego emitted `ordinary-local-cli.mjs`, który buduje `operator.commandFor`; nie uruchamiać zagnieżdżonego operatora ani nowej fabryki/proofa. Dla istniejącego `smtp-sink.ts`: `entry` wskazuje ten plik, `imports` zawiera ref istniejącego loadera `tsx/dist/loader.mjs`, `envPaths.DYNA_LOCAL_CONFIG_PATH` wskazuje właściwy config Main; cwd wybiera istniejący mailbox. Nie tworzyć nowego mailbox/config przez samą zmianę supervisor profilu.

`ports` obejmuje gotowość i dodatkowe porty danej usługi (np. Woo TLS oraz wewnętrzny PHP). Wszystkie porty całego profilu muszą być rozłączne i wolne na127.0.0.1 przed pierwszym child oraz przed startem danej usługi. Nie jest to rezerwacja portów przeciw obcemu procesowi między sprawdzeniem a bind; dziecko musi odmówić konfliktu, a supervisor zamknie częściowy stack.

Readiness ma dokładnie pola `kind,port,path,status,json,ca`. Dla `tcp` ostatnie cztery to null. Dla HTTP(S) path jest względnym path zaczynającym się pojedynczym `/`, status jest jawny, a json może wymagać dokładnych wartości top-level pól. Probes to tylko lokalne GET bez cookies/auth i bez redirectfollow; response≤8KiB i deadline500ms. HTTPS wymaga przypiętego CA, weryfikuje nazwęlocalhost i łączy wyłącznie127.0.0.1. TCP-ready oznacza tylko port, nie AUTH/business/provider acceptance. WooB może nadal wymagać jawnego istniejącego initial-bootstrap GET po resume; supervisor nie wykonuje ukrytych operacji biznesowych ani nie uznaje TCP za pełny odbiór Woo.

## Lifecycle i ograniczenia

- Profil ma1–8usług; startup100ms–300s na usługę, wspólny shutdown100ms–60s. Start nie robi autoRetry/restartu dziecka ani reaperów jobs. Trwałe pending/attempted/unknown pozostają domeną istniejącego workera/polityki.
- Jeden state0600 wiąże hash profilu, supervisor birth oraz child uid/pid/start/commandSHA. Zmiana profilu odmawia stop/status; PID reuse nie uprawnia do sygnału. Supervisor sygnalizuje wyłącznie swoje faktyczne dzieci; stop command sygnalizuje zweryfikowany supervisor.
- Zatrzymanie lub błąd startu zamyka częściowy stack w odwrotnej kolejności. Jeden SIGTERM na dziecko, bez SIGKILL/eskalacji i bez PGstop. Upływ terminu zachowuje `close-unconfirmed` i błąd; nie daje clean PASS. Uporczywie działające dziecko może utrzymywać oryginalny terminal otwarty — nie jest automatycznie porzucane jako sukces.
- Sygnał otrzymany przez supervisor podczas startu jest pamiętany. Nie naprawia to automatycznie luk cleanup wewnątrz dziecka: szczególnie dotychczasowy ordinary CLI podpina handler po awaited factory. Przy sygnale przed rejestracją handlera dziecko może zakończyć się sygnałem; supervisor zapisze niepotwierdzone zamknięcie. App-level startup drain to osobna zmiana z planu worker-lifecycle.
- stdout/stderr dzieci nie są kopiowane do terminala lub plików. State zapisuje liczbę bajtów oraz SHA256 ograniczonego prefixu każdej pary streamów (`hashed_bytes`); przekroczenie limitu1KiB–1MiB/stream zatrzymuje stack. Hash nie oznacza pełnego loga po przekroczeniu limitu. Błędy zawierają wyłącznie code/messageSHA, bez surowej wiadomości, args i secrets.
- Brak zmian Source istniejących usług, ich permissions, provider destinations lub opt-in reguł. Włączenie stacka nie nadaje pracy wielu tenantów ani zgody na providerwrite. Profile i źródła muszą być przeglądane jako normalny kod/config operatora; supervisor nie jest sandboxem dla złośliwego node entrypoint.

## Skupiona weryfikacja

```sh
node --check tools/local/stack.mjs
node --test tools/local/stack.test.mjs tools/local/operator.test.mjs
```

Testy tworzą wyłącznie nowe temp600/700 i rzeczywiste syntetyczne childHTTP serwery na losowych wolnych loopback ports. Sprawdzają kolejność, gotowość, konflikt, earlyexit, częściowy cleanup, signal duringstartup, profiledrift, limitlogów i brak dziedziczeniaDSN. Nie używają aktualnych Main/Woo/SMTP/PG ani kont providerów. Pełny rzeczywisty odbiór nowego stacka i dalsze worker scopes muszą mieć osobny jawny krok Root.
