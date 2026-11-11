# Format zasobu SQL209 — implementacja i historyczny plan

**Aktualizacja18.10.2026:** formatv2 jest zaimplementowany i przeszedł rzeczywisty
builder pakietu12 `11301186…`:379 plików/100015196B, zapas648100B do96MiB.
SQL Source18 ma27029809B/SHA `9e25cb84…`; rzeczywisty Node24.17.0/zlib1.3.1-e00f703
gzip9 ma3663081B/SHA `8edb7d63…`. Akceptowane są wyłącznie te przypięte bajty,
trzy stałe współdzielenia178/201/202 i czteroelementowy roster storage.
Ogólne limity16MiB i96MiB oraz historyczny formatv1 pozostają bez zmian.
Builder odmawia braku209 przy rzeczywistym wpisie migracji; CLI porównuje
również oba nowe moduły narzędziowe i runtime. Kontrole obejmują rzeczywisty
etap buildera, validator i prywatny reader, ale nie stanowią odbioru startu,
Native lub operacji biznesowej. Poniższe pomiary i propozycje opisują starszy
plan; ich kandydaci SQL i prognozy rozmiaru nie są bieżącym wynikiem.

Stan: plan do oceny po rzeczywistym odbiorze Native209. Nie ustanawia E209,
nie zatwierdza nowego formatu ani zwiększenia limitów. Nie uruchomiono tutaj
PostgreSQL, aplikacji, instalatora ani nowego wydania. Poniższe pomiary dotyczą
istniejącego pakietu11 i kompresji bajtów kandydata SQL; nie dowodzą gotowości209.

## Rzeczywiste wejścia i rozróżnienie limitów

Istniejący pakiet: `local-builds/full-base-development-11`.

| Fakt | Zweryfikowana wartość |
| --- | --- |
| `release.json` SHA256 / długość | `c29ae8952c64a9f0560d5a4c26a1826f0017cdbb605a21f0d9288b63b298a242` / 334132 B |
| Liczba członków `manifest.files` | 382 |
| Suma fizycznych bajtów członków, bez `release.json` | 99772339 B |
| Source04: `contract/source-release-manifest.json` SHA256 | `1d8ea45cad203f9821e6e8f2d3fc8ed7835065a0a19185a0ea4caa21d7f96c76` |
| Kandydat SQL209 SHA256 / długość | `67e5bc59e288d7529a62c1f12bf2a680d6ba3f45d158ababce2fbb4b2e0be150` / 27023644 B |
| `gzipSync(SQL209, {level:9})` SHA256 / długość | `e690a660007db1ca23b2c3820212673ddc71b2a9cd20db31ffb66f1700b46374` / 3662894 B |

Hash gzip jest pomiarem przy obecnym Node/zlib, nie przenośną gwarancją
identycznego kompresora. Przyszły builder musi zapisać i sprawdzać rzeczywisty
hash skompresowanych bajtów oraz niezależny hash pełnego SQL.

Obecne ograniczenia są odrębne:

- `resource-io.mjs:14–17` i `portable-release.mjs:13,34`: zwykły fizyczny plik
  oraz zwykły odczyt zasobu najwyżej 16 MiB; stary pakiet źródłowy najwyżej 64 MiB.
- `emitted-release.mjs:17–18`: członek najwyżej 16 MiB, suma fizycznych członków
  najwyżej 96 MiB = 100663296 B. Pakiet11 ma tylko 890957 B zapasu.
- `packing189-catalogue-reader.mjs:21` i `order-merge-delivery209-inverse.mjs:11`:
  metadata najwyżej 64 MiB, pojedynczy rekord najwyżej8 MiB. Te limity pozostają
  bez zmian; nie są limitami pliku SQL ani pakietu.

