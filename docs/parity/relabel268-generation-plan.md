# Relabel268: nowa etykieta po „Anuluj etykietę” — plan generacji strażników (11.11.2026)

Uwagi v3, katalog automatyzacji wiersz 19. Wydanie demo idzie z czytelną odmową (commit 4118b2d). Ten dokument
ustala, ile kosztuje zrobienie tego w bazie przez nową generację strażników, zanim powstanie migracja 268.

## Co musi się zmienić w SQL

| funkcja | gdzie | zmiana | wpływ na pieczęcie (świeże `migrate()`, 257 migracji, do 267) |
|---|---|---|---|
| `order_shipments_guard()` (trigger na `shipments`) | ostatnio `server/234_carriers.sql` | anulowana etykieta nie jest „inną paczką”; anulowanej nie można wydać | brak: 18/18 nazwanych, demo 16/16, 119/138 boolowskich |
| `order_parcel_frame_physical_v1(...)` | linia 134/137 | plan paczek nie wymaga ani nie przyjmuje anulowanej etykiety | brak |
| `order_shipments_dispatch_guard()` (trigger na `orders`) | `server/134_order_parcels.sql:449`, opakowana w `server/137_order_parcel_releases.sql:262-269` | `count(*) ... >1` liczy tylko `status<>'canceled'` | **9/18 nazwanych, demo 6/16, 89/138** |

Bez trzeciej zmiany zamówienie z anulowaną i nową etykietą nie przejdzie na `shipped`
(„Wydanie wielu paczek wymaga jawnego przydziału pozycji”). Pierwsza gałąź tego strażnika (plan paczek) omija
liczenie, ale plan wymaga 2..50 paczek, rezerwacji z lokacjami i źródeł DEMO bez kanału (`server/134_order_parcels.sql:229,237`),
więc nie obsłuży InPost/DPD/DHL/PP — ta droga została odrzucona w lane Q.

## Dlaczego zmiana na `orders` łamie strażniki

`fa3_draft_fingerprint()` (`server/158_fa3_draft_native.sql:265`), `b2b_invoice_fingerprint()` i `b2b_credit_fingerprint()`
hashują `pg_get_functiondef` każdej funkcji wyzwalacza na `orders`. Zmienione wartości (seal-diff, 42 funkcje odcisków):
tylko te trzy. Od 162 żadna migracja nie zmieniła wyzwalacza na `orders` — 209 też nie — więc nie ma wzorca dla
dokładnie tej zmiany.

Śledzenie (`trace.py`: każdy `RETURN` instrumentowany, wariant v2 w wycofanej transakcji) pokazuje, gdzie pada:

- `fa3_draft_guards` → `b2b_invoice_upgrade_valid` → `b2b_credit_upgrade_valid` → `credit_source_upgrade_valid` →
  `financial_return_upgrade_valid` (L164–169): `cert.successors = buyer_address_predecessors()->'fingerprints'`
  (żywe odciski 157–165 kontra certyfikat 162 zapisany przy migracji 162);
- `buyer_address_guards` (L212): `seal.predecessor_certificates = predecessors214` (te same żywe odciski);
- `manual_inventory_off_valid` (L175): `credit_fp267` kontra `cert->>'original160_fingerprint'`;
- `wave_print177_valid` (L215), `ordinary187_valid`, `large_import173_valid` → przez powyższe;
- `packed_label_print_guards`, `operative_delivery_valid`, `cooperation171_valid`, `nested172_valid`,
  `pim_dictionary_valid`, `warehouse_wz_issuer_guards`, `catalog_stock_control_guards`, `return_credit206_guards`
  → przez `wave_print177_valid` / `manual_inventory_off_valid` / `financial_return_upgrade_valid`.

## Minimalny zestaw nowej generacji

Funkcje, które wołają `fa3_draft_fingerprint()`, `b2b_invoice_fingerprint()`, `b2b_credit_fingerprint()` albo
`buyer_address_predecessors()`: **54**, razem **17,9 MB** treści, 13 z nich ponad 0,5 MB
(`ordinary177..187_valid`, `ordinary180_manual_basis`, `manual_inventory_off_valid`/`_projection_valid`,
`partial_sale204_predecessor_definition` 2,0 MB, `wave_print177_history_map` 0,8 MB). Lista: `roots.txt` w notatkach sesji.

Każda z nich jest z kolei przypięta dosłownie (hex treści, sha256 projekcji przez
`order_merge_delivery209_predecessor_source_sha`, np. `'789ecc…'` dla `wave_print177_valid` w czterech strażnikach,
`entry219` w `financial_return_upgrade_valid`). Nowa generacja musi więc, jak 209:

1. dodać certyfikat 268 (predecessor = obecne odciski 158/159/160, successor = po zmianie, dokładny tekst starej
   i nowej treści `order_shipments_dispatch_guard`);
