# Base API poza CRM — inwentarz 23.10.2026

Przegląd plików (bez uruchamiania) 188 metod z przypiętego indeksu (204) poza CRM i Base Connect.
Na `connector.php` są wyłącznie 11 metod CRM (`base-wire-crm.ts:11`, `base-wire-crm-dictionaries.ts:12`).

| Rodzina | Metody | Na Base wire | Natywny odpowiednik | Brak natywnego |
| --- | ---: | ---: | ---: | ---: |
| Zamówienia (z fakturami, paragonami, pick-pack) | 51 | 0 | 29 | 22 |
| Zwroty | 21 | 0 | 11 | 10 |
| Przesyłki kurierskie | 16 | 0 | 14 | 2 |
| Katalog produktów (PIM + WMS) | 93 | 0 | 45 | 48 |
| Magazyny zewnętrzne | 7 | 0 | 6 | 1 |
| Razem | 188 | 0 | 105 | 83 |

„Natywny odpowiednik” to także odpowiednik częściowy (inny DTO, brak liczbowych ID, podgląd/wykonanie zamiast
jednego wywołania). Nie jest to odbiór zgodności.

Kolejność dostarczania (zależności procesu zamówienie → kompletacja → wysyłka → faktura):
`getInventoryWarehouses`, `getInventoryProductsData`, `updateInventoryProductsStock`, `getOrderStatusList`,
`addOrder` (paid=1), `getOrders` (stronicowanie po dacie; remis w tej samej sekundzie nieopisany), `addOrderPickList`,
`setOrderStatus`, `createPackage`, `addInvoice`; dalej `getLabel`, `getOrderSources`, `getJournalList`.

Wspólna infrastruktura z CRM do ponownego użycia: kodek (`base-wire-codec.ts`), trasa i limit 100/min
(`base-wire-crm-routes.ts:47-69`), uwierzytelnienie i świeży dowód uprawnień (`base-wire-crm-authority.ts`),
liczbowe ID jako tabele boczne z wyzwalaczem (`218_base_wire_crm.sql:3-44`), idempotencja przez `Idempotency-Key`.
Warunek wstępny: `connector.php` musi stać się rejestrem rodzin (metoda → zakres, zapis, obsługa) zamiast
listy metod CRM i zakresów `crm:*`.

Uwaga: `BASE-WIRE-GAPS-20261019.md` mówi, że kodek nie jest wpięty w aplikację — to nieaktualne od `976ba8f`.
