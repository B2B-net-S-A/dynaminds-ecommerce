# Odczyty Woo: N15 — administracyjne rozstrzygnięcie niepotwierdzonej próby

**Zwykły start N15 i jeden jawny abort starej próby A PASS w opisanym
zakresie. Pierwotny wynik pozostaje niepotwierdzony. Jedno nowe naturalne wykonanie A,
osobna pauza, globalne uzgodnienie danych i zwykły restart z zachowaniem pauzy
PASS w opisanym zakresie. Pełny Goal pozostaje OPEN.**

## Co zmienia N15

Administrator własnej firmy może jawnie zakończyć niepotwierdzone wykonanie
`orders.sync`, gdy lane jest wstrzymany. Podgląd oraz polecenie są związane
z dokładnym stanem kontroli, wykonania, dispatch i zadania; zmiana tych danych
odrzuca polecenie. Osobny niezmienny receipt utrwala aktora, request hash i ACK.

Wykonanie przechodzi do `aborted`, zadanie do istniejącego stanu `failed`,
z usuniętą dzierżawą. Attempts, payload i dedup zadania pozostają zachowane.
Historyczny dispatch pozostaje `started`; pierwotny wynik nadal jest
`UNCONFIRMED`. Operacja nie potwierdza powodzenia starego odczytu, nie odtwarza
jego przyczyny i nie ponawia, nie przejmuje ani nie resetuje procesora.
Wznowienie wymaga osobnego jawnego polecenia konfiguracji.

Migracja213 rozszerza wyłącznie rodzinę212: terminalny stan `aborted`,
wykluczenie go z indeksu aktywnego wykonania, dwa silne klucze powiązań
oraz osobna tabela `local_woo_read_reconciliations`. FORCE RLS i uprawnienia
SELECT/INSERT bez UPDATE/DELETE chronią receipt. Dotychczasowa migracja212
pozostała byteexact. Zwykły runtime z włączonymi odczytami wymaga212 i213;
wyłączona funkcja pozostaje nieaktywna. UI nie pozwala ręcznie ponowić
zadania zarządzanego przez tę lane.

Kod runtime przypięty do commita
`0ced4aa4912c718f495aa0df4ac1a7b7a24d7468`.
Kontrolowane testy obejmują ochronę CAS/powiązań, brak replay, terminalny stan,
RLS/DDL i spójność zasobów oraz uruchamiania. Są dowodem kodu, a nie odbiorem
rzeczywistego rozstrzygnięcia A lub pracy pięciu firm.

## Schemat i parser — rzeczywiste sprawdzenia na pustym Source

Root wykonał niezależną kompilację199+209+211+212+213:64 dodatki i2 zmiany,
pełny inverse do40879 rekordów poprzednika oraz siedem pełnych guardów
przed i po zmianie TRUE. ROLLBACK, zamknięcia i usunięcie własnego scratch
potwierdzone. Osobny pełny projector i złożony odczyt cold zachowują stare
warstwy; nie jest to instalacja na bazie biznesowej ani odbiór aplikacji.

Parser PostgreSQL sprawdził wszystkie43 literalne zapytania aktualnego core
przez PREPARE, bez EXECUTE i zapisów biznesowych. Każdy wynik ma status
`PARSED_NOT_EXECUTED`; ROLLBACK/end, zamknięcia, usunięcie scratch i identyczne
role potwierdzone. Pełne hashe43 SQL i receipt sprawdzono także na plikach.
PREPARE nie dowodzi skutków transakcji ani poprawności rzeczywistego UI.

- SQL213,2757B: `09c9d543c5e4a464a8a0824d810238979c26f4696260a7a233da286778b41868`.
- Source213 `result.private.json`,107354B: `c85f38c3d115a396562402ea0c2855ea77e5fe72745fab9fb6b3015223c9f243`.
- Pełny inverse,887B: `dc881b724364ff66fa706455ffd750c6b25931e6221301a24e94cf44be6948b2`.
- Złożony cold,588B: `cb8a8906ecac0e99bc22e06828a8cdc5fb70105b7b059c4642488fe2572f77fa`.
- Parser `result.private.json`,136338B: `31a19f093fb0fd101524860dfc9d968f32cb9f8431b8c2dfd7d978e405a41d5a`.
- Core44952B: `34107e608c015c799a71a0fe8ae4c429fcc328c11a20a2c565db5ab0a06737c2`.

## Wydanie N15

File-only preparer zachował1282 pliki stagingu N14, podmienił10 istniejących
źródeł oraz dopisał dwa moduły213 i SQL213:1295 źródeł. Zależności są wspólnym
symlinkiem; nie skopiowano dist, node_modules ani obcego WIP. Kontrakt ma80
plików,43 runtime-source i31 krawędzi Native. Poprzednie30 krawędzi i cały
wcześniejszy Native zachowane; zmiana inwentarza to dopisanie jednej krawędzi213.
Pełne inverse manifestu i inwentarza potwierdzone.

