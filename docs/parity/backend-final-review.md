# Niezależny final review zmian backendu — lokalny etap full Base

Data: 2026-10-17. Przegląd read-only kodu; zapisano wyłącznie ten raport.

## Wynik

**Nie znalazłem konkretnej nowej usterki wymagającej poprawki w przejrzanym diffie.** Wynik odnosi się do kodu i wskazanych testów, a nie do odbioru całego produktu ani uruchomionego wydania. Nie modyfikowałem backendu, konfiguracji, Main, baz danych ani usług.

Repozytorium: `/Users/arturtwardowski/DYNA Ecomerce/development/full-base`. HEAD w momencie przeglądu: `17b48adee0f3a7ac196acbe3135217aff5600b87`. Przejrzano również niezacommitowane zmiany; właściwą tożsamość ich treści określają SHA-256 poniżej.

## Sprawdzone granice

- `server/app.ts:368–377`: pozostają brandowane instancje lokalnych fixture/registry, wzajemna wyłączność dwóch konstruktorów, wymóg tożsamości własnego lokalnego transportu, odmowa connector access w trybie read-only i odmowa połączenia manualnych connector jobs z globalnym background workerem.
- `ordinary-connector-routing.ts`: wybór transportu następuje przed dispatch na podstawie dokładnego origin. Błąd DNS, odmowa metody ani błąd transportu nie uruchamiają fallback. Nieprawidłowy URL idzie do restrykcyjnego connectora i tam jest odrzucany; nie otrzymuje lokalnego fallback.
- `ordinary-provider-reads.ts`: połączenie dwóch prywatnych selekcji nie uchyla read-only. Konfiguracja jest klonowana; brandowany transport pozostaje niezależny od własnego transportu Woo. Rozważyłem overlap przy bezpośrednim wywołaniu `buildApp`, które nie ponawia `assertDisjointConnectorOrigins`: obecny `supplierRemoteFeedUrl` używany przez brandowaną politykę connectora dopuszcza HTTPS/443 i odrzuca localhost oraz porty 8443/8444, więc aktualne lokalne origins nie mogą zostać przejęte przez connector.
- `ordinary-connector-jobs.ts`: jedyna zmiana usuwa blanket refusal obecności lokalnego fixture. Nadal wymagany jest jawny tryb `sandbox_manual_once`, brak read-only, prawdziwy capability i wyłącznie providerzy sandbox inni niż Woo. Przeczytane istniejące ścieżki zachowują sesję administratora, aktualne IAM/MFA, właściciela job/plan/channel, trwałą intencję, oryginalny lease i zakaz ponowienia po niepotwierdzonym COMMIT. Nie zmieniono procesorów ani ich finalizacji.
- `ordinary-local-cli.ts:45–68`: sygnał lub błąd strumienia podczas odczytu prywatnej selekcji/factory jest zapamiętywany; po otrzymaniu runtime używany jest jeden promise zamknięcia. Sygnały pozostają obsługiwane podczas drain. Brak komunikatu LISTENING po zapamiętanym stop. Pierwotny błąd jest zachowany przy wtórnym błędzie zamknięcia. Auto-entry ma dodatkowe stałe handlery błędów stdout/stderr, aby zapis raportu porażki po EPIPE nie wywołał nieobsłużonego zdarzenia.
- `scoped-automation-worker.ts:7–30,39–67`: nowa obserwacja jest ograniczona do RAM i 128 istniejących slotów historii. Dopasowanie wymaga równocześnie tenant oraz rule. Odpowiedź nie zawiera identyfikatorów innej firmy, treści wyjątków, URL, sekretów ani payloadów. Kody błędów mają zamkniętą allowlistę. Wielokrotne pętle zwracają AMBIGUOUS_RUNTIME, zamiast wskazywać arbitralną instancję. Usunięcie readera następuje po zakończeniu rzeczywistego drain, także przy jego porażce.
- `local-automation-worker-control.ts:154–172`: przed obserwacją RAM nadal sprawdzane są sesyjna rola admin, aktualna rola w bazie oraz własność reguły w bieżącym tenant. Nowe pole nie dopisuje SQL i nie zmienia aktywacji, claim, retry ani lease. `paused` oznacza tylko konfigurację reguły; odpowiedź jawnie zastrzega, że nie jest potwierdzeniem drain. `last_cycle` jest ostatnią zachowaną wizytą RAM, a nie trwałą historią ani dowodem powodzenia operacji.

