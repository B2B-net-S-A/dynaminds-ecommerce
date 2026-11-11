# Pełny zbiór danych etapu 5 — generowanie od 29.10.2026

Pełny profil `docs/parity/acceptance-profile.v1.json` (`config_sha256` `1ab65a92…b8a7`): 5 firm × 20 000 SKU
+ 20 000 zamówień, 180 dni historii (`docs/FULL-BASE-GOAL.md` warunek 10, `HANDOFF-GOAL-V2-20261028.md` pkt 3).
Generowany na spakowanym wydaniu, na osobnej instancji, bo `--simulate-days` przesuwa zegar libfaketime całej
instancji (manifest sekcja 10). Instancja `dyna-scale-pg18` (test obciążenia, bazy `_41`, `_71`, `_81`),
Main (4100) i PG04 (57084) nie są dotykane.

**Stan 29.10 06:00 UTC: bieg 5 (`full03`, baza `dynaminds_scale_20261029_03`) trwa, odłączony.**
- Wydanie `c718174`, narzędzia z `913b6d5` (worktree `local-builds/scale-tools-913b6d5`).
- Faktury idą ścieżką 230, bo zapieczętowany budżet 157 nie mieści pełnego planu.
- Bieg 4 (`full02`) zatrzymany celowo po 11 dniach.

Szczegóły: sekcje „Biegi 4 i 5” i „Tempo i szacunek”. Blokady biegów 2–3 (otwarcie WMS) są rozwiązane w `6cf61aa`
(limit zależny od planu) i przez `vacuum-loop`.

## Instancja

| Pole | Wartość |
|---|---|
| kontener PG | `dyna-scale-full-pg18`, projekt compose `dyna-scale-full-pg18`, `127.0.0.1:57091` → 5432 |
| obraz | `dyna-scale-pg18-faketime:18.4` (`tools/scale/docker/`, ten sam Dockerfile; id `sha256:9188e555…2b72`), PostgreSQL 18.4 aarch64, libfaketime włączony |
| wolumeny | dane `dyna-scale-full-pg18-data`, archiwum WAL `dyna-scale-full-pg18-wal-archive` (zstd, `archive_timeout 60s`) |
| stan lokalny (poza gitem, 0700) | `development/full-base/data/scale/pg18-full-docker/`: `secrets/postgres.password` (własne hasło instancji), `local-config.json` (klucz szyfrowania szablonu + to hasło), `faketime/faketime.rc` (+ `.lock` w czasie biegu), `dumps/`, `runs/` |
| kontener generatora | `dyna-scale-full-gen`, `node:22.23.0-trixie-slim@sha256:cfd8f2a5…db82`, `--network container:dyna-scale-full-pg18` (wydanie wymaga pętli zwrotnej, manifest sekcja 7 pkt 11), uid/gid użytkownika, workspace `<workspace>` zamontowany pod tą samą ścieżką |
| limity CPU | PG `--cpus 6`, generator `--cpus 2` (razem 8 z 18; hostowi zostaje 10) |
| pamięć | PG `--memory 10g` (bez swapu); `ALTER SYSTEM`: `shared_buffers=3GB`, `maintenance_work_mem=1GB`, `autovacuum_work_mem=512MB` (w `postgresql.auto.conf`; manifest sekcja 3 ma 16 GB, ale VM Dockera ma 31 GiB i `dyna-scale-pg18` też jest uruchomiony). Na pomiar: `ALTER SYSTEM RESET` tych trzech + restart. Generator bez limitu pamięci (~1,7 GiB po starcie) |

Narzędzie: `tools/scale/docker/scale-pg.sh` z `SCALE_PG_CONTAINER` (commit `99009bf`, test
`tests/scale-docker-instance.test.mjs` 4/4, na poprzednim skrypcie 0/4). Projekt compose = nazwa kontenera, więc
`up/stop/down` tej instancji nie dotykają projektu `dyna-scale-pg`; port 57090 jest dla niej odrzucany.

## Wydanie

