# Harmonogramy — współstart aplikacji i workera (18.10.2026)

**S2: współstart, historia, lokalne odmowy IAM, naturalne terminy i łagodny restart odebrane w opisanym zakresie.** Nowe wydanie `d7b99d110c89cafd9f4fb1a4c49be7c7f08b6a9abd0e93bc7edf474a6d3cc71c` zachowało cały stempel1703 po uruchomieniu aplikacji i osobnego workera. Normalne API oraz uwierzytelniony Chrome odczytały historię26 wykonań i wyniki pierwszego wykonania na stronach25+1. Nowy harmonogram wykonał bez ręcznego run26 zmian, następnie0, a po pauzie, restarcie workera i wznowieniu ponownie0. Dane uzgodniono; własne procesy próby zamknięto. Późniejsza pełna kontrola187 przekroczyła8s; osobne uzgodnienie danych nie zastępuje tej niezaliczonej bramki. Pełny Goal pozostaje otwarty.

**Zachowana próba S1:** wydanie `315b269e058edcd2c02184d807963df5421cd290daca8d4646cdd96b49b09bed` zapisało26 rzeczywistych skutków, lecz nie przeszło odbioru wspólnego działania. Osiągnęło APP READY, po czym Startup osobnego workera zmienił generację i odciął odczyty aplikacji. Nie powtarzano nieudanego polecenia ani pierwszej operacji biznesowej. Poniższe wcześniejsze wyniki zachowują swój historyczny zakres.

## Rzeczywisty przebieg i zachowane dane

Pakiet obejmował 382 pliki i 99 451 722 B. Zwykły Startup na własnej odtworzonej kopii wykonał źródłowo autoryzowaną normalizację 232 domyślnych ACL; nie naprawiano ACL ręcznie przed startem. Generacja wzrosła z 1469 do 1702. Osobna kontrola tylko do odczytu potwierdziła pełny stempel, `dirty=false`, `validated_generation=1702`, ten sam release, 37 firm, zero opt-inów lokalnych reguł oraz ostatnią migrację209. Pełne guardy209 i187 sprawdzono osobno przy limicie8s: oba TRUE; ROLLBACK i zamknięcie klienta potwierdzone. Samo to nie było odbiorem biznesowym.

Przez normalne API utworzono własną firmę, produkt i26 ręcznych zamówień z WMS OFF. Chrome posłużył do utworzenia harmonogramu z jedną akcją `add_tag` oraz zakolejkowania pierwszego wykonania. Globalne workery i scoped rules pozostawały wyłączone; uruchomiono osobny worker ograniczony do tej firmy, harmonogramu, autora, znacznika czasu i dokładnego taga.

Obserwator PostgreSQL tylko do odczytu zapisał rzeczywistą sekwencję: `queued/pending/0` → `running` → `queued/pending/25` → nowa dzierżawa `running` → `done/26`. To bezpośredni dowód dwóch partii25+1, a nie wniosek wyłącznie z końcowego licznika. Nie zmienił się hash652 pozostałych zadań. Kontrola zachowanych danych przed poprawionym wydaniem potwierdziła26 zamówień ze statusem `new`, jeden właściwy tag na każdym, wersję podniesioną dokładnie o1,26 receipts,26 elementów `done` i26 zdarzeń zmiany taga. Zapas wynosił `on_hand=26`, `reserved=26`, `available=0`; liczba firm po własnym signup wynosiła38. Kontrole zakończono ROLLBACK i potwierdzonym zamknięciem klienta.

Jednocześnie drugi zwykły Startup podniósł generację1702→1703 i zatwierdził ją z tym samym wydaniem. Działająca aplikacja zachowała wcześniejszy pełny stempel1702 i poprawnie odmówiła użycia zmienionej generacji. GET `/api/automation-schedules` zwrócił500 (`req-a7`); pierwsze polecenie `read-first` zakończyło się EXIT1 po101ms, z **zerem POST**. Potwierdza to błąd współstartu mimo poprawnych trwałych skutków workera. Dane i błąd pozostają zachowane, bez replay.

Worker zakończył się EXIT0 po254624ms. Aplikacja zakończyła się EXIT0 po576986ms; supervisor potwierdził stan `closed`, brak błędu i pustą listę cleanup. Odbiór nie obejmuje odzyskiwania po nagłym zabiciu procesu.

