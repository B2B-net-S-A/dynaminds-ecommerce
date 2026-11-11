# Odczyty harmonogramów — N05,18.10.2026

**Częściowy odbiór normalnego API: start, odczyty przed/po starcie workera i IAM PASS.**
Wydanie `74f747910717c16af8a65f85ff2bef6924e8e94eba01605647f7b1506e99bd0f`
obejmuje382 pliki/99 453 588 B i11 entrypointów. Wszystkie pliki sprawdzono
bajtowo; limity16MiB/96MiB zachowane. Kontrakty native/resource209 i sześć
plików frontendu są identyczne z N04. Jedyną zmianą źródła runtime jest
`server/automation-schedule-routes.ts`: trzy GET używają `tenantReadTx`,
cztery mutacje zachowują `tenantTx`. Nie dołączono nieodebranego210.

Zwykły start N05 na tej samej własnej bazie osiągnął READY i health200.
Root porównał cały stempel: generation=validated_generation1703,dirty=false,
native/profile/contract bez zmian, jedynie zatwierdzona rewizja wydania nowa.
Zachowano ownership nonce i konfigurację; bez clone/restore lub ręcznych grantów.
Osobny odczyt kontroli miał ROLLBACK/end TRUE. Nie nadaje to odbioru pełnego187.

## Odczyty i ograniczony profil przed workerem

Poprawiony obserwator A02 wykonał117 GET,0 POST i0 bezpośrednich SQL:
17 kontroli poprawności oraz100 sekwencyjnych próbek mieszanych trzech tras
w proporcji34/33/33. Pełne DTO historii26 i wyników26 są zgodne na stronach25+1;
historia drugiego harmonogramu zachowała trzy runy i pauzę v5. Trzy trasy
odmówiły401 bez sesji. Sesja administratora i zapisane źródła dowodowe pozostały
niezmienione.

Profil po odczytach kontrolnych: p50=4,529ms,p95=6,501ms,p99=8,837ms;
średnia4,696ms. Cały sekwencyjny loop z walidacją i prywatnym zapisem dowodów
trwał1134,231ms (88,165 żądania/s). Percentyle dotyczą mieszanych100 odczytów
jednej lokalnej aplikacji po kontrolach poprawności. Bez współbieżności,
obciążonych workerów, hydratora zamówienia lub przyznania profilu skali Goala.
Nie jest to porównanie wydajności przed/po zmianie kodu.

Po starcie ograniczonego workera tego samego N05 ponownie potwierdzono cały
stempel1703, health200 i ROLLBACK/end odczytu kontroli. Harmonogram pozostał
zapauzowany; nie zakolejkowano nowych runów. A02 po starcie workera wykonał
kolejne117 GET z pełną zgodnością DTO i100 próbkami: p50=4,519ms,
p95=6,799ms,p99=7,639ms, średnia4,754ms. Loop trwał1172,983ms
(85,253 żądania/s).0 retry/POST/SQL; ten odbiór nadal nie obejmuje obciążonej
kolejki ani profilu skali Goala.

Pierwotny A01 zakończył się FAILED po trzech GET i0 próbkach: health/me200,
następnie prawidłowy401 z `application/problem+json`. Helper błędnie wymagał
`application/json`; zachowano nieudany wynik. Nowy A02 dopuszcza właściwy MIME,
bez zmiany oczekiwanego401 i bez kopiowania wyniku do starej próby.

## Rzeczywiste odmowy IAM

Osobny odbiór wykonał40 żądań:35 GET i dokładnie5 POST z ACK — dwa logowania
istniejących własnych fikstur, odmówiony run403 i dwa logout. Nie tworzono nowych
użytkowników, firm, członkostw lub runów biznesowych. Trzy nagłówki obcej własnej
firmy dały409; jej sesja widziała wyłącznie własną listę, a cztery obce historie
lub szczegóły odmówiły404. Viewer odczytał pełne strony25+1 i historię trzech
runów, lecz nie mógł zakolejkować wykonania. Końcowe odczyty administratora są
w pełni zgodne z początkowymi. Nowe sesje wylogowano, ich stare tokeny dały401,
prywatne jars są puste, a istniejąca sesja administratora zachowana.

## Normalny Chrome na N05

Root w zwykłej istniejącej sesji administratora odczytał historię25+1,
przeszedł do pierwotnego runu26/26 i do drugiej strony wyników25+1.
Ostatnie zamówienie to `DE-20261018-93FA34B9`. Nawigacja odbyła się przez
Chrome/CUA, bez biznesowych mutacji; osobny health potwierdził N05/200.
Zachowano typed receipt, AX i zrzut ekranu obejrzany przez Root.
To odbiór paginacji; nie nowy test błędu/retry lub poll5s według zegara.

## Zamknięcie workera i osobny GET zamówienia

