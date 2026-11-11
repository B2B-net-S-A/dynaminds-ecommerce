# Odbiór dwóch tenantów — SMTP worker ACK

Status: **rzeczywisty lokalny odbiór API–worker–SMTP PASS**, oryginalny68071 EXIT0; wynik `PASS_LOCAL_API_WORKER_SMTP_LIFECYCLE_ONLY`. Nowe wydanie209 `09158d0b…`, osobna kopia bazy/API4104/SMTP60951 i dwóch tenantów. Cztery wiadomości DB odpowiadają czterem skutkom SMTP bez deduplikacji:2 smtp_accepted/2 uncertain. Pause/drain/restart oraz brak ponowienia po utracie ACK potwierdzono;5 własnych cykli stacka zamknięto, globalnie0 opt-in przy39 tenantach. Osobny Chrome potwierdził odczyt statusu/historii/original-email obu tenantów przy0 business POST. UI creation/pause/resume/drain/restart **NOT_ACCEPTED**; doręczenie zewnętrzne, stock, skala i pełny Goal nieodebrane. [Pełny raport](../../docs/parity/WORKER-SMTP-LIFECYCLE-LOCAL-20261018.md).

Root niezależnie obejrzał oba zrzuty i potwierdził po Chrome4 wiadomości/4 skutki/0 opt-in. Późniejszy stack UI7210 i SMTP34567 zakończono EXIT0, porty4104/60951 zwolniono; stary1025 zachowano. Poprawka prezentacji `c8e9159` ma45 testów React PASS/typecheck EXIT0; nie jest częścią09158 ani nowym odebranym wizualnie wydaniem. Szczegółowe piny końcowego odczytu i cleanup są w powyższym raporcie.

Wcześniejszy kontrolowany test całego runnera:17/17 PASS, bez aplikacji, listenerów, workerów, SMTP service i PG. Porty importów procesu/SMTP/timerów oraz HTTP są syntetyczne wyłącznie w loaderze testowym; pliki, uprawnienia i fsync są rzeczywiste. Te testy nadal stanowią osobny dowód protokołu; rzeczywisty wynik pochodzi z przebiegu68071.

Domyślne przygotowanie wykonuje wyłącznie odczyt przypiętych lokalnych plików:

```sh
node tools/parity/worker-smtp-ack-acceptance.mjs prepare /ABS/private-selection.json SHA256
```

Tryb wykonania wymaga osobnego przeglądu Root, gotowych rzeczywistych fikstur i nowego lokalnego wydania. Nie używać go do Main ani APP16. Runner nie przyjmuje callbacków SQL, komend ani arbitralnego URL; wykonuje tylko istniejący tools/local/stack.mjs i zamknięte operacje ACK service.

Wymagany jest nowy przypięty pakiet, osobna kopia `dynaminds_worker_acceptance_<timestamp>`, osobny port API `apiPort` (1024..65535; 4100 i 4103 jawnie zabronione), wyłącznie `--verified-stock-writers --scoped-automation`, właścicielski `localSmtpPort` różny od 1025 oraz `apiPort` oraz działający prywatny ACK service. Root musi niezależnie potwierdzić globalny zakres opt-in w kopii bazy: normalne API administratora tenanta nie dowodzi braku aktywacji w innych tenantach. Obecna usługa na 1025 i APP16 pozostają nienaruszone.

Dwa prywatne lokalizatory logowania, dwa konta administratorów i dwie reguły email-only `order.note_added` muszą wskazywać rzeczywiste dane przygotowane normalnym API. Potrzeba sześciu świeżych, oznaczonych zamówień manualnych `.test` (accepted/lost/paused dla każdego tenanta), dwóch własnych kanałów SMTP i szablonów. Runner ich nie tworzy. Przed pierwszym business POST wymaga pustej notatki i email history każdego zamówienia oraz braku jobs, child effects i unresolved history własnych reguł. Loginy muszą spełniać normalne wymagania IAM/MFA; brak obejścia uwierzytelnienia.

Odebrany przebieg68071: odrzucenie dostępu między tenantami; aktywacja i zdarzenie notatki; trwałe zatrzymanie DATA przed ACK; pauza jako zmiana konfiguracji, nie drain ACK; rzeczywiste zakończenie własnego stacka dopiero po release 250; restart i readback; osobny drop ACK, stan uncertain i brak ponownej wysyłki po restarcie. Kontrola list/read odbiornika oraz normalne GET API służą uzgodnieniu. Żaden niepewny POST nie jest powtarzany. Notatka zamówienia nie ma serwerowego klucza idempotencji: lokalny UUID w dzienniku nie daje takiej gwarancji.

