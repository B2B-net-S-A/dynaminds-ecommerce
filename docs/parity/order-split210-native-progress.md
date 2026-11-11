# Native210: nieaktywny kandydat atomowego podziału

**C33: pełna próba Source31 zakończona odmową runtime.**
Root7096/child19103 EXIT1/108,935s:199+27 etapów, pełne493/22 zgodne z V31,
inverse40502 i dokładna serializacja64011475 B odtworzone. Cztery kontrole
210/209/buyer/return-credit TRUE; następny ordinary187:57014/8006,974292ms przy8s.
ROLLBACK/DROP0/oba zamknięcia/18 ról zgodne. COMMIT i Native nieosiągnięte;
poprawka nie usuwa jeszcze blokady biznesowego podziału. Osobny source-preview
EXIT0/5,592s bez PG nie zastępuje tego wyniku.
[Dowody i decyzja po C33](SPLIT210-C33-LOCAL-20261018.md).

**Source31: V31 i pakiet H/seal zsynchronizowane; pełna próba runtime otwarta.**
V31 `358022 B / 58d86a31…`, canonical `2d13ca57…`: 493 dodatki i 22 zmiany;
488 dodatków oraz wszystkie BEFORE są identyczne z V30, zmieniono pięć dodatków
oraz source/definition jednego AFTER. H przechowuje pełne raw deskryptory24 pól.
Pakiet H/resource/installer:60/60 PASS bez pominięć; seal/oracle:36/36 PASS;
Native ma1 test kontrolowany PASS i25 testów bazy pominiętych, bez odbioru Native.
Root niezależnie porównał pełne H493/22 z V31 i odtworzył źródłową podstawę sealu515;
zachowano pełny historyczny Source30, obie kopie resource są identyczne.
To odbiór źródeł i pakietu. Pełna kompilacja C33, rzeczywisty Native,
aktywacja aplikacji i biznesowy podział przez UI/API pozostają otwarte.
[Pełne dowody i granice](SPLIT210-COMPOSITE-CODEC-CANDIDATE-20261018.md).

Wcześniejsze etapy i ich ówczesne granice:

**Source31 w generatorze; nowy P23 rzeczywiście odebrany.**
Program4524547/3e99139d… zachowuje27 etapów i pełne22 raw deskryptory;
physicalDATA3590688/db01… ma603616B zapasu. Root104/104 testy źródeł PASS
bez SKIP; pełny reverse odtwarza Source30,24/27 etapów literalnie bez zmian.
Root14593 P23 EXIT0 odczytał44CHECK+3generated:45 wartości zgodnych z P22
oraz dwa nowe CHECK-i; ROLLBACK/schemat nieobecny/role/memberships/close zgodne.
Wszystkie98 sourcepins potwierdzone. To odbiór generatora i niezależnych wyrażeń;
V31/H/seal, pełna kompilacja, Native i biznesowy split nadal otwarte.
[Dowody i granice](SPLIT210-COMPOSITE-CODEC-CANDIDATE-20261018.md).

**Source31: rzeczywiste złożenie źródeł i skończony wrapper guarda.**
Root10719 EXIT0 przechwycił dokładny rawguard52253/4f0ed506… z nowych
źródeł; cały tekst jest bajtowo równy niezależnej pięciozmianowej rekonstrukcji.
Root sprawdził22 pełne BEFORE,21 niezmienionych AFTER i jedyną zmianę
source/definition metadata2, pełne24 pola/checks oraz DATAinverse.
Nowy skończony wrapper daje53140/2b802356…; historyczny pipeline i całe
zapytanie capture pozostają literalne. Root53/53 testy źródeł PASS bez SKIP.
To source-only bez PG: publiczny generator/pakiet, nowy47-leaf probeP23,
pełny V31, kompilator, Native i biznesowy split nadal otwarte.
[Dowody i granice](SPLIT210-COMPOSITE-CODEC-CANDIDATE-20261018.md).

**Split210: kandydat composite mieści się w DATA; osobny codec SQL PASS.**
Root29/29 testów źródeł PASS. Finite helper pokrywa sześć miejsc odczytu,
bez podłączenia do generatora. Osobna próba6887 EXIT0 na PostgreSQL18.4
odtworzyła wszystkie22 pełne24-polowe deskryptory oraz całe logiczne DATA;
36 błędnych wariantów odmówiono z55000. ROLLBACK, usunięcie obu funkcjiTEMP,
niezmienione role/publiczna topologia i zamknięcie klienta potwierdzone.
Fizyczny kandydat z composite ma3590688B i603616B zapasu przy4MiB.
To helpery poza generatorem, bez wykonania composite snapshotu, Native,
MVCC, dowodu8s lub biznesowego splitu. Następny etap: sześć punktów dekodowania,
pełna autoryzacja Source31 i świeży pełny przebieg przy dotychczasowych limitach.
[Dowody i granice](SPLIT210-COMPOSITE-CODEC-CANDIDATE-20261018.md).

**C32: Source30 wykonany;187 ponownie przekroczył8s, bez Native.**
Oryginalny Root57874/child1203 zakończył się TERMINAL EXIT1/109,406s
(15:40:27,595Z–15:42:17,001Z), status `SOURCE_COMPILATION_FAILED_NO_REPLAY`.
Wykonano199 etapów rodzica i27 etapów210. Pełny inverse493 dodatków/22 podmian
odtworzył40502 rekordy rodzica209 i jego pełną serializację64011475B/b3300ea8….
Instalacja stałego seal zakończyła się; cztery kontrole210/209/buyer/return-credit
zwróciły TRUE. Wcześniejsze cztery niezależne cold capabilities również TRUE.

Następny `ordinary187_valid` zakończył się57014 po8006,45625ms przy8s.
Zapisany stos przerwania zaczyna się od `order_split210_valid` linia10,
`order_split210_require` linia1 i `order_split210_is_added_trigger` linia6,
potem prowadzi przez finanse181. To miejsce przerwania, bez przypisania mu
całego kosztu lub dowodu izolowanego hotspotu. Wynik logiczny187 nieznany.
Kolejna kontrola173, COMMIT, rzeczywisty Native i kontrole po QA nie zostały
osiągnięte. Pełny ROLLBACK, DROP własnej bazy przy0 klientach, oba zamknięcia
i identyczne18 ról potwierdza receipt; brak aktywacji i biznesowego splitu.
[Receipt112607B](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler32-source30-prepared-20261018-01/run/receipt.private.json)
ma SHA `c89c514b3924c9dfbda5c9e71da54f130a2a2ab4a335a5f0e721c7e1bff75818`.
[Końcowy przegląd Root2863B](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler32-source30-prepared-20261018-01/root-terminal-review.private.json)
ma SHA `9caf2fe65dc49bdcc1fea21dce7495295bc51f6f6e0cfc3dbd43bf05cd4abf28`.
Root niezależnie potwierdził wszystkie493 pełne dodatki i22 kompletne BEFORE/AFTER
zgodne z V30,84 pełne artefakty28 certyfikatów w trzech grupach,200 aktualnych
pinów/135 plików,18 ról i cleanup.
[Pełny inverse: osobny przegląd1661B](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler32-source30-prepared-20261018-01/root-full-inverse-review.private.json)
ma SHA `0363ad434561a6f07286392c5660a4915fd70c51e66d9a2f7029d36fa73b7433`.
Odtworzył wszystkie40502 kompletne rekordy i dokładną serializację64011475B
SHA `b3300ea8ae4933715ef1bdd7d36318b7908a56db321cbef01d2845ecfa10fcf3`.
Przywrócone wartości BEFORE są źródłowo równe, z zachowaną kolejnością pól
obiektu potrzebną do identycznej serializacji. Peer niezależnie potwierdził
pełne40502 rekordy/canonical oraz56 artefaktów certyfikatów. Wynik kompilatora
pozostaje FAILED; brak COMMIT, Native i post-QA. Nie powtórzono operatora.
Następny krok to [przegląd architektury kosztu walidacji](SPLIT210-VALIDATION-COST-REVIEW-20261018.md).
Nie jest to pomiar samodzielnego valid, P95 lub zakończenie całego Goala.

Przed pełnym C32 osobny preview, oryginalny Root94151 TERMINAL EXIT0/4,125s,
potwierdził pełne złożenie Source30 oraz rodziców209/208. Zachowano cały
leksykalny try i jego ogon, a bezwarunkowa bariera zatrzymała wykonanie
przed runtime/locator/PG:0 połączeń i0 SQL.
[Przegląd Root preview1777B](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler32-source30-prepared-20261018-01/source-assembly-preview/root-terminal-review.private.json)
ma SHA `37197884238856ad29a6a13acc43051cabc1f13b4154e8eae270bfa9a28b0784`.

**Source30: zapytanie D34 w generatorze, spójne oczekiwania i pakiet; runtime otwarty.**
Helper zastosowano wyłącznie do dokładnie przypiętego surowego Source29.
Historyczny Source27 pozostaje literalnie niezmieniony. Pełne inverse
odtwarzają poprzedni guard Source29 i jego surowe źródło; osobny inverse
całego programu odtwarza5094543B/bd61089c… z nowego5094845B/f2f3d9cf….
DATA4192445B SHA `fedf779b7544a8e16ba1d711067762c4593d0fa0b21ea1e24cff9a90b7cebb45`
pozostaje identyczne. Brak cache między wywołaniami, nowych funkcji runtime
lub zmiany samodzielnego fingerprint. Zachowano pełny selektor triggerów.

Root20072 TERMINAL EXIT0 opublikował wyłącznie źródłowy V30.
[Vector337281B](../../../../local-builds/full-base-preview-20261017/order-split210-source-expectation-trigger-map30-prepared-20261018-01/expected-vector.private.json.gz)
ma SHA `13464fcb80007fa21ab0361c5eedaabc17d64db5b7e3e8d2c4bf9f46cac77604`,
canonical SHA `ebbe874a4c9edd42f0099c75c856cdacfa637c8a261a220619a736603bf1f136`.
[Wynik źródłowy1147B](../../../../local-builds/full-base-preview-20261017/order-split210-source-expectation-trigger-map30-prepared-20261018-01/result.private.json)
ma SHA `5ca2ac87aaa3c11423e898694e322fa3f509cbea647eaf508e6f15e97a61e564`.
Root niezależnie potwierdził492 identyczne dodatki i wszystkie22 kompletne
BEFORE/AFTER. Jedynym zmienionym rekordem jest `order_split210_valid()`:
22 pola deskryptora identyczne, źródło i definicja zmienione dokładnie
o transformację D34. Nowe ciało52957B SHA `a93aea9f2a1ee9dbf9135430f41d27267f8afe86f95e122655263108fbdc03cc`.
[Root review1610B](../../../../local-builds/full-base-preview-20261017/order-split210-source-expectation-trigger-map30-prepared-20261018-01/root-terminal-review.private.json)
ma SHA `e31ffc99edbc22231796115645fb52fd8090e28d305d55b11f417206ba346d6d`.

P22 użyto ponownie dopiero po pełnej zgodności aktualnego probe poza polem
pochodzenia candidate: identyczne SQL6207B/ef80e240…, readback a51b4d20…,
47 celów oraz wszystkie projekcje tabel. Historyczne92 piny związano
z niezmiennym V29; aktualny pełny import closure liczy94 piny. To reuse
tych samych niezależnych liści, bez nowej próby PG lub deklarowania P23.

Źródłowe helper/closure22/22 PASS. Pierwszy Root zestaw pięciu modułów miał
67 PASS/1 stary assert długości FAIL; poprawiono wyłącznie test rozliczania
dodatkowych302B i dodano pełny inverse do Source29. Cały poprawiony moduł
source:17/17 PASS,0 SKIP. Seal/oracle/default Native:36 PASS,25 DB SKIP,
0 FAIL; rzeczywisty Native był jawnie wyłączony. H/codec/installer:56/56 PASS,
0 SKIP. Root potwierdził pełne493/22 H zgodne z V30 i literalnie zachowane
całe H29 przed starszymi świadkami. Oba kodeki są identyczne; zmierzony
Node24 gzip9 ma592358B SHA `f2cc4610ea80906f3969d32a23e135e5756ab7835aae7862b50fefa742a0399b`.
[Root review H/codec](../../../../local-builds/full-base-preview-20261017/order-split210-h-resource30-synchronization-prepared-20261018-01/root-h-codec-review.private.json)
ma1463B SHA `9fdb2efaaed803d031f86391ad85f9f3758edea488ae1b729521d8455c6fe2a8`.
Schema v6/22, zasoby7/aliasy5/v3 i wszystkie limity bez zmian.

Powyższe nie potwierdza pełnej kompilacji Source30, czasu całego187,
rzeczywistego Native lub podziału przez UI/API. Te odbiory pozostają otwarte.
Poniższe D34 zachowuje historyczny stan helpera przed tą integracją.

**D34: błąd TDZ przed PG, potem osobny poprawiony preview źródeł.**
Oryginalny Root68965 TERMINAL EXIT1 zakończył się podczas składania źródeł.
Nowy `const baseline` w bloku porównania przesłonił istniejące wiązanie
używane wcześniej do katalogu208; wynik to ReferenceError przed odczytem
runtime/połączeniem PG. Złożono źródło210, lecz wykonano0 etapów rodzica,
0 etapów210 i0 zapytań SQL; nie utworzono połączenia ani bazy. Oryginalne
pliki, attempt i logi zachowano bez ponawiania tego operatora.
[Przegląd błędu D34](../../../../local-builds/full-base-preview-20261017/order-split210-source29-trigger-map-comparison34-prepared-20261018-01/root-source-failure-review.private.json)
ma1273B SHA `6a0f25cff71188141b4165fffe1e71cfafbeebffdc8c656c6efbb11c732e7892`.

Świeży scope-fix zmienia tylko nowe wiązanie i jego użycia na
`comparison34Baseline`, zachowując wcześniejsze odczyty baseline208.
Analiza AST obejmuje40 nowych deklaracji głównego try:0 kolizji ze starymi
wiązaniami zewnętrznymi i0 nowych bezpośrednich odczytów przed inicjalizacją.
To analiza statyczna; sam wcześniejszy node-check i189 kontroli historycznych
nie wykryły błędu wykonania źródeł. Dlatego przygotowano osobny preview
z niezmienionym całym zakresem try i późniejszymi deklaracjami, zakończony
bezwarunkową barierą przed pierwszym runtime pin/locator/PG.

Rzeczywisty preview: oryginalny Root95111 TERMINAL EXIT0/4,245s
(18.10.2026,15:20:29.031Z–15:20:33.276Z), marker `SOURCE_ASSEMBLY_READY`,
status `SOURCE_ASSEMBLY_PREVIEW_READY_NO_DATABASE`. Złożono źródła199 etapów
rodzica208 oraz manifest200 etapów po dodaniu209, nie wykonując tych etapów.
Root potwierdził złożone programy209/210 i brak odczytu runtime, połączeń,
SQL, Native oraz aktywacji.
[Receipt preview D34](../../../../local-builds/full-base-preview-20261017/order-split210-source29-trigger-map-comparison34-scope-fix-20261018-02/source-assembly-preview-20261018-01/run/receipt.private.json)
ma56075B SHA `1bdf77aef4f6a241be5be796f41dafb5365dcb8df8faafab350e221131d796ff`.
[Przegląd Root preview](../../../../local-builds/full-base-preview-20261017/order-split210-source29-trigger-map-comparison34-scope-fix-20261018-02/source-assembly-preview-20261018-01/root-terminal-review.private.json)
ma1860B SHA `f8281e7228bd3669a5cf9734ea9fc7e6a1d056e2ec0e1bdcc89fc7ab1a0e8870`.

Faktyczny poprawiony D34: oryginalny Root68517 TERMINAL EXIT0/106,467s,
child99187 (18.10.2026,15:21:37.656Z–15:23:24.123Z). Ukończono199 etapów
rodzica i27 etapów210. Zapisano14 proof observations (siedem par
oryginał/kandydat),7 kontroli `order_split210_valid()` i4 plany w kolejności
oryginał,kandydat,kandydat,oryginał. Wszystkie cztery pełne wartości tekstowe
lub SQL NULL zgadzały się w każdej parze, bez utraty kolidujących nazw kolumn.
Pełne rekordy:515 baseline i nieprefiksowane zewnętrzne obiekty;516 po rename
RI;517 po dodaniu zwykłego prefiksowanego triggera;542 w topologii granicznej;
515 po każdym rollback savepoint. Wyniki valid:TRUE,TRUE,FALSE,FALSE,TRUE,
FALSE,TRUE. Topologia potwierdziła8 RI w katalogu,6 wybranych,2 wykluczone
na zewnętrznym dziecku i jeden zwykły trigger na własnej relacji.

Receipt potwierdza cofnięcie wszystkich kontroli, pełny niezmieniony katalog,
28 certyfikatów,manifesty209/166,seal,role,piny i ustawienia. Pełny ROLLBACK,
DROP przy0 klientach i oba zamknięcia potwierdzone;18 ról przed/po/końcowo
zgodnych. Bez COMMIT, Native, aktywacji lub odbioru biznesowego.
[Receipt poprawionego D34](../../../../local-builds/full-base-preview-20261017/order-split210-source29-trigger-map-comparison34-scope-fix-20261018-02/run/receipt.private.json)
ma146554B SHA `35576fba548db7ec58c4193f2ccc8688e8f4059e301ead9e71ead309c6929008`.
Historyczny status receipt
`SOURCE29_TRIGGER_MAP_COMPARISON_ROLLED_BACK_PENDING_REVIEW` pozostaje bez
nadpisania. Końcowy Root review nadaje
`FULL_VALUES_EQUIVALENT_LOCAL_PLAN_IMPROVED_DIAGNOSTIC_ONLY`: siedem pełnych
par i wszystkie cztery pola zgodne bajtowo,112 pełnych artefaktów28
certyfikatów identycznych, katalog64591304B SHA `528955b9…` bez zmiany,
18 ról i wszystkie kontrole oraz cleanup zgodne.
[Końcowy przegląd Root D34](../../../../local-builds/full-base-preview-20261017/order-split210-source29-trigger-map-comparison34-scope-fix-20261018-02/root-terminal-review.private.json)
ma8499B SHA `babcabcd645abee855e561dc76133ead36e8d877c1f93db0e18f7d4f2091e922`.

W dwóch parach porównawczych (cztery instrumentowane plany w porządku ABBA)
średni execution zmienił się15,9645→14,786ms (−7,382%), a zmierzony wall
19,2935625→17,892563ms (−7,261%). Oba warianty zachowały wszystkie103
wybrane rekordy triggerów; szeroki join11741 constraints zastąpiły22
odczyty po OID. To ograniczony wynik tego jednego zapytania w lokalnym
profilu, z wpływem instrumentacji i wcześniejszych jawnych kontroli.
Nie jest czasem całego valid/187, P95, ogólnym odbiorem wydajności, Native
lub biznesowego splitu. Root i niezależny peer zalecają promocję tej
źródłowej zmiany jako następny krok; helper pozostaje poza generatorem
produktu, a promocji jeszcze nie wykonano.

