# S5 — komunikacja i portal klienta: sprawdzenie i poprawki (27.10.2026)

Ciąg dalszy toru S5 z [STAGE4-NONINTEGRATION-GAP-20261025.md](STAGE4-NONINTEGRATION-GAP-20261025.md).
Wymagania bez migracji zrobiono 26.10 ([PORTAL-COMM-S5-20261026.md](PORTAL-COMM-S5-20261026.md),
commity `a75087a`, `275a280`, `84c559c`, `ceaa7f1`). 27.10 nie zaczynano ich od nowa: sprawdzono je
na aktualnym HEAD, pokazano czerwony→zielony, dokończono regresję, która 26.10 została „w toku”,
i poprawiono dwie rzeczy znalezione po drodze.

Poza zakresem (bez zmian): COM-PORTAL-4, COM-005, COM-008 (migracje, serializuje je koordynator),
COM-003 (z torem L7 integracji), COM-PORTAL-3 (świadome ograniczenie, `tests/buyer-address.test.ts:340`),
COM-PORTAL-6 (bramka płatności).

## Stan wymagań

| Wymaganie | Stan | Commit | Dowód 27.10 |
|---|---|---|---|
| COM-002 + COM-007 (tagi, `{{portal_link}}`, podgląd na żywo, powiadomienie) | zrobione | `a75087a`, `275a280` | sonda czerwona na drzewie sprzed S5, zielona na HEAD; `messages-s5.database` 1–2 zielone; zrzuty 04, 05, 08 |
| COM-001 (oś komunikacji w karcie zamówienia) | zrobione | `275a280` | sonda (trasa) czerwona→zielona; `messages-s5.database` 3 zielony; zrzuty 02, 03 |
| COM-006 (test provider_live) | zrobione | `ceaa7f1`, `990adec`, `d6c5283` | mutant bez `check_idx` czerwony, HEAD 3/3; strażnik nazwy klonu poprawiony; etykieta statusu bez node:crypto |
| COM-PORTAL-5 (faktura z portalu) | zrobione | `84c559c` | sonda (trasa) czerwona→zielona; `messages-s5.database` 4–5 zielone; zrzut 07, curl 409 po zmianie konta |
| COM-PORTAL-1 (link śledzenia, poza listą S5, przy okazji) | zrobione | `84c559c` | `messages-s5.database` 6 zielony; zrzut 06 (DPD live → tracktrace.dpd.com.pl) |

## Co poprawiono 27.10

### Strażnik nazwy klonu w testach S5 z bazą (`990adec`)

`tests/messages-s5.database.test.ts:30` i `tests/sms-provider-live.database.test.ts:20` przyjmowały
tylko `dynaminds_s5_20261026_NN`. Każdy późniejszy bieg na świeżym klonie kończył się po 1–2 s
asercją nazwy, zanim ruszył pierwszy test (log: `The input did not match … /^\/dynaminds_s5_20261026_[0-9]{2}$/`).
Teraz `dynaminds_s5_2026MMDD_NN` na 127.0.0.1; inne bazy nadal odrzucane.

### Pusty klient Vite przez etykietę statusu SMS (`d6c5283`)

`web/sms-delivery.tsx` importował `SMSAPI_STATUS_NAMES` z `server/sms-delivery.ts`, który od
`5be263d` (token callbacku SMSAPI, tor L2) importuje `node:crypto`. W przeglądarce cała aplikacja
była biała: `Module "node:crypto" has been externalized for browser compatibility` (zrzut 00).
Kody statusów przeniesiono do `server/sms-delivery-status.ts` (bez importów Node);
`server/sms-delivery.ts` je reeksportuje, więc serwer i testy L2 się nie zmieniają.
Nowy test w `tests/messages-s5.test.ts` przegląda importy wartości `web/* → ../server/*`
i odrzuca moduł serwera z importem `node:*`, `pg`, `fs`, `path`, `crypto` (importy `type` są
dozwolone, bo znikają przy kompilacji). Czerwony przed poprawką
(`sms-delivery.tsx → server/sms-delivery`), zielony po niej. Pozostałe moduły serwera używane przez
web importują `pg` tylko jako typ.

## Czerwony → zielony

| Co | Czerwony | Zielony |
|---|---|---|
| `tests/messages-s5.test.ts` na drzewie sprzed S5 (`a75087a^`) | plik nie ładuje się: `Cannot find module server/message-variables` | HEAD: 8/8 (dwa razy), po `d6c5283` 9/9 (dwa razy, razem z `sms-live-contract` 17/17) |
| sonda `zz-s5-probe.test.ts` (tylko API sprzed S5), klon `_07` | `a75087a^`: 0/4 — „Nieznana zmienna: portal_link”, „Nieznana zmienna szablonu: tracking_number”, filtr usuwa `href` linku portalu, brak trasy `/api/orders/:id/communication` | HEAD: 4/4 |
| `tests/sms-provider-live.database.test.ts`, mutant bez `check_idx:'1'` w `server/sms-live-transport.ts`, klon `_08` | 2/3, test 2: `expected '1'`, `actual null` | HEAD, klon `_02`: 3/3 (419 s) |
| przeglądarka bez `d6c5283` | biała strona, błąd `node:crypto` w konsoli | aplikacja się ładuje (zrzut 01) |
| test importów web → server | `['sms-delivery.tsx → server/sms-delivery']` | `[]` |

