# Sterownik obciążenia a profil — zgodność (29.10.2026)

Bieg `full-20261029-05` (`LOAD-TEST-FULL-20261029-C.md`) zaliczył wszystko, co sterownik wtedy mierzył. Do pełnego
odbioru warunku 10 (`FULL-BASE-GOAL.md` §10, `docs/parity/acceptance-profile.v1.json`) brakowało sześciu rzeczy z
§4.3 tamtego dokumentu. Ten dokument mówi, gdzie każde wymaganie profilu jest teraz w sterowniku
(`tools/scale/load/`, opis w `README.md` tamże, sekcja „Profile compliance”), czym jest sprawdzane i co zostaje otwarte.

Bieg próbny sterownika: §7. Pełnego profilu (75 min) ten dokument nie obejmuje.

## 1. Mapa wymagań

| # | Wymaganie profilu | Gdzie w sterowniku | Zapis w raporcie | Test | Stan |
|---|---|---|---|---|---|
| 1 | `timing.warmup_seconds` 600, fazy `steady12:12:1800`, `steady24:24:1800` | `run.mjs`: domyślne wartości = profil; `lib.mjs` `planCompliance` odmawia startu przy innym planie bez `--dry-run`, przed jakimkolwiek efektem | `run.json` `profile_compliance` (`deviations`, `acceptance_run`), nagłówek `SUMMARY.md` | `tests/scale-load-profile.test.mjs` „timing…”, „run.mjs refuses…” | zrobione |
| 2 | `timing.cold`: 3 kolejne próby, świeży proces, start → uwierzytelniony odczyt + gotowość workera ≤ 180 s | `run.mjs` `--cold-attempts` (domyślnie 3): każdy CLI wydania startuje 3 razy w nowym kontenerze; `probe.mjs` po `ORDINARY_LOCAL_APP_LISTENING`: `/api/health` z `scoped_automation_enabled`, `GET /api/orders?limit=1` sesją właściciela każdej z 5 firm; `lib.mjs` `coldStartSummary`, `businessReady` | `run.json` `cold_start.processes.<proces>`: próby, mediana, max, `all_within` | „cold start…” | zrobione |
| 3 | `background.lanes`: `order_import` 6/min, `stock_sync` 12/min na firmę, lokalny Woo | `run.mjs --woo` + `woo.mjs`, `woo-lanes.mjs`, `setup.mjs --woo-products`; sklepy `tools/local/official-woo` | `run.json` `background.lanes.*` per firma i faza (≥ stawka w każdej pełnej minucie, ukończenie w każdym oknie 60 s); `run.json` `woo` (sklepy, kanały, produkty, zdrowie torów, licznik producenta, wiersze per kanał, odczyt stanów Woo vs DYNAMINDS) | `tests/scale-load-woo.test.mjs`, „background…” | **sterownik zrobiony, tory mierzone; profil niespełniony** przez dwa zachowania produktu (§3.3); automatyzacje zrobione |
| 4 | `stock_operation` dla wszystkich firm, w tym B i D | wiązania `scripts/full-base-scale-http-ports.mjs` wariant `manual_off`; `prepare.mjs` `manualOffCommand` (B/D) | operacja w `run.json` `result.phases.*.operations.stock_operation` (już bez `not_bindable`) | `tests/full-base-scale-http-ports.test.mjs` „stock_operation manual OFF…”, „preparer B/D…” | zrobione (§2) |
| 5 | połowa `stock_operation` na gorących SKU; wyścig o skończony stan na firmę i fazę z zamrożonym oczekiwaniem | `setup.mjs` zamraża przed wysłaniem żądań: 4 gorące SKU na firmę i jeden SKU wyścigu na fazę i firmę; `prepare.mjs` co drugi `stock_operation` na gorących SKU, `contentionCommand`; `lib.mjs` `contentionRace`, `hotReport` | `run.json` `hot_skus`, `contention_plan`; per faza `hot` (udział, wynik) i `hot.contention.tenants.<firma>.as_expected` | „contention…”, „report: hot share…”, „preparer A/C/E…”, „preparer: the first order_create…” | zrobione (§4) |
| 6 | `correctness.reconciliation` po biegu, PASS/FAIL | `reconcile.mjs`, uruchamiany automatycznie przez `run.mjs` po zatrzymaniu wszystkich procesów wydania; werdykt `lib.mjs` `reconciliationVerdict` | `raw/reconciliation.json` (wszystkie liczby, czasy zapytań), `run.json` `reconciliation`, nagłówek `SUMMARY.md`; FAIL = kod wyjścia 1 | „reconciliation…” | zrobione (§5) |

Wcześniejsze zachowanie zostaje za flagami tam, gdzie profil na to pozwala: `--dry-run` (krótsza rozgrzewka i fazy,
mniej prób zimnego startu), `--cold-attempts 1`, `--hot-skus 0` (bez gorących SKU; wyścig o skończony stan i tak
działa). Uzgodnienia po biegu nie da się wyłączyć: profil go wymaga.

## 2. `stock_operation` B i D

Przyczyna `not_bindable`: profil każe B i D działać bez partii WMS (`dataset.per_tenant[].wms_lots: false`), a plan
zbioru to odwzorowuje (B/D: `wms_policies.enabled` = 0, A/C/E = 1, sprawdzone na kopii `_41`). Wiązania znały tylko
protokoły WMS (`wms_adjustment090`, `wms_transfer`), więc dla B/D nie było wariantu.

Produkt ma natywną ścieżkę dla firm bez partii: korekta ręczna OFF PW/RW (migracja 169, `server/manual-inventory-off.ts`,
trasy `/api/inventory/manual-corrections/…`). Sterownik używa jej bez zmiany produktu i bez zmiany zbioru:

- przygotowanie (niemierzone): `GET …/source?product_id&warehouse_id` (rewizja ramki), `POST …/previews`
  `{client_key, revision, product_id, warehouse_id, location: default_location, delta: ±1, note}`;
- pomiar: `POST …/previews/:id/apply` `{client_key (inny niż podglądu), scope_hash, confirmed: true}` → 201;
- wiązanie sprawdza świeży paragon tego podglądu: protokół `manual_off_pw_rw_v1`, żądanie, dokument PW/RW z jednym
  wierszem, oba identyfikatory dzienników; przypięte źródła `server/manual-inventory-off.ts`,
  `server/manual-inventory-off-routes.ts`, `server/169_manual_inventory_off.sql`;
- tylko produkty `simple` z domyślnym miejscem (warunek natywnej ramki);
- wyścig: zmiana ramki (stan, miejsca, aktywne rezerwacje) między podglądem a wykonaniem daje SQLSTATE 40001, a usługa
  zamienia go na 409 `Manual OFF native source or authority refused`. To nowy oznaczony wyścig `manual_off_source`.
  Ten sam tekst ma też odmowa 23514 (np. zmiana zgody), dlatego klient po odmowie czyta podgląd: `receipt_id = null`
  potwierdza brak skutku.

Skrót planu `ca7c640f…` się nie zmienia: zbiór i plan nie są ruszane. Sonda na kopii `_41` przed biegiem próbnym: B
źródło 200, podgląd 201, wykonanie 201 (RW-M/2026/000001, stan 19 → 18); A ta sama trasa 409 (firma z partiami
musi używać korekty WMS).

## 3. Tło: import zamówień i synchronizacja stanów (30.10.2026)

Profil wymaga oficjalnego lokalnego WooCommerce (`background.dependencies.official_local_woo_required_for_import_and_sync`,
`local_official_woo_instances_min: 2`). Atrapa serwera Woo nie daje odbioru, więc tor działa na pięciu prawdziwych sklepach.

### 3.1 Sklepy

`tools/local/official-woo` (README tamże), root `local-builds/official-woo-scale-20261030-01`, projekt `dyna-woo-39d98c319221`:

- obrazy pobrane 30.10 i przypięte digestami `linux/arm64` z oficjalnych indeksów (`images.lock.json`, indeksy w
  `manifests/`); plugin WooCommerce 11.2.1: 18 060 641 B, sha256 `5317434c…a8586`, zgodny;
- pięć sklepów a–e (WordPress 7.1.3, Woo 11.2.1, PHP 8.3, MariaDB 11.4.13), instalacja przez WP-CLI w kontenerach,
  bootstrap `complete` w każdym; brzeg TLS z własnym CA tylko na `127.0.0.1:18443–18447`;
- sprawdzone: przypięte CA 200 na każdym porcie, bez CA błąd TLS, obcy `Host` 444, nasłuch tylko 127.0.0.1;
  klucz importera i producenta 200 na własnym sklepie, klucz sąsiedniego sklepu 401;
- dwa klucze REST na sklep (`importer` dla wydania, `producer` dla sterownika), utworzone przez `WC_Auth::create_keys`
  przez WP-CLI, tylko w plikach 0600 roota;
- dostęp z przestrzeni sieciowej `dyna-scale-full-pg18`: forwarder TCP (`operator.mjs forward`), TLS end-to-end;
  sprawdzone z kontenera Node w tej przestrzeni: 200 z weryfikacją CA na pięciu portach.

Produkt: obsługa do pięciu sklepów i originów 18443–18447 jest od `9224af7`; ta praca produktu nie zmienia
(`server/`, `shared/` bez zmian, więc bez przepinania plików z `SOURCE_ROSTER`).

### 3.2 Sterownik

`run.mjs --woo <woo-store-bindings.private.json>` (opis: `tools/scale/load/README.md`, „Background lanes”):

- sklep a–e obsługuje firmę A–E (≥ 2); bieg, po którym sklep przekroczyłby 1000 − 50 zamówień, odmawia przed skutkiem;
- `setup.mjs --woo-products 80` zamraża per firma 80 produktów simple (≥ 30 dostępnych na MAIN, poza gorącymi SKU
  i wyścigiem); sterownik tworzy je w sklepie z tym samym SKU i stanem i mapuje (`POST /api/integrations/:id/mappings`);
- tylko `dyna-load-app` dostaje `--local-woo-stores` (kopie CA i klucza importera w `--out/private`), `--local-woo-reads`,
  `--local-woo-stock` i startuje po procesach workerów; root sklepów jest zasłonięty (tmpfs) w każdym kontenerze;
- `woo-lanes.mjs` zwykłą sesją właściciela: kanał, mapowania, synchronizacja stanów (30 s), odczyt `orders.sync` (60 s),
  zgoda importu po pierwszym odczycie; po fazach: import i odczyt off, stan off, gdy kanał jest spokojny;
- producent (host, klucz producenta): zamówienie `processing` co 7,5 s na sklep (8/min, powyżej 6, bo import przychodzi
  paczką raz na odczyt ~61 s), 3 różne zmapowane linie;
- pomiar z bazy co 10 s: `order_import` = paragony importu `done`, `stock_sync` = plany ofert `external_api_verified`
  z `desired_applied`; w raporcie też liczniki per kanał i odczyt stanów Woo vs DYNAMINDS po biegu.

### 3.3 Wynik i blokada (produkt)

Biegi próbne §8. Tory działają (setki prawdziwych importów i zweryfikowanych zapisów stanów do Woo), ale produkt
zatrzymuje kanał na stałe po pierwszym błędzie (`automatic_retry: false`, kanał wraca dopiero po restarcie procesu),
a przy tym obciążeniu błąd przychodzi po kilku minutach:

