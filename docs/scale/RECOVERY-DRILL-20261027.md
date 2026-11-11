# Próba odtwarzania — etap 5, 27.10.2026 (warunek 11: RPO ≤15 min, RTO ≤60 min)

Ciągła archiwizacja WAL instancji `dyna-scale-pg18`, kopie bazowe z plikami, zapieczętowanymi kluczami
i konfiguracją oraz odtworzenie na nowy, pusty kontener do wskazanego czasu, z uruchomionym wydaniem
i niepustą kolejką zadań. Narzędzia i opis: `tools/recovery/README.md`. Wszystko lokalnie (Docker),
czasy w UTC. Dowody (poza gitem, `data/` jest w `.gitignore`, katalogi 0700, pliki 0600):
`data/recovery/`.

## Wynik

| Miara | Cel | Zmierzone | Dowód |
|---|---|---|---|
| RPO, utrata dysku danych (kopia bazowa + archiwum WAL) | ≤15 min | **57,6 s** w najgorszym ustawieniu (`kill -9` 2,5 s przed kolejnym przełączeniem segmentu, `archive_timeout = 60s`), 567 z 1049 potwierdzonych zapisów | `data/recovery/rpo-20261027/rpo-report.json` |
| RPO, awaria serwera, dysk cały (odtworzenie po awarii z własnego `pg_wal`) | — | **0 s**, 0 zapisów | jw., `disk_intact` |
| RTO, nowy kontener → wydanie słucha → kolejka przetworzona raz → API | ≤60 min | **230,3 s** (bieg 1), **240,7 s** (bieg 2) przy klastrze 1,18 GB | `data/recovery/drill-20261027/drill-report.run1.json`, `…run2.json` |
| RTO, pełny zbiór etapu 5 (**ekstrapolacja**) | ≤60 min | ~11,4 min (założenia niżej); **~10,4 min** po zmianie drenażu kolejki (bieg 3, sekcja 9) | sekcja 7; pole `extrapolation` raportów (`drillExtrapolation`, `tools/recovery/pitr-lib.mjs`) |
| strażnicy po odtworzeniu (sesja `jit=off`, `timezone=UTC`) | 10/10 | 10/10 `true` (15,8 s), także po restarcie | `verify.guards` |
| kolejka: przeżyła odtworzenie i przetworzona raz | bez podwójnych skutków | 20/20 zadań `automation` oczekujących po odtworzeniu → 40/40 `done`, `attempts=1`; 1 znacznik notatki, 1 zdarzenie `order.note_added`, 1 `automation_runs` na zamówienie; po restarcie wydania bez zmian | `verify.queue`, `verify_after_restart.queue` |

Wydanie: `scale-release-20261027-02`, commit `8ad430990b35a278188cd664430f81d02a216575`, `release.json`
`353f9126…4f82`, drzewo pakietu `c0176cf3…13a3`. Kod narzędzi: commity tej gałęzi z 27.10.2026
(`tools/recovery/*`, `tools/scale/docker/*`).

## 1. Archiwizacja na instancji etapu 5

`tools/scale/docker/postgresql.scale.conf`: `archive_command = '/usr/local/bin/dyna-wal-archive %p %f'`
(zstd poziom 1, fsync pliku i katalogu przed sukcesem; ponowne archiwum tej samej treści = sukces, innej
= odmowa), `archive_timeout = 60s`. Obraz przebudowany, kontener odtworzony 27.10 ok. 03:53 przy zerowej
liczbie sesji klientów (`scale-pg.sh up`, te same wolumeny). Sprawdzenie:

```sh
docker exec dyna-scale-pg18 psql -X -U postgres -At -c "show archive_command" -c "show archive_timeout" -c "select pg_switch_wal()"
# /usr/local/bin/dyna-wal-archive %p %f | 1min | 0/2D0000B8 → /wal-archive/00000001000000000000002D.zst (690 B)
```

Przełączony, prawie pusty segment 16 MiB zajmuje po kompresji 690 B, więc 60 s kosztuje miejsce tylko
przy zapisach. Pod obciążeniem (3,79 GB WAL w 13 s, sekcja 4) archiwum nadążało: po zakończeniu zapisu
ostatni segment był już zarchiwizowany (opóźnienie 0 s, 229 plików, 424 MB po kompresji).