Sonda nie jest częścią repo (leży w katalogu sesji); używa tylko funkcji, które istniały przed S5,
żeby czerwony nie był samym brakiem modułu.

## Testy z bazą (PG04, klony `dynaminds_s5_20261027_NN`)

Każdy bieg: świeży klon `dynaminds_restore_36751abef3079f3f`, prawdziwe `migrate()` z czystego
worktree HEAD (`8ad4309` + pliki S5 z commitów powyżej, bez cudzych niezacommitowanych zmian),
blokada sieci `tests/loopback-only-network.mjs` (dozwolony tylko port PG04, dla email też 1025),
`--test-concurrency=1`, bez podnoszenia `statement_timeout` aplikacji.

| Zestaw | Klon | Wynik | Czas |
|---|---|---|---|
| `tests/messages-s5.database.test.ts` | `_01` | 6/6 | 748 s |
| `tests/sms-provider-live.database.test.ts` | `_02` | 3/3 | 419 s |
| `tests/portal.test.ts` (regresja) | `_03` | 14/17 — nie przechodzą 8, 12, 17 (te same co 26.10) | 3821 s |
| `tests/email.test.ts` (regresja) | `_04` | 20/20 | 4711 s |
| `tests/customer-messages.test.ts` (regresja) | `_05` | 9/11 — nie przechodzą 8, 10 (te same co 26.10) | 3141 s |
| `tests/sms.test.ts` (regresja) | `_06` | 26/27, ostatni („pełna partia250”) przerwany limitem 3 h pliku przy 237/250 wiadomościach `simulated`, bez błędu | 10800 s |
| A/B: portal 8, 12, 17 przed S5 (`a75087a^`) i na HEAD, równolegle | `_09`, `_10` | przed S5 0/3, HEAD 0/3 — te same błędy | 742 s, 750 s |
| A/B: customer-messages 8, 10 przed S5 i na HEAD, równolegle | `_11`, `_12` | przed S5 0/2, HEAD 0/2 — te same błędy | 901 s, 905 s |

Nieprzechodzące testy regresji to asercje czasowe pod obciążeniem PG04 (load average 10–12,
6–20 s na transakcję z funkcjami strażniczymi), nie zmiana zachowania S5. Dowód: w biegu A/B te
same testy z drzewa sprzed S5 padają identycznie na klonie obok, w tym samym czasie.

- portal 8, customer-messages 8: test czeka na zapytanie `FOR UPDATE` w `pg_stat_activity`
  przez 100 × 10 ms; żądanie dochodzi do blokady później („did not reach the observed order lock”).
- portal 12, customer-messages 10: limit 20 żądań na minutę (`server/portal-routes.ts:260`,
  `server/customer-message-routes.ts:199`); 20 żądań trwa dłużej niż minuta, okno się przesuwa
  i 21. przechodzi zamiast 429.
- portal 17: pomiar `deepMs < 2000` i `canceling statement due to statement timeout` (8 s domyślnie).
- sms „pełna partia250”: samo utworzenie 250 zamówień zajęło ok. 55 min (ok. 4,5 zamówienia/min),
  potem worker przetwarzał ok. 3 wiadomości/min; przy limicie 3 h zostało 13 wiadomości w kolejce.
  Szablon testu używa tylko starych tagów, więc nowe odczyty S5 się nie włączają
  (`usedVariables` w `server/message-variables.ts`). Biegu A/B dla tego testu nie robiono (3 h na stronę).

26.10 te same zestawy dały: portal 14/17 (8, 12, 17), email 20/20, customer-messages 9/11 (8, 10),
sms 26/27 (cały plik przekroczył 2 h). Wynik jest więc ten sam przy innym obciążeniu.

## Bez bazy

| Sprawdzenie | Wynik |
|---|---|
| `tests/messages-s5.test.ts` + `tests/sms-live-contract.test.ts`, dwa razy | 17/17, 17/17 |
| `npx tsc --noEmit -p .` | exit 0, 0 błędów (przed i po `d6c5283`) |
| `run-bw.sh` (base-wire + pakowanie zasobów) | 328/328 przed `d6c5283`, 333/333 po nim (liczba wzrosła o testy innych torów; drzewo robocze z ich niezacommitowanymi zmianami) |

## Przeklikane w przeglądarce (27.10)

API 4197 (worker wyłączony, blokada sieci) + Vite 5197 na worktree HEAD, klon `_01` z danymi testu
`messages-s5.database`. Sesja testowa wpisana w klon. Aplikację otwierano pod `s5com.localhost:5197`,
bo panel przeglądarki dzielą inne tory, a ciasteczka `127.0.0.1` nie rozróżniają portów (inny tor
na `127.0.0.1:5237` nadpisał sesję). Zrzuty w
`/private/tmp/claude-501/-Users-arturtwardowski-DYNA-Ecomerce/c4509fbf-d64d-4ac0-9f43-0a17b377d972/scratchpad/s5-com/shots/`:

