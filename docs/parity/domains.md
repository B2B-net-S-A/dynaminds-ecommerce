# Funkcjonalny inwentarz domen — pełny Goal Base

**2026-10-17: 135 wymagań, 16 domen, 56 pierwotnych źródeł.** `inventory_complete:false` — to skończona pierwsza mapa, nie deklaracja pełnego parytetu. Operacje, testy i dowody każdego wiersza: [domains.json](domains.json).

Baza: odebrane lokalne V2,50/50 i pięć bram. [Bieżący stan](../CURRENT-PRODUCT-STATUS.md). [V1](../BASE-COVERAGE-V1.md) jest historyczną taksonomią. `accepted_v2` oznacza tylko dokładny przykład i bound_scope przypiętego Root receiptu; nie odbiór całego odpowiednika Base ani nowego Goala.

| Domena | Stabilne ID | Liczba | accepted_v2 | unverified |
|---|---|---:|---:|---:|
| OMS | `DOM-OMS-001`–`DOM-OMS-013` | 13 | 10 | 3 |
| PIM | `DOM-PIM-001`–`DOM-PIM-014` | 14 | 6 | 8 |
| WMS | `DOM-WMS-001`–`DOM-WMS-014` | 14 | 6 | 8 |
| IMP | `DOM-IMP-001`–`DOM-IMP-010` | 10 | 4 | 6 |
| FIN | `DOM-FIN-001`–`DOM-FIN-010` | 10 | 1 | 9 |
| B2B | `DOM-B2B-001`–`DOM-B2B-008` | 8 | 0 | 8 |
| COM | `DOM-COM-001`–`DOM-COM-008` | 8 | 0 | 8 |
| AUTO | `DOM-AUTO-001`–`DOM-AUTO-009` | 9 | 6 | 3 |
| REPRICE | `DOM-REPRICE-001`–`DOM-REPRICE-006` | 6 | 0 | 6 |
| ANALYTICS | `DOM-ANALYTICS-001`–`DOM-ANALYTICS-006` | 6 | 0 | 6 |
| AI | `DOM-AI-001`–`DOM-AI-006` | 6 | 0 | 6 |
| SEC | `DOM-SEC-001`–`DOM-SEC-006` | 6 | 3 | 3 |
| ACCOUNT | `DOM-ACCOUNT-001`–`DOM-ACCOUNT-005` | 5 | 0 | 5 |
| API | `DOM-API-001`–`DOM-API-006` | 6 | 0 | 6 |
| HW | `DOM-HW-001`–`DOM-HW-006` | 6 | 0 | 6 |
| SHIP | `DOM-SHIP-001`–`DOM-SHIP-008` | 8 | 0 | 8 |

Razem: **36 accepted_v2, 99 unverified, 0 potwierdzonych missing**. Nieznalezienie wskazanego kandydata nie zostało zamienione w tezę o braku całej implementacji.

## Odbiór i poziomy dowodu

Każdy wiersz zawiera happy path, konkretny negatyw, restart/idempotencję oraz uprawnienia/izolację. `evidence.code`, `local`, `sandbox`, `account` są czterema oddzielnymi tablicami. Pusta oznacza brak przejrzanego dowodu. Code anchor dowodzi istnienia kandydata, nie pełnej semantyki czy rejestracji zwykłego runtime. `full_goal_acceptance:not_evaluated` obowiązuje także przy istniejącym V2 PASS.

Lokalny SMTP nie oznacza zewnętrznego doręczenia; DEMO nie jest nadaniem/fiskalizacją/przelewem. Skala V2 nie potwierdza wielu tenantów z aktywnymi workerami. Kryteria negatywne i restartowe to propozycja projektu, nie cytat z dokumentacji Base.

## Addytywne dowody lokalnego wydania10 — 2026-10-17

Rewizja `49e3a6fdf5780802e5eb562010b634afb0512ebe074ad8017141523e8eb38f55`, schemat208. Dodano dowody do **pięciu istniejących ID**; nadal 36 `accepted_v2` i 99 `unverified`. Nie zmieniono definicji, operacji, kryteriów ani statusów; `full_goal_acceptance:not_evaluated`, pełny odbiór modułu/Base pozostaje **false**. Zamrożone scope.v2 i inputs są historycznymi, osobnymi plikami i pozostają literalne.

