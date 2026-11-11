# Workery i lokalny lifecycle — plan implementacji

Status na18.10.2026: rzeczywisty lokalny lifecycle zwykłe API–worker–SMTP dwóch tenantów odebrano w oryginalnym68071 EXIT0 (`PASS_LOCAL_API_WORKER_SMTP_LIFECYCLE_ONLY`). Nowe wydanie209 `09158d0b…`, osobna kopia bazy, API4104 i prywatny SMTP60951; Main/APP16 zachowane. Cztery wiadomości DB odpowiadają czterem skutkom odbiornika bez deduplikacji:2 smtp_accepted/2 uncertain. Pause/drain/restart, zatrzymane DATA oraz brak replay po utracie ACK potwierdzono w tym zakresie. Pięć własnych cykli stacka zamknięto, globalnie0 opt-in przy39 tenantach. Osobny Chrome odebrał odczyt statusu/historii i oryginalnej uncertain wiadomości obu tenantów przy0 business POST. UI creation/pause/resume/drain/restart **NOT_ACCEPTED**; brak doręczenia zewnętrznego, skali, fizycznego stocku i odbioru wszystkich providerów. [Dokładny raport i granice](WORKER-SMTP-LIFECYCLE-LOCAL-20261018.md).

Root obejrzał oba zrzuty Chrome i potwierdził po nim4 wiadomości/4 skutki,0 globalnych opt-in oraz zachowane Main/APP16. Późniejszy własny stack UI i SMTP zamknięto EXIT0;4104/60951 zwolnione, stary1025 zachowany. Poprawka prezentacji `c8e9159` ma45 testów React PASS/typecheck EXIT0; nie jest częścią09158 i nie ma nowego rzeczywistego odbioru wizualnego.

Poniższy plan zachowuje wcześniejszą analizę źródeł i dalsze wymagania. Nie jest listą wszystkich zamkniętych punktów. Wąski odbiór SMTP nie zamyka coexist transportów, innych worker kinds ani pełnego Goala.

## Co rzeczywiście działa i co blokuje wspólny runtime

| Miejsce | Obecne zachowanie | Minimalna zmiana |
|---|---|---|
| `tools/local/operator.mjs`, `validateProfile` / `commandFor` | Już umie oba refs i oba argumenty, lecz odrzuca jednoczesne `connectorAccessSelection` i `localWooSelection`. | Dopuścić ich współistnienie po sprawdzeniu rozłączności capability; zachować wszystkie stare profile i domyślne flags. |
| `server/ordinary-local-cli.ts:20–49` | Parser również odrzuca parę selekcji; ma stały limit15 argv. | Usunąć wyłącznie konflikt, policzyć poprawny skończony limit argv dla legalnej kombinacji; zachować duplicate/unknown/private-file/hash guards. |
| `server/ordinary-provider-reads.ts:48–52` | `prepareOrdinaryConnectorAccess` odrzuca `localWooFixture`. Inne opt-in NBP/MCF/providerReads mają osobne odmowy. | W pierwszym patchu połączyć tylko connectorAccess + własne Woo. Nie usuwać hurtowo pozostałych odmów ani readOnly guard. |
| `server/ordinary-local-runtime.ts:49–91,157–169` | Przekazuje osobny connector transport, ale preferuje lokalny Woo jako integrationTransport. Globalne workery są zawsze OFF. | Złożyć rozłączne transporty w istniejącym konstruktorze; nie uruchamiać `server/index.ts` i nie przełączać globalnych workerów. |
| `server/app.ts:323–332,378–387` | `bindOrdinaryConnectorTransport` już wybiera dokładny origin przed wysłaniem; brak retry/fallback po błędzie. `buildApp` blokuje hasLocalWoo+connector. | Zachować branded transporty, wybrać jeden transport przed dispatch, odmówić niejednoznacznego originu. Nie używać catch→drugi transport. |
| `server/ordinary-connector-jobs.ts:12–16` | Manualny executor wymaga sandbox connectorów innych niż Woo, ale dodatkowo odrzuca samą obecność lokalnego Woo. | Zastąpić ten globalny konflikt kontrolą konkretnego joba/providera; nadal wyłącznie jawny sandbox_manual_once i świeży własny job. |

Lokalny Woo registry (`server/local-woo-http-registry.ts`) ma prywatny WeakMap, dokładne tenant/user/channel/origin i własne TLS transporty/close. Te checks nie mogą zostać zastąpione capability z JSON lub wspólnym fetch. Dwa transporty obsługujące ten sam origin mają być błędem konstrukcji przed jakimkolwiek IO. Connector nie dostaje dostępu do loopback tylko dlatego, że profil zawiera Woo.

