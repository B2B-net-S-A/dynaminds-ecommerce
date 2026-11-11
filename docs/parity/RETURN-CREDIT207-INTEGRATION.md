# Zwrot magazynowy i korekta — ordinary API10: cztery przypadki PASS

## Aktualny odbiór ordinary HTTP10

Wydanie `49e3a6fdf5780802e5eb562010b634afb0512ebe074ad8017141523e8eb38f55`,
schemat208, zwykła lokalna aplikacja4103: `PASS_ORDINARY_HTTP`, cztery przypadki
i203 żądania drivera. Dodatkowy preflight wykonał odrębne żądania;203 nie jest
liczbą całego ruchu przygotowania. Stare niepewne próby06/07 pozostają zachowane
i nie były automatycznie wznawiane.

| Przypadek | Wynik zwykłego API |
|---|---|
| WMS OFF | E2E-OFF-03/2026/000001, −27,00 zł; pozostało17,01 zł |
| WMS ON | ZWROT-ON/2026/000001, −27,00 zł; pozostało17,01 zł |
| Wyłącznie odrzucenie | Brak nowego dokumentu, numeru i finansowego POST następcy |
| Prawdziwa stara188 i nowa207 | ZWROT-MIX/2026/000001, −17,00 zł; pozostało17,01 zł; dwie rodziny w historii, stary replay zachowany |

Driver sprawdził oryginalne komendy, preview po wystawieniu, dokumenty/druk,
odmowę nowych starych zapisów i readback. Przed każdym finansowym POST
trwale zachowano dokładny body i oryginalny klucz, bez automatycznego retry.
Porównanie stock/payments dotyczy odczytów API wykonanych przez driver;
nie jest nowym snapshotem wszystkich fizycznych tabel DB.

Dowody w `local-builds/full-base-preview-20261017/return-credit207-ordinary10-1792270843651/`:
`result.private.json`, identyczny `result-observed.private.json`,54 zdarzenia
`progress.private.jsonl` oraz `http-mutation-intents.private.jsonl`.
Osobny bieżący przegląd Chrome i dowody znajdują się w
`ordinary10-chrome-review/`. Nie nadajemy temu zestawowi odbioru pełnego UI,
IAM/concurrency, restartu/ACK-loss, dostawcy refundacji lub skali.

Poniżej zachowano historyczne etapy i ich pierwotne granice; aktualny wynik
nie zmienia wcześniejszych niepowodzeń w sukcesy.

17.10.2026. **Rzeczywiste PostgreSQL: 4/4 PASS, bez pominięć.** SQL207 ma
SHA256 `8abe73aec97e294860f918c7285c016444fce15322bf03148926f41041076172`.
Stare SQL188, jego20 funkcji i struktura oraz reader206 pozostały literalne.
Nie zastosowano207 do Main ani działającego podglądu05.

## Wykonane scenariusze

Prawdziwe faktury157 i historie zwrotów utworzono wcześniej przez zwykłe API
podglądu05. W odrębnej kopii sprawdzono:

- pełne odrzucenie148: brak received_at, brak przyjęcia169 i brak finansowej
  sekwencji; źródło zwraca brak potrzeby korekty, bez dokumentu i numeru;
- odrzucenie, a następnie prawdziwe przyjęcie oraz częściowe przyjęcie WMS ON;
  z faktury44,01 zł powstaje uznanie27,00 zł, pozostaje sprzedaż17,01 zł;
- własne serie, preview, wystawienie i dokładny replay tego samego klucza;
  odmowę złej zgody, innej firmy, zmienionego scope i kolizji numeracji;
- rollback, bieżące cofnięcie roli i sześć uszkodzeń historycznego dowodu;
  pełny odczyt33 zbiorów fizycznych oraz płatności potwierdza brak dodatkowych
  skutków magazynowych i wypłaty przez samą korektę.

Wynik dotyczy Native SQL w PostgreSQL, a nie wywołania nowego endpointu
przez zwykły runtime. Nie dowodzi jeszcze konkurencji dwóch nowych korekt,
restartu procesu, utraty ACK w rzeczywistym HTTP ani pełnego mieszanego
łańcucha wcześniejszej188 i nowej207 na autentycznych danych.

