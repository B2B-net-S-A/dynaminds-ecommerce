# Split210 — zapisany schemat: generator i niezależny PostgreSQL

Status: **Source32 w generatorze, rzeczywisty P24 oraz źródłowe V32/H/inverse/seal/installer PASS**.
**Późniejszy rzeczywisty C34 zakończył się timeoutem187 przy8s**, mimo pełnej
zgodności494/22 i czterech guardów TRUE. ROLLBACK i cleanup potwierdzone;
bez COMMIT i Native. [Pełny wynik C34](SPLIT210-C34-LOCAL-20261018.md).
Instalacja, Native oraz biznesowy podział przez API i Chrome pozostają otwarte.
Działające N09 nie zostało aktualizowane tym kandydatem.

## Zmiana i granice

Poprzedni [profil pełnej walidacji](SPLIT210-CALL-PROFILE-LOCAL-20261018.md)
wykazał 279 zakończonych wywołań `order_split210_valid()` i 4382,508 ms czasu
własnego w próbie, w której pełny187 przekroczył 8 s. Source32 sprawdza hipotezę
ograniczenia powtarzanego odczytu klucza z dużego JSONB. Ten raport nie przypisuje
nowemu wariantowi żadnego zmierzonego przyspieszenia.

Do końca tabeli projection basis dopisano nullable `payload_schema`, obliczane
przez PostgreSQL jako STORED z surowego payload. Pięć wcześniejszych kolumn
zachowuje pozycje. Własny valid używa tego pola w tej samej równości schematu.
Pozostałe predykaty danych, świeże kontrole katalogu, granice wywołań SQL,
22 podmiany poprzedników i fizyczny DATA pozostają bez zmian. Nie dodano cache
wyniku walidacji ani pomijania kontroli deskryptorów.

Cały program Source32 ma 4 524 613 B, SHA256
`a737148ee97845de656b38d5a92dea341c6040c2ae8b39557d2e248c26c6fc8b`.
Dokładny inverse dwóch etapów odtwarza cały Source31: 4 524 547 B,
`3e99139ded0b97012846f5d1bb023e60bb289b307a0647d3302419c3f60414ab`.
DATA nadal ma 3 590 688 B i hash `db01b0c7…`. Dwa moduły reprezentacji zasobu
przypinają nowy gzip9: 531 254 B,
`4f2ba3cc8be00d1746b41c81e88c24cdbafaaa7cd12bd3f7694d3b7d0ba7b450`.
Limity 16 MiB na plik i 96 MiB łącznie pozostają bez zmian.

## Rzeczywisty P24

Koordynator uruchomił jednorazowo [operator P24](../../../../local-builds/full-base-preview-20261017/root-source210-source32-expression-probe24-prepared-20261018-01/run.private.mjs)
według [zamrożonej specyfikacji](../../../../local-builds/full-base-preview-20261017/root-source210-source32-expression-probe24-prepared-20261018-01/spec.private.json).
Sesja 82247 zakończyła się EXIT 0. Użyto PostgreSQL 18.4 na 57084 i wyłącznie
nowej bazy z własnym znacznikiem, bez dostępu do biznesowej bazy aplikacji.

- Cały niezależny probe ośmiu tabel odczytał 44 CHECK i cztery wyrażenia generated.
  Wszystkie 47 wcześniejszych wartości jest dokładnie zgodnych z P23.
- Porównanie starej deklaracji w SAVEPOINT i nowej deklaracji potwierdziło
  wszystkie 14 pól deskryptora każdej z pięciu wcześniejszych kolumn oraz attnum.
  Nowa kolumna ma pozycję 6, typ text, nullable i generated `s`.
- Wstawienie pełnego źródłowo przypiętego DATA potwierdziło zgodność nowego
  pola i dawnego accessora. Dwanaście osobnych przypadków obejmuje prawidłowy
  i błędny string, brak klucza, NULL, wartości niestringowe oraz korzenie JSON.
  Oba accessory dają zgodne wyniki; brak schematu i NULL nie spełniają predykatu.
- ROLLBACK usunął schemat i tabelę TEMP. Zamknięto obu klientów, potwierdzono
  zero połączeń przed DROP i usunięto wyłącznie własną bazę. Role, członkostwa
  i wszystkie 99 przypiętych plików źródłowych zachowały zgodność.

