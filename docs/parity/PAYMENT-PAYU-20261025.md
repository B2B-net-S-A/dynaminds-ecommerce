# PayU: klient płatności portalu bez podłączenia (25.10.2026)

Decyzja Artura z 25.10.2026: płatności z portalu klienta (COM-PORTAL-6 w [audycie etapu 4](STAGE4-NONINTEGRATION-GAP-20261025.md)) idą przez **PayU**. Zakres [scope v7](scope-inputs/v7/README.md) dopisuje dostawcę `payu` z 8 operacjami. Wszystkie mają status „planned”, a wymagany poziom dowodu to `account`.

Ta część nie wymaga migracji. Powstały czyste moduły i lokalny fake. Nie ma migracji, zmian w `server/db.ts`, tras w `server/app.ts` ani wpisu w `server/integrations.ts`. Kod nie wykonuje prawdziwych połączeń sieciowych, bo transport podaje wywołujący. **Wszystkie odpowiedzi dostawcy w testach są syntetyczne.** Fake i pliki `tests/fixtures/payu/*.json` przygotowano ręcznie według publicznej dokumentacji PayU REST API 2.1, a nie z nagrań. Każdy plik fixture ma klucz `_synthetic` z napisem „SYNTETYCZNE”.

Sandbox PayU (`secure.snd.payu.com`) jest publiczny. Do lokalnego odbioru wystarczy, że właściciel zarejestruje konto sandbox i przekaże `pos_id`, `client_secret` i drugi klucz (MD5) przez ustawienia kanału. Umowa nie jest potrzebna. Konto produkcyjne i wypłaty to osobny poziom `account`.

## Pliki

| Plik | Rola |
|---|---|
| `server/payment-payu-values.ts` | Endpointy i lista dozwolonych hostów, statusy, schematy wejścia (zod: zamówienie, zwrot), kontrola hosta `redirectUri`, kwoty w groszach, mapowanie błędów `payuProblem` na komunikaty po polsku |
| `server/payment-payu.ts` | Klasa `PayU(mode, settings, credentials, transport, options)`: token OAuth z cache, tworzenie, odczyt i anulowanie zamówienia, zwroty, ponawianie, idempotencja, uzgodnienie po utracie odpowiedzi |
| `server/payment-payu-notify.ts` | Parsowanie nagłówka `OpenPayu-Signature`, weryfikacja podpisu w stałym czasie (MD5 / SHA-256), parsowanie powiadomień o zamówieniu i zwrocie, czysta decyzja `decidePayuNotification` |
| `server/payment-payu-reconcile.ts` | `matchPayuSettlement`: dopasowanie wierszy rozliczenia do sesji płatności, ze słownikiem klasyfikacji `payment_import_rows` |
| `server/payment-payu-fake.ts` | Stanowy fake PayU (OAuth, zamówienia, wyszukiwanie po extOrderId, anulowanie, zwroty) z zegarem, wygasaniem tokenów, wstrzykiwaniem awarii i budową podpisanych powiadomień |
| `tests/payment-payu*.test.ts` | 25 testów: `payment-payu` 18, `payment-payu-notify` 6, `payment-payu-reconcile` 1 |
| `tests/fixtures/payu/` | 8 syntetycznych odpowiedzi JSON |

## Kontrakt

