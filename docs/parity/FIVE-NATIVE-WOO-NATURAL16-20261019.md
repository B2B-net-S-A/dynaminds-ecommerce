# Pięć firm: N16 — dziesięć pierwszych naturalnych cykli i osobne pauzy

**Pięć firm, dziesięć pierwszych naturalnych cykli i osobne pauzy PASS w opisanym
zakresie na istniejącym N15. Globalne uzgodnienie632 tabel i końcowy odczyt
po GET/Chrome PASS. Pełna automatyka, skala i pełny Goal OPEN.**

## Zakres

N16 korzysta z tego samego uruchomionego wydania N15
`aa143236c03e3e9629e2f068ac23879f53d25a2fefbea2ae13e62c3f01bd9f51`,
schematu213, bazy i pięciu istniejących oficjalnych lokalnych sklepów.
Nie powstało nowe wydanie, migracja ani kopia danych. Oba odczyty każdej
firmy — orders.sync i catalog.fetch — wymagają osobnej zgody w zwykłym UI.
Nie wykonuje się ręcznego procesora, automatycznego zatwierdzania importów
biznesowych ani zapisów stocku.

## Rzeczywisty stan początkowy

Root przed włączeniem harmonogramów zachował pełne hashe632 tabel i pełne
wiersze14 tabel mogących się zmienić. To baseline do późniejszego uzgodnienia,
a nie dowód zachowania danych po cyklach. Odczyt miał0 zapisów/HTTP;
ROLLBACK i zamknięcie potwierdzone.
`before.private.json`,2499999B:
`bc93e5a7d6f919f69e3dd79d82fb42e1da65b348f481e2ef5106d4ff455a58d7`.

Osobny baseline obserwatora:12 GET200/0 POST/0 SQL. Sprawdzono świeżą tożsamość
administratora każdej firmy, pełną wcześniejszą historię oraz wstrzymane kontrole.
A: zamówienia v5/katalog v2; B: zamówienia v2/katalog nieutworzony;
C/D/E: brak obu kontroli. Starsze aborted oraz DONE pozostają częścią baseline.
`baseline01/result.private.json`,19566B:
`76481695231352bdb49d843fb01f8fb8c171e8185d3952166764eb2915f4d4b9`.

Niezależny helper izolacji zakończył27 GET bez POST/SQL/dostawcy:12 odpowiedzi200
oraz15 cudzych dostępów404. Własne dane pięciu firm i brak dostępu do wskazanych
cudzych kanałów potwierdzone. Wszystkie39 surowych ACK baseline i izolacji,
referencje oraz hashe body sprawdzono niezależnie na plikach.
`run-before01/result.private.json`,37407B:
`969472bdcdd6e26e23e9658506148091330575cfaa8fcb46aaebc2923a4b7d65`.

## Dziesięć osobnych zgód i obserwacja

Root wykonał dziesięć osobnych zgód w zwykłym UI pięciu kont;
zachowane są zrzuty włączonych konfiguracji A–E. Planowane wersje po zgodach:
A orders6/catalog3, B orders3/catalog1, C/D/E orders1/catalog1, interwał60s.
Nie utożsamiamy zgody ani przechwyconego przyszłego terminu z zakończonym cyklem.

Obserwator jest GET-only: maksimum300s i400 GET, pojedyncze żądanie maksymalnie15s,
odpowiedź1MiB i cały prywatny materiał64MiB. Każdy przyszły termin zapisuje
osobno natychmiast po ACK; wymaga braku nowego wykonania tego kind przed capture.
Nie czeka na jednoczesne ustawienie wszystkich dziesięciu kontroli. Co10s
wypisuje ograniczony postęp. Błąd HTTP lub niepełny wynik zatrzymuje próbę
bez ponowienia, przejęcia zadania ani replay.

Odbiór wymaga pierwszego naturalnego DONE każdego kind każdej firmy z dokładnym
wcześniej przechwyconym scheduled_for, nowymi identyfikatorami, zadaniem DONE bez
retry/dzierżawy oraz pełnym łańcuchem dispatch ACK/checkpoint. Dla zamówień
sprawdza wszystkie external_id i source_hash względem przypiętych natywnych DTO
stock2750ca30…:12/14/1/1/1. Dla katalogu wymaga osobnego nowego run READY,
wszystkich staged ID:7/3/1/1/1, bez zatwierdzania katalogu biznesowego.