1. **Odczyt zamówień:** `server/local-woo-orders-read.ts:21` (oraz `:31`, `:32`) odmawia 409, gdy liczba stron lub
   zamówień zmieni się między stronami. Sklep ma kilka stron (50 na stronę), a nowe zamówienie przychodzi co 7,5 s, więc
   zamówienie w trakcie odczytu daje 409 (`local_woo.read.failure`, faza `provider_read`, HTTP 409), zadanie
   `orders.sync` zostaje `running`, kanał nie jest już czytany (`server/local-woo-read-lane.ts:321`, `stopped.add`).
2. **Zapis stanów:** `offer.write` (jedna próba) kończy się „Cena lub stan zmieniły się przed wykonaniem. Przygotuj nowy
   plan”, gdy stan DYNAMINDS zmieni się między planem `offer.sync` a zapisem. Import rezerwuje towar właśnie na tych
   produktach, więc konflikt przychodzi w rozgrzewce. Nieudane zadanie zatrzymuje kanał
   (`server/local-woo-stock-lane.ts:103`, `:193`): `local_woo_stock_blocked_channels` 5 przed końcem biegu `-66`.

Profil (`background.method` 5) każe w takim przypadku zachować stan niespełniony i zrobić warunek produktu przed
obciążeniem. Możliwe kierunki (decyzja właściciela, zmiana zreviewowanego kodu):

- odczyt z ustalonym górnym ograniczeniem (np. `before`/górne `id` z chwili startu odczytu), żeby nowe zamówienia nie
  zmieniały paginacji; wymaga dopuszczenia tego parametru w `local-woo-http-transport.ts`;
- konflikt planu (`conflict`, bez zapisu u dostawcy) jako zakończenie bez skutku, po którym następny `offer.sync`
  planuje od nowa, zamiast zatrzymania kanału.

Sterownik zapisuje oba tory jako zmierzone i `not_met` (nigdy `false`); `all_ok` tła jest `false`.

### 3.4 Poprawka produktu (`8f548bd`, `bcee492`, 30.10.2026)

Decyzja koordynatora (odwracalna): oba kierunki z §3.3, z zachowaniem zakazu ślepego ponawiania niepewnych zapisów.

**Odczyt.** `readLocalWooOrders` ustala na starcie odczytu górną granicę `before=<sekunda GMT startu − 5 s>` z
`dates_are_gmt=true` i wysyła ją na każdej stronie. To parametry oficjalnego wc/v3 (`WC_REST_CRUD_Controller`,
`date_query` po `post_date_gmt`, w HPOS `date_created_gmt`; sprawdzone w pluginie 11.2.1 i na sklepie a: 200, odczyt
5 stron = 233 zamówienia = `x-wp-total` bez granicy, granica w roku 2000 daje 0). Zamówienia z czasu odczytu bierze
następny odczyt (każdy odczyt jest pełny do swojej granicy). Margines 5 s pokrywa zamówienie, którego COMMIT jest
późniejszy niż czas utworzenia, i drobną różnicę zegarów hosta i kontenerów. Kontrole 409 (zmiana liczby stron lub
zamówień w obrębie granicy) zostają. Transport dopuszcza `before` i `dates_are_gmt` tylko w GET
`/wp-json/wc/v3/orders`, tylko razem, `before` tylko jako dokładne `YYYY-MM-DD HH:MM:SS` z poprawnym kalendarzem,
`dates_are_gmt` tylko `true`.

**Granica bez skutku — odczyt.** Błąd w fazie `credentials` albo `provider_read` zdarza się, zanim procesor otworzy
transakcję stagingu: `localWooReadLaneBeforeStage` przestawia fazę na `stage` jako pierwszy krok tej transakcji
(`server/sync.ts`). Wtedy tor zamyka dokładnie trzymaną próbę w jednej transakcji: zadanie `failed` (CAS na tej samej
dzierżawie, `attempts=1`), dyspozycja `acknowledged`, wystąpienie `aborted`, audyt `local_woo.read.no_effect`.
Przyczyna zostaje w diagnostyce (`GET …/read-lanes/occurrences/:id`, faza i status HTTP). Kanał nie jest zatrzymany,
następny odczyt idzie według harmonogramu. Gdy cokolwiek z tej próby się zmieniło (dzierżawa, dyspozycja,
wystąpienie, właściciel), zamknięcie odmawia i zostaje dotychczasowe zatrzymanie. Faza `processor`, `stage`,
`completion`, `claim` i `catalog.fetch` też zostają bez zmian.

**Granica bez skutku — zapis stanu.** `offer.write` kończy się jako „bez skutku, do ponownego planu”, gdy
jednocześnie:
- błąd to `Problem` 409 z procesora (konflikt planu), a nie odmowa samego toru: jego płotu (zgoda, wersja, źródło,
  dzierżawa), jego transportu ani wywołania dostawcy za nim;
- to wykonanie nie wysłało do Woo żadnego żądania zapisu (innego niż GET). Licznik stoi na granicy sieci, za
  wszystkimi kontrolami toru, a transport toru dopuszcza tylko GET i zaplanowany PUT;
- plan jest nadal `queued` w fazie `ready`, czyli nigdy nie wszedł w `write_started`, które poprzedza każdy PUT;
- zadanie nadal jest `running` na dzierżawie toru.

Wtedy zadanie przechodzi w `done`, plan w `conflict` z przyczyną, a dyspozycja dostaje ACK z
`outcome: NO_EFFECT_REPLAN`, `provider_requests` (liczba GET) i `provider_writes: 0`. Następny `offer.sync` planuje
od nowa.

W granicy są oba konflikty widziane pod obciążeniem:
- „Cena lub stan zmieniły się przed wykonaniem” (`server/offers.ts`, przed pierwszym żądaniem);
- „Oferta zewnętrzna zmieniła się od podglądu” (po GET stanu oferty, w fazie `ready`). Zamówienia producenta
  obniżają stan w Woo, więc ten konflikt przychodzi w każdym biegu.

