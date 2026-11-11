# Sterowanie lokalnym workerem przez UI — 2026-10-18

Status: **ACCEPTED_LOCAL_UI_RULE_CONTROL_TWO_TENANTS_WITH_DISCLOSED_OBSERVER_FAILURE**.
Root wykonał końcowy reader z EXIT0: **19 biznesowych zapisów zwykłego UI,
dwóch tenantów, sześć zamówień i siedem nowych linii notatek**. Końcowe pięć
wiadomości DB odpowiada dokładnie pięciu trwałym efektom lokalnego SMTP:
**dwie `smtp_accepted` i trzy `uncertain`**. Jedna `uncertain` pochodzi z jawnie
ujawnionego błędu pierwszego obserwatora; dodatkowa notatka4b była nowym,
odrębnym zdarzeniem, nigdy ponowieniem starego wysłania.

**Cleanup: CLOSED_AND_PRESERVED** — osobny terminalny przegląd Root potwierdził
zamknięcie własnej aplikacji i odbiornika SMTP, zwolnienie ich portów oraz
zachowanie Main/APP16 i starego SMTP1025. Nie odebrano tutaj nowego drain/restart,
pełnego recovery, skali ani dostarczenia zewnętrznego. `full_goal_complete=false`.

## Pakiet, start i fikstury

Badane wydanie lokalne to
`bd46ebfaaa0e3c4f8d260243ce6ea175e892bd204f6b8ab8b4b7eff0335afa7d`.
To nowy pakiet209 zawierający poprawkę normalizatora ACL oraz poprawkę układu UI
`c8e9159`. Zwykły start aplikacji na świeżej, osobnej kopii przyjął232 brakujące
reprezentacje domyślnych ACL bez wcześniejszych ręcznych GRANT i bez wywołania
normalizatora poza aplikacją. Root potwierdził40503 metadane, kontrolę209/187
przy limicie odczytu8s i początkowe37 tenantów /0 opt-in.
To osobny dowód startu po restore; szczegóły i granice opisuje
[raport restore](RESTORE-OWNER-ACL-LOCAL-20261018.md).

Następnie przygotowanie przez zwykłe API utworzyło dwie świeże przestrzenie
tenantów i sześć zamówień: po jednym dla przyjętego SMTP, utraconego ACK oraz
notatki przy wyłączonej regule. Receipt potwierdza22 biznesowe POST,103 żądania
łącznie i zgodność końcowych pinów źródeł. Samo przygotowanie fikstur nie jest
odbiorem workera. Dane uwierzytelnienia, cookies, DSN i treści wiadomości
pozostają wyłącznie w prywatnych plikach0600.

## Odebrany przebieg tenant0

- UI zapisał wyłączenie bazowej reguły fikstury i utworzył nową regułę notatki.
  Root snapshot02 niezależnie sprawdził jej ID, właściciela, tenant, nazwę,
  warunek tagu, trigger, kanał, szablon, priorytet50 oraz wersję1. Bazowa reguła
  jest wyłączona w GET i PG; globalna liczba aktywnych opt-in wynosiła0.
  Snapshot korzystał z istniejącej sesji i wykonał0 authPOST oraz0 biznesowych
  POST. Zachował także pełne odczyty sześciu zamówień i pustą historię e-mail.
- UI włączył nową regułę do wersji2. Niezależny odczyt Root potwierdził pełny
  kształt reguły oraz dokładnie jeden dozwolony aktywny opt-in. To zapis
  konfiguracji; nie jest potwierdzeniem drain lub zatrzymania procesora.
- UI zapisał pierwszą notatkęA raz i otrzymał ACK. Pierwszy obserwator Root
  zakończył się jednak błędem opisanym niżej; ta próbka pozostaje w dowodach.