## Poprawka źródeł i granica wcześniejszego odbioru

Przyczyna: bezwarunkowe `CREATE TABLE IF NOT EXISTS migrations` w migratorze wywoływało `ddl_command_start` i zwiększało generację także przy istniejącej tabeli. Samo zapisanie JS gate przez `installOrdinarySchemaRuntime` nie wykonuje DDL. Lokalny commit `8382112` wprowadza [skończony bootstrap](../../server/migration-bootstrap.ts): pod dotychczasową wyłączną blokadą982376 odczytuje dokładnie `public.migrations`; istniejąca trwała tabela właściciela `postgres` oznacza zero DDL, brak tabeli zachowuje bootstrap z nullable `applied_at`, a błędna tożsamość odmawia bez naprawiania. Pełne guardy, normalizacja, cold admission i kontrola generacji pozostają włączone.

Root wykonał osobną rzeczywistą regresję na istniejącej tabeli: jedno SELECT pod982376, cały stempel1703 bez zmiany, ROLLBACK i zamknięcie klienta TRUE. Sama ta regresja potwierdzała brak DDL tego przypadku, **nie naprawiony współstart nowego wydania**.44 ukierunkowane testy workera/bootstrapu przeszły, typecheck EXIT0. Test planu migracji początkowo miał stare oczekiwania207/198; taki sam wynik odtworzono na bazie. Po zachowaniu niezmienionej pętli i aktualizacji literalnych oczekiwań208/209 przeszedł4/4. Te kontrole nie zastępowały osobnego odbioru pakietu i API/UI opisanego dalej.

Wcześniejszy lokalny commit `4a12e4c` dodaje ograniczone zakolejkowanie pracy według terminu i blokowanie bieżącego członkostwa administratora. W próbie315b miał wyłącznie odbiór **SOURCE ONLY**, ponieważ tamto wydanie go nie zawierało. S2 zawiera ten kod i osobno potwierdza współstart, opisane odmowy dostępu i naturalne terminy przedstawione poniżej. Test zmiany uprawnień podczas pracy nadal wymaga osobnego wykonania.

W próbie315b nie odebrano25 kolejnych pustych runów, stron historii, odmów IAM, restartu ani naprawionego współstartu. Nie wykonywano tych etapów po błędzie GET500. Nowy odbiór S2 opisano poniżej; nie zmienia on wyniku tamtej próby.

## S2 — rzeczywisty współstart na zachowanych danych

Pakiet `d7b99d11…` obejmuje382 pliki i99 453 662 B. Root uruchomił zwykłą aplikację, a następnie osobny worker tego samego wydania na tej samej własnej bazie i z zachowanym kluczem konfiguracji. Nie odtwarzano ani nie kopiowano ponownie danych. Dwa odczyty kontrolne — przed i po starcie workera — mają status `CO_START_READONLY_BOOKEND_PASS`.

Oba porównały cały wiersz kontroli runtime z zachowanym źródłem dowodowym: `generation=validated_generation=1703`, `dirty=false`, niezmienione native/profile/contract oraz `release_sha256` równe nowemu wydaniu. Między startem aplikacji i workera cały ten wiersz pozostał identyczny. Osobne pełne guardy209 i187 zwróciły TRUE przy niezmienionym limicie8s. Odczytano38 firm,0 opt-inów lokalnych reguł i migrację209.

Pełne porównania potwierdziły te same26 projekcji zamówień, receipts, elementów `done`, zdarzeń zmiany taga i stan magazynowy26/26/0. Hash całych652 zadań pozostałych firm pozostał `fea2273b…`. Każdy bookend wykonał trzy zwykłe GET200: health nowego wydania z obiema flagami workerów FALSE, listę jednego włączonego harmonogramu v1 oraz szczegóły pierwszego wykonania `done=26`, `job_state=done`. Wszystkie odczyty SQL były READ ONLY, z potwierdzonym ROLLBACK i zamknięciem klienta; nie wykonano biznesowych POST.

### Zachowany błąd obserwatora strefy czasowej

