# Return-credit211 — zwykły UI i lokalne rozliczenie

Data: 18.10.2026. Zakres: jeden istniejący zwrot konsumencki na zachowanej
oryginalnej bazie. **PASS w tym lokalnym zakresie:** normalna aktualizacja,
Chrome, końcowe osiem GET oraz pełne uzgodnienie SQL potwierdziły jedną korektę
i osobne lokalne potwierdzenie rozliczenia. Pełny Goal pozostaje otwarty.

## Wydanie i zwykła aktualizacja

N07: `9f0336c203ec7edb3d884e7b0c621caec492f13dab3af9c95f1bbca62eb58ccf`,
źródła `35a89ca2bdc2786a36ef4beeb9738cf9ee30ebc9`.
Oryginalną aplikację uruchomiono normalnie na porcie 4105 po wcześniejszym
sprawdzeniu nowego wydania na odtworzonej kopii. Zwykły migrator zainstalował
`211_return_credit148_acceptance`; nie odtwarzano ani nie zastępowano
oryginalnej bazy kopią, na której NativeQA wystawił już osobną korektę.

Root READY potwierdził przed czynnościami UI:

- 625 wcześniejszych tabel, 627 po aktualizacji; 623 stare tabele identyczne;
- Dodane wyłącznie `return_credit211_acceptances` i `return_credit211_metadata`;
- Oczekiwane zmiany wyłącznie w `migrations` i `ordinary182_runtime_generation`;
- Pełne cztery historyczne receipts206 i źródłowe metadata zachowane, cztery
 typowane historyczne parent211;
- Normalnie zatwierdzoną generację 1744, `dirty=false`, `validated_generation=1744`,
 dokładną rewizję N07 oraz ROLLBACK i zamknięcie klienta odczytu.

Powyższe porównanie 623 tabel dotyczy **aktualizacji przed UI**. Późniejsze
wystawienie korekty i potwierdzenie rozliczenia legalnie zmieniają dane
finansowe oraz RMA; nie należy przedstawiać ich jako operacji bez zapisów.

## Rzeczywisty proces Chrome

Użyto wcześniej utworzonej FV 44,01 zł i RMA `RMA-2026-A0F59914`, z zakończoną
decyzją sale 1 / custody 1 / reject 1. Nie powtarzano fizycznego przyjęcia i nie
fabrykowano receipt169. Nowa ścieżka211 autoryzuje rzeczywistą historię148.

1. W zwykłym panelu utworzono serię `KOR-RMA211`.
2. Po osobnym potwierdzeniu przygotowano pełny podgląd korekty −27,00 zł.
3. Po kolejnym potwierdzeniu wystawiono numerowaną korektę
   `KOR-RMA211/2026/000001`; dokument
   `db26866e-7092-474c-b811-95dd183c2666`. Otworzono również widok druku.
4. Osobno w RMA potwierdzono lokalne rozliczenie 2700 z referencją
   `LOCAL-TEST-NO-TRANSFER-RMA211-20261018`. UI pokazał zamkniętą sprawę,
   potwierdzone 27,00 zł i komunikat, że system nie wykonał przelewu.

To **lokalny zapis potwierdzenia operatora**, bez wypłaty przez dostawcę
płatności, bez KSeF i bez fiskalizacji. Nie jest dowodem rzeczywistego transferu
pieniędzy. Odbiór Native na kopii pozostaje osobnym etapem opisanym w
[raporcie preflight/Native](RETURN-CREDIT211-PREFLIGHT-LOCAL-20261018.md).

## Końcowy odczyt zwykłego API

Root zapisał osiem odpowiedzi 200: health, strategy, source, order, returns, RMA,
payments, document. Sam odczyt obejmował 8 GET i 0 POST; nie jest to liczba zapisów
wcześniejszej sesji Chrome.

Kwoty minor w poniższych odczytach podano w groszach PLN; 2700 oznacza 27,00 zł.

| Odczyt | Potwierdzony wynik |
|---|---|
| Health | N07, schemat211, restore_preview=false; globalne workery, scoped automation i split210 wyłączone. |
| Strategy/source | `destinations`, dostępne; po wystawieniu `eligible=false`, `already_credited`, jedna poprzednia korekta i jedna rodzina dokumentu. |
| Dokument | Jedna numerowana korekta −2700; kwoty brutto przed 4401, po 1701. Netto/VAT korekty −2195/−505. |
| RMA | `closed`, wersja 3; `settlement.amount=2700` z potwierdzeniem i wersją żądania 2. |
| Płatności | `received=4401`, `refunded=2700`, `credit=2700` i `return_credit=2700`, `net=1701` i `nominal=1701`, `amount_due=0`, `overpayment=0`. |
| Dziennik płatności | Wpływ 4401 i jeden refund 2700 z metodą `return_confirmation`. |
| Zamówienie | Oryginalna wartość 4401; częściowy zwrot nie oznacza zwrotu całego zamówienia. |

## Końcowe uzgodnienie SQL — PASS

Root wykonał odczyt wszystkich 627 tabel. 614 pozostało identycznych, w tym
stock, dokumenty źródłowe, fizyczna historia148, dane169, metadata, generacja,
kolejki zadań i outbox. Pozostałe 13 tabel uzgodniono przez pełne hashe:

- Dziewięć nowych wierszy: seria, preview, admission, dokument, receipt,
  licznik, namespace206, typowany parent211 oraz lokalny refund w ledgerze.
- Dwa nowe zdarzenia audytu i dwa zdarzenia zamówienia.
- W starym zamówieniu zmieniły się tylko `version` 8→10 i `updated_at`.
- W starym RMA zmieniły się tylko `state`, `refunded_at`, `settlement`,
  `updated_at` i `version` 2→3; końcowy stan to `closed`.

