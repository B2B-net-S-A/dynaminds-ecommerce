# N06 — zachowane dane, odczyt zamówienia i UI, 18.10.2026

**Częściowy odbiór lokalnego wydania PASS. Pełny Goal pozostaje aktywny.**

Wydanie `a07922b9455baf0b4116099cf9ac7b1100f16197ba3eb87110ff295722dbffd1`
z cięcia źródeł `4e5e96291b95fb696ee99bc43c78aff86244dfde` zawiera 382 pliki,
99 471 980 B i 11 entrypointów. Root oraz niezależny agent sprawdzili pełny roster,
rozmiary i hashe. Stage/check/frontend/emit zakończyły się EXIT0.
Zachowano limity 16 MiB na plik i 96 MiB na pakiet oraz natywny kontrakt 209.
Nowe źródła aplikacji są związane z cięciem 1279 plików, grafem 742 i 732 faktycznie
emitowanymi źródłami; nie przypisujemy ich autoryzacji staremu kontraktowi 59/25.
Pakiet nie zawiera nieodebranych 210 ani 211.

## Normalne przełączenie

Produktowy `stack.mjs stop` zamknął N05 łagodnie: stop 23938 EXIT0,
oryginalny proces 2327 EXIT0, bez sygnału. Bazy nie zatrzymywano ani nie odtwarzano.
Przygotowanie S4 zakończyło się EXIT0, zachowując dokładne bajty konfiguracji,
hasło, klucz i tę samą własną bazę na 57083. Zwykły start N06 osiągnął READY
na 4105 bez ręcznych grantów lub nadania approval. Oryginalny uchwyt 24967
pozostaje żywy; supervisor 65914 i aplikacja 65918 są własnością tego startu.

Osobny rzeczywisty odczyt PostgreSQL sprawdził tożsamość bazy i ownership nonce
oraz cały stempel 1703: generation i validated_generation 1703, dirty=false,
wszystkie wcześniejsze pola bez zmian poza zatwierdzonym release_sha256.
ROLLBACK i zamknięcie klienta potwierdzono. Health 200 wskazuje N06/schema209,
bez globalnych workerów, scoped rules, restore-preview i splitu.
Samo READY nie nadaje odbioru pełnego `ordinary187_valid()` ani crash recovery.

Późniejszy osobny rzeczywisty probe Root 79854 wykonał dokładnie raz
`SELECT public.ordinary187_valid() AS valid` i uzyskał TRUE w 4450,635 ms,
przy 8 s, UTC i jit=off, w READ ONLY. Tożsamość/nonce oraz cały stempel 1703
przed i po zgodne; ROLLBACK i end TRUE. Jest to świeży pozytywny wynik
pełnego walidatora na N06, bez przyznania powtarzalności, współbieżności,
recovery lub przyszłej instalacji 211. Nie zastępuje historycznych prób FAILED.

## Ten sam profil GET zamówienia

Zachowano przypięty profil N05, to samo zamówienie i sesję własnej firmy.
Każda wersja: 2 warmupy + 20 kolejnych próbek, współbieżność 1, timeout 15 s,
0 retry, worker zatrzymany. N06 dodatkowo sprawdziło health przed i po pomiarze:
łącznie 24 GET, 0 POST i 0 bezpośrednich SQL. Pełny DTO zamówienia odpowiada
poprzedniemu we wszystkich 22 odpowiedziach N06.

| Percentyl, ms | N05 | N06 |
| --- | ---: | ---: |
| p50 |731,690|329,140|
| p95 |1270,925|357,622|
| p99 |1312,418|369,939|

p95 w tej próbce spadło o 71,86% i mieści się w 500 ms. Niezależny przegląd
porównał 46 plików odpowiedzi, 44 pełne DTO zamówienia i przeliczył percentyle
nearest-rank z zapisanych czasów. Runner N06 mierzy do pełnego body, UTF-8
i JSON.parse, bez zapisu artefaktów; starszy receipt bazowy nie ma osobnego
pola opisującego punkt zakończenia zegara. To ograniczenie opisu starego dowodu.