Root wykonał świeży Vite i check, następnie emit. Niezależna walidacja plikowa
sprawdziła wszystkie387 plików pakietu, dokładny roster i100405509B oraz11
entrypointów.239 wcześniejszych stałych członków identycznych. SQL213 ma jeden
fizyczny plik i jest zgodny bajtowo w źródle, stagingu, kontrakcie i pakiecie.
Niezmienione limity16MiB na członka i96MiB na pakiet zachowane; zapas257787B.
Końcowe1295 plików źródła i stagingu oraz23 referencje pozostają zgodne.

- Wydanie: `aa143236c03e3e9629e2f068ac23879f53d25a2fefbea2ae13e62c3f01bd9f51`.
- Kontrakt: `00bec1d5c8e992951b0596694277e4df38df20f8b962caec9034fb0a82171781`.
- Przygotowanie5025B: `501a0dc70d3b8286dd342f5195d2f7c354eb4b6d96a1770a25c2dff80aa1d573`.

## Zwykły start i zachowanie danych

Root uruchomił N15 zwykłą drogą na dotychczasowej bazie i konfiguracji; READY
potwierdzone. Migracja213 dodała jedną tabelę.629 z631 wcześniejszych tabel
ma pełne hashe identyczne; jedyne zmiany to dopisanie migracji213 oraz czysty
stempel generacji1769→1782 z zatwierdzonym nowym wydaniem. Stare wiersze lane,
zadania i audytu zachowane, nowa tabela receipts pusta przed operacją.
Pełne porównanie629 hashy oraz przypięte surowe pliki sprawdzono także niezależnie.
`upgrade-preservation.root-proof.private.json`,2293B:
`0a66773440e53ffa47104bea8ab67bf234ebe39091d23dffbcb02ec506f3f5a3`.

## Jeden jawny abort A i ochrona przed ręcznym replay

Root wykonał jeden abort w zwykłym Chrome, po podglądzie własnego wstrzymanego
wykonania A. Zachowany ACK ma `LOCAL_WOO_READ_ATTEMPT_ABORTED`, wersję3,
`enabled=false`, occurrence `aborted`, job `failed`, historyczny dispatch
`started`, `original_outcome=UNCONFIRMED`, `automatic_retry=false`.
Kontrola i cały stary dispatch pozostały identyczne. Attempts/payload/dedup
zadania zachowane. Receipt i jeden wpis audytu utrwalają jawne rozstrzygnięcie;
nie oznaczają potwierdzenia pierwotnego odczytu ani wyjaśnienia jego przyczyny.
Root zachował zrzut `ui-A-aborted.root.png`.

Uzgodnienie obejmuje632 tabele:628 pełnych hashy identycznych, jedyne skutki
w jobs, occurrences, receipts i audit. Root potwierdził pełne inverse zmienionych
historycznych tabel; niezależny odczyt plików potwierdza628 niezmienionych hashy,
identyczne controls/dispatches oraz referencje dowodów.
`abort-preservation.root-proof.private.json`,3364B:
`ca6fb3857fae75d5e6de7bd385a5f89551bf77d43e55cb7368f590ea0797a815`.

Osobne dwa POST: ręczne retry i run-once odrzucone409. Całe632 hashe tabel
identyczne przed i po tych odmowach; job bez zmian, bez zapisu dostawcy.
`guards.result.private.json`,15469B:
`c8288d33a9b03a9bfa194e567fa8ed06c7dceb6fce1cf3774fff60f6c8f06b24`.

## Nowe wykonanie naturalne A i końcowa pauza

Po rozstrzygnięciu Root wykonał osobne jawne Wznów. Przechwycona przed terminem
konfiguracja zamówień A v4 miała przyszły next_at2026-10-18T23:44:01.045Z.
Dokładnie ten termin ma nowe wykonanie; occurrence i nowe zadanie zakończone
DONE, attempts0, bez aktywnej dzierżawy. Jeden dispatch ACK ma after_hash
identyczny z checkpointem. Odczyt objął12 istniejących natywnych zamówień A,
zgodnych z external_id inboundów. To staging istniejących danych, nie12 nowych
importów biznesowych. Stare zadanie pozostaje odrębnie administracyjnie zakończone,
a jego pierwotny wynik nadal niepotwierdzony.

Root obserwator30069 zakończył EXIT0:20 GET200/0 POST. Po osobnej pauzie
zwykły UI pokazuje nowe DONE i wstrzymane zamówienia v5, next_at=NULL.
Zrzut `ui-A-new-natural-done-paused.root.png`:
`5dccfef1e7019debd7b70502ec8fd691a2a3a0a5154ae7ce2c991bf89f8ebd66`.
`observe.result.private.json`,43699B:
`9d74bd80bcdeeb24d2d663e598ed5514934dc3a856e2dae785c9c62b56076865`.
Pełne raw ACK, przyszły termin, DONE/lease i dispatch/checkpoint sprawdzono
niezależnie na plikach.