Sam gzip209 **nie wystarcza**: 99772339 + 3662894 = 103435233 B, czyli
2771937 B ponad fizyczne 96 MiB. Suma tych samych plików z rozwiniętym209 wynosi
126795983 B. Kompresja nie uprawnia do twierdzenia, że zachowano globalny limit
96 MiB rozwiniętych bajtów. Taki limit nie wynika z obecnego kodu pakietowania;
jeżeli stanie się warunkiem nowego formatu, projekt trzeba dodatkowo zmienić.

## Dokładny kandydat deduplikacji178

W pakiecie11 odczytano oba rzeczywiste pliki i potwierdzono pełną równość bajtów:

- `native/178_large_import_wave_print_compatibility.sql`, rola `native-sql`;
- `resources/server/178_large_import_wave_print_compatibility.sql`, rola
  `runtime-resource`.

Każdy ma 3991821 B i SHA256
`078ef0fd47ff756ffbac18c0f965698fc912c8fd739aba11a945d9c72e4f0faa`.
Source04 ma dokładnie krawędź `ordinary178_compatibility` wskazującą pierwszy
plik z tym samym hashem. Proponowany nowy format może współdzielić ten
**istniejący** fizyczny plik dla jednego ustalonego logicznego zasobu178.
Nie należy przepisywać Source04, zmieniać jego roli, krawędzi, profilu ani
hasha, ani dodawać ogólnego resolvera ścieżek dostarczanych przez manifest.

Prognoza wyłącznie dla tej zmiany i gzip209:
99772339 − 3991821 + 3662894 = **99443412 B**, zapas 1219884 B do 96 MiB.
Nie uwzględnia przyszłych modułów, E209 ani zmian bundlera. Przyszła liczba
plików, revision i faktyczna suma pozostają nieznane do emisji nowego pakietu.
Nawet deduplikacja wszystkich obecnych identycznych plików (19842859 B)
nie utrzymałaby 96 MiB przy liczeniu pełnych rozwiniętych bajtów209.

## Najmniejszy proponowany format

1. Nowa, jawnie wersjonowana gałąź zasobów z jedynym kodowo ustalonym
   gzip-ID `sql:server/209_order_merge_delivery_inheritance.sql` i fizycznym
   członkiem `resources/server/209_order_merge_delivery_inheritance.sql.gz`.
   Zwykłe zasoby i starsze manifesty nadal podlegają swoim dotychczasowym
   regułom. Osobna, ścisła gałąź współdzielenia178 ma jeden ustalony cel;
   manifest nie przyznaje prawa wyboru dowolnego aliasu ani kodowania.
2. Manifest wiąże fizyczne `bytes/sha256`; niezależna, kodowo przypięta
   oczekiwana struktura po zaakceptowanej kompilacji209 wiąże pełne
   `decoded_bytes/decoded_sha256`. Sam manifest lub argument `expected`
   nie uwierzytelnia źródła i nie może zastąpić przyszłego E209.
3. Odczyt `.gz` zachowuje obecny limit16 MiB, zakaz linków i cięcia
   tożsamości ścieżka/FD/przed/po. Dekoder ma skończone `maxOutputLength`
   równe dokładnej przypiętej długości209; następnie sprawdza długość,
   pełny SHA256 i poprawny UTF8. Żaden ogólny limit surowych zasobów nie rośnie.
   Rozwinięcie 27 MB jest jawnym, osobnym ograniczeniem tylko tego formatu209,
   a nie domyślnym dopuszczeniem innych dużych plików.
4. Oryginalny tryb źródłowy potrzebuje osobnego odczytu wyłącznie przypiętego
   pliku209, ze skończonym limitem i tymi samymi kontrolami FD/hash. Dzisiejszy
   `packageBytes` odrzuci27 MB jeszcze przed kompresją; nie wolno po prostu
   zwiększyć jego ogólnego 16 MiB. Builder ponawia pełne sprawdzenie źródła
   przy końcowym cięciu zasobów.
