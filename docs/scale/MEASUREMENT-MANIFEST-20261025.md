# Manifest pomiaru skali — etap 5, przygotowanie 25.10.2026

**Status: PRZYGOTOWANIE / pomiar pełnego profilu niewykonany.** Ten dokument zamraża
sposób pomiaru przed etapem 5. Wymagania liczbowe pochodzą z
`docs/parity/acceptance-profile.v1.json` (`config_sha256`
`1ab65a9256b67be9c50fd1ff964a8072d4ce1c4340b6c07900345b8c4926b8a7`) i z punktu 10
`docs/FULL-BASE-GOAL.md`. Gdy ten manifest i profil się różnią, wygrywa profil;
zmiana profilu wymaga jego nowej wersji z przypiętym rodzicem.

## 1. Sprzęt (zamrożony, odczyt 25.10.2026)

| Pole | Wartość | Źródło |
|---|---|---|
| Komputer | Apple M5 Max, 18 rdzeni logicznych = 18 fizycznych (6 wydajnościowych + 12 energooszczędnych) | `sysctl -n machdep.cpu.brand_string hw.ncpu hw.physicalcpu hw.perflevel0.physicalcpu hw.perflevel1.physicalcpu` |
| Pamięć | 137 438 953 472 B = 128 GiB | `sysctl -n hw.memsize` |
| System | macOS 26.6 (25G72), Darwin 25.6.0, arm64 | `sw_vers`, `uname -r`, `uname -m` |
| Dysk systemowy | 3,6 TiB, wolne 3,1 TiB | `df -h /` |
| Node | v22.23.0 | `node --version` |
| PostgreSQL (PG04) | 18.4, plik `local-builds/crypto-accelerated209/runtime-arm64/bin/postgres` to Mach-O arm64 (napis `version()` podaje `x86_64-apple-darwin24.6.0`, to etykieta kompilacji) | `file`, `SELECT version()` |

Wynik z innego sprzętu, z 24 GB RAM albo z rosnącym swapem nie jest porównywalny
(punkt 10 Goala). Na początku każdego biegu zapisujemy ponownie te same pola; inna
wartość unieważnia porównanie z tym manifestem.

## 2. Wydanie do zmierzenia

| Pole | Wartość |
|---|---|
| Git SHA wydania | *do wpisania na starcie etapu 5* (bieg próbny w wydaniu 26.10: `74d3f9507292f86ff1e2c76d3c8a652a99d135bb`, sekcja 11) |
| SHA256 pakietu / manifestu wydania | *do wpisania na starcie etapu 5* (bieg próbny: `release.json` `bc9901a9e95b3637255bd609e125f3495827125dfce8c737aa66c3aeb4305b9f`, drzewo pakietu `a6ea5448e663cf48761e1455209621b6100aa4b14b6bc04ff329919eedbb1843`) |
| Ostatnia migracja w ledgerze | *do wpisania* (klon z 25.10 po `migrate()`: `233_fiscal_receipts`, 223 wpisy) |
| Kontrakt źródeł / profil natywny | *do wpisania* |
| SHA generatora (`tools/scale/*.mjs`) | *do wpisania* (git SHA commita generatora; bieg próbny 26.10 na `3d25907`, sekcja 10) |

Jedno niezmienne wydanie dla zimnego startu, rozgrzewki, obu faz, awarii i odtworzenia
(`binding_and_evidence.exact_same_final_release`). Zmiana kodu, konfiguracji albo
danych w trakcie unieważnia cały bieg.

**Wymóg dla generatora:** pełny zbiór danych generujemy na tym samym spakowanym
wydaniu, uruchomionym przez `server/ordinary-local-runtime.ts` (zainstalowana bramka
schematu `installOrdinarySchemaRuntime`). Powód w sekcji 7: w trybie źródłowym każde
`tenantTx` wykonuje cztery walidatory schematu (zmierzone ~9,3 s na pustą transakcję).
Pakiet i bieg w nim: `tools/scale/release-build.mjs` (pola tej tabeli zapisuje do
`release-build.json`) i `generate.mjs --release` przez `scale-pg.sh netns-node` (sekcja 11).

## 3. PostgreSQL na czas pomiaru

Instancja: Docker `dyna-scale-pg18` (PostgreSQL 18.4 arm64 + libfaketime), `127.0.0.1:57090`,
definicja i odtworzenie w sekcji 10 i `tools/scale/docker/README.md`. Osobna instancja, nie współdzielona PG04 (port 57084), bo na PG04 równolegle pracują
testy innych agentów, a profil każe uznać bieg za nieważny przy niekontrolowanym
obciążeniu sąsiednim (`limits.resources.measurement_host_policy`). Main (port 4100,
`app/data/postgres`) pozostaje nietknięty.

| Ustawienie | Wartość na pomiar | PG04 dziś | Powód |
|---|---|---|---|
| binarka | PostgreSQL 18.4 arm64 z obrazu `postgres:18.4-trixie@sha256:a02db8ca…1636` (Debian 18.4-1.pgdg13+1), ta sama wersja co PG04 | `runtime-arm64/bin/postgres` 18.4 | jedna wersja dla generatora i pomiaru; zmiana z 26.10 (decyzja: Docker + libfaketime), binarka PG04 nie przyjmuje przesunięcia zegara |
| `listen_addresses` / port | kontener `*`, na hoście tylko `127.0.0.1:57090`, wolumen `dyna-scale-pg18-data` | 57084 | izolacja od PG04 i Main |
| zegar | libfaketime w procesach serwera, przesunięcie z pliku; na pomiar `SCALE_FAKETIME=off` | — | historia 180 dni zwykłymi ścieżkami (sekcja 10) |
| `shared_buffers` | 16GB | 128MB | zbiór ~kilka–kilkanaście GB mieści się w pamięci; 12,5% RAM |
| `effective_cache_size` | 64GB | 4GB | planer ma wiedzieć o pamięci podręcznej systemu |
| `work_mem` | 32MB | 4MB | sortowania list (strony po 50) bez plików tymczasowych |
| `maintenance_work_mem` | 2GB | 64MB | VACUUM/indeksy po generowaniu |
| `max_wal_size` / `min_wal_size` | 16GB / 2GB | 1GB / domyślne | mniej wymuszonych checkpointów przy zapisach |
| `checkpoint_timeout` / `checkpoint_completion_target` | 15min / 0.9 | 5min | równy rozkład zapisu |
| `random_page_cost` | 1.1 | 4 | dysk SSD |
| `max_connections` | 100 | 100 | pula aplikacji 12 + workery + obserwatorzy mieszczą się z zapasem |
| `jit` | off | off | jak w aplikacji (`-c jit=off`) |
| `timezone` | UTC | — | jak w puli aplikacji |
| `fsync`, `synchronous_commit`, `full_page_writes` | on, on, on | on | żadnych skrótów trwałości |
| `wal_level` / `archive_mode` | replica / on, archiwum WAL na wolumenie `dyna-scale-pg18-wal-archive`; od 27.10 `archive_command` = `dyna-wal-archive` (zstd + fsync) i `archive_timeout = 60s` | replica / off | ten sam koszt, który da RPO ≤15 min z punktu 11 (pomiar: `docs/scale/RECOVERY-DRILL-20261027.md`) |
| `autovacuum` | on, `autovacuum_vacuum_scale_factor=0.05`, `autovacuum_analyze_scale_factor=0.02` | on | statystyki aktualne przy 100 tys. zamówień |
| `track_io_timing`, `log_min_duration_statement` | on, 1000ms | — | dowód wolnych zapytań |
| `statement_timeout`, `lock_timeout` | 8s, 8s w puli aplikacji (bez zmian) | — | `timeouts_ms.runtime_*` profilu |

