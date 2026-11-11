# Odczyty Woo: N14 — diagnostyka i pierwszy naturalny odczyt zamówień B

**Zwykły start N14, diagnostyka starego UNKNOWN i jeden naturalny odczyt zamówień B PASS w opisanym zakresie. Biznesowe i natywne DTO pięciu sklepów zachowane; stare wykonanie A nadal nierozstrzygnięte.**

N13 zakończył dwa naturalne odczyty katalogu, lecz odczyt zamówień pozostał
running bez potwierdzonego zakończenia. Zachowana stara próba nie zawiera
przyczyny; nie przypisujemy jej wyjątku ani rollbacku procesora.
[Wynik częściowy N13](LOCAL-WOO-READ-RECOVERY13-20261019.md) pozostaje bez zmian.

## Zakres zmiany

- Core zachowuje ograniczoną diagnostykę przyszłego błędu: fazę, czas, kategorię,
  kod PostgreSQL lub HTTP oraz odcisk błędu. Brak surowej treści błędu i sekretów.
- Osobny świeży odczyt sprawdza własną firmę, administratora, kanał i powiązanie
  wykonania z zadaniem oraz dispatch. Diagnostyka pochodzi z pamięci lub audytu;
  brak zachowanej przyczyny jest osobnym jawnym wynikiem, bez zgadywania.
- Szczegóły w zwykłym UI pokazują fazę, bezpieczny opis, kod i czas. `57014`
  oznacza przerwane zapytanie, bez przypisywania niepotwierdzonej przyczyny.
  Surowe błędy, odciski i identyfikatory techniczne nie są wyświetlane.
- Diagnostyka nie ponawia, nie przejmuje i nie resetuje zadania. Nie potwierdza
  nieznanego wyniku. Zmiana firmy lub szczegółów usuwa stary widok; spóźniona
  odpowiedź nie przenosi danych do nowego kontekstu.

Bieżące trzy źródła: core `e0a2bf59…`, trasy `66127f2f…`, UI `f6d4b90a…`.
Końcowy commit: `4bc27f073e2ba6134defc64c035097a819998166`.
Root potwierdził78 testów TS i29 React PASS oraz typecheck EXIT0 — oryginalne
terminale60235,74118 i43622; bez zachowanych osobnych plików wyników. Obejmują
zachowane błędy PG/HTTP, brak przyczyny, nullable powiązania, obce lub rozszerzone
DTO oraz spóźnione odpowiedzi. Nie jest to rzeczywisty odbiór awarii dostawcy.

Rzeczywisty PostgreSQL przeanalizował40 literalnych zapytań core przez PREPARE,
bez EXECUTE i zapisów biznesowych; ROLLBACK i zamknięcie potwierdzone.
`parser.result.private.json`,13163B:
`406c74751921c2f3bce176dcbd292dfc3f283087e449d59c7991816887b1ac67`.
Wynik wiąże dokładne źródło core34096B:
`e0a2bf59e3d7378dee653e7780a73937e1e526f0834e0eec86ed1dde3f00b772`.
PREPARE nie wykonuje tych ścieżek ani nie dowodzi ich skutków biznesowych.

## Przygotowanie wydania i otwarte granice

Minimalny caller plikowy korzysta z1292 źródeł N13, podmienia dokładnie trzy
zatwierdzone pliki i zachowuje1289 pozostałych, bez kopiowania dist lub zależności.
Kontrakt77/41/30 ma zachować74 pozostałe pliki, cały inwentarz i Native. Pełny
inverse manifestu, aktualne Git blobs oraz bookendy są wymagane. Stare bramki
Native dotyczą niezmienionego SQL; nie deklarujemy ponownego odbioru runtime.
Root wykonał świeży Vite, check i emit: wszystkie trzy fazy EXIT0
(oryginalny terminal50091). Pełny pakiet386 plików/100368775B mieści się
w niezmienionych limitach16/96MiB; wszystkie bajty, hashe i dokładny roster
sprawdzono również niezależnie na plikach. Native contract pozostał identyczny.
Wydanie: `f11d25a3bc93afcace30927b5dce7b810564ae0d937037aba42914677023a4ce`.
Kontrakt źródeł: `51a203b44921dca628d866a278fc500ba4dae6f2df26a272b4e5ae6f1ad14199`.
`build.root-result.private.json`,825B:
`e9efe1876090fbc52db1ea03ad304e964f09a30e75c631827a45d5732642d223`.

Przypięte wejście Roota: `final-sources.private.json`,838B,
`fb30eb73173e63e2996b5c3a9a8608f32611c0138c9e55bc0e7d0793da9d5436`.
Caller13366B: `840c9cdd5b66e4c30846bb56988f84cc0b32092ae9441cecc2f496bf736e119a`.
Prywatne dowody znajdują się w `local-woo-read212-diagnostics-n14-root-20261019-01`.

## Zwykły start i dotychczasowy stan