- Nowa, inna notatka `accepted-second-event` została zapisana raz, z osobnym
  intentem4b. Uprzednio uzbrojony watcher02 przypisał nową wiadomość do jej
  własnego joba, batcha, runu, zamówienia i tenanta, porównał prawdziwy nagłówek
  `X-Dynaminds-Message` lokalnego SMTP i wykonał pojedyncze `release` po
  trwałym, wyłącznym zapisie intentu. Root original77659 EXIT0 potwierdził
  `OWN_EFFECT_CONTROL_AND_GET_READBACK_CONFIRMED`, stan `smtp_accepted` oraz
  brak automatycznego ponawiania. Stara wiadomość nie została użyta jako nowa.
- UI wyłączył regułę do wersji3. Root ponownie potwierdził wyłączoną bazową
  regułę, pełny kształt nowej reguły oraz0 globalnych aktywnych opt-in.
  UI zapisał też notatkęP raz. Późniejszy snapshot Root `tenant0-paused-note`
  potwierdził0 e-mail dla P i0 globalnych opt-in przez GET/PG READ ONLY;
  osobny odczyt SMTP wykazał dokładnie2 zapisane efekty,0 oczekujących ACK
  i wyłączony dedupe. Pauza nie jest deklaracją drain.
- Wznowienie do wersji4 zostało niezależnie odczytane przez Root: globalnie1
  dokładnie dozwolony opt-in, nadal0 e-mail dla P. Nowa wiadomość zdarzeniaB
  została następnie przypisana do oryginalnego joba i własnego efektu.
  Watcher02 original36000 EXIT0 wykonał jeden `drop` z potwierdzonym ACK
  sterowania; odczyt API potwierdził `uncertain`. Wiadomość to
  `dd0d3f4e-9c63-4829-acdc-b2acb1032cf9`, job
  `6f7dac45-e2de-4f00-8f77-a2c8986b5177`, efekt
  `5fd89e35-03b7-4ef2-8de2-3caa7091a0fe`.
- Odrębny helper READ ONLY original90683 EXIT0 zaobserwował brak ponownej
  wysyłki przez **20,047s i10 nowych zakończonych cykli runtime** przy aktywnej
  wersji4. W138 GET i46 odczytach SMTP potwierdził tę samą wiadomość/job
  `uncertain`, `automatic_retry=false`, wymagane uzgodnienie, procesor RUNNING,
  `started=true`, `draining=false`, dokładnie3 niezmienione efekty SMTP
  i nadal0 e-mail dla P. Dokładny globalny zakres sprawdzono w PG READ ONLY
  na obu końcach obserwacji. Helper wykonał0 authPOST,0 biznesowych POST
  i0 mutacji SMTP. To dowód tego ograniczonego okna, bez twierdzenia o trwałej
  liczbie prób ani o zachowaniu po restarcie.

- Po zakończeniu okna obserwacji UI wyłączył regułę do wersji5. Końcowy
  niezależny GET/PG Root potwierdził `effective=false` i konfigurację OFF.

## Odebrany przebieg tenant1 i końcowe uzgodnienie

Tenant1 wykonał dziewięć odrębnych zapisów UI: wyłączenie bazowej reguły,
utworzenie własnej reguły, włączenie, notatkę przyjętą przez SMTP, pauzę,
notatkęP, wznowienie, notatkę z kontrolowaną utratą ACK i końcową pauzę.
Root watchery przywiązały każdą nową wiadomość do dokładnego joba, batcha,
runu, reguły i wersji oraz własnego trwałego efektu SMTP. Pojedyncze `release`
i `drop` zakończyły się odpowiednio `smtp_accepted` i `uncertain`.

Przy aktywnej wersji4 niezależny reader tenant1 potwierdził brak ponowienia
przez **20,667s i10 nowych zakończonych cykli**. Okno tenant0 wynosiło
**20,047s i10 cykli**. Odczyty zachowały oryginalne wiadomości i efekty,
zero wiadomości dla obu notatekP i zero mutacji SMTP. To dwa ograniczone
okna obserwacji, nie dowód zachowania po dowolnym czasie lub restarcie.