**D33: plan pojedynczego źródłowego zapytania, odbiór wyłącznie diagnostyczny.**
Pierwotny Root019cf4 zakończył się EXIT1 przed attempt marker, katalogiem run
i połączeniem PostgreSQL. Przyczyną była błędna bramka historycznych danych:
Root review D32 zapisuje `roles_unchanged:18`, a operator wymagał `true`.
Oryginalnych plików i logów nie nadpisano ani nie ponowiono tego operatora.
[Przegląd odmowy D33](../../../../local-builds/full-base-preview-20261017/order-split210-source29-valid-query-plan33-prepared-20261018-01/root-preflight-refusal-review.private.json)
ma1095B SHA `9781a70aa5521715f09e15da5aeca4c8ef56043aef5f0d977f30110669bde700`;
potwierdza0 połączeń i0 wysłanych zapytań SQL.

Świeży poprawiony operator: oryginalny Root94449 TERMINAL EXIT0/104,403s
(18.10.2026,14:59:57.619Z–15:01:42.022Z). Z niezależnego V29 wyodrębniono
linię17938B zapytania przechwytującego katalog; usunięto wyłącznie terminalne
`INTO actual,live_external,live_fingerprint`, zachowując dokładny inverse.
Zapytanie17895B wykonano dokładnie raz przez EXPLAIN ANALYZE przy8s:
czas SQL19,618958ms. Prywatny plan85890B jest zapisany; instrumentacja sama
wpływa na czas. Nie wykonano osobnej powtórki187 ani PIM po tej diagnostyce.

Potwierdzone wszystkie postchecks diagnostyki: pełny katalog niezmieniony,
28 pełnych certyfikatów,manifesty209/166,seal,role i207 referencji źródeł oraz
provenance zgodne; ustawienia bez zmiany. Pełny ROLLBACK, DROP własnej bazy
przy0 klientach oraz oba zamknięcia potwierdzone;18 ról bez zmiany.
Bez COMMIT, Native, aktywacji lub odbioru biznesowego. To wynik jednego
zapytania z ciała walidatora, nie czas całego `order_split210_valid()` lub187,
P95, naprawa timeoutu, pełny odbiór kompilatora albo biznesowego splitu.
Końcowy Root review potwierdza493 dodatki i22 podmiany według unikalnych
kluczy,pełny katalog64591304B,112 artefaktów28 certyfikatów w czterech
etapach,manifesty/seal,18 ról,207 pinów i osiem postflags. Wynik pozostaje
`PASS_SOURCE_QUERY_PLAN_DIAGNOSTIC_ONLY`, wszystkie flagi odbioru false.
[Receipt poprawionego D33](../../../../local-builds/full-base-preview-20261017/order-split210-source29-valid-query-plan33-preflight-fix-20261018-02/run/receipt.private.json)
ma118586B SHA `440de135f999e3440243fb5609e1090a6173c061e1d3e6551e1893e12e382ecf`.
[Zapisany plan D33](../../../../local-builds/full-base-preview-20261017/order-split210-source29-valid-query-plan33-preflight-fix-20261018-02/run/query-plan33.explain.private.json)
ma85890B SHA `0cad1ffee314b42ffd6aee8d9fc1ded193368418eab3cbd7f6dda435b6d8592c`.
[Końcowy przegląd Root D33](../../../../local-builds/full-base-preview-20261017/order-split210-source29-valid-query-plan33-preflight-fix-20261018-02/root-terminal-review.private.json)
ma2552B SHA `ac3c6b4947f63aef63561a138f7c049ba1b0fc8282ae59815286b20db3dd6c27`.
[Analiza planu D33](../../../../local-builds/full-base-preview-20261017/order-split210-source29-valid-query-plan33-preflight-fix-20261018-02/root-query-plan-analysis.private.json)
ma53002B SHA `24ddb382f32c65024581a9ae3873f47bb302f5dbac47527819a48eb016d12e50`.

W tym jednym instrumentowanym planie planning wyniósł1,640ms, execution
16,036ms. CTE493 własnych elementów:11,935ms; gałąź triggerów:4,146ms,
constraints:2,982ms,kolumny:0,789ms. Hash join triggerów obejmuje wszystkie
11741 constraints (1,303ms), mimo103 wybranych triggerów. Są to czasy węzłów
inkluzywne i zaokrąglone; nie sumujemy ich jako rozliczenia całego zapytania.
Następny kandydat to lookup nazwy constraint lokalny dla zapytania, oparty
na dokładnych OID wybranych triggerów, z zachowaniem wykrywania nieznanych
triggerów o wymaganym prefiksie oraz zewnętrznych FK. Mikrooptymalizacja
ordinal COUNT (około0,131ms) ma niższy priorytet. To hipoteza do osobnej
implementacji i pomiaru; żadnej tej optymalizacji nie wdrożono ani nie nadano
odbioru wydajności.

**D32: częściowy profil Source29 zapisany; późniejsza kontrola PIM nie przeszła.**
Oryginalny Root83078 TERMINAL EXIT1/120,152s. Po199 etapach rodzica i27
etapach210 oraz czterech bramkach TRUE wykonano niezmieniony
`ordinary187_valid()` dokładnie raz, bez rozgrzewki:57014 po8005,834542ms
przy8s. Wynik logiczny nieznany. Błąd obsłużono przez rollback savepoint;
zapisano statystyki92 OID i przywrócono wcześniejszy `track_functions`
przed kontrolami końcowymi. Pełny katalog przed/po jest zgodny bajtowo
(64591304B). Następna, osobna kontrola PIM zakończyła się57014 przy
skonfigurowanym limicie8s; nie zapisano jej osobnego czasu, więc nie
przypisujemy dokładnej liczby milisekund. Końcowe kontrole certyfikatów,
rodziców, seal i źródłowych pinów nie zostały osiągnięte.

Obserwacja BEFORE była pusta przy wcześniejszym tracking NONE:92 OID ma
wyłącznie AFTER,0 porównywalnych delt, wszystkie delty pozostają NULL.
Zgłoszony ranking AFTER czasu własnego: `order_split210_valid()` —275 wywołań/
4557,977538ms; snapshot209 —65/1383,689950ms; metadata2 —29/1036,760715ms.
To kumulacyjne obserwacje transakcji, nie wyliczone przyrosty ani dowód
samodzielnego kosztu tych funkcji w całym przerwanym zapytaniu. Czasy
inkluzywne nakładają się; nie sumujemy ich i nie przypisujemy rankingowi
pełnego rozliczenia8s, P95, kompletności call tree lub odbioru wydajności.
Tracking sam wpływa na wykonanie, a przerwane i inline funkcje mogą nie
być raportowane. Ponawiania D32, naprawy timeoutu ani wdrożenia kolejnej
optymalizacji ten wynik nie potwierdza.

Pełny ROLLBACK, DROP przy0 klientach, oba zamknięcia oraz18 niezmienionych
ról potwierdzone. Bez COMMIT, Native, aktywacji lub odbioru biznesowego.
Końcowy przegląd Root zachowuje
`PARTIAL_PROFILE_CAPTURED_POST_PROFILE_PIM_FAILED_NO_REPLAY`: niezależnie
potwierdza pełny katalog,493 dodatki/22 podmiany V29,28 certyfikatów sprzed
profilowania oraz198 aktualnych pinów i9 provenance. Odczyt tych pinów po
zakończeniu nie zastępuje nieosiągniętych kontroli operatora.
[Receipt D32](../../../../local-builds/full-base-preview-20261017/order-split210-source29-runtime-profile32-prepared-20261018-01/run/receipt.private.json)
ma117832B SHA `ecbc4328ec33740a107a1e2cb5837af4cf211a0963246f3d3314953f4ecdf7bc`.
[Przegląd Root D32](../../../../local-builds/full-base-preview-20261017/order-split210-source29-runtime-profile32-prepared-20261018-01/root-terminal-review.private.json)
ma2806B SHA `5c65c57696d84ae1fd7bd6259bb0b74502b016d94f9121cb69a597af70f1d901`.
[Analiza zapisanych statystyk](../../../../local-builds/full-base-preview-20261017/order-split210-source29-runtime-profile32-prepared-20261018-01/root-function-profile.private.json)
ma53569B SHA `dcc5939ba9ff9405551676f789084c73b952b2e295edd85b391635f039a4b46d`.

**C31: rzeczywisty Source29 wykonany; zbiorcza kontrola187 nadal przekracza8s.**
Oryginalny Root16973 zakończył się TERMINAL EXIT1 po109,522s
(18.10.2026,14:34:17.727Z–14:36:07.249Z). Ukończono199 etapów rodzica
i27 etapów210. Pełny inverse493 dodatków/22 podmian odtworzył40502 rekordy209,
canonical `10e79173…` oraz serializację64011475B `b3300ea8…`.
Wszystkie28 starych certyfikatów zachowało pełne bajty przed209, po209 i po210;
własny manifest209 bez zmiany. Seal515 zastosowany, cztery kontrole
`order_split210_valid`,209,buyer i return-credit zwróciły TRUE.

Następny `ordinary187_valid()` przerwano kodem57014 po8006,048833ms przy
niezmienionym limicie8s. Wynik logiczny pozostaje nieznany. Stos wskazuje
`order_split210_try_function_projection` linia9 → predecessor source SHA
linia3 → partial sale204 linia10 → ordinary181 financial/credit → history
PIM linia18. To miejsce osiągnięcia skumulowanego limitu całego zapytania,
bez osobnego pomiaru kosztu wskazanej funkcji lub dowodu źródła spowolnienia.
Następny krok wymaga ograniczonej diagnostyki, bez ślepego ponawiania C31,
podnoszenia limitów, pomijania kontroli lub wnioskowania szybkości z tego stosu.

ROLLBACK, DROP własnej bazy przy0 klientach oraz zamknięcie klienta i admina
potwierdzone;18 ról przed/po/końcowo zgodnych. Nie wykonano COMMIT,
rzeczywistego Native, post-QA, aktywacji ani biznesowego splitu. Końcowy
przegląd Root zachowuje FAILED: niezależnie potwierdza pełną zgodność493
dodatków oraz22 podmian z V29,28 certyfikatów i198 aktualnych pinów oraz9
osobnych provenance. Podmiany dopasowano po unikalnym kluczu, ponieważ
kolejność tablic jest różna; całe BEFORE/AFTER są zgodne. Ten odczyt po
zakończeniu nie zastępuje niewykonanego programmatic post-QA.
[Receipt C31](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler31-prepared-20261018-01/run/receipt.private.json)
ma109680B SHA `c2e56240caa7a021f04c5f2f56c22853ec3c5a76b3a4ba9fcbc9c1cbd3e41c9e`.
[Przegląd Root C31](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler31-prepared-20261018-01/root-terminal-review.private.json)
ma2716B SHA `f8b66a2694ca8265b9a8f4457112892a81dfed4529563120516c7093756a7d60`.
Zachowano oryginalną nieudaną próbę; poniższe wpisy o przygotowaniu Source29
i wcześniejszych wydaniach zachowują swoje historyczne granice.

**Osobna próba capability32: liczniki ukończonych funkcji po rollbacku savepoint.**
Oryginalny Root67390 EXIT0 potwierdził na PostgreSQL18 zachowanie liczników
ukończonych wywołań zagnieżdżonych w `pg_stat_xact_user_functions`: po
kontrolowanym błędzie P0001 pozostała delta7, a po57014 przy8004,742708ms —
delta11, po ROLLBACK TO SAVEPOINT w obu przypadkach. Pełny ROLLBACK usunął
wszystkie trzy funkcje tymczasowe; końcowo0 funkcji,18 ról i ustawienia
przywrócone, klient zamknięty. Bez COMMIT lub zmian aplikacji.
[Receipt capability32](../../../../local-builds/full-base-preview-20261017/pg18-xact-function-stats-capability32-20261018-01/receipt.private.json)
ma18791B SHA `2f9a8c7bdf265aa7ef85f0289717866917ecc4b52c7fca34f722eb8fc894495d`.
To sprawdzenie możliwości przyszłej diagnostyki, bez pomiaru Source29,
naprawy timeoutu187, dowodu kompletności liczników lub odbioru Native.

Osobny czysty [helper profilu](../../tools/parity/function-runtime-profile.mjs)
ma [11 testów kontrolowanych](../../tests/function-runtime-profile.test.mjs):
końcowy Root11/11 PASS,0 SKIP w48,922125ms. Brakujące obserwacje pozostają
nieznane, liczniki int8 zachowują precyzję, czas własny i inkluzywny są
rozdzielone, a ranking AFTER jawnie nie jest przyrostem. Helper wykorzystano
offline do interpretacji rzeczywistych zapisanych statystyk D32; sam nie
wykonuje instrumentacji bazy. Testy nie dowodzą naprawy timeoutu,
wydajności lub odbioru Native.

**Source29: współdzielona migawka, źródła i osobny odbiór47 wyrażeń SQL.**
Commit `8004077` dodaje czysty helper oraz jego testy. Root11/11 PASS
(373,910ms), cztery zestawy generatora52/52 PASS (3231,749ms) i oracle15/15
PASS (11086,600ms), bez pominięć. Pierwszy wariant delegujący do
`checked_projection_map()` odrzucono w niezależnym przeglądzie: zmiana ciała
tej funkcji lub dodatkowe przeciążenie mogły ominąć usuniętą kontrolę209.
Nie wykonano przygotowanej próby tego wariantu na PostgreSQL.

Poprawiony helper zachowuje parsowanie oryginalnych pól typowanych, następnie
wykonuje niezależne `order_split210_require()` przed wywołaniem jednej świeżej
`validation_snapshot()`. Wewnętrzna bramka migawki pozostaje niezmieniona.
Jawne kontrole manifestu, original166 i pełnego fingerprintu209 poprzedzają
porównanie wszystkich17 deskryptorów, sygnatur i liczby przeciążeń. Zachowano
całe wczesne powroty, pełny odczyt DATA,51 zamian i końcowy parse JSONB.
To usunięcie powtórnego szerokiego odczytu katalogu, bez deklaracji mniejszej
liczby wszystkich bramek lub potwierdzenia szybkości.

Body6507B `cfad1ebd…` i pełne CREATE6739B `0ed79c93…` mają pełny inverse do
Source28 7215/7447B. Niezależny odczyt źródłowego programu209 odtworzył
kandydata5094543B `bd61089c…`; wszystkie22 BEFORE i pozostałe21 AFTER są
literalnie zgodne z Source28. DATA4192445B `fedf779b…` ma1859B zapasu do4MiB.
Zmiana dotyczy wyłącznie źródła/definicji metadata2 i ich dwóch hashy;
historyczny Source27 pozostaje dosłownym świadkiem. Odrzucony wariant
guardu `e7ec…` nie jest dopuszczony przez skończony kontrakt wejścia.

Rzeczywisty P22: oryginalny Root9647 zakończył się EXIT0. Na PG04 sprawdzono
44 CHECK i3 wyrażenia generowane;45 z47 wyników są identyczne z P21, a dwa
zmienione CHECK dotyczą wyłącznie długości i SHA nowego DATA. ROLLBACK,
brak schematu po próbie, niezmienione role/członkostwa i zamknięcie klienta
potwierdzone. Nie odczytywano katalogu zainstalowanego210 i nie wykonano
COMMIT. [Receipt P22](../../../../local-builds/full-base-preview-20261017/root-source210-closure29-expression-probe22-prepared-20261018-01/receipt.private.json)
ma1776B SHA `36845e808ef58e0e481a65d71ad4c38b5b78ae2df0d262653f580d353ed42c67`;
[przegląd Root](../../../../local-builds/full-base-preview-20261017/root-source210-closure29-expression-probe22-prepared-20261018-01/root-terminal-review.private.json)
ma1517B SHA `b40eca59c33907a7cf12ae283297fec77571c1e0128ba17828a2c97000f0b2d6`.
To osobny dowód wyrażeń dla źródłowych oczekiwań, bez Native lub odbioru
pełnej instalacji.

Root opublikował następnie plikowe oczekiwania V29: check-prepared EXIT0,
oryginalny44205 EXIT0. Gzip332708B `8f2ba2f6…`, canonical `55154ca7…`,
result916B `199fdfe4…`. Niezależne porównanie z V28 potwierdziło493 dodatki,
22 podmiany,490 identycznych dodatków, wszystkie22 BEFORE i21 AFTER.
Trzy różniące się dodatki to własny valid i dwa CHECK DATA; w CHECK zmieniło
się wyłącznie pole definition. W metadata2 zmieniły się wyłącznie source
i definition. [Przegląd Root V29](../../../../local-builds/full-base-preview-20261017/order-split210-source-expectation-closure29-prepared-20261018-01/root-terminal-review.private.json)
ma1344B SHA `982d96fc4b66fd7c048f20ef4373f87d77462be391218af0908fe3db3a27cff6`.
Builder wykonał0 wywołań PG i0 żądań sieciowych; to oczekiwania ze źródeł
i rzeczywistego P22, bez przyjęcia katalogu docelowego jako oczekiwań.

H/codec oraz seal i testy instalatora zostały źródłowo przebudowane dla V29.
Root33/33 testy H/codec PASS (11557,987ms), agent19/19 testów instalatora
PASS (26947ms); wzajemne przeglądy bez P1/P2. Wszystkie493 dodatki i22
podmiany publicznego H są niezależnie DEEP równe opublikowanemu V29.
Zachowano odtworzenie CAŁEGO H28 (3180698B, SHA `5011467a…`) przed
tworzeniem starszych fixtures. Raw SQL5094543B/bd610 i rzeczywisty gzip9
592271B/ef2d są przypięte w obu identycznych codecach. APIv6/22, siedem
zasobów, pięć aliasów i limity pozostają bez zmian.

Pierwszy bieg seal/default Native65017:19 PASS,1 FAIL (stary dodatni pin
wyniku V28 w teście),25 DB SKIP. Poprawiono wyłącznie ten assert na rzeczywisty
wynik V29; oryginalny57640 zakończył się1/1 PASS. Pozostałe18 kontroli seal
i jedna kontrola Native przeszły w niezmienionym kodzie pierwszego biegu.
To pokrycie19 kontroli seal i jednej kontrolowanej Native, nie jeden końcowy
zielony bieg45 przypadków. Zachowano logi błędu i poprawki;25 pominięć nie
stanowi rzeczywistego Native. Niezależny przegląd potwierdził pełny inverse
algorytmu seal do Source28 i dokładny siedmioliniowy inverse Native;
26 przypadków oraz limity8s/120s/900s są niezmienione.

Pełny kompilator, rzeczywisty Native, aktywacja oraz odbiór API/Chrome nie
zostały zamknięte przez te testy. Nie ponawiano niezmienionej próby C30,
nie podniesiono limitów i nie przełączono zachowanych aplikacji.