| Operacja (`integration.payu.*`) | Wywołanie PayU | Metoda klienta | Ponawianie | Testy |
|---|---|---|---|---|
| `connection` | `POST /pl/standard/user/oauth/authorize` (`grant_type=client_credentials`, form) | `accessToken()`, `test()` | tak | cache do `expires_in` minus 60 s, odświeżenie po wygaśnięciu, jedno żądanie przy równoległych wywołaniach, 401 `invalid_client`, token odrzucony przez API → nowy token i jedno powtórzenie |
| `order.create` | `POST /api/v2_1/orders` (odpowiedź 302 z JSON, `redirect: 'manual'`) | `createOrder(input)` → `{orderId, extOrderId, redirectUri, status, recovered, replayed}` | nie | sukces PLN/EUR, walidacja (suma produktów, waluta, HTTPS, extOrderId), replay tego samego klucza bez żądania, inne body = 409, utrata odpowiedzi, `ERROR_ORDER_NOT_UNIQUE`, rozbieżna kwota |
| `order.status` | `GET /api/v2_1/orders/{orderId}`, `GET /api/v2_1/orders/ext/{extOrderId}` | `order()`, `ordersByExtOrderId()` | tak | status, kwota, waluta, `PAYMENT_ID`, 404, ponowienia 429/5xx z Retry-After |
| `notification.receive` | POST od PayU na `notifyUrl` | `verifyPayuNotification(rawBody, headers, secondKey)`, `decidePayuNotification(session, n)` | — | MD5 i SHA-256, zły lub brakujący podpis, zmienione body, replay = `duplicate` (jeden wpływ), status po terminalnym i spóźniony status ignorowane, rozbieżna kwota lub waluta i obce ID odrzucone |
| `refund.create` | `POST /api/v2_1/orders/{orderId}/refunds` | `refund(orderId, {extRefundId, description, currency, amount?})` | nie | częściowy i pełny (reszta), ponad pobraną kwotę → 422 bez POST, zamówienie nieopłacone, inna waluta, odmowa PayU, replay po `extRefundId`, utrata odpowiedzi |
| `refund.status` | `GET /api/v2_1/orders/{orderId}/refunds[/{refundId}]` | `refunds()`, `refundStatus()` | tak | PENDING → FINALIZED |
| `payout.reconcile` | raport rozliczeń / import płatności (bez API) | `matchPayuSettlement(rows, sessions)` | — | ready, duplicate, unmatched, ambiguous, conflict, invalid; netto = brutto − prowizja |
| `order.cancel` | `DELETE /api/v2_1/orders/{orderId}` | `cancel(orderId)` | nie | anulowanie, drugie anulowanie = już anulowane, utrata odpowiedzi → odczyt statusu, opłacone → 409 „użyj zwrotu” |

### Bezpieczeństwo i niezawodność

