# Etap 3 (finanse i wymogi prawne): próba odbioru na jednym wydaniu, 27.10.2026

Stan: **próba przeszła lokalnie: 357/357 kontroli, po restarcie 20/20.** Jest to szkic wpisu do matrycy, a nie odbiór
etapu. Odbiór wymaga oficjalnych XSD JPK i kont testowych dostawców (sekcja „Co blokuje prawdziwy odbiór”).

Kryterium: dokumenty i rozliczenia zgadzają się co do grosza z zamówieniami i zwrotami, eksporty prawne mają
poprawną strukturę, a odbiór jest lokalny (KSeF: lokalny kontrakt). Podejście jest takie samo jak przy etapie 2
(`STAGE2-N29-LOCAL-20261023.md`):
- jedno spakowane wydanie i świeża kopia PG04;
- skrypt odbioru wyłącznie przez zwykłe HTTP z ciasteczkiem sesji (rejestracja firm, zero SQL, zero wywołań w procesie);
- przebieg z zapisem stanu, potem restart i odczyt kontrolny.

## Środowisko

| | |
|---|---|
| Wydanie | `stage3-rehearsal-20261027-02` z `tools/scale/release-build.mjs`. Commit `c9515e1` = `7aace7f` + poprawka raportu rozliczeń (niżej) + skrypt. Manifest `1f679b62…ee08d`, schemat 244 |
| Wydanie pierwszego przebiegu | `stage3-rehearsal-20261027-01`, commit `7aace7f`, manifest `10dceecf…1a40d`. Tu wyszła luka 206 w raporcie rozliczeń |
| Baza | PG04 `127.0.0.1:57084`, klon `dynaminds_s3acc_20261027_03` z `dynaminds_restore_36751abef3079f3f`. Migracje do 244 zrobiła fabryka wydania. Start ze świeżego klonu (klon + migracje) ok. 3,5 min |
| Uruchomienie | `runtime/server/ordinary-local-cli.mjs <selection> <sha> 4127 --verified-stock-writers`, środowisko `env -i`, a w nim `DYNA_KSEF_FAKE=local`, `DYNA_PAYU_FAKE=local` i `DYNA_MIGRATION_BACKUP=off` (wyjaśnienie w „Odstępstwach”) |
| Atrapy (tylko pętla zwrotna) | drukarka fiskalna 233, KSeF 2.0 (atrapa zakupowa 243 z wewnętrzną atrapą 229 do wysyłki), PayU w trybie symulacji wewnątrz wydania. Kurs NBP wpisany ręcznie, bo port pobierania NBP jest w tym wydaniu wyłączony (503). Żadnego połączenia z MF, KSeF, PayU ani NBP |
| Skrypt | `tools/parity/stage3-acceptance.mjs run\|after-restart`. Atrapy i start są poza repozytorium, w katalogu sesji `scratchpad/s3acc/` (`fakes.mts`, `start.sh`) |
| Dowody | `local-builds/full-base-preview-20261017/stage3-rehearsal-20261027-02/evidence-03/` (szczegóły pod tabelą) |

Pliki dowodów:
- `stage3-acceptance-run.json` (sha256 `0f77ee89…5d53f`);
- `stage3-acceptance-after-restart.json` (sha256 `19732cd9…1cef3`);
- `screenshots/A-rozliczenie.jpg`, `screenshots/B-rozliczenie-kor188-206.jpg`;
- stan i wygenerowane hasła testowe w `*.private.json` (0600).

## Dane

Dwie nowe firmy, obie z rejestracji `/api/auth/signup` i na planie enterprise, każda z serią 157:
- **Firma A:** wszystkie procesy poza 188/206.
- **Firma B:** KOR 188 i KOR 206/207. Wymagają ścisłej kontroli magazynu (169) i asystenta zwrotów, które zmieniają
  zasady całego katalogu, więc działają w osobnej firmie.

Zamówienia przeszły pełną ścieżkę przez HTTP: utworzenie, opłacenie (wpłata), kompletacja ze skanami, spakowanie,
wysyłka.

## Wyniki według wymagań