Kopia bazowa instancji etapu 5 (bez przerwy w pracy, `pg_basebackup -Ft -X stream`, zstd po stronie klienta):

```sh
node tools/recovery/pitr.mjs base-backup --source dyna-scale-pg18 --sets "$PWD/data/recovery/sets" \
  --files "$PWD/data/product-images" --keys "$PWD/data/scale/pg18-docker/local-config.json" \
  --passphrase-file <plik operatora 0600> --config …/postgresql.scale.conf --config …/compose.yml --config …/Dockerfile
```

Zestaw `20261027T035412Z-dyna-scale-pg18`: 171,5 MB (z klastra 953 MB), kopia 1,2 s, `pg_verifybackup` 0,9 s,
identyfikator systemu `7700762086550167594`, początek `000000010000000000000031`.

**Zegar libfaketime.** Gdy generator cofa zegar bazy (`--simulate-days`), `archive_timeout` nie działa
(serwer widzi ostatnie przełączenie w przyszłości); segmenty archiwizują się po zapełnieniu. Granica RPO
obowiązuje przy prawdziwym zegarze (`SCALE_FAKETIME=off`, pomiar i zwykła praca). Odtworzenie do chwili
z biegu symulowanego: punkt przywracania (`pitr.mjs restore-point`), nie czas.

## 2. Odtworzenie fizyczne a problem ACL z kopii logicznej

Zestaw etapu 5 odtworzony do `--latest` na nowy kontener `dyna-recovery-src` (źródło prób, żeby nie
zabijać instancji etapu 5): weryfikacja 1,2 s, rozpakowanie 2,0 s, odtwarzanie WAL i promocja 1,4 s,
razem 5,1 s. Skróty ACL relacji (w tym sekwencji) i funkcji oraz liczby wierszy identyczne ze źródłem:

| baza | ACL relacji (md5) | sekwencje z jawnym ACL | ACL funkcji (md5) | zamówienia / zadania / ledger |
|---|---|---|---|---|
| `dynaminds_scale_20261026_04` (źródło i kopia) | `38d86e02…6dd` | 14 | `5716530c…af7` | 928 / 731 / `234_carriers` |
| `dynaminds_restore_36751abef3079f3f` (źródło i kopia) | `3be2c2a9…f4c` | 1 | `c938152c…ae7` | 428 / 731 / `217_crm_field_definitions` |

Kopia fizyczna przenosi katalogi bajt w bajt, więc niejawne ACL sekwencji z migracji 219/220 (gubione
przez `pg_dump`) zostają, a normalizator ACL nie bierze udziału. Edycja `server/ordinary-legacy-schema.mjs:29`
nie jest do tego potrzebna (ścieżka logiczna `npm run backup` nadal jej wymaga).

## 3. RPO: zapis, `kill -9`, odtworzenie, porównanie

```sh
node tools/recovery/pitr.mjs restore --set "$PWD/data/recovery/sets/20261027T035412Z-dyna-scale-pg18" --target dyna-recovery-rposrc --latest
node tools/recovery/rpo-drill.mjs --src dyna-recovery-rposrc --dir "$PWD/data/recovery/rpo-20261027"
```

Przebieg: kopia bazowa źródła (2,3 s) → jedna sesja `psql`, `INSERT … RETURNING` co 100 ms
(`synchronous_commit=on`, zwrócony wiersz = trwały zapis lokalny) → po przełączeniu
`000000020000000000000035` (zarchiwizowany 04:00:45,669) `docker kill --signal KILL` o 04:01:43,238,
czyli 2,5 s przed następnym przełączeniem → odtworzenie kopii bazowej + archiwum na nowy kontener
`dyna-recovery-rpo` (dysk danych traktowany jako utracony; 5,0 s) → porównanie.

