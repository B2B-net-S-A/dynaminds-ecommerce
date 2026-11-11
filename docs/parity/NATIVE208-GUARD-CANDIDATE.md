# Source208: kandydat redukcji powtórzonych guardów

Status: **SOURCE_DDL_COMPILED, SOURCE_REVIEWED, ORDINARY10_READY_FOUR_CASE_HTTP_PASS**.
SQL208 zintegrowano z migratorem i obiema listami zasobów; cold gate wymaga
pełnego208→207 oraz czterech markerów. Main pozostaje na205. Podgląd07 zamknięto
poprawnie; zwykły start08 zapisał migrację208 na tej samej kopii podglądowej,
ale zakończył się EXIT1 przed READY. Żaden finansowy przypadek08 nie ruszył.
Zachowano `preview08-start-failure.private.json` i oryginalne stany usługi.
Hash65B stderr potwierdza wyłącznie nazwę AssertionError; pierwotnego message
ani stack CLI nie zapisał. Niezależnie znaleziono i odtworzono pominięcie
projekcji208 w `ordinary-legacy-schema.mjs` przed projekcją207. Poprawka
`cbf2cca` dodaje ścisłą kompozycję208→207→packing-wave;14 focused tests PASS,
0 skip. Wymaga nowego wydania i rzeczywistego odbioru; nie przypisujemy
niezachowanego pierwotnego komunikatu konkretnemu assertion.

Rzeczywisty metadata-only odczyt tej samej kopii208 odtworzył odmowę starej
projekcji207 i zaakceptował208→207→wave. Observer wymagał zwykłego owner
READ COMMITTED z982376; użyto wyłącznie SELECT i ROLLBACK, bez DDL/businessDML.
Wcześniejszy observer READ ONLY odmówił kontekstu; nie przedstawiamy go jako
zakończonego porównania. Dowód: `preview08-normalizer-reproduction-1792263576977.private.json`.

Nowy pakiet09 `eb78c328…` ma jedną zmianę emitowanego źródła: normalizer.
381 plików/99 756 119B i714 źródeł sprawdzono; Native/ABI/resources/static/Source04
pozostały literalne08. Start09 przekroczył180s gotowości, następnie60s shutdown;
oryginalny `READINESS_TIMEOUT` i `SHUTDOWN_UNCONFIRMED` pozostają niezaliczone.
Później app zakończyła się EXIT0 bez sygnału; wszystkie trzy pierwotne PID
potwierdzono jako nieobecne. Dowód: `preview09-start-failure.private.json`.
Żaden finansowy przypadek09 nie ruszył. Main pozostał na205 i health200.

Próbkowanie tego samego żywego app44106 przed jego zakończeniem wskazało306/635
próbek głównego wątku w UTF8/SHA256, pozostałe w obiektach/sortowaniu/GC;
szczyt pamięci3,4GB. Niesymbolizowane ramki nie identyfikują konkretnej funkcjiJS.
Osobna analiza callgraph wskazuje27 materializacji projekcji w jednym cold
snapshot i14 w normalizerze. Optymalizacja niemutowalnych danychJS pozostaje
osobnym kandydatem; nie zmienia świeżych kontroli Native/IAM ani limitów.

## Reprezentacja immutableJS — zintegrowana, start10 READY

Commit `d8b5894` dodaje WeakMap wyników siedmiu czystych projekcji201–208.
Kluczem jest wyłącznie wynik rzeczywistego validatora, własny głęboko zamrożony
snapshot. Obcy obiekt, identyczny hash lub `Object.freeze` nie przejmuje wpisu.
Zamrożono zwracane wrappery/liczniki;205 inactive używa już immutable records
zamiast zbędnej kopii. Nie zmieniono readera, SourceSQL/E, Native, IAM ani
świeżych odczytów/generation gates.46 focused tests PASS,0 skip; review PASS.

File-only benchmark na rzeczywistym skompilowanym katalogu40243 rekordów
wykonał dwa osobne procesy kolejno: literalny09 i kandydat. Każdy wykonał dwa
cykle pure-callsequence, bez PG/owner custody/app/API. Pełna semantyka,
liczniki i digest40243→40215→39676 są identyczne, wraz z pełną produkcyjną
ścieżką E201–203. Receipt SHA256
`0dfe30c1100152781fa099ce3ed228b8503402d9edeaa1c11c23de52b0db0391`;
semantic SHA256 `2520d3d89e74b8984c87cb4c6beb3bf7dc28202bfb381a63e908ec2a25a556b4`.
Oba procesy EXIT0, bez sygnału; zamknięcie pierwszego poprzedziło drugi.