- **Hosty.** Środowisko wybiera wyłącznie `mode`: `sandbox` → `https://secure.snd.payu.com`, `production` → `https://secure.payu.com`. Dowolnego adresu nie da się podać. Każdy URL żądania jest sprawdzany względem listy dozwolonych hostów: HTTPS, port 443, bez danych logowania. Przekierowania są odrzucane (`PAYU_REDIRECT`). Wyjątek to odpowiedź 302 na utworzenie zamówienia; w niej liczy się tylko `redirectUri` z body, a nie nagłówek `Location`. `redirectUri` musi być hostem `*.payu.com` zgodnym ze środowiskiem (sandbox `*.snd.payu.com`); inaczej wynik jest uzgadniany odczytem.
- **Sekrety.** `client_secret` i drugi klucz pochodzą z kanału, w kodzie nie ma stałych. Fake ma wyłącznie syntetyczne wartości `synthetic-…`. Tekst błędu od PayU nie trafia do komunikatu. Kod błędu jest oczyszczany (`PAYU_VALIDATION:ERROR_VALUE_INVALID`, a nieznany kod jako `unknown`).
- **Podpis.** Oczekiwana wartość to `md5(body + second_key)` albo `sha256(body + second_key)`. Liczy się ją na surowych bajtach body, przed parsowaniem JSON, i porównuje `timingSafeEqual` na skrótach równej długości. Nagłówek `OpenPayu-Signature` albo `X-OpenPayu-Signature`. Body ponad 256 KB jest odrzucane bez interpretacji.
- **Ponawianie.** Token i odczyty: 3 próby przy 429/500/502/503/504, timeoucie i błędzie sieci, Retry-After do 5 s, inaczej 250/500 ms. Mutacje (`createOrder`, `cancel`, `refund`) idą raz. Brak odpowiedzi, 5xx albo nieczytelny sukces daje `PAYU_UNCERTAIN` i uzgodnienie odczytem. 401 z API oznacza odrzucony token przed przetworzeniem, więc klient pobiera nowy token i ponawia żądanie jeden raz.
- **Idempotencja `order.create`.** Klucz to `extOrderId` (id sesji płatności i numer próby, `[A-Za-z0-9._:-]{1,100}`). Ten sam klucz z tym samym body zwraca zapisany wynik bez żądania, a inne body daje 409. Po utracie odpowiedzi albo `ERROR_ORDER_NOT_UNIQUE` klient czyta `GET /orders/ext/{extOrderId}`. Kwota i waluta muszą się zgadzać, a dokładnie jedno zamówienie oznacza `recovered:true`. Odczyt PayU nie zwraca linku płatności, więc po odzyskaniu `redirectUri` ma wartość `null`. Podłączenie anuluje wtedy tę próbę i tworzy nową z nowym `extOrderId`. Gdy odczyt nic nie znajduje (`PAYU_RECONCILE_ABSENT`), klucz zostaje zablokowany. Nowa próba wymaga nowego `extOrderId`, czyli jawnego kroku, a nie ponowienia. Odmowa 4xx przed utworzeniem zwalnia klucz.
- **Zwroty.** Klient najpierw czyta zamówienie (musi mieć status COMPLETED, waluta musi się zgadzać) i istniejące zwroty. Kwota zwrotu nie może przekroczyć kwoty pobranej pomniejszonej o zwroty inne niż CANCELED; przekroczenie daje `PAYU_REFUND_EXCEEDS` bez żądania. Brak `amount` oznacza zwrot reszty. `extRefundId` już widoczny u dostawcy oznacza replay, a ten sam klucz z inną kwotą daje 409.
- **Kody `Problem.code`.** `PAYU_AUTH`, `PAYU_FORBIDDEN`, `PAYU_RATE_LIMIT`, `PAYU_UNAVAILABLE`, `PAYU_NOT_FOUND`, `PAYU_VALIDATION`, `PAYU_BUSINESS`, `PAYU_DUPLICATE_EXT_ORDER`, `PAYU_REFUND_BALANCE`, `PAYU_REFUND_REJECTED`, `PAYU_REFUND_EXCEEDS`, `PAYU_UNCERTAIN`, `PAYU_TIMEOUT`, `PAYU_REDIRECT`, `PAYU_INVALID_RESPONSE`, `PAYU_RECONCILE_ABSENT`, `PAYU_RECONCILE_AMBIGUOUS`, `PAYU_AMOUNT_MISMATCH`, `PAYU_SIGNATURE`, `PAYU_FOREIGN_NOTIFICATION`, `PAYU_NOTIFICATION_*`, `PAYU_INPUT`.

## Co zostaje do podłączenia

> **27.10.2026: podłączone w migracji 242** ([PAYU242-20261027](PAYU242-20261027.md)): punkty 1 (tabele `payu242_*`,
> konfiguracja we własnej tabeli zamiast `channels`), 3 (portal „Zapłać”, strona powrotu), 4 (powiadomienia
> na `/callbacks/payu/:config/:token` z listą adresów PayU, tokenem ścieżki i podpisem), 8 (RODO: tabele 242 bez danych
> osobowych) i 9 (testy z Postgresem), a zwroty z punktu 6 jako zwrot administratora z karty zamówienia.
> Nadal otwarte: punkt 2 w części egress (`ordinary-connector-policy.ts`, potrzebny przy prawdziwym sandboxie),
> 5 (worker, tor S3), 6 (powiązanie z RMA), 7 (import raportu wypłat) oraz pytania do sandboxa niżej i pytanie 14
> (adresy IP nadawców powiadomień) z dokumentu 242.


Kolejność: migracja sesji, potem kanał, trasy i UI. Numer migracji trzeba zarezerwować w kolejce torów (od 234, wg audytu etapu 4; 233 to paragony).

1. **Migracja tabeli sesji płatności** (nowy plik, bez edycji istniejących):
   - `payment_sessions(id, tenant_id, order_id, channel_id, provider='payu', ext_order_id UNIQUE per tenant, attempt, provider_order_id, amount, currency, status, phase create_started|created|recovered|absent, redirect_uri, created_at, expires_at, completed_at, receipt_entry_id)`, z FK do `orders` i `payment_entries`;
   - `payment_session_notifications(tenant_id, session_id, provider_order_id, status, signature_algorithm, body_hash, received_at, outcome)` jako dziennik powiadomień (replay = ten sam `body_hash`/status);
   - zwroty: `payment_session_refunds(ext_refund_id UNIQUE, provider_refund_id, amount, status, return_id)` powiązane z `payment_entries.kind='refund'` (`server/023_payments.sql:8`);
   - import rozliczeń: `payment_import_namespaces.source_kind` dopuszcza dziś tylko `bank_statement`, `carrier_report` i `shared_settlement` (`server/077_payment_imports.sql:3`). Raport PayU wymaga nowej wartości (np. `provider_settlement`) albo profilu `shared_settlement`.
   Implementacja `PayuIdempotencyStore` na tej tabeli: `claim` jako INSERT/SELECT … FOR UPDATE po `ext_order_id`, `finish` jako `phase='created'`.