| | ostatni potwierdzony zapis | ostatni po odtworzeniu | utrata |
|---|---|---|---|
| tylko archiwum (dysk danych utracony) | seq 1049, 04:01:43,187 | seq 482, 04:00:45,599 (ciągłe 1…482) | **57 588 ms, 567 wierszy** |
| awaria serwera, ten sam wolumen | seq 1049 | seq 1049 | **0** |

Najgorszy przypadek wynika z ustawienia: `archive_timeout` (60 s) + czas archiwizacji segmentu (~0,2 s).
Cel ≤15 min spełniony z zapasem ×15. Pliki zdjęć mają osobne RPO: `files-sync` (dopisujący mirror)
uruchamiany co ≤15 min (README: co 5 min); zdjęcie dodane po ostatnim przebiegu wraca jako wiersz bazy bez
pliku (API 404 „Plik zdjęcia jest niedostępny”).

## 4. Przepustowość odtwarzania WAL

Po kopii bazowej `dyna-recovery-rposrc` (2,5 s): `CREATE TABLE … 4 000 000 wierszy`, `UPDATE` całości,
indeks → 3 786 543 272 B WAL w 13 s; odtworzenie `--latest` na `dyna-recovery-replay`: odtwarzanie
WAL i promocja **11,96 s** (≈316 MB/s, ze startem kontenera), 4 000 000 wierszy po odtworzeniu
(`data/recovery/replay-20261027/{load.txt,restore.json}`).

## 5. Próba pełna: baza, pliki, klucze, konfiguracja, usługi, kolejka

```sh
D="$PWD/data/recovery/drill-20261027"
node tools/recovery/restore-drill.mjs --src dyna-recovery-src --template dynaminds_scale_20261026_04 \
  --db dynaminds_scale_20261027_91 --release "<local-builds>/scale-release-20261027-02/release-build.json" \
  --dir "$D" --passphrase-file "$D/passphrase.private" --orders 10                       # bieg 1 (z przygotowaniem)
node tools/recovery/restore-drill.mjs … --target dyna-recovery-t2 --from restore           # bieg 2 (ten sam zestaw i czas)
```

Przygotowanie na źródle (bez pomiaru RTO): klon `dynaminds_scale_20261027_91` z
`dynaminds_scale_20261026_04` (firma B: 250 SKU, 250 zamówień); faza 1 przez API wydania (fabryka
z dostępnym procesorem reguł, bez nasłuchu, więc nic nie jest przejmowane; fabryka 141,6 s): reguła
`order.created → add_note`, włączony lokalny worker, zdjęcie, 10 zamówień = 10 oczekujących zadań →
kopia bazowa zestawu (zdjęcie w migawce plików, zapieczętowane `local-config.json`, `postgresql.scale.conf`,
`compose.yml`, `Dockerfile`, `release-build.json`; 3,8 s) → faza 2 po kopii (10 zamówień i zdjęcie tylko
w WAL i w mirrorze plików) → `files-sync` (2 pliki) → wiersz kanarka `before`, **czas docelowy
2026-10-27T04:03:26.871Z**, wiersz kanarka `after`, przełączenie WAL (archiwum do `00000002000000000000003F`).
20 zadań oczekujących w źródle w chwili docelowej.

Odtworzenie (mierzone, nowy kontener i wolumeny):

| Faza | bieg 1 | bieg 2 |
|---|---|---|
| weryfikacja zestawu (sha256 9 plików, tryby 0600, identyfikator systemu w archiwum i `backup_manifest`, `pg_verifybackup`) | 1,36 s | 1,37 s |
| rozpakowanie kopii bazowej na pusty wolumen | 2,03 s | 2,07 s |
| odtwarzanie WAL do czasu docelowego + promocja (oś czasu 3) | 1,75 s | 1,74 s |
| pliki (1 z zestawu + 1 z mirrora), klucze (odpieczętowane, 0600), konfiguracja (4) | 0,04 s | 0,05 s |
| kontrole: kanarek, oczekująca kolejka | 0,10 s | 0,09 s |
| start wydania `ordinary-local-cli.mjs … --scoped-automation` do `ORDINARY_LOCAL_APP_LISTENING` (bramka schematu, zimna walidacja) | 144,6 s | 154,9 s |
| strażnicy 10/10, opróżnienie kolejki, odczyty API | 80,0 s (strażnicy 15,8; kolejka 63,8) | 80,0 s (15,8; 63,8) |
| **RTO razem** | **230,3 s** | **240,7 s** |

