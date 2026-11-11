# Split210 — kandydat composite i bezstratny codec DATA, 18.10.2026

Status: **Source31, niezależny P23, V31 oraz pakiet H/resource/seal zsynchronizowane i sprawdzone źródłowo. Pełna kompilacja, rzeczywisty Native, aktywacja i biznesowy split nadal otwarte**. Nie zastępuje nieudanej próby [C32 i przeglądu kosztu walidacji](SPLIT210-VALIDATION-COST-REVIEW-20261018.md): pełny187 nadal zakończył się `57014` przy8s, przed COMMIT i Native.

Rzeczywista późniejsza próba **C33 zakończyła się57014/8s w ordinary187**, po pełnym493/22 i czterech kontrolach TRUE. ROLLBACK i cleanup potwierdzone; bez COMMIT/Native/aktywacji. [Pełny wynik i dalsza decyzja](SPLIT210-C33-LOCAL-20261018.md).

## V31 i końcowy pakiet źródłowy

Root opublikował V31 w `order-split210-source-expectation-composite31-prepared-20261018-01`:
358022 B, SHA256 `58d86a31b14b4ff236d131331fc0370df1ac270d8f6fe186c30e9120de6ecb5e`,
canonical `2d13ca57c395334787ced7a653b8dcfcd3af09d64996852c0a3afaab32bc1316`.
Pełne493 rekordy odtworzono ze źródeł i nowego P23/47;488 dodatków i wszystkie22 BEFORE
są identyczne z V30. Pięć zmienionych dodatków to dwa CHECK-i DATA i trzy funkcje;
w zmianach22 tylko metadata2 AFTER source/definition różnią się od V30.

H `471698 B / 5a6c8ee1ac5dd2cbe7c6bca7545ab071507fb413dfed0ef5002f2e31c2362683`
zawiera pełne493/22 raw rekordy. Obie kopie resource mają7719 B i SHA256
`630a0ee23abcd29575392f76b52f04ff3f9102746ad6f19944b7bed444164965`.
Zachowano pełne historyczne H30 i stałą sealu30; pełne inverse i7 pinów są w
`order-split210-h-resource31-synchronization-prepared-20261018-01/readiness.private.json`.
Root osobno potwierdził całe H↔V31,24 pola wszystkich BEFORE/AFTER,
źródłowe515 rekordów sealu oraz równość obu kopii resource w
`root-whole-package-review.private.json`. Fizyczne DATA3590688 B zachowuje603616 B zapasu.

Końcowe testy: H/resource/installer60 PASS/0 SKIP; seal21 PASS i oracle15 PASS;
Native:1 test kontrolowany PASS,25 testów PG SKIP (brak aktywnej flagi).
Pierwszy łączny bieg zachował błąd ekstraktora fixture; poprawiony pełny oracle15/15
przeszedł osobno, seal nie zmieniono. Bez wykonania SQL, pełnej kompilacji lub Native.
Te wyniki nie potwierdzają szybkości pełnego guarda ani biznesowego podziału.

## Co przygotowano

[Composite](../../tools/parity/order-split210-metadata-composite.mjs) przyjmuje wyłącznie dwa przypięte ciała ze źródłowego V30: metadata2 `6507 B / cfad1ebdc47ddd2f3c72b058a1736dd4767a244d7ea4c22f51c3a1a655f4499e` oraz snapshot `21739 B / 611cb9304d6f540b31b72a1a627a2e87a5964129dfc0335120e587c4ecdd791c`. Zachowuje jeden pełny caller-require na zastępowanej granicy i wkleja całe oryginalne zapytanie snapshotu jako stały literał `EXECUTE … INTO`; usuwa wyłącznie osobny leading SELECT require snapshotu. Samodzielny snapshot pozostaje niezmieniony. Pozostały kod metadata2, roster17 i cały oryginalny sufiks DATA51 są literalnie zachowane; pełny inverse odtwarza ciało i definicję. Pozostałe zagnieżdżone guardy pozostają — to nie deklaracja jednego require dla całej ścieżki.

Nowe ciało: **28068 B**, SHA `d3d059467f193f5334f1fc35d6469f120445251cbf9aedfa15c9045793b14c00`; definicja: **28300 B**, SHA `00e5a1912773134c953342c96cfabc3a9f1a74c653f78ec3cf678f5de5c8a672`. Przyrost każdego tekstu wynosi21561B. Wklejone zapytanie ma21697B/SHA `e5674d6fed4a586b5109303e3c6a12367dc6340b1155b99d3d5d29d6397caa68`.