Pełny zrzut `pg_settings` zapisujemy przed i po biegu. Po wygenerowaniu danych:
`VACUUM (ANALYZE)` całej bazy, potem zimny start (sekcja 5).

## 4. Dane

Generator: `tools/scale/generate.mjs` (plan `tools/scale/plan.mjs`, zapis
`tools/scale/writer.mjs`). Deterministyczny: ten sam seed i parametry dają ten sam
skrót planu; testy `tests/scale-generator.test.mjs`.

| Parametr | Pełny profil |
|---|---|
| seed / as-of | `dyna-scale-20261025` / `2026-10-25T00:00:00.000Z` |
| skrót planu (`planDigest`, `dyna-scale-plan/v2` od 26.10) | pełny profil `ca7c640f0c9761fe0ce79197da92cbc276c229219d5ce11ccd173f869496ae37` (od 28.10, `6f8dd64`: zestawy bloku 0 biorą jego warianty, gdy wszystkie proste SKU bloku są gorące — od 880 SKU na firmę zestaw bez składników zatrzymywał generator; wcześniej `f9a5ccea…218028`); `--tenants 5 --skus 20000 --orders 4000` `1d1eae6fac1f8a1103f245bf88c5a813edfb328bfb7c9e9af3c8d9094c7a903f` (zbiór testu obciążenia, sekcja 12); `--scale-factor 0.01` `f320dcf6809a39a5af505bb74810eb70bd57706f560a8260c678738c76c2fe63`; `--scale-factor 0.005 --days 2` `e75538e7fe50a92e0ed20d4c96b1665f4b78e0e087e5898ac028e8abfe2d5262` (`node tools/scale/generate.mjs --plan-only`). v1 (25.10): `a71ce5e5…c6c536` / `66624d2b…eb076` — zmiana: linie zestawów i plan partii WMS |
| firmy | 5 (A–E), osobne konta właścicieli i organizacje utworzone przez `/api/auth/signup`, plan Enterprise przez `PATCH /api/workspaces/plan` |
| SKU | 100 000 = 5 × 20 000; na każde 100: 2 grupy (rodzice wariantów), 8 wariantów, 88 prostych, 2 zestawy |
| gorące SKU | 100 na firmę, stan początkowy dokładnie 20 szt., nieużywane przez historię |
| magazyny / lokalizacje | 2 na firmę (`MAIN` z rejestracji + `ZAP-x` przez `POST /api/warehouses`), po 20 lokalizacji |
| WMS partie | A, C, E: polityka włączana zwykłym otwarciem WMS (`createWmsOpeningPreview` + `activateWmsOpening`); 5 % fizycznych SKU (bez gorących) ma stan otwarcia sprzed polityki (partia `opening`, koszt nieznany 70 % / znany 30 %), reszta przychodzi dokumentami PZ (`receiveWmsReceipt`) w dwóch dostawach (60 % / 40 %, koszt znany, 5 % zerowy), gorące SKU jedną PZ po 20 szt.; zamówienia rezerwują warstwy FIFO w `createOrder`, skan wskazuje warstwę, zwrot przyjmuje fragmenty wydania. B, D bez partii |
| zestawy | 2 % linii zamówień sprzedaje zestaw (jak udział zestawów w katalogu); popyt liczony na składnikach |
| zamówienia | 100 000 = 5 × 20 000; statusy draft 10, confirmed 15, picking 15, packed 10, shipped 40, cancelled 5, returned 5 % |
| linie / sztuki | 1 linia 40 %, 2–3 40 %, 4–10 15 %, 11–20 5 %; sztuk na linię 1–5 95 %, 6–20 5 % |
| klienci | pula `ceil(zamówienia / 2,5)` na firmę, rozkład z powracającymi klientami, adresy PL, e-mail w `example.test` |
| płatności | potwierdzenie wpłaty zwykłym przejściem `new → paid` (`confirmOutstanding`) dla wszystkich poza draft i częścią cancelled |
| faktury | lokalna FV 157 z modelem podatkowym 226 (`previewLocalInvoice` + `issueLocalInvoiceWithTax`) dla 80 % wysłanych i wszystkich zwróconych; seria na firmę |
| zwroty | sprawa zwrotu (`requestReturn` → `receiveReturn` z przyjęciem na stan → `recordRefund`) dla statusu returned |
| historia | plan rozkłada `placed_at` równo na 180 dni; `--simulate-days` zapisuje katalog dzień przed oknem, a zamówienia każdego dnia przy zegarze bazy i procesu ustawionym na ten dzień (sekcja 10) |

Ścieżki zapisu: konfiguracja firm przez prawdziwe trasy HTTP (`buildApp` + `inject`,
bez nagłówka `origin`), rekordy masowe przez te same funkcje domenowe, które wołają
trasy (`createProduct`, `createOrder`, `transitionDirectLegacyOnReturnInTx`, `scan`,
`shipDemo`, FV, zwroty), każda w `tenantTx` (rola `dyna_app`, RLS, triggery, strażnicy).
Bez wyłączania triggerów i bez wstawiania dowodów SQL-em.

Przed i po generowaniu: 10 strażników prawdziwych (`ordinary187_valid`,
`buyer_address_guards`, `order_merge_delivery209_valid`, `return_credit206_guards`,
`ordinary188_structure_valid`, `return_credit211_metadata_valid`,
`large_import173_valid`, `fa3_draft_guards`, `pim_dictionary_valid`,
`local_invoice_guards`), sesja `-c jit=off -c timezone=UTC`,
`SET LOCAL search_path TO "$user",public`, `BEGIN READ ONLY`. Inwentarz z profilu
(`dataset.required_inventory`): liczby i skróty per firma/tabela/status, histogram
linii i sztuk, sumy stanów i rezerwacji, stan kolejek, rozmiar bazy i indeksów.

## 5. Profil obciążenia

Model z profilu: pętla zamknięta, jedno uwierzytelnione żądanie w locie na klienta,
zero celowego czasu namysłu, bez automatycznego ponawiania zapisów. Kolejność:
3 zimne starty (każdy ≤180 s do gotowości biznesowej i workerów) → 600 s rozgrzewki
(wykluczone z wyników) → **steady12** 1800 s, 12 klientów, ≥10 udanych RPS →
**steady24** 1800 s, 24 klientów, ≥20 udanych RPS → drenaż workerów ≤120 s →
ciepły restart ≤60 s → przypadki odtwarzania poza godziną pomiaru.
Udział firm A–E po 20 % (±2 pp).

| Grupa klientów | Operacje profilu (udział) | Ścieżka |
|---|---|---|
| Przyjmowanie zamówień | `order_create` 15 % | Base API `POST /connector.php` `addOrder` (token API firmy, klucz klienta) |
| Przeglądanie | `order_list` 25 %, `catalog_search` 20 %, `order_detail` 15 % | sesja UI: listy zamówień (połowa starszych niż 30 dni), wyszukiwanie produktów (SKU/tekst 50:50; trafienie/brak/szeroko 50:25:25), szczegół zamówienia |
| Kompletacja | `reserve_and_status` 10 %, `stock_operation` 5 % | zmiany statusu z rezerwacją (w tym wyścig o gorące SKU), skan, pakowanie, korekty/przesunięcia WMS |
| Fakturowanie i płatności | `payment_or_document` 5 % (pół na pół) | wpłata (`POST /api/orders/:id/payments`) albo FV (`…/previews` → `…/tax-issue`) |
| Zwroty | `return_receive` 5 % | przyjęcie zwrotu WMS OFF/ON z uzgodnieniem fizycznym i finansowym |

