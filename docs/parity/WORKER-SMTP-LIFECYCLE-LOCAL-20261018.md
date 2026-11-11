# Lokalny odbiór API–worker–SMTP — 18.10.2026

Status: **PASS_LOCAL_API_WORKER_SMTP_LIFECYCLE_ONLY**. Oryginalny proces Root 68071 zakończył się EXIT0. Odebrano rzeczywisty lokalny przebieg dwóch tenantów na nowym wydaniu209, osobnej kopii danych, API 4104 i prywatnym odbiorniku SMTP 60951. Osobny rzeczywisty Chrome potwierdził **ACTUAL_AUTHENTICATED_READ_ONLY_WORKER_STATUS_HISTORY_ORIGINAL_EMAIL_RECONCILIATION**. Tworzenie konfiguracji, pause/resume/drain/restart przez UI nadal **NOT_ACCEPTED**.

## Wydanie i zakres

Manifest nowego wydania `09158d0bcf96af4649067756117d337a1945beea90aa83d625fcc695f3cbc81b` wiąże 379 plików o łącznym rozmiarze 99408853B przy limicie 96MiB; każdy człon pozostaje poniżej 16MiB. Własny profil uruchamia zwykły entrypoint z `--verified-stock-writers --scoped-automation`. Nie przełączano Main (4100) ani APP16 (4103). Dwa nowe konta administratorów, reguły email-only `order.note_added`, kanały i szablony oraz sześć świeżych zamówień przygotowano zwykłym API. Dane logowania, identyfikatory i surowe SMTP pozostają w prywatnych artefaktach.

Jest to wydanie 209, nie aktywacja Source27/split210. Rzeczywisty lifecycle nie jest testem fizycznego stocku. Kopia workerowa była wcześniej naprawiona źródłowo w zakresie reprezentacji ACL; ten przebieg nie odbiera samodzielnej ścieżki restore/normalizera w pakiecie. Canonical09158 zawiera historyczny normalizer. [Osobny odbiór aktualnej publicznej funkcji](RESTORE-OWNER-ACL-LOCAL-20261018.md) dotyczy kolejnej świeżej kopii i bezpośredniego wywołania źródła; nie nadaje odbioru normalizera w canonical09158.

## Rzeczywiście wykonane zachowania

| Zachowanie | Potwierdzony wynik |
|---|---|
| IAM i izolacja | Dwa różne konta/tenanty; zwykłe API odrzuca obce zamówienie i konfigurację workera. Fikstury przed pierwszym skutkiem miały puste historie i brak wcześniejszych zadań własnych reguł. |
| Wiadomość rozpoczęta przed pauzą | DATA zapisane trwale przed ACK; pauza konfiguracji nie udaje zakończenia rozpoczętego skutku. Własny stack obserwowano jako `draining`, z nadal zatrzymanym tym samym DATA. Dopiero release 250 pozwala zakończyć rozpoczęty skutek i zamknąć pierwotny proces. |
| Zdarzenie podczas pauzy | Po jednym oznaczonym zamówieniu na tenanta; historie email pozostały puste także po restarcie. Pauza nie tworzy późniejszego wysłania tego zdarzenia. |
| Restart po accepted | Zwykły odczyt API potwierdził `smtp_accepted`; wyłączona aktywacja pozostała wyłączona. |
| Utrata ACK | Odbiornik trwale zapisał DATA, następnie zamknął połączenie bez ACK. Wiadomość została `uncertain`, wymaga uzgodnienia i nie otrzymała automatycznego replay po restarcie. |
| Obserwacja braku replay | Runner obserwował co najmniej dwa różne zakończone cykle runtime na tenanta i niezmienioną liczbę skutków w odbiorniku bez deduplikacji. To obserwacja, nie ogólny licznik wszystkich prób jobs. |
| Zakończenie i readback | Pięć własnych cykli stacka zakończonych; odczyt końcowy zachował oryginalne invariants sześciu zamówień. Main/APP16 pozostały na swoich rewizjach. |

Każdy business POST miał wcześniejszy trwały intent; niepewnej odpowiedzi nie ponawiano. Receipt liczy 540 żądań API, 14 business writes runnera i 135 poleceń kontroli SMTP. Polecenia kontroli obejmują także odczyty; liczby nie są miarą przepustowości ani dowodem liczby prób zadań. Przygotowanie fikstur poprzedzało runner i stanowi osobny etap.

## Niezależny odczyt Root po terminalu