**C30: Source28 po raz pierwszy wykonany; własna kontrola TRUE, zbiorcza kontrola187 nadal odmawia.**
Oryginalny Root66937 EXIT1 po129,547s. Nowy profil zachował wszystkie188
dotychczasowych pinów i dodał osiem źródłowych powiązań kodu1fb05c9;
SQL209, Source28 i V28 bez zmian, P30 poza instalatorem. Przed próbą
sprawdzono zachowane C28 i rzeczywisty pomiar C29. Nie dodano instrumentacji,
rozgrzewki, pominięć ani większych limitów. Ukończono199 etapów rodzica;
187/173 TRUE w5305,007/5463,038ms przy8s oraz wszystkie cztery niezależne
cold capabilities, w tym PIM, TRUE.

Wykonano wszystkie27 etapów210. Pełny inverse493/22 odtworzył40502 rekordy
209, canonical `10e79173…` i serializację64011475B `b3300ea8…`.
28 starych certyfikatów nie zmieniło zapisanych bajtów; seal515 zastosowany.
`order_split210_valid()` zwrócił TRUE w19,877ms — pierwszy rzeczywisty pomiar
Source28, bez porównania szybkości ze Source27. Kontrole209, buyer i return-credit
TRUE w49,068/2612,262/2531,594ms. Następny `ordinary187_valid()` przekroczył
8s po8008,225ms; wynik logiczny nieznany. Stos: metadata209 linia12 →
history_predecessor_project linia6 → ordinary187 linia376. Odczyt przypiętego
katalogu rozstrzyga przeciążenie: historia wywołuje metadata(value,entries),
a linia12 rozpoczyna pełne sprawdzanie17 aktualnych rekordów. Timeout stosu
nie jest osobnym pomiarem czasu tej pętli; późniejszy sufiks P30 nie zmienia
tego miejsca. Kolejna zmiana wymaga analizy współdzielenia pracy w jednym
wywołaniu przy zachowaniu wszystkich kontroli i limitów, bez ponawiania C30.

ROLLBACK, DROP przy0 klientach, oba zamknięcia i18 ról przed/po zgodne.
Bez COMMIT, uruchomienia rzeczywistych testów Native, aktywacji i biznesowego
splitu. Post-QA i jego powiązania ośmiu plików nie wykonały się; późniejszy
niezależny odczyt potwierdził zgodność196 pinów, bez nadania odbioru UI/API.
[Receipt C30](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler30-prepared-20261018-01/run/receipt.private.json)
ma106208B SHA `a657e417d4366d2734516e76d5fec7c8646b24241e43f9dd27644fd10540ecb6`.
[Przegląd Root](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler30-prepared-20261018-01/root-terminal-review.private.json)
ma3934B SHA `a954aa1be349988a6fe825c8a5c126f4e4b9dcb99aa2056909959c8c62f9b528`.

**Odczyt powiązań przez innych operatorów: nowy kontrakt, odbiór kontrolowany.**
Commit `1fb05c9` dodaje osobny GET `/api/order-splits/orders/:id/lineage`.
Zwykły dostęp do zamówienia jest sprawdzany pod RLS przed odczytem prywatnych
powiązań i ponownie dla wszystkich wyników po przywróceniu roli aplikacji.
Zapytania właściciela mają jawny tenant i zwracają wyłącznie identyfikatory
oraz ograniczone projekcje zdarzeń. Serwer wymaga pełnego grafu2–100 wyników,
ciągłego result_index, jednego źródła, unikalnych ID/slotów oraz zgodnego
trzypolowego zdarzenia każdego wyniku. Niepełna historia odmawia; prawdziwy
brak historii zwraca null dopiero po kontroli osieroconych fragmentów źródła.
Limity:101 jako sentinel,64KiB dla projekcji/DTO. Dotychczasowe komendy,
head i odzyskiwanie nadal wymagają autora wykonania. Nie zmieniono schematu,
grantów, rejestracji aktywacji ani wywołań zapisu Native.

Klient używa nowego GET, wiąże DTO z trwałym zdarzeniem i bieżącą sesją;
nie deklaruje, że może sam dowieść kompletności danych DB z listy ID.
Root99/99 testów backendu, klienta i React StrictMode PASS,0 SKIP,
5090,148ms; końcowy typecheck EXIT0, niezależne wzajemne przeglądy PASS.
Testy obejmują dwóch operatorów o różnych ID, viewer,99 dzieci, obcą firmę,
późny IAM, uszkodzone grafy oraz niezmienioną odmowę recovery innego autora.
To źródła i kontrolowane porty; bez rzeczywistego HTTP/PG tego czytnika,
Chrome, zainstalowanego210 i biznesowego podziału dwóch operatorów.
Poniższy opis75e4dc3 zachowuje wcześniejszy stan i jego ograniczenia.

**P30: rzeczywista równoważność podmiany metadanych, bez integracji instalatora.**
Commit `64f2e36` dostarcza czysty helper jednej zmiany7116→7261B.
Pomija podmianę source/definition wyłącznie wtedy, gdy dolna granica długości
UTF8 cytowanego tekstu przekracza długość bieżącego wyniku; zachowuje SQL NULL
przed tym sprawdzeniem. Kolejność,17 podmian hashy, cały prefiks walidacji,
przypięta baza17 rekordów, nagłówek funkcji i końcowy parse pozostają literalne.
Cały inverse funkcji PASS; Root9/9 testów źródłowych/oracle PASS,0 SKIP,
3986,094ms. Kontrolowany fixture3387B pomija32 niemożliwe duże podmiany;
to ograniczenie pracy w modelu, bez odbioru czasu PostgreSQL.

Oryginalny Root94279 EXIT0 wykonał60 wywołań TEMP funkcji starego/nowego
sufiksu w nowej własnej bazie PG04. Wszystkie30 par ma zgodne SQL NULL,
długości i SHA tekstu, w tym17 rzeczywistych deskryptorów AFTER przypiętej
bazy209, hashe, kaskady, kolizje kluczy, cytowanie i Unicode. ROLLBACK,
DROP przy0 klientach i zamknięcia potwierdzone. Pełnych bramek rodzica ani
końcowego parse JSONB nie wykonywano; wariant stary zawsze poprzedzał nowy,
więc czasy nie stanowią odbioru wydajności. Parent209/Source210 nie zmieniono.
[Receipt P30](../../../../local-builds/full-base-preview-20261017/metadata209-length-skip-probe30-prepared-20261018-01/receipt.private.json)
ma17853B SHA `4fa5120b7eb3a4987c07b7cb0cfd9128479b4261816619c80bdacb3990d9762c`.
[Przegląd Root](../../../../local-builds/full-base-preview-20261017/metadata209-length-skip-probe30-prepared-20261018-01/root-terminal-review.private.json)
ma1897B SHA `7595a62891c520e3ca2a4b5f23e94ddea75f4c874e344ad879c2fba53c667309`.
Niezależny przegląd potwierdził fakty i granice. Bez Native, aktywacji lub
biznesowego odbioru splitu; propozycja nie jest jeszcze używana w instalatorze.

**C29: pojedynczy pomiar PIM rodzica209, bez wykonania210.**
Oryginalny proces Root30536 zakończył się EXIT0. Zachowano199 etapów
rodzica i wszystkie wcześniejsze bramki C28:209/166/204/205/207 oraz187/173
TRUE. Następnie dokładnie jeden `pim_dictionary_valid()` zwrócił TRUE
w5387,463ms przy niezmienionym limicie8s. Wyłącznie na czas tego pomiaru
włączono transakcyjne `track_functions=all`, przywrócone przed ROLLBACK.
W104 zarejestrowanych pozycjach nie stwierdzono ujemnych delt; liczniki
nie dowodzą kompletności rozliczenia pracy SQL.
Największy czas własny: snapshot209 —86 wywołań/1743,778ms oraz
predecessor-metadata(value,entries) —21/1188,680ms. Definition(oid,entries)
miał6134 wywołania, ale tylko66,902ms czasu własnego. To kieruje analizę
na snapshot/projekcję metadanych. Czasów inkluzywnych nie sumujemy.

Pełny katalog40502 rekordów, canonical `10e79173…` i serializacja64011475B
`b3300ea8…` są identyczne przed/po;28 starych certyfikatów, manifesty209/166,
18 ról i ustawienia zgodne. ROLLBACK, DROP przy0 klientach i zamknięcia
obu klientów potwierdzone. Kod210DDL/COMMIT/Native fizycznie usunięto z tego
operatora. [Receipt C29](../../../../local-builds/full-base-preview-20261017/parent209-pim-cold-diagnostic29-prepared-20261018-01/run/receipt.private.json)
ma94169B SHA `2002b8a4fb0569a227e54af51fc6220cc55dc63cdbca60aaf8932787b0b2f721`.
[Końcowy przegląd Root](../../../../local-builds/full-base-preview-20261017/parent209-pim-cold-diagnostic29-prepared-20261018-01/root-terminal-review.private.json)
ma8408B SHA `4fe23df4dfbb00e16e265429f4e9ee7cc9740c96fcdbd0cd9ebc906d915f85fb`;
Root sprawdził bajty/SHA dziesięciu powiązanych artefaktów. Niezależny
przegląd plikowy potwierdził wynik. Śledzenie dodaje narzut, funkcje SQL mogą
być inlinowane, a liczniki nie stanowią pełnego rozliczenia pracy SQL.
To **odbiór pomiaru diagnostycznego**, bez dowodu usunięcia timeoutu C28,
zwykłego pomiaru bez instrumentacji, Source28/210, Native lub biznesowego splitu.

**Trwała nawigacja splitu: kod i kontrolowane testy, bez odbioru runtime210.**
Commit `75e4dc3` dodaje widok źródło/wyniki oparty na trwałych zdarzeniach
bieżącego zamówienia i istniejących GET wykonania. Odczyt pełnej unii stron
sprawdza execution/source/current-slot, wersje, UUID, limity, unikalność oraz
IAM przed i po. Nie wymaga localStorage, nie zapisuje intencji i nie ponawia
komend. Odmowa lub niespójność nie publikuje linków do pozostałych wyników.
Zmiana firmy/użytkownika/roli/zamówienia usuwa stare wyniki i anuluje odczyt;
kontroler działa również po ponownym efekcie React StrictMode. Istniejące
ograniczenie GET do autora wykonania pozostaje: widoczność dla innego operatora
wymaga osobnego rozwiązania i odbioru. Root53/53 kontrolowane testy klienta,
panelu i nowego widoku PASS,0 SKIP,2598,525ms; typecheck EXIT0 oraz niezależny
przegląd źródeł PASS. Bez rzeczywistego HTTP/Chrome, nowego splitu lub stocku.

Commit `e53b24c` wymaga jawnego, osobnego lokalnego originu dla fixture/runnera,
odrzuca Main na4100 i APP16 na4103 i wiąże progress/v2 z originem, rewizją i schematem.
Przeniesiony na inny port, stary lub niepełny dziennik odmawia przed plikami
i siecią. Root43/43 kontrolowane testy PASS,0 SKIP,1459,845ms. Historyczny
physical18 nie został przełączony; rzeczywisty odbiór wymaga nowego profilu
i wydania210. Native, zwykły start, WMS OFF/ON, API i Chrome pozostają otwarte.

**Historyczna pełna próba C28: timeout rodzica209 przed pierwszym DDL210.**
Root oryginalny77703 zakończył się EXIT1 po91,381s. Ukończono199 etapów
rodzica; jego ordinary187/large-import173 oraz połączone209/166/204/205/207
zwróciły TRUE. Następny niezależny cold capability `pim_dictionary_valid()`
przekroczył niezmieniony limit8s: PIM14 → financial-return46 →
partial-sale204 predecessor3 → order-merge209 predecessor-definition8.
Nie rozpoczęto żadnego z27 etapów210. W receipt nie ma before210/after210,
pełnego inverse210 ani seal210. **Nowa walidacja Source28 nie została wykonana
lub zmierzona**; ten wynik nie dowodzi jej poprawy ani regresji.

ROLLBACK, DROP przy0 klientach, zamknięcie klienta/admina i dokładna równość
ról przed/po są potwierdzone. Nie ponowiono próby. [Receipt C28](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler28-prepared-1792329000280/run/receipt.private.json)
ma82293B SHA `97aa963f90b91cce4289a0ba4cdd03b96ef3527aadd97740107167fdfb6710d7`.
[Końcowy przegląd Root](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler28-prepared-1792329000280/root-terminal-review.private.json)
ma1857B SHA `5506e3679ba28eaf7b94ba2fc10e906fdc87cc9b8073a504bc4fa8dc9a63c005`.
Pozostają otwarte kompilacja210, rzeczywisty Native, aktywacja i biznesowy split.

**Historyczne przygotowanie Source28: wspólny odczyt w jednym zapytaniu.**
Commit `be95c26` usuwa powtórne odczyty pełnych22 deskryptorów oraz ośmiu
rodzajów własnego katalogu wewnątrz jednego wywołania `order_split210_valid()`.
MATERIALIZED zachowuje pełne rekordy,36 kontroli zewnętrznych i identyczne
równanie fingerprintu. Każde kolejne wywołanie nadal wykonuje świeżą kontrolę;
nie dodano cache, nowej funkcji runtime ani obejścia bramek. SQL ma5096765B,
SHA `0efeb7fab0521edd3e4130930750482722548e52c32dc553b3787c4774673766`.
Plikowy inverse przywraca całe Source27 bajtowo. DATA4193843B oraz wszystkie22
poprzedniki są bez zmian. Root37/37 testów źródłowych i15/15 oracle PASS;
testy równania nie zastępują rzeczywistego kompilatora lub pomiaru wydajności.

Rzeczywisty P21, oryginalny4506 EXIT0, potwierdził44 CHECK+3 generated,
ROLLBACK, brak schematu, zgodność ról/członkostw i zamknięcie klienta.
[Receipt](../../../../local-builds/full-base-preview-20261017/root-source210-closure28-expression-probe21-prepared-1792327314519/receipt.private.json)
ma1780B SHA `f0b98cc7ec3e860f09dba45368c474d8e807a7845d35ebdfde5c86ad51bf1874`.
VECTOR28, oryginalny24851 EXIT0, opublikował493 dodatki/22 podmiany bez pól
oczekujących przy120 źródłach i91 zgodnych źródłach P21. Gzip331940B ma SHA
`21d960ec9c29b4319c8b754dfc041a3326fb7ca95376eaa41920b86fbfab47af`,
canonical `01b5bb22cb11877c0660cc60df4f988b743ec5f4e211d568d89240289de43924`.
Root niezależnie porównał publikacje: pozostałe492 pełne rekordy i wszystkie22
podmiany są identyczne; zmieniły się wyłącznie source/definition pełnego
24-polowego rekordu valid. [Przegląd Root](../../../../local-builds/full-base-preview-20261017/order-split210-source-expectation-closure28-prepared-1792327314520/root-terminal-review.private.json)
ma1364B SHA `73250b04a71ea0412598d31d1950fde40a89c30404a5dd455b5edcdcd2fef554`.
H/codec/seal/Native oraz testy instalatora są źródłowo zsynchronizowane.
Root katalog/codec31/31 i installer17/17 PASS; fixed-seal/default Native ma
44 testy:19 PASS (18 seal i jeden harness),25 rzeczywistych DB SKIP.
Pominięcia nie nadają odbioru Native. Oba codec są bajtowo identyczne;
rzeczywisty gzip9 ma590882B SHA
`88cb0d063a89c88c15c64b2cf7467d22cd15a5434d0b94fdfe0d3af5fad89646`.
Pełny Source27 jest zachowany jako historyczny świadek; jego stare valid
jest odrzucane po wszystkich24 polach. Algorytm seal od capture do końca
pliku, kod produkcyjny instalatora,26 przypadków Native i limity są niezmienione.
[Źródłowy przegląd integracji Root](../../../../local-builds/full-base-preview-20261017/order-split210-source-expectation-closure28-prepared-1792327314520/root-integration-review.private.json)
ma3378B SHA `96dfb47960f160cded7412fd27254a42016813c684d7a838f8d7889a0e3f9386`.
W chwili C28 był to **SOURCE_EXPECTATION_PREPARED_NOT_COMPILED**: odmowa nastąpiła przed210,
bez rzeczywistego Native, aktywacji aplikacji i biznesowego splitu.
Wcześniejszą próbę C27 z wykonanymi etapami210 opisano niżej.

**Historyczna próba z27 etapami210: Source27/C27 — inverse PASS, timeout187.**
Jednorazowy oryginalny proces40543 zakończył się EXIT1. Wszystkie27 etapów
kandydata Source27 wykonano, a493 dodatki i22 podmiany odwrócono dokładnie do
40502 rekordów rodzica209: canonical `10e79173…`, pełna serializacja64011475B
`b3300ea8…`. Zachowano28 tabel certyfikatów; źródłowy seal515 i kontrole210,
209, buyer oraz return-credit przeszły. SQL5096180B ma SHA
`eeb5034d0d26766f4548a895e3a23b9ae2ab9ad7854215583e8995d9a218c6e3`;
rzeczywisty gzip9 Node24.17 ma592595B SHA
`827c16deeb3640815ea151e29a61391686652f3558f2b76a845cff9448e97d24`.
DATA4193843B,22 poprzedniki, pozostałe492 dodatki, przodek buyer208 oraz limity
8s/4MiB/16MiB/96MiB pozostają bez zmian względem Source26.

Następny `ordinary187_valid()` przerwano57014 przy niezmienionym limicie8s.
Stos:210 require1 → try_function_projection6 →209 predecessor_source_sha3 →
partial_sale204_valid10 →209 history_operative_valid62 →wave_valid541 →187373.
Logiczny wynik187 pozostaje **nieznany**, a173 i Native26 nie zostały odebrane.
Potwierdzono ROLLBACK, DROP własnej bazy przy0 połączeń, oba zamknięcia klientów
i dokładną zgodność ról. Nie było COMMIT Source210, aktywacji aplikacji ani
biznesowego podziału. To odmowa próby integralności, nie dowód błędu procesu
workerów lub działającego wydania209.

[Receipt C27](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler27-prepared-1792324998451/run/receipt.private.json)
ma102644B SHA `70f748ce61bdf3ff05b0153b33e0de2e29dd9ff2e975cebd00c0c0509fc438a9`.
[Root terminal review](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler27-prepared-1792324998451/root-terminal-review.private.json)
ma1574B SHA `7b839bdc6435d6ae79dd5298a1949000868847c5609f65ac282e6e333b1ac330`
i potwierdza oryginalny EXIT1 oraz powyższe granice.