Końcowy reader Root niezależnie sprawdził:

- Wszystkie19 par intent–ACK z jawnego manifestu: hashe, unikalne identyfikatory,
  tenant/aktor, wydanie, profil, fikstury, zamknięte kroki, cel, notatkę,
  wersję i stan konfiguracji. Uwzględnia różne nazwy plików ACK tenant1.
  Status UI oczekujący na dowód SMTP nie był utożsamiany z akceptacją SMTP.
- Sześć zamówień zachowało porównywane pola poza dozwolonymi notatkami i ich
  wersjami: status, magazyn, odbiorcę/adres/dostawę, kwoty, pozycje,
  kompletację, tagi, przesyłki i dokumenty. Przyrosty wersji wynoszą2 dla
  accepted tenant0 oraz1 dla pozostałych pięciu; łącznie siedem linii notatek.
- Obie nowe reguły mają wersję5, konfigurację OFF i `effective=false`;
  obie bazowe reguły pozostają OFF w wersji2. Globalnie jest0 aktywnych
  opt-in przy39 tenantach. Zapis pauzy konfiguracji nie jest dowodem drain.
- Pięć unikalnych wiadomości, jobów i efektów jest powiązanych przez dokładny
  nagłówek `X-Dynaminds-Message`, odbiorcę i tenant. Wszystkie joby mają
  `attempts=1`, `max_attempts=1`, stan `done` i `lease_token=NULL`.
  Dwa kontrolowane drop dały dwie `uncertain`; trzecia ujawniona pierwotna
  wiadomość pozostała `uncertain` z `decision=null`, bez automatycznego retry.
- Dla dwóch własnych produktów odczytano po `on_hand=3`, `reserved=3`,
  `available=0`. To kontrola zachowania stanu, nie odbiór nowego fizycznego
  ruchu magazynowego przez UI.
- Cztery odczyty obcych zamówień/reguł, po dwa na tenant, odmówiły404.
  Main4100 i APP164103 zachowały przypięte wydania oraz wyłączone globalne
  background workers.

Zwykły UI wykonał dwa logowania i dwa wylogowania; na końcu formularz logowania
był widoczny, a własna karta została zamknięta. Root obejrzał desktop obu
tenantów oraz ekrany375×667 tenant0 i tenant1, w tym diagnostykę oryginalnej
`uncertain` tenant1 z poprawnym zawijaniem UUID. Osobne odczyty Chrome dla obu
przestrzeni potwierdzają brak poziomego overflow; wąskie karty wymagają
przewijania pionowego. Nie jest to odbiór wszystkich rozdzielczości,
dostępności ani całego interfejsu produktu.

## Jawne odchylenie pierwszego obserwatora

Root original48043 zakończył się EXIT1 **przed jakimkolwiek release/drop**.
Obserwator zobaczył świeżą wiadomość jeszcze w kolejce, z
`attempted_at=NULL`, i błędnie potraktował ją jako powód natychmiastowej odmowy,
zamiast dalej czekać. UI nie ponowił zapisu notatki ani wysyłki. Worker później
utworzył jeden efekt SMTP; zanim Root zebrał uzgodnienie, wiadomość była już
`uncertain`, a lista oczekujących ACK była pusta.

Prywatne uzgodnienie01 wiąże oryginalną wiadomość
`c85751a2-a53d-4320-a894-64db614b2a14`, job
`6c60b4c3-5475-4abd-b807-934b25cd5935` i efekt
`c90af1fc-9067-41d8-aac0-2d46009c30ca`; `previous_control_dispatched=false`,
`decision=null`, `automatic_business_retry=false`. Nie jest to zaplanowana
kontrolowana próbka utraty ACK i nie zaliczamy jej jako przyjętego SMTP.

