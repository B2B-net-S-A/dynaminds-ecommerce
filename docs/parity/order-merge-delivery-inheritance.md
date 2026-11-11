# MERGE: zachowanie operacyjnego adresu wybranego odbiorcy

**Odbiór biznesowy18.10: APP READY pakietu16, API into-main i Chrome new-technical.**
Aktualny [raport odbioru](MERGE209-LOCAL-ACCEPTANCE-20261018.md) potwierdza
działające procesy na rewizji `691a7cb5…`, z zachowaniem ograniczeń do lokalnych
ręcznych nieopłaconych par i WMS OFF. Nowe zamówienie techniczne zachowuje
zmieniony adres głównego, zapisuje historię dziedziczenia i wyłącza korektę
adresu w portalu; odświeżenie i ponowne otwarcie potwierdzono w Chrome.
Odczyt API into-main naprawia wyłącznie błędne oczekiwanie wcześniejszego
weryfikatora: Source166 przewiduje `reason: null → dependent_plan_locked`
po pojawieniu się incoming claim. Pierwotny FAILED zachowano; biznesowego
POST nie ponawiano. Poniższe opisy oczekujące na start/MERGE są historyczne.

**Source22b — reviewed kompilacja i54/54 testy PostgreSQL PASS.**
Oryginalny76509 zakończył się EXIT0. Receipt `9942cd0f…`, Root review `c3083fdf…`:
259 dodatków,21 zmian,17 pełnych funkcji i4 CHECK; cały inverse do literalnego208.
Pełne187/173 oraz cztery bezpośrednie capability przeszły przed COMMIT przy8s;
54 testy bez pominięć, identyczny post-QA katalog,28 dawnych tabel i19 wartości
pochodnych zachowane. Role bez zmian; normalny DROP wyłącznie własnej bazy przy0
połączeń, zamknięcie obu klientów potwierdzone. Aplikacyjny inverse pełnego
rzeczywistego katalogu także PASS (`d99f597b…`). Pakiet15 `e00eebe6…` zbudowany,
379 plików/100605831B w limicie96MiB. Nie jest to jeszcze READY ani odbiór MERGE
na zachowanych danych przez UI/API.

**Upgrade02 zachowanej kopii: reviewed PASS.** Oryginalny91418 EXIT0, receipt
`09dbc56b…`, Root review `b70c7a5d…`. Przed/po wszystkie627 fingerprintów;
dokładnie624 tabele bez zmian, basis ma kompletny nowy wiersz źródłowy, manifest
zmienia tylko fingerprint496c→a3ad, kontrola182 generation1400→1466 odpowiada66 DDL.
Wszystkie7 bram przeszły przy8s, COMMIT i endACK potwierdzone. Poprzednia01 nie
wykonała DDL i zakończyła się ROLLBACK: historyczna precondition nie uwzględniła
dwóch zatwierdzonych CREATE IF NOT EXISTS podczas wcześniejszych prób startu14b.
02 zachowuje ścisłą kontrolę całego wiersza i źródłową deltę267+2, bez resetu
lub przyjmowania dowolnego licznika. Zintegrowany zestaw Root:76 PASS /0 SKIP.
Start aplikacji i biznesowy MERGE nadal wymagają osobnego odbioru.

**Start15b i następny pakiet16.** Oryginalny95658 zakończył się EXIT1 przedREADY;
PID95507/95512 następnie potwierdzono jako nieobecne. Dokładnie jedna diagnostyka
tego samego pakietu24086 wskazała `stock-writer-source-sha` w returns.ts. Doszła
do prepareStockWriterActivation po pełnym cold etapie, więc wcześniejsza odmowaPIM
nie jest przyczyną tej próby. 41 pozostałych pinów writerów i3 Native są literalne;
nowy pin0f32/39085 odpowiada commitowi a251dfe, a test odwraca cztery dokładne
zmiany do starego cce7/38350. Pakiet16 `691a7cb5…` zachowuje ten sam SQL0e03,
kontrakt121a i dane22b. Root39/39 testów coverage/supervisor/email, typecheck i
Vite build PASS. Start16 i biznesowy MERGE jeszcze nieodebrane.

**Historia diagnostyki prowadzącej do naprawy:**
Pierwsza diagnostyka `59291` zakończyła się57014 przy8s na publicznym PIM, przed
instrumentowanym187. Oryginalny trace wskazał wave→packed→PIM; nie uznano tego za
poprawną odmowę biznesową. Nowy operator `10541` mierzył najpierw instrumentowany187
i zachował pierwotny błąd55000: `204 exact current predecessor input required`,
`order_merge_delivery209_history_predecessor_project` linia6, blok187 linia376.
Argument helpera zawierał już metadane sprowadzone do strony BEFORE, podczas gdy
pętla sześciu korzeni porównywała go z surowym AFTER. Obie próby potwierdziły
ROLLBACK, normalny DROP własnej bazy przy0 połączeń i zamknięcie obu klientów.
Osobny waveDO w02 nie został osiągnięty; nie przypisano mu PASS.

Poprawka dotyczy jednego wykonywalnego odczytu metadanych, wyłącznie dla22.
Zachowuje pełną równość deskryptorów, dalszy inverse204 oraz historyczne literały.
Oddzielna poprawka PIM ocenia rzeczywisty wave raz w tej samej inwokacji i przekazuje
wynik czterem prywatnym klonom. Wszystkie25 guardów, starsze gałęzie, nagłówki,
kontrole manifestów, ACL i źródłowe hash pozostają wymagane. Nie zapisuje werdyktu
między wywołaniami. Trzy klony mają projekcję1/1/11 odczytów i hash; issuer zachowuje
ścisłą identity po potwierdzeniu zera takich odczytów. Wszystkie cztery klony są
ujęte w pełnym fingerprint i właścicielskim zamknięciu ACL.

Koordynator wykonał zintegrowane74 kontrole:74 PASS /0 FAIL /0 SKIP.
SQL18–21 pozostaje literalny. Prywatny kandydat Source22b ma28449419B i SHA256
`0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a`;
źródłowa podstawa17 funkcji ma21756960B / `ed45aecdcf4d959c7ff636cd315a12162316f030cb1e382e7e82e5ed6eb4a2d4`.
W chwili przygotowania kandydat miał status **SOURCE_ONLY_NOT_COMPILED**.
Późniejsza rzeczywista próba76509 i promocja SQL/kontraktu mają odbiór opisany wyżej;
aktualizacja kopii, READY i biznesowe UI/API nadal pozostają otwarte.
[Receipt diagnostyki02](../../../../local-builds/full-base-preview-20261017/source22-runtime-boundaries02-prepared-1792299300002/run/receipt.private.json),
SHA256 `23bbc5c6e380d73e684a02b122c7920318ea234a10ad6c37574a42091405fa57`,
oraz [przegląd koordynatora](../../../../local-builds/full-base-preview-20261017/source22-runtime-boundaries02-prepared-1792299300002/root-terminal-review.private.json),
SHA256 `56dc3ee9e3de5678b9ab3717f655abe6e5db9b0ca26f93b6f47f0e8d640332bd`,
zachowują dokładne granice tego rozpoznania.

**Source22 — gotowy kod naprawy, bez odbioru Native.** Commit `57a63b6` domyka
publiczną ścieżkę siedmiu walidatorów zależnych od kompletacji i jej prywatny helper dostawy.
Wszystkie 17 funkcji ma pełne deskryptory BEFORE/AFTER; zachowano nagłówki, ACL
i historyczne dane certyfikatów. 50 kontroli kodu oraz niezależny przegląd źródeł przeszły,
w tym literalna zgodność SQL wersji 18–21. Prywatny kandydat SQL ma 28424454 B i SHA256
`8b5c1f90883102db9ab3d55948e7ae22da388c1d8f29e8161bc8f28032af8757`.
Nie zastąpił pliku SQL209 ani kontraktu Source21. Profil QA22 wymaga 54 rzeczywistych PASS
bez SKIP; domyślny wynik 1 PASS / 53 SKIP potwierdza wyłącznie kontrole bez PG.
**Rzeczywista próba Source22 `55710`: FAILED, bez COMMIT.** Na nowej własnej bazie
potwierdzono dokładny katalog208, deltę255 dodatków /21 zmian /0 usunięć (17 funkcji,
4 CHECK), pełny inverse do `6dcfbee7…` oraz literalną zgodność28 starych tabel
certyfikatów. Cztery pojedyncze predykaty modułu i wspólne pięć były true, lecz pełny
`ordinary187_valid()` zwrócił false przy niezmienionym limicie8s; nie był to timeout.
54 testy Native i cztery bezpośrednie capability pozostały NOT_RUN. Nie nadano odbioru
ani nie zastąpiono SQL209 lub kontraktu Source21. Potwierdzono ROLLBACK, normalny DROP
wyłącznie własnej bazy przy0 połączeń, zamknięcie obu klientów i zgodność ról przed/po.
[Receipt próby22](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory22-accelerated-prepared-1792298030387/run/receipt.private.json),
SHA256 `8b5034f32f13597b9b921f59bd546a8e9ee6570b2dc9ac17763d9bdbce17d2ab`,
oraz [przegląd koordynatora](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory22-accelerated-prepared-1792298030387/root-terminal-review.private.json),
SHA256 `114b1dca04d4613c67ed6bd500e71fe8e09de367eb5f6f29b265dad810701e73`,
zachowują ten wynik. Diagnoza konkretnego warunku odmowy, aktualizacja kopii, READY
i biznesowy MERGE pozostają otwarte. Main i zachowana kopia biznesowa bez zmian.

