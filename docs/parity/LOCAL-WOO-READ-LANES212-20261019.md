# Automatyczne odczyty lokalnych sklepów — etap 212

Status: **zwykła aktualizacja N12 i zachowanie danych PASS; rzeczywiste cykle nadal otwarte**.
Aplikacja pięciu sklepów działa na wydaniu N12 `0d9c15979a240b3257cac3737f63a2cf0b39527bd7313f2aaaefe130a7e387f8`.
Wcześniejszy odebrany import, korektę w Chrome i wysłanie stanu do Woo opisuje
[raport procesu pięciu sklepów](FIVE-NATIVE-BUSINESS-LOCAL-20261019.md).

## Implementacja

- Dwa niezależne harmonogramy na własny kanał: zamówienia i katalog produktów,
  dla maksymalnie pięciu wybranych lokalnych sklepów.
- Trwała konfiguracja, wersje CAS i niezmienne potwierdzenia poleceń; osobne
  przebiegi i intencje wykonania. Cztery tabele z FORCE RLS i kluczami obcymi.
- Pauza i jawne wznowienie potwierdzonej kontynuacji. Rozpoczęte wykonanie
  bez potwierdzenia pozostaje do uzgodnienia także po restarcie.
- Istniejące procesory pobierają dane do przeglądu. Transport dopuszcza tylko
  GET do wybranego lokalnego sklepu. Ten proces nie zatwierdza importów,
  nie tworzy produktów biznesowych i nie wysyła stanów ani cen.
- Przed zapisaniem odebranych danych procesory ponownie sprawdzają aktualną
  rolę, kanał, zaszyfrowane poświadczenia i dzierżawę w tej samej transakcji.
- Zwykły panel sklepu: włączenie, pauza, wznowienie, historia, szczegóły
  wykonania i odczyt serwerowego potwierdzenia po utracie odpowiedzi.
- Jedna pętla bez nakładających się cykli; start po nasłuchu aplikacji,
  zatrzymanie i opróżnienie przed zamknięciem rejestru sklepów.
  Osobna flaga `--local-woo-reads` wymaga przypiętego wyboru sklepów;
  dotychczasowe uruchomienia pozostają bez nowej automatyki.

Testy wykryły i naprawiły m.in. konflikt dwóch kart przy odczycie potwierdzenia,
blokadę późniejszego podłączenia sklepu po bezczynnym starcie oraz możliwość
zapisu po odebraniu uprawnień lub zmianie poświadczeń podczas odczytu.

## Baza i granice odbioru

Rzeczywisty kompilator wykonał istniejące199 etapy,209,211 i nowy212 na osobnej
pustej bazie. Pierwotny wynik jest zachowany jako FAILED: walidator błędnie
uznał relacje indeksów za dodatkowe tabele. DDL i odczyty zakończyły się ACK.

Poprawiony walidator i niezależne uzgodnienie kompletnych zapisanych wyników
potwierdziły **239 dodatków,0 zmian i0 usunięć**. Są to cztery tabele,13 relacji
indeksów i ich pełne metadane; osiem zewnętrznych FK ma16 właściwych triggerów
RI. Po odjęciu dodatków odzyskano dokładnie40640 rekordów Source211, pełne
liczniki i canonical SHA256 `98c9759312bdd4b00c04fa53da8d07da85c960610b262b89ebdcfec9d42a9f33`.
ROLLBACK, zamknięcie obu klientów, usunięcie własnej bazy i zachowanie ról
potwierdzone. Późniejsze sprawdzenie227 przypiętych źródeł było zgodne.

Późniejszy rzeczywisty operator wykonał siedem pełnych bramek SQL przed i po212:
ordinary187, buyer address, merge209, return credit206, structure188,
metadata211 i large import173. Wszystkie14 wyników TRUE, przy niezmienionym
limicie8s serwera/9s klienta, bez ponowień. Pełny inverse211,239 dodatków,
ROLLBACK, zamknięcie klientów, usunięcie własnej bazy i zachowanie ról PASS.
Receipt: `03c83579bf08e9f385c39ff7fc5e4f98d17127e9a35957c5f70d4b9891d8c675`.