Pierwszy bookend S2 zakończył się EXIT1 przed HTTP: pełny stempel1703, guardy i26 zachowanych skutków przeszły, lecz hash652 obcych zadań różnił się przy serializacji UTC. Osobny rzeczywisty odczyt Root wykazał `Europe/Warsaw → UTC → Europe/Warsaw`: pierwotny hash `fea2273b…`, hash UTC `b01b3f03…`, po powrocie ponownie pierwotny hash. To różnica serializacji `to_jsonb(j)` pól czasu, bez dowodu zmiany zadań.

Oryginalny skrypt i nieudany wynik pozostają zachowane. Nowy `timezone02` przy obu porównaniach używa dokładnego pierwotnego SQL i domyślnej strefy `Europe/Warsaw`, po udanym odczycie przywraca UTC. Oczekiwane652/`fea2273b…` nie zostały zastąpione zaobserwowanym hashem UTC. Pozostałe kontrole i limity są zachowane; błąd SQL przechodzi do dotychczasowego ROLLBACK bez maskowania kolejnym SET.

## S2 — historia26 wykonań, wyniki i uprawnienia

Osobny `read-first` na nowym wydaniu zakończył się PASS:8 GET,0 POST, pierwsze wykonanie `scanned=done=26`, `skipped=failed=0`. Dwie strony wyników25+1 zawierają dokładnie26 unikalnych ID zamówień z pierwotnego setupu. Nie tworzono ani nie zakolejkowano ponownie pierwszego wykonania.

Następnie Root wykonał25 odrębnych POST przez zwykłe API, każdy z wcześniej zapisanym unikalnym kluczem klienta i własnym ACK. Każde wykonanie kończyło się przed następnym, z `scanned=done=failed=0`. Receipt potwierdza25 POST/25 ACK oraz85 GET. Historia26 wykonań ma strony25+1, dokładny zbiór26 ID i pierwotne wykonanie jako najstarsze. To wynik API;25 dodatkowych enqueue nie wykonano przez Chrome.

Odrębny odbiór IAM potwierdził sześć przypadków:401 bez sesji,409 dla nagłówka rzeczywiście utworzonej innej własnej firmy,404 historii i404 szczegółów pierwszego wykonania z jej sesji,200 dla odczytu własnej historii przez zaproszonego viewer oraz403 dla jego poprawnie zbudowanego żądania run. Wykonano dokładnie6 POST z ACK: signup obcej własnej firmy, zaproszenie viewer, jego signup, odmówiony run i dwa logout. Obie nowe sesje wylogowano, poprzednie tokeny odmówiły401, prywatne cookie jars są puste; sesję administratora zachowano. Historia przed i po ma te same26 ID. Nie usuwano firm ani członkostw fikstur.

Root potwierdził też zwykły uwierzytelniony interfejs w Chrome: pierwsza strona historii pokazuje25 pustych wykonań, przycisk „Starsze” prowadzi do jednego pierwotnego wykonania z26 wynikami. Wyniki pierwszego wykonania przechodzą25+1 przez „Dalsze”; zapisany zrzut pokazuje ostatnie zamówienie `DE-20261018-93FA34B9`. To rzeczywista aplikacja i API tego wydania. Wcześniejszy [test syntetyczny błędu/retry](AUTOMATION-SCHEDULE-HISTORY-LOCAL-20261018.md) zachowuje odrębny zakres; tutaj nie udzielono nowego odbioru błędów GET ani odświeżania co5s według zegara.

## S2 — naturalny termin, brak powtórzenia i pauza

Root utworzył przez zwykły Chrome drugi, początkowo wyłączony harmonogram: interwał60s, minimalny wiek0h, statusNowe, raz na zamówienie i definicję, warunek starego własnego taga i jedna akcja dodania nowego taga. Po uruchomieniu osobnego workera tego samego wydania potwierdzono niezmieniony stempel1703 i health200. Obserwator rozpoczął od wyłączonego harmonogramu bez wykonań; dopiero wtedy Root włączył go w UI. Nie wykonywano ręcznego POST/run ani zmian next_at przez SQL.

Rzeczywisty obserwator zakończył się EXIT0:293 GET,0 zapisów HTTP/SQL. Oba przyszłe next_at zapisano przed ich nadejściem, scheduled_for odpowiadały tym terminom, a wykonania nie powstały przed czasem. Pierwszy cykl zapisał26 skutków w partiach25+1 (stan po25 faktycznie zaobserwowano), drugi zakończył się0 sprawdzeń i0 skutków. Pełne GET26 zamówień potwierdziły dokładnie jeden dodatkowy tag i przyrost wersji o1; drugi cykl nie zmienił całych wyników odczytu. Zapas pozostał26/26/0, pierwotne26 ID historii bez zmian.