| Pole | Wartość |
|---|---|
| commit | `90a821da4295a611d0b03c1b965652970338242e` (HEAD `goal/full-base-20261017` 29.10, migracja 254) |
| katalog | `local-builds/full-base-preview-20261017/scale-release-full-20261029-01` (`release-build.json`, `release-canonical/`, `project/` = `git archive` commita) |
| `release.json` | `1bfebbda50e21f3ee81036e6414b93d702ded3a6b7078dbe93f4c11af9954f6e` |
| drzewo pakietu | `080c7fbe5aa705d49616ec8403fc91ee08e34a236930ee4aa5f853dfafffcaf8`, 445 plików, 101 985 589 B |
| kontrakt źródeł | `fe490177…56da`, `1.0.0-full-base-scale-90a821da4295.254`, 72 krawędzie Native, ostatnia `254_carrier_returns` |
| generator | `project/tools/scale/*.mjs` z tego samego commita (niezależny od worktree i od zmian w gałęzi) |

**To nie jest wydanie końcowe.** Manifest (sekcja 2) wymaga jednego niezmiennego wydania dla pomiaru. Zbiór
zostanie podniesiony do wydania końcowego jego własnym `migrate()` (N → N+1, ledger 254 → ostatnia migracja
wydania końcowego), tak jak każdy klon szablonu jest podnoszony z 217. Dane historyczne (zamówienia, ruchy,
dokumenty) zapisały ścieżki wydania `90a821d`; to akceptujemy i wpisujemy do manifestu przy zamrożeniu.

Wydanie biegów 4 i 5 (zastępuje `90a821d` z biegów 1–3):

| Pole | Wartość |
|---|---|
| commit | `c71817420b89c1b3b306d693d79e30dbff34ccc8` (`fcc7b89` z migracjami do 258 + `c718174` limit pliku pakietu 32 MiB) |
| katalog | `local-builds/full-base-preview-20261017/scale-release-full-20261029-02` |
| `release.json` / drzewo | `b0b0a5a3dc22d9cedffa4a4c4f4b4c03c6f6570fdda805956bf7f4265cad345a` / `17e0b06540fa1226138b73951ab09feb08617be5c64c5193533f4d3716b39cc9`, 449 plików |
| kontrakt źródeł | `1.0.0-full-base-scale-c71817420b89.258`, ostatnia `258_wz_issuer_refresh`, ledger 248 |
| generator | bieg 4: `project/tools/scale/*.mjs` wydania (= `c718174`). Bieg 5: **`913b6d5`** (faktury 230), z worktree `local-builds/scale-tools-913b6d5` (`git worktree add --detach … 913b6d5`), żeby wznowienie nie wzięło późniejszych zmian gałęzi. Pakiet wydania ten sam |

## Szablon i klon

- Zrzut szablonu `dynaminds_restore_36751abef3079f3f.dump` skopiowany z `data/scale/pg18-docker/dumps/`
  (SHA256 `cd78a108…e806fd`, jak w manifeście sekcja 10), `pg_restore --exit-on-error` 8,8 s, `VACUUM (ANALYZE)`;
  646 tabel, ledger `217_crm_field_definitions`, 207 wpisów.
- ACL właściciela: pg_dump pomija ACL równe domyślnemu. Zamiast porównania z PG04 (`compare-template.mjs`)
  źródłem był manifest kopii zapasowej aplikacji, z której powstał szablon
  (`…/n23-backup-restore-prepared-agent-20261019-01/restore/36751abef3079f3f/manifest.json`,
  `relation_acl_snapshot` 646 + `private_acl_snapshot` 3 — te same dane, które `server/recovery.ts` odtworzył w szablonie
  na PG04). `GRANT ALL … TO postgres` na **234** obiektach (tyle samo co przy porównaniu z PG04 26.10); ponowny przebieg:
  0 do zmiany, 0 innych różnic z 649 wpisów. Bez tego kroku strażnik 209 odmawiał (55000 „209 complete source
  installation required”).
- Klon `dynaminds_scale_20261029_01`: `scale-pg.sh clone` → `migrate()` 670 ms, ledger `254_carrier_returns`,
  244 wpisy, **10 strażników `true`**.

## Bieg

Plan `dyna-scale-plan/v2`, seed `dyna-scale-20261025`, tag `5076fb8f`, **sha256
`ca7c640f0c9761fe0ce79197da92cbc276c229219d5ce11ccd173f869496ae37`** (5 × 20 000 / 20 000, 180 dni, okno
28.04–24.10.2026, katalog 27.04).

