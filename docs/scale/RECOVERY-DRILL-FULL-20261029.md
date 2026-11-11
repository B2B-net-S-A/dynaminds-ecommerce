# Próba odtwarzania na pełnym zbiorze — etap 5, 29.10.2026 (warunek 11: RPO ≤15 min, RTO ≤60 min)

Pełny zbiór akceptacyjny (`docs/scale/FULL-DATASET-GEN-20261029.md`): baza `dynaminds_scale_20261029_03`
w kontenerze `dyna-scale-full-pg18` (5 firm × 20 000 SKU + 20 000 zamówień, 180 dni). Po symulowanej utracie
odtworzyłem bazę, pliki, klucze, konfigurację, usługi i niepustą kolejkę do nowego kontenera. Wydanie to wydanie
z generowania. Wszystko lokalnie (Docker), czasy w UTC. Narzędzia: `tools/recovery/full-drill.mjs`
(nowe), `tools/recovery/drill-app.mjs` (read-back API i strażnicy 11–12), `tools/recovery/pitr.mjs` (bez zmian).
Dowody poza gitem (`data/` w `.gitignore`, katalogi 0700, pliki 0600): `data/recovery/full-20261029/`.

## Wynik

| Kryterium | Cel | Zmierzone | Wynik |
|---|---|---|---|
| RPO, dysk danych utracony (kopia bazowa + archiwum WAL), `kill -9` 2,5 s przed przełączeniem segmentu | ≤15 min | **57,6 s**, utracone 570 z 1527 potwierdzonych zapisów, bez dziur (1…957) | **PASS** |
| RTO, od `kill -9` do wydania z opróżnioną kolejką i sprawdzonym API | ≤60 min | **150,2 s** (2,5 min) | **PASS** |
| baza w nowym kontenerze | nowy kontener, nowe wolumeny | `dyna-recovery-full-t1`, oś czasu 3, ten sam identyfikator systemu `7701885160486498347` | PASS |
| liczby wierszy na firmę = źródło w punkcie odtworzenia | równe | 747 tabel, 9 174 642 wiersze, 51 firm, **0 różnic** | PASS |
| pliki (zdjęcia) | wszystkie | 2/2: 1 z migawki zestawu, 1 z mirrora `files-sync`; `GET /api/product-images/:id` 200, sha256 zgodne | PASS |
| klucze | odpieczętowane | `local-config.json` z zestawu (AES-256-GCM, plik hasła 0600) ma sha256 równe źródłu, 0600; wydanie odszyfrowuje dane (read-back) | PASS |
| konfiguracja | odtworzona | 4 pliki: `postgresql.scale.conf`, `compose.yml`, `Dockerfile`, `release-build.json` | PASS |
| usługi, zimny start po kolei | słuchają | PostgreSQL (promocja 1,5 s) → wydanie `ordinary-local-cli.mjs --scoped-automation` do `ORDINARY_LOCAL_APP_LISTENING` **108,9 s**; restart 104,7 s | PASS |
| 10 strażników + `warehouse_wz_issuer_guards` + `email_inbound_guards` (sesja `jit=off`, `timezone=UTC`) | `true` | 10/10 (14,9 s) + 2/2 (2,2 s), po restarcie tak samo | PASS |
| kolejka niepusta w chwili awarii, opróżniona raz | bez podwójnych skutków | 200 zadań drilla `pending/attempts=0` w chwili awarii i po odtworzeniu → 400 × `done/attempts=1` (200 `automation` + 200 `automation.run`), 200 wykonań, na każde zamówienie 1 znacznik i 1 zdarzenie `order.note_added`; po restarcie bez zmian | PASS |
| odczyt przez API próbki zamówień i faktur | jak w źródle | **50/50** odpowiedzi identycznych z odpowiedziami źródła sprzed awarii (sha256 kanonicznego JSON): 5 × `/api/orders/:id` + 5 × `/api/invoice230/documents/:id` na każdą z 5 firm, sesje właścicieli odtworzone z bazy | PASS |
| sprawdzenie przez UI | (warunek 11: „UI i API”) | nie wykonane, patrz „Otwarte” | — |

Wydanie: `scale-release-full-20261029-02`, commit `c71817420b89c1b3b306d693d79e30dbff34ccc8`, `release.json`
`b0b0a5a3…345a`, drzewo pakietu `17e0b065…9cc9` (to samo, którym generowano zbiór).