**Aktualizacja18.10 — upgrade04 na zachowanej kopii: reviewed PASS.**
[Receipt upgrade04](../../../../local-builds/full-base-preview-20261017/source21-preview-upgrade04-20261018/receipt.private.json),
SHA256 `c2c215ead48b85157f074dabcbcec6eb30193b2c2fbf903386839d94bd2d482d`,
oraz [przegląd koordynatora](../../../../local-builds/full-base-preview-20261017/source21-preview-upgrade04-20261018/root-review.private.json),
SHA256 `198d7511c5ff25b8518ca4311b183127e2c09eab108a8a6d12795510c7f4c54b`,
potwierdzają zgodność wszystkich627 tabel oryginalnego preview i kopii **przed pierwszym GRANT**.
Po aktualizacji624 pozostałe tabele zachowały fingerprinty. Trzy wyjątki nie zostały pominięte:
własne payload/manifest209 mają dokładną źródłową zmianę, a kontrolna krotka182 zachowuje
pełną sprawdzoną semantykę invalidacji: generacja+232 po naprawie reprezentacji właścicielskich
ACL i+267 po całości, dirty=true oraz pola wcześniejszej walidacji wyczyszczone. Nie wyłączano
tego triggera, nie cofano epoki i nie nadawano approval. Rzeczywisty ledger NOT NULL zachowano;
istniejąca ścisła projekcja służy wyłącznie porównaniu metadanych. Pełne187/173 zwróciły true
w2151,299583/2150,275125ms przy8s. COMMIT i zamknięcie obu klientów potwierdzono.
Upgrade dotyczył wyłącznie kopii na57083; Main i oryginalny preview57081 pozostają bez zapisu.

Pierwszy start pakietu14 zakończył się EXIT1 **przed PG**, bez READY: selection używała
`postgresql:`, podczas gdy runtime wymaga `postgres:`. Zachowano jego zamknięty stan.
Nowe selection/profile14b zmieniają tylko równoważny protokół URL i wynikowe piny;
pozostałe składniki połączenia, klucz szyfrowania, wydaniefe95 i port4103 są identyczne.
Oryginalny start14b `7072` zakończył się EXIT1: **FAILED_NOT_READY**, stan closed, dziecko86752
zakończone, publiczny stderr65B sygnalizuje AssertionError bez dokładnej przyczyny. Guard plikowy
z rzeczywistym reviewed receipt upgrade04 przeszedł; nie jest to odbiór aplikacji. Koordynator
uruchomił jednorazową diagnostykę `98212` rzeczywistego eksportu packaged CLI z tymi samymi
wejściami i prywatnym trace. Diagnostyka zakończyła się EXIT1: `ordinary184-cold-capability-predicate:pim_dictionary_valid`, wynik false zamiast true. To niezależny predykat capability; wynik pełnego187/173 nie stanowi jego odbioru. Nie ponawiano startu profilu. Classified MERGE przez zwykłe
UI/API, recovery, skala i wspólne wydanie pozostają otwarte. Nie wykonano nowej operacji biznesowej.

Diagnostyka koordynatora `89260` w rzeczywistym kontekście UTC/search_path potwierdziła
`order_merge_delivery209_valid()=true`, lecz publiczny wave177 i cztery niezależne capability
pozostały false. Z25 publicznych poprzedników PIM tylko operative delivery, packed label,
parcel physical WZ i warehouse WZ issuer zwróciły false; pozostałe21 były true.
[Receipt predykatów](../../../../local-builds/full-base-preview-20261017/source21-pim-predecessor-UTC-predicates.private.json),
SHA256 `f5155a71a37518d9305babf41ff54a4148daa434e582de2e523acf5f08cc9312`.
[Osobna kontrola metadanych](../../../../local-builds/full-base-preview-20261017/source21-current-metadata-identity.private.json),
SHA256 `c5dfebe2c974bd05d337ebd6b9ab5e0595d6150914c43152be2e9887c12a5d4c`,
potwierdza identyczny surowy katalog `90c26f9b…` jak po upgrade04 i brak mutacji metadanych
podczas startu. Historyczne46 testów Native nie sprawdzało czterech bezpośrednich capability;
rozszerzenie QA `805130d` dodaje te kontrole źródłowo, bez nowego wyniku Native.
Most biznesowy split `f9323d2` ma36 kontroli i build PASS koordynatora; Native210, routes i UI
pozostają nieaktywne. Jednorazowa diagnostyka wave wskazała `ROOT_WAVE_TERMINAL_OPERATIVE`: wcześniejsze34 warunki i terminal nested przeszły, a operative zwrócił false. Receipt `892862541c5c92b1e875e6f356311e534bc5f8cf9d497c79ff4c1850114393e7` potwierdza ROLLBACK, niezmienioną krotkę182, brak funkcji tymczasowej po rollback i zamknięcie klienta. To lokalizacja odmowy, bez odbioru poprawki lub startu.


**Bieżący etap18.10: Source21 Native integrity — reviewed PASS na runtime03.**
Oryginalny operator `2451` zakończył się EXIT0: pełne187/173 zwróciły true
w2227,573375/2140,950917ms przy niezmienionych8s, COMMIT potwierdzono,
a46/46 testów Native przeszło bez FAIL/SKIP/CANCEL. Dokładna baza208,
delta240/14/0, literalne28 starych tabel certyfikatów i pełny odczyt poQA
pozostały zgodne. Normalny DROP własnej bazy przy0 połączeń i zamknięcie
obu klientów potwierdzono. [Receipt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory21-accelerated-prepared-1792294650941/run/receipt.private.json)
ma SHA256 `af03a68cb4441eb8410492f68dd7c32fa6a2164177c1af031bfddb506b0a36f2`;
[niezależny przegląd koordynatora](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory21-accelerated-prepared-1792294650941/run/root-review.private.json)
ma SHA256 `5445dfdeeef966d122f3d0f6e02966f83a606b8bbdaca98141b5a033f623f77c`.
Próba używała tego samego SQL956/54pinów/generacji21, limitów120s/900s
i osobnego PostgreSQL18.4 na57083. Oryginalny operator `46112` utrzymuje
runtime03/PID82507 z faktycznie załadowanymi prywatnymi crypto/SSL5434/bb86;
osiem digestów SQL 0B–10MiB jest równych Node.

To odbiór źródłowej kompilacji i integralności Native na przypiętym runtime.
**Aktualizacja Source18→21 na osobnej kopii przeszła w upgrade04 opisanym powyżej. READY aplikacji,
classified MERGE przez zwykłe UI/API, recovery oraz wspólne wydanie pozostają otwarte.**
Nie przełączono Main i nie zmieniono wcześniejszych klastrów57081/55432.
Wcześniejsze nieudane próby domyślna/LZ4 zachowują swoje receipts i granice.
Próby startu01 (gniazdo Unix>103B) i02 (hardened-runtime ignorował DYLD)
zakończyły się FAILED i normalnym stopem; cleanup ich78,242MiB zachował logi.
Nowy prywatny runtime ma identyczny kod `__TEXT,__text`, lokalne linkowanie
i podpis ad-hoc, bez zmian SIP lub oryginalnych bibliotek.
Lokalne `db5659e`, `08934b7` i `8a1b98c` obejmują kontrole historii,
26 testów PG TEMP, listę stronicowaną oraz53 kontrolowane/29 końcowych PG TEMP;
build przeszedł. Izolowany wizualny receipt79ef przy1440px/390px jest dowodem
syntetycznego komponentu/CSS, bez odbioru uwierzytelnionego UI lub biznesowego POST.


**Aktualizacja18.10.2026 — domyślny Source21 i osobna próba LZ4 odmówiły.**
Oryginalny kompilator `65047` zakończył się EXIT1: cztery single i wspólne
pięć predykatów zwróciły true, ale pełny `ordinary187_valid()` przekroczył8s
(57014) w ścieżce snapshot/checked map→partial predecessor→buyer→PIM→parents.
Nie było COMMIT;46 testów Native mają **NOT_RUN**, bez odbioru startu lub MERGE.
Potwierdzono ROLLBACK, normalny DROP własnej bazy przy0 połączeń i zamknięcie
obu klientów. [Receipt21](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory21-prepared-1792292504656/run/receipt.private.json)
ma SHA256 `d77922eaf2444773fb984d8df68335b73d157ddc548d5d85567032703f730f17`.
SQL `95605368565cbec656fd41db95192879d450d700d13424bb7b575186c447572b`
ma27545803B; deklarowana baza operatora to `095af87b…`, kod zapisano w `f225163c…`.

Osobna próba **Source21-LZ4 EXIT1**, oryginalne uruchomienie `22554`, użyła katalogu
`order-merge-delivery209-source-compiler-memory21-lz4-prepared-1792292778172`.
Zachowuje ten sam SQL,54 piny,8s/120s oraz46NativeQA/900s. Zmienia wyłącznie
sesyjne `default_toast_compression=lz4` przed DDL we własnej nowej bazie,
z jawnym odczytem ustawienia; nie zmienia Main ani istniejących danych.
Cztery single i wspólne pięć predykatów były true, ale pełny `ordinary187_valid()`
ponownie przekroczył8s (57014), tym razem w ścieżce source-SHA/partial valid→
financial/invoice/credit→PIM/parents. Nie było COMMIT;46Native mają **NOT_RUN**.
ROLLBACK, normalny DROP własnej bazy przy0 połączeń i zamknięcie obu klientów
są potwierdzone. [Receipt LZ4](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory21-lz4-prepared-1792292778172/run/receipt.private.json)
ma SHA256 `197d77b710c68de4a286486665398901f76128de7d8c6240ad73a6a0069c9051`.
Nie potwierdzono przewagi wydajności ani odbioru przy8s.
[Osobny odczyt Source18](../../../../local-builds/full-base-preview-20261017/source209-current-toast-readonly-probe.private.json)
(`bb8db7dd…`) potwierdził fizyczny PGLZ w trzech dużych funkcjach, rollback i zamknięcie klienta.
Binarium PostgreSQL18.4 ma OpenSSL/LZ4 i `-O2`; to warunek techniczny badania,
nie pomiar przewagi LZ4 ani odbiór recovery. Historyczne Source20 true przy14s
poniżej nie oznacza spełnienia8s. Main, brak READY podglądu13 i otwarte
classified MERGE/split/skala/recovery zachowują dotychczasowe granice.