```sh
cd <checkout z 99009bf>   # 29.10: worktree-agent-ac4073f6478a7d275; SCALE_WORKSPACE wymagane z worktree
export SCALE_PG_CONTAINER=dyna-scale-full-pg18 SCALE_PG_PORT=57091 \
  SCALE_PG_STATE="<workspace>/development/full-base/data/scale/pg18-full-docker" \
  SCALE_WORKSPACE="<workspace>"
REL="<workspace>/local-builds/full-base-preview-20261017/scale-release-full-20261029-01"
RUNS="$SCALE_PG_STATE/runs"
# instancja (jednorazowo, 29.10 00:47 UTC)
SCALE_RESTORE_CONFIG="<workspace>/local-builds/full-base-preview-20261017/n23-backup-restore-prepared-agent-20261019-01/restore/36751abef3079f3f/local-config.json" \
  SCALE_PG_CPUS=6 SCALE_PG_MEMORY=10g tools/scale/docker/scale-pg.sh up
# … pg_restore szablonu, ACL właściciela, potem:
tools/scale/docker/scale-pg.sh clone dynaminds_scale_20261029_01
# VACUUM (ANALYZE) co 600 s, bo przy cofniętym zegarze autovacuum nie działa (sekcja „Stan”); od biegu po 01:13 UTC
tools/scale/docker/scale-pg.sh vacuum-loop dynaminds_scale_20261029_01 600
# generator (start 29.10 00:52 UTC; ta sama komenda = wznowienie z checkpointu)
SCALE_GEN_DETACH=1 SCALE_GEN_CPUS=2 tools/scale/docker/scale-pg.sh netns-node dynaminds_scale_20261029_01 \
  "$REL/project/tools/scale/generate.mjs" --simulate-days --connections 5 --tx-mode batch --order-batch 25 \
  --release "$REL/release-build.json" --checkpoint "$RUNS/full01.checkpoint.json" --report "$RUNS/full01.report.json"
```

Bieg 5 (od 29.10 05:13 UTC). Wznowienie = ta sama komenda:

```sh
cd "<workspace>/development/full-base"   # scale-pg.sh z SCALE_PG_CONTAINER (cbd9f9d, 1603ad0)
export SCALE_PG_CONTAINER=dyna-scale-full-pg18 SCALE_PG_PORT=57091 \
  SCALE_PG_STATE="<workspace>/development/full-base/data/scale/pg18-full-docker"
REL="<workspace>/local-builds/full-base-preview-20261017/scale-release-full-20261029-02"
WT="<workspace>/local-builds/scale-tools-913b6d5"; RUNS="$SCALE_PG_STATE/runs"
tools/scale/docker/scale-pg.sh clone dynaminds_scale_20261029_03          # migrate() 1,5 s, ledger 248, 10 strażników true
tools/scale/docker/scale-pg.sh vacuum-loop dynaminds_scale_20261029_03 120  # 120 s, nie 600 (bieg 4, niżej)
SCALE_GEN_DETACH=1 SCALE_GEN_CPUS=2 tools/scale/docker/scale-pg.sh netns-node dynaminds_scale_20261029_03 \
  "$WT/tools/scale/generate.mjs" --simulate-days --connections 5 --tx-mode batch --order-batch 25 \
  --release "$REL/release-build.json" --checkpoint "$RUNS/full03.checkpoint.json" --report "$RUNS/full03.report.json"
```

Checkpoint: `data/scale/pg18-full-docker/runs/full01.checkpoint.json` (zapis po każdej zatwierdzonej partii),
raport na końcu: `runs/full01.report.json`. Log biegu = `docker logs dyna-scale-full-gen` (kontener zostaje po
zakończeniu); log biegu 1 (przerwany celowo, niżej) w `runs/full01-run1.log`.

Start fabryki wydania przy każdym (wznowionym) biegu: `migrate()` 1,7–1,8 s, zimna walidacja 77–78 s.

## Postęp

```sh
docker ps --filter name=dyna-scale-full --format '{{.Names}}\t{{.Status}}'
docker logs --tail 2 dyna-scale-full-gen                 # [Ns] A:… sku x/20000 ord y/20000 | … rec/s
docker logs dyna-scale-full-gen 2>&1 | grep '^day ' | tail -5   # day k <data> done in Ns {"A":n,…}
docker logs dyna-scale-full-gen 2>&1 | grep -c '^retry'
python3 -c 'import json,sys;c=json.load(open(sys.argv[1]));print({k:(v["phase"],v["products_next"],v["orders_next"]) for k,v in c["tenants"].items()})' \
  "<workspace>/development/full-base/data/scale/pg18-full-docker/runs/full03.checkpoint.json"   # bieg 5
docker stats --no-stream dyna-scale-full-pg18 dyna-scale-full-gen
```