Pierwsza wersja (`8f548bd`) liczyła także GET i w biegu `-67` zatrzymała tym drugim konfliktem 5/5 kanałów (§8).

Każdy inny błąd zostaje jak dotąd: `failOffer`, dyspozycja bez ACK i trwałe zatrzymanie kanału. Dotyczy to też:
- błędu po wysłaniu PUT,
- odmowy płotu toru,
- konfliktu przy płocie PUT w fazie `write_started`.

**Widoczność i powrót bez restartu.**
- Odczyt: zatrzymany kanał widać w `GET …/read-lanes` (historia, `reconciliation_required`) i w diagnostyce
  wystąpienia.
- Odczyt, powrót: istniejąca akcja operatora (pauza, `abort-preview`, `abort`) kończy próbę i zdejmuje zatrzymanie.
  Bez interfejsu w `web/`, tylko trasy sesji.
- Odczyt, zatrzymanie bez trzymanej próby (błąd `eligibility` albo `claim` bez potwierdzonego claimu): tej akcji nie
  ma, kanał wraca dopiero po restarcie.
- Stan: tor pokazuje tylko liczbę (`local_woo_stock_blocked_channels` w `/api/health`), bez przyczyny i bez akcji
  operatora. Niepotwierdzona dyspozycja blokuje kanał także po restarcie. To zostaje otwarte; nowego UI tu nie dodano.
  W `-69` dokładnie ten przypadek zatrzymał kanał B (niepewny zapis po `write_started`). Uzgodnić go można dziś tylko
  ręcznie w bazie. Przyczyna błędu nie jest nigdzie zapisana: `failOffer` zapisuje „Błąd zapisu oferty”, a tor
  niczego nie loguje. (Zamknięte w §3.5.)

Wynik pod obciążeniem: §8 (`-67`…`-69`).

### 3.5 Uzgodnienie operatora i przepustowość toru stanów (`7ede43f`, `f0db048`, 30.10.2026)

**Uzgodnienie niepewnego zapisu.** Ta sama ścieżka co w odczycie: zwykła sesja właściciela wybranego sklepu
(bez klucza API i nagłówka `Authorization`), ponowne sprawdzenie roli administratora w bazie, podgląd i dopiero
potem jawna akcja. Trasy (`server/local-woo-stock-lane-routes.ts`), baza
`/api/local-fixtures/woocommerce/channels/:channelId/stock-lane`:
- `GET` — stan: niepotwierdzona dyspozycja (zadanie, plan, faza), oczyszczona przyczyna;
- `GET /reconciliation-preview` — jeden GET oferty u dostawcy przez transport toru (dokładna ścieżka, tylko GET).
  Zwraca plan i obserwację, dozwolone wyniki oraz skróty migawki i obserwacji;
- `POST /reconcile` z polami `client_key`, `dispatch_id`, `expected_snapshot_sha256`, `observation_sha256`,
  `outcome` i `confirmed: true`. Wynik `outcome` to jedno z trzech:
  - `EFFECT_CONFIRMED` — obserwacja = plan;
  - `SUPERSEDED` — obserwacja ≠ plan;
  - `FAILED` — bez twierdzenia o skutku.

Przy `POST /reconcile` świeży odczyt Woo musi dać tę samą obserwację co podgląd, inaczej 409 (wyścig nieaktualnej
obserwacji). Migawka bazy jest sprawdzana ponownie w kolejności blokad claim. Zadanie i plan zostają zamknięte:
- plan `done`/`conflict`/`failed`, `scope: operator_reconciled`, faza `reconciled`. Taki plan nie liczy się jako
  zweryfikowany zapis dostawcy;
- audyt `local_woo.stock.reconcile` i ACK `OPERATOR_RECONCILED` zdejmują blokadę, także po restarcie;
- PUT nie jest wysyłany ponownie. Następny `offer.sync` planuje od nowa ze świeżym odczytem;
- `client_key` jest idempotentny, `POST /reconcile/observe` odczytuje zapisany wynik;
- odmowa, gdy ta instancja właśnie wykonuje tę dyspozycję;
- niepotwierdzony `offer.sync` (np. utracony COMMIT dyspozycji) można tylko zakończyć (`FAILED`).

**Przyczyna i log.** Każdy błąd wykonania zapisuje `local_woo.stock.failure`: kategorię, klasę, sqlstate, status
HTTP i status dostawcy, fazę toru (`provider_write`, `after_write`, …), fazę planu, liczbę żądań i zapisów do Woo
oraz skrót komunikatu. Bez treści komunikatu, odpowiedzi, URL i kluczy. Do tego jedna linia JSON `local_woo.stock.failure`.
Zatrzymanie na claim też daje linię (`local_woo.stock.stopped`). Panel: `web/local-woo-stock-reconcile.tsx` w widoku
integracji Woo (stan, przyczyna, „Odczytaj stan w WooCommerce”, potwierdzenie, jeden przycisk na dozwolony wynik,
zachowany znacznik przy niepewnym wyniku POST i „Odczytaj wynik uzgodnienia” bez ponawiania).

**Przepustowość.** Wybrane sklepy działają współbieżnie (każdy ściśle po kolei), a jeden cykl wykonuje do 25
należnych zadań sklepu zamiast jednego na takt workera. Każdy claim powtarza pełne kontrole zgody, źródła i
dyspozycji. Każdy zapis nadal czyta Woo tuż przed PUT. Kadencja `offer.sync` zostaje (minimum 30 s to `CHECK` w
`017_offer_sync.sql`). `products/batch` (Woo 11.2.1: `POST /wc/v3/products/batch` i `…/variations/batch`, limit 100
pozycji, wynik per pozycja bez transakcji) odrzucony: jeden PUT obejmowałby wiele planów i granica niepewnego zapisu
przestałaby być dokładna.