**Oddzielna diagnostyka Source21-LZ4: true, nadal ponad8s.** Oryginalne
uruchomienie `39873` EXIT0 zwróciło true dla pełnych187 i173 w8852,068875ms
oraz8650,197292ms (pojedyncze wywołania, diagnostyczne120s).
[Receipt548c](../../../../local-builds/full-base-preview-20261017/source209-full-runtime-profile21-lz4-prepared-1792293093679/run/receipt.private.json)
ma SHA256 `548c5ad8eb56dc8527d356068ac13cf4286224462d3435a70618714a22f812df`.
Wymuszony ROLLBACK, normalny DROP własnej bazy przy0 klientach i oba zamknięcia
potwierdzono. Brak COMMIT/46NativeQA; to nie spełnia8s ani odbioru produktu.
Prototyp odczytu bajtów definicji przeszedł rzeczywistą read-only równość pełnych
24 pól/10 funkcji, lecz trzy pary pomiarów około 104–107 ms nie wykazały istotnego
zysku, a nowy plan zapisał 634 bloki tymczasowe. Pozostaje **niezintegrowany**.
[Receipt prototypu](../../../../local-builds/full-base-preview-20261017/fingerprint209-definition-bytes01-diagnostic.private.json)
ma SHA256 `8cef69bbb9d6e255a2d3f60bc581616ef7bbf02ae5ad636ee37d8189d8cd13cc`;
ROLLBACK i zamknięcie klienta potwierdzono.
Osobny prywatny OpenSSL 3.5.6 ARM64/ASM/O3 ma sprzętowy kod SHA256 i dał
równe digests w mikrobenchmarku EVP: stary/nowy/Node mediany 84,609/3,607/3,592 ms
na 10 MiB (12 prób). [Receipt builda](../../../../local-builds/crypto-accelerated209/openssl-3.5.6-arm64-o3/build-result.private.json)
`9cc4e788…` nie jest odbiorem PostgreSQL ani 8 s; istniejąca biblioteka i usługi
pozostały bez podmiany. Nowy runtime wymaga osobnych pełnych bram.
Lokalne `28a3787` (RMA) i `4cf53ed` (worker),52/22 testy kontrolowane, nie oznaczają
nowego odbioru UI/API, dostawcy, pełnej skali lub recovery. Kolejne lokalne
`977c9bd` (płatności, 10 testów kontrolowanych) i `2dbd6ce` (cała historia
uzgadniania, 29 testów kontrolowanych) również nie nadają odbioru wspólnego
wydania lub godzinnej skali. Main pozostaje bez zmian.

**Aktualizacja 18.10.2026 — Source20: logiczne true, limit8s nadal otwarty.**
Oddzielna diagnostyka zakończyła się EXIT0: `ordinary187_valid()` zwróciło
true w14169,12ms, a `large_import173_valid()` w13617,65ms. Każde wejście
wywołano raz z diagnostycznym limitem120s. To rozdziela domknięcie logiczne
od opóźnienia; wcześniejszy kompilator20 nadal odmówił przy wymaganych8s.
Nie było COMMIT, NativeQA, aktywacji aplikacji ani wykonania MERGE.
Potwierdzono ROLLBACK, normalny DROP własnej bazy przy0 połączeń i zamknięcie
obu klientów. [Receipt diagnostyki](../../../../local-builds/full-base-preview-20261017/source209-full-runtime-profile20-prepared-1792291691304/run/receipt.private.json)
(`6532b7cd…`) zachowuje wynik bez nadania odbioru Native, p95 lub wydania.
Commit produktu `216f67c` wiąże próbki płatności/RMA z atomowym wynikiem;
pełny profil skali nadal odmawia uruchomienia przez siedem brakujących bramek.
Ujemne korekty WMS zapisano w `7222768` (34 testy kontrolowane), bez odbioru
rzeczywistego HTTP/WMS. Main bez zmian,
podgląd13 nadal bez READY; classified MERGE, split, skala i recovery otwarte.
Starsze wpisy poniżej zachowują zakres własnych prób.

**Aktualizacja 18.10.2026 — Source19: pełna brama startowa nadal otwarta.**
Kandydat `97208701…` wykonał DDL w transakcji i zachował dokładną deltę
235 dodatków/14 zmian/0 usunięć oraz literalne 28 starych tabel certyfikatów.
Koordynator niezależnie potwierdził pełny inverse do Source208:
62402967B / `c59a648f…`, canonical `6dcfbee7…`.
Cztery pojedyncze kontrole i dotychczasowa wspólna brama pięciu przeszły,
lecz dodany rzeczywisty `ordinary187_valid()` zakończył się 57014 przy 8s
w ścieżce finansowej. Nie było COMMIT ani uruchomienia 41 testów Native.
Oryginalny kompilator `69907` zakończył się EXIT1; potwierdzono ROLLBACK,
normalny DROP własnej bazy przy 0 połączeń i zamknięcie obu klientów.
Trzy prywatne adaptery historii mają 24 testy plikowe PASS i lokalny commit
`55945f8`. Nie osłabiono walidacji ani budżetów; dalszy pomiar ma ustalić
koszt rzeczywistej ścieżki. Main pozostaje bez zmian, a podgląd13 nie jest READY.
Source18 37/37 opisuje kontrole modułu, które nie obejmowały pełnego187/173.
Nie jest to odbiór biznesowego MERGE, splitu ani pełnego Goala.


**Start12: zachowana odmowa i naprawa osobnej bramy187.**
Pierwszy start pakietu12 zakończył się EXIT1 przed READY. Migracja209 jest
zatwierdzona na istniejącej bazie podglądu; Main nie zmienił wydania.
Kontrolowany odczyt potwierdził poprawny pełny katalog i inverse209, a osobny
odczyt odtworzył odmowę `205 entire current descriptor required` w kontroli
`ordinary187_valid()`. Jej przygotowanie SQL znało205, bez następcy209.
Nowa ścisła kompozycja209→205→204 zachowuje cały historyczny anchor i
sprawdza hash rzeczywistej bieżącej funkcji209. Pięć focused tests PASS;
rzeczywisty odczyt deskryptora i siedem anchorów PASS, z rollbackiem oraz
zamknięciem klienta. Nie wykonywano operacji biznesowej ani ponownego MERGE.
Dowody: `preview12-cold-diagnostic.private.json`,
`preview12-durable187-diagnostic.private.json` oraz
`preview12-durable187-fixed-diagnostic.private.json` w katalogu podglądu.
Nieudany service12 zachowuje swój stan; nie podnoszono180s/60s ani8s/120s.

**Aktualizacja18.10.2026 — Source18: pełny odbiór Native, wydanie12 zbudowane.**
SQL `9e25cb8442f85380eac367c26ba0d0c9fd0f7f6ac1588ed281cab153d9d8b50d`
przeszedł rzeczywistą kompilację, COMMIT i37/37 NativeQA bez pominięć.
Wspólna kontrola pięciu predykatów zwróciła wszystkie true w5738,18ms przy
niezmienionym limicie8s. Dwanaście kolumn STORED i dwanaście niezależnych
CHECK surowego payload dało dokładnie232 dodatki/14 zmian/0 usunięć.
Root sprawdził1229 ciągłych zdarzeń,84 piny archiwów, literalne28 starych
tabel certyfikatów, pełny katalog przed/po QA, niezmienione role i normalny
DROP własnej bazy przy0 połączeń. Oryginalny terminal51935 zakończył się EXIT0.
[Receipt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory18-prepared-1792286957446/run/receipt.private.json)
(`12df76f2…`) i [niezależny audyt Root](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory18-prepared-1792286957446/run/Root-independent-terminal-review.private.json)
(`27f96467…`) wiążą wynik. Pierwszy caller odmówił przed PG z powodu złej
reprezentacji ścieżki preparedDirectory; poprawiono wyłącznie tę relację przed
jedynym rzeczywistym uruchomieniem Source18, zachowując pierwszy błąd.

Pełny file-only inverse bieżącego katalogu przywrócił literalny Source208:
62402967B/SHA `c59a648f…`, kanoniczny SHA `6dcfbee7…`.
Stały moduł E209 wiąże tę deltę i źródłowy program biznesowy; projekcje cold
oraz mapy28 zachowują wcześniejsze pełne porównania i odmowy.
To reprezentacja metadanych, bez przyznania autoryzacji lub gotowości aplikacji.

Rzeczywisty builder wyemitował pakiet12 `11301186…`:379 plików,
100015196B, przy niezmienionych limitach16MiB/96MiB. Nowy format używa
przypiętego gzip209 oraz trzech stałych fizycznych plików178/201/202.
Wejście Source05 `4a895667…` zmienia wyłącznie dwa przejrzane źródła runtime
względem Source04;57 pozostałych członków, Native, profil i ABI są literalne.
Build frontendu/typecheck PASS. Pełny start12 i classified MERGE przez zwykłe
API/Chrome pozostają osobnym odbiorem; split210 i pełny Goal pozostają otwarte.

