# Przegląd bezpieczeństwa etapu 4 — 27.10.2026

Gałąź `goal/full-base-20261017`, wyłącznie lokalnie. Wynik: 1 HIGH, 6 MEDIUM.
Sondy recenzenta: `…/c4509fbf…/scratchpad/sr4/` (`iso2.mjs`, `lock.mjs`, `ssrf.mjs`, `start.sh`).
Ten plik zawiera streszczenie ustaleń przekazane przy zleceniu poprawek, nie pełny tekst raportu.

## Ustalenia

### H1 (blokuje wyjście z etapu 4) — pauza schedulerów całej instalacji dla dowolnego admina
`server/worker-supervision-routes.ts` (pause/resume, ok. 102–115) sprawdzał tylko `adminSession(req)`,
czyli administratora własnej firmy, a działał na wspólnym runtime workera procesu
(`workerRuntime().pause(name)`, `server/worker-supervisor.ts:257`; odpowiedź mówiła
`affects: 'ALL_WORKSPACES_OF_THIS_INSTALLATION'`). Rejestracja jest otwarta
(`server/workspace-routes.ts:269`, `server/app.ts:921`), więc administrator dowolnej
samodzielnie założonej organizacji mógł wstrzymać `jobs.tick`, `orders.statuses` itd.
wszystkim firmom do restartu. `GET /api/operations/workers` pokazywał też błędy kroków
(`publicWorkerError`, w tym komunikaty `Problem`) z pracy innych firm.

### M1 — `local_fake` KSeF jako wyrocznia HTTP na loopback
`server/ksef229-model.ts:45-46`, `server/ksef229-client.ts:50-56`: admin dowolnej firmy mógł
ustawić `http://127.0.0.1:<port>/<ścieżka>` i badać porty tej maszyny przez
`POST /api/ksef229/configs/:nip/check`.

### M2 — polityka blokady konta
Decyzja właściciela już zapisana; bez zmian w tej rundzie.

### M3 — sekret powrotu PayU w logu
`server/payu242-routes.ts:68,:83`: `?s=<sekret>` trafiał do logu żądań (serializer w `server/app.ts:745-750`).

### M4 — historia komunikacji kupującego bez rejestru RODO
`server/customer-message-routes.ts`, `GET /api/orders/:id/communication?scope=customer`: rola viewer
czytała treści, adresy i telefony z innych zamówień kupującego, bez wiersza w rejestrze dostępu (228).

### M5 — ciasteczko sesji zawsze bez `Secure`
`server/workspace-routes.ts:50-57`: `secure: false` niezależnie od protokołu.

### M6 — brak FORCE RLS na `payu242_*` i `audit238_event_keys`
Wymaga migracji; poza tą rundą (otwarte punkty). 27.10: poprawione migracją 246 (SR4-M6, niżej).

## Poprawki

Każda poprawka zaczęła się od testu, który padał (red), potem kod, potem ten sam test przeszedł (green).
Testy bazodanowe na jednorazowych klonach `dynaminds_restore_36751abef3079f3f` →
`dynaminds_sf4_20261027_01..05` na PG04 (127.0.0.1:57084); klony usunięte po biegu.

| Ustalenie | Commit | Red | Green |
|---|---|---|---|
| H1 | `450a267` fix(workers) | `tests/security-stage4.database.test.ts` 1–3: pauza przez admina z rejestracji `200 !== 403`; `web/worker-supervision.test.mjs` czerwony | 4/4 testy H1 (w tym AUTO-08), UI 2/2, S3 `worker-supervision.database` 4/4 (klon 02), AUTO-08 `scoped-processor-control.database` 2/2 (klon 03) |
| M1 | `59f4320` fix(ksef229) | `ksefLocalFakeAllowed is not a function` | ksef229-model/client/routes + ksef-purchase-client 35/35 |
| M3 | `68a43bf` fix(payu242), re-pin `00fd099` | `tests/request-log.test.ts` (brak modułu) | 2/2; pin `server/app.ts` cb93d873 → 8387f4c3 |
| M4 | `c9fb501` fix(messages) | `no body of the other order for a viewer` | test M4 zielony; `messages-s5.database` 6/6 (klon 04) |
| M5 | `9f9bca7` fix(auth) | `set-cookie` bez `Secure` przy origin https | test M5 zielony |

### Decyzje
- **H1**: operator instalacji = administrator firmy wskazanej w `DYNA_WORKER_OPERATOR_TENANT`
  (UUID; domyślnie brak, czyli nikt). Wybrane zamiast reguły „dokładnie jedna firma w instalacji”,
  bo nie zależy od liczby firm (rejestracja drugiej firmy nie zmienia uprawnień) i jest jawnie
  włączana przez operatora. Pozostali administratorzy: 403 na pause/resume (nic nie trafia do
  audytu), `last_error` kroków = `null`, pola `installation_operator`, `scheduler_control`,
  `scheduler_control_rule` w odpowiedzi. Panel ukrywa kolumnę „Akcja” i wyjaśnia, kto może
  wstrzymać. Start/stop procesora reguł tej firmy (AUTO-08) bez zmian.