Root uruchomił N14 zwykłą drogą na tej samej bazie i konfiguracji; proces62392
osiągnął READY, aplikacja43197. Końcowy odczyt631 tabel potwierdza630 pełnych
hashy identycznych. Zmienił się wyłącznie zatwierdzony release SHA w jednym
wierszu; cały pozostały stempel, w tym generacja1769, bez zmian. ROLLBACK/end
odczytu potwierdzone. Pełne porównanie zweryfikowano także niezależnie na plikach.
`after-normal-start.private.json`,93723B:
`eac9dae8b472f031f5a3c5a6fb448646a7a43a2f798c8bc1d506c71345dfb002`.

Chrome A pokazuje uczciwy brak zachowanej przyczyny starego wykonania
(NO_RETAINED_CAUSE), bez przypisania błędu lub odzyskiwania zadania.
Root obejrzał `ui-old-unknown-diagnostic.root.png`; SHA256
`328f8507743536a6a777b412e904c798ac1adce0bd35dcb32b22d3dfca612a8d`.

Osobne5 GET200/0 POST przed próbą B potwierdza pustą konfigurację i historię B
oraz zachowanie starego wykonania A: job nadal running, diagnostyka nadal bez
zachowanej przyczyny. `B-before-api.private.json`,15932B:
`65e2bd521fd204082dc71e32c8132944d6792362f681098dab726eb7d0072c08`.
To stan początkowy; oczekiwanie na przyszły termin nie jest odbiorem cyklu.

## Pierwszy naturalny odczyt zamówień B

Przechwycony przyszły termin konfiguracji v1 odpowiada dokładnie scheduled_for
nowego wykonania B. Wykonanie i job zakończyły się DONE, attempts0, bez aktywnej
dzierżawy; jeden potwierdzony dispatch ma after_hash zgodny z checkpointem
wykonania. Widok inbound zawiera14 istniejących, ponownie odczytanych zamówień
natywnych B. To odczyt do kolejki, nie14 nowych importów biznesowych;
wcześniej zaimportowane własne zamówienie pozostało zachowane. Po osobnej pauzie
UI końcowy GET pokazuje wyłączone zamówienia v2 z next_at=NULL i jedno DONE.
Nie użyto ręcznego run, resetu ani ponowienia procesora.

Oryginalny obserwator zakończył się EXIT1 po18 zapisanych GET ACK: błędnie
porównał inboundy do tablicy referencji dowodów `native_orders_after_ACKs`,
zamiast natywnych DTO `stock.after.orders`. Nie jest to błąd produktu ani dowód
niepowodzenia cyklu. Próba pozostała niezmieniona:
`B-natural-observation.private.json`,67689B,
`fdb73294173ea2093bb4f0ddf73cecc61096fd8092d3e6ecd439b262e3c6fdd7`.

Root uzgodnił zapisane surowe ACK z poprawnym wcześniejszym wynikiem stocku
`2750ca30…`, dodając tylko jeden GET po pauzie;0 POST/SQL i bez replay procesora.
Sprawdzono niezależnie na plikach hashe odpowiedzi, przyszły termin, powiązania
DONE/checkpoint/job i końcową konfigurację.
`B-natural-reconciliation.private.json`,7577B:
`fb29683c2bd3de3cad0b7c5d77d7d470dde8b9503ea075b5e66f7ce72e26da57`.

Root obejrzał zwykły Chrome B: wstrzymane ustawienia, wykonanie zakończone
oraz potwierdzone zakończenie etapu. Zrzut `ui-B-natural-done-paused.root.png`,
SHA256 `5b4e98c831bdecee6c2d26e361470250f2f898ded94d3a4c676066aee043bb74`.

## Końcowe porównanie pięciu sklepów

Osobny końcowy odczyt32 GET200/0 POST/0 SQL zakończył się EXIT0. Wszystkie pięć
pełnych DTO inventory, własnego zamówienia, płatności i natywnych orders oraz
products zgodne z wynikiem stocku `2750ca30…`; jedyną projekcją produktów jest
wcześniej zweryfikowane, ograniczone related_ids. Historia i job starego A w
całości identyczne z B-before. Wszystkie32 surowe ACK/hashe odpowiedzi i pełne
porównania zweryfikowano niezależnie na plikach.
`five-store-closing-business.private.json`,401055B:
`4c6b54e40a60d5677f672bc3fa1dd766bc61667942e1e09f4e4b14367feef5dc`.

Nie wykonano pełnego uzgodnienia631 tabel po cyklu B — wynik jawnie zachowuje
whole_database_preservation_after_B=false. Pełne porównanie bazy opisane wyżej
dotyczy aktualizacji przed tą próbą. Odbiór B obejmuje jedno naturalne pobranie
i osobną pauzę, bez dowodu wznowienia, restartu lub trwałej pracy pięciu firm.

Nowa diagnostyka rzeczywistego błędu pozostaje nieodebrana. Stare wykonanie A
nadal nierozstrzygnięte; sukces B nie wyjaśnia jego przyczyny ani nie potwierdza
naprawy. Brak odbioru zewnętrznego konta dostawcy, pełnej automatyki, skali lub
całego Goala.