Źródłowe przygotowanie pozostaje osobnym dowodem: rzeczywisty P20 potwierdził
44 CHECK+3 generated z tym samym47-liściowym canonical `010fc936…` i cleanup.
VECTOR27 opublikował493/22 przy118 przypięciach: gzip332079B
`a1740b25e4ca292c6ce74cbc50f2cf3bc204e5c402d5e7e515976f9926b18b13`,
canonical `08127853acbf4f976ca1eb0e3b838affb79f75343a42625d68be838d08432130`,
result `dbe676ffab9589d76d26b9ca2ae418823aa50623f9253263e6c9ee6025f7e229`.
H/codec30 testów oraz installer17/17 PASS. Fixed-seal/default Native:
43 testy,18 PASS i25 SKIP w58,999s; jest to17 testów seal i jeden kontrolowany
harness bez PG, a pominięcia **nie stanowią rzeczywistego Native26**.

**Historyczna hipoteza kosztu po C27 — większej mapy nie wdrożono.**
Bieżący Source209 `partial_sale204_valid()` tworzy świeżą mapę209, następnie
agreguje36 nazw przez `predecessor_source_sha`. Pięć z nich (fa3, invoice,
credit, financial-return i ordinary-financial) trafia do pełnej świeżej
projekcji210; legacy buyer wymaga kolejnej walidacji210. Pełne zdrowe przejście
tego fragmentu ma więc sześć takich kontroli oraz kontrolę snapshotu. Pozostałe
31 nazw odpada z `try_function_projection` po tanim sprawdzeniu nazwy, przed
DATA i pełnym deskryptorem. Stos C27 wskazuje miejsce wyczerpania wspólnego
budżetu, nie liczbę wykonanych wywołań, osobny koszt tej linii ani regresję
filtra metadanych Source27. Wąska propozycja to źródłowo uwierzytelniona,
wewnętrzna mapa pięciu pełnych deskryptorów w jednym zapytaniu, ze świeżą
kontrolą całości i niezmienioną odmową obcych/niepełnych rekordów. Wymaga najpierw
pełnego dowodu inverse i budżetu: nowy następca funkcji17091B nie mieści się
w461B zapasu DATA przy obecnym pełnym zapisie. Nie zwiększono limitu ani nie
przygotowano automatycznej kolejnej próby.

Poniżej zachowano wcześniejsze wyniki i ich historyczne granice dowodów.

**Historia — Source26 zintegrowany; C26 zakończony timeoutem, bez Native.**
Lokalny commit `758df1e` obejmuje źródłową projekcję metadanych i spójne
oczekiwania/H/codec/seal. SQL5095667B SHA
`082e4bed0cf507ceb12c9e351f97fe54c051bf9e332da50546e71f124bcc621a`,
gzip592554B SHA
`8d66c1fda0262a45558338c5267c4633484b80f023b0f85e868aba43680572eb`.
Całe22 podmiany i pozostałe492 dodatki są zgodne ze Source25; zmienia się
jedna własna pełna funkcja metadanych, z zachowaniem nagłówka i ACL.
DATA4193843B pozostaje461B poniżej4MiB. Limity8s,16MiB i96MiB bez zmian.

Rzeczywisty P19 potwierdził44 CHECK+3 generated (47 liści,
canonical `010fc936121a2b1670f3c2b44c456e59921059042076cdb86d766f936f6b6e93`),
z ROLLBACK/brakiem schematu/niezmienionymi rolami i zamknięciem klienta.
VECTOR26 rzeczywiście opublikował493 dodatki/22 podmiany bez pól oczekujących
przy116 źródłach: gzip331946B SHA
`39ce117f86cbb6abddf89d24aaa67853e3eb12ca60bad787dfd81877c625957a`,
canonical `b336aea5299585985e39a3025727685ba61e15bb254aa226b84538d82bf24a0e`,
result918B SHA `849c1feb631f79b1d8fea65ef069d16e245751e783470b2f5ec8e316498a5e0a`.
H v6/22 zachowuje wszystkie flagi odbioru false i historyczne pełne rekordy
Source25/24.65 testów helpera/źródeł,29 H/codec,17 installer PASS.
Root seal/default Native:42 testy,17 PASS/25 SKIP w56,237s; pominięcia nie są
rzeczywistym wykonaniem Native26 ani dowodem wydajności.

Jednorazowy oryginalny83906 zakończył się EXIT1 po około113,814s.
Wszystkie27 etapów i pełny493/22 inverse do40502 rekordów209 PASS:
canonical `10e79173b664e4eb1856e66af1e92ec2620d274edeb5332e53f4b1d11bb388c0`,
pełna serializacja64011475B SHA
`b3300ea8ae4933715ef1bdd7d36318b7908a56db321cbef01d2845ecfa10fcf3`.
Zachowano28 dawnych tabel certyfikatów; seal515 wykonano w transakcji.
Własne210/209/buyer/return-credit zwróciły TRUE. Następny `ordinary187_valid()`
przerwano57014 po8001,305708ms przy niezmienionych8s. Stos:
`order_split210_try_metadata_projection`41 →
`order_merge_delivery209_predecessor_metadata`3 → `ordinary187_valid`376.
Linia41 porównuje pełne finansowe deskryptory20/21 pól. To miejsce wyczerpania
wspólnego budżetu, nie operacja stosu DFS ani osobny pomiar kosztu tej linii;
nie jest to dowód regresji wydajności.
Pełny logiczny wynik187 pozostaje nieznany.187/173 TRUE sprzed instalacji210
potwierdzają wyłącznie rodzica209, nie bieżącego Source26.

Receipt101594B SHA
`c07cc4305144f566d32816f3732490ec7065433595193f03e080823b809b256d`:
`local-builds/full-base-preview-20261017/order-split210-sealed-compiler26-prepared-1792316600210/run/receipt.private.json`.
Root terminal review2720B SHA
`1fb898db63a85624eae81cd89b865ddd6e4761e7df88f6a864203d68462a06d4`
w tym samym katalogu nadrzędnym: `root-terminal-review.private.json`.
Potwierdzono ROLLBACK, normalny DROP własnej bazy przy0 połączeń, oba zamknięcia
i literalną zgodność ról. Bez COMMIT, Native26, emisji instalatora, aktualizacji
kopii, aktywacji aplikacji i biznesowego splitu. Nie przełączano Main/APP16.
Root potwierdził świeże HTTP200: Main4100/db1a33d2…/schemat205 i
APP164103/691a7cb5…/schemat209. W obu background_workers=false; scoped_automation
pozostaje true w Main i false w APP16. To nie jest odbiór lifecycle workerów.
Odmowa C26 jest zachowana, bez ponowienia lub rozluźnienia limitów.

Osobne dowody produktu: Mirakl `060153a` ma Root81 testów i typecheck PASS
oraz Chrome **SYNTHETIC_COMPONENT_UI** ([raport](MIRAKL-OFFERS-PAGINATION-LOCAL-20261018.md));
nie jest to odbiór konta dostawcy ani aktywacja splitu. Runner SMTP `7752f93`
ma17 kontrolowanych testów PASS, lecz rzeczywisty lifecycle aplikacji dwóch
tenantów nadal **NOT_RUN** ([warunki](../../tools/parity/worker-smtp-ack-acceptance.README.md)).

Poniższe sekcje stanowią historię wcześniejszych przygotowań i prób.

**Historia — Source25 zintegrowany, C25 zakończony odmową.**
Commit `c2e142a` integruje helper metadanych z assemblerem oraz niezależnymi
oczekiwaniami/H/codec/seal. SQL5095544B SHA
`d9498e231ea31c10c2182c94de442ac4e5edd94525ab8db8fcfee314582de4d3`,
gzip592532B `d9465a23f040e5570db2c8f078663741177e518e0981964371db0ecdbc8299a9`.
DATA4193843B/4MiB oraz wszystkie22 podmiany pozostają zgodne z Source24.
47 core/oracle,28 H/codec i17 installer PASS. Rzeczywiste PROBE18 oraz VECTOR25
zakończone;493 dodatki,22 podmiany, brak pozycji oczekujących. Root zestaw
fixed-seal/default Native:16 PASS/25 SKIP; nie był to rzeczywisty Native26.

Jednorazowy oryginalny10253 zakończył się EXIT1/113,434s. Wszystkie27 etapów,
pełny493/22 inverse do40502 rekordów209 (canonical10e79173…, serializacjab3300ea8…)
i cztery kontrole210/209/buyer/return-credit przeszły. Następny187 przerwano
57014 przy8s, stos:209 predecessor_metadata linia48 →187 linia376.
Przejście wcześniejszej linii375 wynika z kolejności wykonania; pełny logiczny
wynik187 pozostaje nieznany. Linia48 to końcowe parsowanie JSON, bez osobnego
pomiaru jego udziału w łącznym koszcie. Nie należy przypisywać całego kosztu
tej jednej operacji ani twierdzić, że nadal wystąpiła rekurencja helpera210.

Receipt100915B SHA
`48208febf4e0fc24887629eebf530589dd3051a7bc3f2b68f3786e43e6f8698b`:
`local-builds/full-base-preview-20261017/order-split210-sealed-compiler25-prepared-1792316200210/run/receipt.private.json`.
Root terminal review2482B SHA
`15c9218afc8c107a2b162dc823d834392eb3b2d7660e4cff5034a0ab3db606bc`
w tym samym katalogu nadrzędnym: `root-terminal-review.private.json`.
Potwierdzono ROLLBACK, DROP przy0 połączeń, oba zamknięcia i niezmienione role.
Ponowny health Main4100/APP164103:HTTP200, te same rewizje205/209, workery OFF.
Bez Native, COMMIT, emisji modułu instalacyjnego, aktywacji lub odbioru splitu.
C25 nie jest ponawiany. Kolejny kandydat wymaga dowodu zachowania semantyki,
spójnych źródłowych oczekiwań oraz osobnego odbioru; limity pozostają bez zmian.

Poniższe sekcje zachowują historyczne przygotowania i wyniki.

**Source25 — czysty helper przejścia metadanych przygotowany, bez integracji.**
Lokalny commit `1b16baf` dodaje wyłącznie helper i test. Wejściem jest dokładny
źródłowy CREATE Source24:16192B SHA
`a06f8c1eaff7701be568309d312bd9ddfac375334c3557c04d5dc8cbdc623513`.
22 rozłączne edity odwracają całe źródło;17 zwracanych wyrażeń i kolejność
klasyfikatorów pozostają. Jedna świeża walidacja i odczyt DATA poprzedzają
lokalne DFS; rozróżniono SQLNULL/JSONnull oraz terminalną tożsamość BEFORE.
Nagłówek/ACL pozostają, nie dodano runtime funkcji ani wejścia zaufanych danych.
9/9 testów źródeł i modeli referencyjnych PASS; Root potwierdził niezależnym
uruchomieniem, przegląd źródeł nie wykazał konkretnego P1/P2.
To nie są rzeczywiste testy SQL, wydajności ani Native.

Root przygotował osobną prywatną propozycję programu: dokładnie jedna własna
funkcja zmieniona, wszystkie inne bajty Source24 zachowane. SQL5095544B SHA
`d9498e231ea31c10c2182c94de442ac4e5edd94525ab8db8fcfee314582de4d3`;
gzip592532B SHA
`d9465a23f040e5570db2c8f078663741177e518e0981964371db0ecdbc8299a9`.
DATA pozostaje4193843B/0d59e41f… przy4MiB;22 podmiany poprzedników bez zmian.
Raport: `local-builds/full-base-preview-20261017/root-source25-metadata-proposal-1792315800210/summary.private.json`.
W tym historycznym etapie publiczny assembler/Native/H odpowiadały Source24. Następny etap wymagał
spójnej integracji Source25, niezależnych oczekiwań i nowej jednorazowej próby.
Poprzednia odmowa C24 pozostaje ważna; Main/APP16 nie przełączono.

**C24 — pełny inverse PASS; następna kontrola przekroczyła8s.**
Jednorazowy oryginalny74437 zakończył się EXIT1 po113,243s. Wszystkie27 etapów,
pełne493 dodatki/22 podmiany i inverse do40502 rekordów209 przeszły;
canonical10e79173… i pełna serializacja64011475B b3300ea8… są zgodne.
28 starych tabel certyfikatów zachowano. Seal515 ma616088B SHA
`d091cc3991d2e318354bc066b672f84d7e7031a176e2c60b4146c653535d3408`.
Własne210/209/buyer/return-credit TRUE. Następny187 przerwano57014 przy8s:
valid15 → require1 → try_metadata_projection5 →62 →60 →209metadata3 →187375.
To późniejszy punkt niż history operative373 w C23; pełny logiczny wynik187
nadal nieznany. Kontrola metadanych rekurencyjnie wywołuje tę samą świeżą
walidację210 i odczyt DATA; liczby wywołań ani kosztu perwęzeł nie zmierzono.
Następny kandydat ograniczy współdzielenie do jednego wywołania funkcji,
bez cache pomiędzy wywołaniami lub nowego zaufanego API.

ROLLBACK, DROP przy0 połączeniach, oba zamknięcia i zgodność ról potwierdzone.
Brak Native26/COMMIT/aktywacji. Main i APP16 ponownie HTTP200 na niezmienionych
rewizjach, background_workers=false. Receipt100974B SHA
`e0a8aedbf0e3369693c610a2797530ab822d68c2227cde0e656ca1c01321dbd2`;
Root review3189B SHA
`b4db8397b1e64be7e4baf9331d01b2dc2664c224455f1f87ac142626c7a29477`
w `local-builds/full-base-preview-20261017/order-split210-sealed-compiler24-prepared-1792315000210/`.

Poniżej historyczne przygotowanie i próby; aktualna odmowa jest powyżej.

**Source24 — zintegrowany kandydat źródłowy, jeszcze bez odbioru PostgreSQL.**
Dwa pełne zapytania rodzin158/159 mają po jednej świeżej walidacji210 oraz
lokalne MATERIALIZED mapy dwóch zadeklarowanych triggerów i dwóch definicji
rodziny partial204. Pozostałe funkcje korzystają z zachowanego fallbacku;
trzy właściwości NULL oraz pojedynczy overload nadal warunkują ścisłą projekcję.
Dwa całe edit-spany odwracają się do Source23, a wcześniejsze do literalnego209.
Nowy helper ma8/8 testów czystych PASS i niezależny przegląd źródeł.

Root derivacja: SQL5093221B SHA
`59bafbea5dabb4e8ccd65139d9075f5433be252545971c04a9f0d0cc226ba2d7`;
gzip592117B SHA
`5e86c3e5c5a4fcd8135b0a0a4f00a8d1127ae83021af9cfb657da71a8aaf9cbe`.
DATA4193843B SHA
`0d59e41fbe0cc778bc4009e1efafa47905eb351a99e00f6bd74207a6ceb351a7`,
461B poniżej niezmienionych4MiB.27 etapów/49 deklaracji/22 podmiany pozostają;
wszystkie pozostałe21 podmian są bajtowo zgodne z rzeczywistym VECTOR23.
To nie jest pomiar przyspieszenia ani odbiór migracji.
Dowód: `local-builds/full-base-preview-20261017/root-source24-core-source-derivation-1792318651837/summary.private.json`.

**Source24 — zakończone niezależne przygotowanie oczekiwań.**
Rzeczywisty PROBE17 zakończył się EXIT0/1,372s:44 CHECK+3 generated,
ROLLBACK/schema absent/role/memberships/client closed TRUE; bez target catalogue,
COMMIT i Native. Receipt1780B SHA
`7588510327377f8056b9f15af79745d9da4c5f3dd158b8a1f0f99f6297d0b42e`;
47 liści canonical `010fc936121a2b1670f3c2b44c456e59921059042076cdb86d766f936f6b6e93`.
Rzeczywisty VECTOR24 EXIT0/1,864s opublikował493/22 przy112 źródłach;
gzip331330B SHA `77ee6e1eb03d33e46f118286162cd17d9dd55a772f308b5eb476b709a52679b3`,
canonical `41c9f44f255c3626bda1cdb88a2b2d65dd1f70ab834639980c68c01fccdf1b58`.
H ma pełne493/22 bajtowo zgodne z tym wektorem; oba kodeki są identyczne.
Źródłowe zestawy:44 core/oracle,15 helperów,28 H/codec oraz15 installer PASS bez pominięć.
Root fixed-seal/default Native:40 testów,15 PASS/25 SKIP,0 FAIL; to nie jest
rzeczywiste wykonanie26 Native. Stary pełny Source23/22 nadal jest odrzucany.
Kod Source24 zapisano lokalnie w `37f0b76`; to nie nadaje odbioru migracji.
Nowa pełna kompilacja i odbiór aplikacji pozostają wymagane.

**C23 — rzeczywisty wynik FAILED, bez ponowienia.**
Oryginalny39471: EXIT1/113,507s, wszystkie27 etapów. Pełne493/22 odwrócono
na40502 rekordy209, canonical10e79173…/serializacja64011475B b3300ea8…;
28 starych tabel certyfikatów zachowano. Seal515 wykonano, kontrole własne210,
209, buyer i return-credit zwróciły TRUE. Następny187 przekroczył8s:
57014/8002,277208ms; stos operative121 → wave541 →187373. Linia121 przetwarza
JSON po drugim zapytaniu finansowym; to miejsce wyczerpania całego budżetu,
bez dowodu, że sama ta linia jest wąskim gardłem. Wynik logiczny187 nieznany.
Native26/COMMIT/cold4/aktywacja nie zostały osiągnięte. ROLLBACK, DROP przy0
połączeniach, oba zamknięcia oraz zgodność ról potwierdzone.
Receipt `order-split210-sealed-compiler23-prepared-1792314400210/run/receipt.private.json`:
100514B SHA `fca9c26cd5d9aac38473e45c6c21941ca787f2c8b80c9e359c0695a24eaa293e`.
Root terminal review w tym samym katalogu:10122B SHA
`c8dbd81834ada5b6ec786e07e4ea43f1bb1b089a1bf805591f1cd4887e4ab534`.

**Source23 — ukończone kroki źródłowe poprzedzające C23.**
36 testów core i manual projection,14 oracle,28 H/codec,15 installer PASS.
Fixed-seal/default Native:14 PASS i25 SKIP; pominięcia nie są odbiorem Native.
Rzeczywisty PROBE16 potwierdził47 wyrażeń i rollback; VECTOR23 opublikował493/22
przy110 przypiętych źródłach. To oczekiwania źródeł, bez odbioru produktu.

Przed nową próbą Main i APP16 odpowiadają HTTP200 na poprzednich rewizjach.
Main205 ma background_workers=false/scoped_automation=true; APP16/schema209
ma oba false. Zachowano istniejące dane i wąski odbiór MERGE; split jest wyłączony.

Poniżej historyczny zapis wcześniejszych etapów; bieżący stan jest powyżej.