Root potwierdził dokładne powiązanie czterech wiadomości DB z czterema unikalnymi skutkami SMTP: **2 `smtp_accepted` i 2 `uncertain`**. Odbiornik nie deduplikuje (`dedupe:false`), miał 0 aktywnych połączeń, 0 oczekujących ACK i 4 zapisane skutki. Dwa release 250 i dwa drop bez ACK odpowiadają tym samym czterem efektom. Zera dla dwóch zamówień pauzowanych wynikają z odczytów runnera.

W kopii jest 39 tenantów, globalnie 0 włączonych opt-in lokalnego workera. Readback kontrolny 182 był czysty: generation=validated_generation=1707 i wiązał to samo wydanie09158. Niezależny odczyt zakończył READ ONLY przez ROLLBACK i client-end ACK. Wszystkie 5 własnych cykli stacka mają potwierdzony stan `closed`. Main (4100) pozostał na `db1a33d2…`, APP16 (4103) na `691a7cb5…`; to zachowanie istniejących usług, nie nowy odbiór ich wszystkich procesów.

Przy pierwszym readback odbiornik SMTP pozostawał uruchomiony (`closed:false`). Późniejszy końcowy cleanup, opisany poniżej, potwierdził jego rzeczywiste zamknięcie. PostgreSQL i dotychczasowy sink1025 nie były zamykane.

## Osobny Chrome: odczyt obu tenantów

Na tym samym wydaniu09158 i profilu02 Root uruchomił kolejny własny stack do odczytu. Agent wykonał dwa normalne logowania i dwa wylogowania w jednej nowej własnej karcie Chrome; **0 business POST**. W obu kontach widoczne były własna reguła w wersji5, wyłączone przyjmowanie nowych zdarzeń, bezczynny procesor, historia accepted SMTP i uncertain. Dla uncertain otwarto istniejący oryginalny szczegół email przez GET: własny kanał oraz oryginalne job/message/batch, bez resend.

Po zmianie konta nie było widocznych oryginalnych identyfikatorów poprzedniego tenanta; końcowe wylogowanie wyczyściło stan. Odrzucenie obcych żądań API pozostaje odrębnym dowodem runnera. Samo zniknięcie danych w UI nie zastępuje tego dowodu IAM. Własna karta została zamknięta, dotychczasowych kart nie zmieniano.

Zakres jest odczytowy i desktopowy. Nie wykonano tworzenia reguły, pause/resume, drain lub restartu za pomocą UI. Przyciski nie były używane do ponowienia niepewnej wiadomości. Zrzuty oraz AX pokazują wąską kartę i zatłoczone długie etykiety; tekst i tożsamość skutku były czytelne, ale odbiór mobilny i poprawa układu pozostają poza tym wynikiem. Powiązanie rewizji pochodzi z rzeczywistego Root HTTP READY/profilu/fikstur, nie z osobno wyświetlanej wersji frontendu. Pięć zamkniętych cykli opisanych wyżej dotyczy runnera68071; późniejszy stack Chrome ma osobny lifecycle i nie jest doliczany do pięciu.

## Końcowy przegląd Chrome i cleanup Root

Root obejrzał oba zrzuty i niezależnie powiązał widoczne identyfikatory reguł oraz oryginalnych niepewnych wiadomości z rzeczywistymi skutkami runnera. Odczyt po Chrome potwierdził te same4 wiadomości DB, te same4 skutki SMTP,39 tenantów, globalnie0 opt-in i zachowane Main/APP16. Licznik182 po późniejszym starcie wynosił generation=validated_generation=1708, `dirty=false`; pozostałe wiązania kontrolne wydania były zgodne. To nie jest deklaracja niezmienności całego wiersza182 względem wcześniejszego1707.

Oryginalny późniejszy stack UI7210 i serwis SMTP34567 zakończyły się EXIT0. Root potwierdził `ALL_OWNED_APPLICATION_AND_SMTP_PROCESSES_CLOSED`: stan SMTP `CLOSED`, `fixture_closed=true`, `control_closed=true`, brak prywatnego socketu/locka, porty4104/60951 zwolnione. Dotychczasowy listener1025 oraz źródłowe i workerowe dane zachowano. Pięć wcześniejszych cykli runnera i późniejszy stack UI mają odrębne dowody zamknięcia.

Wskazane w Chrome niedoskonałości układu pozostają jawne. Poprawkę prezentacji czterech plików zapisano w commicie `c8e9159`; Root potwierdził45 istniejących testów React PASS, typecheck EXIT0 i niezależny przegląd źródła. Poprawka nie jest częścią wydania09158; nowe wydanie i ponowny rzeczywisty odbiór wizualny pozostają NOT_RUN. Nie zmienia zakresu powyższego odbioru read-only.

