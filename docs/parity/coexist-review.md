# Niezależny przegląd coexist i walidatora parytety

Stan: 2026-10-17. Zakres: statyczny diff izolowanego development/full-base oraz dwie czysto plikowe próby istniejącego checkInventories w RAM. Bez uruchamiania aplikacji, HTTP, PG, kont, lifecycle i testów biznesowych. Własność: wyłącznie ten raport. Pełny Goal pozostaje częściowy.

## Wniosek

**Coexist: brak wykrytego blokera bezpieczeństwa w przeczytanym diffie; oczekiwane testy Root przed integracją. Walidator: HOLD dla traktowania full_coverage_ready jako wiarygodnej bramy semantycznej.** Obecna macierz integracji daje valid=true/full_coverage_ready=false i nie zostaje tym raportem odebrana jako gotowy produkt.

## Ustalenia wymagające korekty

1. **P2 — nieweryfikowane dowody lokalne.** tools/parity/check.mjs CLAIMS zna accepted_local, lecz nie local_scoped_acceptance używane przez23 wiersze aktualnej macierzy. Referencje tych wierszy są w evidence.local[].ref. Aktualna próba na prawdziwym JSON zwróciła valid=true, evidence_files_verified=0, required_open=313. To nie fałszywy PASS obecnej parytety, ale validator nie wykryje usunięcia lub driftu wskazanych lokalnych receipts. Minimalnie: rozpoznać scoped local jako poziom local, normalizować r.ref??r i zweryfikować każdą zadeklarowaną referencję lokalną; lokalny odbiór nadal nie spełnia account. Locator kodu bez SHA nie jest dodatnim dowodem i nie powinien być tak traktowany.

2. **P2 — sprzeczne complete może dać fałszywe ready.** Kontrolna kopia dokumentu wyłącznie w RAM: inventory_complete=true, coverage_gaps=[], wszystkie status=complete, required_evidence_level=local i evidence.local wskazujące sam poprawnie zahashowany plik macierzy. Pozostawiono summary.full_base_roster_complete=false i verification.account=unverified_external_provider_account. requireComplete=true zwróciło valid=true/full_coverage_ready=true/errors=[]; zweryfikowano tylko jeden plik. Nie zapisano tej kopii i nie zmieniono prawdziwej macierzy. Minimalnie: jawna polityka wymaganego poziomu poza dowolną deklaracją wiersza, odmowa sprzecznych flag pełnego rosteru/verification, zakaz używania samego inventory jako dowodu wykonania i wymagany typ/status właściwego receipt. Hash dowodzi tożsamości pliku, nie przyjęcia operacji. Przy zachowaniu walidatora tylko strukturalnego bezpieczniej nazwać wynik structural_coverage_declared zamiast full_coverage_ready i zostawić osobną bramę semantyczną Root.

## Zachowane zabezpieczenia coexist

- ordinary-connector-routing.ts wybiera transport raz po dokładnym URL.origin. Origin z innym portem, hostem podobnym tekstowo lub innym protokołem nie staje się zaufanym originem konektora. Nie ma catch/retry wokół wybranego transportu; jego synchroniczny wyjątek lub odrzucony Promise nie przechodzi do fallback. Błędny URL kierowany jest do connector, który nadal odmawia w swoim parserze.
- Originy Allegro sandbox/live, InPost i DPD są literalne; DPDInfo tylko live. Woo publiczne jest związane ze storeUrl; prywatny localWoo dopuszcza tylko localhost8443/8444, własne kanały i CA. prepareOrdinaryConnectorAccess sprawdza rozłączność z oboma originami localWoo. Walidacja publicznego URL nadal dopuszcza wyłącznie HTTPS443, a transport nadal sprawdza publiczny DNS/peer/TLS i ścisłą ścieżkę/metodę/body/header.
- Usunięto tylko zakaz jednoczesnego użycia lokalnego Woo i konektora. sandbox_manual_once nadal odmawia każdego Woo w capabilities i każdego live, wymaga aktualnej zwykłej sesji admina, tenant/actor/channel/job/plan, świeżego pending attempts0, oryginalnej intencji i lease. Własny transport tej próby nadal dopuszcza wyłącznie sandbox origin danego Allegro/InPost/DPD; nie używa lokalnego fallback. Te fragmenty nie zostały zmienione.
- Read-only nadal odmawia connector access oraz localWoo; domyślnie żaden nowy opt-in nie jest włączony. Globalni background workers pozostają false. Scoped automation zachowuje osobny transport localWoo i znaną listę kanałów; nie otrzymuje złożonego transportu publicznych konektorów.
- CLI pozostawia args.length<=15, hash-pinned prywatne selections, ścisłe flagi oraz odmowę duplikatów i trybu sandbox jobs bez connector selection. Operator pozwala obie selections, nie dodaje flag ani dowolnego URL.