| Wymaganie | Dokładny nowy dowód | Nadal otwarte |
|---|---|---|
| `DOM-FIN-003` | Cztery ordinary API: OFF/ON −2700gr i pozostało1701gr, reject-only bez dokumentu/numeru, mixed stara188 −1000gr +nowa207 −1700gr. 203 żądania drivera; osobny preflight poza licznikiem. | Pełne UI tworzenia, IAM/concurrency, restart/ACK-loss, refundacja dostawcy, pozostałe podatki i skala. |
| `DOM-FIN-006` | Scoped rejestr korekt API/Chrome, w mixed widoczne dwie rodziny dokumentów. | Pełny sales register, okres, eksport i wszystkie dokumenty. |
| `DOM-OMS-011` | Dwa ordinary API warianty MERGE, źródłowe pozycje/lineage i target readback. 82 żądania: 74 GET, 4 auth POST200, 4 business POST201; cztery oryginalne klucze, bez retry. | UI tworzenia, genuine negatywy/IAM/concurrency, restart/recovery, wielostronicowość, classified/override delivery i konflikt odbiorców. Split nadal code-only. |
| `DOM-WMS-003` | Osobny inventory API po MERGE: on_hand=6 / reserved=4 / available=2; cele po 2 reservation/pendingparcel units w API baseline. | Pełny fizyczny DB audit, wszystkie lokalizacje/partie/journale, transfer stock, restart/recovery i workery. |
| `DOM-HW-002` | Chrome: trzy widoki druku już wystawionych korekt OFF/ON/mixed. | Fizyczna drukarka/bridge/job receipt, PDF delivery, etykiety i druk masowy; nie odebrano operacji wyboru/zadania/potwierdzenia. |

Piny dowodów (pełne SHA/bytes/bound_scope także per ID w JSON):

- [Root ordinary API credit review](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/return-credit207-ordinary10-1792270843651/Root-final-review.private.json>), SHA `9d3019f9ca84bab1b6a660cd934f25e7203845a2e1aed0296a4ee600312d3d34`.
- [Root Chrome read/print review](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/ordinary10-chrome-review/Root-chrome-review.private.json>), SHA `068e53df2a5672c17418257fd70a76b4d3906b930963620b10cfe034e8daea5f`.
- [MERGE recorded ordinary result](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/order-merge-ordinary10-run-1792273659001/result.private.json>), SHA `60f583342ff0dd5ddcf5a0f46b6e747b479cd8a28d9493b28db3ad787cff5a36`; [independent artifact review](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/order-merge-ordinary10-run-1792273659001/independent-ordinary-merge-review.private.json>), SHA `085f2198f61af09a6c5a014b270400038686036dd6663986ebfb42278f642b36`.
- [Inventory API baseline](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/merge10-after-and-before11-1792273759001/inventory.private.json>), SHA `bb25c19e2966af70353cca25b39a4814a55fd3aa64bb78cf260da6a4aedeb8ed`; [independent baseline review](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/merge10-after-and-before11-1792273759001/independent-baseline-review.private.json>), SHA `cdde2bf5b3910a813ef43487f51b9512bd2fba7abe44c150e4dfa3a553ebf263`.

Raw target/order DTO mogą zawierać portal credentials; nie publikujemy ich treści. Liczniki HTTP nie oznaczają p95/pojemności. Driver porównywał część odpowiedzi w pamięci; niezależny przegląd nie odtwarza z dysku wszystkich niezachowanych stron. MERGE fizyczne rows w driverze to source snapshots, a osobny inventory baseline to nadal API-observable state, nie pełny audyt DB. Baseline przed 11 nie stanowi dowodu stanu po restarcie.

Split ma wyłącznie pinowane nowe schema/values/test (commit `22970811d84fb24fb0e20a12bbdfa03e9d22b0b2`), poza emitowanym grafem runtime wydań10 i11. Raportowane 14 testów pure i 744 niezależne małe integer oracle cases (368 ready / 376 jawnych VAT conflict / 0 fail) są **code-only**, bez osobnego trwałego receiptu testowego w tej macierzy; nie oznaczają funkcji DONE. Brak split runtime/Native/custody/finansów/UI. Istniejąca negatywna ocena pełnego odbioru nie została zmieniona.