Po odtworzeniu: log serwera „starting point-in-time recovery to 2026-10-27 04:03:26.871+00”,
„recovery stopping before commit of transaction 15369, time 04:03:27.920656” (to wiersz `after`),
kanarek = tylko `before`, 20/20 zadań seeda `pending`, `attempts=0`.

Po uruchomieniu wydania (worker w procesie aplikacji):

- zadania: 40 × `done/attempts=1` (20 `automation` + 20 `automation.run`), `automation_runs` 20 × `done`;
- na każde z 20 zamówień: znacznik `drill-note-rmvq5o8wt` w notatce 1 raz, 1 zdarzenie `order.note_added`,
  1 wykonanie reguły;
- API z sesją odtworzoną z bazy (cookie `dyna_session`): `/api/health` 200,
  `/api/automations/:id/local-worker` 200, `state=ENABLED`, `processor_running=true`, zdjęcia z obu faz 200
  i sha256 zgodne z zapisanymi, `/api/orders/:id` 200 ze znacznikiem 1 raz (ścieżka odszyfrowania z kluczem
  z zestawu);
- restart wydania (SIGTERM, ponowny start 146,9 s, 15 s pracy workera): te same liczby, `drain_ms` 2–3 ms,
  brak drugiego przejęcia ani skutku.

## 6. Odmowy sprawdzone na Dockerze

| Próba | Wynik |
|---|---|
| archiwum z segmentem innego klastra (świeży initdb, id `7701197894153842738`, plik nazwany jak start zestawu) | `system identifier mismatch (WAL archive): backup set 7700762086550167594, WAL archive 7701197894153842738`; kontener i wolumeny nie powstały |
| `--target dyna-scale-pg18` | `refused: the stage 5 instance dyna-scale-pg18 is never a restore target` |
| złe hasło zestawu (`--passphrase-file` z innym hasłem) | `cannot open the sealed keys: wrong passphrase or changed key file` przed utworzeniem wolumenów |
| cel istnieje (`dyna-recovery-t1`) | `refused: container dyna-recovery-t1 already exists …` |
| sekrety w logach, raportach i kodzie | przeszukanie `data/recovery` (bez plików `*.private`, `local-config.json`, `*.sealed`, zestawów) oraz `tools/recovery` i testu: 0 wystąpień hasła bazy, klucza szyfrowania i hasła zestawu |

Testy części czystych (argumenty, manifest, identyfikator systemu z `backup_manifest` i nagłówka WAL, nazwy
plików WAL, pieczęć kluczy, plik hasła, ustawienia odtwarzania, okno RPO, ekstrapolacja, przycinanie):
`node --test tests/recovery-pitr.test.mjs` → 16/16.

## 7. Ekstrapolacja na pełny zbiór etapu 5 (100 tys. SKU / 100 tys. zamówień / 5 firm)

**To jest ekstrapolacja, nie pomiar.** Rozmiar: `dynaminds_scale_20261026_04` ma 176 MB przy 500 SKU
+ 500 zamówieniach na szablonie 139 MB (≈74 KB na parę SKU+zamówienie) → ~7,5 GB bazy pełnego zbioru;
przyjęto klaster **20 GiB** (zapas ×2,7). Zmierzony klaster: 1,18 GB (×18,25).

| Faza | zmierzone | podstawa | pełny zbiór |
|---|---|---|---|
| weryfikacja zestawu | 1,37 s | liniowo z rozmiarem | 25 s |
| rozpakowanie | 2,07 s | liniowo z rozmiarem | 38 s |
| odtwarzanie WAL | 316 MB/s | WAL od ostatniej kopii bazowej; założone ≤100 GB (kopia co 6 h) | ≤317 s |
| pliki, klucze, konfiguracja, kontrole | 0,15 s | stałe (zbiór profilu nie ma zdjęć) | 0,2 s |
| start wydania | 144,6–154,9 s | próg profilu „zimny start ≤180 s” (manifest sekcja 6), mierzony w etapie 5 | 180 s |
| strażnicy | 15,8 s | ×4 zapasu (niezmierzone powyżej 500 zamówień na firmę) | 63 s |
| kolejka (20 zamówień, 40 zadań) | 63,8 s | ~1,6 s na zadanie (patrz niżej) | 64 s |
| **razem** | 230–241 s | | **685–686 s ≈ 11,4 min** |