## Własna weryfikacja

Wykonano w DEV:

```sh
node --import tsx --test tests/ordinary-connector-coexist.test.ts tests/ordinary-local-cli.test.ts tests/ordinary-local-cli-lifecycle.test.ts tests/scoped-automation-diagnostics.test.ts
```

Wynik: **35 testów PASS, 0 FAIL, 0 skipped, exit 0**, czas całkowity 3224.71725 ms. Narzędzie wykonawcze: session 6383, końcowy output chunk `11132d`.

Testy obejmują odmowę zmieszanych capabilities/read-only, dokładny routing, brak fallback po błędzie, CLI parser i limit argv, wczesne/repeated SIGTERM, SIGINT, failure wyboru/factory/listen/close, EPIPE przed i po factory, drain once, tenant+rule scope, IAM przed telemetry, bounded RAM, multiple-loop ambiguity i rozdzielenie konfiguracji pauzy od zajętości workera.

Granica: testy lifecycle i diagnostyki uruchamiają rzeczywiste moduły z kontrolowanymi portami FS/process/transaction/processor/timer. Nie stanowią natywnego testu OS sygnałów, rzeczywistego COMMIT ACK-loss, izolacji PostgreSQL/RLS, calla sandbox dostawcy, wydanego bundle, UI Chrome ani recovery całego środowiska. Nie powielałem dużego builda ani typecheck wykonywanego przez koordynatora. Nie potwierdzam przy ich pomocy spełnienia pełnego Goala.

## Tożsamość przejrzanej treści

| Plik względem DEV | SHA-256 | Bajty |
| --- | --- | --- |
| `server/app.ts` | `8c5aa38831e06eb866b63bfd50039be092957fbd283d03087e29646150e602dd` | 98026 |
| `server/ordinary-connector-routing.ts` | `0866f8b7395827c56daa86fc7dbcd076d50dd89c49a7a1ec2763aac5aa428ce3` | 2098 |
| `server/ordinary-provider-reads.ts` | `951dbaab7d9f874b4dcf85ac97c41d3b2035bf1851b9195162c0a9e169ede053` | 4730 |
| `server/ordinary-connector-jobs.ts` | `76e5e74df24a68ecdbe9262861a9a79c43011c6a4fd0a865c951ed77da0f26da` | 13182 |
| `server/ordinary-local-cli.ts` | `426de467c102d788ee32f857646b833ae3fd998792e07b471dfead4b2abbc13e` | 8164 |
| `server/scoped-automation-worker.ts` | `577d66d70a646c42fe50f944fc73a5f612a866f3c0f1fe71e2c789589c51610d` | 5979 |
| `server/local-automation-worker-control.ts` | `6b35c7776f661e2a06bd769ad6ddad436f58099530c4b683b93441b02d476b2d` | 18331 |
| `tests/ordinary-connector-coexist.test.ts` | `9a6bdecac83b2439179933808b7487eccf0eb9dccbfb7dbfa5f9405325c35468` | 4111 |
| `tests/ordinary-local-cli.test.ts` | `749dadf4b2591e06e26ebbf3b99f236af62afe492d652b802a2491f895845152` | 6678 |
| `tests/ordinary-local-cli-lifecycle.test.ts` | `54c66af664f7a0da2553969ea3d1b3868fb04f939ba3b11b00d7f48d1ad0f372` | 12766 |
| `tests/scoped-automation-diagnostics.test.ts` | `83dd22ea1d8ced4f8c2c1011c442c8e307eb5d3bfd1fb3759b20072342b02dbd` | 12029 |