[Receipt](../../../../local-builds/full-base-preview-20261017/root-source210-source32-expression-probe24-prepared-20261018-01/run01/receipt.private.json)
ma 2100 B i SHA256 `8670887ca7932ee7e39e94d1d6d2573607fa4c5d13599b62b50746c2f43a6ace`.
[Niezależna baza 48 wyrażeń](../../../../local-builds/full-base-preview-20261017/root-source210-source32-expression-probe24-prepared-20261018-01/run01/independent-source-expressions.private.json)
ma 9250 B i SHA256 `aa361e192fb32f9826c32281c5ec9afd9bf33cead66727aa3f603a11055cf3c3`.
[Przegląd koordynatora](../../../../local-builds/full-base-preview-20261017/root-source210-source32-expression-probe24-prepared-20261018-01/root-terminal-review.private.json)
ma 3256 B i SHA256 `777a1802ab4f3feac4bbb9d54fc39a0c1f9dcc776b794b22037f6fb827855a30`.
Niezależny agent potwierdził pełne artefakty, wcześniejsze wartości i cleanup.

## Pełne oczekiwania V32 i instalator

Po rzeczywistym P24 koordynator uruchomił źródłowy builder V32 (sesja 10228,
EXIT 0). Każdy z 494 pełnych dodatków odtworzono ze źródeł i niezależnych
48 wyrażeń; wszystkie 22 pełne BEFORE/AFTER pozostały identyczne z V31.
Z 493 wcześniejszych dodatków 492 są identyczne, a własny valid zmienia tylko
source i definition. Jedyną nową tożsamością jest kolumna 6.

[V32](../../../../local-builds/full-base-preview-20261017/order-split210-source-expectation32-prepared-20261018-01/expected-vector.private.json.gz)
ma 345 505 B i SHA256 `770000ca79bbab659efa37b754d990395024ee85e80359f0afefaec933316392`;
canonical SHA256 to `ffd25373cad501603ea8bd08521a75a8c50d4693dc27bac305eea8902f27dc7e`.
[Przegląd koordynatora V32](../../../../local-builds/full-base-preview-20261017/order-split210-source-expectation32-prepared-20261018-01/root-terminal-review.private.json)
ma 2471 B i SHA256 `c61b845ed89297503e1122599c62defb87220612d1e8e584ec0ac48c868db542`.
Nie odczytywano docelowego katalogu, aby uzyskać oczekiwania.

H v7 jest w całości zgodne z dodatkami i zmianami V32. Pełny inverse H32→H31
odtwarza dawną serializację 3 271 512 B, nie tylko liczbę rekordów. Stare profile
inverse v2–v6 nadal wymagają swoich 493 dodatków; nowy v7 wymaga dokładnych 494.
Seal i instalator wymagają 516 rekordów fingerprintu oraz 48 niezależnych wyrażeń.
Jednorazowy seal zachowuje wcześniejszy accessor JSONB; optymalizacja dotyczy
powtarzanego runtime valid. Wszystkie te artefakty pozostają źródłowymi
oczekiwaniami, bez nadania odbioru instalacji lub Native.

## Testy i następne bramki

Koordynator: 65 testów helpera, generatora i oracle PASS, 0 SKIP;
pięć testów reprezentacji zasobu PASS, 0 SKIP. Domyślny zestaw Native ma
jeden test kontrolowany PASS i 26 przypadków PG SKIP; nie stanowi odbioru Native.
Dodano przypadek naruszenia nowej kolumny i jej odmowy bezpośredniego zapisu.
Źródła zapisano lokalnie w `c07365e`, reprezentację zasobu w `956ad9d`.
V32 builder: koordynator 10/10 PASS bez SKIP; H: 6/6 PASS. Dodatkowo agenci:
katalog 35/35, seal 22/22 oraz instalator/emitter 25/25 PASS bez SKIP.
Koordynator niezależnie porównał całe H z rzeczywistym V32 i odtworzył źródłowy
seal 516. H zapisano w `bbb4f04`, inverse v7 w `e16f888`, a seal, instalator
i Native source gates w `b4b43f9`.

Następnie potrzebna jest pełna kompilacja na własnej bazie, porównanie wszystkich
494 dodatków i 22 podmian oraz rzeczywisty Native. Dopiero rzeczywisty pełny187
przy niezmienionym limicie 8 s może rozstrzygnąć
hipotezę kosztu. Następne bramki to rzeczywisty Native, wspólne wydanie z211,
zachowanie danych i biznesowy split w zwykłym API/Chrome dla WMS OFF i ON.
Żadna z tych bramek ani cały Goal nie została zamknięta przez P24.
