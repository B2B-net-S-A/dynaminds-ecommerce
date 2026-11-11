# Split210 — materializacja snapshotu: diagnostyka lokalna

**Wynik: zgodność PASS, brak podstaw do promocji Source32.** Rzeczywisty DIAG34
zakończył się EXIT0 po około114,685s. Mediana bezpośredniego zapytania poprawiła
się o0,289ms (1,20%), p95 o0,148ms (0,59%). Ten pomiar nie dowodzi usunięcia
limitu8s pełnego `ordinary187_valid()` ani korzyści po wpięciu w funkcję/SPI.

## Rzeczywisty zakres

Po199+27 etapach źródeł i czterech kontrolach210/209/buyer/return-credit TRUE
wykonano dwa odczyty pełnego publicznego snapshotu, dwie pary rozgrzewki i20
naprzemiennych par bezpośrednich zapytań: oryginalnego oraz z jednym dodatkowym
`own209_current AS MATERIALIZED`. Nie tworzono funkcji kandydata. Wszystkie46
porównań całych wartości były zgodne; zapisany wynik zawiera17 różnych funkcji,
każda z pełnym zestawem24 pól. Świeża kontrola potwierdziła brak211 w ledgerze,
tabelach i funkcjach tej pustej kompilacji209→Source31.

|20 mierzonych próbek każdego wariantu|Oryginał|Kandydat|
|---|---:|---:|
|Średnia|24,312656ms|24,031669ms|
|Mediana|24,145792ms|23,856583ms|
|p95, nearest rank|25,317333ms|25,169042ms|
|Minimum–maksimum|23,866125–25,529000ms|23,564083–25,360417ms|

Kandydat był szybszy w16/20 par. Pełny publiczny snapshot przed/po trwał
37,685292/37,893125ms; nie zastąpiono go kandydatem. To mała różnica jednego
zapytania w jednym lokalnym przebiegu, bez deklaracji istotności statystycznej,
p95 całego produktu lub pomiaru tej samej granicy funkcji/SPI.

## Zachowane dane i zakończenie

Status `SOURCE31_OWN_SNAPSHOT_DIAGNOSTIC_ROLLED_BACK_PENDING_ROOT_REVIEW`
oznacza zaplanowany wyjątek po zakończeniu porównania, nie błąd kompilatora.
Pełny katalog40995 rekordów po210 i po diagnostyce jest identyczny bajtowo:
oba gzip6345003B mają SHA `4562b7a6ca27e9b67f71fac59b366c5cfd292fb391a1666072e8438d4b3fbc3f`,
a serializacja64683516B SHA `7f2581fb847dc03070fbf729ed0bc798f1a95cf4262e4fd9977aa7e2b4c74456`.
Niezależny przegląd plików porównał84 pełne artefakty28 starych tabel
certyfikatów i ich28 surowych hashy. Całe18 ról przed/po jest zgodne.
Stempel generacji i manifesty bez zmiany; ROLLBACK, DROP własnej bazy przy0
połączeń oraz zamknięcie obu klientów potwierdzone.

Pełny187 po instalacji210, COMMIT, Native i aktywacja nie zostały wykonane.
Helper pozostaje niewpiętym kandydatem źródłowym. Wcześniejszy timeout C33
pozostaje otwarty; nie promujemy tej optymalizacji jako jego naprawy.

## Dowody

- [Receipt DIAG34](../../../../local-builds/full-base-preview-20261017/order-split210-own-snapshot-diagnostic34-prepared-20261018-01/run/receipt.private.json):138492B, SHA `36d7efe8dcbf845190f6aff96ad564be8ad225aec2667407cf8be8ba63b2c8ba`.
- [Pełne czasy i granice](../../../../local-builds/full-base-preview-20261017/order-split210-own-snapshot-diagnostic34-prepared-20261018-01/run/diagnostic34.comparison.private.json):11577B, SHA `02e6750cccadd9ec22ba0c22cb512a05f008fa77f93f4a1a8f7149c4768e148a`.
- Uruchomiony caller104050B/SHA `751f37e5153b529df4659a765ab338c824dd4015668a3c6107aa36a6cb3b85f7`; spec144946B/SHA `92a0f9683336c37de903655016cb63219ef6edab31f660d4e2780323525bb14c`.
- [Kandydat](../../tools/parity/order-merge-delivery209-snapshot-own-materialized.mjs):9198B/SHA `ff62a181089ca7aef9f4e04edc4836ed99891fa089e45d30c5909bb0adc04564`; jego testy i inverse są dowodami źródeł, nie odbiorem biznesowego podziału.

Trzy jawne mapowania historycznych pinów runtime dopuszczono wyłącznie w tej
diagnostyce. Moduły startup/profile nie są wykonywane przez jej ścieżkę źródeł;
nie ogłaszamy ogólnej równoważności starszego i nowszego startupu. Nie zmieniono
historycznych specyfikacji C33, V31, zakresu walidacji ani limitów.