**Aktualizacja18.10.2026 — memory17: szybsze single, wspólna brama nadal otwarta.**
Źródło `e489b9f3…` ukończyło DDL i zachowało dokładną deltę208 dodatków,
14 zmian i0 usunięć. Cztery pojedyncze kontrole true:147,52/4342,22/
3510,16/15,14ms. Wspólna kontrola pięciu predykatów zakończyła się57014
po8020,18ms, przed COMMIT. NativeQA nie uruchomiono. Wynik nie nadaje
odbioru MERGE ani aktywacji nowego wydania.

Root sprawdził1098 ciągłych zdarzeń,56 pinów archiwów i literalne28 starych
tabel certyfikatów, rollback, niezmienione role oraz normalny DROP własnej
bazy przy0 połączeń i zamknięcie klientów. Oryginalny terminal67851 EXIT1.
[Receipt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory17-prepared-1792286365209/run/receipt.private.json)
(`4d2a8652…`) i [audyt Root](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory17-prepared-1792286365209/run/Root-independent-terminal-review.private.json)
(`87a90e13…`) zachowują nieudany wynik. Następna zmiana wydziela małe,
niezależnie sprawdzane kolumny generowane z tego samego surowego DATA,
z zachowaniem pełnych bieżących kontroli i niezmienionych budżetów.

**Aktualizacja18.10.2026 — kompaktowa ekstrakcja: rzeczywisty mały pomiar.**
W jednej transakcji TEMP na PostgreSQL18 porównano trzy sposoby odczytu
dziesięciu key/after_check z identycznej mapy źródłowej21,15MB: ścieżki JSONB
68,43ms, elementy tablicy72,49ms, typed recordset51,03ms. Wszystkie dziesięć
hashy kompletnych after_check było zgodne z niezależnymi źródłowymi wartościami.
Root potwierdził oryginalny terminal74369 EXIT0,9 zdarzeń, rollback, brak obu
obiektów TEMP, niezmienione role/tożsamość i zamknięcie klienta.
[Receipt](../../../../local-builds/full-base-preview-20261017/source209-compact-extraction-prepared-1792285904389/run/receipt.private.json)
(`b9bac929…`) i [audyt Root](../../../../local-builds/full-base-preview-20261017/source209-compact-extraction-prepared-1792285904389/run/Root-independent-review.private.json)
(`d7a742ff…`) opisują stałą kolejność i jeden pomiar każdego wariantu.
To sam odczyt źródłowego DATA z nieodebranej próby16, bez aktualnego odczytu
całego katalogu, pełnych guardów, p95, Native lub operacji biznesowych.

Kandydat17 `e489b9f3…` zmienia wyłącznie cztery bloki ekstrakcji na typed
recordset z zachowaniem MATERIALIZED, wszystkich bieżących nagłówków,
kontroli rosteru i pełnej mapy. Odwrócenie czterech bloków odtwarza cały
SQL67 bajt w bajt. Root37 testów źródłowych PASS; pełna próba pozostaje
osobną bramą. Nie deklarujemy przyspieszenia całego MERGE z tego mikrotestu.

**Aktualizacja18.10.2026 — memory16: wspólna brama nadal odmawia.**
Kandydat67e5bc59 przywraca wyłącznie zmierzony lokalny helper193 i zachowuje
cztery walidatory MATERIALIZED. Root36 testów źródłowych PASS; odwrócenie tej
jednej rutyny przywraca cały SQL47 bajt w bajt, w tym mapę10 i wszystkie ACL.
Rzeczywista kompilacja ukończyła DDL, dokładną deltę208 dodatków/14 zmian/
0 usunięć oraz dosłowne28 starych tabel certyfikatów. Cztery single true:
147,65/6657,90/5126,60/15,02ms. Combined5 zakończył się57014 po8020,04ms,
przed COMMIT i bez uruchomienia NativeQA. Stack: lokalny descriptor14,
source11, partial_sale204_valid10. Nie nadano odbioru ani aktywacji.

Root potwierdził oryginalny terminal35580 EXIT1,1098 ciągłych zdarzeń,
56 pinów archiwów certyfikatów, pełny ROLLBACK, normalny DROP przy0 połączeń
i zamknięcie klientów. [Receipt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory16-prepared-1792285457488/run/receipt.private.json)
(`0bb82af2…`) oraz [audyt Root](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory16-prepared-1792285457488/run/Root-independent-terminal-review.private.json)
(`dfee0869…`) zachowują wynik. Kolejny pomiar porówna trzy sposoby ekstrakcji
kompaktowych powiązań z tej samej źródłowej mapy, bez zmiany bram lub metadanych.

**Aktualizacja18.10.2026 — porównanie lokalnego helpera zakończone.**
Na źródle47 odtworzono dokładny208, zainstalowano209 i potwierdzono208
dodatków/14 zmian/0 usunięć oraz dosłowne28 starych tabel certyfikatów.
Identyczny batch dziesięciu wywołań lokalnego deskryptora zwrócił wszystkie
pełne hashe BEFORE zgodne z mapą źródłową: obecny47 w1131,42ms, literalny
helper193 w775,63ms. Pełny indeks FUNCTION wykazał dokładnie jedną zmianę;
mapa pozostała literalna. Po podmianie własna kontrola209 prawidłowo odmówiła.
Nie wykonywano reseal, COMMIT, NativeQA ani operacji biznesowej.

Root potwierdził oryginalny terminal1584 EXIT0,1142 ciągłe zdarzenia,
62 piny artefaktów, pełny ROLLBACK, normalny DROP przy0 połączeń i zamknięcie
klientów. [Receipt](../../../../local-builds/full-base-preview-20261017/source209-local-descriptor-comparison-prepared-1792284754163/run/receipt.private.json)
(`c912ee25…`) i [niezależny audyt Root](../../../../local-builds/full-base-preview-20261017/source209-local-descriptor-comparison-prepared-1792284754163/run/Root-independent-review.private.json)
(`b37a604d…`) wiążą wynik. Kolejność47→193 była stała; współdzielony koszt
haszowania, rozgrzanie i narzut śledzenia ograniczają wnioski. To pojedynczy
pomiar helpera, bez odbioru wydajności, p95 lub całego MERGE. Następny kandydat
przywraca wyłącznie lokalny helper193, zachowując cztery walidatory MATERIALIZED;
jego pełna kompilacja i30 kontroli Native pozostają osobną bramą.

**Aktualizacja18.10.2026 — memory15: DDL i single przeszły, combined nie.**
Źródło `47f80aef…` ukończyło DDL209 i dokładną deltę208 dodatków/14 zmian/
0 usunięć. Cztery pojedyncze kontrole zwróciły true w149,92/7452,75/6686,18/
15,31ms. Wspólna kontrola pięciu predykatów zakończyła się57014 po8015,54ms,
przed COMMIT. **QA Native nie uruchomiono**; nie jest to wynik0/30. Stack
wskazuje lokalny predecessor_descriptor, jego wrapper definition i odczyt buyer.
Nie ma potwierdzenia poprawy względem193; dwa kosztowne single były wolniejsze.

Root potwierdził oryginalny terminal63234 EXIT1, pełny ROLLBACK, normalny
DROP przy0 połączeń i zamknięcie klientów. [Receipt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory15-prepared-1792284121366/run/receipt.private.json)
(`ca7647eb…`) oraz [audyt1098 zdarzeń](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory15-prepared-1792284121366/run/independent-terminal-review.private.json)
(`817ef671…`) zachowują ten wynik. Audyt wiąże56 referencji archiwów i28
wpisów indeksu certyfikatów przed/po, bez claim pełnego katalogu po QA.
Następny pomiar porówna bezpośrednio dwie wersje lokalnego helpera na tej samej
mapie i dziesięciu bieżących powiązaniach, z całkowitym rollbackiem i bez reseal.

`65b54e8` dodaje osobny niewpięty prymityw dla rzeczywistej mapy28 poprzedników:
pełne20 pól dwóch obecnych zmienionych funkcji musi być zgodnie BEFORE albo
AFTER. Pozostałe26 zachowuje do pełnego porównania rodzica. Walidacja10 funkcji
w wymaganym kontrakcie źródłowym nie oznacza10 aktualnych odczytów. Root7
focused testów PASS; brak domyślnego E209, Native, cache lub zgody na instalację.
Osobny zakończony [test plikowy mapy28](../../../../local-builds/full-base-preview-20261017/source209-predecessor-metadata-roundtrip-1792284611045/result.private.json)
(`64319532…`) wyprowadził rzeczywiste20 pól z przypiętych pełnych rekordów
katalogu Source15 i niezależnego SQL170/173. Całe28 wartości po inverse jest
równe BEFORE;26 pozostałych zachowano, owner-tamper odrzucono. Kolejność
kluczy JSON różni się, zatem nie jest to dowód identycznej surowej serializacji.
To reprezentacja z katalogu, bez rzeczywistego SELECT173, Native lub aktywacji.

**Aktualizacja18.10.2026 — memory14: regresja instalacji, bez NativeQA.**
Źródło `e538fcea…` z bezpośrednimi ścieżkami JSONB zakończyło sourceDDL57014
po122093,79ms przy niezmienionym limicie120s. Stack wskazuje FOR w
checked_projection_map, następnie partial_sale204_predecessor_definition
i buyer_address_guards. Nie ukończono DDL209, nie ma katalogu/certyfikatów
AFTER209, COMMIT ani uruchomionego QA Native. Nie jest to wynik0/30.
Root potwierdził oryginalny terminal71585 EXIT1, ROLLBACK, normalny DROP
przy0 połączeń i zamknięcie klientów.
[Receipt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory14-prepared-1792283694189/run/receipt.private.json)
(`8341b917…`) i [audyt964 zdarzeń](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory14-prepared-1792283694189/run/independent-terminal-review.private.json)
(`e68e0d6c…`) zachowują nieudany wynik bez replay.