Root wyłączył harmonogram w UI przed kolejnym terminem. SQL READ ONLY potwierdził enabled=false, version3, definition_version1, next_atNULL, dokładnie dwa zakończone runy,26 nowych receipts,26+0 elementów oraz dokładnie52 zdarzenia tagów:26 pierwotnych i26 nowych. Pierwotne receipts, elementy i pełne26 wierszy historii pozostały identyczne. Nie ma aktywnych zadań tego scope;652 zadań innych firm zachowało oryginalny hash. Stempel1703 i guard209 pozostały zgodne; ROLLBACK i zamknięcie klienta potwierdzono. Następnie własny worker zakończył się łagodnie EXIT0 po310440ms. To odbiór naturalnego add_tag w jednej własnej firmie; bez dostawców, nagłego crashu lub wszystkich akcji.

## S2 — łagodny restart i wznowienie bez powtórnych skutków

Po potwierdzonej pauzie v3 i zakończeniu poprzedniego workera EXIT0 Root uruchomił nowy proces tego samego entry i dokładnie tej samej selekcji. Poprzedni PID był nieobecny; nowy PID, czas narodzin i hash polecenia zapisano osobno. Nowy worker osiągnął STARTED przy nadal wyłączonym harmonogramie, bez zmiany całego stempla1703; aplikacja nadal zwracała health200. Nie odtwarzano bazy, nie zmieniano lease ani nie ponawiano starego enqueue.

Obserwator rozpoczął od disabled/v3/dwóch zakończonych wykonań. Root wznowił harmonogram w UI (v4, definicja1); przyszły normalny termin+60s zapisano przed jego nadejściem. Trzeci naturalny run zakończył się0/0/0/0 bez elementów, z job_state=done. Wynik EXIT0/178 GET/0 POST potwierdza dokładnie3 ID runów, wszystkie26 pełnych odczytów zamówień identyczne z odczytami po drugim cyklu, identyczny stock i całą pierwotną historię26. Root ponownie wyłączył harmonogram w UI (v5).

Końcowy SQL READ ONLY porównał pierwotne zamówienia, receipts, elementy,52 zdarzenia, magazyn, historię26 i dwa wcześniejsze naturalne runy z przypiętym wynikiem sprzed restartu. Wszystkie były identyczne. Potwierdzono trzeci pusty run v4, pauzę v5 z next_atNULL, brak aktywnej pracy, niezmieniony stempel1703 i652 cudze zadania. Guard209 TRUE, ROLLBACK i zamknięcie TRUE; pełny187 nadal jawnie nieodebrany.

Po SIGTERM nowy worker zakończył się EXIT0 po272397ms. Normalne narzędzie stack stop zamknęło własną aplikację i supervisor: pierwotny handle aplikacji EXIT0/1540591ms, status closed, errorNULL, cleanup=[], PG_managed=false. Wszystkie pięć PID tej próby jest nieobecne, port4105 wolny. Main4100 i APP164103 zachowały HTTP200 oraz poprzednie pełne revision. Własna baza i dane pozostały zachowane. Ten test obejmuje łagodny stop/restart własnego scope; nie nagły crash, utratę ACK ani odtworzenie niepustej kolejki.

## S2 — zachowany timeout187 i odrębny dowód danych

Końcowa pełna kontrola po historii/IAM zakończyła się EXIT1: stempel1703,39 firm i guard209 przeszły, następny pełny187 przekroczył niezmieniony limit8s (57014). Przed odczytami danych i HTTP wykonano ROLLBACK oraz zamknięcie klienta. Próby nie powtarzano ani nie podnoszono limitu.

Osobna diagnostyka DATA ONLY, fizycznie bez wywołania187, zakończyła się EXIT0: te same26 zamówień/receipts/elementów/zdarzeń i zapas26/26/0, pełna pierwotna historia26,652 cudze zadania i7 GET200. Jej status jawnie zachowuje FULL187_NOT_ACCEPTED. Również późniejsze uzgodnienie dwóch naturalnych cykli nie nadaje odbioru187 lub profilu skali.

