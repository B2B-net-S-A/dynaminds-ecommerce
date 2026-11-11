# Następny proces do domknięcia: zwrot magazynowy → korekta → rozliczenie

**Aktualizacja 17.10.2026:** reader historii206 ma rzeczywiste3/3 PASS w
oddzielnej scratch DB; [zakres dowodu](RETURN-CREDIT206-INTEGRATION.md).
Writer jest rozwijany jako odrębny successor207 z zachowaniem literalnego188,
na gałęzi `development/returns-credit206`. Nie został jeszcze odebrany
w zwykłym runtime ani podłączony do Main/podglądu. Poniższy audyt jest
historycznym uzasadnieniem luki, nie obietnicą zmiany guardów188.

Rzeczywiste API ujawniło dodatkowo, że pełne odrzucenie destinations148
zachowuje `state=rejected`, `received_at=NULL`, `receipt_sequence=0` oraz
receipt148, a nie tworzy przyjęcia169. Nowy proces musi zachować taką
inspekcję osobno od finansowej sekwencji zaakceptowanych zwrotów. Nie wolno
tworzyć zastępczego receipt169 ani numeru korekty dla odrzuconego towaru.
Późniejsze prawdziwe przyjęcie ma nadal własną poprawną sekwencję169.
To otwarty warunek writera207, a nie zakończony odbiór finansowy.

2026-10-17. **Rekomendacja: po obecnym odbiorze runtime domknąć lokalny proces FV157 konsument PL/PLN → przyjęcie148 `destinations_v1` → korekta188 → rozliczenie i wspólny odczyt ilości/kwot.** To usuwa konkretną przerwę pomiędzy istniejącymi modułami. Samo dodanie nowych adapterów bez połączenia tych ścieżek jej nie usuwa.

## Granice i stan źródeł

Audyt wyłącznie read-only źródeł i treści testów w `/Users/arturtwardowski/DYNA Ecomerce/development/full-base`, branch `goal/full-base-20261017`, HEAD odczytany jako `17b48ad`. Poszczególne pliki przypięto poniżej, ponieważ HEAD nie opisuje całego bieżącego WIP. Indeksy: `local-app/docs/parity/domains.json` oraz `integrations.json`; brak anchora nie był uznawany za brak funkcji. Nie zmieniano Source, Main, DB ani Goala. Nie wykonywano builda, API, migracji, testów z DB ani wywołań dostawców.

**To diagnoza kodu, nie nowy odbiór runtime.** Poniżej „istnieje” oznacza zidentyfikowaną implementację/callsite i odpowiadającą treść testu, a nie deklarację ponownego uruchomienia tego testu na obecnym wydaniu.

## Potwierdzona ścieżka i zakres, którego nie trzeba pisać od początku