Zostaje też: wyścig o skończony stan obejmuje tylko HTTP (§4); jeden pełny bieg na root sklepów (≈ 561 zamówień na sklep).

## 4. Gorące SKU i wyścig o skończony stan

- **Gorące SKU:** 4 na firmę, ≥ 50 dostępnych na MAIN. A/C/E: z pozycjami partii (`quantity − reserved ≥ 10`).
  B/D: `simple` z domyślnym miejscem. Wybór `md5(product_id ‖ run id)`, zapis w `run.json` `hot_skus` przed
  pierwszym żądaniem.
- **Udział:** co drugi `stock_operation` celuje w gorące SKU, czyli połowa ruchu, jak w profilu. Wyścigi wersji
  (`stock_version`, `manual_off_source`) są przez to zamierzone. Budżet: ≤ 1 % żądań fazy (bez zmian).
- **Wyścig o skończony stan** (`correctness.reconciliation` 5): na fazę i firmę jeden SKU z 2…7 dostępnymi, poniżej
  okna zamówień ≥ 8, więc nie wybierze go żadne inne polecenie.
  - Pierwszy `order_create` trzech klientów w fazie (pierwszych, których harmonogram ma zamówienie dla tej firmy,
    `contentionClients`) zamawia całą odczytaną dostępną ilość tego SKU.
  - Popyt to 3 × dostępne > dostępne. Zamrożone oczekiwanie: wysłane 3, przyjęte ≤ 1, reszta 409 dokładnie
    `Za mało towaru: <SKU>. Dostępne: n` (oznaczony wyścig tylko tego polecenia), 0 błędów.
  - Brak skutku: brak zamówienia z unikalnym e-mailem polecenia.
  - Brak sprzedaży ponad stan sprawdza uzgodnienie: `available ≥ 0`, `reserved` = aktywne rezerwacje.
  - Zakres: tylko ścieżka HTTP. Profil mówi o „HTTP/import/worker”; import działa (§3), ale nie jest jeszcze stronami
    wyścigu.

## 5. Uzgodnienie po biegu (`reconcile.mjs`)

Jedna transakcja `REPEATABLE READ READ ONLY` na pięć firm biegu, po zatrzymaniu procesów wydania. PASS tylko wtedy,
gdy każda liczba poniżej to 0, a każdy strażnik zwraca `true`:

| sekcja | sprawdzenie | zakres |
|---|---|---|
| `stock` | Σ `stock_movements.delta` = `on_hand`; Σ `stock_locations` = `on_hand`; Σ pozycji partii = `on_hand` (magazyny z partiami); `reserved` = Σ aktywnych rezerwacji (`quantity − consumed − released`) = Σ aktywnych `reservation_locations`; `available = on_hand − reserved`, `available ≥ 0`, `reserved ≤ on_hand` | cały stan 5 firm (96 000 wierszy) |
| `reservations` | otwarte zamówienia (new/paid/picking/packed) mają aktywne rezerwacje, zamknięte nie mają aktywnych, otwarte nie mają zużytych | cały stan |
| `orders` | jeden efekt na e-mail polecenia (`load-…`), magazyn własnej firmy, suma = Σ linii + wysyłka | od startu biegu |
| `invoices` | faktura ma własne zamówienie po wysyłce, jedna na zamówienie, brutto 230 = suma zamówienia | od startu biegu |
| `payments` | własne zamówienie, unikalny `client_key`, wpłaty − zwroty ≤ suma zamówienia | od startu biegu |
| `jobs` | 0 oczekujących, 0 w toku, 0 nieudanych | od startu biegu |
| `orphans` | dokumenty, ruchy magazynowe, paragony OFF, operacje WMS i przebiegi automatyzacji bez rekordu nadrzędnego; dokumenty magazynowe bez linii | od startu biegu |
| `guards` | 15 funkcji strażników z biegów `-02`/`-05` (`RECONCILE_GUARDS`), wszystkie `true` (warunek ≥ 12) | — |

Linia bazowa na kopii `_41` przed biegiem: PASS, 15/15 strażników, 18 s. Z oknem „od 2020” (cała historia zbioru jako
„bieg”) też PASS: 100 000 zamówień, 36 821 faktur, 92 140 płatności. Definicje nie dają więc fałszywych alarmów na
danych generatora.

Poza zakresem tego skryptu (otwarte, `correctness`): pełna księga zamiarów zapisu sterownika, powtórka kluczy
idempotencji, izolacja firm niezależnymi sesjami, porównanie skrótów przed i po.

## 6. Co zostaje otwarte dla warunku 10

1. Tło `order_import` / `stock_sync` (§3): sklepy, kanały, zgody i pomiar są gotowe; profil niespełniony, bo produkt
   zatrzymuje kanał po 409 paginacji odczytu i po konflikcie planu zapisu stanów (§3.3). Wymaga decyzji i zmiany produktu.
2. Pomiary zasobów co 1 s po stronie serwera (pętla zdarzeń serwera, pula bazy, CPU hosta): bez zmian, manifest §12
   „Otwarte” 3.
3. Wyścig o skończony stan obejmuje tylko HTTP (import nie jest stroną wyścigu).
4. Pełny bieg 75 min z tym sterownikiem: planuje koordynator.

## 7. Bieg próbny sterownika (29.10.2026)

Dowody: `data/scale/load/driver-dryrun-20261029/` w `development/full-base` (`dryrun-20261029-41`, `-42`:
`run.json`, `SUMMARY.md`, `raw/`; `dryrun-extra-41`: logi `run.mjs`, rozmiary baz `dyna-scale-pg18` przed i po).

Ustawienia obu biegów:

- wydanie `scale-release-full-20261029-05` (commit `1b1bb00`; `server/` i `shared/` bez zmian do HEAD `5126273`);
- instancja `dyna-scale-full-pg18`, kopie `CREATE DATABASE … TEMPLATE dynaminds_scale_20261029_03`
  (`_41`, `_42`; `_03`, `_q597`, `_07` nieruszane);