| Proces | Kontrole | Wynik | Dowód (nazwa kontroli w `stage3-acceptance-run.json`) |
|---|---|---|---|
| FV 157 | 15 | PASS | 3 faktury z liniami 23/8/5/0 % i wysyłką: brutto = suma zamówienia; Σ stawek = sumy; wpłata = suma; powtórzenie wystawienia zwraca ten sam dokument (`reused`); numery `S3A…/2026/000001–3` ciągłe; GTU_06 w migawce 226; druga FV dla zamówienia → 409 |
| Model VAT 226 i FV-S 230 | 22 | PASS | MPP (B2B > 15 000 zł, pozycja z zał. 15) → `mpp.required`; ZW z podstawą P_19A; NP II dla DE B2B z VAT UE; OO dla czynnego podatnika PL; OSS DE 19 % (VAT = 19 % netto co do grosza); OO dla konsumenta → blokada; brutto = zamówienie; powtórzenia `reused` |
| EUR i NBP 227 | 7 | PASS | Kurs ręczny tabeli A z dnia poprzedniego (`208/A/NBP/2026`, 4,2563). Pobieranie NBP → 503 („wpisz ręcznie”). PLN netto i VAT = EUR × kurs, zaokrąglenie połówkowe na kategorię; zapis 227 z kursem |
| KOR-S 232 | 6 | PASS | Anulowanie: delta = −brutto FV-S, a drugie anulowanie → 409. Zwrot: delta = −kwota zwrotu pieniędzy. Powtórzenia `reused`; numeracja KOR-S 1, 2 |
| KOR 188 i KOR 206/207 | 12 | PASS | FV 4401. Zwrot zwykły (z przyjęciem 169) → KOR 188 `KOR/…/000001` −1000. Zwrot przez asystenta i miejsca docelowe (przechowanie + odrzut) → kredyt 1700, strategia `destinations`, KOR 206 `KZ…/2026/000001` −1700, po korekcie 1701. Powtórzenia `reused`; 188 odmawia zwrotu z miejsc docelowych (409) |
| Paragony 233 i raport dobowy | 18 | PASS | 3 paragony: brutto = zamówienie, numery ciągłe. Powtórzenie nie drukuje drugi raz (atrapa ma 3). Drugi paragon → 409. Raport dobowy `matches` i Σ brutto = Σ paragonów; powtórzenie `reused`. FV-S do paragonu: brutto = paragon, link do numeru paragonu, FA(3) `<FP>1</FP>`. FV 157 dla zamówienia z paragonem → 409 (przy wystawieniu) |
| KSeF 229/231 (wysyłka i UPO, lokalna atrapa) | 21 | PASS | Sprawdzenie konfiguracji ok; prawdziwy MF wyłączony. FV 157 i 4 FV-S (MPP, OO, EUR, NP II) przyjęte z numerem KSeF; UPO zawiera numer. Ponowna wysyłka `replayed` bez nowej faktury w atracie. Awaria KSeF → kolejka offline → „wyślij kolejkę” → przyjęte. KOR-S (232) przyjęta |
| KSeF 243 (zakupy, atrapa) | 10 | PASS | 3 faktury zakupowe pobrane; ponowne pobranie zapisuje 0 (deduplikacja po numerze KSeF); rejestr ma 3 pozycje; bajty FA(3) z rejestru = bajty z KSeF (sha256) |
| JPK_V7M, JPK_V7K, JPK_FA (tylko struktura) | 142 | PASS | Opis kontroli pod tabelą |
| Raport rozliczeń | 82 | PASS | Opis kontroli pod tabelą |
| RODO 228 | 9 | PASS | Eksport ZIP (`dane-klienta.json`) z obu zamówieniami i fakturą. Podgląd: zamówienie z fakturą zostaje do 31.12.2031 (retencja podatkowa). Anonimizacja i powtórzenie potwierdzenia (`replayed`, ten sam wynik). E-mail i telefon zanonimizowane, nazwisko na zamówieniu z fakturą zostaje, zamówienie bez faktury zanonimizowane w całości. Dokument FV i JPK_FA bajt w bajt bez zmian. Rejestr dostępu: export, anonymisation_preview, anonymisation |
| PayU 242 (symulacja) | 8 | PASS | Sesja 201 na kwotę zamówienia; ten sam `client_key` → ta sama sesja. Strona atrapy → 303; drugie zakończenie nie księguje nic. Jedna wpłata PayU = suma; status `paid`; sesja COMPLETED. FV po wysyłce = kwota PayU; w raporcie rozliczeń `zgodne` |
| Numeracja (rejestry) | 3 | PASS | Rejestr 157 i rejestr FV-S ciągłe od 1; liczba w rejestrach = liczba wystawionych w przebiegu |
| Po restarcie | 20 | PASS | Ta sama rewizja. Każdy dokument (19: 16 firmy A, 3 firmy B) identyczny; V7M, V7K i JPK_FA obu firm identyczne (bez `DataWytworzeniaJPK`); raporty rozliczeń identyczne (bez `generated_at`); numery KSeF, raport dobowy, sesja PayU i rejestr 243 bez zmian |