Starsza historia zachowana w całości. Późniejsze cykle60s są zapisywane jako
obserwacje, nie kasowane ani utożsamiane z dodatkowym odbiorem DONE. Po odbiorze
pierwszych dziesięciu cykli zaplanowano osobne pauzy wszystkich konfiguracji;
wyniki pauz i porównania biznesowego opisano poniżej. Globalne uzgodnienie
pozostaje odrębnym krokiem.

- Observer22311B: `c9a1ed6f3810d2ad876a682e462dc0efd98c09e9620dcee532b4ad6705184339`.
- Wejścia3582B: `d210ff0c89a3dda9146b8505e6322d40c63ece7307531861fdffd7e54a6cf0ed`.
- Readiness2925B: `c270af97ff8c62ff716ce6fc0314c6091f2b13894952ef109cd047cc65f40388`.

## Nieudany obserwator zachowany; procesora nie ponowiono

Oryginalny obserwator30664 zakończył EXIT1 po84 GET: jego asercja dopuszczała
tylko staged/imported i odrzuciła wcześniejszy inbound A external_id14 w stanie
error. Przed UI i po odczycie ten sam wiersz miał identyczne id, state=error,
order_id=NULL, source_hash oraz issues. To błąd warunku obserwatora, nie dowód
nowej awarii odczytu; informacja o wcześniejszym błędzie danych pozostała zachowana.
API i tabela używają pola issues, bez osobnego pola error.

Stary skrypt i cała próba niezmienione. Root nie odtworzył procesora ani nie
przechwytywał nowych terminów. Osobny kolektor po jawnych pauzach korzystał
z dokładnie dziesięciu wcześniej zapisanych przyszłych terminów, baseline i
surowych wierszy sprzed UI; miał limit90s/100 GET. Dla istniejących inboundów wymagał identycznych
id/state/order_id/source_hash/issues, również wcześniejszego error; tylko
rzeczywiście nowe inboundy muszą być staged/imported. Pełne źródłowe hashe
zamówień nadal porównywane z zachowanymi natywnymi DTO stock2750ca30….

- Zachowana porażka `observe01/failure.private.json`,89155B: `59c0317dded45b7f1f6daaf3af4511529f154d9a9be622648681497381db0ce6`.
- Osobny kolektor21896B: `8dd930f5c08909faf68021c24a8cee65c77010fd32cf0784c1592af1a229e1d5`.

## Dziesięć pierwszych naturalnych cykli — PASS

Rzeczywisty kolektor Roota zakończył EXIT0:47 GET200/0 POST/0 SQL. Wszystkie
dziesięć pierwszych wykonań ma dokładny wcześniej przechwycony scheduled_for,
nowe occurrence/job, DONE, attempts0 i brak dzierżawy, pełny łańcuch dispatch
ACK/checkpoint. Pięć odczytów zamówień potwierdza wszystkie ID i source_hash
12/14/1/1/1 zamówień. Pięć nowych run katalogowych READY zawiera dokładnie
7/3/1/1/1 staged produktów. Nie zatwierdzono importów biznesowych ani katalogu.

W czasie oczekiwania doszły dwa późniejsze cykle orders A i B; historia
zachowuje je jako DONE. Łącznie zaobserwowano12 nowych wykonań:7 orders i5 catalog.
Pełny odbiór pierwszego terminu dotyczy dziesięciu wskazanych wykonań; późniejsze
dwa nie zostały przemianowane na pierwszy cykl, usunięte ani zignorowane.
Cała historia wcześniejsza niż N16 pozostała identyczna.

Root osobno wstrzymał wszystkie dziesięć konfiguracji. Końcowe wersje
A orders7/catalog4, B orders4/catalog2, C/D/E orders2/catalog2, wszędzie
wyłączone i next_at=NULL. To nowe zgody na pauzę, a nie cofnięcie odczytów.
Pełne dziesięć dowodów, stare historie, wszystkie raw ACK i końcowe wersje
zweryfikowano niezależnie na plikach.
`collect-completed01/result.private.json`,221553B:
`4ebd515a720d3258eeabaf4f0f144377bf4a963df628f17b8d21b5d211048cc1`.

## Zachowanie biznesu, izolacja i globalne uzgodnienie

Końcowy odczyt32 GET200/0 POST zachował pełne porównywane DTO stanów, własnych
zamówień, płatności i natywnych zamówień pięciu firm. Produkty zgodne z przyjętą
wcześniej jedyną projekcją bounded related_ids. Wszystko porównano z tym samym
stock2750ca30…; nie było natywnych zapisów. Osobne27 GET po pauzach ponownie
potwierdza izolację:12 odpowiedzi200 i15 cudzych404. Niezależny odczyt plików
sprawdził wszystkie106 raw ACK kolektora/closing/izolacji, bodySHA oraz pełne DTO.