Koniec: kontener `dyna-scale-full-gen` w stanie `Exited (0)`, w logu `guards after … ` i `report …`; plik zegara
wraca do `+0`. Exit ≠ 0 = przyczyna w ostatnich liniach logu, potem wznowienie.

## Wstrzymanie, wznowienie, przerwanie

```sh
# wstrzymanie na okno testu obciążenia (najpierw generator, potem jego PG)
docker pause dyna-scale-full-gen dyna-scale-full-pg18
# wznowienie (najpierw PG, potem generator)
docker unpause dyna-scale-full-pg18 dyna-scale-full-gen
# przerwanie z możliwością wznowienia (partia w toku się wycofuje, checkpoint = baza)
docker logs dyna-scale-full-gen > "$RUNS/full01-runN.log" 2>&1; docker kill --signal KILL dyna-scale-full-gen; docker rm dyna-scale-full-gen
#   …wznowienie: komenda generatora z sekcji „Bieg” bez zmian
# zatrzymanie PG (wolumeny zostają), dopiero po przerwaniu generatora; start: docker start dyna-scale-full-pg18
docker stop -t 120 dyna-scale-full-pg18
```

Uwaga: `scale-pg.sh` bez `99009bf` (np. w `development/full-base` przed integracją) nie zna `SCALE_PG_CONTAINER`
i każde `up/stop/down/netns-*` działa na `dyna-scale-pg18`. Dlatego wstrzymanie i przerwanie są wyżej gołymi
komendami `docker`, a komendy `scale-pg.sh` z sekcji „Bieg” uruchamiać z worktree z `99009bf` albo po integracji.

Sprawdzone 29.10 na tym biegu:

- **pause/unpause** (00:54:20–00:56:00 UTC, 100 s, w fazie katalogu): po wznowieniu partie w toku dostały
  `statement timeout` (PostgreSQL liczy `statement_timeout` od zegara ściennego) i zostały ponowione
  (`retry A/C/D/E products … #1`, po jednym na tor), potem dalej bez błędów. Healthcheck pokazuje `unhealthy` po pauzie
  dłuższej niż ~2 min i wraca do `healthy` przy pierwszej próbie po wznowieniu; nic na niego nie reaguje (brak polityki
  restartu). Każda pauza kosztuje najwyżej jedno ponowienie na tor (limit 40 na partię).
- **kill -9 i wznowienie** (00:56:20 UTC): checkpoint A 1900, B 1700, C 1900, D 1600, E 1900 SKU; ta sama komenda
  podjęła od tych miejsc; po wznowieniu `count(*) = count(DISTINCT sku)` na każdej z 5 firm (bez duplikatów).
  Blokada zegara (`faketime.rc.lock`, ten sam host i pid w nowym kontenerze) uznana za porzuconą (`simclock.mjs`).

Zegar w czasie pauzy biegnie dalej (przesunięcie libfaketime jest względne), więc zamówienia dnia zapisane po
wznowieniu mają `created_at` przesunięte o długość pauzy w obrębie tego samego symulowanego dnia (dzień zaczyna się
06:00 UTC; pauza do ~17 h nie przenosi zapisu na kolejny dzień). Ryzyko szczątkowe: pauza dokładnie w chwili zmiany
dnia (`moveClock`, poza ponowieniami) może zakończyć bieg błędem — wtedy przerwanie i wznowienie jak wyżej.

## Stan 29.10 02:17 (Warszawa): ZABLOKOWANE na otwarciu WMS, zamówienia nie ruszyły

| Bieg | Czas (UTC) | Wynik |
|---|---|---|
| 1 | 00:52–00:56 | katalog A 1900, B 1700, C 1900, D 1600, E 1900 SKU; w środku pause/unpause; celowe `kill -9` (`runs/full01-run1.log`) |
| 2 | 00:56–01:10 | katalog 5 × 20 000 SKU gotowy (≈7 min zegara dla 100 000 SKU z biegiem 1, do 290 rek./s); B i D w fazie `orders`; otwarcie WMS A/C/E: 40 × `statement timeout` na każdej firmie, exit 1 (`runs/full01-run2.log`, `full01-run2-failed.report.json`) |
| 3 | 01:14–01:16 | po `VACUUM (ANALYZE)`: otwarcie WMS A/C/E odrzucone 413 „Otwarcie obejmuje za dużo stanów”, exit 1 (`runs/full01-run3.log`); strażnicy po biegu 10/10 `true`, zegar `+0`, blokada zwolniona |

