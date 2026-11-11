# Split210 — koszt powtarzanej walidacji, 2026-10-18

Status: **przegląd źródeł i istniejących danych diagnostycznych; bez zmian kodu i bez akceptacji wydajnościowej**. Source30 i jego artefakty pozostają zamrożone. Analizę przygotowano przed zakończeniem C32, bez zakładania jego wyniku. Późniejszy wynik opisano osobno poniżej.

## Późniejszy wynik C32

Oryginalny Root57874 zakończył się EXIT1 po109,406s: `ordinary187_valid` przekroczył8s, `57014` po8006,45625ms. Cztery wcześniejsze kontrole210/209/buyer/return-credit byłyTRUE; potwierdzono pełny493/22 inverse,84 pełne artefakty28 tabel certyfikatów, zgodność18 ról oraz ROLLBACK/DROP przy0 klientach/zamknięcia. COMMIT, Native i post-QA nie zostały osiągnięte. [Końcowy przegląd Root](../../../../local-builds/full-base-preview-20261017/order-split210-sealed-compiler32-source30-prepared-20261018-01/root-terminal-review.private.json),2863B, SHA `9caf2fe65dc49bdcc1fea21dce7495295bc51f6f6e0cfc3dbd43bf05cd4abf28`.

Warunek rozpoczęcia przeglądu architektury został więc spełniony. Nie powtarzamy niezmienionej próby, nie podnosimy limitu i nie traktujemy optymalizacji pojedynczego zapytania jako naprawy całego187. Poniższa reprezentacja pozostaje propozycją wymagającą osobnego dowodu; ten dokument nie oznacza jej wdrożenia.

## Konkretny mnożnik kosztu

W [metadata-fresh-map.mjs](../../tools/parity/order-split210-metadata-fresh-map.mjs), linie 54–56, dwuargumentowy `order_merge_delivery209_predecessor_metadata` najpierw wykonuje `order_split210_require()`, a następnie wywołuje `order_merge_delivery209_validation_snapshot()`. Snapshot generowany przez [layer.mjs](../../tools/parity/order-split210-layer.mjs), linia 159, zaczyna się kolejnym `order_split210_require()`. Z kolei [closure.mjs](../../tools/parity/order-split210-closure.mjs), linia 184, wiąże każdy require z pełnym `order_split210_valid()`.

To dwa pełne sprawdzenia w jednym pełnym przejściu tej ścieżki metadata2. Nie należy po prostu usuwać pierwszego: niezależnie uwierzytelnia ono kod funkcji snapshot przed dispatch; sprawdzenie znajdujące się dopiero wewnątrz potencjalnie zmienionej funkcji nie zastępuje tego zaufania. Osobne projekcje dopasowanych funkcji i rekordów też wymagają pełnego require — `closure.mjs`, linie 190, 200 i 209. Tanie odrzucenie niedopasowanych nazw występuje przed guardem, więc liczba wszystkich wywołań projektora nie jest liczbą pełnych walidacji.

Przy pełnych przejściach 29 wywołań metadata2 wymagałoby 29 kontroli w wywołującym i 29 wewnątrz snapshotu. Te 29 snapshotów mieściłoby się w ogólnej liczbie 65 snapshotów, nie byłoby dodatkowymi 29. Oznacza to strukturalny przykład 65 + 29 = 94 kontroli w tych dwóch punktach. Jest to opis grafu wywołań pod warunkiem dojścia do odpowiednich instrukcji, nie odtworzenie dokładnej liczby wywołań badanego zapytania ani delta ze statystyk.

## Co rzeczywiście pokazuje D32

Podstawa: [Root D32 — profil funkcji](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/order-split210-source29-runtime-profile32-prepared-20261018-01/root-function-profile.private.json>) — 53569 B, SHA-256 `dcc5939ba9ff9405551676f789084c73b952b2e295edd85b391635f039a4b46d`; oraz [Root — przegląd terminalny D32](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/order-split210-source29-runtime-profile32-prepared-20261018-01/root-terminal-review.private.json>).

| Funkcja | Raportowane wywołania AFTER | Raportowany SELF AFTER, ms |
| --- | ---: | ---: |
| `order_split210_valid()` | 275 | 4557,977538 |
| `order_merge_delivery209_validation_snapshot()` | 65 | 1383,689950 |
| `order_merge_delivery209_predecessor_metadata(value, entries)` | 29 | 1036,760715 |

Wszystkie 92 obserwowane OID mają nieobecną obserwację BEFORE: **0 porównywalnych OID, 92 nieznane delty**. Są to skumulowane wartości zgłoszone w AFTER; brak rekordu BEFORE nie oznacza zera. Nie wolno przedstawiać ich jako przyrostów wyłącznie badanego wywołania. Anulowane lub nadal aktywne ramki mogą nie zostać zgłoszone, część funkcji może być inlinowana lub nieśledzona, a samo śledzenie ma narzut.

Zapytanie diagnostyczne D32 zakończyło się `57014` po 8005,834542 ms. To czas do anulowania, nie czas ukończenia ordinary187. Czasów inclusive nie sumujemy, SELF też nie stanowi kompletnego rozliczenia czasu całego zapytania. Dane nie określają p95, przepustowości ani osiągnięcia limitu 8 s. Po pobraniu profilu dalszy postcheck PIM także przekroczył limit; D32 pozostało częściową diagnostyką, bez akceptacji kompilatora źródeł, Native lub pełnego Goal.

## Twarda granica DATA: 4 MiB