Suma mierzonych faz:58,319919s→12,869667s; CPU user+system:66,548898s→14,828728s.
PeakRSS wzrósł2972736→3103472KiB (około+4,4% /127,67MiB). To jeden uporządkowany
lokalny eksperyment Node24.17.0/old-space3072MiB, nie limit całego RSS,
p95, pomiar gotowości, skali lub potwierdzenie poprawności Native/IAM.

Pakiet10 `49e3a6fd…`:382 pliki/99 769 311B,714 emitowanych źródeł; dokładnie
7memo+2backendMERGE zmiany względem09, aktualny frontend Web Locks. Native,
ABI, Source04 i zasoby pozostały literalne. Typecheck+Vite PASS, niezależny
przegląd pakietu i konfiguracji PASS. Rzeczywisty start10 jest osobnym odbiorem
na tej samej kopii208, w tym samym Standard/180s/60s; dotychczasowe timeouty
pozostają w historii. Rzeczywisty READY10 potwierdzono, następnie cztery nowe przypadki finansowe
zakończyły się PASS_ORDINARY_HTTP (203 żądania drivera): OFF/ON, reject-only
i historia legacy188→reject148→received169→credit207. To nie jest pełna
certyfikacja Native208, współbieżności, IAM, ACK-loss, restartu ani skali.
Szczegóły i granice: [integracja korekt](RETURN-CREDIT207-INTEGRATION.md).
Niezależny pusty compiler wykonał
199 etapów, potwierdził 28 dodatków / 2 zmiany / 0 usunięć i zachowanie wszystkich
40 213 pozostałych rekordów. Root sprawdził źródła, kolejność, role i dowody.
Rzeczywiste negatywy guardów: 14 testów DB oraz 2 czyste, 16 PASS / 0 skip.
To nie jest odbiór biznesowy Native, pomiar zwykłego requestu ani aktywacja.

Obecny SQL208: a0091c26296575ea5b9b97fc794535e79bbcbfa056dcfa2ac33bab96c0c226a8.
Receipt kompilacji: b52b3ab3d28b5dca944a7a14936d1118dd724510e23911dcc7d4e6fe44064381.
Program: 89baeaf2156e4df5909d848e0b0fd2e3c022d2718ad3ecc67c9107baac7dd5f0.
Review Roota: bb8f0c73f18281c941f8a378323016ada241e49e7d106586dbaa09ba7fb816f4.

Generator: tools/parity/return-credit208-source.mjs i return-credit208.template.sql.
Wynik: server/208_consumer_return_credit_guard_dedup.sql.
Poprzednik SQL207 ma SHA256
8abe73aec97e294860f918c7285c016444fce15322bf03148926f41041076172.
188, struktura188,206 i207 pozostają literalne na dysku.

Przed DDL wymagana jest transakcja właściciela postgres, origin, UTC, PG18
i istniejąca wyłączna blokada982376. Weryfikowany jest prawdziwy guard207,
literalna struktura188 oraz wszystkie539 descriptorów206+207 z niezależnej
kompilacji źródłowej. Ograniczony odczyt katalogu zachowuje także wewnętrzne
triggery FK na istniejących tabelach rodziców. Nie czyta danych biznesowych.

Nowy prywatny return_credit208_manifest zachowuje cały oryginalny wiersz
manifestu207, aktualny fingerprint przestrzeni206 i fingerprint metadanych208.
Nie aktualizuje starych manifestów, dokumentów ani liczników. RLS jest FORCE,
jedyna polityka należy do postgres, odziedziczone granty innych odbiorców są
odbierane tylko na nowych obiektach. Triggery blokują UPDATE, DELETE i TRUNCATE.
Jedyna nowa funkcja to prywatna return_credit208_fingerprint().

Zmieniają się dokładnie dwa istniejące body:

- return_credit206_guards: znika bezpośrednie157/169/160, nadal sprawdzane
  przez niezmienny pełny188; pozostają origin, struktura188, wszystkie
  dotychczasowe liczniki i rodzice. Nowy manifest i obie aktualne przestrzenie
  metadanych muszą się zgadzać. Brak, częściowa instalacja lub dodatkowe
  nazwane obiekty208 powodują odmowę.
- return_credit206_require: znika bezpośrednie157/169 już pokryte guardem.
  local_invoice_require(uid,kid,writing,pin) pozostaje bez zmian: ponownie
  sprawdza157 oraz świeżą tożsamość, uprawnienia, zakres klucza i wymagane piny.