## Procedura

```sh
cd "<workspace>/development/full-base"
D="$PWD/data/recovery/full-20261029"
REL="<workspace>/local-builds/full-base-preview-20261017/scale-release-full-20261029-02/release-build.json"
# 0. generator skończył (exit 0, 10:38:30); sidecar VACUUM zatrzymany, logi zachowane
docker logs dyna-scale-full-vacuum > data/scale/pg18-full-docker/runs/full03-vacuum-sidecar.log 2>&1
docker logs dyna-scale-full-gen    > data/scale/pg18-full-docker/runs/full03-run5.log 2>&1
docker stop -t 30 dyna-scale-full-vacuum
# 1. plik hasła zestawu (losowy, 0600, nie w logach ani w zestawie)
( umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))' > "$D/passphrase.private" )
# 2. cała próba (kroki source → seed → disaster → restore; --from <krok> wznawia)
node tools/recovery/full-drill.mjs --dataset dyna-scale-full-pg18 --db dynaminds_scale_20261029_03 --release "$REL" \
  --local-config "$PWD/data/scale/pg18-full-docker/local-config.json" --dir "$D" --passphrase-file "$D/passphrase.private" \
  --orders 100 --readback 5
```

Kroki (`tools/recovery/full-drill.mjs`, opis w `tools/recovery/README.md`):

1. **source**, bez pomiaru. Liczby wierszy zbioru (tylko odczyt) i kopia bazowa `dyna-scale-full-pg18`:
   `pg_basebackup`, punkt kontrolny i WAL, nic więcej na tej instancji. Odtworzenie `--latest` do nowego
   kontenera `dyna-recovery-full-src`, który gra rolę produkcji. Zbiór i jego kontener zostają nietknięte. Kopia
   ma te same liczby co zbiór (`counts_equal_dataset: true`).
2. **seed**, bez pomiaru, na `dyna-recovery-full-src`, przez API wydania (fabryka z procesorem reguł, bez
   nasłuchu, więc nic nie jest przejmowane):
   - próbka read-back: 5 firm × (5 zamówień + 5 faktur `invoice230`, wybór po `md5(id)`), odpowiedzi i sesje
     w `src-app/readback.private.json`;
   - firma B: reguła `order.created → add_note` z włączonym lokalnym workerem, zdjęcie, 100 zamówień, czyli
     100 oczekujących zadań;
   - **zestaw kopii** `sets/20261029T105425Z-dyna-recovery-full-src`: kopia bazowa, migawka zdjęć,
     zapieczętowane klucze, 4 pliki konfiguracji;
   - po zestawie: 100 kolejnych zamówień i zdjęcie, tylko w WAL i w mirrorze plików; potem `files-sync`
     (2 pliki);
   - liczby wierszy każdej tabeli na firmę, czyli **punkt odtworzenia** (10:56:23). Po nim nikt już nie pisze
     do bazy drilla.
3. **disaster**: zapisy sondy co 100 ms do `recovery_rpo.rpo_probe` (jedna sesja, `synchronous_commit=on`,
   zwrócony wiersz = trwały zapis lokalny). Pierwsze przełączenie `archive_timeout` archiwizuje ostatni segment
   seeda. Drugie (`0000000200000004000000DA`, 10:58:23,937) wyznacza chwilę zabicia: `docker kill --signal KILL
   dyna-recovery-full-src` o **10:59:21,490**, 2,5 s przed następnym przełączeniem (najgorszy przypadek). Wolumen
   danych traktowany jako utracony. Ocalało tylko archiwum WAL `dyna-recovery-full-src-wal-archive`. W chwili
   awarii w kolejce czekało 200 zadań drilla (`pending`, `attempts=0`) i 597 starych zadań szablonu (o nich
   niżej).
4. **restore**, mierzone od zabicia. `pitr.mjs restore --latest` zestawu i archiwum do nowego kontenera
   `dyna-recovery-full-t1` z nowymi wolumenami, potem kolejno:
   - RPO z sondy;
   - liczby wierszy porównane z punktem odtworzenia;
   - kontrola kolejki;
   - pliki, klucze i konfiguracja na miejsce;
   - zimny start wydania;
   - weryfikacja (`drill-app.mjs verify`): 10 + 2 strażników, opróżnienie kolejki dokładnie raz, API (health,
     worker reguły, zdjęcia, zamówienie), read-back 50 odpowiedzi.

   Potem bez pomiaru: restart wydania (SIGTERM), 15 s pracy workera i ponowna weryfikacja.