## Dowody i niezależny przegląd

W `local-builds/full-base-preview-20261017/return-credit207-genuine05-1792257815982/`:

- `native207-final-1792258585500.receipt.private.json`, SHA256
  `4fe9d8e43601ff80c24aa0de9827840518c7640024ca2dcdf7b274f0bcb6424a`;
- `final-evidence-index.private.json`, SHA256
  `3ebefb7aeedbf2941ac0efc75776397220d4cf332ce9ff38620b4b821eeabd09`;
- `Root-native207-review.private.json`:9 artefaktów sprawdzonych strumieniowo,
  TAP4 PASS/0 FAIL/0 SKIP i zgodne piny źródłowe przed/po wykonaniu;
- `Root-legacy-admission.private.json`: rzeczywista odmowa nowej starej
  komendy dla trzech autentycznych historii, rollback i14 zbiorów bez zmian;
- `Root-scratch-cleanup.private.json`: własną testową DB usunięto normalnie
  dopiero po0 połączeń, bez przerywania cudzych procesów.

Późniejsza poprawka DTO `can_issue=false` dla już wystawionego preview zmienia
service TypeScript, więc nie przypisujemy starego pinu tego service nowemu
wydaniu. Sam SQL207 i wykonany test Native pozostają dokładnie te same.
Poprawka stanu preview ma osobne testy; potrzebuje też normalnego HTTP odbioru.

## Kompilacja schematu i pozostałe bramy

Niezależny kompilator196 migracji i4 companion sources odtworzył najpierw
pełne literalne expected205, następnie zastosował206 i207. Otrzymał539
addytywnych rekordów metadanych, bez zmiany lub usunięcia starych.
Pierwsza próba kompilatora odmówiła z powodu parsera pomijającego wieloliniowe
migracje125/126; błąd parsera poprawiono, zachowując pierwotny EXIT1 i stare
expected. Wynik źródłowy nie pochodzi z obserwacji bazy przypadków biznesowych.
Nowa dokładna projekcja oraz porównanie pełnego katalogu są osobnymi bramami;
sama kompilacja nie oznacza certyfikacji Native lub udanego cold.

UI ma16 kontrolowanych testów React PASS oraz pełny lokalny build. Obejmuje
wybór strategii bez fallbacku, własną i kolejną serię, niepewny wynik bez
automatycznego replay, odczyt dokumentów z kopii i blokadę zapisów w kopii.
To kontrolowane DTO, nie odbiór Chrome na nowym pakiecie.

Nadal wymagane: integracja końcowego kontraktu/migratora, pakiet i zwykły
start, rzeczywiste API oraz Chrome, mieszana historia188/207, concurrency,
ACK-loss/restart i uzgodnienie rozliczenia. Rzeczywista refundacja u dostawcy
jest odrębną otwartą funkcją. [Pełny Goal](../FULL-BASE-GOAL.md) pozostaje aktywny.

## Bieżąca integracja źródeł — bez zmiany działających usług

Koordynator przeniósł stabilny kod biznesowy i UI do `development/full-base`.
Łączne skupione sprawdzenie modelu, tras, zabezpieczenia starego zapisu,
odczytu stanu wystawionego preview i React zakończyło się40/40 PASS.
Stan wystawienia preview jest odczytywany z trwałego receipt w obu rodzinach,
również dla oryginalnej komendy i dokładnego ponowienia POST.

Niezależny przegląd kompilatora potwierdził wszystkie539 dodatków w źródłowym
i rzeczywistym katalogu oraz brak zmian pozostałych39676 descriptorów źródła.
Dowód: `return-credit207-source-compiler-corrected-1792258763830/Root-independent-review.private.json`
w katalogu podglądu. Pierwsze zbyt szerokie porównanie koordynatora zakończyło
się EXIT137; drugi, sekwencyjny przegląd zakończył się EXIT0. Nie przypisujemy
pierwszej próbie sukcesu ani nie zmieniamy jej wyniku.

