# Korekta przyjęcia 148 — kandydat 211 i rzeczywisty preflight

**Kompilacja, instalacja i korekta SQL na kopii PASS; wspólne wydanie, zwykły UI/API i refund nadal otwarte.**

Nowy niewpięty kod wprowadza czytnik historii przyjęcia destinations148 bez
numerowanego 169 jako źródło korekty. Typowany parent rozróżnia prawdziwe 148
i 169; nie tworzy PZ, ruchu stocku ani zastępczego receipt 169. Zachowuje stare
ścieżki 169/188, kalkulator v2, numery i pełne historyczne manifesty 206/208/209.
Seed dotyczy wyłącznie wcześniej istniejących korekt 206.

Kandydat ma 205 593 B, SHA256
`dd4b84617213f88f99e38aa43028785da422dddafb4b5f0035c9343a7f2535ac`.
Obejmuje nowe obiekty, seed, trzy porty źródłowe i zmianę FK. Ten kandydat
nie zawiera INSERT autoryzującego seala ani COMMIT. Po kompilacji opublikowano
osobny pełny program instalacyjny 719 328 B/SHA `08a7f80a…`, obejmujący
kandydat i jeden seal ze stałego wektora źródłowego. Migrator wskazuje ten
pełny program po 209, bez aktywowania 210. Instalację na kopii i biznesowy SQL
odebrano osobno poniżej. Wspólne wydanie i zwykły UI/API pozostają otwarte.
N06 na 4105 pozostaje bez 211.

## Jedna kopia zachowanych danych

Root uruchomił istniejący produktowy backup i restore, bez zatrzymywania N06:

- backup 49914 EXIT0: AES-256-GCM, 13 895 716 B, 625 tabel publicznych i 1 obraz;
- restore 14432 EXIT0: porównanie pełnych fingerprintów 625 tabel i schematu v4;
- potwierdzone 627 rekordów ACL oraz 2 tabele prywatne z 13 343 wierszami;
- zweryfikowane 134 szyfrowane rekordy oraz obraz 183 805 B;
- zachowane wartości hasła i klucza konfiguracji, workery wyłączone.

Produkt odtworzył jedną nową bazę `dynaminds_restore_5d7646c680227492` na 57083.
Root nadał komentarz własności z osobnym nonce wyłącznie tej bazie, przez
połączenie maintenance. Nie wykonywano tej operacji na bazie źródłowej.
Osobny READ ONLY potwierdził stempel 1703 i cztery kompletne stare receipts 206.
Pełny `order_merge_delivery209_valid()` na kopii zwrócił TRUE w 31,080 ms przy 8 s.
To nie dowodzi całego recovery Goala: backup nie obejmuje wszystkich private FS
roots, a odtworzenie niepustych kolejek z ich pracą nadal wymaga osobnego odbioru.

## Rzeczywista kompilacja DDL na kopii i ROLLBACK

Root 54777 wykonał dokładny kandydat w jednej transakcji na oznaczonej kopii.
Źródła, tożsamość, nonce i brak 211 sprawdzono przed operacją. Wykonanie DDL,
seeda czterech starych korekt i FK trwało 4206,075 ms. Odczyt potwierdził:

- 4 uwierzytelnione parents, 0 wierszy metadata i metadata_valid=FALSE;
- FK receipts 206 wskazuje na nowy typowany parent 211;
- Brak seala jest świadomą odmową instalacji, nie udzielonym Native approval.

Następnie Root wykonał ROLLBACK. Nowy niezależny odczyt w kolejnej transakcji
porównał **cały katalog 40 503 rekordów**, pełne globalne fingerprinty 50 tabel
biznesowych i manifestów oraz stempel 1703. Wszystkie wartości identyczne.
Zamknięcie klienta potwierdzone. Nie wykonano COMMIT, korekty, refundu ani
zmiany danych źródłowej aplikacji. Pełne wartości katalogu porównano w pamięci;
receipt zapisuje wynik i hash, bez kolejnych dwóch kopii dużego katalogu.

Różnicę 40 503/40 502 wobec pustego Source209 sprawdzono osobnym rzeczywistym
odczytem dwóch pełnych deskryptorów. To dokładny, istniejący wariant
`migrations.applied_at NOT NULL`, obsługiwany przez źródłowy
`projectMigrationsNullability`: usuwa jeden dodatkowy constraint i odtwarza
literalną kolumnę. Nie utworzono oczekiwań kompilatora z danych kopii.

## Testy kontrolowane i zachowane odmowy

Root uruchomił razem 28 testów: 18 źródeł/kalkulacji, 8 zamkniętej odwrotności
katalogu i 2 rzeczywistego operatora z symulowanym transportem: 28 PASS, 0 SKIP,
297,062 ms na Node22.23.0. Test utraty ACK zachowuje pierwszy błąd i intencję,
zatrzymując replay. Nie jest rzeczywistą utratą ACK PostgreSQL ani dowodem
automatycznego readback. Draft inverse wymaga przyszłego autoryzowanego
wektora; nie publikuje jeszcze stałego Native211 contract.

