# Base API poza CRM — wydanie N26, odbiór lokalny

Stan: rodziny inventory (3 metody), orders (4), fulfillment (4), invoices (4) na `connector.php` — odbiór lokalny procesu
zamówienie → kompletacja → wysyłka → faktura PASS. Pełny Goal OPEN.

- Źródła `56ed038`; rewizja wydania `e8a0b3e2f59e9c3f0ff85b03deff5e8693b828521925aa9c0f364c97f9e6eafc`, schemat 220,
  kontrakt 118 plików / 38 krawędzi natywnych, 98 152 KB. Baza: kopia N24 jako `dynaminds_n26_20261023_01` (PG04),
  port 4109, start 71 s, restart 73 s.
- Dowody: `local-builds/full-base-preview-20261017/base-wire-n26-20261023-01/` (`api-acceptance-check.private.json`,
  `api-acceptance-after-restart.private.json`, `chrome-n26-dashboard-base-orders.jpg`).

| Przebieg | Wynik |
| --- | --- |
| Proces przez UI + Base API (32 kroki) | 32/32 |
| Po restarcie | 4/4 |
| Chrome: przegląd pokazuje zamówienia z Base API jako „Nadane” | PASS |

Proces: produkt z UI → `addOrder` (paid=1, linia po SKU, Idempotency-Key, replay bez drugiego zamówienia) → zamówienie
„Opłacone” w UI → `addOrderPickList` → skany fali w UI → „Spakowane” w UI → `createPackage` (kurier demo, replay bez
drugiej przesyłki) → „Nadane” → `getLabel` → seria FV z UI → `addInvoice` (numer z natywnego licznika serii) →
`getInvoices`/`getInvoiceFile` → rejestr FV w UI. Także: zamówienie z UI widoczne w `getOrders` z liczbowym ID,
`setOrderStatus` na zamówieniu z UI, izolacja drugiej firmy, klucz tylko do odczytu odrzucony przy zapisie.

Otwarte: `getOrderStatusList` pusty dla nowej firmy (brak natywnych statusów workflow); `getInventories` /
`getInventoryProductsList` w toku; `getJournalList` (migracja 221) w toku; restore z dumpa czeka na zgodę;
konto Base — brak.