## Zwykła aktualizacja N12

- Źródła: lokalny commit `20542a9c1ef3effb516aa2b4e914a38d223190de`;
  świeży Vite z izolowanego zestawu1292 plików. Zależności współdzielone,
  bez instalacji i kopiowania node_modules.
- Wszystkie386 plików pakietu zweryfikowane po pełnych bajtach i SHA;
  razem100356145B, limit pojedynczego pliku16MiB i całości96MiB zachowany.
  Kontrakt źródłowy77/41/30;212 jest obecny, nieodebrany split210 nieobecny.
- Normalny stop N11 zakończył się EXIT0. Normalny start N12 przez dotychczasowy
  lokalny supervisor osiągnął READY. Ta sama baza, konfiguracja, port4105
  i pięć sklepów; dodana wyłącznie flaga `--local-woo-reads`.
- Health potwierdził rewizję N12, schemat212 i działający procesor odczytów.
  Pozostałe workery globalne i scoped pozostają wyłączone.
- Rzeczywisty odczyt BEFORE627 i AFTER631 tabel:625 dawnych tabel w całości
  identycznych; cały dawny hash migracji odzyskany po odjęciu dokładnie jednego
  nowego wiersza212. Generacja1744→1769 jest zatwierdzona i czysta; zmiana
  przypięcia wydania zgodna. Cztery nowe tabele puste przed włączeniem w UI.
  Wszystkie stare dane biznesowe zachowane. Oba odczyty RRRO/ROLLBACK/end PASS.
- BEFORE: `a968b84748f64b2d2745678fce4074b8b80ad14e821e0373a90569a84aff73c3`;
  AFTER: `02cb2adf061e138393e14847e9ed998fad6125ba10ad133ce286dd744ffa4602`;
  rzeczywisty READY: `64248d94819a2b259dbd46243dcf3f3fccd6baf280f84b0112aed9e765631482`.

Panel Chrome własnej firmy A po aktualizacji potwierdził działający procesor,
dwa oddzielne harmonogramy60s, własny magazyn i pustą historię.

Pierwsze zwykłe włączenie zamówień w UI zakończyło się500. UI zachował
niepewne polecenie i zablokował ponowienie; osobny obserwacyjny odczyt wyniku
potwierdził brak zapisanego ACK, bez ponownego zapisu konfiguracji. Obserwator
naturalnych cykli zakończył się EXIT1 po180s bez włączonych harmonogramów.

Rzeczywisty parser PostgreSQL, w transakcji READ ONLY i bez EXECUTE, potwierdził
dwie wady zapytań:42P08 dla parametru odstępu użytego jako integer/double
precision oraz42883 dla identyfikatora kanału użytego jako text/uuid.
Jawne rzutowania obu zapytań przechodzą PREPARE. Osobny końcowy odczyt wszystkich
631 tabel po błędzie i odczycie wyniku potwierdził ich pełną niezmienność względem
AFTER aktualizacji: `cf05025467933b3a47bc4a7cbb1dfae8d1dd3f4bb64738d2ff89de837ef4be42`,
RRRO/ROLLBACK/end PASS. Przed UI zapisano37 GET pełnych stanów biznesowych
i natywnych pięciu sklepów, receipt `1c92b9467e9ed28d6d99fef5d23d93067c92d0dbc17eb1f97e7d42732d599940`.

**N12 nie odebrał naturalnego cyklu.** Poprawka źródeł i jawne anulowanie
niepotwierdzonego polecenia wymagają kolejnego wydania i rzeczywistego odbioru.
Otwarte pozostają rzeczywiste odczyty po
terminie, pauza/wznowienie, restart, utrata potwierdzeń i wyścigi dwóch instancji
na PostgreSQL. Kontrolowane testy ich nie zastępują.

Pełny Goal, katalog integracji, skala100 tys. SKU/100 tys. zamówień i końcowe
odtwarzanie platformy pozostają otwarte.