[Codec](../../tools/parity/order-split210-definition-codec.mjs) zastępuje tylko `after.definition` wszystkich22 zmian zamkniętym markerem wersji. Pozostawia raw BEFORE, raw AFTER.source, pozostałe pola i tagged checks. Odtwarza pełne24 pola z autoryzowanego nagłówka BEFORE, AFTER.source i oryginalnego sufiksu. Brak nowej funkcji runtime, cache, trusted frame lub oczekiwań pobieranych z `pg_proc`. Per-entry decode może obsłużyć wybraną zmianę bez odtwarzania wszystkich dużych definicji.

Łącznie **20 testów źródłowych PASS,0 SKIP** dla wersji przed TEMP probe: [composite9](../../tests/order-split210-metadata-composite.test.mjs) i [codec11](../../tests/order-split210-definition-codec.test.mjs). Obejmują pełny roundtrip, wszystkie24 pola, odmowę zmienionych źródeł, markerów, rosteru, nagłówków, typów/NULL oraz granice cytowania SQL. Nie są odbiorem PG całego kompozytu.

## Pomiar źródłowego DATA

| Reprezentacja kandydata | Bajty | SHA-256 |
| --- | ---: | --- |
| Logiczna, z pełnymi22 definicjami | 4235679 | `01ab182b9b1ee0f35a3e7fd9505aeafd9415b516c843d6265c20017139008b9e` |
| Fizyczna, po codec | 3590688 | `db01b0c7849fc9771ab7d6a7cf41ff79d8e5c4eec1a96ee0c0637f17902f12b3` |

Oszczędność644991B; zapas do niezmienionego limitu4194304B wynosi **603616B, około604kB**. Niezależny source-only przegląd ponownie złożył ten sam kandydat i potwierdził oba pełne canonical piny. To pomiar tej reprezentacji; nie pomiar zasobów ani rozmiaru przyszłego kompletnego wydania.

## Rzeczywisty TEMP probe Root

Root uruchomił jednorazowo [operator](../../../../local-builds/full-base-preview-20261017/order-split210-codec31-sql-probe-prepared-20261018-01/run.private.mjs),13164B/SHA `eaaa8805a279aa5d382eeeb09a079296cf76490e0788a10e952d133cb4e3db11`, według [specyfikacji](../../../../local-builds/full-base-preview-20261017/order-split210-codec31-sql-probe-prepared-20261018-01/spec.private.json),11957B/SHA `23bbe9cfdae145c941272f91ce811388e4f7615547353201885857fb56f7641c`. TERMINAL EXIT0 na lokalnym PostgreSQL18.4/57084.

[Wynik](../../../../local-builds/full-base-preview-20261017/order-split210-codec31-sql-probe-prepared-20261018-01/result.private.json),5924B/SHA `c24c2690700373ef2f26a258b66371a5c7b9d77e5c76129971c39ec6240d4498`, zawiera **59/59 PASS**:23 dodatnie — cały logiczny DATA i22 pełne wybrane wpisy — oraz36 ujemnych, wszystkie z oczekiwanym `55000`. Badano SQL NULL, JSON null, skalary/tablice, wersję, roster, markery, komplet pól, typy źródeł i definicji, nagłówek/body/sufiks oraz kolizję delimitera. Stosowano8s dla odczytów i osobne savepointy dla odmów.

Powstały wyłącznie dwie funkcje-wrappery w sesyjnym `pg_temp`; po ROLLBACK potwierdzono brak obu. Role oraz topologia funkcji i relacji w `public`/`ordinary187_private` pozostały zgodne, klient został zamknięty. Nie instalowano programu publicznego210, nie wykonywano dostawców ani zapisów biznesowych. Nie jest to porównanie całego katalogu aplikacji. [Przegląd terminalny Root](../../../../local-builds/full-base-preview-20261017/order-split210-codec31-sql-probe-prepared-20261018-01/root-terminal-review.private.json),1178B/SHA `8bb8a2ed5ddfa7cb7a7fd13f4df905cf09235b593fce077254f57ce7922bbf27`.

