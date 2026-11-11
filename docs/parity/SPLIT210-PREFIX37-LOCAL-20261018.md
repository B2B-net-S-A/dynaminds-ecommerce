# Split210 — porównanie zakresów nazw D37

Status: **rzeczywiste porównanie zapytań i uzgodnienie plików PASS**.
Podział zamówienia, instalacja nowego wariantu i pełny Goal pozostają otwarte.

Root wykonał jeden diagnostyczny operator na własnym PG04: sesja65975,
EXIT0, 2026-10-18T21:11:08.108Z–21:13:06.443Z. Zainstalowany w transakcji
Source32 pozostał niezmieniony. Kandydat dodaje sześć zakresów nazw z COLLATE
"C", zachowując oryginalne starts_with oraz wszystkie filtry i pola metadanych.
Pełny inverse sześciu zmian odtwarza oryginalne zapytanie.

## Poprawność

- 42 rzeczywiste świadki PostgreSQL NAME/C: granice prefiksów, Unicode,
  limit63 bajtów i NULL; zgodność wartości i pełnych bajtów.
- Sześć pełnych wyników czterokolumnowych: oryginał/kandydat dla516 rekordów,
  po kontrolowanej zmianie519 i po rollback ponownie516. Wszystkie wartości
  oryginału i kandydata identyczne; wszystkie stare rekordy zachowane.
- Zmiana metadanych wykryta przez świeży guard; po rollback cztery guardy TRUE.
  Publiczny CHECK, funkcja i trigger w innym schemacie są uwzględnione;
  CHECK obcego schematu pozostaje wykluczony zgodnie z oryginalnym zakresem.
- Całe494 dodatki/22 zmiany zgodne z V32. Inverse40502 rekordów/64011475B,
  końcowy katalog40996,84 stare payloady certyfikatów i18 ról zgodne.
- ROLLBACK, zamknięcie obu klientów i DROP własnej pustej bazy z0 połączeń
  potwierdzone. Bez COMMIT, Native lub aktywacji aplikacji.

## Pomiar

Dwa warmupy na wariant, potem20 par w zrównoważonej kolejności10AB/10BA.
Każdy pomiar sprawdza trzy oryginalne wyniki w całości. Zegar obejmuje samo
wywołanie SQL klienta, bez zapisu intent/ACK. Limity odczytu8s/klienta9s,
track_functions=none. Cztery dodatkowe testy rzeczywistej funkcji dispatch
potwierdziły rowMode=array, parametry, limit, pomiar i brak retry; PASS0SKIP.

| Wariant | Mediana ms | p95 ms | Min–max ms |
|---|---:|---:|---:|
| Oryginał |22,058|25,309|20,535–25,872|
| Zakresy nazw |18,153|19,484|15,277–22,721|

p95 tego małego lokalnego profilu spadło o około23%. Osobne pojedyncze EXPLAIN:
execution18,149→13,965ms, shared hits6209→3945; planowanie4,285→2,621ms.
To bezpośrednie zapytania, bez pomiaru kosztu tej samej funkcji przez SPI.
Nie wykonano pełnego ordinary187 po210, Native, biznesowego splitu lub skali.
Wynik uzasadnia przygotowanie nowego źródła i jego pełny odbiór w istniejących
limitach; sam nie nadaje takiego odbioru.

## Dowody i granice

Katalog: `local-builds/full-base-preview-20261017/source32-prefix-range-comparison37-prepared-20261018-01`.

| Plik | Bajty | SHA256 |
|---|---:|---|
| run/receipt.private.json |140921|31055fc3048904da8629ed11f87631190234763de61d2e3d0f8a507e0373616c|
| root-terminal-file-review.private.json |2465|277cf44851062e6547f22c48a3e9a8c73a159eb14cc9e171c8d546fc04b0a537|