Każdy POST wymaga wcześniejszego wyłącznego dziennika 0600 + fsync; pole `client_key` dla konfiguracji workera odpowiada kluczowi rzeczywistego żądania. Polecenia SMTP używają istniejącego trwałego klienta ACK service. Odpowiedzi są ograniczone do pełnych 2 MiB API / 512 KiB kontroli SMTP; przekroczenie odmawia odbioru, nie obcina wyniku. Dane zamówień i surowe wiadomości mogą występować tylko w prywatnych artefaktach, nie w stdout.

Pozytywny wynik dotyczy wyłącznie lokalnego API i cyklu życia SMTP. Nie dowodzi dostarczenia wiadomości odbiorcy, testu prawdziwego konta, tworzenia i sterowania przez UI, fizycznego stocku, pełnego restore ani pojemności. Normalne API wiadomości nie udostępnia ogólnego licznika wszystkich prób jobs. Source27/P20/VECTOR27 pozostają źródłowe; ostatnia pełna próba C26 odmówiła przy8s, bez Native. Aktywacja split210 pozostaje zablokowana.

## Weryfikacja runnera

```sh
node --test --test-concurrency=1 tests/worker-smtp-ack-acceptance.test.mjs
```

Testy wykonują cały rzeczywisty kod runnera przez kontrolowane porty importów. Obejmują plik i fsync katalogu przed dispatch, brak ponowienia po utracie ACK konfiguracji/notatki/SMTP control, prawdziwy klucz konfiguracji w intencji, odmowę IAM/obcego tenanta/starych jobs, sygnalizację niepotwierdzonego drain, dryf SHA i uprawnień, ograniczenia prywatnego wejścia oraz przerwanie zbyt dużego strumienia bez obciętego sukcesu. Przed release ACK runner wymaga rzeczywistego prywatnego stanu stacka `draining` z właściwym profile SHA, żywego pierwotnego procesu i nadal zatrzymanego tego samego DATA. Opóźnione polecenie stop nie daje sukcesu bez tej obserwacji; brak draining odmawia release. Sam stan stacka nie dowodzi osobnego stanu DRAINING wewnątrz workera, dlatego końcowy dowód nadal wymaga czystego terminalu pierwotnego procesu i readback. Dwa zakończone różne cykle RAM obserwuje się po restarcie; nie są licznikiem trwałych prób.

## Zamknięta selekcja i komenda nowej próby

Selekcja 0600 zawiera dokładnie `schema`, `revision`, `expectedSchema`, `apiPort`, `stackProfile`, `smtpDirectory`, `auth`, `fixtures`, `observationMs`. Schema to `dynaminds-worker-smtp-ack-acceptance/v1`; profile/auth mają przypięte `{path,sha256}`. `auth` ma dwa lokalizatory 0600 schematu `dynaminds-worker-acceptance-auth/v1` z `email,password`. Każda z dwóch fikstur zawiera wyłącznie `tenant_id,actor_id,rule_id,channel_id,template_id,accepted_order_id,lost_order_id,paused_order_id,recipient,tag`. Obserwacja po restarcie trwa 13000..30000 ms. Nie przekazywać sekretów argumentami CLI.

Oryginalnego przebiegu68071 nie powtarzać. Każda nowa próba wymaga nowej selekcji/outputu i osobnego przygotowania oraz przeglądu Root:

```sh
node tools/parity/worker-smtp-ack-acceptance.mjs --run-owned-worker-smtp-ack-acceptance /ABS/private-selection.json SHA256 /ABS/FRESH_PRIVATE_OUTPUT
```

Wynik niepewny oznacza zatrzymanie. Istniejącego katalogu nie używa się ponownie. Dla utraconego ACK notatki brak endpointu wyszukania komendy po kluczu: zachowuje się dokładną notatkę i ID zamówienia do odrębnego GET-only przeglądu; runner nie wznawia automatycznie procesu. Utrata ACK konfiguracji lub kontroli SMTP również nie powoduje powtórzenia mutacji. `GET local-worker` jest konfiguracją/obserwacją, nie endpointem drain — dowód drain pochodzi wyłącznie z zakończenia własnego pierwotnego procesu i stanu stacka.