| Krok | Rzeczywisty kod i ścieżka | Istniejące sprawdzenia w kodzie testów |
|---|---|---|
| Zgłoszenie i przyjęcie | `server/return-routes.ts:78–100` rejestruje POST receive/refund; `server/returns.ts:350` `receiveReturn`; `return-completion.ts` koordynuje jeden zapis stanów i protokoły169/162/112/138. | `tests/returns.test.ts:130` ilości i dokładne grosze; `:169` replay przyjęcia/rozliczenia, równoległe żądania i jeden efekt. |
| Przyjęcie do sprzedaży / custody / odrzucenie | `server/return-destinations.ts:316` `receiveReturnDestinations` tworzy koordynator `protocol: destinations_v1`, kończy natywny148, potem169; fizyczne wykonanie jest przekazywane do istniejącego adaptera. | `tests/catalog-stock-control-return169.test.ts:302` przygotowuje rzeczywiste skany139, dzieli sale/custody/reject, wiąże PZ wielu magazynów i WMS oraz sprawdza czysty replay. |
| Lokalna korekta do numerowanej faktury | `server/local-consumer-credit-routes.ts` rejestruje source/preview/issue/original-command/detail; `server/local-consumer-credits.ts` porównuje snapshot i hash kalkulacji, trzyma poprzednie korekty i numerację. SQL188 waliduje całe historyczne przyjęcie. `web/returns.tsx` renderuje `LocalConsumerCreditPanel` na sprawie z FV `local_invoice`. | Lokalna ścieżka istnieje; ten audyt nie przyznaje jej świeżego odbioru na obecnym buildzie. Jej ograniczenia protokołów wskazano w luce 1. |
| Korekta Fakturowni | `server/invoices.ts:128` `previewInvoice`, `:248` używa `partialCorrectionPositions`, `:335` queue, `:555` worker z weryfikacją odczytu; `server/return-invoices.ts:5` pilnuje kolejności, kwot i oryginału. UI: `web/invoices.tsx:93,139,449`. | `tests/invoices.test.ts:670–705` dwie korekty i grosz resztowy; `:708–734` ACK-loss bez drugiego POST; `:736–796` kolejność, brak mieszania pełnych/częściowych oraz odrzucenie zmienionego readback. |
| Rozliczenie klienta | `server/returns.ts:701` `recordRefund` oblicza `min(refund_amount, balance.overpayment)`, zapisuje lokalny ledger tylko dla dodatniej wypłaty i zamyka sprawę. UI jawnie opisuje potwierdzenie operatora. | `tests/payments.test.ts:320` zero-cash COD nie tworzy pieniędzy, `:344` ogranicza zwrot do rzeczywistej wpłaty, `:372` obsługuje późne COD jako nadpłatę. To nadal lokalne deklaracje, nie wypłaty przez operatora płatności. |

Ważna korekta interpretacji matrycy: `integration.fakturownia.correction.partial` ma `registry_planned_unverified`, lecz kod i powyższe testy częściowej korekty istnieją. **Nie uznawać jej za brak implementacji.** Wymaga uzgodnienia statusu z dowodami normalnego runtime oraz odrębnego sandboxa/konta, bez automatycznego awansu do `accepted`.

## 1. Najbliższa luka implementacyjna: przyjęcie148 nie przechodzi do korekty188

**Konkretny przypadek:** konsument otrzymał FV157. Operator skanuje zwrot i przyjmuje część do sprzedaży, część do custody, resztę odrzuca przez istniejący ekran destinations148. Sprawa uzyskuje kwotę uznania i PZ/WMS, ale źródło korekty188 odrzuca jej historyczny protokół.

Dowód w źródłach:

- `server/return-destinations.ts:322–324` przekazuje `protocol: 'destinations_v1'`; `:352–354` kończy169 z `assistant_receipt_id` prawdziwej operacji148.
- `server/188_local_consumer_credit.sql:38` `local_consumer_credit_history` odczytuje sealed169, lecz `:47` dopuszcza wyłącznie `rma` i `assistant_v1`. To jawna odmowa innego protokołu, nie wniosek z wyszukiwarki.
- Ten sam walidator `:53–66` sprawdza parent139 tylko dla `assistant_v1`; nie ma odpowiedniej gałęzi pełnego historycznego148. `local_consumer_credit_source:183–188` wywołuje ten walidator dla **całej** historii otrzymanych zwrotów. Nieobsługiwany wcześniejszy zwrot może więc blokować także późniejszą korektę innej sprawy tego samego zamówienia.
- B2B nie jest gotowym obejściem: `server/b2b-credit-source.ts:100` i `server/b2b-credit-physical.ts:57` również ograniczają typowane protokoły; `:145` source jawnie odmawia partner credit bez osobnego financial validator. Nie przełączać dokumentu na inny tryb.

**Najmniejsza spójna implementacja:** addytywne, wersjonowane rozszerzenie historycznego źródła korekt konsumenckich o dokładny parent148. Zachować istniejące sealed188/169, numerację, poprzednie korekty, oryginalną kalkulację, role i custody. Zweryfikować nie tylko nazwę protokołu, ale relacje admission148 → preview → native receipt/result → admission/receipt169, właściwe tenant/order/return/actor/tx, wszystkie przyjęte i odrzucone pozycje, warehouses/arrivals, stock/bin/layer mapy i zgodność kwoty przyjęcia. **Nie wystarczy dopisać `destinations_v1` do `IN(...)`, wystawić zwykłego RMA zastępującego przyjęcie ani usunąć guardów starej migracji.**