Przygotowano następny kontrakt budowy59 plików:
`build-input/source-contract-return-credit-04/release.json`, SHA256
`1d8ea45cad203f9821e6e8f2d3fc8ed7835065a0a19185a0ea4caa21d7f96c76`.
Zmienia tylko przypięty `server/app.ts`, dodający rejestrację nowych tras;
kontrakty Native i adaptera są literalne względem poprzednika.
To wejście budowy, bez uruchomienia aplikacji i bez odbioru nowego wydania.

## Rzeczywisty start06 i zachowana odmowa odbioru API

Pakiet06 `1e9044ee6cb59fda0013b8fb64059b74917cab0a9ea8831433c666633e63bc97`
uruchomił się na istniejącej kopii podglądowej z migracją205→207. Gotowość
osiągnął po około72s (jedna obserwacja operacyjna, bez odbioru trzech startów
profilu skali). Main zachował swoje wydanie205; PostgreSQL nie restartowano.
Dowód: `preview06-ready.private.json` w katalogu podglądu.

Pierwszy odbiór ordinary HTTP zakończył się EXIT1 po wystawieniu pierwszej
korekty. Odczyt dokumentu, druk, oryginalne komendy, dokładny POST preview
po wystawieniu i replay issue zwróciły poprawne odpowiedzi. Końcowy ogólny
source wybrał jednak wcześniejszy odrzucony zwrot i zwrócił
`no_commercial_change` zamiast stanu późniejszego, już skorygowanego przyjęcia.
Nie uznajemy całego przypadku ani zestawu czterech przypadków za odebrane.
Pełne klucze i potwierdzone odpowiedzi zachowano w
`return-credit207-ordinary06-1792259843976/failure.private.json`; nie wolno
ponawiać tego przypadku jako świeżego zapisu.

Poprawka prezentacji wybiera jawny zwrot, następnie oczekujące przyjęcie,
a przy braku oczekujących — najnowsze rzeczywiste przyjęcie lub odrzucenie.
Porządek zachowuje mikrosekundy fizycznych receipt, bez używania dat korekt.
Siedem testów selekcji i dziesięć wcześniejszych testów arytmetyki przeszło.
SQL207 i jego niezależna kompilacja pozostały literalne. Poprawka wymaga
następnego niezmiennego pakietu oraz ponownego odbioru zwykłego API.

Późniejsza rzeczywista regresja odczytu na pakiecie07 potwierdziła naprawę
tego wyboru: sześć odpowiedzi HTTP200 (health, login, switch, ogólne źródło,
dokument, jawnie wybrany odrzucony zwrot). Ogólne źródło zwraca
`already_credited`, a jawny odrzucony zwrot `no_commercial_change`.
Istniejący dokument06, jego−2700gr i pozostałe1701gr zachowano.
Zero finansowych POST, replay lub SQL. Dowód:
`return-credit207-source07-readonly-prepared-1792261633847/receipt.private.json`,
SHA256 `0d9b9293b4a6cbf0b400c4c449fd3cf606bf39f7872d82fe855b8c66f2986ae3`.
Pierwsza próba obserwatora odmówiła po samym health z powodu zbyt krótkiej
oczekiwanej nazwy schematu; zachowano ją osobno, bez logowania lub zapisów.
Powyższy odbiór dotyczy regresji odczytu, nie całego przebiegu czterech przypadków.

## Podgląd07: poprawny odczyt UI, otwarta wydajność przygotowania

Pakiet07 `2024d33281e1e266e2c9255d17b447269d32662518a44b7be4bf61024437e2e9`
osiągnął gotowość na tej samej kopii207. Chrome potwierdził rzeczywiste
logowanie i przełączenie firmy, rejestr, powiązanie istniejącej korekty
ze sprawą przyjętą, brak dokumentu dla sprawy odrzuconej oraz wydruk.
Na wydruku widoczne są netto−21,95 zł, VAT−5,05 zł i brutto−27,00 zł.
Dowód i cztery obrazy: `preview07-credit-ui.private.json`. Dokument wystawiono
wcześniej przez API06; ten przegląd nie odbiera wystawiania przez Chrome.