`45c7cf3` wyznacza granicę MATERIALIZED dla dokładnie10 kompaktowych rekordów
key/after_check przed skanami katalogu. Zapobiega podstawianiu wyrażeń
wyciągających liście dużego JSONB do predykatów skanów. Rzeczywisty plan
nie został jeszcze zmierzony; wynik14 sam nie dowodzi wyłącznej przyczyny.
Root35 testów źródłowych PASS. W źródle `47f80aef…` zmieniono dokładnie4
ciała helperów; po ich odwróceniu cały SQL jest literalny względem e538,
w tym DATA,10 historycznych następców, ACL i190 odczytów. Pomiar nowego
kandydata pozostaje osobną bramą. Main i podgląd nadal bez209/210.

**Aktualizacja18.10.2026 — profil funkcji ukończony, odbiór209 otwarty.**
Dokładne źródło193 przeszło diagnostykę w osobnej pustej bazie. Cztery pojedyncze
kontrole zwróciły true w147,33/4582,90/3713,37/25,74ms; wspólna kontrola pięciu
predykatów zakończyła się57014 po8010,22ms. Śledzenie było wyłącznie LOCAL,
bez resetu globalnego, bez COMMIT i bez uruchomienia NativeQA. Root potwierdził
oryginalny terminal61926 EXIT0, pełny ROLLBACK, przywrócenie track_functions,
normalny DROP przy0 połączeń i zamknięcie klientów.

Statystyki zakończonych wywołań wskazują w buyer: lokalny predecessor_descriptor
27 razy /1533,66ms self, fingerprint12 razy /1320,67ms self oraz
checked_projection_map707 razy /1224,69ms self. Nie dowodzą wyłącznej przyczyny:
deskryptor obejmuje również pełne świeże nagłówki i SHA tekstów; wiele wywołań
mapy kończy się przed odczytem dużego payloadu. Czas anulowanej ramki może być
nieobecny; total_time obejmuje dzieci i nie wolno go sumować. To diagnostyka
z narzutem instrumentacji, bez pomiaru p95 lub odbioru wydajności.
[Receipt](../../../../local-builds/full-base-preview-20261017/source209-function-xact-diagnostic-prepared-1792282993783/run/receipt.private.json)
(`68093065…`) i [niezależny audyt](../../../../local-builds/full-base-preview-20261017/source209-function-xact-diagnostic-prepared-1792282993783/run/independent-function-xact-diagnostic-review.private.json)
(`6e4f041f…`) zachowują1170 zdarzeń i15 przypiętych artefaktów statystyk.

Następny kandydat ogranicza materializowanie szerokich elementów JSONB przez
bezpośrednie ścieżki do key/after_check/before. Mała rzeczywista próba PostgreSQL
porównała110 ścieżek w11 syntetycznych przypadkach oraz10 kompaktowych wierszy;
wyniki były równe starym operatorom, z pełnym rollbackiem i usunięciem TEMP.
[Wynik semantyki](../../../../local-builds/full-base-preview-20261017/source209-nested-jsonpath-rollback-probe-1792283544973/result.private.json)
(`e173eefe…`) nie jest pomiarem przyspieszenia ani pełnej migracji.

**Aktualizacja18.10.2026 — dokładna odwrotna projekcja metadanych.**
`9b00fa9` dodaje czysty inverse209: usuwa wyłącznie pełny oczekiwany roster
dodatków i przywraca dokładnie10 funkcji oraz4 CHECK. Zachowuje wszystkie
pozostałe rekordy, sprawdza8 FK/32 związane triggery RI, pełne nagłówki,
ACL, overloady i granice JSON. Nie nadaje uprawnień ani gotowości aplikacji;
oczekiwany kontrakt wymaga osobnego uwierzytelnienia przez caller.

Root10 testów PASS. Osobny zakończony test plikowy źródła193 potwierdził
pełną strukturalną i kanoniczną zgodność40243 rekordów poprzednika po usunięciu
208 dodatków i odwróceniu14 zmian. Kolejność pól w surowym JSON różni się.
Wrapper `1e66288` kanonizuje cały katalog i rozlicza osiem liczników;
18 focused testów inverse/wrapper PASS. Zakończony osobny test plikowy wrappera
potwierdził wszystkie liczniki,40243 rekordy, pełny SHA i identyczną serializację
62402967B poprzednika208. Negatywny przypadek zmienionego CHECK został odrzucony.
[Receipt wrappera](../../../../local-builds/full-base-preview-20261017/source209-memory13-wrapper-file-review-1792283689972/receipt.private.json)
(`035bd0e5…`) ma jawnie historyczny zakres częściowego DDL193; nie przypisuje
go nowszemu źródłu ani odbiorowi Native. Proces94581 EXIT0, bez PG/HTTP.
[Receipt testu plikowego](../../../../local-builds/full-base-preview-20261017/source209-memory13-inverse-file-review-1792283212799/receipt.private.json)
(`e338da48…`) dotyczy częściowego DDL sprzed COMMIT. Nie jest kontraktem
E209, ukończoną kompilacją źródła, odbiorem Native ani odbiorem biznesowym.

**Aktualizacja18.10.2026 — memory13: brak potwierdzonej poprawy czasu.**
Źródło `193fe6ee…` zachowuje wszystkie pola metadanych, porównując dwa pełne
liście source/definition przez tagowane SHA256 UTF8. Pełne before/after pozostają
literalne; mapę rozszerzono wyłącznie o źródłowo wyprowadzone `after_check`.
Root32 testy źródłowe PASS i niezależny review nie dają odbioru wydajności.
W rzeczywistej próbie wspólna brama8s zakończyła się57014 po8012,67ms,
**przed COMMIT; QA Native nie uruchomiono**. Pojedyncze wcześniejsze kontrole
miały135,27/5048,83/4108,19/17,40ms. Nie są to p95 ani dowód przyspieszenia.

Oryginalny controller zakończył się EXIT1, z potwierdzonym ROLLBACK, normalnym
DROP przy zerze połączeń i zamknięciem klientów.56 archiwów certyfikatów nadal
zachowuje dosłowne dane. [Receipt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory13-prepared-1792282498085/run/receipt.private.json)
(`9760cfbd…`) oraz [niezależny audyt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory13-prepared-1792282498085/run/independent-certificates-terminal-review.private.json)
(`797e252e…`) pozostają niezmienione. Następny pomiar ma zebrać czasy własne
funkcji w tej samej transakcji, bez resetowania statystyk globalnych, podnoszenia
limitów lub nadawania odbioru Native. Main i podgląd pozostają bez209.
Poniższe wpisy są historią.

**Aktualizacja18.10.2026 — memory12: wspólna brama8s nie przeszła.**
Źródło `ace88a2f…` grupuje odczyty pełnych dziesięciu bieżących deskryptorów
w jednym zapytaniu, zachowując wszystkie pola, roster i odmowy braków/overload.
Root29 testów źródłowych PASS oraz niezależny review nie zastępują pomiaru.
Rzeczywista wspólna kontrola przed COMMIT zakończyła się57014 po8024,42ms.
**Nie wykonano COMMIT ani nie uruchomiono QA Native; liczba wykonanych testów
Native wynosi0.** Nie jest to nowy wynik0/30 ani potwierdzenie poprawy czasu.
Pojedyncze wcześniejsze kontrole miały149,20/3928,71/2937,99/15,27ms.

Oryginalny controller zakończył się EXIT1. Receipt potwierdza ROLLBACK,
normalny DROP przy zerze połączeń i zamknięcie obu klientów. Wszystkie56
archiwów certyfikatów z28 tabel zachowało dosłowne bajty.
[Oryginalny wynik](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory12-prepared-1792282042729/run/receipt.private.json)
(`72cfea96…`) i [niezależny audyt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory12-prepared-1792282042729/run/independent-certificates-terminal-review.private.json)
(`b1a7979c…`) pozostają zachowane. Dalsza optymalizacja ma porównywać świeże
pełne metadane z pełnymi SHA obu wielkich liści tekstowych, bez pomijania pól
i bez cache wyniku kontroli. Main i podgląd pozostają bez209.
Poniższe wpisy są historią.

**Aktualizacja 18.10.2026 — memory11: 27/30 PASS, nadal bez aktywacji209.**
Źródło `156d3cce…` przeszło COMMIT i wspólną, niezmienioną kontrolę pięciu
predykatów w7928,66ms przy limicie8s. To pojedynczy pomiar, z małym zapasem;
nie oznacza odbioru wydajności. Pełne QA zakończyło30 przypadków wynikiem
**27PASS /3FAIL /0SKIP /0CANCEL**:26 przypadków bazy i jeden locator PASS.
`missing-own-helper`, `projection-sha-generation-constant` oraz
`projection-sha-generation-dropped` zakończyły się57014 przy końcowym
odczycie healthy po rollbacku do savepointu. Ich początkowe kontrole i rzeczywiste
odmowy209/buyer przeszły, lecz cały przypadek pozostaje FAIL.

Wszystkie29 przypadków bazowych potwierdziło zewnętrzny ROLLBACK i zamknięcie
klienta. Oryginalny controller zakończył się EXIT1, child EXIT1 bez sygnału;
potwierdzono normalny DROP własnej bazy przy zerze połączeń i zamknięcie klientów.
56 archiwów certyfikatów z28 tabel zachowało dosłowne bajty; pełnego katalogu
po nieudanym QA nie porównano. [Oryginalny receipt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory11-prepared-1792280965628/run/receipt.private.json)
(`3c2513bd…`) i [niezależny audyt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory11-prepared-1792280965628/run/independent-certificates-terminal-review.private.json)
(`872b57e5…`) zachowują te granice. Main i podgląd pozostają bez209.
Następny krok to ograniczenie powtarzanych zapytań pełnej walidacji bieżących
powiązań, przy zachowaniu wszystkich porównań i niezmienionych limitów.
Poniższe wpisy są historią.