2. przepiąć koniec łańcucha (`financial_return_upgrade_valid`), `buyer_address_guards`, `manual_inventory_off_valid`
   i ich przypięte kopie na projekcję „268 → 267” (podmiana dokładnej treści 268 na treść 137 przed hashem), bez
   ruszania starych certyfikatów;
3. objąć projekcją każde miejsce, które przypina treść funkcji zmienionych w kroku 2 (kaskada jak w 209: ~60 strażników,
   generator `tools/parity/order-merge-delivery209-*.mjs` ~300 KB, SQL 28 MB);
4. przejść tę samą aktywację co 209 (`docs/parity/order-merge-delivery209-activation-plan.md`): zimna inspekcja
   (`packing189-cold-inspection`), normalizator ACL (`server/ordinary-legacy-schema.mjs`), mapa 28 poprzedników 173,
   zasób ponad 16 MiB, pełny start wydania.

Technika „quine” z 257 (odcisk, który podmienia sam siebie) odpada — fałszowałaby pieczęć.

## Szacunek

| wariant | koszt | ryzyko |
|---|---|---|
| A. Nowa generacja (powyżej) | 2–3 tygodnie pracy sesji (209: ~30 iteracji źródła, generator 300 KB); kilka dni to za mało | wysokie: każda pomyłka = aplikacja nie startuje; dotyka 13 funkcji po 0,5–2 MB |
| B. Ponowne użycie wiersza anulowanej przesyłki (nowa etykieta nadpisuje ten sam `shipments.id`, dane anulowanej idą do nowej tabeli 268) | 3–5 dni; tylko `order_shipments_guard` + nowa tabela, bez zmian na `orders` | średnie, nieocenione do końca: pamięć etykiet (`shipment_label_cache_assets`, `print_label_assets` po `shipment_id`), plany przewoźników i fulfillment marketplace’ów wiążą się z `shipment_id`; trzeba dowieść, że stara etykieta nigdy nie wróci do druku |
| C. Zostaje odmowa (stan 4118b2d) | 0 | brak; klient dalej nie zrobi drugiej etykiety w tym samym zamówieniu |

## Decyzja (Artur, 11.11.2026): wariant B

Sonda B, potem B. Wykonanie: `server/268_cancelled_label_relabel.sql`.

- Nowa etykieta przejmuje wiersz anulowanej (`shipments.id` bez zmian, nowa tożsamość: przewoźnik, numer, tryb,
  kanał, `external_id`, pobranie; śledzenie od zera). Na `orders` nic się nie zmienia, więc
  `order_shipments_dispatch_guard` dalej liczy jeden wiersz i zamówienie przechodzi na `shipped`.
- `order_shipments_guard()` (technika 108, cztery miejsca w treści 234): gałąź „relabel” tylko dla wiersza
  `canceled`, nigdy niewydanego, z nowym numerem, w tym samym zamówieniu, bez wydania w tym samym kroku; stara
  tożsamość trafia do `shipment268_replaced_labels` (RLS, `dyna_app` tylko czyta swojego najemcę, wiersze
  niezmienne); nowa etykieta przechodzi te same sprawdzenia co wstawiona (plan przewoźnika, status zamówienia);
  anulowanej etykiety nie da się wydać żadną drogą (także plan paczek); „odżywienie” anulowanej bez nowego
  numeru jest odrzucane; numer (i identyfikator u dostawcy) zastąpionej etykiety nie wraca już do obiegu — ani na
  tym samym wierszu po kolejnym anulowaniu, ani w innym zamówieniu (po przejęciu wiersza znika z
  `shipments_tracking_identity`, więc strażnik sprawdza archiwum; luka znaleziona w przeglądzie kodu 11.11.2026).
- Druk i pamięć etykiet porównują pełną ramkę źródła z numerem (`label_cache_selected_frame`, `label_print_queue`),
  więc podglądy i zasoby starej etykiety wygasają po przejęciu wiersza; plan DPD szuka etykiety po
  `result->>'tracking_number'` równym numerowi przesyłki.

Pieczęcie na świeżym `migrate()` (PG 18.4, C.UTF-8), w wycofanej transakcji i po kompilacji z COMMIT:
18/18 nazwanych, demo 16/16, 119/138 boolowskich — ten sam zbiór przed i po (0 różnic); seal-diff: 0 zmian
z 42 funkcji odcisków. Kompilacja katalogu: 51 dodań, 1 zmiana (`order_shipments_guard()`), 0 usunięć,
poprzednik = skompilowany after267; projekcja `projectCompiledCancelledLabelRelabel268Catalogue(after268)` daje
dokładnie before268 (sha `515e4ec0…`). Normalizator ACL nie potrzebuje 268 (tabela ma jawny `GRANT SELECT`
dla `dyna_app`, więc pg_dump zachowuje ACL; `tests/ordinary-legacy-schema-contracts.test.mjs` 5/5).