Wykonany codec:10942B/SHA `06dbfc0a11dc42a140bd615aa55e9a1bcbb5841ab9b5411554efb94c09e3a30f`, zachowany jako [executed source](../../../../local-builds/full-base-preview-20261017/order-split210-codec31-sql-probe-prepared-20261018-01/codec-executed-source.private.mjs). Composite użyty do przygotowania wartości:7406B/SHA `35752645b8e7ff389efa265d829e96a09db34395b6d0ccc599538130eb42551f`. TEMP probe wykonywał SQL kodeka, **nie zapytanie snapshotu ani pełny kompozyt metadata2**.

Po probe dodano wyłącznie112B zeroargumentowego eksportu istniejących bloków SQL. Aktualny helper ma11054B/SHA `30eeb21ded629690e179f7888d467415b146009a129d3bb5b19a7abe4e2eb212`. [Oddzielny dowód Root](../../../../local-builds/full-base-preview-20261017/order-split210-codec31-sql-probe-prepared-20261018-01/root-post-probe-export-review.private.json),888B/SHA `b85ee0e951531e38a8c12cc4f0e96e24f8cfe1357c7b0c5ceacd54c9eb91da2c`, oraz niezależny odczyt potwierdzają: usunięcie dokładnie jednej dodanej linii odtwarza **cały wykonany plik bajtowo**. SQL nie zmieniono: full block4667B/SHA `e0c92d1d846596d14fa6e768496decd3b791fef52d34f597887bdc2cf1ebdf24`, per-entry3877B/SHA `00d7a85bfd5ede2d184bfa460cf8f7d8c4335cf2524b1a180ba582ec47dd4ec2`. Nie wykonywano nowego PG ani ponowienia59; późniejszego testu eksportu nie dopisujemy do wcześniejszego wyniku20 testów źródłowych.

## Granice autoryzacji i dalszego odbioru

Codec jest formatem bezstratnym, nie niezależnym walidatorem zaufania dla dowolnego uploadu. Encode wymaga22 deskryptorów z autoryzowanych źródeł; przed decode istniejący świeży pełny guard515 musi uwierzytelnić fizyczny DATA i wykonujący kod. Wspólne sfałszowanie strukturalnie zgodnych pól BEFORE/AFTER nie jest samodzielnie wykrywane przez codec. Oczekiwań nie wolno zastępować odczytem obserwowanego katalogu.