Root92476: file-only reviewer EXIT0, PASS_SOURCE32_PREFIX37_FILE_RECONCILIATION_ONLY.
Niezależnie uzgodnił pełne katalogi, inverse, sześć wyników,42 świadki,
wszystkie pary i ich intent/ACK, dwa plany oraz cleanup. Jego sześć testów
kontrolowanych PASS0SKIP. Pierwsze polecenie testów wskazało nieistniejącą
nazwę pliku; poprawione polecenie uruchomiło właściwy zestaw, bez powtórzenia SQL.
Generation/new-manifest mają osobne pełne BEFORE; równość AFTER i rodziców
209/166 jest ukończoną asercją przypiętego operatora, nie osobnym payloadem.

Działające N10 i baza biznesowa pozostały poza zakresem operatora.

## Następny wariant Source33 — tylko źródła

Commit927ea46 wprowadza dokładnie sześć zmierzonych zakresów do funkcji valid.
Root47/47 testów PASS,0SKIP; niezależny przegląd źródeł GO. Cały Source33 ma
4525227B/SHA25623cdd8115b0eadd52c2fc39f503af469bbb1aad9e721997ce88d00b04eb5f50d.
Pełny inverse odtwarza Source32; DATA i22 wcześniejsze podmiany są identyczne.

Root30194: kolektor źródeł EXIT0; publikator V33 także EXIT0. Kolektor sprawdził
w całości dawny probe P24: SQL, readback,48 uporządkowanych targetów i osiem
oryginalnych/oczyszczonych DDL identyczne, poza jawnym source_candidate.
P24 pozostaje historycznym rzeczywistym pomiarem Source32; nie wykonano nowego
probe i nie opisujemy ponownego użycia jako nowego pomiaru PostgreSQL.

Świeży V33:494 dodatki/22 zmiany,493 pełne dodatki identyczne. Jedyna różnica
to source/definition funkcji valid; pozostałe22 pola jej24-polowego deskryptora
zachowane. Root niezależnie porównał pełne wartości, cały inverse funkcji oraz
wszystkie100 pinów źródeł. Oczekiwania nie pochodzą z obserwacji docelowego katalogu.

Katalog: `local-builds/full-base-preview-20261017/order-split210-source-expectation33-prepared-20261018-01`.

- V33 gzip346573B/SHA25635d9eb87e6dd69562949312b93cc7a4b0400ac7f63d65b1e08979cc0a8950de1.
- Canonical V33: a46053d1f8a62dd0eaba255c617817475ac2d371df0fd473dd2e7475369a1d4a.
- Root file review2975B/SHA25613ef836aedfb66f22470204e4ae5ffd9c64a174cf09705c0ec37402cf30c04fc.
- Osiem kontrolowanych testów collector/builder PASS,0SKIP.

**Historyczna granica publikacji V33: H, seal, zasoby, instalacja i Native nie były jeszcze zaktualizowane.**
Nie wykonano pełnego compiler/ordinary187/Native dla Source33, nie aktywowano
go w N11 i nie odebrano biznesowego podziału. To wymagany kolejny etap.

## Uzupełnienie: kontrakt H33 i zasoby źródłowe

Po publikacji V33 promowano statyczny kontrakt H, piny seala, kodeki zasobów
i ich testy do Source33. Pełny literalny H32 i wcześniejsza historia pozostały
zachowane. Koordynator niezależnie odtworzył cały H32 z bieżącego H33 przez
odwrócenie sześciu zmian w dwóch polach jednego deskryptora funkcji; pozostałe
493 dodatki i wszystkie 22 podmiany są identyczne.

- H33: decoded3273120 B / `9e23c99c53bdc7d0dd58abac262b3b6971823d7dbafe8be8b82c878145d7f0d6`;
  gzip350082 B / `d7d2908b214c0fd87bcfbfd77346941af8dfaf40b57b17d68a9c7ad71b234536`.
- Bieżący SQL:4525227 B / `23cdd8115b0eadd52c2fc39f503af469bbb1aad9e721997ce88d00b04eb5f50d`;
  gzip531367 B / `2cf81c97acb0461f07937e392549c594db1d28831dbacde590fc5c7f670d13b4`.
- 77 testów H/katalogu/kodeków/installera/emitera i39 testów seala/oracle PASS.
  Po końcowym doprecyzowaniu testu świadka ponowiono ten przypadek:1 PASS.
  Koordynator uruchomił osobno5 aktualnych testów:5 PASS/0SKIP/EXIT0.