2. **Kanał i rejestr**: wpis `payu` w `server/integrations.ts` (settings `pos_id`, `client_id`, `environment`; credentials `client_secret`, `second_key`) i `case 'payu'` w `connector()` (`:1817`). Enum dostawców w `POST /api/integrations` (`server/app.ts:1797`). Egress przez `server/ordinary-connector-policy.ts`: tylko `secure.snd.payu.com` / `secure.payu.com`, stałe ścieżki z tabeli wyżej, `redirect: 'manual'` dla `POST /api/v2_1/orders`. `safeFetch` (`server/integrations.ts:572`) już przepuszcza `manual`.
3. **Portal „Zapłać”**: w `server/portal-routes.ts` (dziś `:127` pokazuje tylko saldo) dodać `POST /api/public/orders/:token/payments`. Trasa bierze kwotę z `paymentBalance().amount_due` po stronie serwera, a nie od kupującego, sprawdza ważność linku pod blokadą zamówienia (jak `:221`), wywołuje `createOrder` z `extOrderId = session.id + '-' + attempt` i `customerIp` z żądania i zwraca `redirectUri`. W `server/portal-view.ts:60` dodać przycisk „Zapłać” przy `amount_due > 0` i `payment_mode='prepaid'`, ze stanem „Płatność w toku” i „Opłacono”. CSP portalu (`form-action 'self'`) nie blokuje przejścia przez `location.assign(redirectUri)`. `continueUrl` wraca na stronę portalu, która tylko czyta stan i niczego nie księguje.
4. **Trasa powiadomień**: publiczny `POST /api/public/payu/notify/:channel` z surowym body (`addContentTypeParser('application/json', {parseAs: 'buffer'})`, wzór `server/sync-routes.ts:354`). Trasa wywołuje `verifyPayuNotification`, potem `decidePayuNotification` pod blokadą sesji. `apply` + `bookReceipt` = `recordFinancialPaymentInTx` (`server/payments.ts:365`, `kind='receipt'`, `method='payu'`, `reference=PAYMENT_ID`, `client_key='payu:'+orderId`) w tej samej transakcji. Odpowiedź 200 przychodzi dopiero po commicie, a dla `duplicate`/`ignored` także 200, żeby PayU przestał ponawiać. Zły podpis daje 401 bez zapisu. Limit zapytań i log bez body.
5. **Worker**: zadanie uzgadniające sesje w `create_started`/`recovered`/`absent` i sesje `PENDING` starsze niż N minut (odczyt `order()`, anulowanie odzyskanych bez linku). Gałąź w `server/worker.ts` należy do toru S3, więc dopisać ją po rebase.
6. **Zwroty z RMA**: `server/returns.ts` / rozliczenie zwrotu wywołuje `refund()` z `extRefundId = return_id`. FINALIZED (powiadomienie albo `refundStatus`) daje wpis `payment_entries.kind='refund'`.
7. **Uzgodnienie wypłat**: profil importu raportu rozliczeń PayU w `server/payment-imports.ts`, wiersze przez `matchPayuSettlement`, a `ready` przez istniejące `payment_import_allocations` (`server/124_payment_import_allocations.sql`). Prowizja: `payment_entries.fee` jest dozwolone dziś tylko dla `courier_remittance`/`reversal` (`server/023_payments.sql:17`), więc prowizja PayU wymaga decyzji: osobny rodzaj wpisu albo rozszerzenie CHECK w migracji.
8. **RODO**: sesja i dziennik powiadomień przechowują e-mail kupującego, IP i body powiadomienia. Zapisywać tylko `body_hash` i pola potrzebne do rozliczenia. IP i e-mail usuwać albo pseudonimizować po zamknięciu sesji i upływie terminu reklamacji, a dane księgowe przechowywać 5 lat (`server/rodo228.ts`: dopisać kategorię `payment_session` do eksportu i anonimizacji). Do rejestru czynności przetwarzania trzeba dopisać PayU jako odbiorcę danych.
9. **Testy po podłączeniu**: `tests/payment-payu*.test.ts` dopisać do listy w `scripts/test.ts`, bo testy są wyliczane jawnie. Nie potrzebują Postgresa. Testy tras (portal, notify, replay pod równoległością) z Postgresem.