Stały `EXECUTE` zapobiega przechwyceniu kolumny SQL `value` przez parametr PL/pgSQL. Dokumentacja PostgreSQL18 potwierdza [brak podstawiania zmiennych i brak cache planu EXECUTE](https://www.postgresql.org/docs/18/plpgsql-statements.html#PLPGSQL-STATEMENTS-EXECUTING-DYN). [SPI visibility](https://www.postgresql.org/docs/18/spi-visibility.html) i [read-only SPI](https://www.postgresql.org/docs/18/spi-spi-execute.html) opisują zachowanie snapshotu dla STABLE; [exec_stmt_dynexecute w źródłach PostgreSQL18](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/pl/plpgsql/src/pl_exec.c) przekazuje `estate->readonly_func`. Jest to podstawa projektowa, nie wykonany test współbieżnych zmian/MVCC. Każde EXECUTE ponownie planuje zapytanie — koszt pozostaje niezmierzony.

Otwarte pozostają: podłączenie composite i kodeka we wszystkich właściwych konsumentach, nowe spójne źródła/vector/seal/H, pełne493/22 inverse z nową reprezentacją, odmowy przy jednoczesnym zatruciu kodu i DATA, MVCC/DDL oraz pełny runtime przy8s. Następnie rzeczywisty Native, normalny start, split przez API i Chrome, skala i recovery. Ten dokument nie ogłasza naprawy timeoutu C32, odbioru Native, poprawy wydajności ani ukończenia modułu lub Goala.


## Kolejny skończony etap źródłowy: sześć punktów dekodowania

[Finite ports](../../tools/parity/order-split210-definition-codec-ports.mjs)
przyjmuje wyłącznie dwie pełne, przypięte deklaracje Source30. Wstawia ten sam
wykonany blok dekodera w jednym miejscu try_function_projection i pięciu
try_metadata_projection: cały rekord funkcji, trzy kształty kompaktowe oraz
początek pętli literalnych pól. Wstawka buyer poprzedza dołączenie ancestor208.
Tagged snapshot, project209_record, odczyty rodzin i pozostałe struktury DATA
nie dostają dekodera. Każda deklaracja i surowe ciało mają pełny inverse;
wcześniejszy łańcuch transformacji metadanych pozostaje literalny. Na tym wcześniejszym etapie nie był
podłączony do generatora; nie był to dowód wydajności ani runtime210.

Root wykonał wspólnie trzy moduły: **29/29 PASS,0 SKIP,0 FAIL**
(8 ports,12 codec,9 composite;620,073417ms). To późniejszy, osobny zestaw źródłowy;
nie dodaje wywołań PG do wcześniejszej próby59. Niezależny przegląd porównał
pełne wejściowe ciała obu deklaracji z opublikowanym H30 oraz potwierdził sześć
miejsc odczytu, pełne inverse i brak nowych funkcji runtime. Dekodowanie na
ścieżce całego rekordu wykonuje się także przed kontrolami tagged; jego koszt
pozostaje do zmierzenia w przyszłym pełnym przebiegu.


## Rzeczywiste złożenie źródeł Source31 i zamknięta autoryzacja guarda

Osobny Root10719 zakończył się TERMINAL EXIT0, wyłącznie source-only:
[wynik złożenia](../../../../local-builds/full-base-preview-20261017/order-split210-source31-source-capture-prepared-20261018-01/result.private.json),
26192B/SHA `8e82c8107f846d130534951c0e0363387846f1929c84beda8b720cf250754997`.
Prywatne kopie layer/closure mają pełne inverse6+28 do publicznych źródeł;
Root i peer potwierdzili50 przypiętych referencji. Rzeczywiście przechwycony
rawguard52253B/SHA `4f0ed5068c80152a0459cabf2e4a280980a8e33de99190e0d7ddde7e42864d35`
jest w całości bajtowo równy wcześniejszej niezależnej rekonstrukcji z historycznego
Source29 i pięciu dokładnych zmian. Zachowano wszystkie22 BEFORE i21 innych
AFTER; tylko source/definition metadata2 zmieniły się. Root ponownie sprawdził
pełne24 pola, checks z surowych definicji oraz cały inverse physical→logical DATA.
Physical3590688/db01… i603616B zapasu są zgodne z wcześniejszym pomiarem.

[Nowy finite wrapper](../../tools/parity/order-split210-valid-snapshot31.mjs)
przyjmuje wyłącznie to dokładne źródło. Odwraca pięć zamkniętych powiązań do
przypiętego historycznego raw29, wykorzystuje niezmieniony historyczny łańcuch,
a wynik weryfikuje dwoma niezależnymi torami. Zachowuje cztery pełne inverse
transformacji, pięć zmian wejścia/wyjścia i tę samą kompletną instrukcję capture.
Przesunięcie offsetów mapy o17 wynika wyłącznie z dłuższego physical schema.
Wynik guarda53140B/SHA `2b8023561f6456783d30a4d19a1211736f80b936f81c6fbb6388f5f5786154a5`;
surowe ciało52974B/SHA `8713e8b6393add4c2fd888d28c35fc70e8f8f19ef3e6ce76de9423d3681bf772`.
[Krzyżowy przegląd Root](../../../../local-builds/full-base-preview-20261017/order-split210-source31-source-capture-prepared-20261018-01/root-finite-guard31-review.private.json)
sprawdza wynik dla faktycznie przechwyconego źródła. Peers potwierdzili pełne
literalne inverse i brakP1/P2. Historyczny moduł valid-snapshot pozostaje niezmieniony.

Root uruchomił wspólnie sześć modułów źródłowych: **53/53 PASS,0 SKIP,0 FAIL**
(594,409208ms), obejmujących także historyczny valid-snapshot i trigger-map.
Nie wykonano nowego SQL/PG/sieci. Prywatny capture używał jawnego nieautoryzującego
stuba; jego wynik nie jest kompletnym wektorem493 nowych metadanych ani pełną
kompilacją SQL. Na tym wcześniejszym etapie nowy wrapper pozostawał poza publicznym generatorem i pakietem.

Kolejny etap: spójne wpięcie Source31, świeży47-leaf P23 dla dwóch zmienionych
CHECK długości/hashu (45 pozostałych do porównania), nowy pełny V31 i H/seal,
a następnie pełny kompilator/Native i biznesowy split. Dotychczasowy P22 nie
może zostać użyty jako pomiar nowych wyrażeń. Brak nowego schemaCHECK i brak
zmiany limitów. Wynik C32 nadalFAILED; pełny Goal pozostaje otwarty.


## Publiczny generator Source31 i nowy rzeczywisty P23

Późniejsza integracja zmieniła wyłącznie layer i closure; assembler zachował
istniejący kontrakt pełnych22 surowych deskryptorów. Publiczna fabryka składa
27 etapów,27 nowych funkcji i8 tabel: program4524547B/SHA
`3e99139ded0b97012846f5d1bb023e60bb289b307a0647d3302419c3f60414ab`,
gzip9 531238B/SHA `ee237ea1961e6feb355ba9c4ea40d483f62a415fbdb75183c62b3b9d67cbb0ad`.
Physical DATA pozostaje3590688/db01… przy603616B zapasu. Root osobno
odtworzył z historycznych źródeł cały Source30 5094845/f2f3…;24/27 etapów
jest bajtowo identycznych. Zmieniły się tylko DATA, ports i replacement metadata2.
[Porównanie całych programów](../../../../local-builds/full-base-preview-20261017/order-split210-source31-public-assembly-20261018-01/root-historical-comparison.private.json).

Nowe testy zawierają pełne inverse wnętrza tych trzech etapów, zanim wykonają
wszystkie starsze witnesses: physical→logical→historyczny DATA4192445/fedf…,
sześć wstawek i pięć bindings→całe stare ports97283/e661…, a następnie cały
program5094845/f2f3…. Stare fixtures zachowano literalnie. Root wykonał dziewięć
modułów: **104/104 PASS,0 SKIP,0 FAIL** (3439,276292ms); agent63/63 oraz
niezależny przegląd bezP1/P2 obejmowały cztery zmienione testy.

Rzeczywisty P23, oryginalny Root38577/child14593, zakończył się TERMINAL EXIT0.
Utworzył tylko osiem niezależnych tabel w próbnej przestrzeni nazw i odczytał
44 CHECK oraz3 generated expressions. Wszystkie47 celów są zgodne;
45 pełnych wartości pozostało literalnie zgodnych z P22, a dwa nowe CHECK-i
potwierdzają autorskie3590688B i db01… . Nie użyto P22 jako pomiaru nowych pól.
Odczyty i DDL zachowały8s. ROLLBACK, brak próbnego schematu, identyczne role
oraz memberships i zamknięcie klienta potwierdzono. Przed pierwszą próbą
Root poprawił także kontrolę cleanup po błędzie i pinning faktycznie parsowanych
bajtów locatora; pięć dodatkowych kroków ma pełny inverse do przygotowania
P23, a następnie pełny historyczny inverse do P22. Nie powtarzano operatora.

[Receipt P23](../../../../local-builds/full-base-preview-20261017/root-source210-source31-expression-probe23-prepared-20261018-01/receipt.private.json),
2276B/SHA `a4fd5b660718ee9a2efe985715884b82b64d4c2b44e6300d99d8a3873426ab3d`;
[basis47](../../../../local-builds/full-base-preview-20261017/root-source210-source31-expression-probe23-prepared-20261018-01/independent-source-expressions.private.json),
9078B/SHA `12cc0b52508436bddf8633d5c012f08dd3987570b0779580ceb4a6010d2e5bb1`;
[końcowy przegląd Root](../../../../local-builds/full-base-preview-20261017/root-source210-source31-expression-probe23-prepared-20261018-01/root-terminal-review.private.json),
1626B/SHA `72ec2d55aedfbcf9673ce766aad18a52f4c118f9cd6393f565095f817fe88345`.
Canonical47 SHA `eba71c20f63e1c6935aa2a8309073c9649a2e28858d35a26f2daf1585c2eda85`.
Root i peer potwierdzili pełny zestaw98 aktualnych pinów,34 faktyczne moduły
grafu i dokładnie dwa źródłowe literały różnicy całego probeSQL względem P22.

P23 nie instaluje całego programu210, nie czyta jego docelowego katalogu,
nie dowodzi pełnego inverse katalogu, Native, wydajności lub biznesowego splitu.
Aktualizacja V31/H/seal i świeży pełny kompilator pozostają kolejnymi krokami;
stary pakiet Source30 i jego stałe bramki nie zostały poluzowane. C32 pozostaje
FAILED, główne lokalne aplikacje zachowane, pełny Goal aktywny.