Granica pesymistyczna: gdyby zimny start i strażnicy rosły liniowo z rozmiarem (2 827 s + 288 s), razem
~59 min — tuż przy celu. Dlatego wynik zależy od pomiaru zimnego startu na pełnym zbiorze w etapie 5
(próg 180 s), a nie od samego odtwarzania bazy, które zajmuje ~6 min.

Kolejka: procesor reguł przejmuje jedno zadanie na regułę na cykl i czeka 1 s między cyklami
(`server/scoped-automation-worker.ts` w wydaniu `8ad4309`), więc ~1,6 s na zadanie, ~3,2 s na zamówienie z jedną regułą.
Aplikacja i API działają od startu; pełne opróżnienie zaległości mieści się w 60 min przy ≲900
oczekujących zamówieniach na regułę. **Nieaktualne od 8ecfe31**: sekcja 9.

## 8. Otwarte

1. Harmonogram kopii bazowych (co 6 h) i `files-sync` (co 5 min) jest opisany w `tools/recovery/README.md`
   (przykład `crontab`), ale nie został zainstalowany na tym komputerze: to trwała zmiana konfiguracji
   systemu, decyzja właściciela.
2. Sprawdzenie odtworzonej aplikacji przez UI (warunek 11: „UI i API”) nie zostało wykonane: CLI słucha
   tylko w przestrzeni sieciowej kontenera (`127.0.0.1:18190`), API sprawdzone stamtąd. Do przeklikania
   potrzebny jest przekaźnik portu na host.
3. Ekstrapolacja zimnego startu i strażników do pełnego zbioru (sekcja 7) — do potwierdzenia pomiarem
   w etapie 5. Przepustowość opróżniania kolejki: zamknięte w 8ecfe31 (sekcja 9). Kolejka 40 zadań
   opróżnia się w czasie kontroli strażników. Drenaż ≤120 s mieści ~3 400 zadań (bez obciążenia
   profilu). Tempo pod obciążeniem steady24 nie jest zmierzone.
4. Kontenery i wolumeny prób zostają (zatrzymane) jako dowód: `dyna-recovery-{src,t1,t2,rposrc,rpo,replay}`
   z wolumenami `…-data` / `…-wal-archive` (największy `dyna-recovery-replay-data` 8,2 GB). Usunięcie:
   `docker rm dyna-recovery-<x> && docker volume rm dyna-recovery-<x>-data dyna-recovery-<x>-wal-archive`.
5. `prune --apply` nie był uruchamiany (plan na instancji etapu 5: zostaje 1 zestaw, do usunięcia 48 starszych
   plików WAL sprzed `000000010000000000000031`).

## 9. Drenaż kolejki po zmianie procesora reguł (bieg 3, 27.10.2026)

Zmiana: `server/scoped-automation-worker.ts` w 8ecfe31 (opis i gwarancje:
`docs/parity/WORKERS-S3-20261025.md`, „Drenaż kolejki procesora reguł”). Przejście po regułach, które
przejęło pracę, uruchamia następne od razu. Przejście bezczynne albo z błędem dalej czeka 1 s.

**Pomiar w wydaniu** na klonach PG04 `dynaminds_qd_20261027_NN` (szablon
`dynaminds_restore_36751abef3079f3f`; jedna reguła `order.created → add_note`; 2 zadania na zamówienie;
pętla wydania startuje przy `listen`). Skrypt i logi:
`/private/tmp/claude-501/-Users-arturtwardowski-DYNA-Ecomerce/c4509fbf-d64d-4ac0-9f43-0a17b377d972/scratchpad/qd/release-drain.mjs`, `…/qd/logs/{before,after}-{200,1000}.txt`.

