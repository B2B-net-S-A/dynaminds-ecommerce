# S5 — komunikacja i portal klienta, część bez migracji (26.10.2026)

Tor S5 z [STAGE4-NONINTEGRATION-GAP-20261025.md](STAGE4-NONINTEGRATION-GAP-20261025.md) (obszar 1).
Zakres tej części: wymagania S5 bez zmiany schematu. Pominięte świadomie:

| Wymaganie | Dlaczego pominięte |
|---|---|
| COM-003 | idzie z torem L7 integracji (CHECK-i w 063) |
| COM-PORTAL-6 | płatność z portalu czeka na migrację PayU |
| COM-PORTAL-3 | świadome ograniczenie (bez zmiany kraju i punktu odbioru), bez zmian |
| COM-PORTAL-4, COM-005, COM-008 | wymagają migracji |
| COM-PORTAL-2 | było gotowe, bez zmian |

## Co zrobiono

### COM-002 i COM-007 — tagi szablonów, `{{portal_link}}`, podgląd na żywo, powiadomienie

- Wspólna lista tagów email i SMS: `server/message-variables.ts`. Do dawnych
  `order_number, customer_name, total, currency, status, source` (SMS) i `tracking_number` (email)
  doszły: `portal_link`, `products`, `delivery_address`, `delivery_method`, `invoice_number`,
  a SMS dostał też `tracking_number`. Dodatkowe odczyty idą tylko dla tagów użytych w szablonie,
  więc stare szablony renderują się tak jak dotąd.
- `{{portal_link}}` = `http://127.0.0.1:4100/api/public/orders/<token>`. Adres jest stały i lokalny
  (jak link odzyskiwania hasła w `server/password-recovery.ts`), nigdy z nagłówków Host/Origin.
  Wyłączony albo wygasły link zatrzymuje wiadomość z czytelnym błędem („Link do strony zamówienia
  jest wyłączony lub wygasł…”), zamiast wysłać martwy link.
- `{{delivery_address}}` bierze adres po zmianie kupującego (`effectiveDeliveryInTx`), a dla punktu
  odbioru „Punkt odbioru <kod>”. `{{delivery_method}}` = przewoźnicy przesyłek albo „Punkt odbioru” /
  „Dostawa pod adres”, bo zamówienie nie ma kolumny sposobu dostawy (to ANALYTICS-002, z migracją).
  `{{invoice_number}}` bez faktury zatrzymuje wiadomość („Zamówienie nie ma jeszcze faktury”).
- Filtr HTML przepuszcza `http` wyłącznie dla dokładnego linku portalu; inne `http` (także
  `HTTP:`, ze spacją, z encją tabulatora, z doklejonym `@host`) tracą `href`.
- Zmiana tokenu (rotacja) między podglądem a zatwierdzeniem daje 409 przy kolejkowaniu — stary
  link nie wyjdzie do kupującego.
- Podgląd na żywo w edytorze szablonu email i SMS: `POST /api/email/templates/preview`,
  `POST /api/sms/templates/preview` (dane przykładowe albo jedno zamówienie firmy). Nic nie zapisuje
  ani nie kolejkuje. Prawo: jak przygotowanie wiadomości (bez roli viewer); obca firma → 404 (RLS).
  UI: `web/messages-template-preview.tsx` (odświeżanie 400 ms po zmianie, numer zamówienia opcjonalny,
  klikane tagi).
- Powiadomienie o odpowiedzi: w wątku „Wiadomości klientów” pod odpowiedzią jest panel
  „Powiadom kupującego emailem” (`web/portal-reply-notify.tsx`). Używa zwykłego podglądu partii email
  i zatwierdzenia (`/api/email/preview` → `/queue`), więc obowiązują te same prawa, zgoda na zewnętrzne
  SMTP i limity; podpowiada szablony z `{{portal_link}}`. Automatycznej wysyłki bez zatwierdzenia nie ma.

### COM-001 — oś komunikacji w karcie zamówienia

- `GET /api/orders/:id/communication?scope=order|customer&channel=email|sms|portal&cursor=…`
  (`server/order-communication.ts`, trasa w `server/customer-message-routes.ts`, bez zmian w `app.ts`).
  Łączy email wychodzący, SMS, wiadomości portalu (kupujący, odpowiedź, notatka) i email przychodzący
  przypisany z IMAP. Szkice i niepoprawne pozycje podglądu są pomijane. Strony po 30, kursor (czas, id).
- Notatki prywatne i odebrane emaile widzi tylko aktualny administrator/operator (ta sama rola co
  skrzynka). Klucz API wymaga `communications:read`. Zamówienie obcej firmy → 404.