## Trwałość i uprawnienia: rozszerzać obecny model

`server/scoped-automation-worker.ts` już ma pojedynczy aktywny cycle, bounded discovery32 reguł, cursor, close/drain i bounded128 wyników diagnostycznych. Discovery wybiera zapisane `owned-automatic-rule/v1` opt-in. Nie jest to ogólny worker providerów.

`server/local-automation-worker-control.ts:42–109` sprawdza w oryginalnym tenantTx autentyczny prywatny lease, bieżącego autora-admina, exact rule/version/activation, watermark, event i zamrożoną definicję. Claim wybiera pending/attempts0/bez lease, FOR UPDATE SKIP LOCKED; zapisuje attempts1/max_attempts1. Rozpoczęte/expired/unknown nie są reclaimowane. Stock/email child wiąże się z konkretnym zakończonym runem i źródłem. Ponowny start wznawia tylko nadal nieuruchomione dozwolone pending po `run_at`.

Zachować te semantyki. Najmniejszy kolejny etap:

1. Coexist transportów + regresja dotychczasowych trzech akcji (workflow/status, localWoo stock, lokalny SMTP). Brak nowych providerwrite z samego uruchomienia stacka.
2. Dla kolejnego rodzaju akcji dodać jawny opt-in polityki do istniejącego rule/control/lease, aktualną walidację konta i frozen source, a potem użyć istniejącego procesora. Nie robić nowej uniwersalnej bazy kolejki/proof engine.
3. Przed siecią trwale zapisać i potwierdzić dokładną intencję/próbę; sprawdzić nadal aktualną rolę, tenant, channel/config/lease. Niepotwierdzony COMMIT oznacza zero provider calls. Utracony ACK po dispatch pozostaje do normalnego GET/uzgodnienia, bez automatycznego replay. Nowy job obserwacyjny musi być odczytowy i powiązany z oryginalnym planem.
4. Reconciliation pokazać w istniejącej historii/queue UI. Nie maskować unknown jako success lub nowy attempts0. Zmiana reguły/roli/credentials przed dispatch ma odmówić; zmiana po wysłaniu nie uprawnia do drugiego wywołania.

`ordinary-connector-jobs.ts:20–75` jest precedensem dla fresh IAM/session, durable intent, exact plan/job/config oraz jednego dispatch; to manualny sandbox executor, nie scheduler do bezpośredniego owinięcia pętlą. Jego `run` jest związany z cookies aktualnego administratora. Worker nie może udawać takiej sesji; wspólny kod można wydzielić jako wewnętrzne admission/processor po osobnej ocenie per-kind, pozostawiając różne źródła uprawnień manual vs trwały opt-in.

**Nie używać globalnego `startWorker()` jako skrótu.** `server/worker.ts:90–124,569+` zawiera szerokie schedulery/reapery i odzyskiwanie running→pending po czasie. To inny kontrakt od V2 no-unknown-replay. `server/index.ts` dodatkowo seeduje oraz włącza AI/DeepL workery. Istniejący `ordinary-local-worker.ts` daje wąski precedens lifecycle dla repricing, ale jego politykę jobów należy ocenić osobno; ograniczony kind sam nie dowodzi bezpieczeństwa reaperów.

## Własność procesu i shutdown

Nowy `tools/local/stack.mjs` ma tylko nadzorować istniejące foreground node entrypoints. Użyć tego samego `ordinary-local-cli` co `operator.commandFor`, istniejących canonical Woo i smtp-sink; bez fabryki aplikacji w supervisorze i bez drugiej fabryki na tym samym DB. Rozdzielić warstwę start/status/stop od uprawnień aplikacji, selekcji providerów i trwałych opt-in reguł. Nie uruchamiać automatycznie profili obecnego Main.

Jeden prywatny profil i jeden owned state dla stacka; exact entry/ref/args/cwd/environment-path refs, loopback-only readiness, bounded log metadata/SHA, process uid/birth/command hash. Ready oznacza wyłącznie spełnione skonfigurowane probes, nie odbiór biznesowy. SMTP TCP nie dowodzi AUTH/delivery; Woo TCP nie zastępuje własnego initial-bootstrap/normal API.

Start zależności w kolejności profilu, stop odwrotnie (Main/worker przed Woo/SMTP); po częściowym starcie zamknąć także rozpoczęte procesy. SIGTERM podczas startup ma zostać zapamiętany. W aplikacji najpierw zatrzymać claims/nowe requests, potem doczekać prawdziwych requests i effects, następnie transport/importer/shared scope/owners/pool. Obecny `ordinary-local-runtime.close()` jest idempotentny; hooks `app.ts:1506–1509` drainują scoped worker przed końcem poola. Nie wymuszać kill ani nie zatrzymywać PostgreSQL. Timeout oznacza unconfirmed closure, zachowany stan i błąd, nie deklarację cleanclose.