## Źródłowa poprawka odczytów — poza wydaniem S2

Lokalny commit `32c9522` przenosi trzy czyste GET listy/historii/wyników harmonogramów do tenantReadTx i usuwa z dwóch z nich mutex producenta kolejki e-mail. Zapytania, paginacja i wszystkie mutacje pozostają niezmienione; RLS oraz bramka generacji są zachowane. Root potwierdził7/7 testów kontrolowanych i typecheck EXIT0. S2 nie zawiera tej zmiany: odbiór nowego wspólnego wydania i pomiar czasu pozostają otwarte. Nie jest to naprawa timeoutu pełnego187 ani osobnego kosztu hydratora adresu w GET zamówienia.

## Pozostałe granice

Zmiana uprawnień podczas pracy, crash/utrata ACK, odtworzenie niepustej kolejki, pełny187 przy8s oraz odbiór nowej poprawki odczytów pozostają otwarte. Wszystkie własne procesy S2 zamknięto; dane zachowano. Odebrany lifecycle dotyczy wyłącznie lokalnego add_tag w jednym własnym scope. Nie zastępuje pełnej automatyki, recovery ani skali. Nie zamknięto żadnego z ośmiu nadrzędnych kryteriów pełnego [Goala](../FULL-BASE-GOAL.md); integracje dostawców i pełny split nadal pozostają otwarte.

## Artefakty lokalne

Poniższe prywatne dowody zawierają szczegóły potrzebne do kontroli; dokument nie kopiuje haseł, cookies, URL-i z poświadczeniami ani payloadów źródłowych.