**Odbiór tego procesu:** na jednym lokalnym wydaniu i odrębnych danych testowych wykonać przez UI/API FV157, skanowanie i split148, podgląd/issue korekty, rozliczenie oraz świeży odczyt całego grafu. Przykład oparty na istniejącym teście169: pozycja 1000 gr + dwie sztuki o łącznej wartości 3401 gr; przyjąć 1000 gr do sale, 1700 gr do custody, ostatnią sztukę odrzucić. Uznanie 2700 gr, pozostała sprzedaż 1701 gr. Zweryfikować VAT z oryginalnego dokumentu bez ponownego liczenia z bieżącego katalogu. Stock sprzedaży rośnie tylko o sale, custody zachowuje własne przeznaczenie, odrzucenie niczego nie przyjmuje. Korekta i rozliczenie nie zmieniają stock/WMS drugi raz.

W tym samym odbiorze: zmieniony parent/warehouse/kwota i obcy tenant są odrzucane; utrata odpowiedzi issue jest uzgadniana po oryginalnym kluczu bez drugiego numeru; replay receive zachowuje te same PZ i fragmenty; restart nie zmienia kwot ani ID; osobny przypadek zero-cash COD nie produkuje wpisu wypłaty. Zachować wszystkie stare pozytywne ścieżki rma/assistant_v1. To odbiera konkretną rodzinę lokalnych zwrotów, nie wszystkie odmiany B2B/dropship/parcel i nie konto dostawcy.

## 2. Luka pełnego produktu: refundacja w zwykłym procesie nie wykonuje płatności

`server/return-routes.ts:97–101` wywołuje wyłącznie `recordRefund`. `server/returns.ts:729–740` dopisuje lokalny `payment_entries` (`method='return_confirmation'`) i ustawia `refunded_at`; `:748–753` zapisuje wprost `scope='operator_confirmation_no_payment_call'`. Nie kolejkuje tutaj wywołania bramki płatności. `web/returns.tsx` pokazuje „System nie wykonał przelewu” oraz potwierdzenie „wykonane poza systemem”. To uczciwa działająca funkcja lokalnego rozliczenia, lecz nie wykonanie refundacji wymagane przez pełny zakres Goala.

Nie jest to twierdzenie o globalnym braku dowolnego SDK refund w całym repo. **Potwierdzony brak dotyczy podpięcia rzeczywistej refundacji do badanego zwykłego procesu RMA.** Matryca płatności wymaga dalszego rozpisania operacji dostawców; sama `DOM-FIN-009` odbiera tylko zero-cash.

**Następny spójny zakres po luce1:** jedna trwała komenda refund oparta na zidentyfikowanej oryginalnej transakcji i własnym RMA, z kwotą/walutą/limitem środków, stanem pending/unknown/confirmed/failed, jednym kluczem i niezmiennym readback. Wpiąć ją w istniejący model kolejki i jawne akcje UI. Nie zamykać sprawy jako wypłaconej przed potwierdzeniem dostawcy; nie ponawiać niepewnego POST po restarcie. Zachować odrębny tryb manualny i zero-cash. Lokalny serwer protokołu może sprawdzić timeout/duplikat/ACK-loss, ale rzeczywiste konto/sandbox pozostaje osobnym otwartym odbiorem. Wybór dostawcy i oficjalnego kontraktu wymaga dopięcia do matrycy; ten audyt go nie inwentaryzuje ani nie ustanawia nowego konta.

## 3. Luka obsługi wyjątków: błędnego potwierdzenia RMA nie można skorygować obecną ścieżką

Po zapisaniu `settlement`, `recordRefund` (`server/returns.ts:709–715`) zwraca poprzedni wynik tylko dla identycznego input; inna referencja/treść daje409. Jednocześnie `reversalEntry` w `server/payments.ts:456–469` jawnie odrzuca wpis z `return_id` z komunikatem „Rozliczenie sprawy zwrotowej wymaga osobnej korekty procesu”. Zarówno zwykła korekta płatności, jak i `reverseFinancialPaymentInTx` korzystają z tego samego walidatora. `registerReturnRoutes` udostępnia receive/decision/refund/document, bez korekty rozliczenia. To bezpieczna odmowa niespójnego zapisu, ale brak operacyjnego procesu naprawy pomyłki operatora w tym flow.