`closure.mjs`, linie 103 i 144, włącza wszystkie 22 zmiany do DATA, wraz z pełnymi raw BEFORE/AFTER oraz reprezentacjami kontrolnymi. Linia 151 wymusza limit **4194304 B**. Obecne DATA ma **4192445 B**, czyli tylko **1859 B** zapasu.

Bezpośrednie wklejenie 15–21 KiB zapytania snapshotu do metadata2 AFTER nie mieści się w obecnej reprezentacji: powiększa co najmniej `source` i `definition`, dodatkowo kodowane w JSON. Samo wyemitowanie `CREATE FUNCTION` poza payload nie rozwiązuje problemu, ponieważ `layer.changes` wraca do `data.changes`. **Zwykły inline composite w obecnym formacie odrzucamy.** Nie proponujemy podniesienia limitu ani usunięcia pól lub kontroli.

## Warunkowa alternatywa architektoniczna

Jeżeli pełne C32 ponownie przekroczy 8 s, następny krok powinien zacząć się od tego przeglądu architektury i rzeczywistych wyników C32, a nie od kolejnej nieuzasadnionej mikrooptymalizacji.

Kierunek do zbadania: zamknięte, źródłowo generowane wykonanie metadata2 z jednym świeżym pełnym guardem 515 rekordów i literalnie wbudowanym oryginalnym zapytaniem snapshotu, pełnym rosterem 17 oraz dotychczasowymi kontrolami DATA. Bez dispatch do nowej zaufanej funkcji pomocniczej, przekazywanego trusted-frame API, observed expectations lub cache między wywołaniami. Samodzielny publiczny snapshot zachowałby własne pełne sprawdzenia. Zmiana granic odczytu wymaga dowodu zachowania świeżości, nie tylko identycznego wyniku na spokojnej bazie.

Aby taki kompozyt zmieścić, potrzebna byłaby **osobna, bezstratna reprezentacja źródłowych tekstów AFTER**: małe zamknięte referencje w DATA, pełne literały emitowane poza DATA w istniejącym kodzie own210 oraz rekonstrukcja kompletnych 24 pól przed oryginalnymi porównaniami. H, source-vector i fixed-seal nadal zawierałyby całe raw deskryptory pochodzące ze źródeł. Obserwowany `pg_proc` nie może dostarczać oczekiwań. Istnieje wzorzec compact refs → pełny kształt PIM w [metadata-shapes.mjs](../../tools/parity/order-split210-metadata-shapes.mjs), linie 34–38 i 50–66, ale nie dowodzi on automatycznie poprawności proponowanej reprezentacji pełnych AFTER.

To **opcja do osobnego dowodu, nie gotowy patch ani gwarancja 8 s**. Przed implementacją lub promocją wymagane są:

- pełny spis wszystkich konsumentów `entries.changes`, raw `after.source`/`after.definition`, tagged checks, snapshot map i projekcji; żadna ścieżka nie może otrzymać nieodtworzonej referencji zamiast dotychczasowego deskryptora;
- bajtowy roundtrip pełnych tekstów i wszystkich 24 pól, zachowanie właściciela, ACL, nagłówka, pełnego rosteru, kolejności i niezależnej autoryzacji źródeł; oczekiwania nadal muszą powstawać z autorskich źródeł;
- rzeczywisty pomiar wynikowego DATA **≤ 4194304 B**, rozmiarów kodu i zasobów; żadnego zakładania oszczędności ani zmiany limitu;
- kontrole jednoczesnego zatrucia kodu snapshotu, metadata2, guardów, nagłówków/ACL, manifestów i DATA oraz przypadków brakujących, nadmiarowych i przeciążonych obiektów;
- osobny dowód MVCC/świeżości, zachowania odmów i granic dispatch, w tym współbieżnych zmian DDL; następnie pełny kontrolowany przebieg z niezmienionym limitem 8 s, rollbackiem i cleanupem.

W ramach tego przeglądu wykonano wyłącznie odczyt źródeł oraz istniejących plików diagnostycznych i zapis niniejszego dokumentu. Nie zmieniano kodu, testów, operatorów ani trzech głównych dokumentów statusu; nie wykonano SQL ani testów.


## Następny dowód: tylko AFTER.definition, bez externalizacji źródeł

Późniejszy kandydat wybiera prostszy format: pełne BEFORE i AFTER.source
pozostają w DATA. Tylko22 AFTER.definition zastępuje ścisły wersjonowany znacznik;
pełna definicja wraca z autorskiego nagłówka BEFORE, surowego AFTER.source
i stałego sufiksu. Nowy physical schema odróżnia reprezentację od logicznych
pełnych24 pól. Nie trzeba przenosić ciała AFTER poza DATA ani tworzyć zaufanego
runtime callee. Świeży pełny guard nadal musi uwierzytelnić fizyczne DATA i kod.

Rzeczywisty osobny TEMP SQL probe na PostgreSQL18.4 odtworzył całe logiczne
DATA i wszystkie22 pełne deskryptory;36 odmów dało55000. Fizyczny kandydat
z dokładnym composite ma3590688B i603616B zapasu do4MiB. Dekodowanie tylko
wybranego rekordu w sześciu punktach dwóch funkcji ogranicza niepotrzebne
odtwarzanie dużych definicji, lecz jego wydajność nie została odebrana.
Helpery pozostają poza generatorem i pakietem; wynik C32 nadalFAILED.
Pełne źródła, dekompresja, SQL, namespace cleanup i otwarte warunki opisuje
[osobny raport kandydata](SPLIT210-COMPOSITE-CODEC-CANDIDATE-20261018.md).