## Granice i testy Root

Ten raport nie zastępuje testów konstruktora/normalnego UI. Minimalne kontrole: exact origins/local fallback, brak fallback po sync/async błędzie, read-only refusal, Woo/live denied przez sandbox executor, unknown URL/method refusal oraz argv15/16 i duplikaty selections. Nowy parserowy test wszystkich flag na15 argumentach nie dowodzi działającego startupu: istniejące --nbp-eur oraz --amazon-mcf-sandbox-eu nadal odmawiają localWoo w prepareOrdinaryProviderReads/prepareOrdinaryAmazonMcfReads. To jawne istniejące ograniczenie, nie wykryte obejście ani obietnica zgodności wszystkich flag.

Nie stwierdzam, że samo współistnienie transportów dowodzi14 działających integracji ani poprawnego lifecycle każdego workera. Zewnętrzne sandboxy i konta nie były wywoływane.

## Piny przeczytanego zakresu

| Ścieżka względem development/full-base | SHA256 | Bajty |
|---|---|---:|
| server/ordinary-connector-routing.ts | 0866f8b7395827c56daa86fc7dbcd076d50dd89c49a7a1ec2763aac5aa428ce3 | 2098 |
| server/app.ts | 8c5aa38831e06eb866b63bfd50039be092957fbd283d03087e29646150e602dd | 98026 |
| server/ordinary-provider-reads.ts | 951dbaab7d9f874b4dcf85ac97c41d3b2035bf1851b9195162c0a9e169ede053 | 4730 |
| server/ordinary-connector-jobs.ts | 76e5e74df24a68ecdbe9262861a9a79c43011c6a4fd0a865c951ed77da0f26da | 13182 |
| server/ordinary-local-cli.ts | dea75bddcb0bfa24b0f96b833629bbd4cfa50b7f63394a4503f0655dab8a7daa | 7565 |
| tools/local/operator.mjs | 61f89b425a697bf84761a7ef9f981f9d63d1aea31a99a8e6f156b8353788e4f1 | 11115 |
| server/ordinary-connector-policy.ts | 1d3289ee329a4c19b35675c320f5201f5767fc3f053c27d8e8e0947c3e9062fd | 14326 |
| server/ordinary-local-runtime.ts | b027a7fd682c94783a876915a52b18ccf3f542bad75b445a8d222297252c8408 | 18398 |

Validator: /Users/arturtwardowski/DYNA Ecomerce/local-app/tools/parity/check.mjs; SHA256 7d62772bd9c8502277ece2072dcd79281054901c002eac87d6d8e2572be944d9; 6400B.

Inventory: /Users/arturtwardowski/DYNA Ecomerce/local-app/docs/parity/integrations.json; SHA256 c7eb039c26cd60a495dcd8b8eb624a5c58caed1be1d1f6f9f4656781318229d4; 1191016B.

Terminal plikowych kontroli: chunk8345be, EXIT0. Kontrolna sprzeczna macierz nigdy nie została zapisana.

## Amendment: ponowny niezależny przegląd po poprawce Root

**Dwa wcześniejsze ustalenia P2 dotyczące walidatora są zamknięte w przypiętej niżej wersji.** Ponowiona kontrola prawdziwej integrations.json zwróciła valid=true, completion_review_candidate=false, acceptance_granted_by_checker=false i43 unikalne zweryfikowane hashrefs. Pole full_coverage_ready zostało usunięte. Nested ref i local_scoped_acceptance są obsługiwane. Celowy drift SHA jednego lokalnego receipt powoduje odmowę (2 błędy), a dokładny wcześniejszy kontrprzykład complete/provider-local/sam plik inventory przy pozostawionych sprzecznych deklaracjach otrzymał valid=false/candidate=false i627 błędów. Kopie były tylko w RAM. Nie jest to certyfikacja treści wszystkich przyszłych receipts; checker wprost nie nadaje odbioru.