## Czasy (RTO)

| Faza | czas |
|---|---|
| `kill -9` → start odtwarzania | 0,68 s |
| weryfikacja zestawu: sha256 3 plików bazy (2,12 GB), tryby 0600, identyfikator systemu w archiwum i `backup_manifest`, `pg_verifybackup`, odpieczętowanie kluczy | 7,96 s |
| rozpakowanie kopii bazowej na pusty wolumen | 7,96 s |
| odtwarzanie WAL z archiwum + promocja (redo `4/D6000028` → `4/DA0157C0`, ~64 MiB, 0,10 s; oś czasu 3) | 1,47 s |
| pliki (1 z zestawu + 1 z mirrora), klucze, konfiguracja (4) | 0,004 s |
| RPO z sondy | 0,05 s |
| liczby wierszy, 747 tabel / 9 174 642 wiersze, porównanie | 1,29 s |
| kontrola kolejki, stan aplikacji (plik env, wybór CLI, zdjęcia) | 0,10 s |
| zimny start wydania do `ORDINARY_LOCAL_APP_LISTENING` | **108,89 s** |
| strażnicy 10 (14,9 s) + 2 (2,2 s), kolejka (`drain_ms` 3: opróżniona w czasie strażników), API (0,1 s), read-back 50 (3,9 s) | 21,35 s |
| reszta (reset ustawień odtwarzania, odczyt logów serwera) | ~0,5 s |
| **RTO razem** | **150,2 s** |

Klaster źródła 9,14 GB (`dynaminds_scale_20261029_03` 7,20 GB plus `_01`, `_02` i szablon), kopia bazowa po
zstd 2,12 GB. Wyniki biegu z 27.10 na klastrze 1,18 GB: 197–241 s. Mimo ośmiokrotnie większego klastra RTO jest
niższe, bo zimny start wydania spadł ze 145–174 s do 109 s (e178a7b, 210fa79), a kolejka opróżnia się w czasie
strażników (8ecfe31).

Przygotowanie (bez pomiaru): liczby zbioru 0,73 s; kopia bazowa zbioru 17,5 s (`pg_basebackup` 10,4 s +
`pg_verifybackup` 6,9 s); odtworzenie do źródła drilla 17,1 s; seed 1 104,6 s (fabryka 96,2 s); zestaw drilla
14,6 s; seed 2 102,3 s; sonda RPO do zabicia 178 s.

**Odtwarzanie WAL przy rzadszych kopiach bazowych (ekstrapolacja, nie pomiar).** W tej próbie od kopii bazowej
do awarii było tylko ~64 MiB WAL. Instancja zbioru wytworzyła przez całe ~10 h generowania (z biegami 1–4)
~19,3 GiB WAL (oś czasu 1 do `4/D2`). Przy przepustowości odtwarzania zmierzonej 27.10 (316 MB/s, sekcja 4 tamtego
dokumentu) to ~66 s. Nawet przy kopii bazowej co 6 h i tak ciężkim zapisie RTO zostaje około 3,6 min.

## RPO

| | ostatni potwierdzony zapis | ostatni po odtworzeniu | utrata |
|---|---|---|---|
| tylko archiwum (dysk danych utracony) | seq 1527, 10:59:21,404 | seq 957, 10:58:23,820 (ciągłe 1…957) | **57 584 ms, 570 wierszy** |

Najgorszy przypadek wynika z ustawienia: `archive_timeout` 60 s + czas archiwizacji (~0,1 s). Ten sam wynik co
27.10 (57,6 s). Cel ≤15 min spełniony z zapasem ×15. Dane aplikacji zapisane przed ostatnim przełączeniem
(seed obu faz) wróciły w całości: 0 różnic liczb. Zdjęcia mają osobne RPO, czyli odstęp `files-sync` (README:
co 5 min). Przypadku „awaria serwera, dysk cały” tym razem nie mierzyłem. Wolumen danych źródła drilla został
usunięty po próbie (27.10: 0 s).

## Ustawienia PostgreSQL

Strojenia `ALTER SYSTEM` instancji zbioru nie resetowałem. Do porównania czasów odtwarzania i zimnego startu
ustawienia produkcyjne nie były potrzebne. Rozpakowanie i odtwarzanie WAL nie zależą od `shared_buffers`,
a zimny start to praca JS wydania. Klastry drilla dostały je w `postgresql.auto.conf` razem z danymi:

