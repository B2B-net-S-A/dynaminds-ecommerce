# Raport rozliczeń: płatności ↔ faktury ↔ korekty ↔ zwroty (2026-10-23)

Etap 3 (finanse). Raport tylko do odczytu, liczony z istniejących tabel. Bez nowej migracji.

## Gdzie
- API: `GET /api/settlement-report?from=RRRR-MM-DD&to=RRRR-MM-DD[&currency=PLN]` (JSON)
  oraz `GET /api/settlement-report/file?...` (CSV, UTF-8 z BOM, kwoty w groszach).
- UI: Dokumenty → panel „Rozliczenie płatności, faktur i korekt” (`web/settlement-report.tsx`).
- Kod: `server/settlement-report.ts` (arytmetyka, statusy, CSV, walidacja),
  `server/settlement-report-data.ts` (odczyt z bazy), `server/settlement-report-routes.ts`.

## Uprawnienia
To samo prawo co „Przelewy i pobrania” (import płatności): `paymentImportAdmin`, czyli rola
`admin` odczytana na nowo z `memberships` w bazie (nie tylko z sesji). Operator i viewer → 403.
Klucze API → 403 (raport nie jest operacją publicznego API). Odczyt w jednej migawce
`tenantReadTx` (REPEATABLE READ, READ ONLY, rola `dyna_app` z RLS) i z jawnym `tenant_id` w każdym zapytaniu.

## Co jest uzgadniane (dla każdego zamówienia, liczby całkowite w groszach, BigInt)
| Pole | Źródło |
|---|---|
| wartość zamówienia | `orders.total` (z dostawą) |
| zwroty uznane | `return_cases.refund_amount`, stany `refund_pending`/`closed` |
| anulowania uznane | `cancelled_credit_minor` z zakresu sprzedaży 204 (`commercialSaleScopeReadonlyInTx`) |
| należność | `total − (zwroty + anulowania)`, nie mniej niż 0; 0 dla zamówienia anulowanego |
| wpłaty | `payment_entries` `receipt` + `courier_collection` (pobranie), storna netto |
| zwroty pieniędzy | `payment_entries` `refund`, storna netto |
| pobrania do przekazania | pobrania − przekazania kuriera − prowizje |
| zafakturowano | `documents` kind `invoice`: `local_invoice` (`totals.gross_minor`), `b2b_invoice` (`fiscal_snapshot.totals.gross_minor`), demo/Fakturownia/symulacja (`data.total`) |
| korekty | `documents` kind `correction` (`b2b_correction` → `calculation.totals.delta.gross_minor`, demo/Fakturownia → `data.total` ujemne) oraz `local_consumer_credit_documents` (188) |

Strona płatności powtarza dokładnie saldo z karty zamówienia (`balance()` w
`order-merge-payments.ts`); test bazodanowy porównuje każdy wiersz z `paymentBalance`.

Różnice:
- różnica płatności = zapłacono netto − należność (ujemna: niedopłata, dodatnia: nadpłata),
- różnica dokumentów = (faktury + korekty) − należność,
- zwroty bez korekty = (zwroty + anulowania) + korekty (dodatnia: zwrot bez korekty, ujemna: korekta bez zwrotu).

## Statusy (pierwszy pasujący jest statusem głównym; wszystkie są w oznaczeniach)
`scalone`, `inna_waluta`, `niedoplata`, `nadplata`, `brak_faktury`, `korekta_bez_faktury`,
`korekta_bez_zwrotu`, `zwrot_bez_korekty`, `faktura_niezgodna`, `wiele_faktur`,
`dokument_nieczytelny`, w przeciwnym razie `zgodne`.

## Waluty
Kwoty płatności i dokumentów w walucie innej niż waluta zamówienia nie są dodawane do liczb
zamówienia; wiersz dostaje `inna_waluta` i listę `foreign`. Sumy są osobno dla każdej waluty;
obce kwoty trafiają do pól `foreign_*` sumy swojej waluty i nie mieszają się z należnościami.

## Scalone zamówienia
Zamówienie źródłowe (jest w `order_merge_claims` jako source) ma status `scalone` i nie wchodzi
do sum. Zamówienie docelowe liczy księgę razem ze źródłami (`orderMergePaymentSourceIdsInTx`),
tak jak saldo na karcie zamówienia.

## Ograniczenia
- Okres filtruje po dacie utworzenia zamówienia (czas polski). Płatności, dokumenty i zwroty
  liczone są wszystkie do chwili przeliczenia, bez stanu „na dzień”.
- Najwyżej 366 dni i 2000 zamówień na raport (powyżej: 422 z prośbą o zawężenie).
- Pro formy nie są fakturami i nie są liczone.
- Waluta korekty B2B jest odczytywana z `calculation.currency`; brak waluty lub kwoty →
  `dokument_nieczytelny` i dokument nie jest sumowany.
- Zwroty liczone są według przyjęcia (`refund_pending`/`closed`); zgłoszone, nieprzyjęte zwroty nie obniżają należności.
- Sprawdzenie uprawnień używa zwykłej transakcji zapisu (jak import płatności); w tej
  lokalnej kompilacji samo otwarcie `tenantTx` trwa ok. 9–12 s, więc raport ładuje się z tym opóźnieniem
  (te same czasy mają np. `/api/local-invoices/options`).

## Weryfikacja
- `tests/settlement-report.test.ts` — 22 testy arytmetyki, statusów, CSV, walidacji i odmów (403/400).
- `tests/settlement-report.database.test.ts` — na świeżym klonie PG04: trzy zasiane zamówienia
  z płatnością, fakturą, korektą i zwrotem co do grosza, każdy wiersz = `paymentBalance`,
  sumy = suma wierszy, CSV = JSON, odmowy viewer/operator/nieaktualna rola, izolacja firm.