- `scope=customer`: do 20 najnowszych zamówień z tym samym adresem email (bez rozróżniania wielkości
  liter). Zamówienie bez emaila → tylko to zamówienie.
- UI: panel „Historia komunikacji z kupującym” w karcie zamówienia (`web/messages-order-timeline.tsx`,
  jedna linia w `web/main.tsx`), filtry zakresu i kanału.

### COM-004 — wyniki partii (drobne)

- W podglądzie partii email i SMS: „Pobierz wyniki CSV” (odbiorca, temat/treść, wynik, błąd; BOM,
  średnik, ochrona przed formułami arkusza) i „Wybierz ponownie nieudane” — zaznacza zamówienia z
  wiadomościami niepoprawnymi albo zatrzymanymi przed próbą (`invalid`, `failed`). Wyników niepewnych
  (`uncertain`) nie ponawia, bo mogły dotrzeć. `web/messages-batch-results.tsx`.

### COM-006 — test ścieżki provider_live

- `tests/sms-provider-live.database.test.ts`: endpoint tylko dla administratora z MFA, zgoda na
  wysyłkę, zadanie `sms.send`, dokładnie jeden POST do SMSAPI (fałszywy transport) z `idx`,
  `check_idx=1`, `notify_url` i bez `test=1`, ponowne uruchomienie zadania bez drugiego POST,
  utracona odpowiedź → `uncertain` bez ponowienia, odmowa dostawcy → `failed`, callback tylko z
  adresu SMSAPI, z właściwym kontem, duplikat i spóźniony raport, status w `/api/sms/messages`
  i w partii. Etykieta statusu w UI (`web/sms-delivery.tsx`) — test w `tests/messages-s5.test.ts`.
  Kod produkcyjny SMS live bez zmian (callback należy do toru L2).

### COM-PORTAL-5 — faktura z portalu

- `GET /api/public/orders/:token/documents/:id/file` oddaje PDF przygotowany wcześniej przez
  pracownika: Fakturownia (cache `invoice_email_files` z 063) albo zweryfikowany eksport Odoo.
  Walidacja ta sama co dla załącznika email (`emailAttachment`): bieżący dokument, konto, hash pliku.
  Portal nigdy nie woła dostawcy. Brak przygotowanego pliku albo zmiana dokumentu/konta → 409
  „Plik tego dokumentu nie jest jeszcze udostępniony. Skontaktuj się ze sprzedawcą.” Pobranie trafia
  do audytu (`portal.document.download`, bez użytkownika). Nagłówki: `no-store`, `nosniff`,
  `attachment`, CSP `default-src 'none'`. Pierwotny link po łączeniu zamówień — 409 jak dla wydruku.
- `/data` zwraca `download: 'pdf'|'print'|null`; PDF dostawcy ma pierwszeństwo przed wydrukiem DEMO.
  Strona portalu pokazuje „Pobierz PDF”.

### COM-PORTAL-1 — link śledzenia (opcjonalny)

- Przesyłka `live` InPost ShipX i DPD Polska dostaje `tracking_url` do publicznej strony przewoźnika;
  sandbox i DEMO nie (`trackingUrl` w `server/portal-routes.ts`).

## Pliki

| Plik | Zmiana |
|---|---|
| `server/message-variables.ts` | nowy: tagi, wartości, stały adres portalu |
| `server/email.ts`, `server/email-routes.ts` | tagi, filtr linków, podgląd na żywo |
| `server/sms.ts`, `server/sms-routes.ts` | tagi, podgląd na żywo |
| `server/order-communication.ts` | nowy: oś komunikacji |
| `server/customer-message-routes.ts`, `server/customer-messages.ts` | trasa osi, eksport roli skrzynki |
| `server/portal-routes.ts`, `server/portal-view.ts` | PDF z portalu, link śledzenia |
| `web/messages-*.tsx`, `web/messages-variables.ts`, `web/messages.css`, `web/portal-reply-notify.tsx` | nowe komponenty |
| `web/email.tsx`, `web/sms.tsx`, `web/customer-messages.tsx`, `web/main.tsx` (2 linie) | podpięcie |
| `tests/messages-s5.test.ts` | nowy, bez bazy |
| `tests/messages-s5.database.test.ts`, `tests/sms-provider-live.database.test.ts` | nowe, z bazą |

## Weryfikacja