- `shared_buffers=3GB`, `maintenance_work_mem=1GB`, `autovacuum_work_mem=512MB`;
- reszta z `tools/scale/docker/postgresql.scale.conf` w obrazie: `archive_mode=on`, `archive_timeout=60s`,
  `max_wal_size=16GB`, `jit=off`;
- kontenery drilla bez limitu `--memory` (`pitr.mjs restore` go nie ustawia; instancja zbioru ma `--memory 10g`);
- libfaketime wyłączony (`SCALE_FAKETIME=off`), czyli prawdziwy zegar, więc `archive_timeout` działa.

Wartości manifestu (16 GB) nie stosowałem. VM Dockera ma 31 GiB, a `dyna-scale-pg18` i `dyna-scale-full-pg18`
też działały.

## Kolejka: zadania sprzed drilla

Zbiór ma 597 zadań `automation` w stanie `pending`. Należą do 20 firm szablonu (nie firm skali), a reguły tych firm są
wyłączone (`enabled=false`) albo ich nie ma. Są też w zbiorze źródłowym. Procesor reguł ich nie przejmuje, więc po opróżnieniu
dalej czeka 597, tak samo jak w zbiorze. Przetworzonych przyrosło dokładnie o zadania drilla: `automation/done`
7 → 207, `automation.run/done` 9 → 209.

Sprawdzone na kopii `dynaminds_scale_20261029_q597` (TEMPLATE `_03`), bo pytanie brzmiało, czy to błąd przydziału:

- Pochodzenie: te same 597 wierszy (594 + 3) są w `dynaminds_restore_36751abef3079f3f`, z którego klonuje się zbiór.
  `created_at` = `run_at` z zegara ściennego 08.10 01:38 – 15.10 23:44, sprzed bazy V2 z 17.10 (`3f1003d`). Generator nie dodał
  ani jednego zadania `automation`, a jego zegar libfaketime ich nie dotyczy.
- 594 mają `payload.rules = []`. Wstawił je starszy kod, który tworzył zadanie dyspozytora dla każdego zdarzenia. Od `3f1003d`
  `server/events.ts` wstawia je tylko, gdy są reguły (`if(rules.length)`). 3 zadania zamroziły regułę
  `ff8dac8f…` w wersji 3 (firma `745e953a…`). Ta reguła ma dziś wersję 4, `enabled=false` i nie ma `local_worker`.
- Stan: wszystkie 597 mają `attempts=0`, brak `locked_at` i `lease_token`, `run_at<=now()`, a zdarzenie
  (`eventId`, `orderId`, `trigger`) istnieje. Nic ich więc nie zablokowało w połowie.
- Dlaczego procesor reguł zwraca brak wiersza: wyszukiwanie reguł w `scoped-automation-worker.ts` (`enabled` i
  `local_worker.enabled='true'`) znajduje w zbiorze 0 reguł, więc `claimAutomaticJob` nie jest nawet wołany. Gdyby był,
  zapytanie dyspozytora wymaga `payload->'rules' @> [{id, version: aktywna wersja}]`. Jako `dyna_app` z tenantem
  `745e953a…`: wersja 3 → 3 wiersze, 4 i 5 → 0. Zadanie z `rules = []` nie pasuje do żadnego `@>`. To samo jest po p275.
- Kto je przetwarza: worker ogólny (`server/worker.ts` → `dispatchAutomation`). Dla `rules = []` tylko ustawia `done`
  (`server/automations.ts`, pętla po 0 regułach). Wydanie `--scoped-automation` celowo nie uruchamia workera ogólnego.

Wniosek: to nie błąd produktu ani generatora, tylko zaległość szablonu. Narzędzia drilla liczą opróżnienie po
identyfikatorach zadań drilla (`tools/recovery/full-drill.mjs`, `seeded_pending`, `pending_seeded_jobs`). `jobs_after_drain`
to tylko podsumowanie wszystkich zadań według rodzaju i stanu, dlatego widać w nim 597.

## Nienaruszalność

- `dyna-scale-full-pg18` / `dynaminds_scale_20261029_03` po próbie: zamówienia 100 428, produkty 100 197,
  dokumenty 36 841, `order_events` 1 141 643, zadania 731 (razem z firmami szablonu), czyli dokładnie jak przed
  próbą. Zapisy drilla trafiły tylko do kopii (`dyna-recovery-full-*`).