Tło przez obie fazy, dla każdej firmy: automatyzacje 5/min, import zamówień z lokalnego
WooCommerce 6/min, synchronizacja stanów 12/min; co najmniej 2 rzeczywiste procesy
workerów; lokalne instancje oficjalnego WooCommerce ≥2. Sterownik:
`tools/scale/load/run.mjs` (od 27.10: klient na kontener z własnym adresem, żądania przez
`scripts/full-base-scale-http-ports.mjs`, workery wydania aktywne; sekcja 12) — wcześniej
`scripts/full-base-scale-executor.mjs` (siedem bramek z `docs/parity/FULL-BASE-SCALE-GAPS-20261019.md`
nadal otwartych, sekcja 12 „Otwarte”).

## 6. Progi sukcesu

| Miara | Próg |
|---|---|
| odczyt p95 / p99 | ≤500 ms / ≤1000 ms — każda operacja, firma, faza i łącznie |
| zapis p95 / p99 | ≤4000 ms / ≤8000 ms — jw. |
| nieoczekiwane 5xx / timeouty / błędy | 0 / 0 / 0 |
| oczekiwane odmowy | tylko 409 z dokładnym powodem, na wcześniej oznaczonych wyścigach, ≤1 % żądań, poza przepustowością |
| przepustowość | steady12 ≥10 RPS, steady24 ≥20 RPS przez całe 1800 s; żaden pełny 60-s kubełek < połowy minimum |
| klienci aktywni | ≥95 % czasu fazy; szczyt in-flight 12 / 24 potwierdzony licznikiem serwera |
| próbki | ≥100 na firmę × operację × fazę |
| duplikaty, oversell, przeciek firm, utrata zapisu | 0 |
| kolejki | najstarsze kwalifikujące p95 ≤15 s, max ≤60 s; drenaż ≤120 s; nierozstrzygnięte unknown 0 |
| CPU hosta | średnia 60 s ≤85 % |
| RSS aplikacja+baza+workery | ≤12 GiB i ≤75 % RAM; przyrost swapu ≤256 MiB |
| pętla zdarzeń p99 | ≤100 ms |
| pula bazy | oczekiwanie p95 ≤50 ms, p99 ≤250 ms, timeouty 0, wykorzystanie p95 ≤0,8 |
| dysk | wolne ≥30 GiB; przyrost bazy w biegu ≤10 GiB; dowody ≤1 GiB |
| zimny start / ciepły restart | ≤180 s / ≤60 s |

Brak pomiaru albo pominięty krok = niezaliczone (`binding_and_evidence.decision`).

## 7. Znane przeszkody przed pełnym biegiem

1. **Koszt transakcji w trybie źródłowym.** Bez bramki schematu `tenantTx` przed
   każdą transakcją wykonuje `preflightPim`, `preflightNestedPim`,
   `preflightPhysicalParcelWz`, `preflightOperationalDeliveryConsumers`
   (`server/db.ts:287-290`). Zmierzone na klonie PG04: ~4,2 + 1,9 + 1,9 + 1,8 s,
   pusta `tenantTx` 9,3–9,6 s. Pełny zbiór to setki tysięcy transakcji, więc
   generator musi działać w runtime spakowanego wydania (sekcja 2). *Rozwiązane 26.10:*
   `generate.mjs --release`, pusta `tenantTx` w wydaniu 4,2–5,4 ms (sekcja 11).
2. **Limit 600 żądań/min na adres IP** (`server/app.ts:744`, klucz = adres peera).
   10 RPS z jednego adresu pętli zwrotnej to dokładnie limit; steady24 (≥20 RPS)
   jest z jednego adresu niewykonalne, a 429 liczy się jako błąd. *Decyzja 26.10:* klienci
   obciążenia w sieci Docker (osobne adresy), limit produktu bez zmian.
   *Decyzja 29.10:* limit można ustawić w instalacji zmienną `DYNA_RATE_LIMIT_PER_MIN`.
   - Dozwolone wartości: 60–100 000. Bez zmiennej limit wynosi 600.
   - Szczegóły: `LOAD-TEST-FULL-20261029.md` §4.1.
   - Bieg zapisuje użytą wartość (sekcja 12).
3. **Limit Base API 100/min na firmę** na `connector.php`
   (`server/base-wire-routes.ts:94`). Przy 15 % `addOrder` i 20 RPS to ~36/min na
   firmę, ale pętla zamknięta bez namysłu przy szybszym systemie przekroczy limit.
   *Decyzja 26.10:* profil obciążenia ogranicza `addOrder` do limitu 100/min na firmę.
4. **Historia 180 dni.** Zwykłe ścieżki biorą czas z `now()` bazy, a `created_at` wielu
   tabel jest niezmienny (triggery). *Rozwiązane 26.10 w generatorze:* `--simulate-days`
   na instancji Docker z libfaketime (sekcja 10), bez zapisu dat SQL-em.
5. **WMS partie w A/C/E.** *Rozwiązane 26.10:* otwarcie WMS + PZ (sekcja 4). Nowa
   przeszkoda: pkt 9.
6. **Zestawy (bundle).** *Rozwiązane 26.10:* 2 % linii zamówień (sekcja 4).
7. **Walidator PIM blisko limitu 8 s.** `pim_dictionary_valid()` trwał na PG04 4,0 s
   na początku biegu i 7,2–9,8 s pod koniec, także na nietkniętym szablonie (5,7–9,3 s),
   przy średnim obciążeniu hosta 14–20 od testów innych agentów. W trybie źródłowym
   `preflightPim` przekroczył wtedy `statement_timeout=8000` puli i przerwał bieg
   dwukrotnie. To dodatkowy powód, by pomiar i generowanie miały osobną instancję
   i spakowane wydanie.
8. **Status „returned”.** Zwrot części zamówienia przez sprawę zwrotu zostawia
   zamówienie w `shipped` (sprawa `closed`); `return_completed` daje tylko zwrot
   całości. Inwentarz liczy więc „returned” jako zamówienia z zamkniętą sprawą zwrotu.
9. **Limity WMS na firmę blokują pełny profil A/C/E.** `WMS_LOT_LIMITS.operations = 100000`
   (`server/wms-lots-schema.ts:12`, sprawdzane w `quota()`, `server/wms-lots.ts:185-199`),
   a jedna sztuka skanu to jedna operacja. Plan pełnego profilu daje na firmę z partiami
   ~235 000 operacji (66 724 `reserve`, 136 741 `scan`, 30 571 `dispatch`, 976 `return`),
   więc generowanie stanie po ~40 % zamówień. Do tego `evidence_bytes` 128 MiB liczone
   sumą `to_jsonb` wszystkich wierszy WMS firmy przy każdej operacji (wynik skanu to pełny
   JSON zamówienia). To decyzja produktowa (limit albo zapis skanu), nie generatora.
   *Rozwiązane 26.10:* limity per plan (fd7f783, enterprise 10 mln operacji / 64 GiB), writer przełącza
   firmy na `enterprise` (`tools/scale/writer.mjs:60`), licznik dowodów O(1) — migracja 235 (2b8d9da, d66a8ee).
