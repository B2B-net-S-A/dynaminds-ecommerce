# Historia harmonogramów — odzyskiwanie odczytu, 18.10.2026

Pierwotny odbiór: **PASS_SYNTHETIC_COMPONENT_UI_ONLY**. Poprawka obejmuje rzeczywisty
komponent React i CSS, kontrolowane lokalne odpowiedzi GET oraz Chrome w profilu
Artur. Wtedy nie odebrano jej na wspólnym wydaniu z normalną sesją, API i workerem.
Późniejszy rzeczywisty odbiór paginacji S2 opisano w osobnej sekcji poniżej.

Po zmianie kursora historia i wyniki nie pokazują wierszy poprzedniej strony.
Błąd jest przypisany do właściwego widoku i pozwala ponowić dokładnie ten sam GET.
Spóźniona odpowiedź nie zastępuje innego harmonogramu lub wykonania. Aktualne
szczegóły wykonania zastępują również jego wcześniejszy komunikat błędu.

[Komponent](../../web/automation-schedules.tsx) i
[dedykowane testy](../../web/automation-schedules-history.test.mjs):10/10 PASS,
bez pominięć; typecheck EXIT0, niezależny przegląd bez P1/P2. Testy obejmują
opóźnienia, błędy i retry obu list, zmianę harmonogramu, zamknięcie/unmount,
ponowny wybór, role/readOnly oraz refresh i rzeczywisty callback interwału5s.

Root wykonał w Chrome zmianę strony historii, kontrolowany błąd i ponowny odczyt,
a następnie ten sam proces dla wyników zamówień. Podczas loading/error właściwa
tabela była pusta; retry historii pokazał17 października, retry wyników pokazał
ORD-1002 bez ORD-1001. Przy szerokości1280px dokument zachował1280px.
Ślad zawiera10 GET, po dwa żądania dla każdego ponawianego kursora, bez zapisów.
Root obejrzał zrzuty błędu historii i końcowego sukcesu; peer obejrzał wszystkie pięć.

Dowody w `local-builds/full-base-preview-20261017/automation-schedules-history-component-visual-20261018-01`:
`root-ui-review.private.json`, `root-final-dom.private.txt`, `source-proof.private.json`,
`calls.private.json`, `closed.private.json` i pięć przypiętych zrzutów JPG.
Komponent ma SHA256 `b762a92e7445967519d42bf709730097d4abead3b27386a76a79bb7eb0d9e353`.
Root zamknął własną kartę i serwer; EXIT0, PID19445 i listener49430 nieobecne.

Harness jawnie wstrzymuje automatyczny interwał5s dla stabilnych zrzutów.
Chrome nie potwierdza więc odświeżania według zegara, autoryzacji, bazy, workera,
dostawcy ani pełnej automatyki. Główne lokalne usługi pozostały poza tym testem.


## Późniejszy odbiór normalnej aplikacji S2

Na wydaniu `d7b99d110c89cafd9f4fb1a4c49be7c7f08b6a9abd0e93bc7edf474a6d3cc71c`
Root uruchomił zwykłą aplikację i osobny ograniczony worker na zachowanej bazie.
Odczyty przed i po starcie workera potwierdziły cały niezmieniony stempel1703,
pełne guardy209/187 TRUE przy8s oraz poprawne odpowiedzi zwykłego API.
[Raport współstartu i dowody](SCHEDULE-WORKER-COSTART-LOCAL-20261018.md)
zachowuje pierwotny315b GET500 oraz odrębny błąd serializacji TimeZone.

Rzeczywisty `read-first` wykonał8 GET i0 POST: pierwsze wykonanie zakończone,
`scanned=done=26`, bez skipped/failed. Strony wyników25+1 mają dokładnie26 ID
zamówień z pierwotnego setupu. Następne25 odrębnych POST wykonano przez API,
każdy z własnym zapisanym kluczem i ACK, po zakończeniu poprzedniego runu.
Wszystkie25 zakończyły się z zerowymi scanned/done/failed; receipt obejmuje
25 POST i85 GET. Historia zawiera dokładnie26 różnych wykonań na stronach25+1,
z pierwotnym wykonaniem jako najstarszym.

W normalnej sesji Chrome Root odczytał25 pustych runów, użył „Starsze” do
pierwotnego runu z26 skutkami, a potem „Dalsze” do ostatniego z26 wyników.
Zapisany rzeczywisty zrzut pokazuje obie drugie strony i zamówienie
`DE-20261018-93FA34B9`. To odbiór odczytu i paginacji;25 kolejnych enqueue
pochodziło z API.