## Pytania do sandboxa

Wszystko poniżej to założenie z publicznej dokumentacji, nie sprawdzony kontrakt.

1. Czy `POST /api/v2_1/orders` zawsze odpowiada 302 z JSON (czy także 201/200), i czy przy `ERROR_ORDER_NOT_UNIQUE` dla tego samego `extOrderId` PayU zwraca istniejący `orderId` albo `redirectUri`. Od tego zależy, czy po utracie odpowiedzi można odzyskać link bez nowej próby.
2. Czy unikalność `extOrderId` jest wymuszana w obrębie POS zawsze, czy tylko przy określonej konfiguracji punktu, i jak długo.
3. Host strony płatności w sandboxie (`merch-prod.snd.payu.com`?) i w produkcji (`secure.payu.com/pay/`). Od tego zależy `payuRedirectOk`.
4. `expires_in` tokenu (spodziewane ~43 199 s), czy token działa dla wielu POS, kod błędu przy wygasłym tokenie (401 `UNAUTHORIZED`?).
5. Nagłówek podpisu: `OpenPayu-Signature` czy `X-OpenPayu-Signature` w sandboxie, wartości `algorithm` (MD5, SHA-256, SHA1?), czy podpis obejmuje dokładne bajty body.
6. Kolejność i powtarzanie powiadomień: czy PayU ponawia do 200, w jakich odstępach, czy może przysłać PENDING po COMPLETED, czy wysyła powiadomienia dla zwrotów na ten sam `notifyUrl`.
7. `WAITING_FOR_CONFIRMATION`: czy POS ma autoodbiór. Jeśli nie, potrzebna jest operacja `PUT /api/v2_1/orders/{id}/status` (`COMPLETED`), której nie ma w scope v7.
8. Zwroty: maksymalna liczba zwrotów częściowych, kody `codeLiteral` (saldo, kwota, duplikat `extRefundId`), czy `GET /refunds` zwraca `extRefundId`, czas przejścia PENDING → FINALIZED w sandboxie.
9. `DELETE /api/v2_1/orders/{id}`: odpowiedź dla zamówienia PENDING i COMPLETED, czy anulowanie jest możliwe po wejściu kupującego na stronę płatności.
10. Waluty: czy POS sandbox obsługuje EUR bez osobnej konfiguracji, czy EUR wymaga innego POS.
11. Raport rozliczeń (wypłaty): format (CSV/XLSX/API), kolumny identyfikatora (`orderId`, `extOrderId`, `PAYMENT_ID`?), prowizja na wiersz czy zbiorczo, waluta wypłaty. `matchPayuSettlement` przyjmuje dziś `reference`, `amount`, `fee` i `currency`.
12. Limity zapytań (scope v7: `official_rate_limit` = source_missing) i czy 429 niesie `Retry-After`.
13. Wymagane pola `buyer` i `products` (np. `buyer.phone`, `language`), maksymalne długości `description` i `extOrderId`, minimalna i maksymalna kwota.

## Weryfikacja

```
cd "development/full-base"
npx tsc --noEmit -p .
npx tsx --test tests/payment-payu.test.ts tests/payment-payu-notify.test.ts tests/payment-payu-reconcile.test.ts
node --test tools/parity/scope-v6-wave1.test.mjs tools/parity/scope-v7-payu.test.mjs
```

Wynik 26.10.2026: tsc bez błędów; PayU 25 testów, 25 zaliczonych; scope v6 + v7 8 testów, 8 zaliczonych.