| Zrzut | Co widać |
|---|---|
| `00-before-fix-blank-app.jpg` | biała strona przed `d6c5283` |
| `01-after-fix-app-loads.jpg` | panel ładuje się po poprawce |
| `02-order-communication-timeline.jpg` | karta zamówienia: notatka, odpowiedź i wiadomość portalu, SMS i email z linkiem portalu, produktami, adresem, dostawą i fakturą |
| `03-timeline-buyer-scope.jpg` | zakres „Wszystkie zamówienia kupującego”: 2 zamówienia, numer przy każdej pozycji |
| `04-email-template-live-preview-sample.jpg` | edytor szablonu: klikane tagi, podgląd na danych przykładowych |
| `05-email-template-live-preview-order.jpg` | ten sam podgląd na zamówieniu `DE-20261026-C25B0390`: link portalu, numer przesyłki, produkty; „Nic nie jest zapisywane ani wysyłane” |
| `06-portal-live-dpd-tracking-link.jpg` | portal: przesyłka DPD live z linkiem „Śledź przesyłkę u przewoźnika” |
| `07-portal-pdf-download-button.jpg` | portal: „Pobierz PDF” dla dokumentu z zweryfikowanym eksportem Odoo |
| `08-reply-notify-panel-no-templates.jpg` | wątek klienta: panel „Powiadom kupującego emailem”, stan „Brak aktywnych szablonów email” |

Pełne przejście powiadomienia (podgląd → zatwierdzenie → symulacja) jest w zrzutach 05–07 z 26.10
i w `messages-s5.database` test 1 (podgląd → kolejka → worker).

## Decyzje (odwracalne, najbliżej Base)

- Kody statusów SMSAPI w osobnym module zamiast kopii w `web/`: jedna lista, serwer bez zmian w API.
- Strażnik nazwy klonu przyjmuje każdą datę `2026MMDD`, nie listę dat: klon S5 jest i tak jednorazowy.
- Regresję istniejących zestawów uruchomiono bez podnoszenia `statement_timeout` aplikacji
  (26.10 podnoszono go do 60 s), żeby wynik odpowiadał domyślnej konfiguracji.

## Zamknięte po sprawdzeniu (27.10, tor S5-fix)

Trzy pozycje z „Otwarte” poprawione bez migracji; każda najpierw testem, który pada.

| Pozycja | Commit | Czerwony → zielony |
|---|---|---|
| Historia SMS pusta przy odpowiedzi API wolniejszej niż 5 s (`web/sms.tsx`) | `49a2921` | `tests/sms-history-poll.test.ts` (jsdom, ręczny takt 5 s): 0/2 → 2/2. Takt nie startuje nowego zapytania, gdy poprzednie trwa; odpowiedź pokazywana tylko dla otwartej strony i nowsza od pokazanej (spóźniona odpowiedź porzuconej strony nadal odrzucana) |
| Surowy status przesyłki w portalu (`created`) | `11c03dc` | `tests/messages-s5.test.ts`: 9/10 → 10/10. Jedna mapa etykiet `server/shipment-status-labels.ts` (dawny `trackingName` z `web/tracking.tsx`, dopisane `created: 'Utworzona'`) dla panelu i portalu, także dla przesyłek zamiennika |
| „Pobierz PDF” w `/data` mimo pliku, którego pobranie zwraca 409 | `855a402` | `tests/messages-s5.database.test.ts` na PG04: klon `dynaminds_s5fix_20261027_01` (stary kod) 4/6, padają dokładnie nowe asercje `/data`; klon `_02` (poprawka) 6/6. `/data` używa tej samej walidacji co pobranie (`checkedPdf()`: dokument, konto, skrót pliku); po zmianie konta Odoo zostaje wydruk DEMO albo „pobranie u sprzedawcy” |

Przeklikane na klonie `_02` (API 4297, Vite 5297 z opóźnieniem 12 s na `/api/sms/messages`, adres
`s5fix.localhost:5297`); zrzuty w
`/private/tmp/claude-501/-Users-arturtwardowski-DYNA-Ecomerce/c4509fbf-d64d-4ac0-9f43-0a17b377d972/scratchpad/s5fix/shots/`:
`01`/`02` — historia SMS pusta w trakcie zapytania, po 12 s (ponad dwa takty) wiersz widoczny, do API
dotarły 2 zapytania w 20 s zamiast jednego co 5 s; `03` — „DPD Polska · … · Utworzona”; `04` — „Pobierz PDF”
przy ważnym eksporcie Odoo; `05` — po zmianie danych konta pobranie zwraca 409, a portal pokazuje wydruk DEMO.

## Otwarte

- Bez indeksu `(tenant_id, order_id)` w `email_messages`/`sms_messages` (z 26.10, wymaga migracji).