**Source23 — czysty następca walidatora180 przygotowany, jeszcze bez integracji.**
`tools/parity/order-split210-manual-projection-successor.mjs` ma18065B SHA
`89d0085567a70cb118cd63a664eeb66e6b8d6a58100e909c5c2c5ada5bba784b`.
Jeden port SELECT używa istniejącego `try_function_projection(oid)->>'source'`
wyłącznie dla b2b credit; świeża walidacja210 i pełny AFTER poprzedzają zwrot
literalnego BEFORE169. Pozostałe trzy odczyty, wszystkie certyfikaty, nagłówek,
ACL i cały inverse zachowane.7/7 testów źródłowych bez pominięć i niezależny RO
PASS_SOURCE_ONLY. AFTER62874B SHA
`1ed715eab820427ab1f5f21a1223c55ae7179a65a3b043258fc29adda3c13097`;
pełne24 pola `524590ac58593b4da406a6f1b14085b48ec47825c7b74824a58fc00eb7252db9`.

Root zmierzył proponowane DATA po dodaniu pełnej22. zmiany i nonlegacy key:
4192139B przy stałym4194304B,2165B zapasu. Zachowano pełne raw BEFORE/AFTER;
żadna kompakcja, nowa rodzina ani kształt metadanych nie są potrzebne według
zbadanych konsumentów. To pomiar propozycji, bez integracji w assemblerze.
Raport i decyzja: `local-builds/full-base-preview-20261017/root-source23-data-budget-1792317174934/`.
Kolejne kroki: assembler22/27 etapów/49 deklaracji, źródłowe testy, niezależne
oczekiwania oraz pełna migracja/seal515/Native26. Prywatny migration helper
musi dopuścić dokładnie nazwane `b jsonb` i sentinel LIMIT23. Aktywacja aplikacji
wymaga własnego odbioru; bieżące źródła Source22 i Main/APP16 nie zostały
zastąpione przez przygotowany helper.

**Po C22 — potwierdzony źródłowo fałszywy parametr projekcji.**
Bieżący `ordinary180_projection_valid(b jsonb)` jest nadal całym literalnym
Source180: ciało62761B SHA
`935413d577889f484287b5b3ab9b164ac906d0c5d9582d9a3595eed897e79436`,
pełne24 pola SHA `8d586129ef7525342d0a6d2fd208a64b0d024e2634aeeb5613e997f4f8d57b71`.
Pętla porównuje surowe ciała czterech funkcji z zachowanym certyfikatem169.
Przed210 wszystkie cztery były zgodne; po210 jedynie `b2b_credit_fingerprint()`
różni się od własnego certyfikowanego BEFORE:5802B/9e3766d4… →6024B/71d6e7a1….
Wymusza to FALSE parametru projekcji w `ordinary181_manual_basis`, a kalkulator
kredytu zwraca NULL zgodnie z zachowaną semantyką. Nowa gałąź TRUE kalkulatora
nie może naprawić tego wcześniejszego warunku. To wykazana pozostająca
niezgodność; dokładnej pierwszej gałęzi odmowy187 w C22 nie zmierzono.
Dowód2866B SHA `5d4a51c0ce6c87fda14d75cb059a5a43b3c61d79dd10b849581fc2f59b7bf53d`
w katalogu C22: `manual-basis-projection-source-proof.private.json`.

Następna poprawka ma projektować wyłącznie tę jedną funkcję przez istniejącą
świeżą walidację210 i pełny descriptor AFTER; pozostałe trzy odczyty, certyfikat,
nagłówek i ACL pozostają literalne. Obecny187 już odczytuje SHA tego walidatora
przez209 predecessor, bez potrzeby nowej rodziny lub kopii metadanych.
Zmianę trzeba sprawdzić względem pozostałego258851B budżetu DATA4MiB,
pełnej kompilacji, Native i aplikacji. Bez zmiany limitów lub certyfikatów.

**C22 — pełny493/21 inverse PASS, nadal odmowa187.**
Oryginalny proces77968 zakończył się EXIT1 po117,361s. Wykonano26 etapów
Source22; wszystkie493 dodatki i21 pełnych podmian przeszły porównanie źródłowe.
Cały inverse odtworzył40502 rekordy literalnego209, canonical
`10e79173b664e4eb1856e66af1e92ec2620d274edeb5332e53f4b1d11bb388c0`
i serializację64011475B SHA
`b3300ea8ae4933715ef1bdd7d36318b7908a56db321cbef01d2845ecfa10fcf3`.
Seal514 oraz28 starych tabel certyfikatów zgodne. Własne210/209, buyer i
return-credit zwróciły TRUE. Kolejne `ordinary187_valid()` zwróciło FALSE
po7643,81175ms przy niezmienionym8s, bez timeoutu. To odmowa logiczna;
nie odebrano poprawności kredytowego wyniku ani pełnej integralności modułu.
Duże173, cztery cold kontrole po210, COMMIT i Native26 nieosiągnięte.

ROLLBACK, normalny DROP przy0 klientach, oba zamknięcia i role bez zmian
potwierdzone. Main4100/APP164103 nadal HTTP200 na tych samych rewizjach,
workery wyłączone. Receipt98935B SHA
`ebce575fd15c31a766366cd30ade15243d9840f11410839055f7b54380247e8b`,
Root review2040B SHA
`0c661f27ca0de4f725b3e07ea05f268182e6c30d6458067ba36752e087790d75`
w `local-builds/full-base-preview-20261017/order-split210-sealed-compiler22-prepared-1792313900210/`.
Następny krok to porównanie zachowanych źródeł i katalogów, bez ponawiania
tej samej próby ani zastępowania certyfikatów zaobserwowanymi wartościami.

Końcowy Root zestaw fixed-seal + domyślny Native harness:13PASS/0FAIL/25SKIP,
43279,292ms. Dwanaście testów seal i jeden kontrolowany harness przeszły;
25 pominięć nie oznacza rzeczywistego Native. Instalator:15/15 testów
źródłowych bez pominięć. Wcześniejsze dwa zestawy Root odrzuciły nieaktualne
literały DATA w teście; oczekiwania poprawiono do niezależnie wyprowadzonego
3935453B/3b432d74…, bez zmiany limitu lub źródłowego seal.

**Source22 — następca kalkulatora i niezależne oczekiwania przygotowane.**
Dodano 21. podmianę: `ordinary181_credit_calculate(projection_ok boolean)`.
Przy TRUE wykonuje świeżą walidację210 i pomija wyłącznie pięć źródłowo
wyznaczonych triggerów210 w obu selektorach. FALSE/NULL zachowują poprzedni
wynik NULL; cały packing189 inverse, nagłówek, ACL i kodek pozostają zachowane.
Nie dodano nowych funkcji ani nie zmieniono historycznych certyfikatów.
Kandydat ma 4761964 B SHA
`9e3ba852a350877d4d2106c7d794a29f236dd4794b4ef00d41fd15a6a0e5fe52`;
26 etapów, 48 deklaracji, 493 dodatki i 21 podmian. DATA ma 3935453 B przy
niezmienionym limicie 4 MiB. Root potwierdził 36/36 testów źródeł i osobno
14/14 testów niezależnego oracle, bez pominięć. To dowody źródłowe.

Rzeczywisty PROBE15, oryginalny99721 EXIT0, potwierdził 47 wyrażeń schematu;
ROLLBACK, brak schematu próbnego i zamknięcie klienta potwierdzone.
Receipt 1780 B SHA `d278c5c28f5fc83b1edb5a91c437f0abbc96750d589a892500eb123d9df407dd`,
basis 9078 B SHA `506c6905c39074ede16b24c1602b670001f354fbf045b0905c6911f2bc5a26fb`.
To osobna próba wyrażeń, bez pełnej migracji, COMMIT i Native.
VECTOR22, oryginalny5208 EXIT0, opublikował oczekiwania 493+21 z 108 źródeł:
gzip 304389 B SHA `9ef39ca65e0531fd2c72c47ebe7913bd1d43d29d017fbb43f25045d9019e67f0`,
canonical `476dd5601335c1875854abd8065f63fc9d5dd9638ba1db652fd2d4125d3cb766`,
result 918 B SHA `88a1c34699a3c30f6f8d6f50f629b81b338c356d75093ffb256f86b64f5ef48e`.
Publikacja nie uruchamiała PostgreSQL ani sieci; wszystkie flagi odbioru false.

H v5 i kodek22 uwzględniają rzeczywisty VECTOR22 i zachowują historyczne v2–v4.
Pozostają wymagane: końcowe testy instalatora, pełna kompilacja493/21,
seal514, rzeczywiste Native26, migracja kopii, start i biznesowy split UI/API/WMS.
Main i APP16 nie zostały przełączone. Historyczne odmowy pozostają ważne.

**Źródłowy konflikt kredytowy po C21 — poprawka jeszcze nieodebrana.**
Aktualne `ordinary181_credit_calculate(projection_ok boolean)` odpowiada dokładnie
definicji Source189: ciało 10976 B SHA `cd01cc819ad82f1049d7ab3d601eff67d99d5cfce631b4dcb268267c1108176e`,
pełny descriptor 24 pól SHA `ee435112e587dc13f430bd6d46f819e21e5a92f33b7a9e59d664b91bd116fef1`.
Jego selektory obejmują pięć nowych triggerów `order_split210_bound` oraz jedną
nową funkcję guard z członkostwa triggerów dwóch tabel. To dodatkowe wejście
do MD5 kredytowego, przenoszone przez `ordinary181_manual_basis` do fingerprintu160.
Oryginalna projekcja Source189 usuwa własne obiekty packing, lecz nie dodatki210.
Źródłowo potwierdzono zmianę wejścia, bez pomiaru konkretnej wartości MD5 ani
bezpośredniego rozdzielenia klauzuli5 w PostgreSQL. Raport C21
`credit-calculation-source-review.private.json` 4239 B SHA
`7efeede84a5101d50824a9fe723bee05f00879326f4928beb288be600eed7735`.
Przygotowywany jest właściwy następca kalkulatora jako 21. zmieniana funkcja;
zachować tryby projekcji, świeżą walidację210, nagłówki/ACL i historyczny kodek.
Nie zmieniać zapisanych fingerprintów ani certyfikatów. Source21 pozostaje
nieodebrany; nowy kandydat i wszystkie jego oczekiwania wymagają osobnego odbioru.

**C21 — pierwsza odmowa dotyczy porównania certyfikatu historii.**
Oryginalny proces 2951 zakończył się diagnostycznie EXIT0. Probe bieżącego,
źródłowo wyprowadzonego AFTER Source21 wskazał `SOURCE21_OPERATIVE_EDGE_167_74088`.
Wcześniejsze warunki tej definicji nie odrzuciły wykonania. Gałąź 167 porównuje
dziesięć elementów profilu, manifestów, list funkcji i fingerprintów; strony
tego warunku nie zostały jeszcze rozdzielone. Nie ma podstaw do zmiany wzorców
certyfikatów ani ponownego ich zatwierdzania.
Cały katalog po diagnostyce jest bajtowo identyczny, role pozostały zgodne;
potwierdzono ROLLBACK, DROP przy 0 klientach i oba zamknięcia.
Receipt 100528 B SHA `6b36adb3b8392ba4951867b29ecf7a3991f294e9180de42a31b55572cccb00a6`
w `local-builds/full-base-preview-20261017/order-split210-history-operative-diagnostic21-prepared-1792313300210/run/`.
Bez COMMIT, Native i aktywacji. Najpierw porównać dostępne źródła i snapshoty
certyfikatów; dopiero brak rozstrzygającego dowodu uzasadnia dalszy pomiar.

**C20 — own-wave odmawia w kontroli historii realizacji.**
Oryginalny46702 EXIT0 diagnostycznie,124,33s. Uwierzytelniono świeże24 pola
own-wave ze źródłowym209; nie zmienia go Source21. Istniejący anonimowy probe
w7025,057ms przy8s wskazał `SOURCE22_WAVE_TERMINAL_OPERATIVE`: wcześniejsze33
warunki i nested172 przeszły, następnie kontrola historii realizacji zwróciła false.
To bramka metadanych migracji, bez dowodu błędu fizycznych operacji magazynowych.
SAVEPOINT przywrócono i zwolniono przed pełnym odczytem. Całe katalogi przed/po
są bajtowo identyczne:6335312B gzip `f9f5b2c089d3360940b4a272cab3225c0d93e4c15f251200d023eafb11af2dad`;
40995 rekordów,28 certyfikatów, trzy manifesty i role bez zmian. ROLLBACK,
normalny DROP0 i oba zamknięcia potwierdzone. Receipt100425B SHA
`a294ba6d03bd3b475cce090d79ad98430a8a91c7e436f4cbcfdfe71ef941757e`
w `local-builds/full-base-preview-20261017/order-split210-wave-compiler-diagnostic20-prepared-1792312500210/run/`.
Bez COMMIT, Native i aktywacji. Następny krok: pierwsza odmowa bieżącej,
źródłowo wyprowadzonej definicji historii Source21, zamiast zgadywania poprawki.

**C19 — odmowa187 pochodzi z kontroli kompletacji magazynowej.**
Oryginalny proces45925 zakończył się EXIT0 po126,38s w trybie diagnostycznym.
Jedyny marker `SOURCE210_187_EDGE_374_1532980_WAVE_FALSE` odczytuje już obliczone
`wave_ok`; nie dodaje wywołania ani nie zmienia warunku. Źródło187 i wszystkie24
pola uwierzytelniono; anonimowy blok zachowuje limit8s. Pełny493/20 inverse,
cały katalog po diagnostyce,28 certyfikatów, trzy manifesty i role są zgodne.
Potwierdzono ROLLBACK, normalny DROP przy0 klientach i zamknięcie obu klientów.
Receipt100493B SHA `86a8f17458b43145af6db0ca282a699a0438cb2e8934b4e202522d57456fb790`
w `local-builds/full-base-preview-20261017/order-split210-ordinary187-compiler-diagnostic19-prepared-1792312300210/run/`.
Root review2438B SHA `ceb2b58a1e4e84b4bde16f66f5468cb82fd6ef91988d8c27fb2e53c39646b49c`
potwierdza również health200 Main/APP16 na zachowanych rewizjach.
To lokalizacja odmowy, bez COMMIT, Native lub aktywacji podziału. Następny krok:
istniejący źródłowo zgodny probe own-wave, rozróżniający nested172 i historię
realizacji bez dodatkowych wywołań zależności. C18 pozostaje nieudanym odbiorem.

**C18 — Source21 porównany wPostgreSQL, nadal bez odbioru Native.**
Oryginalny91490 EXIT1,116,18s. Pełny493/20 inverse40502 PASS zcanonical
`10e79173b664e4eb1856e66af1e92ec2620d274edeb5332e53f4b1d11bb388c0`,
serializacja64011475B `b3300ea8ae4933715ef1bdd7d36318b7908a56db321cbef01d2845ecfa10fcf3`.
Seal513 i28 starych certyfikatów zachowano. Własne210/209/buyer/return-credit TRUE.
Kolejne187 zwróciło false7931,547834ms przy8s, bez57014 i bez stosu SQLerror;
to wynik logiczny odmowy, nie dowód poprawy wydajności. Duże173/cold4/COMMIT/
Native26 nieosiągnięte. Wcześniejsze TRUE187/173 wprefiksie oznacza wyłącznieparent209.
ROLLBACK, normalny DROP0, oba zamknięcia i identyczne role PASS. Main/APP16
po próbie HTTP200 na tych samych rewizjach. Receipt97619B SHA
`dd5bace708716bdeb493c3fb1382ea359233a5c8cadac12c4d1e0fad1229b3fa`,
Root review2425B SHA `f00dbe7f4642b35f06938169eff7f84f2631155c38da051788baf05eefb97279`.
Dowody: `local-builds/full-base-preview-20261017/order-split210-sealed-compiler18-prepared-1792312100210/run/`.
Niezależne SOURCE-only porównanie sześciu pełnych definicji rodzin ze starymi
ramionami CASE i fallbackiem209 jest zgodne (raport3913B/b810c99b… wfolderzeC18).
Nie lokalizuje to pierwszej odmowy187 i nie zastępuje PostgreSQL.
Root zestaw instalatora:49PASS/25SKIP/0FAIL,74 testy,66901,066ms; log
`/tmp/dyna-source21-install-focused.log` zachowany również wfolderzeC18.
Pominięte testy wymagają rzeczywistego Native. Publiczny zasób/migrator210 nadal
nie został aktywowany. Historyczne C17 i jego timeout pozostają bez zmian.

**PROBE14 i VECTOR21 — niezależne oczekiwania Source21.**
PROBE14 oryginalny14731 EXIT0:47 pól,84 piny, role/członkostwa bez zmian,
ROLLBACK/nieobecny schemat/zamknięty klient. Receipt1780B SHA
`def3cbc39478e774768de9f23c1ff65bd4760440ab6886f574a0e3688645137d`,
basis9078B `19ee35f63f36fe61a63efa559bf6882c9fa7e8897b7501f58475f80d7ce20ef9`,
canonical47 `bafdc6f67731e2ffafd0faf52971231acccfbd3c8c1c8f9f52f8957412894ff6`.
Folder:`root-source210-closure21-expression-probe14-prepared-1792311800210`.
VECTOR21 oryginalny51809 EXIT0:106 referencji,493+20/0 oczekujących pól,
0PG/0sieci. Gzip301156B SHA
`aebab8c9b0f280f16d79bfb43e79ea47558fa6d6e2c100be0f148b92dcbfb870`,
canonical `8968b09d2f775e831e388b78dee18d2e9e9ec1db52fb6149565785a8d25cc300`,
result918B `76fba9a5535c788b4c2afded01155198e82d872b2e54bd12e35df1455505c133`.
Folder:`order-split210-source-expectation-closure21-prepared-1792311900210`.
Oba foldery pod `local-builds/full-base-preview-20261017`; brak targetadoption.


**Split210 — Source21 usuwa powtarzane projekcje w20 wywołaniach historii.**
Kandydat `d6fa6a3d7cf6fbeb0333e2e16d8d59a28cf87249151293a533fab28ef597c951`
ma4674391B; liczby20 zmian/25 etapów/47 deklaracji/493 dodatków pozostają te same.
Sześć portów operative, sześć buyer iosiem startup korzysta z istniejącej rodziny
partial204. Dla objętego folda to jedna świeża walidacja zamiast pięciu; agregacja
nadal waliduje każdy objęty wiersz. Trzy dodatkowe warunki NULL i odmowę55000
zachowano wyłącznie dla źródłowo potwierdzonego przecięcia czterech funkcji.
Nagłówki, ACL, przeciążenia, fallback i cytowana historia pozostają chronione.
Koordynator:115/115 testów źródłowych PASS,0SKIP w15024,478ms. Dane3863093B
pozostają wlimicie4MiB. **Bez pomiaru poprawy czasu, nowego Native lub aktywacji**;
historyczna odmowa C17 przy8s pozostaje ważna.