- `dyna-scale-pg18` (`_71/_41/_61/_81/_82`), Main (4100) i PG04: nietknięte.
- Sekrety: przeszukanie 24 plików (`data/recovery/full-20261029` bez `*.private*`, `local-config.json`,
  `*.sealed` i zestawów; narzędzia; log sidecara) pod kątem hasła bazy, klucza szyfrowania i hasła zestawu, także
  w postaci URL-encoded: 0 trafień. Hasło bazy jest tylko w plikach 0600 (`app.env.private`,
  `selection.private.json`).
- Testy części czystych: `node --test tests/recovery-pitr.test.mjs` → 16/16.

## Dowody (`data/recovery/full-20261029/`)

| Plik | Treść |
|---|---|
| `full-drill-report.json` | raport: zbiór, zestawy, seed, punkt odtworzenia, awaria, RPO, fazy RTO, liczby, kolejka, `verify`, `verify_after_restart` |
| `counts-dataset.json`, `counts-source.json`, `counts-dyna-recovery-full-t1.json` | liczby wierszy każdej tabeli na firmę: zbiór, punkt odtworzenia, po odtworzeniu |
| `rpo-acked.json` | 1527 potwierdzonych zapisów sondy (seq, czas) |
| `drill.stderr.log`, `drill.stdout.log` | przebieg i podsumowanie |
| `sets/20261029T105425Z-dyna-recovery-full-src/` | zestaw drilla (kopia bazowa 2,12 GB, zdjęcie, zapieczętowane klucze, konfiguracja, `manifest.json`) |
| `sets-dataset/20261029T105204Z-dyna-scale-full-pg18/` | kopia bazowa zbioru (2,12 GB), z której powstało źródło drilla |
| `src-app/` (0600) | `seed.json`, sesje i odpowiedzi read-back (`readback.private.json`), plik env |
| `dyna-recovery-full-t1-state/`, `dyna-recovery-full-t1-app/` | odtworzone pliki, klucze, konfiguracja; stan aplikacji odtworzonej |
| `data/scale/pg18-full-docker/runs/full03-vacuum-sidecar.log`, `full03-run5.log` | logi sidecara VACUUM i generatora biegu 5 |

## Co zostaje na dysku

- Kontener `dyna-recovery-full-t1`, zatrzymany: odtworzona baza jako dowód. Wolumeny `dyna-recovery-full-t1-data`
  (9,25 GB) i `dyna-recovery-full-t1-wal-archive` (9 MB).
- Wolumen `dyna-recovery-full-src-wal-archive` (16,5 MB): archiwum WAL, bez którego zestawu drilla nie da się
  odtworzyć dalej niż do jego kopii bazowej.
- Host: `data/recovery/full-20261029/` 4,0 GB (dwa zestawy po 2,0 GB).
- Usunięte po zapisaniu dowodów: kontener `dyna-recovery-full-src` i jego wolumen danych (9,25 GB), czyli
  „utracony dysk”.
- Instancja zbioru `dyna-scale-full-pg18` działa. `dyna-scale-full-vacuum` zatrzymany. `dyna-scale-full-gen` w
  stanie `Exited (0)`, nieruszany.

Usunięcie pozostałości drilla, gdy dowody nie będą potrzebne:

```sh
docker rm dyna-recovery-full-t1
docker volume rm dyna-recovery-full-t1-data dyna-recovery-full-t1-wal-archive dyna-recovery-full-src-wal-archive
rm -rf "data/recovery/full-20261029/sets-dataset"   # zestaw drilla w sets/ potrzebuje archiwum src
```

## Otwarte

1. Sprawdzenie odtworzonej aplikacji przez UI (warunek 11). CLI słucha tylko w przestrzeni sieciowej kontenera
   (`127.0.0.1:18190`), więc do przeklikania potrzebny jest przekaźnik portu na host. Tak samo jak w
   `RECOVERY-DRILL-20261027.md` §8.2.
2. Harmonogram kopii bazowych i `files-sync` (`crontab`) nadal nie jest zainstalowany. To decyzja właściciela
   (TASKS.md „Czeka na mnie”).
3. Pomiar był na wydaniu generowania `c718174`, nie na wydaniu końcowym. Po zamrożeniu wydania końcowego próbę
   trzeba powtórzyć tą samą komendą, z nowym `--release` i nowym `--target`/`--src`.