Odmowy IAM sprawdzono przez normalne API:401 bez sesji,409 przy nagłówku
rzeczywiście utworzonej innej własnej firmy,404 obcej historii i404 szczegółów,
200 dla odczytu przez zaproszonego viewer oraz403 dla jego żądania run.
Dokładnie6 POST ma ACK: dwa signup, zaproszenie, odmówiony run i dwa logout.
Obie nowe sesje wylogowano i ich stare tokeny odmówiły401; sesja admina pozostała.
Historia przed i po ma te same26 ID.

Pierwszy ograniczony worker po25 pustych runach zakończył się EXIT0.
Naturalny termin oraz późniejszy łagodny restart i wznowienie odebrano w osobnych etapach opisanych poniżej.
Późniejsza pełna kontrola zamykająca zakończyła się na ordinary187:
57014 przy8s, przed odczytem danych i HTTP; ROLLBACK oraz end potwierdzono.
Osobny rzeczywisty wariant danych02 zakończył się
`DATA_PRESERVATION_ONLY_PASS_FULL187_NOT_ACCEPTED`: pełny stempel1703,
209 TRUE, wszystkie pierwotne26 skutków i całe26 wierszy historii identyczne,
652 cudze zadania z pierwotnym hashem,7 GET200, ROLLBACK i end TRUE.
187 nie wykonano ani nie odebrano. Ten etap nie zamyka pełnego odbioru runtime;
późniejsze zamknięcie własnych usług opisano poniżej. Aktualny odbiór nie rozszerza wcześniejszego testu błędu/retry
na rzeczywistą aplikację ani nie potwierdza poll5s według zegara.
Żadne z ośmiu nadrzędnych kryteriów Goala nie zostało przez ten etap zamknięte.

Dowody S2, sprawdzone bajtowo:

| Dowód | SHA256 |
| --- | --- |
| [Pierwsze26 wyników25+1](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/schedule-history-read-first01/result.private.json) | `0ec1be0f03a119b7afaefc922c8a054eb5fa43b634785b2a014eed0314bf3da4` |
| [25 pustych wykonań i historia26 ID](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/schedule-history-enqueue25empty01/result.private.json) | `03e3af7003fae3e0eb49b8a0a4e9cf467b8a797e276cb5beb8804441e136f826` |
| [Rzeczywisty IAM i wylogowania](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/permissions-negative-api-run01/result.private.json) | `bed410402baef23d78d96c13d4c6c75a4b85258eed58d2a63c37fd86bfe905d5` |
| [Drugie strony w zwykłym Chrome](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/history-and-results-second-pages-chrome.png) | `d9389ff8b5f7caecee43660a221199fea6bd5d31418c22d9a3c11fc101863291` |
| [Pierwszy worker: terminal EXIT0](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/worker-process-terminal.private.json) | `3229d94116065829f89501b0bbb0e115e3c412b8552ada5275995e1fbf305828` |
| [Pełny closing01:187 timeout, ROLLBACK/end](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/closing-preservation-prepared-agent-20261018-01/run01/closing-preservation.result.private.json) | `e7495def1d286f6575b18c867e710e90af90f4f2076ede360148579ea5ced068` |
| [Rzeczywisty odczyt danych02: PASS bez odbioru187](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/closing-preservation-data-only-prepared-agent-20261018-02/run01/data-only-preservation.result.private.json) | `d2f528bb36aeeccb164bfbe17afc9d271be5d971929fe5f1701f4fc4d6530f8c` |


## Późniejszy naturalny termin60s i pauza przez UI

Root utworzył przez UI osobny wyłączony harmonogram, przypiął jego autora,
tenant, dokładne26 ID i odrębny tag, a następnie włączył go do v2.
Rzeczywisty obserwator wykonał293 GET,0 POST i0 SQL: nie stwierdził runu
przed terminem, powiązał `scheduled_for` z wcześniej odczytanym `next_at`
i potwierdził dwa naturalne wykonania. Pierwsze przetworzyło26 zamówień,
drugie0 przy zachowanej definicji `once_per_version`. Zaobserwowano
checkpoint25; wyniki pierwszego wykonania mają strony25+1.
Ręczny endpoint run nie był używany w tym etapie.

Root zapauzował harmonogram przez zwykły UI: wersja3, definicja1,
`enabled=false`, `next_at=null`. Zapisany zrzut Chrome pokazuje dwa
wykonania26+0 oraz pauzę. Następny odczyt SQL READ ONLY potwierdził dokładne
ID obu runów i ich terminy,26 nowych receipts,26 elementów pierwszego
i0 drugiego runu. Każde z26 zamówień zachowało status `new`, otrzymało
dokładnie jeden dodatkowy tag i wersję+1 względem stanu sprzed nowego terminu.
Łącznie istnieją52 zdarzenia zmiany tagów:26 pierwotnych i26 nowych.
Zapas26/26/0 i całe pierwotne26 wierszy historii pozostały identyczne.