**Najmniejszy osobny zakres:** admin-only append-only korekta lokalnego potwierdzenia RMA, powiązana z dokładnym wpisem i powodem; koryguje ledger i wynik rozliczenia bez ponownego przyjęcia towaru lub anulowania dokumentu sprzedaży. Zachować oryginał, osobny klucz komendy, wersję sprawy i dowód readback. Zmiana samej referencji oraz odwrócenie deklaracji niewykonanego przelewu powinny mieć osobne efekty; zdalnej potwierdzonej wypłaty nie wolno „cofnąć” lokalnym reversal. Przypadek0-cash też wymaga historii zmiany mimo braku payment_entry. Ten zakres jest po luce1; nie obchodzić obecnej odmowy ręcznym UPDATE/DELETE.

## Kolejność realizacji i warunek zakończenia następnego etapu

**Najpierw luka1**, bo łączy istniejący, lokalny proces magazynowy i finansowy bez zależności od kont zewnętrznych. Gotowy etap oznacza jeden zwykły flow UI/API z niezmienną historią sale/custody/reject, numerowaną korektą i poprawnym rozliczeniem, również po ACK-loss/replay/restart. Następnie luka2 jako rzeczywista integracja refund, a luka3 jako kontrolowana obsługa pomyłek. Zakończenie tego etapu nie zamyka Goala ani pozostałych protokołów, walut, regionów i integracji.

## Piny odczytanych źródeł DEV

SHA256 i rozmiar odczytano po audycie; nie są pinami wydania ani dowodem uruchomienia testów.

| Plik w DEV | Bajty | SHA256 |
|---|---:|---|
| `server/returns.ts` | 38350 | `cce7b2cb21659c1637a44f5394f28cb74aadd9fed1a00ecabd2acad8ed42c7a0` |
| `server/return-routes.ts` | 3785 | `43c1fdfd2a3586c1fe9f08bef36ad7346c68fcc2c1d8ace4bcd09f28488cd9b0` |
| `server/return-completion.ts` | 5585 | `1fd7129ae3bd0e29e4e77690782d9f4f65c74a87e54753d45623fb4750b56231` |
| `server/return-destinations.ts` | 30222 | `c514fd6de722755258ea0de284a784bdb511415ca36b95d211f16588152ab26c` |
| `server/188_local_consumer_credit.sql` | 60866 | `cfa89fad3148555c0d91c5293d5e4727ab80d589681724196b70eb8a798cfbc6` |
| `server/local-consumer-credits.ts` | 13536 | `51da608bc97efe832162f2c9f5331d5d46e83e50b0e18e94e1d8e5e954f51d91` |
| `server/payments.ts` | 17978 | `aa14325393d62d2bc0165a12d6c2956168ec1922bb77c7b395f09b15977af79e` |
| `server/return-invoices.ts` | 5244 | `d9cbc6a49251b6fec4d375d2ea27e282871260d255e673c6c82957441f13723f` |
| `server/invoices.ts` | 27325 | `c788bfaf67e0a623e6f28557775e761bf219c05fddbd97f6a15cf42ce816c7ff` |
| `web/returns.tsx` | 47463 | `363c58264adae485df20d56d299cf55e44e4524fbea89aa647202e2dacd9e961` |
| `tests/returns.test.ts` | 22134 | `1692b6bf250bd72f8e33e26c11941d2ae9743fdd408d6bfa50151ffcddace330` |
| `tests/payments.test.ts` | 25462 | `a42672ad8242bd3c935c2829c7115e7607fbe331a84033c3c536a1666e1fac1a` |
| `tests/invoices.test.ts` | 29676 | `f9d8345f8185f395a4be056590d7343e5b93c7484997ab44a2d8cda9ad455d4d` |
| `tests/catalog-stock-control-return169.test.ts` | 28682 | `852144693544c13efb02cf4dd7cf3d3a1b8ded59f3d63c7808f83847362d9552` |