10. **Pula 8 s a walidator PIM na tej instancji.** `pim_dictionary_valid()` trwa na klonie
   7,0–7,7 s (szablon 6,4–7,3 s), także bez libfaketime i bez obciążenia; PG04 w tym samym
   czasie 5,0 s przy load 12. W trybie źródłowym preflight przed `tenantTx` przekracza
   co któryś raz `statement_timeout=8000` puli. Generator ponawia wtedy partię (każdy krok
   jest wznawialny, ponowienia są w raporcie); spakowane wydanie z bramką schematu nie
   wykonuje tych preflightów (bieg w wydaniu 26.10: 0 ponowień, sekcja 11).
11. **Wydanie nie startuje na opublikowanym porcie Dockera.** Zimna walidacja wydania
   (`packing189-catalogue-reader.mjs` `derivePackingColdIdentity`) przyjmuje tylko sesję
   właściciela, w której `inet_server_addr()` jest pętlą zwrotną, a `inet_server_port()` równa
   się portowi klienta. Przez `127.0.0.1:57090` serwer widzi `192.168.48.2:5432` → odmowa
   `recovery-selected-database`. Generator (i tak samo mierzone wydanie) działa więc w kontenerze
   Node we wspólnej przestrzeni sieciowej kontenera PG (`scale-pg.sh netns-node`, `127.0.0.1:5432`).
12. **Limit 96 MiB pakietu.** `tools/build/emitted-release.mjs:20` (i kopia w `shared/…`) odrzuca
   pakiet powyżej 100 663 296 B. `74d3f95`: 100 670 178 B z wciętym JSON kontraktu (N29), 100 641 612 B
   po zapisie bez wcięć (zapas 21 684 B). `2b8d9da` (migracja 235): 100 666 753 B, czyli 3 457 B za
   dużo także bez wcięć — pakiet z HEAD z 235 dziś się nie buduje. Wymaga decyzji (podniesienie
   limitu albo oszczędność bajtów, np. aliasy `resource-format210`).
   *Rozwiązane 27.10:* limit podniesiony do 128 MiB (7720aa1); wydanie z HEAD `7720aa1` (z 235) ma
   100 667 577 B, startuje (fabryka 126,6 s, pusty `tenantTx` mediana 4,9 ms).

## 8. Zapis wyników

- Katalog biegu: `docs/scale/results/<YYYYMMDD-HHMM>-<release-sha12>/` (pliki 0600,
  katalogi 0700, bez DSN, haseł, ciasteczek i tokenów).
- `run-manifest.json` **przed** startem: wszystkie pola z
  `binding_and_evidence.required_run_manifest_before_execution`, ten manifest
  (SHA256 pliku), skrót profilu, skrót planu generatora i raport generatora.
- `generate-report.json` (z `tools/scale/generate.mjs --report`), `pg_settings`
  przed/po, inwentarz danych przed rozgrzewką i po fazach.
- Zwarty ledger intencji/efektów (ndjson), histogramy (≤1 ms poniżej 1 s, ≤10 ms
  poniżej 10 s), próbki zasobów co 1 s, raporty z `required_reports`, kody wyjścia
  i skróty wszystkich plików.
- `SUMMARY.md`: tabela progów z sekcji 6 — wartość, próg, wynik — oraz wpis do matrycy
  (`tools/parity/check.mjs`). Wynik dotyczy wyłącznie wydania z sekcji 2.

## 9. Bieg weryfikacyjny generatora 25–26.10.2026 (mała skala)

Klon `dynaminds_scale_20261025_02` z szablonu `dynaminds_restore_36751abef3079f3f`,
prawdziwe `migrate()` (ledger `233_fiscal_receipts`, 223 wpisy), PG04 127.0.0.1:57084,
`DYNA_LOCAL_CONFIG_PATH` = konfiguracja testowa. Parametry: `--scale-factor 0.01`
(2 firmy × 500 SKU / 500 zamówień, 180 dni), seed `dyna-scale-20261025`,
`--connections 4 --tx-mode batch --order-batch 25`, tryb źródłowy (bez bramki schematu).
Host współdzielony: średnie obciążenie 14–20 od testów innych agentów na PG04,
więc liczby są górną granicą kosztu, nie pomiarem.

**Przebieg.** Bieg 1 przerwany celowo `kill -9` w połowie partii (A: transakcja
partii w toku, B: wystawianie FV); biegi 2 i 3 wznowiły z checkpointu i zatrzymały się
na `statement timeout` w `preflightPim` (sekcja 7 pkt 7). Stan końcowy: 500/500 SKU
i 300/500 zamówień na firmę (275 w checkpoincie + 25 z niezamkniętej partii).

| Wynik | A | B |
|---|---|---|
| SKU (różne) | 500 (440 prostych, 40 wariantów, 10 grup, 10 zestawów) | 500 (jw.) |
| zamówienia / różne znaczniki | 300 / 300 | 300 / 300 |
| zamówienia w checkpoincie zgodne z planem | 275/275 (15 „returned” jako `shipped` + zwrot `closed`, pkt 8) | 275/275 (11 jw.) |
| lokalne FV (1 na zamówienie) | 104 dok. / 104 zam. | 103 / 103 |
| sprawy zwrotu `closed` / zaplanowane | 17 / 17 | 13 / 13 |
| wpłaty / zwroty płatności | 216 / 12 (po biegu 2) | 221 / 16 (po biegu 2) |
| ujemne stany / gorące SKU na 20 szt. | 0 / 50 z 50 | 0 / 50 z 50 |
| magazyny / lokalizacje | 2 / 40 | 2 / 40 |

Strażnicy: wszystkie 10 `true` przed każdym biegiem i po każdym (także po `kill -9`).
Wznowienie nie utworzyło żadnego duplikatu (zamówienia B z przerwanej partii znalezione
po znaczniku, FV i zwroty po deterministycznych `client_key`).

**Przepustowość (bieg 2, 3628 s bez przerw, 2 tory):** 450 zamówień, 2267 kroków,
2847 skanów, 154 FV, 27 zwrotów; 0,124 zamówienia/s łącznie, 0,62 kroku/s,
25 693 wiersze wstawione (7 wierszy/s według `pg_stat_database`), 5515 commitów.
Produkty: 0,125 s/SKU w partiach po 100 (z tego ~11 s stałego kosztu partii).
Pusta `tenantTx` 11,2–13,1 s. Zamówienie: 14,7–16,2 s na tor, z czego ~53 % to
preflight transakcji (346 transakcji × ~11,2 s z 3628 s × 2 tory).
Baza: 125,8 MB szablon → 149,6 MB.

**Ekstrapolacja do pełnego profilu** (5 × 20 000 SKU + 20 000 zamówień, koszt rekordu
stały, bez wzrostu z rozmiarem tabel, przy tym obciążeniu hosta):

| Tryb | Na tor firmy | 5 torów równolegle | 4 połączenia (2 fale) |
|---|---|---|---|
| źródłowy (zmierzony) | ~86 h | ~86 h | ~173 h |
| bez preflightu transakcji (runtime wydania) | ~24 h | ~24 h | ~49 h |

Wniosek: pełne generowanie w trybie źródłowym nie jest wykonalne; wymaga runtime
spakowanego wydania na osobnej instancji PG, a nawet wtedy ~1 doba przy 5 torach.
Kolejne skrócenie (więcej torów w firmie, równoległe FV) to decyzja przed etapem 5.
Surowe pliki: raporty `dynaminds_scale_20261025_02.report.json` (bieg 3) i
`run02-b.report.json` (bieg 2) oraz checkpoint w katalogu roboczym sesji (scratchpad).