## Otwarte źródła i zakres

- **DOM-GAP-001 / INVENTORY:** Skończona próbka jawnych źródeł nie jest pełnym spisem ekranów, opcji i usług Base. Domknięcie: Porównać pełny indeks pomocy i uzgodnione źródła z wszystkimi wierszami.
- **DOM-GAP-002 / VARIANT-CONFLICT:** Pomoc wariantów dopuszcza łączenie istniejących produktów; FAQ eksportu temu przeczy, a import produktów wyklucza tworzenie wariantów. Domknięcie: Rozstrzygnąć aktualny kontrakt UI/importu przed rozszerzeniem DOM-PIM-007 i IMP.
- **DOM-GAP-003 / STOCKTAKE-CONFLICT:** Artykuł inwentaryzacji opisuje blokadę lokalizacji oraz brak automatycznej blokady ruchu w panelu. Domknięcie: Rozdzielić ręczną blokadę, WMS App i panel w DOM-WMS-014.
- **DOM-GAP-004 / CONNECTOR-ROSTER:** Generic domain rows nie zastępują osobnych list marketplace/sklepów/ERP/kurierów/SMS/fulfillment i ich wersji API. Domknięcie: Zintegrować oddzielny konektorowy inwentarz Root z operacjami i poziomami dowodu.
- **DOM-GAP-005 / AUTHENTICATED-OPTIONS:** Nie odwiedzano zalogowanego Base ani kont dostawców; opcje zależne od planu, kraju i konta pozostają otwarte. Domknięcie: Autoryzowany przegląd panelu lub aktualnej specyfikacji z dokładnym zakresem.
- **DOM-GAP-006 / API-SECURITY:** Wire compatibility metod i X-BLToken Base nie wynika z REST DYNAMINDS. MFA/SSO/retencja/RODO nie mają tu pełnego źródłowego kontraktu. Domknięcie: Osobno zamrozić publiczny kontrakt API i wymagania bezpieczeństwa po primary review.
- **DOM-GAP-007 / ACCOUNT-ECOSYSTEM:** Base Store, Super Merchant i program partnerski oraz usługi handlowe nie są kompletnie rozpisane przez ACCOUNT. Domknięcie: Osobne pierwotne źródła i rozdział funkcji software od usług biznesowych.
- **DOM-GAP-008 / CODE-SEMANTICS:** Kandydat pliku lub symbolu nie dowodzi działania funkcji ani rejestracji w normalnym runtime. Brak kandydata nie dowodzi braku całego kodu. Domknięcie: Per-row Source/UI review i kontrolowane testy przed statusem missing lub implemented.
- **DOM-GAP-009 / FULL-GOAL-RECEPTION:** accepted_v2 jest wąskim przykładem lokalnym; cztery kryteria nowego Goala nie są przezeń automatycznie odebrane. Domknięcie: Pełny normalny happy/negative/restart/permissions i właściwy poziom dostawcy.
- **DOM-GAP-010 / DEPTH-VARIANTS:** Nie rozpisano wszystkich podatków/OSS/KSeF, dokumentów, walut, zdarzeń, tagów, modeli sprzętu i wariantów kosztu. Domknięcie: Dodać podwiersze po zamrożeniu źródeł, zamiast interpretować jeden wiersz jako wszystkie kombinacje.