Kontrole JPK (wszystkie trzy pliki dla obu firm):
- nagłówek `JPK_V7M (3)`, `JPK_V7K (3)` i `JPK_FA (4)` z okresem;
- liczba wierszy = dokumenty (+1 wiersz RO raportu dobowego), a `LiczbaWierszySprzedazy` się zgadza;
- `PodatekNalezny` = Σ VAT wierszy bez wierszy FP, bo te są już w RO;
- VAT wiersza = VAT dokumentu w PLN (EUR po kursie 227), z wyjątkiem OSS;
- `NrKSeF` = numer z KSeF dla wysłanych, a BFK/OFF dla pozostałych;
- znaczniki GTU_06, MPP, `TypDokumentu` FP i RO, OO w K_31, NP II w K_11/K_12, ZW w K_10;
- deklaracja V7M (P_38);
- JPK_FA: `LiczbaFaktur`, `WartoscFaktur` = Σ P_15, P_15 każdej faktury lub korekty = brutto dokumentu, `LiczbaWierszyFaktur`.

Kontrole raportu rozliczeń (16 zamówień A ze skryptu, w tym 1 EUR, i zamówienie B):
- `order_total` = zamówienie;
- zgodne zamówienia mają flagi `['zgodne']`, a zapłacono netto = należność = udokumentowano;
- w firmie B: 4401 wpłacone, 2700 zwrócone, korekty −2700 (188 + 206), udokumentowane 1701 = należność, `zgodne`;
- częściowy zwrot w A: zwrócone = uznane, korekty = −zwrot;
- sumy = Σ wierszy w 6 polach, a CSV ma wiersz na każdy wiersz JSON;
- celowe rozbieżności są oznaczone dokładnie:
  - anulowanie KOR-S przy zatrzymanym zamówieniu → `faktura_niezgodna`, różnica = −suma;
  - zamówienie bez faktury → `brak_faktury`;
  - zamówienie w EUR jest osobno.

UI: obie firmy przeklikane w przeglądarce, Dokumenty → „Rozliczenie płatności, faktur i korekt”:
- **A:** 17 zamówień PLN (15 zgodnych oraz celowe „Korekta bez zwrotu” i „Brak faktury”) i 1 EUR;
- **B:** 1 zamówienie zgodne, korekty −27,00 zł (2 dokumenty).

## Błędy produktu

1. **Naprawiony: raport rozliczeń pomijał KOR 206/207.**
   - Przyczyna: `server/settlement-report-data.ts` czytał korekty 188 (`local_consumer_credit_documents`) i 232, ale nie `return_credit206_documents`.
   - Objaw na wydaniu 01: zamówienie B wykazywało korekty −1000, udokumentowane 3401 i flagi `zwrot_bez_korekty` + `faktura_niezgodna`, choć JPK obejmował KOR 206.
   - Test RED: `tests/settlement-report-kor206.test.ts` („[−1000, 3401 …] ≠ [−2700, 1701 …]”).
   - Poprawka: ten sam odczyt co dla 188. Prawo SELECT dla `dyna_app` i RLS już istnieją. Migracja niepotrzebna.
   - GREEN: 27/27 (`settlement-report*`, `receipt233-settlement`), `tsc --noEmit` bez błędów.
   - Na wydaniu 02 zamówienie B jest `zgodne` (API i UI).