Kontrole autora walidatora zostały niezależnie powtórzone:5/5 PASS, EXIT0, chunk91fb1b. Własne trzy kontrole powyżej: EXIT0, chunk902fe2.

**Coexist:5/5 kontrolowanych testów Root PASS.** Testy importują prawdziwe moduły, ale DNS jest kontrolowanym portem, a local fallback modelem bez połączenia. Sprawdzono inert construction/readonly/brand, overlap, exact local selection, brak fallback po DNS/method/URL failure oraz odmowę Woo/live dla sandbox manual. Nie są to wywołania aplikacji, publicznych dostawców ani dowód normalnego startupu/UI.

**Nowy early-signal lifecycle:9/9 kontrolowanych testów autora PASS**, chunkc7f469/EXIT0 razem14/14 z coexist. VM wykonuje cały transpile prawdziwego CLI bez zamiany kodu, przy syntetycznych portach FS/process/factory. Testy sensownie pokrywają sygnał przed factory i podczas factory/listen, pojedynczy close/drain, brak fałszywego LISTENING, oryginalny pierwszy błąd także przy błędzie close/FD i inert import. Nie uruchomiono prawdziwej aplikacji, providerów ani PG.

### Dodatkowe P2 lifecycle — drugi taki sam sygnał podczas drain

W przypiętym CLI linia51 pozostawia process.once('SIGINT',onSignal) i process.once('SIGTERM',onSignal). Po pierwszym SIGTERM handler tego sygnału jest usunięty, choć factory/close może nadal czekać. Drugi SIGTERM na prawdziwym procesie może zastosować domyślną terminację przed domknięciem ownerów. Dziewięć modeli emituje SIGTERM+SIGINT, nie SIGTERM+SIGTERM; zwykły EventEmitter też nie odwzorowuje systemowej terminacji przy braku listenera. To odziedziczony wzorzec, nie nowa utrata kontroli dostawców, ale nowy early-stop mechanizm go nie naprawia. Minimalna poprawka: process.on dla obu sygnałów i istniejące removeSignals dopiero po zakończeniu drain; stopping??= nadal zapewnia jedno close. Focused regresja powinna utrzymać listener po dwóch takich samych sygnałach przy deferred factory/close oraz sprawdzić pojedynczy close i finalne usunięcie obu listenerów. Root został powiadomiony; kod nie był edytowany przez reviewera.

Aktualny wynik: **walidator wcześniejszych dwóch luk ACK; coexist kontrolowane źródłowo ACK; lifecycle sygnału jednokrotnego ACK, powtórzony ten sam sygnał wymaga powyższej wąskiej poprawki.** Full Goal nadal częściowy; ten przegląd nie nadaje akceptacji runtime/integracji.

Piny amendment:

| Plik | SHA256 | Bajty |
|---|---|---:|
| /Users/arturtwardowski/DYNA Ecomerce/local-app/tools/parity/check.mjs | 952973b5e04367ab8a4f1756b02f288fc28e8529a57b307aa69d0293d678bc5d | 7386 |
| /Users/arturtwardowski/DYNA Ecomerce/local-app/tools/parity/check.test.mjs | f51c675b70080ec0617d8360725365e10fd7b377d9219930d7204ac43e5bc671 | 4416 |
| /Users/arturtwardowski/DYNA Ecomerce/development/full-base/server/ordinary-local-cli.ts | 4645cc7489cae9fb2c5c7a263bd8d6c3474fde72b75e3ad1cd3f95edf3969fa6 | 7561 |
| /Users/arturtwardowski/DYNA Ecomerce/development/full-base/tests/ordinary-connector-coexist.test.ts | 9a6bdecac83b2439179933808b7487eccf0eb9dccbfb7dbfa5f9405325c35468 | 4111 |
| /Users/arturtwardowski/DYNA Ecomerce/development/full-base/tests/ordinary-local-cli-lifecycle.test.ts | 3237e6378abbaa4c9ab6d99c8efa221b1f803fbf232ad4f3fc373b5df24b0621 | 10435 |