**Przyczyna biegu 2: statystyki planera, nie produkt.** Autovacuum nie przeanalizował nowych wierszy, gdy zegar
instancji był cofnięty o 184 dni (`pg_stat_user_tables`: `products` 100 000 zmian od analizy, `last_autoanalyze` puste).
Planer liczył 1 wiersz na firmę w `stock`/`products`, więc pierwsze zapytanie `openingSnapshot` (`server/wms-lots.ts:1314`)
szło pętlą zagnieżdżoną po 192 mln par: `EXPLAIN ANALYZE` 36 869 ms przy limicie 8 s. Po `VACUUM (ANALYZE)` (1 s):
hash join, 37 ms. Narzędzie `scale-pg.sh vacuum-loop <db> [s]` (commit `de2b34f`, test 5/5) uruchamia kontener
`dyna-scale-full-vacuum` z `VACUUM (ANALYZE, SKIP_LOCKED)` co 600 s w przestrzeni sieciowej instancji. Kolejny bieg
uruchamiać razem z nim; w pauzie wstrzymać również jego:
`docker pause dyna-scale-full-gen dyna-scale-full-vacuum dyna-scale-full-pg18` / `docker unpause dyna-scale-full-pg18 dyna-scale-full-vacuum dyna-scale-full-gen`.
Sidecar jest usunięty, dopóki generator stoi.

**Przyczyna biegu 3: limit produktu.** `WMS_LOT_LIMITS.physical_rows = 10000` (`server/wms-lots-schema.ts:6`). Otwarcie
liczy wszystkie wiersze `stock` i `stock_locations` firmy (`server/wms-lots.ts:1321`, `:1329`), także zerowe. Firma A/C/E
pełnego profilu ma 19 200 wierszy `stock` i 19 200 lokalizacji, z czego dodatnich jest tylko 917 / 951 / 986. Pozostałe
to SKU, których zapas ma przyjść przez PZ. Zwykły `createProduct` zawsze tworzy wiersz stanu (`warehouse_id` wymagane,
`server/domain.ts:115`), więc generator nie ma zwykłej ścieżki, która zmieściłaby się w limicie bez zmiany planu. Przy
8 000 SKU (`_71`, 7 680 wierszy) limit nie był osiągany. Skutek produktowy: firma z ponad 10 000 wierszy stanu nie
włączy partii WMS przez otwarcie, a profil akceptacyjny wymaga tego dla A/C/E przy 20 000 SKU.

Do decyzji (koordynator/Artur), potem nowy klon i bieg od zera (katalog to tylko ~7 min):

1. Produkt: otwarcie liczy do limitu tylko wiersze z ilością > 0 albo stronicuje podgląd. Nowe wydanie, więc nowy
   `release-build` i klon. Plan `ca7c640f…` bez zmian.
2. Produkt: limit otwarcia zależny od planu firmy (jak operacje WMS w `fd7f783`, enterprise), np. 50 000. Nowe wydanie, plan bez zmian.
3. Generator: otwarcie WMS po pierwszych ≤ 10 000 wierszach stanu, a reszta katalogu A/C/E już pod polityką partii.
   Bez zmiany produktu, ale ~5 % SKU drugiej połowy nie dostanie partii `opening` (zmiana planu i skrótu) i maskuje lukę produktu.

Instancja `dyna-scale-full-pg18` zostaje uruchomiona, bez obciążenia, z klonem `_01` (katalog 5 × 20 000, B/D gotowe
do zamówień) i zegarem `+0`. Kontener `dyna-scale-full-gen` jest usunięty, logi są w `runs/`.

## Biegi 4 i 5 (29.10)

| Bieg | Baza / checkpoint | Czas (UTC) | Wynik |
|---|---|---|---|
| 4 | `_02` / `full02` | 04:28–05:10 | Klon i migracja: ledger 248, strażnicy 10/10 `true`, plan `ca7c640f…`. Katalog 5 × 20 000 SKU w ~8 min. Otwarcie WMS A/C/E: 32 × `statement timeout` na firmę (limit 40); ponowienia przeszły po drugim `VACUUM (ANALYZE)`, bo pierwszy przebieg sidecara był przy pustym katalogu. Dni 0–10 po 63–150 s. Zatrzymany celowo po 11 dniach (`kill`, log `runs/full02-run4.log`, zegar ręcznie na `+0`, blokada usunięta): faktury 157 skończyłyby się około dnia 49 |
| 5 | `_03` / `full03` | od 05:13 | Narzędzia `913b6d5` (faktury 230), sidecar co 120 s: otwarcie WMS bez żadnego ponowienia. Dalej w tabeli postępu niżej |

