# Następny konektor: rodzina Mirakl Seller API

Stan rozpoznania: **17.10.2026**. Status: **kontrakt następnego zadania, bez implementacji i bez odbioru dostawcy**. Zakres niniejszej zmiany: wyłącznie ten dokument. Nie dodano adaptera, registry, migracji, kont, sekretów ani wywołań biznesowych.

## Wybór i jego granice

Rekomenduję jeden rzeczywisty adapter **Mirakl Marketplace Seller API**, konfigurowany osobno dla instancji operatora i sklepu sprzedawcy. W uchwyconym katalogu Base dokładny token `mirakl` w `catalog_cards[].attributes['data-tags']`, po podziale białymi znakami i zamianie na małe litery, występuje na **182 kartach / 182 różnych ID**. To największa rozpoznana nazwana rodzina technologiczna w tym snapshotcie: analogiczne etykiety `conectala` mają 69 kart, `omnik` 49. Ogólne kategorie hurtowni i kurierów nie dowodzą wspólnego API. **182 to liczba obserwowanych etykiet, nie liczba wdrożeń, obsługiwanych kont ani odebranych integracji.** Nie dowiedziono globalnej przewagi nad każdą możliwą rodziną.

Przykłady etykiet: Empik (`empik`), Castorama PL (`castoramapl`), Media Expert (`tergpl`), Modivo (`modivo`), Douglas (`douglas`), home&you (`homeandyoupl`), Black Red White (`blackredwhitepl`), Big Bang (`bigbangmarketplace`). Lista docelowa jest odtwarzalna z [rosteru](base-provider-roster.json); nie przeglądano 2000 stron szczegółowych. Base samo opisuje wspólną rodzinę i oddzielne integracje rynków Mirakl. To potwierdza kierunek implementacji, bez potwierdzania dostępności dowolnego konta. [Źródło Base](https://base.com/pl-PL/integracje/mirakl/).

Nie należy tworzyć 182 pozornych adapterów. Jeden adapter techniczny plus jawna konfiguracja instancji/rynku; każda pozycja rosteru zachowuje osobny status i dowód konta, wariantu oraz operacji. Etykieta Base nie wystarcza do automatycznego zgadywania hosta API, waluty, uprawnień, wymagań produktów lub sposobu realizacji.

## Dowód z bieżącego repo

Sprawdzono `local-app/server` i `development/full-base/server` oraz frontend drzewa rozwojowego: brak odwołań `Mirakl|mirakl`. Istniejący `server/integrations.ts` ma 14 pozycji oraz factory `connector()` bez przypadku Mirakl. Nowy adapter ma rozszerzyć te mechanizmy:

| Obecny element | Znaczenie dla implementacji |
|---|---|
| `server/integrations.ts`: registry, `connector()`, `ApiClient`, `validateRemoteUrl()` | Rejestr i konstrukcja klienta istnieją. Ogólny klient GET ponawia maksymalnie trzy razy i skraca oczekiwanie do 5 s; nie nadaje się bez zmian do respektowania długiego `Retry-After` Mirakl. |
| `server/schema.sql`: `channels`, `jobs`, `integration_runs`, `orders`, `listings` | Jest izolacja kanału i firmy; nie potrzeba osobnej bazy ani nowego ogólnego systemu kolejek. |
| `server/002_imports.sql`: `inbound_orders` | Zachować staging, source hash, powiązanie SKU i unikalność `(tenant_id,channel_id,external_id)`. Ten sam identyfikator zamówienia z dwóch instancji nie jest duplikatem między kanałami. |
| `server/003_sync.sql`, `server/sync.ts` | Harmonogram, cursor i lease istnieją; allowlist importu nie zawiera Mirakl. Wymagana własna logika okna aktualizacji, nie skopiowany cursor Allegro. |
| `server/offer-sync-policy.ts` | Wzorzec blokady wersji, roli i konfiguracji; dla Mirakl identity musi obejmować także instancję, sklep i generację poświadczeń. |
| `server/ordinary-connector-jobs.ts` | Istniejący ręczny tryb ma zamknięte rodzaje i dostawców Allegro/InPost/DPD. Nie udawać obsługi Mirakl przez dopisanie samej nazwy do tej listy. |
| `web/integration-catalog.tsx`, `web/integration-workspace.tsx`, `web/sync.tsx`, `web/offer-sync.tsx` | Rozszerzyć obecny interfejs konfiguracji, importu, harmonogramów, podglądu i uzgadniania. |

To rozpoznanie kodu, nie potwierdzenie przebiegu w działającym Main. Implementować w izolowanym `development/full-base`, po integracji aktualnego wydania koordynatora.

## Oficjalny kontrakt wejściowy

Wybrany produkt to **MMP REST Seller APIs**. Publiczne general notes opisują HTTPS, nagłówek `Authorization: <API_KEY>` oraz `shop_id` wybierający sklep. Klucz szyfrować istniejącym mechanizmem; nigdy w URL, logu lub podglądzie. Offset pagination ma `max` do 100 i `offset`; seek pagination ma `limit`, `page_token`, `next_page_token`. Konkretny endpoint decyduje, który wariant obowiązuje. `429` wymaga respektowania `Retry-After` w sekundach. [General notes](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3).

**Nie pomylić z Mirakl Connect Channel Platform.** Ten odrębny produkt używa OAuth2 client credentials provisionowanych przez partner team i przepływów eventowych. Nie jest zamiennikiem uprawnień do konta sprzedawcy w instancji MMP. Jeśli operator wymaga innego auth, ten wariant pozostaje osobnym wymaganiem do udokumentowania; nie przyjmować automatycznie ważności API key wszędzie. [Connect authorization](https://developer.mirakl.com/content/product/connect-channel-platform/developer-guide/authorization).

Instancja i shop muszą pochodzić z konta/operatora. Nie istnieje w tym rozpoznaniu potwierdzony ogólnodostępny anonimowy sandbox Mirakl. Lokalna fixture działa wyłącznie lokalnie; prawdziwy sandbox lub konto wymagają otrzymanych danych dostępowych, a ich brak pozostaje otwarty.

## Następny kompletny przekrój UI → API → worker → readback

Zadanie wdrożeniowe obejmuje połączenie, import zamówień, odczyt ofert oraz kontrolowaną synchronizację stanów i cen istniejących ofert. Rezultatem ma być działający proces operatora na jednej jawnej konfiguracji instancji i sklepu, z odrębnymi dowodami kontraktu lokalnego i konta dostawcy.

| Operacja | Publiczny endpoint / kontrakt | Odbiór skutku i ograniczenie |
|---|---|---|
| Tożsamość sklepu A01 | `GET /api/account?shop_id=…`; scopes `ROLE_SHOP_ADMIN` / `ROLE_PARTNER_SHOP_READ` | Zapisać shop ID, walutę i stan; nie wykonywać automatycznie przy każdym ekranie. Dokument wskazuje maksymalnie raz dziennie: cache i jawna informacja o dacie. [A01](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/stores). |
| Zamówienia OR11 | `GET /api/orders`, offset, zamknięte okno `start_update_date`/`end_update_date`, jawne `shop_id`, `order_ids` do readback | Odczyt → staging → mapowanie → lokalny import. Domyślny async zalecany co 5 min, maksimum raz na minutę; **External Partner ma co 15 min**. W profilu nieznanego typu startować z 15 min. Dla wielkich zakresów przewidzieć OR13/14/15 jako osobne rozszerzenie, nie obchodzić limitów. [OR11](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/orders/or11). |
| Lista ofert OF21 | `GET /api/offers?shop_id=…`, offset; filtr SKU | Powiązać `offer_id` i `shop_sku` z lokalnym produktem; uwzględnić pricing channel. Dokument opisuje wywołanie przy widoku ofert, nie stanowi zgody na dowolny ciągły polling. Włączyć cykliczne odczyty dopiero z potwierdzoną polityką instancji. [OF21](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/offers/of21). |
| Stany STO01 | `POST /api/offers/stock/imports?shop_id=…`, multipart CSV | Globalnie lub per `warehouse-code`, pełna jawna lista SKU i quantities. `201/import_id` oznacza przyjęty import; maksimum raz na minutę. [STO01](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/offers/sto01). |
| Status stanów STO02 | `GET /api/offers/stock/imports/{import_id}/status?shop_id=…` | Po STO01: `WAITING/RUNNING/COMPLETE/FAILED`, liczby sukcesów i błędów, `has_error_report`; zalecane 5 min, maksimum raz na 15 s. `COMPLETE` z błędnymi wierszami nie jest pełnym sukcesem. [STO02](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/offers/sto02). |
| Ceny PRI01 | `POST /api/offers/pricing/imports?shop_id=…`, multipart CSV | Semantyka **delete and replace wszystkich obowiązujących cen oferty**; nieuwzględniona cena jest usuwana. Price Approval może zmienić wyłącznie ceny oczekujące. Następny przekrój dopuszcza tylko zwykły pojedynczy cennik bez Advanced Pricing, po odczycie i potwierdzeniu pełnego zestawu; inne warianty jawnie otwarte. Maksimum raz na minutę. [PRI01](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/offers/pri01). |
| Status cen PRI02 | `GET /api/offers/pricing/imports?import_id=…&shop_id=…` | To lista z **seek pagination**, nie `/pricing/imports/{id}/status`. Zachować filtr/identyfikator i binding tokena do firmy/kanału. Zalecane co 5 min, maksimum raz na minutę. [PRI02](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/offers/pri02). |

Po statusie importu pobrać odpowiedni raport błędów (STO03/PRI03, według publicznego indeksu ofert) i odczytać ofertę przez OF22 albo OF21 dla dokładnego SKU. Odbiór musi porównać docelowy stan/cenę i zachowane pozostałe wymiary. Raport importu bez zgodności końcowej zostawia `reconcile_required`. Dokładne pełne pola odpowiedzi OF22 i raportów należy zamrozić ze schematu lub oficjalnego przykładu **przed implementacją parserów**; nazwy endpointów nie są wystarczającą specyfikacją. [Indeks operacji ofert](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/offers).

Publikacja całej oferty OF24 jest osobnym kolejnym zadaniem. Dokument wymaga przesłania wszystkich pól; pominięte wracają do wartości domyślnych. Operacja zwraca import ID i może wykrywać duplikaty, ale nie opisuje uniwersalnego client idempotency key. Nie wykorzystywać jej jako prostego PATCH ceny lub stanu ani jako dowodu bezpiecznego replay po timeout. [OF24](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/offers/of24).

## Worker, limity i niepewne odpowiedzi

To projekt implementacji, nie dodatkowe twierdzenia o gwarancjach Mirakl:

- Odczyty zamówień: utrwalić granice okna, page offset, ostatni zakończony watermark i dedup po kanale. Watermark przesuwać dopiero po zapisaniu całego okna. Powtórzone wiersze/strony po restarcie nie tworzą kolejnego zamówienia, rezerwacji ani ruchu magazynowego. Nowe/nieznane statusy mają trafić do diagnostyki, nie wymuszać wysyłki.
- Rate limiter współdzielony między UI i workerami oraz wszystkimi kanałami korzystającymi z tego samego konta API. Klucz budżetu nie może zależeć wyłącznie od sekretu: rotacja lub drugi API key tego samego konta nie tworzy nowej kwoty. Związać instancję, potwierdzoną tożsamość konta/sklepu, operację i profil uprawnień. Gdy rzeczywisty zakres kwoty jest niepotwierdzony, konserwatywnie agregować po instancji i operacji; konfiguracja poświadczeń ma osobną generację, bez jawnych sekretów. `Retry-After: 120` nie może być skrócony do 5 s. Utrwalić `not_before`; scheduler oddaje lease zamiast spać w transakcji.
- Przed zapisem: trwały plan z hash payloadu, rolą, wersją konfiguracji, instancją, shop ID i generacją poświadczeń. Claim oraz trwały zapis intencji przed wywołaniem dostawcy; recheck binding/pauzy/roli bezpośrednio przed wysłaniem.
- Po otrzymaniu import ID najpierw utrwalić receipt; kolejne cykle wykonują wyłącznie status/readback, nie ponownie POST. Stan `accepted` jest odrębny od `completed`.
- Timeout po wysłaniu albo utrata ACK zapisu receipt: `unknown/reconcile_required`, bez automatycznego POST po wygaśnięciu lease. Najpierw readback konkretnych SKU i parametrów. Sama zgodność wartości nie dowodzi, który import ją spowodował; to osobny wynik uzgodnienia, z widoczną granicą dowodu. Dla niewystarczającego readback wymagany operator.
- Pauza zatrzymuje nowe mutacje, lecz pozwala kontrolowanemu odczytowi uzgodnić już wysłany import. Restart i drugi worker nie przejmują niepewnej mutacji jako świeżego zadania.
- Nie włączać globalnego ticka dla wszystkich konektorów. Dodać wyraźny zakres nowego handlera do rzeczywistego workera; wykorzystać istniejące lease/intencje/uwierzytelnianie, zamiast nowego równoległego silnika dowodowego.

**Webhooki:** dokument produktu MMP wyraźnie ogranicza HTTP Webhooks i Cloud Events do użytkowników Operator, nie Seller. Pierwsza implementacja sprzedawcy używa trwałego pollingu, bez pozornego endpointu webhook. Osobny dostęp Operator może otworzyć odrębne wymaganie; lokalny-only scope nie uzasadnia provisioningu kolejek chmurowych. [Oficjalna dostępność webhooks](https://developer.mirakl.com/content/product/mmp).

## Zmiany do wykonania w aplikacji

1. **Registry i transport:** nowy `mirakl` dopiero z działającym klientem i handlerami. Ustawienia: jawny HTTPS origin instancji, `shop_id`, alias rynku, profil roli API, locale, tax mode, potwierdzone capabilities i osobne włączenie zapisów. Sekret `api_key` w istniejącym szyfrowanym `channels.credentials`. Ścisłe origin/path/method, brak przekierowania z Authorization, prywatne IP/DNS/SSRF odrzucane; fixture loopback wyłącznie przez istniejącą oddzielną lokalną capability. Nazwa rynku nie tworzy automatycznie hosta.
2. **Dane:** wykorzystać `channels`, `inbound_orders`, `jobs`, `integration_runs` i istniejący ledger planów. Dodać tylko brakujące typowane rekordy: identity/capabilities, trwałe okna importu i receipts mutacji z pełnym bindingiem, import ID, licznikami wierszy oraz redagowanymi diagnostykami. Tenant RLS, FK kanału, unikalna intencja i lease. Numery schematu ustalać po integracji bieżących prac. Nie zmieniać historycznych migracji.
3. **Normalizacja zamówień:** oddzielić source state/payment workflow/tax mode od statusu lokalnego; kwoty zapisywać w najmniejszych jednostkach, bez floatów. Zachować source snapshot/hash i osobne external line ID. Testować kilka linii tego samego SKU; nie gubić ich przez aktualną unikalność pozycji produktowej. Suma linii, koszt wysyłki i podatki muszą uzgodnić się ze źródłem. Brak mapowania SKU blokuje import, bez zgadywania produktu.
4. **UI:** konfiguracja konkretnej instancji/sklepu → test i data tożsamości → preview/staging → poprawa mapowania → import → harmonogram/pauza. Dla ofert preview dokładnej listy SKU, ilości, pełnego zestawu cen i ryzyka replace; jawne zatwierdzenie, postęp asynchroniczny, raport błędów i przycisk readback. Widoczne: symulacja lokalna / konto / sandbox / niezweryfikowane. Brak toastu sukcesu po samym 201.
5. **Worker:** handler importu OR11 oraz sekwencje STO01→STO02→readback i PRI01→PRI02→readback; oddzielne durable zadania dla statusów/raportów. Własne per-operation throttling i connection hash. Korzystać z istniejącego panelu kolejki i kontroli ról.
6. **Matryca:** nowe wiersze operacji ze źródłem i oddzielnymi poziomami code/local/UI/sandbox/account. Nie przyznawać odbioru wszystkim 182katalogowym etykietom po teście jednej fixture albo jednego sklepu.

## Odbiór, który zmienia stan produktu

| Próba | Wymagany wynik |
|---|---|
| Dwie lokalne instancje i dwa sklepy z tym samym external order ID | Osobne importy; brak przecieku kluczy, cursorów, kwot i historii między kanałami/firmami. Zmiana origin/shop/sekretu unieważnia stary plan przed zapisem. |
| OR11: ponad100 zamówień, powtórzona strona, overlap okna, zmiana statusu, restart w połowie | Wszystkie strony bez utraty; każdy order/import/rezerwacja tylko raz; pełne źródłowe wartości i poprawny watermark dopiero na końcu. |
| Brak SKU, kilka linii tego samego SKU, obca waluta, TAX_INCLUDED/TAX_EXCLUDED | Jasny staging i blokada niezgodności; kontrolowane sumy i line identity; zero cichego nadpisania. |
| Dwa aktywne workery, pause/role revoke i restart po claim | Jedna dopuszczona mutacja; niepewny efekt nie trafia ponownie do pending. |
| STO01/PRI01: accepted → running → complete oraz complete z błędnym wierszem | UI rozróżnia przyjęcie, częściowy wynik i zgodny readback; poprawne liczniki; żadnego „sukcesu wszystkiego” z samego HTTP 201. |
| ACK-loss po efekcie i timeout po wysłaniu | Ponowne wejście/readback/restart nie wysyła kolejnego POST. Operator widzi granicę rozpoznania importu i wynik porównania. |
| 429 z Retry-After 120, odczyt UI równolegle z workerem | Jeden współdzielony cooldown nie krótszy niż 120 s; brak obejścia limitem drugiego kanału tej samej tożsamości. |
| PRI01 przy dodatkowych cenach/rabatach/approval | Pierwszy wariant odmawia przed POST; nie usuwa nieobjętych cen. Kolejne rozszerzenie musi jawnie obsłużyć cały zestaw. |
| Złośliwe Location/Link, redirect, prywatny DNS, obcy page token, błędny raport | Brak wyjścia poza dozwoloną instancję/capability i brak ujawnienia sekretu; bounded parser/rozmiary. |
| Chrome na wspólnym lokalnym wydaniu | Operator wykonuje cały import i uzgodnienie stanów/cen w zwykłym UI; oddzielny odbiór API, aktywnego workera oraz recovery niepustej kolejki. |

Lokalne fixtures muszą realizować rzeczywisty kontrakt odpowiedzi i efektów z odrębnym ledgerem dostawcy, a nie odpowiadać zawsze 200. Minimum dwa różne lokalne originy plus pięć firm w docelowym teście skali. Sukces lokalny dowodzi kontraktu fixture; oficjalny sandbox/konto pozostaje osobnym otwartym testem. Nie uruchamiać obciążenia 100k na rzeczywistym dostawcy ani na obecnym Main.

## Dalsze wymagania rodziny pozostają otwarte

Akceptacja/refusal linii OR21 (`PUT /api/orders/{id}/accept`, tylko właściwy stan, pełne decyzje linii), tracking OR23 (`PUT /api/orders/{id}/tracking`) i shipment OR24 (`PUT /api/orders/{id}/ship`, wymagane `Content-Length: 0`) są publicznie opisane i nadają się na następny przekrój po importach/stanach/cenach. Każdy wymaga durable intent i OR11 readback. [OR21](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/orders/or21), [OR23](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/orders/or23), [OR24](https://developer.mirakl.com/content/product/mmp/rest/seller/openapi3/orders/or24).

Refundacje, anulowania, partial/multiple shipments, nowe produkty i ich taxonomy/attributes, publikacja OF24, Advanced/Channel/Customer Pricing, dokumenty, wiadomości i rozliczenia pozostają w pełnym Goal. Ten przekrój nie zamyka rodziny ani żadnego z tych wymagań. Każda instancja operatora wymaga potwierdzenia właściwych scopes, funkcji, auth i konta.

## Źródła i powtarzalność

Punktem odniesienia nazw jest `base-provider-roster.json` SHA256 `b4c1ea152a16bdd2186c56d46d706299ad77ac3007798487b66fa16177e3915a`, 3 672 322 B. Parser katalogu i snapshot źródłowy pozostają w dokumentacji rosteru; liczba 182 wynika z dokładnego tokenu `mirakl`, nie z wyszukiwania samego słowa w całym JSON. Wszystkie powyższe źródła dokumentacji są pierwotne i odczytane publicznie 17.10.2026. Nie odczytywano kont ani endpointów biznesowych.

Narzędzie web nie umiało odczytać części odpowiedzi `text/markdown`; oficjalne OF02 odczytano zwykłym publicznym GET z Accept text/markdown (2110 B, SHA256 `545b2cab49b2d4b2e7cfb866538fe427d075b9b7b2195183d452686649ee8556`). OF22 odczytane jako HTML przez GET nie zostało tu uznane za zweryfikowany pełny schemat pól; dlatego zamrożenie parsera jest jawnym zadaniem implementacji. Nie skopiowano pełnych stron dokumentacji ani nie tworzono nowych dużych artefaktów.