## 10. Instancja Docker, symulowane dni i bieg próbny 26.10.2026

### Definicja instancji

| Pole | Wartość |
|---|---|
| pliki | `tools/scale/docker/` (`Dockerfile`, `compose.yml`, `postgresql.scale.conf`, `initdb/10-scale.sh`, `postgres-faketime.sh`, `scale-pg.sh`, `compare-template.mjs`, `README.md`) |
| obraz | `dyna-scale-pg18-faketime:18.4` z `postgres:18.4-trixie@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636` + pakiet Debian `libfaketime`; `version()` = `PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1) on aarch64-unknown-linux-gnu` |
| kontener / port | `dyna-scale-pg18`, `127.0.0.1:57090` (4100/5432/57084 odrzucane przez skrypt) |
| dane | wolumen `dyna-scale-pg18-data`, archiwum WAL `dyna-scale-pg18-wal-archive` (`archive_command` = `cp` do `/wal-archive`) |
| ustawienia | sekcja 3, plik `postgresql.scale.conf` dołączony do `postgresql.conf` przy pierwszym starcie; `initdb --locale=C.UTF-8 --encoding=UTF8` (jak szablon na PG04) |
| healthcheck | `pg_isready -h 127.0.0.1 -p 5432 -U postgres -d postgres` co 5 s |
| stan lokalny | `data/scale/pg18-docker/` (poza gitem, 0700): hasło instancji, `local-config.json` (klucz szyfrowania szablonu + hasło instancji), plik przesunięcia zegara, zrzut szablonu |
| maszyna wirtualna | Docker Desktop 29.8.2, 18 vCPU, 32 GiB (`docker info`); `shared_buffers=16GB` to połowa pamięci VM, `effective_cache_size=64GB` opisuje hosta, nie VM |

### Szablon i klon

Szablon PG04 `dynaminds_restore_36751abef3079f3f` powstał zwykłą ścieżką odtworzenia aplikacji
(`server/recovery.ts`, katalog `local-builds/full-base-preview-20261017/n23-backup-restore-prepared-agent-20261019-01/restore/36751abef3079f3f`,
ledger `217_crm_field_definitions`, 207 wpisów). Na instancję Docker trafia przez `pg_dump -Fc`
(klient 18.4, migawka REPEATABLE READ, tylko odczyt na PG04) i `pg_restore`:

- zrzut 38 472 055 B, SHA256 `cd78a10824d149f88ca1f7a563282af44b5cc7eb91f10917664f8e5cc6e806fd`, 3 s; odtworzenie 12 s;
- porównanie z PG04: 646 tabel, 32 412 wierszy, każda tabela z tą samą liczbą wierszy; 1639 funkcji,
  1579 triggerów, 3 triggery zdarzeń, 719 polityk, 2171 indeksów; skróty ACL relacji, funkcji,
  schematów, typów i domyślnych ACL identyczne po `GRANT ALL … TO postgres` na 234 obiektach, których
  ACL na PG04 jest zmaterializowanym domyślnym ACL właściciela (`pg_dump` go pomija);
- rola klastra `dyna_app NOLOGIN` tworzona przy pierwszym starcie.

Klon: `CREATE DATABASE dynaminds_scale_YYYYMMDD_NN TEMPLATE dynaminds_restore_36751abef3079f3f`,
prawdziwe `migrate()` (0,3–0,4 s; ledger `233_fiscal_receipts`, 223 wpisy), 10 strażników `true`.

### Zegar: libfaketime

- `/usr/lib/postgresql/18/bin/postgres` to opakowanie ładujące `libfaketime.so.1` tylko do serwera
  (z preloadem w skrypcie startowym `gosu` się zawiesza i kontener nie startuje).
- Przesunięcie względne w sekundach w pliku `/faketime/faketime.rc` (montowany katalog stanu),
  `FAKETIME_CACHE_DURATION=1` (każdy proces czyta plik najwyżej raz na sekundę),
  `FAKETIME_DONT_FAKE_MONOTONIC=1` (zegary monotoniczne prawdziwe). Zmiana działa bez restartu,
  dla istniejących połączeń puli i nowych sesji; sprawdzone w obie strony
  (`now()` = `clock_timestamp()` = `DEFAULT now()` = `2026-04-28 06:00:02` przy `-15617414`, potem `+0`).
- Generator (`--simulate-days`, `tools/scale/simclock.mjs`) zapisuje to samo przesunięcie do pliku
  i do `Date` swojego procesu, zmienia dzień tylko na barierze wszystkich torów (PostgreSQL liczy
  `statement_timeout` od zegara ściennego) i sprawdza świeżą sesją, że baza podąża
  (tolerancja 5 s). Katalog, otwarcie WMS i PZ: dzień przed oknem, 06:00 UTC; zamówienia dnia k:
  dzień k, 06:00 UTC + czas zapisu. Na końcu `+0`. Jeden symulujący generator na instancję
  (blokada `faketime.rc.lock`).
- Narzut libfaketime: `pim_dictionary_valid()` na tym samym odtworzonym szablonie 7,0–7,4 s
  z preloadem i bez. Na pomiar i tak `SCALE_FAKETIME=off` (kontener bez preloadu).
- Skutki uboczne: przy zegarze w przeszłości checkpointy czasowe czekają (te od rozmiaru WAL
  działają), harmonogram autovacuum jest przesunięty; po generowaniu `VACUUM (ANALYZE)`.
  Wiersze szablonu mają prawdziwe daty z października 2026.

### Odtworzenie

```sh
cd development/full-base
tools/scale/docker/scale-pg.sh up
tools/scale/docker/scale-pg.sh dump-template
tools/scale/docker/scale-pg.sh restore-template
tools/scale/docker/scale-pg.sh clone dynaminds_scale_20261026_02
eval "$(tools/scale/docker/scale-pg.sh env dynaminds_scale_20261026_02)"
node node_modules/tsx/dist/cli.mjs tools/scale/generate.mjs --scale-factor 0.005 --days 2 --simulate-days \
  --connections 4 --tx-mode batch --order-batch 25 \
  --checkpoint data/scale/runs/smoke02.checkpoint.json --report data/scale/runs/smoke02.report.json
tools/scale/docker/scale-pg.sh status
```

### Bieg próbny 26.10.2026 (`--scale-factor 0.005 --days 2`, tryb źródłowy)

Baza `dynaminds_scale_20261026_02` (świeży klon), plan `e75538e7…5262` (2 firmy × 250 SKU /
250 zamówień, okno 23–24.10.2026), seed `dyna-scale-20261025`, `--connections 4 --tx-mode batch
--order-batch 25`, generator `3d25907` (bieg 1) i `8d8f82d` (bieg 2, wznowienie z checkpointu).
Host współdzielony (load 12–22 od testów innych agentów).

**Przebieg.** Bieg 1 (1411 s) zapisał katalog, otwarcie WMS i PZ, pierwsze 25 zamówień obu firm
i zatrzymał się na przyjęciu drugiego zwrotu A w tej samej transakcji partii:
`receiveReturn` kończy się `SET CONSTRAINTS ALL IMMEDIATE` (`server/returns.ts:665`), więc kolejny
zwrot WMS w tej samej transakcji trafiał na natychmiastowy trigger spójności WMS. Poprawka
w generatorze (`8d8f82d`): zwroty firm z partiami po jednym na transakcję, jak w trasie.
Bieg 2 (5271 s) dokończył oba dni bez błędu. Wznowienie nie utworzyło duplikatów (na firmę 250 zamówień
= 250 różnych znaczników, 0 zamówień z dwiema FV, 0 powtórzonych SKU; 0 ujemnych stanów).
Ponowienia po `statement timeout` preflightu PIM (`server/pim-dictionaries/runtime.ts:16`):
18 w biegu 1, 20 w biegu 2 (sekcja 7 pkt 10).