Wynik kontrolnego odczytu logicznie odjął wyłącznie te konkretne nowe wiersze
oraz zdarzenia i podstawił kandydatów dwóch wcześniejszych wierszy. Kandydaci
pochodzili z osobnej zachowanej kopii; zostali zaakceptowani dopiero po dokładnym
odtworzeniu **całych hashy wcześniejszych tabel oryginału**. Wszystkie 13 hashy
zgodziło się z oryginalnym stanem sprzed UI. Nie wykonywano UPDATE, DELETE ani
normalizacji danych w bazie. To pełne uzgodnienie legalnego przyrostu, a nie
porównanie wyłącznie liczników lub zaakceptowanie dowolnej różnicy.

Nowa korekta ma dokładne połączenie document/receipt/admission206→parent211
`destinations148` i zgodne dane finansowe. Wszystkie cztery wcześniejsze pełne
receipts są identyczne; nowe receipts169: 0. Stock i fizyczna historia148
pozostały bez zmian. Pełny stempel generacji 1744 i źródłowe metadata są
zachowane. `return_credit211_metadata_valid()` zwrócił TRUE przy niezmienionym
limicie 8 s. Odczyt był READ ONLY; ROLLBACK i zamknięcie klienta potwierdzone.

Po odświeżeniu zwykły UI zachował ten sam numer korekty i zamknięty stan RMA;
wydruk pokazał ten sam numer oraz kwoty. Końcowy bilans to `received=4401`,
`credit=2700`, `refunded=2700`, `net=1701`, `amount_due=0` i `overpayment=0`.
Nie wykonano przelewu, wywołania dostawcy płatności ani CLI POST.

Pełne guardy i replay były wcześniej osobnym odbiorem Native na kopii.
Końcowe uzgodnienie po UI nie dodaje nowego pomiaru całego187 ani testu skali.

## Dowody prywatne

`O7` oznacza
`/Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/return-credit211-original-app-n07-prepared-agent01`.
Pełne odpowiedzi i tożsamości pozostają w prywatnych plikach; ten raport nie
kopiuje cookie, tokenów portalu, DSN ani danych kupującego.

| Artefakt względem O7 | Bajty | SHA256 |
|---|---:|---|
| `ui-acceptance-root01/result.private.json` |14841|`586cb25b304e051ec9f0a395b487c5882989ce1db34ae20637dac6b54804d58d`|
| `ui-acceptance-root01/final-sql-observation.private.json` |2192625|`7210f3332321e8fd618d3ec5e11d28b73999b40363642fcf7b5e9732d9b9a35a`|
| `ready-root.private.json` |93833|`35f2b9eef60d1da448644b5abdfaa61915a56452d21533e27f7835ad9d1d5e6b`|
| `ui-acceptance-root01/GET-receipts.private.json` |2860|`bf23784b3f14667a1b75be51b2a0795ab8b9c04c49a9cdfc82ed5e39b32ca3d5`|
| `ui-acceptance-root01/health.private.json` |4113|`1fced50f6e9408300d114c9a4440f2bd0dc7fe3179c9e0a9966fe26239c889e8`|
| `ui-acceptance-root01/strategy.private.json` |324|`25534150d482b8f1fae08625a0669f5f41a835af40e29e58954318002311c39d`|
| `ui-acceptance-root01/source.private.json` |16363|`4f4672954d314c6517ad7b68f882dd6bd67f5dd8995c940ef419cae43461f461`|
| `ui-acceptance-root01/order.private.json` |23090|`0577ee63aeb1ad0bb6afd35ed8f669eb87af3821501b1f4d4fcaa3dcfc5811b7`|
| `ui-acceptance-root01/returns.private.json` |7777|`b75b5f4481b760b6fc7fdc2f11d76eeec7441c23e68266b0b42c7dadba622eea`|
| `ui-acceptance-root01/rma.private.json` |3845|`8422365c36846995e4978eba012d765e7320d98f6360d7c1dee369a855edec0d`|
| `ui-acceptance-root01/payments.private.json` |2623|`337505d2ddeb530d90ea6ea7aa7a502f8486b4e086da0b4b9ec4fa303f4e3277`|
| `ui-acceptance-root01/document.private.json` |12363|`3a61e74f6aa0342d37e2e2142b7e484bbc0467da8f99dac2a1716b13b9a5726a`|
| `ui-preview-root.png` |118867|`3563e56611dd39ba0f49e130689249e072be28bbf1baab84f47237e2edea4a82`|
| `ui-rma-credit-settlement-root.png` |121120|`7f63ef8677541a7f2110494d17d4b13db7f6f2418e1990fadf3e18e61baef5f8`|
| `ui-closed-return-root.png` |122582|`ea74252baa3f6dc466a2947a843bd6b57c7c1069999a4d968d24ece4abb1507c`|
| `ui-credit-print-root.png` |158167|`27e26d3b66c1c6695536b0c1cc4f59f3eb9546b5d3e3d5db03aff3b2bef3d732`|

## Granice

Jeden lokalny przypadek148 i zwykły administrator/Chrome/API na tym samym N07.
Nie jest to odbiór wszystkich odmian RMA, płatności dostawców, B2B, WMS lots,
split210, godzinnej skali ani całego recovery. Wcześniejsze odmowy N05/N06 oraz
nieudane prywatne preflighty pozostają zachowane. Osiem kryteriów
[pełnego Goala](../FULL-BASE-GOAL.md) pozostaje otwartych.