- `--warmup 60 --phases steady12:12:180,steady24:24:180 --workers 2 --rate-limit-per-min 3000 --dry-run`;
- zasilanie AC.

`dyna-scale-pg18` był zatrzymany w obu biegach:

- `docker stop -t 120` o 21:18:25 UTC, kod 0; start o 21:57:17 UTC;
- start czysty („shut down at 21:18:25”), `healthy`, `RestartCount 0`;
- rozmiary wszystkich baz identyczne przed i po; zmienił się tylko LSN (checkpoint zamknięcia).

| | `-41` (pierwszy) | `-42` (po poprawkach) |
|---|---|---|
| zimny start | 3 próby na proces: aplikacja 112,0 / 111,3 / 111,3 s (mediana 111,3), worker 110,6 / 110,9 / 110,3 s; `all_within` | 1 próba (`--cold-attempts 1`, czas): 115,2 / 113,0 s |
| `profile_compliance` | DEVIATES (rozgrzewka, fazy), dry run | to samo + 1 próba zimnego startu |
| RPS sukcesu steady12 / steady24 | 51,11 / 56,80 | 51,21 / 56,03 |
| błędy | 0 / 0 / 3 (`REFUSAL_HAD_EFFECT`, błąd sterownika, niżej) | **0 / 0 / 0**, 0 × 429, 0 × 5xx, 0 timeoutów |
| oczekiwane odmowy (udział) | 0,36 / 0,14 / 0,12 % | 0,39 / 0,14 / 0,19 % (budżet 1 %) |
| udział zapisów wysłanych | 40,2 / 40,3 / 40,1 % | 40,4 / 40,3 / 40,1 % (profil 40; przedtem ≈ 38,3 z B/D `not_bindable`) |
| `stock_operation` B/D | wysyłane, 0 `not_bindable` | to samo |
| gorące SKU | 50,6 / 50,0 / 50,3 % `stock_operation` | 51,6 / 50,3 / 51,0 % |
| wyścig o skończony stan | NOT AS EXPECTED: B, C, D tylko 2 z 3 poleceń; steady24 3 × fałszywe „had effect” | **as expected w A–E w każdej fazie**: 1 przyjęte, 2 odmowy z dokładnym powodem, brak skutku 30/30 |
| tło | automatyzacje `met` (≥ 119/min na firmę, najdłuższa przerwa ≤ 3,5 s); import i synchronizacja `blocked` | to samo |
| uzgodnienie | FAIL: `orders.duplicate_client_effects` 1 035, `invoices.order_not_shipped` 12 (błędy definicji, niżej) | **PASS**, 15/15 strażników, 18,9 s; 4 535 zamówień, 510 faktur, 2 219 płatności, 9 070 zadań, 0 niezgodności |
| ostrzeżenia odpowiedzi / późne hooki | 0 / 0 | 0 / 0 |
| kod wyjścia | 1 (FAIL uzgodnienia) | 0 |

Poprawione po `-41` (testy jako pierwsze, w tym samym commicie co zmiana):

1. **Klienci wyścigu.** Zadania klienta n = k·klienci + klient ustalają n mod 4, więc na firmę klient widzi tylko
   ćwiartkę cyklu. Klient 0 przy 12 klientach nigdy nie tworzy zamówienia dla B. Klienci wyścigu to teraz pierwsi trzej,
   których harmonogram ma `order_create` dla tej firmy (`lib.mjs` `contentionClients`).
2. **E-mail polecenia.** Licznik zaczynał się od nowa w każdej fazie, więc e-maile powtarzały się między fazami.
   Odczyt „brak skutku” znajdował zamówienie z poprzedniej fazy, a uzgodnienie liczyło duplikaty. E-mail zawiera teraz
   znacznik biegu i fazę.
3. **Status zamówienia faktury.** Zwrot po fakturze przenosi zamówienie do `return_received`. Uzgodnienie przyjmuje
   `shipped`, `delivered` i `return_*`.
4. **Podgląd manual OFF.** Przy zmianie ramki między odczytem źródła a podglądem przygotowanie jest powtarzane raz
   (bez pomiaru). Odmowy przygotowania steady12: 7 → 1.

Obserwacje do pełnego biegu:

- **Koszt `stock_operation` B/D (manual OFF).** p95 w steady24: B 3 430 ms, D 3 400 ms (`-42`), przy
  218–253 ms dla A/C/E. Odmowy `manual_off_source`: 12, brak skutku potwierdzony 12/12; jedna odmowa
  `stock_version` (A/C/E) bez rozstrzygnięcia odczytu (`null`, warstwa przesunęła się z innego powodu). Mieści się w progu 4 000 / 8 000 ms, ale jest blisko p95 (maks. 4 427 ms w `-41`).
  - Najczęstsze aktywne zapytanie w rozgrzewce: `SELECT manual_inventory_off_valid()`, 186 próbek
    (w `-05` ~262 ms na wywołanie).
  - `manualOffAvailable` i transakcja wołają je kilka razy na żądanie, a operacja to trzy transakcje (źródło, podgląd,
    wykonanie).
  - Odczyty p95 steady24: 159–161 ms (w `-05`: 112 ms). Ten wpływ jest **niepotwierdzony**: inne fazy, krótszy pomiar.
  - To koszt produktu, nie sterownika. Pełny bieg pokaże p95 B/D przy 24 klientach przez 30 min.
- **Udział `stock_operation` per firma.** Ten sam efekt n mod 4 co w punkcie 1: B/D dostają ~55–80 operacji na fazę,
  A/C/E ~110–135. Globalna mieszanka i udział firm są w tolerancji, a ≥ 100 próbek na firmę i operację w 1 800 s jest
  spełnione.
  - Rozkład był taki sam przed tą zmianą (`-05`: B 2 281, D 2 853 zadań).
  - Zmiana harmonogramu zerwałaby porównywalność z `-02`/`-05`; nie ruszałem go.