**Nie jest to godzinny profil 100 tys. SKU / 100 tys. zamówień / pięciu firm / 12→24 klientów
z aktywnymi workerami, importem i synchronizacją. Kryterium 7 pozostaje otwarte.**

## Chrome i zachowany RMA

Root otworzył zwykłą sesję Chrome własnej firmy i istniejące zamówienie
DE-20261018-2B732E22. FV 44,01, przyjęty RMA 27,00, oczekujący refund 27,00
i potwierdzony refund 0,00 pozostały widoczne. Nowa strategia API zwraca 200:
`destinations`, available=false, unavailable_reason=`catalog_receipt_required`.
UI pokazuje wyjaśnienie i nie montuje starego panelu korekty z błędem 409.
Jest to poprawa komunikatu o ograniczeniu, **nie obsługa finansowa tego RMA**.

W formularzu nowej serii faktur B2C, po wypełnieniu pozostałych pól i zgody,
NIP 0000000000 pokazuje polski komunikat o sumie kontrolnej i blokuje zapis.
Prawidłowa wartość odblokowała przycisk; powrót do nieprawidłowej znów go
zablokował. Nie klikano zapisu serii. Zachowano AX i obejrzane zrzuty ekranu.
Początkowa próba native input wskazała etykietę zamiast pola; późniejszy exact
locator NIP nie uwzględnił dodanej podpowiedzi. Obie próby zatrzymały się bez
zapisu; ponowny wybór według aktualnego DOM zakończył weryfikację.

Po UI osobny rzeczywisty odczyt READ ONLY potwierdził cały stempel 1703,
jedno ukończone przyjęcie 148, zero powiązanych 169 i zero korekt 206.
Dwa pełne wiersze stock_movements są identyczne z dowodem N05.
ROLLBACK/end TRUE, końcowy health 200. Nie dodawano PZ, receipt 169, korekty
ani refundu. Wspólna implementacja 211 jest nadal niewpiętym kandydatem.

## Dowody

Wszystkie ścieżki są pod `local-builds/full-base-preview-20261017/`.

| Artefakt | SHA256 |
| --- | --- |
| `order-read-installation-app209-release-prepared-20261018-06/root-canonical-review.private.json` |`ea60f0533a054e8c1ef35c5ebd0119a18ce7fe8f95da1993867d00638cd49d3f`|
| `order-read-installation-runtime-root-20261018-04/root-start-intent.private.json` |`94b6625468d949cb8f3b9809b419996449df580f5887313c1d88df5d6f2c46f2`|
| `order-read-installation-runtime-root-20261018-04/app-ready-root.private.json` |`fed610761407f1455e56d8decd724e4dbf77775d3eaf7a0f0a51c9d9e3423240`|
| `order-get-after-n06-prepared-agent-20261018-01/run01/result.private.json` |`e3b1eabbdbceca2f6291804fe65ebdceae2a6c02e2f204c91dd6f8e2cada3ae6`|
| `order-read-installation-runtime-root-20261018-04/post-ui-root.private.json` |`dc9b904493b83c3f85816074183a01af345c377cda23e282a6bbf55009a6829d`|
| `order-read-installation-runtime-root-20261018-04/post-ui-strategy-root.private.json` |`d579e757c61a57e3ed27012e089e6868daab681884481aeb9644e2516d7f7380`|
| `order-read-installation-runtime-root-20261018-04/full187-probe-root.private.json` |`c8e0855d4bbea00ff6eeb36c844713c6eb88877dbfdd61f7bcc26acefddc6bb1`|

Otwarte: rzeczywista korekta/refund istniejącego RMA, powtarzalność pełnego 187
po zachowanych timeoutach, split, pozostałe procesy i integracje, crash recovery, skala i końcowe
wspólne wydanie. Odbiór GET/UI N06 nie zamyka żadnego z tych pełnych obszarów.