## Dowody

Prywatny katalog bazowy: `local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01` w katalogu projektu. Pełne payloady i dane kont nie są częścią publicznego raportu.

| Artefakt | SHA256 |
|---|---|
| [Receipt `worker-lifecycle-run01/result.json`](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/worker-lifecycle-run01/result.json) — 1309B | `4b68fa414bdd5782fa50a059755e5b3142f278ba9a64a3e049bfdb0d8c6a1bcf` |
| [Niezależny przegląd Root](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/root-worker-terminal-review.private.json) — 7318B | `1fe5022d02af372e7009e4c8cb3b1f0b983ab9bafa3e2f7fbc81d5ea33956a64` |
| [Chrome read-only receipt](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/ui-readonly-acceptance-20261018-01/result.private.json) —6230B | `35348e410578a37e513737d91189b00e191e40c33a026ec9e8ce609ed85cfd18` |
| Prywatny zrzut Chrome tenant0 —102218B | `d0b3b31d8f51492e7ed200067502a0eeee6aa79db48e30495041a862037045d3` |
| Prywatny zrzut Chrome tenant1 —102128B | `6a947851a3c5756e4f5c696df48a717f861d4c9db873ff32692d33a5d4a797fd` |
| [Root: przegląd obu zrzutów i powiązań UI](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/root-ui-terminal-review.private.json) —680B | `1ae2b01c9c43b302161ac2c2775adc9694e0af02ab29be30c39f0d2fd038d6a2` |
| [Root: odczyt DB/SMTP po Chrome](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/root-after-chrome-readback.private.json) —7318B | `d68da3e04f0a7caa8e12d8a310eff16c251d0e68f90036783f9c75f10eca8ff7` |
| [Root: końcowy cleanup](../../../../local-builds/full-base-preview-20261017/worker-acceptance-runtime-root-20261018-01/root-owned-cleanup.private.json) —674B | `7ae6df961cdd360ec5a6cb4d03604dece40eadd412268148e8976fa94a733181` |
| Selekcja rzeczywistego runnera | `9e3ce2abeb022209820d00c40fa7b716dd3de02e1a0a37a1d923c2c500452beb` |
| Manifest wydania | `09158d0bcf96af4649067756117d337a1945beea90aa83d625fcc695f3cbc81b` |

Raport opisuje zachowany oryginalny przebieg. Nie uruchamiać go ponownie ani nie dopisywać do jego dziennika. [Runner i warunki kolejnej nowej próby](../../tools/parity/worker-smtp-ack-acceptance.README.md), [plan dalszego lifecycle](worker-lifecycle-plan.md).

## Granice odbioru i dalszy etap

- **Chrome read-only PASS; UI creation/control NOT_ACCEPTED**. Odczyt istniejących statusów, historii i oryginalnej niepewnej wiadomości nie dowodzi utworzenia reguły, pause/resume, drain lub restartu przez UI.
- SMTP250 potwierdza przyjęcie przez lokalny fixture; nie dowodzi dostarczenia do skrzynki, realnego konta dostawcy, oficjalnego sandboxa ani zewnętrznej wysyłki.
- Odbiór obejmuje dwie reguły email-only i dwa tenanty. Nie obejmuje innych rodzajów workerów, pełnego coexist transportów, pięciu aktywnych firm i godzinnego profilu skali.
- Bez odbioru fizycznego stocku, ogólnego backup/restore, pełnego recovery, aktualizacji wszystkich zachowanych kopii lub pełnego Goala. Utrata ACK pozostaje do uzgodnienia, bez automatycznego resend.
- Source27 ma rzeczywiste P20/VECTOR27 i Root 32 testy źródeł PASS: 493 dodatki / 22 podmiany, 0 pól oczekujących. VECTOR27 `a1740b25…`/332079B i wynik `dbe676ff…`/918B mają status `SOURCE_EXPECTATION_PREPARED_NOT_COMPILED`; nie nadają Native, kompilacji lub aktywacji splitu. Ostatnia pełna próba C26 zakończyła się timeoutem187 przy 8s, z rollback/drop/close. [Historia splitu](order-split210-native-progress.md).
- [Coverage API](base-api-source-coverage-20261018.json) obejmuje 204 strony w 15 archiwach, z jawnymi brakami metadanych 11 stron Client. Sześć kontraktów [Stocktake](base-api-stocktake-contracts.v1.json) ma 94 pola i Root 9 testów DOM/proweniencji PASS. To dowody dokumentacji; nie zmieniają 612 niewykonanych pozycji odbioru implementacji ani kompletności integracji.