| Wynik | A (partie WMS) | B |
|---|---|---|
| SKU | 250 (216 prostych, 24 warianty, 6 grup, 4 zestawy) | 250 (jw.) |
| zamówienia: `created_at` najstarsze / najnowsze / różne dni | 250: 2026-10-23 06:00 / 2026-10-24 06:38 / 2 | 250: 2026-10-23 06:00 / 2026-10-24 06:39 / 2 |
| zamówienia na dzień (plan = zapis) | 125 / 125 | 125 / 125 |
| zdarzenia zamówień, wpłaty, FV, sprawy zwrotu — różne dni | 2785, 241, 88, 17 — po 2 dni (23–24.10) | 3001, 229, 92, 13 — po 2 dni |
| ruchy magazynowe | 1021, 3 dni (22.10 katalog + 23–24.10) | 635, 3 dni |
| statusy | new 19, paid 43, picking 39, packed 29, shipped 105, cancelled 13, return_completed 2 | new 27, paid 36, picking 34, packed 27, shipped 115, cancelled 10, return_completed 1 |
| sprawy zwrotu `closed` / zwroty płatności | 17 / 17 | 13 / 13 |
| linie zestawów (zamówienia) | 22 (22) | 12 (12) |
| polityka WMS | włączona, wersja 1, PLN; otwarcie 11 lokalizacji (koszt nieznany 11) | wyłączona |
| partie | 11 `opening`, 433 `receipt` (116 z datą ważności); 2 dokumenty PZ (`PZ/2026/…`, 22.10) | — |
| warstwy kosztu | znany 413 (7692 szt.), zerowy 20 (389 szt.), nieznany 11 (448 szt.) | — |
| operacje WMS | opening 1, receipt 2, reserve 828, scan 1588, dispatch 329, return 17 | — |
| FIFO (powtórka rezerwacji w kolejności planu, `tools/scale/inspect.mjs` `wmsCounts`) | 844 rezerwacje warstw, 3122 szt., 29 z młodszej partii, **0 naruszeń** | — |

Strażnicy: wszystkie 10 `true` przed i po każdym biegu (`checkGuards`, także po przerwanym biegu 1).
Zegar po biegu: plik `+0`, `now()` = czas hosta. W tym małym planie wszystkie otwarcia A wylosowały
koszt nieznany (11/11); w pełnym planie A to 638 z 917 (69,6 %), więc przypadek „otwarcie ze znanym
kosztem” sprawdzi dopiero większy bieg.

**Czasy (tor firmy).** Pusta `tenantTx` 14,5–14,6 s (preflighty trybu źródłowego; PG04 11–13 s).
Katalog 59–60 s na 250 SKU (3 partie), otwarcie WMS + 2 PZ (433 linie) 146 s, zamówienia
5579–5776 s na 250 (≈22–23 s na zamówienie), dzień 0 2224 s, dzień 1 2985 s (bieg 2). A miała 242,
B 218 transakcji `tenantTx`. Ekstrapolacja z raportu (255 h w trybie źródłowym) nie jest miarą:
koszt rekordu jest tu zdominowany preflightem i ponowieniami, a w spakowanym wydaniu preflightów nie ma.
Raport i checkpoint: `data/scale/runs/smoke02.report.json`, `smoke02.checkpoint.json`, logi
`smoke02.log` (bieg 1) i `smoke02b.log` (bieg 2); wcześniejszy bieg kontrolny 2 × 100 SKU / 2 × 10
zamówień na `dynaminds_scale_20261026_01` (`debug01.*`) dał ten sam obraz (FIFO 0 naruszeń, strażnicy `true`).

### Otwarte przed pełnym biegiem

1. ~~Limit 100 000 operacji WMS na firmę~~ — rozwiązane 26.10 (sekcja 7 pkt 9).
2. ~~Generator w spakowanym wydaniu~~ — zrobione 26.10 (sekcja 11); pakiet z HEAD z migracją 235
   blokował limit 96 MiB — podniesiony do 128 MiB 27.10 (sekcja 7 pkt 12).
3. Pamięć VM Docker 32 GiB przy `shared_buffers=16GB`; próg RSS ≤12 GiB z sekcji 6 a 16 GB
   `shared_buffers` po rozgrzaniu — do rozstrzygnięcia przed pomiarem.
4. Walidatory PIM/ordinary187 na instancji Docker 7,0–7,7 s przy 5,0 s na PG04 w tym samym
   czasie (proste zapytania CPU równe: `generate_series` 603 vs 663 ms, `sha256` 764 vs 765 ms) —
   koszt wirtualizacji przy zapytaniach katalogowych; wpływa na porównywalność pomiaru z PG04.

## 11. Generator w spakowanym wydaniu, bieg próbny 26.10.2026

### Pakiet

`node tools/scale/release-build.mjs --out <katalog>` (tylko pliki): wycinek `git archive` commita,
kontrakt źródeł N29 (`548e3429…0cc06`, migracje do 225) + każdy późniejszy wiersz `RELEASE_MIGRATIONS`
(krawędź Native i para zimnego katalogu jako runtime-source), `vite build`, emiter
`tools/build/local-package.mjs` z tego samego wycinka. Wynik dla `74d3f95`:

| Pole | Wartość |
|---|---|
| katalog | `local-builds/full-base-preview-20261017/scale-release-20261026-01/release-canonical` |
| commit | `74d3f9507292f86ff1e2c76d3c8a652a99d135bb` |
| `release.json` (manifest wydania) | `bc9901a9e95b3637255bd609e125f3495827125dfce8c737aa66c3aeb4305b9f` |
| drzewo pakietu (sha256 posortowanej listy `sha256  ścieżka`) | `a6ea5448e663cf48761e1455209621b6100aa4b14b6bc04ff329919eedbb1843`, 417 plików, 100 641 612 B |
| kontrakt źródeł | `2151d00c…f108`, wersja `1.0.0-full-base-scale-74d3f9507292.234`, 52 krawędzie Native (dodane 226–234) |
| metafile esbuild | `21514a76…aee0` (obok pakietu; generator szuka w nim chunków modułów) |
| ostatnia migracja / ledger | `234_carriers`, 224 wpisy |
| czas budowy | 5 s (archiwum 0,6, kontrakt 0,2, vite 0,5, emisja 3,6) |

### Bieg

Generator (`generate.mjs --release`, `tools/scale/release-runtime.mjs`) tworzy aplikację fabryką
wydania (`createOrdinaryLocalApplication`: `migrate()` 25 ms, zimna walidacja 113 s, razem 140 s)
i woła funkcje domenowe z chunków wydania (ten sam egzemplarz modułu co fabryka, więc `tenantTx`
za zainstalowaną bramką). Kontener `node:22.23.0-trixie-slim@sha256:cfd8f2a5…db82` w przestrzeni
sieciowej `dyna-scale-pg18` (sekcja 7 pkt 11).

