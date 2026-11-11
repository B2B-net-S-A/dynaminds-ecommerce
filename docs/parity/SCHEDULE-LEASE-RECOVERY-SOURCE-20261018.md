# Jawne odzyskanie własnej dzierżawy harmonogramu

Status: **SOURCE_ONLY — rzeczywisty PG crash/CAS, nowe wydanie oraz odbiór UI/API NOT_RUN**. To przyrost produktu dla ograniczonego workera `add_tag`, nie zamknięcie kryterium5 ani całego Goala.

## Dostarczony zakres

[ordinary-local-schedule-worker.ts](../../server/ordinary-local-schedule-worker.ts) udostępnia jednorazowe `recoverLease`; [ordinary-local-worker.ts](../../server/ordinary-local-worker.ts) dodaje jawne `--schedule-recover` w istniejącym jedenastym entrypoincie. Dotychczasowe repricing i `--schedule` pozostają oddzielne. Nie uruchamia się globalny reaper, pętla odzyskiwania, listener HTTP ani procesowanie dostawców.

Po zbudowaniu i odebraniu **nowego** wydania operator wywołuje jego rzeczywisty worker entrypoint:

```sh
node ABSOLUTE_BUILT_ORDINARY_WORKER_ENTRY --schedule-recover ABSOLUTE_SELECTION_PATH SELECTION_SHA256 ABSOLUTE_RECOVERY_PATH RECOVERY_SHA256
```

N05 nie zawiera tej późniejszej zmiany. Nie uruchamiano powyższego polecenia na PG w ramach niniejszego przyrostu. Oba pliki wejściowe wymagają całego SHA256, rzeczywistego pliku0600, właściciela bieżącego procesu i braku symlinka/hardlinka. Selection zachowuje dotychczasowy zamknięty kontrakt: normalna konfiguracja wydania i jedna własna firma/harmonogram/autor/watermark/jeden dokładny `add_tag`.

Recovery JSON ma dokładnie poniższe klucze; placeholdery wymagają **rzeczywistego aktualnego odczytu**, nie są gotowym wejściem:

```json
{
  "schema": "dynaminds-local-schedule-recovery/v1",
  "job_id": "ACTUAL_JOB_UUID",
  "run_id": "ACTUAL_RUN_UUID",
  "lease_token": "ACTUAL_OLD_LEASE_UUID",
  "expected_attempts": 1,
  "schedule_version": "ACTUAL_BIGINT_STRING",
  "definition_version": "ACTUAL_BIGINT_STRING",
  "reason": "Konkretny powód uzgodnionego odzyskania dzierżawy",
  "expected_checkpoint": {
    "cursor_at_text": null,
    "cursor_id": null,
    "scanned": 0,
    "done": 0,
    "skipped": 0,
    "failed": 0
  }
}
```

Checkpoint musi odpowiadać pełnemu bieżącemu wierszowi. Niezerowy cursor wymaga dokładnego PostgreSQL `cursor_at::text`, z zachowaniem mikrosekund, i UUID kursora. `reason` jest przycięty, ma8–500 znaków i nie zawiera znaków sterujących. Brak flag `force`, SQL, dowolnych akcji, aktora lub wyłączenia zabezpieczeń.

## Bezpieczeństwo i wyniki

Normalna fabryka i rzeczywiste `tenantTx` pozostają obowiązkowe. Recovery blokuje schedule→job→run, sprawdza tenant/autor/actions/watermark/wersje oraz **świeże** `offer_sync_is_admin` z blokadą członkostwa. Odrzuca znany `failed>0`, obcy/provider job, provider wait, nieaktualny checkpoint, niewygasłą dzierżawę i wyczerpany limit prób. Zachowuje istniejący próg2min oraz `run_at<=now()`.

CAS sprawdza dokładny stary token, stan, attempts i oryginalne `locked_at::text`; nie używa obciętego JS Date. Nadaje nowy token, zwiększa attempts o1 do granicy `max_attempts` i zapisuje audyt `automation.schedule.lease_recover` w tej samej transakcji. Nie resetuje attempts przy odzyskaniu, kursora, counters, next_at, scheduled_for, job/run ID, receipts ani istniejących skutków. Dotychczasowy procesor nadal zeruje attempts po swoim **udanym** zapisie batcha — ten mechanizm nie został zmieniony.

Procesowanie najwyżej jednego batcha następuje dopiero po ACK całego recovery COMMIT. Stary token jest odcinany przez istniejący warunek lease w `processSchedule`. Gdy batch był już trwale zakończony albo ma pending continuation, komenda jedynie odczytuje zablokowany stan i nie wykonuje akcji; nie jest to akceptacja jego pełnych skutków. Wynik wymaga readback w UI/API. Pozostała kontynuacja może zostać podjęta przez zwykłego workera dopiero zgodnie z jego bramkami.

Nieznany COMMIT lub błąd procesora zatrzymuje instancję z `STOPPED_RECONCILE_NO_AUTOREPLAY`. Jednorazowy runtime nie może potem wystartować pętli, ponownie odzyskać lease ani użyć wcześniej zakończonego ręcznego `cycle`. CLI zamyka własną fabrykę; terminal zawiera status i bezpieczne metadane, bez DSN, treści reason lub tokenów. To uprawniony lokalny operator; nie dodano jeszcze przycisku operatora ani HTTP recovery endpointu.

