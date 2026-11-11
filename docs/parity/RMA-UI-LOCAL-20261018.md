# Zwrot, korekta i lokalne rozliczenie — odbiór częściowy,18.10.2026

**FV44,01 i fizyczne sale1/custody1/reject1 potwierdzone; korekta i lokalny refund otwarte.**
Po przyjęciu źródło korekty odmówiło409: istnieje ukończony148, lecz brak
powiązanego169. Nie wystawiono korekty ani potwierdzenia zwrotu środków.

## Kolejne etapy rzeczywistego przebiegu

Root uruchomił
jednorazowy setup na zwykłym N05 `74f747910717c16af8a65f85ff2bef6924e8e94eba01605647f7b1506e99bd0f`.
Przebieg EXIT0/8974ms wykonał29 żądań i10 mutacji z ACK. Utworzono wyłącznie
świeżą własną firmę administratora, produkt i zamówienie
`DE-20261018-2B732E22`, dwie pozycje1000+3401gr, status `shipped`.
WMS był OFF. Zapas5→rezerwacja3→po lokalnym wydaniu2/rezerwacja0.

Zwykłe API zapisało deklarowaną lokalną wpłatę4401gr: jeden ledger receipt,
received/net4401,refunded/credit/amount_due/overpayment0. Nie wykonano płatności
u dostawcy. Przed każdą mutacją zachowano prywatny intent, po niej dokładny ACK;
bez retry, SQL lub uruchamiania workera. Na końcu tego setupu nie było jeszcze
FV, RMA, korekty ani potwierdzenia zwrotu środków.

Root następnie wystawił przez normalny Chrome FV `RCFV181/2026/000001`
na44,01 i obejrzał pełny wydruk. Osobny obserwator EXIT0/2377ms wykonał19 GET,
0 POST/SQL: invoice/receipt i wystawiony podgląd są zgodne, netto35,78/VAT8,23,
WMS OFF, stock A2/0 i B0, ledger bez zmian; RMA i rejestr korekt wciąż puste.
Magazyn B `RC181` ma aktywną politykę custodyv1. To dowód przed RMA,
nie odbiór przyjęcia, korekty lub rozliczenia.

Zaobserwowana wcześniej odmowa błędnego NIP0000000000 pozostaje zachowana.
Nowa poprawka klienta sprawdza sumę kontrolną i wyświetla polską wskazówkę;
8/8 testów kontrolowanych PASS, commit `ec342bb`. Nie ma jej w N05 — bez odbioru tej poprawki
przez rzeczywisty Chrome na nowym wydaniu. Serwer zachowuje walidację.

Następny pełny proces wymaga osobnego odbioru świeżego przypadku ze ścisłą
kontrolą katalogu przed przyjęciem: korekta−27,00 z pozostającą sprzedażą17,01,
a potem lokalne potwierdzenie operatora2700gr i pełne odczyty dokumentów,
stocku i ledgeru. Nie naprawia to obecnego nieścisłego przyjęcia.
WMS ON, reject-only, IAM/concurrency, crash/ACK-loss,
dostawca refundacji, skala i pełny Goal pozostają otwarte.
Historyczne cztery przypadki/203 żądania ordinary10 zachowują oddzielny
[zakres dowodowy](RETURN-CREDIT207-INTEGRATION.md); nie były tu powtarzane.

| Dowód | SHA256 |
| --- | --- |
| [Rzeczywisty setup OFF przed fakturą i RMA](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/setup-off-run01/result.private.json) | `85f473567af9293c05a7d557c6b0ed3042fd581faec9d43a5dbb9b83a1369dbe` |
| [FV44,01 przed RMA:19 GET](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/invoice-reconciliation-prepared-agent-20261018-01/run01/result.private.json) | `08c53804cab998a9c989643563d58ffe237e56527afb05ca2359e60f9a51bca4` |
| [Pełna podstawa FV, stock i ledger przed RMA](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/invoice-reconciliation-prepared-agent-20261018-01/run01/invoice-basis.private.json) | `f4df1af4e9bfdc6262a85804779f2ce90e36ed77116da1ef3ff3cf11570cb632` |


## Ujawniona granica: fizyczne przyjęcie bez ścisłej kontroli katalogu

Root utworzył przez UI sprawę `RMA-2026-A0F59914` i przyjął sale1/custody1/
reject1. Stan sprawy to `refund_pending`, uznanie2700gr. Pierwszy obserwator
po przyjęciu EXIT1/1273ms zakończył się po5 GET na oczekiwaniu dwóch PZ;
API zwróciło pustą listę `stock_receipts`. Skrypt i nieudany wynik zachowano.
To błędne oczekiwanie helpera dla ilościowego OFF bez ścisłej kontroli katalogu:
ten adapter zapisuje stock, lokalizacje i dziennik, ale nie tworzy PZ/receipt169.
Nie odtwarzano numerów ani receipt po fakcie.

Osobna diagnostyka Root:5 GET/0 zapisów potwierdziło A3/reserved0/sellable3,
B1/reserved0/sellable0 i trwałą operację przyjęcia: accepted2,sale1,custody1,
reject1,commercial_credit2700. To potwierdzenie fizycznego podziału, bez pełnego
odbioru ścieżki finansowej. Następne dwa GET ujawniły rzeczywistą lukę produktu:
strategia zwróciła `legacy`, a jawne źródło korekty dla tej sprawy odmówiło409.
UI nie umożliwił kontynuacji; korekty i potwierdzenia refundu nie utworzono.