```sh
tools/scale/docker/scale-pg.sh clone dynaminds_scale_20261026_04
tools/scale/docker/scale-pg.sh netns-node dynaminds_scale_20261026_04 tools/scale/generate.mjs \
  --scale-factor 0.005 --days 2 --simulate-days --connections 4 --tx-mode batch --order-batch 25 \
  --release <katalog>/release-build.json --checkpoint data/scale/runs/rel04.checkpoint.json --report data/scale/runs/rel04b.report.json
tools/scale/docker/scale-pg.sh netns-kill    # bieg 1 przerwany tak po 262 s (A 50/250, B 25/250 zamówień)
```

Baza `dynaminds_scale_20261026_04` (świeży klon, ledger 234), plan `e75538e7…5262`, seed
`dyna-scale-20261025`, generator `164ee06`. Host: load 4–6.

| Wynik | A (partie WMS) | B |
|---|---|---|
| przebieg | bieg 1: katalog, otwarcie WMS, 2 PZ, 50 zamówień, `kill -9` (exit 137) w partii 51–75; bieg 2 wznowił, 1628 s, exit 0 | bieg 1: 25 zamówień, `kill -9` w partii 26–50 |
| po `kill -9` | baza = checkpoint (50 zamówień), partia w toku wycofana | 25 = checkpoint |
| SKU (różne) | 250 (250) | 250 (250) |
| zamówienia / różne znaczniki / dzień 23.10 / 24.10 | 250 / 250 / 125 / 125 | 250 / 250 / 125 / 125 |
| zamówienia z dwoma dokumentami tego samego rodzaju | 0 | 0 |
| statusy | identyczne z biegiem źródłowym z sekcji 10 (new 19, paid 43, picking 39, packed 29, shipped 105, cancelled 13, return_completed 2) | identyczne (new 27, paid 36, picking 34, packed 27, shipped 115, cancelled 10, return_completed 1) |
| zdarzenia, wpłaty, FV, sprawy zwrotu `closed` | 2785, 241, 88, 17 (jak w sekcji 10) | 3001, 229, 92, 13 (jak w sekcji 10) |
| operacje WMS / FIFO | reserve 828, scan 1588, dispatch 329, return 17; FIFO 844 rezerwacji, **0 naruszeń** | — |
| ujemne stany | 0 | 0 |
| ponowienia po `statement timeout` | 0 | 0 |

Strażnicy: 10/10 `true` przed biegiem 1, przed biegiem 2 (po `kill -9`) i po biegu 2. Zegar po biegu `+0`.
Blokada zegara po `kill -9` (ten sam pid w nowym kontenerze) uznana za porzuconą (`simclock.mjs`).

### Koszt transakcji: wydanie a tryb źródłowy

`tools/scale/tx-probe.mjs` na tym samym klonie (`dynaminds_scale_20261026_03`), treść `SELECT 1`:

| | pusta `tenantTx` | `SELECT 1` puli |
|---|---|---|
| wydanie (kontener, pętla zwrotna) | min 4,2 / mediana 5,0 / max 16,3 ms (10 prób) | 0,1 ms |
| tryb źródłowy (host, port 57090) | min 12 150 / mediana 12 498 / max 12 604 ms (5 prób) | 0,4 ms |

Różnica ścieżki sieciowej to 0,3 ms na zapytanie; pozostałe ~12,5 s to preflight schematu.

| Na tor firmy | tryb źródłowy (sekcja 10) | wydanie |
|---|---|---|
| katalog 250 SKU | 59–60 s | 2,9–3,1 s (0,012 s/SKU) |
| otwarcie WMS + 2 PZ (433 linie) | 146 s | 8,6 s |
| zamówienie (z krokami, skanami, FV, zwrotami) | 22–23 s | 7,36–7,45 s |
| transakcje / ms na transakcję | 242 / ~23 000 | 212 / 8 800 (1865 s toru / 212) |

Zamówienie w wydaniu kosztuje nadal ~7,4 s, bo pracę robią ścieżki produktu: próbkowanie
`pg_stat_activity` co 0,4 s (100 próbek × 2 tory) dało `buyer_address_available()` w 70 % próbek
(0,3–0,5 s na wywołanie: liczy pełne `buyer_address_guards()`, `server/166_buyer_address_sidecar.sql:315`;
wołana w funkcjach adresu kupującego, tamże `:407`, `:436`, `:489`, i w `server/buyer-address.ts:248`),
`warehouse_wz_issuer_prepare` 18 %, suma `to_jsonb` dowodów WMS 4,5 %. Czas partii 25 zamówień
125–297 s bez wyraźnego wzrostu w tym zakresie (zależy od statusów w partii).

### Szacunek pełnego zbioru (5 × 20 000 SKU + 20 000 zamówień)

Koszt rekordu jak w tym biegu: tor = 20 000 × 7,41 s + 20 000 × 0,012 s ≈ **41 h**.
`--connections 5` (pięć torów naraz, zmierzone tylko 2) ≈ **41 h** zegara; `--connections 4`
(dwie fale) ≈ 82 h (`extrapolation_full_profile` w `rel04b.report.json`). Zastępuje szacunek
~24 h z sekcji 9. Niewliczone: wzrost kosztu z rozmiarem tabel (niezmierzony powyżej 250 zamówień),
współbieżność 5 torów na jednej instancji, limit operacji WMS A/C/E (sekcja 7 pkt 9; plan stanie po
~40 % zamówień), 140 s startu fabryki przy każdym wznowieniu. Największa dźwignia skrócenia to
koszt `buyer_address_available()` na zapis zamówienia.

Pliki (poza gitem): `data/scale/runs/rel04a.log`, `rel04b.log`, `rel04b.report.json`,
`rel04.checkpoint.json`; budowa: `<katalog>/release-build.json`, `release-canonical.sha256`,
`emit.log`, `vite.log`.

## 12. Test obciążenia: sterownik i bieg próbny 27.10.2026

Sterownik `tools/scale/load/` (`README.md` tamże, testy `tests/scale-load.test.mjs`). Wszystkie procesy w przestrzeni
sieciowej `dyna-scale-pg18` (sekcja 7 pkt 11; CLI wydania słucha tylko na `127.0.0.1`): `dyna-load-app` (CLI wydania
`4101 --scoped-automation`), `dyna-load-worker-N` (kolejne CLI z workerem, bez ruchu), klient = kontener z adresem
źródłowym `127.0.0.(11+N)` — osobny kubełek limitu 600/min na adres (sekcja 7 pkt 2, decyzja 26.10). Ścieżka
`order_create` to `POST /api/orders` (powiązania nie mają `addOrder` Base API), więc limit 100/min Base API (pkt 3) nie
dotyczy tego sterownika. Raport: `run.json` + `SUMMARY.md` + `raw/`; sekrety w `<out>/private`, usuwane po biegu.

```sh
# wydanie z commita, zbiór, kopia bazy na bieg (bieg zapisuje do bazy)
node tools/scale/release-build.mjs --out <dir> --base-contract <N29 source-contract> --base-contract-sha 548e3429…0cc06
tools/scale/docker/scale-pg.sh psql postgres -c "CREATE DATABASE dynaminds_scale_YYYYMMDD_MM TEMPLATE dynaminds_scale_YYYYMMDD_NN"
# pełny profil (sekcja 5): 600 s rozgrzewki, 2 × 1800 s, 2 procesy workerów
SCALE_PG_STATE=<full-base>/data/scale/pg18-docker node tools/scale/load/run.mjs --release <dir>/release-build.json \
  --db dynaminds_scale_YYYYMMDD_MM --tag <plan tag> --out docs/scale/results/<YYYYMMDD-HHMM>-<sha12> \
  --warmup 600 --phases steady12:12:1800,steady24:24:1800 --workers 2
# bieg próbny 27.10 (zbiór 1 %, 5 firm): --warmup 60 --phases steady12:12:300,steady24:24:300
# limit per adres inny niż domyślne 600 (od 29.10, sekcja 7 pkt 2): --rate-limit-per-min <60…100000>
```