**C17 — rzeczywista pełna kompilacja Source20 zakończona odmową czasu.**
Oryginalny4074 EXIT1, około114,44s. Pełne493/20 porównanie i inverse40502
PASS: canonical `10e79173b664e4eb1856e66af1e92ec2620d274edeb5332e53f4b1d11bb388c0`,
serializacja64011475B `b3300ea8ae4933715ef1bdd7d36318b7908a56db321cbef01d2845ecfa10fcf3`.
Seal513 wykonany;28 starych certyfikatów zachowano. Własne210/209/buyer/return-credit
TRUE; następny `ordinary187_valid()`57014 po8002,536ms przy8s, bez wyniku logicznego.
Stos:187:373→wave209:541→history_operative209:126→partial204:2457→
209 predecessor_definition:3→210 try_function_projection:6→require→valid:15.
Miejsce przerwania nie dowodzi, że sama końcowa instrukcja zużyła cały budżet.
Nie osiągnięto dużego173, cold4, COMMIT ani Native26 dla Source20.
ROLLBACK, normalny DROP przy0 klientach, oba zamknięcia i role bez zmian PASS.
Parent209 miał wcześniejsze udane187/173 przed210; nie nadaje to odbioru Source20.
Receipt98519B SHA `67d36869b79abe53a9a4632dc1172f7fadf38f88469aabdefb10dd4412a1a42b`.
Root review3031B SHA `5a70a61b412368ac96daaa7acb2686f90b2594beb2444907e78d6554f29fc51f`.
Dowody: `local-builds/full-base-preview-20261017/order-split210-sealed-compiler17-prepared-1792311500210/run/`.
Root potwierdził również48 PASS/25 SKIP/0 FAIL w zestawie instalatora (73 testy,
64530,502ms); pominięte testy wymagają rzeczywistego Native. Log:
`/tmp/dyna-source20-install-focused.log`. To osobny dowód plikowy, bez akceptacji.
Prywatne propozycje emission/migration/startup20 pozostają bez aktywacji;
migration20 nadal nie ma emitowanego bindera. Następny krok: ograniczona
źródłowo diagnostyka kosztu ścieżki, bez podnoszenia bramki8s.


**Source20 — rzeczywisty PROBE13 i VECTOR20, nadal bez pełnej kompilacji.**
Koordynator uruchomił PROBE13 raz (oryginalny74361 EXIT0). Sonda wykonała
źródłowe deklaracje8 tabel po usunięciu18 FK, odczytała44 CHECK i3 generated,
sprawdziła84 piny, role i członkostwa, ROLLBACK, nieobecność schematu i zamknięcie
klienta. Receipt `5c0376f0546761f13d230ffd8306977c64f1487bc5a869c302f5726caea8e19b`,
basis `1091b8cb27868081f917af0e06361e37cc188eed421423930b5d790c9be14561`,
canonical47 `470f0a5bc7d785b042e097583246f37db23e841565c1d6037ece6497d3aab72c`.
Dowody: `local-builds/full-base-preview-20261017/root-source210-closure20-expression-probe13-prepared-1792311200210/`.
Następny file-only VECTOR20 (oryginalny54064 EXIT0) wyprowadził493 dodatki i20
zmian wyłącznie ze źródeł i tych47 pól. Sprawdzono106 referencji;0 pól oczekujących,
0 zapytań PG i sieci. Gzip300819B SHA `f8704ea5f0f39df36bad8fabaef92949c62cfe93af020a4684c62bd7bdcf7bb6`,
canonical `f796f8927861525144a0ec20b373d387d3c42ab5b0b958d6b21cc24fe8fba630`,
result918B SHA `1bcf56e6e38990de45eed86881b140e830daa77f0cdcc46d89821125104b76f4`.
Dowody: `local-builds/full-base-preview-20261017/order-split210-source-expectation-closure20-prepared-1792311300210/`.
To niezależna podstawa oczekiwań, **bez pełnego target catalogue/inverse, wykonania
seal, Native26, aktywacji lub odbioru biznesowego**. Odmowy C15/C16 i ich dowody
pozostają literalne; nie zastępuje ich wynik źródłowy.


**Split210 — Source20 połączony źródłowo, bez nowego odbioru Native.**
Domknięto cztery dodatkowe kontrole: historię realizacji, kupującego, startu
oraz ordinary181 financial. Kandydat `442556de0fb012ac9d63a464b1bfca1b4fa37483a32c8250993acc7a9310e5b8`
ma4673025B,25 etapów i20 dokładnych zastąpień. Pełne nagłówki/ACL i historyczny
producent17 pozostają chronione. Kompaktowe reprezentacje PIM zachowują pełne
porównania; immutable DATA3862613B mieści się w4194304B bez podnoszenia limitu.
Koordynator wykonał110/110 testów źródłowych PASS,0FAIL/0SKIP w15988,928ms.
To dowód kodu; pełna kompilacja493/20, seal513, Native26 i podział przez
UI/API/WMS nadal wymagają odbioru. Main i APP16 zachowują wcześniejsze rewizje.


## C16 — rzeczywista diagnostyka wskazała warunek fali kompletacji

Oryginalny26507 zakończył się EXIT0 **diagnostycznie**. Zainstalowane
`ordinary187_valid()` ma dokładnie źródłowe1534118B/caa1f4b… i pełne24 pola
0065a76b… . Anonimowy DO z pierwotnym limitem8s zachował całe ciało i lokalne
zmienne; odwrócenie113 edycji odtwarza źródło. Jedyny stały NOTICE:
`SOURCE210_187_EDGE_374_1532980`.

To pierwszy wykonany warunek odmowy, w linii374: porównanie SHA poprzednika
`wave_print177_valid()` **lub** `wave_ok IS DISTINCT FROM true`, gdzie wave_ok
pochodzi z `order_merge_delivery209_wave_valid(manual_basis)`. Nie zmierzono
osobno dwóch stron tego OR; wynik nie uprawnia do przypisania odmowy jednej
z nich. Źródłowy przegląd aktywnych helperów historii/uruchomienia wykazał
nieobsłużone porównania SHA i nowe triggery; ich następcy pozostają WIP.

Po DO cały katalog i dosłowna serializacja,28 tabel kontrolnych, trzej rodzice,
role, własne210/209 i wszystkie piny pozostały zgodne. Transakcja była zdrowa;
ROLLBACK, normalny DROP przy0 klientach i oba zamknięcia potwierdzone. Brak
COMMIT/Native/aktywacji. [Receipt C16](../../../../local-builds/full-base-preview-20261017/order-split210-ordinary187-compiler-diagnostic16-prepared-1792310500210/run/receipt.private.json),
SHA256 `a2778b48f3893f2b2fca8f0b7de12cffc8eedf2179156a9096f091a7e081fd1a`,93158B.

## C15 — financial/return-credit PASS; zbiorcza kontrola187 nadal false

Oryginalny proces65934 zakończył się EXIT1 po około118,01s. Całe493 dodatki
oraz16 pełnych BEFORE/AFTER zgadzają się ze źródłem. Pełny inverse przywraca
40502 rekordy, canonical10e79173… oraz dosłowne64011475B JSON/b3300ea8… .
Seal509 wykonano z niezależnych źródłowych oczekiwań; rodzice i28 historycznych
tabel kontrolnych pozostały niezmienione do tego punktu.

Przy niezmienionym limicie8s prawdziwe są: własne210 (32,735ms),209
(58,721ms), buyer (3554,778ms) oraz return-credit206 (3165,245ms).
To rzeczywisty postęp względem C11: odmowa return-credit nie występuje wC15.
Następny `ordinary187_valid()` zwrócił **false** po6676,875ms, bez timeoutu.
Nie osiągnięto large-import173, cold4, COMMIT ani Native26.

ROLLBACK, normalny DROP przy0 klientach oraz zamknięcie obu klientów
potwierdzono. Main/APP16 pozostają bez przełączenia. [Receipt C15](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler15-prepared-1792310100210/run/receipt.private.json),
SHA256 `9666b79cd289c4e1c08fb63720bfb024c9de205c28aa61bc56dafa32c8037d05`,90295B.

Osobno koordynator wykonał testy katalogu/kodeka/template/emitter/seal i
wyłączonego domyślnie Native:44 PASS/25 SKIP/0 FAIL,45768,472ms. Te25 SKIP
nie stanowią odbioru Native. Źródłowy binder16/509 f7180994… został faktycznie
wygenerowany prywatnie i importuje tylko3 moduły builtin. Pozostaje bez aktywacji;
publiczny SQL210 i runtime migracji nie zostały promowane.

## Financial16 — źródłowy następca przed odbiorem Native

Lokalny commit `0cd97e9` dodaje szesnastą, źródłowo wyprowadzoną zmianę:
`financial_return_upgrade_valid()`. Osiem dokładnych edycji zachowuje całe
nagłówki/ACL, trzy surowe CASE i pierwotną normalizację własnego ciała.
Osobne źródło204 zamyka projekcję do189 i tożsamość169. Pięć wczesnych
projekcji jest jawnie oddzielonych od czterech funkcji biznesowych; producent17
oraz mapa warstwy11 pozostają bez zmian. Duże ciągi metadanych korzystają
z już związanych pełnych deskryptorów, bez zwiększania limitu4MiB DATA.

Kandydat `69b366874e24053852339bd192762f7878c9c2bb57a9f2b0beabd3af3ed216fe`,
4639523B, ma21 etapów/16 zmian/27 nowych funkcji/8 tabel. DATA4129919B mieści
się w dotychczasowym4194304B. Rzeczywisty zestaw źródłowy: **65/65 PASS, zero
FAIL/SKIP**,11198,400875ms. To testy źródeł, nie odbiór Native lub produktu.

PROBE12 wykonał niezależnie44 CHECK i3 wyrażenia generowane w osobnym
transakcyjnym schemacie PG04. Dokładne47 pól, role, członkostwa i77 źródeł
zgodne; ROLLBACK, nieobecność schematu oraz zamknięcie klienta potwierdzone.
[Receipt PROBE12](../../../../local-builds/full-base-preview-20261017/root-source210-financial16-expression-probe12-1792309827308/receipt.private.json),
SHA256 `7ed658b3fc26f92e4b52f8986ada3c0a0b90933f4d29f92bf99a7b5d71f434a7`.
[Podsumowanie testów](../../../../local-builds/full-base-preview-20261017/root-source210-financial16-expression-probe12-1792309827308/source-focused-summary.private.json),
SHA256 `89fca8dfbd60f4f7e7e71b1d8eeb4701a4d728f8e731fa83da37ccd7c8916c29`.

**Pełna kompilacja493/16, seal509, Native26, uruchomienie i rzeczywisty split
UI/API/WMS pozostają do wykonania.** Historyczne odmowy C11–C13 zachowują swój
zakres; powyższe źródła i47 pól nie zastępują tych odbiorów. Main/APP16 nie
zostały przełączone.


## C13 — diagnostyka odmówiła zbyt starego wzorca funkcji B2B

Operator86973 zakończył się EXIT1 po około106,07s. Ponownie potwierdził
false w ósmej klauzuli208. Ciało strażnika188 jest zgodne ze źródłem, lecz
`b2b_credit_upgrade_valid()` nie odpowiada pierwotnej definicji160.
Sprawdzenie dokładnej zgodności źródła zatrzymało diagnostykę **przed wszystkimi
zapytaniami zagnieżdżonymi**. Ten wynik nie jest nową odmową procesu biznesowego:
wskazuje błędny, zbyt stary wzorzec w narzędziu diagnostycznym.

Przegląd migracji wykazał późniejsze zastąpienie tej funkcji w161:86,
wywołujące `credit_source_upgrade_valid()` przy obecnym161. Ten strażnik
z kolei ma następcę162 delegującego do kontroli financial return. Dalsze
porównania muszą wynikać z aktualnej sukcesji źródłowej; nie wolno przyjąć
odczytanego ciała jako nowego oczekiwania ani usunąć bramki zgodności źródeł.

ROLLBACK, normalny DROP przy0 klientach i oba zamknięcia potwierdzone.
Brak COMMIT, Native, aktywacji oraz odbioru poprawki narzędzia.
[Receipt C13](../../../../local-builds/full-base-preview-20261017/order-split210-credit188-diagnostic13-prepared-1792309400210/run/receipt.private.json),
SHA256 `0508fe2649473023a8f2644e6c7205349a17343cb9aef9e482f6f72d8b4540bf`,91400B.

Osobny rzeczywisty odczyt **plikowy** aktualnego139e przez aplikacyjny projektor
usunął493 dodatki i przywrócił15 funkcji: wszystkie40502 rekordy oraz pełne
64011475B JSON/b3300ea8… są dosłownie równe rodzicowi209. Proces60555 EXIT0,
wynik `a4292fb48bc59b41d176f727cce4682b981f886f5b5d31b7e6f4eff958a2b3ca`.
Dodatkowo13 surowych SELECT audytu magazynu przeszło EXPLAIN bez ANALYZE na
istniejącym PG03/schemat209; rollback/end ACK potwierdzone. Dowód
`c2b19a02471efdc26c6c6b8b2cfe613198209e7694431316ed599ff4147f8c6b`
nie obejmuje danych wynikowych ani fizycznego wykonania splitu.

## C12 — odmowa zagnieżdżonej kontroli rozliczeń konsumenckich

Oryginalny16019 zakończył się EXIT0 w trybie wyłącznie diagnostycznym.
Zainstalowane ciało `return_credit206_guards()` było dokładnie zgodne z literalnym
źródłem208 (2180B, SHA256 `0b1084ebe78ef68eecc0926ace14d07e8d3e1bee6d62c41acbd172dce3f6cf14`).
Bez podmiany funkcji sprawdzono osobnymi SELECT z limitem8s cztery warunki
strukturalne i kolejne składniki końcowego RETURN.

Cztery warunki strukturalne nie odmawiają. Pierwsze siedem składników RETURN
ma wartość true, w tym oba fingerprinty206/208 oraz niezmienione manifesty
rodziców. Ósmy, `public.local_consumer_credit_guards()`, zwrócił false
w538,281ms. Dziewiątego świadomie nie wykonano. Jest to pierwsza fałszywa
klauzula w sprawdzonej kolejności tekstu, bez twierdzenia o kolejności wykonania
oryginalnego wyrażenia AND przez PostgreSQL.

Pełny katalog po diagnostyce,28 starych tabel kontrolnych, manifesty209/166/210,
role i piny źródeł pozostały zgodne. Potwierdzono ROLLBACK, normalny DROP
przy0 klientach i oba zamknięcia. Nie wykonano COMMIT, Native ani aktywacji.

[Receipt C12](../../../../local-builds/full-base-preview-20261017/order-split210-return-credit-diagnostic12-prepared-1792309300210/run/receipt.private.json),
SHA256 `16fd017b65a00d1256c0c5e83d50ce589bcb37b9eb71d65310963ceb95f2ec2c`,93152B.

## C11 — pełny inverse i buyer PASS; odmowa kontroli korekt zwrotów

Oryginalny operator23157 zakończył się EXIT1 po około98,13s. Poprawiona
funkcja snapshotu zainstalowała się poprawnie. Całe493 dodatki i15 pełnych zmian
są zgodne z niezależnym oczekiwaniem źródłowym; inverse odtwarza wszystkie40502
rekordy rodzica209, canonical `10e79173…` oraz pełną serializację `b3300ea8…`.
Źródłowy seal508 rekordów został wykonany po zachowaniu28 tabel kontrolnych.

Przy niezmienionym limicie8s osobne kontrole zwróciły true:

- `order_split210_valid()`:29,751ms;
- `order_merge_delivery209_valid()`:54,408ms;
- `buyer_address_guards()`:3161,958ms.

To pojedyncze rzeczywiste pomiary, bez deklaracji p95 lub odbioru pozostałych
kontroli. Następny `return_credit206_guards()` zwrócił **false** po400,301ms.
Nie osiągnięto pełnych187/173, cold4, COMMIT ani26 testów Native.
Potwierdzono ROLLBACK, normalny DROP własnej bazy przy0 klientach i zamknięcie
obu klientów. Main i APP16 pozostają bez przełączenia.

[Receipt C11](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler11-prepared-1792309100210/run/receipt.private.json),
SHA256 `55ceda14bbff377a63f45258bced467a88b2c376bece84a52193e24781ea4ec6`,88228B.

Prywatne propozycje zasobów v3, startup/cold inverse, migratora i fizycznego
odbioru magazynu są przygotowane. Testy zasobów wykonały rzeczywisty zapis,
walidację i odczyt syntetycznych pakietów (10PASS), migrator ma8 kontroli
syntetycznego klienta, audyt fizyczny5 testów syntetycznych. Żadna z tych
propozycji nie została aktywowana w aplikacji i nie zastępuje Native lub UI/API.
Następny krok to odczytowe zlokalizowanie odmowy strażnika208 przy tym samym8s.

## C10 — odmowa składni snapshotu, poprawka nazwy nadal przed Native

Oryginalny operator84585 zakończył się EXIT1 po około90,04s. Rodzic209
przeszedł swoje kontrole, lecz zastąpienie funkcji
`order_merge_delivery209_validation_snapshot()` zostało odrzucone przez PostgreSQL:
SQLSTATE `42702`, `column reference "key" is ambiguous`.
Nowa kolumna `key` w dołączonej mapie kolidowała z niekwalifikowanym odczytem
`key` w zachowanym zapytaniu historycznym. Nie osiągnięto pełnego porównania
493/15 ani inverse kandydata210, jego seal, COMMIT lub26 testów Native.
ROLLBACK, normalny DROP przy0 klientach i zamknięcie obu klientów potwierdzono.
Main i APP16 pozostają bez przełączenia.

[Receipt C10](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler10-prepared-1792308200210/run/receipt.private.json),
SHA256 `93757838b39849cdda0767ea40840649c924e07c32fcf061409e3047cfe17fe8`,79079B.

Minimalna poprawka zmienia wyłącznie nazwę kolumny mapy i odwołanie w JOIN
na `split210_key`; całe pierwotne zapytanie i porównanie pełnych rekordów pozostają
bez zmian. Zestaw źródłowy obejmujący buyer, closure, layer, source i oracle:
52/52 PASS,0 SKIP. Niezależny PROBE11 odczytał44 CHECK i3 wyrażenia generowane
z ośmiu tabel; potwierdzono rollback, brak schematu po nim, niezmienione role
i zamknięcie klienta. To dowód47 pól źródłowych, nie kompilacja całego210.

Historyczny kandydat źródłowy tego etapu ma3568271B, SHA256
`139e2da7a404202ba7398f9c25040c675ed6dd26caecbedd24ef0069c13376f5`.
VECTOR18 jest opublikowanym oczekiwaniem źródłowym493/15 z zerem brakujących
pól; nie nadaje odbioru instalacji, Native, API ani UI. Przygotowanie pakietu v3,
normalizacji startu i migratora pozostaje oddzielne od ich uruchomienia.

## C09 — zlokalizowana różnica finansowa, bez odbioru Native