Źródła rozdzielają te możliwości: `prepareCatalogStockReturnInTx` może oddać
null dla nieścisłego OFF, a `finish(null)` zwraca pustą listę dokumentów.
Strategia i natywny source207 wymagają dla przyjęcia powiązanego sealed169;
source/preview/issue oraz FK nie mogą zostać zastąpione luźną projekcją148.
Świeży proces ze ścisłą kontrolą katalogu i bilansem otwarcia przed przyjęciem
jest osobnym przypadkiem. Aktywacja teraz nie uzupełni dotychczasowego przyjęcia.
Pełne wsparcie finansowe dla istniejącego nieścisłego przyjęcia wymaga osobnego
kontraktu natywnego i odbioru; pozostaje otwarte.

| Zachowany dowód częściowego wyniku | SHA256 |
| --- | --- |
| [Nieudany obserwator po5 GET: oczekiwanie PZ](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/after-intake-reconciliation-prepared-agent-20261018-01/run01/failure.private.json) | `d702cebcd89bc908c0baab9fce44c115d005fa5d42af9178890be0482f3e4c33` |
| [Root:5 GET diagnostyki fizycznego podziału](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/root-after-intake-diagnostic01/result.private.json) | `59fddbf0e0878509fb9dbbc76761da6f37a35b7e95b71ea8da37e6e866f85d20` |
| [Rzeczywista strategia legacy po destinationsreceive](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/root-credit-source-diagnostic01/1.private.json) | `94077ff8cf7f599b308d0ea0e45f55711e40db13164a2ec38a737418b1cb1812` |
| [Rzeczywista odmowa źródła korekty409](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/root-credit-source-diagnostic01/2.private.json) | `177094c0169431808fa96815bb42fc103dcf7374ca23bcf373ca2575dfc9a704` |

Źródłowa poprawka strategii rozpoznaje ukończone przyjęcie148 bez jego własnego
sealed169 jako `destinations/available=false/catalog_receipt_required`.
Selektor wyjaśnia brak wymaganej dokumentacji i przyszłą prerekwizycję BO,
nie montuje żadnego panelu korekty i nie proponuje uzupełnienia starego receipt.
Commit `3258296`:42/42 kontrolowane testy rzeczywistej funkcji/React PASS,
typecheck EXIT0; Root niezależnie42/42 PASS (3216,681ms) i wspólny typecheck0.
Root wykonał też dokładne nowe zapytanie klasyfikacji READ ONLY na tej sprawie:
`destination=true,catalog_receipt_missing=true`, ROLLBACK/end TRUE. To dowód
zapytania, bez odbioru nowego API/UI lub nowego wydania. Source/preview/issue,
FK i guardy finansowe nie zostały osłabione. Poprawka komunikatu nie zapewnia
pełnego wsparcia finansowego dotychczasowego nieścisłego przyjęcia.

Osobny rzeczywisty odczyt READ ONLY potwierdził dwa ruchy return po+1, jeden
ukończony148, zero169 i zero korekt206. Cały stempel1703 pozostał zgodny,
ROLLBACK/end TRUE. Zachowano wcześniejszą nieudaną diagnostykę z błędną nazwą
`order_payments` (42P01):0 zapisów biznesowych, client end TRUE, bez jawnego ACK
ROLLBACK; nie jest źródłem tych liczników.

Dokładny zakres nowych testów: `node --test tests/return-credit-strategy-admission.test.mjs web/consumer-return-credits.test.mjs`.
Oddzielne Root31/32 w szerszym zestawie zachowało wcześniejszy błąd literalnego
asserta `fixture.includes('for(const on of [false,true])')`; w tej próbie fixture
i test były bajtowo zgodne z HEAD3258296. Późniejsza poprawka testu wykonuje
rzeczywiste defaulty, walidację i nagłówek pętli OFF/ON przez parser Acorn,
z pominięciem ciała biznesowego; fixture pozostał niezmieniony. Root7/7 PASS,
0 SKIP,67,925ms. Zachowano również nieudaną próbę przygotowania testu z API
TypeScript niedostępnym w zainstalowanej wersji. Te wyniki nie odbierają PG/API.


| Dalszy dowód | SHA256 |
| --- | --- |
| [Rzeczywiste ruchy i brak169/korekty, READ ONLY](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/root-rma-physical-and-gap.private.json) | `5de98ac2b82ddab7c967bb06b679347ced3ca0b9699409ade615d09ed0a48923` |
| [Zachowane42P01 błędnej nazwy relacji](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/root-rma-physical-gap-read-failure.private.json) | `ded80d857e437fa9066b2e57a37d5dcb10d58f92cce104d360f83226da60ff16` |
| [Dokładna nowa klasyfikacja SQL na własnej sprawie](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/root-rma-strategy-query.private.json) | `a6be60fa0039e281a13e80bea7c8d175bb637fc24690bfdc1b469bcc429b4bb8` |
| [Niezmieniony wcześniejszy błąd testu źródłowego](../../../../local-builds/full-base-preview-20261017/return-credit-ui-acceptance-prepared-agent-20261018-01/root-existing-history206-test-gap.private.json) | `08f3b0a6f36e93cee63d11c172b13ccafd7280c2dbb9986913165267b103b450` |