- Pierwszy test przenośności odmówił prywatnej ścieżki w metadanych pochodzenia.
  Usunięto ścieżkę, zachowując rozmiar/SHA źródła; payload H nie zmienił się.
  Nie zastąpiono historycznego nieudanego logu sukcesem.

To nadal **odbiór źródeł bez wykonania PostgreSQL**. Nie wykonano nowego probe
P24; jego dawne 48 wartości jawnie wykorzystano ponownie. Pełny kompilator,
Native, instalacja i podział zamówienia w zwykłym UI/API pozostają otwarte.
Wcześniejsze wpisy powyżej opisują poprzednie granice etapów D37 i V33.

## Uzupełnienie: Source34, V34 i kontrakt H34

Commit `45f3278` wpiął do zamknięcia210 helper `order-split210-constraint-candidates`
(dwie gałęzie wyboru constraintów funkcji valid, deduplikacja wyłącznie po OID
katalogu). Powstał Source34, ale H, seal i zasoby nadal wskazywały Source33,
więc 25 testów split210 odmawiało. 23.10.2026 wykonano dla Source34 tę samą
procedurę co dla Source33, bez PostgreSQL.

Katalog: `local-builds/full-base-preview-20261017/order-split210-source-expectation34-prepared-20261023-01`.

- Plan101 źródeł: poprzednie100 ścieżek V33 plus helper constraint-candidates.
  Zmienione piny: closure (Source34), nowy helper oraz sześć plików zmienionych
  później poza split210; bajty programu pozostają przypięte.
- Kolektor i publikator EXIT0. Cały probe P24 równy z wyjątkiem jawnego
  source_candidate; ponownie użyto dawnych 48 wartości, bez nowego probe.
- Bieżący SQL: 4525572 B / `685c16fbf6fdf35f1b95752e7672e6df484ec865d0fa2cf5a20da5801da3dc73`;
  gzip531426 B / `488c2e2836f4e2c2fad8c6ce3dec4cf7f55cd5a7eddef182a1dc9212836eb0f2`.
- V34 gzip346866 B / `0143a44ace2ff5eac97ccb39283e63879198c8092ef60b56b3c0561d6d14c9a9`;
  canonical `cbe9a4819d11454443422879b851636c51e7ae7108677b5d24a48b172a502b32`;
  wynik publikacji `d2331ae7670065ddad12e0c07fc59e9d738cd1d93556d3481ce9c6ca0225c575`.
- Osobny przegląd plików (`f5b000f4…`): 493 dodatki i22 podmiany identyczne
  z V33, w valid zmienione tylko source/definition; dwie zmiany odwracają się
  do Source33, a ponowne złożenie z repozytorium daje ten sam program.
- H34: decoded3273810 B / `06fb4f7711a29622a1395ead240ca3d676b812f0103d92febbbd9433688fed91`;
  gzip350173 B / `c42927324b17458a4697244403f979764f7b91e7760d9a748b47efad1056d78c`.
  Metadane pochodzenia nie zawierają prywatnych ścieżek.

H33 i wektor V33 są teraz pełnymi historycznymi fixture'ami. Testy odtwarzają
z nich cały H33 i jawnie odrzucają poprzedni33 w emiterze, szablonie instalacji,
sealu, oracle oraz w wierszu zasobu210. Helper constraint-candidates celowo
przypina swoje wejście Source33, tak jak prefix-name-ranges przypina Source32.

Zestaw98 plików cold/historii: przed zmianą 921 testów, 884 PASS/25 FAIL/12 SKIP;
po zmianie 950 testów, 938 PASS/0 FAIL/12 SKIP. Test Native210 ma nowe piny
i przechodzi bez PG (1 PASS/26 SKIP). Jego scenariusze wymagają zapieczętowanej
instalacji210, której nie ma, bo pełny kompilator nadal odmawia przy8s (C35).

To nadal **odbiór źródeł bez wykonania PostgreSQL**. Kompilator, Native,
rejestracja migracji210 i podział zamówienia w UI/API pozostają otwarte.