Oryginalny operator80063 zakończył się EXIT0 po około109,77s. Jedyny anonimowy
DO diagnostyczny zakończył się po10272,9445ms etykietą `BUYER210_8_FALSE`:
porównanie MD5 odtworzonych metadanych rodziny160 z jej fingerprintem.
Rodziny158 i159 zakończyły swoje odtworzenie; ich zapytania trwały odpowiednio
219,242ms i369,974ms. Zapytanie160 trwało2091,143ms, ale końca tej rodziny
nie osiągnięto. Te liczby opisują diagnostykę, nie przejście bramki8s.

Dodatkowy przegląd źródła wskazał konkretny błąd: mapa `manual169` dla
`fa3_draft_fingerprint()` i `b2b_invoice_fingerprint()` używa definicji204,
podczas gdy oryginalny helper169 deleguje te funkcje do definicji158/159.
To źródłowo potwierdzona rozbieżność; poprawka i jej odbiór pozostają osobne.

Liczniki funkcji pokazują336 wywołań `order_split210_require()` oraz pięć
snapshotów209. Są to liczniki transakcyjne i zagnieżdżone czasy; nie sumować
czasów rodzica i wywoływanych funkcji ani nie traktować ich jako izolowanego
benchmarku biznesowego. Sesyjne `track_functions` przywrócono z `all` do
pierwotnego `none`. Zainstalowanej funkcji buyer nie podmieniano.

Pełne493 dodatki i15 zmian, inverse40502 rekordów oraz pełna serializacja
rodzica przeszły ponownie. Odczyt po diagnostyce zachował cały katalog,
28 wcześniejszych tabel kontrolnych, oba manifesty rodziców i role.
ROLLBACK, normalny DROP przy0 klientach i oba zamknięcia potwierdzono.
Nie było COMMIT, Native26, aktywacji ani biznesowego splitu. Limit120s
obejmował tylko jednorazowy pomiar; odmowa C08 przy8s pozostaje ważna.

[Receipt C09](../../../../local-builds/full-base-preview-20261017/order-split210-buyer-diagnostic09-prepared-1792307800210/run/receipt.private.json),
SHA256 `c8aeec08ab18385d6eaa86f098027282bdfa1ba7a763f463870e6fe73e6dee0f`.

**Wcześniejsza rzeczywista próba C08: EXIT1 po około104,54s, bez odbioru Native.**
Oryginalny90826 wykonał199 etapów rodzica i20 etapów kandydata
`c257bd5c…` / 3553973B. Pełne493 dodatki i15 zmian są zgodne ze źródłowym
oczekiwaniem; cały inverse ponownie odtworzył40502 rekordy, canonical SHA
`10e79173…` oraz pełne64011475B serializacji o SHA `b3300ea8…`.
Zachowano28 dawnych tabel kontrolnych i manifest209.

Własne210/209 zwróciły true w29,067/1579,019ms. Następny buyer ponownie
zakończył się **57014 po8002,478ms przy niezmienionym8s**. Tym razem stos to
`order_split210_valid` linia10 → `order_split210_require` linia1 →
`order_split210_try_function_projection` linia6 →
`order_merge_delivery209_predecessor_source` linia3 →
`partial_sale204_predecessor_definition` linia65 → buyer linia44.
Zmiana stosu nie jest dowodem spełnienia budżetu ani pełnego przyspieszenia.
Brak COMMIT, Native26, aktywacji aplikacji i odbioru biznesowego splitu.
ROLLBACK, normalny DROP przy0 klientach i oba zamknięcia potwierdzono;
APP16/Main bez przełączenia.

[Receipt C08](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler08-prepared-1792307600210/run/receipt.private.json),
SHA256 `ac9d11a09e637b2c28248c66d8bdcdd98a6c71fa6c039e951576c1a734a24d6b`.
Niezależnie sprawdzono zdarzenia1292–1301 oraz piny/bajty programu,15 oczekiwanych
funkcji, delty, archiwum starych certyfikatów, pieczęci i obu skompresowanych
katalogów. Przegląd był plikowy, bez ponownego PostgreSQL i pełnej dekompresji.

**Historyczna rzeczywista próba C07: EXIT1 po około104,29s, przed COMMIT i NativeQA.**
Oryginalny operator45115 wykonał199 etapów rodzica i20 etapów kandydata
`b3df2079…` / 3543023B, obejmującego także piętnastą zmianę buyer-address.
Wszystkie pola493 dodatków i15 pełnych BEFORE/AFTER są zgodne ze źródłowym
oczekiwaniem; cały inverse odtworzył40502 rekordy rodzica, canonical SHA
`10e79173b664e4eb1856e66af1e92ec2620d274edeb5332e53f4b1d11bb388c0`
oraz pełne64011475B serializacji o SHA
`b3300ea8ae4933715ef1bdd7d36318b7908a56db321cbef01d2845ecfa10fcf3`.
Zachowano28 dawnych tabel kontrolnych i manifest209.

Po źródłowo ustalonej pieczęci `order_split210_valid()` zwrócił true w29,776ms,
a `order_merge_delivery209_valid()` true w1575,196ms. Następny
`buyer_address_guards()` zakończył się **57014 po8002,452ms przy limicie8s**.
Stos prowadzi przez `order_split210_valid` linia15 → `order_split210_require`
linia1 → `order_split210_is_added_trigger` linia6 → buyer linia44.
To przekroczenie budżetu, nie wynik false ani udowodniona przyczyna całego kosztu.
Nie osiągnięto COMMIT ani26 testów Native. Brak aktywacji aplikacji i odbioru
biznesowego splitu; APP16/Main bez przełączenia. ROLLBACK, normalny DROP własnej
bazy przy0 klientach i zamknięcie obu połączeń potwierdzono.

[Receipt C07](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler07-prepared-1792307000210/run/receipt.private.json),
SHA256 `7708cef5e841f79ac6a2b7ea7917d0910e3ccc777d7e3573ca7db64ef0df6954`.
Niezależnie odczytano zdarzenia1292–1301 i sprawdzono bajty/piny programu,
15 oczekiwanych funkcji, pełnej delty, archiwum starych certyfikatów, pieczęci
oraz obu skompresowanych katalogów. Nie wykonano ponownego PostgreSQL ani
ponownej pełnej dekompresji katalogu podczas tego przeglądu.

**Diagnostyka06 zakończona EXIT0 — zlokalizowano odmowę, bez odbioru Native.**
Własne210/209 oraz bezpośredni204 zwróciły true. Anonimowy DO z instrumentacją
źródłowego ciała buyer-address wskazał `BUYER210_5_FALSE`: po czterech wcześniejszych
warunkach odmawia literalne porównanie SHA bieżącego `pg_proc.prosrc` trzech
funkcji `fa3_draft_fingerprint`, `b2b_invoice_fingerprint` i `b2b_credit_fingerprint`
z historycznymi SHA158/159/160. Wszystkie trzy rzeczywiste źródła są zmienione
przez210; osobny odczyt ich projekcji odtworzył dokładne oczekiwane historyczne SHA.
Nie podmieniono żadnej zainstalowanej funkcji i nie pominięto predykatu.

Buyer, return-credit206, manual-inventory, pełne187 i173 zwróciły false;
pełne187/173 zakończyły się w6110/6211ms przy8s, bez timeoutu. To lokalizacja
błędu kompozycji, nie potwierdzenie poprawki.493 dodatki i14 zmian ponownie
przeszły pełny inverse do40502 rekordów; stare certyfikaty, rodzice i role
zachowano. COMMIT i NativeQA nie wykonano; ROLLBACK, normalny DROP przy0 klientach
oraz oba zamknięcia potwierdzono. Split nadal pozostaje nieaktywny i nieodebrany.
[Receipt06](../../../../local-builds/full-base-preview-20261017/order-split210-buyer-diagnostic06-prepared-1792305200210/run/receipt.private.json),
SHA256 `2b76e237f64fff9c67db246454eb38241feae28e84e9352349b644cacfc749a2`.

**Historyczna rzeczywista próba05: EXIT1 przed COMMIT i NativeQA.**
Kompilator zainstalował w swojej transakcji źródłowo ustaloną pieczęć;
`order_split210_valid()` i `order_merge_delivery209_valid()` zwróciły true,
ale następne `buyer_address_guards()` zwróciło **false** w około3s przy
niezmienionym limicie8s. Nie osiągnięto kolejnych pełnych bramek ani26 testów
Native. To konkretna odmowa rodzica, a nie odbiór Native210 lub biznesowego splitu.

Pełne porównanie493 dodatków i14 zmian oraz inverse do40502 rekordów rodzica
pozostały zgodne: canonical SHA `10e79173…`, pełna serializacja64011475B
SHA `b3300ea8…`. Zachowano28 tabel kontrolnych. Nie wykonano COMMIT;
ROLLBACK, normalny DROP własnej bazy przy0 klientach i oba zamknięcia potwierdzono.
Działający APP16 i Main nie zostały przełączone; split przez API/Chrome pozostaje
nieodebrany. Historyczne pomyślne porównanie04 poniżej zachowuje swój zakres.

[Receipt05](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler05-prepared-1792305000210/run/receipt.private.json),
SHA256 `6a40344dc16b4b8e05978b584af5c5c55668e484d725dcc33348498828d96206`,
status `SOURCE_COMPILATION_FAILED_NO_REPLAY`.


## Pakiet lokalny — przed aktywacją

Pakiet16, manifest `691a7cb5e943e1474411906e9f5b9e69143761bf6e74676f6415dea4b41b7fac`,
ma 379 plików / 100610231B i **53065B** zapasu do limitu96MiB (100663296B).
Aliasy178/201/202 są już uwzględnione. Pozostało 15 fizycznych duplikatów;
poniższe dwie pary odczytano i potwierdzono ich pełną równość bajtów i SHA:

| Logiczny zasób → istniejący plik native | Native graph ID | Oszczędność | SHA256 obu plików |
|---|---|---:|---|
| `resources/server/177_picking_wave_print.sql` → `native/177_picking_wave_print.sql` | `wave177_predecessor` |185831B | `025d3bbf7d1cb0938366b5075b63ba348361755890f40282ff229932fb791e19` |
| `resources/server/182_cold_schema_runtime_admission.sql` → `native/182_cold_schema_runtime_admission.sql` | `ordinary182_cold_runtime_admission` |1447850B | `a95276dbdf02f00a50ca97c84a6aa242d493dbbfe50b085f60936e649a0bb7da` |

Logiczne ID: `sql:server/` plus nazwa pliku. W poniższym historycznym oszacowaniu 177 jest najmniejszym wystarczającym
pojedynczym aliasem; największy mniejszy duplikat ma 61995B.
Pomiar gzip9 wyłącznie w pamięci: kandydat `f78e7d47…` / 869737B → 64208B,
SHA `cf7be0b5bcf856e5943a979cbbc6d2a121a744cf218f57103f727706f5467f88`.
Literalny kandydat plus pieczęć05 / 602984B (`0edc9b04…`) → 1472721B raw / 126169B gzip,
SHA gzip `7f9ae385c2c0d7683f33d16c624c1568c42ff8d38b1255f2b13c03f545c18255`.
Ówczesny kontrakt14 i projektor zajmowały łącznie 86537B; nie jest to pomiar nowego kontraktu15. Odejmując je i ten gzip,
alias177 zostawia **26190B**, a alias182 **1288209B**, przed zmianami kodu,
manifestu i frontendu. Zalecany jest **182 dla rezerwy**, do potwierdzenia pełnym buildem.

Nowszy, niepodłączony generator szablonu instalacji dla `c257bd5c…` emituje
moduł36721B z gzip20288B i ograniczonym szablonem301982B. Moduł przyjmuje wyłącznie
zachowane dane rodziców;7 testów rzeczywistego importu/formatowania PASS nie
potwierdza ich rzeczywistego pobrania, instalacji lub Native. To osobny pomiar
reprezentacji, bez pełnego builder→installed-reader i nowego wydania.

**Oszacowanie reprezentacji nie jest odbiorem migracji ani pakietu.** Pieczęć05
jest związana z rodzicem tej próby; nie można przenieść jej do innej instalacji
z innymi zachowanymi danymi manifestu rodzica. Docelowe bajty instalatora wymagają
własnego odbioru źródłowego/Native i builder→installed-reader. Zachowujemy limity
16MiB na członka / 96MiB łącznie i wyłącznie jawne, przypięte aliasy;
przyszłe pełne wydanie nie zostało tu zbudowane ani odebrane.

**Rzeczywista kompilacja04: wykonano199 etapów rodzica i19 etapów210.**
Operator18176 zakończył się EXIT0 ze statusem `COMPILED_PENDING_SOURCE_ADDITION_REVIEW`.
Kandydat `f78e7d47…` skompilował się na osobnym PostgreSQL18.4/57084.
Sprawdzono wszystkie14 pełnych BEFORE przed pierwszym DDL210 i14 AFTER po nim;
po ich odwzorowaniu wszystkie40502 wcześniejsze rekordy pozostały literalne.
Przybyły493 rekordy ośmiu rodzajów, bez usunięć. Wszystkie28 dawnych tabel
kontrolnych oraz manifest209 zachowano. Manifest210 pozostał pusty.
Nie wykonano COMMIT ani NativeQA; ROLLBACK, normalny DROP własnej bazy przy0
klientach i oba zamknięcia połączeń potwierdzono.

Receipt: `local-builds/full-base-preview-20261017/order-split210-source-compiler04-prepared-1792303000004/run/receipt.private.json`,
SHA256 `4ce0a2fe99b3b3b2288817bec5b09d390cde5d413da08bd49df67240ce9d25f5`.
Pełna delta ma SHA256 `aeb861a5d26b05974a203919d16e37e5c0e32c9ba55f36772de9f40ab3c7c3a9`.
Niezależny przegląd potwierdził199+19 etapów i1279 zdarzeń; osobno sprawdzono
28 archiwów certyfikatów i ich rozpakowane bajty.

**Pełny przegląd źródłowy zakończony.** Operator6519 zakończył się EXIT0:
`PASS_SOURCE_COMPILATION_FULL_INVERSE_UNSEALED_NOT_NATIVE`. Wszystkie pola493
dodatków pochodzą z oracle433 oraz osobnego rzeczywistego testu44 CHECK i3 wyrażeń
generowanych. Kolejność ACL16 typów związano z niezależnym odczytem locale i
sortowaniem literalnych nazw uprawnień. Żadne pole katalogu docelowego nie stało
się źródłem oczekiwania. Pełne493 rekordy i14 zmian porównano bez rozbieżności.
Inverse odtworzył wszystkie40502 rekordy rodzica, canonical SHA `10e79173…`
oraz całe64011475B serializacji o SHA `b3300ea8…`. Ponownie sprawdzono28 tabel
kontrolnych,56 archiwów, role i zamknięcia kompilatora. Przed i po porównaniu
sprawdzono84 odwołania do83 różnych plików źródłowych. Testy kontrolne narzędzia:
11 PASS,0 FAIL/SKIP. Sam przegląd był plikowy, bez nowych wywołań PostgreSQL.

Wynik: `local-builds/full-base-preview-20261017/order-split210-full-source-review-prepared-1792303800210/review-result.private.json`,
SHA256 `06edf6069c4a01053dd96f5187068db2c77ee0a5d0e726595d95bb2baa6c3c24`.
Źródłowy wektor oczekiwań:56704B gzip, SHA256
`6da80aebbe62021b8c756387e751b7f8be15e6de4c432a40eb09ffdbdbda717d`.
Nie ma już otwartych pól tego porównania. Pieczęć, Native210, migracja oraz
podział przez zwykłe API/Chrome pozostają nieodebrane.

Wcześniejszy operator25957 zakończył się przed utworzeniem bazy: wymagana liczba
innych klientów0 wyniosła2 przez działający APP16. Nie wykonano DDL ani ponowienia.
Zachowano FAILED i literalną kontrolę0 klientów. Osobny runtime04 używa tych samych
sprawdzonych binariów i bibliotek; APP16/PG03 oraz Main pozostały działające.
Poniższy opis źródłowego kandydata dotyczy etapu poprzedzającego kompilację04.

**Bieżąca aktualizacja18.10 — kandydat przeniesiony na odebrany Source22b.**
Warstwa210 odczytuje pełny program209 o SHA `0e03d091…` i28449419B,
z zachowaniem literalnego rosteru17 wcześniejszych funkcji. Dziesięć wybranych
pełnych deskryptorów BEFORE porównano niezależnie z odebranym kontraktem22b;
Root potwierdził zgodność wszystkich pól, ciał, definicji i ACL.
Nowa kompozycja obejmuje14 zastępstw i19 etapów, 27 nowych funkcji i8 tabel.
Projekcja własnego209 dotyczy teraz `validation_snapshot`, a dodatkowy port
`predecessor_source_sha` zachowuje źródłowe hashe czterech zmienionych funkcji
biznesowych. Cały producent17 wcześniejszych funkcji pozostaje literalny.

Root wykonał28 testów źródłowych bez pominięć i pełne wyprowadzenie z rzeczywistych
bajtów rodzica. Kandydat ma869737B i SHA256
`f78e7d4757fc4956958eb71c5564ef313bcff860b233d4c2e01ec5c67fbf066b`.
Projekcja metadanych dopuszcza teraz ponowne podanie wyłącznie dokładnego,
źródłowo przypiętego BEFORE jako identity, po niezmienionej świeżej kontroli
wszystkich14 aktualnych AFTER i całego210. To poprawka odporności nowej warstwy;
nie wykazano rzeczywistego błędu podwójnego wywołania na działającym22b.
Kontrole zmieszanych pól, obcych nagłówków i dryfu bieżących funkcji nadal odmawiają.
Odczyt Root zapisano w `local-builds/full-base-preview-20261017/split210-source22b-root-review.private.json`.

Odebranie rodzica22b nie nadaje odbioru nowemu210. Historyczny opis tego etapu
poprzedza kompilację04 i pełny inverse opisane powyżej. Manifest210 pozostał pusty;
nie zarejestrowano migracji ani nie włączono funkcji w działającej aplikacji.
Następny wymagany krok to źródłowo ustalona pieczęć i rzeczywiste Native210,
a potem dodatnie scenariusze podziału przez API/Chrome z WMS OFF i ON.
Poniższe odniesienia do rodzica193 i13 zastępstw opisują wcześniejsze etapy.

**Aktualizacja18.10.2026 — składacz źródła i rzeczywisty test prywatnych ACL.**
`4be20ca` składa18 dokładnych etapów: core, terminal, DATA, porty,13 pełnych
następców i końcowe ACL. Każdy etap ma granice UTF8 i SHA. Brak INSERT manifestu,
rejestracji migracji i aktywacji. Rodzic nadal literal193, bez odbioru Native209.
Root10 testów składacza PASS; cały SQL210 nie został wykonany.

