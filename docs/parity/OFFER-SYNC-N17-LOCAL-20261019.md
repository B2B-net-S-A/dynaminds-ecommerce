# Synchronizacja ofert — odbiór lokalnego wydania N17

**Normalna aktualizacja, zapis ustawień w Chrome, odczyt oryginalnego wyniku
przez API i anulowanie przed nadejściem polecenia PASS.** Jest to odbiór
konfiguracji, nie wykonawcy automatycznych zapisów stanów lub cen.

## Wydanie i zachowanie danych

Źródła: `ed16bb14404494d7be6eb7b60cefe878d6c2650a`. Normalnie zbudowany
pakiet ma SHA256 `84ea2dc75afb1538ed9ec4ab8bd4850e6af3453dcb3aaadaa86afe314ff17b78`:
388 plików,100438786B, największy16062211B. Kontrola całego spisu i hashy
potwierdziła brak dodatkowych plików, niezmienione31 zasobów Native i zgodność
limitu16MiB na plik/96MiB łącznie. Zależności są współdzielone, bez instalacji
lub kopiowania node_modules.

Poprzedni supervisor zatrzymano normalnie; nowy uruchomiono przez istniejący
`tools/local/stack.mjs` na tej samej bazie, porcie4105 i pięciu lokalnych
oficjalnych sklepach Woo. Migracja214 została zastosowana normalną ścieżką.
Generacja1782→1789, validated_generation1789, dirty=false. Stempel zmienił
wyłącznie generation, validated_generation i release_sha256.

Pełny odczyt obejmuje632 tabele publiczne przed aktualizacją i633 po dodaniu
journalu. Aktualizacja zmieniła wyłącznie migrations i stempel generacji;
630 dawnych tabel zachowało pełne hashe. Po czynnościach użytkowych zmieniły
się wyłącznie audit_events, offer_sync_configs i nowa offer_sync_commands;
630 pozostałych tabel po aktualizacji zachowało pełne hashe. W porównaniu
z początkiem628 dawnych tabel jest identycznych.

Kontrola FILE odtworzyła67 pełnych hashy surowych tabel z czterech odczytów.
Dokładne usunięcie dwóch nowych audytów, jednej konfiguracji i migracji oraz
rozliczenie trzech pól generacji odtworzyło wszystkie16 dawnych pełnych hashy
wierszy. Żaden stary wpis journalu ani audytu nie został zmieniony. Wszystkie
140 sesji,709 zadań i10 wstrzymanych kontroli odczytu zachowano. Pozostałe
tabele mają dowód pełnego hasha, bez eksportowania ich surowych wierszy.
Ten odbiór dotyczy schematu public, nie stanowi porównania wszystkich prywatnych
schematów PostgreSQL ani całych baz dostawców.

## Zwykły Chrome i API

W istniejącej sesji administratora firmy E otwarto Integracje → Oferty i zapis.
Jednym kliknięciem zapisano konfigurację: wyłączona automatyka, stany włączone,
ceny wyłączone, odstęp60s, weryfikacja900s, bez zgody na zapisy zewnętrzne.
Chrome pokazał wersję1 i potwierdzenie oryginalnego polecenia. Widok został
sprawdzony wizualnie; zrzut zachowano w katalogu runtime N17.

Oddzielny obserwator wykonał11 rzeczywistych żądań: pięć odczytów własnej
tożsamości, pełny odczyt konfiguracji/zadań, odczyt pierwotnego ACK i cztery
próby odczytu tego samego polecenia przez inne firmy. Własny wynik jest dokładnie
równy journalowi; wszystkie cztery obce próby zwróciły404. Nie ponowiono zapisu.

Następnie sześć rzeczywistych żądań sprawdziło anulowanie nowego polecenia,
jego późne nadejście oraz obserwację. Treść dotyczyła włączenia, lecz anulowanie
zapisano najpierw. Późniejsza konfiguracja zwróciła ten sam CANCELLED; odczyt
wyniku również potwierdził to samo anulowanie. Pełne GET konfiguracji i zadań
przed i po jest identyczne: wersja1, automatyka wyłączona, external_authorized=false.
Nie powstało zadanie zapisu ani wywołanie dostawcy.

Łącznie17 pełnych odpowiedzi API i ich pierwotne treści żądań są przypięte
hashami. W bazie dokładnie jedna nowa konfiguracja, dwa niezmienne polecenia
i dwa audyty: offer.sync.configure oraz offer.sync.command.cancel.

## Dowody lokalne

Katalog preview: `local-builds/full-base-preview-20261017/`.

- `offer-sync214-n17-preservation-prepared-agent-20261019-01/global-reconciliation.root-proof.private.json`:
  6021B, `336f6d152c0558a200371bccc3ac3cb985e4c8ed64f16bd59e03c403ed1e5f74`.
- Odczyty before01, after-upgrade01, final-ui01 i after-observe01 są przypięte
  w tym dowodzie; ostatni ma2681249B,
  `41cdebdacd1909f0b1fdd23cb9d54a9db5f853342d93e81e3bf42623c6f56258`.
- `api-observe01/result.private.json`:5175B,
  `155139dce97ab8aa243c1fe120656fe7ab4f000f13b75bb32a1319ae3504e7bf`.
- `cancel-native01/result.private.json`:2161B,
  `dffc629a0002c140749904aa4124f429aec11dc0d21c9a595908e4678aaf59f5`.
- Screenshot: `offer-sync214-n17-runtime-prepared-agent-20261019-01/ui-E-paused-configuration.root.png`.

Źródłowe102 testy kontrolowane, typecheck i niezależną kompilację PostgreSQL
opisuje [Source214](OFFER-SYNC-COMMANDS214-SOURCE-20261019.md). Faktycznej utraty
odpowiedzi w transporcie nie wywoływano w N17; ten wariant ma kontrolowane testy
backendu i React. Nie przypisujemy im odbioru awarii działającego procesu.

Automatyczny executor stanów/cen, automatyczne importy i katalog APPLY, awaria
w trakcie pracy, backup/restore, skala, konta zewnętrznych dostawców i pełny
Goal nadal OPEN. Środowisko pozostaje wyłącznie lokalne.
