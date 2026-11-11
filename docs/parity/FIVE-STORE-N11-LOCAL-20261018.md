# N11 — obsługa pięciu skonfigurowanych sklepów lokalnych

Status: **normalna aktualizacja N11, dane, API i Chrome PASS w opisanym zakresie**.
Obsługa pięciu sklepów ma odbiór kodu; podłączenie pięciu firm, import i worker
na pięciu rzeczywistych sklepach pozostają otwarte. Pełny Goal jest aktywny.

## Produkt i testy

Commit9224af7 rozszerza registry z dwóch do pięciu sklepów. Wspólny moduł
wiąże siedem dokładnych originów: dawne8443/8444 oraz18443–18447. Transport,
automatyka, kontrola workera i UI używają tej samej listy. Identyfikatory
fixture/channel/origin muszą być różne; tenant, aktualny administrator,
właściciel, przypięte CA i credentials nadal obowiązują. Lista nie nadaje
uprawnień do dowolnego adresu lub konta dostawcy.

Root: typecheck EXIT0,39 testów backendu i10 rzeczywistych testów komponentu
React PASS/0SKIP. Kontrolowany HTTPS używał własnego portu losowego, bez
przejęcia portów istniejących sklepów. Testy obejmują pięć niezależnych
wyborów, obcy tenant/user/channel, zmianę wejścia po konstrukcji, cleanup,
odmowy szóstego sklepu, duplikatów i zmienionego adresu oraz dekoder UI.

Kontrakt źródeł rozszerzony w f6f88b0:61 plików/26 runtime/29 SQL,
59 dawnych członków identycznych. Pełny inverse odtwarza poprzedni kontrakt
f371be7c…; nowy manifest f12bcc8836dd5064db0530c9881480f8831bb22232e128ca227a9b04cfcda3e4.
Sześć testów publikatora PASS. Root rzeczywiście opublikował kontrakt i
sprawdził całą zawartość. Raport publikacji przeniesiono poza ścisły roster
kontraktu; ponowna walidacja PASS, bez powtórzenia publikacji lub SQL.

## Wydanie i normalna aktualizacja

Root74157: stage/Vite/check/emit EXIT0. Świeży izolowany Git cut9224af7:
1284 pliki,746 źródeł backendu,340 wejść frontendu, dokładnie sześć zmian
istniejących źródeł i jeden nowy moduł wspólny. Zależności współdzielone;
bez instalacji i kopiowania node_modules.

Rzeczywisty pakiet ma **384 pliki/100285843B**,11 entrypointów, limity
16MiB/member i96MiB całości zachowane. Przygotowanie przewidywało383;
metafile potwierdził dodatkowy537B chunk z wyłącznie nowym modułem origins.
Root zaakceptował rzeczywistą pełną emisję, zachowując pierwotną prognozę.
239 innych członków poza frontendem/runtime/manifestem źródeł jest w całości
zgodnych z N10. Native, adapter, zasoby i migracje niezmienione;210 wyłączone.

Manifest i działająca rewizja:
`8d8f8bdd86246c93366249aafa3c2dac131cef154f39a661a864311ba3d9c749`.

Po świeżym capture627 tabel Root14663 zamknął N10 normalnie EXIT0;
dotychczasowa sesja51527 zakończyła się EXIT0, PID93010 i port4105 zwolnione.
Root21098 uruchomił zwykły stack N11, LOCAL_STACK_READY, app PID13890.
Ta sama baza/konfiguracja,627 tabel,626 biznesowych zachowanych; tylko
release_sha256 zmieniony, generacja/validated1744, dirty=false.
Workery, dostawcy i lokalne fixture'y w tym uruchomieniu pozostają wyłączone.

Pierwszy odczyt po aktualizacji wykonano zbyt wcześnie, podczas stanu starting;
odmówił na starej rewizji bez zapisu snapshotu. Log zachowany. Po rzeczywistym
LOCAL_STACK_READY wykonano nowy odczyt, z pełnym uzgodnieniem i ROLLBACK/end.
Observer osobno potwierdził health200, właściwą rewizję, tożsamość bazy i cały
stempel przez READ ONLY8s/9s. Nie uruchamiał ponownie pełnego187.

## API i Chrome

Root46363:11GET,0POST/SQL/dostawcy, EXIT0; pełne biznesowe DTO i dawne RMA
identyczne z N10. Chrome na zachowanej sesji własnej firmy, po świeżym
załadowaniu N11, potwierdził:

- PARTIAL A-01: stan8, rezerwacja1, dostępne7 oraz szczegóły lokalizacji.
- Zachowane liczby i kwoty na pulpicie.
- Integracje → Lokalne sklepy Woo: jawny komunikat, że ten start nie ma
  skonfigurowanych sklepów. Nie wykonano enroll, tworzenia kanałów lub kluczy.

Końcowy capture potwierdził **wszystkie627 tabel identyczne po API i UI**,
z ROLLBACK/end. Screenshoty ui-stock-root.png i ui-integrations-root.png
oraz AX diff zachowane. Wąski odbiór aktualizacji nie zastępuje rzeczywistego
odbioru pięciu firm/sklepów, importu, workerów, skali lub pełnego WMS.

## Dowody

Wydanie: `local-builds/full-base-preview-20261017/five-store-app-release-prepared-agent-20261018-11`.
Odbiór: `local-builds/full-base-preview-20261017/five-store-original-app-n11-prepared-agent01`.

| Artefakt | SHA256 |
|---|---|
| root-release-review.private.json |ba10f50ee3c949ebacb7ee4c06205bca43f71f023eef75671850b856354895df|
| data-before-root.private.json |6bbfcfe7e6d270f0252f0a64e9db22f4188cbd6aff0a57fe9db8043113828242|
| data-after-root.private.json |b5249f48e67f2419d8e6d6edaa1045743cf5e58315deeba2f894701ddc59e92f|
| ready-root.private.json |93037557903b4d10d55b1620bb9b4e8bb1f14ff41bcf1676a388522292d823d3|
| read-api01/result.private.json |b1c66cdfdb66645fdcc82f7b0ac8dc6583dba12b3e41da6f636d113e968f9632|
| data-after-ui-root.private.json |8739c8a61b469b515a691d52291efee2c241aae1a65e22ed7636d2be8816f900|
| final-runtime-summary.private.json |465f7d967bb0dfd85886a2e475d2be6b08f746bbd729518deaae2474cfa5603c|

Późniejszy commit927ea46 Source33 ma47 testów i niezależny odbiór źródeł;
nie jest częścią tego uruchomionego N11 i nie aktywuje biznesowego splitu.