Ograniczony worker zakończył się po SIGTERM: oryginalny proces EXIT0,
1123602ms; PID58989 nieobecny. Aplikacja N05 nadal działa, danych nie usuwano.
Końcowy receipt potwierdził health4100/4103/4105=200 z tymi samymi pełnymi
rewizjami. To łagodne zakończenie workera, bez dowodu crash recovery.

Po zatrzymaniu workera osobny, przypięty profil pełnego GET zamówienia
wykonał2 warmupy i20 sekwencyjnych próbek:22 GET,0 zapisów/SQL/retry, pełna
zgodność DTO. p50=731,690ms,p95=1270,925ms,p99=1312,418ms. Ten wolniejszy
odczyt obejmuje inny endpoint i hydrator; nie porównuje go z mieszanym profilem
harmonogramów ani nie przyznaje kryterium7 Goala. Porównanie kolejnego wydania
wymaga tego samego profilu i pełnego DTO.

**Otwarte:** pełny187 po wcześniejszym timeout, crash/MVCC recovery, skala,
pełny proces RMA/korekty/rozliczenia i wszystkie osiem kryteriów Goala.
Zmiany źródłowe NIP `ec342bb`, recovery `c902a7f`, dowodu GET `bb8782f` i RMA UX
`3258296` powstały później; nie ma ich w N05. Wynik trzech tras nie naprawia
ani nie odbiera kosztu187.

## Dowody

| Artefakt | SHA256 |
| --- | --- |
| [Wszystkie pliki N05](../../../../local-builds/full-base-preview-20261017/read-transactions-app209-release32c9522-prepared-20261018-05/root-canonical-review.private.json) | `70b390bd344c13695bd08435807d059bccc58ba0e42aef628c98e3e5e190ca33` |
| [Zwykły start i cały stempel1703](../../../../local-builds/full-base-preview-20261017/read-transactions-fixed-runtime-root-20261018-03/app-ready-root.private.json) | `ec1a12c741d50317df99ac9a72162e865cb7493982b46c9d58260ca2d5e77e43` |
| [A01: zachowany błąd MIME obserwatora](../../../../local-builds/full-base-preview-20261017/read-transactions-runtime-acceptance-prepared-agent-20261018-01/before-worker01/failure.private.json) | `d18dadabd07617fa31ff50a2f77c7790801a33c7c9a98e9344ee2686b8e57b77` |
| [A02:117 GET przed workerem](../../../../local-builds/full-base-preview-20261017/read-transactions-runtime-acceptance-problem-json-prepared-agent-20261018-02/before-worker01/result.private.json) | `e998e44330814a49df004faf35cd2a23ed12c51283a3453adeb2fe03f502b5fa` |
| [IAM:40 żądań/5 POST z ACK](../../../../local-builds/full-base-preview-20261017/read-transactions-iam-acceptance-prepared-agent-20261018-01/run01/result.private.json) | `c0c8e74dbd7d6e028bd2317dc4ae98c61ecd53630e6476c40de5f0358b3ff974` |
| [Worker READY: cały stempel1703 i health](../../../../local-builds/full-base-preview-20261017/read-transactions-fixed-runtime-root-20261018-03/worker-ready-root.private.json) | `96d2f6cff6b8647b9b55b03a1cd54247f9f5212771c67bab10319757a4aa468b` |
| [A02:117 GET po starcie workera](../../../../local-builds/full-base-preview-20261017/read-transactions-runtime-acceptance-problem-json-prepared-agent-20261018-02/after-worker01/result.private.json) | `864ef859fbe06e61c0f7f78bccef0bbdced4b99852cb6d994c485f4612b24191` |
| [Normalny Chrome N05: historia i wyniki25+1](../../../../local-builds/full-base-preview-20261017/read-transactions-fixed-runtime-root-20261018-03/chrome-pagination-root.private.json) | `999066449d1bd6bfc1db3681c5aa42dac762547212f81b9f60ca39ed37a1ae7c` |
| [Worker EXIT0, aplikacje i dane zachowane](../../../../local-builds/full-base-preview-20261017/read-transactions-fixed-runtime-root-20261018-03/worker-closure-root.private.json) | `cff237cdd0b274959a82ee5a600ff67af8077484034a8f2b1350cfca95312a0a` |
| [Profil GET pełnego zamówienia](../../../../local-builds/full-base-preview-20261017/order-get-baseline-n05-root-20261018-01/profile.private.json) | `f1db750c1f48179c2b7895f0a6ea4268e493408e72336ed0a3dd7ab5d3a97170` |
| [22 GET: pełne DTO i20 próbek, bez odbioru skali](../../../../local-builds/full-base-preview-20261017/order-get-baseline-n05-root-20261018-01/result.private.json) | `9b12fb74fe73764eae5be08ede2a6647b3bc497e063f0b316ac99c15774269e9` |
