# Split210 — profil jednego pełnego wejścia187

Status: **DIAGNOSTIC_ROLLED_BACK_NOT_ACCEPTED**. Data: 18.10.2026.
Źródła Source31 i nieudany C33 pozostają zachowane; nie uruchomiono ponownie C33.

Root85163 wykonał nowy DIAG35 i zakończył go EXIT0. Jest to poprawnie zakończona
diagnostyka z rollbackiem, a nie udany odbiór badanego zapytania.
Po199 etapach rodzica,27 etapach210, pełnym493/22 inverse i źródłowym sealu
cztery osobne guardy210/209/buyer/return-credit zwróciły TRUE. Następnie dokładnie
jeden `SELECT public.ordinary187_valid() value` przekroczył niezmienione8s:
`57014` po8002,216792ms. Wynik logiczny187 pozostaje nieznany.

## Co zmierzono

Śledzenie `track_functions=all` włączono przed czterema guardami. Baseline
pobrano dopiero po nich, bezpośrednio przed badanym187. Zapisano50 wierszy
BEFORE i116 AFTER:50 OID ma porównywalne liczniki,66 ma **nieznaną deltę**.
Nieobecnego wiersza BEFORE nie zastąpiono zerem.

| Funkcja | Rzeczywisty przyrost calls | Przyrost SELF, ms | Przyrost TOTAL, ms |
|---|---:|---:|---:|
| `order_split210_valid()` |279|4382,507790|4382,507790|
| `order_merge_delivery209_validation_snapshot()` |40|836,375251|1466,681085|
| `order_split210_try_function_projection(fn oid)` |3793|164,019018|2090,401601|
| `order_split210_is_added_trigger(fn oid)` |1945|54,267511|538,399885|

Wartości są różnicami zgłoszonych liczników dla tych samych OID, nie liczbą
wszystkich rozpoczętych prób. Anulowane lub nadal wykonywane ramki mogą nie
mieć kompletnych statystyk; część funkcji może nie być śledzona. TOTAL zawiera
zagnieżdżone wywołania i nakłada się pomiędzy wierszami. **Nie sumujemy tych
czasów**, nie rekonstruujemy z nich pełnego drzewa ani kompletnego czasu187.
Śledzenie dodaje narzut. To jeden anulowany pomiar, bez p95, skali lub odbioru8s.
Odczytane nazwy i SHA bieżących funkcji służą opisowi OID; nie są źródłem
oczekiwanego kontraktu.

## Zachowane kontrole

Po pobraniu statystyk przywrócono `track_functions=none` oraz `statement_timeout=8s`.
Całe skompresowane katalogi przed i po badanym wejściu są bajtowo identyczne:
40995 rekordów, pełna serializacja64683516B/SHA256
`7f2581fb847dc03070fbf729ed0bc798f1a95cf4262e4fd9977aa7e2b4c74456`.
Pozostały zgodne generacja, manifest i rodzice. Niezależny przegląd porównał
84 pełne payloady trzech zestawów28 starych certyfikatów oraz dodatkowe28
po profilu — wszystkie112 są zgodne z odpowiednimi pełnymi wartościami BEFORE.
18 pełnych ról przed/po/final pozostaje identycznych.

Potwierdzono ROLLBACK, DROP wyłącznie własnej bazy przy0 połączeniach i zamknięcie
obu klientów.311 aktywnych odwołań do148 różnych plików sprawdzono z dokładnymi
pinami; tylko trzy jawne historyczne mapowania runtime do zaakceptowanych bajtów
35a89ca pozostają diagnostyczną granicą pochodzenia. Nie zmieniono V31,
programu Source31 ani jego oczekiwań na podstawie obserwowanego katalogu.
COMMIT, Native, aktywacja i odbiór biznesowego splitu nie zostały wykonane.

## Następny cel, bez promocji mikrooptymalizacji

Pierwszym celem jest **SELF pełnego `order_split210_valid()` oraz liczba
rzeczywistych wejść do niego**.3793 wywołania projektora nie oznaczają3793
pełnych guardów: istniejące tanie odrzucenia zakresu trzeba zachować.
Możliwa poprawka musi utrzymać cały roster,24 pola, pełne hashe, świeżość,
odmowy przy mutacji i dotychczasowe granice SPI/MVCC. Bez cache decyzji,
trusted-frame, pomijania guardów lub podnoszenia limitu.

DIAG34 pozostaje zamkniętym pomiarem komponentu:20 zrównoważonych par pełnych
zapytań miało p95 baseline25,317333ms i kandydata25,169042ms, różnicę poniżej1%
(−0,586%). Mediany24,145792/23,856583ms nie zmieniają tej decyzji. Materializacja
własnego producenta nie uzasadnia kolejnej pełnej kompilacji ani promocji
Source32. Nie zmieniono nią publicznej funkcji lub generatora. Wcześniejszy
[financial composite odrzucony z powodu MVCC](SPLIT210-FINANCIAL-COMPOSITE-REJECTED-20261018.md)
nadal pozostaje odrzucony.

## Dowody

Ścieżki względem katalogu głównego DYNAMINDS Ecommerce:

- `local-builds/full-base-preview-20261017/order-split210-full187-call-profile35-prepared-20261018-01/run/receipt.private.json`:
  129214B, SHA256 `c94c21b647d0e7d3ee293b4492c4fa12445b4fc8f48f76fdb9217fffdf3be7c7`.
- W tym samym katalogu `profile35.function-runtime-profile.private.json`:
  85910B, SHA256 `8d9801f62dd699c33fc396ed4e9785e8a7029d9eb3c92ad14e38c65f752e1bc1`.
- `profile35.statistics-before.private.json`:3913B, SHA256
  `b3a5fa6f112edcc3a4357cd2d257360e9ddab35e075cbb903723da0ea237cef0`;
  `profile35.statistics-after.private.json`:8951B, SHA256
  `6143e5e7925f64df81f8a4e5319a808bad67fb77b656896a589b4d6c63f875ea`.
- `local-builds/full-base-preview-20261017/order-split210-own-snapshot-diagnostic34-prepared-20261018-01/run/receipt.private.json`:
  138492B, SHA256 `36d7efe8dcbf845190f6aff96ad564be8ad225aec2667407cf8be8ba63b2c8ba`.

[Historyczny wynik C33](SPLIT210-C33-LOCAL-20261018.md) nadal jest FAILED.
Pełny Goal, Native210 oraz split UI/API/WMS, recovery i skala pozostają otwarte.