- **DOM-GAP-011 / RETENTION-AND-ARCHIVE:** osobno rozwinąć archiwum i retencję; oficjalne [archiwum Base](https://base.com/pl-PL/pomoc/wiedza/archiwum-zamowien/) usuwa część historii. Nie kopiować destrukcyjnej polityki bez jawnego Root review zachowania danych.

## Pierwotne źródła sprawdzone 2026-10-17

Krótkie wymagania są parafrazami publicznej dokumentacji. Nie użyto zalogowanego konta Base/dostawcy.
- `BASE-account` — [konfiguracja-base-com](https://base.com/pl-PL/pomoc/wiedza/konfiguracja-base-com/)
- `BASE-ai` — [ai-w-base-com](https://base.com/pl-PL/pomoc/wiedza/ai-w-base-com/)
- `BASE-api` — [api.baselinker.com](https://api.baselinker.com/)
- `BASE-auto` — [automatyczne-akcje](https://base.com/pl-PL/pomoc/wiedza/automatyczne-akcje/)
- `BASE-billing` — [abonament](https://base.com/pl-PL/pomoc/wiedza/abonament/)
- `BASE-billingfaq` — [abonament](https://base.com/pl-PL/pomoc/faq/abonament/)
- `BASE-bulksets` — [masowe-tworzenie-zestawow](https://base.com/pl-PL/pomoc/wiedza/masowe-tworzenie-zestawow/)
- `BASE-card` — [karta-zamowien](https://base.com/pl-PL/pomoc/wiedza/karta-zamowien/)
- `BASE-catalog` — [katalog](https://base.com/pl-PL/pomoc/wiedza/katalog/)
- `BASE-channel` — [informacje-na-karcie-produktu](https://base.com/pl-PL/pomoc/wiedza/informacje-na-karcie-produktu/)
- `BASE-config` — [manager-zamowien-konfiguracja](https://base.com/pl-PL/pomoc/wiedza/manager-zamowien-konfiguracja/)
- `BASE-connect` — [base-connect](https://base.com/pl-PL/pomoc/wiedza/base-connect/)
- `BASE-count` — [inwentaryzacje](https://base.com/pl-PL/pomoc/wiedza/inwentaryzacje/)
- `BASE-courier` — [konta-kurierow-i-drukowanie](https://base.com/pl-PL/pomoc/wiedza/konta-kurierow-i-drukowanie/)
- `BASE-crm` — [responso](https://base.com/pl-PL/pomoc/wiedza/responso/)
- `BASE-draft` — [szkic-produktu](https://base.com/pl-PL/pomoc/wiedza/szkic-produktu/)
- `BASE-employees` — [konta-pracownikow](https://base.com/pl-PL/pomoc/wiedza/konta-pracownikow/)
- `BASE-erp` — [integracje-z-systemami-ksiegowosci-internetowej](https://base.com/pl-PL/pomoc/wiedza/integracje-z-systemami-ksiegowosci-internetowej/)
- `BASE-events` — [akcje-automatycznie-zdarzenia-systemowe](https://base.com/pl-PL/pomoc/wiedza/akcje-automatycznie-zdarzenia-systemowe/)
- `BASE-export` — [eksport-produktow](https://base.com/pl-PL/pomoc/wiedza/eksport-produktow/)
- `BASE-fields` — [pola-dodatkowe](https://base.com/pl-PL/pomoc/wiedza/pola-dodatkowe/)
- `BASE-filter` — [filtrowanie-listy-zamowien](https://base.com/pl-PL/pomoc/wiedza/filtrowanie-listy-zamowien/)
- `BASE-fulfill` — [integracje-fulfillmentowe](https://base.com/pl-PL/pomoc/wiedza/integracje-fulfillmentowe/)
- `BASE-import` — [import-produktow-z-pliku-csv-lub-xml](https://base.com/pl-PL/pomoc/wiedza/import-produktow-z-pliku-csv-lub-xml/)
- `BASE-invoice` — [faktury-obsluga](https://base.com/pl-PL/pomoc/wiedza/faktury-obsluga/)
- `BASE-locations` — [lokalizacje-w-magazynie](https://base.com/pl-PL/pomoc/wiedza/lokalizacje-w-magazynie/)
- `BASE-messages` — [komunikacja-z-klientem](https://base.com/pl-PL/pomoc/wiedza/komunikacja-z-klientem/)
- `BASE-oms` — [manager-zamowien-obsluga](https://base.com/pl-PL/pomoc/wiedza/manager-zamowien-obsluga/)
- `BASE-packing` — [pakowanie-i-zbieranie-zamowien](https://base.com/pl-PL/pomoc/wiedza/pakowanie-i-zbieranie-zamowien/)
- `BASE-params` — [parametry-w-katalogu](https://base.com/pl-PL/pomoc/wiedza/parametry-w-katalogu/)
- `BASE-payment` — [import-przelewow-i-pobran](https://base.com/pl-PL/pomoc/wiedza/import-przelewow-i-pobran/)
- `BASE-printer` — [base-printer](https://base.com/pl-PL/pomoc/wiedza/base-printer/)
- `BASE-prints` — [wydruki-eksporty](https://base.com/pl-PL/pomoc/wiedza/wydruki-eksporty/)
- `BASE-product` — [karta-produktu](https://base.com/pl-PL/pomoc/wiedza/karta-produktu/)
- `BASE-products` — [lista-produktow-w-magazynie](https://base.com/pl-PL/pomoc/wiedza/lista-produktow-w-magazynie/)
- `BASE-register` — [rejestr-sprzedazy](https://base.com/pl-PL/pomoc/wiedza/rejestr-sprzedazy/)
- `BASE-repricing` — [automatyzacja-cen-repricing](https://base.com/pl-PL/pomoc/wiedza/automatyzacja-cen-repricing/)
- `BASE-returns` — [zwroty](https://base.com/pl-PL/pomoc/wiedza/zwroty/)
- `BASE-rma` — [asystent-zwrotow](https://base.com/pl-PL/pomoc/wiedza/asystent-zwrotow/)
- `BASE-salesdoc` — [dokumenty-sprzedazy](https://base.com/pl-PL/pomoc/wiedza/dokumenty-sprzedazy/)
- `BASE-scale` — [base-scale](https://base.com/pl-PL/pomoc/wiedza/base-scale/)
- `BASE-seller` — [konfiguracja-base-connect-dla-sprzedawcow](https://base.com/pl-PL/pomoc/wiedza/konfiguracja-base-connect-dla-sprzedawcow/)
- `BASE-sets` — [zestawy](https://base.com/pl-PL/pomoc/wiedza/zestawy/)
- `BASE-sms` — [sms](https://base.com/pl-PL/pomoc/wiedza/sms/)
- `BASE-sources` — [import-produktow](https://base.com/pl-PL/pomoc/wiedza/import-produktow/)
- `BASE-stats` — [statystyki](https://base.com/pl-PL/pomoc/wiedza/statystyki/)
- `BASE-stock` — [kontrola-magazynu](https://base.com/pl-PL/pomoc/wiedza/kontrola-magazynu/)
- `BASE-supplier` — [konfiguracja-base-connect-dla-dostawcow](https://base.com/pl-PL/pomoc/wiedza/konfiguracja-base-connect-dla-dostawcow/)
- `BASE-template` — [szablony-email](https://base.com/pl-PL/pomoc/wiedza/szablony-email/)
- `BASE-translate` — [masowe-przenoszenie-aukcji-i-ofert](https://base.com/pl-PL/pomoc/wiedza/masowe-przenoszenie-aukcji-i-ofert/)
- `BASE-update` — [modyfikacja-danych](https://base.com/pl-PL/pomoc/wiedza/modyfikacja-danych/)
- `BASE-variants` — [warianty](https://base.com/pl-PL/pomoc/wiedza/warianty/)
- `BASE-whdocs` — [dokumenty-magazynowe](https://base.com/pl-PL/pomoc/wiedza/dokumenty-magazynowe/)
- `BASE-wms` — [system-zarzadzania-magazynem-wms](https://base.com/pl-PL/pomoc/wiedza/system-zarzadzania-magazynem-wms/)

- `BASE-delay` — [wykonywanie-akcji-z-opoznieniem](https://base.com/pl-PL/pomoc/wiedza/wykonywanie-akcji-z-opoznieniem/)
- `BASE-list` — [lista-zamowien-obsluga](https://base.com/pl-PL/pomoc/wiedza/lista-zamowien-obsluga/)

## Pierwotne granice wykonania i bieżąca aktualizacja

Pierwotnie zapisano wyłącznie dwa nowe pliki domains.json/domains.md. Zweryfikowano 135 unikalnych ID, wymagane pola i cztery poziomy dowodów, istniejące pliki/linie kodu i SHA/bytes aktualnych receiptów Root użytych jako local. Bez HTTP/PG/runtime/usług/fixture, bez zmian aplikacji, macierzy V2 i historii. Potrzebny niezależny review oraz integracja Root.

Aktualizacja dowodów10 zmieniła tylko bieżące domains.json/domains.md; zachowano 135 ID, definicje, operacje, wszystkie stare dowody i statusy oraz zamrożone scope inputs. Nie wykonano nowych HTTP/PG/browser/testów biznesowych. Plikowy parity checker weryfikuje piny, nie przyznaje odbioru produktu.
