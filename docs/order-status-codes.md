# Kody statusów zamówienia a etykiety (05.11.2026)

Uwaga klienta: nowe zamówienie ma od razu wiedzieć z API kanału, czy jest opłacone; przelew bez wpłaty trafia do
„Nieopłacone”, a po zaksięgowaniu wpłaty zaczyna od pozycji 1 „Nowe”. Etap „Opłacone” zniknął.

Kody w bazie zostały, zmieniło się ich znaczenie i etykieta:

| Kod | Etykieta | Znaczenie |
|---|---|---|
| `new` | Nieopłacone | przedpłata, na którą jeszcze nie ma wpłaty |
| `paid` | Nowe | gotowe do realizacji: opłacone w kanale, za pobraniem albo z uwolnionym kredytem kupieckim B2B |
| `picking` … `completed`, `cancelled`, zwroty | bez zmian | |

Dlaczego nie nowy kod (`awaiting_payment`): tabela `orders` (jej ograniczenia i indeksy) jest odciskiem palca
zapieczętowanych modułów (150, 151, 158–160, 169, 173, 178–185). Sama zmiana `orders_status_check` albo indeksu
`orders_pick_candidates` daje `false` w 12 z 18 strażników i aplikacja nie startuje. Nowy kod wymagałby nowej
generacji strażników.

Przepływ:

- Import z kanału i ręczne tworzenie: za pobraniem → od razu `paid` (`createOrder`, `server/domain.ts`);
  opłacone w kanale → `new` + wpłata ze źródła → `paid` (`server/imports.ts`); przedpłata bez wpłaty → `new`.
- Wpłata domykająca saldo → `new → paid` (`advancePaid`, `server/payments.ts`); ręcznie „Oznacz jako opłacone”
  = `PATCH /api/orders/:id/status` z `paid` (deklaracja operatora, `confirmOutstanding`).
- Kredyt kupiecki B2B → `new → paid` przy obciążeniu linii (`chargeTradeCreditInTx`).
- `new → picking` jest odrzucane dla każdego zamówienia; kompletacja startuje tylko z `paid`.
- Migracja 264 (tylko dane) przenosi istniejące zamówienia za pobraniem i na kredyt z `new` do `paid`.

Na zewnątrz zachowana jest dawna semantyka pobrania: zamówienie za pobraniem w `paid` nie jest „opłacone” dla
kanału. Synchronizacja statusu do kanałów (WooCommerce, Allegro, PrestaShop) pomija je do kompletacji
(`server/order-status.ts`, `server/order-status-signals.ts`), a webhook wychodzący podaje dla niego `new`
(`server/outbound-webhooks.ts`). API deweloperskie i Base wire zwracają surowy kod; Base wire ma nowe nazwy
statusów (2147483001 „Nieopłacone”, 2147483002 „Nowe”).