- **M1**: `local_fake` tylko gdy `ksefLocalFakeAllowed()`: `DYNA_KSEF_FAKE=local` albo izolowany
  tryb testów `DYNA_TEST=true`, nigdy przy `NODE_ENV=production`. Sprawdzane przy zapisie ustawień
  i przy każdym tworzeniu klienta (`ksefBaseUrl`), więc także dla zapisanych wcześniej ustawień.
  Ścieżka adresu bez `..`, `//` i `%` (na surowym tekście, zanim URL je rozwiąże).
- **M3**: reguła URL w `server/request-log.ts`; obcięte zapytanie dla `/payu/return/` (strona
  i `/status`), dodatkowo `[redacted]` w ścieżce `/callbacks/payu/:config/:token`.
- **M4** (odwracalna): viewer w widoku kupującego dostaje metadane innych zamówień bez
  `title`/`body`/`party` (`content_hidden: true`); admin/operator dostają treść, a każde takie
  żądanie zapisuje JEDEN wiersz rejestru 228 (`read`, `order_count`, `detail.order_ids`,
  kupujący jako hash e-maila), jak w `65b1738`. Kopia tylko do odczytu nie zapisuje rejestru
  (jak karta CRM). Widok własnego zamówienia bez zmian.
- **M5**: `Secure`, gdy żądanie przyszło po TLS do procesu albo `DYNA_PUBLIC_ORIGIN` zaczyna się
  od `https://` (np. za proxy kończącym TLS). `X-Forwarded-Proto` nie jest zaufany (brak
  `trustProxy`). Ta sama reguła w odświeżeniu sesji (`server/sync-routes.ts`, wcześniej
  ustawiało znów `secure:false`) i w ciasteczku sesji portalu B2B (`server/b2b.ts`).

### Sondy po poprawce (aplikacja `server/index.ts` z workerami, klon 05, bez `DYNA_WORKER_OPERATOR_TENANT`, bez `DYNA_TEST`)
- H1 (`scratchpad/sf4/h1.mjs`, rejestracja nowej organizacji): pause/resume `jobs.tick`
  i `orders.statuses` → 403 ×4; `GET` → `installation_operator false`, 0 widocznych błędów,
  żaden scheduler nie wstrzymany.
- M1 (`sr4/ssrf.mjs` + `sf4/ksefput.mjs`): `PUT` z `local_fake` na porty 1, 57084, 4194 → 422
  „Lokalny serwer KSeF jest wyłączony w tej instalacji (włącza go operator: DYNA_KSEF_FAKE=local)”;
  `check` → 404 (brak ustawień).
- M3: `/payu/return/…?s=SECRETRETURN123` i `/status?s=…` → w logu 0 wystąpień sekretu, URL bez zapytania
  (wcześniej w `sr4/app.log`: `"/payu/return/…?s=x"`).
- UI: panel „Nadzór workerów” dla administratora firmy z rejestracji — tabela schedulerów bez
  kolumny „Akcja” i bez przycisków, pod tabelą wyjaśnienie (zrzuty `scratchpad/sf4/shots/`).

### Pozostałe sprawdzenia
`npx tsc --noEmit -p .` czysto; run-bw 363/363; testy pinów i stubów (`full-base-scale-http-ports`,
`nbp227-issue-hooks`, `local-woo-managed-job-manual-guards`, `ebay-provider-quota`,
`offer-sync-command-routes`, `ksef229-ui`, `invoice230`, `crm-bootstrap`) 89/89.

## Otwarte punkty
- **M6** (SR4-M6, poprawione 27.10): migracja `246_b2b_trade_credit_directory` ustawia `FORCE ROW LEVEL SECURITY` na
  `payu242_configs`, `payu242_sessions`, `payu242_notifications`, `payu242_refunds`, `audit238_event_keys` oraz na
  `custom_event_defs` i `custom_event_calls` z 244 (ta sama klasa: ENABLE bez FORCE). Pula właściciela loguje się
  jako właściciel tabel z `rolsuper`/`rolbypassrls`, więc powiadomienie PayU, strona powrotu, klucz API w audycie i
  zdarzenia własne działają dalej (`tests/force-rls246.database.test.ts`). Właściciel bez BYPASSRLS straciłby te
  odczyty, ale tak samo już dziś odczyt `orders` po tokenie portalu; wymaganie nie jest nowe.
  Szczegóły: [B2B-CREDIT246](B2B-CREDIT246-20261027.md).
- **M2**: polityka blokady konta — decyzja właściciela zapisana, bez zmian.
- **H1**: operator instalacji musi ustawić `DYNA_WORKER_OPERATOR_TENANT`, inaczej nikt nie wstrzyma
  schedulera z panelu (bezpieczny domyślny stan; restart nadal zeruje pauzy).
- **M1**: ten sam bramkowany `ksefBaseUrl` chroni klienta zakupów 243 (`ksef-purchase-client.ts`);
  jego trasy nie były osobno sondowane w tej rundzie.
- **M5**: `DYNA_PUBLIC_ORIGIN=https://…` przy wejściu po zwykłym http sprawi, że przeglądarka nie
  odeśle ciasteczka — ustawiać tylko dla instalacji faktycznie za https.