Wykryto i naprawiono również lukę zwykłego restartu: po zapisanym itemfailure nowa instancja mogła podjąć pending batch. Teraz normalny claim wymaga `r.failed=0` w SQL i ponownie pod blokadą runu, przed nadaniem lease. Znany błąd nie staje się automatyczną próbą po restarcie.

## Dowody źródłowe

[Testy](../../tests/ordinary-local-schedule-worker.test.ts) wykonują rzeczywiste źródła przez kontrolowane porty, bez PG/app/HTTP/provider. Obejmują próg i odmowy wierszy, attempt1→2 przy max2, zgodny checkpoint z mikrosekundami, CAS/audit rollback, dwie trwałe gałęzie utraty ACK, kontynuację25→26, konkurencję dwóch recovererów, rzeczywisty kod odmowy starego tokenu oraz prywatne pliki/CLI/cleanup. Model nie dowodzi rzeczywistego czasu TTL, blokad PG ani awarii sieci/procesu.

Root odebrał końcowy zakres **50/50 PASS,0 SKIP,2287,274958ms**, oryginalna próba83547 EXIT0:28 testów harmonogramów i22 repricing, w tym trzy nowe regresje persisted failure/unused runtime. Wcześniejsze47/47 PASS oraz `npm run typecheck` EXIT0 dotyczyły stanu przed ostatnimi dwiema bramkami SQL/locked-row i zmianą testów. **Pełny typecheck końcowego wspólnego worktree pozostaje do ponowienia przez Roota po zamrożeniu równoległych źródeł**; nie przypisujemy mu wyniku wcześniejszego biegu. Wcześniejszy błąd składni testu i nieudana próba67017 pozostają historycznym błędem przygotowania. Pure parse trzech plików i `git diff --check` po zmianie przeszły.

## Następny rzeczywisty odbiór — plan, nie wykonanie

Użyć jednego nowego wspólnego wydania, istniejącej fabryki i normalnego API do przygotowania nowej własnej firmy,26 zamówień i jednej lokalnej akcji/tagu. Nie zmieniać odebranej historii S2, nie kopiować pakietów i nie tworzyć kolejnego kompilatora. Przygotować osobny kontrolowany zakres danych i zapisać prawdziwy lease/checkpoint przed każdą awarią; TTL odczekać rzeczywiście, bez backdatingu.

| Przypadek | Potrzebna kontrolowana awaria | Wymagany wynik |
| --- | --- | --- |
| Utracony claim/recovery COMMIT ACK | Jednorazowe odcięcie odpowiedzi transportu PG przy COMMIT; odrębny odczyt rozstrzyga, czy zapis zaszedł. Przetestować również zerwanie przed zatwierdzeniem. | Żaden dispatch przed ACK; po faktycznym odczycie pending albo dokładny nowy lease/attempts. Brak nowego occurrence/run/job, powtórne odzyskanie tylko po nowej jawnej decyzji. |
| Crash w batchu przed checkpointem | Drugi klient blokuje wyłącznie kolejny własny order; po dojściu procesora do tej blokady Root kończy jego rzeczywisty backend/proces. | Wszystkie niezatwierdzone akcje/item/receipt/event wracają razem. Po odzyskaniu26 skutków, nie51; wcześniejszy trwały checkpoint25 pozostaje25, stock zgodny. |
| Utracony batch COMMIT ACK | Odciąć odpowiedź dopiero po rzeczywistym zatwierdzeniu batcha25 oraz osobno terminalnego batcha. | Pending/cursor25 prowadzi tylko do pozostałego1; terminal26 wyłącznie do readback. Żadnego powtórnego eventu, wersji, receipt lub outbox dla już wykonanych pozycji. |
| Dwóch recovererów i stary owner | Dwa rzeczywiste procesy na tym samym tokenie; kontrolowane zatrzymanie/wznowienie starego procesora przed jego sprawdzeniem lease. | Jedna rotacja i jeden batch; stary token bez skutków. Osobno odmowy fresh role/version/action/providerwait, TTL i limitu prób. |

Do testów rzeczywistej utraty ACK potrzebny jest punktowy test transportu/clienta w istniejącym harnessie, który kontroluje granicę COMMIT i utrzymuje dowód trwałego stanu z drugiego połączenia. Sam `throw` w mocku albo zabicie procesu po dowolnym czasie nie potwierdza utraty odpowiedzi po COMMIT. Jeżeli nie ma takiej kontroli transportu, ten przypadek pozostaje NOT_RUN; nie dopisywać produkcyjnego bypassu ani nowego frameworka.

Root prowadzi PID/socket/lease provenance, rzeczywiste readback API i Chrome, audyty oraz końcowe uzgodnienie26 IDs/counters/receipts/events/wersji/stocku i cudzych danych. Odbiór operatora przez UI/API, provider unknown, backup/restore i pełne kryterium5 nadal pozostają otwarte po samym przyroście CLI.