| Zadania | przed: `scale-release-20261027-02` (8ad4309) | po: `scale-release-qd-20261027-01` (8ecfe31) |
|---|---|---|
| 200 | 405,4 s (2027 ms/zadanie) | **5,5 s** (27,5 ms/zadanie) |
| 1000 | 443 w limicie 900 s (2032 ms/zadanie; całość ~34 min) | **34,7 s** (34,7 ms/zadanie) |

We wszystkich biegach: zadania `done/attempts=1`, 1 znacznik, 1 zdarzenie `order.note_added` i 1 wykonanie
reguły na przetworzone zamówienie.

**Bieg 3 próby** (wydanie `scale-release-qd-20261027-01`, manifest `9bdb4fe7…31aa0`, ten sam kontener źródłowy
`dyna-recovery-src`, nowa baza `dynaminds_scale_20261027_93`, katalog `data/recovery/drill-qd-20261027/`):

```sh
node tools/recovery/restore-drill.mjs --src dyna-recovery-src --template dynaminds_scale_20261026_04 \
  --db dynaminds_scale_20261027_93 --release <local-builds>/scale-release-qd-20261027-01/release-build.json \
  --dir "$PWD/data/recovery/drill-qd-20261027" --passphrase-file <plik operatora> --orders 10 --target dyna-recovery-t4 [--from restore]
```

Pierwsze odtworzenie (`dyna-recovery-t3`) odmówiło przy kontroli kanarka. Tabela `drill_canary` w kontenerze
źródłowym miała jeszcze wiersze biegu 1, a kontrola porównywała całą tabelę. Samo odtworzenie było poprawne
(wiersz `before` tego biegu jest, `after` nie ma; 20/20 zadań oczekujących). Kontrola sprawdza teraz tylko
wiersze bieżącego biegu (`tools/recovery/restore-drill.mjs`). Odtworzenie powtórzone `--from restore` na
`dyna-recovery-t4`:

| Faza | bieg 3 |
|---|---|
| weryfikacja zestawu / rozpakowanie / WAL + promocja | 1,81 s / 2,38 s / 1,75 s |
| pliki, klucze, konfiguracja, kontrole | 0,10 s |
| start wydania do `ORDINARY_LOCAL_APP_LISTENING` | 173,8 s (równolegle szedł test DB na PG04) |
| strażnicy 10/10 + kolejka + API | 16,5 s (strażnicy 16,1 s; kolejka już opróżniona: `drain_ms` 3) |
| **RTO razem** | **196,8 s** (biegi 1–2: 230,3 / 240,7 s, kolejka 63,8 s) |

Kolejka: 40/40 `done/attempts=1`, 20 wykonań, po 1 znaczniku i 1 zdarzeniu na zamówienie. Po restarcie
(165,3 s) te same liczby. Raport: `data/recovery/drill-qd-20261027/drill-report.json`. Kontenery
`dyna-recovery-t3` i `dyna-recovery-t4` zostają zatrzymane (usuwanie jak w punkcie 8.4).

**Nowa ekstrapolacja** (`extrapolation` raportu biegu 3): 626 s ≈ **10,4 min** na pełny zbiór. Kolejka
40 zadań wnosi 3 ms zamiast 64 s. Tempo procesora to ~29–36 zadań/s na proces, wspólne dla wszystkich reguł
(jedna pętla, jedno zadanie w toku):

- próg profilu „drenaż ≤120 s” mieści ~3 400–4 300 oczekujących zadań, czyli ~1 700–2 100 zamówień przy
  jednej regule;
- w budżecie RTO 60 min po ~10,4 min pozostałych faz zostaje ~49 min, czyli ~85 tys. zadań (~42 tys.
  zamówień przy jednej regule). Wcześniej było to ≲900 zamówień na regułę;
- tło profilu (automatyzacje 5/min × 5 firm ≈ 50 zadań/min) to ~0,1 % tej przepustowości.

**Niezmierzone:** tempo pod obciążeniem steady12/steady24. Dane wyżej pochodzą z bazy bez innego ruchu.

