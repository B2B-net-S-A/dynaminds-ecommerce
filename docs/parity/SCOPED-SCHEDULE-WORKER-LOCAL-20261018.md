# Wąski lokalny worker harmonogramów, 18.10.2026

Status: **SOURCE_AND_CONTROLLED_PORTS_PASS**. Rzeczywisty startup, dzierżawa PG,
wykonanie harmonogramu i odbiór przez Chrome pozostają otwarte.

Istniejący jedenasty entrypoint `ordinary-local-worker` otrzymał jawny podtryb
`--schedule PRIVATE_SELECTION_PATH SHA256`. Dotychczasowy dwuargumentowy tryb
repricing pozostaje bez zmian. Nie dodano entrypointu, migracji ani nowych GRANT.

Nowy owner najpierw uruchamia normalną fabrykę aplikacji i jej kontrole startup.
Prywatny plik0600 ma zamknięty schemat: istniejące sześć pól konfiguracji oraz
dokładny tenant, harmonogram, autor, watermark i jedna akcja add_tag. Nie przyjmuje
SQL, callbacków, kontekstu dostawcy ani nadpisania limitów.

Claim działa w prawdziwym tenantTx/RLS, blokując harmonogram→zadanie→wykonanie.
Sprawdza właściciela, aktualne i zamrożone akcje, obie wersje, payload run_id,
watermark oraz niepodjęte pending z pustą dzierżawą. Dopiero po ACK COMMIT wywołuje
istniejący processSchedule. Aktualną rolę autora odczytuje przez wąski owner-pool
SELECT, ponieważ memberships nie jest dostępne dla dyna_app; procesor ponownie
sprawdza rolę. Nie rozszerzono uprawnień tenantów.

Powrót procesora nie stanowi dowodu wykonania: osobny odczyt sprawdza dokładne
job/run, wyczyszczenie lease, stan, liczniki i zmianę kursora. Rozróżnia zakończenie,
potwierdzoną kontynuację, backpressure i anulowanie. Błąd lub nieznany wynik
zatrzymuje nowe claims bez automatycznego reclaim/replay. Znany błąd pozycji
również zatrzymuje pętlę, z odrębnym stanem zamiast etykiety uncertain.

Root31/31 testów PASS,0 SKIP:9 nowych i22 regresyjne repricing/CLI. Typecheck EXIT0;
niezależny przegląd bez otwartych P1/P2. Dowody lokalne:
`local-builds/full-base-preview-20261017/root-schedule-worker-source-check-20261018-01`
i `automation-schedules-history-app209-prepared-20261018-01/worker-source-readiness.private.json`.

To wąski procesor własnych, już zakolejkowanych wykonań add_tag. Nie uruchamia
globalnego workera, automatycznego schedulera, reapera ani dostawców. Akcja add_tag
może utworzyć dalsze zadania zdarzeń; ten worker ich nie przejmuje. Nie potwierdzono
jeszcze pełnej automatyki, restartu, dostawców, skali ani pełnego Goala.