Wykonany pierwszy helper i jego błędny receipt zachowano bez zmian. Odrębny
watcher02 czeka na rozpoczęcie próby wysyłki, sprawdza niezmienny baseline
starej wiadomości i dopuszcza wyłącznie nową wiadomość z innym jobem i nowym
efektem. Dodatkowa notatka jest nowym zdarzeniem biznesowym, z osobnym intentem
i ACK. Liczba zapisów UI wzrosła18→19. Końcowy odczyt rzeczywiście potwierdził
trzy efekty tenant0 i dwa tenant1, pięć łącznie, z jawnym uwzględnieniem tej
jednej dodatkowej próbki. Nie zaliczono jej jako kontrolowanego drop ani
przyjętego SMTP.

## Terminalne zamknięcie własnych usług

Osobny przegląd Root ma status `CLOSED_AND_PRESERVED`. Stop aplikacji80213 oraz
oryginalny proces startu4891 zakończyły się EXIT0: stan jest zamknięty,
bez błędu i bez błędów cleanup, child zakończył się0. Supervisor42077 i child42081
nie istnieją, a4104 nie nasłuchuje. Odbiornik SMTP został zamknięty z ACK;
oryginalny proces31288 zakończył się EXIT0, stan jest `CLOSED` z
`fixture_closed=true` i `control_closed=true`. PID41495, owner lock i socket
kontrolny nie istnieją, a50171 nie nasłuchuje.

Main4100 i APP164103 zachowały dokładne wcześniejsze wydania i konfigurację
workerów, a stary SMTP1025 nadal nasłuchuje pod tym samym PID96215. Cleanup
nie wykonał biznesowych mutacji ani `release/drop`. Wcześniejszy reader danych
uczciwie zapisał `owned_process_cleanup_pending=true`; późniejszy osobny dowód
zamyka tę granicę, bez zmiany historycznego receipt.

## Co nadal pozostaje otwarte

- Nowy drain/restart przez UI, pełne recovery niepustej kolejki, inne rodzaje
  skutków i providerów oraz docelowy profil skali pozostają poza tym odbiorem.

Nie odebrano tutaj nowego drain/restart, pełnego recovery niepustej kolejki,
odporności na dowolne awarie ani skali. Lokalny SMTP z wyłączonym dedupe nie
dowodzi zewnętrznego dostarczenia. Ten raport nie potwierdza aktywacji Source210,
genuine Native ani ukończenia pełnego klona Base. Poprzedni, odrębny odbiór
[API/worker/SMTP lifecycle](WORKER-SMTP-LIFECYCLE-LOCAL-20261018.md) zachowuje
swój własny zakres i nie jest przenoszony automatycznie na bieżący przebieg UI.

## Prywatne dowody i piny

Wszystkie poniższe ścieżki są pod katalogiem
`/Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01`.
Linki prowadzą do prywatnych dowodów; raport nie kopiuje ich sekretów ani
treści e-mail. Piny potwierdzają odczytane pliki, nie rozszerzają zakresu odbioru.