Odczyt końcowy potwierdził cały stempel1703,39 firm,0 opt-inów, migrację209,
ten sam hash652 cudzych zadań i brak aktywnych lub dzierżawionych zadań
nowego harmonogramu.209 zwrócił TRUE, ROLLBACK i zamknięcie klienta TRUE.
Pełnego187 nie wykonywano ani nie odebrano; wcześniejszy timeout pozostaje
zachowany. Worker tego etapu zakończył się EXIT0. Późniejszy łagodny restart
opisano poniżej; crash/MVCC i pełny Goal pozostają nieodebrane.

| Dowód naturalnego terminu | SHA256 |
| --- | --- |
| [Obserwator:293 GET,26+0,bez ręcznego run](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-time-acceptance-prepared-agent-20261018-01/observe01/result.private.json) | `7ea740322f5b57ed090d0e4c8fa005ab0c4ec9b036754ba4c53ef92b5abc3e63` |
| [Końcowy SQL danych po pauziev3](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-final-data-prepared-agent-20261018-01/run01/due-final-data.result.private.json) | `fb96398de2aa426f94930bc33906a980f1272aeb4c73c1bb24fbd4a7bd15e894` |
| [Naturalne26+0 i pauza w Chrome](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/natural-due-26-plus0-paused-chrome.png) | `e9d190deb34c5a496e6183e2f234d91c6ab8380437be047e66587715cb447473` |


## Łagodny restart, wznowienie i zamknięcie własnych usług

Root ponownie uruchomił ograniczony worker tego samego wydania przy
wyłączonym harmonogramie v3 i dwóch zakończonych runach. Po jego READY
potwierdził cały stempel1703 i health200. Obserwator rozpoczął od tego
wyłączonego stanu, a Root wznowił harmonogram przez UI do v4. Zapisano
przyszły `next_at`; trzeci run powstał naturalnie w tym terminie i zakończył
się0 skutków. Obserwator wykonał178 GET,0 POST i0 SQL. Potwierdził dokładnie
trzy runy oraz pełną równość odczytów26 zamówień, stocku i pierwotnej historii26.
To łagodny restart i wznowienie, bez dowodu nagłego crashu lub MVCC recovery.

Root zapauzował harmonogram w UI do v5. Końcowy SQL READ ONLY potwierdził
pauzę, dokładny trzeci pusty run, dwa wcześniejsze runy bez zmian i wszystkie
zachowane wiersze biznesowe. Guard209, ROLLBACK i end są TRUE;187 nie wykonano
ani nie odebrano. Prywatny wynik obserwatora wymagał osobnej pauzy Root;
jej wykonanie i dane potwierdza dopiero ten końcowy dowód.

Restartowany worker zakończył się łagodnie EXIT0 po272397ms, a aplikacja
ze swoim supervisorem EXIT0 po1540591ms. Root potwierdził brak wszystkich
pięciu własnych PID i listenera4105. Dotychczasowe usługi4100/4103 nadal
odpowiadały HTTP200 na tych samych rewizjach. Nie usuwano danych ani nie
zarządzano PostgreSQL. Status zamknięcia to
`SCOPED_SCHEDULE_LIFECYCLE_CLOSED_FULL_GOAL_OPEN`.
Pełny187 po zachowanym timeout, test zmiany uprawnień podczas pracy,
crash/MVCC recovery, skala i wszystkie osiem kryteriów Goala pozostają otwarte.
Poprawka odczytów `32c9522` nadal ma wyłącznie odbiór źródłowy poza wydaniem S2.

| Dowód restartu i zamknięcia | SHA256 |
| --- | --- |
| [Trzeci naturalny pusty run:178 GET](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-restart-acceptance-prepared-agent-20261018-01/observe-restart01/result.private.json) | `84f59e151feb6a8f9fd7945334452fcbcb5a04626ac4c49ee76cdfa643628b7d` |
| [Końcowy SQL po pauziev5](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/due-restart-final-data-prepared-agent-20261018-01/run01/result.private.json) | `97aefd34d480c57cad3271291f7bf9319fb9c230bfde791c66625b619bea17cd` |
| [Trzeci pusty run i pauza w Chrome](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/restart-resume-empty-paused-chrome.png) | `f0c106512398fa645a0c7440922fc31424e94f5d693a8e964b510b7aed6fd8f1` |
| [Zamknięcie własnego runtime i zachowane usługi](../../../../local-builds/full-base-preview-20261017/automation-schedules-history-fixed-runtime-root-20261018-02/root-final-closure.private.json) | `c5d7e79cca76253ca0635af382eb95d612c27c1adf6fb380df61835878228905` |