Wszystko lokalnie, 26.10.2026. Testy z bazą na świeżych klonach PG04 (`dynaminds_s5_20261026_NN`,
szablon `dynaminds_restore_36751abef3079f3f` + prawdziwe `migrate()` do `233_fiscal_receipts`),
z blokadą sieci (`tests/loopback-only-network.mjs`, dozwolony tylko port PG04). Klon niesie ok. 600
oczekujących zadań prawdziwych kanałów; testy z bazą parkują je przed startem, żeby `tick()` brał
tylko zadania testu (sprawdzone: na klonach 01–05 żadne skopiowane zadanie nie zostało przejęte).

| Sprawdzenie | Wynik |
|---|---|
| `tests/messages-s5.test.ts` (bez bazy) | 8/8 |
| `tests/messages-s5.database.test.ts`, klon `_09` | 6/6 (20,6 min) |
| `tests/sms-provider-live.database.test.ts`, klon `_10` | 3/3 (9,4 min) |
| `npx tsc --noEmit -p .` | 0 błędów (exit 0, po commitach S5) |
| `bash scratchpad/run-bw.sh` | 200/312; wszystkie 112 niepowodzeń to `*-resource-packaging` w trakcie przebudowy przez S1 (niezacommitowane `tools/build/*`, `shared/.../runtime-resources.mjs`, `migration-manifest.mjs`); testy base-wire zielone; S5 nie dotyka pakowania |
| Regresja istniejących zestawów S5 (`portal`, `email`, `sms`, `customer-messages`) | portal 14/17, email 20/20, sms 26/27 (limit 2 h), customer-messages 9/11; powtórzone 27.10 z biegiem A/B przed S5 — [COMMUNICATION-S5-20261027.md](COMMUNICATION-S5-20261027.md) |

Przeklikane w przeglądarce (API 4198 + Vite 5198, nie 4100/5173; proxy usuwa Origin; worker
wyłączony; serwery zatrzymane po sprawdzeniu). Zrzuty w
`/private/tmp/claude-501/-Users-arturtwardowski-DYNA-Ecomerce/8f6a5159-858a-456a-82c1-bf241b6c7765/scratchpad/s5-shots/`:

| Zrzut | Co widać |
|---|---|
| `01-portal-tracking-link.jpg` | portal: przesyłka live InPost z linkiem „Śledź przesyłkę u przewoźnika” |
| `02-portal-order-a-documents-contact.jpg` | portal: dokument DEMO, rozmowa kupującego |
| `03-portal-pdf-download.jpg` | portal: „Pobierz PDF” dla zweryfikowanego PDF Odoo (curl: 200, `application/pdf`, `attachment`, `no-store`, `nosniff`) |
| `04-email-template-live-preview.jpg` | edytor szablonu: klikane tagi, podgląd na żywo z danymi zamówienia i linkiem portalu |
| `05-reply-notify-panel.jpg` | wątek klienta: panel „Powiadom kupującego emailem” z podpowiedzianym szablonem z `{{portal_link}}` |
| `06-reply-notify-preview.jpg` | podgląd powiadomienia: odbiorca, link, produkty, adres, dostawa, faktura |
| `07-reply-notify-queued.jpg` | zatwierdzona symulacja lokalna („Email nie wyszedł poza aplikację”) |
| `08-order-communication-timeline.jpg` | karta zamówienia: oś email, notatka, odpowiedź, wiadomość kupującego, SMS |
| `09-timeline-buyer-scope.jpg` | ta sama oś dla wszystkich zamówień kupującego (2 zamówienia) |

Na PG04 pod obciążeniem innych torów każda transakcja aplikacji wykonuje funkcje strażnicze
(`pim_dictionary_valid()`, `nested172_valid()`) po 6–8 s; serwer UI do przeklikania uruchomiono
z harness­em podnoszącym `statement_timeout` puli do 60 s (`scratchpad/s5/ui-entry.mts`), bo przy 8 s
strona portalu kończyła się 500 „canceling statement due to statement timeout”. Kod aplikacji bez zmian.

## Ograniczenia i uwagi

- Link portalu w emailu wskazuje lokalny adres `127.0.0.1:4100`; działa na tym komputerze. Publiczny
  adres sklepu to decyzja wdrożeniowa poza zakresem „tylko lokalnie”.
- Oś komunikacji i istniejąca historia email/SMS filtrują po `order_id` bez indeksu
  `(tenant_id, order_id)` w `email_messages`/`sms_messages`; przy dużych firmach to skan po firmie.
  Indeks wymaga migracji — do toru migracji S5.
- PG04 jest współdzielony przez ok. 10 torów (load average > 20). Testy z bazą tego toru podnoszą
  `statement_timeout` tylko dla własnych połączeń do 60 s (jak `tests/developer.test.ts`), bo
  odczyt katalogu w `preflightPim` przekraczał 8 s. Domyślne ustawienie aplikacji bez zmian.