| Dowód Root / przygotowanie | B | SHA-256 |
|---|---:|---|
| [root-normal-startup-review.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-normal-startup-review.private.json>) | 1956 | `3bdc86c21fcdc3d18a3e905b70ded990e655c4576e274d385c0c2c44fbfac0fa` |
| [fixture-api-run01/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/fixture-api-run01/result.private.json>) | 738 | `9d480ec0fb72a8af64ecf072ed880746500607dfd91db4aa2553733030fee667` |
| [fixture-api-run01/worker-fixtures.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/fixture-api-run01/worker-fixtures.private.json>) | 1724 | `458ffdba609745f2f019d98a3bed8e32dfdf5f39120ccaed4c29c25c29e8b804` |
| [root-ui-snapshot02/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-snapshot02/result.private.json>) | 362 | `9ac16124f5ed5ff4a675369f627ec417cb2339570f5daecab02af03ee78423d5` |
| [root-ui-snapshot02/rule-bindings.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-snapshot02/rule-bindings.private.json>) | 43799 | `9e380709d9a8d0bcedde0ba27defe6d0e0561539ffd18af72c621257405e15cb` |
| [root-ui-tenant0-active/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-tenant0-active/result.private.json>) | 362 | `bc74ecb5d0e9a0063bfa71046949776003e76b894659c60e5add8d7fddccdce3` |
| [root-ui-tenant0-active/rule-bindings.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-tenant0-active/rule-bindings.private.json>) | 45114 | `876e7f12346ff12f9da943da47573cf5a2a9e8a39cc5d3c0b1ac64d6fe755047` |
| [root-ui-tenant0-paused/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-tenant0-paused/result.private.json>) | 362 | `9ac16124f5ed5ff4a675369f627ec417cb2339570f5daecab02af03ee78423d5` |
| [root-ui-tenant0-paused/rule-bindings.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-tenant0-paused/rule-bindings.private.json>) | 51650 | `46e12495170a1b6ac1a5ceeb5855cb8be296ee3d86b61ef07f643df2245fed3e` |
| [root-watch-tenant0-accepted/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-watch-tenant0-accepted/result.private.json>) | 444 | `9907baa822894ae2a5d29ffc3dd06d3899835402ea12d6b226a7636d083cfb2e` |
| [root-accepted-reconciliation01/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-accepted-reconciliation01/result.private.json>) | 1335 | `0cab3534ff82d862bad2ecca22a6f282787b9f495d50cd906b6e9dca2d390377` |
| [root-watch-tenant0-accepted-second/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-watch-tenant0-accepted-second/result.private.json>) | 1125 | `5c977964b8d509d419bce840d6a235b72dc35b6d4e7838a0f1bfc43708ea199a` |
| [root-ui-observer-prepared/watch.private.mjs](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-observer-prepared/watch.private.mjs>) | 11281 | `810d1aa0066728aeaa985328f6a5911fb75469c627077ebee3d39134f4e5f3df` |
| [root-ui-observer-prepared/watch02.private.mjs](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-observer-prepared/watch02.private.mjs>) | 12280 | `cece0c582348c399d15bcdc40a4e5a29af240e68ed790b189c8d00fb837ae8eb` |

Intenty i potwierdzenia UI zachowano osobno, przed i po pojedynczym zapisie.

| Czynność / ACK UI | B | SHA-256 |
|---|---:|---|
| [tenant0-01-disable-baseline intent](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-01-disable-baseline.intent.private.json>) | 972 | `9f6c2fc0cc88b526d094de3f3fe2bfd9e800fac0937c606cdbc93bf4b3de84e8` |
| [tenant0-01-disable-baseline readback](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-01-disable-baseline.readback.private.json>) | 687 | `2c74d92b6e3a5d3a33c4f29c28863b42c164996232c07582e9c466c50e5234bb` |
| [tenant0-02-create-ui-rule intent](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-02-create-ui-rule.intent.private.json>) | 1402 | `1b48c233691c343b00c9b464748e414b31a4423a8aa6912329b54a5cf4711fc6` |
| [tenant0-02-create-ui-rule readback](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-02-create-ui-rule.readback.private.json>) | 2795 | `594b0d7b4d767333392b9610ca99c79000588c3cf101c37105e7a81509751327` |
| [tenant0-03-activate intent](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-03-activate.intent.private.json>) | 1096 | `c6a5c6f3cd928751a4507a68f9873ae0960f366780f60af3fb50d34772b65513` |
| [tenant0-03-activate readback](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-03-activate.readback.private.json>) | 1322 | `ac164f7ae5c936333139b6fd8bfd2381a21df1015219c0e3ae633f4fc4b50570` |
| [tenant0-04-note-accepted intent](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-04-note-accepted.intent.private.json>) | 1122 | `3117917723c3a98a9f9de0dcd4784950f562fcad9d0da38c35e9c3f1cc6f36c0` |
| [tenant0-04-note-accepted readback](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-04-note-accepted.readback.private.json>) | 1425 | `858b2d2599f0c973c7083df68921149dfc34f7bad24e222effc4df43edf09390` |
| [tenant0-04b-note-accepted-second-event intent](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-04b-note-accepted-second-event.intent.private.json>) | 1150 | `bc74dfd4e106261c31acd1d1a83462e2c95d138546ff434f243103f526e30102` |
| [tenant0-04b-note-accepted-second-event readback](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-04b-note-accepted-second-event.readback.private.json>) | 1465 | `8d9fc26997bacb33d5a32029aef826898b6393f8e9bd88b205691c63b5a2fd67` |
| [tenant0-05-pause intent](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-05-pause.intent.private.json>) | 969 | `20d6070707cd867fce74579e5aa6d9142f420c2a07590409a2f1d2a398f6e6e5` |
| [tenant0-05-pause readback](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-05-pause.readback.private.json>) | 1206 | `1609cd89fd4f7465647da69a218aab5cd1976452da7ee12b8c08f5eb1981f275` |
| [tenant0-06-note-paused intent](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-06-note-paused.intent.private.json>) | 1037 | `f27bb9af55c920871eeb74fbbefb081d9188d966f2ecfc100cf4b6732415f1a4` |
| [tenant0-06-note-paused readback](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-06-note-paused.readback.private.json>) | 1323 | `2f3c873dcf1f0e80656d5edd4a3476434edd77f618c3b1909aede17f3d41ce4a` |