### Decyzja: faktury zbioru ścieżką 230, nie 157 (koordynator, 29.10, odwracalna, tylko narzędzia)

Zapieczętowany `local_invoice_budget` (`server/157_local_invoices.sql:137`):
- odmawia (23514 „Limit historii faktur”) każdej faktury lokalnej firmy, gdy ma ona > 2000 podglądów, > 2000 przyjęć
  albo > 64 MiB historii;
- limit jest dożywotni i taki sam dla każdego planu;
- woła go też odroczony wyzwalacz ograniczeń na tabelach 157, więc nie da się go obejść innym wejściem
  (sondy koordynatora w `…/scratchpad/p274/`).

Pełny plan wystawia ~7 400 faktur na firmę (0,8 × 40 % wysłanych + 5 % zwróconych z 20 000 zamówień). W biegu 4 po
4 dniach było 146–173 faktur na firmę (~34 % zamówień), a po 7 dniach 261–307. Firma A doszłaby do 2000 około
dnia 45–49.

Ścieżka 230 (`server/invoice230.ts`):
- podgląd `POST /api/invoice230/orders/:id/previews`;
- wystawienie przez ten sam `tax-issue` (`issueLocalInvoiceWithTax` przekazuje podgląd 230 do `issueInvoice230InTx`);
- własna podseria `FV-S/<prefiks>/<rok>/<nr>`, bez budżetu na całe życie;
- `orderRefusals` (`:84-101`) nie odmawia zwykłemu zamówieniu konsumenta z PL w PLN;
- odmawia przy istniejącej sprawie zwrotu, ale plan wystawia fakturę przed zwrotem (`orderSteps`).

Zmiany:
- `913b6d5`: generator, `writer.mjs` `issueOrderInvoice`; `orderState` uznaje fakturę 157 albo 230, więc wznowienie
  nie wystawi drugiej.
- `d3dfa1d`: sterownik obciążenia. `prepare.mjs` robi podgląd 230; mierzone żądanie zostaje przypiętym
  `…/local-invoices/previews/:id/issue`, czyli aliasem `tax-issue`. Nowy wariant `invoice230_issue` w
  `scripts/full-base-scale-http-ports.mjs`.

Plan i jego skrót bez zmian (`ca7c640f…`): plan decyduje tylko, które zamówienia dostają fakturę, nie którą ścieżką.
Skutek dla odbioru: faktury zbioru mają numery FV-S i tryb `invoice230`, nie `local_invoice`. Limit 157 jako
decyzja produktowa należy do Artura.

Koszt wywołania 230. Pomiar wykonałem na kopii `dynaminds_scale_20261029_82` (TEMPLATE `_81` po biegu obciążenia),
w instancji `dyna-scale-pg18`:
- firma B, jeden tor, wydanie `c718174`;
- skrypt `…/scratchpad/b/bench230.mjs`: fabryka wydania i `inject` z sesją właściciela; własne zamówienia wysłane
  przygotowaniem sterownika (`shipOwn`), podgląd 230, potem mierzone `…/previews/:id/issue`;
- stan MAIN firmy B uzupełniony zwykłym `POST /api/inventory/adjust` (+200 na 6 144 produkty), bo okno katalogu się
  wyczerpało.

| faktury 230 firmy B | podgląd p50 / p95 ms | wystawienie p50 / p95 ms |
|---|---|---|
| 1–250 | 135 / 145 | 179 / 196 |
| 251–500 | 136 / 163 | 181 / 222 |
| 501–750 | 174 / 200 | 234 / 265 |
| 751–1 000 | 171 / 190 | 229 / 256 |
| 1 001–1 250 | 170 / 198 | 230 / 268 |
| 1 251–1 482 | 180 / 202 | 242 / 274 |