Niezależny review wykrył odziedziczone granty pozostające na funkcjach core.
Końcowa instrukcja obejmuje teraz dokładnie27 nowych typed identities,8 tabel
oraz ACL kolumn;13 historycznych funkcji nie znajduje się w jej zakresie.
Pierwsza mała próba nie utworzyła funkcji z powodu kolejności syntetycznych
typów tabel. Druga wykryła22023 dla zastępczej pustej tablicy ACL. Obie zostały
wycofane; generator i próbę poprawiono na bezpośrednie aclexplode(attacl).

Zakończona próba03 wykonała dokładną końcową instrukcję na uncommitted,
syntetycznych tabelach i ciałach funkcji w osobnym namespace. Odziedziczone
granty pg_monitor dla27 funkcji/8 tabel/2 kolumn spadły do0/0/0; wszystkie
pozostałe nonowner granty również do0. Niezwiązany ACL pozostał literalny,
role klastra bez zmian, ROLLBACK i nieobecność namespace potwierdzone,
klient zamknięty. [Receipt próby03](../../../../local-builds/full-base-preview-20261017/split210-acl-rollback-probe03-1792284207541/receipt.private.json)
(`77eb8c73…`) potwierdza wyłącznie prymityw ACL. Nie nadaje odbioru pełnego
SQL210, Native, producenta biznesowego ani UI/API splitu.

**Aktualizacja18.10.2026 — rzeczywisty kod portów domknięcia, bez pieczęci.**
`bcc7b6b` dodaje generator13 źródłowo wyprowadzonych zmian, prywatne porty
projekcji, niezależny fingerprint pełnych ośmiu rodzajów metadanych oraz
immutable DATA o rozmiarze543693B. Guard sprawdza pełne13 AFTER, zachowanie
literalnych danych manifestów209/166 i dokładny roster36 zewnętrznych
triggerów, w tym24 wewnętrznych RI. Nie wykonuje209_valid/fingerprint,
co zapobiega cyklowi autoryzacji. Przed inverse wymaga świeżej własnej kontroli.

Manifest210 pozostaje pusty; generator nie emituje jego INSERT ani zgody
na aktywację. Root potwierdził63 wspólne testy źródłowe closure/rosterów/
poprzedników oraz inverse/wrapper209, bez pominięć, i osobno8 testów końcowej
rewizji closure. Niezależny review źródła PASS. To nadal nie jest test parsera
PostgreSQL ani pełny odbiór Native210 lub biznesowego splitu.

Kandydat jest przypięty do dokładnego rodzica193, który nie ma pełnego odbioru
Native209. Po zmianie rodzica wymaga jawnego ponownego wyprowadzenia i review.
Pierwszy kompilator ma sprawdzić cały roster210, deparser, wszystkie13 BEFORE/
AFTER, pełny inverse i stare certyfikaty, następnie wycofać nieopieczętowany
kandydat. Dopiero osobna, sprawdzona pieczęć pozwala przejść do rzeczywistych
kontroli integralności i dodatniego scenariusza API/UI.

**Aktualizacja18.10.2026 — odmowa mieszanych obowiązków przed końcowym ogonem.**
Niezależny review wykazał, że pełny finalizer210 może czekać już po ostatnim
sprawdzeniu terminu sesji Mirakl, WZ lub korekty magazynowej. Samo przesunięcie
drainu nie rozwiązuje kompozycji. `3db244a` dodaje więc jawną granicę pierwszego
serwisu: po callbacku, przed dowolnym prepare/finalize, obie rzeczywiste ścieżki
tenantTx odmawiają409, gdy split dzieli transakcję z innym biznesowym obowiązkiem.
Stałe prywatne gettery sprawdzają12 rzeczywistych rejestrów, w tym claimed162,
buyer installations i OAuth jobPins. Samo availability i wspólne blokady
WMS/purchasing/catalog nie są obcym obowiązkiem. Gettery nie nadają zgody,
nie pytają DB i nie usuwają stanu.

Root46 testów kompozycji/managera/tras/transportu/rejestru PASS oraz typecheck.
Testy rzeczywistych lifecycle PIM, WMS, dispatch i Mirakl oraz kontrolowane
kształty pozostałych rejestrów są opisane osobno; nie stanowią odbioru Native.
Obie ścieżki testują odmowę przed przygotowaniem sąsiadów, seal, drain i COMMIT,
z zachowaniem obowiązku aż do rollbacku. Pełna kompozycja wielu operacji wymaga
dalszego wspólnego protokołu prepare/clock i pozostaje otwarta w nadrzędnym Goalu.
Pierwszy split nadal oczekuje kontraktu210, rzeczywistego PG oraz API/Chrome.

**Aktualizacja18.10.2026 — pełny roster FK/RI i ograniczony pomiar PG.**
`0da5766` wyprowadza ze źródła18 kluczy obcych i72 wewnętrzne triggery RI
(48 na własnych tabelach,24 na dawnych), w tym trzy dokładne skrócone nazwy
63-bajtowe. Definicje FK w helperze pozostają semantycznym AST, bez udawania
rzeczywistego deparsera. Root15 testów rosterów PASS.

Osobna rzeczywista próba PostgreSQL utworzyła sześć literalnych deklaracji
tabel210 z jawną zamianą namespace oraz cztery **syntetyczne, minimalne**
tabele referencyjne. Potwierdziła dokładne nazwy i komplet metadanych18 FK
oraz wszystkie72 rekordy RI. ROLLBACK, nieobecność własnego namespace oraz
zamknięcie klienta są potwierdzone w [wyniku próby](../../../../local-builds/full-base-preview-20261017/split210-fk-ri-rollback-probe-1792282102574/result.private.json)
(`f4b032d1…`). Nie uruchomiono całego SQL210, producenta, sukcesji starych
guardów ani pełnego kompilatora. To nie jest odbiór Native lub podziału.

**Aktualizacja18.10.2026 — rzeczywiste miejsca finalizacji w kodzie managera.**
Commity `efbc310`, `b8a9fca`, `78671ec` i `148d5c5` dodają request-bound
Native finalizer, trasy HTTP, rejestr jednej dokładnej operacji i jego spięcie
z rzeczywistymi ścieżkami zwykłej oraz durable transakcji. Rejestr wiąże ten sam
prywatnie przechwycony request, rodzaj i UUID zweryfikowanej zapisanej komendy;
nie przekazuje credentiala ani zgody przez pole requestu. Nowy wynik i replay
otrzymują obowiązek dopiero po pełnej projekcji wyniku i ponownej kontroli IAM.

Zwykły manager opróżnia publiczne ograniczenia po wszystkich sąsiadujących
finalizerach i wywołuje końcową kontrolę bezpośrednio przed COMMIT. Durable
manager robi to dopiero po rzeczywistym `ordinary187_seal`, pod właścicielem
opróżnia też dokładne `ordinary187_private.ordinary187_context_final`, przywraca
rolę i wywołuje ten sam fixed finalizer. Rejestr pozostaje żywy przez wewnętrzne
cleanup callbacka; znika dopiero po zakończeniu zewnętrznego managera, przed
oddaniem połączenia. Błędy i utrata ACK zachowują dotychczasowe rollback/taint,
bez automatycznego ponawiania zapisu.

Finalizer SQL jest osobnym nieaktywnym plikiem
[`order-split210-terminal.sql`](../../tools/parity/order-split210-terminal.sql).
Nową komendę sprawdza względem jej rzeczywistego root/start i pełnej podstawy;
historyczny replay wiąże z obowiązkiem i credentialem bieżącego requestu.
Po końcowym odczycie IAM/zegara kod JS wykonuje tylko odtworzenie roli/tenanta
i kontrolę frame, bez dalszych odczytów danych biznesowych.

Root potwierdził41 testów transportu/rejestru/projekcji/tras oraz osobno37
testów obejmujących osiem scenariuszy actual manager bodies i typecheck.
Kontrolowane porty testują prawdziwe ciała managerów i prawdziwy rejestr,
transport oraz drain; **nie dowodzą rzeczywistego lease, wykonania SQL ani
COMMIT w PostgreSQL**. Trasy nadal nie są zamontowane, domyślne POST odmawiają503,
brakuje zamkniętego kontraktu katalogu210 i pełnego odbioru Native/API/Chrome.
Nie aktywowano210 w Main ani podglądzie. Poniższy opis kandydata pozostaje
przydatny, a jego przyszłe porty wymagają teraz odbioru powyższej integracji.

Stan: `SOURCE_AUTHORED_NOT_SQL_RUN`. Plik
[`tools/parity/order-split210-business.sql`](../../tools/parity/order-split210-business.sql)
nie jest migracją zarejestrowaną w aplikacji. Nie instalowano go na żadnej bazie,
nie uruchamiano kompilatora źródłowego ani fabryki. Nie ma zatwierdzonego
kontraktu katalogu210, odwrotnej projekcji, odbioru Native, API ani UI.
Wszystkie funkcje i tabele pozostają pozbawione uprawnień `PUBLIC,dyna_app`;
końcowy REVOKE obejmuje cały własny namespace. Sam plik nie nadaje uprawnienia
do uruchomienia funkcji zapisu w aplikacji.

## Zaimplementowany kod kandydata

- Własne `previews`, `source_rows`, `executions`, `targets`, `allocations` i
  `replay_duties`: FORCE RLS, polityka właściciela, FK, unikalność kluczy,
  niezmienność UPDATE/DELETE/TRUNCATE oraz skończone budżety historii. Kopia
  pełnego pierwotnego wiersza zachowuje jego UUID również wtedy, gdy cała
  pozycja opuszcza bieżące źródło. Nie powstaje nieprawidłowa pozycja o ilości0.
- Rzeczywista sesja lub klucz i bieżąca polityka/MFA/account-version przez
  istniejącą tożsamość166; oddzielne wymaganie operator/admin oraz zakresów
  orders:read/write i inventory:read/write. Nie wymagamy admina dla operatora.
  `w=true` starego166 jest admin-only, dlatego210 stosuje rzeczywisty odczyt
  tożsamości166 i jawnie dokłada własne wymagania zapisu. NULL roli, hasha,
  użytkownika lub firmy nie daje uprawnienia. Kontrola końcowa ponownie odczytuje
  aktualny credential i zegar DB. Replay otrzymuje obowiązek dla **dzisiejszego**
  requestu, nie dla credentiala zapisanego przy historycznej komendzie.
- Przechwycenie rzeczywistych wierszy po blokadzie źródła, pozycji,
  kompletacji, stock i rezerwacji. Sprawdzenie wersji obejmuje też pełny
  nagłówek, cennik/pricing_snapshot i metadane FIFO w hashu scope. Brak historii
  finansowej wynika z rzeczywistych ledgerów, checks024, queued execution077,
  receipts i allocations124, nie z zerowego salda po odwróceniu wpisów.
- Rekomputacja planu z faktycznej bazy: dzieci według UUID slotu, pozostałość
  źródła ostatnia; zachowanie historycznego line_total, ceny, ilości oraz
  źródłowego netto/VAT. Dostawa ma osobny jawny budżet brutto. Konflikty
  `VAT_ROUNDING_CONFLICT` i `INVOICE_LINE_ROUNDING_CONFLICT` blokują execute.
  `EMPTY_RETAINED_SOURCE` jest jawną odmową, a nie usunięciem źródła.
- Fizyczny plan dzieli istniejące rezerwacje. WMS OFF: lokalizacja w porządku C;
  WMS ON: rzeczywiste fifo_sequence, następnie UUID warstwy i lokalizacja C,
  zgodnie z `calculateOrderSplitCustody` i aktualnym modelem FIFO. Nie tworzy
  nowych warstw, wydań, zwolnień, kosztów, stanów ani ruchów magazynowych.
- Jeden producent wykonania zapisuje cały before/after proof przed zmianami.
  Tworzy wszystkie dzieci w tej samej transakcji, aktualizuje pozostałość źródła,
  przypisuje kompletację/lokalizacje/warstwy oraz zapisuje własny lineage,
  zdarzenia i audyt. Nie używa N osobnych wywołań `createOrder`, które ponownie
  rezerwowałyby stock. Nowe tokeny portalu należą do dzieci; operacyjna polityka
  portalu, cennik, notatka, tagi i nagłówek są dziedziczone z rzeczywistego źródła.
- Odroczone sprawdzenie kompletności wiąże wszystkie sloty i source IDs,
  historyczne pozycje, rzeczywiste nagłówki/pozycje i custody oraz niezmienione
  stock/bins/positions. Dwanaście dodatkowych triggerów odmawia zmian fizycznych
  poza dokładnym proof, w tym nowych ruchów magazynowych mimo zerowego efektu
  netto. Nie dodajemy triggerów do istniejących tabel finansów, realizacji ani
  buyer sidecar. Końcowy odczyt całej tej historii pozostaje obowiązkowy.

To opis napisanego kodu, **nie wynik wykonania SQL**. Dziedziczenie wszystkich
kolumn przez typowany rekord wymaga późniejszego przypięcia dokładnego schematu
orders/order_items i wierszy custody w kontrakcie210; nie jest zgodą na dowolne
nowe kolumny albo przyszłe niezidentyfikowane znaczenie biznesowe.

Przegląd Root zastąpił containment JSONB w prywatnym row-admission dokładnym
porównaniem każdego pełnego wiersza (`value = old_row/new_row`). Containment
nie dowodzi równości zagnieżdżonych obiektów i tablic. Końcowe porównanie
całego before/after pozostaje osobnym warunkiem; rzeczywisty test PG odmowy
częściowego adresu lub components musi wejść do odbioru210.

## Dokładne porty do przyszłej integracji

`order_split210_preview(request jsonb, user_id uuid, api_key_id uuid,
credential_hash text, current_role text)` zwraca id/źródło/wersję/scope/plan/expiry.
`order_split210_execute` ma te same parametry aktora, a request zawiera
`client_key,preview_id,scope_hash,confirmed:true`. Target/item/pick UUID powstają
po stronie Native z identyfikatora podglądu; klient ich nie autoryzuje.

`order_split210_row_admission(table, operation, old_row, new_row)` jest
**prywatnym** predykatem dla konkretnej przyszłej sukcesji istniejącego guarda.
Pasuje wyłącznie do pełnych dokładnych krotek bieżącej transakcji i ponawia IAM.
Nie można go traktować jako publicznego callbacka ani pomijać pozostałych
gałęzi starego guarda. Akceptacja wymaga `IS TRUE`, nigdy domniemania po NULL.

`order_split210_terminal(execution_id)` musi zostać dołączony do rzeczywistego
managed tenantTx finalizera, z custody bieżącego requestu i existing schema
generation/shared982376 fence. Musi wykonać się **po wszystkich** finalizerach
sąsiednich modułów i opróżnieniu odroczonych ograniczeń, bezpośrednio przed
COMMIT. Po nim nie może następować zapis biznesowy ani oczekiwanie na dostawcę.
Własne deferred constraints sprawdzają normalny COMMIT. Nie ma zewnętrznych
triggerów ponownie kolejkujących kontrolę finansów po wcześniejszym
`SET CONSTRAINTS IMMEDIATE`; dlatego samodzielny owner SQL pomijający końcową
bramkę managed tenantTx nie jest wspieranym producentem podziału. Pełne kontrole
financial/history/jobs/imports, bieżącego IAM, zegara, ilości i kwot w terminalu
pozostają bez zmian. Konkurencyjni producenci muszą stosować rzeczywiste wspólne
blokady źródłowego zamówienia; usunięte triggery sprawdzały tylko własny root TX,
nie zapewniały synchronizacji z innymi transakcjami. Nie ma GUC/TTL cache ani
deklaracji `valid=true` zastępującej tę granicę.
Odczyt historycznej komendy, stronicowanie wszystkich wyników i read-only GET
reconciliation pozostają osobnym zadaniem serwisu;404 nie daje zgody na POST.

## Brakująca rzeczywista sukcesja przed aktywacją

1. `104_order_merge_custody.sql`/bieżący `wms_row_guard`: literalny kod zabrania
   DELETE warstwy i zmiany jej ilości poza rzeczywistym MERGE proof. Podział musi
   otrzymać nową **source-derived** gałąź dla dokładnego210 proof. SQL104/145
   pozostają literalne; nie tworzymy fikcyjnego MERGE ani nie wyłączamy guarda.
2. Rejestr obejmuje 27 triggerów: 15 własnych (w tym trzy odroczone zakończenia)
   i 12 fizycznych na starych tabelach, oraz trzy własne ograniczenia triggerowe.
   Nie ma 39 wcześniejszych financial/fulfillment rechecków. Nie dodajemy ich do
   buyer_address_state, local_consumer_credit_previews ani return_credit206_previews,
   które są objęte literalnymi fingerprintami166/188/207.
   Fa3/B2B i dalszy graf204/205 nadal widzą m.in. fizyczne triggery orders/items
   i ruchów magazynowych oraz nową definicję WMS. Potrzebna jest pełna dokładna
   sukcesja/projekcja tych zmian i nowego namespace. Samo dodanie
   gałęzi WMS nie domyka grafu. Nie wolno resealować starych certyfikatów ani
   przyjąć observed catalogue jako expected. Aktualny209 guard ma odmówić przy
   niezamkniętym następcy; to znana granica kandydata, nie ukryta zgodność.
3. Niezależny kompilator źródłowy210, porównanie całego before/after katalogu,
   zamknięty roster nowych obiektów/triggerów/RI/ACL i rzeczywiste negatywy.
   Budżety readera64MiB/rekordu8MiB nie są podnoszone. Nie osadzono historycznych
   wielkich SQL w ciałach funkcji ani nie utworzono kopii mapy209.
4. Rejestracja zasobu, migratora, normalizatora/inverse i cold gates dopiero po
   takim dowodzie oraz przeglądzie. Potem jeden lokalny serwis preview/execute,
   requestcredential custody, pełny DTO/readback, UI i testy rzeczywistych zapisów.

## Wymagany odbiór, nadal niewykonany

Prawdziwy dodatni przypadek WMS OFF oraz ON z wieloma liniami/lokalizacjami/
warstwami i niezależnym oracle. Zachowanie sum ilości, source gross/net/VAT,
dostawy, historycznych cen i cennika. Wszystkie dzieci plus source albo pełny
ROLLBACK; identyczne stock/bin/position/movement fakty przed i po. Testy zmiany
samego sidecaru/cennika/custody, revoke/expiry/MFA po oczekiwaniu, obcego tenanta,
zmiany requestu pod tym samym kluczem, missing/extra child, niedokończonego proof,
wczesnego constraints flush i późnego drift oraz utraty ACK bez drugiego zapisu.

Pełny Goal pozostaje szerszy. Ten pierwszy pion jawnie odmawia paid, B2B,
external/MERGE/previous split, dokumentów, RMA, częściowej realizacji,
niestandardowych pól i klasyfikowanego/override166 źródła. Obsługa tych procesów,
pełnych finansów, późniejszych faktur z resztami, seriali, UI, integracji,
recovery i skali nie jest ukończona przez kalkulator ani przez ten kandydat SQL.