| Zrzut rzeczywistego UI | B | SHA-256 |
|---|---:|---|
| [tenant0-created-rule.private.png](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-created-rule.private.png>) | 139492 | `e0f233b10aace437cbe82da8c08ac0d07b960f13a715ca391cedd63bf204e71b` |
| [tenant0-created-rule-375x667.private.png](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-created-rule-375x667.private.png>) | 32109 | `9a41c22d2795556dc1f45366ee42ed0436ed59d416deb57f90b1c89b46f946f8` |
| [tenant0-note-accepted-second-ui-ack.private.png](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-note-accepted-second-ui-ack.private.png>) | 81410 | `2a4eb915715d776b598eb9031a5db9ad12605b75cac64fb93ca36202762dabb0` |

Poniżej zachowano wcześniejsze potwierdzenia tenant0. Końcowe dowody dwóch
tenantów i przyjęty reader zamieszczono w następnej tabeli.

| Nowy dowód Root | B | SHA-256 |
|---|---:|---|
| [root-ui-tenant0-paused-note/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-tenant0-paused-note/result.private.json>) | 362 | `9ac16124f5ed5ff4a675369f627ec417cb2339570f5daecab02af03ee78423d5` |
| [root-ui-tenant0-paused-note/rule-bindings.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-tenant0-paused-note/rule-bindings.private.json>) | 52170 | `1d55dc4cf8cd8465dc319b98b9acb6bc22b28cee4029f32349a3583f5b513c9b` |
| [paused-note-smtp.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/paused-note-smtp.private.json>) | 185 | `6fcfa77640849af5c9e1a94ea7f6be6ad791f940056f7c44a8f6db73062de3c2` |
| [root-ui-tenant0-resumed/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-tenant0-resumed/result.private.json>) | 362 | `bc74ecb5d0e9a0063bfa71046949776003e76b894659c60e5add8d7fddccdce3` |
| [root-ui-tenant0-resumed/rule-bindings.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-tenant0-resumed/rule-bindings.private.json>) | 52350 | `fa3c89c8d56d686c55075f14f6a6fc6de50f9037167ff727473a9d3f99c008a7` |
| [root-watch-tenant0-lost/control-ack.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-watch-tenant0-lost/control-ack.private.json>) | 864 | `06e55c53245cc9dc9317328a47f549bae89680a3fee784a24e655a49c2e962a5` |
| [root-watch-tenant0-lost/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-watch-tenant0-lost/result.private.json>) | 968 | `34d7bb968df398217f79986d8a878720e2e0276aa8aab4bdb7d764431276b8a4` |
| [root-tenant0-no-replay/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-tenant0-no-replay/result.private.json>) | 12953 | `1daf9617145a245dd2117fbe1d564aa77b712ff8c16ab23db1abddfc1d433683` |
| [root-ui-observer-prepared/no-replay.private.mjs](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-observer-prepared/no-replay.private.mjs>) | 8920 | `683626dbb06c00f451179829acd73bd4dd43635aa60ebe9ac1292add98810aa9` |