5. `server/db.ts` zachowuje logiczną nazwę `.sql` i przekazuje dokładny
   rozwinięty tekst w **jednym** `c.query`. Dzielenie SQL na osobno wykonywane
   części jest niedopuszczalne. Ogólny protokół fragmentów zwiększa zakres,
   nie rozwiązuje limitu sumy pakietu i nie jest tutaj rekomendowany.

## Konkretne miejsca integracji

- `tools/build/resource-definitions.mjs` oraz jego kopia H:
  nowa definicja209 i kodowe ograniczenie kodowania; dotychczasowe definicje
  zachowane. Nowa struktura współdzielenia178 powinna być jawna i oddzielna
  od starego zbioru definicji.
- `tools/build/package-builder.mjs:104–118,163`: przypięty odczyt209,
  deterministyczna kompresja, zapis fizycznego członka, zamknięcie źródłowego
  cięcia, rozliczenie fizycznego aliasu178 tylko raz.
- `tools/build/emitted-release.mjs:16–18,60–68` oraz kopia H: ścisłe nowe
  pola/rola/roster i oba poziomy hashy, kompletny manifest/inventory,
  niezmienione 16/96 MiB. `portable-release.mjs` obu kopii zachowuje stare
  surowe limity i przyjmuje oryginalny Source04 bez modyfikowania jego danych.
- H `runtime-resources.mjs:13–19,33–39,50–55`, `resource-io.mjs` i odpowiednie
  deklaracje typów: autentyczny prywatny reader, kodowo ustalony gzip209,
  ograniczony dekoder i dokładny fallback źródłowy. Nigdy callback zaufania.
- `server/db.ts:606–610`: dopiero po pełnych bramkach209 dopisanie migracji.
  `profile-source.mjs`, `profile-compiler.mjs` i Source04 graph/profile nie
  wymagają zamiany historycznego SQL na gzip. `profile-startup.mjs` nadal
  przyjmuje wyłącznie zweryfikowane wydanie; osobne włączenie209 cold/inverse
  pozostaje w `order-merge-delivery209-activation-plan.md`.

H oznacza `shared/large-import-dependencies/pim-large-import173-business-traversal-ui`.

## Wymagane sprawdzenia przed uznaniem formatu za gotowy

- Rzeczywisty builder → fizyczny pakiet → autentyczny installed reader:
  pełne decoded SQL równe przypiętemu źródłu bajt w bajt; kompletna kontrola
  zamykająca wszystkich członków i inventory. Source04 manifest/profil/native
  graph i wszystkie stare SQL/kontrakty porównać z oryginalnymi pinami.
- Odrzucenie: uszkodzony lub ucięty gzip, błędny CRC, garbage lub dodatkowy
  strumień, inne kodowanie/ID/ścieżka, błędny physical SHA, błędny decoded SHA,
  decoded długość za mała/za duża, invalid UTF8, BOM lub zmienione końce linii
  niezgodne z przypiętym źródłem. Nie wystarcza powodzenie `gunzip`.
- Zip bomb przerwana przez limit dekodera **przed** nieograniczoną alokacją;
  wyjątek209 nie może zwiększać granicy innych zasobów ani metadata64/record8.
- Link/symlink, podmiana inode, modyfikacja podczas odczytu lub końcowego
  rehashu, drugi fizyczny członek i niepełne rozliczenie logicznych ról178
  muszą zakończyć się odmową. Alias178 z innym SHA/rolą/źródłem również.
- Stare testy `tools/build/local-package.test.mjs` i
  `tests/return-credit207-resources.test.mjs`, `return-credit208-resources.test.mjs`
  oraz nowe wąskie testy faktycznego buildera/readerów. Osobno rzeczywisty
  nowy pakiet musi spełnić 16/96 MiB; prognoza powyżej tego nie zastępuje.
- Dopiero rzeczywisty compiler209 + pełne Native QA, wspólne wydanie,
  normalny start i klasyfikowany MERGE przez UI/API mogą zamknąć aktywację.
  Sam format zasobu, kompresja lub zielone testy modułu jej nie dowodzą.