Nowy ordinary przebieg na świeżym OFF zatrzymał się przed wystawieniem:
seria została zapisana, a POST preview zwrócił503. Zachowany terminal1815
zakończył się EXIT1. Log PostgreSQL potwierdza statement timeout podczas
drugiego `return_credit206_frame`, wywołanego z triggera preview; w stosie
występuje `catalog_header205_valid`. Nie zmieniono limitu8s ani guardów.
Równolegle wykonywano zwykłe odczyty UI w innej firmie; sam ten fakt nie
dowodzi przyczyny ani udziału poszczególnych funkcji w opóźnieniu.

Osobne read-only uzgodnienie wykonało8 requestów: oryginalna komenda preview
zwróciła404, seria istnieje, rejestr korekt jest pusty, źródło nadal wskazuje
−2700gr. Dowód:
`return-credit207-preview07-reconciliation-1792260571716/receipt.private.json`;
wyciąg serwera: `pg-preview-timeout.private.json`. Nie ponowiono zapisu.
Pełny zestaw czterech przypadków, mieszana historia w ordinary runtime,
konkurencja, ACK-loss/restart i nowy wspólny recovery pozostają otwarte.

## Pomiar kosztu guardów — READ ONLY, 17.10.2026

Osobna sesja właściciela wykonała18 odczytów sześciu guardów w transakcji
READ ONLY, z limitem instrukcji8s i maksymalnie trzema próbkami na funkcję.
Wszystkie18 zwróciły true. Mediany: guard2071152,93ms, guard188543,79ms,
header20561,08ms, structure18813,01ms, stock-return6,13ms,
return-destination9,08ms. To pomiary pojedynczych funkcji, bez p95 i bez
ponowienia nieudanego POST preview.

Statystyki tej samej transakcji pokazują koszt zagnieżdżonych kontroli204,
162 i160. Zagnieżdżone `total_time` nakładają się i nie wolno ich sumować.
Sam stos timeoutu wskazujący205 nie dowodzi dominującego kosztu205.
Zachowano dokładne definicje i statyczny przegląd35 wywoływanych funkcji;
nie zmieniano globalnej konfiguracji, nie resetowano statystyk i nie wykonywano
DDL/DML. Transakcję wycofano, a sesje zamknięto.

Dowód: `return-credit207-guard-microbench07-1792260802779/evidence-index.private.json`,
SHA256 `d4e52512153b46a037c15df1352d9434bf2170ed43cf6f099d826a2a8e123419`.
Możliwa optymalizacja wymaga osobnego, sprawdzonego następcy migracji:
SQL188/207, istniejący manifest i wystawiony dokument pozostają niezmienione.
Pomiar nie zamyka timeoutu, wydajności procesu ani pełnego odbioru207.

## Trwały zapis błędu i jawna kontynuacja — kod runnera

Runner zapisuje teraz dokładne dozwolone biznesowe body przed wysłaniem
operacji. Nieoczekiwany status HTTP zachowuje bounded zredagowany DTO,
status, hash/rozmiar oryginalnego body i klucz operacji; zapis dowodu jest
oczekiwany przed zgłoszeniem odmowy. Nie zapisuje cookies ani danych logowania.

Opcjonalna jawna kontynuacja wymaga oryginalnych body/kluczy oraz zachowanego
503 z potwierdzonym `failed_before_write` dla tego aktora, firmy i komendy.
Sprawdza bieżące uprawnienia, serię, wersje, historię oraz oryginalny GET404;
nie tworzy zastępczej serii ani nowego klucza preview. Po rozliczeniu preview
wykonuje także wcześniejszy wymagany test odmowy nowego zapisu188.
Kolejna niepewność zatrzymuje przebieg bez automatycznego ponowienia.

Próba07 nie zachowała pierwotnego DTO503, więc nie spełnia wejścia resume:
sam późniejszy GET404 nie zastępuje tego dowodu. Nowy kod nie nadaje jej odbioru.
Koordynator sprawdził razem runner i trzy rodzaje fixture: **41/41 PASS,
zero pominięć**, wyłącznie kontrolowane transporty/DTO; bez rzeczywistego
wykonania kontynuacji, SQL lub wystawienia kolejnego dokumentu.