Przygotowanie przypadków ujawniło błędy pomocniczych skryptów. Pierwszy caller
odmówił przed SQL przez nieunikalny historyczny spis `[1,1,2,0]`; duplikat był
całym identycznym obiektem, brakujący manifest mieszanej ścieżki odnaleziono.
Druga próba odmówiła na adresie `127.0.0.1/32` zamiast wartości hosta; poprawiono
zapytanie na `host(inet_server_addr())`. Kolejna READ ONLY odmówiła przez brak
aktywnej sesji historycznego aktora B. ROLLBACK/end potwierdzone. Nie tworzono
ani nie przedłużano sesji przez SQL. Wszystkie odmowy zachowano.

Następnie odrębna aplikacja kopii na 4106 osiągnęła READY przez zwykły start
N06, bez workerów, trybu restore-preview i zmiany stempla 1703. Root wykonał
zwykły login istniejącego aktora B i przełączenie firmy: dwa POST z osobnymi
potwierdzeniami HTTP 200, bez tworzenia fixture lub sesji przez SQL.
Nowy capture06 zakończył się PASS: cztery pełne stare receipts, fingerprinty
47 tabel dla pięciu firm, tożsamości A/B oraz cały stempel 1703 zachowane.
READ ONLY/REPEATABLE READ, ROLLBACK i zamknięcie klienta potwierdzone.
Ten odczyt nie wywołuje źródła korekty wymagającego blokad zapisu i nie stanowi
nowego odbioru źródeł historycznych. Wcześniejsza próba DDL/seed czterech korekt
pozostaje osobnym dowodem. Root normalnie zamknął aplikację kopii (EXIT0);
oryginalna aplikacja N06 na 4105 pozostała uruchomiona.

## Niezależna kompilacja na pustej bazie

Root uruchomił jeden przypięty kompilator draft02 (sesja 15770, EXIT0).
Przed CREATE DATABASE rzeczywisty odczyt potwierdził brak innych klientów
runtime 57083. Kompilator odtworzył źródłowy program poprzednika i pełne 209,
a następnie wykonał dokładny kandydat 211 na nowej, pustej bazie. Nie używał
katalogu kopii biznesowej jako oczekiwań.

Wynik to 140 dodatków, 6 zmian i 2 usunięcia w ośmiu rodzajach obiektów.
Root i niezależny agent odtworzyli z całego katalogu 211 dokładnie 40 502
rekordy 209 oraz całą serializację 64 011 475 B/SHA `b3300ea8…`.
Sześć pełnych zmian i dwa usunięcia odpowiadają niezależnemu planowi źródłowemu.
Wszystkie pełne payloady 29 starych tabel certyfikatów pozostały identyczne.
Pełne 187/173, cztery kontrole modułowe i cztery cold capabilities przeszły
przed 211 przy niezmienionym limicie 8 s.

Po DDL 211 liczba wierszy metadata i seedowanych parents wynosiła 0,
a metadata_valid=FALSE zgodnie z brakiem seala na pustym źródle.
ROLLBACK, pusty schemat, DROP własnej bazy przy 0 klientach oraz zamknięcie
obu połączeń potwierdzono. Pełne 18 ról przed, po i na końcu są identyczne.
To pozwala opublikować stałe oczekiwania źródłowe; nie jest odbiorem Native211,
instalacji na zachowanych danych, UI/API ani procesu finansowego.

## Instalacja na kopii i rzeczywista korekta SQL

Pierwszy installer odmówił przed DDL przez brak wymaganego search_path;
ROLLBACK/end potwierdzone, bez COMMIT. Zachowano próbę run01. Minimalna V2
ustawia wymagany kontekst po BEGIN, bez zmiany czytnika lub limitów.

Root wykonał V2 raz (68627 EXIT0). DDL pełnego programu trwał 4257,455 ms.
Dokładny fixed inverse odtworzył cały katalog kopii 40 641→40 503 rekordy.
Zachowano globalne 47 tabel, 47 tabel każdej z pięciu firm, cztery stare
receipts i trzy pełne manifesty. Sześć pełnych kontroli zwróciło TRUE przy 8 s,
w tym ordinary187 w 4628,752 ms. Jeden COMMIT ma osobną intencję i ACK;
następny READ ONLY potwierdził seal, cztery parents i jeden marker migracji.
Generacja po rzeczywistym DDL wynosi 1744, dirty=true, bez validated generation.
Nie udzielano ręcznie approval i nie cofano stempla.