## Końcowe dowody odbioru i cleanup

| Dowód | B | SHA-256 |
|---|---:|---|
| [root-final-data-review.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-final-data-review.private.json>) | 31307 | `a72e4d04fea66db761350e471248090fc6ca0ae7f1e6cb99447c0f2e6cacdd16` |
| [root-final-data-check.private.mjs](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-final-data-check.private.mjs>) | 19344 | `aa5253654e5d1af2e1a5b517e719e7b52c6c160d5dfaf9fa98bdbaf58e6b2678` |
| [ui-business-run01/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/result.private.json>) | 19777 | `f9558ca65764fd27b696bbe6b6af14d7abcf22f831dd4b10a72fc7bb2298d067` |
| [root-ui-final-state/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-final-state/result.private.json>) | 362 | `b1244510356de6a05dc7fdcb0d9f89bbf529c18d3c5a8a30fa94f9d4bc100576` |
| [root-ui-final-state/rule-bindings.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-ui-final-state/rule-bindings.private.json>) | 70142 | `3ae2c668704f3b34f8dba882ea56c85a08320e9a7557b098efef2922e786100d` |
| [root-watch-tenant1-accepted/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-watch-tenant1-accepted/result.private.json>) | 975 | `4b20af1f91a0c9714f715775a0aaed013b0d10dd9f7c99b4bfc4ffbfe30ad52e` |
| [root-watch-tenant1-lost/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-watch-tenant1-lost/result.private.json>) | 968 | `04e0888d5ff08b70807e91cd9ab4ea3e27e3f6ac934d8720b89e145a23f5a214` |
| [root-tenant1-no-replay/result.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-tenant1-no-replay/result.private.json>) | 15836 | `fc5402d93e9199b3b10cf697e2a50b81acedea78cc55479ef0514059ffd402c7` |
| [ui-business-run01/tenant0-unresolved-responsive.readback.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant0-unresolved-responsive.readback.private.json>) | 2088 | `d67a9302804a22d10843669e2b1783f4f814f6503d355332d5366ff930c4c0a7` |
| [ui-business-run01/tenant1-unresolved-responsive.readback.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant1-unresolved-responsive.readback.private.json>) | 1966 | `6e76ad6e10c444b5e4d520b6dca5bcd5d3a02118ce0baa064cb70a31fc4f7c8b` |
| [ui-business-run01/tenant1-final-paused-rule.private.png](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant1-final-paused-rule.private.png>) | 117880 | `5114cd0c9c101f3a8828471865777017bfd11c45beb411472f48a3e77f8d01d4` |
| [root-owned-cleanup-review.private.json](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/root-owned-cleanup-review.private.json>) | 2286 | `d801947075e89a999cd80cb8eef0a257e5585e946f5efb1d33318d3d0e6a5cc2` |
| [ui-business-run01/tenant1-unresolved-original-read-375x667.private.png](</Users/arturtwardowski/DYNA Ecomerce/local-builds/full-base-preview-20261017/integrated209-acceptance-root-20261018-01/ui-business-run01/tenant1-unresolved-original-read-375x667.private.png>) | 37142 | `d175ada730513e262a50d8b0fe142d588ad3392b3f9306d6dd9a74cd4393bb69` |