| Dowód | SHA-256 |
| --- | --- |
| [Pakiet382/99 451 722 B](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-runtime-root-20261018-01/root-canonical-review.private.json) | `c2eef6f02e966b5095174eb175703351e159e671d54ff2e3ca7cbf5a70074026` |
| [Startup1702 i osobne guardy](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-runtime-root-20261018-01/poststartup-check.result.private.json) | `11f1b70c0580c65df7340414de9193e35735e9d04c0d70ab0f570e5aefb5e15f` |
| [Rzeczywiste partie25+1](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-runtime-root-20261018-01/first-run-observer.result.private.json) | `7087af21c156e322d1a17219fe4f2c0a2fcdcec28ad99cae61074b469820f818` |
| [GET500/req-a7](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-runtime-root-20261018-01/schedule-history-read-first01/003-response.private.json) | `96f5b5a81e46e13dfb05099c05ed360c6922d5da3e5727252b82cb2e8e7ea25a` |
| [Zachowane26 skutków](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-runtime-root-20261018-01/preserved-data-before-fixed-release.private.json) | `c0e464cd050f0b5a2a580a9843194a84b5d71997978bd7eb1aadc2de6b871a9c` |
| [Rzeczywisty bootstrap bez DDL](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-runtime-root-20261018-01/bootstrap-existing-real-regression.private.json) | `1a6f06c18aa108d0fe399323ece6833e4a00538e39eb5cc34418a18bb424dd9b` |
| [Zamknięta aplikacja i supervisor](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-runtime-root-20261018-01/stack-state.private.json) | `f0c1e77a74be02f175a3f6026973f9d0750c73f56da5bd1262e536fe4f38852d` |
| [Pakiet S2:382/99 453 662 B](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/root-canonical-review.private.json) | `2838e0e62ca6c18836991b2d7ced405cb99c34c8168e1d27396dee7ac52f8fbd` |
| [Zachowany pierwszy bookend S2: różnica strefy](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/co-start-before-worker.result.private.json) | `0379731457d43e221e667d9b7c96e0d644ddb324efa1885b6389796ec99d4fcc` |
| [Rzeczywiste porównanie podstawy TimeZone](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/other-jobs-timezone-basis-review.private.json) | `29b346e3a09812a8ce76e3e611667e10f74c74a1a866b05cbb4b121ee3f26628` |
| [S2 przed workerem: pełny stempel/dane/API](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/co-start-timezone02-before-worker.result.private.json) | `27b66b550315c77c7be289374d83e23ca6a07a4a9ff11dcf0fa1de1993b3a031` |
| [S2 po starcie workera: pełny stempel/dane/API](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/co-start-timezone02-after-worker.result.private.json) | `d88452d4f128d7674ba48c574b088bd7cfc208c1a8432967f6f9abf9770747de` |
| [S2 pierwsze wyniki:26 ID,25+1,0 POST](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/schedule-history-read-first01/result.private.json) | `0ec1be0f03a119b7afaefc922c8a054eb5fa43b634785b2a014eed0314bf3da4` |
| [S2:25 nowych pustych wykonań i historia25+1](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/schedule-history-enqueue25empty01/result.private.json) | `03e3af7003fae3e0eb49b8a0a4e9cf467b8a797e276cb5beb8804441e136f826` |
| [S2: rzeczywiste odmowy IAM i wylogowania](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/permissions-negative-api-run01/result.private.json) | `bed410402baef23d78d96c13d4c6c75a4b85258eed58d2a63c37fd86bfe905d5` |
| [S2: drugie strony historii i wyników w Chrome](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/history-and-results-second-pages-chrome.png) | `d9389ff8b5f7caecee43660a221199fea6bd5d31418c22d9a3c11fc101863291` |
| [S2 zamknięty worker historii](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/worker-terminal-root-review.private.json) | `d66d0f17faa0c9f198a7c908a12d257d82c5ac79e125b9f7c8e4c71dce72a816` |
| [S2 pełny187: zachowany timeout](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/closing-preservation-prepared-agent-20261018-01/run01/closing-preservation.result.private.json) | `e7495def1d286f6575b18c867e710e90af90f4f2076ede360148579ea5ced068` |
| [S2 osobne uzgodnienie danych bez187](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/closing-preservation-data-only-prepared-agent-20261018-02/run01/data-only-preservation.result.private.json) | `d2f528bb36aeeccb164bfbe17afc9d271be5d971929fe5f1701f4fc4d6530f8c` |
| [S2 dwa naturalne terminy26+0](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-time-acceptance-prepared-agent-20261018-01/observe01/result.private.json) | `7ea740322f5b57ed090d0e4c8fa005ab0c4ec9b036754ba4c53ef92b5abc3e63` |
| [S2 końcowe dane i pauza v3](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-final-data-prepared-agent-20261018-01/run01/due-final-data.result.private.json) | `fb96398de2aa426f94930bc33906a980f1272aeb4c73c1bb24fbd4a7bd15e894` |
| [S2 naturalny harmonogram: zamknięty worker](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-time-acceptance-prepared-agent-20261018-01/worker-terminal.private.json) | `2dd6d7c9309074a3a8b3daa63904f41e658ab9080541c5168152085ffe6cdad6` |
| [S2 naturalne terminy i pauza w Chrome](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/natural-due-26-plus0-paused-chrome.png) | `e9d190deb34c5a496e6183e2f234d91c6ab8380437be047e66587715cb447473` |
| [S2 restart: zgodna generacja i health200](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-scope-worker-restart-root-20261018-01/root-ready-and-generation.private.json) | `04190c806a9fa754b836130cd4b38274110925db3dd9ce6a76adebc31393f5e2` |
| [S2 wznowienie: trzeci pusty cykl](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-restart-acceptance-prepared-agent-20261018-01/observe-restart01/result.private.json) | `84f59e151feb6a8f9fd7945334452fcbcb5a04626ac4c49ee76cdfa643628b7d` |
| [S2 po restarcie: pełne uzgodnienie danych](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-restart-final-data-prepared-agent-20261018-01/run01/result.private.json) | `97aefd34d480c57cad3271291f7bf9319fb9c230bfde791c66625b619bea17cd` |
| [S2 po restarcie: zamknięty worker](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-scope-worker-restart-root-20261018-01/worker-terminal.private.json) | `e00b42b0848c1acd61a0fdccd26629b12ca8959ca897b459de1342e75c44daa9` |
| [S2 wznowienie i pauza w Chrome](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/restart-resume-empty-paused-chrome.png) | `f0c106512398fa645a0c7440922fc31424e94f5d693a8e964b510b7aed6fd8f1` |
| [S2 zamknięcie i zachowane Main/APP16](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/root-final-closure.private.json) | `c5d7e79cca76253ca0635af382eb95d612c27c1adf6fb380df61835878228905` |
