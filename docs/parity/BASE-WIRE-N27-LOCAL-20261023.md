# Base API — wydanie N27, odbiór lokalny wszystkich rodzin

Stan: odbiór lokalny PASS dla rodzin CRM, inventory/PIM, orders, fulfillment, invoices, journal, returns, WMS na
jednym wydaniu. Pełny Goal OPEN.

- Źródła `21228bb`; rewizja `1cdafcad1732785620299462b89c7caa58ef0a49101926e9b7f0d75e2bed7d1a`, schemat 221,
  kontrakt 121 plików / 39 krawędzi, 98 300 KB. Baza: kopia N24 `dynaminds_n27_20261023_01` (PG04), port 4110,
  start 74 s, restart 74 s.
- Dowody: `local-builds/full-base-preview-20261017/base-wire-n27-20261023-01/`
  (`api-acceptance-check.private.json` SHA `5c780778…`, `api-acceptance-after-restart.private.json` SHA `fe7c4dc2…`).

| Przebieg | Wynik |
| --- | --- |
| Proces przez UI + Base API (49 kroków) | 49/49 |
| Po restarcie | 4/4 |

Ponad zakres N26 (32 kroki): getInventories, getInventoryProductsList (po SKU), getInventoryProductsData,
updateInventoryProductsStock z replay, addInventoryProduct widoczny w katalogu UI, getInventoryPriceGroups,
dokument PZ przez Base (nagłówek, pozycje, zatwierdzenie dwa razy → stan +3 dokładnie raz), addOrderReturn na
wysłanym zamówieniu widoczny w UI zwrotów, setOrderPayment (suma → jedna wpłata) i historia, getJournalList z typami
1/7/9 dla zamówienia, getOrderPackages, getCouriersList.

Uwaga do testu: `getOrderPaymentsHistory` bez `show_full_history` zwraca tylko wpisy z zewnętrznym ID płatności —
zgodnie z kontraktem Base.

Otwarte: restore z dumpa (zgoda na poprawkę normalizatora ACL), konto Base, addOrderBySplit (natywny podział
odrzuca klucze API), metody bez natywnego odpowiednika (lista w dokumentach rodzin).