Limit na adres w biegu (od 29.10):
- `--rate-limit-per-min` trafia do `app.env` jako `DYNA_RATE_LIMIT_PER_MIN`.
- `run.json` → `rate_limit` zapisuje wartość zgłoszoną w `/api/health` każdego CLI wydania:
  `per_address_per_minute`, `window_seconds`, `source` (`default` / `env` / `release-fixed`), `requested`, `reported_by_release`.
- Ta sama wartość jest w nagłówku `SUMMARY.md`.
- Niezgodność przerywa bieg przed rozgrzewką.
- Wynik biegu dotyczy tej wartości. Biegi z różnymi limitami nie są porównywalne wprost.

Bieg próbny: `docs/scale/LOAD-TEST-DRYRUN-20261027.md` (wydanie `f9b3811`, zbiór `--tenants 5 --scale-factor 0.01`,
plan `d3fe708c…179c`). steady12 6,26 RPS sukcesu (próg 10), steady24 6,24 RPS (próg 20), zapisy p95 5,4–6,0 s, 12 × 500 i
8 timeoutów z `statement_timeout` na blokadzie `wms.operations:<firma>`, najstarsze zadanie workera p95 34 / 62 s
(próg 15 s), zimny start każdej fabryki 206–245 s (próg 180 s). Wąskie gardła z dowodami w sekcji 4 tamtego dokumentu.

### Wierność profilu (28.10, `LOAD-TEST-DRYRUN-20261027.md` sekcja 9)

- **Stan niesie zbiór.** Mieszanka nie ma przyjęć PZ, a profil nie dopuszcza dodatkowych klientów sterownika ani
  niemierzonych pętli, więc sterownik niczego nie uzupełnia. Bieg potrzebuje sprzedawalnego stanu na MAIN na całą
  długość: zmierzone zużycie ~570 szt./min na firmę przy 12 klientach i ~660–790 przy 24 (HEAD `1f35306`), czyli
  ~46,5 tys. szt. na firmę dla 600 s + 2 × 1 800 s. Stan rośnie z liczbą SKU (popyt historii + bufor 5–40 szt.),
  nie zamówień, a zamówienie kosztuje w generatorze 1,2–3,4 s na tor; zbiór testu obciążenia to więc
  `--tenants 5 --skus <N> --orders 4000` (800 zamówień na firmę), generowany na osobnej instancji
  `dyna-scale-pg18-gen` (własny zegar libfaketime) i przenoszony `pg_dump`/`pg_restore` z `--apply-owner-acl`
  (kroki: `LOAD-TEST-DRYRUN` sekcja 9). Raport pokazuje stan na firmę co 15 s, zużycie/min, zapas w minutach i
  polecenia pominięte z braku stanu (wymagane 0).
- **Zbiory:** `dynaminds_scale_20261028_61` (`--skus 20000`, plan `1d1eae6f…903f`, 4 000 SKU / 800 zamówień na firmę,
  485 MB, 47,6–48,5 tys. szt. użytecznych na firmę, wygenerowany w 1 h 22 min) — zbiór biegu walidacyjnego, za mały
  na pełny profil; `dynaminds_scale_20261028_71` (`--skus 40000`, 8 000 SKU / 800 zamówień na firmę) — zbiór pełnego
  biegu: plan `a370c1c2…82e2`, 596 MB, 6 144 SKU na MAIN i 95,98–96,65 tys. szt. użytecznych na firmę (~2× potrzeby),
  wygenerowany w 1 h 56 min (zamówienie 3,7–4,5 s A/C/E, 1,0 s B/D); próba 120 s × 24 na kopii (`fid71-smoke`):
  35,17 RPS, 0 błędów, 0 pominiętych, 2 oczekiwane odmowy (po jednej z każdego wyścigu, brak skutku potwierdzony).
- **Oczekiwane odmowy.** Jedyne oznaczone wyścigi (`tools/scale/load/lib.mjs` `EXPECTED_RACES`): 409 „Zapas zwrotu
  zmienił wersję. Odczytaj ponownie cały zakres” (`return_receive`) i 409 „Stan lub rezerwacja zmieniły wersję”
  (`stock_operation`) — wersja wiersza stanu, którą podbija rezerwacja tego produktu przez innego klienta. Liczone
  osobno (poza RPS sukcesu i percentylami), ≤ 1 % żądań fazy, bez ponawiania, z odczytem zwrotnym braku skutku;
  każdy inny 409 to błąd z przyczyną (`stock_shortage`, `order_version`, `policy_version`, `version_other`, `other`).
- **Mieszanka.** Raport porównuje udział wysłanych operacji i zapisów z profilem w fazie i w każdym 60-s kubełku
  (tolerancja 2 pp). Bieg walidacyjny `fid61-02` (5 min × 12 + 5 min × 24 na kopii `_61`): 0 poleceń pominiętych
  z braku stanu, udział zapisów 37,6–38,3 % w każdym kubełku (profil 40 %; różnica = `stock_operation` B/D bez
  wariantu w powiązaniach, 2 % zadań), 0 błędów, 2 oczekiwane odmowy (0,02 %, brak skutku potwierdzony), wszystkie
  progi operacji spełnione (odczyty p95/p99 steady24 351/519 ms, zapisy 2 480/2 690 ms), 30,46 RPS steady24.
- **Odczyty przy 24 klientach** w `l250-head-01` to kolejka CPU bazy pod zapisami, nie sterownik (jedno żądanie
  w locie, jedno gniazdo, treść po pierwszym bajcie ≤ 2,6 ms, pętla zdarzeń klientów p99 ≤ 14 ms; dowody tamże).

### Otwarte przed pełnym biegiem

1. Wąskie gardła produktu z biegu próbnego (blokada `wms.operations`, strażnicy w transakcji zapisu, pieczęć
   instalacji na każdą transakcję RW, zimny start) — decyzja przed 41-godzinnym generowaniem.
2. Tło profilu (import z lokalnego WooCommerce, synchronizacja stanów, ≥ 2 instancje WooCommerce), wyścig o gorące
   SKU, `stock_operation` B/D, pełny zestaw wariantów zwrotu i uzgodnienie po biegu — poza sterownikiem.
3. Zasoby z sekcji 6 mierzone tylko częściowo (`docker stats` co ~15 s, load hosta); pętla zdarzeń, czekanie na pulę
   i licznik in-flight serwera — niemierzone.
4. Spadek RPS sukcesu w każdej fazie walidacji 28.10 (steady12 31,6 → 18,9, steady24 37,8 → 26,1 w 5 min) bez braku
   stanu i bez błędów — przyczyna niezbadana; w 30 min może zejść poniżej progów 10 / 20 RPS.
5. `GET /api/orders/:id` własnych świeżych zamówień w przygotowaniu: p95 2,2–3,1 s, pojedyncze 10-s timeouty (odmowy
   przygotowania `return_receive`), przy p95 ≤ 53 ms dla zamówień zbioru w `order_detail` — niezbadane.
6. Wyścig o gorące SKU (połowa `stock_operation` na gorących SKU, profil) — sterownik go nie celuje, więc nie jest
   jeszcze oznaczonym wyścigiem; `stock_shortage` pozostaje błędem.