Wszystkie frame, source, triggery zapisu, early/late/deferred requires i ścieżka
COMMIT pozostają. Nie ma cache wyników, zmiany timeout8s ani nowej flagi sesji.
Równoważność logiczna dotyczy aktualnego, przypiętego stanu. Nie deklarujemy
identycznych wyjątków/czasów przy dowolnym równoległym DDL superusera.
Obsługiwane transakcje zachowują rzeczywisty shared982376/generation fence;
odczyt Available(pool) pozostaje wskazówką, bez prawa do zapisu.

## Kontrakt dokładnej projekcji

Niezależna kompilacja Source205→206→207→208 ma zamkniętego klienta i usuniętą
własną bazę po potwierdzeniu zera połączeń. Kontrakt208 zawiera piny programu,
SQL208, receipt i review oraz:

- changes: dokładnie dwa pełne descriptory funkcji; before równe oryginalnym
  rekordom207, after równe wyłącznie zmienionym body i definicji.
  Generator wyprowadza te dwa pełne descriptory; odpowiadają one rzeczywistemu
  wynikowi PostgreSQL.
- additions: pełny, niezależnie skompilowany spis wszystkich nowych rekordów
  przestrzeni208, wraz z typami, indeksem, ograniczeniami, polityką i triggerami.
  Łącznie: 7 kolumn, 12 ograniczeń, 1 funkcja, 1 indeks, 1 polityka, 2 relacje,
  2 triggery i 2 typy. Wartości nie pochodzą z podglądu biznesowego.
- removed: [] i dowód, że każdy pozostały rekord katalogu nie zmienił się;
  oddzielny dowód literalnej zgodności manifestu207 przed/po.

Projekcja sprawdza cały dokładny spis nowych rekordów i oba pełne descriptory
after, usuwa wyłącznie przypięte dodatki, odtwarza oba before i poprawia
liczniki/digest katalogu. Gdy206 istnieje, brak208 wymaga obu literalnych before;
stan mieszany, overload, dodatkowy obiekt lub drift oznacza odmowę. Następnie
działa istniejąca dokładna projekcja207→205. Nie wolno stosować broad prefix
removal ani pomijać nieznanych rekordów. Gdy nie ma żadnego obiektu206 ani208,
warstwa zwraca niezmieniony zweryfikowany katalog jako nieaktywny; pełny
następny compare nadal potwierdza poprzednika205. Gotowość zwykłego runtime
wymaga aktywnych208/207 i markerów189/206/207/208 na rzeczywistym katalogu.

Osobny test plikowy rzeczywistego katalogu potwierdził 40 243 → 40 215 → 39 676
rekordów oraz dokładne digests207 i205, następnie tożsamość ponownej nieaktywnej
projekcji208. Wynik 1 PASS / 0 skip, 2,24 s. Uruchomiono Node z ograniczeniem
old-space1024 MiB; efektywny limit V8 z young space wyniósł 1 275 068 416 B,
a zmierzony maksymalny RSS 1 323 824 KiB. Nie deklarujemy limitu całego RSS1 GiB.

Przed odbiorem biznesowym potrzebne są pozytywne zwykłe procesy UI/API na nowym
wspólnym wydaniu, odwołanie sesji/MFA po oczekiwaniu, source/series drift, replay,
generation drift oraz brak nowych skutków finansowych przy odmowie. Zasoby,
migrator, dokładny sourceinverse i wszystkie cold gates są osobnym krokiem
integracji pod nadzorem Roota.
Poprawy p95≤4s nie można wywnioskować z usunięcia części wywołań: wymaga pomiaru
całego zwykłego requestu na wspólnym wydaniu.

Koordynator sprawdził po integracji45 testów źródeł, zasobów i cold gate:
45 PASS / 0 skip. Pełny build (TypeScript i Vite) przeszedł; ostrzeżenie
o dużym głównym chunku pozostało. Oddzielny rzeczywisty odbiór Native guardów
pochodzi z14 testów DB powyżej, nie z tych kontroli plikowych.
Trzy próbki SELECT guard w jednej źródłowo kompilowanej bazie dały mediany
905,93ms przed208 i764,69ms po208. To pojedynczy uporządkowany eksperyment
na bazie bez danych biznesowych, bez pomiaru p95 i bez dowodu usunięcia
timeoutu w zwykłym procesie. Kontrole kontekstu i IAM pozostają świeże.

Kontrola źródeł:

    node --test tests/return-credit208-source.test.mjs tests/return-credit208-source-compatibility.test.mjs tests/return-credit208-catalogue.test.mjs