- `five-store-closing.private.json`,251958B: `689cc307f48eb874563894cae11f62438f1eb4e86164dd987495635368c08844`.
- Izolacja `run-after01/result.private.json`,54552B: `8ec169ad4e34f98afcff7644c66d7eb510488ba4d3e3268c47bf08088e2b0ce2`.

Root przechwycił po pauzach wszystkie632 hashe tabel i pełne wiersze14 tabel:
`after.private.json`,2610388B,
`7a5777a883d8768a19abb1646ebd2545233bb81148b862c434e016940b545ae8`.
Osobny plikowy helper Roota zakończył EXIT0 i rozliczył cały przekrój632 tabel:
621 pełnych hashy identycznych,11 tabel z dokładnymi skutkami naturalnych odczytów
lub logowań UI. Przeliczono pełne hashe14 zachowanych tabel przed/po i odtworzono
ich wszystkie historyczne wiersze w projekcji porównawczej, bez zapisów DB.
Rozliczono68 nowych wpisów audytu,20 poleceń konfiguracji,7 kontroli,12 zadań,
12 wykonań/dispatch,7 integration_runs oraz5 run katalogowych z13 staged wpisami.
Wcześniejsze inboundy, dane biznesowe, migracje, stempel oraz receipt starego A
zachowane. Z istniejących wierszy zmieniły się wyłącznie terminy synchronizacji
pięciu kanałów i version/updated_at trzech wcześniejszych kontroli.

Dziewięć nowych własnych sesji UI rozliczono oddzielnie: A1, B/C/D/E po2;
pełny hash131 wcześniejszych sesji odtworzony. Wszystkie13 nowych wpisów katalogu
porównano z pełnym produkcyjnym mapperem: source, source_hash i issues zgodne
z zachowanymi źródłami, bez odrzucania related_ids jako pola mappera — nie jest
jego wejściem. Stara próba A i jej receipt zachowane, wynik nadal UNCONFIRMED.

Niezależna kontrola plików potwierdziła621 stałych hashy, dokładnie11 zmienionych
tabel,14 wyników odtworzenia pełnych hashy, wszystkie zachowane historyczne
wiersze14 tabel, liczby nowych wierszy, granice zmienionych pól i referencje.
`global-reconciliation.root-proof.private.json`,23606B:
`76861fbb5c403fcc03c7871f6c13a567580bb5f9a4d8bf5bcc69d90e2b217a0b`.

Ostatni rzeczywisty odczyt po wszystkich GET i Chrome potwierdził wszystkie632
pełne hashe identyczne ze stanem after. To osobny dowód, że dalsze odczyty/UI
nie dopisały kolejnych skutków. ROLLBACK/end potwierdzone,0 zapisów/HTTP obserwatora.
`final-hash.private.json`,89352B:
`f453b7a861d75ccf766800d21e34c23c7c0a3ade9a0d9949e74c4a61bf7def39`.

Odbiór obejmuje pierwszy naturalny cykl dwóch kind w pięciu firmach, późniejsze
zaobserwowane cykle i osobne pauzy. Nie dowodzi długotrwałej pracy, crash recovery,
restartu w trakcie odczytu, skali100k, automatycznego zatwierdzania importów lub
stocku ani integracji z zewnętrznym kontem dostawcy. Pełny Goal pozostaje OPEN.

Prywatne dowody znajdują się w katalogach
`five-native-woo-natural16-root-20261019-01`,
`five-native-woo-natural16-prepared-agent-20261019-01` i
`five-native-woo-natural16-isolation-prepared-agent-20261019-01` pod preview.

Zachowane zrzuty zgód Roota:
- ui-A-enabled.root.png: `f19b66b10ad8630094fbe7bf32580651bcfdccc30b1e808e700da3d7bab19daf`.
- ui-B-enabled.root.png: `7ea25e6c3c1f696fcd01a676c51fd40dc729dd65a9a284ea3260c326107bae0b`.
- ui-C-enabled.root.png: `d9e51e2d319c036db2da97d4b09429c6fd817851fa12871e3cfe0cf47052660b`.
- ui-D-enabled.root.png: `2561ff13ce037bab6cec3de41af2d36515444e9e59f93549770cc54bc6425126`.
- ui-E-enabled.root.png: `f04014f509052b42011aea61c9f1947b54782a75220ac208dbe91b6ed4e8585f`.