Ocena wyników:
- Zero odmów wystawienia na 1 482 faktury.
- Skok przy ~500 zbiega się z obciążeniem hosta przez inne sesje od ~05:50 UTC (PG04: `p276`, `stk29`, load 15–18)
  i z uzupełnieniem stanu. Od 750 do 1 482 koszt rośnie o ~5–6 %.
- Dla porównania sam `local_invoice_budget` 157 rósł liniowo z 12,6 do 67 ms przy 1 300–1 700 fakturach
  (`LOAD-TEST-FULL-20261029.md` 4.7) i odmawia przy 2 001.
- Kilku tysięcy na jednej firmie nie osiągnąłem: ~3 s na fakturę z wysłaniem zamówienia przy limicie 600/min na
  proces, a drugi tor dzieli ten limit.
- Na pełnym zbiorze firmy przeszły 2 000 faktur 230 około dnia 49 (A 2 167, C 1 987) i dalej rosną bez odmów. Czas
  dnia jest płaski: średnia z 10 dni 106–119 s w dniach 20–64 (tabela niżej).
- Bezpośredniego pomiaru na `_03` nie da się zrobić w trakcie biegu. Druga fabryka wydania czeka na blokadę migracji
  982376, którą trzyma generator: `MIGRATION_LOCK_TIMEOUT`.

### Postęp biegu 5

| Chwila (UTC) | Dzień symulowany | Zamówienia na firmę | Faktury 230 / 157 na firmę | Sprawy zwrotu | Ponowienia |
|---|---|---|---|---|---|
| 05:37 | 5 (po dniu 4) | 556–581 | 181–217 / 0 | 19–33, wszystkie po `requested` | 0 |
| 06:57 | 50 | 5 580–5 606 | 1 987–2 167 / 0 | 265–287 | 3 (`statement timeout`, ponowione) |
| 07:24 | 64 | 7 136–7 186 | 2 554–2 752 / 0 | 344–367 | 5 (jak wyżej, każda #1) |

- Czas dnia, średnia z 10 dni: 82,5 / 93,0 / 119,0 / 111,8 / 106,1 / 117,1 / 107,7 s (dziesiątki dni 0–9 … 60–64); ostatnie 20 dni
  średnio 111 s.
- Od ~05:50 UTC host obciążają też inne sesje (procesy PG04 `p276`, `stk29`; load 15–18). Bez tego dni 1–13 szły po
  63–80 s.
- Baza 2,5 GB przy dniu 50; strażnicy przed biegiem 10/10 `true`; zegar instancji biegnie z przesunięciem libfaketime.

Pauza i wznowienie (05:37:37–05:39:07, 90 s, dzień 5):
- `docker pause dyna-scale-full-gen dyna-scale-full-vacuum dyna-scale-full-pg18`, potem `docker unpause` w odwrotnej
  kolejności;
- jedno ponowienie partii w toku (`retry A orders 580 #1 after statement timeout`);
- dzień 5 trwał 180,5 s, w tym 90 s pauzy; dalej bez błędów;
- PG chwilowo `unhealthy`, potem `healthy`.

## Tempo i szacunek

- Katalog: 100 000 SKU w ≈ 7–8 min zegara (5 torów, PG 6 rdzeni, generator 2), do 360 rek./s.
- Otwarcie WMS i PZ firm A/C/E: ~10 min w biegu 5. W biegu 4 dodatkowe ~8 min ponowień przez nieaktualne
  statystyki planera.
- Zamówienia: 111 na firmę na dzień, bariera dnia.
  - Zmierzone w biegu 5: 63–87 s na dzień w dniach 0–13 na cichym hoście, 97–139 s w dniach 20–64 przy obciążeniu
    przez inne sesje.
  - Średnio ~111 s na dzień w ostatnich 20 dniach.
  - Wcześniejsze szacunki (25 h z s/zamówienie `_71`, 41 h z manifestu) są nieaktualne: wydanie 258 i tryb
    `batch` × 25 są kilkakrotnie szybsze.
- **ETA biegu 5**: dzień 64 o 07:24 UTC.
  - Zostało 116 dni × ~111 s ≈ 3,6 h, więc koniec około **11:00 UTC 29.10** (12:00 Warszawa).
  - Przedział 10:30–11:45, zależnie od obciążenia hosta i wzrostu kosztu z rozmiarem tabel (dotąd płaski).
  - Do tego strażnicy po biegu i raport `runs/full03.report.json`.
- Uwaga dla ETA: każda pauza wydłuża bieg o swój czas plus jedno ponowienie partii na tor.