- **Przerwa hosta przy uzgodnieniu.** Synchroniczny `spawnSync` (18–19 s) daje `process_stall` po fazach. Żadna faza
  nie jest unieważniona.

Kopie `_41` i `_42` (po ~7 GB) zostały na `dyna-scale-full-pg18` do wglądu.

## 8. Biegi próbne z tłem Woo (30.10.2026)

Dowody: `data/scale/load/driver-dryrun-20261030/` w `development/full-base` (`dryrun-20261030-61` … `-66`: `run.json`,
`SUMMARY.md`, `raw/`, w tym `raw/woo-producer.ndjson`, `raw/woo-lanes-*.log`). Wydanie `scale-release-full-20261029-05`,
sterownik z worktree tej pracy, instancja `dyna-scale-full-pg18`, kopie `TEMPLATE dynaminds_scale_20261029_03`
(`_61` … `_66`; `-65`, `-66` z `STRATEGY FILE_COPY`), `--warmup 120 --phases steady12:12:180,steady24:24:180 --workers 2
--rate-limit-per-min 3000 --cold-attempts 1 --dry-run --woo …`, zasilanie AC. `dyna-scale-pg18` zatrzymany
`docker stop -t 120` o 01:13:55 UTC (kod 0), start 02:59:40 UTC: czysty („shut down at 01:13:55”), `healthy`,
`RestartCount 0`, rozmiary 14 baz identyczne przed i po.

| bieg | co pokazał | poprawka (testy jako pierwsze) |
|---|---|---|
| `-61` | brak produktów simple ≥ 100 dostępnych (maks. przedział 50–99) | 80 produktów ≥ 30 |
| `-62` | odczyt A–C i stan A–E zatrzymane przed konfiguracją: tory aplikacji cyklowały podczas startu `worker-2` (blokady, `lock_timeout` 8 s) | aplikacja startuje po workerach, odmowa przy `local_woo_stock_blocked_channels` > 0 |
| `-63` | import ~6/min z paczkami 4–5 w części minut; stan: 300/300 pozycji „SKU produktu zewnętrznego różni się od lokalnego powiązania”; wyłączenie stanu przy oczekującym `offer.sync` je oblało | SKU Woo = SKU DYNAMINDS; producent 8/min; wyłączenie stanu po ciszy kanału |
| `-64` | `dyna-scale-full-pg18` przekroczył limit pamięci (20 GiB, `shared_buffers` 16 GB; `OOMKilled`, checkpointer SIGKILL, odtworzenie 02:07:25–02:07:40); sterownik padł na zerwanym połączeniu monitora | monitor zapisuje błąd i łączy się ponownie; kopie `FILE_COPY` |
| `-65` | 345 zamówień źródłowych (0 błędów), 199 importów, 631 zweryfikowanych zapisów stanów; potem kanały zatrzymane (§3.3); wyłączenie czekało w nieskończoność na zatrzymanym kanale | wyłączenie po 90 s mimo braku ciszy, z zapisem |
| `-66` | przebieg do końca: 345 zamówień (0 błędów), 138 importów, 653 zweryfikowane zapisy, 19 konfliktów planu; odczyt zatrzymany na każdym kanale, stan na 5/5 przed końcem; uzgodnienie FAIL `jobs.running` (5 × `orders.sync`), `jobs.failed` (konflikty) | — (blokada produktu, §3.3) |
| `-67` | wydanie `8f548bd`: 60 odczytów `done` (do 5 stron), 0 błędów odczytu, 0 `orders.sync` `running`; import do końca na 5/5 kanałach; stan: 5/5 kanałów zatrzymanych konfliktem „Oferta zewnętrzna zmieniła się od podglądu” po GET (pierwsza granica liczyła GET); uzgodnienie FAIL `jobs.failed` | granica liczy tylko zapisy (`bcee492`, §3.4) |
| `-68` | wydanie `bcee492`: do 04:04 146 zweryfikowanych zapisów, 86 `NO_EFFECT_REPLAN`, 0 nieudanych zapisów, 33 odczyty `done`; o 04:04:14 `dyna-scale-full-pg18` przekroczył limit pamięci (checkpointer SIGKILL, odtworzenie do 04:04:25, jak `-64`), procesy wydania padły na zerwanym połączeniu → steady24 nieważny | bieg powtórzony (`-69`) |
| `-69` | wydanie `bcee492`, przebieg do końca, szczyt pamięci bazy 6 GiB: 51 odczytów `done`, 0 błędów odczytu, 0 zamknięć bez skutku potrzebnych; stan 248 zweryfikowanych zapisów + 157 `NO_EFFECT_REPLAN`; jeden kanał (B) zatrzymany o 04:20:27 przez niepewny zapis (`offer.write` w `write_started`, błąd bez `Problem`, „Błąd zapisu oferty”), czyli zgodnie z granicą; uzgodnienie FAIL `jobs.failed` (ten zapis + oczekujące zapisy B anulowane wyłączeniem toru) | §3.4 „Zostaje” |
| `-70` | wydanie `f0db048` (§3.5), krótki bieg: stan A, C, D, E ≥ 12/min w każdej pełnej minucie steady12 i steady24 (min. 16–54/min); B zatrzymany o 05:29:13 przez niepewny zapis (faza `after_write`, PUT wysłany, odczyt kontrolny pokazał inny stan: „Dostawca nie potwierdził żądanej ceny, stanu lub publikacji”), z przyczyną w audycie i logu; A, D, E zatrzymane dopiero przy wyłączaniu toru po fazach; uzgodnienie FAIL `jobs.failed` | uzgodnienie operatora dla B (§3.5); import, zob. niżej |