Następnie Root uruchomił rzeczywisty NativeQA (33936 EXIT0), na tej samej
oznaczonej kopii i istniejących przypadkach A/B. Wystawiono korektę
`QA211-53BD6/2026/000001`: FV 44,01 → korekta −27,00 → pozostałe 17,01.
Deferred COMMIT zakończył się ACK. Ten sam klucz zwrócił ten sam dokument
z reused=true, bez drugiego numeru, zmiany stocku, oryginalnej FV lub płatności.
Próby obcej firmy, prywatnego ACL i częściowego169 odmówione; wszystkie cztery
stare korekty i pozostałe firmy zachowane. Pełne guardy przed i po TRUE przy 8 s
(ordinary187 4497,666/4351,001 ms). ROLLBACK i zamknięcie klienta potwierdzone.
To odbiór SQL na kopii; nie wykonano refundu ani biznesowego UI/API.

Końcowe testy kontrolowane źródeł, strategii/UI, cold, pakowania i regresji:
131 PASS, 0 SKIP, 3307,876 ms; typecheck EXIT0. Nie są to 131 testy Native.

## Pozostałe warunki

Źródłowy wektor po niezależnym przeglądzie opublikowano jako stały kontrakt
i pełny program instalacyjny z sealem. Instalacja, SQL Native, actual COMMIT,
replay i odmowy są odebrane na kopii. Wymagane są nowy wspólny pakiet i zwykły
proces istniejącego RMA przez UI/API: korekta −27,00, pozostałe 17,01 i lokalny refund 27,00. Rejestracja 211
nie może aktywować 210. Cały nadrzędny Goal pozostaje otwarty.

## Dowody

Ścieżki są pod
`local-builds/full-base-preview-20261017/return-credit211-preserved-copy-root-20261018-01/`.

| Artefakt | SHA256 |
| --- | --- |
| `create.stdout.private.json` |`dc0984af6b1dcc89b4cce4e05982dcafb73d7c393481f1d82cec7aac246c0d41`|
| `restore.stdout.private.json` |`70504d8ae11d13348f1cb13fea8301b780db29b16f0715f1921e5df246f648d8`|
| `copy-owned-ready-root.private.json` |`fb96f0a2a3e4d55264d5519b09feb63457f1e39eb745a40d82a11ec5fe01f965`|
| `rollback-ddl-preflight01/result.private.json` |`35f7c417e6f5a90cc0d4a2fd1dabb61d9057b3dd24b8cef7846ec9d05e7db6d2`|
| `rollback-ddl-preflight01/before.private.json` |`aaaaf2cbd93cb30d6b7d1d340b8fe4e50075e7c63fa25ff96f98d85f68cb336a`|
| `known-nullability-and-authorities-root.private.json` |`aa525c466ce7efadc1edfd758af8211a1f3a95d08f9305424fd3469801f13b15`|
| `copy-app-setup01/ready-root.private.json` |`9309ce24c5cb955f626f0e765779b8aa242c013d7ce0ca92887feb851da3d800`|
| `copy-login-b-prepared-agent01/run01/result.private.json` |`e6b647d5d80b70e7640137a4f689f72e54fa130326681667a842c528f1edc78c`|
| `before211-capture06/result.private.json` |`d362330e6f2927b0dbe5fcd4c5c63957487202be01fcf536a6c6d4be7bf81a9a`|
| `before211-capture06/before211.private.json` |`86bd8d0b78d1d3fb4f27e5da35ba881f0320884cee5fb90eb8bb4f117363e1e7`|
| `install211-prepared-agent01/run02/result.private.json` | `186d29997ab6513ee2613fee5439a4bec6428e20e86d8e36988076f6f2cbd22f` |
| `install211-prepared-agent01/run02/source-expectation.private.json` | `581a68cf9f4c9ba9d2b072a5efdb2235131945815dc25204e70709b9a662e6cd` |
| `native211-qa-prepared-agent01/nativeQA01/result.private.json` | `54e7ff619ae4cebd94ee0114e977f5f8c94927cca1328363b4975e2c4b2e167a` |
| `native211-qa-prepared-agent01/nativeQA01/issue-ack.private.json` | `91dcb04792c965c1041ac78f0fb1b25e516ed105ddd0b4345f54d005618a6aaa` |
| `native211-qa-prepared-agent01/nativeQA01/same-key-replay-ack.private.json` | `2e85ada2317167170da6826056802675f59149adfe489217dcbed4116ce46848` |

Osobna kompilacja jest w
`local-builds/full-base-preview-20261017/return-credit211-empty-source-compiler-prepared-agent-20261018-01/run/`:

| Artefakt | SHA256 |
| --- | --- |
| `receipt.private.json` | `5f6898ea8db70e111714b67c4825438bb3f3490671d456449304f19e1db3aebd` |
| `root-review.private.json` | `c12fbf6fd56dafd2dda3939bb3fbb73355c44f22a5b3d712207fba68c452210f` |
| `source211.compiled-vector.private.json.gz` | `f778c2353173e65098df073340d5cf84272f35ae9d892c3ee95d1ee5db2f2ebe` |