2. **Do decyzji: kopia przed migracją (MIG-3) zapisuje do katalogu wydania i blokuje kolejne starty.**
   - Domyślnie `DYNA_MIGRATION_BACKUP=required`. Katalog kopii i klucz są liczone względem cwd: `server/migration-backup.ts:23` (`resolve('data/backups/pre-migration')`) i `server/recovery.ts:126` (`resolve('.recovery-key')`).
   - CLI wydania uruchamia się z katalogu wydania, więc pierwszy start na klonie z oczekującymi migracjami utworzył w nim `release-canonical/.recovery-key` oraz `data/backups/pre-migration`. Klucz powstaje przed `pg_dump` (`server/recovery.ts:311`).
   - Kopia się nie udała (`MigrationBackupError`). CLI wypisuje tylko nazwę błędu (`ORDINARY_LOCAL_START_FAILED`), więc przyczyna jest **niepotwierdzona**.
   - Następny start padł na `emitted-exact-inventory` (+ `.recovery-key`), także z `DYNA_MIGRATION_BACKUP=off`.
   - Obejście w próbie: usunięcie tych plików i `DYNA_MIGRATION_BACKUP=off` na jednorazowych klonach.
   - Poprawka (gdzie domyślnie trzymać kopię i klucz dla wydania, czy CLI ma wypisywać przyczynę) to decyzja projektowa. Nie jest lokalna, więc nie została zrobiona.
3. **Uwaga, nie błąd:** FV 157 do zamówienia z wydrukowanym paragonem jest odrzucana dopiero przy wystawieniu (409 „wystaw jako FV-S”). Podgląd 157 przechodzi (201).

## Odstępstwa od produkcyjnego uruchomienia

- `DYNA_MIGRATION_BACKUP=off`: jednorazowe klony, patrz błąd 2.
- `--verified-stock-writers`: bez tej flagi aktywacja ścisłej kontroli magazynu (wymagana przez 188/206) daje 503 „Adaptery wszystkich fizycznych writerów wymagają certyfikacji”.
- Daty dokumentów są dzisiejsze (wydanie wystawia z bieżącą datą), więc okres JPK to 2026-10.
- Kurs NBP wpisany ręcznie. Wydanie ma tylko flagę `--nbp-eur`, która łączy się z prawdziwym api.nbp.pl, a tego nie wolno.

## Co blokuje prawdziwy odbiór

- **Oficjalne XSD:** `JPK_V7M_3.xsd`, `JPK_V7K_3.xsd`, `JPK_FA_4.xsd` i FA(3). Katalog `data/source-drafts/jpk-official-xsd/` nie istnieje, więc `server/jpk-xsd.ts` zwraca `skipped`. Struktura jest sprawdzona tylko wewnętrznie (sumy kontrolne, wiersze, znaczniki), bez walidacji schematem MF.
  - **30.10.2026, gałąź pasa XSD (do integracji):**
    - schematy MF FA(3), JPK_V7M(3), JPK_V7K(3) i JPK_FA(4) są w `schemas/mf` (manifest z sha256);
    - walidator offline `server/mf-xsd.ts`;
    - generatory JPK poprawione;
    - pobranie FA(3) i JPK oraz wysyłka KSeF odmawiają (422) pliku niezgodnego ze schematem;
    - szczegóły w `FA3-ALL-DOCS-20261023.md` i `JPK-20261023.md`, sekcje „Walidacja XSD”.
  - Ta próba odbioru jest sprzed zmiany. Na wydaniu trzeba ją powtórzyć.
  - Dopóki pakiet wydania nie zawiera `schemas/mf`, wydanie odpowiada `X-Walidacja-XSD: pominieta`.
- **KSeF:** środowiska `test`/`demo` MF są w wydaniu wyłączone (`KSEF_REAL_ENABLED=false`). Brak tokenu i NIP testowego, więc wysyłki i UPO 229/231/232 oraz pobranie 243 są potwierdzone tylko na lokalnej atrapie.
- **PayU:** brak konta sandbox (POS, `second_key`). Powiadomienia przyszły tylko przez stronę atrapy. Zwrot przez PayU zostaje w atracie jako PENDING (bez `finalizeRefund`), więc nie jest objęty tą próbą.
- **NBP:** brak zgody na odczyt api.nbp.pl (`--nbp-eur`), kurs wpisany ręcznie.
- **Drukarka fiskalna:** tylko atrapa protokołu (Posnet, Elzab i Novitus nie są sprawdzone na urządzeniu).
- **MIG-3:** kopia przed migracją na wydaniu (błąd 2).