Do sprawdzenia przy implementacji: `ordinary-local-cli.ts:49–51` dopiero po awaited factory podpina signals; `operator.mjs` podpina forward po spawn/birth/state. Supervisor musi pamiętać wcześniejszy stop, ale nie może naprawiać tego przez zabicie jeszcze konstruującej się factory. App-level remember-stop-before-factory wymaga osobnego małego patcha i kontrolowanej regresji; nie deklarować, że sam supervisor zamyka tę lukę. Wyjście supervisorowi podczas aktywnego child też nie może być PASS.

## Istniejące API i UI — bez nowych operatorowych wrapperów biznesowych

- `GET/POST /api/automations/:id/local-worker` oraz `GET /api/automations/local-effects/options`; `web/local-automation-worker-control.tsx` już ma „Włącz dla nowych zdarzeń”, stan procesora, wersję i komunikat reconciliation. `AutomationStudio` jest w `web/operations.tsx`, osadzony przez `web/main.tsx`.
- `GET /api/local-operator/connector-jobs/:id` i `POST .../:id/run-once`: istniejące manual sandbox ABI; nie stosować do background claim ani unknown replay. W przeglądanych komponentach nie znaleziono wywołania tego konkretnego endpointu; normalny przycisk w istniejącym IntegrationWorkspace to osobne zadanie UI, nie powód do codziennego CLI.
- Zachować istniejącą kolejkę/reconciliation w `web/integration-recovery-queue.tsx` i osobne own-localWoo flows w `web/configured-woo.tsx`. API statusów nie może ujawniać credential bytes lub pozwalać na obce joby.
- `GET /api/health` ma capability scoped/background/connector/importer; dodać małą obserwowalność started/draining/refused dla faktycznie uruchomionych workerów zamiast utożsamiać listening z przetwarzaniem. Wyniki trwałych skutków pozostają w jobs/runs/audit, nie RAM inspect.

## Weryfikacja i kolejność dostawy

1. Najpierw testy kontrolowane coexist: oba selections razem/importer/scoped flag, rozłączne origins; foreign/overlap/method/body/redirect odmowy przed dispatch; błędu pierwszego transportu nigdy nie wysyłać drugim. Domyślne i readOnly profile pozostają odmowne. Aktualizować stare testy konfliktu wyłącznie do nowego jawnego zakresu, nie usuwać pozostałych negatywów.
2. Realne child-process HTTP fixtures dla stacka: startup readiness/timeout, duplicate port, early exit, partial reverse cleanup, signal podczas startup, idle child error, stop idempotence, birth/profile drift, bounded logs, brak odziedziczonego DATABASE_URL, zero PG lifecycle. To testy nowych testowych procesów, nie Main/providerów.
3. Job tests: revoke role/rule/channel przed effect, dwóch claimers, delayed pending po restarcie, unknown/attempted nigdy replay, utracony COMMIT przed HTTP, utrata ACK po HTTP, błąd cleanup zachowuje primary, close czeka na rozpoczęty effect. Branded lease nie pochodzi z publicznego JSON.
4. Root odebrał lokalne API/SMTP dwóch tenantów w68071; tworzenie i sterowanie przez zwykły UI (odczyt Chrome odebrany), realne konta dostawców tam, gdzie wymagane, docelowy multiTenant/load z aktywnymi workerami i coordinated recovery pozostają osobnymi actual bramami. Nie zastępować ich syntetycznym PASS, nie modyfikować zaakceptowanego V2 pakietu/profili.

Polecenia planowanych skupionych kontroli (w `local-app`, nie wykonano podczas tego przeglądu):

```sh
node --test tools/local/stack.test.mjs tools/local/operator.test.mjs
node --import tsx --test tests/ordinary-local-cli.test.ts tests/ordinary-provider-reads.test.ts tests/provider-read-transport.test.ts tests/local-woo-multistore-transport.test.ts tests/automation-local-effects.test.ts tests/ordinary-local-worker.test.ts
npm run typecheck
```

Dokument nie ustala nowych SLA, nie nadaje sandbox/live akceptacji, nie tworzy profili runtime i nie uprawnia workera do dodatkowych tenantów/providerów. Minimalne code ownership pierwszego etapu: operator/CLI/provider-preparation/runtime/app/manual connector guard + ich focused tests; dalsze worker kinds dopiero po zamkniętym admission per-kind.