**Aktualizacja 18.10.2026 — memory10: pełne30 testów, odbiór nadal otwarty.**
Źródło `8b31ca6d…` przeszło COMMIT oraz dokładną deltę208 dodatków /14 zmian
/0 usunięć. Wszystkie56 archiwów starych certyfikatów zachowało bajty przed
i po zastosowaniu209. Pojedyncze kontrole:209149,37ms, buyer5001,04ms,
consumer3871,91ms i literal18815,30ms. To pojedyncze pomiary lokalne, nie p95.

Pełny TAP ma **2PASS /28FAIL /0SKIP /0CANCEL**. PASS dotyczy jednego przypadku
bazy `extra-own-function` i walidatora locatora. Wszystkie28 błędów to57014;
nie wszystkie wystąpiły przed mutacją. W21 przypadkach ukończono stan początkowy,
w18 zapisano odmowy209 i buyer, w2 odmowę prawdziwego immutable triggera.
Tylko1 przypadek ukończył pełny odczyt po rollbacku. Odmowa mutacji nie zastępuje
tego końcowego odczytu; nadal brak pełnego odbioru Native i biznesowego.

Oryginalny controller potwierdził child EXIT1 bez sygnału, zamknięcie klientów,
zero połączeń i normalny DROP własnej bazy. Nie przerywano testów. Pełnego
katalogu po QA nie porównano, ponieważ child zwrócił1. [Receipt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory10-prepared-1792280468870/run/receipt.private.json)
(`38318dd9…`) i [niezależny przegląd](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory10-prepared-1792280468870/run/independent-certificates-terminal-review.private.json)
(`242342bf…`) zachowują te granice.

`8ad5d3b` usuwa wyłącznie powtórne wywołanie tej samej kontroli209 wewnątrz
trzech już sprawdzonych funkcji. Każda nadal czyta pełne bieżące metadane,
rzeczywiste pochodne danych i wszystkie10 powiązań; bezpośredni czytnik mapy
pozostaje osobno zabezpieczony. Root27 testów źródłowych PASS. Następny caller
dodaje tę samą wspólną kontrolę Native8s przed COMMIT, żeby nie uruchamiać30
przypadków przy niespełnionym baseline. Nie usuwa ani nie rozluźnia żadnego
testu. Main205 i podgląd208 nadal nie otrzymały209.

**Aktualizacja 18.10.2026 — pomiar wskazał koszt skrótu payloadu.**
Osobna kompilacja dokładnego źródła `22189011…` zakończyła się COMMIT,
zachowaniem 56 archiwów starych certyfikatów i normalnym DROP przy zerze
połączeń. To diagnostyka, bez QA Native i odbioru biznesowego.
Dokładne zapytanie fingerprintu miało Planning 4,485 ms / Execution 350,981 ms;
odczyt i wyliczenie SHA payloadu zajęły 219,526 ms, a deskryptory poprzedników
111,358 ms. Brak bloków tymczasowych. Sam SELECT mapy trwał 0,021 ms,
ale nie mierzy kosztu pełnego czytnika mapy. Pomiar nie potwierdza dominacji
planowania ani przelewania WindowAgg na dysk.

Próba na tabeli TEMP w bazie administracyjnej potwierdziła legalną generację
STORED liczby bajtów, SHA i JSONB: pięć próbek JSON z Unicode i backslashami
oraz UPDATE zachowały zgodność z bezpośrednim `convert_to(...,'UTF8')`.
Bezpośredni zapis generowanego SHA odrzucono kodem428C9; ROLLBACK usunął
tabelę, klient został zamknięty. Nie jest to jeszcze odbiór implementacji209.
Kandydat ma zachować świeże sprawdzenie pełnych metadanych kolumn i wszystkie
dotychczasowe limity. Dalszy pełny test Native pozostaje wymagany.

Dowody: [diagnostyka i niezależny przegląd](../../../../local-builds/full-base-preview-20261017/source209-query-plan-diagnostic-prepared-1792279964882/run/independent-query-plan-terminal-review.private.json)
(`6aed413c…`) oraz [próba pochodnych PostgreSQL](../../../../local-builds/full-base-preview-20261017/source209-generated-derivatives-probe-1792280355935/result.private.json)
(`28b447f0…`). Main205 i podgląd208 pozostają bez aktywacji209.

**Aktualizacja 18.10.2026 — memory09 nadal bez odbioru, dalszy pomiar zapytania.**
Kandydat `22189011…` przeszedł kompilację źródłową (12,91s), dokładną deltę
204 dodatków /14 zmian /0 usunięć oraz literalność starych certyfikatów.
Cztery pojedyncze kontrole zwróciły true, lecz wspólna brama8s ponownie nie
przeszła. Zarejestrowano14 błędów57014 przed mutacjami; próbę przerwano przy15.
**Nie ukończono25 przypadków, a nowy negatyw kolumny generowanej nie ma odbioru.**

Root wysłał sygnał wyłącznie potwierdzonemu dziecku QA. Po SIGTERM proces
pozostał żywy, więc po przekroczeniu terminu i ponownym sprawdzeniu PID/PPID
zakończono to samo dziecko SIGKILL. Utrzymane przez Root połączenie diagnostyczne
spowodowało uczciwy `CLEANUP_UNCONFIRMED` w oryginalnym receipt; nie przepisano go.
Osobna diagnostyka02 na tej samej bazie zwróciła buyer=true w6703,49ms,
potwierdziła zamknięcie backendu, niezmienione role, zero połączeń i normalny
DROP oraz nieobecność własnej bazy. Diagnostyka01 wcześniej zakończyła się
przed pomiarem, czekając na terminal dziecka; jej błąd również zachowano.

Zmiany `5194e09` nie dały wystarczającej poprawy:12 wywołań fingerprintu
nadal zajęło3706,97ms, a7 odczytów mapy1363,95ms. Następny pomiar ma oddzielić
przygotowanie planu SQL od wykonania i zbadać koszt WindowAgg; nie podnosimy
limitów ani nie aktywujemy209.
[Oryginalny wynik09](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory09-prepared-1792279385985/run/receipt.private.json),
[oddzielny pomiar i cleanup Root02](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory09-prepared-1792279385985/run/Root-existing-scratch-profile02.private.json)
i [niezależny przegląd](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory09-prepared-1792279385985/run/independent-certificates-terminal-review.private.json).
Poniższe wpisy są historią.

**Aktualizacja 18.10.2026 — memory08 zakończona, bez odbioru Native.**
Źródło SQL209 `bdf9769b…` zastosowano w 12,29 s. Dokładna delta
202 dodatków / 14 zmian / 0 usunięć, cztery pojedyncze kontrole i COMMIT
przeszły. Wszystkie 56 archiwów starych certyfikatów zachowało dosłowne
bajty. Pełne QA zakończyło jednak 24 przypadki wynikiem **1 PASS / 23 FAIL**:
jedyny PASS dotyczy walidatora locatora, a pozostałe przypadki przekroczyły
limit 8 s (`57014`) we wspólnej kontroli `healthy()`, przed właściwymi
mutacjami. To nie są zaliczone testy negatywne ani odbiór biznesowy MERGE.

Oryginalny receipt potwierdza zamknięcie obu klientów, zero połączeń i normalne
usunięcie własnej bazy testowej. Nie użyto sygnału zatrzymania ani replay.
Main i podgląd nie otrzymały209. Następny krok to pomiar czasu rzeczywistych
funkcji w osobnej bazie źródłowej; nie zwiększamy limitów i nie uznajemy
czterech pojedynczych kontroli za zastępstwo pełnej bramy.

Dowody: [oryginalny receipt](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory08-prepared-1792278268025/run/receipt.private.json)
(`375b4d08…`) i [niezależny przegląd plikowy](../../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory08-prepared-1792278268025/run/independent-certificates-terminal-review.private.json)
(`f8494630…`). Starsze wpisy poniżej pozostają historią.

**Aktualizacja 18.10.2026 — rzeczywisty limit kontroli, bez aktywacji209.**
Próba memory04 zastosowała SQL `362f89b3…` w pustej własnej bazie źródłowej
(ACK72,11s). Potwierdzono197 dodatków,14 zmian i brak usunięć;56 archiwów
z28 tabel zachowało literalne dane. Kontrola209 zwróciła true w346,5ms,
lecz `buyer_address_guards()` przekroczyła niezmieniony limit8s (`57014`).
Nie wykonano COMMIT ani23 kontroli Native. Rollback, zamknięcie klientów
i zwykły DROP przy zerowej liczbie połączeń potwierdza
[niezależny raport memory04](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory04-prepared-1792276327474/run/independent-certificates-terminal-review.private.json).

Poprawka `ab440af` wiąże również skrócone przez PostgreSQL nazwy kluczy
z dokładnym źródłowym FK, tabelą i parą akcji RI.12 testów PASS;
[niezależny pełny inverse historycznego memory03](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory03-prepared-1792275908403/run/independent-catalogue-review04-ri-fix.private.json)
odtworzył cały dokładny katalog208 (40243 rekordy) z40440 rekordów209.
To odbiór reprezentacji metadanych, bez Native lub działania produktu.