`-67`…`-69`: dowody w `data/scale/load/driver-dryrun-20261030/` worktree `agent-a22b08f3e583aeaea` (katalog `data/` jest
poza gitem). Kopie `dynaminds_scale_20261030_67`…`_69` (`TEMPLATE _03`, `FILE_COPY`), `--warmup 120 --phases
steady12:12:180,steady24:24:180 --workers 2 --rate-limit-per-min 3000 --cold-attempts 1 --dry-run --woo …`.
`dyna-scale-pg18` zatrzymany `docker stop -t 120` o 03:22:02 UTC (kod 0), start 04:31:47 UTC: czysty („shut down at
03:22:02”), `healthy`, `RestartCount 0`, rozmiary 15 baz identyczne przed i po. Sklep a: 370 zamówień przed `-69`, 439 po nim (odczyt 8 stron w granicy).

`-69`, per firma (import steady12 / steady24, minimum na pełną minutę; zweryfikowane zapisy stanu warmup / steady12 /
steady24):

| firma | import (≥ 6/min) | stan (≥ 12/min) |
|---|---|---|
| A | 26 (7) / 18 (5) | 39 / 59 / 17 |
| B | 24 (7) / 19 (6) | 44 / 34 / 0 (zatrzymany niepewnym zapisem) |
| C | 25 (7) / 19 (6) | 38 / 48 / 19 |
| D | 25 (8) / 19 (6) | 40 / 44 / 22 |
| E | 25 (8) / 19 (6) | 25 / 39 / 16 |

Wniosek:
- Odczyt i import już nie zatrzymują kanału. Import spełnia próg w steady12 na 5/5 i w steady24 na 4/5 (A ma minimum
  5/min). Rozgrzewka nie spełnia progu z budowy biegu: zgoda importu przychodzi dopiero po pierwszym odczycie.
- Stan nie zatrzymuje się już na konfliktach planu (157 przeplanowań bez skutku). Próg 12/min na każdą pełną minutę
  nie jest jednak spełniony. W steady12 średnio 11–20/min, ale w paczkach co ~30 s (`offer.sync`), z przerwami
  28–78 s. W steady24 przy CPU bazy ~750 % spada do ~6/min.
- To przepustowość toru (zapis po zapisie na kanał, ~40 % zapisów kończy się ponownym planem po zmianie stanu w Woo
  przez producenta), a nie zatrzymanie. Do zrobienia osobno.

`-66`, per firma (import / zweryfikowane zapisy / zgodne stany Woo z 80): A 48/152/28, B 32/124/15, C 0/129/7,
D 41/129/23, E 17/119/15. Szczyt pamięci `dyna-scale-full-pg18` w `-65`: 11,1 GiB z 20 GiB. Automatyzacje i ruch HTTP
w normie jak w `-42` (0 błędów, 0 × 5xx). Zimny start 115–116 s na proces (1 próba).

`-70` (30.10.2026, dowody w `data/scale/load/driver-dryrun-20261030/dryrun-20261030-70/` worktree
`agent-ab1f14a6d9d32a1d4`):
- wydanie `scale-release-full-20261030-woostock-01` (commit `f0db048`), kopia `dynaminds_scale_20261030_70`
  (`TEMPLATE _03`, `FILE_COPY`), `--warmup 60 --phases steady12:12:120,steady24:24:120`, reszta jak `-69`;
- `dyna-scale-full-pg18`: limit pamięci podniesiony na czas biegu do 26 GiB (`docker update --memory 26g
  --memory-swap 26g`, 05:21:10 UTC), szczyt 7,79 GiB, CPU do 807 %; po biegu przywrócony na 20 GiB (06:54:25 UTC),
  `healthy`, `RestartCount 0`;
- `dyna-scale-pg18` zatrzymany `docker stop -t 120` o 05:21:10 UTC (kod 0), start 05:55:32 UTC: czysty („shut down
  at 05:21:10”), `healthy`, `RestartCount 0`, rozmiary 15 baz identyczne przed i po;
- sklepy po biegu: 483 zamówienia (a, b), 482 (c–e), czyli +44 na sklep.

Zweryfikowane zapisy stanu na pełną minutę (wymóg ≥ 12):

| firma | warmup | steady12 | steady24 |
|---|---|---|---|
| A | 51 | 25, 40 | 18, 26 |
| B | 0 | 0, 0 | 0, 0 (zatrzymany niepewnym zapisem od 05:29:13) |
| C | 6 | 63, 54 | 16, 25 |
| D | 5 | 67, 32 | 19, 25 |
| E | 8 | 68, 39 | 26, 26 |

Wniosek:
- Przepustowość stanu na kanałach niezatrzymanych spełnia próg w obu fazach. W `-69` było to ~6/min w steady24.
  Rozgrzewka (60 s) nie spełnia progu z budowy biegu: konfiguracja stanu startuje w trakcie.
- Konflikty planu spadły do 15–26 na sklep przy 369–504 zweryfikowanych zapisach, wobec ~40 % w `-69`.
- Zatrzymanie B jest zgodne z granicą (skutek PUT niepewny). Dziś zdejmuje je §3.5 bez bazy. Na `_70` tego nie
  wykonano, bo aplikacja biegu już nie działa.
- Import w steady24 ma minimum 4/min na 5/5 (w `-69` 5–6), w steady12 A i B 4/min. Przyczyna niepotwierdzona:
  - wyrównanie paczek importu (odczyt co ~61 s) do dwóch pełnych minut fazy 120 s;
  - albo większe obciążenie od szybszego toru stanów (ta sama pula połączeń aplikacji i te same sklepy).
  Do sprawdzenia w pełnym biegu.
- HTTP: 0 błędów, 0 × 5xx we wszystkich fazach.
