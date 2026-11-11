# DYNAMINDS Ecommerce — bieżący stan produktu

**CRM Base API: odbiór lokalny wydania N25b PASS (23.10.2026).** Wszystkie 11 metod
Clients (CRM) przez `connector.php` i UI na tych samych rekordach, dwie firmy, klucz
tylko do odczytu, restart: 3/3 + 28/28 + 6/6, Chrome PASS. Rewizja `62c5f113…`,
źródła `52ffd47`, schema219. Otwarte: start na bazie odtworzonej z dumpa (zgoda na
poprawkę normalizatora ACL), konto Base. [Raport](parity/CRM-N25B-LOCAL-20261023.md).
Poniższy wpis z 19.10 opisuje odrzucony wariant 218 (manifest zgodności).

**Source34: V34, kontrakt H34 i powiązania seala/zasobów odebrane źródłowo (23.10.2026).**
Program4525572 B/`685c16fb…` z `45f3278` (wybór constraintów valid przez OID
katalogu). Publikacja V34 bezPG: 494 dodatki/22 podmiany, 493 dodatki i cały
probe P24 bez zmian, jedyna zmiana to source/definition funkcji valid; pełny
inverse do Source33. H33 i V33 zostają historyczne i są jawnie odrzucane. Zestaw
98 plików cold/historii: 950 testów, 938 PASS/0 FAIL/12 SKIP (wcześniej 25 FAIL).
Kompilator, Native i aktywacja210 nadal OPEN; migracja210 nie jest zarejestrowana.
[Dowody i granice Source34](parity/SPLIT210-PREFIX37-LOCAL-20261018.md#uzupełnienie-source34-v34-i-kontrakt-h34).

**CRM: wygaszanie uprawnienia poprawione; odbiór wydania nadal OPEN.**
Lokalny commit `222e349` unieważnia proof po zakończeniu callbacku, również
po błędzie i przed ewentualną utratą ACK COMMIT. Zachowany port nie może go
ponownie użyć. Osiemdziesiąt trzy testy źródłowe PASS, typecheck0; nie jest to
odbiór PostgreSQL ani uruchomionego wydania. Commit `a8b19e0` przygotowuje siedem
jawnie wybieranych scenariuszy DB słowników; tych scenariuszy nie uruchomiono.
Rzeczywisty compile19 kandydata MOVE potwierdził pełne31/21 rekordów, lecz trzy
kontrole187/173/PIM nadal przekraczają8s. Profile38 wskazał137/164 wywołania ramki
w pojedynczych kontrolach. Prywatne pięć getterów ctx39 przeszło porównanie
87 wyników funkcji, dwóch definicji CHECK i trzech metadata, wymagane odmowy oraz ACL;
ROLLBACK odtworzył cały katalog217 i role. Nowy zamknięty graf15 oraz wspólne
wejścia wymagają osobnej integracji, kontroli35 kotwic i pełnego odbioru9.
Źródła11 metod i dawna matryca nie stanowią odbioru działającego Base API.
[Dowody i granice nowych prób](parity/BASE-WIRE-CRM218-IMPLEMENTATION-20261019.md).

**N24: działająca aplikacja, świeże odtworzenie i kontrolki bezpieczeństwa PASS.**
Normalny4105 i odtworzony4106 używają wydania `2e05da9f…`, źródeł `bd18f34`
i schematu217. Backup14 131 236 B odtworzono do nowej PG04;644 tabele,
731 zadań i uprawnienia zachowane. Po Chrome kopia ma dokładnie jedną nową
sesję, wszystkie stare144 zachowane; źródło bez zmian. MFA, hasło i kończenie
sesji są w podglądzie wyłączone. Pełne UI/recovery/skala i Goal OPEN.
[Dowody i granice odbioru N24](parity/N24-RECOVERY-READONLY-LOCAL-20261019.md).

**Kandydat CRM218: źródła i częściowe kontrole rzeczywistego SQL; nieaktywowany.**
Lokalny commit `382f3b5` obejmuje17 plików komponentów i testów źródłowych;
`4280abb` rozdziela test rejestracji aplikacji. Wspólna trasa rozpoznaje11 metod,
w tym sześć słownikowych, domyślnie zablokowanych przed auth i limitem tenanta
bez jawnej możliwości219. Leniwa kompozycja zachowuje pięć podstawowych metod
bez219; sześć testów kompozycji i40 testów tras/wire/rate/lifecycle PASS bez pominięć.
Nie jest to aktywacja218/219 ani Base wire w działającym N24.
Root sprawdził czysty, izolowany checkout: pełny typecheck0. Pierwszy zestaw
115 sprawdzeń miał114 PASS i jedną odmowę — test wymagał nieobjętej paczką
rejestracji w app. Cały test przeniesiono bez zmiany asercji do osobnego
`base-wire-crm-application-registration.test.ts`, pozostawionego z integracją WIP.
Po rozdzieleniu pięć testów lifecycle PASS w czystym checkout; pozostałe109
sprawdzeń wcześniej PASS: łącznie114 sprawdzeń komponentów źródłowych.
Test rejestracji aplikacji PASS w obecnym WIP, lecz integracja/DB i zwykły
odbiór API pozostają otwarte. Migracja219 nadal nieaktywna.
Aktualny compile17 potwierdził dziewięć kontroli przed migracją i sześć po niej;
187/173/PIM nadal przekraczają8s w ścieżkach historii209/odcisków177.
ROLLBACK do217 i zamknięcie klienta potwierdzone, bez podwyższania limitów.
Prywatny compile18 z trzema podmianami współdzielącymi ramkę dał ten sam wynik
9 przed/6 po i trzy timeouty. Nie promowano go do D SQL ani działającego wydania.
Rzeczywisty TEMP32 sprawdził zamknięte poddrzewo partial204 z jawnym kontekstem:
33 pary/66 wywołań zachowały pełne wyniki oraz odmowy NULL P0002/brak OID55000.
W tym zestawie ramka wykonała się90→21 razy; dla rodzica partial20411→1 na
wywołanie. Suma trzech wywołań rodzica:485,058→208,310ms czasu funkcji serwera,
oddzielnie485,631→208,868ms czasu zapytania klienta. To nie p95 ani wynik
pełnych dziewięciu kontroli. Publiczne funkcje i ramka niezmienione;
ROLLBACK do217, pełne osiem rekordów funkcji oraz role/członkostwa i end PASS.
Osobna rzeczywista próba schematu wygenerowanej kolumny odrzuciła siedem
niedozwolonych zapisów lub zmian; nie jest to odbiór pełnych dziewięciu kontroli.
30 testów kompatybilności i siedem compact PASS dotyczą źródeł. Bieżący pełny
SQL8208759 B (`a4f57b16…`) nie ma jeszcze aktualnego compact, rzeczywistego
A/B instalatorów, cold kontraktu ani odbioru biznesowego API.
[Bieżący inwentarz źródeł11 metod](parity/base-api-crm-source-inventory.v2.json)
potwierdza obecność adapterów i dispatchu11/11, ale nie kompletność semantyki:
odbiór zwykłego wydania i protokołu dostawcy nadal0/11.
[Historyczna matryca pięciu adapterów](parity/base-api-crm-coverage-20261019.json)
pozostaje bez zmian; jej dawnych pinów nie używa się jako dowodu bieżących źródeł.
Historyczny installer676785 B odtworzył w osobnych rzeczywistych transakcjach
te same39 pełnych rekordów funkcji, dwa CHECK, manifest i sidecary co pełny
plik7821317 B; obie próby zakończyły się ROLLBACK. To dowód równoważności
tamtej instalacji, bez przenoszenia wyniku na obecny kandydat.
Panel API/webhooków ma osobną poprawkę readonly i11 testów PASS w źródłach;
odbiór jej wspólnego wydania pozostaje otwarty. Kolejne bramki: rzeczywisty
odbiór218 i cold inverse218→217, zgodne piny pakietu oraz zastąpienie obecnej
bramki obecności tabel w app zweryfikowanymi możliwościami i dispatch11.
Sześć metod wymaga też osobnego odbioru219; obecna rejestracja używa serwisu
pięciu metod i nie włącza słowników. Pełny Goal OPEN.
[Kandydat, wynik DB i następny krok](parity/BASE-WIRE-CRM218-IMPLEMENTATION-20261019.md).

**N23: świeży backup/restore i zachowanie danych PASS; Chrome podglądu PARTIAL.**
Jedno odtworzenie do nowej PG04 zachowało wszystkie644 pełne count/SHA,
731 zadań,144 sesje oraz role. Nowy podgląd4106 działa z wyłączonymi workerami.
Chrome A pokazał odebrane zamówienie/płatność oraz blokady integracji,
organizacji i abonamentu. Po UI źródło644 całe; kopia643 całe plus dokładnie
jedna nowa własna sesja, wszystkie stare sesje zachowane. Otwarte: aktywne
kontrolki bezpieczeństwa konta oraz błędy części paneli zbiorczych zamówień.
Pełne UI/recovery/skala/Base API i Goal OPEN.
[Odbiór i ograniczenia N23](parity/N23-BACKUP-RESTORE-LOCAL-20261019.md).

**N23: normalny runtime i wąski Chrome D PASS; odtworzony podgląd OPEN.**
Źródła `2c8d332…`, 25 focused testów PASS, typecheck0. Pakiet `c148c9c9…`:
392 pliki/99 047 859 B, 1324 źródła, limity 16/96 MiB i 35 Native zachowane.
N22 integracje oraz N23 globalne tworzenie/ustawienia/billing mają source gates
read-only; ich odbiór w odtworzonym podglądzie N23 nadal OPEN, bez Base wire codec.
Root normalnie zatrzymał N21 i uruchomił N23 raz; READY c148, ta sama baza,
schema217/port4105/konfiguracja/flagi. Aktualizacja zachowała 643 całe tabele;
w całej generacji1887 zmienił się wyłącznie pin wydania, migracje bez zmian.
Chrome D: dashboard i odebrane zamówienie, 12,30 PLN source_import/due0 widoczne.
Po tym wąskim UI wszystkie 644 hashe i 28 pełnych zestawów identyczne po upgrade;
731 jobs/144 sesje i generacja bez zmian. To nie odbiór całego UI read-only.
Profile BR23 gotowe wyłącznie plikowo; fresh backup/restore i preview N23 OPEN.
Pełne recovery, skala, kompilator/Native Source34, Base wire i cały Goal pozostają OPEN.
[Dowody i granice N23](parity/RESTORED-PREVIEW-N23-PACKAGE-20261019.md).

**N21 D: naturalny import i osobny stock — UI/API oraz zachowanie danych PASS.**
Istniejące `5f5bc626…`, schema217; jeden natywny POST utworzył Woo D #12.
Dwa przyszłe cykle orders v3 DONE/ACK zachowały jeden receipt/order i płatność
source_import 12,30 PLN; inventory 8/1/7 v1→8/2/6 v2, bez drugiego importu.
Osobny UI stock+1: 9/2/7 v3; stock-only v1 → naturalny DONE/Woo 6→7 → pauza v2.
Orders v4/import v2/katalog v2 wyłączone. Monitor importu: 70 GET; stocku: 74 GET.
Świeże porównania zachowały cztery inne inventory i pięć dawnych order/payment DTO.
Natywne dwa GET: stare zamówienie całe, nowe #12 całe równe ACK; produkt #10
stock7→7, sales1→2/daty, pozostałe pola identyczne, related_ids puste.
Globalnie 644 bieżące hashe sprawdzone: stock 632 całe/12 dokładnych zmian,
import 622 całe/22 dokładne zmiany; 8+10 pełnych historycznych hashy odtworzonych
wyłącznie SELECT, RRRO8s/9s, ROLLBACK/end PASS. Wspólne końcowe porównanie pięciu
firm jeszcze przed odbiorem; liczba PUT, crash, skala i cały Goal pozostają OPEN.
[Odbiór i granice D](parity/LOCAL-WOO-IMPORT-STOCK-D-N21-20261019.md).

**N21 C: naturalny import i osobny naturalny stock — UI/API oraz zachowanie danych PASS.**
Istniejące `5f5bc626…`, schema217; jeden natywny POST utworzył Woo C #12.
Dwa przyszłe cykle orders v3 DONE/ACK zachowały jeden receipt/order i płatność
source_import 12,30 PLN; inventory 8/1/7 v1→8/2/6 v2, bez drugiego importu.
Osobny UI stock+1: 9/2/7 v3, konfiguracja stock-only v1 → naturalny DONE/Woo 6→7
→ pauza v2; orders v4/import v2/katalog v2 wyłączone. 70+72 GET zachowały świeże
inventory czterech innych firm i pięć wcześniejszych app order/payment DTO.
Końcowe dwa natywne GET: stare zamówienie całe, nowe #12 całe równe ACK;
produkt #10 stock7→7, sales1→2/daty, wszystkie pozostałe pola identyczne.
Globalnie 644 bieżące hashe sprawdzone: stock 632 całe/12 dokładnych zmian,
import 622 całe/22 dokładne zmiany; 8+10 pełnych historycznych hashy odtworzonych
wyłącznie SELECT, RRRO8s/9s, ROLLBACK/end PASS. Brak wyłączeń całego tenanta.
D, liczba PUT, crash/odzyskiwanie, skala, pełna automatyka pięciu firm i Goal OPEN.
[Odbiór i granice C](parity/LOCAL-WOO-IMPORT-STOCK-C-N21-20261019.md).

**N21 B: naturalny import i osobny naturalny stock — UI/API oraz zachowanie danych PASS.**
Istniejące wydanie `5f5bc626…`, schema217; jeden natywny POST utworzył Woo B #27.
Dwa przyszłe cykle orders v5 DONE/ACK zachowały jeden receipt/order i płatność
source_import 12,30 PLN; inventory 8/1/7 v1→8/2/6 v2, bez drugiego importu.
Osobny UI stock+1: 9/2/7 v3, stock-only v1 → naturalny plan/parent DONE/Woo 6→7
→ pauza v2; orders v6/import v2/katalog v2 wyłączone. Cztery inne inventory i pięć
wcześniejszych app order/payment DTO zachowane w świeżych porównaniach.
Globalnie 644 bieżące hashe sprawdzone: stock 632 całe/12 dokładnych zmian,
import 622 całe/22 dokładne zmiany; 8+10 pełnych historycznych hashy odtworzonych
wyłącznie porównawczymi SELECT. Dawny listing linked i dawny last_result odtworzone
w projekcji; bieżący publish i nowy wynik stocku są zgodne ze źródłowym zapisem Woo.
Pierwsza błędna asercja czytnika zachowana; poprawiony odczyt RRRO/RB/end PASS.
Liczba PUT, crash/odzyskiwanie, skala, C/D oraz pełna automatyka pięciu firm i Goal OPEN.
[Odbiór i granice B](parity/LOCAL-WOO-IMPORT-STOCK-B-N21-20261019.md).

**N21: sześć odczytów i wskazane widoki odtworzonej aplikacji — PASS.**
Normalne wydanie `5f5bc626…`, źródła `522fac7…`, ten sam schemat217 i baza.
Aktualizacja zachowała643 całe tabele; zmienił się tylko pin wydania w generacji1887.
Nowy backup/restore do oddzielnej PG04 zachował wszystkie644 pełne hashe i719 zadań.
Odbiór16 API: pełne DTO,2 odmowy423 i4 cudze404; snapshot9ms/status4ms to pojedyncze
próbki, nie p95. Chrome A potwierdził zamówienie/płatność, lokalne odświeżanie oraz
zablokowane zapisy w konfiguracjach płatności i statusów. Po odbiorze źródło644 całe;
kopia643 całe plus jedna własna sesja, wszystkie dawne dane i role zachowane.
Cały UI preview nadal PARTIAL: inne przyciski dodawania/testowania/importowania
integracji wymagają N22. Pełne recovery, skala, pięć firm i cały Goal pozostają OPEN.
[Odbiór i granice N21](parity/RESTORED-PREVIEW-N21-LOCAL-20261019.md).

**N20: zaszyfrowany backup i odtworzenie DB/konfiguracji/obrazu/kolejki — PASS.**
Root odtworzył kopię PG03 do nowej bazy PG04; źródło nie było celem restore.
W obu bazach wszystkie 644 liczności i pełne kanoniczne SHA256 odpowiadają
końcowemu stanowi po stock A. Kolejka 719 zadań zachowana: 119 DONE, 3 failed,
597 pending; zadania nie zostały uruchomione. Konfiguracja z kluczem i jeden obraz
odtworzone; 18 ról i 3 członkostwa każdego klastra pozostały bez zmian.
Niezależna końcowa kontrola RRRO 8s/9s, 0 zapisów, ROLLBACK/end PASS.
Podgląd odtworzonej aplikacji uruchomiony: Chrome A zalogował i pokazał płatne
zamówienie/płatność, ale odbiór PARTIAL — przyciski mutacji nadal aktywne w UI,
odczyt statusu 500 pod obciążeniem i timeout inventory. Dwa żądania odmówione 423.
Poprawki UI/API wymagają następnego wydania; pełny prywatny filesystem, pełne
odzyskiwanie, skala i wszystkie 5 firm pozostają OPEN.
Kompilator/Native Source34 i pełny Goal OPEN. [Odbiór i granice](parity/N20-BACKUP-RESTORE-LOCAL-20261019.md).

**N20 A: naturalny import oraz osobny naturalny stock — UI/API PASS.**
Bez nowego wydania: istniejące `221a27dd…`, schema 217. Po UI opt-in importu v1
jeden POST utworzył lokalne Woo A #31; monitor wystartował przy orders v7 paused.
Po UI enable v8 dwa przyszłe cykle DONE/ACK zachowały jeden receipt/inbound/order
`265ece16…` i płatność source_import 12,30 PLN — deklaracja źródła, nie banku.
Inventory A 9/1/8 v2→9/2/7 v3; drugie wykonanie bez duplikatu. 53 GET zachowały
cztery pozostałe inventory i pięć dawnych order/payment DTO. Chrome potwierdził
import i osobne pauzy orders v9/import v2; katalog v4 nadal wyłączony.
Globalnie 644 uzgodnione: 622 całe/22 dokładne zmiany, 10 pełnych historycznych hashy
odtworzonych tylko w projekcjach SELECT. Dwa native GET: 12 starych pełnych order DTO
bez zmian, nowe #31 równe ACK; 7 produktów z jawnym wyjątkiem related_ids.
Osobny UI stock+1: 10/2/8 v4; config v1 → naturalne DONE/Woo 7→8 → pauza v2.
Listing bez zmian; globalny stock: 633 tabele całe/11 dokładnych zmian/7 pełnych inverse PASS,
42 GET: ceny i sales 2 bez zmian, nowe A order/payment zachowane; native orders sprawdzono przed stockiem.
Liczba PUT/crash/pełne odzyskiwanie/skala i automatyka wszystkich 5 firm nadal OPEN.
Pełny Goal OPEN. [Odbiór i granice importu A](parity/LOCAL-WOO-IMPORT216-A-N20-20261019.md).

**N20: edytor definicji CRM217 — normalne wydanie, Chrome/API PASS.**
Wydanie `221a27dd…`, źródło `3212ef1…`, schema 217; ta sama baza i pięć sklepów.
Bez DDL: 643 pełne hashe zachowane, w generacji 1887 zmieniono tylko release SHA.
Poprawiono odczyt 217 bez uprawnień do migrations; sześć realnych prób roli dyna_app PASS.
Chrome E: pięć poleceń, użyta opcja 422, wartość „Pilne” i aktywne pole po reloadzie.
API A: 150 żądań / 28 unikalnych poleceń; siedem typów, kolejność, CAS, archiwizacja,
przywrócenie, prywatny plik i oryginalne ACK/anulowanie. 12 cudzych 404 zachowanych.
Globalne CRM: wszystkie 644 uzgodnione — 638 tabel całych, 6 dokładnych zmian,
33 polecenia / 33 audyty A28/E5; wszystkie pozostałe stare wiersze zachowane.
Naturalny stock E: UI 8/2/6→9/2/7, konfiguracja v2, plan/parent DONE i Woo 6→7;
po osobnej pauzie v3 wyłączone. Dwa własne zadania/dispatch/ACK z exact checkpoint PASS.
Natywne końcowe 2 GET: tylko stock/daty produktu zmienione; ceny/total_sales 2 i oba
pełne DTO zamówień Woo #11/#12 bez zmian. Globalny stock PASS: 644 uzgodnione,
632 całe/12 dokładnych zmian; 8 pełnych historycznych hashy odtworzonych projekcjami SELECT.
Liczba żądań PUT po stronie lokalnego Woo nieudowodniona.
Osobny [import E w N19](parity/LOCAL-WOO-IMPORT216-N19-20261019.md) odebrany bez duplikatu.
Runtime read-only, Base wire, crash/restore, skala i stock/import wszystkich 5 firm
pozostają nieodebrane; pełny Goal OPEN. [Wyniki i granice N20](parity/CRM217-N20-LOCAL-20261019.md).

**N18: lokalny CRM — normalna aktualizacja, Chrome/API i zachowanie danych PASS.**
Wydanie `be813a84…`, schema215, ta sama baza i pięć lokalnych sklepów.
Chrome E: profil, częściowa zmiana danych, grupa/status, siedem edytorów wartości,
prywatny CSV i relacja istniejącego zamówienia; trwałość po reloadzie potwierdzona.
96 żądań API obejmuje słowniki, archiwizację, oryginalne ACK/anulowanie oraz
12 cudzych404. Pięć pełnych DTO zamówień przed/po identycznych. Po aktualizacji
631 dawnych tabel bez zmian; po UI/API633 całe tabele identyczne, pozostałe
zmiany audytu/CRM rozliczone31 poleceniami/31 audytami.140 sesji/709 zadań/10 pauz
zachowane; generacja1854/validated1854/dirty=false. Edytor definicji217, Base wire,
automatyczne importy/zapisy, crash/restore, skala i pełny Goal OPEN.
[Odbiór N18](parity/CRM215-N18-LOCAL-20261019.md).

**N17: trwałe ustawienia synchronizacji — normalna aktualizacja, Chrome/API i zachowanie danych PASS.**
Wydanie `84ea2dc7…`, schema214, ta sama baza i pięć lokalnych sklepów;
generacja1789/validated1789/dirty=false. Chrome E zapisał wyłączoną konfigurację
v1; API odczytało dokładny pierwotny ACK, cztery obce firmy otrzymały404.
Osobne anulowanie przed spóźnionym poleceniem zwróciło ten sam CANCELLED,
bez zmiany pełnego GET konfiguracji/zadań. Wszystkie17 odpowiedzi zachowane.
Pełna kontrola633 tabel publicznych:630 po aktualizacji bez zmian; dokładne
2 audyty,1 konfiguracja i2 polecenia rozliczone. Wszystkie16 dawnych pełnych
hashy wierszy odtworzone,140 sesji/709 zadań/10 pauz zachowane. Automatyczne
zapisy/importy, awaria procesu, restore, skala i pełny Goal OPEN.
[Odbiór N17](parity/OFFER-SYNC-N17-LOCAL-20261019.md).

**Source214: trwałe polecenia konfiguracji synchronizacji ofert — kod i kompilacja PASS.**
Journal zachowuje oryginalny wynik zapisu; UI uzgadnia utratę ACK przez odczyt
lub anulowanie, bez automatycznego ponowienia. Odczyt wyniku rzeczywiście READ ONLY;
świeże IAM, izolacja firmy/kanału, WebLock i trwałe próby między kartami sprawdzone.
102 testy kontrolowane backendu/React/zasobów i typecheck PASS. Pełna niezależna
kompilacja:43 dodatki,0 zmian/usunięć wcześniejszych deskryptorów,14 kontroli TRUE
przy8s; ROLLBACK/klienci/drop/role potwierdzone. Późniejszy N17 opisany powyżej
odebrał normalne wydanie214 i Chrome/API. Automatyczny executor stanów, importy,
skala i pełny Goal OPEN. [Dowody i granice214](parity/OFFER-SYNC-COMMANDS214-SOURCE-20261019.md).

**N16: pięć firm × dwa pierwsze naturalne odczyty oraz osobne pauzy PASS.**
Bez nowego wydania: istniejący N15 `aa143236…`, schema213. Root jawnie włączył
10 harmonogramów w UI. Kolektor po pauzach potwierdził10 pierwszych terminów:
DONE/ACK, zamówienia12/14/1/1/1 z pełnymi source_hash, katalogi7/3/1/1/1 staged.
Dwa późniejsze orders A/B również zachowane jako DONE; łącznie12 nowych wykonań.
Wszystkie kontrole wstrzymane: A7/4, B4/2, C/D/E2/2. Końcowe32 GET zachowały
pełne porównywane biznesowe i natywne DTO; izolacja przed i po: po15 cudzych404.
Stary obserwator84GET odrzucił istniejący ERROR A14; próba zachowana, poprawny
odczyt dowodów wykonano bez replay procesora. Globalne632:621 pełnych hashy
identycznych,11 dokładnych zmian uzgodnionych, wszystkie wcześniejsze wiersze
zachowane;9 własnych sesji UI i13 pełnych produkcyjnych projekcji katalogu rozliczone.
Po wszystkich GET/Chrome wszystkie632 hashe nadal identyczne ze stanem after.
Długotrwała automatyka, crash/inflight recovery, skala, automatyczne importy/stock
i pełny Goal OPEN.
[Wyniki i granice N16](parity/FIVE-NATIVE-WOO-NATURAL16-20261019.md).

**N15: jawne rozstrzygnięcie starego A → nowe naturalne DONE → pauza v5 PASS.**
Wydanie `aa143236…` uruchomiono normalnie z migracją213.629 pełnych hashy starych
tabel zachowanych; jedyne zmiany aktualizacji to migracja i czysta generacja
1769→1782. Chrome zakończył starą próbę A administracyjnie: occurrence aborted,
job failed, historyczny dispatch started i pierwotny wynik UNCONFIRMED.
628 pełnych tabel zachowanych; controls, dispatch i attempts/payload/dedup
zadania bez zmian. Ręczne retry/run-once: dwa409 i wszystkie632 tabele identyczne.
Osobne Wznów v4 uruchomiło nowe naturalne wykonanie: DONE, jeden dispatch ACK,
12 istniejących zamówień ponownie odczytanych do inbound, bez nowych importów
biznesowych. Po osobnej pauzie zamówienia A v5 wyłączone. Końcowe32 GET200/0POST
zachowały pełne porównywane biznesowe i natywne DTO pięciu sklepów.
Globalne uzgodnienie632 tabel:624 pełne hashe identyczne, osiem dokładnych zmian
z pełnym inverse zachowuje wszystkie stare wiersze. Zwykły restart przy pauzie
zachował wszystkie632 tabele, generację1782 i dokładny pierwotny abort ACK.
Awaria procesu, restart w trakcie odczytu, pięć aktywnych firm, pełna automatyka,
skala i pełny Goal OPEN.
[Wyniki i granice N15](parity/LOCAL-WOO-READ-RECONCILIATION15-20261019.md).
Poniższe wpisy opisują wcześniejsze etapy odbioru.

**N14: normalny start i jeden naturalny odczyt zamówień B PASS; stare A nadal OPEN.**
Wydanie `f11d25a3…` dodaje bezpieczny odczyt zachowanej diagnostyki, bez retry lub
resetu. Aktualizacja zachowała631 tabel poza jednym release SHA; generacja1769
bez zmian. Chrome A uczciwie pokazuje brak zachowanej przyczyny starego UNKNOWN.
Naturalne wykonanie B osiągnęło DONE z jednym potwierdzonym dispatch, bez
aktywnej dzierżawy;14 istniejących zamówień ponownie odczytano do inbound, bez
nowych importów biznesowych. Chrome potwierdził DONE i osobną pauzę v2.
Końcowe32 GET200/0POST zachowały pełne biznesowe i natywne DTO pięciu sklepów
oraz starą historię/job A; pełnego uzgodnienia631 tabel po cyklu B nie wykonano.
Nieudany obserwator z błędną referencją expected został zachowany i uzgodniony
bez replay. Wznowienie, restart, pięć aktywnych firm, skala i pełny Goal OPEN.
[Wyniki i granice N14](parity/LOCAL-WOO-READ-DIAGNOSTICS14-20261019.md).

**N13: anulowanie i dwa naturalne odczyty katalogu PASS; zamówienia nadal OPEN.**
Wydanie `085237ff…` zachowało przed UI wszystkie631 tabel poza zatwierdzonym
release SHA, generacja1769 bez zmian. Chrome anulował oryginalne UNKNOWN bez
ponowienia; dokładny wynik, wstrzymany wpis v1 i audyt rozliczone. Po włączeniu
katalog zakończył dwa naturalne wykonania, każde po7 staged wpisów i jednym
potwierdzonym dispatchu. Zamówienia pozostały running z aktywną dzierżawą;
obserwator odmówił po180s. Po pauzie obu konfiguracji osobny audyt45 GET200/0POST
potwierdził całą historię3 wykonań oraz zgodność biznesowych i natywnych DTO pięciu
sklepów; B–E bez automatyki. Nie resetowano ani nie ponawiano zadania. Pełne
workery, uzgodnienie całej bazy po cyklach i Goal nadal OPEN.
[Proces i granice N13](parity/LOCAL-WOO-READ-RECOVERY13-20261019.md).

**Historyczny N12: zwykła aktualizacja212 i zachowanie danych PASS.**
Wydanie `0d9c1597…` uruchomiono normalnie na tej samej bazie i pięciu sklepach,
z aktywnym procesorem odczytów. Wszystkie stare dane627 tabel zachowane;
doszły cztery puste tabele, generacja1744→1769 zatwierdzona. Pełne14 bramek SQL
przed/po212 TRUE przy8s. Chrome A pokazuje dwa harmonogramy60s i pustą historię.
Pierwsze włączenie w UI ujawniło500: parser PG potwierdził dwa konflikty typów
SQL. UI zachował niepewne polecenie bez ponowienia; później wszystkie631 tabel
pozostały identyczne. Poprawka wymaga kolejnego wydania. Naturalne cykle,
pauza/wznowienie, restart i odbiór pięciu firm nadal OPEN.
[Wydanie i dowody](parity/LOCAL-WOO-READ-LANES212-20261019.md).

**Pięć sklepów: zachowanie wcześniejszych danych i korekta UI → stan Woo PASS.**
Uzgodniono wcześniejsze wiersze wszystkich627 tabel po importach:604 bez zmian,
23 z dokładnie217 nowymi wierszami i pięcioma projekcjami kanałów. Następnie
Chrome firmy A zapisał korektę+1:9/1/8. Podgląd samego stocku, kolejka i ręczne
wykonanie istniejącego procesora zmieniły Woo7→8; pozostałe cztery firmy nadal
8/1/7 i Woo7. Ceny, zamówienia i rozliczenia zachowane. Automatyczne odczyty,
pełne późniejsze uzgodnienie bazy, skala i pełny Goal nadal OPEN.
[Proces i dowody](parity/FIVE-NATIVE-BUSINESS-LOCAL-20261019.md).

**Pięć oficjalnych lokalnych sklepów: produkt → import → zamówienie → rezerwacja PASS.**
Pięć firm, wspólny świeżySKU, odrębne lokalne produkty/zamówienia; wszędzie
8/1/7 i Woo7, po12,30PLN bez wpłat. Pięć cudzych zamówień404;160ACK wznowienia
uzgodnione. Znany produkt pierwszej próby wykorzystano bez drugiegoPOST.
Chrome E potwierdza stan i zamówienie. Późniejsze uzgodnienie zmian23tabel
i zapis stanu A opisano powyżej; automatyczne workery i skala pozostają OPEN.
[Rzeczywiste procesy i granice](parity/FIVE-NATIVE-BUSINESS-LOCAL-20261019.md).

**Source33/C35: rzeczywisty pełny kompilator nadal odmawia przy8s.**
199+27 etapów,494/22 i pełny inverse40502 zgodne; cztery osobne guardy TRUE.
Pełny ordinary187 po210:57014/8003,862ms. ROLLBACK, oba zamknięte klienty,
DROP przy0 połączeń i18 ról uzgodnione. Bez COMMIT kandydata, Native i aktywacji.
[Wynik i granice C35](parity/SPLIT210-C35-LOCAL-20261018.md).

**Pięć firm i sklepów: zwykły start N11, podłączenie API i widoki Chrome PASS.**
Pięć rzeczywistych rejestracji; normalny restart z pięcioma sklepami zachował
wszystkie 627 tabel i cały stempel1744. Pięć podłączeń:5POST201+24GET,
pięć cudzych kanałów404, stara firma nadal bez sklepów; pełneACK uzgodnione.
Pięć normalnych logowań Chrome potwierdza własne podłączone kanały i adresy.
Produkt/zamówienie/import/sync, aktywne workery i skala
pozostają OPEN. [Dowody i następny proces](parity/FIVE-NATIVE-CHANNELS-LOCAL-20261018.md).
Starszy wpis N11 z zerem wybranych sklepów poniżej opisuje poprzedni start.

**Source33: źródła, V33, kontrakt H i powiązania seala/zasobów odebrane źródłowo.**
47 testów oraz8 testów kolektora PASS; rzeczywista kolekcja i publikacja bezPG.
493 dodatki/22 podmiany oraz cały dawny probe P24 zachowane; jedyna zmiana
to source/definition funkcji valid,100 pinów zgodnych. Promocja H/seal/zasobów
ma77+39 testów kontrolowanych PASS; koordynator osobno potwierdził cały inverse
H33→H32 oraz5 aktualnych testów. Późniejszy C35 wykonał pełny kompilator,
lecz odmówił przy8s; Native nie osiągnięto. To odbiór źródeł, N11 nie aktywuje210.
[Dowody i granice Source33](parity/SPLIT210-PREFIX37-LOCAL-20261018.md).

**Oficjalne Woo C/D/E: trzy świeże instalacje, zwykły start i natywne API PASS.**
WordPress7.1.3/Woo11.2.1, przypięte TLS/CA, normalne logowanie i klucze,
odczyty wersji/products/orders,401 bez klucza i logout:27 żądań/6POST.
A/B zachowane. Nowe drzewa około604MiB bez kopii zależności. Podłączenie pięciu
firm do N11, import/sync/workery i skala pozostają OPEN.
[Dowody i granice C/D/E](parity/OFFICIAL-WOO-CDE-LOCAL-20261018.md).

**Bieżące N11 `8d8f8bdd…`: normalny start, zachowane dane, API i Chrome PASS.**
Obsługa do pięciu skonfigurowanych lokalnych sklepów jest spójna w registry,
transporcie, automatyce i UI;49 testów/typecheck PASS. Kontrakt61/26/29 i świeży
build384 plików zweryfikowane. Aktualizacja zachowała626 tabel biznesowych,
tylko release pin zmieniony;11GET i Chrome bez zmian biznesowych, końcowe627
tabel identyczne. Ten start nie wybiera sklepów/workera; rzeczywiste pięć firm,
import/sync, skala i pełny Goal pozostają otwarte.
[Dowody i granice N11](parity/FIVE-STORE-N11-LOCAL-20261018.md).

**D37: szybsze zapytanie metadanych, pełna lokalna zgodność; split nadal otwarty.**
Rzeczywiste20 par10AB/10BA: p95 25,309→19,484ms; sześć pełnych wyników
516/519/516 i42 świadki NAME/C zgodne. Root uzgodnił494/22, inverse40502,
końcowy40996,84 payloady certyfikatów i cleanup. Bez instalacji kandydata,
pełnego187 po210, Native lub biznesowego odbioru. [Pomiar i granice D37](parity/SPLIT210-PREFIX37-LOCAL-20261018.md).

**Bieżące N10 `07c760b0…`: lokalizacje odporne na spóźnione odpowiedzi; normalny start, API i Chrome PASS w opisanym zakresie.** Aktualizacja zachowała626 tabel biznesowych; zmienił się tylko pin wydania, generacja1744 bez zmian. Jedenaście GET i Chrome potwierdziły8/1/7, historię, zmianę filtra/magazynu i dawny podpis skany3/3/zarezerwowane1. Końcowe627 tabel bez zmian po UI.21 testów i typecheck PASS. Nowy odczyt quota eBay ma kontrolowane testy adaptera/handlera/UI; bieżąca firma nie ma kanałów, więc zwykły panel i konto dostawcy nadal nieodebrane. [Wydanie i granice N10](parity/STOCK-EBAY-N10-LOCAL-20261018.md).

**D36: aktualny koszt split210 zmierzony; funkcja nadal nieodebrana.** Jedno instrumentowane ordinary187 przy8s zakończyło się57014/8001,589ms. Porównywalne zakończone wywołania order_split210_valid:277/4289,805ms SELF; osobny dokładny captureSQL execution15,224ms, z największym kosztem own constraints/triggers. Pełne494/22 i inverse40502, końcowy katalog40996,84 dawne payloady certyfikatów,213/148 pinów oraz rollback/drop0/oba klienty/18 ról rozliczone. EXIT0 dotyczy diagnostyki, bez COMMIT/Native/aktywacji i odbioru wydajności. [Pomiar i granice](parity/SPLIT210-CALL-PROFILE36-LOCAL-20261018.md).

**Bieżące N09 `75f23960…`: podpis kompletacji — zwykły start, API i Chrome PASS.** Ten sam przypadek po wydaniu 2 z 3 sztuk pokazuje „A-01 · skany 3/3 · zarezerwowane 1 szt.”, a Magazyny nadal 8/1/7. Świeży Vite, typecheck EXIT 0 i 383 pliki pakietu sprawdzone; wszystkie pliki poza frontendem identyczne z N08, bez migracji SQL. Normalny upgrade zachował 626 tabel biznesowych spośród 627; zmienił się wyłącznie pin wydania, generacja 1744 bez zmiany. Jedenaście GET potwierdziło pełną zgodność biznesowych DTO i starego RMA; Chrome bez zapisów biznesowych. To wąski odbiór podpisu, bez zamknięcia ręcznej blokady lokalizacji, WMS ON, skali lub całego Goala. [Dowody i granice N09](parity/PICKING-CAPTION-N09-LOCAL-20261018.md).

**Split210 Source32/C34 — pełne494/22 zgodne, zwykły187 nadal timeout8s.** Rzeczywiste199+27 etapów, cały inverse40502/64011475 B i28 payloadów certyfikatów zgodne. Cztery guardy TRUE, potem ordinary18757014/8002,680ms w live_changed; wynik logiczny nieznany. ROLLBACK/drop0/oba klienty/18 ról potwierdzone; bez COMMIT, Native i aktywacji N09. P24/V32/H/inverse/seal/installer mają odrębny odbiór źródłowy. Source32 nie rozwiązał timeoutu. [Wynik i następny pomiar](parity/SPLIT210-C34-LOCAL-20261018.md).

**Historyczny odbiór N08:** poniższy wpis zachowuje ówczesny stan; wskazana w nim otwarta etykieta została później odebrana w N09.

**Wydanie N08 `37111698…`: pozostała rezerwacja lokalizacji — zwykły start, API i Chrome PASS.** Normalna aktualizacja zachowała 626 tabel biznesowych spośród 627; zmieniło się wyłącznie przypięcie wydania w `ordinary182_runtime_generation`, generacja nadal 1744. Ten sam własny przypadek z N07: zamówione 3, wydane pierwszą paczką 2, pozostała rezerwacja 1. Jedenaście GET bez zapisów potwierdziło w lokalizacji **stan 8 / rezerwacja 1 / dostępne 7**, a pozostałe biznesowe DTO i stare RMA były identyczne. Chrome potwierdził te wartości w Magazyny → filtr SKU → Szczegóły. Osobna etykieta kompletacji OMS nadal pokazuje historyczne „3/3 szt. zarezerwowane” i pozostaje OPEN; nie przyznajemy odbioru wszystkich liczników OMS, ręcznej blokady lokalizacji, pełnej skali ani całego Goala. [Dowody i granice N08](parity/STOCK-LOCATION-RESERVATION-LOCAL-20261018.md).

**Historia odbiorów:** poniższe wpisy o N07 i wcześniejszych wydaniach zachowują stan z chwili danego odbioru; ich dawne ograniczenia nie opisują nowszego N08.

N07 `9f0336c2…`: lokalny proces RMA przez zwykły Chrome/API i końcowy SQL PASS. Normalna aktualizacja zachowała przed UI 623 stare tabele i cztery wcześniejsze korekty. Wystawiono `KOR-RMA211/2026/000001` na −27,00 zł do FV 44,01 zł i osobno potwierdzono lokalne rozliczenie 27,00 zł, bez przelewu. Osiem GET 200, odświeżenie i druk potwierdzają jeden numer, `already_credited`, RMA `closed`, `refunded=2700`, `net=1701` i `overpayment=0`. Końcowe 627 tabel: 614 identycznych; wszystkie 13 legalnie zmienionych odtworzyły dokładne pełne hashe sprzed UI po rozliczeniu konkretnych nowych wierszy i dwóch zmienionych nagłówków. Stock, historia148, stare cztery korekty, stempel 1744 oraz jobs/outbox zachowane; metadata211 TRUE przy 8 s, READ ONLY/ROLLBACK/end TRUE. Jeden lokalny przypadek bez dostawcy płatności; pełny Goal, split, skala i pozostałe procesy pozostają otwarte. [Dowody i granice](parity/RETURN-CREDIT211-UI-LOCAL-20261018.md). Kolejne wpisy zachowują historyczny stan przed tym odbiorem N07.

211: instalacja i rzeczywisty SQL Native na odtworzonej kopii PASS. Po pełnym source inverse, zachowaniu 47 globalnych tabel, pięciu firm i czterech starych korekt pojedynczy COMMIT oraz odczyt potwierdziły instalację. NativeQA wystawił korektę −27,00 do FV44,01 (pozostałe17,01); replay zwrócił ten sam dokument bez nowego numeru i zmian stocku. Pełne guardy przed/po TRUE przy8s. 131 testów kontrolowanych PASS/0SKIP, typecheck EXIT0. Generacja kopii1744/dirtytrue jest niezatwierdzona, a oryginalny N06 nadal bez211. Wspólne wydanie, zwykły UI/API i lokalny refund pozostają otwarte. [Dowody i granice211](parity/RETURN-CREDIT211-PREFLIGHT-LOCAL-20261018.md).

N06 `a07922b9…` uruchomiono normalnie na zachowanych danych po łagodnym zamknięciu N05. Cały stempel1703 zgodny poza zatwierdzoną rewizją. Ten sam pełny GET zamówienia: p95 **1270,925→357,622ms**, pełna zgodność DTO przy2 warmupach+20 kolejnych próbkach, bez workerów i zapisów. Chrome potwierdził walidację NIP oraz jasną odmowę korekty istniejącego RMA zamiast starego panelu z409. Osobny pełny187 zwrócił TRUE w4450,635ms przy8s/UTC/jit=off, READ ONLY, ROLLBACK/end TRUE. To pojedynczy wynik; wcześniejsze timeouty, powtarzalność i skala pozostają otwarte. Korekta/refund tego przypadku,211 i nadrzędny Goal nadal nieodebrane. [Odbiór i granice N06](parity/ORDER-READ-N06-LOCAL-20261018.md). Poniższe wpisy o N05 zachowują historyczny stan.

Najnowszy częściowy odbiór N05 `74f74791…`: normalny współstart aplikacji i ograniczonego workera na zachowanej bazie ze stemplami1703, po117 GET przed/po starcie workera i IAM40 żądań/5 POST z ACK. Normalny Chrome potwierdził historię i wyniki25+1. Worker zakończył się łagodnie EXIT0; aplikacja i dane pozostały zachowane, health4100/4103/4105=200 z tymi samymi rewizjami. Profil trzech odczytów harmonogramów ma p95=6,501/6,799ms; osobny GET pełnego zamówienia:20 próbek,p95=1270,925ms. To odrębne lokalne profile, bez odbioru skali Goala lub pełnego187. [Dowody i granice](parity/READ-TRANSACTIONS-LOCAL-20261018.md).

RMA na N05: FV44,01 i fizyczne sale1/custody1/reject1 potwierdzone, lecz źródło korekty odmawia409 z powodu braku powiązanego receipt169. Korekta i lokalny refund pozostają otwarte. NIP `ec342bb`, recovery `c902a7f`, dowód GET `bb8782f` i komunikat RMA `3258296` są późniejszymi zmianami źródeł, jeszcze poza N05; nie oznaczają odbioru nowego wydania. [Częściowy odbiór RMA](parity/RMA-UI-LOCAL-20261018.md).

Stan na 18.10.2026: wydanie `d7b99d11…` odebrało lokalny współstart aplikacji i ograniczonego workera bez zmiany całego stempla1703, historię26 wykonań i26 wyników na stronach25+1 przez API oraz Chrome, a także sześć przypadków dostępu/IAM. Pierwszy worker zakończył się EXIT0. Późniejsza pełna kontrola zamykająca odmówiła na ordinary187:57014 przy8s, przed kontrolą danych i HTTP; ROLLBACK i zamknięcie klienta potwierdzono. Odrębna diagnostyka danych02 zakończyła się PASS: zachowane26 skutków, pełne26 wierszy historii,652 cudze zadania i7 GET200, z ROLLBACK/end; pełny187 nie został w niej wykonany ani odebrany. Osobny naturalny termin60s zakończył dwa wykonania26+0 bez ręcznego run; UI potwierdził pauzę v3, a końcowy odczyt danych52 zdarzenia i brak aktywnych zadań tego zakresu. Po łagodnym restarcie i wznowieniu w UI odebrano trzeci naturalny pusty run bez zmiany26 zamówień, stocku i historii; końcowy SQL potwierdził pauzę v5 i zachowanie danych. Własne workery i aplikacja zakończyły się EXIT0, pięć PID i port4105 nieobecne. Pełny187, crash recovery i nadrzędny Goal pozostają otwarte. [Dowody i zachowane błędy](parity/SCHEDULE-WORKER-COSTART-LOCAL-20261018.md).

Pakiet16 Source22b osiągnął **APP READY** na zachowanej kopii danych. Na tym samym wydaniu odebrano przez zwykłe API połączenie do głównego zamówienia, a przez Chrome utworzenie nowego zamówienia technicznego z odziedziczonym adresem. Ponowny odczyt i otwarcie potwierdziły historię oraz wyłączoną korektę adresu w portalu. Odbiór MERGE dotyczy lokalnych ręcznych, nieopłaconych par z WMS OFF. Osobne wydanie209 odebrało lokalny lifecycle API–worker–SMTP z pause/drain/restart. Kolejne wydanie `bd46ebfa…` odebrało normalny start po restore oraz rzeczywiste tworzenie, aktywację, pauzę i wznowienie reguł przez UI dwóch firm:19 zapisów,5 lokalnych skutków SMTP, końcowe uzgodnienie danych i zamknięcie własnych procesów. [Dowody UI i granice](parity/WORKER-UI-CONTROL-LOCAL-20261018.md). Pełne OMS, split, integracje, pozostałe workery, skala i recovery nadal pozostają otwarte. [Zakres MERGE](parity/MERGE209-LOCAL-ACCEPTANCE-20261018.md). Pełny [Goal](FULL-BASE-GOAL.md) pozostaje aktywny. Poniższe wpisy o wcześniejszych próbach zachowują historyczne granice dowodów.

| Obszar | Potwierdzony stan | Granica odbioru |
|---|---|---|
| Harmonogramy — wspólny start aplikacji i workera | WydanieD7/382 pliki na zachowanych danych: oba odczyty przed/po starcie workera porównały cały stempel1703,26 skutków, zapas26/26/0 i ten sam hash652 cudzych zadań. Osobne209/187 TRUE przy8s i po3 GET200; pierwszy ograniczony worker po25 kolejnych pustych runach zakończył się EXIT0. | Zachowano wcześniejszy315b GET500 oraz osobny błąd obserwatora TimeZone. Późniejszy closing01:18757014 przy8s, przed danymi/HTTP, wynik logiczny nieznany; ROLLBACK/end TRUE. Data-only02: PASS dla26 danych, całej historii26,652 zadań i7 GET200;187 niewykonany/nieodebrany. Osobny termin60s:26+0 bez ręcznego run, UI pauza v3,26 nowych receipts/26+0 elementów/52 zdarzenia,1703 i652 cudze zadania bez zmian; worker tego etapu EXIT0. Łagodny restart/wznowienie: trzeci naturalny run0, historia3 i pełne zachowanie danych; UI pauza v5. Własne procesy EXIT0/PID-y i4105 nieobecne. Pełny187 i crash recovery pozostają otwarte. [Raport](parity/SCHEDULE-WORKER-COSTART-LOCAL-20261018.md). |
| Matryca — zachowanie odkrytych kodów katalogu | Freezer obsługuje osobne opcjonalne catalogue_inventory i odrzuca utratę znanych kodów z przypiętych wejść rodzica. Root19/19 PASS,0 SKIP; niezależnie sprawdzono kształt2052 zapisanych kodów. Wymagania i liczby operacji bez zmian. | Odbiór narzędzia i testów kontrolowanych. Nie utworzono scope.v3; raw HTTP nie zweryfikowano ponownie. Wcześniejszy drift dowodów Mirakl nadal blokuje bieżący replay v2 także w starym helperze. [Granice](parity/CATALOGUE-INVENTORY-CONTINUITY-20261018.md). |
| Split210 — rzeczywisty Source31/C33 | Root7096/child19103 EXIT1/108,935s:199+27 etapów, pełne493/22 zgodne z V31, inverse40502 i dokładna serializacja64011475 B. Cztery kontrole210/209/buyer/return-credit TRUE. | Następny ordinary187:57014/8006,974292ms przy8s, wynik logiczny nieznany. ROLLBACK/DROP0/oba zamknięcia/18 ról zgodne. Bez COMMIT/Native/aktywacji i biznesowego splitu. Nie wdrożono skrótu osłabiającego dispatch. [Pełny wynik](parity/SPLIT210-C33-LOCAL-20261018.md). |
| Harmonogramy — rzeczywista historia, wyniki i role | D7: read-first8 GET/0 POST,26 wyników25+1; następnie25 odrębnych API POST z ACK i25 pustych wykonań. Historia26 ID ma strony25+1. Chrome na normalnej sesji potwierdził obie paginacje. IAM:401/409/404/404/viewer200/run403, dokładnie6 POST z ACK, dwa nowe logout i zachowana sesja admina. |25 dodatkowych runów zakolejkowano przez API. Wcześniejszy test błędu/retry pozostaje SYNTHETIC_COMPONENT_UI;10/10 testów i typecheck PASS zachowują swój zakres. Brak nowego odbioru błędów GET w zwykłej aplikacji lub zegarowego poll5s. Osobny odczyt danych02 po25 runach PASS, z całą historią26; pełna kontrola187 nadal nieodebrana po timeout. [Historia](parity/AUTOMATION-SCHEDULE-HISTORY-LOCAL-20261018.md), [pełny odbiór S2](parity/SCHEDULE-WORKER-COSTART-LOCAL-20261018.md). |
| Split210 — V31 i pakiet H/resource/seal | V31493/22 z nowego P23/47:488 dodatków i22 BEFORE literalnie bez zmian; pięć dodatków i metadata2 AFTER source/definition zmienione. H/resource/installer60 PASS, seal21 PASS, oracle15 PASS; Root niezależnie potwierdził całe H↔V31 i źródłowy seal515. | Wyłącznie źródła/pakiet. Native1 kontrolowany PASS/25 PG SKIP. Pełna kompilacja C33, rzeczywisty Native, aktywacja i biznesowy split UI/API nadal otwarte. [Dowody](parity/SPLIT210-COMPOSITE-CODEC-CANDIDATE-20261018.md). |
| Split210 — Source31 generator i rzeczywisty P23 | Publiczna fabryka4524547/3e99139d…:27 etapów/raw22; physicalDATA3590688/db01… i603616B zapasu. Root104/104 testy źródeł PASS bez SKIP i pełny inverse do Source30. P23 Root14593 EXIT0:44CHECK+3generated;45 zgodnych wartości i dwa nowe CHECK-i,98 pinów i cleanup zgodne. | To generator i niezależny deparser47, bez instalacji pełnego210 lub odczytu docelowego katalogu. V31/H/seal, pełny kompilator, Native i biznesowy split nadal otwarte. [Dowody i granice](parity/SPLIT210-COMPOSITE-CODEC-CANDIDATE-20261018.md). |
| Split210 — Source31: złożenie i autoryzacja źródłowa | Root10719 source-only EXIT0: rawguard52253/4f0ed506… dokładnie równy niezależnej rekonstrukcji. Wszystkie22 BEFORE i21 innych AFTER zgodne z V30; tylko source/definition metadata2 zmienione. Physical DATA3590688/db01…; cały inverse i checks pełnych24 pól potwierdzone. Nowy finite wrapper53140/2b802356…; Root53/53 testy źródeł PASS,0 SKIP. | Bez nowego SQL/PG; publiczny generator/pakiet niezmienione. Wymagane spójne wpięcie, świeży47-leaf P23, V31/H/seal i pełna kompilacja. Native, aplikacja i biznesowy split pozostają otwarte. [Dowody i granice](parity/SPLIT210-COMPOSITE-CODEC-CANDIDATE-20261018.md). |
| Split210 — kandydat composite i bezstratny codec | Root29/29 testów źródłowych PASS; finite helper pokrywa sześć miejsc odczytu. Rzeczywisty osobny TEMP SQL probe6887 EXIT0: pełne22 deskryptory po24 pola i całe logiczne DATA zgodne;36 błędnych wariantów odrzuconych55000. Fizyczny kandydat3590688B ma603616B zapasu do4MiB; ROLLBACK, brak obu funkcji TEMP, role/topologia i zamknięcie klienta potwierdzone. | Helpery jeszcze poza generatorem/pakietem. Próba nie wykonuje composite snapshotu, pełnej kompilacji, Native, testu MVCC ani biznesowego splitu. Kolejny krok: sześć lokalnych dekoderów, spójna autoryzacja Source31 i nowy pełny przebieg przy8s. [Dowody i granice](parity/SPLIT210-COMPOSITE-CODEC-CANDIDATE-20261018.md). |
| Split210 — rzeczywisty Source30/C32 | Oryginalny Root57874/child1203 TERMINAL EXIT1/109,406s:199+27 etapów, pełny493/22 inverse do40502 rekordów i cztery kontrole210/209/buyer/return-credit TRUE. Wcześniejszy osobny preview94151 EXIT0/4,125s potwierdził pełne złożenie źródeł bez PG. | Następny187:57014/8006,45625ms przy8s; wynik logiczny nieznany. ROLLBACK/DROP0/oba zamknięcia/18 ról zgodne. COMMIT, Native i post-QA nieosiągnięte, bez aktywacji i biznesowego splitu. Root niezależnie potwierdził493/22,84 pełne artefakty28 certyfikatów i200 pinów; osobny inverse odtworzył40502 rekordy oraz dokładną serializację64011475B. Następny krok: [architektura kosztu walidacji](parity/SPLIT210-VALIDATION-COST-REVIEW-20261018.md). [Dowody C32](parity/order-split210-native-progress.md). |
| Split210 — Source30: generator, oczekiwania, seal i pakiet | Zapytanie z D34 włączono tylko dla przypiętego Source29. Program5094845B/f2f3d9cf…, DATA4192445B/fedf… bez zmian; pełny inverse odtwarza poprzedni program. Root opublikował V30:493 dodatki/22 podmiany, tylko dwa pola własnego valid różnią się; P22 ponownie użyty dla dokładnie tych samych47 wyrażeń. H/codec/installer56/56 PASS; seal/oracle/default Native36 PASS/25 DB SKIP. | Odbiór źródeł i pakietu. Pełna kompilacja Source30, rzeczywisty Native i podział przez UI/API pozostają otwarte; nie podniesiono limitów. [Dowody Source30](parity/order-split210-native-progress.md). |
| Mirakl — ponowne sprawdzenie dostępności i widok mobilny | Operator może ponownie sprawdzić lokalną dostępność odczytów bez przeładowania widoku i utraty filtrów. Root23/23 testy PASS, typecheck EXIT0; Chrome potwierdził false→true bez automatycznego odczytu ofert. Przy375px dokument zachowuje375px, a tabela przewija się lokalnie klawiaturą. | SYNTHETIC_COMPONENT_UI: rzeczywisty komponent z kontrolowanymi lokalnymi GET, bez PG i zewnętrznego dostawcy. Wspólne wydanie i konto Mirakl pozostają otwarte. [Raport](parity/MIRAKL-AVAILABILITY-RECHECK-LOCAL-20261018.md). |
| Split210 — D34: rzeczywiste porównanie diagnostyczne | Poprawiony oryginalny Root68517 TERMINAL EXIT0/106,467s:199+27 etapów,14 odczytów pełnych czterech wyjść w siedmiu parach,7 kontroli valid i4 plany. Root końcowo potwierdził pełną równość,112 artefaktów28 certyfikatów,katalog64591304B i cleanup. W dwóch instrumentowanych parach średni execution15,9645→14,786ms (−7,382%), wall19,2935625→17,892563ms (−7,261%). | Odbiór dotyczy równoważności i lokalnego planu jednego zapytania, bez dowodu czasu całego valid/187,P95,Native lub splitu. Root i peer zalecili promocję źródłową; opis zachowuje historyczny stan przed Source30. Wcześniejszy68965 EXIT1/0PG i osobny preview95111 EXIT0 pozostają zachowane. [Dowody D34](parity/order-split210-native-progress.md). |
| Split210 — diagnostyka zapytania Source29/D33 | Pierwotny D33 odmówił w preflight przed attempt/run/połączeniem PG przez błędne oczekiwanie boolean zamiast liczby18. Świeży poprawiony Root94449 TERMINAL EXIT0/104,403s: jedno EXPLAIN źródłowego zapytania,19,619ms. Końcowy Root review potwierdza pełny katalog,112 artefaktów28 certyfikatów,rodziców,seal,18 ról,207 pinów i osiem postflags; ROLLBACK/DROP0/oba zamknięcia. | To wyłącznie plan jednego zapytania z ciała walidatora, nie czas całego valid lub187, P95, naprawa timeoutu, Native lub split. Analiza wskazuje kandydat lokalnego lookup constraint dla wybranych trigger OID; optymalizacji nie wdrożono. [Dowody D33](parity/order-split210-native-progress.md). |
| Split210 — częściowa diagnostyka Source29/D32 | Oryginalny Root83078 TERMINAL EXIT1/120,152s:187 wywołany raz,57014/8005,835ms, obsłużony rollbackiem savepoint; zapisano92 OID i przywrócono tracking. Pełny katalog przed/po zgodny bajtowo. | Pusta obserwacja BEFORE oznacza92 nieznane delty; rankingi AFTER są zgłoszonymi licznikami kumulacyjnymi. Późniejsza kontrola PIM również57014 przy skonfigurowanych8s, bez zapisanego osobnego czasu. Końcowe certyfikaty/rodzice/seal/piny nie osiągnięte. Pełny ROLLBACK/DROP0/zamknięcia/18 ról zgodne; bez COMMIT, Native lub aktywacji. [Dowody D32](parity/order-split210-native-progress.md). |
| Split210 — rzeczywisty Source29/C31 | Oryginalny Root16973 TERMINAL EXIT1/109,522s:199 etapów rodzica i27 etapów210; pełny493/22 inverse do40502 rekordów,28 certyfikatów bez zmiany pełnych bajtów i seal515. Cztery kontrole210/209/buyer/return-credit TRUE. Root końcowo potwierdził493 dodatki i22 podmiany zgodne z V29,198 aktualnych pinów i9 osobnych provenance. | Następny187:57014/8006,049ms przy8s, stos `try_function_projection`→predecessor SHA→finanse→history PIM; wynik logiczny nieznany. Miejsce przerwania nie jest pomiarem kosztu pojedynczej funkcji. ROLLBACK/DROP0/oba zamknięcia/18 ról zgodne; bez COMMIT, Native, aktywacji i biznesowego splitu. Przegląd Root zachowuje wynik FAILED. [Dowody C31](parity/order-split210-native-progress.md). |
| Split210 — Source29 H/codec/seal/installer | Root33/33 H+codec PASS, agent19/19 installer PASS, niezależne RO bez P1/P2. Publiczny H DEEP zgodny z V29/493/22; pełny historyczny H28 odtworzony przed starszymi fixtures. Seal/default Native: pierwszy bieg19 PASS/1 stary pin FAIL/25 DB SKIP; wyłącznie błędny assert poprawiono, jego osobny przypadek1/1 PASS. | To odbiór źródłowy. Nie jeden końcowy zielony45-run; DB SKIP nie dowodzi Native. Pozytywny wynik pełnego kompilatora, instalacja i biznesowy odbiór splitu pozostają otwarte; rzeczywisty C31 opisano wyżej. [Dowody i granice](parity/order-split210-native-progress.md). |
| Split210 — Source29, źródła/P22/V29 | Commit `8004077`: jedna świeża migawka z niezależną bramką przed wywołaniem; pełny fingerprint209 i17 deskryptorów. Root11+52+15 kontroli źródeł PASS bez SKIP. Rzeczywisty P22/Root9647 EXIT0:44 CHECK+3 generated,45 identycznych i2 zmienione CHECK DATA; ROLLBACK/brak schematu/role/zamknięcie zgodne. V29/Root44205 EXIT0:493/22,490 identycznych dodatków,22 BEFORE i21 AFTER zgodne z V28. Kandydat5094543B/bd610, DATA4192445B/fedf ma1859B zapasu. | Bez dowodu szybkości, pełnego kompilatora/Native, aktywacji i biznesowego splitu. P22 nie jest odczytem katalogu zainstalowanego210, V29 pozostaje SOURCE_EXPECTATION_PREPARED_NOT_COMPILED. Zachowane aplikacje bez przełączenia. [Dowody i granice](parity/order-split210-native-progress.md). |
| Split210 — rzeczywisty Source28/C30 | Root66937 EXIT1/129,547s:199 etapów rodzica,187/173 i cztery cold capabilities TRUE;27 etapów210, pełny493/22 inverse40502/canonical10e/serializacja64011475B oraz28 niezmienionych certyfikatów i seal515. Pierwszy rzeczywisty Source28 valid TRUE19,877ms,209/buyer/return-credit TRUE. | Następny187 przekroczył8s po8008,225ms w metadata(value,entries)→history_project, wynik logiczny nieznany. ROLLBACK/DROP0/zamknięcia/18 ról zgodne; bez COMMIT/Native/aktywacji.196 aktualnych pinów zgodnych, lecz post-QA nie wykonano. P30 poza instalatorem; nie obejmuje miejsca timeoutu. [Pełne dowody C30](parity/order-split210-native-progress.md). |
| Split210 — osobny odczyt dla uprawnionych operatorów i P30 | Commit `1fb05c9`: dedykowany order-scoped GET, RLS przed/po odczycie, pełny graf2–100 i zdarzenia; stare recovery autora bez zmian. Root99 kontrolowanych testów/typecheck i wzajemne przeglądy PASS. Commit `64f2e36`: helper pomijania niemożliwych zamian metadanych, Root9 testów PASS. Rzeczywisty P30 EXIT0:30 par TEMP sufiksów zgodnych według NULL/bajtów/SHA; ROLLBACK/DROP0/zamknięcia potwierdzone. | Czytnik nie ma jeszcze rzeczywistego odbioru PG/HTTP/Chrome ani dwóch operatorów na zainstalowanym210. P30 nie wykonuje pełnych bramek/końcowego parse i nie dowodzi wydajności; helper pozostaje poza instalatorem. Bez aktywacji, biznesowego splitu, skali i recovery. [Dowody](parity/order-split210-native-progress.md). |
| Historyczny etap75e4dc3 — pomiar PIM C29 i powiązania UI | Oryginalny Root30536 EXIT0:199 etapów rodzica i wcześniejsze bramki TRUE; jeden instrumentowany PIM TRUE5387,463ms/8s,104 liczniki. Snapshot86/1743,778ms i metadata21/1188,680ms czasu własnego wyznaczają dalszą analizę. Pełny katalog40502/serializacja64011475B,28 certyfikatów,209/166,18 ról, ustawienia, ROLLBACK/DROP0/zamknięcia zgodne. Commit `75e4dc3` dodaje odczyt powiązań z trwałych zdarzeń bez localStorage: Root53 testy kontrolowane/typecheck PASS. Commit `e53b24c` izoluje origin fixture/runnera: Root43 PASS. | C29 nie wykonuje210 i nie dowodzi naprawy timeoutu C28 lub czasu bez instrumentacji. Nowy widok nie ma rzeczywistego odbioru HTTP/Chrome/Native210; GET pozostaje ograniczony do autora wykonania, widoczność dla innego operatora otwarta. Pełny split/WMS/finanse/skala/recovery nadal otwarte. [Dowody i granice](parity/order-split210-native-progress.md). |
| B2B — zaproszenie→akceptacja i trwała historia | Wydanie `34631b2e…`: zwykły start naprawił232 ACL, zachował40503 metadane i przeszedł209/187 przy8s. Po6 POST setupu Chrome wykonał29 zapisów: zatwierdzenie konta v2,27 zaproszeń i jedną akceptację. Root21 GET oraz osobny READ ONLY PG potwierdziły26 cofniętych/1 przyjęte, jeden link kupującego, paginację25+2, IAM401/403/404/422 i16 pustych kategorii biznesowych własnych firm. Root obejrzał pięć rzeczywistych zrzutów, w tym375px i viewer; własna karta/stack zamknięte,4104 wolny, Main/APP16/SMTP zachowane. | Zachowano błąd prywatnego mostu kodu26 i checkpoint25+1. Zaproszenie27 było osobnym autoryzowanym zdarzeniem, bez retry26. Bez empirycznego dowodu braku GET viewer, naturalnego wygaśnięcia24h, konfliktu wersji lub osobnego admin/API-key w tej samej firmie. Bez Base Connect, pełnego B2B order/dropshipping, workerów, recovery lub skali; wcześniejsze testy kontrolowane zachowują swój zakres. [Raport i granice](parity/B2B-INVITATION-HISTORY-LOCAL-20261018.md). |
| Workery — rzeczywiste sterowanie przez UI dwóch firm | Wydanie `bd46ebfa…`:19 zapisów przez Chrome, w tym utworzenie dwóch reguł, lokalna aktywacja, pauza, wznowienie i7 notatek. Root końcowo potwierdził6 zamówień bez zmian ilości/kwot/dokumentów, dwa stany magazynowe3/3/0,4 odmowy dostępu między firmami i5 wiadomości/skutków SMTP:2 accepted/3 uncertain. Obie regułyv5 lokalnie OFF, globalnie0 opt-in. | Jawnie zachowano błąd pierwszego obserwatora i oryginalną niepewną wiadomość; dodatkowa notatka była nowym zdarzeniem, bez ponowienia. Osobne aktywne obserwacje20,047s i20,667s po10 nowych cykli nie wykazały ponownej wysyłki. Root sprawdził widoki desktop/375px. Własny stack i SMTP EXIT0, porty4104/50171 wolne, Main/APP16 i stary SMTP1025 zachowane. Bez nowego drain/restart, pełnego onboardingu, wszystkich workerów, dostawców, skali lub pełnego recovery. [Pełny raport](parity/WORKER-UI-CONTROL-LOCAL-20261018.md). |
| Workery — rzeczywisty lokalny API/SMTP lifecycle dwóch tenantów | Oryginalny68071 EXIT0: `PASS_LOCAL_API_WORKER_SMTP_LIFECYCLE_ONLY` na nowym wydaniu209 `09158d0b…`. Cztery wiadomości DB odpowiadają czterem skutkom odbiornika bez deduplikacji:2 smtp_accepted/2 uncertain; pause/drain/restart i brak ponowienia po utracie ACK. Root potwierdził39 tenantów, globalnie0 opt-in i5 zamkniętych własnych cykli stacka. | Chrome: rzeczywisty odczyt obu tenantów/statusu/historii/original-email PASS,0 business POST. Root obejrzał oba zrzuty i potwierdził po Chrome4 wiadomości/4 skutki oraz0 opt-in. Własny stack UI i SMTP EXIT0,4104/60951 wolne; stary1025 zachowany. UI creation/pause/resume/drain/restart **NOT_ACCEPTED**; poprawka prezentacji `c8e9159` ma45 testów React PASS/typecheck EXIT0, ale nie weszła do09158 i nie ma nowego odbioru wizualnego. Bez doręczenia zewnętrznego, audytu fizycznego stocku, godzinnej skali lub aktywacji split210. Main/APP16 zachowane. [Dowody i dokładne granice](parity/WORKER-SMTP-LIFECYCLE-LOCAL-20261018.md). |
| Restore209 — poprawka w zwykłym starcie nowego pakietu | Nowe wydanie `bd46ebfa…` osiągnęło READY na świeżej kopii bez ręcznych GRANT lub wcześniejszego bezpośredniego normalizatora. Root59423 EXIT0:40503 metadane źródłowo zgodne,232 ACL naprawione przez start, generacja1469→1702 z normalnym DDL,209/187 TRUE przy8s. | To odbiór normalnego startu aplikacji po restore bazy. Późniejszy odbiór UI tego wydania opisano wyżej. Pełne recovery plików i niepustej kolejki oraz uzgodnienie wszystkich danych odtworzonej platformy pozostają otwarte. Historyczny bezpośredni odbiór24018 zachowany. [Raport i dowody](parity/RESTORE-OWNER-ACL-LOCAL-20261018.md). |
| Katalog Base — wymiary źródłowe | Deterministyczny suplement obejmuje2060 wpisów/2056 wystąpień kart, w tym1995 dodatkowych wpisów. Generator i9 testów PASS; Root `--check` EXIT0. Zachowano duplikaty i nieznane wartości. | Liczba dostawców pozostaje nieustalona; filtry kraju, nazwy i tagi rodziny Mirakl nie dowodzą obsługiwanych operacji lub uprawnień. Dodano0 operacji, bez odbioru integracji i bez zmiany częściowego ScopeV2. [Dane źródłowe](parity/base-provider-catalog-dimensions.v1.json). |
| Split210 — Source28/P21/VECTOR28 i próba C28 | Root37 źródeł/15 oracle/31 H-codec/17 installer PASS; seal/default Native19 PASS/25 DB SKIP. Rzeczywiste P21/VECTOR28 potwierdziły47 wyrażeń i493/22 przy120 pinach; pozostałe492 rekordy i22 podmiany bez zmian. | C28 EXIT1/91,381s:199 etapów rodzica209 i187/173 TRUE, potem niezależny PIM cold capability57014/8s przed pierwszym DDL210. Nowej walidacji Source28 nie wykonano ani nie zmierzono. ROLLBACK/DROP0/klienci/role zgodne. Bez Native, aktywacji i biznesowego splitu; DATA4193843B i limity bez zmian. [Dowody i granice](parity/order-split210-native-progress.md). |
| Split210 — rzeczywisty C27: timeout187 | Root40543 EXIT1 po około130s:27 etapów i pełny493/22 inverse do40502 rekordów209 PASS; stały seal oraz kontrole210/209/buyer/return-credit TRUE. Source27 H/codec/seal/installer spójne w `8aa4996`; testy źródłowe i instalatora mają osobne dowody. | Następny187 zakończył się57014 przy niezmienionym limicie8s, wynik logiczny nieznany. ROLLBACK, usunięcie własnej bazy przy0 klientach, oba zamknięcia i role potwierdzone przez Root. Bez COMMIT, rzeczywistego Native, aktywacji lub biznesowego odbioru splitu. [C27 i źródłowa hipoteza dalszej optymalizacji](parity/order-split210-native-progress.md). |
| API — źródła204 i kontrakty Stocktake6 | Wszystkie204 strony metod są zachowane w15 archiwach HTML; braki metadanych11 stron Client pozostają jawne. Sześć kontraktów Stocktake ma39 pól wejścia/55 wyjścia; Root9 testów DOM/proweniencji PASS. | Wyłącznie źródła i kontrakty. Bez odbioru implementacji, konta dostawcy ani zmiany612 pozycji planu wykonawczego. [Coverage](parity/base-api-source-coverage-20261018.json), [Stocktake](parity/base-api-stocktake-contracts.v1.json). |
| Split210 — rzeczywisty C26: timeout187, bez Native | Source26 zintegrowano w `758df1e`;27 etapów, pełny493/22 inverse do40502 rekordów209,28 certyfikatów i seal515 PASS. Kontrole210/209/buyer/return-credit TRUE. | Oryginalny83906 EXIT1/113,814s;187:57014 po8001,306ms przy8s, stos210 try_metadata41 →209 metadata3 →187376. Wynik logiczny187 nieznany. ROLLBACK/DROP0/oba zamknięcia/role potwierdzone; bez COMMIT/Native/aktywacji i odbioru splitu. Świeże Main205/APP16209 HTTP200 bez przełączenia. |
| Split210 — Source26/P19/VECTOR26 |65 testów helpera/źródeł,29 H/codec i17 installer PASS. P19 rzeczywiście potwierdził47 wyrażeń; VECTOR26 opublikował493 dodatki/22 niezmienione podmiany przy116 źródłach. | Root seal/default Native:42 testy,17 PASS/25 SKIP w56,237s — pominięcia nie są Native. DATA4193843B/4MiB oraz limity8s/16MiB/96MiB bez zmian. [Dowody C26](parity/order-split210-native-progress.md). |
| Mirakl — ręczna paginacja ofert | Commit `060153a`: Root81/81 testów API/HTTP/React PASS, typecheck EXIT0. Chrome potwierdził strony0→1→2→1 i reset SKU na rzeczywistym komponencie/CSS z kontrolowanymi GET. | **SYNTHETIC_COMPONENT_UI**, bez konta dostawcy, oficjalnego sandboxa, importu biznesowego lub odbioru wspólnego wydania. [Raport](parity/MIRAKL-OFFERS-PAGINATION-LOCAL-20261018.md). |
| Historia — runner dwóch tenantów przygotowany | Commit `7752f93`:17/17 kontrolowanych testów całego runnera PASS; trwały intent przed POST, brak ponowień po utracie ACK, osobny port API i obserwacja draining przed release. | W chwili przygotowania rzeczywisty lifecycle był NOT_RUN. Sam zestaw kontrolowany nie nadał odbioru aplikacji; późniejszy wynik68071 opisano wyżej, UI i doręczenie nadal osobno. [Runner i warunki](../tools/parity/worker-smtp-ack-acceptance.README.md). |
| Historia — Split210 C25: kolejny timeout | Source25 zintegrowano; wszystkie27 etapów, pełny493/22 inverse do40502 rekordów i cztery kontrole210/209/buyer/return-credit PASS. | Następny187:57014 przy8s, metadata209 linia48 →187 linia376. Bez Native/COMMIT/aktywacji; rollback, DROP0, zamknięcia i role potwierdzone. Main/APP16 HTTP200 bez przełączenia. |
| Historia — Split210 Source25 i oczekiwania źródłowe | Commit c2e142a: lokalne przejście metadanych z jedną świeżą walidacją na wywołanie.47 core/oracle,28 H/codec,17 installer PASS; P18 i VECTOR25 rzeczywiście opublikowane. | Root fixed-seal/default Native:16 PASS/25 SKIP; pominięcia nie stanowią odbioru Native. DATA4193843B/4MiB,22 poprzedniki bez zmian; C25 odmówił później przy187. |
| Historia workerów — prywatny port SMTP | Commit2e35002: konfiguracja właściciela izoluje lokalny port. Root43 testy transportu/polityki i8 kontroli writerów PASS; rzeczywisty klient wysyła do prywatnego odbiornika bez adaptera portu. | Bez nowego uruchomienia aplikacji, dwóch tenantów i odbioru pause/drain/restart. Main/APP16 oraz dotychczasowy port1025 zachowane. |
| Split210 — C24: pełny inverse, timeout metadanych |27 etapów i pełny493/22 inverse do40502 rekordów PASS;28 certyfikatów/seal515/210/209/buyer/return-credit zgodne. |187:57014 przy8s w rekurencyjnej projekcji metadanych, wynik logiczny nieznany. Rollback/DROP0/zamknięcia/role potwierdzone. Bez Native/COMMIT/aktywacji. |
| Split210 — historyczne przygotowanie Source24 | Dwa zapytania finansowe współdzielą kontrolę wyłącznie wewnątrz swojego wykonania; pozostałe21 podmian zgodne z VECTOR23. SQL5093221B, DATA4193843B/4MiB i461B zapasu; helper8/8 źródeł PASS. | Przygotowanie poprzedziło C24; mimo pełnego inverse nadal brak Native i odbioru splitu. |
| Split210 — C23 timeout przy8s | Pełny493/22 inverse,40502 rekordy209,28 certyfikatów i seal515 PASS. Cztery kontrole210/209/buyer/return-credit TRUE. |187:57014/8002,277208ms, wynik logiczny nieznany. ROLLBACK/DROP0/zamknięcia/role potwierdzone; bez Native/COMMIT/aktywacji. |
| Split210 — historyczny etap przygotowania walidatora180 | Czysty helper zmienia jeden odczyt kredytowy, zachowuje pozostałe3 i certyfikat.7/7 testów źródeł i niezależny RO PASS; proponowane DATA22 mieści się w4MiB z2165B zapasu. | Bez integracji assemblera, nowej kompilacji/seal515/Native i aktywacji. Publiczny Source22 i działające Main/APP16 pozostają bez przełączenia. |
| Split210 — źródłowo wykazany fałszywy parametr projekcji | Niezmieniony walidator180 porównuje4 surowe ciała z certyfikatem169; po210 jedno kredytowe różni się. Powoduje to projection_ok FALSE i wynik NULL kalkulatora181. | To dowód pozostającej niezgodności, bez pomiaru pierwszej gałęzi odmowy C22. Następna poprawka wymaga budżetu4MiB, kompilacji, Native i odbioru aplikacji. |
| Split210 — C22 pełny493/21 inverse PASS | Oryginalny77968 EXIT1/117,361s:26 etapów,493 dodatki i21 podmian odtworzyły40502 rekordy literalnego209. Seal514,28 certyfikatów i210/209/buyer/return-credit TRUE. |187 FALSE7643,812ms przy8s bez timeoutu; bez COMMIT/Native/aktywacji. ROLLBACK/DROP0/oba zamknięcia/role i health Main/APP16 potwierdzone. |
| API — PickPack8 |9/9 testów DOM/pól/powiązań PASS, regresje zakupów i transferów15/15 PASS. Rejestr134JSON/70Markdown;204 źródła/statusy zachowane. | Dokumentacja i powiązania;612 pozycji odbioru implementacji nadal NOT_RUN. |
| Historia workerów — lokalny serwis ACK |Nowy proces z prywatnym socketem, trwałym pełnym intentem i atomową odpowiedzią;6/6 testów procesowych. Root łącznie17/17 fixture/transport/serwis PASS; commit2cb10a4. | Narzędzie testowe, bez dwóch tenantów, rzeczywistych zadań aplikacji i odbioru pause/drain/restart workera. |
| Historia workerów — transport rzeczywistego klienta SMTP |3/3 testy rzeczywistego SmtpClient/Nodemailer/TCP PASS: trwałe DATA przed ACK, release250 oznacza accepted, dropACK odrzuca bez ponownej wysyłki transportu. | Jawny adapter portu1025→ephemeral w teście; bez odbioru całego workera, restartu lub profilu aplikacji. |
| Historia workerów — test utraty ACK | Osobny SMTP fixture zapisuje/fsync przed hold ACK, umożliwia250/drop i odczyt po restarcie.8/8 rzeczywistych testów TCP/plików PASS. | Narzędzie testowe; brak odbioru pause/drain/restart całej aplikacji. Workery działających instancji pozostają wyłączone. |
| Split210 — Source22 przygotowany | Następca kalkulatora189 stanowi 21. podmianę; kandydat493/21, 26 etapów, DATA3935453B/4MiB. Root36/36 źródeł i osobno14/14 oracle; rzeczywisty PROBE15 potwierdził47 wyrażeń, VECTOR22 opublikował108 źródeł. | To dowody źródeł i próby wyrażeń. Pełna kompilacja, seal514, Native26, aktualizacja kopii, start i split przez UI/API/WMS nadal nieodebrane. |
| Split210 — konflikt kalkulatora kredytowego | Źródłowo potwierdzono pięć nowych triggerów i jedną funkcję guard210 w wejściu niezmienionego kalkulatora189. Jego wynik trafia do historycznego fingerprintu160. | Następca kalkulatora jest przygotowywany; nie zmieniono certyfikatów ani oczekiwanych hashy. Dokładnej wartości MD5 nie zmierzono. Brak nowego Native i aktywacji. |
| Kontrakty API — zakupy i transfery | Znormalizowano 9 metod zakupowych i 6 metod transferów; łącznie 89 pól wejściowych, 127 wynikowych i 13 pól opisanych w prozie. Końcowy zestaw 15/15 testów bez pominięć. Rejestr ma 126 kontraktów JSON i 78 wyłącznie Markdown przy 204 zachowanych źródłach. | Dokumentacja i powiązania, bez odbioru implementacji. Wszystkie 612 pozycji planu wykonawczego nadal NOT_RUN; historyczne źródła i snapshoty zakresu zachowane. |
| Split210 — C21 porównanie certyfikatu historii | Diagnostyczny proces 2951 EXIT0 wskazał gałąź 167 bieżącego Source21; porównuje ona dziesięć elementów profilu, manifestów i fingerprintów. | Dokładny składnik nieznany. Cały katalog po odczycie bajtowo identyczny, role/ROLLBACK/DROP0/zamknięcia potwierdzone. Bez COMMIT/Native/aktywacji. |
| Split210 — C20 kontrola historii realizacji | Diagnostyczny46702 EXIT0: wcześniejsze33 warunki own-wave i nested172 przeszły; historia realizacji false przy8s. Cały katalog przed/po bajtowo identyczny. | Bramka metadanych migracji; bez dowodu błędu fizycznego magazynu. ROLLBACK/DROP0/oba zamknięcia potwierdzone. Bez COMMIT/Native/aktywacji. |
| Split210 — C19 lokalizacja odmowy187 | Diagnostyczny45925 EXIT0: jedyny marker374 ma WAVE_FALSE; źródło i24 pola zgodne, pełny katalog/certyfikaty/manifesty/role po odczycie bez zmian. | To odmowa kontroli kompletacji. ROLLBACK/DROP0/oba zamknięcia potwierdzone. Bez COMMIT/Native/aktywacji; następny krok to istniejący probe own-wave. |
| Split210 — C18 pełny493/20 inverse PASS | Oryginalny91490 EXIT1:40502/canonical10e/serializacjab330 oraz28 certyfikatów i seal513 zgodne. Własne210/209/buyer/return-credit TRUE. |187 zwraca false7931,548ms przy8s, bez57014. Bez COMMIT/Native/aktywacji; ROLLBACK/DROP0/oba zamknięcia/role potwierdzone. |
| Split210 — Source21 źródłowo przygotowany |20 portów historii używa istniejącej rodziny partial204;115/115 testów źródeł PASS,0SKIP. Kandydatd6fa6a…/4674391B; DATA3863093B/4MiB. | Brak pomiaru poprawy czasu, nowego Native i aktywacji. Historyczny C17 przy8s pozostaje odmową. |
| Split210 — C17 pełny493/20 inverse PASS | Oryginalny4074 EXIT1:pełne40502 canonical10e/serializacjab330,28 certyfikatów i seal513 zgodne. Własne210/209/buyer/return-credit TRUE. | Następny187:57014/8002,536ms przy8s, wynik logiczny nieznany. Bez COMMIT/Native26/aktywacji; ROLLBACK/DROP0/oba zamknięcia/role potwierdzone. Main/APP16 HTTP200 bez przełączenia. |
| Split210 — Source20 / PROBE13 / VECTOR20 | Kandydat442556…/4673025B:20 zmian,25 etapów;110/110 testów źródeł PASS,0SKIP. PROBE13 EXIT0:47 pól/84 piny i ROLLBACK. VECTOR20:493+20/106 referencji,0 pól oczekujących. Dane3862613B przy limicie4MiB; historyczny producent17 zachowany. | Pełna kompilacja493/20, seal513, Native26 i UI/API/WMS nadal otwarte. Main/APP16 bez przełączenia. |
| Split210 — C16 wskazuje warunek kompletacji | Diagnostyczny26507 EXIT0; źródłowo zgodny DO wskazał warunek374: SHA wave_print lub wave_ok. Pełny katalog,28 tabel, rodzice, role i piny po odczycie zgodne. | Osobne strony OR niezmierzone; ROLLBACK/DROP0/oba zamknięcia potwierdzone. Bez COMMIT/Native/aktywacji, poprawki aktywnych helperów są WIP. [Receipt](parity/order-split210-native-progress.md). |
| Split210 — C15 potwierdza poprawkę return-credit | Oryginalny65934 EXIT1 po118s: pełny493/16 inverse, seal509 oraz210/209/buyer/return-credit TRUE przy8s. | Następne187 FALSE6676,875ms bez timeoutu. Brak COMMIT/Native26; ROLLBACK/DROP0/oba zamknięcia potwierdzone. Main/APP16 bez przełączenia. [Receipt i granice](parity/order-split210-native-progress.md). |
| Split210 — Financial16 źródłowo przygotowany | Commit0cd97e9, kandydat69b366…/4639523B,16 dokładnych zmian;65/65 testów źródeł PASS. Niezależny PROBE12 potwierdził47 pól, ROLLBACK, nieobecny schemat i zamknięcie klienta. | Pełna kompilacja493/16, seal509, Native26 i rzeczywisty split przez UI/API/WMS pozostają otwarte. Main/APP16 bez przełączenia. [Dowody](parity/order-split210-native-progress.md). |
| Split210 — C13 zatrzymany na nieaktualnym wzorcu diagnostycznym | Oryginalny86973 EXIT1: ciało188 zgodne, B2B upgrade nie odpowiada staremu160; późniejszą definicję wprowadza161. Zapytania zagnieżdżone NOT_RUN. | To błąd wzorca narzędzia, bez nowego wyniku biznesowego lub Native. ROLLBACK/DROP0/oba zamknięcia potwierdzone. Osobny pełny aplikacyjny inverse plikowy139e i13 EXPLAIN audytu magazynu PASS w swoim zakresie. [C13 i granice](parity/order-split210-native-progress.md). |
| Split210 — C12 zlokalizował zagnieżdżoną odmowę | Oryginalny16019 EXIT0 diagnostycznie: zgodne źródło208, cztery warunki strukturalne i pierwsze siedem składników RETURN przechodzą; `local_consumer_credit_guards()` false w538,281ms. | Bez podmiany funkcji, COMMIT, Native i aktywacji. Pełny katalog/certyfikaty/rodzice/role po odczycie zgodne, ROLLBACK/DROP0/oba zamknięcia potwierdzone. To lokalizacja, bez odbioru poprawki. [C12](parity/order-split210-native-progress.md). |
| Split210 — C11 pełny inverse i buyer PASS | Oryginalny23157 EXIT1 po około98,13s:493/15 source compare i cały inverse40502 PASS, seal508 wykonany. Własne210/209 oraz buyer true w29,751/54,408/3161,958ms przy8s. | Następny `return_credit206_guards()` false po400,301ms. Bez pełnych187/173, cold4, COMMIT i Native26. ROLLBACK, DROP0 i oba zamknięcia potwierdzone; Main/APP16 bez zmiany. [Dowody C11](parity/order-split210-native-progress.md). |
| Split210 — C10 odmówił instalacji snapshotu | Oryginalny84585 EXIT1 po około90,04s: PostgreSQL42702 przy zastąpieniu snapshotu209, kolizja kolumny `key` w nowym JOIN. ROLLBACK, DROP przy0 klientach i oba zamknięcia potwierdzone. | Nie osiągnięto pełnego493/15 inverse, seal, COMMIT ani Native26. Minimalna poprawka `split210_key` ma52 testy źródłowe PASS i niezależny PROBE11 pól tabel; kandydat139e2… nadal nieodebrany. Main/APP16 bez zmiany; [dowody C10](parity/order-split210-native-progress.md). |
| Split210 — diagnostyka C09 lokalizuje różnicę finansową | Oryginalny80063 EXIT0; anonimowy pomiar10272,945ms wskazał `BUYER210_8_FALSE`, porównanie metadanych rodziny160. Przegląd źródła wykazał dwie niewłaściwe definicje w mapie manual169. Pełny inverse493/15→40502 i odczyt po diagnostyce zgodne; rollback/drop0/oba zamknięcia potwierdzone. | To diagnoza, bez COMMIT, Native26 lub odbioru poprawki. Odmowa C08 przy8s pozostaje ważna. Podział w aplikacji nadal wyłączony; [dowody C09](parity/order-split210-native-progress.md). |
| Split210 — C08 pełny inverse PASS, nadal timeout buyer | Oryginalny90826 EXIT1 po około104,54s:493 pełne dodatki i15 zmian zgodne ze źródłem; inverse40502/canonical10e79173…/pełna serializacjab3300ea8… PASS. Własne210/209 true w29,067/1579,019ms; buyer57014 po8002,478ms przy8s, stos valid→require→try_function_projection→209 predecessor_source→partial204 predecessor_definition65→buyer44. | Brak COMMIT, Native26, aktywacji i biznesowego splitu. ROLLBACK, DROP przy0 klientach i oba zamknięcia potwierdzone; APP16/Main bez przełączenia. Zmiana stosu nie jest odbiorem wydajności. Historie05–07 zachowane. [Receipt i granice C08](parity/order-split210-native-progress.md). |
| Split210 — C07 pełny inverse PASS, timeout buyer | Oryginalny45115 EXIT1 po około104,29s:493 pełne dodatki i15 zmian zgodne ze źródłem; inverse do40502 rekordów, canonical10e79173… i pełna serializacjab3300ea8… zgodne. Własne210/209 true w29,776/1575,196ms; buyer57014 po8002,452ms przy8s, stos valid→require→is_added_trigger→buyer linia44. | Brak COMMIT, Native26, aktywacji i biznesowego splitu. ROLLBACK, normalny DROP przy0 klientach i oba zamknięcia potwierdzone; APP16/Main bez przełączenia. Historyczne odmowy05/06 zachowane. Pełny inverse nie nadaje odbioru Native ani UI/API. [Receipt i granice C07](parity/order-split210-native-progress.md). |
| Split210 — diagnostyka06 lokalizuje odmowę | Operator97916 EXIT0 w trybie diagnostycznym:210/209/204 true; pierwszy false buyer-address to porównanie surowych SHA trzech fingerprintów158/159/160. Projekcja odtwarza dokładne historyczne SHA. Pełne187/173 false w6110/6211ms przy8s, bez timeoutu.493 dodatki i14 zmian przechodzą pełny inverse do40502 rekordów; ROLLBACK, DROP przy0 klientach i oba zamknięcia potwierdzone. | Odmowa05 pozostaje zachowana. Nie podmieniono funkcji diagnostyką; brak COMMIT, Native26 i aktywacji. To lokalizacja błędu, nie odbiór poprawki lub biznesowego splitu. APP16/Main bez przełączenia. [Dowody i receipt06](parity/order-split210-native-progress.md). |
| Source22b — reviewed Native54 PASS | Oryginalny76509 EXIT0:199 etapów, delta259/21/0,17 pełnych funkcji i4 CHECK, cały inverse do literalnego208,28 niezmienionych tabel kontrolnych,19 wartości pochodnych,54/54 Native bez FAIL/SKIP/CANCEL. Pełne187/173 true w4510,60/4438,67ms; PIM przed/po QA5286,92/4941,22ms przy8s. ROLLBACK readback, role bez zmian, normalny DROP własnej bazy przy0 klientach i oba klienty zamknięte. | Odbiór modułu źródłowego; nie oznacza READY, aktualizacji istniejących danych ani wykonania MERGE przez UI/API. Historyczne odmowy zachowane. |
| Kandydat Source22 — rzeczywista próba zakończona odmową | Operator `55710` zakończył się EXIT1. Dokładna baza208, delta255/21/0, pełny inverse do literalnego208, 28 niezmienionych tabel certyfikatów oraz cztery predykaty modułu i pięć wspólnych przeszły. Operator przygotowano z 132 kontrolami i dwoma niezależnymi przeglądami. | Pełny `ordinary187_valid()` zwrócił **false** przy niezmienionej bramce8s. Brak COMMIT; 54 testy Native **NOT_RUN**, cztery bezpośrednie capability nie zostały osiągnięte. ROLLBACK, normalny DROP własnej bazy przy0 połączeń i zamknięcie obu klientów potwierdzono. SQL209/kontrakt Source21, kopia biznesowa i Main bez podmiany. Brak READY i odbioru biznesowego. |
| Pakiet15 Source22b | Manifest `e00eebe61e422cc077c748f9cc3ece0b14c355b4b2172889ef98d4bf5f5ed4f6`:379 plików,100605831B, przy limicie96MiB; zależności współdzielone, bez instalacji. Rzeczywisty pełny katalog Source22b przeszedł aplikacyjny inverse259/21 do literalnego208. | Pakiet zbudowany i kopia zaktualizowana; start i końcowy odbiór biznesowy nadal wymagane. |
| Upgrade02 Source21→22b zachowanej kopii | Oryginalny91418 EXIT0, reviewed PASS. Wszystkie627 tabel sprawdzone;624 bez zmian. Własne basis/manifest mają pełne dokładne przejścia, kontrola182 generacja1400→1466 odpowiada66 DDL bez resetu. Pełne187/173 i cold4 true przy8s; COMMIT i zamknięcie klienta potwierdzone. | To odbiór aktualizacji kopii; aplikacja i MERGE przez UI/API nadal wymagają odbioru. Poprzedni01 zakończył się przedDDL na błędnej historycznej precondition267 zamiast267+2 wcześniejsze starty. Zachowano FAILED/ROLLBACK. |
| Start15b — odmowa writer coverage | Oryginalny95658 EXIT1; oba procesy95507/95512 potwierdzono jako nieobecne. Diagnostyka24086 EXIT1 wskazała `stock-writer-source-sha` przy returns.ts: stary pin cce7/38350B zamiast źródła commita a251dfe 0f32/39085B. Start przeszedł pełny cold etap do prepareStockWriterActivation. | Nie ma READY ani MERGE. Historyczna odmowa zachowana; poprawka zmienia wyłącznie jeden pin z42, z pełnym literalnym inverse czterech editów wcześniejszego źródła. |
| Pakiet16 — działający podgląd i odbiór MERGE | Manifest `691a7cb5e943e1474411906e9f5b9e69143761bf6e74676f6415dea4b41b7fac`,379 plików/100610231B. Oryginalny supervisor92463 zgłosił APP READY; HTTP health potwierdza tę rewizję i dostępność MERGE. API into-main oraz Chrome new-technical odebrane w opisanym wyżej zakresie. | Workery i scoped automation pozostają wyłączone. Odbiór MERGE nie obejmuje godzinnej skali, restore, wariantów opłaconych/WMS ON lub całego produktu. Panel email ma testy kodu, bez odbioru doręczenia; szczegóły stock nadal wymagają oryginalnego channel binding. |
| Oryginalny Main | Rewizja `db1a33d2…`, schemat 205. Koordynator potwierdził dziś HTTP200; oryginalny Main pozostaje bez przełączenia. | Odebrany punkt V2 nie oznacza pełnego klona Base ani odbioru późniejszych funkcji. |
| Lokalny podgląd 13 | Pakiet `b8d9cd6bbf56ddd176c98ba09dc90127e6f2befa9bd7d5006776c5ab93963ede`, schemat 209. Start zakończył się EXIT1 przed READY; oryginalne procesy tej próby potwierdzono jako nieobecne. | Classified MERGE 209 i wspólne wydanie nie są odebrane. Przyczynę odmowy Native 187/173 diagnozowano oddzielnie; nie ominięto jej w JS. |
| Native Source 18 | Rzeczywisty kompilator SQL 209 i 37/37 kontroli modułu przeszły. | Zestaw nie obejmował pełnego wejścia runtime 187/173. Późniejsza odmowa startu 13 pozostaje ważna; wynik modułu nie nadaje odbioru produktu. |
| Kandydat Source 19 | Dodano trzy prywatne adaptery historii; 24 kontrole plikowe PASS. Kompilator `69907` zakończył się EXIT1: pełny `ordinary187_valid()` przekroczył 8s (57014). Dokładna delta 235/14/0, literalne 28 starych tabel certyfikatów i pełny inverse do 208 przeszły. | Brak COMMIT i odbioru Native 19; 41 testów nie uruchomiono. Potwierdzono ROLLBACK, normalny DROP własnej bazy przy 0 połączeń i zamknięcie klientów. Start i operacja biznesowa pozostają otwarte. Nie uruchomiono przygotowanych nowych par classified MERGE. |
| Kandydat Source 20 | Domknięto źródłową projekcję historii kupującego i ograniczono niepotrzebne wejścia dla niezmienionych OID. Kompilator `1555` zakończył się EXIT1: cztery osobne kontrole i pięć predykatów modułu były true, ale pełny `ordinary187_valid()` przekroczył niezmieniony limit 8s (57014). Delta 238/14/0. | Brak COMMIT, brak wykonania 44 testów Native i brak odbioru startu lub MERGE. Potwierdzono ROLLBACK, normalny DROP wyłącznie własnej bazy przy 0 połączeń oraz zamknięcie obu klientów. Późniejsza diagnostyka poniżej oddziela wynik logiczny od kosztu pełnego wejścia; nie zmienia odmowy tej próby przy8s. |
| Diagnostyka Source 20 | Oryginalny terminal `25871` EXIT0: `ordinary187_valid()` i `large_import173_valid()` zwróciły true odpowiednio w14169,12ms i13617,65ms. Każde wejście wywołano raz w diagnostycznym limicie120s. | To potwierdzenie wyniku logicznego tych dwóch wejść, bez spełnienia wymaganych8s, p95 lub odbioru Native. Brak COMMIT, NativeQA, aktywacji aplikacji i operacji biznesowej; potwierdzono ROLLBACK, normalny DROP własnej bazy przy0 klientach oraz zamknięcie obu połączeń. |
| Domyślny Source21 | Oryginalny terminal `65047` EXIT1. Wspólny świeży snapshot i111 podmian odczytów SHA zachowują pełne kontrole; cztery single i wspólne pięć predykatów zwróciły true. Pełny `ordinary187_valid()` ponownie zakończył się57014 przy8s, w ścieżce snapshot/checked map→partial predecessor→buyer→PIM→parents. Delta240/14/0. | Brak COMMIT;46 testów Native **NOT_RUN**, bez odbioru Source21, startu i classified MERGE. Receipt potwierdza ROLLBACK, normalny DROP własnej bazy przy0 połączeń oraz zamknięcie obu klientów. Szybsze single nie oznaczają spełnienia bramy pełnego runtime. |
| Source21-LZ4 — eksperyment zakończony odmową | Oryginalne uruchomienie `22554` EXIT1, katalog `order-merge-delivery209-source-compiler-memory21-lz4-prepared-1792292778172`. Ten sam SQL956 i54 piny; sesyjne `default_toast_compression=lz4` odczytano przed DDL we własnej nowej bazie. Cztery single i wspólne pięć predykatów były true, ale pełny `ordinary187_valid()` przekroczył8s (57014), w ścieżce source-SHA/partial valid→financial/invoice/credit→PIM/parents. | Brak COMMIT;46 testów Native **NOT_RUN**. Potwierdzono ROLLBACK, normalny DROP własnej bazy przy0 połączeń oraz zamknięcie obu klientów. Limity8s/120s i900s dla QA pozostały bez zmian. Bez ALTER SYSTEM, restartu, przepisywania istniejącej bazy lub zmiany Main. Próba nie potwierdziła spełnienia8s, odbioru Native, classified MERGE ani recovery. |
| Diagnostyka Source21-LZ4 | Oryginalne uruchomienie `39873` EXIT0: pełne `ordinary187_valid()` i `large_import173_valid()` zwróciły true odpowiednio w8852,068875ms i8650,197292ms. Każde wejście wykonano raz z diagnostycznym limitem120s; po49 świeżych snapshotów kosztowało odpowiednio5570,00ms i5434,56ms. | Oba pełne czasy nadal przekraczają8s. To diagnostyka logiczna i kosztów, bez COMMIT,46NativeQA lub odbioru produktu, startu i MERGE. Wymuszony ROLLBACK, normalny DROP własnej bazy przy0 klientach oraz zamknięcie obu połączeń potwierdzono. |
| Osobny runtime PostgreSQL03 | Koordynator uruchomił oryginalny operator `46112`: PostgreSQL18.4, port57083, PID82507, własny katalog `full-base-accelerated-pg209-20261018-03/data`. Faktycznie załadowane prywatne crypto/SSL zgadzają się z pinami, osiem digestów SQL od0B do10MiB jest równych Node; pojedynczy10MiB trwał7,86ms. | To rzeczywisty **PG READY** nowego, odrębnego runtime. Nie jest to READY aplikacji, pełny test Native, biznesowy MERGE, odbiór godzinnej skali lub aktywacja Main. Stare klastry57081/55432 i Main pozostają bez podmiany. |
| Source21 na runtime03 — Native integrity reviewed PASS | Oryginalny operator `2451` EXIT0. SQL956/54pinów/generacja21, dokładna baza208 i delta240/14/0. Pełne187/173 true w2227,573375/2140,950917ms przy8s; COMMIT i46/46 Native PASS bez FAIL/SKIP/CANCEL. Literalne28 starych tabel certyfikatów oraz pełny odczyt poQA zgodne. Normalny DROP własnej bazy przy0 połączeń i zamknięcie obu klientów potwierdzono. | To odbiór kompilacji źródłowej i integralności Native w przypiętym runtime. Upgrade istniejącej kopii Source18→21 jest potwierdzony osobnym receipt04. READY aplikacji, classified MERGE UI/API, recovery, skala i wspólne wydanie pozostają otwarte. Main bez przełączenia. |
| Pakiet14 Source21 | Manifest `fe95bce1…` wiąże379 wpisów plików o łącznym rozmiarze100313555B, bez samego manifestu. Lokalne `b37cf5a`/`fb30bd1` obejmują pakiet i ścieżkę aktualizacji Source18→21;51 testów kontrolowanych oraz build PASS. Operator własnego PostgreSQL `d49ec98` ma36 testów kontrolowanych PASS. | Istnieje pakiet Source21; starsze wpisy o jego braku są historyczne. Upgrade04 na kopii przeszedł. Pierwszy start14 odmówił przed PG; nowy14b `7072` zakończył się EXIT1 przed READY; dokładna przyczyna oczekuje diagnostyki. Testy operatora pozostają dowodami kontrolowanymi; same nie nadają odbioru aplikacji. |
| Zachowana kopia preview na runtime03 | Oryginalny operator `38951` EXIT0: spójny custom dump37149111B z eksportowanego snapshotu źródłowej transakcji READ ONLY, następnie jednorazowy restore do nowej `dynaminds_full_base_source21_20261018` na57083. Źródłowy ROLLBACK oraz zamknięcie obu klientów potwierdzono; bazę docelową i dump zachowano. | To historyczny receipt samego kopiowania. Równość wszystkich627 tabel przed DDL i późniejszą aktualizację potwierdza upgrade04 poniżej; READY aplikacji i biznesowe UI/API pozostają otwarte. Nie zapisano źródłowej bazy57081 ani Main; nie wykonano DROP lub automatycznego retry. |
| Upgrade04 zachowanej kopii | Reviewed PASS: wszystkie627 tabel zgodne przed pierwszym GRANT,624 pozostałe po aktualizacji bez zmian; własne payload/manifest209 i kontrolna krotka182 mają dokładne źródłowe przejścia. Generacja+232/+267 bez approval, resetu lub wyłączania triggera. Pełne187/173 true w2151,299583/2150,275125ms przy8s, COMMIT i zamknięcie klientów potwierdzone. | To aktualizacja i ochrona danych własnej kopii na57083. Start14b `7072` ma FAILED_NOT_READY; bez odbioru aplikacji, classified MERGE UI/API, skali lub recovery. |

[Receipt Source21 na runtime03](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory21-accelerated-prepared-1792294650941/run/receipt.private.json), SHA256 `af03a68cb4441eb8410492f68dd7c32fa6a2164177c1af031bfddb506b0a36f2`, oraz [przegląd koordynatora](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory21-accelerated-prepared-1792294650941/run/root-review.private.json), SHA256 `5445dfdeeef966d122f3d0f6e02966f83a606b8bbdaca98141b5a033f623f77c`, potwierdzają powyższy zakres Native. Kontrakt E209 promowano z literalnego Source18 do Source21; prywatny wzorzec18 zachowano dla osobnej aktualizacji bez utraty danych. Aktualizację własnej kopii potwierdza upgrade04; odbiór biznesowy pozostaje otwarty.

[Manifest pakietu14](../../../local-builds/full-base-development-14/release.json) ma SHA256 `fe95bce18b2ede587cde36d01247ab2474e91c7f6bc17d2b5830536b25ba6aa8`. [Receipt zachowanej kopii](../../../local-builds/full-base-preview-20261017/source21-preview-copy-20261018/run/result.private.json), SHA256 `f8ea22f94b31d51b0e01d4c4d797f7f26879aa6b5299abd4dfa267dd8dfacf14`, ma status `COPY_RESTORED_PENDING_ROOT_POST_COPY_GATE`: zachowano oryginalny klucz szyfrowania, zmieniono wyłącznie hasło DB w osobnej konfiguracji. Sam wcześniejszy receipt kopii nie potwierdzał równości ani aktualizacji; wymagania te zamknął osobny upgrade04. Start i biznesowy odbiór pakietu14 pozostają otwarte.

**Aktualizacja18.10 — upgrade04 na zachowanej kopii: reviewed PASS.**
[Receipt upgrade04](../../../local-builds/full-base-preview-20261017/source21-preview-upgrade04-20261018/receipt.private.json),
SHA256 `c2c215ead48b85157f074dabcbcec6eb30193b2c2fbf903386839d94bd2d482d`,
oraz [przegląd koordynatora](../../../local-builds/full-base-preview-20261017/source21-preview-upgrade04-20261018/root-review.private.json),
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
[Receipt predykatów](../../../local-builds/full-base-preview-20261017/source21-pim-predecessor-UTC-predicates.private.json),
SHA256 `f5155a71a37518d9305babf41ff54a4148daa434e582de2e523acf5f08cc9312`.
[Osobna kontrola metadanych](../../../local-builds/full-base-preview-20261017/source21-current-metadata-identity.private.json),
SHA256 `c5dfebe2c974bd05d337ebd6b9ab5e0595d6150914c43152be2e9887c12a5d4c`,
potwierdza identyczny surowy katalog `90c26f9b…` jak po upgrade04 i brak mutacji metadanych
podczas startu. Historyczne46 testów Native nie sprawdzało czterech bezpośrednich capability;
rozszerzenie QA `805130d` dodaje te kontrole źródłowo, bez nowego wyniku Native.
Most biznesowy split `f9323d2` ma36 kontroli i build PASS koordynatora; Native210, routes i UI
pozostają nieaktywne. Jednorazowa diagnostyka wave wskazała `ROOT_WAVE_TERMINAL_OPERATIVE`: wcześniejsze34 warunki i terminal nested przeszły, a operative zwrócił false. Receipt `892862541c5c92b1e875e6f356311e534bc5f8cf9d497c79ff4c1850114393e7` potwierdza ROLLBACK, niezmienioną krotkę182, brak funkcji tymczasowej po rollback i zamknięcie klienta. To lokalizacja odmowy, bez odbioru poprawki lub startu.


Domyślny operator Source21 zachował deklarowaną bazę Git `095af87b61c305381ea1b7e9c04460194af010e3`; kod kandydata zapisano następnie lokalnie w `f225163c6e8bb2ba81ed6468eb5b41e580f9e2ae`. To identyfikatory pochodzenia kodu, bez nadania odbioru wydania. SQL ma SHA256 `95605368565cbec656fd41db95192879d450d700d13424bb7b575186c447572b` i27545803B. [Receipt domyślnej próby21](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory21-prepared-1792292504656/run/receipt.private.json) ma SHA256 `d77922eaf2444773fb984d8df68335b73d157ddc548d5d85567032703f730f17`. Nieudany wynik pozostaje zachowany; próba LZ4 nie jest jego ponowieniem ani zastąpieniem dowodu. [Receipt osobnej próby LZ4](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory21-lz4-prepared-1792292778172/run/receipt.private.json) ma SHA256 `197d77b710c68de4a286486665398901f76128de7d8c6240ad73a6a0069c9051`. Jej single trwały odpowiednio150,30/1891,55/1244,22/14,78ms; nie są pomiarem p95 ani dowodem kosztu pełnego wejścia.


[Receipt diagnostyki Source21-LZ4](../../../local-builds/full-base-preview-20261017/source209-full-runtime-profile21-lz4-prepared-1792293093679/run/receipt.private.json), SHA256 `548c5ad8eb56dc8527d356068ac13cf4286224462d3435a70618714a22f812df`, zachowuje status `DIAGNOSTIC_FULL_RUNTIME_PROFILE_COMPLETE_ROLLED_BACK_NOT_ACCEPTED`. Pojedynczy pomiar w stałej kolejności nie jest p95 ani dowodem spełnienia8s. Oddzielny prototyp współdzielenia aktualnych bajtów definicji pozostał niepodłączony po rzeczywistym pomiarze opisanym poniżej; nie nadaje odbioru Native.


Osobny [read-only pomiar prototypu bajtów definicji](../../../local-builds/full-base-preview-20261017/fingerprint209-definition-bytes01-diagnostic.private.json), SHA256 `8cef69bbb9d6e255a2d3f60bc581616ef7bbf02ae5ad636ee37d8189d8cd13cc`, potwierdził pełną równość fingerprintu i wszystkich 24 pól dziesięciu funkcji. Trzy pary EXPLAIN dały oryginał 105,782/105,307/107,186 ms oraz prototyp 104,000/106,082/105,693 ms. Nie wykazano istotnego przyspieszenia; nowy plan zapisał 634 bloki tymczasowe. ROLLBACK i zamknięcie klienta potwierdzono. Prototyp **odrzucono do integracji**; SQL Source21 nie został nim zmieniony.

Rzeczywista, dotychczas załadowana libcrypto/OpenSSL 3.5.6 ma skalarny kod SHA256 bez instrukcji ARM SHA256. Osobny prywatny build tej samej wersji, ARM64/ASM/O3, ma te instrukcje oraz zgodne eksporty 107 symboli OpenSSL używanych przez PostgreSQL. [Receipt builda i mikrobenchmarku EVP](../../../local-builds/crypto-accelerated209/openssl-3.5.6-arm64-o3/build-result.private.json), SHA256 `9cc4e7880865ac87601c802d5cf246fc2b08491e61856a527627ce3ce57fc81f`, zapisuje równość digestów dla starej biblioteki, nowej i Node. W 12 próbach po 10 MiB mediany wyniosły odpowiednio 84,609/3,607/3,592 ms. To pomiar samego EVP, nie pełnego SQL, p95 lub odbiór Native. Nie podmieniono biblioteki wcześniej działającego serwera. Sam mikrobenchmark nie uruchamiał PostgreSQL; odrębny runtime03 osiągnął później PG READY opisany poniżej ; źródłowy Native przeszedł później w niezmienionych limitach, a odbiór aplikacji i procesów biznesowych pozostaje otwarty.


[READY odrębnego runtime03](../../../local-builds/full-base-accelerated-pg209-20261018-03/ready.private.json), SHA256 `2a14f74ce1ecf54b032a1b2cfef6b3097a9d5fa7b9802a45d34a4af5f8f30a2f`, wiąże binarium PostgreSQL `00581df2…`, manifest `6d2abeec…`, staged libcrypto `5434d2fb…` i libssl `bb86be6e…`. Ich sekcje `__TEXT,__text` są identyczne ze źródłowymi kopiami; zmiany linkowania i lokalny podpis ad-hoc dotyczą wyłącznie nowego prywatnego pakietu. Oryginały i ustawienia systemowe pozostały bez zmian. Sam wcześniejszy mikrobenchmark nie uruchamiał bazy; obecny PG READY jest osobnym rzeczywistym dowodem.

Dwie wcześniejsze próby startu zostały zachowane jako nieudane: [01](../../../local-builds/full-base-accelerated-pg209-20261018/failed.private.json) odmówiła przed SQL z powodu ścieżki gniazda Unix dłuższej niż103B; [02](../../../local-builds/full-base-accelerated-pg209-20261018-02/failed.private.json) nie potwierdziła nowych bibliotek, ponieważ podpisany hardened-runtime ignorował DYLD. Druga próba utworzyła wyłącznie techniczną rolę `dyna_app` w swoim nowym klastrze, bez danych biznesowych i aplikacji. [Normalny stop01](../../../local-builds/full-base-accelerated-pg209-20261018/stopped.private.json) i [stop02](../../../local-builds/full-base-accelerated-pg209-20261018-02/stopped.private.json) są zapisane; koordynator potwierdził zwolnienie wyłącznie ich78,242MiB danych przy zachowaniu logów i receipts. Wyniku FAILED nie zastępuje kod0 pierwszego narzędzia; rzeczywisty status odczytano z receipt i logu.

Historyczna próba Source20 wiązała bazę `869e12a`, SQL `d69ed0c143b42caaa5f830c1978a0e7013894d06c75113017c17d1aa34d3350e` oraz receipt `233f50563a35c0b65967223a17d182c3342229e5719dbd25d6a7e8aa64cc63ba`, przy49 pinach wejść. Jej późniejsze logiczne true w diagnostyce120s pozostaje ważne w swoim zakresie; nie znosi odmowy przy8s i nie nadaje odbioru nowszemu Source21.

Osobny [odczyt fizycznego TOAST Source18](../../../local-builds/full-base-preview-20261017/source209-current-toast-readonly-probe.private.json), SHA256 `bb8db7dd2bb4d6aca92a22d6d4dcad1b0cc3c2b2ea58e14d0d1ffca85ffbc893`, wykazał PGLZ dla trzech dużych ciał funkcji. Odczyt był bez DDL, zakończony rollbackiem i zamknięciem klienta; nie jest pomiarem kompilatora21. Rzeczywiste binarium embedded PostgreSQL18.4 ma opcje `--with-openssl`, `--with-lz4` i `-O2`; proces ładuje libcrypto/OpenSSL3.5.6 i liblz4. Samo wsparcie bibliotek nie dowodzi szybszego hashowania, dekompresji ani spełnienia8s.

Lokalne commity `a251dfe`, `869e12a` i `216f67c` dodają atomowe rozróżnienie nowego zapisu i replay dla płatności/przyjęć RMA, odzyskiwanie podglądu split niezależne od kolejności pól JSON oraz powiązanie próbek obciążenia z trwałą tożsamością efektu. Testy kontrolowane tych zakresów przeszły; nie wykonano jeszcze tych zmian przez działające wspólne HTTP/UI ani pełnego pomiaru skali. Pełny executor nadal jawnie odmawia uruchomienia przez siedem brakujących bramek profilu.


Lokalne commity `28a3787` i `4cf53ed` obejmują odpowiednio częściowy binding RMA oraz ograniczone odczyty lokalnego workera. Przeszły52 i22 testy kontrolowane; to dowody kodu w swoim zakresie, bez nowego odbioru wspólnego UI/API, dostawcy, godzinnej skali lub recovery. Lokalne `977c9bd` (płatności, 10 testów kontrolowanych) i `2dbd6ce` (uzgadnianie całej historii, 29 testów kontrolowanych) dostarczają kolejne poprawki kodu. Nie stanowią odbioru wspólnego wydania ani godzinnego profilu skali; osobny odbiór PostgreSQL i biznesowego UI/API zachowuje własny zakres dowodów.


Lokalne `db5659e` (komunikat ograniczonej historii), `08934b7` (rzeczywiste testy SQL na izolowanych tabelach tymczasowych:26PASS) i `8a1b98c` (stronicowana lista nieuzgodnionych skutków,53 testy kontrolowane oraz końcowy zestaw29/29 rzeczywistych testów PG TEMP) rozszerzają nadzór automatyki. Koordynator potwierdził również build. [Izolowany odbiór wizualny komponentu](../../../local-builds/full-base-preview-20261017/unresolved-ui-visual/1792294587221/receipt.private.json), SHA256 `79ef84e6de46082d5c610a5ec9706d089594796f4f2d070370c35275e2c5af9a`, używał rzeczywistego komponentu iCSS przy1440px/390px bez przepełnienia. Dane były syntetyczne; nie dowodzi to uwierzytelnionego przepływu, rzeczywistego API/PG, biznesowego POST ani całego układu aplikacji.


[Receipt diagnostyki Source20](../../../local-builds/full-base-preview-20261017/source209-full-runtime-profile20-prepared-1792291691304/run/receipt.private.json)
ma SHA256 `6532b7cde2a0f9c262fbce11715ef246d036a17981ef57ebcb2a91f87dbb76ec`.
Logiczne true w dłuższym pomiarze nie znosi wcześniejszego57014 przy8s;
pełne wejścia,44 testy Native, start i classified MERGE muszą przejść swoje
niezmienione bramy na jednym nowym wydaniu. Te wyniki nie potwierdzają
spełnienia8s ani kosztu nowszego wydania. Commit `7222768` dodaje częściowy binding ujemnych
korekt WMS i atomową deduplikację identyfikatorów operacji, dokumentu oraz
fragmentów. Jego 34 testy kontrolowane przeszły; rzeczywisty WMS/API/UI nie
został jeszcze odebrany. Nowy runner podziału zamówienia ma 20 testów
kontrolowanych i domyślnie `PREPARED_NOT_RUN`; oczekuje rzeczywistego Native210,
rejestracji tras i osobnego dowodu fizycznego transferu.


Dowody Source22b: [receipt](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory22b-accelerated-prepared-1792299862194/run/receipt.private.json), SHA256 `9942cd0f31631af320c535b424a0c41ee7a3ad912faba64a964b44da8d0f5989`; [przegląd Root](../../../local-builds/full-base-preview-20261017/order-merge-delivery209-source-compiler-memory22b-accelerated-prepared-1792299862194/root-terminal-review.private.json), SHA256 `c3083fdf081056ef7085cae2423ecfa7233d37722769a9dfe32b37e2326737c1`; aplikacyjny inverse SHA256 `d99f597bc9eb08e93ec196fbbf469ad49e101f41f36e896b13df9d72c41b6051`.

Dowody upgrade02: receipt `09dbc56bbfddd58ec82c98fab4dd1eb004e10d587ac5e140840b4076b86149bb`, Root review `b70c7a5d30380d3a7f0b58398b598ff075b6c4eb744b68616b98722328f9fbb4` w `local-builds/full-base-preview-20261017/source22b-preview-upgrade02-20261018`. Zintegrowany zestaw Root obejmujący źródła, codecs, pełny inverse, startup, cold gate i oba plany aktualizacji:76 PASS /0 FAIL /0 SKIP.

## Co pozostaje do pełnego Goala

1. Zamknąć pełny katalog wymagań. [Scope v2](parity/scope.v2.json) jest zamrożonym, częściowym zakresem 2585 wymagań, z `scope_complete:false` i bez akceptacji produktu.
2. Odebrać kompletne OMS/PIM/WMS, w tym classified MERGE i [split 1→N](parity/order-split-implementation-plan.md), przez zwykłe UI/API. Fundamenty, czyste kalkulatory i testy modułów nie są wykonaniem całego procesu.
3. Domknąć finanse, dokumenty, B2B, komunikację, repricing, raporty i AI według [matrycy domen](parity/domains.json). Wąskie wcześniejsze odbiory nie obejmują wszystkich wariantów.
4. Rozliczyć operacje [integracji](parity/integrations.json) osobno na poziomie kodu, lokalnego działania, oficjalnego sandboxa i konta dostawcy. Symulator lokalny nie zastępuje dostawcy; brak poświadczeń pozostawia wymaganie otwarte.
5. Rozszerzyć odebrane lokalne [API–worker–SMTP](parity/WORKER-SMTP-LIFECYCLE-LOCAL-20261018.md) oraz [tworzenie i sterowanie regułami przez UI dwóch firm](parity/WORKER-UI-CONTROL-LOCAL-20261018.md) o pełny onboarding, pozostałe wymagane skutki/providerów oraz wszystkie firmy profilu docelowego. Powtórzyć kompletny lifecycle na wspólnym końcowym wydaniu; szczegóły w [planie workerów](parity/worker-lifecycle-plan.md).
6. Domknąć codzienny interfejs, zwykłe role, izolację firm i powtarzalną lokalną obsługę środowiska. Odczyt dokumentu w Chrome nie oznacza wykonania jego utworzenia przez UI.
7. Wykonać zamrożony [profil skali](parity/acceptance-profile.README.md):100 tys. SKU, 100 tys. zamówień, pięć aktywnych firm, godzina przy współbieżności 12/24 z workerami, importem i synchronizacją. Specyfikacja i narzędzia nie są pomiarem.
8. Odebrać wszystkie wymagania na jednym wydaniu, wraz z utratą ACK, restartem, niepustymi kolejkami i backup/restore. Końcowy pełny odbiór nie został udzielony.

Szczegółowe dowody i granice: [rejestr rozwoju](parity/README.md), [MERGE 209](parity/order-merge-delivery-inheritance.md) i [korekty 207](parity/RETURN-CREDIT207-INTEGRATION.md). Historia odebranego punktu wyjścia: [status local-app](../../../local-app/docs/CURRENT-PRODUCT-STATUS.md) i [odbiór V2](../../../local-app/docs/V2-ACCEPTANCE.md).

Praca pozostaje wyłącznie lokalna; Docker jest dozwolony. Ten przekrój nie zmienia Goala, uprawnień ani stanu usług.