Commity `c605e37` i `0684f5a` zastępują powtarzaną walidację mapy świeżym,
lokalnym stanem pojedynczego wywołania sześciu zapieczętowanych funkcji.
Wszystkie190 odczytów używa tej mapy; każdy wybrany descriptor nadal musi
odpowiadać pełnemu bieżącemu AFTER. Ścieżka niezmienionej funkcji pozostaje
bez transformacji. Brak GUC, cache sesji lub podwyższania limitów.
18 testów plikowych PASS oraz niezależny przegląd nie zastępują pomiaru SQL.
Kandydat `a7d4d66d…` i24 kontrole Native są przedmiotem osobnej próby memory05;
nie nadano im jeszcze odbioru.

Istniejące dwie nowe próbki zamówień na podglądzie11/208 mają rzeczywistą
klasyfikację adresu; główna ma zmianę kupującego wykonaną przez publiczny
portal. Chrome potwierdził stan i historię. Nie wykonano na nich MERGE.
Przygotowany sterownik209 ma wykorzystać te same zamówienia po pozytywnych
bramach źródłowych i uruchomieniu wspólnego wydania, bez tworzenia ich ponownie.

Poniższe wpisy zachowują historię wcześniejszych prób.

Stan: **2026-10-17, INACTIVE_IMPLEMENTATION_IN_PROGRESS**. Koordynator przydzielił następcy numer209. Zapisano kandydat SQL, helper kryptograficzny, integrację serwisu i testy kontrolowane; kompletna projekcja poprzedników, compiler proof, rejestracja migracji i odbiór na nowym wydaniu nadal pozostają otwarte. SQL209 nie został zainstalowany w Main ani podglądzie11. Historyczne SQL166/103 i certy pozostają literalne. Poniższy opis oddziela wymagany wynik od faktycznego odbioru.

**Nowsza próba źródłowa i poprawka18.10.2026.** Drugi program odtworzył dokładny
baseline208 i zarchiwizował28 tabel certyfikatów, lecz SQL209 zakończył się
`57014` po121,9s w ścieżce `predecessor_descriptor → fa3_draft_fingerprint →
buyer_address_guards`. [Niezależny zapis końcowy](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory02-prepared-1792275043162/run/independent-certificates-terminal-review.private.json)
potwierdza brak ACK209/COMMIT/QA oraz rollback, zamknięcie klientów i normalny
DROP własnej bazy przy zerowej liczbie połączeń.

Kandydat SQL `2cfde1ed…` zwraca pełne aktualne metadane funkcji spoza dokładnie
10 nazw bez zbędnej transformacji. Każda nazwa objęta projekcją, w tym overload,
nadal wymaga świeżego pełnego sprawdzenia209, mapy i wszystkich10 deskryptorów
AFTER. Nie zmieniono historycznych bajtów, nagłówków, mapy danych ani limitów;
17 testów źródłowych i niezależny assembly PASS nie dowodzą poprawy czasu.
Trzecia próba jest osobnym, jednorazowym przebiegiem; do jej końcowego odbioru
nie przyznajemy zgodności Native209.

Naprawiono również potwierdzoną lukę powtórnego POST: dokładny replay preview
lub execute rejestruje aktualną request-owned tożsamość i końcową duty przed
zwróceniem DTO. Duty przechwytuje bieżący stan historycznego zamówienia, bez
żądania dawnej kwalifikowalności edycji adresu.12 testów rzeczywistych funkcji
z kontrolowaną transakcją PASS obejmuje także unieważnienie sesji podczas
oczekiwania i brak COMMIT po późnej zmianie tożsamości.

**Aktualizacja18.10.2026 — przerwana kompilacja testowa.** Proces zakończył się
kodem137, bez ustalonej przyczyny. Przeszło199 etapów poprzednika i814 zdarzeń
intent/ACK; zapisany katalog przed209 jest identyczny bajtowo z niezależnie
odebranym208 (SHA256 `320ba526496c79605630b7b1c98128bd3039251d72365ceedc75798e2650987d`).
Nie ma intentu SQL209, COMMIT ani kontroli Native209. Oryginalnego receipt nie
zmieniono; [niezależny przegląd przerwania](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-prepared-1792274132752/run/independent-interrupted-run-review.private.json)
nie nadaje odbioru następcy. Koordynator potwierdził nieobecny proces, dokładny
marker i właściciela jego bazy, zero połączeń oraz pusty schemat po rollback.
Następnie wykonał zwykły DROP wyłącznie tej bazy i potwierdził jej nieobecność;
[osobny zapis cleanup](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-prepared-1792274132752/run/Root-terminal-cleanup.private.json).
Main205 i podgląd11/208 odpowiadają health200 na niezmienionych rewizjach.

Sterownik zwykłego odbioru MERGE obsługuje teraz jawny profil
`expectedSchema=209_order_merge_delivery_inheritance`, nadal z osobnym
przypięciem rewizji i wyłącznie lokalnym4103. Stary profil pozostaje208;
obserwowany health nie staje się oczekiwaniem.13 testów kontrolowanego
transportu PASS nie oznacza uruchomienia209 ani nowego odbioru biznesowego.

Jawny profil209 wywołuje teraz dodatkowy odbiór wyłącznie GET: publiczny stan
edycji adresu i pełną, ograniczoną historię celu. Dla technicznego celu sprawdza
świeży token portalu, zachowaną ogólną politykę portalu, wyłączony opt-in i jeden
własny wpis `merge_inherit`. Dla `into_main_order` wymaga zachowania istniejących
wersji sidecaru i tokenu. Dane adresu/tokenów pozostają wyłącznie w pamięci;
wynik zawiera bezpieczne identyfikatory, liczniki i jawne granice dowodu.
Publiczna historia nie udostępnia powiązania z execution/preview/scope ani
wykonawcą, więc helper pozostawia te dowody niepotwierdzone. Koordynator
wykonał24/24 testy kontrolowane sterownika i helpera, bez prawdziwego HTTP/PG.

Dodano czystą projekcję katalogu209→208 z jawnym oczekiwaniem źródłowym:
`order-merge-delivery209-source-compatibility.mjs`. Wymaga dokładnie10 zmian
funkcji,4 zmian CHECK oraz pełnych deskryptorów nowych obiektów, także dwóch
triggerów i odroczonego constraint na historycznych tabelach. Koordynator
wykonał10/10 testów na syntetycznych deskryptorach i rzeczywistym walidatorze
katalogu. Moduł nie ma domyślnego kontraktu i nie jest podłączony do startu;
źródłowy kontrakt wymaga zakończonej kompilacji i niezależnego przeglądu.

UI commit `7e00288` pokazuje operacyjną dostawę obok danych pierwotnych, rozróżnia historię dziedziczenia i umożliwia otwarcie źródła z dowodu. Zwykła nawigacja historia→archiwumA→właścicielB została rzeczywiście sprawdzona w Chrome na tymczasowym frontendzie4104 z proxy wyłącznie do backendu11/4103. [Zapis i ograniczenia](../../../local-builds/full-base-preview-20261017/merge11-dev-ui-archive-1792273753912/Root-scoped-review.private.json). To nie jest wspólny niezmienny pakiet ani odbiór nowego writera Native209. Serwer developerskiego UI został poprawnie zamknięty; Main i podgląd11 pozostają bez tej aktywacji.

## Konkretny obecny błąd

`server/order-merges.ts:813` ponownie przechwytuje źródła i sprawdza scope. Przy `technical_merge`, `:834–865` kopiuje surowy nagłówek wybranego `main`, po czym nadaje nową tożsamość, token portalu i wyliczone kwoty. Nie tworzy odpowiadającego mu `buyer_address_state`. `into_main_order` zachowuje dotychczasowe ID i istniejący sidecar.

`server/domain.ts:189–194` i `server/buyer-address.ts:506–535` obliczają `effective_delivery` z sidecaru **konkretnego ID zamówienia**. Brak stanu oznacza `unknown`, nie klasyfikację adresu wywnioskowaną z ulicy. Dlatego techniczny cel traci zarówno klasyfikację `address`/`pickup_point`, jak i rzeczywisty override. Zachowanie `orders.address` nie naprawia tej utraty. Istniejący zwykły runner MERGE porównuje wybrany main z wynikiem także po operacyjnych `kind/delivery` i powinien ten przypadek odrzucić; dotychczasowe przygotowanie par z `unknown` nie jest odbiorem dziedziczenia adresu.

Drugi brak jest w podglądzie: `capture` (`order-merges.ts:156–233`) nie obejmuje sidecarów; `receiverConflict` (`:597–606`) porównuje tylko surowe name/email/address/B2B. Zmiana klasyfikacji lub polityki przez `adminAccess` zwiększa `state.version`, ale **nie zwiększa `orders.version`** (`buyer-address.ts:1074–1097`; SQL166 `:457–466`). Sam obecny CAS nagłówka nie wykryje takiej zmiany. Dwa identyczne surowe adresy mogą też mieć różne operacyjne override.

## Dlaczego obecnego writera nie można wywołać jako kopiowania

Źródło: `server/166_buyer_address_sidecar.sql`:

- `buyer_address_current_state`, `:201–206`: brak wiersza daje zerowy, wyłączony stan `unknown`.
- Tabele previews/receipts, `:130–165`: wyłącznie `access|delivery`; administrator z actor ID jest dopuszczony dla `access`, a `delivery` wymaga tokenu i braku aktora/API key. FK `last_receipt_id` jest związany z **tenantem i docelowym order ID**. Nie można skopiować cudzego wskaźnika/historycznego receipt.
- `buyer_address_preview_guard`, `:215–255`: `access` może zmienić klasyfikację/politykę, ale nie zaszyfrowane bajty dostawy. `delivery` wymaga bieżącego portalu, włączonej polityki, `new|paid`, właściwego tokenu i zgodności klasyfikacji.
- `buyer_address_state_guard`, `:277–296`: własny, zmieniony receipt z tej samej root TX; dokładne before/after, CAS wersji i kontrola rodzaju zmiany. Bezpośredni INSERT/UPDATE stanu nie jest dostępny dla `dyna_app` (`:179–185`, `:312–313`).
- `buyer_address_block_reason`, `:359–402`: realizacja, skany, przyjęte plany oraz source **lub target** obecnego MERGE blokują nową zmianę kupującego.
- `buyer_address_prepare`, `:403–431`, i `buyer_address_apply`, `:432–470`: oba ponownie sprawdzają właściwą tożsamość; istniejący `delivery` nie jest uprawnieniem administratora do odtworzenia cudzego adresu.
- `buyer_address_complete`, `:298–310`, i `buyer_address_terminal`, `:474–499`: końcowa zgodność stanu/wersji/buyer basis, bieżące IAM i zegar po oczekiwaniach.

`createBuyerAddressService().adminAccess` (`buyer-address.ts:1045–1110`) uruchamia `transact` (`:563–634`) z własnym pool connection, BEGIN i COMMIT. Wywołanie go po MERGE tworzyłoby drugą transakcję. Nie kopiuje override i nie zapewnia atomowego rollbacku MERGE. Publiczny writer kupującego nie może być użyty przez serwer do podszycia się pod kupującego. Eksportowane `prepareCreatedOrderBuyerInstallationInTx` (`:181–204`) jest wyłącznie jednorazowym faktem instalacji dla hydratora `createOrder`, **nie admission do zapisania sidecaru**.

## Szyfrowanie i związanie source → target

Obecne `seal/unseal` (`buyer-address.ts:278–311`) używa AES-256-GCM `IV12 || tag16 || ciphertext`, sprawdza długość, SHA, AEAD, UTF-8 i kanoniczny JSON. **Nie wywołuje `setAAD`**. Nie należy więc twierdzić, że obecny szyfrogram jest kryptograficznie związany AAD z ID źródła. Związanie z zamówieniem zapewniają buyer basis, scope, receipt i FK Native166. Sam udany decrypt po skopiowaniu bajtów nie uprawnia do przeniesienia kontekstu.

Nowy producent musi utworzyć własny target receipt/CAS oraz świeży, zaszyfrowany dowód dziedziczenia wiążący tenant, wybrany source/main, source state/receipt/basis, target, preview, execution i scope. Przy obecnym formacie może zachować **dokładny** source override ciphertext/bytes/hash wyłącznie jako udowodnione dziedziczenie tych samych bajtów, z niezależnym docelowym wskaźnikiem i historią; nie wykonuje ponownego szyfrowania z tym samym IV. Serwis musi najpierw uwierzytelnić i semantycznie sprawdzić rzeczywisty source plaintext oraz docelową zgodność kraju/rodzaju. SQL sprawdza rzeczywiste source ciphertext/basis i kompletne powiązanie, nie caller-asserted JSON.

Jeżeli przyszły format wprowadzi AAD obejmujące source ID, kopiowanie szyfrogramu przestanie być poprawne: potrzebny będzie jawnie wersjonowany decrypt źródła i nowe szyfrowanie z docelowym AAD. Nie wolno dopisać takiej zmiany do starego formatu bez zgodności readera i recovery.

## Minimalna rzeczywista naprawa

Potrzebny jest **wąski następca Native**, a nie sam JS helper. Zalecana ścieżka zachowuje jedną istniejącą rodzinę sidecaru i obecny reader dostawy; nie wprowadza konkurencyjnego fallback-store adresów.

1. Pod istniejącymi order locks przechwycić w preview rzeczywisty stan/buyer basis i uwierzytelniony operacyjny adres wszystkich wybranych źródeł, z limitem liczby/bajtów. Wiązać je ze scope i pokazać konflikt rzeczywistych odbiorców. W trwałym snapshotcie zapisać zaszyfrowany stan, rodzaj, hash adresu i buyer basis; odszyfrowany override pozostaje wyłącznie w ograniczonej pamięci serwisu do walidacji/porównania, nie w nowym plaintext logu lub snapshotcie MERGE. Execute odczytuje to ponownie po oczekiwaniach. Zmiana source policy/state bez zmiany nagłówka musi odmówić staremu preview.
2. Dodać odrębny typ dziedziczenia z MERGE do nowych, audytowanych reguł/proof rodziny166. Native admission musi należeć do tej samej prawdziwej root TX/generation, tenant/actor/key, `technical_merge`, oryginalnego preview/execution/request/scope, wybranego main i ustalonego świeżego target ID. Cel musi mieć zerowy, nieużyty sidecar; source musi nadal odpowiadać zamrożonemu frame. Nie przyjmować samego GUC, `trusted:true`, caller body ani historycznego execution z innej TX jako authority.
3. Przydzielić nowe lokalne target state/receipt versions i własny receipt ID. Dziedziczyć klasyfikację i faktyczny adres; **nie kopiować źródłowego portal tokenu, zgody na edycję, wygaśnięcia, actor receipt ani liczników wersji**. Nowy portal nie otrzymuje automatycznego opt-in do zmiany adresu. Pochodzenie klasyfikacji musi jawnie wskazywać dziedziczenie dowodu, bez fikcyjnego kliknięcia kupującego. Exact before/after obejmuje także adres; replay nie tworzy drugiego receipt ani nie kopiuje ponownie.
4. Wpiąć producenta w istniejącą TX wykonania. `order_merge_scope` (`103_order_merges.sql:84–87`) wiąże execution z preview snapshotem; nowy deferred completeness musi ponadto wymagać jedynego, poprawnego proof dziedziczenia dla technicznego celu z klasyfikowanym main. Snapshot celu/wersje muszą odpowiadać końcowemu stanowi po dziedziczeniu. Utrzymać transfer custody, salda, finalne IAM, `SET CONSTRAINTS ALL IMMEDIATE` (`order-merges.ts:978`) i COMMIT. `into_main_order` nie dostaje zbędnego nowego sidecaru.

Nie ustalać wyjątku dla `new|paid` w całym buyer writerze. MERGE obsługuje również `picking|packed`; w tych stanach można rozważyć wyłącznie udowodnione przeniesienie **niezmienionego** odbiorcy wraz z custody, bez nowej zgody na edycję czy obchodzenia blokad realizacji. Każdy taki stan wymaga osobnego dowodu. Do tego czasu jawna odmowa jest bezpieczniejsza od utraty adresu i pozostawia wymaganie otwarte.

### Konkretne pliki pierwszego patcha

Pięć plików rdzenia: nowy `server/209_order_merge_delivery_inheritance.sql`, nowy `server/order-merge-delivery-inheritance.ts`, istniejący `server/order-merges.ts`, istniejący `server/buyer-address.ts` oraz nowy `tests/order-merge-delivery-inheritance.test.ts`.

To **nie jest pełna lista integracji wydania**: wymagane będą źródłowy generator/kontrakt/inverse/pełny compiler proof, rejestracja db/resources/cold/normalizer, dostosowanie walidacji odtworzonej historii w `validateRecoveredBuyerAddresses` (`buyer-address.ts:1196`), odpowiednie recovery testy i ordinary API/browser na wspólnym wydaniu. Stare SQL166 i stare certy pozostają literalne; każda dozwolona zmiana deskryptora/constraint/ACL/parent-trigger musi być dokładną deltą następcy, bez observed-as-expected i bez wyłączenia guarda. Nowy helper nie jest dodawany do whitelisty przez poluzowanie Source. Obecny `catalog-stock-writer-coverage.ts` nie zawiera buyer-address/order-merges w 42 source entries; nie zmieniać pozostałych pinów przy okazji. Cały rzeczywisty pakiet/manifest i nowy writer nadal wymagają własnego przeglądu integracji.

## Odbiór i negatywy przed uznaniem naprawy

- Osobno `unknown`, oryginalny `address`, autentyczny buyer override, `pickup_point`; różne raw receivers oraz identyczne raw header z różnymi override. Wybrany main wygrywa, pozostałe źródła pozostają historyczne i niezmienne. WMS OFF/ON oraz oba tryby MERGE. Sprawdzić wszystkie obecnie dopuszczane statusy, nie tylko `new`.
- Po MERGE zwykłe GET target `effective_delivery.kind/delivery` równe wybranemu main; surowe buyer/billing dane pozostają zachowane. Nowy token/wyłączony opt-in, własne receipt/version i pełne lineage. Shipping/parcel/invoice konsumenci muszą odczytać ten sam adres, a historyczny provider payload pozostaje niezmienny.
- Zmiana source klasyfikacji/polityki/override po preview, również bez zmiany order version; równoległy adminAccess, buyer edit, MERGE, dispatch. Current IAM revoke/expiry/MFA/restore podczas oczekiwań odmawia całej operacji.
- Obcy tenant/main/target/actor/API key, fałszywy lub historyczny execution, drugi target, zajęty sidecar, brak/extra proof, zmieniony scope, ciphertext/bytes/hash/tag/country/locker contradiction, rozjechany before/after i końcowa wersja — odmowa bez częściowego COMMIT. Błąd każdego etapu header/items/custody/inheritance/audit/final constraint ma wycofać całość.
- Utrata ACK: oryginalne command lookup i jeden wynik; bez ponownego dziedziczenia i bez generowania nowych kluczy. Restart/backup/restore zachowuje autentyczny adres, jego AEAD i kontekst obu stron, oryginalną komendę i receipt. Symulowany test helpera ani sam status HTTP200 nie są odbiorem biznesowym tej naprawy.