## Końcowe dane pięciu sklepów i pozostałe granice

Osobny Root odczyt70804 zakończył EXIT0:32 GET200/0 POST, bez natywnych zapisów.
Pięć pełnych DTO stanów, własnych zamówień, płatności i natywnych zamówień
zgodne z zaakceptowanym wynikiem stocku2750ca30…; produkty identyczne po jedynej
wcześniej uzgodnionej projekcji bounded related_ids. Wszystkie52 surowe GET ACK
obserwacji i closing oraz pełne porównania pięciu sklepów zweryfikowano
niezależnie na plikach. Końcowe kontrole wszystkich pięciu firm wstrzymane.
`five-store-closing.private.json`,234792B:
`bbe129e4caab05da4f12af36bbc4cc728af6db59402d130d7938d87775680d45`.

## Globalne uzgodnienie naturalnego cyklu

Osobne rzeczywiste uzgodnienie632 tabel porównało stan po odmowach ręcznego
wykonania ze stanem po Wznów, naturalnym DONE i pauzie.624 pełne hashe tabel
identyczne. W pozostałych ośmiu tabelach rozliczono dokładnie sześć nowych
wierszy audytu, jedno zadanie, jeden integration_run, dwa polecenia konfiguracji,
jedno wykonanie i jeden dispatch. Z istniejących wierszy zmieniły się tylko
last_sync_at/next_sync_at kanału A oraz version/updated_at jego kontroli zamówień.

Wyłącznie w projekcji porównawczej pominięto wskazane nowe wiersze i podstawiono
historyczne wartości wskazanych pól. PostgreSQL obliczył hashe; obserwator nie
wykonał zapisów. Pełne hashe wszystkich ośmiu tabel odtworzyły baseline.
Wszystkie stare wiersze, w tym administracyjnie zakończona próba i
historyczny started dispatch, zachowane. To uzgodnienie całej bazy, odrębne od
porównania32 GET biznesowych DTO. Niezależnie na plikach sprawdzono624 hashe,
osiem wyników inverse, surowe referencje oraz dokładny zakres nowych wierszy/pól.
`natural-preservation.root-proof.private.json`,18051B:
`6b52ccd015e57bdd5cc666599a3404f83df052640dfa5732e8387c1e29ed10b5`.

## Zwykły restart przy wstrzymanych konfiguracjach

Root zatrzymał i uruchomił zwykły stos N15 przy wstrzymanych konfiguracjach;
nowy start17164 osiągnął READY. Dwa GET i jeden obserwacyjny POST odczytały
historyczny abort ACK, identyczny ze zapisanym pierwotnym wynikiem. Nie wykonano
ponownego abortu ani procesora. Pauza v5, cała historia i nowe naturalne DONE
zachowane. Wszystkie632 pełne hashe tabel i zapisane wiersze identyczne przed
i po restarcie/obserwacji, w tym cały czysty stempel generacji1782.
Niezależna kontrola plików potwierdza pełne632 porównania, surowe ACK oraz exact ACK.
Po restarcie Root odświeżył zwykły Chrome i otworzył historię oraz szczegóły
nowego DONE. Obejrzany przez Roota zrzut pokazuje stare aborted, nowe DONE
i wszystkie konfiguracje wstrzymane: `ui-A-after-restart-history.root.png`,
`57224359b5c4babaea8da80152791853adc48f9997ec094ec41df993cdd5c477`.

- `restart-observe.result.private.json`,12586B: `cf2850fcd28559cd4721a9dd2a522d5d2600d3a6c387ec6a0e57644d18df17e4`.
- `restart-preservation.root-proof.private.json`,1500B: `76cd5f18437f5807ca620d7fb408486a350910ab11276d84e18d24808d141584`.

Odbiór restartu dotyczy normalnego zatrzymania przy pauzie. Nie obejmuje awarii
procesu, restartu w trakcie aktywnego odczytu ani utraty odpowiedzi dostawcy.
Nie odebrano trwałej automatyki pięciu aktywnych firm, skali, zewnętrznego konta
dostawcy ani pełnego Goala. Pierwotny wynik starego A pozostaje UNCONFIRMED.

Prywatne dowody: `local-woo-read213-source-root-20261019-01`,
`local-woo-read213-parser-prepared-agent-20261019-01`,
`local-woo-read213-release-prepared-agent-20261019-01` oraz
`local-woo-read213-n15-root-20261019-01` pod lokalnym katalogiem preview.
Nie wykonano zdalnego wdrożenia, odbioru zewnętrznego konta dostawcy ani pełnego Goala.
